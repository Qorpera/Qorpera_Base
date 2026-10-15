//! The folder program mounted for real against a node stand-in. Needs root and /dev/fuse, so it runs only when
//! QORPERA_FOLDER_FUSE_TESTS=1 (the run-on-node step sets it, in a container given /dev/fuse); without it the
//! test says it was skipped.

mod support;

use qorpera_folder::link::{Link, View};
use qorpera_folder::mount::{self, Options, Stop};
use qorpera_folder::reads::ReadLog;
use std::ffi::CString;
use std::io::{ErrorKind, Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::io::IntoRawFd;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};
use support::{FakeNode, PASS};

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

fn names(dir: &Path) -> Vec<String> {
	let mut out: Vec<String> =
		std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
	out.sort();
	out
}

fn mounted(path: &Path) -> bool {
	std::fs::read_to_string("/proc/self/mountinfo").unwrap().lines().any(|l| l.split(' ').nth(4) == Some(path.to_str().unwrap()))
}

/// Takes down a mount a stopped program left behind. The program tries its unmount once; under load the kernel can
/// still count a descriptor on the mount for a moment (EBUSY, #1021's merge test), and the mount stays. Unmounts it
/// here, again while it is busy, so the next program mounts at an empty mountpoint and not over this one.
fn unmounted(path: &Path) {
	let c = c_path(path);
	// SAFETY: a path from CString, and no flags.
	let gone = eventually(Duration::from_secs(10), || !mounted(path) || unsafe { libc::umount2(c.as_ptr(), 0) } == 0);
	assert!(gone && !mounted(path), "{} stayed mounted", path.display());
}

fn start(node: &FakeNode) -> (PathBuf, std::thread::JoinHandle<Stop>) {
	start_with(node, None)
}

/// Mounts with the version map kept in `state` (a mount started again over the same folder reads it back).
fn start_with(node: &FakeNode, state: Option<PathBuf>) -> (PathBuf, std::thread::JoinHandle<Stop>) {
	let state = Some(state.unwrap_or_else(|| node.dir.join("state")));
	let mountpoint = node.dir.join("company");
	std::fs::create_dir_all(&mountpoint).unwrap();
	// Below, "mounted" must mean this program's mount, not one left here before.
	assert!(!mounted(&mountpoint), "{} is still mounted from before", mountpoint.display());
	let link = Link::new(
		node.addr.clone(),
		View { environment_id: "env".into(), view_id: "view".into(), pass: PASS.into() },
		4,
	);
	let options =
		Options { mountpoint: mountpoint.clone(), threads: 4, ttl: Duration::from_secs(3600), allow_other: false, owner: None, state, reads: None, local: None };
	let runner = std::thread::spawn(move || match mount::run(link, options) {
		Ok(stop) => stop,
		Err(e) => panic!("mount failed: {e:?}"),
	});
	assert!(eventually(Duration::from_secs(5), || mounted(&mountpoint)), "the folder was not mounted");
	(mountpoint, runner)
}

#[test]
fn mounts_reads_follows_changes_and_unmounts_when_the_view_closes() {
	if !wanted() {
		return;
	}
	let node = FakeNode::start();
	node.put("docs/plan.md", "the plan, version one", false);
	node.put("readme.md", "hi", false);
	node.put("tools/run.sh", "#!/bin/sh\necho ok\n", true);
	let (company, runner) = start(&node);

	assert_eq!(names(&company), ["docs", "readme.md", "tools"]);
	assert_eq!(names(&company.join("docs")), ["plan.md"]);
	let plan = company.join("docs/plan.md");
	assert_eq!(std::fs::read_to_string(&plan).unwrap(), "the plan, version one");
	assert_eq!(std::fs::metadata(&plan).unwrap().permissions().mode() & 0o777, 0o444);
	assert_eq!(std::fs::metadata(company.join("tools/run.sh")).unwrap().permissions().mode() & 0o777, 0o555);
	assert_eq!(std::fs::metadata(company.join("docs")).unwrap().permissions().mode() & 0o777, 0o555);

	// Read-only: no writes, no new files.
	let write = std::fs::OpenOptions::new().write(true).open(&plan).unwrap_err();
	assert_eq!(write.raw_os_error(), Some(libc::EROFS));
	assert_eq!(std::fs::write(company.join("new.md"), "x").unwrap_err().raw_os_error(), Some(libc::EROFS));

	// A second read comes from the kernel's page cache.
	let reads = node.reads();
	assert_eq!(std::fs::read_to_string(&plan).unwrap(), "the plan, version one");
	assert_eq!(node.reads(), reads, "the second read went to the node");

	// A file open before a change keeps reading its own version, and a new reader sees only the new one,
	// even with the same size: two versions never share cached pages.
	node.put("docs/same.md", &"a".repeat(64 * 1024), false);
	let same = company.join("docs/same.md");
	assert!(eventually(Duration::from_secs(2), || same.exists()));
	let mut held = std::fs::File::open(&same).unwrap();
	let mut first = vec![0u8; 4096];
	held.read_exact(&mut first).unwrap();
	assert!(first.iter().all(|&b| b == b'a'));
	node.put("docs/same.md", &"b".repeat(64 * 1024), false);
	assert!(eventually(Duration::from_secs(2), || std::fs::read(&same).ok().is_some_and(|v| v.iter().all(|&b| b == b'b'))));
	let mut rest = Vec::new();
	held.read_to_end(&mut rest).unwrap();
	assert_eq!(rest.len(), 64 * 1024 - 4096);
	assert!(rest.iter().all(|&b| b == b'a'), "the open file read the newer version");
	let fresh = std::fs::read(&same).unwrap();
	assert!(fresh.iter().all(|&b| b == b'b'), "a new reader saw the older version's pages");
	drop(held);

	// A change on the node shows at once, cached pages included.
	node.put("docs/plan.md", "the plan, version two, longer", false);
	assert!(eventually(Duration::from_secs(2), || std::fs::read_to_string(&plan).ok().as_deref()
		== Some("the plan, version two, longer")));
	node.put("docs/new.md", "new", false);
	assert!(eventually(Duration::from_secs(2), || names(&company.join("docs")) == ["new.md", "plan.md", "same.md"]));
	node.remove("readme.md");
	assert!(eventually(Duration::from_secs(2), || {
		std::fs::metadata(company.join("readme.md")).err().map(|e| e.kind()) == Some(ErrorKind::NotFound)
	}));

	// The feed breaks: a change it missed still shows once it is back, because the program drops its caches.
	node.drop_feeds();
	node.put_quietly("docs/new.md", "changed while the feed was down");
	assert!(eventually(Duration::from_secs(5), || node.feeds() == 1), "the feed did not come back");
	assert!(eventually(Duration::from_secs(2), || std::fs::read_to_string(company.join("docs/new.md")).ok().as_deref()
		== Some("changed while the feed was down")));

	// The node closes the view: the folder program unmounts and says why.
	node.close_view();
	let stop = runner.join().unwrap();
	assert!(matches!(stop, Stop::ViewClosed), "{stop:?}");
	assert!(!mounted(&company));
}

#[test]
fn a_change_that_races_a_lookup_never_leaves_the_old_name_or_version_in_the_kernel() {
	if !wanted() {
		return;
	}
	let node = FakeNode::start();
	node.put("race/keep.md", "keep", false);
	let (company, runner) = start(&node);
	assert_eq!(names(&company.join("race")), ["keep.md"]);
	// A lookup answered from what the folder held just before a change can reach the kernel after the change's
	// own drop: the kernel does not find a name it is still making, and would keep it for the whole TTL.
	let mut stale = Vec::new();
	for i in 0..300u64 {
		let name = format!("race/{i}.md");
		let path = company.join(&name);
		node.put(&name, "version one", false);
		let looker = {
			let path = path.clone();
			std::thread::spawn(move || {
				let start = Instant::now();
				while start.elapsed() < Duration::from_millis(50) && std::fs::metadata(&path).is_err() {}
			})
		};
		std::thread::sleep(Duration::from_micros((i % 8) * 50));
		let removed = i % 2 == 0;
		if removed {
			node.remove(&name);
		} else {
			node.put(&name, "version two", false);
		}
		looker.join().unwrap();
		let settled = eventually(Duration::from_secs(1), || {
			if removed {
				std::fs::metadata(&path).err().map(|e| e.kind()) == Some(ErrorKind::NotFound)
			} else {
				std::fs::read_to_string(&path).ok().as_deref() == Some("version two")
			}
		});
		if !settled {
			stale.push(name);
		}
	}
	assert!(stale.is_empty(), "the kernel kept an old name or version: {stale:?}");
	node.close_view();
	assert!(matches!(runner.join().unwrap(), Stop::ViewClosed));
}

#[test]
fn a_refused_view_is_never_mounted() {
	if !wanted() {
		return;
	}
	let node = FakeNode::start();
	let mountpoint = node.dir.join("company");
	std::fs::create_dir(&mountpoint).unwrap();
	let link = Link::new(
		node.addr.clone(),
		View { environment_id: "env".into(), view_id: "view".into(), pass: "wrong".into() },
		2,
	);
	let options =
		Options { mountpoint: mountpoint.clone(), threads: 2, ttl: Duration::from_secs(1), allow_other: false, owner: None, state: None, reads: None, local: None };
	match mount::run(link, options) {
		Err(mount::Failed::View(_)) => {}
		other => panic!("{other:?}"),
	}
	assert!(!mounted(&mountpoint));
}

#[test]
fn writes_files_and_folders_through_a_writable_mount() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("docs/plan.md", "the plan, version one", false);
	let (company, runner) = start_with(&node, Some(node.dir.join("state")));
	assert_eq!(std::fs::metadata(company.join("docs/plan.md")).unwrap().permissions().mode() & 0o777, 0o644);

	// A new file, there at once and on the node.
	std::fs::write(company.join("docs/new.md"), "hello").unwrap();
	assert_eq!(std::fs::read_to_string(company.join("docs/new.md")).unwrap(), "hello");
	assert_eq!(node.content("docs/new.md").unwrap(), b"hello");

	// A file across three chunks, written in pieces.
	let big: Vec<u8> = (0..9 * 1024 * 1024 + 5).map(|i| (i % 251) as u8).collect();
	std::fs::write(company.join("big.bin"), &big).unwrap();
	assert_eq!(node.content("big.bin").unwrap(), big);
	assert_eq!(std::fs::read(company.join("big.bin")).unwrap(), big);

	// Writes inside chunks already sent (a database's pages), read back before the close.
	let mut f = std::fs::OpenOptions::new().read(true).write(true).open(company.join("big.bin")).unwrap();
	f.seek(SeekFrom::Start(4096)).unwrap();
	f.write_all(b"page").unwrap();
	f.seek(SeekFrom::Start(5 * 1024 * 1024)).unwrap();
	f.write_all(b"two").unwrap();
	let mut back = [0u8; 4];
	f.seek(SeekFrom::Start(4096)).unwrap();
	f.read_exact(&mut back).unwrap();
	assert_eq!(&back, b"page");
	drop(f);
	let mut expected = big.clone();
	expected[4096..4100].copy_from_slice(b"page");
	expected[5 * 1024 * 1024..5 * 1024 * 1024 + 3].copy_from_slice(b"two");
	assert_eq!(node.content("big.bin").unwrap(), expected);

	// An editor's save: it read the file, writes a temporary one and renames it over, based on the version it read.
	assert_eq!(std::fs::read_to_string(company.join("docs/plan.md")).unwrap(), "the plan, version one");
	std::fs::write(company.join("docs/.plan.md.new"), "the plan, version two").unwrap();
	std::fs::rename(company.join("docs/.plan.md.new"), company.join("docs/plan.md")).unwrap();
	assert_eq!(node.content("docs/plan.md").unwrap(), b"the plan, version two");
	assert_eq!(node.renames().last().unwrap().to_base.as_deref(), Some("v1"));
	assert_eq!(std::fs::read_to_string(company.join("docs/plan.md")).unwrap(), "the plan, version two");

	// Folders: made with what is in them, renamed, removed.
	std::fs::create_dir_all(company.join("a/b")).unwrap();
	std::fs::write(company.join("a/b/c.txt"), "c").unwrap();
	std::fs::rename(company.join("a"), company.join("z")).unwrap();
	assert_eq!(std::fs::read_to_string(company.join("z/b/c.txt")).unwrap(), "c");
	assert_eq!(names(&company), ["big.bin", "docs", "z"]);
	std::fs::remove_dir_all(company.join("z")).unwrap();
	assert!(!node.exists("z") && !node.exists("z/b/c.txt"));

	// The executable bit, and a file cut short that no one has open.
	std::fs::set_permissions(company.join("docs/new.md"), std::fs::Permissions::from_mode(0o755)).unwrap();
	assert!(node.executable("docs/new.md"));
	assert_eq!(std::fs::metadata(company.join("docs/new.md")).unwrap().permissions().mode() & 0o777, 0o755);
	let path = std::ffi::CString::new(company.join("big.bin").to_str().unwrap()).unwrap();
	// SAFETY: a path from CString, and a plain truncate.
	assert_eq!(unsafe { libc::truncate(path.as_ptr(), 10) }, 0);
	assert_eq!(node.content("big.bin").unwrap(), &expected[..10]);
	assert_eq!(std::fs::metadata(company.join("big.bin")).unwrap().len(), 10);

	// What the folder does not hold.
	assert_eq!(std::os::unix::fs::symlink("x", company.join("link")).unwrap_err().raw_os_error(), Some(libc::EPERM));

	// The machine asks for a boundary.
	let link = Link::new(node.addr.clone(), View { environment_id: "env".into(), view_id: "view".into(), pass: PASS.into() }, 1);
	link.publish().unwrap();
	assert_eq!(node.publishes(), 1);

	node.close_view();
	assert!(matches!(runner.join().unwrap(), Stop::ViewClosed));
}

#[test]
fn the_version_map_and_unreleased_read_log_outlive_the_program() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("notes.md", "first", false);
	let state = node.dir.join("state");
	let (company, runner) = start_with(&node, Some(state.clone()));
	assert_eq!(std::fs::read_to_string(company.join("notes.md")).unwrap(), "first");
	let journal = ReadLog::open(&state, false).unwrap();
	let before = journal.locked().unwrap().request(0);
	assert_eq!(before.reads.len(), 1);
	assert_eq!(before.reads[0].path, "notes.md");
	assert_eq!(before.reads[0].version.as_deref(), Some("v1"));
	node.close_view();
	assert!(matches!(runner.join().unwrap(), Stop::ViewClosed));
	unmounted(&company);
	// Another machine saves while the program is down; the program starts again with the same map.
	node.reopen_view();
	node.put("notes.md", "theirs", false);
	let (company, runner) = start_with(&node, Some(state));
	let after = journal.locked().unwrap().request(0);
	assert_eq!(after.log, before.log);
	assert_eq!(after.reads, before.reads);
	// An editor saves its buffer in place: based on the version read before the restart, not the newest.
	std::fs::write(company.join("notes.md"), "mine").unwrap();
	assert_eq!(node.opens().last().unwrap(), &("notes.md".to_string(), Some("v1".to_string())));
	node.close_view();
	assert!(matches!(runner.join().unwrap(), Stop::ViewClosed));
}

fn c_path(path: &Path) -> CString {
	CString::new(path.to_str().unwrap()).unwrap()
}

/// The errno a libc call that returned -1 left.
fn last_errno() -> Option<i32> {
	std::io::Error::last_os_error().raw_os_error()
}

#[test]
fn a_close_the_node_does_not_take_at_once_is_tried_again_until_it_does() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	let (company, runner) = start(&node);
	// A boundary is settling: the node answers BUSY to the next chunk and the next close.
	node.busy(1, 1);
	let mut f = std::fs::File::create(company.join("busy.md")).unwrap();
	f.write_all(b"written whole").unwrap();
	// The program's close hears it; the file is still closed at the node soon after, with every byte.
	// SAFETY: closes the descriptor this test owns.
	assert_eq!(unsafe { libc::close(f.into_raw_fd()) }, -1);
	assert_eq!(last_errno(), Some(libc::EBUSY));
	assert!(eventually(Duration::from_secs(5), || node.open_handles() == 0), "the node's handle was left open");
	assert_eq!(node.content("busy.md").unwrap(), b"written whole");
	// No longer written here: the next save opens it at the node again.
	std::fs::write(company.join("busy.md"), "again").unwrap();
	assert_eq!(node.content("busy.md").unwrap(), b"again");
	assert_eq!(node.open_handles(), 0);
	node.close_view();
	assert!(matches!(runner.join().unwrap(), Stop::ViewClosed));
}

/// An index as git writes it (version 2, SHA-1) that tracks `paths`.
fn git_index(paths: &[&str]) -> Vec<u8> {
	let mut out = b"DIRC".to_vec();
	out.extend_from_slice(&2u32.to_be_bytes());
	out.extend_from_slice(&(paths.len() as u32).to_be_bytes());
	for path in paths {
		let start = out.len();
		out.extend_from_slice(&[0; 40]);
		out.extend_from_slice(&[0xab; 20]);
		out.extend_from_slice(&(path.len() as u16).to_be_bytes());
		out.extend_from_slice(path.as_bytes());
		let len = out.len() - start;
		out.resize(start + (len + 8) / 8 * 8, 0);
	}
	out.extend_from_slice(&[0; 20]);
	out
}

#[test]
fn a_cache_move_the_node_does_not_take_at_once_goes_on_through_the_same_handle() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("code/o/n/worktrees/w/README", "readme", false);
	node.put("code/o/n/repo.git/worktrees/w/HEAD", "ref: refs/heads/main\n", false);
	let (company, runner) = start(&node);
	// The worktree's node_modules is a cache git does not track: on the machine's disk, not in the folder.
	let modules = company.join("code/o/n/worktrees/w/node_modules");
	std::fs::create_dir(&modules).unwrap();
	std::fs::write(modules.join("x.js"), "cached").unwrap();
	assert!(!node.exists("code/o/n/worktrees/w/node_modules"));
	// Git comes to track it while a boundary settles: the node answers BUSY to the move's first chunk.
	let git = company.join("code/o/n/repo.git/worktrees/w");
	std::fs::write(git.join("index.lock"), git_index(&["node_modules/x.js"])).unwrap();
	node.busy(1, 0);
	std::fs::rename(git.join("index.lock"), git.join("index")).unwrap();
	// The move goes on through the handle it opened, so none is left open at the node to keep its boundaries back.
	let moved = || node.content("code/o/n/worktrees/w/node_modules/x.js").is_some_and(|c| c == b"cached");
	let done = eventually(Duration::from_secs(20), || moved() && node.open_handles() == 0);
	assert!(done, "moved: {}, handles open at the node: {}", moved(), node.open_handles());
	assert_eq!(std::fs::read(modules.join("x.js")).unwrap(), b"cached");
	node.close_view();
	assert!(matches!(runner.join().unwrap(), Stop::ViewClosed));
}

#[test]
fn one_writer_per_file_across_duplicated_inherited_and_truncating_descriptors() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("docs/plan.md", "the plan", false);
	let (company, runner) = start(&node);
	let log = company.join("log.txt");

	// A descriptor closed while its duplicate goes on writing: the close closes the file at the node, and the next
	// write opens it again there, going on from the chunk still in memory.
	let mut f = std::fs::File::create(&log).unwrap();
	f.write_all(b"one ").unwrap();
	let mut dup = f.try_clone().unwrap();
	drop(f);
	assert_eq!(node.content("log.txt").unwrap(), b"one ");
	dup.write_all(b"two").unwrap();
	drop(dup);
	assert_eq!(node.content("log.txt").unwrap(), b"one two");
	assert_eq!(node.gets(), 0, "the chunk in memory was read back");

	// A child that inherited the descriptor writes and exits: its close leaves the file open at the node; the
	// opener's close closes it. (The copy handed to the child closes in this process with the command, which is the
	// opener's close; the child writes after it.)
	let f = std::fs::OpenOptions::new().append(true).open(&log).unwrap();
	let mut command = std::process::Command::new("sh");
	command.arg("-c").arg("sleep 0.5; printf ' three'").stdout(f.try_clone().unwrap());
	let mut child = command.spawn().unwrap();
	drop(command);
	assert!(child.wait().unwrap().success());
	assert_eq!(node.content("log.txt").unwrap(), b"one two", "the child's exit closed the file at the node");
	assert_eq!(node.open_handles(), 1);
	drop(f);
	assert_eq!(node.content("log.txt").unwrap(), b"one two three");

	// ftruncate of the open file, then an O_TRUNC open that joins it: one handle at the node throughout.
	let opens = node.opens().len();
	let f = std::fs::OpenOptions::new().write(true).open(&log).unwrap();
	f.set_len(3).unwrap();
	assert_eq!(std::fs::metadata(&log).unwrap().len(), 3);
	let mut g = std::fs::OpenOptions::new().write(true).truncate(true).open(&log).unwrap();
	g.write_all(b"fresh").unwrap();
	drop(g);
	assert_eq!(std::fs::read(&log).unwrap(), b"fresh");
	drop(f);
	assert_eq!(node.content("log.txt").unwrap(), b"fresh");
	assert_eq!((node.opens().len(), node.open_handles()), (opens + 1, 0));

	// The executable bit at create.
	let mut script = std::fs::OpenOptions::new().write(true).create(true).mode(0o755).open(company.join("run.sh")).unwrap();
	script.write_all(b"#!/bin/sh\n").unwrap();
	drop(script);
	assert!(node.executable("run.sh"));

	// `touch`: times are the folder's, so nothing changes. Owners are the mount's. Two names cannot swap.
	let plan = c_path(&company.join("docs/plan.md"));
	let version = node.version("docs/plan.md");
	// SAFETY: a path from CString; null times mean now.
	assert_eq!(unsafe { libc::utimensat(libc::AT_FDCWD, plan.as_ptr(), std::ptr::null(), 0) }, 0);
	assert_eq!(node.version("docs/plan.md"), version);
	// SAFETY: as above; a gid of -1 leaves it.
	assert_eq!(unsafe { libc::chown(plan.as_ptr(), 4242, u32::MAX) }, -1);
	assert_eq!(last_errno(), Some(libc::EPERM));
	const RENAME_EXCHANGE: libc::c_uint = 2;
	let other = c_path(&log);
	// SAFETY: two paths from CString, and the renameat2 flags.
	let swapped = unsafe {
		libc::syscall(libc::SYS_renameat2, libc::AT_FDCWD, plan.as_ptr(), libc::AT_FDCWD, other.as_ptr(), RENAME_EXCHANGE)
	};
	assert_eq!((swapped, last_errno()), (-1, Some(libc::EINVAL)));

	// O_RDONLY with O_TRUNC cuts the file too.
	// SAFETY: a path from CString, opened and closed.
	let fd = unsafe { libc::open(plan.as_ptr(), libc::O_RDONLY | libc::O_TRUNC) };
	assert!(fd >= 0);
	// SAFETY: closes the descriptor opened above.
	assert_eq!(unsafe { libc::close(fd) }, 0);
	assert_eq!(node.content("docs/plan.md").unwrap(), b"");
	assert_eq!(std::fs::metadata(company.join("docs/plan.md")).unwrap().len(), 0);

	node.close_view();
	assert!(matches!(runner.join().unwrap(), Stop::ViewClosed));
}

#[test]
fn a_file_held_open_across_a_newer_version_bases_its_save_on_what_it_read() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("plan.md", "the first", false);
	let (company, runner) = start(&node);
	let plan = company.join("plan.md");
	// An editor opens the file; another machine publishes a newer version before the editor reads it, and the mount
	// shows that one now.
	let mut held = std::fs::File::open(&plan).unwrap();
	node.put("plan.md", "the second one", false);
	assert!(eventually(Duration::from_secs(2), || std::fs::metadata(&plan).is_ok_and(|m| m.len() == 14)));
	// The editor reads the version it opened: the only version this mount read of the path.
	let mut text = String::new();
	held.read_to_string(&mut text).unwrap();
	assert_eq!(text, "the first");
	// Its save in place names that version, so the node takes it for the stale save it is, not an overwrite.
	std::fs::write(&plan, "mine").unwrap();
	assert_eq!(node.opens().last().unwrap(), &("plan.md".to_string(), Some("v1".to_string())));
	// A read of the newest version takes over; the file still open does not take the map back.
	node.put("notes.md", "n1", false);
	assert!(eventually(Duration::from_secs(2), || company.join("notes.md").exists()));
	let mut notes = std::fs::File::open(company.join("notes.md")).unwrap();
	node.put("notes.md", "n2 longer", false);
	assert!(eventually(Duration::from_secs(2), || std::fs::read_to_string(company.join("notes.md")).ok().as_deref()
		== Some("n2 longer")));
	let mut old = String::new();
	notes.read_to_string(&mut old).unwrap();
	assert_eq!(old, "n1");
	std::fs::write(company.join("notes.md"), "mine").unwrap();
	assert_eq!(node.opens().last().unwrap(), &("notes.md".to_string(), Some("v2".to_string())));
	node.close_view();
	assert!(matches!(runner.join().unwrap(), Stop::ViewClosed));
}

fn save_after_reading_an_empty_file(rename: bool) {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("plan.md", "", false);
	let (company, runner) = start_with(&node, Some(node.dir.join("state")));
	let plan = company.join("plan.md");
	let mut held = std::fs::File::open(&plan).unwrap();
	assert_eq!(held.metadata().unwrap().len(), 0);
	let mut content = Vec::new();
	held.read_to_end(&mut content).unwrap();
	assert!(content.is_empty());
	assert_eq!(node.reads(), 0, "an empty file needs no byte request: the kernel may answer EOF itself");

	// Another writer publishes, and the feed advances this mount. Only inspect attributes here: reading the newer
	// bytes would deliberately replace the editor's remembered base.
	node.put("plan.md", "the other writer's work", false);
	assert!(eventually(Duration::from_secs(2), || std::fs::metadata(&plan).is_ok_and(|m| m.len() == 23)));
	if rename {
		let temporary = company.join(".plan.md.new");
		std::fs::write(&temporary, "from the empty buffer").unwrap();
		std::fs::rename(&temporary, &plan).unwrap();
		assert_eq!(node.renames().last().unwrap().to_base.as_deref(), Some("v1"));
	} else {
		std::fs::write(&plan, "from the empty buffer").unwrap();
		assert_eq!(node.opens().last().unwrap(), &("plan.md".to_string(), Some("v1".to_string())));
	}
	drop(held);
	node.close_view();
	assert!(matches!(runner.join().unwrap(), Stop::ViewClosed));
}

#[test]
fn an_empty_file_read_keeps_its_base_for_an_in_place_save() {
	save_after_reading_an_empty_file(false);
}

#[test]
fn an_empty_file_read_keeps_its_base_for_a_temporary_file_save() {
	save_after_reading_an_empty_file(true);
}

/// Run the actual CLI as root and access its mount from another uid/gid. Changing process credentials is confined
/// to the child command; the test runner and daemon retain root, including ownership of their private files.
fn a_root_mount_for_another_account(owner: Option<(u32, u32)>, allow_other: bool, writable: bool) {
	if !wanted() {
		return;
	}
	// SAFETY: geteuid has no preconditions.
	assert_eq!(unsafe { libc::geteuid() }, 0, "this test needs a root daemon");
	let node = if writable { FakeNode::writable() } else { FakeNode::start() };
	node.put("docs/plan.md", "first", false);
	// Make the containing directory traversable, independently of the test runner's umask.
	std::fs::set_permissions(&node.dir, std::fs::Permissions::from_mode(0o755)).unwrap();
	let company = node.dir.join("company");
	std::fs::create_dir(&company).unwrap();
	let view = node.dir.join("view.json");
	let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&view).unwrap();
	write!(file, "{{\"environmentId\":\"env\",\"viewId\":\"view\",\"pass\":\"{PASS}\"}}").unwrap();
	drop(file);
	let state = node.dir.join("state");
	let mut command = Command::new(env!("CARGO_BIN_EXE_qorpera-folder"));
	command.arg("mount").arg("--view-file").arg(&view).arg("--mountpoint").arg(&company)
		.arg("--connect").arg(&node.addr).arg("--state-dir").arg(&state)
		.arg("--allow-other").arg(if allow_other { "yes" } else { "no" })
		.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped());
	if let Some((uid, gid)) = owner {
		command.arg("--owner-uid").arg(uid.to_string()).arg("--owner-gid").arg(gid.to_string());
	}
	let mut daemon = command.spawn().unwrap();
	if !eventually(Duration::from_secs(5), || mounted(&company)) {
		let _ = daemon.kill();
		let output = daemon.wait_with_output().unwrap();
		panic!("the CLI did not mount: {}", String::from_utf8_lossy(&output.stderr));
	}
	let folder_meta = std::fs::metadata(&company).unwrap();
	let file_meta = std::fs::metadata(company.join("docs/plan.md")).unwrap();
	let may_write = writable && allow_other && owner == Some((65534, 65534));
	let output = Command::new("sh").arg("-c").arg(r#"
set -eu
[ "$(id -u)" = 65534 ] && [ "$(id -g)" = 65534 ]
if [ "$4" = yes ]; then
  [ "$(cat "$1/docs/plan.md")" = first ]
else
  if cat "$1/docs/plan.md" >/dev/null 2>&1; then exit 10; fi
fi
if [ "$5" = yes ]; then
  mkdir "$1/new"
  printf created >"$1/new/note.md"
  [ "$(cat "$1/new/note.md")" = created ]
  printf rewritten >"$1/docs/plan.md"
  [ "$(cat "$1/docs/plan.md")" = rewritten ]
else
  if (mkdir "$1/new") 2>/dev/null; then exit 11; fi
  if (printf overwritten >"$1/docs/plan.md") 2>/dev/null; then exit 12; fi
fi
if cat "$2" >/dev/null 2>&1; then exit 13; fi
if [ "$6" = yes ]; then
  if cat "$3/versions.jsonl" >/dev/null 2>&1; then exit 14; fi
fi
"#).arg("unprivileged-mount-user").arg(&company).arg(&view).arg(&state)
		.arg(if allow_other { "yes" } else { "no" }).arg(if may_write { "yes" } else { "no" })
		.arg(if writable { "yes" } else { "no" }).uid(65534).gid(65534).output().unwrap();
	// Close and reap before checking assertions, so a regression leaves no child mount behind.
	node.close_view();
	if !eventually(Duration::from_secs(5), || daemon.try_wait().unwrap().is_some()) {
		let _ = daemon.kill();
	}
	let stopped = daemon.wait_with_output().unwrap();
	assert_eq!(stopped.status.code(), Some(3), "{}", String::from_utf8_lossy(&stopped.stderr));
	assert!(!mounted(&company));
	assert!(output.status.success(), "child {:?}: {}", output.status.code(), String::from_utf8_lossy(&output.stderr));
	let expected_owner = if writable { owner.unwrap_or((0, 0)) } else { (0, 0) };
	assert_eq!((folder_meta.uid(), folder_meta.gid()), expected_owner);
	assert_eq!((file_meta.uid(), file_meta.gid()), expected_owner);
	assert_eq!(folder_meta.mode() & 0o777, if writable { 0o755 } else { 0o555 });
	assert_eq!(file_meta.mode() & 0o777, if writable { 0o644 } else { 0o444 });
	assert_eq!(node.content("docs/plan.md").unwrap(), if may_write { b"rewritten".as_slice() } else { b"first".as_slice() });
	assert_eq!(node.content("new/note.md"), may_write.then(|| b"created".to_vec()));
	let view_meta = std::fs::metadata(&view).unwrap();
	assert_eq!((view_meta.uid(), view_meta.mode() & 0o777), (0, 0o600));
	if writable {
		let state_meta = std::fs::metadata(&state).unwrap();
		let log_meta = std::fs::metadata(state.join("versions.jsonl")).unwrap();
		assert_eq!((state_meta.uid(), state_meta.mode() & 0o777), (0, 0o700));
		assert_eq!((log_meta.uid(), log_meta.mode() & 0o777), (0, 0o600));
	} else {
		// The account read docs/plan.md, but a read-only mount hands no reads over, so it never logs them.
		let journal = ReadLog::open(&state, false).unwrap();
		assert!(journal.locked().unwrap().request(0).reads.is_empty(), "a read-only mount logged its reads");
	}
}

#[test]
fn a_root_daemon_defaults_to_root_owned_files_even_with_allow_other() {
	a_root_mount_for_another_account(None, true, true);
}

#[test]
fn an_explicit_owner_can_write_without_reading_the_root_daemons_private_files() {
	a_root_mount_for_another_account(Some((65534, 65534)), true, true);
}

#[test]
fn an_explicit_owner_still_needs_allow_other() {
	a_root_mount_for_another_account(Some((65534, 65534)), false, true);
}

#[test]
fn an_explicit_owner_does_not_make_a_read_only_view_writable() {
	a_root_mount_for_another_account(Some((65534, 65534)), true, false);
}
