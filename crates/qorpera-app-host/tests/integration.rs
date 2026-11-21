use bytes::Bytes;
use http::{Request, StatusCode};
use http_body_util::{BodyExt, Full};
use hyper_util::rt::TokioIo;
use qorpera_app_host::driver::LocalProcessDriver;
use qorpera_app_host::lifecycle::{AppLifecycleManager, DeployRequest, InstanceState};
use qorpera_app_host::logs::LogRingBuffer;
use qorpera_app_host::reaper::reap_once_with_router;
use qorpera_app_host::server::AppHostServer;
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;
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

fn node_http_script(label: &str, health_status: u16) -> Vec<String> {
    let script = format!(
        "const http=require('http');const port=Number(process.env.PORT);console.log('boot:{label}');const s=http.createServer((req,res)=>{{if(req.url==='/health'){{res.writeHead({health_status});res.end('{label}');return;}}res.writeHead(200);res.end('{label}:'+process.env.APP_GREETING);}});s.listen(port,'127.0.0.1');"
    );
    vec!["node".to_string(), "-e".to_string(), script]
}

#[tokio::test]
async fn blue_green_deploy_rollback_on_unhealthy_hibernate_wake_and_logs() {
    let driver = Arc::new(LocalProcessDriver::new());
    let logs = Arc::new(LogRingBuffer::new(200, 64 * 1024));
    let manager = Arc::new(AppLifecycleManager::new(
        driver,
        logs,
        Duration::from_secs(4),
        Duration::from_millis(50),
    ));
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
    assert_eq!(manager.status("dep-v1").unwrap().state, InstanceState::Stopped);
    assert_eq!(manager.active_deployment_for_site("site-shop").as_deref(), Some("dep-v2"));

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
    assert_eq!(manager.status("dep-v2").unwrap().state, InstanceState::Hibernated);
    assert_eq!(manager.status("dep-always").unwrap().state, InstanceState::Running);

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
        woken_addrs.push(json["upstream_addr"].as_str().unwrap().to_string());
    }
    assert!(woken_addrs.iter().all(|a| a == &woken_addrs[0]));

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
    let manager = Arc::new(AppLifecycleManager::new(
        driver,
        logs,
        Duration::from_secs(4),
        Duration::from_millis(20),
    ));
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

    let reaped = reap_once_with_router(&manager, &format!("http://{router_addr}"), "reaper-secret")
        .await
        .unwrap();
    assert_eq!(reaped, vec!["dep-cold".to_string()]);
    assert_eq!(manager.status("dep-cold").unwrap().state, InstanceState::Hibernated);
    assert_eq!(*cleared.lock().unwrap(), vec!["dep-cold".to_string()]);
}
