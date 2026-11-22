use crate::lifecycle::{AppLifecycleManager, DeployRequest};
use bytes::Bytes;
use http::{Method, Request, Response, StatusCode};
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::Serialize;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use subtle::ConstantTimeEq;
use tokio::net::TcpListener;
use tokio::sync::Semaphore;

pub type BoxBody = http_body_util::combinators::BoxBody<Bytes, hyper::Error>;

const MAX_CONTROL_BODY_BYTES: usize = 1024 * 1024;
const MAX_CONNS: usize = 256;
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(10);
const BODY_READ_TIMEOUT: Duration = Duration::from_secs(15);

fn full_body(bytes: impl Into<Bytes>) -> BoxBody {
    Full::new(bytes.into())
        .map_err(|never| match never {})
        .boxed()
}

pub struct AppHostServer {
    pub addr: SocketAddr,
    listener: TcpListener,
    manager: Arc<AppLifecycleManager>,
    control_token: String,
    body_read_timeout: Duration,
}

impl AppHostServer {
    pub async fn bind(
        bind_addr: SocketAddr,
        manager: Arc<AppLifecycleManager>,
        control_token: String,
    ) -> Result<Self, std::io::Error> {
        let listener = TcpListener::bind(bind_addr).await?;
        let addr = listener.local_addr()?;
        Ok(Self {
            addr,
            listener,
            manager,
            control_token,
            body_read_timeout: BODY_READ_TIMEOUT,
        })
    }

    pub fn with_body_read_timeout(mut self, timeout: Duration) -> Self {
        self.body_read_timeout = timeout;
        self
    }

    pub fn spawn(self) -> tokio::task::JoinHandle<()> {
        self.spawn_inner(None)
    }

    pub fn spawn_with_shutdown(
        self,
        shutdown: tokio::sync::watch::Receiver<bool>,
    ) -> tokio::task::JoinHandle<()> {
        self.spawn_inner(Some(shutdown))
    }

    fn spawn_inner(
        self,
        mut shutdown: Option<tokio::sync::watch::Receiver<bool>>,
    ) -> tokio::task::JoinHandle<()> {
        let sem = Arc::new(Semaphore::new(MAX_CONNS));
        tokio::spawn(async move {
            loop {
                let stream = if let Some(rx) = shutdown.as_mut() {
                    if *rx.borrow() {
                        break;
                    }
                    tokio::select! {
                        biased;
                        changed = rx.changed() => {
                            if changed.is_err() || *rx.borrow() {
                                break;
                            }
                            continue;
                        }
                        accepted = self.listener.accept() => {
                            match accepted {
                                Ok((stream, _peer)) => stream,
                                Err(_) => continue,
                            }
                        }
                    }
                } else {
                    match self.listener.accept().await {
                        Ok((stream, _peer)) => stream,
                        Err(_) => continue,
                    }
                };
                let Ok(permit) = Arc::clone(&sem).try_acquire_owned() else {
                    drop(stream);
                    continue;
                };
                let _ = stream.set_nodelay(true);
                let mgr = Arc::clone(&self.manager);
                let token = self.control_token.clone();
                let body_timeout = self.body_read_timeout;
                tokio::spawn(async move {
                    let _permit = permit;
                    let io = TokioIo::new(stream);
                    let svc = service_fn(move |req| {
                        let m = Arc::clone(&mgr);
                        let t = token.clone();
                        async move {
                            Ok::<_, hyper::Error>(handle_request(m, &t, body_timeout, req).await)
                        }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .timer(TokioTimer::new())
                        .header_read_timeout(HEADER_READ_TIMEOUT)
                        .serve_connection(io, svc)
                        .await;
                });
            }
        })
    }
}

fn json_res(status: StatusCode, body: impl Serialize) -> Response<BoxBody> {
    let data = serde_json::to_vec(&body).unwrap_or_else(|_| b"{}".to_vec());
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .header("cache-control", "no-store")
        .body(full_body(data))
        .unwrap()
}

fn check_auth(req: &Request<Incoming>, expected: &str) -> bool {
    let Some(val) = req.headers().get("authorization").and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let Some(token) = val.strip_prefix("Bearer ") else {
        return false;
    };
    token.len() == expected.len() && bool::from(token.as_bytes().ct_eq(expected.as_bytes()))
}

enum BodyErr {
    TooLarge,
    Timeout,
    Bad,
}

async fn read_body(body: Incoming, timeout: Duration) -> Result<Bytes, BodyErr> {
    match tokio::time::timeout(
        timeout,
        Limited::new(body, MAX_CONTROL_BODY_BYTES).collect(),
    )
    .await
    {
        Ok(Ok(c)) => Ok(c.to_bytes()),
        Ok(Err(err)) => {
            if err.downcast_ref::<http_body_util::LengthLimitError>().is_some() {
                Err(BodyErr::TooLarge)
            } else {
                Err(BodyErr::Bad)
            }
        }
        Err(_) => Err(BodyErr::Timeout),
    }
}

async fn handle_request(
    manager: Arc<AppLifecycleManager>,
    expected_token: &str,
    body_read_timeout: Duration,
    req: Request<Incoming>,
) -> Response<BoxBody> {
    let method = req.method().clone();
    let path = req.uri().path().to_string();

    if method == Method::GET && path == "/_internal/health" {
        return json_res(StatusCode::OK, serde_json::json!({ "ok": true }));
    }

    if !check_auth(&req, expected_token) {
        return json_res(StatusCode::UNAUTHORIZED, serde_json::json!({ "error": "unauthorized" }));
    }

    if method == Method::POST && path == "/_internal/apps/deploy" {
        let bytes = match read_body(req.into_body(), body_read_timeout).await {
            Ok(b) => b,
            Err(BodyErr::TooLarge) => {
                return json_res(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    serde_json::json!({ "error": "body_too_large" }),
                );
            }
            Err(BodyErr::Timeout) => {
                return json_res(
                    StatusCode::REQUEST_TIMEOUT,
                    serde_json::json!({ "error": "body_timeout" }),
                );
            }
            Err(BodyErr::Bad) => {
                return json_res(StatusCode::BAD_REQUEST, serde_json::json!({ "error": "bad_body" }));
            }
        };
        let deploy_req: DeployRequest = match serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(e) => {
                return json_res(
                    StatusCode::BAD_REQUEST,
                    serde_json::json!({ "error": format!("invalid_json: {e}") }),
                )
            }
        };
        return match manager.deploy_blue_green(deploy_req).await {
            Ok(status) => json_res(StatusCode::OK, status),
            Err(err) => json_res(StatusCode::UNPROCESSABLE_ENTITY, serde_json::json!({ "error": err })),
        };
    }

    if let Some(rest) = path.strip_prefix("/_internal/apps/") {
        if let Some(dep_id) = rest.strip_suffix("/wake") {
            if method == Method::POST {
                let fallback = match read_body(req.into_body(), body_read_timeout).await {
                    Ok(bytes) if !bytes.is_empty() => serde_json::from_slice::<DeployRequest>(&bytes).ok(),
                    Ok(_) => None,
                    Err(BodyErr::TooLarge) => {
                        return json_res(
                            StatusCode::PAYLOAD_TOO_LARGE,
                            serde_json::json!({ "error": "body_too_large" }),
                        );
                    }
                    Err(BodyErr::Timeout) => {
                        return json_res(
                            StatusCode::REQUEST_TIMEOUT,
                            serde_json::json!({ "error": "body_timeout" }),
                        );
                    }
                    Err(BodyErr::Bad) => None,
                };
                return match manager.wake_detailed(dep_id, fallback).await {
                    Ok(outcome) => json_res(
                        StatusCode::OK,
                        serde_json::json!({
                            "upstream_addr": outcome.upstream_addr,
                            "wake_mode": outcome.mode,
                        }),
                    ),
                    Err(err) => json_res(StatusCode::SERVICE_UNAVAILABLE, serde_json::json!({ "error": err })),
                };
            }
        }
        if let Some(dep_id) = rest.strip_suffix("/freeze") {
            if method == Method::POST {
                return match manager.freeze_deployment(dep_id).await {
                    Ok(status) => json_res(StatusCode::OK, status),
                    Err(err) if err == "deployment_not_found" => {
                        json_res(StatusCode::NOT_FOUND, serde_json::json!({ "error": err }))
                    }
                    Err(err) => json_res(StatusCode::CONFLICT, serde_json::json!({ "error": err })),
                };
            }
        }
        if let Some(dep_id) = rest.strip_suffix("/stop") {
            if method == Method::POST {
                return match manager.stop_deployment(dep_id).await {
                    Ok(()) => json_res(StatusCode::OK, serde_json::json!({ "stopped": true })),
                    Err(err) => json_res(StatusCode::INTERNAL_SERVER_ERROR, serde_json::json!({ "error": err })),
                };
            }
        }
        if let Some(dep_id) = rest.strip_suffix("/status") {
            if method == Method::GET {
                return match manager.status(dep_id) {
                    Some(st) => json_res(StatusCode::OK, st),
                    None => json_res(StatusCode::NOT_FOUND, serde_json::json!({ "error": "not_found" })),
                };
            }
        }
        if let Some(dep_id) = rest.strip_suffix("/logs") {
            if method == Method::GET {
                let tail = req
                    .uri()
                    .query()
                    .and_then(|q| {
                        q.split('&').find_map(|pair| {
                            let (k, v) = pair.split_once('=')?;
                            if k == "tail" {
                                v.parse::<usize>().ok()
                            } else {
                                None
                            }
                        })
                    })
                    .unwrap_or(200)
                    .min(2000);
                let entries = manager.logs().tail(dep_id, tail);
                return json_res(StatusCode::OK, serde_json::json!({ "entries": entries }));
            }
        }
    }

    json_res(StatusCode::NOT_FOUND, serde_json::json!({ "error": "not_found" }))
}
