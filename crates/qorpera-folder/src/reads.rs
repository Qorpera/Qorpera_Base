//! The read log of a run box's mount (F3 step 2b): which versions the box opened since the run's native host last
//! asked, so the host can release them as the run's reads with each answer it gives the model. The mount sees every
//! open and every folder listing (the kernel caches pages, not opens), so an answer's reads are the ones its commands
//! made, whatever was cached.
//!
//! The host asks on a Unix socket that systemd passes to the mount (`--reads systemd`): one JSON line
//! `{"t":"take","max":N}`, answered by `{"t":"reads","reads":[...],"more":bool}` with at most N reads, oldest first;
//! taken reads leave the log. A version opened again after it was taken is logged again: the next answer read it too.

use crate::proto::{Authority, EntryKind};
use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::{Arc, Mutex};

/// The most reads one answer gives: what the core records in one release.
pub const MAX_TAKE: usize = 10_000;
/// A request line is short; anything longer is not the native host.
const MAX_REQUEST: u64 = 4096;

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Read {
	pub path: String,
	pub kind: EntryKind,
	pub version: String,
	/// The receipt the node listed the entry with; the core checks the path again when it is missing or stale.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub authority: Option<Authority>,
}

#[derive(Default)]
pub struct ReadLog {
	reads: VecDeque<Read>,
	logged: HashSet<(String, String)>,
}

impl ReadLog {
	/// Logs one read of a path's version, once until it is taken. The root and folders shown only because they hold
	/// readable paths have no version and are not reads.
	pub fn note(&mut self, path: &str, kind: EntryKind, version: &str, authority: Option<&Authority>) {
		if path.is_empty() || version.is_empty() || !self.logged.insert((path.to_string(), version.to_string())) {
			return;
		}
		self.reads.push_back(Read {
			path: path.to_string(),
			kind,
			version: version.to_string(),
			authority: authority.cloned(),
		});
	}

	/// The oldest `max` reads, and whether more are left.
	pub fn take(&mut self, max: usize) -> (Vec<Read>, bool) {
		let n = max.min(self.reads.len());
		let taken: Vec<Read> = self.reads.drain(..n).collect();
		for r in &taken {
			self.logged.remove(&(r.path.clone(), r.version.clone()));
		}
		(taken, !self.reads.is_empty())
	}

	pub fn len(&self) -> usize {
		self.reads.len()
	}

	pub fn is_empty(&self) -> bool {
		self.reads.is_empty()
	}
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Take {
	t: String,
	max: usize,
}

#[derive(Serialize)]
struct Answer<'a> {
	t: &'static str,
	reads: &'a [Read],
	more: bool,
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
				Err(e) => eprintln!("qorpera-folder: reads socket: {e}"),
			}
		}
	});
}

fn answer(stream: UnixStream, log: &Mutex<ReadLog>) -> std::io::Result<()> {
	let mut writer = stream.try_clone()?;
	let mut reader = BufReader::new(stream);
	loop {
		let mut line = String::new();
		if (&mut reader).take(MAX_REQUEST).read_line(&mut line)? == 0 {
			return Ok(());
		}
		let request: Take = match serde_json::from_str(line.trim_end()) {
			Ok(r) => r,
			Err(_) => return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "not a take request")),
		};
		if request.t != "take" || !(1..=MAX_TAKE).contains(&request.max) {
			return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "not a take request"));
		}
		let (reads, more) = log.lock().unwrap().take(request.max);
		let mut out = serde_json::to_vec(&Answer { t: "reads", reads: &reads, more })?;
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
	// SAFETY: systemd passed descriptor 3 to this process alone (LISTEN_PID), and nothing else here owns it.
	let listener = unsafe { UnixListener::from_raw_fd(3) };
	// Not passed on to anything this program starts (it starts nothing, but stays safe if it ever does).
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
	fn logs_each_version_once_until_taken_and_takes_oldest_first() {
		let mut log = ReadLog::default();
		log.note("docs/plan.md", EntryKind::File, "v1", Some(&receipt(1)));
		log.note("docs/plan.md", EntryKind::File, "v1", Some(&receipt(1)));
		log.note("docs", EntryKind::Folder, "f1", None);
		log.note("docs/plan.md", EntryKind::File, "v2", Some(&receipt(2)));
		log.note("", EntryKind::Folder, "", None);
		log.note("implicit", EntryKind::Folder, "", None);
		assert_eq!(log.len(), 3);
		let (first, more) = log.take(2);
		assert!(more);
		assert_eq!(first.iter().map(|r| r.version.as_str()).collect::<Vec<_>>(), ["v1", "f1"]);
		// Taken: a new open of the same version is the next answer's read.
		log.note("docs/plan.md", EntryKind::File, "v1", Some(&receipt(1)));
		let (rest, more) = log.take(MAX_TAKE);
		assert!(!more);
		assert_eq!(rest.iter().map(|r| r.version.as_str()).collect::<Vec<_>>(), ["v2", "v1"]);
		assert!(log.is_empty());
	}

	#[test]
	fn answers_take_requests_and_ends_on_anything_else() {
		let dir = std::env::temp_dir().join(format!("qorpera-reads-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		std::fs::create_dir_all(&dir).unwrap();
		let path = dir.join("reads.sock");
		let listener = UnixListener::bind(&path).unwrap();
		let log = Arc::new(Mutex::new(ReadLog::default()));
		log.lock().unwrap().note("a.txt", EntryKind::File, "v1", Some(&receipt(7)));
		serve(listener, log.clone());
		let mut stream = UnixStream::connect(&path).unwrap();
		stream.write_all(b"{\"t\":\"take\",\"max\":10}\n").unwrap();
		let mut reader = BufReader::new(stream.try_clone().unwrap());
		let mut line = String::new();
		reader.read_line(&mut line).unwrap();
		assert_eq!(
			line,
			"{\"t\":\"reads\",\"reads\":[{\"path\":\"a.txt\",\"kind\":\"file\",\"version\":\"v1\",\"authority\":{\"resourceId\":\"00000000-0000-4000-8000-000000000001\",\"resourceRevision\":7,\"grantId\":null,\"grantRevision\":null}}],\"more\":false}\n"
		);
		stream.write_all(b"{\"t\":\"take\",\"max\":0}\n").unwrap();
		line.clear();
		assert_eq!(reader.read_line(&mut line).unwrap(), 0, "a bad request ends the connection");
		let _ = std::fs::remove_dir_all(&dir);
	}
}
