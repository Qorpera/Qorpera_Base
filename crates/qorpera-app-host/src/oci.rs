use bytes::Bytes;
use http::{Method, Request, StatusCode};
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::{Body, Frame};
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

const MAX_JSON_BYTES: usize = 8 * 1024 * 1024;
const MAX_TOTAL_LAYER_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const REGISTRY_TIMEOUT: Duration = Duration::from_secs(30);
const LAYER_TIMEOUT: Duration = Duration::from_secs(180);
const LXD_IMAGE_UPLOAD_TIMEOUT: Duration = Duration::from_secs(180);
const LXD_CONTROL_TIMEOUT: Duration = Duration::from_secs(15);
const MANIFEST_ACCEPT: &str = "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json";

static IMPORT_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone)]
pub struct OciImportConfig {
    pub staging_dir: PathBuf,
    pub init_binary_path: PathBuf,
}

impl Default for OciImportConfig {
    fn default() -> Self {
        Self {
            staging_dir: PathBuf::from("/var/lib/qorpera-app-host/oci-staging"),
            init_binary_path: PathBuf::from("/usr/local/libexec/qorpera-web-hosting/qorpera-oci-init"),
        }
    }
}

#[derive(Default)]
pub struct OciImportLocks {
    by_alias: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl OciImportLocks {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock_for(&self, alias: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut guard = self.by_alias.lock().unwrap_or_else(|e| e.into_inner());
        Arc::clone(
            guard
                .entry(alias.to_string())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedOciRef {
    pub host_port: String,
    pub repo: String,
    pub reference: String,
}

pub fn parse_oci_ref(server: &str, alias: &str) -> Result<ParsedOciRef, String> {
    let host_port = server
        .strip_prefix("http://")
        .ok_or_else(|| format!("oci_import_unsupported_scheme: {server}"))?
        .trim_end_matches('/');
    if host_port.is_empty() || host_port.contains('/') || host_port.contains('@') {
        return Err(format!("oci_import_invalid_registry_host: {server}"));
    }

    let trimmed = alias.trim().trim_start_matches('/');
    let (repo, reference) = if let Some((r, d)) = trimmed.split_once('@') {
        (r, d)
    } else if let Some((r, t)) = trimmed.rsplit_once(':') {
        if !t.contains('/') {
            (r, t)
        } else {
            (trimmed, "latest")
        }
    } else {
        (trimmed, "latest")
    };

    if repo.is_empty()
        || repo.contains("..")
        || repo.starts_with('/')
        || repo.ends_with('/')
        || !repo
            .bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'-' | b'/'))
    {
        return Err(format!("oci_import_invalid_repo: {repo}"));
    }
    if reference.is_empty()
        || reference.contains("..")
        || !reference
            .bytes()
            .all(|b| matches!(b, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'.' | b'_' | b'-' | b':'))
    {
        return Err(format!("oci_import_invalid_reference: {reference}"));
    }

    Ok(ParsedOciRef {
        host_port: host_port.to_string(),
        repo: repo.to_string(),
        reference: reference.to_string(),
    })
}

#[derive(Debug, Deserialize)]
struct OciDescriptor {
    digest: String,
    #[serde(default)]
    platform: Option<OciPlatform>,
}

#[derive(Debug, Deserialize)]
struct OciPlatform {
    #[serde(default)]
    os: String,
    #[serde(default)]
    architecture: String,
}

#[derive(Debug, Deserialize)]
struct OciManifestOrIndex {
    #[serde(default)]
    manifests: Vec<OciDescriptor>,
    #[serde(default)]
    config: Option<OciDescriptor>,
    #[serde(default)]
    layers: Vec<OciDescriptor>,
}

#[derive(Debug, Deserialize)]
struct OciImageConfigDoc {
    #[serde(default)]
    config: OciImageConfigSection,
}

#[derive(Debug, Default, Deserialize)]
struct OciImageConfigSection {
    #[serde(rename = "Entrypoint", default)]
    entrypoint: Option<Vec<String>>,
    #[serde(rename = "Cmd", default)]
    cmd: Option<Vec<String>>,
    #[serde(rename = "WorkingDir", default)]
    working_dir: Option<String>,
    #[serde(rename = "Env", default)]
    env: Option<Vec<String>>,
    #[serde(rename = "User", default)]
    user: Option<String>,
}

#[derive(Debug, Serialize)]
struct OciInitSpecFile {
    entrypoint: Vec<String>,
    cmd: Vec<String>,
    workdir: String,
    env: Vec<String>,
    user: String,
}

#[derive(Debug, Deserialize)]
struct LxdGenericEnvelope {
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

struct TempDirGuard(PathBuf);

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct ChannelBody {
    rx: mpsc::Receiver<Result<Frame<Bytes>, std::io::Error>>,
}

impl Body for ChannelBody {
    type Data = Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        self.rx.poll_recv(cx)
    }
}

fn host_oci_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        _ => "amd64",
    }
}

fn host_lxd_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "aarch64",
        _ => "x86_64",
    }
}

fn validate_digest(digest: &str) -> Result<&str, String> {
    let hex = digest
        .strip_prefix("sha256:")
        .ok_or_else(|| format!("oci_unsupported_digest: {digest}"))?;
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!("oci_invalid_digest: {digest}"));
    }
    Ok(hex)
}

pub fn sha256_hex(data: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];

    let bit_len = (data.len() as u64).wrapping_mul(8);
    let mut padded = Vec::with_capacity(((data.len() + 9 + 63) / 64) * 64);
    padded.extend_from_slice(data);
    padded.push(0x80);
    while (padded.len() % 64) != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in padded.chunks_exact(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    let mut out = String::with_capacity(64);
    for word in h {
        use std::fmt::Write;
        let _ = write!(&mut out, "{word:08x}");
    }
    out
}

async fn registry_get_bytes(
    host_port: &str,
    path: &str,
    accept: Option<&str>,
) -> Result<(StatusCode, Option<String>, Bytes), String> {
    let stream = tokio::time::timeout(REGISTRY_TIMEOUT, tokio::net::TcpStream::connect(host_port))
        .await
        .map_err(|_| format!("oci_registry_connect_timeout: {host_port}"))?
        .map_err(|e| format!("oci_registry_connect_failed ({host_port}): {e}"))?;
    let io = TokioIo::new(stream);
    let (mut sender, conn) = tokio::time::timeout(REGISTRY_TIMEOUT, hyper::client::conn::http1::handshake(io))
        .await
        .map_err(|_| "oci_registry_handshake_timeout".to_string())?
        .map_err(|e| format!("oci_registry_handshake_failed: {e}"))?;
    tokio::spawn(async move {
        let _ = conn.await;
    });

    let mut req_builder = Request::builder()
        .method(Method::GET)
        .uri(path)
        .header("host", host_port);
    if let Some(a) = accept {
        req_builder = req_builder.header("accept", a);
    }
    let req = req_builder
        .body(Full::new(Bytes::new()))
        .map_err(|e| format!("oci_request_build_failed: {e}"))?;

    let res = tokio::time::timeout(REGISTRY_TIMEOUT, sender.send_request(req))
        .await
        .map_err(|_| format!("oci_registry_request_timeout: {path}"))?
        .map_err(|e| format!("oci_registry_request_failed ({path}): {e}"))?;
    let status = res.status();
    let content_digest = res
        .headers()
        .get("docker-content-digest")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string());
    let body = tokio::time::timeout(
        REGISTRY_TIMEOUT,
        Limited::new(res.into_body(), MAX_JSON_BYTES).collect(),
    )
    .await
    .map_err(|_| format!("oci_registry_body_timeout: {path}"))?
    .map_err(|e| format!("oci_registry_body_failed ({path}): {e}"))?
    .to_bytes();
    Ok((status, content_digest, body))
}

async fn registry_download_blob(
    host_port: &str,
    path: &str,
    dest: &Path,
    remaining_budget: &mut u64,
) -> Result<(), String> {
    let stream = tokio::time::timeout(REGISTRY_TIMEOUT, tokio::net::TcpStream::connect(host_port))
        .await
        .map_err(|_| format!("oci_blob_connect_timeout: {host_port}"))?
        .map_err(|e| format!("oci_blob_connect_failed ({host_port}): {e}"))?;
    let io = TokioIo::new(stream);
    let (mut sender, conn) = tokio::time::timeout(REGISTRY_TIMEOUT, hyper::client::conn::http1::handshake(io))
        .await
        .map_err(|_| "oci_blob_handshake_timeout".to_string())?
        .map_err(|e| format!("oci_blob_handshake_failed: {e}"))?;
    tokio::spawn(async move {
        let _ = conn.await;
    });

    let req = Request::builder()
        .method(Method::GET)
        .uri(path)
        .header("host", host_port)
        .body(Full::new(Bytes::new()))
        .map_err(|e| format!("oci_blob_request_build_failed: {e}"))?;

    let res = tokio::time::timeout(LAYER_TIMEOUT, sender.send_request(req))
        .await
        .map_err(|_| format!("oci_blob_request_timeout: {path}"))?
        .map_err(|e| format!("oci_blob_request_failed ({path}): {e}"))?;
    if !res.status().is_success() {
        return Err(format!("oci_blob_http_{}: {path}", res.status().as_u16()));
    }

    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| format!("oci_blob_create_failed: {e}"))?;
    let mut incoming = res.into_body();
    while let Some(frame_res) = tokio::time::timeout(LAYER_TIMEOUT, incoming.frame())
        .await
        .map_err(|_| format!("oci_blob_read_timeout: {path}"))?
    {
        let frame = frame_res.map_err(|e| format!("oci_blob_stream_failed: {e}"))?;
        if let Some(chunk) = frame.data_ref() {
            let len = chunk.len() as u64;
            if len > *remaining_budget {
                return Err("oci_image_exceeds_max_size".to_string());
            }
            *remaining_budget -= len;
            file.write_all(chunk)
                .await
                .map_err(|e| format!("oci_blob_write_failed: {e}"))?;
        }
    }
    file.flush()
        .await
        .map_err(|e| format!("oci_blob_flush_failed: {e}"))?;
    Ok(())
}

#[cfg(unix)]
async fn lxd_json_request(
    socket_path: &Path,
    method: Method,
    path: &str,
    body: Option<serde_json::Value>,
    timeout: Duration,
) -> Result<(StatusCode, LxdGenericEnvelope), String> {
    let stream = tokio::time::timeout(timeout, tokio::net::UnixStream::connect(socket_path))
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
        .uri(path)
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
    let bytes = tokio::time::timeout(timeout, Limited::new(res.into_body(), MAX_JSON_BYTES).collect())
        .await
        .map_err(|_| "lxd_body_timeout".to_string())?
        .map_err(|e| format!("lxd_body_failed: {e}"))?
        .to_bytes();
    let env: LxdGenericEnvelope = serde_json::from_slice(&bytes)
        .map_err(|e| format!("lxd_invalid_json ({}): {e}", status.as_u16()))?;
    Ok((status, env))
}

#[cfg(unix)]
async fn lxd_upload_image_tar(
    socket_path: &Path,
    project: &str,
    tar_path: &Path,
) -> Result<String, String> {
    let file_len = tokio::fs::metadata(tar_path)
        .await
        .map_err(|e| format!("oci_tar_stat_failed: {e}"))?
        .len();
    let mut file = tokio::fs::File::open(tar_path)
        .await
        .map_err(|e| format!("oci_tar_open_failed: {e}"))?;

    let (tx, rx) = mpsc::channel::<Result<Frame<Bytes>, std::io::Error>>(4);
    tokio::spawn(async move {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match file.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(Ok(Frame::data(Bytes::copy_from_slice(&buf[..n])))).await.is_err() {
                        break;
                    }
                }
                Err(err) => {
                    let _ = tx.send(Err(err)).await;
                    break;
                }
            }
        }
    });

    let stream = tokio::time::timeout(LXD_CONTROL_TIMEOUT, tokio::net::UnixStream::connect(socket_path))
        .await
        .map_err(|_| "lxd_upload_connect_timeout".to_string())?
        .map_err(|e| format!("lxd_upload_connect_failed: {e}"))?;
    let io = TokioIo::new(stream);
    let (mut sender, conn) = tokio::time::timeout(LXD_CONTROL_TIMEOUT, hyper::client::conn::http1::handshake(io))
        .await
        .map_err(|_| "lxd_upload_handshake_timeout".to_string())?
        .map_err(|e| format!("lxd_upload_handshake_failed: {e}"))?;
    tokio::spawn(async move {
        let _ = conn.await;
    });

    let path = lxd_project_path("/1.0/images", project);
    let req = Request::builder()
        .method(Method::POST)
        .uri(&path)
        .header("host", "lxd")
        .header("content-type", "application/octet-stream")
        .header("content-length", file_len.to_string())
        .header("x-lxd-public", "false")
        .body(ChannelBody { rx })
        .map_err(|e| format!("lxd_upload_request_build_failed: {e}"))?;

    let res = tokio::time::timeout(LXD_IMAGE_UPLOAD_TIMEOUT, sender.send_request(req))
        .await
        .map_err(|_| "lxd_image_upload_timeout".to_string())?
        .map_err(|e| format!("lxd_image_upload_failed: {e}"))?;
    let status = res.status();
    let bytes = tokio::time::timeout(LXD_CONTROL_TIMEOUT, Limited::new(res.into_body(), MAX_JSON_BYTES).collect())
        .await
        .map_err(|_| "lxd_image_upload_body_timeout".to_string())?
        .map_err(|e| format!("lxd_image_upload_body_failed: {e}"))?
        .to_bytes();
    let env: LxdGenericEnvelope = serde_json::from_slice(&bytes)
        .map_err(|e| format!("lxd_upload_invalid_json ({}): {e}", status.as_u16()))?;
    if status.as_u16() >= 400 || env.kind == "error" {
        return Err(format!("lxd_image_upload_error: {}", env.error));
    }

    if env.kind == "async" {
        if env.operation.is_empty() {
            return Err("lxd_image_upload_missing_operation".to_string());
        }
        let wait_path = match env.operation.split_once('?') {
            Some((base, q)) if !q.is_empty() => format!("{}/wait?{q}&timeout=180", base.trim_end_matches('/')),
            Some((base, _)) => format!("{}/wait?timeout=180", base.trim_end_matches('/')),
            None => format!("{}/wait?timeout=180", env.operation.trim_end_matches('/')),
        };
        let (wait_status, wait_env) = lxd_json_request(
            socket_path,
            Method::GET,
            &wait_path,
            None,
            LXD_IMAGE_UPLOAD_TIMEOUT,
        )
        .await?;
        if wait_status.as_u16() >= 400 || wait_env.kind == "error" {
            return Err(format!("lxd_image_import_wait_error: {}", wait_env.error));
        }
        if let Some(op_err) = wait_env.metadata.get("err").and_then(|v| v.as_str()) {
            if !op_err.is_empty() {
                return Err(format!("lxd_image_import_op_error: {op_err}"));
            }
        }
        let fp = wait_env
            .metadata
            .get("metadata")
            .and_then(|m| m.get("fingerprint"))
            .and_then(|v| v.as_str())
            .or_else(|| wait_env.metadata.get("fingerprint").and_then(|v| v.as_str()))
            .ok_or_else(|| "lxd_image_import_missing_fingerprint".to_string())?;
        return Ok(fp.to_string());
    }

    let fp = env
        .metadata
        .get("fingerprint")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "lxd_image_import_missing_fingerprint".to_string())?;
    Ok(fp.to_string())
}

#[cfg(unix)]
async fn lxd_lookup_alias(socket_path: &Path, project: &str, alias: &str) -> Result<Option<String>, String> {
    let path = lxd_project_path(&format!("/1.0/images/aliases/{alias}"), project);
    let (status, env) = lxd_json_request(socket_path, Method::GET, &path, None, LXD_CONTROL_TIMEOUT).await?;
    if status == StatusCode::NOT_FOUND || env.status_code == 404 {
        return Ok(None);
    }
    if status.as_u16() >= 400 || env.kind == "error" {
        return Err(format!("lxd_alias_lookup_error: {}", env.error));
    }
    Ok(env
        .metadata
        .get("target")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string()))
}

#[cfg(unix)]
async fn lxd_register_alias(
    socket_path: &Path,
    project: &str,
    alias: &str,
    fingerprint: &str,
) -> Result<(), String> {
    let path = lxd_project_path("/1.0/images/aliases", project);
    let body = serde_json::json!({
        "name": alias,
        "target": fingerprint,
    });
    let (status, env) = lxd_json_request(socket_path, Method::POST, &path, Some(body), LXD_CONTROL_TIMEOUT).await?;
    if status == StatusCode::CONFLICT || env.error.to_ascii_lowercase().contains("already exists") {
        return Ok(());
    }
    if status.as_u16() >= 400 || env.kind == "error" {
        return Err(format!("lxd_alias_register_error: {}", env.error));
    }
    Ok(())
}

fn lxd_project_path(base: &str, project: &str) -> String {
    if project.is_empty() || project == "default" {
        base.to_string()
    } else {
        format!("{base}?project={project}")
    }
}

fn safe_join_inside(root: &Path, rel: &Path) -> Result<PathBuf, String> {
    let mut cur = root.to_path_buf();
    for comp in rel.components() {
        match comp {
            Component::CurDir | Component::RootDir | Component::Prefix(_) => continue,
            Component::ParentDir => return Err(format!("oci_tar_path_traversal: {}", rel.display())),
            Component::Normal(part) => {
                if fs::symlink_metadata(&cur)
                    .map(|m| m.file_type().is_symlink())
                    .unwrap_or(false)
                {
                    return Err(format!("oci_whiteout_symlink_blocked: {}", cur.display()));
                }
                cur.push(part);
            }
        }
    }
    Ok(cur)
}

fn remove_path_no_follow(path: &Path) -> Result<(), String> {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return Ok(());
    };
    if meta.file_type().is_dir() {
        ensure_dirs_writable(path);
        fs::remove_dir_all(path).map_err(|e| format!("oci_whiteout_rmdir_failed: {e}"))
    } else {
        fs::remove_file(path).map_err(|e| format!("oci_whiteout_rm_failed: {e}"))
    }
}

#[cfg(unix)]
fn ensure_dirs_writable(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let Ok(meta) = fs::symlink_metadata(dir) else {
        return;
    };
    if !meta.file_type().is_dir() {
        return;
    }
    let mode = meta.permissions().mode();
    if (mode & 0o700) != 0o700 {
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(mode | 0o700));
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if let Ok(em) = fs::symlink_metadata(&p) {
            if em.file_type().is_dir() {
                ensure_dirs_writable(&p);
            }
        }
    }
}

#[cfg(not(unix))]
fn ensure_dirs_writable(_dir: &Path) {}

fn apply_layer_tar(rootfs: &Path, layer_path: &Path) -> Result<(), String> {
    let list_out = Command::new("tar")
        .arg("-tf")
        .arg(layer_path)
        .output()
        .map_err(|e| format!("oci_tar_list_spawn_failed: {e}"))?;
    if !list_out.status.success() {
        return Err(format!(
            "oci_tar_list_failed: {}",
            String::from_utf8_lossy(&list_out.stderr).trim()
        ));
    }

    let mut opaque_dirs: Vec<PathBuf> = Vec::new();
    let mut whiteouts: Vec<PathBuf> = Vec::new();
    for line in String::from_utf8_lossy(&list_out.stdout).lines() {
        let trimmed = line.trim().trim_start_matches("./").trim_start_matches('/');
        if trimmed.is_empty() {
            continue;
        }
        let rel = Path::new(trimmed);
        for comp in rel.components() {
            if matches!(comp, Component::ParentDir) {
                return Err(format!("oci_tar_path_traversal: {trimmed}"));
            }
        }
        if let Some(name) = rel.file_name().and_then(|s| s.to_str()) {
            let parent = rel.parent().unwrap_or_else(|| Path::new(""));
            if name == ".wh..wh..opq" {
                opaque_dirs.push(parent.to_path_buf());
            } else if let Some(target_name) = name.strip_prefix(".wh.") {
                if !target_name.is_empty() && target_name != "." && target_name != ".." {
                    whiteouts.push(parent.join(target_name));
                }
            }
        }
    }

    ensure_dirs_writable(rootfs);

    for rel_dir in opaque_dirs {
        let dir_path = safe_join_inside(rootfs, &rel_dir)?;
        if let Ok(meta) = fs::symlink_metadata(&dir_path) {
            if meta.file_type().is_dir() {
                if let Ok(entries) = fs::read_dir(&dir_path) {
                    for entry in entries.flatten() {
                        remove_path_no_follow(&entry.path())?;
                    }
                }
            }
        }
    }

    for rel_target in whiteouts {
        let target_path = safe_join_inside(rootfs, &rel_target)?;
        remove_path_no_follow(&target_path)?;
    }

    let mut cmd = Command::new("tar");
    cmd.arg("-xf")
        .arg(layer_path)
        .arg("-C")
        .arg(rootfs)
        .arg("--no-same-owner")
        .arg("--exclude=.wh.*")
        .arg("--exclude=*/.wh.*");
    #[cfg(target_os = "linux")]
    cmd.arg("--delay-directory-restore");

    let ext_out = cmd
        .output()
        .map_err(|e| format!("oci_tar_extract_spawn_failed: {e}"))?;
    if !ext_out.status.success() {
        return Err(format!(
            "oci_tar_extract_failed: {}",
            String::from_utf8_lossy(&ext_out.stderr).trim()
        ));
    }
    Ok(())
}

fn resolve_rootfs_dir_following_internal_symlink(rootfs: &Path, sub: &str) -> Result<PathBuf, String> {
    let direct = rootfs.join(sub);
    if let Ok(meta) = fs::symlink_metadata(&direct) {
        if meta.file_type().is_symlink() {
            let target = fs::read_link(&direct)
                .map_err(|e| format!("oci_readlink_failed ({sub}): {e}"))?;
            let stripped = target
                .to_str()
                .ok_or_else(|| format!("oci_non_utf8_symlink: {sub}"))?
                .trim_start_matches('/');
            let resolved = safe_join_inside(rootfs, Path::new(stripped))?;
            fs::create_dir_all(&resolved).map_err(|e| format!("oci_mkdir_failed: {e}"))?;
            return Ok(resolved);
        }
    }
    fs::create_dir_all(&direct).map_err(|e| format!("oci_mkdir_failed ({sub}): {e}"))?;
    Ok(direct)
}

fn sh_single_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str("'\"'\"'");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

fn build_fallback_sh_init(spec: &OciInitSpecFile) -> String {
    let mut lines = vec![
        "#!/bin/sh".to_string(),
        "set -e".to_string(),
        "ip link set lo up 2>/dev/null || true".to_string(),
    ];
    for kv in &spec.env {
        if let Some((k, v)) = kv.split_once('=') {
            if !k.is_empty() && k.bytes().all(|b| matches!(b, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_')) {
                lines.push(format!(
                    "if [ -z \"${{{k}+x}}\" ]; then export {k}={}; fi",
                    sh_single_quote(v)
                ));
            }
        }
    }
    let wd = if spec.workdir.is_empty() { "/" } else { spec.workdir.as_str() };
    lines.push(format!("cd {}", sh_single_quote(wd)));
    let mut argv = Vec::with_capacity(spec.entrypoint.len() + spec.cmd.len());
    argv.extend(spec.entrypoint.iter().cloned());
    argv.extend(spec.cmd.iter().cloned());
    let cmd_str = argv.iter().map(|a| sh_single_quote(a)).collect::<Vec<_>>().join(" ");
    lines.push(format!("exec {cmd_str}"));
    lines.join("\n") + "\n"
}

fn assemble_lxd_tarball(
    work_dir: &Path,
    layers: &[PathBuf],
    img_cfg: &OciImageConfigSection,
    init_binary_path: &Path,
) -> Result<PathBuf, String> {
    let rootfs = work_dir.join("rootfs");
    fs::create_dir_all(&rootfs).map_err(|e| format!("oci_rootfs_mkdir_failed: {e}"))?;

    for layer in layers {
        apply_layer_tar(&rootfs, layer)?;
    }

    let sbin_dir = resolve_rootfs_dir_following_internal_symlink(&rootfs, "sbin")?;
    let etc_dir = resolve_rootfs_dir_following_internal_symlink(&rootfs, "etc")?;
    let tmp_dir = resolve_rootfs_dir_following_internal_symlink(&rootfs, "tmp")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp_dir, fs::Permissions::from_mode(0o1777));
    }

    let resolv_path = etc_dir.join("resolv.conf");
    if let Ok(meta) = fs::symlink_metadata(&resolv_path) {
        if meta.file_type().is_symlink() {
            let _ = fs::remove_file(&resolv_path);
        }
    }

    let spec = OciInitSpecFile {
        entrypoint: img_cfg.entrypoint.clone().unwrap_or_default(),
        cmd: img_cfg.cmd.clone().unwrap_or_default(),
        workdir: img_cfg.working_dir.clone().unwrap_or_else(|| "/".to_string()),
        env: img_cfg.env.clone().unwrap_or_default(),
        user: img_cfg.user.clone().unwrap_or_default(),
    };
    let spec_bytes = serde_json::to_vec_pretty(&spec).map_err(|e| e.to_string())?;
    fs::write(etc_dir.join("qorpera-oci-init.json"), spec_bytes)
        .map_err(|e| format!("oci_write_init_spec_failed: {e}"))?;

    let init_path = sbin_dir.join("init");
    if fs::symlink_metadata(&init_path).is_ok() {
        // WHY: Alpine and Debian images symlink /sbin/init; unlink first so writing init never overwrites symlink targets.
        fs::remove_file(&init_path).map_err(|e| format!("oci_unlink_existing_init_failed: {e}"))?;
    }
    if init_binary_path.is_file() {
        fs::copy(init_binary_path, &init_path)
            .map_err(|e| format!("oci_copy_init_binary_failed: {e}"))?;
    } else {
        fs::write(&init_path, build_fallback_sh_init(&spec))
            .map_err(|e| format!("oci_write_fallback_init_failed: {e}"))?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&init_path, fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("oci_chmod_init_failed: {e}"))?;
    }

    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let metadata_yaml = format!(
        "architecture: {}\ncreation_date: {now_secs}\nproperties:\n  description: qorpera-oci\n",
        host_lxd_arch()
    );
    fs::write(work_dir.join("metadata.yaml"), metadata_yaml)
        .map_err(|e| format!("oci_write_metadata_failed: {e}"))?;

    let tar_path = work_dir.join("lxd-image.tar");
    let pack = Command::new("tar")
        .arg("-cf")
        .arg(&tar_path)
        .arg("-C")
        .arg(work_dir)
        .arg("metadata.yaml")
        .arg("rootfs")
        .output()
        .map_err(|e| format!("oci_tar_pack_spawn_failed: {e}"))?;
    if !pack.status.success() {
        return Err(format!(
            "oci_tar_pack_failed: {}",
            String::from_utf8_lossy(&pack.stderr).trim()
        ));
    }
    Ok(tar_path)
}

#[cfg(unix)]
pub async fn ensure_oci_image_imported(
    socket_path: &Path,
    project: &str,
    server: &str,
    alias_ref: &str,
    config: &OciImportConfig,
    locks: &OciImportLocks,
) -> Result<String, String> {
    let parsed = parse_oci_ref(server, alias_ref)?;

    let (manifest_digest_hex, manifest_doc) =
        fetch_resolved_manifest(&parsed.host_port, &parsed.repo, &parsed.reference).await?;
    let lxd_alias = format!("qoci-v1-{}", &manifest_digest_hex[..32]);

    if let Some(fp) = lxd_lookup_alias(socket_path, project, &lxd_alias).await? {
        return Ok(fp);
    }

    let alias_lock = locks.lock_for(&lxd_alias);
    let _guard = alias_lock.lock().await;

    if let Some(fp) = lxd_lookup_alias(socket_path, project, &lxd_alias).await? {
        return Ok(fp);
    }

    let cfg_desc = manifest_doc
        .config
        .ok_or_else(|| "oci_manifest_missing_config".to_string())?;
    validate_digest(&cfg_desc.digest)?;
    if manifest_doc.layers.is_empty() {
        return Err("oci_manifest_missing_layers".to_string());
    }
    for layer in &manifest_doc.layers {
        validate_digest(&layer.digest)?;
    }

    let cfg_path = format!("/v2/{}/blobs/{}", parsed.repo, cfg_desc.digest);
    let (cfg_status, _, cfg_bytes) = registry_get_bytes(&parsed.host_port, &cfg_path, None).await?;
    if !cfg_status.is_success() {
        return Err(format!("oci_config_http_{}", cfg_status.as_u16()));
    }
    let cfg_doc: OciImageConfigDoc = serde_json::from_slice(&cfg_bytes)
        .map_err(|e| format!("oci_config_invalid_json: {e}"))?;

    let seq = IMPORT_SEQ.fetch_add(1, Ordering::Relaxed);
    let staging_base = if fs::create_dir_all(&config.staging_dir).is_ok() {
        config.staging_dir.clone()
    } else {
        let fallback = std::env::temp_dir().join("qorpera-oci-staging");
        fs::create_dir_all(&fallback).map_err(|e| format!("oci_staging_mkdir_failed: {e}"))?;
        fallback
    };
    let work_dir = staging_base.join(format!("import-{}-{seq}", std::process::id()));
    fs::create_dir_all(&work_dir).map_err(|e| format!("oci_workdir_mkdir_failed: {e}"))?;
    let _cleanup = TempDirGuard(work_dir.clone());

    let mut remaining_budget = MAX_TOTAL_LAYER_BYTES;
    let mut layer_paths = Vec::with_capacity(manifest_doc.layers.len());
    for (idx, layer) in manifest_doc.layers.iter().enumerate() {
        let blob_path = format!("/v2/{}/blobs/{}", parsed.repo, layer.digest);
        let dest = work_dir.join(format!("layer-{idx}.tar"));
        registry_download_blob(&parsed.host_port, &blob_path, &dest, &mut remaining_budget).await?;
        layer_paths.push(dest);
    }

    let work_clone = work_dir.clone();
    let init_bin = config.init_binary_path.clone();
    let tar_path = tokio::task::spawn_blocking(move || {
        assemble_lxd_tarball(&work_clone, &layer_paths, &cfg_doc.config, &init_bin)
    })
    .await
    .map_err(|e| format!("oci_assemble_join_failed: {e}"))??;

    let fingerprint = lxd_upload_image_tar(socket_path, project, &tar_path).await?;
    lxd_register_alias(socket_path, project, &lxd_alias, &fingerprint).await?;
    Ok(fingerprint)
}

#[cfg(not(unix))]
pub async fn ensure_oci_image_imported(
    _socket_path: &Path,
    _project: &str,
    _server: &str,
    _alias_ref: &str,
    _config: &OciImportConfig,
    _locks: &OciImportLocks,
) -> Result<String, String> {
    Err("oci_import_requires_unix".to_string())
}

async fn fetch_resolved_manifest(
    host_port: &str,
    repo: &str,
    reference: &str,
) -> Result<(String, OciManifestOrIndex), String> {
    let path = format!("/v2/{repo}/manifests/{reference}");
    let (status, header_digest, bytes) =
        registry_get_bytes(host_port, &path, Some(MANIFEST_ACCEPT)).await?;
    if !status.is_success() {
        return Err(format!("oci_manifest_http_{}: {path}", status.as_u16()));
    }
    let doc: OciManifestOrIndex = serde_json::from_slice(&bytes)
        .map_err(|e| format!("oci_manifest_invalid_json: {e}"))?;

    if !doc.manifests.is_empty() && doc.layers.is_empty() {
        let want_arch = host_oci_arch();
        let chosen = doc
            .manifests
            .iter()
            .find(|m| {
                m.platform
                    .as_ref()
                    .map(|p| p.os == "linux" && p.architecture == want_arch)
                    .unwrap_or(false)
            })
            .or_else(|| {
                doc.manifests.iter().find(|m| {
                    m.platform
                        .as_ref()
                        .map(|p| p.os == "linux")
                        .unwrap_or(false)
                })
            })
            .or_else(|| doc.manifests.first())
            .ok_or_else(|| "oci_index_empty".to_string())?;
        validate_digest(&chosen.digest)?;
        let child_path = format!("/v2/{repo}/manifests/{}", chosen.digest);
        let (c_status, c_header, c_bytes) =
            registry_get_bytes(host_port, &child_path, Some(MANIFEST_ACCEPT)).await?;
        if !c_status.is_success() {
            return Err(format!("oci_child_manifest_http_{}: {child_path}", c_status.as_u16()));
        }
        let child_doc: OciManifestOrIndex = serde_json::from_slice(&c_bytes)
            .map_err(|e| format!("oci_child_manifest_invalid_json: {e}"))?;
        let digest_hex = c_header
            .as_deref()
            .and_then(|d| validate_digest(d).ok())
            .or_else(|| validate_digest(&chosen.digest).ok())
            .map(|h| h.to_ascii_lowercase())
            .unwrap_or_else(|| sha256_hex(&c_bytes));
        return Ok((digest_hex, child_doc));
    }

    let digest_hex = header_digest
        .as_deref()
        .and_then(|d| validate_digest(d).ok())
        .or_else(|| validate_digest(reference).ok())
        .map(|h| h.to_ascii_lowercase())
        .unwrap_or_else(|| sha256_hex(&bytes));
    Ok((digest_hex, doc))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_standard_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn parses_oci_refs_and_rejects_traversal() {
        let by_digest = parse_oci_ref(
            "http://127.0.0.1:5000",
            "qorpera-apps/shop@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        )
        .unwrap();
        assert_eq!(by_digest.host_port, "127.0.0.1:5000");
        assert_eq!(by_digest.repo, "qorpera-apps/shop");
        assert!(by_digest.reference.starts_with("sha256:"));

        let by_tag = parse_oci_ref("http://127.0.0.1:5000", "qorpera-apps/shop:v2").unwrap();
        assert_eq!(by_tag.repo, "qorpera-apps/shop");
        assert_eq!(by_tag.reference, "v2");

        assert!(parse_oci_ref("http://127.0.0.1:5000", "../escape:v1").is_err());
        assert!(parse_oci_ref("https://registry.example.com", "a/b:v1").is_err());
    }

    #[test]
    fn assemble_handles_whiteouts_and_unlinks_init_symlink() {
        let work = std::env::temp_dir().join(format!(
            "qorpera-oci-unit-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _guard = TempDirGuard(work.clone());
        fs::create_dir_all(&work).unwrap();

        let l1_src = work.join("l1");
        fs::create_dir_all(l1_src.join("sbin")).unwrap();
        fs::create_dir_all(l1_src.join("app")).unwrap();
        fs::write(l1_src.join("app/keep.txt"), "keep").unwrap();
        fs::write(l1_src.join("app/delete-me.txt"), "gone").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/bin/busybox", l1_src.join("sbin/init")).unwrap();
        let l1_tar = work.join("l1.tar");
        assert!(Command::new("tar")
            .args(["-cf", l1_tar.to_str().unwrap(), "-C", l1_src.to_str().unwrap(), "."])
            .status()
            .unwrap()
            .success());

        let l2_src = work.join("l2");
        fs::create_dir_all(l2_src.join("app")).unwrap();
        fs::write(l2_src.join("app/.wh.delete-me.txt"), "").unwrap();
        let l2_tar = work.join("l2.tar");
        assert!(Command::new("tar")
            .args(["-cf", l2_tar.to_str().unwrap(), "-C", l2_src.to_str().unwrap(), "."])
            .status()
            .unwrap()
            .success());

        let assemble_dir = work.join("assemble");
        fs::create_dir_all(&assemble_dir).unwrap();
        let cfg = OciImageConfigSection {
            entrypoint: Some(vec!["/bin/sh".to_string()]),
            cmd: Some(vec!["-c".to_string(), "echo hi".to_string()]),
            working_dir: Some("/app".to_string()),
            env: Some(vec!["PORT=3000".to_string()]),
            user: None,
        };
        let fake_init = work.join("nonexistent-init-binary");
        let out_tar = assemble_lxd_tarball(&assemble_dir, &[l1_tar, l2_tar], &cfg, &fake_init).unwrap();
        assert!(out_tar.is_file());
        assert!(assemble_dir.join("rootfs/app/keep.txt").is_file());
        assert!(!assemble_dir.join("rootfs/app/delete-me.txt").exists());
        let init_meta = fs::symlink_metadata(assemble_dir.join("rootfs/sbin/init")).unwrap();
        assert!(!init_meta.file_type().is_symlink());
        let spec_json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(assemble_dir.join("rootfs/etc/qorpera-oci-init.json")).unwrap())
                .unwrap();
        assert_eq!(spec_json["workdir"], "/app");
        assert_eq!(spec_json["cmd"][1], "echo hi");
    }
}
