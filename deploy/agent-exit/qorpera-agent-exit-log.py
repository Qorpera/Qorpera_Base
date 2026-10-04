#!/usr/bin/env python3
"""Qorpera agent exit (E1): the connection log.

Reads conntrack's events inside the exit's namespace and writes one JSON line per agent connection as it starts and
as it ends (with bytes each way), one line per refused flow from the exit's refused_flows and refused_other sets, and
a "gap" line whenever events were lost (conntrack reports the kernel dropping them under load) or a read failed.
Files are <log-dir>/flows-YYYY-MM-DD.jsonl (UTC). A heartbeat file is touched every few seconds while both readers
are alive and the conntrack reader watches the exit's current namespace, for `verify`; when the namespace was
replaced under it, the logger exits and its unit starts it again in the new one. Never content: only addresses,
ports, protocol, times and byte counts. E3 joins these lines with the client map and the DNS log.

  qorpera-agent-exit-log.py --netns qexit --log-dir DIR --heartbeat FILE
  qorpera-agent-exit-log.py --parse-conntrack   (stdin: conntrack -E lines; stdout: JSON lines)
  qorpera-agent-exit-log.py --parse-set         (stdin: nft -j list set; stdout: [key, expires] per element)
  qorpera-agent-exit-log.py --diff-sets         (stdin: {previous, current}; stdout: [key, rule] per flow to log)
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
INTERNAL = [
    ipaddress.ip_network(n)
    for n in (
        "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
        "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/4", "240.0.0.0/4", "93.164.62.162/32",
    )
]
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
    """`nft -j list set` output to {key: expires}: key (src, dst, proto) or (src, dst, proto, dport), proto as text;
    expires in seconds, or None when the element has no timeout."""
    keys = {}
    for item in json.loads(text).get("nftables", []):
        for elem in item.get("set", {}).get("elem", []) or []:
            inner = elem.get("elem") if isinstance(elem, dict) and "elem" in elem else None
            value = inner.get("val") if inner else elem
            concat = value.get("concat") if isinstance(value, dict) else None
            if concat and len(concat) in (3, 4):
                keys[(str(concat[0]), str(concat[1]), str(concat[2]), *concat[3:])] = inner.get("expires") if inner else None
    return keys


def new_refusals(previous, current):
    """Keys to log: new since the last poll, or added again (an element's expiry only ever counts down, so a larger
    one means it expired and was added back between two polls)."""
    fresh = []
    for key, expires in current.items():
        if key not in previous:
            fresh.append(key)
        elif expires is not None and (previous[key] is None or expires > previous[key]):
            fresh.append(key)
    return sorted(fresh, key=lambda k: tuple(str(part) for part in k))


def rule_for(key):
    """Which of the exit's refusals a refused flow came from."""
    dst, proto = key[1], key[2]
    try:
        if any(ipaddress.ip_address(dst) in network for network in INTERNAL):
            return "our_networks"
    except ValueError:
        return "unknown"
    if proto == "tcp" and len(key) == 4 and str(key[3]) == "25":
        return "mail"
    return "open_limit"


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

    def gap(self, reason, since=None):
        record = {"ts": time.time(), "event": "gap", "reason": reason}
        if since is not None:
            record["since"] = since
        self.write(record)


def follow_conntrack(netns, writer, reader):
    process = subprocess.Popen(
        ["ip", "netns", "exec", netns, "conntrack", "-E", "-e", "NEW,DESTROY", "-o", "timestamp,extended,id",
         "-b", "16777216"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    reader["process"] = process

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


def watches(process, netns):
    """True when the reader runs in the exit's current namespace (ip netns exec enters it, then becomes conntrack)."""
    try:
        return os.stat(f"/proc/{process.pid}/ns/net").st_ino == os.stat(f"/run/netns/{netns}").st_ino
    except OSError:
        return process.poll() is not None


def nft_json(netns, *what):
    result = subprocess.run(
        ["ip", "netns", "exec", netns, "nft", "-j", "list", *what], capture_output=True, text=True, check=True
    )
    return result.stdout


def unlogged_count(text):
    for item in json.loads(text).get("nftables", []):
        counter = item.get("counter")
        if counter:
            return int(counter.get("packets", 0))
    return 0


def poll_refused(netns, writer, interval):
    seen = {}
    unlogged = None
    failing = False
    while True:
        try:
            current = {}
            for name in SETS:
                current.update(parse_set(nft_json(netns, "set", "inet", "qorpera_agent_exit", name)))
            for key in new_refusals(seen, current):
                record = {"ts": time.time(), "event": "refused", "src": key[0], "dst": key[1], "proto": key[2],
                          "rule": rule_for(key)}
                if len(key) == 4:
                    record["dport"] = key[3]
                writer.write(record)
            seen = current
            # Refusals the exit could not add to its sets (a machine's share spent, or a set full) are a gap.
            count = unlogged_count(nft_json(netns, "counter", "inet", "qorpera_agent_exit", "refused_unlogged"))
            # A rules reload starts the counter again from zero; then everything it holds is new.
            new = count - unlogged if unlogged is not None and count >= unlogged else count if unlogged is not None else 0
            if new > 0:
                writer.gap(f"{new} refused packets of unlogged flows")
            unlogged = count
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
    parser.add_argument("--diff-sets", action="store_true")
    args = parser.parse_args()
    if args.parse_conntrack:
        for line in sys.stdin:
            record = parse_conntrack(line)
            if record:
                print(json.dumps(record, separators=(",", ":"), sort_keys=True))
        return
    if args.parse_set:
        for key, expires in parse_set(sys.stdin.read()).items():
            print(json.dumps([list(key), expires]))
        return
    if args.diff_sets:
        # Test mode: stdin {"previous": [[key, expires], ...], "current": [...]}; prints each key to log, with its rule.
        both = json.load(sys.stdin)
        previous = {tuple(k): e for k, e in both["previous"]}
        current = {tuple(k): e for k, e in both["current"]}
        for key in new_refusals(previous, current):
            print(json.dumps([list(key), rule_for(key)]))
        return
    if not (args.netns and args.log_dir and args.heartbeat):
        parser.error("--netns, --log-dir and --heartbeat are required")
    os.makedirs(args.log_dir, mode=0o750, exist_ok=True)
    writer = Writer(args.log_dir)
    try:
        last_beat = os.stat(args.heartbeat).st_mtime
    except OSError:
        last_beat = None
    writer.gap("logger started", since=last_beat)
    reader = {}
    threads = [
        threading.Thread(target=follow_conntrack, args=(args.netns, writer, reader), daemon=True),
        threading.Thread(target=poll_refused, args=(args.netns, writer, args.interval), daemon=True),
    ]
    for thread in threads:
        thread.start()
    # The heartbeat is written only while both readers are alive, so a dead reader shows in `verify`.
    elsewhere = 0
    while True:
        time.sleep(min(5.0, args.interval))
        if not all(thread.is_alive() for thread in threads):
            sys.exit("the connection logger stopped")
        # Twice in a row, so a reader caught between entering the namespace and starting does not count.
        elsewhere = 0 if "process" not in reader or watches(reader["process"], args.netns) else elsewhere + 1
        if elsewhere >= 2:
            writer.gap("the exit's namespace was replaced; the logger starts again in the new one")
            sys.exit("the conntrack reader watches an old namespace")
        with open(args.heartbeat, "w", encoding="utf-8") as f:
            f.write(f"{time.time():.0f}\n")


if __name__ == "__main__":
    main()
