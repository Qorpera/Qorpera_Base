//! The machine's side of the folder link: a pool of request connections and the feed connection.
//! Each connection opens with the view's id and pass; the node checks them and the calling machine.

use crate::frame::{kind, read_frame, write_frame};
use crate::proto::{
	code, Ack, Change, ChunkHeader, CloseRequest, Entry, ErrorReply, ExecutableRequest, GetChunk, Hello, HelloOk,
	ListRequest, Listing, OpenRequest, Opened, PathRequest, PublishRequest, ReadRequest, ReadsAnswer, RemoveRequest,
	RenameRequest, Report, Role, Saved, MAX_READ, PART, PROTOCOL,
};
use crate::reads::{Locked, ReadLog};
use crate::transport::{connect, Stream};
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use crate::viewfile::ViewFile;

/// How long a list or a read may wait for its answer, and a request to be sent. A cold read of a 4 MiB piece from the
/// storage server takes well under a second (measured 28 September); this only catches a link that died silently. A
/// change waits for its answer as long as the node takes (`change`).
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

/// A failed publication may still have an answered report whose receipts must reach the caller. Its release or
/// final closure remains unproven; retaining the report never changes the failure into a success.
#[derive(Debug)]
pub struct PublishFailure {
	pub failure: Fail,
	pub report: Option<Report>,
}

impl From<Fail> for PublishFailure {
	fn from(failure: Fail) -> Self {
		Self { failure, report: None }
	}
}

impl std::fmt::Display for PublishFailure {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		self.failure.fmt(f)
	}
}

#[derive(Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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
	view: Mutex<Current>,
	view_file: Option<Arc<ViewFile>>,
	/// A CLI publisher holds daemon.lock throughout all connections and publication when this is true.
	abandon: bool,
	grace: bool,
	feed: Mutex<Option<Connection>>,
	free: Mutex<Vec<Connection>>,
	ready: Condvar,
	open: Mutex<usize>,
	max: usize,
	/// Permanent closure after an immediate refusal or the desktop handoff grace expires.
	closed: AtomicBool,
	/// Called once when the view closes, so the mount can end instead of failing every call.
	on_closed: Mutex<Option<Box<dyn FnOnce() + Send>>>,
	/// REQUEST_TIMEOUT, shorter in tests.
	timeout: Duration,
	reads: Option<Arc<ReadLog>>,
}

struct Current {
	view: View,
	epoch: u64,
	accepted: bool,
	switchable: bool,
	closed_at: Option<Instant>,
}

/// Every stream is tied to the hello that accepted it, never to whichever view the Link currently names.
struct Connection {
	stream: Stream,
	epoch: u64,
	/// Service intake is volatile and belongs to this exact accepted connection.
	taken: u64,
	intake_lost: Option<bool>,
}
impl std::ops::Deref for Connection { type Target = Stream; fn deref(&self) -> &Stream { &self.stream } }
impl std::ops::DerefMut for Connection { fn deref_mut(&mut self) -> &mut Stream { &mut self.stream } }

impl Link {
	pub fn with_view_file(mut self, store: Arc<ViewFile>, grace: bool, abandon: bool) -> Link {
		self.view_file = Some(store);
		self.grace = grace;
		self.abandon = abandon;
		self
	}

	pub fn has_reads(&self) -> bool { self.reads.is_some() }

	pub fn epoch(&self) -> u64 { self.view.lock().unwrap().epoch }

	/// Checks atomic primary-file replacement even while the filesystem is idle. A bad replacement never erases
	/// accepted proof or extends the fixed closure grace. A successful hello invalidates old pools and the feed.
	pub fn refresh(&self) -> Result<bool, Fail> {
		self.expire();
		if self.closed() {
			return Err(Fail::Remote(ErrorReply { code: code::VIEW_CLOSED.into(), message: "the view is closed".into() }));
		}
		let before = self.epoch();
		if let Some(store) = &self.view_file {
			let target = store.target().map_err(Fail::Link)?;
			let changed = target != self.view.lock().unwrap().view;
			if changed {
				let (connection, _) = self.hello(Role::Io, self.timeout)?;
				connection.shutdown();
			}
		}
		self.expire();
		Ok(before != self.epoch())
	}

	pub fn expire(&self) {
		let expired = self.view.lock().unwrap().closed_at.is_some_and(|at| at.elapsed() >= Duration::from_secs(60));
		if expired && !self.closed.swap(true, Ordering::SeqCst) { self.fire_closed(); }
	}
	pub fn new(addr: String, view: View, max: usize) -> Link {
		Link {
			addr,
			view: Mutex::new(Current { view, epoch: 0, accepted: false, switchable: false, closed_at: None }),
			view_file: None,
			abandon: false,
			grace: false,
			feed: Mutex::new(None),
			free: Mutex::new(Vec::new()),
			ready: Condvar::new(),
			open: Mutex::new(0),
			max: max.max(1),
			closed: AtomicBool::new(false),
			on_closed: Mutex::new(None),
			timeout: REQUEST_TIMEOUT,
			reads: None,
		}
	}

	pub fn with_reads(mut self, reads: Arc<ReadLog>) -> Link {
		self.reads = Some(reads);
		self
	}

	pub fn record_read(&self, path: &str, version: Option<&str>, authority: Option<&crate::proto::Authority>) -> io::Result<()> {
		self.reads.as_ref().map_or(Ok(()), |log| log.note(path, version, authority))
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

	fn hello(&self, role: Role, timeout: Duration) -> Result<(Connection, HelloOk), Fail> {
		// A fixed interprocess lock spans reading primary, authenticating and checkpointing the accepted view.
		// No pool or journal lock is held: a stalled hello cannot deadlock the live mount's ordinary IO.
		let proof = self.view_file.as_ref().map(|store| store.prepare()).transpose().map_err(Fail::Link)?;
		let target = proof.as_ref().map(|p| p.target.clone()).unwrap_or_else(|| self.view.lock().unwrap().view.clone());
		let before = self.epoch();
		let remaining = self.view.lock().unwrap().closed_at.map(|at| Duration::from_secs(60).saturating_sub(at.elapsed()));
		let timeout = remaining.map_or(timeout, |left| timeout.min(left.max(Duration::from_millis(1))));
		let mut stream = connect(&self.addr).map_err(Fail::Link)?;
		stream.set_timeouts(Some(timeout), Some(self.timeout)).map_err(Fail::Link)?;
		let hello = Hello {
			protocol: PROTOCOL,
			environment_id: target.environment_id.clone(),
			view_id: target.view_id.clone(),
			pass: target.pass.clone(),
			role,
			previous: proof.as_ref().and_then(|p| p.previous.as_ref()).map(|old| crate::proto::Previous { view_id: old.view_id.clone(), pass: old.pass.clone() }),
			abandon: self.abandon && role == Role::Io,
		};
		let ok: HelloOk = match exchange(&mut stream, kind::HELLO, &json(&hello), kind::HELLO_OK).and_then(|b| parse(&b)) {
			Ok(ok) => ok,
			Err(f) => {
				// A refused proposed successor does not close the accepted view, nor reset its existing deadline.
				let same = self.view.lock().unwrap().view == target;
				if same { self.note(before, &f); }
				return Err(f);
			}
		};
		if ok.protocol != PROTOCOL || ok.view_id != target.view_id {
			return Err(Fail::Link(io::Error::other("the node answered for another view or protocol")));
		}
		self.expire();
		if self.closed() && self.view.lock().unwrap().accepted {
			return Err(Fail::Remote(ErrorReply { code: code::VIEW_CLOSED.into(), message: "the closed view's grace expired".into() }));
		}
		if let Some(proof) = &proof { proof.accepted().map_err(Fail::Link)?; }
		let (epoch, changed) = {
			let mut current = self.view.lock().unwrap();
			let changed = current.view != target;
			if changed {
				current.view = target;
				current.epoch += 1;
				current.closed_at = None;
				self.closed.store(false, Ordering::SeqCst);
			}
			current.accepted = true;
			current.switchable = ok.switchable;
			(current.epoch, changed)
		};
		if changed {
			self.drop_idle();
			if let Some(feed) = self.feed.lock().unwrap().take() { feed.shutdown(); }
		}
		Ok((Connection { stream, epoch, taken: 0, intake_lost: None }, ok))
	}

	/// Opens the feed: the node's answer to the hello, then a stream of changes.
	pub fn open_feed(&self) -> Result<(Feed, HelloOk), Fail> {
		let (connection, ok) = self.hello(Role::Feed, FEED_TIMEOUT)?;
		let mut active = self.feed.lock().unwrap();
		if connection.epoch != self.epoch() {
			return Err(Fail::Link(io::Error::other("the view changed while opening its feed")));
		}
		*active = Some(Connection { stream: connection.try_clone().map_err(Fail::Link)?, epoch: connection.epoch, taken: 0, intake_lost: None });
		Ok((Feed { connection }, ok))
	}

	pub fn feed_failed(&self, feed: &Feed, fail: &Fail) { self.note(feed.connection.epoch, fail); }
	pub fn feed_current(&self, feed: &Feed) -> bool { self.epoch() == feed.connection.epoch }

	/// All entries of a folder, page by page.
	pub fn list(&self, path: &str) -> Result<Vec<Entry>, Fail> {
		let mut out = Vec::new();
		let mut after = None;
		let mut epoch = self.epoch();
		loop {
			let req = ListRequest { path: path.to_string(), after: after.take() };
			let page: Listing = self.call(kind::LIST, &json(&req), kind::LISTING).and_then(|b| parse(&b))?;
			let now = self.epoch();
			if now != epoch {
				// An old page's continuation is not a cursor in the successor's tree.
				epoch = now;
				out.clear();
				after = None;
				continue;
			}
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
					let current = s.epoch == self.epoch();
					self.give(s);
					if current { return Ok(data); }
					// Lists and reads are repeatable; never return an old epoch's response into a new view.
					continue;
				}
				Err(f @ Fail::Remote(_)) => {
					let stale = s.epoch != self.epoch();
					self.answered(s, &f);
					if stale { continue; }
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
	///
	/// It waits for its answer as long as the node takes (a boundary the change waits for, or publishes first): the node
	/// answers, or its service goes and the connection with it. Given up early, a change the node still made would be
	/// lost to the program: a file opened there that nothing closes, a close whose version never comes.
	fn change(&self, request: u8, payload: &[u8], answer: u8) -> Result<Vec<u8>, Fail> {
		let mut attempt = 0;
		loop {
			attempt += 1;
			let mut s = match self.take() {
				Ok(s) => s,
				Err(Fail::Link(_)) if attempt == 1 => continue,
				Err(f) => return Err(f),
			};
			if let Err(f) = self.send_change(&mut s, request, payload) {
				// No mutation went out when handing over reads failed. A fresh connection must take the journal
				// again: an earlier I acknowledgement does not survive the service that acknowledged it.
				if let Fail::Remote(_) = f {
					let stale = s.epoch != self.epoch();
					self.answered(s, &f);
					if stale && f.view_closed() { continue; }
					return Err(f);
				}
				self.lost();
				self.drop_idle();
				if attempt == 1 {
					continue;
				}
				return Err(f);
			}
			return match read_answer(&mut s, answer) {
				Ok(data) => {
					if let Some(s) = self.after_change(s) {
						self.give(s);
					}
					Ok(data)
				}
				Err(f @ Fail::Remote(_)) => {
					let epoch = s.epoch;
					match self.after_change(s) {
						Some(s) => self.answered(s, &f),
						None => self.note(epoch, &f),
					}
					if epoch != self.epoch() && f.view_closed() { continue; }
					Err(f)
				}
				Err(Fail::Link(e)) => {
					self.lost();
					Err(Fail::Link(e))
				}
			};
		}
	}

	/// The journal lock spans the I/i barrier and the mutation's send, so every open already returned is accounted
	/// for. Release it before waiting for the mutation's answer: a slow boundary must not hold up unrelated reads.
	fn send_change(&self, s: &mut Connection, request: u8, payload: &[u8]) -> Result<u64, Fail> {
		let mut held = self.reads.as_ref().map(|log| log.locked()).transpose().map_err(Fail::Link)?;
		if let Some(log) = &mut held {
			self.hand_over(s, log)?;
			if log.lost() && request != kind::PUBLISH {
				return Err(Fail::Remote(ErrorReply { code: code::DENIED.into(), message: "the read journal is unproven".into() }));
			}
		}
		let through = held.as_ref().map_or(0, |log| log.last());
		s.set_timeouts(None, Some(self.timeout)).map_err(Fail::Link)?;
		write_frame(&mut s.stream, request, payload).map_err(Fail::Link)?;
		Ok(through)
	}

	fn hand_over(&self, s: &mut Connection, log: &mut Locked<'_>) -> Result<(), Fail> {
		let mut after = log.released().max(s.taken);
		if after >= log.last() && s.intake_lost == Some(log.lost()) {
			return Ok(());
		}
		s.set_timeouts(Some(self.timeout), Some(self.timeout)).map_err(Fail::Link)?;
		loop {
			let request = log.request(after);
			let sent = request.reads.last().map(|read| read.seq);
			let answer: ReadsAnswer = exchange(s, kind::READS, &json(&request), kind::READS_OK).and_then(|b| parse(&b))?;
			log.acknowledge(&answer).map_err(Fail::Link)?;
			if sent.is_some_and(|seq| answer.taken < seq) {
				return Err(Fail::Link(io::Error::other("the service did not take the complete read prefix")));
			}
			s.taken = s.taken.max(answer.taken);
			s.intake_lost = Some(request.lost);
			after = s.taken.max(log.released());
			if request.lost || after >= log.last() { return Ok(()); }
		}
	}

	/// A connection a change used, with a request's read timeout again; ended when it will not take it.
	fn after_change(&self, s: Connection) -> Option<Connection> {
		if s.set_timeouts(Some(self.timeout), Some(self.timeout)).is_ok() {
			return Some(s);
		}
		s.shutdown();
		self.lost();
		None
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
	fn answered(&self, s: Connection, f: &Fail) {
		let epoch = s.epoch;
		match f {
			Fail::Remote(e) if e.code == code::UNAVAILABLE => {
				s.shutdown();
				self.lost();
			}
			_ => self.give(s),
		}
		self.note(epoch, f);
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
	pub fn publish(&self) -> Result<Report, PublishFailure> {
		self.publish_final(false)
	}

	pub fn publish_final(&self, final_boundary: bool) -> Result<Report, PublishFailure> {
		let (mut s, _) = self.hello(Role::Io, self.timeout)?;
		let epoch = s.epoch;
		let mut received = None;
		let answer = (|| -> Result<(), Fail> {
			let through = self.send_change(&mut s, kind::PUBLISH, &json(&PublishRequest { final_boundary }))?;
			let bytes = read_answer(&mut s, kind::REPORT).map_err(|f| match f {
				Fail::Link(e) => Fail::Link(io::Error::new(
					e.kind(),
					format!("the request went out but no answer came ({e}), so whether the boundary ran is unknown"),
				)),
				f => f,
			})?;
			received = Some(parse::<Report>(&bytes)?);
			let report = received.as_ref().unwrap();
			if report.refused.is_none() && !report.closed {
				if let Some(reads) = &self.reads {
					let mut log = reads.locked().map_err(Fail::Link)?;
					// Poll only: reads begun after the boundary are for the next one. An empty paths report also
					// represents an unanswered no-write release, so it is not by itself proof of completion.
					let request = log.request(log.last());
					s.set_timeouts(Some(self.timeout), Some(self.timeout)).map_err(Fail::Link)?;
					let acknowledged: ReadsAnswer = exchange(&mut s, kind::READS, &json(&request), kind::READS_OK).and_then(|b| parse(&b))?;
					log.acknowledge(&acknowledged).map_err(Fail::Link)?;
					if log.lost() || log.released() < through {
						return Err(Fail::Link(io::Error::other("the boundary's read release did not complete; ask again")));
					}
				}
				// Keep non-success path reports intact: the helper distinguishes a definitive refusal from a
				// retryable one. Only an otherwise successful final needs this additional closure proof.
				if final_boundary && report.paths.iter().all(|entry| entry.outcome == "saved") {
					return Err(Fail::Link(io::Error::other("the final boundary did not close the view; ask again")));
				}
			}
			Ok(())
		})();
		s.shutdown();
		if let Err(f) = &answer {
			self.note(epoch, f);
		}
		match answer {
			Ok(()) => Ok(received.unwrap()),
			Err(failure) => Err(PublishFailure { failure, report: received }),
		}
	}

	fn note(&self, epoch: u64, f: &Fail) {
		if !f.view_closed() { return; }
		let defer = {
			let mut current = self.view.lock().unwrap();
			if current.epoch != epoch { return; }
			let defer = self.grace && current.accepted && current.switchable;
			if defer { current.closed_at.get_or_insert_with(Instant::now); }
			defer
		};
		if !defer { self.closed.store(true, Ordering::SeqCst); }
		{
			let _free = self.free.lock().unwrap();
			self.ready.notify_all();
		}
		if !defer { self.fire_closed(); }
	}

	/// A free connection, or a new one while fewer than `max` are open, or a wait for one.
	fn take(&self) -> Result<Connection, Fail> {
		self.refresh()?;
		let mut free = self.free.lock().unwrap();
		loop {
			if self.closed() {
				return Err(Fail::Remote(ErrorReply { code: code::VIEW_CLOSED.into(), message: "the view is closed".into() }));
			}
			if let Some(s) = free.pop() {
				if s.epoch == self.epoch() { return Ok(s); }
				s.shutdown();
				let mut open = self.open.lock().unwrap();
				*open = open.saturating_sub(1);
				continue;
			}
			{
				let mut open = self.open.lock().unwrap();
				if *open < self.max {
					*open += 1;
					drop(open);
					drop(free);
					return self.hello(Role::Io, self.timeout).map(|(s, _)| s).inspect_err(|f| {
						self.lost();
						let _ = f; // hello already recorded a refusal against its own epoch.
					});
				}
			}
			free = self.ready.wait(free).unwrap();
		}
	}

	fn give(&self, s: Connection) {
		let mut free = self.free.lock().unwrap();
		if s.epoch == self.epoch() {
			free.push(s);
		} else {
			s.shutdown();
			let mut open = self.open.lock().unwrap();
			*open = open.saturating_sub(1);
		}
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
	connection: Connection,
}

impl Feed {
	/// The next change; a heartbeat is a change with no paths. Errors when the link breaks or no
	/// frame came within `FEED_TIMEOUT`.
	pub fn next(&mut self) -> Result<Change, Fail> {
		let (k, payload) = read_frame(&mut self.connection.stream).map_err(Fail::Link)?;
		match k {
			kind::CHANGE => parse(&payload),
			kind::ERROR => Err(Fail::Remote(parse(&payload)?)),
			other => Err(Fail::Link(io::Error::other(format!("unexpected frame {other} on the feed")))),
		}
	}

	pub fn ack(&mut self, seq: u64) -> Result<(), Fail> {
		write_frame(&mut self.connection.stream, kind::ACK, &json(&Ack { seq })).map_err(Fail::Link)
	}

	pub fn close(&self) {
		self.connection.shutdown();
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
		Entry { name: name.into(), kind: EntryKind::File, size: 3, mtime_ms: 0, executable: false, version: "v1".into(), authority: None }
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
					let ok = HelloOk { protocol: PROTOCOL, view_id: hello.view_id, as_of_seq: 7, read_only: true, switchable: false };
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
	fn each_connection_takes_only_new_reads_and_still_reports_later_lost_proof() {
		for count in [0, 40] {
			let dir = tempdir();
			let state = dir.join("state");
			let reads = Arc::new(ReadLog::open(&state, true).unwrap());
			for n in 0..count { reads.note(&format!("input/{n}"), Some("v1"), None).unwrap(); }
			let path = dir.join("node.sock");
			let listener = UnixListener::bind(&path).unwrap();
			let received = Arc::new(Mutex::new(Vec::<crate::proto::ReadsRequest>::new()));
			let received_by_node = received.clone();
			std::thread::spawn(move || {
				for conn in listener.incoming() {
					let mut s = conn.unwrap();
					let received = received_by_node.clone();
					std::thread::spawn(move || {
						let (_, body) = read_frame(&mut s).unwrap();
						let hello: Hello = serde_json::from_slice(&body).unwrap();
						let ok = HelloOk { protocol: PROTOCOL, view_id: hello.view_id, as_of_seq: 1, read_only: false, switchable: false };
						write_frame(&mut s, kind::HELLO_OK, &json(&ok)).unwrap();
						let mut taken = 0;
						while let Ok((kind, body)) = read_frame(&mut s) {
							if kind == kind::READS {
								let request: crate::proto::ReadsRequest = serde_json::from_slice(&body).unwrap();
								taken = request.reads.last().map_or(taken, |read| read.seq);
								let answer = ReadsAnswer { log: request.log.clone(), taken, released: 0 };
								received.lock().unwrap().push(request);
								if write_frame(&mut s, kind::READS_OK, &json(&answer)).is_err() { break; }
							} else {
								assert_eq!(kind, kind::MKDIR);
								if write_frame(&mut s, kind::DONE, b"{}").is_err() { break; }
							}
						}
					});
				}
			});
			let link = Link::new(format!("unix:{}", path.display()), view("right"), 1).with_reads(reads.clone());
			link.mkdir("first").unwrap();
			link.mkdir("second").unwrap();
			assert_eq!(received.lock().unwrap().len(), 1, "no repeated intake, including an empty log");
			assert_eq!(received.lock().unwrap()[0].reads.len(), count);
			reads.note("new", Some("v2"), None).unwrap();
			link.mkdir("third").unwrap();
			assert_eq!(received.lock().unwrap()[1].reads.len(), 1);
			assert_eq!(received.lock().unwrap()[1].reads[0].seq, count as u64 + 1);
			link.drop_idle(); // A new stream represents a service with no volatile taken watermark.
			link.mkdir("after-reconnect").unwrap();
			assert_eq!(received.lock().unwrap()[2].reads.len(), count + 1);
			std::fs::write(state.join("reads.lost"), b"").unwrap();
			assert!(link.mkdir("must-not-go-out").is_err());
			let got = received.lock().unwrap();
			assert_eq!(got.len(), 4);
			assert!(got[3].lost && got[3].reads.is_empty(), "a live stream must hear newly lost proof");
			drop(got);
			link.drop_idle();
			std::fs::remove_dir_all(dir).unwrap();
		}
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
					assert_eq!(hello.protocol, PROTOCOL);
					let ok = HelloOk { protocol: PROTOCOL, view_id: hello.view_id, as_of_seq: 1, read_only: false, switchable: false };
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
					let ok = HelloOk { protocol: PROTOCOL, view_id: hello.view_id, as_of_seq: 1, read_only: false, switchable: false };
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
						let ok = HelloOk { protocol: PROTOCOL, view_id: hello.view_id, as_of_seq: 1, read_only: false, switchable: false };
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

	/// A node stand-in that answers every request after `delay`: a list with an empty listing, anything else with `{}`.
	fn slow_node(dir: &std::path::Path, delay: Duration) -> String {
		let path = dir.join("node.sock");
		let listener = UnixListener::bind(&path).unwrap();
		std::thread::spawn(move || {
			for conn in listener.incoming() {
				let mut s = conn.unwrap();
				std::thread::spawn(move || {
					let (_, body) = read_frame(&mut s).unwrap();
					let hello: Hello = serde_json::from_slice(&body).unwrap();
					let ok = HelloOk { protocol: PROTOCOL, view_id: hello.view_id, as_of_seq: 1, read_only: false, switchable: false };
					write_frame(&mut s, kind::HELLO_OK, &serde_json::to_vec(&ok).unwrap()).unwrap();
					while let Ok((k, _)) = read_frame(&mut s) {
						std::thread::sleep(delay);
						let (k, body) = if k == kind::LIST {
							(kind::LISTING, serde_json::to_vec(&Listing { entries: Vec::new(), next: None }).unwrap())
						} else {
							(kind::DONE, b"{}".to_vec())
						};
						if write_frame(&mut s, k, &body).is_err() {
							return;
						}
					}
				});
			}
		});
		format!("unix:{}", path.display())
	}

	#[test]
	fn a_change_waits_for_its_answer_as_long_as_the_node_takes() {
		let dir = tempdir();
		let mut link = Link::new(slow_node(&dir, Duration::from_millis(600)), view("right"), 2);
		link.timeout = Duration::from_millis(200);
		// A list gives up on a node that does not answer in time.
		assert!(matches!(link.list(""), Err(Fail::Link(_))));
		// A change does not: the node may be waiting for a boundary, and it would still make a change given up on.
		link.mkdir("slow").unwrap();
		// Its connection goes back to the pool with the request timeout again.
		assert_eq!(link.free.lock().unwrap().len(), 1);
		assert!(matches!(link.list(""), Err(Fail::Link(_))));
		std::fs::remove_dir_all(dir).unwrap();
	}

	#[test]
	fn a_publish_whose_answer_is_lost_is_never_sent_twice() {
		let dir = tempdir();
		// The node takes the publish, then the link breaks before its report: the boundary may have run.
		let (addr, got, _) = dropping_node(&dir, |k, _| k == kind::PUBLISH);
		let link = Link::new(addr, view("right"), 2);
		let err = link.publish().unwrap_err();
		assert!(matches!(err.failure, Fail::Link(_)) && err.to_string().contains("unknown"), "{err}");
		assert!(err.report.is_none());
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

	#[test]
	fn old_read_replies_and_refusals_cannot_enter_or_close_a_successor_epoch() {
		use std::os::unix::fs::PermissionsExt;
		use std::sync::mpsc;
		for refused in [false, true] {
			let dir = tempdir();
			std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
			let state = dir.join("state");
			let log = Arc::new(ReadLog::open(&state, true).unwrap());
			let primary = dir.join("primary.json");
			let first = View { environment_id: "company".into(), view_id: "first".into(), pass: "private-first".into() };
			let second = View { environment_id: "company".into(), view_id: "second".into(), pass: "private-second".into() };
			std::fs::write(&primary, json(&first)).unwrap();
			std::fs::set_permissions(&primary, std::fs::Permissions::from_mode(0o600)).unwrap();
			let store = Arc::new(ViewFile::open(primary.clone(), &state, &first, log.created()).unwrap());
			let socket = dir.join("switch.sock");
			let listener = UnixListener::bind(&socket).unwrap();
			let (entered, started) = mpsc::channel();
			let gate = Arc::new((Mutex::new(false), Condvar::new()));
			let server_gate = gate.clone();
			std::thread::spawn(move || {
				for connection in listener.incoming() {
					let mut stream = connection.unwrap();
					let gate = server_gate.clone();
					let entered = entered.clone();
					std::thread::spawn(move || {
						let (_, bytes) = read_frame(&mut stream).unwrap();
						let hello: Hello = serde_json::from_slice(&bytes).unwrap();
						let old = hello.view_id == "first";
						let ok = HelloOk { protocol: PROTOCOL, view_id: hello.view_id, as_of_seq: 1, read_only: false, switchable: true };
						write_frame(&mut stream, kind::HELLO_OK, &json(&ok)).unwrap();
						while let Ok((request, _)) = read_frame(&mut stream) {
							assert_eq!(request, kind::READ);
							if old {
								entered.send(()).unwrap();
								let mut open = gate.0.lock().unwrap();
								while !*open { open = gate.1.wait(open).unwrap(); }
							}
							let answer = if old && refused {
								write_frame(&mut stream, kind::ERROR, &json(&ErrorReply { code: code::VIEW_CLOSED.into(), message: "old view closed".into() }))
							} else { write_frame(&mut stream, kind::DATA, if old { b"stale" } else { b"fresh" }) };
							if answer.is_err() { break; }
						}
					});
				}
			});
			let link = Arc::new(Link::new(format!("unix:{}", socket.display()), first, 2).with_reads(log).with_view_file(store, true, false));
			let reading = { let link = link.clone(); std::thread::spawn(move || link.read("file", "version", 0, 5)) };
			started.recv_timeout(Duration::from_secs(3)).unwrap();
			let replacement = dir.join("next.json");
			std::fs::write(&replacement, json(&second)).unwrap();
			std::fs::set_permissions(&replacement, std::fs::Permissions::from_mode(0o600)).unwrap();
			std::fs::rename(replacement, primary).unwrap();
			assert!(link.refresh().unwrap());
			*gate.0.lock().unwrap() = true;
			gate.1.notify_all();
			assert_eq!(reading.join().unwrap().unwrap(), b"fresh");
			assert!(!link.closed());
			assert_eq!(link.read("file", "version", 0, 5).unwrap(), b"fresh");
			link.drop_idle();
			std::fs::remove_dir_all(dir).unwrap();
		}
	}

}
