use arc_swap::ArcSwap;
use bytes::Bytes;
use flate2::{write::GzEncoder, Compression};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::broadcast;

pub const DEFAULT_MAX_CACHE_BYTES: usize = 256 * 1024 * 1024;
pub const DEFAULT_MAX_BLOB_BYTES: usize = 100 * 1024 * 1024;
const COMPRESS_MIN_BYTES: usize = 256;
const PRECOMPRESS_MAX_BYTES: usize = 8 * 1024 * 1024;
const BLOCKING_OFFLOAD_THRESHOLD: usize = 16 * 1024;
const CACHE_SHARDS: usize = 64;
const BROTLI_QUALITY: u32 = 6;
const BROTLI_WINDOW: u32 = 22;
const ZSTD_LEVEL: i32 = 9;

static TEMP_FILE_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PutOutcome {
    Stored,
    Exists,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContentEncoding {
    Identity,
    Gzip,
    Brotli,
    Zstd,
}

impl ContentEncoding {
    pub fn header_value(self) -> Option<&'static str> {
        match self {
            ContentEncoding::Identity => None,
            ContentEncoding::Gzip => Some("gzip"),
            ContentEncoding::Brotli => Some("br"),
            ContentEncoding::Zstd => Some("zstd"),
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct AcceptedEncodings {
    pub gzip_q: f32,
    pub br_q: f32,
    pub zstd_q: f32,
}

impl AcceptedEncodings {
    pub const IDENTITY: Self = Self {
        gzip_q: 0.0,
        br_q: 0.0,
        zstd_q: 0.0,
    };

    pub const GZIP_ONLY: Self = Self {
        gzip_q: 1.0,
        br_q: 0.0,
        zstd_q: 0.0,
    };

    pub fn from_header(header: &str) -> Self {
        let mut out = Self::default();
        for part in header.split(',') {
            let mut segments = part.split(';');
            let Some(coding) = segments.next().map(str::trim) else {
                continue;
            };
            if coding.is_empty() {
                continue;
            }
            let mut q = 1.0f32;
            for param in segments {
                let p = param.trim();
                if let Some(val) = p.strip_prefix("q=").or_else(|| p.strip_prefix("Q=")) {
                    if let Ok(parsed) = val.trim().parse::<f32>() {
                        if parsed.is_finite() {
                            q = parsed.clamp(0.0, 1.0);
                        }
                    }
                }
            }
            if coding.eq_ignore_ascii_case("br") {
                out.br_q = q;
            } else if coding.eq_ignore_ascii_case("zstd") {
                out.zstd_q = q;
            } else if coding.eq_ignore_ascii_case("gzip") {
                out.gzip_q = q;
            }
        }
        out
    }
}

#[derive(Debug, Clone)]
pub struct BlobPayload {
    pub bytes: Bytes,
    pub raw_len: usize,
    pub encoding: ContentEncoding,
}

#[derive(Debug)]
pub enum BlobError {
    InvalidHash,
    HashMismatch,
    TooLarge,
    NotFound,
    CorruptOnDisk,
    Io(std::io::Error),
}

impl std::fmt::Display for BlobError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BlobError::InvalidHash => write!(f, "invalid sha256"),
            BlobError::HashMismatch => write!(f, "sha256 mismatch"),
            BlobError::TooLarge => write!(f, "blob exceeds maximum allowed size"),
            BlobError::NotFound => write!(f, "blob not found"),
            BlobError::CorruptOnDisk => write!(f, "blob failed sha256 verification on read"),
            BlobError::Io(err) => write!(f, "io error: {err}"),
        }
    }
}

impl std::error::Error for BlobError {}

impl From<std::io::Error> for BlobError {
    fn from(err: std::io::Error) -> Self {
        if err.kind() == std::io::ErrorKind::NotFound {
            BlobError::NotFound
        } else {
            BlobError::Io(err)
        }
    }
}

pub fn is_valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

#[derive(Clone)]
struct CachedBlob {
    raw: Bytes,
    gzip: Option<Bytes>,
    brotli: Option<Bytes>,
    zstd: Option<Bytes>,
    accounted_bytes: usize,
}

impl CachedBlob {
    fn new(raw: Bytes, gzip: Option<Bytes>, brotli: Option<Bytes>, zstd: Option<Bytes>) -> Self {
        let accounted_bytes = raw.len()
            + gzip.as_ref().map_or(0, Bytes::len)
            + brotli.as_ref().map_or(0, Bytes::len)
            + zstd.as_ref().map_or(0, Bytes::len);
        Self {
            raw,
            gzip,
            brotli,
            zstd,
            accounted_bytes,
        }
    }

    fn to_payload(&self, accepted: AcceptedEncodings) -> BlobPayload {
        let raw_len = self.raw.len();
        let mut best_q = 0.0f32;
        let mut best: Option<(ContentEncoding, &Bytes)> = None;

        if accepted.br_q > best_q {
            if let Some(ref br) = self.brotli {
                best_q = accepted.br_q;
                best = Some((ContentEncoding::Brotli, br));
            }
        }
        if accepted.zstd_q > best_q {
            if let Some(ref zs) = self.zstd {
                best_q = accepted.zstd_q;
                best = Some((ContentEncoding::Zstd, zs));
            }
        }
        if accepted.gzip_q > best_q {
            if let Some(ref gz) = self.gzip {
                best = Some((ContentEncoding::Gzip, gz));
            }
        }

        if let Some((encoding, bytes)) = best {
            return BlobPayload {
                bytes: bytes.clone(),
                raw_len,
                encoding,
            };
        }
        BlobPayload {
            bytes: self.raw.clone(),
            raw_len,
            encoding: ContentEncoding::Identity,
        }
    }
}

struct SieveEntry {
    value: CachedBlob,
    visited: AtomicBool,
}

struct SieveNode {
    key: String,
    entry: Arc<SieveEntry>,
    prev: Option<usize>,
    next: Option<usize>,
}

struct SieveShard {
    index: HashMap<String, usize>,
    entries: HashMap<String, Arc<SieveEntry>>,
    nodes: Vec<Option<SieveNode>>,
    free: Vec<usize>,
    head: Option<usize>,
    tail: Option<usize>,
    hand: Option<usize>,
    total_bytes: usize,
    max_bytes: usize,
}

struct WaitFreeShard {
    readable: ArcSwap<HashMap<String, Arc<SieveEntry>>>,
    writer: Mutex<SieveShard>,
}

impl WaitFreeShard {
    fn new(max_bytes: usize) -> Self {
        Self {
            readable: ArcSwap::from_pointee(HashMap::new()),
            writer: Mutex::new(SieveShard::new(max_bytes)),
        }
    }

    #[inline]
    fn contains(&self, key: &str) -> bool {
        self.readable.load().contains_key(key)
    }

    #[inline]
    fn get_wait_free(&self, key: &str, accepted: AcceptedEncodings) -> Option<BlobPayload> {
        let map = self.readable.load();
        let entry = map.get(key)?;
        if !entry.visited.load(Ordering::Relaxed) {
            entry.visited.store(true, Ordering::Relaxed);
        }
        Some(entry.value.to_payload(accepted))
    }

    fn insert(&self, key: String, blob: CachedBlob) {
        if let Ok(mut guard) = self.writer.lock() {
            if guard.insert(key, blob) {
                self.readable.store(Arc::new(guard.entries.clone()));
            }
        }
    }
}

impl SieveShard {
    fn new(max_bytes: usize) -> Self {
        Self {
            index: HashMap::new(),
            entries: HashMap::new(),
            nodes: Vec::new(),
            free: Vec::new(),
            head: None,
            tail: None,
            hand: None,
            total_bytes: 0,
            max_bytes,
        }
    }

    fn detach(&mut self, idx: usize) {
        let (prev, next) = {
            let Some(node) = self.nodes[idx].as_ref() else {
                return;
            };
            (node.prev, node.next)
        };
        if self.hand == Some(idx) {
            self.hand = prev;
        }
        if let Some(p) = prev {
            if let Some(pn) = self.nodes[p].as_mut() {
                pn.next = next;
            }
        } else {
            self.head = next;
        }
        if let Some(n) = next {
            if let Some(nn) = self.nodes[n].as_mut() {
                nn.prev = prev;
            }
        } else {
            self.tail = prev;
        }
        if let Some(node) = self.nodes[idx].as_mut() {
            node.prev = None;
            node.next = None;
        }
    }

    fn push_front(&mut self, idx: usize) {
        let old_head = self.head;
        if let Some(node) = self.nodes[idx].as_mut() {
            node.prev = None;
            node.next = old_head;
        }
        if let Some(h) = old_head {
            if let Some(hn) = self.nodes[h].as_mut() {
                hn.prev = Some(idx);
            }
        } else {
            self.tail = Some(idx);
        }
        self.head = Some(idx);
    }

    fn evict_one(&mut self) -> bool {
        let mut cursor = self.hand.or(self.tail);
        let Some(start) = cursor else {
            return false;
        };
        let mut steps = 0usize;
        let max_steps = self.index.len().saturating_mul(2).saturating_add(2);
        while let Some(idx) = cursor {
            if steps > max_steps {
                cursor = Some(start);
                break;
            }
            steps += 1;
            let (was_visited, prev) = match self.nodes[idx].as_ref() {
                Some(n) => (n.entry.visited.swap(false, Ordering::Relaxed), n.prev),
                None => return false,
            };
            if !was_visited {
                self.hand = prev;
                self.detach(idx);
                if let Some(evicted) = self.nodes[idx].take() {
                    self.index.remove(&evicted.key);
                    self.entries.remove(&evicted.key);
                    self.total_bytes = self
                        .total_bytes
                        .saturating_sub(evicted.entry.value.accounted_bytes);
                }
                self.free.push(idx);
                return true;
            }
            cursor = prev.or(self.tail);
        }
        if let Some(idx) = cursor {
            self.detach(idx);
            if let Some(evicted) = self.nodes[idx].take() {
                self.index.remove(&evicted.key);
                self.entries.remove(&evicted.key);
                self.total_bytes = self
                    .total_bytes
                    .saturating_sub(evicted.entry.value.accounted_bytes);
            }
            self.free.push(idx);
            return true;
        }
        false
    }

    fn insert(&mut self, key: String, blob: CachedBlob) -> bool {
        let accounted = blob.accounted_bytes;
        if self.max_bytes == 0 || accounted > self.max_bytes {
            return false;
        }
        if let Some(existing_idx) = self.index.remove(&key) {
            self.detach(existing_idx);
            self.entries.remove(&key);
            if let Some(old) = self.nodes[existing_idx].take() {
                self.total_bytes = self
                    .total_bytes
                    .saturating_sub(old.entry.value.accounted_bytes);
            }
            self.free.push(existing_idx);
        }
        while self.total_bytes + accounted > self.max_bytes {
            if !self.evict_one() {
                break;
            }
        }
        let entry = Arc::new(SieveEntry {
            value: blob,
            visited: AtomicBool::new(false),
        });
        let node = SieveNode {
            key: key.clone(),
            entry: Arc::clone(&entry),
            prev: None,
            next: None,
        };
        let idx = if let Some(slot) = self.free.pop() {
            self.nodes[slot] = Some(node);
            slot
        } else {
            let slot = self.nodes.len();
            self.nodes.push(Some(node));
            slot
        };
        self.total_bytes += accounted;
        self.index.insert(key.clone(), idx);
        self.entries.insert(key, entry);
        self.push_front(idx);
        true
    }
}

#[derive(Clone)]
enum ReadResult {
    Ok(CachedBlob),
    NotFound,
    Corrupt,
    Io(String),
}

struct InFlightGuard<'a> {
    map: &'a Mutex<HashMap<String, broadcast::Sender<ReadResult>>>,
    key: String,
    completed: bool,
}

impl<'a> InFlightGuard<'a> {
    fn finish(mut self, result: ReadResult) {
        self.completed = true;
        if let Ok(mut guard) = self.map.lock() {
            if let Some(tx) = guard.remove(&self.key) {
                let _ = tx.send(result);
            }
        }
    }
}

impl Drop for InFlightGuard<'_> {
    fn drop(&mut self) {
        if !self.completed {
            if let Ok(mut guard) = self.map.lock() {
                if let Some(tx) = guard.remove(&self.key) {
                    let _ = tx.send(ReadResult::Io("blob_read_cancelled".to_string()));
                }
            }
        }
    }
}

fn hex_nibble(b: u8) -> usize {
    match b {
        b'0'..=b'9' => (b - b'0') as usize,
        b'a'..=b'f' => (b - b'a' + 10) as usize,
        _ => 0,
    }
}

fn shard_for_sha(sha256: &str) -> usize {
    let bytes = sha256.as_bytes();
    let n0 = bytes.first().copied().map_or(0, hex_nibble);
    let n1 = bytes.get(1).copied().map_or(0, hex_nibble);
    ((n0 << 4) | n1) & (CACHE_SHARDS - 1)
}

struct PrecompressedVariants {
    gzip: Option<Bytes>,
    brotli: Option<Bytes>,
    zstd: Option<Bytes>,
}

pub struct BlobStore {
    root: PathBuf,
    max_blob_bytes: usize,
    max_cache_bytes: usize,
    shards: Vec<WaitFreeShard>,
    inflight: Mutex<HashMap<String, broadcast::Sender<ReadResult>>>,
}

impl BlobStore {
    pub fn new(root: PathBuf, max_cache_bytes: usize, max_blob_bytes: usize) -> Self {
        let per_shard = if max_cache_bytes == 0 {
            0
        } else {
            (max_cache_bytes / CACHE_SHARDS).max(1)
        };
        let mut shards = Vec::with_capacity(CACHE_SHARDS);
        for _ in 0..CACHE_SHARDS {
            shards.push(WaitFreeShard::new(per_shard));
        }
        Self {
            root,
            max_blob_bytes,
            max_cache_bytes,
            shards,
            inflight: Mutex::new(HashMap::new()),
        }
    }

    pub fn max_blob_bytes(&self) -> usize {
        self.max_blob_bytes
    }

    fn blob_path(&self, sha256: &str) -> Result<PathBuf, BlobError> {
        if !is_valid_sha256(sha256) {
            return Err(BlobError::InvalidHash);
        }
        Ok(self.root.join(&sha256[0..2]).join(&sha256[2..4]).join(sha256))
    }

    fn sidecar_path(raw_path: &Path, ext: &str) -> PathBuf {
        let mut os = raw_path.as_os_str().to_os_string();
        os.push(ext);
        PathBuf::from(os)
    }

    pub async fn exists(&self, sha256: &str) -> Result<bool, BlobError> {
        let path = self.blob_path(sha256)?;
        let shard_idx = shard_for_sha(sha256);
        if self.shards[shard_idx].contains(sha256) {
            return Ok(true);
        }
        match tokio::fs::metadata(&path).await {
            Ok(meta) => Ok(meta.is_file()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(err) => Err(BlobError::Io(err)),
        }
    }

    pub async fn put(
        &self,
        sha256: &str,
        bytes: Bytes,
        precompress: bool,
    ) -> Result<PutOutcome, BlobError> {
        let path = self.blob_path(sha256)?;
        if bytes.len() > self.max_blob_bytes {
            return Err(BlobError::TooLarge);
        }
        let expected_sha = sha256.to_string();
        let bytes_for_cpu = bytes.clone();
        let should_precompress = precompress
            && bytes.len() >= COMPRESS_MIN_BYTES
            && bytes.len() <= PRECOMPRESS_MAX_BYTES
            && !is_likely_incompressible(&bytes);

        let (hash_ok, variants) = if bytes.len() >= BLOCKING_OFFLOAD_THRESHOLD || should_precompress {
            tokio::task::spawn_blocking(move || {
                if sha256_hex(&bytes_for_cpu) != expected_sha {
                    return (
                        false,
                        PrecompressedVariants {
                            gzip: None,
                            brotli: None,
                            zstd: None,
                        },
                    );
                }
                let v = if should_precompress {
                    precompress_all(&bytes_for_cpu)
                } else {
                    PrecompressedVariants {
                        gzip: None,
                        brotli: None,
                        zstd: None,
                    }
                };
                (true, v)
            })
            .await
            .map_err(|e| BlobError::Io(std::io::Error::other(e.to_string())))?
        } else {
            if sha256_hex(&bytes) != sha256 {
                return Err(BlobError::HashMismatch);
            }
            (
                true,
                PrecompressedVariants {
                    gzip: None,
                    brotli: None,
                    zstd: None,
                },
            )
        };
        if !hash_ok {
            return Err(BlobError::HashMismatch);
        }

        if tokio::fs::metadata(&path).await.map_or(false, |m| m.is_file()) {
            return Ok(PutOutcome::Exists);
        }
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        write_atomic(&path, &bytes, true).await?;

        if let Some(ref gz) = variants.gzip {
            let _ = write_atomic(&Self::sidecar_path(&path, ".gz"), gz, false).await;
        }
        if let Some(ref br) = variants.brotli {
            let _ = write_atomic(&Self::sidecar_path(&path, ".br"), br, false).await;
        }
        if let Some(ref zs) = variants.zstd {
            let _ = write_atomic(&Self::sidecar_path(&path, ".zst"), zs, false).await;
        }

        let cached = CachedBlob::new(bytes, variants.gzip, variants.brotli, variants.zstd);
        let shard_idx = shard_for_sha(sha256);
        self.shards[shard_idx].insert(sha256.to_string(), cached);
        Ok(PutOutcome::Stored)
    }

    pub async fn get(&self, sha256: &str, prefer_gzip: bool) -> Result<BlobPayload, BlobError> {
        let accepted = if prefer_gzip {
            AcceptedEncodings::GZIP_ONLY
        } else {
            AcceptedEncodings::IDENTITY
        };
        self.get_encoded(sha256, accepted).await
    }

    pub async fn get_encoded(
        &self,
        sha256: &str,
        accepted: AcceptedEncodings,
    ) -> Result<BlobPayload, BlobError> {
        let path = self.blob_path(sha256)?;
        let shard_idx = shard_for_sha(sha256);
        if let Some(hit) = self.shards[shard_idx].get_wait_free(sha256, accepted) {
            return Ok(hit);
        }

        let existing_rx = {
            let mut map = self
                .inflight
                .lock()
                .map_err(|_| BlobError::Io(std::io::Error::other("inflight lock poisoned")))?;
            if let Some(tx) = map.get(sha256) {
                Some(tx.subscribe())
            } else {
                let (tx, _) = broadcast::channel(8);
                map.insert(sha256.to_string(), tx);
                None
            }
        };

        if let Some(mut rx) = existing_rx {
            return match rx.recv().await {
                Ok(ReadResult::Ok(blob)) => Ok(blob.to_payload(accepted)),
                Ok(ReadResult::NotFound) => Err(BlobError::NotFound),
                Ok(ReadResult::Corrupt) => Err(BlobError::CorruptOnDisk),
                Ok(ReadResult::Io(msg)) => Err(BlobError::Io(std::io::Error::other(msg))),
                Err(_) => Err(BlobError::Io(std::io::Error::other("inflight_closed"))),
            };
        }

        let guard = InFlightGuard {
            map: &self.inflight,
            key: sha256.to_string(),
            completed: false,
        };

        let raw_vec = match tokio::fs::read(&path).await {
            Ok(v) => v,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                guard.finish(ReadResult::NotFound);
                return Err(BlobError::NotFound);
            }
            Err(err) => {
                let msg = err.to_string();
                guard.finish(ReadResult::Io(msg));
                return Err(BlobError::Io(err));
            }
        };

        let expected = sha256.to_string();
        let (valid, raw) = if raw_vec.len() >= BLOCKING_OFFLOAD_THRESHOLD {
            tokio::task::spawn_blocking(move || {
                let ok = sha256_hex(&raw_vec) == expected;
                (ok, Bytes::from(raw_vec))
            })
            .await
            .map_err(|e| BlobError::Io(std::io::Error::other(e.to_string())))?
        } else {
            let ok = sha256_hex(&raw_vec) == expected;
            (ok, Bytes::from(raw_vec))
        };

        if !valid {
            guard.finish(ReadResult::Corrupt);
            return Err(BlobError::CorruptOnDisk);
        }

        let gz_path = Self::sidecar_path(&path, ".gz");
        let br_path = Self::sidecar_path(&path, ".br");
        let zs_path = Self::sidecar_path(&path, ".zst");
        let (gz_res, br_res, zs_res) = tokio::join!(
            tokio::fs::read(&gz_path),
            tokio::fs::read(&br_path),
            tokio::fs::read(&zs_path),
        );
        let gzip = gz_res.ok().map(Bytes::from);
        let brotli = br_res.ok().map(Bytes::from);
        let zstd = zs_res.ok().map(Bytes::from);

        let cached = CachedBlob::new(raw, gzip, brotli, zstd);
        let payload = cached.to_payload(accepted);
        self.shards[shard_idx].insert(sha256.to_string(), cached.clone());
        guard.finish(ReadResult::Ok(cached));
        Ok(payload)
    }

    pub async fn get_range(
        &self,
        sha256: &str,
        start: usize,
        end_inclusive: usize,
    ) -> Result<(Bytes, usize), BlobError> {
        let path = self.blob_path(sha256)?;
        let shard_idx = shard_for_sha(sha256);
        if let Some(hit) = self.shards[shard_idx].get_wait_free(sha256, AcceptedEncodings::IDENTITY) {
            let total = hit.raw_len;
            if total == 0 || start >= total || start > end_inclusive {
                return Ok((Bytes::new(), total));
            }
            let capped_end = end_inclusive.min(total - 1);
            return Ok((hit.bytes.slice(start..=capped_end), total));
        }

        let meta = tokio::fs::metadata(&path).await?;
        let total = meta.len() as usize;
        if total == 0 || start >= total || start > end_inclusive {
            return Ok((Bytes::new(), total));
        }
        let capped_end = end_inclusive.min(total - 1);
        let max_direct_cache = (self.max_cache_bytes / CACHE_SHARDS).min(4 * 1024 * 1024);
        if total <= max_direct_cache {
            let payload = self.get_encoded(sha256, AcceptedEncodings::IDENTITY).await?;
            return Ok((payload.bytes.slice(start..=capped_end), payload.raw_len));
        }

        let len = capped_end - start + 1;
        let mut file = tokio::fs::File::open(&path).await?;
        file.seek(SeekFrom::Start(start as u64)).await?;
        let mut buf = Vec::with_capacity(len.min(16 * 1024 * 1024));
        file.take(len as u64).read_to_end(&mut buf).await?;
        Ok((Bytes::from(buf), total))
    }
}

fn is_likely_incompressible(bytes: &[u8]) -> bool {
    if bytes.len() < 12 {
        return false;
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || bytes.starts_with(b"\xff\xd8\xff")
        || bytes.starts_with(b"GIF8")
        || bytes.starts_with(b"wOF2")
        || bytes.starts_with(b"\x1f\x8b")
        || bytes.starts_with(b"\x28\xb5\x2f\xfd")
        || bytes.starts_with(b"PK\x03\x04")
        || bytes.starts_with(b"\x1a\x45\xdf\xa3")
        || bytes.starts_with(b"OggS")
        || bytes.starts_with(b"ID3")
    {
        return true;
    }
    if bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return true;
    }
    if &bytes[4..8] == b"ftyp" {
        return true;
    }
    false
}

fn precompress_all(raw: &[u8]) -> PrecompressedVariants {
    let gzip = compress_gzip_if_smaller(raw);
    let brotli = compress_brotli_if_smaller(raw);
    let zstd = compress_zstd_if_smaller(raw);
    PrecompressedVariants { gzip, brotli, zstd }
}

fn compress_gzip_if_smaller(raw: &[u8]) -> Option<Bytes> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(raw).ok()?;
    let compressed = encoder.finish().ok()?;
    if compressed.len() * 100 < raw.len() * 95 {
        Some(Bytes::from(compressed))
    } else {
        None
    }
}

fn compress_brotli_if_smaller(raw: &[u8]) -> Option<Bytes> {
    let mut out = Vec::new();
    {
        let mut writer = brotli::CompressorWriter::new(&mut out, 4096, BROTLI_QUALITY, BROTLI_WINDOW);
        writer.write_all(raw).ok()?;
    }
    if out.len() * 100 < raw.len() * 95 {
        Some(Bytes::from(out))
    } else {
        None
    }
}

fn compress_zstd_if_smaller(raw: &[u8]) -> Option<Bytes> {
    let compressed = zstd::bulk::compress(raw, ZSTD_LEVEL).ok()?;
    if compressed.len() * 100 < raw.len() * 95 {
        Some(Bytes::from(compressed))
    } else {
        None
    }
}

async fn write_atomic(target: &Path, bytes: &[u8], sync_data: bool) -> Result<(), BlobError> {
    let seq = TEMP_FILE_SEQ.fetch_add(1, Ordering::Relaxed);
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let file_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("blob");
    let tmp = target.with_file_name(format!(".{file_name}.tmp-{}-{seq}-{nonce}", std::process::id()));
    let mut file = tokio::fs::File::create(&tmp).await?;
    tokio::io::AsyncWriteExt::write_all(&mut file, bytes).await?;
    if sync_data {
        file.sync_data().await?;
    }
    drop(file);
    match tokio::fs::rename(&tmp, target).await {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = tokio::fs::remove_file(&tmp).await;
            Err(BlobError::Io(err))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tempfile::tempdir;

    #[tokio::test]
    async fn put_get_and_verify_integrity_across_br_zstd_gzip() {
        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().to_path_buf(), 1024 * 1024, 1024 * 1024);
        let body = Bytes::from("<html><body><h1>Hej Danmark</h1><p>Hurtig webhosting paa dansk bare metal.</p></body></html>".repeat(40));
        let hash = sha256_hex(&body);

        assert_eq!(store.put(&hash, body.clone(), true).await.unwrap(), PutOutcome::Stored);
        assert_eq!(store.put(&hash, body.clone(), true).await.unwrap(), PutOutcome::Exists);
        assert!(store.exists(&hash).await.unwrap());

        let br = store
            .get_encoded(&hash, AcceptedEncodings::from_header("gzip, br, zstd"))
            .await
            .unwrap();
        assert_eq!(br.encoding, ContentEncoding::Brotli);
        assert!(br.bytes.len() < body.len());

        let zs = store
            .get_encoded(&hash, AcceptedEncodings::from_header("zstd;q=1.0, br;q=0.5, gzip;q=0.5"))
            .await
            .unwrap();
        assert_eq!(zs.encoding, ContentEncoding::Zstd);
        assert!(zs.bytes.len() < body.len());

        let gz = store.get(&hash, true).await.unwrap();
        assert_eq!(gz.encoding, ContentEncoding::Gzip);
        assert!(gz.bytes.len() < body.len());
        assert!(br.bytes.len() <= gz.bytes.len());

        let raw = store.get(&hash, false).await.unwrap();
        assert_eq!(raw.encoding, ContentEncoding::Identity);
        assert_eq!(raw.bytes, body);
    }

    #[tokio::test]
    async fn skips_precompression_for_png_magic_bytes() {
        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().to_path_buf(), 1024 * 1024, 1024 * 1024);
        let mut fake_png = b"\x89PNG\r\n\x1a\n".to_vec();
        fake_png.extend_from_slice(&[0u8; 2048]);
        let body = Bytes::from(fake_png);
        let hash = sha256_hex(&body);

        store.put(&hash, body.clone(), true).await.unwrap();
        let res = store
            .get_encoded(&hash, AcceptedEncodings::from_header("br, zstd, gzip"))
            .await
            .unwrap();
        assert_eq!(res.encoding, ContentEncoding::Identity);
        assert_eq!(res.bytes, body);
    }

    #[tokio::test]
    async fn rejects_hash_mismatch_and_detects_corruption() {
        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().to_path_buf(), 0, 1024 * 1024);
        let body = Bytes::from_static(b"hello world");
        let wrong = "0".repeat(64);
        assert!(matches!(
            store.put(&wrong, body.clone(), false).await,
            Err(BlobError::HashMismatch)
        ));

        let hash = sha256_hex(&body);
        store.put(&hash, body, false).await.unwrap();

        let disk_path = dir.path().join(&hash[0..2]).join(&hash[2..4]).join(&hash);
        tokio::fs::write(&disk_path, b"tampered!").await.unwrap();
        assert!(matches!(store.get(&hash, false).await, Err(BlobError::CorruptOnDisk)));
    }

    #[tokio::test]
    async fn evicts_sieve_entries_and_coalesces_cold_reads() {
        let dir = tempdir().unwrap();
        let store = Arc::new(BlobStore::new(dir.path().to_path_buf(), 64 * 64, 1024 * 1024));
        let mut hashes = Vec::new();
        for i in 0..80 {
            let body = Bytes::from(format!("blob-payload-{i:04}-abcdefghij"));
            let h = sha256_hex(&body);
            store.put(&h, body, false).await.unwrap();
            hashes.push(h);
        }
        let target = hashes[0].clone();
        let mut tasks = Vec::new();
        for _ in 0..32 {
            let s = Arc::clone(&store);
            let h = target.clone();
            tasks.push(tokio::spawn(async move { s.get(&h, false).await.unwrap().raw_len }));
        }
        for t in tasks {
            assert!(t.await.unwrap() > 20);
        }
        let (slice, total) = store.get_range(&target, 0, 7).await.unwrap();
        assert_eq!(slice.as_ref(), b"blob-pay");
        assert!(total > 20);
    }
}
