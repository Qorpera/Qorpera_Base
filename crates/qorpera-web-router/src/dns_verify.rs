use serde::{Deserialize, Serialize};

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
            .map_or(false, |exp| answers.aaaa_records.iter().any(|a| a.trim().eq_ignore_ascii_case(exp)));
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
}
