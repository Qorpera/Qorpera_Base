//! A node stand-in for the folder program's tests: the folder protocol on a Unix socket, over a small tree
//! in memory that a test changes while machines watch it.

use qorpera_folder::frame::{kind, read_frame, write_frame};
use qorpera_folder::proto::{
	code, Change, ChunkHeader, CloseRequest, Entry, EntryKind, ErrorReply, ExecutableRequest, GetChunk, Hello, HelloOk,
	LinkRequest, ListRequest, Listing, OpenRequest, Opened, PathRequest, ReadRequest, ReadsRequest, ReadsAnswer, RemoveRequest, RenameRequest, Report, Role,
	SymlinkRequest, CHUNK,
};
use sha2::{Digest, Sha256};
use qorpera_folder::transport::Stream;
use std::collections::BTreeMap;
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub const PASS: &str = "right-pass";

#[derive(Clone)]
struct Node {
	folder: bool,
	/// A symbolic link: `content` is its target.
	link: bool,
	version: u64,
	content: Vec<u8>,
	executable: bool,
}

/// A file open for writing: its path and its chunks as the node holds them.
struct Open {
	path: String,
	chunks: Vec<Vec<u8>>,
	/// The file is in the tree only once this handle's close lands it.
	draft: bool,
}

#[derive(Default)]
struct State {
	entries: BTreeMap<String, Node>,
	/// Replaced versions: (path, version) to content.
	old: std::collections::HashMap<(String, String), Vec<u8>>,
	seq: u64,
	feeds: Vec<Stream>,
	reads: usize,
	closed: bool,
	/// The view takes writes (protocol 2). Writes change the tree at once; a publish only counts.
	writable: bool,
	handles: std::collections::HashMap<u32, Open>,
	next_handle: u32,
	parts: std::collections::HashMap<(u32, u32), Vec<u8>>,
	/// Every open for writing: its path and the base it named.
	opens: Vec<(String, Option<String>)>,
	renames: Vec<RenameRequest>,
	links: Vec<LinkRequest>,
	publishes: usize,
	/// Chunks asked back.
	gets: usize,
	/// How many of the next chunks, closes, discards and links to answer BUSY (a boundary settling).
	busy_chunks: usize,
	busy_closes: usize,
	busy_discards: usize,
	busy_links: usize,
	/// How many of the next renames to answer only a while after they changed the tree and the feeds heard of it.
	slow_renames: usize,
	logs: std::collections::HashMap<String, u64>,
	/// Every read the machine handed over, as (path, version).
	logged: Vec<(String, Option<String>)>,
	unproven: bool,
}

pub struct FakeNode {
	pub dir: PathBuf,
	pub addr: String,
	state: Arc<Mutex<State>>,
}

fn parent(path: &str) -> &str {
	path.rsplit_once('/').map_or("", |(p, _)| p)
}

fn send_json(s: &mut Stream, k: u8, v: &impl serde::Serialize) -> std::io::Result<()> {
	write_frame(s, k, &serde_json::to_vec(v).unwrap())
}

fn error(s: &mut Stream, c: &str) -> std::io::Result<()> {
	send_json(s, kind::ERROR, &ErrorReply { code: c.into(), message: String::new() })
}

impl FakeNode {
	pub fn start() -> FakeNode {
		// Tests run in parallel threads of one process: a counter keeps their folders apart.
		static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
		let dir = std::env::temp_dir().join(format!(
			"qorpera-folder-node-{}-{}",
			std::process::id(),
			NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
		));
		let _ = std::fs::remove_dir_all(&dir);
		std::fs::create_dir(&dir).unwrap();
		let path = dir.join("node.sock");
		let listener = UnixListener::bind(&path).unwrap();
		let state = Arc::new(Mutex::new(State::default()));
		let shared = state.clone();
		std::thread::spawn(move || {
			for conn in listener.incoming() {
				let Ok(conn) = conn else { return };
				let state = shared.clone();
				std::thread::spawn(move || serve(Stream::Unix(conn), state));
			}
		});
		FakeNode { dir, addr: format!("unix:{}", path.display()), state }
	}

	/// Writes a file (and the folders above it), then tells every feed.
	pub fn put(&self, path: &str, content: &str, executable: bool) {
		self.place(path, content, executable, false);
	}

	/// Makes a symbolic link (and the folders above it), or replaces what the path held, then tells every feed.
	pub fn put_link(&self, path: &str, target: &str) {
		self.place(path, target, false, true);
	}

	fn place(&self, path: &str, content: &str, executable: bool, link: bool) {
		let mut s = self.state.lock().unwrap();
		let mut changed = vec![path.to_string()];
		let mut p = parent(path);
		while !p.is_empty() {
			if !s.entries.contains_key(p) {
				s.entries.insert(p.to_string(), Node { folder: true, link: false, version: 1, content: Vec::new(), executable: false });
				changed.push(p.to_string());
			}
			p = parent(p);
		}
		if let Some(n) = s.entries.get(path).cloned() {
			s.old.insert((path.to_string(), format!("v{}", n.version)), n.content);
		}
		let version = s.entries.get(path).map_or(1, |n| n.version + 1);
		s.entries.insert(path.to_string(), Node { folder: false, link, version, content: content.as_bytes().to_vec(), executable });
		notify(&mut s, changed, false);
	}

	pub fn remove(&self, path: &str) {
		let mut s = self.state.lock().unwrap();
		s.entries.remove(path);
		notify(&mut s, vec![path.to_string()], false);
	}

	/// Changes the tree without telling anyone (as if the feed had missed it).
	pub fn put_quietly(&self, path: &str, content: &str) {
		let mut s = self.state.lock().unwrap();
		let version = s.entries.get(path).map_or(1, |n| n.version + 1);
		s.entries.insert(path.to_string(), Node { folder: false, link: false, version, content: content.as_bytes().to_vec(), executable: false });
		s.seq += 1;
	}

	pub fn drop_feeds(&self) {
		for f in self.state.lock().unwrap().feeds.drain(..) {
			f.shutdown();
		}
	}

	pub fn feeds(&self) -> usize {
		self.state.lock().unwrap().feeds.len()
	}

	pub fn close_view(&self) {
		let mut s = self.state.lock().unwrap();
		s.closed = true;
		for mut f in s.feeds.drain(..) {
			let _ = error(&mut f, code::VIEW_CLOSED);
		}
	}

	pub fn reads(&self) -> usize {
		self.state.lock().unwrap().reads
	}

	/// A node whose view takes writes.
	pub fn writable() -> FakeNode {
		let node = FakeNode::start();
		node.state.lock().unwrap().writable = true;
		node
	}

	/// The view opens again after `close_view` (a mount started again).
	pub fn reopen_view(&self) {
		self.state.lock().unwrap().closed = false;
	}

	pub fn content(&self, path: &str) -> Option<Vec<u8>> {
		self.state.lock().unwrap().entries.get(path).filter(|n| !n.folder && !n.link).map(|n| n.content.clone())
	}

	/// A link's target.
	pub fn target(&self, path: &str) -> Option<String> {
		self.state.lock().unwrap().entries.get(path).filter(|n| n.link).map(|n| String::from_utf8(n.content.clone()).unwrap())
	}

	/// Every hard link asked for.
	pub fn links(&self) -> Vec<LinkRequest> {
		self.state.lock().unwrap().links.clone()
	}

	pub fn exists(&self, path: &str) -> bool {
		self.state.lock().unwrap().entries.contains_key(path)
	}

	pub fn executable(&self, path: &str) -> bool {
		self.state.lock().unwrap().entries.get(path).is_some_and(|n| n.executable)
	}

	pub fn opens(&self) -> Vec<(String, Option<String>)> {
		self.state.lock().unwrap().opens.clone()
	}

	pub fn renames(&self) -> Vec<RenameRequest> {
		self.state.lock().unwrap().renames.clone()
	}

	/// Every read the machine handed over (it hands them over before each change), as (path, version).
	pub fn logged(&self) -> Vec<(String, Option<String>)> {
		self.state.lock().unwrap().logged.clone()
	}

	pub fn publishes(&self) -> usize {
		self.state.lock().unwrap().publishes
	}

	pub fn version(&self, path: &str) -> Option<String> {
		self.state.lock().unwrap().entries.get(path).map(version_of)
	}

	pub fn gets(&self) -> usize {
		self.state.lock().unwrap().gets
	}

	/// Files open for writing at the node.
	pub fn open_handles(&self) -> usize {
		self.state.lock().unwrap().handles.len()
	}

	/// The next `chunks` chunks and `closes` closes are answered BUSY.
	pub fn busy(&self, chunks: usize, closes: usize) {
		let mut s = self.state.lock().unwrap();
		s.busy_chunks = chunks;
		s.busy_closes = closes;
	}

	/// The next `discards` discards of a handle are answered BUSY.
	pub fn busy_discards(&self, discards: usize) {
		self.state.lock().unwrap().busy_discards = discards;
	}

	/// The next `links` symbolic links are answered BUSY.
	pub fn busy_links(&self, links: usize) {
		self.state.lock().unwrap().busy_links = links;
	}

	/// The next `renames` renames are answered three seconds after they changed the tree and the feeds heard of it.
	pub fn slow_renames(&self, renames: usize) {
		self.state.lock().unwrap().slow_renames = renames;
	}

	/// How many of the discards `busy_discards` asked for were not answered BUSY yet.
	pub fn busy_discards_left(&self) -> usize {
		self.state.lock().unwrap().busy_discards
	}
}

impl Drop for FakeNode {
	fn drop(&mut self) {
		let _ = std::fs::remove_dir_all(&self.dir);
	}
}

fn notify(s: &mut State, paths: Vec<String>, resync: bool) {
	s.seq += 1;
	let change = Change { seq: s.seq, resync, paths };
	s.feeds.retain_mut(|f| send_json(f, kind::CHANGE, &change).is_ok());
}

fn serve(mut s: Stream, state: Arc<Mutex<State>>) {
	let Ok((kind_byte, body)) = read_frame(&mut s) else { return };
	assert_eq!(kind_byte, kind::HELLO);
	let hello: Hello = serde_json::from_slice(&body).unwrap();
	{
		let st = state.lock().unwrap();
		if hello.pass != PASS || st.closed {
			let _ = error(&mut s, if st.closed { code::VIEW_CLOSED } else { code::VIEW_REFUSED });
			return;
		}
		// As the node does: the machine's protocol echoed.
		let ok =
			HelloOk { protocol: hello.protocol, view_id: hello.view_id.clone(), as_of_seq: st.seq, read_only: !st.writable, switchable: false, code_host: false };
		send_json(&mut s, kind::HELLO_OK, &ok).unwrap();
	}
	if hello.role == Role::Feed {
		state.lock().unwrap().feeds.push(s.try_clone().unwrap());
		// Acknowledgements until the machine goes.
		while read_frame(&mut s).is_ok() {}
		return;
	}
	loop {
		let Ok((k, body)) = read_frame(&mut s) else { return };
		let mut st = state.lock().unwrap();
		if k == kind::RENAME && st.writable && st.slow_renames > 0 {
			// The tree changes now and the answer comes later, while the node goes on with other requests.
			st.slow_renames -= 1;
			let req: RenameRequest = serde_json::from_slice(&body).unwrap();
			st.renames.push(req.clone());
			let done = rename(&mut st, &req);
			if done.is_ok() {
				notify(&mut st, vec![req.from, req.to], false);
			}
			drop(st);
			std::thread::sleep(std::time::Duration::from_secs(3));
			let result = match done {
				Ok(()) => write_frame(&mut s, kind::DONE, b"{}"),
				Err(c) => error(&mut s, c),
			};
			if result.is_err() {
				return;
			}
			continue;
		}
		let result = match k {
			kind::LIST => {
				let req: ListRequest = serde_json::from_slice(&body).unwrap();
				if !req.path.is_empty() && !st.entries.get(&req.path).is_some_and(|n| n.folder) {
					error(&mut s, code::NOT_FOUND)
				} else {
					let entries: Vec<Entry> = st
						.entries
						.iter()
						.filter(|(p, _)| parent(p) == req.path && p.as_str() != req.path)
						.map(|(p, n)| Entry {
							name: p.rsplit('/').next().unwrap().to_string(),
							kind: if n.folder {
								EntryKind::Folder
							} else if n.link {
								EntryKind::Symlink
							} else {
								EntryKind::File
							},
							size: n.content.len() as u64,
							mtime_ms: 1_700_000_000_000,
							executable: n.executable,
							version: format!("v{}", n.version),
							authority: None,
						})
						.collect();
					send_json(&mut s, kind::LISTING, &Listing { entries, next: None })
				}
			}
			kind::READ => {
				let req: ReadRequest = serde_json::from_slice(&body).unwrap();
				st.reads += 1;
				match st.entries.get(&req.path) {
					Some(n) if !n.folder && format!("v{}", n.version) == req.version => {
						let start = (req.offset as usize).min(n.content.len());
						let end = (start + req.length as usize).min(n.content.len());
						let data = n.content[start..end].to_vec();
						write_frame(&mut s, kind::DATA, &data)
					}
					Some(n) if !n.folder => {
						// The previous version stays readable, as the node's superseded versions do.
						match st.old.get(&(req.path.clone(), req.version.clone())) {
							Some(content) => {
								let start = (req.offset as usize).min(content.len());
								let end = (start + req.length as usize).min(content.len());
								let data = content[start..end].to_vec();
								write_frame(&mut s, kind::DATA, &data)
							}
							None => error(&mut s, code::STALE),
						}
					}
					_ => error(&mut s, code::NOT_FOUND),
				}
			}
			_ if !st.writable => error(&mut s, code::READ_ONLY),
			_ => write(&mut st, &mut s, k, &body),
		};
		drop(st);
		if result.is_err() {
			return;
		}
	}
}

fn version_of(n: &Node) -> String {
	format!("v{}", n.version)
}

/// A rename applied to the tree, or the error code the node answers.
fn rename(st: &mut State, req: &RenameRequest) -> Result<(), &'static str> {
	let Some(n) = st.entries.get(&req.from).cloned() else { return Err(code::NOT_FOUND) };
	if let Some(t) = st.entries.get(&req.to) {
		if req.no_replace {
			return Err(code::EXISTS);
		}
		if t.folder != n.folder {
			return Err(if t.folder { code::NOT_A_FILE } else { code::NOT_A_FOLDER });
		}
	}
	let from = format!("{}/", req.from);
	let moved: Vec<(String, Node)> = st
		.entries
		.iter()
		.filter(|(p, _)| **p == req.from || p.starts_with(&from))
		.map(|(p, n)| (p.clone(), n.clone()))
		.collect();
	st.entries.remove(&req.to);
	for (p, n) in moved {
		st.entries.remove(&p);
		st.entries.insert(format!("{}{}", req.to, &p[req.from.len()..]), n);
	}
	Ok(())
}

/// A write request, applied to the tree at once.
fn write(st: &mut State, s: &mut Stream, k: u8, body: &[u8]) -> std::io::Result<()> {
	let folder = |st: &State, p: &str| p.is_empty() || st.entries.get(p).is_some_and(|n| n.folder);
	match k {
		kind::READS => {
			let req: ReadsRequest = serde_json::from_slice(body).unwrap();
			st.unproven |= req.lost;
			let mut taken = st.logs.get(&req.log).copied().unwrap_or_else(|| req.reads.first().map_or(0, |r| r.seq - 1));
			for read in &req.reads {
				if read.seq <= taken { continue; }
				assert_eq!(read.seq, taken + 1);
				taken = read.seq;
				st.logged.push((read.path.clone(), read.version.clone()));
			}
			st.logs.insert(req.log.clone(), taken);
			// This stand-in's operator view has no read set: every read is released immediately.
			send_json(s, kind::READS_OK, &ReadsAnswer { log: req.log, taken, released: taken })
		}
		kind::OPEN => {
			let req: OpenRequest = serde_json::from_slice(body).unwrap();
			st.opens.push((req.path.clone(), req.base.clone()));
			match st.entries.get(&req.path).cloned() {
				Some(n) if n.folder => return error(s, code::NOT_A_FILE),
				Some(_) if req.exclusive => return error(s, code::EXISTS),
				// As the node: the kernel follows a link before it opens, so one that reaches here was to be new.
				Some(n) if n.link => return error(s, code::EXISTS),
				None if !req.create => return error(s, code::NOT_FOUND),
				None if !folder(st, parent(&req.path)) => return error(s, code::NOT_FOUND),
				// A draft starts empty, and the tree keeps what it had until its close.
				_ if req.draft => {
					st.next_handle += 1;
					let handle = st.next_handle;
					st.handles.insert(handle, Open { path: req.path, chunks: Vec::new(), draft: true });
					return send_json(s, kind::OPENED, &Opened { handle, size: 0, version: "draft".into() });
				}
				None => {
					st.entries.insert(req.path.clone(), Node { folder: false, link: false, version: 1, content: Vec::new(), executable: false });
				}
				Some(n) if req.truncate && !n.content.is_empty() => {
					st.old.insert((req.path.clone(), version_of(&n)), n.content.clone());
					let e = st.entries.get_mut(&req.path).unwrap();
					e.content.clear();
					e.version += 1;
				}
				Some(_) => {}
			}
			let n = st.entries[&req.path].clone();
			let chunks = n.content.chunks(CHUNK as usize).map(<[u8]>::to_vec).collect();
			st.next_handle += 1;
			let handle = st.next_handle;
			st.handles.insert(handle, Open { path: req.path, chunks, draft: false });
			send_json(s, kind::OPENED, &Opened { handle, size: n.content.len() as u64, version: version_of(&n) })
		}
		kind::CHUNK => {
			let len = u32::from_be_bytes(body[..4].try_into().unwrap()) as usize;
			let header: ChunkHeader = serde_json::from_slice(&body[4..4 + len]).unwrap();
			if header.offset == 0 && st.busy_chunks > 0 {
				st.busy_chunks -= 1;
				return error(s, code::BUSY);
			}
			let data = &body[4 + len..];
			let key = (header.handle, header.index);
			let sofar = st.parts.entry(key).or_default();
			if header.offset == 0 {
				sofar.clear();
			}
			assert_eq!(header.offset as usize, sofar.len(), "parts in order");
			sofar.extend_from_slice(data);
			if sofar.len() as u64 == header.bytes {
				let chunk = st.parts.remove(&key).unwrap();
				let digest: String = Sha256::digest(&chunk).iter().map(|b| format!("{b:02x}")).collect();
				assert_eq!(digest, header.sha256, "the chunk's hash");
				let open = st.handles.get_mut(&header.handle).expect("an open handle");
				let index = header.index as usize;
				assert!(index <= open.chunks.len(), "a chunk before {index} is missing");
				if index == open.chunks.len() {
					open.chunks.push(chunk);
				} else {
					open.chunks[index] = chunk;
				}
			}
			write_frame(s, kind::DONE, b"{}")
		}
		kind::GET_CHUNK => {
			let req: GetChunk = serde_json::from_slice(body).unwrap();
			st.gets += 1;
			let c = &st.handles[&req.handle].chunks[req.index as usize];
			let start = (req.offset as usize).min(c.len());
			let end = (start + req.length as usize).min(c.len());
			write_frame(s, kind::DATA, &c[start..end])
		}
		kind::CLOSE => {
			let req: CloseRequest = serde_json::from_slice(body).unwrap();
			if req.discard {
				if st.busy_discards > 0 {
					st.busy_discards -= 1;
					return error(s, code::BUSY);
				}
				st.handles.remove(&req.handle).expect("an open handle");
				return write_frame(s, kind::DONE, b"{}");
			}
			if st.busy_closes > 0 {
				st.busy_closes -= 1;
				return error(s, code::BUSY);
			}
			let open = st.handles.remove(&req.handle).expect("an open handle");
			let count = req.size.div_ceil(CHUNK) as usize;
			assert!(open.chunks.len() >= count, "the chunks do not make up the size");
			for (i, c) in open.chunks[..count].iter().enumerate() {
				let want = if i + 1 < count { CHUNK } else { req.size - (count as u64 - 1) * CHUNK };
				assert_eq!(c.len() as u64, want, "chunk {i} does not tile the size");
			}
			let content = open.chunks[..count].concat();
			if open.draft && !st.entries.contains_key(&open.path) {
				st.entries.insert(open.path.clone(), Node { folder: false, link: false, version: 1, content: Vec::new(), executable: false });
			}
			let n = st.entries.get(&open.path).cloned().expect("the file");
			if n.content != content {
				st.old.insert((open.path.clone(), version_of(&n)), n.content.clone());
				let e = st.entries.get_mut(&open.path).unwrap();
				e.content = content;
				e.version += 1;
			}
			let version = version_of(&st.entries[&open.path]);
			send_json(s, kind::DONE, &serde_json::json!({ "version": version }))
		}
		kind::MKDIR => {
			let req: PathRequest = serde_json::from_slice(body).unwrap();
			if st.entries.contains_key(&req.path) {
				return error(s, code::EXISTS);
			}
			if !folder(st, parent(&req.path)) {
				return error(s, code::NOT_FOUND);
			}
			st.entries.insert(req.path, Node { folder: true, link: false, version: 1, content: Vec::new(), executable: false });
			write_frame(s, kind::DONE, b"{}")
		}
		kind::UNLINK | kind::RMDIR => {
			let req: RemoveRequest = serde_json::from_slice(body).unwrap();
			let Some(n) = st.entries.get(&req.path).cloned() else { return error(s, code::NOT_FOUND) };
			if n.folder != (k == kind::RMDIR) {
				return error(s, if n.folder { code::NOT_A_FILE } else { code::NOT_A_FOLDER });
			}
			let prefix = format!("{}/", req.path);
			if n.folder && st.entries.keys().any(|p| p.starts_with(&prefix)) {
				return error(s, code::NOT_EMPTY);
			}
			st.entries.remove(&req.path);
			write_frame(s, kind::DONE, b"{}")
		}
		kind::RENAME => {
			let req: RenameRequest = serde_json::from_slice(body).unwrap();
			st.renames.push(req.clone());
			match rename(st, &req) {
				Ok(()) => write_frame(s, kind::DONE, b"{}"),
				Err(c) => error(s, c),
			}
		}
		kind::SYMLINK => {
			let req: SymlinkRequest = serde_json::from_slice(body).unwrap();
			if st.busy_links > 0 {
				st.busy_links -= 1;
				return error(s, code::BUSY);
			}
			if st.entries.contains_key(&req.path) {
				return error(s, code::EXISTS);
			}
			if !folder(st, parent(&req.path)) {
				return error(s, code::NOT_FOUND);
			}
			st.entries.insert(req.path, Node { folder: false, link: true, version: 1, content: req.target.into_bytes(), executable: false });
			send_json(s, kind::DONE, &serde_json::json!({ "version": "v1" }))
		}
		kind::LINK => {
			let req: LinkRequest = serde_json::from_slice(body).unwrap();
			st.links.push(req.clone());
			let Some(mut n) = st.entries.get(&req.from).cloned() else { return error(s, code::NOT_FOUND) };
			if n.folder {
				return error(s, code::NOT_PERMITTED);
			}
			// The new name gets what the source was at the version the machine showed, if the node still has it.
			if let Some(base) = req.from_base.as_ref().filter(|b| **b != version_of(&n)) {
				let Some(content) = st.old.get(&(req.from.clone(), base.clone())) else { return error(s, code::STALE) };
				n.content = content.clone();
			}
			if st.entries.contains_key(&req.to) {
				return error(s, code::EXISTS);
			}
			if !folder(st, parent(&req.to)) {
				return error(s, code::NOT_FOUND);
			}
			st.entries.insert(req.to, Node { version: 1, ..n });
			send_json(s, kind::DONE, &serde_json::json!({ "version": "v1" }))
		}
		kind::EXECUTABLE => {
			let req: ExecutableRequest = serde_json::from_slice(body).unwrap();
			let Some(n) = st.entries.get_mut(&req.path) else { return error(s, code::NOT_FOUND) };
			if n.executable != req.executable {
				n.executable = req.executable;
				n.version += 1;
			}
			let version = version_of(n);
			send_json(s, kind::DONE, &serde_json::json!({ "version": version }))
		}
		kind::PUBLISH => {
			st.publishes += 1;
			send_json(s, kind::REPORT, &Report {
				commit_id: Some("c".into()), seq: Some(st.seq), paths: Vec::new(),
				refused: st.unproven.then(|| "unproven".into()),
				closed: !st.unproven && serde_json::from_slice::<serde_json::Value>(body).unwrap()["final"].as_bool() == Some(true),
			})
		}
		_ => error(s, code::BAD_REQUEST),
	}
}
