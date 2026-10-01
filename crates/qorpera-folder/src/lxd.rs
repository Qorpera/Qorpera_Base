//! Which machine has a vsock CID, as this node's LXD says: one fixed read request on LXD's local socket, made
//! by the bridge for every machine connection. Nothing is cached, because LXD may give a machine another CID
//! when it starts again. The bridge reads nothing a machine sends, so the account that may ask LXD (which is
//! root-equivalent on the node) never parses machine input.

use crate::proto::{Lookup, Machine};
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::time::Duration;

pub const SOCKET: &str = "/var/snap/lxd/common/lxd/unix.socket";
/// The largest answer read from LXD: every instance on the node with its configuration.
const MAX_ANSWER: u64 = 64 * 1024 * 1024;

/// The running machine with this CID, if any. Anything unexpected from LXD is `Unavailable`, never `None`:
/// the service then answers "try again" instead of refusing the machine.
pub fn lookup(socket: &str, cid: u32, timeout: Duration) -> (Lookup, Option<Machine>) {
	match instances(socket, timeout) {
		Ok(body) => find(&body, cid),
		Err(_) => (Lookup::Unavailable, None),
	}
}

fn instances(socket: &str, timeout: Duration) -> std::io::Result<Vec<u8>> {
	let mut s = UnixStream::connect(socket)?;
	s.set_read_timeout(Some(timeout))?;
	s.set_write_timeout(Some(timeout))?;
	// HTTP/1.0: LXD then answers with the whole body and closes, never chunked.
	s.write_all(b"GET /1.0/instances?all-projects=true&recursion=1 HTTP/1.0\r\nHost: lxd\r\n\r\n")?;
	let mut answer = Vec::new();
	s.take(MAX_ANSWER + 1).read_to_end(&mut answer)?;
	if answer.len() as u64 > MAX_ANSWER {
		return Err(std::io::Error::other("LXD answer is too large"));
	}
	let split = answer.windows(4).position(|w| w == b"\r\n\r\n").ok_or_else(|| std::io::Error::other("no HTTP head"))?;
	let status = answer[..split].split(|&b| b == b'\n').next().unwrap_or_default();
	if !(status.starts_with(b"HTTP/1.") && status.get(8..13) == Some(b" 200 ")) {
		return Err(std::io::Error::other("LXD did not answer 200"));
	}
	Ok(answer[split + 4..].to_vec())
}

fn find(body: &[u8], cid: u32) -> (Lookup, Option<Machine>) {
	let Ok(answer) = serde_json::from_slice::<serde_json::Value>(body) else { return (Lookup::Unavailable, None) };
	let Some(instances) = answer.get("metadata").and_then(|m| m.as_array()) else {
		return (Lookup::Unavailable, None);
	};
	let wanted = cid.to_string();
	for instance in instances {
		let config = instance.get("config");
		let field = |key: &str| config.and_then(|c| c.get(key)).and_then(|v| v.as_str());
		if field("volatile.vsock_id") != Some(wanted.as_str()) {
			continue;
		}
		let text = |key: &str| instance.get(key).and_then(|v| v.as_str());
		return match (text("status"), text("project"), text("name"), field("volatile.uuid")) {
			(Some("Running"), Some(project), Some(name), Some(uuid)) => (
				Lookup::Found,
				Some(Machine { project: project.to_string(), name: name.to_string(), physical_id: uuid.to_string() }),
			),
			// Not running (a stale CID), or an answer without the fields: never a match.
			(Some(_), Some(_), Some(_), _) => (Lookup::None, None),
			_ => (Lookup::Unavailable, None),
		};
	}
	(Lookup::None, None)
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::os::unix::net::UnixListener;

	fn answer(instances: &str) -> Vec<u8> {
		format!(r#"{{"type":"sync","status":"Success","status_code":200,"metadata":[{instances}]}}"#).into_bytes()
	}

	const EXEC: &str = r#"{"name":"qorpera-exec-node02","project":"qn25b2","status":"Running","config":{"volatile.vsock_id":"42","volatile.uuid":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","image.os":"ubuntu"}}"#;
	const STOPPED: &str = r#"{"name":"old","project":"p","status":"Stopped","config":{"volatile.vsock_id":"43","volatile.uuid":"u"}}"#;

	#[test]
	fn finds_the_running_machine_with_the_cid() {
		let body = answer(&format!("{STOPPED},{EXEC}"));
		let (lookup, machine) = find(&body, 42);
		assert_eq!(lookup, Lookup::Found);
		assert_eq!(
			machine,
			Some(Machine {
				project: "qn25b2".into(),
				name: "qorpera-exec-node02".into(),
				physical_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee".into()
			})
		);
		assert_eq!(find(&body, 43), (Lookup::None, None), "a stopped machine's CID matches nothing");
		assert_eq!(find(&body, 44), (Lookup::None, None));
		// "4" must not match "42".
		assert_eq!(find(&body, 4), (Lookup::None, None));
		assert_eq!(find(b"not json", 42), (Lookup::Unavailable, None));
		assert_eq!(find(br#"{"metadata":{}}"#, 42), (Lookup::Unavailable, None));
	}

	fn serve_once(reply: Vec<u8>) -> (String, std::thread::JoinHandle<Vec<u8>>) {
		let dir = std::env::temp_dir().join(format!(
			"qorpera-folder-lxd-{}-{}",
			std::process::id(),
			std::time::UNIX_EPOCH.elapsed().unwrap().as_nanos()
		));
		std::fs::create_dir(&dir).unwrap();
		let path = dir.join("lxd.sock");
		let listener = UnixListener::bind(&path).unwrap();
		let handle = std::thread::spawn(move || {
			let (mut s, _) = listener.accept().unwrap();
			let mut request = vec![0u8; 4096];
			let n = s.read(&mut request).unwrap();
			s.write_all(&reply).unwrap();
			drop(s);
			let _ = std::fs::remove_dir_all(&dir);
			request.truncate(n);
			request
		});
		(path.to_string_lossy().into_owned(), handle)
	}

	#[test]
	fn asks_lxd_once_over_its_socket() {
		let mut reply = b"HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n".to_vec();
		reply.extend(answer(EXEC));
		let (socket, server) = serve_once(reply);
		let (lookup, machine) = lookup(&socket, 42, Duration::from_secs(5));
		assert_eq!(lookup, Lookup::Found);
		assert_eq!(machine.unwrap().name, "qorpera-exec-node02");
		let request = String::from_utf8(server.join().unwrap()).unwrap();
		assert!(request.starts_with("GET /1.0/instances?all-projects=true&recursion=1 HTTP/1.0\r\n"), "{request}");
	}

	#[test]
	fn an_error_or_no_lxd_is_unavailable_not_a_refusal() {
		let (socket, server) = serve_once(b"HTTP/1.0 500 Internal Server Error\r\n\r\n{}".to_vec());
		assert_eq!(lookup(&socket, 42, Duration::from_secs(5)), (Lookup::Unavailable, None));
		server.join().unwrap();
		assert_eq!(lookup("/nonexistent/lxd.sock", 42, Duration::from_secs(1)), (Lookup::Unavailable, None));
	}
}
