use crate::postgres_sync::connect_postgres_client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::watch;
use tracing::{info, warn};

const MAX_TELEMETRY_BUCKETS: usize = 4096;
const MAX_SAMPLES_PER_BUCKET: usize = 256;
const MAX_FLUSH_BATCH_SIZE: usize = 500;
const TELEMETRY_FLUSH_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct BucketKey {
    site_id: String,
    deployment_id: String,
    hour_unix: i64,
}

#[derive(Debug, Clone, Default)]
struct BucketAccumulator {
    requests: u64,
    status_2xx: u64,
    status_3xx: u64,
    status_4xx: u64,
    status_5xx: u64,
    latency_sum_ms: u64,
    latency_max_ms: u32,
    samples: Vec<u32>,
    p50_hint_ms: Option<u32>,
    p95_hint_ms: Option<u32>,
}

impl BucketAccumulator {
    fn record(&mut self, status: u16, latency_ms: u32) {
        self.requests = self.requests.saturating_add(1);
        match status {
            200..=299 => self.status_2xx = self.status_2xx.saturating_add(1),
            300..=399 => self.status_3xx = self.status_3xx.saturating_add(1),
            400..=499 => self.status_4xx = self.status_4xx.saturating_add(1),
            500..=599 => self.status_5xx = self.status_5xx.saturating_add(1),
            _ => {}
        }
        self.latency_sum_ms = self.latency_sum_ms.saturating_add(u64::from(latency_ms));
        if latency_ms > self.latency_max_ms {
            self.latency_max_ms = latency_ms;
        }
        if self.samples.len() < MAX_SAMPLES_PER_BUCKET {
            self.samples.push(latency_ms);
        } else {
            let slot = (self.requests as usize).wrapping_mul(2654435761) % MAX_SAMPLES_PER_BUCKET;
            self.samples[slot] = latency_ms;
        }
        self.p50_hint_ms = None;
        self.p95_hint_ms = None;
    }

    fn merge_payload(&mut self, payload: &AppTelemetryBucketPayload) {
        let prev_requests = self.requests;
        self.requests = self.requests.saturating_add(payload.requests);
        self.status_2xx = self.status_2xx.saturating_add(payload.status_2xx);
        self.status_3xx = self.status_3xx.saturating_add(payload.status_3xx);
        self.status_4xx = self.status_4xx.saturating_add(payload.status_4xx);
        self.status_5xx = self.status_5xx.saturating_add(payload.status_5xx);
        self.latency_sum_ms = self.latency_sum_ms.saturating_add(payload.latency_sum_ms);
        if payload.latency_max_ms > self.latency_max_ms {
            self.latency_max_ms = payload.latency_max_ms;
        }
        if self.samples.is_empty() && prev_requests == 0 {
            self.p50_hint_ms = Some(payload.latency_p50_ms);
            self.p95_hint_ms = Some(payload.latency_p95_ms);
        } else {
            if self.samples.len() < MAX_SAMPLES_PER_BUCKET {
                self.samples.push(payload.latency_p50_ms);
            }
            if self.samples.len() < MAX_SAMPLES_PER_BUCKET {
                self.samples.push(payload.latency_p95_ms);
            }
        }
    }

    fn percentiles(&self) -> (u32, u32) {
        if self.samples.is_empty() {
            let fallback = if self.requests > 0 {
                (self.latency_sum_ms / self.requests).min(u64::from(u32::MAX)) as u32
            } else {
                0
            };
            return (
                self.p50_hint_ms.unwrap_or(fallback),
                self.p95_hint_ms.unwrap_or(self.latency_max_ms.max(fallback)),
            );
        }
        let mut sorted = self.samples.clone();
        sorted.sort_unstable();
        let len = sorted.len();
        let p50_idx = (len - 1) * 50 / 100;
        let p95_idx = (len - 1) * 95 / 100;
        (sorted[p50_idx], sorted[p95_idx])
    }

    fn to_payload(&self, key: &BucketKey) -> AppTelemetryBucketPayload {
        let (p50, p95) = self.percentiles();
        AppTelemetryBucketPayload {
            site_id: key.site_id.clone(),
            deployment_id: key.deployment_id.clone(),
            hour_unix: key.hour_unix,
            requests: self.requests,
            status_2xx: self.status_2xx,
            status_3xx: self.status_3xx,
            status_4xx: self.status_4xx,
            status_5xx: self.status_5xx,
            latency_sum_ms: self.latency_sum_ms,
            latency_p50_ms: p50,
            latency_p95_ms: p95,
            latency_max_ms: self.latency_max_ms,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppTelemetryBucketPayload {
    pub site_id: String,
    pub deployment_id: String,
    pub hour_unix: i64,
    pub requests: u64,
    pub status_2xx: u64,
    pub status_3xx: u64,
    pub status_4xx: u64,
    pub status_5xx: u64,
    pub latency_sum_ms: u64,
    pub latency_p50_ms: u32,
    pub latency_p95_ms: u32,
    pub latency_max_ms: u32,
}

#[derive(Default)]
pub struct AppTelemetryTracker {
    buckets: Mutex<HashMap<BucketKey, BucketAccumulator>>,
}

impl AppTelemetryTracker {
    pub fn new() -> Self {
        Self {
            buckets: Mutex::new(HashMap::new()),
        }
    }

    pub fn record(&self, site_id: &str, deployment_id: &str, status: u16, latency_ms: u32) {
        let now_secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs() as i64);
        self.record_at(site_id, deployment_id, status, latency_ms, now_secs);
    }

    pub fn record_at(
        &self,
        site_id: &str,
        deployment_id: &str,
        status: u16,
        latency_ms: u32,
        unix_secs: i64,
    ) {
        if site_id.is_empty() || deployment_id.is_empty() || unix_secs <= 0 {
            return;
        }
        let hour_unix = unix_secs - unix_secs.rem_euclid(3600);
        let key = BucketKey {
            site_id: site_id.to_string(),
            deployment_id: deployment_id.to_string(),
            hour_unix,
        };
        let Ok(mut map) = self.buckets.lock() else {
            return;
        };
        if !map.contains_key(&key) && map.len() >= MAX_TELEMETRY_BUCKETS {
            return;
        }
        map.entry(key).or_default().record(status, latency_ms);
    }

    pub fn snapshot(&self) -> Vec<AppTelemetryBucketPayload> {
        let Ok(map) = self.buckets.lock() else {
            return Vec::new();
        };
        let mut out: Vec<AppTelemetryBucketPayload> = map
            .iter()
            .map(|(k, v)| v.to_payload(k))
            .collect();
        out.sort_by(|a, b| {
            a.hour_unix
                .cmp(&b.hour_unix)
                .then_with(|| a.site_id.cmp(&b.site_id))
                .then_with(|| a.deployment_id.cmp(&b.deployment_id))
        });
        out
    }

    pub fn drain(&self) -> Vec<AppTelemetryBucketPayload> {
        let Ok(mut map) = self.buckets.lock() else {
            return Vec::new();
        };
        if map.is_empty() {
            return Vec::new();
        }
        let taken = std::mem::take(&mut *map);
        let mut out: Vec<AppTelemetryBucketPayload> = taken
            .into_iter()
            .map(|(k, v)| v.to_payload(&k))
            .collect();
        out.sort_by(|a, b| {
            a.hour_unix
                .cmp(&b.hour_unix)
                .then_with(|| a.site_id.cmp(&b.site_id))
                .then_with(|| a.deployment_id.cmp(&b.deployment_id))
        });
        out
    }

    pub fn requeue(&self, buckets: Vec<AppTelemetryBucketPayload>) {
        if buckets.is_empty() {
            return;
        }
        let Ok(mut map) = self.buckets.lock() else {
            return;
        };
        for bucket in buckets {
            if bucket.requests == 0 {
                continue;
            }
            let key = BucketKey {
                site_id: bucket.site_id.clone(),
                deployment_id: bucket.deployment_id.clone(),
                hour_unix: bucket.hour_unix,
            };
            if !map.contains_key(&key) && map.len() >= MAX_TELEMETRY_BUCKETS {
                continue;
            }
            map.entry(key).or_default().merge_payload(&bucket);
        }
    }
}

async fn flush_batch_to_postgres(
    database_url: &str,
    batch: &[AppTelemetryBucketPayload],
) -> Result<i32, String> {
    if batch.is_empty() {
        return Ok(0);
    }
    let payload = serde_json::to_value(batch).map_err(|e| format!("serialize failed: {e}"))?;
    let client = connect_postgres_client(database_url, TELEMETRY_FLUSH_TIMEOUT).await?;
    let row = tokio::time::timeout(
        TELEMETRY_FLUSH_TIMEOUT,
        client.query_one("SELECT public.qorpera_ingest_app_telemetry($1::jsonb)", &[&payload]),
    )
    .await
    .map_err(|_| "postgres ingest timed out".to_string())?
    .map_err(|e| format!("postgres ingest failed: {e}"))?;
    Ok(row.try_get::<_, i32>(0).unwrap_or(0))
}

pub async fn flush_telemetry_once(database_url: &str, telemetry: &AppTelemetryTracker) {
    let drained = telemetry.drain();
    if drained.is_empty() {
        return;
    }
    let mut failed: Vec<AppTelemetryBucketPayload> = Vec::new();
    for chunk in drained.chunks(MAX_FLUSH_BATCH_SIZE) {
        if let Err(err) = flush_batch_to_postgres(database_url, chunk).await {
            warn!(error = %err, buckets = chunk.len(), "failed flushing app telemetry batch");
            failed.extend_from_slice(chunk);
        }
    }
    if !failed.is_empty() {
        telemetry.requeue(failed);
    }
}

pub fn spawn_telemetry_flusher(
    database_url: String,
    telemetry: Arc<AppTelemetryTracker>,
    interval: Duration,
    mut shutdown: watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval.max(Duration::from_secs(5)));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        ticker.tick().await;
        loop {
            tokio::select! {
                biased;
                changed = shutdown.changed() => {
                    if changed.is_err() || *shutdown.borrow() {
                        flush_telemetry_once(&database_url, &telemetry).await;
                        info!("flushed app telemetry on shutdown");
                        break;
                    }
                }
                _ = ticker.tick() => {
                    flush_telemetry_once(&database_url, &telemetry).await;
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_status_classes_and_percentiles_per_hour() {
        let tracker = AppTelemetryTracker::new();
        let base_hour = 1_764_201_600i64;
        tracker.record_at("site-a", "dep-1", 200, 10, base_hour + 5);
        tracker.record_at("site-a", "dep-1", 201, 20, base_hour + 60);
        tracker.record_at("site-a", "dep-1", 302, 30, base_hour + 120);
        tracker.record_at("site-a", "dep-1", 404, 40, base_hour + 240);
        tracker.record_at("site-a", "dep-1", 502, 100, base_hour + 300);
        tracker.record_at("site-a", "dep-1", 200, 50, base_hour + 3605);

        let snap = tracker.snapshot();
        assert_eq!(snap.len(), 2);
        assert_eq!(snap[0].site_id, "site-a");
        assert_eq!(snap[0].deployment_id, "dep-1");
        assert_eq!(snap[0].hour_unix, base_hour);
        assert_eq!(snap[0].requests, 5);
        assert_eq!(snap[0].status_2xx, 2);
        assert_eq!(snap[0].status_3xx, 1);
        assert_eq!(snap[0].status_4xx, 1);
        assert_eq!(snap[0].status_5xx, 1);
        assert_eq!(snap[0].latency_sum_ms, 200);
        assert_eq!(snap[0].latency_p50_ms, 30);
        assert_eq!(snap[0].latency_p95_ms, 40);
        assert_eq!(snap[0].latency_max_ms, 100);

        assert_eq!(snap[1].hour_unix, base_hour + 3600);
        assert_eq!(snap[1].requests, 1);
        assert_eq!(snap[1].status_2xx, 1);
    }

    #[test]
    fn drain_clears_and_requeue_merges_with_new_traffic() {
        let tracker = AppTelemetryTracker::new();
        let base_hour = 1_764_201_600i64;
        tracker.record_at("site-a", "dep-1", 200, 25, base_hour + 10);
        let drained = tracker.drain();
        assert_eq!(drained.len(), 1);
        assert!(tracker.snapshot().is_empty());

        tracker.record_at("site-a", "dep-1", 500, 80, base_hour + 20);
        tracker.requeue(drained);

        let merged = tracker.snapshot();
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].requests, 2);
        assert_eq!(merged[0].status_2xx, 1);
        assert_eq!(merged[0].status_5xx, 1);
        assert_eq!(merged[0].latency_sum_ms, 105);
        assert_eq!(merged[0].latency_max_ms, 80);
    }
}
