use crate::driver::{AppInstanceHandle, AppLaunchSpec, AppRuntimeDriver};
use crate::logs::LogRingBuffer;
use bytes::Bytes;
use http::Request;
use http_body_util::Full;
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::net::TcpStream;
use tokio::sync::broadcast;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeployRequest {
    pub deployment_id: String,
    pub site_id: String,
    pub oci_image_ref: Option<String>,
    pub command: Option<Vec<String>>,
    #[serde(default = "default_health_path")]
    pub health_path: String,
    #[serde(default = "default_idle_timeout")]
    pub idle_timeout_sec: u64,
    #[serde(default = "default_memory_mb")]
    pub memory_mb: u32,
    #[serde(default = "default_vcpu")]
    pub vcpu_limit: f32,
    #[serde(default = "default_pids")]
    pub pids_limit: u32,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

fn default_health_path() -> String {
    "/".to_string()
}

fn default_idle_timeout() -> u64 {
    900
}

fn default_memory_mb() -> u32 {
    512
}

fn default_vcpu() -> f32 {
    1.0
}

fn default_pids() -> u32 {
    256
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InstanceState {
    Running,
    Hibernated,
    Stopped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeploymentStatus {
    pub deployment_id: String,
    pub site_id: String,
    pub state: InstanceState,
    pub upstream_addr: Option<String>,
    pub idle_timeout_sec: u64,
    pub started_at_ms: Option<u64>,
}

struct ManagedDeployment {
    spec: DeployRequest,
    handle: Option<AppInstanceHandle>,
    state: InstanceState,
    started_at_ms: Option<u64>,
}

pub struct AppLifecycleManager {
    driver: Arc<dyn AppRuntimeDriver>,
    logs: Arc<LogRingBuffer>,
    health_timeout: Duration,
    health_interval: Duration,
    drain_delay: Duration,
    deployments: Mutex<HashMap<String, ManagedDeployment>>,
    live_by_site: Mutex<HashMap<String, String>>,
    waking: Mutex<HashMap<String, broadcast::Sender<Result<String, String>>>>,
}

impl AppLifecycleManager {
    pub fn new(
        driver: Arc<dyn AppRuntimeDriver>,
        logs: Arc<LogRingBuffer>,
        health_timeout: Duration,
        drain_delay: Duration,
    ) -> Self {
        Self {
            driver,
            logs,
            health_timeout,
            health_interval: Duration::from_millis(50),
            drain_delay,
            deployments: Mutex::new(HashMap::new()),
            live_by_site: Mutex::new(HashMap::new()),
            waking: Mutex::new(HashMap::new()),
        }
    }

    pub fn logs(&self) -> Arc<LogRingBuffer> {
        Arc::clone(&self.logs)
    }

    pub async fn deploy_blue_green(&self, req: DeployRequest) -> Result<DeploymentStatus, String> {
        let port = self.driver.allocate_port()?;
        let launch = AppLaunchSpec {
            deployment_id: req.deployment_id.clone(),
            site_id: req.site_id.clone(),
            oci_image_ref: req.oci_image_ref.clone(),
            command: req.command.clone(),
            port,
            health_path: req.health_path.clone(),
            memory_mb: req.memory_mb,
            vcpu_limit: req.vcpu_limit,
            pids_limit: req.pids_limit,
            env: req.env.clone(),
        };

        let handle = self.driver.start(launch, Arc::clone(&self.logs)).await?;

        if let Err(err) = wait_for_health(
            &handle.upstream_addr,
            &req.health_path,
            self.health_timeout,
            self.health_interval,
        )
        .await
        {
            let _ = self.driver.stop(&req.deployment_id).await;
            self.logs.push(
                &req.deployment_id,
                "system",
                format!("health check failed; aborted deploy: {err}"),
            );
            return Err(format!("health_check_failed: {err}"));
        }

        let now_ms = unix_ms();
        let previous_live = {
            let mut live_map = self.live_by_site.lock().map_err(|_| "lock_poisoned".to_string())?;
            let prev = live_map.insert(req.site_id.clone(), req.deployment_id.clone());
            if prev.as_deref() == Some(req.deployment_id.as_str()) {
                None
            } else {
                prev
            }
        };

        let status = DeploymentStatus {
            deployment_id: req.deployment_id.clone(),
            site_id: req.site_id.clone(),
            state: InstanceState::Running,
            upstream_addr: Some(handle.upstream_addr.clone()),
            idle_timeout_sec: req.idle_timeout_sec,
            started_at_ms: Some(now_ms),
        };

        {
            let mut map = self.deployments.lock().map_err(|_| "lock_poisoned".to_string())?;
            map.insert(
                req.deployment_id.clone(),
                ManagedDeployment {
                    spec: req,
                    handle: Some(handle),
                    state: InstanceState::Running,
                    started_at_ms: Some(now_ms),
                },
            );
        }

        if let Some(prev_id) = previous_live {
            if !self.drain_delay.is_zero() {
                tokio::time::sleep(self.drain_delay).await;
            }
            let _ = self.stop_deployment_internal(&prev_id, InstanceState::Stopped).await;
        }

        Ok(status)
    }

    pub async fn wake(&self, deployment_id: &str, fallback_spec: Option<DeployRequest>) -> Result<String, String> {
        let already_running = {
            let map = self.deployments.lock().map_err(|_| "lock_poisoned".to_string())?;
            map.get(deployment_id)
                .filter(|d| d.state == InstanceState::Running)
                .and_then(|d| d.handle.as_ref().map(|h| h.upstream_addr.clone()))
        };
        if let Some(addr) = already_running {
            if self.driver.is_running(deployment_id).await {
                return Ok(addr);
            }
        }

        if let Some(spec) = fallback_spec {
            let mut map = self.deployments.lock().map_err(|_| "lock_poisoned".to_string())?;
            map.entry(deployment_id.to_string()).or_insert(ManagedDeployment {
                spec,
                handle: None,
                state: InstanceState::Hibernated,
                started_at_ms: None,
            });
        }

        let existing_rx = {
            let mut waking = self.waking.lock().map_err(|_| "lock_poisoned".to_string())?;
            if let Some(tx) = waking.get(deployment_id) {
                Some(tx.subscribe())
            } else {
                let (tx, _) = broadcast::channel(8);
                waking.insert(deployment_id.to_string(), tx);
                None
            }
        };

        if let Some(mut rx) = existing_rx {
            return rx
                .recv()
                .await
                .map_err(|_| "wake_channel_closed".to_string())?;
        }

        let outcome = self.perform_wake(deployment_id).await;
        if let Ok(mut waking) = self.waking.lock() {
            if let Some(tx) = waking.remove(deployment_id) {
                let _ = tx.send(outcome.clone());
            }
        }
        outcome
    }

    async fn perform_wake(&self, deployment_id: &str) -> Result<String, String> {
        let spec = {
            let map = self.deployments.lock().map_err(|_| "lock_poisoned".to_string())?;
            map.get(deployment_id)
                .map(|d| d.spec.clone())
                .ok_or_else(|| "deployment_not_found".to_string())?
        };
        let port = self.driver.allocate_port()?;
        let launch = AppLaunchSpec {
            deployment_id: spec.deployment_id.clone(),
            site_id: spec.site_id.clone(),
            oci_image_ref: spec.oci_image_ref.clone(),
            command: spec.command.clone(),
            port,
            health_path: spec.health_path.clone(),
            memory_mb: spec.memory_mb,
            vcpu_limit: spec.vcpu_limit,
            pids_limit: spec.pids_limit,
            env: spec.env.clone(),
        };
        let handle = self.driver.start(launch, Arc::clone(&self.logs)).await?;
        if let Err(err) = wait_for_health(
            &handle.upstream_addr,
            &spec.health_path,
            self.health_timeout,
            self.health_interval,
        )
        .await
        {
            let _ = self.driver.stop(deployment_id).await;
            return Err(format!("wake_health_failed: {err}"));
        }
        let addr = handle.upstream_addr.clone();
        let now_ms = unix_ms();
        {
            let mut map = self.deployments.lock().map_err(|_| "lock_poisoned".to_string())?;
            if let Some(entry) = map.get_mut(deployment_id) {
                entry.handle = Some(handle);
                entry.state = InstanceState::Running;
                entry.started_at_ms = Some(now_ms);
            }
        }
        Ok(addr)
    }

    pub async fn stop_deployment(&self, deployment_id: &str) -> Result<(), String> {
        self.stop_deployment_internal(deployment_id, InstanceState::Stopped)
            .await
    }

    async fn stop_deployment_internal(
        &self,
        deployment_id: &str,
        next_state: InstanceState,
    ) -> Result<(), String> {
        self.driver.stop(deployment_id).await?;
        let mut map = self.deployments.lock().map_err(|_| "lock_poisoned".to_string())?;
        if let Some(entry) = map.get_mut(deployment_id) {
            entry.handle = None;
            entry.state = next_state;
        }
        Ok(())
    }

    pub async fn reap_idle(
        &self,
        activity_ms: &HashMap<String, u64>,
        now_ms: u64,
    ) -> Vec<String> {
        let candidates: Vec<String> = {
            let Ok(map) = self.deployments.lock() else {
                return Vec::new();
            };
            map.iter()
                .filter_map(|(id, dep)| {
                    if dep.state != InstanceState::Running || dep.spec.idle_timeout_sec == 0 {
                        return None;
                    }
                    let last = activity_ms
                        .get(id)
                        .copied()
                        .or(dep.started_at_ms)
                        .unwrap_or(0);
                    let timeout_ms = dep.spec.idle_timeout_sec.saturating_mul(1000);
                    if now_ms.saturating_sub(last) >= timeout_ms {
                        Some(id.clone())
                    } else {
                        None
                    }
                })
                .collect()
        };

        let mut reaped = Vec::new();
        for id in candidates {
            if self
                .stop_deployment_internal(&id, InstanceState::Hibernated)
                .await
                .is_ok()
            {
                self.logs
                    .push(&id, "system", "hibernated idle deployment".to_string());
                reaped.push(id);
            }
        }
        reaped
    }

    pub fn status(&self, deployment_id: &str) -> Option<DeploymentStatus> {
        let map = self.deployments.lock().ok()?;
        let dep = map.get(deployment_id)?;
        Some(DeploymentStatus {
            deployment_id: dep.spec.deployment_id.clone(),
            site_id: dep.spec.site_id.clone(),
            state: dep.state,
            upstream_addr: dep.handle.as_ref().map(|h| h.upstream_addr.clone()),
            idle_timeout_sec: dep.spec.idle_timeout_sec,
            started_at_ms: dep.started_at_ms,
        })
    }

    pub fn active_deployment_for_site(&self, site_id: &str) -> Option<String> {
        self.live_by_site.lock().ok()?.get(site_id).cloned()
    }
}

async fn wait_for_health(
    addr: &str,
    health_path: &str,
    timeout: Duration,
    interval: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let path = if health_path.starts_with('/') {
        health_path.to_string()
    } else {
        format!("/{health_path}")
    };
    let mut last_err = "not_ready".to_string();
    while Instant::now() < deadline {
        match probe_http(addr, &path).await {
            Ok(()) => return Ok(()),
            Err(err) => {
                last_err = err;
                tokio::time::sleep(interval).await;
            }
        }
    }
    Err(last_err)
}

async fn probe_http(addr: &str, path: &str) -> Result<(), String> {
    let stream = tokio::time::timeout(Duration::from_millis(500), TcpStream::connect(addr))
        .await
        .map_err(|_| "connect_timeout".to_string())?
        .map_err(|e| format!("connect: {e}"))?;
    let io = TokioIo::new(stream);
    let (mut sender, conn) = hyper::client::conn::http1::handshake(io)
        .await
        .map_err(|e| format!("handshake: {e}"))?;
    tokio::spawn(async move {
        let _ = conn.await;
    });
    let req = Request::builder()
        .method("GET")
        .uri(path)
        .header("host", addr)
        .body(Full::new(Bytes::new()))
        .map_err(|e| e.to_string())?;
    let res = tokio::time::timeout(Duration::from_millis(800), sender.send_request(req))
        .await
        .map_err(|_| "response_timeout".to_string())?
        .map_err(|e| format!("request: {e}"))?;
    if res.status().is_success() {
        Ok(())
    } else {
        Err(format!("status_{}", res.status().as_u16()))
    }
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}
