//! The machine's side of the folder link: a pool of request connections and the feed connection.
//! Each connection opens with the view's id and pass; the node checks them and the calling machine.

use crate::frame::{kind, read_frame, write_frame};
use crate::proto::{
	code, Ack, Change, ChunkHeader, CloseRequest, Entry, ErrorReply, ExecutableRequest, GetChunk, Hello, HelloOk,
	ListRequest, Listing, OpenRequest, Opened, PathRequest, ReadRequest, RemoveRequest, RenameRequest, Report, Role, Saved,
	MAX_READ, PART, PROTOCOL,
};
use crate::transport::{connect, Stream};
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

/// How long a request may wait for its answer. A cold read of a 4 MiB piece from the storage server
/// takes well under a second (measured 28 September); this only catches a link that died silently.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// The node sends a heartbeat on the feed every 15 seconds; three missed ones mean the link is gone.
pub const FEED_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug)]
pub enum Fail {
	/// The node answered with an error.
	Remote(ErrorReply),
	/// The link broke or the answer made no sense.
	Link(io::Error),
}

impl Fail {
	pub fn errno(&self) -> i32 {
		match self {
			Fail::Remote(e) => e.errno(),
			Fail::Link(_) => libc::EIO,
		}
	}
	pub fn view_closed(&self) -> bool {
		matches!(self, Fail::Remote(e) if e.code == code::VIEW_CLOSED || e.code == code::VIEW_REFUSED)
	}
}

impl std::fmt::Display for Fail {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Fail::Remote(e) => write!(f, "{}: {}", e.code, e.message),
			Fail::Link(e) => write!(f, "link: {e}"),
		}
	}
}

pub struct View {
	pub environment_id: String,
	pub view_id: String,
	pub pass: String,
}

impl std::fmt::Debug for View {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		// Never print the pass.
		f.debug_struct("View")
			.field("environment_id", &self.environment_id)
			.field("view_id", &self.view_id)
			.finish_non_exhaustive()
	}
}

pub struct Link {
	addr: String,
	view: View,
	free: Mutex<Vec<Stream>>,
	ready: Condvar,
	open: Mutex<usize>,
	max: usize,
	/// Set once the node says the view is closed; every later call fails at once.
	closed: AtomicBool,
	/// Called once when the view closes, so the mount can end instead of failing every call.
	on_closed: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl Link {
	pub fn new(addr: String, view: View, max: usize) -> Link {
		Link {
			addr,
			view,
			free: Mutex::new(Vec::new()),
			ready: Condvar::new(),
			open: Mutex::new(0),
			max: max.max(1),
			closed: AtomicBool::new(false),
			on_closed: Mutex::new(None),
		}
	}

	/// `f` runs once, on whichever thread first learns that the view closed.
	pub fn when_closed(&self, f: impl FnOnce() + Send + 'static) {
		*self.on_closed.lock().unwrap() = Some(Box::new(f));
		if self.closed() {
			self.fire_closed();
		}
	}

	fn fire_closed(&self) {
		let f = self.on_closed.lock().unwrap().take();
		if let Some(f) = f {
			f();
		}
	}

	pub fn closed(&self) -> bool {
		self.closed.load(Ordering::SeqCst)
	}

	fn hello(&self, role: Role, timeout: Duration) -> Result<(Stream, HelloOk), Fail> {
		let mut s = connect(&self.addr).map_err(Fail::Link)?;
		s.set_timeouts(Some(timeout), Some(REQUEST_TIMEOUT)).map_err(Fail::Link)?;
		let hello = Hello {
			protocol: PROTOCOL,
			environment_id: self.view.environment_id.clone(),
			view_id: self.view.view_id.clone(),
			pass: self.view.pass.clone(),
			role,
		};
		let ok: HelloOk = exchange(&mut s, kind::HELLO, &json(&hello), kind::HELLO_OK).and_then(|b| parse(&b))?;
		if ok.protocol != PROTOCOL || ok.view_id != self.view.view_id {
			return Err(Fail::Link(io::Error::other("the node answered for another view or protocol")));
		}
		Ok((s, ok))
	}

	/// Opens the feed: the node's answer to the hello, then a stream of changes.
	pub fn open_feed(&self) -> Result<(Feed, HelloOk), Fail> {
		match self.hello(Role::Feed, FEED_TIMEOUT) {
			Ok((stream, ok)) => Ok((Feed { stream }, ok)),
			Err(f) => {
				self.note(&f);
				Err(f)
			}
		}
	}

	/// All entries of a folder, page by page.
	pub fn list(&self, path: &str) -> Result<Vec<Entry>, Fail> {
		let mut out = Vec::new();
		let mut after = None;
		loop {
			let req = ListRequest { path: path.to_string(), after: after.take() };
			let page: Listing = self.call(kind::LIST, &json(&req), kind::LISTING).and_then(|b| parse(&b))?;
			out.extend(page.entries);
			match page.next {
				Some(next) => after = Some(next),
				None => return Ok(out),
			}
		}
	}

	pub fn read(&self, path: &str, version: &str, offset: u64, length: u32) -> Result<Vec<u8>, Fail> {
		let req = ReadRequest { path: path.to_string(), version: version.to_string(), offset, length: length.min(MAX_READ) };
		let data = self.call(kind::READ, &json(&req), kind::DATA)?;
		if data.len() > req.length as usize {
			return Err(Fail::Link(io::Error::other("the node sent more than was asked for")));
		}
		Ok(data)
	}

	/// One request on a pooled connection. A connection that breaks is dropped and the request is sent
	/// once more on a fresh one (lists and reads change nothing, so a repeat is safe).
	fn call(&self, request: u8, payload: &[u8], answer: u8) -> Result<Vec<u8>, Fail> {
		let mut attempt = 0;
		loop {
			attempt += 1;
			let mut s = match self.take() {
				Ok(s) => s,
				Err(Fail::Link(_)) if attempt == 1 => continue,
				Err(f) => return Err(f),
			};
			match exchange(&mut s, request, payload, answer) {
				Ok(data) => {
					self.give(s);
					return Ok(data);
				}
				Err(f @ Fail::Remote(_)) => {
					self.answered(s, &f);
					return Err(f);
				}
				Err(Fail::Link(e)) => {
					self.lost();
					// Pooled connections broke together (the node's service restarted): the next try opens a new one.
					self.drop_idle();
					if attempt > 1 {
						return Err(Fail::Link(e));
					}
				}
			}
		}
	}

	// ---- Writes (protocol 2) --------------------------------------------------------------------------------------

	/// One change on a pooled connection. Unlike a list or a read it is not sent again once it went out and the link
	/// broke before the answer: the node may have made it, so the program sees EIO. A connection that could not be made,
	/// or that would not take the request (a pooled one the node closed, when its service restarted), never delivered
	/// it: every idle pooled connection is let go with it, and the change goes out once more on a new connection.
	fn change(&self, request: u8, payload: &[u8], answer: u8) -> Result<Vec<u8>, Fail> {
		let mut attempt = 0;
		loop {
			attempt += 1;
			let mut s = match self.take() {
				Ok(s) => s,
				Err(Fail::Link(_)) if attempt == 1 => continue,
				Err(f) => return Err(f),
			};
			if let Err(e) = write_frame(&mut s, request, payload) {
				self.lost();
				self.drop_idle();
				if attempt == 1 {
					continue;
				}
				return Err(Fail::Link(e));
			}
			return match read_answer(&mut s, answer) {
				Ok(data) => {
					self.give(s);
					Ok(data)
				}
				Err(f @ Fail::Remote(_)) => {
					self.answered(s, &f);
					Err(f)
				}
				Err(Fail::Link(e)) => {
					self.lost();
					Err(Fail::Link(e))
				}
			};
		}
	}

	/// Every idle pooled connection, ended: one the node closed means its service went, and took the others with it.
	fn drop_idle(&self) {
		let idle = std::mem::take(&mut *self.free.lock().unwrap());
		for s in idle {
			s.shutdown();
			self.lost();
		}
	}

	/// A connection the node answered with an error: back to the pool, unless the error says the node may have ended it
	/// (it ends a connection after a failure of its own, which it answers as UNAVAILABLE).
	fn answered(&self, s: Stream, f: &Fail) {
		match f {
			Fail::Remote(e) if e.code == code::UNAVAILABLE => {
				s.shutdown();
				self.lost();
			}
			_ => self.give(s),
		}
		self.note(f);
	}

	pub fn open_write(&self, request: &OpenRequest) -> Result<Opened, Fail> {
		self.change(kind::OPEN, &json(request), kind::OPENED).and_then(|b| parse(&b))
	}

	/// One chunk of an open file, hashed and sent in parts. The node starts a chunk over at a part from offset 0, so a
	/// chunk whose sending broke off is sent again whole, once.
	pub fn put_chunk(&self, handle: u32, index: u32, data: &[u8]) -> Result<(), Fail> {
		let sha256 = hex(&Sha256::digest(data));
		let mut attempt = 0;
		'whole: loop {
			attempt += 1;
			let mut offset = 0;
			while offset < data.len() {
				let end = (offset + PART).min(data.len());
				let header = json(&ChunkHeader {
					handle,
					index,
					sha256: sha256.clone(),
					bytes: data.len() as u64,
					offset: offset as u64,
				});
				let mut payload = Vec::with_capacity(4 + header.len() + end - offset);
				payload.extend_from_slice(&(header.len() as u32).to_be_bytes());
				payload.extend_from_slice(&header);
				payload.extend_from_slice(&data[offset..end]);
				match self.change(kind::CHUNK, &payload, kind::DONE) {
					Ok(_) => offset = end,
					Err(Fail::Link(_)) if attempt == 1 => continue 'whole,
					Err(f) => return Err(f),
				}
			}
			return Ok(());
		}
	}

	/// Part of a chunk the open file has, back from the node (at most 1 MiB). Changes nothing, so it is asked again
	/// when the link breaks.
	pub fn get_chunk(&self, handle: u32, index: u32, offset: u64, length: u32) -> Result<Vec<u8>, Fail> {
		let request = GetChunk { handle, index, offset, length: length.min(MAX_READ) };
		let data = self.call(kind::GET_CHUNK, &json(&request), kind::DATA)?;
		if data.len() > request.length as usize {
			return Err(Fail::Link(io::Error::other("the node sent more than was asked for")));
		}
		Ok(data)
	}

	/// Closes the open file at `size`; the answer is the version the save made.
	pub fn close_write(&self, handle: u32, size: u64) -> Result<String, Fail> {
		let saved: Saved = self.change(kind::CLOSE, &json(&CloseRequest { handle, size }), kind::DONE).and_then(|b| parse(&b))?;
		Ok(saved.version)
	}

	pub fn mkdir(&self, path: &str) -> Result<(), Fail> {
		self.change(kind::MKDIR, &json(&PathRequest { path: path.to_string() }), kind::DONE).map(drop)
	}

	pub fn unlink(&self, path: &str, base: Option<String>) -> Result<(), Fail> {
		self.change(kind::UNLINK, &json(&RemoveRequest { path: path.to_string(), base }), kind::DONE).map(drop)
	}

	pub fn rmdir(&self, path: &str, base: Option<String>) -> Result<(), Fail> {
		self.change(kind::RMDIR, &json(&RemoveRequest { path: path.to_string(), base }), kind::DONE).map(drop)
	}

	pub fn rename(&self, request: &RenameRequest) -> Result<(), Fail> {
		self.change(kind::RENAME, &json(request), kind::DONE).map(drop)
	}

	/// Sets or clears the executable bit; the answer is the version the change made.
	pub fn set_executable(&self, path: &str, base: Option<String>, executable: bool) -> Result<String, Fail> {
		let request = ExecutableRequest { path: path.to_string(), base, executable };
		let saved: Saved = self.change(kind::EXECUTABLE, &json(&request), kind::DONE).and_then(|b| parse(&b))?;
		Ok(saved.version)
	}

	/// Publishes what the mount has pending; the answer is the boundary's report. Sent once, on a connection of its own
	/// that waits as long as the boundary takes (staging, the commit, the feed): the node answers, or its service goes
	/// and the connection with it. When the link breaks after the request went out, the boundary may have run, and its
	/// report is lost: a second one would publish only what is still pending, and leave the first one's conflicts out.
	pub fn publish(&self) -> Result<Report, Fail> {
		let (mut s, _) = self.hello(Role::Io, REQUEST_TIMEOUT).inspect_err(|f| self.note(f))?;
		let answer = s.set_timeouts(None, Some(REQUEST_TIMEOUT)).map_err(Fail::Link).and_then(|()| {
			write_frame(&mut s, kind::PUBLISH, b"{}").map_err(Fail::Link)?;
			read_answer(&mut s, kind::REPORT).map_err(|f| match f {
				Fail::Link(e) => Fail::Link(io::Error::new(
					e.kind(),
					format!("the request went out but no answer came ({e}), so whether the boundary ran is unknown"),
				)),
				f => f,
			})
		});
		s.shutdown();
		if let Err(f) = &answer {
			self.note(f);
		}
		answer.and_then(|b| parse(&b))
	}

	fn note(&self, f: &Fail) {
		if f.view_closed() {
			self.closed.store(true, Ordering::SeqCst);
			{
				let _free = self.free.lock().unwrap();
				self.ready.notify_all();
			}
			self.fire_closed();
		}
	}

	/// A free connection, or a new one while fewer than `max` are open, or a wait for one.
	fn take(&self) -> Result<Stream, Fail> {
		let mut free = self.free.lock().unwrap();
		loop {
			if self.closed() {
				return Err(Fail::Remote(ErrorReply { code: code::VIEW_CLOSED.into(), message: "the view is closed".into() }));
			}
			if let Some(s) = free.pop() {
				return Ok(s);
			}
			{
				let mut open = self.open.lock().unwrap();
				if *open < self.max {
					*open += 1;
					drop(open);
					drop(free);
					return self.hello(Role::Io, REQUEST_TIMEOUT).map(|(s, _)| s).inspect_err(|f| {
						self.lost();
						self.note(f);
					});
				}
			}
			free = self.ready.wait(free).unwrap();
		}
	}

	fn give(&self, s: Stream) {
		self.free.lock().unwrap().push(s);
		self.ready.notify_one();
	}

	fn lost(&self) {
		let _free = self.free.lock().unwrap();
		let mut open = self.open.lock().unwrap();
		*open = open.saturating_sub(1);
		self.ready.notify_one();
	}
}

pub struct Feed {
	stream: Stream,
}

impl Feed {
	/// The next change; a heartbeat is a change with no paths. Errors when the link breaks or no
	/// frame came within `FEED_TIMEOUT`.
	pub fn next(&mut self) -> Result<Change, Fail> {
		let (k, payload) = read_frame(&mut self.stream).map_err(Fail::Link)?;
		match k {
			kind::CHANGE => parse(&payload),
			kind::ERROR => Err(Fail::Remote(parse(&payload)?)),
			other => Err(Fail::Link(io::Error::other(format!("unexpected frame {other} on the feed")))),
		}
	}

	pub fn ack(&mut self, seq: u64) -> Result<(), Fail> {
		write_frame(&mut self.stream, kind::ACK, &json(&Ack { seq })).map_err(Fail::Link)
	}

	pub fn close(&self) {
		self.stream.shutdown();
	}
}

fn exchange(s: &mut Stream, request: u8, payload: &[u8], answer: u8) -> Result<Vec<u8>, Fail> {
	write_frame(s, request, payload).map_err(Fail::Link)?;
	read_answer(s, answer)
}

fn read_answer(s: &mut Stream, answer: u8) -> Result<Vec<u8>, Fail> {
	let (k, body) = read_frame(s).map_err(Fail::Link)?;
	if k == answer {
		Ok(body)
	} else if k == kind::ERROR {
		Err(Fail::Remote(parse(&body)?))
	} else {
		Err(Fail::Link(io::Error::other(format!("unexpected frame {k}"))))
	}
}

fn json(v: &impl serde::Serialize) -> Vec<u8> {
	serde_json::to_vec(v).expect("protocol messages always serialize")
}

fn parse<T: DeserializeOwned>(b: &[u8]) -> Result<T, Fail> {
	serde_json::from_slice(b).map_err(|e| Fail::Link(io::Error::new(io::ErrorKind::InvalidData, e)))
}

fn hex(bytes: &[u8]) -> String {
	bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl crate::writer::Chunks for Link {
	fn put(&self, handle: u32, index: u32, data: &[u8]) -> Result<(), Fail> {
		self.put_chunk(handle, index, data)
	}
	fn get(&self, handle: u32, index: u32, offset: u64, length: u64) -> Result<Vec<u8>, Fail> {
		self.get_chunk(handle, index, offset, length.min(MAX_READ as u64) as u32)
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::frame::{read_frame, write_frame};
	use crate::proto::{Entry, EntryKind};
	use std::os::unix::net::UnixListener;
	use std::sync::atomic::AtomicUsize;
	use std::sync::Arc;

	fn entry(name: &str) -> Entry {
		Entry { name: name.into(), kind: EntryKind::File, size: 3, mtime_ms: 0, executable: false, version: "v1".into() }
	}

	/// A node stand-in on a Unix socket: checks the hello, pages a listing two entries at a time, serves
	/// reads of "a" at version v1, and drops every connection after `drop_after` requests.
	fn fake_node(dir: &std::path::Path, drop_after: usize, hellos: Arc<AtomicUsize>) -> String {
		let path = dir.join("node.sock");
		let listener = UnixListener::bind(&path).unwrap();
		std::thread::spawn(move || {
			for conn in listener.incoming() {
				let mut s = conn.unwrap();
				let hellos = hellos.clone();
				std::thread::spawn(move || {
					let (k, body) = read_frame(&mut s).unwrap();
					assert_eq!(k, kind::HELLO);
					let hello: Hello = serde_json::from_slice(&body).unwrap();
					hellos.fetch_add(1, Ordering::SeqCst);
					if hello.pass != "right" {
						let e = ErrorReply { code: code::VIEW_REFUSED.into(), message: "no".into() };
						write_frame(&mut s, kind::ERROR, &serde_json::to_vec(&e).unwrap()).unwrap();
						return;
					}
					let ok = HelloOk { protocol: PROTOCOL, view_id: hello.view_id, as_of_seq: 7, read_only: true };
					write_frame(&mut s, kind::HELLO_OK, &serde_json::to_vec(&ok).unwrap()).unwrap();
					for _ in 0..drop_after {
						let Ok((k, body)) = read_frame(&mut s) else { return };
						match k {
							kind::LIST => {
								let req: ListRequest = serde_json::from_slice(&body).unwrap();
								let names = ["a", "b", "c", "d", "e"];
								let start = req.after.map_or(0, |a| names.iter().position(|n| *n == a).unwrap() + 1);
								let page: Vec<Entry> = names[start..].iter().take(2).map(|n| entry(n)).collect();
								let next = (start + 2 < names.len()).then(|| page.last().unwrap().name.clone());
								let listing = Listing { entries: page, next };
								write_frame(&mut s, kind::LISTING, &serde_json::to_vec(&listing).unwrap()).unwrap();
							}
							kind::READ => {
								let req: ReadRequest = serde_json::from_slice(&body).unwrap();
								if req.path == "a" && req.version == "v1" {
									let data = &b"abc"[req.offset as usize..];
									write_frame(&mut s, kind::DATA, &data[..data.len().min(req.length as usize)]).unwrap();
								} else {
									let e = ErrorReply { code: code::STALE.into(), message: String::new() };
									write_frame(&mut s, kind::ERROR, &serde_json::to_vec(&e).unwrap()).unwrap();
								}
							}
							_ => panic!("unexpected frame {k}"),
						}
					}
				});
			}
		});
		format!("unix:{}", path.display())
	}

	fn tempdir() -> std::path::PathBuf {
		let dir = std::env::temp_dir().join(format!("qorpera-folder-test-{}-{}", std::process::id(), rand_suffix()));
		std::fs::create_dir(&dir).unwrap();
		dir
	}

	fn rand_suffix() -> u64 {
		static N: AtomicUsize = AtomicUsize::new(0);
		N.fetch_add(1, Ordering::SeqCst) as u64 * 1_000_003 + std::time::UNIX_EPOCH.elapsed().unwrap().subsec_nanos() as u64
	}

	fn view(pass: &str) -> View {
		View { environment_id: "env-1".into(), view_id: "view-1".into(), pass: pass.into() }
	}

	#[test]
	fn lists_every_page_and_reads() {
		let dir = tempdir();
		let addr = fake_node(&dir, 100, Arc::new(AtomicUsize::new(0)));
		let link = Link::new(addr, view("right"), 4);
		let names: Vec<String> = link.list("").unwrap().into_iter().map(|e| e.name).collect();
		assert_eq!(names, ["a", "b", "c", "d", "e"]);
		assert_eq!(link.read("a", "v1", 1, 10).unwrap(), b"bc");
		match link.read("a", "v2", 0, 3) {
			Err(Fail::Remote(e)) => assert_eq!(e.errno(), libc::ESTALE),
			other => panic!("{other:?}"),
		}
		assert!(!link.closed());
		std::fs::remove_dir_all(dir).unwrap();
	}

	#[test]
	fn a_broken_connection_is_replaced_once() {
		let dir = tempdir();
		let hellos = Arc::new(AtomicUsize::new(0));
		// Every connection answers one request, then closes.
		let addr = fake_node(&dir, 1, hellos.clone());
		let link = Link::new(addr, view("right"), 1);
		assert_eq!(link.read("a", "v1", 0, 3).unwrap(), b"abc");
		// The pooled connection is closed now: the next request goes out again on a new one.
		assert_eq!(link.read("a", "v1", 0, 3).unwrap(), b"abc");
		assert_eq!(hellos.load(Ordering::SeqCst), 2);
		std::fs::remove_dir_all(dir).unwrap();
	}

	#[test]
	fn a_refused_view_closes_the_link() {
		let dir = tempdir();
		let addr = fake_node(&dir, 100, Arc::new(AtomicUsize::new(0)));
		let link = Link::new(addr, view("wrong"), 2);
		let told = Arc::new(AtomicUsize::new(0));
		let counter = told.clone();
		link.when_closed(move || {
			counter.fetch_add(1, Ordering::SeqCst);
		});
		let err = link.list("").unwrap_err();
		assert!(err.view_closed(), "{err}");
		assert!(link.closed());
		assert_eq!(told.load(Ordering::SeqCst), 1, "the mount hears of it once");
		// Later calls fail at once, without connecting.
		assert!(link.read("a", "v1", 0, 1).unwrap_err().view_closed());
		assert_eq!(told.load(Ordering::SeqCst), 1);
		std::fs::remove_dir_all(dir).unwrap();
	}

	#[test]
	fn the_feed_reports_a_refused_view() {
		let dir = tempdir();
		let addr = fake_node(&dir, 100, Arc::new(AtomicUsize::new(0)));
		let link = Link::new(addr, view("wrong"), 2);
		match link.open_feed() {
			Err(f) => assert!(f.view_closed(), "{f}"),
			Ok(_) => panic!("a refused view opened a feed"),
		}
		std::fs::remove_dir_all(dir).unwrap();
	}

	#[test]
	fn the_pass_never_prints() {
		assert!(!format!("{:?}", view("secret-pass")).contains("secret-pass"));
	}

	type Stored = Arc<std::sync::Mutex<std::collections::HashMap<(u32, u32), Vec<u8>>>>;

	/// A node stand-in that takes writes: checks each chunk's parts come in order and add up to the hash the header
	/// names, keeps the chunk, and serves it back.
	fn fake_writer_node(dir: &std::path::Path) -> (String, Stored) {
		let path = dir.join("node.sock");
		let listener = UnixListener::bind(&path).unwrap();
		let stored: Stored = Arc::default();
		let chunks = stored.clone();
		std::thread::spawn(move || {
			let partial: Arc<std::sync::Mutex<Vec<u8>>> = Arc::default();
			for conn in listener.incoming() {
				let mut s = conn.unwrap();
				let (chunks, partial) = (chunks.clone(), partial.clone());
				std::thread::spawn(move || {
					let (_, body) = read_frame(&mut s).unwrap();
					let hello: Hello = serde_json::from_slice(&body).unwrap();
					assert_eq!(hello.protocol, 2);
					let ok = HelloOk { protocol: 2, view_id: hello.view_id, as_of_seq: 1, read_only: false };
					write_frame(&mut s, kind::HELLO_OK, &serde_json::to_vec(&ok).unwrap()).unwrap();
					let done = |s: &mut std::os::unix::net::UnixStream, body: &str| write_frame(s, kind::DONE, body.as_bytes()).unwrap();
					while let Ok((k, body)) = read_frame(&mut s) {
						match k {
							kind::OPEN => {
								let req: OpenRequest = serde_json::from_slice(&body).unwrap();
								assert_eq!(req.base.as_deref(), Some("v1"));
								let o = Opened { handle: 7, size: 0, version: "p0".into() };
								write_frame(&mut s, kind::OPENED, &serde_json::to_vec(&o).unwrap()).unwrap();
							}
							kind::CHUNK => {
								let len = u32::from_be_bytes(body[..4].try_into().unwrap()) as usize;
								let header: ChunkHeader = serde_json::from_slice(&body[4..4 + len]).unwrap();
								let data = &body[4 + len..];
								assert!(data.len() <= PART);
								let mut sofar = partial.lock().unwrap();
								if header.offset == 0 {
									sofar.clear();
								}
								assert_eq!(header.offset as usize, sofar.len(), "parts in order");
								sofar.extend_from_slice(data);
								if sofar.len() as u64 == header.bytes {
									assert_eq!(hex(&Sha256::digest(&sofar[..])), header.sha256);
									chunks.lock().unwrap().insert((header.handle, header.index), sofar.clone());
								}
								done(&mut s, "{}");
							}
							kind::GET_CHUNK => {
								let req: GetChunk = serde_json::from_slice(&body).unwrap();
								let chunks = chunks.lock().unwrap();
								let c = &chunks[&(req.handle, req.index)];
								let end = (req.offset as usize + req.length as usize).min(c.len());
								write_frame(&mut s, kind::DATA, &c[req.offset as usize..end]).unwrap();
							}
							kind::CLOSE => done(&mut s, r#"{"version":"p1"}"#),
							kind::EXECUTABLE => done(&mut s, r#"{"version":"p2"}"#),
							kind::MKDIR => {
								let e = ErrorReply { code: code::EXISTS.into(), message: "taken".into() };
								write_frame(&mut s, kind::ERROR, &serde_json::to_vec(&e).unwrap()).unwrap();
							}
							kind::RENAME | kind::UNLINK | kind::RMDIR => done(&mut s, "{}"),
							kind::PUBLISH => {
								let report = r#"{"commitId":"c","seq":3,"paths":[{"path":"a","outcome":"saved"}]}"#;
								write_frame(&mut s, kind::REPORT, report.as_bytes()).unwrap();
							}
							other => panic!("unexpected frame {other}"),
						}
					}
				});
			}
		});
		(format!("unix:{}", path.display()), stored)
	}

	/// A node stand-in that takes writes and drops the connection the first time `drop` says so for a frame it got
	/// (before answering it). Returns its address and every frame it got: its kind, and a chunk part's offset.
	fn dropping_node(
		dir: &std::path::Path,
		drop: impl Fn(u8, &[u8]) -> bool + Send + Sync + 'static,
	) -> (String, Arc<std::sync::Mutex<Vec<(u8, u64)>>>, Stored) {
		let path = dir.join("node.sock");
		let listener = UnixListener::bind(&path).unwrap();
		let got: Arc<std::sync::Mutex<Vec<(u8, u64)>>> = Arc::default();
		let stored: Stored = Arc::default();
		let (seen, chunks, drop) = (got.clone(), stored.clone(), Arc::new(drop));
		let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
		std::thread::spawn(move || {
			let partial: Arc<std::sync::Mutex<Vec<u8>>> = Arc::default();
			for conn in listener.incoming() {
				let mut s = conn.unwrap();
				let (seen, chunks, drop, dropped, partial) =
					(seen.clone(), chunks.clone(), drop.clone(), dropped.clone(), partial.clone());
				std::thread::spawn(move || {
					let (_, body) = read_frame(&mut s).unwrap();
					let hello: Hello = serde_json::from_slice(&body).unwrap();
					let ok = HelloOk { protocol: 2, view_id: hello.view_id, as_of_seq: 1, read_only: false };
					write_frame(&mut s, kind::HELLO_OK, &serde_json::to_vec(&ok).unwrap()).unwrap();
					while let Ok((k, body)) = read_frame(&mut s) {
						let mut offset = 0;
						if k == kind::CHUNK {
							let len = u32::from_be_bytes(body[..4].try_into().unwrap()) as usize;
							let header: ChunkHeader = serde_json::from_slice(&body[4..4 + len]).unwrap();
							offset = header.offset;
							let mut sofar = partial.lock().unwrap();
							if header.offset == 0 {
								sofar.clear();
							}
							assert_eq!(header.offset as usize, sofar.len(), "parts in order");
							sofar.extend_from_slice(&body[4 + len..]);
							if sofar.len() as u64 == header.bytes {
								chunks.lock().unwrap().insert((header.handle, header.index), sofar.clone());
							}
						}
						seen.lock().unwrap().push((k, offset));
						if !dropped.load(Ordering::SeqCst) && drop(k, &body) {
							dropped.store(true, Ordering::SeqCst);
							return;
						}
						write_frame(&mut s, kind::DONE, b"{}").unwrap();
					}
				});
			}
		});
		(format!("unix:{}", path.display()), got, stored)
	}

	/// A node stand-in whose answers take a moment (so requests at once each take a connection of their own), that
	/// counts the mkdirs it got by path, and can end every connection at once (its service restarting).
	struct ClosingNode {
		addr: String,
		streams: Arc<std::sync::Mutex<Vec<std::os::unix::net::UnixStream>>>,
		made: Arc<std::sync::Mutex<Vec<String>>>,
	}

	impl ClosingNode {
		fn start(dir: &std::path::Path) -> ClosingNode {
			let path = dir.join("node.sock");
			let listener = UnixListener::bind(&path).unwrap();
			let streams: Arc<std::sync::Mutex<Vec<std::os::unix::net::UnixStream>>> = Arc::default();
			let made: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
			let (all, got) = (streams.clone(), made.clone());
			std::thread::spawn(move || {
				for conn in listener.incoming() {
					let mut s = conn.unwrap();
					all.lock().unwrap().push(s.try_clone().unwrap());
					let got = got.clone();
					std::thread::spawn(move || {
						let Ok((_, body)) = read_frame(&mut s) else { return };
						let hello: Hello = serde_json::from_slice(&body).unwrap();
						let ok = HelloOk { protocol: 2, view_id: hello.view_id, as_of_seq: 1, read_only: false };
						write_frame(&mut s, kind::HELLO_OK, &serde_json::to_vec(&ok).unwrap()).unwrap();
						while let Ok((k, body)) = read_frame(&mut s) {
							assert_eq!(k, kind::MKDIR);
							got.lock().unwrap().push(serde_json::from_slice::<PathRequest>(&body).unwrap().path);
							std::thread::sleep(Duration::from_millis(100));
							if write_frame(&mut s, kind::DONE, b"{}").is_err() {
								return;
							}
						}
					});
				}
			});
			ClosingNode { addr: format!("unix:{}", path.display()), streams, made }
		}

		fn close_all(&self) {
			for s in self.streams.lock().unwrap().drain(..) {
				let _ = s.shutdown(std::net::Shutdown::Both);
			}
		}
	}

	#[test]
	fn a_change_after_the_node_ended_every_pooled_connection_goes_out_once() {
		let dir = tempdir();
		let node = ClosingNode::start(&dir);
		let link = Arc::new(Link::new(node.addr.clone(), view("right"), 4));
		// Three changes at once: the pool keeps three connections.
		let threads: Vec<_> = ["a", "b", "c"]
			.into_iter()
			.map(|p| {
				let link = link.clone();
				std::thread::spawn(move || link.mkdir(p).unwrap())
			})
			.collect();
		for t in threads {
			t.join().unwrap();
		}
		assert_eq!(link.free.lock().unwrap().len(), 3);
		// The node's service restarts: every pooled connection is dead. The next change still goes out, once.
		node.close_all();
		std::thread::sleep(Duration::from_millis(50));
		link.mkdir("d").unwrap();
		assert_eq!(node.made.lock().unwrap().iter().filter(|p| *p == "d").count(), 1);
		std::fs::remove_dir_all(dir).unwrap();
	}

	#[test]
	fn a_change_whose_answer_is_lost_is_never_sent_twice() {
		let dir = tempdir();
		// The node takes the mkdir, then the link breaks before its answer: it may have made it.
		let (addr, got, _) = dropping_node(&dir, |k, _| k == kind::MKDIR);
		let link = Link::new(addr, view("right"), 2);
		let err = link.mkdir("made").unwrap_err();
		assert!(matches!(err, Fail::Link(_)), "{err}");
		assert_eq!(err.errno(), libc::EIO);
		assert_eq!(got.lock().unwrap().iter().filter(|(k, _)| *k == kind::MKDIR).count(), 1);
		// The pool goes on with a new connection.
		link.mkdir("next").unwrap();
		std::fs::remove_dir_all(dir).unwrap();
	}

	#[test]
	fn a_publish_whose_answer_is_lost_is_never_sent_twice() {
		let dir = tempdir();
		// The node takes the publish, then the link breaks before its report: the boundary may have run.
		let (addr, got, _) = dropping_node(&dir, |k, _| k == kind::PUBLISH);
		let link = Link::new(addr, view("right"), 2);
		let err = link.publish().unwrap_err();
		assert!(matches!(err, Fail::Link(_)) && err.to_string().contains("unknown"), "{err}");
		assert_eq!(got.lock().unwrap().iter().filter(|(k, _)| *k == kind::PUBLISH).count(), 1);
		std::fs::remove_dir_all(dir).unwrap();
	}

	#[test]
	fn a_chunk_whose_sending_broke_off_is_sent_again_whole() {
		let dir = tempdir();
		// The link breaks at the chunk's second part.
		let (addr, got, stored) = dropping_node(&dir, |k, body| {
			k == kind::CHUNK && {
				let len = u32::from_be_bytes(body[..4].try_into().unwrap()) as usize;
				serde_json::from_slice::<ChunkHeader>(&body[4..4 + len]).unwrap().offset == PART as u64
			}
		});
		let link = Link::new(addr, view("right"), 2);
		let data: Vec<u8> = (0..2 * PART + 7).map(|i| (i % 253) as u8).collect();
		link.put_chunk(3, 0, &data).unwrap();
		let offsets: Vec<u64> = got.lock().unwrap().iter().map(|(_, o)| *o).collect();
		assert_eq!(offsets, [0, PART as u64, 0, PART as u64, 2 * PART as u64]);
		assert_eq!(stored.lock().unwrap()[&(3, 0)], data);
		std::fs::remove_dir_all(dir).unwrap();
	}

	#[test]
	fn writes_go_out_and_chunks_come_back() {
		let dir = tempdir();
		let (addr, stored) = fake_writer_node(&dir);
		let link = Link::new(addr, view("right"), 3);
		let open = OpenRequest { path: "a".into(), base: Some("v1".into()), create: true, exclusive: false, truncate: true };
		assert_eq!(link.open_write(&open).unwrap(), Opened { handle: 7, size: 0, version: "p0".into() });
		// A chunk of more than two parts.
		let data: Vec<u8> = (0..2 * PART + 10).map(|i| (i % 251) as u8).collect();
		link.put_chunk(7, 0, &data).unwrap();
		assert_eq!(stored.lock().unwrap()[&(7, 0)], data);
		assert_eq!(link.get_chunk(7, 0, PART as u64 - 2, 5).unwrap(), &data[PART - 2..PART + 3]);
		assert_eq!(link.close_write(7, data.len() as u64).unwrap(), "p1");
		assert_eq!(link.set_executable("a", None, true).unwrap(), "p2");
		assert_eq!(link.mkdir("taken").unwrap_err().errno(), libc::EEXIST);
		let rename = RenameRequest { from: "a".into(), from_base: None, to: "b".into(), to_base: None, no_replace: false };
		link.rename(&rename).unwrap();
		link.unlink("b", Some("p1".into())).unwrap();
		let report = link.publish().unwrap();
		assert_eq!((report.commit_id.as_deref(), report.seq), (Some("c"), Some(3)));
		assert_eq!(report.paths[0].outcome, "saved");
		assert!(!link.closed(), "an error about one request leaves the view open");
		std::fs::remove_dir_all(dir).unwrap();
	}
}
