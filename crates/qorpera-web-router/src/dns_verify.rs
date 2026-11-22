use crate::postgres_sync::connect_postgres_client;
use crate::routes::{DomainStatus, SharedRoutes};
use serde::{Deserialize, Serialize};
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::net::UdpSocket;
use tokio::sync::{mpsc, Semaphore};
use tokio::task::JoinSet;
use tracing::{info, warn};

pub const DNS_TYPE_A: u16 = 1;
pub const DNS_TYPE_CNAME: u16 = 5;
pub const DNS_TYPE_TXT: u16 = 16;
pub const DNS_TYPE_AAAA: u16 = 28;
const MAX_PARALLEL_DOMAIN_CHECKS: usize = 16;
const DB_OP_TIMEOUT: Duration = Duration::from_secs(5);

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
}

pub fn evaluate_dns(expectation: &DnsExpectation, answers: &DnsAnswers) -> DnsVerificationResult {
    let expected_txt = format!("qorpera-verify={}", expectation.verification_token);
    let txt_ok = !expectation.require_txt
        || answers
            .txt_records
            .iter()
            .any(|raw| raw.trim_matches('"').trim() == expected_txt);

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
    } else if !routing_ok && !txt_ok {
        "dns_routing_and_txt_missing".to_string()
    } else if !routing_ok {
        if expectation.is_apex {
            "apex_a_record_mismatch".to_string()
        } else {
            "cname_record_mismatch".to_string()
        }
    } else {
        "txt_verification_missing".to_string()
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
    pkt.extend_from_slice(&0u16.to_be_bytes());
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

pub fn parse_dns_response(packet: &[u8], expected_tx_id: u16) -> Result<Vec<(u16, String)>, String> {
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
    let rcode = flags & 0x000F;
    if rcode == 3 {
        return Ok(Vec::new());
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
            DNS_TYPE_CNAME => {
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

    Ok(out)
}

pub async fn query_dns_udp(
    server: SocketAddr,
    qname: &str,
    qtype: u16,
    timeout: Duration,
) -> Result<Vec<(u16, String)>, String> {
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
    let mut buf = [0u8; 2048];
    let n = tokio::time::timeout(timeout, sock.recv(&mut buf))
        .await
        .map_err(|_| "dns_timeout".to_string())?
        .map_err(|e| format!("dns_recv: {e}"))?;
    parse_dns_response(&buf[..n], tx_id)
}

async fn query_with_fallback(
    servers: &[SocketAddr],
    qname: &str,
    qtype: u16,
    timeout: Duration,
) -> Vec<(u16, String)> {
    for server in servers {
        if let Ok(records) = query_dns_udp(*server, qname, qtype, timeout).await {
            return records;
        }
    }
    Vec::new()
}

pub async fn resolve_domain_dns(
    servers: &[SocketAddr],
    hostname: &str,
    timeout: Duration,
) -> DnsAnswers {
    let txt_host = format!("_qorpera.{hostname}");
    let (a_res, aaaa_res, cname_res, txt_res) = tokio::join!(
        query_with_fallback(servers, hostname, DNS_TYPE_A, timeout),
        query_with_fallback(servers, hostname, DNS_TYPE_AAAA, timeout),
        query_with_fallback(servers, hostname, DNS_TYPE_CNAME, timeout),
        query_with_fallback(servers, &txt_host, DNS_TYPE_TXT, timeout),
    );
    let mut answers = DnsAnswers::default();
    for (rt, val) in a_res
        .into_iter()
        .chain(aaaa_res)
        .chain(cname_res)
        .chain(txt_res)
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

fn status_sql_str(status: DomainStatus) -> &'static str {
    match status {
        DomainStatus::PendingDns => "pending_dns",
        DomainStatus::DnsVerified => "dns_verified",
        DomainStatus::TlsActive => "tls_active",
        DomainStatus::Moved => "moved",
        DomainStatus::Failed => "failed",
    }
}

pub async fn verify_domains_once(
    routes: &Arc<SharedRoutes>,
    dns_servers: &[SocketAddr],
    database_url: Option<&str>,
    query_timeout: Duration,
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
        return Vec::new();
    }

    let db_client = if let Some(url) = database_url {
        match connect_postgres_client(url, DB_OP_TIMEOUT).await {
            Ok(client) => Some(Arc::new(client)),
            Err(err) => {
                warn!(error = %err, "dns verifier postgres connect failed");
                None
            }
        }
    } else {
        None
    };

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
        let db_ref = db_client.clone();

        set.spawn(async move {
            let _permit = permit;
            let answers = resolve_domain_dns(&targets_ref.servers, &domain.hostname, query_timeout).await;
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
            let eval = evaluate_dns(&expectation, &answers);
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

            if let Some(ref client) = db_ref {
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
                    }
                    Err(_) => {
                        warn!(domain = %domain.hostname, "timed out persisting domain check");
                    }
                    Ok(Ok(_)) => {}
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

            let next_misses = if eval.verified {
                0
            } else {
                domain.consecutive_misses.saturating_add(1)
            };
            let changed_in_memory =
                next_status != domain.status || next_misses != domain.consecutive_misses;

            (
                DomainCheckOutcome {
                    id: domain.id,
                    hostname: domain.hostname,
                    previous_status: domain.status,
                    next_status,
                    reason: eval.reason,
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
    if !changed_batch.is_empty() {
        routes.update(|table| {
            table.update_domain_checks(&changed_batch);
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
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ticker.tick().await;
        let min_trigger_gap = Duration::from_secs(2);
        let mut last_sweep = tokio::time::Instant::now() - min_trigger_gap;
        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    let _ = verify_domains_once(&routes, &dns_servers, database_url.as_deref(), Duration::from_secs(3)).await;
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
                    let _ = verify_domains_once(&routes, &dns_servers, database_url.as_deref(), Duration::from_secs(3)).await;
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
}
