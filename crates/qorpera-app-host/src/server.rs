use crate::lifecycle::{AppLifecycleManager, DeployRequest};
use bytes::Bytes;
use http::{Method, Request, Response, StatusCode};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use serde::Serialize;
use std::net::SocketAddr;
use std::sync::Arc;
use subtle::ConstantTimeEq;
use tokio::net::TcpListener;

pub type BoxBody = http_body_util::combinators::BoxBody<Bytes, hyper::Error>;

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
        })
    }

    pub fn spawn(self) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            loop {
                let Ok((stream, _peer)) = self.listener.accept().await else {
                    continue;
                };
                let mgr = Arc::clone(&self.manager);
                let token = self.control_token.clone();
                tokio::spawn(async move {
                    let io = TokioIo::new(stream);
                    let svc = service_fn(move |req| {
                        let m = Arc::clone(&mgr);
                        let t = token.clone();
                        async move { Ok::<_, hyper::Error>(handle_request(m, &t, req).await) }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
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

async fn handle_request(
    manager: Arc<AppLifecycleManager>,
    expected_token: &str,
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
        let Ok(collected) = req.into_body().collect().await else {
            return json_res(StatusCode::BAD_REQUEST, serde_json::json!({ "error": "bad_body" }));
        };
        let deploy_req: DeployRequest = match serde_json::from_slice(&collected.to_bytes()) {
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
                let fallback = match req.into_body().collect().await {
                    Ok(collected) => {
                        let bytes = collected.to_bytes();
                        if bytes.is_empty() {
                            None
                        } else {
                            serde_json::from_slice::<DeployRequest>(&bytes).ok()
                        }
                    }
                    Err(_) => None,
                };
                return match manager.wake(dep_id, fallback).await {
                    Ok(upstream_addr) => {
                        json_res(StatusCode::OK, serde_json::json!({ "upstream_addr": upstream_addr }))
                    }
                    Err(err) => json_res(StatusCode::SERVICE_UNAVAILABLE, serde_json::json!({ "error": err })),
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
