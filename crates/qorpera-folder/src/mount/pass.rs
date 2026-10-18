//! Removing old caches (RUNTIME-FOLDER-MACHINE-CACHES.md "Removing old caches"): a pass when the program starts and
//! each hour after, on a thread of its own, over the caches' top entries by their records (`records.rs`).
//!
//! - A record left without its top entry for `records::TOUCH_AFTER` goes.
//! - The caches of a node's folder gone from the folder go, both kinds.
//! - A top entry made by its name goes once unused for `records::UNUSED`.
//! - With less than a tenth of the caches' disk free, those made by their names go, the least recently used first,
//!   until 15% is.
//!
//! A kept one never goes by age or for room. In a cache folder other programs share, only this view's caches go with
//! their gone folder (the folder may be one only another view has), and only this view's, or those of a view with no
//! program running, go by age; any view's go for room. A top entry a program holds (its record's lock) never goes, nor
//! one in a worktree any program sharing the caches has caches in to move into the folder (`Local::no_moves`,
//! `settled`), nor one in a folder whose caches are moving into the folder (`Local::whole`).
//!
//! Each removal takes `Local::moving`, `Local::folders`, the renames' lock (`Local::no_renames`), the moves' lock of a
//! top entry's worktree (`Local::no_moves`), the record's lock and the names, in that order, none of them waited for but
//! the first two and the names; it lets go of them all before it tells the kernels (`Kernel::tell`, `Kernel::moved`)
//! and takes the cache off the disk.
//!
//! Limits: a rename of a folder by none of the programs sharing the caches (the web app's, another machine's) leaves its
//! caches where its old path was, so they go with that folder as gone at the next pass. A shell's working folder in a
//! cache is not a handle the mount has open, so it does not hold the cache.

use super::on_disk::{no_moves, settled};
use super::Shared;
use crate::link::Fail;
use crate::local::{Local, Recorded};
use crate::peers::{Change, Parent};
use crate::records::{self, Kind, Record};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

/// Test switch: a pass each `n` milliseconds (`QORPERA_FOLDER_TEST_PASS_MS=<n>`), not each hour.
const TEST_PASS_MS: &str = "QORPERA_FOLDER_TEST_PASS_MS";

/// How long after a pass the next one starts.
const EVERY: Duration = Duration::from_secs(3600);

/// Starts the passes, while `watching`.
pub(super) fn start(shared: Arc<Shared>, watching: Arc<AtomicBool>) {
	let every = std::env::var(TEST_PASS_MS).ok().and_then(|n| n.parse().ok()).map_or(EVERY, Duration::from_millis);
	std::thread::spawn(move || {
		while watching.load(Ordering::SeqCst) {
			if let Some(local) = shared.local.as_ref() {
				shared.pass(local);
			}
			let until = Instant::now() + every;
			while watching.load(Ordering::SeqCst) {
				let Some(left) = until.checked_duration_since(Instant::now()).filter(|d| !d.is_zero()) else { break };
				std::thread::sleep(left.min(Duration::from_millis(200)));
			}
		}
	});
}

/// Whether less than `percent` of `space` (free and whole, in bytes) is free.
fn below(space: (u64, u64), percent: u64) -> bool {
	u128::from(space.0) * 100 < u128::from(space.1) * u128::from(percent)
}

/// Whether the node's answer `listed` to a listing of a folder says it is gone (an error of any other kind, or a broken
/// link, says nothing).
fn found_gone<T>(listed: &Result<T, Fail>) -> bool {
	matches!(listed, Err(f) if matches!(f.errno(), libc::ENOENT | libc::ENOTDIR))
}

/// Whether the record `record` was last used longer than `unused` before `now`.
fn unused(record: &Record, now: SystemTime, unused: Duration) -> bool {
	now.duration_since(record.used).is_ok_and(|d| d > unused)
}

/// What a pass removed.
#[derive(Default)]
struct Removed {
	left: usize,
	gone: usize,
	unused: usize,
	room: usize,
}

impl Shared {
	/// One pass (the module's doc).
	fn pass(&self, local: &Local) {
		let started = Instant::now();
		let now = SystemTime::now();
		let mut removed = Removed::default();
		// This program's own holds no handle has keep nothing from it.
		local.let_go_idle_tops(Duration::ZERO);
		let found = local.recorded();
		let shared = local.cache_folder();
		let mine = |record: &Record| shared.is_none() || record.view.as_deref() == Some(local.view());
		// A view no program serves: its records' views are only hex (`records::read`), so a name in `views/`.
		let left = |record: &Record| {
			shared.is_some_and(|dir| record.view.as_deref().is_some_and(|view| !records::running(dir, view)))
		};
		// A record is written before its top entry is made (`on_disk.rs`), so a new one is left alone a while.
		let left_alone = |record: &Record, there: bool| !there && unused(record, now, records::TOUCH_AFTER);
		for entry in found.iter().filter(|e| !e.top && e.record.as_ref().is_some_and(|r| left_alone(r, false))) {
			if self.remove(local, entry, false, left_alone) {
				removed.left += 1;
			}
		}
		let mut dirs: BTreeMap<&str, Vec<&Recorded>> = BTreeMap::new();
		for entry in found.iter().filter(|e| e.top && !e.dir.is_empty()) {
			dirs.entry(&entry.dir).or_default().push(entry);
		}
		for (dir, entries) in dirs {
			// With none of this view's, its folder is not listed.
			if !entries.iter().any(|e| e.record.as_ref().map_or(shared.is_none(), mine)) {
				continue;
			}
			if !found_gone(&self.link.list(dir)) {
				continue;
			}
			// One without a record is of no view (`records::read`): only a program with caches of its own takes it.
			let old = |record: &Record, there: bool| there && mine(record);
			for entry in entries {
				if self.remove(local, entry, true, old) {
					removed.gone += 1;
				}
			}
		}
		let by_name = |record: &Record| record.kind == Kind::Name;
		for entry in &found {
			let old = |record: &Record, there: bool| {
				there && by_name(record) && (mine(record) || left(record)) && unused(record, now, records::UNUSED)
			};
			if entry.top && entry.record.as_ref().is_some_and(|r| old(r, true)) && self.remove(local, entry, false, old) {
				removed.unused += 1;
			}
		}
		let space = || records::space(&local.caches_disk());
		match space() {
			Ok(free) if below(free, 10) => {
				let mut lru: Vec<&Recorded> =
					found.iter().filter(|e| e.top && e.record.as_ref().is_some_and(by_name)).collect();
				lru.sort_by_key(|e| e.record.as_ref().map(|r| r.used));
				for entry in lru {
					if space().is_ok_and(|free| !below(free, 15)) {
						break;
					}
					let old = |record: &Record, there: bool| there && by_name(record);
					if self.remove(local, entry, false, old) {
						removed.room += 1;
					}
				}
			}
			Ok(_) => {}
			Err(e) => eprintln!("qorpera-folder: removing old caches: the caches' disk's free space is not known ({e})"),
		}
		let free = match space() {
			Ok((free, whole)) => format!("{free} of {whole} bytes free"),
			Err(e) => format!("free space not known ({e})"),
		};
		eprintln!(
			"qorpera-folder: removing old caches: {} with their folder gone, {} unused, {} for room, {} records left \
			 without one; {free}, in {} ms",
			removed.gone,
			removed.unused,
			removed.room,
			removed.left,
			started.elapsed().as_millis()
		);
	}

	/// Removes the cache (or the record) `entry`, if `old` still picks it by its record and nothing keeps it (the
	/// module's doc); `listed` when its folder was found gone, which no rename may have moved since. Whether a cache
	/// went.
	fn remove(&self, local: &Local, entry: &Recorded, listed: bool, old: impl Fn(&Record, bool) -> bool) -> bool {
		let (dir, name) = (entry.dir.as_str(), entry.name.as_str());
		let gone = {
			let _moving = local.moving.lock().unwrap();
			let _folders = local.folders.lock().unwrap();
			let _renames = match local.no_renames() {
				Ok(held) => held,
				// Another program's rename of a folder is moving caches: the next pass.
				Err(e) if e.kind() == io::ErrorKind::WouldBlock => return false,
				Err(e) => {
					eprintln!("qorpera-folder: removing old caches: the renames' lock ({e})");
					return false;
				}
			};
			let moves = if entry.top { no_moves(local, dir) } else { Ok(None) };
			let _moves = match moves {
				Ok(held) => held,
				// A program sharing the caches has caches in the worktree to move into the folder: the next pass.
				Err(e) if e.kind() == io::ErrorKind::WouldBlock => return false,
				Err(e) => {
					eprintln!("qorpera-folder: removing old caches: the moves' lock ({e})");
					return false;
				}
			};
			if entry.top && (!settled(local, dir) || local.whole(dir)) {
				return false;
			}
			// A folder found gone that is there again (another program's rename moved caches onto it since), or not found
			// gone now, keeps them.
			if listed && !found_gone(&self.link.list(dir)) {
				return false;
			}
			match local.remove_old(dir, name, old) {
				Ok(gone) => gone,
				Err(e) => {
					eprintln!("qorpera-folder: removing old caches: the cache {name} in {dir:?} ({e})");
					return false;
				}
			}
		};
		let Some(gone) = gone else { return false };
		let changes = vec![Change::name(Parent::Dir(dir.to_string()), name)];
		// Refused, the other programs' kernels forget it as they fall back.
		let _ = self.kernel.tell(&changes);
		self.kernel.moved(changes);
		take_off(&gone);
		true
	}
}

/// Takes `disk` (a file or a folder) off the disk now.
fn take_off(disk: &Path) {
	let removed = match fs::symlink_metadata(disk) {
		Ok(m) if m.is_dir() => fs::remove_dir_all(disk),
		Ok(_) => fs::remove_file(disk),
		Err(e) => Err(e),
	};
	if let Err(e) = removed {
		eprintln!("qorpera-folder: removing old caches: {} could not be taken off the disk ({e})", disk.display());
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::proto::{code, ErrorReply};

	#[test]
	fn short_is_below_the_share_of_the_whole() {
		assert!(below((9, 100), 10));
		assert!(!below((10, 100), 10));
		assert!(below((14, 100), 15));
		assert!(!below((15, 100), 15));
		assert!(!below((u64::MAX, u64::MAX), 15));
		assert!(!below((0, 0), 10));
	}

	#[test]
	fn only_the_nodes_not_found_says_a_folder_is_gone() {
		let answer = |code: &str| Err::<(), _>(Fail::Remote(ErrorReply { code: code.into(), message: String::new() }));
		assert!(found_gone(&answer(code::NOT_FOUND)));
		assert!(found_gone(&answer(code::NOT_A_FOLDER)));
		assert!(!found_gone(&answer(code::BUSY)));
		assert!(!found_gone(&answer(code::UNAVAILABLE)));
		assert!(!found_gone(&Err::<(), _>(Fail::Link(io::Error::other("the link broke")))));
		assert!(!found_gone(&Ok::<_, Fail>(())));
	}
}
