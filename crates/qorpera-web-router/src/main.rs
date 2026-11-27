use qorpera_web_router::blob_store::{BlobStore, DEFAULT_MAX_BLOB_BYTES, DEFAULT_MAX_CACHE_BYTES};
use qorpera_web_router::dns_verify::{default_dns_servers, spawn_dns_verifier};
use qorpera_web_router::postgres_sync::spawn_postgres_sync;
use qorpera_web_router::routes::EdgeSnapshot;
use qorpera_web_router::server::{BoundServers, RouterConfig, RouterState};
use qorpera_web_router::telemetry::spawn_telemetry_flusher;
use std::env;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tracing::info;

fn main() {
    let default_threads = std::thread::available_parallelism()
        .map_or(4, |n| n.get().clamp(2, 16));
    let worker_threads = env::var("QORPERA_WEB_ROUTER_THREADS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|&n| n > 0)
        .unwrap_or(default_threads);
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(worker_threads)
        .max_blocking_threads(32)
        .enable_all()
        .build()
        .expect("failed building tokio runtime");
    rt.block_on(async_main());
}

async fn async_main() {
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

    let dns_servers: Vec<SocketAddr> = env::var("QORPERA_WEB_DNS_SERVERS")
        .unwrap_or_default()
        .split(',')
        .filter_map(|s| s.trim().parse::<SocketAddr>().ok())
        .collect();
    let dns_servers = if dns_servers.is_empty() {
        default_dns_servers()
    } else {
        dns_servers
    };

    let app_host_url = env::var("QORPERA_WEB_APP_HOST_URL").ok().filter(|v| !v.trim().is_empty());
    let database_url = read_secret("QORPERA_WEB_ROUTER_DATABASE_URL", "QORPERA_WEB_ROUTER_DATABASE_URL_FILE").ok();

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
        dns_servers: dns_servers.clone(),
        database_url: database_url.clone(),
        auth_backend: None,
    };

    let blobs = Arc::new(BlobStore::new(blob_root, max_cache_bytes, max_blob_bytes));
    let web_origins = qorpera_web_router::server::parse_web_origins(env::var("QORPERA_WEB_ORIGINS").ok().as_deref());
    let state = Arc::new(RouterState::new(blobs, EdgeSnapshot::default(), &cfg).with_web_origins(web_origins));

    let (dns_tx, dns_rx) = mpsc::channel::<()>(8);
    let dns_interval_sec: u64 = env::var("QORPERA_WEB_DNS_POLL_SEC")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(30);
    spawn_dns_verifier(
        Arc::clone(&state.routes),
        dns_servers,
        database_url.clone(),
        Duration::from_secs(dns_interval_sec.max(5)),
        dns_rx,
    );

    let (shutdown_tx, shutdown_rx) = watch::channel(false);

    let telemetry_handle = if let Some(ref db_url) = database_url {
        spawn_postgres_sync(
            db_url.clone(),
            Arc::clone(&state.routes),
            Arc::clone(&state.ready),
            Duration::from_secs(60),
            Some(dns_tx),
        );
        let flush_sec: u64 = env::var("QORPERA_WEB_TELEMETRY_FLUSH_SEC")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(30);
        Some(spawn_telemetry_flusher(
            db_url.clone(),
            Arc::clone(&state.telemetry),
            Duration::from_secs(flush_sec.max(5)),
            shutdown_rx.clone(),
        ))
    } else {
        None
    };

    let bound = BoundServers::bind(&cfg, Arc::clone(&state))
        .await
        .expect("failed to bind router listeners");
    info!(
        public_addr = %bound.public_addr,
        internal_addr = %bound.internal_addr,
        "qorpera-web-router listening"
    );
    let (pub_handle, int_handle) = bound.spawn_with_shutdown(shutdown_rx.clone());
    #[cfg(unix)]
    let unix_handle = env::var("QORPERA_WEB_ROUTER_PUBLIC_UNIX")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|p| {
            let pb = PathBuf::from(&p);
            let h = qorpera_web_router::server::spawn_public_unix_listener_with_shutdown(
                pb,
                Arc::clone(&state),
                shutdown_rx.clone(),
            )
            .expect("failed to bind public unix socket");
            info!(unix_socket = %p, "qorpera-web-router listening on unix socket");
            (p, h)
        });
    shutdown_signal().await;
    info!("shutting down qorpera-web-router");
    let _ = shutdown_tx.send(true);
    let _ = tokio::time::timeout(Duration::from_secs(2), async {
        let _ = pub_handle.await;
        let _ = int_handle.await;
    })
    .await;
    if let Some(handle) = telemetry_handle {
        let _ = tokio::time::timeout(Duration::from_secs(3), handle).await;
    }
    #[cfg(unix)]
    if let Some((path, h)) = unix_handle {
        let _ = tokio::time::timeout(Duration::from_secs(2), h).await;
        let _ = std::fs::remove_file(path);
    }
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut sigterm = signal(SignalKind::terminate()).expect("failed installing SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = sigterm.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
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
