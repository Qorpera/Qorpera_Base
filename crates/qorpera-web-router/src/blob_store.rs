use crate::proxy::{BoxBody, BoxBodyError};
use bytes::{Bytes, BytesMut};
use flate2::{write::GzEncoder, Compression};
use http_body_util::BodyExt;
use hyper::body::{Body, Frame};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc as std_mpsc, Arc, Mutex, RwLock};
use std::task::{Context, Poll};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, BufWriter};
use tokio::sync::{broadcast, mpsc, oneshot, OwnedSemaphorePermit, Semaphore};

pub const DEFAULT_MAX_CACHE_BYTES: usize = 256 * 1024 * 1024;
pub const DEFAULT_MAX_BLOB_BYTES: usize = 100 * 1024 * 1024;
pub const DEFAULT_STREAM_THRESHOLD_BYTES: usize = 4 * 1024 * 1024;
const COMPRESS_MIN_BYTES: usize = 256;
const PRECOMPRESS_MAX_BYTES: usize = 8 * 1024 * 1024;
const PUT_CACHE_WARM_MAX_BYTES: usize = 512 * 1024;
const BLOCKING_OFFLOAD_THRESHOLD: usize = 16 * 1024;
const CACHE_SHARDS: usize = 64;
const MAX_CONCURRENT_PRECOMPRESS: usize = 2;
const MAX_COMPRESS_QUEUE: usize = 32;
const ENTRY_STRUCTURAL_OVERHEAD: usize = 256;
const STREAM_CHUNK_BYTES: usize = 64 * 1024;
const BROTLI_QUALITY: i32 = 5;
const BROTLI_MAX_WINDOW: u32 = 22;
const ZSTD_LEVEL: i32 = 6;

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

    pub fn ranked_sidecars(self) -> [Option<(ContentEncoding, &'static str)>; 3] {
        let mut candidates = [
            (ContentEncoding::Brotli, ".br", self.br_q),
            (ContentEncoding::Zstd, ".zst", self.zstd_q),
            (ContentEncoding::Gzip, ".gz", self.gzip_q),
        ];
        candidates.sort_by(|a, b| b.2.total_cmp(&a.2));
        let mut out = [None; 3];
        let mut idx = 0;
        for (enc, ext, q) in candidates {
            if q > 0.0 {
                out[idx] = Some((enc, ext));
                idx += 1;
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
    Timeout,
    BodyRead,
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
            BlobError::Timeout => write!(f, "blob body read timed out"),
            BlobError::BodyRead => write!(f, "blob body read failed"),
            BlobError::Io(err) => write!(f, "io error: {err}"),
        }
    }
}

pub enum BlobRead {
    Buffered(BlobPayload),
    Stream {
        file: tokio::fs::File,
        len: usize,
        total: usize,
        encoding: ContentEncoding,
        expected_sha256: Option<String>,
    },
}

pub enum BlobRangeRead {
    Buffered(Bytes, usize),
    Stream {
        file: tokio::fs::File,
        len: usize,
        total: usize,
    },
}

struct ChannelBody {
    rx: mpsc::Receiver<Result<Frame<Bytes>, BoxBodyError>>,
}

impl Body for ChannelBody {
    type Data = Bytes;
    type Error = BoxBodyError;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        self.rx.poll_recv(cx)
    }
}

pub fn stream_file_body(
    mut file: tokio::fs::File,
    mut remaining: usize,
    expected_sha256: Option<String>,
) -> BoxBody {
    let (tx, rx) = mpsc::channel::<Result<Frame<Bytes>, BoxBodyError>>(4);
    tokio::spawn(async move {
        let mut hasher = expected_sha256.as_ref().map(|_| Sha256::new());
        // WHY: Hold back the trailing chunk until EOF when verifying SHA-256 so a corrupt blob aborts with an error frame before Content-Length completes.
        let mut pending: Option<Bytes> = None;
        while remaining > 0 {
            let want = remaining.min(STREAM_CHUNK_BYTES);
            let mut buf = BytesMut::with_capacity(want);
            match (&mut file).take(want as u64).read_buf(&mut buf).await {
                Ok(0) => {
                    let _ = tx
                        .send(Err(Box::new(std::io::Error::new(
                            std::io::ErrorKind::UnexpectedEof,
                            "blob truncated while streaming",
                        ))))
                        .await;
                    return;
                }
                Ok(n) => {
                    remaining -= n;
                    if let Some(ref mut h) = hasher {
                        h.update(&buf);
                    }
                    let chunk = buf.freeze();
                    if expected_sha256.is_some() {
                        if let Some(prev) = pending.replace(chunk) {
                            if tx.send(Ok(Frame::data(prev))).await.is_err() {
                                return;
                            }
                        }
                    } else if tx.send(Ok(Frame::data(chunk))).await.is_err() {
                        return;
                    }
                }
                Err(err) => {
                    let _ = tx.send(Err(Box::new(err))).await;
                    return;
                }
            }
        }
        if let (Some(expected), Some(h)) = (expected_sha256, hasher) {
            let mut extra = [0u8; 1];
            let grew = matches!(file.read(&mut extra).await, Ok(n) if n > 0);
            if grew || hex::encode(h.finalize()) != expected {
                let _ = tx
                    .send(Err(Box::new(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "blob sha256 mismatch while streaming",
                    ))))
                    .await;
                return;
            }
            if let Some(last) = pending {
                let _ = tx.send(Ok(Frame::data(last))).await;
            }
        }
    });
    ChannelBody { rx }.boxed()
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
        // WHY: Account for HashMap, Arc, and SIEVE node overhead so tiny blobs cannot bypass max_cache_bytes.
        let accounted_bytes = ENTRY_STRUCTURAL_OVERHEAD
            + raw.len()
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
    key: Arc<str>,
    entry: Arc<SieveEntry>,
    prev: Option<usize>,
    next: Option<usize>,
}

struct SieveShard {
    index: HashMap<Arc<str>, usize>,
    nodes: Vec<Option<SieveNode>>,
    free: Vec<usize>,
    head: Option<usize>,
    tail: Option<usize>,
    hand: Option<usize>,
    total_bytes: usize,
    max_bytes: usize,
}

struct WaitFreeShard {
    inner: RwLock<SieveShard>,
}

impl WaitFreeShard {
    fn new(max_bytes: usize) -> Self {
        Self {
            inner: RwLock::new(SieveShard::new(max_bytes)),
        }
    }

    #[inline]
    fn contains(&self, key: &str) -> bool {
        self.inner.read().ok().is_some_and(|guard| guard.index.contains_key(key))
    }

    #[inline]
    fn get_wait_free(&self, key: &str, accepted: AcceptedEncodings) -> Option<BlobPayload> {
        let guard = self.inner.read().ok()?;
        let &idx = guard.index.get(key)?;
        let entry = &guard.nodes[idx].as_ref()?.entry;
        if !entry.visited.load(Ordering::Relaxed) {
            entry.visited.store(true, Ordering::Relaxed);
        }
        Some(entry.value.to_payload(accepted))
    }

    fn insert(&self, key: &str, blob: CachedBlob) {
        if let Ok(mut guard) = self.inner.write() {
            guard.insert(Arc::from(key), blob);
        }
    }
}

impl SieveShard {
    fn new(max_bytes: usize) -> Self {
        Self {
            index: HashMap::new(),
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
                self.total_bytes = self
                    .total_bytes
                    .saturating_sub(evicted.entry.value.accounted_bytes);
            }
            self.free.push(idx);
            return true;
        }
        false
    }

    fn insert(&mut self, key: Arc<str>, blob: CachedBlob) -> bool {
        let accounted = blob.accounted_bytes;
        if self.max_bytes == 0 || accounted > self.max_bytes {
            return false;
        }
        if let Some(existing_idx) = self.index.remove(&key) {
            self.detach(existing_idx);
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
            key: Arc::clone(&key),
            entry,
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

struct CompressJob {
    raw: Bytes,
    reply: oneshot::Sender<PrecompressedVariants>,
    _permit: OwnedSemaphorePermit,
}

struct CompressPool {
    tx: Mutex<Option<std_mpsc::SyncSender<CompressJob>>>,
    queue_sem: Arc<Semaphore>,
    max_workers: usize,
    max_queue: usize,
}

impl CompressPool {
    fn new() -> Self {
        Self::with_limits(MAX_CONCURRENT_PRECOMPRESS, MAX_COMPRESS_QUEUE)
    }

    fn with_limits(max_workers: usize, max_queue: usize) -> Self {
        Self {
            tx: Mutex::new(None),
            queue_sem: Arc::new(Semaphore::new(max_queue.max(1))),
            max_workers: max_workers.max(1),
            max_queue: max_queue.max(1),
        }
    }

    async fn compress(&self, raw: Bytes) -> Result<PrecompressedVariants, BlobError> {
        // WHY: Bound queued + active precompression jobs asynchronously so bursts do not grow RAM unboundedly or block Tokio workers.
        let permit = Arc::clone(&self.queue_sem)
            .acquire_owned()
            .await
            .map_err(|_| BlobError::Io(std::io::Error::other("compress queue closed")))?;
        let sender = {
            let mut guard = self
                .tx
                .lock()
                .map_err(|_| BlobError::Io(std::io::Error::other("compress pool lock poisoned")))?;
            if let Some(ref tx) = *guard {
                tx.clone()
            } else {
                let (tx, rx) = std_mpsc::sync_channel::<CompressJob>(self.max_queue);
                let shared_rx = Arc::new(Mutex::new(rx));
                for worker_idx in 0..self.max_workers {
                    let rx_ref = Arc::clone(&shared_rx);
                    let _ = std::thread::Builder::new()
                        .name(format!("qorpera-compress-{worker_idx}"))
                        .spawn(move || {
                            let mut zstd_ctx = zstd::bulk::Compressor::new(ZSTD_LEVEL).ok();
                            loop {
                                let job = {
                                    let Ok(rx_guard) = rx_ref.lock() else {
                                        break;
                                    };
                                    rx_guard.recv()
                                };
                                let Ok(job) = job else {
                                    break;
                                };
                                let CompressJob { raw, reply, _permit } = job;
                                let variants = precompress_all_with_ctx(&raw, zstd_ctx.as_mut());
                                drop(_permit);
                                let _ = reply.send(variants);
                            }
                        });
                }
                *guard = Some(tx.clone());
                tx
            }
        };

        let (reply_tx, reply_rx) = oneshot::channel();
        sender
            .try_send(CompressJob {
                raw,
                reply: reply_tx,
                _permit: permit,
            })
            .map_err(|_| BlobError::Io(std::io::Error::other("compress pool unavailable")))?;
        reply_rx
            .await
            .map_err(|_| BlobError::Io(std::io::Error::other("compress job dropped")))
    }
}

pub struct BlobStore {
    root: PathBuf,
    max_blob_bytes: usize,
    max_cache_bytes: usize,
    stream_threshold_bytes: usize,
    shards: Vec<WaitFreeShard>,
    inflight: Mutex<HashMap<String, broadcast::Sender<ReadResult>>>,
    compress_pool: CompressPool,
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
            stream_threshold_bytes: DEFAULT_STREAM_THRESHOLD_BYTES,
            shards,
            inflight: Mutex::new(HashMap::new()),
            compress_pool: CompressPool::new(),
        }
    }

    pub fn with_stream_threshold(mut self, bytes: usize) -> Self {
        self.stream_threshold_bytes = bytes;
        self
    }

    fn direct_cache_limit(&self) -> usize {
        if self.max_cache_bytes == 0 {
            self.stream_threshold_bytes
        } else {
            (self.max_cache_bytes / CACHE_SHARDS).min(self.stream_threshold_bytes)
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

        let hash_ok = if bytes.len() >= BLOCKING_OFFLOAD_THRESHOLD {
            let expected_sha = sha256.to_string();
            let bytes_for_hash = bytes.clone();
            tokio::task::spawn_blocking(move || sha256_hex(&bytes_for_hash) == expected_sha)
                .await
                .map_err(|e| BlobError::Io(std::io::Error::other(e.to_string())))?
        } else {
            sha256_hex(&bytes) == sha256
        };
        if !hash_ok {
            return Err(BlobError::HashMismatch);
        }

        let shard_idx = shard_for_sha(sha256);
        if self.shards[shard_idx].contains(sha256)
            || tokio::fs::metadata(&path).await.map_or(false, |m| m.is_file())
        {
            return Ok(PutOutcome::Exists);
        }

        let should_precompress = precompress
            && bytes.len() >= COMPRESS_MIN_BYTES
            && bytes.len() <= PRECOMPRESS_MAX_BYTES
            && !is_likely_incompressible(&bytes);

        let variants = if should_precompress {
            self.compress_pool.compress(bytes.clone()).await?
        } else {
            PrecompressedVariants {
                gzip: None,
                brotli: None,
                zstd: None,
            }
        };

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
        if cached.accounted_bytes <= PUT_CACHE_WARM_MAX_BYTES {
            self.shards[shard_idx].insert(sha256, cached);
        }
        Ok(PutOutcome::Stored)
    }

    pub async fn put_stream<B>(
        &self,
        sha256: &str,
        mut body: B,
        precompress: bool,
        frame_timeout: Duration,
    ) -> Result<PutOutcome, BlobError>
    where
        B: Body<Data = Bytes> + Unpin,
    {
        let path = self.blob_path(sha256)?;
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        // WHY: Stream uploads directly to a guarded temp file with incremental SHA-256 so large PUTs do not buffer up to 100 MiB in RAM.
        let tmp = unique_temp_path(&path);
        let mut guard = TempFileGuard::new(tmp.clone());
        let mut file = BufWriter::with_capacity(256 * 1024, tokio::fs::File::create(&tmp).await?);
        let mut hasher = Sha256::new();
        let mut total_bytes = 0usize;
        let mut small_buf: Option<Vec<u8>> = Some(Vec::new());

        loop {
            let next_frame = match tokio::time::timeout(frame_timeout, body.frame()).await {
                Ok(frame) => frame,
                Err(_) => {
                    drop(file);
                    guard.remove_now().await;
                    return Err(BlobError::Timeout);
                }
            };
            let Some(frame_res) = next_frame else {
                break;
            };
            let frame = match frame_res {
                Ok(f) => f,
                Err(_) => {
                    drop(file);
                    guard.remove_now().await;
                    return Err(BlobError::BodyRead);
                }
            };
            if let Ok(chunk) = frame.into_data() {
                if chunk.is_empty() {
                    continue;
                }
                let Some(next_total) = total_bytes.checked_add(chunk.len()) else {
                    drop(file);
                    guard.remove_now().await;
                    return Err(BlobError::TooLarge);
                };
                if next_total > self.max_blob_bytes {
                    drop(file);
                    guard.remove_now().await;
                    return Err(BlobError::TooLarge);
                }
                total_bytes = next_total;
                hasher.update(&chunk);
                if let Err(err) = file.write_all(&chunk).await {
                    drop(file);
                    guard.remove_now().await;
                    return Err(BlobError::Io(err));
                }
                if let Some(ref mut buf) = small_buf {
                    if total_bytes <= PRECOMPRESS_MAX_BYTES {
                        buf.extend_from_slice(&chunk);
                    } else {
                        small_buf = None;
                    }
                }
            }
        }

        let actual_sha = hex::encode(hasher.finalize());
        if actual_sha != sha256 {
            drop(file);
            guard.remove_now().await;
            return Err(BlobError::HashMismatch);
        }

        let shard_idx = shard_for_sha(sha256);
        if self.shards[shard_idx].contains(sha256)
            || tokio::fs::metadata(&path).await.map_or(false, |m| m.is_file())
        {
            drop(file);
            guard.remove_now().await;
            return Ok(PutOutcome::Exists);
        }

        if let Err(err) = file.flush().await {
            drop(file);
            guard.remove_now().await;
            return Err(BlobError::Io(err));
        }
        let inner_file = file.into_inner();
        if let Err(err) = inner_file.sync_data().await {
            drop(inner_file);
            guard.remove_now().await;
            return Err(BlobError::Io(err));
        }
        drop(inner_file);
        if let Err(err) = tokio::fs::rename(&tmp, &path).await {
            guard.remove_now().await;
            return Err(BlobError::Io(err));
        }
        guard.defuse();

        if let Some(buf) = small_buf {
            let bytes = Bytes::from(buf);
            let should_precompress = precompress
                && bytes.len() >= COMPRESS_MIN_BYTES
                && bytes.len() <= PRECOMPRESS_MAX_BYTES
                && !is_likely_incompressible(&bytes);
            let variants = if should_precompress {
                self.compress_pool.compress(bytes.clone()).await?
            } else {
                PrecompressedVariants {
                    gzip: None,
                    brotli: None,
                    zstd: None,
                }
            };
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
            if cached.accounted_bytes <= PUT_CACHE_WARM_MAX_BYTES {
                self.shards[shard_idx].insert(sha256, cached);
            }
        }
        Ok(PutOutcome::Stored)
    }

    pub async fn get_or_stream(
        &self,
        sha256: &str,
        accepted: AcceptedEncodings,
    ) -> Result<BlobRead, BlobError> {
        let path = self.blob_path(sha256)?;
        let shard_idx = shard_for_sha(sha256);
        if let Some(hit) = self.shards[shard_idx].get_wait_free(sha256, accepted) {
            return Ok(BlobRead::Buffered(hit));
        }
        let meta = tokio::fs::metadata(&path).await?;
        let total = meta.len() as usize;
        if total > self.direct_cache_limit() {
            // WHY: Preserve precomputed sidecars for 4-8 MiB assets and verify raw stream SHA-256 on disk reads above cache limit.
            if total <= PRECOMPRESS_MAX_BYTES {
                for (encoding, ext) in accepted.ranked_sidecars().into_iter().flatten() {
                    let sidecar_path = Self::sidecar_path(&path, ext);
                    if let Ok(sidecar_file) = tokio::fs::File::open(&sidecar_path).await {
                        if let Ok(sidecar_meta) = sidecar_file.metadata().await {
                            if sidecar_meta.is_file() {
                                return Ok(BlobRead::Stream {
                                    file: sidecar_file,
                                    len: sidecar_meta.len() as usize,
                                    total,
                                    encoding,
                                    expected_sha256: None,
                                });
                            }
                        }
                    }
                }
            }
            let file = tokio::fs::File::open(&path).await?;
            return Ok(BlobRead::Stream {
                file,
                len: total,
                total,
                encoding: ContentEncoding::Identity,
                expected_sha256: Some(sha256.to_string()),
            });
        }
        self.get_encoded(sha256, accepted).await.map(BlobRead::Buffered)
    }

    pub async fn get_range_or_stream(
        &self,
        sha256: &str,
        start: usize,
        end_inclusive: usize,
    ) -> Result<BlobRangeRead, BlobError> {
        let path = self.blob_path(sha256)?;
        let shard_idx = shard_for_sha(sha256);
        if let Some(hit) = self.shards[shard_idx].get_wait_free(sha256, AcceptedEncodings::IDENTITY) {
            let total = hit.raw_len;
            if total == 0 || start >= total || start > end_inclusive {
                return Ok(BlobRangeRead::Buffered(Bytes::new(), total));
            }
            let capped_end = end_inclusive.min(total - 1);
            return Ok(BlobRangeRead::Buffered(hit.bytes.slice(start..=capped_end), total));
        }

        let meta = tokio::fs::metadata(&path).await?;
        let total = meta.len() as usize;
        if total == 0 || start >= total || start > end_inclusive {
            return Ok(BlobRangeRead::Buffered(Bytes::new(), total));
        }
        let capped_end = end_inclusive.min(total - 1);
        if total <= self.direct_cache_limit() {
            let payload = self.get_encoded(sha256, AcceptedEncodings::IDENTITY).await?;
            return Ok(BlobRangeRead::Buffered(
                payload.bytes.slice(start..=capped_end),
                payload.raw_len,
            ));
        }

        let len = capped_end - start + 1;
        let mut file = tokio::fs::File::open(&path).await?;
        file.seek(SeekFrom::Start(start as u64)).await?;
        Ok(BlobRangeRead::Stream { file, len, total })
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

        let (gzip, brotli, zstd) = if raw.len() >= COMPRESS_MIN_BYTES
            && raw.len() <= PRECOMPRESS_MAX_BYTES
            && !is_likely_incompressible(&raw)
        {
            let gz_path = Self::sidecar_path(&path, ".gz");
            let br_path = Self::sidecar_path(&path, ".br");
            let zs_path = Self::sidecar_path(&path, ".zst");
            let (gz_res, br_res, zs_res) = tokio::join!(
                tokio::fs::read(&gz_path),
                tokio::fs::read(&br_path),
                tokio::fs::read(&zs_path),
            );
            (
                gz_res.ok().map(Bytes::from),
                br_res.ok().map(Bytes::from),
                zs_res.ok().map(Bytes::from),
            )
        } else {
            (None, None, None)
        };

        let cached = CachedBlob::new(raw, gzip, brotli, zstd);
        let payload = cached.to_payload(accepted);
        self.shards[shard_idx].insert(sha256, cached.clone());
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

fn precompress_all_with_ctx(
    raw: &[u8],
    zstd_ctx: Option<&mut zstd::bulk::Compressor<'_>>,
) -> PrecompressedVariants {
    let gzip = compress_gzip_if_smaller(raw);
    let brotli = compress_brotli_if_smaller(raw);
    let zstd = compress_zstd_if_smaller(raw, zstd_ctx);
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

fn optimal_brotli_window(len: usize) -> u32 {
    if len == 0 {
        return 10;
    }
    let pow2 = len.checked_next_power_of_two().unwrap_or(1 << BROTLI_MAX_WINDOW);
    pow2.trailing_zeros().clamp(10, BROTLI_MAX_WINDOW)
}

fn compress_brotli_if_smaller(raw: &[u8]) -> Option<Bytes> {
    let mut params = brotli::enc::BrotliEncoderParams::default();
    params.quality = BROTLI_QUALITY;
    params.lgwin = optimal_brotli_window(raw.len()) as i32;
    params.size_hint = raw.len();
    let mut out = Vec::new();
    {
        let mut writer = brotli::CompressorWriter::with_params(&mut out, 4096, &params);
        writer.write_all(raw).ok()?;
    }
    if out.len() * 100 < raw.len() * 95 {
        Some(Bytes::from(out))
    } else {
        None
    }
}

fn compress_zstd_if_smaller(
    raw: &[u8],
    zstd_ctx: Option<&mut zstd::bulk::Compressor<'_>>,
) -> Option<Bytes> {
    let compressed = match zstd_ctx {
        Some(ctx) => ctx.compress(raw).ok()?,
        None => zstd::bulk::compress(raw, ZSTD_LEVEL).ok()?,
    };
    if compressed.len() * 100 < raw.len() * 95 {
        Some(Bytes::from(compressed))
    } else {
        None
    }
}

struct TempFileGuard {
    path: Option<PathBuf>,
}

impl TempFileGuard {
    fn new(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }

    fn defuse(&mut self) {
        self.path = None;
    }

    async fn remove_now(&mut self) {
        if let Some(path) = self.path.take() {
            let _ = tokio::fs::remove_file(path).await;
        }
    }
}

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        if let Some(path) = self.path.take() {
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                handle.spawn_blocking(move || {
                    let _ = std::fs::remove_file(path);
                });
            } else {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

fn unique_temp_path(target: &Path) -> PathBuf {
    let seq = TEMP_FILE_SEQ.fetch_add(1, Ordering::Relaxed);
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let file_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("blob");
    target.with_file_name(format!(".{file_name}.tmp-{}-{seq}-{nonce}", std::process::id()))
}

async fn write_atomic(target: &Path, bytes: &[u8], sync_data: bool) -> Result<(), BlobError> {
    let tmp = unique_temp_path(target);
    let mut guard = TempFileGuard::new(tmp.clone());
    let mut file = tokio::fs::File::create(&tmp).await?;
    if let Err(err) = file.write_all(bytes).await {
        drop(file);
        guard.remove_now().await;
        return Err(BlobError::Io(err));
    }
    if sync_data {
        if let Err(err) = file.sync_data().await {
            drop(file);
            guard.remove_now().await;
            return Err(BlobError::Io(err));
        }
    }
    drop(file);
    match tokio::fs::rename(&tmp, target).await {
        Ok(()) => {
            guard.defuse();
            Ok(())
        }
        Err(err) => {
            guard.remove_now().await;
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
        let store = Arc::new(BlobStore::new(dir.path().to_path_buf(), 64 * 512, 1024 * 1024));
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

    #[tokio::test]
    async fn put_stream_cleans_temp_files_on_error_and_streams_large_reads() {
        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().to_path_buf(), 64 * 512, 256 * 1024)
            .with_stream_threshold(1024);

        let tiny = CachedBlob::new(Bytes::new(), None, None, None);
        assert!(tiny.accounted_bytes >= ENTRY_STRUCTURAL_OVERHEAD);

        let data = Bytes::from(vec![b'x'; 4096]);
        let wrong_sha = "1".repeat(64);
        assert!(matches!(
            store
                .put_stream(&wrong_sha, http_body_util::Full::new(data.clone()), false, Duration::from_secs(2))
                .await,
            Err(BlobError::HashMismatch)
        ));
        let bucket = dir.path().join("11").join("11");
        let leftover: Vec<_> = std::fs::read_dir(&bucket)
            .unwrap()
            .filter_map(Result::ok)
            .collect();
        assert!(leftover.is_empty(), "temp file leaked after hash mismatch");

        let sha = sha256_hex(&data);
        assert_eq!(
            store
                .put_stream(&sha, http_body_util::Full::new(data.clone()), false, Duration::from_secs(2))
                .await
                .unwrap(),
            PutOutcome::Stored
        );
        assert_eq!(
            store
                .put_stream(&sha, http_body_util::Full::new(data.clone()), false, Duration::from_secs(2))
                .await
                .unwrap(),
            PutOutcome::Exists
        );

        let read = store.get_or_stream(&sha, AcceptedEncodings::IDENTITY).await.unwrap();
        let streamed = match read {
            BlobRead::Stream {
                file,
                len,
                total,
                encoding,
                expected_sha256,
            } => {
                assert_eq!(len, data.len());
                assert_eq!(total, data.len());
                assert_eq!(encoding, ContentEncoding::Identity);
                assert_eq!(expected_sha256.as_deref(), Some(sha.as_str()));
                stream_file_body(file, len, expected_sha256)
                    .collect()
                    .await
                    .unwrap()
                    .to_bytes()
            }
            BlobRead::Buffered(_) => panic!("expected streaming read above threshold"),
        };
        assert_eq!(streamed, data);

        let range = store.get_range_or_stream(&sha, 100, 199).await.unwrap();
        let range_bytes = match range {
            BlobRangeRead::Stream { file, len, total } => {
                assert_eq!(len, 100);
                assert_eq!(total, data.len());
                stream_file_body(file, len, None)
                    .collect()
                    .await
                    .unwrap()
                    .to_bytes()
            }
            BlobRangeRead::Buffered(_, _) => panic!("expected streaming range above threshold"),
        };
        assert_eq!(range_bytes.len(), 100);
    }

    struct PendingBody;

    impl Body for PendingBody {
        type Data = Bytes;
        type Error = std::convert::Infallible;

        fn poll_frame(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
            Poll::Pending
        }
    }

    struct ChunkListBody {
        chunks: std::collections::VecDeque<Bytes>,
    }

    impl Body for ChunkListBody {
        type Data = Bytes;
        type Error = std::convert::Infallible;

        fn poll_frame(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
            Poll::Ready(self.chunks.pop_front().map(|c| Ok(Frame::data(c))))
        }
    }

    #[tokio::test]
    async fn put_stream_enforces_frame_timeout_and_size_limit_with_temp_cleanup() {
        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().to_path_buf(), 64 * 512, 2048);

        let timeout_sha = "2".repeat(64);
        assert!(matches!(
            store
                .put_stream(&timeout_sha, PendingBody, false, Duration::from_millis(40))
                .await,
            Err(BlobError::Timeout)
        ));
        let bucket2 = dir.path().join("22").join("22");
        assert!(std::fs::read_dir(&bucket2).unwrap().next().is_none());

        let too_large_sha = "3".repeat(64);
        let chunks = ChunkListBody {
            chunks: std::collections::VecDeque::from([
                Bytes::from(vec![b'a'; 1500]),
                Bytes::from(vec![b'b'; 1000]),
            ]),
        };
        assert!(matches!(
            store
                .put_stream(&too_large_sha, chunks, false, Duration::from_secs(2))
                .await,
            Err(BlobError::TooLarge)
        ));
        let bucket3 = dir.path().join("33").join("33");
        assert!(std::fs::read_dir(&bucket3).unwrap().next().is_none());
    }

    #[tokio::test]
    async fn get_or_stream_serves_sidecars_and_aborts_corrupt_raw_blobs_above_threshold() {
        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().to_path_buf(), 64 * 512, 256 * 1024)
            .with_stream_threshold(1024);
        let text = Bytes::from("console.log('qorpera web router streaming sidecar');\n".repeat(120));
        let sha = sha256_hex(&text);

        assert_eq!(
            store
                .put_stream(&sha, http_body_util::Full::new(text.clone()), true, Duration::from_secs(2))
                .await
                .unwrap(),
            PutOutcome::Stored
        );

        let br_read = store
            .get_or_stream(&sha, AcceptedEncodings::from_header("gzip, br, zstd"))
            .await
            .unwrap();
        match br_read {
            BlobRead::Stream {
                file,
                len,
                total,
                encoding,
                expected_sha256,
            } => {
                assert_eq!(encoding, ContentEncoding::Brotli);
                assert_eq!(total, text.len());
                assert!(len < text.len());
                assert!(expected_sha256.is_none());
                let compressed = stream_file_body(file, len, expected_sha256)
                    .collect()
                    .await
                    .unwrap()
                    .to_bytes();
                assert_eq!(compressed.len(), len);
            }
            BlobRead::Buffered(_) => panic!("expected streaming sidecar above threshold"),
        }

        let raw_path = dir.path().join(&sha[0..2]).join(&sha[2..4]).join(&sha);
        let mut tampered = text.to_vec();
        let last_idx = tampered.len() - 1;
        tampered[last_idx] ^= 0xff;
        tokio::fs::write(&raw_path, &tampered).await.unwrap();

        let corrupt_read = store.get_or_stream(&sha, AcceptedEncodings::IDENTITY).await.unwrap();
        match corrupt_read {
            BlobRead::Stream {
                file,
                len,
                expected_sha256,
                ..
            } => {
                let err = stream_file_body(file, len, expected_sha256)
                    .collect()
                    .await
                    .unwrap_err();
                assert!(
                    err.to_string().contains("sha256 mismatch"),
                    "expected sha256 mismatch error, got: {err}"
                );
            }
            BlobRead::Buffered(_) => panic!("expected streaming raw read above threshold"),
        }
    }

    #[tokio::test]
    async fn compress_pool_enforces_queue_bound_and_completes_burst() {
        let pool = Arc::new(CompressPool::with_limits(1, 2));
        let payload = Bytes::from("compressible-payload-".repeat(256));

        let held1 = Arc::clone(&pool.queue_sem).acquire_owned().await.unwrap();
        let held2 = Arc::clone(&pool.queue_sem).acquire_owned().await.unwrap();
        let blocked = {
            let p = Arc::clone(&pool);
            let data = payload.clone();
            tokio::spawn(async move { p.compress(data).await.unwrap() })
        };
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(!blocked.is_finished(), "compress must wait when queue bound is full");
        drop(held1);
        drop(held2);
        let first = blocked.await.unwrap();
        assert!(first.brotli.is_some());

        let mut tasks = Vec::new();
        for _ in 0..8 {
            let p = Arc::clone(&pool);
            let data = payload.clone();
            tasks.push(tokio::spawn(async move { p.compress(data).await.unwrap() }));
        }
        for task in tasks {
            let variants = task.await.unwrap();
            assert!(variants.gzip.is_some());
            assert!(variants.brotli.is_some());
            assert!(variants.zstd.is_some());
        }
        assert_eq!(pool.queue_sem.available_permits(), 2);
    }
}
