use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, BufReader, ErrorKind, Read, Write};
use std::os::fd::{FromRawFd, RawFd};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

pub const SECRET_MIN_BYTES: usize = 8;
pub const SECRET_MAX_BYTES: usize = 32 * 1024;
pub const SECRET_VALUES_MAX: usize = 4096;
pub const SECRET_TAG_BITS: u32 = 20;
const TAG_LIMIT: u32 = 1 << SECRET_TAG_BITS;
const TAG_SHIFT: u32 = 32 - SECRET_TAG_BITS;
const BITMAP_WORDS: usize = 1 << (SECRET_TAG_BITS - 5);
const WINDOW_LABEL: &[u8] = b"qorpera-secret-window/v1";
const VALUE_LABEL: &[u8] = b"qorpera-secret-value/v1";
pub const CONFIRM_FLOOR: u64 = 64 * 1024 * 1024;
pub const CONFIRM_FACTOR: u64 = 4;
const BATCH_LINE_MAX: usize = 256;
const MAX_SPEC_BYTES: usize = 512 * 1024;
const READ_BUF_BYTES: usize = 256 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScanSpec {
	pub key: String,
	pub values: Vec<SpecValue>,
	pub rebuilt_max: u64,
	#[serde(default = "default_confirm_floor")]
	pub confirm_floor: u64,
	#[serde(default = "default_confirm_factor")]
	pub confirm_factor: u64,
}

fn default_confirm_floor() -> u64 {
	CONFIRM_FLOOR
}

fn default_confirm_factor() -> u64 {
	CONFIRM_FACTOR
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpecValue {
	pub length: usize,
	pub start: u32,
	pub whole: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ScanOutcome {
	Clean { rebuilt: u64 },
	Secret,
	Unchecked { reason: &'static str },
}

#[derive(Clone)]
struct HmacSha256 {
	inner: Sha256,
	outer: Sha256,
}

impl HmacSha256 {
	fn new(key: &[u8]) -> Self {
		let mut block = [0u8; 64];
		if key.len() > 64 {
			let digest = Sha256::digest(key);
			block[..32].copy_from_slice(&digest);
		} else {
			block[..key.len()].copy_from_slice(key);
		}
		let mut ipad = [0x36u8; 64];
		let mut opad = [0x5cu8; 64];
		for i in 0..64 {
			ipad[i] ^= block[i];
			opad[i] ^= block[i];
		}
		let mut inner = Sha256::new();
		inner.update(ipad);
		let mut outer = Sha256::new();
		outer.update(opad);
		Self { inner, outer }
	}

	fn mac(&self, data: &[u8]) -> [u8; 32] {
		let mut inner = self.inner.clone();
		inner.update(data);
		let first = inner.finalize();
		let mut outer = self.outer.clone();
		outer.update(first);
		outer.finalize().into()
	}

	fn mac16(&self, data: &[u8]) -> [u8; 16] {
		let full = self.mac(data);
		let mut out = [0u8; 16];
		out.copy_from_slice(&full[..16]);
		out
	}
}

fn decode_b64url_char(b: u8) -> Option<u8> {
	match b {
		b'A'..=b'Z' => Some(b - b'A'),
		b'a'..=b'z' => Some(b - b'a' + 26),
		b'0'..=b'9' => Some(b - b'0' + 52),
		b'-' => Some(62),
		b'_' => Some(63),
		_ => None,
	}
}

fn decode_b64url_exact<const N: usize>(text: &str) -> Option<[u8; N]> {
	let expected_chars = (N * 8).div_ceil(6);
	let bytes = text.as_bytes();
	if bytes.len() != expected_chars {
		return None;
	}
	let mut out = [0u8; N];
	let mut out_i = 0;
	let mut i = 0;
	while i + 4 <= bytes.len() {
		let a = decode_b64url_char(bytes[i])?;
		let b = decode_b64url_char(bytes[i + 1])?;
		let c = decode_b64url_char(bytes[i + 2])?;
		let d = decode_b64url_char(bytes[i + 3])?;
		out[out_i] = (a << 2) | (b >> 4);
		out[out_i + 1] = (b << 4) | (c >> 2);
		out[out_i + 2] = (c << 6) | d;
		out_i += 3;
		i += 4;
	}
	match bytes.len() - i {
		0 => {}
		2 => {
			let a = decode_b64url_char(bytes[i])?;
			let b = decode_b64url_char(bytes[i + 1])?;
			if (b & 0x0f) != 0 {
				return None;
			}
			out[out_i] = (a << 2) | (b >> 4);
			out_i += 1;
		}
		3 => {
			let a = decode_b64url_char(bytes[i])?;
			let b = decode_b64url_char(bytes[i + 1])?;
			let c = decode_b64url_char(bytes[i + 2])?;
			if (c & 0x03) != 0 {
				return None;
			}
			out[out_i] = (a << 2) | (b >> 4);
			out[out_i + 1] = (b << 4) | (c >> 2);
			out_i += 2;
		}
		_ => return None,
	}
	(out_i == N).then_some(out)
}

struct LengthGroup {
	length: usize,
	wholes: Vec<[u8; 16]>,
}

pub struct Matcher {
	c0: u32,
	c1: u32,
	c2: u32,
	c3: u32,
	c4: u32,
	c5: u32,
	c6: u32,
	c7: u32,
	kv_hmac: HmacSha256,
	bitmap: Box<[u32; BITMAP_WORDS]>,
	tags: HashMap<u32, Vec<LengthGroup>>,
	longest: usize,
}

pub struct CompiledSpec {
	pub matcher: Option<Matcher>,
	pub rebuilt_max: u64,
	pub budget: u64,
}

impl CompiledSpec {
	pub fn from_spec(spec: ScanSpec) -> Result<Self, String> {
		let mut key = decode_b64url_exact::<32>(&spec.key).ok_or_else(|| "invalid key".to_string())?;
		if spec.values.len() > SECRET_VALUES_MAX {
			key.fill(0);
			return Err("too many secret values".to_string());
		}
		let budget = spec.confirm_floor.max(spec.confirm_factor.saturating_mul(spec.rebuilt_max));
		if spec.values.is_empty() {
			key.fill(0);
			return Ok(Self { matcher: None, rebuilt_max: spec.rebuilt_max, budget });
		}
		let key_hmac = HmacSha256::new(&key);
		key.fill(0);
		let kw = key_hmac.mac(WINDOW_LABEL);
		let mut kv = key_hmac.mac(VALUE_LABEL);
		let kv_hmac = HmacSha256::new(&kv);
		kv.fill(0);
		let mut bitmap = Box::new([0u32; BITMAP_WORDS]);
		let mut tags: HashMap<u32, Vec<LengthGroup>> = HashMap::new();
		let mut longest = 0usize;
		for value in &spec.values {
			if !(SECRET_MIN_BYTES..=SECRET_MAX_BYTES).contains(&value.length) {
				return Err("invalid secret value length".to_string());
			}
			if value.start >= TAG_LIMIT {
				return Err("invalid secret value start tag".to_string());
			}
			let whole = decode_b64url_exact::<16>(&value.whole).ok_or_else(|| "invalid secret value whole".to_string())?;
			bitmap[(value.start >> 5) as usize] |= 1u32 << (value.start & 31);
			let groups = tags.entry(value.start).or_default();
			if let Some(group) = groups.iter_mut().find(|g| g.length == value.length) {
				if !group.wholes.contains(&whole) {
					group.wholes.push(whole);
				}
			} else {
				groups.push(LengthGroup { length: value.length, wholes: vec![whole] });
			}
			longest = longest.max(value.length);
		}
		let matcher = Matcher {
			c0: u32::from_be_bytes(kw[0..4].try_into().unwrap()),
			c1: u32::from_be_bytes(kw[4..8].try_into().unwrap()) | 1,
			c2: u32::from_be_bytes(kw[8..12].try_into().unwrap()),
			c3: u32::from_be_bytes(kw[12..16].try_into().unwrap()) | 1,
			c4: u32::from_be_bytes(kw[16..20].try_into().unwrap()),
			c5: u32::from_be_bytes(kw[20..24].try_into().unwrap()) | 1,
			c6: u32::from_be_bytes(kw[24..28].try_into().unwrap()),
			c7: u32::from_be_bytes(kw[28..32].try_into().unwrap()) | 1,
			kv_hmac,
			bitmap,
			tags,
			longest,
		};
		Ok(Self { matcher: Some(matcher), rebuilt_max: spec.rebuilt_max, budget })
	}
}

#[cold]
#[inline(never)]
fn confirm(matcher: &Matcher, budget_left: &mut u64, tag: u32, bytes: &[u8], start: usize) -> Result<bool, ()> {
	let Some(groups) = matcher.tags.get(&tag) else {
		return Ok(false);
	};
	let remaining = bytes.len() - start;
	for group in groups {
		if group.length > remaining {
			continue;
		}
		let cost = group.length as u64;
		if cost > *budget_left {
			return Err(());
		}
		*budget_left -= cost;
		let whole = matcher.kv_hmac.mac16(&bytes[start..start + group.length]);
		if group.wholes.contains(&whole) {
			return Ok(true);
		}
	}
	Ok(false)
}

fn scan_range(matcher: &Matcher, budget_left: &mut u64, bytes: &[u8], last_start: usize) -> Result<bool, ()> {
	if bytes.len() < SECRET_MIN_BYTES {
		return Ok(false);
	}
	let end = (last_start + SECRET_MIN_BYTES).min(bytes.len());
	if end < SECRET_MIN_BYTES {
		return Ok(false);
	}
	let mut win = ((bytes[0] as u64) << 48)
		| ((bytes[1] as u64) << 40)
		| ((bytes[2] as u64) << 32)
		| ((bytes[3] as u64) << 24)
		| ((bytes[4] as u64) << 16)
		| ((bytes[5] as u64) << 8)
		| (bytes[6] as u64);
	let c0 = matcher.c0;
	let c1 = matcher.c1;
	let c2 = matcher.c2;
	let c3 = matcher.c3;
	let c4 = matcher.c4;
	let c5 = matcher.c5;
	let c6 = matcher.c6;
	let c7 = matcher.c7;
	let bitmap = &matcher.bitmap;
	for (start, &b) in bytes[7..end].iter().enumerate() {
		win = (win << 8) | (b as u64);
		let hi = (win >> 32) as u32;
		let lo = win as u32;
		let mut h = (hi ^ c0).wrapping_mul(c1);
		h ^= h >> 15;
		h = (h ^ lo ^ c2).wrapping_mul(c3);
		h ^= h >> 13;
		h = (h ^ c4).wrapping_mul(c5);
		h ^= h >> 16;
		h = (h ^ c6).wrapping_mul(c7);
		let tag = h >> TAG_SHIFT;
		if (bitmap[(tag >> 5) as usize] & (1u32 << (tag & 31))) == 0 {
			continue;
		}
		if confirm(matcher, budget_left, tag, bytes, start)? {
			return Ok(true);
		}
	}
	Ok(false)
}

pub struct ObjectScanner<'a> {
	matcher: &'a Matcher,
	budget_left: u64,
	tail: Vec<u8>,
}

impl<'a> ObjectScanner<'a> {
	pub fn new(matcher: &'a Matcher, budget: u64) -> Self {
		Self { matcher, budget_left: budget, tail: Vec::with_capacity(matcher.longest.saturating_mul(2)) }
	}

	pub fn push(&mut self, chunk: &[u8]) -> Result<bool, ()> {
		if chunk.is_empty() {
			return Ok(false);
		}
		let longest = self.matcher.longest;
		let need = longest - 1;
		if self.tail.is_empty() {
			if chunk.len() >= longest {
				let last = chunk.len() - longest;
				if scan_range(self.matcher, &mut self.budget_left, chunk, last)? {
					return Ok(true);
				}
				self.tail.extend_from_slice(&chunk[last + 1..]);
			} else {
				self.tail.extend_from_slice(chunk);
			}
			return Ok(false);
		}
		if chunk.len() >= need {
			let old_len = self.tail.len();
			self.tail.extend_from_slice(&chunk[..need]);
			if scan_range(self.matcher, &mut self.budget_left, &self.tail, old_len - 1)? {
				return Ok(true);
			}
			self.tail.clear();
			if chunk.len() >= longest {
				let last = chunk.len() - longest;
				if scan_range(self.matcher, &mut self.budget_left, chunk, last)? {
					return Ok(true);
				}
				self.tail.extend_from_slice(&chunk[last + 1..]);
			} else {
				self.tail.extend_from_slice(chunk);
			}
			return Ok(false);
		}
		self.tail.extend_from_slice(chunk);
		if self.tail.len() >= longest {
			let last = self.tail.len() - longest;
			if scan_range(self.matcher, &mut self.budget_left, &self.tail, last)? {
				return Ok(true);
			}
			let keep = self.tail.len() - (last + 1);
			self.tail.copy_within(last + 1.., 0);
			self.tail.truncate(keep);
		}
		Ok(false)
	}

	pub fn end(&mut self) -> Result<bool, ()> {
		let found = if self.tail.len() >= SECRET_MIN_BYTES {
			let last = self.tail.len() - SECRET_MIN_BYTES;
			scan_range(self.matcher, &mut self.budget_left, &self.tail, last)?
		} else {
			false
		};
		self.tail.clear();
		Ok(found)
	}
}

const IDX_V2_MAGIC: [u8; 4] = [0xff, 0x74, 0x4f, 0x63];
const IDX_V2_HEADER_LEN: usize = 8 + 256 * 4;
const IDX_V2_TRAILER_LEN: usize = 40;
const MAX_IDX_OBJECTS: usize = 20_000_000;
const MAX_EXCLUDE_OIDS_BYTES: usize = 64 * 1024 * 1024;
const HEX_DIGITS: &[u8; 16] = b"0123456789abcdef";

#[inline]
fn hex_nibble(b: u8) -> Option<u8> {
	match b {
		b'0'..=b'9' => Some(b - b'0'),
		b'a'..=b'f' => Some(b - b'a' + 10),
		_ => None,
	}
}

fn parse_hex_oid<const N: usize>(hex: &[u8]) -> Option<[u8; N]> {
	if hex.len() != N * 2 {
		return None;
	}
	let mut out = [0u8; N];
	for i in 0..N {
		let hi = hex_nibble(hex[i * 2])?;
		let lo = hex_nibble(hex[i * 2 + 1])?;
		out[i] = (hi << 4) | lo;
	}
	Some(out)
}

fn encode_hex_20(oid: &[u8; 20], out: &mut [u8; 40]) {
	for i in 0..20 {
		out[i * 2] = HEX_DIGITS[(oid[i] >> 4) as usize];
		out[i * 2 + 1] = HEX_DIGITS[(oid[i] & 0x0f) as usize];
	}
}

pub struct IdxV2 {
	fanout: [u32; 256],
	oids: Vec<u8>,
}

impl IdxV2 {
	pub fn from_path(path: &Path) -> Result<Self, String> {
		let mut file = OpenOptions::new()
			.read(true)
			.custom_flags(libc::O_NOFOLLOW)
			.open(path)
			.map_err(|e| format!("idx {} could not be opened: {e}", path.display()))?;
		let meta = file.metadata().map_err(|e| format!("idx {} could not be stated: {e}", path.display()))?;
		if !meta.file_type().is_file() {
			return Err(format!("idx {} is not a regular file", path.display()));
		}
		Self::from_reader(&mut file, Some(meta.len()))
	}

	pub fn from_reader<R: Read>(reader: &mut R, known_len: Option<u64>) -> Result<Self, String> {
		let mut header = [0u8; IDX_V2_HEADER_LEN];
		reader.read_exact(&mut header).map_err(|_| "idx header is truncated".to_string())?;
		if header[0..4] != IDX_V2_MAGIC {
			return Err("idx magic is not git pack idx v2".to_string());
		}
		let version = u32::from_be_bytes(header[4..8].try_into().unwrap());
		if version != 2 {
			return Err(format!("unsupported idx version {version}"));
		}
		let mut fanout = [0u32; 256];
		let mut prev = 0u32;
		for i in 0..256 {
			let off = 8 + i * 4;
			let count = u32::from_be_bytes(header[off..off + 4].try_into().unwrap());
			if count < prev {
				return Err("idx fanout table is not monotonic".to_string());
			}
			fanout[i] = count;
			prev = count;
		}
		let total = fanout[255] as usize;
		if total > MAX_IDX_OBJECTS {
			return Err("idx object count exceeds limit".to_string());
		}
		let min_size = (IDX_V2_HEADER_LEN as u64)
			.checked_add((total as u64).checked_mul(28).ok_or_else(|| "idx size overflow".to_string())?)
			.and_then(|v| v.checked_add(IDX_V2_TRAILER_LEN as u64))
			.ok_or_else(|| "idx size overflow".to_string())?;
		if let Some(len) = known_len {
			if len < min_size || (len - min_size) % 8 != 0 {
				return Err("idx file length does not match fanout count".to_string());
			}
		}
		let mut oids = vec![0u8; total * 20];
		reader.read_exact(&mut oids).map_err(|_| "idx oid table is truncated".to_string())?;
		for bucket in 0..256usize {
			let lo = if bucket == 0 { 0 } else { fanout[bucket - 1] as usize };
			let hi = fanout[bucket] as usize;
			for idx in lo..hi {
				let cur = &oids[idx * 20..(idx + 1) * 20];
				if cur[0] != bucket as u8 {
					return Err("idx oid table does not match fanout bucket".to_string());
				}
				if idx > lo && &oids[(idx - 1) * 20..idx * 20] >= cur {
					return Err("idx oid table is not strictly sorted".to_string());
				}
			}
		}
		Ok(Self { fanout, oids })
	}

	pub fn len(&self) -> usize {
		self.fanout[255] as usize
	}

	pub fn is_empty(&self) -> bool {
		self.len() == 0
	}

	pub fn contains_sha1(&self, oid: &[u8; 20]) -> bool {
		let bucket = oid[0] as usize;
		let mut lo = if bucket == 0 { 0 } else { self.fanout[bucket - 1] as usize };
		let mut hi = self.fanout[bucket] as usize;
		while lo < hi {
			let mid = lo + (hi - lo) / 2;
			let slot = &self.oids[mid * 20..(mid + 1) * 20];
			match slot.cmp(oid.as_slice()) {
				std::cmp::Ordering::Less => lo = mid + 1,
				std::cmp::Ordering::Greater => hi = mid,
				std::cmp::Ordering::Equal => return true,
			}
		}
		false
	}

	pub fn iter_sha1(&self) -> impl Iterator<Item = &[u8; 20]> {
		self.oids.chunks_exact(20).map(|c| c.try_into().unwrap())
	}
}

#[derive(Default)]
pub struct OidExcludeSet {
	idx_tables: Vec<IdxV2>,
	sha1: Vec<[u8; 20]>,
	sha256: Vec<[u8; 32]>,
}

impl OidExcludeSet {
	pub fn is_empty(&self) -> bool {
		self.idx_tables.is_empty() && self.sha1.is_empty() && self.sha256.is_empty()
	}

	pub fn add_idx(&mut self, idx: IdxV2) {
		if !idx.is_empty() {
			self.idx_tables.push(idx);
		}
	}

	pub fn add_oids_reader<R: Read>(&mut self, reader: R) -> Result<(), String> {
		let mut limited = BufReader::new(reader.take((MAX_EXCLUDE_OIDS_BYTES + 1) as u64));
		let mut total_bytes = 0usize;
		let mut line = String::new();
		loop {
			line.clear();
			let n = limited.read_line(&mut line).map_err(|_| "exclude oids could not be read".to_string())?;
			if n == 0 {
				break;
			}
			total_bytes += n;
			if total_bytes > MAX_EXCLUDE_OIDS_BYTES {
				return Err("exclude oids exceed maximum size".to_string());
			}
			let trimmed = line.trim();
			if trimmed.is_empty() {
				continue;
			}
			let raw = trimmed.as_bytes();
			if raw.len() == 40 {
				let oid = parse_hex_oid::<20>(raw).ok_or_else(|| "invalid sha1 oid in exclude list".to_string())?;
				self.sha1.push(oid);
			} else if raw.len() == 64 {
				let oid = parse_hex_oid::<32>(raw).ok_or_else(|| "invalid sha256 oid in exclude list".to_string())?;
				self.sha256.push(oid);
			} else {
				return Err("invalid oid length in exclude list".to_string());
			}
		}
		self.sha1.sort_unstable();
		self.sha1.dedup();
		self.sha256.sort_unstable();
		self.sha256.dedup();
		Ok(())
	}

	pub fn contains_sha1(&self, oid: &[u8; 20]) -> bool {
		if self.idx_tables.iter().any(|idx| idx.contains_sha1(oid)) {
			return true;
		}
		self.sha1.binary_search(oid).is_ok()
	}

	pub fn contains_sha256(&self, oid: &[u8; 32]) -> bool {
		self.sha256.binary_search(oid).is_ok()
	}

	pub fn contains_hex(&self, oid_hex: &[u8]) -> bool {
		if self.is_empty() {
			return false;
		}
		if oid_hex.len() == 40 {
			parse_hex_oid::<20>(oid_hex).is_some_and(|oid| self.contains_sha1(&oid))
		} else if oid_hex.len() == 64 {
			parse_hex_oid::<32>(oid_hex).is_some_and(|oid| self.contains_sha256(&oid))
		} else {
			false
		}
	}

	pub fn load(idx_paths: &[PathBuf], exclude_oids_fd: Option<RawFd>) -> Result<Self, String> {
		let mut set = Self::default();
		for path in idx_paths {
			set.add_idx(IdxV2::from_path(path)?);
		}
		if let Some(fd) = exclude_oids_fd {
			if fd < 3 {
				return Err("--exclude-oids-fd must be 3 or higher".to_string());
			}
			// SAFETY: fcntl F_GETFD checks whether exclude_oids_fd is open before taking ownership.
			if unsafe { libc::fcntl(fd, libc::F_GETFD) } < 0 {
				return Err("exclude oids fd is not open".to_string());
			}
			clear_nonblock(fd).map_err(|_| "exclude oids fd flags could not be updated".to_string())?;
			// SAFETY: fd is verified open, >= 3, and dedicated to this command.
			let file = unsafe { File::from_raw_fd(fd) };
			set.add_oids_reader(file)?;
		}
		Ok(set)
	}
}

pub fn write_delta_oids<W: Write>(target: &IdxV2, excludes: &OidExcludeSet, writer: &mut W) -> io::Result<usize> {
	let mut hex = [0u8; 41];
	hex[40] = b'\n';
	let mut count = 0usize;
	for oid in target.iter_sha1() {
		if !excludes.contains_sha1(oid) {
			let hex_slice: &mut [u8; 40] = (&mut hex[..40]).try_into().unwrap();
			encode_hex_20(oid, hex_slice);
			writer.write_all(&hex)?;
			count += 1;
		}
	}
	Ok(count)
}

pub fn run_diff_idx(
	target_idx: &Path,
	exclude_idx_paths: &[PathBuf],
	exclude_oids_fd: Option<RawFd>,
) -> Result<usize, String> {
	let target = IdxV2::from_path(target_idx)?;
	let excludes = OidExcludeSet::load(exclude_idx_paths, exclude_oids_fd)?;
	let stdout = io::stdout();
	let mut out = io::BufWriter::with_capacity(64 * 1024, stdout.lock());
	let count = write_delta_oids(&target, &excludes, &mut out).map_err(|e| format!("stdout write failed: {e}"))?;
	out.flush().map_err(|e| format!("stdout flush failed: {e}"))?;
	Ok(count)
}

fn parse_batch_header(line: &[u8]) -> Option<(&[u8], u64)> {
	let sp1 = line.iter().position(|&b| b == b' ')?;
	if sp1 != 40 && sp1 != 64 {
		return None;
	}
	let oid = &line[..sp1];
	if !oid.iter().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
		return None;
	}
	let rest = &line[sp1 + 1..];
	let sp2 = rest.iter().position(|&b| b == b' ')?;
	match &rest[..sp2] {
		b"blob" | b"tree" | b"commit" | b"tag" => {}
		_ => return None,
	}
	let size_bytes = &rest[sp2 + 1..];
	if size_bytes.is_empty() || size_bytes.len() > 13 {
		return None;
	}
	if size_bytes == b"0" {
		return Some((oid, 0));
	}
	if !matches!(size_bytes[0], b'1'..=b'9') {
		return None;
	}
	let mut size: u64 = 0;
	for &b in size_bytes {
		if !b.is_ascii_digit() {
			return None;
		}
		size = size * 10 + (b - b'0') as u64;
	}
	Some((oid, size))
}

enum Phase {
	Header,
	Content { due: u64, skip: bool },
	TrailingNewline { skip: bool },
}

pub fn scan_pack_stream<R: Read>(reader: &mut R, spec: &CompiledSpec) -> ScanOutcome {
	scan_pack_stream_with_excludes(reader, spec, &OidExcludeSet::default())
}

pub fn scan_pack_stream_with_excludes<R: Read>(
	reader: &mut R,
	spec: &CompiledSpec,
	excludes: &OidExcludeSet,
) -> ScanOutcome {
	let mut buf = vec![0u8; READ_BUF_BYTES];
	let mut line = Vec::with_capacity(BATCH_LINE_MAX);
	let mut phase = Phase::Header;
	let mut rebuilt: u64 = 0;
	let mut scanner = spec.matcher.as_ref().map(|m| ObjectScanner::new(m, spec.budget));
	loop {
		let n = match reader.read(&mut buf) {
			Ok(0) => break,
			Ok(n) => n,
			Err(e) if e.kind() == ErrorKind::Interrupted => continue,
			Err(_) => return ScanOutcome::Unchecked { reason: "read_error" },
		};
		let chunk = &buf[..n];
		let mut at = 0;
		while at < chunk.len() {
			match phase {
				Phase::Header => {
					let max_scan = (BATCH_LINE_MAX - line.len() + 1).min(chunk.len() - at);
					let search = &chunk[at..at + max_scan];
					if let Some(rel) = search.iter().position(|&b| b == b'\n') {
						let parsed = if line.is_empty() {
							parse_batch_header(&chunk[at..at + rel]).map(|(oid, size)| (excludes.contains_hex(oid), size))
						} else {
							line.extend_from_slice(&chunk[at..at + rel]);
							let res = parse_batch_header(&line).map(|(oid, size)| (excludes.contains_hex(oid), size));
							line.clear();
							res
						};
						let Some((skip, size)) = parsed else {
							return ScanOutcome::Unchecked { reason: "header" };
						};
						if !skip {
							rebuilt = match rebuilt.checked_add(size) {
								Some(total) if total <= spec.rebuilt_max => total,
								_ => return ScanOutcome::Unchecked { reason: "rebuilt_limit" },
							};
						}
						phase = if size == 0 {
							Phase::TrailingNewline { skip }
						} else {
							Phase::Content { due: size, skip }
						};
						at += rel + 1;
					} else {
						if line.len() + max_scan > BATCH_LINE_MAX {
							return ScanOutcome::Unchecked { reason: "header" };
						}
						line.extend_from_slice(search);
						at += max_scan;
					}
				}
				Phase::Content { due, skip } => {
					let avail = (chunk.len() - at) as u64;
					let take = due.min(avail) as usize;
					if !skip {
						if let Some(scan) = scanner.as_mut() {
							match scan.push(&chunk[at..at + take]) {
								Ok(true) => return ScanOutcome::Secret,
								Ok(false) => {}
								Err(()) => return ScanOutcome::Unchecked { reason: "budget" },
							}
						}
					}
					at += take;
					let rem = due - take as u64;
					phase = if rem == 0 {
						Phase::TrailingNewline { skip }
					} else {
						Phase::Content { due: rem, skip }
					};
				}
				Phase::TrailingNewline { skip } => {
					if chunk[at] != b'\n' {
						return ScanOutcome::Unchecked { reason: "framing" };
					}
					if !skip {
						if let Some(scan) = scanner.as_mut() {
							match scan.end() {
								Ok(true) => return ScanOutcome::Secret,
								Ok(false) => {}
								Err(()) => return ScanOutcome::Unchecked { reason: "budget" },
							}
						}
					}
					phase = Phase::Header;
					at += 1;
				}
			}
		}
	}
	if matches!(phase, Phase::Header) && line.is_empty() {
		ScanOutcome::Clean { rebuilt }
	} else {
		ScanOutcome::Unchecked { reason: "truncated" }
	}
}

pub fn scan_raw_stream<R: Read>(reader: &mut R, spec: &CompiledSpec) -> ScanOutcome {
	let mut buf = vec![0u8; READ_BUF_BYTES];
	let mut rebuilt: u64 = 0;
	let mut scanner = spec.matcher.as_ref().map(|m| ObjectScanner::new(m, spec.budget));
	loop {
		let n = match reader.read(&mut buf) {
			Ok(0) => break,
			Ok(n) => n,
			Err(e) if e.kind() == ErrorKind::Interrupted => continue,
			Err(_) => return ScanOutcome::Unchecked { reason: "read_error" },
		};
		rebuilt = match rebuilt.checked_add(n as u64) {
			Some(total) if total <= spec.rebuilt_max => total,
			_ => return ScanOutcome::Unchecked { reason: "rebuilt_limit" },
		};
		if let Some(scan) = scanner.as_mut() {
			match scan.push(&buf[..n]) {
				Ok(true) => return ScanOutcome::Secret,
				Ok(false) => {}
				Err(()) => return ScanOutcome::Unchecked { reason: "budget" },
			}
		}
	}
	if let Some(scan) = scanner.as_mut() {
		match scan.end() {
			Ok(true) => return ScanOutcome::Secret,
			Ok(false) => {}
			Err(()) => return ScanOutcome::Unchecked { reason: "budget" },
		}
	}
	ScanOutcome::Clean { rebuilt }
}

fn load_spec_from_fd(spec_fd: RawFd) -> Result<CompiledSpec, String> {
	if spec_fd < 3 {
		return Err("--spec-fd must be 3 or higher".to_string());
	}
	// SAFETY: fcntl F_GETFD checks whether spec_fd is open before taking ownership.
	if unsafe { libc::fcntl(spec_fd, libc::F_GETFD) } < 0 {
		return Err("spec fd is not open".to_string());
	}
	clear_nonblock(spec_fd).map_err(|_| "spec fd flags could not be updated".to_string())?;
	// SAFETY: spec_fd is verified open, >= 3, and dedicated to this command.
	let mut spec_file = unsafe { File::from_raw_fd(spec_fd) };
	let mut spec_bytes = Vec::new();
	Read::by_ref(&mut spec_file)
		.take((MAX_SPEC_BYTES + 1) as u64)
		.read_to_end(&mut spec_bytes)
		.map_err(|_| "spec could not be read".to_string())?;
	drop(spec_file);
	if spec_bytes.len() > MAX_SPEC_BYTES {
		spec_bytes.fill(0);
		return Err("spec exceeds maximum size".to_string());
	}
	let parsed: Result<ScanSpec, _> = serde_json::from_slice(&spec_bytes);
	spec_bytes.fill(0);
	let spec = parsed.map_err(|_| "spec is not valid json".to_string())?;
	CompiledSpec::from_spec(spec)
}

fn clear_nonblock(fd: RawFd) -> io::Result<()> {
	// SAFETY: fcntl F_GETFL inspects descriptor flags without dereferencing memory.
	let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
	if flags < 0 {
		return Err(io::Error::last_os_error());
	}
	if (flags & libc::O_NONBLOCK) != 0 {
		// SAFETY: clearing O_NONBLOCK on an open pipe/socket descriptor ensures blocking reads.
		if unsafe { libc::fcntl(fd, libc::F_SETFL, flags & !libc::O_NONBLOCK) } < 0 {
			return Err(io::Error::last_os_error());
		}
	}
	Ok(())
}

pub fn run_from_fd(spec_fd: RawFd) -> Result<ScanOutcome, String> {
	run_pack_from_fd(spec_fd, &[], None)
}

pub fn run_pack_from_fd(
	spec_fd: RawFd,
	exclude_idx_paths: &[PathBuf],
	exclude_oids_fd: Option<RawFd>,
) -> Result<ScanOutcome, String> {
	clear_nonblock(libc::STDIN_FILENO).map_err(|_| "stdin flags could not be updated".to_string())?;
	let stdin = io::stdin();
	let mut lock = stdin.lock();
	let compiled = load_spec_from_fd(spec_fd)?;
	let excludes = OidExcludeSet::load(exclude_idx_paths, exclude_oids_fd)?;
	Ok(scan_pack_stream_with_excludes(&mut lock, &compiled, &excludes))
}

pub fn run_stream_from_fd(spec_fd: RawFd) -> Result<ScanOutcome, String> {
	clear_nonblock(libc::STDIN_FILENO).map_err(|_| "stdin flags could not be updated".to_string())?;
	let stdin = io::stdin();
	let mut lock = stdin.lock();
	run_stream_from_fd_with_reader(spec_fd, &mut lock)
}

#[cfg(test)]
fn run_from_fd_with_reader<R: Read>(spec_fd: RawFd, reader: &mut R) -> Result<ScanOutcome, String> {
	let compiled = load_spec_from_fd(spec_fd)?;
	Ok(scan_pack_stream(reader, &compiled))
}

fn run_stream_from_fd_with_reader<R: Read>(spec_fd: RawFd, reader: &mut R) -> Result<ScanOutcome, String> {
	let compiled = load_spec_from_fd(spec_fd)?;
	Ok(scan_raw_stream(reader, &compiled))
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::io::Cursor;

	const TEST_KEY: [u8; 32] = [
		0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
	];

	fn encode_b64url(bytes: &[u8]) -> String {
		const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
		let mut out = String::with_capacity((bytes.len() * 8).div_ceil(6));
		let mut i = 0;
		while i + 3 <= bytes.len() {
			let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8) | (bytes[i + 2] as u32);
			out.push(TABLE[((n >> 18) & 63) as usize] as char);
			out.push(TABLE[((n >> 12) & 63) as usize] as char);
			out.push(TABLE[((n >> 6) & 63) as usize] as char);
			out.push(TABLE[(n & 63) as usize] as char);
			i += 3;
		}
		match bytes.len() - i {
			1 => {
				let n = (bytes[i] as u32) << 16;
				out.push(TABLE[((n >> 18) & 63) as usize] as char);
				out.push(TABLE[((n >> 12) & 63) as usize] as char);
			}
			2 => {
				let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8);
				out.push(TABLE[((n >> 18) & 63) as usize] as char);
				out.push(TABLE[((n >> 12) & 63) as usize] as char);
				out.push(TABLE[((n >> 6) & 63) as usize] as char);
			}
			_ => {}
		}
		out
	}

	fn secret_value(key: &[u8; 32], value: &str) -> SpecValue {
		let bytes = value.as_bytes();
		let key_hmac = HmacSha256::new(key);
		let kw = key_hmac.mac(WINDOW_LABEL);
		let kv = key_hmac.mac(VALUE_LABEL);
		let c0 = u32::from_be_bytes(kw[0..4].try_into().unwrap());
		let c1 = u32::from_be_bytes(kw[4..8].try_into().unwrap()) | 1;
		let c2 = u32::from_be_bytes(kw[8..12].try_into().unwrap());
		let c3 = u32::from_be_bytes(kw[12..16].try_into().unwrap()) | 1;
		let c4 = u32::from_be_bytes(kw[16..20].try_into().unwrap());
		let c5 = u32::from_be_bytes(kw[20..24].try_into().unwrap()) | 1;
		let c6 = u32::from_be_bytes(kw[24..28].try_into().unwrap());
		let c7 = u32::from_be_bytes(kw[28..32].try_into().unwrap()) | 1;
		let hi = u32::from_be_bytes(bytes[0..4].try_into().unwrap());
		let lo = u32::from_be_bytes(bytes[4..8].try_into().unwrap());
		let mut h = (hi ^ c0).wrapping_mul(c1);
		h ^= h >> 15;
		h = (h ^ lo ^ c2).wrapping_mul(c3);
		h ^= h >> 13;
		h = (h ^ c4).wrapping_mul(c5);
		h ^= h >> 16;
		h = (h ^ c6).wrapping_mul(c7);
		let start = h >> TAG_SHIFT;
		let whole = encode_b64url(&HmacSha256::new(&kv).mac16(bytes));
		SpecValue { length: bytes.len(), start, whole }
	}

	fn compiled(values: &[&str], rebuilt_max: u64) -> CompiledSpec {
		CompiledSpec::from_spec(ScanSpec {
			key: encode_b64url(&TEST_KEY),
			values: values.iter().map(|v| secret_value(&TEST_KEY, v)).collect(),
			rebuilt_max,
			confirm_floor: CONFIRM_FLOOR,
			confirm_factor: CONFIRM_FACTOR,
		})
		.unwrap()
	}

	fn batch_entry(oid: &str, kind: &str, content: &[u8]) -> Vec<u8> {
		let mut out = format!("{oid} {kind} {}\n", content.len()).into_bytes();
		out.extend_from_slice(content);
		out.push(b'\n');
		out
	}

	struct ChunkedReader<'a> {
		data: &'a [u8],
		pos: usize,
		step: usize,
	}

	impl Read for ChunkedReader<'_> {
		fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
			if self.pos >= self.data.len() {
				return Ok(0);
			}
			let take = self.step.min(buf.len()).min(self.data.len() - self.pos);
			buf[..take].copy_from_slice(&self.data[self.pos..self.pos + take]);
			self.pos += take;
			Ok(take)
		}
	}

	#[test]
	fn matches_pinned_golden_vectors_from_typescript() {
		let vectors = [
			("test-value-0001", 15usize, 629920u32, "5X_nxV1CHyqs5ZYNTg0gzw"),
			("tëst-välue-ø2", 16usize, 509688u32, "xBn2UbqRMZ5bn2atiZ2EMQ"),
			("12345678", 8usize, 482076u32, "2qRGAeL827FEO7IY3r5SvQ"),
		];
		let spec = CompiledSpec::from_spec(ScanSpec {
			key: encode_b64url(&TEST_KEY),
			values: vectors
				.iter()
				.map(|(_, length, start, whole)| SpecValue {
					length: *length,
					start: *start,
					whole: (*whole).to_string(),
				})
				.collect(),
			rebuilt_max: 1024 * 1024,
			confirm_floor: CONFIRM_FLOOR,
			confirm_factor: CONFIRM_FACTOR,
		})
		.unwrap();
		for (value, length, start, whole) in vectors {
			let computed = secret_value(&TEST_KEY, value);
			assert_eq!(computed.length, length);
			assert_eq!(computed.start, start);
			assert_eq!(computed.whole, whole);
			let oid = "0123456789abcdef0123456789abcdef01234567";
			let stream = batch_entry(oid, "blob", format!("before {value} after").as_bytes());
			assert_eq!(scan_pack_stream(&mut Cursor::new(&stream), &spec), ScanOutcome::Secret);
			let trimmed = batch_entry(oid, "blob", &value.as_bytes()[1..]);
			assert_eq!(
				scan_pack_stream(&mut Cursor::new(&trimmed), &spec),
				ScanOutcome::Clean { rebuilt: (value.len() - 1) as u64 }
			);
		}
	}

	#[test]
	fn hmac_sha256_matches_rfc4231_vectors() {
		let key1 = [0x0bu8; 20];
		assert_eq!(
			HmacSha256::new(&key1).mac(b"Hi There"),
			[
				0xb0, 0x34, 0x4c, 0x61, 0xd8, 0xdb, 0x38, 0x53, 0x5c, 0xa8, 0xaf, 0xce, 0xaf, 0x0b, 0xf1, 0x2b,
				0x88, 0x1d, 0xc2, 0x00, 0xc9, 0x83, 0x3d, 0xa7, 0x26, 0xe9, 0x37, 0x6c, 0x2e, 0x32, 0xcf, 0xf7,
			]
		);
		let long_key = [0xaau8; 131];
		assert_eq!(
			HmacSha256::new(&long_key).mac(b"Test Using Larger Than Block-Size Key - Hash Key First"),
			[
				0x60, 0xe4, 0x31, 0x59, 0x1e, 0xe0, 0xb6, 0x7f, 0x0d, 0x8a, 0x26, 0xaa, 0xcb, 0xf5, 0xb7, 0x7f,
				0x8e, 0x0b, 0xc6, 0x21, 0x37, 0x28, 0xc5, 0x14, 0x05, 0x46, 0x04, 0x0f, 0x0e, 0xe3, 0x7f, 0x54,
			]
		);
	}

	#[test]
	fn scans_across_every_chunk_split_and_never_matches_across_object_boundaries() {
		let spec = compiled(&["test-value-0001", "test-value-0001-and-longer", "12345678"], 1024 * 1024);
		let matcher = spec.matcher.as_ref().unwrap();
		for value in ["test-value-0001", "test-value-0001-and-longer", "12345678"] {
			let payload = format!("before {value} after");
			let bytes = payload.as_bytes();
			for split in 0..=bytes.len() {
				let mut s = ObjectScanner::new(matcher, CONFIRM_FLOOR);
				let mut found = s.push(&bytes[..split]).unwrap();
				if !found {
					found = s.push(&bytes[split..]).unwrap();
				}
				if !found {
					found = s.end().unwrap();
				}
				assert!(found, "split={split} value={value}");
			}
			let mut single = ObjectScanner::new(matcher, CONFIRM_FLOOR);
			let mut found = false;
			for b in bytes {
				if single.push(&[*b]).unwrap() {
					found = true;
					break;
				}
			}
			if !found {
				found = single.end().unwrap();
			}
			assert!(found, "byte-by-byte value={value}");
		}

		let oid1 = "1111111111111111111111111111111111111111";
		let oid2 = "2222222222222222222222222222222222222222";
		let mut split_across_objects = batch_entry(oid1, "blob", b"test-val");
		split_across_objects.extend_from_slice(&batch_entry(oid2, "blob", b"ue-0001"));
		assert_eq!(
			scan_pack_stream(&mut Cursor::new(&split_across_objects), &spec),
			ScanOutcome::Clean { rebuilt: 15 }
		);

		let mut secret_in_second = batch_entry(oid1, "blob", b"harmless");
		secret_in_second.extend_from_slice(&batch_entry(oid2, "commit", b"msg test-value-0001\n"));
		for step in [1usize, 3, 7, 13, 64, 4096] {
			let mut reader = ChunkedReader { data: &secret_in_second, pos: 0, step };
			assert_eq!(scan_pack_stream(&mut reader, &spec), ScanOutcome::Secret, "step={step}");
		}
	}

	#[test]
	fn enforces_confirm_budget_identically_to_typescript() {
		let long = format!("test-val{}", "x".repeat(32 * 1024 - 8));
		let repeated = "test-val".repeat(8 * 1024);
		let oid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

		let over_stream = batch_entry(oid, "blob", repeated.as_bytes());
		let spec = compiled(&[&long], over_stream.len() as u64);
		assert_eq!(scan_pack_stream(&mut Cursor::new(&over_stream), &spec), ScanOutcome::Unchecked { reason: "budget" });

		let under_stream = batch_entry(oid, "blob", &repeated.as_bytes()[..40 * 1024]);
		let spec_under = compiled(&[&long], under_stream.len() as u64);
		assert_eq!(
			scan_pack_stream(&mut Cursor::new(&under_stream), &spec_under),
			ScanOutcome::Clean { rebuilt: (40 * 1024) as u64 }
		);
	}

	#[test]
	fn enforces_batch_framing_sha256_headers_empty_objects_and_rebuilt_limit() {
		let spec = compiled(&["test-value-0001"], 100);
		assert_eq!(scan_pack_stream(&mut Cursor::new(&[]), &spec), ScanOutcome::Clean { rebuilt: 0 });

		let sha1 = "0123456789abcdef0123456789abcdef01234567";
		let sha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
		let mut valid = batch_entry(sha1, "blob", b"");
		valid.extend_from_slice(&batch_entry(sha256, "tree", b"hello"));
		valid.extend_from_slice(&batch_entry(sha1, "tag", b"v1.0"));
		for step in [1usize, 2, 5, 19, 1024] {
			let mut reader = ChunkedReader { data: &valid, pos: 0, step };
			assert_eq!(scan_pack_stream(&mut reader, &spec), ScanOutcome::Clean { rebuilt: 9 });
		}

		let exact = batch_entry(sha1, "blob", &vec![b'a'; 100]);
		assert_eq!(scan_pack_stream(&mut Cursor::new(&exact), &spec), ScanOutcome::Clean { rebuilt: 100 });
		let over = batch_entry(sha1, "blob", &vec![b'a'; 101]);
		assert_eq!(scan_pack_stream(&mut Cursor::new(&over), &spec), ScanOutcome::Unchecked { reason: "rebuilt_limit" });

		let bad_cases: &[(&[u8], &str)] = &[
			(b"0123456789abcdef0123456789abcdef01234567 missing\n", "header"),
			(b"0123456789ABCDEF0123456789abcdef01234567 blob 0\n\n", "header"),
			(b"0123456789abcdef0123456789abcdef0123456 blob 0\n\n", "header"),
			(b"0123456789abcdef0123456789abcdef01234567 blub 0\n\n", "header"),
			(b"0123456789abcdef0123456789abcdef01234567 blob 01\na\n", "header"),
			(b"0123456789abcdef0123456789abcdef01234567 blob 3\nabcx", "framing"),
			(b"0123456789abcdef0123456789abcdef01234567 blob 3\nabc", "truncated"),
			(b"0123456789abcdef0123456789abcdef01234567 blob 3\nab", "truncated"),
			(b"0123456789abcdef0123456789abcdef01234567 blob", "truncated"),
		];
		for (input, reason) in bad_cases {
			assert_eq!(
				scan_pack_stream(&mut Cursor::new(input), &spec),
				ScanOutcome::Unchecked { reason },
				"input={:?}",
				String::from_utf8_lossy(input)
			);
		}
		let overlong_header = vec![b'a'; BATCH_LINE_MAX + 5];
		assert_eq!(
			scan_pack_stream(&mut Cursor::new(&overlong_header), &spec),
			ScanOutcome::Unchecked { reason: "header" }
		);
	}

	#[test]
	fn rejects_invalid_specs_and_non_canonical_base64url() {
		assert!(decode_b64url_exact::<32>(&encode_b64url(&TEST_KEY)).is_some());
		let mut non_canonical_key = encode_b64url(&TEST_KEY);
		non_canonical_key.pop();
		non_canonical_key.push('B');
		assert!(decode_b64url_exact::<32>(&non_canonical_key).is_none());

		let mut non_canonical_whole = "5X_nxV1CHyqs5ZYNTg0gzw".to_string();
		non_canonical_whole.pop();
		non_canonical_whole.push('x');
		assert!(decode_b64url_exact::<16>(&non_canonical_whole).is_none());

		let empty = CompiledSpec::from_spec(ScanSpec {
			key: encode_b64url(&TEST_KEY),
			values: vec![],
			rebuilt_max: 100,
			confirm_floor: CONFIRM_FLOOR,
			confirm_factor: CONFIRM_FACTOR,
		})
		.unwrap();
		assert!(empty.matcher.is_none());
		let oid = "0123456789abcdef0123456789abcdef01234567";
		let stream = batch_entry(oid, "blob", b"test-value-0001");
		assert_eq!(scan_pack_stream(&mut Cursor::new(&stream), &empty), ScanOutcome::Clean { rebuilt: 15 });
	}

	#[test]
	fn reads_spec_from_nonblocking_pipe_fd() {
		let mut fds = [-1 as RawFd; 2];
		// SAFETY: pipe writes two new valid fds into `fds`.
		assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
		// SAFETY: fds[0] is open and newly returned by pipe.
		let flags = unsafe { libc::fcntl(fds[0], libc::F_GETFL) };
		// SAFETY: setting O_NONBLOCK on our test pipe read end verifies clear_nonblock.
		assert_eq!(unsafe { libc::fcntl(fds[0], libc::F_SETFL, flags | libc::O_NONBLOCK) }, 0);
		let val = secret_value(&TEST_KEY, "test-value-0001");
		let spec_json = serde_json::json!({
			"key": encode_b64url(&TEST_KEY),
			"values": [{ "length": val.length, "start": val.start, "whole": val.whole }],
			"rebuiltMax": 1024
		})
		.to_string();
		// SAFETY: fds[1] is the write end exclusively owned by this test.
		let mut writer = unsafe { File::from_raw_fd(fds[1]) };
		std::io::Write::write_all(&mut writer, spec_json.as_bytes()).unwrap();
		drop(writer);
		let oid = "0123456789abcdef0123456789abcdef01234567";
		let stream = batch_entry(oid, "blob", b"contains test-value-0001 here");
		let result = run_from_fd_with_reader(fds[0], &mut Cursor::new(&stream)).unwrap();
		assert_eq!(result, ScanOutcome::Secret);
	}

	fn build_synthetic_idx_v2(mut oids: Vec<[u8; 20]>, extra_large_offsets: usize) -> Vec<u8> {
		oids.sort_unstable();
		oids.dedup();
		let mut out = Vec::new();
		out.extend_from_slice(&IDX_V2_MAGIC);
		out.extend_from_slice(&2u32.to_be_bytes());
		let mut fanout = [0u32; 256];
		let mut count = 0u32;
		let mut oi = 0usize;
		for bucket in 0..256u32 {
			while oi < oids.len() && oids[oi][0] as u32 == bucket {
				count += 1;
				oi += 1;
			}
			fanout[bucket as usize] = count;
			out.extend_from_slice(&count.to_be_bytes());
		}
		for oid in &oids {
			out.extend_from_slice(oid);
		}
		out.resize(out.len() + oids.len() * 8 + extra_large_offsets * 8 + IDX_V2_TRAILER_LEN, 0);
		out
	}

	#[test]
	fn scan_raw_stream_detects_secrets_across_chunks_and_enforces_limits() {
		let spec = compiled(&["test-value-0001", "12345678"], 256);
		assert_eq!(scan_raw_stream(&mut Cursor::new(b""), &spec), ScanOutcome::Clean { rebuilt: 0 });
		assert_eq!(
			scan_raw_stream(&mut Cursor::new(b"plain harmless payload"), &spec),
			ScanOutcome::Clean { rebuilt: 22 }
		);
		let payload = b"prefix test-value-0001 suffix";
		for step in [1usize, 3, 7, 15, 64] {
			let mut reader = ChunkedReader { data: payload, pos: 0, step };
			assert_eq!(scan_raw_stream(&mut reader, &spec), ScanOutcome::Secret, "step={step}");
		}
		let too_big = vec![b'z'; 257];
		assert_eq!(scan_raw_stream(&mut Cursor::new(&too_big), &spec), ScanOutcome::Unchecked { reason: "rebuilt_limit" });

		let mut fds = [-1 as RawFd; 2];
		// SAFETY: pipe writes two valid fds.
		assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
		let val = secret_value(&TEST_KEY, "test-value-0001");
		let spec_json = serde_json::json!({
			"key": encode_b64url(&TEST_KEY),
			"values": [{ "length": val.length, "start": val.start, "whole": val.whole }],
			"rebuiltMax": 1024
		})
		.to_string();
		// SAFETY: fds[1] is exclusively owned by this test.
		let mut writer = unsafe { File::from_raw_fd(fds[1]) };
		writer.write_all(spec_json.as_bytes()).unwrap();
		drop(writer);
		assert_eq!(
			run_stream_from_fd_with_reader(fds[0], &mut Cursor::new(b"xx test-value-0001 yy")).unwrap(),
			ScanOutcome::Secret
		);
	}

	#[test]
	fn idx_v2_parses_searches_diffs_and_rejects_malformed_inputs() {
		let o1 = [0x00u8; 20];
		let o2 = [0x12u8; 20];
		let mut o3 = [0x12u8; 20];
		o3[19] = 0x99;
		let o4 = [0xffu8; 20];
		let raw = build_synthetic_idx_v2(vec![o4, o2, o1, o3], 2);
		let idx = IdxV2::from_reader(&mut Cursor::new(&raw), Some(raw.len() as u64)).unwrap();
		assert_eq!(idx.len(), 4);
		assert!(idx.contains_sha1(&o1));
		assert!(idx.contains_sha1(&o2));
		assert!(idx.contains_sha1(&o3));
		assert!(idx.contains_sha1(&o4));
		assert!(!idx.contains_sha1(&[0x55u8; 20]));

		let empty_raw = build_synthetic_idx_v2(vec![], 0);
		let empty = IdxV2::from_reader(&mut Cursor::new(&empty_raw), Some(empty_raw.len() as u64)).unwrap();
		assert!(empty.is_empty());

		let mut bad_magic = raw.clone();
		bad_magic[0] = 0x00;
		assert!(IdxV2::from_reader(&mut Cursor::new(&bad_magic), Some(bad_magic.len() as u64)).is_err());
		let mut bad_ver = raw.clone();
		bad_ver[7] = 3;
		assert!(IdxV2::from_reader(&mut Cursor::new(&bad_ver), Some(bad_ver.len() as u64)).is_err());
		let mut bad_fanout = raw.clone();
		bad_fanout[8..12].copy_from_slice(&5u32.to_be_bytes());
		assert!(IdxV2::from_reader(&mut Cursor::new(&bad_fanout), Some(bad_fanout.len() as u64)).is_err());
		assert!(IdxV2::from_reader(&mut Cursor::new(&raw), Some((raw.len() - 1) as u64)).is_err());

		let base_raw = build_synthetic_idx_v2(vec![o1, o3], 0);
		let base_idx = IdxV2::from_reader(&mut Cursor::new(&base_raw), Some(base_raw.len() as u64)).unwrap();
		let mut excludes = OidExcludeSet::default();
		excludes.add_idx(base_idx);
		let mut delta_out = Vec::new();
		let delta_count = write_delta_oids(&idx, &excludes, &mut delta_out).unwrap();
		assert_eq!(delta_count, 2);
		let lines: Vec<&str> = std::str::from_utf8(&delta_out).unwrap().lines().collect();
		assert_eq!(lines, vec!["12".repeat(20), "ff".repeat(20)]);
	}

	#[test]
	fn scan_pack_skips_excluded_oids_while_scanning_delta_objects_and_checking_framing() {
		let spec = compiled(&["test-value-0001"], 64);
		let published_oid_bytes = [0x11u8; 20];
		let published_oid = "11".repeat(20);
		let excluded_list_oid = "22".repeat(20);
		let delta_oid = "33".repeat(20);
		let base_raw = build_synthetic_idx_v2(vec![published_oid_bytes], 0);
		let base_idx = IdxV2::from_reader(&mut Cursor::new(&base_raw), Some(base_raw.len() as u64)).unwrap();
		let mut excludes = OidExcludeSet::default();
		excludes.add_idx(base_idx);
		excludes
			.add_oids_reader(Cursor::new(format!("{excluded_list_oid}\n").as_bytes()))
			.unwrap();

		let mut clean_delta = batch_entry(&published_oid, "blob", b"old test-value-0001 skipped");
		clean_delta.extend_from_slice(&batch_entry(&excluded_list_oid, "blob", &[b'x'; 200]));
		clean_delta.extend_from_slice(&batch_entry(&delta_oid, "blob", b"new safe delta"));
		assert_eq!(
			scan_pack_stream_with_excludes(&mut Cursor::new(&clean_delta), &spec, &excludes),
			ScanOutcome::Clean { rebuilt: 14 }
		);

		let mut dirty_delta = batch_entry(&published_oid, "blob", b"old test-value-0001 skipped");
		dirty_delta.extend_from_slice(&batch_entry(&delta_oid, "blob", b"leaked test-value-0001"));
		assert_eq!(
			scan_pack_stream_with_excludes(&mut Cursor::new(&dirty_delta), &spec, &excludes),
			ScanOutcome::Secret
		);

		let bad_framing = format!("{published_oid} blob 3\nabcx");
		assert_eq!(
			scan_pack_stream_with_excludes(&mut Cursor::new(bad_framing.as_bytes()), &spec, &excludes),
			ScanOutcome::Unchecked { reason: "framing" }
		);
	}
}
