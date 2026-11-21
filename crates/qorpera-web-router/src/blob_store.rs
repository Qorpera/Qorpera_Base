use bytes::Bytes;
use flate2::{write::GzEncoder, Compression};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub const DEFAULT_MAX_CACHE_BYTES: usize = 256 * 1024 * 1024;
pub const DEFAULT_MAX_BLOB_BYTES: usize = 100 * 1024 * 1024;
const GZIP_MIN_BYTES: usize = 256;

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

struct CachedBlob {
    raw: Bytes,
    gzip: Option<Bytes>,
    accounted_bytes: usize,
}

struct LruState {
    entries: HashMap<String, CachedBlob>,
    order: VecDeque<String>,
    total_bytes: usize,
    max_bytes: usize,
}

impl LruState {
    fn new(max_bytes: usize) -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            total_bytes: 0,
            max_bytes,
        }
    }

    fn get(&mut self, key: &str, prefer_gzip: bool) -> Option<BlobPayload> {
        let entry = self.entries.get(key)?;
        let raw_len = entry.raw.len();
        let payload = if prefer_gzip {
            if let Some(gz) = &entry.gzip {
                BlobPayload {
                    bytes: gz.clone(),
                    raw_len,
                    encoding: ContentEncoding::Gzip,
                }
            } else {
                BlobPayload {
                    bytes: entry.raw.clone(),
                    raw_len,
                    encoding: ContentEncoding::Identity,
                }
            }
        } else {
            BlobPayload {
                bytes: entry.raw.clone(),
                raw_len,
                encoding: ContentEncoding::Identity,
            }
        };
        if let Some(pos) = self.order.iter().position(|k| k == key) {
            self.order.remove(pos);
        }
        self.order.push_back(key.to_string());
        Some(payload)
    }

    fn insert(&mut self, key: String, raw: Bytes, gzip: Option<Bytes>) {
        let accounted = raw.len() + gzip.as_ref().map_or(0, Bytes::len);
        if self.max_bytes == 0 || accounted > self.max_bytes {
            return;
        }
        if let Some(prev) = self.entries.remove(&key) {
            self.total_bytes = self.total_bytes.saturating_sub(prev.accounted_bytes);
            if let Some(pos) = self.order.iter().position(|k| k == &key) {
                self.order.remove(pos);
            }
        }
        while self.total_bytes + accounted > self.max_bytes {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(evicted) = self.entries.remove(&oldest) {
                self.total_bytes = self.total_bytes.saturating_sub(evicted.accounted_bytes);
            }
        }
        self.total_bytes += accounted;
        self.order.push_back(key.clone());
        self.entries.insert(
            key,
            CachedBlob {
                raw,
                gzip,
                accounted_bytes: accounted,
            },
        );
    }
}

pub struct BlobStore {
    root: PathBuf,
    max_blob_bytes: usize,
    cache: Mutex<LruState>,
}

impl BlobStore {
    pub fn new(root: PathBuf, max_cache_bytes: usize, max_blob_bytes: usize) -> Self {
        Self {
            root,
            max_blob_bytes,
            cache: Mutex::new(LruState::new(max_cache_bytes)),
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
        if sha256_hex(&bytes) != sha256 {
            return Err(BlobError::HashMismatch);
        }
        if tokio::fs::metadata(&path).await.map_or(false, |m| m.is_file()) {
            return Ok(PutOutcome::Exists);
        }
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        write_atomic(&path, &bytes).await?;

        let gzipped = if precompress_gzip && bytes.len() >= GZIP_MIN_BYTES {
            compress_if_smaller(&bytes)
        } else {
            None
        };
        if let Some(ref gz) = gzipped {
            let gz_path = Self::gzip_path(&path);
            let _ = write_atomic(&gz_path, gz).await;
        }
        if let Ok(mut guard) = self.cache.lock() {
            guard.insert(sha256.to_string(), bytes, gzipped);
        }
        Ok(PutOutcome::Stored)
    }

    pub async fn get(&self, sha256: &str, prefer_gzip: bool) -> Result<BlobPayload, BlobError> {
        let path = self.blob_path(sha256)?;
        if let Ok(mut guard) = self.cache.lock() {
            if let Some(hit) = guard.get(sha256, prefer_gzip) {
                return Ok(hit);
            }
        }
        let raw_vec = tokio::fs::read(&path).await?;
        if sha256_hex(&raw_vec) != sha256 {
            return Err(BlobError::CorruptOnDisk);
        }
        let raw = Bytes::from(raw_vec);
        let gz_path = Self::gzip_path(&path);
        let gzip = match tokio::fs::read(&gz_path).await {
            Ok(vec) => Some(Bytes::from(vec)),
            Err(_) => None,
        };
        let raw_len = raw.len();
        let payload = if prefer_gzip {
            if let Some(ref gz) = gzip {
                BlobPayload {
                    bytes: gz.clone(),
                    raw_len,
                    encoding: ContentEncoding::Gzip,
                }
            } else {
                BlobPayload {
                    bytes: raw.clone(),
                    raw_len,
                    encoding: ContentEncoding::Identity,
                }
            }
        } else {
            BlobPayload {
                bytes: raw.clone(),
                raw_len,
                encoding: ContentEncoding::Identity,
            }
        };
        if let Ok(mut guard) = self.cache.lock() {
            guard.insert(sha256.to_string(), raw, gzip);
        }
        Ok(payload)
    }

    pub async fn get_range(
        &self,
        sha256: &str,
        start: usize,
        end_inclusive: usize,
    ) -> Result<(Bytes, usize), BlobError> {
        let payload = self.get(sha256, false).await?;
        let total = payload.raw_len;
        if total == 0 || start >= total || start > end_inclusive {
            return Ok((Bytes::new(), total));
        }
        let capped_end = end_inclusive.min(total - 1);
        Ok((payload.bytes.slice(start..=capped_end), total))
    }
}

fn compress_if_smaller(raw: &[u8]) -> Option<Bytes> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(raw).ok()?;
    let compressed = encoder.finish().ok()?;
    if compressed.len() * 100 < raw.len() * 95 {
        Some(Bytes::from(compressed))
    } else {
        None
    }
}

async fn write_atomic(target: &Path, bytes: &[u8]) -> Result<(), BlobError> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let mut tmp = target.as_os_str().to_os_string();
    tmp.push(format!(".{}.{}.tmp", std::process::id(), nonce));
    let tmp_path = PathBuf::from(tmp);
    let write_res = async {
        let mut file = tokio::fs::File::create(&tmp_path).await?;
        tokio::io::AsyncWriteExt::write_all(&mut file, bytes).await?;
        file.sync_all().await?;
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
}
