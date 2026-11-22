use crate::routes::{EdgeSnapshot, SharedRoutes};
use sha2::{Digest, Sha256};
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tokio::sync::{mpsc, Notify};
use tokio_postgres_rustls::MakeRustlsConnect;
use tracing::{error, info, warn};

pub const ROUTE_NOTIFY_CHANNEL: &str = "qorpera_web_route_changes";
const DB_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const DB_QUERY_TIMEOUT: Duration = Duration::from_secs(10);
const SNAPSHOT_OFFLOAD_THRESHOLD_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, PartialEq, Eq)]
struct CaFileStamp {
    len: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    ino: u64,
    #[cfg(unix)]
    ctime: i64,
    #[cfg(unix)]
    ctime_nsec: i64,
}

impl CaFileStamp {
    fn from_path(path: &Path) -> Option<Self> {
        let meta = std::fs::metadata(path).ok()?;
        let modified = meta.modified().ok();
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            Some(Self {
                len: meta.len(),
                modified,
                dev: meta.dev(),
                ino: meta.ino(),
                ctime: meta.ctime(),
                ctime_nsec: meta.ctime_nsec(),
            })
        }
        #[cfg(not(unix))]
        {
            Some(Self {
                len: meta.len(),
                modified,
            })
        }
    }
}

struct CachedTlsConfig {
    ca_path: Option<PathBuf>,
    ca_stamp: Option<CaFileStamp>,
    config: rustls::ClientConfig,
}

struct TlsConfigCache {
    slot: Mutex<Option<CachedTlsConfig>>,
}

impl TlsConfigCache {
    const fn new() -> Self {
        Self {
            slot: Mutex::new(None),
        }
    }

    fn get_cached_no_ca(&self) -> Option<rustls::ClientConfig> {
        let guard = self.slot.lock().ok()?;
        let entry = guard.as_ref()?;
        if entry.ca_path.is_none() {
            Some(entry.config.clone())
        } else {
            None
        }
    }

    fn get_or_build(&self, explicit_ca: Option<&Path>) -> Result<rustls::ClientConfig, String> {
        let extra_ca = explicit_ca.map(Path::to_path_buf).or_else(env_ca_file);
        let stamp = extra_ca.as_deref().and_then(CaFileStamp::from_path);
        let cacheable = extra_ca.is_none() || stamp.is_some();
        if cacheable {
            if let Ok(guard) = self.slot.lock() {
                if let Some(ref entry) = *guard {
                    if entry.ca_path == extra_ca && entry.ca_stamp == stamp {
                        return Ok(entry.config.clone());
                    }
                }
            }
        }
        // WHY: Cache only Ok TLS configs and track full file metadata (size, mtime, inode/ctime) so cp -p/rsync rotations invalidate cache.
        let cfg = build_tls_client_config_resolved(extra_ca.as_deref())?;
        if let Ok(mut guard) = self.slot.lock() {
            *guard = Some(CachedTlsConfig {
                ca_path: extra_ca,
                ca_stamp: stamp,
                config: cfg.clone(),
            });
        }
        Ok(cfg)
    }
}

static DEFAULT_TLS_CACHE: TlsConfigCache = TlsConfigCache::new();

fn env_ca_file() -> Option<PathBuf> {
    std::env::var("QORPERA_WEB_ROUTER_DATABASE_CA_FILE")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

fn build_tls_client_config_resolved(extra_ca: Option<&Path>) -> Result<rustls::ClientConfig, String> {
    let mut root_store = rustls::RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let native = rustls_native_certs::load_native_certs();
    for cert in native.certs {
        let _ = root_store.add(cert);
    }
    if let Some(path) = extra_ca {
        let file = std::fs::File::open(path)
            .map_err(|e| format!("failed to open database CA file {}: {e}", path.display()))?;
        let mut reader = BufReader::new(file);
        let mut added = 0usize;
        for item in rustls_pemfile::certs(&mut reader) {
            let cert = item.map_err(|e| format!("invalid PEM cert in {}: {e}", path.display()))?;
            root_store
                .add(cert)
                .map_err(|e| format!("failed to load CA cert from {}: {e}", path.display()))?;
            added += 1;
        }
        if added == 0 {
            return Err(format!("no CA certificates found in {}", path.display()));
        }
    }
    let tls_config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|e| format!("tls protocol version setup failed: {e}"))?
    .with_root_certificates(root_store)
    .with_no_client_auth();
    Ok(tls_config)
}

pub fn build_postgres_tls_connector(ca_file: Option<&Path>) -> Result<MakeRustlsConnect, String> {
    if ca_file.is_none() {
        return Ok(MakeRustlsConnect::new(DEFAULT_TLS_CACHE.get_or_build(None)?));
    }
    let resolved = ca_file.map(Path::to_path_buf).or_else(env_ca_file);
    Ok(MakeRustlsConnect::new(build_tls_client_config_resolved(
        resolved.as_deref(),
    )?))
}

async fn default_postgres_tls_connector() -> Result<MakeRustlsConnect, String> {
    if env_ca_file().is_none() {
        if let Some(cfg) = DEFAULT_TLS_CACHE.get_cached_no_ca() {
            return Ok(MakeRustlsConnect::new(cfg));
        }
    }
    tokio::task::spawn_blocking(|| build_postgres_tls_connector(None))
        .await
        .map_err(|e| format!("tls init task failed: {e}"))?
}

pub async fn connect_postgres_client(
    database_url: &str,
    timeout: Duration,
) -> Result<tokio_postgres::Client, String> {
    let tls = default_postgres_tls_connector().await?;
    let (client, conn) = tokio::time::timeout(timeout, tokio_postgres::connect(database_url, tls))
        .await
        .map_err(|_| "connect timed out".to_string())?
        .map_err(|e| format!("connect failed: {e}"))?;
    tokio::spawn(async move {
        if let Err(err) = conn.await {
            warn!(error = %err, "postgres client connection closed");
        }
    });
    Ok(client)
}

#[derive(Default)]
pub struct NotifyCoalescer {
    dirty: AtomicBool,
    dns_needed: AtomicBool,
    closed: AtomicBool,
    wake: Notify,
}

impl NotifyCoalescer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&self, payload: &str) {
        if should_trigger_dns(payload) {
            self.dns_needed.store(true, Ordering::Release);
        }
        self.dirty.store(true, Ordering::Release);
        self.wake.notify_one();
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.wake.notify_one();
    }

    pub async fn take_or_wait(&self) -> Option<bool> {
        loop {
            if self.dirty.swap(false, Ordering::AcqRel) {
                return Some(self.dns_needed.swap(false, Ordering::AcqRel));
            }
            if self.closed.load(Ordering::Acquire) {
                return None;
            }
            self.wake.notified().await;
        }
    }
}

pub fn spawn_postgres_sync(
    database_url: String,
    routes: Arc<SharedRoutes>,
    ready: Arc<AtomicBool>,
    reconcile_interval: Duration,
    domain_verify_tx: Option<mpsc::Sender<()>>,
) {
    tokio::spawn(async move {
        let mut backoff = Duration::from_secs(1);
        loop {
            match run_sync_session(
                &database_url,
                Arc::clone(&routes),
                Arc::clone(&ready),
                reconcile_interval,
                domain_verify_tx.clone(),
            )
            .await
            {
                Ok(()) => {
                    backoff = Duration::from_secs(1);
                }
                Err(err) => {
                    error!(error = %err, "postgres route sync disconnected; retrying");
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(Duration::from_secs(30));
                }
            }
        }
    });
}

async fn run_sync_session(
    database_url: &str,
    routes: Arc<SharedRoutes>,
    ready: Arc<AtomicBool>,
    reconcile_interval: Duration,
    domain_verify_tx: Option<mpsc::Sender<()>>,
) -> Result<(), String> {
    let tls = default_postgres_tls_connector().await?;
    let (client, mut connection) =
        tokio::time::timeout(DB_CONNECT_TIMEOUT, tokio_postgres::connect(database_url, tls))
            .await
            .map_err(|_| "connect timed out".to_string())?
            .map_err(|e| format!("connect failed: {e}"))?;

    // WHY: Coalesce pg_notify bursts losslessly into atomic flags so bursts > 32 never drop domain_recheck or route updates.
    let coalescer = Arc::new(NotifyCoalescer::new());
    let coalescer_tx = Arc::clone(&coalescer);
    tokio::spawn(async move {
        let mut stream = futures_poll_notifications(&mut connection);
        while let Some(event) = stream.next().await {
            match event {
                Ok(tokio_postgres::AsyncMessage::Notification(n)) => {
                    coalescer_tx.push(n.payload());
                }
                Ok(_) => {}
                Err(err) => {
                    warn!(error = %err, "postgres connection error");
                    break;
                }
            }
        }
        coalescer_tx.close();
    });

    tokio::time::timeout(
        DB_QUERY_TIMEOUT,
        client.batch_execute(&format!("LISTEN {ROUTE_NOTIFY_CHANNEL};")),
    )
    .await
    .map_err(|_| "listen timed out".to_string())?
    .map_err(|e| format!("listen failed: {e}"))?;

    let mut last_snapshot_hash: Option<[u8; 32]> = None;
    refresh_snapshot(&client, &routes, &mut last_snapshot_hash).await?;
    ready.store(true, Ordering::Release);
    info!("loaded initial web routing snapshot from postgres");
    if let Some(ref dtx) = domain_verify_tx {
        let _ = dtx.try_send(());
    }

    let mut ticker = tokio::time::interval(reconcile_interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ticker.tick().await;

    loop {
        tokio::select! {
            notify = coalescer.take_or_wait() => {
                let Some(trigger_dns) = notify else {
                    return Err("notification stream closed".to_string());
                };
                refresh_snapshot(&client, &routes, &mut last_snapshot_hash).await?;
                if trigger_dns {
                    if let Some(ref dtx) = domain_verify_tx {
                        let _ = dtx.try_send(());
                    }
                }
            }
            _ = ticker.tick() => {
                refresh_snapshot(&client, &routes, &mut last_snapshot_hash).await?;
            }
        }
    }
}

fn should_trigger_dns(payload: &str) -> bool {
    payload == "domain_recheck"
        || payload == "domain_added"
        || payload == "qorpera_site_settings"
}

async fn refresh_snapshot(
    client: &tokio_postgres::Client,
    routes: &Arc<SharedRoutes>,
    last_hash: &mut Option<[u8; 32]>,
) -> Result<(), String> {
    let row = tokio::time::timeout(
        DB_QUERY_TIMEOUT,
        client.query_one("SELECT public.qorpera_web_edge_snapshot()::text", &[]),
    )
    .await
    .map_err(|_| "snapshot query timed out".to_string())?
    .map_err(|e| format!("snapshot query failed: {e}"))?;
    let raw_json: String = row.get(0);
    let previous_hash = *last_hash;
    let parsed = if raw_json.len() >= SNAPSHOT_OFFLOAD_THRESHOLD_BYTES {
        tokio::task::spawn_blocking(move || parse_snapshot_if_changed(&raw_json, previous_hash))
            .await
            .map_err(|e| format!("snapshot parse task failed: {e}"))??
    } else {
        parse_snapshot_if_changed(&raw_json, previous_hash)?
    };
    let Some((digest, snapshot)) = parsed else {
        return Ok(());
    };
    routes.update(|table| table.apply_snapshot(snapshot));
    *last_hash = Some(digest);
    Ok(())
}

fn parse_snapshot_if_changed(
    raw_json: &str,
    previous_hash: Option<[u8; 32]>,
) -> Result<Option<([u8; 32], EdgeSnapshot)>, String> {
    let digest: [u8; 32] = Sha256::digest(raw_json.as_bytes()).into();
    if previous_hash.as_ref() == Some(&digest) {
        return Ok(None);
    }
    let snapshot: EdgeSnapshot =
        serde_json::from_str(raw_json).map_err(|e| format!("snapshot parse failed: {e}"))?;
    Ok(Some((digest, snapshot)))
}

struct ConnectionMessages<'a, S, T> {
    conn: &'a mut tokio_postgres::Connection<S, T>,
}

impl<'a, S, T> ConnectionMessages<'a, S, T>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    async fn next(&mut self) -> Option<Result<tokio_postgres::AsyncMessage, tokio_postgres::Error>> {
        std::future::poll_fn(|cx| self.conn.poll_message(cx)).await
    }
}

fn futures_poll_notifications<S, T>(
    conn: &mut tokio_postgres::Connection<S, T>,
) -> ConnectionMessages<'_, S, T> {
    ConnectionMessages { conn }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_default_rustls_connector_and_rejects_missing_ca_file() {
        assert!(build_postgres_tls_connector(None).is_ok());
        assert!(build_postgres_tls_connector(None).is_ok());
        let missing = Path::new("/nonexistent/qorpera-missing-ca.pem");
        assert!(build_postgres_tls_connector(Some(missing)).is_err());
    }

    #[test]
    fn tls_config_cache_does_not_cache_errors_and_retries_after_file_appears() {
        let dir = tempfile::tempdir().unwrap();
        let ca_path = dir.path().join("ca.pem");
        let cache = TlsConfigCache::new();

        let err1 = cache.get_or_build(Some(&ca_path)).unwrap_err();
        assert!(err1.contains("failed to open"), "unexpected err: {err1}");
        assert!(cache.get_cached_no_ca().is_none());

        std::fs::write(&ca_path, b"").unwrap();
        let err2 = cache.get_or_build(Some(&ca_path)).unwrap_err();
        assert!(err2.contains("no CA certificates"), "unexpected err: {err2}");

        assert!(cache.get_or_build(None).is_ok());
        assert!(cache.get_cached_no_ca().is_some());
    }

    #[tokio::test]
    async fn coalescer_preserves_dns_flag_across_large_notify_burst_and_handles_close() {
        let coalescer = NotifyCoalescer::new();
        for _ in 0..100 {
            coalescer.push("route_update");
        }
        coalescer.push("domain_recheck");
        for _ in 0..100 {
            coalescer.push("route_update");
        }
        assert_eq!(coalescer.take_or_wait().await, Some(true));

        coalescer.push("route_update");
        coalescer.close();
        assert_eq!(coalescer.take_or_wait().await, Some(false));
        assert_eq!(coalescer.take_or_wait().await, None);
    }
}
