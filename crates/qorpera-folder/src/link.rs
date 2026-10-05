//! The machine's side of the folder link: a pool of request connections and the feed connection.
//! Each connection opens with the view's id and pass; the node checks them and the calling machine.

use crate::frame::{kind, read_frame, write_frame};
use crate::proto::{
	code, Ack, Change, Entry, ErrorReply, Hello, HelloOk, ListRequest, Listing, ReadRequest, Role, MAX_READ, PROTOCOL,
};
use crate::transport::{connect, Stream};
use serde::de::DeserializeOwned;
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
				Err(Fail::Remote(e)) => {
					self.give(s);
					let f = Fail::Remote(e);
					self.note(&f);
					return Err(f);
				}
				Err(Fail::Link(e)) => {
					self.lost();
					if attempt > 1 {
						return Err(Fail::Link(e));
					}
				}
			}
		}
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
}
