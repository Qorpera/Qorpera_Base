use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const SHARD_COUNT: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RateDecision {
    pub allowed: bool,
    pub retry_after_secs: u64,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct Key128(u64, u64);

struct Bucket {
    tokens: f64,
    last_refill: Instant,
}

struct Shard {
    buckets: HashMap<Key128, Bucket>,
    fifo: VecDeque<Key128>,
    last_sweep: Option<Instant>,
}

impl Shard {
    fn new() -> Self {
        Self {
            buckets: HashMap::new(),
            fifo: VecDeque::new(),
            last_sweep: None,
        }
    }
}

pub struct RateLimiter {
    rate_per_sec: f64,
    burst: f64,
    per_shard_cap: usize,
    stale_cutoff: Duration,
    shards: Vec<Mutex<Shard>>,
}

#[inline]
fn hash_pair_128(a: &str, b: &str) -> Key128 {
    let mut h1: u64 = 0xcbf29ce484222325;
    let mut h2: u64 = 0x84222325cbf29ce4;
    for byte in a.as_bytes() {
        let v = *byte as u64;
        h1 = (h1 ^ v).wrapping_mul(0x100000001b3);
        h2 = h2.wrapping_mul(0x9e3779b97f4a7c15).wrapping_add(v ^ 0x55);
    }
    h1 = (h1 ^ (b'|' as u64)).wrapping_mul(0x100000001b3);
    h2 = h2.wrapping_mul(0x9e3779b97f4a7c15).wrapping_add(0xff);
    for byte in b.as_bytes() {
        let v = *byte as u64;
        h1 = (h1 ^ v).wrapping_mul(0x100000001b3);
        h2 = h2.wrapping_mul(0x9e3779b97f4a7c15).wrapping_add(v ^ 0xaa);
    }
    h2 ^= h2 >> 33;
    h2 = h2.wrapping_mul(0xff51afd7ed558ccd);
    h2 ^= h2 >> 33;
    Key128(h1, h2)
}

#[inline]
fn hash_str_128(s: &str) -> Key128 {
    let mut h1: u64 = 0xcbf29ce484222325;
    let mut h2: u64 = 0x84222325cbf29ce4;
    for byte in s.as_bytes() {
        let v = *byte as u64;
        h1 = (h1 ^ v).wrapping_mul(0x100000001b3);
        h2 = h2.wrapping_mul(0x9e3779b97f4a7c15).wrapping_add(v ^ 0x55);
    }
    h2 ^= h2 >> 33;
    h2 = h2.wrapping_mul(0xff51afd7ed558ccd);
    h2 ^= h2 >> 33;
    Key128(h1, h2)
}

impl RateLimiter {
    pub fn new(rate_per_sec: f64, burst: f64, max_entries: usize) -> Self {
        let rps = rate_per_sec.max(0.01);
        let b = burst.max(1.0);
        let total_cap = max_entries.max(SHARD_COUNT);
        let per_shard_cap = (total_cap + SHARD_COUNT - 1) / SHARD_COUNT;
        let stale_cutoff = Duration::from_secs(((b / rps).ceil() as u64).max(60));
        let mut shards = Vec::with_capacity(SHARD_COUNT);
        for _ in 0..SHARD_COUNT {
            shards.push(Mutex::new(Shard::new()));
        }
        Self {
            rate_per_sec: rps,
            burst: b,
            per_shard_cap: per_shard_cap.max(1),
            stale_cutoff,
            shards,
        }
    }

    pub fn check(&self, key: &str) -> RateDecision {
        let k = hash_str_128(key);
        let shard_idx = (k.0 as usize) & (SHARD_COUNT - 1);
        self.check_in_shard(shard_idx, k, Instant::now())
    }

    pub fn check_pair(&self, host: &str, client_ip: &str) -> RateDecision {
        let k = hash_pair_128(host, client_ip);
        let shard_idx = (k.0 as usize) & (SHARD_COUNT - 1);
        self.check_in_shard(shard_idx, k, Instant::now())
    }

    pub fn check_at(&self, key: &str, now: Instant) -> RateDecision {
        let k = hash_str_128(key);
        let shard_idx = (k.0 as usize) & (SHARD_COUNT - 1);
        self.check_in_shard(shard_idx, k, now)
    }

    fn check_in_shard(&self, shard_idx: usize, key: Key128, now: Instant) -> RateDecision {
        let Ok(mut shard) = self.shards[shard_idx].lock() else {
            return RateDecision {
                allowed: true,
                retry_after_secs: 0,
            };
        };

        if let Some(entry) = shard.buckets.get_mut(&key) {
            return self.consume(entry, now);
        }

        if shard.buckets.len() >= self.per_shard_cap {
            let should_sweep = shard
                .last_sweep
                .map_or(true, |last| now.saturating_duration_since(last) >= Duration::from_secs(1));
            if should_sweep {
                let cutoff = self.stale_cutoff;
                shard
                    .buckets
                    .retain(|_, b| now.saturating_duration_since(b.last_refill) < cutoff);
                shard.last_sweep = Some(now);
            }
            while shard.buckets.len() >= self.per_shard_cap {
                if let Some(candidate) = shard.fifo.pop_front() {
                    shard.buckets.remove(&candidate);
                } else {
                    break;
                }
            }
            if shard.fifo.len() > self.per_shard_cap * 2 {
                let Shard { buckets, fifo, .. } = &mut *shard;
                fifo.retain(|k| buckets.contains_key(k));
            }
        }

        shard.fifo.push_back(key);
        let entry = shard.buckets.entry(key).or_insert(Bucket {
            tokens: self.burst,
            last_refill: now,
        });
        self.consume(entry, now)
    }

    #[inline]
    fn consume(&self, entry: &mut Bucket, now: Instant) -> RateDecision {
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

    #[cfg(test)]
    fn total_entries(&self) -> usize {
        self.shards
            .iter()
            .map(|s| s.lock().map_or(0, |g| g.buckets.len()))
            .sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enforces_burst_and_refills() {
        let limiter = RateLimiter::new(2.0, 2.0, 128);
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
        let limiter = RateLimiter::new(10.0, 10.0, 128);
        let t0 = Instant::now();
        for i in 0..2000 {
            limiter.check_at(&format!("198.51.100.{i}"), t0);
        }
        assert!(limiter.total_entries() <= 128);
    }
}
