//! The records of the caches' top entries (RUNTIME-FOLDER-MACHINE-CACHES.md "Removing old caches"), which removing old
//! caches judges them by (`mount/pass.rs`). The top entry `name` of the node's folder `dir` has its record at `r/<name>`,
//! beside its `t/<name>` (`Local::record`), so the caches of a folder and their records move or go together. A record
//! says how its top entry was made (`Kind`) and for which view (`view_hash`); its mtime is when the entry was last used.
//! Each program serving a top entry holds a shared lock on its record (`Local::hold_top`), as one making it does until
//! it is made (`Local::write_record`), and a removal takes it exclusively without waiting. A record is written in
//! place, never replaced while its top entry is there: a rename moves it with its entry, and an exchange swaps two with
//! theirs (`exchange`), so a record and the locks on it stay with its top entry for the entry's life. A top entry
//! without a record (made before records were) counts as kept, and so does a record that is not one `write` wrote.
//!
//! In a cache folder several programs share (`--cache-dir`), each program holds a shared lock on its view's file in
//! `views/` for its life (`hold_view`), so a program can tell whether a record's view has one running (`running`).

use sha2::{Digest, Sha256};
use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, FileExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

/// How a cache's top entry was made.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
	/// By its name (rules 2 and 3, and the worktree list): what an install or a build makes again. Removed when unused
	/// for `UNUSED`, and the least recently used first when the disk is short.
	Name,
	/// Cache only because git ignores it (rule 4): what nothing may make again. Removed only with its published parent.
	Kept,
}

/// A record's length: its kind, a newline, its view's hash in hex, a newline.
const LEN: usize = 4 + 1 + 64 + 1;

/// How long a top entry made by its name may go unused.
pub const UNUSED: Duration = Duration::from_secs(14 * 24 * 3600);

/// How old a record's last use is before a use updates it: at most once an hour.
pub const TOUCH_AFTER: Duration = Duration::from_secs(3600);

/// The folder of the views' locks in a shared cache folder.
const VIEWS: &str = "views";

/// Test switch: the size of the caches' disk (`QORPERA_FOLDER_TEST_DISK_BYTES=<n>`), its free space then `n` less the
/// bytes of the files in the caches (`space`); a write to a cache file past it gets `ENOSPC` (`Local::write`).
pub const TEST_DISK_BYTES: &str = "QORPERA_FOLDER_TEST_DISK_BYTES";

/// The size the test switch gives the caches' disk, read once.
pub fn test_disk_bytes() -> Option<u64> {
	static BYTES: OnceLock<Option<u64>> = OnceLock::new();
	*BYTES.get_or_init(|| std::env::var(TEST_DISK_BYTES).ok().and_then(|n| n.parse().ok()))
}

/// The view `view`'s hash, as records and the views' locks name it: its SHA-256 in lowercase hex.
pub fn view_hash(view: &str) -> String {
	Sha256::digest(view.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn content(kind: Kind, view: &str) -> Vec<u8> {
	let kind = match kind {
		Kind::Name => "name",
		Kind::Kept => "kept",
	};
	format!("{kind}\n{view}\n").into_bytes()
}

/// A record's kind and view, from its bytes: `Kept` and none for any but those `write` writes.
fn parse(bytes: &[u8]) -> (Kind, Option<String>) {
	let hex = |b: &[u8]| b.iter().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'));
	if bytes.len() != LEN || bytes[4] != b'\n' || bytes[LEN - 1] != b'\n' || !hex(&bytes[5..LEN - 1]) {
		return (Kind::Kept, None);
	}
	let view = Some(String::from_utf8_lossy(&bytes[5..LEN - 1]).into_owned());
	match &bytes[..4] {
		b"name" => (Kind::Name, view),
		b"kept" => (Kind::Kept, view),
		_ => (Kind::Kept, None),
	}
}

/// What a record says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
	pub kind: Kind,
	/// The hash of the view that wrote it (`view_hash`); none in one `write` did not write.
	pub view: Option<String>,
	/// When its top entry was last used.
	pub used: SystemTime,
}

/// Opens the record at `path`, made empty if missing (never through a link), with the folder it is in.
pub fn open(path: &Path) -> io::Result<File> {
	if let Some(dir) = path.parent() {
		fs::DirBuilder::new().recursive(true).mode(0o755).create(dir)?;
	}
	OpenOptions::new().read(true).write(true).create(true).mode(0o600).custom_flags(libc::O_NOFOLLOW).open(path)
}

/// Writes the record `file` in place: its top entry, made as `kind` for the view whose hash is `view`, used now.
pub fn write(file: &File, kind: Kind, view: &str) -> io::Result<()> {
	file.write_all_at(&content(kind, view), 0)?;
	file.set_len(LEN as u64)?;
	file.set_modified(SystemTime::now())
}

/// The record `file`'s top entry is used now.
pub fn touch(file: &File) -> io::Result<()> {
	file.set_modified(SystemTime::now())
}

/// What the record at `path` says, if one is there that can be read.
pub fn read_path(path: &Path) -> Option<Record> {
	let file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(path).ok()?;
	read(&file).ok()
}

/// What the record `file` says.
pub fn read(file: &File) -> io::Result<Record> {
	let (kind, view) = parse(&bytes(file)?);
	Ok(Record { kind, view, used: file.metadata()?.modified()? })
}

/// The bytes of the record `file`, up to one more than a record has.
fn bytes(file: &File) -> io::Result<Vec<u8>> {
	let mut bytes = vec![0; LEN + 1];
	let mut read = 0;
	while read < bytes.len() {
		match file.read_at(&mut bytes[read..], read as u64) {
			Ok(0) => break,
			Ok(n) => read += n,
			Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
			Err(e) => return Err(e),
		}
	}
	bytes.truncate(read);
	Ok(bytes)
}

/// Swaps the records at `a` and `b` (RENAME_EXCHANGE, each made first if missing), as an exchange swaps their top
/// entries, so the locks programs hold on each go with its entry; what each said stays with its name, written again in
/// place, used now.
pub fn exchange(a: &Path, b: &Path) -> io::Result<()> {
	let files = (open(a)?, open(b)?);
	let said = (bytes(&files.0)?, bytes(&files.1)?);
	let c = |p: &Path| CString::new(p.as_os_str().as_bytes()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput));
	let (a, b) = (c(a)?, c(b)?);
	// SAFETY: two valid C strings; renameat2 reads them only.
	if unsafe { libc::renameat2(libc::AT_FDCWD, a.as_ptr(), libc::AT_FDCWD, b.as_ptr(), libc::RENAME_EXCHANGE) } != 0 {
		return Err(io::Error::last_os_error());
	}
	for (file, said) in [(&files.0, &said.1), (&files.1, &said.0)] {
		file.write_all_at(said, 0)?;
		file.set_len(said.len() as u64)?;
		file.set_modified(SystemTime::now())?;
	}
	Ok(())
}

/// Holds the lock of the view whose hash is `view` in the shared cache folder `caches` for as long as the file is kept:
/// shared, as each program serving the view holds it.
pub fn hold_view(caches: &Path, view: &str) -> io::Result<File> {
	let dir = caches.join(VIEWS);
	fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir)?;
	let mut options = OpenOptions::new();
	options.read(true).write(true).create(true).mode(0o600).custom_flags(libc::O_NOFOLLOW);
	let file = options.open(dir.join(view))?;
	crate::viewfile::flock(&file, libc::LOCK_SH)?;
	Ok(file)
}

/// Whether a program serving the view whose hash is `view` (a record's, so only hex) is running on the shared cache
/// folder `caches`: it holds the view's lock (`hold_view`). One that cannot be told counts as running.
pub fn running(caches: &Path, view: &str) -> bool {
	let file = match OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(caches.join(VIEWS).join(view)) {
		Ok(file) => file,
		Err(e) if e.kind() == io::ErrorKind::NotFound => return false,
		Err(_) => return true,
	};
	crate::viewfile::flock(&file, libc::LOCK_EX | libc::LOCK_NB).is_err()
}

/// The free and the whole space of the disk of the caches in `dir`, in bytes: what an unprivileged writer can use. Under
/// the test switch (`TEST_DISK_BYTES`), its size less the bytes of the files under `dir`.
pub fn space(dir: &Path) -> io::Result<(u64, u64)> {
	if let Some(size) = test_disk_bytes() {
		return Ok((size.saturating_sub(bytes_under(dir)?), size));
	}
	let path = CString::new(dir.as_os_str().as_bytes()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
	// SAFETY: statvfs fills the zeroed struct, and reads only the C string.
	let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
	if unsafe { libc::statvfs(path.as_ptr(), &mut stat) } != 0 {
		return Err(io::Error::last_os_error());
	}
	let block = stat.f_frsize as u64;
	Ok((stat.f_bavail as u64 * block, stat.f_blocks as u64 * block))
}

/// The bytes of the files under `dir` (never through a link).
pub fn bytes_under(dir: &Path) -> io::Result<u64> {
	let mut bytes = 0;
	let mut todo: Vec<PathBuf> = vec![dir.to_path_buf()];
	while let Some(dir) = todo.pop() {
		let read = match fs::read_dir(&dir) {
			Ok(read) => read,
			// One a removal took meanwhile.
			Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
			Err(e) => return Err(e),
		};
		for entry in read.flatten() {
			let Ok(meta) = fs::symlink_metadata(entry.path()) else { continue };
			if meta.is_dir() {
				todo.push(entry.path());
			} else if meta.is_file() {
				bytes += meta.len();
			}
		}
	}
	Ok(bytes)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn a_record_is_parsed_strictly() {
		let view = view_hash("view");
		assert_eq!(view.len(), 64);
		assert_eq!(parse(&content(Kind::Name, &view)), (Kind::Name, Some(view.clone())));
		assert_eq!(parse(&content(Kind::Kept, &view)), (Kind::Kept, Some(view.clone())));
		for bad in [
			Vec::new(),
			b"name\n".to_vec(),
			content(Kind::Name, &view)[..LEN - 1].to_vec(),
			[content(Kind::Name, &view), b"x".to_vec()].concat(),
			content(Kind::Name, &view.to_uppercase()),
			format!("nope\n{view}\n").into_bytes(),
			format!("name\n{}../\n", &view[..61]).into_bytes(),
		] {
			assert_eq!(parse(&bad), (Kind::Kept, None), "{:?}", String::from_utf8_lossy(&bad));
		}
	}

	#[test]
	fn a_record_is_written_in_place() {
		let dir = std::env::temp_dir().join(format!("qorpera-records-{}", std::process::id()));
		let path = dir.join("r").join("node_modules");
		let file = open(&path).unwrap();
		let ino = std::os::unix::fs::MetadataExt::ino(&file.metadata().unwrap());
		assert_eq!(read(&file).unwrap().kind, Kind::Kept);
		write(&file, Kind::Name, &view_hash("a")).unwrap();
		let old = SystemTime::now() - UNUSED;
		file.set_modified(old).unwrap();
		let again = open(&path).unwrap();
		assert_eq!(read(&again).unwrap(), Record { kind: Kind::Name, view: Some(view_hash("a")), used: old });
		write(&again, Kind::Kept, &view_hash("b")).unwrap();
		let record = read(&file).unwrap();
		assert_eq!((record.kind, record.view), (Kind::Kept, Some(view_hash("b"))));
		assert!(record.used > old);
		assert_eq!(std::os::unix::fs::MetadataExt::ino(&fs::symlink_metadata(&path).unwrap()), ino);
		fs::remove_dir_all(dir).unwrap();
	}

	#[test]
	fn a_view_runs_while_its_lock_is_held() {
		let dir = std::env::temp_dir().join(format!("qorpera-views-{}", std::process::id()));
		fs::create_dir_all(&dir).unwrap();
		let view = view_hash("view");
		assert!(!running(&dir, &view));
		let held = hold_view(&dir, &view).unwrap();
		let second = hold_view(&dir, &view).unwrap();
		assert!(running(&dir, &view));
		drop(held);
		assert!(running(&dir, &view));
		drop(second);
		assert!(!running(&dir, &view));
		fs::remove_dir_all(dir).unwrap();
	}

	#[test]
	fn the_space_counts_the_files_under_the_caches() {
		let dir = std::env::temp_dir().join(format!("qorpera-space-{}", std::process::id()));
		fs::create_dir_all(dir.join("a/b")).unwrap();
		fs::write(dir.join("a/b/c"), [0; 100]).unwrap();
		fs::write(dir.join("d"), [0; 20]).unwrap();
		std::os::unix::fs::symlink("/etc/passwd", dir.join("a/l")).unwrap();
		assert_eq!(bytes_under(&dir).unwrap(), 120);
		let (free, size) = space(&dir).unwrap();
		assert!(size > 0 && free <= size);
		fs::remove_dir_all(dir).unwrap();
	}
}
