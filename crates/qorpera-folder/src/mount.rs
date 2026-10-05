//! The folder at a mount point inside a machine. Names and attributes come from folder listings the node sends on
//! demand; bytes come from the node as programs read them. The node's feed tells the program what changed, and the
//! kernel is told to drop exactly that. The kernel's page cache and this program's memory are the only caches: nothing
//! is written to the machine's disk.
//!
//! While the feed is down nothing is cached at all (every lookup asks the node), so a machine never
//! shows a version older than the node's.
//!
//! A lookup answered from what this program held just before a change can reach the kernel after the change's own
//! drop: the kernel does not find a name it is still making, and would keep the old name or version for the whole
//! TTL. So a change also drops every name such a lookup answered, again and again for a while (`chase`).
//!
//! A view the node lets write (protocol 2; deploy/first-node/RUNTIME-FOLDER-WRITES.md) is mounted read-write. Each
//! change goes to the node as it is made and stays pending in the view until a boundary publishes it: the node shows
//! this mount its own pending changes, other machines only what is published. A file open for writing keeps the one
//! chunk being written in memory (`writer.rs`), and the mount's version map (`versions.rs`) gives each save its base.
//! The kernel makes, moves and drops its own names for the changes it asks for, so a change made here only brings this
//! program's tree in step; the kernel is never told from inside a request (it holds the folder's lock then).

use crate::link::{Fail, Link};
use crate::proto::{code, join, valid_name, valid_path, EntryKind, OpenRequest, RenameRequest, MAX_READ};
use crate::tree::{Attr, Child, Inval, Tree, ROOT};
use crate::versions::VersionMap;
use crate::writer::Writer;
use fuser::{
	Config, Errno, FileAttr, FileHandle, FileType, Filesystem, FopenFlags, Generation, INodeNo, InitFlags,
	KernelConfig, LockOwner, MountOption, Notifier, OpenAccMode, OpenFlags, RenameFlags, ReplyAttr, ReplyCreate,
	ReplyData, ReplyDirectory, ReplyEmpty, ReplyEntry, ReplyOpen, ReplyStatfs, ReplyWrite, Request, SessionACL,
	TimeOrNow, WriteFlags,
};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// A raced name is dropped again at 1, 2, 4 … ms after its change, CHASE_STEPS times (the last about 16 s after it);
/// a lookup's answer counts as possibly not yet in the kernel for as long.
const CHASE_STEPS: u32 = 15;
const CHASE_WINDOW: Duration = Duration::from_millis(1 << (CHASE_STEPS - 1));
/// Answers remembered at most: past it, those older than the window go, and then the older half (a burst of lookups
/// never grows memory without end, and the newest, the ones that may still be in flight, stay).
const ANSWERED_MAX: usize = 1 << 16;

/// Names a lookup answered with a cacheable entry: the tree's change count it read them at, and when.
#[derive(Default)]
struct Answered {
	map: HashMap<(u64, String), (u64, Instant)>,
}

impl Answered {
	fn note(&mut self, dir: u64, name: &str, changes: u64, now: Instant) {
		if self.map.len() >= ANSWERED_MAX {
			self.map.retain(|_, (_, at)| now.duration_since(*at) < CHASE_WINDOW);
		}
		if self.map.len() >= ANSWERED_MAX {
			let mut times: Vec<Instant> = self.map.values().map(|(_, at)| *at).collect();
			times.sort_unstable();
			let cut = times[times.len() / 2];
			self.map.retain(|_, (_, at)| *at > cut);
		}
		self.map.insert((dir, name.to_string()), (changes, now));
	}

	/// The names in `inval` that a lookup answered from before the tree reached `changes`, lately enough that the
	/// answer may not have landed in the kernel yet.
	fn raced(&self, inval: &[Inval], changes: u64, now: Instant) -> Vec<(u64, String)> {
		inval
			.iter()
			.filter_map(|i| match i {
				Inval::Entry(parent, name) => Some((*parent, name.clone())),
				Inval::Inode(_) => None,
			})
			.filter(|key| {
				self.map.get(key).is_some_and(|(read, at)| *read < changes && now.duration_since(*at) < CHASE_WINDOW)
			})
			.collect()
	}
}

pub struct Options {
	pub mountpoint: PathBuf,
	pub threads: usize,
	/// How long the kernel may keep names and attributes while the feed is up.
	pub ttl: Duration,
	/// Let every account on the machine read the folder (a box's account, from step 2). Without it only the
	/// account that mounted it can, root included only if it mounted it.
	pub allow_other: bool,
	/// The folder the mount's version map is kept in (under /run/qorpera-folder/), so a program started again for the
	/// mount bases saves on what was read before; None keeps it in memory.
	pub state: Option<PathBuf>,
}

/// Why the program stopped.
#[derive(Debug)]
pub enum Stop {
	/// SIGTERM, SIGINT or SIGHUP.
	Signal(i32),
	/// The node closed the view (or never knew it).
	ViewClosed,
	/// The kernel ended the session (someone unmounted the folder).
	Ended(std::io::Result<()>),
}

enum Handle {
	Dir(Vec<(u64, FileType, String)>),
	File { ino: u64, path: String, version: String, size: u64 },
	/// Open for writing: the file's writer, which every handle writing it shares.
	Write { ino: u64, open: Arc<Mutex<Open>> },
}

/// A file open for writing in this mount: the node's handle and the one chunk in memory. Every handle that writes the
/// file shares it, as they would share its pages.
///
/// The kernel's release of a handle comes after the program's close returns, so the node closes the file at the close
/// (flush) of its last writing handle: a boundary asked for right after the close publishes it. A write that still comes
/// on that handle (a duplicated descriptor, a mapped page written back) opens the file at the node again.
struct Open {
	/// None once the node has closed the file.
	writer: Option<Writer>,
	/// Handles open on it for writing.
	handles: u32,
}

struct Shared {
	tree: Mutex<Tree>,
	link: Link,
	feed_up: AtomicBool,
	listing: Mutex<HashSet<u64>>,
	listed: Condvar,
	handles: Mutex<HashMap<u64, Handle>>,
	next_fh: AtomicU64,
	ttl: Duration,
	answered: Mutex<Answered>,
	/// The node lets this view write.
	writable: bool,
	/// Who the files show as owned by: the account that mounted the folder (a read-only view shows root).
	owner: (u32, u32),
	versions: Mutex<VersionMap>,
	/// Files open for writing, by inode.
	writing: Mutex<HashMap<u64, Arc<Mutex<Open>>>>,
}

impl Shared {
	fn ttl(&self, cacheable: bool) -> Duration {
		if cacheable && self.feed_up.load(Ordering::SeqCst) {
			self.ttl
		} else {
			Duration::ZERO
		}
	}

	/// A folder's entries: from memory, or from the node. One fetch per folder at a time; others wait
	/// for it. The flag says whether the answer may be cached by the kernel.
	fn children(&self, dir: u64, hold: Option<&str>) -> Result<(Vec<Child>, bool), i32> {
		loop {
			let (path, started) = {
				let mut tree = self.tree.lock().unwrap();
				let Some(path) = tree.path(dir).map(str::to_string) else { return Err(libc::ENOENT) };
				if tree.attr(dir).is_some_and(|a| a.kind == EntryKind::File) {
					return Err(libc::ENOTDIR);
				}
				if let Some(listing) = tree.listing(dir) {
					let listing = listing.to_vec();
					if let Some(c) = hold.and_then(|name| listing.iter().find(|c| c.name == name)) {
						tree.hold(c.ino);
						// Recorded under the tree's lock, so a change after this read always sees it.
						self.answer(dir, &c.name, tree.changes());
					}
					return Ok((listing, true));
				}
				(path, tree.changes())
			};
			{
				let mut busy = self.listing.lock().unwrap();
				if busy.contains(&dir) {
					while busy.contains(&dir) {
						busy = self.listed.wait(busy).unwrap();
					}
					continue;
				}
				busy.insert(dir);
			}
			let fetched = self.link.list(&path).map_err(|f| f.errno()).map(|entries| {
				let entries = entries.into_iter().filter(|e| valid_name(&e.name)).collect();
				let keep = self.feed_up.load(Ordering::SeqCst);
				let mut tree = self.tree.lock().unwrap();
				let (children, kept) = tree.install(dir, entries, started, keep, hold);
				if let Some(name) = hold.filter(|name| kept && children.iter().any(|c| c.name == *name)) {
					self.answer(dir, name, started);
				}
				(children, kept)
			});
			// Released only after the listing is in: a second fetch of this folder never overlaps the first's install.
			{
				self.listing.lock().unwrap().remove(&dir);
				self.listed.notify_all();
			}
			if let (true, Ok((children, kept))) = (debug(), &fetched) {
				eprintln!("qorpera-folder: listed {path:?}: {} entries, kept {kept}", children.len());
			}
			return fetched;
		}
	}

	/// Current attributes of a node: from memory, or by listing its folder again.
	fn attr(&self, ino: u64) -> Result<(Attr, bool), i32> {
		let (parent, name) = {
			let tree = self.tree.lock().unwrap();
			if let Some(a) = tree.attr(ino) {
				return Ok((a, true));
			}
			let (Some(parent), Some(path)) = (tree.parent(ino), tree.path(ino)) else { return Err(libc::ENOENT) };
			(parent, crate::proto::split(path).1.to_string())
		};
		let (children, kept) = self.children(parent, None)?;
		match children.into_iter().find(|c| c.name == name) {
			Some(c) if c.ino == ino => Ok((c.attr, kept)),
			// A newer version got its own inode and this one keeps its version (detached); a path that is gone
			// is gone.
			_ => self.tree.lock().unwrap().attr(ino).map(|a| (a, kept)).ok_or(libc::ENOENT),
		}
	}

	/// A lookup is about to answer `name` in `dir` from what the tree held at `changes` (called under the tree lock).
	fn answer(&self, dir: u64, name: &str, changes: u64) {
		self.answered.lock().unwrap().note(dir, name, changes, Instant::now());
	}

	/// The names a change's drops race (called under the tree lock, after the change, so no answer is noted between).
	/// A change that drops no name (the feed's heartbeat) looks at nothing.
	fn raced(&self, inval: &[Inval], changes: u64) -> Vec<(u64, String)> {
		if !inval.iter().any(|i| matches!(i, Inval::Entry(..))) {
			return Vec::new();
		}
		self.answered.lock().unwrap().raced(inval, changes, Instant::now())
	}

	fn handle(&self, h: Handle) -> FileHandle {
		let fh = self.next_fh.fetch_add(1, Ordering::SeqCst);
		self.handles.lock().unwrap().insert(fh, h);
		FileHandle(fh)
	}

	fn path_of(&self, ino: u64) -> Result<String, i32> {
		self.tree.lock().unwrap().path(ino).map(str::to_string).ok_or(libc::ENOENT)
	}

	/// The attributes the kernel gets: a file open for writing here is as long as its writer says.
	fn shown(&self, ino: u64, mut attr: Attr) -> Attr {
		let open = self.writing.lock().unwrap().get(&ino).cloned();
		if let Some(writer) = open.as_ref().and_then(|o| o.lock().unwrap().writer.as_ref().map(Writer::size)) {
			attr.size = writer;
		}
		attr
	}

	fn file_attr(&self, ino: u64, a: &Attr) -> FileAttr {
		let t = UNIX_EPOCH + Duration::from_millis(a.mtime_ms.max(0) as u64);
		let (kind, perm, size) = match (a.kind, self.writable) {
			(EntryKind::Folder, false) => (FileType::Directory, 0o555, 0),
			(EntryKind::File, false) => (FileType::RegularFile, if a.executable { 0o555 } else { 0o444 }, a.size),
			(EntryKind::Folder, true) => (FileType::Directory, 0o755, 0),
			(EntryKind::File, true) => (FileType::RegularFile, if a.executable { 0o755 } else { 0o644 }, a.size),
		};
		FileAttr {
			ino: INodeNo(ino),
			size,
			blocks: size.div_ceil(512),
			atime: t,
			mtime: t,
			ctime: t,
			crtime: t,
			kind,
			perm,
			nlink: if kind == FileType::Directory { 2 } else { 1 },
			uid: self.owner.0,
			gid: self.owner.1,
			rdev: 0,
			flags: 0,
			blksize: 128 * 1024,
		}
	}

	/// What a name in a folder shows now (listing the folder if need be).
	fn child(&self, dir: u64, name: &str) -> Result<Child, i32> {
		let (children, _) = self.children(dir, None)?;
		children.into_iter().find(|c| c.name == name).ok_or(libc::ENOENT)
	}

	/// Opens `ino` (at `path`, showing `attr`) for writing at the node, or joins the handles already writing it.
	fn open_write(&self, ino: u64, path: &str, attr: &Attr, truncate: bool) -> Result<Arc<Mutex<Open>>, i32> {
		// Held over the node's open, so two opens of one file never make two node handles.
		let mut writing = self.writing.lock().unwrap();
		if let Some(open) = writing.get(&ino).cloned() {
			let mut o = open.lock().unwrap();
			if truncate {
				self.writer(ino, &mut o)?.truncate(&self.link, 0).map_err(|f| f.errno())?;
			}
			o.handles += 1;
			drop(o);
			return Ok(open);
		}
		let base = self.versions.lock().unwrap().base(path);
		let opened = self
			.link
			.open_write(&OpenRequest { path: path.to_string(), base, create: false, exclusive: false, truncate })
			.map_err(|f| f.errno())?;
		let open = Arc::new(Mutex::new(Open { writer: Some(Writer::new(opened.handle, opened.size)), handles: 1 }));
		writing.insert(ino, open.clone());
		// The node's version of it now (a truncate made one at once), on the same inode.
		self.tree.lock().unwrap().set_local(ino, Attr { size: opened.size, version: opened.version, ..attr.clone() });
		Ok(open)
	}

	/// The file's writer, opening it at the node again if the node closed it (a write after its last close).
	fn writer<'a>(&self, ino: u64, open: &'a mut Open) -> Result<&'a mut Writer, i32> {
		if open.writer.is_none() {
			let path = self.path_of(ino)?;
			let base = self.versions.lock().unwrap().base(&path);
			let opened = self
				.link
				.open_write(&OpenRequest { path, base, create: false, exclusive: false, truncate: false })
				.map_err(|f| f.errno())?;
			open.writer = Some(Writer::new(opened.handle, opened.size));
		}
		Ok(open.writer.as_mut().expect("opened above"))
	}

	/// What is left goes to the node, which closes the file; the version it made is the version map's and the tree's.
	/// Errors are the program's to hear (a close).
	fn close_at_node(&self, ino: u64, open: &mut Open) -> Result<(), i32> {
		let Some(mut writer) = open.writer.take() else { return Ok(()) };
		let finished = writer.finish(&self.link);
		// After a chunk that could not be sent, the node's handle is closed at what reached it whole, never left open:
		// an open file is never published.
		let size = match &finished {
			Ok(size) => *size,
			Err(_) => writer.held_size(),
		};
		let version = self.link.close_write(writer.handle, size).map_err(|f| f.errno())?;
		let mut tree = self.tree.lock().unwrap();
		if let Some(path) = tree.path(ino).map(str::to_string) {
			self.versions.lock().unwrap().saved(&path, &version);
		}
		if let Some(attr) = tree.attr(ino) {
			tree.set_local(ino, Attr { size, version, mtime_ms: now_ms(), ..attr });
		}
		finished.map(|_| ()).map_err(|f| f.errno())
	}

	/// The last handle writing `ino` let go: the file is closed at the node if it is not yet, and no longer written here.
	fn close_write(&self, ino: u64, open: &Arc<Mutex<Open>>) {
		{
			let mut writing = self.writing.lock().unwrap();
			if writing.get(&ino).is_some_and(|o| Arc::ptr_eq(o, open)) {
				writing.remove(&ino);
			}
		}
		if let Err(e) = self.close_at_node(ino, &mut open.lock().unwrap()) {
			eprintln!("qorpera-folder: a file could not be closed at the node (errno {e})");
		}
	}
}

fn now_ms() -> i64 {
	SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// A name the folder may hold, or EINVAL.
fn name_of(name: &OsStr) -> Result<&str, Errno> {
	name.to_str().filter(|n| valid_name(n)).ok_or(Errno::EINVAL)
}

/// QORPERA_FOLDER_DEBUG=1 logs every listing fetched and every change applied.
fn debug() -> bool {
	static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
	*ON.get_or_init(|| std::env::var("QORPERA_FOLDER_DEBUG").as_deref() == Ok("1"))
}

fn file_type(kind: EntryKind) -> FileType {
	match kind {
		EntryKind::Folder => FileType::Directory,
		EntryKind::File => FileType::RegularFile,
	}
}

struct FolderFs {
	s: Arc<Shared>,
}

/// An errno from a failed call to the node.
fn errno(f: Fail) -> Errno {
	Errno::from_i32(f.errno())
}

impl FolderFs {
	/// A name this program changes: its folder's path and its own, or EROFS when the view does not write.
	fn place(&self, parent: INodeNo, name: &OsStr) -> Result<(String, String), Errno> {
		if !self.s.writable {
			return Err(Errno::EROFS);
		}
		let name = name_of(name)?;
		let dir = self.s.path_of(parent.0).map_err(Errno::from_i32)?;
		Ok((join(&dir, name), name.to_string()))
	}

	fn reply_attr(&self, ino: u64, reply: ReplyAttr) {
		match self.s.attr(ino) {
			Ok((a, kept)) => {
				let a = self.s.shown(ino, a);
				reply.attr(&self.s.ttl(kept), &self.s.file_attr(ino, &a))
			}
			Err(e) => reply.error(Errno::from_i32(e)),
		}
	}

	/// A file not open for writing here cut short or grown: opened at the node, its new end sent, closed.
	fn truncate_closed(&self, ino: u64, attr: &Attr, size: u64) -> Result<(), Errno> {
		let path = self.s.path_of(ino).map_err(Errno::from_i32)?;
		let base = self.s.versions.lock().unwrap().base(&path);
		let opened = self
			.s
			.link
			.open_write(&OpenRequest { path: path.clone(), base, create: false, exclusive: false, truncate: size == 0 })
			.map_err(errno)?;
		let mut writer = Writer::new(opened.handle, opened.size);
		let cut = writer.truncate(&self.s.link, size).and_then(|()| writer.finish(&self.s.link));
		let at = if cut.is_ok() { size } else { writer.held_size() };
		let version = self.s.link.close_write(opened.handle, at).map_err(errno)?;
		cut.map_err(errno)?;
		self.s.versions.lock().unwrap().saved(&path, &version);
		self.s.tree.lock().unwrap().set_local(ino, Attr { size, version, mtime_ms: now_ms(), ..attr.clone() });
		Ok(())
	}
}

impl Filesystem for FolderFs {
	fn init(&mut self, _req: &Request, config: &mut KernelConfig) -> std::io::Result<()> {
		let _ = config.set_max_readahead(MAX_READ);
		let _ = config.set_max_background(64);
		let _ = config.add_capabilities(InitFlags::FUSE_PARALLEL_DIROPS);
		if self.s.writable {
			// open(O_TRUNC) comes to `open` whole, so a truncating save is one node open, not a setattr and an open.
			let _ = config.add_capabilities(InitFlags::FUSE_ATOMIC_O_TRUNC);
		}
		eprintln!("qorpera-folder: kernel FUSE ABI {:?}", config.kernel_abi());
		Ok(())
	}

	fn lookup(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEntry) {
		let Some(name) = name.to_str().filter(|n| valid_name(n)) else { return reply.error(Errno::ENOENT) };
		match self.s.children(parent.0, Some(name)) {
			Ok((children, kept)) => match children.iter().find(|c| c.name == name) {
				Some(c) => {
					let a = self.s.shown(c.ino, c.attr.clone());
					reply.entry(&self.s.ttl(kept), &self.s.file_attr(c.ino, &a), Generation(0))
				}
				None => reply.error(Errno::ENOENT),
			},
			Err(e) => reply.error(Errno::from_i32(e)),
		}
	}

	fn forget(&self, _req: &Request, ino: INodeNo, nlookup: u64) {
		self.s.tree.lock().unwrap().forget(ino.0, nlookup);
	}

	fn getattr(&self, _req: &Request, ino: INodeNo, _fh: Option<FileHandle>, reply: ReplyAttr) {
		self.reply_attr(ino.0, reply);
	}

	fn opendir(&self, _req: &Request, ino: INodeNo, _flags: OpenFlags, reply: ReplyOpen) {
		let (children, _) = match self.s.children(ino.0, None) {
			Ok(r) => r,
			Err(e) => return reply.error(Errno::from_i32(e)),
		};
		let parent = self.s.tree.lock().unwrap().parent(ino.0).unwrap_or(ROOT);
		let mut entries = Vec::with_capacity(children.len() + 2);
		entries.push((ino.0, FileType::Directory, ".".to_string()));
		entries.push((parent, FileType::Directory, "..".to_string()));
		entries.extend(children.into_iter().map(|c| (c.ino, file_type(c.attr.kind), c.name)));
		// No kernel listing cache (FOPEN_CACHE_DIR): the kernel keeps it while the folder's time is unchanged, and a
		// folder's time does not change when a file inside it does. The listing is in this program's memory anyway.
		reply.opened(self.s.handle(Handle::Dir(entries)), FopenFlags::empty());
	}

	fn readdir(&self, _req: &Request, _ino: INodeNo, fh: FileHandle, offset: u64, mut reply: ReplyDirectory) {
		let handles = self.s.handles.lock().unwrap();
		let Some(Handle::Dir(entries)) = handles.get(&fh.0) else { return reply.error(Errno::EBADF) };
		for (i, (ino, kind, name)) in entries.iter().enumerate().skip(offset as usize) {
			if reply.add(INodeNo(*ino), (i + 1) as u64, *kind, name) {
				break;
			}
		}
		reply.ok();
	}

	fn releasedir(&self, _req: &Request, _ino: INodeNo, fh: FileHandle, _flags: OpenFlags, reply: ReplyEmpty) {
		self.s.handles.lock().unwrap().remove(&fh.0);
		reply.ok();
	}

	fn open(&self, _req: &Request, ino: INodeNo, flags: OpenFlags, reply: ReplyOpen) {
		let write = flags.acc_mode() != OpenAccMode::O_RDONLY;
		if write && !self.s.writable {
			return reply.error(Errno::EROFS);
		}
		let (attr, kept) = match self.s.attr(ino.0) {
			Ok(r) => r,
			Err(e) => return reply.error(Errno::from_i32(e)),
		};
		if attr.kind == EntryKind::Folder {
			return reply.error(Errno::EISDIR);
		}
		let path = match self.s.path_of(ino.0) {
			Ok(p) => p,
			Err(e) => return reply.error(Errno::from_i32(e)),
		};
		if write {
			return match self.s.open_write(ino.0, &path, &attr, flags.0 & libc::O_TRUNC != 0) {
				Ok(open) => reply.opened(self.s.handle(Handle::Write { ino: ino.0, open }), FopenFlags::empty()),
				Err(e) => reply.error(Errno::from_i32(e)),
			};
		}
		// Keep cached pages across opens while the feed is up and nothing writes the file here. They are this
		// version's only: a newer version is another inode (tree.rs), and this program's own saves are what was written
		// through this inode.
		let writing = self.s.writing.lock().unwrap().contains_key(&ino.0);
		let flags =
			if self.s.ttl(kept).is_zero() || writing { FopenFlags::empty() } else { FopenFlags::FOPEN_KEEP_CACHE };
		reply.opened(self.s.handle(Handle::File { ino: ino.0, path, version: attr.version, size: attr.size }), flags);
	}

	fn create(&self, _req: &Request, parent: INodeNo, name: &OsStr, mode: u32, umask: u32, flags: i32, reply: ReplyCreate) {
		let (path, name) = match self.place(parent, name) {
			Ok(p) => p,
			Err(e) => return reply.error(e),
		};
		let base = self.s.versions.lock().unwrap().base(&path);
		let request = OpenRequest {
			path: path.clone(),
			base,
			create: true,
			exclusive: flags & libc::O_EXCL != 0,
			truncate: flags & libc::O_TRUNC != 0,
		};
		let opened = match self.s.link.open_write(&request) {
			Ok(o) => o,
			Err(f) => return reply.error(errno(f)),
		};
		// A program that makes a file executable at create (a checkout, `cp` of a script) gets the bit at once.
		let mut attr =
			Attr { kind: EntryKind::File, size: opened.size, mtime_ms: now_ms(), executable: false, version: opened.version };
		if mode & !umask & 0o100 != 0 {
			match self.s.link.set_executable(&path, None, true) {
				Ok(version) => {
					attr.executable = true;
					attr.version = version;
				}
				Err(f) => {
					let _ = self.s.link.close_write(opened.handle, opened.size);
					return reply.error(errno(f));
				}
			}
		}
		let ino = self.s.tree.lock().unwrap().add_local(parent.0, &name, attr.clone());
		let open = Arc::new(Mutex::new(Open { writer: Some(Writer::new(opened.handle, opened.size)), handles: 1 }));
		self.s.writing.lock().unwrap().insert(ino, open.clone());
		let fh = self.s.handle(Handle::Write { ino, open });
		reply.created(&self.s.ttl(true), &self.s.file_attr(ino, &attr), Generation(0), fh, FopenFlags::empty());
	}

	fn read(
		&self,
		_req: &Request,
		_ino: INodeNo,
		fh: FileHandle,
		offset: u64,
		size: u32,
		_flags: OpenFlags,
		_lock_owner: Option<LockOwner>,
		reply: ReplyData,
	) {
		let (ino, file, written) = match self.s.handles.lock().unwrap().get(&fh.0) {
			Some(Handle::File { ino, path, version, size }) => (*ino, Some((path.clone(), version.clone(), *size)), None),
			Some(Handle::Write { ino, open }) => (*ino, None, Some(open.clone())),
			_ => return reply.error(Errno::EBADF),
		};
		// A file being written here reads as written, whichever handle reads it (once the node has closed it, it reads as
		// the version that close made).
		let writing = written.or_else(|| self.s.writing.lock().unwrap().get(&ino).cloned());
		if let Some(open) = writing {
			let mut o = open.lock().unwrap();
			if let Some(writer) = o.writer.as_mut() {
				let length = size.min(MAX_READ) as u64;
				return match writer.read(&self.s.link, offset, length) {
					Ok(data) => reply.data(&data),
					Err(f) => reply.error(errno(f)),
				};
			}
		}
		// An inode this program saved goes on as the version it saved (the same inode); any other is the version it
		// was opened at.
		let current = {
			let tree = self.s.tree.lock().unwrap();
			match (tree.path(ino), tree.attr(ino)) {
				(Some(p), Some(a)) if a.kind == EntryKind::File => Some((p.to_string(), a.version, a.size)),
				_ => None,
			}
		};
		let Some((path, version, file_size)) = current.or(file) else { return reply.error(Errno::EIO) };
		if offset >= file_size {
			return reply.data(&[]);
		}
		let len = (file_size - offset).min(size.min(MAX_READ) as u64) as u32;
		match self.s.link.read(&path, &version, offset, len) {
			Ok(data) => {
				// The version map: the newest version this mount read of the path, a save's base. A file still open from
				// before a newer version arrived reads an older one, which is not the newest seen.
				if self.s.writable && self.s.tree.lock().unwrap().current(ino) {
					self.s.versions.lock().unwrap().read(&path, &version);
				}
				reply.data(&data)
			}
			Err(f) => {
				if matches!(&f, Fail::Remote(e) if e.code == code::STALE) {
					// The file changed under this open file. Forget it here; the kernel hears from the
					// feed (telling it from inside a read could deadlock on the page being read).
					self.s.tree.lock().unwrap().invalidate([path.as_str()]);
				} else {
					eprintln!("qorpera-folder: read failed: {f}");
				}
				reply.error(errno(f))
			}
		}
	}

	fn write(
		&self,
		_req: &Request,
		_ino: INodeNo,
		fh: FileHandle,
		offset: u64,
		data: &[u8],
		_write_flags: WriteFlags,
		_flags: OpenFlags,
		_lock_owner: Option<LockOwner>,
		reply: ReplyWrite,
	) {
		let (ino, open) = match self.s.handles.lock().unwrap().get(&fh.0) {
			Some(Handle::Write { ino, open }) => (*ino, open.clone()),
			_ => return reply.error(Errno::EBADF),
		};
		let result = {
			let mut o = open.lock().unwrap();
			self.s
				.writer(ino, &mut o)
				.map_err(Errno::from_i32)
				.and_then(|w| w.write(&self.s.link, offset, data).map_err(errno))
		};
		match result {
			Ok(()) => reply.written(data.len() as u32),
			Err(e) => reply.error(e),
		}
	}

	/// Each close of a descriptor: what was written goes to the node, so a failure reaches the program's close. The
	/// last handle writing the file closes it at the node, so a boundary right after the close publishes it.
	fn flush(&self, _req: &Request, _ino: INodeNo, fh: FileHandle, _lock_owner: LockOwner, reply: ReplyEmpty) {
		let (ino, open) = match self.s.handles.lock().unwrap().get(&fh.0) {
			Some(Handle::Write { ino, open }) => (*ino, open.clone()),
			_ => return reply.ok(),
		};
		let mut o = open.lock().unwrap();
		let result = if o.handles == 1 {
			self.s.close_at_node(ino, &mut o).map_err(Errno::from_i32)
		} else {
			o.writer.as_mut().map_or(Ok(()), |w| w.flush(&self.s.link).map_err(errno))
		};
		match result {
			Ok(()) => reply.ok(),
			Err(e) => reply.error(e),
		}
	}

	/// What was written goes to the node; the file stays open (nothing is published until a boundary).
	fn fsync(&self, _req: &Request, _ino: INodeNo, fh: FileHandle, _datasync: bool, reply: ReplyEmpty) {
		let open = match self.s.handles.lock().unwrap().get(&fh.0) {
			Some(Handle::Write { open, .. }) => open.clone(),
			_ => return reply.ok(),
		};
		let result = open.lock().unwrap().writer.as_mut().map_or(Ok(()), |w| w.flush(&self.s.link));
		match result {
			Ok(()) => reply.ok(),
			Err(f) => reply.error(errno(f)),
		}
	}

	fn release(
		&self,
		_req: &Request,
		_ino: INodeNo,
		fh: FileHandle,
		_flags: OpenFlags,
		_lock_owner: Option<LockOwner>,
		_flush: bool,
		reply: ReplyEmpty,
	) {
		let handle = self.s.handles.lock().unwrap().remove(&fh.0);
		if let Some(Handle::Write { ino, open }) = handle {
			let last = {
				let mut o = open.lock().unwrap();
				o.handles -= 1;
				o.handles == 0
			};
			if last {
				self.s.close_write(ino, &open);
			}
		}
		reply.ok();
	}

	#[allow(clippy::too_many_arguments)]
	fn setattr(
		&self,
		_req: &Request,
		ino: INodeNo,
		mode: Option<u32>,
		uid: Option<u32>,
		gid: Option<u32>,
		size: Option<u64>,
		_atime: Option<TimeOrNow>,
		_mtime: Option<TimeOrNow>,
		_ctime: Option<SystemTime>,
		_fh: Option<FileHandle>,
		_crtime: Option<SystemTime>,
		_chgtime: Option<SystemTime>,
		_bkuptime: Option<SystemTime>,
		_flags: Option<fuser::BsdFileFlags>,
		reply: ReplyAttr,
	) {
		if !self.s.writable && (mode.is_some() || size.is_some() || uid.is_some() || gid.is_some()) {
			return reply.error(Errno::EROFS);
		}
		// The folder keeps no owners: the files are the mount's.
		if uid.is_some_and(|u| u != self.s.owner.0) || gid.is_some_and(|g| g != self.s.owner.1) {
			return reply.error(Errno::EPERM);
		}
		let attr = match self.s.attr(ino.0) {
			Ok((a, _)) => a,
			Err(e) => return reply.error(Errno::from_i32(e)),
		};
		if let Some(size) = size {
			if attr.kind == EntryKind::Folder {
				return reply.error(Errno::EISDIR);
			}
			let open = self.s.writing.lock().unwrap().get(&ino.0).cloned();
			let result = match open {
				Some(open) => {
					let mut o = open.lock().unwrap();
					self.s
						.writer(ino.0, &mut o)
						.map_err(Errno::from_i32)
						.and_then(|w| w.truncate(&self.s.link, size).map_err(errno))
				}
				None => self.truncate_closed(ino.0, &attr, size),
			};
			if let Err(e) = result {
				return reply.error(e);
			}
		}
		if let Some(mode) = mode {
			// The folder keeps the executable bit alone; other bits are the mount's.
			let executable = mode & 0o100 != 0;
			let current = self.s.attr(ino.0).map(|(a, _)| a).unwrap_or(attr);
			if current.kind == EntryKind::File && executable != current.executable {
				let path = match self.s.path_of(ino.0) {
					Ok(p) => p,
					Err(e) => return reply.error(Errno::from_i32(e)),
				};
				let base = self.s.versions.lock().unwrap().base(&path);
				match self.s.link.set_executable(&path, base, executable) {
					Ok(version) => {
						self.s.versions.lock().unwrap().saved(&path, &version);
						self.s.tree.lock().unwrap().set_local(ino.0, Attr { executable, version, ..current });
					}
					Err(f) => return reply.error(errno(f)),
				}
			}
		}
		// Times are the folder's: a `touch` of an existing file changes nothing, and is not an error.
		self.reply_attr(ino.0, reply);
	}

	fn mkdir(&self, _req: &Request, parent: INodeNo, name: &OsStr, _mode: u32, _umask: u32, reply: ReplyEntry) {
		let (path, name) = match self.place(parent, name) {
			Ok(p) => p,
			Err(e) => return reply.error(e),
		};
		if let Err(f) = self.s.link.mkdir(&path) {
			return reply.error(errno(f));
		}
		let attr = Attr { kind: EntryKind::Folder, size: 0, mtime_ms: now_ms(), executable: false, version: String::new() };
		let ino = self.s.tree.lock().unwrap().add_local(parent.0, &name, attr.clone());
		reply.entry(&self.s.ttl(true), &self.s.file_attr(ino, &attr), Generation(0));
	}

	fn unlink(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
		self.remove(parent, name, false, reply);
	}

	fn rmdir(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
		self.remove(parent, name, true, reply);
	}

	fn rename(
		&self,
		_req: &Request,
		parent: INodeNo,
		name: &OsStr,
		newparent: INodeNo,
		newname: &OsStr,
		flags: RenameFlags,
		reply: ReplyEmpty,
	) {
		// Exchanging two names has no unit of its own.
		if flags.intersects(RenameFlags::RENAME_EXCHANGE | RenameFlags::RENAME_WHITEOUT) {
			return reply.error(Errno::EINVAL);
		}
		let ((from, from_name), (to, _)) = match (self.place(parent, name), self.place(newparent, newname)) {
			(Ok(a), Ok(b)) => (a, b),
			(Err(e), _) | (_, Err(e)) => return reply.error(e),
		};
		// A move's base is the version the name showed; a file renamed over is a save of the target, based on the
		// version the mount holds for it.
		let source = match self.s.child(parent.0, &from_name) {
			Ok(c) => c,
			Err(e) => return reply.error(Errno::from_i32(e)),
		};
		let folder = source.attr.kind == EntryKind::Folder;
		let from_base = (!folder).then(|| source.attr.version.clone());
		let to_base = self.s.versions.lock().unwrap().base(&to);
		let request = RenameRequest {
			from: from.clone(),
			from_base,
			to: to.clone(),
			to_base,
			no_replace: flags.contains(RenameFlags::RENAME_NOREPLACE),
		};
		if let Err(f) = self.s.link.rename(&request) {
			return reply.error(errno(f));
		}
		self.s.versions.lock().unwrap().renamed(&from, &to, folder);
		self.s.tree.lock().unwrap().renamed_local(&from, &to, newparent.0);
		reply.ok();
	}

	fn mknod(&self, _req: &Request, _parent: INodeNo, _name: &OsStr, _mode: u32, _umask: u32, _rdev: u32, reply: ReplyEntry) {
		// The folder holds files and folders only.
		reply.error(if self.s.writable { Errno::EPERM } else { Errno::EROFS });
	}

	fn symlink(&self, _req: &Request, _parent: INodeNo, _link_name: &OsStr, _target: &Path, reply: ReplyEntry) {
		reply.error(if self.s.writable { Errno::EPERM } else { Errno::EROFS });
	}

	fn link(&self, _req: &Request, _ino: INodeNo, _newparent: INodeNo, _newname: &OsStr, reply: ReplyEntry) {
		reply.error(if self.s.writable { Errno::EPERM } else { Errno::EROFS });
	}

	fn statfs(&self, _req: &Request, _ino: INodeNo, reply: ReplyStatfs) {
		let files = self.s.tree.lock().unwrap().known() as u64;
		// Room is the company's, not this machine's: a writable mount says there is plenty, so programs that check
		// before they save do save; the node and the core refuse what does not fit.
		let (blocks, free) = if self.s.writable { (1 << 32, 1 << 31) } else { (0, 0) };
		reply.statfs(blocks, free, free, files, 0, 128 * 1024, 255, 128 * 1024);
	}
}

impl FolderFs {
	/// unlink and rmdir: the base is the version the name showed.
	fn remove(&self, parent: INodeNo, name: &OsStr, folder: bool, reply: ReplyEmpty) {
		let (path, name) = match self.place(parent, name) {
			Ok(p) => p,
			Err(e) => return reply.error(e),
		};
		let base = match self.s.child(parent.0, &name) {
			Ok(c) if folder && c.attr.kind != EntryKind::Folder => return reply.error(Errno::ENOTDIR),
			Ok(c) if !folder && c.attr.kind == EntryKind::Folder => return reply.error(Errno::EISDIR),
			Ok(c) => (!c.attr.version.is_empty()).then_some(c.attr.version),
			Err(e) => return reply.error(Errno::from_i32(e)),
		};
		let result = if folder { self.s.link.rmdir(&path, base) } else { self.s.link.unlink(&path, base) };
		if let Err(f) = result {
			return reply.error(errno(f));
		}
		self.s.versions.lock().unwrap().removed(&path);
		self.s.tree.lock().unwrap().removed_local(&path);
		reply.ok();
	}
}

fn tell_kernel(notifier: &Notifier, inval: Vec<Inval>) {
	for i in inval {
		let result = match &i {
			Inval::Inode(ino) => notifier.inval_inode(INodeNo(*ino), 0, 0),
			Inval::Entry(parent, name) => notifier.inval_entry(INodeNo(*parent), OsStr::new(name)),
		};
		// ENOENT: the kernel holds nothing for it, so there was nothing to drop.
		if let Err(e) = result {
			if e.raw_os_error() != Some(libc::ENOENT) {
				eprintln!("qorpera-folder: could not tell the kernel about {i:?}: {e}");
			}
		}
	}
}

/// Follows the node's feed until the view closes. Every (re)connection starts from a clean slate,
/// so nothing missed while the link was down is ever shown.
fn follow(
	s: Arc<Shared>,
	notifier: Notifier,
	mut feed: crate::link::Feed,
	stop: mpsc::Sender<Stop>,
	chased: mpsc::Sender<Vec<(u64, String)>>,
) {
	// Drops what a change names in the kernel, and has every name a lookup answered from before it dropped again.
	let apply = |inval: Vec<Inval>, raced: Vec<(u64, String)>| {
		tell_kernel(&notifier, inval);
		if !raced.is_empty() {
			let _ = chased.send(raced);
		}
	};
	let mut wait = Duration::from_secs(1);
	loop {
		loop {
			let change = match feed.next() {
				Ok(c) => c,
				Err(f) => {
					if f.view_closed() {
						let _ = stop.send(Stop::ViewClosed);
						return;
					}
					eprintln!("qorpera-folder: feed lost ({f}); nothing is cached until it is back");
					break;
				}
			};
			let (inval, raced) = {
				let mut tree = s.tree.lock().unwrap();
				let inval = if change.resync {
					tree.resync()
				} else if change.paths.is_empty() {
					Vec::new()
				} else {
					let paths: Vec<&str> = change.paths.iter().map(String::as_str).filter(|p| valid_path(p)).collect();
					tree.invalidate(paths)
				};
				let raced = s.raced(&inval, tree.changes());
				(inval, raced)
			};
			if debug() {
				eprintln!("qorpera-folder: change {} resync {} paths {:?}: {inval:?}", change.seq, change.resync, change.paths);
			}
			apply(inval, raced);
			if feed.ack(change.seq).is_err() {
				break;
			}
		}
		feed.close();
		s.feed_up.store(false, Ordering::SeqCst);
		let (inval, raced) = {
			let mut tree = s.tree.lock().unwrap();
			let inval = tree.resync();
			let raced = s.raced(&inval, tree.changes());
			(inval, raced)
		};
		apply(inval, raced);
		feed = loop {
			std::thread::sleep(wait);
			match s.link.open_feed() {
				Ok((f, ok)) => {
					wait = Duration::from_secs(1);
					eprintln!("qorpera-folder: feed back at change {}", ok.as_of_seq);
					// Anything fetched before this moment may be older than the feed's start.
					let (inval, raced) = {
						let mut tree = s.tree.lock().unwrap();
						let inval = tree.resync();
						let raced = s.raced(&inval, tree.changes());
						(inval, raced)
					};
					s.feed_up.store(true, Ordering::SeqCst);
					apply(inval, raced);
					break f;
				}
				Err(f) if f.view_closed() => {
					let _ = stop.send(Stop::ViewClosed);
					return;
				}
				Err(f) => {
					eprintln!("qorpera-folder: feed still down: {f}");
					wait = (wait * 2).min(Duration::from_secs(10));
				}
			}
		};
	}
}

/// Drops raced names from the kernel again at 1, 2, 4 … ms after their change, CHASE_STEPS times: a lookup answered
/// from before the change lands in the kernel within that, and the next drop after it removes what it made. A drop
/// of a name the kernel no longer holds does nothing.
fn chase(notifier: Notifier, names: mpsc::Receiver<Vec<(u64, String)>>) {
	let mut due: Vec<(Instant, u32, u64, String)> = Vec::new();
	loop {
		let next = due.iter().map(|d| d.0).min();
		let got = match next {
			Some(at) => names.recv_timeout(at.saturating_duration_since(Instant::now())),
			None => names.recv().map_err(|_| mpsc::RecvTimeoutError::Disconnected),
		};
		match got {
			Ok(batch) => {
				let at = Instant::now() + Duration::from_millis(1);
				due.extend(batch.into_iter().map(|(parent, name)| (at, 0, parent, name)));
			}
			Err(mpsc::RecvTimeoutError::Timeout) => {}
			Err(mpsc::RecvTimeoutError::Disconnected) => return,
		}
		let now = Instant::now();
		let mut later = Vec::with_capacity(due.len());
		for (at, step, parent, name) in due.drain(..) {
			if at > now {
				later.push((at, step, parent, name));
				continue;
			}
			tell_kernel(&notifier, vec![Inval::Entry(parent, name.clone())]);
			if step + 1 < CHASE_STEPS {
				later.push((now + Duration::from_millis(1 << step), step + 1, parent, name));
			}
		}
		due = later;
	}
}

/// Blocks the stop signals in this thread and every thread it starts, and returns the set to wait on.
fn block_stop_signals() -> libc::sigset_t {
	// SAFETY: plain libc calls on a local, zero-initialised signal set.
	unsafe {
		let mut set: libc::sigset_t = std::mem::zeroed();
		libc::sigemptyset(&mut set);
		for sig in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
			libc::sigaddset(&mut set, sig);
		}
		libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
		set
	}
}

/// Why the folder could not be served at all.
#[derive(Debug)]
pub enum Failed {
	/// The node closed or refused the view.
	View(String),
	Other(String),
}

/// Mounts the view and serves it until a signal, the view's end, or an unmount. Returns why it stopped.
pub fn run(link: Link, options: Options) -> Result<Stop, Failed> {
	let signals = block_stop_signals();
	// Open the feed before anything is listed, so no change after the first listing can be missed. This
	// also checks the view: a refused view never gets mounted.
	let (feed, ok) = link.open_feed().map_err(|f| {
		if f.view_closed() {
			Failed::View(f.to_string())
		} else {
			Failed::Other(format!("could not reach the node's folder service: {f}"))
		}
	})?;
	let writable = !ok.read_only;
	eprintln!(
		"qorpera-folder: view {} accepted at change {}, {}",
		ok.view_id,
		ok.as_of_seq,
		if writable { "read-write" } else { "read-only" }
	);
	// The version map outlives this program (and the node's service), as the buffers it protects do.
	let versions = match (&options.state, writable) {
		(Some(dir), true) => VersionMap::open(dir)
			.map_err(|e| Failed::Other(format!("the version map in {}: {e}", dir.display())))?,
		_ => VersionMap::memory(),
	};
	// SAFETY: geteuid and getegid have no preconditions.
	let owner = if writable { unsafe { (libc::geteuid(), libc::getegid()) } } else { (0, 0) };
	let shared = Arc::new(Shared {
		tree: Mutex::new(Tree::new()),
		link,
		feed_up: AtomicBool::new(true),
		listing: Mutex::new(HashSet::new()),
		listed: Condvar::new(),
		handles: Mutex::new(HashMap::new()),
		next_fh: AtomicU64::new(1),
		ttl: options.ttl,
		answered: Mutex::new(Answered::default()),
		writable,
		owner,
		versions: Mutex::new(versions),
		writing: Mutex::new(HashMap::new()),
	});
	let mut config = Config::default();
	config.mount_options = vec![
		if writable { MountOption::RW } else { MountOption::RO },
		MountOption::NoSuid,
		MountOption::NoDev,
		MountOption::NoAtime,
		MountOption::DefaultPermissions,
		MountOption::FSName("qorpera-company".into()),
		MountOption::Subtype("qorpera".into()),
	];
	config.acl = if options.allow_other { SessionACL::All } else { SessionACL::Owner };
	config.n_threads = Some(options.threads.max(1));
	config.clone_fd = true;
	let mut session = fuser::Session::new(FolderFs { s: shared.clone() }, &options.mountpoint, &config)
		.map_err(|e| Failed::Other(format!("mount {}: {e}", options.mountpoint.display())))?;
	let notifier = session.notifier();
	let mut unmount = session.unmount_callable();
	let (stop_tx, stop_rx) = mpsc::channel();
	{
		let stop = stop_tx.clone();
		std::thread::spawn(move || {
			let mut sig = 0;
			// SAFETY: waits on the set blocked above; writes only `sig`.
			unsafe { libc::sigwait(&signals, &mut sig) };
			let _ = stop.send(Stop::Signal(sig));
		});
	}
	{
		let stop = stop_tx.clone();
		std::thread::spawn(move || {
			let _ = stop.send(Stop::Ended(session.run()));
		});
	}
	{
		// A request connection refused after the view was accepted (the view closed meanwhile) ends the mount,
		// rather than leaving it mounted and failing every call.
		let stop = stop_tx.clone();
		shared.link.when_closed(move || {
			let _ = stop.send(Stop::ViewClosed);
		});
	}
	{
		let shared = shared.clone();
		let (chased, names) = mpsc::channel();
		let chaser = notifier.clone();
		std::thread::spawn(move || chase(chaser, names));
		std::thread::spawn(move || follow(shared, notifier, feed, stop_tx, chased));
	}
	eprintln!("qorpera-folder: mounted at {} with {} threads", options.mountpoint.display(), options.threads);
	let why = stop_rx.recv().map_err(|_| Failed::Other("every stop channel closed".into()))?;
	if !matches!(why, Stop::Ended(_)) {
		if let Err(e) = unmount.unmount() {
			eprintln!("qorpera-folder: unmount {}: {e}", options.mountpoint.display());
		}
	}
	Ok(why)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn a_change_races_only_the_names_answered_before_it_and_lately() {
		let mut answered = Answered::default();
		let t0 = Instant::now();
		answered.note(1, "a.md", 4, t0);
		answered.note(1, "b.md", 5, t0);
		answered.note(2, "a.md", 3, t0);
		let inval = vec![
			Inval::Inode(7),
			Inval::Entry(1, "a.md".into()),
			Inval::Entry(1, "b.md".into()),
			Inval::Entry(1, "c.md".into()),
		];
		// The change brought the tree to 5: a.md was read at 4 (before it), b.md at 5 (after), c.md never.
		assert_eq!(answered.raced(&inval, 5, t0), vec![(1, "a.md".to_string())]);
		// Past the window the answer has long landed, and the change's own drop finds it.
		assert!(answered.raced(&inval, 5, t0 + CHASE_WINDOW).is_empty());
	}

	#[test]
	fn a_full_record_keeps_its_newest_half() {
		let mut answered = Answered::default();
		let t0 = Instant::now();
		for i in 0..ANSWERED_MAX {
			answered.note(1, &format!("{i}"), 1, t0 + Duration::from_micros(i as u64));
		}
		let newest = format!("{}", ANSWERED_MAX - 1);
		answered.note(1, "next", 1, t0 + Duration::from_secs(1));
		assert!(answered.map.len() <= ANSWERED_MAX / 2 + 1);
		assert!(answered.map.contains_key(&(1, newest)) && answered.map.contains_key(&(1, "next".into())));
		assert!(!answered.map.contains_key(&(1, "0".into())));
	}
}
