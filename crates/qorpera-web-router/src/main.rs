use qorpera_web_router::blob_store::{BlobStore, DEFAULT_MAX_BLOB_BYTES, DEFAULT_MAX_CACHE_BYTES};
use qorpera_web_router::postgres_sync::spawn_postgres_sync;
use qorpera_web_router::routes::EdgeSnapshot;
use qorpera_web_router::server::{BoundServers, RouterConfig, RouterState};
use std::env;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tracing::info;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .json()
        .init();

    let public_bind: SocketAddr = env::var("QORPERA_WEB_ROUTER_PUBLIC_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8095".to_string())
        .parse()
        .expect("invalid QORPERA_WEB_ROUTER_PUBLIC_BIND");

    let internal_bind: SocketAddr = env::var("QORPERA_WEB_ROUTER_INTERNAL_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8094".to_string())
        .parse()
        .expect("invalid QORPERA_WEB_ROUTER_INTERNAL_BIND");

    let blob_root = PathBuf::from(
        env::var("QORPERA_WEB_ROUTER_BLOB_ROOT").unwrap_or_else(|_| "/var/lib/qorpera-web-blobs".to_string()),
    );
    let max_cache_bytes: usize = env::var("QORPERA_WEB_ROUTER_CACHE_BYTES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_MAX_CACHE_BYTES);
    let max_blob_bytes: usize = env::var("QORPERA_WEB_ROUTER_MAX_BLOB_BYTES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_MAX_BLOB_BYTES);

    let control_token = read_secret("QORPERA_WEB_ROUTER_CONTROL_TOKEN", "QORPERA_WEB_ROUTER_CONTROL_TOKEN_FILE")
        .expect("QORPERA_WEB_ROUTER_CONTROL_TOKEN or *_FILE is required");
    let cookie_secret = read_secret("QORPERA_WEB_ROUTER_COOKIE_SECRET", "QORPERA_WEB_ROUTER_COOKIE_SECRET_FILE")
        .expect("QORPERA_WEB_ROUTER_COOKIE_SECRET or *_FILE is required")
        .into_bytes();

    let trusted_proxies: Vec<IpAddr> = env::var("QORPERA_WEB_ROUTER_TRUSTED_PROXIES")
        .unwrap_or_default()
        .split(',')
        .filter_map(|s| s.trim().parse::<IpAddr>().ok())
        .collect();

    let app_host_url = env::var("QORPERA_WEB_APP_HOST_URL").ok().filter(|v| !v.trim().is_empty());

    let cfg = RouterConfig {
        public_bind,
        internal_bind,
        control_token,
        cookie_secret,
        trusted_proxies,
        rate_limit_rps: env::var("QORPERA_WEB_ROUTER_RPS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(50.0),
        rate_limit_burst: env::var("QORPERA_WEB_ROUTER_BURST")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(150.0),
        unlock_limit_rps: 0.2,
        unlock_limit_burst: 5.0,
        app_host_url,
        wake_timeout: Duration::from_secs(15),
    };

    let blobs = Arc::new(BlobStore::new(blob_root, max_cache_bytes, max_blob_bytes));
    let state = Arc::new(RouterState::new(blobs, EdgeSnapshot::default(), &cfg));

    if let Ok(db_url) = read_secret("QORPERA_WEB_ROUTER_DATABASE_URL", "QORPERA_WEB_ROUTER_DATABASE_URL_FILE") {
        spawn_postgres_sync(db_url, Arc::clone(&state.routes), Duration::from_secs(60));
    }

    let bound = BoundServers::bind(&cfg, Arc::clone(&state))
        .await
        .expect("failed to bind router listeners");
    info!(
        public_addr = %bound.public_addr,
        internal_addr = %bound.internal_addr,
        "qorpera-web-router listening"
    );
    let (_pub_handle, _int_handle) = bound.spawn();
    let _ = tokio::signal::ctrl_c().await;
    info!("shutting down qorpera-web-router");
}

fn read_secret(env_key: &str, file_key: &str) -> Result<String, String> {
    if let Ok(path) = env::var(file_key) {
        let content = std::fs::read_to_string(&path).map_err(|e| format!("failed reading {path}: {e}"))?;
        let trimmed = content.trim().to_string();
        if !trimmed.is_empty() {
            return Ok(trimmed);
        }
    }
    env::var(env_key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("missing {env_key}"))
}
