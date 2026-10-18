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
//! A notify that fails, a change told late, or a listener that stopped turns the kernel cache off for good: everything
//! handed to the kernel is dropped, and if that fails too the program exits (its mount closed, never stale).

use super::*;
use crate::local::Stamp;
use crate::peers::{self, Change, Heard, Listener, Parent, Teller};
use std::os::fd::{AsRawFd, OwnedFd};
use std::sync::OnceLock;

/// FUSE_NOTIFY_INC_EPOCH (ABI 7.44).
const NOTIFY_INC_EPOCH: i32 = 8;
/// Test switches: the kernel cache off with this reason, as a kernel without the epoch would (`QORPERA_FOLDER_TEST_KERNEL_OFF`);
/// a told change's notify failing (`QORPERA_FOLDER_TEST_NOTIFY_FAILS=1`), not the fallback's.
const TEST_OFF: &str = "QORPERA_FOLDER_TEST_KERNEL_OFF";
const TEST_NOTIFY_FAILS: &str = "QORPERA_FOLDER_TEST_NOTIFY_FAILS";

pub(super) struct Kernel {
	/// A writable view, which has caches.
	caches: bool,
	/// Why the kernel cache may not be used, known before the mount (the cache folder's times, a test switch).
	allowed: Result<(), String>,
	/// The kernel cache is on: from `init` and `mounted`, whichever comes last, until a fallback.
	on: AtomicBool,
	/// Whether the kernel's INIT allows the kernel cache, until the mount is made too (fuser answers INIT before
	/// `Session::new` returns, so before `mounted`).
	init: Mutex<Option<Result<(), String>>>,
	/// The first fallback's reason, also one heard before the kernel cache was decided.
	off: OnceLock<String>,
	told: OnceLock<Told>,
	/// Local inodes the kernel holds an entry of, and how many lookups it counts for each (absent names aside).
	handed: Mutex<HashMap<u64, u64>>,
	/// What each local file was at the last open answered here: an open keeps the kernel's pages only when the file is
	/// still so (another program's change nobody told, an inode number the disk gave again).
	stamps: Mutex<HashMap<u64, Stamp>>,
	peers: OnceLock<Peers>,
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

	/// Forgets on this mount what another program told (`peers.rs`), before the answer.
	fn heard(&self, h: Heard) {
		match h {
			Heard::Change(change) => {
				if self.on() {
					if let Err(e) = self.drop_change(&change) {
						self.fall_back(&format!("a told change's notify failed: {e}"));
					}
				}
			}
			Heard::Late(_) => self.fall_back("a change was told later than the teller waits"),
			Heard::Malformed(why) => {
				// The change it meant is unknown: everything handed out goes, still only invalidation.
				eprintln!("qorpera-folder: kernel cache: a malformed message from another program: {why}");
				if self.on() {
					if let Err(e) = self.drop_all() {
						self.fall_back(&format!("dropping all after a malformed message failed: {e}"));
					}
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
		if let Some((parent, _)) = &change.name {
			// A local folder's times and size changed; a node folder's attributes are the node's.
			if let Parent::Local(dir) = parent {
				told.notifier.inval_inode(INodeNo(*dir), -1, 0)?;
			}
			self.epoch()?;
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
		{
			let _init = self.init.lock().unwrap();
			let _ = self.off.set(why.to_string());
			if !self.on.swap(false, Ordering::SeqCst) {
				return;
			}
		}
		eprintln!("qorpera-folder: kernel cache off: {why}");
		if let Err(e) = self.drop_all() {
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
