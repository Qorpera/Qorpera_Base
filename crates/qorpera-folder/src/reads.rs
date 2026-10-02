//! The read log of a run box's mount (F3 step 2b): which versions the box opened or listed, so the run's native host
//! can release them as the run's reads with each answer it gives the model. The mount sees every open and every
//! folder listing (the kernel caches pages, not opens), so an answer's reads are the ones its commands made, whatever
//! was cached. Looking a name up or reading its attributes (`stat`) is not a read; neither is the root, nor a folder
//! shown only because it holds readable paths. Any process that reaches the mount is logged; only the box does.
//!
//! The host asks on a Unix socket that systemd passes to the mount (`--reads systemd`), one JSON line at a time:
//! - `{"t":"take","after":S,"max":N}` answers `{"t":"reads","log":L,"reads":[{seq,path,kind,version,authority?}],
//!   "more":bool}`: the oldest N reads numbered after S. Nothing leaves the log by being taken.
//! - `{"t":"ack","log":L,"upTo":S}` answers `{"t":"acked","log":L,"upTo":S}` and drops every read numbered up to S,
//!   once the host has released them; an ack for another log, or past what was handed out, is refused. A release that
//!   failed is simply taken again with the next answer.
//!
//! `L` names this program's log: a new one means the program restarted and its earlier reads are gone, which the host
//! must treat as reads it cannot account for. A version read again while its read waits and has not been handed out
//! is not logged twice; read again after it was handed out, it moves to the end of the log under a new number, so the
//! next answer names it too; acknowledged, it is logged again. So each answer's release names what its commands read.
//! Memory: about 0.6 KB per waiting read (path and version), inside the folder unit's own memory.

use crate::proto::{Authority, EntryKind};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read as _, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// The most reads one answer gives: what the core records in one release.
pub const MAX_TAKE: usize = 10_000;
/// A request line is short; anything longer is not the native host.
const MAX_REQUEST: u64 = 4096;
/// A connection that sends nothing, or reads no answer, this long is ended, so one stuck connection never blocks the next.
const IDLE: Duration = Duration::from_secs(30);

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Read {
	pub seq: u64,
	pub path: String,
	pub kind: EntryKind,
	pub version: String,
	/// The receipt the node listed the entry with. Without one, the host sends the nil-uuid stand-in (resource
	/// 00000000-0000-0000-0000-000000000000, revision 0, no grant) and the core checks the path again; a stale one costs
	/// the core the same check.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub authority: Option<Authority>,
}

pub struct ReadLog {
	id: String,
	next: u64,
	/// The highest number any take handed out.
	handed: u64,
	reads: VecDeque<Read>,
	/// Each waiting read's number, by path and version.
	logged: HashMap<(String, String), u64>,
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
			handed: 0,
			reads: VecDeque::new(),
			logged: HashMap::new(),
		}
	}

	pub fn id(&self) -> &str {
		&self.id
	}

	/// Logs one read of a path's version: once while it waits unread, again (moved to the end) once handed out.
	pub fn note(&mut self, path: &str, kind: EntryKind, version: &str, authority: Option<&Authority>) {
		if path.is_empty() || version.is_empty() {
			return;
		}
		let key = (path.to_string(), version.to_string());
		if let Some(&seq) = self.logged.get(&key) {
			if seq > self.handed {
				return;
			}
			let at = self.reads.partition_point(|r| r.seq < seq);
			self.reads.remove(at);
		}
		self.logged.insert(key, self.next);
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
	pub fn take(&mut self, after: u64, max: usize) -> (Vec<Read>, bool) {
		let start = self.reads.partition_point(|r| r.seq <= after);
		let taken: Vec<Read> = self.reads.iter().skip(start).take(max).cloned().collect();
		let more = self.reads.len() - start > taken.len();
		if let Some(last) = taken.last() {
			self.handed = self.handed.max(last.seq);
		}
		(taken, more)
	}

	/// Drops every read numbered up to `up_to`: the host released them. Never past what was handed out.
	pub fn ack(&mut self, up_to: u64) -> bool {
		if up_to > self.handed {
			return false;
		}
		while self.reads.front().is_some_and(|r| r.seq <= up_to) {
			let r = self.reads.pop_front().expect("a front read");
			self.logged.remove(&(r.path, r.version));
		}
		true
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
		log: String,
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
	stream.set_write_timeout(Some(IDLE))?;
	let mut writer = stream.try_clone()?;
	let mut reader = BufReader::new(stream);
	let invalid = || std::io::Error::new(std::io::ErrorKind::InvalidData, "not a reads request");
	loop {
		let mut line = String::new();
		if (&mut reader).take(MAX_REQUEST).read_line(&mut line)? == 0 {
			return Ok(());
		}
		let request: Request = serde_json::from_str(line.trim_end()).map_err(|_| invalid())?;
		// The answer is built outside the lock: the box's opens never wait on it.
		let mut out = match request {
			Request::Take { after, max } => {
				if !(1..=MAX_TAKE).contains(&max) {
					return Err(invalid());
				}
				let (id, (reads, more)) = {
					let mut log = log.lock().unwrap();
					(log.id().to_string(), log.take(after, max))
				};
				serde_json::to_vec(&Answer::Reads { log: &id, reads: &reads, more })?
			}
			Request::Ack { log: named, up_to } => {
				let id = {
					let mut log = log.lock().unwrap();
					// Another log's acknowledgement (from before a restart) drops nothing.
					if named != log.id() || !log.ack(up_to) {
						return Err(invalid());
					}
					log.id().to_string()
				};
				serde_json::to_vec(&Answer::Acked { log: &id, up_to })?
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
	// SAFETY: fstat and getsockopt only read descriptor 3's kind into local values.
	let stream_socket = unsafe {
		let mut stat: libc::stat = std::mem::zeroed();
		let mut kind: libc::c_int = 0;
		let mut len = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
		libc::fstat(3, &mut stat) == 0
			&& stat.st_mode & libc::S_IFMT == libc::S_IFSOCK
			&& libc::getsockopt(3, libc::SOL_SOCKET, libc::SO_TYPE, (&mut kind as *mut libc::c_int).cast(), &mut len) == 0
			&& kind == libc::SOCK_STREAM
	};
	if !stream_socket {
		return Err("--reads systemd: descriptor 3 is not a stream socket".into());
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
		assert!(!log.ack(1), "nothing was handed out yet");
		let (first, more) = log.take(0, 2);
		assert!(more);
		assert_eq!(first.iter().map(|r| (r.seq, r.version.as_str())).collect::<Vec<_>>(), [(1, "v1"), (2, "f1")]);
		// Taking again gives the same reads: nothing left the log.
		assert_eq!(log.take(0, 2).0, first);
		// v1 is read again after it was handed out: it moves to the end under a new number, for the next answer.
		log.note("docs/plan.md", EntryKind::File, "v1", Some(&receipt(1)));
		assert_eq!(log.len(), 3);
		// Waiting and not handed out since: not logged twice.
		log.note("docs/plan.md", EntryKind::File, "v2", Some(&receipt(2)));
		log.note("docs/plan.md", EntryKind::File, "v1", Some(&receipt(1)));
		assert_eq!(log.len(), 3);
		let (rest, more) = log.take(2, MAX_TAKE);
		assert!(!more);
		assert_eq!(rest.iter().map(|r| (r.seq, r.version.as_str())).collect::<Vec<_>>(), [(3, "v2"), (4, "v1")]);
		assert!(!log.ack(5), "never past what was handed out");
		assert!(log.ack(2));
		assert_eq!(log.take(0, MAX_TAKE).0.iter().map(|r| r.seq).collect::<Vec<_>>(), [3, 4]);
		assert!(log.ack(4));
		assert!(log.is_empty());
		log.note("docs/plan.md", EntryKind::File, "v1", Some(&receipt(1)));
		assert_eq!(log.take(4, MAX_TAKE).0.iter().map(|r| (r.seq, r.version.as_str())).collect::<Vec<_>>(), [(5, "v1")]);
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
		assert_eq!(
			ask(&format!("{{\"t\":\"ack\",\"log\":\"{id}\",\"upTo\":1}}\n")),
			format!("{{\"t\":\"acked\",\"log\":\"{id}\",\"upTo\":1}}\n")
		);
		assert_eq!(
			ask("{\"t\":\"take\",\"after\":0,\"max\":10}\n"),
			format!("{{\"t\":\"reads\",\"log\":\"{id}\",\"reads\":[],\"more\":false}}\n")
		);
		assert_eq!(ask("{\"t\":\"take\",\"after\":0,\"max\":0}\n"), "", "a bad request ends the connection");
		// Another log's acknowledgement (from before a restart) drops nothing, and ends the connection too.
		log.lock().unwrap().note("b.txt", EntryKind::File, "v1", None);
		let mut other = UnixStream::connect(&path).unwrap();
		let mut other_reader = BufReader::new(other.try_clone().unwrap());
		other.write_all(b"{\"t\":\"take\",\"after\":0,\"max\":10}\n").unwrap();
		let mut line = String::new();
		other_reader.read_line(&mut line).unwrap();
		other.write_all(format!("{{\"t\":\"ack\",\"log\":\"{}\",\"upTo\":2}}\n", "0".repeat(32)).as_bytes()).unwrap();
		line.clear();
		assert_eq!(other_reader.read_line(&mut line).unwrap(), 0);
		assert_eq!(log.lock().unwrap().len(), 1);
		let _ = std::fs::remove_dir_all(&dir);
	}
}
