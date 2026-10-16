//! qorpera-folder: the company folder inside a Qorpera machine, and the node's vsock bridge to the
//! folder service. See README.md and deploy/first-node/RUNTIME-FOLDER-SERVICE.md.

use qorpera_folder::{bridge, cache, link, lxd, mount, proto, reads::ReadLog, relay, viewfile::{self, DaemonLock, ViewFile}};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

const USAGE: &str = "Usage:
  qorpera-folder mount --view-file <file> --mountpoint <dir> [--connect vsock:2:5250] [--threads 16] [--ttl-seconds 3600] [--allow-other yes] [--owner-uid <uid> --owner-gid <gid>] [--state-dir /run/qorpera-folder/<viewId>] [--local-dir <dir>]
  qorpera-folder publish --view-file <file> [--state-dir /run/qorpera-folder/<viewId>] [--final] [--json] [--connect vsock:2:5250]
  qorpera-folder bridge --service unix:<socket> [--listen vsock:any:5250] [--per-machine 512] [--lxd-socket <path>]
  qorpera-folder relay --listen systemd|unix:<socket> [--connect vsock:2:5250]
  qorpera-folder version

mount: shows the view named in <file> (JSON {\"environmentId\", \"viewId\", \"pass\"}; a regular file owned by this
account, mode 0600 or tighter) at <dir> until a signal, the view's end or an unmount: read-write when the node lets the
view write, else read-only. A writable mount keeps its version map in <state-dir>, so a mount started again bases saves
on what was read before. --owner-uid and --owner-gid together set the virtual owner of writable files and folders;
by default they belong to the mounting account. Another account also needs --allow-other yes. These options do not
change the daemon account or ownership of its private view file and state directory. Read-only views stay root-owned.
A writable mount keeps the session's own git settings and hooks, and the caches in code worktrees (node_modules,
target, ...), in --local-dir (default <state-dir>/local; give one on the machine's disk): never published, and kept
for the next view, git settings excepted.
Exit codes: 0 stopped, 1 failed, 2 usage, 3 the node closed or refused the view.

publish: hands over the mount's durable read log from <state-dir> before publishing its pending changes, even after
the mount program exited. Use the mount's exact existing state directory; a missing directory fails locally without
contacting the node. --final asks the command's last boundary to close its view. --json prints only the exact
structured report on stdout; diagnostics stay on stderr. Otherwise prints each path's outcome. An answered report
is printed even if its later release or closure check fails; exit 1 still means completion is unproven.
Exit codes: 0 every path saved (or nothing was pending), 1 failed (when no answer came after the request went out,
whether the boundary ran is unknown: publish again to see what is still pending), 2 usage, 3 the view is closed, 4 a
path was not saved or the boundary was refused (including an unproven read log). In JSON mode exit 1 or 3 can have no
stdout report: the exit code carries transport/unknown or closed status; closed:true is reserved for an answered final.

relay: carries each connection to <socket> (systemd: the one its socket unit passed) to the node's folder service,
byte for byte (the execution host's native hosts, which cannot open vsock).";

/// The node closed or refused the view: a supervisor must not simply start the mount again.
const EXIT_VIEW_CLOSED: u8 = 3;

fn main() -> ExitCode {
	let args: Vec<String> = std::env::args().skip(1).collect();
	let result = match args.first().map(String::as_str) {
		Some("mount") => mount(&args[1..]),
		Some("publish") => publish(&args[1..]),
		Some("bridge") => bridge(&args[1..]),
		Some("relay") => relay(&args[1..]),
		Some("version" | "--version") => {
			println!("qorpera-folder {} (protocol {})", env!("CARGO_PKG_VERSION"), proto::PROTOCOL);
			Ok(ExitCode::SUCCESS)
		}
		_ => Err(Usage(String::new())),
	};
	match result {
		Ok(code) => code,
		Err(Usage(msg)) => {
			if !msg.is_empty() {
				eprintln!("qorpera-folder: {msg}");
			}
			eprintln!("{USAGE}");
			ExitCode::from(2)
		}
	}
}

struct Usage(String);

/// `--name value` pairs; every name must be known and given once.
fn options(args: &[String], known: &[&str]) -> Result<std::collections::HashMap<String, String>, Usage> {
	flag_options(args, known, &[])
}

fn flag_options(args: &[String], known: &[&str], flags: &[&str]) -> Result<std::collections::HashMap<String, String>, Usage> {
	let mut out = std::collections::HashMap::new();
	let mut it = args.iter();
	while let Some(name) = it.next() {
		let key = name.strip_prefix("--")
			.filter(|k| known.contains(k) || flags.contains(k))
			.ok_or_else(|| Usage(format!("unknown option {name}")))?;
		let value = if flags.contains(&key) {
			"yes".to_string()
		} else {
			it.next().filter(|v| !v.starts_with("--")).ok_or_else(|| Usage(format!("{name} needs a value")))?.clone()
		};
		if out.insert(key.to_string(), value).is_some() {
			return Err(Usage(format!("{name} given twice")));
		}
	}
	Ok(out)
}

fn number<T: std::str::FromStr>(o: &std::collections::HashMap<String, String>, key: &str, default: T) -> Result<T, Usage> {
	match o.get(key) {
		Some(v) => v.parse().map_err(|_| Usage(format!("--{key} must be a number"))),
		None => Ok(default),
	}
}

fn mount(args: &[String]) -> Result<ExitCode, Usage> {
	let o = options(args, &["view-file", "mountpoint", "connect", "threads", "ttl-seconds", "allow-other", "state-dir", "local-dir", "owner-uid", "owner-gid"])?;
	let view_file = o.get("view-file").ok_or_else(|| Usage("--view-file is required".into()))?;
	let mountpoint = PathBuf::from(o.get("mountpoint").ok_or_else(|| Usage("--mountpoint is required".into()))?);
	let addr = o.get("connect").cloned().unwrap_or_else(|| format!("vsock:2:{}", proto::VSOCK_PORT));
	let threads: usize = number(&o, "threads", 16)?;
	let ttl: u64 = number(&o, "ttl-seconds", 3600)?;
	let owner = mount_owner(&o)?;
	let allow_other = match o.get("allow-other").map(String::as_str) {
		None | Some("no") => false,
		Some("yes") => true,
		Some(_) => return Err(Usage("--allow-other is yes or no".into())),
	};
	if !(1..=64).contains(&threads) {
		return Err(Usage("--threads must be 1 to 64".into()));
	}
	let view = match viewfile::read(std::path::Path::new(view_file)) {
		Ok(v) => v,
		Err(e) => {
			eprintln!("qorpera-folder: view file {view_file}: {e}");
			return Ok(ExitCode::FAILURE);
		}
	};
	let state = match o.get("state-dir") {
		Some(dir) => PathBuf::from(dir),
		None => match state_dir(&view.view_id) {
			Some(dir) => dir,
			None => return Err(Usage("this view id needs a --state-dir".into())),
		},
	};
	// Acquire the fixed lifetime lock before any journal, accepted-proof or connection mutation. A standalone
	// publisher holding it excludes a new daemon until its proven-dead abandonment and publication complete.
	let _daemon = match DaemonLock::acquire(&state, false, true) {
		Ok(Some(lock)) => lock,
		Ok(None) => { eprintln!("qorpera-folder: another mount or publisher holds this state"); return Ok(ExitCode::FAILURE); }
		Err(e) => { eprintln!("qorpera-folder: mount state lock: {e}"); return Ok(ExitCode::FAILURE); }
	};
	let prepared = (|| -> std::io::Result<_> {
		let reads = Arc::new(ReadLog::open(&state, true)?);
		let store = Arc::new(ViewFile::open(PathBuf::from(view_file), &state, &view, reads.created())?);
		Ok((reads, store))
	})();
	let (reads, store) = match prepared {
		Ok(prepared) => prepared,
		Err(e) => { eprintln!("qorpera-folder: private mount state: {e}"); return Ok(ExitCode::FAILURE); }
	};
	// The journal goes to the mount, which logs reads only once the node says the view can write.
	let link = link::Link::new(addr, view, threads).with_view_file(store, true, false);
	let options = mount::Options { mountpoint, threads, ttl: Duration::from_secs(ttl), allow_other, owner, state: Some(state), reads: Some(reads), local: o.get("local-dir").map(PathBuf::from) };
	match mount::run(link, options) {
		Ok(mount::Stop::ViewClosed) => {
			eprintln!("qorpera-folder: the node closed the view; unmounted");
			Ok(ExitCode::from(EXIT_VIEW_CLOSED))
		}
		Ok(mount::Stop::Signal(sig)) => {
			eprintln!("qorpera-folder: signal {sig}; unmounted");
			Ok(ExitCode::SUCCESS)
		}
		Ok(mount::Stop::Ended(Ok(()))) => Ok(ExitCode::SUCCESS),
		Ok(mount::Stop::Ended(Err(e))) => {
			eprintln!("qorpera-folder: session ended: {e}");
			Ok(ExitCode::FAILURE)
		}
		Err(mount::Failed::View(e)) => {
			eprintln!("qorpera-folder: the node refused the view: {e}");
			Ok(ExitCode::from(EXIT_VIEW_CLOSED))
		}
		Err(mount::Failed::Other(e)) => {
			eprintln!("qorpera-folder: {e}");
			Ok(ExitCode::FAILURE)
		}
	}
}

/// Virtual inode ownership only: the daemon keeps its identity and sole access to the view pass and state.
fn mount_owner(o: &std::collections::HashMap<String, String>) -> Result<Option<(u32, u32)>, Usage> {
	match (o.get("owner-uid"), o.get("owner-gid")) {
		(None, None) => Ok(None),
		(Some(_), Some(_)) => {
			let uid: u32 = number(o, "owner-uid", 0)?;
			let gid: u32 = number(o, "owner-gid", 0)?;
			// Linux reserves the all-ones value as an invalid uid/gid.
			if uid == u32::MAX || gid == u32::MAX {
				return Err(Usage("--owner-uid and --owner-gid must be less than 4294967295".into()));
			}
			Ok(Some((uid, gid)))
		}
		_ => Err(Usage("--owner-uid and --owner-gid must be given together".into())),
	}
}

/// The mount's own folder under /run/qorpera-folder/ (a memory file system): its version map lives there, and goes when
/// the machine restarts.
fn state_dir(view_id: &str) -> Option<PathBuf> {
	let fine = !view_id.is_empty()
		&& view_id != "."
		&& view_id != ".."
		&& view_id.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b));
	fine.then(|| PathBuf::from("/run/qorpera-folder").join(view_id))
}

/// Publishes the view's pending changes and prints the report.
fn publish(args: &[String]) -> Result<ExitCode, Usage> {
	let o = flag_options(args, &["view-file", "connect", "state-dir"], &["final", "json"])?;
	let view_file = o.get("view-file").ok_or_else(|| Usage("--view-file is required".into()))?;
	let addr = o.get("connect").cloned().unwrap_or_else(|| format!("vsock:2:{}", proto::VSOCK_PORT));
	let view = match viewfile::read(std::path::Path::new(view_file)) {
		Ok(v) => v,
		Err(e) => {
			eprintln!("qorpera-folder: view file {view_file}: {e}");
			return Ok(ExitCode::FAILURE);
		}
	};
	let state = match o.get("state-dir") {
		Some(dir) => PathBuf::from(dir),
		None => state_dir(&view.view_id).ok_or_else(|| Usage("this view id needs a --state-dir".into()))?,
	};
	let daemon = match DaemonLock::acquire(&state, false, false) {
		Ok(lock) => lock,
		Err(e) => { eprintln!("qorpera-folder: mount state lock: {e}; use its exact --state-dir"); return Ok(ExitCode::FAILURE); }
	};
	// A busy lock means alive, even while hello is stalled or every service stream is disconnected.
	let abandon = daemon.is_some();
	let store = match ViewFile::open(PathBuf::from(view_file), &state, &view, false) {
		Ok(store) => Arc::new(store),
		Err(e) => {
			eprintln!("qorpera-folder: accepted view proof cannot be read: {e}");
			return Ok(print_report(&proto::Report { refused: Some("unproven".into()), ..Default::default() }, o.contains_key("json")));
		}
	};
	let reads = match ReadLog::open(&state, false) {
		Ok(reads) => Arc::new(reads),
		Err(e) => {
			eprintln!("qorpera-folder: cannot open the mount's state directory: {e}; use its exact --state-dir");
			if e.kind() == std::io::ErrorKind::NotFound {
				return Ok(ExitCode::FAILURE);
			}
			let report = proto::Report { refused: Some("unproven".into()), ..Default::default() };
			return Ok(print_report(&report, o.contains_key("json")));
		}
	};
	if state.join(cache::MOVING).try_exists().unwrap_or(true) {
		// The mount has cache folders git came to track still to move into the folder (cache.rs): a boundary now would
		// leave their files out.
		eprintln!("qorpera-folder: cache folders git now tracks are still moving into the folder; publish again shortly");
		return Ok(ExitCode::FAILURE);
	}
	let report = match link::Link::new(addr, view, 1).with_reads(reads.clone()).with_view_file(store, false, abandon).publish_final(o.contains_key("final")) {
		Ok(r) => r,
		Err(f) if f.report.is_some() => {
			eprintln!("qorpera-folder: publication report received, but completion is unproven: {f}");
			print_report(f.report.as_ref().unwrap(), o.contains_key("json"));
			return Ok(ExitCode::FAILURE);
		}
		Err(f) if f.failure.view_closed() => {
			eprintln!("qorpera-folder: the view is closed: {f}");
			return Ok(ExitCode::from(EXIT_VIEW_CLOSED));
		}
		Err(f) => {
			if reads.locked().is_ok_and(|log| log.lost()) {
				eprintln!("qorpera-folder: the read journal is unproven: {f}");
				let report = proto::Report { refused: Some("unproven".into()), ..Default::default() };
				return Ok(print_report(&report, o.contains_key("json")));
			}
			eprintln!("qorpera-folder: could not publish: {f}");
			return Ok(ExitCode::FAILURE);
		}
	};
	Ok(print_report(&report, o.contains_key("json")))
}

fn print_report(report: &proto::Report, json: bool) -> ExitCode {
	let code = if report.refused.is_none() && report.paths.iter().all(|e| e.outcome == "saved") {
		ExitCode::SUCCESS
	} else {
		ExitCode::from(4)
	};
	if json {
		println!("{}", serde_json::to_string(report).expect("a report serializes"));
		return code;
	}
	if let Some(reason) = &report.refused {
		println!("refused: {reason}");
	} else if report.paths.is_empty() {
		println!("nothing to publish");
	}
	for entry in &report.paths {
		let mut why = entry.reason.clone().unwrap_or_default();
		if let Some(receipt) = &entry.receipt {
			why = format!("{why}; this version is kept on receipt {receipt}");
		}
		if entry.kept {
			why = format!("{why}; still pending here");
		}
		println!("{:<12} {}{}", entry.outcome, entry.path, if why.is_empty() { String::new() } else { format!("  ({})", why.trim_start_matches("; ")) });
	}
	code
}


fn bridge(args: &[String]) -> Result<ExitCode, Usage> {
	let o = options(args, &["listen", "service", "per-machine", "lxd-socket"])?;
	let service = o.get("service").ok_or_else(|| Usage("--service is required".into()))?;
	if !service.starts_with("unix:") {
		return Err(Usage("--service must be unix:<socket>".into()));
	}
	let listen = o.get("listen").cloned().unwrap_or_else(|| format!("vsock:any:{}", proto::VSOCK_PORT));
	let per_machine: usize = number(&o, "per-machine", bridge::PER_MACHINE)?;
	let lxd_socket = o.get("lxd-socket").cloned().unwrap_or_else(|| lxd::SOCKET.to_string());
	match bridge::run(&listen, service, per_machine.max(1), &lxd_socket) {
		Ok(()) => Ok(ExitCode::SUCCESS),
		Err(e) => {
			eprintln!("qorpera-folder bridge: {e}");
			Ok(ExitCode::FAILURE)
		}
	}
}

fn relay(args: &[String]) -> Result<ExitCode, Usage> {
	let o = options(args, &["listen", "connect"])?;
	let upstream = o.get("connect").cloned().unwrap_or_else(|| format!("vsock:2:{}", proto::VSOCK_PORT));
	let listener = match o.get("listen").map(String::as_str) {
		Some("systemd") => relay::systemd_listener().map_err(Usage)?,
		Some(path) if path.starts_with("unix:") => match std::os::unix::net::UnixListener::bind(&path[5..]) {
			Ok(l) => l,
			Err(e) => {
				eprintln!("qorpera-folder relay: {path}: {e}");
				return Ok(ExitCode::FAILURE);
			}
		},
		_ => return Err(Usage("--listen is systemd or unix:<socket>".into())),
	};
	match relay::run(listener, &upstream) {
		Ok(()) => Ok(ExitCode::SUCCESS),
		Err(e) => {
			eprintln!("qorpera-folder relay: {e}");
			Ok(ExitCode::FAILURE)
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn publish_flags_take_no_values_and_reject_duplicates_and_malformed_flags() {
		let parse = |args: &[&str]| flag_options(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>(), &["state-dir"], &["final", "json"]);
		assert!(parse(&["--state-dir", "/state", "--final", "--json"]).is_ok());
		for bad in [vec!["--json", "yes"], vec!["--final", "--final"], vec!["--json=no"], vec!["--state-dir"], vec!["--state-dir", "--json"], vec!["--unknown"]] {
			assert!(parse(&bad).is_err(), "{bad:?}");
		}
	}

	#[test]
	fn mount_owner_defaults_to_the_mounting_account_and_accepts_an_explicit_pair() {
		let mut o = std::collections::HashMap::new();
		assert!(matches!(mount_owner(&o), Ok(None)));
		o.insert("owner-uid".into(), "1000".into());
		o.insert("owner-gid".into(), "1001".into());
		assert!(matches!(mount_owner(&o), Ok(Some((1000, 1001)))));
		o.insert("owner-uid".into(), "0".into());
		o.insert("owner-gid".into(), "0".into());
		assert!(matches!(mount_owner(&o), Ok(Some((0, 0)))));
	}

	#[test]
	fn mount_owner_rejects_a_half_pair() {
		for key in ["owner-uid", "owner-gid"] {
			let o = std::collections::HashMap::from([(key.to_string(), "1000".to_string())]);
			assert!(mount_owner(&o).is_err(), "{key}");
		}
	}

	#[test]
	fn mount_owner_rejects_invalid_and_out_of_range_ids() {
		for key in ["owner-uid", "owner-gid"] {
			for value in ["-1", "nobody", "", "4294967295", "4294967296"] {
				let mut o = std::collections::HashMap::from([
					("owner-uid".to_string(), "1000".to_string()),
					("owner-gid".to_string(), "1000".to_string()),
				]);
				o.insert(key.to_string(), value.to_string());
				assert!(mount_owner(&o).is_err(), "{key}={value}");
			}
		}
	}
}
