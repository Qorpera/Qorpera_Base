//! Each worktree's cache list (§6 "The per-session cache"; RUNTIME-FOLDER-CODING-MACHINES.md "The cache list"): the
//! folder names whose folders in the worktree live on the machine's disk (`local.rs`), never published, unseen by
//! other views. It starts from `git::CACHE_NAMES`. A name under which the worktree's own index has entries leaves the
//! list, and stays off it, so files already published never fall back into a cache; the names that left are written
//! through to a file beside the cached folders and read back by a program started again.
//!
//! A wrong list only keeps the session's own files unpublished, which root in the machine could do anyway.

use crate::git::CACHE_NAMES;
use crate::index;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

/// One line of the file: a name that left a worktree's list.
#[derive(Serialize, Deserialize)]
struct Line {
	w: String,
	n: String,
}

#[derive(Default)]
struct Worktree {
	left: BTreeSet<String>,
	/// Its index was read since the program started.
	read: bool,
}

pub struct CacheList {
	/// By worktree path (`code/<owner>/<name>/worktrees/<worker>`).
	worktrees: HashMap<String, Worktree>,
	/// Where the names that left are written through; None keeps them in memory only.
	file: Option<File>,
}

impl CacheList {
	pub fn memory() -> CacheList {
		CacheList { worktrees: HashMap::new(), file: None }
	}

	/// The list kept in `path`, with the names an earlier program saw leave.
	pub fn open(path: &Path) -> io::Result<CacheList> {
		let mut out = CacheList::memory();
		match std::fs::read(path) {
			Ok(text) => {
				for line in text.split(|b| *b == b'\n') {
					let Ok(l) = serde_json::from_slice::<Line>(line) else { continue };
					out.worktrees.entry(l.w).or_default().left.insert(l.n);
				}
			}
			Err(e) if e.kind() == io::ErrorKind::NotFound => {}
			Err(e) => return Err(e),
		}
		out.file = Some(OpenOptions::new().create(true).append(true).mode(0o600).open(path)?);
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
		for name in &leaving {
			w.left.insert(name.clone());
			if let Some(file) = self.file.as_mut() {
				let line = serde_json::to_string(&Line { w: worktree.to_string(), n: name.clone() }).unwrap() + "\n";
				// A name not written through leaves again when a program started again reads the index.
				if let Err(e) = file.write_all(line.as_bytes()) {
					eprintln!("qorpera-folder: the cache list could not be written ({e}); it goes on in memory");
				}
			}
		}
		leaving.into_iter().collect()
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
		let mut list = CacheList::open(&file).unwrap();
		assert!(list.listed(w, "build") && list.listed(w, "node_modules"));
		assert!(!list.listed(w, "out") && !list.read(w));
		let paths = ["build/a".to_string(), "src/build.rs".to_string(), "x/node_modules/".to_string()];
		assert_eq!(list.indexed(w, &paths), ["build", "node_modules"]);
		assert!(list.read(w) && !list.listed(w, "build") && !list.listed(w, "node_modules"));
		assert!(list.listed("code/o/n/worktrees/v", "build"));
		// Untracked again: still off.
		assert!(list.indexed(w, &[]).is_empty());
		assert!(!list.listed(w, "build"));
		let again = CacheList::open(&file).unwrap();
		assert!(!again.listed(w, "build") && again.listed(w, "dist") && !again.read(w));
		std::fs::remove_dir_all(&dir).unwrap();
	}
}
