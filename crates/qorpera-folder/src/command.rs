//! `qorpera-folder command`: the folder helper's per-command child, which starts one office command with its own
//! company mount at `/company` (deploy/first-node/RUNTIME-FOLDER-COMPANY-MACHINES.md, "Who makes the namespaces").
//!
//! The helper runs it as root in the initial user namespace. This process (A) pins the shell through a pidfd and checks
//! that it is the office account's sandbox, moves into the shell's cgroup, and joins the shell's mount, pid, uts, ipc
//! and cgroup namespaces, plus the computer's network namespace for a networked command. A never joins the shell's
//! user namespace. Its child (B) chroots into the shell's root, makes a mount namespace (and an offline command's
//! network namespace with only `lo`) owned by the initial user namespace, attaches the command's tree at
//! `/run/qorpera-company`, and closes every fd but stdio and the shell's user namespace. Still root in the initial user
//! namespace, B drops to the office account with no capabilities, and only then joins the shell's user namespace, as a
//! member like the shell's own commands and never its parent, so the owner rule of user_namespaces(7) gives it nothing
//! over the shell's namespaces (option (c'), coordinator 15 Oct). In there it takes the shell's bounding set, locks
//! SECBIT_NOROOT, holds no capabilities, sets no_new_privs and the command filter, and execs in `/company`. A stays to
//! report the start and the end on fd 3, and to stop the command.
//!
//! B runs nothing of the command's until the helper lets it: once the tree is attached, A reports the command's pid and
//! mount namespace (`started`), so the namespace on record already names its command, and lets B go on only after the
//! helper answers `G` on fd 4, which it does once that namespace is on record. A helper that gives up on the start, or
//! goes, closes fd 4: A then kills B and reaps it, and B, which waits on a pipe only A writes, ends by itself if A was
//! killed. So a command never runs that the helper can't account for.
//!
//! Joining a user namespace needs a single-threaded process with an fs of its own (`userns_install`). This program
//! starts no thread, and B is forked from A without CLONE_FS, so B makes every step from the fork to the exec itself.

#[cfg(not(target_arch = "x86_64"))]
compile_error!("the command filter checks the x86_64 audit architecture and syscall numbers");

use std::ffi::{CStr, CString};
use std::io::{self, Read};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::time::{Duration, Instant};

/// The account every office command runs as.
const OFFICE_ACCOUNT: &CStr = c"qorpera-office";
/// The command's mount parent in the shell's root. The shell links `/company` to its `company` child.
const COMPANY_PARENT: [&CStr; 2] = [c"run", c"qorpera-company"];
const COMPANY: &CStr = c"/company";
/// The office unit's RestrictAddressFamilies (qorpera-company-computer.service). A command ends on this set, never
/// wider: the helper unit adds AF_VSOCK, and the command filter takes it away.
pub const FAMILIES: [libc::c_int; 4] = [libc::AF_UNIX, libc::AF_INET, libc::AF_INET6, libc::AF_NETLINK];
/// The shell's environment, which becomes the command's, is read from `/proc/<shell>/environ` up to this size.
const ENVIRON_LIMIT: usize = 65536;
/// From the fork to the exec. Past it the start has failed and B is killed.
const START_DEADLINE: Duration = Duration::from_secs(20);
/// A stop is the shell host's: SIGTERM to the command's process group, then SIGKILL this much later.
const STOP_GRACE: Duration = Duration::from_secs(2);
/// Where the helper reads reports. In B it is the start pipe, so it closes at the exec.
const REPORTS: RawFd = 3;
/// Where the helper lets the command run: one `G`, once it recorded the command's mount namespace. Without it (end of
/// file, or the helper gone) A stops B before the exec.
const GO: RawFd = 4;

const AUDIT_ARCH_X86_64: u32 = 0xC000_003E;
const X32_SYSCALL_BIT: u32 = 0x4000_0000;
const CAPABILITY_VERSION_3: u32 = 0x2008_0522;
/// SECBIT_NOROOT | SECBIT_NOROOT_LOCKED: an exec as uid 0 gains no capabilities, and the bit can't be cleared. The
/// backstop only: B refuses to be uid 0 in the shell's user namespace in the first place.
const SECUREBITS_LOCKED_NOROOT: libc::c_ulong = 0b11;

/// What the helper asks for. `argv[0]` is the program, an absolute path in the shell's root.
pub struct Request {
	pub shell_pid: libc::pid_t,
	pub tree: CString,
	pub network: bool,
	pub argv: Vec<CString>,
}

/// One report line on fd 3. `Started` comes before the exec, when B is ready to run (its pid and mount namespace are
/// the command's), and `Failed` may come after it.
enum Report<'a> {
	Started { pid: libc::pid_t, mntns: u64 },
	Exit { code: Option<i32>, signal: Option<String> },
	Failed(&'a str),
}

fn report(event: Report) {
	let value = match event {
		Report::Started { pid, mntns } => serde_json::json!({ "t": "started", "pid": pid, "mntns": mntns }),
		Report::Exit { code, signal } => serde_json::json!({ "t": "exit", "code": code, "signal": signal }),
		Report::Failed(error) => serde_json::json!({ "t": "failed", "error": error }),
	};
	let line = format!("{value}\n");
	let mut bytes = line.as_bytes();
	while !bytes.is_empty() {
		// SAFETY: writes from a live buffer. A helper that is gone (EPIPE; Rust ignores SIGPIPE) changes nothing here.
		let n = unsafe { libc::write(REPORTS, bytes.as_ptr().cast(), bytes.len()) };
		if n < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
			continue;
		}
		if n <= 0 {
			return;
		}
		bytes = &bytes[n as usize..];
	}
}

fn os(step: &str) -> String {
	format!("{step}: {}", io::Error::last_os_error())
}

/// A libc or raw syscall return: -1 is a failure with errno.
fn cvt<T: Copy + PartialEq + From<i8>>(ret: T, step: &str) -> Result<T, String> {
	if ret == T::from(-1) { Err(os(step)) } else { Ok(ret) }
}

fn fd(ret: libc::c_long, step: &str) -> Result<OwnedFd, String> {
	let raw = cvt(ret, step)?;
	// SAFETY: a new fd the call just returned, owned by nobody else.
	Ok(unsafe { OwnedFd::from_raw_fd(raw as RawFd) })
}

fn open_at(dir: &OwnedFd, name: &CStr, flags: libc::c_int) -> Result<OwnedFd, String> {
	// SAFETY: a live dirfd and a NUL-terminated name.
	let raw = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags | libc::O_CLOEXEC) };
	fd(raw.into(), &format!("open {}", name.to_string_lossy()))
}

fn open_path(path: &CStr, flags: libc::c_int) -> Result<OwnedFd, String> {
	// SAFETY: a NUL-terminated path.
	let raw = unsafe { libc::open(path.as_ptr(), flags | libc::O_CLOEXEC) };
	fd(raw.into(), &format!("open {}", path.to_string_lossy()))
}

fn read_at(dir: &OwnedFd, name: &CStr, limit: usize) -> Result<Vec<u8>, String> {
	let mut bytes = Vec::new();
	std::fs::File::from(open_at(dir, name, libc::O_RDONLY)?)
		.take(limit as u64 + 1)
		.read_to_end(&mut bytes)
		.map_err(|e| format!("read {}: {e}", name.to_string_lossy()))?;
	if bytes.len() > limit {
		return Err(format!("{} is over {limit} bytes", name.to_string_lossy()));
	}
	Ok(bytes)
}

/// Sets this thread's fs uid, which the kernel's file permission checks use, and checks it took: setfsuid returns the
/// previous fs uid either way, and an invalid id (`u32::MAX`) changes nothing, so the second call reads it back.
fn set_fsuid(uid: u32) -> Result<(), String> {
	// SAFETY: setfsuid changes only the calling thread's fs uid, and the launcher has one thread.
	let now = unsafe {
		libc::setfsuid(uid);
		libc::setfsuid(u32::MAX)
	};
	if now as u32 != uid {
		return Err(format!("set the fs uid to {uid}"));
	}
	Ok(())
}

/// A file only its owner may read, such as `/proc/<pid>/environ` (0400, the process's own uid): A holds no CAP_DAC_*,
/// so it opens it with the owner's fs uid and then takes root's back. The kernel's ptrace check on the same open passes
/// on CAP_SYS_PTRACE, which the fs uid doesn't touch.
fn read_as(dir: &OwnedFd, name: &CStr, limit: usize, uid: u32) -> Result<Vec<u8>, String> {
	set_fsuid(uid)?;
	let read = read_at(dir, name, limit);
	set_fsuid(0)?;
	read
}

fn stat_of(fd: &OwnedFd, step: &str) -> Result<libc::stat, String> {
	// SAFETY: fstat fills a zeroed stat from a live fd.
	unsafe {
		let mut st: libc::stat = std::mem::zeroed();
		cvt(libc::fstat(fd.as_raw_fd(), &mut st), step)?;
		Ok(st)
	}
}

/// The capability sets of `/proc/<pid>/status`, as masks.
#[derive(Debug, Default, PartialEq)]
struct Caps {
	inheritable: u64,
	permitted: u64,
	effective: u64,
	bounding: u64,
	ambient: u64,
}

#[derive(Debug, Default, PartialEq)]
struct Status {
	uid: Vec<u32>,
	gid: Vec<u32>,
	nspid: Vec<u32>,
	caps: Caps,
}

fn numbers(value: &str) -> Option<Vec<u32>> {
	value.split_whitespace().map(|n| n.parse().ok()).collect()
}

fn mask(value: &str) -> Option<u64> {
	u64::from_str_radix(value.trim(), 16).ok()
}

fn parse_status(text: &str) -> Result<Status, String> {
	let mut status = Status::default();
	let mut seen = 0u8;
	for line in text.lines() {
		let Some((key, value)) = line.split_once(':') else { continue };
		let (bit, parsed) = match key {
			"Uid" => (0, numbers(value).map(|v| status.uid = v)),
			"Gid" => (1, numbers(value).map(|v| status.gid = v)),
			"NSpid" => (2, numbers(value).map(|v| status.nspid = v)),
			"CapInh" => (3, mask(value).map(|v| status.caps.inheritable = v)),
			"CapPrm" => (4, mask(value).map(|v| status.caps.permitted = v)),
			"CapEff" => (5, mask(value).map(|v| status.caps.effective = v)),
			"CapBnd" => (6, mask(value).map(|v| status.caps.bounding = v)),
			"CapAmb" => (7, mask(value).map(|v| status.caps.ambient = v)),
			_ => continue,
		};
		if parsed.is_none() {
			return Err(format!("the shell's status has an unreadable {key} line"));
		}
		seen |= 1 << bit;
	}
	if seen != u8::MAX {
		return Err("the shell's status lacks an id, NSpid or capability line".into());
	}
	Ok(status)
}

/// The shell is the office account's (every real, effective, saved and file-system id), the init of a pid namespace
/// of its own, and holds no capability. The office's bwrap leaves its sandbox none, and the command holds none in the
/// same user namespace, so a shell with any is not the office's and is refused. Its bounding set is what the command
/// gets.
fn check_shell(status: &Status, uid: u32, gid: u32) -> Result<(), String> {
	let all = |ids: &[u32], id: u32| ids.len() == 4 && ids.iter().all(|&i| i == id);
	if !all(&status.uid, uid) || !all(&status.gid, gid) {
		return Err("the shell is not the office account's".into());
	}
	if status.nspid.len() < 2 || status.nspid.last() != Some(&1) {
		return Err("the shell is not the init of a pid namespace of its own".into());
	}
	let caps = &status.caps;
	if caps.inheritable | caps.permitted | caps.effective | caps.ambient != 0 {
		return Err("the shell holds capabilities".into());
	}
	Ok(())
}

/// The cgroup v2 path in `/proc/<pid>/cgroup`, as the initial cgroup namespace sees it.
fn parse_cgroup(text: &str) -> Result<String, String> {
	let path = text.lines().find_map(|line| line.strip_prefix("0::")).ok_or("the shell has no cgroup v2 path")?;
	if !path.starts_with('/') || path.split('/').any(|part| part == "..") {
		return Err("the shell's cgroup path is not plain".into());
	}
	Ok(path.to_string())
}

/// `/proc/<pid>/environ`: NUL-separated `NAME=value` entries.
fn parse_environ(bytes: &[u8]) -> Result<Vec<CString>, String> {
	bytes
		.split(|&b| b == 0)
		.filter(|entry| !entry.is_empty())
		.map(|entry| match entry.iter().position(|&b| b == b'=') {
			Some(at) if at > 0 => Ok(CString::new(entry).expect("split at every NUL")),
			_ => Err("the shell's environment has an entry without a name".to_string()),
		})
		.collect()
}

fn office_ids() -> Result<(u32, u32), String> {
	// SAFETY: getpwnam_r fills `entry` from `buffer`, both live for the call; only the ids are read after it.
	unsafe {
		let mut entry: libc::passwd = std::mem::zeroed();
		let mut buffer = vec![0 as libc::c_char; 16384];
		let mut found: *mut libc::passwd = std::ptr::null_mut();
		let error = libc::getpwnam_r(OFFICE_ACCOUNT.as_ptr(), &mut entry, buffer.as_mut_ptr(), buffer.len(), &mut found);
		if error != 0 || found.is_null() {
			return Err("the office account is missing".into());
		}
		Ok((entry.pw_uid, entry.pw_gid))
	}
}

/// The office account's ids in the shell's user namespace may be neither root nor the kernel's overflow ids (unmapped):
/// either would make the command something other than the shell's own commands, and a later exec as uid 0 would get
/// its capabilities back (no_new_privs doesn't stop that).
fn check_inside(uids: [u32; 3], gids: [u32; 3], overflow: (u32, u32)) -> Result<(), String> {
	if uids.iter().any(|&id| id == 0 || id == overflow.0) || gids.iter().any(|&id| id == 0 || id == overflow.1) {
		return Err(format!("the office account is {uids:?}/{gids:?} in the shell's user namespace"));
	}
	Ok(())
}

/// What A takes from the shell, and from the helper's own view, before it joins the shell.
struct Prepared {
	uid: u32,
	gid: u32,
	/// `/proc/sys/kernel/overflowuid` and `overflowgid`: what an unmapped id reads as.
	overflow: (u32, u32),
	bounding: u64,
	cgroup: String,
	env: Vec<CString>,
	pidfd: OwnedFd,
	root: OwnedFd,
	namespaces: Vec<(OwnedFd, libc::c_int)>,
	/// The shell's user namespace, which only B joins, once it is unprivileged.
	user: OwnedFd,
	/// The helper's /proc (the initial pid namespace's), to read B's mount namespace once B has made it.
	proc: OwnedFd,
	null: OwnedFd,
	tree: OwnedFd,
}

fn alive(pidfd: &OwnedFd) -> Result<(), String> {
	// SAFETY: signal 0 through a live pidfd only checks that the process still runs.
	let sent = unsafe { libc::syscall(libc::SYS_pidfd_send_signal, pidfd.as_raw_fd(), 0, std::ptr::null::<libc::siginfo_t>(), 0) };
	cvt(sent, "the shell ended").map(drop)
}

fn prepare(request: &Request) -> Result<Prepared, String> {
	let (uid, gid) = office_ids()?;
	// Pin the shell first: if the process still runs once /proc/<pid> is open, that directory is the shell's, whatever
	// later takes the pid.
	// SAFETY: pidfd_open with a pid and no flags.
	let pidfd = fd(unsafe { libc::syscall(libc::SYS_pidfd_open, request.shell_pid, 0) }, "pin the shell")?;
	let proc = open_path(c"/proc", libc::O_PATH | libc::O_DIRECTORY)?;
	let shell = open_at(&proc, &CString::new(request.shell_pid.to_string()).expect("digits"), libc::O_PATH | libc::O_DIRECTORY)?;
	alive(&pidfd)?;

	let status = parse_status(&String::from_utf8_lossy(&read_at(&shell, c"status", 65536)?))?;
	check_shell(&status, uid, gid)?;
	let own_user = open_path(c"/proc/self/ns/user", libc::O_RDONLY)?;
	let shell_user = open_at(&shell, c"ns/user", libc::O_RDONLY)?;
	let (own, theirs) = (stat_of(&own_user, "own user namespace")?, stat_of(&shell_user, "the shell's user namespace")?);
	if (own.st_dev, own.st_ino) == (theirs.st_dev, theirs.st_ino) {
		return Err("the shell is in the initial user namespace".into());
	}
	let mut owner: libc::uid_t = libc::uid_t::MAX;
	// SAFETY: NS_GET_OWNER_UID writes one uid_t.
	cvt(unsafe { libc::ioctl(shell_user.as_raw_fd(), libc::NS_GET_OWNER_UID, &raw mut owner) }, "the shell's user namespace owner")?;
	if owner != uid {
		return Err("the shell's user namespace is not the office account's".into());
	}
	let overflow = (overflow_id(&proc, c"sys/kernel/overflowuid")?, overflow_id(&proc, c"sys/kernel/overflowgid")?);
	let cgroup = parse_cgroup(&String::from_utf8_lossy(&read_at(&shell, c"cgroup", 65536)?))?;
	let env = parse_environ(&read_as(&shell, c"environ", ENVIRON_LIMIT, uid)?)?;
	let root = open_at(&shell, c"root", libc::O_PATH | libc::O_DIRECTORY)?;
	let mut namespaces = Vec::new();
	let kinds = [
		(c"ns/mnt", libc::CLONE_NEWNS),
		(c"ns/pid", libc::CLONE_NEWPID),
		(c"ns/uts", libc::CLONE_NEWUTS),
		(c"ns/ipc", libc::CLONE_NEWIPC),
		(c"ns/cgroup", libc::CLONE_NEWCGROUP),
		(c"ns/net", libc::CLONE_NEWNET),
	];
	for (name, kind) in kinds {
		if kind != libc::CLONE_NEWNET || request.network {
			namespaces.push((open_at(&shell, name, libc::O_RDONLY)?, kind));
		}
	}
	let null = open_path(c"/dev/null", libc::O_RDWR)?;
	// A recursive clone of the command's mount parent, from the helper's mount namespace. The helper made it shared, so
	// its remounts reach the clone.
	let flags = libc::OPEN_TREE_CLONE | libc::OPEN_TREE_CLOEXEC | libc::AT_RECURSIVE as libc::c_uint;
	// SAFETY: open_tree with a NUL-terminated path.
	let tree = fd(unsafe { libc::syscall(libc::SYS_open_tree, libc::AT_FDCWD, request.tree.as_ptr(), flags) }, "clone the command's tree")?;
	alive(&pidfd)?;
	let bounding = status.caps.bounding;
	Ok(Prepared { uid, gid, overflow, bounding, cgroup, env, pidfd, root, namespaces, user: shell_user, proc, null, tree })
}

fn overflow_id(proc: &OwnedFd, name: &CStr) -> Result<u32, String> {
	let text = read_at(proc, name, 32)?;
	String::from_utf8_lossy(&text).trim().parse().map_err(|_| format!("{} is not a number", name.to_string_lossy()))
}

/// Into the shell's cgroup first, so the office's stop reaches A, B and the command, and a helper restart doesn't.
/// Then the shell's namespaces; the pid namespace applies to A's children.
fn join(prepared: &mut Prepared) -> Result<(), String> {
	let procs = format!("/sys/fs/cgroup{}/cgroup.procs", prepared.cgroup);
	// SAFETY: getpid has no preconditions.
	let pid = unsafe { libc::getpid() };
	std::fs::write(&procs, format!("{pid}\n")).map_err(|e| format!("move into the shell's cgroup: {e}"))?;
	for (ns, kind) in prepared.namespaces.drain(..) {
		// SAFETY: setns with a live namespace fd and its type.
		cvt(unsafe { libc::setns(ns.as_raw_fd(), kind) }, "join the shell's namespaces")?;
	}
	Ok(())
}

/// Classic BPF for the command, on top of the helper unit's own filters: `clone3`, any other architecture and any x32
/// number are ENOSYS (callers fall back to `clone`, which the flag check covers), every `setns` is EPERM whatever its
/// fd (defense in depth: a command joins no namespace), `unshare` or `clone` with CLONE_NEWUSER is EPERM, and `socket`
/// outside `families` is EAFNOSUPPORT. Everything else is allowed. The program is #1097's proof's, row for row.
pub fn command_filter(families: &[libc::c_int]) -> Vec<libc::sock_filter> {
	const LD_W_ABS: u16 = 0x20;
	const JEQ_K: u16 = 0x15;
	const JGE_K: u16 = 0x35;
	const JSET_K: u16 = 0x45;
	const RET_K: u16 = 0x06;
	#[derive(Clone, Copy, PartialEq)]
	enum Label {
		Next,
		Flags,
		Eperm,
		Enosys,
		Allow,
	}
	enum Op {
		Plain(u16, u32),
		Jump(u16, u32, Label, Label),
		Mark(Label),
	}
	use Label::*;
	let mut ops = vec![
		Op::Plain(LD_W_ABS, 4), // the architecture
		Op::Jump(JEQ_K, AUDIT_ARCH_X86_64, Next, Enosys),
		Op::Plain(LD_W_ABS, 0), // the syscall number
		Op::Jump(JGE_K, X32_SYSCALL_BIT, Enosys, Next),
		Op::Jump(JEQ_K, libc::SYS_clone3 as u32, Enosys, Next),
		Op::Jump(JEQ_K, libc::SYS_setns as u32, Eperm, Next),
		Op::Jump(JEQ_K, libc::SYS_unshare as u32, Flags, Next),
		Op::Jump(JEQ_K, libc::SYS_clone as u32, Flags, Next),
		Op::Jump(JEQ_K, libc::SYS_socket as u32, Next, Allow),
		Op::Plain(LD_W_ABS, 16), // socket's family: the low half of the first argument
	];
	for &family in families {
		ops.push(Op::Jump(JEQ_K, family as u32, Allow, Next));
	}
	ops.extend([
		Op::Plain(RET_K, libc::SECCOMP_RET_ERRNO | libc::EAFNOSUPPORT as u32),
		Op::Mark(Flags),
		Op::Plain(LD_W_ABS, 16), // the flags of unshare and clone: the low half of the first argument
		Op::Jump(JSET_K, libc::CLONE_NEWUSER as u32, Eperm, Allow),
		Op::Mark(Eperm),
		Op::Plain(RET_K, libc::SECCOMP_RET_ERRNO | libc::EPERM as u32),
		Op::Mark(Enosys),
		Op::Plain(RET_K, libc::SECCOMP_RET_ERRNO | libc::ENOSYS as u32),
		Op::Mark(Allow),
		Op::Plain(RET_K, libc::SECCOMP_RET_ALLOW),
	]);
	let mut marks = Vec::new();
	let mut index = 0usize;
	for op in &ops {
		match op {
			Op::Mark(label) => marks.push((*label, index)),
			_ => index += 1,
		}
	}
	let mut program = Vec::new();
	for op in &ops {
		let here = program.len();
		let offset = |label: Label| -> u8 {
			match marks.iter().find(|(mark, _)| *mark == label) {
				None => 0,
				Some(&(_, at)) => u8::try_from(at - here - 1).expect("a filter jump fits in 8 bits"),
			}
		};
		match *op {
			Op::Plain(code, k) => program.push(libc::sock_filter { code, jt: 0, jf: 0, k }),
			Op::Jump(code, k, jt, jf) => program.push(libc::sock_filter { code, jt: offset(jt), jf: offset(jf), k }),
			Op::Mark(_) => {}
		}
	}
	program
}

#[repr(C)]
struct CapHeader {
	version: u32,
	pid: libc::c_int,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CapData {
	effective: u32,
	permitted: u32,
	inheritable: u32,
}

/// Everything B needs, made before the fork.
struct Child<'a> {
	prepared: &'a Prepared,
	network: bool,
	start: RawFd,
	ack: RawFd,
	/// A's end of the ack pipe, which B closes first: once A is gone, B's read of the ack sees end of file.
	answer: RawFd,
	program: &'a CStr,
	argv: Vec<*const libc::c_char>,
	env: Vec<*const libc::c_char>,
	filter: Vec<libc::sock_filter>,
}

/// A failure in B goes to A on the start pipe as `E<step>: <error>`, and B ends.
fn fail(start: RawFd, error: &str) -> ! {
	let line = format!("E{error}");
	// SAFETY: a write from a live buffer, then _exit, which runs nothing of this process's.
	unsafe {
		libc::write(start, line.as_ptr().cast(), line.len());
		libc::_exit(1)
	}
}

/// B, from the fork to the exec: in the shell's pid namespace (A's setns applies to its children), root in the initial
/// user namespace until the drop, and only then a member of the shell's user namespace. The start pipe takes fd 3
/// first: B never uses its copy of the helper's report pipe, and fd 3 closes at the exec.
fn child(c: &Child) -> ! {
	// SAFETY: close and dup3 of live fds.
	unsafe { libc::close(c.answer) };
	if unsafe { libc::dup3(c.start, REPORTS, libc::O_CLOEXEC) } == -1 {
		fail(c.start, &os("keep the start pipe"));
	}
	match child_steps(c) {
		Ok(never) => match never {},
		Err(error) => fail(REPORTS, &error),
	}
}

fn child_steps(c: &Child) -> Result<std::convert::Infallible, String> {
	let p = c.prepared;
	// SAFETY: plain syscalls on live fds, NUL-terminated paths and live structs; B has one thread, as A had at the fork.
	unsafe {
		// Its own session and process group: a stop signals the group.
		cvt(libc::setsid(), "setsid")?;
		cvt(libc::fchdir(p.root.as_raw_fd()), "enter the shell's root")?;
		cvt(libc::chroot(c".".as_ptr()), "chroot into the shell's root")?;
		cvt(libc::chdir(c"/".as_ptr()), "chdir /")?;
		// The command's own mount namespace, and an offline command's own network namespace: both owned by the initial
		// user namespace, so the office account can change neither. Private, so nothing attached here reaches the
		// shell.
		cvt(libc::unshare(libc::CLONE_NEWNS | if c.network { 0 } else { libc::CLONE_NEWNET }), "unshare")?;
		cvt(libc::mount(std::ptr::null(), c"/".as_ptr(), std::ptr::null(), libc::MS_REC | libc::MS_PRIVATE, std::ptr::null()), "make / private")?;
		if !c.network {
			loopback_up()?;
		}
		// The shell's root belongs to the office account: find the mount parent one name at a time, following no link
		// and no `..` (openat2 with RESOLVE_IN_ROOT would, but the helper unit's RestrictSUIDSGID filter answers openat2
		// with ENOSYS), and attach the tree to it by fd. The attached copy only receives the helper's remounts.
		let mut target = open_path(c"/", libc::O_PATH | libc::O_DIRECTORY)?;
		for name in COMPANY_PARENT {
			target = open_at(&target, name, libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW)?;
		}
		let empty = c"".as_ptr();
		let flags = libc::MOVE_MOUNT_F_EMPTY_PATH | libc::MOVE_MOUNT_T_EMPTY_PATH;
		cvt(libc::syscall(libc::SYS_move_mount, p.tree.as_raw_fd(), empty, target.as_raw_fd(), empty, flags), "attach the command's tree")?;
		let attr = libc::mount_attr { attr_set: 0, attr_clr: 0, propagation: libc::MS_SLAVE, userns_fd: 0 };
		let flags = (libc::AT_EMPTY_PATH | libc::AT_RECURSIVE) as libc::c_uint;
		let size = std::mem::size_of::<libc::mount_attr>();
		cvt(libc::syscall(libc::SYS_mount_setattr, p.tree.as_raw_fd(), empty, flags, &raw const attr, size), "make the command's tree a slave")?;
		drop(target);
		// A reads this mount namespace's inode through its own /proc and reports it, and answers once the helper let the
		// command go. The tree is attached first: from the report on, the namespace's own mount table names its command,
		// which is how the helper's `ended` tells it from a namespace whose inode was used again. Until the answer B runs
		// only this program.
		cvt(libc::write(REPORTS, b"U".as_ptr().cast(), 1), "report the mount namespace")?;
		let mut ack = 0u8;
		if libc::read(c.ack, (&raw mut ack).cast(), 1) != 1 {
			return Err("no answer from the launcher".into());
		}
		// Only stdio, the start pipe and the shell's user namespace stay open. The namespace's fd closes once B joined,
		// and the pipe at the exec. Fds 0 to 4 were open before A opened anything, so the namespace's is above them, and
		// the helper's fd 4 closes here.
		let user = p.user.as_raw_fd() as libc::c_uint;
		if user > REPORTS as libc::c_uint + 1 {
			cvt(libc::syscall(libc::SYS_close_range, REPORTS as libc::c_uint + 1, user - 1, 0), "close every other fd")?;
		}
		cvt(libc::syscall(libc::SYS_close_range, user + 1, libc::c_uint::MAX, 0), "close every other fd")?;
		drop_privileges(p)?;
		cvt(libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0), "no_new_privs")?;
		let program = libc::sock_fprog { len: c.filter.len() as libc::c_ushort, filter: c.filter.as_ptr().cast_mut() };
		cvt(libc::syscall(libc::SYS_seccomp, libc::SECCOMP_SET_MODE_FILTER, 0, &raw const program), "the command filter")?;
		// Rust ignores SIGPIPE, and an ignored signal stays ignored across exec. A blocked the signals it waits for.
		libc::signal(libc::SIGPIPE, libc::SIG_DFL);
		let mut none: libc::sigset_t = std::mem::zeroed();
		libc::sigemptyset(&mut none);
		libc::sigprocmask(libc::SIG_SETMASK, &none, std::ptr::null_mut());
		cvt(libc::chdir(COMPANY.as_ptr()), "chdir /company")?;
		libc::execve(c.program.as_ptr(), c.argv.as_ptr(), c.env.as_ptr());
	}
	Err(os("exec"))
}

/// The (c') order (coordinator, 15 Oct). Still root in the initial user namespace: the ambient set and keep-caps
/// cleared, then the office account's ids, which empty the permitted and effective sets, and no inheritable set. Then B
/// joins the shell's user namespace: the office account owns it, so the kernel allows that with no capability, and
/// hands B a full set that counts only in there. In there the ids are checked, then the shell's bounding set, no
/// ambient set, SECBIT_NOROOT locked (PR_SET_SECUREBITS needs CAP_SETPCAP, so it comes before the capset), and no
/// capabilities. Checked after each capset.
fn drop_privileges(p: &Prepared) -> Result<(), String> {
	// SAFETY: prctl, setgroups, setres[ug]id, setns, close and getres[ug]id with live, correctly sized arguments.
	unsafe {
		cvt(libc::prctl(libc::PR_CAP_AMBIENT, libc::PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0), "clear the ambient set")?;
		cvt(libc::prctl(libc::PR_SET_KEEPCAPS, 0, 0, 0, 0), "clear keep-caps")?;
		cvt(libc::setgroups(0, std::ptr::null()), "setgroups")?;
		cvt(libc::setresgid(p.gid, p.gid, p.gid), "setresgid")?;
		cvt(libc::setresuid(p.uid, p.uid, p.uid), "setresuid")?;
		// Lowering every set needs no capability.
		capset_none()?;
		if held()? {
			return Err("capabilities left after the drop to the office account".into());
		}
		cvt(libc::setns(p.user.as_raw_fd(), libc::CLONE_NEWUSER), "join the shell's user namespace")?;
		libc::close(p.user.as_raw_fd());
		let (mut uids, mut gids) = ([0; 3], [0; 3]);
		cvt(libc::getresuid(&mut uids[0], &mut uids[1], &mut uids[2]), "getresuid")?;
		cvt(libc::getresgid(&mut gids[0], &mut gids[1], &mut gids[2]), "getresgid")?;
		check_inside(uids, gids, p.overflow)?;
		for cap in 0..64 {
			let dropped = (p.bounding >> cap) & 1 == 1 || libc::prctl(libc::PR_CAPBSET_DROP, cap, 0, 0, 0) == 0;
			// Past the kernel's last capability the call is EINVAL.
			if !dropped && io::Error::last_os_error().raw_os_error() != Some(libc::EINVAL) {
				return Err(os("drop the bounding set"));
			}
		}
		cvt(libc::prctl(libc::PR_CAP_AMBIENT, libc::PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0), "clear the ambient set")?;
		cvt(libc::prctl(libc::PR_SET_SECUREBITS, SECUREBITS_LOCKED_NOROOT, 0, 0, 0), "lock SECBIT_NOROOT")?;
		capset_none()?;
		if held()? {
			return Err("capabilities left in the shell's user namespace".into());
		}
		if libc::prctl(libc::PR_GET_SECUREBITS, 0, 0, 0, 0) != SECUREBITS_LOCKED_NOROOT as libc::c_int {
			return Err("the securebits are not SECBIT_NOROOT locked".into());
		}
	}
	Ok(())
}

fn capset_none() -> Result<(), String> {
	let mut header = CapHeader { version: CAPABILITY_VERSION_3, pid: 0 };
	let none = [CapData { effective: 0, permitted: 0, inheritable: 0 }; 2];
	// SAFETY: capset reads two v3 records.
	cvt(unsafe { libc::syscall(libc::SYS_capset, &raw mut header, none.as_ptr()) }, "capset").map(drop)
}

/// Whether this process holds any effective, permitted or inheritable capability.
fn held() -> Result<bool, String> {
	let mut header = CapHeader { version: CAPABILITY_VERSION_3, pid: 0 };
	let mut held = [CapData { effective: u32::MAX, permitted: u32::MAX, inheritable: u32::MAX }; 2];
	// SAFETY: capget fills two v3 records.
	cvt(unsafe { libc::syscall(libc::SYS_capget, &raw mut header, held.as_mut_ptr()) }, "capget")?;
	Ok(held.iter().any(|d| d.effective | d.permitted | d.inheritable != 0))
}

/// `lo` up in an offline command's new network namespace, where it starts down.
fn loopback_up() -> Result<(), String> {
	// SAFETY: a datagram socket and two ioctls on a zeroed ifreq-sized buffer: the name at 0, the flags (a short) at 16.
	unsafe {
		let socket = fd(libc::socket(libc::AF_INET, libc::SOCK_DGRAM | libc::SOCK_CLOEXEC, 0).into(), "lo socket")?;
		let mut request = [0u8; 40];
		request[..2].copy_from_slice(b"lo");
		cvt(libc::ioctl(socket.as_raw_fd(), libc::SIOCGIFFLAGS, request.as_mut_ptr()), "read lo's flags")?;
		let flags = i16::from_ne_bytes([request[16], request[17]]) | libc::IFF_UP as i16;
		request[16..18].copy_from_slice(&flags.to_ne_bytes());
		cvt(libc::ioctl(socket.as_raw_fd(), libc::SIOCSIFFLAGS, request.as_mut_ptr()), "bring lo up")?;
	}
	Ok(())
}

/// A signal's name as the shell host reports it (SIGTERM), or SIG<number> for one without a name.
pub fn signal_name(signal: libc::c_int) -> String {
	const NAMES: [&str; 32] = [
		"", "HUP", "INT", "QUIT", "ILL", "TRAP", "ABRT", "BUS", "FPE", "KILL", "USR1", "SEGV", "USR2", "PIPE", "ALRM", "TERM",
		"STKFLT", "CHLD", "CONT", "STOP", "TSTP", "TTIN", "TTOU", "URG", "XCPU", "XFSZ", "VTALRM", "PROF", "WINCH", "IO",
		"PWR", "SYS",
	];
	match usize::try_from(signal).ok().and_then(|n| NAMES.get(n)) {
		Some(name) if !name.is_empty() => format!("SIG{name}"),
		_ => format!("SIG{signal}"),
	}
}

/// Starts the command and reports on fd 3 until it ends. Returns the exit code: 0 once its end was reported, 1 when it
/// failed to start (reported too), 2 when fds 0 to 4 are not all open.
pub fn run(request: &Request) -> u8 {
	// SAFETY: prctl with integer arguments: only root with CAP_SYS_PTRACE may read this process's memory or fds.
	unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) };
	// SAFETY: F_GETFD only reads an fd's flags.
	if (0..=GO).any(|fd| unsafe { libc::fcntl(fd, libc::F_GETFD) } == -1) {
		eprintln!("qorpera-folder command: fds 0 to 4 must be open (the command's stdio, the reports and the go)");
		return 2;
	}
	// SAFETY: sets the close-on-exec flag of open fds.
	unsafe {
		libc::fcntl(REPORTS, libc::F_SETFD, libc::FD_CLOEXEC);
		libc::fcntl(GO, libc::F_SETFD, libc::FD_CLOEXEC);
	}
	// Stderr is the command's: a failure goes only to the reports.
	match start(request) {
		Ok(code) => code,
		Err(error) => {
			report(Report::Failed(&error));
			1
		}
	}
}

fn pipe() -> Result<(OwnedFd, OwnedFd), String> {
	let mut fds = [0; 2];
	// SAFETY: pipe2 fills two fds, owned here from then on.
	unsafe {
		cvt(libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC), "pipe")?;
		Ok((OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])))
	}
}

fn start(request: &Request) -> Result<u8, String> {
	let mut prepared = prepare(request)?;
	join(&mut prepared)?;
	// SAFETY: a zeroed set filled by sigemptyset and sigaddset, blocked in this single thread, then read by a signalfd.
	let signals = unsafe {
		let mut set: libc::sigset_t = std::mem::zeroed();
		libc::sigemptyset(&mut set);
		libc::sigaddset(&mut set, libc::SIGTERM);
		libc::sigaddset(&mut set, libc::SIGCHLD);
		libc::sigprocmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
		fd(libc::signalfd(-1, &set, libc::SFD_CLOEXEC).into(), "signalfd")?
	};
	let (start_read, start_write) = pipe()?;
	let (ack_read, ack_write) = pipe()?;
	let mut argv: Vec<*const libc::c_char> = request.argv.iter().map(|a| a.as_ptr()).collect();
	argv.push(std::ptr::null());
	let mut env: Vec<*const libc::c_char> = prepared.env.iter().map(|e| e.as_ptr()).collect();
	env.push(std::ptr::null());
	let state = Child {
		prepared: &prepared,
		network: request.network,
		start: start_write.as_raw_fd(),
		ack: ack_read.as_raw_fd(),
		answer: ack_write.as_raw_fd(),
		program: &request.argv[0],
		argv,
		env,
		filter: command_filter(&FAMILIES),
	};
	// SAFETY: this process has one thread, so the child may run anything; it leaves only through exec or _exit.
	let b = cvt(unsafe { libc::fork() }, "fork")?;
	if b == 0 {
		child(&state);
	}
	drop(state);
	drop((start_write, ack_read));
	// A keeps no end of the command's stdio, so the helper sees the command's own end of file.
	for target in 0..=2 {
		// SAFETY: dup2 of a live fd onto stdio.
		unsafe { libc::dup2(prepared.null.as_raw_fd(), target) };
	}
	let Prepared { proc, pidfd, root, tree, null, user, .. } = prepared;
	drop((pidfd, root, tree, null, user));
	Ok(supervise(b, &proc, &start_read, ack_write, &signals))
}

/// B's end, seen without reaping it, so its pid and process group stay its own until a stop is done.
fn ended(b: libc::pid_t) -> Option<(Option<i32>, Option<String>)> {
	// SAFETY: waitid with WNOWAIT fills a zeroed siginfo and leaves B a zombie.
	unsafe {
		let mut info: libc::siginfo_t = std::mem::zeroed();
		let flags = libc::WEXITED | libc::WNOHANG | libc::WNOWAIT;
		if libc::waitid(libc::P_PID, b as libc::id_t, &mut info, flags) != 0 || info.si_pid() != b {
			return None;
		}
		Some(match info.si_code {
			libc::CLD_EXITED => (Some(info.si_status()), None),
			_ => (None, Some(signal_name(info.si_status()))),
		})
	}
}

/// The process group B leads, or B itself before its setsid.
fn signal_group(b: libc::pid_t, signal: libc::c_int) {
	// SAFETY: kill with the pid of a child A has not reaped, so no other process has it.
	unsafe {
		if libc::kill(-b, signal) != 0 {
			libc::kill(b, signal);
		}
	}
}

/// Kills and reaps B after a failed start, then reports it: once the helper reads `failed`, B is gone. B never exec'd,
/// so its process group is B alone.
fn abandon(b: libc::pid_t, error: &str) -> u8 {
	signal_group(b, libc::SIGKILL);
	// SAFETY: waits on A's own child.
	unsafe { libc::waitpid(b, std::ptr::null_mut(), 0) };
	report(Report::Failed(error));
	1
}

/// Waits for B's start, then for its end, and stops it on SIGTERM as the shell host does. B's start is in three steps:
/// its mount namespace with the command's tree attached, reported as `started`; the helper's `G`, after which A lets B
/// go on; and the exec, which closes B's end of the start pipe. A failure before the exec, after `started` too, is
/// reported as `failed`.
fn supervise(b: libc::pid_t, proc: &OwnedFd, start: &OwnedFd, ack: OwnedFd, signals: &OwnedFd) -> u8 {
	let deadline = Instant::now() + START_DEADLINE;
	let mut message = Vec::new();
	let mut reported = false;
	let mut released = false;
	let mut starting = true;
	let mut end: Option<(Option<i32>, Option<String>)> = None;
	let mut kill_at: Option<Instant> = None;
	let mut killed = false;
	loop {
		if let Some((code, signal)) = &end {
			// A stopped command's group gets its SIGKILL before B is reaped and its pid freed.
			if !starting && (kill_at.is_none() || killed) {
				report(Report::Exit { code: *code, signal: signal.clone() });
				// SAFETY: reaps A's own child.
				unsafe { libc::waitpid(b, std::ptr::null_mut(), 0) };
				return 0;
			}
		}
		let wake = [starting.then_some(deadline), kill_at.filter(|_| !killed)].into_iter().flatten().min();
		let now = Instant::now();
		let timeout = wake.map_or(-1, |at| at.saturating_duration_since(now).as_millis().min(60_000) as libc::c_int);
		let mut fds = [
			libc::pollfd { fd: if starting { start.as_raw_fd() } else { -1 }, events: libc::POLLIN, revents: 0 },
			libc::pollfd { fd: signals.as_raw_fd(), events: libc::POLLIN, revents: 0 },
			// After the go, the helper's end of fd 4 is of no more use: a helper that goes then changes nothing here.
			libc::pollfd { fd: if starting && !released { GO } else { -1 }, events: libc::POLLIN, revents: 0 },
		];
		// SAFETY: polls three pollfds in a live array. EINTR only means poll again.
		unsafe { libc::poll(fds.as_mut_ptr(), 3, timeout) };
		let now = Instant::now();
		if fds[0].revents != 0 {
			let mut chunk = [0u8; 512];
			// SAFETY: reads into a live buffer.
			let n = unsafe { libc::read(start.as_raw_fd(), chunk.as_mut_ptr().cast(), chunk.len()) };
			if n > 0 {
				message.extend_from_slice(&chunk[..n as usize]);
				if message == b"U" {
					// B is A's unreaped child, so this pid is still B.
					let path = CString::new(format!("{b}/ns/mnt")).expect("digits");
					// SAFETY: fstatat fills a zeroed stat through a live dirfd.
					let inode = unsafe {
						let mut st: libc::stat = std::mem::zeroed();
						(libc::fstatat(proc.as_raw_fd(), path.as_ptr(), &mut st, 0) == 0).then_some(st.st_ino)
					};
					let Some(inode) = inode else { return abandon(b, &os("read the command's mount namespace")) };
					report(Report::Started { pid: b, mntns: inode });
					reported = true;
				}
			} else if n == 0 || io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
				// The exec closed B's end of the start pipe, or B ended.
				starting = false;
				match (message.as_slice(), released) {
					(b"U", true) => {}
					([b'U', b'E', error @ ..] | [b'E', error @ ..], _) => return abandon(b, &String::from_utf8_lossy(error)),
					_ => return abandon(b, "the command's starter ended before the exec"),
				}
			}
		}
		if fds[2].revents != 0 {
			let mut go = 0u8;
			// SAFETY: reads one byte into a live buffer.
			let n = unsafe { libc::read(GO, (&raw mut go).cast(), 1) };
			if n == 1 && go == b'G' && reported {
				released = true;
				// SAFETY: one byte from a live buffer; B waits for it.
				unsafe { libc::write(ack.as_raw_fd(), b"A".as_ptr().cast(), 1) };
			} else if n != -1 || io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
				// End of file: the helper gave up on the start, or went. Anything else is not its answer.
				return abandon(b, "the helper did not let the command start");
			}
		}
		if fds[1].revents != 0 {
			// SAFETY: reads one signalfd record into a zeroed struct of its size.
			let signal = unsafe {
				let mut info: libc::signalfd_siginfo = std::mem::zeroed();
				let size = std::mem::size_of::<libc::signalfd_siginfo>();
				(libc::read(signals.as_raw_fd(), (&raw mut info).cast(), size) == size as isize).then_some(info.ssi_signo)
			};
			if signal == Some(libc::SIGTERM as u32) && kill_at.is_none() {
				signal_group(b, libc::SIGTERM);
				kill_at = Some(now + STOP_GRACE);
			}
			if end.is_none() {
				end = ended(b);
			}
		}
		if kill_at.is_some_and(|at| !killed && now >= at) {
			signal_group(b, libc::SIGKILL);
			killed = true;
		}
		if starting && now >= deadline {
			return abandon(b, "the command did not start in time");
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// Runs a filter over one call, as the kernel would for the instructions it uses.
	fn evaluate(program: &[libc::sock_filter], arch: u32, nr: u32, arg0: u64) -> u32 {
		let mut accumulator = 0u32;
		let mut pc = 0usize;
		loop {
			let op = program[pc];
			pc += 1;
			match op.code {
				0x20 => {
					accumulator = match op.k {
						0 => nr,
						4 => arch,
						16 => arg0 as u32,
						k => panic!("load at {k}"),
					}
				}
				0x15 | 0x35 | 0x45 => {
					let taken = match op.code {
						0x15 => accumulator == op.k,
						0x35 => accumulator >= op.k,
						_ => accumulator & op.k != 0,
					};
					pc += usize::from(if taken { op.jt } else { op.jf });
				}
				0x06 => return op.k,
				code => panic!("op {code:#x}"),
			}
		}
	}

	fn refused(errno: libc::c_int) -> u32 {
		libc::SECCOMP_RET_ERRNO | errno as u32
	}

	#[test]
	fn the_filter_refuses_setns_new_user_namespaces_clone3_x32_and_other_families() {
		let program = command_filter(&FAMILIES);
		let call = |nr: libc::c_long, arg0: u64| evaluate(&program, AUDIT_ARCH_X86_64, nr as u32, arg0);
		// setns by its number alone, whatever the fd: a namespace's of any type, a pidfd, or none (-1).
		for fd in [0u64, 3, 4, 1000, u64::MAX, 0xFFFF_FFFF] {
			assert_eq!(call(libc::SYS_setns, fd), refused(libc::EPERM), "{fd}");
		}
		assert_eq!(evaluate(&program, AUDIT_ARCH_X86_64, X32_SYSCALL_BIT | libc::SYS_setns as u32, 0), refused(libc::ENOSYS));
		assert_eq!(call(libc::SYS_unshare, libc::CLONE_NEWUSER as u64), refused(libc::EPERM));
		assert_eq!(call(libc::SYS_unshare, (libc::CLONE_NEWUSER | libc::CLONE_NEWNS) as u64), refused(libc::EPERM));
		assert_eq!(call(libc::SYS_unshare, libc::CLONE_NEWNS as u64), libc::SECCOMP_RET_ALLOW);
		assert_eq!(call(libc::SYS_clone, (libc::CLONE_NEWUSER | libc::SIGCHLD) as u64), refused(libc::EPERM));
		assert_eq!(call(libc::SYS_clone, libc::SIGCHLD as u64), libc::SECCOMP_RET_ALLOW);
		assert_eq!(call(libc::SYS_clone3, 0), refused(libc::ENOSYS));
		for family in FAMILIES {
			assert_eq!(call(libc::SYS_socket, family as u64), libc::SECCOMP_RET_ALLOW, "{family}");
		}
		for family in [libc::AF_VSOCK, libc::AF_PACKET, libc::AF_BLUETOOTH, libc::AF_ALG] {
			assert_eq!(call(libc::SYS_socket, family as u64), refused(libc::EAFNOSUPPORT), "{family}");
		}
		// The family is the low half of the first argument.
		assert_eq!(call(libc::SYS_socket, (1u64 << 32) | libc::AF_VSOCK as u64), refused(libc::EAFNOSUPPORT));
		assert_eq!(call(libc::SYS_read, 0), libc::SECCOMP_RET_ALLOW);
		assert_eq!(evaluate(&program, AUDIT_ARCH_X86_64, X32_SYSCALL_BIT | libc::SYS_unshare as u32, 0), refused(libc::ENOSYS));
		assert_eq!(evaluate(&program, 0x4000_0003, libc::SYS_read as u32, 0), refused(libc::ENOSYS));
	}

	#[test]
	fn the_command_ends_on_the_office_families() {
		assert_eq!(FAMILIES, [libc::AF_UNIX, libc::AF_INET, libc::AF_INET6, libc::AF_NETLINK]);
		assert!(!FAMILIES.contains(&libc::AF_VSOCK));
	}

	/// The filter #1097's nested-VM proof installed and checked (its `filterSha256`, run 20261015T201341-55427-fedd944b):
	/// each row's code (u16), jt, jf and k (u32), little-endian.
	#[test]
	fn the_filter_is_the_one_the_proof_installed() {
		use sha2::{Digest, Sha256};
		let mut hash = Sha256::new();
		for row in command_filter(&FAMILIES) {
			hash.update(row.code.to_le_bytes());
			hash.update([row.jt, row.jf]);
			hash.update(row.k.to_le_bytes());
		}
		let digest: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
		assert_eq!(digest, "b7d7c2cc80049e76e3a5df206c194da0c49fc4cdd36d03ac9312625cc92d2ed3");
	}

	#[test]
	fn the_office_account_is_neither_root_nor_unmapped_inside() {
		let overflow = (65534, 65534);
		assert!(check_inside([999; 3], [986; 3], overflow).is_ok());
		assert!(check_inside([1000; 3], [1000; 3], overflow).is_ok());
		for (uids, gids) in [
			([0, 0, 0], [986; 3]),
			([999, 999, 0], [986; 3]),
			([999; 3], [0, 986, 986]),
			([65534; 3], [986; 3]),
			([999; 3], [986, 986, 65534]),
		] {
			assert!(check_inside(uids, gids, overflow).is_err(), "{uids:?}/{gids:?}");
		}
		// The overflow ids are the kernel's, read from /proc/sys/kernel, not a constant.
		assert!(check_inside([65534; 3], [65534; 3], (70000, 70000)).is_ok());
		assert!(check_inside([999; 3], [986; 3], (999, 65534)).is_err());
		assert!(check_inside([999; 3], [986; 3], (65534, 986)).is_err());
	}

	const SHELL: &str = "Name:\ttini\nUmask:\t0077\nUid:\t999\t999\t999\t999\nGid:\t986\t986\t986\t986\nNSpid:\t1578\t1\n\
		CapInh:\t0000000000000000\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapBnd:\t0000000000000000\n\
		CapAmb:\t0000000000000000\nNoNewPrivs:\t1\n";

	#[test]
	fn a_shell_is_the_office_accounts_pid_namespace_init_without_capabilities() {
		let status = parse_status(SHELL).unwrap();
		assert_eq!(status.uid, [999; 4]);
		assert_eq!(status.nspid, [1578, 1]);
		assert!(check_shell(&status, 999, 986).is_ok());
		let bounded = parse_status(&SHELL.replace("CapBnd:\t0000000000000000", "CapBnd:\t000001ffffffffff")).unwrap();
		assert_eq!(bounded.caps.bounding, 0x1ff_ffff_ffff);
		assert!(check_shell(&bounded, 999, 986).is_ok());
		for (from, to) in [
			("Uid:\t999\t999\t999\t999", "Uid:\t999\t0\t999\t999"),
			("Uid:\t999\t999\t999\t999", "Uid:\t999\t999\t999"),
			("Gid:\t986\t986\t986\t986", "Gid:\t986\t986\t986\t0"),
			("NSpid:\t1578\t1", "NSpid:\t1578"),
			("NSpid:\t1578\t1", "NSpid:\t1578\t7"),
			("CapEff:\t0000000000000000", "CapEff:\t0000000000200000"),
			("CapPrm:\t0000000000000000", "CapPrm:\t0000000000000001"),
			("CapInh:\t0000000000000000", "CapInh:\t0000000000000400"),
			("CapAmb:\t0000000000000000", "CapAmb:\t0000000000001000"),
		] {
			let changed = parse_status(&SHELL.replace(from, to)).unwrap();
			assert!(check_shell(&changed, 999, 986).is_err(), "{to}");
		}
		assert!(check_shell(&status, 1000, 986).is_err());
		assert!(check_shell(&status, 999, 1000).is_err());
		assert!(parse_status(&SHELL.replace("CapAmb:\t0000000000000000\n", "")).is_err());
		assert!(parse_status(&SHELL.replace("Uid:\t999", "Uid:\tx")).is_err());
		assert!(parse_status(&SHELL.replace("CapEff:\t0000000000000000", "CapEff:\tzz")).is_err());
	}

	#[test]
	fn the_cgroup_is_the_plain_v2_path() {
		let path = parse_cgroup("0::/system.slice/qorpera-company-computer.service\n").unwrap();
		assert_eq!(path, "/system.slice/qorpera-company-computer.service");
		assert!(parse_cgroup("1:name=systemd:/x\n").is_err());
		assert!(parse_cgroup("0::/system.slice/../x\n").is_err());
		assert!(parse_cgroup("0::relative\n").is_err());
	}

	#[test]
	fn the_environment_is_the_shells_named_entries() {
		let env = parse_environ(b"HOME=/home/qorpera\0PATH=/usr/local/bin:/usr/bin:/bin\0EMPTY=\0").unwrap();
		assert_eq!(env, [c"HOME=/home/qorpera", c"PATH=/usr/local/bin:/usr/bin:/bin", c"EMPTY="].map(CString::from));
		assert!(parse_environ(b"").unwrap().is_empty());
		assert!(parse_environ(b"HOME=/x\0=nameless\0").is_err());
		assert!(parse_environ(b"NOVALUE\0").is_err());
	}

	#[test]
	fn signals_have_the_shell_hosts_names() {
		assert_eq!(signal_name(libc::SIGTERM), "SIGTERM");
		assert_eq!(signal_name(libc::SIGKILL), "SIGKILL");
		assert_eq!(signal_name(libc::SIGSYS), "SIGSYS");
		assert_eq!(signal_name(34), "SIG34");
		assert_eq!(signal_name(0), "SIG0");
		for signal in 1..=64 {
			let name = signal_name(signal);
			assert!(name.len() <= 15 && name[3..].bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()), "{name}");
		}
	}
}
