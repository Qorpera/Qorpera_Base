//! The machine's caches (deploy/first-node/RUNTIME-FOLDER-MACHINE-CACHES.md "The rules"): the folder names whose new
//! folders live on the machine's disk (`local.rs`), never published, unseen by other views. One table (`NAMES`)
//! decides them: rule 2's dependency names in any folder, rule 3's build names in a folder holding a project file
//! (`PROJECT_FILES`), and, in a worktree, each worktree's cache list (rule 4; RUNTIME-FOLDER-CODING-MACHINES.md "The
//! cache list").
//!
//! A worktree's list starts from the table's names but `out`. A name under which the worktree's own index has entries
//! leaves the list, and stays off it, so files already published never fall back into a cache; the names that left are
//! written through to a file beside the cached folders and read back by a program started again. The cache folders of
//! a name that left move into the folder (`mount/on_disk.rs`); a move not finished is written through too, tried
//! again, and while one is left a marker in the mount's state directory (`MOVING`) makes `qorpera-folder publish`
//! refuse, so no boundary leaves out files git tracks.
//!
//! Git's ignore rules make the rest of a worktree's caches, files too (`ignore.rs`), but never a path its index tracks
//! (`tracks`). A cache git comes to track (`git add -f`) moves into the folder the same way, as the move `TRACKED`.
//!
//! A wrong list only keeps the session's own files unpublished, which root in the machine could do anyway.

use crate::index;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

/// The marker in a mount's state directory that is there while a move is unfinished.
pub const MOVING: &str = "caches.moving";

/// The move, in place of a name, of the caches a worktree's index tracks, or tracks paths in: no folder's name.
pub const TRACKED: &str = "/";

/// What makes a new folder of a name a cache. Names match exactly (rule 5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Named {
	/// Rule 2: in any folder.
	Dependency,
	/// Rule 3: in a project, and at any depth in a worktree (rule 4).
	Build,
	/// Rule 3's `out`: in a project; in a worktree only when git ignores it (rule 4).
	Out,
}

/// The cache names, one table for every rule.
pub const NAMES: [(&str, Named); 21] = [
	("node_modules", Named::Dependency),
	(".pnpm-store", Named::Dependency),
	(".venv", Named::Dependency),
	("venv", Named::Dependency),
	("__pycache__", Named::Dependency),
	(".pytest_cache", Named::Dependency),
	(".mypy_cache", Named::Dependency),
	(".ruff_cache", Named::Dependency),
	(".tox", Named::Dependency),
	(".gradle", Named::Dependency),
	(".turbo", Named::Dependency),
	(".next", Named::Dependency),
	(".nuxt", Named::Dependency),
	(".svelte-kit", Named::Dependency),
	(".parcel-cache", Named::Dependency),
	("dist", Named::Build),
	("build", Named::Build),
	("target", Named::Build),
	("coverage", Named::Build),
	(".cache", Named::Build),
	("out", Named::Out),
];

/// The files that make the folder holding one a project (rule 3).
pub const PROJECT_FILES: [&str; 14] = [
	"package.json",
	"Cargo.toml",
	"pyproject.toml",
	"setup.py",
	"requirements.txt",
	"go.mod",
	"pom.xml",
	"build.gradle",
	"build.gradle.kts",
	"Gemfile",
	"composer.json",
	"mix.exs",
	"deno.json",
	"CMakeLists.txt",
];

pub fn named(name: &str) -> Option<Named> {
	NAMES.iter().find(|(n, _)| *n == name).map(|(_, kind)| *kind)
}

/// Whether a new folder `name` outside the code areas is a cache (rules 2 and 3). `project` says whether its parent
/// holds one of `PROJECT_FILES`; it is asked only for a build name.
pub fn outside(name: &str, project: impl FnOnce() -> bool) -> bool {
	match named(name) {
		Some(Named::Dependency) => true,
		Some(Named::Build | Named::Out) => project(),
		None => false,
	}
}

/// Whether `name` starts on a worktree's list (rule 4).
pub fn on_worktree_list(name: &str) -> bool {
	matches!(named(name), Some(Named::Dependency | Named::Build))
}

/// One line of the file: a name that left a worktree's list, or (`moved`) whose cache folders all moved into the folder.
#[derive(Serialize, Deserialize)]
struct Line {
	w: String,
	n: String,
	#[serde(default, skip_serializing_if = "std::ops::Not::not")]
	moved: bool,
}

#[derive(Default)]
struct Worktree {
	left: BTreeSet<String>,
	/// Names that left whose cache folders have not all moved into the folder yet (and `TRACKED`).
	moving: BTreeSet<String>,
	/// Its index was read since the program started.
	read: bool,
	/// The paths its index tracked when it was last read (a sparse index's folders without their `/`).
	tracked: BTreeSet<String>,
}

pub struct CacheList {
	/// By worktree path (`code/<owner>/<name>/worktrees/<worker>`).
	worktrees: HashMap<String, Worktree>,
	/// Where the names that left are written through; None keeps them in memory only.
	file: Option<File>,
	/// `MOVING` in the mount's state directory; None keeps no marker.
	marker: Option<PathBuf>,
}

impl CacheList {
	pub fn memory() -> CacheList {
		CacheList { worktrees: HashMap::new(), file: None, marker: None }
	}

	/// The list kept in `path`, with the names an earlier program saw leave and the moves it did not finish; the marker
	/// `marker` is there just while one is left.
	pub fn open(path: &Path, marker: Option<PathBuf>) -> io::Result<CacheList> {
		let mut out = CacheList::memory();
		match std::fs::read(path) {
			Ok(text) => {
				for line in text.split(|b| *b == b'\n') {
					let Ok(l) = serde_json::from_slice::<Line>(line) else { continue };
					let w = out.worktrees.entry(l.w).or_default();
					if l.moved {
						w.moving.remove(&l.n);
					} else {
						if l.n != TRACKED {
							w.left.insert(l.n.clone());
						}
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
		on_worktree_list(name) && !self.worktrees.get(worktree).is_some_and(|w| w.left.contains(name))
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

	/// Whether `worktree`'s index tracks `path` (in the worktree), or a path in it: as it did when it was last read.
	pub fn tracks(&self, worktree: &str, path: &str) -> bool {
		let Some(w) = self.worktrees.get(worktree) else { return false };
		let below = format!("{path}/");
		self.covers(worktree, path) || w.tracked.range(below.clone()..).next().is_some_and(|p| p.starts_with(&below))
	}

	/// Whether `worktree`'s index tracks `path` and all in it: itself, or a sparse index's folder it is in.
	pub fn covers(&self, worktree: &str, path: &str) -> bool {
		let Some(w) = self.worktrees.get(worktree) else { return false };
		let mut at = Some(path);
		while let Some(p) = at {
			if w.tracked.contains(p) {
				return true;
			}
			at = p.rsplit_once('/').map(|(up, _)| up);
		}
		false
	}

	/// `worktree`'s index tracks caches, or paths in them: they move into the folder (`TRACKED`).
	pub fn track(&mut self, worktree: &str) {
		let w = self.worktrees.entry(worktree.to_string()).or_default();
		if !w.moving.insert(TRACKED.to_string()) {
			return;
		}
		self.write(&Line { w: worktree.to_string(), n: TRACKED.to_string(), moved: false });
		self.mark();
	}

	/// `worktree`'s index lists `paths` now: the names that leave its list by it.
	pub fn indexed(&mut self, worktree: &str, paths: &[String]) -> Vec<String> {
		let w = self.worktrees.entry(worktree.to_string()).or_default();
		w.read = true;
		w.tracked = paths.iter().map(|p| p.strip_suffix('/').unwrap_or(p).to_string()).collect();
		let mut leaving = BTreeSet::new();
		for path in paths {
			for name in index::folders(path) {
				if on_worktree_list(name) && !w.left.contains(name) {
					leaving.insert(name.to_string());
				}
			}
		}
		w.left.extend(leaving.iter().cloned());
		w.moving.extend(leaving.iter().cloned());
		for name in &leaving {
			self.write(&Line { w: worktree.to_string(), n: name.clone(), moved: false });
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
		self.write(&Line { w: worktree.to_string(), n: name.to_string(), moved: true });
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

	/// Puts the marker there while a move is unfinished, and takes it away once none is (after the line saying so, so
	/// a program stopped between the two puts it right when started again).
	fn mark(&self) {
		let Some(marker) = &self.marker else { return };
		let done = if self.worktrees.values().any(|w| !w.moving.is_empty()) {
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
	fn the_table_decides_by_rule_and_exact_name() {
		let never = || -> bool { panic!("asked for a project") };
		assert!(outside("node_modules", never) && outside(".pnpm-store", never) && outside(".venv", never));
		assert!(outside("build", || true) && outside("out", || true) && !outside("build", || false));
		assert!(!outside("Build", never) && !outside("BUILD", never) && !outside("vendor", never));
		assert!(!outside(".yarn", never) && !outside("src", never));
		let list = CacheList::memory();
		let w = "code/o/n/worktrees/w";
		assert!(list.listed(w, ".svelte-kit") && list.listed(w, "coverage") && !list.listed(w, "out"));
		assert_eq!(NAMES.iter().filter(|(n, _)| on_worktree_list(n)).count(), 20);
		assert!(PROJECT_FILES.contains(&"Cargo.toml") && !PROJECT_FILES.contains(&"cargo.toml"));
	}

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
	fn tracked_paths_and_the_folders_above_them_are_tracked() {
		let w = "code/o/n/worktrees/w";
		let mut list = CacheList::memory();
		assert!(!list.tracks(w, "a"));
		let paths = ["a/b/keep.txt", "a/b-c", "x.log", "sparse/dir/"].map(String::from);
		list.indexed(w, &paths);
		for path in ["a", "a/b", "a/b/keep.txt", "a/b-c", "x.log", "sparse/dir", "sparse/dir/deep/file", "sparse"] {
			assert!(list.tracks(w, path), "{path}");
		}
		for path in ["a/b/other.txt", "a/b-", "a/bc", "x", "x.lo", "b", "sparse/di", "sparse/dir2"] {
			assert!(!list.tracks(w, path), "{path}");
		}
		for path in ["a/b/keep.txt", "x.log", "sparse/dir", "sparse/dir/deep/file"] {
			assert!(list.covers(w, path), "{path}");
		}
		for path in ["a", "a/b", "sparse", "a/b/other.txt"] {
			assert!(!list.covers(w, path), "{path}");
		}
		assert!(!list.tracks("code/o/n/worktrees/v", "a"));
		// What the index tracks now, not what it did.
		list.indexed(w, &["y".to_string()]);
		assert!(!list.tracks(w, "a/b/keep.txt") && list.tracks(w, "y"));
	}

	#[test]
	fn a_move_of_tracked_caches_is_kept_until_done() {
		let dir = std::env::temp_dir().join(format!("qorpera-cache-tracked-{}", std::process::id()));
		std::fs::create_dir_all(&dir).unwrap();
		let (file, marker) = (dir.join("left.jsonl"), dir.join(MOVING));
		let _ = std::fs::remove_file(&file);
		let w = "code/o/n/worktrees/w";
		let mut list = CacheList::open(&file, Some(marker.clone())).unwrap();
		list.track(w);
		list.track(w);
		assert_eq!(list.moves(None), [(w.to_string(), TRACKED.to_string())]);
		assert!(marker.exists() && list.listed(w, "build"));
		let mut again = CacheList::open(&file, Some(marker.clone())).unwrap();
		assert_eq!(again.moves(Some(w)), [(w.to_string(), TRACKED.to_string())]);
		// No name left the list for it, and the index is read again before the move.
		assert!(again.listed(w, "build") && !again.read(w) && !again.tracks(w, "build"));
		again.moved(w, TRACKED);
		assert!(again.moves(None).is_empty() && !marker.exists());
		assert!(CacheList::open(&file, Some(marker.clone())).unwrap().moves(None).is_empty());
		std::fs::remove_dir_all(&dir).unwrap();
	}
}
