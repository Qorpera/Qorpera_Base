//! The folder at a mount point inside a machine. Names and attributes come from folder listings the node sends on
//! demand; bytes come from the node as programs read them. The node's feed tells the program what changed, and the
//! kernel is told to drop exactly that. The kernel's page cache and this program's memory are the only caches of the
//! node's files: a writable view's own files on the machine's disk are never the node's (below).
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
//!
//! Git works in a writable view's code areas (`git.rs`; deploy/first-node/RUNTIME-FOLDER-CODING-MACHINES.md §6). The
//! session's own git settings and hooks, and the caches in its worktrees (`node_modules`, `target`, ...), are files
//! on the machine's disk that the node never sees (`local.rs`, `on_disk.rs`); git's shared files are asked for again
//! each time, and a lock git takes on one is the node's lease on it.

mod kernel;
mod on_disk;

use crate::link::{Fail, Link};
use crate::local::{self, Local};
use crate::proto::{
	code, join, valid_name, valid_path, EntryKind, LinkRequest, OpenRequest, RenameRequest, MAX_READ, MAX_TARGET,
};
use crate::tree::{Attr, Child, Inval, Tree, ROOT};
use crate::versions::VersionMap;
use crate::reads::ReadLog;
use crate::writer::Writer;
use fuser::{
	Config, Errno, FileAttr, FileHandle, FileType, Filesystem, FopenFlags, Generation, INodeNo, InitFlags,
	KernelConfig, LockOwner, MountOption, Notifier, OpenAccMode, OpenFlags, RenameFlags, ReplyAttr, ReplyCreate,
	ReplyData, ReplyDirectory, ReplyEmpty, ReplyEntry, ReplyOpen, ReplyStatfs, ReplyWrite, Request, SessionACL,
	TimeOrNow, WriteFlags,
};
use std::collections::{BTreeSet, HashMap, HashSet};
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
/// A create's entry and attributes, at the node or local, are not kept (`Kernel::close`): the kernel makes the inode
/// when it reads the reply, which may be after the end's drop, so the open's permission check (`DefaultPermissions`)
/// asks for them again, and after the end is refused: such a create opens nothing.
const CREATED: Duration = Duration::ZERO;

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
	/// Virtual ownership of writable files and folders; None uses the mounting account. Does not change the
	/// daemon's identity, its private view/state files, or access through allow_other. Read-only views stay root-owned.
	pub owner: Option<(u32, u32)>,
	/// The folder the mount's version map is kept in (under /run/qorpera-folder/), so a program started again for the
	/// mount bases saves on what was read before; None keeps it in memory.
	pub state: Option<PathBuf>,
	/// The read journal the caller already opened in `state` (the CLI does, to check the view proof). Only a writable
	/// view logs its reads: a read-only one hands none over, so its journal would never be emptied. None opens it here.
	pub reads: Option<Arc<ReadLog>>,
	/// Where a writable view keeps the session's own git files (`local.rs`), and its caches without `caches`; None uses
	/// `local/` in `state`. It should be on the machine's disk: caches grow large, and outlive the view.
	pub local: Option<PathBuf>,
	/// Where a writable view keeps its caches, on the machine's disk; the programs serving one owner's mounts on the
	/// machine share it. None keeps them in `local`, for this mount only.
	pub caches: Option<PathBuf>,
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
	/// Open for writing: the file's writer, which every handle writing it shares, and the process that opened the
	/// handle.
	Write { ino: u64, open: Arc<Mutex<Open>>, opener: u32 },
}

/// A file open for writing in this mount: the node's handle and the one chunk in memory. Every handle that writes the
/// file shares it, as they would share its pages.
///
/// The kernel's release of a handle comes after the program's close returns, so the node closes the file at the close
/// (flush) of its last writing handle by the process that opened it: a boundary asked for right after the close
/// publishes it. A write that still comes on that handle (a duplicated descriptor, a child that inherited it, a mapped
/// page written back) opens the file at the node again.
///
/// Each file's lock is held over the node's calls for it (its open, chunks and close), never the lock of the map of
/// open files: a slow call holds up that file alone.
struct Open {
	/// None while the node has the file closed, and while it is first opened there.
	writer: Option<Writer>,
	/// The writer of the node's last close of the file, with the version that close made: opened again at that
	/// version, it goes on from that writer, so its chunk in memory is not read back.
	closed: Option<(String, Writer)>,
	/// Handles open on it for writing.
	handles: u32,
}

impl Open {
	fn new() -> Arc<Mutex<Open>> {
		Arc::new(Mutex::new(Open { writer: None, closed: None, handles: 0 }))
	}
}

/// The files this view made that no boundary has published, by path: one renamed into a cache moves there and leaves
/// the view's changes (`mount/on_disk.rs`), as it takes nothing from the folder. A file is noted before the node makes
/// it (`create`, a cache's file renamed onto a new name), so a change the feed tells of its path after (a boundary
/// that published it, another view's change) always takes it off again. It moves with the node's renames of it, but
/// not with its folder's (the version map forgets what a folder's move takes along, `VersionMap::renamed`), and a lost
/// feed takes all off.
#[derive(Default)]
struct Unpublished(BTreeSet<String>);

impl Unpublished {
	/// Notes `path`: whether it was not noted.
	fn note(&mut self, path: &str) -> bool {
		self.0.insert(path.to_string())
	}

	/// Takes `path`, and all noted below it, off.
	fn forget(&mut self, path: &str) {
		self.0.remove(path);
		for p in self.below(path) {
			self.0.remove(&p);
		}
	}

	/// The paths noted below the folder `path`.
	fn below(&self, path: &str) -> Vec<String> {
		let prefix = format!("{path}/");
		self.0.range(prefix.clone()..).take_while(|p| p.starts_with(&prefix)).cloned().collect()
	}

	/// Before the node renames `from` to `to` (a folder when `folder`; `fresh` when the node has nothing at `to`): a
	/// noted file is noted at `to` too. Whether `to` stays noted (`renamed`), and whether it is noted now, which a rename
	/// the node refuses takes off again.
	fn renaming(&mut self, from: &str, to: &str, folder: bool, fresh: bool) -> (bool, bool) {
		// Over a file the folder has, it is a save of that file.
		let stays = !folder && self.0.contains(from) && (fresh || self.0.contains(to));
		(stays, stays && self.note(to))
	}

	/// The node renamed `from` to `to` (`renaming`).
	fn renamed(&mut self, from: &str, to: &str, folder: bool, stays: bool) {
		if folder {
			self.forget(from);
			self.forget(to);
		}
		self.0.remove(from);
		if !stays {
			self.0.remove(to);
		}
	}
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
	/// Virtual owner: the explicit owner or the mounting account (a read-only view shows root).
	owner: (u32, u32),
	versions: Mutex<VersionMap>,
	/// Files open for writing, by inode. Held only to look one up, add or remove it: never while a file's own lock is
	/// waited for (the order is a file's lock, then this map).
	writing: Mutex<HashMap<u64, Arc<Mutex<Open>>>>,
	/// A writable view's own git files and caches on the machine's disk (`on_disk.rs`); None for a read-only view,
	/// which shows the node's copy of every path.
	local: Option<Local>,
	/// The company's code host (`HelloOk::code_host`): git's session-local files are the node's, published like any.
	code_host: bool,
	/// Names the kernel took from a request answered here, dropped again as a change's raced names are (`chase`): the
	/// target of a rename across the edge between the caches and the folder (`mount/on_disk.rs`).
	chased: mpsc::Sender<Vec<(u64, String)>>,
	unpublished: Mutex<Unpublished>,
	/// The kernel's cache of the caches, and the other programs sharing them (`mount/kernel.rs`).
	kernel: kernel::Kernel,
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
				if tree.attr(dir).is_some_and(|a| a.kind != EntryKind::Folder) {
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
			// A link's mode is the folder's, as on a disk; its size is its target's length.
			(EntryKind::Symlink, _) => (FileType::Symlink, 0o777, a.size),
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

	/// Remember a version read through its inode, unless a local save or rename changed what that inode stands for.
	/// A detached older version counts only when no newer read or save is already remembered for the path.
	fn read_version(&self, ino: u64, path: &str, version: &str) {
		if !self.writable {
			return;
		}
		let tree = self.tree.lock().unwrap();
		let mut versions = self.versions.lock().unwrap();
		let its = tree.path(ino) == Some(path) && tree.last_seen(ino).is_some_and(|a| a.version == version);
		if its && (tree.current(ino) || (!tree.removed_here(ino) && versions.get(path).is_none())) {
			versions.read(path, version);
		}
	}

	/// Opens `ino` (at `path`, showing `attr`) for writing at the node, or joins the handles already writing it (or a
	/// file whose close the node has not taken yet). Only this file's lock is held over the node's open: two opens of it
	/// never make two node handles, and nothing else waits.
	fn open_write(&self, ino: u64, path: &str, attr: &Attr, truncate: bool) -> Result<Arc<Mutex<Open>>, i32> {
		loop {
			let open = self.writing.lock().unwrap().entry(ino).or_insert_with(Open::new).clone();
			let mut o = open.lock().unwrap();
			if !self.writes(ino, &open) {
				// Closed and let go meanwhile, or its first open failed: start again.
				continue;
			}
			if o.handles > 0 || o.writer.is_some() {
				if truncate {
					self.writer(ino, &mut o)?.truncate(&self.link, 0).map_err(|f| f.errno())?;
				}
				o.handles += 1;
				drop(o);
				return Ok(open);
			}
			let base = self.versions.lock().unwrap().base(path);
			let request = OpenRequest { path: path.to_string(), base, create: false, exclusive: false, truncate, draft: false };
			let opened = match self.link.open_write(&request) {
				Ok(opened) => opened,
				Err(f) => {
					self.let_go(ino, &open);
					return Err(f.errno());
				}
			};
			o.writer = Some(Writer::new(opened.handle, opened.size));
			o.handles = 1;
			// The node's version of it now (a truncate made one at once), on the same inode; before the file's lock goes,
			// so a close through another handle never sees its version taken back.
			self.tree.lock().unwrap().set_local(ino, Attr { size: opened.size, version: opened.version, ..attr.clone() });
			drop(o);
			return Ok(open);
		}
	}

	/// Whether `open` is what the map holds for `ino` (called with the file's lock held).
	fn writes(&self, ino: u64, open: &Arc<Mutex<Open>>) -> bool {
		self.writing.lock().unwrap().get(&ino).is_some_and(|o| Arc::ptr_eq(o, open))
	}

	/// The file is no longer written here (called with its lock held, no handle on it and the node's closed).
	fn let_go(&self, ino: u64, open: &Arc<Mutex<Open>>) {
		let mut writing = self.writing.lock().unwrap();
		if writing.get(&ino).is_some_and(|o| Arc::ptr_eq(o, open)) {
			writing.remove(&ino);
		}
	}

	/// The file's writer, opening it at the node again if the node closed it (a write after its last close). Opened
	/// again at the version that close made, it goes on from the writer it closed.
	fn writer<'a>(&self, ino: u64, open: &'a mut Open) -> Result<&'a mut Writer, i32> {
		if open.writer.is_none() {
			let path = {
				let tree = self.tree.lock().unwrap();
				// A file this mount removed, or replaced, since takes no more writes: its path holds another file now, or
				// none. (One a newer version from the node replaced is still that path's file: a log published while a
				// program that inherited its descriptor is quiet; the base tells the node which version it was.)
				if tree.removed_here(ino) {
					return Err(libc::ESTALE);
				}
				tree.path(ino).map(str::to_string).ok_or(libc::ENOENT)?
			};
			let base = self.versions.lock().unwrap().base(&path);
			let opened = self
				.link
				.open_write(&OpenRequest { path, base, create: false, exclusive: false, truncate: false, draft: false })
				.map_err(|f| f.errno())?;
			open.writer = Some(match open.closed.take() {
				Some((version, w)) if version == opened.version && w.size() == opened.size => w.reopened(opened.handle),
				_ => Writer::new(opened.handle, opened.size),
			});
		}
		Ok(open.writer.as_mut().expect("opened above"))
	}

	/// What is left goes to the node, which closes the file; the version it made is the version map's and the tree's.
	/// When the node does not take it, the writer stays, with its chunk in memory, for the next try: the node's handle is
	/// never closed at a size the program did not write.
	fn close_at_node(&self, ino: u64, open: &mut Open) -> Result<(), Fail> {
		let Some(writer) = open.writer.as_mut() else { return Ok(()) };
		let size = writer.finish(&self.link)?;
		let version = self.link.close_write(writer.handle, size)?;
		let writer = open.writer.take().expect("held above");
		{
			let mut tree = self.tree.lock().unwrap();
			// Only for the file its path shows: one removed, or renamed over, while open saved a version no path has.
			if tree.current(ino) {
				if let Some(path) = tree.path(ino) {
					self.versions.lock().unwrap().saved(path, &version);
				}
				// Known again if a change had made them unknown: the path shows this mount's pending file.
				if let Some(attr) = tree.last_seen(ino) {
					tree.set_local(ino, Attr { size, version: version.clone(), mtime_ms: now_ms(), ..attr });
				}
			}
		}
		open.closed = Some((version, writer));
		Ok(())
	}

	/// A handle writing `ino` let go. The last one closes the file at the node, and the file is no longer written here.
	/// A close the node does not take now (BUSY while a boundary settles, the link down, the company paused) is tried
	/// again until it does, so the node's handle is never left open; a handle opened on the file meanwhile takes it
	/// over.
	fn leave(self: &Arc<Self>, ino: u64, open: Arc<Mutex<Open>>) {
		{
			let mut o = open.lock().unwrap();
			o.handles -= 1;
			if o.handles > 0 {
				return;
			}
		}
		let Err(f) = self.try_close(ino, &open) else { return };
		eprintln!("qorpera-folder: the node did not take a file's close now ({f}); trying again");
		let s = self.clone();
		std::thread::spawn(move || {
			let mut wait = Duration::from_millis(100);
			loop {
				std::thread::sleep(wait);
				if s.try_close(ino, &open).is_ok() {
					return;
				}
				wait = (wait * 2).min(Duration::from_secs(10));
			}
		});
	}

	/// One try at closing a file no handle writes at the node. Ok once nothing more is to be done: it closed, a new
	/// handle took it over, or the node will never take the close (it no longer knows the handle, or the view closed;
	/// what it holds of the file then goes when the view's connections end).
	fn try_close(&self, ino: u64, open: &Arc<Mutex<Open>>) -> Result<(), Fail> {
		let mut o = open.lock().unwrap();
		if o.handles > 0 {
			return Ok(());
		}
		match self.close_at_node(ino, &mut o) {
			Ok(()) => {}
			Err(f) if again(&f) => return Err(f),
			Err(f) => {
				eprintln!("qorpera-folder: a file could not be closed at the node: {f}");
				o.writer = None;
			}
		}
		self.let_go(ino, open);
		Ok(())
	}

	/// `f`, run while the node's file `ino` is not open for writing here, and no open of it for writing starts (its lock
	/// held, as `open_write` takes it): EXDEV while it is. A handle whose close the node has taken (the opener's close
	/// before the kernel's release) writes no more unless a write comes on it after all, which then finds what `f` left.
	fn unwritten<T>(&self, ino: u64, f: impl FnOnce() -> Result<T, i32>) -> Result<T, i32> {
		loop {
			let open = self.writing.lock().unwrap().entry(ino).or_insert_with(Open::new).clone();
			let o = open.lock().unwrap();
			if !self.writes(ino, &open) {
				continue;
			}
			// Open for writing, or a close the node has not taken yet (`leave`).
			if o.writer.is_some() {
				return Err(libc::EXDEV);
			}
			let done = f();
			if o.handles == 0 {
				self.let_go(ino, &open);
			}
			return done;
		}
	}

	/// Gives up the node's handle of a draft not written whole: it leaves nothing in the view. Tried again while the
	/// node does not take it now (`again`), as a close is (`leave`).
	fn give_up(self: &Arc<Self>, handle: u32) {
		let Err(f) = self.link.discard_write(handle) else { return };
		if !again(&f) {
			return;
		}
		eprintln!("qorpera-folder: the node did not take a draft's discard now ({f}); trying again");
		let s = self.clone();
		std::thread::spawn(move || {
			let mut wait = Duration::from_millis(100);
			loop {
				std::thread::sleep(wait);
				match s.link.discard_write(handle) {
					Err(f) if again(&f) => wait = (wait * 2).min(Duration::from_secs(10)),
					_ => return,
				}
			}
		});
	}
}

/// A failure the node may get past: a request it could not take now.
fn again(f: &Fail) -> bool {
	match f {
		Fail::Link(_) => true,
		Fail::Remote(e) => [code::BUSY, code::UNAVAILABLE, code::DENIED].contains(&e.code.as_str()),
	}
}

/// The process a request came from. The kernel names the thread; a process's threads open and close its files alike.
/// The thread itself when /proc does not say.
fn process_of(thread: u32) -> u32 {
	std::fs::read_to_string(format!("/proc/{thread}/status"))
		.ok()
		.and_then(|status| status.lines().find_map(|l| l.strip_prefix("Tgid:")).and_then(|t| t.trim().parse().ok()))
		.unwrap_or(thread)
}

fn now_ms() -> i64 {
	SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// A name the folder may hold, or EINVAL.
fn name_of(name: &OsStr) -> Result<&str, Errno> {
	name.to_str().filter(|n| valid_name(n)).ok_or(Errno::EINVAL)
}

/// In a git object store: `objects` or below it, in a repository's `.git` or a bare one's `<name>.git` (a code area's
/// `repo.git` too: the rule of 5d's `git::object`, for every repository). Git checks that a hard link there is the
/// source's own inode, which a new name here never is (RUNTIME-FOLDER-LINKS.md "Git").
fn git_objects(path: &str) -> bool {
	let mut rest = path;
	while let Some((name, below)) = rest.split_once('/') {
		if name.ends_with(".git") && (below == "objects" || below.starts_with("objects/")) {
			return true;
		}
		rest = below;
	}
	false
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
		EntryKind::Symlink => FileType::Symlink,
	}
}

struct FolderFs {
	s: Arc<Shared>,
}

/// An errno from a failed call to the node.
fn errno(f: Fail) -> Errno {
	Errno::from_i32(f.errno())
}

/// A reply refused once the program is ending (`FolderFs::served`).
trait Refuse {
	fn refuse(self);
}

macro_rules! refuse {
	($($reply:ty),*) => {$(
		impl Refuse for $reply {
			fn refuse(self) {
				self.error(Errno::EIO)
			}
		}
	)*};
}

refuse!(ReplyAttr, ReplyCreate, ReplyData, ReplyDirectory, ReplyEmpty, ReplyEntry, ReplyOpen, ReplyStatfs, ReplyWrite);

impl FolderFs {
	/// The reply to answer, or none once the program is ending: then it is refused with EIO here, before the request
	/// takes any lock, while the kernel drops its pages (`Kernel::close`).
	fn served<R: Refuse>(&self, reply: R) -> Option<R> {
		if self.s.kernel.closing() {
			reply.refuse();
			return None;
		}
		Some(reply)
	}

	/// `served`, after noting that the kernel may keep `ino`'s pages or attributes from this answer on (an open or a
	/// create). An answer it lets through was noted before the refusals began, so the end's drop has its inode.
	fn noted<R: Refuse>(&self, ino: u64, reply: R) -> Option<R> {
		self.s.kernel.opened(ino);
		self.served(reply)
	}

	/// A name this program changes: its folder's path and its own, or EROFS when the view does not write. A local
	/// folder has no path at the node (its `local_*` hook answers for every name in it).
	fn place(&self, parent: INodeNo, name: &OsStr) -> Result<(String, String), Errno> {
		if !self.s.writable {
			return Err(Errno::EROFS);
		}
		let name = name_of(name)?;
		if local::is_local(parent.0) {
			return Ok((String::new(), name.to_string()));
		}
		let dir = self.s.path_of(parent.0).map_err(Errno::from_i32)?;
		Ok((join(&dir, name), name.to_string()))
	}

	fn reply_attr(&self, ino: u64, reply: ReplyAttr) {
		match self.s.attr(ino) {
			Ok((a, kept)) => {
				let a = self.s.shown(ino, a);
				let ttl = if self.s.fresh(ino) { Duration::ZERO } else { self.s.ttl(kept) };
				reply.attr(&ttl, &self.s.file_attr(ino, &a))
			}
			Err(e) => reply.error(Errno::from_i32(e)),
		}
	}

	/// A file cut short or grown (`truncate`, `ftruncate`): as through a writing handle of its own, which closes the file
	/// at the node after unless another handle still writes it. A cut to nothing is the node's, at the open.
	fn resize(&self, ino: u64, attr: &Attr, size: u64) -> Result<(), Errno> {
		let path = self.s.path_of(ino).map_err(Errno::from_i32)?;
		let open = self.s.open_write(ino, &path, attr, size == 0).map_err(Errno::from_i32)?;
		let cut = if size == 0 {
			Ok(())
		} else {
			let mut o = open.lock().unwrap();
			self.s.writer(ino, &mut o).map_err(Errno::from_i32).and_then(|w| w.truncate(&self.s.link, size).map_err(errno))
		};
		self.s.leave(ino, open);
		cut
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
		self.s.kernel.init(config);
		Ok(())
	}

	fn lookup(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEntry) {
		let Some(reply) = self.served(reply) else { return };
		let Some(name) = name.to_str().filter(|n| valid_name(n)) else { return reply.error(Errno::ENOENT) };
		let Some(reply) = self.local_lookup(parent.0, name, reply) else { return };
		self.s.may_answer_top(parent.0, name);
		match self.s.children(parent.0, Some(name)) {
			Ok((children, kept)) => match children.iter().find(|c| c.name == name) {
				Some(c) => {
					let a = self.s.shown(c.ino, c.attr.clone());
					let ttl = if self.s.fresh(c.ino) { Duration::ZERO } else { self.s.ttl(kept) };
					reply.entry(&ttl, &self.s.file_attr(c.ino, &a), Generation(0))
				}
				None => {
					if let Some(reply) = self.cache_lookup(parent.0, name, reply) {
						reply.error(Errno::ENOENT)
					}
				}
			},
			Err(e) => reply.error(Errno::from_i32(e)),
		}
	}

	fn forget(&self, _req: &Request, ino: INodeNo, nlookup: u64) {
		if local::is_local(ino.0) {
			self.s.kernel.forget(ino.0, nlookup);
		}
		self.s.tree.lock().unwrap().forget(ino.0, nlookup);
	}

	fn getattr(&self, _req: &Request, ino: INodeNo, fh: Option<FileHandle>, reply: ReplyAttr) {
		let Some(reply) = self.served(reply) else { return };
		let Some(reply) = self.local_getattr(ino.0, fh.map(|fh| fh.0), reply) else { return };
		self.reply_attr(ino.0, reply);
	}

	fn opendir(&self, _req: &Request, ino: INodeNo, _flags: OpenFlags, reply: ReplyOpen) {
		let Some(reply) = self.served(reply) else { return };
		let Some(reply) = self.noted(ino.0, reply) else { return };
		let Some(reply) = self.local_opendir(ino.0, reply) else { return };
		let (children, _) = match self.s.children(ino.0, None) {
			Ok(r) => r,
			Err(e) => return reply.error(Errno::from_i32(e)),
		};
		let (attr, _) = match self.s.attr(ino.0) {
			Ok(attr) => attr,
			Err(e) => return reply.error(Errno::from_i32(e)),
		};
		let path = match self.s.path_of(ino.0) {
			Ok(path) => path,
			Err(e) => return reply.error(Errno::from_i32(e)),
		};
		if let Err(e) = self.s.link.record_read(&path, None, attr.authority.as_ref()) {
			eprintln!("qorpera-folder: could not record a directory read: {e}");
			return reply.error(Errno::EIO);
		}
		let parent = self.s.tree.lock().unwrap().parent(ino.0).unwrap_or(ROOT);
		let mut entries = Vec::with_capacity(children.len() + 2);
		entries.push((ino.0, FileType::Directory, ".".to_string()));
		entries.push((parent, FileType::Directory, "..".to_string()));
		entries.extend(children.into_iter().map(|c| (c.ino, file_type(c.attr.kind), c.name)));
		if let Err(e) = self.merge_local(ino.0, &path, &mut entries) {
			return reply.error(Errno::from_i32(e));
		}
		// No kernel listing cache (FOPEN_CACHE_DIR): the kernel keeps it while the folder's time is unchanged, and a
		// folder's time does not change when a file inside it does. The listing is in this program's memory anyway.
		reply.opened(self.s.handle(Handle::Dir(entries)), FopenFlags::empty());
	}

	fn readdir(&self, _req: &Request, _ino: INodeNo, fh: FileHandle, offset: u64, reply: ReplyDirectory) {
		let Some(mut reply) = self.served(reply) else { return };
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
		let Some(reply) = self.served(reply) else { return };
		self.s.handles.lock().unwrap().remove(&fh.0);
		reply.ok();
	}

	fn open(&self, req: &Request, ino: INodeNo, flags: OpenFlags, reply: ReplyOpen) {
		let Some(reply) = self.served(reply) else { return };
		let Some(reply) = self.noted(ino.0, reply) else { return };
		// O_RDONLY with O_TRUNC cuts the file too (the kernel leaves the cut to `open` here, FUSE_ATOMIC_O_TRUNC).
		let write = flags.acc_mode() != OpenAccMode::O_RDONLY || flags.0 & libc::O_TRUNC != 0;
		if write && !self.s.writable {
			return reply.error(Errno::EROFS);
		}
		let Some(reply) = self.local_open(ino.0, flags.0, write, reply) else { return };
		// One this program moved into a cache, by the name the kernel moved it to: the kernel looks that up again, and
		// finds the cache's file (the chase has it drop the name soon after).
		if self.s.tree.lock().unwrap().in_cache(ino.0) {
			return reply.error(Errno::ESTALE);
		}
		let (attr, kept) = match self.s.attr(ino.0) {
			Ok(r) => r,
			Err(e) => return reply.error(Errno::from_i32(e)),
		};
		match attr.kind {
			EntryKind::Folder => return reply.error(Errno::EISDIR),
			// The kernel follows a link before it opens; one that reaches here is opened without following it.
			EntryKind::Symlink => return reply.error(Errno::ELOOP),
			EntryKind::File => {}
		}
		let path = match self.s.path_of(ino.0) {
			Ok(p) => p,
			Err(e) => return reply.error(Errno::from_i32(e)),
		};
		if let Err(e) = self.s.link.record_read(&path, Some(&attr.version), attr.authority.as_ref()) {
			eprintln!("qorpera-folder: could not record a file open: {e}");
			return reply.error(Errno::EIO);
		}
		if write {
			return match self.s.open_write(ino.0, &path, &attr, flags.0 & libc::O_TRUNC != 0) {
				Ok(open) => {
					let handle = Handle::Write { ino: ino.0, open, opener: process_of(req.pid()) };
					reply.opened(self.s.handle(handle), FopenFlags::empty())
				}
				Err(e) => reply.error(Errno::from_i32(e)),
			};
		}
		// Keep cached pages across opens while the feed is up and nothing writes the file here. They are this
		// version's only: a newer version is another inode (tree.rs), and this program's own saves are what was written
		// through this inode.
		let writing = self.s.writing.lock().unwrap().contains_key(&ino.0);
		// The kernel can answer EOF for an empty file without sending a read. Its empty content is already known at
		// this read-only open, so remember that version before a later writer or feed change can replace it. A file
		// being written here instead reads from its writer; its listed size may not describe those bytes.
		if attr.size == 0 && !writing {
			self.s.read_version(ino.0, &path, &attr.version);
		}
		let fresh = self.s.ttl(kept).is_zero() || self.s.fresh(ino.0);
		let flags = if fresh || writing { FopenFlags::empty() } else { FopenFlags::FOPEN_KEEP_CACHE };
		reply.opened(self.s.handle(Handle::File { ino: ino.0, path, version: attr.version, size: attr.size }), flags);
	}

	fn create(&self, req: &Request, parent: INodeNo, name: &OsStr, mode: u32, umask: u32, flags: i32, reply: ReplyCreate) {
		let Some(reply) = self.served(reply) else { return };
		let (path, name) = match self.place(parent, name) {
			Ok(p) => p,
			Err(e) => return reply.error(e),
		};
		let Some(reply) = self.local_create(parent.0, &name, mode & !umask, flags, reply) else { return };
		let base = self.s.versions.lock().unwrap().base(&path);
		let request = OpenRequest {
			path: path.clone(),
			base,
			create: true,
			exclusive: flags & libc::O_EXCL != 0,
			truncate: flags & libc::O_TRUNC != 0,
			draft: false,
		};
		// A new file, where the folder's listing has none: this view's own until a boundary publishes it (`Unpublished`).
		let fresh = request.exclusive || {
			let tree = self.s.tree.lock().unwrap();
			tree.listing(parent.0).is_some_and(|l| !l.iter().any(|c| c.name == name))
		};
		let noted = fresh && self.s.unpublished.lock().unwrap().note(&path);
		let opened = match self.s.link.open_write(&request) {
			Ok(o) => o,
			Err(f) => {
				if noted {
					self.s.unpublished.lock().unwrap().forget(&path);
				}
				return reply.error(errno(f));
			}
		};
		let mut attr =
			Attr { kind: EntryKind::File, size: opened.size, mtime_ms: now_ms(), executable: false, version: opened.version, authority: None };
		let ino = {
			let mut tree = self.s.tree.lock().unwrap();
			if request.exclusive {
				on_disk::locked(&mut tree, &path);
			}
			tree.add_local(parent.0, &name, attr.clone())
		};
		let open = Open::new();
		{
			let mut o = open.lock().unwrap();
			o.writer = Some(Writer::new(opened.handle, opened.size));
			o.handles = 1;
		}
		self.s.writing.lock().unwrap().insert(ino, open.clone());
		// A program that makes a file executable at create (a checkout, `cp` of a script) gets the bit at once.
		if mode & !umask & 0o100 != 0 {
			match self.s.link.set_executable(&path, None, true) {
				Ok(version) => {
					attr.executable = true;
					attr.version = version;
					self.s.tree.lock().unwrap().set_local(ino, attr.clone());
				}
				Err(f) => {
					// The file is made, but the program gets no handle on it: it is closed at the node, and the kernel
					// holds no entry for it.
					self.s.leave(ino, open);
					self.s.tree.lock().unwrap().forget(ino, 1);
					return reply.error(errno(f));
				}
			}
		}
		let fh = self.s.handle(Handle::Write { ino, open, opener: process_of(req.pid()) });
		// Refused here, the file stays made with its handle: the program is ending.
		let Some(reply) = self.noted(ino, reply) else { return };
		self.s.kernel.late(&name);
		reply.created(&CREATED, &self.s.file_attr(ino, &attr), Generation(0), fh, FopenFlags::empty());
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
		let Some(reply) = self.served(reply) else { return };
		let Some(reply) = self.local_read(fh.0, offset, size, reply) else { return };
		let (ino, file, written) = match self.s.handles.lock().unwrap().get(&fh.0) {
			Some(Handle::File { ino, path, version, size }) => (*ino, Some((path.clone(), version.clone(), *size)), None),
			Some(Handle::Write { ino, open, .. }) => (*ino, None, Some(open.clone())),
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
		let (path, version, file_size) = match current.or(file) {
			Some(f) => f,
			// A writing handle on a file the node has closed, whose attributes a change made unknown since: listed again.
			None => match self.s.attr(ino) {
				Ok((a, _)) if a.kind == EntryKind::File => match self.s.path_of(ino) {
					Ok(path) => (path, a.version, a.size),
					Err(e) => return reply.error(Errno::from_i32(e)),
				},
				Ok(_) => return reply.error(Errno::EISDIR),
				Err(e) => return reply.error(Errno::from_i32(e)),
			},
		};
		if offset >= file_size {
			return reply.data(&[]);
		}
		let len = (file_size - offset).min(size.min(MAX_READ) as u64) as u32;
		match self.s.link.read(&path, &version, offset, len) {
			Ok(data) => {
				self.s.read_version(ino, &path, &version);
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
		write_flags: WriteFlags,
		_flags: OpenFlags,
		_lock_owner: Option<LockOwner>,
		reply: ReplyWrite,
	) {
		let Some(reply) = self.served(reply) else { return };
		let cache = write_flags.contains(WriteFlags::FUSE_WRITE_CACHE);
		let Some(reply) = self.local_write(fh.0, offset, data, cache, reply) else { return };
		let (ino, open) = match self.s.handles.lock().unwrap().get(&fh.0) {
			Some(Handle::Write { ino, open, .. }) => (*ino, open.clone()),
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
	///
	/// A close by another process than the one that opened the handle (a child that inherited the descriptor, exiting)
	/// leaves it all to the opener's close, or to the release: children closing one by one would each close the file at
	/// the node, and stage it there.
	fn flush(&self, req: &Request, _ino: INodeNo, fh: FileHandle, _lock_owner: LockOwner, reply: ReplyEmpty) {
		let Some(reply) = self.served(reply) else { return };
		let Some(reply) = self.local_handle(fh.0, false, false, reply) else { return };
		let (ino, open, opener) = match self.s.handles.lock().unwrap().get(&fh.0) {
			Some(Handle::Write { ino, open, opener }) => (*ino, open.clone(), *opener),
			_ => return reply.ok(),
		};
		if process_of(req.pid()) != opener {
			return reply.ok();
		}
		let mut o = open.lock().unwrap();
		let result = if o.handles == 1 {
			self.s.close_at_node(ino, &mut o)
		} else {
			o.writer.as_mut().map_or(Ok(()), |w| w.flush(&self.s.link))
		};
		match result {
			Ok(()) => reply.ok(),
			Err(f) => reply.error(errno(f)),
		}
	}

	/// What was written goes to the node; the file stays open (nothing is published until a boundary).
	fn fsync(&self, _req: &Request, _ino: INodeNo, fh: FileHandle, _datasync: bool, reply: ReplyEmpty) {
		let Some(reply) = self.served(reply) else { return };
		let Some(reply) = self.local_handle(fh.0, true, false, reply) else { return };
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
		let Some(reply) = self.served(reply) else { return };
		let Some(reply) = self.local_handle(fh.0, false, true, reply) else { return };
		let handle = self.s.handles.lock().unwrap().remove(&fh.0);
		if let Some(Handle::Write { ino, open, .. }) = handle {
			self.s.leave(ino, open);
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
		atime: Option<TimeOrNow>,
		mtime: Option<TimeOrNow>,
		_ctime: Option<SystemTime>,
		fh: Option<FileHandle>,
		_crtime: Option<SystemTime>,
		_chgtime: Option<SystemTime>,
		_bkuptime: Option<SystemTime>,
		_flags: Option<fuser::BsdFileFlags>,
		reply: ReplyAttr,
	) {
		let Some(reply) = self.served(reply) else { return };
		if !self.s.writable && (mode.is_some() || size.is_some() || uid.is_some() || gid.is_some()) {
			return reply.error(Errno::EROFS);
		}
		// The folder keeps no owners: the files are the mount's.
		if uid.is_some_and(|u| u != self.s.owner.0) || gid.is_some_and(|g| g != self.s.owner.1) {
			return reply.error(Errno::EPERM);
		}
		let Some(reply) = self.local_setattr(ino.0, fh.map(|fh| fh.0), mode, size, (atime, mtime), reply) else { return };
		let attr = match self.s.attr(ino.0) {
			Ok((a, _)) => a,
			Err(e) => return reply.error(Errno::from_i32(e)),
		};
		// A link's mode and times are the folder's (`chmod`, `touch -h`): nothing is kept, and it is not an error.
		if attr.kind == EntryKind::Symlink {
			return self.reply_attr(ino.0, reply);
		}
		if let Some(size) = size {
			if attr.kind == EntryKind::Folder {
				return reply.error(Errno::EISDIR);
			}
			if let Err(e) = self.resize(ino.0, &attr, size) {
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

	fn mkdir(&self, _req: &Request, parent: INodeNo, name: &OsStr, mode: u32, umask: u32, reply: ReplyEntry) {
		let Some(reply) = self.served(reply) else { return };
		let (path, name) = match self.place(parent, name) {
			Ok(p) => p,
			Err(e) => return reply.error(e),
		};
		let Some(reply) = self.local_mkdir(parent.0, &name, mode & !umask, reply) else { return };
		if let Err(f) = self.s.link.mkdir(&path) {
			return reply.error(errno(f));
		}
		self.caches_gone(&path);
		let attr = Attr { kind: EntryKind::Folder, size: 0, mtime_ms: now_ms(), executable: false, version: String::new(), authority: None };
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
		let Some(reply) = self.served(reply) else { return };
		let ((from, from_name), (to, to_name)) = match (self.place(parent, name), self.place(newparent, newname)) {
			(Ok(a), Ok(b)) => (a, b),
			(Err(e), _) | (_, Err(e)) => return reply.error(e),
		};
		let Some(reply) = self.local_rename((parent.0, &from_name), (newparent.0, &to_name), flags, reply) else {
			return;
		};
		// Exchanging two names has no unit of its own.
		if flags.intersects(RenameFlags::RENAME_EXCHANGE | RenameFlags::RENAME_WHITEOUT) {
			return reply.error(Errno::EINVAL);
		}
		// A move's base is the version the name showed; a file renamed over is a save of the target, based on the
		// version the mount holds for it.
		let source = match self.s.child(parent.0, &from_name) {
			Ok(c) => c,
			Err(e) => return reply.error(Errno::from_i32(e)),
		};
		let folder = source.attr.kind == EntryKind::Folder;
		let held = match folder.then(|| self.folder_renaming((parent.0, &from_name), (newparent.0, &to_name))) {
			Some(Err(e)) => return reply.error(Errno::from_i32(e)),
			Some(Ok(held)) => held,
			None => None,
		};
		let from_base = (!folder).then(|| source.attr.version.clone());
		let to_base = self.s.versions.lock().unwrap().base(&to);
		let request = RenameRequest {
			from: from.clone(),
			from_base,
			to: to.clone(),
			to_base,
			no_replace: flags.contains(RenameFlags::RENAME_NOREPLACE),
		};
		let index = self.index_before(&from, &to, &source);
		let fresh = {
			let tree = self.s.tree.lock().unwrap();
			tree.listing(newparent.0).is_some_and(|l| !l.iter().any(|c| c.name == to_name))
		};
		let (stays, noted) = self.s.unpublished.lock().unwrap().renaming(&from, &to, folder, fresh);
		if let Err(f) = self.s.link.rename(&request) {
			if noted {
				self.s.unpublished.lock().unwrap().0.remove(&to);
			}
			return reply.error(errno(f));
		}
		self.s.unpublished.lock().unwrap().renamed(&from, &to, folder, stays);
		self.s.versions.lock().unwrap().renamed(&from, &to, folder);
		self.s.tree.lock().unwrap().renamed_local(&from, &to, newparent.0);
		let told = if folder { self.caches_renamed(held, &from, &to) } else { Ok(()) };
		self.index_after(&to, index);
		match told {
			Ok(()) => reply.ok(),
			Err(e) => reply.error(Errno::from_i32(e)),
		}
	}

	fn mknod(&self, _req: &Request, _parent: INodeNo, _name: &OsStr, _mode: u32, _umask: u32, _rdev: u32, reply: ReplyEntry) {
		let Some(reply) = self.served(reply) else { return };
		// The folder holds files, folders and links only: no device, named pipe or socket.
		reply.error(if self.s.writable { Errno::EPERM } else { Errno::EROFS });
	}

	/// A link's target, read at the link's version and logged as a read of the link, as an open of a file is. The kernel
	/// keeps no target (FUSE_CACHE_SYMLINKS stays off), so every readlink comes here and every reader is logged.
	fn readlink(&self, _req: &Request, ino: INodeNo, reply: ReplyData) {
		let Some(reply) = self.served(reply) else { return };
		let Some(reply) = self.local_readlink(ino.0, reply) else { return };
		let (attr, _) = match self.s.attr(ino.0) {
			Ok(r) => r,
			Err(e) => return reply.error(Errno::from_i32(e)),
		};
		if attr.kind != EntryKind::Symlink {
			return reply.error(Errno::EINVAL);
		}
		let path = match self.s.path_of(ino.0) {
			Ok(p) => p,
			Err(e) => return reply.error(Errno::from_i32(e)),
		};
		if let Err(e) = self.s.link.record_read(&path, Some(&attr.version), attr.authority.as_ref()) {
			eprintln!("qorpera-folder: could not record a link read: {e}");
			return reply.error(Errno::EIO);
		}
		match self.s.link.read(&path, &attr.version, 0, MAX_TARGET) {
			Ok(target) => {
				self.s.read_version(ino.0, &path, &attr.version);
				reply.data(&target)
			}
			Err(f) => {
				if matches!(&f, Fail::Remote(e) if e.code == code::STALE) {
					// Changed since it was listed: the next lookup lists its folder again.
					self.s.tree.lock().unwrap().invalidate([path.as_str()]);
				}
				reply.error(errno(f))
			}
		}
	}

	/// A new link holding `target` as written (the kernel refuses an empty one and one over 4,095 bytes first). Its
	/// version is this mount's save, as a close's is.
	fn symlink(&self, _req: &Request, parent: INodeNo, link_name: &OsStr, target: &Path, reply: ReplyEntry) {
		let Some(reply) = self.served(reply) else { return };
		let (path, name) = match self.place(parent, link_name) {
			Ok(p) => p,
			Err(e) => return reply.error(e),
		};
		let Some(reply) = self.local_symlink(parent.0, &name, target, reply) else { return };
		// The folder keeps text: a target that is not UTF-8 has no form it could keep exactly.
		let Some(target) = target.to_str() else { return reply.error(Errno::EINVAL) };
		let version = match self.s.link.symlink(&path, target) {
			Ok(v) => v,
			Err(f) => return reply.error(errno(f)),
		};
		self.s.versions.lock().unwrap().saved(&path, &version);
		let attr =
			Attr { kind: EntryKind::Symlink, size: target.len() as u64, mtime_ms: now_ms(), executable: false, version, authority: None };
		let ino = self.s.tree.lock().unwrap().add_local(parent.0, &name, attr.clone());
		reply.entry(&self.s.ttl(true), &self.s.file_attr(ino, &attr), Generation(0));
	}

	/// A hard link: a new name with the source's content as this mount shows it, stored once. The two names are never
	/// joined (RUNTIME-FOLDER-LINKS.md): the new one is an inode of its own with one link, so a save to either never shows
	/// through the other. Making it is a read of the source, logged before the node is asked. From or into a git object
	/// store it is EXDEV, which git and other tools take as "copy instead".
	fn link(&self, _req: &Request, ino: INodeNo, newparent: INodeNo, newname: &OsStr, reply: ReplyEntry) {
		let Some(reply) = self.served(reply) else { return };
		let (to, name) = match self.place(newparent, newname) {
			Ok(p) => p,
			Err(e) => return reply.error(e),
		};
		let Some(reply) = self.local_link(ino.0, (newparent.0, &name), reply) else { return };
		let (attr, _) = match self.s.attr(ino.0) {
			Ok(r) => r,
			Err(e) => return reply.error(Errno::from_i32(e)),
		};
		let from = match self.s.path_of(ino.0) {
			Ok(p) => p,
			Err(e) => return reply.error(Errno::from_i32(e)),
		};
		if git_objects(&from) || git_objects(&to) {
			return reply.error(Errno::EXDEV);
		}
		if let Err(e) = self.s.link.record_read(&from, Some(&attr.version), attr.authority.as_ref()) {
			eprintln!("qorpera-folder: could not record a hard link's read: {e}");
			return reply.error(Errno::EIO);
		}
		let request = LinkRequest { from: from.clone(), from_base: Some(attr.version.clone()), to: to.clone() };
		let version = match self.s.link.hard_link(&request) {
			Ok(v) => v,
			Err(f) => {
				if matches!(&f, Fail::Remote(e) if e.code == code::STALE) {
					self.s.tree.lock().unwrap().invalidate([from.as_str()]);
				}
				return reply.error(errno(f));
			}
		};
		self.s.read_version(ino.0, &from, &attr.version);
		self.s.versions.lock().unwrap().saved(&to, &version);
		// The source's kind, size and executable bit; the kernel takes a new node in the reply (proved on the test
		// machine: a node of the same type with its own number).
		let attr = Attr { version, mtime_ms: now_ms(), authority: None, ..attr };
		let new = self.s.tree.lock().unwrap().add_local(newparent.0, &name, attr.clone());
		reply.entry(&self.s.ttl(true), &self.s.file_attr(new, &attr), Generation(0));
	}

	fn statfs(&self, _req: &Request, _ino: INodeNo, reply: ReplyStatfs) {
		let Some(reply) = self.served(reply) else { return };
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
		let Some(reply) = self.served(reply) else { return };
		let (path, name) = match self.place(parent, name) {
			Ok(p) => p,
			Err(e) => return reply.error(e),
		};
		let Some(reply) = self.local_remove(parent.0, &name, folder, reply) else { return };
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
		self.s.unpublished.lock().unwrap().forget(&path);
		self.s.tree.lock().unwrap().removed_local(&path);
		if folder {
			self.caches_gone(&path);
		}
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
					s.link.feed_failed(&feed, &f);
					if s.link.closed() {
						let _ = stop.send(Stop::ViewClosed);
						return;
					}
					eprintln!("qorpera-folder: feed lost ({f}); nothing is cached until it is back");
					break;
				}
			};
			if !s.link.feed_current(&feed) { break; }
			{
				let mut unpublished = s.unpublished.lock().unwrap();
				if change.resync {
					*unpublished = Unpublished::default();
				}
				for path in change.paths.iter().filter(|p| valid_path(p)) {
					// A view's own new folder gone live is told by a name no folder has below it (the folder service's
					// `LISTING_ONLY`): what it holds may have gone live with it.
					unpublished.forget(path.strip_suffix("/\u{1}").unwrap_or(path));
				}
			}
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
			if change.resync {
				// The tree's resync drops the node's names; a cache top the node's entry won over goes too.
				s.kernel.own();
			}
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
		s.kernel.own();
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
					// What a boundary published while the feed was down was never told.
					*s.unpublished.lock().unwrap() = Unpublished::default();
					s.feed_up.store(true, Ordering::SeqCst);
					apply(inval, raced);
					s.kernel.own();
					break f;
				}
				Err(_) if s.link.closed() => {
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

/// Mounts the view and serves it until a signal, the view's end, or an unmount. Returns why it stopped. The caller
/// holds the state's daemon.lock.
pub fn run(mut link: Link, mut options: Options) -> Result<Stop, Failed> {
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
	if writable && !link.has_reads() {
		let reads = match options.reads.take() {
			Some(reads) => reads,
			None => {
				let dir = options.state.as_ref().ok_or_else(|| Failed::Other("a writable mount needs its private state directory".into()))?;
				// Open the journal before the version map creates files: only unused state can start a new read sequence.
				Arc::new(ReadLog::open(dir, true).map_err(|e| Failed::Other(format!("read journal: {e}")))?)
			}
		};
		link = link.with_reads(reads);
	}
	if writable {
		// The caller holds the state's daemon.lock: what an earlier program left open goes before a file is served here.
		link.abandon_earlier().map_err(|f| {
			if f.view_closed() {
				Failed::View(f.to_string())
			} else {
				Failed::Other(format!("could not tell the node the earlier program is gone: {f}"))
			}
		})?;
	}
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
	let owner = if writable {
		// SAFETY: geteuid and getegid have no preconditions. This affects virtual attributes only.
		options.owner.unwrap_or_else(|| unsafe { (libc::geteuid(), libc::getegid()) })
	} else {
		(0, 0)
	};
	let local = match (options.local.take().or_else(|| options.state.as_ref().map(|s| s.join("local"))), writable) {
		(Some(dir), true) => {
			let marker = options.state.as_ref().map(|s| s.join(crate::cache::MOVING));
			Some(
				Local::open(&dir, options.caches.as_deref(), &ok.view_id, owner, marker).map_err(|e| {
					// Its starter tells an unusable cache folder from another failure by the line's start.
					let e = e.to_string();
					Failed::Other(if e.starts_with(crate::local::UNUSABLE) { e } else { format!("the local folder {}: {e}", dir.display()) })
				})?,
			)
		}
		_ => None,
	};
	let (chased, names) = mpsc::channel();
	let kernel = kernel::Kernel::new(local.as_ref());
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
		local,
		code_host: ok.code_host,
		chased: chased.clone(),
		unpublished: Mutex::new(Unpublished::default()),
		kernel,
	});
	// Other programs on a shared cache folder can tell this one about their changes before it serves anything.
	kernel::Kernel::start(&shared)
		.map_err(|e| Failed::Other(format!("listening for the other programs on the cache folder: {e}")))?;
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
	{
		use std::os::fd::AsFd;
		let fuse = session.as_fd().try_clone_to_owned().map_err(|e| Failed::Other(format!("the mount's /dev/fuse: {e}")))?;
		shared.kernel.mounted(notifier.clone(), fuse);
	}
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
		let chaser = notifier.clone();
		std::thread::spawn(move || chase(chaser, names));
		std::thread::spawn(move || follow(shared, notifier, feed, stop_tx, chased));
	}
	let watching = Arc::new(AtomicBool::new(true));
	let watcher = {
		let shared = shared.clone();
		let watching = watching.clone();
		std::thread::spawn(move || {
			while watching.load(Ordering::SeqCst) {
				// A refused/malformed replacement leaves the accepted proof and fixed grace intact. Request calls
				// report their own errors; the idle watcher retries quietly without exposing credentials.
				let _ = shared.link.refresh();
				shared.link.expire();
				std::thread::sleep(Duration::from_millis(250));
			}
		})
	};
	if shared.local.is_some() {
		// Cache folders git came to track whose move into the folder did not finish (`mount/on_disk.rs`).
		let shared = shared.clone();
		let watching = watching.clone();
		std::thread::spawn(move || {
			while watching.load(Ordering::SeqCst) {
				std::thread::sleep(Duration::from_secs(5));
				if let Some(local) = shared.local.as_ref() {
					shared.move_caches(local, None);
				}
			}
		});
	}
	eprintln!("qorpera-folder: mounted at {} with {} threads", options.mountpoint.display(), options.threads);
	let why = stop_rx.recv().map_err(|_| Failed::Other("every stop channel closed".into()))?;
	shared.kernel.stop();
	// Every request refused, then the kernel's pages dropped, then the unmount and the exit: a fd held past the end reads
	// nothing more. Also when the kernel ended the session: an abort ends it with its pages still held.
	shared.kernel.close();
	if !matches!(why, Stop::Ended(_)) {
		if let Err(e) = unmount.unmount() {
			eprintln!("qorpera-folder: unmount {}: {e}", options.mountpoint.display());
		}
	}
	watching.store(false, Ordering::SeqCst);
	let _ = watcher.join();
	Ok(why)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn what_this_view_made_moves_with_its_renames_onto_a_name_of_its_own_or_none_and_not_with_its_folder() {
		let mut unpublished = Unpublished::default();
		for path in ["a", "d/x", "d/e/y", "dd/z", "k"] {
			assert!(unpublished.note(path));
		}
		assert!(!unpublished.note("a"));
		let noted = |u: &Unpublished| u.0.iter().cloned().collect::<Vec<_>>();
		// A file onto a new name, or one of its own, stays this view's; onto a file the folder has, it is a save of that.
		assert_eq!(unpublished.renaming("a", "b", false, true), (true, true));
		unpublished.renamed("a", "b", false, true);
		assert_eq!(unpublished.renaming("b", "k", false, false), (true, false));
		unpublished.renamed("b", "k", false, true);
		assert_eq!(noted(&unpublished), ["d/e/y", "d/x", "dd/z", "k"]);
		unpublished.note("c");
		assert_eq!(unpublished.renaming("c", "readme", false, false), (false, false));
		unpublished.renamed("c", "readme", false, false);
		assert_eq!(noted(&unpublished), ["d/e/y", "d/x", "dd/z", "k"]);
		// A rename the node refuses takes back what it noted.
		assert_eq!(unpublished.renaming("k", "m", false, true), (true, true));
		unpublished.0.remove("m");
		assert_eq!(noted(&unpublished), ["d/e/y", "d/x", "dd/z", "k"]);
		// A folder's files are this view's no longer, at either name, but for those of a folder whose name only starts
		// the same.
		assert_eq!(unpublished.renaming("d", "f", true, true), (false, false));
		unpublished.note("f/w");
		unpublished.renamed("d", "f", true, false);
		assert_eq!(noted(&unpublished), ["dd/z", "k"]);
	}

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

	#[test]
	fn knows_a_git_object_store_in_any_repository() {
		for path in [
			"code/app/.git/objects",
			"code/app/.git/objects/ab/cdef",
			"code/app/.git/objects/pack/tmp_pack_x",
			"code/site.git/objects/ab/cdef",
			"code/qorpera/app/repo.git/objects/ab/cdef",
		] {
			assert!(git_objects(path), "{path}");
		}
		for path in [
			"docs/plan.md",
			"code/app/.git/refs/heads/main",
			"code/app/.git/objects.lock",
			"code/app/objects/ab/cdef",
			"code/app/.github/objects/ab",
			"code/qorpera/app/repo.git/refs/heads/main",
		] {
			assert!(!git_objects(path), "{path}");
		}
	}
}
