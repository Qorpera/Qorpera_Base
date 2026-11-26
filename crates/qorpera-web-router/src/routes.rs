use crate::security::sanitize_redirect_location;
use arc_swap::{ArcSwap, Guard};
use http::HeaderValue;
use serde::{Deserialize, Deserializer, Serialize};
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

fn null_as_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

fn null_as_health_path<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Option::<String>::deserialize(deserializer)?.unwrap_or_else(default_health_path))
}

fn null_as_idle_timeout<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Option::<u64>::deserialize(deserializer)?.unwrap_or_else(default_idle_timeout))
}

fn null_as_memory_mb<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Option::<u32>::deserialize(deserializer)?.unwrap_or_else(default_memory_mb))
}

fn null_as_vcpu_limit<'de, D>(deserializer: D) -> Result<f32, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Option::<f32>::deserialize(deserializer)?.unwrap_or_else(default_vcpu_limit))
}

fn null_as_hosts_domain<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Option::<String>::deserialize(deserializer)?.unwrap_or_else(default_hosts_domain))
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum UpstreamOverride {
    Set(String),
    Cleared(Option<String>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeploymentKind {
    Static,
    Server,
    Hybrid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DomainStatus {
    PendingDns,
    DnsVerified,
    TlsActive,
    Moved,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestFile {
    pub sha256: String,
    pub bytes: usize,
    pub content_type: String,
    #[serde(default)]
    pub immutable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RedirectRule {
    pub from: String,
    pub to: String,
    #[serde(default = "default_redirect_status")]
    pub status: u16,
}

fn default_redirect_status() -> u16 {
    301
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeaderRule {
    pub path_prefix: String,
    pub headers: HashMap<String, String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SiteManifest {
    #[serde(default, deserialize_with = "null_as_default")]
    pub files: HashMap<String, ManifestFile>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub redirects: Vec<RedirectRule>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub headers: Vec<HeaderRule>,
    #[serde(default)]
    pub spa_fallback: Option<String>,
    #[serde(default)]
    pub not_found_page: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeploymentRecord {
    pub id: String,
    pub kind: DeploymentKind,
    #[serde(default, deserialize_with = "null_as_default")]
    pub manifest: SiteManifest,
    #[serde(default)]
    pub upstream_addr: Option<String>,
    #[serde(default)]
    pub oci_image_ref: Option<String>,
    #[serde(default)]
    pub app_port: Option<u16>,
    #[serde(default = "default_health_path", deserialize_with = "null_as_health_path")]
    pub health_path: String,
    #[serde(default = "default_idle_timeout", deserialize_with = "null_as_idle_timeout")]
    pub idle_timeout_sec: u64,
    #[serde(default = "default_memory_mb", deserialize_with = "null_as_memory_mb")]
    pub memory_mb: u32,
    #[serde(default = "default_vcpu_limit", deserialize_with = "null_as_vcpu_limit")]
    pub vcpu_limit: f32,
    #[serde(default, deserialize_with = "null_as_default")]
    pub env_spec: HashMap<String, String>,
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

fn default_vcpu_limit() -> f32 {
    1.0
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomDomainRecord {
    pub id: String,
    pub site_id: String,
    pub hostname: String,
    pub is_apex: bool,
    pub is_primary: bool,
    pub status: DomainStatus,
    pub verification_token: String,
    #[serde(default)]
    pub last_checked_at: Option<String>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub consecutive_misses: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SiteRecord {
    pub id: String,
    pub slug: String,
    pub is_public: bool,
    pub taken_down: bool,
    pub password_sha256: Option<String>,
    pub password_version: i32,
    pub live_deployment: Option<DeploymentRecord>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub preview_deployments: HashMap<String, DeploymentRecord>,
    #[serde(default)]
    pub primary_custom_domain: Option<String>,
    #[serde(default)]
    pub db_live: Option<DeploymentRecord>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub db_previews: HashMap<String, DeploymentRecord>,
}

#[derive(Debug, Clone, Copy)]
pub struct ChosenDeployment<'a> {
    pub deployment: &'a DeploymentRecord,
    pub db_version_id: Option<&'a str>,
}

impl SiteRecord {
    pub fn deployment_for(&self, scope: HostScope, preview_version_id: Option<&str>) -> Option<ChosenDeployment<'_>> {
        let live = || {
            self.live_deployment
                .as_ref()
                .map(deployed)
                .or_else(|| self.db_live.as_ref().and_then(database_stored))
        };
        match scope {
            HostScope::NextHost => {
                if let Some(version_id) = preview_version_id {
                    if let Some(deployment) = self.preview_deployments.get(version_id) {
                        return Some(deployed(deployment));
                    }
                    if let Some(chosen) = self.db_previews.get(version_id).and_then(database_stored) {
                        return Some(chosen);
                    }
                }
                self.preview_deployments.values().next().map(deployed).or_else(live)
            }
            HostScope::PreviewSlot(_) => {
                let version_id = preview_version_id?;
                if let Some(deployment) = self.preview_deployments.get(version_id) {
                    return Some(deployed(deployment));
                }
                self.db_previews.get(version_id).and_then(database_stored)
            }
            HostScope::OwnHost | HostScope::CustomDomain => live(),
        }
    }
}

fn deployed(deployment: &DeploymentRecord) -> ChosenDeployment<'_> {
    ChosenDeployment {
        deployment,
        db_version_id: None,
    }
}

fn database_stored(deployment: &DeploymentRecord) -> Option<ChosenDeployment<'_>> {
    if deployment.kind != DeploymentKind::Static {
        return None;
    }
    let version_id = deployment.id.strip_prefix("db:").filter(|id| !id.is_empty())?;
    Some(ChosenDeployment {
        deployment,
        db_version_id: Some(version_id),
    })
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EdgeSnapshot {
    #[serde(default = "default_hosts_domain", deserialize_with = "null_as_hosts_domain")]
    pub hosts_domain: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub legacy_hosts_domains: Vec<String>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub hosts_enabled: bool,
    #[serde(default, deserialize_with = "null_as_default")]
    pub public_enabled: bool,
    #[serde(default, deserialize_with = "null_as_default")]
    pub domains_enabled: bool,
    #[serde(default)]
    pub edge_ipv4: Option<String>,
    #[serde(default)]
    pub edge_ipv6: Option<String>,
    #[serde(default)]
    pub edge_cname_target: Option<String>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub sites: Vec<SiteRecord>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub custom_domains: Vec<CustomDomainRecord>,
}

fn default_hosts_domain() -> String {
    "qorpera.site".to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostScope {
    OwnHost,
    NextHost,
    PreviewSlot(u8),
    CustomDomain,
}

#[derive(Debug, Clone)]
pub enum ResolvedHost {
    Site {
        site: Arc<SiteRecord>,
        scope: HostScope,
        canonical_redirect: Option<String>,
    },
    UnknownOwnHost {
        scope: HostScope,
    },
    AlmostReady,
}

#[derive(Debug, Clone)]
pub enum StaticResolution<'a> {
    ReservedPlatformPath,
    Redirect {
        status: u16,
        location: String,
    },
    File {
        path: Cow<'a, str>,
        file: &'a ManifestFile,
        status: u16,
    },
    NotFound,
}

#[derive(Clone)]
pub struct RouteTable {
    pub hosts_domain: String,
    pub legacy_hosts_domains: Vec<String>,
    pub hosts_enabled: bool,
    pub public_enabled: bool,
    pub domains_enabled: bool,
    pub edge_ipv4: Option<String>,
    pub edge_ipv6: Option<String>,
    pub edge_cname_target: Option<String>,
    sites_by_slug: Arc<HashMap<String, Arc<SiteRecord>>>,
    sites_by_id: Arc<HashMap<String, Arc<SiteRecord>>>,
    domains_by_host: Arc<HashMap<String, CustomDomainRecord>>,
    routing_ok_domain_ids: Arc<HashSet<String>>,
    deployment_snapshot_upstreams: Arc<HashMap<String, Option<String>>>,
    upstream_overrides: HashMap<String, UpstreamOverride>,
    content_type_headers: Arc<HashMap<String, HeaderValue>>,
}

pub struct SharedRoutes {
    inner: ArcSwap<RouteTable>,
    write_lock: Mutex<()>,
}

impl SharedRoutes {
    pub fn new(initial: RouteTable) -> Self {
        Self {
            inner: ArcSwap::from_pointee(initial),
            write_lock: Mutex::new(()),
        }
    }

    #[inline]
    pub fn load(&self) -> Guard<Arc<RouteTable>> {
        self.inner.load()
    }

    pub fn update<R>(&self, f: impl FnOnce(&mut RouteTable) -> R) -> R {
        let _guard = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut next = (**self.inner.load()).clone();
        let out = f(&mut next);
        self.inner.store(Arc::new(next));
        out
    }
}

impl RouteTable {
    pub fn from_snapshot(snapshot: EdgeSnapshot) -> Self {
        let mut sites_by_slug = HashMap::with_capacity(snapshot.sites.len());
        let mut sites_by_id = HashMap::with_capacity(snapshot.sites.len());
        let mut deployment_snapshot_upstreams = HashMap::with_capacity(snapshot.sites.len());
        let mut content_type_headers = HashMap::new();
        for site in snapshot.sites {
            if let Some(ref dep) = site.live_deployment {
                collect_precomputed_headers(&dep.manifest, &mut content_type_headers);
                deployment_snapshot_upstreams.insert(dep.id.clone(), dep.upstream_addr.clone());
            }
            for dep in site.preview_deployments.values() {
                collect_precomputed_headers(&dep.manifest, &mut content_type_headers);
                deployment_snapshot_upstreams.insert(dep.id.clone(), dep.upstream_addr.clone());
            }
            for dep in site.db_live.iter().chain(site.db_previews.values()) {
                collect_precomputed_headers(&dep.manifest, &mut content_type_headers);
            }
            let arc = Arc::new(site);
            sites_by_slug.insert(arc.slug.clone(), Arc::clone(&arc));
            sites_by_id.insert(arc.id.clone(), arc);
        }
        let mut domains_by_host = HashMap::with_capacity(snapshot.custom_domains.len());
        for domain in snapshot.custom_domains {
            if let Some(norm) = normalize_host(&domain.hostname) {
                domains_by_host.insert(norm, domain);
            }
        }
        Self {
            hosts_domain: snapshot.hosts_domain.to_ascii_lowercase(),
            legacy_hosts_domains: snapshot
                .legacy_hosts_domains
                .into_iter()
                .map(|d| d.to_ascii_lowercase())
                .collect(),
            hosts_enabled: snapshot.hosts_enabled,
            public_enabled: snapshot.public_enabled,
            domains_enabled: snapshot.domains_enabled,
            edge_ipv4: snapshot.edge_ipv4,
            edge_ipv6: snapshot.edge_ipv6,
            edge_cname_target: snapshot.edge_cname_target,
            sites_by_slug: Arc::new(sites_by_slug),
            sites_by_id: Arc::new(sites_by_id),
            domains_by_host: Arc::new(domains_by_host),
            routing_ok_domain_ids: Arc::new(HashSet::new()),
            deployment_snapshot_upstreams: Arc::new(deployment_snapshot_upstreams),
            upstream_overrides: HashMap::new(),
            content_type_headers: Arc::new(content_type_headers),
        }
    }

    #[inline]
    pub fn content_type_header(&self, content_type: &str) -> HeaderValue {
        if let Some(val) = self.content_type_headers.get(content_type) {
            return val.clone();
        }
        HeaderValue::from_str(content_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"))
    }

    #[inline]
    pub fn etag_header(&self, sha256: &str) -> Option<HeaderValue> {
        // WHY: Format 64-byte SHA-256 ETags on the stack instead of duplicating every manifest digest into a RouteTable HashMap.
        let bytes = sha256.as_bytes();
        if bytes.len() == 64 {
            let mut buf = [0u8; 66];
            buf[0] = b'"';
            buf[1..65].copy_from_slice(bytes);
            buf[65] = b'"';
            return HeaderValue::from_bytes(&buf).ok();
        }
        HeaderValue::from_str(&format!("\"{sha256}\"")).ok()
    }

    pub fn apply_snapshot(&mut self, snapshot: EdgeSnapshot) {
        self.apply_prebuilt(Self::from_snapshot(snapshot));
    }

    pub fn apply_prebuilt(&mut self, mut next: RouteTable) {
        if !self.routing_ok_domain_ids.is_empty() {
            next.routing_ok_domain_ids = Arc::new(
                next.domains_by_host
                    .values()
                    .filter(|domain| self.routing_ok_domain_ids.contains(&domain.id))
                    .map(|domain| domain.id.clone())
                    .collect(),
            );
        }
        let old_overrides = std::mem::take(&mut self.upstream_overrides);
        if !old_overrides.is_empty() {
            let mut active_upstreams: HashMap<&str, Option<&str>> = HashMap::new();
            for site in next.sites_by_id.values() {
                if site.taken_down {
                    continue;
                }
                if let Some(ref dep) = site.live_deployment {
                    active_upstreams.insert(dep.id.as_str(), dep.upstream_addr.as_deref());
                }
                for dep in site.preview_deployments.values() {
                    active_upstreams.insert(dep.id.as_str(), dep.upstream_addr.as_deref());
                }
            }
            for (dep_id, ov) in old_overrides {
                let Some(next_snap_addr) = active_upstreams.get(dep_id.as_str()).copied() else {
                    continue;
                };
                match ov {
                    UpstreamOverride::Set(addr) => {
                        if next_snap_addr.is_none() {
                            next.upstream_overrides.insert(dep_id, UpstreamOverride::Set(addr));
                        }
                    }
                    UpstreamOverride::Cleared(cleared_addr) => {
                        if next_snap_addr.is_some() && next_snap_addr == cleared_addr.as_deref() {
                            next.upstream_overrides
                                .insert(dep_id, UpstreamOverride::Cleared(cleared_addr));
                        }
                    }
                }
            }
        }
        *self = next;
    }

    fn snapshot_upstream_for(&self, deployment_id: &str) -> Option<String> {
        self.deployment_snapshot_upstreams
            .get(deployment_id)
            .and_then(|addr| addr.clone())
    }

    pub fn set_upstream_override(&mut self, deployment_id: String, upstream_addr: Option<String>) {
        match upstream_addr {
            Some(addr) => {
                self.upstream_overrides
                    .insert(deployment_id, UpstreamOverride::Set(addr));
            }
            None => {
                let snap_addr = self.snapshot_upstream_for(&deployment_id);
                self.upstream_overrides
                    .insert(deployment_id, UpstreamOverride::Cleared(snap_addr));
            }
        }
    }

    pub fn clear_upstream_if_matches(&mut self, deployment_id: &str, expected_addr: &str) -> bool {
        let snap_addr = self.snapshot_upstream_for(deployment_id);
        let current_matches = match self.upstream_overrides.get(deployment_id) {
            Some(UpstreamOverride::Set(addr)) => addr == expected_addr,
            Some(UpstreamOverride::Cleared(_)) => false,
            None => snap_addr.as_deref() == Some(expected_addr),
        };
        if current_matches {
            self.upstream_overrides
                .insert(deployment_id.to_string(), UpstreamOverride::Cleared(snap_addr));
            true
        } else {
            false
        }
    }

    pub fn custom_domains(&self) -> Vec<CustomDomainRecord> {
        self.domains_by_host.values().cloned().collect()
    }

    pub fn update_domain_status(&mut self, domain_id: &str, status: DomainStatus) -> bool {
        let domains = Arc::make_mut(&mut self.domains_by_host);
        for domain in domains.values_mut() {
            if domain.id == domain_id {
                domain.status = status;
                return true;
            }
        }
        false
    }

    pub fn update_domain_check(&mut self, domain_id: &str, status: DomainStatus, verified: bool) -> bool {
        let domains = Arc::make_mut(&mut self.domains_by_host);
        for domain in domains.values_mut() {
            if domain.id == domain_id {
                domain.status = status;
                domain.consecutive_misses = if verified {
                    0
                } else {
                    domain.consecutive_misses.saturating_add(1)
                };
                return true;
            }
        }
        false
    }

    pub fn update_domain_checks(&mut self, updates: &[(String, DomainStatus, bool)]) -> usize {
        if updates.is_empty() {
            return 0;
        }
        let mut by_id: HashMap<&str, (DomainStatus, bool)> = HashMap::with_capacity(updates.len());
        for (id, status, verified) in updates {
            by_id.insert(id.as_str(), (*status, *verified));
        }
        let any_changed = self.domains_by_host.values().any(|domain| {
            if let Some(&(next_status, verified)) = by_id.get(domain.id.as_str()) {
                let next_misses = if verified {
                    0
                } else {
                    domain.consecutive_misses.saturating_add(1)
                };
                domain.status != next_status || domain.consecutive_misses != next_misses
            } else {
                false
            }
        });
        if !any_changed {
            return 0;
        }
        let domains = Arc::make_mut(&mut self.domains_by_host);
        let mut updated = 0usize;
        for domain in domains.values_mut() {
            if let Some(&(next_status, verified)) = by_id.get(domain.id.as_str()) {
                let next_misses = if verified {
                    0
                } else {
                    domain.consecutive_misses.saturating_add(1)
                };
                if domain.status != next_status || domain.consecutive_misses != next_misses {
                    domain.status = next_status;
                    domain.consecutive_misses = next_misses;
                    updated += 1;
                }
            }
        }
        updated
    }

    pub fn domain_routing_differs(&self, results: &[(String, bool)]) -> bool {
        results
            .iter()
            .any(|(id, routing_ok)| self.routing_ok_domain_ids.contains(id) != *routing_ok)
    }

    pub fn set_domain_routing(&mut self, results: &[(String, bool)]) {
        if !self.domain_routing_differs(results) {
            return;
        }
        let ids = Arc::make_mut(&mut self.routing_ok_domain_ids);
        for (id, routing_ok) in results {
            if *routing_ok {
                ids.insert(id.clone());
            } else {
                ids.remove(id);
            }
        }
    }

    pub fn upstream_for(&self, deployment: &DeploymentRecord) -> Option<String> {
        match self.upstream_overrides.get(&deployment.id) {
            Some(UpstreamOverride::Set(addr)) => Some(addr.clone()),
            Some(UpstreamOverride::Cleared(_)) => None,
            None => deployment.upstream_addr.clone(),
        }
    }

    pub fn is_tls_allowed(&self, raw_domain: &str) -> bool {
        let Some(host) = normalize_host_cow(raw_domain) else {
            return false;
        };
        if let Some(domain) = self.domains_by_host.get(host.as_ref()) {
            if !self.domains_enabled {
                return false;
            }
            if !is_verified(domain.status) && !self.routing_ok_domain_ids.contains(&domain.id) {
                return false;
            }
            return self
                .sites_by_id
                .get(&domain.site_id)
                .map_or(false, |site| !site.taken_down);
        }
        if !self.hosts_enabled {
            return false;
        }
        if let Some((slug, _scope)) = self.parse_platform_site_host(host.as_ref()) {
            return self
                .sites_by_slug
                .get(slug)
                .map_or(false, |site| !site.taken_down);
        }
        false
    }

    pub fn resolve_host(&self, raw_host: &str) -> Option<ResolvedHost> {
        let host = normalize_host_cow(raw_host)?;
        if let Some(domain) = self.domains_by_host.get(host.as_ref()) {
            if !self.domains_enabled {
                return None;
            }
            let site = self.sites_by_id.get(&domain.site_id)?.clone();
            if !is_verified(domain.status) {
                return (!site.taken_down).then_some(ResolvedHost::AlmostReady);
            }
            let redirect = match &site.primary_custom_domain {
                Some(primary) if !domain.is_primary && primary.as_str() != host.as_ref() && !site.taken_down => {
                    Some(primary.clone())
                }
                _ => None,
            };
            return Some(ResolvedHost::Site {
                site,
                scope: HostScope::CustomDomain,
                canonical_redirect: redirect,
            });
        }
        if let Some((slug, scope)) = self.parse_platform_site_host(host.as_ref()) {
            if !self.hosts_enabled {
                return Some(ResolvedHost::UnknownOwnHost { scope });
            }
            if let Some(site) = self.sites_by_slug.get(slug) {
                let redirect = if scope == HostScope::OwnHost && !site.taken_down {
                    site.primary_custom_domain
                        .as_ref()
                        .filter(|primary| {
                            self.domains_enabled
                                && self
                                    .domains_by_host
                                    .get(*primary)
                                    .map_or(false, |d| is_verified(d.status))
                        })
                        .cloned()
                } else {
                    None
                };
                return Some(ResolvedHost::Site {
                    site: Arc::clone(site),
                    scope,
                    canonical_redirect: redirect,
                });
            }
            return Some(ResolvedHost::UnknownOwnHost { scope });
        }
        None
    }

    fn parse_platform_site_host<'a>(&self, host: &'a str) -> Option<(&'a str, HostScope)> {
        let domains = std::iter::once(self.hosts_domain.as_str())
            .chain(self.legacy_hosts_domains.iter().map(String::as_str));
        for base in domains {
            if base.is_empty() {
                continue;
            }
            let suffix_len = base.len() + 1;
            if host.len() > suffix_len && host.ends_with(base) && host.as_bytes()[host.len() - suffix_len] == b'.' {
                let label = &host[..host.len() - suffix_len];
                if label.contains('.') {
                    return None;
                }
                if let Some(slug) = label.strip_suffix("--next") {
                    if is_valid_slug(slug) {
                        return Some((slug, HostScope::NextHost));
                    }
                    return None;
                }
                if let Some((slug, slot_str)) = label.rsplit_once("--p") {
                    if slot_str.len() == 1 {
                        let b = slot_str.as_bytes()[0];
                        if (b'0'..=b'7').contains(&b) && is_valid_slug(slug) {
                            return Some((slug, HostScope::PreviewSlot(b - b'0')));
                        }
                    }
                    return None;
                }
                if is_valid_slug(label) {
                    return Some((label, HostScope::OwnHost));
                }
                return None;
            }
        }
        None
    }
}

fn is_verified(status: DomainStatus) -> bool {
    matches!(status, DomainStatus::DnsVerified | DomainStatus::TlsActive)
}

fn collect_precomputed_headers(
    manifest: &SiteManifest,
    content_types: &mut HashMap<String, HeaderValue>,
) {
    for file in manifest.files.values() {
        if !content_types.contains_key(&file.content_type) {
            let hv = HeaderValue::from_str(&file.content_type)
                .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"));
            content_types.insert(file.content_type.clone(), hv);
        }
    }
}

pub fn normalize_host(raw: &str) -> Option<String> {
    normalize_host_cow(raw).map(Cow::into_owned)
}

pub fn normalize_host_cow(raw: &str) -> Option<Cow<'_, str>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 260 {
        return None;
    }
    let without_port = if trimmed.starts_with('[') {
        return None;
    } else if let Some((h, _port)) = trimmed.split_once(':') {
        h
    } else {
        trimmed
    };
    let stripped = without_port.strip_suffix('.').unwrap_or(without_port);
    if stripped.is_empty() || stripped.len() > 253 {
        return None;
    }
    if stripped.starts_with('.') || stripped.ends_with('.') || stripped.contains("..") {
        return None;
    }
    let mut needs_lower = false;
    for label in stripped.split('.') {
        if label.is_empty() || label.len() > 63 || label.starts_with('-') || label.ends_with('-') {
            return None;
        }
        for b in label.bytes() {
            if matches!(b, b'A'..=b'Z') {
                needs_lower = true;
            } else if !matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'-') {
                return None;
            }
        }
    }
    if needs_lower {
        Some(Cow::Owned(stripped.to_ascii_lowercase()))
    } else {
        Some(Cow::Borrowed(stripped))
    }
}

pub fn is_valid_slug(slug: &str) -> bool {
    if !(3..=48).contains(&slug.len()) {
        return false;
    }
    if slug.starts_with('-') || slug.ends_with('-') || slug.contains("--") {
        return false;
    }
    slug.bytes().all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'-'))
}

pub fn resolve_static_path<'a>(manifest: &'a SiteManifest, raw_path: &'a str) -> StaticResolution<'a> {
    let decoded = percent_decode_path(raw_path);
    let normalized = decoded.trim_start_matches('/');
    if normalized.starts_with("__qorpera") && (normalized.len() == 9 || normalized.as_bytes()[9] == b'/') {
        return StaticResolution::ReservedPlatformPath;
    }
    if normalized.starts_with(".qorpera") && (normalized.len() == 8 || normalized.as_bytes()[8] == b'/') {
        return StaticResolution::ReservedPlatformPath;
    }

    if !manifest.redirects.is_empty() {
        let request_path = format!("/{normalized}");
        for rule in &manifest.redirects {
            if let Some(target) = match_redirect(rule, &request_path) {
                if matches!(rule.status, 301 | 302 | 303 | 307 | 308) {
                    if let Some(safe_loc) = sanitize_redirect_location(&target) {
                        return StaticResolution::Redirect {
                            status: rule.status,
                            location: safe_loc,
                        };
                    }
                    continue;
                }
                if rule.status == 200 {
                    let rewritten = target.trim_start_matches('/');
                    if let Some((key, file)) = manifest.files.get_key_value(rewritten) {
                        return StaticResolution::File {
                            path: Cow::Borrowed(key.as_str()),
                            file,
                            status: 200,
                        };
                    }
                }
            }
        }
    }

    if normalized
        .split('/')
        .any(|seg| seg == ".." || seg == "." || seg.starts_with('.'))
    {
        return StaticResolution::NotFound;
    }

    if normalized.is_empty() {
        if let Some((key, file)) = manifest.files.get_key_value("index.html") {
            return StaticResolution::File {
                path: Cow::Borrowed(key.as_str()),
                file,
                status: 200,
            };
        }
    } else if normalized.ends_with('/') {
        let index = format!("{normalized}index.html");
        if let Some((key, file)) = manifest.files.get_key_value(&index) {
            return StaticResolution::File {
                path: Cow::Borrowed(key.as_str()),
                file,
                status: 200,
            };
        }
    } else {
        if let Some((key, file)) = manifest.files.get_key_value(normalized) {
            return StaticResolution::File {
                path: Cow::Borrowed(key.as_str()),
                file,
                status: 200,
            };
        }
        let html_clean = format!("{normalized}.html");
        if let Some((key, file)) = manifest.files.get_key_value(&html_clean) {
            return StaticResolution::File {
                path: Cow::Borrowed(key.as_str()),
                file,
                status: 200,
            };
        }
        let dir_index = format!("{normalized}/index.html");
        if manifest.files.contains_key(&dir_index) {
            let loc = format!("/{normalized}/");
            if let Some(safe_loc) = sanitize_redirect_location(&loc) {
                return StaticResolution::Redirect {
                    status: 308,
                    location: safe_loc,
                };
            }
        }
    }

    if let Some(spa) = &manifest.spa_fallback {
        let looks_like_asset = normalized
            .rsplit('/')
            .next()
            .map_or(false, |last| last.contains('.'));
        if !looks_like_asset {
            let spa_key = spa.trim_start_matches('/');
            if let Some((key, file)) = manifest.files.get_key_value(spa_key) {
                return StaticResolution::File {
                    path: Cow::Borrowed(key.as_str()),
                    file,
                    status: 200,
                };
            }
        }
    }

    if let Some(not_found) = &manifest.not_found_page {
        let key = not_found.trim_start_matches('/');
        if let Some((k, file)) = manifest.files.get_key_value(key) {
            return StaticResolution::File {
                path: Cow::Borrowed(k.as_str()),
                file,
                status: 404,
            };
        }
    } else if let Some((k, file)) = manifest.files.get_key_value("404.html") {
        return StaticResolution::File {
            path: Cow::Borrowed(k.as_str()),
            file,
            status: 404,
        };
    }

    StaticResolution::NotFound
}

pub fn matching_custom_headers(
    manifest: &SiteManifest,
    path: &str,
    is_public: bool,
) -> Vec<(String, String)> {
    if manifest.headers.is_empty() {
        return Vec::new();
    }
    let normalized = if path.starts_with('/') {
        std::borrow::Cow::Borrowed(path)
    } else {
        std::borrow::Cow::Owned(format!("/{path}"))
    };
    let mut out = Vec::new();
    for rule in &manifest.headers {
        if rule.path_prefix == "*" || normalized.starts_with(&rule.path_prefix) {
            for (k, v) in &rule.headers {
                if is_safe_custom_header(k, is_public) {
                    out.push((k.clone(), v.clone()));
                }
            }
        }
    }
    out
}

fn is_safe_custom_header(name: &str, is_public: bool) -> bool {
    let lower = name.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "set-cookie"
            | "strict-transport-security"
            | "content-length"
            | "transfer-encoding"
            | "connection"
            | "upgrade"
            | "host"
            | "x-qorpera-client-ip"
            | "content-encoding"
            | "etag"
            | "content-range"
            | "accept-ranges"
            | "location"
            | "content-type"
            | "vary"
    ) {
        return false;
    }
    if !is_public
        && matches!(
            lower.as_str(),
            "cache-control"
                | "expires"
                | "cdn-cache-control"
                | "surrogate-control"
                | "x-robots-tag"
                | "cross-origin-resource-policy"
        )
    {
        return false;
    }
    true
}

fn match_redirect(rule: &RedirectRule, request_path: &str) -> Option<String> {
    if let Some(prefix) = rule.from.strip_suffix('*') {
        if let Some(rest) = request_path.strip_prefix(prefix) {
            return Some(rule.to.replace(":splat", rest));
        }
    } else if rule.from == request_path {
        return Some(rule.to.clone());
    }
    None
}

fn percent_decode_path(raw: &str) -> Cow<'_, str> {
    if !raw.contains('%') {
        return Cow::Borrowed(raw);
    }
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                let decoded = (hi << 4) | lo;
                if decoded != 0 {
                    out.push(decoded);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    Cow::Owned(String::from_utf8_lossy(&out).into_owned())
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_snapshot() -> EdgeSnapshot {
        let mut files = HashMap::new();
        files.insert(
            "index.html".to_string(),
            ManifestFile {
                sha256: "a".repeat(64),
                bytes: 12,
                content_type: "text/html; charset=utf-8".to_string(),
                immutable: false,
            },
        );
        files.insert(
            "docs/index.html".to_string(),
            ManifestFile {
                sha256: "b".repeat(64),
                bytes: 10,
                content_type: "text/html; charset=utf-8".to_string(),
                immutable: false,
            },
        );
        files.insert(
            "about.html".to_string(),
            ManifestFile {
                sha256: "c".repeat(64),
                bytes: 10,
                content_type: "text/html; charset=utf-8".to_string(),
                immutable: false,
            },
        );
        EdgeSnapshot {
            hosts_domain: "qorpera.site".to_string(),
            legacy_hosts_domains: vec!["qorpera.com".to_string()],
            hosts_enabled: true,
            public_enabled: true,
            domains_enabled: true,
            sites: vec![SiteRecord {
                id: "site-1".to_string(),
                slug: "nordic-bakery".to_string(),
                is_public: true,
                taken_down: false,
                password_sha256: None,
                password_version: 1,
                live_deployment: Some(DeploymentRecord {
                    id: "dep-1".to_string(),
                    kind: DeploymentKind::Static,
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
                                ("cache-control".to_string(), "public, max-age=3600".to_string()),
                                ("x-robots-tag".to_string(), "index".to_string()),
                                ("x-custom".to_string(), "ok".to_string()),
                            ]),
                        }],
                        spa_fallback: None,
                        not_found_page: None,
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
                primary_custom_domain: Some("nordicbakery.dk".to_string()),
                db_live: None,
                db_previews: HashMap::new(),
            }],
            custom_domains: vec![
                CustomDomainRecord {
                    id: "dom-1".to_string(),
                    site_id: "site-1".to_string(),
                    hostname: "nordicbakery.dk".to_string(),
                    is_apex: true,
                    is_primary: true,
                    status: DomainStatus::TlsActive,
                    verification_token: "tok".to_string(),
                    last_checked_at: None,
                    consecutive_misses: 0,
                },
                CustomDomainRecord {
                    id: "dom-2".to_string(),
                    site_id: "site-1".to_string(),
                    hostname: "www.nordicbakery.dk".to_string(),
                    is_apex: false,
                    is_primary: false,
                    status: DomainStatus::DnsVerified,
                    verification_token: "tok2".to_string(),
                    last_checked_at: None,
                    consecutive_misses: 0,
                },
                CustomDomainRecord {
                    id: "dom-3".to_string(),
                    site_id: "site-1".to_string(),
                    hostname: "unverified.dk".to_string(),
                    is_apex: true,
                    is_primary: false,
                    status: DomainStatus::PendingDns,
                    verification_token: "tok3".to_string(),
                    last_checked_at: None,
                    consecutive_misses: 0,
                },
            ],
            ..Default::default()
        }
    }

    #[test]
    fn tls_allow_blocks_unverified_and_unknown_domains() {
        let table = RouteTable::from_snapshot(sample_snapshot());
        assert!(table.is_tls_allowed("nordicbakery.dk"));
        assert!(table.is_tls_allowed("www.nordicbakery.dk"));
        assert!(table.is_tls_allowed("nordic-bakery.qorpera.site"));
        assert!(table.is_tls_allowed("nordic-bakery--next.qorpera.site"));
        assert!(table.is_tls_allowed("nordic-bakery--p0.qorpera.site"));
        assert!(table.is_tls_allowed("nordic-bakery--p7.qorpera.site"));
        assert!(!table.is_tls_allowed("nordic-bakery--p8.qorpera.site"));
        assert!(!table.is_tls_allowed("nordic-bakery--pab12cd34.qorpera.site"));
        assert!(!table.is_tls_allowed("unverified.dk"));
        assert!(!table.is_tls_allowed("random-attacker.com"));
        assert!(!table.is_tls_allowed("nonexistent.qorpera.site"));
        assert!(!table.is_tls_allowed("nonexistent--p0.qorpera.site"));
        assert!(matches!(
            table.resolve_host("nordic-bakery--p2.qorpera.site"),
            Some(ResolvedHost::Site { scope: HostScope::PreviewSlot(2), canonical_redirect: None, .. })
        ));
    }

    #[test]
    fn tls_allowed_once_routing_points_here_before_the_txt_is_found() {
        let mut table = RouteTable::from_snapshot(sample_snapshot());
        assert!(!table.is_tls_allowed("unverified.dk"));
        assert!(matches!(table.resolve_host("unverified.dk"), Some(ResolvedHost::AlmostReady)));
        assert!(table.resolve_host("random-attacker.com").is_none());

        let routing = vec![("dom-3".to_string(), true), ("dom-unknown".to_string(), true)];
        assert!(table.domain_routing_differs(&routing));
        table.set_domain_routing(&routing);
        assert!(!table.domain_routing_differs(&routing));
        assert!(table.is_tls_allowed("unverified.dk"));
        assert!(!table.is_tls_allowed("random-attacker.com"));
        assert!(matches!(table.resolve_host("unverified.dk"), Some(ResolvedHost::AlmostReady)));

        table.apply_snapshot(sample_snapshot());
        assert!(table.is_tls_allowed("unverified.dk"));

        let mut disabled = sample_snapshot();
        disabled.domains_enabled = false;
        let mut off = table.clone();
        off.apply_snapshot(disabled);
        assert!(!off.is_tls_allowed("unverified.dk"));
        assert!(off.resolve_host("unverified.dk").is_none());

        let mut taken_down = sample_snapshot();
        taken_down.sites[0].taken_down = true;
        let mut down = table.clone();
        down.apply_snapshot(taken_down);
        assert!(!down.is_tls_allowed("unverified.dk"));
        assert!(down.resolve_host("unverified.dk").is_none());

        let mut removed = sample_snapshot();
        removed.custom_domains.retain(|d| d.id != "dom-3");
        table.apply_snapshot(removed);
        assert!(!table.is_tls_allowed("unverified.dk"));
        table.apply_snapshot(sample_snapshot());
        assert!(!table.is_tls_allowed("unverified.dk"));

        table.set_domain_routing(&[("dom-3".to_string(), true)]);
        assert!(table.is_tls_allowed("unverified.dk"));
        table.set_domain_routing(&[("dom-3".to_string(), false)]);
        assert!(!table.is_tls_allowed("unverified.dk"));
    }

    #[test]
    fn resolves_redirects_clean_urls_and_blocks_reserved() {
        let snap = sample_snapshot();
        let manifest = &snap.sites[0].live_deployment.as_ref().unwrap().manifest;
        assert!(matches!(
            resolve_static_path(manifest, "/__qorpera/member"),
            StaticResolution::ReservedPlatformPath
        ));
        assert!(matches!(
            resolve_static_path(manifest, "/%5f%5fqorpera/member"),
            StaticResolution::ReservedPlatformPath
        ));
        assert!(matches!(
            resolve_static_path(manifest, "/docs"),
            StaticResolution::Redirect { status: 308, ref location } if location == "/docs/"
        ));
        assert!(matches!(
            resolve_static_path(manifest, "/about"),
            StaticResolution::File { ref path, status: 200, .. } if path == "about.html"
        ));
        assert!(matches!(
            resolve_static_path(manifest, "/old/bread"),
            StaticResolution::Redirect { status: 301, ref location } if location == "/new/bread"
        ));
        assert!(matches!(
            resolve_static_path(manifest, "/old/%0d%0aX-Evil:1"),
            StaticResolution::NotFound
        ));
        assert!(matches!(
            resolve_static_path(manifest, "/open//evil.com"),
            StaticResolution::NotFound
        ));

        let priv_headers = matching_custom_headers(manifest, "/index.html", false);
        assert_eq!(priv_headers, vec![("x-custom".to_string(), "ok".to_string())]);
        let pub_headers = matching_custom_headers(manifest, "/index.html", true);
        assert!(pub_headers.iter().any(|(k, _)| k == "cache-control"));
    }

    #[test]
    fn apply_snapshot_preserves_live_upstream_overrides() {
        let snap = sample_snapshot();
        let mut table = RouteTable::from_snapshot(snap.clone());
        table.set_upstream_override("dep-1".to_string(), Some("127.0.0.1:45555".to_string()));
        table.set_upstream_override("removed-dep".to_string(), Some("127.0.0.1:49999".to_string()));
        table.apply_snapshot(snap);

        let dep = table.sites_by_id.get("site-1").unwrap().live_deployment.as_ref().unwrap();
        assert_eq!(table.upstream_for(dep).as_deref(), Some("127.0.0.1:45555"));
        assert!(!table.upstream_overrides.contains_key("removed-dep"));

        let mut snap_with_addr = sample_snapshot();
        snap_with_addr.sites[0].live_deployment.as_mut().unwrap().upstream_addr =
            Some("127.0.0.1:41001".to_string());
        let mut t2 = RouteTable::from_snapshot(snap_with_addr.clone());
        t2.set_upstream_override("dep-1".to_string(), None);
        let d2 = t2.sites_by_id.get("site-1").unwrap().live_deployment.as_ref().unwrap();
        assert_eq!(t2.upstream_for(d2), None);
        t2.apply_snapshot(snap_with_addr.clone());
        let d2b = t2.sites_by_id.get("site-1").unwrap().live_deployment.as_ref().unwrap();
        assert_eq!(t2.upstream_for(d2b), None);

        let mut snap_new_addr = snap_with_addr;
        snap_new_addr.sites[0].live_deployment.as_mut().unwrap().upstream_addr =
            Some("127.0.0.1:41002".to_string());
        t2.apply_snapshot(snap_new_addr);
        let site2c = Arc::clone(t2.sites_by_id.get("site-1").unwrap());
        let d2c = site2c.live_deployment.as_ref().unwrap();
        assert_eq!(t2.upstream_for(d2c).as_deref(), Some("127.0.0.1:41002"));
        assert!(!t2.clear_upstream_if_matches("dep-1", "127.0.0.1:41001"));
        assert!(t2.clear_upstream_if_matches("dep-1", "127.0.0.1:41002"));
        assert_eq!(t2.upstream_for(d2c), None);
    }

    #[test]
    fn deserializes_explicit_null_snapshot_fields() {
        let raw = r#"{
            "hosts_domain": null,
            "legacy_hosts_domains": null,
            "hosts_enabled": null,
            "public_enabled": true,
            "domains_enabled": null,
            "sites": [{
                "id": "s1",
                "slug": "null-safe",
                "is_public": true,
                "taken_down": false,
                "password_sha256": null,
                "password_version": 1,
                "live_deployment": {
                    "id": "d1",
                    "kind": "server",
                    "manifest": {"files": null, "redirects": null, "headers": null},
                    "health_path": null,
                    "idle_timeout_sec": null,
                    "memory_mb": null,
                    "vcpu_limit": null,
                    "env_spec": null
                },
                "preview_deployments": null
            }],
            "custom_domains": null
        }"#;
        let parsed: EdgeSnapshot = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.hosts_domain, "qorpera.site");
        assert_eq!(parsed.sites.len(), 1);
        let dep = parsed.sites[0].live_deployment.as_ref().unwrap();
        assert_eq!(dep.health_path, "/");
        assert_eq!(dep.idle_timeout_sec, 900);
        assert_eq!(dep.memory_mb, 512);
    }

    #[test]
    fn snapshot_before_and_after_database_stored_sites() {
        let before = r#"{"hosts_enabled": true, "public_enabled": true, "sites": [{
            "id": "s1", "slug": "old-shape", "is_public": false, "taken_down": false,
            "password_sha256": "aa", "password_version": 2, "live_deployment": null,
            "preview_deployments": {}, "primary_custom_domain": null
        }]}"#;
        let parsed: EdgeSnapshot = serde_json::from_str(before).unwrap();
        let site = &parsed.sites[0];
        assert!(site.db_live.is_none() && site.db_previews.is_empty());
        assert!(site.deployment_for(HostScope::OwnHost, None).is_none());
        assert!(site.deployment_for(HostScope::NextHost, Some("v-2")).is_none());

        let sha = "b".repeat(64);
        let after = format!(
            r#"{{"hosts_enabled": true, "public_enabled": true, "sites": [{{
            "id": "s1", "slug": "new-shape", "is_public": false, "taken_down": false,
            "password_sha256": null, "password_version": 3, "live_deployment": null,
            "preview_deployments": {{}}, "primary_custom_domain": null,
            "db_live": {{"id": "db:v-1", "kind": "static", "manifest": {{"files": {{
                "index.html": {{"sha256": "{sha}", "bytes": 12, "content_type": "text/html; charset=utf-8"}}}}}}}},
            "db_previews": {{
                "v-2": {{"id": "db:v-2", "kind": "static", "manifest": {{"files": {{}}}}}},
                "v-3": {{"id": "db:v-3", "kind": "server", "oci_image_ref": "x", "manifest": {{}}}},
                "v-4": {{"id": "dep-4", "kind": "static", "manifest": {{}}}}
            }},
            "a_key_from_a_later_snapshot": {{"anything": [1, 2]}}
        }}], "another_later_key": true}}"#
        );
        let parsed: EdgeSnapshot = serde_json::from_str(&after).unwrap();
        let site = &parsed.sites[0];
        let live = site.deployment_for(HostScope::OwnHost, None).unwrap();
        assert_eq!(live.deployment.id, "db:v-1");
        assert_eq!(live.db_version_id, Some("v-1"));
        assert_eq!(live.deployment.manifest.files["index.html"].sha256, sha);
        let custom = site.deployment_for(HostScope::CustomDomain, None).unwrap();
        assert_eq!(custom.db_version_id, Some("v-1"));
        let next = site.deployment_for(HostScope::NextHost, Some("v-2")).unwrap();
        assert_eq!(next.db_version_id, Some("v-2"));
        let not_static = site.deployment_for(HostScope::NextHost, Some("v-3")).unwrap();
        assert_eq!(not_static.db_version_id, Some("v-1"));
        let not_db = site.deployment_for(HostScope::NextHost, Some("v-4")).unwrap();
        assert_eq!(not_db.db_version_id, Some("v-1"));
        let unknown = site.deployment_for(HostScope::NextHost, Some("v-9")).unwrap();
        assert_eq!(unknown.db_version_id, Some("v-1"));

        let table = RouteTable::from_snapshot(parsed);
        assert_eq!(
            table.etag_header(&sha).unwrap(),
            HeaderValue::from_str(&format!("\"{sha}\"")).unwrap()
        );
    }

    #[test]
    fn a_deployment_wins_over_database_stored_versions() {
        let mut snap = sample_snapshot();
        let mut db = snap.sites[0].live_deployment.clone().unwrap();
        db.id = "db:v-1".to_string();
        snap.sites[0].db_live = Some(db.clone());
        snap.sites[0].db_previews.insert("v-1".to_string(), db);
        let site = &snap.sites[0];
        let live = site.deployment_for(HostScope::OwnHost, None).unwrap();
        assert_eq!(live.deployment.id, "dep-1");
        assert!(live.db_version_id.is_none());
        let next = site.deployment_for(HostScope::NextHost, None).unwrap();
        assert_eq!(next.deployment.id, "dep-1");
        assert!(next.db_version_id.is_none());
    }
}
