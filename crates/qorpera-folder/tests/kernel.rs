//! Folder programs sharing one `--cache-dir`, with the kernel cache (MC3a, `deploy/first-node/RUNTIME-FOLDER-MACHINE-CACHES.md`
//! "The kernel cache"): what one program changes in the shared caches, every other one's kernel shows at once. Each
//! program is the CLI in a process of its own, as on a machine: the test switches are its environment, and it can be
//! stopped. Needs root and /dev/fuse, so it runs only when QORPERA_FOLDER_FUSE_TESTS=1, as `tests/mount.rs`.

#[allow(dead_code)]
mod support;

use qorpera_folder::peers::WAIT;
use std::ffi::CString;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, FileExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Barrier};
use std::time::{Duration, Instant};
use support::{FakeNode, PASS};

/// The test switches (`mount/kernel.rs`).
const KERNEL_OFF: &str = "QORPERA_FOLDER_TEST_KERNEL_OFF";
const NOTIFY_FAILS: &str = "QORPERA_FOLDER_TEST_NOTIFY_FAILS";
const NAMES: &str = "QORPERA_FOLDER_TEST_NAMES";
const SLOW_LOOKUP: &str = "QORPERA_FOLDER_TEST_SLOW_LOOKUP";
const SLOW_FALL_BACK: &str = "QORPERA_FOLDER_TEST_SLOW_FALL_BACK";
const CLOSE_GATE: &str = "QORPERA_FOLDER_TEST_CLOSE_GATE";
const LATE_CREATE: &str = "QORPERA_FOLDER_TEST_LATE_CREATE";
/// The end's drop, its gate closed (`CLOSE_GATE`).
const DROP_WAITS: &str = "qorpera-folder: test switch: the drop waits for";
/// A cache top in a node folder (a dependency folder is a cache anywhere, `cache.rs`), and files in it.
const TOP: &str = "notes/node_modules";
const X: &str = "notes/node_modules/x.js";
const Y: &str = "notes/node_modules/y.js";

fn wanted() -> bool {
	if std::env::var("QORPERA_FOLDER_FUSE_TESTS").as_deref() == Ok("1") {
		return true;
	}
	eprintln!("skipped: set QORPERA_FOLDER_FUSE_TESTS=1 (as root, with /dev/fuse) to mount for real");
	false
}

/// Waits until `check` holds, for at most `limit`.
fn eventually(limit: Duration, mut check: impl FnMut() -> bool) -> bool {
	let start = Instant::now();
	while start.elapsed() < limit {
		if check() {
			return true;
		}
		std::thread::sleep(Duration::from_millis(20));
	}
	check()
}

fn mounted(path: &Path) -> bool {
	std::fs::read_to_string("/proc/self/mountinfo").unwrap().lines().any(|l| l.split(' ').nth(4) == Some(path.to_str().unwrap()))
}

fn names(dir: &Path) -> Vec<String> {
	let mut out: Vec<String> =
		std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
	out.sort();
	out
}

/// The cache folder every program on `node` shares.
fn caches(node: &FakeNode) -> PathBuf {
	let dir = node.dir.join("caches");
	match std::fs::DirBuilder::new().mode(0o700).create(&dir) {
		Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => panic!("{}: {e}", dir.display()),
		_ => dir,
	}
}

/// Where the file `name` in `TOP` is on the machine's disk, in the mirror of the node's folders (`local.rs`).
fn disk(node: &FakeNode, name: &str) -> PathBuf {
	caches(node).join("caches/d/notes/t/node_modules").join(name)
}

fn view(node: &FakeNode) -> PathBuf {
	let view = node.dir.join("view.json");
	if !view.exists() {
		let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&view).unwrap();
		write!(file, "{{\"environmentId\":\"env\",\"viewId\":\"view\",\"pass\":\"{PASS}\"}}").unwrap();
	}
	view
}

/// One folder program: the CLI mounting `node`'s view at a mountpoint and with a state of its own, its caches in the
/// cache folder the programs on `node` share, its log in a file.
struct Program {
	child: Child,
	mountpoint: PathBuf,
	log: PathBuf,
}

impl Program {
	/// Starts it with the test switches `env`, and waits until its kernel cache is on or off.
	fn start(node: &FakeNode, name: &str, env: &[(&str, &str)]) -> Program {
		let mountpoint = node.dir.join(name);
		std::fs::create_dir(&mountpoint).unwrap();
		let log = node.dir.join(format!("{name}.log"));
		let child = Command::new(env!("CARGO_BIN_EXE_qorpera-folder"))
			.arg("mount").arg("--view-file").arg(view(node)).arg("--mountpoint").arg(&mountpoint)
			.arg("--connect").arg(&node.addr).arg("--state-dir").arg(node.dir.join(format!("{name}.state")))
			.arg("--cache-dir").arg(caches(node))
			.env_remove(KERNEL_OFF).env_remove(NOTIFY_FAILS).env_remove(NAMES).env_remove(SLOW_LOOKUP).env_remove(SLOW_FALL_BACK)
			.env_remove(CLOSE_GATE).env_remove(LATE_CREATE)
			.envs(env.iter().copied())
			.stdout(Stdio::null()).stderr(File::create(&log).unwrap())
			.spawn().unwrap();
		let program = Program { child, mountpoint, log };
		let decided = || {
			let log = program.logged();
			mounted(&program.mountpoint) && (log.contains("qorpera-folder: kernel cache on") || log.contains("qorpera-folder: kernel cache off"))
		};
		assert!(eventually(Duration::from_secs(10), decided), "{name} did not mount: {}", program.logged());
		program
	}

	fn at(&self, path: &str) -> PathBuf {
		self.mountpoint.join(path)
	}

	fn logged(&self) -> String {
		std::fs::read_to_string(&self.log).unwrap_or_default()
	}

	fn signal(&self, sig: i32) {
		// SAFETY: kill has no preconditions; the child is not reaped while `self` lives.
		assert_eq!(unsafe { libc::kill(self.child.id() as i32, sig) }, 0);
	}

	/// Its socket in the programs folder (`peers.rs`).
	fn socket(&self, node: &FakeNode) -> PathBuf {
		let programs = caches(node).join("programs");
		let own = format!("{}.", self.child.id());
		let name = names(&programs).into_iter().find(|n| n.starts_with(&own)).expect("the program's socket");
		programs.join(name)
	}

	fn len(&self, path: &str) -> u64 {
		std::fs::metadata(self.at(path)).unwrap().len()
	}

	fn read(&self, path: &str) -> String {
		std::fs::read_to_string(self.at(path)).unwrap()
	}
}

impl Drop for Program {
	/// A program a failed test left running is killed, and its mount taken down.
	fn drop(&mut self) {
		if self.child.try_wait().ok().flatten().is_none() {
			let _ = self.child.kill();
			let _ = self.child.wait();
		}
		if mounted(&self.mountpoint) {
			let c = CString::new(self.mountpoint.to_str().unwrap()).unwrap();
			// SAFETY: a path from CString.
			unsafe { libc::umount2(c.as_ptr(), libc::MNT_DETACH) };
		}
	}
}

/// The view ends: every program stops as at a view's end (exit 3).
fn closed(node: &FakeNode, programs: Vec<Program>) {
	node.close_view();
	for mut p in programs {
		let ended = eventually(Duration::from_secs(10), || p.child.try_wait().unwrap().is_some());
		assert!(ended, "a program did not stop: {}", p.logged());
		assert_eq!(p.child.wait().unwrap().code(), Some(3), "{}", p.logged());
	}
}

/// What a read through `file` from its start gives.
fn read_at(file: &File) -> String {
	let mut buf = [0; 64];
	let n = file.read_at(&mut buf, 0).unwrap();
	String::from_utf8(buf[..n].to_vec()).unwrap()
}

/// Two programs on one cache folder, each with the kernel cache on.
fn two(node: &FakeNode) -> (Program, Program) {
	two_with(node, &[])
}

/// Two programs on one cache folder, each with the kernel cache on, the second with the test switches `env`.
fn two_with(node: &FakeNode, env: &[(&str, &str)]) -> (Program, Program) {
	let two = (Program::start(node, "a", &[]), Program::start(node, "b", env));
	for p in [&two.0, &two.1] {
		assert!(p.logged().contains("qorpera-folder: kernel cache on"), "{}", p.logged());
	}
	two
}

#[test]
fn a_cache_folder_others_could_use_is_refused() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	let open = node.dir.join("open");
	std::fs::DirBuilder::new().mode(0o755).create(&open).unwrap();
	std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o755)).unwrap();
	let mountpoint = node.dir.join("company");
	std::fs::create_dir(&mountpoint).unwrap();
	let out = Command::new(env!("CARGO_BIN_EXE_qorpera-folder"))
		.arg("mount").arg("--view-file").arg(view(&node)).arg("--mountpoint").arg(&mountpoint)
		.arg("--connect").arg(&node.addr).arg("--state-dir").arg(node.dir.join("state")).arg("--cache-dir").arg(&open)
		.output().unwrap();
	let said = String::from_utf8_lossy(&out.stderr);
	assert_eq!(out.status.code(), Some(1), "{said}");
	assert!(said.contains("FOLDER_CACHE_DIR_UNUSABLE"), "{said}");
	assert!(!mounted(&mountpoint));
}

#[test]
fn the_kernel_cache_is_on_only_where_the_start_up_check_allows_it() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("notes/readme", "readme", false);
	let a = Program::start(&node, "a", &[]);
	let b = Program::start(&node, "b", &[(KERNEL_OFF, "no epoch notify")]);
	assert!(a.logged().contains("qorpera-folder: kernel cache on"), "{}", a.logged());
	assert!(b.logged().contains("qorpera-folder: kernel cache off: no epoch notify (test switch)"), "{}", b.logged());
	std::fs::create_dir(a.at(TOP)).unwrap();
	std::fs::write(a.at(X), "one").unwrap();
	for p in [&a, &b, &a, &b] {
		assert_eq!(p.len(X), 3);
	}
	// Changed behind every program's back (only the programs change the cache folder): a kernel that keeps the
	// attributes answers from them, one without asks every time.
	OpenOptions::new().append(true).open(disk(&node, "x.js")).unwrap().write_all(b"two").unwrap();
	assert_eq!(b.len(X), 6, "b's kernel asked");
	assert_eq!(a.len(X), 3, "a's kernel answered from what it keeps");
	// A program without the kernel cache tells all the same: b's change reaches a's kernel before b's write returns.
	std::fs::write(b.at(X), "three").unwrap();
	assert_eq!((a.len(X), a.read(X).as_str()), (5, "three"));
	closed(&node, vec![a, b]);
}

#[test]
fn what_one_program_changes_in_the_shared_caches_another_shows_at_once() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("notes/readme", "readme", false);
	let (a, b) = two(&node);
	// Names b looked up before a made them: the kernel keeps absent names too.
	assert!(!b.at(TOP).exists());
	std::fs::create_dir(a.at(TOP)).unwrap();
	assert!(b.at(TOP).is_dir(), "the cache top a made");
	assert!(!b.at(Y).exists());
	std::fs::write(a.at(X), "one").unwrap();
	std::fs::write(a.at(Y), "why").unwrap();
	assert_eq!(b.read(Y), "why", "a name b looked up before a made it");
	// b reads x twice, so its kernel keeps the pages, and holds it open.
	assert_eq!((b.read(X), b.read(X)), ("one".to_string(), "one".to_string()));
	let held = File::open(b.at(X)).unwrap();
	assert_eq!(read_at(&held), "one");

	// Written again through a handle a holds, at the same size.
	let writer = OpenOptions::new().write(true).open(a.at(X)).unwrap();
	writer.write_all_at(b"two", 0).unwrap();
	assert_eq!(read_at(&held), "two", "a read through b's held handle");
	assert_eq!(b.read(X), "two", "b opens it again");
	// Truncated and longer, then cut short; its mode.
	std::fs::write(a.at(X), "three!").unwrap();
	assert_eq!((b.len(X), read_at(&held).as_str()), (6, "three!"));
	writer.set_len(2).unwrap();
	assert_eq!((b.len(X), b.read(X).as_str(), read_at(&held).as_str()), (2, "th", "th"));
	std::fs::set_permissions(a.at(X), std::fs::Permissions::from_mode(0o600)).unwrap();
	assert_eq!(std::fs::metadata(b.at(X)).unwrap().permissions().mode() & 0o777, 0o600);
	drop(writer);

	// Renamed over a name b knows: the moved file under its new name, nothing under its old one; b's handle follows it.
	std::fs::rename(a.at(X), a.at(Y)).unwrap();
	assert!(!b.at(X).exists());
	assert_eq!((b.read(Y).as_str(), read_at(&held).as_str()), ("th", "th"));
	drop(held);
	std::fs::remove_file(a.at(Y)).unwrap();
	assert!(!b.at(Y).exists());

	// Folders, links and hard links.
	let pkg = "notes/node_modules/pkg";
	std::fs::create_dir(a.at(pkg)).unwrap();
	assert!(b.at(pkg).is_dir());
	std::fs::write(a.at("notes/node_modules/pkg/i.js"), "index").unwrap();
	std::os::unix::fs::symlink("i.js", a.at("notes/node_modules/pkg/l.js")).unwrap();
	std::fs::hard_link(a.at("notes/node_modules/pkg/i.js"), a.at("notes/node_modules/pkg/h.js")).unwrap();
	assert_eq!(std::fs::read_link(b.at("notes/node_modules/pkg/l.js")).unwrap(), Path::new("i.js"));
	assert_eq!(b.read("notes/node_modules/pkg/h.js"), "index");
	assert_eq!(names(&b.at(pkg)), ["h.js", "i.js", "l.js"]);
	for name in ["h.js", "i.js", "l.js"] {
		std::fs::remove_file(a.at(&format!("{pkg}/{name}"))).unwrap();
	}
	std::fs::remove_dir(a.at(pkg)).unwrap();
	assert!(!b.at(pkg).exists());
	assert!(names(&b.at(TOP)).is_empty());
	// The top itself goes.
	std::fs::remove_dir(a.at(TOP)).unwrap();
	assert!(!b.at(TOP).exists());
	assert_eq!(names(&b.at("notes")), ["readme"]);
	closed(&node, vec![a, b]);
}

/// A truncate, a mode and times through a handle reach the file it has open: not what another program renamed over its
/// name, and never what a link renamed there names, a file on the machine outside every cache.
#[test]
fn a_change_through_a_handle_never_reaches_what_a_link_another_program_renamed_over_it_names() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("notes/readme", "readme", false);
	let (a, b) = two(&node);
	let victim = node.dir.join("victim");
	std::fs::write(&victim, "host").unwrap();
	std::fs::set_permissions(&victim, std::fs::Permissions::from_mode(0o644)).unwrap();
	let mtime = std::time::UNIX_EPOCH + Duration::from_secs(1_000_000);
	File::options().write(true).open(&victim).unwrap().set_modified(mtime).unwrap();
	std::fs::create_dir(a.at(TOP)).unwrap();
	std::fs::write(a.at(X), "mine").unwrap();
	let held = OpenOptions::new().read(true).write(true).open(a.at(X)).unwrap();
	std::os::unix::fs::symlink(&victim, b.at(Y)).unwrap();
	std::fs::rename(b.at(Y), b.at(X)).unwrap();
	// An ftruncate carries the handle: the file a has open is cut short.
	held.set_len(1).unwrap();
	assert_eq!(read_at(&held), "m");
	// An fchmod and a futimens carry none: the name is another file now, so neither is made.
	let _ = held.set_permissions(std::fs::Permissions::from_mode(0o666));
	let _ = held.set_times(std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH).set_accessed(std::time::UNIX_EPOCH));
	let meta = std::fs::metadata(&victim).unwrap();
	let host = (std::fs::read_to_string(&victim).unwrap(), meta.permissions().mode() & 0o777, meta.modified().unwrap());
	assert_eq!(host, ("host".to_string(), 0o644, mtime));
	drop(held);
	closed(&node, vec![a, b]);
}

/// A cache folder another program renamed and put a link to a folder on the machine in the place of, before this
/// program heard of it: an open through a folder held open from before reaches nothing past the link, neither a file
/// there nor a new one.
#[test]
fn an_open_in_a_held_cache_folder_never_reaches_past_a_link_another_program_put_in_its_place() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("notes/readme", "readme", false);
	let (a, b) = two(&node);
	std::fs::create_dir(b.at(TOP)).unwrap();
	std::fs::create_dir(b.at(&format!("{TOP}/d"))).unwrap();
	let held = File::open(a.at(&format!("{TOP}/d"))).unwrap();
	let host = node.dir.join("host");
	std::fs::create_dir(&host).unwrap();
	std::fs::write(host.join("x"), "host bytes").unwrap();
	// Behind every program's back, as b's swap lands while a is in the middle of an open there: a's names still
	// have `d` the folder it holds.
	std::fs::rename(disk(&node, "d"), disk(&node, "e")).unwrap();
	std::os::unix::fs::symlink(&host, disk(&node, "d")).unwrap();
	let opened = |name: &str, flags: i32| open_in(&held, name, flags | libc::O_WRONLY | libc::O_CREAT);
	assert!(opened("x", libc::O_TRUNC).is_err());
	assert!(opened("y", 0).is_err());
	assert_eq!(std::fs::read_to_string(host.join("x")).unwrap(), "host bytes");
	assert!(!host.join("y").exists());
	drop(held);
	closed(&node, vec![a, b]);
}

/// `openat` of `name` in the folder `dir` holds open, with `flags` (and a mode for a file it makes); closed at once.
fn open_in(dir: &File, name: &str, flags: i32) -> std::io::Result<()> {
	let name = CString::new(name).unwrap();
	// SAFETY: an open fd, a C string, and a mode.
	let fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags | libc::O_CLOEXEC, 0o644 as libc::c_uint) };
	if fd < 0 {
		return Err(std::io::Error::last_os_error());
	}
	// SAFETY: the descriptor just opened, closed once.
	unsafe { libc::close(fd) };
	Ok(())
}

/// A program's epoch rises only for a name its kernel may hold (`Kernel::hold`). Each of the next tests changes one name
/// after the other program's kernel took it, with no other change told in between, so only that name's hold can make
/// the other program show the change at once.
#[test]
fn a_name_looked_up_absent_that_another_program_makes_shows_at_once() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("notes/readme", "readme", false);
	let (a, b) = two(&node);
	std::fs::create_dir(a.at(TOP)).unwrap();
	std::fs::write(a.at(X), "x").unwrap();
	assert_eq!(b.read(X), "x");
	assert!(!b.at(Y).exists());
	// Made behind every program's back: b's kernel keeps the name absent.
	std::fs::write(disk(&node, "y.js"), "behind").unwrap();
	assert!(!b.at(Y).exists(), "b's kernel keeps the absent name");
	std::fs::remove_file(disk(&node, "y.js")).unwrap();
	std::fs::write(a.at(Y), "why").unwrap();
	assert_eq!(b.read(Y), "why", "a name b's kernel kept absent");
	closed(&node, vec![a, b]);
}

/// A listing hands the kernel no names nor attributes (the program does not take `READDIRPLUS`), so none needs holding.
/// This fails if listings start to hand them out unheld.
#[test]
fn a_listing_hands_the_kernel_nothing_a_change_must_drop() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("notes/readme", "readme", false);
	let (a, b) = two(&node);
	std::fs::create_dir(a.at(TOP)).unwrap();
	std::fs::write(a.at(X), "x").unwrap();
	std::fs::write(a.at(Y), "why").unwrap();
	assert_eq!(names(&b.at(TOP)), ["x.js", "y.js"]);
	// Changed behind every program's back: b's kernel asks, as it holds nothing of x from the listing.
	OpenOptions::new().append(true).open(disk(&node, "x.js")).unwrap().write_all(b"more").unwrap();
	assert_eq!(b.len(X), 5);
	// A name b listed and a removes.
	std::fs::remove_file(a.at(Y)).unwrap();
	assert_eq!(std::fs::metadata(b.at(Y)).unwrap_err().raw_os_error(), Some(libc::ENOENT));
	assert_eq!(names(&b.at(TOP)), ["x.js"]);
	closed(&node, vec![a, b]);
}

/// b's lookup reads the disk before a makes the name and answers after a's create returned: the name was held from
/// before the read, so a's create raised b's epoch, and b's kernel takes the answer as stale; b's next look shows it.
#[test]
fn a_lookup_answered_after_another_programs_create_is_not_kept_absent() {
	if !wanted() {
		return;
	}
	const LATE: &str = "notes/node_modules/late.js";
	let node = FakeNode::writable();
	node.put("notes/readme", "readme", false);
	let (a, b) = two_with(&node, &[(SLOW_LOOKUP, "late.js")]);
	std::fs::create_dir(a.at(TOP)).unwrap();
	assert!(b.at(TOP).is_dir());
	let looking = {
		let path = b.at(LATE);
		std::thread::spawn(move || path.exists())
	};
	let waits = "qorpera-folder: test switch: a lookup of late.js read the disk and waits";
	assert!(eventually(Duration::from_secs(10), || b.logged().contains(waits)), "{}", b.logged());
	std::fs::write(a.at(LATE), "late").unwrap();
	assert!(!looking.join().unwrap(), "b's lookup read the disk before a's create");
	assert_eq!(b.read(LATE), "late", "the answer that came after a's create");
	closed(&node, vec![a, b]);
}

/// b's lookup finds a name on the disk and answers after a removed it: the name was held from before the read, so a's
/// removal raised b's epoch, and b's kernel takes the answer as stale. The inode a told was not yet in b's kernel, so
/// only the name's hold shows it gone at once.
#[test]
fn a_lookup_answered_after_another_program_removes_the_name_is_not_kept() {
	if !wanted() {
		return;
	}
	const GONE: &str = "notes/node_modules/gone.js";
	let node = FakeNode::writable();
	node.put("notes/readme", "readme", false);
	let (a, b) = two_with(&node, &[(SLOW_LOOKUP, "gone.js")]);
	std::fs::create_dir(a.at(TOP)).unwrap();
	std::fs::write(a.at(GONE), "gone").unwrap();
	assert!(b.at(TOP).is_dir());
	let looking = {
		let path = b.at(GONE);
		std::thread::spawn(move || path.exists())
	};
	let waits = "qorpera-folder: test switch: a lookup of gone.js read the disk and waits";
	assert!(eventually(Duration::from_secs(10), || b.logged().contains(waits)), "{}", b.logged());
	std::fs::remove_file(a.at(GONE)).unwrap();
	assert!(looking.join().unwrap(), "b's lookup read the disk before a's removal");
	assert_eq!(std::fs::metadata(b.at(GONE)).unwrap_err().raw_os_error(), Some(libc::ENOENT));
	closed(&node, vec![a, b]);
}

/// b holds two names at most: the third drops every name and raises its epoch, so a name it let go of that its kernel
/// kept absent shows at once when a makes it; a name still held does too.
#[test]
fn a_full_table_of_names_drops_every_name_the_kernel_holds() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("notes/readme", "readme", false);
	let (a, b) = two_with(&node, &[(NAMES, "2")]);
	std::fs::create_dir(a.at(TOP)).unwrap();
	assert!(b.at(TOP).is_dir());
	let n = |i: usize| format!("{TOP}/n{i}.js");
	for i in 0..4 {
		assert!(!b.at(&n(i)).exists());
	}
	std::fs::write(a.at(&n(0)), "zero").unwrap();
	assert_eq!(b.read(&n(0)), "zero", "a name the full table let go of");
	std::fs::write(a.at(&n(3)), "three").unwrap();
	assert_eq!(b.read(&n(3)), "three", "a name still held");
	assert!(!b.logged().contains("kernel cache off"), "{}", b.logged());
	closed(&node, vec![a, b]);
}

/// a renames a folder in the caches whose path b walked: b shows the old path gone and the new one, at once (the
/// folder's inode, told too, also has b's kernel ask for it, and b finds it at its old name no more). Then a renames one
/// b never walked onto a name b has only seen absent: only the new name's hold can drop it.
#[test]
fn a_folder_another_program_renames_under_a_walked_path_moves_at_once() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("notes/readme", "readme", false);
	let (a, b) = two(&node);
	let (d, e) = ("notes/node_modules/d", "notes/node_modules/e");
	std::fs::create_dir(a.at(TOP)).unwrap();
	std::fs::create_dir(a.at(d)).unwrap();
	std::fs::write(a.at("notes/node_modules/d/f.js"), "f").unwrap();
	assert_eq!(b.read("notes/node_modules/d/f.js"), "f");
	std::fs::rename(a.at(d), a.at(e)).unwrap();
	assert_eq!(std::fs::metadata(b.at("notes/node_modules/d/f.js")).unwrap_err().raw_os_error(), Some(libc::ENOENT));
	assert!(!b.at(d).exists());
	assert_eq!(b.read("notes/node_modules/e/f.js"), "f");
	let (g, h) = ("notes/node_modules/g", "notes/node_modules/h");
	std::fs::create_dir(a.at(g)).unwrap();
	std::fs::write(a.at("notes/node_modules/g/f.js"), "g").unwrap();
	assert!(!b.at(h).exists());
	std::fs::rename(a.at(g), a.at(h)).unwrap();
	assert_eq!(b.read("notes/node_modules/h/f.js"), "g");
	closed(&node, vec![a, b]);
}

/// A folder of the node's that one program renames takes its caches along, and every other program forgets them before
/// the rename returns: the node tells it of the rename only later.
#[test]
fn a_folder_one_program_renames_moves_its_caches_in_every_program_at_once() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("notes/readme", "readme", false);
	let (a, b) = two(&node);
	let (from, to) = ("notes/a/node_modules/x.js", "notes/b/node_modules/x.js");
	std::fs::create_dir_all(a.at("notes/a/node_modules")).unwrap();
	std::fs::write(a.at(from), "one").unwrap();
	assert_eq!(b.read(from), "one");
	std::fs::rename(a.at("notes/a"), a.at("notes/b")).unwrap();
	// b's kernel holds the folder's name for the TTL unless b is told.
	for gone in ["notes/a/node_modules", from] {
		assert!(!b.at(gone).exists(), "b's kernel kept {gone} where it was");
	}
	node.tell(&["notes/a", "notes/b"]);
	assert_eq!((a.read(to), b.read(to)), ("one".to_string(), "one".to_string()));
	closed(&node, vec![a, b]);
}

/// A change to a name b's kernel was never handed raises no epoch in b: b keeps what its kernel holds (here a name it
/// kept absent, which was made behind every program's back).
#[test]
fn a_change_to_a_name_a_kernel_never_held_keeps_what_it_holds() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("notes/readme", "readme", false);
	let (a, b) = two(&node);
	std::fs::create_dir(a.at(TOP)).unwrap();
	assert!(!b.at(Y).exists());
	std::fs::write(disk(&node, "y.js"), "behind").unwrap();
	for i in 0..10 {
		let name = format!("{TOP}/churn{i}.js");
		std::fs::write(a.at(&name), "c").unwrap();
		std::fs::remove_file(a.at(&name)).unwrap();
	}
	assert!(!b.at(Y).exists(), "b's kernel still keeps the absent name");
	// A change to the name itself drops it.
	std::fs::remove_file(disk(&node, "y.js")).unwrap();
	std::fs::write(a.at(Y), "why").unwrap();
	assert_eq!(b.read(Y), "why");
	closed(&node, vec![a, b]);
}

#[test]
fn a_file_crossing_the_edge_of_the_shared_caches_leaves_no_name_behind() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("notes/readme", "readme", false);
	let (a, b) = two(&node);
	std::fs::create_dir(a.at(TOP)).unwrap();
	std::fs::write(a.at(X), "cached").unwrap();
	assert_eq!(b.read(X), "cached");
	// Out of the caches into the folder: the name b's kernel kept goes at once, and b's feed brings the published file.
	std::fs::rename(a.at(X), a.at("notes/x.js")).unwrap();
	assert!(!b.at(X).exists());
	assert_eq!(node.content("notes/x.js").unwrap(), b"cached");
	node.tell(&["notes/x.js"]);
	assert!(eventually(Duration::from_secs(10), || b.at("notes/x.js").exists()));
	assert_eq!(b.read("notes/x.js"), "cached");
	// A file a made and no boundary published (so no feed told b of it), into the caches: b shows it there at once.
	assert!(!b.at("notes/node_modules/out.js").exists());
	std::fs::write(a.at("notes/out.tmp"), "built").unwrap();
	std::fs::rename(a.at("notes/out.tmp"), a.at("notes/node_modules/out.js")).unwrap();
	assert_eq!(b.read("notes/node_modules/out.js"), "built");
	assert!(!node.exists("notes/out.tmp"));
	node.tell(&["notes/out.tmp"]);
	assert!(eventually(Duration::from_secs(10), || !b.at("notes/out.tmp").exists()));
	// Another view publishes a node_modules here: the node's entry wins in both (rule 1), and the cache goes.
	std::fs::write(b.at(X), "cached").unwrap();
	assert_eq!(a.read(X), "cached");
	node.put("notes/node_modules/y", "published", false);
	for p in [&a, &b] {
		assert!(eventually(Duration::from_secs(10), || names(&p.at(TOP)) == ["y"]), "{:?}", names(&p.at(TOP)));
		assert!(!p.at(X).exists());
	}
	closed(&node, vec![a, b]);
}

#[test]
fn an_open_keeps_the_kernels_pages_only_of_a_file_as_it_was() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("notes/readme", "readme", false);
	let (a, b) = two(&node);
	std::fs::create_dir(a.at(TOP)).unwrap();
	std::fs::write(a.at(X), "aaaa").unwrap();
	assert_eq!((b.read(X), b.read(X)), ("aaaa".to_string(), "aaaa".to_string()));
	// Changed on the disk behind every program's back, at the same size (as a program that stopped before it told
	// would leave it): b's next open reads it again.
	std::fs::write(disk(&node, "x.js"), "bbbb").unwrap();
	assert_eq!(b.read(X), "bbbb");
	// An inode number the disk gives again: a removes x and makes y of the same size.
	assert_eq!(b.read(X), "bbbb");
	std::fs::remove_file(a.at(X)).unwrap();
	std::fs::write(a.at(Y), "cccc").unwrap();
	assert_eq!(b.read(Y), "cccc");
	closed(&node, vec![a, b]);
}

#[test]
fn a_told_change_whose_notify_fails_turns_the_kernel_cache_off() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("notes/readme", "readme", false);
	let a = Program::start(&node, "a", &[]);
	let b = Program::start(&node, "b", &[(NOTIFY_FAILS, "1")]);
	assert!(b.logged().contains("qorpera-folder: kernel cache on"), "{}", b.logged());
	// b's own files, which its kernel keeps.
	std::fs::create_dir(b.at(TOP)).unwrap();
	std::fs::write(b.at(X), "one").unwrap();
	assert_eq!((b.read(X), b.read(X), b.len(X)), ("one".to_string(), "one".to_string(), 3));
	// a's change: b's notify fails, so b drops all its kernel holds, and answers.
	std::fs::write(a.at(X), "two!").unwrap();
	let log = b.logged();
	assert!(log.contains("qorpera-folder: kernel cache off: a told change's notify failed: test switch"), "{log}");
	assert!(log.contains("qorpera-folder: kernel cache: dropped what the kernel held"), "{log}");
	assert_eq!((b.len(X), b.read(X).as_str()), (4, "two!"));
	// Off from then on: b's kernel asks every time.
	std::fs::write(disk(&node, "x.js"), "three").unwrap();
	assert_eq!(b.len(X), 5);
	closed(&node, vec![a, b]);
}

#[test]
fn a_program_that_does_not_answer_fails_the_change_in_time_and_turns_its_kernel_cache_off() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("notes/readme", "readme", false);
	let (a, b) = two(&node);
	std::fs::create_dir(a.at(TOP)).unwrap();
	std::fs::write(a.at(X), "one").unwrap();
	assert_eq!((b.read(X), b.read(X)), ("one".to_string(), "one".to_string()));
	// b stops answering: a's change fails once a has waited for it, and a's mount still answers.
	b.signal(libc::SIGSTOP);
	let started = Instant::now();
	let failed = std::fs::write(a.at(X), "two!").unwrap_err();
	let took = started.elapsed();
	assert_eq!(failed.raw_os_error(), Some(libc::EIO), "{failed}");
	assert!(took >= WAIT - Duration::from_secs(1) && took < WAIT + Duration::from_secs(10), "{took:?}");
	assert!(a.logged().contains("qorpera-folder: telling the other programs on the cache folder"), "{}", a.logged());
	assert!(a.at(X).exists());
	// b goes on: it hears the change late, and as its kernel may have answered stale meanwhile, turns the cache off.
	b.signal(libc::SIGCONT);
	let late = "qorpera-folder: kernel cache off: a change was told later than the teller waits";
	// Logged once the drop is done, after the line that turned it off.
	let dropped = "qorpera-folder: kernel cache: dropped what the kernel held";
	assert!(eventually(Duration::from_secs(10), || b.logged().contains(dropped)), "{}", b.logged());
	assert!(b.logged().contains(late), "{}", b.logged());
	assert_eq!(std::fs::read(b.at(X)).unwrap(), std::fs::read(disk(&node, "x.js")).unwrap());
	// Changes go through again, and b shows them.
	let started = Instant::now();
	std::fs::write(a.at(X), "three").unwrap();
	assert!(started.elapsed() < Duration::from_secs(2), "{:?}", started.elapsed());
	assert_eq!(b.read(X), "three");
	closed(&node, vec![a, b]);
}

#[test]
fn a_change_told_while_a_fallback_drops_what_the_kernel_holds_is_answered_after_the_drop() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("notes/readme", "readme", false);
	let a = Program::start(&node, "a", &[]);
	let b = Program::start(&node, "b", &[(SLOW_FALL_BACK, "1")]);
	assert!(b.logged().contains("qorpera-folder: kernel cache on"), "{}", b.logged());
	std::fs::create_dir(a.at(TOP)).unwrap();
	std::fs::write(a.at(X), "one").unwrap();
	assert_eq!((b.len(X), b.len(X)), (3, 3), "b's kernel keeps the attributes");
	// A change told long ago: b turns its kernel cache off, and waits before it drops what its kernel holds.
	let mut late = UnixStream::connect(b.socket(&node)).unwrap();
	late.write_all(b"{\"seq\":1,\"at\":1,\"dir\":\"notes\",\"name\":\"zz\"}\n").unwrap();
	let off = "qorpera-folder: kernel cache off: a change was told later than the teller waits";
	let dropped = "qorpera-folder: kernel cache: dropped what the kernel held";
	assert!(eventually(Duration::from_secs(10), || b.logged().contains(off)), "{}", b.logged());
	assert!(!b.logged().contains(dropped), "{}", b.logged());
	// a's change meanwhile: b answers it once the drop is done, so a's write returns with b's kernel holding nothing.
	std::fs::write(a.at(X), "two!").unwrap();
	assert_eq!(b.len(X), 4);
	assert!(eventually(Duration::from_secs(10), || b.logged().contains(dropped)), "{}", b.logged());
	drop(late);
	closed(&node, vec![a, b]);
}

#[test]
fn a_message_that_is_no_change_drops_all_the_kernel_holds() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("notes/readme", "readme", false);
	let (a, b) = two(&node);
	std::fs::create_dir(a.at(TOP)).unwrap();
	std::fs::write(a.at(X), "one").unwrap();
	assert_eq!((b.len(X), b.len(X)), (3, 3));
	OpenOptions::new().append(true).open(disk(&node, "x.js")).unwrap().write_all(b"two").unwrap();
	assert_eq!(b.len(X), 3, "b's kernel keeps the attributes");
	// Not a change: it goes unanswered, and b's kernel drops all it holds.
	let mut stream = UnixStream::connect(b.socket(&node)).unwrap();
	stream.write_all(b"no change\n").unwrap();
	let mut rest = Vec::new();
	stream.read_to_end(&mut rest).unwrap();
	assert!(rest.is_empty());
	let log = b.logged();
	assert!(log.contains("qorpera-folder: kernel cache: a malformed message from another program: no change"), "{log}");
	assert_eq!(b.len(X), 6, "b's kernel asked again");
	// A number to answer but no change: answered all the same.
	let mut stream = BufReader::new(UnixStream::connect(b.socket(&node)).unwrap());
	stream.get_mut().write_all(b"{\"seq\":7,\"at\":1}\n").unwrap();
	let mut answer = String::new();
	stream.read_line(&mut answer).unwrap();
	assert_eq!(answer, "{\"seq\":7}\n");
	// The kernel cache stays on, and changes still reach b.
	assert!(!b.logged().contains("kernel cache off"), "{}", b.logged());
	std::fs::write(a.at(X), "three").unwrap();
	assert_eq!(b.read(X), "three");
	closed(&node, vec![a, b]);
}

#[test]
fn the_node_files_a_program_reads_are_still_handed_over() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("notes/readme", "readme", false);
	let (a, b) = two(&node);
	assert_eq!((a.read("notes/readme"), b.read("notes/readme")), ("readme".to_string(), "readme".to_string()));
	// Cache files are no node files: their reads are not the machine's to hand over.
	std::fs::create_dir(a.at(TOP)).unwrap();
	std::fs::write(a.at(X), "cached").unwrap();
	assert_eq!((a.read(X), b.read(X)), ("cached".to_string(), "cached".to_string()));
	std::fs::write(a.at("notes/out.md"), "out").unwrap();
	assert_eq!(node.logged(), [("notes/readme".to_string(), Some("v1".to_string()))]);
	closed(&node, vec![a, b]);
}

/// What the kernel does with a shared mapping of a cache file: a write through it reaches the other programs shortly
/// after writeback (told without waiting, as its pages wait for the reply), and a mapping in another program shows a
/// change shortly after its pages drop. Neither is ordered with the write's return, `msync` or `fsync` (the plan's known
/// limit); a read, a stat, an open and a read through a held fd show a change at once.
#[test]
fn a_shared_mapping_of_a_cache_file_shows_changes_shortly_after() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("notes/readme", "readme", false);
	let (a, b) = two(&node);
	std::fs::create_dir(a.at(TOP)).unwrap();
	std::fs::write(a.at(X), [b'a'; 4096]).unwrap();
	let held = File::open(b.at(X)).unwrap();
	assert_eq!(read_at(&held), "a".repeat(64));
	// A write through a mapping in a: b's held fd shows it once a's writeback is told.
	{
		let file = OpenOptions::new().read(true).write(true).open(a.at(X)).unwrap();
		let map = Mapping::new(&file, true);
		map.write(b"bbbb");
		map.sync();
	}
	assert!(std::fs::read(disk(&node, "x.js")).unwrap().starts_with(b"bbbb"));
	assert!(eventually(Duration::from_secs(10), || read_at(&held).starts_with("bbbb")), "{}", read_at(&held));
	// A mapping in b made before a's write shows it once b's pages drop.
	let map = Mapping::new(&File::open(b.at(X)).unwrap(), false);
	assert_eq!(map.start(), *b"bbbb");
	std::fs::write(a.at(X), [b'c'; 4096]).unwrap();
	assert!(read_at(&held).starts_with("cccc"));
	assert!(eventually(Duration::from_secs(10), || map.start() == *b"cccc"));
	drop(map);
	closed(&node, vec![a, b]);
}

/// A shared mapping of a whole small file (`mmap`).
struct Mapping {
	at: *mut u8,
	len: usize,
}

impl Mapping {
	fn new(file: &File, write: bool) -> Mapping {
		let len = file.metadata().unwrap().len() as usize;
		let prot = if write { libc::PROT_READ | libc::PROT_WRITE } else { libc::PROT_READ };
		// SAFETY: maps `len` bytes of an open file; the mapping outlives the fd, and is unmapped on drop.
		let at = unsafe { libc::mmap(std::ptr::null_mut(), len, prot, libc::MAP_SHARED, file.as_raw_fd(), 0) };
		assert_ne!(at, libc::MAP_FAILED, "{}", std::io::Error::last_os_error());
		Mapping { at: at.cast(), len }
	}

	/// The first 4 bytes, read from the mapping each time.
	fn start(&self) -> [u8; 4] {
		// SAFETY: the mapping is live and longer than 4 bytes.
		unsafe { std::ptr::read_volatile(self.at.cast::<[u8; 4]>()) }
	}

	/// Writes `data` at the mapping's start.
	fn write(&self, data: &[u8]) {
		assert!(data.len() <= self.len);
		// SAFETY: the mapping is live, writable and at least `data.len()` bytes.
		unsafe { std::ptr::copy_nonoverlapping(data.as_ptr(), self.at, data.len()) }
	}

	fn sync(&self) {
		assert_eq!(self.synced(), Ok(()));
	}

	/// `msync` of the whole mapping, or the errno it fails with.
	fn synced(&self) -> Result<(), i32> {
		// SAFETY: the mapping is live.
		match unsafe { libc::msync(self.at.cast(), self.len, libc::MS_SYNC) } {
			0 => Ok(()),
			_ => Err(std::io::Error::last_os_error().raw_os_error().unwrap()),
		}
	}

	/// What reading the mapping's first byte does in a child process: the byte, or the signal that ended the child.
	fn touched(&self) -> Result<u8, i32> {
		// SAFETY: the child only reads the mapping and exits, both async-signal-safe; the parent reaps it.
		let pid = unsafe { libc::fork() };
		assert!(pid >= 0, "{}", std::io::Error::last_os_error());
		if pid == 0 {
			// SAFETY: the mapping is live in the child too.
			unsafe { libc::_exit(i32::from(std::ptr::read_volatile(self.at))) }
		}
		let mut status = 0;
		// SAFETY: waits for the child forked above.
		assert_eq!(unsafe { libc::waitpid(pid, &mut status, 0) }, pid);
		if libc::WIFSIGNALED(status) {
			Err(libc::WTERMSIG(status))
		} else {
			Ok(libc::WEXITSTATUS(status) as u8)
		}
	}
}

impl Drop for Mapping {
	fn drop(&mut self) {
		// SAFETY: unmaps what `new` mapped.
		unsafe { libc::munmap(self.at.cast(), self.len) };
	}
}

/// A process holding the view at its end reads nothing more of it (`Kernel::close`), the view closed.
#[test]
fn a_process_holding_the_view_at_its_close_reads_nothing_more() {
	if !wanted() {
		return;
	}
	held_past_the_end(false, 0);
}

/// The same at a SIGTERM, as a helper's stop sends 20 s before its SIGKILL (`TimeoutStopSec=20s`), with many files
/// opened before: the drop is done well inside that.
#[test]
fn a_process_holding_the_view_at_a_sigterm_reads_nothing_more_and_the_drop_is_quick() {
	if !wanted() {
		return;
	}
	held_past_the_end(true, CLOSE_FILES);
}

/// Cache files opened and read before a SIGTERM, for the drop's time.
const CLOSE_FILES: usize = 3000;

/// A program ends while a process holds: read fds on a node file and a cache file, a fd on a file it never read while
/// another process read it, a fd on a node file and one on a cache file it made and wrote, a folder's fd it opens names
/// through, a shared mapping read once, and a shared writable mapping written and not written back. The program refuses
/// every request from the end on, has the kernel drop the pages of every file opened through it (each pinned page a
/// process already took stays its own), then unmounts and exits. After it, every read, stat and open through what the
/// process holds fails, the mapping's next touch gets SIGBUS, and the written page is lost: its msync gives EIO and the
/// disk never has it. During the drop (held at its gate, `CLOSE_GATE`), the program answers each request (a statfs,
/// asked over and over from before the end) with a refusal, and after the end the session is gone. The end is the
/// view's close (`sigterm` false) or a SIGTERM, after `files` more cache files were opened and read.
fn held_past_the_end(sigterm: bool, files: usize) {
	let node = FakeNode::writable();
	node.put("notes/readme", "readme", false);
	node.put("notes/package.json", "{\"name\":\"notes\"}", false);
	let gate = node.dir.join("gate");
	let mut a = Program::start(&node, "a", &[(CLOSE_GATE, gate.to_str().unwrap())]);
	assert!(a.logged().contains("qorpera-folder: kernel cache on"), "{}", a.logged());
	std::fs::create_dir(a.at(TOP)).unwrap();
	std::fs::write(a.at(X), [b'x'; 8192]).unwrap();
	std::fs::write(a.at(Y), [b'y'; 4096]).unwrap();
	for i in 0..files {
		let name = format!("{TOP}/f{i}.js");
		std::fs::write(a.at(&name), [b'f'; 4096]).unwrap();
		assert_eq!(std::fs::read(a.at(&name)).unwrap().len(), 4096);
	}
	let readme = File::open(a.at("notes/readme")).unwrap();
	assert_eq!(read_at(&readme), "readme");
	let x = File::open(a.at(X)).unwrap();
	assert_eq!(read_at(&x), "x".repeat(64));
	let package = File::open(a.at("notes/package.json")).unwrap();
	let other = Command::new("cat").arg(a.at("notes/package.json")).output().unwrap();
	assert_eq!(other.stdout, b"{\"name\":\"notes\"}");
	// Made and written through the fd it holds, then read through it (the kernel asks for the attributes once).
	let z = format!("{TOP}/z.js");
	let made: Vec<File> = ["notes/made.md", z.as_str()]
		.iter()
		.map(|path| {
			let file = OpenOptions::new().read(true).write(true).create_new(true).open(a.at(path)).unwrap();
			file.write_all_at(&[b'm'; 4096], 0).unwrap();
			assert_eq!(read_at(&file), "m".repeat(64));
			file
		})
		.collect();
	let top = OpenOptions::new().read(true).custom_flags(libc::O_DIRECTORY).open(a.at(TOP)).unwrap();
	assert!(opened_in(&top, "x.js").is_ok());
	let mapped = Mapping::new(&x, false);
	assert_eq!(mapped.start(), *b"xxxx");
	assert_eq!(mapped.touched(), Ok(b'x'));
	let y = OpenOptions::new().read(true).write(true).open(a.at(Y)).unwrap();
	let written = Mapping::new(&y, true);
	written.write(b"lost");
	// Until the session is gone, a process asks for the view's statfs, which the kernel never keeps: through the drop,
	// the program's loops answer each with a refusal. It is answered once before the end.
	let refused = Arc::new(AtomicUsize::new(0));
	let (started, start) = mpsc::channel();
	let asking = {
		let (asked, refused) = (top.try_clone().unwrap(), refused.clone());
		std::thread::spawn(move || {
			let (mut started, deadline) = (Some(started), Instant::now() + Duration::from_secs(60));
			while Instant::now() < deadline {
				// SAFETY: all zeros is a statfs; an open fd and a statfs to fill.
				let mut stats: libc::statfs = unsafe { std::mem::zeroed() };
				if unsafe { libc::fstatfs(asked.as_raw_fd(), &mut stats) } == 0 {
					if let Some(started) = started.take() {
						started.send(()).unwrap();
					}
					continue;
				}
				match std::io::Error::last_os_error().raw_os_error() {
					Some(libc::EIO) => refused.fetch_add(1, Ordering::SeqCst),
					errno => return errno,
				};
			}
			None
		})
	};
	start.recv_timeout(Duration::from_secs(10)).expect("a statfs answered before the end");
	let code = if sigterm {
		a.signal(libc::SIGTERM);
		0
	} else {
		node.close_view();
		3
	};
	// The drop dropped every inode and waits: the program is still ending, and refuses each statfs.
	assert!(eventually(Duration::from_secs(10), || a.logged().contains(DROP_WAITS)), "{}", a.logged());
	assert!(eventually(Duration::from_secs(10), || refused.load(Ordering::SeqCst) > 0), "no statfs refused during the drop");
	assert!(a.child.try_wait().unwrap().is_none(), "the program ended during the drop: {}", a.logged());
	std::fs::write(&gate, "").unwrap();
	let ended = eventually(Duration::from_secs(20), || a.child.try_wait().unwrap().is_some());
	assert!(ended, "the program did not stop: {}", a.logged());
	assert_eq!(a.child.wait().unwrap().code(), Some(code), "{}", a.logged());
	let mut buf = [0; 16];
	for (what, file) in [("readme", &readme), ("x.js", &x), ("package.json", &package), ("made.md", &made[0]), ("z.js", &made[1])] {
		let read = file.read_at(&mut buf, 0);
		assert!(read.is_err(), "a read of {what} through its held fd after the end gave {read:?}");
		assert!(file.metadata().is_err(), "a stat of {what} through its held fd after the end");
	}
	let opened = opened_in(&top, "x.js");
	assert!(opened.is_err(), "an open through the held folder after the end gave {opened:?}");
	assert!(top.metadata().is_err(), "a stat of the held folder after the end");
	assert_eq!(mapped.touched(), Err(libc::SIGBUS));
	assert_eq!(written.synced(), Err(libc::EIO));
	assert_eq!(std::fs::read(disk(&node, "y.js")).unwrap(), [b'y'; 4096]);
	// The statfs asked while the connection ended gets ECONNABORTED, a later one ENOTCONN.
	let last = asking.join().unwrap();
	println!("statfs refused {} times through the end, then {last:?}", refused.load(Ordering::SeqCst));
	assert!(matches!(last, Some(libc::ECONNABORTED | libc::ENOTCONN)), "the session outlived the program: {last:?}");
	// Every file and folder opened through the program: x, y, readme, package.json, the two made, the top, and the
	// `files`.
	let log = a.logged();
	let all = |l: &&str| l.starts_with("qorpera-folder: closing: dropped the kernel's pages of ") && l.ends_with(" ms");
	let line = log.lines().find(all).unwrap_or_else(|| panic!("{log}"));
	let words: Vec<&str> = line.split(' ').collect();
	let (dropped, ms): (usize, u64) = (words[7].parse().unwrap(), words[10].parse().unwrap());
	assert_eq!(dropped, files + 7, "{line}");
	assert!(ms < 10_000, "{line}");
	println!("{line}");
}

/// A create let through before the end whose reply goes out only after the end's drop (`LATE_CREATE`), at the node
/// and in a cache: the drop came before the kernel had the inode, which it makes from the reply after. The reply hands
/// no attributes to keep, so the open's permission check asks for them, is refused, and the create opens nothing.
#[test]
fn a_create_answered_after_the_ends_drop_opens_nothing() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("notes/readme", "readme", false);
	let gate = node.dir.join("gate");
	let mut a = Program::start(&node, "a", &[(CLOSE_GATE, gate.to_str().unwrap()), (LATE_CREATE, "late.md")]);
	std::fs::create_dir(a.at(TOP)).unwrap();
	let (made, creates) = mpsc::channel();
	for path in ["notes/late.md".to_string(), format!("{TOP}/late.md")] {
		let (path, made) = (a.at(&path), made.clone());
		std::thread::spawn(move || made.send(OpenOptions::new().read(true).write(true).create_new(true).open(path)).unwrap());
	}
	let waits = "qorpera-folder: test switch: a create of late.md was let through and waits for the end's drop";
	assert!(eventually(Duration::from_secs(10), || a.logged().matches(waits).count() == 2), "{}", a.logged());
	a.signal(libc::SIGTERM);
	// Both inodes were in the drop; the replies go out after it, during the end.
	for _ in 0..2 {
		let created = creates.recv_timeout(Duration::from_secs(20)).unwrap();
		assert_eq!(created.as_ref().map_err(|e| e.raw_os_error()).err(), Some(Some(libc::EIO)), "{created:?}");
	}
	assert!(a.logged().contains(DROP_WAITS), "{}", a.logged());
	assert!(a.child.try_wait().unwrap().is_none(), "the program ended during the drop: {}", a.logged());
	std::fs::write(&gate, "").unwrap();
	let ended = eventually(Duration::from_secs(20), || a.child.try_wait().unwrap().is_some());
	assert!(ended, "the program did not stop: {}", a.logged());
	assert_eq!(a.child.wait().unwrap().code(), Some(0), "{}", a.logged());
}

/// A fallback that cannot drop what the kernel holds ends the program (exit 1) through the same end as a stop. A
/// SIGTERM during that end's drop waits for it (`Kernel::close`): the program neither unmounts nor exits before the
/// drop is done, and a fd held past the end reads nothing more.
#[test]
fn a_stop_during_a_fallbacks_end_waits_for_its_drop() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("notes/readme", "readme", false);
	let gate = node.dir.join("gate");
	let mut a = Program::start(&node, "a", &[(NOTIFY_FAILS, "all"), (CLOSE_GATE, gate.to_str().unwrap())]);
	assert!(a.logged().contains("qorpera-folder: kernel cache on"), "{}", a.logged());
	std::fs::create_dir(a.at(TOP)).unwrap();
	std::fs::write(a.at(X), "one").unwrap();
	let x = File::open(a.at(X)).unwrap();
	assert_eq!(read_at(&x), "one");
	// Not a change: a drops all its kernel holds, which fails, so it falls back, cannot drop either, and ends.
	let mut stream = UnixStream::connect(a.socket(&node)).unwrap();
	stream.write_all(b"no change\n").unwrap();
	assert!(eventually(Duration::from_secs(10), || a.logged().contains(DROP_WAITS)), "{}", a.logged());
	let log = a.logged();
	assert!(log.contains("qorpera-folder: kernel cache: could not drop what the kernel holds (test switch); stopping"), "{log}");
	// The stop's end comes second, and waits.
	a.signal(libc::SIGTERM);
	let second = "qorpera-folder: closing: the end already began; waiting for its drop";
	assert!(eventually(Duration::from_secs(10), || a.logged().contains(second)), "{}", a.logged());
	std::thread::sleep(Duration::from_millis(500));
	assert!(a.child.try_wait().unwrap().is_none(), "the program ended during the drop: {}", a.logged());
	assert!(mounted(&a.mountpoint), "the program unmounted during the drop: {}", a.logged());
	std::fs::write(&gate, "").unwrap();
	let ended = eventually(Duration::from_secs(20), || a.child.try_wait().unwrap().is_some());
	assert!(ended, "the program did not stop: {}", a.logged());
	// Whichever caller exits first: the fallback's 1 or the stop's 0.
	let code = a.child.wait().unwrap().code();
	assert!(matches!(code, Some(0 | 1)), "{code:?}: {}", a.logged());
	assert!(x.read_at(&mut [0; 4], 0).is_err(), "a read through a held fd after the end");
	assert!(x.metadata().is_err(), "a stat through a held fd after the end");
	assert_eq!(a.logged().matches("qorpera-folder: closing: dropped the kernel's pages of ").count(), 1, "{}", a.logged());
}

/// `openat` of `name` in the folder `dir` holds open.
fn opened_in(dir: &File, name: &str) -> std::io::Result<File> {
	use std::os::fd::FromRawFd;
	let name = CString::new(name).unwrap();
	// SAFETY: an open fd and a C string; a new fd is owned by the File.
	match unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC) } {
		fd if fd >= 0 => Ok(unsafe { File::from_raw_fd(fd) }),
		_ => Err(std::io::Error::last_os_error()),
	}
}

/// The node takes a cache top's name while the feeds are lost: at the resync, every program looks the names up again,
/// and shows the node's folder there, not the cache its kernel kept (the resync drops the node's names, and its own
/// epoch every other).
#[test]
fn a_cache_top_the_node_took_unheard_goes_from_every_program_at_the_resync() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("notes/readme", "readme", false);
	let (a, b) = two(&node);
	std::fs::create_dir(a.at(TOP)).unwrap();
	std::fs::write(a.at(X), "cached").unwrap();
	assert_eq!((a.read(X), b.read(X)), ("cached".to_string(), "cached".to_string()));
	// The programs open their feeds again a second after they lost them.
	node.drop_feeds();
	node.put("notes/node_modules/y", "published", false);
	for p in [&a, &b] {
		assert!(eventually(Duration::from_secs(15), || names(&p.at(TOP)) == ["y"]), "{:?}", names(&p.at(TOP)));
		assert!(!p.at(X).exists());
		assert_eq!(p.read("notes/node_modules/y"), "published");
	}
	closed(&node, vec![a, b]);
}

/// A cache top the node's entry won over leaves the disk at a listing of its folder, behind the kernels' backs: a name
/// below it that a held folder still reaches goes at once in the program that moved it (its own epoch), and shortly
/// after in the other (told).
#[test]
fn a_cache_top_that_leaves_the_disk_takes_the_names_a_held_folder_reaches() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("notes/readme", "readme", false);
	let (a, b) = two(&node);
	std::fs::create_dir(a.at(TOP)).unwrap();
	std::fs::write(a.at(X), "cached").unwrap();
	// Each holds the top and its file open: the kernel keeps their names past the node's change, which drops the top's.
	let held: Vec<(File, File)> = [&a, &b].map(|p| (File::open(p.at(TOP)).unwrap(), File::open(p.at(X)).unwrap())).into();
	node.put("notes/node_modules/y", "published", false);
	for p in [&a, &b] {
		assert!(eventually(Duration::from_secs(10), || names(&p.at(TOP)) == ["y"]), "{:?}", names(&p.at(TOP)));
	}
	assert!(held.iter().all(|(top, _)| reaches(top, "x.js")));
	assert_eq!(names(&a.at("notes")), ["node_modules", "readme"]);
	assert!(!disk(&node, "x.js").exists());
	assert!(!reaches(&held[0].0, "x.js"));
	assert!(eventually(Duration::from_secs(10), || !reaches(&held[1].0, "x.js")));
	drop(held);
	closed(&node, vec![a, b]);
}

/// Whether `name` is in the folder `dir` holds open (`fstatat`).
fn reaches(dir: &File, name: &str) -> bool {
	let name = CString::new(name).unwrap();
	let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
	// SAFETY: an open fd, a C string, and a buffer `fstatat` fills.
	unsafe { libc::fstatat(dir.as_raw_fd(), name.as_ptr(), stat.as_mut_ptr(), 0) == 0 }
}

/// Two programs writing one cache file (small writes and ones across a page edge, into pages the kernel does not hold,
/// and a truncate) and making, looking up and removing names in one cache folder, at the same moments, each change told
/// to the other before its reply. A told program that waited on what its own request holds (the page a write keeps
/// locked, the folder a create or unlink has locked) would hold up both for `WAIT` and fail the change.
#[test]
fn two_programs_changing_one_file_and_one_folder_at_once_never_wait_on_each_other() {
	if !wanted() {
		return;
	}
	const ROUNDS: usize = 500;
	const LIMIT: Duration = Duration::from_secs(120);
	const PAGE: u64 = 4096;
	let node = FakeNode::writable();
	node.put("notes/readme", "readme", false);
	let (a, b) = two(&node);
	let shared = "notes/node_modules/shared";
	std::fs::create_dir(a.at(TOP)).unwrap();
	std::fs::write(a.at(shared), [0u8; 3 * PAGE as usize]).unwrap();
	// Program `me` writes 100 bytes in the first page, and 200 across the edge after page `me`.
	let small = |me: u64| me * 100..me * 100 + 100;
	let across = |me: u64| (me + 1) * PAGE - 100..(me + 1) * PAGE + 100;
	let step = Arc::new(Barrier::new(2));
	let (done, results) = mpsc::channel();
	for (me, mount) in [(0u64, a.mountpoint.clone()), (1, b.mountpoint.clone())] {
		let (step, done) = (step.clone(), done.clone());
		std::thread::spawn(move || {
			let ran = (|| -> Result<(), String> {
				let file = OpenOptions::new().read(true).write(true).open(mount.join(shared)).map_err(|e| e.to_string())?;
				let other = 1 - me;
				for round in 0..ROUNDS {
					let failed = |what: &str, e: std::io::Error| format!("program {me}, round {round}: {what}: {e}");
					let byte = round as u8;
					step.wait();
					for range in [small(me), across(me)] {
						file.write_all_at(&vec![byte; (range.end - range.start) as usize], range.start)
							.map_err(|e| failed("write", e))?;
					}
					if me == 0 {
						file.set_len((3 + round as u64 % 2) * PAGE).map_err(|e| failed("truncate", e))?;
					}
					for range in [small(me), across(me)] {
						let mut back = vec![0; (range.end - range.start) as usize];
						file.read_exact_at(&mut back, range.start).map_err(|e| failed("read", e))?;
						if back.iter().any(|&b| b != byte) {
							return Err(format!("program {me}, round {round}: read back what it did not write"));
						}
					}
					let name = |who: u64| mount.join(format!("{TOP}/{who}.{round}"));
					std::fs::write(name(me), "x").map_err(|e| failed("create", e))?;
					step.wait();
					std::fs::metadata(name(other)).map_err(|e| failed("look up the other's name", e))?;
					step.wait();
					std::fs::remove_file(name(me)).map_err(|e| failed("unlink", e))?;
				}
				Ok(())
			})();
			let _ = done.send(ran);
		});
	}
	let started = Instant::now();
	for _ in 0..2 {
		let ran = results.recv_timeout(LIMIT.saturating_sub(started.elapsed()));
		ran.unwrap_or_else(|_| panic!("the rounds did not end within {LIMIT:?}")).unwrap();
	}
	eprintln!("{ROUNDS} rounds in {:?}", started.elapsed());
	// Both show the file as the disk has it, and the folder with nothing else in it; neither turned its kernel cache off.
	let last = (ROUNDS - 1) as u8;
	let on_disk = std::fs::read(disk(&node, "shared")).unwrap();
	assert_eq!(on_disk.len() as u64, (3 + (ROUNDS as u64 - 1) % 2) * PAGE);
	for (i, &byte) in on_disk.iter().enumerate() {
		let written = [small(0), across(0), small(1), across(1)].iter().any(|r| r.contains(&(i as u64)));
		assert_eq!(byte, if written { last } else { 0 }, "byte {i}");
	}
	for p in [&a, &b] {
		assert!(std::fs::read(p.at(shared)).unwrap() == on_disk);
		assert_eq!(names(&p.at(TOP)), ["shared"]);
		assert!(!p.logged().contains("kernel cache off"), "{}", p.logged());
	}
	closed(&node, vec![a, b]);
}
