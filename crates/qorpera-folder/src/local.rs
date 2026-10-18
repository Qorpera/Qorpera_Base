//! The session's own files on the machine's disk (RUNTIME-FOLDER-CODING-MACHINES.md "Code areas and git" and "The
//! cache list"): files the mount shows at their paths in the folder but never sends to the node, so they are never
//! published and other views and machines see nothing of them.
//!
//! - **Session-local git files** (`git::session_local`): a repository's `config`, `hooks/**` and `info/**`, and a
//!   worktree's `config.worktree`. The session gets its own copy, seeded from the published one the first time the
//!   mount reaches the repository (or the worktree's git folder), and what git writes there stays here. The node's own
//!   copy of those paths is never shown.
//! - **The machine's caches** (`cache.rs`): a new folder an install or a build makes under a cache name, where the
//!   node has nothing at that path, and what is in it. Whatever the node has at a path wins.
//!
//! They live in the local folder (`--local-dir`, by default `local/` in the mount's state folder), the caches in the
//! cache folder when there is one (`--cache-dir`, which the programs serving one owner's mounts on the machine share).
//! Git files are at `git/<path>`, by their paths in the folder. Caches are kept by the node's folder they are in: the
//! top entries (a cache folder or file whose folder is the node's) of the folder `a/b` are in `caches/d/a/d/b/t/`, so a
//! cache is told from the caches of a folder below its own, and the caches of a folder and of all below it move or go
//! together with it. A folder of the node's whose caches are moving into the folder (`mount/on_disk.rs`) is marked
//! (`w`, beside its `t/`) until all of them have, so the move goes on there under whatever name a rename gives it. A
//! local folder that a program started for another view finds is that view's: its git files go (they are seeded again),
//! its caches stay (they can be rebuilt at any time, and are only ever the machine's own). What goes is moved to the
//! program's own folder in `gone/` first and taken off the disk there apart from the requests.
//!
//! The kernel knows a local file by its inode on the disk with the top bit set (`LOCAL`); the node's inodes never have
//! it. So does a handle open on one. A cache's has the next bit set too (`CACHE`), as the caches may be on a disk of
//! their own; a file on a disk mounted in the local or cache folder is not shown (`Local::id`).

use crate::cache::CacheList;
use crate::git;
use crate::ignore::Patterns;
use crate::records::{self, Kind, Record};
use crate::writer::Writer;
use fuser::{FileAttr, FileType, INodeNo};
use std::collections::{HashMap, HashSet};
use std::ffi::{CString, OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::ops::{Deref, DerefMut};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant, UNIX_EPOCH};

/// The bit local inodes and handles have.
pub const LOCAL: u64 = 1 << 63;

/// The bit the local inodes of the caches have as well (`Local::id`).
const CACHE: u64 = 1 << 62;

pub fn is_local(ino: u64) -> bool {
	ino & LOCAL != 0
}

/// A local file as an open found it (`Local::stamp`). On a disk with fine-grained times (`Local::probe`), the same stamp
/// at a later open means nothing wrote the file in between.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stamp {
	mtime: (i64, i64),
	ctime: (i64, i64),
	size: u64,
	generation: u64,
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
			Area::Cache => "caches",
		}
	}
}

/// Where what goes from the local folder waits to be taken off the disk.
const GONE: &str = "gone";

/// What a `--cache-dir` the program cannot use starts its error with, for its starter to tell it from another failure.
pub const UNUSABLE: &str = "FOLDER_CACHE_DIR_UNUSABLE";

/// The longest `--cache-dir`: the programs' sockets in it (`<dir>/programs/<name>`, `mount/peers.rs`) must fit a
/// socket's 108 bytes.
pub const CACHE_DIR_MAX: usize = 80;

/// The mark of a folder whose caches are moving into the folder (`Local::whole`).
const WHOLE: &str = "w";

/// The most local folders held open as reached lately (`Local::reach`); one more lets go of them all.
const REACHED: usize = 64;

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

/// A local file the mount has open: the file, its inode, whether the handle changes its bytes (`Local::seal`), which
/// then holds the file's lock (`writer`), and the cache's top entry it holds (`Local::hold_top`).
struct Handle {
	file: File,
	ino: u64,
	writes: bool,
	top: Option<u64>,
}

/// How long a cache's top entry no handle holds any more stays held (`Local::let_go_idle_tops`), so the many opens of
/// one install or build lock its record once.
pub const IDLE_HOLD: Duration = Duration::from_secs(60);

/// A cache's top entry this program holds (`Local::hold_top`): its record, locked shared, how many of the mount's
/// handles hold it, since when none has, and its last use as this program last read or wrote it.
struct HeldTop {
	record: File,
	count: usize,
	idle: Option<Instant>,
	used: std::time::SystemTime,
}

impl HeldTop {
	/// The top entry is used now: its record says so if it said an older use than `records::TOUCH_AFTER`.
	fn used_now(&mut self) {
		let now = std::time::SystemTime::now();
		if now.duration_since(self.used).is_ok_and(|d| d >= records::TOUCH_AFTER) && records::touch(&self.record).is_ok() {
			self.used = now;
		}
	}
}

/// A hold on a cache's top entry (`Local::hold_top`), let go of when dropped unless kept.
struct Holding<'a> {
	local: &'a Local,
	key: Option<u64>,
}

impl Holding<'_> {
	/// Kept past the drop: the key to let go of it by (`Local::let_go_top`), none if nothing was held.
	fn keep(mut self) -> Option<u64> {
		self.key.take()
	}
}

impl Drop for Holding<'_> {
	fn drop(&mut self) {
		if let Some(key) = self.key {
			self.local.let_go_top(key);
		}
	}
}

/// An error of a local file found again after a wait for a cache move (`Local::unsealed`): one not there any more is in
/// the folder now, so the name or inode it was asked by is stale, for the kernel to look up again (ESTALE).
fn stale(waited: bool) -> impl Fn(i32) -> i32 {
	move |e| if waited && e == libc::ENOENT { libc::ESTALE } else { e }
}

/// Whether an open with `flags` changes the file's bytes: one for writing, or a truncate.
fn changes_bytes(flags: i32) -> bool {
	flags & libc::O_ACCMODE != libc::O_RDONLY || flags & libc::O_TRUNC != 0
}

/// A change to a local file's bytes not made (`Local::changing`): failed, or the file, opened, that a cache move of
/// another program sharing these caches has sealed, made again once that move is done with it.
enum Change {
	Failed(i32),
	Sealed(File),
}

impl From<i32> for Change {
	fn from(e: i32) -> Self {
		Change::Failed(e)
	}
}

/// `file`, a local file opened to change its bytes, with the shared lock a cache move's seal takes exclusively
/// (`Local::seal`), held for as long as the file is: `Sealed` while a move has it, of this program or another sharing
/// these caches.
fn writer(file: File) -> Result<File, Change> {
	match crate::viewfile::flock(&file, libc::LOCK_SH | libc::LOCK_NB) {
		Ok(()) => Ok(file),
		Err(e) if e.kind() == io::ErrorKind::WouldBlock => Err(Change::Sealed(file)),
		Err(e) => Err(Change::Failed(errno(e))),
	}
}

/// `writer`, once `file` is still the file at `disk`: a cache move of another program sharing these caches may have
/// sealed it, written it into the folder, taken it off the disk and let go of it between its open and the lock, and a
/// change then would go to a file no one sees (ESTALE: the kernel looks its name up again). With the lock held, no move
/// seals it.
fn writer_at(file: File, disk: &Disk) -> Result<File, Change> {
	#[cfg(test)]
	tests::parked("open", &disk.at);
	let file = writer(file)?;
	let ino = file.metadata().map_err(errno)?.ino();
	match fs::symlink_metadata(disk.path()) {
		Ok(meta) if meta.ino() == ino => Ok(file),
		Err(e) if e.kind() != io::ErrorKind::NotFound => Err(Change::Failed(errno(e))),
		_ => Err(Change::Failed(libc::ESTALE)),
	}
}

/// The file at `disk`, locked as a writer's is (`writer_at`) for a rename or removal of its name, which another
/// program's cache move that has sealed it then waits for (`Change::Sealed`): so the move never takes another file off
/// the disk in its place (`Local::moved_file_out`). None for what no move seals: no file, a link, a folder, or one a
/// read cannot open.
fn named_file(disk: &Disk) -> Result<Option<File>, Change> {
	let flags = libc::O_NOFOLLOW | libc::O_NONBLOCK;
	let file = match OpenOptions::new().read(true).custom_flags(flags).open(disk.path()) {
		Ok(file) => file,
		Err(e) if matches!(e.raw_os_error(), Some(libc::ENOENT | libc::ELOOP | libc::EACCES | libc::ENXIO)) => return Ok(None),
		Err(e) => return Err(Change::Failed(errno(e))),
	};
	if !file.metadata().map_err(errno)?.is_file() {
		return Ok(None);
	}
	writer_at(file, disk).map(Some)
}

/// Where a local file is on the disk (`Local::folder`): the folder it is in, held open (`O_PATH`) as found from its
/// area's folder one folder at a time and never through a link, and its name there; with where that is by its path
/// (`at`). Another program sharing these caches may rename a folder above it, or put a link to a folder outside them
/// in its place, meanwhile: what is made, opened, renamed or removed at `path` is in the folder found, or nowhere.
struct Disk {
	dir: File,
	name: OsString,
	at: PathBuf,
}

impl Disk {
	/// The name in the folder found, through the folder's descriptor in /proc (as `set_mode`): never through what has
	/// the folder's path now.
	fn path(&self) -> PathBuf {
		fd_path(&self.dir).join(&self.name)
	}
}

/// What reaches `file`, opened, itself: its descriptor in /proc.
fn fd_path(file: &File) -> PathBuf {
	PathBuf::from(format!("/proc/self/fd/{}", file.as_raw_fd()))
}

/// The target of the link `place` is, opened itself (`O_PATH | O_NOFOLLOW`).
fn target_of(place: &File) -> Result<Vec<u8>, i32> {
	let mut target = vec![0u8; libc::PATH_MAX as usize];
	// SAFETY: a descriptor, an empty NUL-ended path (the link the descriptor is), and a buffer of its length.
	let read = unsafe { libc::readlinkat(place.as_raw_fd(), c"".as_ptr(), target.as_mut_ptr().cast(), target.len()) };
	if read < 0 {
		return Err(errno(io::Error::last_os_error()));
	}
	target.truncate(read as usize);
	Ok(target)
}

/// The folder `name` in `dir`, opened as a place to find what is in it (`O_PATH`), never through a link (`ENOTDIR`, or
/// `ELOOP`). openat, as openat2's `RESOLVE_NO_SYMLINKS` is refused where the program runs (`command.rs`).
fn open_dir(dir: &File, name: &OsStr) -> Result<File, i32> {
	let name = CString::new(name.as_bytes()).map_err(|_| libc::EINVAL)?;
	let flags = libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
	// SAFETY: a descriptor and a NUL-ended name.
	let fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags) };
	if fd < 0 {
		return Err(errno(io::Error::last_os_error()));
	}
	// SAFETY: the descriptor openat just gave, owned by nothing else.
	Ok(unsafe { File::from_raw_fd(fd) })
}

/// Makes the folder `name` in `dir` (0755), unless one is there.
fn make_dir(dir: &File, name: &OsStr) -> Result<(), i32> {
	let name = CString::new(name.as_bytes()).map_err(|_| libc::EINVAL)?;
	// SAFETY: a descriptor and a NUL-ended name.
	if unsafe { libc::mkdirat(dir.as_raw_fd(), name.as_ptr(), 0o755) } < 0 {
		let e = errno(io::Error::last_os_error());
		if e != libc::EEXIST {
			return Err(e);
		}
	}
	Ok(())
}

/// The names, held (`Local::names`): by this program, and, when the caches are shared, by the lock every program
/// sharing them takes for its names, let go of with them; then the next turn at them is served.
struct Held<'a> {
	names: MutexGuard<'a, Names>,
	lock: Option<&'a File>,
	_turn: Turn<'a>,
}

/// The turns at the names (`Local::names`), served first come first served: the next turn given and the one served,
/// and the wait for one's turn. A mutex alone lets the thread that lets go of it take it again at once, so one that
/// changes names over and over (a link made and removed in a loop) could keep the others from them for long.
#[derive(Default)]
struct Turns {
	at: Mutex<(u64, u64)>,
	served: Condvar,
}

impl Turns {
	/// Waits for a turn of its own.
	fn take(&self) -> Turn<'_> {
		let mut at = self.at.lock().unwrap();
		let mine = at.0;
		at.0 += 1;
		while at.1 != mine {
			at = self.served.wait(at).unwrap();
		}
		Turn(self)
	}
}

/// A turn at the names (`Turns::take`): the next one's once let go of.
struct Turn<'a>(&'a Turns);

impl Drop for Turn<'_> {
	fn drop(&mut self) {
		let mut at = self.0.at.lock().unwrap();
		at.1 += 1;
		if at.0 > at.1 {
			self.0.served.notify_all();
		}
	}
}

impl Deref for Held<'_> {
	type Target = Names;
	fn deref(&self) -> &Names {
		&self.names
	}
}

impl DerefMut for Held<'_> {
	fn deref_mut(&mut self) -> &mut Names {
		&mut self.names
	}
}

impl Drop for Held<'_> {
	fn drop(&mut self) {
		if let Some(lock) = self.lock {
			let _ = crate::viewfile::flock(lock, libc::LOCK_UN);
		}
	}
}

/// Sets `mode` on what `place` is (`Local::place_of`), which an `O_PATH` descriptor has no fchmod for: through its name in
/// /proc, which reaches that inode itself, as glibc's fchmodat does for AT_SYMLINK_NOFOLLOW. Not a link, which has no
/// mode of its own on Linux.
fn set_mode(place: &File, mode: u32) -> Result<(), i32> {
	if place.metadata().map_err(errno)?.is_symlink() {
		return Err(libc::EOPNOTSUPP);
	}
	let at = format!("/proc/self/fd/{}", place.as_raw_fd());
	fs::set_permissions(at, fs::Permissions::from_mode(mode & 0o7777)).map_err(errno)
}

/// Sets the access and change times `times` gives (each kept where `None`) on what `place` is, a link too
/// (`AT_EMPTY_PATH`, which takes an `O_PATH` descriptor).
fn set_times(place: &File, times: (Option<std::time::SystemTime>, Option<std::time::SystemTime>)) -> Result<(), i32> {
	if times == (None, None) {
		return Ok(());
	}
	let spec = |t: Option<std::time::SystemTime>| {
		let (tv_sec, tv_nsec) = match t.map(|t| t.duration_since(UNIX_EPOCH)) {
			None => (0, libc::UTIME_OMIT),
			Some(Ok(d)) => (d.as_secs() as i64, d.subsec_nanos() as i64),
			// Before 1970: whole seconds back, and nanoseconds on from there.
			Some(Err(e)) => match (e.duration().as_secs() as i64, e.duration().subsec_nanos() as i64) {
				(s, 0) => (-s, 0),
				(s, ns) => (-s - 1, 1_000_000_000 - ns),
			},
		};
		libc::timespec { tv_sec, tv_nsec }
	};
	let specs = [spec(times.0), spec(times.1)];
	// SAFETY: a descriptor, an empty NUL-ended path, and two timespecs.
	if unsafe { libc::utimensat(place.as_raw_fd(), c"".as_ptr(), specs.as_ptr(), libc::AT_EMPTY_PATH) } < 0 {
		return Err(errno(io::Error::last_os_error()));
	}
	Ok(())
}

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

/// `ino`'s latest name: its folder, name and area.
fn latest(names: &Names, ino: u64) -> Option<(Up, String, Area)> {
	names.get(&ino).and_then(|all| all.last()).cloned()
}

/// Forgets every name `gone` picks, and then every name in a local folder left with none.
fn forget_all(names: &mut Names, gone: impl Fn(&Up, &str, Area) -> bool) {
	for all in names.values_mut() {
		all.retain(|(up, name, area)| !gone(up, name, *area));
	}
	loop {
		names.retain(|_, all| !all.is_empty());
		let named: HashSet<u64> = names.keys().copied().collect();
		let before: usize = names.values().map(Vec::len).sum();
		for all in names.values_mut() {
			all.retain(|(up, _, _)| !matches!(up, Up::Local(ino) if !named.contains(ino)));
		}
		if names.values().map(Vec::len).sum::<usize>() == before {
			return;
		}
	}
}

/// `ino` by its latest names: the mount folder above it, the names from there down to it, and its area.
fn chain(names: &Names, ino: u64) -> Option<(String, Vec<String>, Area)> {
	let (mut up, name, area) = latest(names, ino)?;
	let mut parts = vec![name];
	loop {
		match up {
			Up::Mount(path) => {
				parts.reverse();
				return Some((path, parts, area));
			}
			Up::Local(ino) => {
				let (next, name, _) = latest(names, ino)?;
				parts.push(name);
				up = next;
			}
		}
	}
}

/// `ino`'s path in the folder by its latest names (`up` gives the path of a mount folder above it).
fn path_in(names: &Names, ino: u64) -> Option<(String, Area)> {
	let (dir, parts, area) = chain(names, ino)?;
	Some((parts.iter().fold(dir, |path, name| crate::proto::join(&path, name)), area))
}

/// Whether the folder's `path` is `dir` or below it.
fn under(path: &str, dir: &str) -> bool {
	path == dir || dir.is_empty() || path.strip_prefix(dir).is_some_and(|rest| rest.starts_with('/'))
}

/// Where the local entries of the node's folder `dir` are in `area`'s folder on the disk (`Local::room`).
fn room_in(dir: &str, area: Area) -> PathBuf {
	match area {
		Area::Git => PathBuf::from(dir),
		Area::Cache => mirror_in(dir).join("t"),
	}
}

/// Where the caches of the node's folder `dir` are in the caches' folder (`Local::mirror`).
fn mirror_in(dir: &str) -> PathBuf {
	let mut disk = PathBuf::new();
	for name in dir.split('/').filter(|n| !n.is_empty()) {
		disk.push("d");
		disk.push(name);
	}
	disk
}

/// Moves `disk` (a file or a folder) into `gone` (this program's, `Gone`) and takes it off the disk there, apart from
/// the request.
fn trash(gone: &Path, disk: &Path) -> io::Result<()> {
	let to = aside(gone);
	fs::rename(disk, &to)?;
	take_off(to, None);
	Ok(())
}

/// A new name in `gone` (this program's, `Gone`) for what goes.
fn aside(gone: &Path) -> PathBuf {
	static NEXT: AtomicU64 = AtomicU64::new(0);
	let started = std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
	gone.join(format!("{started}-{}", NEXT.fetch_add(1, Ordering::SeqCst)))
}

/// Takes `disk` off the disk on a thread of its own, holding `held` (its lock, `Gone::open`) until it is gone.
fn take_off(disk: PathBuf, held: Option<File>) {
	std::thread::spawn(move || {
		let removed = match fs::symlink_metadata(&disk) {
			Ok(m) if m.is_dir() => fs::remove_dir_all(&disk),
			Ok(_) => fs::remove_file(&disk),
			Err(e) => Err(e),
		};
		match removed {
			Err(e) if e.kind() != io::ErrorKind::NotFound => {
				eprintln!("qorpera-folder: {} could not be taken off the disk ({e})", disk.display())
			}
			_ => {}
		}
		drop(held);
	});
}

/// This program's own folder in a `gone/`, locked while it runs: what goes waits in it to be taken off the disk, and so
/// does a file being put in place (`Local::place`). The caches' `gone/` is shared by every program given the same
/// `--cache-dir`, so a program starting takes off only what no running program holds.
struct Gone {
	dir: PathBuf,
	_held: File,
}

impl Gone {
	/// Takes off what programs no longer running left in `gone`, and makes this program's own folder there.
	fn open(gone: &Path) -> io::Result<Gone> {
		fs::DirBuilder::new().recursive(true).mode(0o700).create(gone)?;
		for left in fs::read_dir(gone)? {
			let path = left?.path();
			match hold(&path) {
				// Left by a program that stopped.
				Ok(lock) => take_off(path, Some(lock)),
				// Not a folder: left by a program from before these folders.
				Err(e) if matches!(e.raw_os_error(), Some(libc::ENOTDIR | libc::ELOOP)) => take_off(path, None),
				// A running program's own, or one another program is taking off.
				Err(e) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::NotFound) => {}
				Err(e) => eprintln!("qorpera-folder: {} is left where it is ({e})", path.display()),
			}
		}
		static NEXT: AtomicU64 = AtomicU64::new(0);
		for _ in 0..100 {
			let started = std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
			let dir = gone.join(format!("p-{started}-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
			fs::DirBuilder::new().mode(0o700).create(&dir)?;
			// Another program starting may take it for one left before this one holds it: then another.
			let lock = match hold(&dir) {
				Ok(lock) => lock,
				Err(e) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::NotFound) => continue,
				Err(e) => return Err(e),
			};
			let (now, made) = (fs::symlink_metadata(&dir), lock.metadata()?);
			if now.is_ok_and(|m| m.dev() == made.dev() && m.ino() == made.ino()) {
				return Ok(Gone { dir, _held: lock });
			}
		}
		Err(io::Error::other(format!("no folder of its own in {}", gone.display())))
	}
}

/// The folder `path` (never through a link), locked exclusively without waiting: `WouldBlock` while a program holds it.
fn hold(path: &Path) -> io::Result<File> {
	let file = OpenOptions::new().read(true).custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW).open(path)?;
	crate::viewfile::flock(&file, libc::LOCK_EX | libc::LOCK_NB)?;
	Ok(file)
}

pub struct Local {
	root: PathBuf,
	/// Where the caches are: `--cache-dir`, which several programs can share, or else `root`.
	caches: PathBuf,
	/// This program's own folders in `root`'s `gone/` and, with a cache folder of its own, in the caches' (`Gone`).
	gone: Gone,
	caches_gone: Option<Gone>,
	/// By local inode: the names it is known by (the folder it is in, its name, its area), the latest last. A file with
	/// more than one name (a hard link) is found by the latest, and by one left when that one goes.
	names: Mutex<Names>,
	/// The turns at `names` (`Local::names`).
	turns: Turns,
	/// With a cache folder: the lock the programs sharing it take with their names (`names`), `<cache-dir>/names`.
	names_lock: Option<File>,
	/// The seeds done, written through to `seeded` so a program started again does not seed over the session's changes.
	seeded: Mutex<HashSet<String>>,
	/// Held while a seed is copied, so a second lookup waits for it rather than finding half of it.
	pub seeding: Mutex<()>,
	/// The local files open, by handle; each kept with the names held (`hold`), and the wait for one to be let go of.
	handles: Mutex<HashMap<u64, Handle>>,
	released: Condvar,
	next_fh: AtomicU64,
	/// The caches' top entries this program holds, by their records' inodes (`hold_top`); taken after the names.
	held: Mutex<HashMap<u64, HeldTop>>,
	/// The local files a cache move is writing into the folder, by inode, each with the file that holds its lock for
	/// other programs (`seal`), and the wait for one to be done.
	sealed: Mutex<HashMap<u64, File>>,
	lifted: Condvar,
	pub cache: Mutex<CacheList>,
	/// Held while cache folders move into the folder (`mount/on_disk.rs`), so no two move the same; with the writes of a
	/// move the node did not take, by the file's path, so the next move goes on through the same handle.
	pub moving: Mutex<HashMap<String, Writer>>,
	/// How many of its folders the node renamed for this view. Held from the node's rename of one until its caches have
	/// moved with it (`mount.rs`), while the caches of a folder the node no longer has go, and through each of the
	/// node's folders a move into the folder goes through (`mount/on_disk.rs`): so no listing takes a renamed folder's
	/// caches for those of one that is gone, and no move goes on under a folder's old name.
	pub folders: Mutex<u64>,
	/// The `.gitignore` files read for the caches in worktrees (`ignore.rs`), by their paths: the version each was read
	/// at, and its patterns.
	pub ignores: Mutex<HashMap<String, (String, Arc<Patterns>)>>,
	owner: (u32, u32),
	/// The folders of the git files and of the caches, held open as places to find what is in them (`folder`).
	areas: (File, File),
	/// The disks the git files and the caches are on (`id`).
	devs: (u64, u64),
	/// Where those two folders are, as the kernel names them (`/proc/self/fd`, `reach`).
	at: (PathBuf, PathBuf),
	/// Local folders reached lately (`reach`), held open, by local inode.
	reached: Mutex<HashMap<u64, File>>,
	/// The view's hash, which the records of the caches it makes name (`records.rs`).
	view: String,
	/// With a cache folder of its own: the view's lock there, held while the program runs (`records::hold_view`), and
	/// the file of the renames' lock (`renames_lock`).
	_view_held: Option<File>,
	renames: Option<File>,
	/// With a cache folder of its own: the moves' locks it holds shared, by worktree, while it has caches there to move
	/// into the folder (`hold_moves`); the worktrees with moves are read with it held.
	moves: Mutex<HashMap<String, File>>,
	/// Tests only: run once at the named point of a change (`pause`), so a test has another program act there.
	#[cfg(test)]
	paused: Mutex<HashMap<&'static str, Box<dyn FnOnce() + Send>>>,
}

/// Held from the node's rename of one of its folders for this view until the caches have moved with it
/// (`Local::renames_lock`): this program's `folders` and, in a cache folder other programs share, a shared lock on the
/// renames' file, which removing old caches takes exclusively without waiting (`mount/pass.rs`). So no program takes a
/// folder another program's rename is moving for one that is gone, and removes the caches the rename is to move.
pub struct Renaming<'a> {
	// Dropped first: the lock is let go of before the mutex, so another rename of this program never takes the mutex
	// while this one shares the lock still on the same open file (and lets go of it for both).
	_shared: Option<Unlock<'a>>,
	folders: MutexGuard<'a, u64>,
}

impl Renaming<'_> {
	/// The node renamed the folder: one more rename for this view.
	pub fn renamed(&mut self) {
		*self.folders += 1;
	}
}

/// A lock let go of when dropped.
struct Unlock<'a>(&'a File);

impl Drop for Unlock<'_> {
	fn drop(&mut self) {
		let _ = crate::viewfile::flock(self.0, libc::LOCK_UN);
	}
}

/// The renames' file in the shared cache folder `caches` (`Renaming`).
fn renames_file(caches: &Path) -> io::Result<File> {
	let mut options = OpenOptions::new();
	options.read(true).write(true).create(true).mode(0o600).custom_flags(libc::O_NOFOLLOW);
	options.open(caches.join("renames"))
}

/// The file of the moves' lock of the worktree `worktree` in the shared cache folder `caches` (`Local::hold_moves`),
/// named by the SHA-256 of its path, as a view's lock is by its view's (`records::view_hash`).
fn moves_file(caches: &Path, worktree: &str) -> io::Result<File> {
	let dir = caches.join("moves");
	fs::DirBuilder::new().recursive(true).mode(0o700).create(&dir)?;
	let mut options = OpenOptions::new();
	options.read(true).write(true).create(true).mode(0o600).custom_flags(libc::O_NOFOLLOW);
	options.open(dir.join(records::view_hash(worktree)))
}

/// A cache top entry, or a record left without one, as removing old caches finds them (`Local::tops_recorded`): its
/// node's folder and name, whether the top is there, and its record if it has one.
pub struct Recorded {
	pub dir: String,
	pub name: String,
	pub top: bool,
	pub record: Option<Record>,
}

impl Local {
	/// The local folder `root` (made 0700 if missing) for view `view`, with the caches in `caches` (a folder its starter
	/// made, `UNUSABLE` otherwise; none keeps them in `root`), its files owned by `owner` in the mount; `marker` is there
	/// while a cache folder git came to track has not moved into the folder (`cache.rs`).
	pub fn open(root: &Path, caches: Option<&Path>, view: &str, owner: (u32, u32), marker: Option<PathBuf>) -> io::Result<Local> {
		fs::DirBuilder::new().recursive(true).mode(0o700).create(root)?;
		let caches = match caches {
			Some(dir) => {
				let unusable = |why: &str| io::Error::other(format!("{UNUSABLE}: {}: {why}", dir.display()));
				let meta = fs::symlink_metadata(dir).map_err(|e| unusable(&e.to_string()))?;
				if !dir.is_absolute() || dir.as_os_str().len() > CACHE_DIR_MAX {
					return Err(unusable(&format!("must be an absolute path of at most {CACHE_DIR_MAX} bytes")));
				}
				if !meta.is_dir() || !crate::viewfile::private(&meta) {
					return Err(unusable("must be a folder (not a link) only this account can use"));
				}
				let (a, b) = (fs::canonicalize(root)?, fs::canonicalize(dir)?);
				if a != b && (a.starts_with(&b) || b.starts_with(&a)) {
					return Err(unusable("must not be inside the local folder, nor hold it"));
				}
				(a != b).then_some(b)
			}
			None => None,
		};
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
		// What an earlier program left to take off the disk goes (`Gone`); so do the caches of 5d's program, kept by their
		// paths, and, given a cache folder, those an earlier program kept here.
		let gone = Gone::open(&root.join(GONE))?;
		let mut old = vec![root.join("cache")];
		old.extend(caches.as_ref().map(|_| root.join(Area::Cache.dir())));
		for old in old {
			match trash(&gone.dir, &old) {
				Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
				_ => {}
			}
		}
		let caches_gone = caches.as_ref().map(|dir| Gone::open(&dir.join(GONE))).transpose()?;
		let names_lock = match &caches {
			Some(dir) => {
				let flags = libc::O_NOFOLLOW;
				Some(OpenOptions::new().read(true).write(true).create(true).mode(0o600).custom_flags(flags).open(dir.join("names"))?)
			}
			None => None,
		};
		let hash = records::view_hash(view);
		let view_held = caches.as_ref().map(|dir| records::hold_view(dir, &hash)).transpose()?;
		let renames = caches.as_deref().map(renames_file).transpose()?;
		let caches = caches.unwrap_or_else(|| root.to_path_buf());
		let (git, cache) = (root.join(Area::Git.dir()), caches.join(Area::Cache.dir()));
		let mut areas = Vec::new();
		for dir in [&git, &cache] {
			fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
			let flags = libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW;
			areas.push(OpenOptions::new().read(true).custom_flags(flags).open(dir)?);
		}
		let (cache, git) = (areas.pop().expect("two"), areas.pop().expect("two"));
		let devs = (git.metadata()?.dev(), cache.metadata()?.dev());
		let at = (fs::read_link(fd_path(&git))?, fs::read_link(fd_path(&cache))?);
		let seeded = match fs::read_to_string(root.join("seeded")) {
			Ok(text) => text.lines().map(str::to_string).collect(),
			Err(e) if e.kind() == io::ErrorKind::NotFound => HashSet::new(),
			Err(e) => return Err(e),
		};
		let local = Local {
			root: root.to_path_buf(),
			caches,
			gone,
			caches_gone,
			names: Mutex::new(HashMap::new()),
			turns: Turns::default(),
			names_lock,
			seeded: Mutex::new(seeded),
			seeding: Mutex::new(()),
			handles: Mutex::new(HashMap::new()),
			released: Condvar::new(),
			next_fh: AtomicU64::new(1),
			held: Mutex::new(HashMap::new()),
			sealed: Mutex::new(HashMap::new()),
			lifted: Condvar::new(),
			cache: Mutex::new(CacheList::open(&root.join("cache-left.jsonl"), marker)?),
			moving: Mutex::new(HashMap::new()),
			folders: Mutex::new(0),
			ignores: Mutex::new(HashMap::new()),
			owner,
			areas: (git, cache),
			devs,
			at,
			reached: Mutex::new(HashMap::new()),
			view: hash,
			_view_held: view_held,
			renames,
			moves: Mutex::new(HashMap::new()),
			#[cfg(test)]
			paused: Mutex::new(HashMap::new()),
		};
		// The moves an earlier program left (`cache.rs`).
		local.hold_moves();
		Ok(local)
	}

	/// The names, held, for this program and for the others sharing these caches (`names_lock`): so no two programs
	/// change names in them at once, nor one between another's check of a name and its change of it (a seal's, a
	/// rename's, a removal's). Nothing waits while they are held but for that lock, so every holder is soon done. They
	/// go to this program's threads in turn (`turns`), first come first served.
	fn names(&self) -> Held<'_> {
		let turn = self.turns.take();
		let names = self.names.lock().unwrap();
		let lock = self.names_lock.as_ref().filter(|lock| match crate::viewfile::flock(lock, libc::LOCK_EX) {
			Ok(()) => true,
			Err(e) => {
				eprintln!("qorpera-folder: the names are held without their lock ({e})");
				false
			}
		});
		Held { names, lock, _turn: turn }
	}

	/// `area`'s folder on the disk: by its path, and held open (`areas`).
	fn area_path(&self, area: Area) -> PathBuf {
		match area {
			Area::Git => self.root.join(Area::Git.dir()),
			Area::Cache => self.caches.join(Area::Cache.dir()),
		}
	}

	/// The folder `rel` in `area`'s folder on the disk (made, folder by folder, where missing when `make`), found from
	/// there one folder at a time and never through a link (`ENOTDIR` or `ELOOP` at one), and on `area`'s disk
	/// (`EXDEV`, as `id` says).
	fn folder(&self, area: Area, rel: &Path, make: bool) -> Result<File, i32> {
		let (dir, dev) = match area {
			Area::Git => (&self.areas.0, self.devs.0),
			Area::Cache => (&self.areas.1, self.devs.1),
		};
		let mut found = dir.try_clone().map_err(errno)?;
		for part in rel.components() {
			let Component::Normal(name) = part else { return Err(libc::EINVAL) };
			found = match open_dir(&found, name) {
				Err(libc::ENOENT) if make => make_dir(&found, name).and_then(|()| open_dir(&found, name))?,
				opened => opened?,
			};
		}
		if found.metadata().map_err(errno)?.dev() != dev {
			return Err(libc::EXDEV);
		}
		Ok(found)
	}

	/// Where `disk`, a path in `area`'s folder on the disk, is: its name in the folder above it, found as `folder` finds
	/// one.
	fn beneath(&self, area: Area, disk: &Path) -> Result<Disk, i32> {
		let rel = disk.strip_prefix(self.area_path(area)).map_err(|_| libc::EINVAL)?;
		let name = rel.file_name().ok_or(libc::EINVAL)?;
		let dir = self.folder(area, rel.parent().unwrap_or(Path::new("")), false)?;
		Ok(Disk { dir, name: name.to_os_string(), at: disk.to_path_buf() })
	}

	/// The local folder `ino`, at `rel` in `area`'s folder by the names (`disk_under`): found as `folder` finds one, and
	/// checked to be `ino` (`ESTALE` if not, or if no folder is there). One reached so lately it is still held open
	/// (`reached`) is not found again while the kernel names it at `rel` still (`/proc/self/fd`): that is the folder the
	/// walk would reach. Moved, or with a link or another folder in its place, it is walked to again.
	fn reach(&self, area: Area, rel: &Path, ino: u64) -> Result<File, i32> {
		let at = match area {
			Area::Git => self.at.0.join(rel),
			Area::Cache => self.at.1.join(rel),
		};
		let mut reached = self.reached.lock().unwrap();
		if let Some(dir) = reached.get(&ino) {
			if fs::read_link(fd_path(dir)).is_ok_and(|now| now == at) {
				return dir.try_clone().map_err(errno);
			}
		}
		let stale = |e: i32| if matches!(e, libc::ENOENT | libc::ENOTDIR | libc::ELOOP) { libc::ESTALE } else { e };
		let dir = self.folder(area, rel, false).map_err(stale)?;
		if self.id(area, &dir.metadata().map_err(errno)?) != Ok(ino) {
			return Err(libc::ESTALE);
		}
		if reached.len() >= REACHED {
			reached.clear();
		}
		reached.insert(ino, dir.try_clone().map_err(errno)?);
		Ok(dir)
	}

	/// The local inode the file `meta` gives in `area` is known by: its inode on the disk with `LOCAL`, and with `CACHE`
	/// for the caches', which may be on a disk of their own (`--cache-dir`) with the git files' inodes; the same in every
	/// program sharing them. Not for a file on another disk than its area's (one mounted in the local or cache folder,
	/// whose inodes may be its area's too), which is not shown (`EXDEV`), nor for an inode with those bits (`EOVERFLOW`).
	fn id(&self, area: Area, meta: &fs::Metadata) -> Result<u64, i32> {
		let (dev, bit) = match area {
			Area::Git => (self.devs.0, 0),
			Area::Cache => (self.devs.1, CACHE),
		};
		if meta.dev() != dev {
			return Err(libc::EXDEV);
		}
		if meta.ino() & (LOCAL | CACHE) != 0 {
			return Err(libc::EOVERFLOW);
		}
		Ok(meta.ino() | LOCAL | bit)
	}

	/// This program's own folder in the `gone/` on the disk of `area`'s files.
	fn gone(&self, area: Area) -> &Path {
		match (area, &self.caches_gone) {
			(Area::Cache, Some(gone)) => &gone.dir,
			_ => &self.gone.dir,
		}
	}

	/// Where the local file at the folder's `path` is on the disk: a git file, or a cache's top entry.
	pub fn disk(&self, area: Area, path: &str) -> PathBuf {
		let (dir, name) = crate::proto::split(path);
		self.room(dir, area).join(name)
	}

	/// Where the local entries of the node's folder `dir` are on the disk: its git files, or its top entries.
	pub fn room(&self, dir: &str, area: Area) -> PathBuf {
		self.area_path(area).join(room_in(dir, area))
	}

	/// Where the caches of the node's folder `dir` are on the disk: its top entries in `t/`, the caches of each folder
	/// in it in `d/<name>/`.
	fn mirror(&self, dir: &str) -> PathBuf {
		self.area_path(Area::Cache).join(mirror_in(dir))
	}

	/// What is in the folder `rel` in `area`'s folder on the disk (`folder`), read through it: each name, and what it is
	/// (never what a link names). None when it is not there.
	fn listed(&self, area: Area, rel: &Path) -> Vec<(OsString, fs::Metadata)> {
		let Ok(dir) = self.folder(area, rel, false) else { return Vec::new() };
		let Ok(read) = fs::read_dir(fd_path(&dir)) else { return Vec::new() };
		read.flatten().filter_map(|e| Some((e.file_name(), e.metadata().ok()?))).collect()
	}

	/// What `name` in the folder `rel` in `area`'s folder on the disk is (never what a link names).
	fn stat_in(&self, area: Area, rel: &Path, name: &str) -> Result<fs::Metadata, i32> {
		let dir = self.folder(area, rel, false)?;
		fs::symlink_metadata(fd_path(&dir).join(name)).map_err(errno)
	}

	/// Whether the node's folder `dir` has a cache named `name`.
	pub fn is_top(&self, dir: &str, name: &str) -> bool {
		self.stat_in(Area::Cache, &room_in(dir, Area::Cache), name).is_ok()
	}

	/// Whether the node's folder `dir` has caches in it: it is not empty.
	pub fn tops(&self, dir: &str) -> bool {
		!self.listed(Area::Cache, &room_in(dir, Area::Cache)).is_empty()
	}

	/// The caches of the node's folder `dir`, by name (those named in UTF-8), with what each is (never what a link
	/// names), read through the folders found as `folder` finds them.
	pub fn tops_in(&self, dir: &str) -> Vec<(String, fs::Metadata)> {
		let listed = self.listed(Area::Cache, &room_in(dir, Area::Cache)).into_iter();
		listed.filter_map(|(name, meta)| Some((name.into_string().ok()?, meta))).collect()
	}

	/// Whether the node's folder `dir` has caches in it or in a folder below it, or did since the program started.
	pub fn has_caches(&self, dir: &str) -> bool {
		!self.listed(Area::Cache, &mirror_in(dir)).is_empty()
	}

	/// The names of the folders in the node's folder `dir` that have caches in them or below, or had.
	pub fn mirrors(&self, dir: &str) -> Vec<String> {
		let listed = self.listed(Area::Cache, &mirror_in(dir).join("d")).into_iter();
		listed.filter_map(|(name, _)| name.into_string().ok()).collect()
	}

	/// Whether all the caches of the node's folder `dir`, and of the folders below it, are moving into the folder: it
	/// was a cache, or was in one, and a move has not taken them all yet (`mount/on_disk.rs`).
	pub fn whole(&self, dir: &str) -> bool {
		self.stat_in(Area::Cache, &mirror_in(dir), WHOLE).is_ok()
	}

	/// Marks the node's folder `dir` as one whose caches all move (`whole`), or takes the mark off once they have.
	pub fn mark_whole(&self, dir: &str, whole: bool) -> io::Result<()> {
		let _names = self.names();
		self.mark(dir, whole).map_err(io::Error::from_raw_os_error)
	}

	/// `mark_whole`, with the names held.
	fn mark(&self, dir: &str, whole: bool) -> Result<(), i32> {
		let folder = match self.folder(Area::Cache, &mirror_in(dir), whole) {
			Ok(folder) => folder,
			Err(libc::ENOENT) if !whole => return Ok(()),
			Err(e) => return Err(e),
		};
		let mark = fd_path(&folder).join(WHOLE);
		if whole {
			let options = OpenOptions::new().create(true).write(true).mode(0o644).custom_flags(libc::O_NOFOLLOW).open(mark);
			return options.map(drop).map_err(errno);
		}
		match fs::remove_file(mark) {
			Err(e) if e.kind() != io::ErrorKind::NotFound => Err(errno(e)),
			_ => Ok(()),
		}
	}

	/// Whether caches are moving into the folder from the node's folder `path`, or from one below it: it is marked as one
	/// whose caches all move (`whole`), or has a cache folder named one of `names` (those still to move in its worktree),
	/// which a move has not reached yet.
	pub fn moving_below(&self, path: &str, names: &[String]) -> bool {
		let mut todo = vec![mirror_in(path)];
		while let Some(rel) = todo.pop() {
			let named = |n: &String| self.stat_in(Area::Cache, &rel.join("t"), n).is_ok_and(|m| m.is_dir());
			if self.stat_in(Area::Cache, &rel, WHOLE).is_ok() || names.iter().any(named) {
				return true;
			}
			todo.extend(self.listed(Area::Cache, &rel.join("d")).into_iter().map(|(name, _)| rel.join("d").join(name)));
		}
		false
	}

	/// The node has an entry where `dir` has the cache `name` (rule 1): the cache goes.
	pub fn gone_top(&self, dir: &str, name: &str) {
		let mut names = self.names();
		let top = self.beneath(Area::Cache, &self.disk(Area::Cache, &crate::proto::join(dir, name)));
		match top.map_err(io::Error::from_raw_os_error).and_then(|top| trash(self.gone(Area::Cache), &top.path())) {
			Ok(()) => {}
			Err(e) if e.kind() == io::ErrorKind::NotFound => return,
			Err(e) => return eprintln!("qorpera-folder: the cache {name} in {dir:?} could not go ({e})"),
		}
		let up = Up::Mount(dir.to_string());
		forget_all(&mut names, |u, n, area| area == Area::Cache && *u == up && n == name);
	}

	/// Whether other programs may serve these caches too: they are in a cache folder (`--cache-dir`). A folder one view
	/// has not may then be another's (made there and not published yet), so no program drops caches because its own
	/// view has no folder for them (`drop_mirror`).
	pub fn shared(&self) -> bool {
		self.caches_gone.is_some()
	}

	/// The folder the programs sharing the caches listen in (`crate::peers`), when they are shared.
	pub fn programs(&self) -> Option<PathBuf> {
		self.shared().then(|| self.caches.join("programs"))
	}

	/// The cache folder other programs share, when they do (`records::running`).
	pub fn cache_folder(&self) -> Option<&Path> {
		self.shared().then_some(self.caches.as_path())
	}

	/// The folder all the caches are in on their disk.
	pub fn caches_disk(&self) -> PathBuf {
		self.caches.join(Area::Cache.dir())
	}

	/// This view's hash, as the records of the caches it makes name it (`records.rs`).
	pub fn view(&self) -> &str {
		&self.view
	}

	/// Where the record of the cache `name` in the node's folder `dir` is (`records.rs`).
	pub fn record(&self, dir: &str, name: &str) -> PathBuf {
		self.mirror(dir).join("r").join(name)
	}

	/// Writes the record of the cache `name` in the node's folder `dir`: made by this view as `kind`, and used now. One
	/// that cannot be written leaves the cache counted as kept. It is locked shared until the file returned is dropped,
	/// once the cache is made: a removal of an earlier cache of that name that has the record is waited for, and the
	/// record written again in its place, so no removal takes the new cache's record (`remove_old`).
	pub fn write_record(&self, dir: &str, name: &str, kind: Kind) -> Option<File> {
		let path = self.record(dir, name);
		let locked = || -> io::Result<Option<File>> {
			let file = records::open(&path)?;
			crate::viewfile::flock(&file, libc::LOCK_SH)?;
			let ino = file.metadata()?.ino();
			Ok((fs::symlink_metadata(&path).map(|m| m.ino()).ok() == Some(ino)).then_some(file))
		};
		let written = loop {
			match locked() {
				Ok(None) => {}
				Ok(Some(file)) => break records::write(&file, kind, &self.view).map(|()| file),
				Err(e) => break Err(e),
			}
		};
		match written {
			Ok(file) => Some(file),
			Err(e) => {
				eprintln!("qorpera-folder: the record of the cache {name} in {dir:?} could not be written ({e})");
				None
			}
		}
	}

	/// The records a rename within the caches changes (`rename`): an exchange of two top entries swaps their records,
	/// and with them the locks programs hold on them, each saying what it said by its name, both used now
	/// (`records::exchange`); otherwise the record of a top entry renamed onto another's place or a new one's goes with
	/// it, and with it the locks, made as `kind` there (none given: as the place's own record says). One of a top entry
	/// renamed into a folder of the caches stays for removing old caches to take (`mount/pass.rs`).
	fn records_renamed(&self, from: (&Up, &str), to: (&Up, &str), kind: Option<Kind>, exchange: bool) {
		let record = |up: &Up, name: &str| match up {
			Up::Mount(dir) => Some(self.record(dir, name)),
			Up::Local(_) => None,
		};
		let (source, Some(target), Up::Mount(dir)) = (record(from.0, from.1), record(to.0, to.1), to.0) else { return };
		let done = if exchange {
			match &source {
				Some(source) => records::exchange(source, &target),
				None => records::open(&target).and_then(|file| records::touch(&file)),
			}
		} else {
			let kind = kind.unwrap_or_else(|| records::read_path(&target).map_or(Kind::Kept, |r| r.kind));
			let moved = match source.map(|source| fs::rename(source, &target)) {
				Some(Err(e)) if e.kind() != io::ErrorKind::NotFound => Err(e),
				_ => Ok(()),
			};
			moved.and_then(|()| records::open(&target)).and_then(|file| records::write(&file, kind, &self.view))
		};
		if let Err(e) = done {
			eprintln!("qorpera-folder: the record of the cache {} in {dir:?} could not follow its rename ({e})", to.1);
		}
	}

	/// Held across the node's rename of one of its folders until the caches have moved with it (`Renaming`): this
	/// program's `folders`, then, when the caches are shared, the renames' lock, shared.
	pub fn renames_lock(&self) -> io::Result<Renaming<'_>> {
		let folders = self.folders.lock().unwrap();
		let shared = match &self.renames {
			Some(file) => {
				crate::viewfile::flock(file, libc::LOCK_SH)?;
				Some(Unlock(file))
			}
			None => None,
		};
		Ok(Renaming { _shared: shared, folders })
	}

	/// The renames' lock taken exclusively, without waiting, on an open of its own (a lock on this program's open would
	/// only change its own), for as long as the file is kept: `WouldBlock` while another program's rename of a folder
	/// moves caches (`Renaming`). None needed when the caches are not shared: `folders` keeps this program's renames out.
	pub fn no_renames(&self) -> io::Result<Option<File>> {
		if !self.shared() {
			return Ok(None);
		}
		let file = renames_file(&self.caches)?;
		crate::viewfile::flock(&file, libc::LOCK_EX | libc::LOCK_NB)?;
		Ok(Some(file))
	}

	/// Holds the moves' lock of each worktree this program has caches to move into the folder in (`cache.rs`), shared,
	/// and lets go of those of the worktrees it has none to move in any more: at its start, at each round of moves and
	/// once a move is asked for, so removing old caches in another program sharing them leaves the worktree's alone
	/// meanwhile (`no_moves`). A removal that has a lock is waited for, so never with the names held. Nothing when the
	/// caches are not shared.
	pub fn hold_moves(&self) {
		let Some(caches) = self.cache_folder() else { return };
		// The worktrees with moves read with the locks held: a call that read them before a move was asked for never lets
		// go of the lock a later call took for it.
		let mut held = self.moves.lock().unwrap();
		let moving: HashSet<String> = self.cache.lock().unwrap().moves(None).into_iter().map(|(w, _)| w).collect();
		self.pause("hold_moves");
		held.retain(|worktree, _| moving.contains(worktree));
		for worktree in moving {
			if held.contains_key(&worktree) {
				continue;
			}
			let file = moves_file(caches, &worktree);
			match file.and_then(|file| crate::viewfile::flock(&file, libc::LOCK_SH).map(|()| file)) {
				Ok(file) => {
					held.insert(worktree, file);
				}
				Err(e) => eprintln!("qorpera-folder: the moves' lock of {worktree} could not be held ({e})"),
			}
		}
	}

	/// Tests only: runs what a test set for the point `at` (`paused`), once.
	#[cfg(test)]
	fn pause(&self, at: &'static str) {
		let paused = self.paused.lock().unwrap().remove(at);
		if let Some(paused) = paused {
			paused();
		}
	}

	#[cfg(not(test))]
	fn pause(&self, _at: &'static str) {}

	/// The moves' lock of the worktree `worktree` taken exclusively, without waiting, on an open of its own, for as long
	/// as the file is kept: `WouldBlock` while a program sharing the caches, this one too, has caches there to move into
	/// the folder (`hold_moves`). None needed when the caches are not shared: this program's own list says (`cache.rs`).
	pub fn no_moves(&self, worktree: &str) -> io::Result<Option<File>> {
		let Some(caches) = self.cache_folder() else { return Ok(None) };
		let file = moves_file(caches, worktree)?;
		crate::viewfile::flock(&file, libc::LOCK_EX | libc::LOCK_NB)?;
		Ok(Some(file))
	}

	/// The caches' top entries, and the records left without one, of every node's folder (`Recorded`).
	pub fn recorded(&self) -> Vec<Recorded> {
		let mut found = Vec::new();
		let mut todo = vec![(String::new(), self.mirror(""))];
		while let Some((dir, disk)) = todo.pop() {
			let names = |sub: &str| -> HashSet<String> {
				let Ok(read) = fs::read_dir(disk.join(sub)) else { return HashSet::new() };
				read.flatten().filter_map(|e| e.file_name().into_string().ok()).collect()
			};
			let (tops, written) = (names("t"), names("r"));
			for name in tops.union(&written) {
				let record = written.contains(name).then(|| records::read_path(&disk.join("r").join(name))).flatten();
				found.push(Recorded { dir: dir.clone(), name: name.clone(), top: tops.contains(name), record });
			}
			for name in names("d") {
				todo.push((crate::proto::join(&dir, &name), disk.join("d").join(&name)));
			}
		}
		found
	}

	/// Removes the cache `name` of the node's folder `dir` (or, when it has none, its record), for removing old caches:
	/// if no program holds its record (`hold_top`) and `old` still picks it by what the record says now (a cache
	/// without one, as an empty record: kept, of no view). The cache moves into this program's `gone/` with the names
	/// held, as `gone_top` takes one; the folder it is in there is returned to take off the disk after the caller let
	/// go of its locks. None if nothing was removed, or only a record.
	pub fn remove_old(&self, dir: &str, name: &str, old: impl Fn(&Record, bool) -> bool) -> io::Result<Option<PathBuf>> {
		let path = self.record(dir, name);
		let top = self.disk(Area::Cache, &crate::proto::join(dir, name));
		let file = match OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(&path) {
			Ok(file) => file,
			Err(e) if e.kind() == io::ErrorKind::NotFound && fs::symlink_metadata(&top).is_ok() => records::open(&path)?,
			Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
			Err(e) => return Err(e),
		};
		match crate::viewfile::flock(&file, libc::LOCK_EX | libc::LOCK_NB) {
			Err(e) if e.kind() == io::ErrorKind::WouldBlock => return Ok(None),
			done => done?,
		}
		let mut names = self.names();
		// A rename moved it, or removing it took it, since it was opened.
		if fs::symlink_metadata(&path).map(|m| m.ino()).ok() != Some(file.metadata()?.ino()) {
			return Ok(None);
		}
		let there = fs::symlink_metadata(&top).is_ok();
		if !old(&records::read(&file)?, there) {
			return Ok(None);
		}
		let gone = there.then(|| aside(self.gone(Area::Cache)));
		if let Some(gone) = &gone {
			fs::rename(&top, gone)?;
			let up = Up::Mount(dir.to_string());
			forget_all(&mut names, |u, n, area| area == Area::Cache && *u == up && n == name);
		}
		fs::remove_file(&path)?;
		Ok(gone)
	}

	/// Whether the caches' disk gives a file a new mtime and ctime at each write, however soon after a stat: the kernel
	/// cache's open-time check (`stamp`) needs that. Fifty rounds of a stat, a write of the same size and a stat, on a
	/// file in this program's own `gone/` folder there.
	pub fn probe(&self) -> io::Result<bool> {
		use std::os::unix::fs::FileExt;
		let path = self.gone(Area::Cache).join(format!("probe-{}", std::process::id()));
		let file = OpenOptions::new().read(true).write(true).create_new(true).mode(0o600).open(&path);
		let _ = fs::remove_file(&path);
		let file = file?;
		file.write_all_at(b"0", 0)?;
		let mut before = file.metadata()?;
		for round in 0..50u8 {
			file.write_all_at(&[b'0' + round % 10], 0)?;
			let after = file.metadata()?;
			let times = |m: &fs::Metadata| ((m.mtime(), m.mtime_nsec()), (m.ctime(), m.ctime_nsec()));
			let (was, now) = (times(&before), times(&after));
			if now.0 == was.0 || now.1 == was.1 {
				return Ok(false);
			}
			before = after;
		}
		Ok(true)
	}

	/// What the open-time check compares for the open handle `fh`: the file's times and size, and its generation, which a
	/// disk inode number reused after an unlink does not keep (0 where the disk has none).
	pub fn stamp(&self, fh: u64) -> Result<Stamp, i32> {
		const FS_IOC_GETVERSION: libc::c_ulong = 0x8008_7601;
		let handles = self.handles.lock().unwrap();
		let file = &handles.get(&fh).ok_or(libc::EBADF)?.file;
		let meta = file.metadata().map_err(errno)?;
		let mut generation: libc::c_long = 0;
		// SAFETY: the ioctl writes at most a long to `generation`; on a disk without generations it fails and writes nothing.
		unsafe { libc::ioctl(std::os::fd::AsRawFd::as_raw_fd(file), FS_IOC_GETVERSION as _, &mut generation) };
		Ok(Stamp {
			mtime: (meta.mtime(), meta.mtime_nsec()),
			ctime: (meta.ctime(), meta.ctime_nsec()),
			size: meta.size(),
			generation: generation as u64,
		})
	}

	/// The node's folder `path` is gone from the view: its caches, and those of every folder below it, go. Not those of
	/// a cache folder other programs share (`shared`): they stay until removing old caches finds the folder gone from
	/// the folder (RUNTIME-FOLDER-MACHINE-CACHES.md "Removing old caches").
	pub fn drop_mirror(&self, path: &str) {
		if self.shared() {
			return;
		}
		let mut names = self.names();
		let mirror = self.beneath(Area::Cache, &self.mirror(path)).map_err(io::Error::from_raw_os_error);
		match mirror.and_then(|mirror| trash(self.gone(Area::Cache), &mirror.path())) {
			Ok(()) => {}
			Err(e) if e.kind() == io::ErrorKind::NotFound => return,
			Err(e) => return eprintln!("qorpera-folder: the caches in {path:?} could not go ({e})"),
		}
		forget_all(&mut names, |u, _, area| area == Area::Cache && matches!(u, Up::Mount(p) if under(p, path)));
	}

	/// The node took the rename of its folder `from` to `to`: the caches in it and below move with it. Those of a folder
	/// it replaced at `to` go; in a repository's git folder, where no cache is shown, they go too. With none at `from`,
	/// nothing changes: those at `to` may be another program's (`shared`), or ones another program's rename of the same
	/// folder moved there already, which is looked for again once no other program is moving caches (`renaming`). A
	/// rename of `to` the node took from another program before this one moved them still leaves them at `to`, where
	/// removing old caches finds the folder gone. Whether the caches changed.
	pub fn renamed(&self, from: &str, to: &str) -> bool {
		let mirror = |dir: &str| self.beneath(Area::Cache, &self.mirror(dir)).map_err(io::Error::from_raw_os_error);
		let there = || mirror(from).is_ok_and(|source| fs::symlink_metadata(source.path()).is_ok());
		if from == to || !there() {
			return false;
		}
		let _renaming = self.renaming();
		let mut names = self.names();
		if !there() {
			return false;
		}
		match mirror(to).and_then(|target| trash(self.gone(Area::Cache), &target.path())) {
			Err(e) if e.kind() != io::ErrorKind::NotFound => eprintln!("qorpera-folder: the caches in {to:?} could not go ({e})"),
			_ => {}
		}
		let into_git = matches!(git::place(to), git::Place::Git { .. });
		let moved = if into_git {
			mirror(from).and_then(|source| trash(self.gone(Area::Cache), &source.path()))
		} else {
			let target = mirror_in(to);
			let (above, name) = target.parent().zip(target.file_name()).expect("a folder's caches are in its folder's");
			let into = self.folder(Area::Cache, above, true).map_err(io::Error::from_raw_os_error);
			into.and_then(|into| mirror(from).and_then(|source| fs::rename(source.path(), fd_path(&into).join(name))))
		};
		if let Err(e) = moved {
			eprintln!("qorpera-folder: the caches in {from:?} could not move to {to:?} ({e})");
		}
		forget_all(&mut names, |u, _, area| area == Area::Cache && matches!(u, Up::Mount(p) if under(p, to)));
		if into_git {
			forget_all(&mut names, |u, _, area| area == Area::Cache && matches!(u, Up::Mount(p) if under(p, from)));
			return true;
		}
		for all in names.values_mut() {
			for (up, _, area) in all.iter_mut() {
				if let (Up::Mount(p), Area::Cache) = (&*up, *area) {
					if under(p, from) {
						*up = Up::Mount(format!("{to}{}", &p[from.len()..]));
					}
				}
			}
		}
		true
	}

	/// Held while one program moves caches with a folder the node renamed (`renamed`), for every program sharing these
	/// caches: their folder, locked exclusively, taken before the names and never with them. None, logged, when it
	/// cannot be: the move goes on as it would without.
	fn renaming(&self) -> Option<File> {
		let locked = OpenOptions::new()
			.read(true)
			.custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
			.open(self.mirror(""))
			.and_then(|dir| crate::viewfile::flock(&dir, libc::LOCK_EX).map(|()| dir));
		locked.inspect_err(|e| eprintln!("qorpera-folder: the caches move without their lock ({e})")).ok()
	}

	/// Makes the cache folder `name` in `dir` the caches of the node's folder of that name, which a move has in the
	/// folder now (`mount/on_disk.rs`): what is in it becomes that folder's top entries, all moving (`whole`) or (not
	/// `whole`) those the move picks. When that folder has top entries of its own: `whole`, false, and nothing done;
	/// not `whole`, what is in it joins them, but for a name they have, which is not shown (the node's folder is) and
	/// goes with the cache folder.
	pub fn convert(&self, dir: &str, name: &str, whole: bool) -> io::Result<bool> {
		let mut names = self.names();
		let path = crate::proto::join(dir, name);
		let failed = io::Error::from_raw_os_error;
		let top = self.beneath(Area::Cache, &self.disk(Area::Cache, &path)).map_err(failed)?;
		let meta = fs::symlink_metadata(top.path())?;
		if !meta.is_dir() {
			return Err(failed(libc::ENOTDIR));
		}
		let ino = self.id(Area::Cache, &meta).map_err(failed)?;
		let mirror = self.folder(Area::Cache, &mirror_in(&path), true).map_err(failed)?;
		let into = fd_path(&mirror).join("t");
		let joined = match fs::remove_dir(&into) {
			Err(e) if e.raw_os_error() == Some(libc::ENOTEMPTY) || e.raw_os_error() == Some(libc::EEXIST) => {
				if whole {
					return Ok(false);
				}
				// Read and moved from through the folders themselves, the cache folder checked to be the one found.
				let (from, to) = (open_dir(&top.dir, &top.name).map_err(failed)?, open_dir(&mirror, OsStr::new("t")).map_err(failed)?);
				if self.id(Area::Cache, &from.metadata()?) != Ok(ino) {
					return Err(failed(libc::ESTALE));
				}
				let mut joined = HashSet::new();
				for entry in fs::read_dir(fd_path(&from))? {
					let entry = entry?;
					let to = fd_path(&to).join(entry.file_name());
					if fs::symlink_metadata(&to).is_err() {
						fs::rename(entry.path(), to)?;
						joined.extend(entry.file_name().into_string());
					}
				}
				Some(joined)
			}
			Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
			_ => None,
		};
		if whole {
			self.mark(&path, true).map_err(failed)?;
		}
		if joined.is_none() {
			fs::rename(top.path(), &into)?;
		}
		for all in names.values_mut() {
			for (up, n, area) in all.iter_mut() {
				if *up == Up::Local(ino) && *area == Area::Cache && joined.as_ref().is_none_or(|j| j.contains(n.as_str())) {
					*up = Up::Mount(path.clone());
				}
			}
		}
		let up = Up::Mount(dir.to_string());
		if joined.is_some() {
			trash(self.gone(Area::Cache), &top.path())?;
			forget_all(&mut names, |u, n, area| area == Area::Cache && *u == up && n == name);
		} else {
			forget(&mut names, ino, &up, name);
		}
		Ok(true)
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
	/// Never through a link the session made where a seeded folder or file was.
	pub fn put(&self, path: &str, bytes: Option<&[u8]>, executable: bool) -> io::Result<()> {
		let Some(bytes) = bytes else {
			return self.folder(Area::Git, Path::new(path), true).map(drop).map_err(io::Error::from_raw_os_error);
		};
		let disk = self.seed_at(path)?;
		let mode = if executable { 0o755 } else { 0o644 };
		let mut options = OpenOptions::new();
		options.create(true).write(true).truncate(true).mode(mode).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
		options.open(disk.path())?.write_all(bytes)
	}

	/// Where the seeded file at the folder's `path` goes, the folders above it made as needed (`folder`).
	fn seed_at(&self, path: &str) -> io::Result<Disk> {
		let (dir, name) = crate::proto::split(path);
		let found = self.folder(Area::Git, Path::new(dir), true).map_err(io::Error::from_raw_os_error)?;
		Ok(Disk { dir: found, name: name.into(), at: self.disk(Area::Git, path) })
	}

	/// Makes a seeded link at the folder's `path` to `target`, in place of one an earlier seed left there.
	pub fn put_link(&self, path: &str, target: &[u8]) -> io::Result<()> {
		let disk = self.seed_at(path)?;
		match fs::remove_file(disk.path()) {
			Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
			_ => {}
		}
		std::os::unix::fs::symlink(OsStr::from_bytes(target), disk.path())
	}

	/// The local inode's folder, name and area.
	pub fn name(&self, ino: u64) -> Option<(Up, String, Area)> {
		latest(&self.names.lock().unwrap(), ino)
	}

	/// The local inode's path in the folder (`up` gives the path of a mount folder above it).
	pub fn path(&self, ino: u64) -> Option<(String, Area)> {
		path_in(&self.names.lock().unwrap(), ino)
	}

	/// Where the local inode is on the disk, by `names`. What reads or changes a local file or its names finds it with
	/// the names held until it is done, so no unlink or rename between finding and using it (of a hard link's name, or
	/// a folder above) has it read or change another file by the same name. One no name reaches any more (removed, or
	/// in the folder now, a cache move's) is stale: an entry the kernel still has for it is looked up again (ESTALE).
	/// So is one in a local folder another program sharing these caches renamed, or put a link or another folder in
	/// the place of, which this program's names do not know: the folder its names reach is found from its area's
	/// folder one folder at a time (`folder`, never through a link) and checked to be the one they name, or is one
	/// found so lately it is held open still, while it is where they say (`reach`).
	fn disk_at(&self, names: &Names, ino: u64) -> Result<(Disk, Area), i32> {
		let (up, name, area) = latest(names, ino).ok_or(libc::ESTALE)?;
		self.disk_under(names, &up, &name, area)
	}

	/// Where `name` in `up` is on the disk, by `names` (`disk_at`), with its area (for a mount folder, the area `area`
	/// says).
	fn disk_under(&self, names: &Names, up: &Up, name: &str, area: Area) -> Result<(Disk, Area), i32> {
		let (dir, area) = match up {
			Up::Mount(path) => (self.folder(area, &room_in(path, area), false)?, area),
			Up::Local(ino) => {
				let (top, parts, area) = chain(names, *ino).ok_or(libc::ESTALE)?;
				let rel: PathBuf = std::iter::once(room_in(&top, area)).chain(parts.iter().map(PathBuf::from)).collect();
				(self.reach(area, &rel, *ino)?, area)
			}
		};
		let at = self.at_under(names, up, name, area).ok_or(libc::ESTALE)?;
		Ok((Disk { dir, name: name.into(), at }, area))
	}

	/// Where `name` in `up` is on the disk by its path, from `names` alone (`disk_under` finds it).
	fn at_under(&self, names: &Names, up: &Up, name: &str, area: Area) -> Option<PathBuf> {
		match up {
			Up::Mount(path) => Some(self.disk(area, &crate::proto::join(path, name))),
			Up::Local(ino) => {
				let (dir, parts, area) = chain(names, *ino)?;
				let mut disk = self.room(&dir, area);
				disk.extend(&parts);
				Some(disk.join(name))
			}
		}
	}

	/// The entry for `name` in `up`, from the disk, now known by its inode.
	pub fn entry(&self, up: Up, name: &str, area: Area) -> Result<FileAttr, i32> {
		let mut names = self.names();
		let (disk, area) = self.disk_under(&names, &up, name, area)?;
		self.known_at(&mut names, up, name, area, &disk)
	}

	/// `name` in `up`, at `disk`, now known by its inode (`names` held since it was found or made there).
	fn known_at(&self, names: &mut Names, up: Up, name: &str, area: Area, disk: &Disk) -> Result<FileAttr, i32> {
		let meta = fs::symlink_metadata(disk.path()).map_err(errno)?;
		let ino = self.id(area, &meta)?;
		known(names, ino, up, name, area);
		Ok(self.attr(ino, &meta))
	}

	/// The attributes of a local inode, from the disk: of the mount's handle `fh` when it is one of `ino`'s (an fstat),
	/// otherwise of what its name has (with the names held, as `disk_at` says), checked to be `ino` still (ESTALE).
	pub fn getattr(&self, ino: u64, fh: Option<u64>) -> Result<FileAttr, i32> {
		if let Some(file) = self.handle_of(fh, ino, false) {
			return file.and_then(|f| f.metadata()).map(|m| self.attr(ino, &m)).map_err(errno);
		}
		let names = self.names();
		let (disk, area) = self.disk_at(&names, ino)?;
		let meta = fs::symlink_metadata(disk.path()).map_err(errno)?;
		if self.id(area, &meta) != Ok(ino) {
			return Err(libc::ESTALE);
		}
		Ok(self.attr(ino, &meta))
	}

	/// The attributes of the local inode `ino`, from the disk's `meta`.
	fn attr(&self, ino: u64, meta: &fs::Metadata) -> FileAttr {
		let time = |s: i64, ns: i64| {
			if s >= 0 {
				UNIX_EPOCH + Duration::new(s as u64, ns as u32)
			} else {
				UNIX_EPOCH
			}
		};
		FileAttr {
			ino: INodeNo(ino),
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

	/// The local entries of a mount folder (`dir`, in `area`), each now known by its inode; not one on another disk
	/// (`id`).
	pub fn entries_of(&self, dir: &str, area: Area) -> Vec<(u64, FileType, String)> {
		let mut names = self.names();
		let Ok(room) = self.folder(area, &room_in(dir, area), false) else { return Vec::new() };
		let Ok(read) = fs::read_dir(fd_path(&room)) else { return Vec::new() };
		let mut out = Vec::new();
		for entry in read.flatten() {
			let (Ok(meta), Some(name)) = (entry.metadata(), entry.file_name().to_str().map(str::to_string)) else {
				continue;
			};
			let Ok(ino) = self.id(area, &meta) else { continue };
			known(&mut names, ino, Up::Mount(dir.to_string()), &name, area);
			out.push((ino, kind(&meta.file_type()), name));
		}
		out
	}

	/// The entries of a local folder, each now known by its inode; not one on another disk (`id`).
	pub fn children(&self, ino: u64) -> Result<Vec<(u64, FileType, String)>, i32> {
		let mut out = Vec::new();
		let mut names = self.names();
		let (disk, area) = self.disk_at(&names, ino)?;
		let stale = |e: i32| if matches!(e, libc::ENOENT | libc::ENOTDIR | libc::ELOOP) { libc::ESTALE } else { e };
		let dir = open_dir(&disk.dir, &disk.name).map_err(stale)?;
		if self.id(area, &dir.metadata().map_err(errno)?) != Ok(ino) {
			return Err(libc::ESTALE);
		}
		for entry in fs::read_dir(fd_path(&dir)).map_err(errno)?.flatten() {
			let (Ok(meta), Some(name)) = (entry.metadata(), entry.file_name().to_str().map(str::to_string)) else {
				continue;
			};
			let Ok(child) = self.id(area, &meta) else { continue };
			known(&mut names, child, Up::Local(ino), &name, area);
			out.push((child, kind(&meta.file_type()), name));
		}
		Ok(out)
	}

	/// Makes the folders a mount folder's local entries go in (as `folder` makes them), with the names held.
	fn make_room(&self, up: &Up, area: Area) -> Result<(), i32> {
		if let Up::Mount(path) = up {
			self.folder(area, &room_in(path, area), true)?;
		}
		Ok(())
	}

	/// Creates a file and opens it: its attributes and the handle.
	pub fn create(&self, up: Up, name: &str, area: Area, mode: u32, flags: i32) -> Result<(FileAttr, u64), i32> {
		// Truncated once it is locked (`writer`) and found to be on its area's disk, not before. Never through a link
		// another program sharing these caches made at the name meanwhile: what it names may be outside them.
		let mut options = open_options(flags & !libc::O_TRUNC);
		options.create(true).mode(mode & 0o7777).custom_flags(libc::O_NOFOLLOW);
		if flags & libc::O_EXCL != 0 {
			options.create_new(true);
		}
		self.changing(
			|names| self.ino_under(names, &up, name, area),
			|mut names, waited| {
				if waited && self.ino_under(&names, &up, name, area).is_none() {
					// The file of that name a cache move had is in the folder now, not made again here.
					return Err(Change::Failed(libc::ESTALE));
				}
				self.make_room(&up, area)?;
				let (disk, area) = self.disk_under(&names, &up, name, area)?;
				// Before the file is made: one made again after a wait for a removal would find it there.
				let top = self.hold_top(&names, &up, name, area)?;
				let file = options.open(disk.path()).map_err(errno)?;
				let file = if changes_bytes(flags) { writer_at(file, &disk)? } else { file };
				let ino = self.id(area, &file.metadata().map_err(errno)?)?;
				if flags & libc::O_TRUNC != 0 {
					file.set_len(0).map_err(errno)?;
				}
				let meta = file.metadata().map_err(errno)?;
				known(&mut names, ino, up.clone(), name, area);
				let fh = self.hold(file, ino, flags, top.keep());
				drop(names);
				Ok((self.attr(ino, &meta), fh))
			},
		)
	}

	pub fn mkdir(&self, up: Up, name: &str, area: Area, mode: u32) -> Result<FileAttr, i32> {
		let mut names = self.names();
		self.make_room(&up, area)?;
		let (disk, area) = self.disk_under(&names, &up, name, area)?;
		fs::DirBuilder::new().mode(mode & 0o7777).create(disk.path()).map_err(errno)?;
		self.known_at(&mut names, up, name, area, &disk)
	}

	pub fn symlink(&self, up: Up, name: &str, area: Area, target: &Path) -> Result<FileAttr, i32> {
		let mut names = self.names();
		self.make_room(&up, area)?;
		let (disk, area) = self.disk_under(&names, &up, name, area)?;
		std::os::unix::fs::symlink(target, disk.path()).map_err(errno)?;
		self.known_at(&mut names, up, name, area, &disk)
	}

	/// A local link's target: of the link its name has, checked to be `ino` still (`place_of`).
	pub fn readlink(&self, ino: u64) -> Result<Vec<u8>, i32> {
		let names = self.names();
		let place = self.place_of(&names, ino)?;
		drop(names);
		target_of(&place)
	}

	/// A second name for a local file, in the same area.
	pub fn link(&self, ino: u64, up: Up, name: &str, area: Area) -> Result<FileAttr, i32> {
		let mut names = self.names();
		let (from, from_area) = self.disk_at(&names, ino)?;
		if from_area != area {
			return Err(libc::EXDEV);
		}
		if self.id(area, &fs::symlink_metadata(from.path()).map_err(errno)?) != Ok(ino) {
			return Err(libc::ESTALE);
		}
		self.make_room(&up, area)?;
		let (to, area) = self.disk_under(&names, &up, name, area)?;
		fs::hard_link(from.path(), to.path()).map_err(errno)?;
		self.known_at(&mut names, up, name, area, &to)
	}

	/// Removes the file `name` in `up`: its inode. One a cache move has, of this program or another, once it is in the
	/// folder (`named_file`).
	pub fn unlink(&self, up: &Up, name: &str, area: Area) -> Result<u64, i32> {
		self.changing(
			|names| self.ino_under(names, up, name, area),
			|mut names, waited| {
				let (disk, area) = self.disk_under(&names, up, name, area).map_err(stale(waited))?;
				let _locked = named_file(&disk)?;
				let ino = self.id(area, &fs::symlink_metadata(disk.path()).map_err(errno).map_err(stale(waited))?)?;
				fs::remove_file(disk.path()).map_err(errno)?;
				forget(&mut names, ino, up, name);
				Ok(ino)
			},
		)
	}

	/// Removes the empty folder `name` in `up`: its inode.
	pub fn rmdir(&self, up: &Up, name: &str, area: Area) -> Result<u64, i32> {
		let mut names = self.names();
		let (disk, area) = self.disk_under(&names, up, name, area)?;
		let ino = self.id(area, &fs::symlink_metadata(disk.path()).map_err(errno)?)?;
		fs::remove_dir(disk.path()).map_err(errno)?;
		forget(&mut names, ino, up, name);
		Ok(ino)
	}

	/// Takes the file, or the empty folder, at `disk` off the disk once a cache move has it in the folder
	/// (`mount/on_disk.rs`), with every name that reached it there: a hard link to it elsewhere keeps just its own.
	pub fn moved_out(&self, disk: &Path) -> Result<(), i32> {
		let mut names = self.names();
		let disk = self.beneath(Area::Cache, disk)?;
		let meta = fs::symlink_metadata(disk.path()).map_err(errno)?;
		self.take_off(&mut names, &disk, &meta)
	}

	/// `moved_out` for the file a cache move sealed (`seal`) as `ino`: not one that took its place at `disk` since
	/// (`EBUSY`), which the move is made again for. No other program sharing these caches renames a file there between
	/// the check and the removal: both are made with the names held (`names`).
	pub fn moved_file_out(&self, disk: &Path, ino: u64) -> Result<(), i32> {
		let mut names = self.names();
		let found = self.beneath(Area::Cache, disk)?;
		let meta = fs::symlink_metadata(found.path()).map_err(errno)?;
		if self.id(Area::Cache, &meta) != Ok(ino) {
			return Err(libc::EBUSY);
		}
		#[cfg(test)]
		tests::parked("remove", disk);
		self.take_off(&mut names, &found, &meta)
	}

	fn take_off(&self, names: &mut Names, disk: &Disk, meta: &fs::Metadata) -> Result<(), i32> {
		let ino = self.id(Area::Cache, meta)?;
		let removed = if meta.is_dir() { fs::remove_dir(disk.path()) } else { fs::remove_file(disk.path()) };
		removed.map_err(errno)?;
		let gone: Vec<(Up, String)> = names
			.get(&ino)
			.into_iter()
			.flatten()
			.filter(|(up, name, area)| self.at_under(names, up, name, *area).is_some_and(|at| at == disk.at))
			.map(|(up, name, _)| (up.clone(), name.clone()))
			.collect();
		for (up, name) in gone {
			forget(names, ino, &up, &name);
		}
		Ok(())
	}

	/// Seals the local file at `disk` for a cache move that writes it into the folder (`mount/on_disk.rs`): the file,
	/// opened for reading, and its inode. Until `unseal`, an open of it for writing, a change of its attributes and one
	/// of a name it has wait (`unsealed`), so what the move reads is all that was written to it, and nothing is written
	/// to it once the move takes it off the disk. One the mount has open for writing, or another move has sealed, is not
	/// sealed (`EBUSY`): the move is made again until its writers are done. So for the other programs sharing these
	/// caches (`--cache-dir`), whose handles that change a file's bytes hold a shared lock on it (`writer`): the seal
	/// takes it exclusively, without waiting, and keeps it until `unseal`, and their changes to the file's bytes wait for
	/// it, as do their renames and removals of it or over it (`named_file`). Not their changes of its mode or times,
	/// which this mount's wait for: one made while the move is leaves the file in the folder with the mode it had when
	/// sealed. No byte written is lost.
	pub fn seal(&self, disk: &Path) -> Result<(File, u64), i32> {
		let names = self.names();
		let disk = self.beneath(Area::Cache, disk)?;
		self.seal_at(&names, Area::Cache, &disk)?.map_err(|_| libc::EBUSY)
	}

	/// `seal` for the cache file `name` in `up` (`mount/on_disk.rs`), and where it is on the disk. One the mount has open
	/// for writing is waited for up to `wait`, as a program's close is done before the kernel lets go of its handle; one
	/// another program has open for writing is not (`EBUSY` at once).
	pub fn seal_name(&self, up: &Up, name: &str, area: Area, wait: Duration) -> Result<(File, u64, PathBuf), i32> {
		let until = Instant::now() + wait;
		loop {
			let names = self.names();
			let (disk, area) = self.disk_under(&names, up, name, area)?;
			let handles = match self.seal_at(&names, area, &disk)? {
				Ok((file, ino)) => return Ok((file, ino, disk.at)),
				Err(handles) => handles,
			};
			drop(names);
			let left = until.saturating_duration_since(Instant::now());
			if left.is_zero() {
				return Err(libc::EBUSY);
			}
			drop(self.released.wait_timeout(handles, left).unwrap());
		}
	}

	/// `seal` with the names held; the handles, held still, when the mount has the file open for writing, so a wait for
	/// one to be let go of (`release`) misses none.
	#[allow(clippy::type_complexity)]
	fn seal_at(
		&self,
		_names: &Names,
		area: Area,
		disk: &Disk,
	) -> Result<Result<(File, u64), MutexGuard<'_, HashMap<u64, Handle>>>, i32> {
		// Not a pipe that took its place since it was listed, whose open would wait with the names held.
		let flags = libc::O_NOFOLLOW | libc::O_NONBLOCK;
		let file = OpenOptions::new().read(true).custom_flags(flags).open(disk.path()).map_err(errno)?;
		let meta = file.metadata().map_err(errno)?;
		let ino = self.id(area, &meta)?;
		if !meta.is_file() || self.sealed.lock().unwrap().contains_key(&ino) {
			return Err(libc::EBUSY);
		}
		let handles = self.handles.lock().unwrap();
		if handles.values().any(|h| h.writes && h.ino == ino) {
			return Ok(Err(handles));
		}
		drop(handles);
		// Nor one another program has open to change it (`writer`), or has sealed.
		match crate::viewfile::flock(&file, libc::LOCK_EX | libc::LOCK_NB) {
			Err(e) if e.kind() == io::ErrorKind::WouldBlock => return Err(libc::EBUSY),
			locked => locked.map_err(errno)?,
		}
		self.sealed.lock().unwrap().insert(ino, file.try_clone().map_err(errno)?);
		Ok(Ok((file, ino)))
	}

	/// The cache move is done with the local file `ino` (`seal`): its lock goes too, though the move may hold the file
	/// still.
	pub fn unseal(&self, ino: u64) {
		if let Some(file) = self.sealed.lock().unwrap().remove(&ino) {
			let _ = crate::viewfile::flock(&file, libc::LOCK_UN);
		}
		self.lifted.notify_all();
	}

	/// The names, held once no cache move has the local file `changed` gives (with them held) sealed (`seal`), and
	/// whether that waited for one, with the names let go of meanwhile.
	fn unsealed(&self, changed: impl Fn(&Names) -> Option<u64>) -> (Held<'_>, bool) {
		let mut waited = false;
		loop {
			let names = self.names();
			let Some(ino) = changed(&names) else { return (names, waited) };
			let mut sealed = self.sealed.lock().unwrap();
			if !sealed.contains_key(&ino) {
				drop(sealed);
				return (names, waited);
			}
			drop(names);
			while sealed.contains_key(&ino) {
				sealed = self.lifted.wait(sealed).unwrap();
			}
			waited = true;
		}
	}

	/// `unsealed`, and `change` made with the names it gives and whether it waited: made again, with the names let go of
	/// meanwhile, once the cache move of another program sharing these caches that has sealed the file `change` opened
	/// (`Change::Sealed`) lets go of its lock (`unseal`), or that program ends.
	fn changing<'a, T>(
		&'a self,
		changed: impl Fn(&Names) -> Option<u64>,
		change: impl Fn(Held<'a>, bool) -> Result<T, Change>,
	) -> Result<T, i32> {
		let mut waited = false;
		loop {
			let (names, unsealed) = self.unsealed(&changed);
			match change(names, waited || unsealed) {
				Ok(done) => return Ok(done),
				Err(Change::Failed(e)) => return Err(e),
				Err(Change::Sealed(file)) => {
					crate::viewfile::flock(&file, libc::LOCK_SH).map_err(errno)?;
					waited = true;
				}
			}
		}
	}

	/// The local inode of the file `name` in `up` names, if one is on the disk.
	fn ino_under(&self, names: &Names, up: &Up, name: &str, area: Area) -> Option<u64> {
		let (disk, area) = self.disk_under(names, up, name, area).ok()?;
		fs::symlink_metadata(disk.path()).ok().and_then(|m| self.id(area, &m).ok())
	}

	/// Renames within one area; `exchange` swaps the two (RENAME_EXCHANGE), `no_replace` refuses an existing target. The
	/// inodes moved and replaced. A cache's top entry made at `to` is one made as `kind` (`records_renamed`). In the
	/// caches, the top entries at both names are held first (`hold_top`), so a removal of either that another program
	/// has begun ends before anything moves, and none begins until the records have followed the rename.
	pub fn rename(
		&self,
		from: (&Up, &str),
		to: (&Up, &str),
		area: Area,
		no_replace: bool,
		exchange: bool,
		kind: Option<Kind>,
	) -> Result<(Option<u64>, Option<u64>), i32> {
		// A file a cache move has, renamed once it is in the folder; one that takes its name meanwhile is moved again
		// (`moved_file_out`). So for another program's move, of the files at both names (`named_file`); and the names, held
		// for every program sharing these caches, keep one from taking either name between the check and the rename.
		self.changing(
			|names| self.ino_under(names, from.0, from.1, area),
			|mut names, waited| {
				let (source, from_area) = self.disk_under(&names, from.0, from.1, area).map_err(stale(waited))?;
				self.make_room(to.0, area)?;
				let (target, to_area) = self.disk_under(&names, to.0, to.1, area).map_err(stale(waited))?;
				if from_area != to_area {
					return Err(Change::Failed(libc::EXDEV));
				}
				let _tops = (self.hold_top(&names, from.0, from.1, area)?, self.hold_top(&names, to.0, to.1, area)?);
				let _locked = (named_file(&source)?, named_file(&target)?);
				let flags = if exchange {
					libc::RENAME_EXCHANGE
				} else if no_replace {
					libc::RENAME_NOREPLACE
				} else {
					0
				};
				let ino_at = |d: &Disk| fs::symlink_metadata(d.path()).ok().map(|m| self.id(area, &m)).transpose();
				let (moved, replaced) = (ino_at(&source)?, ino_at(&target)?);
				#[cfg(test)]
				tests::parked("rename", &target.at);
				renameat2(&source.path(), &target.path(), flags).map_err(stale(waited))?;
				if moved.is_some() && moved == replaced {
					// Two names of one file: the rename left both.
					return Ok((moved, replaced));
				}
				if area == Area::Cache {
					self.pause("records_renamed");
					self.records_renamed(from, to, kind, exchange);
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
				Ok((moved, replaced))
			},
		)
	}

	/// Changes a local inode's mode, size or times, on that inode itself: through the mount's handle `fh` when it is one
	/// of `ino`'s (a truncate of an open file), otherwise through what `ino`'s name has now, checked to be `ino` still
	/// and never followed when a link (`place_of`). Another program sharing these caches may have renamed a file or a
	/// link over the name. A size once the file is locked (`writer`), before anything changes.
	pub fn setattr(
		&self,
		ino: u64,
		fh: Option<u64>,
		mode: Option<u32>,
		size: Option<u64>,
		times: (Option<std::time::SystemTime>, Option<std::time::SystemTime>),
	) -> Result<FileAttr, i32> {
		let meta = self.changing(
			|_| Some(ino),
			|names, waited| {
				let (place, truncate) = match self.handle_of(fh, ino, size.is_some()).transpose().map_err(errno)? {
					// Its bytes change with the lock it has held since it was opened (`writer`).
					Some(file) => (file.try_clone().map_err(errno)?, size.map(|size| (file, size))),
					None => {
						let place = self.place_of(&names, ino).map_err(stale(waited))?;
						let truncate = match size {
							Some(size) => {
								let (disk, area) = self.disk_at(&names, ino)?;
								let flags = libc::O_NOFOLLOW | libc::O_NONBLOCK;
								let file = OpenOptions::new().write(true).custom_flags(flags).open(disk.path());
								let file = file.map_err(errno).map_err(stale(waited))?;
								if self.id(area, &file.metadata().map_err(errno)?) != Ok(ino) {
									return Err(Change::Failed(libc::ESTALE));
								}
								Some((writer_at(file, &disk)?, size))
							}
							None => None,
						};
						(place, truncate)
					}
				};
				if let Some(mode) = mode {
					set_mode(&place, mode)?;
				}
				if let Some((file, size)) = truncate {
					file.set_len(size).map_err(errno)?;
				}
				set_times(&place, times)?;
				drop(names);
				place.metadata().map_err(|e| Change::Failed(errno(e)))
			},
		)?;
		Ok(self.attr(ino, &meta))
	}

	/// The file of the mount's handle `fh`, when it is one of the local inode `ino`'s (and one that changes its bytes,
	/// for `bytes`).
	fn handle_of(&self, fh: Option<u64>, ino: u64, bytes: bool) -> Option<io::Result<File>> {
		let handles = self.handles.lock().unwrap();
		let handle = handles.get(&fh?).filter(|h| h.ino == ino && (h.writes || !bytes))?;
		Some(handle.file.try_clone())
	}

	/// What the local inode `ino`'s name has now (`disk_at`), opened as a place to read or change its attributes on
	/// (`O_PATH`), a link itself and not what it names, and checked to be `ino` still (ESTALE).
	fn place_of(&self, names: &Names, ino: u64) -> Result<File, i32> {
		let (disk, area) = self.disk_at(names, ino)?;
		let flags = libc::O_PATH | libc::O_NOFOLLOW;
		let place = OpenOptions::new().read(true).custom_flags(flags).open(disk.path()).map_err(errno)?;
		if self.id(area, &place.metadata().map_err(errno)?) != Ok(ino) {
			return Err(libc::ESTALE);
		}
		Ok(place)
	}

	/// Opens a local file: the handle. It is found, opened and kept with the names held (`disk_at`, `hold`), once no
	/// cache move has it sealed where the open changes it (`unsealed`, `writer`), and what was opened is checked to be
	/// `ino` before a truncate touches it. A cache's file holds its top entry first (`hold_top`).
	pub fn open_file(&self, ino: u64, flags: i32) -> Result<u64, i32> {
		let changes = changes_bytes(flags);
		self.changing(
			|_| changes.then_some(ino),
			|names, waited| {
				let (up, name, area) = latest(&names, ino).ok_or(libc::ESTALE)?;
				let top = self.hold_top(&names, &up, &name, area)?;
				let (disk, area) = self.disk_at(&names, ino).map_err(stale(waited))?;
				let options = open_options(flags & !libc::O_TRUNC).custom_flags(libc::O_NOFOLLOW).open(disk.path());
				let file = options.map_err(errno).map_err(stale(waited))?;
				if self.id(area, &file.metadata().map_err(errno)?) != Ok(ino) {
					return Err(Change::Failed(libc::ESTALE));
				}
				let file = if changes { writer_at(file, &disk)? } else { file };
				if flags & libc::O_TRUNC != 0 {
					file.set_len(0).map_err(errno)?;
				}
				let fh = self.hold(file, ino, flags, top.keep());
				drop(names);
				Ok(fh)
			},
		)
	}

	/// Keeps `file`, the local file `ino` opened with `flags`, holding the cache's top entry `top` (`hold_top`): its
	/// handle. With the names held, so a cache move's `seal` sees every handle that changes the file's bytes.
	fn hold(&self, file: File, ino: u64, flags: i32, top: Option<u64>) -> u64 {
		let fh = self.next_fh.fetch_add(1, Ordering::SeqCst) | LOCAL;
		self.handles.lock().unwrap().insert(fh, Handle { file, ino, writes: changes_bytes(flags), top });
		fh
	}

	/// Holds the cache's top entry that `name` in `up` is (in a mount folder) or is in, with the names held, so removing
	/// old caches leaves it (`remove_old`): its record, made if missing, locked shared, and its last use written if
	/// older than `records::TOUCH_AFTER`. A lock this program has on it already is counted again. While a removal has
	/// the record, or after one took it or a rename moved another record to its place, the change waits and is made
	/// again (`Change::Sealed`). Nothing held for a git file, nor (logged) when the record cannot be opened or locked,
	/// which no removal can then lock either.
	fn hold_top(&self, names: &Names, up: &Up, name: &str, area: Area) -> Result<Holding<'_>, Change> {
		let none = Holding { local: self, key: None };
		let (dir, top) = match up {
			Up::Mount(dir) if area == Area::Cache => (dir.clone(), name.to_string()),
			Up::Local(ino) => match chain(names, *ino).ok_or(libc::ESTALE)? {
				(dir, mut parts, Area::Cache) => (dir, parts.swap_remove(0)),
				_ => return Ok(none),
			},
			Up::Mount(_) => return Ok(none),
		};
		let path = self.record(&dir, &top);
		let mut held = self.held.lock().unwrap();
		let known = fs::symlink_metadata(&path).ok().map(|m| m.ino()).filter(|ino| held.contains_key(ino));
		if let Some(key) = known {
			let entry = held.get_mut(&key).expect("a held top entry");
			entry.count += 1;
			entry.idle = None;
			entry.used_now();
			return Ok(Holding { local: self, key: Some(key) });
		}
		let failed = |e: io::Error| eprintln!("qorpera-folder: the cache {top} in {dir:?} is not held ({e})");
		let record = match records::open(&path) {
			Ok(file) => file,
			Err(e) => {
				failed(e);
				return Ok(none);
			}
		};
		match crate::viewfile::flock(&record, libc::LOCK_SH | libc::LOCK_NB) {
			Ok(()) => {}
			Err(e) if e.kind() == io::ErrorKind::WouldBlock => return Err(Change::Sealed(record)),
			Err(e) => {
				failed(e);
				return Ok(none);
			}
		}
		let key = record.metadata().map_err(errno)?.ino();
		if fs::symlink_metadata(&path).map(|m| m.ino()).ok() != Some(key) {
			return Err(Change::Sealed(record));
		}
		let used = records::read(&record).map_or(UNIX_EPOCH, |r| r.used);
		let mut entry = HeldTop { record, count: 1, idle: None, used };
		entry.used_now();
		held.insert(key, entry);
		Ok(Holding { local: self, key: Some(key) })
	}

	/// Lets go of a hold on a cache's top entry (`hold_top`): one no handle holds any more is idle from now, its last use
	/// written if old, until `let_go_idle_tops`.
	pub fn let_go_top(&self, key: u64) {
		let mut held = self.held.lock().unwrap();
		let Some(entry) = held.get_mut(&key) else { return };
		entry.count -= 1;
		if entry.count == 0 {
			entry.idle = Some(Instant::now());
			entry.used_now();
		}
	}

	/// Lets go of the caches' top entries no handle has held for `after`: their records' locks.
	pub fn let_go_idle_tops(&self, after: Duration) {
		self.held.lock().unwrap().retain(|_, entry| entry.idle.is_none_or(|since| since.elapsed() < after));
	}

	/// Holds the cache's top entry the local folder `ino` is, or is in (`hold_top`), while the mount has it open: the
	/// key to let go of it by (`let_go_top`), none for a git folder.
	pub fn hold_dir(&self, ino: u64) -> Result<Option<u64>, i32> {
		self.changing(
			|_| None,
			|names, _| {
				let (up, name, area) = latest(&names, ino).ok_or(libc::ESTALE)?;
				Ok(self.hold_top(&names, &up, &name, area)?.keep())
			},
		)
	}

	pub fn read(&self, fh: u64, offset: u64, size: u32) -> Result<Vec<u8>, i32> {
		use std::os::unix::fs::FileExt;
		let handles = self.handles.lock().unwrap();
		let file = handles.get(&fh).ok_or(libc::EBADF)?.file.try_clone().map_err(errno)?;
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
		let handle = handles.get(&fh).ok_or(libc::EBADF)?;
		let (file, ino) = (handle.file.try_clone().map_err(errno)?, handle.ino);
		drop(handles);
		if let Some(size) = records::test_disk_bytes() {
			self.test_disk_full(&file, ino, offset + data.len() as u64, size)?;
		}
		file.write_all_at(data, offset).map_err(errno)?;
		Ok(data.len() as u32)
	}

	/// Under the test switch of the caches' disk size (`records::TEST_DISK_BYTES`): ENOSPC for a write of a cache's file
	/// `file` (`ino`) up to `end` that grows the caches' files past `size`.
	fn test_disk_full(&self, file: &File, ino: u64, end: u64, size: u64) -> Result<(), i32> {
		if self.name(ino).is_none_or(|(_, _, area)| area != Area::Cache) {
			return Ok(());
		}
		let grows = end.saturating_sub(file.metadata().map_err(errno)?.len());
		if grows > 0 && records::bytes_under(&self.caches_disk()).map_err(errno)? + grows > size {
			return Err(libc::ENOSPC);
		}
		Ok(())
	}

	pub fn fsync(&self, fh: u64) -> Result<(), i32> {
		let handles = self.handles.lock().unwrap();
		handles.get(&fh).ok_or(libc::EBADF)?.file.sync_data().map_err(errno)
	}

	/// The local inode the handle `fh` has open.
	pub fn opened(&self, fh: u64) -> Option<u64> {
		self.handles.lock().unwrap().get(&fh).map(|h| h.ino)
	}

	pub fn release(&self, fh: u64) {
		let handle = self.handles.lock().unwrap().remove(&fh);
		self.released.notify_all();
		if let Some(key) = handle.and_then(|h| h.top) {
			self.let_go_top(key);
		}
	}

	/// Puts `bytes` in place as a new file `name` in `up` (executable when `executable`) at once, as a rename puts a file
	/// (`mount/on_disk.rs`): over the file there, kept aside until the move is kept or undone (`Placed`), unless
	/// `no_replace` (`EEXIST`); never over a folder (`EISDIR`). One a cache move has sealed, of this program or another
	/// sharing these caches (`named_file`), is waited for, and is gone into the folder after (`ESTALE`).
	pub fn place(
		&self,
		up: &Up,
		name: &str,
		area: Area,
		bytes: &[u8],
		executable: bool,
		no_replace: bool,
	) -> Result<Placed<'_>, i32> {
		static NEXT: AtomicU64 = AtomicU64::new(0);
		let started = std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
		let temp = self.gone(area).join(format!("in-{started}-{}", NEXT.fetch_add(1, Ordering::SeqCst)));
		let written = (|| {
			let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&temp)?;
			file.write_all(bytes)?;
			file.set_permissions(fs::Permissions::from_mode(if executable { 0o755 } else { 0o644 }))?;
			self.id(area, &file.metadata()?).map_err(io::Error::from_raw_os_error)
		})();
		let placed = written.map_err(errno).and_then(|ino| {
			self.changing(
				|names| self.ino_under(names, up, name, area),
				|mut names, waited| {
					self.make_room(up, area)?;
					let (target, _) = self.disk_under(&names, up, name, area).map_err(stale(waited))?;
					let _locked = named_file(&target)?;
					let replaced = match fs::symlink_metadata(target.path()) {
						Ok(m) if m.is_dir() => return Err(Change::Failed(libc::EISDIR)),
						Ok(_) if no_replace => return Err(Change::Failed(libc::EEXIST)),
						Ok(m) => Some(self.id(area, &m)?),
						Err(e) if e.kind() == io::ErrorKind::NotFound && waited => return Err(Change::Failed(libc::ESTALE)),
						Err(e) if e.kind() == io::ErrorKind::NotFound => None,
						Err(e) => return Err(Change::Failed(errno(e))),
					};
					let flags = if replaced.is_some() { libc::RENAME_EXCHANGE } else { libc::RENAME_NOREPLACE };
					renameat2(&temp, &target.path(), flags)?;
					if let Some(old) = replaced {
						forget(&mut names, old, up, name);
					}
					known(&mut names, ino, up.clone(), name, area);
					Ok((ino, replaced))
				},
			)
		});
		match placed {
			Ok((ino, replaced)) => {
				Ok(Placed { local: self, up: up.clone(), name: name.to_string(), area, aside: temp, ino, replaced })
			}
			Err(e) => {
				let _ = fs::remove_file(&temp);
				Err(e)
			}
		}
	}

	/// The files and folders under a cache folder's disk path, folders before what they hold, with their paths below
	/// it: what moves into the folder when its name leaves the list. None of it on another disk (`id`): the walk stops
	/// there (`EXDEV`). Each folder is read as `folder` finds it, never through a link.
	pub fn walk(&self, disk: &Path) -> io::Result<Vec<(String, fs::Metadata)>> {
		let base = disk.strip_prefix(self.area_path(Area::Cache)).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))?;
		let mut out = Vec::new();
		let mut todo = vec![String::new()];
		while let Some(rel) = todo.pop() {
			let dir = self.folder(Area::Cache, &base.join(&rel), false).map_err(io::Error::from_raw_os_error)?;
			for entry in fs::read_dir(fd_path(&dir))? {
				let entry = entry?;
				let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
				let rel = crate::proto::join(&rel, &name);
				let meta = entry.metadata()?;
				self.id(Area::Cache, &meta).map_err(io::Error::from_raw_os_error)?;
				if meta.is_dir() {
					todo.push(rel.clone());
				}
				out.push((rel, meta));
			}
		}
		Ok(out)
	}

	/// The file at the folder's `path` in `area`, opened to read, as `folder` finds it and never through a link (nor a
	/// pipe's open that waits).
	pub fn open_in(&self, area: Area, path: &str) -> io::Result<File> {
		let disk = self.beneath(area, &self.disk(area, path)).map_err(io::Error::from_raw_os_error)?;
		OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(disk.path())
	}

	/// The target of the link at the cache disk path `disk`, as `folder` finds it, the local inode of the link, and the
	/// link: all of the one link opened there (`O_PATH`), so another program renaming or exchanging links there meanwhile
	/// never gives one link's inode with another's target (which a cache move would publish, and then take the link off).
	/// The move keeps the link open until it is off the disk (`moved_file_out`): while it is, a link another program
	/// makes there after removing this one never has its inode.
	pub fn read_link(&self, disk: &Path) -> Result<(PathBuf, u64, File), i32> {
		let disk = self.beneath(Area::Cache, disk)?;
		let flags = libc::O_PATH | libc::O_NOFOLLOW;
		let place = OpenOptions::new().read(true).custom_flags(flags).open(disk.path()).map_err(errno)?;
		let ino = self.id(Area::Cache, &place.metadata().map_err(errno)?)?;
		#[cfg(test)]
		tests::parked("link", &disk.at);
		let target = target_of(&place)?;
		Ok((PathBuf::from(OsStr::from_bytes(&target)), ino, place))
	}
}

/// A file `Local::place` put in place, until the move it is for is kept (`keep`) or undone (`undo`).
pub struct Placed<'a> {
	local: &'a Local,
	up: Up,
	name: String,
	area: Area,
	/// Where the file it replaced is meanwhile.
	aside: PathBuf,
	ino: u64,
	replaced: Option<u64>,
}

impl Placed<'_> {
	/// The move is done: the file it replaced is taken off the disk.
	pub fn keep(self) {
		if self.replaced.is_some() {
			take_off(self.aside, None);
		}
	}

	/// The move is not made: the file it replaced is back, unless a change since put another in its place. Not while a
	/// cache move has the file sealed, of this program or another sharing these caches (`named_file`).
	pub fn undo(self) {
		let local = self.local;
		let (up, name, area) = (&self.up, self.name.as_str(), self.area);
		let _ = local.changing(
			|names| local.ino_under(names, up, name, area),
			|mut names, _| {
				let target = local.disk_under(&names, up, name, area).map(|(disk, _)| disk);
				let _locked = target.as_ref().map(named_file).unwrap_or(Ok(None))?;
				let here = target.as_ref().ok().and_then(|t| local.id(area, &fs::symlink_metadata(t.path()).ok()?).ok());
				let back = match (&target, self.replaced) {
					(Ok(target), Some(_)) if here == Some(self.ino) => {
						renameat2(&self.aside, &target.path(), libc::RENAME_EXCHANGE)
					}
					(Ok(target), None) if here == Some(self.ino) => fs::remove_file(target.path()).map_err(errno),
					_ => Err(libc::ESTALE),
				};
				if back.is_ok() {
					forget(&mut names, self.ino, up, name);
					if let Some(old) = self.replaced {
						known(&mut names, old, up.clone(), name, area);
					}
				}
				Ok(())
			},
		);
		if self.replaced.is_some() {
			take_off(self.aside, None);
		}
	}
}

/// renameat2 of `from` to `to` with `flags`.
fn renameat2(from: &Path, to: &Path, flags: u32) -> Result<(), i32> {
	let c = |p: &Path| std::ffi::CString::new(p.as_os_str().as_bytes()).map_err(|_| libc::EINVAL);
	let (from, to) = (c(from)?, c(to)?);
	// SAFETY: two valid C strings; renameat2 reads them only.
	if unsafe { libc::renameat2(libc::AT_FDCWD, from.as_ptr(), libc::AT_FDCWD, to.as_ptr(), flags) } != 0 {
		return Err(io::Error::last_os_error().raw_os_error().unwrap_or(libc::EIO));
	}
	Ok(())
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
	use std::sync::atomic::AtomicBool;
	use std::sync::mpsc;

	fn local(tag: &str, view: &str) -> (Local, PathBuf) {
		let dir = std::env::temp_dir().join(format!("qorpera-local-{tag}-{}", std::process::id()));
		(Local::open(&dir, None, view, (1000, 1000), None).unwrap(), dir)
	}

	/// A sealed file, unsealed when dropped: a check that fails lets the changes waiting on it end, and the test fail.
	struct Sealed<'a>(&'a Local, u64);

	impl Drop for Sealed<'_> {
		fn drop(&mut self) {
			self.0.unseal(self.1);
		}
	}

	type Park = (&'static str, PathBuf, std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>);

	/// The files a test stops the next change to at a point: `open`, between its open and its lock (`writer_at`);
	/// `rename`, just before a rename over it; `remove`, just before a cache move takes it off the disk
	/// (`moved_file_out`); `link`, between a cache move's read of a link's inode and of its target (`read_link`). It is told when one stopped there, and tells it to go on (`park`).
	static PARK: Mutex<Vec<Park>> = Mutex::new(Vec::new());

	pub(super) fn parked(point: &str, disk: &Path) {
		let mut parks = PARK.lock().unwrap();
		let Some(at) = parks.iter().position(|(p, at, _, _)| *p == point && at == disk) else { return };
		let (_, _, parked, go) = parks.remove(at);
		drop(parks);
		let _ = parked.send(());
		let _ = go.recv();
	}

	/// The next change to `disk` at `point`, stopped there (`parked`) until `go`: a stop not reached is taken off when
	/// it is dropped, and one reached goes on.
	struct Parked {
		point: &'static str,
		disk: PathBuf,
		stopped: std::sync::mpsc::Receiver<()>,
		go: Option<std::sync::mpsc::Sender<()>>,
	}

	impl Parked {
		/// Whether a change stopped there within `wait`.
		fn stopped(&self, wait: Duration) -> bool {
			self.stopped.recv_timeout(wait).is_ok()
		}

		fn go(&mut self) {
			self.go.take();
		}
	}

	impl Drop for Parked {
		fn drop(&mut self) {
			PARK.lock().unwrap().retain(|(p, at, _, _)| !(*p == self.point && *at == self.disk));
		}
	}

	fn park(point: &'static str, disk: &Path) -> Parked {
		let (parked, stopped) = std::sync::mpsc::channel();
		let (go, until) = std::sync::mpsc::channel();
		PARK.lock().unwrap().push((point, disk.to_path_buf(), parked, until));
		Parked { point, disk: disk.to_path_buf(), stopped, go: Some(go) }
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
		assert_eq!(l.getattr(attr.ino.0, None).unwrap().perm, 0o755);
		assert_eq!(
			l.create(Up::Local(hooks_ino), "pre-commit", Area::Git, 0o644, libc::O_WRONLY | libc::O_EXCL).unwrap_err(),
			libc::EEXIST
		);
		let fh = l.open_file(attr.ino.0, libc::O_RDONLY).unwrap();
		assert_eq!(l.read(fh, 2, 100).unwrap(), b"/bin/sh\n");
		l.release(fh);
		l.rename((&Up::Local(hooks_ino), "pre-commit"), (&Up::Local(hooks_ino), "post-commit"), Area::Git, true, false, None)
			.unwrap();
		assert_eq!(l.path(attr.ino.0).unwrap().0, "code/o/n/repo.git/hooks/post-commit");
		let names: Vec<String> = l.children(hooks_ino).unwrap().into_iter().map(|c| c.2).collect();
		assert_eq!(names, ["post-commit"]);
		let roots: Vec<String> = l.entries_of("code/o/n/repo.git", Area::Git).into_iter().map(|c| c.2).collect();
		assert_eq!(roots, ["hooks"]);
		let cache = Up::Mount("code/o/n/worktrees/w".to_string());
		assert_eq!(
			l.rename((&Up::Local(hooks_ino), "post-commit"), (&cache, "x"), Area::Cache, false, false, None),
			Err(libc::EXDEV)
		);
		l.unlink(&Up::Local(hooks_ino), "post-commit", Area::Git).unwrap();
		l.rmdir(&up, "hooks", Area::Git).unwrap();
		fs::remove_dir_all(&dir).unwrap();
	}

	#[test]
	fn a_local_inode_is_its_areas_and_never_one_on_another_disk() {
		let (mut l, dir) = local("ids", "v1");
		let git = l.mkdir(Up::Mount("code/o/n/repo.git".to_string()), "hooks", Area::Git, 0o755).unwrap();
		let top = Up::Mount("p".to_string());
		let cache = l.mkdir(top.clone(), "node_modules", Area::Cache, 0o755).unwrap();
		assert_eq!((git.ino.0 & (LOCAL | CACHE), cache.ino.0 & (LOCAL | CACHE)), (LOCAL, LOCAL | CACHE));
		assert_eq!(l.getattr(cache.ino.0, None).unwrap().ino, cache.ino);
		// The caches may be on a disk of their own, with the git files' inodes: one inode is told apart by its area.
		let disk = dir.join("caches/d/p/t/node_modules");
		let meta = fs::symlink_metadata(&disk).unwrap();
		assert_eq!((l.id(Area::Git, &meta), l.id(Area::Cache, &meta)), (Ok(meta.ino() | LOCAL), Ok(cache.ino.0)));
		// A file on another disk than its area's is none of its files.
		assert_eq!(l.id(Area::Git, &fs::symlink_metadata("/proc/self").unwrap()), Err(libc::EXDEV));
		// As if a disk were mounted in the cache folder, with these caches on it: they are not shown, looked up or walked.
		fs::create_dir(disk.join("x")).unwrap();
		l.devs.1 = !l.devs.1;
		assert!(l.entries_of("p", Area::Cache).is_empty());
		assert_eq!(l.entry(top, "node_modules", Area::Cache).unwrap_err(), libc::EXDEV);
		assert_eq!(l.walk(&disk).unwrap_err().raw_os_error(), Some(libc::EXDEV));
		assert_eq!(l.entries_of("code/o/n/repo.git", Area::Git).len(), 1);
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
		l.rename((&up, "b"), (&up, "c"), Area::Cache, false, false, None).unwrap();
		assert_eq!(l.path(a).unwrap().0, "code/o/n/worktrees/w/target/a");
		assert_eq!(l.path(b).unwrap().0, "code/o/n/worktrees/w/target/c");
		// Two names of one file swapped: both stay.
		l.link(a, up.clone(), "d", Area::Cache).unwrap();
		l.rename((&up, "a"), (&up, "d"), Area::Cache, false, false, None).unwrap();
		assert!(l.disk(Area::Cache, "code/o/n/worktrees/w/target/a").exists());
		assert_eq!(l.path(a).unwrap().0, "code/o/n/worktrees/w/target/d");
		l.unlink(&up, "d", Area::Cache).unwrap();
		assert_eq!(l.path(a).unwrap().0, "code/o/n/worktrees/w/target/a");
		fs::remove_dir_all(&dir).unwrap();
	}

	#[test]
	fn an_open_by_a_hard_links_name_never_reaches_the_file_that_took_its_place() {
		let (l, dir) = local("link-race", "v1");
		let up = Up::Mount("code/o/n/worktrees/w/target".to_string());
		let (attr, fh) = l.create(up.clone(), "a", Area::Cache, 0o644, libc::O_WRONLY).unwrap();
		l.release(fh);
		let a = attr.ino.0;
		let sub = Up::Local(l.mkdir(up.clone(), "subdir", Area::Cache, 0o755).unwrap().ino.0);
		let victim = l.disk(Area::Cache, "code/o/n/worktrees/w/target/subdir").join("b");
		let stop = AtomicBool::new(false);
		std::thread::scope(|s| {
			// `a`'s second name comes and goes, another file taking its place each time.
			let other = s.spawn(|| {
				while !stop.load(Ordering::SeqCst) {
					l.link(a, sub.clone(), "b", Area::Cache).unwrap();
					l.unlink(&sub, "b", Area::Cache).unwrap();
					let (_, fh) = l.create(sub.clone(), "b", Area::Cache, 0o644, libc::O_WRONLY).unwrap();
					assert_eq!(l.write(fh, 0, b"other").unwrap(), 5);
					l.release(fh);
					assert_eq!(fs::read(&victim).unwrap(), b"other", "an open of a reached the file that took b");
					l.unlink(&sub, "b", Area::Cache).unwrap();
				}
			});
			let opens = (0..2000).try_for_each(|_| {
				let fh = l.open_file(a, libc::O_WRONLY | libc::O_TRUNC)?;
				let wrote = l.write(fh, 0, b"a");
				l.release(fh);
				wrote.map(drop)
			});
			stop.store(true, Ordering::SeqCst);
			other.join().unwrap();
			assert_eq!(opens, Ok(()));
		});
		assert_eq!(fs::read(l.disk(Area::Cache, "code/o/n/worktrees/w/target/a")).unwrap(), b"a");
		fs::remove_dir_all(&dir).unwrap();
	}

	#[test]
	fn a_stat_or_readlink_by_a_hard_links_name_never_reaches_the_link_that_took_its_place() {
		let (l, dir) = local("stat-race", "v1");
		let up = Up::Mount("code/o/n/worktrees/w/target".to_string());
		let a = l.symlink(up.clone(), "a", Area::Cache, Path::new("to-a")).unwrap().ino.0;
		let sub = Up::Local(l.mkdir(up.clone(), "subdir", Area::Cache, 0o755).unwrap().ino.0);
		let stop = AtomicBool::new(false);
		std::thread::scope(|s| {
			// `a`'s second name comes and goes, another link taking its place each time.
			let other = s.spawn(|| {
				while !stop.load(Ordering::SeqCst) {
					l.link(a, sub.clone(), "b", Area::Cache).unwrap();
					l.unlink(&sub, "b", Area::Cache).unwrap();
					l.symlink(sub.clone(), "b", Area::Cache, Path::new("to-other")).unwrap();
					l.unlink(&sub, "b", Area::Cache).unwrap();
				}
			});
			let reads = (0..2000).try_for_each(|_| {
				let attr = l.getattr(a, None)?;
				let target = l.readlink(a)?;
				if attr.ino.0 != a || attr.size != 4 || target != b"to-a" {
					return Err(-1);
				}
				Ok(())
			});
			stop.store(true, Ordering::SeqCst);
			other.join().unwrap();
			assert_eq!(reads, Ok(()), "a stat or readlink of a reached the link that took b");
		});
		fs::remove_dir_all(&dir).unwrap();
	}

	#[test]
	fn the_names_go_to_the_thread_that_waited_for_them_first() {
		let (l, dir) = local("turns", "v1");
		let held = l.names();
		let order = Mutex::new(Vec::new());
		std::thread::scope(|s| {
			let waiting = s.spawn(|| {
				let _names = l.names();
				order.lock().unwrap().push("waiting");
			});
			std::thread::sleep(Duration::from_millis(200));
			assert!(!waiting.is_finished());
			// Let go of and taken again at once, as by a thread that changes names in a loop: the one waiting goes first.
			drop(held);
			let names = l.names();
			order.lock().unwrap().push("again");
			drop(names);
			waiting.join().unwrap();
		});
		assert_eq!(*order.lock().unwrap(), ["waiting", "again"]);
		fs::remove_dir_all(&dir).unwrap();
	}

	#[test]
	fn a_hard_link_a_cache_move_leaves_on_the_disk_keeps_its_own_names() {
		let (l, dir) = local("moved-out", "v1");
		let target = Up::Mount("code/o/n/worktrees/w/target".to_string());
		let (attr, fh) = l.create(target, "a", Area::Cache, 0o644, libc::O_WRONLY).unwrap();
		l.release(fh);
		let a = attr.ino.0;
		let modules = l.mkdir(Up::Mount("code/o/n/worktrees/w".to_string()), "node_modules", Area::Cache, 0o755).unwrap();
		l.link(a, Up::Local(modules.ino.0), "b", Area::Cache).unwrap();
		assert_eq!(l.path(a), Some(("code/o/n/worktrees/w/node_modules/b".to_string(), Area::Cache)));
		// Git came to track node_modules: the move has b in the folder, and takes it and its folder off the disk.
		let modules = l.disk(Area::Cache, "code/o/n/worktrees/w/node_modules");
		l.moved_out(&modules.join("b")).unwrap();
		l.moved_out(&modules).unwrap();
		assert_eq!(l.path(a), Some(("code/o/n/worktrees/w/target/a".to_string(), Area::Cache)));
		assert_eq!(l.getattr(a, None).map(|attr| attr.nlink), Ok(1));
		l.release(l.open_file(a, libc::O_RDONLY).unwrap());
		fs::remove_dir_all(&dir).unwrap();
	}

	#[test]
	fn a_file_a_cache_move_has_sealed_changes_only_once_the_move_is_done() {
		use std::io::Read;
		let (l, dir) = local("sealed", "v1");
		let up = Up::Mount("code/o/n/worktrees/w/target".to_string());
		let (attr, fh) = l.create(up.clone(), "a", Area::Cache, 0o644, libc::O_WRONLY).unwrap();
		let (a, disk) = (attr.ino.0, l.disk(Area::Cache, "code/o/n/worktrees/w/target/a"));
		// Open for writing: the move waits for its writer.
		assert_eq!(l.seal(&disk).map(|(_, ino)| ino), Err(libc::EBUSY));
		assert_eq!(l.write(fh, 0, b"ab").unwrap(), 2);
		l.release(fh);
		let (mut file, ino) = l.seal(&disk).unwrap();
		assert_eq!(ino, a);
		std::thread::scope(|s| {
			let sealed = Sealed(&l, ino);
			// An open for writing, a truncate, a create, an unlink or a rename waits until the move is done with the
			// file; a read does not.
			let opened = s.spawn(|| l.open_file(a, libc::O_WRONLY).map(drop));
			let truncated = s.spawn(|| l.setattr(a, None, None, Some(0), (None, None)).map(drop));
			let made = s.spawn(|| l.create(up.clone(), "a", Area::Cache, 0o644, libc::O_WRONLY).map(drop));
			let removed = s.spawn(|| l.unlink(&up, "a", Area::Cache).map(drop));
			let renamed = s.spawn(|| l.rename((&up, "a"), (&up, "z"), Area::Cache, false, false, None).map(drop));
			std::thread::sleep(Duration::from_millis(300));
			let waiting = [&opened, &truncated, &removed, &renamed].iter().all(|t| !t.is_finished());
			assert!(waiting && !made.is_finished());
			let fh = l.open_file(a, libc::O_RDONLY).unwrap();
			assert_eq!(l.read(fh, 0, 100).unwrap(), b"ab");
			l.release(fh);
			let mut read = Vec::new();
			file.read_to_end(&mut read).unwrap();
			assert_eq!(read, b"ab");
			// In the folder now: the name and the inode they asked by are stale, to be looked up again.
			l.moved_file_out(&disk, ino).unwrap();
			drop(sealed);
			for waited in [opened, truncated, made, removed, renamed] {
				assert_eq!(waited.join().unwrap(), Err(libc::ESTALE));
			}
		});
		assert!(!disk.exists() && !l.disk(Area::Cache, "code/o/n/worktrees/w/target/z").exists());
		// A move that did not finish: the change goes on, with the file on the disk still.
		let (attr, fh) = l.create(up.clone(), "b", Area::Cache, 0o644, libc::O_WRONLY).unwrap();
		l.release(fh);
		let disk = l.disk(Area::Cache, "code/o/n/worktrees/w/target/b");
		let (_, ino) = l.seal(&disk).unwrap();
		std::thread::scope(|s| {
			let sealed = Sealed(&l, ino);
			let opened = s.spawn(|| l.open_file(attr.ino.0, libc::O_WRONLY | libc::O_TRUNC));
			std::thread::sleep(Duration::from_millis(300));
			assert!(!opened.is_finished());
			drop(sealed);
			let fh = opened.join().unwrap().unwrap();
			assert_eq!(l.seal(&disk).map(|(_, ino)| ino), Err(libc::EBUSY));
			l.release(fh);
		});
		// A rename over it waits for the move, which takes only its own file off the disk.
		let (_, ino) = l.seal(&disk).unwrap();
		let (_, fh) = l.create(up.clone(), "c", Area::Cache, 0o644, libc::O_WRONLY).unwrap();
		l.write(fh, 0, b"c").unwrap();
		l.release(fh);
		std::thread::scope(|s| {
			let sealed = Sealed(&l, ino);
			let over = s.spawn(|| l.rename((&up, "c"), (&up, "b"), Area::Cache, false, false, None).map(drop));
			std::thread::sleep(Duration::from_millis(300));
			assert!(!over.is_finished());
			l.moved_file_out(&disk, ino).unwrap();
			drop(sealed);
			over.join().unwrap().unwrap();
		});
		assert_eq!(fs::read(&disk).unwrap(), b"c");
		// A file that took its name meanwhile behind the mount's back stays on the disk, for the move to be made again.
		let (_, ino) = l.seal(&disk).unwrap();
		fs::write(disk.with_file_name("d"), "d").unwrap();
		fs::rename(disk.with_file_name("d"), &disk).unwrap();
		assert_eq!(l.moved_file_out(&disk, ino), Err(libc::EBUSY));
		l.unseal(ino);
		assert_eq!(fs::read(&disk).unwrap(), b"d");
		fs::remove_dir_all(&dir).unwrap();
	}

	#[test]
	fn a_cache_file_open_for_writing_is_sealed_once_it_is_let_go_of_or_not_at_all() {
		let (l, dir) = local("seal-name", "v1");
		let up = Up::Mount("code/o/n/worktrees/w/node_modules".to_string());
		let (attr, fh) = l.create(up.clone(), "a", Area::Cache, 0o644, libc::O_WRONLY).unwrap();
		let a = attr.ino.0;
		// Open for writing: the seal waits for the mount to let go of it, and is not made if it does not in time.
		let started = Instant::now();
		assert_eq!(l.seal_name(&up, "a", Area::Cache, Duration::from_millis(200)).map(|s| s.1), Err(libc::EBUSY));
		assert!(started.elapsed() >= Duration::from_millis(200));
		std::thread::scope(|s| {
			let sealing = s.spawn(|| l.seal_name(&up, "a", Area::Cache, Duration::from_secs(10)).map(|(_, ino, disk)| (ino, disk)));
			std::thread::sleep(Duration::from_millis(300));
			let waiting = !sealing.is_finished();
			l.release(fh);
			assert!(waiting);
			let disk = l.disk(Area::Cache, "code/o/n/worktrees/w/node_modules/a");
			assert_eq!(sealing.join().unwrap(), Ok((a, disk)));
		});
		// Sealed by another move: not sealed again, at once.
		let started = Instant::now();
		assert_eq!(l.seal_name(&up, "a", Area::Cache, Duration::from_secs(10)).map(|s| s.1), Err(libc::EBUSY));
		assert!(started.elapsed() < Duration::from_secs(5));
		l.unseal(a);
		assert_eq!(l.seal_name(&up, "a", Area::Cache, Duration::ZERO).map(|s| s.1), Ok(a));
		assert_eq!(l.seal_name(&up, "b", Area::Cache, Duration::ZERO).map(|s| s.1), Err(libc::ENOENT));
		fs::remove_dir_all(&dir).unwrap();
	}

	#[test]
	fn a_placed_file_takes_its_name_whole_and_one_undone_gives_it_back() {
		let (l, dir) = local("place", "v1");
		let up = Up::Mount("code/o/n/worktrees/w".to_string());
		let disk = |name: &str| l.disk(Area::Cache, &format!("code/o/n/worktrees/w/{name}"));
		let ino = |name: &str| l.entry(up.clone(), name, Area::Cache).map(|a| a.ino.0);
		// Onto a new name: a file of its own, executable as asked; undone, the name is free again.
		l.place(&up, "a.log", Area::Cache, b"new", true, false).unwrap().keep();
		assert_eq!(fs::read(disk("a.log")).unwrap(), b"new");
		assert_eq!(fs::metadata(disk("a.log")).unwrap().permissions().mode() & 0o777, 0o755);
		l.place(&up, "c.log", Area::Cache, b"new", false, false).unwrap().undo();
		assert_eq!(ino("c.log"), Err(libc::ENOENT));
		// Over a file unless told not to (EEXIST), and never over a folder (EISDIR).
		let (old, fh) = l.create(up.clone(), "b.log", Area::Cache, 0o644, libc::O_WRONLY).unwrap();
		l.write(fh, 0, b"old").unwrap();
		l.release(fh);
		l.mkdir(up.clone(), "d", Area::Cache, 0o755).unwrap();
		assert_eq!(l.place(&up, "b.log", Area::Cache, b"x", false, true).map(drop), Err(libc::EEXIST));
		assert_eq!(l.place(&up, "d", Area::Cache, b"x", false, false).map(drop), Err(libc::EISDIR));
		// Undone: the file it replaced is back, by its name and inode.
		let placed = l.place(&up, "b.log", Area::Cache, b"newer", false, false).unwrap();
		assert_eq!(fs::read(disk("b.log")).unwrap(), b"newer");
		assert_ne!(ino("b.log"), Ok(old.ino.0));
		placed.undo();
		assert_eq!(fs::read(disk("b.log")).unwrap(), b"old");
		assert_eq!(ino("b.log"), Ok(old.ino.0));
		// Kept: the new file has the name.
		l.place(&up, "b.log", Area::Cache, b"newer", false, false).unwrap().keep();
		assert_eq!(fs::read(disk("b.log")).unwrap(), b"newer");
		assert_ne!(ino("b.log"), Ok(old.ino.0));
		// A name a cache move has sealed is waited for: gone into the folder since, it is stale.
		let (e, fh) = l.create(up.clone(), "e.log", Area::Cache, 0o644, libc::O_WRONLY).unwrap();
		l.release(fh);
		let (_, sealed, at) = l.seal_name(&up, "e.log", Area::Cache, Duration::ZERO).unwrap();
		assert_eq!(sealed, e.ino.0);
		std::thread::scope(|s| {
			let sealed = Sealed(&l, sealed);
			let placing = s.spawn(|| l.place(&up, "e.log", Area::Cache, b"x", false, false).map(drop));
			std::thread::sleep(Duration::from_millis(300));
			assert!(!placing.is_finished());
			l.moved_file_out(&at, sealed.1).unwrap();
			drop(sealed);
			assert_eq!(placing.join().unwrap(), Err(libc::ESTALE));
		});
		assert!(!disk("e.log").exists());
		// The files kept aside and the temporary ones of the refused places are all taken off the disk.
		let gone = || fs::read_dir(&l.gone.dir).unwrap().count() == 0;
		let started = Instant::now();
		while !gone() && started.elapsed() < Duration::from_secs(5) {
			std::thread::sleep(Duration::from_millis(20));
		}
		assert!(gone());
		fs::remove_dir_all(&dir).unwrap();
	}

	#[test]
	fn another_views_git_files_go_and_its_caches_stay() {
		let (l, dir) = local("views", "v1");
		l.put("code/o/n/repo.git/config", Some(b"[core]\n"), false).unwrap();
		l.mark_seeded("code/o/n/repo.git");
		l.mkdir(Up::Mount("code/o/n/worktrees/w".to_string()), "node_modules", Area::Cache, 0o755).unwrap();
		drop(l);
		let again = Local::open(&dir, None, "v1", (0, 0), None).unwrap();
		assert!(again.seeded("code/o/n/repo.git") && dir.join("git/code/o/n/repo.git/config").exists());
		drop(again);
		let other = Local::open(&dir, None, "v2", (0, 0), None).unwrap();
		assert!(!other.seeded("code/o/n/repo.git") && !dir.join("git/code/o/n/repo.git/config").exists());
		assert!(other.disk(Area::Cache, "code/o/n/worktrees/w/node_modules").is_dir());
		let tops: Vec<String> = other.entries_of("code/o/n/worktrees/w", Area::Cache).into_iter().map(|e| e.2).collect();
		assert_eq!(tops, ["node_modules"]);
		fs::remove_dir_all(&dir).unwrap();
	}

	#[test]
	fn caches_live_by_the_folder_they_are_in_and_move_or_go_with_it() {
		let (l, dir) = local("mirrors", "v1");
		let made = |up: Up, name: &str| l.mkdir(up, name, Area::Cache, 0o755).unwrap().ino.0;
		let file = |up: Up, name: &str| {
			let (attr, fh) = l.create(up, name, Area::Cache, 0o644, libc::O_WRONLY).unwrap();
			l.release(fh);
			attr.ino.0
		};
		// The folder's root, and a folder below it.
		let store = made(Up::Mount(String::new()), ".pnpm-store");
		assert_eq!(l.path(store), Some((".pnpm-store".to_string(), Area::Cache)));
		assert!(dir.join("caches/t/.pnpm-store").is_dir());
		let modules = made(Up::Mount("a/b".to_string()), "node_modules");
		let x = file(Up::Local(modules), "x.js");
		assert!(dir.join("caches/d/a/d/b/t/node_modules/x.js").is_file());
		assert!(l.is_top("a/b", "node_modules") && !l.is_top("a", "b") && !l.is_top("a/b", "x.js"));
		assert!(l.tops("a/b") && !l.tops("a") && l.has_caches("a") && !l.has_caches("c"));
		assert_eq!(l.mirrors("a"), ["b"]);
		// A move of a name takes the cache folders of that name in and below a folder, not a file of that name.
		let moving = |path: &str, name: &str| l.moving_below(path, &[name.to_string()]);
		file(Up::Mount("e".to_string()), "dist");
		assert!(moving("a", "node_modules") && moving("a/b", "node_modules") && !moving("a", "dist") && !moving("e", "dist"));
		// The node renamed a to c, in place of an empty c whose folder below had caches.
		made(Up::Mount("c/old".to_string()), "dist");
		l.renamed("a", "c");
		assert!(!l.has_caches("a") && !l.is_top("c/old", "dist") && l.mirrors("c") == ["b"]);
		assert_eq!(l.path(x), Some(("c/b/node_modules/x.js".to_string(), Area::Cache)));
		assert!(l.getattr(x, None).is_ok());
		// The node took a folder git came to track in place of the cache: what was in it is that folder's caches now.
		let built = made(Up::Mount("c/b".to_string()), "dist");
		let y = file(Up::Local(built), "y.js");
		assert_eq!(l.convert("c/b", "dist", true).unwrap(), true);
		assert!(!l.is_top("c/b", "dist") && l.is_top("c/b/dist", "y.js"));
		assert_eq!(l.name(y), Some((Up::Mount("c/b/dist".to_string()), "y.js".to_string(), Area::Cache)));
		assert!(l.whole("c/b/dist") && l.moving_below("c", &[]) && !l.moving_below("e", &[]));
		// One whose folder has caches of its own stays as it is.
		let again = made(Up::Mount("c/b".to_string()), "dist");
		assert_eq!(l.convert("c/b", "dist", true).unwrap(), false);
		assert!(l.is_top("c/b", "dist") && l.is_top("c/b/dist", "y.js"));
		// A folder git tracks paths in: the rest of it stays the caches of the node's folder, not all moving.
		let tracked = made(Up::Mount("e".to_string()), "logs");
		let kept = file(Up::Local(tracked), "keep.log");
		assert_eq!(l.convert("e", "logs", false).unwrap(), true);
		assert!(l.is_top("e/logs", "keep.log") && !l.whole("e/logs") && !l.moving_below("e", &[]));
		// Again, where that folder has caches already: what is in it joins them, but for a name they have.
		let more = made(Up::Mount("e".to_string()), "logs");
		let (twin, new) = (file(Up::Local(more), "keep.log"), file(Up::Local(more), "new.log"));
		assert_eq!(l.convert("e", "logs", false).unwrap(), true);
		assert!(!l.is_top("e", "logs") && l.is_top("e/logs", "keep.log") && l.is_top("e/logs", "new.log"));
		assert_eq!(l.name(new), Some((Up::Mount("e/logs".to_string()), "new.log".to_string(), Area::Cache)));
		assert!(l.name(kept).is_some() && l.name(twin).is_none() && l.name(more).is_none());
		assert!(!l.whole("e/logs") && !dir.join("caches/d/e/t/logs").exists());
		// The node's entry wins (rule 1), and a folder gone takes the caches in and below it.
		l.gone_top("c/b", "dist");
		assert!(!l.is_top("c/b", "dist") && l.name(again).is_none() && l.getattr(again, None) == Err(libc::ESTALE));
		l.drop_mirror("c");
		assert!(!l.has_caches("c") && l.name(x).is_none() && l.name(modules).is_none() && l.name(y).is_none());
		// Moved into a repository's git folder, where no cache is shown, they go too.
		let z = file(Up::Mount("d".to_string()), "out");
		l.renamed("d", "code/o/n/repo.git/d");
		assert!(!l.has_caches("d") && !l.has_caches("code/o/n/repo.git/d") && l.name(z).is_none());
		assert_eq!(l.path(store), Some((".pnpm-store".to_string(), Area::Cache)));
		fs::remove_dir_all(&dir).unwrap();
	}

	#[test]
	fn the_caches_of_5ds_program_go_at_the_start() {
		let dir = std::env::temp_dir().join(format!("qorpera-local-old-cache-{}", std::process::id()));
		fs::create_dir_all(dir.join("cache/code/o/n/worktrees/w/node_modules")).unwrap();
		fs::create_dir_all(dir.join("gone/1-0/x")).unwrap();
		let l = Local::open(&dir, None, "v1", (0, 0), None).unwrap();
		assert!(!dir.join("cache").exists());
		assert!(l.entries_of("code/o/n/worktrees/w", Area::Cache).is_empty());
		drop(l);
		fs::remove_dir_all(&dir).unwrap();
	}

	#[test]
	fn programs_given_one_cache_folder_share_its_caches_and_each_keeps_its_own_gone() {
		let base = std::env::temp_dir().join(format!("qorpera-local-shared-{}", std::process::id()));
		let shared = base.join("cache");
		fs::DirBuilder::new().recursive(true).mode(0o700).create(&shared).unwrap();
		// The caches a program kept in its local folder before go once it has a cache folder.
		fs::create_dir_all(base.join("a/caches/t/node_modules")).unwrap();
		// What programs that stopped left to take off: one from before the programs' own folders, and one's own.
		fs::create_dir_all(shared.join("gone/1-0/x")).unwrap();
		fs::create_dir_all(shared.join("gone/p-1-1-0/y")).unwrap();
		let a = Local::open(&base.join("a"), Some(&shared), "v1", (0, 0), None).unwrap();
		assert!(!base.join("a/caches").exists());
		a.mkdir(Up::Mount("p".to_string()), "node_modules", Area::Cache, 0o755).unwrap();
		assert!(shared.join("caches/d/p/t/node_modules").is_dir());
		assert!(a.gone(Area::Cache).starts_with(&shared) && a.gone(Area::Git).starts_with(base.join("a")));
		// A second program, for another view, sees the first one's caches, and leaves its own folder in gone/ be.
		let b = Local::open(&base.join("b"), Some(&shared), "v2", (0, 0), None).unwrap();
		let tops = |l: &Local| l.entries_of("p", Area::Cache).into_iter().map(|e| e.2).collect::<Vec<_>>();
		assert_eq!(tops(&b), ["node_modules"]);
		assert!(a.gone(Area::Cache).is_dir() && b.gone(Area::Cache).is_dir());
		let left = || shared.join("gone/1-0").exists() || shared.join("gone/p-1-1-0").exists();
		let started = Instant::now();
		while left() && started.elapsed() < Duration::from_secs(5) {
			std::thread::sleep(Duration::from_millis(20));
		}
		assert!(!left());
		// What one takes off goes through its own folder, on the caches' disk.
		b.gone_top("p", "node_modules");
		assert!(tops(&a).is_empty() && a.gone(Area::Cache).is_dir());
		// Started again, a program finds the caches it made.
		a.mkdir(Up::Mount("p".to_string()), "dist", Area::Cache, 0o755).unwrap();
		drop(a);
		let again = Local::open(&base.join("a"), Some(&shared), "v1", (0, 0), None).unwrap();
		assert_eq!(tops(&again), ["dist"]);
		// The cache folder is one its starter made, only this account's, a short path, and neither it nor the local folder
		// is inside the other.
		let open = |root: &str, caches: &str| Local::open(&base.join(root), Some(&base.join(caches)), "v1", (0, 0), None);
		let unusable = |r: io::Result<Local>| r.err().is_some_and(|e| e.to_string().starts_with(UNUSABLE));
		assert!(unusable(open("c", "missing")) && !base.join("missing").exists());
		fs::DirBuilder::new().recursive(true).mode(0o700).create(base.join("c/caches")).unwrap();
		assert!(unusable(open("c", "c/caches")) && unusable(open("d/local", "d")));
		fs::DirBuilder::new().mode(0o755).create(base.join("wide")).unwrap();
		fs::set_permissions(base.join("wide"), fs::Permissions::from_mode(0o755)).unwrap();
		std::os::unix::fs::symlink(&shared, base.join("link")).unwrap();
		assert!(unusable(open("e", "wide")) && unusable(open("e", "link")));
		let long = base.join("l".repeat(CACHE_DIR_MAX));
		fs::DirBuilder::new().mode(0o700).create(&long).unwrap();
		assert!(unusable(Local::open(&base.join("e"), Some(&long), "v1", (0, 0), None)));
		assert!(unusable(Local::open(&base.join("e"), Some(Path::new("cache")), "v1", (0, 0), None)));
		// Given its local folder, a program keeps its caches there.
		let same = open("f", "f").unwrap();
		same.mkdir(Up::Mount(String::new()), ".pnpm-store", Area::Cache, 0o755).unwrap();
		assert!(base.join("f/caches/t/.pnpm-store").is_dir());
		drop((b, again, same));
		fs::remove_dir_all(&base).unwrap();
	}

	/// Two programs, for the views v1 and v2, given one cache folder; and the folder they share.
	fn sharing(tag: &str) -> (Local, Local, PathBuf) {
		let base = std::env::temp_dir().join(format!("qorpera-local-{tag}-{}", std::process::id()));
		let shared = base.join("cache");
		fs::DirBuilder::new().recursive(true).mode(0o700).create(&shared).unwrap();
		let a = Local::open(&base.join("a"), Some(&shared), "v1", (0, 0), None).unwrap();
		let b = Local::open(&base.join("b"), Some(&shared), "v2", (0, 0), None).unwrap();
		(a, b, base)
	}

	#[test]
	fn no_program_takes_off_caches_another_shares_for_a_folder_its_own_view_has_not() {
		let (a, b, base) = sharing("shared-keep");
		assert!(a.shared() && b.shared());
		// v2 made a folder p it has not published, with caches in it: v1's view has no p.
		b.mkdir(Up::Mount("p/q".to_string()), "node_modules", Area::Cache, 0o755).unwrap();
		a.drop_mirror("p");
		assert!(a.has_caches("p") && a.is_top("p/q", "node_modules"));
		// Nor a rename of a folder v1 has no caches in onto p: p's are v2's.
		assert!(!a.renamed("r", "p"));
		assert!(b.is_top("p/q", "node_modules"));
		// One that has, moves them, as a program on its own does; the same rename by the other program finds none.
		a.mkdir(Up::Mount("s".to_string()), "dist", Area::Cache, 0o755).unwrap();
		assert!(a.renamed("s", "t"));
		assert!(b.is_top("t", "dist") && !b.has_caches("s"));
		assert!(!b.renamed("s", "t"));
		// Not sharing them, a program takes off the caches of a folder gone from its view (`drop_mirror`).
		let (alone, dir) = local("shared-alone", "v1");
		alone.mkdir(Up::Mount("p".to_string()), "node_modules", Area::Cache, 0o755).unwrap();
		assert!(!alone.shared());
		alone.drop_mirror("p");
		assert!(!alone.has_caches("p"));
		drop((a, b, alone));
		fs::remove_dir_all(&base).unwrap();
		fs::remove_dir_all(&dir).unwrap();
	}

	#[test]
	fn a_folders_caches_another_program_moved_while_this_one_waited_are_not_moved_again() {
		let (a, b, base) = sharing("shared-renaming");
		a.mkdir(Up::Mount("s".to_string()), "dist", Area::Cache, 0o755).unwrap();
		// v2's program is moving caches: v1's rename of the same folder waits, and then finds them moved.
		let held = File::open(a.mirror("")).unwrap();
		crate::viewfile::flock(&held, libc::LOCK_EX).unwrap();
		std::thread::scope(|s| {
			let renamed = s.spawn(|| a.renamed("s", "t"));
			std::thread::sleep(Duration::from_millis(300));
			assert!(!renamed.is_finished());
			fs::rename(b.mirror("s"), b.mirror("t")).unwrap();
			drop(held);
			assert!(!renamed.join().unwrap());
		});
		assert!(b.is_top("t", "dist") && a.is_top("t", "dist") && !a.has_caches("s"));
		drop((a, b));
		fs::remove_dir_all(&base).unwrap();
	}

	#[test]
	fn a_cache_another_program_holds_is_not_removed_and_a_removal_that_has_its_record_is_waited_for() {
		let (a, b, base) = sharing("shared-held");
		let up = Up::Mount("p".to_string());
		let modules = b.mkdir(up.clone(), "node_modules", Area::Cache, 0o755).unwrap().ino.0;
		let (attr, fh) = b.create(Up::Local(modules), "x.js", Area::Cache, 0o644, libc::O_WRONLY).unwrap();
		let any = |_: &Record, there: bool| there;
		// Held by the other program's handle, then idle in it.
		assert_eq!(a.remove_old("p", "node_modules", any).unwrap(), None);
		b.release(fh);
		assert_eq!(a.remove_old("p", "node_modules", any).unwrap(), None);
		assert!(a.is_top("p", "node_modules"));
		// Held again once let go of, its last use is written if old.
		b.let_go_idle_tops(Duration::ZERO);
		let record = a.record("p", "node_modules");
		let old = std::time::SystemTime::now() - 2 * records::TOUCH_AFTER;
		File::options().write(true).open(&record).unwrap().set_modified(old).unwrap();
		let fh = b.open_file(attr.ino.0, libc::O_RDONLY).unwrap();
		assert!(records::read_path(&record).unwrap().used > old);
		b.release(fh);
		b.let_go_idle_tops(Duration::ZERO);
		// A removal that has the record: a hold waits for it.
		let removing = File::open(&record).unwrap();
		crate::viewfile::flock(&removing, libc::LOCK_EX).unwrap();
		std::thread::scope(|s| {
			let held = s.spawn(|| b.hold_dir(modules));
			std::thread::sleep(Duration::from_millis(300));
			assert!(!held.is_finished());
			drop(removing);
			b.let_go_top(held.join().unwrap().unwrap().expect("a held top entry"));
		});
		// Let go of, it goes.
		b.let_go_idle_tops(Duration::ZERO);
		let gone = a.remove_old("p", "node_modules", any).unwrap().expect("a removed cache");
		assert!(!a.is_top("p", "node_modules") && !record.exists());
		fs::remove_dir_all(gone).unwrap();
		// The record of a new cache whose name a removal has: written in its place once the removal is done.
		let dist = a.record("p", "dist");
		drop(a.write_record("p", "dist", Kind::Name));
		let removing = File::open(&dist).unwrap();
		crate::viewfile::flock(&removing, libc::LOCK_EX).unwrap();
		std::thread::scope(|s| {
			let written = s.spawn(|| b.write_record("p", "dist", Kind::Kept));
			std::thread::sleep(Duration::from_millis(300));
			assert!(!written.is_finished());
			fs::remove_file(&dist).unwrap();
			drop(removing);
			let file = written.join().unwrap().expect("a written record");
			assert_eq!(file.metadata().unwrap().ino(), fs::symlink_metadata(&dist).unwrap().ino());
		});
		let written = records::read_path(&dist).unwrap();
		assert_eq!((written.kind, written.view.as_deref()), (Kind::Kept, Some(b.view())));
		drop((a, b));
		fs::remove_dir_all(&base).unwrap();
	}

	#[test]
	fn a_rename_onto_a_cache_another_program_is_removing_waits_for_the_removal() {
		let (a, b, base) = sharing("shared-rename-removed");
		let up = Up::Mount("p".to_string());
		let modules = a.mkdir(up.clone(), "node_modules", Area::Cache, 0o755).unwrap().ino.0;
		let (_, fh) = a.create(Up::Local(modules), "x.js", Area::Cache, 0o644, libc::O_WRONLY).unwrap();
		a.write(fh, 0, b"x").unwrap();
		a.release(fh);
		a.mkdir(up.clone(), "dist", Area::Cache, 0o755).unwrap();
		a.let_go_idle_tops(Duration::ZERO);
		// v2's removal of dist has its record: v1's rename of node_modules onto dist waits until dist is gone, and the
		// removal takes the old dist, not node_modules.
		let gone = std::thread::scope(|s| {
			let renaming = std::cell::OnceCell::new();
			let (a, up) = (&a, &up);
			let old = |_: &Record, there: bool| {
				let rename = move || a.rename((up, "node_modules"), (up, "dist"), Area::Cache, false, false, None);
				let renamed = s.spawn(move || rename().map(drop));
				std::thread::sleep(Duration::from_millis(300));
				assert!(!renamed.is_finished());
				assert!(renaming.set(renamed).is_ok());
				there
			};
			let gone = b.remove_old("p", "dist", old).unwrap().expect("a removed cache");
			renaming.into_inner().expect("a rename").join().unwrap().unwrap();
			gone
		});
		assert_eq!(fs::read(a.disk(Area::Cache, "p/dist").join("x.js")).unwrap(), b"x");
		assert!(a.is_top("p", "dist") && !a.is_top("p", "node_modules") && !a.record("p", "node_modules").exists());
		fs::remove_dir_all(gone).unwrap();
		drop((a, b));
		fs::remove_dir_all(&base).unwrap();
	}

	#[test]
	fn an_exchange_of_two_caches_swaps_their_records_and_the_holds_on_them() {
		let (a, b, base) = sharing("shared-exchange");
		let up = Up::Mount("p".to_string());
		drop((b.write_record("p", "node_modules", Kind::Name), b.write_record("p", "dist", Kind::Kept)));
		let modules = b.mkdir(up.clone(), "node_modules", Area::Cache, 0o755).unwrap().ino.0;
		b.mkdir(up.clone(), "dist", Area::Cache, 0o755).unwrap();
		let (_, fh) = b.create(Up::Local(modules), "x.js", Area::Cache, 0o644, libc::O_WRONLY).unwrap();
		b.rename((&up, "node_modules"), (&up, "dist"), Area::Cache, false, true, None).unwrap();
		b.let_go_idle_tops(Duration::ZERO);
		// The open file's tree is dist now, held by the record that went with it; each says what its name's did.
		let any = |_: &Record, there: bool| there;
		assert_eq!(a.remove_old("p", "dist", any).unwrap(), None);
		assert_eq!(records::read_path(&a.record("p", "dist")).unwrap().kind, Kind::Kept);
		assert_eq!(records::read_path(&a.record("p", "node_modules")).unwrap().kind, Kind::Name);
		let gone = a.remove_old("p", "node_modules", any).unwrap().expect("a removed cache");
		assert!(a.is_top("p", "dist") && !a.is_top("p", "node_modules"));
		assert!(b.disk(Area::Cache, "p/dist").join("x.js").exists());
		fs::remove_dir_all(gone).unwrap();
		b.release(fh);
		drop((a, b));
		fs::remove_dir_all(&base).unwrap();
	}

	#[test]
	fn a_worktrees_caches_a_program_has_to_move_are_not_removed() {
		let (a, b, base) = sharing("shared-moves");
		let worktree = "code/o/n/worktrees/w";
		assert!(a.no_moves(worktree).unwrap().is_some());
		// v1 has caches there to move into the folder: no removal takes the worktree's, its own neither.
		a.cache.lock().unwrap().track(worktree);
		a.hold_moves();
		for program in [&a, &b] {
			assert_eq!(program.no_moves(worktree).map(drop).map_err(|e| e.kind()), Err(io::ErrorKind::WouldBlock));
		}
		// Moved: let go of.
		let generation = a.cache.lock().unwrap().generation(worktree);
		a.cache.lock().unwrap().moved(worktree, crate::cache::TRACKED, generation);
		a.hold_moves();
		assert!(b.no_moves(worktree).unwrap().is_some());
		// Not sharing its caches, a program has its own list only.
		let (alone, dir) = local("moves-alone", "v1");
		assert!(alone.no_moves(worktree).unwrap().is_none());
		drop((a, b, alone));
		fs::remove_dir_all(&base).unwrap();
		fs::remove_dir_all(&dir).unwrap();
	}

	/// Has `local` stop at the point `at` of its next change there (`Local::pause`): what says it got there, and what
	/// lets it go on once sent to or dropped.
	fn pause_at(local: &Local, at: &'static str) -> (mpsc::Receiver<()>, mpsc::Sender<()>) {
		let ((there, got_there), (go_on, going_on)) = (mpsc::channel(), mpsc::channel());
		let paused = move || {
			there.send(()).unwrap();
			let _ = going_on.recv();
		};
		local.paused.lock().unwrap().insert(at, Box::new(paused));
		(got_there, go_on)
	}

	#[test]
	fn a_refresh_of_the_moves_locks_from_before_a_move_was_asked_for_keeps_the_lock_taken_for_it() {
		let (a, b, base) = sharing("shared-moves-refresh");
		let worktree = "code/o/n/worktrees/w";
		// v1 reads its worktrees with moves (none), and a move there is asked for, and its lock taken, before it goes on.
		let (got_there, go_on) = pause_at(&a, "hold_moves");
		std::thread::scope(|s| {
			let go_on = go_on;
			let refresh = s.spawn(|| a.hold_moves());
			got_there.recv_timeout(Duration::from_secs(10)).expect("the refresh paused");
			let asked = s.spawn(|| {
				a.cache.lock().unwrap().track(worktree);
				a.hold_moves();
			});
			std::thread::sleep(Duration::from_millis(300));
			drop(go_on);
			refresh.join().unwrap();
			asked.join().unwrap();
		});
		assert_eq!(b.no_moves(worktree).map(drop).map_err(|e| e.kind()), Err(io::ErrorKind::WouldBlock));
		drop((a, b));
		fs::remove_dir_all(&base).unwrap();
	}

	#[test]
	fn an_open_in_another_program_waits_for_a_rename_of_caches_to_move_their_records() {
		let (a, b, base) = sharing("shared-rename-open");
		let up = Up::Mount("p".to_string());
		let modules = a.mkdir(up.clone(), "node_modules", Area::Cache, 0o755).unwrap().ino.0;
		let (_, fh) = a.create(Up::Local(modules), "x.js", Area::Cache, 0o644, libc::O_WRONLY).unwrap();
		a.release(fh);
		a.mkdir(up.clone(), "dist", Area::Cache, 0o755).unwrap();
		a.let_go_idle_tops(Duration::ZERO);
		// v2 opens x.js in `top` once v1's `rename` has moved the trees, before their records: it waits for the records,
		// and holds the one that came with x.js's tree.
		let opened_between = |top: &str, rename: &(dyn Fn() + Sync)| {
			let (got_there, go_on) = pause_at(&a, "records_renamed");
			std::thread::scope(|s| {
				let go_on = go_on;
				let renamed = s.spawn(move || rename());
				got_there.recv_timeout(Duration::from_secs(10)).expect("the rename paused");
				let opened = s.spawn(|| {
					let top = b.entry(up.clone(), top, Area::Cache).unwrap().ino.0;
					b.open_file(b.entry(Up::Local(top), "x.js", Area::Cache).unwrap().ino.0, libc::O_RDONLY).unwrap()
				});
				std::thread::sleep(Duration::from_millis(300));
				assert!(!opened.is_finished());
				drop(go_on);
				renamed.join().unwrap();
				opened.join().unwrap()
			})
		};
		let any = |_: &Record, there: bool| there;
		let fh = opened_between("dist", &|| {
			a.rename((&up, "node_modules"), (&up, "dist"), Area::Cache, false, true, None).unwrap();
		});
		a.let_go_idle_tops(Duration::ZERO);
		assert_eq!(a.remove_old("p", "dist", any).unwrap(), None);
		b.release(fh);
		b.let_go_idle_tops(Duration::ZERO);
		// So with a rename to a new name.
		let fh = opened_between("out", &|| {
			a.rename((&up, "dist"), (&up, "out"), Area::Cache, false, false, None).unwrap();
		});
		a.let_go_idle_tops(Duration::ZERO);
		assert_eq!(a.remove_old("p", "out", any).unwrap(), None);
		b.release(fh);
		drop((a, b));
		fs::remove_dir_all(&base).unwrap();
	}

	#[test]
	fn another_programs_renames_and_removals_of_a_file_a_cache_move_has_wait_for_it() {
		let (a, b, base) = sharing("shared-names");
		let up = Up::Mount("code/o/n/worktrees/w/target".to_string());
		let disk = |name: &str| a.disk(Area::Cache, &format!("code/o/n/worktrees/w/target/{name}"));
		for (name, bytes) in [("x", "mine"), ("y", "peer"), ("u", "gone"), ("v", "away")] {
			let (_, fh) = b.create(up.clone(), name, Area::Cache, 0o644, libc::O_WRONLY).unwrap();
			b.write(fh, 0, bytes.as_bytes()).unwrap();
			b.release(fh);
		}
		// v1's move has x: v2's rename of y over it waits, so the move takes x off the disk, not y.
		let (_, ino) = a.seal(&disk("x")).unwrap();
		std::thread::scope(|s| {
			let sealed = Sealed(&a, ino);
			let over = s.spawn(|| b.rename((&up, "y"), (&up, "x"), Area::Cache, false, false, None).map(drop));
			std::thread::sleep(Duration::from_millis(300));
			assert!(!over.is_finished());
			a.moved_file_out(&disk("x"), ino).unwrap();
			drop(sealed);
			over.join().unwrap().unwrap();
		});
		assert_eq!(fs::read(disk("x")).unwrap(), b"peer");
		// A removal or a rename of a file it has waits too, and finds it in the folder (stale).
		let (_, u) = a.seal(&disk("u")).unwrap();
		let (_, v) = a.seal(&disk("v")).unwrap();
		std::thread::scope(|s| {
			let sealed = (Sealed(&a, u), Sealed(&a, v));
			let removed = s.spawn(|| b.unlink(&up, "u", Area::Cache).map(drop));
			let renamed = s.spawn(|| b.rename((&up, "v"), (&up, "w"), Area::Cache, false, false, None).map(drop));
			std::thread::sleep(Duration::from_millis(300));
			assert!(!removed.is_finished() && !renamed.is_finished());
			a.moved_file_out(&disk("u"), u).unwrap();
			a.moved_file_out(&disk("v"), v).unwrap();
			drop(sealed);
			assert_eq!(removed.join().unwrap(), Err(libc::ESTALE));
			assert_eq!(renamed.join().unwrap(), Err(libc::ESTALE));
		});
		assert!(!disk("w").exists());
		drop((a, b));
		fs::remove_dir_all(&base).unwrap();
	}

	#[test]
	fn a_cache_move_and_another_programs_writes_to_the_file_wait_for_each_other() {
		use std::io::Read;
		let (a, b, base) = sharing("shared-seal");
		let up = Up::Mount("code/o/n/worktrees/w/target".to_string());
		let disk = |name: &str| a.disk(Area::Cache, &format!("code/o/n/worktrees/w/target/{name}"));
		// v2's program has it open for writing: v1's move is not made, at once.
		let (attr, fh) = b.create(up.clone(), "a", Area::Cache, 0o644, libc::O_WRONLY).unwrap();
		let ino = attr.ino.0;
		assert_eq!(a.seal(&disk("a")).map(|(_, ino)| ino), Err(libc::EBUSY));
		let started = Instant::now();
		assert_eq!(a.seal_name(&up, "a", Area::Cache, Duration::from_secs(10)).map(|s| s.1), Err(libc::EBUSY));
		assert!(started.elapsed() < Duration::from_secs(5));
		assert_eq!(b.write(fh, 0, b"ab").unwrap(), 2);
		b.release(fh);
		// Let go of: sealed. v2's changes to its bytes wait for the move, a read does not; a truncate truncates nothing
		// meanwhile.
		let (mut file, sealed) = a.seal(&disk("a")).unwrap();
		assert_eq!(sealed, ino);
		std::thread::scope(|s| {
			let sealed = Sealed(&a, ino);
			let opened = s.spawn(|| b.open_file(ino, libc::O_WRONLY).map(drop));
			let emptied = s.spawn(|| b.open_file(ino, libc::O_WRONLY | libc::O_TRUNC).map(drop));
			let truncated = s.spawn(|| b.setattr(ino, None, None, Some(0), (None, None)).map(drop));
			let made = s.spawn(|| b.create(up.clone(), "a", Area::Cache, 0o644, libc::O_WRONLY | libc::O_TRUNC).map(drop));
			std::thread::sleep(Duration::from_millis(300));
			assert!([&opened, &emptied, &truncated, &made].iter().all(|t| !t.is_finished()));
			let fh = b.open_file(ino, libc::O_RDONLY).unwrap();
			assert_eq!(b.read(fh, 0, 100).unwrap(), b"ab");
			b.release(fh);
			let mut read = Vec::new();
			file.read_to_end(&mut read).unwrap();
			assert_eq!(read, b"ab");
			// In the folder now: stale for v2 too, to be looked up again.
			a.moved_file_out(&disk("a"), ino).unwrap();
			drop(sealed);
			for waited in [opened, emptied, truncated, made] {
				assert_eq!(waited.join().unwrap(), Err(libc::ESTALE));
			}
		});
		assert!(!disk("a").exists());
		// A move that did not finish: v2's change goes on, with the file as it was, and holds the next move off.
		let (attr, fh) = b.create(up.clone(), "b", Area::Cache, 0o644, libc::O_WRONLY).unwrap();
		assert_eq!(b.write(fh, 0, b"xy").unwrap(), 2);
		b.release(fh);
		let (_, sealed) = a.seal(&disk("b")).unwrap();
		std::thread::scope(|s| {
			let unsealed = Sealed(&a, sealed);
			let opened = s.spawn(|| b.open_file(attr.ino.0, libc::O_WRONLY | libc::O_TRUNC));
			std::thread::sleep(Duration::from_millis(300));
			assert!(!opened.is_finished());
			assert_eq!(fs::read(disk("b")).unwrap(), b"xy");
			drop(unsealed);
			let fh = opened.join().unwrap().unwrap();
			assert!(fs::read(disk("b")).unwrap().is_empty());
			assert_eq!(a.seal(&disk("b")).map(|(_, ino)| ino), Err(libc::EBUSY));
			b.release(fh);
		});
		let (_, sealed) = a.seal(&disk("b")).unwrap();
		// Sealed by one program: not by the other.
		assert_eq!(b.seal(&disk("b")).map(|(_, ino)| ino), Err(libc::EBUSY));
		a.unseal(sealed);
		let (_, sealed) = b.seal(&disk("b")).unwrap();
		b.unseal(sealed);
		drop((a, b));
		fs::remove_dir_all(&base).unwrap();
	}

	#[test]
	fn another_programs_cache_move_waits_for_a_file_between_its_open_and_its_lock() {
		let (a, b, base) = sharing("shared-park");
		let up = Up::Mount("code/o/n/worktrees/w/target".to_string());
		let disk = a.disk(Area::Cache, "code/o/n/worktrees/w/target/a");
		let (attr, fh) = b.create(up.clone(), "a", Area::Cache, 0o644, libc::O_WRONLY).unwrap();
		b.release(fh);
		std::thread::scope(|s| {
			// In here, so a check that fails lets the open go on (`Parked`), and the test fail.
			let mut parked = park("open", &disk);
			let opened = s.spawn(|| b.open_file(attr.ino.0, libc::O_WRONLY));
			assert!(parked.stopped(Duration::from_secs(10)));
			// v1's move waits for the names v2's open holds: it never seals the file, or takes it off the disk, before
			// the open locks it; then the file is open for writing, and is not sealed.
			// A seal made too early goes with its handle, before the open goes on (`sealed` drops first).
			let sealed = s.spawn(|| a.seal(&disk).map(|(_, ino)| Sealed(&a, ino)));
			std::thread::sleep(Duration::from_millis(300));
			assert!(!sealed.is_finished());
			parked.go();
			let fh = opened.join().unwrap().unwrap();
			assert_eq!(sealed.join().unwrap().map(|sealed| sealed.1), Err(libc::EBUSY));
			b.release(fh);
		});
		let (_, sealed) = a.seal(&disk).unwrap();
		a.unseal(sealed);
		drop((a, b));
		fs::remove_dir_all(&base).unwrap();
	}

	#[test]
	fn nothing_reaches_past_a_cache_folder_another_program_put_a_link_or_another_folder_in_the_place_of() {
		let (a, b, base) = sharing("shared-swap");
		let up = Up::Mount("c".to_string());
		let d = a.mkdir(up.clone(), "d", Area::Cache, 0o755).unwrap().ino.0;
		let (_, fh) = a.create(Up::Local(d), "x", Area::Cache, 0o644, libc::O_WRONLY).unwrap();
		a.write(fh, 0, b"keep").unwrap();
		a.release(fh);
		// v2 renames d and puts a link to a folder outside the caches in its place, which v1's names do not know.
		let outside = base.join("outside");
		fs::create_dir(&outside).unwrap();
		fs::write(outside.join("x"), "host bytes").unwrap();
		b.rename((&up, "d"), (&up, "e"), Area::Cache, false, false, None).unwrap();
		b.symlink(up.clone(), "d", Area::Cache, &outside).unwrap();
		let made = |name: &str, flags: i32| a.create(Up::Local(d), name, Area::Cache, 0o644, flags).map(drop);
		assert_eq!(made("x", libc::O_WRONLY | libc::O_TRUNC), Err(libc::ESTALE));
		assert_eq!(made("new", libc::O_WRONLY), Err(libc::ESTALE));
		assert_eq!(a.mkdir(Up::Local(d), "f", Area::Cache, 0o755).map(drop), Err(libc::ESTALE));
		assert_eq!(a.entry(Up::Local(d), "x", Area::Cache).map(drop), Err(libc::ESTALE));
		assert_eq!(a.children(d).map(drop), Err(libc::ESTALE));
		assert_eq!(fs::read(outside.join("x")).unwrap(), b"host bytes");
		assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);
		// Another folder in its place: not the one v1's names name.
		fs::remove_file(a.disk(Area::Cache, "c/d")).unwrap();
		b.mkdir(up.clone(), "d", Area::Cache, 0o755).unwrap();
		assert_eq!(made("new", libc::O_WRONLY), Err(libc::ESTALE));
		assert_eq!(a.children(d).map(drop), Err(libc::ESTALE));
		assert_eq!(fs::read_dir(a.disk(Area::Cache, "c/d")).unwrap().count(), 0);
		assert_eq!(fs::read(a.disk(Area::Cache, "c/e").join("x")).unwrap(), b"keep");
		drop((a, b));
		fs::remove_dir_all(&base).unwrap();
	}

	#[test]
	fn a_folder_reached_before_another_program_moved_it_or_put_a_link_or_another_folder_in_its_place_is_walked_to_again() {
		let (a, b, base) = sharing("shared-reached");
		let up = Up::Mount("c".to_string());
		let d = a.mkdir(up.clone(), "d", Area::Cache, 0o755).unwrap().ino.0;
		let made = |name: &str| a.create(Up::Local(d), name, Area::Cache, 0o644, libc::O_WRONLY).map(|(_, fh)| a.release(fh));
		made("x").unwrap();
		// Reached once, so held open: the next use finds it there.
		assert!(a.reached.lock().unwrap().contains_key(&d));
		made("y").unwrap();
		// v2 renames d, which v1's names do not know: v1 walks to it again and finds none.
		b.rename((&up, "d"), (&up, "e"), Area::Cache, false, false, None).unwrap();
		assert_eq!(made("z"), Err(libc::ESTALE));
		assert_eq!(a.entry(Up::Local(d), "x", Area::Cache).map(drop), Err(libc::ESTALE));
		// Back where v1's names say: found there again.
		b.rename((&up, "e"), (&up, "d"), Area::Cache, false, false, None).unwrap();
		made("z").unwrap();
		// A link to a folder outside the caches in its place: never followed.
		let outside = base.join("outside");
		fs::create_dir(&outside).unwrap();
		b.rename((&up, "d"), (&up, "e"), Area::Cache, false, false, None).unwrap();
		b.symlink(up.clone(), "d", Area::Cache, &outside).unwrap();
		assert_eq!(made("w"), Err(libc::ESTALE));
		assert_eq!(a.entry(Up::Local(d), "x", Area::Cache).map(drop), Err(libc::ESTALE));
		assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
		// Another folder in its place: not the one v1's names name.
		fs::remove_file(a.disk(Area::Cache, "c/d")).unwrap();
		b.mkdir(up.clone(), "d", Area::Cache, 0o755).unwrap();
		assert_eq!(made("w"), Err(libc::ESTALE));
		assert_eq!(fs::read_dir(a.disk(Area::Cache, "c/d")).unwrap().count(), 0);
		let mut kept: Vec<_> = fs::read_dir(a.disk(Area::Cache, "c/e")).unwrap().map(|e| e.unwrap().file_name()).collect();
		kept.sort();
		assert_eq!(kept, ["x", "y", "z"]);
		drop((a, b));
		fs::remove_dir_all(&base).unwrap();
	}

	#[test]
	fn another_programs_rename_over_a_name_and_a_cache_move_of_a_file_made_there_meanwhile_lose_nothing() {
		let (a, b, base) = sharing("shared-race");
		let up = Up::Mount("code/o/n/worktrees/w/target".to_string());
		let disk = |name: &str| a.disk(Area::Cache, &format!("code/o/n/worktrees/w/target/{name}"));
		let (_, fh) = b.create(up.clone(), "y", Area::Cache, 0o644, libc::O_WRONLY).unwrap();
		b.write(fh, 0, b"peer").unwrap();
		b.release(fh);
		std::thread::scope(|s| {
			// v2's rename of y over x found no x, and stops before it renames.
			let (mut renaming, mut removing) = (park("rename", &disk("x")), park("remove", &disk("x")));
			let over = s.spawn(|| b.rename((&up, "y"), (&up, "x"), Area::Cache, false, false, None).map(drop));
			assert!(renaming.stopped(Duration::from_secs(10)));
			// v1 makes x, writes it, and its move seals it and takes it off the disk: not before v2's rename is done.
			let mine = s.spawn(|| {
				let (_, fh) = a.create(up.clone(), "x", Area::Cache, 0o644, libc::O_WRONLY | libc::O_EXCL)?;
				a.write(fh, 0, b"mine")?;
				a.release(fh);
				let (_, ino, at) = a.seal_name(&up, "x", Area::Cache, Duration::ZERO)?;
				let out = a.moved_file_out(&at, ino);
				a.unseal(ino);
				out
			});
			let removed = removing.stopped(Duration::from_secs(2));
			renaming.go();
			removing.go();
			assert!(!removed);
			assert_eq!(over.join().unwrap(), Ok(()));
			assert_eq!(mine.join().unwrap(), Err(libc::EEXIST));
		});
		assert_eq!(fs::read(disk("x")).unwrap(), b"peer");
		drop((a, b));
		fs::remove_dir_all(&base).unwrap();
	}

	#[test]
	fn a_file_put_in_place_or_undone_waits_for_another_programs_cache_move() {
		let (a, b, base) = sharing("shared-place");
		let up = Up::Mount("code/o/n/worktrees/w/target".to_string());
		let disk = |name: &str| a.disk(Area::Cache, &format!("code/o/n/worktrees/w/target/{name}"));
		let (_, fh) = b.create(up.clone(), "x", Area::Cache, 0o644, libc::O_WRONLY).unwrap();
		b.write(fh, 0, b"peer").unwrap();
		b.release(fh);
		// v2's move has x: v1's file put in its place waits, and finds it in the folder after (stale).
		let (_, ino) = b.seal(&disk("x")).unwrap();
		std::thread::scope(|s| {
			let sealed = Sealed(&b, ino);
			let placed = s.spawn(|| a.place(&up, "x", Area::Cache, b"mine", false, false).map(drop));
			std::thread::sleep(Duration::from_millis(300));
			assert!(!placed.is_finished());
			assert_eq!(fs::read(disk("x")).unwrap(), b"peer");
			b.moved_file_out(&disk("x"), ino).unwrap();
			drop(sealed);
			assert_eq!(placed.join().unwrap(), Err(libc::ESTALE));
		});
		assert!(!disk("x").exists());
		// A file put in place that v2's move has: its undo waits, and leaves it to the move.
		let placed = a.place(&up, "z", Area::Cache, b"new", false, false).unwrap();
		let (_, ino) = b.seal(&disk("z")).unwrap();
		std::thread::scope(|s| {
			let sealed = Sealed(&b, ino);
			let undone = s.spawn(move || placed.undo());
			std::thread::sleep(Duration::from_millis(300));
			assert!(!undone.is_finished());
			assert_eq!(b.moved_file_out(&disk("z"), ino), Ok(()));
			drop(sealed);
			undone.join().unwrap();
		});
		assert!(!disk("z").exists());
		drop((a, b));
		fs::remove_dir_all(&base).unwrap();
	}

	#[test]
	fn a_change_through_a_handle_reaches_the_file_it_opened_not_one_another_program_renamed_over_it() {
		let (a, b, base) = sharing("shared-setattr");
		let up = Up::Mount("code/o/n/worktrees/w/target".to_string());
		let disk = |name: &str| a.disk(Area::Cache, &format!("code/o/n/worktrees/w/target/{name}"));
		let (x, fh) = a.create(up.clone(), "x", Area::Cache, 0o644, libc::O_RDWR).unwrap();
		a.write(fh, 0, b"old").unwrap();
		let (_, y) = b.create(up.clone(), "y", Area::Cache, 0o644, libc::O_WRONLY).unwrap();
		b.write(y, 0, b"peer").unwrap();
		b.release(y);
		b.rename((&up, "y"), (&up, "x"), Area::Cache, false, false, None).unwrap();
		// v1's ftruncate: its own file, not v2's.
		assert_eq!(a.setattr(x.ino.0, Some(fh), None, Some(0), (None, None)).map(|attr| attr.size), Ok(0));
		assert_eq!(fs::read(disk("x")).unwrap(), b"peer");
		// Without a handle (an fchmod): stale, and v2's file keeps its mode.
		assert_eq!(a.setattr(x.ino.0, None, Some(0o600), None, (None, None)).map(drop), Err(libc::ESTALE));
		assert_eq!(a.getattr(x.ino.0, None).map(drop), Err(libc::ESTALE));
		assert_eq!(a.getattr(x.ino.0, Some(fh)).map(|attr| attr.size), Ok(0));
		assert_eq!(fs::metadata(disk("x")).unwrap().mode() & 0o777, 0o644);
		// A link renamed over it: what it names is never changed.
		let victim = base.join("victim");
		fs::write(&victim, "v").unwrap();
		fs::set_permissions(&victim, fs::Permissions::from_mode(0o644)).unwrap();
		let mtime = fs::metadata(&victim).unwrap().modified().unwrap();
		let (z, zfh) = a.create(up.clone(), "z", Area::Cache, 0o644, libc::O_RDWR).unwrap();
		b.symlink(up.clone(), "s", Area::Cache, &victim).unwrap();
		b.rename((&up, "s"), (&up, "z"), Area::Cache, false, false, None).unwrap();
		let epoch = Some(UNIX_EPOCH);
		assert_eq!(a.setattr(z.ino.0, None, Some(0o666), None, (None, None)).map(drop), Err(libc::ESTALE));
		assert_eq!(a.setattr(z.ino.0, None, None, Some(0), (None, None)).map(drop), Err(libc::ESTALE));
		assert_eq!(a.setattr(z.ino.0, None, None, None, (epoch, epoch)).map(drop), Err(libc::ESTALE));
		assert_eq!(a.readlink(z.ino.0), Err(libc::ESTALE));
		a.setattr(z.ino.0, Some(zfh), None, Some(0), (None, None)).unwrap();
		// Nor by a create at a name a link took meanwhile.
		let made = a.create(up.clone(), "z", Area::Cache, 0o644, libc::O_WRONLY | libc::O_TRUNC);
		assert_eq!(made.map(drop), Err(libc::ELOOP));
		let meta = fs::metadata(&victim).unwrap();
		assert_eq!((fs::read(&victim).unwrap(), meta.mode() & 0o777, meta.modified().unwrap()), (b"v".to_vec(), 0o644, mtime));
		// A link's own times change, never what it names; it has no mode of its own.
		let s = b.symlink(up.clone(), "t", Area::Cache, &victim).unwrap();
		let before = Some(UNIX_EPOCH - Duration::from_millis(1_500));
		let set = b.setattr(s.ino.0, None, None, None, (before, before)).unwrap();
		assert_eq!(set.kind, FileType::Symlink);
		let link = fs::symlink_metadata(disk("t")).unwrap();
		assert_eq!((link.mtime(), link.mtime_nsec(), link.atime()), (-2, 500_000_000, -2));
		assert_eq!(b.setattr(s.ino.0, None, Some(0o600), None, (None, None)).map(drop), Err(libc::EOPNOTSUPP));
		assert_eq!(b.readlink(s.ino.0), Ok(victim.as_os_str().as_bytes().to_vec()));
		assert_eq!(fs::metadata(&victim).unwrap().modified().unwrap(), mtime);
		// Its own file, by name: each change made.
		let (w, wfh) = b.create(up.clone(), "w", Area::Cache, 0o644, libc::O_WRONLY).unwrap();
		b.write(wfh, 0, b"abc").unwrap();
		b.release(wfh);
		let at = Some(UNIX_EPOCH + Duration::from_secs(1_000));
		let set = b.setattr(w.ino.0, None, Some(0o600), Some(1), (at, at)).unwrap();
		assert_eq!((set.perm, set.size, set.mtime), (0o600, 1, at.unwrap()));
		assert_eq!(fs::read(disk("w")).unwrap(), b"a");
		a.release(fh);
		a.release(zfh);
		drop((a, b));
		fs::remove_dir_all(&base).unwrap();
	}

	#[test]
	fn a_link_a_cache_move_reads_while_another_program_exchanges_it_gives_its_own_target() {
		let (a, b, base) = sharing("shared-link");
		let up = Up::Mount("code/o/n/worktrees/w/target".to_string());
		let x = b.symlink(up.clone(), "x", Area::Cache, Path::new("old")).unwrap();
		b.symlink(up.clone(), "y", Area::Cache, Path::new("new")).unwrap();
		let disk = a.disk(Area::Cache, "code/o/n/worktrees/w/target/x");
		std::thread::scope(|s| {
			// In here, so a check that fails lets the read go on (`Parked`), and the test fail.
			let mut parked = park("link", &disk);
			let read = s.spawn(|| a.read_link(&disk));
			assert!(parked.stopped(Duration::from_secs(10)));
			// v2 exchanges x and y between v1's read of x's inode and of its target: v1 has the target of the link whose
			// inode it has, which is the link the move takes off the disk only while it is at x (`moved_file_out`).
			b.rename((&up, "x"), (&up, "y"), Area::Cache, false, true).unwrap();
			parked.go();
			assert_eq!(read.join().unwrap().map(|(target, ino, _)| (target, ino)), Ok((PathBuf::from("old"), x.ino.0)));
		});
		assert_eq!(a.read_link(&disk).map(|(target, ..)| target), Ok(PathBuf::from("new")));
		drop((a, b));
		fs::remove_dir_all(&base).unwrap();
	}

	#[test]
	fn a_link_a_cache_move_read_keeps_its_inode_from_one_another_program_makes_in_its_place() {
		let (a, b, base) = sharing("shared-link-again");
		let up = Up::Mount("code/o/n/worktrees/w/target".to_string());
		b.symlink(up.clone(), "x", Area::Cache, Path::new("old")).unwrap();
		let disk = a.disk(Area::Cache, "code/o/n/worktrees/w/target/x");
		let (target, ino, link) = a.read_link(&disk).unwrap();
		assert_eq!(target, PathBuf::from("old"));
		// While v1's move publishes `old`, v2 removes x and makes it again, over and over. The link v1 holds open is still
		// the one it read, off the disk but not freed, so no other file has its inode: none of v2's links, which the move
		// takes none of off the disk.
		for _ in 0..20 {
			b.unlink(&up, "x", Area::Cache).unwrap();
			let held = link.metadata().unwrap();
			assert_eq!((a.id(Area::Cache, &held), held.nlink()), (Ok(ino), 0));
			let made = b.symlink(up.clone(), "x", Area::Cache, Path::new("new")).unwrap();
			assert_ne!(made.ino.0, ino);
		}
		assert_eq!(a.moved_file_out(&disk, ino), Err(libc::EBUSY));
		drop(link);
		assert_eq!(a.read_link(&disk).map(|(target, ..)| target), Ok(PathBuf::from("new")));
		drop((a, b));
		fs::remove_dir_all(&base).unwrap();
	}

	#[test]
	fn a_seeded_link_is_a_link_on_the_disk_in_place_of_one_an_earlier_seed_left() {
		let (l, dir) = local("seeded-link", "v1");
		let disk = dir.join("git/code/o/n/repo.git/hooks/pre-commit");
		l.put_link("code/o/n/repo.git/hooks/pre-commit", b"/bin/false").unwrap();
		l.put_link("code/o/n/repo.git/hooks/pre-commit", b"../../tools/check").unwrap();
		assert_eq!(fs::read_link(&disk).unwrap(), Path::new("../../tools/check"));
		fs::remove_dir_all(&dir).unwrap();
	}
}
