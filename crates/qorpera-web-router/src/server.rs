use crate::blob_store::{AcceptedEncodings, BlobError, BlobStore, PutOutcome};
use crate::dns_verify::{default_dns_servers, verify_domains_once};
use crate::proxy::{
    full_body, is_websocket_upgrade, proxy_empty_request, proxy_http_or_ws, ActivityTracker, BoxBody,
    PooledProxyClient, ProxyError, WakeCoordinator, WakeRequest,
};
use crate::ratelimit::RateLimiter;
use crate::routes::{
    matching_custom_headers, normalize_host_cow, resolve_static_path, DeploymentKind, EdgeSnapshot,
    HostScope, ResolvedHost, RouteTable, SharedRoutes, StaticResolution,
};
use crate::security::{
    check_cross_site_write, constant_time_eq, extract_client_ip_cow, inject_preview_banner,
    parse_cookie, render_app_unavailable_page, render_not_found_page, render_password_page,
    render_takedown_page, sanitize_next_path, sanitize_redirect_location, sign_preview_cookie,
    sign_session_cookie, verify_preview_cookie, verify_session_cookie, HSTS_HEADER,
    SITE_SESSION_COOKIE,
};
use bytes::Bytes;
use http::{HeaderName, HeaderValue, Method, Request, Response, StatusCode};
use http_body_util::{BodyExt, Limited};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::future::Future;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::net::TcpListener;
use tokio::sync::Semaphore;
use tokio_postgres::NoTls;

const MAX_FORM_BODY_BYTES: usize = 16 * 1024;
const MAX_CONTROL_JSON_BYTES: usize = 64 * 1024;
const MAX_SNAPSHOT_BODY_BYTES: usize = 64 * 1024 * 1024;
const MAX_PUBLIC_CONNS: usize = 4096;
const MAX_INTERNAL_CONNS: usize = 256;
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(10);
const AUTH_DB_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone)]
pub struct RedeemedTicket {
    pub site_id: String,
    pub version_id: String,
    pub password_version: i32,
    pub max_age: u64,
}

#[derive(Debug, Clone)]
pub struct RedeemedMemberPass {
    pub site_id: String,
    pub password_version: i32,
    pub max_age: u64,
}

pub trait EdgeAuthBackend: Send + Sync {
    fn redeem_preview_ticket(
        &self,
        host: String,
        ticket: String,
    ) -> Pin<Box<dyn Future<Output = Option<RedeemedTicket>> + Send>>;

    fn redeem_member_pass(
        &self,
        host: String,
        pass: String,
    ) -> Pin<Box<dyn Future<Output = Option<RedeemedMemberPass>> + Send>>;
}

pub struct PostgresAuthBackend {
    database_url: String,
    client: Arc<tokio::sync::Mutex<Option<Arc<tokio_postgres::Client>>>>,
}

impl PostgresAuthBackend {
    pub fn new(database_url: String) -> Self {
        Self {
            database_url,
            client: Arc::new(tokio::sync::Mutex::new(None)),
        }
    }

    async fn get_client(
        db_url: &str,
        slot: &tokio::sync::Mutex<Option<Arc<tokio_postgres::Client>>>,
    ) -> Option<Arc<tokio_postgres::Client>> {
        {
            let guard = slot.lock().await;
            if let Some(ref c) = *guard {
                if !c.is_closed() {
                    return Some(Arc::clone(c));
                }
            }
        }
        let (client, conn) = tokio::time::timeout(AUTH_DB_TIMEOUT, tokio_postgres::connect(db_url, NoTls))
            .await
            .ok()?
            .ok()?;
        tokio::spawn(async move {
            let _ = conn.await;
        });
        let arc = Arc::new(client);
        let mut guard = slot.lock().await;
        *guard = Some(Arc::clone(&arc));
        Some(arc)
    }

    async fn query_json(
        db_url: &str,
        slot: &tokio::sync::Mutex<Option<Arc<tokio_postgres::Client>>>,
        sql: &str,
        arg1: &str,
        arg2: &str,
    ) -> Option<serde_json::Value> {
        for attempt in 0..2 {
            let client = Self::get_client(db_url, slot).await?;
            match tokio::time::timeout(AUTH_DB_TIMEOUT, client.query_one(sql, &[&arg1, &arg2])).await {
                Ok(Ok(row)) => return Some(row.get(0)),
                _ => {
                    let mut guard = slot.lock().await;
                    *guard = None;
                    if attempt == 1 {
                        return None;
                    }
                }
            }
        }
        None
    }
}

impl EdgeAuthBackend for PostgresAuthBackend {
    fn redeem_preview_ticket(
        &self,
        host: String,
        ticket: String,
    ) -> Pin<Box<dyn Future<Output = Option<RedeemedTicket>> + Send>> {
        let db_url = self.database_url.clone();
        let slot = Arc::clone(&self.client);
        Box::pin(async move {
            let val = Self::query_json(
                &db_url,
                &slot,
                "SELECT public.qorpera_web_edge_redeem_ticket($1::text, $2::text)",
                &host,
                &ticket,
            )
            .await?;
            if val.get("state")?.as_str()? != "open" {
                return None;
            }
            Some(RedeemedTicket {
                site_id: val.get("site_id")?.as_str()?.to_string(),
                version_id: val.get("version_id")?.as_str()?.to_string(),
                password_version: val.get("password_version")?.as_i64()? as i32,
                max_age: val.get("max_age")?.as_u64().unwrap_or(43200),
            })
        })
    }

    fn redeem_member_pass(
        &self,
        host: String,
        pass: String,
    ) -> Pin<Box<dyn Future<Output = Option<RedeemedMemberPass>> + Send>> {
        let db_url = self.database_url.clone();
        let slot = Arc::clone(&self.client);
        Box::pin(async move {
            let val = Self::query_json(
                &db_url,
                &slot,
                "SELECT public.qorpera_web_edge_redeem_member_pass($1::text, $2::text)",
                &host,
                &pass,
            )
            .await?;
            if val.get("state")?.as_str()? != "open" {
                return None;
            }
            Some(RedeemedMemberPass {
                site_id: val.get("site_id")?.as_str()?.to_string(),
                password_version: val.get("password_version")?.as_i64()? as i32,
                max_age: val.get("max_age")?.as_u64().unwrap_or(43200),
            })
        })
    }
}

#[derive(Default)]
pub struct MemoryAuthBackend {
    tickets: Mutex<HashMap<(String, String), RedeemedTicket>>,
    passes: Mutex<HashMap<(String, String), RedeemedMemberPass>>,
}

impl MemoryAuthBackend {
    pub fn insert_ticket(&self, host: &str, ticket: &str, value: RedeemedTicket) {
        if let Ok(mut map) = self.tickets.lock() {
            map.insert((host.to_ascii_lowercase(), ticket.to_string()), value);
        }
    }

    pub fn insert_member_pass(&self, host: &str, pass: &str, value: RedeemedMemberPass) {
        if let Ok(mut map) = self.passes.lock() {
            map.insert((host.to_ascii_lowercase(), pass.to_string()), value);
        }
    }
}

impl EdgeAuthBackend for MemoryAuthBackend {
    fn redeem_preview_ticket(
        &self,
        host: String,
        ticket: String,
    ) -> Pin<Box<dyn Future<Output = Option<RedeemedTicket>> + Send>> {
        let result = self
            .tickets
            .lock()
            .ok()
            .and_then(|mut map| map.remove(&(host.to_ascii_lowercase(), ticket)));
        Box::pin(async move { result })
    }

    fn redeem_member_pass(
        &self,
        host: String,
        pass: String,
    ) -> Pin<Box<dyn Future<Output = Option<RedeemedMemberPass>> + Send>> {
        let result = self
            .passes
            .lock()
            .ok()
            .and_then(|mut map| map.remove(&(host.to_ascii_lowercase(), pass)));
        Box::pin(async move { result })
    }
}

pub struct RouterConfig {
    pub public_bind: SocketAddr,
    pub internal_bind: SocketAddr,
    pub control_token: String,
    pub cookie_secret: Vec<u8>,
    pub trusted_proxies: Vec<IpAddr>,
    pub rate_limit_rps: f64,
    pub rate_limit_burst: f64,
    pub unlock_limit_rps: f64,
    pub unlock_limit_burst: f64,
    pub app_host_url: Option<String>,
    pub wake_timeout: Duration,
    pub dns_servers: Vec<SocketAddr>,
    pub database_url: Option<String>,
    pub auth_backend: Option<Arc<dyn EdgeAuthBackend>>,
}

pub struct RouterState {
    pub blobs: Arc<BlobStore>,
    pub routes: Arc<SharedRoutes>,
    pub limiter: Arc<RateLimiter>,
    pub unlock_limiter: Arc<RateLimiter>,
    pub activity: Arc<ActivityTracker>,
    pub waker: Arc<WakeCoordinator>,
    pub proxy_client: PooledProxyClient,
    pub control_token: String,
    pub cookie_secret: Vec<u8>,
    pub trusted_proxies: Vec<IpAddr>,
    pub dns_servers: Vec<SocketAddr>,
    pub database_url: Option<String>,
    pub auth_backend: Option<Arc<dyn EdgeAuthBackend>>,
    pub ready: Arc<AtomicBool>,
    db_slot: Arc<tokio::sync::Mutex<Option<Arc<tokio_postgres::Client>>>>,
}

impl RouterState {
    pub fn new(blobs: Arc<BlobStore>, initial: EdgeSnapshot, cfg: &RouterConfig) -> Self {
        let dns_servers = if cfg.dns_servers.is_empty() {
            default_dns_servers()
        } else {
            cfg.dns_servers.clone()
        };
        let auth_backend = cfg.auth_backend.clone().or_else(|| {
            cfg.database_url
                .clone()
                .map(|url| Arc::new(PostgresAuthBackend::new(url)) as Arc<dyn EdgeAuthBackend>)
        });
        let ready = Arc::new(AtomicBool::new(cfg.database_url.is_none()));
        Self {
            blobs,
            routes: Arc::new(SharedRoutes::new(RouteTable::from_snapshot(initial))),
            limiter: Arc::new(RateLimiter::new(cfg.rate_limit_rps, cfg.rate_limit_burst, 65_536)),
            unlock_limiter: Arc::new(RateLimiter::new(
                cfg.unlock_limit_rps,
                cfg.unlock_limit_burst,
                32_768,
            )),
            activity: Arc::new(ActivityTracker::new()),
            waker: Arc::new(WakeCoordinator::new(
                cfg.app_host_url.clone(),
                cfg.control_token.clone(),
                cfg.wake_timeout,
            )),
            proxy_client: PooledProxyClient::new(),
            control_token: cfg.control_token.clone(),
            cookie_secret: cfg.cookie_secret.clone(),
            trusted_proxies: cfg.trusted_proxies.clone(),
            dns_servers,
            database_url: cfg.database_url.clone(),
            auth_backend,
            ready,
            db_slot: Arc::new(tokio::sync::Mutex::new(None)),
        }
    }
}

pub struct BoundServers {
    pub public_addr: SocketAddr,
    pub internal_addr: SocketAddr,
    public_listener: TcpListener,
    internal_listener: TcpListener,
    state: Arc<RouterState>,
}

impl BoundServers {
    pub async fn bind(cfg: &RouterConfig, state: Arc<RouterState>) -> Result<Self, std::io::Error> {
        let public_listener = TcpListener::bind(cfg.public_bind).await?;
        let internal_listener = TcpListener::bind(cfg.internal_bind).await?;
        let public_addr = public_listener.local_addr()?;
        let internal_addr = internal_listener.local_addr()?;
        Ok(Self {
            public_addr,
            internal_addr,
            public_listener,
            internal_listener,
            state,
        })
    }

    pub fn spawn(self) -> (tokio::task::JoinHandle<()>, tokio::task::JoinHandle<()>) {
        let pub_state = Arc::clone(&self.state);
        let pub_listener = self.public_listener;
        let pub_sem = Arc::new(Semaphore::new(MAX_PUBLIC_CONNS));
        let pub_handle = tokio::spawn(async move {
            loop {
                let Ok((stream, peer)) = pub_listener.accept().await else {
                    continue;
                };
                let Ok(permit) = Arc::clone(&pub_sem).try_acquire_owned() else {
                    drop(stream);
                    continue;
                };
                let _ = stream.set_nodelay(true);
                let state = Arc::clone(&pub_state);
                tokio::spawn(async move {
                    let _permit = permit;
                    let io = TokioIo::new(stream);
                    let svc = service_fn(move |req| {
                        let st = Arc::clone(&state);
                        async move { Ok::<_, hyper::Error>(handle_public(st, peer.ip(), req).await) }
                    });
                    let mut builder = hyper_util::server::conn::auto::Builder::new(TokioExecutor::new());
                    builder
                        .http1()
                        .timer(TokioTimer::new())
                        .header_read_timeout(HEADER_READ_TIMEOUT);
                    builder
                        .http2()
                        .timer(TokioTimer::new())
                        .keep_alive_interval(Duration::from_secs(30))
                        .keep_alive_timeout(Duration::from_secs(10));
                    let _ = builder.serve_connection_with_upgrades(io, svc).await;
                });
            }
        });

        let int_state = Arc::clone(&self.state);
        let int_listener = self.internal_listener;
        let int_sem = Arc::new(Semaphore::new(MAX_INTERNAL_CONNS));
        let int_handle = tokio::spawn(async move {
            loop {
                let Ok((stream, _peer)) = int_listener.accept().await else {
                    continue;
                };
                let Ok(permit) = Arc::clone(&int_sem).try_acquire_owned() else {
                    drop(stream);
                    continue;
                };
                let _ = stream.set_nodelay(true);
                let state = Arc::clone(&int_state);
                tokio::spawn(async move {
                    let _permit = permit;
                    let io = TokioIo::new(stream);
                    let svc = service_fn(move |req| {
                        let st = Arc::clone(&state);
                        async move { Ok::<_, hyper::Error>(handle_internal(st, req).await) }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .timer(TokioTimer::new())
                        .header_read_timeout(HEADER_READ_TIMEOUT)
                        .serve_connection(io, svc)
                        .await;
                });
            }
        });

        (pub_handle, int_handle)
    }
}

#[cfg(unix)]
pub fn spawn_public_unix_listener(
    path: std::path::PathBuf,
    state: Arc<RouterState>,
) -> Result<tokio::task::JoinHandle<()>, std::io::Error> {
    if path.exists() {
        let _ = std::fs::remove_file(&path);
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let listener = tokio::net::UnixListener::bind(&path)?;
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666));
    }
    let sem = Arc::new(Semaphore::new(MAX_PUBLIC_CONNS));
    Ok(tokio::spawn(async move {
        let loopback = IpAddr::V4(std::net::Ipv4Addr::LOCALHOST);
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                continue;
            };
            let Ok(permit) = Arc::clone(&sem).try_acquire_owned() else {
                drop(stream);
                continue;
            };
            let st = Arc::clone(&state);
            tokio::spawn(async move {
                let _permit = permit;
                let io = TokioIo::new(stream);
                let svc = service_fn(move |req| {
                    let s = Arc::clone(&st);
                    async move { Ok::<_, hyper::Error>(handle_public(s, loopback, req).await) }
                });
                let mut builder = hyper_util::server::conn::auto::Builder::new(TokioExecutor::new());
                builder
                    .http1()
                    .timer(TokioTimer::new())
                    .header_read_timeout(HEADER_READ_TIMEOUT);
                builder
                    .http2()
                    .timer(TokioTimer::new())
                    .keep_alive_interval(Duration::from_secs(30))
                    .keep_alive_timeout(Duration::from_secs(10));
                let _ = builder.serve_connection_with_upgrades(io, svc).await;
            });
        }
    }))
}

#[derive(Serialize)]
struct HealthBody {
    ok: bool,
}

#[derive(Deserialize)]
struct UpstreamUpdateBody {
    upstream_addr: Option<String>,
}

enum BodyReadError {
    TooLarge,
    Failed,
}

async fn read_limited_body(body: Incoming, max_bytes: usize) -> Result<Bytes, BodyReadError> {
    match Limited::new(body, max_bytes).collect().await {
        Ok(collected) => Ok(collected.to_bytes()),
        Err(err) => {
            if err.downcast_ref::<http_body_util::LengthLimitError>().is_some() {
                Err(BodyReadError::TooLarge)
            } else {
                Err(BodyReadError::Failed)
            }
        }
    }
}

fn json_response(status: StatusCode, body: impl Serialize) -> Response<BoxBody> {
    let payload = serde_json::to_vec(&body).unwrap_or_else(|_| b"{}".to_vec());
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .header("cache-control", "no-store")
        .body(full_body(payload))
        .unwrap()
}

fn text_response(status: StatusCode, body: &'static str) -> Response<BoxBody> {
    Response::builder()
        .status(status)
        .header("content-type", "text/plain; charset=utf-8")
        .header("cache-control", "no-store, no-transform")
        .body(full_body(body.as_bytes()))
        .unwrap()
}

fn html_response(status: StatusCode, html: impl Into<Bytes>, noindex: bool) -> Response<BoxBody> {
    let mut builder = Response::builder()
        .status(status)
        .header("content-type", "text/html; charset=utf-8")
        .header("cache-control", "no-store, no-transform")
        .header("strict-transport-security", HSTS_HEADER)
        .header("x-content-type-options", "nosniff");
    if noindex {
        builder = builder.header("x-robots-tag", "noindex, nofollow, noarchive");
    }
    builder.body(full_body(html)).unwrap()
}

fn safe_redirect_response(
    status: StatusCode,
    location: &str,
    set_cookie: Option<&str>,
) -> Response<BoxBody> {
    let Some(safe_loc) = sanitize_redirect_location(location) else {
        return html_response(StatusCode::BAD_REQUEST, render_not_found_page(), true);
    };
    let Ok(loc_val) = HeaderValue::from_str(&safe_loc) else {
        return html_response(StatusCode::BAD_REQUEST, render_not_found_page(), true);
    };
    let mut builder = Response::builder()
        .status(status)
        .header("location", loc_val)
        .header("cache-control", "no-store, no-transform")
        .header("strict-transport-security", HSTS_HEADER);
    if let Some(cookie) = set_cookie {
        if let Ok(c_val) = HeaderValue::from_str(cookie) {
            builder = builder.header("set-cookie", c_val);
        }
    }
    builder
        .body(full_body(Bytes::new()))
        .unwrap_or_else(|_| text_response(StatusCode::INTERNAL_SERVER_ERROR, "redirect error"))
}

fn check_bearer(req: &Request<Incoming>, expected_token: &str) -> bool {
    let Some(header) = req.headers().get("authorization").and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let Some(token) = header.strip_prefix("Bearer ") else {
        return false;
    };
    constant_time_eq(token.as_bytes(), expected_token.as_bytes())
}

async fn persist_upstream_to_db(
    db_url: &str,
    slot: &tokio::sync::Mutex<Option<Arc<tokio_postgres::Client>>>,
    dep_id: &str,
    upstream_addr: &Option<String>,
) {
    for attempt in 0..2 {
        let Some(client) = PostgresAuthBackend::get_client(db_url, slot).await else {
            return;
        };
        let res = tokio::time::timeout(
            AUTH_DB_TIMEOUT,
            client.execute(
                "SELECT public.qorpera_web_deployment_set_upstream($1::text::uuid, $2::text)",
                &[&dep_id, upstream_addr],
            ),
        )
        .await;
        match res {
            Ok(Ok(_)) => return,
            _ => {
                let mut guard = slot.lock().await;
                *guard = None;
                if attempt == 1 {
                    return;
                }
            }
        }
    }
}

async fn handle_internal(state: Arc<RouterState>, req: Request<Incoming>) -> Response<BoxBody> {
    let path = req.uri().path().to_string();
    let method = req.method().clone();

    if method == Method::GET && path == "/_internal/health" {
        if state.ready.load(Ordering::Acquire) {
            return json_response(StatusCode::OK, HealthBody { ok: true });
        }
        return json_response(StatusCode::SERVICE_UNAVAILABLE, HealthBody { ok: false });
    }

    if method == Method::GET && path == "/_internal/tls/allow" {
        let domain = req
            .uri()
            .query()
            .and_then(|q| query_param(q, "domain"))
            .unwrap_or_default();
        let allowed = state.routes.load().is_tls_allowed(&domain);
        return if allowed {
            text_response(StatusCode::OK, "allowed")
        } else {
            text_response(StatusCode::FORBIDDEN, "denied")
        };
    }

    if !check_bearer(&req, &state.control_token) {
        return text_response(StatusCode::UNAUTHORIZED, "unauthorized");
    }

    if method == Method::GET && path == "/_internal/metrics/activity" {
        return json_response(StatusCode::OK, state.activity.snapshot());
    }

    if method == Method::POST && path == "/_internal/domains/verify" {
        let outcomes = verify_domains_once(
            &state.routes,
            &state.dns_servers,
            state.database_url.as_deref(),
            Duration::from_secs(3),
        )
        .await;
        return json_response(StatusCode::OK, serde_json::json!({ "checked": outcomes }));
    }

    if method == Method::POST && path == "/_internal/routes/snapshot" {
        let bytes = match read_limited_body(req.into_body(), MAX_SNAPSHOT_BODY_BYTES).await {
            Ok(b) => b,
            Err(BodyReadError::TooLarge) => {
                return text_response(StatusCode::PAYLOAD_TOO_LARGE, "snapshot too large");
            }
            Err(BodyReadError::Failed) => {
                return text_response(StatusCode::BAD_REQUEST, "invalid body");
            }
        };
        let snapshot: EdgeSnapshot = match serde_json::from_slice(&bytes) {
            Ok(s) => s,
            Err(_) => return text_response(StatusCode::BAD_REQUEST, "invalid snapshot json"),
        };
        state.routes.update(|table| table.apply_snapshot(snapshot));
        state.ready.store(true, Ordering::Release);
        return json_response(StatusCode::OK, HealthBody { ok: true });
    }

    if method == Method::POST {
        if let Some(rest) = path.strip_prefix("/_internal/deployments/") {
            if let Some(dep_id) = rest.strip_suffix("/upstream") {
                if !dep_id.is_empty() && !dep_id.contains('/') {
                    let bytes = match read_limited_body(req.into_body(), MAX_CONTROL_JSON_BYTES).await {
                        Ok(b) => b,
                        Err(BodyReadError::TooLarge) => {
                            return text_response(StatusCode::PAYLOAD_TOO_LARGE, "payload too large");
                        }
                        Err(BodyReadError::Failed) => {
                            return text_response(StatusCode::BAD_REQUEST, "invalid body");
                        }
                    };
                    let parsed: UpstreamUpdateBody = match serde_json::from_slice(&bytes) {
                        Ok(v) => v,
                        Err(_) => return text_response(StatusCode::BAD_REQUEST, "invalid json"),
                    };
                    state.routes.update(|table| {
                        table.set_upstream_override(dep_id.to_string(), parsed.upstream_addr.clone());
                    });
                    if let Some(ref db_url) = state.database_url {
                        persist_upstream_to_db(db_url, &state.db_slot, dep_id, &parsed.upstream_addr).await;
                    }
                    return json_response(StatusCode::OK, HealthBody { ok: true });
                }
            }
        }
    }

    if let Some(sha) = path.strip_prefix("/_internal/blobs/") {
        if method == Method::HEAD {
            return match state.blobs.exists(sha).await {
                Ok(true) => Response::builder()
                    .status(StatusCode::OK)
                    .body(full_body(Bytes::new()))
                    .unwrap(),
                Ok(false) => Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(full_body(Bytes::new()))
                    .unwrap(),
                Err(BlobError::InvalidHash) => text_response(StatusCode::BAD_REQUEST, "invalid sha256"),
                Err(_) => text_response(StatusCode::INTERNAL_SERVER_ERROR, "storage error"),
            };
        }
        if method == Method::PUT {
            let max_len = state.blobs.max_blob_bytes();
            let content_len = req
                .headers()
                .get("content-length")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<usize>().ok());
            if let Some(len) = content_len {
                if len > max_len {
                    return text_response(StatusCode::PAYLOAD_TOO_LARGE, "blob too large");
                }
            }
            let body = match read_limited_body(req.into_body(), max_len).await {
                Ok(b) => b,
                Err(BodyReadError::TooLarge) => {
                    return text_response(StatusCode::PAYLOAD_TOO_LARGE, "blob too large");
                }
                Err(BodyReadError::Failed) => {
                    return text_response(StatusCode::BAD_REQUEST, "body read failed");
                }
            };
            return match state.blobs.put(sha, body, true).await {
                Ok(PutOutcome::Stored) => json_response(StatusCode::CREATED, serde_json::json!({"state":"stored"})),
                Ok(PutOutcome::Exists) => json_response(StatusCode::OK, serde_json::json!({"state":"exists"})),
                Err(BlobError::InvalidHash) => text_response(StatusCode::BAD_REQUEST, "invalid sha256"),
                Err(BlobError::HashMismatch) => text_response(StatusCode::BAD_REQUEST, "sha256 mismatch"),
                Err(BlobError::TooLarge) => text_response(StatusCode::PAYLOAD_TOO_LARGE, "blob too large"),
                Err(_) => text_response(StatusCode::INTERNAL_SERVER_ERROR, "storage error"),
            };
        }
    }

    text_response(StatusCode::NOT_FOUND, "not found")
}

async fn handle_public(
    state: Arc<RouterState>,
    peer_ip: IpAddr,
    req: Request<Incoming>,
) -> Response<BoxBody> {
    let raw_host = req
        .headers()
        .get("x-forwarded-host")
        .or_else(|| req.headers().get("host"))
        .and_then(|v| v.to_str().ok())
        .or_else(|| req.uri().authority().map(|a| a.as_str()))
        .unwrap_or("");
    let Some(host_cow) = normalize_host_cow(raw_host) else {
        return html_response(StatusCode::BAD_REQUEST, render_not_found_page(), true);
    };
    let host_owned: Option<String>;
    let host: &str = match host_cow {
        std::borrow::Cow::Borrowed(s) => s,
        std::borrow::Cow::Owned(s) => {
            host_owned = Some(s);
            host_owned.as_deref().unwrap_or("")
        }
    };
    let client_ip_cow = extract_client_ip_cow(req.headers(), peer_ip, &state.trusted_proxies);
    let client_ip_owned: Option<String>;
    let client_ip: &str = match client_ip_cow {
        std::borrow::Cow::Borrowed(s) => s,
        std::borrow::Cow::Owned(s) => {
            client_ip_owned = Some(s);
            client_ip_owned.as_deref().unwrap_or("")
        }
    };

    let decision = state.limiter.check_pair(host, client_ip);
    if !decision.allowed {
        return Response::builder()
            .status(StatusCode::TOO_MANY_REQUESTS)
            .header("retry-after", decision.retry_after_secs.to_string())
            .header("cache-control", "no-store, no-transform")
            .header("content-type", "text/plain; charset=utf-8")
            .body(full_body("Too many requests"))
            .unwrap();
    }

    let is_member_pass_post = req.method() == Method::POST && req.uri().path() == "/__qorpera/member";
    if !is_member_pass_post && !check_cross_site_write(req.method(), req.headers(), host) {
        return text_response(StatusCode::FORBIDDEN, "cross-site write refused");
    }

    let route_table = state.routes.load();
    let resolved_host = route_table.resolve_host(host);
    let global_public_enabled = route_table.public_enabled;

    let Some(resolved_host) = resolved_host else {
        return html_response(StatusCode::NOT_FOUND, render_not_found_page(), true);
    };

    let (site, scope, canonical_redirect) = match resolved_host {
        ResolvedHost::UnknownOwnHost { scope } => {
            let path = req.uri().path();
            if path == "/robots.txt" {
                return Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "text/plain; charset=utf-8")
                    .header("cache-control", "no-store, no-transform")
                    .body(full_body("User-agent: *\nDisallow: /\n"))
                    .unwrap();
            }
            let body = if scope == HostScope::NextHost {
                render_password_page("/", false)
            } else {
                render_password_page(path, false)
            };
            return html_response(StatusCode::UNAUTHORIZED, body, true);
        }
        ResolvedHost::Site {
            site,
            scope,
            canonical_redirect,
        } => (site, scope, canonical_redirect),
    };

    if site.taken_down {
        return html_response(StatusCode::GONE, render_takedown_page(), true);
    }

    if scope == HostScope::NextHost && req.method() == Method::GET && req.uri().path() == "/.qorpera/enter" {
        let host_s = host.to_string();
        drop(route_table);
        return handle_preview_enter(state, &site, &host_s, req).await;
    }

    if scope == HostScope::OwnHost && is_member_pass_post {
        let host_s = host.to_string();
        drop(route_table);
        return handle_member_pass(state, &site, &host_s, req).await;
    }

    let is_public = global_public_enabled && site.is_public && scope != HostScope::NextHost;
    let now_unix = if canonical_redirect.is_some() || !is_public {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs())
    } else {
        0
    };

    if let Some(primary) = canonical_redirect {
        let in_app_iframe = scope == HostScope::OwnHost
            && req
                .headers()
                .get("sec-fetch-dest")
                .and_then(|v| v.to_str().ok())
                .map_or(false, |v| v.eq_ignore_ascii_case("iframe"))
            && parse_cookie(req.headers(), SITE_SESSION_COOKIE).map_or(false, |cookie| {
                verify_session_cookie(
                    &cookie,
                    &state.cookie_secret,
                    &site.id,
                    "site",
                    site.password_version,
                    now_unix,
                )
            });
        if !in_app_iframe {
            let pq = req
                .uri()
                .path_and_query()
                .map(|v| v.as_str())
                .unwrap_or("/");
            return safe_redirect_response(
                StatusCode::PERMANENT_REDIRECT,
                &format!("https://{primary}{pq}"),
                None,
            );
        }
    }

    if !is_public && req.uri().path() == "/robots.txt" && req.method() == Method::GET {
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/plain; charset=utf-8")
            .header("cache-control", "no-store, no-transform")
            .body(full_body("User-agent: *\nDisallow: /\n"))
            .unwrap();
    }

    if !is_public
        && scope != HostScope::NextHost
        && req.uri().path() == "/.qorpera/unlock"
        && req.method() == Method::POST
    {
        let host_s = host.to_string();
        let ip_s = client_ip.to_string();
        drop(route_table);
        return handle_unlock(state, &site, &host_s, &ip_s, req).await;
    }

    let mut preview_version_id: Option<String> = None;
    if !is_public {
        let authorized = match scope {
            HostScope::NextHost => parse_cookie(req.headers(), SITE_SESSION_COOKIE).map_or(false, |cookie| {
                if let Some(ver_id) = verify_preview_cookie(
                    &cookie,
                    &state.cookie_secret,
                    &site.id,
                    site.password_version,
                    now_unix,
                ) {
                    preview_version_id = Some(ver_id);
                    true
                } else {
                    verify_session_cookie(
                        &cookie,
                        &state.cookie_secret,
                        &site.id,
                        "next",
                        site.password_version,
                        now_unix,
                    )
                }
            }),
            HostScope::OwnHost | HostScope::CustomDomain => {
                parse_cookie(req.headers(), SITE_SESSION_COOKIE).map_or(false, |cookie| {
                    verify_session_cookie(
                        &cookie,
                        &state.cookie_secret,
                        &site.id,
                        "site",
                        site.password_version,
                        now_unix,
                    )
                })
            }
        };
        if !authorized {
            return html_response(
                StatusCode::UNAUTHORIZED,
                render_password_page(req.uri().path(), false),
                true,
            );
        }
    }

    let deployment = match scope {
        HostScope::NextHost => preview_version_id
            .as_deref()
            .and_then(|ver_id| site.preview_deployments.get(ver_id))
            .or_else(|| site.preview_deployments.values().next())
            .or(site.live_deployment.as_ref()),
        HostScope::OwnHost | HostScope::CustomDomain => site.live_deployment.as_ref(),
    };

    let Some(deployment) = deployment else {
        return html_response(StatusCode::NOT_FOUND, render_not_found_page(), true);
    };

    if matches!(deployment.kind, DeploymentKind::Static | DeploymentKind::Hybrid) {
        let resolution = resolve_static_path(&deployment.manifest, req.uri().path());
        match resolution {
            StaticResolution::ReservedPlatformPath => {
                return html_response(StatusCode::NOT_FOUND, render_not_found_page(), true);
            }
            StaticResolution::Redirect { status, location } => {
                let code = StatusCode::from_u16(status).unwrap_or(StatusCode::MOVED_PERMANENTLY);
                return safe_redirect_response(code, &location, None);
            }
            StaticResolution::File {
                path: resolved_path,
                file,
                status,
            } => {
                if deployment.kind == DeploymentKind::Static || status == 200 {
                    let ct_hdr = route_table.content_type_header(&file.content_type);
                    let etag_hdr = route_table.etag_header(&file.sha256);
                    drop(route_table);
                    return serve_static_file(
                        &state.blobs,
                        &deployment.manifest,
                        resolved_path.as_ref(),
                        file,
                        ct_hdr,
                        etag_hdr,
                        status,
                        is_public,
                        scope == HostScope::NextHost,
                        &site.slug,
                        &req,
                    )
                    .await;
                }
            }
            StaticResolution::NotFound => {
                if deployment.kind == DeploymentKind::Static {
                    return html_response(StatusCode::NOT_FOUND, render_not_found_page(), !is_public);
                }
            }
        }
    }

    let current_upstream = route_table.upstream_for(deployment);
    drop(route_table);

    state.activity.record(&deployment.id);

    let wake_deployment = || WakeRequest {
        deployment_id: deployment.id.clone(),
        site_id: site.id.clone(),
        oci_image_ref: deployment.oci_image_ref.clone(),
        health_path: deployment.health_path.clone(),
        idle_timeout_sec: deployment.idle_timeout_sec,
        memory_mb: deployment.memory_mb,
        vcpu_limit: deployment.vcpu_limit,
        env: deployment.env_spec.clone(),
    };

    let (upstream, was_cached) = match current_upstream {
        Some(addr) => (addr, true),
        None => match wake_and_record(&state, wake_deployment()).await {
            Ok(addr) => (addr, false),
            Err(_) => {
                return html_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    render_app_unavailable_page(),
                    true,
                );
            }
        },
    };

    let host_s = host.to_string();
    let ip_s = client_ip.to_string();
    let retry_meta = if was_cached
        && matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS)
        && !is_websocket_upgrade(req.headers())
    {
        Some((
            req.method().clone(),
            req.uri()
                .path_and_query()
                .map(|pq| pq.as_str().to_string())
                .unwrap_or_else(|| "/".to_string()),
            req.headers().clone(),
        ))
    } else {
        None
    };

    match proxy_http_or_ws(&state.proxy_client, &upstream, req, &host_s, &ip_s, !is_public).await {
        Ok(res) => res,
        Err(ProxyError::ConnectFailed(_)) => {
            let existing_replacement = state.routes.update(|table| {
                if table.clear_upstream_if_matches(&deployment.id, &upstream) {
                    None
                } else {
                    table
                        .upstream_for(deployment)
                        .filter(|addr| addr != &upstream)
                }
            });
            if let Some((method, pq, headers)) = retry_meta {
                let next_upstream = match existing_replacement {
                    Some(addr) => Ok(addr),
                    None => wake_and_record(&state, wake_deployment()).await,
                };
                if let Ok(new_upstream) = next_upstream {
                    if let Ok(res) = proxy_empty_request(
                        &state.proxy_client,
                        &new_upstream,
                        method,
                        &pq,
                        &headers,
                        &host_s,
                        &ip_s,
                        !is_public,
                    )
                    .await
                    {
                        return res;
                    }
                }
            }
            html_response(
                StatusCode::BAD_GATEWAY,
                render_app_unavailable_page(),
                true,
            )
        }
        Err(ProxyError::UpstreamFailed(_)) => html_response(
            StatusCode::BAD_GATEWAY,
            render_app_unavailable_page(),
            true,
        ),
    }
}

async fn wake_and_record(state: &Arc<RouterState>, req: WakeRequest) -> Result<String, String> {
    let dep_id = req.deployment_id.clone();
    let addr = state.waker.wake(req).await?;
    state.routes.update(|table| {
        table.set_upstream_override(dep_id.clone(), Some(addr.clone()));
    });
    if let Some(ref db_url) = state.database_url {
        let url = db_url.clone();
        let slot = Arc::clone(&state.db_slot);
        let persisted = Some(addr.clone());
        tokio::spawn(async move {
            persist_upstream_to_db(&url, &slot, &dep_id, &persisted).await;
        });
    }
    Ok(addr)
}

async fn handle_preview_enter(
    state: Arc<RouterState>,
    site: &crate::routes::SiteRecord,
    host: &str,
    req: Request<Incoming>,
) -> Response<BoxBody> {
    let Some(backend) = state.auth_backend.as_ref() else {
        return html_response(StatusCode::UNAUTHORIZED, render_password_page("/", false), true);
    };
    let ticket = req
        .uri()
        .query()
        .and_then(|q| query_param(q, "t"))
        .unwrap_or_default();
    if ticket.is_empty() {
        return html_response(StatusCode::UNAUTHORIZED, render_password_page("/", false), true);
    }
    let Some(redeemed) = backend.redeem_preview_ticket(host.to_string(), ticket).await else {
        return html_response(StatusCode::UNAUTHORIZED, render_password_page("/", false), true);
    };
    if redeemed.site_id != site.id {
        return html_response(StatusCode::UNAUTHORIZED, render_password_page("/", false), true);
    }
    let now_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let token = sign_preview_cookie(
        &state.cookie_secret,
        &redeemed.site_id,
        &redeemed.version_id,
        redeemed.password_version,
        now_unix + redeemed.max_age,
    );
    let set_cookie = format!(
        "{SITE_SESSION_COOKIE}={token}; Path=/; Max-Age={}; HttpOnly; Secure; SameSite=Lax",
        redeemed.max_age
    );
    safe_redirect_response(StatusCode::SEE_OTHER, "/", Some(&set_cookie))
}

async fn handle_member_pass(
    state: Arc<RouterState>,
    site: &crate::routes::SiteRecord,
    host: &str,
    req: Request<Incoming>,
) -> Response<BoxBody> {
    let Some(backend) = state.auth_backend.as_ref() else {
        return html_response(StatusCode::UNAUTHORIZED, render_password_page("/", true), true);
    };
    let body_bytes = match read_limited_body(req.into_body(), MAX_FORM_BODY_BYTES).await {
        Ok(b) => b,
        Err(BodyReadError::TooLarge) => {
            return text_response(StatusCode::PAYLOAD_TOO_LARGE, "form body too large");
        }
        Err(BodyReadError::Failed) => {
            return html_response(StatusCode::BAD_REQUEST, render_password_page("/", true), true);
        }
    };
    let form = String::from_utf8_lossy(&body_bytes);
    let pass = query_param(&form, "pass").unwrap_or_default();
    let next_path = sanitize_next_path(&query_param(&form, "path").unwrap_or_else(|| "/".to_string()));
    if pass.is_empty() {
        return html_response(StatusCode::UNAUTHORIZED, render_password_page(&next_path, true), true);
    }
    let Some(redeemed) = backend.redeem_member_pass(host.to_string(), pass).await else {
        return html_response(StatusCode::UNAUTHORIZED, render_password_page(&next_path, true), true);
    };
    if redeemed.site_id != site.id {
        return html_response(StatusCode::UNAUTHORIZED, render_password_page(&next_path, true), true);
    }
    let now_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let token = sign_session_cookie(
        &state.cookie_secret,
        &redeemed.site_id,
        "site",
        redeemed.password_version,
        now_unix + redeemed.max_age,
    );
    let set_cookie = format!(
        "{SITE_SESSION_COOKIE}={token}; Path=/; Max-Age={}; HttpOnly; Secure; SameSite=None; Partitioned",
        redeemed.max_age
    );
    safe_redirect_response(StatusCode::SEE_OTHER, &next_path, Some(&set_cookie))
}

async fn handle_unlock(
    state: Arc<RouterState>,
    site: &crate::routes::SiteRecord,
    _host: &str,
    client_ip: &str,
    req: Request<Incoming>,
) -> Response<BoxBody> {
    let limit_key = format!("unlock|{}|{client_ip}", site.id);
    let decision = state.unlock_limiter.check(&limit_key);
    if !decision.allowed {
        return Response::builder()
            .status(StatusCode::TOO_MANY_REQUESTS)
            .header("retry-after", decision.retry_after_secs.to_string())
            .header("cache-control", "no-store, no-transform")
            .body(full_body("Too many attempts"))
            .unwrap();
    }

    let body_bytes = match read_limited_body(req.into_body(), MAX_FORM_BODY_BYTES).await {
        Ok(b) => b,
        Err(BodyReadError::TooLarge) => {
            return text_response(StatusCode::PAYLOAD_TOO_LARGE, "form body too large");
        }
        Err(BodyReadError::Failed) => {
            return html_response(StatusCode::BAD_REQUEST, render_password_page("/", true), true);
        }
    };
    let form = String::from_utf8_lossy(&body_bytes);
    let password = query_param(&form, "password").unwrap_or_default();
    let next_path = sanitize_next_path(&query_param(&form, "next").unwrap_or_else(|| "/".to_string()));

    let mut hasher = Sha256::new();
    hasher.update(password.as_bytes());
    let candidate = hex::encode(hasher.finalize());

    let matches = site
        .password_sha256
        .as_deref()
        .map_or(false, |expected| constant_time_eq(candidate.as_bytes(), expected.as_bytes()));

    if !matches {
        return html_response(
            StatusCode::UNAUTHORIZED,
            render_password_page(&next_path, true),
            true,
        );
    }

    let now_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let max_age = 7 * 24 * 3600;
    let token = sign_session_cookie(
        &state.cookie_secret,
        &site.id,
        "site",
        site.password_version,
        now_unix + max_age,
    );
    let set_cookie = format!(
        "{SITE_SESSION_COOKIE}={token}; Path=/; Max-Age={max_age}; HttpOnly; Secure; SameSite=Lax"
    );
    safe_redirect_response(StatusCode::SEE_OTHER, &next_path, Some(&set_cookie))
}

#[allow(clippy::too_many_arguments)]
async fn serve_static_file(
    blobs: &BlobStore,
    manifest: &crate::routes::SiteManifest,
    resolved_path: &str,
    file: &crate::routes::ManifestFile,
    content_type_hdr: HeaderValue,
    etag_hdr: Option<HeaderValue>,
    status: u16,
    is_public: bool,
    is_preview: bool,
    slug: &str,
    req: &Request<Incoming>,
) -> Response<BoxBody> {
    if !matches!(*req.method(), Method::GET | Method::HEAD) {
        return Response::builder()
            .status(StatusCode::METHOD_NOT_ALLOWED)
            .header("allow", "GET, HEAD")
            .header("cache-control", "no-store, no-transform")
            .body(full_body(Bytes::new()))
            .unwrap();
    }

    if status == 200 && !is_preview {
        if let Some(inm) = req.headers().get("if-none-match").and_then(|v| v.to_str().ok()) {
            let etag_str = etag_hdr.as_ref().and_then(|v| v.to_str().ok()).unwrap_or("");
            if !etag_str.is_empty() && etag_matches(inm, etag_str) {
                return build_static_response(
                    StatusCode::NOT_MODIFIED,
                    None,
                    None,
                    manifest,
                    resolved_path,
                    file,
                    content_type_hdr,
                    etag_hdr,
                    is_public,
                    None,
                    full_body(Bytes::new()),
                );
            }
        }
    }

    let is_html = file.content_type.starts_with("text/html");
    if let Some(range_hdr) = req.headers().get("range").and_then(|v| v.to_str().ok()) {
        if status == 200 && !is_preview {
            if let Some(range) = parse_single_range(range_hdr, file.bytes) {
                match range {
                    RangeSpec::Valid(start, end) => {
                        let Ok((slice, total)) = blobs.get_range(&file.sha256, start, end).await else {
                            return text_response(StatusCode::SERVICE_UNAVAILABLE, "blob unavailable");
                        };
                        if slice.is_empty() {
                            return Response::builder()
                                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                                .header("content-range", format!("bytes */{total}"))
                                .header("cache-control", "no-store, no-transform")
                                .body(full_body(Bytes::new()))
                                .unwrap();
                        }
                        let content_len = slice.len();
                        let actual_end = start + content_len - 1;
                        let body = if *req.method() == Method::HEAD {
                            full_body(Bytes::new())
                        } else {
                            full_body(slice)
                        };
                        return build_static_response(
                            StatusCode::PARTIAL_CONTENT,
                            Some(content_len),
                            Some(format!("bytes {start}-{actual_end}/{total}")),
                            manifest,
                            resolved_path,
                            file,
                            content_type_hdr,
                            etag_hdr,
                            is_public,
                            None,
                            body,
                        );
                    }
                    RangeSpec::Unsatisfiable => {
                        return Response::builder()
                            .status(StatusCode::RANGE_NOT_SATISFIABLE)
                            .header("content-range", format!("bytes */{}", file.bytes))
                            .header("cache-control", "no-store, no-transform")
                            .body(full_body(Bytes::new()))
                            .unwrap();
                    }
                }
            }
        }
    }

    let accepted = if is_preview {
        AcceptedEncodings::IDENTITY
    } else {
        req.headers()
            .get("accept-encoding")
            .and_then(|v| v.to_str().ok())
            .map_or(AcceptedEncodings::IDENTITY, AcceptedEncodings::from_header)
    };

    let payload = match blobs.get_encoded(&file.sha256, accepted).await {
        Ok(p) => p,
        Err(_) => return text_response(StatusCode::SERVICE_UNAVAILABLE, "blob unavailable"),
    };

    let (final_bytes, encoding) = if is_preview && is_html {
        (Bytes::from(inject_preview_banner(&payload.bytes, slug)), None)
    } else {
        (payload.bytes, payload.encoding.header_value())
    };

    let len = final_bytes.len();
    let body = if *req.method() == Method::HEAD {
        full_body(Bytes::new())
    } else {
        full_body(final_bytes)
    };
    let status_code = StatusCode::from_u16(status).unwrap_or(StatusCode::OK);
    build_static_response(
        status_code,
        Some(len),
        None,
        manifest,
        resolved_path,
        file,
        content_type_hdr,
        etag_hdr,
        is_public,
        encoding,
        body,
    )
}

#[allow(clippy::too_many_arguments)]
fn build_static_response(
    status: StatusCode,
    content_length: Option<usize>,
    content_range: Option<String>,
    manifest: &crate::routes::SiteManifest,
    resolved_path: &str,
    file: &crate::routes::ManifestFile,
    content_type_hdr: HeaderValue,
    etag_hdr: Option<HeaderValue>,
    is_public: bool,
    encoding: Option<&'static str>,
    body: BoxBody,
) -> Response<BoxBody> {
    let cache_control = if !is_public {
        "private, no-cache, no-transform"
    } else if file.immutable {
        "public, max-age=31536000, immutable"
    } else {
        "public, max-age=0, must-revalidate"
    };
    let mut res = Response::new(body);
    *res.status_mut() = status;
    let headers = res.headers_mut();
    headers.reserve(12);

    headers.insert(HeaderName::from_static("content-type"), content_type_hdr);
    if let Some(etag_val) = etag_hdr {
        headers.insert(HeaderName::from_static("etag"), etag_val);
    }
    headers.insert(
        HeaderName::from_static("accept-ranges"),
        HeaderValue::from_static("bytes"),
    );
    headers.insert(
        HeaderName::from_static("cache-control"),
        HeaderValue::from_static(cache_control),
    );
    headers.insert(
        HeaderName::from_static("strict-transport-security"),
        HeaderValue::from_static(HSTS_HEADER),
    );
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        HeaderName::from_static("vary"),
        HeaderValue::from_static("Accept-Encoding"),
    );
    if let Some(len) = content_length {
        if let Some(v) = usize_header_value(len) {
            headers.insert(HeaderName::from_static("content-length"), v);
        }
    }
    if let Some(range) = content_range {
        if let Ok(v) = HeaderValue::from_str(&range) {
            headers.insert(HeaderName::from_static("content-range"), v);
        }
    }
    if let Some(enc) = encoding {
        headers.insert(
            HeaderName::from_static("content-encoding"),
            HeaderValue::from_static(enc),
        );
    }
    if !is_public {
        headers.insert(
            HeaderName::from_static("x-robots-tag"),
            HeaderValue::from_static("noindex, nofollow, noarchive"),
        );
        headers.insert(
            HeaderName::from_static("cross-origin-resource-policy"),
            HeaderValue::from_static("same-origin"),
        );
    }
    if !manifest.headers.is_empty() {
        for (k, v) in matching_custom_headers(manifest, resolved_path, is_public) {
            if let (Ok(name), Ok(val)) = (
                HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(&v),
            ) {
                headers.insert(name, val);
            }
        }
    }
    res
}

fn etag_matches(if_none_match: &str, etag: &str) -> bool {
    let trimmed = if_none_match.trim();
    if trimmed == "*" {
        return true;
    }
    for candidate in trimmed.split(',') {
        let token = candidate.trim();
        let normalized = token.strip_prefix("W/").unwrap_or(token);
        if normalized == etag {
            return true;
        }
    }
    false
}

enum RangeSpec {
    Valid(usize, usize),
    Unsatisfiable,
}

fn parse_single_range(header: &str, total: usize) -> Option<RangeSpec> {
    let spec = header.trim().strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (start_s, end_s) = spec.split_once('-')?;
    if total == 0 {
        return Some(RangeSpec::Unsatisfiable);
    }
    if start_s.is_empty() {
        let suffix: usize = end_s.parse().ok()?;
        if suffix == 0 {
            return Some(RangeSpec::Unsatisfiable);
        }
        let start = total.saturating_sub(suffix);
        return Some(RangeSpec::Valid(start, total - 1));
    }
    let start: usize = start_s.parse().ok()?;
    if start >= total {
        return Some(RangeSpec::Unsatisfiable);
    }
    let end = if end_s.is_empty() {
        total - 1
    } else {
        end_s.parse::<usize>().ok()?.min(total - 1)
    };
    if start > end {
        return Some(RangeSpec::Unsatisfiable);
    }
    Some(RangeSpec::Valid(start, end))
}

fn query_param(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        if k == key {
            return Some(url_decode(v));
        }
    }
    None
}

fn usize_header_value(mut n: usize) -> Option<HeaderValue> {
    let mut buf = [0u8; 20];
    let mut idx = buf.len();
    if n == 0 {
        return Some(HeaderValue::from_static("0"));
    }
    while n > 0 {
        idx -= 1;
        buf[idx] = b'0' + (n % 10) as u8;
        n /= 10;
    }
    HeaderValue::from_bytes(&buf[idx..]).ok()
}

fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn url_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
        } else if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_nibble(bytes[i + 1]), hex_nibble(bytes[i + 2])) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
            out.push(bytes[i]);
            i += 1;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}
