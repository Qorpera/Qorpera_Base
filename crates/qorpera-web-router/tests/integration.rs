use bytes::Bytes;
use http::{Request, StatusCode};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use qorpera_web_router::blob_store::{sha256_hex, BlobStore};
use qorpera_web_router::routes::{
    CustomDomainRecord, DeploymentKind, DeploymentRecord, DomainStatus, EdgeSnapshot, HeaderRule,
    ManifestFile, RedirectRule, SiteManifest, SiteRecord,
};
use qorpera_web_router::server::{BoundServers, RouterConfig, RouterState};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tempfile::tempdir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

async fn http_call(
    addr: SocketAddr,
    req: Request<Full<Bytes>>,
) -> (StatusCode, http::HeaderMap, Bytes) {
    let stream = TcpStream::connect(addr).await.unwrap();
    let io = TokioIo::new(stream);
    let (mut sender, conn) = hyper::client::conn::http1::handshake(io).await.unwrap();
    tokio::spawn(async move {
        let _ = conn.await;
    });
    let res = sender.send_request(req).await.unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let body = res.into_body().collect().await.unwrap().to_bytes();
    (status, headers, body)
}

fn test_config(app_host_url: Option<String>) -> RouterConfig {
    RouterConfig {
        public_bind: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        internal_bind: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        control_token: "secret-control-token".to_string(),
        cookie_secret: b"secret-cookie-key-32-bytes-minimum!".to_vec(),
        trusted_proxies: vec![],
        rate_limit_rps: 500.0,
        rate_limit_burst: 500.0,
        unlock_limit_rps: 10.0,
        unlock_limit_burst: 10.0,
        app_host_url,
        wake_timeout: Duration::from_secs(5),
    }
}

#[tokio::test]
async fn static_sites_custom_domains_tls_ask_privacy_and_takedown() {
    let dir = tempdir().unwrap();
    let blobs = Arc::new(BlobStore::new(dir.path().to_path_buf(), 8 * 1024 * 1024, 8 * 1024 * 1024));
    let cfg = test_config(None);
    let state = Arc::new(RouterState::new(blobs, EdgeSnapshot::default(), &cfg));
    let bound = BoundServers::bind(&cfg, state).await.unwrap();
    let pub_addr = bound.public_addr;
    let int_addr = bound.internal_addr;
    let (_pub_h, _int_h) = bound.spawn();

    let index_html = Bytes::from("<html><body><h1>Hej Danmark</h1></body></html>".repeat(20));
    let index_sha = sha256_hex(&index_html);
    let not_found_html = Bytes::from("<h1>Custom 404</h1>");
    let not_found_sha = sha256_hex(&not_found_html);
    let video_bytes = Bytes::from_static(b"0123456789abcdef");
    let video_sha = sha256_hex(&video_bytes);

    let (st, _, _) = http_call(
        int_addr,
        Request::builder()
            .method("PUT")
            .uri(format!("/_internal/blobs/{index_sha}"))
            .body(Full::new(index_html.clone()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);

    let (st, _, _) = http_call(
        int_addr,
        Request::builder()
            .method("PUT")
            .uri(format!("/_internal/blobs/{}", "0".repeat(64)))
            .header("authorization", "Bearer secret-control-token")
            .body(Full::new(index_html.clone()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);

    for (sha, body) in [
        (&index_sha, &index_html),
        (&not_found_sha, &not_found_html),
        (&video_sha, &video_bytes),
    ] {
        let (st, _, _) = http_call(
            int_addr,
            Request::builder()
                .method("PUT")
                .uri(format!("/_internal/blobs/{sha}"))
                .header("authorization", "Bearer secret-control-token")
                .body(Full::new(body.clone()))
                .unwrap(),
        )
        .await;
        assert_eq!(st, StatusCode::CREATED);
    }

    let (st, _, _) = http_call(
        int_addr,
        Request::builder()
            .method("HEAD")
            .uri(format!("/_internal/blobs/{index_sha}"))
            .header("authorization", "Bearer secret-control-token")
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    let mut files = HashMap::new();
    files.insert(
        "index.html".to_string(),
        ManifestFile {
            sha256: index_sha.clone(),
            bytes: index_html.len(),
            content_type: "text/html; charset=utf-8".to_string(),
            immutable: false,
        },
    );
    files.insert(
        "404.html".to_string(),
        ManifestFile {
            sha256: not_found_sha.clone(),
            bytes: not_found_html.len(),
            content_type: "text/html; charset=utf-8".to_string(),
            immutable: false,
        },
    );
    files.insert(
        "clip.mp4".to_string(),
        ManifestFile {
            sha256: video_sha.clone(),
            bytes: video_bytes.len(),
            content_type: "video/mp4".to_string(),
            immutable: true,
        },
    );

    let mut custom_hdrs = HashMap::new();
    custom_hdrs.insert("x-custom-test".to_string(), "ok".to_string());

    let mut snapshot = EdgeSnapshot {
        hosts_domain: "qorpera.site".to_string(),
        legacy_hosts_domains: vec!["qorpera.com".to_string()],
        hosts_enabled: true,
        public_enabled: true,
        domains_enabled: true,
        sites: vec![
            SiteRecord {
                id: "site-public".to_string(),
                slug: "min-butik".to_string(),
                is_public: true,
                taken_down: false,
                password_sha256: None,
                password_version: 1,
                live_deployment: Some(DeploymentRecord {
                    id: "dep-1".to_string(),
                    kind: DeploymentKind::Static,
                    manifest: SiteManifest {
                        files: files.clone(),
                        redirects: vec![RedirectRule {
                            from: "/legacy".to_string(),
                            to: "/".to_string(),
                            status: 301,
                        }],
                        headers: vec![HeaderRule {
                            path_prefix: "/".to_string(),
                            headers: custom_hdrs,
                        }],
                        spa_fallback: None,
                        not_found_page: Some("404.html".to_string()),
                    },
                    upstream_addr: None,
                    oci_image_ref: None,
                    health_path: "/".to_string(),
                    idle_timeout_sec: 900,
                }),
                preview_deployments: HashMap::new(),
                primary_custom_domain: Some("minbutik.dk".to_string()),
            },
            SiteRecord {
                id: "site-private".to_string(),
                slug: "hemmeligt-rum".to_string(),
                is_public: false,
                taken_down: false,
                password_sha256: Some(sha256_hex(b"super-secret-pass")),
                password_version: 1,
                live_deployment: Some(DeploymentRecord {
                    id: "dep-priv".to_string(),
                    kind: DeploymentKind::Static,
                    manifest: SiteManifest {
                        files,
                        ..Default::default()
                    },
                    upstream_addr: None,
                    oci_image_ref: None,
                    health_path: "/".to_string(),
                    idle_timeout_sec: 900,
                }),
                preview_deployments: HashMap::new(),
                primary_custom_domain: None,
            },
        ],
        custom_domains: vec![
            CustomDomainRecord {
                id: "dom-apex".to_string(),
                site_id: "site-public".to_string(),
                hostname: "minbutik.dk".to_string(),
                is_apex: true,
                is_primary: true,
                status: DomainStatus::TlsActive,
                verification_token: "v1".to_string(),
            },
            CustomDomainRecord {
                id: "dom-www".to_string(),
                site_id: "site-public".to_string(),
                hostname: "www.minbutik.dk".to_string(),
                is_apex: false,
                is_primary: false,
                status: DomainStatus::DnsVerified,
                verification_token: "v2".to_string(),
            },
            CustomDomainRecord {
                id: "dom-pending".to_string(),
                site_id: "site-public".to_string(),
                hostname: "pending.dk".to_string(),
                is_apex: true,
                is_primary: false,
                status: DomainStatus::PendingDns,
                verification_token: "v3".to_string(),
            },
        ],
        ..Default::default()
    };

    let (st, _, _) = http_call(
        int_addr,
        Request::builder()
            .method("POST")
            .uri("/_internal/routes/snapshot")
            .header("authorization", "Bearer secret-control-token")
            .body(Full::new(Bytes::from(serde_json::to_vec(&snapshot).unwrap())))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    let (st, _, _) = http_call(
        int_addr,
        Request::builder()
            .method("GET")
            .uri("/_internal/tls/allow?domain=minbutik.dk")
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    let (st, _, _) = http_call(
        int_addr,
        Request::builder()
            .method("GET")
            .uri("/_internal/tls/allow?domain=pending.dk")
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    let (st, hdrs, body) = http_call(
        pub_addr,
        Request::builder()
            .method("GET")
            .uri("/")
            .header("host", "minbutik.dk")
            .header("accept-encoding", "gzip")
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(hdrs.get("content-encoding").unwrap(), "gzip");
    assert_eq!(hdrs.get("x-custom-test").unwrap(), "ok");
    assert!(body.len() < index_html.len());

    let (st, _, _) = http_call(
        pub_addr,
        Request::builder()
            .method("GET")
            .uri("/")
            .header("host", "minbutik.dk")
            .header("if-none-match", format!("\"{index_sha}\""))
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::NOT_MODIFIED);

    let (st, hdrs, body) = http_call(
        pub_addr,
        Request::builder()
            .method("GET")
            .uri("/clip.mp4")
            .header("host", "minbutik.dk")
            .header("range", "bytes=2-5")
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::PARTIAL_CONTENT);
    assert_eq!(hdrs.get("content-range").unwrap(), "bytes 2-5/16");
    assert_eq!(body, Bytes::from_static(b"2345"));

    let (st, hdrs, _) = http_call(
        pub_addr,
        Request::builder()
            .method("GET")
            .uri("/products?id=7")
            .header("host", "www.minbutik.dk")
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::PERMANENT_REDIRECT);
    assert_eq!(hdrs.get("location").unwrap(), "https://minbutik.dk/products?id=7");

    let (st, _, body) = http_call(
        pub_addr,
        Request::builder()
            .method("GET")
            .uri("/missing-page")
            .header("host", "minbutik.dk")
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    assert_eq!(body, not_found_html);

    let (st, _, _) = http_call(
        pub_addr,
        Request::builder()
            .method("GET")
            .uri("/__qorpera/member")
            .header("host", "minbutik.dk")
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND);

    let (st, _, _) = http_call(
        pub_addr,
        Request::builder()
            .method("GET")
            .uri("/")
            .header("host", "hemmeligt-rum.qorpera.site")
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);

    let (st, _, _) = http_call(
        pub_addr,
        Request::builder()
            .method("POST")
            .uri("/.qorpera/unlock")
            .header("host", "hemmeligt-rum.qorpera.site")
            .header("sec-fetch-site", "same-site")
            .body(Full::new(Bytes::from("password=super-secret-pass")))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    let (st, hdrs, _) = http_call(
        pub_addr,
        Request::builder()
            .method("POST")
            .uri("/.qorpera/unlock")
            .header("host", "hemmeligt-rum.qorpera.site")
            .header("sec-fetch-site", "same-origin")
            .header("origin", "https://hemmeligt-rum.qorpera.site")
            .body(Full::new(Bytes::from("password=super-secret-pass&next=/")))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::SEE_OTHER);
    let cookie = hdrs
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();

    let (st, _, body) = http_call(
        pub_addr,
        Request::builder()
            .method("GET")
            .uri("/")
            .header("host", "hemmeligt-rum.qorpera.site")
            .header("cookie", cookie)
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body, index_html);

    snapshot.sites[0].taken_down = true;
    let (st, _, _) = http_call(
        int_addr,
        Request::builder()
            .method("POST")
            .uri("/_internal/routes/snapshot")
            .header("authorization", "Bearer secret-control-token")
            .body(Full::new(Bytes::from(serde_json::to_vec(&snapshot).unwrap())))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    let (st, _, _) = http_call(
        pub_addr,
        Request::builder()
            .method("GET")
            .uri("/")
            .header("host", "minbutik.dk")
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::GONE);

    let (st, _, _) = http_call(
        int_addr,
        Request::builder()
            .method("GET")
            .uri("/_internal/tls/allow?domain=minbutik.dk")
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn hybrid_static_fast_path_singleflight_wake_and_websocket_upgrade() {
    let backend_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let backend_addr = backend_listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = backend_listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let io = TokioIo::new(stream);
                let svc = service_fn(|mut req: Request<Incoming>| async move {
                    if req.uri().path() == "/ws" {
                        let on_upgrade = hyper::upgrade::on(&mut req);
                        tokio::spawn(async move {
                            if let Ok(upgraded) = on_upgrade.await {
                                let mut ws = TokioIo::new(upgraded);
                                let mut buf = [0u8; 64];
                                if let Ok(n) = ws.read(&mut buf).await {
                                    let _ = ws.write_all(&buf[..n]).await;
                                }
                            }
                        });
                        return Ok::<_, hyper::Error>(
                            http::Response::builder()
                                .status(StatusCode::SWITCHING_PROTOCOLS)
                                .header("connection", "upgrade")
                                .header("upgrade", "websocket")
                                .body(Full::new(Bytes::new()))
                                .unwrap(),
                        );
                    }
                    let host = req
                        .headers()
                        .get("x-forwarded-host")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("")
                        .to_string();
                    Ok::<_, hyper::Error>(
                        http::Response::builder()
                            .status(StatusCode::OK)
                            .header("content-type", "text/plain")
                            .body(Full::new(Bytes::from(format!("dynamic:{host}:{}", req.uri().path()))))
                            .unwrap(),
                    )
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(io, svc)
                    .with_upgrades()
                    .await;
            });
        }
    });

    let wake_count = Arc::new(AtomicUsize::new(0));
    let app_host_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let app_host_addr = app_host_listener.local_addr().unwrap();
    let wake_counter = Arc::clone(&wake_count);
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = app_host_listener.accept().await else {
                break;
            };
            let wc = Arc::clone(&wake_counter);
            let b_addr = backend_addr;
            tokio::spawn(async move {
                let io = TokioIo::new(stream);
                let svc = service_fn(move |_req: Request<Incoming>| {
                    let wc2 = Arc::clone(&wc);
                    async move {
                        wc2.fetch_add(1, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(80)).await;
                        let body = serde_json::json!({"upstream_addr": b_addr.to_string()}).to_string();
                        Ok::<_, hyper::Error>(
                            http::Response::builder()
                                .status(StatusCode::OK)
                                .header("content-type", "application/json")
                                .body(Full::new(Bytes::from(body)))
                                .unwrap(),
                        )
                    }
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(io, svc)
                    .await;
            });
        }
    });

    let dir = tempdir().unwrap();
    let blobs = Arc::new(BlobStore::new(dir.path().to_path_buf(), 8 * 1024 * 1024, 8 * 1024 * 1024));
    let asset = Bytes::from_static(b"console.log('fast-static');");
    let asset_sha = sha256_hex(&asset);
    blobs.put(&asset_sha, asset.clone(), false).await.unwrap();

    let mut files = HashMap::new();
    files.insert(
        "_next/static/app.js".to_string(),
        ManifestFile {
            sha256: asset_sha,
            bytes: asset.len(),
            content_type: "application/javascript".to_string(),
            immutable: true,
        },
    );

    let snapshot = EdgeSnapshot {
        hosts_domain: "qorpera.site".to_string(),
        hosts_enabled: true,
        public_enabled: true,
        domains_enabled: true,
        sites: vec![SiteRecord {
            id: "site-hybrid".to_string(),
            slug: "fullstack-app".to_string(),
            is_public: true,
            taken_down: false,
            password_sha256: None,
            password_version: 1,
            live_deployment: Some(DeploymentRecord {
                id: "dep-hybrid-1".to_string(),
                kind: DeploymentKind::Hybrid,
                manifest: SiteManifest {
                    files,
                    ..Default::default()
                },
                upstream_addr: None,
                oci_image_ref: Some("registry.qorpera.internal/sites/fullstack@sha256:1234".to_string()),
                health_path: "/".to_string(),
                idle_timeout_sec: 900,
            }),
            preview_deployments: HashMap::new(),
            primary_custom_domain: None,
        }],
        ..Default::default()
    };

    let cfg = test_config(Some(format!("http://{app_host_addr}")));
    let state = Arc::new(RouterState::new(blobs, snapshot, &cfg));
    let bound = BoundServers::bind(&cfg, state).await.unwrap();
    let pub_addr = bound.public_addr;
    let (_pub_h, _int_h) = bound.spawn();

    let (st, hdrs, body) = http_call(
        pub_addr,
        Request::builder()
            .method("GET")
            .uri("/_next/static/app.js")
            .header("host", "fullstack-app.qorpera.site")
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body, asset);
    assert_eq!(hdrs.get("cache-control").unwrap(), "public, max-age=31536000, immutable");
    assert_eq!(wake_count.load(Ordering::SeqCst), 0);

    let mut handles = Vec::new();
    for i in 0..5 {
        handles.push(tokio::spawn(async move {
            http_call(
                pub_addr,
                Request::builder()
                    .method("GET")
                    .uri(format!("/api/item/{i}"))
                    .header("host", "fullstack-app.qorpera.site")
                    .body(Full::new(Bytes::new()))
                    .unwrap(),
            )
            .await
        }));
    }
    for (i, h) in handles.into_iter().enumerate() {
        let (st, _, body) = h.await.unwrap();
        assert_eq!(st, StatusCode::OK);
        assert_eq!(
            String::from_utf8(body.to_vec()).unwrap(),
            format!("dynamic:fullstack-app.qorpera.site:/api/item/{i}")
        );
    }
    assert_eq!(wake_count.load(Ordering::SeqCst), 1);

    let stream = TcpStream::connect(pub_addr).await.unwrap();
    let io = TokioIo::new(stream);
    let (mut sender, conn) = hyper::client::conn::http1::handshake(io).await.unwrap();
    tokio::spawn(async move {
        let _ = conn.with_upgrades().await;
    });
    let mut ws_res = sender
        .send_request(
            Request::builder()
                .method("GET")
                .uri("/ws")
                .header("host", "fullstack-app.qorpera.site")
                .header("connection", "Upgrade")
                .header("upgrade", "websocket")
                .body(Full::new(Bytes::new()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(ws_res.status(), StatusCode::SWITCHING_PROTOCOLS);
    let upgraded = hyper::upgrade::on(&mut ws_res).await.unwrap();
    let mut ws_io = TokioIo::new(upgraded);
    ws_io.write_all(b"ping-through-edge").await.unwrap();
    let mut echoed = [0u8; 17];
    ws_io.read_exact(&mut echoed).await.unwrap();
    assert_eq!(&echoed, b"ping-through-edge");
}
