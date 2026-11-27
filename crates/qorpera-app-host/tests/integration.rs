use bytes::Bytes;
use http::{Method, Request, StatusCode};
use http_body_util::{BodyExt, Full};
use hyper_util::rt::TokioIo;
use qorpera_app_host::driver::{
    AppInstanceHandle, AppLaunchSpec, AppRuntimeDriver, BoxFuture, LocalProcessDriver, LxdAppDriver,
};
use qorpera_app_host::lifecycle::{AppLifecycleManager, DeployRequest, InstanceState, WakeMode};
use qorpera_app_host::logs::LogRingBuffer;
use qorpera_app_host::reaper::reap_once_with_router;
use qorpera_app_host::server::AppHostServer;
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{watch, Notify};

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
        is_preview: false,
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
        is_preview: false,
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
        is_preview: false,
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
        is_preview: false,
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
        is_preview: false,
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
        is_preview: false,
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
        delete_calls: AtomicUsize,
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
        delete_calls: AtomicUsize::new(0),
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
                                if method == Method::DELETE {
                                    let mut guard = st_req.lock().unwrap();
                                    guard.delete_calls.fetch_add(1, Ordering::SeqCst);
                                    if let Some(mut c) = guard.containers.remove(name) {
                                        if let Some(h) = c.server_handle.take() {
                                            h.abort();
                                        }
                                        return json_reply(
                                            StatusCode::ACCEPTED,
                                            serde_json::json!({
                                                "type": "async",
                                                "status_code": 100,
                                                "operation": "/1.0/operations/op-delete-1"
                                            }),
                                        );
                                    }
                                    return json_reply(
                                        StatusCode::NOT_FOUND,
                                        serde_json::json!({
                                            "type": "error",
                                            "status_code": 404,
                                            "error": "Instance not found"
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
        is_preview: false,
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
    {
        let guard = state.lock().unwrap();
        assert_eq!(guard.delete_calls.load(Ordering::SeqCst), 1);
        assert!(guard.containers.is_empty());
    }
    srv_task.abort();
    let _ = std::fs::remove_file(&sock_path);
}

#[tokio::test]
async fn reaper_fails_closed_on_activity_error_and_already_running_wake_blocks_stale_freeze() {
    let driver = Arc::new(LocalProcessDriver::new());
    let logs = Arc::new(LogRingBuffer::new(200, 64 * 1024));
    let manager = Arc::new(
        AppLifecycleManager::new(
            driver,
            logs,
            Duration::from_secs(4),
            Duration::from_millis(20),
        )
        .with_deep_hibernate_delay(Some(Duration::from_secs(600))),
    );

    let deploy = DeployRequest {
        deployment_id: "dep-guard".to_string(),
        site_id: "site-guard".to_string(),
        oci_image_ref: None,
        command: Some(node_http_script("guard", 200)),
        health_path: "/health".to_string(),
        idle_timeout_sec: 1,
        memory_mb: 256,
        vcpu_limit: 1.0,
        pids_limit: 128,
        env: HashMap::new(),
        is_preview: false,
    };
    let status = manager.deploy_blue_green(deploy).await.unwrap();
    let upstream_addr = status.upstream_addr.clone().unwrap();

    let mut activity = HashMap::new();
    activity.insert("dep-guard".to_string(), 1_000u64);
    let candidates = manager.idle_candidates_with_generation(&activity, 120_000);
    assert_eq!(candidates.len(), 1);
    let (dep_id, started_at, wake_gen) = candidates[0].clone();
    let wake_outcome = manager.wake_detailed(&dep_id, None).await.unwrap();
    assert_eq!(wake_outcome.mode, WakeMode::AlreadyRunning);
    assert!(
        !manager
            .freeze_if_unchanged_generation(&dep_id, started_at, wake_gen, 120_000)
            .await
    );
    assert_eq!(
        manager.status(&dep_id).unwrap().state,
        InstanceState::Running
    );

    let activity_calls = Arc::new(AtomicUsize::new(0));
    let upstream_updates: Arc<Mutex<Vec<Option<String>>>> = Arc::new(Mutex::new(Vec::new()));
    let router_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let router_addr = router_listener.local_addr().unwrap();
    let calls_ref = Arc::clone(&activity_calls);
    let updates_ref = Arc::clone(&upstream_updates);
    let router_task = tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = router_listener.accept().await else {
                break;
            };
            let c_ref = Arc::clone(&calls_ref);
            let u_ref = Arc::clone(&updates_ref);
            tokio::spawn(async move {
                let io = TokioIo::new(stream);
                let svc = hyper::service::service_fn(move |req: Request<hyper::body::Incoming>| {
                    let c = Arc::clone(&c_ref);
                    let u = Arc::clone(&u_ref);
                    async move {
                        let path = req.uri().path().to_string();
                        let bytes = req
                            .into_body()
                            .collect()
                            .await
                            .map(|b| b.to_bytes())
                            .unwrap_or_default();
                        if path == "/_internal/metrics/activity" {
                            let n = c.fetch_add(1, Ordering::SeqCst);
                            if n == 0 {
                                let body = serde_json::json!({ "deployments": { "dep-guard": 1000u64 } })
                                    .to_string();
                                return Ok::<_, hyper::Error>(
                                    http::Response::builder()
                                        .status(StatusCode::OK)
                                        .header("content-type", "application/json")
                                        .body(Full::new(Bytes::from(body)))
                                        .unwrap(),
                                );
                            }
                            return Ok::<_, hyper::Error>(
                                http::Response::builder()
                                    .status(StatusCode::INTERNAL_SERVER_ERROR)
                                    .body(Full::new(Bytes::from_static(b"router_error")))
                                    .unwrap(),
                            );
                        }
                        if path == "/_internal/deployments/dep-guard/upstream" {
                            let val: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                            let addr = val["upstream_addr"].as_str().map(|s| s.to_string());
                            u.lock().unwrap().push(addr);
                            return Ok::<_, hyper::Error>(
                                http::Response::builder()
                                    .status(StatusCode::OK)
                                    .body(Full::new(Bytes::from_static(b"{\"ok\":true}")))
                                    .unwrap(),
                            );
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

    let err = reap_once_with_router(&manager, &format!("http://{router_addr}"), "secret")
        .await
        .expect_err("second activity failure must abort freeze");
    assert!(err.contains("router_status_500"), "unexpected error: {err}");
    assert_eq!(
        manager.status("dep-guard").unwrap().state,
        InstanceState::Running
    );
    assert_eq!(
        *upstream_updates.lock().unwrap(),
        vec![None, Some(upstream_addr)]
    );

    router_task.abort();
    let _ = manager.stop_deployment("dep-guard").await;
}

struct ControlledDriver {
    running: Arc<Mutex<HashMap<String, (u16, tokio::task::JoinHandle<()>)>>>,
    frozen: Arc<Mutex<HashSet<String>>>,
    forced_port_by_dep: Arc<Mutex<HashMap<String, u16>>>,
    freeze_entered: Arc<Notify>,
    freeze_release: Arc<Notify>,
    block_freeze: Arc<AtomicBool>,
    stop_calls: Arc<AtomicUsize>,
    delete_calls: Arc<AtomicUsize>,
    deleted_ids: Arc<Mutex<Vec<String>>>,
    unfreeze_calls: Arc<AtomicUsize>,
}

impl ControlledDriver {
    fn new() -> Self {
        Self {
            running: Arc::new(Mutex::new(HashMap::new())),
            frozen: Arc::new(Mutex::new(HashSet::new())),
            forced_port_by_dep: Arc::new(Mutex::new(HashMap::new())),
            freeze_entered: Arc::new(Notify::new()),
            freeze_release: Arc::new(Notify::new()),
            block_freeze: Arc::new(AtomicBool::new(false)),
            stop_calls: Arc::new(AtomicUsize::new(0)),
            delete_calls: Arc::new(AtomicUsize::new(0)),
            deleted_ids: Arc::new(Mutex::new(Vec::new())),
            unfreeze_calls: Arc::new(AtomicUsize::new(0)),
        }
    }

    async fn spawn_health_listener(port: u16) -> Result<tokio::task::JoinHandle<()>, String> {
        let listener = TcpListener::bind(("127.0.0.1", port))
            .await
            .map_err(|e| format!("bind_{port}: {e}"))?;
        Ok(tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let mut buf = [0u8; 512];
                    let _ = stream.read(&mut buf).await;
                    let _ = stream
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                        .await;
                });
            }
        }))
    }
}

impl AppRuntimeDriver for ControlledDriver {
    fn allocate_port(&self) -> Result<u16, String> {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        Ok(listener.local_addr().map_err(|e| e.to_string())?.port())
    }

    fn start(
        &self,
        spec: AppLaunchSpec,
        _logs: Arc<LogRingBuffer>,
    ) -> BoxFuture<'_, Result<AppInstanceHandle, String>> {
        let running = Arc::clone(&self.running);
        let frozen = Arc::clone(&self.frozen);
        let forced = Arc::clone(&self.forced_port_by_dep);
        Box::pin(async move {
            let forced_port = forced.lock().unwrap().remove(&spec.deployment_id);
            let port = forced_port.unwrap_or(spec.port);
            if forced_port.is_none() {
                let handle = Self::spawn_health_listener(port).await?;
                if let Some((_, old)) = running.lock().unwrap().insert(spec.deployment_id.clone(), (port, handle)) {
                    old.abort();
                }
            }
            frozen.lock().unwrap().remove(&spec.deployment_id);
            Ok(AppInstanceHandle {
                deployment_id: spec.deployment_id.clone(),
                upstream_addr: format!("127.0.0.1:{port}"),
                runtime_id: format!("ctrl-{}", spec.deployment_id),
            })
        })
    }

    fn stop(&self, deployment_id: &str) -> BoxFuture<'_, Result<(), String>> {
        let running = Arc::clone(&self.running);
        let frozen = Arc::clone(&self.frozen);
        let stop_calls = Arc::clone(&self.stop_calls);
        let dep_id = deployment_id.to_string();
        Box::pin(async move {
            stop_calls.fetch_add(1, Ordering::SeqCst);
            frozen.lock().unwrap().remove(&dep_id);
            if let Some((_, handle)) = running.lock().unwrap().remove(&dep_id) {
                handle.abort();
            }
            Ok(())
        })
    }

    fn delete(&self, deployment_id: &str) -> BoxFuture<'_, Result<(), String>> {
        let running = Arc::clone(&self.running);
        let frozen = Arc::clone(&self.frozen);
        let delete_calls = Arc::clone(&self.delete_calls);
        let deleted_ids = Arc::clone(&self.deleted_ids);
        let dep_id = deployment_id.to_string();
        Box::pin(async move {
            delete_calls.fetch_add(1, Ordering::SeqCst);
            deleted_ids.lock().unwrap().push(dep_id.clone());
            frozen.lock().unwrap().remove(&dep_id);
            if let Some((_, handle)) = running.lock().unwrap().remove(&dep_id) {
                handle.abort();
            }
            Ok(())
        })
    }

    fn is_running(&self, deployment_id: &str) -> BoxFuture<'_, bool> {
        let running = Arc::clone(&self.running);
        let frozen = Arc::clone(&self.frozen);
        let dep_id = deployment_id.to_string();
        Box::pin(async move {
            running.lock().unwrap().contains_key(&dep_id) && !frozen.lock().unwrap().contains(&dep_id)
        })
    }

    fn freeze(&self, deployment_id: &str) -> BoxFuture<'_, Result<(), String>> {
        let frozen = Arc::clone(&self.frozen);
        let entered = Arc::clone(&self.freeze_entered);
        let release = Arc::clone(&self.freeze_release);
        let block = Arc::clone(&self.block_freeze);
        let dep_id = deployment_id.to_string();
        Box::pin(async move {
            if block.load(Ordering::SeqCst) {
                entered.notify_waiters();
                release.notified().await;
            }
            frozen.lock().unwrap().insert(dep_id);
            Ok(())
        })
    }

    fn unfreeze(&self, deployment_id: &str) -> BoxFuture<'_, Result<(), String>> {
        let frozen = Arc::clone(&self.frozen);
        let unfreeze_calls = Arc::clone(&self.unfreeze_calls);
        let dep_id = deployment_id.to_string();
        Box::pin(async move {
            unfreeze_calls.fetch_add(1, Ordering::SeqCst);
            frozen.lock().unwrap().remove(&dep_id);
            Ok(())
        })
    }
}

fn mock_deploy_request(deployment_id: &str, site_id: &str) -> DeployRequest {
    DeployRequest {
        deployment_id: deployment_id.to_string(),
        site_id: site_id.to_string(),
        oci_image_ref: None,
        command: None,
        health_path: "/health".to_string(),
        idle_timeout_sec: 1,
        memory_mb: 256,
        vcpu_limit: 1.0,
        pids_limit: 128,
        env: HashMap::new(),
        is_preview: false,
    }
}

#[tokio::test]
async fn wake_during_in_progress_freeze_waits_and_unfreezes_instead_of_returning_frozen_app() {
    let driver = Arc::new(ControlledDriver::new());
    let logs = Arc::new(LogRingBuffer::new(64, 16 * 1024));
    let manager = Arc::new(AppLifecycleManager::new(
        Arc::clone(&driver) as Arc<dyn AppRuntimeDriver>,
        logs,
        Duration::from_secs(2),
        Duration::from_millis(20),
    ));

    let deployed = manager
        .deploy_blue_green(mock_deploy_request("dep-race", "site-race"))
        .await
        .unwrap();
    let addr = deployed.upstream_addr.clone().unwrap();

    let mut activity = HashMap::new();
    activity.insert("dep-race".to_string(), 1_000u64);
    let candidates = manager.idle_candidates_with_generation(&activity, 120_000);
    assert_eq!(candidates.len(), 1);
    let (_, started_at, wake_gen) = candidates[0];

    driver.block_freeze.store(true, Ordering::SeqCst);
    let entered = driver.freeze_entered.notified();
    let mgr_freeze = Arc::clone(&manager);
    let freeze_task = tokio::spawn(async move {
        mgr_freeze
            .freeze_if_unchanged_generation("dep-race", started_at, wake_gen, 120_000)
            .await
    });
    entered.await;

    let mgr_wake = Arc::clone(&manager);
    let wake_task = tokio::spawn(async move { mgr_wake.wake_detailed("dep-race", None).await });
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(!wake_task.is_finished(), "wake must wait behind active freeze lock");

    driver.freeze_release.notify_waiters();
    assert!(freeze_task.await.unwrap());
    let outcome = wake_task.await.unwrap().unwrap();
    assert_eq!(outcome.mode, WakeMode::Unfrozen);
    assert_eq!(outcome.upstream_addr, addr);
    assert_eq!(
        manager.status("dep-race").unwrap().state,
        InstanceState::Running
    );
    assert!(driver.is_running("dep-race").await);
    assert_eq!(driver.unfreeze_calls.load(Ordering::SeqCst), 1);

    let _ = manager.stop_deployment("dep-race").await;
}

#[tokio::test]
async fn blue_green_drain_deletes_superseded_concurrent_ports_stay_distinct_and_conflict_rejected() {
    let driver = Arc::new(ControlledDriver::new());
    let logs = Arc::new(LogRingBuffer::new(64, 16 * 1024));
    let manager = Arc::new(AppLifecycleManager::new(
        Arc::clone(&driver) as Arc<dyn AppRuntimeDriver>,
        logs,
        Duration::from_secs(2),
        Duration::from_millis(25),
    ));

    let mut deploy_tasks = Vec::new();
    for i in 0..8 {
        let mgr = Arc::clone(&manager);
        deploy_tasks.push(tokio::spawn(async move {
            mgr.deploy_blue_green(mock_deploy_request(
                &format!("dep-conc-{i}"),
                &format!("site-conc-{i}"),
            ))
            .await
        }));
    }
    let mut ports = HashSet::new();
    for t in deploy_tasks {
        let st = t.await.unwrap().unwrap();
        let addr: SocketAddr = st.upstream_addr.unwrap().parse().unwrap();
        assert!(ports.insert(addr.port()), "duplicate port assigned: {}", addr.port());
    }

    let first = manager
        .deploy_blue_green(mock_deploy_request("dep-bg-1", "site-bg"))
        .await
        .unwrap();
    let first_port: u16 = first
        .upstream_addr
        .unwrap()
        .parse::<SocketAddr>()
        .unwrap()
        .port();
    let second = manager
        .deploy_blue_green(mock_deploy_request("dep-bg-2", "site-bg"))
        .await
        .unwrap();
    let second_port: u16 = second
        .upstream_addr
        .unwrap()
        .parse::<SocketAddr>()
        .unwrap()
        .port();
    assert_ne!(first_port, second_port);

    for _ in 0..40 {
        if driver.deleted_ids.lock().unwrap().iter().any(|id| id == "dep-bg-1") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(15)).await;
    }
    assert_eq!(driver.delete_calls.load(Ordering::SeqCst), 1);
    assert_eq!(driver.stop_calls.load(Ordering::SeqCst), 0);

    driver
        .forced_port_by_dep
        .lock()
        .unwrap()
        .insert("dep-collider".to_string(), second_port);
    let conflict_err = manager
        .deploy_blue_green(mock_deploy_request("dep-collider", "site-collider"))
        .await
        .expect_err("driver returning port owned by another deployment must fail");
    assert!(
        conflict_err.contains(&format!("port_reservation_conflict:{second_port}")),
        "unexpected error: {conflict_err}"
    );

    let _ = manager.shutdown_all().await;
}

#[tokio::test]
async fn server_returns_408_on_stalled_deploy_and_wake_bodies_and_exits_on_shutdown_signal() {
    let driver = Arc::new(LocalProcessDriver::new());
    let logs = Arc::new(LogRingBuffer::new(32, 8 * 1024));
    let manager = Arc::new(AppLifecycleManager::new(
        driver,
        logs,
        Duration::from_secs(2),
        Duration::ZERO,
    ));
    let bind_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0);
    let server = AppHostServer::bind(bind_addr, manager, "app-secret".to_string())
        .await
        .unwrap()
        .with_body_read_timeout(Duration::from_millis(80));
    let addr = server.addr;
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let handle = server.spawn_with_shutdown(shutdown_rx);

    for path in ["/_internal/apps/deploy", "/_internal/apps/dep-stalled/wake"] {
        let mut stream = TcpStream::connect(addr).await.unwrap();
        let req = format!(
            "POST {path} HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer app-secret\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{{\"a\""
        );
        stream.write_all(req.as_bytes()).await.unwrap();
        let mut resp = Vec::new();
        let mut buf = [0u8; 1024];
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(250), stream.read(&mut buf)).await {
                Ok(Ok(0)) => break,
                Ok(Ok(n)) => {
                    resp.extend_from_slice(&buf[..n]);
                    if String::from_utf8_lossy(&resp).contains("body_timeout") {
                        break;
                    }
                }
                Ok(Err(_)) | Err(_) => break,
            }
        }
        let text = String::from_utf8_lossy(&resp);
        assert!(text.starts_with("HTTP/1.1 408"), "expected 408 for {path}, got: {text}");
        assert!(text.contains("body_timeout"), "expected body_timeout for {path}, got: {text}");
    }

    let _ = shutdown_tx.send(true);
    tokio::time::timeout(Duration::from_secs(1), handle)
        .await
        .expect("accept loop must exit promptly on shutdown signal")
        .unwrap();
}

#[tokio::test]
async fn preview_deploy_does_not_replace_or_stop_live_deployment_for_same_site() {
    let driver = Arc::new(ControlledDriver::new());
    let logs = Arc::new(LogRingBuffer::new(64, 16 * 1024));
    let manager = Arc::new(AppLifecycleManager::new(
        Arc::clone(&driver) as Arc<dyn AppRuntimeDriver>,
        logs,
        Duration::from_secs(2),
        Duration::ZERO,
    ));

    let live = manager
        .deploy_blue_green(mock_deploy_request("dep-live-1", "site-shared"))
        .await
        .unwrap();
    assert_eq!(live.state, InstanceState::Running);
    assert_eq!(
        manager.active_deployment_for_site("site-shared").as_deref(),
        Some("dep-live-1")
    );

    let mut preview_req = mock_deploy_request("dep-preview-1", "site-shared");
    preview_req.is_preview = true;
    let preview = manager.deploy_blue_green(preview_req).await.unwrap();
    assert_eq!(preview.state, InstanceState::Running);
    assert_ne!(preview.upstream_addr, live.upstream_addr);

    assert_eq!(
        manager.active_deployment_for_site("site-shared").as_deref(),
        Some("dep-live-1")
    );
    assert_eq!(
        manager.status("dep-live-1").unwrap().state,
        InstanceState::Running
    );
    assert!(driver.is_running("dep-live-1").await);
    assert!(driver.is_running("dep-preview-1").await);
    assert_eq!(driver.delete_calls.load(Ordering::SeqCst), 0);

    let live_v2 = manager
        .deploy_blue_green(mock_deploy_request("dep-live-2", "site-shared"))
        .await
        .unwrap();
    assert_eq!(live_v2.state, InstanceState::Running);
    assert_eq!(
        manager.active_deployment_for_site("site-shared").as_deref(),
        Some("dep-live-2")
    );
    assert_eq!(
        manager.status("dep-live-1").unwrap().state,
        InstanceState::Stopped
    );
    assert_eq!(
        manager.status("dep-preview-1").unwrap().state,
        InstanceState::Running
    );
    assert!(driver.is_running("dep-preview-1").await);

    manager.stop_deployment("dep-preview-1").await.unwrap();
    assert_eq!(
        manager.status("dep-preview-1").unwrap().state,
        InstanceState::Stopped
    );
    assert!(driver.is_running("dep-live-2").await);

    manager.shutdown_all().await;
}

#[tokio::test]
async fn stop_with_mismatched_expected_upstream_leaves_replacement_running() {
    let driver = Arc::new(ControlledDriver::new());
    let logs = Arc::new(LogRingBuffer::new(64, 16 * 1024));
    let manager = Arc::new(AppLifecycleManager::new(
        Arc::clone(&driver) as Arc<dyn AppRuntimeDriver>,
        logs,
        Duration::from_secs(2),
        Duration::ZERO,
    ));
    let server = AppHostServer::bind(
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        Arc::clone(&manager),
        "stop-guard-secret".to_string(),
    )
    .await
    .unwrap();
    let addr = server.addr;
    let _handle = server.spawn();

    let mut req1 = mock_deploy_request("dep-reused", "site-stop-guard");
    req1.is_preview = true;
    let first = manager.deploy_blue_green(req1).await.unwrap();
    let first_upstream = first.upstream_addr.clone().unwrap();

    let mut req2 = mock_deploy_request("dep-reused", "site-stop-guard");
    req2.is_preview = true;
    let second = manager.deploy_blue_green(req2).await.unwrap();
    let second_upstream = second.upstream_addr.clone().unwrap();
    assert_ne!(first_upstream, second_upstream);

    let (st, body) = http_call(
        addr,
        Request::builder()
            .method("POST")
            .uri("/_internal/apps/dep-reused/stop")
            .header("authorization", "Bearer stop-guard-secret")
            .header("content-type", "application/json")
            .body(Full::new(Bytes::from(
                serde_json::json!({ "expected_upstream_addr": first_upstream }).to_string(),
            )))
            .unwrap(),
    )
    .await;
    assert_eq!(st, StatusCode::CONFLICT);
    let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(parsed["stopped"], false);
    assert_eq!(parsed["error"], "upstream_mismatch");
    assert_eq!(
        manager.status("dep-reused").unwrap().state,
        InstanceState::Running
    );
    assert!(driver.is_running("dep-reused").await);

    let (st2, body2) = http_call(
        addr,
        Request::builder()
            .method("POST")
            .uri("/_internal/apps/dep-reused/stop")
            .header("authorization", "Bearer stop-guard-secret")
            .header("content-type", "application/json")
            .body(Full::new(Bytes::from(
                serde_json::json!({ "expected_upstream_addr": second_upstream }).to_string(),
            )))
            .unwrap(),
    )
    .await;
    assert_eq!(st2, StatusCode::OK);
    let parsed2: serde_json::Value = serde_json::from_slice(&body2).unwrap();
    assert_eq!(parsed2["stopped"], true);
    assert_eq!(
        manager.status("dep-reused").unwrap().state,
        InstanceState::Stopped
    );

    manager.shutdown_all().await;
}
