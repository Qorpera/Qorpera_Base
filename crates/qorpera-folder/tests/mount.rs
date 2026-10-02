//! The folder program mounted for real against a node stand-in. Needs root and /dev/fuse, so it runs only when
//! QORPERA_FOLDER_FUSE_TESTS=1 (the run-on-node step sets it, in a container given /dev/fuse); without it the
//! test says it was skipped.

mod support;

use qorpera_folder::link::{Link, View};
use qorpera_folder::mount::{self, Options, Stop};
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use support::{FakeNode, PASS, RESOURCE};

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

fn start_with(node: &FakeNode, reads: Option<UnixListener>) -> (PathBuf, std::thread::JoinHandle<Stop>) {
	let mountpoint = node.dir.join("company");
	std::fs::create_dir(&mountpoint).unwrap();
	let link = Link::new(
		node.addr.clone(),
		View { environment_id: "env".into(), view_id: "view".into(), pass: PASS.into() },
		4,
	);
	let options =
		Options { mountpoint: mountpoint.clone(), threads: 4, ttl: Duration::from_secs(3600), allow_other: false, reads };
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
	assert!(eventually(Duration::from_secs(5), || same.exists()));
	let mut held = std::fs::File::open(&same).unwrap();
	let mut first = vec![0u8; 4096];
	held.read_exact(&mut first).unwrap();
	assert!(first.iter().all(|&b| b == b'a'));
	node.put("docs/same.md", &"b".repeat(64 * 1024), false);
	assert!(eventually(Duration::from_secs(5), || std::fs::read(&same).ok().is_some_and(|v| v.iter().all(|&b| b == b'b'))));
	let mut rest = Vec::new();
	held.read_to_end(&mut rest).unwrap();
	assert_eq!(rest.len(), 64 * 1024 - 4096);
	assert!(rest.iter().all(|&b| b == b'a'), "the open file read the newer version");
	let fresh = std::fs::read(&same).unwrap();
	assert!(fresh.iter().all(|&b| b == b'b'), "a new reader saw the older version's pages");
	drop(held);

	// A change on the node shows at once, cached pages included.
	node.put("docs/plan.md", "the plan, version two, longer", false);
	assert!(eventually(Duration::from_secs(5), || std::fs::read_to_string(&plan).ok().as_deref()
		== Some("the plan, version two, longer")));
	node.put("docs/new.md", "new", false);
	assert!(eventually(Duration::from_secs(5), || names(&company.join("docs")) == ["new.md", "plan.md", "same.md"]));
	node.remove("readme.md");
	assert!(eventually(Duration::from_secs(5), || {
		std::fs::metadata(company.join("readme.md")).err().map(|e| e.kind()) == Some(ErrorKind::NotFound)
	}));

	// The feed breaks: a change it missed still shows once it is back, because the program drops its caches.
	node.drop_feeds();
	node.put_quietly("docs/new.md", "changed while the feed was down");
	assert!(eventually(Duration::from_secs(5), || node.feeds() == 1), "the feed did not come back");
	assert!(eventually(Duration::from_secs(5), || std::fs::read_to_string(company.join("docs/new.md")).ok().as_deref()
		== Some("changed while the feed was down")));

	// The node closes the view: the folder program unmounts and says why.
	node.close_view();
	let stop = runner.join().unwrap();
	assert!(matches!(stop, Stop::ViewClosed), "{stop:?}");
	assert!(!mounted(&company));
}

/// The run's native host's side of the read log: everything waiting, page by page, then acknowledged.
fn take(socket: &Path) -> Vec<serde_json::Value> {
	let mut stream = UnixStream::connect(socket).unwrap();
	let mut reader = BufReader::new(stream.try_clone().unwrap());
	let mut ask = |request: String| {
		stream.write_all(format!("{request}\n").as_bytes()).unwrap();
		let mut line = String::new();
		reader.read_line(&mut line).unwrap();
		serde_json::from_str::<serde_json::Value>(&line).unwrap()
	};
	let mut out = Vec::new();
	let mut after = 0;
	let mut log;
	loop {
		let answer = ask(format!("{{\"t\":\"take\",\"after\":{after},\"max\":2}}"));
		assert_eq!(answer["t"], "reads");
		log = answer["log"].as_str().unwrap().to_string();
		let page = answer["reads"].as_array().unwrap().clone();
		if let Some(last) = page.last() {
			after = last["seq"].as_u64().unwrap();
		}
		out.extend(page);
		if answer["more"] == false {
			break;
		}
	}
	if after > 0 {
		assert_eq!(ask(format!("{{\"t\":\"ack\",\"log\":\"{log}\",\"upTo\":{after}}}"))["t"], "acked");
	}
	out
}

fn read_paths(reads: &[serde_json::Value]) -> Vec<String> {
	reads.iter().map(|r| format!("{} {}", r["path"].as_str().unwrap(), r["version"].as_str().unwrap())).collect()
}

#[test]
fn a_run_box_mount_logs_every_open_and_listing_until_its_host_takes_them() {
	if !wanted() {
		return;
	}
	let node = FakeNode::start();
	node.put("docs/plan.md", "the plan", false);
	node.put("readme.md", "hi", false);
	let socket = node.dir.join("reads.sock");
	let (company, runner) = start_with(&node, Some(UnixListener::bind(&socket).unwrap()));

	assert_eq!(names(&company.join("docs")), ["plan.md"]);
	assert_eq!(std::fs::read_to_string(company.join("docs/plan.md")).unwrap(), "the plan");
	assert_eq!(std::fs::read_to_string(company.join("docs/plan.md")).unwrap(), "the plan");
	let reads = take(&socket);
	// The folder listed and the file opened, once each; the root and the second, cached open add nothing.
	assert_eq!(read_paths(&reads), ["docs v1", "docs/plan.md v1"]);
	assert_eq!(reads[1]["kind"], "file");
	assert_eq!(reads[1]["authority"]["resourceId"], RESOURCE);
	assert_eq!(reads[1]["authority"]["resourceRevision"], 1);
	assert!(take(&socket).is_empty(), "acknowledged reads leave the log");

	// The next answer's command reads the same file from the page cache: still its read. A new version is another.
	assert_eq!(std::fs::read_to_string(company.join("docs/plan.md")).unwrap(), "the plan");
	node.put("docs/plan.md", "the plan, again", false);
	let plan = company.join("docs/plan.md");
	assert!(eventually(Duration::from_secs(5), || std::fs::read_to_string(&plan).ok().as_deref() == Some("the plan, again")));
	assert_eq!(read_paths(&take(&socket)), ["docs/plan.md v1", "docs/plan.md v2"]);

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
		Options { mountpoint: mountpoint.clone(), threads: 2, ttl: Duration::from_secs(1), allow_other: false, reads: None };
	match mount::run(link, options) {
		Err(mount::Failed::View(_)) => {}
		other => panic!("{other:?}"),
	}
	assert!(!mounted(&mountpoint));
}
