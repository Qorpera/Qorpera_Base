//! The folder program mounted for real against a node stand-in. Needs root and /dev/fuse, so it runs only when
//! QORPERA_FOLDER_FUSE_TESTS=1 (the run-on-node step sets it, in a container given /dev/fuse); without it the
//! test says it was skipped.

mod support;

use qorpera_folder::link::{Link, View};
use qorpera_folder::mount::{self, Options, Stop};
use std::io::ErrorKind;
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
	let mountpoint = node.dir.join("company");
	std::fs::create_dir(&mountpoint).unwrap();
	let link = Link::new(
		node.addr.clone(),
		View { environment_id: "env".into(), view_id: "view".into(), pass: PASS.into() },
		4,
	);
	let options = Options { mountpoint: mountpoint.clone(), threads: 4, ttl: Duration::from_secs(3600), allow_other: false };
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

	// A change on the node shows at once, cached pages included.
	node.put("docs/plan.md", "the plan, version two, longer", false);
	assert!(eventually(Duration::from_secs(2), || std::fs::read_to_string(&plan).ok().as_deref()
		== Some("the plan, version two, longer")));
	node.put("docs/new.md", "new", false);
	assert!(eventually(Duration::from_secs(2), || names(&company.join("docs")) == ["new.md", "plan.md"]));
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
	let options = Options { mountpoint: mountpoint.clone(), threads: 2, ttl: Duration::from_secs(1), allow_other: false };
	match mount::run(link, options) {
		Err(mount::Failed::View(_)) => {}
		other => panic!("{other:?}"),
	}
	assert!(!mounted(&mountpoint));
}
