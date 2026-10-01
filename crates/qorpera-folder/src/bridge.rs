//! The node's vsock bridge: takes each machine's connection on the folder port and passes it to the
//! folder service's Unix socket, after one frame that names the machine's CID. The CID comes from the
//! node's kernel, so a machine cannot claim another's. The service accepts that frame only first, and
//! only on its own socket, which only this bridge's account may open.
//!
//! The bridge reads nothing else: every other byte is passed through as it is.

use crate::frame::{kind, write_frame};
use crate::proto::Bridge;
use crate::transport::{connect, Listener, Stream};
use std::collections::HashMap;
use std::io;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Connections one machine may hold open at once. A guard against a machine (where an agent can be root)
/// exhausting the node's threads, not a product limit: a folder program opens one feed and at most 16
/// request connections per mount, and a company machine has at most twelve mounts.
pub const PER_MACHINE: usize = 512;

/// CIDs 0–2 are the hypervisor, the local loopback and the host itself; no machine has them.
const FIRST_GUEST_CID: u32 = 3;

pub fn run(listen: &str, service: &str, per_machine: usize) -> io::Result<()> {
	let listener = Listener::bind(listen)?;
	if !matches!(listener, Listener::Vsock(_)) {
		return Err(io::Error::new(io::ErrorKind::InvalidInput, "the bridge listens on vsock only"));
	}
	eprintln!("qorpera-folder bridge: {listen} -> {service}");
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
		let open = open.clone();
		let spawned = std::thread::Builder::new().name(format!("bridge-{cid}")).spawn(move || {
			if let Err(e) = pass(stream, cid, &service) {
				eprintln!("qorpera-folder bridge: machine {cid}: {e}");
			}
			let mut open = open.lock().unwrap();
			if let Some(count) = open.get_mut(&cid) {
				*count -= 1;
				if *count == 0 {
					open.remove(&cid);
				}
			}
		});
		if let Err(e) = spawned {
			eprintln!("qorpera-folder bridge: no thread for machine {cid}: {e}");
		}
	}
}

/// Passes one machine connection through to the service until either side closes.
fn pass(machine: Stream, cid: u32, service: &str) -> io::Result<()> {
	let mut to_service = connect(service)?;
	write_frame(&mut to_service, kind::BRIDGE, &serde_json::to_vec(&Bridge { cid }).expect("serializes"))?;
	let mut from_machine = machine.try_clone()?;
	let mut into_service = to_service.try_clone()?;
	let upstream = std::thread::Builder::new().name(format!("bridge-{cid}-up")).spawn(move || {
		let _ = io::copy(&mut from_machine, &mut into_service);
		// The machine closed (or broke): end both directions.
		into_service.shutdown();
		from_machine.shutdown();
	})?;
	let mut into_machine = machine;
	let _ = io::copy(&mut to_service, &mut into_machine);
	into_machine.shutdown();
	to_service.shutdown();
	let _ = upstream.join();
	Ok(())
}
