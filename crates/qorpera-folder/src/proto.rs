//! Folder protocol v1: what a machine's folder program and its node's folder service say to each other.
//! The node side is `packages/object-gateway/src/folder-service/protocol.ts`; keep the two in step.

use serde::{Deserialize, Serialize};

pub const PROTOCOL: u32 = 1;
/// The folder service's vsock port on the node (the host is always CID 2 from inside a VM).
pub const VSOCK_PORT: u32 = 5250;
/// The largest read a machine asks for in one request.
pub const MAX_READ: u32 = 1024 * 1024;

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
	/// Lists and reads, one request at a time.
	Io,
	/// The node pushes changes; the machine acknowledges them.
	Feed,
}

/// The first frame on every connection from a machine.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
	pub protocol: u32,
	/// The company folder (its environment id).
	pub environment_id: String,
	pub view_id: String,
	pub pass: String,
	pub role: Role,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HelloOk {
	pub protocol: u32,
	pub view_id: String,
	/// The folder's change number when the view was checked.
	pub as_of_seq: u64,
	pub read_only: bool,
}

/// The first frame from the bridge on the node: the peer's CID as the node's kernel reported it, and the
/// machine LXD says has that CID now.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Bridge {
	pub cid: u32,
	pub lookup: Lookup,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub machine: Option<Machine>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Lookup {
	/// A running machine has this CID (`machine` names it).
	Found,
	/// No running machine has it.
	None,
	/// LXD could not be asked or answered badly; the service answers UNAVAILABLE, not a refusal.
	Unavailable,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Machine {
	pub project: String,
	pub name: String,
	/// The instance's `volatile.uuid`.
	pub physical_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ListRequest {
	/// A folder path relative to the view's root; "" is the root.
	pub path: String,
	/// Continue after this name (from the previous page's `next`).
	#[serde(skip_serializing_if = "Option::is_none")]
	pub after: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
	File,
	Folder,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
	pub name: String,
	pub kind: EntryKind,
	#[serde(default)]
	pub size: u64,
	/// Milliseconds since 1970 of the current version; 0 when unknown.
	#[serde(default)]
	pub mtime_ms: i64,
	#[serde(default)]
	pub executable: bool,
	/// The path's current version: the core's id for it, opaque here.
	#[serde(default)]
	pub version: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
	pub entries: Vec<Entry>,
	/// Set when more entries follow: pass it as `after` for the next page.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub next: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReadRequest {
	pub path: String,
	/// The version the machine was shown; the node serves exactly that version or refuses.
	pub version: String,
	pub offset: u64,
	pub length: u32,
}

/// Pushed on a feed connection. `paths` changed (added, changed, removed or moved away); `resync`
/// means drop everything (for example after an access change). An empty change is a heartbeat.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Change {
	pub seq: u64,
	#[serde(default)]
	pub resync: bool,
	#[serde(default)]
	pub paths: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Ack {
	pub seq: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ErrorReply {
	pub code: String,
	#[serde(default)]
	pub message: String,
}

/// Error codes the node sends.
pub mod code {
	pub const NOT_FOUND: &str = "NOT_FOUND";
	pub const NOT_A_FOLDER: &str = "NOT_A_FOLDER";
	pub const NOT_A_FILE: &str = "NOT_A_FILE";
	/// The version asked for is no longer the one this view may read.
	pub const STALE: &str = "STALE";
	pub const DENIED: &str = "DENIED";
	pub const BAD_REQUEST: &str = "BAD_REQUEST";
	/// The node cannot answer right now (database or storage server unreachable); try again.
	pub const UNAVAILABLE: &str = "UNAVAILABLE";
	/// The view was closed or its lease ran out: the folder program unmounts and exits.
	pub const VIEW_CLOSED: &str = "VIEW_CLOSED";
	/// The view, its pass or the calling machine did not match.
	pub const VIEW_REFUSED: &str = "VIEW_REFUSED";
}

impl ErrorReply {
	/// The errno a program on the machine sees for this error.
	pub fn errno(&self) -> i32 {
		match self.code.as_str() {
			code::NOT_FOUND => libc::ENOENT,
			code::NOT_A_FOLDER => libc::ENOTDIR,
			code::NOT_A_FILE => libc::EISDIR,
			code::STALE => libc::ESTALE,
			code::DENIED => libc::EACCES,
			code::BAD_REQUEST => libc::EINVAL,
			_ => libc::EIO,
		}
	}
}

/// A folder path: "" for the root, otherwise names joined by '/', none of them empty, "." or "..",
/// none longer than 255 bytes or holding a NUL. The whole path is at most 4096 bytes.
pub fn valid_path(path: &str) -> bool {
	if path.is_empty() {
		return true;
	}
	path.len() <= 4096 && path.split('/').all(valid_name)
}

pub fn valid_name(name: &str) -> bool {
	!name.is_empty() && name != "." && name != ".." && name.len() <= 255 && !name.contains(['/', '\0'])
}

pub fn join(parent: &str, name: &str) -> String {
	if parent.is_empty() {
		name.to_string()
	} else {
		format!("{parent}/{name}")
	}
}

/// The parent folder and the last name of a non-root path.
pub fn split(path: &str) -> (&str, &str) {
	match path.rsplit_once('/') {
		Some((parent, name)) => (parent, name),
		None => ("", path),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn paths() {
		for good in ["", "a", "a/b", "rules/agents.md", "æøå/ü"] {
			assert!(valid_path(good), "{good}");
		}
		for bad in ["/", "/a", "a/", "a//b", ".", "a/./b", "..", "a/..", "a\0b"] {
			assert!(!valid_path(bad), "{bad:?}");
		}
		assert!(!valid_path(&"x".repeat(256)));
		assert!(valid_path(&"x".repeat(255)));
		assert!(!valid_path(&["y"; 2049].join("/")));
		assert_eq!(join("", "a"), "a");
		assert_eq!(join("a/b", "c"), "a/b/c");
		assert_eq!(split("a/b/c"), ("a/b", "c"));
		assert_eq!(split("a"), ("", "a"));
	}

	#[test]
	fn wire_shapes() {
		let hello = Hello {
			protocol: PROTOCOL,
			environment_id: "e".into(),
			view_id: "v".into(),
			pass: "p".into(),
			role: Role::Feed,
		};
		assert_eq!(
			serde_json::to_string(&hello).unwrap(),
			r#"{"protocol":1,"environmentId":"e","viewId":"v","pass":"p","role":"feed"}"#
		);
		let list = ListRequest { path: "a".into(), after: None };
		assert_eq!(serde_json::to_string(&list).unwrap(), r#"{"path":"a"}"#);
		let listing: Listing = serde_json::from_str(
			r#"{"entries":[{"name":"x","kind":"file","size":3,"mtimeMs":5,"executable":true,"version":"0b6c7f2e-8d3a-4c1e-9f00-1a2b3c4d5e6f","extra":1},{"name":"d","kind":"folder"}],"next":"x"}"#,
		)
		.unwrap();
		assert_eq!(listing.entries[0].size, 3);
		assert_eq!(listing.entries[0].version, "0b6c7f2e-8d3a-4c1e-9f00-1a2b3c4d5e6f");
		assert!(listing.entries[0].executable);
		assert_eq!(listing.entries[1].kind, EntryKind::Folder);
		assert_eq!(listing.next.as_deref(), Some("x"));
		let bridge = Bridge {
			cid: 7,
			lookup: Lookup::Found,
			machine: Some(Machine { project: "p".into(), name: "n".into(), physical_id: "u".into() }),
		};
		assert_eq!(
			serde_json::to_string(&bridge).unwrap(),
			r#"{"cid":7,"lookup":"found","machine":{"project":"p","name":"n","physicalId":"u"}}"#
		);
		let none = Bridge { cid: 7, lookup: Lookup::Unavailable, machine: None };
		assert_eq!(serde_json::to_string(&none).unwrap(), r#"{"cid":7,"lookup":"unavailable"}"#);
		let change: Change = serde_json::from_str(r#"{"seq":9}"#).unwrap();
		assert_eq!((change.seq, change.resync, change.paths.len()), (9, false, 0));
	}

	#[test]
	fn errors_map_to_errno() {
		let e = |code: &str| ErrorReply { code: code.into(), message: String::new() }.errno();
		assert_eq!(e(code::NOT_FOUND), libc::ENOENT);
		assert_eq!(e(code::STALE), libc::ESTALE);
		assert_eq!(e(code::DENIED), libc::EACCES);
		assert_eq!(e("SOMETHING_NEW"), libc::EIO);
	}
}
