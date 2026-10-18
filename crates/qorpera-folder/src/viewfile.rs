//! Private view credentials and their durable handover proof. The helper replaces `primary`; the last accepted
//! view stays beside the journal until the service accepts its successor. A fixed lock inode serializes mount
//! threads and independent publishers, including an acknowledgement lost before its checkpoint was written.

use crate::link::View;
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

const PROOF: &str = "view.json";
const LOCK: &str = "view.lock";
const DAEMON: &str = "daemon.lock";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
	schema: String,
	view: View,
}

pub struct ViewFile {
	primary: PathBuf,
	dir: PathBuf,
	lock: Mutex<File>,
}

pub struct Prepared<'a> {
	store: &'a ViewFile,
	_lock: ViewLock<'a>,
	pub target: View,
	pub previous: Option<View>,
}

struct ViewLock<'a>(MutexGuard<'a, File>);

impl Drop for ViewLock<'_> {
	fn drop(&mut self) { let _ = flock(&self.0, libc::LOCK_UN); }
}

/// Held by the mounted program throughout its lifetime. A publisher that acquires it knows no mount is running
/// and excludes a restart until its boundary ends; a failed nonblocking acquisition means the mount is alive.
pub struct DaemonLock(File);

impl ViewFile {
	/// `fresh` is the journal's actual first initialization, never inferred from a missing proof file. The initial
	/// credential is checkpointed before any FUSE operation can be served; subsequent checkpoints require a hello.
	pub fn open(primary: PathBuf, dir: &Path, initial: &View, fresh: bool) -> io::Result<Self> {
		let meta = std::fs::symlink_metadata(dir)?;
		if !meta.is_dir() || !private(&meta) {
			return Err(bad("view state must be a private directory owned by the daemon"));
		}
		// A publisher must not create this lock while a first mount is still initializing its read journal.
		let store = Self { primary, dir: dir.to_path_buf(), lock: Mutex::new(open_private(&dir.join(LOCK), fresh)?) };
		{
			let _lock = store.acquire()?;
			if fresh {
				// A fresh journal is made only in empty state. Existing proof is never overwritten as initialization.
				if store.dir.join(PROOF).try_exists()? {
					return Err(bad("unexpected view proof in new mount state"));
				}
				store.save(initial)?;
			} else {
				store.last()?;
			}
		}
		Ok(store)
	}

	fn acquire(&self) -> io::Result<ViewLock<'_>> {
		let guard = self.lock.lock().unwrap();
		flock(&guard, libc::LOCK_EX)?;
		Ok(ViewLock(guard))
	}

	fn last(&self) -> io::Result<View> {
		let bytes = read_private(&self.dir.join(PROOF), 4096)?;
		let record: Record = serde_json::from_slice(&bytes).map_err(|_| bad("view proof is not complete"))?;
		if record.schema != "qorpera.folder-view-proof/v1" || !valid(&record.view) {
			return Err(bad("view proof is not complete"));
		}
		Ok(record.view)
	}

	fn save(&self, view: &View) -> io::Result<()> {
		let temporary = self.dir.join("view.next");
		let mut file = open_private(&temporary, true)?;
		file.set_len(0)?;
		serde_json::to_writer(&mut file, &Record { schema: "qorpera.folder-view-proof/v1".into(), view: view.clone() })?;
		file.write_all(b"\n")?;
		file.sync_all()?;
		std::fs::rename(temporary, self.dir.join(PROOF))?;
		File::open(&self.dir)?.sync_all()
	}

	/// The file is read under the same lock as the checkpoint: a publisher cannot checkpoint an old target after
	/// another process accepted a newer one. The caller holds this guard through hello and `accepted`.
	pub fn prepare(&self) -> io::Result<Prepared<'_>> {
		let guard = self.acquire()?;
		let result = (|| {
			let target = read(&self.primary)?;
			let last = self.last()?;
			if target.environment_id != last.environment_id {
				return Err(bad("a mount cannot switch company"));
			}
			if target.view_id == last.view_id && target.pass != last.pass {
				return Err(bad("a view's credentials cannot change"));
			}
			let previous = (target != last).then_some(last);
			Ok((target, previous))
		})();
		let (target, previous) = result?;
		Ok(Prepared { store: self, _lock: guard, target, previous })
	}

	pub fn target(&self) -> io::Result<View> {
		read(&self.primary)
	}
}

impl Prepared<'_> {
	pub fn accepted(&self) -> io::Result<()> {
		if self.previous.is_some() { self.store.save(&self.target)?; }
		Ok(())
	}
}

impl DaemonLock {
	pub fn acquire(dir: &Path, wait: bool, create: bool) -> io::Result<Option<Self>> {
		if create { std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?; }
		let meta = std::fs::symlink_metadata(dir)?;
		if !meta.is_dir() || !private(&meta) { return Err(bad("mount state must be private to the daemon")); }
		let file = open_private(&dir.join(DAEMON), create)?;
		match flock(&file, libc::LOCK_EX | if wait { 0 } else { libc::LOCK_NB }) {
			Ok(()) => Ok(Some(Self(file))),
			Err(error) if !wait && error.kind() == io::ErrorKind::WouldBlock => Ok(None),
			Err(error) => Err(error),
		}
	}
}

impl Drop for DaemonLock {
	fn drop(&mut self) { let _ = flock(&self.0, libc::LOCK_UN); }
}

pub(crate) fn flock(file: &File, operation: i32) -> io::Result<()> {
	loop {
		// SAFETY: the descriptor is owned by the caller's live File.
		if unsafe { libc::flock(file.as_raw_fd(), operation) } == 0 { return Ok(()); }
		let error = io::Error::last_os_error();
		if error.kind() != io::ErrorKind::Interrupted { return Err(error); }
	}
}

pub(crate) fn private(meta: &std::fs::Metadata) -> bool {
	// SAFETY: geteuid has no preconditions.
	meta.uid() == unsafe { libc::geteuid() } && meta.mode() & 0o077 == 0
}

fn open_private(path: &Path, create: bool) -> io::Result<File> {
	let file = OpenOptions::new().read(true).write(true).create(create).mode(0o600).custom_flags(libc::O_NOFOLLOW).open(path)?;
	let meta = file.metadata()?;
	if !meta.is_file() || !private(&meta) { return Err(bad("view state must be a private regular file owned by the daemon")); }
	Ok(file)
}

fn read_private(path: &Path, limit: u64) -> io::Result<Vec<u8>> {
	let file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(path)?;
	let meta = file.metadata()?;
	if !meta.is_file() || !private(&meta) || meta.len() > limit {
		return Err(bad("view credentials must be a private regular file of at most 4 KiB owned by the daemon"));
	}
	let mut bytes = Vec::new();
	file.take(limit + 1).read_to_end(&mut bytes)?;
	if bytes.len() as u64 > limit { return Err(bad("view credentials exceed 4 KiB")); }
	Ok(bytes)
}

fn valid(view: &View) -> bool {
	[&view.environment_id, &view.view_id, &view.pass].iter().all(|v| !v.is_empty() && v.len() <= 256 && v.bytes().all(|b| b.is_ascii_graphic()))
}

pub fn read(path: &Path) -> io::Result<View> {
	let view: View = serde_json::from_slice(&read_private(path, 4096)?).map_err(|_| bad("view file must be JSON {environmentId,viewId,pass}"))?;
	if !valid(&view) { return Err(bad("view credentials must be printable ASCII without spaces")); }
	Ok(view)
}

fn bad(message: &str) -> io::Error { io::Error::new(io::ErrorKind::InvalidData, message) }

#[cfg(test)]
mod tests {
	use super::*;
	use std::os::unix::fs::{DirBuilderExt, PermissionsExt, symlink};
	use std::sync::atomic::{AtomicUsize, Ordering};

	struct Temp(PathBuf);
	impl Temp {
		fn new() -> Self {
			static NEXT: AtomicUsize = AtomicUsize::new(0);
			let dir = std::env::temp_dir().join(format!("qorpera-view-proof-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
			std::fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
			Self(dir)
		}
		fn primary(&self, view: &View) -> PathBuf {
			let temporary = self.0.join("primary.next");
			let mut file = open_private(&temporary, true).unwrap();
			file.set_len(0).unwrap();
			serde_json::to_writer(&mut file, view).unwrap();
			file.sync_all().unwrap();
			let primary = self.0.join("primary.json");
			std::fs::rename(temporary, &primary).unwrap();
			primary
		}
	}
	impl Drop for Temp { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
	fn view(id: &str) -> View { View { environment_id: "company".into(), view_id: id.into(), pass: format!("pass-{id}") } }

	#[test]
	fn replacement_and_process_death_keep_old_proof_until_successful_hello() {
		let temp = Temp::new();
		let a = view("a");
		let primary = temp.primary(&a);
		let store = ViewFile::open(primary.clone(), &temp.0, &a, true).unwrap();
		assert!(store.prepare().unwrap().previous.is_none());
		temp.primary(&view("b"));
		{
			let pending = store.prepare().unwrap();
			assert_eq!(pending.previous.as_ref().unwrap(), &a);
			assert_eq!(pending.target, view("b"));
			// Process/link death before acceptance: no checkpoint.
		}
		drop(store);
		let restarted = ViewFile::open(primary, &temp.0, &view("b"), false).unwrap();
		let pending = restarted.prepare().unwrap();
		assert_eq!(pending.previous, Some(a));
		pending.accepted().unwrap();
		drop(pending);
		assert!(restarted.prepare().unwrap().previous.is_none());
	}

	#[test]
	fn rapid_replacements_name_the_last_acknowledged_view_and_publishers_share_the_checkpoint() {
		let temp = Temp::new();
		let a = view("a");
		let primary = temp.primary(&a);
		let mount = ViewFile::open(primary.clone(), &temp.0, &a, true).unwrap();
		temp.primary(&view("b"));
		temp.primary(&view("c"));
		let publisher = ViewFile::open(primary, &temp.0, &view("c"), false).unwrap();
		let pending = publisher.prepare().unwrap();
		assert_eq!(pending.previous, Some(a));
		assert_eq!(pending.target, view("c"));
		pending.accepted().unwrap();
		drop(pending);
		temp.primary(&view("d"));
		assert_eq!(mount.prepare().unwrap().previous, Some(view("c")));
	}

	#[test]
	fn missing_bad_or_cross_company_proof_is_never_reinitialized() {
		let temp = Temp::new();
		let a = view("a");
		let primary = temp.primary(&a);
		assert!(ViewFile::open(primary.clone(), &temp.0, &a, false).is_err());
		let store = ViewFile::open(primary.clone(), &temp.0, &a, true).unwrap();
		let mut other = view("b");
		other.environment_id = "another-company".into();
		temp.primary(&other);
		assert!(store.prepare().is_err());
		temp.primary(&a);
		std::fs::remove_file(temp.0.join(PROOF)).unwrap();
		assert!(store.prepare().is_err());
		assert!(ViewFile::open(primary, &temp.0, &a, false).is_err());
	}

	#[test]
	fn credentials_and_proof_stay_private_and_symlinks_are_refused() {
		let temp = Temp::new();
		let a = view("a");
		let primary = temp.primary(&a);
		let store = ViewFile::open(primary.clone(), &temp.0, &a, true).unwrap();
		for path in [primary.clone(), temp.0.join(PROOF), temp.0.join(LOCK)] {
			assert_eq!(std::fs::metadata(path).unwrap().mode() & 0o777, 0o600);
		}
		std::fs::set_permissions(&primary, std::fs::Permissions::from_mode(0o644)).unwrap();
		assert!(store.prepare().is_err());
		std::fs::set_permissions(&primary, std::fs::Permissions::from_mode(0o600)).unwrap();
		std::fs::remove_file(temp.0.join(PROOF)).unwrap();
		symlink(&primary, temp.0.join(PROOF)).unwrap();
		assert!(store.prepare().is_err());
	}

	#[test]
	fn a_daemon_lock_proves_liveness_and_excludes_a_restart_during_dead_program_publish() {
		let temp = Temp::new();
		let missing = temp.0.join("missing");
		assert!(DaemonLock::acquire(&missing, false, false).is_err());
		assert!(!missing.exists());
		let daemon = DaemonLock::acquire(&temp.0, true, true).unwrap().unwrap();
		assert!(DaemonLock::acquire(&temp.0, false, false).unwrap().is_none());
		drop(daemon);
		let publisher = DaemonLock::acquire(&temp.0, false, false).unwrap().unwrap();
		assert!(DaemonLock::acquire(&temp.0, false, true).unwrap().is_none());
		drop(publisher);
		assert!(DaemonLock::acquire(&temp.0, false, true).unwrap().is_some());
	}
}
