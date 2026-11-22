use crate::logs::LogRingBuffer;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::future::Future;
use std::net::TcpListener;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

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

pub struct LocalProcessDriver {
    children: Arc<Mutex<HashMap<String, Child>>>,
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
                let _ = prev.kill().await;
                let _ = prev.wait().await;
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
                guard.insert(spec.deployment_id.clone(), child)
            };
            if let Some(mut extra) = displaced {
                let _ = extra.kill().await;
                let _ = extra.wait().await;
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
            if let Some(mut child) = child_opt {
                let _ = child.kill().await;
                let _ = child.wait().await;
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
                Some(child) => matches!(child.try_wait(), Ok(None)),
                None => false,
            }
        })
    }

    fn stop_all(&self) -> BoxFuture<'_, ()> {
        let children = Arc::clone(&self.children);
        Box::pin(async move {
            let drained: Vec<Child> = {
                let Ok(mut guard) = children.lock() else {
                    return;
                };
                guard.drain().map(|(_, c)| c).collect()
            };
            for mut child in drained {
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
        })
    }
}

pub struct LxdAppDriver {
    pub project: String,
    pub egress_profile: String,
    pub lxc_binary: String,
    pub bind_ip: String,
}

impl LxdAppDriver {
    pub fn new(project: String, egress_profile: String, bind_ip: String) -> Self {
        Self {
            project,
            egress_profile,
            lxc_binary: "lxc".to_string(),
            bind_ip,
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
        let lxc = self.lxc_binary.clone();
        let bind_ip = self.bind_ip.clone();
        Box::pin(async move {
            let image = spec
                .oci_image_ref
                .clone()
                .ok_or_else(|| "lxd driver requires oci_image_ref".to_string())?;
            let cname = Self::container_name(&spec.deployment_id);
            let cpu_cores = spec.vcpu_limit.ceil().max(1.0) as u32;

            let exists = Command::new(&lxc)
                .args(["--project", &project, "info", &cname])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await
                .map_or(false, |s| s.success());

            if !exists {
                let mut init_args = vec![
                    "--project".to_string(),
                    project.clone(),
                    "init".to_string(),
                    image,
                    cname.clone(),
                    "--profile".to_string(),
                    profile,
                    "-c".to_string(),
                    "security.nesting=false".to_string(),
                    "-c".to_string(),
                    "security.privileged=false".to_string(),
                    "-c".to_string(),
                    format!("limits.memory={}MB", spec.memory_mb),
                    "-c".to_string(),
                    format!("limits.cpu={cpu_cores}"),
                    "-c".to_string(),
                    format!("limits.processes={}", spec.pids_limit),
                    "-c".to_string(),
                    "boot.autostart=false".to_string(),
                    "-c".to_string(),
                    format!("environment.PORT={}", spec.port),
                ];
                for (k, v) in &spec.env {
                    if is_safe_env_key(k) {
                        init_args.push("-c".to_string());
                        init_args.push(format!("environment.{k}={v}"));
                    }
                }
                let init_out = Command::new(&lxc)
                    .args(&init_args)
                    .output()
                    .await
                    .map_err(|e| format!("lxc init failed: {e}"))?;
                if !init_out.status.success() {
                    let err = String::from_utf8_lossy(&init_out.stderr);
                    return Err(format!("lxc init error: {err}"));
                }
            } else {
                let _ = Command::new(&lxc)
                    .args([
                        "--project",
                        &project,
                        "config",
                        "set",
                        &cname,
                        &format!("environment.PORT={}", spec.port),
                    ])
                    .output()
                    .await;
                let _ = Command::new(&lxc)
                    .args([
                        "--project",
                        &project,
                        "config",
                        "device",
                        "remove",
                        &cname,
                        "http-ingress",
                    ])
                    .output()
                    .await;
            }

            let proxy_out = Command::new(&lxc)
                .args([
                    "--project",
                    &project,
                    "config",
                    "device",
                    "add",
                    &cname,
                    "http-ingress",
                    "proxy",
                    &format!("listen=tcp:{bind_ip}:{}", spec.port),
                    &format!("connect=tcp:127.0.0.1:{}", spec.port),
                ])
                .output()
                .await
                .map_err(|e| format!("lxc proxy add failed: {e}"))?;
            if !proxy_out.status.success() {
                let err = String::from_utf8_lossy(&proxy_out.stderr);
                return Err(format!("lxc proxy add error: {err}"));
            }

            let start_out = Command::new(&lxc)
                .args(["--project", &project, "start", &cname])
                .output()
                .await
                .map_err(|e| format!("lxc start failed: {e}"))?;
            if !start_out.status.success() {
                let err = String::from_utf8_lossy(&start_out.stderr);
                if !err.contains("already running") {
                    return Err(format!("lxc start error: {err}"));
                }
            }

            logs.push(
                &spec.deployment_id,
                "system",
                format!("started lxd container {cname} on {bind_ip}:{}", spec.port),
            );

            Ok(AppInstanceHandle {
                deployment_id: spec.deployment_id,
                upstream_addr: format!("{bind_ip}:{}", spec.port),
                runtime_id: cname,
            })
        })
    }

    fn stop(&self, deployment_id: &str) -> BoxFuture<'_, Result<(), String>> {
        let project = self.project.clone();
        let lxc = self.lxc_binary.clone();
        let cname = Self::container_name(deployment_id);
        Box::pin(async move {
            let _ = Command::new(&lxc)
                .args(["--project", &project, "stop", "--timeout", "10", &cname])
                .output()
                .await;
            Ok(())
        })
    }

    fn is_running(&self, deployment_id: &str) -> BoxFuture<'_, bool> {
        let project = self.project.clone();
        let lxc = self.lxc_binary.clone();
        let cname = Self::container_name(deployment_id);
        Box::pin(async move {
            let Ok(out) = Command::new(&lxc)
                .args(["--project", &project, "list", &cname, "--format=csv", "-c", "s"])
                .output()
                .await
            else {
                return false;
            };
            String::from_utf8_lossy(&out.stdout)
                .trim()
                .eq_ignore_ascii_case("RUNNING")
        })
    }
}

fn is_safe_env_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 128
        && key
            .bytes()
            .all(|b| matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_'))
}
