use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub const DEFAULT_MAX_LOG_DEPLOYMENTS: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub ts_ms: u64,
    pub stream: String,
    pub line: String,
}

struct DeploymentLogBuf {
    entries: VecDeque<LogEntry>,
    total_bytes: usize,
}

struct LogStore {
    per_deployment: HashMap<String, DeploymentLogBuf>,
    order: VecDeque<String>,
}

pub struct LogRingBuffer {
    max_lines: usize,
    max_bytes: usize,
    max_deployments: usize,
    store: Mutex<LogStore>,
}

impl LogRingBuffer {
    pub fn new(max_lines: usize, max_bytes: usize) -> Self {
        Self::with_max_deployments(max_lines, max_bytes, DEFAULT_MAX_LOG_DEPLOYMENTS)
    }

    pub fn with_max_deployments(
        max_lines: usize,
        max_bytes: usize,
        max_deployments: usize,
    ) -> Self {
        Self {
            max_lines: max_lines.max(16),
            max_bytes: max_bytes.max(4096),
            max_deployments: max_deployments.max(1),
            store: Mutex::new(LogStore {
                per_deployment: HashMap::new(),
                order: VecDeque::new(),
            }),
        }
    }

    pub fn push(&self, deployment_id: &str, stream: &str, line: String) {
        let ts_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64);
        let clipped = if line.len() > 4096 {
            let mut end = 4096;
            while end > 0 && !line.is_char_boundary(end) {
                end -= 1;
            }
            line[..end].to_string()
        } else {
            line
        };
        let entry_bytes = clipped.len() + stream.len() + 16;
        let Ok(mut store) = self.store.lock() else {
            return;
        };
        if !store.per_deployment.contains_key(deployment_id) {
            while store.per_deployment.len() >= self.max_deployments {
                let Some(oldest) = store.order.pop_front() else {
                    break;
                };
                store.per_deployment.remove(&oldest);
            }
            let key = deployment_id.to_string();
            store.order.push_back(key.clone());
            store.per_deployment.insert(
                key,
                DeploymentLogBuf {
                    entries: VecDeque::new(),
                    total_bytes: 0,
                },
            );
        }
        let Some(buf) = store.per_deployment.get_mut(deployment_id) else {
            return;
        };
        while (buf.entries.len() >= self.max_lines || buf.total_bytes + entry_bytes > self.max_bytes)
            && !buf.entries.is_empty()
        {
            if let Some(old) = buf.entries.pop_front() {
                buf.total_bytes = buf
                    .total_bytes
                    .saturating_sub(old.line.len() + old.stream.len() + 16);
            }
        }
        buf.total_bytes += entry_bytes;
        buf.entries.push_back(LogEntry {
            ts_ms,
            stream: stream.to_string(),
            line: clipped,
        });
    }

    pub fn remove(&self, deployment_id: &str) {
        if let Ok(mut store) = self.store.lock() {
            if store.per_deployment.remove(deployment_id).is_some() {
                store.order.retain(|k| k != deployment_id);
            }
        }
    }

    pub fn tail(&self, deployment_id: &str, limit: usize) -> Vec<LogEntry> {
        let Ok(store) = self.store.lock() else {
            return Vec::new();
        };
        let Some(buf) = store.per_deployment.get(deployment_id) else {
            return Vec::new();
        };
        let take = limit.min(buf.entries.len());
        buf.entries
            .iter()
            .skip(buf.entries.len().saturating_sub(take))
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_lines_and_returns_tail() {
        let logs = LogRingBuffer::new(16, 4096);
        for i in 0..30 {
            logs.push("dep-1", "stdout", format!("line-{i}"));
        }
        let tail = logs.tail("dep-1", 3);
        assert_eq!(tail.len(), 3);
        assert_eq!(tail[0].line, "line-27");
        assert_eq!(tail[2].line, "line-29");

        let multibyte = format!("{}øæå", "a".repeat(4095));
        logs.push("dep-utf8", "stdout", multibyte);
        let utf8_tail = logs.tail("dep-utf8", 1);
        assert_eq!(utf8_tail.len(), 1);
        assert_eq!(utf8_tail[0].line.len(), 4095);
    }

    #[test]
    fn bounds_total_deployments_with_fifo_eviction() {
        let logs = LogRingBuffer::with_max_deployments(16, 4096, 4);
        for i in 0..10 {
            logs.push(&format!("dep-{i}"), "stdout", format!("msg-{i}"));
        }
        assert!(logs.tail("dep-0", 10).is_empty());
        assert!(logs.tail("dep-5", 10).is_empty());
        assert_eq!(logs.tail("dep-6", 10).len(), 1);
        assert_eq!(logs.tail("dep-9", 10).len(), 1);
        logs.remove("dep-9");
        assert!(logs.tail("dep-9", 10).is_empty());
    }
}
