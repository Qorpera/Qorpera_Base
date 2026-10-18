//! The other programs on one `--cache-dir` (MC3a, `deploy/first-node/RUNTIME-FOLDER-MACHINE-CACHES.md` "The kernel
//! cache"). Each one's kernel keeps cache names, attributes and pages, so a change one program makes in the shared
//! caches is told to every other before its own reply: each listens on `<caches>/programs/<pid>.<8hex>`, forgets what
//! it was told on its own mount, and only then answers. One JSON line per change, `{"seq":N}` back.
//!
//! A listener that does not answer within `WAIT` fails the teller's request (EIO); one that hears a change later than
//! that may have answered stale meanwhile, which its handler learns as `Heard::Late`. A refused connection is a dead
//! program, whose socket is removed. Local inode numbers are the disk's (`Local::id`), the same in every program; a cache
//! top's folder goes by its node path, which each program maps to its own inode.

use crate::local::LOCAL;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::fd::FromRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, MetadataExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

/// How long a teller waits for each listener's answer, and how old a change a listener takes as on time.
pub const WAIT: Duration = Duration::from_secs(10);
/// A longer line closes its connection.
const LINE_MAX: usize = 1 << 20;
/// Lines written before their answers are read, so neither side's socket buffer fills.
const WINDOW: usize = 256;

/// What a change made stale in another program's kernel: a cache file's attributes and pages (`ino`), and/or one name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Change {
	pub ino: Option<u64>,
	pub name: Option<(Parent, String)>,
}

/// The folder a told name is in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Parent {
	/// A local folder in the caches, by its inode.
	Local(u64),
	/// A node folder (a cache top's parent), by its path.
	Dir(String),
}

impl Change {
	pub fn ino(ino: u64) -> Change {
		Change { ino: Some(ino), name: None }
	}

	pub fn name(parent: Parent, name: &str) -> Change {
		Change { ino: None, name: Some((parent, name.to_string())) }
	}
}

/// What a listener's handler hears. It answers once the handler returns.
#[derive(Debug, PartialEq, Eq)]
pub enum Heard {
	Change(Change),
	/// Told more than `WAIT` after it was made: the teller has given up, and this kernel may have answered stale.
	Late(Change),
	/// A line that is no change. Its sender is a program of this account, so the handler forgets everything.
	Malformed(String),
	/// The listener can take no more changes (its socket is removed): nothing tells this program a change any more.
	Deaf(String),
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Line {
	seq: u64,
	/// CLOCK_MONOTONIC in nanoseconds when the change was told, the same clock for every program on the machine.
	at: u64,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	ino: Option<u64>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	name: Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	up: Option<u64>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	dir: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ack {
	seq: u64,
}

impl Line {
	fn new(seq: u64, at: u64, change: &Change) -> Line {
		let (name, up, dir) = match &change.name {
			None => (None, None, None),
			Some((Parent::Local(up), name)) => (Some(name.clone()), Some(*up), None),
			Some((Parent::Dir(dir), name)) => (Some(name.clone()), None, Some(dir.clone())),
		};
		Line { seq, at, ino: change.ino, name, up, dir }
	}

	/// The change, if the line is one: local inodes have `LOCAL`, a name is one name in exactly one folder.
	fn change(self) -> Option<Change> {
		let local = |ino: u64| ino & LOCAL != 0;
		if self.ino.is_some_and(|ino| !local(ino)) {
			return None;
		}
		let name = match (self.name, self.up, self.dir) {
			(None, None, None) => None,
			(Some(name), Some(up), None) if local(up) => Some((Parent::Local(up), name)),
			(Some(name), None, Some(dir)) if crate::proto::valid_path(&dir) => Some((Parent::Dir(dir), name)),
			_ => return None,
		};
		if name.as_ref().is_some_and(|(_, name)| !crate::proto::valid_name(name)) || (self.ino.is_none() && name.is_none()) {
			return None;
		}
		Some(Change { ino: self.ino, name })
	}
}

/// CLOCK_MONOTONIC in nanoseconds.
fn now() -> u64 {
	let mut t = libc::timespec { tv_sec: 0, tv_nsec: 0 };
	// SAFETY: `t` is a valid timespec for the call to fill.
	unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut t) };
	t.tv_sec as u64 * 1_000_000_000 + t.tv_nsec as u64
}

/// This program's socket in the programs folder. Its threads serve it until the program ends; `remove` takes its name
/// away first, so no teller waits for this program again.
pub struct Listener {
	name: String,
	path: PathBuf,
}

impl Listener {
	/// The socket's name in the programs folder, which this program's own teller skips.
	pub fn name(&self) -> &str {
		&self.name
	}

	pub fn remove(&self) {
		let _ = fs::remove_file(&self.path);
	}
}

/// Listens in the programs folder `dir`, making it (0700) if it is missing. `heard` runs on the connection's own thread
/// for each line it reads, and the line is answered once it returns. A listener that can no longer accept removes its
/// socket and tells `heard` it is deaf: nothing tells this program a change from then on.
pub fn listen(dir: &Path, heard: impl Fn(Heard) + Send + Sync + 'static) -> io::Result<Listener> {
	folder(dir)?;
	let name = format!("{}.{:08x}", std::process::id(), random()?);
	let hidden = dir.join(format!(".{name}"));
	let path = dir.join(&name);
	let listener = UnixListener::bind(&hidden)?;
	// Listening before tellers see it: one that found it refusing would remove it as a dead program's.
	if let Err(e) = fs::rename(&hidden, &path) {
		let _ = fs::remove_file(&hidden);
		return Err(e);
	}
	let heard: Arc<dyn Fn(Heard) + Send + Sync> = Arc::new(heard);
	let socket = path.clone();
	let spawned = std::thread::Builder::new().name("peers".into()).spawn(move || {
		for stream in listener.incoming() {
			let stream = match stream {
				Ok(s) => s,
				Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
				Err(e) if matches!(e.raw_os_error(), Some(libc::EBADF | libc::EINVAL | libc::ENOTSOCK)) => {
					let _ = fs::remove_file(&socket);
					heard(Heard::Deaf(format!("accept: {e}")));
					return;
				}
				Err(e) => {
					eprintln!("qorpera-folder: programs: accept: {e}");
					std::thread::sleep(Duration::from_millis(100));
					continue;
				}
			};
			let heard = heard.clone();
			let spawned = std::thread::Builder::new().name("peers-in".into()).spawn(move || serve(stream, &*heard));
			// The teller's connection ends unanswered and it fails its request.
			if let Err(e) = spawned {
				eprintln!("qorpera-folder: programs: no thread for a connection: {e}");
			}
		}
	});
	if let Err(e) = spawned {
		let _ = fs::remove_file(&path);
		return Err(e);
	}
	Ok(Listener { name, path })
}

/// Answers one teller's lines in order. A line without a sequence number to answer closes the connection, so its
/// teller fails at once rather than at its time-out.
fn serve(stream: UnixStream, heard: &(dyn Fn(Heard) + Send + Sync)) {
	let mut out = match stream.try_clone() {
		Ok(s) => s,
		Err(e) => return eprintln!("qorpera-folder: programs: {e}"),
	};
	let _ = out.set_write_timeout(Some(WAIT));
	let mut lines = BufReader::new(stream);
	let mut line = Vec::new();
	loop {
		line.clear();
		match (&mut lines).take(LINE_MAX as u64 + 1).read_until(b'\n', &mut line) {
			Ok(0) => return,
			Ok(_) => {}
			Err(e) => return eprintln!("qorpera-folder: programs: {e}"),
		}
		let Some(text) = line.strip_suffix(b"\n") else {
			// Longer than LINE_MAX, or cut off: a change was made that this program cannot read.
			let shown = String::from_utf8_lossy(&line[..line.len().min(200)]).into_owned();
			return heard(Heard::Malformed(format!("{} bytes without an end of line: {shown}", line.len())));
		};
		let seq = match serde_json::from_slice::<Line>(text) {
			Ok(told) => {
				let (seq, at) = (told.seq, told.at);
				match told.change() {
					Some(change) if now().saturating_sub(at) > WAIT.as_nanos() as u64 => heard(Heard::Late(change)),
					Some(change) => heard(Heard::Change(change)),
					None => heard(Heard::Malformed(shown(text))),
				}
				Some(seq)
			}
			Err(_) => {
				heard(Heard::Malformed(shown(text)));
				serde_json::from_slice::<serde_json::Value>(text).ok().and_then(|v| v.get("seq")?.as_u64())
			}
		};
		let Some(seq) = seq else { return };
		let ack = serde_json::to_string(&Ack { seq }).expect("serializes") + "\n";
		if let Err(e) = out.write_all(ack.as_bytes()) {
			return eprintln!("qorpera-folder: programs: {e}");
		}
	}
}

fn shown(text: &[u8]) -> String {
	String::from_utf8_lossy(&text[..text.len().min(200)]).into_owned()
}

/// The programs folder: made here, or one already there that is a folder only this account can use.
fn folder(dir: &Path) -> io::Result<()> {
	match fs::DirBuilder::new().mode(0o700).create(dir) {
		Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
			let meta = fs::symlink_metadata(dir)?;
			// SAFETY: geteuid has no preconditions.
			let me = unsafe { libc::geteuid() };
			if meta.is_dir() && meta.uid() == me && meta.mode() & 0o077 == 0 {
				Ok(())
			} else {
				Err(io::Error::other(format!("{}: not a folder only this account can use", dir.display())))
			}
		}
		made => made,
	}
}

fn random() -> io::Result<u32> {
	let mut bytes = [0u8; 4];
	fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
	Ok(u32::from_ne_bytes(bytes))
}
/// Tells the other programs listening in the programs folder. Its connections stay open for the next change, one per
/// request at a time, and a change told `later` goes from a thread of its own.
pub struct Teller {
	dir: PathBuf,
	own: String,
	wait: Duration,
	seq: AtomicU64,
	idle: Mutex<HashMap<String, Vec<BufReader<UnixStream>>>>,
	later: Mutex<mpsc::Sender<Vec<Change>>>,
}

/// One program being told one window of changes.
struct Telling {
	name: String,
	stream: BufReader<UnixStream>,
}

impl Teller {
	/// `own` is this program's own listener, which it never tells.
	pub fn new(dir: &Path, own: &str) -> io::Result<Arc<Teller>> {
		Teller::waiting(dir, own, WAIT)
	}

	fn waiting(dir: &Path, own: &str, wait: Duration) -> io::Result<Arc<Teller>> {
		let (later, queue) = mpsc::channel::<Vec<Change>>();
		let teller = Arc::new(Teller {
			dir: dir.to_path_buf(),
			own: own.to_string(),
			wait,
			seq: AtomicU64::new(1),
			idle: Mutex::new(HashMap::new()),
			later: Mutex::new(later),
		});
		let told = teller.clone();
		std::thread::Builder::new().name("peers-later".into()).spawn(move || {
			for changes in queue {
				// Logged by `tell`; nobody waits for it.
				let _ = told.tell(&changes);
			}
		})?;
		Ok(teller)
	}

	/// Tells every other listening program `changes`, and returns once each answered for all of them, so each has
	/// forgotten them on its mount. A program that does not answer within the wait, or breaks off while it still
	/// listens, fails the call (logged), and the caller fails its request.
	pub fn tell(&self, changes: &[Change]) -> io::Result<()> {
		if changes.is_empty() {
			return Ok(());
		}
		let mut programs = self.programs()?;
		// A program that removed its socket and ended is never listed again: its kept connections go now.
		self.idle.lock().unwrap().retain(|name, _| programs.contains(name));
		let mut failed = None;
		let mut fail = |name: &str, e: io::Error| {
			eprintln!("qorpera-folder: program {name} in {}: {e}", self.dir.display());
			failed = Some(e);
		};
		for window in changes.chunks(WINDOW) {
			let deadline = Instant::now() + self.wait;
			let first = self.seq.fetch_add(window.len() as u64, Ordering::Relaxed);
			let at = now();
			let mut text = String::new();
			for (i, change) in window.iter().enumerate() {
				text += &serde_json::to_string(&Line::new(first + i as u64, at, change)).expect("serializes");
				text.push('\n');
			}
			let mut sent = Vec::new();
			for name in std::mem::take(&mut programs) {
				match self.send(&name, text.as_bytes(), deadline) {
					Ok(Some(stream)) => sent.push(Telling { name, stream }),
					Ok(None) => {}
					Err(e) => fail(&name, e),
				}
			}
			for mut told in sent {
				match answers(&mut told.stream, first, window.len(), deadline) {
					Ok(()) => {
						self.idle.lock().unwrap().entry(told.name.clone()).or_default().push(told.stream);
						programs.push(told.name);
					}
					// A program that ended meanwhile has no mount left to be stale.
					Err(_) if self.gone(&told.name) => {}
					Err(e) => fail(&told.name, e),
				}
			}
		}
		match failed {
			None => Ok(()),
			Some(e) => Err(e),
		}
	}

	/// Tells `changes` from the teller's own thread, for a change made behind the kernels' backs that no request waits
	/// on.
	pub fn later(&self, changes: Vec<Change>) {
		if !changes.is_empty() {
			let _ = self.later.lock().unwrap().send(changes);
		}
	}

	/// The listening programs other than this one. A dot-name is not listening yet.
	fn programs(&self) -> io::Result<Vec<String>> {
		let mut names = Vec::new();
		for entry in fs::read_dir(&self.dir)? {
			let name = entry?.file_name().to_string_lossy().into_owned();
			if !name.starts_with('.') && name != self.own {
				names.push(name);
			}
		}
		Ok(names)
	}

	/// Writes `text` to `name` over a kept connection, or a new one if that fails. `None`: the program is gone.
	fn send(&self, name: &str, text: &[u8], deadline: Instant) -> io::Result<Option<BufReader<UnixStream>>> {
		let kept = self.idle.lock().unwrap().get_mut(name).and_then(Vec::pop);
		if let Some(mut stream) = kept {
			if write(stream.get_mut(), text, deadline).is_ok() {
				return Ok(Some(stream));
			}
		}
		let path = self.dir.join(name);
		let mut stream = match connect(&path, self.wait) {
			Ok(s) => BufReader::new(s),
			Err(e) if e.raw_os_error() == Some(libc::ECONNREFUSED) => {
				let _ = fs::remove_file(&path);
				return Ok(None);
			}
			Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
			Err(e) => return Err(e),
		};
		write(stream.get_mut(), text, deadline)?;
		Ok(Some(stream))
	}

	/// Whether `name`'s program has ended: its socket refuses, or is removed. Its kept connections go.
	fn gone(&self, name: &str) -> bool {
		let path = self.dir.join(name);
		let gone = match connect(&path, self.wait) {
			Ok(_) => false,
			Err(e) if e.raw_os_error() == Some(libc::ECONNREFUSED) => {
				let _ = fs::remove_file(&path);
				true
			}
			Err(e) => e.kind() == io::ErrorKind::NotFound,
		};
		if gone {
			self.idle.lock().unwrap().remove(name);
		}
		gone
	}
}

fn write(stream: &mut UnixStream, text: &[u8], deadline: Instant) -> io::Result<()> {
	stream.set_write_timeout(Some(left(deadline)?))?;
	stream.write_all(text).map_err(timed)
}

/// Reads the answers to `count` lines from `first` on, in order.
fn answers(stream: &mut BufReader<UnixStream>, first: u64, count: usize, deadline: Instant) -> io::Result<()> {
	let mut line = String::new();
	for i in 0..count as u64 {
		stream.get_ref().set_read_timeout(Some(left(deadline)?))?;
		line.clear();
		if stream.by_ref().take(64).read_line(&mut line).map_err(timed)? == 0 {
			return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "closed before its answer"));
		}
		match serde_json::from_str::<Ack>(line.trim_end()) {
			Ok(Ack { seq }) if seq == first + i => {}
			_ => return Err(io::Error::new(io::ErrorKind::InvalidData, format!("answered {:?}", line.trim_end()))),
		}
	}
	Ok(())
}

fn left(deadline: Instant) -> io::Result<Duration> {
	match deadline.checked_duration_since(Instant::now()) {
		Some(left) if !left.is_zero() => Ok(left),
		_ => Err(io::Error::new(io::ErrorKind::TimedOut, "no answer in time")),
	}
}

/// A socket time-out reads as EAGAIN.
fn timed(e: io::Error) -> io::Error {
	if e.kind() == io::ErrorKind::WouldBlock {
		io::Error::new(io::ErrorKind::TimedOut, "no answer in time")
	} else {
		e
	}
}

/// Connects with `wait` as the send time-out, which also bounds a connect to a listener whose queue is full.
fn connect(path: &Path, wait: Duration) -> io::Result<UnixStream> {
	// SAFETY: socket() has no preconditions; it returns a new descriptor or -1.
	let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
	if fd < 0 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: `fd` is a new socket nothing else owns.
	let stream = unsafe { UnixStream::from_raw_fd(fd) };
	stream.set_write_timeout(Some(wait))?;
	// SAFETY: an all-zero sockaddr_un is valid.
	let mut addr: libc::sockaddr_un = unsafe { std::mem::zeroed() };
	addr.sun_family = libc::AF_UNIX as libc::sa_family_t;
	let bytes = path.as_os_str().as_bytes();
	if bytes.len() >= addr.sun_path.len() {
		return Err(io::Error::from_raw_os_error(libc::ENAMETOOLONG));
	}
	for (to, from) in addr.sun_path.iter_mut().zip(bytes) {
		*to = *from as libc::c_char;
	}
	let len = std::mem::size_of::<libc::sa_family_t>() + bytes.len() + 1;
	// SAFETY: `addr` is a valid sockaddr_un, of which the first `len` bytes hold the family and the NUL-ended path.
	let done = unsafe { libc::connect(fd, &addr as *const libc::sockaddr_un as *const libc::sockaddr, len as libc::socklen_t) };
	if done < 0 {
		return Err(io::Error::last_os_error());
	}
	Ok(stream)
}
#[cfg(test)]
mod tests {
	use super::*;

	fn programs() -> PathBuf {
		static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
		let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
		let caches = std::env::temp_dir().join(format!("qorpera-folder-peers-{}-{n}", std::process::id()));
		fs::create_dir_all(&caches).unwrap();
		caches.join("programs")
	}

	fn listening(dir: &Path) -> (Listener, Arc<Mutex<Vec<Heard>>>) {
		let heard = Arc::new(Mutex::new(Vec::new()));
		let into = heard.clone();
		let listener = listen(dir, move |h| into.lock().unwrap().push(h)).unwrap();
		(listener, heard)
	}

	fn raw(dir: &Path, name: &str) -> BufReader<UnixStream> {
		BufReader::new(UnixStream::connect(dir.join(name)).unwrap())
	}

	/// Writes `line` and reads its answer ("" when the listener closed the connection).
	fn say(stream: &mut BufReader<UnixStream>, line: &str) -> String {
		stream.get_mut().write_all(format!("{line}\n").as_bytes()).unwrap();
		let mut answer = String::new();
		stream.read_line(&mut answer).unwrap();
		answer
	}

	const A: u64 = LOCAL | 7;
	const B: u64 = LOCAL | 8;

	#[test]
	fn every_other_program_forgets_a_change_before_the_teller_returns() {
		let dir = programs();
		let (b, heard_b) = listening(&dir);
		let (_c, heard_c) = listening(&dir);
		let a = Teller::new(&dir, "a").unwrap();
		let changes = vec![
			Change::ino(A),
			Change::name(Parent::Local(A), "x.js"),
			Change { ino: Some(B), name: Some((Parent::Dir("code/o/r/wt".into()), "node_modules".into())) },
		];
		a.tell(&changes).unwrap();
		let told: Vec<Heard> = changes.iter().cloned().map(Heard::Change).collect();
		assert_eq!(*heard_b.lock().unwrap(), told);
		assert_eq!(*heard_c.lock().unwrap(), told);

		// Again over the kept connections, and more than one window in order.
		let many: Vec<Change> = (0..600).map(|i| Change::ino(LOCAL | i)).collect();
		a.tell(&many).unwrap();
		assert_eq!(heard_b.lock().unwrap()[3..], many.iter().cloned().map(Heard::Change).collect::<Vec<_>>()[..]);
		assert_eq!(a.idle.lock().unwrap().values().map(Vec::len).sum::<usize>(), 2);

		// A program never tells itself.
		let own = Teller::new(&dir, b.name()).unwrap();
		own.tell(&changes[..1]).unwrap();
		assert_eq!(heard_b.lock().unwrap().len(), 603);
		assert_eq!(heard_c.lock().unwrap().len(), 604);

		// A removed listener is told nothing, and its kept connection does not fail the teller.
		b.remove();
		a.tell(&changes[..1]).unwrap();
		assert_eq!(heard_b.lock().unwrap().len(), 603);
		assert_eq!(heard_c.lock().unwrap().len(), 605);
		// Nor does it keep its connection open.
		let idle = a.idle.lock().unwrap();
		assert!(!idle.contains_key(b.name()));
		assert_eq!(idle.values().map(Vec::len).sum::<usize>(), 1);
	}

	#[test]
	fn a_dead_programs_socket_is_removed_and_a_dot_name_is_skipped() {
		let dir = programs();
		let (_b, heard) = listening(&dir);
		drop(UnixListener::bind(dir.join("1.deadbeef")).unwrap());
		UnixListener::bind(dir.join(".2.0badf00d")).unwrap();
		let a = Teller::new(&dir, "a").unwrap();
		a.later(vec![Change::ino(A)]);
		a.tell(&[Change::ino(B)]).unwrap();
		assert!(!dir.join("1.deadbeef").exists());
		assert!(dir.join(".2.0badf00d").exists());
		let deadline = Instant::now() + Duration::from_secs(5);
		while heard.lock().unwrap().len() < 2 && Instant::now() < deadline {
			std::thread::sleep(Duration::from_millis(10));
		}
		let mut heard = std::mem::take(&mut *heard.lock().unwrap());
		heard.sort_by_key(|h| match h {
			Heard::Change(c) => c.ino,
			_ => None,
		});
		assert_eq!(heard, vec![Heard::Change(Change::ino(A)), Heard::Change(Change::ino(B))]);
	}

	#[test]
	fn a_program_that_does_not_answer_fails_the_teller_in_time() {
		let dir = programs();
		fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
		// Bound and listening, never accepting: a stopped program.
		let _stopped = UnixListener::bind(dir.join("3.5709bed0")).unwrap();
		let a = Teller::waiting(&dir, "a", Duration::from_millis(300)).unwrap();
		let started = Instant::now();
		let e = a.tell(&[Change::ino(A)]).unwrap_err();
		assert_eq!(e.kind(), io::ErrorKind::TimedOut);
		assert!(started.elapsed() < Duration::from_secs(5));
		assert!(dir.join("3.5709bed0").exists());
	}

	#[test]
	fn a_late_change_and_lines_that_are_no_change() {
		let dir = programs();
		let (b, heard) = listening(&dir);
		let mut s = raw(&dir, b.name());
		let late = now().saturating_sub(11_000_000_000);
		assert_eq!(say(&mut s, &format!(r#"{{"seq":4,"at":{late},"ino":{A}}}"#)), "{\"seq\":4}\n");
		let at = now();
		for (seq, line) in [
			(5, format!(r#"{{"seq":5,"at":{at},"ino":1}}"#)),
			(6, format!(r#"{{"seq":6,"at":{at},"ino":{A},"more":1}}"#)),
			(7, format!(r#"{{"seq":7,"at":{at},"name":"a/b","up":{A}}}"#)),
			(8, format!(r#"{{"seq":8,"at":{at},"name":"x","up":{A},"dir":"d"}}"#)),
			(9, format!(r#"{{"seq":9,"at":{at},"name":"x"}}"#)),
			(10, format!(r#"{{"seq":10,"at":{at}}}"#)),
			(11, format!(r#"{{"seq":11,"at":{at},"name":"x","dir":"../d"}}"#)),
		] {
			assert_eq!(say(&mut s, &line), format!("{{\"seq\":{seq}}}\n"), "{line}");
		}
		assert_eq!(say(&mut s, "not json"), "");
		let mut long = raw(&dir, b.name());
		long.get_mut().write_all(&vec![b'a'; LINE_MAX + 1]).unwrap();
		let mut end = String::new();
		assert_eq!(long.read_line(&mut end).unwrap(), 0);

		let heard = heard.lock().unwrap();
		assert_eq!(heard[0], Heard::Late(Change::ino(A)));
		assert_eq!(heard.len(), 10);
		assert!(heard[1..].iter().all(|h| matches!(h, Heard::Malformed(_))), "{heard:?}");
	}
}
