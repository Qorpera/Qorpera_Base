//! The mount's version map (deploy/first-node/RUNTIME-FOLDER-WRITES.md, "Pending changes and base versions"): for each
//! path, the newest version the mount read of it, or the version its own save made since. A save names it as its base,
//! so an editor that read v1 while another machine published v2 saves against v1 and gets a conflict, not a silent
//! overwrite of v2.
//!
//! It must outlive the program, and the node's service: an editor's buffer outlives both. So each change is written
//! through to a file in a folder under /run/qorpera-folder/ (a memory file system, root's only), and a program started
//! again for the same mount reads it back. It goes when the machine restarts, together with every process whose buffer
//! it protected. It holds paths and version ids, never content, and at most one entry per path.
//!
//! The map is not authority: a base can only claim to have seen a version, and the core checks every unit.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

const FILE: &str = "versions.jsonl";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
	pub version: String,
	/// Made by this mount's own save (a close or the executable bit), not read: it follows its file when the file is
	/// renamed over another (an editor's save through a temporary file).
	pub made: bool,
}

/// One line of the file: a path's entry, or (`v` absent) its removal.
#[derive(Serialize, Deserialize)]
struct Line {
	p: String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	v: Option<String>,
	#[serde(default, skip_serializing_if = "std::ops::Not::not")]
	m: bool,
}

pub struct VersionMap {
	/// By path, in order, so a folder's paths are one range.
	map: BTreeMap<String, Entry>,
	/// Where it is written through; None keeps it in memory only.
	file: Option<(PathBuf, File)>,
	lines: usize,
	/// The file's length up to its last whole line, and whether a failed write may have left part of a line after it.
	length: u64,
	torn: bool,
	/// A write that failed is reported once; the map goes on in memory.
	failed: bool,
}

impl VersionMap {
	/// A map kept in memory only.
	pub fn memory() -> VersionMap {
		VersionMap { map: BTreeMap::new(), file: None, lines: 0, length: 0, torn: false, failed: false }
	}

	/// The map of the mount whose state folder is `dir` (made 0700 if missing), with what an earlier program wrote.
	pub fn open(dir: &Path) -> io::Result<VersionMap> {
		std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
		let path = dir.join(FILE);
		let mut map = BTreeMap::new();
		let mut lines = 0;
		let text = match std::fs::read(&path) {
			Ok(text) => text,
			Err(e) if e.kind() == io::ErrorKind::NotFound => Vec::new(),
			Err(e) => return Err(e),
		};
		// Whole lines only: what follows the last newline was cut short (a crash, or a write that failed) and is cut off
		// the file, so the next line written starts a line of its own. A line that does not read is skipped alone.
		let whole = text.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
		for line in text[..whole].split(|b| *b == b'\n') {
			let Ok(l) = serde_json::from_slice::<Line>(line) else { continue };
			lines += 1;
			match l.v {
				Some(version) => map.insert(l.p, Entry { version, made: l.m }),
				None => map.remove(&l.p),
			};
		}
		if whole < text.len() {
			OpenOptions::new().write(true).open(&path)?.set_len(whole as u64)?;
		}
		let file = OpenOptions::new().create(true).append(true).mode(0o600).open(&path)?;
		let mut out =
			VersionMap { map, file: Some((path, file)), lines, length: whole as u64, torn: false, failed: false };
		out.compact_if_due();
		Ok(out)
	}

	pub fn get(&self, path: &str) -> Option<&Entry> {
		self.map.get(path)
	}

	/// The base a save of `path` names.
	pub fn base(&self, path: &str) -> Option<String> {
		self.map.get(path).map(|e| e.version.clone())
	}

	pub fn len(&self) -> usize {
		self.map.len()
	}

	pub fn is_empty(&self) -> bool {
		self.map.is_empty()
	}

	/// The mount read `version` of `path`: the caller tells only of reads of the version the path shows now (a file
	/// still open from before a newer version arrived reads an older one, which is not the newest the mount has seen).
	/// Reading back what its own save made keeps it marked as made.
	pub fn read(&mut self, path: &str, version: &str) {
		if self.map.get(path).is_some_and(|e| e.version == version) {
			return;
		}
		self.set(path, Entry { version: version.to_string(), made: false });
	}

	/// The mount's own save made `version` of `path`.
	pub fn saved(&mut self, path: &str, version: &str) {
		self.set(path, Entry { version: version.to_string(), made: true });
	}

	/// `from` was renamed to `to`. A file's own save goes with it (a temporary file renamed over its target is the
	/// target's save); anything else about either name is forgotten, since a move gives what it moves new versions. A
	/// folder's paths, and those under it, are forgotten on both sides.
	pub fn renamed(&mut self, from: &str, to: &str, folder: bool) {
		if folder {
			self.removed(from);
			self.removed(to);
			return;
		}
		let moved = self.map.get(from).filter(|e| e.made).cloned();
		self.forget(from);
		match moved {
			Some(entry) => self.set(to, entry),
			None => self.forget(to),
		}
	}

	/// `path` was removed: it, and for a folder everything under it, is forgotten.
	pub fn removed(&mut self, path: &str) {
		let prefix = format!("{path}/");
		let mut under: Vec<String> =
			self.map.range(prefix.clone()..).map(|(p, _)| p).take_while(|p| p.starts_with(&prefix)).cloned().collect();
		under.push(path.to_string());
		for p in under {
			self.forget(&p);
		}
	}

	fn set(&mut self, path: &str, entry: Entry) {
		if self.map.get(path) == Some(&entry) {
			return;
		}
		self.append(&Line { p: path.to_string(), v: Some(entry.version.clone()), m: entry.made });
		self.map.insert(path.to_string(), entry);
	}

	fn forget(&mut self, path: &str) {
		if self.map.remove(path).is_some() {
			self.append(&Line { p: path.to_string(), v: None, m: false });
		}
	}

	fn append(&mut self, line: &Line) {
		// A write that failed may have left part of its line, and its entry is not in the file: the file is written
		// afresh from memory first. Until that works, nothing more is appended after the fragment.
		if self.torn && !self.rewrite() {
			return;
		}
		let Some((path, file)) = &mut self.file else { return };
		let mut text = serde_json::to_string(line).expect("a line always serializes");
		text.push('\n');
		match file.write_all(text.as_bytes()) {
			Ok(()) => {
				self.lines += 1;
				self.length += text.len() as u64;
			}
			Err(e) => {
				if !self.failed {
					eprintln!("qorpera-folder: the version map could not be written to {}: {e}", path.display());
				}
				self.failed = true;
				self.torn = true;
			}
		}
		self.compact_if_due();
	}

	/// Writes the map out afresh once the file holds many more lines than entries.
	fn compact_if_due(&mut self) {
		if self.lines > 2 * self.map.len() + 1024 && !self.rewrite() {
			// Not tried again until it has grown as much once more.
			self.lines = self.map.len();
		}
	}

	/// Writes the whole map to a new file and puts it in place. Whether it worked.
	fn rewrite(&mut self) -> bool {
		let Some((path, _)) = &self.file else { return false };
		let path = path.clone();
		let fresh = path.with_extension("jsonl.new");
		let result = (|| -> io::Result<File> {
			let mut out = OpenOptions::new().create(true).write(true).truncate(true).mode(0o600).open(&fresh)?;
			let mut text = String::new();
			for (p, e) in &self.map {
				text.push_str(&serde_json::to_string(&Line { p: p.clone(), v: Some(e.version.clone()), m: e.made }).expect("serializes"));
				text.push('\n');
			}
			out.write_all(text.as_bytes())?;
			std::fs::rename(&fresh, &path)?;
			OpenOptions::new().append(true).open(&path)
		})();
		match result {
			Ok(file) => {
				self.length = file.metadata().map_or(0, |m| m.len());
				self.file = Some((path, file));
				self.lines = self.map.len();
				self.torn = false;
				true
			}
			Err(e) => {
				let _ = std::fs::remove_file(&fresh);
				if !self.failed {
					eprintln!("qorpera-folder: the version map could not be written afresh: {e}");
				}
				self.failed = true;
				false
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn tempdir() -> PathBuf {
		static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
		let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
		std::env::temp_dir().join(format!("qorpera-folder-versions-{}-{n}", std::process::id()))
	}

	#[test]
	fn reads_and_saves_are_kept_across_a_restart() {
		let dir = tempdir();
		{
			let mut map = VersionMap::open(&dir).unwrap();
			map.read("docs/plan.md", "v1");
			map.read("docs/plan.md", "v1");
			map.saved("notes/a.md", "p1");
			map.read("gone.md", "g1");
			map.removed("gone.md");
		}
		let map = VersionMap::open(&dir).unwrap();
		assert_eq!(map.get("docs/plan.md"), Some(&Entry { version: "v1".into(), made: false }));
		assert_eq!(map.get("notes/a.md"), Some(&Entry { version: "p1".into(), made: true }));
		assert_eq!(map.get("gone.md"), None);
		assert_eq!(map.len(), 2);
		// A repeated read wrote nothing more.
		assert_eq!(std::fs::read_to_string(dir.join(FILE)).unwrap().lines().count(), 4);
		let mode = std::fs::metadata(&dir).unwrap().permissions();
		assert_eq!(std::os::unix::fs::PermissionsExt::mode(&mode) & 0o777, 0o700);
		std::fs::remove_dir_all(dir).unwrap();
	}

	#[test]
	fn a_line_cut_short_is_cut_off_and_what_follows_is_kept() {
		let dir = tempdir();
		std::fs::create_dir_all(&dir).unwrap();
		// A line that does not read is skipped alone; the last one was cut short mid-character.
		let mut text = b"{\"p\":\"a\",\"v\":\"1\"}\nnot json\n{\"p\":\"c\",\"v\":\"3\"}\n{\"p\":\"b\",\"v\":\"\xc3".to_vec();
		std::fs::write(dir.join(FILE), &text).unwrap();
		{
			let mut map = VersionMap::open(&dir).unwrap();
			assert_eq!((map.base("a").as_deref(), map.base("c").as_deref(), map.base("b")), (Some("1"), Some("3"), None));
			map.read("d", "4");
		}
		// The next program reads what was written after the cut too.
		let map = VersionMap::open(&dir).unwrap();
		assert_eq!((map.base("a").as_deref(), map.base("c").as_deref(), map.base("d").as_deref()), (Some("1"), Some("3"), Some("4")));
		text.truncate(0);
		std::fs::remove_dir_all(dir).unwrap();
	}

	#[test]
	fn a_save_through_a_temporary_file_goes_to_its_target() {
		let mut map = VersionMap::memory();
		map.read("plan.md", "v1");
		map.saved(".plan.md.swx", "p1");
		// The editor reads its own save back: still its own.
		map.read(".plan.md.swx", "p1");
		map.renamed(".plan.md.swx", "plan.md", false);
		assert_eq!(map.get("plan.md"), Some(&Entry { version: "p1".into(), made: true }));
		assert_eq!(map.get(".plan.md.swx"), None);
		// A plain move forgets both names: the move gives the file a new version.
		map.read("a.md", "a1");
		map.renamed("a.md", "b.md", false);
		assert_eq!((map.get("a.md"), map.get("b.md")), (None, None));
		// A folder's move forgets everything under both.
		map.read("d/x", "1");
		map.read("e/y", "2");
		map.read("de", "3");
		map.renamed("d", "e", true);
		assert_eq!((map.get("d/x"), map.get("e/y")), (None, None));
		assert_eq!(map.base("de").as_deref(), Some("3"));
	}

	#[test]
	fn the_file_is_written_afresh_when_it_grows() {
		let dir = tempdir();
		{
			let mut map = VersionMap::open(&dir).unwrap();
			for i in 0..3000 {
				map.read("same.md", &format!("v{i}"));
			}
		}
		let lines = std::fs::read_to_string(dir.join(FILE)).unwrap().lines().count();
		assert!(lines < 2000, "{lines} lines for one entry");
		let map = VersionMap::open(&dir).unwrap();
		assert_eq!(map.base("same.md").as_deref(), Some("v2999"));
		std::fs::remove_dir_all(dir).unwrap();
	}
}
