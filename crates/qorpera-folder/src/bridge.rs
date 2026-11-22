//! The node's vsock bridge: takes each machine's connection on the folder port and passes it to the
//! folder service's Unix socket, after one frame that names the machine: its CID from the node's kernel
//! (a machine cannot claim another's) and the instance LXD says has that CID now (`lxd.rs`). The service
//! accepts that frame only first, and only on its own socket, which only this bridge's account may open.
//!
//! The bridge reads nothing a machine sends: every byte is passed through as it is.

use crate::frame::{kind, write_frame};
use crate::lxd::Machines;
use crate::proto::Bridge;
use crate::transport::{connect, Listener, Stream};
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const COPY_BUF_BYTES: usize = 128 * 1024;

/// Connections one machine may hold open at once. A guard against a machine (where an agent can be root)
/// exhausting the node's threads, not a product limit: a folder program opens one feed and at most 16
/// request connections per mount, and a company machine has at most twelve mounts.
pub const PER_MACHINE: usize = 512;

/// CIDs 0–2 are the hypervisor, the local loopback and the host itself; no machine has them.
const FIRST_GUEST_CID: u32 = 3;

pub fn run(listen: &str, service: &str, per_machine: usize, lxd_socket: &str) -> io::Result<()> {
	let listener = Listener::bind(listen)?;
	if !matches!(listener, Listener::Vsock(_)) {
		return Err(io::Error::new(io::ErrorKind::InvalidInput, "the bridge listens on vsock only"));
	}
	eprintln!("qorpera-folder bridge: {listen} -> {service}");
	let machines = Arc::new(Machines::new(lxd_socket));
	let open: Arc<Mutex<HashMap<u32, usize>>> = Arc::new(Mutex::new(HashMap::new()));
	loop {
		let (stream, cid) = match listener.accept() {
			Ok(accepted) => accepted,
			Err(e) => {
				eprintln!("qorpera-folder bridge: accept: {e}");
				std::thread::sleep(Duration::from_millis(100));
				continue;
			}
		};
		let Some(cid) = cid.filter(|&c| c >= FIRST_GUEST_CID) else {
			stream.shutdown();
			continue;
		};
		{
			let mut open = open.lock().unwrap();
			let count = open.entry(cid).or_insert(0);
			if *count >= per_machine {
				eprintln!("qorpera-folder bridge: machine {cid} already holds {count} connections; refused one more");
				stream.shutdown();
				continue;
			}
			*count += 1;
		}
		let service = service.to_string();
		let machines = machines.clone();
		let done = open.clone();
		let spawned = std::thread::Builder::new().name(format!("bridge-{cid}")).spawn(move || {
			if let Err(e) = pass(stream, cid, &service, &machines) {
				eprintln!("qorpera-folder bridge: machine {cid}: {e}");
			}
			release(&done, cid);
		});
		if let Err(e) = spawned {
			eprintln!("qorpera-folder bridge: no thread for machine {cid}: {e}");
			release(&open, cid);
		}
	}
}

fn release(open: &Mutex<HashMap<u32, usize>>, cid: u32) {
	let mut open = open.lock().unwrap();
	if let Some(count) = open.get_mut(&cid) {
		*count -= 1;
		if *count == 0 {
			open.remove(&cid);
		}
	}
}

/// Names the machine, then passes its connection through to the service until either side closes.
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

fn pass(machine: Stream, cid: u32, service: &str, machines: &Machines) -> io::Result<()> {
	let (lookup, found) = machines.lookup(cid);
	let mut to_service = connect(service)?;
	let handshake = std::time::Duration::from_secs(10);
	let _ = to_service.set_timeouts(Some(handshake), Some(handshake));
	let bridge = Bridge { cid, lookup, machine: found };
	write_frame(&mut to_service, kind::BRIDGE, &serde_json::to_vec(&bridge).expect("serializes"))?;
	let _ = to_service.set_timeouts(None, None);
	let mut from_machine = machine.try_clone()?;
	let mut into_service = to_service.try_clone()?;
	let (up_tx, up_rx) = std::sync::mpsc::channel::<()>();
	let upstream = std::thread::Builder::new().name(format!("bridge-{cid}-up")).spawn(move || {
		// WHY: Propagate clean EOF with SHUT_WR so half-closed requests keep receiving their in-flight response.
		if copy_buffered(&mut from_machine, &mut into_service).is_ok() {
			into_service.shutdown_write();
		} else {
			into_service.shutdown();
			from_machine.shutdown();
		}
		let _ = up_tx.send(());
	})?;
	let mut into_machine = machine;
	if copy_buffered(&mut to_service, &mut into_machine).is_ok() {
		into_machine.shutdown_write();
		// WHY: Bound teardown when the service closes an idle pooled socket so the upstream copy thread exits promptly.
		if up_rx.recv_timeout(std::time::Duration::from_millis(200)).is_err() {
			into_machine.shutdown();
			to_service.shutdown();
		}
	} else {
		into_machine.shutdown();
		to_service.shutdown();
	}
	let _ = upstream.join();
	Ok(())
}
