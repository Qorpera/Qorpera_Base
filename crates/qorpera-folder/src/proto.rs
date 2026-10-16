//! Folder protocol v4: what a machine's folder program and its node's folder service say to each other.
//! The node side is `packages/object-gateway/src/folder-service/protocol.ts`; keep the two in step.
//! Version 2 adds writes (deploy/first-node/RUNTIME-FOLDER-WRITES.md); a view the node does not let write answers
//! the hello with `readOnly`. Version 3 adds the read log, and version 4 links (deploy/first-node/RUNTIME-FOLDER-LINKS.md).

use serde::{Deserialize, Serialize};

pub const PROTOCOL: u32 = 4;
/// The folder service's vsock port on the node (the host is always CID 2 from inside a VM).
pub const VSOCK_PORT: u32 = 5250;
/// The largest read a machine asks for in one request.
pub const MAX_READ: u32 = 1024 * 1024;
/// A file's chunks: every one but the last exactly this long (the version-2 manifest's chunk size).
pub const CHUNK: u64 = 4 * 1024 * 1024;
/// A chunk goes to the node in parts of at most this many bytes, so a frame stays under 2 MiB.
pub const PART: usize = 1024 * 1024;
/// The most chunks a file has: 256 MiB, the version-2 manifest's limit.
pub const MAX_CHUNKS: u64 = 64;

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
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub previous: Option<Previous>,
	#[serde(default, skip_serializing_if = "std::ops::Not::not")]
	pub abandon: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Previous {
	pub view_id: String,
	pub pass: String,
}

impl std::fmt::Debug for Previous {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("Previous").field("view_id", &self.view_id).finish_non_exhaustive()
	}
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HelloOk {
	pub protocol: u32,
	pub view_id: String,
	/// The folder's change number when the view was checked.
	pub as_of_seq: u64,
	pub read_only: bool,
	#[serde(default, skip_serializing_if = "std::ops::Not::not")]
	pub switchable: bool,
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
	/// A symbolic link (protocol 4): its size is its target's length in bytes; `R` on its version reads the target.
	Symlink,
}

/// The authority under which the service listed a path. The core rechecks it when the read is released.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Authority {
	pub resource_id: String,
	pub resource_revision: u64,
	#[serde(deserialize_with = "required_nullable")]
	pub grant_id: Option<String>,
	#[serde(deserialize_with = "required_nullable")]
	pub grant_revision: Option<u64>,
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
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub authority: Option<Authority>,
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

/// One successful file open, link read, hard link's source or non-root folder listing in a mount's durable,
/// consecutive read log.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LoggedRead {
	pub seq: u64,
	pub path: String,
	#[serde(deserialize_with = "required_nullable")]
	pub version: Option<String>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub authority: Option<Authority>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ReadsRequest {
	pub log: String,
	pub reads: Vec<LoggedRead>,
	#[serde(default, skip_serializing_if = "std::ops::Not::not")]
	pub lost: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ReadsAnswer {
	pub log: String,
	pub taken: u64,
	pub released: u64,
}

#[derive(Serialize)]
pub struct PublishRequest {
	#[serde(rename = "final", skip_serializing_if = "std::ops::Not::not")]
	pub final_boundary: bool,
}

// ---- Writes (protocol 2) ----------------------------------------------------------------------------------------

/// `O`: a file opened for writing. `base` is the version the mount's version map holds for the path (left out for a
/// path it never read): the node bases the save on it.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
	pub path: String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub base: Option<String>,
	pub create: bool,
	pub exclusive: bool,
	pub truncate: bool,
}

/// `o`: the node's handle for the open file, its size and the version it shows now.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Opened {
	pub handle: u32,
	pub size: u64,
	pub version: String,
}

/// The header of a `K` part: the whole chunk's hash and length, and where this part starts in it.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ChunkHeader {
	pub handle: u32,
	pub index: u32,
	pub sha256: String,
	pub bytes: u64,
	pub offset: u64,
}

/// `G`: part of a chunk the open file has (sent before, or its version's own) back.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct GetChunk {
	pub handle: u32,
	pub index: u32,
	pub offset: u64,
	pub length: u32,
}

/// `C`: the file closed at `size`; its chunks must make up that size on the 4 MiB grid.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct CloseRequest {
	pub handle: u32,
	pub size: u64,
}

/// `k` to a close or the executable bit: the version the save made (the version map takes it).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct Saved {
	pub version: String,
}

/// `M`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct PathRequest {
	pub path: String,
}

/// `U` and `D`: `base` is the version the name showed.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct RemoveRequest {
	pub path: String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub base: Option<String>,
}

/// `N`: `fromBase` is the version the name showed; `toBase` the version map's for a file renamed over (a save).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RenameRequest {
	pub from: String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub from_base: Option<String>,
	pub to: String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub to_base: Option<String>,
	pub no_replace: bool,
}

/// `X`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ExecutableRequest {
	pub path: String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub base: Option<String>,
	pub executable: bool,
}

// ---- Links (protocol 4) -----------------------------------------------------------------------------------------

/// A link's target is 1 to 4,095 bytes (the kernel's bound, which it checks before the program sees one).
pub const MAX_TARGET: u32 = 4095;

/// `Y`: a symbolic link at a path nothing holds.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct SymlinkRequest {
	pub path: String,
	pub target: String,
}

/// `J`: `fromBase` is the version the source showed; the new name gets the bytes (or the target) of that version.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LinkRequest {
	pub from: String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub from_base: Option<String>,
	pub to: String,
}

/// `p`: what a boundary did with each changed path.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Report {
	#[serde(deserialize_with = "required_nullable")]
	pub commit_id: Option<String>,
	#[serde(deserialize_with = "required_nullable")]
	pub seq: Option<u64>,
	pub paths: Vec<ReportEntry>,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub refused: Option<String>,
	#[serde(default, skip_serializing_if = "std::ops::Not::not")]
	pub closed: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ReportEntry {
	pub path: String,
	/// saved, conflict, refused, denied, waiting_for_review, not_applied or waiting.
	pub outcome: String,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub reason: Option<String>,
	/// A conflict's receipt: the change set that keeps this mount's version.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub receipt: Option<String>,
	/// Still pending in this mount.
	#[serde(default, skip_serializing_if = "std::ops::Not::not")]
	pub kept: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ErrorReply {
	pub code: String,
	#[serde(default)]
	pub message: String,
}

/// `null` is a value in these exact wire/journal records; an absent field is a malformed record.
fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
	D: serde::Deserializer<'de>,
	T: Deserialize<'de>,
{
	Option::<T>::deserialize(deserializer)
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
	// Writes (protocol 2).
	pub const EXISTS: &str = "EXISTS";
	pub const NOT_EMPTY: &str = "NOT_EMPTY";
	pub const NOT_PERMITTED: &str = "NOT_PERMITTED";
	pub const TOO_LARGE: &str = "TOO_LARGE";
	pub const READ_ONLY: &str = "READ_ONLY";
	/// A published path cannot go where nothing is published (a trash folder); a file manager then deletes instead.
	pub const NOT_HERE: &str = "NOT_HERE";
	/// The change needed what was pending published first, and that could not be done now.
	pub const BUSY: &str = "BUSY";
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
			code::EXISTS => libc::EEXIST,
			code::NOT_EMPTY => libc::ENOTEMPTY,
			code::NOT_PERMITTED => libc::EPERM,
			code::TOO_LARGE => libc::EFBIG,
			code::READ_ONLY => libc::EROFS,
			code::NOT_HERE => libc::EXDEV,
			code::BUSY => libc::EBUSY,
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
	fn nullable_read_and_receipt_fields_cannot_be_silently_missing() {
		assert!(serde_json::from_str::<LoggedRead>(r#"{"seq":1,"path":"docs"}"#).is_err());
		let read: LoggedRead = serde_json::from_str(r#"{"seq":1,"path":"docs","version":null}"#).unwrap();
		assert_eq!(read.version, None);
		assert!(serde_json::from_str::<Authority>(r#"{"resourceId":"r","resourceRevision":1}"#).is_err());
		let receipt: Authority = serde_json::from_str(r#"{"resourceId":"r","resourceRevision":1,"grantId":null,"grantRevision":null}"#).unwrap();
		assert_eq!(receipt.grant_id, None);
	}

	#[test]
	fn a_report_must_have_paths_and_malformed_or_unknown_shapes_never_mean_empty_success() {
		for bad in [r#"{}"#, r#"{"paths":[]}"#, r#"{"paths":null}"#, r#"{"paths":[],"closed":"yes"}"#, r#"{"paths":[],"unanswered":true}"#] {
			assert!(serde_json::from_str::<Report>(bad).is_err(), "{bad}");
		}
		let report: Report = serde_json::from_str(r#"{"commitId":null,"seq":null,"paths":[],"refused":"unproven"}"#).unwrap();
		assert_eq!(report.refused.as_deref(), Some("unproven"));
	}

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
			previous: None,
			abandon: false,
		};
		assert_eq!(
			serde_json::to_string(&hello).unwrap(),
			r#"{"protocol":4,"environmentId":"e","viewId":"v","pass":"p","role":"feed"}"#
		);
		let list = ListRequest { path: "a".into(), after: None };
		assert_eq!(serde_json::to_string(&list).unwrap(), r#"{"path":"a"}"#);
		let listing: Listing = serde_json::from_str(
			r#"{"entries":[{"name":"x","kind":"file","size":3,"mtimeMs":5,"executable":true,"version":"0b6c7f2e-8d3a-4c1e-9f00-1a2b3c4d5e6f","extra":1},{"name":"d","kind":"folder"},{"name":"l","kind":"symlink","size":9,"mtimeMs":5,"executable":false,"version":"v"}],"next":"x"}"#,
		)
		.unwrap();
		assert_eq!(listing.entries[0].size, 3);
		assert_eq!(listing.entries[0].version, "0b6c7f2e-8d3a-4c1e-9f00-1a2b3c4d5e6f");
		assert!(listing.entries[0].executable);
		assert_eq!(listing.entries[1].kind, EntryKind::Folder);
		assert_eq!((listing.entries[2].kind, listing.entries[2].size), (EntryKind::Symlink, 9));
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
	fn write_shapes() {
		// As protocol.ts parses them: exact keys, a base only when there is one.
		let open = OpenRequest { path: "a".into(), base: None, create: true, exclusive: false, truncate: true };
		assert_eq!(serde_json::to_string(&open).unwrap(), r#"{"path":"a","create":true,"exclusive":false,"truncate":true}"#);
		let rename =
			RenameRequest { from: "a".into(), from_base: Some("v".into()), to: "b".into(), to_base: None, no_replace: true };
		assert_eq!(serde_json::to_string(&rename).unwrap(), r#"{"from":"a","fromBase":"v","to":"b","noReplace":true}"#);
		let header = ChunkHeader { handle: 1, index: 2, sha256: "s".into(), bytes: 3, offset: 0 };
		assert_eq!(serde_json::to_string(&header).unwrap(), r#"{"handle":1,"index":2,"sha256":"s","bytes":3,"offset":0}"#);
		let remove = RemoveRequest { path: "a".into(), base: Some("v".into()) };
		assert_eq!(serde_json::to_string(&remove).unwrap(), r#"{"path":"a","base":"v"}"#);
		let symlink = SymlinkRequest { path: "a".into(), target: "../b c".into() };
		assert_eq!(serde_json::to_string(&symlink).unwrap(), r#"{"path":"a","target":"../b c"}"#);
		let link = LinkRequest { from: "a".into(), from_base: Some("v".into()), to: "b".into() };
		assert_eq!(serde_json::to_string(&link).unwrap(), r#"{"from":"a","fromBase":"v","to":"b"}"#);
		let unbased = LinkRequest { from: "a".into(), from_base: None, to: "b".into() };
		assert_eq!(serde_json::to_string(&unbased).unwrap(), r#"{"from":"a","to":"b"}"#);
		let report: Report = serde_json::from_str(
			r#"{"commitId":null,"seq":null,"paths":[{"path":"a","outcome":"denied","reason":"denied","kept":true},{"path":"b","outcome":"conflict","receipt":"r"}]}"#,
		)
		.unwrap();
		assert_eq!(report.commit_id, None);
		assert!(report.paths[0].kept && !report.paths[1].kept);
		assert_eq!(report.paths[1].receipt.as_deref(), Some("r"));
	}

	#[test]
	fn errors_map_to_errno() {
		let e = |code: &str| ErrorReply { code: code.into(), message: String::new() }.errno();
		assert_eq!(e(code::NOT_FOUND), libc::ENOENT);
		assert_eq!(e(code::STALE), libc::ESTALE);
		assert_eq!(e(code::DENIED), libc::EACCES);
		assert_eq!(e(code::EXISTS), libc::EEXIST);
		assert_eq!(e(code::NOT_EMPTY), libc::ENOTEMPTY);
		assert_eq!(e(code::NOT_PERMITTED), libc::EPERM);
		assert_eq!(e(code::TOO_LARGE), libc::EFBIG);
		assert_eq!(e(code::READ_ONLY), libc::EROFS);
		assert_eq!(e(code::NOT_HERE), libc::EXDEV);
		assert_eq!(e(code::BUSY), libc::EBUSY);
		assert_eq!(e("SOMETHING_NEW"), libc::EIO);
	}
}
