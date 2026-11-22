//! The execution host's relay to its node's folder service (F3 `company_search`). A run's native host is a Node
//! program, which cannot open vsock, so a socket per slot carries its connection to the node's bridge, byte for
//! byte. The relay reads nothing it carries: the node's bridge names the calling machine (this host, by the CID the
//! kernel reports), and the folder service checks the run's view and its pass, as for any machine.

use crate::transport::{self, Stream};
use std::io::{self, Read, Write};
use std::os::unix::net::UnixListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

const COPY_BUF_BYTES: usize = 128 * 1024;
const MAX_RELAY_CONNECTIONS: usize = 512;

struct ActiveGuard(Arc<AtomicUsize>);

impl Drop for ActiveGuard {
	fn drop(&mut self) {
		self.0.fetch_sub(1, Ordering::AcqRel);
	}
}

fn try_acquire(active: &Arc<AtomicUsize>, limit: usize) -> Option<ActiveGuard> {
	let mut cur = active.load(Ordering::Acquire);
	loop {
		if cur >= limit {
			return None;
		}
		match active.compare_exchange_weak(cur, cur + 1, Ordering::AcqRel, Ordering::Acquire) {
			Ok(_) => return Some(ActiveGuard(Arc::clone(active))),
			Err(next) => cur = next,
		}
	}
}

/// Serves every connection to `listener`, each over its own connection to `upstream`. An accept that fails for the
/// moment (no descriptors left, a caller gone before it was taken) is logged and the relay goes on, so the slot's other
/// connections stay up. A listening socket that can never accept again ends the relay with the error, and systemd
/// starts it again (`Restart=on-failure`).
pub fn run(listener: UnixListener, upstream: &str) -> io::Result<()> {
	run_with_limit(listener, upstream, MAX_RELAY_CONNECTIONS)
}

fn run_with_limit(listener: UnixListener, upstream: &str, max_connections: usize) -> io::Result<()> {
	let active = Arc::new(AtomicUsize::new(0));
	for local in listener.incoming() {
		let local = match local {
			Ok(s) => s,
			Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
			Err(e) if listener_broken(&e) => return Err(e),
			Err(e) => {
				eprintln!("qorpera-folder relay: accept: {e}");
				std::thread::sleep(std::time::Duration::from_millis(100));
				continue;
			}
		};
		let Some(guard) = try_acquire(&active, max_connections) else {
			eprintln!("qorpera-folder relay: too many open connections ({max_connections}); refusing");
			let _ = local.shutdown(std::net::Shutdown::Both);
			continue;
		};
		let upstream = upstream.to_string();
		let spawned = std::thread::Builder::new().name("relay".into()).spawn(move || {
			let _guard = guard;
			match transport::connect(&upstream) {
				Ok(remote) => pipe(Stream::Unix(local), remote),
				// The caller sees its connection end and asks again.
				Err(e) => eprintln!("qorpera-folder relay: {upstream}: {e}"),
			}
		});
		if let Err(e) = spawned {
			eprintln!("qorpera-folder relay: no thread for a connection: {e}");
		}
	}
	Ok(())
}

/// The listening socket itself is unusable: asking again only fails again.
fn listener_broken(e: &io::Error) -> bool {
	matches!(e.raw_os_error(), Some(libc::EBADF | libc::EINVAL | libc::ENOTSOCK | libc::EOPNOTSUPP | libc::EFAULT))
}

/// Copies both ways until either side ends, then ends both.
fn copy_buffered<R: Read, W: Write>(reader: &mut R, writer: &mut W) -> io::Result<u64> {
	let mut buf = vec![0u8; COPY_BUF_BYTES];
	let mut total = 0u64;
	loop {
		let n = match reader.read(&mut buf) {
			Ok(0) => return Ok(total),
			Ok(n) => n,
			Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
			Err(e) => return Err(e),
		};
		writer.write_all(&buf[..n])?;
		total += n as u64;
	}
}

fn pipe(local: Stream, remote: Stream) {
	let (mut from_local, mut into_remote) = match (local.try_clone(), remote.try_clone()) {
		(Ok(a), Ok(b)) => (a, b),
		_ => {
			local.shutdown();
			remote.shutdown();
			return;
		}
	};
	let (up_tx, up_rx) = std::sync::mpsc::channel::<()>();
	let up = std::thread::Builder::new().name("relay-up".into()).spawn(move || {
		// WHY: Propagate clean EOF with SHUT_WR so half-closed requests keep receiving their in-flight response.
		if copy_buffered(&mut from_local, &mut into_remote).is_ok() {
			into_remote.shutdown_write();
		} else {
			from_local.shutdown();
			into_remote.shutdown();
		}
		let _ = up_tx.send(());
	});
	let (mut from_remote, mut into_local) = (remote, local);
	if copy_buffered(&mut from_remote, &mut into_local).is_ok() {
		into_local.shutdown_write();
		// WHY: Bound teardown when the server closes an idle pooled socket so the up thread does not pin an ActiveGuard slot.
		if up_rx.recv_timeout(std::time::Duration::from_millis(200)).is_err() {
			from_remote.shutdown();
			into_local.shutdown();
		}
	} else {
		from_remote.shutdown();
		into_local.shutdown();
	}
	if let Ok(up) = up {
		let _ = up.join();
	}
}

/// The socket systemd passed (`LISTEN_FDS`, descriptor 3), when it is meant for this process.
pub fn systemd_listener() -> Result<UnixListener, String> {
	use std::os::fd::FromRawFd;
	let pid = std::env::var("LISTEN_PID").ok();
	let fds = std::env::var("LISTEN_FDS").ok();
	if pid.as_deref() != Some(&std::process::id().to_string()) || fds.as_deref() != Some("1") {
		return Err("--listen systemd needs the one socket of the relay's socket unit".into());
	}
	// Taken: nothing this program starts would see them as its own.
	for name in ["LISTEN_PID", "LISTEN_FDS", "LISTEN_FDNAMES"] {
		std::env::remove_var(name);
	}
	// SAFETY: fstat and getsockopt only read descriptor 3's kind into local values.
	let stream_socket = unsafe {
		let mut stat: libc::stat = std::mem::zeroed();
		let mut kind: libc::c_int = 0;
		let mut len = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
		libc::fstat(3, &mut stat) == 0
			&& stat.st_mode & libc::S_IFMT == libc::S_IFSOCK
			&& libc::getsockopt(3, libc::SOL_SOCKET, libc::SO_TYPE, (&mut kind as *mut libc::c_int).cast(), &mut len) == 0
			&& kind == libc::SOCK_STREAM
	};
	if !stream_socket {
		return Err("--listen systemd: descriptor 3 is not a stream socket".into());
	}
	// SAFETY: systemd passed descriptor 3 to this process alone (LISTEN_PID), and nothing else here owns it.
	let listener = unsafe { UnixListener::from_raw_fd(3) };
	// SAFETY: plain fcntl on a descriptor this process owns.
	unsafe { libc::fcntl(3, libc::F_SETFD, libc::FD_CLOEXEC) };
	Ok(listener)
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::io::{Read, Write};
	use std::os::unix::net::UnixStream;

	#[test]
	fn ends_when_its_listening_socket_can_never_accept_and_goes_on_past_a_passing_failure() {
		use std::os::fd::{FromRawFd, IntoRawFd};
		// A descriptor that is no socket: every accept fails the same way, so the relay ends (systemd starts it again).
		let file = std::fs::File::open("/dev/null").unwrap();
		let listener = unsafe { UnixListener::from_raw_fd(file.into_raw_fd()) };
		let ended = run(listener, "unix:/nonexistent").unwrap_err();
		assert_eq!(ended.raw_os_error(), Some(libc::ENOTSOCK));
		for passing in [libc::EMFILE, libc::ENFILE, libc::ENOBUFS, libc::ENOMEM, libc::ECONNABORTED, libc::EPROTO] {
			assert!(!listener_broken(&io::Error::from_raw_os_error(passing)), "{passing}");
		}
		for broken in [libc::EBADF, libc::EINVAL, libc::ENOTSOCK, libc::EOPNOTSUPP] {
			assert!(listener_broken(&io::Error::from_raw_os_error(broken)), "{broken}");
		}
	}

	#[test]
	fn carries_bytes_both_ways_and_ends_with_either_side() {
		let dir = std::env::temp_dir().join(format!("qorpera-folder-relay-{}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		std::fs::create_dir(&dir).unwrap();
		let service = UnixListener::bind(dir.join("service.sock")).unwrap();
		let relay = UnixListener::bind(dir.join("relay.sock")).unwrap();
		let upstream = format!("unix:{}", dir.join("service.sock").display());
		std::thread::spawn(move || run(relay, &upstream));
		// The service echoes what it is sent, upper-cased, until the caller ends.
		std::thread::spawn(move || {
			for conn in service.incoming() {
				let mut conn = conn.unwrap();
				std::thread::spawn(move || {
					let mut buf = [0u8; 64];
					loop {
						let n = conn.read(&mut buf).unwrap_or(0);
						if n == 0 {
							break;
						}
						conn.write_all(&buf[..n].to_ascii_uppercase()).unwrap();
					}
				});
			}
		});
		for _ in 0..2 {
			let mut caller = UnixStream::connect(dir.join("relay.sock")).unwrap();
			caller.write_all(b"hello node").unwrap();
			let mut answer = [0u8; 10];
			caller.read_exact(&mut answer).unwrap();
			assert_eq!(&answer, b"HELLO NODE");
			caller.shutdown(std::net::Shutdown::Write).unwrap();
			let mut rest = Vec::new();
			caller.read_to_end(&mut rest).unwrap();
			assert!(rest.is_empty(), "the relay ends the caller's side once the service ends");
		}
		// No service: the caller's connection ends.
		std::fs::remove_file(dir.join("service.sock")).unwrap();
		let mut caller = UnixStream::connect(dir.join("relay.sock")).unwrap();
		let mut rest = Vec::new();
		caller.read_to_end(&mut rest).unwrap();
		assert!(rest.is_empty());
		let _ = std::fs::remove_dir_all(&dir);
	}

	#[test]
	fn half_close_preserves_inflight_response_and_enforces_connection_cap() {
		let dir = std::env::temp_dir().join(format!(
			"qorpera-folder-relay-cap-{}-{}",
			std::process::id(),
			std::time::UNIX_EPOCH.elapsed().unwrap().as_nanos()
		));
		std::fs::create_dir(&dir).unwrap();
		let service_sock = dir.join("service.sock");
		let relay_sock = dir.join("relay.sock");
		let service = UnixListener::bind(&service_sock).unwrap();
		let relay = UnixListener::bind(&relay_sock).unwrap();
		let upstream = format!("unix:{}", service_sock.display());
		std::thread::spawn(move || run_with_limit(relay, &upstream, 1));
		std::thread::spawn(move || {
			for conn in service.incoming() {
				let mut conn = conn.unwrap();
				std::thread::spawn(move || {
					let mut req = Vec::new();
					let _ = conn.read_to_end(&mut req);
					std::thread::sleep(std::time::Duration::from_millis(60));
					let _ = conn.write_all(&req.to_ascii_uppercase());
				});
			}
		});

		let mut first = UnixStream::connect(&relay_sock).unwrap();
		first.write_all(b"ping").unwrap();
		first.shutdown(std::net::Shutdown::Write).unwrap();
		let mut second = UnixStream::connect(&relay_sock).unwrap();
		second.set_read_timeout(Some(std::time::Duration::from_secs(2))).unwrap();
		let mut refused = Vec::new();
		second.read_to_end(&mut refused).unwrap();
		assert!(refused.is_empty());

		let mut reply = Vec::new();
		first.read_to_end(&mut reply).unwrap();
		assert_eq!(reply, b"PING");
		let _ = std::fs::remove_dir_all(&dir);
	}

	#[test]
	fn server_close_on_idle_client_releases_relay_slot_promptly() {
		let dir = std::env::temp_dir().join(format!(
			"qorpera-folder-relay-idle-{}-{}",
			std::process::id(),
			std::time::UNIX_EPOCH.elapsed().unwrap().as_nanos()
		));
		std::fs::create_dir(&dir).unwrap();
		let service_sock = dir.join("service.sock");
		let relay_sock = dir.join("relay.sock");
		let service = UnixListener::bind(&service_sock).unwrap();
		let relay = UnixListener::bind(&relay_sock).unwrap();
		let upstream = format!("unix:{}", service_sock.display());
		std::thread::spawn(move || run_with_limit(relay, &upstream, 1));
		std::thread::spawn(move || {
			for (i, conn) in service.incoming().enumerate() {
				let mut conn = conn.unwrap();
				if i == 0 {
					let _ = conn.write_all(b"bye");
					drop(conn);
				} else {
					let _ = conn.write_all(b"ok");
					drop(conn);
				}
			}
		});

		let mut idle_client = UnixStream::connect(&relay_sock).unwrap();
		let mut buf = [0u8; 3];
		idle_client.read_exact(&mut buf).unwrap();
		assert_eq!(&buf, b"bye");
		std::thread::sleep(std::time::Duration::from_millis(350));

		let mut next_client = UnixStream::connect(&relay_sock).unwrap();
		next_client.set_read_timeout(Some(std::time::Duration::from_secs(2))).unwrap();
		let mut reply = Vec::new();
		next_client.read_to_end(&mut reply).unwrap();
		assert_eq!(reply, b"ok");
		drop(idle_client);
		let _ = std::fs::remove_dir_all(&dir);
	}
}
