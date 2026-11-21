use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RateDecision {
    pub allowed: bool,
    pub retry_after_secs: u64,
}

struct Bucket {
    tokens: f64,
    last_refill: Instant,
}

pub struct RateLimiter {
    rate_per_sec: f64,
    burst: f64,
    max_entries: usize,
    buckets: Mutex<HashMap<String, Bucket>>,
}

impl RateLimiter {
    pub fn new(rate_per_sec: f64, burst: f64, max_entries: usize) -> Self {
        Self {
            rate_per_sec: rate_per_sec.max(0.01),
            burst: burst.max(1.0),
            max_entries: max_entries.max(16),
            buckets: Mutex::new(HashMap::new()),
        }
    }

    pub fn check(&self, key: &str) -> RateDecision {
        self.check_at(key, Instant::now())
    }

    pub fn check_at(&self, key: &str, now: Instant) -> RateDecision {
        let Ok(mut map) = self.buckets.lock() else {
            return RateDecision {
                allowed: true,
                retry_after_secs: 0,
            };
        };
        if !map.contains_key(key) && map.len() >= self.max_entries {
            let stale_cutoff = Duration::from_secs(((self.burst / self.rate_per_sec).ceil() as u64).max(60));
            map.retain(|_, b| now.saturating_duration_since(b.last_refill) < stale_cutoff);
            if map.len() >= self.max_entries {
                if let Some(oldest_key) = map
                    .iter()
                    .min_by_key(|(_, b)| b.last_refill)
                    .map(|(k, _)| k.clone())
                {
                    map.remove(&oldest_key);
                }
            }
        }
        let entry = map.entry(key.to_string()).or_insert(Bucket {
            tokens: self.burst,
            last_refill: now,
        });
        let elapsed = now.saturating_duration_since(entry.last_refill).as_secs_f64();
        entry.tokens = (entry.tokens + elapsed * self.rate_per_sec).min(self.burst);
        entry.last_refill = now;
        if entry.tokens >= 1.0 {
            entry.tokens -= 1.0;
            RateDecision {
                allowed: true,
                retry_after_secs: 0,
            }
        } else {
            let deficit = 1.0 - entry.tokens;
            let wait = (deficit / self.rate_per_sec).ceil().max(1.0) as u64;
            RateDecision {
                allowed: false,
                retry_after_secs: wait,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enforces_burst_and_refills() {
        let limiter = RateLimiter::new(2.0, 2.0, 100);
        let t0 = Instant::now();
        assert!(limiter.check_at("1.2.3.4", t0).allowed);
        assert!(limiter.check_at("1.2.3.4", t0).allowed);
        let blocked = limiter.check_at("1.2.3.4", t0);
        assert!(!blocked.allowed);
        assert!(blocked.retry_after_secs >= 1);
        assert!(limiter.check_at("1.2.3.4", t0 + Duration::from_millis(600)).allowed);
    }

    #[test]
    fn bounds_memory_under_unique_keys() {
        let limiter = RateLimiter::new(10.0, 10.0, 16);
        let t0 = Instant::now();
        for i in 0..64 {
            limiter.check_at(&format!("198.51.100.{i}"), t0);
        }
        assert!(limiter.buckets.lock().unwrap().len() <= 16);
    }
}
