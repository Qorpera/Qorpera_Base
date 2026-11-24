use crate::lifecycle::AppLifecycleManager;
use bytes::Bytes;
use http::Request;
use http_body_util::{BodyExt, Full, Limited};
use hyper_util::client::legacy::{connect::HttpConnector, Client};
use hyper_util::rt::TokioExecutor;
use serde::Deserialize;
use std::collections::HashMap;
use std::future::{poll_fn, Future};
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::task::Poll;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tracing::{info, warn};

const ROUTER_HTTP_TIMEOUT: Duration = Duration::from_secs(5);
const PRE_HIBERNATE_DRAIN: Duration = Duration::from_millis(250);
const MAX_ROUTER_BODY_BYTES: usize = 4 * 1024 * 1024;
const MAX_CONCURRENT_REAP: usize = 8;

type RouterClient = Client<HttpConnector, Full<Bytes>>;

fn router_http_client() -> &'static RouterClient {
    static CLIENT: OnceLock<RouterClient> = OnceLock::new();
    CLIENT.get_or_init(|| {
        let mut connector = HttpConnector::new();
        connector.set_nodelay(true);
        connector.set_connect_timeout(Some(ROUTER_HTTP_TIMEOUT));
        Client::builder(TokioExecutor::new())
            .pool_idle_timeout(Duration::from_secs(30))
            .pool_max_idle_per_host(MAX_CONCURRENT_REAP)
            .build(connector)
    })
}

async fn run_bounded<'a, I, T, F, Fut>(items: I, limit: usize, mut f: F) -> Vec<Fut::Output>
where
    I: IntoIterator<Item = T>,
    F: FnMut(T) -> Fut,
    Fut: Future + 'a,
{
    let cap = limit.max(1);
    let mut iter = items.into_iter();
    let mut active: Vec<Pin<Box<Fut>>> = Vec::with_capacity(cap);
    let mut results = Vec::new();
    while active.len() < cap {
        let Some(item) = iter.next() else { break };
        active.push(Box::pin(f(item)));
    }
    while !active.is_empty() {
        let (idx, out) = poll_fn(|cx| {
            for (i, fut) in active.iter_mut().enumerate() {
                if let Poll::Ready(val) = fut.as_mut().poll(cx) {
                    return Poll::Ready((i, val));
                }
            }
            Poll::Pending
        })
        .await;
        active.swap_remove(idx);
        results.push(out);
        if let Some(item) = iter.next() {
            active.push(Box::pin(f(item)));
        }
    }
    results
}

#[derive(Deserialize)]
struct ActivityResponse {
    #[serde(default)]
    deployments: HashMap<String, u64>,
}

async fn restore_running_upstream(
    manager: &AppLifecycleManager,
    router_internal_url: &str,
    control_token: &str,
    dep_id: &str,
) {
    if let Some(st) = manager.status(dep_id) {
        if st.state == crate::lifecycle::InstanceState::Running {
            if let Some(addr) = st.upstream_addr {
                let _ = set_router_upstream(router_internal_url, control_token, dep_id, Some(&addr))
                    .await;
            }
        }
    }
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
    let candidates = manager.idle_candidates_with_generation(&activity, now_ms);
    let mut reaped = Vec::new();
    if !candidates.is_empty() {
        let clear_results = run_bounded(candidates, MAX_CONCURRENT_REAP, |(dep_id, started_at, wake_gen)| async move {
            match set_router_upstream(router_internal_url, control_token, &dep_id, None).await {
                Ok(()) => Some((dep_id, started_at, wake_gen)),
                Err(err) => {
                    warn!(deployment_id = %dep_id, error = %err, "failed clearing idle upstream before freeze");
                    None
                }
            }
        })
        .await;
        let cleared: Vec<_> = clear_results.into_iter().flatten().collect();
        if !cleared.is_empty() {
            tokio::time::sleep(PRE_HIBERNATE_DRAIN).await;

            // WHY: Fail closed if the post-drain activity check fails so a router blip cannot freeze live apps with stale activity data.
            let latest_activity = match fetch_router_activity(router_internal_url, control_token).await {
                Ok(map) => map,
                Err(err) => {
                    warn!(error = %err, "post-drain activity check failed; restoring cleared upstreams");
                    let _ = run_bounded(&cleared, MAX_CONCURRENT_REAP, |(dep_id, _, _)| async move {
                        restore_running_upstream(manager, router_internal_url, control_token, dep_id)
                            .await;
                    })
                    .await;
                    return Err(err);
                }
            };
            let latest_activity = &latest_activity;
            let freeze_results = run_bounded(cleared, MAX_CONCURRENT_REAP, |(dep_id, started_at, wake_gen)| async move {
                let saw_new_traffic = latest_activity
                    .get(&dep_id)
                    .copied()
                    .is_some_and(|ts| ts >= now_ms);
                if saw_new_traffic {
                    restore_running_upstream(manager, router_internal_url, control_token, &dep_id)
                        .await;
                    return None;
                }
                if manager
                    .freeze_if_unchanged_generation(&dep_id, started_at, wake_gen, now_ms)
                    .await
                {
                    info!(deployment_id = %dep_id, "froze idle deployment after clearing router upstream");
                    Some(dep_id)
                } else {
                    restore_running_upstream(manager, router_internal_url, control_token, &dep_id)
                        .await;
                    None
                }
            })
            .await;
            reaped.extend(freeze_results.into_iter().flatten());
        }
    }

    let now_after = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(now_ms, |d| d.as_millis() as u64);
    let deep_results = run_bounded(
        manager.deep_hibernate_candidates(now_after),
        MAX_CONCURRENT_REAP,
        |(dep_id, frozen_at)| async move {
            if manager.deep_hibernate_if_unchanged(&dep_id, frozen_at).await {
                info!(deployment_id = %dep_id, "deep-hibernated frozen deployment to reclaim memory");
                Some(dep_id)
            } else {
                None
            }
        },
    )
    .await;
    reaped.extend(deep_results.into_iter().flatten());
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
    let req = Request::builder()
        .method("GET")
        .uri(&url)
        .header("authorization", format!("Bearer {token}"))
        .body(Full::new(Bytes::new()))
        .map_err(|_| "invalid_router_url".to_string())?;
    let res = tokio::time::timeout(ROUTER_HTTP_TIMEOUT, router_http_client().request(req))
        .await
        .map_err(|_| "router_request_timeout".to_string())?
        .map_err(|e| format!("router_request: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("router_status_{}", res.status().as_u16()));
    }
    let body = tokio::time::timeout(
        ROUTER_HTTP_TIMEOUT,
        Limited::new(res.into_body(), MAX_ROUTER_BODY_BYTES).collect(),
    )
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
    let url = format!(
        "{}/_internal/deployments/{deployment_id}/upstream",
        base_url.trim_end_matches('/')
    );
    let payload = serde_json::to_vec(&serde_json::json!({ "upstream_addr": upstream_addr }))
        .map_err(|e| e.to_string())?;
    let req = Request::builder()
        .method("POST")
        .uri(&url)
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {token}"))
        .body(Full::new(Bytes::from(payload)))
        .map_err(|_| "invalid_router_url".to_string())?;
    let res = tokio::time::timeout(ROUTER_HTTP_TIMEOUT, router_http_client().request(req))
        .await
        .map_err(|_| "router_request_timeout".to_string())?
        .map_err(|e| format!("router_request: {e}"))?;
    let status = res.status();
    let _ = tokio::time::timeout(
        ROUTER_HTTP_TIMEOUT,
        Limited::new(res.into_body(), 64 * 1024).collect(),
    )
    .await;
    if !status.is_success() {
        return Err(format!("router_status_{}", status.as_u16()));
    }
    Ok(())
}
