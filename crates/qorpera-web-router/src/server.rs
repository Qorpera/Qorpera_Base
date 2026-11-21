use crate::blob_store::{BlobError, BlobStore, PutOutcome};
use crate::proxy::{
    full_body, proxy_http_or_ws, ActivityTracker, BoxBody, WakeCoordinator, WakeRequest,
};
use crate::ratelimit::RateLimiter;
use crate::routes::{
    matching_custom_headers, normalize_host, resolve_static_path, DeploymentKind, EdgeSnapshot,
    HostScope, ResolvedHost, RouteTable, StaticResolution,
};
use crate::security::{
    check_cross_site_write, constant_time_eq, extract_client_ip, inject_preview_banner,
    parse_cookie, render_app_unavailable_page, render_not_found_page, render_password_page,
    render_takedown_page, sanitize_next_path, sign_session_cookie, verify_session_cookie,
    HSTS_HEADER, SITE_SESSION_COOKIE,
};
use bytes::Bytes;
use http::{HeaderName, HeaderValue, Method, Request, Response, StatusCode};
use http_body_util::BodyExt;
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::net::TcpListener;

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
}

pub struct RouterState {
    pub blobs: Arc<BlobStore>,
    pub routes: Arc<RwLock<RouteTable>>,
    pub limiter: Arc<RateLimiter>,
    pub unlock_limiter: Arc<RateLimiter>,
    pub activity: Arc<ActivityTracker>,
    pub waker: Arc<WakeCoordinator>,
    pub control_token: String,
    pub cookie_secret: Vec<u8>,
    pub trusted_proxies: Vec<IpAddr>,
}

impl RouterState {
    pub fn new(blobs: Arc<BlobStore>, initial: EdgeSnapshot, cfg: &RouterConfig) -> Self {
        Self {
            blobs,
            routes: Arc::new(RwLock::new(RouteTable::from_snapshot(initial))),
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
            control_token: cfg.control_token.clone(),
            cookie_secret: cfg.cookie_secret.clone(),
            trusted_proxies: cfg.trusted_proxies.clone(),
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
        let pub_handle = tokio::spawn(async move {
            loop {
                let Ok((stream, peer)) = pub_listener.accept().await else {
                    continue;
                };
                let state = Arc::clone(&pub_state);
                tokio::spawn(async move {
                    let io = TokioIo::new(stream);
                    let svc = service_fn(move |req| {
                        let st = Arc::clone(&state);
                        async move { Ok::<_, hyper::Error>(handle_public(st, peer.ip(), req).await) }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(io, svc)
                        .with_upgrades()
                        .await;
                });
            }
        });

        let int_state = Arc::clone(&self.state);
        let int_listener = self.internal_listener;
        let int_handle = tokio::spawn(async move {
            loop {
                let Ok((stream, _peer)) = int_listener.accept().await else {
                    continue;
                };
                let state = Arc::clone(&int_state);
                tokio::spawn(async move {
                    let io = TokioIo::new(stream);
                    let svc = service_fn(move |req| {
                        let st = Arc::clone(&state);
                        async move { Ok::<_, hyper::Error>(handle_internal(st, req).await) }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(io, svc)
                        .await;
                });
            }
        });

        (pub_handle, int_handle)
    }
}

#[derive(Serialize)]
struct HealthBody {
    ok: bool,
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

fn check_bearer(req: &Request<Incoming>, expected_token: &str) -> bool {
    let Some(header) = req.headers().get("authorization").and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let Some(token) = header.strip_prefix("Bearer ") else {
        return false;
    };
    constant_time_eq(token.as_bytes(), expected_token.as_bytes())
}

async fn handle_internal(state: Arc<RouterState>, req: Request<Incoming>) -> Response<BoxBody> {
    let path = req.uri().path().to_string();
    let method = req.method().clone();

    if method == Method::GET && path == "/_internal/health" {
        return json_response(StatusCode::OK, HealthBody { ok: true });
    }

    if method == Method::GET && path == "/_internal/tls/allow" {
        let domain = req
            .uri()
            .query()
            .and_then(|q| query_param(q, "domain"))
            .unwrap_or_default();
        let allowed = state
            .routes
            .read()
            .map(|guard| guard.is_tls_allowed(&domain))
            .unwrap_or(false);
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

    if method == Method::POST && path == "/_internal/routes/snapshot" {
        let Ok(collected) = req.into_body().collect().await else {
            return text_response(StatusCode::BAD_REQUEST, "invalid body");
        };
        let bytes = collected.to_bytes();
        let snapshot: EdgeSnapshot = match serde_json::from_slice(&bytes) {
            Ok(s) => s,
            Err(_) => return text_response(StatusCode::BAD_REQUEST, "invalid snapshot json"),
        };
        let table = RouteTable::from_snapshot(snapshot);
        if let Ok(mut guard) = state.routes.write() {
            *guard = table;
            return json_response(StatusCode::OK, HealthBody { ok: true });
        }
        return text_response(StatusCode::INTERNAL_SERVER_ERROR, "route lock poisoned");
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
            let Ok(collected) = req.into_body().collect().await else {
                return text_response(StatusCode::BAD_REQUEST, "body read failed");
            };
            let body = collected.to_bytes();
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
        .unwrap_or("");
    let Some(host) = normalize_host(raw_host) else {
        return html_response(StatusCode::BAD_REQUEST, render_not_found_page(), true);
    };
    let client_ip = extract_client_ip(req.headers(), peer_ip, &state.trusted_proxies);

    let rate_key = format!("{host}|{client_ip}");
    let decision = state.limiter.check(&rate_key);
    if !decision.allowed {
        return Response::builder()
            .status(StatusCode::TOO_MANY_REQUESTS)
            .header("retry-after", decision.retry_after_secs.to_string())
            .header("cache-control", "no-store, no-transform")
            .header("content-type", "text/plain; charset=utf-8")
            .body(full_body("Too many requests"))
            .unwrap();
    }

    if !check_cross_site_write(req.method(), req.headers(), &host) {
        return text_response(StatusCode::FORBIDDEN, "cross-site write refused");
    }

    let resolved = {
        let Ok(guard) = state.routes.read() else {
            return text_response(StatusCode::SERVICE_UNAVAILABLE, "router unavailable");
        };
        (guard.resolve_host(&host), guard.public_enabled)
    };

    let (resolved_host, global_public_enabled) = resolved;
    let Some(resolved_host) = resolved_host else {
        return html_response(StatusCode::NOT_FOUND, render_not_found_page(), true);
    };

    let (site, scope, canonical_redirect) = match resolved_host {
        ResolvedHost::UnknownOwnHost { scope } => {
            if req.uri().path() == "/robots.txt" {
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
                render_password_page(req.uri().path(), false)
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

    if let Some(primary) = canonical_redirect {
        let pq = req
            .uri()
            .path_and_query()
            .map(|v| v.as_str())
            .unwrap_or("/");
        return Response::builder()
            .status(StatusCode::PERMANENT_REDIRECT)
            .header("location", format!("https://{primary}{pq}"))
            .header("cache-control", "no-store, no-transform")
            .header("strict-transport-security", HSTS_HEADER)
            .body(full_body(Bytes::new()))
            .unwrap();
    }

    let is_public = global_public_enabled && site.is_public && scope != HostScope::NextHost;
    let path = req.uri().path().to_string();

    if !is_public && path == "/robots.txt" && req.method() == Method::GET {
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/plain; charset=utf-8")
            .header("cache-control", "no-store, no-transform")
            .body(full_body("User-agent: *\nDisallow: /\n"))
            .unwrap();
    }

    if !is_public && path == "/.qorpera/unlock" && req.method() == Method::POST {
        return handle_unlock(state, &site, &host, &client_ip, req).await;
    }

    if !is_public {
        let scope_key = match scope {
            HostScope::NextHost => "next",
            HostScope::OwnHost | HostScope::CustomDomain => "site",
        };
        let now_unix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        let authorized = parse_cookie(req.headers(), SITE_SESSION_COOKIE).map_or(false, |cookie| {
            verify_session_cookie(
                &cookie,
                &state.cookie_secret,
                &site.id,
                scope_key,
                site.password_version,
                now_unix,
            )
        });
        if !authorized {
            return html_response(
                StatusCode::UNAUTHORIZED,
                render_password_page(&path, false),
                true,
            );
        }
    }

    let deployment = match scope {
        HostScope::NextHost => site
            .preview_deployments
            .values()
            .next()
            .or(site.live_deployment.as_ref()),
        HostScope::OwnHost | HostScope::CustomDomain => site.live_deployment.as_ref(),
    };

    let Some(deployment) = deployment else {
        return html_response(StatusCode::NOT_FOUND, render_not_found_page(), true);
    };

    if matches!(deployment.kind, DeploymentKind::Static | DeploymentKind::Hybrid) {
        let resolution = resolve_static_path(&deployment.manifest, &path);
        match resolution {
            StaticResolution::ReservedPlatformPath => {
                return html_response(StatusCode::NOT_FOUND, render_not_found_page(), true);
            }
            StaticResolution::Redirect { status, location } => {
                let code = StatusCode::from_u16(status).unwrap_or(StatusCode::MOVED_PERMANENTLY);
                return Response::builder()
                    .status(code)
                    .header("location", location)
                    .header("strict-transport-security", HSTS_HEADER)
                    .header("cache-control", "no-store, no-transform")
                    .body(full_body(Bytes::new()))
                    .unwrap();
            }
            StaticResolution::File {
                path: resolved_path,
                file,
                status,
            } => {
                if deployment.kind == DeploymentKind::Static || status == 200 {
                    return serve_static_file(
                        &state.blobs,
                        &deployment.manifest,
                        &resolved_path,
                        &file,
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

    state.activity.record(&deployment.id);

    let current_upstream = state
        .routes
        .read()
        .ok()
        .and_then(|g| g.upstream_for(deployment));

    let upstream = match current_upstream {
        Some(addr) => addr,
        None => {
            let wake_req = WakeRequest {
                deployment_id: deployment.id.clone(),
                site_id: site.id.clone(),
                oci_image_ref: deployment.oci_image_ref.clone(),
                health_path: deployment.health_path.clone(),
            };
            match state.waker.wake(wake_req).await {
                Ok(addr) => {
                    if let Ok(mut guard) = state.routes.write() {
                        guard.set_upstream_override(deployment.id.clone(), Some(addr.clone()));
                    }
                    addr
                }
                Err(_) => {
                    return html_response(
                        StatusCode::SERVICE_UNAVAILABLE,
                        render_app_unavailable_page(),
                        true,
                    );
                }
            }
        }
    };

    match proxy_http_or_ws(&upstream, req, &host, &client_ip, !is_public).await {
        Ok(res) => res,
        Err(_) => html_response(
            StatusCode::BAD_GATEWAY,
            render_app_unavailable_page(),
            true,
        ),
    }
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

    let Ok(collected) = req.into_body().collect().await else {
        return html_response(StatusCode::BAD_REQUEST, render_password_page("/", true), true);
    };
    let form = String::from_utf8_lossy(&collected.to_bytes()).into_owned();
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
    Response::builder()
        .status(StatusCode::SEE_OTHER)
        .header("location", next_path)
        .header("set-cookie", set_cookie)
        .header("cache-control", "no-store, no-transform")
        .header("strict-transport-security", HSTS_HEADER)
        .body(full_body(Bytes::new()))
        .unwrap()
}

#[allow(clippy::too_many_arguments)]
async fn serve_static_file(
    blobs: &BlobStore,
    manifest: &crate::routes::SiteManifest,
    resolved_path: &str,
    file: &crate::routes::ManifestFile,
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

    let etag = format!("\"{}\"", file.sha256);
    if status == 200 && !is_preview {
        if let Some(inm) = req.headers().get("if-none-match").and_then(|v| v.to_str().ok()) {
            if inm.trim() == etag || inm.trim() == format!("W/{etag}") {
                return apply_static_headers(
                    Response::builder().status(StatusCode::NOT_MODIFIED),
                    manifest,
                    resolved_path,
                    file,
                    &etag,
                    is_public,
                    None,
                )
                .body(full_body(Bytes::new()))
                .unwrap();
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
                        let content_len = slice.len();
                        let body = if *req.method() == Method::HEAD {
                            full_body(Bytes::new())
                        } else {
                            full_body(slice)
                        };
                        return apply_static_headers(
                            Response::builder()
                                .status(StatusCode::PARTIAL_CONTENT)
                                .header("content-range", format!("bytes {start}-{end}/{total}"))
                                .header("content-length", content_len.to_string()),
                            manifest,
                            resolved_path,
                            file,
                            &etag,
                            is_public,
                            None,
                        )
                        .body(body)
                        .unwrap();
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

    let accepts_gzip = !is_preview
        && req
            .headers()
            .get("accept-encoding")
            .and_then(|v| v.to_str().ok())
            .map_or(false, |v| v.split(',').any(|p| p.trim().starts_with("gzip")));

    let payload = match blobs.get(&file.sha256, accepts_gzip).await {
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
    apply_static_headers(
        Response::builder()
            .status(status_code)
            .header("content-length", len.to_string()),
        manifest,
        resolved_path,
        file,
        &etag,
        is_public,
        encoding,
    )
    .body(body)
    .unwrap()
}

fn apply_static_headers(
    mut builder: http::response::Builder,
    manifest: &crate::routes::SiteManifest,
    resolved_path: &str,
    file: &crate::routes::ManifestFile,
    etag: &str,
    is_public: bool,
    encoding: Option<&'static str>,
) -> http::response::Builder {
    let cache_control = if !is_public {
        "private, no-cache, no-transform"
    } else if file.immutable {
        "public, max-age=31536000, immutable"
    } else {
        "public, max-age=0, must-revalidate"
    };
    builder = builder
        .header("content-type", file.content_type.as_str())
        .header("etag", etag)
        .header("accept-ranges", "bytes")
        .header("cache-control", cache_control)
        .header("strict-transport-security", HSTS_HEADER)
        .header("x-content-type-options", "nosniff")
        .header("vary", "Accept-Encoding");
    if let Some(enc) = encoding {
        builder = builder.header("content-encoding", enc);
    }
    if !is_public {
        builder = builder
            .header("x-robots-tag", "noindex, nofollow, noarchive")
            .header("cross-origin-resource-policy", "same-origin");
    }
    for (k, v) in matching_custom_headers(manifest, resolved_path) {
        if let (Ok(name), Ok(val)) = (
            HeaderName::from_bytes(k.as_bytes()),
            HeaderValue::from_str(&v),
        ) {
            builder = builder.header(name, val);
        }
    }
    builder
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

fn url_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
        } else if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(val) = u8::from_str_radix(&input[i + 1..i + 3], 16) {
                out.push(val);
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
