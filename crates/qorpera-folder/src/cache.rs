//! Each worktree's cache list (§6 "The per-session cache"; RUNTIME-FOLDER-CODING-MACHINES.md "The cache list"): the
//! folder names whose folders in the worktree live on the machine's disk (`local.rs`), never published, unseen by
//! other views. It starts from `git::CACHE_NAMES`. A name under which the worktree's own index has entries leaves the
//! list, and stays off it, so files already published never fall back into a cache; the names that left are written
//! through to a file beside the cached folders and read back by a program started again. The cache folders of a name
//! that left move into the folder (`mount/on_disk.rs`); a move not finished is written through too, tried again, and
//! while one is left a marker in the mount's state directory (`MOVING`) makes `qorpera-folder publish` refuse, so no
//! boundary leaves out files git tracks. So does a file a move left empty in the folder when it gave up on it (its disk
//! file went), until the folder no longer has it.
//!
//! A wrong list only keeps the session's own files unpublished, which root in the machine could do anyway.

use crate::git::CACHE_NAMES;
use crate::index;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

/// The marker in a mount's state directory that is there while a move is unfinished.
pub const MOVING: &str = "caches.moving";

/// One line of the file: a name that left a worktree's list, or (`moved`) whose cache folders all moved into the folder;
/// with no worktree, a file in the folder a move left empty (`n`, at the version `empty`), or (`moved`) out of it.
#[derive(Serialize, Deserialize)]
struct Line {
	w: String,
	n: String,
	#[serde(default, skip_serializing_if = "std::ops::Not::not")]
	moved: bool,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	empty: Option<String>,
}

#[derive(Default)]
struct Worktree {
	left: BTreeSet<String>,
	/// Names that left whose cache folders have not all moved into the folder yet.
	moving: BTreeSet<String>,
	/// Its index was read since the program started.
	read: bool,
}

pub struct CacheList {
	/// By worktree path (`code/<owner>/<name>/worktrees/<worker>`).
	worktrees: HashMap<String, Worktree>,
	/// The files in the folder moves left empty, by path, with the versions they were left at: to take out of it.
	empties: BTreeMap<String, String>,
	/// Where the names that left are written through; None keeps them in memory only.
	file: Option<File>,
	/// `MOVING` in the mount's state directory; None keeps no marker.
	marker: Option<PathBuf>,
}

impl CacheList {
	pub fn memory() -> CacheList {
		CacheList { worktrees: HashMap::new(), empties: BTreeMap::new(), file: None, marker: None }
	}

	/// The list kept in `path`, with the names an earlier program saw leave and the moves it did not finish; the marker
	/// `marker` is there just while one is left.
	pub fn open(path: &Path, marker: Option<PathBuf>) -> io::Result<CacheList> {
		let mut out = CacheList::memory();
		match std::fs::read(path) {
			Ok(text) => {
				for line in text.split(|b| *b == b'\n') {
					let Ok(l) = serde_json::from_slice::<Line>(line) else { continue };
					if l.w.is_empty() {
						match l.empty {
							Some(version) => out.empties.insert(l.n, version),
							None => out.empties.remove(&l.n),
						};
						continue;
					}
					let w = out.worktrees.entry(l.w).or_default();
					if l.moved {
						w.moving.remove(&l.n);
					} else {
						w.left.insert(l.n.clone());
						w.moving.insert(l.n);
					}
				}
			}
			Err(e) if e.kind() == io::ErrorKind::NotFound => {}
			Err(e) => return Err(e),
		}
		out.file = Some(OpenOptions::new().create(true).append(true).mode(0o600).open(path)?);
		out.marker = marker;
		out.mark();
		Ok(out)
	}

	/// Whether a folder named `name` in `worktree` is a cache.
	pub fn listed(&self, worktree: &str, name: &str) -> bool {
		CACHE_NAMES.contains(&name) && !self.worktrees.get(worktree).is_some_and(|w| w.left.contains(name))
	}

	/// Whether `worktree`'s index was read since the program started.
	pub fn read(&self, worktree: &str) -> bool {
		self.worktrees.get(worktree).is_some_and(|w| w.read)
	}

	/// `worktree`'s index changed without being read: it is read again before the next new cache.
	pub fn stale(&mut self, worktree: &str) {
		if let Some(w) = self.worktrees.get_mut(worktree) {
			w.read = false;
		}
	}

	/// `worktree`'s index lists `paths` now: the names that leave its list by it.
	pub fn indexed(&mut self, worktree: &str, paths: &[String]) -> Vec<String> {
		let w = self.worktrees.entry(worktree.to_string()).or_default();
		w.read = true;
		let mut leaving = BTreeSet::new();
		for path in paths {
			for name in index::folders(path) {
				if CACHE_NAMES.contains(&name) && !w.left.contains(name) {
					leaving.insert(name.to_string());
				}
			}
		}
		w.left.extend(leaving.iter().cloned());
		w.moving.extend(leaving.iter().cloned());
		for name in &leaving {
			self.write(&Line { w: worktree.to_string(), n: name.clone(), moved: false, empty: None });
		}
		if !leaving.is_empty() {
			self.mark();
		}
		leaving.into_iter().collect()
	}

	/// The names whose cache folders are still to move into the folder, with their worktrees: `worktree`'s, or all.
	pub fn moves(&self, worktree: Option<&str>) -> Vec<(String, String)> {
		let only = |w: &str| worktree.is_none() || worktree == Some(w);
		let of = |(w, t): (&String, &Worktree)| t.moving.iter().map(|n| (w.clone(), n.clone())).collect::<Vec<_>>();
		self.worktrees.iter().filter(|(w, _)| only(w)).flat_map(of).collect()
	}

	/// `worktree`'s cache folders named `name` all moved into the folder.
	pub fn moved(&mut self, worktree: &str, name: &str) {
		if !self.worktrees.get_mut(worktree).is_some_and(|w| w.moving.remove(name)) {
			return;
		}
		self.write(&Line { w: worktree.to_string(), n: name.to_string(), moved: true, empty: None });
		self.mark();
	}

	/// A move gave up on the file `path` (its disk file went) and left it empty in the folder, at `version`.
	pub fn emptied(&mut self, path: &str, version: &str) {
		self.empties.insert(path.to_string(), version.to_string());
		self.write(&Line { w: String::new(), n: path.to_string(), moved: false, empty: Some(version.to_string()) });
		self.mark();
	}

	/// The files in the folder moves left empty, with the versions they were left at.
	pub fn empties(&self) -> Vec<(String, String)> {
		self.empties.iter().map(|(path, version)| (path.clone(), version.clone())).collect()
	}

	/// The file `path` a move left empty is out of the folder (or another version took its place).
	pub fn emptied_out(&mut self, path: &str) {
		if self.empties.remove(path).is_none() {
			return;
		}
		self.write(&Line { w: String::new(), n: path.to_string(), moved: true, empty: None });
		self.mark();
	}

	fn write(&mut self, line: &Line) {
		let Some(file) = self.file.as_mut() else { return };
		let text = serde_json::to_string(line).unwrap() + "\n";
		// Not written through: a name leaves again when a program started again reads the index; a move is tried again.
		if let Err(e) = file.write_all(text.as_bytes()) {
			eprintln!("qorpera-folder: the cache list could not be written ({e}); it goes on in memory");
		}
	}

	/// Puts the marker there while a move is unfinished, or a file one left empty is in the folder, and takes it away
	/// once none is (after the line saying so, so a program stopped between the two puts it right when started again).
	fn mark(&self) {
		let Some(marker) = &self.marker else { return };
		let done = if !self.empties.is_empty() || self.worktrees.values().any(|w| !w.moving.is_empty()) {
			OpenOptions::new().create(true).truncate(false).write(true).mode(0o600).open(marker).and_then(|f| f.sync_all())
		} else {
			match std::fs::remove_file(marker) {
				Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
				done => done,
			}
		};
		if let Err(e) = done {
			eprintln!("qorpera-folder: the marker {} could not be set ({e})", marker.display());
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn names_leave_once_tracked_and_stay_off() {
		let dir = std::env::temp_dir().join(format!("qorpera-cache-{}", std::process::id()));
		std::fs::create_dir_all(&dir).unwrap();
		let file = dir.join("left.jsonl");
		let _ = std::fs::remove_file(&file);
		let w = "code/o/n/worktrees/w";
		let mut list = CacheList::open(&file, None).unwrap();
		assert!(list.listed(w, "build") && list.listed(w, "node_modules"));
		assert!(!list.listed(w, "out") && !list.read(w));
		let paths = ["build/a".to_string(), "src/build.rs".to_string(), "x/node_modules/".to_string()];
		assert_eq!(list.indexed(w, &paths), ["build", "node_modules"]);
		assert!(list.read(w) && !list.listed(w, "build") && !list.listed(w, "node_modules"));
		assert!(list.listed("code/o/n/worktrees/v", "build"));
		// Untracked again: still off.
		assert!(list.indexed(w, &[]).is_empty());
		assert!(!list.listed(w, "build"));
		let again = CacheList::open(&file, None).unwrap();
		assert!(!again.listed(w, "build") && again.listed(w, "dist") && !again.read(w));
		std::fs::remove_dir_all(&dir).unwrap();
	}

	#[test]
	fn unfinished_moves_are_kept_and_marked_until_done() {
		let dir = std::env::temp_dir().join(format!("qorpera-cache-moves-{}", std::process::id()));
		std::fs::create_dir_all(&dir).unwrap();
		let (file, marker) = (dir.join("left.jsonl"), dir.join(MOVING));
		let _ = std::fs::remove_file(&file);
		std::fs::write(&marker, b"").unwrap();
		let (w, v) = ("code/o/n/worktrees/w", "code/o/n/worktrees/v");
		let mut list = CacheList::open(&file, Some(marker.clone())).unwrap();
		// A marker left by a program whose moves all finished goes.
		assert!(list.moves(None).is_empty() && !marker.exists());
		list.indexed(w, &["build/a".to_string(), "dist/b".to_string()]);
		list.indexed(v, &["build/c".to_string()]);
		let pair = |w: &str, n: &str| (w.to_string(), n.to_string());
		assert_eq!(list.moves(Some(w)), [pair(w, "build"), pair(w, "dist")]);
		assert!(marker.exists());
		list.moved(w, "build");
		list.moved(v, "build");
		assert!(marker.exists());
		// A program started again finds the unfinished move; the marker stays until it is done.
		let mut again = CacheList::open(&file, Some(marker.clone())).unwrap();
		assert_eq!(again.moves(None), [pair(w, "dist")]);
		assert!(marker.exists() && !again.listed(w, "dist") && !again.listed(v, "build"));
		again.moved(w, "dist");
		assert!(again.moves(None).is_empty() && !marker.exists());
		assert!(CacheList::open(&file, Some(marker.clone())).unwrap().moves(None).is_empty());
		std::fs::remove_dir_all(&dir).unwrap();
	}

	#[test]
	fn files_moves_left_empty_are_kept_and_marked_until_out_of_the_folder() {
		let dir = std::env::temp_dir().join(format!("qorpera-cache-empties-{}", std::process::id()));
		std::fs::create_dir_all(&dir).unwrap();
		let (file, marker) = (dir.join("left.jsonl"), dir.join(MOVING));
		let _ = std::fs::remove_file(&file);
		let (w, x) = ("code/o/n/worktrees/w", "code/o/n/worktrees/w/build/x");
		let mut list = CacheList::open(&file, Some(marker.clone())).unwrap();
		list.indexed(w, &["build/a".to_string()]);
		list.emptied(x, "v1");
		list.moved(w, "build");
		// The move is done, but the file it left empty is still in the folder.
		assert!(list.moves(None).is_empty() && marker.exists());
		let mut again = CacheList::open(&file, Some(marker.clone())).unwrap();
		assert_eq!(again.empties(), [(x.to_string(), "v1".to_string())]);
		assert!(marker.exists() && !again.listed(w, "build"));
		again.emptied_out(x);
		assert!(again.empties().is_empty() && !marker.exists());
		assert!(CacheList::open(&file, Some(marker.clone())).unwrap().empties().is_empty());
		std::fs::remove_dir_all(&dir).unwrap();
	}
}
