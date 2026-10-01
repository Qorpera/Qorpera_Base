//! The folder at a mount point inside a machine, read-only. Names and attributes come from folder
//! listings the node sends on demand; bytes come from the node as programs read them. The node's feed
//! tells the program what changed, and the kernel is told to drop exactly that. The kernel's page cache
//! and this program's memory are the only caches: nothing is written to the machine's disk.
//!
//! While the feed is down nothing is cached at all (every lookup asks the node), so a machine never
//! shows a version older than the node's.

use crate::link::{Fail, Link};
use crate::proto::{code, valid_name, valid_path, EntryKind, MAX_READ};
use crate::tree::{Attr, Child, Inval, Tree, ROOT};
use fuser::{
	Config, Errno, FileAttr, FileHandle, FileType, Filesystem, FopenFlags, Generation, INodeNo, InitFlags,
	KernelConfig, LockOwner, MountOption, Notifier, OpenAccMode, OpenFlags, ReplyAttr, ReplyData, ReplyDirectory,
	ReplyEmpty, ReplyEntry, ReplyOpen, ReplyStatfs, Request, SessionACL,
};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, UNIX_EPOCH};

pub struct Options {
	pub mountpoint: PathBuf,
	pub threads: usize,
	/// How long the kernel may keep names and attributes while the feed is up.
	pub ttl: Duration,
	/// Let every account on the machine read the folder (a box's account, from step 2). Without it only the
	/// account that mounted it can, root included only if it mounted it.
	pub allow_other: bool,
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
	File { path: String, version: u64, size: u64 },
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
			let fetched = self.link.list(&path);
			{
				self.listing.lock().unwrap().remove(&dir);
				self.listed.notify_all();
			}
			let entries = fetched.map_err(|f| f.errno())?;
			let entries = entries.into_iter().filter(|e| valid_name(&e.name)).collect();
			let keep = self.feed_up.load(Ordering::SeqCst);
			return Ok(self.tree.lock().unwrap().install(dir, entries, started, keep, hold));
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
			// The path now names something else (removed and made again): this inode is gone.
			_ => Err(libc::ENOENT),
		}
	}

	fn handle(&self, h: Handle) -> FileHandle {
		let fh = self.next_fh.fetch_add(1, Ordering::SeqCst);
		self.handles.lock().unwrap().insert(fh, h);
		FileHandle(fh)
	}
}

fn file_type(kind: EntryKind) -> FileType {
	match kind {
		EntryKind::Folder => FileType::Directory,
		EntryKind::File => FileType::RegularFile,
	}
}

fn file_attr(ino: u64, a: &Attr) -> FileAttr {
	let t = UNIX_EPOCH + Duration::from_millis(a.mtime_ms.max(0) as u64);
	let (kind, perm, size) = match a.kind {
		EntryKind::Folder => (FileType::Directory, 0o555, 0),
		EntryKind::File => (FileType::RegularFile, if a.executable { 0o555 } else { 0o444 }, a.size),
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
		uid: 0,
		gid: 0,
		rdev: 0,
		flags: 0,
		blksize: 128 * 1024,
	}
}

struct FolderFs {
	s: Arc<Shared>,
}

impl Filesystem for FolderFs {
	fn init(&mut self, _req: &Request, config: &mut KernelConfig) -> std::io::Result<()> {
		let _ = config.set_max_readahead(MAX_READ);
		let _ = config.set_max_background(64);
		let _ = config.add_capabilities(InitFlags::FUSE_PARALLEL_DIROPS);
		eprintln!("qorpera-folder: kernel FUSE ABI {:?}", config.kernel_abi());
		Ok(())
	}

	fn lookup(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEntry) {
		let Some(name) = name.to_str().filter(|n| valid_name(n)) else { return reply.error(Errno::ENOENT) };
		match self.s.children(parent.0, Some(name)) {
			Ok((children, kept)) => match children.iter().find(|c| c.name == name) {
				Some(c) => reply.entry(&self.s.ttl(kept), &file_attr(c.ino, &c.attr), Generation(0)),
				None => reply.error(Errno::ENOENT),
			},
			Err(e) => reply.error(Errno::from_i32(e)),
		}
	}

	fn forget(&self, _req: &Request, ino: INodeNo, nlookup: u64) {
		self.s.tree.lock().unwrap().forget(ino.0, nlookup);
	}

	fn getattr(&self, _req: &Request, ino: INodeNo, _fh: Option<FileHandle>, reply: ReplyAttr) {
		match self.s.attr(ino.0) {
			Ok((a, kept)) => reply.attr(&self.s.ttl(kept), &file_attr(ino.0, &a)),
			Err(e) => reply.error(Errno::from_i32(e)),
		}
	}

	fn opendir(&self, _req: &Request, ino: INodeNo, _flags: OpenFlags, reply: ReplyOpen) {
		let (children, kept) = match self.s.children(ino.0, None) {
			Ok(r) => r,
			Err(e) => return reply.error(Errno::from_i32(e)),
		};
		let parent = self.s.tree.lock().unwrap().parent(ino.0).unwrap_or(ROOT);
		let mut entries = Vec::with_capacity(children.len() + 2);
		entries.push((ino.0, FileType::Directory, ".".to_string()));
		entries.push((parent, FileType::Directory, "..".to_string()));
		entries.extend(children.into_iter().map(|c| (c.ino, file_type(c.attr.kind), c.name)));
		let flags = if self.s.ttl(kept).is_zero() {
			FopenFlags::empty()
		} else {
			FopenFlags::FOPEN_CACHE_DIR | FopenFlags::FOPEN_KEEP_CACHE
		};
		reply.opened(self.s.handle(Handle::Dir(entries)), flags);
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
		if flags.acc_mode() != OpenAccMode::O_RDONLY {
			return reply.error(Errno::EROFS);
		}
		let (attr, kept) = match self.s.attr(ino.0) {
			Ok(r) => r,
			Err(e) => return reply.error(Errno::from_i32(e)),
		};
		if attr.kind == EntryKind::Folder {
			return reply.error(Errno::EISDIR);
		}
		let Some(path) = self.s.tree.lock().unwrap().path(ino.0).map(str::to_string) else {
			return reply.error(Errno::ENOENT);
		};
		// Keep cached pages across opens while the feed is up: it drops them when the file changes.
		let flags = if self.s.ttl(kept).is_zero() { FopenFlags::empty() } else { FopenFlags::FOPEN_KEEP_CACHE };
		reply.opened(self.s.handle(Handle::File { path, version: attr.version, size: attr.size }), flags);
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
		let (path, version, file_size) = match self.s.handles.lock().unwrap().get(&fh.0) {
			Some(Handle::File { path, version, size }) => (path.clone(), *version, *size),
			_ => return reply.error(Errno::EBADF),
		};
		if offset >= file_size {
			return reply.data(&[]);
		}
		let len = (file_size - offset).min(size.min(MAX_READ) as u64) as u32;
		match self.s.link.read(&path, version, offset, len) {
			Ok(data) => reply.data(&data),
			Err(f) => {
				if matches!(&f, Fail::Remote(e) if e.code == code::STALE) {
					// The file changed under this open file. Forget it here; the kernel hears from the
					// feed (telling it from inside a read could deadlock on the page being read).
					self.s.tree.lock().unwrap().invalidate([path.as_str()]);
				} else {
					eprintln!("qorpera-folder: read failed: {f}");
				}
				reply.error(Errno::from_i32(f.errno()))
			}
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
		self.s.handles.lock().unwrap().remove(&fh.0);
		reply.ok();
	}

	fn statfs(&self, _req: &Request, _ino: INodeNo, reply: ReplyStatfs) {
		let files = self.s.tree.lock().unwrap().known() as u64;
		reply.statfs(0, 0, 0, files, 0, 128 * 1024, 255, 128 * 1024);
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
fn follow(s: Arc<Shared>, notifier: Notifier, mut feed: crate::link::Feed, stop: mpsc::Sender<Stop>) {
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
			let inval = if change.resync {
				s.tree.lock().unwrap().resync()
			} else if change.paths.is_empty() {
				Vec::new()
			} else {
				let paths: Vec<&str> = change.paths.iter().map(String::as_str).filter(|p| valid_path(p)).collect();
				s.tree.lock().unwrap().invalidate(paths)
			};
			tell_kernel(&notifier, inval);
			if feed.ack(change.seq).is_err() {
				break;
			}
		}
		feed.close();
		s.feed_up.store(false, Ordering::SeqCst);
		let inval = s.tree.lock().unwrap().resync();
		tell_kernel(&notifier, inval);
		feed = loop {
			std::thread::sleep(wait);
			match s.link.open_feed() {
				Ok((f, ok)) => {
					wait = Duration::from_secs(1);
					eprintln!("qorpera-folder: feed back at change {}", ok.as_of_seq);
					// Anything fetched before this moment may be older than the feed's start.
					let inval = s.tree.lock().unwrap().resync();
					s.feed_up.store(true, Ordering::SeqCst);
					tell_kernel(&notifier, inval);
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
	eprintln!("qorpera-folder: view {} accepted at change {}", ok.view_id, ok.as_of_seq);
	let shared = Arc::new(Shared {
		tree: Mutex::new(Tree::new()),
		link,
		feed_up: AtomicBool::new(true),
		listing: Mutex::new(HashSet::new()),
		listed: Condvar::new(),
		handles: Mutex::new(HashMap::new()),
		next_fh: AtomicU64::new(1),
		ttl: options.ttl,
	});
	let mut config = Config::default();
	config.mount_options = vec![
		MountOption::RO,
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
		let shared = shared.clone();
		std::thread::spawn(move || follow(shared, notifier, feed, stop_tx));
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
