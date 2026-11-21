use qorpera_app_host::driver::{AppRuntimeDriver, LocalProcessDriver, LxdAppDriver};
use qorpera_app_host::lifecycle::AppLifecycleManager;
use qorpera_app_host::logs::LogRingBuffer;
use qorpera_app_host::reaper::spawn_idle_reaper;
use qorpera_app_host::server::AppHostServer;
use std::env;
use std::net::SocketAddr;
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

    let bind_addr: SocketAddr = env::var("QORPERA_APP_HOST_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8096".to_string())
        .parse()
        .expect("invalid QORPERA_APP_HOST_BIND");

    let control_token = read_secret("QORPERA_APP_HOST_CONTROL_TOKEN", "QORPERA_APP_HOST_CONTROL_TOKEN_FILE")
        .expect("QORPERA_APP_HOST_CONTROL_TOKEN or *_FILE is required");

    let driver_mode = env::var("QORPERA_APP_HOST_DRIVER").unwrap_or_else(|_| "lxd".to_string());
    let driver: Arc<dyn AppRuntimeDriver> = if driver_mode == "local" {
        Arc::new(LocalProcessDriver::new())
    } else {
        let project = env::var("QORPERA_APP_HOST_LXD_PROJECT").unwrap_or_else(|_| "qorpera-web-apps".to_string());
        let profile =
            env::var("QORPERA_APP_HOST_LXD_PROFILE").unwrap_or_else(|_| "qorpera-web-apps-egress".to_string());
        let bind_ip = env::var("QORPERA_APP_HOST_CONTAINER_BIND_IP").unwrap_or_else(|_| "127.0.0.1".to_string());
        Arc::new(LxdAppDriver::new(project, profile, bind_ip))
    };

    let logs = Arc::new(LogRingBuffer::new(2000, 256 * 1024));
    let manager = Arc::new(AppLifecycleManager::new(
        driver,
        logs,
        Duration::from_secs(30),
        Duration::from_secs(2),
    ));

    if let Ok(router_url) = env::var("QORPERA_APP_HOST_ROUTER_URL") {
        let trimmed = router_url.trim().to_string();
        if !trimmed.is_empty() {
            let reap_sec: u64 = env::var("QORPERA_APP_HOST_REAP_INTERVAL_SEC")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(30)
                .max(5);
            let _reaper = spawn_idle_reaper(
                Arc::clone(&manager),
                trimmed,
                control_token.clone(),
                Duration::from_secs(reap_sec),
            );
        }
    }

    let server = AppHostServer::bind(bind_addr, manager, control_token)
        .await
        .expect("failed to bind qorpera-app-host");
    info!(addr = %server.addr, driver = %driver_mode, "qorpera-app-host listening");
    let _handle = server.spawn();
    let _ = tokio::signal::ctrl_c().await;
    info!("shutting down qorpera-app-host");
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
