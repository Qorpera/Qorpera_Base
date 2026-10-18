//! The session's own files on the machine's disk (RUNTIME-FOLDER-CODING-MACHINES.md "Code areas and git" and "The
//! cache list"): files the mount shows at their paths in the folder but never sends to the node, so they are never
//! published and other views and machines see nothing of them.
//!
//! - **Session-local git files** (`git::session_local`): a repository's `config`, `hooks/**` and `info/**`, and a
//!   worktree's `config.worktree`. The session gets its own copy, seeded from the published one the first time the
//!   mount reaches the repository (or the worktree's git folder), and what git writes there stays here. The node's own
//!   copy of those paths is never shown.
//! - **The machine's caches** (`cache.rs`): a new folder an install or a build makes under a cache name, where the
//!   node has nothing at that path, and what is in it. Whatever the node has at a path wins.
//!
//! They live in the local folder (`--local-dir`, by default `local/` in the mount's state folder). Git files are at
//! `git/<path>`, by their paths in the folder. Caches are kept by the node's folder they are in: the top entries (a
//! cache folder or file whose folder is the node's) of the folder `a/b` are in `caches/d/a/d/b/t/`, so a cache is told
//! from the caches of a folder below its own, and the caches of a folder and of all below it move or go together with
//! it. A folder of the node's whose caches are moving into the folder (`mount/on_disk.rs`) is marked (`w`, beside its
//! `t/`) until all of them have, so the move goes on there under whatever name a rename gives it. A local folder that
//! a program started for another view finds is that view's: its git files go (they are seeded again), its caches stay
//! (they can be rebuilt at any time, and are only ever the machine's own). What goes is moved to `gone/` first and
//! taken off the disk there apart from the requests.
//!
//! The kernel knows a local file by its inode on the disk with the top bit set (`LOCAL`); the node's inodes never have
//! it. So does a handle open on one.

use crate::cache::CacheList;
use crate::git;
use crate::ignore::Patterns;
use crate::writer::Writer;
use fuser::{FileAttr, FileType, INodeNo};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant, UNIX_EPOCH};

/// The bit local inodes and handles have.
pub const LOCAL: u64 = 1 << 63;

pub fn is_local(ino: u64) -> bool {
	ino & LOCAL != 0
}

/// Which local files a path is among.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Area {
	Git,
	Cache,
}

impl Area {
	fn dir(self) -> &'static str {
		match self {
			Area::Git => "git",
			Area::Cache => "caches",
		}
	}
}

/// Where what goes from the local folder waits to be taken off the disk.
const GONE: &str = "gone";

/// The mark of a folder whose caches are moving into the folder (`Local::whole`).
const WHOLE: &str = "w";

/// The folder a local file is in: a folder of the mount's (by its path), or a local one (by its inode).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Up {
	Mount(String),
	Local(u64),
}

/// Whether `path` is a session-local git file (`git::session_local`).
pub fn git_file(path: &str) -> bool {
	matches!(git::place(path), git::Place::Git { rest, .. } if git::session_local(rest))
}

/// What seeds the session-local git file `path`, or the folder `path` that holds some: the repository's
/// (`<area>/repo.git`: its `config`, `hooks/` and `info/`), or a worktree's git folder's
/// (`<area>/repo.git/worktrees/<worker>`: its `config.worktree`).
pub fn seed_of(path: &str) -> Option<String> {
	let git::Place::Git { area, rest } = git::place(path) else { return None };
	if rest.is_empty() || git::session_local(rest) && !rest.starts_with("worktrees/") {
		return Some(format!("{area}/repo.git"));
	}
	let worker = rest.strip_prefix("worktrees/")?.split('/').next().filter(|w| !w.is_empty())?;
	let below = &rest["worktrees/".len() + worker.len()..];
	(below.is_empty() || git::session_local(rest)).then(|| format!("{area}/repo.git/worktrees/{worker}"))
}

/// The names `seed` holds: what the published copy of it gives the session (its folders' contents included).
pub fn seeded_names(seed: &str) -> &'static [&'static str] {
	if seed.contains("/repo.git/worktrees/") {
		&["config.worktree"]
	} else {
		&["config", "hooks", "info"]
	}
}

type Names = HashMap<u64, Vec<(Up, String, Area)>>;

/// A local file the mount has open: the file, its inode, and whether the handle writes to it (`Local::seal`).
struct Handle {
	file: File,
	ino: u64,
	writes: bool,
}

/// An error of a local file found again after a wait for a cache move (`Local::unsealed`): one not there any more is in
/// the folder now, so the name or inode it was asked by is stale, for the kernel to look up again (ESTALE).
fn stale(waited: bool) -> impl Fn(i32) -> i32 {
	move |e| if waited && e == libc::ENOENT { libc::ESTALE } else { e }
}

/// `ino` is known by `name` in `up`, its latest name.
fn known(names: &mut Names, ino: u64, up: Up, name: &str, area: Area) {
	let all = names.entry(ino).or_default();
	all.retain(|(u, n, _)| !(*u == up && n == name));
	all.push((up, name.to_string(), area));
}

/// `name` in `up` no longer names `ino`.
fn forget(names: &mut Names, ino: u64, up: &Up, name: &str) {
	if let Some(all) = names.get_mut(&ino) {
		all.retain(|(u, n, _)| !(u == up && n == name));
		if all.is_empty() {
			names.remove(&ino);
		}
	}
}

/// `ino`'s latest name: its folder, name and area.
fn latest(names: &Names, ino: u64) -> Option<(Up, String, Area)> {
	names.get(&ino).and_then(|all| all.last()).cloned()
}

/// Forgets every name `gone` picks, and then every name in a local folder left with none.
fn forget_all(names: &mut Names, gone: impl Fn(&Up, &str, Area) -> bool) {
	for all in names.values_mut() {
		all.retain(|(up, name, area)| !gone(up, name, *area));
	}
	loop {
		names.retain(|_, all| !all.is_empty());
		let named: HashSet<u64> = names.keys().copied().collect();
		let before: usize = names.values().map(Vec::len).sum();
		for all in names.values_mut() {
			all.retain(|(up, _, _)| !matches!(up, Up::Local(ino) if !named.contains(ino)));
		}
		if names.values().map(Vec::len).sum::<usize>() == before {
			return;
		}
	}
}

/// `ino` by its latest names: the mount folder above it, the names from there down to it, and its area.
fn chain(names: &Names, ino: u64) -> Option<(String, Vec<String>, Area)> {
	let (mut up, name, area) = latest(names, ino)?;
	let mut parts = vec![name];
	loop {
		match up {
			Up::Mount(path) => {
				parts.reverse();
				return Some((path, parts, area));
			}
			Up::Local(ino) => {
				let (next, name, _) = latest(names, ino)?;
				parts.push(name);
				up = next;
			}
		}
	}
}

/// `ino`'s path in the folder by its latest names (`up` gives the path of a mount folder above it).
fn path_in(names: &Names, ino: u64) -> Option<(String, Area)> {
	let (dir, parts, area) = chain(names, ino)?;
	Some((parts.iter().fold(dir, |path, name| crate::proto::join(&path, name)), area))
}

/// Whether the folder's `path` is `dir` or below it.
fn under(path: &str, dir: &str) -> bool {
	path == dir || dir.is_empty() || path.strip_prefix(dir).is_some_and(|rest| rest.starts_with('/'))
}

/// Moves `disk` (a file or a folder) into `gone/` and takes it off the disk there, apart from the request.
fn trash(root: &Path, disk: &Path) -> io::Result<()> {
	static NEXT: AtomicU64 = AtomicU64::new(0);
	let started = std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
	let to = root.join(GONE).join(format!("{started}-{}", NEXT.fetch_add(1, Ordering::SeqCst)));
	fs::rename(disk, &to)?;
	take_off(to);
	Ok(())
}

fn take_off(disk: PathBuf) {
	std::thread::spawn(move || {
		let removed = match fs::symlink_metadata(&disk) {
			Ok(m) if m.is_dir() => fs::remove_dir_all(&disk),
			Ok(_) => fs::remove_file(&disk),
			Err(e) => Err(e),
		};
		if let Err(e) = removed {
			eprintln!("qorpera-folder: {} could not be taken off the disk ({e})", disk.display());
		}
	});
}

pub struct Local {
	root: PathBuf,
	/// By local inode: the names it is known by (the folder it is in, its name, its area), the latest last. A file with
	/// more than one name (a hard link) is found by the latest, and by one left when that one goes.
	names: Mutex<Names>,
	/// The seeds done, written through to `seeded` so a program started again does not seed over the session's changes.
	seeded: Mutex<HashSet<String>>,
	/// Held while a seed is copied, so a second lookup waits for it rather than finding half of it.
	pub seeding: Mutex<()>,
	/// The local files open, by handle; each kept with the names held (`hold`), and the wait for one to be let go of.
	handles: Mutex<HashMap<u64, Handle>>,
	released: Condvar,
	next_fh: AtomicU64,
	/// The local files a cache move is writing into the folder, by inode (`seal`), and the wait for one to be done.
	sealed: Mutex<HashSet<u64>>,
	lifted: Condvar,
	pub cache: Mutex<CacheList>,
	/// Held while cache folders move into the folder (`mount/on_disk.rs`), so no two move the same; with the writes of a
	/// move the node did not take, by the file's path, so the next move goes on through the same handle.
	pub moving: Mutex<HashMap<String, Writer>>,
	/// How many of its folders the node renamed for this view. Held from the node's rename of one until its caches have
	/// moved with it (`mount.rs`), while the caches of a folder the node no longer has go, and through each of the
	/// node's folders a move into the folder goes through (`mount/on_disk.rs`): so no listing takes a renamed folder's
	/// caches for those of one that is gone, and no move goes on under a folder's old name.
	pub folders: Mutex<u64>,
	/// The `.gitignore` files read for the caches in worktrees (`ignore.rs`), by their paths: the version each was read
	/// at, and its patterns.
	pub ignores: Mutex<HashMap<String, (String, Arc<Patterns>)>>,
	owner: (u32, u32),
}

impl Local {
	/// The local folder `root` (made 0700 if missing) for view `view`, its files owned by `owner` in the mount; `marker`
	/// is there while a cache folder git came to track has not moved into the folder (`cache.rs`).
	pub fn open(root: &Path, view: &str, owner: (u32, u32), marker: Option<PathBuf>) -> io::Result<Local> {
		fs::DirBuilder::new().recursive(true).mode(0o700).create(root)?;
		let mark = root.join("view");
		if fs::read_to_string(&mark).ok().as_deref() != Some(view) {
			// Another view's: its git files are not this session's.
			for gone in [root.join("git"), root.join("seeded")] {
				match fs::symlink_metadata(&gone) {
					Ok(m) if m.is_dir() => fs::remove_dir_all(&gone)?,
					Ok(_) => fs::remove_file(&gone)?,
					Err(e) if e.kind() == io::ErrorKind::NotFound => {}
					Err(e) => return Err(e),
				}
			}
			let mut file = OpenOptions::new().create(true).write(true).truncate(true).mode(0o600).open(&mark)?;
			file.write_all(view.as_bytes())?;
		}
		for dir in [Area::Git.dir(), Area::Cache.dir(), GONE] {
			fs::DirBuilder::new().recursive(true).mode(0o700).create(root.join(dir))?;
		}
		// What an earlier program left to take off the disk, and the caches of 5d's program, kept by their paths.
		for left in fs::read_dir(root.join(GONE))? {
			take_off(left?.path());
		}
		match trash(root, &root.join("cache")) {
			Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
			_ => {}
		}
		let seeded = match fs::read_to_string(root.join("seeded")) {
			Ok(text) => text.lines().map(str::to_string).collect(),
			Err(e) if e.kind() == io::ErrorKind::NotFound => HashSet::new(),
			Err(e) => return Err(e),
		};
		Ok(Local {
			root: root.to_path_buf(),
			names: Mutex::new(HashMap::new()),
			seeded: Mutex::new(seeded),
			seeding: Mutex::new(()),
			handles: Mutex::new(HashMap::new()),
			released: Condvar::new(),
			next_fh: AtomicU64::new(1),
			sealed: Mutex::new(HashSet::new()),
			lifted: Condvar::new(),
			cache: Mutex::new(CacheList::open(&root.join("cache-left.jsonl"), marker)?),
			moving: Mutex::new(HashMap::new()),
			folders: Mutex::new(0),
			ignores: Mutex::new(HashMap::new()),
			owner,
		})
	}

	/// Where the local file at the folder's `path` is on the disk: a git file, or a cache's top entry.
	pub fn disk(&self, area: Area, path: &str) -> PathBuf {
		let (dir, name) = crate::proto::split(path);
		self.room(dir, area).join(name)
	}

	/// Where the local entries of the node's folder `dir` are on the disk: its git files, or its top entries.
	pub fn room(&self, dir: &str, area: Area) -> PathBuf {
		match area {
			Area::Git => self.root.join(Area::Git.dir()).join(dir),
			Area::Cache => self.mirror(dir).join("t"),
		}
	}

	/// Where the caches of the node's folder `dir` are on the disk: its top entries in `t/`, the caches of each folder
	/// in it in `d/<name>/`.
	fn mirror(&self, dir: &str) -> PathBuf {
		let mut disk = self.root.join(Area::Cache.dir());
		for name in dir.split('/').filter(|n| !n.is_empty()) {
			disk.push("d");
			disk.push(name);
		}
		disk
	}

	/// Whether the node's folder `dir` has a cache named `name`.
	pub fn is_top(&self, dir: &str, name: &str) -> bool {
		fs::symlink_metadata(self.disk(Area::Cache, &crate::proto::join(dir, name))).is_ok()
	}

	/// Whether the node's folder `dir` has caches in it: it is not empty.
	pub fn tops(&self, dir: &str) -> bool {
		fs::read_dir(self.mirror(dir).join("t")).is_ok_and(|mut d| d.next().is_some())
	}

	/// Whether the node's folder `dir` has caches in it or in a folder below it, or did since the program started.
	pub fn has_caches(&self, dir: &str) -> bool {
		fs::read_dir(self.mirror(dir)).is_ok_and(|mut d| d.next().is_some())
	}

	/// The names of the folders in the node's folder `dir` that have caches in them or below, or had.
	pub fn mirrors(&self, dir: &str) -> Vec<String> {
		let Ok(read) = fs::read_dir(self.mirror(dir).join("d")) else { return Vec::new() };
		read.flatten().filter_map(|e| e.file_name().to_str().map(str::to_string)).collect()
	}

	/// Whether all the caches of the node's folder `dir`, and of the folders below it, are moving into the folder: it
	/// was a cache, or was in one, and a move has not taken them all yet (`mount/on_disk.rs`).
	pub fn whole(&self, dir: &str) -> bool {
		fs::symlink_metadata(self.mirror(dir).join(WHOLE)).is_ok()
	}

	/// Marks the node's folder `dir` as one whose caches all move (`whole`), or takes the mark off once they have.
	pub fn mark_whole(&self, dir: &str, whole: bool) -> io::Result<()> {
		let mark = self.mirror(dir).join(WHOLE);
		if whole {
			fs::DirBuilder::new().recursive(true).mode(0o755).create(self.mirror(dir))?;
			return OpenOptions::new().create(true).write(true).mode(0o644).open(mark).map(drop);
		}
		match fs::remove_file(mark) {
			Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
			_ => Ok(()),
		}
	}

	/// Whether caches are moving into the folder from the node's folder `path`, or from one below it: it is marked as one
	/// whose caches all move (`whole`), or has a cache folder named one of `names` (those still to move in its worktree),
	/// which a move has not reached yet.
	pub fn moving_below(&self, path: &str, names: &[String]) -> bool {
		let mut todo = vec![self.mirror(path)];
		while let Some(disk) = todo.pop() {
			let named = |n: &String| fs::symlink_metadata(disk.join("t").join(n)).is_ok_and(|m| m.is_dir());
			if fs::symlink_metadata(disk.join(WHOLE)).is_ok() || names.iter().any(named) {
				return true;
			}
			if let Ok(read) = fs::read_dir(disk.join("d")) {
				todo.extend(read.flatten().map(|e| e.path()));
			}
		}
		false
	}

	/// The node has an entry where `dir` has the cache `name` (rule 1): the cache goes.
	pub fn gone_top(&self, dir: &str, name: &str) {
		let mut names = self.names.lock().unwrap();
		match trash(&self.root, &self.disk(Area::Cache, &crate::proto::join(dir, name))) {
			Ok(()) => {}
			Err(e) if e.kind() == io::ErrorKind::NotFound => return,
			Err(e) => return eprintln!("qorpera-folder: the cache {name} in {dir:?} could not go ({e})"),
		}
		let up = Up::Mount(dir.to_string());
		forget_all(&mut names, |u, n, area| area == Area::Cache && *u == up && n == name);
	}

	/// The node's folder `path` is gone from the view: its caches, and those of every folder below it, go.
	pub fn drop_mirror(&self, path: &str) {
		let mut names = self.names.lock().unwrap();
		match trash(&self.root, &self.mirror(path)) {
			Ok(()) => {}
			Err(e) if e.kind() == io::ErrorKind::NotFound => return,
			Err(e) => return eprintln!("qorpera-folder: the caches in {path:?} could not go ({e})"),
		}
		forget_all(&mut names, |u, _, area| area == Area::Cache && matches!(u, Up::Mount(p) if under(p, path)));
	}

	/// The node took the rename of its folder `from` to `to`: the caches in it and below move with it. Those of a folder
	/// it replaced at `to` go; in a repository's git folder, where no cache is shown, they go too.
	pub fn renamed(&self, from: &str, to: &str) {
		let (source, target) = (self.mirror(from), self.mirror(to));
		let there = |p: &Path| fs::symlink_metadata(p).is_ok();
		if from == to || !there(&source) && !there(&target) {
			return;
		}
		let mut names = self.names.lock().unwrap();
		match trash(&self.root, &target) {
			Err(e) if e.kind() != io::ErrorKind::NotFound => eprintln!("qorpera-folder: the caches in {to:?} could not go ({e})"),
			_ => {}
		}
		let into_git = matches!(git::place(to), git::Place::Git { .. });
		let moved = if !there(&source) {
			Ok(())
		} else if into_git {
			trash(&self.root, &source)
		} else {
			fs::DirBuilder::new()
				.recursive(true)
				.mode(0o755)
				.create(target.parent().expect("a folder's caches are in its folder's"))
				.and_then(|()| fs::rename(&source, &target))
		};
		if let Err(e) = moved {
			eprintln!("qorpera-folder: the caches in {from:?} could not move to {to:?} ({e})");
		}
		forget_all(&mut names, |u, _, area| area == Area::Cache && matches!(u, Up::Mount(p) if under(p, to)));
		if into_git {
			return forget_all(&mut names, |u, _, area| area == Area::Cache && matches!(u, Up::Mount(p) if under(p, from)));
		}
		for all in names.values_mut() {
			for (up, _, area) in all.iter_mut() {
				if let (Up::Mount(p), Area::Cache) = (&*up, *area) {
					if under(p, from) {
						*up = Up::Mount(format!("{to}{}", &p[from.len()..]));
					}
				}
			}
		}
	}

	/// Makes the cache folder `name` in `dir` the caches of the node's folder of that name, which a move has in the
	/// folder now (`mount/on_disk.rs`): what is in it becomes that folder's top entries, all moving (`whole`) or (not
	/// `whole`) those the move picks. When that folder has top entries of its own: `whole`, false, and nothing done;
	/// not `whole`, what is in it joins them, but for a name they have, which is not shown (the node's folder is) and
	/// goes with the cache folder.
	pub fn convert(&self, dir: &str, name: &str, whole: bool) -> io::Result<bool> {
		let mut names = self.names.lock().unwrap();
		let path = crate::proto::join(dir, name);
		let (top, into) = (self.disk(Area::Cache, &path), self.mirror(&path).join("t"));
		let ino = fs::symlink_metadata(&top)?.ino() | LOCAL;
		fs::DirBuilder::new().recursive(true).mode(0o755).create(self.mirror(&path))?;
		let joined = match fs::remove_dir(&into) {
			Err(e) if e.raw_os_error() == Some(libc::ENOTEMPTY) || e.raw_os_error() == Some(libc::EEXIST) => {
				if whole {
					return Ok(false);
				}
				let mut joined = HashSet::new();
				for entry in fs::read_dir(&top)? {
					let entry = entry?;
					let to = into.join(entry.file_name());
					if fs::symlink_metadata(&to).is_err() {
						fs::rename(entry.path(), to)?;
						joined.extend(entry.file_name().into_string());
					}
				}
				Some(joined)
			}
			Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
			_ => None,
		};
		if whole {
			self.mark_whole(&path, true)?;
		}
		if joined.is_none() {
			fs::rename(&top, &into)?;
		}
		for all in names.values_mut() {
			for (up, n, area) in all.iter_mut() {
				if *up == Up::Local(ino) && *area == Area::Cache && joined.as_ref().is_none_or(|j| j.contains(n.as_str())) {
					*up = Up::Mount(path.clone());
				}
			}
		}
		let up = Up::Mount(dir.to_string());
		if joined.is_some() {
			trash(&self.root, &top)?;
			forget_all(&mut names, |u, n, area| area == Area::Cache && *u == up && n == name);
		} else {
			forget(&mut names, ino, &up, name);
		}
		Ok(true)
	}

	pub fn seeded(&self, seed: &str) -> bool {
		self.seeded.lock().unwrap().contains(seed)
	}

	/// `seed` is copied; a failed write only means a program started again seeds it again.
	pub fn mark_seeded(&self, seed: &str) {
		self.seeded.lock().unwrap().insert(seed.to_string());
		let written = OpenOptions::new()
			.create(true)
			.append(true)
			.mode(0o600)
			.open(self.root.join("seeded"))
			.and_then(|mut f| f.write_all(format!("{seed}\n").as_bytes()));
		if let Err(e) = written {
			eprintln!("qorpera-folder: a seed could not be noted ({e})");
		}
	}

	/// Writes a seeded file (or, `bytes` None, folder) at the folder's `path`, the folders above it made as needed.
	pub fn put(&self, path: &str, bytes: Option<&[u8]>, executable: bool) -> io::Result<()> {
		let disk = self.disk(Area::Git, path);
		let Some(bytes) = bytes else { return fs::DirBuilder::new().recursive(true).mode(0o755).create(&disk) };
		if let Some(parent) = disk.parent() {
			fs::DirBuilder::new().recursive(true).mode(0o755).create(parent)?;
		}
		let mode = if executable { 0o755 } else { 0o644 };
		let mut file = OpenOptions::new().create(true).write(true).truncate(true).mode(mode).open(&disk)?;
		file.write_all(bytes)
	}

	/// Makes a seeded link at the folder's `path` to `target`, in place of one an earlier seed left there.
	pub fn put_link(&self, path: &str, target: &[u8]) -> io::Result<()> {
		let disk = self.disk(Area::Git, path);
		if let Some(parent) = disk.parent() {
			fs::DirBuilder::new().recursive(true).mode(0o755).create(parent)?;
		}
		match fs::remove_file(&disk) {
			Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
			_ => {}
		}
		std::os::unix::fs::symlink(OsStr::from_bytes(target), &disk)
	}

	/// The local inode's folder, name and area.
	pub fn name(&self, ino: u64) -> Option<(Up, String, Area)> {
		latest(&self.names.lock().unwrap(), ino)
	}

	/// The local inode's path in the folder (`up` gives the path of a mount folder above it).
	pub fn path(&self, ino: u64) -> Option<(String, Area)> {
		path_in(&self.names.lock().unwrap(), ino)
	}

	/// Where the local inode is on the disk, by `names`. What reads or changes a local file or its names finds it with
	/// the names held until it is done, so no unlink or rename between finding and using it (of a hard link's name, or
	/// a folder above) has it read or change another file by the same name. One no name reaches any more (removed, or
	/// in the folder now, a cache move's) is stale: an entry the kernel still has for it is looked up again (ESTALE).
	fn disk_at(&self, names: &Names, ino: u64) -> Result<(PathBuf, Area), i32> {
		let (dir, parts, area) = chain(names, ino).ok_or(libc::ESTALE)?;
		let mut disk = self.room(&dir, area);
		disk.extend(&parts);
		Ok((disk, area))
	}

	/// Where `name` in `up` is on the disk, by `names` (`disk_at`), with its area (for a mount folder, the area `area`
	/// says).
	fn disk_under(&self, names: &Names, up: &Up, name: &str, area: Area) -> Result<(PathBuf, Area), i32> {
		match up {
			Up::Mount(path) => Ok((self.disk(area, &crate::proto::join(path, name)), area)),
			Up::Local(ino) => self.disk_at(names, *ino).map(|(dir, area)| (dir.join(name), area)),
		}
	}

	/// The entry for `name` in `up`, from the disk, now known by its inode.
	pub fn entry(&self, up: Up, name: &str, area: Area) -> Result<FileAttr, i32> {
		let mut names = self.names.lock().unwrap();
		let (disk, area) = self.disk_under(&names, &up, name, area)?;
		self.known_at(&mut names, up, name, area, &disk)
	}

	/// `name` in `up`, at `disk`, now known by its inode (`names` held since it was found or made there).
	fn known_at(&self, names: &mut Names, up: Up, name: &str, area: Area, disk: &Path) -> Result<FileAttr, i32> {
		let meta = fs::symlink_metadata(disk).map_err(errno)?;
		known(names, meta.ino() | LOCAL, up, name, area);
		Ok(self.attr(&meta))
	}

	/// The attributes of a local inode, from the disk (with the names held, as `disk_at` says).
	pub fn getattr(&self, ino: u64) -> Result<FileAttr, i32> {
		let names = self.names.lock().unwrap();
		let (disk, _) = self.disk_at(&names, ino)?;
		fs::symlink_metadata(disk).map(|m| self.attr(&m)).map_err(errno)
	}

	pub fn attr(&self, meta: &fs::Metadata) -> FileAttr {
		let time = |s: i64, ns: i64| {
			if s >= 0 {
				UNIX_EPOCH + Duration::new(s as u64, ns as u32)
			} else {
				UNIX_EPOCH
			}
		};
		FileAttr {
			ino: INodeNo(meta.ino() | LOCAL),
			size: meta.size(),
			blocks: meta.blocks(),
			atime: time(meta.atime(), meta.atime_nsec()),
			mtime: time(meta.mtime(), meta.mtime_nsec()),
			ctime: time(meta.ctime(), meta.ctime_nsec()),
			crtime: time(meta.mtime(), meta.mtime_nsec()),
			kind: kind(&meta.file_type()),
			perm: (meta.mode() & 0o7777) as u16,
			nlink: meta.nlink() as u32,
			uid: self.owner.0,
			gid: self.owner.1,
			rdev: 0,
			flags: 0,
			blksize: 4096,
		}
	}

	/// The local entries of a mount folder (`dir`, in `area`), each now known by its inode.
	pub fn entries_of(&self, dir: &str, area: Area) -> Vec<(u64, FileType, String)> {
		let Ok(read) = fs::read_dir(self.room(dir, area)) else { return Vec::new() };
		let mut out = Vec::new();
		let mut names = self.names.lock().unwrap();
		for entry in read.flatten() {
			let (Ok(meta), Some(name)) = (entry.metadata(), entry.file_name().to_str().map(str::to_string)) else {
				continue;
			};
			let ino = meta.ino() | LOCAL;
			known(&mut names, ino, Up::Mount(dir.to_string()), &name, area);
			out.push((ino, kind(&meta.file_type()), name));
		}
		out
	}

	/// The entries of a local folder, each now known by its inode.
	pub fn children(&self, ino: u64) -> Result<Vec<(u64, FileType, String)>, i32> {
		let mut out = Vec::new();
		let mut names = self.names.lock().unwrap();
		let (disk, area) = self.disk_at(&names, ino)?;
		for entry in fs::read_dir(disk).map_err(errno)?.flatten() {
			let (Ok(meta), Some(name)) = (entry.metadata(), entry.file_name().to_str().map(str::to_string)) else {
				continue;
			};
			let child = meta.ino() | LOCAL;
			known(&mut names, child, Up::Local(ino), &name, area);
			out.push((child, kind(&meta.file_type()), name));
		}
		Ok(out)
	}

	/// Makes the folders a mount folder's local entries go in.
	fn make_room(&self, up: &Up, area: Area) -> Result<(), i32> {
		if let Up::Mount(path) = up {
			fs::DirBuilder::new().recursive(true).mode(0o755).create(self.room(path, area)).map_err(errno)?;
		}
		Ok(())
	}

	/// Creates a file and opens it: its attributes and the handle.
	pub fn create(&self, up: Up, name: &str, area: Area, mode: u32, flags: i32) -> Result<(FileAttr, u64), i32> {
		self.make_room(&up, area)?;
		let mut options = open_options(flags);
		options.create(true).mode(mode & 0o7777);
		if flags & libc::O_EXCL != 0 {
			options.create_new(true);
		}
		let (mut names, waited) = self.unsealed(|names| self.ino_under(names, &up, name, area));
		if waited && self.ino_under(&names, &up, name, area).is_none() {
			// The file of that name a cache move had is in the folder now, not made again here.
			return Err(libc::ESTALE);
		}
		let (disk, area) = self.disk_under(&names, &up, name, area)?;
		let file = options.open(&disk).map_err(errno)?;
		let meta = file.metadata().map_err(errno)?;
		known(&mut names, meta.ino() | LOCAL, up, name, area);
		let fh = self.hold(file, meta.ino() | LOCAL, flags);
		drop(names);
		Ok((self.attr(&meta), fh))
	}

	pub fn mkdir(&self, up: Up, name: &str, area: Area, mode: u32) -> Result<FileAttr, i32> {
		self.make_room(&up, area)?;
		let mut names = self.names.lock().unwrap();
		let (disk, area) = self.disk_under(&names, &up, name, area)?;
		fs::DirBuilder::new().mode(mode & 0o7777).create(&disk).map_err(errno)?;
		self.known_at(&mut names, up, name, area, &disk)
	}

	pub fn symlink(&self, up: Up, name: &str, area: Area, target: &Path) -> Result<FileAttr, i32> {
		self.make_room(&up, area)?;
		let mut names = self.names.lock().unwrap();
		let (disk, area) = self.disk_under(&names, &up, name, area)?;
		std::os::unix::fs::symlink(target, &disk).map_err(errno)?;
		self.known_at(&mut names, up, name, area, &disk)
	}

	pub fn readlink(&self, ino: u64) -> Result<Vec<u8>, i32> {
		let names = self.names.lock().unwrap();
		let (disk, _) = self.disk_at(&names, ino)?;
		fs::read_link(disk).map(|t| t.as_os_str().as_bytes().to_vec()).map_err(errno)
	}

	/// A second name for a local file, in the same area.
	pub fn link(&self, ino: u64, up: Up, name: &str, area: Area) -> Result<FileAttr, i32> {
		let mut names = self.names.lock().unwrap();
		let (from, from_area) = self.disk_at(&names, ino)?;
		if from_area != area {
			return Err(libc::EXDEV);
		}
		self.make_room(&up, area)?;
		let (to, area) = self.disk_under(&names, &up, name, area)?;
		fs::hard_link(from, &to).map_err(errno)?;
		self.known_at(&mut names, up, name, area, &to)
	}

	pub fn unlink(&self, up: &Up, name: &str, area: Area) -> Result<(), i32> {
		let (mut names, waited) = self.unsealed(|names| self.ino_under(names, up, name, area));
		let (disk, _) = self.disk_under(&names, up, name, area).map_err(stale(waited))?;
		let ino = fs::symlink_metadata(&disk).map_err(errno).map_err(stale(waited))?.ino() | LOCAL;
		fs::remove_file(disk).map_err(errno)?;
		forget(&mut names, ino, up, name);
		Ok(())
	}

	pub fn rmdir(&self, up: &Up, name: &str, area: Area) -> Result<(), i32> {
		let mut names = self.names.lock().unwrap();
		let (disk, _) = self.disk_under(&names, up, name, area)?;
		let ino = fs::symlink_metadata(&disk).map_err(errno)?.ino() | LOCAL;
		fs::remove_dir(disk).map_err(errno)?;
		forget(&mut names, ino, up, name);
		Ok(())
	}

	/// Takes the file, or the empty folder, at `disk` off the disk once a cache move has it in the folder
	/// (`mount/on_disk.rs`), with every name that reached it there: a hard link to it elsewhere keeps just its own.
	pub fn moved_out(&self, disk: &Path) -> Result<(), i32> {
		let mut names = self.names.lock().unwrap();
		let meta = fs::symlink_metadata(disk).map_err(errno)?;
		self.take_off(&mut names, disk, &meta)
	}

	/// `moved_out` for the file a cache move sealed (`seal`) as `ino`: not one that took its place at `disk` since
	/// (`EBUSY`), which the move is made again for.
	pub fn moved_file_out(&self, disk: &Path, ino: u64) -> Result<(), i32> {
		let mut names = self.names.lock().unwrap();
		let meta = fs::symlink_metadata(disk).map_err(errno)?;
		if meta.ino() | LOCAL != ino {
			return Err(libc::EBUSY);
		}
		self.take_off(&mut names, disk, &meta)
	}

	fn take_off(&self, names: &mut Names, disk: &Path, meta: &fs::Metadata) -> Result<(), i32> {
		let removed = if meta.is_dir() { fs::remove_dir(disk) } else { fs::remove_file(disk) };
		removed.map_err(errno)?;
		let ino = meta.ino() | LOCAL;
		let gone: Vec<(Up, String)> = names
			.get(&ino)
			.into_iter()
			.flatten()
			.filter(|(up, name, area)| self.disk_under(names, up, name, *area).is_ok_and(|(at, _)| at == disk))
			.map(|(up, name, _)| (up.clone(), name.clone()))
			.collect();
		for (up, name) in gone {
			forget(names, ino, &up, &name);
		}
		Ok(())
	}

	/// Seals the local file at `disk` for a cache move that writes it into the folder (`mount/on_disk.rs`): the file,
	/// opened for reading, and its inode. Until `unseal`, an open of it for writing, a change of its attributes and one
	/// of a name it has wait (`unsealed`), so what the move reads is all that was written to it, and nothing is written
	/// to it once the move takes it off the disk. One the mount has open for writing, or another move has sealed, is not
	/// sealed (`EBUSY`): the move is made again until its writers are done.
	pub fn seal(&self, disk: &Path) -> Result<(File, u64), i32> {
		let names = self.names.lock().unwrap();
		self.seal_at(&names, disk)?.map_err(|_| libc::EBUSY)
	}

	/// `seal` for the cache file `name` in `up` (`mount/on_disk.rs`), and where it is on the disk. One the mount has open
	/// for writing is waited for up to `wait`, as a program's close is done before the kernel lets go of its handle.
	pub fn seal_name(&self, up: &Up, name: &str, area: Area, wait: Duration) -> Result<(File, u64, PathBuf), i32> {
		let until = Instant::now() + wait;
		loop {
			let names = self.names.lock().unwrap();
			let (disk, _) = self.disk_under(&names, up, name, area)?;
			let handles = match self.seal_at(&names, &disk)? {
				Ok((file, ino)) => return Ok((file, ino, disk)),
				Err(handles) => handles,
			};
			drop(names);
			let left = until.saturating_duration_since(Instant::now());
			if left.is_zero() {
				return Err(libc::EBUSY);
			}
			drop(self.released.wait_timeout(handles, left).unwrap());
		}
	}

	/// `seal` with the names held; the handles, held still, when the mount has the file open for writing, so a wait for
	/// one to be let go of (`release`) misses none.
	#[allow(clippy::type_complexity)]
	fn seal_at(&self, _names: &Names, disk: &Path) -> Result<Result<(File, u64), MutexGuard<'_, HashMap<u64, Handle>>>, i32> {
		// Not a pipe that took its place since it was listed, whose open would wait with the names held.
		let flags = libc::O_NOFOLLOW | libc::O_NONBLOCK;
		let file = OpenOptions::new().read(true).custom_flags(flags).open(disk).map_err(errno)?;
		let meta = file.metadata().map_err(errno)?;
		let ino = meta.ino() | LOCAL;
		if !meta.is_file() || self.sealed.lock().unwrap().contains(&ino) {
			return Err(libc::EBUSY);
		}
		let handles = self.handles.lock().unwrap();
		if handles.values().any(|h| h.writes && h.ino == ino) {
			return Ok(Err(handles));
		}
		drop(handles);
		self.sealed.lock().unwrap().insert(ino);
		Ok(Ok((file, ino)))
	}

	/// The cache move is done with the local file `ino` (`seal`).
	pub fn unseal(&self, ino: u64) {
		self.sealed.lock().unwrap().remove(&ino);
		self.lifted.notify_all();
	}

	/// The names, held once no cache move has the local file `changed` gives (with them held) sealed (`seal`), and
	/// whether that waited for one, with the names let go of meanwhile.
	fn unsealed(&self, changed: impl Fn(&Names) -> Option<u64>) -> (MutexGuard<'_, Names>, bool) {
		let mut waited = false;
		loop {
			let names = self.names.lock().unwrap();
			let Some(ino) = changed(&names) else { return (names, waited) };
			let mut sealed = self.sealed.lock().unwrap();
			if !sealed.contains(&ino) {
				drop(sealed);
				return (names, waited);
			}
			drop(names);
			while sealed.contains(&ino) {
				sealed = self.lifted.wait(sealed).unwrap();
			}
			waited = true;
		}
	}

	/// The local inode of the file `name` in `up` names, if one is on the disk.
	fn ino_under(&self, names: &Names, up: &Up, name: &str, area: Area) -> Option<u64> {
		let (disk, _) = self.disk_under(names, up, name, area).ok()?;
		fs::symlink_metadata(disk).ok().map(|m| m.ino() | LOCAL)
	}

	/// Renames within one area; `exchange` swaps the two (RENAME_EXCHANGE), `no_replace` refuses an existing target.
	pub fn rename(
		&self,
		from: (&Up, &str),
		to: (&Up, &str),
		area: Area,
		no_replace: bool,
		exchange: bool,
	) -> Result<(), i32> {
		// A file a cache move has, renamed once it is in the folder; one that takes its name meanwhile is moved again
		// (`moved_file_out`).
		let (mut names, waited) = self.unsealed(|names| self.ino_under(names, from.0, from.1, area));
		let (source, from_area) = self.disk_under(&names, from.0, from.1, area).map_err(stale(waited))?;
		let (target, to_area) = self.disk_under(&names, to.0, to.1, area).map_err(stale(waited))?;
		if from_area != to_area {
			return Err(libc::EXDEV);
		}
		self.make_room(to.0, area)?;
		let flags = if exchange {
			libc::RENAME_EXCHANGE
		} else if no_replace {
			libc::RENAME_NOREPLACE
		} else {
			0
		};
		let ino_at = |p: &Path| fs::symlink_metadata(p).ok().map(|m| m.ino() | LOCAL);
		let (moved, replaced) = (ino_at(&source), ino_at(&target));
		renameat2(&source, &target, flags).map_err(stale(waited))?;
		if moved.is_some() && moved == replaced {
			// Two names of one file: the rename left both.
			return Ok(());
		}
		if let Some(ino) = replaced {
			forget(&mut names, ino, to.0, to.1);
		}
		if let Some(ino) = moved {
			forget(&mut names, ino, from.0, from.1);
			known(&mut names, ino, to.0.clone(), to.1, area);
		}
		if let (true, Some(ino)) = (exchange, replaced) {
			known(&mut names, ino, from.0.clone(), from.1, area);
		}
		Ok(())
	}

	/// Changes a local inode's mode, size or times.
	pub fn setattr(
		&self,
		ino: u64,
		mode: Option<u32>,
		size: Option<u64>,
		times: (Option<std::time::SystemTime>, Option<std::time::SystemTime>),
	) -> Result<FileAttr, i32> {
		let (names, waited) = self.unsealed(|_| Some(ino));
		let (disk, _) = self.disk_at(&names, ino).map_err(stale(waited))?;
		if let Some(mode) = mode {
			fs::set_permissions(&disk, fs::Permissions::from_mode(mode & 0o7777)).map_err(errno)?;
		}
		if let Some(size) = size {
			OpenOptions::new().write(true).open(&disk).and_then(|f| f.set_len(size)).map_err(errno)?;
		}
		if times.0.is_some() || times.1.is_some() {
			let mut t = fs::FileTimes::new();
			if let Some(a) = times.0 {
				t = t.set_accessed(a);
			}
			if let Some(m) = times.1 {
				t = t.set_modified(m);
			}
			// A folder or a file alike: opened for reading only, as utimensat would need no more.
			File::open(&disk).and_then(|f| f.set_times(t)).map_err(errno)?;
		}
		drop(names);
		self.getattr(ino)
	}

	/// Opens a local file: the handle. It is found, opened and kept with the names held (`disk_at`, `hold`), once no
	/// cache move has it sealed where the open changes it (`unsealed`), and what was opened is checked to be `ino` before
	/// a truncate touches it.
	pub fn open_file(&self, ino: u64, flags: i32) -> Result<u64, i32> {
		let changes = flags & libc::O_ACCMODE != libc::O_RDONLY || flags & libc::O_TRUNC != 0;
		let (names, waited) = self.unsealed(|_| changes.then_some(ino));
		let (disk, _) = self.disk_at(&names, ino).map_err(stale(waited))?;
		let options = open_options(flags & !libc::O_TRUNC).custom_flags(libc::O_NOFOLLOW).open(disk);
		let file = options.map_err(errno).map_err(stale(waited))?;
		if file.metadata().map_err(errno)?.ino() | LOCAL != ino {
			return Err(libc::ESTALE);
		}
		if flags & libc::O_TRUNC != 0 {
			file.set_len(0).map_err(errno)?;
		}
		let fh = self.hold(file, ino, flags);
		drop(names);
		Ok(fh)
	}

	/// Keeps `file`, the local file `ino` opened with `flags`: its handle. With the names held, so a cache move's `seal`
	/// sees every handle that writes to the file.
	fn hold(&self, file: File, ino: u64, flags: i32) -> u64 {
		let fh = self.next_fh.fetch_add(1, Ordering::SeqCst) | LOCAL;
		let writes = flags & libc::O_ACCMODE != libc::O_RDONLY;
		self.handles.lock().unwrap().insert(fh, Handle { file, ino, writes });
		fh
	}

	pub fn read(&self, fh: u64, offset: u64, size: u32) -> Result<Vec<u8>, i32> {
		use std::os::unix::fs::FileExt;
		let handles = self.handles.lock().unwrap();
		let file = handles.get(&fh).ok_or(libc::EBADF)?.file.try_clone().map_err(errno)?;
		drop(handles);
		let mut buf = vec![0; size as usize];
		let mut read = 0;
		while read < buf.len() {
			match file.read_at(&mut buf[read..], offset + read as u64) {
				Ok(0) => break,
				Ok(n) => read += n,
				Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
				Err(e) => return Err(errno(e)),
			}
		}
		buf.truncate(read);
		Ok(buf)
	}

	pub fn write(&self, fh: u64, offset: u64, data: &[u8]) -> Result<u32, i32> {
		use std::os::unix::fs::FileExt;
		let handles = self.handles.lock().unwrap();
		let file = handles.get(&fh).ok_or(libc::EBADF)?.file.try_clone().map_err(errno)?;
		drop(handles);
		file.write_all_at(data, offset).map_err(errno)?;
		Ok(data.len() as u32)
	}

	pub fn fsync(&self, fh: u64) -> Result<(), i32> {
		let handles = self.handles.lock().unwrap();
		handles.get(&fh).ok_or(libc::EBADF)?.file.sync_data().map_err(errno)
	}

	pub fn release(&self, fh: u64) {
		self.handles.lock().unwrap().remove(&fh);
		self.released.notify_all();
	}

	/// Puts `bytes` in place as a new file `name` in `up` (executable when `executable`) at once, as a rename puts a file
	/// (`mount/on_disk.rs`): over the file there, kept aside until the move is kept or undone (`Placed`), unless
	/// `no_replace` (`EEXIST`); never over a folder (`EISDIR`). One a cache move has sealed is waited for, and is gone
	/// into the folder after (`ESTALE`).
	pub fn place(
		&self,
		up: &Up,
		name: &str,
		area: Area,
		bytes: &[u8],
		executable: bool,
		no_replace: bool,
	) -> Result<Placed<'_>, i32> {
		static NEXT: AtomicU64 = AtomicU64::new(0);
		self.make_room(up, area)?;
		let started = std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
		let temp = self.root.join(GONE).join(format!("in-{started}-{}", NEXT.fetch_add(1, Ordering::SeqCst)));
		let written = (|| {
			let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&temp)?;
			file.write_all(bytes)?;
			file.set_permissions(fs::Permissions::from_mode(if executable { 0o755 } else { 0o644 }))?;
			Ok(file.metadata()?.ino() | LOCAL)
		})();
		let placed = written.map_err(errno).and_then(|ino| {
			let (mut names, waited) = self.unsealed(|names| self.ino_under(names, up, name, area));
			let (target, _) = self.disk_under(&names, up, name, area).map_err(stale(waited))?;
			let replaced = match fs::symlink_metadata(&target) {
				Ok(m) if m.is_dir() => return Err(libc::EISDIR),
				Ok(_) if no_replace => return Err(libc::EEXIST),
				Ok(m) => Some(m.ino() | LOCAL),
				Err(e) if e.kind() == io::ErrorKind::NotFound && waited => return Err(libc::ESTALE),
				Err(e) if e.kind() == io::ErrorKind::NotFound => None,
				Err(e) => return Err(errno(e)),
			};
			let flags = if replaced.is_some() { libc::RENAME_EXCHANGE } else { libc::RENAME_NOREPLACE };
			renameat2(&temp, &target, flags)?;
			if let Some(old) = replaced {
				forget(&mut names, old, up, name);
			}
			known(&mut names, ino, up.clone(), name, area);
			Ok((ino, replaced))
		});
		match placed {
			Ok((ino, replaced)) => {
				Ok(Placed { local: self, up: up.clone(), name: name.to_string(), area, aside: temp, ino, replaced })
			}
			Err(e) => {
				let _ = fs::remove_file(&temp);
				Err(e)
			}
		}
	}

	/// The files and folders under a cache folder's disk path, folders before what they hold, with their paths below
	/// it: what moves into the folder when its name leaves the list.
	pub fn walk(&self, disk: &Path) -> io::Result<Vec<(String, fs::Metadata)>> {
		let mut out = Vec::new();
		let mut todo = vec![String::new()];
		while let Some(rel) = todo.pop() {
			for entry in fs::read_dir(if rel.is_empty() { disk.to_path_buf() } else { disk.join(&rel) })? {
				let entry = entry?;
				let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
				let rel = crate::proto::join(&rel, &name);
				let meta = entry.metadata()?;
				if meta.is_dir() {
					todo.push(rel.clone());
				}
				out.push((rel, meta));
			}
		}
		Ok(out)
	}
}

/// A file `Local::place` put in place, until the move it is for is kept (`keep`) or undone (`undo`).
pub struct Placed<'a> {
	local: &'a Local,
	up: Up,
	name: String,
	area: Area,
	/// Where the file it replaced is meanwhile.
	aside: PathBuf,
	ino: u64,
	replaced: Option<u64>,
}

impl Placed<'_> {
	/// The move is done: the file it replaced is taken off the disk.
	pub fn keep(self) {
		if self.replaced.is_some() {
			take_off(self.aside);
		}
	}

	/// The move is not made: the file it replaced is back, unless a change since put another in its place.
	pub fn undo(self) {
		let local = self.local;
		let (up, name, area) = (&self.up, self.name.as_str(), self.area);
		let (mut names, _) = local.unsealed(|names| local.ino_under(names, up, name, area));
		let target = local.disk_under(&names, up, name, area).map(|(disk, _)| disk);
		let here = target.as_ref().ok().and_then(|t| fs::symlink_metadata(t).ok()).map(|m| m.ino() | LOCAL);
		let back = match (&target, self.replaced) {
			(Ok(target), Some(_)) if here == Some(self.ino) => renameat2(&self.aside, target, libc::RENAME_EXCHANGE),
			(Ok(target), None) if here == Some(self.ino) => fs::remove_file(target).map_err(errno),
			_ => Err(libc::ESTALE),
		};
		if back.is_ok() {
			forget(&mut names, self.ino, up, name);
			if let Some(old) = self.replaced {
				known(&mut names, old, up.clone(), name, area);
			}
		}
		drop(names);
		if self.replaced.is_some() {
			take_off(self.aside);
		}
	}
}

/// renameat2 of `from` to `to` with `flags`.
fn renameat2(from: &Path, to: &Path, flags: u32) -> Result<(), i32> {
	let c = |p: &Path| std::ffi::CString::new(p.as_os_str().as_bytes()).map_err(|_| libc::EINVAL);
	let (from, to) = (c(from)?, c(to)?);
	// SAFETY: two valid C strings; renameat2 reads them only.
	if unsafe { libc::renameat2(libc::AT_FDCWD, from.as_ptr(), libc::AT_FDCWD, to.as_ptr(), flags) } != 0 {
		return Err(io::Error::last_os_error().raw_os_error().unwrap_or(libc::EIO));
	}
	Ok(())
}

fn kind(t: &fs::FileType) -> FileType {
	use std::os::unix::fs::FileTypeExt;
	if t.is_dir() {
		FileType::Directory
	} else if t.is_symlink() {
		FileType::Symlink
	} else if t.is_fifo() {
		FileType::NamedPipe
	} else if t.is_socket() {
		FileType::Socket
	} else {
		FileType::RegularFile
	}
}

/// The options an open with `flags` asks for (its access mode, append and truncate).
fn open_options(flags: i32) -> OpenOptions {
	let mut o = OpenOptions::new();
	match flags & libc::O_ACCMODE {
		libc::O_WRONLY => o.write(true),
		libc::O_RDWR => o.read(true).write(true),
		_ => o.read(true),
	};
	if flags & libc::O_APPEND != 0 {
		o.append(true);
	}
	if flags & libc::O_TRUNC != 0 {
		o.truncate(true);
	}
	o
}

pub fn errno(e: io::Error) -> i32 {
	e.raw_os_error().unwrap_or(libc::EIO)
}

/// A name from the kernel as the local files take it.
pub fn name_str(name: &OsStr) -> Option<&str> {
	name.to_str().filter(|n| crate::proto::valid_name(n))
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::sync::atomic::AtomicBool;

	fn local(tag: &str, view: &str) -> (Local, PathBuf) {
		let dir = std::env::temp_dir().join(format!("qorpera-local-{tag}-{}", std::process::id()));
		(Local::open(&dir, view, (1000, 1000), None).unwrap(), dir)
	}

	/// A sealed file, unsealed when dropped: a check that fails lets the changes waiting on it end, and the test fail.
	struct Sealed<'a>(&'a Local, u64);

	impl Drop for Sealed<'_> {
		fn drop(&mut self) {
			self.0.unseal(self.1);
		}
	}

	#[test]
	fn seeds_and_git_files() {
		assert!(git_file("code/o/n/repo.git/config") && git_file("code/o/n/repo.git/hooks/pre-commit"));
		assert!(git_file("code/o/n/repo.git/worktrees/w/config.worktree"));
		assert!(!git_file("code/o/n/repo.git/refs/heads/x") && !git_file("code/o/n/worktrees/w/config"));
		assert_eq!(seed_of("code/o/n/repo.git/hooks/x").as_deref(), Some("code/o/n/repo.git"));
		let worktree = Some("code/o/n/repo.git/worktrees/w");
		assert_eq!(seed_of("code/o/n/repo.git/worktrees/w/config.worktree").as_deref(), worktree);
		assert_eq!(seed_of("code/o/n/repo.git/worktrees/w").as_deref(), worktree);
		assert_eq!(seed_of("code/o/n/repo.git").as_deref(), Some("code/o/n/repo.git"));
		assert_eq!(seed_of("code/o/n/repo.git/worktrees"), None);
		assert_eq!(seed_of("code/o/n/repo.git/worktrees/w/HEAD"), None);
		assert_eq!(seed_of("code/o/n/repo.git/refs/heads"), None);
		assert_eq!(seed_of("code/o/n/worktrees/w/x"), None);
	}

	#[test]
	fn files_live_on_the_disk_by_path() {
		let (l, dir) = local("files", "v1");
		let up = Up::Mount("code/o/n/repo.git".to_string());
		let hooks = l.mkdir(up.clone(), "hooks", Area::Git, 0o755).unwrap();
		let hooks_ino = hooks.ino.0;
		assert!(is_local(hooks_ino) && hooks.kind == FileType::Directory);
		let (attr, fh) = l.create(Up::Local(hooks_ino), "pre-commit", Area::Git, 0o755, libc::O_WRONLY).unwrap();
		assert_eq!(l.write(fh, 0, b"#!/bin/sh\n").unwrap(), 10);
		l.release(fh);
		assert_eq!(l.path(attr.ino.0), Some(("code/o/n/repo.git/hooks/pre-commit".to_string(), Area::Git)));
		assert_eq!(fs::read(dir.join("git/code/o/n/repo.git/hooks/pre-commit")).unwrap(), b"#!/bin/sh\n");
		assert_eq!(l.getattr(attr.ino.0).unwrap().perm, 0o755);
		assert_eq!(
			l.create(Up::Local(hooks_ino), "pre-commit", Area::Git, 0o644, libc::O_WRONLY | libc::O_EXCL).unwrap_err(),
			libc::EEXIST
		);
		let fh = l.open_file(attr.ino.0, libc::O_RDONLY).unwrap();
		assert_eq!(l.read(fh, 2, 100).unwrap(), b"/bin/sh\n");
		l.release(fh);
		l.rename((&Up::Local(hooks_ino), "pre-commit"), (&Up::Local(hooks_ino), "post-commit"), Area::Git, true, false)
			.unwrap();
		assert_eq!(l.path(attr.ino.0).unwrap().0, "code/o/n/repo.git/hooks/post-commit");
		let names: Vec<String> = l.children(hooks_ino).unwrap().into_iter().map(|c| c.2).collect();
		assert_eq!(names, ["post-commit"]);
		let roots: Vec<String> = l.entries_of("code/o/n/repo.git", Area::Git).into_iter().map(|c| c.2).collect();
		assert_eq!(roots, ["hooks"]);
		let cache = Up::Mount("code/o/n/worktrees/w".to_string());
		assert_eq!(
			l.rename((&Up::Local(hooks_ino), "post-commit"), (&cache, "x"), Area::Cache, false, false),
			Err(libc::EXDEV)
		);
		l.unlink(&Up::Local(hooks_ino), "post-commit", Area::Git).unwrap();
		l.rmdir(&up, "hooks", Area::Git).unwrap();
		fs::remove_dir_all(&dir).unwrap();
	}

	#[test]
	fn a_hard_link_keeps_the_names_left() {
		let (l, dir) = local("links", "v1");
		let up = Up::Mount("code/o/n/worktrees/w/target".to_string());
		let made = |name: &str| {
			let (attr, fh) = l.create(up.clone(), name, Area::Cache, 0o644, libc::O_WRONLY).unwrap();
			assert_eq!(l.write(fh, 0, name.as_bytes()).unwrap() as usize, name.len());
			l.release(fh);
			attr.ino.0
		};
		let a = made("a");
		l.link(a, up.clone(), "b", Area::Cache).unwrap();
		l.unlink(&up, "b", Area::Cache).unwrap();
		let b = made("b");
		assert_eq!(l.path(a).unwrap().0, "code/o/n/worktrees/w/target/a");
		let fh = l.open_file(a, libc::O_RDONLY).unwrap();
		assert_eq!(l.read(fh, 0, 100).unwrap(), b"a");
		l.release(fh);
		// A name of a file replaced by a rename.
		l.link(a, up.clone(), "c", Area::Cache).unwrap();
		l.rename((&up, "b"), (&up, "c"), Area::Cache, false, false).unwrap();
		assert_eq!(l.path(a).unwrap().0, "code/o/n/worktrees/w/target/a");
		assert_eq!(l.path(b).unwrap().0, "code/o/n/worktrees/w/target/c");
		// Two names of one file swapped: both stay.
		l.link(a, up.clone(), "d", Area::Cache).unwrap();
		l.rename((&up, "a"), (&up, "d"), Area::Cache, false, false).unwrap();
		assert!(l.disk(Area::Cache, "code/o/n/worktrees/w/target/a").exists());
		assert_eq!(l.path(a).unwrap().0, "code/o/n/worktrees/w/target/d");
		l.unlink(&up, "d", Area::Cache).unwrap();
		assert_eq!(l.path(a).unwrap().0, "code/o/n/worktrees/w/target/a");
		fs::remove_dir_all(&dir).unwrap();
	}

	#[test]
	fn an_open_by_a_hard_links_name_never_reaches_the_file_that_took_its_place() {
		let (l, dir) = local("link-race", "v1");
		let up = Up::Mount("code/o/n/worktrees/w/target".to_string());
		let (attr, fh) = l.create(up.clone(), "a", Area::Cache, 0o644, libc::O_WRONLY).unwrap();
		l.release(fh);
		let a = attr.ino.0;
		let sub = Up::Local(l.mkdir(up.clone(), "subdir", Area::Cache, 0o755).unwrap().ino.0);
		let victim = l.disk(Area::Cache, "code/o/n/worktrees/w/target/subdir").join("b");
		let stop = AtomicBool::new(false);
		std::thread::scope(|s| {
			// `a`'s second name comes and goes, another file taking its place each time.
			let other = s.spawn(|| {
				while !stop.load(Ordering::SeqCst) {
					l.link(a, sub.clone(), "b", Area::Cache).unwrap();
					l.unlink(&sub, "b", Area::Cache).unwrap();
					let (_, fh) = l.create(sub.clone(), "b", Area::Cache, 0o644, libc::O_WRONLY).unwrap();
					assert_eq!(l.write(fh, 0, b"other").unwrap(), 5);
					l.release(fh);
					assert_eq!(fs::read(&victim).unwrap(), b"other", "an open of a reached the file that took b");
					l.unlink(&sub, "b", Area::Cache).unwrap();
				}
			});
			let opens = (0..2000).try_for_each(|_| {
				let fh = l.open_file(a, libc::O_WRONLY | libc::O_TRUNC)?;
				let wrote = l.write(fh, 0, b"a");
				l.release(fh);
				wrote.map(drop)
			});
			stop.store(true, Ordering::SeqCst);
			other.join().unwrap();
			assert_eq!(opens, Ok(()));
		});
		assert_eq!(fs::read(l.disk(Area::Cache, "code/o/n/worktrees/w/target/a")).unwrap(), b"a");
		fs::remove_dir_all(&dir).unwrap();
	}

	#[test]
	fn a_stat_or_readlink_by_a_hard_links_name_never_reaches_the_link_that_took_its_place() {
		let (l, dir) = local("stat-race", "v1");
		let up = Up::Mount("code/o/n/worktrees/w/target".to_string());
		let a = l.symlink(up.clone(), "a", Area::Cache, Path::new("to-a")).unwrap().ino.0;
		let sub = Up::Local(l.mkdir(up.clone(), "subdir", Area::Cache, 0o755).unwrap().ino.0);
		let stop = AtomicBool::new(false);
		std::thread::scope(|s| {
			// `a`'s second name comes and goes, another link taking its place each time.
			let other = s.spawn(|| {
				while !stop.load(Ordering::SeqCst) {
					l.link(a, sub.clone(), "b", Area::Cache).unwrap();
					l.unlink(&sub, "b", Area::Cache).unwrap();
					l.symlink(sub.clone(), "b", Area::Cache, Path::new("to-other")).unwrap();
					l.unlink(&sub, "b", Area::Cache).unwrap();
				}
			});
			let reads = (0..2000).try_for_each(|_| {
				let attr = l.getattr(a)?;
				let target = l.readlink(a)?;
				if attr.ino.0 != a || attr.size != 4 || target != b"to-a" {
					return Err(-1);
				}
				Ok(())
			});
			stop.store(true, Ordering::SeqCst);
			other.join().unwrap();
			assert_eq!(reads, Ok(()), "a stat or readlink of a reached the link that took b");
		});
		fs::remove_dir_all(&dir).unwrap();
	}

	#[test]
	fn a_hard_link_a_cache_move_leaves_on_the_disk_keeps_its_own_names() {
		let (l, dir) = local("moved-out", "v1");
		let target = Up::Mount("code/o/n/worktrees/w/target".to_string());
		let (attr, fh) = l.create(target, "a", Area::Cache, 0o644, libc::O_WRONLY).unwrap();
		l.release(fh);
		let a = attr.ino.0;
		let modules = l.mkdir(Up::Mount("code/o/n/worktrees/w".to_string()), "node_modules", Area::Cache, 0o755).unwrap();
		l.link(a, Up::Local(modules.ino.0), "b", Area::Cache).unwrap();
		assert_eq!(l.path(a), Some(("code/o/n/worktrees/w/node_modules/b".to_string(), Area::Cache)));
		// Git came to track node_modules: the move has b in the folder, and takes it and its folder off the disk.
		let modules = l.disk(Area::Cache, "code/o/n/worktrees/w/node_modules");
		l.moved_out(&modules.join("b")).unwrap();
		l.moved_out(&modules).unwrap();
		assert_eq!(l.path(a), Some(("code/o/n/worktrees/w/target/a".to_string(), Area::Cache)));
		assert_eq!(l.getattr(a).map(|attr| attr.nlink), Ok(1));
		l.release(l.open_file(a, libc::O_RDONLY).unwrap());
		fs::remove_dir_all(&dir).unwrap();
	}

	#[test]
	fn a_file_a_cache_move_has_sealed_changes_only_once_the_move_is_done() {
		use std::io::Read;
		let (l, dir) = local("sealed", "v1");
		let up = Up::Mount("code/o/n/worktrees/w/target".to_string());
		let (attr, fh) = l.create(up.clone(), "a", Area::Cache, 0o644, libc::O_WRONLY).unwrap();
		let (a, disk) = (attr.ino.0, l.disk(Area::Cache, "code/o/n/worktrees/w/target/a"));
		// Open for writing: the move waits for its writer.
		assert_eq!(l.seal(&disk).map(|(_, ino)| ino), Err(libc::EBUSY));
		assert_eq!(l.write(fh, 0, b"ab").unwrap(), 2);
		l.release(fh);
		let (mut file, ino) = l.seal(&disk).unwrap();
		assert_eq!(ino, a);
		std::thread::scope(|s| {
			let sealed = Sealed(&l, ino);
			// An open for writing, a truncate, a create, an unlink or a rename waits until the move is done with the
			// file; a read does not.
			let opened = s.spawn(|| l.open_file(a, libc::O_WRONLY).map(drop));
			let truncated = s.spawn(|| l.setattr(a, None, Some(0), (None, None)).map(drop));
			let made = s.spawn(|| l.create(up.clone(), "a", Area::Cache, 0o644, libc::O_WRONLY).map(drop));
			let removed = s.spawn(|| l.unlink(&up, "a", Area::Cache));
			let renamed = s.spawn(|| l.rename((&up, "a"), (&up, "z"), Area::Cache, false, false));
			std::thread::sleep(Duration::from_millis(300));
			let waiting = [&opened, &truncated, &removed, &renamed].iter().all(|t| !t.is_finished());
			assert!(waiting && !made.is_finished());
			let fh = l.open_file(a, libc::O_RDONLY).unwrap();
			assert_eq!(l.read(fh, 0, 100).unwrap(), b"ab");
			l.release(fh);
			let mut read = Vec::new();
			file.read_to_end(&mut read).unwrap();
			assert_eq!(read, b"ab");
			// In the folder now: the name and the inode they asked by are stale, to be looked up again.
			l.moved_file_out(&disk, ino).unwrap();
			drop(sealed);
			for waited in [opened, truncated, made, removed, renamed] {
				assert_eq!(waited.join().unwrap(), Err(libc::ESTALE));
			}
		});
		assert!(!disk.exists() && !l.disk(Area::Cache, "code/o/n/worktrees/w/target/z").exists());
		// A move that did not finish: the change goes on, with the file on the disk still.
		let (attr, fh) = l.create(up.clone(), "b", Area::Cache, 0o644, libc::O_WRONLY).unwrap();
		l.release(fh);
		let disk = l.disk(Area::Cache, "code/o/n/worktrees/w/target/b");
		let (_, ino) = l.seal(&disk).unwrap();
		std::thread::scope(|s| {
			let sealed = Sealed(&l, ino);
			let opened = s.spawn(|| l.open_file(attr.ino.0, libc::O_WRONLY | libc::O_TRUNC));
			std::thread::sleep(Duration::from_millis(300));
			assert!(!opened.is_finished());
			drop(sealed);
			let fh = opened.join().unwrap().unwrap();
			assert_eq!(l.seal(&disk).map(|(_, ino)| ino), Err(libc::EBUSY));
			l.release(fh);
		});
		// A file that took its name meanwhile stays on the disk, for the move to be made again.
		let (_, ino) = l.seal(&disk).unwrap();
		let (_, fh) = l.create(up.clone(), "c", Area::Cache, 0o644, libc::O_WRONLY).unwrap();
		l.release(fh);
		l.rename((&up, "c"), (&up, "b"), Area::Cache, false, false).unwrap();
		assert_eq!(l.moved_file_out(&disk, ino), Err(libc::EBUSY));
		l.unseal(ino);
		assert!(disk.exists());
		fs::remove_dir_all(&dir).unwrap();
	}

	#[test]
	fn a_cache_file_open_for_writing_is_sealed_once_it_is_let_go_of_or_not_at_all() {
		let (l, dir) = local("seal-name", "v1");
		let up = Up::Mount("code/o/n/worktrees/w/node_modules".to_string());
		let (attr, fh) = l.create(up.clone(), "a", Area::Cache, 0o644, libc::O_WRONLY).unwrap();
		let a = attr.ino.0;
		// Open for writing: the seal waits for the mount to let go of it, and is not made if it does not in time.
		let started = Instant::now();
		assert_eq!(l.seal_name(&up, "a", Area::Cache, Duration::from_millis(200)).map(|s| s.1), Err(libc::EBUSY));
		assert!(started.elapsed() >= Duration::from_millis(200));
		std::thread::scope(|s| {
			let sealing = s.spawn(|| l.seal_name(&up, "a", Area::Cache, Duration::from_secs(10)).map(|(_, ino, disk)| (ino, disk)));
			std::thread::sleep(Duration::from_millis(300));
			let waiting = !sealing.is_finished();
			l.release(fh);
			assert!(waiting);
			let disk = l.disk(Area::Cache, "code/o/n/worktrees/w/node_modules/a");
			assert_eq!(sealing.join().unwrap(), Ok((a, disk)));
		});
		// Sealed by another move: not sealed again, at once.
		let started = Instant::now();
		assert_eq!(l.seal_name(&up, "a", Area::Cache, Duration::from_secs(10)).map(|s| s.1), Err(libc::EBUSY));
		assert!(started.elapsed() < Duration::from_secs(5));
		l.unseal(a);
		assert_eq!(l.seal_name(&up, "a", Area::Cache, Duration::ZERO).map(|s| s.1), Ok(a));
		assert_eq!(l.seal_name(&up, "b", Area::Cache, Duration::ZERO).map(|s| s.1), Err(libc::ENOENT));
		fs::remove_dir_all(&dir).unwrap();
	}

	#[test]
	fn a_placed_file_takes_its_name_whole_and_one_undone_gives_it_back() {
		let (l, dir) = local("place", "v1");
		let up = Up::Mount("code/o/n/worktrees/w".to_string());
		let disk = |name: &str| l.disk(Area::Cache, &format!("code/o/n/worktrees/w/{name}"));
		let ino = |name: &str| l.entry(up.clone(), name, Area::Cache).map(|a| a.ino.0);
		// Onto a new name: a file of its own, executable as asked; undone, the name is free again.
		l.place(&up, "a.log", Area::Cache, b"new", true, false).unwrap().keep();
		assert_eq!(fs::read(disk("a.log")).unwrap(), b"new");
		assert_eq!(fs::metadata(disk("a.log")).unwrap().permissions().mode() & 0o777, 0o755);
		l.place(&up, "c.log", Area::Cache, b"new", false, false).unwrap().undo();
		assert_eq!(ino("c.log"), Err(libc::ENOENT));
		// Over a file unless told not to (EEXIST), and never over a folder (EISDIR).
		let (old, fh) = l.create(up.clone(), "b.log", Area::Cache, 0o644, libc::O_WRONLY).unwrap();
		l.write(fh, 0, b"old").unwrap();
		l.release(fh);
		l.mkdir(up.clone(), "d", Area::Cache, 0o755).unwrap();
		assert_eq!(l.place(&up, "b.log", Area::Cache, b"x", false, true).map(drop), Err(libc::EEXIST));
		assert_eq!(l.place(&up, "d", Area::Cache, b"x", false, false).map(drop), Err(libc::EISDIR));
		// Undone: the file it replaced is back, by its name and inode.
		let placed = l.place(&up, "b.log", Area::Cache, b"newer", false, false).unwrap();
		assert_eq!(fs::read(disk("b.log")).unwrap(), b"newer");
		assert_ne!(ino("b.log"), Ok(old.ino.0));
		placed.undo();
		assert_eq!(fs::read(disk("b.log")).unwrap(), b"old");
		assert_eq!(ino("b.log"), Ok(old.ino.0));
		// Kept: the new file has the name.
		l.place(&up, "b.log", Area::Cache, b"newer", false, false).unwrap().keep();
		assert_eq!(fs::read(disk("b.log")).unwrap(), b"newer");
		assert_ne!(ino("b.log"), Ok(old.ino.0));
		// A name a cache move has sealed is waited for: gone into the folder since, it is stale.
		let (e, fh) = l.create(up.clone(), "e.log", Area::Cache, 0o644, libc::O_WRONLY).unwrap();
		l.release(fh);
		let (_, sealed, at) = l.seal_name(&up, "e.log", Area::Cache, Duration::ZERO).unwrap();
		assert_eq!(sealed, e.ino.0);
		std::thread::scope(|s| {
			let sealed = Sealed(&l, sealed);
			let placing = s.spawn(|| l.place(&up, "e.log", Area::Cache, b"x", false, false).map(drop));
			std::thread::sleep(Duration::from_millis(300));
			assert!(!placing.is_finished());
			l.moved_file_out(&at, sealed.1).unwrap();
			drop(sealed);
			assert_eq!(placing.join().unwrap(), Err(libc::ESTALE));
		});
		assert!(!disk("e.log").exists());
		// The files kept aside and the temporary ones of the refused places are all taken off the disk.
		let gone = || fs::read_dir(dir.join(GONE)).unwrap().count() == 0;
		let started = Instant::now();
		while !gone() && started.elapsed() < Duration::from_secs(5) {
			std::thread::sleep(Duration::from_millis(20));
		}
		assert!(gone());
		fs::remove_dir_all(&dir).unwrap();
	}

	#[test]
	fn another_views_git_files_go_and_its_caches_stay() {
		let (l, dir) = local("views", "v1");
		l.put("code/o/n/repo.git/config", Some(b"[core]\n"), false).unwrap();
		l.mark_seeded("code/o/n/repo.git");
		l.mkdir(Up::Mount("code/o/n/worktrees/w".to_string()), "node_modules", Area::Cache, 0o755).unwrap();
		drop(l);
		let again = Local::open(&dir, "v1", (0, 0), None).unwrap();
		assert!(again.seeded("code/o/n/repo.git") && dir.join("git/code/o/n/repo.git/config").exists());
		drop(again);
		let other = Local::open(&dir, "v2", (0, 0), None).unwrap();
		assert!(!other.seeded("code/o/n/repo.git") && !dir.join("git/code/o/n/repo.git/config").exists());
		assert!(other.disk(Area::Cache, "code/o/n/worktrees/w/node_modules").is_dir());
		let tops: Vec<String> = other.entries_of("code/o/n/worktrees/w", Area::Cache).into_iter().map(|e| e.2).collect();
		assert_eq!(tops, ["node_modules"]);
		fs::remove_dir_all(&dir).unwrap();
	}

	#[test]
	fn caches_live_by_the_folder_they_are_in_and_move_or_go_with_it() {
		let (l, dir) = local("mirrors", "v1");
		let made = |up: Up, name: &str| l.mkdir(up, name, Area::Cache, 0o755).unwrap().ino.0;
		let file = |up: Up, name: &str| {
			let (attr, fh) = l.create(up, name, Area::Cache, 0o644, libc::O_WRONLY).unwrap();
			l.release(fh);
			attr.ino.0
		};
		// The folder's root, and a folder below it.
		let store = made(Up::Mount(String::new()), ".pnpm-store");
		assert_eq!(l.path(store), Some((".pnpm-store".to_string(), Area::Cache)));
		assert!(dir.join("caches/t/.pnpm-store").is_dir());
		let modules = made(Up::Mount("a/b".to_string()), "node_modules");
		let x = file(Up::Local(modules), "x.js");
		assert!(dir.join("caches/d/a/d/b/t/node_modules/x.js").is_file());
		assert!(l.is_top("a/b", "node_modules") && !l.is_top("a", "b") && !l.is_top("a/b", "x.js"));
		assert!(l.tops("a/b") && !l.tops("a") && l.has_caches("a") && !l.has_caches("c"));
		assert_eq!(l.mirrors("a"), ["b"]);
		// A move of a name takes the cache folders of that name in and below a folder, not a file of that name.
		let moving = |path: &str, name: &str| l.moving_below(path, &[name.to_string()]);
		file(Up::Mount("e".to_string()), "dist");
		assert!(moving("a", "node_modules") && moving("a/b", "node_modules") && !moving("a", "dist") && !moving("e", "dist"));
		// The node renamed a to c, in place of an empty c whose folder below had caches.
		made(Up::Mount("c/old".to_string()), "dist");
		l.renamed("a", "c");
		assert!(!l.has_caches("a") && !l.is_top("c/old", "dist") && l.mirrors("c") == ["b"]);
		assert_eq!(l.path(x), Some(("c/b/node_modules/x.js".to_string(), Area::Cache)));
		assert!(l.getattr(x).is_ok());
		// The node took a folder git came to track in place of the cache: what was in it is that folder's caches now.
		let built = made(Up::Mount("c/b".to_string()), "dist");
		let y = file(Up::Local(built), "y.js");
		assert_eq!(l.convert("c/b", "dist", true).unwrap(), true);
		assert!(!l.is_top("c/b", "dist") && l.is_top("c/b/dist", "y.js"));
		assert_eq!(l.name(y), Some((Up::Mount("c/b/dist".to_string()), "y.js".to_string(), Area::Cache)));
		assert!(l.whole("c/b/dist") && l.moving_below("c", &[]) && !l.moving_below("e", &[]));
		// One whose folder has caches of its own stays as it is.
		let again = made(Up::Mount("c/b".to_string()), "dist");
		assert_eq!(l.convert("c/b", "dist", true).unwrap(), false);
		assert!(l.is_top("c/b", "dist") && l.is_top("c/b/dist", "y.js"));
		// A folder git tracks paths in: the rest of it stays the caches of the node's folder, not all moving.
		let tracked = made(Up::Mount("e".to_string()), "logs");
		let kept = file(Up::Local(tracked), "keep.log");
		assert_eq!(l.convert("e", "logs", false).unwrap(), true);
		assert!(l.is_top("e/logs", "keep.log") && !l.whole("e/logs") && !l.moving_below("e", &[]));
		// Again, where that folder has caches already: what is in it joins them, but for a name they have.
		let more = made(Up::Mount("e".to_string()), "logs");
		let (twin, new) = (file(Up::Local(more), "keep.log"), file(Up::Local(more), "new.log"));
		assert_eq!(l.convert("e", "logs", false).unwrap(), true);
		assert!(!l.is_top("e", "logs") && l.is_top("e/logs", "keep.log") && l.is_top("e/logs", "new.log"));
		assert_eq!(l.name(new), Some((Up::Mount("e/logs".to_string()), "new.log".to_string(), Area::Cache)));
		assert!(l.name(kept).is_some() && l.name(twin).is_none() && l.name(more).is_none());
		assert!(!l.whole("e/logs") && !dir.join("caches/d/e/t/logs").exists());
		// The node's entry wins (rule 1), and a folder gone takes the caches in and below it.
		l.gone_top("c/b", "dist");
		assert!(!l.is_top("c/b", "dist") && l.name(again).is_none() && l.getattr(again) == Err(libc::ESTALE));
		l.drop_mirror("c");
		assert!(!l.has_caches("c") && l.name(x).is_none() && l.name(modules).is_none() && l.name(y).is_none());
		// Moved into a repository's git folder, where no cache is shown, they go too.
		let z = file(Up::Mount("d".to_string()), "out");
		l.renamed("d", "code/o/n/repo.git/d");
		assert!(!l.has_caches("d") && !l.has_caches("code/o/n/repo.git/d") && l.name(z).is_none());
		assert_eq!(l.path(store), Some((".pnpm-store".to_string(), Area::Cache)));
		fs::remove_dir_all(&dir).unwrap();
	}

	#[test]
	fn the_caches_of_5ds_program_go_at_the_start() {
		let dir = std::env::temp_dir().join(format!("qorpera-local-old-cache-{}", std::process::id()));
		fs::create_dir_all(dir.join("cache/code/o/n/worktrees/w/node_modules")).unwrap();
		fs::create_dir_all(dir.join("gone/1-0/x")).unwrap();
		let l = Local::open(&dir, "v1", (0, 0), None).unwrap();
		assert!(!dir.join("cache").exists());
		assert!(l.entries_of("code/o/n/worktrees/w", Area::Cache).is_empty());
		drop(l);
		fs::remove_dir_all(&dir).unwrap();
	}

	#[test]
	fn a_seeded_link_is_a_link_on_the_disk_in_place_of_one_an_earlier_seed_left() {
		let (l, dir) = local("seeded-link", "v1");
		let disk = dir.join("git/code/o/n/repo.git/hooks/pre-commit");
		l.put_link("code/o/n/repo.git/hooks/pre-commit", b"/bin/false").unwrap();
		l.put_link("code/o/n/repo.git/hooks/pre-commit", b"../../tools/check").unwrap();
		assert_eq!(fs::read_link(&disk).unwrap(), Path::new("../../tools/check"));
		fs::remove_dir_all(&dir).unwrap();
	}
}
