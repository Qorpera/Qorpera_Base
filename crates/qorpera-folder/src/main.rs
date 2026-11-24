//! qorpera-folder: the company folder inside a Qorpera machine, and the node's vsock bridge to the
//! folder service. See README.md and deploy/first-node/RUNTIME-FOLDER-SERVICE.md.

use qorpera_folder::{bridge, cache, data, link, lxd, mount, proto, reads::ReadLog, relay, scan, search, viewfile::{self, DaemonLock, ViewFile}};
use std::io::Write;
use std::os::fd::RawFd;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

const USAGE: &str = "Usage:
  qorpera-folder mount --view-file <file> --mountpoint <dir> [--connect vsock:2:5250] [--threads 16] [--ttl-seconds 3600] [--allow-other yes] [--owner-uid <uid> --owner-gid <gid>] [--state-dir /run/qorpera-folder/<viewId>] [--local-dir <dir>] [--cache-dir <dir>]
  qorpera-folder publish --view-file <file> [--state-dir /run/qorpera-folder/<viewId>] [--final] [--json] [--connect vsock:2:5250]
  qorpera-folder bridge --service unix:<socket> [--listen vsock:any:5250] [--per-machine 512] [--lxd-socket <path>]
  qorpera-folder relay --listen systemd|unix:<socket> [--connect vsock:2:5250]
  qorpera-folder data [--view-file /run/qorpera-folder/view.json] [--root /company] [--connect vsock:2:5250] [--format json|table|csv|tsv|ndjson] describe [<database>] | apply <database> [--dry-run] | query <database> (<question> | --sql '<select>'|- | --sql-file <path>) [--params-json '<obj>'] [--params-file <path>] [name=value | name:=<JSON> ...] | change <database> <change> [--dry-run] [--params-json '<obj>'] [--params-file <path>] [name=value | name:=<JSON> ...] | rows <database> <table> [--limit N] [--offset N] [--order col[:asc|:desc]] | changes <database> | --help
  qorpera-folder scan-pack --spec-fd <fd> [--exclude-idx <path>]... [--exclude-oids-fd <fd>] | --diff-idx <path> [--exclude-idx <path>]... [--exclude-oids-fd <fd>]
  qorpera-folder scan-stream --spec-fd <fd>
  qorpera-folder search-worker --storage-root <dir> [--index-mib <N>] [--threads <N>]
  qorpera-folder version

mount: shows the view named in <file> (JSON {\"environmentId\", \"viewId\", \"pass\"}; a regular file owned by this
account, mode 0600 or tighter) at <dir> until a signal, the view's end or an unmount: read-write when the node lets the
view write, else read-only. A writable mount keeps its version map in <state-dir>, so a mount started again bases saves
on what was read before. --owner-uid and --owner-gid together set the virtual owner of writable files and folders;
by default they belong to the mounting account. Another account also needs --allow-other yes. These options do not
change the daemon account or ownership of its private view file and state directory. Read-only views stay root-owned.
A writable mount keeps the session's own git settings and hooks in --local-dir (default <state-dir>/local; give one on
the machine's disk), and the machine's caches (node_modules, target, what git ignores in a worktree, ...) in
--cache-dir (an existing folder only this account can use, an absolute path of at most 80 bytes, shared by the mounts
of one owner on the machine, else exit 1 with FOLDER_CACHE_DIR_UNUSABLE; default --local-dir, for this mount only):
never published, and kept for the next view, git settings excepted.
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
byte for byte (the execution host's native hosts, which cannot open vsock).

data: a company machine's command for the company's databases (the folders data/<database>/ of the company folder),
as the machine's folder view: what the view may read there is what it may ask and change. describe shows the databases
(or one): tables, steps, questions and changes. apply applies a database's waiting steps (--dry-run previews step state
without applying); a step that would destroy data is held, and its yes is asked from an agent's data_apply, never from
a machine. query asks a question by name (data/<database>/queries/<question>.sql) or one select of its own (--sql, --sql -
for stdin, or --sql-file); change runs a named change (data/<database>/actions/<change>.sql; --dry-run previews without
mutating); rows reads table rows via a bounded select; changes inspects a database's named changes and step status. A
value is text; name:=<JSON> gives a JSON number, boolean, null, array or object; --params-json and --params-file load
a JSON object of parameters. --format selects json (default), table, csv, tsv or ndjson. --help/-h prints usage and
exits 0. When the store asks for a file's text, the command reads it under <root> and sends it by its hash; a file
written a moment ago is used once it is saved to the folder (the command asks again for 10 s).
Exit codes: 0 an answer, 1 a refusal (its words on standard error), 2 usage, 3 the databases cannot be reached from
this machine now, no answer came, or the answer could not be printed (an apply or a change may then have run: look
before running it again).

scan-pack: reads a git cat-file --batch-all-objects --batch --unordered stream on standard input, scans each object
against the keyed secret-hash specification JSON read from --spec-fd <fd> (>= 3), and prints one JSON result line on
standard output ({\"status\":\"clean\",\"rebuilt\":...}, {\"status\":\"secret\"}, or {\"status\":\"unchecked\",\"reason\":...}).
Exit codes: 0 result printed, 1 invalid specification or I/O failure, 2 usage.

search-worker: persistent off-event-loop content-addressed trigram + linear-time regex search worker for folder-service.
Reads 4-byte big-endian length-prefixed JSON requests on stdin, verifies objects under --storage-root with O_NOFOLLOW
and SHA-256, maintains a bounded LRU trigram/object/tree cache (--index-mib, default 512, 1..2048), executes queries across
--threads worker threads (default 4, 1..32), and writes matching length-prefixed JSON responses on stdout until stdin EOF.
Exit codes: 0 clean shutdown on stdin EOF, 1 I/O or protocol failure, 2 usage.";

/// The node closed or refused the view: a supervisor must not simply start the mount again.
const EXIT_VIEW_CLOSED: u8 = 3;

fn main() -> ExitCode {
	let args: Vec<String> = std::env::args().skip(1).collect();
	let result = match args.first().map(String::as_str) {
		Some("mount") => mount(&args[1..]),
		Some("publish") => publish(&args[1..]),
		Some("bridge") => bridge(&args[1..]),
		Some("relay") => relay(&args[1..]),
		Some("data") => data(&args[1..]),
		Some("scan-pack") => scan_pack(&args[1..]),
		Some("scan-stream") => scan_stream(&args[1..]),
		Some("search-worker") => search_worker(&args[1..]),
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
	let o = options(args, &["view-file", "mountpoint", "connect", "threads", "ttl-seconds", "allow-other", "state-dir", "local-dir", "cache-dir", "owner-uid", "owner-gid"])?;
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
	let options = mount::Options {
		mountpoint,
		threads,
		ttl: Duration::from_secs(ttl),
		allow_other,
		owner,
		state: Some(state),
		reads: Some(reads),
		local: o.get("local-dir").map(PathBuf::from),
		caches: o.get("cache-dir").map(PathBuf::from),
	};
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

const MACHINE_VIEW_FILE: &str = "/run/qorpera-folder/view.json";

fn data(args: &[String]) -> Result<ExitCode, Usage> {
	let mut view_file: Option<String> = None;
	let mut root: Option<String> = None;
	let mut connect: Option<String> = None;
	let mut leading_format: Option<data::Format> = None;
	let mut i = 0;
	while i < args.len() {
		match args[i].as_str() {
			"-h" | "--help" => {
				println!("{}", data::DATA_USAGE);
				return Ok(ExitCode::SUCCESS);
			}
			"--view-file" => {
				if view_file.is_some() {
					return Err(Usage("--view-file given twice".into()));
				}
				let val = args.get(i + 1).filter(|v| !v.starts_with("--")).ok_or_else(|| Usage("--view-file needs a value".into()))?;
				view_file = Some(val.clone());
				i += 2;
			}
			"--root" => {
				if root.is_some() {
					return Err(Usage("--root given twice".into()));
				}
				let val = args.get(i + 1).filter(|v| !v.starts_with("--")).ok_or_else(|| Usage("--root needs a value".into()))?;
				root = Some(val.clone());
				i += 2;
			}
			"--connect" => {
				if connect.is_some() {
					return Err(Usage("--connect given twice".into()));
				}
				let val = args.get(i + 1).filter(|v| !v.starts_with("--")).ok_or_else(|| Usage("--connect needs a value".into()))?;
				connect = Some(val.clone());
				i += 2;
			}
			"--format" => {
				if leading_format.is_some() {
					return Err(Usage("--format given twice".into()));
				}
				let val = args.get(i + 1).filter(|v| !v.starts_with("--")).ok_or_else(|| Usage("--format needs a value".into()))?;
				leading_format = Some(data::Format::parse(val).map_err(Usage)?);
				i += 2;
			}
			other if other.starts_with("--") => return Err(Usage(format!("unknown option {other}"))),
			_ => break,
		}
	}
	let parsed = match data::parse_cli(&args[i..], leading_format, std::io::stdin().lock()).map_err(Usage)? {
		data::Command::Help => {
			println!("{}", data::DATA_USAGE);
			return Ok(ExitCode::SUCCESS);
		}
		data::Command::Execute(parsed) => parsed,
	};
	let view_file = view_file.as_deref().unwrap_or(MACHINE_VIEW_FILE);
	let root = PathBuf::from(root.as_deref().unwrap_or("/company"));
	let addr = connect.unwrap_or_else(|| format!("vsock:2:{}", proto::VSOCK_PORT));
	let view = match viewfile::read(std::path::Path::new(view_file)) {
		Ok(view) => view,
		Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
			eprintln!("data: this machine has no company folder ({}), so it reaches no databases", root.display());
			return Ok(ExitCode::from(data::EXIT_UNREACHABLE));
		}
		Err(e) => {
			eprintln!("data: the machine's folder view cannot be read ({e}); the command runs as root");
			return Ok(ExitCode::from(data::EXIT_UNREACHABLE));
		}
	};
	Ok(ExitCode::from(data::run_parsed(
		&addr,
		&view,
		&root,
		&parsed,
		&data::Waits::default(),
		&mut std::io::stdout(),
		&mut std::io::stderr(),
	)))
}

#[derive(Debug, PartialEq, Eq)]
struct ScanPackArgs {
	spec_fd: Option<RawFd>,
	diff_idx: Option<PathBuf>,
	exclude_idx: Vec<PathBuf>,
	exclude_oids_fd: Option<RawFd>,
}

fn scan_pack_args(args: &[String]) -> Result<ScanPackArgs, Usage> {
	let mut spec_fd: Option<RawFd> = None;
	let mut diff_idx: Option<PathBuf> = None;
	let mut exclude_idx: Vec<PathBuf> = Vec::new();
	let mut exclude_oids_fd: Option<RawFd> = None;
	let mut it = args.iter();
	while let Some(arg) = it.next() {
		match arg.as_str() {
			"--spec-fd" => {
				if spec_fd.is_some() {
					return Err(Usage("--spec-fd given twice".into()));
				}
				let raw = it.next().filter(|v| !v.starts_with("--")).ok_or_else(|| Usage("--spec-fd needs a value".into()))?;
				let fd: RawFd = raw.parse().map_err(|_| Usage("--spec-fd must be a file descriptor".into()))?;
				if fd < 3 {
					return Err(Usage("--spec-fd must be 3 or higher".into()));
				}
				spec_fd = Some(fd);
			}
			"--diff-idx" => {
				if diff_idx.is_some() {
					return Err(Usage("--diff-idx given twice".into()));
				}
				let raw = it.next().filter(|v| !v.starts_with("--") && !v.is_empty()).ok_or_else(|| Usage("--diff-idx needs a path".into()))?;
				diff_idx = Some(PathBuf::from(raw));
			}
			"--exclude-idx" => {
				let raw = it.next().filter(|v| !v.starts_with("--") && !v.is_empty()).ok_or_else(|| Usage("--exclude-idx needs a path".into()))?;
				exclude_idx.push(PathBuf::from(raw));
			}
			"--exclude-oids-fd" => {
				if exclude_oids_fd.is_some() {
					return Err(Usage("--exclude-oids-fd given twice".into()));
				}
				let raw = it.next().filter(|v| !v.starts_with("--")).ok_or_else(|| Usage("--exclude-oids-fd needs a value".into()))?;
				let fd: RawFd = raw.parse().map_err(|_| Usage("--exclude-oids-fd must be a file descriptor".into()))?;
				if fd < 3 {
					return Err(Usage("--exclude-oids-fd must be 3 or higher".into()));
				}
				exclude_oids_fd = Some(fd);
			}
			other => return Err(Usage(format!("unknown option {other}"))),
		}
	}
	match (spec_fd, &diff_idx) {
		(Some(_), Some(_)) => return Err(Usage("--spec-fd and --diff-idx cannot be combined".into())),
		(None, None) => return Err(Usage("--spec-fd or --diff-idx is required".into())),
		_ => {}
	}
	if let (Some(a), Some(b)) = (spec_fd, exclude_oids_fd) {
		if a == b {
			return Err(Usage("--spec-fd and --exclude-oids-fd must be different descriptors".into()));
		}
	}
	Ok(ScanPackArgs { spec_fd, diff_idx, exclude_idx, exclude_oids_fd })
}

fn scan_pack_fd(args: &[String]) -> Result<RawFd, Usage> {
	let o = options(args, &["spec-fd"])?;
	let raw = o.get("spec-fd").ok_or_else(|| Usage("--spec-fd is required".into()))?;
	let fd: RawFd = raw.parse().map_err(|_| Usage("--spec-fd must be a file descriptor".into()))?;
	if fd < 3 {
		return Err(Usage("--spec-fd must be 3 or higher".into()));
	}
	Ok(fd)
}

fn scan_pack(args: &[String]) -> Result<ExitCode, Usage> {
	let parsed = scan_pack_args(args)?;
	if let Some(target_idx) = parsed.diff_idx {
		return match scan::run_diff_idx(&target_idx, &parsed.exclude_idx, parsed.exclude_oids_fd) {
			Ok(_) => Ok(ExitCode::SUCCESS),
			Err(msg) => {
				eprintln!("qorpera-folder scan-pack: {msg}");
				Ok(ExitCode::FAILURE)
			}
		};
	}
	let fd = parsed.spec_fd.expect("validated");
	match scan::run_pack_from_fd(fd, &parsed.exclude_idx, parsed.exclude_oids_fd) {
		Ok(outcome) => {
			let line = serde_json::to_string(&outcome).expect("a scan outcome serializes");
			let mut stdout = std::io::stdout().lock();
			if writeln!(stdout, "{line}").is_err() || stdout.flush().is_err() {
				return Ok(ExitCode::FAILURE);
			}
			Ok(ExitCode::SUCCESS)
		}
		Err(msg) => {
			eprintln!("qorpera-folder scan-pack: {msg}");
			Ok(ExitCode::FAILURE)
		}
	}
}

fn scan_stream(args: &[String]) -> Result<ExitCode, Usage> {
	let fd = scan_pack_fd(args)?;
	match scan::run_stream_from_fd(fd) {
		Ok(outcome) => {
			let line = serde_json::to_string(&outcome).expect("a scan outcome serializes");
			let mut stdout = std::io::stdout().lock();
			if writeln!(stdout, "{line}").is_err() || stdout.flush().is_err() {
				return Ok(ExitCode::FAILURE);
			}
			Ok(ExitCode::SUCCESS)
		}
		Err(msg) => {
			eprintln!("qorpera-folder scan-stream: {msg}");
			Ok(ExitCode::FAILURE)
		}
	}
}

fn search_worker_options(args: &[String]) -> Result<(PathBuf, usize, usize), Usage> {
	let o = options(args, &["storage-root", "index-mib", "threads"])?;
	let root = o.get("storage-root").filter(|p| !p.is_empty()).ok_or_else(|| Usage("--storage-root is required".into()))?;
	let index_mib: usize = number(&o, "index-mib", 512)?;
	if !(1..=2048).contains(&index_mib) {
		return Err(Usage("--index-mib must be 1 to 2048".into()));
	}
	let threads: usize = number(&o, "threads", 4)?;
	if !(1..=32).contains(&threads) {
		return Err(Usage("--threads must be 1 to 32".into()));
	}
	Ok((PathBuf::from(root), index_mib, threads))
}

fn search_worker(args: &[String]) -> Result<ExitCode, Usage> {
	let (root, index_mib, threads) = search_worker_options(args)?;
	match search::run_worker(&root, index_mib, threads) {
		Ok(()) => Ok(ExitCode::SUCCESS),
		Err(msg) => {
			eprintln!("qorpera-folder search-worker: {msg}");
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

	#[test]
	fn scan_pack_requires_spec_fd_at_least_three() {
		let parse = |args: &[&str]| scan_pack_fd(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>());
		assert_eq!(parse(&["--spec-fd", "3"]).ok(), Some(3));
		assert_eq!(parse(&["--spec-fd", "12"]).ok(), Some(12));
		for bad in [
			vec![],
			vec!["--spec-fd"],
			vec!["--spec-fd", "0"],
			vec!["--spec-fd", "2"],
			vec!["--spec-fd", "-1"],
			vec!["--spec-fd", "abc"],
			vec!["--spec-fd", "3", "--other", "1"],
		] {
			assert!(parse(&bad).is_err(), "{bad:?}");
		}
		let parse_pack = |args: &[&str]| scan_pack_args(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>());
		assert_eq!(
			parse_pack(&["--spec-fd", "3", "--exclude-idx", "/a.idx", "--exclude-idx", "/b.idx", "--exclude-oids-fd", "4"]).ok(),
			Some(ScanPackArgs {
				spec_fd: Some(3),
				diff_idx: None,
				exclude_idx: vec![PathBuf::from("/a.idx"), PathBuf::from("/b.idx")],
				exclude_oids_fd: Some(4),
			})
		);
		assert_eq!(
			parse_pack(&["--diff-idx", "/new.idx", "--exclude-idx", "/old.idx"]).ok(),
			Some(ScanPackArgs {
				spec_fd: None,
				diff_idx: Some(PathBuf::from("/new.idx")),
				exclude_idx: vec![PathBuf::from("/old.idx")],
				exclude_oids_fd: None,
			})
		);
		for bad in [
			vec!["--spec-fd", "3", "--exclude-oids-fd", "3"],
			vec!["--spec-fd", "3", "--diff-idx", "/a.idx"],
			vec!["--exclude-idx", "/a.idx"],
		] {
			assert!(parse_pack(&bad).is_err(), "{bad:?}");
		}
	}

	#[test]
	fn search_worker_validates_storage_root_index_mib_and_threads() {
		let parse = |args: &[&str]| search_worker_options(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>());
		assert_eq!(parse(&["--storage-root", "/srv/objects"]).ok(), Some((PathBuf::from("/srv/objects"), 512, 4)));
		assert_eq!(
			parse(&["--storage-root", "/srv/objects", "--index-mib", "384", "--threads", "8"]).ok(),
			Some((PathBuf::from("/srv/objects"), 384, 8))
		);
		for bad in [
			vec![],
			vec!["--storage-root"],
			vec!["--storage-root", ""],
			vec!["--storage-root", "/srv", "--index-mib", "0"],
			vec!["--storage-root", "/srv", "--index-mib", "2049"],
			vec!["--storage-root", "/srv", "--threads", "0"],
			vec!["--storage-root", "/srv", "--threads", "33"],
			vec!["--storage-root", "/srv", "--unknown", "1"],
		] {
			assert!(parse(&bad).is_err(), "{bad:?}");
		}
	}
}
