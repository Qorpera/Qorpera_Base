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

const ROUTER_HTTP_TIMEOUT: Duration = Duration::from_secs(5);
const PRE_HIBERNATE_DRAIN: Duration = Duration::from_millis(250);

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
    let candidates = manager.idle_candidates(&activity, now_ms);
    let mut reaped = Vec::new();
    if !candidates.is_empty() {
        let mut cleared = Vec::new();
        for (dep_id, started_at) in candidates {
            if let Err(err) =
                set_router_upstream(router_internal_url, control_token, &dep_id, None).await
            {
                warn!(deployment_id = %dep_id, error = %err, "failed clearing idle upstream before freeze");
            } else {
                cleared.push((dep_id, started_at));
            }
        }
        if !cleared.is_empty() {
            tokio::time::sleep(PRE_HIBERNATE_DRAIN).await;

            let latest_activity = fetch_router_activity(router_internal_url, control_token)
                .await
                .unwrap_or(activity);
            for (dep_id, started_at) in cleared {
                let saw_new_traffic = latest_activity
                    .get(&dep_id)
                    .copied()
                    .is_some_and(|ts| ts >= now_ms);
                if saw_new_traffic {
                    if let Some(st) = manager.status(&dep_id) {
                        if let Some(addr) = st.upstream_addr {
                            let _ = set_router_upstream(
                                router_internal_url,
                                control_token,
                                &dep_id,
                                Some(&addr),
                            )
                            .await;
                        }
                    }
                    continue;
                }
                if manager.freeze_if_unchanged(&dep_id, started_at, now_ms).await {
                    info!(deployment_id = %dep_id, "froze idle deployment after clearing router upstream");
                    reaped.push(dep_id);
                }
            }
        }
    }

    let now_after = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(now_ms, |d| d.as_millis() as u64);
    for (dep_id, frozen_at) in manager.deep_hibernate_candidates(now_after) {
        if manager.deep_hibernate_if_unchanged(&dep_id, frozen_at).await {
            info!(deployment_id = %dep_id, "deep-hibernated frozen deployment to reclaim memory");
            reaped.push(dep_id);
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
    let stream = tokio::time::timeout(ROUTER_HTTP_TIMEOUT, TcpStream::connect((host, port)))
        .await
        .map_err(|_| "router_connect_timeout".to_string())?
        .map_err(|e| format!("router_connect: {e}"))?;
    let _ = stream.set_nodelay(true);
    let io = TokioIo::new(stream);
    let (mut sender, conn) = tokio::time::timeout(
        ROUTER_HTTP_TIMEOUT,
        hyper::client::conn::http1::handshake(io),
    )
    .await
    .map_err(|_| "router_handshake_timeout".to_string())?
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
    let res = tokio::time::timeout(ROUTER_HTTP_TIMEOUT, sender.send_request(req))
        .await
        .map_err(|_| "router_request_timeout".to_string())?
        .map_err(|e| format!("router_request: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("router_status_{}", res.status().as_u16()));
    }
    let body = tokio::time::timeout(ROUTER_HTTP_TIMEOUT, res.into_body().collect())
        .await
        .map_err(|_| "router_body_timeout".to_string())?
        .map_err(|e| format!("router_body: {e}"))?
        .to_bytes();
    let parsed: ActivityResponse =
        serde_json::from_slice(&body).map_err(|e| format!("router_json: {e}"))?;
    Ok(parsed.deployments)
}

async fn set_router_upstream(
    base_url: &str,
    token: &str,
    deployment_id: &str,
    upstream_addr: Option<&str>,
) -> Result<(), String> {
    let path = format!("/_internal/deployments/{deployment_id}/upstream");
    let url = format!("{}{}", base_url.trim_end_matches('/'), path);
    let uri: Uri = url.parse().map_err(|_| "invalid_router_url".to_string())?;
    let host = uri.host().ok_or_else(|| "missing_router_host".to_string())?;
    let port = uri.port_u16().unwrap_or(80);
    let stream = tokio::time::timeout(ROUTER_HTTP_TIMEOUT, TcpStream::connect((host, port)))
        .await
        .map_err(|_| "router_connect_timeout".to_string())?
        .map_err(|e| format!("router_connect: {e}"))?;
    let _ = stream.set_nodelay(true);
    let io = TokioIo::new(stream);
    let (mut sender, conn) = tokio::time::timeout(
        ROUTER_HTTP_TIMEOUT,
        hyper::client::conn::http1::handshake(io),
    )
    .await
    .map_err(|_| "router_handshake_timeout".to_string())?
    .map_err(|e| format!("router_handshake: {e}"))?;
    tokio::spawn(async move {
        let _ = conn.await;
    });
    let payload = serde_json::to_vec(&serde_json::json!({ "upstream_addr": upstream_addr }))
        .map_err(|e| e.to_string())?;
    let req = Request::builder()
        .method("POST")
        .uri(&path)
        .header("host", format!("{host}:{port}"))
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {token}"))
        .body(Full::new(Bytes::from(payload)))
        .map_err(|e| e.to_string())?;
    let res = tokio::time::timeout(ROUTER_HTTP_TIMEOUT, sender.send_request(req))
        .await
        .map_err(|_| "router_request_timeout".to_string())?
        .map_err(|e| format!("router_request: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("router_status_{}", res.status().as_u16()));
    }
    Ok(())
}
