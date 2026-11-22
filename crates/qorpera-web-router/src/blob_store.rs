use bytes::Bytes;
use flate2::{write::GzEncoder, Compression};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::broadcast;

pub const DEFAULT_MAX_CACHE_BYTES: usize = 256 * 1024 * 1024;
pub const DEFAULT_MAX_BLOB_BYTES: usize = 100 * 1024 * 1024;
const GZIP_MIN_BYTES: usize = 256;
const BLOCKING_OFFLOAD_THRESHOLD: usize = 32 * 1024;
const CACHE_SHARDS: usize = 16;

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
}

impl ContentEncoding {
    pub fn header_value(self) -> Option<&'static str> {
        match self {
            ContentEncoding::Identity => None,
            ContentEncoding::Gzip => Some("gzip"),
        }
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
    accounted_bytes: usize,
}

impl CachedBlob {
    fn to_payload(&self, prefer_gzip: bool) -> BlobPayload {
        let raw_len = self.raw.len();
        if prefer_gzip {
            if let Some(gz) = &self.gzip {
                return BlobPayload {
                    bytes: gz.clone(),
                    raw_len,
                    encoding: ContentEncoding::Gzip,
                };
            }
        }
        BlobPayload {
            bytes: self.raw.clone(),
            raw_len,
            encoding: ContentEncoding::Identity,
        }
    }
}

struct LruNode {
    key: String,
    value: CachedBlob,
    prev: Option<usize>,
    next: Option<usize>,
}

struct LruShard {
    index: HashMap<String, usize>,
    nodes: Vec<Option<LruNode>>,
    free: Vec<usize>,
    head: Option<usize>,
    tail: Option<usize>,
    total_bytes: usize,
    max_bytes: usize,
}

impl LruShard {
    fn new(max_bytes: usize) -> Self {
        Self {
            index: HashMap::new(),
            nodes: Vec::new(),
            free: Vec::new(),
            head: None,
            tail: None,
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

    fn push_back(&mut self, idx: usize) {
        let old_tail = self.tail;
        if let Some(node) = self.nodes[idx].as_mut() {
            node.prev = old_tail;
            node.next = None;
        }
        if let Some(t) = old_tail {
            if let Some(tn) = self.nodes[t].as_mut() {
                tn.next = Some(idx);
            }
        } else {
            self.head = Some(idx);
        }
        self.tail = Some(idx);
    }

    fn get(&mut self, key: &str, prefer_gzip: bool) -> Option<BlobPayload> {
        let idx = *self.index.get(key)?;
        if self.tail != Some(idx) {
            self.detach(idx);
            self.push_back(idx);
        }
        self.nodes[idx].as_ref().map(|n| n.value.to_payload(prefer_gzip))
    }

    fn insert(&mut self, key: String, raw: Bytes, gzip: Option<Bytes>) {
        let accounted = raw.len() + gzip.as_ref().map_or(0, Bytes::len);
        if self.max_bytes == 0 || accounted > self.max_bytes {
            return;
        }
        if let Some(existing_idx) = self.index.remove(&key) {
            self.detach(existing_idx);
            if let Some(old) = self.nodes[existing_idx].take() {
                self.total_bytes = self.total_bytes.saturating_sub(old.value.accounted_bytes);
            }
            self.free.push(existing_idx);
        }
        while self.total_bytes + accounted > self.max_bytes {
            let Some(oldest_idx) = self.head else {
                break;
            };
            self.detach(oldest_idx);
            if let Some(evicted) = self.nodes[oldest_idx].take() {
                self.index.remove(&evicted.key);
                self.total_bytes = self.total_bytes.saturating_sub(evicted.value.accounted_bytes);
            }
            self.free.push(oldest_idx);
        }
        let node = LruNode {
            key: key.clone(),
            value: CachedBlob {
                raw,
                gzip,
                accounted_bytes: accounted,
            },
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
        self.index.insert(key, idx);
        self.push_back(idx);
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

fn shard_for_sha(sha256: &str) -> usize {
    let b = sha256.as_bytes().first().copied().unwrap_or(0);
    let nibble = match b {
        b'0'..=b'9' => (b - b'0') as usize,
        b'a'..=b'f' => (b - b'a' + 10) as usize,
        _ => 0,
    };
    nibble & (CACHE_SHARDS - 1)
}

pub struct BlobStore {
    root: PathBuf,
    max_blob_bytes: usize,
    max_cache_bytes: usize,
    shards: Vec<Mutex<LruShard>>,
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
            shards.push(Mutex::new(LruShard::new(per_shard)));
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

    fn gzip_path(raw_path: &Path) -> PathBuf {
        let mut os = raw_path.as_os_str().to_os_string();
        os.push(".gz");
        PathBuf::from(os)
    }

    pub async fn exists(&self, sha256: &str) -> Result<bool, BlobError> {
        let path = self.blob_path(sha256)?;
        let shard_idx = shard_for_sha(sha256);
        if let Ok(guard) = self.shards[shard_idx].lock() {
            if guard.index.contains_key(sha256) {
                return Ok(true);
            }
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
        precompress_gzip: bool,
    ) -> Result<PutOutcome, BlobError> {
        let path = self.blob_path(sha256)?;
        if bytes.len() > self.max_blob_bytes {
            return Err(BlobError::TooLarge);
        }
        let expected_sha = sha256.to_string();
        let bytes_for_cpu = bytes.clone();
        let (hash_ok, gzipped) = if bytes.len() >= BLOCKING_OFFLOAD_THRESHOLD {
            tokio::task::spawn_blocking(move || {
                if sha256_hex(&bytes_for_cpu) != expected_sha {
                    return (false, None);
                }
                let gz = if precompress_gzip && bytes_for_cpu.len() >= GZIP_MIN_BYTES {
                    compress_if_smaller(&bytes_for_cpu)
                } else {
                    None
                };
                (true, gz)
            })
            .await
            .map_err(|e| BlobError::Io(std::io::Error::other(e.to_string())))?
        } else {
            if sha256_hex(&bytes) != sha256 {
                return Err(BlobError::HashMismatch);
            }
            let gz = if precompress_gzip && bytes.len() >= GZIP_MIN_BYTES {
                compress_if_smaller(&bytes)
            } else {
                None
            };
            (true, gz)
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

        if let Some(ref gz) = gzipped {
            let gz_path = Self::gzip_path(&path);
            let _ = write_atomic(&gz_path, gz, false).await;
        }
        let shard_idx = shard_for_sha(sha256);
        if let Ok(mut guard) = self.shards[shard_idx].lock() {
            guard.insert(sha256.to_string(), bytes, gzipped);
        }
        Ok(PutOutcome::Stored)
    }

    pub async fn get(&self, sha256: &str, prefer_gzip: bool) -> Result<BlobPayload, BlobError> {
        let path = self.blob_path(sha256)?;
        let shard_idx = shard_for_sha(sha256);
        if let Ok(mut guard) = self.shards[shard_idx].lock() {
            if let Some(hit) = guard.get(sha256, prefer_gzip) {
                return Ok(hit);
            }
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
                Ok(ReadResult::Ok(blob)) => Ok(blob.to_payload(prefer_gzip)),
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

        let gz_path = Self::gzip_path(&path);
        let gzip = match tokio::fs::read(&gz_path).await {
            Ok(vec) => Some(Bytes::from(vec)),
            Err(_) => None,
        };
        let accounted = raw.len() + gzip.as_ref().map_or(0, Bytes::len);
        let cached = CachedBlob {
            raw: raw.clone(),
            gzip: gzip.clone(),
            accounted_bytes: accounted,
        };
        let payload = cached.to_payload(prefer_gzip);
        if let Ok(mut shard_guard) = self.shards[shard_idx].lock() {
            shard_guard.insert(sha256.to_string(), raw, gzip);
        }
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
        if let Ok(mut guard) = self.shards[shard_idx].lock() {
            if let Some(hit) = guard.get(sha256, false) {
                let total = hit.raw_len;
                if total == 0 || start >= total || start > end_inclusive {
                    return Ok((Bytes::new(), total));
                }
                let capped_end = end_inclusive.min(total - 1);
                return Ok((hit.bytes.slice(start..=capped_end), total));
            }
        }

        let meta = tokio::fs::metadata(&path).await?;
        let total = meta.len() as usize;
        if total == 0 || start >= total || start > end_inclusive {
            return Ok((Bytes::new(), total));
        }
        let capped_end = end_inclusive.min(total - 1);
        let max_direct_cache = (self.max_cache_bytes / CACHE_SHARDS).min(4 * 1024 * 1024);
        if total <= max_direct_cache {
            let payload = self.get(sha256, false).await?;
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

fn compress_if_smaller(raw: &[u8]) -> Option<Bytes> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder.write_all(raw).ok()?;
    let compressed = encoder.finish().ok()?;
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
    let mut tmp = target.as_os_str().to_os_string();
    tmp.push(format!(".{}.{}.{}.tmp", std::process::id(), seq, nonce));
    let tmp_path = PathBuf::from(tmp);
    let write_res = async {
        let mut file = tokio::fs::File::create(&tmp_path).await?;
        tokio::io::AsyncWriteExt::write_all(&mut file, bytes).await?;
        if sync_data {
            file.sync_data().await?;
        }
        tokio::fs::rename(&tmp_path, target).await?;
        Ok::<(), std::io::Error>(())
    }
    .await;
    if let Err(err) = write_res {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(BlobError::Io(err));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn put_get_and_verify_integrity() {
        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().to_path_buf(), 1024 * 1024, 1024 * 1024);
        let body = Bytes::from("hello world ".repeat(100));
        let hash = sha256_hex(&body);

        assert_eq!(store.put(&hash, body.clone(), true).await.unwrap(), PutOutcome::Stored);
        assert_eq!(store.put(&hash, body.clone(), true).await.unwrap(), PutOutcome::Exists);
        assert!(store.exists(&hash).await.unwrap());

        let gz = store.get(&hash, true).await.unwrap();
        assert_eq!(gz.encoding, ContentEncoding::Gzip);
        assert_eq!(gz.raw_len, body.len());
        assert!(gz.bytes.len() < body.len());

        let raw = store.get(&hash, false).await.unwrap();
        assert_eq!(raw.encoding, ContentEncoding::Identity);
        assert_eq!(raw.bytes, body);
    }

    #[tokio::test]
    async fn rejects_hash_mismatch_and_detects_corruption() {
        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().to_path_buf(), 0, 1024 * 1024);
        let body = Bytes::from_static(b"authentic");
        let hash = sha256_hex(&body);
        let wrong = "0".repeat(64);

        assert!(matches!(
            store.put(&wrong, body.clone(), false).await,
            Err(BlobError::HashMismatch)
        ));
        store.put(&hash, body, false).await.unwrap();

        let disk_path = dir.path().join(&hash[0..2]).join(&hash[2..4]).join(&hash);
        tokio::fs::write(&disk_path, b"tampered!").await.unwrap();
        assert!(matches!(store.get(&hash, false).await, Err(BlobError::CorruptOnDisk)));
    }

    #[tokio::test]
    async fn evicts_lru_entries_in_constant_time_and_coalesces_cold_reads() {
        let dir = tempdir().unwrap();
        let store = std::sync::Arc::new(BlobStore::new(dir.path().to_path_buf(), 16 * 64, 1024 * 1024));
        let mut hashes = Vec::new();
        for i in 0..40 {
            let body = Bytes::from(format!("payload-{i:04}-{}", "a".repeat(20)));
            let h = sha256_hex(&body);
            store.put(&h, body, false).await.unwrap();
            hashes.push(h);
        }

        let target = hashes[0].clone();
        let mut tasks = Vec::new();
        for _ in 0..32 {
            let s = std::sync::Arc::clone(&store);
            let h = target.clone();
            tasks.push(tokio::spawn(async move { s.get(&h, false).await.unwrap().raw_len }));
        }
        for t in tasks {
            assert!(t.await.unwrap() > 20);
        }

        let (slice, total) = store.get_range(&target, 0, 7).await.unwrap();
        assert_eq!(slice.as_ref(), b"payload-");
        assert!(total > 20);
    }
}
