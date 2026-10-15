//! The mount's side of git on the mount (`git.rs`) and of the session's own files on the machine's disk (`local.rs`):
//! which of the kernel's requests the local files answer, what the mount refuses git, and what it does around git's
//! locks and its index.
//!
//! Each `local_*` hook takes the request's reply and hands it back when the node answers the request after all.

use super::*;
use crate::git::{self, Place};
use crate::index;
use crate::local::{self, is_local, Area, Up};
use crate::proto::{split, Entry, CHUNK, MAX_CHUNKS};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::os::unix::fs::PermissionsExt;

/// Whether the kernel must ask the node again for `path` each time: git's shared files, which other sessions change.
pub(super) fn fresh(path: &str) -> bool {
	matches!(git::place(path), Place::Git { rest, .. } if git::shared(rest))
}

/// A file git would read objects from elsewhere through (or its lock): never written.
pub(super) fn alternates(path: &str) -> bool {
	let path = path.strip_suffix(".lock").unwrap_or(path);
	matches!(git::place(path), Place::Git { rest, .. } if git::alternates(rest))
}

/// After a lock git took on a shared file `path` (`X.lock`) was made, the node gave the folder service the file, its
/// reflog and `packed-refs` as they are now: the mount forgets what it knew of them, so git reads those.
pub(super) fn locked(tree: &mut Tree, path: &str) {
	if let Place::Git { area, rest } = git::place(path) {
		if let Some(target) = git::locked(rest) {
			let paths = git::refreshed(area, target);
			// The kernel keeps none of them (`fresh`), so it needs no word.
			drop(tree.invalidate(paths.iter().map(String::as_str)));
		}
	}
}

fn when(t: Option<TimeOrNow>) -> Option<SystemTime> {
	t.map(|t| match t {
		TimeOrNow::SpecificTime(t) => t,
		TimeOrNow::Now => SystemTime::now(),
	})
}

impl Shared {
	/// Whether the node's file `ino` is one of git's shared files in a writable view (`fresh`).
	pub(super) fn fresh(&self, ino: u64) -> bool {
		self.writable && self.tree.lock().unwrap().path(ino).is_some_and(fresh)
	}

	/// Where `name` in the folder `parent` is answered by the local files, if it is: in a local folder, or a
	/// session-local git file (seeded first).
	fn here(&self, local: &Local, parent: u64, name: &str) -> Result<Option<(Up, Area)>, i32> {
		if is_local(parent) {
			let (_, _, area) = local.name(parent).ok_or(libc::ENOENT)?;
			return Ok(Some((Up::Local(parent), area)));
		}
		let Some(dir) = self.code_dir(parent) else { return Ok(None) };
		let path = join(&dir, name);
		if self.code_host || !local::git_file(&path) {
			return Ok(None);
		}
		if let Some(seed) = local::seed_of(&path) {
			self.seed(local, &seed)?;
		}
		Ok(Some((Up::Mount(dir), Area::Git)))
	}

	/// The path of the node's folder `dir`, if it is in a code area (where the local files can be).
	fn code_dir(&self, dir: u64) -> Option<String> {
		let tree = self.tree.lock().unwrap();
		tree.path(dir).filter(|p| p.starts_with("code/")).map(str::to_string)
	}

	/// Where `name` in the folder `parent` is answered by the local files, if it is: as `here`, or one of the session's
	/// cache folders (or a file in a cache's place) in a folder of the node's, where the node has nothing.
	fn found(&self, local: &Local, parent: u64, name: &str) -> Result<Option<(Up, Area)>, i32> {
		if let Some(found) = self.here(local, parent, name)? {
			return Ok(Some(found));
		}
		let Some(dir) = self.code_dir(parent).filter(|d| matches!(git::place(d), Place::Worktree { .. })) else {
			return Ok(None);
		};
		let on_disk = fs::symlink_metadata(local.disk(Area::Cache, &join(&dir, name))).is_ok();
		if !on_disk || self.child(parent, name).is_ok() {
			return Ok(None);
		}
		Ok(Some((Up::Mount(dir), Area::Cache)))
	}

	/// Where a new `name` in the folder `parent` goes for a file now in `area`: as `here`, or, for a cache's file,
	/// beside it in the node's folder where the node has nothing (a cache renamed in its worktree stays a cache).
	fn target(&self, local: &Local, parent: u64, name: &str, area: Area) -> Result<Option<(Up, Area)>, i32> {
		if let Some(found) = self.here(local, parent, name)? {
			return Ok(Some(found));
		}
		if area != Area::Cache {
			return Ok(None);
		}
		let Some(dir) = self.code_dir(parent).filter(|d| matches!(git::place(d), Place::Worktree { .. })) else {
			return Ok(None);
		};
		Ok(self.child(parent, name).is_err().then_some((Up::Mount(dir), Area::Cache)))
	}

	/// Whether a new folder `name` in the node's folder `dir` is one of the session's caches: `dir` is in a worktree
	/// and `name` is on its list (`cache.rs`), whose index is read first if it was not yet.
	fn cache(&self, local: &Local, dir: &str, name: &str) -> bool {
		let Place::Worktree { area, worker, .. } = git::place(dir) else { return false };
		if !git::CACHE_NAMES.contains(&name) {
			return false;
		}
		let (worktree, index) = git::worktree(area, worker);
		if !local.cache.lock().unwrap().read(&worktree) {
			self.read_index(local, &worktree, &index);
		}
		local.cache.lock().unwrap().listed(&worktree, name)
	}

	/// The session-local git files `seed` holds, copied from the node's once per view (`local.rs`).
	fn seed(&self, local: &Local, seed: &str) -> Result<(), i32> {
		if local.seeded(seed) {
			return Ok(());
		}
		let _held = local.seeding.lock().unwrap();
		if local.seeded(seed) {
			return Ok(());
		}
		let entries = match self.link.list(seed) {
			Ok(entries) => entries,
			Err(f) if f.errno() == libc::ENOENT => Vec::new(),
			Err(f) => return Err(f.errno()),
		};
		for entry in entries.iter().filter(|e| local::seeded_names(seed).contains(&e.name.as_str())) {
			self.copy_in(local, &join(seed, &entry.name), entry)?;
		}
		local.mark_seeded(seed);
		Ok(())
	}

	fn copy_in(&self, local: &Local, path: &str, entry: &Entry) -> Result<(), i32> {
		match entry.kind {
			EntryKind::File => {
				let bytes = self.read_all(path, &entry.version, entry.size)?;
				local.put(path, Some(&bytes), entry.executable).map_err(local::errno)
			}
			EntryKind::Folder => {
				local.put(path, None, false).map_err(local::errno)?;
				for child in self.link.list(path).map_err(|f| f.errno())? {
					self.copy_in(local, &join(path, &child.name), &child)?;
				}
				Ok(())
			}
		}
	}

	/// The node's file `path` at `version`, whole.
	fn read_all(&self, path: &str, version: &str, size: u64) -> Result<Vec<u8>, i32> {
		let mut out = Vec::with_capacity(size as usize);
		while (out.len() as u64) < size {
			let length = (size - out.len() as u64).min(MAX_READ as u64) as u32;
			let chunk = self.link.read(path, version, out.len() as u64, length).map_err(|f| f.errno())?;
			if chunk.is_empty() {
				break;
			}
			out.extend_from_slice(&chunk);
		}
		Ok(out)
	}

	/// Reads `worktree`'s index (at `index`) from the node, for its cache list. A worktree without one has tracked
	/// nothing yet; one the node could not give is read again at the next new cache.
	fn read_index(&self, local: &Local, worktree: &str, index: &str) {
		let (dir, name) = split(index);
		let entry = match self.link.list(dir) {
			Ok(entries) => entries.into_iter().find(|e| e.name == name && e.kind == EntryKind::File),
			Err(f) if f.errno() == libc::ENOENT => None,
			Err(f) => return eprintln!("qorpera-folder: {index} could not be listed (errno {})", f.errno()),
		};
		let data = match entry {
			None => return self.indexed(local, worktree, &[]),
			Some(e) => match self.read_all(index, &e.version, e.size) {
				Ok(data) => data,
				Err(e) => return eprintln!("qorpera-folder: {index} could not be read (errno {e})"),
			},
		};
		self.indexed_data(local, worktree, index, &data);
	}

	/// The index `data` git wrote for `worktree` (at `index`).
	fn indexed_data(&self, local: &Local, worktree: &str, index: &str, data: &[u8]) {
		match index::paths(data) {
			Ok(paths) => self.indexed(local, worktree, &paths),
			Err(e) => eprintln!("qorpera-folder: {index} could not be read ({e:?}); its worktree's cache list stays"),
		}
	}

	/// `worktree`'s index tracks `paths` now: the names under which it tracks files leave its cache list, and their
	/// cache folders move into the folder (`move_caches`).
	fn indexed(&self, local: &Local, worktree: &str, paths: &[String]) {
		local.cache.lock().unwrap().indexed(worktree, paths);
		self.move_caches(local, Some(worktree));
	}

	/// Moves the cache folders of the names that left a worktree's list into the folder (`move_in`): `worktree`'s, or
	/// every worktree's. A move that fails stays on the list (`cache.rs`), tried again at the worktree's next index and
	/// every few seconds (`mount.rs`); until none is left, `qorpera-folder publish` refuses the view's boundaries.
	pub(super) fn move_caches(&self, local: &Local, worktree: Option<&str>) {
		let mut held = local.moving.lock().unwrap();
		let moves = local.cache.lock().unwrap().moves(worktree);
		for (worktree, name) in moves {
			match self.move_in(local, &mut held, &worktree, &name) {
				Ok(()) => local.cache.lock().unwrap().moved(&worktree, &name),
				Err(e) => eprintln!("qorpera-folder: the {name} caches in {worktree} could not move into the folder yet (errno {e})"),
			}
		}
		// A write kept for a move that is done or no longer to be made (its file left the disk, or is a cache again) is
		// closed empty and removed: a handle of the view's left open keeps its boundaries from publishing.
		let moves = local.cache.lock().unwrap().moves(None);
		let left: Vec<String> =
			held.keys().filter(|path| !moves.iter().any(|(w, n)| in_cache(path, w, n))).cloned().collect();
		for path in left {
			let writer = held.remove(&path).expect("held");
			let removed = match self.link.close_write(writer.handle, 0) {
				Ok(version) => match self.link.unlink(&path, Some(version)) {
					Err(f) if f.errno() != libc::ENOENT => Err(f),
					_ => Ok(()),
				},
				Err(f) if again(&f) => {
					held.insert(path.clone(), writer);
					Err(f)
				}
				// The node has no such handle open any more.
				Err(_) => Ok(()),
			};
			if let Err(f) = removed {
				eprintln!("qorpera-folder: the kept write of {path} could not be given up yet (errno {})", f.errno());
			}
		}
	}

	/// Moves `worktree`'s cache folders named `name` into the folder as files the session wrote, published at the
	/// session's boundary: git tracks files under that name now, so they are the worktree's. One a move did not finish
	/// is in the node's folder already, with what is left of it on the disk.
	fn move_in(&self, local: &Local, held: &mut HashMap<String, Writer>, worktree: &str, name: &str) -> Result<(), i32> {
		let mut todo = vec![worktree.to_string()];
		while let Some(dir) = todo.pop() {
			let Ok(read) = fs::read_dir(local.disk(Area::Cache, &dir)) else { continue };
			let node: Vec<String> = match self.link.list(&dir) {
				Ok(entries) => entries.into_iter().map(|e| e.name).collect(),
				Err(f) => return Err(f.errno()),
			};
			for entry in read.flatten() {
				let Some(child) = entry.file_name().to_str().map(str::to_string) else { continue };
				if !entry.file_type().is_ok_and(|t| t.is_dir()) {
					continue;
				}
				if child == name {
					self.move_folder(local, held, &join(&dir, &child), &entry.path())?;
				} else if node.contains(&child) {
					// A folder of the node's with caches in it.
					todo.push(join(&dir, &child));
				}
			}
			self.tree.lock().unwrap().invalidate([dir.as_str()]);
		}
		Ok(())
	}

	/// Each file leaves the disk once it is in the folder, and each folder once it is empty: what stays is what has not
	/// moved yet, and what cannot (links wait for the folder's own), seen in the folder's place as a cache's are.
	fn move_folder(&self, local: &Local, held: &mut HashMap<String, Writer>, path: &str, disk: &Path) -> Result<(), i32> {
		let made = |p: &str| match self.link.mkdir(p) {
			Err(f) if f.errno() != libc::EEXIST => Err(f.errno()),
			_ => Ok(()),
		};
		made(path)?;
		let walked = local.walk(disk).map_err(local::errno)?;
		for (rel, meta) in &walked {
			let to = join(path, rel);
			if meta.is_dir() {
				made(&to)?;
			} else if meta.is_file() {
				self.write_in(held, &to, &disk.join(rel), meta.permissions().mode() & 0o100 != 0)?;
				fs::remove_file(disk.join(rel)).map_err(local::errno)?;
			} else {
				eprintln!("qorpera-folder: {to} is not a file or a folder, and stays out of the folder");
			}
		}
		// Deepest first (the walk gives a folder before what is in it); one with a link left in it stays.
		for (rel, _) in walked.iter().rev().filter(|(_, m)| m.is_dir()) {
			let _ = fs::remove_dir(disk.join(rel));
		}
		let _ = fs::remove_dir(disk);
		Ok(())
	}

	/// Writes the disk's file `disk` to the folder's `path`, as the session's new file. A write the node did not take
	/// is kept in `held` with its handle, as the mount keeps a close it did not take (`again`), and the next move
	/// writes the file again from the start through it: a handle left open would keep the file from every boundary.
	fn write_in(&self, held: &mut HashMap<String, Writer>, path: &str, disk: &Path, executable: bool) -> Result<(), i32> {
		let mut file = fs::File::open(disk).map_err(local::errno)?;
		let mut writer = match held.remove(path) {
			Some(writer) => writer,
			None => {
				let request =
					OpenRequest { path: path.to_string(), base: None, create: true, exclusive: false, truncate: true };
				let opened = self.link.open_write(&request).map_err(|f| f.errno())?;
				Writer::new(opened.handle, opened.size)
			}
		};
		let mut version = match self.send(&mut writer, &mut file) {
			Ok(version) => version,
			Err(Sent::Disk(e)) => {
				held.insert(path.to_string(), writer);
				return Err(e);
			}
			Err(Sent::Node(f)) => {
				// Kept for an answer the node may get past; after any other, the handle is not the node's any more.
				if again(&f) {
					held.insert(path.to_string(), writer);
				}
				return Err(f.errno());
			}
		};
		if executable {
			version = self.link.set_executable(path, Some(version), true).map_err(|f| f.errno())?;
		}
		self.versions.lock().unwrap().saved(path, &version);
		Ok(())
	}

	/// Writes `file` through `writer` from its start and closes it: the version the close made.
	fn send(&self, writer: &mut Writer, file: &mut fs::File) -> Result<String, Sent> {
		writer.truncate(&self.link, 0).map_err(Sent::Node)?;
		let mut buf = vec![0; MAX_READ as usize];
		let mut at = 0;
		loop {
			let n = file.read(&mut buf).map_err(|e| Sent::Disk(local::errno(e)))?;
			if n == 0 {
				break;
			}
			// Past what the node takes, checked here so the writer's own refusal is never taken for the node's.
			if at + n as u64 > MAX_CHUNKS * CHUNK {
				return Err(Sent::Disk(libc::EFBIG));
			}
			writer.write(&self.link, at, &buf[..n]).map_err(Sent::Node)?;
			at += n as u64;
		}
		let size = writer.finish(&self.link).map_err(Sent::Node)?;
		self.link.close_write(writer.handle, size).map_err(Sent::Node)
	}
}

/// Why a cache's file was not written into the folder: the disk's error, or the node's.
enum Sent {
	Disk(i32),
	Node(Fail),
}

/// Whether the folder's `path` is in `worktree`'s cache folders named `name`.
fn in_cache(path: &str, worktree: &str, name: &str) -> bool {
	let Some(rest) = path.strip_prefix(worktree).and_then(|r| r.strip_prefix('/')) else { return false };
	let folders = rest.rsplit_once('/').map_or("", |(folders, _)| folders);
	folders.split('/').any(|folder| folder == name)
}

impl FolderFs {
	fn local(&self) -> Result<&Local, i32> {
		self.s.local.as_ref().ok_or(libc::ENOENT)
	}

	/// lookup of a local file, before the node's.
	pub(super) fn local_lookup(&self, parent: u64, name: &str, reply: ReplyEntry) -> Option<ReplyEntry> {
		let Some(local) = &self.s.local else { return Some(reply) };
		match self.s.here(local, parent, name) {
			Ok(None) => return Some(reply),
			Ok(Some((up, area))) => match local.entry(up, name, area) {
				Ok(attr) => reply.entry(&self.s.ttl, &attr, Generation(0)),
				Err(e) => reply.error(Errno::from_i32(e)),
			},
			Err(e) => reply.error(Errno::from_i32(e)),
		}
		None
	}

	/// lookup of a name the node does not have in a folder of a worktree: one of the session's caches, if there is one.
	pub(super) fn cache_lookup(&self, parent: u64, name: &str, reply: ReplyEntry) -> Option<ReplyEntry> {
		let Some(local) = &self.s.local else { return Some(reply) };
		let Some(dir) = self.s.code_dir(parent).filter(|d| matches!(git::place(d), Place::Worktree { .. })) else {
			return Some(reply);
		};
		match local.entry(Up::Mount(dir), name, Area::Cache) {
			// The node's folder wins once it has one (`move_in`), so the kernel asks again each time.
			Ok(attr) => reply.entry(&Duration::ZERO, &attr, Generation(0)),
			Err(_) => return Some(reply),
		}
		None
	}

	pub(super) fn local_getattr(&self, ino: u64, reply: ReplyAttr) -> Option<ReplyAttr> {
		if !is_local(ino) {
			return Some(reply);
		}
		match self.local().and_then(|l| l.getattr(ino)) {
			Ok(attr) => reply.attr(&self.s.ttl, &attr),
			Err(e) => reply.error(Errno::from_i32(e)),
		}
		None
	}

	pub(super) fn local_opendir(&self, ino: u64, reply: ReplyOpen) -> Option<ReplyOpen> {
		if !is_local(ino) {
			return Some(reply);
		}
		match self.local().and_then(|l| l.children(ino)) {
			Ok(children) => {
				let mut entries = vec![
					(ino, FileType::Directory, ".".to_string()),
					(ino, FileType::Directory, "..".to_string()),
				];
				entries.extend(children);
				reply.opened(self.s.handle(Handle::Dir(entries)), FopenFlags::empty());
			}
			Err(e) => reply.error(Errno::from_i32(e)),
		}
		None
	}

	/// The local entries of the node's folder `dir` added to its `entries`: the session-local git files in place of the
	/// node's, and a worktree's caches where the node has nothing.
	pub(super) fn merge_local(&self, dir: &str, entries: &mut Vec<(u64, FileType, String)>) -> Result<(), i32> {
		let Some(local) = &self.s.local else { return Ok(()) };
		if !dir.starts_with("code/") {
			return Ok(());
		}
		if let Some(seed) = local::seed_of(dir).filter(|_| !self.s.code_host) {
			self.s.seed(local, &seed)?;
			entries.retain(|e| !local::git_file(&join(dir, &e.2)));
			entries.extend(local.entries_of(dir, Area::Git));
		} else if matches!(git::place(dir), Place::Worktree { .. }) {
			let caches = local.entries_of(dir, Area::Cache);
			let caches: Vec<_> = caches.into_iter().filter(|c| !entries.iter().any(|e| e.2 == c.2)).collect();
			entries.extend(caches);
		}
		Ok(())
	}

	pub(super) fn local_open(&self, ino: u64, flags: i32, write: bool, reply: ReplyOpen) -> Option<ReplyOpen> {
		if is_local(ino) {
			match self.local().and_then(|l| l.open_file(ino, flags)) {
				Ok(fh) => reply.opened(FileHandle(fh), FopenFlags::empty()),
				Err(e) => reply.error(Errno::from_i32(e)),
			}
			return None;
		}
		if write && self.s.tree.lock().unwrap().path(ino).is_some_and(alternates) {
			reply.error(Errno::EPERM);
			return None;
		}
		Some(reply)
	}

	pub(super) fn local_create(
		&self,
		parent: u64,
		name: &str,
		mode: u32,
		flags: i32,
		reply: ReplyCreate,
	) -> Option<ReplyCreate> {
		let Some(local) = &self.s.local else { return Some(reply) };
		match self.s.found(local, parent, name) {
			Ok(None) => {
				if self.s.code_dir(parent).is_some_and(|d| alternates(&join(&d, name))) {
					reply.error(Errno::EPERM);
					return None;
				}
				return Some(reply);
			}
			Ok(Some((up, area))) => match local.create(up, name, area, mode, flags) {
				Ok((attr, fh)) => reply.created(&self.s.ttl, &attr, Generation(0), FileHandle(fh), FopenFlags::empty()),
				Err(e) => reply.error(Errno::from_i32(e)),
			},
			Err(e) => reply.error(Errno::from_i32(e)),
		}
		None
	}

	pub(super) fn local_read(&self, fh: u64, offset: u64, size: u32, reply: ReplyData) -> Option<ReplyData> {
		if !is_local(fh) {
			return Some(reply);
		}
		match self.local().and_then(|l| l.read(fh, offset, size.min(MAX_READ))) {
			Ok(data) => reply.data(&data),
			Err(e) => reply.error(Errno::from_i32(e)),
		}
		None
	}

	pub(super) fn local_write(&self, fh: u64, offset: u64, data: &[u8], reply: ReplyWrite) -> Option<ReplyWrite> {
		if !is_local(fh) {
			return Some(reply);
		}
		match self.local().and_then(|l| l.write(fh, offset, data)) {
			Ok(n) => reply.written(n),
			Err(e) => reply.error(Errno::from_i32(e)),
		}
		None
	}

	/// flush, fsync (`sync`) and release (`release`) of a local file's handle.
	pub(super) fn local_handle(&self, fh: u64, sync: bool, release: bool, reply: ReplyEmpty) -> Option<ReplyEmpty> {
		if !is_local(fh) {
			return Some(reply);
		}
		match self.local() {
			Ok(local) if sync => match local.fsync(fh) {
				Ok(()) => reply.ok(),
				Err(e) => reply.error(Errno::from_i32(e)),
			},
			Ok(local) => {
				if release {
					local.release(fh);
				}
				reply.ok()
			}
			Err(e) => reply.error(Errno::from_i32(e)),
		}
		None
	}

	/// setattr of a local file; and of the node's objects' times, which git sets to keep an object it would otherwise
	/// write again: refused, so it writes it again.
	pub(super) fn local_setattr(
		&self,
		ino: u64,
		mode: Option<u32>,
		size: Option<u64>,
		atime: Option<TimeOrNow>,
		mtime: Option<TimeOrNow>,
		reply: ReplyAttr,
	) -> Option<ReplyAttr> {
		if is_local(ino) {
			match self.local().and_then(|l| l.setattr(ino, mode, size, (when(atime), when(mtime)))) {
				Ok(attr) => reply.attr(&self.s.ttl, &attr),
				Err(e) => reply.error(Errno::from_i32(e)),
			}
			return None;
		}
		let object = |p: &str| matches!(git::place(p), Place::Git { rest, .. } if git::object(rest));
		if (atime.is_some() || mtime.is_some()) && self.s.tree.lock().unwrap().path(ino).is_some_and(object) {
			reply.error(Errno::EPERM);
			return None;
		}
		Some(reply)
	}

	/// mkdir of a local folder: in a local folder, a session-local git folder, or one of the session's caches.
	pub(super) fn local_mkdir(&self, parent: u64, name: &str, mode: u32, reply: ReplyEntry) -> Option<ReplyEntry> {
		let Some(local) = &self.s.local else { return Some(reply) };
		let (up, area) = match self.s.here(local, parent, name) {
			Ok(Some(found)) => found,
			Ok(None) => match self.s.code_dir(parent) {
				Some(dir) if self.s.cache(local, &dir, name) && self.s.child(parent, name).is_err() => {
					(Up::Mount(dir), Area::Cache)
				}
				_ => return Some(reply),
			},
			Err(e) => {
				reply.error(Errno::from_i32(e));
				return None;
			}
		};
		let ttl = if area == Area::Cache && matches!(up, Up::Mount(_)) { Duration::ZERO } else { self.s.ttl };
		match local.mkdir(up, name, area, mode) {
			Ok(attr) => reply.entry(&ttl, &attr, Generation(0)),
			Err(e) => reply.error(Errno::from_i32(e)),
		}
		None
	}

	pub(super) fn local_remove(&self, parent: u64, name: &str, folder: bool, reply: ReplyEmpty) -> Option<ReplyEmpty> {
		let Some(local) = &self.s.local else { return Some(reply) };
		let done = match self.s.found(local, parent, name) {
			Ok(None) => return Some(reply),
			Ok(Some((up, area))) if folder => local.rmdir(&up, name, area),
			Ok(Some((up, area))) => local.unlink(&up, name, area),
			Err(e) => Err(e),
		};
		match done {
			Ok(()) => reply.ok(),
			Err(e) => reply.error(Errno::from_i32(e)),
		}
		None
	}

	/// rename of a local file (within its area: across, EXDEV), and git's refused rename onto its alternates.
	pub(super) fn local_rename(
		&self,
		from: (u64, &str),
		to: (u64, &str),
		flags: RenameFlags,
		reply: ReplyEmpty,
	) -> Option<ReplyEmpty> {
		let Some(local) = &self.s.local else { return Some(reply) };
		let found = self.s.found(local, from.0, from.1).and_then(|source| {
			let target = match &source {
				Some((_, area)) => self.s.target(local, to.0, to.1, *area)?,
				None => self.s.here(local, to.0, to.1)?,
			};
			Ok((source, target))
		});
		let done = match found {
			Ok((None, None)) => {
				if self.s.code_dir(to.0).is_some_and(|d| alternates(&join(&d, to.1))) {
					reply.error(Errno::EPERM);
					return None;
				}
				return Some(reply);
			}
			Ok((Some((source, area)), Some((target, to_area)))) if area == to_area => {
				if flags.contains(RenameFlags::RENAME_WHITEOUT) {
					Err(libc::EINVAL)
				} else {
					let no_replace = flags.contains(RenameFlags::RENAME_NOREPLACE);
					let exchange = flags.contains(RenameFlags::RENAME_EXCHANGE);
					local.rename((&source, from.1), (&target, to.1), area, no_replace, exchange)
				}
			}
			Ok(_) => Err(libc::EXDEV),
			Err(e) => Err(e),
		};
		match done {
			Ok(()) => reply.ok(),
			Err(e) => reply.error(Errno::from_i32(e)),
		}
		None
	}

	pub(super) fn local_symlink(
		&self,
		parent: u64,
		name: &str,
		target: &Path,
		reply: ReplyEntry,
	) -> Option<ReplyEntry> {
		let Some(local) = &self.s.local else { return Some(reply) };
		match self.s.found(local, parent, name) {
			Ok(None) => return Some(reply),
			Ok(Some((up, area))) => match local.symlink(up, name, area, target) {
				Ok(attr) => reply.entry(&self.s.ttl, &attr, Generation(0)),
				Err(e) => reply.error(Errno::from_i32(e)),
			},
			Err(e) => reply.error(Errno::from_i32(e)),
		}
		None
	}

	pub(super) fn local_link(&self, ino: u64, to: (u64, &str), reply: ReplyEntry) -> Option<ReplyEntry> {
		if !is_local(ino) {
			return Some(reply);
		}
		let done = self.local().and_then(|local| {
			let (_, _, area) = local.name(ino).ok_or(libc::ENOENT)?;
			match self.s.target(local, to.0, to.1, area)? {
				Some((up, to_area)) if to_area == area => local.link(ino, up, to.1, area),
				_ => Err(libc::EXDEV),
			}
		});
		match done {
			Ok(attr) => reply.entry(&self.s.ttl, &attr, Generation(0)),
			Err(e) => reply.error(Errno::from_i32(e)),
		}
		None
	}

	/// readlink: only local files are links (the node's links come with the folder's own).
	pub(super) fn local_readlink(&self, ino: u64, reply: ReplyData) {
		if !is_local(ino) {
			return reply.error(Errno::EINVAL);
		}
		match self.local().and_then(|l| l.readlink(ino)) {
			Ok(target) => reply.data(&target),
			Err(e) => reply.error(Errno::from_i32(e)),
		}
	}

	/// The index git is about to put in place for a worktree by renaming its lock `from` (`source`) onto `to`, read
	/// before the rename for the worktree's cache list (`index_after`). A worktree with no caches only reads it before
	/// its next one.
	pub(super) fn index_before(&self, from: &str, to: &str, source: &Child) -> Option<(String, Vec<u8>)> {
		let local = self.s.local.as_ref()?;
		let worktree = git::index_of(to)?;
		if source.attr.kind != EntryKind::File {
			return None;
		}
		let cached = fs::read_dir(local.disk(Area::Cache, &worktree)).is_ok_and(|mut d| d.next().is_some());
		if !cached {
			local.cache.lock().unwrap().stale(&worktree);
			return None;
		}
		match self.s.read_all(from, &source.attr.version, source.attr.size) {
			Ok(data) => Some((worktree, data)),
			Err(e) => {
				local.cache.lock().unwrap().stale(&worktree);
				eprintln!("qorpera-folder: {from} could not be read (errno {e})");
				None
			}
		}
	}

	/// The rename `index_before` read for landed at `to`.
	pub(super) fn index_after(&self, to: &str, read: Option<(String, Vec<u8>)>) {
		if let (Some(local), Some((worktree, data))) = (&self.s.local, read) {
			self.s.indexed_data(local, &worktree, to, &data);
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn a_kept_write_belongs_to_a_move_only_inside_a_folder_of_its_name() {
		let w = "code/o/n/worktrees/w";
		assert!(in_cache("code/o/n/worktrees/w/node_modules/x.js", w, "node_modules"));
		assert!(in_cache("code/o/n/worktrees/w/pkg/node_modules/a/x.js", w, "node_modules"));
		assert!(!in_cache("code/o/n/worktrees/w/src/node_modules", w, "node_modules"));
		assert!(!in_cache("code/o/n/worktrees/w2/node_modules/x.js", w, "node_modules"));
		assert!(!in_cache("code/o/n/worktrees/w/src/x.js", w, "node_modules"));
	}
}
