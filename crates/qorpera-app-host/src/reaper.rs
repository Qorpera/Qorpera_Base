use crate::lifecycle::AppLifecycleManager;
use bytes::Bytes;
use http::{Request, Uri};
use http_body_util::{BodyExt, Full};
use hyper_util::rt::TokioIo;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::net::TcpStream;
use tracing::{info, warn};

#[derive(Deserialize)]
struct ActivityResponse {
    #[serde(default)]
    deployments: HashMap<String, u64>,
}

pub async fn reap_once_with_router(
    manager: &AppLifecycleManager,
    router_internal_url: &str,
    control_token: &str,
) -> Result<Vec<String>, String> {
    let activity = fetch_router_activity(router_internal_url, control_token).await?;
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64);
    let reaped = manager.reap_idle(&activity, now_ms).await;
    for dep_id in &reaped {
        if let Err(err) = clear_router_upstream(router_internal_url, control_token, dep_id).await {
            warn!(deployment_id = %dep_id, error = %err, "failed clearing hibernated upstream in router");
        } else {
            info!(deployment_id = %dep_id, "reaped idle deployment and cleared router upstream");
        }
    }
    Ok(reaped)
}

pub fn spawn_idle_reaper(
    manager: Arc<AppLifecycleManager>,
    router_internal_url: String,
    control_token: String,
    interval: Duration,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ticker.tick().await;
        loop {
            ticker.tick().await;
            if let Err(err) = reap_once_with_router(&manager, &router_internal_url, &control_token).await {
                warn!(error = %err, "idle reaper poll failed");
            }
        }
    })
}

async fn fetch_router_activity(
    base_url: &str,
    token: &str,
) -> Result<HashMap<String, u64>, String> {
    let url = format!("{}/_internal/metrics/activity", base_url.trim_end_matches('/'));
    let uri: Uri = url.parse().map_err(|_| "invalid_router_url".to_string())?;
    let host = uri.host().ok_or_else(|| "missing_router_host".to_string())?;
    let port = uri.port_u16().unwrap_or(80);
    let stream = TcpStream::connect((host, port))
        .await
        .map_err(|e| format!("router_connect: {e}"))?;
    let io = TokioIo::new(stream);
    let (mut sender, conn) = hyper::client::conn::http1::handshake(io)
        .await
        .map_err(|e| format!("router_handshake: {e}"))?;
    tokio::spawn(async move {
        let _ = conn.await;
    });
    let req = Request::builder()
        .method("GET")
        .uri("/_internal/metrics/activity")
        .header("host", format!("{host}:{port}"))
        .header("authorization", format!("Bearer {token}"))
        .body(Full::new(Bytes::new()))
        .map_err(|e| e.to_string())?;
    let res = sender
        .send_request(req)
        .await
        .map_err(|e| format!("router_request: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("router_status_{}", res.status().as_u16()));
    }
    let body = res
        .into_body()
        .collect()
        .await
        .map_err(|e| format!("router_body: {e}"))?
        .to_bytes();
    let parsed: ActivityResponse =
        serde_json::from_slice(&body).map_err(|e| format!("router_json: {e}"))?;
    Ok(parsed.deployments)
}

async fn clear_router_upstream(
    base_url: &str,
    token: &str,
    deployment_id: &str,
) -> Result<(), String> {
    let path = format!("/_internal/deployments/{deployment_id}/upstream");
    let url = format!("{}{}", base_url.trim_end_matches('/'), path);
    let uri: Uri = url.parse().map_err(|_| "invalid_router_url".to_string())?;
    let host = uri.host().ok_or_else(|| "missing_router_host".to_string())?;
    let port = uri.port_u16().unwrap_or(80);
    let stream = TcpStream::connect((host, port))
        .await
        .map_err(|e| format!("router_connect: {e}"))?;
    let io = TokioIo::new(stream);
    let (mut sender, conn) = hyper::client::conn::http1::handshake(io)
        .await
        .map_err(|e| format!("router_handshake: {e}"))?;
    tokio::spawn(async move {
        let _ = conn.await;
    });
    let req = Request::builder()
        .method("POST")
        .uri(&path)
        .header("host", format!("{host}:{port}"))
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {token}"))
        .body(Full::new(Bytes::from_static(b"{\"upstream_addr\":null}")))
        .map_err(|e| e.to_string())?;
    let res = sender
        .send_request(req)
        .await
        .map_err(|e| format!("router_request: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("router_status_{}", res.status().as_u16()));
    }
    Ok(())
}
