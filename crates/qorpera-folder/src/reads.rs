//! The read log of a run box's mount (F3 step 2b): which versions the box opened or listed, so the run's native host
//! can release them as the run's reads with each answer it gives the model. The mount sees every open and every
//! folder listing (the kernel caches pages, not opens), so an answer's reads are the ones its commands made, whatever
//! was cached. Looking a name up or reading its attributes (`stat`) is not a read; neither is the root, nor a folder
//! shown only because it holds readable paths. Any process that reaches the mount is logged; only the box does.
//!
//! The host asks on a Unix socket that systemd passes to the mount (`--reads systemd`), one JSON line at a time:
//! - `{"t":"take","after":S,"max":N}` answers `{"t":"reads","log":L,"reads":[{seq,path,kind,version,authority?}],
//!   "more":bool}`: the oldest N reads numbered after S. Nothing leaves the log by being taken.
//! - `{"t":"ack","upTo":S}` answers `{"t":"acked","log":L,"upTo":S}` and drops every read numbered up to S, once the
//!   host has released them. A release that failed is simply taken again with the next answer.
//!
//! `L` names this program's log: a new one means the program restarted and its earlier reads are gone, which the host
//! must treat as reads it cannot account for. A version read again while its read waits is not logged twice; once
//! acknowledged, it is logged again, so each answer's release names what its commands read. Memory: about 0.6 KB per
//! waiting read (path and version), inside the folder unit's own memory.

use crate::proto::{Authority, EntryKind};
use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
use std::io::{BufRead, BufReader, Read as _, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// The most reads one answer gives: what the core records in one release.
pub const MAX_TAKE: usize = 10_000;
/// A request line is short; anything longer is not the native host.
const MAX_REQUEST: u64 = 4096;
/// A connection that sends nothing this long is ended, so one stuck connection never blocks the next.
const IDLE: Duration = Duration::from_secs(30);

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Read {
	pub seq: u64,
	pub path: String,
	pub kind: EntryKind,
	pub version: String,
	/// The receipt the node listed the entry with. Without one, the host sends an empty one and the core checks the
	/// path again; a stale one costs the core the same check.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub authority: Option<Authority>,
}

pub struct ReadLog {
	id: String,
	next: u64,
	reads: VecDeque<Read>,
	logged: HashSet<(String, String)>,
}

impl Default for ReadLog {
	fn default() -> Self {
		ReadLog::new()
	}
}

impl ReadLog {
	pub fn new() -> ReadLog {
		let mut bytes = [0u8; 16];
		// SAFETY: getrandom writes at most `len` bytes into the buffer it is given.
		let n = unsafe { libc::getrandom(bytes.as_mut_ptr().cast(), bytes.len(), 0) };
		assert_eq!(n, bytes.len() as isize, "getrandom");
		ReadLog {
			id: bytes.iter().map(|b| format!("{b:02x}")).collect(),
			next: 1,
			reads: VecDeque::new(),
			logged: HashSet::new(),
		}
	}

	pub fn id(&self) -> &str {
		&self.id
	}

	/// Logs one read of a path's version, unless it already waits.
	pub fn note(&mut self, path: &str, kind: EntryKind, version: &str, authority: Option<&Authority>) {
		if path.is_empty() || version.is_empty() || !self.logged.insert((path.to_string(), version.to_string())) {
			return;
		}
		self.reads.push_back(Read {
			seq: self.next,
			path: path.to_string(),
			kind,
			version: version.to_string(),
			authority: authority.cloned(),
		});
		self.next += 1;
	}

	/// The oldest `max` reads numbered after `after`, and whether more follow them.
	pub fn take(&self, after: u64, max: usize) -> (Vec<Read>, bool) {
		let start = self.reads.partition_point(|r| r.seq <= after);
		let taken: Vec<Read> = self.reads.iter().skip(start).take(max).cloned().collect();
		let more = self.reads.len() - start > taken.len();
		(taken, more)
	}

	/// Drops every read numbered up to `up_to`: the host released them.
	pub fn ack(&mut self, up_to: u64) {
		while self.reads.front().is_some_and(|r| r.seq <= up_to) {
			let r = self.reads.pop_front().expect("a front read");
			self.logged.remove(&(r.path, r.version));
		}
	}

	pub fn len(&self) -> usize {
		self.reads.len()
	}

	pub fn is_empty(&self) -> bool {
		self.reads.is_empty()
	}
}

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "camelCase", deny_unknown_fields)]
enum Request {
	Take {
		after: u64,
		max: usize,
	},
	#[serde(rename_all = "camelCase")]
	Ack {
		up_to: u64,
	},
}

#[derive(Serialize)]
#[serde(tag = "t", rename_all = "camelCase")]
enum Answer<'a> {
	Reads {
		log: &'a str,
		reads: &'a [Read],
		more: bool,
	},
	#[serde(rename_all = "camelCase")]
	Acked {
		log: &'a str,
		up_to: u64,
	},
}

/// Answers the native host on `listener` until the program ends, one connection at a time.
pub fn serve(listener: UnixListener, log: Arc<Mutex<ReadLog>>) {
	std::thread::spawn(move || {
		for stream in listener.incoming() {
			match stream {
				Ok(stream) => {
					if let Err(e) = answer(stream, &log) {
						eprintln!("qorpera-folder: reads connection ended: {e}");
					}
				}
				Err(e) => {
					eprintln!("qorpera-folder: reads socket: {e}");
					std::thread::sleep(Duration::from_millis(100));
				}
			}
		}
	});
}

fn answer(stream: UnixStream, log: &Mutex<ReadLog>) -> std::io::Result<()> {
	stream.set_read_timeout(Some(IDLE))?;
	let mut writer = stream.try_clone()?;
	let mut reader = BufReader::new(stream);
	let invalid = || std::io::Error::new(std::io::ErrorKind::InvalidData, "not a reads request");
	loop {
		let mut line = String::new();
		if (&mut reader).take(MAX_REQUEST).read_line(&mut line)? == 0 {
			return Ok(());
		}
		let request: Request = serde_json::from_str(line.trim_end()).map_err(|_| invalid())?;
		let mut out = {
			let mut log = log.lock().unwrap();
			match request {
				Request::Take { after, max } => {
					if !(1..=MAX_TAKE).contains(&max) {
						return Err(invalid());
					}
					let (reads, more) = log.take(after, max);
					serde_json::to_vec(&Answer::Reads { log: log.id(), reads: &reads, more })?
				}
				Request::Ack { up_to } => {
					log.ack(up_to);
					serde_json::to_vec(&Answer::Acked { log: log.id(), up_to })?
				}
			}
		};
		out.push(b'\n');
		writer.write_all(&out)?;
	}
}

/// The socket systemd passed (`LISTEN_FDS`, descriptor 3), when it is meant for this process.
pub fn systemd_listener() -> Result<UnixListener, String> {
	use std::os::fd::FromRawFd;
	let pid = std::env::var("LISTEN_PID").ok();
	let fds = std::env::var("LISTEN_FDS").ok();
	if pid.as_deref() != Some(&std::process::id().to_string()) || fds.as_deref() != Some("1") {
		return Err("--reads systemd needs the one socket of the mount's reads socket unit".into());
	}
	// Taken: nothing this program starts would see them as its own.
	for name in ["LISTEN_PID", "LISTEN_FDS", "LISTEN_FDNAMES"] {
		std::env::remove_var(name);
	}
	// SAFETY: systemd passed descriptor 3 to this process alone (LISTEN_PID), and nothing else here owns it.
	let listener = unsafe { UnixListener::from_raw_fd(3) };
	// SAFETY: plain fcntl on a descriptor this process owns.
	unsafe { libc::fcntl(3, libc::F_SETFD, libc::FD_CLOEXEC) };
	Ok(listener)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn receipt(n: u64) -> Authority {
		Authority {
			resource_id: "00000000-0000-4000-8000-000000000001".into(),
			resource_revision: n,
			grant_id: None,
			grant_revision: None,
		}
	}

	#[test]
	fn reads_wait_until_acknowledged_and_a_read_after_that_is_logged_again() {
		let mut log = ReadLog::new();
		assert_eq!(log.id().len(), 32);
		assert_ne!(log.id(), ReadLog::new().id(), "each program's log has its own id");
		log.note("docs/plan.md", EntryKind::File, "v1", Some(&receipt(1)));
		log.note("docs/plan.md", EntryKind::File, "v1", Some(&receipt(1)));
		log.note("docs", EntryKind::Folder, "f1", None);
		log.note("docs/plan.md", EntryKind::File, "v2", Some(&receipt(2)));
		log.note("", EntryKind::Folder, "", None);
		log.note("implicit", EntryKind::Folder, "", None);
		assert_eq!(log.len(), 3);
		let (first, more) = log.take(0, 2);
		assert!(more);
		assert_eq!(first.iter().map(|r| (r.seq, r.version.as_str())).collect::<Vec<_>>(), [(1, "v1"), (2, "f1")]);
		// Taking again gives the same reads: nothing left the log.
		assert_eq!(log.take(0, 2).0, first);
		let (rest, more) = log.take(2, MAX_TAKE);
		assert!(!more);
		assert_eq!(rest.iter().map(|r| r.seq).collect::<Vec<_>>(), [3]);
		// Still waiting: a read of v1 is not logged twice. Acknowledged: it is the next answer's read.
		log.note("docs/plan.md", EntryKind::File, "v1", Some(&receipt(1)));
		assert_eq!(log.len(), 3);
		log.ack(2);
		assert_eq!(log.take(0, MAX_TAKE).0.iter().map(|r| r.seq).collect::<Vec<_>>(), [3]);
		log.note("docs/plan.md", EntryKind::File, "v1", Some(&receipt(1)));
		log.ack(3);
		let (again, _) = log.take(3, MAX_TAKE);
		assert_eq!(again.iter().map(|r| (r.seq, r.version.as_str())).collect::<Vec<_>>(), [(4, "v1")]);
		log.ack(u64::MAX);
		assert!(log.is_empty());
	}

	#[test]
	fn answers_take_and_ack_requests_and_ends_on_anything_else() {
		let dir = std::env::temp_dir().join(format!("qorpera-reads-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		std::fs::create_dir_all(&dir).unwrap();
		let path = dir.join("reads.sock");
		let listener = UnixListener::bind(&path).unwrap();
		let log = Arc::new(Mutex::new(ReadLog::new()));
		log.lock().unwrap().note("a.txt", EntryKind::File, "v1", Some(&receipt(7)));
		let id = log.lock().unwrap().id().to_string();
		serve(listener, log.clone());
		let mut stream = UnixStream::connect(&path).unwrap();
		let mut reader = BufReader::new(stream.try_clone().unwrap());
		let mut ask = |request: &str| {
			stream.write_all(request.as_bytes()).unwrap();
			let mut line = String::new();
			reader.read_line(&mut line).unwrap();
			line
		};
		let read = format!(
			"{{\"t\":\"reads\",\"log\":\"{id}\",\"reads\":[{{\"seq\":1,\"path\":\"a.txt\",\"kind\":\"file\",\"version\":\"v1\",\"authority\":{{\"resourceId\":\"00000000-0000-4000-8000-000000000001\",\"resourceRevision\":7,\"grantId\":null,\"grantRevision\":null}}}}],\"more\":false}}\n"
		);
		assert_eq!(ask("{\"t\":\"take\",\"after\":0,\"max\":10}\n"), read);
		assert_eq!(ask("{\"t\":\"take\",\"after\":0,\"max\":10}\n"), read, "a take leaves the log as it was");
		assert_eq!(ask("{\"t\":\"ack\",\"upTo\":1}\n"), format!("{{\"t\":\"acked\",\"log\":\"{id}\",\"upTo\":1}}\n"));
		assert_eq!(
			ask("{\"t\":\"take\",\"after\":0,\"max\":10}\n"),
			format!("{{\"t\":\"reads\",\"log\":\"{id}\",\"reads\":[],\"more\":false}}\n")
		);
		assert_eq!(ask("{\"t\":\"take\",\"after\":0,\"max\":0}\n"), "", "a bad request ends the connection");
		let _ = std::fs::remove_dir_all(&dir);
	}
}
