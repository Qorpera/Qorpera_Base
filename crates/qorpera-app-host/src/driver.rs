use crate::logs::LogRingBuffer;
use bytes::Bytes;
use http::{Method, Request, StatusCode};
use http_body_util::{BodyExt, Full, Limited};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::future::Future;
use std::net::TcpListener;
use std::path::PathBuf;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

pub const DEFAULT_LXD_SOCKET_PATH: &str = "/var/snap/lxd/common/lxd/unix.socket";
const MAX_LXD_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const LXD_CONTROL_TIMEOUT: Duration = Duration::from_secs(15);
const LXD_CREATE_WAIT_SECS: u64 = 120;
const LXD_STATE_WAIT_SECS: u64 = 30;
const LXD_FREEZE_WAIT_SECS: u64 = 10;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppLaunchSpec {
    pub deployment_id: String,
    pub site_id: String,
    pub oci_image_ref: Option<String>,
    pub command: Option<Vec<String>>,
    pub port: u16,
    pub health_path: String,
    pub memory_mb: u32,
    pub vcpu_limit: f32,
    pub pids_limit: u32,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppInstanceHandle {
    pub deployment_id: String,
    pub upstream_addr: String,
    pub runtime_id: String,
}

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait AppRuntimeDriver: Send + Sync {
    fn allocate_port(&self) -> Result<u16, String>;
    fn start(
        &self,
        spec: AppLaunchSpec,
        logs: Arc<LogRingBuffer>,
    ) -> BoxFuture<'_, Result<AppInstanceHandle, String>>;
    fn stop(&self, deployment_id: &str) -> BoxFuture<'_, Result<(), String>>;
    fn is_running(&self, deployment_id: &str) -> BoxFuture<'_, bool>;
    fn freeze(&self, _deployment_id: &str) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async { Err("freeze_unsupported".to_string()) })
    }
    fn unfreeze(&self, _deployment_id: &str) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async { Err("unfreeze_unsupported".to_string()) })
    }
    fn stop_all(&self) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }
}

pub fn allocate_ephemeral_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("port bind failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("local_addr failed: {e}"))?
        .port();
    Ok(port)
}

pub fn is_loopback_port_available(bind_ip: &str, port: u16) -> bool {
    if port == 0 {
        return false;
    }
    TcpListener::bind((bind_ip, port)).is_ok()
}

struct LocalChild {
    child: Child,
    frozen: bool,
}

pub struct LocalProcessDriver {
    children: Arc<Mutex<HashMap<String, LocalChild>>>,
}

impl Default for LocalProcessDriver {
    fn default() -> Self {
        Self::new()
    }
}

impl LocalProcessDriver {
    pub fn new() -> Self {
        Self {
            children: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[cfg(unix)]
fn send_unix_signal(pid: u32, signal: libc::c_int) -> Result<(), String> {
    let pid_i32 = i32::try_from(pid).map_err(|_| "invalid_pid".to_string())?;
    let rc = unsafe { libc::kill(pid_i32, signal) };
    if rc == 0 {
        Ok(())
    } else {
        Err(format!("signal_failed: {}", std::io::Error::last_os_error()))
    }
}

impl AppRuntimeDriver for LocalProcessDriver {
    fn allocate_port(&self) -> Result<u16, String> {
        allocate_ephemeral_loopback_port()
    }

    fn start(
        &self,
        spec: AppLaunchSpec,
        logs: Arc<LogRingBuffer>,
    ) -> BoxFuture<'_, Result<AppInstanceHandle, String>> {
        let children = Arc::clone(&self.children);
        Box::pin(async move {
            let old_child = {
                let mut guard = children.lock().map_err(|_| "children lock poisoned".to_string())?;
                guard.remove(&spec.deployment_id)
            };
            if let Some(mut prev) = old_child {
                let _ = prev.child.kill().await;
                let _ = prev.child.wait().await;
            }

            let argv = spec
                .command
                .as_ref()
                .filter(|c| !c.is_empty())
                .ok_or_else(|| "local process driver requires command".to_string())?;
            let mut cmd = Command::new(&argv[0]);
            cmd.args(&argv[1..]);
            cmd.env_clear();
            if let Ok(path) = std::env::var("PATH") {
                cmd.env("PATH", path);
            }
            for (k, v) in &spec.env {
                cmd.env(k, v);
            }
            cmd.env("PORT", spec.port.to_string());
            cmd.env("HOST", "127.0.0.1");
            cmd.stdin(Stdio::null());
            cmd.stdout(Stdio::piped());
            cmd.stderr(Stdio::piped());
            cmd.kill_on_drop(true);

            let mut child = cmd
                .spawn()
                .map_err(|e| format!("failed to spawn app process: {e}"))?;
            let runtime_id = child
                .id()
                .map(|pid| format!("pid:{pid}"))
                .unwrap_or_else(|| "pid:unknown".to_string());

            if let Some(stdout) = child.stdout.take() {
                let dep_id = spec.deployment_id.clone();
                let log_ref = Arc::clone(&logs);
                tokio::spawn(async move {
                    let mut lines = BufReader::new(stdout).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        log_ref.push(&dep_id, "stdout", line);
                    }
                });
            }
            if let Some(stderr) = child.stderr.take() {
                let dep_id = spec.deployment_id.clone();
                let log_ref = Arc::clone(&logs);
                tokio::spawn(async move {
                    let mut lines = BufReader::new(stderr).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        log_ref.push(&dep_id, "stderr", line);
                    }
                });
            }

            let displaced = {
                let mut guard = children.lock().map_err(|_| "children lock poisoned".to_string())?;
                guard.insert(
                    spec.deployment_id.clone(),
                    LocalChild {
                        child,
                        frozen: false,
                    },
                )
            };
            if let Some(mut extra) = displaced {
                let _ = extra.child.kill().await;
                let _ = extra.child.wait().await;
            }

            Ok(AppInstanceHandle {
                deployment_id: spec.deployment_id,
                upstream_addr: format!("127.0.0.1:{}", spec.port),
                runtime_id,
            })
        })
    }

    fn stop(&self, deployment_id: &str) -> BoxFuture<'_, Result<(), String>> {
        let children = Arc::clone(&self.children);
        let dep = deployment_id.to_string();
        Box::pin(async move {
            let child_opt = {
                let mut guard = children.lock().map_err(|_| "children lock poisoned".to_string())?;
                guard.remove(&dep)
            };
            if let Some(mut entry) = child_opt {
                let _ = entry.child.kill().await;
                let _ = entry.child.wait().await;
            }
            Ok(())
        })
    }

    fn is_running(&self, deployment_id: &str) -> BoxFuture<'_, bool> {
        let children = Arc::clone(&self.children);
        let dep = deployment_id.to_string();
        Box::pin(async move {
            let Ok(mut guard) = children.lock() else {
                return false;
            };
            match guard.get_mut(&dep) {
                Some(entry) => !entry.frozen && matches!(entry.child.try_wait(), Ok(None)),
                None => false,
            }
        })
    }

    fn freeze(&self, deployment_id: &str) -> BoxFuture<'_, Result<(), String>> {
        let children = Arc::clone(&self.children);
        let dep = deployment_id.to_string();
        Box::pin(async move {
            #[cfg(unix)]
            {
                let mut guard = children.lock().map_err(|_| "children lock poisoned".to_string())?;
                let entry = guard
                    .get_mut(&dep)
                    .ok_or_else(|| "process_not_found".to_string())?;
                if !matches!(entry.child.try_wait(), Ok(None)) {
                    return Err("process_exited".to_string());
                }
                let pid = entry.child.id().ok_or_else(|| "missing_pid".to_string())?;
                send_unix_signal(pid, libc::SIGSTOP)?;
                entry.frozen = true;
                Ok(())
            }
            #[cfg(not(unix))]
            {
                let _ = (children, dep);
                Err("freeze_unsupported".to_string())
            }
        })
    }

    fn unfreeze(&self, deployment_id: &str) -> BoxFuture<'_, Result<(), String>> {
        let children = Arc::clone(&self.children);
        let dep = deployment_id.to_string();
        Box::pin(async move {
            #[cfg(unix)]
            {
                let mut guard = children.lock().map_err(|_| "children lock poisoned".to_string())?;
                let entry = guard
                    .get_mut(&dep)
                    .ok_or_else(|| "process_not_found".to_string())?;
                if !matches!(entry.child.try_wait(), Ok(None)) {
                    return Err("process_exited".to_string());
                }
                let pid = entry.child.id().ok_or_else(|| "missing_pid".to_string())?;
                send_unix_signal(pid, libc::SIGCONT)?;
                entry.frozen = false;
                Ok(())
            }
            #[cfg(not(unix))]
            {
                let _ = (children, dep);
                Err("unfreeze_unsupported".to_string())
            }
        })
    }

    fn stop_all(&self) -> BoxFuture<'_, ()> {
        let children = Arc::clone(&self.children);
        Box::pin(async move {
            let drained: Vec<LocalChild> = {
                let Ok(mut guard) = children.lock() else {
                    return;
                };
                guard.drain().map(|(_, c)| c).collect()
            };
            for mut entry in drained {
                let _ = entry.child.kill().await;
                let _ = entry.child.wait().await;
            }
        })
    }
}

#[derive(Debug, Deserialize)]
struct LxdEnvelope {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    status_code: u16,
    #[serde(default)]
    operation: String,
    #[serde(default)]
    error: String,
    #[serde(default)]
    metadata: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
struct LxdInstanceInfo {
    #[serde(default)]
    status: String,
    #[serde(default)]
    config: HashMap<String, String>,
    #[serde(default)]
    devices: HashMap<String, HashMap<String, String>>,
}

#[derive(Debug, Deserialize)]
struct LxdStateMetadata {
    #[serde(default)]
    status: String,
}

#[derive(Debug, Deserialize)]
struct LxdOperationMetadata {
    #[serde(default)]
    status_code: u16,
    #[serde(default)]
    err: String,
}

#[derive(Clone)]
struct LxdUnixClient {
    socket_path: PathBuf,
}

impl LxdUnixClient {
    fn new(socket_path: PathBuf) -> Self {
        Self { socket_path }
    }

    #[cfg(unix)]
    async fn request_json(
        &self,
        method: Method,
        path_and_query: &str,
        body: Option<serde_json::Value>,
        timeout: Duration,
    ) -> Result<(StatusCode, LxdEnvelope), String> {
        if !self.socket_path.exists() {
            return Err(format!(
                "lxd unix socket not found at {}",
                self.socket_path.display()
            ));
        }
        let stream = tokio::time::timeout(timeout, tokio::net::UnixStream::connect(&self.socket_path))
            .await
            .map_err(|_| "lxd_connect_timeout".to_string())?
            .map_err(|e| format!("lxd_connect_failed: {e}"))?;
        let io = TokioIo::new(stream);
        let (mut sender, conn) = tokio::time::timeout(timeout, hyper::client::conn::http1::handshake(io))
            .await
            .map_err(|_| "lxd_handshake_timeout".to_string())?
            .map_err(|e| format!("lxd_handshake_failed: {e}"))?;
        tokio::spawn(async move {
            let _ = conn.await;
        });

        let payload = match body {
            Some(v) => Bytes::from(serde_json::to_vec(&v).map_err(|e| e.to_string())?),
            None => Bytes::new(),
        };
        let mut builder = Request::builder()
            .method(method)
            .uri(path_and_query)
            .header("host", "lxd");
        if !payload.is_empty() {
            builder = builder.header("content-type", "application/json");
        }
        let req = builder
            .body(Full::new(payload))
            .map_err(|e| format!("lxd_request_build_failed: {e}"))?;

        let res = tokio::time::timeout(timeout, sender.send_request(req))
            .await
            .map_err(|_| "lxd_request_timeout".to_string())?
            .map_err(|e| format!("lxd_request_failed: {e}"))?;
        let status = res.status();
        let bytes = tokio::time::timeout(
            timeout,
            Limited::new(res.into_body(), MAX_LXD_RESPONSE_BYTES).collect(),
        )
        .await
        .map_err(|_| "lxd_body_timeout".to_string())?
        .map_err(|e| format!("lxd_body_failed: {e}"))?
        .to_bytes();

        let envelope: LxdEnvelope = serde_json::from_slice(&bytes)
            .map_err(|e| format!("lxd_invalid_json (status {}): {e}", status.as_u16()))?;
        Ok((status, envelope))
    }

    #[cfg(not(unix))]
    async fn request_json(
        &self,
        _method: Method,
        _path_and_query: &str,
        _body: Option<serde_json::Value>,
        _timeout: Duration,
    ) -> Result<(StatusCode, LxdEnvelope), String> {
        Err("lxd unix socket requires unix".to_string())
    }

    async fn wait_operation(&self, op_url: &str, wait_secs: u64) -> Result<(), String> {
        if op_url.is_empty() {
            return Err("lxd_missing_operation_url".to_string());
        }
        let (base_op, existing_query) = match op_url.split_once('?') {
            Some((b, q)) => (b.trim_end_matches('/'), Some(q)),
            None => (op_url.trim_end_matches('/'), None),
        };
        let wait_path = match existing_query {
            Some(q) if !q.is_empty() => format!("{base_op}/wait?{q}&timeout={wait_secs}"),
            _ => format!("{base_op}/wait?timeout={wait_secs}"),
        };
        let timeout = Duration::from_secs(wait_secs.saturating_add(10));
        let (status, env) = self
            .request_json(Method::GET, &wait_path, None, timeout)
            .await?;
        if status.as_u16() >= 400 || env.kind == "error" {
            return Err(format!("lxd_operation_wait_error: {}", env.error));
        }
        if let Ok(op_meta) = serde_json::from_value::<LxdOperationMetadata>(env.metadata) {
            if !op_meta.err.is_empty() {
                return Err(op_meta.err);
            }
            if op_meta.status_code != 0 && op_meta.status_code != 200 {
                return Err(format!("lxd_operation_failed_code_{}", op_meta.status_code));
            }
        }
        Ok(())
    }

    async fn get_instance(&self, project: &str, name: &str) -> Result<Option<LxdInstanceInfo>, String> {
        let path = project_path(&format!("/1.0/instances/{name}"), project);
        let (status, env) = self
            .request_json(Method::GET, &path, None, LXD_CONTROL_TIMEOUT)
            .await?;
        if status == StatusCode::NOT_FOUND || env.status_code == 404 {
            return Ok(None);
        }
        if status.as_u16() >= 400 || env.kind == "error" {
            return Err(format!("lxd_get_instance_error: {}", env.error));
        }
        let info: LxdInstanceInfo = serde_json::from_value(env.metadata)
            .map_err(|e| format!("lxd_instance_metadata_invalid: {e}"))?;
        Ok(Some(info))
    }

    async fn get_instance_status(&self, project: &str, name: &str) -> Result<Option<String>, String> {
        let path = project_path(&format!("/1.0/instances/{name}/state"), project);
        let (status, env) = self
            .request_json(Method::GET, &path, None, LXD_CONTROL_TIMEOUT)
            .await?;
        if status == StatusCode::NOT_FOUND || env.status_code == 404 {
            return Ok(None);
        }
        if status.as_u16() >= 400 || env.kind == "error" {
            return Err(format!("lxd_get_state_error: {}", env.error));
        }
        let state: LxdStateMetadata = serde_json::from_value(env.metadata)
            .map_err(|e| format!("lxd_state_metadata_invalid: {e}"))?;
        Ok(Some(state.status))
    }

    async fn create_instance(
        &self,
        project: &str,
        body: serde_json::Value,
        wait_secs: u64,
    ) -> Result<(), String> {
        let path = project_path("/1.0/instances", project);
        let (status, env) = self
            .request_json(Method::POST, &path, Some(body), LXD_CONTROL_TIMEOUT)
            .await?;
        if status.as_u16() >= 400 || env.kind == "error" {
            return Err(format!("lxd_create_error: {}", env.error));
        }
        if env.kind == "async" {
            self.wait_operation(&env.operation, wait_secs).await?;
        }
        Ok(())
    }

    async fn patch_instance(
        &self,
        project: &str,
        name: &str,
        body: serde_json::Value,
        wait_secs: u64,
    ) -> Result<(), String> {
        let path = project_path(&format!("/1.0/instances/{name}"), project);
        let (status, env) = self
            .request_json(Method::PATCH, &path, Some(body), LXD_CONTROL_TIMEOUT)
            .await?;
        if status.as_u16() >= 400 || env.kind == "error" {
            return Err(format!("lxd_patch_error: {}", env.error));
        }
        if env.kind == "async" {
            self.wait_operation(&env.operation, wait_secs).await?;
        }
        Ok(())
    }

    async fn set_instance_state(
        &self,
        project: &str,
        name: &str,
        action: &str,
        force: bool,
        timeout_secs: u64,
    ) -> Result<(), String> {
        let path = project_path(&format!("/1.0/instances/{name}/state"), project);
        let body = serde_json::json!({
            "action": action,
            "timeout": timeout_secs,
            "force": force,
            "stateful": false,
        });
        let (status, env) = self
            .request_json(Method::PUT, &path, Some(body), LXD_CONTROL_TIMEOUT)
            .await?;
        if status == StatusCode::NOT_FOUND && action == "stop" {
            return Ok(());
        }
        if status.as_u16() >= 400 || env.kind == "error" {
            if is_idempotent_state_error(action, &env.error) {
                return Ok(());
            }
            return Err(format!("lxd_state_{action}_error: {}", env.error));
        }
        if env.kind == "async" {
            if let Err(err) = self.wait_operation(&env.operation, timeout_secs).await {
                if is_idempotent_state_error(action, &err) {
                    return Ok(());
                }
                return Err(format!("lxd_state_{action}_op_error: {err}"));
            }
        }
        Ok(())
    }
}

fn is_idempotent_state_error(action: &str, err: &str) -> bool {
    let lower = err.to_ascii_lowercase();
    match action {
        "start" => lower.contains("already running"),
        "stop" => lower.contains("already stopped") || lower.contains("not found"),
        "freeze" => lower.contains("already frozen"),
        "unfreeze" => lower.contains("already running") || lower.contains("not frozen"),
        _ => false,
    }
}

fn project_path(base: &str, project: &str) -> String {
    if project.is_empty() || project == "default" {
        base.to_string()
    } else {
        format!("{base}?project={}", encode_uri_component(project))
    }
}

fn encode_uri_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for b in input.bytes() {
        if matches!(
            b,
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~'
        ) {
            out.push(b as char);
        } else {
            use std::fmt::Write;
            let _ = write!(&mut out, "%{b:02X}");
        }
    }
    out
}

pub fn parse_lxd_image_source(
    image: &str,
    oci_scheme_override: Option<&str>,
) -> serde_json::Value {
    let trimmed = image.trim();
    if let Some(rest) = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
    {
        let scheme = if trimmed.starts_with("https://") {
            "https"
        } else {
            "http"
        };
        if let Some((host, alias)) = rest.split_once('/') {
            if !host.is_empty() && !alias.is_empty() {
                return serde_json::json!({
                    "type": "image",
                    "mode": "pull",
                    "protocol": "oci",
                    "server": format!("{scheme}://{host}"),
                    "alias": alias,
                });
            }
        }
    }

    if trimmed.len() == 64 && trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
        return serde_json::json!({
            "type": "image",
            "fingerprint": trimmed.to_ascii_lowercase(),
        });
    }

    if let Some((first_seg, rest)) = trimmed.split_once('/') {
        let looks_like_host = first_seg.contains('.')
            || first_seg.contains(':')
            || first_seg.eq_ignore_ascii_case("localhost");
        if looks_like_host && !rest.is_empty() {
            let scheme = oci_scheme_override.unwrap_or_else(|| {
                if is_loopback_registry(first_seg) {
                    "http"
                } else {
                    "https"
                }
            });
            return serde_json::json!({
                "type": "image",
                "mode": "pull",
                "protocol": "oci",
                "server": format!("{scheme}://{first_seg}"),
                "alias": rest,
            });
        }
    }

    serde_json::json!({
        "type": "image",
        "alias": trimmed,
    })
}

fn is_loopback_registry(host: &str) -> bool {
    let lower = host.to_ascii_lowercase();
    lower == "localhost"
        || lower.starts_with("localhost:")
        || lower.starts_with("127.")
        || lower.starts_with("[::1]")
}

fn extract_bound_port(info: &LxdInstanceInfo, bind_ip: &str) -> Option<u16> {
    let dev = info.devices.get("http-ingress")?;
    if dev.get("type").map(|s| s.as_str()) != Some("proxy") {
        return None;
    }
    let listen_prefix = format!("tcp:{bind_ip}:");
    let listen = dev.get("listen")?;
    let port_str = listen.strip_prefix(&listen_prefix)?;
    let port: u16 = port_str.parse().ok()?;
    let expected_connect = format!("tcp:127.0.0.1:{port}");
    if dev.get("connect").map(|s| s.as_str()) != Some(expected_connect.as_str()) {
        return None;
    }
    if info.config.get("environment.PORT").map(|s| s.as_str()) != Some(port_str) {
        return None;
    }
    Some(port)
}

pub struct LxdAppDriver {
    pub project: String,
    pub egress_profile: String,
    pub bind_ip: String,
    pub socket_path: PathBuf,
    pub oci_registry_scheme: Option<String>,
}

impl LxdAppDriver {
    pub fn new(project: String, egress_profile: String, bind_ip: String) -> Self {
        Self::with_socket_path(
            project,
            egress_profile,
            bind_ip,
            PathBuf::from(DEFAULT_LXD_SOCKET_PATH),
        )
    }

    pub fn with_socket_path(
        project: String,
        egress_profile: String,
        bind_ip: String,
        socket_path: PathBuf,
    ) -> Self {
        Self {
            project,
            egress_profile,
            bind_ip,
            socket_path,
            oci_registry_scheme: None,
        }
    }

    pub fn container_name(deployment_id: &str) -> String {
        let sanitized: String = deployment_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
            .take(48)
            .collect();
        format!("qapp-{}", sanitized.to_ascii_lowercase())
    }
}

impl AppRuntimeDriver for LxdAppDriver {
    fn allocate_port(&self) -> Result<u16, String> {
        allocate_ephemeral_loopback_port()
    }

    fn start(
        &self,
        spec: AppLaunchSpec,
        logs: Arc<LogRingBuffer>,
    ) -> BoxFuture<'_, Result<AppInstanceHandle, String>> {
        let project = self.project.clone();
        let profile = self.egress_profile.clone();
        let bind_ip = self.bind_ip.clone();
        let client = LxdUnixClient::new(self.socket_path.clone());
        let oci_scheme = self.oci_registry_scheme.clone();
        Box::pin(async move {
            let image = spec
                .oci_image_ref
                .clone()
                .ok_or_else(|| "lxd driver requires oci_image_ref".to_string())?;
            let cname = Self::container_name(&spec.deployment_id);
            let cpu_cores = spec.vcpu_limit.ceil().max(1.0) as u32;

            let existing = client.get_instance(&project, &cname).await?;

            let active_port = match existing {
                None => {
                    let mut config = serde_json::Map::new();
                    config.insert("security.nesting".to_string(), serde_json::json!("false"));
                    config.insert("security.privileged".to_string(), serde_json::json!("false"));
                    config.insert(
                        "limits.memory".to_string(),
                        serde_json::json!(format!("{}MB", spec.memory_mb)),
                    );
                    config.insert(
                        "limits.cpu".to_string(),
                        serde_json::json!(cpu_cores.to_string()),
                    );
                    config.insert(
                        "limits.processes".to_string(),
                        serde_json::json!(spec.pids_limit.to_string()),
                    );
                    config.insert("boot.autostart".to_string(), serde_json::json!("false"));
                    config.insert(
                        "environment.PORT".to_string(),
                        serde_json::json!(spec.port.to_string()),
                    );
                    for (k, v) in &spec.env {
                        if is_safe_env_key(k) {
                            config.insert(format!("environment.{k}"), serde_json::json!(v));
                        }
                    }

                    let create_payload = serde_json::json!({
                        "name": cname,
                        "type": "container",
                        "profiles": [profile],
                        "config": config,
                        "devices": {
                            "http-ingress": {
                                "type": "proxy",
                                "listen": format!("tcp:{bind_ip}:{}", spec.port),
                                "connect": format!("tcp:127.0.0.1:{}", spec.port),
                            }
                        },
                        "source": parse_lxd_image_source(&image, oci_scheme.as_deref()),
                    });
                    client
                        .create_instance(&project, create_payload, LXD_CREATE_WAIT_SECS)
                        .await?;
                    client
                        .set_instance_state(&project, &cname, "start", false, LXD_STATE_WAIT_SECS)
                        .await?;
                    spec.port
                }
                Some(info) if info.status.eq_ignore_ascii_case("running") => {
                    if let Some(existing_port) = extract_bound_port(&info, &bind_ip) {
                        logs.push(
                            &spec.deployment_id,
                            "system",
                            format!("reattached running lxd container {cname} on {bind_ip}:{existing_port}"),
                        );
                        return Ok(AppInstanceHandle {
                            deployment_id: spec.deployment_id,
                            upstream_addr: format!("{bind_ip}:{existing_port}"),
                            runtime_id: cname,
                        });
                    }
                    client
                        .set_instance_state(&project, &cname, "stop", true, LXD_FREEZE_WAIT_SECS)
                        .await?;
                    let patch_payload = build_port_patch(&bind_ip, spec.port);
                    client
                        .patch_instance(&project, &cname, patch_payload, LXD_STATE_WAIT_SECS)
                        .await?;
                    client
                        .set_instance_state(&project, &cname, "start", false, LXD_STATE_WAIT_SECS)
                        .await?;
                    spec.port
                }
                Some(info) if info.status.eq_ignore_ascii_case("frozen") => {
                    if let Some(existing_port) = extract_bound_port(&info, &bind_ip) {
                        client
                            .set_instance_state(&project, &cname, "unfreeze", false, LXD_FREEZE_WAIT_SECS)
                            .await?;
                        logs.push(
                            &spec.deployment_id,
                            "system",
                            format!("unfroze lxd container {cname} on {bind_ip}:{existing_port}"),
                        );
                        return Ok(AppInstanceHandle {
                            deployment_id: spec.deployment_id,
                            upstream_addr: format!("{bind_ip}:{existing_port}"),
                            runtime_id: cname,
                        });
                    }
                    client
                        .set_instance_state(&project, &cname, "stop", true, LXD_FREEZE_WAIT_SECS)
                        .await?;
                    let patch_payload = build_port_patch(&bind_ip, spec.port);
                    client
                        .patch_instance(&project, &cname, patch_payload, LXD_STATE_WAIT_SECS)
                        .await?;
                    client
                        .set_instance_state(&project, &cname, "start", false, LXD_STATE_WAIT_SECS)
                        .await?;
                    spec.port
                }
                Some(info) => {
                    let chosen_port = match extract_bound_port(&info, &bind_ip) {
                        Some(existing_port)
                            if existing_port == spec.port
                                || is_loopback_port_available(&bind_ip, existing_port) =>
                        {
                            existing_port
                        }
                        _ => {
                            let patch_payload = build_port_patch(&bind_ip, spec.port);
                            client
                                .patch_instance(&project, &cname, patch_payload, LXD_STATE_WAIT_SECS)
                                .await?;
                            spec.port
                        }
                    };
                    client
                        .set_instance_state(&project, &cname, "start", false, LXD_STATE_WAIT_SECS)
                        .await?;
                    chosen_port
                }
            };

            logs.push(
                &spec.deployment_id,
                "system",
                format!("started lxd container {cname} on {bind_ip}:{active_port}"),
            );

            Ok(AppInstanceHandle {
                deployment_id: spec.deployment_id,
                upstream_addr: format!("{bind_ip}:{active_port}"),
                runtime_id: cname,
            })
        })
    }

    fn stop(&self, deployment_id: &str) -> BoxFuture<'_, Result<(), String>> {
        let project = self.project.clone();
        let client = LxdUnixClient::new(self.socket_path.clone());
        let cname = Self::container_name(deployment_id);
        Box::pin(async move {
            client
                .set_instance_state(&project, &cname, "stop", true, LXD_FREEZE_WAIT_SECS)
                .await
        })
    }

    fn freeze(&self, deployment_id: &str) -> BoxFuture<'_, Result<(), String>> {
        let project = self.project.clone();
        let client = LxdUnixClient::new(self.socket_path.clone());
        let cname = Self::container_name(deployment_id);
        Box::pin(async move {
            client
                .set_instance_state(&project, &cname, "freeze", false, LXD_FREEZE_WAIT_SECS)
                .await
        })
    }

    fn unfreeze(&self, deployment_id: &str) -> BoxFuture<'_, Result<(), String>> {
        let project = self.project.clone();
        let client = LxdUnixClient::new(self.socket_path.clone());
        let cname = Self::container_name(deployment_id);
        Box::pin(async move {
            client
                .set_instance_state(&project, &cname, "unfreeze", false, LXD_FREEZE_WAIT_SECS)
                .await
        })
    }

    fn is_running(&self, deployment_id: &str) -> BoxFuture<'_, bool> {
        let project = self.project.clone();
        let client = LxdUnixClient::new(self.socket_path.clone());
        let cname = Self::container_name(deployment_id);
        Box::pin(async move {
            match client.get_instance_status(&project, &cname).await {
                Ok(Some(st)) => st.eq_ignore_ascii_case("running"),
                _ => false,
            }
        })
    }
}

fn build_port_patch(bind_ip: &str, port: u16) -> serde_json::Value {
    serde_json::json!({
        "config": {
            "environment.PORT": port.to_string(),
        },
        "devices": {
            "http-ingress": {
                "type": "proxy",
                "listen": format!("tcp:{bind_ip}:{port}"),
                "connect": format!("tcp:127.0.0.1:{port}"),
            }
        }
    })
}

fn is_safe_env_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 128
        && key
            .bytes()
            .all(|b| matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_lxd_image_sources_for_loopback_remote_and_local() {
        let loopback = parse_lxd_image_source(
            "127.0.0.1:5000/qorpera-apps/shop@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            None,
        );
        assert_eq!(loopback["protocol"], "oci");
        assert_eq!(loopback["server"], "http://127.0.0.1:5000");
        assert_eq!(
            loopback["alias"],
            "qorpera-apps/shop@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        );

        let remote = parse_lxd_image_source("registry.qorpera.internal/sites/app:v2", None);
        assert_eq!(remote["protocol"], "oci");
        assert_eq!(remote["server"], "https://registry.qorpera.internal");
        assert_eq!(remote["alias"], "sites/app:v2");

        let fp = parse_lxd_image_source(&"a".repeat(64), None);
        assert_eq!(fp["fingerprint"], "a".repeat(64));

        let local = parse_lxd_image_source("qorpera-node22", None);
        assert_eq!(local["alias"], "qorpera-node22");
    }
}
