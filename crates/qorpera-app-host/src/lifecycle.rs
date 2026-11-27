use crate::driver::{
    is_loopback_port_available, AppInstanceHandle, AppLaunchSpec, AppRuntimeDriver,
};
use crate::logs::LogRingBuffer;
use bytes::Bytes;
use http::Request;
use http_body_util::{BodyExt, Full};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::net::TcpStream;
use tokio::sync::broadcast;

const DEFAULT_DEEP_HIBERNATE_SEC: u64 = 3600;
const MAX_STOPPED_HISTORY: usize = 128;
const MAX_IDLE_LOCKS: usize = 64;
const THAW_HEALTH_TIMEOUT: Duration = Duration::from_millis(1500);
const THAW_HEALTH_INTERVAL: Duration = Duration::from_millis(10);
const THAW_HEALTH_MAX_INTERVAL: Duration = Duration::from_millis(100);
const THAW_RUNNING_CHECK_INTERVAL: Duration = Duration::from_millis(250);
const PORT_ALLOC_ATTEMPTS: usize = 16;

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
    #[serde(default)]
    pub is_preview: bool,
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
    Frozen,
    Hibernated,
    Stopped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WakeMode {
    AlreadyRunning,
    Unfrozen,
    ColdStart,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WakeOutcome {
    pub upstream_addr: String,
    pub mode: WakeMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeploymentStatus {
    pub deployment_id: String,
    pub site_id: String,
    pub state: InstanceState,
    pub upstream_addr: Option<String>,
    pub idle_timeout_sec: u64,
    pub started_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frozen_at_ms: Option<u64>,
}

struct ManagedDeployment {
    spec: DeployRequest,
    handle: Option<AppInstanceHandle>,
    last_port: Option<u16>,
    state: InstanceState,
    started_at_ms: Option<u64>,
    frozen_at_ms: Option<u64>,
    wake_generation: u64,
}

struct WakingGuard<'a> {
    map: &'a Mutex<HashMap<String, broadcast::Sender<Result<WakeOutcome, String>>>>,
    key: String,
    completed: bool,
}

impl<'a> WakingGuard<'a> {
    fn finish(mut self, outcome: Result<WakeOutcome, String>) -> Result<WakeOutcome, String> {
        self.completed = true;
        if let Ok(mut waking) = self.map.lock() {
            if let Some(tx) = waking.remove(&self.key) {
                let _ = tx.send(outcome.clone());
            }
        }
        outcome
    }
}

impl Drop for WakingGuard<'_> {
    fn drop(&mut self) {
        if !self.completed {
            if let Ok(mut waking) = self.map.lock() {
                if let Some(tx) = waking.remove(&self.key) {
                    let _ = tx.send(Err("wake_cancelled".to_string()));
                }
            }
        }
    }
}

pub struct AppLifecycleManager {
    driver: Arc<dyn AppRuntimeDriver>,
    logs: Arc<LogRingBuffer>,
    health_timeout: Duration,
    health_interval: Duration,
    drain_delay: Duration,
    deep_hibernate_delay: Option<Duration>,
    deployments: Arc<Mutex<HashMap<String, ManagedDeployment>>>,
    live_by_site: Mutex<HashMap<String, String>>,
    waking: Mutex<HashMap<String, broadcast::Sender<Result<WakeOutcome, String>>>>,
    deploy_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    deployment_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    reserved_ports: Arc<Mutex<HashSet<u16>>>,
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
            deep_hibernate_delay: Some(Duration::from_secs(DEFAULT_DEEP_HIBERNATE_SEC)),
            deployments: Arc::new(Mutex::new(HashMap::new())),
            live_by_site: Mutex::new(HashMap::new()),
            waking: Mutex::new(HashMap::new()),
            deploy_locks: Mutex::new(HashMap::new()),
            deployment_locks: Mutex::new(HashMap::new()),
            reserved_ports: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    fn reserve_port(&self, preferred: Option<u16>) -> Result<u16, String> {
        if let Some(p) = preferred {
            if let Ok(mut reserved) = self.reserved_ports.lock() {
                if !reserved.contains(&p) && is_loopback_port_available("127.0.0.1", p) {
                    reserved.insert(p);
                    return Ok(p);
                }
            }
        }
        // WHY: Track reserved ports in-process across concurrent starts so ephemeral bind-and-drop probes cannot hand two starts the same port.
        for _ in 0..PORT_ALLOC_ATTEMPTS {
            let candidate = self.driver.allocate_port()?;
            if let Ok(mut reserved) = self.reserved_ports.lock() {
                if reserved.insert(candidate) {
                    return Ok(candidate);
                }
            }
        }
        Err("port_reservation_exhausted".to_string())
    }

    fn release_port(&self, port: Option<u16>) {
        if let Some(p) = port {
            if let Ok(mut reserved) = self.reserved_ports.lock() {
                reserved.remove(&p);
            }
        }
    }

    fn commit_bound_port(
        &self,
        reserved_port: u16,
        bound_port: Option<u16>,
        allowed_existing_port: Option<u16>,
    ) -> Result<u16, String> {
        match bound_port {
            Some(actual) if actual != reserved_port => {
                let mut reserved = self
                    .reserved_ports
                    .lock()
                    .map_err(|_| "lock_poisoned".to_string())?;
                if Some(actual) != allowed_existing_port && reserved.contains(&actual) {
                    reserved.remove(&reserved_port);
                    return Err(format!("port_reservation_conflict:{actual}"));
                }
                reserved.remove(&reserved_port);
                reserved.insert(actual);
                Ok(actual)
            }
            Some(actual) => Ok(actual),
            None => Ok(reserved_port),
        }
    }

    fn prune_idle_locks(&self) {
        for map_lock in [&self.deploy_locks, &self.deployment_locks] {
            if let Ok(mut locks) = map_lock.lock() {
                if locks.len() > MAX_IDLE_LOCKS {
                    locks.retain(|_, lock| Arc::strong_count(lock) > 1);
                }
            }
        }
    }

    pub fn with_deep_hibernate_delay(mut self, delay: Option<Duration>) -> Self {
        self.deep_hibernate_delay = delay.filter(|d| !d.is_zero());
        self
    }

    pub fn logs(&self) -> Arc<LogRingBuffer> {
        Arc::clone(&self.logs)
    }

    fn site_deploy_lock(&self, site_id: &str) -> Result<Arc<tokio::sync::Mutex<()>>, String> {
        let mut locks = self.deploy_locks.lock().map_err(|_| "lock_poisoned".to_string())?;
        Ok(Arc::clone(
            locks
                .entry(site_id.to_string())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
        ))
    }

    fn deployment_lock(&self, deployment_id: &str) -> Result<Arc<tokio::sync::Mutex<()>>, String> {
        let mut locks = self
            .deployment_locks
            .lock()
            .map_err(|_| "lock_poisoned".to_string())?;
        Ok(Arc::clone(
            locks
                .entry(deployment_id.to_string())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
        ))
    }

    pub async fn deploy_blue_green(&self, req: DeployRequest) -> Result<DeploymentStatus, String> {
        let site_lock = if req.is_preview {
            None
        } else {
            Some(self.site_deploy_lock(&req.site_id)?)
        };
        let _site_guard = match &site_lock {
            Some(lock) => Some(lock.lock().await),
            None => None,
        };

        let dep_lock = self.deployment_lock(&req.deployment_id)?;
        let (status, previous_live) = {
            let _dep_guard = dep_lock.lock().await;

            let old_port = {
                let map = self.deployments.lock().map_err(|_| "lock_poisoned".to_string())?;
                map.get(&req.deployment_id)
                    .and_then(|d| d.handle.as_ref().and_then(|h| parse_port(&h.upstream_addr)))
            };

            let port = self.reserve_port(None)?;
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

            let handle = match self.driver.start(launch, Arc::clone(&self.logs)).await {
                Ok(handle) => handle,
                Err(err) => {
                    self.release_port(Some(port));
                    return Err(err);
                }
            };

            let bound_port = match self.commit_bound_port(
                port,
                parse_port(&handle.upstream_addr),
                old_port,
            ) {
                Ok(bound) => bound,
                Err(err) => {
                    let _ = self.driver.delete(&req.deployment_id).await;
                    return Err(err);
                }
            };

            if let Err(err) = wait_for_health(
                &handle.upstream_addr,
                &req.health_path,
                self.health_timeout,
                self.health_interval,
            )
            .await
            {
                let _ = self.driver.delete(&req.deployment_id).await;
                self.release_port(Some(bound_port));
                self.logs.push(
                    &req.deployment_id,
                    "system",
                    format!("health check failed; aborted deploy: {err}"),
                );
                return Err(format!("health_check_failed: {err}"));
            }

            let now_ms = unix_ms();
            let previous_live = if req.is_preview {
                None
            } else {
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
                frozen_at_ms: None,
            };

            {
                let mut map = self.deployments.lock().map_err(|_| "lock_poisoned".to_string())?;
                let next_gen = map
                    .get(&req.deployment_id)
                    .map_or(1, |d| d.wake_generation.wrapping_add(1));
                if old_port != Some(bound_port) {
                    self.release_port(old_port);
                }
                map.insert(
                    req.deployment_id.clone(),
                    ManagedDeployment {
                        spec: req,
                        handle: Some(handle),
                        last_port: Some(bound_port),
                        state: InstanceState::Running,
                        started_at_ms: Some(now_ms),
                        frozen_at_ms: None,
                        wake_generation: next_gen,
                    },
                );
            }

            (status, previous_live)
        };

        if let Some(prev_id) = previous_live {
            if self.drain_delay.is_zero() {
                let _ = self.stop_deployment(&prev_id).await;
            } else {
                let driver = Arc::clone(&self.driver);
                let deployments = Arc::clone(&self.deployments);
                let logs = Arc::clone(&self.logs);
                let reserved_ports = Arc::clone(&self.reserved_ports);
                let prev_lock = self.deployment_lock(&prev_id)?;
                let delay = self.drain_delay;
                tokio::spawn(async move {
                    tokio::time::sleep(delay).await;
                    let _guard = prev_lock.lock().await;
                    // WHY: Delete superseded blue-green containers rather than merely stopping them so old qapp-* instances do not leak storage.
                    let _ = driver.delete(&prev_id).await;
                    let (evicted, released_port) = if let Ok(mut map) = deployments.lock() {
                        let released = if let Some(entry) = map.get_mut(&prev_id) {
                            let port = entry
                                .handle
                                .as_ref()
                                .and_then(|h| parse_port(&h.upstream_addr));
                            entry.handle = None;
                            entry.frozen_at_ms = None;
                            entry.state = InstanceState::Stopped;
                            port
                        } else {
                            None
                        };
                        (evict_old_stopped(&mut map), released)
                    } else {
                        (Vec::new(), None)
                    };
                    if let Some(port) = released_port {
                        if let Ok(mut reserved) = reserved_ports.lock() {
                            reserved.remove(&port);
                        }
                    }
                    for id in evicted {
                        logs.remove(&id);
                    }
                });
            }
        }
        drop(_site_guard);
        drop(site_lock);
        drop(dep_lock);
        self.prune_stopped_history();
        self.prune_idle_locks();

        Ok(status)
    }

    pub async fn wake(
        &self,
        deployment_id: &str,
        fallback_spec: Option<DeployRequest>,
    ) -> Result<String, String> {
        self.wake_detailed(deployment_id, fallback_spec)
            .await
            .map(|o| o.upstream_addr)
    }

    pub async fn wake_detailed(
        &self,
        deployment_id: &str,
        fallback_spec: Option<DeployRequest>,
    ) -> Result<WakeOutcome, String> {
        let maybe_running = {
            let map = self.deployments.lock().map_err(|_| "lock_poisoned".to_string())?;
            map.get(deployment_id)
                .is_some_and(|d| d.state == InstanceState::Running && d.handle.is_some())
        };
        if maybe_running {
            let dep_lock = self.deployment_lock(deployment_id)?;
            // WHY: Serialize the fast path against an in-progress freeze; if dep_lock is held, fall through to perform_wake to wait and unfreeze.
            if let Ok(_dep_guard) = dep_lock.try_lock() {
                let already_running = {
                    let map = self.deployments.lock().map_err(|_| "lock_poisoned".to_string())?;
                    map.get(deployment_id)
                        .filter(|d| d.state == InstanceState::Running)
                        .and_then(|d| d.handle.as_ref().map(|h| h.upstream_addr.clone()))
                };
                if let Some(addr) = already_running {
                    if self.driver.is_running(deployment_id).await {
                        if let Ok(mut map) = self.deployments.lock() {
                            if let Some(entry) = map.get_mut(deployment_id) {
                                if entry.state == InstanceState::Running {
                                    entry.wake_generation = entry.wake_generation.wrapping_add(1);
                                }
                            }
                        }
                        return Ok(WakeOutcome {
                            upstream_addr: addr,
                            mode: WakeMode::AlreadyRunning,
                        });
                    }
                }
            };
        }

        if let Some(spec) = fallback_spec {
            let mut map = self.deployments.lock().map_err(|_| "lock_poisoned".to_string())?;
            map.entry(deployment_id.to_string()).or_insert(ManagedDeployment {
                spec,
                handle: None,
                last_port: None,
                state: InstanceState::Hibernated,
                started_at_ms: None,
                frozen_at_ms: None,
                wake_generation: 0,
            });
        }

        let existing_rx = {
            let mut waking = self.waking.lock().map_err(|_| "lock_poisoned".to_string())?;
            if let Some(tx) = waking.get(deployment_id) {
                Some(tx.subscribe())
            } else {
                let (tx, _) = broadcast::channel(16);
                waking.insert(deployment_id.to_string(), tx);
                None
            }
        };

        if let Some(mut rx) = existing_rx {
            let wait_limit = self.health_timeout + Duration::from_secs(5);
            return match tokio::time::timeout(wait_limit, rx.recv()).await {
                Ok(Ok(outcome)) => outcome,
                Ok(Err(_)) => Err("wake_channel_closed".to_string()),
                Err(_) => Err("wake_wait_timeout".to_string()),
            };
        }

        let guard = WakingGuard {
            map: &self.waking,
            key: deployment_id.to_string(),
            completed: false,
        };
        let outcome = self.perform_wake(deployment_id).await;
        guard.finish(outcome)
    }

    async fn perform_wake(&self, deployment_id: &str) -> Result<WakeOutcome, String> {
        let dep_lock = self.deployment_lock(deployment_id)?;
        let _dep_guard = dep_lock.lock().await;

        let (spec, state, handle, last_port) = {
            let map = self.deployments.lock().map_err(|_| "lock_poisoned".to_string())?;
            let dep = map
                .get(deployment_id)
                .ok_or_else(|| "deployment_not_found".to_string())?;
            (dep.spec.clone(), dep.state, dep.handle.clone(), dep.last_port)
        };

        if state == InstanceState::Running {
            if let Some(h) = &handle {
                if self.driver.is_running(deployment_id).await {
                    if let Ok(mut map) = self.deployments.lock() {
                        if let Some(entry) = map.get_mut(deployment_id) {
                            if entry.state == InstanceState::Running {
                                entry.wake_generation = entry.wake_generation.wrapping_add(1);
                            }
                        }
                    }
                    return Ok(WakeOutcome {
                        upstream_addr: h.upstream_addr.clone(),
                        mode: WakeMode::AlreadyRunning,
                    });
                }
            }
        }

        if state == InstanceState::Frozen {
            if let Some(h) = handle {
                match self.driver.unfreeze(deployment_id).await {
                    Ok(()) => {
                        if wait_for_thawed_health(
                            &*self.driver,
                            deployment_id,
                            &h.upstream_addr,
                            &spec.health_path,
                            THAW_HEALTH_TIMEOUT,
                        )
                        .await
                        .is_ok()
                        {
                            let now_ms = unix_ms();
                            {
                                let mut map =
                                    self.deployments.lock().map_err(|_| "lock_poisoned".to_string())?;
                                if let Some(entry) = map.get_mut(deployment_id) {
                                    entry.state = InstanceState::Running;
                                    entry.frozen_at_ms = None;
                                    entry.started_at_ms = Some(now_ms);
                                    entry.wake_generation = entry.wake_generation.wrapping_add(1);
                                }
                            }
                            self.logs.push(
                                deployment_id,
                                "system",
                                "unfroze idle deployment".to_string(),
                            );
                            return Ok(WakeOutcome {
                                upstream_addr: h.upstream_addr,
                                mode: WakeMode::Unfrozen,
                            });
                        }
                        self.logs.push(
                            deployment_id,
                            "system",
                            "thawed health probe failed; falling back to cold start".to_string(),
                        );
                    }
                    Err(err) => {
                        self.logs.push(
                            deployment_id,
                            "system",
                            format!("unfreeze failed ({err}); falling back to cold start"),
                        );
                    }
                }
                let _ = self.driver.stop(deployment_id).await;
                self.release_port(parse_port(&h.upstream_addr));
            }
        } else if let Some(h) = &handle {
            self.release_port(parse_port(&h.upstream_addr));
        }

        let port = self.reserve_port(last_port)?;
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
        let handle = match self.driver.start(launch, Arc::clone(&self.logs)).await {
            Ok(handle) => handle,
            Err(err) => {
                self.release_port(Some(port));
                return Err(err);
            }
        };
        let bound_port = match self.commit_bound_port(port, parse_port(&handle.upstream_addr), None)
        {
            Ok(bound) => bound,
            Err(err) => {
                let _ = self.driver.stop(deployment_id).await;
                return Err(err);
            }
        };
        if let Err(err) = wait_for_health(
            &handle.upstream_addr,
            &spec.health_path,
            self.health_timeout,
            self.health_interval,
        )
        .await
        {
            let _ = self.driver.stop(deployment_id).await;
            self.release_port(Some(bound_port));
            return Err(format!("wake_health_failed: {err}"));
        }
        let addr = handle.upstream_addr.clone();
        let now_ms = unix_ms();
        {
            let mut map = self.deployments.lock().map_err(|_| "lock_poisoned".to_string())?;
            if let Some(entry) = map.get_mut(deployment_id) {
                entry.handle = Some(handle);
                entry.last_port = Some(bound_port);
                entry.state = InstanceState::Running;
                entry.started_at_ms = Some(now_ms);
                entry.frozen_at_ms = None;
                entry.wake_generation = entry.wake_generation.wrapping_add(1);
            }
        }
        Ok(WakeOutcome {
            upstream_addr: addr,
            mode: WakeMode::ColdStart,
        })
    }

    pub async fn freeze_deployment(&self, deployment_id: &str) -> Result<DeploymentStatus, String> {
        let dep_lock = self.deployment_lock(deployment_id)?;
        let _dep_guard = dep_lock.lock().await;

        let current_state = {
            let waking_busy = self
                .waking
                .lock()
                .is_ok_and(|w| w.contains_key(deployment_id));
            if waking_busy {
                return Err("deployment_waking".to_string());
            }
            let map = self.deployments.lock().map_err(|_| "lock_poisoned".to_string())?;
            let dep = map
                .get(deployment_id)
                .ok_or_else(|| "deployment_not_found".to_string())?;
            dep.state
        };

        if current_state == InstanceState::Frozen {
            return self
                .status(deployment_id)
                .ok_or_else(|| "deployment_not_found".to_string());
        }
        if current_state != InstanceState::Running {
            return Err("deployment_not_running".to_string());
        }

        self.driver.freeze(deployment_id).await?;
        let now_ms = unix_ms();
        let status = {
            let mut map = self.deployments.lock().map_err(|_| "lock_poisoned".to_string())?;
            let entry = map
                .get_mut(deployment_id)
                .ok_or_else(|| "deployment_not_found".to_string())?;
            entry.state = InstanceState::Frozen;
            entry.frozen_at_ms = Some(now_ms);
            status_from_entry(entry)
        };
        self.logs
            .push(deployment_id, "system", "froze deployment".to_string());
        Ok(status)
    }

    pub async fn stop_deployment(&self, deployment_id: &str) -> Result<(), String> {
        let _ = self.stop_deployment_if_upstream(deployment_id, None).await?;
        Ok(())
    }

    pub async fn stop_deployment_if_upstream(
        &self,
        deployment_id: &str,
        expected_upstream_addr: Option<&str>,
    ) -> Result<bool, String> {
        let dep_lock = self.deployment_lock(deployment_id)?;
        let res = {
            let _dep_guard = dep_lock.lock().await;
            if let Some(expected) = expected_upstream_addr {
                let actual = {
                    let map = self.deployments.lock().map_err(|_| "lock_poisoned".to_string())?;
                    map.get(deployment_id)
                        .and_then(|entry| entry.handle.as_ref().map(|h| h.upstream_addr.clone()))
                };
                if let Some(actual_addr) = actual {
                    if actual_addr != expected {
                        return Ok(false);
                    }
                }
            }
            self.stop_deployment_unlocked(deployment_id, InstanceState::Stopped, true)
                .await?;
            Ok(true)
        };
        drop(dep_lock);
        self.prune_stopped_history();
        self.prune_idle_locks();
        res
    }

    fn prune_stopped_history(&self) {
        let evicted = if let Ok(mut map) = self.deployments.lock() {
            evict_old_stopped(&mut map)
        } else {
            Vec::new()
        };
        for id in &evicted {
            self.logs.remove(id);
        }
        if !evicted.is_empty() {
            if let Ok(mut locks) = self.deployment_locks.lock() {
                for id in &evicted {
                    if let Some(lock) = locks.get(id) {
                        if Arc::strong_count(lock) == 1 {
                            locks.remove(id);
                        }
                    }
                }
            }
        }
    }

    pub async fn shutdown_all(&self) {
        self.driver.stop_all().await;
        if let Ok(mut map) = self.deployments.lock() {
            for dep in map.values_mut() {
                dep.handle = None;
                dep.frozen_at_ms = None;
                dep.state = InstanceState::Stopped;
            }
        }
        if let Ok(mut reserved) = self.reserved_ports.lock() {
            reserved.clear();
        }
    }

    async fn stop_deployment_unlocked(
        &self,
        deployment_id: &str,
        next_state: InstanceState,
        delete_instance: bool,
    ) -> Result<(), String> {
        if delete_instance {
            self.driver.delete(deployment_id).await?;
        } else {
            self.driver.stop(deployment_id).await?;
        }
        let released_port = {
            let mut map = self.deployments.lock().map_err(|_| "lock_poisoned".to_string())?;
            if let Some(entry) = map.get_mut(deployment_id) {
                let port = entry
                    .handle
                    .as_ref()
                    .and_then(|h| parse_port(&h.upstream_addr));
                entry.handle = None;
                entry.frozen_at_ms = None;
                entry.state = next_state;
                port
            } else {
                None
            }
        };
        self.release_port(released_port);
        Ok(())
    }

    pub fn idle_candidates(
        &self,
        activity_ms: &HashMap<String, u64>,
        now_ms: u64,
    ) -> Vec<(String, Option<u64>)> {
        self.idle_candidates_with_generation(activity_ms, now_ms)
            .into_iter()
            .map(|(id, started_at, _)| (id, started_at))
            .collect()
    }

    pub fn idle_candidates_with_generation(
        &self,
        activity_ms: &HashMap<String, u64>,
        now_ms: u64,
    ) -> Vec<(String, Option<u64>, u64)> {
        let waking_keys: HashSet<String> = self
            .waking
            .lock()
            .map(|w| w.keys().cloned().collect())
            .unwrap_or_default();
        let Ok(map) = self.deployments.lock() else {
            return Vec::new();
        };
        map.iter()
            .filter_map(|(id, dep)| {
                if dep.state != InstanceState::Running
                    || dep.spec.idle_timeout_sec == 0
                    || waking_keys.contains(id)
                {
                    return None;
                }
                let last = activity_ms
                    .get(id)
                    .copied()
                    .or(dep.started_at_ms)
                    .unwrap_or(0);
                let timeout_ms = dep.spec.idle_timeout_sec.saturating_mul(1000);
                if now_ms.saturating_sub(last) >= timeout_ms {
                    Some((id.clone(), dep.started_at_ms, dep.wake_generation))
                } else {
                    None
                }
            })
            .collect()
    }

    pub fn deep_hibernate_candidates(&self, now_ms: u64) -> Vec<(String, u64)> {
        let Some(delay) = self.deep_hibernate_delay else {
            return Vec::new();
        };
        let delay_ms = delay.as_millis() as u64;
        let waking_keys: HashSet<String> = self
            .waking
            .lock()
            .map(|w| w.keys().cloned().collect())
            .unwrap_or_default();
        let Ok(map) = self.deployments.lock() else {
            return Vec::new();
        };
        map.iter()
            .filter_map(|(id, dep)| {
                if dep.state != InstanceState::Frozen || waking_keys.contains(id) {
                    return None;
                }
                let frozen_at = dep.frozen_at_ms?;
                if now_ms.saturating_sub(frozen_at) >= delay_ms {
                    Some((id.clone(), frozen_at))
                } else {
                    None
                }
            })
            .collect()
    }

    pub async fn freeze_if_unchanged(
        &self,
        deployment_id: &str,
        expected_started_at_ms: Option<u64>,
        frozen_at_ms: u64,
    ) -> bool {
        self.freeze_if_unchanged_inner(deployment_id, expected_started_at_ms, None, frozen_at_ms)
            .await
    }

    pub async fn freeze_if_unchanged_generation(
        &self,
        deployment_id: &str,
        expected_started_at_ms: Option<u64>,
        expected_wake_generation: u64,
        frozen_at_ms: u64,
    ) -> bool {
        self.freeze_if_unchanged_inner(
            deployment_id,
            expected_started_at_ms,
            Some(expected_wake_generation),
            frozen_at_ms,
        )
        .await
    }

    async fn freeze_if_unchanged_inner(
        &self,
        deployment_id: &str,
        expected_started_at_ms: Option<u64>,
        expected_wake_generation: Option<u64>,
        frozen_at_ms: u64,
    ) -> bool {
        let Ok(dep_lock) = self.deployment_lock(deployment_id) else {
            return false;
        };
        let _dep_guard = dep_lock.lock().await;
        let still_matches = {
            let waking_busy = self
                .waking
                .lock()
                .is_ok_and(|w| w.contains_key(deployment_id));
            if waking_busy {
                false
            } else {
                self.deployments.lock().is_ok_and(|map| {
                    map.get(deployment_id).is_some_and(|d| {
                        d.state == InstanceState::Running
                            && d.started_at_ms == expected_started_at_ms
                            && expected_wake_generation.is_none_or(|g| d.wake_generation == g)
                    })
                })
            }
        };
        if !still_matches {
            return false;
        }
        match self.driver.freeze(deployment_id).await {
            Ok(()) => {
                if let Ok(mut map) = self.deployments.lock() {
                    if let Some(entry) = map.get_mut(deployment_id) {
                        entry.state = InstanceState::Frozen;
                        entry.frozen_at_ms = Some(frozen_at_ms);
                    }
                }
                self.logs
                    .push(deployment_id, "system", "froze idle deployment".to_string());
                true
            }
            Err(_) => {
                if self
                    .stop_deployment_unlocked(deployment_id, InstanceState::Hibernated, false)
                    .await
                    .is_ok()
                {
                    self.logs.push(
                        deployment_id,
                        "system",
                        "hibernated idle deployment".to_string(),
                    );
                    true
                } else {
                    false
                }
            }
        }
    }

    pub async fn deep_hibernate_if_unchanged(
        &self,
        deployment_id: &str,
        expected_frozen_at_ms: u64,
    ) -> bool {
        let Ok(dep_lock) = self.deployment_lock(deployment_id) else {
            return false;
        };
        let _dep_guard = dep_lock.lock().await;
        let still_matches = {
            let waking_busy = self
                .waking
                .lock()
                .is_ok_and(|w| w.contains_key(deployment_id));
            if waking_busy {
                false
            } else {
                self.deployments.lock().is_ok_and(|map| {
                    map.get(deployment_id).is_some_and(|d| {
                        d.state == InstanceState::Frozen
                            && d.frozen_at_ms == Some(expected_frozen_at_ms)
                    })
                })
            }
        };
        if !still_matches {
            return false;
        }
        if self
            .stop_deployment_unlocked(deployment_id, InstanceState::Hibernated, false)
            .await
            .is_ok()
        {
            self.logs.push(
                deployment_id,
                "system",
                "deep-hibernated frozen deployment".to_string(),
            );
            true
        } else {
            false
        }
    }

    pub async fn hibernate_if_unchanged(
        &self,
        deployment_id: &str,
        expected_started_at_ms: Option<u64>,
    ) -> bool {
        let Ok(dep_lock) = self.deployment_lock(deployment_id) else {
            return false;
        };
        let _dep_guard = dep_lock.lock().await;
        let still_matches = {
            let waking_busy = self
                .waking
                .lock()
                .is_ok_and(|w| w.contains_key(deployment_id));
            if waking_busy {
                false
            } else {
                self.deployments.lock().is_ok_and(|map| {
                    map.get(deployment_id).is_some_and(|d| {
                        d.state == InstanceState::Running && d.started_at_ms == expected_started_at_ms
                    })
                })
            }
        };
        if !still_matches {
            return false;
        }
        if self
            .stop_deployment_unlocked(deployment_id, InstanceState::Hibernated, false)
            .await
            .is_ok()
        {
            self.logs
                .push(deployment_id, "system", "hibernated idle deployment".to_string());
            true
        } else {
            false
        }
    }

    pub async fn reap_idle(
        &self,
        activity_ms: &HashMap<String, u64>,
        now_ms: u64,
    ) -> Vec<String> {
        let mut reaped = Vec::new();
        for (id, started_at, wake_gen) in self.idle_candidates_with_generation(activity_ms, now_ms) {
            if self
                .freeze_if_unchanged_generation(&id, started_at, wake_gen, now_ms)
                .await
            {
                reaped.push(id);
            }
        }
        for (id, frozen_at) in self.deep_hibernate_candidates(now_ms) {
            if self.deep_hibernate_if_unchanged(&id, frozen_at).await {
                reaped.push(id);
            }
        }
        reaped
    }

    pub fn status(&self, deployment_id: &str) -> Option<DeploymentStatus> {
        let map = self.deployments.lock().ok()?;
        let dep = map.get(deployment_id)?;
        Some(status_from_entry(dep))
    }

    pub fn active_deployment_for_site(&self, site_id: &str) -> Option<String> {
        self.live_by_site.lock().ok()?.get(site_id).cloned()
    }
}

fn evict_old_stopped(map: &mut HashMap<String, ManagedDeployment>) -> Vec<String> {
    let mut stopped: Vec<(String, u64)> = map
        .iter()
        .filter(|(_, d)| d.state == InstanceState::Stopped)
        .map(|(id, d)| (id.clone(), d.started_at_ms.unwrap_or(0)))
        .collect();
    if stopped.len() <= MAX_STOPPED_HISTORY {
        return Vec::new();
    }
    stopped.sort_by_key(|(_, ts)| *ts);
    let drop_count = stopped.len() - MAX_STOPPED_HISTORY;
    let mut evicted = Vec::with_capacity(drop_count);
    for (id, _) in stopped.into_iter().take(drop_count) {
        if map.remove(&id).is_some() {
            evicted.push(id);
        }
    }
    evicted
}

fn status_from_entry(dep: &ManagedDeployment) -> DeploymentStatus {
    DeploymentStatus {
        deployment_id: dep.spec.deployment_id.clone(),
        site_id: dep.spec.site_id.clone(),
        state: dep.state,
        upstream_addr: dep.handle.as_ref().map(|h| h.upstream_addr.clone()),
        idle_timeout_sec: dep.spec.idle_timeout_sec,
        started_at_ms: dep.started_at_ms,
        frozen_at_ms: dep.frozen_at_ms,
    }
}

fn parse_port(addr: &str) -> Option<u16> {
    addr.rsplit_once(':')?.1.parse().ok()
}

async fn wait_for_thawed_health(
    driver: &dyn AppRuntimeDriver,
    deployment_id: &str,
    addr: &str,
    health_path: &str,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let path = if health_path.starts_with('/') {
        health_path.to_string()
    } else {
        format!("/{health_path}")
    };
    let mut last_err = "not_ready".to_string();
    let mut step = THAW_HEALTH_INTERVAL;
    let mut last_running_check = Instant::now();
    let mut sender: Option<hyper::client::conn::http1::SendRequest<Full<Bytes>>> = None;
    // WHY: Back off probes and throttle LXD state checks so a slow thaw cannot storm the LXD Unix socket at 100 req/s.
    while Instant::now() < deadline {
        match probe_http_reused(addr, &path, &mut sender).await {
            Ok(()) => return Ok(()),
            Err(err) => {
                last_err = err;
                if last_running_check.elapsed() >= THAW_RUNNING_CHECK_INTERVAL {
                    last_running_check = Instant::now();
                    if !driver.is_running(deployment_id).await {
                        return Err(last_err);
                    }
                }
                tokio::time::sleep(step).await;
                step = (step * 2).min(THAW_HEALTH_MAX_INTERVAL);
            }
        }
    }
    Err(last_err)
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
    let mut step = Duration::from_millis(10).min(interval);
    let mut sender: Option<hyper::client::conn::http1::SendRequest<Full<Bytes>>> = None;
    while Instant::now() < deadline {
        match probe_http_reused(addr, &path, &mut sender).await {
            Ok(()) => return Ok(()),
            Err(err) => {
                last_err = err;
                tokio::time::sleep(step).await;
                step = (step * 2).min(interval);
            }
        }
    }
    Err(last_err)
}

async fn probe_http_reused(
    addr: &str,
    path: &str,
    cached: &mut Option<hyper::client::conn::http1::SendRequest<Full<Bytes>>>,
) -> Result<(), String> {
    let reusable = match cached.take() {
        Some(mut existing) if !existing.is_closed() => {
            if existing.ready().await.is_ok() {
                Some(existing)
            } else {
                None
            }
        }
        _ => None,
    };
    let mut sender = match reusable {
        Some(existing) => existing,
        None => {
            let stream = tokio::time::timeout(Duration::from_millis(500), TcpStream::connect(addr))
                .await
                .map_err(|_| "connect_timeout".to_string())?
                .map_err(|e| format!("connect: {e}"))?;
            let _ = stream.set_nodelay(true);
            let io = TokioIo::new(stream);
            let (s, conn) = tokio::time::timeout(
                Duration::from_millis(500),
                hyper::client::conn::http1::handshake(io),
            )
            .await
            .map_err(|_| "handshake_timeout".to_string())?
            .map_err(|e| format!("handshake: {e}"))?;
            tokio::spawn(async move {
                let _ = conn.await;
            });
            s
        }
    };
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
    let status = res.status();
    let _ = tokio::time::timeout(Duration::from_millis(200), res.into_body().collect()).await;
    if !sender.is_closed() {
        *cached = Some(sender);
    }
    if status.is_success() {
        Ok(())
    } else {
        Err(format!("status_{}", status.as_u16()))
    }
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::driver::LocalProcessDriver;

    #[test]
    fn prune_idle_locks_retains_held_locks_past_threshold() {
        let manager = AppLifecycleManager::new(
            Arc::new(LocalProcessDriver::new()),
            Arc::new(LogRingBuffer::new(16, 4096)),
            Duration::from_secs(1),
            Duration::ZERO,
        );
        let held_site = manager.site_deploy_lock("site-held").unwrap();
        let held_dep = manager.deployment_lock("dep-held").unwrap();
        for i in 0..(MAX_IDLE_LOCKS + 10) {
            let _ = manager.site_deploy_lock(&format!("site-{i}")).unwrap();
            let _ = manager.deployment_lock(&format!("dep-{i}")).unwrap();
        }
        assert!(manager.deploy_locks.lock().unwrap().len() > MAX_IDLE_LOCKS);
        assert!(manager.deployment_locks.lock().unwrap().len() > MAX_IDLE_LOCKS);

        manager.prune_idle_locks();

        let sites = manager.deploy_locks.lock().unwrap();
        let deps = manager.deployment_locks.lock().unwrap();
        assert_eq!(sites.len(), 1);
        assert_eq!(deps.len(), 1);
        assert!(Arc::ptr_eq(sites.get("site-held").unwrap(), &held_site));
        assert!(Arc::ptr_eq(deps.get("dep-held").unwrap(), &held_dep));
    }

    #[test]
    fn commit_bound_port_rejects_foreign_collision_without_releasing_owner() {
        let manager = AppLifecycleManager::new(
            Arc::new(LocalProcessDriver::new()),
            Arc::new(LogRingBuffer::new(16, 4096)),
            Duration::from_secs(1),
            Duration::ZERO,
        );
        {
            let mut reserved = manager.reserved_ports.lock().unwrap();
            reserved.insert(41_000);
            reserved.insert(41_001);
        }

        let err = manager
            .commit_bound_port(41_001, Some(41_000), None)
            .expect_err("foreign reserved port must conflict");
        assert!(err.contains("port_reservation_conflict:41000"));
        let reserved = manager.reserved_ports.lock().unwrap();
        assert!(reserved.contains(&41_000));
        assert!(!reserved.contains(&41_001));
        drop(reserved);

        {
            let mut reserved = manager.reserved_ports.lock().unwrap();
            reserved.insert(41_002);
        }
        let reused = manager
            .commit_bound_port(41_002, Some(41_000), Some(41_000))
            .expect("own existing port may be reattached");
        assert_eq!(reused, 41_000);
        let reserved = manager.reserved_ports.lock().unwrap();
        assert!(reserved.contains(&41_000));
        assert!(!reserved.contains(&41_002));
    }
}
