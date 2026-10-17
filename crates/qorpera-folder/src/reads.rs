//! A mount's read journal, kept under /run across program/service restarts. A successful FUSE open (or readlink, or
//! a hard link's read of its source) is logged before its reply. Nothing is forgotten until the service says the core
//! released it. The mount and a separate publisher share a fixed lock-file inode; replacing a compacted journal never
//! replaces that lock. A damaged journal leaves a permanent lost marker: a later retry must not turn missing proof
//! into an empty successful boundary.

use crate::frame::MAX_PAYLOAD;
use crate::proto::{valid_path, Authority, LoggedRead, ReadsAnswer, ReadsRequest};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

const JOURNAL: &str = "reads.jsonl";
const LOCK: &str = "reads.lock";
const LOST: &str = "reads.lost";
const MAX_SEQUENCE: u64 = 9_007_199_254_740_991;

#[derive(Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase", deny_unknown_fields)]
enum Line {
	Start { log: String, released: u64 },
	Read { read: LoggedRead },
	Released { seq: u64 },
}

struct State {
	log: String,
	last: u64,
	released: u64,
	reads: VecDeque<LoggedRead>,
	lines: usize,
	lost: bool,
}

struct Local {
	lock: File,
	state: Option<State>,
	/// Inode and bytes consumed. Other processes' appended records are read incrementally; compaction replaces the
	/// inode, so its complete snapshot is read instead. The lock keeps a record whole for every reader.
	stamp: Option<(u64, u64, u64)>,
}

pub struct ReadLog {
	dir: PathBuf,
	local: Mutex<Local>,
	created: bool,
}

pub struct Locked<'a> {
	dir: &'a Path,
	local: MutexGuard<'a, Local>,
}

impl ReadLog {
	/// `fresh` allows initialization only in a genuinely unused state folder. A publisher passes false: a missing
	/// journal is missing proof, never an invitation to start a new log. The helper gives each new mount empty state.
	pub fn open(dir: &Path, fresh: bool) -> io::Result<ReadLog> {
		if fresh {
			std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
		}
		let meta = std::fs::symlink_metadata(dir)?;
		// The stable lock and journal names are meaningful only inside a directory the daemon alone can replace.
		// SAFETY: geteuid has no preconditions.
		if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
			return Err(io::Error::new(
				io::ErrorKind::PermissionDenied,
				"read journal directory must be private to the daemon",
			));
		}
		// The CLI holds its process-lifetime lock before any state or connection mutation. That fixed lock alone
		// is not prior read proof; a journal lock, version map or view checkpoint is, even if the journal went missing.
		let unused = std::fs::read_dir(dir)?.try_fold(true, |unused, entry| {
			Ok::<_, io::Error>(unused && entry?.file_name() == "daemon.lock")
		})?;
		let lock = private_file(&dir.join(LOCK), true)?;
		let mut out = ReadLog { dir: dir.to_path_buf(), local: Mutex::new(Local { lock, state: None, stamp: None }), created: false };
		let created;
		{
			let mut held = out.acquire()?;
			created = !dir.join(JOURNAL).exists() && fresh && unused;
			if created {
				let state = State { log: uuid()?, last: 0, released: 0, reads: VecDeque::new(), lines: 1, lost: false };
				held.local.state = Some(state);
				held.rewrite()?;
			}
			held.refresh();
		}
		out.created = created;
		Ok(out)
	}

	/// This instance initialized the journal in empty mount state; missing adjacent proof may only be initialized then.
	pub fn created(&self) -> bool { self.created }

	fn acquire(&self) -> io::Result<Locked<'_>> {
		let local = self.local.lock().unwrap();
		loop {
			// SAFETY: flock uses the live file descriptor owned by this guard. The in-process mutex is necessary:
			// threads sharing one open file description do not exclude each other with flock alone.
			if unsafe { libc::flock(local.lock.as_raw_fd(), libc::LOCK_EX) } == 0 {
				return Ok(Locked { dir: &self.dir, local });
			}
			let e = io::Error::last_os_error();
			if e.kind() != io::ErrorKind::Interrupted {
				return Err(e);
			}
		}
	}

	pub fn locked(&self) -> io::Result<Locked<'_>> {
		let mut held = self.acquire()?;
		held.refresh();
		Ok(held)
	}

	pub fn note(&self, path: &str, version: Option<&str>, authority: Option<&Authority>) -> io::Result<()> {
		if path.is_empty() {
			return Ok(());
		}
		let mut held = self.locked()?;
		if held.lost() {
			return Err(unproven());
		}
		let seq = held.state().last.checked_add(1).filter(|n| *n <= MAX_SEQUENCE).ok_or_else(unproven)?;
		let read = LoggedRead {
			seq,
			path: path.to_string(),
			version: version.map(str::to_string),
			authority: authority.cloned(),
		};
		if !valid_path(path) {
			return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid logged path"));
		}
		if let Err(e) = held.append(&Line::Read { read: read.clone() }) {
			held.mark_lost();
			return Err(e);
		}
		let state = held.local.state.as_mut().unwrap();
		state.last = seq;
		state.reads.push_back(read);
		Ok(())
	}
}

impl Locked<'_> {
	fn state(&self) -> &State {
		self.local.state.as_ref().expect("the journal was opened")
	}
	pub fn last(&self) -> u64 {
		self.state().last
	}
	pub fn released(&self) -> u64 {
		self.state().released
	}
	pub fn lost(&self) -> bool {
		self.state().lost
	}

	/// A bounded, consecutive batch after `after`, or an empty poll. Released records are already in the core and
	/// need not be replayed after the service restarts. Budget actual encoded bytes, including escaped path names.
	pub fn request(&self, after: u64) -> ReadsRequest {
		let state = self.state();
		let mut reads = Vec::new();
		let mut bytes = 256;
		if !state.lost {
			// The deque is consecutive and starts immediately after the released prefix. Jump directly to
			// the requested suffix instead of rescanning every retained read before every batch or mutation.
			let start = after.saturating_sub(state.released).min(state.reads.len() as u64) as usize;
			for read in state.reads.range(start..) {
				let size = serde_json::to_vec(read).expect("a read serializes").len() + 1;
				if bytes + size > MAX_PAYLOAD || reads.len() == 10_000 {
					break;
				}
				bytes += size;
				reads.push(read.clone());
			}
		}
		ReadsRequest { log: state.log.clone(), reads, lost: state.lost }
	}

	/// Only the service's released prefix permits forgetting entries. A restarted service may report a lower
	/// watermark; that never takes back a durable acknowledgement. Impossible acknowledgements poison this mount.
	pub fn acknowledge(&mut self, answer: &ReadsAnswer) -> io::Result<()> {
		let state = self.state();
		if answer.log != state.log || answer.released > answer.taken || answer.taken > state.last {
			self.mark_lost();
			return Err(unproven());
		}
		if answer.released <= state.released {
			return Ok(());
		}
		self.append(&Line::Released { seq: answer.released }).inspect_err(|_| self.mark_lost())?;
		let state = self.local.state.as_mut().unwrap();
		state.released = answer.released;
		while state.reads.front().is_some_and(|r| r.seq <= state.released) {
			state.reads.pop_front();
		}
		if state.lines > 2 * state.reads.len() + 1024 {
			// Compaction failing leaves the already-synced journal and acknowledgement intact.
			if let Err(e) = self.rewrite() {
				eprintln!("qorpera-folder: read journal compaction: {e}");
			}
		}
		Ok(())
	}

	fn refresh(&mut self) {
		if self.local.state.as_ref().is_some_and(|s| s.lost) {
			return;
		}
		if self.dir.join(LOST).try_exists().unwrap_or(true) || self.load().is_err() {
			self.mark_lost();
		}
	}

	fn load(&mut self) -> io::Result<()> {
		let mut file = private_file(&self.dir.join(JOURNAL), false)?;
		let meta = file.metadata()?;
		let stamp = (meta.dev(), meta.ino(), meta.len());
		if self.local.stamp == Some(stamp) {
			return Ok(());
		}
		let offset = match self.local.stamp {
			Some((dev, ino, len)) if (dev, ino) == (stamp.0, stamp.1) && len <= stamp.2 => len,
			_ => 0,
		};
		file.seek(SeekFrom::Start(offset))?;
		let mut bytes = Vec::new();
		file.read_to_end(&mut bytes)?;
		let complete = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |n| n + 1);
		// A partial final append never returned its open/ack. Preserve all complete records and trim just that tail.
		if complete < bytes.len() {
			file.set_len(offset + complete as u64)?;
			file.sync_data()?;
		}
		let old_last = self.local.state.as_ref().map_or(0, |s| s.last);
		let old_released = self.local.state.as_ref().map_or(0, |s| s.released);
		let old_log = self.local.state.as_ref().map(|s| s.log.clone());
		if offset == 0 {
			self.local.state = None;
		}
		for bytes in bytes[..complete].split_inclusive(|b| *b == b'\n') {
			let line: Line = serde_json::from_slice(bytes).map_err(|_| unproven())?;
			match line {
				Line::Start { log, released }
					if self.local.state.is_none() && valid_id(&log) && released <= MAX_SEQUENCE =>
				{
					self.local.state =
						Some(State { log, last: released, released, reads: VecDeque::new(), lines: 0, lost: false });
				}
				Line::Read { read } => {
					let state = self.local.state.as_mut().ok_or_else(unproven)?;
					if read.seq != state.last + 1
						|| read.seq > MAX_SEQUENCE
						|| read.path.is_empty()
						|| !valid_path(&read.path)
					{
						return Err(unproven());
					}
					state.last = read.seq;
					state.reads.push_back(read);
				}
				Line::Released { seq } => {
					let state = self.local.state.as_mut().ok_or_else(unproven)?;
					if seq < state.released || seq > state.last {
						return Err(unproven());
					}
					state.released = seq;
					while state.reads.front().is_some_and(|r| r.seq <= seq) {
						state.reads.pop_front();
					}
				}
				_ => return Err(unproven()),
			}
			self.local.state.as_mut().unwrap().lines += 1;
		}
		let state = self.local.state.as_ref().ok_or_else(unproven)?;
		if state.last < old_last || state.released < old_released || old_log.is_some_and(|id| id != state.log) {
			return Err(unproven());
		}
		self.local.stamp = Some((stamp.0, stamp.1, offset + complete as u64));
		Ok(())
	}

	fn append(&mut self, line: &Line) -> io::Result<()> {
		let mut file = private_file(&self.dir.join(JOURNAL), false)?;
		file.seek(SeekFrom::End(0))?;
		let mut bytes = serde_json::to_vec(line)?;
		bytes.push(b'\n');
		file.write_all(&bytes)?;
		file.sync_data()?;
		let meta = file.metadata()?;
		self.local.stamp = Some((meta.dev(), meta.ino(), meta.len()));
		self.local.state.as_mut().unwrap().lines += 1;
		Ok(())
	}

	fn rewrite(&mut self) -> io::Result<()> {
		let path = self.dir.join("reads.jsonl.new");
		let mut file = private_file(&path, true)?;
		file.set_len(0)?;
		let state = self.state();
		serde_json::to_writer(&mut file, &Line::Start { log: state.log.clone(), released: state.released })?;
		file.write_all(b"\n")?;
		for read in &state.reads {
			serde_json::to_writer(&mut file, &Line::Read { read: read.clone() })?;
			file.write_all(b"\n")?;
		}
		file.sync_all()?;
		std::fs::rename(&path, self.dir.join(JOURNAL))?;
		File::open(self.dir)?.sync_all()?;
		let meta = file.metadata()?;
		self.local.stamp = Some((meta.dev(), meta.ino(), meta.len()));
		let state = self.local.state.as_mut().unwrap();
		state.lines = state.reads.len() + 1;
		Ok(())
	}

	fn mark_lost(&mut self) {
		if self.local.state.is_none() {
			// The UUID carries no authority. A lost journal needs only a valid id to notify the service permanently.
			let log = uuid().unwrap_or_else(|_| "00000000-0000-4000-8000-000000000000".into());
			self.local.state = Some(State { log, last: 0, released: 0, reads: VecDeque::new(), lines: 0, lost: true });
		}
		self.local.state.as_mut().unwrap().lost = true;
		let persist = || -> io::Result<()> {
			private_file(&self.dir.join(LOST), true)?.sync_all()?;
			File::open(self.dir)?.sync_all()
		};
		if let Err(e) = persist() {
			eprintln!("qorpera-folder: read proof is lost; could not persist its marker: {e}");
		}
	}
}

impl Drop for Locked<'_> {
	fn drop(&mut self) {
		// SAFETY: the guard still owns the live descriptor and mutex. Closing the process also releases the lock.
		unsafe { libc::flock(self.local.lock.as_raw_fd(), libc::LOCK_UN) };
	}
}

fn private_file(path: &Path, create: bool) -> io::Result<File> {
	let file = OpenOptions::new()
		.read(true)
		.write(true)
		.create(create)
		.mode(0o600)
		.custom_flags(libc::O_NOFOLLOW)
		.open(path)?;
	let meta = file.metadata()?;
	// SAFETY: geteuid has no preconditions.
	if !meta.is_file() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
		return Err(io::Error::new(
			io::ErrorKind::PermissionDenied,
			"read journal files must be private to the daemon",
		));
	}
	Ok(file)
}

fn unproven() -> io::Error {
	io::Error::other("the mount's read journal cannot be shown complete (unproven)")
}

fn valid_id(id: &str) -> bool {
	id.len() == 36
		&& id.bytes().enumerate().all(
			|(n, b)| {
				if [8, 13, 18, 23].contains(&n) {
					b == b'-'
				} else {
					b.is_ascii_hexdigit()
				}
			},
		)
}

fn uuid() -> io::Result<String> {
	let mut bytes = [0u8; 16];
	let mut at = 0;
	while at < bytes.len() {
		// SAFETY: getrandom writes only into the remaining valid bytes of this local array.
		let n = unsafe { libc::getrandom(bytes[at..].as_mut_ptr().cast(), bytes.len() - at, 0) };
		if n < 0 {
			let e = io::Error::last_os_error();
			if e.kind() == io::ErrorKind::Interrupted {
				continue;
			}
			return Err(e);
		}
		if n == 0 {
			return Err(io::Error::other("getrandom returned no bytes"));
		}
		at += n as usize;
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	let h: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
	Ok(format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..]))
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::sync::Arc;

	struct Temp(PathBuf);
	impl Temp {
		fn new() -> Temp {
			Temp(std::env::temp_dir().join(format!("qorpera-read-log-{}", uuid().unwrap())))
		}
	}
	impl Drop for Temp {
		fn drop(&mut self) {
			let _ = std::fs::remove_dir_all(&self.0);
		}
	}

	#[test]
	fn restart_replays_only_the_durably_released_prefixs_successors() {
		let dir = Temp::new();
		let log = ReadLog::open(&dir.0, true).unwrap();
		log.note("", None, None).unwrap();
		let receipt =
			Authority { resource_id: uuid().unwrap(), resource_revision: 9, grant_id: None, grant_revision: None };
		log.note("docs", None, Some(&receipt)).unwrap();
		log.note("docs/a", Some("abcdef"), Some(&receipt)).unwrap();
		let id;
		{
			let mut held = log.locked().unwrap();
			let request = held.request(0);
			id = request.log.clone();
			assert_eq!(request.reads.iter().map(|r| r.seq).collect::<Vec<_>>(), [1, 2]);
			assert_eq!(request.reads[0].version, None);
			assert_eq!(request.reads[1].authority, Some(receipt));
			held.acknowledge(&ReadsAnswer { log: id.clone(), taken: 2, released: 1 }).unwrap();
		}
		drop(log);
		let log = ReadLog::open(&dir.0, false).unwrap();
		let mut held = log.locked().unwrap();
		assert_eq!(held.request(0).log, id);
		assert_eq!(held.request(0).reads.iter().map(|r| r.seq).collect::<Vec<_>>(), [2]);
		// A new service's empty log cannot undo what the core already acknowledged.
		held.acknowledge(&ReadsAnswer { log: id, taken: 0, released: 0 }).unwrap();
		assert_eq!(held.released(), 1);
	}

	#[test]
	fn separate_publishers_and_mount_threads_share_one_sequence_through_compaction() {
		let dir = Temp::new();
		let mount = Arc::new(ReadLog::open(&dir.0, true).unwrap());
		let publisher = ReadLog::open(&dir.0, false).unwrap();
		let threads: Vec<_> = (0..4)
			.map(|n| {
				let mount = mount.clone();
				std::thread::spawn(move || {
					for i in 0..100 {
						mount.note(&format!("{n}/{i}"), Some("a"), None).unwrap();
					}
				})
			})
			.collect();
		for thread in threads {
			thread.join().unwrap();
		}
		{
			let mut held = publisher.locked().unwrap();
			assert_eq!(held.last(), 400);
			assert_eq!(held.request(0).reads.iter().map(|r| r.seq).collect::<Vec<_>>(), (1..=400).collect::<Vec<_>>());
			let id = held.request(0).log;
			held.acknowledge(&ReadsAnswer { log: id, taken: 400, released: 399 }).unwrap();
			held.rewrite().unwrap();
		}
		mount.note("after", None, None).unwrap();
		let held = publisher.locked().unwrap();
		assert_eq!(held.request(0).reads.iter().map(|r| r.seq).collect::<Vec<_>>(), [400, 401]);
		assert_eq!(held.last(), 401);
	}

	#[test]
	fn a_torn_unanswered_append_is_trimmed_but_complete_bad_records_poison_the_mount() {
		let dir = Temp::new();
		let log = ReadLog::open(&dir.0, true).unwrap();
		log.note("kept", Some("a"), None).unwrap();
		drop(log);
		let path = dir.0.join(JOURNAL);
		OpenOptions::new().append(true).open(&path).unwrap().write_all(b"{\"t\":\"read\"").unwrap();
		let log = ReadLog::open(&dir.0, false).unwrap();
		assert!(!log.locked().unwrap().lost());
		log.note("next", Some("b"), None).unwrap();
		assert_eq!(log.locked().unwrap().last(), 2);
		OpenOptions::new().append(true).open(&path).unwrap().write_all(b"not-json\n").unwrap();
		assert!(log.locked().unwrap().lost());
		assert!(log.note("refused", None, None).is_err());
		// Replacing even the whole journal with apparently valid bytes cannot undo its durable lost marker.
		std::fs::remove_file(&path).unwrap();
		drop(log);
		assert!(ReadLog::open(&dir.0, true).unwrap().locked().unwrap().lost());
	}

	#[test]
	fn missing_journals_and_impossible_acknowledgements_are_never_an_empty_success() {
		for existing_versions in [false, true] {
			let dir = Temp::new();
			std::fs::DirBuilder::new().mode(0o700).create(&dir.0).unwrap();
			if existing_versions {
				std::fs::write(dir.0.join("versions.jsonl"), b"").unwrap();
			}
			let log = ReadLog::open(&dir.0, existing_versions).unwrap();
			assert!(log.locked().unwrap().request(0).lost);
		}
		let dir = Temp::new();
		let log = ReadLog::open(&dir.0, true).unwrap();
		log.note("a", Some("a"), None).unwrap();
		let mut held = log.locked().unwrap();
		let id = held.request(0).log;
		assert!(held.acknowledge(&ReadsAnswer { log: id, taken: 1, released: 2 }).is_err());
		assert!(held.lost());
	}

	#[test]
	fn a_publisher_never_creates_missing_state_or_a_lost_marker_there() {
		let dir = Temp::new();
		assert!(matches!(ReadLog::open(&dir.0, false), Err(e) if e.kind() == io::ErrorKind::NotFound));
		assert!(!dir.0.exists());
		let nested = dir.0.join("wrong/state");
		assert!(ReadLog::open(&nested, false).is_err());
		assert!(!dir.0.exists());
	}

	#[test]
	fn a_failed_append_is_unproven_and_a_new_mount_uses_an_independent_empty_log() {
		let dir = Temp::new();
		let log = ReadLog::open(&dir.0, true).unwrap();
		log.note("a", Some("a"), None).unwrap();
		let id = log.locked().unwrap().request(0).log;
		// Replacing the journal with a directory cannot silently serve another open.
		std::fs::remove_file(dir.0.join(JOURNAL)).unwrap();
		std::fs::create_dir(dir.0.join(JOURNAL)).unwrap();
		assert!(log.note("b", Some("b"), None).is_err());
		assert!(log.locked().unwrap().lost());
		drop(log);
		assert!(ReadLog::open(&dir.0, false).unwrap().locked().unwrap().lost());
		let fresh = Temp::new();
		let next = ReadLog::open(&fresh.0, true).unwrap();
		let next = next.locked().unwrap();
		assert_ne!(next.request(0).log, id);
		assert_eq!(next.last(), 0);
		assert!(!next.lost());
	}

	#[test]
	fn state_and_journal_files_must_be_owned_by_the_daemon_and_private() {
		use std::os::unix::fs::{symlink, PermissionsExt};
		let dir = Temp::new();
		std::fs::create_dir(&dir.0).unwrap();
		std::fs::set_permissions(&dir.0, std::fs::Permissions::from_mode(0o755)).unwrap();
		assert!(ReadLog::open(&dir.0, true).is_err());
		std::fs::set_permissions(&dir.0, std::fs::Permissions::from_mode(0o700)).unwrap();
		let log = ReadLog::open(&dir.0, true).unwrap();
		std::fs::set_permissions(dir.0.join(JOURNAL), std::fs::Permissions::from_mode(0o644)).unwrap();
		assert!(log.note("not-served", Some("a"), None).is_err());
		let alias = Temp::new();
		symlink(&dir.0, &alias.0).unwrap();
		assert!(ReadLog::open(&alias.0, false).is_err());
	}

	#[test]
	fn batches_fit_frames_even_for_paths_with_expensive_json_escaping() {
		let dir = Temp::new();
		let log = ReadLog::open(&dir.0, true).unwrap();
		let path = vec!["\u{0001}".repeat(250); 16].join("/");
		for _ in 0..100 {
			log.note(&path, None, None).unwrap();
		}
		let held = log.locked().unwrap();
		let request = held.request(0);
		assert!(request.reads.len() < 100 && !request.reads.is_empty());
		assert!(serde_json::to_vec(&request).unwrap().len() <= MAX_PAYLOAD);
		assert_eq!(held.request(request.reads.last().unwrap().seq).reads.last().unwrap().seq, 100);
	}
}
