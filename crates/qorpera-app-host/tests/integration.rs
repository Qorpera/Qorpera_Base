use bytes::Bytes;
use http::{Method, Request, StatusCode};
use http_body_util::{BodyExt, Full};
use hyper_util::rt::TokioIo;
use qorpera_app_host::driver::{AppRuntimeDriver, LocalProcessDriver, LxdAppDriver};
use qorpera_app_host::lifecycle::{AppLifecycleManager, DeployRequest, InstanceState, WakeMode};
use qorpera_app_host::logs::LogRingBuffer;
use qorpera_app_host::reaper::reap_once_with_router;
use qorpera_app_host::server::AppHostServer;
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::net::{TcpListener, TcpStream};

async fn http_call(addr: SocketAddr, req: Request<Full<Bytes>>) -> (StatusCode, Bytes) {
    let stream = TcpStream::connect(addr).await.unwrap();
    let io = TokioIo::new(stream);
    let (mut sender, conn) = hyper::client::conn::http1::handshake(io).await.unwrap();
    tokio::spawn(async move {
        let _ = conn.await;
    });
    let res = sender.send_request(req).await.unwrap();
    let status = res.status();
    let body = res.into_body().collect().await.unwrap().to_bytes();
    (status, body)
}

fn test_http_server_bin() -> &'static PathBuf {
    static BIN: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    BIN.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!(
            "qorpera-app-host-test-bin-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("server.rs");
        let bin = dir.join("server");
        std::fs::write(
            &src,
            r#"use std::io::{Read, Write};
use std::net::TcpListener;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let label = args.get(1).cloned().unwrap_or_default();
    let health_status: u16 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(200);
    let port: u16 = std::env::var("PORT").unwrap().parse().unwrap();
    let greeting = std::env::var("APP_GREETING").unwrap_or_default();
    let listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
    println!("boot:{}", label);
    let _ = std::io::stdout().flush();
    for stream in listener.incoming().flatten() {
        let label = label.clone();
        let greeting = greeting.clone();
        std::thread::spawn(move || {
            let mut stream = stream;
            let mut buf = [0u8; 4096];
            let Ok(n) = stream.read(&mut buf) else { return };
            let req = String::from_utf8_lossy(&buf[..n]);
            let path = req
                .lines()
                .next()
                .and_then(|l| l.split_whitespace().nth(1))
                .unwrap_or("/");
            let (status, body) = match path {
                "/health" => (health_status, label),
                "/pid" => (200, std::process::id().to_string()),
                _ => (200, format!("{}:{}", label, greeting)),
            };
            let reason = if status == 200 { "OK" } else { "ERR" };
            let resp = format!(
                "HTTP/1.1 {} {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                status,
                reason,
                body.len(),
                body
            );
            let _ = stream.write_all(resp.as_bytes());
        });
    }
}
"#,
        )
        .unwrap();
        let rustc = std::env::var("RUSTC").unwrap_or_else(|_| "rustc".to_string());
        let status = std::process::Command::new(rustc)
            .args([src.to_str().unwrap(), "-o", bin.to_str().unwrap()])
            .status()
            .unwrap();
        assert!(status.success(), "failed to compile test http server");
        bin
    })
}

fn node_http_script(label: &str, health_status: u16) -> Vec<String> {
    vec![
        test_http_server_bin().to_string_lossy().into_owned(),
        label.to_string(),
        health_status.to_string(),
    ]
}

#[tokio::test]
async fn blue_green_deploy_rollback_on_unhealthy_two_tier_freeze_wake_and_logs() {
    let driver = Arc::new(LocalProcessDriver::new());
    let logs = Arc::new(LogRingBuffer::new(200, 64 * 1024));
    let manager = Arc::new(
        AppLifecycleManager::new(
            driver,
            logs,
            Duration::from_secs(4),
            Duration::from_millis(50),
        )
        .with_deep_hibernate_delay(Some(Duration::from_secs(600))),
    );
    let bind_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0);
    let server = AppHostServer::bind(bind_addr, Arc::clone(&manager), "app-secret".to_string())
        .await
        .unwrap();
    let addr = server.addr;
    let _handle = server.spawn();

    let mut env1 = HashMap::new();
    env1.insert("APP_GREETING".to_string(), "hej-v1".to_string());
    let deploy_v1 = DeployRequest {
        deployment_id: "dep-v1".to_string(),
        site_id: "site-shop".to_string(),
        oci_image_ref: None,
        command: Some(node_http_script("v1", 200)),
        health_path: "/health".to_string(),
        idle_timeout_sec: 60,
        memory_mb: 256,
        vcpu_limit: 1.0,
        pids_limit: 128,
        env: env1,
    };

    let (st, body) = http_call(
        addr,
        Request::builder()
            .method("POST")
            .uri("/_internal/apps/deploy")
            .header("authorization", "Bearer app-secret")
            .body(Full::new(Bytes::from(serde_json::to_vec(&deploy_v1).unwrap())))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let v1_json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let v1_upstream: SocketAddr = v1_json["upstream_addr"].as_str().unwrap().parse().unwrap();

    let (app_st, app_body) = http_call(
        v1_upstream,
        Request::builder()
            .method("GET")
            .uri("/")
            .header("host", v1_upstream.to_string())
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(app_st, StatusCode::OK);
    assert_eq!(app_body, Bytes::from_static(b"v1:hej-v1"));

    let mut env2 = HashMap::new();
    env2.insert("APP_GREETING".to_string(), "hej-v2".to_string());
    let deploy_v2 = DeployRequest {
        deployment_id: "dep-v2".to_string(),
        site_id: "site-shop".to_string(),
        oci_image_ref: None,
        command: Some(node_http_script("v2", 200)),
        health_path: "/health".to_string(),
        idle_timeout_sec: 60,
        memory_mb: 256,
        vcpu_limit: 1.0,
        pids_limit: 128,
        env: env2,
    };

    let (st, body) = http_call(
        addr,
        Request::builder()
            .method("POST")
            .uri("/_internal/apps/deploy")
            .header("authorization", "Bearer app-secret")
            .body(Full::new(Bytes::from(serde_json::to_vec(&deploy_v2).unwrap())))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let v2_json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let v2_upstream: SocketAddr = v2_json["upstream_addr"].as_str().unwrap().parse().unwrap();
    assert_ne!(v1_upstream, v2_upstream);
    assert_eq!(manager.active_deployment_for_site("site-shop").as_deref(), Some("dep-v2"));
    let (_, pid_before_freeze) = http_call(
        v2_upstream,
        Request::builder()
            .method("GET")
            .uri("/pid")
            .header("host", v2_upstream.to_string())
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;

    let (v1_drain_st, _) = http_call(
        v1_upstream,
        Request::builder()
            .method("GET")
            .uri("/")
            .header("host", v1_upstream.to_string())
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(v1_drain_st, StatusCode::OK);
    for _ in 0..20 {
        if manager.status("dep-v1").unwrap().state == InstanceState::Stopped {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(manager.status("dep-v1").unwrap().state, InstanceState::Stopped);

    let deploy_v3_broken = DeployRequest {
        deployment_id: "dep-v3".to_string(),
        site_id: "site-shop".to_string(),
        oci_image_ref: None,
        command: Some(node_http_script("v3", 500)),
        health_path: "/health".to_string(),
        idle_timeout_sec: 60,
        memory_mb: 256,
        vcpu_limit: 1.0,
        pids_limit: 128,
        env: HashMap::new(),
    };
    let (st, _) = http_call(
        addr,
        Request::builder()
            .method("POST")
            .uri("/_internal/apps/deploy")
            .header("authorization", "Bearer app-secret")
            .body(Full::new(Bytes::from(serde_json::to_vec(&deploy_v3_broken).unwrap())))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(manager.active_deployment_for_site("site-shop").as_deref(), Some("dep-v2"));
    assert_eq!(manager.status("dep-v2").unwrap().state, InstanceState::Running);

    let always_on = DeployRequest {
        deployment_id: "dep-always".to_string(),
        site_id: "site-always".to_string(),
        oci_image_ref: None,
        command: Some(node_http_script("always", 200)),
        health_path: "/health".to_string(),
        idle_timeout_sec: 0,
        memory_mb: 256,
        vcpu_limit: 1.0,
        pids_limit: 128,
        env: HashMap::new(),
    };
    let (st, _) = http_call(
        addr,
        Request::builder()
            .method("POST")
            .uri("/_internal/apps/deploy")
            .header("authorization", "Bearer app-secret")
            .body(Full::new(Bytes::from(serde_json::to_vec(&always_on).unwrap())))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);

    let mut activity = HashMap::new();
    activity.insert("dep-v2".to_string(), 1_000);
    activity.insert("dep-always".to_string(), 1_000);
    let reaped = manager.reap_idle(&activity, 120_000).await;
    assert_eq!(reaped, vec!["dep-v2".to_string()]);
    assert_eq!(manager.status("dep-v2").unwrap().state, InstanceState::Frozen);
    assert_eq!(manager.status("dep-always").unwrap().state, InstanceState::Running);

    let wake_t0 = Instant::now();
    let mut wake_handles = Vec::new();
    for _ in 0..4 {
        wake_handles.push(tokio::spawn(async move {
            http_call(
                addr,
                Request::builder()
                    .method("POST")
                    .uri("/_internal/apps/dep-v2/wake")
                    .header("authorization", "Bearer app-secret")
                    .body(Full::new(Bytes::new()))
                    .unwrap(),
            )
            .await
        }));
    }
    let mut woken_addrs = Vec::new();
    for h in wake_handles {
        let (st, body) = h.await.unwrap();
        assert_eq!(st, StatusCode::OK);
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["wake_mode"], "unfrozen");
        woken_addrs.push(json["upstream_addr"].as_str().unwrap().to_string());
    }
    let thaw_elapsed = wake_t0.elapsed();
    assert!(
        thaw_elapsed < Duration::from_millis(250),
        "frozen wake took too long: {thaw_elapsed:?}"
    );
    assert!(woken_addrs.iter().all(|a| a == &v2_upstream.to_string()));

    let (pid_st, pid_after_unfreeze) = http_call(
        v2_upstream,
        Request::builder()
            .method("GET")
            .uri("/pid")
            .header("host", v2_upstream.to_string())
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(pid_st, StatusCode::OK);
    assert_eq!(pid_after_unfreeze, pid_before_freeze);

    let reaped_freeze_2 = manager.reap_idle(&activity, 200_000).await;
    assert_eq!(reaped_freeze_2, vec!["dep-v2".to_string()]);
    assert_eq!(manager.status("dep-v2").unwrap().state, InstanceState::Frozen);

    let deep_reaped = manager.reap_idle(&activity, 900_000).await;
    assert_eq!(deep_reaped, vec!["dep-v2".to_string()]);
    assert_eq!(manager.status("dep-v2").unwrap().state, InstanceState::Hibernated);

    let (st, cold_body) = http_call(
        addr,
        Request::builder()
            .method("POST")
            .uri("/_internal/apps/dep-v2/wake")
            .header("authorization", "Bearer app-secret")
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let cold_json: serde_json::Value = serde_json::from_slice(&cold_body).unwrap();
    assert_eq!(cold_json["wake_mode"], "cold_start");
    let cold_upstream: SocketAddr = cold_json["upstream_addr"].as_str().unwrap().parse().unwrap();
    let (_, pid_after_cold) = http_call(
        cold_upstream,
        Request::builder()
            .method("GET")
            .uri("/pid")
            .header("host", cold_upstream.to_string())
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_ne!(pid_after_cold, pid_before_freeze);

    let (st, log_body) = http_call(
        addr,
        Request::builder()
            .method("GET")
            .uri("/_internal/apps/dep-v2/logs?tail=50")
            .header("authorization", "Bearer app-secret")
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let log_json: serde_json::Value = serde_json::from_slice(&log_body).unwrap();
    let lines: Vec<&str> = log_json["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e["line"].as_str())
        .collect();
    assert!(lines.contains(&"boot:v2"));

    let _ = manager.stop_deployment("dep-v2").await;
    let _ = manager.stop_deployment("dep-always").await;
}

#[tokio::test]
async fn cold_start_wake_from_payload_and_router_idle_reaper_loop() {
    let driver = Arc::new(LocalProcessDriver::new());
    let logs = Arc::new(LogRingBuffer::new(200, 64 * 1024));
    let manager = Arc::new(
        AppLifecycleManager::new(
            driver,
            logs,
            Duration::from_secs(4),
            Duration::from_millis(20),
        )
        .with_deep_hibernate_delay(Some(Duration::from_millis(300))),
    );
    let server = AppHostServer::bind(
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        Arc::clone(&manager),
        "reaper-secret".to_string(),
    )
    .await
    .unwrap();
    let app_host_addr = server.addr;
    let _handle = server.spawn();

    let cleared: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let router_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let router_addr = router_listener.local_addr().unwrap();
    let cleared_ref = Arc::clone(&cleared);
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = router_listener.accept().await else {
                break;
            };
            let cleared_inner = Arc::clone(&cleared_ref);
            tokio::spawn(async move {
                let io = TokioIo::new(stream);
                let svc = hyper::service::service_fn(move |req: Request<hyper::body::Incoming>| {
                    let c = Arc::clone(&cleared_inner);
                    async move {
                        let path = req.uri().path().to_string();
                        if path == "/_internal/metrics/activity" {
                            let body = serde_json::json!({ "deployments": { "dep-cold": 1000u64 } }).to_string();
                            return Ok::<_, hyper::Error>(
                                http::Response::builder()
                                    .status(StatusCode::OK)
                                    .header("content-type", "application/json")
                                    .body(Full::new(Bytes::from(body)))
                                    .unwrap(),
                            );
                        }
                        if let Some(rest) = path.strip_prefix("/_internal/deployments/") {
                            if let Some(dep_id) = rest.strip_suffix("/upstream") {
                                c.lock().unwrap().push(dep_id.to_string());
                                return Ok::<_, hyper::Error>(
                                    http::Response::builder()
                                        .status(StatusCode::OK)
                                        .body(Full::new(Bytes::from_static(b"{\"ok\":true}")))
                                        .unwrap(),
                                );
                            }
                        }
                        Ok::<_, hyper::Error>(
                            http::Response::builder()
                                .status(StatusCode::NOT_FOUND)
                                .body(Full::new(Bytes::new()))
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

    let mut env = HashMap::new();
    env.insert("APP_GREETING".to_string(), "cold-ok".to_string());
    let cold_spec = DeployRequest {
        deployment_id: "dep-cold".to_string(),
        site_id: "site-cold".to_string(),
        oci_image_ref: None,
        command: Some(node_http_script("cold", 200)),
        health_path: "/health".to_string(),
        idle_timeout_sec: 1,
        memory_mb: 256,
        vcpu_limit: 1.0,
        pids_limit: 128,
        env,
    };

    let (st, body) = http_call(
        app_host_addr,
        Request::builder()
            .method("POST")
            .uri("/_internal/apps/dep-cold/wake")
            .header("authorization", "Bearer reaper-secret")
            .body(Full::new(Bytes::from(serde_json::to_vec(&cold_spec).unwrap())))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let upstream: SocketAddr = json["upstream_addr"].as_str().unwrap().parse().unwrap();

    let (app_st, app_body) = http_call(
        upstream,
        Request::builder()
            .method("GET")
            .uri("/")
            .header("host", upstream.to_string())
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(app_st, StatusCode::OK);
    assert_eq!(app_body, Bytes::from_static(b"cold:cold-ok"));

    let reaped_tier1 = reap_once_with_router(&manager, &format!("http://{router_addr}"), "reaper-secret")
        .await
        .unwrap();
    assert_eq!(reaped_tier1, vec!["dep-cold".to_string()]);
    assert_eq!(manager.status("dep-cold").unwrap().state, InstanceState::Frozen);
    assert_eq!(*cleared.lock().unwrap(), vec!["dep-cold".to_string()]);

    tokio::time::sleep(Duration::from_millis(350)).await;
    let reaped_tier2 = reap_once_with_router(&manager, &format!("http://{router_addr}"), "reaper-secret")
        .await
        .unwrap();
    assert_eq!(reaped_tier2, vec!["dep-cold".to_string()]);
    assert_eq!(manager.status("dep-cold").unwrap().state, InstanceState::Hibernated);

    let w1 = DeployRequest {
        deployment_id: "dep-shut-1".to_string(),
        site_id: "site-shut-1".to_string(),
        oci_image_ref: None,
        command: Some(node_http_script("s1", 200)),
        health_path: "/health".to_string(),
        idle_timeout_sec: 0,
        memory_mb: 256,
        vcpu_limit: 1.0,
        pids_limit: 128,
        env: HashMap::new(),
    };
    let w2 = DeployRequest {
        deployment_id: "dep-shut-2".to_string(),
        site_id: "site-shut-2".to_string(),
        ..w1.clone()
    };
    let s1 = manager.deploy_blue_green(w1).await.unwrap();
    let s2 = manager.deploy_blue_green(w2).await.unwrap();
    let a1: SocketAddr = s1.upstream_addr.unwrap().parse().unwrap();
    let a2: SocketAddr = s2.upstream_addr.unwrap().parse().unwrap();

    let (freeze_st, _) = http_call(
        app_host_addr,
        Request::builder()
            .method("POST")
            .uri("/_internal/apps/dep-shut-2/freeze")
            .header("authorization", "Bearer reaper-secret")
            .body(Full::new(Bytes::new()))
            .unwrap(),
    )
    .await;
    assert_eq!(freeze_st, StatusCode::OK);
    assert_eq!(manager.status("dep-shut-2").unwrap().state, InstanceState::Frozen);

    manager.shutdown_all().await;
    assert_eq!(manager.status("dep-shut-1").unwrap().state, InstanceState::Stopped);
    assert_eq!(manager.status("dep-shut-2").unwrap().state, InstanceState::Stopped);
    assert!(TcpStream::connect(a1).await.is_err());
    assert!(TcpStream::connect(a2).await.is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn lxd_unix_socket_atomic_create_freeze_unfreeze_port_reuse_and_fallback() {
    struct MockContainer {
        status: String,
        config: HashMap<String, String>,
        devices: HashMap<String, HashMap<String, String>>,
        server_handle: Option<tokio::task::JoinHandle<()>>,
    }

    struct MockLxdState {
        containers: HashMap<String, MockContainer>,
        create_calls: AtomicUsize,
        patch_calls: AtomicUsize,
        freeze_calls: AtomicUsize,
        unfreeze_calls: AtomicUsize,
        start_calls: AtomicUsize,
        stop_calls: AtomicUsize,
        fail_next_unfreeze: AtomicBool,
        last_create_payload: Mutex<Option<serde_json::Value>>,
    }

    fn spawn_dummy_http(port: u16) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let Ok(listener) = TcpListener::bind(("127.0.0.1", port)).await else {
                return;
            };
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let io = TokioIo::new(stream);
                    let svc = hyper::service::service_fn(|_req: Request<hyper::body::Incoming>| async {
                        Ok::<_, hyper::Error>(
                            http::Response::builder()
                                .status(StatusCode::OK)
                                .body(Full::new(Bytes::from_static(b"lxd-ok")))
                                .unwrap(),
                        )
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(io, svc)
                        .await;
                });
            }
        })
    }

    let state = Arc::new(Mutex::new(MockLxdState {
        containers: HashMap::new(),
        create_calls: AtomicUsize::new(0),
        patch_calls: AtomicUsize::new(0),
        freeze_calls: AtomicUsize::new(0),
        unfreeze_calls: AtomicUsize::new(0),
        start_calls: AtomicUsize::new(0),
        stop_calls: AtomicUsize::new(0),
        fail_next_unfreeze: AtomicBool::new(false),
        last_create_payload: Mutex::new(None),
    }));

    let sock_path = PathBuf::from(format!("/tmp/qlxd-test-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&sock_path);
    let unix_listener = tokio::net::UnixListener::bind(&sock_path).unwrap();
    let state_srv = Arc::clone(&state);
    let srv_task = tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = unix_listener.accept().await else {
                break;
            };
            let st_conn = Arc::clone(&state_srv);
            tokio::spawn(async move {
                let io = TokioIo::new(stream);
                let svc = hyper::service::service_fn(move |req: Request<hyper::body::Incoming>| {
                    let st_req = Arc::clone(&st_conn);
                    async move {
                        let method = req.method().clone();
                        let path = req.uri().path().to_string();
                        let body_bytes = req
                            .into_body()
                            .collect()
                            .await
                            .map(|c| c.to_bytes())
                            .unwrap_or_default();

                        let json_reply = |code: StatusCode, val: serde_json::Value| {
                            Ok::<_, hyper::Error>(
                                http::Response::builder()
                                    .status(code)
                                    .header("content-type", "application/json")
                                    .body(Full::new(Bytes::from(serde_json::to_vec(&val).unwrap())))
                                    .unwrap(),
                            )
                        };

                        if method == Method::GET && path.starts_with("/1.0/operations/") && path.ends_with("/wait") {
                            return json_reply(
                                StatusCode::OK,
                                serde_json::json!({
                                    "type": "sync",
                                    "status": "Success",
                                    "status_code": 200,
                                    "metadata": { "status_code": 200, "err": "" }
                                }),
                            );
                        }

                        if method == Method::POST && path == "/1.0/instances" {
                            let val: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap();
                            let name = val["name"].as_str().unwrap().to_string();
                            let config: HashMap<String, String> =
                                serde_json::from_value(val["config"].clone()).unwrap();
                            let devices: HashMap<String, HashMap<String, String>> =
                                serde_json::from_value(val["devices"].clone()).unwrap();
                            let mut guard = st_req.lock().unwrap();
                            guard.create_calls.fetch_add(1, Ordering::SeqCst);
                            *guard.last_create_payload.lock().unwrap() = Some(val);
                            guard.containers.insert(
                                name,
                                MockContainer {
                                    status: "Stopped".to_string(),
                                    config,
                                    devices,
                                    server_handle: None,
                                },
                            );
                            return json_reply(
                                StatusCode::ACCEPTED,
                                serde_json::json!({
                                    "type": "async",
                                    "status": "Operation created",
                                    "status_code": 100,
                                    "operation": "/1.0/operations/op-create-1"
                                }),
                            );
                        }

                        if let Some(rest) = path.strip_prefix("/1.0/instances/") {
                            if let Some(name) = rest.strip_suffix("/state") {
                                if method == Method::GET {
                                    let guard = st_req.lock().unwrap();
                                    return match guard.containers.get(name) {
                                        Some(c) => json_reply(
                                            StatusCode::OK,
                                            serde_json::json!({
                                                "type": "sync",
                                                "status_code": 200,
                                                "metadata": { "status": c.status }
                                            }),
                                        ),
                                        None => json_reply(
                                            StatusCode::NOT_FOUND,
                                            serde_json::json!({
                                                "type": "error",
                                                "status_code": 404,
                                                "error": "Instance not found"
                                            }),
                                        ),
                                    };
                                }
                                if method == Method::PUT {
                                    let val: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap();
                                    let action = val["action"].as_str().unwrap();
                                    let mut guard = st_req.lock().unwrap();
                                    let st_ref = &mut *guard;
                                    if action == "unfreeze" && st_ref.fail_next_unfreeze.swap(false, Ordering::SeqCst) {
                                        return json_reply(
                                            StatusCode::INTERNAL_SERVER_ERROR,
                                            serde_json::json!({
                                                "type": "error",
                                                "status_code": 500,
                                                "error": "injected unfreeze failure"
                                            }),
                                        );
                                    }
                                    let Some(c) = st_ref.containers.get_mut(name) else {
                                        return json_reply(
                                            StatusCode::NOT_FOUND,
                                            serde_json::json!({
                                                "type": "error",
                                                "status_code": 404,
                                                "error": "Instance not found"
                                            }),
                                        );
                                    };
                                    match action {
                                        "start" => {
                                            st_ref.start_calls.fetch_add(1, Ordering::SeqCst);
                                            if let Some(h) = c.server_handle.take() {
                                                h.abort();
                                            }
                                            let port: u16 = c.config["environment.PORT"].parse().unwrap();
                                            c.server_handle = Some(spawn_dummy_http(port));
                                            c.status = "Running".to_string();
                                        }
                                        "freeze" => {
                                            st_ref.freeze_calls.fetch_add(1, Ordering::SeqCst);
                                            c.status = "Frozen".to_string();
                                        }
                                        "unfreeze" => {
                                            st_ref.unfreeze_calls.fetch_add(1, Ordering::SeqCst);
                                            c.status = "Running".to_string();
                                        }
                                        "stop" => {
                                            st_ref.stop_calls.fetch_add(1, Ordering::SeqCst);
                                            if let Some(h) = c.server_handle.take() {
                                                h.abort();
                                            }
                                            c.status = "Stopped".to_string();
                                        }
                                        _ => {}
                                    }
                                    return json_reply(
                                        StatusCode::ACCEPTED,
                                        serde_json::json!({
                                            "type": "async",
                                            "status_code": 100,
                                            "operation": "/1.0/operations/op-state-1"
                                        }),
                                    );
                                }
                            } else {
                                let name = rest;
                                if method == Method::GET {
                                    let guard = st_req.lock().unwrap();
                                    return match guard.containers.get(name) {
                                        Some(c) => json_reply(
                                            StatusCode::OK,
                                            serde_json::json!({
                                                "type": "sync",
                                                "status_code": 200,
                                                "metadata": {
                                                    "status": c.status,
                                                    "config": c.config,
                                                    "devices": c.devices,
                                                }
                                            }),
                                        ),
                                        None => json_reply(
                                            StatusCode::NOT_FOUND,
                                            serde_json::json!({
                                                "type": "error",
                                                "status_code": 404,
                                                "error": "Instance not found"
                                            }),
                                        ),
                                    };
                                }
                                if method == Method::PATCH {
                                    let val: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap();
                                    let mut guard = st_req.lock().unwrap();
                                    guard.patch_calls.fetch_add(1, Ordering::SeqCst);
                                    if let Some(c) = guard.containers.get_mut(name) {
                                        if let Some(cfg) = val["config"].as_object() {
                                            for (k, v) in cfg {
                                                if let Some(s) = v.as_str() {
                                                    c.config.insert(k.clone(), s.to_string());
                                                }
                                            }
                                        }
                                        if let Some(devs) = val["devices"].as_object() {
                                            for (k, v) in devs {
                                                let map: HashMap<String, String> =
                                                    serde_json::from_value(v.clone()).unwrap();
                                                c.devices.insert(k.clone(), map);
                                            }
                                        }
                                    }
                                    return json_reply(
                                        StatusCode::OK,
                                        serde_json::json!({
                                            "type": "sync",
                                            "status_code": 200,
                                            "metadata": {}
                                        }),
                                    );
                                }
                            }
                        }

                        json_reply(
                            StatusCode::NOT_FOUND,
                            serde_json::json!({ "type": "error", "status_code": 404, "error": "not found" }),
                        )
                    }
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(io, svc)
                    .await;
            });
        }
    });

    let driver = Arc::new(LxdAppDriver::with_socket_path(
        "qorpera-web-apps".to_string(),
        "qorpera-web-apps-egress".to_string(),
        "127.0.0.1".to_string(),
        sock_path.clone(),
    ));
    let logs = Arc::new(LogRingBuffer::new(200, 64 * 1024));
    let manager = Arc::new(
        AppLifecycleManager::new(
            Arc::clone(&driver) as Arc<dyn AppRuntimeDriver>,
            logs,
            Duration::from_secs(3),
            Duration::from_millis(10),
        )
        .with_deep_hibernate_delay(Some(Duration::from_secs(600))),
    );

    let deploy = DeployRequest {
        deployment_id: "dep-lxd-1".to_string(),
        site_id: "site-lxd".to_string(),
        oci_image_ref: Some(
            "127.0.0.1:5000/qorpera-apps/demo@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                .to_string(),
        ),
        command: None,
        health_path: "/health".to_string(),
        idle_timeout_sec: 60,
        memory_mb: 512,
        vcpu_limit: 1.5,
        pids_limit: 256,
        env: HashMap::from([("NODE_ENV".to_string(), "production".to_string())]),
    };

    let deployed = manager.deploy_blue_green(deploy).await.unwrap();
    let initial_addr = deployed.upstream_addr.clone().unwrap();
    assert_eq!(deployed.state, InstanceState::Running);
    assert!(driver.is_running("dep-lxd-1").await);

    {
        let guard = state.lock().unwrap();
        assert_eq!(guard.create_calls.load(Ordering::SeqCst), 1);
        assert_eq!(guard.start_calls.load(Ordering::SeqCst), 1);
        assert_eq!(guard.patch_calls.load(Ordering::SeqCst), 0);
        let payload = guard.last_create_payload.lock().unwrap().clone().unwrap();
        assert_eq!(payload["config"]["security.nesting"], "false");
        assert_eq!(payload["config"]["security.privileged"], "false");
        assert_eq!(payload["config"]["limits.cpu"], "2");
        assert_eq!(payload["source"]["protocol"], "oci");
        assert_eq!(payload["source"]["server"], "http://127.0.0.1:5000");
        assert_eq!(payload["devices"]["http-ingress"]["type"], "proxy");
    }

    let mut activity = HashMap::new();
    activity.insert("dep-lxd-1".to_string(), 1_000);
    assert_eq!(manager.reap_idle(&activity, 120_000).await, vec!["dep-lxd-1"]);
    assert_eq!(manager.status("dep-lxd-1").unwrap().state, InstanceState::Frozen);
    assert!(!driver.is_running("dep-lxd-1").await);

    let t0 = Instant::now();
    let woken = manager.wake_detailed("dep-lxd-1", None).await.unwrap();
    assert_eq!(woken.mode, WakeMode::Unfrozen);
    assert_eq!(woken.upstream_addr, initial_addr);
    assert!(t0.elapsed() < Duration::from_millis(100));
    {
        let guard = state.lock().unwrap();
        assert_eq!(guard.freeze_calls.load(Ordering::SeqCst), 1);
        assert_eq!(guard.unfreeze_calls.load(Ordering::SeqCst), 1);
        assert_eq!(guard.create_calls.load(Ordering::SeqCst), 1);
        assert_eq!(guard.patch_calls.load(Ordering::SeqCst), 0);
    }

    assert_eq!(manager.reap_idle(&activity, 200_000).await, vec!["dep-lxd-1"]);
    assert_eq!(manager.status("dep-lxd-1").unwrap().state, InstanceState::Frozen);
    assert_eq!(manager.reap_idle(&activity, 900_000).await, vec!["dep-lxd-1"]);
    assert_eq!(manager.status("dep-lxd-1").unwrap().state, InstanceState::Hibernated);

    tokio::time::sleep(Duration::from_millis(30)).await;
    let tier2_woken = manager.wake_detailed("dep-lxd-1", None).await.unwrap();
    assert_eq!(tier2_woken.mode, WakeMode::ColdStart);
    assert_eq!(tier2_woken.upstream_addr, initial_addr);
    {
        let guard = state.lock().unwrap();
        assert_eq!(guard.create_calls.load(Ordering::SeqCst), 1);
        assert_eq!(guard.patch_calls.load(Ordering::SeqCst), 0);
        assert_eq!(guard.start_calls.load(Ordering::SeqCst), 2);
    }

    let _ = manager.freeze_deployment("dep-lxd-1").await.unwrap();
    state
        .lock()
        .unwrap()
        .fail_next_unfreeze
        .store(true, Ordering::SeqCst);
    let fallback_woken = manager.wake_detailed("dep-lxd-1", None).await.unwrap();
    assert_eq!(fallback_woken.mode, WakeMode::ColdStart);
    {
        let guard = state.lock().unwrap();
        assert_eq!(guard.start_calls.load(Ordering::SeqCst), 3);
    }

    assert_eq!(manager.reap_idle(&activity, 1_500_000).await, vec!["dep-lxd-1"]);
    assert_eq!(manager.reap_idle(&activity, 2_500_000).await, vec!["dep-lxd-1"]);
    assert_eq!(manager.status("dep-lxd-1").unwrap().state, InstanceState::Hibernated);
    tokio::time::sleep(Duration::from_millis(30)).await;
    let occupant = TcpListener::bind(&initial_addr).await.unwrap();
    let collided_woken = manager.wake_detailed("dep-lxd-1", None).await.unwrap();
    assert_eq!(collided_woken.mode, WakeMode::ColdStart);
    assert_ne!(collided_woken.upstream_addr, initial_addr);
    {
        let guard = state.lock().unwrap();
        assert_eq!(guard.patch_calls.load(Ordering::SeqCst), 1);
        assert_eq!(guard.start_calls.load(Ordering::SeqCst), 4);
    }
    drop(occupant);

    let _ = manager.stop_deployment("dep-lxd-1").await;
    srv_task.abort();
    let _ = std::fs::remove_file(&sock_path);
}
