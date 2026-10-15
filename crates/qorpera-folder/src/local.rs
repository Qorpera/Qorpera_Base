//! The session's own files on the machine's disk (RUNTIME-FOLDER-CODING-MACHINES.md "Code areas and git" and "The
//! cache list"): files the mount shows at their paths in the folder but never sends to the node, so they are never
//! published and other views and machines see nothing of them.
//!
//! - **Session-local git files** (`git::session_local`): a repository's `config`, `hooks/**` and `info/**`, and a
//!   worktree's `config.worktree`. The session gets its own copy, seeded from the published one the first time the
//!   mount reaches the repository (or the worktree's git folder), and what git writes there stays here. The node's own
//!   copy of those paths is never shown.
//! - **Cache folders** (`cache.rs`): inside a worktree, a folder git or a build makes under a name on the worktree's
//!   cache list, where the node has nothing at that path. Whatever the node has at a path wins.
//!
//! They live in the local folder (`--local-dir`, by default `local/` in the mount's state folder): `git/<path>` and
//! `cache/<path>`, by their paths in the folder. A local folder that a program started for another view finds is that
//! view's: its git files go (they are seeded again), its caches stay (they can be rebuilt at any time, and are only
//! ever the session's own).
//!
//! The kernel knows a local file by its inode on the disk with the top bit set (`LOCAL`); the node's inodes never have
//! it. So does a handle open on one.

use crate::cache::CacheList;
use crate::git;
use fuser::{FileAttr, FileType, INodeNo};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};

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
			Area::Cache => "cache",
		}
	}
}

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

pub struct Local {
	root: PathBuf,
	/// By local inode: the names it is known by (the folder it is in, its name, its area), the latest last. A file with
	/// more than one name (a hard link) is found by the latest, and by one left when that one goes.
	names: Mutex<Names>,
	/// The seeds done, written through to `seeded` so a program started again does not seed over the session's changes.
	seeded: Mutex<HashSet<String>>,
	/// Held while a seed is copied, so a second lookup waits for it rather than finding half of it.
	pub seeding: Mutex<()>,
	handles: Mutex<HashMap<u64, File>>,
	next_fh: AtomicU64,
	pub cache: Mutex<CacheList>,
	/// Held while cache folders move into the folder (`mount/on_disk.rs`), so no two move the same.
	pub moving: Mutex<()>,
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
		for area in [Area::Git, Area::Cache] {
			fs::DirBuilder::new().recursive(true).mode(0o700).create(root.join(area.dir()))?;
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
			next_fh: AtomicU64::new(1),
			cache: Mutex::new(CacheList::open(&root.join("cache-left.jsonl"), marker)?),
			moving: Mutex::new(()),
			owner,
		})
	}

	/// Where the local file at the folder's `path` is on the disk.
	pub fn disk(&self, area: Area, path: &str) -> PathBuf {
		self.root.join(area.dir()).join(path)
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

	/// The local inode's folder, name and area.
	pub fn name(&self, ino: u64) -> Option<(Up, String, Area)> {
		self.names.lock().unwrap().get(&ino).and_then(|all| all.last()).cloned()
	}

	/// The local inode's path in the folder (`up` gives the path of a mount folder above it).
	pub fn path(&self, ino: u64) -> Option<(String, Area)> {
		let (mut up, name, area) = self.name(ino)?;
		let mut names = vec![name];
		loop {
			match up {
				Up::Mount(path) => {
					names.push(path);
					names.reverse();
					return Some((names.join("/"), area));
				}
				Up::Local(ino) => {
					let (next, name, _) = self.name(ino)?;
					names.push(name);
					up = next;
				}
			}
		}
	}

	/// Where the local inode is on the disk.
	pub fn disk_of(&self, ino: u64) -> Result<(PathBuf, Area), i32> {
		let (path, area) = self.path(ino).ok_or(libc::ENOENT)?;
		Ok((self.disk(area, &path), area))
	}

	/// Where `name` in `up` is on the disk, with its area (for a mount folder, the area `area` says).
	pub fn disk_in(&self, up: &Up, name: &str, area: Area) -> Result<(PathBuf, Area), i32> {
		match up {
			Up::Mount(path) => Ok((self.disk(area, &crate::proto::join(path, name)), area)),
			Up::Local(ino) => self.disk_of(*ino).map(|(dir, area)| (dir.join(name), area)),
		}
	}

	/// The entry for `name` in `up`, from the disk, now known by its inode.
	pub fn entry(&self, up: Up, name: &str, area: Area) -> Result<FileAttr, i32> {
		let (disk, area) = self.disk_in(&up, name, area)?;
		let mut names = self.names.lock().unwrap();
		let meta = fs::symlink_metadata(&disk).map_err(errno)?;
		known(&mut names, meta.ino() | LOCAL, up, name, area);
		drop(names);
		Ok(self.attr(&meta))
	}

	/// The attributes of a local inode, from the disk.
	pub fn getattr(&self, ino: u64) -> Result<FileAttr, i32> {
		let (disk, _) = self.disk_of(ino)?;
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
		let Ok(read) = fs::read_dir(self.disk(area, dir)) else { return Vec::new() };
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
		let (disk, area) = self.disk_of(ino)?;
		let mut out = Vec::new();
		let mut names = self.names.lock().unwrap();
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
			fs::DirBuilder::new().recursive(true).mode(0o755).create(self.disk(area, path)).map_err(errno)?;
		}
		Ok(())
	}

	/// Creates a file and opens it: its attributes and the handle.
	pub fn create(&self, up: Up, name: &str, area: Area, mode: u32, flags: i32) -> Result<(FileAttr, u64), i32> {
		self.make_room(&up, area)?;
		let (disk, _) = self.disk_in(&up, name, area)?;
		let mut options = open_options(flags);
		options.create(true).mode(mode & 0o7777);
		if flags & libc::O_EXCL != 0 {
			options.create_new(true);
		}
		let file = options.open(&disk).map_err(errno)?;
		let attr = self.entry(up, name, area)?;
		Ok((attr, self.hold(file)))
	}

	pub fn mkdir(&self, up: Up, name: &str, area: Area, mode: u32) -> Result<FileAttr, i32> {
		self.make_room(&up, area)?;
		let (disk, _) = self.disk_in(&up, name, area)?;
		fs::DirBuilder::new().mode(mode & 0o7777).create(&disk).map_err(errno)?;
		self.entry(up, name, area)
	}

	pub fn symlink(&self, up: Up, name: &str, area: Area, target: &Path) -> Result<FileAttr, i32> {
		self.make_room(&up, area)?;
		let (disk, _) = self.disk_in(&up, name, area)?;
		std::os::unix::fs::symlink(target, &disk).map_err(errno)?;
		self.entry(up, name, area)
	}

	pub fn readlink(&self, ino: u64) -> Result<Vec<u8>, i32> {
		let (disk, _) = self.disk_of(ino)?;
		fs::read_link(disk).map(|t| t.as_os_str().as_bytes().to_vec()).map_err(errno)
	}

	/// A second name for a local file, in the same area.
	pub fn link(&self, ino: u64, up: Up, name: &str, area: Area) -> Result<FileAttr, i32> {
		let (from, from_area) = self.disk_of(ino)?;
		if from_area != area {
			return Err(libc::EXDEV);
		}
		self.make_room(&up, area)?;
		let (to, _) = self.disk_in(&up, name, area)?;
		fs::hard_link(from, &to).map_err(errno)?;
		self.entry(up, name, area)
	}

	pub fn unlink(&self, up: &Up, name: &str, area: Area) -> Result<(), i32> {
		let (disk, _) = self.disk_in(up, name, area)?;
		let mut names = self.names.lock().unwrap();
		let ino = fs::symlink_metadata(&disk).map_err(errno)?.ino() | LOCAL;
		fs::remove_file(disk).map_err(errno)?;
		forget(&mut names, ino, up, name);
		Ok(())
	}

	pub fn rmdir(&self, up: &Up, name: &str, area: Area) -> Result<(), i32> {
		let (disk, _) = self.disk_in(up, name, area)?;
		let mut names = self.names.lock().unwrap();
		let ino = fs::symlink_metadata(&disk).map_err(errno)?.ino() | LOCAL;
		fs::remove_dir(disk).map_err(errno)?;
		forget(&mut names, ino, up, name);
		Ok(())
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
		let (source, from_area) = self.disk_in(from.0, from.1, area)?;
		let (target, to_area) = self.disk_in(to.0, to.1, area)?;
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
		let c = |p: &Path| std::ffi::CString::new(p.as_os_str().as_bytes()).map_err(|_| libc::EINVAL);
		let (source_c, target_c) = (c(&source)?, c(&target)?);
		let mut names = self.names.lock().unwrap();
		let ino_at = |p: &Path| fs::symlink_metadata(p).ok().map(|m| m.ino() | LOCAL);
		let (moved, replaced) = (ino_at(&source), ino_at(&target));
		// SAFETY: two valid C strings; renameat2 reads them only.
		let done = unsafe {
			libc::renameat2(libc::AT_FDCWD, source_c.as_ptr(), libc::AT_FDCWD, target_c.as_ptr(), flags)
		};
		if done != 0 {
			return Err(io::Error::last_os_error().raw_os_error().unwrap_or(libc::EIO));
		}
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
		let (disk, _) = self.disk_of(ino)?;
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
		self.getattr(ino)
	}

	/// Opens a local file: the handle.
	pub fn open_file(&self, ino: u64, flags: i32) -> Result<u64, i32> {
		let (disk, _) = self.disk_of(ino)?;
		let file = open_options(flags).open(disk).map_err(errno)?;
		Ok(self.hold(file))
	}

	fn hold(&self, file: File) -> u64 {
		let fh = self.next_fh.fetch_add(1, Ordering::SeqCst) | LOCAL;
		self.handles.lock().unwrap().insert(fh, file);
		fh
	}

	pub fn read(&self, fh: u64, offset: u64, size: u32) -> Result<Vec<u8>, i32> {
		use std::os::unix::fs::FileExt;
		let handles = self.handles.lock().unwrap();
		let file = handles.get(&fh).ok_or(libc::EBADF)?.try_clone().map_err(errno)?;
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
		let file = handles.get(&fh).ok_or(libc::EBADF)?.try_clone().map_err(errno)?;
		drop(handles);
		file.write_all_at(data, offset).map_err(errno)?;
		Ok(data.len() as u32)
	}

	pub fn fsync(&self, fh: u64) -> Result<(), i32> {
		let handles = self.handles.lock().unwrap();
		handles.get(&fh).ok_or(libc::EBADF)?.sync_data().map_err(errno)
	}

	pub fn release(&self, fh: u64) {
		self.handles.lock().unwrap().remove(&fh);
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

	fn local(tag: &str, view: &str) -> (Local, PathBuf) {
		let dir = std::env::temp_dir().join(format!("qorpera-local-{tag}-{}", std::process::id()));
		(Local::open(&dir, view, (1000, 1000), None).unwrap(), dir)
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
		assert!(dir.join("cache/code/o/n/worktrees/w/target/a").exists());
		assert_eq!(l.path(a).unwrap().0, "code/o/n/worktrees/w/target/d");
		l.unlink(&up, "d", Area::Cache).unwrap();
		assert_eq!(l.path(a).unwrap().0, "code/o/n/worktrees/w/target/a");
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
		assert!(dir.join("cache/code/o/n/worktrees/w/node_modules").is_dir());
		let walked: Vec<String> =
			other.walk(&dir.join("cache/code/o/n/worktrees")).unwrap().into_iter().map(|w| w.0).collect();
		assert_eq!(walked, ["w", "w/node_modules"]);
		fs::remove_dir_all(&dir).unwrap();
	}
}
