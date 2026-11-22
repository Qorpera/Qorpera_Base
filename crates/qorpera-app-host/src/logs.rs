use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

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

pub struct LogRingBuffer {
    max_lines: usize,
    max_bytes: usize,
    per_deployment: Mutex<HashMap<String, DeploymentLogBuf>>,
}

impl LogRingBuffer {
    pub fn new(max_lines: usize, max_bytes: usize) -> Self {
        Self {
            max_lines: max_lines.max(16),
            max_bytes: max_bytes.max(4096),
            per_deployment: Mutex::new(HashMap::new()),
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
        let Ok(mut map) = self.per_deployment.lock() else {
            return;
        };
        let buf = map
            .entry(deployment_id.to_string())
            .or_insert_with(|| DeploymentLogBuf {
                entries: VecDeque::new(),
                total_bytes: 0,
            });
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

    pub fn tail(&self, deployment_id: &str, limit: usize) -> Vec<LogEntry> {
        let Ok(map) = self.per_deployment.lock() else {
            return Vec::new();
        };
        let Some(buf) = map.get(deployment_id) else {
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
}
