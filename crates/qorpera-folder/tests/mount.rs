//! The folder program mounted for real against a node stand-in. Needs root and /dev/fuse, so it runs only when
//! QORPERA_FOLDER_FUSE_TESTS=1 (the run-on-node step sets it, in a container given /dev/fuse); without it the
//! test says it was skipped.

mod support;

use qorpera_folder::link::{Link, View};
use qorpera_folder::mount::{self, Options, Stop};
use std::io::{ErrorKind, Read, Seek, SeekFrom, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
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

fn start(node: &FakeNode) -> (PathBuf, std::thread::JoinHandle<Stop>) {
	start_with(node, None)
}

/// Mounts with the version map kept in `state` (a mount started again over the same folder reads it back).
fn start_with(node: &FakeNode, state: Option<PathBuf>) -> (PathBuf, std::thread::JoinHandle<Stop>) {
	let mountpoint = node.dir.join("company");
	std::fs::create_dir_all(&mountpoint).unwrap();
	let link = Link::new(
		node.addr.clone(),
		View { environment_id: "env".into(), view_id: "view".into(), pass: PASS.into() },
		4,
	);
	let options =
		Options { mountpoint: mountpoint.clone(), threads: 4, ttl: Duration::from_secs(3600), allow_other: false, state };
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
		Options { mountpoint: mountpoint.clone(), threads: 2, ttl: Duration::from_secs(1), allow_other: false, state: None };
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
fn the_version_map_outlives_the_program() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("notes.md", "first", false);
	let state = node.dir.join("state");
	let (company, runner) = start_with(&node, Some(state.clone()));
	assert_eq!(std::fs::read_to_string(company.join("notes.md")).unwrap(), "first");
	node.close_view();
	assert!(matches!(runner.join().unwrap(), Stop::ViewClosed));
	// Another machine saves while the program is down; the program starts again with the same map.
	node.reopen_view();
	node.put("notes.md", "theirs", false);
	let (company, runner) = start_with(&node, Some(state));
	// An editor saves its buffer in place: based on the version read before the restart, not the newest.
	std::fs::write(company.join("notes.md"), "mine").unwrap();
	assert_eq!(node.opens().last().unwrap(), &("notes.md".to_string(), Some("v1".to_string())));
	node.close_view();
	assert!(matches!(runner.join().unwrap(), Stop::ViewClosed));
}
