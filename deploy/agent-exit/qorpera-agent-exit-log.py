#!/usr/bin/env python3
"""Qorpera agent exit (E1): the connection log.

Reads conntrack's events inside the exit's namespace and writes one JSON line per agent connection as it starts and
as it ends (with bytes each way), one line per refused flow from the exit's refused_flows and refused_other sets, and
a "gap" line whenever events were lost (conntrack reports the kernel dropping them under load) or a read failed.
Files are <log-dir>/flows-YYYY-MM-DD.jsonl (UTC). A heartbeat file is touched every few seconds while both readers
are alive, for `verify`. Never content: only addresses, ports, protocol, times and byte counts. E3 joins these lines
with the client map and the DNS log.

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
SETS = ("refused_flows", "refused_other")
# conntrack's own warning when the kernel drops events because the reader is behind.
LOST = ("ENOBUFS", "losing events")


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
        try:
            if key in ("src", "dst") and count == 0:
                record[key] = value
            elif key in ("sport", "dport") and count == 0:
                record[key] = int(value)
            elif key in ("packets", "bytes"):
                record[f"{key}_{'out' if count == 0 else 'in'}"] = int(value)
            elif key == "id":
                record["id"] = int(value)
        except ValueError:
            return None
    try:
        address = ipaddress.ip_address(record.get("src", ""))
    except ValueError:
        return None
    if address not in AGENTS or address == GATEWAY:
        return None
    return record


def parse_set(text):
    """`nft -j list set` output to a list of keys: (src, dst, proto) or (src, dst, proto, dport), proto as text."""
    keys = []
    for item in json.loads(text).get("nftables", []):
        for elem in item.get("set", {}).get("elem", []) or []:
            value = elem.get("elem", {}).get("val", elem) if isinstance(elem, dict) else elem
            concat = value.get("concat") if isinstance(value, dict) else None
            if concat and len(concat) in (3, 4):
                keys.append((str(concat[0]), str(concat[1]), str(concat[2]), *concat[3:]))
    return keys


class Writer:
    def __init__(self, log_dir):
        self.log_dir = log_dir
        self.lock = threading.Lock()

    def write(self, record):
        day = time.strftime("%Y-%m-%d", time.gmtime(record["ts"]))
        line = json.dumps(record, separators=(",", ":"), sort_keys=True)
        path = os.path.join(self.log_dir, f"flows-{day}.jsonl")
        with self.lock:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o640)
            with os.fdopen(fd, "a", encoding="utf-8") as f:
                f.write(line + "\n")

    def gap(self, reason):
        self.write({"ts": time.time(), "event": "gap", "reason": reason})


def follow_conntrack(netns, writer):
    process = subprocess.Popen(
        ["ip", "netns", "exec", netns, "conntrack", "-E", "-e", "NEW,DESTROY", "-o", "timestamp,extended,id",
         "-b", "16777216"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    def watch_errors():
        for line in process.stderr:
            if any(marker in line for marker in LOST):
                writer.gap("conntrack lost events")

    threading.Thread(target=watch_errors, daemon=True).start()
    for line in process.stdout:
        record = parse_conntrack(line)
        if record:
            writer.write(record)
    writer.gap(f"conntrack stopped with {process.wait()}")


def poll_refused(netns, writer, interval):
    seen = set()
    failing = False
    while True:
        try:
            current = set()
            for name in SETS:
                result = subprocess.run(
                    ["ip", "netns", "exec", netns, "nft", "-j", "list", "set", "inet", "qorpera_agent_exit", name],
                    capture_output=True,
                    text=True,
                    check=True,
                )
                current.update(parse_set(result.stdout))
            for key in sorted(current - seen, key=lambda k: tuple(str(part) for part in k)):
                record = {"ts": time.time(), "event": "refused", "src": key[0], "dst": key[1], "proto": key[2]}
                if len(key) == 4:
                    record["dport"] = key[3]
                writer.write(record)
            # A flow that expired from the set and comes back is logged again.
            seen = current
            failing = False
        except Exception as error:  # noqa: BLE001 - a failed read is a gap, never the end of the logger
            if not failing:
                writer.gap(f"cannot read the refused flows: {error}")
                print(f"cannot read the refused flows: {error}", file=sys.stderr, flush=True)
            failing = True
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
    os.makedirs(args.log_dir, mode=0o750, exist_ok=True)
    writer = Writer(args.log_dir)
    writer.gap("logger started")
    threads = [
        threading.Thread(target=follow_conntrack, args=(args.netns, writer), daemon=True),
        threading.Thread(target=poll_refused, args=(args.netns, writer, args.interval), daemon=True),
    ]
    for thread in threads:
        thread.start()
    # The heartbeat is written only while both readers are alive, so a dead reader shows in `verify`.
    while True:
        time.sleep(min(5.0, args.interval))
        if not all(thread.is_alive() for thread in threads):
            sys.exit("the connection logger stopped")
        with open(args.heartbeat, "w", encoding="utf-8") as f:
            f.write(f"{time.time():.0f}\n")


if __name__ == "__main__":
    main()
