//! The node's vsock bridge: takes each machine's connection on the folder port and passes it to the
//! folder service's Unix socket, after one frame that names the machine: its CID from the node's kernel
//! (a machine cannot claim another's) and the instance LXD says has that CID now (`lxd.rs`). The service
//! accepts that frame only first, and only on its own socket, which only this bridge's account may open.
//!
//! The bridge reads nothing a machine sends: every byte is passed through as it is.

use crate::frame::{kind, write_frame};
use crate::lxd::Machines;
use crate::mux::{Mux, WorkerPool};
use crate::proto::Bridge;
use crate::transport::{connect, Listener, Stream};
use std::collections::HashMap;
use std::io;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const HANDSHAKE_WORKERS: usize = 4;

/// Connections one machine may hold open at once. A guard against a machine (where an agent can be root)
/// exhausting the node's threads, not a product limit: a folder program opens one feed and at most 16
/// request connections per mount, and a company machine has at most twelve mounts.
pub const PER_MACHINE: usize = 512;

/// CIDs 0–2 are the hypervisor, the local loopback and the host itself; no machine has them.
const FIRST_GUEST_CID: u32 = 3;

struct MachineGuard {
	open: Arc<Mutex<HashMap<u32, usize>>>,
	cid: u32,
}

impl Drop for MachineGuard {
	fn drop(&mut self) {
		release(&self.open, self.cid);
	}
}

pub fn run(listen: &str, service: &str, per_machine: usize, lxd_socket: &str) -> io::Result<()> {
	let listener = Listener::bind(listen)?;
	if !matches!(listener, Listener::Vsock(_)) {
		return Err(io::Error::new(io::ErrorKind::InvalidInput, "the bridge listens on vsock only"));
	}
	eprintln!("qorpera-folder bridge: {listen} -> {service}");
	// WHY: Multiplex bridged connections on one epoll loop + 4 handshake workers instead of 2 OS threads and 256 KiB per connection.
	let mux = Arc::new(Mux::spawn("bridge-mux")?);
	let pool = WorkerPool::new("bridge-init", HANDSHAKE_WORKERS)?;
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
		let guard = MachineGuard { open: open.clone(), cid };
		let mux = Arc::clone(&mux);
		pool.submit(move || {
			if let Err(e) = handshake_and_attach(stream, cid, &service, &machines, &mux, guard) {
				eprintln!("qorpera-folder bridge: machine {cid}: {e}");
			}
		});
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
fn handshake_and_attach(
	machine: Stream,
	cid: u32,
	service: &str,
	machines: &Machines,
	mux: &Mux,
	guard: MachineGuard,
) -> io::Result<()> {
	let (lookup, found) = machines.lookup(cid);
	let mut to_service = connect(service)?;
	let handshake = Duration::from_secs(10);
	let _ = to_service.set_timeouts(Some(handshake), Some(handshake));
	let bridge = Bridge { cid, lookup, machine: found };
	write_frame(&mut to_service, kind::BRIDGE, &serde_json::to_vec(&bridge).expect("serializes"))?;
	let _ = to_service.set_timeouts(None, None);
	mux.add(machine, to_service, guard)
}
