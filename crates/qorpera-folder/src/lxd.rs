//! Which machine has a vsock CID, as this node's LXD says, asked by the bridge for every machine connection
//! before any pass is checked. So any machine on the node can make the bridge ask, and asking must stay cheap:
//! - A CID confirmed in the last two seconds is answered from memory.
//! - A CID known from an earlier listing is confirmed with one single-instance request, one at a time per CID
//!   (others wait for it). An instance that is gone (404) or no longer has the CID falls through to a listing.
//! - Otherwise the node's instances are listed, one listing at a time for the whole bridge (connections arriving
//!   meanwhile wait for it), and at most one a second: a CID missing from a listing under a second old is answered
//!   "none" without asking again.
//!
//! The bridge asks over LXD's pinned loopback HTTPS listener with its own client certificate (`lxd_https`), not as
//! a member of the socket's group. Root's socket (`--lxd-socket`) stays for root tools and tests.
//!
//! The bridge reads nothing a machine sends, so the account that may ask LXD (which is root-equivalent on the node)
//! never parses machine input.

use crate::lxd_https::Https;
use crate::proto::{Lookup, Machine};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

pub const SOCKET: &str = "/var/snap/lxd/common/lxd/unix.socket";
/// The largest answer read from LXD: every instance on the node with its configuration.
const MAX_ANSWER: u64 = 64 * 1024 * 1024;
/// The largest HTTP head read from LXD.
const MAX_HEAD: usize = 16 * 1024;
const CONFIRMED_FOR: Duration = Duration::from_secs(2);
const LIST_AT_MOST_EVERY: Duration = Duration::from_secs(1);
const TIMEOUT: Duration = Duration::from_secs(5);

struct Known {
	machine: Machine,
	confirmed: Instant,
}

#[derive(Default)]
struct State {
	known: HashMap<u32, Known>,
	confirming: std::collections::HashSet<u32>,
	listing: bool,
	listed: Option<Instant>,
}

/// How the bridge reaches LXD.
pub enum Transport {
	/// The bridge's own way (WS15 V2-A1): its client certificate on the pinned loopback listener.
	Https(Https),
	/// Root's socket, for root tools and tests.
	Socket(String),
}

pub struct Machines {
	transport: Transport,
	state: Mutex<State>,
	done: Condvar,
	/// Requests made to LXD (for tests and the log).
	asked: Mutex<u64>,
}

impl Machines {
	pub fn new(transport: Transport) -> Machines {
		Machines { transport, state: Mutex::new(State::default()), done: Condvar::new(), asked: Mutex::new(0) }
	}

	pub fn asked(&self) -> u64 {
		*self.asked.lock().unwrap()
	}

	/// The running machine with this CID, if any. Anything unexpected from LXD is `Unavailable`, never `None`:
	/// the service then answers "try again" instead of refusing the machine.
	pub fn lookup(&self, cid: u32) -> (Lookup, Option<Machine>) {
		let mut state = self.state.lock().unwrap();
		let hint = loop {
			match state.known.get(&cid) {
				Some(k) if k.confirmed.elapsed() < CONFIRMED_FOR => return (Lookup::Found, Some(k.machine.clone())),
				Some(_) if state.confirming.contains(&cid) => state = self.done.wait(state).unwrap(),
				Some(k) => {
					let hint = (k.machine.clone(), k.confirmed);
					state.confirming.insert(cid);
					break Some(hint);
				}
				None => break None,
			}
		};
		drop(state);
		if let Some((machine, seen)) = hint {
			let confirmed = self.confirm(cid, &machine);
			let mut state = self.state.lock().unwrap();
			state.confirming.remove(&cid);
			self.done.notify_all();
			match confirmed {
				Ok(true) => {
					state.known.insert(cid, Known { machine: machine.clone(), confirmed: Instant::now() });
					return (Lookup::Found, Some(machine));
				}
				Ok(false) => {
					// Only the entry that was checked: a listing meanwhile may have put a fresh one there.
					if state.known.get(&cid).is_some_and(|k| k.confirmed == seen) {
						state.known.remove(&cid);
					}
				}
				Err(_) => return (Lookup::Unavailable, None),
			}
		}
		self.from_listing(cid)
	}

	/// One single-instance request: is the machine still running with this CID and physical id? An instance that
	/// is gone (404) is not.
	fn confirm(&self, cid: u32, machine: &Machine) -> std::io::Result<bool> {
		let path = format!("/1.0/instances/{}?project={}", machine.name, machine.project);
		let (status, body) = self.get(&path)?;
		if status == 404 {
			return Ok(false);
		}
		if status != 200 {
			return Err(std::io::Error::other("LXD did not answer 200"));
		}
		let answer: serde_json::Value = serde_json::from_slice(&body).map_err(std::io::Error::other)?;
		let meta = answer.get("metadata").ok_or_else(|| std::io::Error::other("no metadata"))?;
		Ok(matches(meta, cid).as_ref() == Some(machine))
	}

	fn from_listing(&self, cid: u32) -> (Lookup, Option<Machine>) {
		let mut state = self.state.lock().unwrap();
		loop {
			if let Some(k) = state.known.get(&cid) {
				return (Lookup::Found, Some(k.machine.clone()));
			}
			if state.listed.is_some_and(|at| at.elapsed() < LIST_AT_MOST_EVERY) {
				return (Lookup::None, None);
			}
			if !state.listing {
				break;
			}
			state = self.done.wait(state).unwrap();
		}
		state.listing = true;
		drop(state);
		let listed = self.get("/1.0/instances?all-projects=true&recursion=1").and_then(|(status, body)| {
			if status != 200 {
				return Err(std::io::Error::other("LXD did not answer 200"));
			}
			running(&body)
		});
		let mut state = self.state.lock().unwrap();
		state.listing = false;
		self.done.notify_all();
		match listed {
			Ok(found) => {
				let now = Instant::now();
				state.known = found.into_iter().map(|(c, machine)| (c, Known { machine, confirmed: now })).collect();
				state.listed = Some(now);
				match state.known.get(&cid) {
					Some(k) => (Lookup::Found, Some(k.machine.clone())),
					None => (Lookup::None, None),
				}
			}
			Err(_) => (Lookup::Unavailable, None),
		}
	}

	/// The status and body of one request.
	fn get(&self, path: &str) -> std::io::Result<(u16, Vec<u8>)> {
		*self.asked.lock().unwrap() += 1;
		match &self.transport {
			Transport::Https(https) => exchange(&mut https.connect()?, &https.host(), path),
			Transport::Socket(socket) => {
				let mut s = UnixStream::connect(socket)?;
				s.set_read_timeout(Some(TIMEOUT))?;
				s.set_write_timeout(Some(TIMEOUT))?;
				exchange(&mut s, "lxd", path)
			}
		}
	}
}

/// One HTTP/1.0 request and its answer's status and body. LXD then answers with the whole body, never chunked. With
/// a Content-Length the body ends there, even if the connection stays open; without one, at the close.
fn exchange(s: &mut (impl Read + Write), host: &str, path: &str) -> std::io::Result<(u16, Vec<u8>)> {
	s.write_all(format!("GET {path} HTTP/1.0\r\nHost: {host}\r\n\r\n").as_bytes())?;
	s.flush()?;
	let mut answer = Vec::new();
	let mut chunk = [0u8; 8192];
	let split = loop {
		if let Some(at) = answer.windows(4).position(|w| w == b"\r\n\r\n") {
			break at;
		}
		if answer.len() > MAX_HEAD {
			return Err(std::io::Error::other("LXD's HTTP head is too large"));
		}
		match s.read(&mut chunk) {
			Ok(0) => return Err(std::io::Error::other("no HTTP head")),
			Ok(n) => answer.extend_from_slice(&chunk[..n]),
			Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
			Err(e) => return Err(e),
		}
	};
	if split > MAX_HEAD {
		return Err(std::io::Error::other("LXD's HTTP head is too large"));
	}
	let head = std::str::from_utf8(&answer[..split]).map_err(|_| std::io::Error::other("LXD's HTTP head is not text"))?;
	let mut lines = head.split("\r\n");
	let status = lines
		.next()
		.and_then(|line| line.strip_prefix("HTTP/1."))
		.and_then(|rest| rest.get(2..5))
		.filter(|code| code.bytes().all(|b| b.is_ascii_digit()))
		.and_then(|code| code.parse::<u16>().ok())
		.ok_or_else(|| std::io::Error::other("no HTTP status"))?;
	let mut length: Option<u64> = None;
	for line in lines {
		let (name, value) = line.split_once(':').ok_or_else(|| std::io::Error::other("an HTTP header without a colon"))?;
		if name.eq_ignore_ascii_case("transfer-encoding") {
			return Err(std::io::Error::other("LXD's answer has a transfer encoding"));
		}
		if name.eq_ignore_ascii_case("content-length") {
			let value = value.trim_matches([' ', '\t']);
			let value = Some(value)
				.filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
				.and_then(|v| v.parse::<u64>().ok())
				.ok_or_else(|| std::io::Error::other("LXD's Content-Length is not a number"))?;
			if length.is_some_and(|l| l != value) {
				return Err(std::io::Error::other("LXD's answer has two different Content-Lengths"));
			}
			length = Some(value);
		}
	}
	let mut body = answer.split_off(split + 4);
	match length {
		Some(length) => {
			if length > MAX_ANSWER {
				return Err(std::io::Error::other("LXD answer is too large"));
			}
			if body.len() as u64 > length {
				return Err(std::io::Error::other("LXD's answer is longer than its Content-Length"));
			}
			Read::take(&mut *s, length - body.len() as u64).read_to_end(&mut body)?;
			if (body.len() as u64) < length {
				return Err(std::io::Error::other("LXD's answer ended early"));
			}
		}
		None => {
			Read::take(&mut *s, MAX_ANSWER + 1 - body.len() as u64).read_to_end(&mut body)?;
			if body.len() as u64 > MAX_ANSWER {
				return Err(std::io::Error::other("LXD answer is too large"));
			}
		}
	}
	Ok((status, body))
}

/// The instance as a machine if it is running with this CID and has every field.
fn matches(instance: &serde_json::Value, cid: u32) -> Option<Machine> {
	let config = instance.get("config")?;
	let field = |key: &str| config.get(key).and_then(|v| v.as_str());
	let text = |key: &str| instance.get(key).and_then(|v| v.as_str());
	if field("volatile.vsock_id")? != cid.to_string() || text("status")? != "Running" {
		return None;
	}
	// Names go into a request path later: LXD's own names only.
	let safe = |s: &str| !s.is_empty() && s.len() <= 63 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
	if !safe(text("name")?) || !safe(text("project")?) {
		return None;
	}
	Some(Machine {
		project: text("project")?.to_string(),
		name: text("name")?.to_string(),
		physical_id: field("volatile.uuid")?.to_string(),
	})
}

/// Every running machine with a CID. A stopped instance whose stale CID a running one now has is skipped.
fn running(body: &[u8]) -> std::io::Result<HashMap<u32, Machine>> {
	let answer: serde_json::Value = serde_json::from_slice(body).map_err(std::io::Error::other)?;
	let instances = answer.get("metadata").and_then(|m| m.as_array()).ok_or_else(|| std::io::Error::other("no list"))?;
	let mut out = HashMap::new();
	for instance in instances {
		let Some(cid) = instance
			.get("config")
			.and_then(|c| c.get("volatile.vsock_id"))
			.and_then(|v| v.as_str())
			.and_then(|v| v.parse::<u32>().ok())
		else {
			continue;
		};
		if let Some(machine) = matches(instance, cid) {
			out.insert(cid, machine);
		}
	}
	Ok(out)
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::os::unix::net::UnixListener;
	use std::sync::Arc;

	fn answer(instances: &str) -> String {
		format!(r#"{{"type":"sync","status":"Success","status_code":200,"metadata":[{instances}]}}"#)
	}

	const EXEC: &str = r#"{"name":"qorpera-exec-node02","project":"qn25b2","status":"Running","config":{"volatile.vsock_id":"42","volatile.uuid":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","image.os":"ubuntu"}}"#;
	const STOPPED: &str = r#"{"name":"old","project":"p","status":"Stopped","config":{"volatile.vsock_id":"42","volatile.uuid":"u"}}"#;
	const STOPPED_43: &str = r#"{"name":"gone","project":"p","status":"Stopped","config":{"volatile.vsock_id":"43","volatile.uuid":"u"}}"#;

	fn exec() -> Machine {
		Machine {
			project: "qn25b2".into(),
			name: "qorpera-exec-node02".into(),
			physical_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee".into(),
		}
	}

	#[test]
	fn the_running_machine_wins_over_a_stopped_one_with_the_same_stale_cid() {
		let found = running(answer(&format!("{STOPPED},{EXEC},{STOPPED_43}")).as_bytes()).unwrap();
		assert_eq!(found.get(&42), Some(&exec()));
		assert!(!found.contains_key(&43), "a stopped machine's CID matches nothing");
		assert!(running(b"not json").is_err());
		assert!(running(br#"{"metadata":{}}"#).is_err());
	}

	/// A stand-in LXD answering every request from `reply(path)`, counting them, each after `delay`.
	fn fake_lxd(reply: impl Fn(&str) -> (u16, String) + Send + Sync + 'static, delay: Duration) -> (String, Arc<Mutex<Vec<String>>>) {
		let dir = std::env::temp_dir().join(format!(
			"qorpera-folder-lxd-{}-{}",
			std::process::id(),
			std::time::UNIX_EPOCH.elapsed().unwrap().as_nanos()
		));
		std::fs::create_dir(&dir).unwrap();
		let path = dir.join("lxd.sock");
		let listener = UnixListener::bind(&path).unwrap();
		let seen = Arc::new(Mutex::new(Vec::new()));
		let log = seen.clone();
		let reply = Arc::new(reply);
		std::thread::spawn(move || {
			for conn in listener.incoming() {
				let Ok(mut s) = conn else { return };
				let reply = reply.clone();
				let log = log.clone();
				std::thread::spawn(move || {
					let mut request = vec![0u8; 4096];
					let n = s.read(&mut request).unwrap_or(0);
					let request = String::from_utf8_lossy(&request[..n]).to_string();
					let target = request.split(' ').nth(1).unwrap_or("").to_string();
					log.lock().unwrap().push(target.clone());
					std::thread::sleep(delay);
					let (status, body) = reply(&target);
					let _ = s.write_all(format!("HTTP/1.0 {status} X\r\nContent-Type: application/json\r\n\r\n{body}").as_bytes());
				});
			}
		});
		(path.to_string_lossy().into_owned(), seen)
	}

	#[test]
	fn many_connections_at_once_make_one_listing_and_cheap_confirmations() {
		let (socket, seen) = fake_lxd(
			|target| {
				if target.starts_with("/1.0/instances?") {
					(200, answer(EXEC))
				} else {
					(200, format!(r#"{{"type":"sync","metadata":{EXEC}}}"#))
				}
			},
			Duration::from_millis(50),
		);
		let machines = Arc::new(Machines::new(Transport::Socket(socket)));
		let threads: Vec<_> = (0..64)
			.map(|i| {
				let machines = machines.clone();
				// Half ask for the running machine, half for a CID nobody has.
				std::thread::spawn(move || machines.lookup(if i % 2 == 0 { 42 } else { 77 }))
			})
			.collect();
		for (i, t) in threads.into_iter().enumerate() {
			let (lookup, machine) = t.join().unwrap();
			if i % 2 == 0 {
				assert_eq!((lookup, machine), (Lookup::Found, Some(exec())));
			} else {
				assert_eq!((lookup, machine), (Lookup::None, None));
			}
		}
		assert_eq!(seen.lock().unwrap().len(), 1, "64 connections, one listing: {:?}", seen.lock().unwrap());
		// After the confirmation window, a known machine costs one single-instance request.
		std::thread::sleep(CONFIRMED_FOR + Duration::from_millis(50));
		assert_eq!(machines.lookup(42), (Lookup::Found, Some(exec())));
		let requests = seen.lock().unwrap().clone();
		assert_eq!(requests.len(), 2);
		assert_eq!(requests[1], "/1.0/instances/qorpera-exec-node02?project=qn25b2");
		assert!(requests[0].starts_with("/1.0/instances?all-projects=true&recursion=1"));
		assert_eq!(machines.asked(), 2);
	}

	#[test]
	fn lookups_after_the_window_share_one_confirmation_and_a_gone_instance_is_listed_again() {
		let (socket, seen) = fake_lxd(
			|target| {
				if target.starts_with("/1.0/instances?") {
					(200, answer(EXEC))
				} else {
					(200, format!(r#"{{"type":"sync","metadata":{EXEC}}}"#))
				}
			},
			Duration::from_millis(100),
		);
		let machines = Arc::new(Machines::new(Transport::Socket(socket)));
		assert_eq!(machines.lookup(42).0, Lookup::Found);
		std::thread::sleep(CONFIRMED_FOR + Duration::from_millis(50));
		let threads: Vec<_> = (0..32)
			.map(|_| {
				let machines = machines.clone();
				std::thread::spawn(move || machines.lookup(42))
			})
			.collect();
		for t in threads {
			assert_eq!(t.join().unwrap(), (Lookup::Found, Some(exec())));
		}
		assert_eq!(seen.lock().unwrap().len(), 2, "one listing, then one confirmation: {:?}", seen.lock().unwrap());

		// The instance is gone (404): not this machine, so the CID is listed again (it now has another one).
		let (socket, seen) = fake_lxd(
			|target| {
				if target.starts_with("/1.0/instances?") {
					(200, answer(r#"{"name":"next","project":"p","status":"Running","config":{"volatile.vsock_id":"42","volatile.uuid":"n"}}"#))
				} else {
					(404, r#"{"type":"error","error":"Instance not found","error_code":404}"#.into())
				}
			},
			Duration::ZERO,
		);
		let machines = Machines::new(Transport::Socket(socket));
		machines.state.lock().unwrap().known.insert(
			42,
			Known { machine: exec(), confirmed: Instant::now() - CONFIRMED_FOR - Duration::from_millis(1) },
		);
		let (lookup, machine) = machines.lookup(42);
		assert_eq!(lookup, Lookup::Found);
		assert_eq!(machine.unwrap().name, "next");
		assert_eq!(seen.lock().unwrap().len(), 2);
	}

	#[test]
	fn a_machine_that_stopped_is_listed_again_and_an_error_is_unavailable() {
		let calls = Arc::new(Mutex::new(0u32));
		let count = calls.clone();
		let (socket, _) = fake_lxd(
			move |target| {
				let mut n = count.lock().unwrap();
				*n += 1;
				match (*n, target.starts_with("/1.0/instances?")) {
					(1, _) => (200, answer(EXEC)),
					// The confirmation finds it stopped; the listing after it has nothing.
					(2, false) => (200, format!(r#"{{"type":"sync","metadata":{STOPPED}}}"#)),
					(3, true) => (200, answer("")),
					_ => (500, "{}".into()),
				}
			},
			Duration::ZERO,
		);
		let machines = Machines::new(Transport::Socket(socket));
		assert_eq!(machines.lookup(42).0, Lookup::Found);
		std::thread::sleep(CONFIRMED_FOR + Duration::from_millis(50));
		assert_eq!(machines.lookup(42), (Lookup::None, None));
		std::thread::sleep(LIST_AT_MOST_EVERY + Duration::from_millis(50));
		assert_eq!(machines.lookup(42), (Lookup::Unavailable, None));
		let nowhere = Machines::new(Transport::Socket("/nonexistent/lxd.sock".into()));
		assert_eq!(nowhere.lookup(42), (Lookup::Unavailable, None));
	}

	/// An answer that arrives `step` bytes at a time. Past its end the wire is closed, or stays open (a read then
	/// fails, as a read timeout would).
	struct Wire {
		answer: Vec<u8>,
		at: usize,
		step: usize,
		open: bool,
		sent: Vec<u8>,
	}

	impl Read for Wire {
		fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
			if self.at >= self.answer.len() {
				return if self.open { Err(std::io::ErrorKind::WouldBlock.into()) } else { Ok(0) };
			}
			let n = self.step.min(buf.len()).min(self.answer.len() - self.at);
			buf[..n].copy_from_slice(&self.answer[self.at..self.at + n]);
			self.at += n;
			Ok(n)
		}
	}

	impl Write for Wire {
		fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
			self.sent.extend_from_slice(buf);
			Ok(buf.len())
		}

		fn flush(&mut self) -> std::io::Result<()> {
			Ok(())
		}
	}

	fn wire(answer: &str, step: usize, open: bool) -> Wire {
		Wire { answer: answer.as_bytes().to_vec(), at: 0, step, open, sent: Vec::new() }
	}

	#[test]
	fn an_answer_ends_at_its_content_length_or_at_the_close_and_anything_else_is_refused() {
		// The listener may keep the connection open after the body: its Content-Length ends it.
		let mut open = wire("HTTP/1.0 200 OK\r\nContent-Type: application/json\r\nContent-Length: 5\r\n\r\nhello", 7, true);
		assert_eq!(exchange(&mut open, "127.0.0.1:8443", "/1.0/x").unwrap(), (200, b"hello".to_vec()));
		assert_eq!(open.sent, b"GET /1.0/x HTTP/1.0\r\nHost: 127.0.0.1:8443\r\n\r\n");
		let read = |answer: &str, step: usize, open: bool| {
			exchange(&mut wire(answer, step, open), "lxd", "/1.0").map_err(|e| e.to_string())
		};
		assert_eq!(read("HTTP/1.1 404 Not Found\r\ncontent-length: 2\r\n\r\n{}", 7, true), Ok((404, b"{}".to_vec())));
		assert_eq!(read("HTTP/1.0 200 OK\r\n\r\nto the end", 7, false), Ok((200, b"to the end".to_vec())));
		assert_eq!(read("HTTP/1.0 200 OK\r\nContent-Length: 2\r\nContent-Length:\t2 \r\n\r\nok", 7, true), Ok((200, b"ok".to_vec())));
		let long_head = format!("HTTP/1.0 200 OK\r\nX: {}\r\n\r\n", "a".repeat(MAX_HEAD));
		for (answer, step, refused) in [
			("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\n\r\n", 7, "transfer encoding"),
			("HTTP/1.0 200 OK\r\nContent-Length: 9\r\n\r\nshort", 7, "ended early"),
			("HTTP/1.0 200 OK\r\nContent-Length: 1\r\n\r\nlonger", 4096, "longer than its Content-Length"),
			("HTTP/1.0 200 OK\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\nok", 7, "two different"),
			("HTTP/1.0 200 OK\r\nContent-Length: +2\r\n\r\nok", 7, "not a number"),
			("HTTP/1.0 200 OK\r\nContent-Length: \r\n\r\nok", 7, "not a number"),
			("HTTP/1.0 200 OK\r\nContent-Length: 67108865\r\n\r\nok", 7, "too large"),
			("HTTP/1.0 200 OK\r\nno colon\r\n\r\nok", 7, "without a colon"),
			("HTTP/1.0 200 OK\r\n", 7, "no HTTP head"),
			("NOT-HTTP\r\n\r\n", 7, "no HTTP status"),
			("HTTP/1.0 +20 OK\r\n\r\n", 7, "no HTTP status"),
			(long_head.as_str(), 4096, "head is too large"),
		] {
			let got = read(answer, step, false);
			assert!(got.as_ref().is_err_and(|e| e.contains(refused)), "{answer:.60}: {got:?}");
		}
	}

	#[test]
	fn the_bridge_asks_over_the_pinned_listener_with_its_own_certificate() {
		use crate::lxd_https::tests::{stand_in, Scratch};
		let scratch = Scratch::new(&std::env::temp_dir());
		let (https, heard) = stand_in(
			&scratch.0,
			|_| format!("HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n{}", answer(EXEC)).into_bytes(),
			None,
		);
		let identity = https.identity();
		let machines = Machines::new(Transport::Https(https));
		assert_eq!(machines.lookup(42), (Lookup::Found, Some(exec())));
		let seen = heard.recv_timeout(Duration::from_secs(10)).unwrap();
		let request = String::from_utf8(seen.request).unwrap();
		let expected = "GET /1.0/instances?all-projects=true&recursion=1 HTTP/1.0\r\nHost: 127.0.0.1:";
		assert!(request.starts_with(expected), "{request}");
		assert_eq!(seen.client, Some(identity));
	}
}
