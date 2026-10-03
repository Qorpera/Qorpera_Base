#!/usr/bin/env python3
"""Qorpera agent exit (E1): the connection log.

Reads conntrack's events inside the exit's namespace and writes one JSON line per agent connection as it starts and
as it ends (with bytes each way), and one line per refused flow from the exit's refused_flows set. Files are
<log-dir>/flows-YYYY-MM-DD.jsonl (UTC). A heartbeat file is touched every 10 seconds for `verify`. Never content:
only addresses, ports, protocol, times and byte counts. E3 joins these lines with the client map and the DNS log.

  qorpera-agent-exit-log.py --netns qexit --log-dir DIR --heartbeat FILE
  qorpera-agent-exit-log.py --parse-conntrack   (stdin: conntrack -E lines; stdout: JSON lines)
  qorpera-agent-exit-log.py --parse-set         (stdin: nft -j list set; stdout: one JSON key per element)
"""

import argparse
import ipaddress
import json
import os
import subprocess
import sys
import threading
import time

AGENTS = ipaddress.ip_network("10.210.0.0/16")
# The exit's own address on the agents' bridge: its DHCP replies are not agent connections.
GATEWAY = ipaddress.ip_address("10.210.0.1")
SET = ["inet", "qorpera_agent_exit", "refused_flows"]


def parse_conntrack(line):
    """One `conntrack -E -o timestamp,extended,id` line to a record, or None when it is not an agent connection."""
    tokens = line.split()
    if len(tokens) < 4 or not tokens[0].startswith("["):
        return None
    try:
        ts = float(tokens[0].strip("[]"))
    except ValueError:
        return None
    event = next((t.strip("[]").lower() for t in tokens[1:3] if t.strip("[]") in ("NEW", "DESTROY", "UPDATE")), None)
    if event not in ("new", "destroy"):
        return None
    proto = None
    for i, t in enumerate(tokens):
        if t == "ipv4" and i + 2 < len(tokens):
            proto = tokens[i + 2]
            break
    if proto is None:
        return None
    seen = {}
    record = {"ts": ts, "event": event, "proto": proto}
    for t in tokens:
        if "=" not in t:
            continue
        key, value = t.split("=", 1)
        count = seen.get(key, 0)
        seen[key] = count + 1
        if key in ("src", "dst", "sport", "dport") and count == 0:
            record[key] = int(value) if key in ("sport", "dport") else value
        elif key in ("packets", "bytes"):
            record[f"{key}_{'out' if count == 0 else 'in'}"] = int(value)
        elif key == "id":
            record["id"] = int(value)
    src = record.get("src")
    if src is None:
        return None
    try:
        address = ipaddress.ip_address(src)
        if address not in AGENTS or address == GATEWAY:
            return None
    except ValueError:
        return None
    return record


def parse_set(text):
    """`nft -j list set` output to a list of (src, dst, proto, dport) keys."""
    keys = []
    for item in json.loads(text).get("nftables", []):
        for elem in item.get("set", {}).get("elem", []) or []:
            value = elem.get("elem", {}).get("val", elem) if isinstance(elem, dict) else elem
            concat = value.get("concat") if isinstance(value, dict) else None
            if concat and len(concat) == 4:
                keys.append(tuple(concat))
    return keys


class Writer:
    def __init__(self, log_dir):
        self.log_dir = log_dir
        self.lock = threading.Lock()

    def write(self, record):
        day = time.strftime("%Y-%m-%d", time.gmtime(record["ts"]))
        line = json.dumps(record, separators=(",", ":"), sort_keys=True)
        with self.lock, open(os.path.join(self.log_dir, f"flows-{day}.jsonl"), "a", encoding="utf-8") as f:
            f.write(line + "\n")


def follow_conntrack(netns, writer):
    process = subprocess.Popen(
        ["ip", "netns", "exec", netns, "conntrack", "-E", "-e", "NEW,DESTROY", "-o", "timestamp,extended,id"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        bufsize=1,
    )
    for line in process.stdout:
        record = parse_conntrack(line)
        if record:
            writer.write(record)
    sys.exit(f"conntrack stopped with {process.wait()}")


def poll_refused(netns, writer, interval):
    seen = set()
    while True:
        result = subprocess.run(
            ["ip", "netns", "exec", netns, "nft", "-j", "list", "set", *SET], capture_output=True, text=True
        )
        if result.returncode != 0:
            sys.exit(f"cannot read the refused flows: {result.stderr.strip()}")
        current = set(parse_set(result.stdout))
        for src, dst, proto, dport in sorted(current - seen):
            writer.write({"ts": time.time(), "event": "refused", "src": src, "dst": dst, "proto": proto, "dport": dport})
        # A flow that expired from the set and comes back is logged again.
        seen = current
        time.sleep(interval)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--netns")
    parser.add_argument("--log-dir")
    parser.add_argument("--heartbeat")
    parser.add_argument("--interval", type=float, default=5.0)
    parser.add_argument("--parse-conntrack", action="store_true")
    parser.add_argument("--parse-set", action="store_true")
    args = parser.parse_args()
    if args.parse_conntrack:
        for line in sys.stdin:
            record = parse_conntrack(line)
            if record:
                print(json.dumps(record, separators=(",", ":"), sort_keys=True))
        return
    if args.parse_set:
        for key in parse_set(sys.stdin.read()):
            print(json.dumps(list(key)))
        return
    if not (args.netns and args.log_dir and args.heartbeat):
        parser.error("--netns, --log-dir and --heartbeat are required")
    os.makedirs(args.log_dir, exist_ok=True)
    writer = Writer(args.log_dir)
    # A thread that dies takes the process with it (sys.exit in a thread only ends the thread), so watch them.
    threads = [
        threading.Thread(target=follow_conntrack, args=(args.netns, writer), daemon=True),
        threading.Thread(target=poll_refused, args=(args.netns, writer, args.interval), daemon=True),
    ]
    for thread in threads:
        thread.start()
    while all(thread.is_alive() for thread in threads):
        with open(args.heartbeat, "w", encoding="utf-8") as f:
            f.write(f"{time.time():.0f}\n")
        time.sleep(min(10.0, args.interval))
    sys.exit("the connection logger stopped")


if __name__ == "__main__":
    main()
