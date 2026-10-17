//! The folder program mounted for real against a node stand-in. Needs root and /dev/fuse, so it runs only when
//! QORPERA_FOLDER_FUSE_TESTS=1 (the run-on-node step sets it, in a container given /dev/fuse); without it the
//! test says it was skipped.

mod support;

use qorpera_folder::link::{Link, View};
use qorpera_folder::mount::{self, Options, Stop};
use qorpera_folder::proto::LinkRequest;
use qorpera_folder::reads::ReadLog;
use std::ffi::CString;
use std::io::{ErrorKind, Read, Seek, SeekFrom, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::io::{AsRawFd, IntoRawFd};
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

	// What the folder does not hold: a named pipe, a device, a socket.
	// SAFETY: paths from CString, and a plain mkfifo and mknod.
	assert_eq!(unsafe { libc::mkfifo(c_path(&company.join("pipe")).as_ptr(), 0o644) }, -1);
	assert_eq!(last_errno(), Some(libc::EPERM));
	// SAFETY: as above.
	assert_eq!(unsafe { libc::mknod(c_path(&company.join("null")).as_ptr(), libc::S_IFCHR | 0o644, libc::makedev(1, 3)) }, -1);
	assert_eq!(last_errno(), Some(libc::EPERM));
	assert_eq!(std::os::unix::net::UnixListener::bind(company.join("sock")).unwrap_err().raw_os_error(), Some(libc::EPERM));
	assert!(!node.exists("pipe") && !node.exists("null") && !node.exists("sock"));

	// The machine asks for a boundary.
	let link = Link::new(node.addr.clone(), View { environment_id: "env".into(), view_id: "view".into(), pass: PASS.into() }, 1);
	link.publish().unwrap();
	assert_eq!(node.publishes(), 1);

	node.close_view();
	assert!(matches!(runner.join().unwrap(), Stop::ViewClosed));
}

/// A read as the node takes it from the machine's read log.
fn read(path: &str, version: &str) -> (String, Option<String>) {
	(path.to_string(), Some(version.to_string()))
}

#[test]
fn a_read_only_mount_shows_links_and_makes_none() {
	if !wanted() {
		return;
	}
	let node = FakeNode::start();
	node.put("docs/plan.md", "the plan", false);
	node.put_link("docs/latest", "plan.md");
	let (company, runner) = start(&node);
	let latest = company.join("docs/latest");
	let meta = std::fs::symlink_metadata(&latest).unwrap();
	assert!(meta.file_type().is_symlink());
	assert_eq!(meta.len(), 7);
	assert_eq!(std::fs::read_link(&latest).unwrap(), Path::new("plan.md"));
	assert_eq!(std::fs::read_to_string(&latest).unwrap(), "the plan");
	let refused = |e: std::io::Error| e.raw_os_error();
	assert_eq!(std::os::unix::fs::symlink("plan.md", company.join("docs/other")).map_err(refused), Err(Some(libc::EROFS)));
	assert_eq!(std::fs::hard_link(company.join("docs/plan.md"), company.join("docs/copy.md")).map_err(refused), Err(Some(libc::EROFS)));
	// SAFETY: a path from CString, and a plain mkfifo.
	assert_eq!(unsafe { libc::mkfifo(c_path(&company.join("docs/pipe")).as_ptr(), 0o644) }, -1);
	assert_eq!(last_errno(), Some(libc::EROFS));
	// A link changed on the node shows its new target at once; one to a path the view does not hold finds nothing.
	node.put_link("docs/latest", "../private/plan.md");
	assert!(eventually(Duration::from_secs(2), || std::fs::read_link(&latest).ok().as_deref()
		== Some(Path::new("../private/plan.md"))));
	assert_eq!(std::fs::read_to_string(&latest).unwrap_err().kind(), ErrorKind::NotFound);
	node.close_view();
	assert!(matches!(runner.join().unwrap(), Stop::ViewClosed));
}

#[test]
fn makes_reads_moves_and_copies_links_through_a_writable_mount() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("docs/plan.md", "the plan", false);
	node.put_link("docs/old", "plan.md");
	let (company, runner) = start(&node);
	let docs = company.join("docs");
	let outside = node.dir.join("outside.txt");
	std::fs::write(&outside, "the machine's own file").unwrap();

	// `ln -s`, relative and absolute: kept as written, and followed by the kernel.
	std::os::unix::fs::symlink("plan.md", docs.join("rel")).unwrap();
	std::os::unix::fs::symlink(&outside, docs.join("abs")).unwrap();
	std::os::unix::fs::symlink("../secret/keys.md", docs.join("nowhere")).unwrap();
	assert_eq!(node.target("docs/rel").as_deref(), Some("plan.md"));
	assert_eq!(node.target("docs/abs").as_deref(), outside.to_str());
	assert_eq!(std::fs::read_link(docs.join("rel")).unwrap(), Path::new("plan.md"));
	assert_eq!(std::fs::read_to_string(docs.join("rel")).unwrap(), "the plan");
	// A machine file outside the folder is the machine's; a path the view does not hold is not there.
	assert_eq!(std::fs::read_to_string(docs.join("abs")).unwrap(), "the machine's own file");
	assert_eq!(std::fs::read_to_string(docs.join("nowhere")).unwrap_err().kind(), ErrorKind::NotFound);
	let meta = std::fs::symlink_metadata(docs.join("rel")).unwrap();
	assert!(meta.file_type().is_symlink());
	assert_eq!((meta.len(), meta.permissions().mode() & 0o777, meta.nlink()), (7, 0o777, 1));
	let ls = String::from_utf8(Command::new("ls").arg("-l").arg(&docs).output().unwrap().stdout).unwrap();
	assert!(ls.lines().any(|l| l.starts_with("lrwxrwxrwx") && l.ends_with(" rel -> plan.md")), "{ls}");
	// A link's times are not kept, and setting them is no error.
	assert!(Command::new("touch").arg("-h").arg(docs.join("rel")).status().unwrap().success());

	// `ln -sf` over a link the machine read: a new link renamed over it, based on the version read.
	assert_eq!(std::fs::read_link(docs.join("old")).unwrap(), Path::new("plan.md"));
	assert!(Command::new("ln").arg("-sf").arg("rel").arg(docs.join("old")).status().unwrap().success());
	// Each readlink was a read of the link at its version, handed over before that change.
	let logged = node.logged();
	assert!(logged.contains(&read("docs/rel", "v1")) && logged.contains(&read("docs/old", "v1")), "{logged:?}");
	assert_eq!(node.target("docs/old").as_deref(), Some("rel"));
	let replaced = node.renames().last().unwrap().clone();
	assert_eq!((replaced.to.as_str(), replaced.to_base.as_deref()), ("docs/old", Some("v1")));
	assert_eq!(std::fs::read_to_string(docs.join("old")).unwrap(), "the plan");
	assert_eq!(names(&docs), ["abs", "nowhere", "old", "plan.md", "rel"]);

	// `mv` and `rm` of a link move or remove the link, never what it names.
	std::fs::rename(docs.join("rel"), company.join("moved")).unwrap();
	assert_eq!(node.target("moved").as_deref(), Some("plan.md"));
	assert!(!node.exists("docs/rel"));
	assert_eq!(std::fs::read_to_string(company.join("moved")).unwrap_err().kind(), ErrorKind::NotFound);
	std::fs::remove_file(company.join("moved")).unwrap();
	std::fs::remove_file(docs.join("old")).unwrap();
	assert!(!node.exists("moved") && !node.exists("docs/old"));
	assert_eq!(node.content("docs/plan.md").unwrap(), b"the plan");

	// `cp -a` and `tar` keep a folder's links as links.
	std::fs::create_dir(company.join("src")).unwrap();
	std::fs::write(company.join("src/f.txt"), "f").unwrap();
	std::os::unix::fs::symlink("f.txt", company.join("src/l")).unwrap();
	let copied = Command::new("cp").arg("-a").arg(company.join("src")).arg(company.join("copy")).output().unwrap();
	assert!(copied.status.success(), "{}", String::from_utf8_lossy(&copied.stderr));
	assert_eq!(node.target("copy/l").as_deref(), Some("f.txt"));
	assert_eq!(node.content("copy/f.txt").unwrap(), b"f");
	let archive = node.dir.join("src.tar");
	let packed = Command::new("tar").arg("-cf").arg(&archive).arg("-C").arg(&company).arg("src").output().unwrap();
	assert!(packed.status.success(), "{}", String::from_utf8_lossy(&packed.stderr));
	let listed = String::from_utf8(Command::new("tar").arg("-tvf").arg(&archive).output().unwrap().stdout).unwrap();
	assert!(listed.lines().any(|l| l.starts_with('l') && l.ends_with("src/l -> f.txt")), "{listed}");
	std::fs::create_dir(company.join("untar")).unwrap();
	let unpacked = Command::new("tar").arg("-xf").arg(&archive).arg("-C").arg(company.join("untar")).output().unwrap();
	assert!(unpacked.status.success(), "{}", String::from_utf8_lossy(&unpacked.stderr));
	assert_eq!(node.target("untar/src/l").as_deref(), Some("f.txt"));
	assert_eq!(std::fs::read_to_string(company.join("untar/src/l")).unwrap(), "f");

	// The folder keeps text: a target that is not UTF-8 is refused.
	let latin1 = std::ffi::OsStr::from_bytes(b"caf\xe9");
	assert_eq!(std::os::unix::fs::symlink(latin1, docs.join("cafe")).unwrap_err().raw_os_error(), Some(libc::EINVAL));
	assert!(!node.exists("docs/cafe"));
	node.close_view();
	assert!(matches!(runner.join().unwrap(), Stop::ViewClosed));
}

#[test]
fn a_hard_link_is_a_file_of_its_own_and_a_read_of_its_source() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("a.md", "alpha", false);
	let (company, runner) = start(&node);
	let (a, b) = (company.join("a.md"), company.join("b.md"));

	// `ln a b`: the node copies a at the version shown, and the copy is logged as a read of a.
	assert!(Command::new("ln").arg(&a).arg(&b).status().unwrap().success());
	assert_eq!(node.links(), [LinkRequest { from: "a.md".into(), from_base: Some("v1".into()), to: "b.md".into() }]);
	assert_eq!(node.content("b.md").unwrap(), b"alpha");
	assert_eq!(node.logged(), [read("a.md", "v1")]);
	assert_eq!(std::fs::read_to_string(&b).unwrap(), "alpha");

	// Two files with one link each: a save to a never shows through b.
	let (ma, mb) = (std::fs::metadata(&a).unwrap(), std::fs::metadata(&b).unwrap());
	assert_eq!((ma.nlink(), mb.nlink()), (1, 1));
	assert_ne!(ma.ino(), mb.ino());
	std::fs::write(&a, "alpha two").unwrap();
	assert_eq!(node.content("a.md").unwrap(), b"alpha two");
	assert_eq!(node.content("b.md").unwrap(), b"alpha");
	assert_eq!(std::fs::read_to_string(&b).unwrap(), "alpha");
	std::fs::remove_file(&b).unwrap();
	assert_eq!(std::fs::read_to_string(&a).unwrap(), "alpha two");

	// A version the node no longer serves is not linked at a newer one. Linked through an open file's name in /proc, so
	// the kernel links the inode it holds: a lookup of `a.md` first would show the newer version, and link that.
	let held = std::fs::File::open(&a).unwrap();
	node.put_quietly("a.md", "theirs");
	let (source, to) = (c_path(Path::new(&format!("/proc/self/fd/{}", held.as_raw_fd()))), c_path(&company.join("c.md")));
	// SAFETY: paths from CString, and a plain linkat.
	assert_eq!(unsafe { libc::linkat(libc::AT_FDCWD, source.as_ptr(), libc::AT_FDCWD, to.as_ptr(), libc::AT_SYMLINK_FOLLOW) }, -1);
	assert_eq!(last_errno(), Some(libc::ESTALE));
	drop(held);
	assert!(!node.exists("c.md"));

	// A link's hard link is a link with the same target (`ln` does not follow it); a folder has none.
	std::os::unix::fs::symlink("a.md", company.join("l")).unwrap();
	std::fs::hard_link(company.join("l"), company.join("l2")).unwrap();
	assert_eq!(node.target("l2").as_deref(), Some("a.md"));
	assert!(std::fs::symlink_metadata(company.join("l2")).unwrap().file_type().is_symlink());
	std::fs::create_dir(company.join("d")).unwrap();
	assert_eq!(std::fs::hard_link(company.join("d"), company.join("d2")).unwrap_err().raw_os_error(), Some(libc::EPERM));
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
fn a_cache_move_whose_link_the_node_does_not_take_at_once_is_made_again() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("code/o/n/worktrees/w/README", "readme", false);
	node.put("code/o/n/repo.git/worktrees/w/HEAD", "ref: refs/heads/main\n", false);
	let (company, runner) = start(&node);
	// A cache with a file and a link to it, on the machine's disk.
	let modules = company.join("code/o/n/worktrees/w/node_modules");
	std::fs::create_dir(&modules).unwrap();
	std::fs::write(modules.join("x.js"), "cached").unwrap();
	std::os::unix::fs::symlink("x.js", modules.join("y.js")).unwrap();
	// Git comes to track both while a boundary settles: the node answers BUSY to the link.
	let git = company.join("code/o/n/repo.git/worktrees/w");
	std::fs::write(git.join("index.lock"), git_index(&["node_modules/x.js", "node_modules/y.js"])).unwrap();
	node.busy_links(1);
	std::fs::rename(git.join("index.lock"), git.join("index")).unwrap();
	// The move is not done while the link is not in the folder: it is tried again, and the link moves in.
	let moved = || node.target("code/o/n/worktrees/w/node_modules/y.js").as_deref() == Some("x.js");
	assert!(eventually(Duration::from_secs(20), moved), "the link did not move into the folder");
	assert_eq!(node.content("code/o/n/worktrees/w/node_modules/x.js").unwrap(), b"cached");
	assert_eq!(std::fs::read_link(modules.join("y.js")).unwrap(), Path::new("x.js"));
	node.close_view();
	assert!(matches!(runner.join().unwrap(), Stop::ViewClosed));
}

#[test]
fn a_cache_move_given_up_leaves_nothing_in_the_folder() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("code/o/n/worktrees/w/README", "readme", false);
	node.put("code/o/n/repo.git/worktrees/w/HEAD", "ref: refs/heads/main\n", false);
	let (company, runner) = start(&node);
	let modules = company.join("code/o/n/worktrees/w/node_modules");
	std::fs::create_dir(&modules).unwrap();
	std::fs::write(modules.join("x.js"), "cached").unwrap();
	// Git comes to track it while a boundary settles: the move's write of x.js is kept, its handle open at the node.
	let git = company.join("code/o/n/repo.git/worktrees/w");
	std::fs::write(git.join("index.lock"), git_index(&["node_modules/x.js"])).unwrap();
	node.busy(1_000_000, 0);
	std::fs::rename(git.join("index.lock"), git.join("index")).unwrap();
	assert!(eventually(Duration::from_secs(10), || node.open_handles() == 1));
	// The write is a draft: until the node takes its close, x.js is not in the folder.
	let (x, marker) = ("code/o/n/worktrees/w/node_modules/x.js", node.dir.join("state/caches.moving"));
	assert!(!node.exists(x) && marker.exists());
	// x.js leaves the machine's disk before the node takes a chunk: the move gives its write up, and the node answers
	// the first two discards BUSY. The handle is given up all the same, and nothing is left in the folder.
	node.busy_discards(2);
	std::fs::remove_file(node.dir.join("state/local/caches/d/code/d/o/d/n/d/worktrees/d/w/d/node_modules/t/x.js")).unwrap();
	let out = eventually(Duration::from_secs(30), || node.open_handles() == 0 && !marker.exists());
	assert!(out, "handles open at the node: {}, marker: {}", node.open_handles(), marker.exists());
	assert!(!node.exists(x) && node.busy_discards_left() == 0);
	node.close_view();
	assert!(matches!(runner.join().unwrap(), Stop::ViewClosed));
}

#[test]
fn caches_outside_the_code_areas_follow_the_rules_and_stay_on_the_machine() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("notes/readme", "readme", false);
	node.put("apps/web/package.json", "{}", false);
	let (company, runner) = start(&node);
	// A dependency folder is a cache anywhere, the top included (rule 2); a build folder beside a project file (rule 3).
	let cached = [".venv", "notes/node_modules", "apps/web/node_modules", "apps/web/build"];
	for dir in cached {
		std::fs::create_dir(company.join(dir)).unwrap();
		std::fs::write(company.join(dir).join("x"), dir).unwrap();
	}
	// Published: a build folder in a plain folder, a file of a cache's name and a name that differs in case (rule 5).
	std::fs::create_dir(company.join("notes/build")).unwrap();
	std::fs::write(company.join("apps/web/dist"), "a file").unwrap();
	std::fs::create_dir(company.join("apps/web/Build")).unwrap();
	for path in ["notes/build", "apps/web/dist", "apps/web/Build"] {
		assert!(node.exists(path), "{path} is not in the folder");
	}
	for dir in cached {
		assert!(!node.exists(dir) && !node.exists(&format!("{dir}/x")), "{dir} is in the folder");
		assert_eq!(std::fs::read_to_string(company.join(dir).join("x")).unwrap(), dir);
	}
	assert_eq!(names(&company.join("notes")), ["build", "node_modules", "readme"]);
	assert_eq!(names(&company.join("apps/web")), ["Build", "build", "dist", "node_modules", "package.json"]);
	// On the machine's disk, in the mirror of the node's folders (`local.rs`).
	let caches = node.dir.join("state/local/caches");
	assert_eq!(std::fs::read_to_string(caches.join("t/.venv/x")).unwrap(), ".venv");
	assert_eq!(std::fs::read_to_string(caches.join("d/apps/d/web/t/build/x")).unwrap(), "apps/web/build");
	node.close_view();
	assert!(matches!(runner.join().unwrap(), Stop::ViewClosed));
}

#[test]
fn nothing_crosses_the_edge_between_the_caches_and_the_folder() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("notes/readme", "readme", false);
	let (company, runner) = start(&node);
	let (notes, caches) = (company.join("notes"), node.dir.join("state/local/caches/d/notes"));
	std::fs::create_dir_all(notes.join("sub/node_modules/pkg")).unwrap();
	std::fs::write(notes.join("sub/node_modules/pkg/x.js"), "cached").unwrap();
	assert!(node.exists("notes/sub") && !node.exists("notes/sub/node_modules"));
	// A folder of the node's with caches in it is not empty, and its caches go with it when it is renamed.
	assert_eq!(std::fs::remove_dir(notes.join("sub")).unwrap_err().raw_os_error(), Some(libc::ENOTEMPTY));
	std::fs::rename(notes.join("sub"), notes.join("moved")).unwrap();
	let m = notes.join("moved");
	assert_eq!(std::fs::read_to_string(m.join("node_modules/pkg/x.js")).unwrap(), "cached");
	assert!(caches.join("d/moved/t/node_modules/pkg/x.js").exists() && !caches.join("d/sub").exists());
	// A rename or a hard link across the edge is EXDEV (`mv` copies): a cache's file or folder out of it, a cache to a
	// name that is none, a file of the folder's into a cache, and a folder of the node's onto a new cache's place.
	let exdev = |r: std::io::Result<()>| r.unwrap_err().raw_os_error() == Some(libc::EXDEV);
	assert!(exdev(std::fs::rename(m.join("node_modules/pkg/x.js"), m.join("x.js"))));
	assert!(exdev(std::fs::rename(m.join("node_modules/pkg"), m.join("pkg"))));
	assert!(exdev(std::fs::rename(m.join("node_modules"), m.join("modules"))));
	assert!(exdev(std::fs::rename(notes.join("readme"), m.join("node_modules/readme"))));
	std::fs::create_dir(m.join("lib")).unwrap();
	assert!(exdev(std::fs::rename(m.join("lib"), m.join(".venv"))));
	assert!(exdev(std::fs::hard_link(notes.join("readme"), m.join("node_modules/readme"))));
	assert!(exdev(std::fs::hard_link(m.join("node_modules/pkg/x.js"), m.join("x.js"))));
	assert!(node.links().is_empty() && node.exists("notes/readme") && node.exists("notes/moved/lib"));
	// Within the caches, links and renames are the disk's: a cache renamed to another cache's name stays one.
	std::fs::hard_link(m.join("node_modules/pkg/x.js"), m.join("node_modules/pkg/y.js")).unwrap();
	std::os::unix::fs::symlink("pkg/y.js", m.join("node_modules/z.js")).unwrap();
	std::fs::rename(m.join("node_modules"), m.join(".venv")).unwrap();
	assert_eq!(std::fs::read_to_string(m.join(".venv/z.js")).unwrap(), "cached");
	assert!(!node.exists("notes/moved/.venv") && caches.join("d/moved/t/.venv/pkg/y.js").exists());
	// rm -r empties the folder first, and its caches' mirror goes with it: made again, it is empty.
	std::fs::remove_dir_all(&m).unwrap();
	assert!(!node.exists("notes/moved") && !caches.join("d/moved").exists());
	std::fs::create_dir(&m).unwrap();
	assert!(names(&m).is_empty());
	node.close_view();
	assert!(matches!(runner.join().unwrap(), Stop::ViewClosed));
}

#[test]
fn the_nodes_entry_wins_and_a_folder_gone_from_the_node_takes_its_caches_along() {
	if !wanted() {
		return;
	}
	let node = FakeNode::writable();
	node.put("notes/readme", "readme", false);
	let (company, runner) = start(&node);
	let (notes, caches) = (company.join("notes"), node.dir.join("state/local/caches/d/notes"));
	for dir in ["node_modules", "a/.venv", "b/.venv"] {
		std::fs::create_dir_all(notes.join(dir)).unwrap();
		std::fs::write(notes.join(dir).join("x"), "cached").unwrap();
	}
	// Another view publishes a node_modules here: the node's is shown, and the cache goes at the next listing (rule 1).
	node.put("notes/node_modules/y", "published", false);
	assert!(eventually(Duration::from_secs(10), || names(&notes.join("node_modules")) == ["y"]));
	assert_eq!(names(&notes), ["a", "b", "node_modules", "readme"]);
	assert!(!caches.join("t/node_modules").exists());
	// Another view removes a and b: b made again here has none of its caches, and the next listing drops a's.
	node.remove("notes/a");
	node.remove("notes/b");
	assert!(eventually(Duration::from_secs(10), || !notes.join("b").exists()));
	std::fs::create_dir(notes.join("b")).unwrap();
	assert!(names(&notes.join("b")).is_empty() && !caches.join("d/b").exists());
	assert!(caches.join("d/a/t/.venv/x").exists());
	assert_eq!(names(&notes), ["b", "node_modules", "readme"]);
	assert!(!caches.join("d/a").exists());
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
