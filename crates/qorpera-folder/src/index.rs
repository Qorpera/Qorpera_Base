//! A reader of git's index file (git's documented format, `Documentation/gitformat-index.txt`, versions 2 to 4), for
//! the cache list (§6 "The per-session cache"): the paths a worktree's index lists, nothing else of it.
//!
//! The index does not say which hash the repository uses: an entry's name length (in its flags) must meet the name's
//! end, so the reader tries SHA-1's 20 bytes and then SHA-256's 32 and keeps the one every entry agrees with. Its
//! checksum is not checked (`index.skipHash` writes none). A split index (`core.splitIndex`, which the sessions run
//! without) lists only part of the paths, so it reads as unknown.

/// Why an index could not be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Unread {
	/// Not an index: no `DIRC` signature, an unknown version, or entries that run past the end.
	Malformed(&'static str),
	/// A split index: the paths it lists are not all of them.
	Split,
}

const FIXED: usize = 40;
const NAME_MASK: u16 = 0x0fff;
const EXTENDED: u16 = 0x4000;

/// Every path the index lists, in its order (a sparse index's folders end with `/`).
pub fn paths(data: &[u8]) -> Result<Vec<String>, Unread> {
	if data.len() < 12 || &data[..4] != b"DIRC" {
		return Err(Unread::Malformed("no index signature"));
	}
	let version = u32::from_be_bytes(data[4..8].try_into().unwrap());
	if !(2..=4).contains(&version) {
		return Err(Unread::Malformed("an index version this reader does not know"));
	}
	let count = u32::from_be_bytes(data[8..12].try_into().unwrap()) as usize;
	let (paths, end) = match entries(data, version, count, 20) {
		Ok(read) => read,
		Err(_) => entries(data, version, count, 32)?,
	};
	if extensions(&data[end..]).any(|signature| signature == *b"link") {
		return Err(Unread::Split);
	}
	Ok(paths)
}

/// The entries, with `hash` bytes per object name, and where they end.
fn entries(data: &[u8], version: u32, count: usize, hash: usize) -> Result<(Vec<String>, usize), Unread> {
	let bad = |why| Unread::Malformed(why);
	let mut at = 12;
	let mut out = Vec::with_capacity(count.min(1 << 20));
	let mut previous: Vec<u8> = Vec::new();
	for _ in 0..count {
		let start = at;
		let flags_at = start + FIXED + hash;
		let flags = data.get(flags_at..flags_at + 2).ok_or(bad("an entry past the end"))?;
		let flags = u16::from_be_bytes(flags.try_into().unwrap());
		at = flags_at + 2;
		if flags & EXTENDED != 0 {
			if version < 3 {
				return Err(bad("extended flags before version 3"));
			}
			at += 2;
		}
		let length = (flags & NAME_MASK) as usize;
		let name = if version == 4 {
			let tail = data.get(at..).ok_or(bad("an entry past the end"))?;
			let (strip, used) = varint(tail).ok_or(bad("a bad prefix length"))?;
			at += used;
			let tail = data.get(at..).ok_or(bad("an entry past the end"))?;
			let end = tail.iter().position(|b| *b == 0).ok_or(bad("a name past the end"))?;
			let keep = previous.len().checked_sub(strip).ok_or(bad("a prefix longer than the path before"))?;
			let mut name = previous[..keep].to_vec();
			name.extend_from_slice(&tail[..end]);
			at += end + 1;
			name
		} else {
			let tail = data.get(at..).ok_or(bad("an entry past the end"))?;
			let end = tail.iter().position(|b| *b == 0).ok_or(bad("a name past the end"))?;
			let name = tail[..end].to_vec();
			// One to eight NULs: the entry is padded to a multiple of 8 bytes.
			at = start + (at - start + end + 8) / 8 * 8;
			if at > data.len() {
				return Err(bad("an entry past the end"));
			}
			name
		};
		if length != NAME_MASK as usize && length != name.len() {
			return Err(bad("a name length that does not meet the name's end"));
		}
		out.push(String::from_utf8_lossy(&name).into_owned());
		previous = name;
	}
	Ok((out, at))
}

/// Git's offset varint (`varint.c`): each byte's top bit says another follows, and each step adds one.
fn varint(data: &[u8]) -> Option<(usize, usize)> {
	let mut used = 0;
	let mut byte = *data.get(used)?;
	used += 1;
	let mut value = (byte & 0x7f) as usize;
	while byte & 0x80 != 0 {
		byte = *data.get(used)?;
		used += 1;
		value = value.checked_add(1)?.checked_mul(128)?.checked_add((byte & 0x7f) as usize)?;
	}
	Some((value, used))
}

/// The signatures of the extensions after the entries (the checksum, of either hash's size, ends the file).
fn extensions(mut data: &[u8]) -> impl Iterator<Item = [u8; 4]> + '_ {
	std::iter::from_fn(move || {
		if data.len() < 8 + 20 {
			return None;
		}
		let signature: [u8; 4] = data[..4].try_into().unwrap();
		if !signature.iter().all(u8::is_ascii_alphabetic) {
			return None;
		}
		let size = u32::from_be_bytes(data[4..8].try_into().unwrap()) as usize;
		data = data.get(8 + size..)?;
		Some(signature)
	})
}

/// The folder names on a path (all its names but the last; every one for a sparse index's folder, which ends with `/`).
pub fn folders(path: &str) -> impl Iterator<Item = &str> {
	let folder = path.strip_suffix('/');
	let path = folder.unwrap_or(path);
	let mut names: Vec<&str> = path.split('/').collect();
	if folder.is_none() {
		names.pop();
	}
	names.into_iter()
}

#[cfg(test)]
pub(crate) mod tests {
	use super::*;

	type Extension<'a> = (&'a [u8; 4], &'a [u8]);

	/// An index as git writes it: `paths` in order, version 2 to 4, with `hash`-byte object names; `extended` sets the
	/// extended flag (version 3 on) on every entry.
	pub(crate) fn index(version: u32, hash: usize, paths: &[&str], extended: bool, extensions: &[Extension]) -> Vec<u8> {
		let mut out = b"DIRC".to_vec();
		out.extend_from_slice(&version.to_be_bytes());
		out.extend_from_slice(&(paths.len() as u32).to_be_bytes());
		let mut previous = "";
		for path in paths {
			let start = out.len();
			out.extend_from_slice(&[0u8; FIXED]);
			out.extend_from_slice(&vec![0xab; hash]);
			let mut flags = path.len().min(NAME_MASK as usize) as u16;
			if extended {
				flags |= EXTENDED;
			}
			out.extend_from_slice(&flags.to_be_bytes());
			if extended {
				out.extend_from_slice(&0u16.to_be_bytes());
			}
			if version == 4 {
				let common = previous.bytes().zip(path.bytes()).take_while(|(a, b)| a == b).count();
				out.extend_from_slice(&encode(previous.len() - common));
				out.extend_from_slice(&path.as_bytes()[common..]);
				out.push(0);
			} else {
				out.extend_from_slice(path.as_bytes());
				let len = out.len() - start;
				out.resize(start + (len + 8) / 8 * 8, 0);
			}
			previous = path;
		}
		for (signature, body) in extensions {
			out.extend_from_slice(*signature);
			out.extend_from_slice(&(body.len() as u32).to_be_bytes());
			out.extend_from_slice(body);
		}
		out.extend_from_slice(&vec![0; hash]);
		out
	}

	/// Git's `encode_varint`.
	fn encode(mut value: usize) -> Vec<u8> {
		let mut bytes = vec![(value & 0x7f) as u8];
		while value >> 7 != 0 {
			value = (value >> 7) - 1;
			bytes.push(0x80 | (value & 0x7f) as u8);
		}
		bytes.reverse();
		bytes
	}

	const PATHS: [&str; 5] = [".gitignore", "build/out.txt", "build/sub/x", "src/build.rs", "src/main.rs"];

	#[test]
	fn reads_each_version_and_hash() {
		for (version, extended) in [(2, false), (3, false), (3, true), (4, false), (4, true)] {
			for hash in [20, 32] {
				let data = index(version, hash, &PATHS, extended, &[(b"TREE", b"tree data")]);
				assert_eq!(paths(&data).unwrap(), PATHS, "version {version}, hash {hash}, extended {extended}");
			}
		}
	}

	#[test]
	fn varints_round_trip() {
		for value in [0, 1, 127, 128, 255, 16511, 16512, 1 << 20] {
			assert_eq!(varint(&encode(value)), Some((value, encode(value).len())), "{value}");
		}
	}

	#[test]
	fn refuses_what_it_cannot_read() {
		assert_eq!(paths(b"nope"), Err(Unread::Malformed("no index signature")));
		let mut data = index(2, 20, &PATHS, false, &[]);
		data[7] = 9;
		assert!(matches!(paths(&data), Err(Unread::Malformed(_))));
		let data = index(2, 20, &PATHS, false, &[]);
		assert!(matches!(paths(&data[..60]), Err(Unread::Malformed(_))));
		let data = index(4, 20, &PATHS, false, &[(b"link", &[0; 20])]);
		assert_eq!(paths(&data), Err(Unread::Split));
		assert!(matches!(paths(&index(2, 20, &PATHS, true, &[])), Err(Unread::Malformed(_))));
	}

	#[test]
	fn a_long_name_reads_to_its_end() {
		let long = format!("a/{}", "x".repeat(5000));
		let data = index(2, 20, &[long.as_str()], false, &[]);
		assert_eq!(paths(&data).unwrap(), [long]);
	}

	#[test]
	fn folder_names() {
		assert_eq!(folders("a/b/c").collect::<Vec<_>>(), ["a", "b"]);
		assert_eq!(folders("c").count(), 0);
		assert_eq!(folders("a/b/").collect::<Vec<_>>(), ["a", "b"]);
	}
}
