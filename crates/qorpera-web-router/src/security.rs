use http::{HeaderMap, Method};
use sha2::{Digest, Sha256};
use std::net::IpAddr;
use subtle::ConstantTimeEq;

pub const SITE_SESSION_COOKIE: &str = "__Host-qorpera_site";
pub const CLIENT_IP_HEADER: &str = "x-qorpera-client-ip";
pub const HSTS_HEADER: &str = "max-age=31536000";

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    bool::from(a.ct_eq(b))
}

pub fn extract_client_ip(headers: &HeaderMap, peer_ip: IpAddr, trusted_proxies: &[IpAddr]) -> String {
    let trusted = peer_ip.is_loopback() || trusted_proxies.contains(&peer_ip);
    if trusted {
        if let Some(val) = headers.get(CLIENT_IP_HEADER).and_then(|v| v.to_str().ok()) {
            if let Ok(parsed) = val.trim().parse::<IpAddr>() {
                return normalize_ip_bucket(parsed);
            }
        }
    }
    normalize_ip_bucket(peer_ip)
}

fn normalize_ip_bucket(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                v4.to_string()
            } else {
                let segs = v6.segments();
                format!("{:x}:{:x}:{:x}:{:x}::/64", segs[0], segs[1], segs[2], segs[3])
            }
        }
    }
}

pub fn check_cross_site_write(method: &Method, headers: &HeaderMap, expected_host: &str) -> bool {
    if matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS) {
        return true;
    }
    if let Some(sfs) = headers.get("sec-fetch-site").and_then(|v| v.to_str().ok()) {
        let lower = sfs.trim().to_ascii_lowercase();
        if lower == "same-site" || lower == "cross-site" {
            return false;
        }
    }
    if let Some(origin) = headers.get("origin").and_then(|v| v.to_str().ok()) {
        let trimmed = origin.trim();
        let expected = format!("https://{expected_host}");
        if trimmed == "null" {
            let sfs = headers
                .get("sec-fetch-site")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");
            if !sfs.eq_ignore_ascii_case("same-origin") {
                return false;
            }
        } else if !trimmed.eq_ignore_ascii_case(&expected) {
            return false;
        }
    }
    true
}

pub fn parse_cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    for value in headers.get_all("cookie") {
        let Ok(raw) = value.to_str() else {
            continue;
        };
        for pair in raw.split(';') {
            let trimmed = pair.trim();
            if let Some((k, v)) = trimmed.split_once('=') {
                if k.trim() == name {
                    return Some(v.trim().to_string());
                }
            }
        }
    }
    None
}

pub fn sign_preview_cookie(
    secret: &[u8],
    site_id: &str,
    version_id: &str,
    password_version: i32,
    expires_unix: u64,
) -> String {
    let payload = format!("v2.{expires_unix}.{version_id}");
    let mac = compute_mac(secret, site_id, "next", password_version, &payload);
    format!("{payload}.{mac}")
}

pub fn verify_preview_cookie(
    cookie: &str,
    secret: &[u8],
    site_id: &str,
    password_version: i32,
    now_unix: u64,
) -> Option<String> {
    let parts: Vec<&str> = cookie.split('.').collect();
    if parts.len() != 4 || parts[0] != "v2" {
        return None;
    }
    let expires_unix = parts[1].parse::<u64>().ok()?;
    if expires_unix <= now_unix {
        return None;
    }
    let version_id = parts[2];
    if version_id.is_empty() || version_id.len() > 64 {
        return None;
    }
    let payload = format!("v2.{expires_unix}.{version_id}");
    let expected = compute_mac(secret, site_id, "next", password_version, &payload);
    if constant_time_eq(parts[3].as_bytes(), expected.as_bytes()) {
        Some(version_id.to_string())
    } else {
        None
    }
}

pub fn sign_session_cookie(
    secret: &[u8],
    site_id: &str,
    scope: &str,
    password_version: i32,
    expires_unix: u64,
) -> String {
    let payload = format!("v1.{expires_unix}");
    let mac = compute_mac(secret, site_id, scope, password_version, &payload);
    format!("{payload}.{mac}")
}

pub fn verify_session_cookie(
    cookie: &str,
    secret: &[u8],
    site_id: &str,
    scope: &str,
    password_version: i32,
    now_unix: u64,
) -> bool {
    let parts: Vec<&str> = cookie.split('.').collect();
    if parts.len() != 3 || parts[0] != "v1" {
        return false;
    }
    let Ok(expires_unix) = parts[1].parse::<u64>() else {
        return false;
    };
    if expires_unix <= now_unix {
        return false;
    }
    let payload = format!("v1.{expires_unix}");
    let expected = compute_mac(secret, site_id, scope, password_version, &payload);
    constant_time_eq(parts[2].as_bytes(), expected.as_bytes())
}

fn compute_mac(secret: &[u8], site_id: &str, scope: &str, password_version: i32, payload: &str) -> String {
    let mut inner = Sha256::new();
    inner.update(secret);
    inner.update(b"|");
    inner.update(site_id.as_bytes());
    inner.update(b"|");
    inner.update(scope.as_bytes());
    inner.update(b"|");
    inner.update(password_version.to_string().as_bytes());
    inner.update(b"|");
    inner.update(payload.as_bytes());
    let first = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(secret);
    outer.update(b"|outer|");
    outer.update(first);
    hex::encode(outer.finalize())
}

pub fn sanitize_next_path(next: &str) -> String {
    if next.starts_with('/') && !next.starts_with("//") && !next.contains('\r') && !next.contains('\n') {
        next.to_string()
    } else {
        "/".to_string()
    }
}

pub fn escape_html(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

pub fn render_password_page(next_path: &str, wrong_password: bool) -> String {
    let escaped_next = escape_html(&sanitize_next_path(next_path));
    let error_html = if wrong_password {
        "<p style=\"color:#b91c1c;font-size:14px;margin:0 0 12px\">Incorrect password.</p>"
    } else {
        ""
    };
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"robots\" content=\"noindex,nofollow\"><title>Private site</title><style>body{{font-family:system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f8fafc;color:#0f172a}}main{{background:#fff;padding:28px;border-radius:12px;border:1px solid #e2e8f0;width:min(360px,90vw)}}h1{{font-size:18px;margin:0 0 12px}}input{{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:15px;margin-bottom:12px}}button{{width:100%;padding:10px 14px;border:0;border-radius:8px;background:#0f172a;color:#fff;font-size:15px;cursor:pointer}}</style></head><body><main><h1>Password required</h1>{error_html}<form method=\"post\" action=\"/.qorpera/unlock\"><input type=\"hidden\" name=\"next\" value=\"{escaped_next}\"><input type=\"password\" name=\"password\" autocomplete=\"current-password\" placeholder=\"Password\" required autofocus><button type=\"submit\">Continue</button></form></main></body></html>"
    )
}

pub fn render_takedown_page() -> &'static str {
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"robots\" content=\"noindex,nofollow\"><title>Site unavailable</title><style>body{font-family:system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f8fafc;color:#0f172a}main{max-width:420px;padding:24px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{color:#475569;margin:0}</style></head><body><main><h1>This site is not available</h1><p>This site has been taken offline.</p></main></body></html>"
}

pub fn render_not_found_page() -> &'static str {
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Not found</title><style>body{font-family:system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f8fafc;color:#0f172a}main{max-width:420px;padding:24px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{color:#475569;margin:0}</style></head><body><main><h1>Page not found</h1><p>The page you requested does not exist.</p></main></body></html>"
}

pub fn render_app_unavailable_page() -> &'static str {
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>App unavailable</title><style>body{font-family:system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f8fafc;color:#0f172a}main{max-width:420px;padding:24px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{color:#475569;margin:0}</style></head><body><main><h1>App is starting or offline</h1><p>Please try again in a moment.</p></main></body></html>"
}

pub fn inject_preview_banner(html: &[u8], slug: &str) -> Vec<u8> {
    let banner = format!(
        "<div data-qorpera-preview=\"1\" style=\"position:fixed;bottom:12px;right:12px;z-index:2147483647;background:#0f172a;color:#fff;padding:8px 12px;border-radius:8px;font:13px/1.3 system-ui,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.2)\">Not live yet &middot; {}</div>",
        escape_html(slug)
    );
    let mut out = Vec::with_capacity(html.len() + banner.len());
    out.extend_from_slice(html);
    out.extend_from_slice(banner.as_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    #[test]
    fn signs_and_verifies_session_cookie_with_version_invalidation() {
        let secret = b"test-signing-key";
        let cookie = sign_session_cookie(secret, "site-1", "site", 2, 2000);
        assert!(verify_session_cookie(&cookie, secret, "site-1", "site", 2, 1500));
        assert!(!verify_session_cookie(&cookie, secret, "site-1", "site", 3, 1500));
        assert!(!verify_session_cookie(&cookie, secret, "site-1", "next", 2, 1500));
        assert!(!verify_session_cookie(&cookie, secret, "site-1", "site", 2, 2001));
    }

    #[test]
    fn rejects_cross_site_writes() {
        let mut h = HeaderMap::new();
        h.insert("sec-fetch-site", "same-site".parse().unwrap());
        assert!(!check_cross_site_write(&Method::POST, &h, "shop.qorpera.site"));
        assert!(check_cross_site_write(&Method::GET, &h, "shop.qorpera.site"));

        let mut h2 = HeaderMap::new();
        h2.insert("origin", "https://evil.qorpera.site".parse().unwrap());
        assert!(!check_cross_site_write(&Method::POST, &h2, "shop.qorpera.site"));

        let mut h3 = HeaderMap::new();
        h3.insert("origin", "https://shop.qorpera.site".parse().unwrap());
        assert!(check_cross_site_write(&Method::POST, &h3, "shop.qorpera.site"));
    }

    #[test]
    fn trusts_client_ip_header_only_from_loopback_or_trusted_proxy() {
        let mut h = HeaderMap::new();
        h.insert(CLIENT_IP_HEADER, "203.0.113.5".parse().unwrap());
        assert_eq!(extract_client_ip(&h, IpAddr::V4(Ipv4Addr::LOCALHOST), &[]), "203.0.113.5");
        assert_eq!(
            extract_client_ip(&h, IpAddr::V4(Ipv4Addr::new(198, 51, 100, 9)), &[]),
            "198.51.100.9"
        );
        assert_eq!(
            extract_client_ip(&HeaderMap::new(), IpAddr::V6(Ipv6Addr::new(0x2001, 0xdb8, 1, 2, 3, 4, 5, 6)), &[]),
            "2001:db8:1:2::/64"
        );
    }
}
