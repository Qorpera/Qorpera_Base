use crate::proxy::{BoxBody, BoxBodyError};
use bytes::{Bytes, BytesMut};
use flate2::{write::GzEncoder, Compression};
use http_body_util::BodyExt;
use hyper::body::{Body, Frame};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
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
const STREAM_TO_DISK_THRESHOLD: usize = 4 * 1024 * 1024;
const BLOCKING_OFFLOAD_THRESHOLD: usize = 16 * 1024;
const CACHE_SHARDS: usize = 64;
const MAX_CONCURRENT_PRECOMPRESS: usize = 2;
const MAX_COMPRESS_QUEUE: usize = 32;
const MAX_BG_PRECOMPRESS_QUEUE: usize = 1024;
const MAX_BG_PRECOMPRESS_BYTES: usize = 64 * 1024 * 1024;
const MAX_STREAM_COMPRESS_CONCURRENCY: usize = MAX_CONCURRENT_PRECOMPRESS;
const MAX_STREAM_INCOMPRESSIBLE_CACHE: usize = 4096;
const BATCH_WRITE_CONCURRENCY: usize = 16;
const ENTRY_STRUCTURAL_OVERHEAD: usize = 256;
const STREAM_CHUNK_BYTES: usize = 64 * 1024;
const BROTLI_QUALITY: i32 = 4;
const BROTLI_MAX_WINDOW: u32 = 22;
const ZSTD_LEVEL: i32 = 5;

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

    fn bit(self) -> u8 {
        match self {
            ContentEncoding::Identity => 1 << 0,
            ContentEncoding::Gzip => 1 << 1,
            ContentEncoding::Brotli => 1 << 2,
            ContentEncoding::Zstd => 1 << 3,
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

const BIT_RAW: u8 = 1 << 0;
const BIT_GZIP: u8 = 1 << 1;
const BIT_BROTLI: u8 = 1 << 2;
const BIT_ZSTD: u8 = 1 << 3;
const BIT_ALL: u8 = BIT_RAW | BIT_GZIP | BIT_BROTLI | BIT_ZSTD;

#[derive(Clone)]
struct CachedBlob {
    raw_len: usize,
    raw: Option<Bytes>,
    gzip: Option<Bytes>,
    brotli: Option<Bytes>,
    zstd: Option<Bytes>,
    probed_mask: u8,
    accounted_bytes: usize,
}

impl CachedBlob {
    fn from_parts(
        raw_len: usize,
        raw: Option<Bytes>,
        gzip: Option<Bytes>,
        brotli: Option<Bytes>,
        zstd: Option<Bytes>,
        probed_mask: u8,
    ) -> Self {
        // WHY: Account for HashMap, Arc, and SIEVE node overhead so tiny blobs cannot bypass max_cache_bytes.
        let accounted_bytes = ENTRY_STRUCTURAL_OVERHEAD
            + raw.as_ref().map_or(0, Bytes::len)
            + gzip.as_ref().map_or(0, Bytes::len)
            + brotli.as_ref().map_or(0, Bytes::len)
            + zstd.as_ref().map_or(0, Bytes::len);
        Self {
            raw_len,
            raw,
            gzip,
            brotli,
            zstd,
            probed_mask,
            accounted_bytes,
        }
    }

    #[cfg(test)]
    fn new(raw: Bytes, gzip: Option<Bytes>, brotli: Option<Bytes>, zstd: Option<Bytes>) -> Self {
        let raw_len = raw.len();
        Self::from_parts(raw_len, Some(raw), gzip, brotli, zstd, BIT_ALL)
    }

    fn warm_after_put(raw: Bytes, brotli: Option<Bytes>) -> Self {
        let raw_len = raw.len();
        if let Some(br) = brotli {
            Self::from_parts(raw_len, None, None, Some(br), None, BIT_BROTLI)
        } else {
            Self::from_parts(raw_len, Some(raw), None, None, None, BIT_ALL)
        }
    }

    fn warm_raw_pending(raw: Bytes, compressible: bool) -> Self {
        let raw_len = raw.len();
        let mask = if compressible { BIT_RAW } else { BIT_ALL };
        Self::from_parts(raw_len, Some(raw), None, None, None, mask)
    }

    fn variant(&self, encoding: ContentEncoding) -> Option<&Bytes> {
        match encoding {
            ContentEncoding::Identity => self.raw.as_ref(),
            ContentEncoding::Gzip => self.gzip.as_ref(),
            ContentEncoding::Brotli => self.brotli.as_ref(),
            ContentEncoding::Zstd => self.zstd.as_ref(),
        }
    }

    fn set_variant(&mut self, encoding: ContentEncoding, bytes: Option<Bytes>) {
        self.probed_mask |= encoding.bit();
        match encoding {
            ContentEncoding::Identity => self.raw = bytes,
            ContentEncoding::Gzip => self.gzip = bytes,
            ContentEncoding::Brotli => self.brotli = bytes,
            ContentEncoding::Zstd => self.zstd = bytes,
        }
        self.accounted_bytes = ENTRY_STRUCTURAL_OVERHEAD
            + self.raw.as_ref().map_or(0, Bytes::len)
            + self.gzip.as_ref().map_or(0, Bytes::len)
            + self.brotli.as_ref().map_or(0, Bytes::len)
            + self.zstd.as_ref().map_or(0, Bytes::len);
    }

    fn try_payload(&self, accepted: AcceptedEncodings) -> Option<BlobPayload> {
        for (enc, _) in accepted.ranked_sidecars().into_iter().flatten() {
            if (self.probed_mask & enc.bit()) == 0 {
                return None;
            }
            if let Some(bytes) = self.variant(enc) {
                return Some(BlobPayload {
                    bytes: bytes.clone(),
                    raw_len: self.raw_len,
                    encoding: enc,
                });
            }
        }
        self.raw.as_ref().map(|bytes| BlobPayload {
            bytes: bytes.clone(),
            raw_len: self.raw_len,
            encoding: ContentEncoding::Identity,
        })
    }

    fn to_payload(&self, accepted: AcceptedEncodings) -> Option<BlobPayload> {
        self.try_payload(accepted)
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
        let payload = entry.value.try_payload(accepted)?;
        if !entry.visited.load(Ordering::Relaxed) {
            entry.visited.store(true, Ordering::Relaxed);
        }
        Some(payload)
    }

    fn get_cached_entry(&self, key: &str) -> Option<CachedBlob> {
        let guard = self.inner.read().ok()?;
        let &idx = guard.index.get(key)?;
        Some(guard.nodes[idx].as_ref()?.entry.value.clone())
    }

    fn insert(&self, key: &str, blob: CachedBlob) {
        if let Ok(mut guard) = self.inner.write() {
            guard.insert(Arc::from(key), blob);
        }
    }

    fn upgrade_if_present(&self, key: &str, brotli: Option<Bytes>) {
        if let Ok(mut guard) = self.inner.write() {
            let Some(&idx) = guard.index.get(key) else {
                return;
            };
            let Some(raw_len) = guard.nodes[idx].as_ref().map(|n| n.entry.value.raw_len) else {
                return;
            };
            let upgraded = if let Some(br) = brotli {
                CachedBlob::from_parts(raw_len, None, None, Some(br), None, BIT_BROTLI)
            } else {
                let raw = guard.nodes[idx].as_ref().and_then(|n| n.entry.value.raw.clone());
                CachedBlob::from_parts(raw_len, raw, None, None, None, BIT_ALL)
            };
            if upgraded.accounted_bytes <= PUT_CACHE_WARM_MAX_BYTES {
                guard.insert(Arc::from(key), upgraded);
            }
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

fn dir_bucket_key(sha256: &str) -> u16 {
    let b = sha256.as_bytes();
    let p0 = (hex_nibble(b[0]) << 4) | hex_nibble(b[1]);
    let p1 = (hex_nibble(b[2]) << 4) | hex_nibble(b[3]);
    ((p0 as u16) << 8) | (p1 as u16)
}

struct BgCompressJob {
    sha256: String,
    path: PathBuf,
    raw: Bytes,
    shard_idx: usize,
    _slot_permit: OwnedSemaphorePermit,
    _byte_permit: OwnedSemaphorePermit,
}

struct BackgroundPrecompress {
    tx: Mutex<Option<std_mpsc::SyncSender<BgCompressJob>>>,
    slots: Arc<Semaphore>,
    bytes: Arc<Semaphore>,
    shards: Arc<Vec<WaitFreeShard>>,
}

impl BackgroundPrecompress {
    fn new(shards: Arc<Vec<WaitFreeShard>>) -> Self {
        Self {
            tx: Mutex::new(None),
            slots: Arc::new(Semaphore::new(MAX_BG_PRECOMPRESS_QUEUE)),
            bytes: Arc::new(Semaphore::new(MAX_BG_PRECOMPRESS_BYTES)),
            shards,
        }
    }

    fn enqueue(&self, sha256: String, path: PathBuf, raw: Bytes, shard_idx: usize) {
        let Ok(slot_permit) = Arc::clone(&self.slots).try_acquire_owned() else {
            return;
        };
        let need_bytes = (raw.len().max(1).min(MAX_BG_PRECOMPRESS_BYTES)) as u32;
        let Ok(byte_permit) = Arc::clone(&self.bytes).try_acquire_many_owned(need_bytes) else {
            return;
        };
        let sender = {
            let Ok(mut guard) = self.tx.lock() else {
                return;
            };
            if let Some(ref tx) = *guard {
                tx.clone()
            } else {
                let workers = std::thread::available_parallelism()
                    .map_or(2, |n| n.get().clamp(2, 4));
                let (tx, rx) = std_mpsc::sync_channel::<BgCompressJob>(MAX_BG_PRECOMPRESS_QUEUE);
                let shared_rx = Arc::new(Mutex::new(rx));
                for idx in 0..workers {
                    let rx_ref = Arc::clone(&shared_rx);
                    let shards_ref = Arc::clone(&self.shards);
                    let _ = std::thread::Builder::new()
                        .name(format!("qorpera-bg-compress-{idx}"))
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
                                let BgCompressJob {
                                    sha256,
                                    path,
                                    raw,
                                    shard_idx,
                                    _slot_permit,
                                    _byte_permit,
                                } = job;
                                let brotli = compress_brotli_if_smaller(&raw);
                                if let Some(ref br) = brotli {
                                    let _ = write_atomic_sync(&BlobStore::sidecar_path(&path, ".br"), br, false);
                                }
                                shards_ref[shard_idx].upgrade_if_present(&sha256, brotli);
                                if let Some(ref zs) = compress_zstd_if_smaller(&raw, zstd_ctx.as_mut()) {
                                    let _ = write_atomic_sync(&BlobStore::sidecar_path(&path, ".zst"), zs, false);
                                }
                                if let Some(ref gz) = compress_gzip_if_smaller(&raw) {
                                    let _ = write_atomic_sync(&BlobStore::sidecar_path(&path, ".gz"), gz, false);
                                }
                                drop(_byte_permit);
                                drop(_slot_permit);
                            }
                        });
                }
                *guard = Some(tx.clone());
                tx
            }
        };
        let _ = sender.try_send(BgCompressJob {
            sha256,
            path,
            raw,
            shard_idx,
            _slot_permit: slot_permit,
            _byte_permit: byte_permit,
        });
    }
}

struct StreamSidecarGuard<'a> {
    map: &'a Mutex<HashMap<String, broadcast::Sender<()>>>,
    key: String,
}

impl Drop for StreamSidecarGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.map.lock() {
            if let Some(tx) = guard.remove(&self.key) {
                let _ = tx.send(());
            }
        }
    }
}

pub struct BlobStore {
    root: PathBuf,
    max_blob_bytes: usize,
    max_cache_bytes: usize,
    stream_threshold_bytes: usize,
    shards: Arc<Vec<WaitFreeShard>>,
    inflight: Mutex<HashMap<String, broadcast::Sender<ReadResult>>>,
    compress_pool: CompressPool,
    bg_compress: BackgroundPrecompress,
    created_dirs: Arc<RwLock<HashSet<u16>>>,
    stream_compress_sem: Arc<Semaphore>,
    stream_sidecar_inflight: Mutex<HashMap<String, broadcast::Sender<()>>>,
    stream_sidecar_skip: Mutex<HashSet<String>>,
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
        let shards = Arc::new(shards);
        let bg_compress = BackgroundPrecompress::new(Arc::clone(&shards));
        Self {
            root,
            max_blob_bytes,
            max_cache_bytes,
            stream_threshold_bytes: DEFAULT_STREAM_THRESHOLD_BYTES,
            shards,
            inflight: Mutex::new(HashMap::new()),
            compress_pool: CompressPool::new(),
            bg_compress,
            created_dirs: Arc::new(RwLock::new(HashSet::new())),
            stream_compress_sem: Arc::new(Semaphore::new(MAX_STREAM_COMPRESS_CONCURRENCY)),
            stream_sidecar_inflight: Mutex::new(HashMap::new()),
            stream_sidecar_skip: Mutex::new(HashSet::new()),
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

    // WHY: Check a batch of blob digests in one blocking pass after memory-shard hits to avoid N HTTP HEAD round-trips on deploys.
    pub async fn exists_batch(&self, hashes: &[String]) -> Result<Vec<String>, BlobError> {
        let mut seen = std::collections::HashSet::with_capacity(hashes.len());
        let mut existing = Vec::new();
        let mut to_stat: Vec<(String, PathBuf)> = Vec::new();
        for sha256 in hashes {
            let path = self.blob_path(sha256)?;
            if !seen.insert(sha256.as_str()) {
                continue;
            }
            let shard_idx = shard_for_sha(sha256);
            if self.shards[shard_idx].contains(sha256) {
                existing.push(sha256.clone());
            } else {
                to_stat.push((sha256.clone(), path));
            }
        }
        if to_stat.is_empty() {
            return Ok(existing);
        }
        let disk_hits = tokio::task::spawn_blocking(move || -> Result<Vec<String>, std::io::Error> {
            let mut hits = Vec::new();
            for (sha256, path) in to_stat {
                match std::fs::metadata(&path) {
                    Ok(meta) if meta.is_file() => hits.push(sha256),
                    Ok(_) => {}
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                    Err(err) => return Err(err),
                }
            }
            Ok(hits)
        })
        .await
        .map_err(|e| BlobError::Io(std::io::Error::other(e.to_string())))?
        .map_err(BlobError::Io)?;
        existing.extend(disk_hits);
        Ok(existing)
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

        if bytes.len() <= self.direct_cache_limit() {
            let cached = CachedBlob::warm_after_put(bytes, variants.brotli);
            if cached.accounted_bytes <= PUT_CACHE_WARM_MAX_BYTES {
                self.shards[shard_idx].insert(sha256, cached);
            }
        }
        Ok(PutOutcome::Stored)
    }

    fn ensure_parent_dir_sync(
        created_dirs: &RwLock<HashSet<u16>>,
        sha256: &str,
        path: &Path,
    ) -> Result<(), BlobError> {
        let key = dir_bucket_key(sha256);
        if created_dirs.read().ok().is_some_and(|g| g.contains(&key)) {
            return Ok(());
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if let Ok(mut g) = created_dirs.write() {
            g.insert(key);
        }
        Ok(())
    }

    fn finish_stored_bytes(&self, sha256: &str, path: PathBuf, bytes: Bytes, precompress: bool) {
        let shard_idx = shard_for_sha(sha256);
        let compressible = precompress
            && bytes.len() >= COMPRESS_MIN_BYTES
            && bytes.len() <= PRECOMPRESS_MAX_BYTES
            && !is_likely_incompressible(&bytes);
        if bytes.len() <= self.direct_cache_limit() && bytes.len() + ENTRY_STRUCTURAL_OVERHEAD <= PUT_CACHE_WARM_MAX_BYTES {
            self.shards[shard_idx].insert(sha256, CachedBlob::warm_raw_pending(bytes.clone(), compressible));
        }
        if compressible {
            self.bg_compress.enqueue(sha256.to_string(), path, bytes, shard_idx);
        }
    }

    pub async fn put_batch(
        &self,
        items: Vec<(String, Bytes)>,
        precompress: bool,
    ) -> Result<(usize, usize), BlobError> {
        let mut prepared = Vec::with_capacity(items.len());
        for (sha256, bytes) in items {
            let path = self.blob_path(&sha256)?;
            if bytes.len() > self.max_blob_bytes {
                return Err(BlobError::TooLarge);
            }
            prepared.push((sha256, path, bytes));
        }
        let sem = Arc::new(Semaphore::new(BATCH_WRITE_CONCURRENCY));
        let mut handles = Vec::with_capacity(prepared.len());
        for (sha256, path, bytes) in prepared {
            let permit = Arc::clone(&sem)
                .acquire_owned()
                .await
                .map_err(|_| BlobError::Io(std::io::Error::other("batch semaphore closed")))?;
            let shards = Arc::clone(&self.shards);
            let created_dirs = Arc::clone(&self.created_dirs);
            let shard_idx = shard_for_sha(&sha256);
            handles.push(tokio::task::spawn_blocking(move || -> Result<(PutOutcome, String, PathBuf, Bytes), BlobError> {
                let _permit = permit;
                if sha256_hex(&bytes) != sha256 {
                    return Err(BlobError::HashMismatch);
                }
                if shards[shard_idx].contains(&sha256)
                    || std::fs::metadata(&path).map_or(false, |m| m.is_file())
                {
                    return Ok((PutOutcome::Exists, sha256, path, bytes));
                }
                Self::ensure_parent_dir_sync(&created_dirs, &sha256, &path)?;
                if let Err(err) = write_atomic_sync(&path, &bytes, true) {
                    if let Some(parent) = path.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    write_atomic_sync(&path, &bytes, true).map_err(|_| err)?;
                }
                Ok((PutOutcome::Stored, sha256, path, bytes))
            }));
        }
        let mut stored = 0usize;
        let mut exists = 0usize;
        for handle in handles {
            let (outcome, sha256, path, bytes) = handle
                .await
                .map_err(|e| BlobError::Io(std::io::Error::other(e.to_string())))??;
            match outcome {
                PutOutcome::Stored => {
                    stored += 1;
                    self.finish_stored_bytes(&sha256, path, bytes, precompress);
                }
                PutOutcome::Exists => {
                    exists += 1;
                }
            }
        }
        Ok((stored, exists))
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
        let dir_key = dir_bucket_key(sha256);
        let dir_known = self.created_dirs.read().ok().is_some_and(|g| g.contains(&dir_key));
        if !dir_known {
            if let Some(parent) = path.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            if let Ok(mut g) = self.created_dirs.write() {
                g.insert(dir_key);
            }
        }

        let mut hasher = Sha256::new();
        let mut total_bytes = 0usize;
        let mut mem_buf: Option<Vec<u8>> = Some(Vec::new());
        let mut spill_file: Option<(BufWriter<tokio::fs::File>, TempFileGuard)> = None;
        let mut small_buf: Option<Vec<u8>> = Some(Vec::new());

        loop {
            let next_frame = match tokio::time::timeout(frame_timeout, body.frame()).await {
                Ok(frame) => frame,
                Err(_) => {
                    if let Some((f, mut g)) = spill_file.take() {
                        drop(f);
                        g.remove_now().await;
                    }
                    return Err(BlobError::Timeout);
                }
            };
            let Some(frame_res) = next_frame else {
                break;
            };
            let frame = match frame_res {
                Ok(f) => f,
                Err(_) => {
                    if let Some((f, mut g)) = spill_file.take() {
                        drop(f);
                        g.remove_now().await;
                    }
                    return Err(BlobError::BodyRead);
                }
            };
            if let Ok(chunk) = frame.into_data() {
                if chunk.is_empty() {
                    continue;
                }
                let Some(next_total) = total_bytes.checked_add(chunk.len()) else {
                    if let Some((f, mut g)) = spill_file.take() {
                        drop(f);
                        g.remove_now().await;
                    }
                    return Err(BlobError::TooLarge);
                };
                if next_total > self.max_blob_bytes {
                    if let Some((f, mut g)) = spill_file.take() {
                        drop(f);
                        g.remove_now().await;
                    }
                    return Err(BlobError::TooLarge);
                }
                total_bytes = next_total;
                hasher.update(&chunk);
                if let Some(ref mut buf) = mem_buf {
                    if total_bytes <= STREAM_TO_DISK_THRESHOLD {
                        buf.extend_from_slice(&chunk);
                    } else {
                        // WHY: Spill uploads above 4 MiB to a guarded temp file so large PUTs up to 100 MiB stay bounded in RAM.
                        let spilled = mem_buf.take().unwrap_or_default();
                        let tmp = unique_temp_path(&path);
                        let mut guard = TempFileGuard::new(tmp.clone());
                        let mut writer =
                            BufWriter::with_capacity(256 * 1024, tokio::fs::File::create(&tmp).await?);
                        if let Err(err) = writer.write_all(&spilled).await {
                            drop(writer);
                            guard.remove_now().await;
                            return Err(BlobError::Io(err));
                        }
                        if let Err(err) = writer.write_all(&chunk).await {
                            drop(writer);
                            guard.remove_now().await;
                            return Err(BlobError::Io(err));
                        }
                        if total_bytes <= PRECOMPRESS_MAX_BYTES {
                            let mut sb = spilled;
                            sb.extend_from_slice(&chunk);
                            small_buf = Some(sb);
                        } else {
                            small_buf = None;
                        }
                        spill_file = Some((writer, guard));
                    }
                } else if let Some((ref mut writer, _)) = spill_file {
                    if let Err(err) = writer.write_all(&chunk).await {
                        if let Some((f, mut g)) = spill_file.take() {
                            drop(f);
                            g.remove_now().await;
                        }
                        return Err(BlobError::Io(err));
                    }
                    if let Some(ref mut sb) = small_buf {
                        if total_bytes <= PRECOMPRESS_MAX_BYTES {
                            sb.extend_from_slice(&chunk);
                        } else {
                            small_buf = None;
                        }
                    }
                }
            }
        }

        let actual_sha = hex::encode(hasher.finalize());
        if actual_sha != sha256 {
            if let Some((f, mut g)) = spill_file.take() {
                drop(f);
                g.remove_now().await;
            }
            return Err(BlobError::HashMismatch);
        }

        let shard_idx = shard_for_sha(sha256);
        if let Some(buf) = mem_buf {
            let bytes = Bytes::from(buf);
            if self.shards[shard_idx].contains(sha256) {
                return Ok(PutOutcome::Exists);
            }
            let write_path = path.clone();
            let write_bytes = bytes.clone();
            let write_sha = sha256.to_string();
            let created_dirs = Arc::clone(&self.created_dirs);
            let outcome = tokio::task::spawn_blocking(move || -> Result<PutOutcome, BlobError> {
                if std::fs::metadata(&write_path).map_or(false, |m| m.is_file()) {
                    return Ok(PutOutcome::Exists);
                }
                Self::ensure_parent_dir_sync(&created_dirs, &write_sha, &write_path)?;
                if let Err(err) = write_atomic_sync(&write_path, &write_bytes, true) {
                    if let Some(parent) = write_path.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    write_atomic_sync(&write_path, &write_bytes, true).map_err(|_| err)?;
                }
                Ok(PutOutcome::Stored)
            })
            .await
            .map_err(|e| BlobError::Io(std::io::Error::other(e.to_string())))??;
            if outcome == PutOutcome::Stored {
                self.finish_stored_bytes(sha256, path, bytes, precompress);
            }
            return Ok(outcome);
        }

        let Some((mut file, mut guard)) = spill_file.take() else {
            return Err(BlobError::Io(std::io::Error::other("missing spill file")));
        };
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
        if let Err(err) = tokio::fs::rename(guard.path.as_ref().unwrap(), &path).await {
            guard.remove_now().await;
            return Err(BlobError::Io(err));
        }
        guard.defuse();
        if let Some(buf) = small_buf {
            self.finish_stored_bytes(sha256, path, Bytes::from(buf), precompress);
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
                let ranked = accepted.ranked_sidecars();
                let mut found_sidecar = None;
                for (idx, (encoding, ext)) in ranked.into_iter().flatten().enumerate() {
                    let sidecar_path = Self::sidecar_path(&path, ext);
                    if let Ok(sidecar_file) = tokio::fs::File::open(&sidecar_path).await {
                        if let Ok(sidecar_meta) = sidecar_file.metadata().await {
                            if sidecar_meta.is_file() {
                                found_sidecar = Some((
                                    idx,
                                    encoding,
                                    sidecar_file,
                                    sidecar_meta.len() as usize,
                                ));
                                break;
                            }
                        }
                    }
                }
                if let Some((idx, encoding, sidecar_file, sidecar_len)) = found_sidecar {
                    if idx > 0 {
                        for (hi_enc, hi_ext) in ranked.into_iter().flatten().take(idx) {
                            let hi_path = Self::sidecar_path(&path, hi_ext);
                            if let Ok(hi_file) = tokio::fs::File::open(&hi_path).await {
                                if let Ok(hi_meta) = hi_file.metadata().await {
                                    if hi_meta.is_file() {
                                        return Ok(BlobRead::Stream {
                                            file: hi_file,
                                            len: hi_meta.len() as usize,
                                            total,
                                            encoding: hi_enc,
                                            expected_sha256: None,
                                        });
                                    }
                                }
                            }
                        }
                    }
                    return Ok(BlobRead::Stream {
                        file: sidecar_file,
                        len: sidecar_len,
                        total,
                        encoding,
                        expected_sha256: None,
                    });
                }
                if total >= COMPRESS_MIN_BYTES {
                    if let Some((encoding, ext)) = ranked.into_iter().flatten().next() {
                        let sidecar_key = format!("{sha256}{ext}");
                        let skipped = self
                            .stream_sidecar_skip
                            .lock()
                            .ok()
                            .is_some_and(|set| set.contains(&sidecar_key));
                        if !skipped {
                            let existing_rx = {
                                self.stream_sidecar_inflight.lock().ok().and_then(|mut map| {
                                    if let Some(tx) = map.get(&sidecar_key) {
                                        Some(tx.subscribe())
                                    } else {
                                        let (tx, _) = broadcast::channel(4);
                                        map.insert(sidecar_key.clone(), tx);
                                        None
                                    }
                                })
                            };
                            if let Some(mut rx) = existing_rx {
                                let _ = rx.recv().await;
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
                            } else {
                                let _guard = StreamSidecarGuard {
                                    map: &self.stream_sidecar_inflight,
                                    key: sidecar_key.clone(),
                                };
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
                                if let Ok(_permit) = Arc::clone(&self.stream_compress_sem).acquire_owned().await {
                                    if let Ok(raw) = self.read_verified_raw(&path, sha256).await {
                                        let compressed = if is_likely_incompressible(&raw) {
                                            None
                                        } else {
                                            let raw_clone = raw.clone();
                                            tokio::task::spawn_blocking(move || {
                                                compress_bytes_for_encoding(&raw_clone, encoding)
                                            })
                                            .await
                                            .ok()
                                            .flatten()
                                        };
                                        if let Some(comp) = compressed {
                                            if write_atomic(&sidecar_path, &comp, false).await.is_ok() {
                                                if let Ok(sidecar_file) =
                                                    tokio::fs::File::open(&sidecar_path).await
                                                {
                                                    return Ok(BlobRead::Stream {
                                                        file: sidecar_file,
                                                        len: comp.len(),
                                                        total,
                                                        encoding,
                                                        expected_sha256: None,
                                                    });
                                                }
                                            }
                                        } else if let Ok(mut skip) = self.stream_sidecar_skip.lock() {
                                            if skip.len() >= MAX_STREAM_INCOMPRESSIBLE_CACHE {
                                                skip.clear();
                                            }
                                            skip.insert(sidecar_key);
                                        }
                                    }
                                }
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
                Ok(ReadResult::Ok(blob)) => {
                    if let Some(payload) = blob.to_payload(accepted) {
                        Ok(payload)
                    } else {
                        Box::pin(self.get_encoded(sha256, accepted)).await
                    }
                }
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

        // WHY: Re-check cache and probe missing sidecars under the single-flight guard to avoid concurrent sidecar read stampedes.
        if let Some(mut entry) = self.shards[shard_idx].get_cached_entry(sha256) {
            if let Some(payload) = entry.to_payload(accepted) {
                guard.finish(ReadResult::Ok(entry));
                return Ok(payload);
            }
            let ranked = accepted.ranked_sidecars();
            for (idx, (enc, ext)) in ranked.into_iter().flatten().enumerate() {
                if (entry.probed_mask & enc.bit()) == 0 {
                    let loaded = tokio::fs::read(Self::sidecar_path(&path, ext))
                        .await
                        .ok()
                        .map(Bytes::from);
                    entry.set_variant(enc, loaded);
                }
                if let Some(bytes) = entry.variant(enc).cloned() {
                    if idx > 0 {
                        for (hi_enc, hi_ext) in ranked.into_iter().flatten().take(idx) {
                            if let Ok(hi_vec) = tokio::fs::read(Self::sidecar_path(&path, hi_ext)).await {
                                let hi_bytes = Bytes::from(hi_vec);
                                entry.set_variant(hi_enc, Some(hi_bytes.clone()));
                                let raw_len = entry.raw_len;
                                self.shards[shard_idx].insert(sha256, entry.clone());
                                guard.finish(ReadResult::Ok(entry));
                                return Ok(BlobPayload {
                                    bytes: hi_bytes,
                                    raw_len,
                                    encoding: hi_enc,
                                });
                            }
                        }
                    }
                    let raw_len = entry.raw_len;
                    self.shards[shard_idx].insert(sha256, entry.clone());
                    guard.finish(ReadResult::Ok(entry));
                    return Ok(BlobPayload {
                        bytes,
                        raw_len,
                        encoding: enc,
                    });
                }
            }
            if entry.raw.is_none() {
                let raw = match self.read_verified_raw(&path, sha256).await {
                    Ok(bytes) => bytes,
                    Err(BlobError::NotFound) => {
                        guard.finish(ReadResult::NotFound);
                        return Err(BlobError::NotFound);
                    }
                    Err(BlobError::CorruptOnDisk) => {
                        guard.finish(ReadResult::Corrupt);
                        return Err(BlobError::CorruptOnDisk);
                    }
                    Err(err) => {
                        guard.finish(ReadResult::Io(err.to_string()));
                        return Err(err);
                    }
                };
                entry.set_variant(ContentEncoding::Identity, Some(raw));
            }
            if let Some((top_enc, top_ext)) = ranked.into_iter().flatten().next() {
                if let Some(ref raw) = entry.raw {
                    if raw.len() >= COMPRESS_MIN_BYTES
                        && raw.len() <= PRECOMPRESS_MAX_BYTES
                        && !is_likely_incompressible(raw)
                    {
                        let compressed = compress_single_async(raw.clone(), top_enc).await;
                        entry.set_variant(top_enc, compressed.clone());
                        if let Some(comp) = compressed {
                            let sidecar_path = Self::sidecar_path(&path, top_ext);
                            let comp_disk = comp.clone();
                            tokio::spawn(async move {
                                let _ = write_atomic(&sidecar_path, &comp_disk, false).await;
                            });
                            let raw_len = entry.raw_len;
                            self.shards[shard_idx].insert(sha256, entry.clone());
                            guard.finish(ReadResult::Ok(entry));
                            return Ok(BlobPayload {
                                bytes: comp,
                                raw_len,
                                encoding: top_enc,
                            });
                        }
                    }
                }
            }
            if let Some(payload) = entry.to_payload(accepted) {
                self.shards[shard_idx].insert(sha256, entry.clone());
                guard.finish(ReadResult::Ok(entry));
                return Ok(payload);
            }
        }

        let raw = match self.read_verified_raw(&path, sha256).await {
            Ok(bytes) => bytes,
            Err(BlobError::NotFound) => {
                guard.finish(ReadResult::NotFound);
                return Err(BlobError::NotFound);
            }
            Err(BlobError::CorruptOnDisk) => {
                guard.finish(ReadResult::Corrupt);
                return Err(BlobError::CorruptOnDisk);
            }
            Err(err) => {
                guard.finish(ReadResult::Io(err.to_string()));
                return Err(err);
            }
        };

        let raw_len = raw.len();
        let can_sidecar = raw_len >= COMPRESS_MIN_BYTES
            && raw_len <= PRECOMPRESS_MAX_BYTES
            && !is_likely_incompressible(&raw);

        let mut cached = if can_sidecar {
            CachedBlob::from_parts(raw_len, None, None, None, None, 0)
        } else {
            CachedBlob::from_parts(raw_len, Some(raw.clone()), None, None, None, BIT_ALL)
        };

        let mut matched_sidecar = false;
        if can_sidecar {
            let ranked = accepted.ranked_sidecars();
            for (idx, (enc, ext)) in ranked.into_iter().flatten().enumerate() {
                let loaded = tokio::fs::read(Self::sidecar_path(&path, ext))
                    .await
                    .ok()
                    .map(Bytes::from);
                let found = loaded.is_some();
                cached.set_variant(enc, loaded);
                if found {
                    if idx > 0 {
                        for (hi_enc, hi_ext) in ranked.into_iter().flatten().take(idx) {
                            if let Ok(hi_vec) = tokio::fs::read(Self::sidecar_path(&path, hi_ext)).await {
                                cached.set_variant(hi_enc, Some(Bytes::from(hi_vec)));
                                break;
                            }
                        }
                    }
                    matched_sidecar = true;
                    break;
                }
            }
            if !matched_sidecar {
                if let Some((top_enc, top_ext)) = ranked.into_iter().flatten().next() {
                    let compressed = compress_single_async(raw.clone(), top_enc).await;
                    cached.set_variant(top_enc, compressed.clone());
                    if let Some(comp) = compressed {
                        let sidecar_path = Self::sidecar_path(&path, top_ext);
                        tokio::spawn(async move {
                            let _ = write_atomic(&sidecar_path, &comp, false).await;
                        });
                        matched_sidecar = true;
                    }
                }
            }
            if !matched_sidecar {
                cached.set_variant(ContentEncoding::Identity, Some(raw));
            }
        }

        let payload = cached
            .to_payload(accepted)
            .expect("cached blob must satisfy requested encoding");
        self.shards[shard_idx].insert(sha256, cached.clone());
        guard.finish(ReadResult::Ok(cached));
        Ok(payload)
    }

    async fn read_verified_raw(&self, path: &Path, sha256: &str) -> Result<Bytes, BlobError> {
        let raw_vec = match tokio::fs::read(path).await {
            Ok(v) => v,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Err(BlobError::NotFound),
            Err(err) => return Err(BlobError::Io(err)),
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
            return Err(BlobError::CorruptOnDisk);
        }
        Ok(raw)
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

pub fn compress_bytes_for_encoding(raw: &[u8], enc: ContentEncoding) -> Option<Bytes> {
    if raw.len() < COMPRESS_MIN_BYTES {
        return None;
    }
    match enc {
        ContentEncoding::Identity => None,
        ContentEncoding::Gzip => compress_gzip_if_smaller(raw),
        ContentEncoding::Brotli => compress_brotli_if_smaller(raw),
        ContentEncoding::Zstd => compress_zstd_if_smaller(raw, None),
    }
}

async fn compress_single_async(raw: Bytes, enc: ContentEncoding) -> Option<Bytes> {
    if raw.len() >= BLOCKING_OFFLOAD_THRESHOLD {
        tokio::task::spawn_blocking(move || compress_bytes_for_encoding(&raw, enc))
            .await
            .ok()
            .flatten()
    } else {
        compress_bytes_for_encoding(&raw, enc)
    }
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
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
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

fn write_atomic_sync(target: &Path, bytes: &[u8], sync_data: bool) -> Result<(), BlobError> {
    let tmp = unique_temp_path(target);
    let mut file = std::fs::File::create(&tmp)?;
    if let Err(err) = file.write_all(bytes) {
        drop(file);
        let _ = std::fs::remove_file(&tmp);
        return Err(BlobError::Io(err));
    }
    if sync_data {
        if let Err(err) = file.sync_data() {
            drop(file);
            let _ = std::fs::remove_file(&tmp);
            return Err(BlobError::Io(err));
        }
    }
    drop(file);
    match std::fs::rename(&tmp, target) {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = std::fs::remove_file(&tmp);
            Err(BlobError::Io(err))
        }
    }
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

    #[tokio::test]
    async fn lazy_single_variant_cache_warms_only_brotli_and_loads_others_on_demand() {
        let dir = tempdir().unwrap();
        let store = BlobStore::new(dir.path().to_path_buf(), 64 * 1024 * 1024, 1024 * 1024);
        let text = Bytes::from("export const app = 'qorpera lazy cache variant test';\n".repeat(400));
        let sha = sha256_hex(&text);

        assert_eq!(
            store.put(&sha, text.clone(), true).await.unwrap(),
            PutOutcome::Stored
        );

        let shard = shard_for_sha(&sha);
        let initial = store.shards[shard].get_cached_entry(&sha).expect("warmed in cache");
        assert!(initial.brotli.is_some());
        assert!(initial.raw.is_none());
        assert!(initial.gzip.is_none());
        assert!(initial.zstd.is_none());
        assert!(initial.accounted_bytes < text.len() / 4);

        let br = store
            .get_encoded(&sha, AcceptedEncodings::from_header("gzip, br, zstd"))
            .await
            .unwrap();
        assert_eq!(br.encoding, ContentEncoding::Brotli);
        assert_eq!(br.raw_len, text.len());

        let gz = store
            .get_encoded(&sha, AcceptedEncodings::GZIP_ONLY)
            .await
            .unwrap();
        assert_eq!(gz.encoding, ContentEncoding::Gzip);

        let raw = store
            .get_encoded(&sha, AcceptedEncodings::IDENTITY)
            .await
            .unwrap();
        assert_eq!(raw.encoding, ContentEncoding::Identity);
        assert_eq!(raw.bytes, text);
    }

    #[tokio::test]
    async fn get_or_stream_singleflights_and_caches_incompressible_blobs() {
        let dir = tempdir().unwrap();
        let store = Arc::new(
            BlobStore::new(dir.path().to_path_buf(), 64 * 512, 256 * 1024).with_stream_threshold(1024),
        );
        let compressible = Bytes::from("export const chunk = 'streaming-singleflight-sidecar';\n".repeat(160));
        let comp_sha = sha256_hex(&compressible);
        assert_eq!(
            store.put(&comp_sha, compressible.clone(), false).await.unwrap(),
            PutOutcome::Stored
        );

        let mut tasks = Vec::new();
        for _ in 0..8 {
            let s = Arc::clone(&store);
            let sha = comp_sha.clone();
            tasks.push(tokio::spawn(async move {
                s.get_or_stream(&sha, AcceptedEncodings::from_header("br, gzip"))
                    .await
                    .unwrap()
            }));
        }
        for task in tasks {
            match task.await.unwrap() {
                BlobRead::Stream { encoding, len, total, .. } => {
                    assert_eq!(encoding, ContentEncoding::Brotli);
                    assert_eq!(total, compressible.len());
                    assert!(len < compressible.len());
                }
                BlobRead::Buffered(_) => panic!("expected streaming sidecar"),
            }
        }
        assert!(store.stream_sidecar_inflight.lock().unwrap().is_empty());

        let mut state: u64 = 0x9e37_79b9_7f4a_7c15;
        let mut random_bytes = vec![b'A', b'A', b'A', b'A'];
        for _ in 0..8192 {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            random_bytes.push((state & 0xff) as u8);
        }
        let rand_payload = Bytes::from(random_bytes);
        let rand_sha = sha256_hex(&rand_payload);
        assert_eq!(
            store.put(&rand_sha, rand_payload.clone(), false).await.unwrap(),
            PutOutcome::Stored
        );
        let read = store
            .get_or_stream(&rand_sha, AcceptedEncodings::from_header("br"))
            .await
            .unwrap();
        assert!(matches!(read, BlobRead::Stream { encoding: ContentEncoding::Identity, .. }));
        assert!(store.stream_sidecar_skip.lock().unwrap().contains(&format!("{rand_sha}.br")));
        assert!(store.stream_sidecar_inflight.lock().unwrap().is_empty());
    }
}
