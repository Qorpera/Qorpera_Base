use crate::postgres_sync::connect_postgres_client;
use crate::routes::{DomainStatus, SharedRoutes};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UdpSocket};
use tokio::sync::{mpsc, Semaphore};
use tokio::task::JoinSet;
use tracing::{info, warn};

pub const DNS_TYPE_A: u16 = 1;
pub const DNS_TYPE_NS: u16 = 2;
pub const DNS_TYPE_CNAME: u16 = 5;
pub const DNS_TYPE_TXT: u16 = 16;
pub const DNS_TYPE_AAAA: u16 = 28;
pub const DNS_RCODE_NXDOMAIN: u8 = 3;
const MAX_NS_HOSTS: usize = 4;
const MAX_REASON_CHARS: usize = 300;
const MAX_PARALLEL_DOMAIN_CHECKS: usize = 16;
const DB_OP_TIMEOUT: Duration = Duration::from_secs(5);
const UNCHANGED_DB_HEARTBEAT: Duration = Duration::from_secs(10 * 60);

#[derive(Default)]
pub struct DomainPersistTracker {
    last_persisted: Mutex<HashMap<String, tokio::time::Instant>>,
}

impl DomainPersistTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn should_persist(&self, domain_id: &str, changed: bool, heartbeat: Duration) -> bool {
        if changed {
            return true;
        }
        let Ok(map) = self.last_persisted.lock() else {
            return true;
        };
        map.get(domain_id)
            .is_none_or(|ts| ts.elapsed() >= heartbeat)
    }

    pub fn mark_persisted(&self, domain_id: &str) {
        if let Ok(mut map) = self.last_persisted.lock() {
            map.insert(domain_id.to_string(), tokio::time::Instant::now());
        }
    }

    pub fn prune_missing(&self, active_ids: &HashSet<String>) {
        if let Ok(mut map) = self.last_persisted.lock() {
            map.retain(|id, _| active_ids.contains(id));
        }
    }
}

static DNS_TX_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DnsExpectation {
    pub hostname: String,
    pub is_apex: bool,
    pub expected_ipv4: Option<String>,
    pub expected_ipv6: Option<String>,
    pub expected_cname_target: Option<String>,
    pub verification_token: String,
    pub require_txt: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DnsAnswers {
    pub a_records: Vec<String>,
    pub aaaa_records: Vec<String>,
    pub cname_records: Vec<String>,
    pub txt_records: Vec<String>,
    #[serde(default)]
    pub hostname_txt_records: Vec<String>,
    #[serde(default)]
    pub registrable_domain_ns: Vec<String>,
    #[serde(default)]
    pub registrable_domain_not_found: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DnsVerificationResult {
    pub verified: bool,
    pub routing_ok: bool,
    pub txt_ok: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomainCheckOutcome {
    pub id: String,
    pub hostname: String,
    pub previous_status: DomainStatus,
    pub next_status: DomainStatus,
    pub reason: String,
    pub routing_ok: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DnsReply {
    pub rcode: u8,
    pub records: Vec<(u16, String)>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MergedDnsReply {
    pub records: Vec<(u16, String)>,
    pub answered: usize,
    pub nxdomain: usize,
}

impl MergedDnsReply {
    pub fn merge(replies: impl IntoIterator<Item = DnsReply>) -> Self {
        let mut merged = Self::default();
        for reply in replies {
            merged.answered += 1;
            if reply.rcode == DNS_RCODE_NXDOMAIN {
                merged.nxdomain += 1;
            }
            for record in reply.records {
                if !merged.records.contains(&record) {
                    merged.records.push(record);
                }
            }
        }
        merged
    }

    pub fn not_found_everywhere(&self) -> bool {
        self.answered > 0 && self.nxdomain == self.answered
    }

    fn values_of(&self, record_type: u16) -> Vec<String> {
        self.records
            .iter()
            .filter(|(rt, _)| *rt == record_type)
            .map(|(_, value)| value.clone())
            .collect()
    }
}

pub fn registrable_domain(hostname: &str) -> &str {
    let trimmed = hostname.trim_end_matches('.');
    match trimmed.rmatch_indices('.').nth(1) {
        Some((dot, _)) => &trimmed[dot + 1..],
        None => trimmed,
    }
}

fn txt_matches(raw: &str, expected: &str) -> bool {
    raw.trim_matches('"').trim() == expected
}

fn clean_ns_hosts(raw_hosts: &[String]) -> Vec<String> {
    let mut hosts: Vec<String> = raw_hosts
        .iter()
        .map(|raw| raw.trim().trim_end_matches('.').to_ascii_lowercase())
        .filter(|host| {
            !host.is_empty()
                && host.len() <= 253
                && !host.starts_with('.')
                && !host.contains("..")
                && host
                    .bytes()
                    .all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_'))
        })
        .collect();
    hosts.sort();
    hosts.dedup();
    hosts.truncate(MAX_NS_HOSTS);
    hosts
}

fn failure_reason(
    expectation: &DnsExpectation,
    answers: &DnsAnswers,
    routing_ok: bool,
    txt_ok: bool,
    expected_txt: &str,
) -> String {
    let base = if !routing_ok && answers.registrable_domain_not_found {
        "domain_not_found"
    } else if !routing_ok && !txt_ok {
        "dns_routing_and_txt_missing"
    } else if !routing_ok {
        if expectation.is_apex {
            "apex_a_record_mismatch"
        } else {
            "cname_record_mismatch"
        }
    } else {
        "txt_verification_missing"
    };
    let mut reason = base.to_string();
    if !txt_ok
        && answers
            .hostname_txt_records
            .iter()
            .any(|raw| txt_matches(raw, expected_txt))
    {
        reason.push_str(" txt_on_wrong_name");
    }
    let ns_hosts = clean_ns_hosts(&answers.registrable_domain_ns);
    for count in (1..=ns_hosts.len()).rev() {
        let with_ns = format!("{reason} ns={}", ns_hosts[..count].join(","));
        if with_ns.len() <= MAX_REASON_CHARS {
            return with_ns;
        }
    }
    reason
}

pub fn evaluate_dns(expectation: &DnsExpectation, answers: &DnsAnswers) -> DnsVerificationResult {
    let expected_txt = format!("qorpera-verify={}", expectation.verification_token);
    let txt_ok = !expectation.require_txt
        || answers
            .txt_records
            .iter()
            .any(|raw| txt_matches(raw, &expected_txt));

    let routing_ok = if expectation.is_apex {
        let v4_match = expectation
            .expected_ipv4
            .as_deref()
            .map_or(false, |exp| answers.a_records.iter().any(|a| a.trim() == exp));
        let v6_match = expectation
            .expected_ipv6
            .as_deref()
            .map_or(false, |exp| {
                answers
                    .aaaa_records
                    .iter()
                    .any(|a| a.trim().eq_ignore_ascii_case(exp))
            });
        let cname_flatten_match = expectation.expected_cname_target.as_deref().map_or(false, |exp| {
            let norm = exp.trim_end_matches('.').to_ascii_lowercase();
            answers
                .cname_records
                .iter()
                .any(|c| c.trim_end_matches('.').to_ascii_lowercase() == norm)
        });
        v4_match || v6_match || cname_flatten_match
    } else {
        let cname_match = expectation.expected_cname_target.as_deref().map_or(false, |exp| {
            let norm = exp.trim_end_matches('.').to_ascii_lowercase();
            answers
                .cname_records
                .iter()
                .any(|c| c.trim_end_matches('.').to_ascii_lowercase() == norm)
        });
        let a_match = expectation
            .expected_ipv4
            .as_deref()
            .map_or(false, |exp| answers.a_records.iter().any(|a| a.trim() == exp));
        cname_match || a_match
    };

    let verified = routing_ok && txt_ok;
    let reason = if verified {
        "ok".to_string()
    } else {
        failure_reason(expectation, answers, routing_ok, txt_ok, &expected_txt)
    };

    DnsVerificationResult {
        verified,
        routing_ok,
        txt_ok,
        reason,
    }
}

#[derive(Debug, Deserialize)]
struct DohResponse {
    #[serde(rename = "Answer", default)]
    answer: Vec<DohAnswer>,
}

#[derive(Debug, Deserialize)]
struct DohAnswer {
    #[serde(rename = "type")]
    record_type: u16,
    data: String,
}

pub fn parse_doh_answers(json_body: &[u8]) -> Result<Vec<(u16, String)>, serde_json::Error> {
    let parsed: DohResponse = serde_json::from_slice(json_body)?;
    Ok(parsed
        .answer
        .into_iter()
        .map(|a| (a.record_type, a.data))
        .collect())
}

pub fn default_dns_servers() -> Vec<SocketAddr> {
    vec![
        SocketAddr::from(([1, 1, 1, 1], 53)),
        SocketAddr::from(([8, 8, 8, 8], 53)),
        SocketAddr::from(([9, 9, 9, 9], 53)),
    ]
}

fn next_tx_id(qname: &str, qtype: u16) -> u16 {
    let seq = DNS_TX_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0u64, |d| d.as_nanos() as u64);
    let mut mixed = nanos ^ seq.wrapping_mul(0x9e3779b97f4a7c15) ^ (qtype as u64).wrapping_mul(0xbf58476d1ce4e5b9);
    for b in qname.as_bytes() {
        mixed ^= *b as u64;
        mixed = mixed.wrapping_mul(0x100000001b3);
    }
    mixed ^= mixed >> 33;
    mixed = mixed.wrapping_mul(0xff51afd7ed558ccd);
    mixed ^= mixed >> 33;
    (mixed as u16) ^ ((mixed >> 16) as u16)
}

pub fn build_dns_query(tx_id: u16, qname: &str, qtype: u16) -> Result<Vec<u8>, String> {
    let mut pkt = Vec::with_capacity(64);
    pkt.extend_from_slice(&tx_id.to_be_bytes());
    pkt.extend_from_slice(&0x0100u16.to_be_bytes());
    pkt.extend_from_slice(&1u16.to_be_bytes());
    pkt.extend_from_slice(&0u16.to_be_bytes());
    pkt.extend_from_slice(&0u16.to_be_bytes());
    pkt.extend_from_slice(&1u16.to_be_bytes());
    for label in qname.trim_end_matches('.').split('.') {
        if label.is_empty() || label.len() > 63 {
            return Err("invalid_dns_label".to_string());
        }
        pkt.push(label.len() as u8);
        pkt.extend_from_slice(label.as_bytes());
    }
    pkt.push(0);
    pkt.extend_from_slice(&qtype.to_be_bytes());
    pkt.extend_from_slice(&1u16.to_be_bytes());
    // WHY: Advertise RFC 6891 EDNS0 (1232 B UDP payload) so multi-record TXT verification responses do not truncate at 512 B.
    pkt.push(0);
    pkt.extend_from_slice(&41u16.to_be_bytes());
    pkt.extend_from_slice(&1232u16.to_be_bytes());
    pkt.extend_from_slice(&0u32.to_be_bytes());
    pkt.extend_from_slice(&0u16.to_be_bytes());
    Ok(pkt)
}

fn read_dns_name(packet: &[u8], mut offset: usize) -> Result<(String, usize), String> {
    let mut labels = Vec::new();
    let mut jumped = false;
    let mut end_offset = offset;
    let mut hops = 0;

    loop {
        if offset >= packet.len() {
            return Err("dns_name_oob".to_string());
        }
        let len = packet[offset];
        if len == 0 {
            if !jumped {
                end_offset = offset + 1;
            }
            break;
        }
        if (len & 0xC0) == 0xC0 {
            if offset + 1 >= packet.len() {
                return Err("dns_ptr_oob".to_string());
            }
            let ptr = (((len & 0x3F) as usize) << 8) | (packet[offset + 1] as usize);
            if !jumped {
                end_offset = offset + 2;
                jumped = true;
            }
            offset = ptr;
            hops += 1;
            if hops > 16 {
                return Err("dns_ptr_loop".to_string());
            }
            continue;
        }
        let label_len = len as usize;
        offset += 1;
        if offset + label_len > packet.len() {
            return Err("dns_label_oob".to_string());
        }
        let label = String::from_utf8_lossy(&packet[offset..offset + label_len]).into_owned();
        labels.push(label);
        offset += label_len;
        if !jumped {
            end_offset = offset;
        }
    }

    Ok((labels.join("."), end_offset))
}

pub fn parse_dns_response(packet: &[u8], expected_tx_id: u16) -> Result<DnsReply, String> {
    if packet.len() < 12 {
        return Err("dns_short_header".to_string());
    }
    let tx_id = u16::from_be_bytes([packet[0], packet[1]]);
    if tx_id != expected_tx_id {
        return Err("dns_tx_mismatch".to_string());
    }
    let flags = u16::from_be_bytes([packet[2], packet[3]]);
    if (flags & 0x8000) == 0 {
        return Err("dns_not_response".to_string());
    }
    let rcode = (flags & 0x000F) as u8;
    if rcode == DNS_RCODE_NXDOMAIN {
        return Ok(DnsReply {
            rcode,
            records: Vec::new(),
        });
    }
    if rcode != 0 {
        return Err(format!("dns_rcode_{rcode}"));
    }
    let qdcount = u16::from_be_bytes([packet[4], packet[5]]) as usize;
    let ancount = u16::from_be_bytes([packet[6], packet[7]]) as usize;
    let mut offset = 12usize;

    for _ in 0..qdcount {
        let (_, next) = read_dns_name(packet, offset)?;
        if next + 4 > packet.len() {
            return Err("dns_question_oob".to_string());
        }
        offset = next + 4;
    }

    let mut out = Vec::with_capacity(ancount.min(64));
    for _ in 0..ancount {
        let (_, next) = read_dns_name(packet, offset)?;
        if next + 10 > packet.len() {
            return Err("dns_rr_header_oob".to_string());
        }
        let rtype = u16::from_be_bytes([packet[next], packet[next + 1]]);
        let rdlen = u16::from_be_bytes([packet[next + 8], packet[next + 9]]) as usize;
        let rdata_start = next + 10;
        let rdata_end = rdata_start + rdlen;
        if rdata_end > packet.len() {
            return Err("dns_rdata_oob".to_string());
        }
        match rtype {
            DNS_TYPE_A if rdlen == 4 => {
                let ip = Ipv4Addr::new(
                    packet[rdata_start],
                    packet[rdata_start + 1],
                    packet[rdata_start + 2],
                    packet[rdata_start + 3],
                );
                out.push((rtype, ip.to_string()));
            }
            DNS_TYPE_AAAA if rdlen == 16 => {
                let mut octets = [0u8; 16];
                octets.copy_from_slice(&packet[rdata_start..rdata_end]);
                let ip = Ipv6Addr::from(octets);
                out.push((rtype, ip.to_string()));
            }
            DNS_TYPE_CNAME | DNS_TYPE_NS => {
                if let Ok((target, _)) = read_dns_name(packet, rdata_start) {
                    out.push((rtype, target));
                }
            }
            DNS_TYPE_TXT => {
                let mut pos = rdata_start;
                let mut combined = String::new();
                while pos < rdata_end {
                    let seg_len = packet[pos] as usize;
                    pos += 1;
                    if pos + seg_len > rdata_end {
                        break;
                    }
                    combined.push_str(&String::from_utf8_lossy(&packet[pos..pos + seg_len]));
                    pos += seg_len;
                }
                if !combined.is_empty() {
                    out.push((rtype, combined));
                }
            }
            _ => {}
        }
        offset = rdata_end;
    }

    Ok(DnsReply { rcode, records: out })
}

fn is_dns_truncated(packet: &[u8]) -> bool {
    packet.len() >= 4 && (u16::from_be_bytes([packet[2], packet[3]]) & 0x0200) != 0
}

async fn query_dns_tcp(
    server: SocketAddr,
    query: &[u8],
    tx_id: u16,
    timeout: Duration,
) -> Result<DnsReply, String> {
    let len = u16::try_from(query.len()).map_err(|_| "dns_query_too_large".to_string())?;
    let mut stream = tokio::time::timeout(timeout, TcpStream::connect(server))
        .await
        .map_err(|_| "dns_tcp_connect_timeout".to_string())?
        .map_err(|e| format!("dns_tcp_connect: {e}"))?;
    let mut framed = Vec::with_capacity(2 + query.len());
    framed.extend_from_slice(&len.to_be_bytes());
    framed.extend_from_slice(query);
    tokio::time::timeout(timeout, stream.write_all(&framed))
        .await
        .map_err(|_| "dns_tcp_send_timeout".to_string())?
        .map_err(|e| format!("dns_tcp_send: {e}"))?;
    let mut len_buf = [0u8; 2];
    tokio::time::timeout(timeout, stream.read_exact(&mut len_buf))
        .await
        .map_err(|_| "dns_tcp_recv_timeout".to_string())?
        .map_err(|e| format!("dns_tcp_recv: {e}"))?;
    let resp_len = u16::from_be_bytes(len_buf) as usize;
    let mut resp = vec![0u8; resp_len];
    tokio::time::timeout(timeout, stream.read_exact(&mut resp))
        .await
        .map_err(|_| "dns_tcp_recv_timeout".to_string())?
        .map_err(|e| format!("dns_tcp_recv: {e}"))?;
    parse_dns_response(&resp, tx_id)
}

pub async fn query_dns_udp(
    server: SocketAddr,
    qname: &str,
    qtype: u16,
    timeout: Duration,
) -> Result<DnsReply, String> {
    let bind_addr: SocketAddr = if server.is_ipv6() {
        "[::]:0".parse().unwrap()
    } else {
        "0.0.0.0:0".parse().unwrap()
    };
    let sock = UdpSocket::bind(bind_addr)
        .await
        .map_err(|e| format!("dns_bind: {e}"))?;
    sock.connect(server)
        .await
        .map_err(|e| format!("dns_connect: {e}"))?;
    let tx_id = next_tx_id(qname, qtype);
    let query = build_dns_query(tx_id, qname, qtype)?;
    sock.send(&query)
        .await
        .map_err(|e| format!("dns_send: {e}"))?;
    let mut buf = [0u8; 4096];
    let n = tokio::time::timeout(timeout, sock.recv(&mut buf))
        .await
        .map_err(|_| "dns_timeout".to_string())?
        .map_err(|e| format!("dns_recv: {e}"))?;
    if is_dns_truncated(&buf[..n]) {
        if let Ok(records) = query_dns_tcp(server, &query, tx_id, timeout).await {
            return Ok(records);
        }
    }
    parse_dns_response(&buf[..n], tx_id)
}

pub async fn query_all_servers(
    servers: &[SocketAddr],
    qname: &str,
    qtype: u16,
    timeout: Duration,
) -> MergedDnsReply {
    let mut set = JoinSet::new();
    for (index, server) in servers.iter().copied().enumerate() {
        let qname = qname.to_string();
        set.spawn(async move {
            let reply = tokio::time::timeout(
                timeout.saturating_mul(2),
                query_dns_udp(server, &qname, qtype, timeout),
            )
            .await;
            (index, reply.ok().and_then(Result::ok))
        });
    }
    let mut replies: Vec<Option<DnsReply>> = vec![None; servers.len()];
    while let Some(joined) = set.join_next().await {
        if let Ok((index, reply)) = joined {
            replies[index] = reply;
        }
    }
    MergedDnsReply::merge(replies.into_iter().flatten())
}

pub async fn resolve_domain_dns(
    servers: &[SocketAddr],
    hostname: &str,
    timeout: Duration,
) -> DnsAnswers {
    let txt_host = format!("_qorpera.{hostname}");
    let (a_res, aaaa_res, cname_res, txt_res) = tokio::join!(
        query_all_servers(servers, hostname, DNS_TYPE_A, timeout),
        query_all_servers(servers, hostname, DNS_TYPE_AAAA, timeout),
        query_all_servers(servers, hostname, DNS_TYPE_CNAME, timeout),
        query_all_servers(servers, &txt_host, DNS_TYPE_TXT, timeout),
    );
    let mut answers = DnsAnswers::default();
    for (rt, val) in a_res
        .records
        .into_iter()
        .chain(aaaa_res.records)
        .chain(cname_res.records)
        .chain(txt_res.records)
    {
        match rt {
            DNS_TYPE_A => answers.a_records.push(val),
            DNS_TYPE_AAAA => answers.aaaa_records.push(val),
            DNS_TYPE_CNAME => answers.cname_records.push(val),
            DNS_TYPE_TXT => answers.txt_records.push(val),
            _ => {}
        }
    }
    answers
}

pub async fn add_domain_diagnostics(
    answers: &mut DnsAnswers,
    servers: &[SocketAddr],
    hostname: &str,
    check_hostname_txt: bool,
    timeout: Duration,
) {
    let hostname_txt = async {
        if check_hostname_txt {
            query_all_servers(servers, hostname, DNS_TYPE_TXT, timeout).await
        } else {
            MergedDnsReply::default()
        }
    };
    let (ns, txt) = tokio::join!(
        query_all_servers(servers, registrable_domain(hostname), DNS_TYPE_NS, timeout),
        hostname_txt,
    );
    answers.registrable_domain_not_found = ns.not_found_everywhere();
    answers.registrable_domain_ns = ns.values_of(DNS_TYPE_NS);
    answers.hostname_txt_records = txt.values_of(DNS_TYPE_TXT);
}

fn status_sql_str(status: DomainStatus) -> &'static str {
    match status {
        DomainStatus::PendingDns => "pending_dns",
        DomainStatus::DnsVerified => "dns_verified",
        DomainStatus::TlsActive => "tls_active",
        DomainStatus::Moved => "moved",
        DomainStatus::Failed => "failed",
    }
}

struct DbClientSlot {
    url: String,
    client: tokio::sync::Mutex<Option<Arc<tokio_postgres::Client>>>,
}

impl DbClientSlot {
    fn new(url: String) -> Self {
        Self {
            url,
            client: tokio::sync::Mutex::new(None),
        }
    }

    async fn get(&self) -> Option<Arc<tokio_postgres::Client>> {
        let mut guard = self.client.lock().await;
        if let Some(ref client) = *guard {
            if !client.is_closed() {
                return Some(Arc::clone(client));
            }
            *guard = None;
        }
        match connect_postgres_client(&self.url, DB_OP_TIMEOUT).await {
            Ok(client) => {
                let arc = Arc::new(client);
                *guard = Some(Arc::clone(&arc));
                Some(arc)
            }
            Err(err) => {
                warn!(error = %err, "dns verifier postgres connect failed");
                None
            }
        }
    }

    async fn clear_if_same(&self, failed: &Arc<tokio_postgres::Client>) {
        let mut guard = self.client.lock().await;
        if guard.as_ref().is_some_and(|held| Arc::ptr_eq(held, failed)) {
            *guard = None;
        }
    }
}

pub async fn verify_domains_once(
    routes: &Arc<SharedRoutes>,
    dns_servers: &[SocketAddr],
    database_url: Option<&str>,
    query_timeout: Duration,
) -> Vec<DomainCheckOutcome> {
    let db_slot = database_url.map(|url| Arc::new(DbClientSlot::new(url.to_string())));
    verify_domains_once_with_tracker(routes, dns_servers, db_slot.as_ref(), query_timeout, None, true).await
}

async fn verify_domains_once_with_tracker(
    routes: &Arc<SharedRoutes>,
    dns_servers: &[SocketAddr],
    db_slot: Option<&Arc<DbClientSlot>>,
    query_timeout: Duration,
    persist_tracker: Option<&Arc<DomainPersistTracker>>,
    force_all_persist: bool,
) -> Vec<DomainCheckOutcome> {
    let (domains, expected_ipv4, expected_ipv6, expected_cname_target, domains_enabled) = {
        let guard = routes.load();
        (
            guard.custom_domains(),
            guard.edge_ipv4.clone(),
            guard.edge_ipv6.clone(),
            guard.edge_cname_target.clone(),
            guard.domains_enabled,
        )
    };
    if !domains_enabled || domains.is_empty() {
        if let Some(tracker) = persist_tracker {
            tracker.prune_missing(&HashSet::new());
        }
        return Vec::new();
    }
    if let Some(tracker) = persist_tracker {
        let active_ids: HashSet<String> = domains.iter().map(|d| d.id.clone()).collect();
        tracker.prune_missing(&active_ids);
    }

    struct SweepTargets {
        servers: Vec<SocketAddr>,
        expected_ipv4: Option<String>,
        expected_ipv6: Option<String>,
        expected_cname_target: Option<String>,
    }

    let targets = Arc::new(SweepTargets {
        servers: dns_servers.to_vec(),
        expected_ipv4,
        expected_ipv6,
        expected_cname_target,
    });
    let sem = Arc::new(Semaphore::new(MAX_PARALLEL_DOMAIN_CHECKS));
    let mut set: JoinSet<(DomainCheckOutcome, bool, bool)> = JoinSet::new();
    let mut outcomes = Vec::with_capacity(domains.len());
    let mut changed_batch = Vec::new();

    for domain in domains {
        let Ok(permit) = Arc::clone(&sem).acquire_owned().await else {
            break;
        };
        while let Some(res) = set.try_join_next() {
            if let Ok((outcome, verified, changed_in_memory)) = res {
                if changed_in_memory {
                    changed_batch.push((outcome.id.clone(), outcome.next_status, verified));
                }
                outcomes.push(outcome);
            }
        }
        let targets_ref = Arc::clone(&targets);
        let db_slot_ref = db_slot.map(Arc::clone);
        let tracker_ref = persist_tracker.map(Arc::clone);

        set.spawn(async move {
            let _permit = permit;
            let mut answers = resolve_domain_dns(&targets_ref.servers, &domain.hostname, query_timeout).await;
            let require_txt = domain.is_apex
                && matches!(
                    domain.status,
                    DomainStatus::PendingDns | DomainStatus::Failed | DomainStatus::Moved
                );
            let expectation = DnsExpectation {
                hostname: domain.hostname.clone(),
                is_apex: domain.is_apex,
                expected_ipv4: targets_ref.expected_ipv4.clone(),
                expected_ipv6: targets_ref.expected_ipv6.clone(),
                expected_cname_target: targets_ref.expected_cname_target.clone(),
                verification_token: domain.verification_token.clone(),
                require_txt,
            };
            let mut eval = evaluate_dns(&expectation, &answers);
            if !eval.verified {
                add_domain_diagnostics(
                    &mut answers,
                    &targets_ref.servers,
                    &domain.hostname,
                    !eval.txt_ok,
                    query_timeout,
                )
                .await;
                eval = evaluate_dns(&expectation, &answers);
            }
            let next_status = if eval.verified {
                if domain.status == DomainStatus::TlsActive {
                    DomainStatus::TlsActive
                } else {
                    DomainStatus::DnsVerified
                }
            } else if matches!(domain.status, DomainStatus::DnsVerified | DomainStatus::TlsActive) {
                if domain.consecutive_misses + 1 >= 3 {
                    DomainStatus::Moved
                } else {
                    domain.status
                }
            } else {
                domain.status
            };
            let err_text = if eval.verified {
                None
            } else {
                Some(eval.reason.as_str())
            };
            let next_misses = if eval.verified {
                0
            } else {
                domain.consecutive_misses.saturating_add(1)
            };
            let changed_in_memory =
                next_status != domain.status || next_misses != domain.consecutive_misses;
            // WHY: Always persist explicit rechecks or domains with NULL last_checked_at while throttling unchanged periodic writes.
            let force_persist =
                force_all_persist || changed_in_memory || domain.last_checked_at.is_none();
            let should_write_db = tracker_ref.as_ref().is_none_or(|t| {
                t.should_persist(&domain.id, force_persist, UNCHANGED_DB_HEARTBEAT)
            });
            if should_write_db {
                if let Some(ref slot) = db_slot_ref {
                    if let Some(client) = slot.get().await {
                        let res = tokio::time::timeout(
                            DB_OP_TIMEOUT,
                            client.execute(
                                "SELECT public.qorpera_web_domain_mark_checked($1::text::uuid, $2::text, $3::text)",
                                &[&domain.id, &status_sql_str(next_status), &err_text],
                            ),
                        )
                        .await;
                        match res {
                            Ok(Err(err)) => {
                                warn!(domain = %domain.hostname, error = %err, "failed persisting domain check");
                                if client.is_closed() {
                                    slot.clear_if_same(&client).await;
                                }
                            }
                            Err(_) => {
                                warn!(domain = %domain.hostname, "timed out persisting domain check");
                                slot.clear_if_same(&client).await;
                            }
                            Ok(Ok(_)) => {
                                if let Some(ref tracker) = tracker_ref {
                                    tracker.mark_persisted(&domain.id);
                                }
                            }
                        }
                    }
                }
            }

            if next_status != domain.status {
                info!(
                    domain = %domain.hostname,
                    from = status_sql_str(domain.status),
                    to = status_sql_str(next_status),
                    "custom domain status transitioned"
                );
            }

            (
                DomainCheckOutcome {
                    id: domain.id,
                    hostname: domain.hostname,
                    previous_status: domain.status,
                    next_status,
                    reason: eval.reason,
                    routing_ok: eval.routing_ok,
                },
                eval.verified,
                changed_in_memory,
            )
        });
    }

    while let Some(res) = set.join_next().await {
        if let Ok((outcome, verified, changed_in_memory)) = res {
            if changed_in_memory {
                changed_batch.push((outcome.id.clone(), outcome.next_status, verified));
            }
            outcomes.push(outcome);
        }
    }
    let routing: Vec<(String, bool)> = outcomes
        .iter()
        .map(|outcome| (outcome.id.clone(), outcome.routing_ok))
        .collect();
    if !changed_batch.is_empty() || routes.load().domain_routing_differs(&routing) {
        routes.update(|table| {
            table.update_domain_checks(&changed_batch);
            table.set_domain_routing(&routing);
        });
    }
    outcomes
}

pub fn spawn_dns_verifier(
    routes: Arc<SharedRoutes>,
    dns_servers: Vec<SocketAddr>,
    database_url: Option<String>,
    interval: Duration,
    mut trigger_rx: mpsc::Receiver<()>,
) {
    let persist_tracker = Arc::new(DomainPersistTracker::new());
    let db_slot = database_url.map(|url| Arc::new(DbClientSlot::new(url)));
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ticker.tick().await;
        let min_trigger_gap = Duration::from_secs(2);
        let mut last_sweep = tokio::time::Instant::now() - min_trigger_gap;
        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    let _ = verify_domains_once_with_tracker(
                        &routes,
                        &dns_servers,
                        db_slot.as_ref(),
                        Duration::from_secs(3),
                        Some(&persist_tracker),
                        false,
                    )
                    .await;
                    last_sweep = tokio::time::Instant::now();
                }
                msg = trigger_rx.recv() => {
                    if msg.is_none() {
                        break;
                    }
                    let elapsed = last_sweep.elapsed();
                    if elapsed < min_trigger_gap {
                        tokio::time::sleep(min_trigger_gap - elapsed).await;
                    }
                    while trigger_rx.try_recv().is_ok() {}
                    let _ = verify_domains_once_with_tracker(
                        &routes,
                        &dns_servers,
                        db_slot.as_ref(),
                        Duration::from_secs(3),
                        Some(&persist_tracker),
                        true,
                    )
                    .await;
                    last_sweep = tokio::time::Instant::now();
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifies_apex_a_record_and_subdomain_cname() {
        let apex = DnsExpectation {
            hostname: "minbutik.dk".to_string(),
            is_apex: true,
            expected_ipv4: Some("93.164.62.162".to_string()),
            expected_ipv6: None,
            expected_cname_target: Some("sites.qorpera.site".to_string()),
            verification_token: "abc123".to_string(),
            require_txt: true,
        };
        let wrong = evaluate_dns(
            &apex,
            &DnsAnswers {
                a_records: vec!["1.1.1.1".to_string()],
                txt_records: vec!["\"qorpera-verify=abc123\"".to_string()],
                ..Default::default()
            },
        );
        assert!(!wrong.verified);
        assert_eq!(wrong.reason, "apex_a_record_mismatch");

        let ok = evaluate_dns(
            &apex,
            &DnsAnswers {
                a_records: vec!["93.164.62.162".to_string()],
                txt_records: vec!["\"qorpera-verify=abc123\"".to_string()],
                ..Default::default()
            },
        );
        assert!(ok.verified);

        let sub = DnsExpectation {
            hostname: "shop.minbutik.dk".to_string(),
            is_apex: false,
            expected_ipv4: Some("93.164.62.162".to_string()),
            expected_ipv6: None,
            expected_cname_target: Some("sites.qorpera.site".to_string()),
            verification_token: "tok".to_string(),
            require_txt: false,
        };
        let sub_ok = evaluate_dns(
            &sub,
            &DnsAnswers {
                cname_records: vec!["sites.qorpera.site.".to_string()],
                ..Default::default()
            },
        );
        assert!(sub_ok.verified);
    }

    fn encode_dns_name(name: &str) -> Vec<u8> {
        let mut out = Vec::new();
        for label in name.trim_end_matches('.').split('.') {
            out.push(label.len() as u8);
            out.extend_from_slice(label.as_bytes());
        }
        out.push(0);
        out
    }

    #[tokio::test]
    async fn resolves_live_udp_a_cname_and_txt_records_with_servfail_fallback() {
        let bad_server = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let bad_addr = bad_server.local_addr().unwrap();
        tokio::spawn(async move {
            let mut buf = [0u8; 512];
            for _ in 0..8 {
                let Ok((n, peer)) = bad_server.recv_from(&mut buf).await else {
                    break;
                };
                if n < 12 {
                    continue;
                }
                let mut resp = Vec::new();
                resp.extend_from_slice(&buf[0..2]);
                resp.extend_from_slice(&0x8182u16.to_be_bytes());
                resp.extend_from_slice(&0u16.to_be_bytes());
                resp.extend_from_slice(&0u16.to_be_bytes());
                resp.extend_from_slice(&0u16.to_be_bytes());
                resp.extend_from_slice(&0u16.to_be_bytes());
                let _ = bad_server.send_to(&resp, peer).await;
            }
        });

        let server = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let addr = server.local_addr().unwrap();
        tokio::spawn(async move {
            let mut buf = [0u8; 512];
            for _ in 0..8 {
                let Ok((n, peer)) = server.recv_from(&mut buf).await else {
                    break;
                };
                if n < 12 {
                    continue;
                }
                let (qname, after_name) = read_dns_name(&buf[..n], 12).unwrap();
                let qtype = u16::from_be_bytes([buf[after_name], buf[after_name + 1]]);
                let mut resp = Vec::new();
                resp.extend_from_slice(&buf[0..2]);
                resp.extend_from_slice(&0x8180u16.to_be_bytes());
                resp.extend_from_slice(&1u16.to_be_bytes());
                let rdata: Option<(u16, Vec<u8>)> = match (qname.as_str(), qtype) {
                    ("minbutik.dk", DNS_TYPE_A) => Some((DNS_TYPE_A, vec![93, 164, 62, 162])),
                    ("_qorpera.minbutik.dk", DNS_TYPE_TXT) => {
                        let txt = b"qorpera-verify=deadbeef";
                        let mut v = vec![txt.len() as u8];
                        v.extend_from_slice(txt);
                        Some((DNS_TYPE_TXT, v))
                    }
                    ("www.minbutik.dk", DNS_TYPE_CNAME) => {
                        Some((DNS_TYPE_CNAME, encode_dns_name("sites.qorpera.site")))
                    }
                    _ => None,
                };
                resp.extend_from_slice(&(if rdata.is_some() { 1u16 } else { 0u16 }).to_be_bytes());
                resp.extend_from_slice(&0u16.to_be_bytes());
                resp.extend_from_slice(&0u16.to_be_bytes());
                resp.extend_from_slice(&buf[12..after_name + 4]);
                if let Some((rt, data)) = rdata {
                    resp.extend_from_slice(&[0xC0, 0x0C]);
                    resp.extend_from_slice(&rt.to_be_bytes());
                    resp.extend_from_slice(&1u16.to_be_bytes());
                    resp.extend_from_slice(&60u32.to_be_bytes());
                    resp.extend_from_slice(&(data.len() as u16).to_be_bytes());
                    resp.extend_from_slice(&data);
                }
                let _ = server.send_to(&resp, peer).await;
            }
        });

        let apex = resolve_domain_dns(&[bad_addr, addr], "minbutik.dk", Duration::from_secs(2)).await;
        assert_eq!(apex.a_records, vec!["93.164.62.162".to_string()]);
        assert_eq!(apex.txt_records, vec!["qorpera-verify=deadbeef".to_string()]);

        let sub = resolve_domain_dns(&[bad_addr, addr], "www.minbutik.dk", Duration::from_secs(2)).await;
        assert_eq!(sub.cname_records, vec!["sites.qorpera.site".to_string()]);
    }

    type MockAnswer = (u8, Vec<(u16, Vec<u8>)>);

    fn txt_rdata(text: &str) -> Vec<u8> {
        let mut v = vec![text.len() as u8];
        v.extend_from_slice(text.as_bytes());
        v
    }

    async fn spawn_mock_dns(answer: impl Fn(&str, u16) -> MockAnswer + Send + 'static) -> SocketAddr {
        let server = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let addr = server.local_addr().unwrap();
        tokio::spawn(async move {
            let mut buf = [0u8; 512];
            loop {
                let Ok((n, peer)) = server.recv_from(&mut buf).await else {
                    break;
                };
                if n < 12 {
                    continue;
                }
                let (qname, after_name) = read_dns_name(&buf[..n], 12).unwrap();
                let qtype = u16::from_be_bytes([buf[after_name], buf[after_name + 1]]);
                let (rcode, records) = answer(&qname, qtype);
                let mut resp = Vec::new();
                resp.extend_from_slice(&buf[0..2]);
                resp.extend_from_slice(&(0x8180u16 | rcode as u16).to_be_bytes());
                resp.extend_from_slice(&1u16.to_be_bytes());
                resp.extend_from_slice(&(records.len() as u16).to_be_bytes());
                resp.extend_from_slice(&0u16.to_be_bytes());
                resp.extend_from_slice(&0u16.to_be_bytes());
                resp.extend_from_slice(&buf[12..after_name + 4]);
                for (rt, data) in records {
                    resp.extend_from_slice(&[0xC0, 0x0C]);
                    resp.extend_from_slice(&rt.to_be_bytes());
                    resp.extend_from_slice(&1u16.to_be_bytes());
                    resp.extend_from_slice(&60u32.to_be_bytes());
                    resp.extend_from_slice(&(data.len() as u16).to_be_bytes());
                    resp.extend_from_slice(&data);
                }
                let _ = server.send_to(&resp, peer).await;
            }
        });
        addr
    }

    fn namah_live(qname: &str, qtype: u16) -> MockAnswer {
        match (qname, qtype) {
            ("namah.dk", DNS_TYPE_A) => (0, vec![(DNS_TYPE_A, vec![93, 164, 62, 162])]),
            ("_qorpera.namah.dk", DNS_TYPE_TXT) => (0, vec![(DNS_TYPE_TXT, txt_rdata("qorpera-verify=tok"))]),
            ("namah.dk", DNS_TYPE_NS) => (
                0,
                vec![
                    (DNS_TYPE_NS, encode_dns_name("ns02.one.com")),
                    (DNS_TYPE_NS, encode_dns_name("ns01.one.com")),
                ],
            ),
            _ => (0, Vec::new()),
        }
    }

    fn namah_expectation() -> DnsExpectation {
        DnsExpectation {
            hostname: "namah.dk".to_string(),
            is_apex: true,
            expected_ipv4: Some("93.164.62.162".to_string()),
            expected_ipv6: None,
            expected_cname_target: Some("sites.qorpera.site".to_string()),
            verification_token: "tok".to_string(),
            require_txt: true,
        }
    }

    #[test]
    fn parses_nxdomain_rcode_and_ns_records() {
        let query = build_dns_query(7, "namah.dk", DNS_TYPE_NS).unwrap();
        let mut nx = query[..12].to_vec();
        nx[2] = 0x81;
        nx[3] = 0x83;
        let reply = parse_dns_response(&nx, 7).unwrap();
        assert_eq!(reply, DnsReply { rcode: DNS_RCODE_NXDOMAIN, records: Vec::new() });

        let mut servfail = nx.clone();
        servfail[3] = 0x82;
        assert!(parse_dns_response(&servfail, 7).is_err());
    }

    #[test]
    fn reason_tokens_name_the_wrong_txt_name_the_shop_and_a_missing_domain() {
        let expectation = namah_expectation();
        let pointed = DnsAnswers {
            a_records: vec!["93.164.62.162".to_string()],
            hostname_txt_records: vec!["\"qorpera-verify=tok\"".to_string()],
            registrable_domain_ns: vec!["NS02.one.com.".to_string(), "ns01.one.com".to_string(), "ns01.one.com.".to_string()],
            ..Default::default()
        };
        let eval = evaluate_dns(&expectation, &pointed);
        assert!(!eval.verified && eval.routing_ok && !eval.txt_ok);
        assert_eq!(eval.reason, "txt_verification_missing txt_on_wrong_name ns=ns01.one.com,ns02.one.com");

        let other_txt = DnsAnswers {
            hostname_txt_records: vec!["v=spf1 -all".to_string(), "qorpera-verify=other".to_string()],
            ..pointed.clone()
        };
        assert_eq!(
            evaluate_dns(&expectation, &other_txt).reason,
            "txt_verification_missing ns=ns01.one.com,ns02.one.com"
        );

        let nothing = DnsAnswers::default();
        assert_eq!(evaluate_dns(&expectation, &nothing).reason, "dns_routing_and_txt_missing");

        let missing = DnsAnswers {
            registrable_domain_not_found: true,
            ..Default::default()
        };
        assert_eq!(evaluate_dns(&expectation, &missing).reason, "domain_not_found");

        let sub = DnsExpectation {
            hostname: "shop.namah.dk".to_string(),
            is_apex: false,
            require_txt: false,
            ..namah_expectation()
        };
        let sub_eval = evaluate_dns(
            &sub,
            &DnsAnswers {
                registrable_domain_ns: vec!["ns1.simply.com".to_string()],
                ..Default::default()
            },
        );
        assert_eq!(sub_eval.reason, "cname_record_mismatch ns=ns1.simply.com");

        let verified = DnsAnswers {
            txt_records: vec!["qorpera-verify=tok".to_string()],
            ..pointed
        };
        let ok = evaluate_dns(&expectation, &verified);
        assert!(ok.verified);
        assert_eq!(ok.reason, "ok");
    }

    #[test]
    fn ns_token_keeps_at_most_four_hosts_and_drops_trailing_hosts_to_fit() {
        let expectation = namah_expectation();
        let many = DnsAnswers {
            a_records: vec!["93.164.62.162".to_string()],
            registrable_domain_ns: ["e", "d", "c", "b", "a", "bad host", "", "x\u{7}y"]
                .iter()
                .map(|h| format!("{h}.example.net"))
                .chain(["".to_string(), "bad,host.net".to_string()])
                .collect(),
            ..Default::default()
        };
        assert_eq!(
            evaluate_dns(&expectation, &many).reason,
            "txt_verification_missing ns=a.example.net,b.example.net,c.example.net,d.example.net"
        );

        let long_label = "a".repeat(63);
        let long_host = |c: char| format!("{c}{}.{long_label}.{long_label}.example", &long_label[1..]);
        let long = DnsAnswers {
            a_records: vec!["93.164.62.162".to_string()],
            hostname_txt_records: vec!["qorpera-verify=tok".to_string()],
            registrable_domain_ns: vec![long_host('a'), long_host('b'), long_host('c')],
            ..Default::default()
        };
        let reason = evaluate_dns(&expectation, &long).reason;
        assert!(reason.len() <= 300);
        assert_eq!(reason, format!("txt_verification_missing txt_on_wrong_name ns={}", long_host('a')));
        assert!(reason.split(' ').all(|token| !token.is_empty()));

        let longest_host = format!("{long_label}.{long_label}.{long_label}.{}", &long_label[..61]);
        assert_eq!(longest_host.len(), 253);
        let huge = DnsAnswers {
            hostname_txt_records: vec!["qorpera-verify=tok".to_string()],
            registrable_domain_ns: vec![longest_host],
            ..Default::default()
        };
        assert_eq!(
            evaluate_dns(&expectation, &huge).reason,
            "dns_routing_and_txt_missing txt_on_wrong_name"
        );
    }

    #[tokio::test]
    async fn any_server_may_confirm_when_another_serves_a_stale_nxdomain() {
        let stale = spawn_mock_dns(|_, _| (DNS_RCODE_NXDOMAIN, Vec::new())).await;
        let silent = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let silent_addr = silent.local_addr().unwrap();
        let live = spawn_mock_dns(namah_live).await;

        let started = tokio::time::Instant::now();
        let answers = resolve_domain_dns(
            &[stale, silent_addr, live],
            "namah.dk",
            Duration::from_millis(400),
        )
        .await;
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(answers.a_records, vec!["93.164.62.162".to_string()]);
        assert_eq!(answers.txt_records, vec!["qorpera-verify=tok".to_string()]);
        assert!(evaluate_dns(&namah_expectation(), &answers).verified);

        let merged = query_all_servers(&[stale, live, live], "namah.dk", DNS_TYPE_A, Duration::from_secs(1)).await;
        assert_eq!(merged.records, vec![(DNS_TYPE_A, "93.164.62.162".to_string())]);
        assert_eq!((merged.answered, merged.nxdomain), (3, 1));
        assert!(!merged.not_found_everywhere());
        drop(silent);
    }

    #[tokio::test]
    async fn diagnostics_find_a_missing_domain_the_shop_and_a_txt_on_the_wrong_name() {
        let nx_a = spawn_mock_dns(|_, _| (DNS_RCODE_NXDOMAIN, Vec::new())).await;
        let nx_b = spawn_mock_dns(|_, _| (DNS_RCODE_NXDOMAIN, Vec::new())).await;
        let silent = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let silent_addr = silent.local_addr().unwrap();
        let servers = [nx_a, nx_b, silent_addr];
        let timeout = Duration::from_millis(300);
        let mut answers = resolve_domain_dns(&servers, "namah.dk", timeout).await;
        add_domain_diagnostics(&mut answers, &servers, "namah.dk", true, timeout).await;
        assert!(answers.registrable_domain_not_found);
        assert_eq!(evaluate_dns(&namah_expectation(), &answers).reason, "domain_not_found");

        let wrong_name = spawn_mock_dns(|qname, qtype| match (qname, qtype) {
            ("namah.dk", DNS_TYPE_A) => (0, vec![(DNS_TYPE_A, vec![93, 164, 62, 162])]),
            ("namah.dk", DNS_TYPE_TXT) => (0, vec![(DNS_TYPE_TXT, txt_rdata("qorpera-verify=tok"))]),
            ("_qorpera.namah.dk", _) => (DNS_RCODE_NXDOMAIN, Vec::new()),
            ("namah.dk", DNS_TYPE_NS) => (0, vec![(DNS_TYPE_NS, encode_dns_name("ns01.one.com"))]),
            _ => (0, Vec::new()),
        })
        .await;
        let servers = [nx_a, wrong_name];
        let mut answers = resolve_domain_dns(&servers, "namah.dk", timeout).await;
        add_domain_diagnostics(&mut answers, &servers, "namah.dk", true, timeout).await;
        assert!(!answers.registrable_domain_not_found);
        assert_eq!(
            evaluate_dns(&namah_expectation(), &answers).reason,
            "txt_verification_missing txt_on_wrong_name ns=ns01.one.com"
        );

        let record_missing = spawn_mock_dns(|qname, qtype| match (qname, qtype) {
            ("shop.namah.dk", _) => (DNS_RCODE_NXDOMAIN, Vec::new()),
            ("namah.dk", DNS_TYPE_NS) => (0, vec![(DNS_TYPE_NS, encode_dns_name("ns01.one.com."))]),
            _ => (0, Vec::new()),
        })
        .await;
        let mut answers = resolve_domain_dns(&[record_missing], "shop.namah.dk", timeout).await;
        add_domain_diagnostics(&mut answers, &[record_missing], "shop.namah.dk", false, timeout).await;
        assert!(!answers.registrable_domain_not_found);
        let sub = DnsExpectation {
            hostname: "shop.namah.dk".to_string(),
            is_apex: false,
            require_txt: false,
            ..namah_expectation()
        };
        assert_eq!(evaluate_dns(&sub, &answers).reason, "cname_record_mismatch ns=ns01.one.com");
        assert_eq!(registrable_domain("shop.namah.dk."), "namah.dk");
        assert_eq!(registrable_domain("namah.dk"), "namah.dk");
        drop(silent);
    }

    #[tokio::test]
    async fn persist_tracker_skips_unchanged_inside_heartbeat_and_prunes_removed() {
        let tracker = DomainPersistTracker::new();
        let hb = Duration::from_millis(60);
        assert!(tracker.should_persist("dom-1", false, hb));
        tracker.mark_persisted("dom-1");
        assert!(!tracker.should_persist("dom-1", false, hb));
        assert!(tracker.should_persist("dom-1", true, hb));

        tokio::time::sleep(Duration::from_millis(70)).await;
        assert!(tracker.should_persist("dom-1", false, hb));
        tracker.mark_persisted("dom-1");

        tracker.prune_missing(&HashSet::from(["dom-2".to_string()]));
        assert!(tracker.should_persist("dom-1", false, hb));
    }

    #[tokio::test]
    async fn falls_back_to_tcp_when_udp_response_sets_tc_bit() {
        let tcp_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = tcp_listener.local_addr().unwrap();
        let udp_server = UdpSocket::bind(addr).await.unwrap();

        tokio::spawn(async move {
            let mut buf = [0u8; 512];
            let Ok((n, peer)) = udp_server.recv_from(&mut buf).await else {
                return;
            };
            if n < 12 {
                return;
            }
            let (_, after_name) = read_dns_name(&buf[..n], 12).unwrap();
            let mut resp = Vec::new();
            resp.extend_from_slice(&buf[0..2]);
            resp.extend_from_slice(&0x8380u16.to_be_bytes());
            resp.extend_from_slice(&1u16.to_be_bytes());
            resp.extend_from_slice(&0u16.to_be_bytes());
            resp.extend_from_slice(&0u16.to_be_bytes());
            resp.extend_from_slice(&0u16.to_be_bytes());
            resp.extend_from_slice(&buf[12..after_name + 4]);
            let _ = udp_server.send_to(&resp, peer).await;
        });

        tokio::spawn(async move {
            let Ok((mut stream, _)) = tcp_listener.accept().await else {
                return;
            };
            let mut len_buf = [0u8; 2];
            if stream.read_exact(&mut len_buf).await.is_err() {
                return;
            }
            let qlen = u16::from_be_bytes(len_buf) as usize;
            let mut qbuf = vec![0u8; qlen];
            if stream.read_exact(&mut qbuf).await.is_err() {
                return;
            }
            let (_, after_name) = read_dns_name(&qbuf, 12).unwrap();
            let txt = b"qorpera-verify=tcp-fallback-token";
            let mut rdata = vec![txt.len() as u8];
            rdata.extend_from_slice(txt);
            let mut resp = Vec::new();
            resp.extend_from_slice(&qbuf[0..2]);
            resp.extend_from_slice(&0x8180u16.to_be_bytes());
            resp.extend_from_slice(&1u16.to_be_bytes());
            resp.extend_from_slice(&1u16.to_be_bytes());
            resp.extend_from_slice(&0u16.to_be_bytes());
            resp.extend_from_slice(&0u16.to_be_bytes());
            resp.extend_from_slice(&qbuf[12..after_name + 4]);
            resp.extend_from_slice(&[0xC0, 0x0C]);
            resp.extend_from_slice(&DNS_TYPE_TXT.to_be_bytes());
            resp.extend_from_slice(&1u16.to_be_bytes());
            resp.extend_from_slice(&60u32.to_be_bytes());
            resp.extend_from_slice(&(rdata.len() as u16).to_be_bytes());
            resp.extend_from_slice(&rdata);
            let mut framed = Vec::with_capacity(2 + resp.len());
            framed.extend_from_slice(&(resp.len() as u16).to_be_bytes());
            framed.extend_from_slice(&resp);
            let _ = stream.write_all(&framed).await;
        });

        let records = query_dns_udp(addr, "_qorpera.big-txt.example", DNS_TYPE_TXT, Duration::from_secs(2))
            .await
            .unwrap();
        assert_eq!(records.records, vec![(DNS_TYPE_TXT, "qorpera-verify=tcp-fallback-token".to_string())]);
    }
}
