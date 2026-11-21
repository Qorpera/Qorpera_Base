use bytes::Bytes;
use http::{HeaderMap, HeaderName, HeaderValue, Request, Response, StatusCode, Uri};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::net::TcpStream;
use tokio::sync::broadcast;

pub type BoxBody = http_body_util::combinators::BoxBody<Bytes, hyper::Error>;

pub fn full_body(bytes: impl Into<Bytes>) -> BoxBody {
    Full::new(bytes.into())
        .map_err(|never| match never {})
        .boxed()
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
    last_seen_ms: Mutex<HashMap<String, u64>>,
}

impl Default for ActivityTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl ActivityTracker {
    pub fn new() -> Self {
        Self {
            last_seen_ms: Mutex::new(HashMap::new()),
        }
    }

    pub fn record(&self, deployment_id: &str) {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64);
        if let Ok(mut map) = self.last_seen_ms.lock() {
            map.insert(deployment_id.to_string(), now_ms);
        }
    }

    pub fn snapshot(&self) -> ActivitySnapshot {
        let deployments = self
            .last_seen_ms
            .lock()
            .map(|m| m.clone())
            .unwrap_or_default();
        ActivitySnapshot { deployments }
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
                let (tx, _) = broadcast::channel(4);
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

        let outcome = tokio::time::timeout(
            self.wake_timeout,
            send_wake_http(&base_url, &self.control_token, &req),
        )
        .await
        .unwrap_or_else(|_| Err("wake_timeout".to_string()));

        if let Ok(mut map) = self.in_flight.lock() {
            if let Some(tx) = map.remove(&key) {
                let _ = tx.send(outcome.clone());
            }
        }
        outcome
    }
}

async fn send_wake_http(base_url: &str, token: &str, payload: &WakeRequest) -> Result<String, String> {
    let trimmed = base_url.trim_end_matches('/');
    let full_url = format!("{trimmed}/_internal/apps/{}/wake", payload.deployment_id);
    let uri: Uri = full_url.parse().map_err(|_| "invalid_app_host_url".to_string())?;
    let host = uri.host().ok_or_else(|| "missing_app_host".to_string())?;
    let port = uri.port_u16().unwrap_or(80);
    let stream = TcpStream::connect((host, port))
        .await
        .map_err(|e| format!("app_host_connect_failed: {e}"))?;
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
    upstream_addr: &str,
    mut req: Request<Incoming>,
    forwarded_host: &str,
    client_ip: &str,
    is_private: bool,
) -> Result<Response<BoxBody>, String> {
    let stream = TcpStream::connect(upstream_addr)
        .await
        .map_err(|e| format!("upstream_connect_failed: {e}"))?;
    let io = TokioIo::new(stream);
    let (mut sender, conn) = hyper::client::conn::http1::handshake(io)
        .await
        .map_err(|e| format!("upstream_handshake_failed: {e}"))?;
    tokio::spawn(async move {
        let _ = conn.with_upgrades().await;
    });

    let ws_upgrade = is_websocket_upgrade(req.headers());
    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());

    let client_upgrade = if ws_upgrade {
        Some(hyper::upgrade::on(&mut req))
    } else {
        None
    };

    let method = req.method().clone();
    let incoming_headers = req.headers().clone();

    let mut out_builder = Request::builder().method(method).uri(path_and_query);
    if let Some(headers) = out_builder.headers_mut() {
        for (name, value) in &incoming_headers {
            if should_forward_request_header(name, ws_upgrade) {
                headers.append(name.clone(), value.clone());
            }
        }
        if let Ok(v) = HeaderValue::from_str(forwarded_host) {
            headers.insert(HeaderName::from_static("host"), v.clone());
            headers.insert(HeaderName::from_static("x-forwarded-host"), v);
        }
        if let Ok(v) = HeaderValue::from_str(client_ip) {
            headers.insert(HeaderName::from_static("x-forwarded-for"), v.clone());
            headers.insert(HeaderName::from_static("x-real-ip"), v);
        }
        headers.insert(
            HeaderName::from_static("x-forwarded-proto"),
            HeaderValue::from_static("https"),
        );
    }

    let upstream_req = out_builder
        .body(req.into_body())
        .map_err(|e| format!("build_upstream_request_failed: {e}"))?;

    let mut upstream_res = sender
        .send_request(upstream_req)
        .await
        .map_err(|e| format!("upstream_send_failed: {e}"))?;

    let status = upstream_res.status();
    let resp_headers = upstream_res.headers().clone();

    if status == StatusCode::SWITCHING_PROTOCOLS {
        if let Some(client_on_upgrade) = client_upgrade {
            let upstream_on_upgrade = hyper::upgrade::on(&mut upstream_res);
            tokio::spawn(async move {
                if let (Ok(client_upgraded), Ok(upstream_upgraded)) =
                    tokio::join!(client_on_upgrade, upstream_on_upgrade)
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
                .map_err(|e| e.to_string());
        }
    }

    let mut builder = Response::builder().status(status);
    if let Some(headers) = builder.headers_mut() {
        for (name, value) in &resp_headers {
            if should_forward_response_header(name, is_private) {
                headers.append(name.clone(), value.clone());
            }
        }
        if is_private {
            headers.insert(
                HeaderName::from_static("cache-control"),
                HeaderValue::from_static("private, no-store, no-transform"),
            );
        }
    }
    let body = upstream_res.into_body().boxed();
    builder.body(body).map_err(|e| e.to_string())
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
            "cache-control" | "expires" | "cdn-cache-control" | "surrogate-control"
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
    )
}

pub fn new_shared_activity() -> Arc<ActivityTracker> {
    Arc::new(ActivityTracker::new())
}
