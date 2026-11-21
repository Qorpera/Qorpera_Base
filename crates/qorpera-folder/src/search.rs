use crate::re::{fold_char_utf8_len, fold_text, trigrams_of_bytes, ExecScratch, PatternError, Regex, TrigramQuery};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::{HashMap, VecDeque};
use std::fs::OpenOptions;
use std::io::{self, BufWriter, ErrorKind, Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub const CHUNK_BYTES: usize = 4 * 1024 * 1024;
const MAX_CHUNKS: usize = 64;
const MAX_MANIFEST_BYTES: usize = 32 * 1024;
pub const HITS_BYTES: usize = 6 * 1024;
pub const SHOWN_BYTES: usize = 26 * 1024;
const HIT_CHARS: usize = 200;
pub const READS_PER_ANSWER: usize = 4_000;
pub const READS_BYTES: usize = 1024 * 1024;
const BINARY_PROBE: usize = 8 * 1024;
pub const DEFAULT_PIECE_BYTES: usize = 4 * 1024 * 1024;
pub const DEFAULT_REGEX_PIECE_BYTES: usize = 256 * 1024;
pub const DEFAULT_LONGEST_LINE: usize = 1024 * 1024;
const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;
const INDEX_SHARDS: usize = 16;
const SMALL_EXACT_TRIGRAM_LIMIT: usize = 32;
const SMALL_FILE_COLLECT_LIMIT: u64 = 16 * 1024;
const MEDIUM_FILE_LIMIT: u64 = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct ObjectKey {
	profile_uuid: [u8; 16],
	sha256: [u8; 32],
}

fn parse_hex_sha256(hex: &str) -> Option<[u8; 32]> {
	let bytes = hex.as_bytes();
	if bytes.len() != 64 {
		return None;
	}
	let mut out = [0u8; 32];
	for i in 0..32 {
		let hi = hex_nibble(bytes[i * 2])?;
		let lo = hex_nibble(bytes[i * 2 + 1])?;
		out[i] = (hi << 4) | lo;
	}
	Some(out)
}

#[inline]
fn hex_nibble(b: u8) -> Option<u8> {
	match b {
		b'0'..=b'9' => Some(b - b'0'),
		b'a'..=b'f' => Some(b - b'a' + 10),
		_ => None,
	}
}

const HEX_CHARS: &[u8; 16] = b"0123456789abcdef";

fn hex_encode_32(bytes: &[u8; 32]) -> String {
	let mut out = [0u8; 64];
	for i in 0..32 {
		out[i * 2] = HEX_CHARS[(bytes[i] >> 4) as usize];
		out[i * 2 + 1] = HEX_CHARS[(bytes[i] & 0x0f) as usize];
	}
	String::from_utf8(out.to_vec()).unwrap()
}

fn format_uuid(bytes: &[u8; 16]) -> String {
	let mut out = [0u8; 36];
	let mut oi = 0usize;
	for (i, &b) in bytes.iter().enumerate() {
		if matches!(i, 4 | 6 | 8 | 10) {
			out[oi] = b'-';
			oi += 1;
		}
		out[oi] = HEX_CHARS[(b >> 4) as usize];
		out[oi + 1] = HEX_CHARS[(b & 0x0f) as usize];
		oi += 2;
	}
	String::from_utf8(out.to_vec()).unwrap()
}

fn parse_uuid(s: &str) -> Option<[u8; 16]> {
	let b = s.as_bytes();
	if b.len() != 36 {
		return None;
	}
	if b[8] != b'-' || b[13] != b'-' || b[18] != b'-' || b[23] != b'-' {
		return None;
	}
	if !(b'1'..=b'8').contains(&b[14]) || !matches!(b[19], b'8' | b'9' | b'a' | b'b') {
		return None;
	}
	let mut out = [0u8; 16];
	let mut oi = 0usize;
	let mut i = 0usize;
	while i < 36 {
		if matches!(i, 8 | 13 | 18 | 23) {
			i += 1;
			continue;
		}
		let hi = hex_nibble(b[i])?;
		let lo = hex_nibble(b[i + 1])?;
		out[oi] = (hi << 4) | lo;
		oi += 1;
		i += 2;
	}
	Some(out)
}

pub fn is_uuid(s: &str) -> bool {
	parse_uuid(s).is_some()
}

#[inline]
fn shard_of(key: &ObjectKey) -> usize {
	let a = u64::from_le_bytes(key.sha256[0..8].try_into().unwrap());
	let b = u64::from_le_bytes(key.profile_uuid[0..8].try_into().unwrap());
	((a ^ b.rotate_left(17)) as usize) & (INDEX_SHARDS - 1)
}

struct LruNode<K, V> {
	key: K,
	val: V,
	cost: usize,
	prev: usize,
	next: usize,
}

struct LruShard<K, V> {
	map: HashMap<K, usize>,
	nodes: Vec<Option<LruNode<K, V>>>,
	free: Vec<usize>,
	head: usize,
	tail: usize,
	bytes: usize,
	max_bytes: usize,
}

const NIL: usize = usize::MAX;

impl<K: Eq + std::hash::Hash + Clone, V: Clone> LruShard<K, V> {
	fn new(max_bytes: usize) -> Self {
		Self {
			map: HashMap::new(),
			nodes: Vec::new(),
			free: Vec::new(),
			head: NIL,
			tail: NIL,
			bytes: 0,
			max_bytes,
		}
	}

	fn get(&mut self, key: &K) -> Option<V> {
		let &idx = self.map.get(key)?;
		self.move_to_front(idx);
		self.nodes[idx].as_ref().map(|n| n.val.clone())
	}

	fn get_with<R>(&mut self, key: &K, f: impl FnOnce(&V) -> R) -> Option<R> {
		let &idx = self.map.get(key)?;
		self.move_to_front(idx);
		self.nodes[idx].as_ref().map(|n| f(&n.val))
	}

	fn insert(&mut self, key: K, val: V, cost: usize) {
		if cost > self.max_bytes {
			return;
		}
		if let Some(&idx) = self.map.get(&key) {
			if let Some(node) = self.nodes[idx].as_mut() {
				self.bytes = self.bytes.saturating_sub(node.cost);
				node.val = val;
				node.cost = cost;
				self.bytes += cost;
			}
			self.move_to_front(idx);
		} else {
			let idx = match self.free.pop() {
				Some(slot) => slot,
				None => {
					self.nodes.push(None);
					self.nodes.len() - 1
				}
			};
			let old_head = self.head;
			self.nodes[idx] = Some(LruNode { key: key.clone(), val, cost, prev: NIL, next: old_head });
			if old_head != NIL {
				self.nodes[old_head].as_mut().unwrap().prev = idx;
			} else {
				self.tail = idx;
			}
			self.head = idx;
			self.map.insert(key, idx);
			self.bytes += cost;
		}
		while self.bytes > self.max_bytes && self.tail != NIL {
			self.evict_tail();
		}
	}

	fn move_to_front(&mut self, idx: usize) {
		if self.head == idx {
			return;
		}
		let (prev, next) = {
			let n = self.nodes[idx].as_ref().unwrap();
			(n.prev, n.next)
		};
		if prev != NIL {
			self.nodes[prev].as_mut().unwrap().next = next;
		}
		if next != NIL {
			self.nodes[next].as_mut().unwrap().prev = prev;
		} else {
			self.tail = prev;
		}
		let old_head = self.head;
		{
			let n = self.nodes[idx].as_mut().unwrap();
			n.prev = NIL;
			n.next = old_head;
		}
		if old_head != NIL {
			self.nodes[old_head].as_mut().unwrap().prev = idx;
		} else {
			self.tail = idx;
		}
		self.head = idx;
	}

	fn evict_tail(&mut self) {
		let idx = self.tail;
		if idx == NIL {
			return;
		}
		let node = self.nodes[idx].take().unwrap();
		self.map.remove(&node.key);
		self.bytes = self.bytes.saturating_sub(node.cost);
		self.tail = node.prev;
		if self.tail != NIL {
			self.nodes[self.tail].as_mut().unwrap().next = NIL;
		} else {
			self.head = NIL;
		}
		self.free.push(idx);
	}
}

struct ShardedLru<K, V> {
	shards: Vec<Mutex<LruShard<K, V>>>,
}

impl<K: Eq + std::hash::Hash + Clone, V: Clone> ShardedLru<K, V> {
	fn new(total_bytes: usize) -> Self {
		let per_shard = (total_bytes / INDEX_SHARDS).max(4096);
		let mut shards = Vec::with_capacity(INDEX_SHARDS);
		for _ in 0..INDEX_SHARDS {
			shards.push(Mutex::new(LruShard::new(per_shard)));
		}
		Self { shards }
	}

	fn get(&self, shard: usize, key: &K) -> Option<V> {
		self.shards[shard].lock().unwrap().get(key)
	}

	fn get_with<R>(&self, shard: usize, key: &K, f: impl FnOnce(&V) -> R) -> Option<R> {
		self.shards[shard].lock().unwrap().get_with(key, f)
	}

	fn insert(&self, shard: usize, key: K, val: V, cost: usize) {
		self.shards[shard].lock().unwrap().insert(key, val, cost);
	}

	#[cfg(test)]
	fn total_bytes(&self) -> usize {
		self.shards.iter().map(|s| s.lock().unwrap().bytes).sum()
	}

	#[cfg(test)]
	fn total_entries(&self) -> usize {
		self.shards.iter().map(|s| s.lock().unwrap().map.len()).sum()
	}
}

#[inline]
fn trigram_hashes(t: u32) -> (u32, u32) {
	let mut h1 = t.wrapping_mul(0x9e37_79b1);
	h1 ^= h1 >> 16;
	h1 = h1.wrapping_mul(0x7feb_352d);
	h1 ^= h1 >> 15;
	let mut h2 = (t ^ 0x5a5a_a5a5).wrapping_mul(0x85eb_ca6b);
	h2 ^= h2 >> 13;
	h2 = h2.wrapping_mul(0xc2b2_ae35);
	h2 ^= h2 >> 16;
	(h1, h2 | 1)
}

#[derive(Debug, Clone)]
enum CompiledTrigramQuery {
	All,
	Exact { tri: u32, h1: u32, h2: u32 },
	And(Vec<CompiledTrigramQuery>),
	Or(Vec<CompiledTrigramQuery>),
}

impl CompiledTrigramQuery {
	fn from_query(q: &TrigramQuery) -> Self {
		match q {
			TrigramQuery::All => Self::All,
			TrigramQuery::Exact(tri) => {
				let (h1, h2) = trigram_hashes(*tri);
				Self::Exact { tri: *tri, h1, h2 }
			}
			TrigramQuery::And(xs) => Self::And(xs.iter().map(Self::from_query).collect()),
			TrigramQuery::Or(xs) => Self::Or(xs.iter().map(Self::from_query).collect()),
		}
	}
}

#[derive(Clone)]
enum TrigramFilter {
	Empty,
	Exact(Arc<[u32]>),
	Bloom(Arc<[u64]>),
	MatchAll,
}

impl TrigramFilter {
	fn heap_bytes(&self) -> usize {
		match self {
			Self::Empty | Self::MatchAll => 0,
			Self::Exact(xs) => xs.len() * 4,
			Self::Bloom(words) => words.len() * 8,
		}
	}

	#[inline]
	fn has_trigram(&self, tri: u32, h1: u32, h2: u32) -> bool {
		match self {
			Self::Empty => false,
			Self::MatchAll => true,
			Self::Exact(xs) => xs.binary_search(&tri).is_ok(),
			Self::Bloom(words) => {
				let mask = ((words.len() * 64) - 1) as u32;
				let b0 = h1 & mask;
				if ((words[(b0 >> 6) as usize] >> (b0 & 63)) & 1) == 0 {
					return false;
				}
				let b1 = h1.wrapping_add(h2) & mask;
				if ((words[(b1 >> 6) as usize] >> (b1 & 63)) & 1) == 0 {
					return false;
				}
				let b2 = h1.wrapping_add(h2.wrapping_mul(2)) & mask;
				((words[(b2 >> 6) as usize] >> (b2 & 63)) & 1) != 0
			}
		}
	}

	fn might_match(&self, q: &CompiledTrigramQuery) -> bool {
		match q {
			CompiledTrigramQuery::All => true,
			CompiledTrigramQuery::Exact { tri, h1, h2 } => self.has_trigram(*tri, *h1, *h2),
			CompiledTrigramQuery::And(xs) => xs.iter().all(|c| self.might_match(c)),
			CompiledTrigramQuery::Or(xs) => xs.iter().any(|c| self.might_match(c)),
		}
	}
}

enum BuilderMode {
	Collect(Vec<u32>),
	Bloom(Vec<u64>),
}

struct TrigramBuilder {
	mode: BuilderMode,
	last2: [u8; 2],
	have: usize,
	utf8_tail: Vec<u8>,
	cur_line_bytes: u64,
	max_line_bytes: u64,
	long_lines_1m: u32,
}

impl TrigramBuilder {
	fn new(file_bytes: u64) -> Self {
		let mode = if file_bytes <= SMALL_FILE_COLLECT_LIMIT {
			BuilderMode::Collect(Vec::with_capacity((file_bytes as usize).min(4096)))
		} else if file_bytes <= MEDIUM_FILE_LIMIT {
			let bits = ((file_bytes as usize) * 4).next_power_of_two().clamp(8192, 65536);
			BuilderMode::Bloom(vec![0u64; bits / 64])
		} else {
			BuilderMode::Bloom(vec![0u64; 262_144 / 64])
		};
		Self {
			mode,
			last2: [0, 0],
			have: 0,
			utf8_tail: Vec::new(),
			cur_line_bytes: 0,
			max_line_bytes: 0,
			long_lines_1m: 0,
		}
	}

	#[inline]
	fn add_tri(&mut self, tri: u32) {
		match &mut self.mode {
			BuilderMode::Collect(v) => v.push(tri),
			BuilderMode::Bloom(words) => {
				let mask = ((words.len() * 64) - 1) as u32;
				let (h1, h2) = trigram_hashes(tri);
				let b0 = h1 & mask;
				words[(b0 >> 6) as usize] |= 1u64 << (b0 & 63);
				let b1 = h1.wrapping_add(h2) & mask;
				words[(b1 >> 6) as usize] |= 1u64 << (b1 & 63);
				let b2 = h1.wrapping_add(h2.wrapping_mul(2)) & mask;
				words[(b2 >> 6) as usize] |= 1u64 << (b2 & 63);
			}
		}
	}

	fn push_folded_bytes(&mut self, bytes: &[u8]) {
		if bytes.is_empty() {
			return;
		}
		let mut i = 0usize;
		while self.have < 2 && i < bytes.len() {
			self.last2[self.have] = bytes[i];
			self.have += 1;
			i += 1;
		}
		if self.have < 2 || i >= bytes.len() {
			return;
		}
		let mut b0 = self.last2[0];
		let mut b1 = self.last2[1];
		for &b2 in &bytes[i..] {
			let tri = ((b0 as u32) << 16) | ((b1 as u32) << 8) | (b2 as u32);
			self.add_tri(tri);
			b0 = b1;
			b1 = b2;
		}
		self.last2 = [b0, b1];
	}

	fn push_raw_chunk(&mut self, chunk: &[u8], is_last: bool) {
		let mut start = 0usize;
		for (i, &b) in chunk.iter().enumerate() {
			if b == b'\n' {
				let line_len = self.cur_line_bytes + (i - start) as u64;
				if line_len > self.max_line_bytes {
					self.max_line_bytes = line_len;
				}
				if line_len > DEFAULT_LONGEST_LINE as u64 {
					self.long_lines_1m = self.long_lines_1m.saturating_add(1);
				}
				self.cur_line_bytes = 0;
				start = i + 1;
			}
		}
		self.cur_line_bytes += (chunk.len() - start) as u64;
		if is_last && self.cur_line_bytes > 0 {
			if self.cur_line_bytes > self.max_line_bytes {
				self.max_line_bytes = self.cur_line_bytes;
			}
			if self.cur_line_bytes > DEFAULT_LONGEST_LINE as u64 {
				self.long_lines_1m = self.long_lines_1m.saturating_add(1);
			}
			self.cur_line_bytes = 0;
		}

		if self.utf8_tail.is_empty() && chunk.is_ascii() {
			let mut folded = Vec::with_capacity(chunk.len());
			for &b in chunk {
				folded.push(b.to_ascii_lowercase());
			}
			self.push_folded_bytes(&folded);
			return;
		}
		let combined: Vec<u8>;
		let data: &[u8] = if self.utf8_tail.is_empty() {
			chunk
		} else {
			combined = [self.utf8_tail.as_slice(), chunk].concat();
			self.utf8_tail.clear();
			&combined
		};
		let cut = if is_last { data.len() } else { whole_utf8(data) };
		let head = &data[..cut];
		if cut < data.len() {
			self.utf8_tail.extend_from_slice(&data[cut..]);
		}
		if head.is_ascii() {
			let mut folded = Vec::with_capacity(head.len());
			for &b in head {
				folded.push(b.to_ascii_lowercase());
			}
			self.push_folded_bytes(&folded);
		} else {
			let decoded = String::from_utf8_lossy(head);
			let folded = fold_text(&decoded);
			self.push_folded_bytes(folded.as_bytes());
		}
	}

	fn finish(self, meta: ManifestMeta) -> IndexedEntry {
		let filter = match self.mode {
			BuilderMode::Collect(mut v) => {
				if v.is_empty() {
					TrigramFilter::Empty
				} else {
					v.sort_unstable();
					v.dedup();
					if v.len() <= SMALL_EXACT_TRIGRAM_LIMIT {
						TrigramFilter::Exact(Arc::from(v))
					} else {
						let bits = (v.len() * 12).next_power_of_two().clamp(512, 65536);
						let mut words = vec![0u64; bits / 64];
						let mask = (bits - 1) as u32;
						for tri in v {
							let (h1, h2) = trigram_hashes(tri);
							let b0 = h1 & mask;
							words[(b0 >> 6) as usize] |= 1u64 << (b0 & 63);
							let b1 = h1.wrapping_add(h2) & mask;
							words[(b1 >> 6) as usize] |= 1u64 << (b1 & 63);
							let b2 = h1.wrapping_add(h2.wrapping_mul(2)) & mask;
							words[(b2 >> 6) as usize] |= 1u64 << (b2 & 63);
						}
						TrigramFilter::Bloom(Arc::from(words))
					}
				}
			}
			BuilderMode::Bloom(words) => {
				let total_bits = words.len() * 64;
				let ones: usize = words.iter().map(|w| w.count_ones() as usize).sum();
				if ones == 0 {
					TrigramFilter::Empty
				} else if ones * 10 > total_bits * 9 {
					TrigramFilter::MatchAll
				} else {
					TrigramFilter::Bloom(Arc::from(words))
				}
			}
		};
		IndexedEntry::Text { meta, filter, max_line_bytes: self.max_line_bytes, long_lines_1m: self.long_lines_1m }
	}
}

const MEDIA_NONE: u16 = 0;
const MEDIA_EXTRA: u16 = u16::MAX;
const EXTRA_NONE: u32 = u32::MAX;

const FLAG_EXEC: u32 = 1 << 2;
const FLAG_HAS_M_SHA: u32 = 1 << 3;
const FLAG_HAS_F_SHA: u32 = 1 << 4;
const FLAG_GM: u32 = 1 << 7;

struct MediaInternerState {
	by_str: HashMap<Box<str>, u16>,
	list: Vec<Arc<str>>,
}

struct MediaInterner {
	inner: Mutex<MediaInternerState>,
}

impl MediaInterner {
	fn new() -> Self {
		Self { inner: Mutex::new(MediaInternerState { by_str: HashMap::new(), list: Vec::new() }) }
	}

	fn intern_id(&self, s: &str) -> u16 {
		let mut guard = self.inner.lock().unwrap();
		if let Some(&id) = guard.by_str.get(s) {
			return id;
		}
		if guard.list.len() >= (MEDIA_EXTRA as usize) - 1 {
			return MEDIA_EXTRA;
		}
		let id = (guard.list.len() + 1) as u16;
		guard.list.push(Arc::from(s));
		guard.by_str.insert(Box::from(s), id);
		id
	}

	fn resolve(&self, id: u16) -> Option<Arc<str>> {
		if id == MEDIA_NONE || id == MEDIA_EXTRA {
			return None;
		}
		let guard = self.inner.lock().unwrap();
		guard.list.get((id - 1) as usize).cloned()
	}
}

#[derive(Clone)]
struct ExtraMeta {
	version: Option<Box<str>>,
	target: Option<Box<str>>,
	media: Option<Box<str>>,
}

impl ExtraMeta {
	fn heap_bytes(&self) -> usize {
		self.version.as_deref().map_or(0, |s| s.len() + 16)
			+ self.target.as_deref().map_or(0, |s| s.len() + 16)
			+ self.media.as_deref().map_or(0, |s| s.len() + 16)
	}
}

#[derive(Clone, Copy)]
struct CompactEntry {
	path_off: u32,
	path_len: u32,
	rb: u32,
	flags: u32,
	bytes: u64,
	extra_idx: u32,
	inline_i: u32,
	version: [u8; 16],
	m_sha: [u8; 32],
	f_sha: [u8; 32],
}

impl CompactEntry {
	#[inline]
	fn kind_code(&self) -> u8 {
		(self.flags & 0b11) as u8
	}

	#[inline]
	fn executable(&self) -> bool {
		(self.flags & FLAG_EXEC) != 0
	}

	#[inline]
	fn has_m_sha(&self) -> bool {
		(self.flags & FLAG_HAS_M_SHA) != 0
	}

	#[inline]
	fn has_f_sha(&self) -> bool {
		(self.flags & FLAG_HAS_F_SHA) != 0
	}

	#[inline]
	fn ver_kind(&self) -> u8 {
		((self.flags >> 5) & 0b11) as u8
	}

	#[inline]
	fn gm(&self) -> bool {
		(self.flags & FLAG_GM) != 0
	}

	#[inline]
	fn media_id(&self) -> u16 {
		(self.flags >> 16) as u16
	}
}

#[derive(Clone)]
struct CompactTree {
	entries: Vec<CompactEntry>,
	paths: Vec<u8>,
	extras: Vec<ExtraMeta>,
}

enum DeltaOp {
	Remove(String),
	Upsert(WorkerEntry),
}

impl DeltaOp {
	fn path(&self) -> &str {
		match self {
			Self::Remove(p) => p.as_str(),
			Self::Upsert(w) => w.p.as_str(),
		}
	}
}

impl CompactTree {
	fn new() -> Self {
		Self { entries: Vec::new(), paths: Vec::new(), extras: Vec::new() }
	}

	fn with_capacity(entries_cap: usize, paths_cap: usize) -> Self {
		Self {
			entries: Vec::with_capacity(entries_cap),
			paths: Vec::with_capacity(paths_cap),
			extras: Vec::new(),
		}
	}

	fn from_wire(incoming: &[WorkerEntry], media: &MediaInterner) -> Self {
		let path_bytes: usize = incoming.iter().map(|w| w.p.len()).sum();
		let mut tree = Self::with_capacity(incoming.len(), path_bytes);
		tree.extend_wire(incoming, media);
		tree
	}

	fn extend_wire(&mut self, incoming: &[WorkerEntry], media: &MediaInterner) {
		let extra_paths: usize = incoming.iter().map(|w| w.p.len()).sum();
		self.entries.reserve(incoming.len());
		self.paths.reserve(extra_paths);
		for w in incoming {
			self.push_wire_ref(w, media);
		}
	}

	fn push_wire_ref(&mut self, w: &WorkerEntry, media: &MediaInterner) {
		let path_off = u32::try_from(self.paths.len()).expect("tree paths exceed 4 GiB");
		let path_len = u32::try_from(w.p.len()).expect("entry path exceeds u32");
		self.paths.extend_from_slice(w.p.as_bytes());
		let kind = w.k.min(2) as u32;
		let mut flags = kind;
		if w.gm {
			flags |= FLAG_GM;
		}
		let mut version = [0u8; 16];
		let mut extra_ver: Option<Box<str>> = None;
		if w.v.is_empty() {
		} else if let Some(uuid) = parse_uuid(&w.v) {
			version = uuid;
			flags |= 1 << 5;
		} else {
			flags |= 2 << 5;
			extra_ver = Some(Box::from(w.v.as_str()));
		}
		let mut m_sha = [0u8; 32];
		let mut f_sha = [0u8; 32];
		let mut bytes = 0u64;
		let mut extra_media: Option<Box<str>> = None;
		let mut extra_target: Option<Box<str>> = None;
		if w.k == 0 {
			bytes = w.b;
			if w.x {
				flags |= FLAG_EXEC;
			}
			if let Some(m) = w.m.as_deref().and_then(parse_hex_sha256) {
				m_sha = m;
				flags |= FLAG_HAS_M_SHA;
			}
			if let Some(f) = w.f.as_deref().and_then(parse_hex_sha256) {
				f_sha = f;
				flags |= FLAG_HAS_F_SHA;
			}
			if let Some(t) = w.t.as_deref() {
				let id = media.intern_id(t);
				flags |= (id as u32) << 16;
				if id == MEDIA_EXTRA {
					extra_media = Some(Box::from(t));
				}
			}
		} else if w.k == 2 {
			if let Some(tg) = w.tg.as_deref() {
				extra_target = Some(Box::from(tg));
			}
		}
		let extra_idx = if extra_ver.is_some() || extra_target.is_some() || extra_media.is_some() {
			let idx = self.extras.len() as u32;
			self.extras.push(ExtraMeta { version: extra_ver, target: extra_target, media: extra_media });
			idx
		} else {
			EXTRA_NONE
		};
		self.entries.push(CompactEntry {
			path_off,
			path_len,
			rb: w.rb.min(u32::MAX as usize) as u32,
			flags,
			bytes,
			extra_idx,
			inline_i: w.i,
			version,
			m_sha,
			f_sha,
		});
	}

	fn push_from_base(&mut self, base: &CompactTree, idx: usize) {
		let mut raw = base.entries[idx];
		let p_start = raw.path_off as usize;
		let p_end = p_start + raw.path_len as usize;
		let new_off = u32::try_from(self.paths.len()).expect("tree paths exceed 4 GiB");
		self.paths.extend_from_slice(&base.paths[p_start..p_end]);
		raw.path_off = new_off;
		if raw.extra_idx != EXTRA_NONE {
			let new_extra = self.extras.len() as u32;
			self.extras.push(base.extras[raw.extra_idx as usize].clone());
			raw.extra_idx = new_extra;
		}
		self.entries.push(raw);
	}

	fn extend_tail_from_base(&mut self, base: &CompactTree, start: usize) {
		if start >= base.entries.len() {
			return;
		}
		if base.extras.is_empty() {
			let first_off = base.entries[start].path_off as usize;
			let new_base_off = self.paths.len();
			self.paths.extend_from_slice(&base.paths[first_off..]);
			let shift = new_base_off as isize - first_off as isize;
			self.entries.reserve(base.entries.len() - start);
			for raw in &base.entries[start..] {
				let mut copied = *raw;
				copied.path_off = (copied.path_off as isize + shift) as u32;
				self.entries.push(copied);
			}
			return;
		}
		for idx in start..base.entries.len() {
			self.push_from_base(base, idx);
		}
	}

	fn patch(base: &CompactTree, upserts: Vec<WorkerEntry>, removes: Vec<String>, media: &MediaInterner) -> Self {
		let upserts_count = upserts.len();
		let upsert_path_bytes: usize = upserts.iter().map(|w| w.p.len()).sum();
		let mut ops: Vec<DeltaOp> = Vec::with_capacity(removes.len() + upserts_count);
		for rm in removes {
			ops.push(DeltaOp::Remove(rm));
		}
		for up in upserts {
			ops.push(DeltaOp::Upsert(up));
		}
		ops.sort_by(|a, b| tree_order(a.path(), b.path()));
		let mut deduped: Vec<DeltaOp> = Vec::with_capacity(ops.len());
		for op in ops {
			if deduped.last().is_some_and(|prev| prev.path() == op.path()) {
				*deduped.last_mut().unwrap() = op;
			} else {
				deduped.push(op);
			}
		}
		let mut out = Self::with_capacity(base.entries.len() + upserts_count, base.paths.len() + upsert_path_bytes);
		let mut bi = 0usize;
		let mut oi = 0usize;
		while bi < base.entries.len() && oi < deduped.len() {
			match tree_order(base.path(bi), deduped[oi].path()) {
				Ordering::Less => {
					out.push_from_base(base, bi);
					bi += 1;
				}
				Ordering::Equal => {
					if let DeltaOp::Upsert(w) = &deduped[oi] {
						out.push_wire_ref(w, media);
					}
					bi += 1;
					oi += 1;
				}
				Ordering::Greater => {
					if let DeltaOp::Upsert(w) = &deduped[oi] {
						out.push_wire_ref(w, media);
					}
					oi += 1;
				}
			}
		}
		if bi < base.entries.len() {
			out.extend_tail_from_base(base, bi);
		}
		while oi < deduped.len() {
			if let DeltaOp::Upsert(w) = &deduped[oi] {
				out.push_wire_ref(w, media);
			}
			oi += 1;
		}
		out.shrink_to_fit();
		out
	}

	fn shrink_to_fit(&mut self) {
		self.entries.shrink_to_fit();
		self.paths.shrink_to_fit();
		self.extras.shrink_to_fit();
	}

	#[inline]
	fn len(&self) -> usize {
		self.entries.len()
	}

	#[inline]
	fn path(&self, idx: usize) -> &str {
		let e = &self.entries[idx];
		let s = e.path_off as usize;
		let bytes = &self.paths[s..s + e.path_len as usize];
		std::str::from_utf8(bytes).unwrap()
	}

	#[inline]
	fn entry(&self, idx: usize) -> EntryRef<'_> {
		EntryRef { tree: self, raw: &self.entries[idx] }
	}

	fn partition_point(&self, pred: impl Fn(&str) -> bool) -> usize {
		self.partition_point_in(0..self.entries.len(), pred)
	}

	fn partition_point_in(&self, range: std::ops::Range<usize>, pred: impl Fn(&str) -> bool) -> usize {
		let mut lo = 0usize;
		let mut hi = range.end - range.start;
		while lo < hi {
			let mid = lo + (hi - lo) / 2;
			if pred(self.path(range.start + mid)) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		lo
	}

	fn mem_bytes(&self) -> usize {
		let entries_b = self.entries.capacity() * std::mem::size_of::<CompactEntry>();
		let paths_b = self.paths.capacity();
		let extras_b = self.extras.capacity() * std::mem::size_of::<ExtraMeta>()
			+ self.extras.iter().map(ExtraMeta::heap_bytes).sum::<usize>();
		entries_b + paths_b + extras_b + 64
	}
}

#[derive(Clone, Copy)]
struct EntryRef<'a> {
	tree: &'a CompactTree,
	raw: &'a CompactEntry,
}

impl<'a> EntryRef<'a> {
	#[inline]
	fn path(&self) -> &'a str {
		let s = self.raw.path_off as usize;
		std::str::from_utf8(&self.tree.paths[s..s + self.raw.path_len as usize]).unwrap()
	}

	#[inline]
	fn kind_code(&self) -> u8 {
		self.raw.kind_code()
	}

	#[inline]
	fn bytes(&self) -> u64 {
		self.raw.bytes
	}

	#[inline]
	fn rb(&self) -> usize {
		self.raw.rb as usize
	}

	#[inline]
	fn gm(&self) -> bool {
		self.raw.gm()
	}

	#[inline]
	fn inline_i(&self) -> u32 {
		self.raw.inline_i
	}

	#[inline]
	fn executable(&self) -> bool {
		self.raw.executable()
	}

	#[inline]
	fn manifest_sha(&self) -> Option<[u8; 32]> {
		if self.raw.has_m_sha() { Some(self.raw.m_sha) } else { None }
	}

	#[inline]
	fn file_sha(&self) -> Option<[u8; 32]> {
		if self.raw.has_f_sha() { Some(self.raw.f_sha) } else { None }
	}

	#[inline]
	fn media_id(&self) -> u16 {
		self.raw.media_id()
	}

	fn extra_media(&self) -> Option<&'a str> {
		if self.raw.extra_idx == EXTRA_NONE {
			return None;
		}
		self.tree.extras[self.raw.extra_idx as usize].media.as_deref()
	}

	fn media_type(&self, media: &MediaInterner) -> Option<String> {
		let id = self.raw.media_id();
		if id == MEDIA_NONE {
			None
		} else if id == MEDIA_EXTRA {
			self.extra_media().map(str::to_string)
		} else {
			media.resolve(id).map(|s| s.to_string())
		}
	}

	#[inline]
	fn version_is_empty(&self) -> bool {
		self.raw.ver_kind() == 0
	}

	fn version_string(&self) -> String {
		match self.raw.ver_kind() {
			0 => String::new(),
			1 => format_uuid(&self.raw.version),
			_ => self.tree.extras[self.raw.extra_idx as usize]
				.version
				.as_deref()
				.unwrap_or("")
				.to_string(),
		}
	}

	fn version_eq(&self, other: &str) -> bool {
		match self.raw.ver_kind() {
			0 => other.is_empty(),
			1 => parse_uuid(other) == Some(self.raw.version),
			_ => self.tree.extras[self.raw.extra_idx as usize].version.as_deref() == Some(other),
		}
	}

	fn target(&self) -> Option<&'a str> {
		if self.raw.extra_idx == EXTRA_NONE {
			return None;
		}
		self.tree.extras[self.raw.extra_idx as usize].target.as_deref()
	}
}

#[derive(Clone)]
struct ManifestMeta {
	v2: bool,
	file_sha256: [u8; 32],
	bytes: u64,
	media_id: u16,
	media_extra: Option<Arc<str>>,
	executable: Option<bool>,
}

impl ManifestMeta {
	fn from_manifest(m: &ParsedManifest, media: &MediaInterner) -> Self {
		let (media_id, media_extra) = match m.media_type.as_deref() {
			None => (MEDIA_NONE, None),
			Some(s) => {
				let id = media.intern_id(s);
				if id == MEDIA_EXTRA { (id, Some(Arc::from(s))) } else { (id, None) }
			}
		};
		Self { v2: m.v2, file_sha256: m.file_sha256, bytes: m.bytes, media_id, media_extra, executable: m.executable }
	}

	fn matches_entry(&self, entry: EntryRef<'_>) -> bool {
		if entry.file_sha() != Some(self.file_sha256) || self.bytes != entry.bytes() {
			return false;
		}
		if self.v2 {
			if self.media_id == MEDIA_NONE
				|| self.media_id != entry.media_id()
				|| self.executable != Some(entry.executable())
			{
				return false;
			}
			if self.media_id == MEDIA_EXTRA && self.media_extra.as_deref() != entry.extra_media() {
				return false;
			}
		}
		true
	}
}

#[derive(Clone)]
enum IndexedEntry {
	Binary { meta: ManifestMeta },
	Text { meta: ManifestMeta, filter: TrigramFilter, max_line_bytes: u64, long_lines_1m: u32 },
}

impl IndexedEntry {
	fn meta(&self) -> &ManifestMeta {
		match self {
			Self::Binary { meta } | Self::Text { meta, .. } => meta,
		}
	}

	fn cost(&self) -> usize {
		let base = 200;
		match self {
			Self::Binary { .. } => base,
			Self::Text { filter, .. } => base + filter.heap_bytes(),
		}
	}
}

#[derive(Debug, Clone)]
struct ManifestChunk {
	sha256: String,
	sha256_bytes: [u8; 32],
	bytes: usize,
	start: u64,
}

#[derive(Debug, Clone)]
struct ParsedManifest {
	v2: bool,
	file_sha256: [u8; 32],
	bytes: u64,
	media_type: Option<String>,
	executable: Option<bool>,
	chunks: Vec<ManifestChunk>,
}

#[derive(Clone)]
enum CachedObject {
	Manifest(Arc<ParsedManifest>),
	Chunk(Arc<Vec<u8>>),
}

struct TreeSlot {
	tree: Arc<CompactTree>,
	bytes: usize,
}

struct TreeCacheState {
	slots: HashMap<u64, TreeSlot>,
	total_bytes: usize,
}

struct TreeCache {
	inner: Mutex<TreeCacheState>,
}

impl TreeCache {
	fn new() -> Self {
		Self { inner: Mutex::new(TreeCacheState { slots: HashMap::new(), total_bytes: 0 }) }
	}

	fn sync(
		&self,
		snapshot_id: u64,
		incoming: Vec<WorkerEntry>,
		append: bool,
		complete: bool,
		media: &MediaInterner,
	) -> bool {
		if append {
			let mut guard = self.inner.lock().unwrap();
			let Some(slot) = guard.slots.get_mut(&snapshot_id) else {
				return false;
			};
			let old_bytes = slot.bytes;
			let tree = Arc::make_mut(&mut slot.tree);
			tree.extend_wire(&incoming, media);
			if complete {
				tree.shrink_to_fit();
			}
			let new_bytes = tree.mem_bytes();
			slot.bytes = new_bytes;
			guard.total_bytes = guard.total_bytes.saturating_sub(old_bytes) + new_bytes;
			return true;
		}
		let mut tree = CompactTree::from_wire(&incoming, media);
		if complete {
			tree.shrink_to_fit();
		}
		let bytes = tree.mem_bytes();
		let mut guard = self.inner.lock().unwrap();
		if let Some(old) = guard.slots.remove(&snapshot_id) {
			guard.total_bytes = guard.total_bytes.saturating_sub(old.bytes);
		}
		guard.slots.insert(snapshot_id, TreeSlot { tree: Arc::new(tree), bytes });
		guard.total_bytes += bytes;
		true
	}

	fn patch(
		&self,
		base_snapshot_id: u64,
		snapshot_id: u64,
		upserts: Vec<WorkerEntry>,
		removes: Vec<String>,
		media: &MediaInterner,
	) -> bool {
		let base = {
			let guard = self.inner.lock().unwrap();
			guard.slots.get(&base_snapshot_id).map(|s| s.tree.clone())
		};
		let Some(base_tree) = base else {
			return false;
		};
		let patched = CompactTree::patch(&base_tree, upserts, removes, media);
		let bytes = patched.mem_bytes();
		let mut guard = self.inner.lock().unwrap();
		if let Some(old) = guard.slots.remove(&snapshot_id) {
			guard.total_bytes = guard.total_bytes.saturating_sub(old.bytes);
		}
		guard.slots.insert(snapshot_id, TreeSlot { tree: Arc::new(patched), bytes });
		guard.total_bytes += bytes;
		true
	}

	fn drop_tree(&self, snapshot_id: u64) {
		let mut guard = self.inner.lock().unwrap();
		if let Some(removed) = guard.slots.remove(&snapshot_id) {
			guard.total_bytes = guard.total_bytes.saturating_sub(removed.bytes);
		}
	}

	fn get(&self, snapshot_id: u64) -> Option<Arc<CompactTree>> {
		let guard = self.inner.lock().unwrap();
		guard.slots.get(&snapshot_id).map(|s| s.tree.clone())
	}

	#[cfg(test)]
	fn total_bytes(&self) -> usize {
		self.inner.lock().unwrap().total_bytes
	}
}

#[derive(Clone, Copy)]
enum TrigramProbe {
	Miss,
	MetadataMismatch,
	Binary,
	Skip { extra_long_lines: u64 },
	MaybeMatch,
}

pub struct SharedIndex {
	storage_root: PathBuf,
	trigrams: ShardedLru<ObjectKey, IndexedEntry>,
	objects: ShardedLru<ObjectKey, CachedObject>,
	trees: TreeCache,
	media: MediaInterner,
}

#[derive(Debug)]
enum ObjectError {
	Integrity(String),
	Missing(String),
	Unavailable(String),
}

impl ObjectError {
	fn message(&self) -> &str {
		match self {
			Self::Integrity(m) | Self::Missing(m) | Self::Unavailable(m) => m,
		}
	}
}

impl SharedIndex {
	pub fn new(storage_root: PathBuf, index_mib: usize) -> Self {
		let total = index_mib.max(1) * 1024 * 1024;
		let trigram_bytes = (total * 25) / 100;
		let object_bytes = (total * 10) / 100;
		Self {
			storage_root,
			trigrams: ShardedLru::new(trigram_bytes),
			objects: ShardedLru::new(object_bytes),
			trees: TreeCache::new(),
			media: MediaInterner::new(),
		}
	}

	pub fn sync_tree(&self, snapshot_id: u64, entries: Vec<WorkerEntry>, append: bool, complete: bool) -> bool {
		self.trees.sync(snapshot_id, entries, append, complete, &self.media)
	}

	pub fn patch_tree(
		&self,
		base_snapshot_id: u64,
		snapshot_id: u64,
		upserts: Vec<WorkerEntry>,
		removes: Vec<String>,
	) -> bool {
		self.trees.patch(base_snapshot_id, snapshot_id, upserts, removes, &self.media)
	}

	pub fn drop_tree(&self, snapshot_id: u64) {
		self.trees.drop_tree(snapshot_id);
	}

	fn get_tree(&self, snapshot_id: u64) -> Option<Arc<CompactTree>> {
		self.trees.get(snapshot_id)
	}

	fn check_profile_dir(&self, profile_id: &str) -> Result<[u8; 16], ObjectError> {
		let Some(uuid) = parse_uuid(profile_id) else {
			return Err(ObjectError::Integrity("Object identity is invalid".to_string()));
		};
		let dir = self.storage_root.join(profile_id);
		match std::fs::metadata(&dir) {
			Ok(meta) if meta.is_dir() => Ok(uuid),
			_ => Err(ObjectError::Unavailable(
				"The company's objects are not on the storage server now".to_string(),
			)),
		}
	}

	fn read_verified_file(
		&self,
		profile_id: &str,
		hash_hex: &str,
		expected_sha: [u8; 32],
		maximum: usize,
		exact: Option<usize>,
	) -> Result<Vec<u8>, ObjectError> {
		if !is_uuid(profile_id) {
			return Err(ObjectError::Integrity("Object identity is invalid".to_string()));
		}
		let path = self.storage_root.join(profile_id).join(hash_hex);
		let mut file = match OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(&path) {
			Ok(f) => f,
			Err(e) => {
				if e.raw_os_error() == Some(libc::ELOOP) {
					return Err(ObjectError::Integrity("Object is a link".to_string()));
				}
				if e.kind() == ErrorKind::NotFound {
					let dir_ok = std::fs::metadata(self.storage_root.join(profile_id))
						.map(|m| m.is_dir())
						.unwrap_or(false);
					if !dir_ok {
						return Err(ObjectError::Unavailable(
							"The company's objects are not on the storage server now".to_string(),
						));
					}
					return Err(ObjectError::Missing("Object is not on the storage server".to_string()));
				}
				return Err(ObjectError::Unavailable(format!("Object could not be opened ({})", e.kind())));
			}
		};
		let meta = file
			.metadata()
			.map_err(|e| ObjectError::Unavailable(format!("Object could not be stated ({})", e.kind())))?;
		if !meta.file_type().is_file() {
			return Err(ObjectError::Integrity("Object is not a regular file".to_string()));
		}
		let size = meta.len() as usize;
		if meta.len() > maximum as u64 || exact.is_some_and(|ex| size != ex) {
			return Err(ObjectError::Integrity("Object has the wrong size".to_string()));
		}
		let mut bytes = vec![0u8; size];
		let mut read = 0usize;
		while read < size {
			match file.read(&mut bytes[read..]) {
				Ok(0) => break,
				Ok(n) => read += n,
				Err(e) if e.kind() == ErrorKind::Interrupted => continue,
				Err(e) => return Err(ObjectError::Unavailable(format!("Object could not be read ({})", e.kind()))),
			}
		}
		if read != size {
			return Err(ObjectError::Integrity("Object failed its hash check".to_string()));
		}
		let actual: [u8; 32] = Sha256::digest(&bytes).into();
		if actual != expected_sha {
			return Err(ObjectError::Integrity("Object failed its hash check".to_string()));
		}
		Ok(bytes)
	}

	fn load_manifest(
		&self,
		profile_id: &str,
		profile_uuid: [u8; 16],
		entry: EntryRef<'_>,
	) -> Result<Arc<ParsedManifest>, ObjectError> {
		let manifest_sha = entry
			.manifest_sha()
			.ok_or_else(|| ObjectError::Integrity("Object identity is invalid".to_string()))?;
		let key = ObjectKey { profile_uuid, sha256: manifest_sha };
		let shard = shard_of(&key);
		if let Some(CachedObject::Manifest(parsed)) = self.objects.get(shard, &key) {
			verify_manifest_against_entry(&parsed, entry, &self.media)?;
			return Ok(parsed);
		}
		let manifest_hex = hex_encode_32(&manifest_sha);
		let raw = self.read_verified_file(profile_id, &manifest_hex, manifest_sha, MAX_MANIFEST_BYTES, None)?;
		let parsed = Arc::new(parse_manifest_bytes(&raw, entry, &self.media)?);
		let cost = 256 + parsed.chunks.len() * 128;
		self.objects.insert(shard, key, CachedObject::Manifest(parsed.clone()), cost);
		Ok(parsed)
	}

	fn load_chunk(
		&self,
		profile_id: &str,
		profile_uuid: [u8; 16],
		chunk: &ManifestChunk,
	) -> Result<Arc<Vec<u8>>, ObjectError> {
		let key = ObjectKey { profile_uuid, sha256: chunk.sha256_bytes };
		let shard = shard_of(&key);
		if let Some(CachedObject::Chunk(bytes)) = self.objects.get(shard, &key) {
			if bytes.len() != chunk.bytes {
				return Err(ObjectError::Integrity("Object has the wrong size".to_string()));
			}
			return Ok(bytes);
		}
		let raw = self.read_verified_file(profile_id, &chunk.sha256, chunk.sha256_bytes, chunk.bytes, Some(chunk.bytes))?;
		let arc = Arc::new(raw);
		let cost = 128 + arc.len();
		self.objects.insert(shard, key, CachedObject::Chunk(arc.clone()), cost);
		Ok(arc)
	}

	fn probe_trigram(
		&self,
		profile_uuid: [u8; 16],
		manifest_sha: [u8; 32],
		entry: EntryRef<'_>,
		trigram_query: &CompiledTrigramQuery,
		use_regex: bool,
		longest_line: usize,
	) -> TrigramProbe {
		let key = ObjectKey { profile_uuid, sha256: manifest_sha };
		self.trigrams
			.get_with(shard_of(&key), &key, |cached| {
				if !cached.meta().matches_entry(entry) {
					return TrigramProbe::MetadataMismatch;
				}
				match cached {
					IndexedEntry::Binary { .. } => TrigramProbe::Binary,
					IndexedEntry::Text { filter, max_line_bytes, long_lines_1m, .. } => {
						let long_lines_known = !use_regex
							|| *max_line_bytes <= longest_line as u64
							|| longest_line == DEFAULT_LONGEST_LINE;
						if long_lines_known && !filter.might_match(trigram_query) {
							let extra_long_lines = if use_regex && *max_line_bytes > longest_line as u64 {
								*long_lines_1m as u64
							} else {
								0
							};
							TrigramProbe::Skip { extra_long_lines }
						} else {
							TrigramProbe::MaybeMatch
						}
					}
				}
			})
			.unwrap_or(TrigramProbe::Miss)
	}

	fn put_trigram(&self, profile_uuid: [u8; 16], manifest_sha: [u8; 32], entry: IndexedEntry) {
		let key = ObjectKey { profile_uuid, sha256: manifest_sha };
		let cost = entry.cost();
		self.trigrams.insert(shard_of(&key), key, entry, cost);
	}
}

fn verify_manifest_against_entry(
	m: &ParsedManifest,
	entry: EntryRef<'_>,
	media: &MediaInterner,
) -> Result<(), ObjectError> {
	if entry.file_sha() != Some(m.file_sha256) || m.bytes != entry.bytes() {
		return Err(ObjectError::Integrity("Manifest does not match its entry".to_string()));
	}
	if m.v2
		&& (m.media_type.is_none()
			|| m.media_type.as_deref() != entry.media_type(media).as_deref()
			|| m.executable != Some(entry.executable()))
	{
		return Err(ObjectError::Integrity("Manifest does not match its entry".to_string()));
	}
	Ok(())
}

fn parse_manifest_bytes(raw: &[u8], entry: EntryRef<'_>, media: &MediaInterner) -> Result<ParsedManifest, ObjectError> {
	let text = std::str::from_utf8(raw).map_err(|_| ObjectError::Integrity("Manifest is not JSON".to_string()))?;
	let val: serde_json::Value =
		serde_json::from_str(text).map_err(|_| ObjectError::Integrity("Manifest is not JSON".to_string()))?;
	let obj = val.as_object().ok_or_else(|| ObjectError::Integrity("Manifest is not an object".to_string()))?;
	let schema = obj.get("schema").and_then(|v| v.as_str()).unwrap_or("");
	let v2 = schema == "qorpera.cloud-file-manifest/v2";
	let expected_keys: &[&str] = if v2 {
		&["schema", "fileSha256", "bytes", "mediaType", "executable", "chunks"]
	} else if schema == "qorpera.cloud-file-manifest/v1" {
		&["schema", "fileSha256", "bytes", "mediaType", "chunks"]
	} else {
		return Err(ObjectError::Integrity("Manifest has an unknown shape".to_string()));
	};
	if obj.len() != expected_keys.len() || expected_keys.iter().any(|k| !obj.contains_key(*k)) {
		return Err(ObjectError::Integrity("Manifest has an unknown shape".to_string()));
	}
	let file_sha256 = obj
		.get("fileSha256")
		.and_then(|v| v.as_str())
		.and_then(parse_hex_sha256)
		.ok_or_else(|| ObjectError::Integrity("Manifest does not match its entry".to_string()))?;
	let bytes = obj
		.get("bytes")
		.and_then(|v| v.as_u64())
		.ok_or_else(|| ObjectError::Integrity("Manifest does not match its entry".to_string()))?;
	let media_type = obj.get("mediaType").and_then(|v| v.as_str()).map(str::to_string);
	let executable = obj.get("executable").and_then(|v| v.as_bool());
	let raw_chunks = obj
		.get("chunks")
		.and_then(|v| v.as_array())
		.ok_or_else(|| ObjectError::Integrity("Manifest does not match its entry".to_string()))?;
	if raw_chunks.len() > MAX_CHUNKS {
		return Err(ObjectError::Integrity("Manifest does not match its entry".to_string()));
	}
	let mut start = 0u64;
	let mut chunks = Vec::with_capacity(raw_chunks.len());
	for (idx, item) in raw_chunks.iter().enumerate() {
		let c = item.as_object().ok_or_else(|| ObjectError::Integrity("Manifest chunk is invalid".to_string()))?;
		if c.len() != 2 {
			return Err(ObjectError::Integrity("Manifest chunk is invalid".to_string()));
		}
		let sha_str = c
			.get("sha256")
			.and_then(|v| v.as_str())
			.ok_or_else(|| ObjectError::Integrity("Manifest chunk is invalid".to_string()))?;
		let sha_bytes =
			parse_hex_sha256(sha_str).ok_or_else(|| ObjectError::Integrity("Manifest chunk is invalid".to_string()))?;
		let c_bytes = c
			.get("bytes")
			.and_then(|v| v.as_u64())
			.ok_or_else(|| ObjectError::Integrity("Manifest chunk is invalid".to_string()))?;
		if c_bytes < 1 || c_bytes > CHUNK_BYTES as u64 {
			return Err(ObjectError::Integrity("Manifest chunk is invalid".to_string()));
		}
		if !v2 && idx + 1 < raw_chunks.len() && c_bytes != CHUNK_BYTES as u64 {
			return Err(ObjectError::Integrity("Manifest chunk is invalid".to_string()));
		}
		chunks.push(ManifestChunk { sha256: sha_str.to_string(), sha256_bytes: sha_bytes, bytes: c_bytes as usize, start });
		start = start
			.checked_add(c_bytes)
			.ok_or_else(|| ObjectError::Integrity("Manifest chunks do not add up to the file".to_string()))?;
	}
	if start != entry.bytes() {
		return Err(ObjectError::Integrity("Manifest chunks do not add up to the file".to_string()));
	}
	let parsed = ParsedManifest { v2, file_sha256, bytes, media_type, executable, chunks };
	verify_manifest_against_entry(&parsed, entry, media)?;
	Ok(parsed)
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchCursor {
	pub path: String,
	pub version: String,
	pub offset: u64,
	pub line: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
	pub path: String,
	pub kind: String,
	pub line: u64,
	pub text: String,
	pub version: String,
	pub offset: u64,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub target: Option<String>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub before: Option<Vec<String>>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub after: Option<Vec<String>>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub from: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SearchFile {
	pub path: String,
	pub version: String,
	pub count: u64,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub partial: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PageState {
	pub hit_bytes: usize,
	pub hits_count: usize,
	pub reads_count: usize,
	pub read_bytes: usize,
	pub examined: usize,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WorkerEntry {
	#[serde(default)]
	pub i: u32,
	pub k: u8,
	pub p: String,
	pub v: String,
	#[serde(default)]
	pub m: Option<String>,
	#[serde(default)]
	pub f: Option<String>,
	#[serde(default)]
	pub b: u64,
	#[serde(default)]
	pub t: Option<String>,
	#[serde(default)]
	pub x: bool,
	#[serde(default)]
	pub tg: Option<String>,
	pub rb: usize,
	#[serde(default)]
	pub gm: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerRequest {
	pub id: u64,
	#[serde(default)]
	pub snapshot_id: Option<u64>,
	#[serde(default)]
	pub profile_id: Option<String>,
	pub version: u8,
	pub query: Option<String>,
	pub regex: bool,
	pub path: String,
	#[serde(default)]
	pub glob: Option<String>,
	pub names_only: bool,
	pub files_only: bool,
	pub case_sensitive: bool,
	pub context: usize,
	pub links: bool,
	pub after: Option<SearchCursor>,
	pub slice_ms: u64,
	#[serde(default)]
	pub longest_line: Option<usize>,
	#[serde(default)]
	pub piece_bytes: Option<usize>,
	#[serde(default)]
	pub state: PageState,
	#[serde(default)]
	pub entries: Vec<WorkerEntry>,
}

fn default_true() -> bool {
	true
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncTreeMessage {
	id: u64,
	snapshot_id: u64,
	#[serde(default)]
	append: bool,
	#[serde(default = "default_true")]
	complete: bool,
	entries: Vec<WorkerEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatchTreeMessage {
	id: u64,
	base_snapshot_id: u64,
	snapshot_id: u64,
	#[serde(default)]
	upserts: Vec<WorkerEntry>,
	#[serde(default)]
	removes: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DropTreeMessage {
	#[serde(default)]
	id: u64,
	snapshot_id: u64,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum TaggedWorkerMessage {
	SyncTree(SyncTreeMessage),
	PatchTree(PatchTreeMessage),
	DropTree(DropTreeMessage),
	Search(WorkerRequest),
}

enum WorkerMessage {
	SyncTree(SyncTreeMessage),
	PatchTree(PatchTreeMessage),
	DropTree(DropTreeMessage),
	Search(WorkerRequest),
}

fn parse_worker_message(bytes: &[u8]) -> Result<WorkerMessage, serde_json::Error> {
	if let Ok(tagged) = serde_json::from_slice::<TaggedWorkerMessage>(bytes) {
		return Ok(match tagged {
			TaggedWorkerMessage::SyncTree(m) => WorkerMessage::SyncTree(m),
			TaggedWorkerMessage::PatchTree(m) => WorkerMessage::PatchTree(m),
			TaggedWorkerMessage::DropTree(m) => WorkerMessage::DropTree(m),
			TaggedWorkerMessage::Search(m) => WorkerMessage::Search(m),
		});
	}
	serde_json::from_slice::<WorkerRequest>(bytes).map(WorkerMessage::Search)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerOk {
	pub hits: Vec<SearchHit>,
	pub files: Vec<SearchFile>,
	pub searched: u64,
	pub binary: u64,
	pub unreadable: u64,
	pub long_lines: u64,
	#[serde(skip_serializing_if = "Vec::is_empty")]
	pub read_indices: Vec<u32>,
	#[serde(skip_serializing_if = "Vec::is_empty")]
	pub read_ranges: Vec<u32>,
	pub logs: Vec<String>,
	pub next: Option<SearchCursor>,
	pub done: bool,
	pub state: PageState,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerError {
	pub kind: &'static str,
	pub message: String,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub entry_index: Option<u32>,
}

impl WorkerError {
	fn simple(kind: &'static str, message: impl Into<String>) -> Self {
		Self { kind, message: message.into(), entry_index: None }
	}
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerResponse {
	pub id: u64,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub synced: Option<bool>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub ok: Option<WorkerOk>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub error: Option<WorkerError>,
}

fn tree_order(a: &str, b: &str) -> Ordering {
	if a == b {
		return Ordering::Equal;
	}
	if a.is_empty() {
		return Ordering::Less;
	}
	if b.is_empty() {
		return Ordering::Greater;
	}
	let ab = a.as_bytes();
	let bb = b.as_bytes();
	let mut ai = 0usize;
	let mut bi = 0usize;
	loop {
		let a_slash = ab[ai..].iter().position(|&c| c == b'/').map(|p| ai + p);
		let b_slash = bb[bi..].iter().position(|&c| c == b'/').map(|p| bi + p);
		let a_end = a_slash.unwrap_or(ab.len());
		let b_end = b_slash.unwrap_or(bb.len());
		let ord = ab[ai..a_end].cmp(&bb[bi..b_end]);
		if ord != Ordering::Equal {
			return ord;
		}
		match (a_slash, b_slash) {
			(None, None) => return Ordering::Equal,
			(None, Some(_)) => return Ordering::Less,
			(Some(_), None) => return Ordering::Greater,
			(Some(as_), Some(bs_)) => {
				ai = as_ + 1;
				bi = bs_ + 1;
			}
		}
	}
}

#[inline]
fn is_descendant(entry_path: &str, dir_path: &str) -> bool {
	if dir_path.is_empty() {
		return true;
	}
	entry_path.len() > dir_path.len()
		&& entry_path.as_bytes()[dir_path.len()] == b'/'
		&& entry_path.as_bytes().starts_with(dir_path.as_bytes())
}

fn slice_tree(tree: &CompactTree, path: &str, from: Option<&str>) -> std::ops::Range<usize> {
	let n = tree.len();
	let (lo, hi) = if path.is_empty() {
		(0usize, n)
	} else {
		let start = tree.partition_point(|p| tree_order(p, path) == Ordering::Less);
		if start >= n || tree.path(start) != path {
			return 0..0;
		}
		if tree.entries[start].kind_code() != 1 {
			(start, start + 1)
		} else {
			let rel_end = tree.partition_point_in(start + 1..n, |p| is_descendant(p, path));
			(start, start + 1 + rel_end)
		}
	};
	if lo >= hi {
		return 0..0;
	}
	let Some(f) = from else {
		return lo..hi;
	};
	if f == path {
		return lo..hi;
	}
	let under_path = if path.is_empty() { true } else { is_descendant(f, path) };
	if !under_path {
		if !path.is_empty() && f.as_bytes() < path.as_bytes() {
			return lo..hi;
		}
		return 0..0;
	}
	if tree.entries[lo].kind_code() != 1 {
		return 0..0;
	}
	let rel = tree.partition_point_in(lo + 1..hi, |p| tree_order(p, f) == Ordering::Less);
	(lo + 1 + rel)..hi
}

enum GlobPart {
	DoubleStar,
	Pattern(Vec<char>),
}

enum SimpleNameGlob {
	Exact(String),
	Affix { prefix: String, suffix: String },
}

struct CompiledGlob {
	parts: Vec<GlobPart>,
	name_only: bool,
	simple_name: Option<SimpleNameGlob>,
}

impl CompiledGlob {
	fn parse(glob: &str) -> Self {
		let name_only = !glob.contains('/');
		let mut simple_name = None;
		if name_only && !glob.contains('?') {
			if let Some(first_star) = glob.find('*') {
				let bytes = glob.as_bytes();
				let mut star_end = first_star;
				while star_end < bytes.len() && bytes[star_end] == b'*' {
					star_end += 1;
				}
				if !glob[star_end..].contains('*') {
					simple_name = Some(SimpleNameGlob::Affix {
						prefix: glob[..first_star].to_string(),
						suffix: glob[star_end..].to_string(),
					});
				}
			} else {
				simple_name = Some(SimpleNameGlob::Exact(glob.to_string()));
			}
		}
		let parts = glob
			.split('/')
			.map(|part| {
				if part == "**" {
					GlobPart::DoubleStar
				} else {
					GlobPart::Pattern(part.chars().collect())
				}
			})
			.collect();
		Self { parts, name_only, simple_name }
	}

	fn matches_entry(&self, entry_path: &str, request_path: &str) -> bool {
		if entry_path == request_path {
			return self.matches_rel(basename(entry_path));
		}
		let rel = if request_path.is_empty() {
			entry_path
		} else if entry_path.len() > request_path.len() {
			&entry_path[request_path.len() + 1..]
		} else {
			entry_path
		};
		self.matches_rel(rel)
	}

	fn matches_rel(&self, rel: &str) -> bool {
		if self.name_only {
			let name = basename(rel);
			if let Some(simple) = &self.simple_name {
				return match simple {
					SimpleNameGlob::Exact(v) => name == v,
					SimpleNameGlob::Affix { prefix, suffix } => {
						name.len() >= prefix.len() + suffix.len()
							&& name.starts_with(prefix.as_str())
							&& name.ends_with(suffix.as_str())
					}
				};
			}
			let name_chars: Vec<char> = name.chars().collect();
			return match &self.parts[0] {
				GlobPart::DoubleStar => true,
				GlobPart::Pattern(pat) => glob_name_matches(pat, &name_chars),
			};
		}
		let names: Vec<Vec<char>> = rel.split('/').map(|s| s.chars().collect()).collect();
		let mut p = 0usize;
		let mut n = 0usize;
		let mut star: Option<usize> = None;
		let mut mark = 0usize;
		while n < names.len() {
			match self.parts.get(p) {
				Some(GlobPart::Pattern(pat)) if glob_name_matches(pat, &names[n]) => {
					p += 1;
					n += 1;
				}
				Some(GlobPart::DoubleStar) => {
					star = Some(p);
					p += 1;
					mark = n;
				}
				_ => {
					if let Some(st) = star {
						p = st + 1;
						mark += 1;
						n = mark;
					} else {
						return false;
					}
				}
			}
		}
		while matches!(self.parts.get(p), Some(GlobPart::DoubleStar)) {
			p += 1;
		}
		p == self.parts.len()
	}
}

fn glob_name_matches(pattern: &[char], name: &[char]) -> bool {
	let mut p = 0usize;
	let mut n = 0usize;
	let mut star: Option<usize> = None;
	let mut mark = 0usize;
	while n < name.len() {
		if p < pattern.len() && pattern[p] != '*' && (pattern[p] == '?' || pattern[p] == name[n]) {
			p += 1;
			n += 1;
		} else if p < pattern.len() && pattern[p] == '*' {
			star = Some(p);
			p += 1;
			mark = n;
		} else if let Some(st) = star {
			p = st + 1;
			mark += 1;
			n = mark;
		} else {
			return false;
		}
	}
	while p < pattern.len() && pattern[p] == '*' {
		p += 1;
	}
	p == pattern.len()
}

#[inline]
fn push_read_range(ranges: &mut Vec<u32>, idx: u32) {
	let len = ranges.len();
	if len >= 2 {
		let start = ranges[len - 2];
		let count = ranges[len - 1];
		if start.wrapping_add(count) == idx {
			ranges[len - 1] = count + 1;
			return;
		}
	}
	ranges.push(idx);
	ranges.push(1);
}

#[inline]
fn decimal_digits(mut n: u64) -> usize {
	if n == 0 {
		return 1;
	}
	let mut d = 0;
	while n > 0 {
		d += 1;
		n /= 10;
	}
	d
}

#[inline]
fn shown_line(path: &str, line: u64, text: &str) -> usize {
	path.len() + decimal_digits(line) + text.len() + 4
}

fn whole_utf8(bytes: &[u8]) -> usize {
	let len = bytes.len();
	let mut start = len;
	while start > 0 && len - start < 3 && (bytes[start - 1] & 0xc0) == 0x80 {
		start -= 1;
	}
	if start == 0 {
		return len;
	}
	let lead = bytes[start - 1];
	let size = if lead >= 0xf0 {
		4
	} else if lead >= 0xe0 {
		3
	} else if lead >= 0xc0 {
		2
	} else {
		1
	};
	if len - (start - 1) >= size { len } else { start - 1 }
}

#[inline]
fn sanitize_char(ch: char) -> char {
	let c = ch as u32;
	if c <= 0x08 || (0x0a..=0x1f).contains(&c) || c == 0x7f { ' ' } else { ch }
}

fn context_text(bytes: &[u8]) -> String {
	let cut = bytes.len().min(HIT_CHARS * 4 + 4);
	let slice = &bytes[..whole_utf8(&bytes[..cut])];
	let decoded = String::from_utf8_lossy(slice);
	let mut out = String::with_capacity(decoded.len().min(HIT_CHARS * 4));
	let mut count = 0usize;
	for ch in decoded.chars() {
		if count == HIT_CHARS {
			out.push('…');
			return out;
		}
		out.push(sanitize_char(ch));
		count += 1;
	}
	out
}

fn around(line: &str, found_folded_byte: usize, case_sensitive: bool) -> String {
	let chars: Vec<char> = line.chars().map(sanitize_char).collect();
	if chars.len() <= HIT_CHARS {
		return chars.into_iter().collect();
	}
	let mut at = 0usize;
	let mut folded_bytes = 0usize;
	for ch in line.chars() {
		if folded_bytes >= found_folded_byte {
			break;
		}
		folded_bytes += if case_sensitive { ch.len_utf8() } else { fold_char_utf8_len(ch) };
		at += 1;
	}
	let start = at.saturating_sub(HIT_CHARS / 4).min(chars.len() - HIT_CHARS);
	let mut out = String::with_capacity(HIT_CHARS * 2 + 6);
	if start > 0 {
		out.push('…');
	}
	for &ch in &chars[start..start + HIT_CHARS] {
		out.push(ch);
	}
	if start + HIT_CHARS < chars.len() {
		out.push('…');
	}
	out
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
	if needle.is_empty() {
		return Some(0);
	}
	if needle.len() > haystack.len() {
		return None;
	}
	let first = needle[0];
	let last_idx = needle.len() - 1;
	let last = needle[last_idx];
	let limit = haystack.len() - needle.len() + 1;
	let mut i = 0usize;
	while i < limit {
		let Some(rel) = haystack[i..limit].iter().position(|&b| b == first) else {
			return None;
		};
		let pos = i + rel;
		if haystack[pos + last_idx] == last && &haystack[pos..pos + needle.len()] == needle {
			return Some(pos);
		}
		i = pos + 1;
	}
	None
}

enum Matcher {
	Always,
	Literal {
		query_folded: String,
		raw_bytes: Option<Vec<u8>>,
		case_sensitive: bool,
	},
	Pattern {
		regex: Regex,
		case_sensitive: bool,
	},
}

impl Matcher {
	fn build(query: Option<&str>, regex: bool, case_sensitive: bool) -> Result<(Self, CompiledTrigramQuery), PatternError> {
		let Some(q) = query else {
			return Ok((Self::Always, CompiledTrigramQuery::All));
		};
		if regex {
			let re = Regex::compile(q, case_sensitive)?;
			let tq = CompiledTrigramQuery::from_query(re.trigram_query());
			return Ok((Self::Pattern { regex: re, case_sensitive }, tq));
		}
		let folded = fold_text(q);
		let tq = CompiledTrigramQuery::from_query(&trigrams_of_bytes(folded.as_bytes()));
		let raw_bytes = if case_sensitive && !q.is_empty() && !q.contains('\u{fffd}') {
			Some(q.as_bytes().to_vec())
		} else {
			None
		};
		let query_match = if case_sensitive { q.to_string() } else { folded };
		Ok((Self::Literal { query_folded: query_match, raw_bytes, case_sensitive }, tq))
	}

	fn find_str(&self, text: &str, scratch: &mut ExecScratch) -> Option<usize> {
		match self {
			Self::Always => Some(0),
			Self::Literal { query_folded, case_sensitive, .. } => {
				if *case_sensitive {
					text.find(query_folded.as_str())
				} else {
					fold_text(text).find(query_folded.as_str())
				}
			}
			Self::Pattern { regex, .. } => regex.find_in_text(text, scratch),
		}
	}

	fn chunk_has_match(&self, whole: &[u8], scratch: &mut ExecScratch) -> bool {
		match self {
			Self::Always => true,
			Self::Literal { query_folded, raw_bytes, case_sensitive } => {
				if let Some(raw) = raw_bytes {
					return find_subslice(whole, raw).is_some();
				}
				if *case_sensitive {
					return String::from_utf8_lossy(whole).contains(query_folded.as_str());
				}
				if whole.is_ascii() && query_folded.is_ascii() {
					let lowered: Vec<u8> = whole.iter().map(|b| b.to_ascii_lowercase()).collect();
					return find_subslice(&lowered, query_folded.as_bytes()).is_some();
				}
				fold_text(&String::from_utf8_lossy(whole)).contains(query_folded.as_str())
			}
			Self::Pattern { regex, case_sensitive } => {
				if *case_sensitive {
					let decoded = String::from_utf8_lossy(whole);
					return regex.find_in_text(&decoded, scratch).is_some();
				}
				if whole.is_ascii() {
					let lowered_bytes: Vec<u8> = whole.iter().map(|b| b.to_ascii_lowercase()).collect();
					let lowered = std::str::from_utf8(&lowered_bytes).unwrap();
					return regex.find_in_folded(lowered, scratch).is_some();
				}
				let folded = fold_text(&String::from_utf8_lossy(whole));
				regex.find_in_folded(&folded, scratch).is_some()
			}
		}
	}
}

struct ContextLine {
	text: String,
	start: u64,
}

fn basename(path: &str) -> &str {
	match path.rfind('/') {
		Some(i) => &path[i + 1..],
		None => path,
	}
}

fn kind_name(k: u8) -> &'static str {
	match k {
		0 => "file",
		1 => "folder",
		_ => "symlink",
	}
}

fn at_cursor(entry: EntryRef<'_>, offset: u64, line: u64) -> SearchCursor {
	SearchCursor { path: entry.path().to_string(), version: entry.version_string(), offset, line }
}

fn hit_measure(shown: &SearchHit, v2: bool) -> usize {
	if !v2 {
		return serde_json::to_string(shown).unwrap().len();
	}
	if shown.line == 0 {
		let extra = match &shown.target {
			None => 2,
			Some(t) => serde_json::to_string(t).unwrap().len() + 6,
		};
		shown.path.len() + extra
	} else {
		let base = shown_line(&shown.path, shown.line, &shown.text);
		let ctx = match &shown.before {
			None => 0,
			Some(before) => before.iter().fold(3usize, |sum, t| sum + shown_line(&shown.path, shown.line, t)),
		};
		base + ctx
	}
}

fn read_manifest_slice(
	index: &SharedIndex,
	profile_id: &str,
	profile_uuid: [u8; 16],
	manifest: &ParsedManifest,
	offset: u64,
	length: usize,
) -> Result<Vec<u8>, ObjectError> {
	let end = manifest.bytes.min(offset.saturating_add(length as u64));
	if offset >= end {
		return Ok(Vec::new());
	}
	let mut out = Vec::with_capacity((end - offset) as usize);
	for chunk in &manifest.chunks {
		let c_end = chunk.start + chunk.bytes as u64;
		if chunk.start < end && c_end > offset {
			let data = index.load_chunk(profile_id, profile_uuid, chunk)?;
			let from = offset.saturating_sub(chunk.start) as usize;
			let to = (end - chunk.start).min(chunk.bytes as u64) as usize;
			out.extend_from_slice(&data[from..to]);
		}
	}
	Ok(out)
}

pub fn execute_search(index: &SharedIndex, req: &WorkerRequest) -> Result<WorkerOk, WorkerError> {
	let resolved_tree = req.snapshot_id.and_then(|sid| index.get_tree(sid));
	execute_search_with_tree(index, req, resolved_tree)
}

fn execute_search_with_tree(
	index: &SharedIndex,
	req: &WorkerRequest,
	resolved_tree: Option<Arc<CompactTree>>,
) -> Result<WorkerOk, WorkerError> {
	let v2 = req.version == 2;
	let use_regex = v2 && req.regex;
	let files_only = v2 && req.files_only;
	let context = if v2 { req.context.min(5) } else { 0 };
	let (matcher, trigram_query) = Matcher::build(req.query.as_deref(), use_regex, req.case_sensitive)
		.map_err(|e| WorkerError::simple("pattern", e.0))?;
	let use_ranges = req.snapshot_id.is_some();
	let synced_tree = if use_ranges {
		Some(resolved_tree.ok_or_else(|| WorkerError::simple("missing_tree", "Synced tree snapshot not found"))?)
	} else {
		None
	};
	let inline_tree = if use_ranges { CompactTree::new() } else { CompactTree::from_wire(&req.entries, &index.media) };
	let glob = if use_ranges { req.glob.as_deref().map(CompiledGlob::parse) } else { None };
	let tree_ref: &CompactTree = match &synced_tree {
		Some(tree) => tree.as_ref(),
		None => &inline_tree,
	};
	let entry_range = if use_ranges {
		slice_tree(tree_ref, &req.path, req.after.as_ref().map(|a| a.path.as_str()))
	} else {
		0..tree_ref.len()
	};
	let deadline = Instant::now() + Duration::from_millis(req.slice_ms);
	let piece_bytes = req
		.piece_bytes
		.unwrap_or(if use_regex { DEFAULT_REGEX_PIECE_BYTES } else { DEFAULT_PIECE_BYTES })
		.max(1);
	let longest_line = req.longest_line.unwrap_or(DEFAULT_LONGEST_LINE).max(1);
	let overlap = req.query.as_deref().map_or(0, str::len) * 3 + 4;
	let budget = if v2 { SHOWN_BYTES } else { HITS_BYTES };

	let mut state = req.state.clone();
	let mut hits: Vec<SearchHit> = Vec::new();
	let mut files: Vec<SearchFile> = Vec::new();
	let mut read_indices: Vec<u32> = Vec::new();
	let mut read_ranges: Vec<u32> = Vec::new();
	let mut logs: Vec<String> = Vec::new();
	let mut searched: u64 = 0;
	let mut binary: u64 = 0;
	let mut unreadable: u64 = 0;
	let mut long_lines: u64 = 0;
	let mut scratch = ExecScratch::new();
	let mut profile_uuid_checked: Option<[u8; 16]> = None;

	let record_read = |entry: EntryRef<'_>,
	                   entry_idx: u32,
	                   state: &mut PageState,
	                   read_indices: &mut Vec<u32>,
	                   read_ranges: &mut Vec<u32>| {
		if entry.version_is_empty() {
			return;
		}
		if use_ranges {
			push_read_range(read_ranges, entry_idx);
		} else {
			read_indices.push(entry_idx);
		}
		state.reads_count += 1;
		state.read_bytes += entry.rb();
	};

	let push_hit = |shown: SearchHit, state: &mut PageState, hits: &mut Vec<SearchHit>| -> bool {
		let bytes = hit_measure(&shown, v2);
		if state.hits_count > 0 && state.hit_bytes + bytes > budget {
			return false;
		}
		hits.push(shown);
		state.hits_count += 1;
		state.hit_bytes += bytes;
		true
	};

	for tree_idx in entry_range {
		let entry = tree_ref.entry(tree_idx);
		let entry_idx = if use_ranges { tree_idx as u32 } else { entry.inline_i() };
		let entry_path = entry.path();
		let kind = entry.kind_code();
		let entry_bytes = entry.bytes();
		if kind == 2 && !req.links {
			continue;
		}
		let glob_matched = if use_ranges {
			glob.as_ref().map_or(true, |g| g.matches_entry(entry_path, &req.path))
		} else {
			entry.gm()
		};
		let is_text = !req.names_only && kind == 0 && entry_bytes > 0 && glob_matched;
		if state.examined > 0
			&& (state.reads_count >= READS_PER_ANSWER
				|| state.read_bytes >= READS_BYTES
				|| Instant::now() >= deadline
				|| (files_only && is_text && state.hit_bytes + shown_line(entry_path, 0, "") + 8 > budget))
		{
			return Ok(WorkerOk {
				hits,
				files,
				searched,
				binary,
				unreadable,
				long_lines,
				read_indices,
				read_ranges,
				logs,
				next: Some(at_cursor(entry, 0, 0)),
				done: true,
				state,
			});
		}
		state.examined += 1;
		if kind == 1 {
			record_read(entry, entry_idx, &mut state, &mut read_indices, &mut read_ranges);
			if req.names_only
				&& entry_path != req.path.as_str()
				&& !entry.version_is_empty()
				&& glob_matched
				&& matcher.find_str(basename(entry_path), &mut scratch).is_some()
			{
				let hit = SearchHit {
					path: entry_path.to_string(),
					kind: "folder".to_string(),
					line: 0,
					text: String::new(),
					version: entry.version_string(),
					offset: 0,
					target: None,
					before: None,
					after: None,
					from: None,
				};
				if !push_hit(hit, &mut state, &mut hits) {
					return Ok(WorkerOk {
						hits,
						files,
						searched,
						binary,
						unreadable,
						long_lines,
						read_indices,
						read_ranges,
						logs,
						next: Some(at_cursor(entry, 0, 0)),
						done: true,
						state,
					});
				}
			}
			continue;
		}
		if req.names_only {
			if glob_matched && matcher.find_str(basename(entry_path), &mut scratch).is_some() {
				let hit = SearchHit {
					path: entry_path.to_string(),
					kind: kind_name(kind).to_string(),
					line: 0,
					text: String::new(),
					version: entry.version_string(),
					offset: 0,
					target: if kind == 2 { entry.target().map(str::to_string) } else { None },
					before: None,
					after: None,
					from: None,
				};
				if !push_hit(hit, &mut state, &mut hits) {
					return Ok(WorkerOk {
						hits,
						files,
						searched,
						binary,
						unreadable,
						long_lines,
						read_indices,
						read_ranges,
						logs,
						next: Some(at_cursor(entry, 0, 0)),
						done: true,
						state,
					});
				}
				record_read(entry, entry_idx, &mut state, &mut read_indices, &mut read_ranges);
			}
			continue;
		}
		if !is_text {
			continue;
		}
		let Some(profile_id) = req.profile_id.as_deref() else {
			if use_ranges {
				return Err(WorkerError {
					kind: "need_profile",
					message: "Storage profile lookup required".to_string(),
					entry_index: Some(entry_idx),
				});
			}
			return Err(WorkerError::simple(
				"unavailable",
				"The company's objects are not on the storage server now",
			));
		};
		let profile_uuid = match profile_uuid_checked {
			Some(uuid) => uuid,
			None => match index.check_profile_dir(profile_id) {
				Ok(uuid) => {
					profile_uuid_checked = Some(uuid);
					uuid
				}
				Err(err) => {
					if matches!(err, ObjectError::Unavailable(_)) {
						return Err(WorkerError::simple("unavailable", err.message()));
					}
					logs.push(format!(
						"folder-service: search passed over {} ({}): {}",
						entry_path,
						entry.version_string(),
						err.message()
					));
					unreadable += 1;
					continue;
				}
			},
		};

		let resume = req
			.after
			.as_ref()
			.filter(|a| a.path.as_str() == entry_path && entry.version_eq(&a.version));
		let manifest_sha = entry.manifest_sha();
		let mut already_indexed = false;

		if resume.is_none() && piece_bytes >= BINARY_PROBE {
			if let Some(m_sha) = manifest_sha {
				match index.probe_trigram(profile_uuid, m_sha, entry, &trigram_query, use_regex, longest_line) {
					TrigramProbe::Miss => {}
					TrigramProbe::MetadataMismatch => {
						logs.push(format!(
							"folder-service: search passed over {} ({}): Manifest does not match its entry",
							entry_path,
							entry.version_string()
						));
						unreadable += 1;
						continue;
					}
					TrigramProbe::Binary => {
						record_read(entry, entry_idx, &mut state, &mut read_indices, &mut read_ranges);
						binary += 1;
						continue;
					}
					TrigramProbe::Skip { extra_long_lines } => {
						record_read(entry, entry_idx, &mut state, &mut read_indices, &mut read_ranges);
						long_lines += extra_long_lines;
						searched += 1;
						continue;
					}
					TrigramProbe::MaybeMatch => {
						already_indexed = true;
					}
				}
			}
		}

		let manifest = match index.load_manifest(profile_id, profile_uuid, entry) {
			Ok(m) => m,
			Err(ObjectError::Unavailable(msg)) => return Err(WorkerError::simple("unavailable", msg)),
			Err(err) => {
				logs.push(format!(
					"folder-service: search passed over {} ({}): {}",
					entry_path,
					entry.version_string(),
					err.message()
				));
				unreadable += 1;
				continue;
			}
		};

		let mut offset: u64 = resume.map_or(0, |r| r.offset);
		let mut line: u64 = resume.map_or(0, |r| r.line);
		let mut line_start: u64 = offset;
		let floor: i64 = if state.examined == 1 { offset as i64 } else { -1 };
		let continued = resume.is_some_and(|r| r.offset > 0 || r.line > 0);
		let mut carry: Vec<u8> = Vec::new();
		let mut long = false;
		let mut line_hit = false;
		let mut unsearched = false;
		let mut head = String::new();
		let mut started = false;
		let mut skipped = false;
		let mut count: u64 = 0;
		let mut ring: VecDeque<ContextLine> = VecDeque::with_capacity(context + 1);
		let mut open_hit_idx: Option<usize> = None;
		let mut wanted: usize = 0;
		let mut builder: Option<TrigramBuilder> =
			if offset == 0 && piece_bytes >= BINARY_PROBE && !already_indexed && manifest_sha.is_some() {
				Some(TrigramBuilder::new(entry_bytes))
			} else {
				None
			};

		loop {
			let piece = match read_manifest_slice(index, profile_id, profile_uuid, &manifest, offset, piece_bytes) {
				Ok(p) => p,
				Err(ObjectError::Unavailable(msg)) => return Err(WorkerError::simple("unavailable", msg)),
				Err(err) => {
					logs.push(format!(
						"folder-service: search passed over {} ({}): {}",
						entry_path,
						entry.version_string(),
						err.message()
					));
					unreadable += 1;
					skipped = true;
					builder = None;
					break;
				}
			};
			if !started {
				started = true;
				record_read(entry, entry_idx, &mut state, &mut read_indices, &mut read_ranges);
				if offset == 0 && piece[..piece.len().min(BINARY_PROBE)].contains(&0) {
					if piece_bytes >= BINARY_PROBE {
						if let Some(m_sha) = manifest_sha {
							index.put_trigram(
								profile_uuid,
								m_sha,
								IndexedEntry::Binary { meta: ManifestMeta::from_manifest(&manifest, &index.media) },
							);
						}
					}
					binary += 1;
					skipped = true;
					builder = None;
					break;
				}
			}
			let end = offset + piece.len() as u64;
			let last = end >= entry_bytes || piece.is_empty();
			if let Some(b) = builder.as_mut() {
				b.push_raw_chunk(&piece, last);
			}
			let bytes: Vec<u8> = if carry.is_empty() {
				piece
			} else {
				let mut merged = Vec::with_capacity(carry.len() + piece.len());
				merged.extend_from_slice(&carry);
				merged.extend_from_slice(&piece);
				merged
			};
			let base = offset - carry.len() as u64;
			let cut_at = bytes.iter().rposition(|&b| b == b'\n').map_or(0, |p| p + 1);
			let whole = &bytes[..cut_at];

			if cut_at > 0 && !line_hit && !long && wanted == 0 && !matcher.chunk_has_match(whole, &mut scratch) {
				let mut from_pos = 0usize;
				while let Some(rel) = whole[from_pos..].iter().position(|&b| b == b'\n') {
					let nl = from_pos + rel;
					if use_regex && nl - from_pos > longest_line {
						long_lines += 1;
					}
					line += 1;
					from_pos = nl + 1;
				}
				if context > 0 {
					let mut tail: Vec<ContextLine> = Vec::with_capacity(context);
					let mut stop = cut_at - 1;
					while tail.len() < context {
						let begin = if stop == 0 {
							0
						} else {
							whole[..stop].iter().rposition(|&b| b == b'\n').map_or(0, |p| p + 1)
						};
						tail.push(ContextLine { text: context_text(&whole[begin..stop]), start: base + begin as u64 });
						if begin == 0 {
							break;
						}
						stop = begin - 1;
					}
					for item in tail.into_iter().rev() {
						ring.push_back(item);
						if ring.len() > context {
							ring.pop_front();
						}
					}
				}
				line_start = base + cut_at as u64;
			} else {
				let mut start = 0usize;
				while start < cut_at {
					let Some(rel) = bytes[start..cut_at].iter().position(|&b| b == b'\n') else {
						break;
					};
					let stop = start + rel;
					let line_bytes = &bytes[start..stop];
					if use_regex && !unsearched && line_bytes.len() > longest_line {
						unsearched = true;
						long_lines += 1;
					}
					if !line_hit && !unsearched && (!line_bytes.is_empty() || use_regex) {
						let text_line = String::from_utf8_lossy(line_bytes);
						if let Some(found) = matcher.find_str(&text_line, &mut scratch) {
							line_hit = true;
							if files_only {
								count += 1;
							} else {
								let shown = SearchHit {
									path: entry_path.to_string(),
									kind: "file".to_string(),
									line: line + 1,
									text: around(&text_line, found, req.case_sensitive),
									version: entry.version_string(),
									offset: line_start,
									target: None,
									before: if context > 0 {
										Some(ring.iter().map(|r| r.text.clone()).collect())
									} else {
										None
									},
									after: if context > 0 { Some(Vec::new()) } else { None },
									from: if context > 0 {
										Some(ring.front().map_or(line_start, |r| r.start))
									} else {
										None
									},
								};
								if !push_hit(shown, &mut state, &mut hits) {
									let cursor = match ring.front() {
										Some(first) => at_cursor(entry, first.start, line - ring.len() as u64),
										None => at_cursor(entry, line_start, line),
									};
									if count > 0 {
										files.push(SearchFile {
											path: entry_path.to_string(),
											version: entry.version_string(),
											count,
											partial: Some(true),
										});
									}
									return Ok(WorkerOk {
										hits,
										files,
										searched,
										binary,
										unreadable,
										long_lines,
										read_indices,
										read_ranges,
										logs,
										next: Some(cursor),
										done: true,
										state,
									});
								}
								if context > 0 {
									ring.clear();
									open_hit_idx = Some(hits.len() - 1);
									wanted = context;
								}
							}
						}
					}
					if !line_hit && context > 0 {
						let line_text = if long { head.clone() } else { context_text(line_bytes) };
						if let Some(idx) = open_hit_idx.filter(|_| wanted > 0) {
							state.hit_bytes += shown_line(&hits[idx].path, line + 1, &line_text);
							hits[idx].after.as_mut().unwrap().push(line_text);
							wanted -= 1;
						} else {
							ring.push_back(ContextLine { text: line_text, start: line_start });
							if ring.len() > context {
								ring.pop_front();
							}
						}
					}
					line += 1;
					line_start = base + stop as u64 + 1;
					long = false;
					line_hit = false;
					unsearched = false;
					start = stop + 1;
				}
			}

			let rest = &bytes[cut_at..];
			if last {
				if !rest.is_empty() {
					if use_regex && !unsearched && rest.len() > longest_line {
						unsearched = true;
						long_lines += 1;
					}
					if !line_hit && !unsearched {
						let text_line = String::from_utf8_lossy(rest);
						if let Some(found) = matcher.find_str(&text_line, &mut scratch) {
							line_hit = true;
							if files_only {
								count += 1;
							} else {
								let shown = SearchHit {
									path: entry_path.to_string(),
									kind: "file".to_string(),
									line: line + 1,
									text: around(&text_line, found, req.case_sensitive),
									version: entry.version_string(),
									offset: line_start,
									target: None,
									before: if context > 0 {
										Some(ring.iter().map(|r| r.text.clone()).collect())
									} else {
										None
									},
									after: if context > 0 { Some(Vec::new()) } else { None },
									from: if context > 0 {
										Some(ring.front().map_or(line_start, |r| r.start))
									} else {
										None
									},
								};
								if !push_hit(shown, &mut state, &mut hits) {
									let cursor = match ring.front() {
										Some(first) => at_cursor(entry, first.start, line - ring.len() as u64),
										None => at_cursor(entry, line_start, line),
									};
									if count > 0 {
										files.push(SearchFile {
											path: entry_path.to_string(),
											version: entry.version_string(),
											count,
											partial: Some(true),
										});
									}
									return Ok(WorkerOk {
										hits,
										files,
										searched,
										binary,
										unreadable,
										long_lines,
										read_indices,
										read_ranges,
										logs,
										next: Some(cursor),
										done: true,
										state,
									});
								}
							}
						}
					}
					if !line_hit && context > 0 {
						if let Some(idx) = open_hit_idx.filter(|_| wanted > 0) {
							let line_text = if long { head.clone() } else { context_text(rest) };
							state.hit_bytes += shown_line(&hits[idx].path, line + 1, &line_text);
							hits[idx].after.as_mut().unwrap().push(line_text);
						}
					}
				}
				break;
			}

			if rest.len() >= longest_line + usize::from(use_regex) {
				let whole_len = whole_utf8(rest);
				if !long && context > 0 {
					head = context_text(&rest[..whole_len]);
				}
				long = true;
				if use_regex {
					if !unsearched && rest.len() > longest_line {
						unsearched = true;
						long_lines += 1;
					}
					carry = Vec::new();
				} else {
					if !line_hit && !unsearched && whole_len > 0 {
						let text_line = String::from_utf8_lossy(&rest[..whole_len]);
						if let Some(found) = matcher.find_str(&text_line, &mut scratch) {
							line_hit = true;
							if files_only {
								count += 1;
							} else {
								let shown = SearchHit {
									path: entry_path.to_string(),
									kind: "file".to_string(),
									line: line + 1,
									text: around(&text_line, found, req.case_sensitive),
									version: entry.version_string(),
									offset: line_start,
									target: None,
									before: if context > 0 {
										Some(ring.iter().map(|r| r.text.clone()).collect())
									} else {
										None
									},
									after: if context > 0 { Some(Vec::new()) } else { None },
									from: if context > 0 {
										Some(ring.front().map_or(line_start, |r| r.start))
									} else {
										None
									},
								};
								if !push_hit(shown, &mut state, &mut hits) {
									let cursor = match ring.front() {
										Some(first) => at_cursor(entry, first.start, line - ring.len() as u64),
										None => at_cursor(entry, line_start, line),
									};
									if count > 0 {
										files.push(SearchFile {
											path: entry_path.to_string(),
											version: entry.version_string(),
											count,
											partial: Some(true),
										});
									}
									return Ok(WorkerOk {
										hits,
										files,
										searched,
										binary,
										unreadable,
										long_lines,
										read_indices,
										read_ranges,
										logs,
										next: Some(cursor),
										done: true,
										state,
									});
								}
								if context > 0 {
									ring.clear();
									open_hit_idx = Some(hits.len() - 1);
									wanted = context;
								}
							}
						}
					}
					let mut keep = whole_len.saturating_sub(overlap);
					while keep < whole_len && (rest[keep] & 0xc0) == 0x80 {
						keep += 1;
					}
					carry = rest[keep..].to_vec();
				}
			} else {
				carry = rest.to_vec();
			}
			offset = end;
			let resume_start = ring.front().map_or(line_start, |r| r.start) as i64;
			if !long && cut_at > 0 && wanted == 0 && resume_start > floor && Instant::now() >= deadline {
				let cursor = match ring.front() {
					Some(first) => at_cursor(entry, first.start, line - ring.len() as u64),
					None => at_cursor(entry, line_start, line),
				};
				if count > 0 {
					files.push(SearchFile {
						path: entry_path.to_string(),
						version: entry.version_string(),
						count,
						partial: Some(true),
					});
				}
				return Ok(WorkerOk {
					hits,
					files,
					searched,
					binary,
					unreadable,
					long_lines,
					read_indices,
					read_ranges,
					logs,
					next: Some(cursor),
					done: true,
					state,
				});
			}
		}

		if let (Some(m_sha), Some(b)) = (manifest_sha, builder) {
			if !skipped {
				index.put_trigram(profile_uuid, m_sha, b.finish(ManifestMeta::from_manifest(&manifest, &index.media)));
			}
		}

		if count > 0 || (files_only && continued && !skipped) {
			files.push(SearchFile {
				path: entry_path.to_string(),
				version: entry.version_string(),
				count,
				partial: None,
			});
			state.hit_bytes += shown_line(entry_path, count, "");
		}
		if !skipped {
			searched += 1;
		}
	}

	Ok(WorkerOk {
		hits,
		files,
		searched,
		binary,
		unreadable,
		long_lines,
		read_indices,
		read_ranges,
		logs,
		next: None,
		done: use_ranges,
		state,
	})
}

fn read_frame<R: Read>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
	let mut head = [0u8; 4];
	let mut got = 0usize;
	while got < 4 {
		match reader.read(&mut head[got..]) {
			Ok(0) => {
				if got == 0 {
					return Ok(None);
				}
				return Err(io::Error::new(ErrorKind::UnexpectedEof, "truncated frame header"));
			}
			Ok(n) => got += n,
			Err(e) if e.kind() == ErrorKind::Interrupted => continue,
			Err(e) => return Err(e),
		}
	}
	let len = u32::from_be_bytes(head) as usize;
	if len == 0 || len > MAX_FRAME_BYTES {
		return Err(io::Error::new(ErrorKind::InvalidData, "invalid frame length"));
	}
	let mut buf = vec![0u8; len];
	reader.read_exact(&mut buf)?;
	Ok(Some(buf))
}

fn write_frame<W: Write>(writer: &mut W, payload: &[u8]) -> io::Result<()> {
	let len = u32::try_from(payload.len())
		.map_err(|_| io::Error::new(ErrorKind::InvalidData, "response exceeds frame limit"))?;
	writer.write_all(&len.to_be_bytes())?;
	writer.write_all(payload)?;
	writer.flush()
}

struct SearchJob {
	req: WorkerRequest,
	synced_tree: Option<Arc<CompactTree>>,
}

struct JobQueue {
	queue: Mutex<(VecDeque<SearchJob>, bool)>,
	ready: Condvar,
}

impl JobQueue {
	fn new() -> Self {
		Self { queue: Mutex::new((VecDeque::new(), false)), ready: Condvar::new() }
	}

	fn push(&self, job: SearchJob) {
		let mut guard = self.queue.lock().unwrap();
		guard.0.push_back(job);
		self.ready.notify_one();
	}

	fn pop(&self) -> Option<SearchJob> {
		let mut guard = self.queue.lock().unwrap();
		loop {
			if let Some(job) = guard.0.pop_front() {
				return Some(job);
			}
			if guard.1 {
				return None;
			}
			guard = self.ready.wait(guard).unwrap();
		}
	}

	fn close(&self) {
		let mut guard = self.queue.lock().unwrap();
		guard.1 = true;
		self.ready.notify_all();
	}
}

pub fn run_worker_io<R: Read, W: Write + Send + 'static>(
	storage_root: PathBuf,
	index_mib: usize,
	threads: usize,
	mut reader: R,
	writer: W,
) -> Result<(), String> {
	let index = Arc::new(SharedIndex::new(storage_root, index_mib));
	let queue = Arc::new(JobQueue::new());
	let out = Arc::new(Mutex::new(BufWriter::new(writer)));
	let mut handles = Vec::with_capacity(threads);
	for _ in 0..threads {
		let idx = index.clone();
		let q = queue.clone();
		let w = out.clone();
		handles.push(std::thread::spawn(move || {
			while let Some(job) = q.pop() {
				let id = job.req.id;
				let resp = match execute_search_with_tree(&idx, &job.req, job.synced_tree) {
					Ok(ok) => WorkerResponse { id, synced: None, ok: Some(ok), error: None },
					Err(error) => WorkerResponse { id, synced: None, ok: None, error: Some(error) },
				};
				let payload = serde_json::to_vec(&resp).expect("search response serializes");
				let mut guard = w.lock().unwrap();
				if write_frame(&mut *guard, &payload).is_err() {
					break;
				}
			}
		}));
	}
	let mut read_err: Option<String> = None;
	loop {
		match read_frame(&mut reader) {
			Ok(None) => break,
			Ok(Some(bytes)) => match parse_worker_message(&bytes) {
				Ok(WorkerMessage::SyncTree(msg)) => {
					let resp = if index.sync_tree(msg.snapshot_id, msg.entries, msg.append, msg.complete) {
						WorkerResponse { id: msg.id, synced: Some(true), ok: None, error: None }
					} else {
						WorkerResponse {
							id: msg.id,
							synced: None,
							ok: None,
							error: Some(WorkerError::simple("missing_tree", "Synced tree snapshot not found")),
						}
					};
					let payload = serde_json::to_vec(&resp).expect("sync response serializes");
					let mut guard = out.lock().unwrap();
					if write_frame(&mut *guard, &payload).is_err() {
						break;
					}
				}
				Ok(WorkerMessage::PatchTree(msg)) => {
					let resp = if index.patch_tree(msg.base_snapshot_id, msg.snapshot_id, msg.upserts, msg.removes) {
						WorkerResponse { id: msg.id, synced: Some(true), ok: None, error: None }
					} else {
						WorkerResponse {
							id: msg.id,
							synced: None,
							ok: None,
							error: Some(WorkerError::simple("missing_tree", "Base snapshot not found")),
						}
					};
					let payload = serde_json::to_vec(&resp).expect("patch response serializes");
					let mut guard = out.lock().unwrap();
					if write_frame(&mut *guard, &payload).is_err() {
						break;
					}
				}
				Ok(WorkerMessage::DropTree(msg)) => {
					index.drop_tree(msg.snapshot_id);
					if msg.id != 0 {
						let resp = WorkerResponse { id: msg.id, synced: Some(true), ok: None, error: None };
						let payload = serde_json::to_vec(&resp).expect("drop response serializes");
						let mut guard = out.lock().unwrap();
						if write_frame(&mut *guard, &payload).is_err() {
							break;
						}
					}
				}
				Ok(WorkerMessage::Search(req)) => {
					// WHY: resolve the snapshot Arc synchronously on the reader thread so a subsequent dropTree never races a queued search.
					let synced_tree = req.snapshot_id.and_then(|sid| index.get_tree(sid));
					queue.push(SearchJob { req, synced_tree });
				}
				Err(e) => {
					read_err = Some(format!("bad search request json: {e}"));
					break;
				}
			},
			Err(e) => {
				read_err = Some(format!("search worker stdin failed: {e}"));
				break;
			}
		}
	}
	queue.close();
	for h in handles {
		let _ = h.join();
	}
	match read_err {
		Some(e) => Err(e),
		None => Ok(()),
	}
}

fn clear_nonblock(fd: libc::c_int) -> io::Result<()> {
	// SAFETY: fcntl F_GETFL inspects descriptor flags without dereferencing memory.
	let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
	if flags < 0 {
		return Err(io::Error::last_os_error());
	}
	if (flags & libc::O_NONBLOCK) != 0 {
		// SAFETY: clearing O_NONBLOCK on an open pipe descriptor ensures blocking reads/writes.
		if unsafe { libc::fcntl(fd, libc::F_SETFL, flags & !libc::O_NONBLOCK) } < 0 {
			return Err(io::Error::last_os_error());
		}
	}
	Ok(())
}

pub fn run_worker(storage_root: &Path, index_mib: usize, threads: usize) -> Result<(), String> {
	if !storage_root.is_dir() {
		return Err(format!("storage root {} is not a directory", storage_root.display()));
	}
	clear_nonblock(libc::STDIN_FILENO).map_err(|_| "stdin flags could not be updated".to_string())?;
	clear_nonblock(libc::STDOUT_FILENO).map_err(|_| "stdout flags could not be updated".to_string())?;
	let stdin = io::stdin();
	let stdout = io::stdout();
	run_worker_io(storage_root.to_path_buf(), index_mib, threads, stdin.lock(), stdout)
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::fs;
	use std::io::Cursor;

	const TEST_PROFILE: &str = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";

	fn hex_sha256(bytes: &[u8]) -> String {
		let d = Sha256::digest(bytes);
		let mut s = String::with_capacity(64);
		for b in d {
			use std::fmt::Write as _;
			let _ = write!(&mut s, "{b:02x}");
		}
		s
	}

	fn temp_dir(label: &str) -> PathBuf {
		let dir = std::env::temp_dir().join(format!(
			"qorpera-search-test-{}-{}-{}",
			label,
			std::process::id(),
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.unwrap()
				.as_nanos()
		));
		fs::create_dir_all(dir.join(TEST_PROFILE)).unwrap();
		dir
	}

	fn write_object_file(root: &Path, path: &str, version: &str, content: &[u8], chunk_size: usize, idx: u32) -> WorkerEntry {
		let profile_dir = root.join(TEST_PROFILE);
		let mut chunks = Vec::new();
		let mut off = 0usize;
		while off < content.len() {
			let end = (off + chunk_size).min(content.len());
			let slice = &content[off..end];
			let sha = hex_sha256(slice);
			fs::write(profile_dir.join(&sha), slice).unwrap();
			chunks.push(serde_json::json!({ "sha256": sha, "bytes": slice.len() }));
			off = end;
		}
		let file_sha = hex_sha256(content);
		let manifest = serde_json::json!({
			"schema": "qorpera.cloud-file-manifest/v2",
			"fileSha256": file_sha,
			"bytes": content.len(),
			"mediaType": "text/plain",
			"executable": false,
			"chunks": chunks,
		})
		.to_string();
		let manifest_sha = hex_sha256(manifest.as_bytes());
		fs::write(profile_dir.join(&manifest_sha), manifest.as_bytes()).unwrap();
		WorkerEntry {
			i: idx,
			k: 0,
			p: path.to_string(),
			v: version.to_string(),
			m: Some(manifest_sha),
			f: Some(file_sha),
			b: content.len() as u64,
			t: Some("text/plain".to_string()),
			x: false,
			tg: None,
			rb: 120 + path.len(),
			gm: true,
		}
	}

	fn base_request(entries: Vec<WorkerEntry>, query: Option<&str>) -> WorkerRequest {
		WorkerRequest {
			id: 1,
			snapshot_id: None,
			profile_id: Some(TEST_PROFILE.to_string()),
			version: 2,
			query: query.map(str::to_string),
			regex: false,
			path: String::new(),
			glob: None,
			names_only: false,
			files_only: false,
			case_sensitive: false,
			context: 0,
			links: true,
			after: None,
			slice_ms: 2_000,
			longest_line: None,
			piece_bytes: None,
			state: PageState::default(),
			entries,
		}
	}

	#[test]
	fn trigram_index_preserves_reads_provenance_and_skips_disk_on_warm_misses() {
		let dir = temp_dir("warm");
		let e0 = write_object_file(&dir, "a.md", "00000000-0000-4000-8000-000000000001", b"alpha beta gamma\n", 1024, 0);
		let e1 = write_object_file(&dir, "b.md", "00000000-0000-4000-8000-000000000002", b"delta epsilon zeta\n", 1024, 1);
		let e2 = write_object_file(&dir, "bin.dat", "00000000-0000-4000-8000-000000000003", b"alpha\0binary", 1024, 2);
		let index = SharedIndex::new(dir.clone(), 8);

		let r1 = execute_search(&index, &base_request(vec![e0.clone(), e1.clone(), e2.clone()], Some("alpha"))).unwrap();
		assert_eq!(r1.hits.len(), 1);
		assert_eq!(r1.hits[0].path, "a.md");
		assert_eq!(r1.searched, 2);
		assert_eq!(r1.binary, 1);
		assert_eq!(r1.read_indices, vec![0, 1, 2]);
		assert_eq!(index.trigrams.total_entries(), 3);

		let r2 = execute_search(&index, &base_request(vec![e0.clone(), e1.clone(), e2.clone()], Some("nonexistent_token"))).unwrap();
		assert!(r2.hits.is_empty());
		assert_eq!(r2.searched, 2);
		assert_eq!(r2.binary, 1);
		assert_eq!(r2.read_indices, vec![0, 1, 2]);

		let mut re_req = base_request(vec![e0, e1, e2], Some("eps[a-z]+\\s+zeta"));
		re_req.regex = true;
		let r3 = execute_search(&index, &re_req).unwrap();
		assert_eq!(r3.hits.len(), 1);
		assert_eq!(r3.hits[0].path, "b.md");
		assert_eq!(r3.read_indices, vec![0, 1, 2]);

		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn lru_eviction_respects_index_mib_budget() {
		let dir = temp_dir("evict");
		let index = SharedIndex::new(dir.clone(), 1);
		let mut entries = Vec::new();
		for i in 0..400u32 {
			let body = format!("file_{i:04}_content_{}_end\n", "abcdefghij".repeat(60));
			entries.push(write_object_file(
				&dir,
				&format!("f{i:04}.txt"),
				&format!("00000000-0000-4000-8000-{i:012x}"),
				body.as_bytes(),
				4096,
				i,
			));
		}
		let r = execute_search(&index, &base_request(entries, Some("file_0399_content"))).unwrap();
		assert_eq!(r.hits.len(), 1);
		assert!(index.trigrams.total_bytes() <= (1024 * 1024 * 25) / 100 + 65536);
		assert!(index.objects.total_bytes() <= (1024 * 1024 * 10) / 100 + 65536);
		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn handles_context_files_only_long_lines_unreadable_and_missing_profile() {
		let dir = temp_dir("parity");
		let text = (1..=14)
			.map(|i| if [4, 5, 10].contains(&i) { format!("line {i} plan") } else { format!("line {i}") })
			.collect::<Vec<_>>()
			.join("\n")
			+ "\n";
		let e0 = write_object_file(&dir, "a.md", "00000000-0000-4000-8000-000000000001", text.as_bytes(), 16, 0);
		let index = SharedIndex::new(dir.clone(), 8);

		let mut ctx_req = base_request(vec![e0.clone()], Some("plan"));
		ctx_req.context = 2;
		ctx_req.piece_bytes = Some(16);
		let r = execute_search(&index, &ctx_req).unwrap();
		assert_eq!(r.hits.len(), 3);
		assert_eq!(r.hits[0].before.as_deref(), Some(&["line 2".to_string(), "line 3".to_string()][..]));
		assert_eq!(r.hits[0].after.as_deref(), Some(&[][..]));
		assert_eq!(r.hits[1].before.as_deref(), Some(&[][..]));
		assert_eq!(r.hits[1].after.as_deref(), Some(&["line 6".to_string(), "line 7".to_string()][..]));
		assert_eq!(r.hits[2].before.as_deref(), Some(&["line 8".to_string(), "line 9".to_string()][..]));
		assert_eq!(r.hits[2].after.as_deref(), Some(&["line 11".to_string(), "line 12".to_string()][..]));

		let long_content = format!("{}\n{}\nb\n{}", "x".repeat(41), "x".repeat(40), "x".repeat(41));
		let e_long = write_object_file(
			&dir,
			"long.txt",
			"00000000-0000-4000-8000-000000000002",
			long_content.as_bytes(),
			16,
			0,
		);
		let mut long_req = base_request(vec![e_long.clone()], Some("^x+$"));
		long_req.regex = true;
		long_req.longest_line = Some(40);
		long_req.piece_bytes = Some(16);
		let r_long = execute_search(&index, &long_req).unwrap();
		assert_eq!(r_long.hits.iter().map(|h| h.line).collect::<Vec<_>>(), vec![2]);
		assert_eq!(r_long.long_lines, 2);

		let mut none_long_req = base_request(vec![e_long], Some("^zzz_no_match$"));
		none_long_req.regex = true;
		none_long_req.longest_line = Some(40);
		let r_none_long = execute_search(&index, &none_long_req).unwrap();
		assert!(r_none_long.hits.is_empty());
		assert_eq!(r_none_long.long_lines, 2);

		let mut tampered = write_object_file(&dir, "bad.md", "00000000-0000-4000-8000-000000000003", b"hello plan\n", 1024, 0);
		fs::write(dir.join(TEST_PROFILE).join(tampered.m.as_ref().unwrap()), b"corrupt").unwrap();
		tampered.i = 0;
		let mut good_entry = e0;
		good_entry.i = 1;
		let r_bad = execute_search(&index, &base_request(vec![tampered, good_entry], Some("plan"))).unwrap();
		assert_eq!(r_bad.unreadable, 1);
		assert_eq!(r_bad.searched, 1);
		assert_eq!(r_bad.logs.len(), 1);
		assert_eq!(r_bad.read_indices, vec![1]);

		fs::remove_dir_all(dir.join(TEST_PROFILE)).unwrap();
		let e_gone = WorkerEntry {
			i: 0,
			k: 0,
			p: "a.md".to_string(),
			v: "00000000-0000-4000-8000-000000000001".to_string(),
			m: Some("a".repeat(64)),
			f: Some("b".repeat(64)),
			b: 10,
			t: Some("text/plain".to_string()),
			x: false,
			tg: None,
			rb: 120,
			gm: true,
		};
		let err = execute_search(&index, &base_request(vec![e_gone], Some("plan"))).unwrap_err();
		assert_eq!(err.kind, "unavailable");

		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn worker_io_multiplexes_concurrent_requests_over_length_prefixed_frames() {
		let dir = temp_dir("mux");
		let e0 = write_object_file(&dir, "one.rs", "00000000-0000-4000-8000-000000000001", b"fn alpha() {}\n", 1024, 0);
		let e1 = write_object_file(&dir, "two.rs", "00000000-0000-4000-8000-000000000002", b"fn beta() {}\n", 1024, 1);
		let mut input = Vec::new();
		for (id, q) in [(1u64, "alpha"), (2, "beta"), (3, "fn\\s+\\w+"), (4, "(a)\\1")] {
			let payload = serde_json::json!({
				"id": id,
				"profileId": TEST_PROFILE,
				"version": 2,
				"query": q,
				"regex": id >= 3,
				"path": "",
				"namesOnly": false,
				"filesOnly": false,
				"caseSensitive": false,
				"context": 0,
				"links": true,
				"after": null,
				"sliceMs": 2000,
				"entries": [
					{ "i": 0, "k": 0, "p": e0.p, "v": e0.v, "m": e0.m, "f": e0.f, "b": e0.b, "t": e0.t, "x": false, "rb": 120, "gm": true },
					{ "i": 1, "k": 0, "p": e1.p, "v": e1.v, "m": e1.m, "f": e1.f, "b": e1.b, "t": e1.t, "x": false, "rb": 120, "gm": true },
				]
			})
			.to_string();
			input.extend_from_slice(&(payload.len() as u32).to_be_bytes());
			input.extend_from_slice(payload.as_bytes());
		}

		let (tx_writer, mut rx_reader) = pipe_buffer();
		run_worker_io(dir.clone(), 8, 4, Cursor::new(input), tx_writer).unwrap();
		let mut by_id: HashMap<u64, serde_json::Value> = HashMap::new();
		while let Some(frame) = read_frame(&mut rx_reader).unwrap() {
			let v: serde_json::Value = serde_json::from_slice(&frame).unwrap();
			by_id.insert(v["id"].as_u64().unwrap(), v);
		}
		assert_eq!(by_id.len(), 4);
		assert_eq!(by_id[&1]["ok"]["hits"][0]["path"], "one.rs");
		assert_eq!(by_id[&2]["ok"]["hits"][0]["path"], "two.rs");
		assert_eq!(by_id[&3]["ok"]["hits"].as_array().unwrap().len(), 2);
		assert_eq!(by_id[&4]["error"]["kind"], "pattern");
		assert!(by_id[&4]["error"]["message"].as_str().unwrap().starts_with("REGEX_BACKREFERENCE: "));

		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn synced_tree_supports_slice_glob_read_ranges_need_profile_and_drop() {
		let dir = temp_dir("synced");
		let folder_entry = |i: u32, p: &str, v: &str| WorkerEntry {
			i,
			k: 1,
			p: p.to_string(),
			v: v.to_string(),
			m: None,
			f: None,
			b: 0,
			t: None,
			x: false,
			tg: None,
			rb: if v.is_empty() { 0 } else { 100 },
			gm: false,
		};
		let entries = vec![
			folder_entry(0, "", ""),
			folder_entry(1, "docs", "00000000-0000-4000-8000-000000000010"),
			write_object_file(&dir, "docs/a.md", "00000000-0000-4000-8000-000000000011", b"needle one\n", 1024, 2),
			write_object_file(&dir, "docs/b.ts", "00000000-0000-4000-8000-000000000012", b"needle two\n", 1024, 3),
			folder_entry(4, "docs-other", "00000000-0000-4000-8000-000000000013"),
			write_object_file(&dir, "docs-other/c.ts", "00000000-0000-4000-8000-000000000014", b"needle three\n", 1024, 5),
		];
		let media = MediaInterner::new();
		let compact = CompactTree::from_wire(&entries, &media);
		assert_eq!(tree_order("docs/b.ts", "docs-other"), Ordering::Less);
		assert_eq!(slice_tree(&compact, "docs", None), 1..4);
		let sub_range = slice_tree(&compact, "docs", Some("docs/b.ts"));
		assert_eq!(sub_range, 3..4);
		assert_eq!(compact.path(sub_range.start), "docs/b.ts");
		let g = CompiledGlob::parse("**/*.ts");
		assert!(!g.matches_entry("docs/a.md", ""));
		assert!(g.matches_entry("docs/b.ts", ""));
		assert!(g.matches_entry("docs/b.ts", "docs"));

		let index = SharedIndex::new(dir.clone(), 8);
		assert!(!index.sync_tree(999, entries[..1].to_vec(), true, true));
		assert!(index.sync_tree(42, entries[..3].to_vec(), false, false));
		assert!(index.sync_tree(42, entries[3..].to_vec(), true, true));

		let mut need_prof = base_request(Vec::new(), Some("needle"));
		need_prof.snapshot_id = Some(42);
		need_prof.profile_id = None;
		let err = execute_search(&index, &need_prof).unwrap_err();
		assert_eq!(err.kind, "need_profile");
		assert_eq!(err.entry_index, Some(2));

		let mut req = base_request(Vec::new(), Some("needle"));
		req.snapshot_id = Some(42);
		req.glob = Some("*.ts".to_string());
		let ok = execute_search(&index, &req).unwrap();
		assert_eq!(ok.hits.iter().map(|h| h.path.as_str()).collect::<Vec<_>>(), vec!["docs/b.ts", "docs-other/c.ts"]);
		assert_eq!(ok.read_ranges, vec![1, 1, 3, 3]);
		assert!(ok.read_indices.is_empty());

		let added = write_object_file(
			&dir,
			"docs/a2.ts",
			"00000000-0000-4000-8000-000000000015",
			b"needle patched\n",
			1024,
			0,
		);
		assert!(!index.patch_tree(999, 43, vec![added.clone()], vec![]));
		assert!(index.patch_tree(42, 43, vec![added], vec!["docs/b.ts".to_string()]));
		let mut patched_req = base_request(Vec::new(), Some("needle"));
		patched_req.snapshot_id = Some(43);
		patched_req.glob = Some("*.ts".to_string());
		let patched_ok = execute_search(&index, &patched_req).unwrap();
		assert_eq!(
			patched_ok.hits.iter().map(|h| h.path.as_str()).collect::<Vec<_>>(),
			vec!["docs/a2.ts", "docs-other/c.ts"]
		);
		assert_eq!(patched_ok.read_ranges, vec![1, 1, 3, 3]);

		index.drop_tree(42);
		let missing = execute_search(&index, &req).unwrap_err();
		assert_eq!(missing.kind, "missing_tree");

		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn reader_thread_resolves_snapshot_before_subsequent_drop_tree_and_bounds_tree_budget() {
		let dir = temp_dir("drop-race");
		let e0 = write_object_file(&dir, "a.rs", "00000000-0000-4000-8000-000000000001", b"alpha_one\n", 1024, 0);
		let e1 = write_object_file(&dir, "b.rs", "00000000-0000-4000-8000-000000000002", b"beta_two\n", 1024, 1);

		let mut input = Vec::new();
		let mut push_msg = |v: serde_json::Value| {
			let s = v.to_string();
			input.extend_from_slice(&(s.len() as u32).to_be_bytes());
			input.extend_from_slice(s.as_bytes());
		};
		push_msg(serde_json::json!({
			"op": "syncTree",
			"id": 1,
			"snapshotId": 10,
			"append": false,
			"entries": [
				{ "i": 0, "k": 0, "p": e0.p, "v": e0.v, "m": e0.m, "f": e0.f, "b": e0.b, "t": e0.t, "x": false, "rb": 120 }
			]
		}));
		push_msg(serde_json::json!({
			"op": "search",
			"id": 2,
			"snapshotId": 10,
			"profileId": TEST_PROFILE,
			"version": 2,
			"query": "alpha_one",
			"regex": false,
			"path": "",
			"namesOnly": false,
			"filesOnly": false,
			"caseSensitive": false,
			"context": 0,
			"links": true,
			"after": null,
			"sliceMs": 2000
		}));
		push_msg(serde_json::json!({
			"op": "patchTree",
			"id": 3,
			"baseSnapshotId": 10,
			"snapshotId": 11,
			"upserts": [
				{ "i": 0, "k": 0, "p": e1.p, "v": e1.v, "m": e1.m, "f": e1.f, "b": e1.b, "t": e1.t, "x": false, "rb": 120 }
			],
			"removes": []
		}));
		push_msg(serde_json::json!({ "op": "dropTree", "id": 0, "snapshotId": 10 }));
		push_msg(serde_json::json!({
			"op": "search",
			"id": 4,
			"snapshotId": 11,
			"profileId": TEST_PROFILE,
			"version": 2,
			"query": "beta_two",
			"regex": false,
			"path": "",
			"namesOnly": false,
			"filesOnly": false,
			"caseSensitive": false,
			"context": 0,
			"links": true,
			"after": null,
			"sliceMs": 2000
		}));

		let (tx_writer, mut rx_reader) = pipe_buffer();
		run_worker_io(dir.clone(), 1, 1, Cursor::new(input), tx_writer).unwrap();
		let mut by_id: HashMap<u64, serde_json::Value> = HashMap::new();
		while let Some(frame) = read_frame(&mut rx_reader).unwrap() {
			let v: serde_json::Value = serde_json::from_slice(&frame).unwrap();
			by_id.insert(v["id"].as_u64().unwrap(), v);
		}
		assert_eq!(by_id[&1]["synced"], true);
		assert_eq!(by_id[&2]["ok"]["hits"][0]["path"], "a.rs");
		assert_eq!(by_id[&3]["synced"], true);
		assert_eq!(by_id[&4]["ok"]["hits"][0]["path"], "b.rs");

		let index = SharedIndex::new(dir.clone(), 1);
		let batch: Vec<WorkerEntry> = (0..2_000u32)
			.map(|i| WorkerEntry {
				i,
				k: 1,
				p: format!("folder_{i:04}/nested/subpath"),
				v: format!("00000000-0000-4000-8000-{i:012x}"),
				m: None,
				f: None,
				b: 0,
				t: None,
				x: false,
				tg: None,
				rb: 120,
				gm: false,
			})
			.collect();
		assert!(index.sync_tree(1, batch, false, true));
		let before_bytes = index.trees.total_bytes();
		assert!(before_bytes < 2_000 * 170, "compact tree was {before_bytes} bytes");

		let mut upserts = Vec::new();
		let mut removes = Vec::new();
		for i in 0..256u32 {
			removes.push(format!("folder_{:04}/nested/subpath", i * 4));
			upserts.push(WorkerEntry {
				i: 0,
				k: 1,
				p: format!("folder_{:04}/nested/subpath", i * 4 + 1),
				v: format!("00000000-0000-4000-8000-10000000{i:04x}"),
				m: None,
				f: None,
				b: 0,
				t: None,
				x: false,
				tg: None,
				rb: 120,
				gm: false,
			});
			upserts.push(WorkerEntry {
				i: 0,
				k: 1,
				p: format!("folder_{:04}/nested/added", i * 4 + 2),
				v: format!("00000000-0000-4000-8000-20000000{i:04x}"),
				m: None,
				f: None,
				b: 0,
				t: None,
				x: false,
				tg: None,
				rb: 120,
				gm: false,
			});
		}
		assert!(index.patch_tree(1, 2, upserts, removes));
		let patched = index.get_tree(2).unwrap();
		assert_eq!(patched.len(), 2_000);
		for i in 1..patched.len() {
			assert_eq!(tree_order(patched.path(i - 1), patched.path(i)), Ordering::Less);
		}
		index.drop_tree(1);
		index.drop_tree(2);
		assert_eq!(index.trees.total_bytes(), 0);

		let _ = fs::remove_dir_all(&dir);
	}

	struct SharedBuf(Arc<Mutex<Vec<u8>>>);

	impl Write for SharedBuf {
		fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
			self.0.lock().unwrap().extend_from_slice(buf);
			Ok(buf.len())
		}
		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}

	struct SharedReader {
		buf: Arc<Mutex<Vec<u8>>>,
		pos: usize,
	}

	impl Read for SharedReader {
		fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
			let guard = self.buf.lock().unwrap();
			if self.pos >= guard.len() {
				return Ok(0);
			}
			let n = out.len().min(guard.len() - self.pos);
			out[..n].copy_from_slice(&guard[self.pos..self.pos + n]);
			self.pos += n;
			Ok(n)
		}
	}

	fn pipe_buffer() -> (SharedBuf, SharedReader) {
		let arc = Arc::new(Mutex::new(Vec::new()));
		(SharedBuf(arc.clone()), SharedReader { buf: arc, pos: 0 })
	}
}
