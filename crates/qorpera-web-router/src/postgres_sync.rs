use crate::routes::{EdgeSnapshot, SharedRoutes};
use sha2::{Digest, Sha256};
use std::io::BufReader;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_postgres_rustls::MakeRustlsConnect;
use tracing::{error, info, warn};

pub const ROUTE_NOTIFY_CHANNEL: &str = "qorpera_web_route_changes";
const DB_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const DB_QUERY_TIMEOUT: Duration = Duration::from_secs(10);

pub fn build_postgres_tls_connector(ca_file: Option<&Path>) -> Result<MakeRustlsConnect, String> {
    let mut root_store = rustls::RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let native = rustls_native_certs::load_native_certs();
    for cert in native.certs {
        let _ = root_store.add(cert);
    }
    let env_ca = std::env::var("QORPERA_WEB_ROUTER_DATABASE_CA_FILE")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let extra_ca = ca_file
        .map(|p| p.to_path_buf())
        .or_else(|| env_ca.map(std::path::PathBuf::from));
    if let Some(path) = extra_ca {
        let file = std::fs::File::open(&path)
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
    Ok(MakeRustlsConnect::new(tls_config))
}

pub async fn connect_postgres_client(
    database_url: &str,
    timeout: Duration,
) -> Result<tokio_postgres::Client, String> {
    let tls = build_postgres_tls_connector(None)?;
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
    let tls = build_postgres_tls_connector(None)?;
    let (client, mut connection) =
        tokio::time::timeout(DB_CONNECT_TIMEOUT, tokio_postgres::connect(database_url, tls))
            .await
            .map_err(|_| "connect timed out".to_string())?
            .map_err(|e| format!("connect failed: {e}"))?;

    let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(32);
    tokio::spawn(async move {
        let mut stream = futures_poll_notifications(&mut connection);
        while let Some(event) = stream.next().await {
            match event {
                Ok(tokio_postgres::AsyncMessage::Notification(n)) => {
                    let _ = tx.try_send(n.payload().to_string());
                }
                Ok(_) => {}
                Err(err) => {
                    warn!(error = %err, "postgres connection error");
                    break;
                }
            }
        }
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
            notify = rx.recv() => {
                let Some(first_payload) = notify else {
                    return Err("notification stream closed".to_string());
                };
                let mut trigger_dns = should_trigger_dns(&first_payload);
                while let Ok(p) = rx.try_recv() {
                    if should_trigger_dns(&p) {
                        trigger_dns = true;
                    }
                }
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
    let digest: [u8; 32] = Sha256::digest(raw_json.as_bytes()).into();
    if last_hash.as_ref() == Some(&digest) {
        return Ok(());
    }
    let snapshot: EdgeSnapshot =
        serde_json::from_str(&raw_json).map_err(|e| format!("snapshot parse failed: {e}"))?;
    routes.update(|table| table.apply_snapshot(snapshot));
    *last_hash = Some(digest);
    Ok(())
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
        let missing = Path::new("/nonexistent/qorpera-missing-ca.pem");
        assert!(build_postgres_tls_connector(Some(missing)).is_err());
    }
}
