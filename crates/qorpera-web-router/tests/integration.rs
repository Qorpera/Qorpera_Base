use bytes::Bytes;
use http::{Request, StatusCode};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use qorpera_web_router::blob_store::{sha256_hex, BlobStore};
use qorpera_web_router::dns_verify::{DNS_TYPE_A, DNS_TYPE_TXT};
use qorpera_web_router::routes::{
    CustomDomainRecord, DeploymentKind, DeploymentRecord, DomainStatus, EdgeSnapshot, HeaderRule,
    ManifestFile, RedirectRule, SiteManifest, SiteRecord,
};
use qorpera_web_router::security::{sign_session_cookie, SITE_SESSION_COOKIE};
use qorpera_web_router::server::{
    BoundServers, EdgeAuthBackend, MemoryAuthBackend, RedeemedMemberPass, RedeemedTicket,
    RouterConfig, RouterState,
};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tempfile::tempdir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket};

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
        dns_servers: vec![],
        database_url: None,
        auth_backend: None,
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
                    app_port: None,
                    health_path: "/".to_string(),
                    idle_timeout_sec: 900,
                    memory_mb: 512,
                    vcpu_limit: 1.0,
                    env_spec: HashMap::new(),
                }),
                preview_deployments: HashMap::new(),
                primary_custom_domain: Some("minbutik.dk".to_string()),
                db_live: None,
                db_previews: HashMap::new(),
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
                    app_port: None,
                    health_path: "/".to_string(),
                    idle_timeout_sec: 900,
                    memory_mb: 512,
                    vcpu_limit: 1.0,
                    env_spec: HashMap::new(),
                }),
                preview_deployments: HashMap::new(),
                primary_custom_domain: None,
                db_live: None,
                db_previews: HashMap::new(),
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
                last_checked_at: None,
                consecutive_misses: 0,
            },
            CustomDomainRecord {
                id: "dom-www".to_string(),
                site_id: "site-public".to_string(),
                hostname: "www.minbutik.dk".to_string(),
                is_apex: false,
                is_primary: false,
                status: DomainStatus::DnsVerified,
                verification_token: "v2".to_string(),
                last_checked_at: None,
                consecutive_misses: 0,
            },
            CustomDomainRecord {
                id: "dom-pending".to_string(),
                site_id: "site-public".to_string(),
                hostname: "pending.dk".to_string(),
                is_apex: true,
                is_primary: false,
                status: DomainStatus::PendingDns,
                verification_token: "v3".to_string(),
                last_checked_at: None,
                consecutive_misses: 0,
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
                app_port: Some(3000),
                health_path: "/".to_string(),
                idle_timeout_sec: 900,
                memory_mb: 512,
                vcpu_limit: 1.0,
                env_spec: HashMap::new(),
            }),
            preview_deployments: HashMap::new(),
            primary_custom_domain: None,
            db_live: None,
            db_previews: HashMap::new(),
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

#[tokio::test]
async fn preview_ticket_member_pass_and_live_dns_domain_verification() {
    let dns_server = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let dns_addr = dns_server.local_addr().unwrap();
    tokio::spawn(async move {
        let mut buf = [0u8; 512];
        for _ in 0..16 {
            let Ok((n, peer)) = dns_server.recv_from(&mut buf).await else {
                break;
            };
            if n < 12 {
                continue;
            }
            let mut offset = 12usize;
            let mut labels = Vec::new();
            while offset < n && buf[offset] != 0 {
                let len = buf[offset] as usize;
                offset += 1;
                labels.push(String::from_utf8_lossy(&buf[offset..offset + len]).into_owned());
                offset += len;
            }
            let qname = labels.join(".");
            let after_name = offset + 1;
            let qtype = u16::from_be_bytes([buf[after_name], buf[after_name + 1]]);
            let rdata: Option<(u16, Vec<u8>)> = match (qname.as_str(), qtype) {
                ("newshop.dk", DNS_TYPE_A) => Some((DNS_TYPE_A, vec![93, 164, 62, 162])),
                ("_qorpera.newshop.dk", DNS_TYPE_TXT) => {
                    let txt = b"qorpera-verify=tok-new";
                    let mut v = vec![txt.len() as u8];
                    v.extend_from_slice(txt);
                    Some((DNS_TYPE_TXT, v))
                }
                _ => None,
            };
            let mut resp = Vec::new();
            resp.extend_from_slice(&buf[0..2]);
            resp.extend_from_slice(&0x8180u16.to_be_bytes());
            resp.extend_from_slice(&1u16.to_be_bytes());
            resp.extend_from_slice(&(if rdata.is_some() { 1u16 } else { 0u16 }).to_be_bytes());
            resp.extend_from_slice(&0u16.to_be_bytes());
            resp.extend_from_slice(&0u16.to_be_bytes());
            resp.extend_from_slice(&buf[12..after_name + 4]);
            if let Some((rt, data)) = rdata {
                resp.extend_from_slice(&[0xC0, 0x0C]);
                resp.extend_from_slice(&rt.to_be_bytes());
                resp.extend_from_slice(&1u16.to_be_bytes());
                resp.extend_from_slice(&60u32.to_be_bytes());
                resp.extend_from_slice(&(data.len() as u16).to_be_bytes());
                resp.extend_from_slice(&data);
            }
            let _ = dns_server.send_to(&resp, peer).await;
        }
    });

    let dir = tempdir().unwrap();
    let blobs = Arc::new(BlobStore::new(dir.path().to_path_buf(), 8 * 1024 * 1024, 8 * 1024 * 1024));
    let live_html = Bytes::from("<html><body>live-v1</body></html>");
    let preview_html = Bytes::from("<html><body>preview-v2</body></html>");
    let live_sha = sha256_hex(&live_html);
    let preview_sha = sha256_hex(&preview_html);
    blobs.put(&live_sha, live_html.clone(), false).await.unwrap();
    blobs.put(&preview_sha, preview_html.clone(), false).await.unwrap();

    let mut live_files = HashMap::new();
    live_files.insert(
        "index.html".to_string(),
        ManifestFile {
            sha256: live_sha,
            bytes: live_html.len(),
            content_type: "text/html; charset=utf-8".to_string(),
            immutable: false,
        },
    );
    let mut preview_files = HashMap::new();
    preview_files.insert(
        "index.html".to_string(),
        ManifestFile {
            sha256: preview_sha,
            bytes: preview_html.len(),
            content_type: "text/html; charset=utf-8".to_string(),
            immutable: false,
        },
    );

    let mut previews = HashMap::new();
    previews.insert(
        "ver-2".to_string(),
        DeploymentRecord {
            id: "dep-2".to_string(),
            kind: DeploymentKind::Static,
            manifest: SiteManifest {
                files: preview_files,
                ..Default::default()
            },
            upstream_addr: None,
            oci_image_ref: None,
            app_port: None,
            health_path: "/".to_string(),
            idle_timeout_sec: 900,
            memory_mb: 512,
            vcpu_limit: 1.0,
            env_spec: HashMap::new(),
        },
    );

    let snapshot = EdgeSnapshot {
        hosts_domain: "qorpera.site".to_string(),
        legacy_hosts_domains: vec!["qorpera.com".to_string()],
        hosts_enabled: true,
        public_enabled: true,
        domains_enabled: true,
        edge_ipv4: Some("93.164.62.162".to_string()),
        edge_ipv6: None,
        edge_cname_target: Some("sites.qorpera.site".to_string()),
        sites: vec![SiteRecord {
            id: "site-1".to_string(),
            slug: "kaffe-shop".to_string(),
            is_public: false,
            taken_down: false,
            password_sha256: Some(sha256_hex(b"pass")),
            password_version: 3,
            live_deployment: Some(DeploymentRecord {
                id: "dep-1".to_string(),
                kind: DeploymentKind::Static,
                manifest: SiteManifest {
                    files: live_files,
                    ..Default::default()
                },
                upstream_addr: None,
                oci_image_ref: None,
                app_port: None,
                health_path: "/".to_string(),
                idle_timeout_sec: 900,
                memory_mb: 512,
                vcpu_limit: 1.0,
                env_spec: HashMap::new(),
            }),
            preview_deployments: previews,
            primary_custom_domain: None,
            db_live: None,
            db_previews: HashMap::new(),
        }],
        custom_domains: vec![CustomDomainRecord {
            id: "dom-new".to_string(),
            site_id: "site-1".to_string(),
            hostname: "newshop.dk".to_string(),
            is_apex: true,
            is_primary: false,
            status: DomainStatus::PendingDns,
            verification_token: "tok-new".to_string(),
            last_checked_at: None,
            consecutive_misses: 0,
        }],
    };

    let auth = Arc::new(MemoryAuthBackend::default());
    auth.insert_ticket(
        "kaffe-shop--next.qorpera.site",
        "ticket-123",
        RedeemedTicket {
            site_id: "site-1".to_string(),
            version_id: "ver-2".to_string(),
            password_version: 3,
            max_age: 43200,
        },
    );
    auth.insert_member_pass(
        "kaffe-shop.qorpera.site",
        "member-pass-123",
        RedeemedMemberPass {
            site_id: "site-1".to_string(),
            version_id: None,
            password_version: 3,
            max_age: 43200,
        },
    );

    let mut cfg = test_config(None);
    cfg.dns_servers = vec![dns_addr];
    cfg.auth_backend = Some(auth as Arc<dyn EdgeAuthBackend>);

    let state = Arc::new(RouterState::new(blobs, snapshot, &cfg));
    let bound = BoundServers::bind(&cfg, state).await.unwrap();
    let pub_addr = bound.public_addr;
    let int_addr = bound.internal_addr;
    let (_p, _i) = bound.spawn();

    let (st, hdrs, _) = http_call(
        pub_addr,
        Request::builder()
            .method("GET")
            .uri("/.qorpera/enter?t=ticket-123")
            .header("host", "kaffe-shop--next.qorpera.site")
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::SEE_OTHER);
    let preview_cookie = hdrs
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();

    let (st, _, _) = http_call(
        pub_addr,
        Request::builder()
            .method("GET")
            .uri("/.qorpera/enter?t=ticket-123")
            .header("host", "kaffe-shop--next.qorpera.site")
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);

    let (st, _, body) = http_call(
        pub_addr,
        Request::builder()
            .method("GET")
            .uri("/")
            .header("host", "kaffe-shop--next.qorpera.site")
            .header("cookie", preview_cookie)
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let html = String::from_utf8(body.to_vec()).unwrap();
    assert!(html.contains("preview-v2"));
    assert!(html.contains("data-qorpera-preview=\"1\""));

    let (st, _, _) = http_call(
        pub_addr,
        Request::builder()
            .method("POST")
            .uri("/__qorpera/member")
            .header("host", "kaffe-shop.qorpera.site")
            .header("origin", "https://evil.example")
            .header("sec-fetch-site", "cross-site")
            .body(Full::new(Bytes::from("pass=member-pass-123&path=/")))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    let (st, _, _) = http_call(
        pub_addr,
        Request::builder()
            .method("POST")
            .uri("/__qorpera/member")
            .header("host", "kaffe-shop.qorpera.site")
            .body(Full::new(Bytes::from("pass=member-pass-123&path=/")))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    let (st, hdrs, _) = http_call(
        pub_addr,
        Request::builder()
            .method("POST")
            .uri("/__qorpera/member")
            .header("host", "kaffe-shop.qorpera.site")
            .header("origin", "https://app.qorpera.com")
            .header("sec-fetch-site", "cross-site")
            .body(Full::new(Bytes::from("pass=member-pass-123&path=/")))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::SEE_OTHER);
    let set_cookie_raw = hdrs.get("set-cookie").unwrap().to_str().unwrap();
    assert!(set_cookie_raw.contains("SameSite=None"));
    let member_cookie = set_cookie_raw.split(';').next().unwrap().to_string();

    let (st, _, body) = http_call(
        pub_addr,
        Request::builder()
            .method("GET")
            .uri("/")
            .header("host", "kaffe-shop.qorpera.site")
            .header("cookie", member_cookie.clone())
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body, live_html);

    let (st, _, _) = http_call(
        int_addr,
        Request::builder()
            .method("GET")
            .uri("/_internal/tls/allow?domain=newshop.dk")
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    let (st, _, _) = http_call(
        int_addr,
        Request::builder()
            .method("POST")
            .uri("/_internal/domains/verify")
            .header("authorization", "Bearer secret-control-token")
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    let (st, _, _) = http_call(
        int_addr,
        Request::builder()
            .method("GET")
            .uri("/_internal/tls/allow?domain=newshop.dk")
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    let (st, _, body) = http_call(
        pub_addr,
        Request::builder()
            .method("GET")
            .uri("/")
            .header("host", "newshop.dk")
            .header("cookie", member_cookie)
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body, live_html);
}

#[tokio::test]
async fn hardening_security_utf8_limits_cookie_strip_stale_pool_and_readiness() {
    let dir = tempdir().unwrap();
    let blobs = Arc::new(BlobStore::new(dir.path().to_path_buf(), 2 * 1024 * 1024, 64 * 1024));
    let mut cfg = test_config(None);
    cfg.database_url = Some("postgresql://127.0.0.1:1/unused".to_string());
    let state = Arc::new(RouterState::new(blobs, EdgeSnapshot::default(), &cfg));
    let bound = BoundServers::bind(&cfg, Arc::clone(&state)).await.unwrap();
    let pub_addr = bound.public_addr;
    let int_addr = bound.internal_addr;
    let (_pub_h, _int_h) = bound.spawn();

    let (st, _, _) = http_call(
        int_addr,
        Request::builder()
            .method("GET")
            .uri("/_internal/health")
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::SERVICE_UNAVAILABLE);

    let html_bytes = Bytes::from("<html><body>private-hardening-test-body</body></html>".repeat(20));
    let html_sha = sha256_hex(&html_bytes);
    let (st, _, _) = http_call(
        int_addr,
        Request::builder()
            .method("PUT")
            .uri(format!("/_internal/blobs/{html_sha}"))
            .header("authorization", "Bearer secret-control-token")
            .body(Full::new(html_bytes.clone()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::CREATED);

    let oversized = Bytes::from(vec![b'x'; 80 * 1024]);
    let (st, _, _) = http_call(
        int_addr,
        Request::builder()
            .method("PUT")
            .uri(format!("/_internal/blobs/{}", sha256_hex(&oversized)))
            .header("authorization", "Bearer secret-control-token")
            .body(Full::new(oversized))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::PAYLOAD_TOO_LARGE);

    let backend_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let backend_addr = backend_listener.local_addr().unwrap();
    let saw_cookie: Arc<std::sync::Mutex<String>> = Arc::new(std::sync::Mutex::new(String::new()));
    let saw_cookie_ref = Arc::clone(&saw_cookie);
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = backend_listener.accept().await else {
                break;
            };
            let sc = Arc::clone(&saw_cookie_ref);
            tokio::spawn(async move {
                let io = TokioIo::new(stream);
                let svc = service_fn(move |req: Request<Incoming>| {
                    let sc_inner = Arc::clone(&sc);
                    async move {
                        let cookie_val = req
                            .headers()
                            .get("cookie")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("")
                            .to_string();
                        *sc_inner.lock().unwrap() = cookie_val;
                        Ok::<_, hyper::Error>(
                            http::Response::builder()
                                .status(StatusCode::OK)
                                .header("cache-control", "public, max-age=86400")
                                .header("x-robots-tag", "index")
                                .body(Full::new(Bytes::from_static(b"backend-ok")))
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

    let mut files = HashMap::new();
    files.insert(
        "index.html".to_string(),
        ManifestFile {
            sha256: html_sha.clone(),
            bytes: html_bytes.len(),
            content_type: "text/html; charset=utf-8".to_string(),
            immutable: false,
        },
    );
    let snapshot = EdgeSnapshot {
        hosts_domain: "qorpera.site".to_string(),
        hosts_enabled: true,
        public_enabled: true,
        domains_enabled: true,
        sites: vec![SiteRecord {
            id: "site-priv-h".to_string(),
            slug: "priv-hard".to_string(),
            is_public: false,
            taken_down: false,
            password_sha256: Some(sha256_hex(b"secret-pw")),
            password_version: 1,
            live_deployment: Some(DeploymentRecord {
                id: "dep-priv-h".to_string(),
                kind: DeploymentKind::Hybrid,
                manifest: SiteManifest {
                    files,
                    redirects: vec![
                        RedirectRule {
                            from: "/old/*".to_string(),
                            to: "/new/:splat".to_string(),
                            status: 301,
                        },
                        RedirectRule {
                            from: "/open/*".to_string(),
                            to: "/:splat".to_string(),
                            status: 302,
                        },
                    ],
                    headers: vec![HeaderRule {
                        path_prefix: "/".to_string(),
                        headers: HashMap::from([
                            ("cache-control".to_string(), "public, max-age=999999".to_string()),
                            ("x-robots-tag".to_string(), "index, follow".to_string()),
                            ("x-allowed".to_string(), "yes".to_string()),
                        ]),
                    }],
                    spa_fallback: None,
                    not_found_page: None,
                },
                upstream_addr: Some(backend_addr.to_string()),
                oci_image_ref: None,
                app_port: None,
                health_path: "/".to_string(),
                idle_timeout_sec: 900,
                memory_mb: 512,
                vcpu_limit: 1.0,
                env_spec: HashMap::new(),
            }),
            preview_deployments: HashMap::new(),
            primary_custom_domain: None,
            db_live: None,
            db_previews: HashMap::new(),
        }],
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
            .uri("/_internal/health")
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    let (st, _, _) = http_call(
        pub_addr,
        Request::builder()
            .method("POST")
            .uri("/.qorpera/unlock")
            .header("host", "priv-hard.qorpera.site")
            .body(Full::new(Bytes::from("password=%a\u{00e9}&next=%f\u{00f8}")))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);

    let (st, _, _) = http_call(
        pub_addr,
        Request::builder()
            .method("POST")
            .uri("/.qorpera/unlock")
            .header("host", "priv-hard.qorpera.site")
            .body(Full::new(Bytes::from(vec![b'a'; 32 * 1024])))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::PAYLOAD_TOO_LARGE);

    let (st, hdrs, _) = http_call(
        pub_addr,
        Request::builder()
            .method("POST")
            .uri("/.qorpera/unlock")
            .header("host", "priv-hard.qorpera.site")
            .body(Full::new(Bytes::from("password=secret-pw&next=/")))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::SEE_OTHER);
    let session_cookie = hdrs
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();

    let (st, hdrs, body_br) = http_call(
        pub_addr,
        Request::builder()
            .method("GET")
            .uri("/")
            .header("host", "priv-hard.qorpera.site")
            .header("cookie", session_cookie.clone())
            .header("accept-encoding", "gzip, br, zstd")
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(hdrs.get("content-encoding").unwrap(), "br");
    assert!(body_br.len() < html_bytes.len());

    let (st, hdrs, body_zstd) = http_call(
        pub_addr,
        Request::builder()
            .method("GET")
            .uri("/")
            .header("host", "priv-hard.qorpera.site")
            .header("cookie", session_cookie.clone())
            .header("accept-encoding", "zstd;q=1.0, br;q=0.5, gzip;q=0.5")
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(hdrs.get("content-encoding").unwrap(), "zstd");
    assert!(body_zstd.len() < html_bytes.len());

    let (st, hdrs, _) = http_call(
        pub_addr,
        Request::builder()
            .method("GET")
            .uri("/")
            .header("host", "priv-hard.qorpera.site")
            .header("cookie", session_cookie.clone())
            .header("accept-encoding", "gzip;q=0, identity")
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert!(hdrs.get("content-encoding").is_none());
    assert_eq!(hdrs.get("cache-control").unwrap(), "private, no-cache, no-transform");
    assert_eq!(hdrs.get("x-robots-tag").unwrap(), "noindex, nofollow, noarchive");
    assert_eq!(hdrs.get("x-allowed").unwrap(), "yes");

    let (st, _, _) = http_call(
        pub_addr,
        Request::builder()
            .method("GET")
            .uri("/")
            .header("host", "priv-hard.qorpera.site")
            .header("cookie", session_cookie.clone())
            .header("if-none-match", format!("\"other\", W/\"{html_sha}\""))
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::NOT_MODIFIED);

    let (st, hdrs, body) = http_call(
        pub_addr,
        Request::builder()
            .method("GET")
            .uri("/api/me")
            .header("host", "priv-hard.qorpera.site")
            .header("cookie", format!("{session_cookie}; app_sid=user42"))
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body, Bytes::from_static(b"backend-ok"));
    assert_eq!(saw_cookie.lock().unwrap().as_str(), "app_sid=user42");
    assert_eq!(hdrs.get("cache-control").unwrap(), "private, no-store, no-transform");
    assert_eq!(hdrs.get("x-robots-tag").unwrap(), "noindex, nofollow, noarchive");

    let stream = TcpStream::connect(pub_addr).await.unwrap();
    let io = TokioIo::new(stream);
    let (mut h2_sender, h2_conn) =
        hyper::client::conn::http2::handshake(hyper_util::rt::TokioExecutor::new(), io)
            .await
            .unwrap();
    tokio::spawn(async move {
        let _ = h2_conn.await;
    });
    let h2_req = Request::builder()
        .method("GET")
        .uri("http://priv-hard.qorpera.site/")
        .header("cookie", session_cookie)
        .header("accept-encoding", "br, zstd, gzip")
        .body(Full::new(Bytes::new()))
        .unwrap();
    let h2_res = h2_sender.send_request(h2_req).await.unwrap();
    assert_eq!(h2_res.status(), StatusCode::OK);
    assert_eq!(h2_res.headers().get("content-encoding").unwrap(), "br");
}

#[tokio::test]
async fn websocket_concurrency_cap_activity_heartbeat_streaming_blobs_timeouts_and_shutdown() {
    let backend_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let backend_addr = backend_listener.local_addr().unwrap();
    let backend_task = tokio::spawn(async move {
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
                                while let Ok(n) = ws.read(&mut buf).await {
                                    if n == 0 {
                                        break;
                                    }
                                    if ws.write_all(&buf[..n]).await.is_err() {
                                        break;
                                    }
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
                    Ok::<_, hyper::Error>(
                        http::Response::builder()
                            .status(StatusCode::OK)
                            .body(Full::new(Bytes::from_static(b"ok")))
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

    let dir = tempdir().unwrap();
    let blobs = Arc::new(
        BlobStore::new(dir.path().to_path_buf(), 64 * 512, 1024 * 1024).with_stream_threshold(1024),
    );
    let large_payload = Bytes::from(vec![b'M'; 8192]);
    let large_sha = sha256_hex(&large_payload);

    let mut files = HashMap::new();
    files.insert(
        "large.bin".to_string(),
        ManifestFile {
            sha256: large_sha.clone(),
            bytes: large_payload.len(),
            content_type: "application/octet-stream".to_string(),
            immutable: true,
        },
    );

    let snapshot = EdgeSnapshot {
        hosts_domain: "qorpera.site".to_string(),
        hosts_enabled: true,
        public_enabled: true,
        domains_enabled: true,
        sites: vec![SiteRecord {
            id: "site-ws".to_string(),
            slug: "ws-cap".to_string(),
            is_public: true,
            taken_down: false,
            password_sha256: None,
            password_version: 1,
            live_deployment: Some(DeploymentRecord {
                id: "dep-ws-1".to_string(),
                kind: DeploymentKind::Hybrid,
                manifest: SiteManifest {
                    files,
                    ..Default::default()
                },
                upstream_addr: Some(backend_addr.to_string()),
                oci_image_ref: None,
                app_port: Some(3000),
                health_path: "/".to_string(),
                idle_timeout_sec: 900,
                memory_mb: 512,
                vcpu_limit: 1.0,
                env_spec: HashMap::new(),
            }),
            preview_deployments: HashMap::new(),
            primary_custom_domain: None,
            db_live: None,
            db_previews: HashMap::new(),
        }],
        ..Default::default()
    };

    let cfg = test_config(None);
    let state = Arc::new(
        RouterState::new(blobs, snapshot, &cfg)
            .with_ws_limit(2)
            .with_ws_heartbeat(Duration::from_millis(200))
            .with_body_read_timeout(Duration::from_millis(120)),
    );
    let bound = BoundServers::bind(&cfg, Arc::clone(&state)).await.unwrap();
    let pub_addr = bound.public_addr;
    let int_addr = bound.internal_addr;
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let (pub_h, int_h) = bound.spawn_with_shutdown(shutdown_rx.clone());

    #[cfg(unix)]
    let (sock_path, unix_h) = {
        use std::os::unix::fs::PermissionsExt;
        let sock_path = dir.path().join("public.sock");
        let h = qorpera_web_router::server::spawn_public_unix_listener_with_shutdown(
            sock_path.clone(),
            Arc::clone(&state),
            shutdown_rx.clone(),
        )
        .unwrap();
        let mode = std::fs::metadata(&sock_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o660, "public.sock must be restricted to 0660");
        (sock_path, h)
    };

    let (st, _, _) = http_call(
        int_addr,
        Request::builder()
            .method("PUT")
            .uri(format!("/_internal/blobs/{large_sha}"))
            .header("authorization", "Bearer secret-control-token")
            .body(Full::new(large_payload.clone()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::CREATED);

    let (st, hdrs, body) = http_call(
        pub_addr,
        Request::builder()
            .method("GET")
            .uri("/large.bin")
            .header("host", "ws-cap.qorpera.site")
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(hdrs.get("content-length").unwrap(), "8192");
    assert_eq!(body, large_payload);

    let (st, hdrs, body) = http_call(
        pub_addr,
        Request::builder()
            .method("GET")
            .uri("/large.bin")
            .header("host", "ws-cap.qorpera.site")
            .header("range", "bytes=100-299")
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::PARTIAL_CONTENT);
    assert_eq!(hdrs.get("content-range").unwrap(), "bytes 100-299/8192");
    assert_eq!(body.len(), 200);

    let open_ws = || async {
        let stream = TcpStream::connect(pub_addr).await.unwrap();
        let io = TokioIo::new(stream);
        let (mut sender, conn) = hyper::client::conn::http1::handshake(io).await.unwrap();
        tokio::spawn(async move {
            let _ = conn.with_upgrades().await;
        });
        let res = sender
            .send_request(
                Request::builder()
                    .method("GET")
                    .uri("/ws")
                    .header("host", "ws-cap.qorpera.site")
                    .header("connection", "Upgrade")
                    .header("upgrade", "websocket")
                    .body(Full::new(Bytes::new()))
                    .unwrap(),
            )
            .await
            .unwrap();
        res
    };

    let mut ws1_res = open_ws().await;
    assert_eq!(ws1_res.status(), StatusCode::SWITCHING_PROTOCOLS);
    let mut ws1_io = TokioIo::new(hyper::upgrade::on(&mut ws1_res).await.unwrap());

    let mut ws2_res = open_ws().await;
    assert_eq!(ws2_res.status(), StatusCode::SWITCHING_PROTOCOLS);
    let ws2_io = TokioIo::new(hyper::upgrade::on(&mut ws2_res).await.unwrap());

    let ws3_res = open_ws().await;
    assert_eq!(ws3_res.status(), StatusCode::SERVICE_UNAVAILABLE);

    let ts_before = *state
        .activity
        .snapshot()
        .deployments
        .get("dep-ws-1")
        .unwrap();
    tokio::time::sleep(Duration::from_millis(1100)).await;
    ws1_io.write_all(b"ping").await.unwrap();
    let mut echo = [0u8; 4];
    ws1_io.read_exact(&mut echo).await.unwrap();
    assert_eq!(&echo, b"ping");
    tokio::time::sleep(Duration::from_millis(250)).await;
    let ts_after = *state
        .activity
        .snapshot()
        .deployments
        .get("dep-ws-1")
        .unwrap();
    assert!(
        ts_after > ts_before,
        "active WS traffic must keep advancing deployment activity ({ts_before} -> {ts_after})"
    );

    drop(ws1_io);
    drop(ws2_io);
    let mut recovered = false;
    for _ in 0..20 {
        let res = open_ws().await;
        if res.status() == StatusCode::SWITCHING_PROTOCOLS {
            recovered = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(recovered, "WS permit must be released once clients close");

    let mut stalled = TcpStream::connect(int_addr).await.unwrap();
    let stalled_req = format!(
        "POST /_internal/routes/snapshot HTTP/1.1\r\nHost: {int_addr}\r\nAuthorization: Bearer secret-control-token\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{{\"a\""
    );
    stalled.write_all(stalled_req.as_bytes()).await.unwrap();
    let mut resp = Vec::new();
    let mut buf = [0u8; 512];
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while std::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(300), stalled.read(&mut buf)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => {
                resp.extend_from_slice(&buf[..n]);
                if String::from_utf8_lossy(&resp).contains("body timeout") {
                    break;
                }
            }
            Ok(Err(_)) | Err(_) => break,
        }
    }
    let resp_text = String::from_utf8_lossy(&resp);
    assert!(
        resp_text.starts_with("HTTP/1.1 408"),
        "expected 408 on stalled snapshot upload, got: {resp_text}"
    );

    let _ = shutdown_tx.send(true);
    tokio::time::timeout(Duration::from_secs(1), async {
        let _ = pub_h.await;
        let _ = int_h.await;
        #[cfg(unix)]
        {
            let _ = unix_h.await;
            let _ = std::fs::remove_file(&sock_path);
        }
    })
    .await
    .expect("router listeners must exit promptly on shutdown signal");
    backend_task.abort();
}

#[tokio::test]
async fn websocket_per_deployment_isolation_idle_cutoff_and_streamed_sidecar_integrity() {
    let backend_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let backend_addr = backend_listener.local_addr().unwrap();
    let backend_task = tokio::spawn(async move {
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
                                while let Ok(n) = ws.read(&mut buf).await {
                                    if n == 0 {
                                        break;
                                    }
                                    if ws.write_all(&buf[..n]).await.is_err() {
                                        break;
                                    }
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
                    Ok::<_, hyper::Error>(
                        http::Response::builder()
                            .status(StatusCode::OK)
                            .body(Full::new(Bytes::from_static(b"ok")))
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

    let dir = tempdir().unwrap();
    let blobs = Arc::new(
        BlobStore::new(dir.path().to_path_buf(), 64 * 512, 1024 * 1024).with_stream_threshold(1024),
    );
    let large_js = Bytes::from("export const message = 'qorpera streaming asset test';\n".repeat(160));
    let large_sha = sha256_hex(&large_js);

    let mut files = HashMap::new();
    files.insert(
        "bundle.js".to_string(),
        ManifestFile {
            sha256: large_sha.clone(),
            bytes: large_js.len(),
            content_type: "application/javascript".to_string(),
            immutable: true,
        },
    );

    let make_site = |id: &str, slug: &str, dep_id: &str, site_files: HashMap<String, ManifestFile>| SiteRecord {
        id: id.to_string(),
        slug: slug.to_string(),
        is_public: true,
        taken_down: false,
        password_sha256: None,
        password_version: 1,
        live_deployment: Some(DeploymentRecord {
            id: dep_id.to_string(),
            kind: DeploymentKind::Hybrid,
            manifest: SiteManifest {
                files: site_files,
                ..Default::default()
            },
            upstream_addr: Some(backend_addr.to_string()),
            oci_image_ref: None,
            app_port: Some(3000),
            health_path: "/".to_string(),
            idle_timeout_sec: 900,
            memory_mb: 512,
            vcpu_limit: 1.0,
            env_spec: HashMap::new(),
        }),
        preview_deployments: HashMap::new(),
        primary_custom_domain: None,
        db_live: None,
        db_previews: HashMap::new(),
    };

    let snapshot = EdgeSnapshot {
        hosts_domain: "qorpera.site".to_string(),
        hosts_enabled: true,
        public_enabled: true,
        domains_enabled: true,
        sites: vec![
            make_site("site-a", "tenant-a", "dep-a", files),
            make_site("site-b", "tenant-b", "dep-b", HashMap::new()),
        ],
        ..Default::default()
    };

    let cfg = test_config(None);
    let state = Arc::new(
        RouterState::new(blobs, snapshot, &cfg)
            .with_ws_limits(4, 1, 10)
            .with_ws_heartbeat(Duration::from_millis(60))
            .with_ws_idle_timeout(Duration::from_millis(180)),
    );
    let bound = BoundServers::bind(&cfg, Arc::clone(&state)).await.unwrap();
    let pub_addr = bound.public_addr;
    let int_addr = bound.internal_addr;
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let (pub_h, int_h) = bound.spawn_with_shutdown(shutdown_rx);

    let (st, _, _) = http_call(
        int_addr,
        Request::builder()
            .method("PUT")
            .uri(format!("/_internal/blobs/{large_sha}"))
            .header("authorization", "Bearer secret-control-token")
            .body(Full::new(large_js.clone()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::CREATED);

    let (st, hdrs, br_body) = http_call(
        pub_addr,
        Request::builder()
            .method("GET")
            .uri("/bundle.js")
            .header("host", "tenant-a.qorpera.site")
            .header("accept-encoding", "gzip, br, zstd")
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(hdrs.get("content-encoding").unwrap(), "br");
    assert!(br_body.len() < large_js.len());

    let raw_path = dir.path().join(&large_sha[0..2]).join(&large_sha[2..4]).join(&large_sha);
    let mut tampered = large_js.to_vec();
    tampered[0] ^= 0x55;
    tokio::fs::write(&raw_path, &tampered).await.unwrap();

    let stream = TcpStream::connect(pub_addr).await.unwrap();
    let io = TokioIo::new(stream);
    let (mut sender, conn) = hyper::client::conn::http1::handshake(io).await.unwrap();
    tokio::spawn(async move {
        let _ = conn.await;
    });
    let corrupt_res = sender
        .send_request(
            Request::builder()
                .method("GET")
                .uri("/bundle.js")
                .header("host", "tenant-a.qorpera.site")
                .header("accept-encoding", "identity")
                .body(Full::new(Bytes::new()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(
        corrupt_res.into_body().collect().await.is_err(),
        "corrupt streamed blob above threshold must fail transfer instead of returning clean 200"
    );

    let open_ws = |host: &'static str| async move {
        let stream = TcpStream::connect(pub_addr).await.unwrap();
        let io = TokioIo::new(stream);
        let (mut sender, conn) = hyper::client::conn::http1::handshake(io).await.unwrap();
        tokio::spawn(async move {
            let _ = conn.with_upgrades().await;
        });
        sender
            .send_request(
                Request::builder()
                    .method("GET")
                    .uri("/ws")
                    .header("host", host)
                    .header("connection", "Upgrade")
                    .header("upgrade", "websocket")
                    .body(Full::new(Bytes::new()))
                    .unwrap(),
            )
            .await
            .unwrap()
    };

    let mut ws_a1 = open_ws("tenant-a.qorpera.site").await;
    assert_eq!(ws_a1.status(), StatusCode::SWITCHING_PROTOCOLS);
    let mut ws_a1_io = TokioIo::new(hyper::upgrade::on(&mut ws_a1).await.unwrap());

    let ws_a2 = open_ws("tenant-a.qorpera.site").await;
    assert_eq!(ws_a2.status(), StatusCode::SERVICE_UNAVAILABLE);

    let mut ws_b1 = open_ws("tenant-b.qorpera.site").await;
    assert_eq!(ws_b1.status(), StatusCode::SWITCHING_PROTOCOLS);
    let _ws_b1_io = TokioIo::new(hyper::upgrade::on(&mut ws_b1).await.unwrap());

    let mut buf = [0u8; 8];
    let closed = tokio::time::timeout(Duration::from_secs(2), ws_a1_io.read(&mut buf))
        .await
        .expect("idle WS must be closed by idle timeout");
    assert!(
        matches!(closed, Ok(0) | Err(_)),
        "expected EOF or reset after idle cutoff, got: {closed:?}"
    );

    let mut recovered = false;
    for _ in 0..20 {
        let res = open_ws("tenant-a.qorpera.site").await;
        if res.status() == StatusCode::SWITCHING_PROTOCOLS {
            recovered = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(recovered, "per-deployment WS permit must be freed after idle cutoff");

    let _ = shutdown_tx.send(true);
    let _ = tokio::time::timeout(Duration::from_secs(1), async {
        let _ = pub_h.await;
        let _ = int_h.await;
    })
    .await;
    backend_task.abort();
}

fn get(host: &str, path: &str, headers: &[(&str, &str)]) -> Request<Full<Bytes>> {
    let mut builder = Request::builder().method("GET").uri(path).header("host", host);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    builder.body(Full::new(Bytes::new())).unwrap()
}

fn first_cookie(headers: &http::HeaderMap) -> String {
    headers
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string()
}

fn html_file(sha256: String, bytes: usize) -> ManifestFile {
    ManifestFile {
        sha256,
        bytes,
        content_type: "text/html; charset=utf-8".to_string(),
        immutable: false,
    }
}

fn static_deployment(id: &str, files: HashMap<String, ManifestFile>) -> DeploymentRecord {
    DeploymentRecord {
        id: id.to_string(),
        kind: DeploymentKind::Static,
        manifest: SiteManifest {
            files,
            ..Default::default()
        },
        upstream_addr: None,
        oci_image_ref: None,
        app_port: None,
        health_path: "/".to_string(),
        idle_timeout_sec: 900,
        memory_mb: 512,
        vcpu_limit: 1.0,
        env_spec: HashMap::new(),
    }
}

fn site_record(id: &str, slug: &str, is_public: bool, password_sha256: Option<String>) -> SiteRecord {
    SiteRecord {
        id: id.to_string(),
        slug: slug.to_string(),
        is_public,
        taken_down: false,
        password_sha256,
        password_version: 4,
        live_deployment: None,
        preview_deployments: HashMap::new(),
        primary_custom_domain: None,
        db_live: None,
        db_previews: HashMap::new(),
    }
}

#[tokio::test]
async fn websites_not_live_yet_and_served_from_database_versions() {
    let dir = tempdir().unwrap();
    let blobs = Arc::new(BlobStore::new(dir.path().to_path_buf(), 8 * 1024 * 1024, 8 * 1024 * 1024));

    let live_html = Bytes::from("<html><body>stored-live</body></html>");
    let next_html = Bytes::from("<html><body>stored-next</body></html>");
    let missing_html = Bytes::from("<h1>stored 404</h1>");
    let open_html = Bytes::from("<html><body>open-site</body></html>");
    let style_css = Bytes::from("body { color: #123456 }".repeat(40));
    let bad_real = Bytes::from("<p>what the manifest names</p>");
    let bad_served = Bytes::from("<p>WHAT THE MANIFEST NAMES</p>");
    assert_eq!(bad_real.len(), bad_served.len());
    let short_html = Bytes::from("<p>short</p>");

    let mut closed_files = HashMap::new();
    closed_files.insert("index.html".to_string(), html_file(sha256_hex(&live_html), live_html.len()));
    closed_files.insert("404.html".to_string(), html_file(sha256_hex(&missing_html), missing_html.len()));
    closed_files.insert("bad.html".to_string(), html_file(sha256_hex(&bad_real), bad_real.len()));
    closed_files.insert("short.html".to_string(), html_file(sha256_hex(&short_html), short_html.len() + 5));
    closed_files.insert("gone.html".to_string(), html_file("e".repeat(64), 10));
    let mut next_files = HashMap::new();
    next_files.insert("index.html".to_string(), html_file(sha256_hex(&next_html), next_html.len()));
    let mut open_files = HashMap::new();
    open_files.insert("index.html".to_string(), html_file(sha256_hex(&open_html), open_html.len()));
    open_files.insert(
        "style.css".to_string(),
        ManifestFile {
            sha256: sha256_hex(&style_css),
            bytes: style_css.len(),
            content_type: "text/css; charset=utf-8".to_string(),
            immutable: false,
        },
    );
    open_files.insert("huge.bin".to_string(), html_file("f".repeat(64), 11 * 1024 * 1024));

    let mut closed = site_record("site-closed", "stille-side", false, None);
    closed.db_live = Some(static_deployment("db:ver-live", closed_files));
    closed
        .db_previews
        .insert("ver-next".to_string(), static_deployment("db:ver-next", next_files));
    let mut open = site_record("site-open", "aaben-side", true, Some(sha256_hex(b"open-pass")));
    open.db_live = Some(static_deployment("db:ver-open", open_files));
    let app_link = site_record("site-app", "lenke-app", false, Some(sha256_hex(b"app-link-pass")));
    let mut down = site_record("site-down", "nede-side", false, None);
    down.taken_down = true;
    down.db_live = Some(static_deployment("db:ver-down", HashMap::new()));

    let snapshot = EdgeSnapshot {
        hosts_domain: "qorpera.site".to_string(),
        hosts_enabled: true,
        public_enabled: true,
        domains_enabled: true,
        sites: vec![closed, open, app_link, down],
        ..Default::default()
    };

    let auth = Arc::new(MemoryAuthBackend::default());
    auth.insert_site_file("site-closed", "ver-live", "index.html", live_html.clone());
    auth.insert_site_file("site-closed", "ver-live", "404.html", missing_html.clone());
    auth.insert_site_file("site-closed", "ver-live", "bad.html", bad_served.clone());
    auth.insert_site_file("site-closed", "ver-live", "short.html", short_html.clone());
    auth.insert_site_file("site-closed", "ver-next", "index.html", next_html.clone());
    auth.insert_site_file("site-open", "ver-open", "index.html", open_html.clone());
    auth.insert_site_file("site-open", "ver-open", "style.css", style_css.clone());
    auth.insert_member_pass(
        "stille-side.qorpera.site",
        "member-pass-1",
        RedeemedMemberPass {
            site_id: "site-closed".to_string(),
            version_id: None,
            password_version: 4,
            max_age: 43200,
        },
    );
    auth.insert_ticket(
        "stille-side--next.qorpera.site",
        "ticket-1",
        RedeemedTicket {
            site_id: "site-closed".to_string(),
            version_id: "ver-next".to_string(),
            password_version: 4,
            max_age: 43200,
        },
    );

    let mut cfg = test_config(None);
    cfg.auth_backend = Some(Arc::clone(&auth) as Arc<dyn EdgeAuthBackend>);
    let state = Arc::new(RouterState::new(Arc::clone(&blobs), snapshot, &cfg));
    let bound = BoundServers::bind(&cfg, state).await.unwrap();
    let pub_addr = bound.public_addr;
    let (_p, _i) = bound.spawn();

    let (st, hdrs, body) = http_call(pub_addr, get("stille-side.qorpera.site", "/", &[])).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    let page = String::from_utf8(body.to_vec()).unwrap();
    assert!(page.contains("<h1>Not live yet</h1>"));
    assert!(!page.contains("<form") && !page.contains("password"));
    assert_eq!(hdrs.get("x-robots-tag").unwrap(), "noindex, nofollow, noarchive");
    assert_eq!(hdrs.get("cache-control").unwrap(), "no-store, no-transform");
    assert_eq!(hdrs.get("vary").unwrap(), "Accept-Language");
    let english_page = body.clone();

    let (st, _, body) = http_call(
        pub_addr,
        get("stille-side.qorpera.site", "/about", &[("accept-language", "da-DK,da;q=0.9,en;q=0.8")]),
    )
    .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    let page = String::from_utf8(body.to_vec()).unwrap();
    assert!(page.contains("<h1>Ikke live endnu</h1>") && page.contains("lang=\"da\""));
    let (_, _, body) = http_call(
        pub_addr,
        get("stille-side.qorpera.site", "/", &[("accept-language", "en;q=0.9, da;q=0.5")]),
    )
    .await;
    assert_eq!(body, english_page);

    let (st, _, body) = http_call(pub_addr, get("ingen-side.qorpera.site", "/", &[])).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    assert_eq!(body, english_page);
    let (st, _, body) = http_call(pub_addr, get("ingen-side--next.qorpera.site", "/", &[])).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    assert_eq!(body, english_page);

    let (st, _, body) = http_call(
        pub_addr,
        Request::builder()
            .method("POST")
            .uri("/.qorpera/unlock")
            .header("host", "stille-side.qorpera.site")
            .header("sec-fetch-site", "same-origin")
            .header("origin", "https://stille-side.qorpera.site")
            .body(Full::new(Bytes::from("password=anything-at-all&next=/")))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    assert_eq!(body, english_page);

    let (st, _, body) = http_call(pub_addr, get("stille-side.qorpera.site", "/robots.txt", &[])).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body, Bytes::from_static(b"User-agent: *\nDisallow: /\n"));

    let member_post = |pass: &str| {
        Request::builder()
            .method("POST")
            .uri("/__qorpera/member")
            .header("host", "stille-side.qorpera.site")
            .header("origin", "https://app.qorpera.com")
            .header("sec-fetch-site", "cross-site")
            .body(Full::new(Bytes::from(format!("pass={pass}&path=/"))))
            .unwrap()
    };
    let (st, _, body) = http_call(pub_addr, member_post("not-a-pass")).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    assert_eq!(body, english_page);
    let (st, hdrs, _) = http_call(pub_addr, member_post("member-pass-1")).await;
    assert_eq!(st, StatusCode::SEE_OTHER);
    let member_cookie = first_cookie(&hdrs);

    assert_eq!(auth.file_fetches(), 0);
    let (st, hdrs, body) = http_call(
        pub_addr,
        get("stille-side.qorpera.site", "/", &[("cookie", member_cookie.as_str())]),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body, live_html);
    assert_eq!(hdrs.get("content-type").unwrap(), "text/html; charset=utf-8");
    assert_eq!(hdrs.get("cache-control").unwrap(), "private, no-cache, no-transform");
    assert_eq!(auth.file_fetches(), 1);
    assert!(blobs.exists(&sha256_hex(&live_html)).await.unwrap());
    let (st, _, body) = http_call(
        pub_addr,
        get("stille-side.qorpera.site", "/index.html", &[("cookie", member_cookie.as_str())]),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body, live_html);
    assert_eq!(auth.file_fetches(), 1);

    let (st, _, body) = http_call(
        pub_addr,
        get("stille-side.qorpera.site", "/no-such-page", &[("cookie", member_cookie.as_str())]),
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    assert_eq!(body, missing_html);

    for path in ["/bad.html", "/short.html", "/gone.html"] {
        let (st, _, body) = http_call(
            pub_addr,
            get("stille-side.qorpera.site", path, &[("cookie", member_cookie.as_str())]),
        )
        .await;
        assert_eq!(st, StatusCode::SERVICE_UNAVAILABLE, "{path}");
        assert_eq!(body, Bytes::from_static(b"blob unavailable"), "{path}");
    }
    assert!(!blobs.exists(&sha256_hex(&bad_real)).await.unwrap());
    assert!(!blobs.exists(&sha256_hex(&bad_served)).await.unwrap());
    assert!(!blobs.exists(&sha256_hex(&short_html)).await.unwrap());

    let before_bump = format!(
        "{SITE_SESSION_COOKIE}={}",
        sign_session_cookie(b"secret-cookie-key-32-bytes-minimum!", "site-closed", "site", 3, u64::MAX / 2)
    );
    let (st, _, body) = http_call(
        pub_addr,
        get("stille-side.qorpera.site", "/", &[("cookie", before_bump.as_str())]),
    )
    .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    assert_eq!(body, english_page);

    let (st, _, body) = http_call(pub_addr, get("stille-side--next.qorpera.site", "/", &[])).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    assert_eq!(body, english_page);
    let (st, _, body) = http_call(
        pub_addr,
        get("stille-side--next.qorpera.site", "/.qorpera/enter?t=wrong-ticket", &[]),
    )
    .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    assert_eq!(body, english_page);
    let (st, hdrs, _) = http_call(
        pub_addr,
        get("stille-side--next.qorpera.site", "/.qorpera/enter?t=ticket-1", &[]),
    )
    .await;
    assert_eq!(st, StatusCode::SEE_OTHER);
    let preview_cookie = first_cookie(&hdrs);
    let (st, _, body) = http_call(
        pub_addr,
        get("stille-side--next.qorpera.site", "/", &[("cookie", preview_cookie.as_str())]),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let html = String::from_utf8(body.to_vec()).unwrap();
    assert!(html.starts_with("<html><body>stored-next</body></html>"));
    assert!(html.contains("data-qorpera-preview=\"1\""));

    let (st, hdrs, body) = http_call(pub_addr, get("aaben-side.qorpera.site", "/", &[])).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body, open_html);
    assert_eq!(hdrs.get("cache-control").unwrap(), "public, max-age=0, must-revalidate");
    assert!(hdrs.get("x-robots-tag").is_none());

    auth.set_file_delay(Duration::from_millis(150));
    let fetches_before = auth.file_fetches();
    let mut readers = Vec::new();
    for _ in 0..8 {
        readers.push(tokio::spawn(async move {
            http_call(pub_addr, get("aaben-side.qorpera.site", "/style.css", &[])).await
        }));
    }
    for reader in readers {
        let (st, _, body) = reader.await.unwrap();
        assert_eq!(st, StatusCode::OK);
        assert_eq!(body, style_css);
    }
    assert_eq!(auth.file_fetches(), fetches_before + 1);
    auth.set_file_delay(Duration::ZERO);

    let (st, _, _) = http_call(pub_addr, get("aaben-side.qorpera.site", "/huge.bin", &[])).await;
    assert_eq!(st, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(auth.file_fetches(), fetches_before + 1);

    let (st, _, body) = http_call(pub_addr, get("lenke-app.qorpera.site", "/", &[])).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    let page = String::from_utf8(body.to_vec()).unwrap();
    assert!(page.contains("Password required") && page.contains("<form"));
    let (st, _, body) = http_call(
        pub_addr,
        Request::builder()
            .method("POST")
            .uri("/.qorpera/unlock")
            .header("host", "lenke-app.qorpera.site")
            .header("sec-fetch-site", "same-origin")
            .header("origin", "https://lenke-app.qorpera.site")
            .body(Full::new(Bytes::from("password=wrong&next=/")))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    assert!(String::from_utf8(body.to_vec()).unwrap().contains("Incorrect password."));
    let (st, hdrs, _) = http_call(
        pub_addr,
        Request::builder()
            .method("POST")
            .uri("/.qorpera/unlock")
            .header("host", "lenke-app.qorpera.site")
            .header("sec-fetch-site", "same-origin")
            .header("origin", "https://lenke-app.qorpera.site")
            .body(Full::new(Bytes::from("password=app-link-pass&next=/")))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::SEE_OTHER);
    let app_cookie = first_cookie(&hdrs);
    let (st, _, _) = http_call(
        pub_addr,
        get("lenke-app.qorpera.site", "/", &[("cookie", app_cookie.as_str())]),
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND);

    let (st, _, _) = http_call(pub_addr, get("nede-side.qorpera.site", "/", &[])).await;
    assert_eq!(st, StatusCode::GONE);
}

#[tokio::test]
async fn a_snapshot_from_before_database_sites_keeps_the_password_gate() {
    let dir = tempdir().unwrap();
    let blobs = Arc::new(BlobStore::new(dir.path().to_path_buf(), 8 * 1024 * 1024, 8 * 1024 * 1024));
    let html = Bytes::from("<html><body>deployed</body></html>");
    let sha = sha256_hex(&html);
    blobs.put(&sha, html.clone(), false).await.unwrap();
    let cfg = test_config(None);
    let state = Arc::new(RouterState::new(blobs, EdgeSnapshot::default(), &cfg));
    let bound = BoundServers::bind(&cfg, state).await.unwrap();
    let pub_addr = bound.public_addr;
    let int_addr = bound.internal_addr;
    let (_p, _i) = bound.spawn();

    let old_shape = format!(
        r#"{{"hosts_domain":"qorpera.site","hosts_enabled":true,"public_enabled":true,"domains_enabled":true,
        "sites":[{{"id":"site-old","slug":"gammel-side","is_public":false,"taken_down":false,
        "password_sha256":"{}","password_version":1,
        "live_deployment":{{"id":"dep-old","kind":"static","manifest":{{"files":{{"index.html":
            {{"sha256":"{sha}","bytes":{},"content_type":"text/html; charset=utf-8"}}}}}}}},
        "preview_deployments":{{}},"primary_custom_domain":null}}],"custom_domains":[]}}"#,
        sha256_hex(b"old-pass"),
        html.len()
    );
    let (st, _, _) = http_call(
        int_addr,
        Request::builder()
            .method("POST")
            .uri("/_internal/routes/snapshot")
            .header("authorization", "Bearer secret-control-token")
            .body(Full::new(Bytes::from(old_shape)))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    let (st, _, body) = http_call(pub_addr, get("gammel-side.qorpera.site", "/", &[])).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    assert!(String::from_utf8(body.to_vec()).unwrap().contains("Password required"));
    let (st, hdrs, _) = http_call(
        pub_addr,
        Request::builder()
            .method("POST")
            .uri("/.qorpera/unlock")
            .header("host", "gammel-side.qorpera.site")
            .header("sec-fetch-site", "same-origin")
            .header("origin", "https://gammel-side.qorpera.site")
            .body(Full::new(Bytes::from("password=old-pass&next=/")))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::SEE_OTHER);
    let cookie = first_cookie(&hdrs);
    let (st, _, body) = http_call(pub_addr, get("gammel-side.qorpera.site", "/", &[("cookie", cookie.as_str())])).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body, html);
}

#[tokio::test]
async fn internal_blobs_exists_batches_and_validates_hashes() {
    let dir = tempdir().unwrap();
    let blobs = Arc::new(BlobStore::new(dir.path().to_path_buf(), 8 * 1024 * 1024, 8 * 1024 * 1024));
    let present_a = Bytes::from("hello-batch-a");
    let sha_a = sha256_hex(&present_a);
    let present_b = Bytes::from("hello-batch-b");
    let sha_b = sha256_hex(&present_b);
    let missing_c = sha256_hex(b"missing-batch-c");
    blobs.put(&sha_a, present_a, false).await.unwrap();
    blobs.put(&sha_b, present_b, false).await.unwrap();

    let cfg = test_config(None);
    let state = Arc::new(RouterState::new(blobs, EdgeSnapshot::default(), &cfg));
    let bound = BoundServers::bind(&cfg, state).await.unwrap();
    let int_addr = bound.internal_addr;
    let (_p, _i) = bound.spawn();

    let (st, _, _) = http_call(
        int_addr,
        Request::builder()
            .method("POST")
            .uri("/_internal/blobs/exists")
            .body(Full::new(Bytes::from(r#"{"hashes":[]}"#)))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);

    let req_body = serde_json::json!({
        "hashes": [sha_a, missing_c, sha_b, sha_a]
    });
    let (st, _, body) = http_call(
        int_addr,
        Request::builder()
            .method("POST")
            .uri("/_internal/blobs/exists")
            .header("authorization", "Bearer secret-control-token")
            .header("content-type", "application/json")
            .body(Full::new(Bytes::from(serde_json::to_vec(&req_body).unwrap())))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let mut existing: Vec<String> = parsed["existing"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    existing.sort();
    let mut expected = vec![sha_a.clone(), sha_b.clone()];
    expected.sort();
    assert_eq!(existing, expected);

    let (st, _, body) = http_call(
        int_addr,
        Request::builder()
            .method("POST")
            .uri("/_internal/blobs/exists")
            .header("authorization", "Bearer secret-control-token")
            .body(Full::new(Bytes::from(r#"{"hashes":[]}"#)))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(parsed["existing"].as_array().unwrap().len(), 0);

    let (st, _, _) = http_call(
        int_addr,
        Request::builder()
            .method("POST")
            .uri("/_internal/blobs/exists")
            .header("authorization", "Bearer secret-control-token")
            .body(Full::new(Bytes::from(r#"{"hashes":["not-a-sha256"]}"#)))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);

    let too_many: Vec<String> = (0..1025).map(|_| sha_a.clone()).collect();
    let (st, _, _) = http_call(
        int_addr,
        Request::builder()
            .method("POST")
            .uri("/_internal/blobs/exists")
            .header("authorization", "Bearer secret-control-token")
            .body(Full::new(Bytes::from(
                serde_json::to_vec(&serde_json::json!({ "hashes": too_many })).unwrap(),
            )))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);

    let (st, _, _) = http_call(
        int_addr,
        Request::builder()
            .method("POST")
            .uri("/_internal/blobs/exists")
            .header("authorization", "Bearer secret-control-token")
            .body(Full::new(Bytes::from(vec![b' '; 260 * 1024])))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn a_pointed_domain_gets_a_certificate_and_an_almost_ready_page_until_verified() {
    let dns_server = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let dns_addr = dns_server.local_addr().unwrap();
    tokio::spawn(async move {
        let mut buf = [0u8; 512];
        loop {
            let Ok((n, peer)) = dns_server.recv_from(&mut buf).await else {
                break;
            };
            if n < 12 {
                continue;
            }
            let mut offset = 12usize;
            let mut labels = Vec::new();
            while offset < n && buf[offset] != 0 {
                let len = buf[offset] as usize;
                offset += 1;
                labels.push(String::from_utf8_lossy(&buf[offset..offset + len]).into_owned());
                offset += len;
            }
            let qname = labels.join(".");
            let after_name = offset + 1;
            let qtype = u16::from_be_bytes([buf[after_name], buf[after_name + 1]]);
            let rdata: Option<(u16, Vec<u8>)> = match (qname.as_str(), qtype) {
                ("namah.dk", DNS_TYPE_A) => Some((DNS_TYPE_A, vec![93, 164, 62, 162])),
                ("namah.dk", DNS_TYPE_TXT) => {
                    let txt = b"qorpera-verify=tok-namah";
                    let mut v = vec![txt.len() as u8];
                    v.extend_from_slice(txt);
                    Some((DNS_TYPE_TXT, v))
                }
                _ => None,
            };
            let mut resp = Vec::new();
            resp.extend_from_slice(&buf[0..2]);
            resp.extend_from_slice(&0x8180u16.to_be_bytes());
            resp.extend_from_slice(&1u16.to_be_bytes());
            resp.extend_from_slice(&(if rdata.is_some() { 1u16 } else { 0u16 }).to_be_bytes());
            resp.extend_from_slice(&0u16.to_be_bytes());
            resp.extend_from_slice(&0u16.to_be_bytes());
            resp.extend_from_slice(&buf[12..after_name + 4]);
            if let Some((rt, data)) = rdata {
                resp.extend_from_slice(&[0xC0, 0x0C]);
                resp.extend_from_slice(&rt.to_be_bytes());
                resp.extend_from_slice(&1u16.to_be_bytes());
                resp.extend_from_slice(&60u32.to_be_bytes());
                resp.extend_from_slice(&(data.len() as u16).to_be_bytes());
                resp.extend_from_slice(&data);
            }
            let _ = dns_server.send_to(&resp, peer).await;
        }
    });

    let dir = tempdir().unwrap();
    let blobs = Arc::new(BlobStore::new(dir.path().to_path_buf(), 8 * 1024 * 1024, 8 * 1024 * 1024));
    let live_html = Bytes::from("<html><body>namah-live</body></html>");
    let live_sha = sha256_hex(&live_html);
    blobs.put(&live_sha, live_html.clone(), false).await.unwrap();
    let mut files = HashMap::new();
    files.insert("index.html".to_string(), html_file(live_sha, live_html.len()));
    let mut site = site_record("site-namah", "namah", true, None);
    site.live_deployment = Some(static_deployment("dep-namah", files));
    let domain = |id: &str, hostname: &str, token: &str| CustomDomainRecord {
        id: id.to_string(),
        site_id: "site-namah".to_string(),
        hostname: hostname.to_string(),
        is_apex: true,
        is_primary: false,
        status: DomainStatus::PendingDns,
        verification_token: token.to_string(),
        last_checked_at: None,
        consecutive_misses: 0,
    };
    let snapshot = EdgeSnapshot {
        hosts_domain: "qorpera.site".to_string(),
        hosts_enabled: true,
        public_enabled: true,
        domains_enabled: true,
        edge_ipv4: Some("93.164.62.162".to_string()),
        sites: vec![site],
        custom_domains: vec![
            domain("dom-namah", "namah.dk", "tok-namah"),
            domain("dom-elsewhere", "elsewhere.dk", "tok-elsewhere"),
        ],
        ..Default::default()
    };

    let mut cfg = test_config(None);
    cfg.dns_servers = vec![dns_addr];
    let state = Arc::new(RouterState::new(blobs, snapshot, &cfg));
    let bound = BoundServers::bind(&cfg, state).await.unwrap();
    let pub_addr = bound.public_addr;
    let int_addr = bound.internal_addr;
    let (_p, _i) = bound.spawn();

    let tls_allow = |domain: &str| {
        Request::builder()
            .method("GET")
            .uri(format!("/_internal/tls/allow?domain={domain}"))
            .body(Full::new(Bytes::new()))
            .unwrap()
    };
    assert_eq!(http_call(int_addr, tls_allow("namah.dk")).await.0, StatusCode::FORBIDDEN);

    let (st, _, body) = http_call(
        int_addr,
        Request::builder()
            .method("POST")
            .uri("/_internal/domains/verify")
            .header("authorization", "Bearer secret-control-token")
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let checked: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let reasons: HashMap<String, (String, bool)> = checked["checked"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| {
            (
                o["hostname"].as_str().unwrap().to_string(),
                (o["reason"].as_str().unwrap().to_string(), o["routing_ok"].as_bool().unwrap()),
            )
        })
        .collect();
    assert_eq!(
        reasons["namah.dk"],
        ("txt_verification_missing txt_on_wrong_name".to_string(), true)
    );
    assert_eq!(reasons["elsewhere.dk"], ("dns_routing_and_txt_missing".to_string(), false));

    assert_eq!(http_call(int_addr, tls_allow("namah.dk")).await.0, StatusCode::OK);
    assert_eq!(http_call(int_addr, tls_allow("elsewhere.dk")).await.0, StatusCode::FORBIDDEN);
    assert_eq!(http_call(int_addr, tls_allow("stranger.dk")).await.0, StatusCode::FORBIDDEN);

    let (st, hdrs, body) = http_call(pub_addr, get("namah.dk", "/", &[])).await;
    assert_eq!(st, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(hdrs.get("retry-after").unwrap(), "60");
    assert_eq!(hdrs.get("cache-control").unwrap(), "no-store, no-transform");
    assert_eq!(hdrs.get("vary").unwrap(), "Accept-Language");
    assert_eq!(hdrs.get("x-content-type-options").unwrap(), "nosniff");
    assert_eq!(hdrs.get("x-robots-tag").unwrap(), "noindex, nofollow, noarchive");
    let page = String::from_utf8(body.to_vec()).unwrap();
    assert!(page.contains("<h1>namah.dk is almost ready</h1>"));
    assert!(page.contains("Made with Qorpera"));
    assert!(!page.contains("namah-live"));

    let (st, _, body) = http_call(
        pub_addr,
        get("namah.dk", "/index.html", &[("accept-language", "da-DK,da;q=0.9,en;q=0.8")]),
    )
    .await;
    assert_eq!(st, StatusCode::SERVICE_UNAVAILABLE);
    let page = String::from_utf8(body.to_vec()).unwrap();
    assert!(page.contains("<h1>namah.dk er næsten klar</h1>") && page.contains("lang=\"da\""));
    assert!(page.contains("Lavet med Qorpera") && !page.contains("namah-live"));

    let (st, _, body) = http_call(pub_addr, get("elsewhere.dk", "/", &[])).await;
    assert_eq!(st, StatusCode::SERVICE_UNAVAILABLE);
    assert!(String::from_utf8(body.to_vec()).unwrap().contains("elsewhere.dk is almost ready"));

    let (st, hdrs, body) = http_call(pub_addr, get("stranger.dk", "/", &[])).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    assert!(hdrs.get("retry-after").is_none());
    assert!(!String::from_utf8(body.to_vec()).unwrap().contains("almost ready"));
}

#[tokio::test]
async fn surface_preview_slots_enforce_version_isolation_inspector_caching_and_sw_block() {
    let dir = tempdir().unwrap();
    let blobs = Arc::new(BlobStore::new(dir.path().to_path_buf(), 8 * 1024 * 1024, 8 * 1024 * 1024));

    let v1_html = Bytes::from("<!doctype html><html><body><h1>Preview V1</h1></body></html>");
    let v2_html = Bytes::from("<!doctype html><html><body><h1>Preview V2</h1></body></html>");
    let chunk_js = Bytes::from("export const chunk = 'cached-surface-preview-asset';\n".repeat(40));
    let v1_hero = Bytes::from_static(b"PNG-V1-HERO-IMAGE-BYTES");
    let v2_hero = Bytes::from_static(b"PNG-V2-HERO-IMAGE-BYTES-UPDATED");
    let v1_date_photo = Bytes::from_static(b"JPG-DATE-V1");
    let v1_sha = sha256_hex(&v1_html);
    let v2_sha = sha256_hex(&v2_html);
    let chunk_sha = sha256_hex(&chunk_js);
    let v1_hero_sha = sha256_hex(&v1_hero);
    let v2_hero_sha = sha256_hex(&v2_hero);
    let v1_date_photo_sha = sha256_hex(&v1_date_photo);
    blobs.put(&v1_sha, v1_html.clone(), true).await.unwrap();
    blobs.put(&v2_sha, v2_html.clone(), true).await.unwrap();
    blobs.put(&chunk_sha, chunk_js.clone(), true).await.unwrap();
    blobs.put(&v1_hero_sha, v1_hero.clone(), false).await.unwrap();
    blobs.put(&v2_hero_sha, v2_hero.clone(), false).await.unwrap();
    blobs.put(&v1_date_photo_sha, v1_date_photo.clone(), false).await.unwrap();

    let mut v1_files = HashMap::new();
    v1_files.insert("index.html".to_string(), html_file(v1_sha.clone(), v1_html.len()));
    v1_files.insert(
        "assets/app-a1b2c3d4.js".to_string(),
        ManifestFile {
            sha256: chunk_sha.clone(),
            bytes: chunk_js.len(),
            content_type: "application/javascript; charset=utf-8".to_string(),
            immutable: true,
        },
    );
    v1_files.insert(
        "assets/hero.png".to_string(),
        ManifestFile {
            sha256: v1_hero_sha.clone(),
            bytes: v1_hero.len(),
            content_type: "image/png".to_string(),
            immutable: true,
        },
    );
    v1_files.insert(
        "photo-20240115.jpg".to_string(),
        ManifestFile {
            sha256: v1_date_photo_sha.clone(),
            bytes: v1_date_photo.len(),
            content_type: "image/jpeg".to_string(),
            immutable: true,
        },
    );
    let mut v2_files = HashMap::new();
    v2_files.insert("index.html".to_string(), html_file(v2_sha.clone(), v2_html.len()));
    v2_files.insert(
        "assets/app-a1b2c3d4.js".to_string(),
        ManifestFile {
            sha256: chunk_sha.clone(),
            bytes: chunk_js.len(),
            content_type: "application/javascript; charset=utf-8".to_string(),
            immutable: true,
        },
    );
    v2_files.insert(
        "assets/hero.png".to_string(),
        ManifestFile {
            sha256: v2_hero_sha.clone(),
            bytes: v2_hero.len(),
            content_type: "image/png".to_string(),
            immutable: true,
        },
    );

    let mut v1_dep = static_deployment("dep-v1", v1_files);
    v1_dep.manifest.headers.push(HeaderRule {
        path_prefix: "/".to_string(),
        headers: HashMap::from([
            ("x-frame-options".to_string(), "DENY".to_string()),
            ("content-security-policy".to_string(), "frame-ancestors 'none'".to_string()),
        ]),
    });
    let v2_dep = static_deployment("dep-v2", v2_files);

    let mut site = site_record("site-surf", "atelier-nord", true, Some(sha256_hex(b"pw")));
    site.preview_deployments.insert("ver-1".to_string(), v1_dep);
    site.preview_deployments.insert("ver-2".to_string(), v2_dep);

    let snapshot = EdgeSnapshot {
        hosts_domain: "qorpera.site".to_string(),
        hosts_enabled: true,
        public_enabled: true,
        domains_enabled: true,
        sites: vec![site],
        ..Default::default()
    };

    let auth = Arc::new(MemoryAuthBackend::default());
    auth.insert_member_pass(
        "atelier-nord--p0.qorpera.site",
        "pass-v1",
        RedeemedMemberPass {
            site_id: "site-surf".to_string(),
            version_id: Some("ver-1".to_string()),
            password_version: 4,
            max_age: 43200,
        },
    );
    auth.insert_member_pass(
        "atelier-nord--p1.qorpera.site",
        "pass-v2",
        RedeemedMemberPass {
            site_id: "site-surf".to_string(),
            version_id: Some("ver-2".to_string()),
            password_version: 4,
            max_age: 43200,
        },
    );
    auth.insert_member_pass(
        "atelier-nord--p0.qorpera.site",
        "pass-v2-p0",
        RedeemedMemberPass {
            site_id: "site-surf".to_string(),
            version_id: Some("ver-2".to_string()),
            password_version: 4,
            max_age: 43200,
        },
    );
    auth.insert_member_pass(
        "atelier-nord--p0.qorpera.site",
        "pass-missing-version",
        RedeemedMemberPass {
            site_id: "site-surf".to_string(),
            version_id: None,
            password_version: 4,
            max_age: 43200,
        },
    );

    let mut cfg = test_config(None);
    cfg.auth_backend = Some(Arc::clone(&auth) as Arc<dyn EdgeAuthBackend>);
    let state = Arc::new(RouterState::new(blobs, snapshot, &cfg));
    let bound = BoundServers::bind(&cfg, state).await.unwrap();
    let pub_addr = bound.public_addr;
    let int_addr = bound.internal_addr;
    let (_p, _i) = bound.spawn();

    let tls_allow = |domain: &str| {
        Request::builder()
            .method("GET")
            .uri(format!("/_internal/tls/allow?domain={domain}"))
            .body(Full::new(Bytes::new()))
            .unwrap()
    };
    assert_eq!(http_call(int_addr, tls_allow("atelier-nord--p0.qorpera.site")).await.0, StatusCode::OK);
    assert_eq!(http_call(int_addr, tls_allow("atelier-nord--p7.qorpera.site")).await.0, StatusCode::OK);
    assert_eq!(http_call(int_addr, tls_allow("atelier-nord--p8.qorpera.site")).await.0, StatusCode::FORBIDDEN);

    let (st, _, body) = http_call(pub_addr, get("atelier-nord--p0.qorpera.site", "/", &[])).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    let unauth = String::from_utf8(body.to_vec()).unwrap();
    assert!(unauth.contains("Not live yet") && !unauth.contains("<form"));

    let (st, _, _) = http_call(pub_addr, get("atelier-nord--p0.qorpera.site", "/__qorpera/inspector.js", &[])).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);

    let post_pass = |host: &str, pass: &str| {
        Request::builder()
            .method("POST")
            .uri("/__qorpera/member")
            .header("host", host)
            .header("origin", "https://app.qorpera.com")
            .header("sec-fetch-site", "cross-site")
            .body(Full::new(Bytes::from(format!("pass={pass}&path=/"))))
            .unwrap()
    };

    assert_eq!(
        http_call(pub_addr, post_pass("atelier-nord--p0.qorpera.site", "pass-missing-version")).await.0,
        StatusCode::UNAUTHORIZED
    );

    let (st, hdrs, _) = http_call(pub_addr, post_pass("atelier-nord--p0.qorpera.site", "pass-v1")).await;
    assert_eq!(st, StatusCode::SEE_OTHER);
    let set_cookie = hdrs.get("set-cookie").unwrap().to_str().unwrap();
    assert!(set_cookie.contains("SameSite=None") && set_cookie.contains("Partitioned"));
    assert_eq!(
        hdrs.get("content-security-policy").unwrap(),
        "frame-ancestors 'self' https://app.qorpera.com"
    );
    let cookie_p0 = first_cookie(&hdrs);

    let (st, hdrs, _) = http_call(pub_addr, post_pass("atelier-nord--p1.qorpera.site", "pass-v2")).await;
    assert_eq!(st, StatusCode::SEE_OTHER);
    let cookie_p1 = first_cookie(&hdrs);

    let (st, _, _) = http_call(
        pub_addr,
        get("atelier-nord--p1.qorpera.site", "/", &[("cookie", cookie_p0.as_str())]),
    )
    .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);

    let (st, hdrs, body) = http_call(
        pub_addr,
        get("atelier-nord--p0.qorpera.site", "/", &[("cookie", cookie_p0.as_str())]),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let html_v1 = String::from_utf8(body.to_vec()).unwrap();
    assert!(html_v1.contains("Preview V1"));
    assert!(html_v1.contains("<script src=\"/__qorpera/inspector.js\" defer></script>"));
    assert_eq!(hdrs.get("cache-control").unwrap(), "private, no-cache, no-transform");
    assert_eq!(hdrs.get("x-robots-tag").unwrap(), "noindex, nofollow, noarchive");
    assert!(hdrs.get("x-frame-options").is_none());
    assert_eq!(
        hdrs.get("content-security-policy").unwrap(),
        "frame-ancestors 'self' https://app.qorpera.com"
    );

    let (st, _, body) = http_call(
        pub_addr,
        get("atelier-nord--p1.qorpera.site", "/", &[("cookie", cookie_p1.as_str())]),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert!(String::from_utf8(body.to_vec()).unwrap().contains("Preview V2"));

    let (st, hdrs, body) = http_call(
        pub_addr,
        get(
            "atelier-nord--p0.qorpera.site",
            "/__qorpera/inspector.js",
            &[("cookie", cookie_p0.as_str())],
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(hdrs.get("content-type").unwrap(), "text/javascript; charset=utf-8");
    let script = String::from_utf8(body.to_vec()).unwrap();
    assert!(script.contains("qorpera-inspector-pick") && script.contains("https://app.qorpera.com"));

    let (st, hdrs, br_body) = http_call(
        pub_addr,
        get(
            "atelier-nord--p0.qorpera.site",
            "/assets/app-a1b2c3d4.js",
            &[("cookie", cookie_p0.as_str()), ("accept-encoding", "br, gzip")],
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(hdrs.get("cache-control").unwrap(), "private, max-age=31536000, immutable");
    assert_eq!(hdrs.get("content-encoding").unwrap(), "br");
    assert!(br_body.len() < chunk_js.len());

    let (st, _, _) = http_call(
        pub_addr,
        get(
            "atelier-nord--p0.qorpera.site",
            "/assets/app-a1b2c3d4.js",
            &[("cookie", cookie_p0.as_str()), ("if-none-match", &format!("\"{chunk_sha}\""))],
        ),
    )
    .await;
    assert_eq!(st, StatusCode::NOT_MODIFIED);

    let (st, _, _) = http_call(
        pub_addr,
        get(
            "atelier-nord--p0.qorpera.site",
            "/sw.js",
            &[("cookie", cookie_p0.as_str()), ("service-worker", "script")],
        ),
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND);

    let (st, hdrs, body) = http_call(
        pub_addr,
        get(
            "atelier-nord--p0.qorpera.site",
            "/assets/hero.png",
            &[("cookie", cookie_p0.as_str())],
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body, v1_hero);
    assert_eq!(hdrs.get("cache-control").unwrap(), "private, no-cache, no-transform");
    assert_eq!(hdrs.get("etag").unwrap(), &format!("\"{v1_hero_sha}\""));

    let (st, hdrs, _) = http_call(
        pub_addr,
        get(
            "atelier-nord--p0.qorpera.site",
            "/photo-20240115.jpg",
            &[("cookie", cookie_p0.as_str())],
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(hdrs.get("cache-control").unwrap(), "private, no-cache, no-transform");

    let (st, hdrs, _) = http_call(pub_addr, post_pass("atelier-nord--p0.qorpera.site", "pass-v2-p0")).await;
    assert_eq!(st, StatusCode::SEE_OTHER);
    let cookie_p0_v2 = first_cookie(&hdrs);

    let (st, hdrs, body) = http_call(
        pub_addr,
        get(
            "atelier-nord--p0.qorpera.site",
            "/assets/hero.png",
            &[
                ("cookie", cookie_p0_v2.as_str()),
                ("if-none-match", &format!("\"{v1_hero_sha}\"")),
            ],
        ),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body, v2_hero);
    assert_eq!(hdrs.get("cache-control").unwrap(), "private, no-cache, no-transform");
    assert_eq!(hdrs.get("etag").unwrap(), &format!("\"{v2_hero_sha}\""));
}
