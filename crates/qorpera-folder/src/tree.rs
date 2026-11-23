//! What the folder program remembers about the folder: inode numbers for paths the kernel knows,
//! folder listings it fetched, and the attributes from those listings. Nothing here talks to the
//! node or the kernel; `mount.rs` does both and uses this under one lock.
//!
//! Rules:
//! - An inode number is never reused while the program runs, so the generation is always 0.
//! - A file's inode stands for one version of it. A newer version gets a new inode; the old one is
//!   detached: no longer reachable by name, its attributes frozen, still readable by whoever opened it.
//!   So the kernel never caches pages of two versions under one inode.
//! - A node stays while the kernel holds a lookup on it or a cached listing names it.
//! - A change to a path drops that path's attributes and its parent's listing. The kernel is then told
//!   to forget the name and the cached pages (`Inval`).
//! - `changes` counts invalidations. A listing fetched while one happened is passed on but not kept.

use crate::proto::{join, split, Authority, Entry, EntryKind};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

pub const ROOT: u64 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attr {
	pub kind: EntryKind,
	pub size: u64,
	pub mtime_ms: i64,
	pub executable: bool,
	/// The core's version of the path (an opaque id).
	pub version: String,
	pub authority: Option<Authority>,
}

impl Attr {
	fn of(e: &Entry) -> Attr {
		Attr { kind: e.kind, size: e.size, mtime_ms: e.mtime_ms, executable: e.executable, version: e.version.clone(), authority: e.authority.clone() }
	}
	pub fn root() -> Attr {
		Attr { kind: EntryKind::Folder, size: 0, mtime_ms: 0, executable: false, version: String::new(), authority: None }
	}
	/// Whether `next` is another version of the file or link (or not the same kind of thing at all).
	fn replaced_by(&self, next: &Attr) -> bool {
		match (self.kind, next.kind) {
			(EntryKind::Folder, EntryKind::Folder) => false,
			(a, b) if a == b => self.version != next.version,
			_ => true,
		}
	}
}

#[derive(Debug)]
struct Node {
	path: String,
	parent: u64,
	/// Current attributes; None when a change made them unknown.
	attr: Option<Attr>,
	/// The attributes last seen, to tell a new version of a file from the same one.
	seen: Attr,
	/// Lookups the kernel holds (it gives them back with forget).
	lookups: u64,
	/// Named in its parent's cached listing.
	listed: bool,
	/// Replaced by a newer version: unreachable by name, attributes frozen.
	detached: bool,
	/// Removed or replaced by this program's own change (a removal, a move, a file made over it): its path holds
	/// another file now, or none.
	removed: bool,
	/// Moved into a cache by this program (`mount/on_disk.rs`): the kernel's entry for it names the cache's file now.
	cached: bool,
	dir_gen: u64,
}

/// One entry of a listing as the kernel gets it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Child {
	pub name: String,
	pub ino: u64,
	pub attr: Attr,
}

/// What the kernel must drop after a change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Inval {
	/// The inode's attributes and cached pages.
	Inode(u64),
	/// The name under a folder.
	Entry(u64, String),
}

pub fn find_child<'a>(children: &'a [Child], name: &str) -> Option<&'a Child> {
	children.binary_search_by(|c| c.name.as_str().cmp(name)).ok().map(|i| &children[i])
}

#[derive(Debug)]
pub struct Tree {
	nodes: HashMap<u64, Node>,
	by_path: BTreeMap<String, u64>,
	dirs: HashMap<u64, Arc<Vec<Child>>>,
	next_ino: u64,
	changes: u64,
	resync_gen: u64,
}

impl Default for Tree {
	fn default() -> Self {
		Self::new()
	}
}

impl Tree {
	pub fn new() -> Tree {
		let mut nodes = HashMap::new();
		nodes.insert(
			ROOT,
			Node {
				path: String::new(),
				parent: ROOT,
				attr: Some(Attr::root()),
				seen: Attr::root(),
				lookups: 1,
				listed: false,
				detached: false,
				removed: false,
				cached: false,
				dir_gen: 0,
			},
		);
		let mut by_path = BTreeMap::new();
		by_path.insert(String::new(), ROOT);
		Tree { nodes, by_path, dirs: HashMap::new(), next_ino: ROOT + 1, changes: 0, resync_gen: 0 }
	}

	pub fn changes(&self) -> u64 {
		self.changes
	}

	pub fn dir_changes(&self, dir: u64) -> u64 {
		self.nodes.get(&dir).map_or(self.changes, |n| n.dir_gen.max(self.resync_gen))
	}

	fn touch_dir(&mut self, dir: u64) {
		if let Some(n) = self.nodes.get_mut(&dir) {
			n.dir_gen = self.changes;
		}
	}

	pub fn path(&self, ino: u64) -> Option<&str> {
		self.nodes.get(&ino).map(|n| n.path.as_str())
	}

	pub fn parent(&self, ino: u64) -> Option<u64> {
		self.nodes.get(&ino).map(|n| n.parent)
	}

	/// The attributes if they are known to be current (or frozen, for a detached version).
	pub fn attr(&self, ino: u64) -> Option<Attr> {
		self.nodes.get(&ino).and_then(|n| n.attr.clone())
	}

	/// The attributes the inode was last seen with, known to be current or not: a file's inode stands for one version
	/// of it, so its version is the one it had then.
	pub fn last_seen(&self, ino: u64) -> Option<Attr> {
		self.nodes.get(&ino).map(|n| n.seen.clone())
	}

	#[cfg(test)]
	fn knows(&self, ino: u64) -> bool {
		self.nodes.contains_key(&ino)
	}

	/// Whether the inode is what its path shows now (not a version a newer one replaced, nor a removed name).
	pub fn current(&self, ino: u64) -> bool {
		self.nodes.get(&ino).is_some_and(|n| !n.detached && self.by_path.get(&n.path) == Some(&ino))
	}

	/// Whether this program's own change removed or replaced the inode's file, so nothing written through it has a
	/// path to go to (a newer version arriving from the node does not count: its path is still the same file's).
	pub fn removed_here(&self, ino: u64) -> bool {
		self.nodes.get(&ino).is_none_or(|n| n.removed)
	}

	/// This program moved the inode's file into a cache, after it removed it (`removed_local`): the kernel moved its entry
	/// to the cache file's name, so an open by it is stale until the kernel drops that.
	pub fn moved_to_cache(&mut self, ino: u64) {
		if let Some(n) = self.nodes.get_mut(&ino) {
			n.cached = true;
		}
	}

	/// Whether this program moved the inode's file into a cache (`moved_to_cache`).
	pub fn in_cache(&self, ino: u64) -> bool {
		self.nodes.get(&ino).is_some_and(|n| n.cached)
	}

	/// The cached listing of a folder.
	pub fn listing(&self, dir: u64) -> Option<Arc<Vec<Child>>> {
		self.dirs.get(&dir).cloned()
	}

	/// How many inodes are remembered (for statfs).
	pub fn known(&self) -> usize {
		self.nodes.len()
	}

	/// Takes in a folder's listing fetched when `changes()` was `started`. Every entry gets an inode;
	/// attributes are taken only if no change came in meanwhile. The listing is kept only if `keep` too;
	/// the second value says whether it was kept (when not, the kernel must not cache what it is given).
	/// `hold` names an entry the kernel is about to look up, so its inode outlives an unkept listing.
	pub fn install(
		&mut self,
		dir: u64,
		entries: Vec<Entry>,
		started: u64,
		keep: bool,
		hold: Option<&str>,
	) -> (Arc<Vec<Child>>, bool) {
		let (children, kept, _) = self.install_inner(dir, entries, started, keep, hold, false);
		(children, kept)
	}

	pub fn install_dir(
		&mut self,
		dir: u64,
		entries: Vec<Entry>,
		started: u64,
		keep: bool,
	) -> (Arc<Vec<Child>>, bool, Vec<u64>) {
		self.install_inner(dir, entries, started, keep, None, true)
	}

	fn install_inner(
		&mut self,
		dir: u64,
		entries: Vec<Entry>,
		started: u64,
		keep: bool,
		hold: Option<&str>,
		hold_all: bool,
	) -> (Arc<Vec<Child>>, bool, Vec<u64>) {
		let Some(dir_path) = self.nodes.get(&dir).filter(|n| !n.detached).map(|n| n.path.clone()) else {
			return (Arc::new(Vec::new()), false, Vec::new());
		};
		let current = self.dir_changes(dir) <= started;
		let keep = keep && current;
		let mut detached = false;
		let mut children = Vec::with_capacity(entries.len());
		for e in entries {
			let path = join(&dir_path, &e.name);
			let attr = Attr::of(&e);
			let existing = self.by_path.get(&path).copied();
			let ino = match existing {
				Some(ino) if !self.nodes[&ino].seen.replaced_by(&attr) => ino,
				_ => {
					if let Some(old) = existing {
						self.detach(old);
						detached = true;
					}
					let ino = self.next_ino;
					self.next_ino += 1;
					self.nodes.insert(
						ino,
						Node {
							path: path.clone(),
							parent: dir,
							attr: None,
							seen: attr.clone(),
							lookups: 0,
							listed: false,
							detached: false,
							removed: false,
							cached: false,
							dir_gen: self.changes,
						},
					);
					self.by_path.insert(path, ino);
					ino
				}
			};
			let node = self.nodes.get_mut(&ino).expect("node of a known path");
			if current {
				node.attr = Some(attr.clone());
				node.seen = attr.clone();
			}
			if hold == Some(e.name.as_str()) {
				node.lookups += 1;
			}
			children.push(Child { name: e.name, ino, attr });
		}
		children.sort_by(|a, b| a.name.cmp(&b.name));
		children.dedup_by(|a, b| a.name == b.name);
		let mut held = Vec::new();
		if hold_all {
			held.reserve(children.len());
			for c in &children {
				if self.hold(c.ino) {
					held.push(c.ino);
				}
			}
		}
		let children = Arc::new(children);
		if keep {
			for c in children.iter() {
				if let Some(n) = self.nodes.get_mut(&c.ino) {
					n.listed = true;
				}
			}
			// The old listing's names that are gone now are no longer held by it.
			if let Some(old) = self.dirs.insert(dir, Arc::clone(&children)) {
				let kept: HashSet<u64> = children.iter().map(|c| c.ino).collect();
				for c in old.iter().filter(|c| !kept.contains(&c.ino)) {
					if let Some(n) = self.nodes.get_mut(&c.ino) {
						n.listed = false;
					}
					self.prune(c.ino);
				}
			}
		} else {
			// A cached listing that named a version now replaced must not hand out its inode. (When kept, the new
			// listing replaced it above.) Dropped only now: dropping it mid-loop would prune siblings this answer names.
			if detached {
				self.drop_listing(dir);
			}
			// Nodes made for this answer alone go when nothing holds them.
			for c in children.iter() {
				self.prune(c.ino);
			}
		}
		(children, keep, held)
	}

	/// The kernel looked a node up once more (from a cached listing).
	pub fn hold(&mut self, ino: u64) -> bool {
		if let Some(n) = self.nodes.get_mut(&ino) {
			n.lookups += 1;
			true
		} else {
			false
		}
	}

	/// The kernel gave back `count` lookups.
	pub fn forget(&mut self, ino: u64, count: u64) -> bool {
		if ino == ROOT {
			return false;
		}
		if let Some(n) = self.nodes.get_mut(&ino) {
			n.lookups = n.lookups.saturating_sub(count);
			let dropped = n.lookups == 0;
			self.prune(ino);
			dropped
		} else {
			true
		}
	}

	/// Paths changed: forget what they were and what their folders listed.
	pub fn invalidate<'a>(&mut self, paths: impl IntoIterator<Item = &'a str>) -> Vec<Inval> {
		self.changes += 1;
		let mut out = Vec::new();
		for path in paths {
			if path.is_empty() {
				self.touch_dir(ROOT);
				if self.dirs.contains_key(&ROOT) {
					self.drop_listing(ROOT);
				}
				out.push(Inval::Inode(ROOT));
				continue;
			}
			if let Some(&ino) = self.by_path.get(path) {
				if let Some(n) = self.nodes.get_mut(&ino) {
					n.attr = None;
					n.dir_gen = self.changes;
				}
				if self.dirs.contains_key(&ino) {
					self.drop_listing(ino);
				}
				out.push(Inval::Inode(ino));
			}
			let (parent_path, name) = split(path);
			if let Some(&parent) = self.by_path.get(parent_path) {
				self.touch_dir(parent);
				if self.dirs.contains_key(&parent) {
					self.drop_listing(parent);
				}
				out.push(Inval::Entry(parent, name.to_string()));
				out.push(Inval::Inode(parent));
			}
		}
		out.dedup();
		out
	}

	fn paths_under(&self, path: &str) -> Vec<(String, u64)> {
		let mut out = Vec::new();
		if let Some(&ino) = self.by_path.get(path) {
			out.push((path.to_string(), ino));
		}
		let prefix = format!("{path}/");
		for (p, &ino) in self.by_path.range(prefix.clone()..) {
			if !p.starts_with(&prefix) {
				break;
			}
			out.push((p.clone(), ino));
		}
		out
	}

	/// Forget the listing of the folder `path` and of each folder below it: the next lookup or listing in one asks the
	/// node. Nodes the kernel holds keep their inodes and attributes; one only a dropped listing named goes. A listing
	/// fetched across this is passed on but not kept. The kernel is told nothing: the caller's folders are ones it keeps
	/// no names in (`fresh`).
	pub fn drop_listings(&mut self, path: &str) {
		self.changes += 1;
		if path.is_empty() {
			self.resync_gen = self.changes;
			let dirs: Vec<u64> = self.dirs.keys().copied().collect();
			for dir in dirs {
				self.drop_listing(dir);
			}
			return;
		}
		let under: Vec<u64> = self.paths_under(path).into_iter().map(|(_, ino)| ino).collect();
		for ino in &under {
			self.touch_dir(*ino);
		}
		for dir in under {
			if self.dirs.contains_key(&dir) {
				self.drop_listing(dir);
			}
		}
	}

	pub fn resync(&mut self) -> Vec<Inval> {
		self.changes += 1;
		self.resync_gen = self.changes;
		let dirs: Vec<u64> = self.dirs.keys().copied().collect();
		for dir in dirs {
			self.drop_listing(dir);
		}
		let mut out = Vec::with_capacity(self.nodes.len() * 2);
		for (&ino, node) in self.nodes.iter_mut() {
			if ino == ROOT {
				out.push(Inval::Inode(ROOT));
				continue;
			}
			if node.detached {
				continue;
			}
			node.attr = None;
			out.push(Inval::Inode(ino));
			out.push(Inval::Entry(node.parent, split(&node.path).1.to_string()));
		}
		out
	}

	// ---- This program's own changes (writes, protocol 2) ------------------------------------------------------------
	//
	// The kernel makes, moves and drops its own names for the changes it asks for, so these only bring the tree in
	// step; the folder's cached listing goes, and the node lists it again with the view's pending changes. A file this
	// program changes keeps its inode across the versions it makes: the kernel's pages of it are what was written.

	/// The node of a name this program made (a file created or a folder made), held by the kernel's lookup.
	pub fn add_local(&mut self, dir: u64, name: &str, attr: Attr) -> u64 {
		self.changes += 1;
		self.touch_dir(dir);
		let Some(dir_path) = self.nodes.get(&dir).map(|n| n.path.clone()) else { return 0 };
		let path = join(&dir_path, name);
		if let Some(old) = self.by_path.get(&path).copied() {
			self.remove_here(old);
		}
		if self.dirs.contains_key(&dir) {
			self.drop_listing(dir);
		}
		let ino = self.next_ino;
		self.next_ino += 1;
		self.nodes.insert(
			ino,
			Node {
				path: path.clone(),
				parent: dir,
				attr: Some(attr.clone()),
				seen: attr,
				lookups: 1,
				listed: false,
				detached: false,
				removed: false,
				cached: false,
				dir_gen: self.changes,
			},
		);
		self.by_path.insert(path, ino);
		ino
	}

	pub fn set_local(&mut self, ino: u64, attr: Attr) {
		self.changes += 1;
		let Some(n) = self.nodes.get_mut(&ino).filter(|n| !n.detached) else { return };
		n.attr = Some(attr.clone());
		n.seen = attr.clone();
		n.dir_gen = self.changes;
		let parent = n.parent;
		let name = split(&n.path).1.to_string();
		self.touch_dir(parent);
		if let Some(list) = self.dirs.get_mut(&parent) {
			if let Ok(idx) = list.binary_search_by(|c| c.name.as_str().cmp(name.as_str())) {
				if list[idx].ino == ino {
					Arc::make_mut(list)[idx].attr = attr;
				}
			}
		}
	}

	/// This program removed `path`: its folder lists again, and it (with everything under it) is no longer reachable by
	/// name. A file still open keeps reading the version it had.
	pub fn removed_local(&mut self, path: &str) {
		self.invalidate([path]);
		for (_, ino) in self.paths_under(path) {
			self.remove_here(ino);
		}
	}

	/// This program moved `from` to `to` (in the folder `to_dir`): the node and everything under it keep their inodes
	/// at their new paths; whatever was at `to` is replaced, and both folders list again.
	pub fn renamed_local(&mut self, from: &str, to: &str, to_dir: u64) {
		self.changes += 1;
		self.touch_dir(to_dir);
		if let Some(old) = self.by_path.get(to).copied() {
			self.remove_here(old);
		}
		for path in [from, to] {
			if let Some(&parent) = self.by_path.get(split(path).0) {
				self.touch_dir(parent);
				if self.dirs.contains_key(&parent) {
					self.drop_listing(parent);
				}
			}
		}
		let Some(moved) = self.by_path.get(from).copied() else { return };
		let under = self.paths_under(from);
		for (path, ino) in under {
			let next = format!("{to}{}", &path[from.len()..]);
			self.by_path.remove(&path);
			if let Some(n) = self.nodes.get_mut(&ino) {
				n.path = next.clone();
				n.dir_gen = self.changes;
			}
			self.by_path.insert(next, ino);
		}
		if let Some(n) = self.nodes.get_mut(&moved) {
			n.parent = to_dir;
			n.listed = false;
		}
	}

	/// This program removed or replaced the node's file: detached, and marked so.
	fn remove_here(&mut self, ino: u64) {
		if let Some(n) = self.nodes.get_mut(&ino) {
			n.removed = true;
		}
		self.detach(ino);
	}

	/// A newer version of the node's path arrived: the node keeps its version for whoever holds it. Its folder's
	/// cached listing is the caller's to replace or drop (`install`).
	fn detach(&mut self, ino: u64) {
		let Some(n) = self.nodes.get_mut(&ino) else { return };
		n.detached = true;
		n.attr = Some(n.seen.clone());
		let path = n.path.clone();
		if self.by_path.get(&path) == Some(&ino) {
			self.by_path.remove(&path);
		}
		if self.dirs.contains_key(&ino) {
			self.drop_listing(ino);
		}
		if let Some(n) = self.nodes.get_mut(&ino) {
			n.listed = false;
		}
		self.prune(ino);
	}

	fn drop_listing(&mut self, dir: u64) {
		let Some(children) = self.dirs.remove(&dir) else { return };
		for c in children.iter() {
			if let Some(n) = self.nodes.get_mut(&c.ino) {
				n.listed = false;
			}
			self.prune(c.ino);
		}
	}

	fn prune(&mut self, ino: u64) {
		if ino == ROOT {
			return;
		}
		let Some(n) = self.nodes.get(&ino) else { return };
		if n.lookups > 0 || n.listed {
			return;
		}
		let n = self.nodes.remove(&ino).expect("checked above");
		if self.by_path.get(&n.path) == Some(&ino) {
			self.by_path.remove(&n.path);
		}
		self.drop_listing(ino);
	}

	#[cfg(test)]
	fn lookups(&self, ino: u64) -> u64 {
		self.nodes[&ino].lookups
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn file(name: &str, size: u64, version: &str) -> Entry {
		Entry { name: name.into(), kind: EntryKind::File, size, mtime_ms: 1, executable: false, version: version.into(), authority: None }
	}
	fn folder(name: &str) -> Entry {
		Entry { name: name.into(), kind: EntryKind::Folder, size: 0, mtime_ms: 1, executable: false, version: "f".into(), authority: None }
	}
	fn ino_of(children: &[Child], name: &str) -> u64 {
		children.iter().find(|c| c.name == name).unwrap().ino
	}

	#[test]
	fn listing_gives_stable_inodes_sorted() {
		let mut t = Tree::new();
		let (kids, kept) = t.install(ROOT, vec![file("b.md", 3, "v1"), folder("a")], t.changes(), true, None);
		assert!(kept);
		assert_eq!(kids.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["a", "b.md"]);
		let b = ino_of(&kids, "b.md");
		let a = ino_of(&kids, "a");
		assert_eq!(t.path(b), Some("b.md"));
		assert_eq!(t.attr(b).unwrap().size, 3);
		assert_eq!(t.listing(ROOT).unwrap().len(), 2);
		// A refetch keeps the inode of an unchanged path, and lets go of a name that is gone.
		let (again, _) = t.install(ROOT, vec![file("b.md", 3, "v1")], t.changes(), true, None);
		assert_eq!(ino_of(&again, "b.md"), b);
		assert!(!t.knows(a));
	}

	#[test]
	fn a_new_version_of_a_file_gets_a_new_inode_and_the_old_one_stays_for_its_holders() {
		let mut t = Tree::new();
		let (kids, _) = t.install(ROOT, vec![file("f", 3, "v1"), folder("d")], t.changes(), true, None);
		let v1 = ino_of(&kids, "f");
		let d = ino_of(&kids, "d");
		t.hold(v1);
		t.hold(d);
		t.invalidate(["f", "d"]);
		let (kids, _) =
			t.install(ROOT, vec![file("f", 9, "v2"), Entry { version: "g".into(), ..folder("d") }], t.changes(), true, None);
		let v2 = ino_of(&kids, "f");
		assert_ne!(v2, v1, "a new version is a new inode");
		assert_eq!(ino_of(&kids, "d"), d, "a folder keeps its inode");
		assert_eq!(t.attr(v1).unwrap().version, "v1", "the old inode keeps its version's attributes");
		assert_eq!(t.attr(v1).unwrap().size, 3);
		assert_eq!(t.attr(v2).unwrap().size, 9);
		// A change on the path no longer touches the old inode.
		let inval = t.invalidate(["f"]);
		assert!(inval.contains(&Inval::Inode(v2)) && !inval.contains(&Inval::Inode(v1)));
		assert_eq!(t.attr(v1).unwrap().version, "v1");
		assert!(t.resync().iter().all(|i| *i != Inval::Inode(v1)));
		assert!(t.attr(v1).is_some(), "a resync keeps a detached version's attributes");
		// It goes when the kernel lets go.
		t.forget(v1, 1);
		assert!(!t.knows(v1));
		// An unheld old inode goes at once.
		let (kids, _) = t.install(ROOT, vec![file("f", 9, "v3")], t.changes(), true, None);
		assert!(!t.knows(v2));
		assert_ne!(ino_of(&kids, "f"), v2);
	}

	#[test]
	fn a_newer_version_seen_before_the_feed_keeps_the_siblings_listed() {
		let mut t = Tree::new();
		let (kids, _) = t.install(ROOT, vec![file("a", 1, "v1"), file("b", 1, "v1"), file("c", 1, "v1")], t.changes(), true, None);
		let (a, c) = (ino_of(&kids, "a"), ino_of(&kids, "c"));
		// A second fetch of the same folder sees b's next version before the feed says so.
		let (kids, kept) = t.install(ROOT, vec![file("a", 1, "v1"), file("b", 2, "v2"), file("c", 1, "v1")], t.changes(), true, None);
		assert!(kept);
		assert_eq!((ino_of(&kids, "a"), ino_of(&kids, "c")), (a, c));
		for c in t.listing(ROOT).unwrap().iter() {
			assert!(t.attr(c.ino).is_some(), "{} is listed but unknown", c.name);
		}
		// Not kept (the feed was down): the cached listing that named the old b goes; siblings in the answer stay
		// reachable through their paths.
		let (kids, kept) = t.install(ROOT, vec![file("a", 1, "v1"), file("b", 3, "v3"), file("c", 1, "v1")], t.changes(), false, Some("b"));
		assert!(!kept);
		assert!(t.listing(ROOT).is_none());
		assert!(t.attr(ino_of(&kids, "b")).is_some(), "the entry about to be looked up stays");
	}

	#[test]
	fn a_change_drops_the_path_and_its_parent_listing() {
		let mut t = Tree::new();
		let (root, _) = t.install(ROOT, vec![folder("docs")], t.changes(), true, None);
		let docs = ino_of(&root, "docs");
		t.hold(docs);
		let (kids, _) = t.install(docs, vec![file("a.md", 1, "1"), file("b.md", 1, "1")], t.changes(), true, None);
		let a = ino_of(&kids, "a.md");
		t.hold(a);
		let inval = t.invalidate(["docs/a.md"]);
		assert_eq!(inval, vec![Inval::Inode(a), Inval::Entry(docs, "a.md".into()), Inval::Inode(docs)]);
		assert_eq!(t.attr(a), None, "attributes must be refetched");
		assert!(t.listing(docs).is_none(), "the folder's listing must be refetched");
		assert!(t.listing(ROOT).is_some(), "other listings stay");
		// b.md was only named by the dropped listing, so it went with it.
		assert!(!t.by_path.contains_key("docs/b.md"));
		// a.md is held by the kernel, so its inode stays.
		assert_eq!(t.path(a), Some("docs/a.md"));
	}

	#[test]
	fn dropping_the_listings_below_a_folder_keeps_what_the_kernel_holds() {
		let mut t = Tree::new();
		let (root, _) = t.install(ROOT, vec![folder("refs"), folder("logs")], t.changes(), true, None);
		let (refs, logs) = (ino_of(&root, "refs"), ino_of(&root, "logs"));
		t.hold(refs);
		t.hold(logs);
		let (kids, _) = t.install(refs, vec![folder("heads"), folder("tags")], t.changes(), true, None);
		let heads = ino_of(&kids, "heads");
		t.hold(heads);
		t.install(heads, vec![file("main", 41, "1"), file("topic", 41, "1")], t.changes(), true, None);
		t.install(logs, vec![folder("refs")], t.changes(), true, None);
		let started = t.changes();
		t.drop_listings("refs");
		assert!(t.listing(refs).is_none() && t.listing(heads).is_none(), "the folder's and those below it go");
		assert!(t.listing(logs).is_some() && t.listing(ROOT).is_some(), "other listings stay");
		assert_eq!(t.path(heads), Some("refs/heads"), "a folder the kernel holds keeps its inode");
		assert!(!t.by_path.contains_key("refs/heads/topic"), "an entry only a dropped listing named goes");
		let (kids, kept) = t.install(heads, vec![file("main", 41, "1")], started, true, None);
		assert!(!kept, "a listing fetched across the drop is not kept");
		assert_eq!(kids.len(), 1);
	}

	#[test]
	fn an_added_path_drops_the_parent_listing_only() {
		let mut t = Tree::new();
		t.install(ROOT, vec![file("x", 1, "1")], t.changes(), true, None);
		let inval = t.invalidate(["new.md"]);
		assert_eq!(inval, vec![Inval::Entry(ROOT, "new.md".into()), Inval::Inode(ROOT)]);
		assert!(t.listing(ROOT).is_none());
	}

	#[test]
	fn a_listing_fetched_across_a_change_is_not_kept() {
		let mut t = Tree::new();
		let started = t.changes();
		t.invalidate(["elsewhere.md"]);
		let (kids, kept) = t.install(ROOT, vec![file("x", 1, "1")], started, true, None);
		assert!(!kept);
		assert_eq!(kids.len(), 1);
		assert!(t.listing(ROOT).is_none());
		// The node made only for that answer is gone again, unless the kernel looked it up.
		assert!(!t.by_path.contains_key("x"));
	}

	#[test]
	fn a_held_entry_outlives_an_unkept_listing() {
		let mut t = Tree::new();
		let started = t.changes();
		t.invalidate(["elsewhere"]);
		let (kids, kept) = t.install(ROOT, vec![file("x", 1, "1"), file("y", 1, "1")], started, true, Some("x"));
		assert!(!kept);
		let x = ino_of(&kids, "x");
		assert!(t.knows(x), "the kernel is about to hold it");
		assert!(!t.knows(ino_of(&kids, "y")));
		assert_eq!(t.attr(x), None, "attributes fetched across a change are not trusted");
		// A cached listing holds the entry the kernel looks up.
		let (kids, kept) = t.install(ROOT, vec![file("x", 1, "1")], t.changes(), true, Some("x"));
		assert!(kept);
		assert_eq!(ino_of(&kids, "x"), x);
		assert_eq!(t.lookups(x), 2);
		assert_eq!(t.attr(x).unwrap().size, 1);
	}

	#[test]
	fn not_keeping_is_respected() {
		let mut t = Tree::new();
		let (_, kept) = t.install(ROOT, vec![file("x", 1, "1")], t.changes(), false, None);
		assert!(!kept);
		assert!(t.listing(ROOT).is_none());
	}

	#[test]
	fn forget_removes_unlisted_nodes() {
		let mut t = Tree::new();
		let (kids, _) = t.install(ROOT, vec![file("x", 1, "1")], t.changes(), true, None);
		let x = ino_of(&kids, "x");
		t.hold(x);
		t.hold(x);
		t.forget(x, 1);
		assert_eq!(t.lookups(x), 1);
		t.forget(x, 1);
		assert!(t.knows(x), "still named by the root listing");
		t.invalidate(["other"]);
		assert!(!t.knows(x), "listing dropped and no lookups left");
		// Forgetting the root never removes it.
		t.forget(ROOT, 100);
		assert!(t.knows(ROOT));
	}

	#[test]
	fn a_new_inode_after_a_path_is_pruned() {
		let mut t = Tree::new();
		let (kids, _) = t.install(ROOT, vec![file("x", 1, "1")], t.changes(), true, None);
		let old = ino_of(&kids, "x");
		t.invalidate(["x"]);
		let (kids, _) = t.install(ROOT, vec![file("x", 1, "1")], t.changes(), true, None);
		assert_ne!(ino_of(&kids, "x"), old, "inode numbers are never reused");
	}

	#[test]
	fn resync_drops_everything_but_keeps_held_inodes() {
		let mut t = Tree::new();
		let (root, _) = t.install(ROOT, vec![folder("d"), file("f", 1, "1")], t.changes(), true, None);
		let d = ino_of(&root, "d");
		let f = ino_of(&root, "f");
		t.hold(d);
		t.install(d, vec![file("g", 1, "1")], t.changes(), true, None);
		let inval = t.resync();
		assert!(t.listing(ROOT).is_none() && t.listing(d).is_none());
		assert!(t.knows(d) && !t.knows(f));
		assert_eq!(t.attr(d), None);
		assert_eq!(t.attr(ROOT), Some(Attr::root()));
		assert!(inval.contains(&Inval::Inode(ROOT)));
		assert!(inval.contains(&Inval::Inode(d)));
		assert!(inval.contains(&Inval::Entry(ROOT, "d".into())));
		assert_eq!(t.known(), 2);
	}

	#[test]
	fn a_removed_folder_drops_its_listing() {
		let mut t = Tree::new();
		let (root, _) = t.install(ROOT, vec![folder("d")], t.changes(), true, None);
		let d = ino_of(&root, "d");
		t.hold(d);
		t.install(d, vec![file("g", 1, "1")], t.changes(), true, None);
		t.invalidate(["d"]);
		assert!(t.listing(d).is_none());
		assert!(!t.by_path.contains_key("d/g"));
	}

	#[test]
	fn this_programs_own_changes_keep_their_inodes() {
		let mut t = Tree::new();
		let (root, _) = t.install(ROOT, vec![folder("d"), file("f", 1, "v1")], t.changes(), true, None);
		let (d, f) = (ino_of(&root, "d"), ino_of(&root, "f"));
		t.hold(d);
		t.hold(f);
		// A file made here: held by the kernel's lookup; its folder lists again.
		let new = Attr { kind: EntryKind::File, size: 0, mtime_ms: 5, executable: false, version: "p0".into(), authority: None };
		let n = t.add_local(d, "new.md", new);
		assert_eq!(t.path(n), Some("d/new.md"));
		// Its save keeps the inode, and a listing that shows that version does too.
		t.set_local(n, Attr { size: 3, version: "p1".into(), ..t.attr(n).unwrap() });
		let (kids, _) = t.install(d, vec![file("new.md", 3, "p1")], t.changes(), true, Some("new.md"));
		assert_eq!(ino_of(&kids, "new.md"), n);
		// A save of a file its folder's cached listing names: a lookup from that listing gives what the save made.
		t.set_local(n, Attr { size: 9, version: "p2".into(), ..t.attr(n).unwrap() });
		let list = t.listing(d).unwrap();
		let listed = list.iter().find(|c| c.ino == n).unwrap();
		assert_eq!((listed.attr.size, listed.attr.version.as_str()), (9, "p2"));
		// A rename keeps the inode at its new path; the file it replaced keeps its version for whoever holds it.
		t.renamed_local("d/new.md", "f", ROOT);
		assert_eq!(t.path(n), Some("f"));
		assert_eq!(t.attr(f).unwrap().version, "v1");
		let (kids, _) = t.install(ROOT, vec![folder("d"), file("f", 9, "p2")], t.changes(), true, Some("f"));
		assert_eq!(ino_of(&kids, "f"), n);
		// A folder's move takes what is under it along.
		let (kids, _) = t.install(d, vec![file("x", 1, "1")], t.changes(), true, Some("x"));
		let x = ino_of(&kids, "x");
		t.renamed_local("d", "e", ROOT);
		assert_eq!((t.path(d), t.path(x)), (Some("e"), Some("e/x")));
		// A removal: no longer reachable by name, still readable by its holder.
		t.removed_local("e");
		assert!(!t.by_path.contains_key("e") && !t.by_path.contains_key("e/x"));
		assert_eq!(t.attr(x).unwrap().version, "1");
		// Removed here, unlike a version a newer one from the node replaced, and unlike the file renamed over above.
		assert!(t.removed_here(x) && t.removed_here(f) && !t.removed_here(n));
		// One moved into a cache is stale by the name the kernel moved it to; only it.
		t.moved_to_cache(x);
		assert!(t.in_cache(x) && !t.in_cache(f) && !t.in_cache(d));
		let (kids, _) = t.install(ROOT, vec![file("f", 9, "p3")], t.changes(), true, Some("f"));
		assert_ne!(ino_of(&kids, "f"), n);
		assert!(!t.current(n) && !t.removed_here(n));
	}

	#[test]
	fn duplicate_names_in_one_listing_collapse() {
		let mut t = Tree::new();
		let (kids, _) = t.install(ROOT, vec![file("x", 1, "1"), file("x", 1, "1")], t.changes(), true, None);
		assert_eq!(kids.len(), 1);
	}

	#[test]
	fn arc_listing_find_child_and_btree_prefix_ops() {
		let mut t = Tree::new();
		let entries: Vec<Entry> = (0..64).map(|i| file(&format!("f{i:03}.txt"), i, &format!("v{i}"))).collect();
		let (kids, kept) = t.install(ROOT, entries, t.changes(), true, Some("f032.txt"));
		assert!(kept);
		let cached = t.listing(ROOT).unwrap();
		assert!(Arc::ptr_eq(&kids, &cached));
		let target = find_child(&cached, "f032.txt").unwrap();
		assert_eq!(target.attr.size, 32);
		assert!(find_child(&cached, "missing.txt").is_none());
		t.set_local(target.ino, Attr { size: 99, version: "v99".into(), ..target.attr.clone() });
		assert_eq!(find_child(&cached, "f032.txt").unwrap().attr.size, 32);
		assert_eq!(find_child(&t.listing(ROOT).unwrap(), "f032.txt").unwrap().attr.size, 99);
		let (dirs, _) = t.install(ROOT, vec![folder("a"), folder("a-other")], t.changes(), true, None);
		let a = find_child(&dirs, "a").unwrap().ino;
		let a_other = find_child(&dirs, "a-other").unwrap().ino;
		t.install(a, vec![file("x", 1, "1")], t.changes(), true, None);
		t.install(a_other, vec![file("y", 1, "1")], t.changes(), true, None);
		t.drop_listings("a");
		assert!(t.listing(a).is_none());
		assert!(t.listing(a_other).is_some());
	}

	#[test]
	fn unrelated_directory_change_does_not_discard_inflight_listing() {
		let mut t = Tree::new();
		let (dirs, _) = t.install(ROOT, vec![folder("alpha"), folder("beta")], t.changes(), true, None);
		let alpha = ino_of(&dirs, "alpha");
		let beta = ino_of(&dirs, "beta");
		t.hold(alpha);
		t.hold(beta);
		let started = t.changes();
		let new_attr = Attr { kind: EntryKind::File, size: 1, mtime_ms: 1, executable: false, version: "v1".into(), authority: None };
		let _ = t.add_local(beta, "b.txt", new_attr);
		let (kids, kept) = t.install(alpha, vec![file("a.txt", 2, "v2")], started, true, None);
		assert!(kept);
		assert_eq!(kids.len(), 1);
		assert!(t.listing(alpha).is_some());

		let started_resync = t.changes();
		t.resync();
		let (_, kept_after_resync) = t.install(alpha, vec![file("a.txt", 2, "v2")], started_resync, true, None);
		assert!(!kept_after_resync);
	}

	#[test]
	fn hold_returns_false_for_pruned_node_and_install_dir_holds_unkept_children() {
		let mut t = Tree::new();
		let (kids, _) = t.install(ROOT, vec![file("a.txt", 1, "v1")], t.changes(), true, None);
		let a = ino_of(&kids, "a.txt");
		assert!(t.hold(a));
		assert!(t.hold(a));
		assert!(!t.forget(a, 1));
		assert!(t.forget(a, 1));
		t.drop_listings("");
		assert!(!t.hold(a));

		let (kids2, kept2, held2) = t.install_dir(ROOT, vec![file("b.txt", 2, "v2")], t.changes(), false);
		assert!(!kept2);
		let b = ino_of(&kids2, "b.txt");
		assert_eq!(held2, vec![b]);
		assert!(t.hold(b));
		assert!(!t.forget(b, 1));
		assert!(t.forget(b, 1));
		assert!(!t.hold(b));
		assert!(!t.forget(ROOT, 1));
	}
}
