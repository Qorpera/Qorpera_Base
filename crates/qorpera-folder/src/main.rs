//! qorpera-folder: the company folder inside a Qorpera machine, and the node's vsock bridge to the
//! folder service. See README.md and deploy/first-node/RUNTIME-FOLDER-SERVICE.md.

use qorpera_folder::{bridge, link, lxd, mount, proto, relay};
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

const USAGE: &str = "Usage:
  qorpera-folder mount --view-file <file> --mountpoint <dir> [--connect vsock:2:5250] [--threads 16] [--ttl-seconds 3600] [--allow-other yes] [--state-dir /run/qorpera-folder/<viewId>]
  qorpera-folder publish --view-file <file> [--connect vsock:2:5250]
  qorpera-folder bridge --service unix:<socket> [--listen vsock:any:5250] [--per-machine 512] [--lxd-socket <path>]
  qorpera-folder relay --listen systemd|unix:<socket> [--connect vsock:2:5250]
  qorpera-folder version

mount: shows the view named in <file> (JSON {\"environmentId\", \"viewId\", \"pass\"}; a regular file owned by this
account, mode 0600 or tighter) at <dir> until a signal, the view's end or an unmount: read-write when the node lets the
view write, else read-only. A writable mount keeps its version map in <state-dir>, so a mount started again bases saves
on what was read before.
Exit codes: 0 stopped, 1 failed, 2 usage, 3 the node closed or refused the view.

publish: publishes what the view in <file> has pending, as one change set, and prints each path's outcome.
Exit codes: 0 every path saved (or nothing was pending), 1 failed (when no answer came after the request went out,
whether the boundary ran is unknown: publish again to see what is still pending), 2 usage, 3 the view is closed, 4 a
path was not saved (a conflict, a refusal, or a file still open).

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
	let mut out = std::collections::HashMap::new();
	let mut it = args.iter();
	while let Some(name) = it.next() {
		let key = name.strip_prefix("--").filter(|k| known.contains(k)).ok_or_else(|| Usage(format!("unknown option {name}")))?;
		let value = it.next().ok_or_else(|| Usage(format!("{name} needs a value")))?;
		if out.insert(key.to_string(), value.clone()).is_some() {
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
	let o = options(args, &["view-file", "mountpoint", "connect", "threads", "ttl-seconds", "allow-other", "state-dir"])?;
	let view_file = o.get("view-file").ok_or_else(|| Usage("--view-file is required".into()))?;
	let mountpoint = PathBuf::from(o.get("mountpoint").ok_or_else(|| Usage("--mountpoint is required".into()))?);
	let addr = o.get("connect").cloned().unwrap_or_else(|| format!("vsock:2:{}", proto::VSOCK_PORT));
	let threads: usize = number(&o, "threads", 16)?;
	let ttl: u64 = number(&o, "ttl-seconds", 3600)?;
	let allow_other = match o.get("allow-other").map(String::as_str) {
		None | Some("no") => false,
		Some("yes") => true,
		Some(_) => return Err(Usage("--allow-other is yes or no".into())),
	};
	if !(1..=64).contains(&threads) {
		return Err(Usage("--threads must be 1 to 64".into()));
	}
	let view = match read_view(view_file) {
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
	let link = link::Link::new(addr, view, threads);
	let options = mount::Options { mountpoint, threads, ttl: Duration::from_secs(ttl), allow_other, state: Some(state) };
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
	let o = options(args, &["view-file", "connect"])?;
	let view_file = o.get("view-file").ok_or_else(|| Usage("--view-file is required".into()))?;
	let addr = o.get("connect").cloned().unwrap_or_else(|| format!("vsock:2:{}", proto::VSOCK_PORT));
	let view = match read_view(view_file) {
		Ok(v) => v,
		Err(e) => {
			eprintln!("qorpera-folder: view file {view_file}: {e}");
			return Ok(ExitCode::FAILURE);
		}
	};
	let report = match link::Link::new(addr, view, 1).publish() {
		Ok(r) => r,
		Err(f) if f.view_closed() => {
			eprintln!("qorpera-folder: the view is closed: {f}");
			return Ok(ExitCode::from(EXIT_VIEW_CLOSED));
		}
		Err(f) => {
			eprintln!("qorpera-folder: could not publish: {f}");
			return Ok(ExitCode::FAILURE);
		}
	};
	if report.paths.is_empty() {
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
	Ok(if report.paths.iter().all(|e| e.outcome == "saved") { ExitCode::SUCCESS } else { ExitCode::from(4) })
}

/// The view's id and pass. The file must be this account's own, a regular file, and readable by no one
/// else: the pass opens the view.
fn read_view(path: &str) -> Result<link::View, String> {
	use std::io::Read;
	use std::os::unix::fs::OpenOptionsExt;
	let mut file = std::fs::OpenOptions::new()
		.read(true)
		.custom_flags(libc::O_NOFOLLOW)
		.open(path)
		.map_err(|e| e.to_string())?;
	let meta = file.metadata().map_err(|e| e.to_string())?;
	// SAFETY: geteuid has no preconditions.
	let me = unsafe { libc::geteuid() };
	if !meta.is_file() || meta.uid() != me || meta.mode() & 0o077 != 0 || meta.len() > 4096 {
		return Err("must be a regular file of at most 4 KiB, owned by this account, mode 0600 or tighter".into());
	}
	let mut text = String::new();
	file.read_to_string(&mut text).map_err(|e| e.to_string())?;
	#[derive(serde::Deserialize)]
	#[serde(rename_all = "camelCase", deny_unknown_fields)]
	struct ViewFile {
		environment_id: String,
		view_id: String,
		pass: String,
	}
	let v: ViewFile = serde_json::from_str(&text)
		.map_err(|_| "must be JSON {\"environmentId\", \"viewId\", \"pass\"}".to_string())?;
	let fine = |s: &str| !s.is_empty() && s.len() <= 256 && s.bytes().all(|b| b.is_ascii_graphic());
	if !fine(&v.environment_id) || !fine(&v.view_id) || !fine(&v.pass) {
		return Err("environmentId, viewId and pass must be printable ASCII without spaces".into());
	}
	Ok(link::View { environment_id: v.environment_id, view_id: v.view_id, pass: v.pass })
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
