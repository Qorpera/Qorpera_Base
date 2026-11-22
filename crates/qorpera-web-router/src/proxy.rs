use crate::security::{strip_platform_cookie, HSTS_HEADER};
use arc_swap::ArcSwap;
use bytes::Bytes;
use http::{HeaderMap, HeaderName, HeaderValue, Request, Response, StatusCode, Uri};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::{TokioExecutor, TokioIo};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::net::TcpStream;
use tokio::sync::broadcast;

pub type BoxBody = http_body_util::combinators::BoxBody<Bytes, hyper::Error>;

const MAX_ACTIVITY_ENTRIES: usize = 16_384;
const ACTIVITY_STALE_MS: u64 = 24 * 60 * 60 * 1000;
const PROXY_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const PROXY_RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
const WS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

pub fn full_body(bytes: impl Into<Bytes>) -> BoxBody {
    Full::new(bytes.into())
        .map_err(|never| match never {})
        .boxed()
}

#[derive(Debug, Clone)]
pub enum ProxyError {
    ConnectFailed(String),
    UpstreamFailed(String),
}

impl std::fmt::Display for ProxyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProxyError::ConnectFailed(e) => write!(f, "connect_failed: {e}"),
            ProxyError::UpstreamFailed(e) => write!(f, "upstream_failed: {e}"),
        }
    }
}

#[derive(Clone)]
pub struct PooledProxyClient {
    client: Client<HttpConnector, BoxBody>,
}

impl Default for PooledProxyClient {
    fn default() -> Self {
        Self::new()
    }
}

impl PooledProxyClient {
    pub fn new() -> Self {
        let mut connector = HttpConnector::new();
        connector.set_nodelay(true);
        connector.set_connect_timeout(Some(PROXY_CONNECT_TIMEOUT));
        connector.set_keepalive(Some(Duration::from_secs(60)));
        let client = Client::builder(TokioExecutor::new())
            .pool_idle_timeout(Duration::from_secs(60))
            .pool_max_idle_per_host(128)
            .build(connector);
        Self { client }
    }
}

fn classify_client_error(err: hyper_util::client::legacy::Error) -> ProxyError {
    if err.is_connect() {
        return ProxyError::ConnectFailed(err.to_string());
    }
    let mut cur: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(&err);
    for _ in 0..6 {
        let Some(src) = cur else {
            break;
        };
        if let Some(he) = src.downcast_ref::<hyper::Error>() {
            if he.is_closed() || he.is_incomplete_message() || he.is_canceled() {
                return ProxyError::ConnectFailed(err.to_string());
            }
        }
        if let Some(io) = src.downcast_ref::<std::io::Error>() {
            if matches!(
                io.kind(),
                std::io::ErrorKind::ConnectionReset
                    | std::io::ErrorKind::BrokenPipe
                    | std::io::ErrorKind::UnexpectedEof
                    | std::io::ErrorKind::ConnectionAborted
                    | std::io::ErrorKind::ConnectionRefused
            ) {
                return ProxyError::ConnectFailed(err.to_string());
            }
        }
        cur = src.source();
    }
    ProxyError::UpstreamFailed(err.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WakeRequest {
    pub deployment_id: String,
    pub site_id: String,
    pub oci_image_ref: Option<String>,
    pub health_path: String,
    #[serde(default = "default_wake_idle")]
    pub idle_timeout_sec: u64,
    #[serde(default = "default_wake_memory")]
    pub memory_mb: u32,
    #[serde(default = "default_wake_vcpu")]
    pub vcpu_limit: f32,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

fn default_wake_idle() -> u64 {
    900
}

fn default_wake_memory() -> u32 {
    512
}

fn default_wake_vcpu() -> f32 {
    1.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WakeResponse {
    pub upstream_addr: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivitySnapshot {
    pub deployments: HashMap<String, u64>,
}

pub struct ActivityTracker {
    entries: ArcSwap<HashMap<String, Arc<AtomicU64>>>,
    write_lock: Mutex<()>,
}

impl Default for ActivityTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl ActivityTracker {
    pub fn new() -> Self {
        Self {
            entries: ArcSwap::from_pointee(HashMap::new()),
            write_lock: Mutex::new(()),
        }
    }

    pub fn record(&self, deployment_id: &str) {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64);
        let guard = self.entries.load();
        if let Some(slot) = guard.get(deployment_id) {
            let prev = slot.load(Ordering::Relaxed);
            if now_ms.saturating_sub(prev) >= 1_000 {
                slot.store(now_ms, Ordering::Relaxed);
            }
            return;
        }
        drop(guard);

        let _lock = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());
        let current = self.entries.load();
        if let Some(slot) = current.get(deployment_id) {
            slot.store(now_ms, Ordering::Relaxed);
            return;
        }
        let mut next: HashMap<String, Arc<AtomicU64>> = (**current).clone();
        if next.len() >= MAX_ACTIVITY_ENTRIES {
            next.retain(|_, ts| now_ms.saturating_sub(ts.load(Ordering::Relaxed)) < ACTIVITY_STALE_MS);
        }
        next.insert(deployment_id.to_string(), Arc::new(AtomicU64::new(now_ms)));
        self.entries.store(Arc::new(next));
    }

    pub fn snapshot(&self) -> ActivitySnapshot {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64);
        let guard = self.entries.load();
        let mut deployments = HashMap::with_capacity(guard.len());
        let mut stale_found = false;
        for (k, v) in guard.iter() {
            let ts = v.load(Ordering::Relaxed);
            if now_ms.saturating_sub(ts) < ACTIVITY_STALE_MS {
                deployments.insert(k.clone(), ts);
            } else {
                stale_found = true;
            }
        }
        drop(guard);
        if stale_found {
            let _lock = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());
            let mut next: HashMap<String, Arc<AtomicU64>> = (**self.entries.load()).clone();
            next.retain(|_, ts| now_ms.saturating_sub(ts.load(Ordering::Relaxed)) < ACTIVITY_STALE_MS);
            self.entries.store(Arc::new(next));
        }
        ActivitySnapshot { deployments }
    }
}

struct WakeFlightGuard<'a> {
    map: &'a Mutex<HashMap<String, broadcast::Sender<Result<String, String>>>>,
    key: String,
    finished: bool,
}

impl<'a> WakeFlightGuard<'a> {
    fn complete(mut self, outcome: Result<String, String>) -> Result<String, String> {
        self.finished = true;
        if let Ok(mut map) = self.map.lock() {
            if let Some(tx) = map.remove(&self.key) {
                let _ = tx.send(outcome.clone());
            }
        }
        outcome
    }
}

impl Drop for WakeFlightGuard<'_> {
    fn drop(&mut self) {
        if !self.finished {
            if let Ok(mut map) = self.map.lock() {
                if let Some(tx) = map.remove(&self.key) {
                    let _ = tx.send(Err("wake_cancelled".to_string()));
                }
            }
        }
    }
}

pub struct WakeCoordinator {
    app_host_base_url: Option<String>,
    control_token: String,
    wake_timeout: Duration,
    in_flight: Mutex<HashMap<String, broadcast::Sender<Result<String, String>>>>,
}

impl WakeCoordinator {
    pub fn new(app_host_base_url: Option<String>, control_token: String, wake_timeout: Duration) -> Self {
        Self {
            app_host_base_url,
            control_token,
            wake_timeout,
            in_flight: Mutex::new(HashMap::new()),
        }
    }

    pub async fn wake(&self, req: WakeRequest) -> Result<String, String> {
        let Some(base_url) = self.app_host_base_url.clone() else {
            return Err("app_host_not_configured".to_string());
        };
        let key = req.deployment_id.clone();
        let existing_rx = {
            let mut map = self.in_flight.lock().map_err(|_| "lock_poisoned".to_string())?;
            if let Some(tx) = map.get(&key) {
                Some(tx.subscribe())
            } else {
                let (tx, _) = broadcast::channel(16);
                map.insert(key.clone(), tx);
                None
            }
        };

        if let Some(mut rx) = existing_rx {
            return match tokio::time::timeout(self.wake_timeout, rx.recv()).await {
                Ok(Ok(result)) => result,
                Ok(Err(_)) => Err("wake_channel_closed".to_string()),
                Err(_) => Err("wake_timeout".to_string()),
            };
        }

        let guard = WakeFlightGuard {
            map: &self.in_flight,
            key,
            finished: false,
        };
        let outcome = tokio::time::timeout(
            self.wake_timeout,
            send_wake_http(&base_url, &self.control_token, &req),
        )
        .await
        .unwrap_or_else(|_| Err("wake_timeout".to_string()));
        guard.complete(outcome)
    }
}

async fn send_wake_http(base_url: &str, token: &str, payload: &WakeRequest) -> Result<String, String> {
    let trimmed = base_url.trim_end_matches('/');
    let full_url = format!("{trimmed}/_internal/apps/{}/wake", payload.deployment_id);
    let uri: Uri = full_url.parse().map_err(|_| "invalid_app_host_url".to_string())?;
    let host = uri.host().ok_or_else(|| "missing_app_host".to_string())?;
    let port = uri.port_u16().unwrap_or(80);
    let stream = tokio::time::timeout(PROXY_CONNECT_TIMEOUT, TcpStream::connect((host, port)))
        .await
        .map_err(|_| "app_host_connect_timeout".to_string())?
        .map_err(|e| format!("app_host_connect_failed: {e}"))?;
    let _ = stream.set_nodelay(true);
    let io = TokioIo::new(stream);
    let (mut sender, conn) = hyper::client::conn::http1::handshake(io)
        .await
        .map_err(|e| format!("app_host_handshake_failed: {e}"))?;
    tokio::spawn(async move {
        let _ = conn.await;
    });

    let body_bytes = serde_json::to_vec(payload).map_err(|e| e.to_string())?;
    let path_and_query = uri
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");
    let request = Request::builder()
        .method("POST")
        .uri(path_and_query)
        .header("host", format!("{host}:{port}"))
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {token}"))
        .body(Full::new(Bytes::from(body_bytes)))
        .map_err(|e| e.to_string())?;

    let response = sender
        .send_request(request)
        .await
        .map_err(|e| format!("app_host_request_failed: {e}"))?;
    let status = response.status();
    let collected = response
        .into_body()
        .collect()
        .await
        .map_err(|e| format!("app_host_body_failed: {e}"))?
        .to_bytes();
    if !status.is_success() {
        return Err(format!("app_host_status_{}", status.as_u16()));
    }
    let parsed: WakeResponse =
        serde_json::from_slice(&collected).map_err(|e| format!("app_host_invalid_json: {e}"))?;
    Ok(parsed.upstream_addr)
}

pub fn is_websocket_upgrade(headers: &HeaderMap) -> bool {
    let has_upgrade = headers
        .get("upgrade")
        .and_then(|v| v.to_str().ok())
        .map_or(false, |v| v.eq_ignore_ascii_case("websocket"));
    let has_connection = headers
        .get("connection")
        .and_then(|v| v.to_str().ok())
        .map_or(false, |v| {
            v.split(',')
                .any(|part| part.trim().eq_ignore_ascii_case("upgrade"))
        });
    has_upgrade && has_connection
}

pub async fn proxy_http_or_ws(
    pool: &PooledProxyClient,
    upstream_addr: &str,
    req: Request<Incoming>,
    forwarded_host: &str,
    client_ip: &str,
    is_private: bool,
) -> Result<Response<BoxBody>, ProxyError> {
    if is_websocket_upgrade(req.headers()) {
        return proxy_websocket(upstream_addr, req, forwarded_host, client_ip, is_private).await;
    }

    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");
    let uri: Uri = format!("http://{upstream_addr}{path_and_query}")
        .parse()
        .map_err(|e| ProxyError::UpstreamFailed(format!("invalid_upstream_uri: {e}")))?;

    let (parts, body) = req.into_parts();
    let mut out_builder = Request::builder().method(parts.method).uri(uri);
    if let Some(headers) = out_builder.headers_mut() {
        copy_request_headers(&parts.headers, headers, forwarded_host, client_ip, false);
    }
    let upstream_req = out_builder
        .body(body.boxed())
        .map_err(|e| ProxyError::UpstreamFailed(format!("build_upstream_request_failed: {e}")))?;

    let upstream_res = tokio::time::timeout(PROXY_RESPONSE_TIMEOUT, pool.client.request(upstream_req))
        .await
        .map_err(|_| ProxyError::UpstreamFailed("upstream_response_timeout".to_string()))?
        .map_err(classify_client_error)?;

    build_proxied_response(upstream_res, is_private)
}

pub async fn proxy_empty_request(
    pool: &PooledProxyClient,
    upstream_addr: &str,
    method: http::Method,
    path_and_query: &str,
    incoming_headers: &HeaderMap,
    forwarded_host: &str,
    client_ip: &str,
    is_private: bool,
) -> Result<Response<BoxBody>, ProxyError> {
    let uri: Uri = format!("http://{upstream_addr}{path_and_query}")
        .parse()
        .map_err(|e| ProxyError::UpstreamFailed(format!("invalid_upstream_uri: {e}")))?;

    let mut out_builder = Request::builder().method(method).uri(uri);
    if let Some(headers) = out_builder.headers_mut() {
        copy_request_headers(incoming_headers, headers, forwarded_host, client_ip, false);
    }
    let upstream_req = out_builder
        .body(full_body(Bytes::new()))
        .map_err(|e| ProxyError::UpstreamFailed(format!("build_retry_request_failed: {e}")))?;
    let upstream_res = tokio::time::timeout(PROXY_RESPONSE_TIMEOUT, pool.client.request(upstream_req))
        .await
        .map_err(|_| ProxyError::UpstreamFailed("upstream_response_timeout".to_string()))?
        .map_err(classify_client_error)?;

    build_proxied_response(upstream_res, is_private)
}

async fn proxy_websocket(
    upstream_addr: &str,
    mut req: Request<Incoming>,
    forwarded_host: &str,
    client_ip: &str,
    is_private: bool,
) -> Result<Response<BoxBody>, ProxyError> {
    let stream = tokio::time::timeout(PROXY_CONNECT_TIMEOUT, TcpStream::connect(upstream_addr))
        .await
        .map_err(|_| ProxyError::ConnectFailed("upstream_connect_timeout".to_string()))?
        .map_err(|e| ProxyError::ConnectFailed(format!("upstream_connect_failed: {e}")))?;
    let _ = stream.set_nodelay(true);
    let io = TokioIo::new(stream);
    let (mut sender, conn) = tokio::time::timeout(
        WS_HANDSHAKE_TIMEOUT,
        hyper::client::conn::http1::handshake(io),
    )
    .await
    .map_err(|_| ProxyError::ConnectFailed("upstream_handshake_timeout".to_string()))?
    .map_err(|e| ProxyError::ConnectFailed(format!("upstream_handshake_failed: {e}")))?;
    tokio::spawn(async move {
        let _ = conn.with_upgrades().await;
    });

    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    let client_upgrade = hyper::upgrade::on(&mut req);
    let method = req.method().clone();
    let incoming_headers = req.headers().clone();

    let mut out_builder = Request::builder().method(method).uri(path_and_query);
    if let Some(headers) = out_builder.headers_mut() {
        copy_request_headers(&incoming_headers, headers, forwarded_host, client_ip, true);
    }

    let upstream_req = out_builder
        .body(req.into_body())
        .map_err(|e| ProxyError::UpstreamFailed(format!("build_upstream_request_failed: {e}")))?;

    let mut upstream_res = tokio::time::timeout(WS_HANDSHAKE_TIMEOUT, sender.send_request(upstream_req))
        .await
        .map_err(|_| ProxyError::UpstreamFailed("ws_handshake_timeout".to_string()))?
        .map_err(|e| ProxyError::UpstreamFailed(format!("upstream_send_failed: {e}")))?;

    let status = upstream_res.status();
    let resp_headers = upstream_res.headers().clone();

    if status == StatusCode::SWITCHING_PROTOCOLS {
        let upstream_on_upgrade = hyper::upgrade::on(&mut upstream_res);
        tokio::spawn(async move {
            if let (Ok(client_upgraded), Ok(upstream_upgraded)) =
                tokio::join!(client_upgrade, upstream_on_upgrade)
            {
                let mut c = TokioIo::new(client_upgraded);
                let mut u = TokioIo::new(upstream_upgraded);
                let _ = tokio::io::copy_bidirectional(&mut c, &mut u).await;
            }
        });
        let mut builder = Response::builder().status(StatusCode::SWITCHING_PROTOCOLS);
        if let Some(headers) = builder.headers_mut() {
            for (name, value) in &resp_headers {
                headers.append(name.clone(), value.clone());
            }
        }
        return builder
            .body(full_body(Bytes::new()))
            .map_err(|e| ProxyError::UpstreamFailed(e.to_string()));
    }

    build_proxied_response(upstream_res, is_private)
}

fn copy_request_headers(
    incoming: &HeaderMap,
    out: &mut HeaderMap,
    forwarded_host: &str,
    client_ip: &str,
    ws_upgrade: bool,
) {
    for (name, value) in incoming {
        if name.as_str() == "cookie" {
            continue;
        }
        if should_forward_request_header(name, ws_upgrade) {
            out.append(name.clone(), value.clone());
        }
    }
    if let Some(filtered_cookie) = strip_platform_cookie(incoming) {
        if let Ok(v) = HeaderValue::from_str(&filtered_cookie) {
            out.insert(HeaderName::from_static("cookie"), v);
        }
    }
    if let Ok(v) = HeaderValue::from_str(forwarded_host) {
        out.insert(HeaderName::from_static("host"), v.clone());
        out.insert(HeaderName::from_static("x-forwarded-host"), v);
    }
    if let Ok(v) = HeaderValue::from_str(client_ip) {
        out.insert(HeaderName::from_static("x-forwarded-for"), v.clone());
        out.insert(HeaderName::from_static("x-real-ip"), v);
    }
    out.insert(
        HeaderName::from_static("x-forwarded-proto"),
        HeaderValue::from_static("https"),
    );
}

fn build_proxied_response(
    upstream_res: Response<Incoming>,
    is_private: bool,
) -> Result<Response<BoxBody>, ProxyError> {
    let status = upstream_res.status();
    let resp_headers = upstream_res.headers().clone();
    let mut builder = Response::builder().status(status);
    if let Some(headers) = builder.headers_mut() {
        for (name, value) in &resp_headers {
            if should_forward_response_header(name, is_private) {
                headers.append(name.clone(), value.clone());
            }
        }
        headers.insert(
            HeaderName::from_static("strict-transport-security"),
            HeaderValue::from_static(HSTS_HEADER),
        );
        if is_private {
            headers.insert(
                HeaderName::from_static("cache-control"),
                HeaderValue::from_static("private, no-store, no-transform"),
            );
            headers.insert(
                HeaderName::from_static("x-robots-tag"),
                HeaderValue::from_static("noindex, nofollow, noarchive"),
            );
        }
    }
    let body = upstream_res.into_body().boxed();
    builder
        .body(body)
        .map_err(|e| ProxyError::UpstreamFailed(e.to_string()))
}

fn should_forward_request_header(name: &HeaderName, ws_upgrade: bool) -> bool {
    let lower = name.as_str();
    if ws_upgrade && (lower == "connection" || lower == "upgrade") {
        return true;
    }
    !matches!(
        lower,
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailers"
            | "transfer-encoding"
            | "upgrade"
            | "host"
            | "x-forwarded-host"
            | "x-forwarded-for"
            | "x-forwarded-proto"
            | "x-real-ip"
            | "x-qorpera-client-ip"
    )
}

fn should_forward_response_header(name: &HeaderName, is_private: bool) -> bool {
    let lower = name.as_str();
    if is_private
        && matches!(
            lower,
            "cache-control" | "expires" | "cdn-cache-control" | "surrogate-control" | "x-robots-tag"
        )
    {
        return false;
    }
    !matches!(
        lower,
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailers"
            | "transfer-encoding"
            | "upgrade"
            | "strict-transport-security"
    )
}

pub fn new_shared_activity() -> Arc<ActivityTracker> {
    Arc::new(ActivityTracker::new())
}
