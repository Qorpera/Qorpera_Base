//! A node stand-in for the folder program's tests: the folder protocol on a Unix socket, over a small tree
//! in memory that a test changes while machines watch it.

use qorpera_folder::frame::{kind, read_frame, write_frame};
use qorpera_folder::proto::{code, Change, Entry, EntryKind, ErrorReply, Hello, HelloOk, ListRequest, Listing, ReadRequest, Role};
use qorpera_folder::transport::Stream;
use std::collections::BTreeMap;
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub const PASS: &str = "right-pass";

#[derive(Clone)]
struct Node {
	folder: bool,
	version: u64,
	content: Vec<u8>,
	executable: bool,
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
		let dir = std::env::temp_dir().join(format!(
			"qorpera-folder-node-{}-{}",
			std::process::id(),
			std::time::UNIX_EPOCH.elapsed().unwrap().as_nanos()
		));
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
		let mut s = self.state.lock().unwrap();
		let mut changed = vec![path.to_string()];
		let mut p = parent(path);
		while !p.is_empty() {
			if !s.entries.contains_key(p) {
				s.entries.insert(p.to_string(), Node { folder: true, version: 1, content: Vec::new(), executable: false });
				changed.push(p.to_string());
			}
			p = parent(p);
		}
		if let Some(n) = s.entries.get(path).cloned() {
			s.old.insert((path.to_string(), format!("v{}", n.version)), n.content);
		}
		let version = s.entries.get(path).map_or(1, |n| n.version + 1);
		s.entries.insert(path.to_string(), Node { folder: false, version, content: content.as_bytes().to_vec(), executable });
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
		s.entries.insert(path.to_string(), Node { folder: false, version, content: content.as_bytes().to_vec(), executable: false });
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
		let ok = HelloOk { protocol: 1, view_id: hello.view_id.clone(), as_of_seq: st.seq, read_only: true };
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
							kind: if n.folder { EntryKind::Folder } else { EntryKind::File },
							size: n.content.len() as u64,
							mtime_ms: 1_700_000_000_000,
							executable: n.executable,
							version: format!("v{}", n.version),
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
			_ => error(&mut s, code::BAD_REQUEST),
		};
		drop(st);
		if result.is_err() {
			return;
		}
	}
}
