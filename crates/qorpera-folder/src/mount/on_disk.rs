//! The mount's side of git on the mount (`git.rs`), of the session's own files on the machine's disk (`local.rs`) and of
//! the machine's caches (`cache.rs`): which of the kernel's requests the local files answer, what the mount refuses git,
//! and what it does around git's locks and its index.
//!
//! A cache is answered where the node has nothing at its path (rule 1), in any of the node's folders but a repository's
//! git folder, on a machine's mount: the code host publishes all it writes. Nothing crosses the edge between the
//! caches and the folder: a rename or a hard link across it is EXDEV (`mv` copies), a folder of the node's with caches
//! in it is not empty, and one the node removes or renames here drops or moves its caches (`local.rs`).
//!
//! Each `local_*` hook takes the request's reply and hands it back when the node answers the request after all.

use super::*;
use crate::cache;
use crate::git::{self, Place};
use crate::ignore::{self, Patterns};
use crate::index;
use crate::local::{self, is_local, Area, Up};
use crate::proto::{split, Entry, CHUNK, MAX_CHUNKS};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::sync::MutexGuard;

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
/// reflog and `packed-refs` as they are now: the mount forgets what it knew of them, so git reads those. Under
/// `packed-refs`' lock git walks the loose refs too (`git pack-refs`), and the node read the feed before the create
/// returned: the mount forgets its listings of `refs/` and the folders below it, so git lists what the node shows now,
/// not a loose ref another session deleted that the feed has not told the mount of yet.
pub(super) fn locked(tree: &mut Tree, path: &str) {
	if let Place::Git { area, rest } = git::place(path) {
		if let Some(target) = git::locked(rest) {
			let paths = git::refreshed(area, target);
			// The kernel keeps none of them (`fresh`), so it needs no word.
			drop(tree.invalidate(paths.iter().map(String::as_str)));
			if target == "packed-refs" {
				tree.drop_listings(&git::refs(area));
			}
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

	/// The path of the node's folder `dir`, if caches can be in it: any but a repository's git folder, on a machine's
	/// mount (the code host publishes all it writes).
	fn cache_dir(&self, dir: u64) -> Option<String> {
		if self.code_host {
			return None;
		}
		let tree = self.tree.lock().unwrap();
		tree.path(dir).filter(|p| !matches!(git::place(p), Place::Git { .. })).map(str::to_string)
	}

	/// Where `name` in the folder `parent` is answered by the local files, if it is: as `here`, or one of the folder's
	/// caches (a cache folder, or a file a move left in a cache's place) where the node has nothing.
	fn found(&self, local: &Local, parent: u64, name: &str) -> Result<Option<(Up, Area)>, i32> {
		if let Some(found) = self.here(local, parent, name)? {
			return Ok(Some(found));
		}
		let Some(dir) = self.cache_dir(parent) else { return Ok(None) };
		if !local.is_top(&dir, name) || self.child(parent, name).is_ok() {
			return Ok(None);
		}
		Ok(Some((Up::Mount(dir), Area::Cache)))
	}

	/// Where a new `name` in the folder `parent` goes for a file (or, `folder`, a folder) now in `area`: as `found`, or,
	/// for a cache's, a new cache where the node has nothing and the rules make one (`cache`).
	fn target(&self, local: &Local, parent: u64, name: &str, area: Area, folder: bool) -> Result<Option<(Up, Area)>, i32> {
		if let Some(found) = self.here(local, parent, name)? {
			return Ok(Some(found));
		}
		if area != Area::Cache {
			return Ok(None);
		}
		let Some(dir) = self.cache_dir(parent) else { return Ok(None) };
		if self.child(parent, name).is_ok() {
			return Ok(None);
		}
		let cache = local.is_top(&dir, name) || self.cache(local, parent, &dir, name, folder);
		Ok(cache.then_some((Up::Mount(dir), Area::Cache)))
	}

	/// Whether a new `name` in the node's folder `parent` (at `dir`) is a cache (`cache.rs`), a folder when `folder`: in a
	/// worktree, a folder on its list or a path git's ignore rules leave out, but never one its index tracks, which is
	/// read first if it was not yet, nor a `.git` or one in it, which git never takes (rule 4); elsewhere in a code area,
	/// never; anywhere else, a folder by rules 2 and 3.
	fn cache(&self, local: &Local, parent: u64, dir: &str, name: &str, folder: bool) -> bool {
		match git::place(dir) {
			Place::Git { .. } => false,
			Place::Worktree { area, worker, rest } => {
				let (worktree, index) = git::worktree(area, worker);
				let path = join(rest, name);
				if path.split('/').any(|n| n == ".git") {
					return false;
				}
				let named = folder && cache::on_worktree_list(name);
				// Neither: published, with no need of the index.
				if !named && !self.ignored(local, area, &worktree, parent, &path, folder) {
					return false;
				}
				if !local.cache.lock().unwrap().read(&worktree) {
					self.read_index(local, &worktree, &index);
				}
				let list = local.cache.lock().unwrap();
				if list.tracks(&worktree, &path, folder) {
					return false;
				}
				if !named || list.listed(&worktree, name) {
					return true;
				}
				drop(list);
				// A name that left the list: by git's rules alone.
				self.ignored(local, area, &worktree, parent, &path, folder)
			}
			Place::Other if dir == "code" || dir.starts_with("code/") => false,
			Place::Other => folder && cache::outside(name, || self.project(parent)),
		}
	}

	/// Whether git's ignore rules leave out `path` in `worktree` (in `area`), a folder when `folder` (`ignore.rs`): the
	/// `.gitignore` in each of the node's folders from the worktree's top down to `parent`, the one `path` is in, and the
	/// repository's `info/exclude`. A folder the mount cannot place in the worktree, or an ignore file it cannot read,
	/// leaves nothing out: the path is published.
	fn ignored(&self, local: &Local, area: &str, worktree: &str, parent: u64, path: &str, folder: bool) -> bool {
		let mut dirs = HashMap::new();
		{
			let tree = self.tree.lock().unwrap();
			let (mut ino, mut rel) = (parent, split(path).0);
			loop {
				if tree.path(ino) != Some(below(worktree, rel).as_str()) {
					return false;
				}
				dirs.insert(rel.to_string(), ino);
				if rel.is_empty() {
					break;
				}
				let Some(up) = tree.parent(ino) else { return false };
				(ino, rel) = (up, split(rel).0);
			}
		}
		let exclude = self.exclude(local, area);
		let gitignore = |dir: &str| self.gitignore(local, *dirs.get(dir)?, &below(worktree, dir));
		ignore::ignored(path, folder, gitignore, exclude.as_ref())
	}

	/// The `.gitignore` in the node's folder `dir` (at `path`), parsed once per version: the node's, or where the node
	/// has none, the folder's cache of that name (git reads a `.gitignore` it ignores too). None when there is neither,
	/// or the one there is not a file (git does not follow a link to it), or could not be read.
	fn gitignore(&self, local: &Local, dir: u64, path: &str) -> Option<Arc<Patterns>> {
		let file = join(path, ".gitignore");
		let (version, size, disk) = match self.child(dir, ".gitignore") {
			Ok(child) if child.attr.kind == EntryKind::File => (child.attr.version, child.attr.size, None),
			Err(libc::ENOENT) => {
				let flags = libc::O_NOFOLLOW | libc::O_NONBLOCK;
				let disk = fs::OpenOptions::new().read(true).custom_flags(flags).open(local.disk(Area::Cache, &file)).ok()?;
				let meta = disk.metadata().ok().filter(|m| m.is_file())?;
				let (ino, len) = (meta.ino(), meta.len());
				let version = format!("disk:{ino}:{len}:{}.{}:{}.{}", meta.mtime(), meta.mtime_nsec(), meta.ctime(), meta.ctime_nsec());
				(version, len, Some(disk))
			}
			_ => return None,
		};
		if let Some((known, patterns)) = local.ignores.lock().unwrap().get(&file) {
			if *known == version {
				return Some(patterns.clone());
			}
		}
		let patterns = if size >= ignore::MAX_FILE as u64 {
			Patterns::default()
		} else {
			let text = match disk {
				Some(disk) => {
					let mut text = Vec::new();
					disk.take(ignore::MAX_FILE as u64).read_to_end(&mut text).map(|_| text).map_err(local::errno)
				}
				None => self.read_all(&file, &version, size),
			};
			match text {
				Ok(text) => Patterns::parse(&text),
				Err(e) => {
					eprintln!("qorpera-folder: {file} could not be read (errno {e}); it leaves nothing out");
					return None;
				}
			}
		};
		let patterns = Arc::new(patterns);
		local.ignores.lock().unwrap().insert(file, (version, patterns.clone()));
		Some(patterns)
	}

	/// The repository's `info/exclude` (`area`'s): a session-local git file (`local.rs`), seeded first. A link in its
	/// place counts as none.
	fn exclude(&self, local: &Local, area: &str) -> Option<Patterns> {
		let seed = format!("{area}/repo.git");
		self.seed(local, &seed).ok()?;
		let disk = local.disk(Area::Git, &format!("{seed}/info/exclude"));
		let meta = fs::symlink_metadata(&disk).ok().filter(|m| m.is_file())?;
		if meta.len() >= ignore::MAX_FILE as u64 {
			return None;
		}
		fs::read(&disk).ok().map(|text| Patterns::parse(&text))
	}

	/// Whether the node's folder `dir` holds a project file (rule 3).
	fn project(&self, dir: u64) -> bool {
		let project = |c: &Child| c.attr.kind != EntryKind::Folder && cache::PROJECT_FILES.contains(&c.name.as_str());
		self.children(dir, None).is_ok_and(|(children, _)| children.iter().any(project))
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
			EntryKind::Symlink => {
				let target = self.read_all(path, &entry.version, entry.size)?;
				local.put_link(path, &target).map_err(local::errno)
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
	/// nothing yet; one the node could not give is read again by the move the cache made then asks for (`made`), or at
	/// the next new cache. Git can put another index in place while the read is on, so what it gives is taken only if
	/// no index was taken in or found stale for the worktree since it started (`index_after`): a newer one taken in
	/// stands, and one found stale is read again, a few times at most.
	fn read_index(&self, local: &Local, worktree: &str, index: &str) {
		for _ in 0..3 {
			let as_of = local.cache.lock().unwrap().reads(worktree);
			let Some(paths) = self.index_paths(index) else { return };
			if self.indexed(local, worktree, &paths, Some(as_of)) || local.cache.lock().unwrap().read(worktree) {
				return;
			}
		}
	}

	/// The paths the node's index at `index` tracks (none where it has none), or None where it could not be read.
	fn index_paths(&self, index: &str) -> Option<Vec<String>> {
		let (dir, name) = split(index);
		let entry = match self.link.list(dir) {
			Ok(entries) => entries.into_iter().find(|e| e.name == name && e.kind == EntryKind::File),
			Err(f) if f.errno() == libc::ENOENT => None,
			Err(f) => {
				eprintln!("qorpera-folder: {index} could not be listed (errno {})", f.errno());
				return None;
			}
		};
		let Some(e) = entry else { return Some(Vec::new()) };
		match self.read_all(index, &e.version, e.size) {
			Ok(data) => parsed_index(index, &data),
			Err(e) => {
				eprintln!("qorpera-folder: {index} could not be read (errno {e})");
				None
			}
		}
	}

	/// The index `data` git wrote for `worktree` (at `index`) just now.
	fn indexed_data(&self, local: &Local, worktree: &str, index: &str, data: &[u8]) {
		if let Some(paths) = parsed_index(index, data) {
			self.indexed(local, worktree, &paths, None);
		}
	}

	/// `worktree`'s index tracks `paths` now: the names under which it tracks files leave its cache list, and their
	/// cache folders move into the folder (`move_caches`), as do the caches it tracks, or tracks paths in (`TRACKED`).
	/// Read from the node when the list's `reads` was `as_of`, they are taken only if it still is (None: git wrote them
	/// just now); whether they were.
	fn indexed(&self, local: &Local, worktree: &str, paths: &[String], as_of: Option<u64>) -> bool {
		let taken = {
			let mut list = local.cache.lock().unwrap();
			match as_of {
				Some(as_of) => list.indexed_as_of(worktree, paths, as_of).is_some(),
				None => {
					list.indexed(worktree, paths);
					true
				}
			}
		};
		if !taken {
			return false;
		}
		if self.tracks_a_cache(local, worktree) {
			local.cache.lock().unwrap().track(worktree);
		}
		self.move_caches(local, Some(worktree));
		true
	}

	/// Whether `worktree`'s index, as it was read last, tracks one of its caches, or a path in one.
	fn tracks_a_cache(&self, local: &Local, worktree: &str) -> bool {
		let list = local.cache.lock().unwrap();
		let mut todo = vec![String::new()];
		while let Some(rel) = todo.pop() {
			let dir = below(worktree, &rel);
			let mut tops = fs::read_dir(local.room(&dir, Area::Cache)).into_iter().flatten().flatten();
			let tracked = |e: fs::DirEntry| {
				let folder = e.file_type().is_ok_and(|t| t.is_dir());
				e.file_name().into_string().is_ok_and(|n| list.tracks(worktree, &join(&rel, &n), folder))
			};
			if tops.any(tracked) {
				return true;
			}
			todo.extend(local.mirrors(&dir).iter().map(|m| join(&rel, m)).filter(|r| list.tracks(worktree, r, true)));
		}
		false
	}

	/// The local `name` (a folder when `folder`) made just now in the node's folder `parent`: a cache by what was known
	/// of its worktree's index when `cache` decided. Where that index is not known now (git put another in place since,
	/// found stale, or it could not be read) or tracks `name` (taken in since), the move of what the index tracks is
	/// asked for (`TRACKED`), which reads it first, as `indexed` asks for it. The mover makes it (`mount.rs`), not this:
	/// what made the cache may still be writing it. Until it is done, `qorpera-folder publish` refuses the boundaries.
	fn made(&self, local: &Local, parent: u64, name: &str, folder: bool) {
		let Some(dir) = self.cache_dir(parent) else { return };
		let Place::Worktree { area, worker, rest } = git::place(&dir) else { return };
		let worktree = git::worktree(area, worker).0;
		let mut list = local.cache.lock().unwrap();
		if !list.read(&worktree) || list.tracks(&worktree, &join(rest, name), folder) {
			list.track(&worktree);
		}
	}

	/// Moves the cache folders of the names that left a worktree's list into the folder (`move_in`): `worktree`'s, or
	/// every worktree's. A move that fails stays on the list (`cache.rs`), tried again at the worktree's next index and
	/// every few seconds (`mount.rs`); until none is left, `qorpera-folder publish` refuses the view's boundaries.
	pub(super) fn move_caches(&self, local: &Local, worktree: Option<&str>) {
		// What an index tracks is known once it was read since the program started; it is read for a move of what it
		// tracks (`indexed` makes the moves), which waits for it until then.
		let unread: Vec<String> = {
			let list = local.cache.lock().unwrap();
			let moves = list.moves(worktree).into_iter();
			moves.filter(|(w, n)| n == cache::TRACKED && !list.read(w)).map(|(w, _)| w).collect()
		};
		for worktree in unread {
			if let Place::Worktree { area, worker, .. } = git::place(&worktree) {
				self.read_index(local, &worktree, &git::worktree(area, worker).1);
			}
		}
		let mut held = local.moving.lock().unwrap();
		let moves = local.cache.lock().unwrap().moves(worktree);
		for (worktree, name) in moves {
			// A `TRACKED` move asked for again meanwhile, for what the index tracks then, is made again.
			let started = {
				let list = local.cache.lock().unwrap();
				if name == cache::TRACKED && !list.read(&worktree) {
					continue;
				}
				list.generation(&worktree)
			};
			match self.move_in(local, &mut held, &worktree, &name) {
				Ok(()) => local.cache.lock().unwrap().moved(&worktree, &name, started),
				Err(e) => eprintln!("qorpera-folder: the {name} caches in {worktree} could not move into the folder yet (errno {e})"),
			}
		}
		// A write kept for a move that is done or no longer to be made (its file left the disk, or is a cache again, or
		// moved on with its folder's rename and was written again under its new name) is given up at the node once no
		// move is left in its worktree. It is a draft (`write_in`), so it leaves nothing in the folder.
		let moves = local.cache.lock().unwrap().moves(None);
		let left: Vec<String> =
			held.keys().filter(|path| !moves.iter().any(|(w, _)| in_worktree(path, w))).cloned().collect();
		for path in left {
			let writer = held.remove(&path).expect("held");
			// Given up otherwise, or the node has no such handle open any more.
			let Err(f) = self.link.discard_write(writer.handle) else { continue };
			if again(&f) {
				eprintln!("qorpera-folder: the kept write of {path} could not be given up yet (errno {})", f.errno());
				held.insert(path, writer);
			}
		}
	}

	/// Moves `worktree`'s cache folders named `name` into the folder as files the session wrote, published at the
	/// session's boundary: git tracks files under that name now, so they are the worktree's. Each is made in the node's
	/// folder first and what is in it becomes that folder's caches (`Local::convert`), each moved in the same way, so
	/// the view shows every file all along, at the node's or on the disk. One a move did not finish is in the node's
	/// folder already, with what is left of it among its caches, marked as all moving (`Local::whole`) under whatever
	/// name a rename in the worktree gave it since.
	///
	/// The move `TRACKED` moves the caches the worktree's index tracks in the same way: a file, or a folder it tracks
	/// all of (a sparse index's), whole; of a folder it tracks paths in, those paths, the rest staying caches.
	fn move_in(&self, local: &Local, held: &mut HashMap<String, Writer>, worktree: &str, name: &str) -> Result<(), i32> {
		let tracked = name == cache::TRACKED;
		let tracks = |path: &str, folder: bool| local.cache.lock().unwrap().tracks(worktree, within(path, worktree), folder);
		// The node's folders to look in, and whether all of their caches move (what was in a cache that moves).
		let start = *local.folders.lock().unwrap();
		let mut todo = vec![(worktree.to_string(), false)];
		while let Some((dir, whole)) = todo.pop() {
			// A folder at a time, which no rename moves meanwhile; after one, the move is tried again from the top.
			let renames = local.folders.lock().unwrap();
			if *renames != start {
				return Err(libc::EAGAIN);
			}
			let whole = whole || local.whole(&dir);
			let tops: Vec<fs::DirEntry> = match fs::read_dir(local.room(&dir, Area::Cache)) {
				Ok(read) => read.flatten().collect(),
				Err(_) => Vec::new(),
			};
			if tops.is_empty() && local.mirrors(&dir).is_empty() {
				local.mark_whole(&dir, false).map_err(local::errno)?;
				continue;
			}
			let folders: Vec<String> = match self.link.list(&dir) {
				Ok(entries) => entries.into_iter().filter(|e| e.kind == EntryKind::Folder).map(|e| e.name).collect(),
				Err(f) => return Err(f.errno()),
			};
			let mut made = Vec::new();
			for entry in tops {
				let Some(child) = entry.file_name().to_str().map(str::to_string) else { continue };
				let Ok(meta) = fs::symlink_metadata(entry.path()) else { continue };
				let path = join(&dir, &child);
				let picked = if tracked { tracks(&path, meta.is_dir()) } else { child == name && meta.is_dir() };
				if !whole && !picked {
					continue;
				}
				if meta.is_dir() {
					let fresh = match self.link.mkdir(&path) {
						Ok(()) => true,
						Err(f) if f.errno() == libc::EEXIST => false,
						Err(f) => return Err(f.errno()),
					};
					if fresh {
						// The caches of a folder of that name the node had no longer: another view removed it, and this
						// one has not listed its folder since (`caches_gone`).
						local.drop_mirror(&path);
					}
					let all = whole || !tracked || local.cache.lock().unwrap().covers(worktree, within(&path, worktree));
					if local.convert(&dir, &child, all).map_err(local::errno)? {
						made.push(child);
					} else {
						// The node's folder has caches of its own, and all of this one moves: it moves whole.
						self.move_folder(local, held, &path, &entry.path())?;
					}
				} else if meta.is_file() {
					self.write_in(local, held, &path, &entry.path())?;
				} else if meta.file_type().is_symlink() {
					if self.link_in(&path, &entry.path())? {
						local.moved_out(&entry.path())?;
					}
				} else {
					eprintln!("qorpera-folder: {path} is not a file, a folder or a link, and stays out of the folder");
				}
			}
			for child in local.mirrors(&dir) {
				// A folder of the node's with caches in it or below; one made now, or by a move not finished, moves whole
				// (`TRACKED`: what the index tracks in it, in those it tracks paths in).
				let path = join(&dir, &child);
				if (folders.contains(&child) || made.contains(&child)) && (whole || !tracked || tracks(&path, true)) {
					let whole = whole || child == name;
					if whole {
						local.mark_whole(&path, true).map_err(local::errno)?;
					}
					todo.push((path, whole));
				}
			}
			local.mark_whole(&dir, false).map_err(local::errno)?;
			self.tree.lock().unwrap().invalidate([dir.as_str()]);
			drop(renames);
		}
		Ok(())
	}

	/// Each file leaves the disk once it is in the folder, and each folder once it is empty, with their names there
	/// (`write_in`, `Local::moved_out`); a link moves as the folder's link. What stays is what has not moved yet, and
	/// what cannot (a link the folder does not take, anything else not a file or a folder), seen in the folder's place
	/// as a cache's are.
	/// A file or a link the node did not take now fails the move, which is tried again (`move_caches`).
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
				self.write_in(local, held, &to, &disk.join(rel))?;
			} else if meta.file_type().is_symlink() {
				if self.link_in(&to, &disk.join(rel))? {
					local.moved_out(&disk.join(rel))?;
				}
			} else {
				eprintln!("qorpera-folder: {to} is not a file, a folder or a link, and stays out of the folder");
			}
		}
		// Deepest first (the walk gives a folder before what is in it); one with something left in it stays.
		for (rel, _) in walked.iter().rev().filter(|(_, m)| m.is_dir()) {
			let _ = local.moved_out(&disk.join(rel));
		}
		let _ = local.moved_out(disk);
		Ok(())
	}

	/// Makes the disk's link `disk` the folder's link at `path`, to the same target (protocol 4): whether it did. One the
	/// folder cannot keep (a target that is not UTF-8, a name it has already, one it refuses) is not made, and stays on
	/// the disk; one the node did not take now (`again`) is a failure, so the move stays to be made.
	fn link_in(&self, path: &str, disk: &Path) -> Result<bool, i32> {
		let target = fs::read_link(disk).map_err(local::errno)?;
		let Some(target) = target.to_str() else {
			eprintln!("qorpera-folder: the link {path} stays out of the folder: its target is not UTF-8");
			return Ok(false);
		};
		match self.link.symlink(path, target) {
			Ok(version) => {
				self.versions.lock().unwrap().saved(path, &version);
				Ok(true)
			}
			Err(f) if again(&f) => Err(f.errno()),
			Err(f) => {
				eprintln!("qorpera-folder: the link {path} stays out of the folder: {f}");
				Ok(false)
			}
		}
	}

	/// Writes the disk's file `disk` to the folder's `path`, as the session's new file, and takes it off the disk
	/// (`Local::moved_file_out`). It is sealed meanwhile (`Local::seal`): an open of it for writing waits until it is in
	/// the folder, and one open for writing already defers the move until its writers are done, so no write to it is
	/// lost. The write is a draft: the file is in the folder only once its close lands it there, so no boundary
	/// publishes it half written, and a write given up leaves nothing (`move_caches`). One the node did not take is kept
	/// in `held` with its handle, as the mount keeps a close it did not take (`again`), and the next move writes the file
	/// again from the start through it.
	fn write_in(&self, local: &Local, held: &mut HashMap<String, Writer>, path: &str, disk: &Path) -> Result<(), i32> {
		let (file, ino) = local.seal(disk)?;
		let moved = self.write_sealed(local, held, path, disk, file, ino);
		local.unseal(ino);
		moved
	}

	/// `write_in` of the sealed file: `file`, opened for reading, and `ino`, its inode.
	fn write_sealed(
		&self,
		local: &Local,
		held: &mut HashMap<String, Writer>,
		path: &str,
		disk: &Path,
		mut file: fs::File,
		ino: u64,
	) -> Result<(), i32> {
		let executable = file.metadata().map_err(local::errno)?.permissions().mode() & 0o100 != 0;
		let mut writer = match held.remove(path) {
			Some(writer) => writer,
			None => {
				let request =
					OpenRequest { path: path.to_string(), base: None, create: true, exclusive: false, truncate: true, draft: true };
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
		local.moved_file_out(disk, ino)
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

/// The paths git's index `data` (at `index`) tracks, or None where it could not be read.
fn parsed_index(index: &str, data: &[u8]) -> Option<Vec<String>> {
	match index::paths(data) {
		Ok(paths) => Some(paths),
		Err(e) => {
			eprintln!("qorpera-folder: {index} could not be read ({e:?}); its worktree's cache list stays");
			None
		}
	}
}

/// The folder's path of `rel` in `worktree` ("" for its top).
fn below(worktree: &str, rel: &str) -> String {
	if rel.is_empty() {
		worktree.to_string()
	} else {
		join(worktree, rel)
	}
}

/// Where the folder's `path` in `worktree` is in it.
fn within<'a>(path: &'a str, worktree: &str) -> &'a str {
	path.strip_prefix(worktree).map_or(path, |rest| rest.trim_start_matches('/'))
}

/// Whether the folder's `path` is in `worktree`.
fn in_worktree(path: &str, worktree: &str) -> bool {
	path.strip_prefix(worktree).is_some_and(|rest| rest.starts_with('/'))
}

/// The worktree the folder's `path` is in, if it is in one.
fn worktree_of(path: &str) -> Option<String> {
	match git::place(path) {
		Place::Worktree { area, worker, .. } => Some(git::worktree(area, worker).0),
		_ => None,
	}
}

/// Whether no caches are moving into the folder in the worktree the node's folder `dir` is in (`cache.rs`); outside
/// one, none ever are.
fn settled(local: &Local, dir: &str) -> bool {
	worktree_of(dir).is_none_or(|worktree| local.cache.lock().unwrap().moves(Some(&worktree)).is_empty())
}

impl FolderFs {
	fn local(&self) -> Result<&Local, i32> {
		self.s.local.as_ref().ok_or(libc::ENOENT)
	}

	/// How long the kernel keeps a new local entry in `up`: one of a node's folder's caches not at all, as the node's
	/// entry wins once it has one (rule 1, `cache_lookup`).
	fn ttl(&self, up: &Up, area: Area) -> Duration {
		if area == Area::Cache && matches!(up, Up::Mount(_)) {
			Duration::ZERO
		} else {
			self.s.ttl
		}
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

	/// lookup of a name the node does not have: one of the folder's caches, if there is one.
	pub(super) fn cache_lookup(&self, parent: u64, name: &str, reply: ReplyEntry) -> Option<ReplyEntry> {
		let Some(local) = &self.s.local else { return Some(reply) };
		let Some(dir) = self.s.cache_dir(parent) else { return Some(reply) };
		match local.entry(Up::Mount(dir), name, Area::Cache) {
			// The node's entry wins once it has one (rule 1, `move_in`), so the kernel asks again each time.
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

	/// The local entries of the node's folder `ino` (at `dir`) added to its `entries`: the session-local git files in
	/// place of the node's, or the folder's caches where the node has nothing. A cache where the node has an entry now
	/// goes (rule 1), as do the caches of a folder in it the node no longer has (removed or renamed by another view);
	/// both wait while a worktree's caches move into the folder, whose moves make the node's folders first. A rename
	/// here since the listing may have given `dir` to another folder: what goes is that of `ino`'s path now.
	pub(super) fn merge_local(&self, ino: u64, dir: &str, entries: &mut Vec<(u64, FileType, String)>) -> Result<(), i32> {
		let Some(local) = &self.s.local else { return Ok(()) };
		if let Some(seed) = local::seed_of(dir).filter(|_| !self.s.code_host) {
			self.s.seed(local, &seed)?;
			entries.retain(|e| !local::git_file(&join(dir, &e.2)));
			entries.extend(local.entries_of(dir, Area::Git));
			return Ok(());
		}
		if self.s.cache_dir(ino).is_none() {
			return Ok(());
		}
		let gone = |dir: &str| {
			let no_folder = |child: &String| match self.s.child(ino, child) {
				Ok(c) => c.attr.kind != EntryKind::Folder,
				Err(e) => e == libc::ENOENT,
			};
			local.mirrors(dir).into_iter().filter(no_folder).collect::<Vec<_>>()
		};
		let listed = |dir: &str| local.entries_of(dir, Area::Cache).iter().any(|c| entries.iter().any(|e| e.2 == c.2));
		if settled(local, dir) && (listed(dir) || !gone(dir).is_empty()) {
			// Asked again, for the path `ino` has now, once no rename here is between the node's and its caches'
			// (`Local::folders`); none moves it while this holds.
			let _held = local.folders.lock().unwrap();
			let Ok(dir) = self.s.path_of(ino) else { return Ok(()) };
			if settled(local, &dir) {
				for child in gone(&dir) {
					local.drop_mirror(&join(&dir, &child));
				}
				for cache in local.entries_of(&dir, Area::Cache) {
					if self.s.child(ino, &cache.2).is_ok() {
						local.gone_top(&dir, &cache.2);
					}
				}
			}
		}
		// Those of the folder `ino` is now, whose listing this is.
		let Ok(dir) = self.s.path_of(ino) else { return Ok(()) };
		for cache in local.entries_of(&dir, Area::Cache) {
			if !entries.iter().any(|e| e.2 == cache.2) {
				entries.push(cache);
			}
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

	/// create of a local file: in a local folder, a session-local git file, or a new cache (`target`).
	pub(super) fn local_create(
		&self,
		parent: u64,
		name: &str,
		mode: u32,
		flags: i32,
		reply: ReplyCreate,
	) -> Option<ReplyCreate> {
		let Some(local) = &self.s.local else { return Some(reply) };
		match self.s.target(local, parent, name, Area::Cache, false) {
			Ok(None) => {
				if self.s.code_dir(parent).is_some_and(|d| alternates(&join(&d, name))) {
					reply.error(Errno::EPERM);
					return None;
				}
				return Some(reply);
			}
			Ok(Some((up, area))) => {
				let ttl = self.ttl(&up, area);
				match local.create(up, name, area, mode, flags) {
					Ok((attr, fh)) => {
						self.s.made(local, parent, name, false);
						reply.created(&ttl, &attr, Generation(0), FileHandle(fh), FopenFlags::empty())
					}
					Err(e) => reply.error(Errno::from_i32(e)),
				}
			}
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

	/// mkdir of a local folder: in a local folder, a session-local git folder, or a new cache (or, where the folder has a
	/// cache of that name already, EEXIST: a rule that changed since does not move it, rule 6).
	pub(super) fn local_mkdir(&self, parent: u64, name: &str, mode: u32, reply: ReplyEntry) -> Option<ReplyEntry> {
		let Some(local) = &self.s.local else { return Some(reply) };
		let (up, area) = match self.s.target(local, parent, name, Area::Cache, true) {
			Ok(Some(found)) => found,
			Ok(None) => return Some(reply),
			Err(e) => {
				reply.error(Errno::from_i32(e));
				return None;
			}
		};
		let ttl = self.ttl(&up, area);
		match local.mkdir(up, name, area, mode) {
			Ok(attr) => {
				self.s.made(local, parent, name, true);
				reply.entry(&ttl, &attr, Generation(0))
			}
			Err(e) => reply.error(Errno::from_i32(e)),
		}
		None
	}

	/// unlink and rmdir of a local file; and rmdir of a folder of the node's with caches in it, which is not empty.
	pub(super) fn local_remove(&self, parent: u64, name: &str, folder: bool, reply: ReplyEmpty) -> Option<ReplyEmpty> {
		let Some(local) = &self.s.local else { return Some(reply) };
		let done = match self.s.found(local, parent, name) {
			Ok(None) if folder && self.s.cache_dir(parent).is_some_and(|d| local.tops(&join(&d, name))) => {
				match self.s.child(parent, name) {
					Ok(c) if c.attr.kind == EntryKind::Folder => Err(libc::ENOTEMPTY),
					_ => return Some(reply),
				}
			}
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

	/// rename of a local file (within its area: across, EXDEV); of the node's onto a local file's place or a new cache's
	/// (EXDEV: `mv` copies it, so its files become the cache's), or onto a folder with caches in it (ENOTEMPTY); and
	/// git's refused rename onto its alternates.
	pub(super) fn local_rename(
		&self,
		from: (u64, &str),
		to: (u64, &str),
		flags: RenameFlags,
		reply: ReplyEmpty,
	) -> Option<ReplyEmpty> {
		let Some(local) = &self.s.local else { return Some(reply) };
		let done = match self.s.found(local, from.0, from.1) {
			Ok(None) => match self.node_rename(local, from, to) {
				Ok(()) => {
					if self.s.code_dir(to.0).is_some_and(|d| alternates(&join(&d, to.1))) {
						reply.error(Errno::EPERM);
						return None;
					}
					return Some(reply);
				}
				Err(e) => Err(e),
			},
			Ok(Some((source, area))) => {
				let folder = local.entry(source.clone(), from.1, area).is_ok_and(|a| a.kind == FileType::Directory);
				match self.s.target(local, to.0, to.1, area, folder) {
					Ok(Some(_)) if flags.contains(RenameFlags::RENAME_WHITEOUT) => Err(libc::EINVAL),
					Ok(Some((target, to_area))) if to_area == area => {
						let no_replace = flags.contains(RenameFlags::RENAME_NOREPLACE);
						let exchange = flags.contains(RenameFlags::RENAME_EXCHANGE);
						let done = local.rename((&source, from.1), (&target, to.1), area, no_replace, exchange);
						if done.is_ok() {
							self.s.made(local, to.0, to.1, folder);
						}
						done
					}
					Ok(_) => Err(libc::EXDEV),
					Err(e) => Err(e),
				}
			}
			Err(e) => Err(e),
		};
		match done {
			Ok(()) => reply.ok(),
			Err(e) => reply.error(Errno::from_i32(e)),
		}
		None
	}

	/// Whether the node may take the rename of its `from` to `to`, by the local files: not onto one's place, nor onto a
	/// new cache's (EXDEV), nor onto a folder with caches in it (ENOTEMPTY).
	fn node_rename(&self, local: &Local, from: (u64, &str), to: (u64, &str)) -> Result<(), i32> {
		if self.s.found(local, to.0, to.1)?.is_some() {
			return Err(libc::EXDEV);
		}
		let Some(dir) = self.s.cache_dir(to.0) else { return Ok(()) };
		match self.s.child(to.0, to.1) {
			Ok(c) if c.attr.kind == EntryKind::Folder && local.tops(&join(&dir, to.1)) => Err(libc::ENOTEMPTY),
			Ok(_) => Ok(()),
			Err(_) => {
				let folder = self.s.child(from.0, from.1).is_ok_and(|c| c.attr.kind == EntryKind::Folder);
				if self.s.cache(local, to.0, &dir, to.1, folder) {
					return Err(libc::EXDEV);
				}
				Ok(())
			}
		}
	}

	pub(super) fn local_symlink(
		&self,
		parent: u64,
		name: &str,
		target: &Path,
		reply: ReplyEntry,
	) -> Option<ReplyEntry> {
		let Some(local) = &self.s.local else { return Some(reply) };
		match self.s.target(local, parent, name, Area::Cache, false) {
			Ok(None) => return Some(reply),
			Ok(Some((up, area))) => {
				let ttl = self.ttl(&up, area);
				match local.symlink(up, name, area, target) {
					Ok(attr) => {
						self.s.made(local, parent, name, false);
						reply.entry(&ttl, &attr, Generation(0))
					}
					Err(e) => reply.error(Errno::from_i32(e)),
				}
			}
			Err(e) => reply.error(Errno::from_i32(e)),
		}
		None
	}

	pub(super) fn local_link(&self, ino: u64, to: (u64, &str), reply: ReplyEntry) -> Option<ReplyEntry> {
		if !is_local(ino) {
			// A file of the folder's, linked to a name on the machine's disk (a local file's, or a new cache's): another
			// file system.
			match self.s.local.as_ref().map(|local| self.s.target(local, to.0, to.1, Area::Cache, false)) {
				Some(Ok(Some(_))) => reply.error(Errno::EXDEV),
				Some(Err(e)) => reply.error(Errno::from_i32(e)),
				_ => return Some(reply),
			}
			return None;
		}
		let done = self.local().and_then(|local| {
			let (_, _, area) = local.name(ino).ok_or(libc::ENOENT)?;
			match self.s.target(local, to.0, to.1, area, false)? {
				Some((up, to_area)) if to_area == area => {
					let (ttl, attr) = (self.ttl(&up, area), local.link(ino, up, to.1, area)?);
					self.s.made(local, to.0, to.1, false);
					Ok((ttl, attr))
				}
				_ => Err(libc::EXDEV),
			}
		});
		match done {
			Ok((ttl, attr)) => reply.entry(&ttl, &attr, Generation(0)),
			Err(e) => reply.error(Errno::from_i32(e)),
		}
		None
	}

	/// readlink of a link on the machine's disk; the folder's own are the node's.
	pub(super) fn local_readlink(&self, ino: u64, reply: ReplyData) -> Option<ReplyData> {
		if !is_local(ino) {
			return Some(reply);
		}
		match self.local().and_then(|l| l.readlink(ino)) {
			Ok(target) => reply.data(&target),
			Err(e) => reply.error(Errno::from_i32(e)),
		}
		None
	}

	/// The index git is about to put in place for a worktree by renaming its lock `from` (`source`) onto `to`, read
	/// before the rename for the worktree's cache list (`index_after`): the worktree, with what git wrote, or None for
	/// one with no caches, which only reads it before its next one (and where it could not be read).
	pub(super) fn index_before(&self, from: &str, to: &str, source: &Child) -> Option<(String, Option<Vec<u8>>)> {
		let local = self.s.local.as_ref()?;
		let worktree = git::index_of(to)?;
		if source.attr.kind != EntryKind::File {
			return None;
		}
		if !local.has_caches(&worktree) {
			return Some((worktree, None));
		}
		match self.s.read_all(from, &source.attr.version, source.attr.size) {
			Ok(data) => Some((worktree, Some(data))),
			Err(e) => {
				eprintln!("qorpera-folder: {from} could not be read (errno {e})");
				Some((worktree, None))
			}
		}
	}

	/// The rename `index_before` read for landed at `to`: what git wrote is taken in, or the index is found stale. Not
	/// before the node has it, so that a read of the index from the node (`read_index`) that gave the one before is
	/// not taken. A stale one beside caches, which it may track (made while git put it in place, or where what git
	/// wrote could not be read), asks for the move of what it tracks, as `made` does.
	pub(super) fn index_after(&self, to: &str, read: Option<(String, Option<Vec<u8>>)>) {
		let (Some(local), Some((worktree, data))) = (&self.s.local, read) else { return };
		let Some(data) = data else {
			let mut list = local.cache.lock().unwrap();
			list.stale(&worktree);
			if local.has_caches(&worktree) {
				list.track(&worktree);
			}
			return;
		};
		self.s.indexed_data(local, &worktree, to, &data);
	}

	/// The node made or removed its folder `path` for this view: caches kept for a folder there before (one another
	/// view removed) go.
	pub(super) fn caches_gone(&self, path: &str) {
		if let Some(local) = &self.s.local {
			local.drop_mirror(path);
		}
	}

	/// Before the node renames its folder `from` to `to` for this view: held until its caches have moved with it
	/// (`caches_renamed`, `Local::folders`). Refused while caches are moving into the folder in its worktree and one of
	/// its name is still on the disk (EBUSY: the move makes the node's folder first and empties the cache into it), and
	/// out of their worktree while some in it or below it are, or are still to (EXDEV: `mv` copies), where the move
	/// would not find them (with a move of what its index tracks, any); so is a rename of the worktree, or of a folder
	/// it is in.
	pub(super) fn folder_renaming(&self, from: (u64, &str), to: (u64, &str)) -> Result<Option<MutexGuard<'_, u64>>, i32> {
		let Some(local) = &self.s.local else { return Ok(None) };
		let held = local.folders.lock().unwrap();
		let Some(dir) = self.s.cache_dir(from.0) else { return Ok(Some(held)) };
		let path = join(&dir, from.1);
		if local.is_top(&dir, from.1) && !settled(local, &dir) {
			return Err(libc::EBUSY);
		}
		// The names still to move in the worktrees the rename takes caches of: the one it is in, or those it holds.
		let takes = |worktree: &str| path == worktree || in_worktree(&path, worktree) || in_worktree(worktree, &path);
		let moves = local.cache.lock().unwrap().moves(None);
		let (tracked, names): (Vec<String>, Vec<String>) =
			moves.into_iter().filter(|(w, _)| takes(w)).map(|(_, n)| n).partition(|n| n == cache::TRACKED);
		// The caches an index tracks can be anywhere in their worktree.
		if local.moving_below(&path, &names) || !tracked.is_empty() && local.has_caches(&path) {
			let worktree = worktree_of(&path);
			if worktree.is_none() || worktree_of(&join(&self.s.path_of(to.0)?, to.1)) != worktree {
				return Err(libc::EXDEV);
			}
		}
		Ok(Some(held))
	}

	/// The node renamed its folder `from` to `to` for this view (`folder_renaming`): its caches move with it.
	pub(super) fn caches_renamed(&self, held: Option<MutexGuard<'_, u64>>, from: &str, to: &str) {
		if let Some(local) = &self.s.local {
			local.renamed(from, to);
		}
		if let Some(mut renames) = held {
			*renames += 1;
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn a_kept_write_belongs_to_the_moves_of_its_worktree() {
		let w = "code/o/n/worktrees/w";
		assert!(in_worktree("code/o/n/worktrees/w/node_modules/x.js", w));
		assert!(in_worktree("code/o/n/worktrees/w/modules/a/x.js", w));
		assert!(!in_worktree("code/o/n/worktrees/w2/node_modules/x.js", w));
		assert!(!in_worktree("code/o/n/worktrees/w", w));
		assert_eq!(worktree_of("code/o/n/worktrees/w/modules/x.js").as_deref(), Some(w));
		assert_eq!(worktree_of("code/o/n/worktrees/w").as_deref(), Some(w));
		assert_eq!(worktree_of("code/o/n/repo.git/worktrees/w/index"), None);
		assert_eq!(worktree_of("notes/node_modules"), None);
	}

	#[test]
	fn packed_refs_lock_forgets_the_listings_of_the_loose_refs() {
		let entry = |name: &str, kind| Entry { name: name.into(), kind, size: 0, mtime_ms: 1, executable: false, version: "1".into(), authority: None };
		let mut tree = Tree::new();
		// code/o/n/repo.git/refs/heads, each folder held by the kernel.
		let mut dirs = vec![ROOT];
		for name in ["code", "o", "n", "repo.git", "refs", "heads"] {
			let (kids, _) = tree.install(*dirs.last().unwrap(), vec![entry(name, EntryKind::Folder)], tree.changes(), true, None);
			tree.hold(kids[0].ino);
			dirs.push(kids[0].ino);
		}
		let (refs, heads) = (dirs[5], dirs[6]);
		let topic = || vec![entry("main", EntryKind::File), entry("topic", EntryKind::File)];
		tree.install(heads, topic(), tree.changes(), true, None);
		// A ref's lock forgets the ref's folder's listing, not the others.
		locked(&mut tree, "code/o/n/repo.git/refs/heads/main.lock");
		assert!(tree.listing(heads).is_none() && tree.listing(refs).is_some());
		tree.install(heads, topic(), tree.changes(), true, None);
		// packed-refs' lock forgets every listing git walks for the loose refs.
		locked(&mut tree, "code/o/n/repo.git/packed-refs.lock");
		assert!(tree.listing(refs).is_none() && tree.listing(heads).is_none());
		assert!(tree.listing(dirs[3]).is_some(), "the repository's folder keeps its listing");
	}
}
