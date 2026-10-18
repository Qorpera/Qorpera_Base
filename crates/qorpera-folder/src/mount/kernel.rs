//! The kernel's cache of the machine's caches (MC3a, `deploy/first-node/RUNTIME-FOLDER-MACHINE-CACHES.md` "The kernel
//! cache"). For cache files only (`Area::Cache`: local inodes and cache tops), the kernel keeps names, attributes and
//! absent names for the TTL, and the pages of a read-only open whose file is as this mount last opened it. Opens,
//! releases and writes still come here, so this program sees every handle and every change.
//!
//! What changes behind the kernel's back is dropped on this mount (an own-mount epoch); what this program changes in a
//! cache folder other programs share is told to each of them before its own reply (`peers.rs`). A told program does
//! only what takes no lock a request may hold: the inode's attributes (`inval_inode` with offset -1), for a name the
//! connection's epoch (`FUSE_NOTIFY_INC_EPOCH`: every name made before it is looked up again at its next use), and the
//! inode's open stamp; then it answers. Its pages drop afterwards on a thread of their own, for memory (a read through a
//! held fd asks for the attributes again and drops them itself, `FUSE_AUTO_INVAL_DATA`).
//!
//! The epoch is for a name the kernel may hold only (`hold`): one in a local folder this program answered a lookup,
//! create, mkdir, symlink, link, rename or removal of, from before it read or changed the disk until the time-out it
//! handed has passed; and every cache top's. The kernel takes the epoch before it sends a request, so an answer on its
//! way when the epoch rises is stale at its first use. A name this program never handed needs no epoch: a lookup of it
//! reads the disk after the change. Listings hand the kernel no names (the program does not take `READDIRPLUS`).
//!
//! A notify that fails, a change told late, or a listener that stopped turns the kernel cache off for good: everything
//! handed to the kernel is dropped, and if that fails too the program exits (its mount closed, never stale).

use super::*;
use crate::local::{Stamp, Up};
use crate::peers::{self, Change, Heard, Listener, Parent, Teller};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::os::fd::{AsRawFd, OwnedFd};
use std::sync::OnceLock;

/// FUSE_NOTIFY_INC_EPOCH (ABI 7.44).
const NOTIFY_INC_EPOCH: i32 = 8;
/// How long past the time-out it was handed with a name stays held: the kernel times an entry from when the request's
/// task reads the reply, a moment after this program wrote it.
const HELD_PAST: Duration = Duration::from_secs(60);
/// The names held at most (`Names`): 100 000, in 131 072 slots of 33 bytes, about 4.3 MB.
const NAMES_MAX: usize = 100_000;
/// Test switches: the kernel cache off with this reason, as a kernel without the epoch would (`QORPERA_FOLDER_TEST_KERNEL_OFF`);
/// a told change's notify failing (`QORPERA_FOLDER_TEST_NOTIFY_FAILS=1`), not the fallback's; the names held at most
/// (`QORPERA_FOLDER_TEST_NAMES=<n>`); a name whose lookups in a local folder wait `SLOW_LOOKUP` between reading the disk
/// and the reply (`QORPERA_FOLDER_TEST_SLOW_LOOKUP=<name>`); a fallback waiting `SLOW_FALL_BACK` between turning the
/// kernel cache off and dropping what the kernel holds (`QORPERA_FOLDER_TEST_SLOW_FALL_BACK=1`).
const TEST_OFF: &str = "QORPERA_FOLDER_TEST_KERNEL_OFF";
const TEST_NOTIFY_FAILS: &str = "QORPERA_FOLDER_TEST_NOTIFY_FAILS";
const TEST_NAMES: &str = "QORPERA_FOLDER_TEST_NAMES";
const TEST_SLOW_LOOKUP: &str = "QORPERA_FOLDER_TEST_SLOW_LOOKUP";
const SLOW_LOOKUP: Duration = Duration::from_millis(300);
const TEST_SLOW_FALL_BACK: &str = "QORPERA_FOLDER_TEST_SLOW_FALL_BACK";
const SLOW_FALL_BACK: Duration = Duration::from_secs(2);

pub(super) struct Kernel {
	/// A writable view, which has caches.
	caches: bool,
	/// Why the kernel cache may not be used, known before the mount (the cache folder's times, a test switch).
	allowed: Result<(), String>,
	/// The kernel cache is on: from `init` and `mounted`, whichever comes last, until a fallback.
	on: AtomicBool,
	/// Whether the kernel's INIT allows the kernel cache, until the mount is made too (fuser answers INIT before
	/// `Session::new` returns, so before `mounted`). Also held by a fallback until it has dropped what the kernel holds.
	init: Mutex<Option<Result<(), String>>>,
	/// The first fallback's reason, also one heard before the kernel cache was decided.
	off: OnceLock<String>,
	told: OnceLock<Told>,
	/// Local inodes the kernel holds an entry of, and how many lookups it counts for each (absent names aside).
	handed: Mutex<HashMap<u64, u64>>,
	/// What each local file was at the last open answered here: an open keeps the kernel's pages only when the file is
	/// still so (another program's change nobody told, an inode number the disk gave again).
	stamps: Mutex<HashMap<u64, Stamp>>,
	/// The names in local folders the kernel may hold an entry of, present or absent (`hold`).
	names: Mutex<Names>,
	/// The test switch's name, whose lookups wait between the disk and the reply.
	slow: Option<String>,
	peers: OnceLock<Peers>,
}

/// A name held for a request (`Kernel::hold`): when it drops, after the reply, the name stays held for its time-out.
pub(super) struct Held<'a> {
	kernel: &'a Kernel,
	/// The name's key, the table's era at the hold, and the time-out.
	key: Option<(u64, u64, Duration)>,
}

impl Drop for Held<'_> {
	fn drop(&mut self) {
		if let Some((key, era, ttl)) = self.key {
			self.kernel.names.lock().unwrap().done(key, era, Instant::now() + ttl + HELD_PAST);
		}
	}
}

/// The held names, by a hash of folder and name (`key`): two names that hash alike are held as one, which only raises
/// an epoch more often.
struct Names {
	held: HashMap<u64, Name>,
	/// Raised when the table drops every name: a request held before then no longer counts down a name held since.
	era: u64,
	max: usize,
}

struct Name {
	/// Requests between their hold and their reply.
	busy: u32,
	/// Until when the kernel may hold the name after the last reply.
	until: Instant,
}

/// A name's key in `Names`.
fn key(dir: u64, name: &str) -> u64 {
	let mut hasher = DefaultHasher::new();
	(dir, name).hash(&mut hasher);
	hasher.finish()
}

impl Names {
	fn new(max: usize) -> Names {
		Names { held: HashMap::new(), era: 0, max: max.max(1) }
	}

	/// Holds `key` for a request, until at least `until`: the era, and whether the table dropped every name first (it was
	/// full), so the kernel must drop them too. A full table first lets go of the names no request holds whose time
	/// passed; if more than half are left, of all.
	fn hold(&mut self, key: u64, now: Instant, until: Instant) -> (u64, bool) {
		let mut cleared = false;
		if self.held.len() >= self.max && !self.held.contains_key(&key) {
			self.held.retain(|_, name| name.busy > 0 || name.until > now);
			if self.held.len() > self.max / 2 {
				self.held.clear();
				self.era += 1;
				cleared = true;
			}
		}
		let name = self.held.entry(key).or_insert(Name { busy: 0, until });
		name.busy += 1;
		name.until = name.until.max(until);
		(self.era, cleared)
	}

	/// A request held in `era` replied: its name stays held until at least `until`.
	fn done(&mut self, key: u64, era: u64, until: Instant) {
		if era != self.era {
			return;
		}
		if let Some(name) = self.held.get_mut(&key) {
			name.busy = name.busy.saturating_sub(1);
			name.until = name.until.max(until);
		}
	}

	fn holds(&self, key: u64, now: Instant) -> bool {
		self.held.get(&key).is_some_and(|name| name.busy > 0 || name.until > now)
	}
}

/// The kernel's side of this mount, from right after it is made.
struct Told {
	notifier: Notifier,
	/// The mount's /dev/fuse, for the notify fuser has no call for (the epoch).
	fuse: OwnedFd,
	/// Inodes whose pages drop on the page-drop thread.
	drops: Mutex<mpsc::Sender<u64>>,
}

struct Peers {
	listener: Listener,
	teller: Arc<Teller>,
}

impl Kernel {
	pub(super) fn new(local: Option<&Local>) -> Kernel {
		let allowed = match (local, std::env::var(TEST_OFF)) {
			(None, _) => Err("a read-only view has no caches".to_string()),
			(Some(_), Ok(why)) => Err(format!("{why} (test switch)")),
			(Some(local), Err(_)) => match local.probe() {
				Ok(true) => Ok(()),
				Ok(false) => Err("a write in the cache folder does not always change its file's times".to_string()),
				Err(e) => Err(format!("could not check the cache folder's times: {e}")),
			},
		};
		Kernel {
			caches: local.is_some(),
			allowed,
			on: AtomicBool::new(false),
			init: Mutex::new(None),
			off: OnceLock::new(),
			told: OnceLock::new(),
			handed: Mutex::new(HashMap::new()),
			stamps: Mutex::new(HashMap::new()),
			names: Mutex::new(Names::new(std::env::var(TEST_NAMES).ok().and_then(|n| n.parse().ok()).unwrap_or(NAMES_MAX))),
			slow: std::env::var(TEST_SLOW_LOOKUP).ok(),
			peers: OnceLock::new(),
		}
	}

	/// Listens for the other programs on a shared cache folder, before anything is served.
	pub(super) fn start(s: &Arc<Shared>) -> std::io::Result<()> {
		let Some(dir) = s.local.as_ref().and_then(Local::programs) else { return Ok(()) };
		let heard = {
			let s = s.clone();
			move |h| s.kernel.heard(h)
		};
		let listener = peers::listen(&dir, heard)?;
		let teller = Teller::new(&dir, listener.name())?;
		let _ = s.kernel.peers.set(Peers { listener, teller });
		Ok(())
	}

	/// The mount is made (fuser has answered the kernel's INIT by now): keeps its notifier and /dev/fuse, and starts the page drops.
	pub(super) fn mounted(&self, notifier: Notifier, fuse: OwnedFd) {
		let (drops, inos) = mpsc::channel::<u64>();
		let dropper = notifier.clone();
		std::thread::Builder::new()
			.name("kernel-drops".into())
			.spawn(move || {
				while let Ok(ino) = inos.recv() {
					let mut batch = HashSet::from([ino]);
					batch.extend(inos.try_iter());
					for ino in batch {
						if let Err(e) = dropper.inval_inode(INodeNo(ino), 0, 0) {
							eprintln!("qorpera-folder: kernel cache: dropping the pages of {ino:#x}: {e}");
						}
					}
				}
			})
			.expect("spawn the page-drop thread");
		let _ = self.told.set(Told { notifier, fuse, drops: Mutex::new(drops) });
		self.decide();
	}

	/// The kernel's INIT: the kernel cache is on only if the kernel re-reads attributes before a read through a held
	/// fd (`FUSE_AUTO_INVAL_DATA`) and has the epoch (7.44), and nothing ruled it out before.
	pub(super) fn init(&self, config: &mut KernelConfig) {
		if !self.caches {
			return;
		}
		let granted = config.add_capabilities(InitFlags::FUSE_AUTO_INVAL_DATA).is_ok();
		let abi = config.kernel_abi();
		let why = self.allowed.clone().and_then(|()| {
			if !granted {
				Err("the kernel did not grant FUSE_AUTO_INVAL_DATA".to_string())
			} else if (abi.0, abi.1) < (7, 44) {
				Err(format!("the kernel's FUSE ABI {}.{} has no epoch notify (7.44)", abi.0, abi.1))
			} else {
				Ok(())
			}
		});
		*self.init.lock().unwrap() = Some(why);
		self.decide();
	}

	/// Turns the kernel cache on or leaves it off, once both the INIT and the mount are in. Until then every answer is
	/// as without it.
	fn decide(&self) {
		if self.told.get().is_none() {
			return;
		}
		let mut init = self.init.lock().unwrap();
		let Some(why) = init.take() else { return };
		match why.and_then(|()| self.off.get().map_or(Ok(()), |why| Err(why.clone()))) {
			Ok(()) => {
				self.on.store(true, Ordering::SeqCst);
				eprintln!("qorpera-folder: kernel cache on");
			}
			Err(why) => eprintln!("qorpera-folder: kernel cache off: {why}"),
		}
	}

	pub(super) fn on(&self) -> bool {
		self.on.load(Ordering::SeqCst)
	}

	/// An entry of the local inode `ino` is about to reach the kernel: counted first, so a fallback that starts after
	/// this reads the kernel cache as on drops it too.
	pub(super) fn hand(&self, ino: u64) {
		*self.handed.lock().unwrap().entry(ino).or_default() += 1;
	}

	/// The kernel forgot `count` lookups of `ino`.
	pub(super) fn forget(&self, ino: u64, count: u64) {
		let mut handed = self.handed.lock().unwrap();
		if let Some(n) = handed.get_mut(&ino) {
			*n = n.saturating_sub(count);
			if *n == 0 {
				handed.remove(&ino);
			}
		}
	}

	/// Whether a read-only open of a file now at `stamp` keeps the kernel's pages: only if it is as this mount last
	/// opened it, and nothing was told about it since.
	pub(super) fn keep(&self, ino: u64, stamp: Stamp) -> bool {
		self.on() && self.stamps.lock().unwrap().insert(ino, stamp) == Some(stamp)
	}

	/// Holds `name` in the folder `up` for a request that may hand the kernel an entry of it, present or absent, with the
	/// time-out `ttl`: from before the request reads or changes the disk, until `ttl` and `HELD_PAST` have passed after
	/// its reply (the guard dropped). A change told for a name held raises the epoch (`drop_change`). A node folder's
	/// names are not held: a change told for one always raises it. A full table drops every name and raises the epoch
	/// before a change told is heard again; one that fails turns the kernel cache off.
	pub(super) fn hold(&self, up: &Up, name: &str, ttl: Duration) -> Held<'_> {
		let Up::Local(dir) = up else { return Held { kernel: self, key: None } };
		if ttl.is_zero() || !self.on() {
			return Held { kernel: self, key: None };
		}
		let key = key(*dir, name);
		let now = Instant::now();
		let mut names = self.names.lock().unwrap();
		let (era, cleared) = names.hold(key, now, now + ttl + HELD_PAST);
		if cleared {
			if let Err(e) = self.epoch() {
				self.fall_back(&format!("an epoch for a full table of names failed: {e}"));
			}
		}
		Held { kernel: self, key: Some((key, era, ttl)) }
	}

	/// Whether the kernel may hold an entry of `name` in `parent` (`hold`).
	fn holds(&self, parent: &Parent, name: &str) -> bool {
		match parent {
			Parent::Local(dir) => self.names.lock().unwrap().holds(key(*dir, name), Instant::now()),
			Parent::Dir(_) => true,
		}
	}

	/// The test switch's wait in a lookup of its name, between reading the disk and the reply.
	pub(super) fn slow(&self, name: &str) {
		if self.slow.as_deref() == Some(name) {
			eprintln!("qorpera-folder: test switch: a lookup of {name} read the disk and waits");
			std::thread::sleep(SLOW_LOOKUP);
		}
	}

	/// Tells the other programs on the cache folder about changes this program made, before its reply: EIO if one did
	/// not answer.
	pub(super) fn tell(&self, changes: &[Change]) -> Result<(), i32> {
		let Some(peers) = self.peers.get() else { return Ok(()) };
		peers.teller.tell(changes).map_err(|e| {
			eprintln!("qorpera-folder: telling the other programs on the cache folder: {e}");
			libc::EIO
		})
	}

	/// Caches this program changed behind its kernel's back (a move, a removal, the node's entry winning): its own
	/// mount looks every name up again, and the other programs are told without waiting (no request of theirs is
	/// ordered after this).
	pub(super) fn moved(&self, changes: Vec<Change>) {
		self.own();
		self.later(changes);
	}

	/// Tells the other programs without waiting: a write from the kernel's writeback, whose pages wait for its reply.
	pub(super) fn later(&self, changes: Vec<Change>) {
		if let Some(peers) = self.peers.get() {
			peers.teller.later(changes);
		}
	}

	/// Every name on this mount is looked up again: a cache top the node's entry may have won over unseen (the feed
	/// lost or resynced), or caches changed behind the kernel's back.
	pub(super) fn own(&self) {
		if self.on() {
			if let Err(e) = self.epoch() {
				self.fall_back(&format!("an epoch on this mount failed: {e}"));
			}
		}
	}

	/// Forgets on this mount what another program told (`peers.rs`), before the answer. With the kernel cache off, the
	/// answer waits for a fallback still dropping what the kernel holds.
	fn heard(&self, h: Heard) {
		match h {
			Heard::Change(change) => {
				if !self.on() {
					drop(self.init.lock().unwrap());
				} else if let Err(e) = self.drop_change(&change) {
					self.fall_back(&format!("a told change's notify failed: {e}"));
				}
			}
			Heard::Late(_) => self.fall_back("a change was told later than the teller waits"),
			Heard::Malformed(why) => {
				// The change it meant is unknown: everything handed out goes, still only invalidation.
				eprintln!("qorpera-folder: kernel cache: a malformed message from another program: {why}");
				if !self.on() {
					drop(self.init.lock().unwrap());
				} else if let Err(e) = self.drop_all() {
					self.fall_back(&format!("dropping all after a malformed message failed: {e}"));
				}
			}
			Heard::Deaf(why) => self.fall_back(&format!("this program no longer hears the others: {why}")),
		}
	}

	/// The lock-free part: attributes, the epoch for a name, the stamp; the pages after.
	fn drop_change(&self, change: &Change) -> std::io::Result<()> {
		if std::env::var(TEST_NOTIFY_FAILS).as_deref() == Ok("1") {
			return Err(std::io::Error::other("test switch"));
		}
		let told = self.told()?;
		if let Some(ino) = change.ino {
			told.notifier.inval_inode(INodeNo(ino), -1, 0)?;
			self.stamps.lock().unwrap().remove(&ino);
			let _ = told.drops.lock().unwrap().send(ino);
		}
		if let Some((parent, name)) = &change.name {
			// A local folder's times and size changed; a node folder's attributes are the node's.
			if let Parent::Local(dir) = parent {
				told.notifier.inval_inode(INodeNo(*dir), -1, 0)?;
			}
			// A name never handed to the kernel is read from the disk at its lookup, after the change.
			if self.holds(parent, name) {
				self.epoch()?;
			}
		}
		Ok(())
	}

	/// Drops every local inode handed to the kernel and every name, as for a change to each.
	fn drop_all(&self) -> std::io::Result<()> {
		let told = self.told()?;
		let inos: Vec<u64> = self.handed.lock().unwrap().keys().copied().collect();
		self.stamps.lock().unwrap().clear();
		self.epoch()?;
		for ino in inos {
			told.notifier.inval_inode(INodeNo(ino), -1, 0)?;
			let _ = told.drops.lock().unwrap().send(ino);
		}
		Ok(())
	}

	/// The kernel cache off for good: every later answer is as without it, and what the kernel holds goes. If it cannot,
	/// the program stops: its mount answers ENOTCONN, never stale.
	fn fall_back(&self, why: &str) {
		let dropped = {
			// Held until the drop is done: a change heard meanwhile is answered after it (`heard`).
			let _init = self.init.lock().unwrap();
			let _ = self.off.set(why.to_string());
			if !self.on.swap(false, Ordering::SeqCst) {
				return;
			}
			eprintln!("qorpera-folder: kernel cache off: {why}");
			if std::env::var(TEST_SLOW_FALL_BACK).as_deref() == Ok("1") {
				std::thread::sleep(SLOW_FALL_BACK);
			}
			self.drop_all()
		};
		if let Err(e) = dropped {
			eprintln!("qorpera-folder: kernel cache: could not drop what the kernel holds ({e}); stopping");
			self.stop();
			std::process::exit(1);
		}
		eprintln!("qorpera-folder: kernel cache: dropped what the kernel held");
	}

	/// The program stops: other programs no longer tell it anything.
	pub(super) fn stop(&self) {
		if let Some(peers) = self.peers.get() {
			peers.listener.remove();
		}
	}

	fn told(&self) -> std::io::Result<&Told> {
		self.told.get().ok_or_else(|| std::io::Error::other("the mount is not made yet"))
	}

	/// `FUSE_NOTIFY_INC_EPOCH`: a notify header alone, which fuser has no call for.
	fn epoch(&self) -> std::io::Result<()> {
		let told = self.told()?;
		let mut header = [0u8; 16];
		header[..4].copy_from_slice(&16u32.to_ne_bytes());
		header[4..8].copy_from_slice(&NOTIFY_INC_EPOCH.to_ne_bytes());
		// SAFETY: writes 16 bytes from a live buffer to the mount's own descriptor.
		let n = unsafe { libc::write(told.fuse.as_raw_fd(), header.as_ptr().cast(), header.len()) };
		match n {
			16 => Ok(()),
			n if n < 0 => Err(std::io::Error::last_os_error()),
			n => Err(std::io::Error::other(format!("the epoch notify wrote {n} of 16 bytes"))),
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn a_name_is_held_until_its_time_passed_after_the_last_reply() {
		let now = Instant::now();
		let at = |s: u64| now + Duration::from_secs(s);
		let mut names = Names::new(10);
		assert!(!names.holds(key(1, "x.js"), now));
		let (era, cleared) = names.hold(key(1, "x.js"), now, at(5));
		assert!(!cleared);
		// Between the hold and the reply, however long that takes.
		assert!(names.holds(key(1, "x.js"), at(100)));
		names.done(key(1, "x.js"), era, at(150));
		assert!(names.holds(key(1, "x.js"), at(149)));
		assert!(!names.holds(key(1, "x.js"), at(150)));
		// Another folder's name, or another name, is not held.
		assert!(!names.holds(key(2, "x.js"), now));
		assert!(!names.holds(key(1, "y.js"), now));
		// A second request's later time-out wins over the first's.
		let first = names.hold(key(1, "y.js"), now, at(5)).0;
		let second = names.hold(key(1, "y.js"), now, at(50)).0;
		names.done(key(1, "y.js"), second, at(50));
		assert!(names.holds(key(1, "y.js"), at(60)), "a request still between its hold and reply");
		names.done(key(1, "y.js"), first, at(5));
		assert!(names.holds(key(1, "y.js"), at(49)));
		assert!(!names.holds(key(1, "y.js"), at(50)));
	}

	#[test]
	fn a_full_table_lets_go_of_names_whose_time_passed_then_of_all() {
		let now = Instant::now();
		let at = |s: u64| now + Duration::from_secs(s);
		let mut names = Names::new(4);
		for k in 0..3 {
			let (era, _) = names.hold(k, now, at(1));
			names.done(k, era, at(1));
		}
		let (era, _) = names.hold(3, now, at(10));
		names.done(3, era, at(10));
		// Full: a name held again takes no room.
		assert_eq!(names.hold(3, now, at(10)), (0, false));
		names.done(3, 0, at(10));
		// The three whose time passed go, and nothing else.
		assert_eq!(names.hold(4, at(2), at(10)), (0, false));
		assert!(names.holds(3, at(2)) && names.holds(4, at(2)) && !names.holds(0, at(2)));
		assert_eq!(names.held.len(), 2);
		// Full of names still held: all go (the caller raises the epoch), in a new era.
		for k in 5..7 {
			names.hold(k, at(2), at(10));
		}
		assert_eq!(names.hold(7, at(2), at(10)), (1, true));
		assert!(!names.holds(3, at(2)) && !names.holds(4, at(2)) && names.holds(7, at(2)));
		// A reply to a request held before then counts down no name held since.
		let (era, _) = names.hold(5, at(2), at(3));
		names.done(5, 0, at(3));
		assert!(names.holds(5, at(100)));
		names.done(5, era, at(3));
		assert!(!names.holds(5, at(3)));
		// The table never grows past its bound.
		for k in 100..1000 {
			names.hold(k, at(2), at(10));
			assert!(names.held.len() <= 4);
		}
	}
}
