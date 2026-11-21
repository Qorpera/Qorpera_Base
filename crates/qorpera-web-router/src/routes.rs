use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

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
    #[serde(default)]
    pub files: HashMap<String, ManifestFile>,
    #[serde(default)]
    pub redirects: Vec<RedirectRule>,
    #[serde(default)]
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
    #[serde(default)]
    pub manifest: SiteManifest,
    #[serde(default)]
    pub upstream_addr: Option<String>,
    #[serde(default)]
    pub oci_image_ref: Option<String>,
    #[serde(default = "default_health_path")]
    pub health_path: String,
    #[serde(default = "default_idle_timeout")]
    pub idle_timeout_sec: u64,
}

fn default_health_path() -> String {
    "/".to_string()
}

fn default_idle_timeout() -> u64 {
    900
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
    #[serde(default)]
    pub preview_deployments: HashMap<String, DeploymentRecord>,
    #[serde(default)]
    pub primary_custom_domain: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EdgeSnapshot {
    #[serde(default = "default_hosts_domain")]
    pub hosts_domain: String,
    #[serde(default)]
    pub legacy_hosts_domains: Vec<String>,
    #[serde(default)]
    pub hosts_enabled: bool,
    #[serde(default)]
    pub public_enabled: bool,
    #[serde(default)]
    pub domains_enabled: bool,
    #[serde(default)]
    pub edge_ipv4: Option<String>,
    #[serde(default)]
    pub edge_ipv6: Option<String>,
    #[serde(default)]
    pub edge_cname_target: Option<String>,
    #[serde(default)]
    pub sites: Vec<SiteRecord>,
    #[serde(default)]
    pub custom_domains: Vec<CustomDomainRecord>,
}

fn default_hosts_domain() -> String {
    "qorpera.site".to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostScope {
    OwnHost,
    NextHost,
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
}

#[derive(Debug, Clone)]
pub enum StaticResolution {
    ReservedPlatformPath,
    Redirect {
        status: u16,
        location: String,
    },
    File {
        path: String,
        file: ManifestFile,
        status: u16,
    },
    NotFound,
}

pub struct RouteTable {
    pub hosts_domain: String,
    pub legacy_hosts_domains: Vec<String>,
    pub hosts_enabled: bool,
    pub public_enabled: bool,
    pub domains_enabled: bool,
    pub edge_ipv4: Option<String>,
    pub edge_ipv6: Option<String>,
    pub edge_cname_target: Option<String>,
    sites_by_slug: HashMap<String, Arc<SiteRecord>>,
    sites_by_id: HashMap<String, Arc<SiteRecord>>,
    domains_by_host: HashMap<String, CustomDomainRecord>,
    upstream_overrides: HashMap<String, String>,
}

impl RouteTable {
    pub fn from_snapshot(snapshot: EdgeSnapshot) -> Self {
        let mut sites_by_slug = HashMap::with_capacity(snapshot.sites.len());
        let mut sites_by_id = HashMap::with_capacity(snapshot.sites.len());
        for site in snapshot.sites {
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
            sites_by_slug,
            sites_by_id,
            domains_by_host,
            upstream_overrides: HashMap::new(),
        }
    }

    pub fn set_upstream_override(&mut self, deployment_id: String, upstream_addr: Option<String>) {
        match upstream_addr {
            Some(addr) => {
                self.upstream_overrides.insert(deployment_id, addr);
            }
            None => {
                self.upstream_overrides.remove(&deployment_id);
            }
        }
    }

    pub fn upstream_for(&self, deployment: &DeploymentRecord) -> Option<String> {
        self.upstream_overrides
            .get(&deployment.id)
            .cloned()
            .or_else(|| deployment.upstream_addr.clone())
    }

    pub fn is_tls_allowed(&self, raw_domain: &str) -> bool {
        let Some(host) = normalize_host(raw_domain) else {
            return false;
        };
        if let Some(domain) = self.domains_by_host.get(&host) {
            if !self.domains_enabled {
                return false;
            }
            if !matches!(domain.status, DomainStatus::DnsVerified | DomainStatus::TlsActive) {
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
        if let Some((slug, _scope)) = self.parse_platform_site_host(&host) {
            return self
                .sites_by_slug
                .get(slug)
                .map_or(false, |site| !site.taken_down);
        }
        false
    }

    pub fn resolve_host(&self, raw_host: &str) -> Option<ResolvedHost> {
        let host = normalize_host(raw_host)?;
        if let Some(domain) = self.domains_by_host.get(&host) {
            if !self.domains_enabled {
                return None;
            }
            if !matches!(domain.status, DomainStatus::DnsVerified | DomainStatus::TlsActive) {
                return None;
            }
            let site = self.sites_by_id.get(&domain.site_id)?.clone();
            let redirect = match &site.primary_custom_domain {
                Some(primary) if !domain.is_primary && primary != &host && !site.taken_down => {
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
        if let Some((slug, scope)) = self.parse_platform_site_host(&host) {
            if !self.hosts_enabled {
                return Some(ResolvedHost::UnknownOwnHost { scope });
            }
            if let Some(site) = self.sites_by_slug.get(slug) {
                let redirect = if scope == HostScope::OwnHost && !site.taken_down {
                    site.primary_custom_domain
                        .as_ref()
                        .filter(|primary| {
                            self.domains_enabled
                                && self.domains_by_host.get(*primary).map_or(false, |d| {
                                    matches!(d.status, DomainStatus::DnsVerified | DomainStatus::TlsActive)
                                })
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
                if is_valid_slug(label) {
                    return Some((label, HostScope::OwnHost));
                }
                return None;
            }
        }
        None
    }
}

pub fn normalize_host(raw: &str) -> Option<String> {
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
    let lower = stripped.to_ascii_lowercase();
    if lower.starts_with('.') || lower.ends_with('.') || lower.contains("..") {
        return None;
    }
    for label in lower.split('.') {
        if label.is_empty() || label.len() > 63 || label.starts_with('-') || label.ends_with('-') {
            return None;
        }
        if !label.bytes().all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'-')) {
            return None;
        }
    }
    Some(lower)
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

pub fn resolve_static_path(manifest: &SiteManifest, raw_path: &str) -> StaticResolution {
    let decoded = percent_decode_path(raw_path);
    let normalized = decoded.trim_start_matches('/');
    if normalized.starts_with("__qorpera") && (normalized.len() == 9 || normalized.as_bytes()[9] == b'/') {
        return StaticResolution::ReservedPlatformPath;
    }
    if normalized.starts_with(".qorpera") && (normalized.len() == 8 || normalized.as_bytes()[8] == b'/') {
        return StaticResolution::ReservedPlatformPath;
    }

    let request_path = format!("/{normalized}");
    for rule in &manifest.redirects {
        if let Some(target) = match_redirect(rule, &request_path) {
            if matches!(rule.status, 301 | 302 | 303 | 307 | 308) {
                return StaticResolution::Redirect {
                    status: rule.status,
                    location: target,
                };
            }
            if rule.status == 200 {
                let rewritten = target.trim_start_matches('/');
                if let Some(file) = manifest.files.get(rewritten) {
                    return StaticResolution::File {
                        path: rewritten.to_string(),
                        file: file.clone(),
                        status: 200,
                    };
                }
            }
        }
    }

    if normalized.split('/').any(|seg| seg == ".." || seg == "." || seg.starts_with('.')) {
        return StaticResolution::NotFound;
    }

    if normalized.is_empty() {
        if let Some(file) = manifest.files.get("index.html") {
            return StaticResolution::File {
                path: "index.html".to_string(),
                file: file.clone(),
                status: 200,
            };
        }
    } else if normalized.ends_with('/') {
        let index = format!("{normalized}index.html");
        if let Some(file) = manifest.files.get(&index) {
            return StaticResolution::File {
                path: index,
                file: file.clone(),
                status: 200,
            };
        }
    } else {
        if let Some(file) = manifest.files.get(normalized) {
            return StaticResolution::File {
                path: normalized.to_string(),
                file: file.clone(),
                status: 200,
            };
        }
        let html_clean = format!("{normalized}.html");
        if let Some(file) = manifest.files.get(&html_clean) {
            return StaticResolution::File {
                path: html_clean,
                file: file.clone(),
                status: 200,
            };
        }
        let dir_index = format!("{normalized}/index.html");
        if manifest.files.contains_key(&dir_index) {
            return StaticResolution::Redirect {
                status: 308,
                location: format!("/{normalized}/"),
            };
        }
    }

    if let Some(spa) = &manifest.spa_fallback {
        let looks_like_asset = normalized
            .rsplit('/')
            .next()
            .map_or(false, |last| last.contains('.'));
        if !looks_like_asset {
            if let Some(file) = manifest.files.get(spa.trim_start_matches('/')) {
                return StaticResolution::File {
                    path: spa.trim_start_matches('/').to_string(),
                    file: file.clone(),
                    status: 200,
                };
            }
        }
    }

    if let Some(not_found) = &manifest.not_found_page {
        let key = not_found.trim_start_matches('/');
        if let Some(file) = manifest.files.get(key) {
            return StaticResolution::File {
                path: key.to_string(),
                file: file.clone(),
                status: 404,
            };
        }
    } else if let Some(file) = manifest.files.get("404.html") {
        return StaticResolution::File {
            path: "404.html".to_string(),
            file: file.clone(),
            status: 404,
        };
    }

    StaticResolution::NotFound
}

pub fn matching_custom_headers(manifest: &SiteManifest, path: &str) -> Vec<(String, String)> {
    let normalized = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    let mut out = Vec::new();
    for rule in &manifest.headers {
        if rule.path_prefix == "*" || normalized.starts_with(&rule.path_prefix) {
            for (k, v) in &rule.headers {
                if is_safe_custom_header(k) {
                    out.push((k.clone(), v.clone()));
                }
            }
        }
    }
    out
}

fn is_safe_custom_header(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    !matches!(
        lower.as_str(),
        "set-cookie"
            | "strict-transport-security"
            | "content-length"
            | "transfer-encoding"
            | "connection"
            | "upgrade"
            | "host"
            | "x-qorpera-client-ip"
    )
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

fn percent_decode_path(raw: &str) -> String {
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
    String::from_utf8_lossy(&out).into_owned()
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
                        redirects: vec![RedirectRule {
                            from: "/old/*".to_string(),
                            to: "/new/:splat".to_string(),
                            status: 301,
                        }],
                        headers: vec![],
                        spa_fallback: None,
                        not_found_page: None,
                    },
                    upstream_addr: None,
                    oci_image_ref: None,
                    health_path: "/".to_string(),
                    idle_timeout_sec: 900,
                }),
                preview_deployments: HashMap::new(),
                primary_custom_domain: Some("nordicbakery.dk".to_string()),
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
                },
                CustomDomainRecord {
                    id: "dom-2".to_string(),
                    site_id: "site-1".to_string(),
                    hostname: "www.nordicbakery.dk".to_string(),
                    is_apex: false,
                    is_primary: false,
                    status: DomainStatus::DnsVerified,
                    verification_token: "tok2".to_string(),
                },
                CustomDomainRecord {
                    id: "dom-3".to_string(),
                    site_id: "site-1".to_string(),
                    hostname: "unverified.dk".to_string(),
                    is_apex: true,
                    is_primary: false,
                    status: DomainStatus::PendingDns,
                    verification_token: "tok3".to_string(),
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
        assert!(!table.is_tls_allowed("unverified.dk"));
        assert!(!table.is_tls_allowed("random-attacker.com"));
        assert!(!table.is_tls_allowed("nonexistent.qorpera.site"));
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
    }
}
