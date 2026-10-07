#!/usr/bin/env python3
"""Qorpera agent exit (E1): the connection log.

Reads conntrack's events inside the exit's namespace and writes one JSON line per agent connection as it starts and
as it ends (with bytes each way), one line per refused flow from the exit's refused_flows and refused_other sets, and
a "gap" line whenever events were lost (conntrack reports the kernel dropping them under load) or a read failed.
Files are <log-dir>/flows-YYYY-MM-DD.jsonl (UTC). A heartbeat file is touched every few seconds while both readers
are alive and the conntrack reader watches the exit's current namespace, for `verify`; when the namespace was
replaced under it, the logger exits and its unit starts it again in the new one. Then, every minute, it writes an
"alive" line into the log itself: so a stretch of the log with none (the logger down, paused or unable to write)
shows wherever the log is read, on any node, also when nothing in that stretch says so. Never content: only
addresses, ports, protocol, times and byte counts. E3 joins these lines with the client map and the DNS log.

The node's disk comes first. Every 5 seconds the logger reads the logs' size (the log folder's files and the tender's
deletion records in lost/) and the disk's free share; past either line (the logs over their cap, or the disk under its
floor) it pauses: it writes no connection, refusal or alive lines, only a gap line when it pauses and one when it goes
on (with the number of connection and refusal lines it did not write); it empties dns.log every 5 seconds (dnsmasq
goes on answering; a gap line says how much of the DNS record was not kept); and it keeps <pause-file> while it
pauses, so `verify` fails and the node takes no new agent road machines. It goes on once the logs are under 95% of the
cap and the disk 2 points above its floor (qorpera-agent-exit-logs.py `tend` deletes the oldest parts to get there).
A line it cannot write (a full disk, no inodes left, say; an alive line too) is counted, it keeps <failing-file> (so
`verify` fails) until a line can be written again, and the first line then written is a gap line that says how many
it lost.

The line guard's brake (E7, RUNTIME-AGENT-EXIT.md §8) lives here too, off until the founder's levels are set. From the
lines it writes, the logger counts each company's new connections per 10-second step and its failed destinations
(unanswered or refused) per minute, as the counts do (qorpera-agent-exit-logs.py). A company past a level is braked for
the set minutes, and again from each moment it is past one while braked (a new connection the brake dropped counts too,
once however often it was resent): its new connections get a share (the slow level per 10 seconds) and the rest are
dropped, so its machines try again a little later. Open connections are never touched, nor what goes to the exit itself
(names, ping), which counts as in the counts. Every 2 seconds the guard keeps the exit's braked map and share chain equal to that; it
writes a "braked" line when a brake starts and an "unbraked" line when it ends (both also while the logger pauses), and
<brake-status> for `verify` (problems: a level that is not a whole number in range, rules it cannot read or write). A
machine's company is the agent plug's own copy of its entry (<state-dir>/seen), and only for an entry the plug
verified.

  qorpera-agent-exit-log.py --netns qexit --log-dir DIR --heartbeat FILE --pause-file FILE --failing-file FILE
                            [--cap-bytes N] [--floor-percent P] [--state-dir DIR --brake-status FILE
                            [--brake-new-10s N] [--brake-failed-60s F] [--brake-slow-10s S] [--brake-minutes M]]
  qorpera-agent-exit-log.py --parse-conntrack   (stdin: conntrack -E lines; stdout: JSON lines)
  qorpera-agent-exit-log.py --parse-set         (stdin: nft -j list set; stdout: [key, expires] per element)
  qorpera-agent-exit-log.py --diff-sets         (stdin: {previous, current}; stdout: [key, rule] per flow to log)
  qorpera-agent-exit-log.py --should-pause      (stdin: {paused, freePercent, bytes, cap, floor}; stdout: true|false)
  qorpera-agent-exit-log.py --brake-levels      (stdin: {key: text}, the four settings; stdout: [levels, problems])
  qorpera-agent-exit-log.py --parse-brake       (stdin: {map, chain, set}: nft -j answers; stdout: what they hold)
  qorpera-agent-exit-log.py --guard-test --state-dir DIR   (stdin: levels and steps; stdout: what the guard did)
"""

import argparse
import datetime
import ipaddress
import json
import os
import re
import secrets
import stat
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
CAP_BYTES = 2 * 1024 * 1024 * 1024
FLOOR_PERCENT = 10.0
# The tender's deletion records, one file per deleted file (qorpera-agent-exit-logs.py).
RECORDS = "lost"
# How often the logger writes its "alive" line; E3's lookup counts a stretch of 3 minutes without one as a time the log
# may miss connections in.
ALIVE_EVERY = 60.0
# Lines that pass while the logger pauses: its own gap lines, and the brake's (rare, and what a company's owners and
# the founder need to see).
PASS_PAUSE = ("gap", "braked", "unbraked")
TABLE = ("inet", "qorpera_agent_exit")
# The brake: how often the guard keeps the exit's rules equal to what it decided (sooner when a brake starts), how
# often it reads the plug's entries again, and the defaults of the share and the time.
BRAKE_EVERY = 2.0
COMPANIES_EVERY = 10.0
SLOW_10S = 50
BRAKE_MINUTES = 10
# The node's settings (/etc/default/qorpera-agent-exit) that hold the brake's levels.
BRAKE_SETTINGS = {
    "new10s": "QORPERA_AGENT_EXIT_BRAKE_NEW_10S",
    "failed60s": "QORPERA_AGENT_EXIT_BRAKE_FAILED_60S",
    "slow10s": "QORPERA_AGENT_EXIT_BRAKE_SLOW_10S",
    "minutes": "QORPERA_AGENT_EXIT_BRAKE_MINUTES",
}


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


def should_pause(paused, free, size, cap, floor):
    """Pause past either line; go on only with some room again, so the logger does not flap at the line."""
    if paused:
        return free < floor + 2 or size > cap * 0.95
    return free < floor or size > cap


def folder_bytes(path):
    with os.scandir(path) as entries:
        return sum(e.stat(follow_symlinks=False).st_size for e in entries if e.is_file(follow_symlinks=False))


def disk_state(log_dir):
    """The disk's free share (for ordinary users, so root's reserve counts as used) and the logs' size: the log
    folder's files and the tender's deletion records in lost/ (they count toward the cap, though they never go)."""
    st = os.statvfs(log_dir)
    free = st.f_bavail * 100.0 / st.f_blocks if st.f_blocks else 0.0
    size = folder_bytes(log_dir)
    try:
        size += folder_bytes(os.path.join(log_dir, RECORDS))
    except (FileNotFoundError, NotADirectoryError):
        pass
    return free, size


def mark(path, text):
    """Writes the marker file `path` (on /run, which a full log disk does not touch); a failure only goes to stderr."""
    try:
        with open(path + ".tmp", "w", encoding="utf-8") as f:
            f.write(text + "\n")
        os.replace(path + ".tmp", path)
    except OSError as error:
        print(f"cannot write {path}: {error}", file=sys.stderr, flush=True)


def unmark(path):
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass


class Writer:
    def __init__(self, log_dir, failing_file=None):
        self.log_dir = log_dir
        self.failing_file = failing_file
        self.lock = threading.Lock()
        self.paused = False
        self.paused_at = None
        self.held = 0
        self.unwritten = 0
        self.unwritten_since = None
        self.unwritten_error = None

    def append(self, record):
        day = time.strftime("%Y-%m-%d", time.gmtime(record["ts"]))
        line = json.dumps(record, separators=(",", ":"), sort_keys=True)
        path = os.path.join(self.log_dir, f"flows-{day}.jsonl")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o640)
        with os.fdopen(fd, "a", encoding="utf-8") as f:
            f.write(line + "\n")

    def recover(self):
        """Lines that could not be written: the first line that can be says how many, and since when. Under the lock."""
        if self.unwritten:
            self.append({"ts": time.time(), "event": "gap", "since": self.unwritten_since,
                         "reason": f"{self.unwritten} lines could not be written ({self.unwritten_error})"})
            self.unwritten, self.unwritten_since, self.unwritten_error = 0, None, None
            if self.failing_file:
                unmark(self.failing_file)

    def retry(self):
        """Every few seconds: with lines lost to a write failure, try to say so (and so be healthy again) even when no
        new line comes."""
        with self.lock:
            try:
                self.recover()
            except OSError:
                pass

    def write(self, record):
        with self.lock:
            if self.paused and record.get("event") not in PASS_PAUSE:
                # An alive line is not a lost one: none while paused is what marks the pause.
                if record.get("event") != "alive":
                    self.held += 1
                return
            try:
                self.recover()
                self.append(record)
            except OSError as error:
                if not self.unwritten:
                    self.unwritten_since = record.get("ts", time.time())
                self.unwritten += 1
                self.unwritten_error = error.strerror or str(error)
                # The exit is unhealthy until a line can be written again.
                if self.failing_file and self.unwritten == 1:
                    mark(self.failing_file, f"cannot write the connection log: {self.unwritten_error}")

    def pause(self, paused, reason, pause_file):
        """Pauses or goes on, with a gap line either way; the pause file is there exactly while it pauses."""
        with self.lock:
            if paused == self.paused:
                return
            self.paused = paused
            since, held = self.paused_at, self.held
            self.paused_at, self.held = (time.time(), 0) if paused else (None, 0)
        if paused:
            self.gap(f"paused: {reason}")
            mark(pause_file, reason)
        else:
            self.gap(f"resumed: {held} lines not written while paused", since=since)
            unmark(pause_file)

    def empty_dns_log(self):
        """While paused, dnsmasq's record is emptied too (dnsmasq appends, so it writes on from the start)."""
        path = os.path.join(self.log_dir, "dns.log")
        try:
            size = os.lstat(path).st_size
            if size:
                os.truncate(path, 0)
                self.gap(f"paused: {size} bytes of the DNS record not kept")
        except OSError as error:
            print(f"cannot empty {path}: {error}", file=sys.stderr, flush=True)

    def gap(self, reason, since=None):
        record = {"ts": time.time(), "event": "gap", "reason": reason}
        if since is not None:
            record["since"] = since
        self.write(record)


def follow_conntrack(netns, writer, reader, guard):
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
            guard.see(record)
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
        ["ip", "netns", "exec", netns, "nft", "-j", "list", *what], capture_output=True, text=True, check=True,
        timeout=30,
    )
    return result.stdout


def unlogged_count(text):
    for item in json.loads(text).get("nftables", []):
        counter = item.get("counter")
        if counter:
            return int(counter.get("packets", 0))
    return 0


def poll_refused(netns, writer, interval, guard):
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
                guard.see(record)
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


def brake_levels(raw):
    """The brake's levels from the node's settings ({key: text}; empty or missing: the default), and the problems with
    them. N new connections in 10 seconds and F failed destinations in a minute (0: that level is not used; both 0: the
    brake is off), the share S per 10 seconds and the minutes M. Any problem turns the brake off: a level that was not
    meant never brakes a company."""
    bounds = {"new10s": (0, 10**9, 0), "failed60s": (0, 10**9, 0), "slow10s": (1, 10**9, SLOW_10S),
              "minutes": (1, 1440, BRAKE_MINUTES)}
    levels, problems = {}, []
    for key, (low, high, default) in bounds.items():
        text = "" if raw.get(key) is None else str(raw[key]).strip()
        levels[key] = default
        if not text:
            continue
        if re.fullmatch(r"[0-9]{1,10}", text) and low <= int(text) <= high:
            levels[key] = int(text)
        else:
            problems.append(f"{BRAKE_SETTINGS[key]}={text[:40]!r} is not a whole number from {low} to {high}")
    # A share as large as the level would let a braked company go on as fast as it went.
    if not problems and levels["new10s"] and levels["slow10s"] >= levels["new10s"]:
        problems.append(f"{BRAKE_SETTINGS['slow10s']}={levels['slow10s']} is not under "
                        f"{BRAKE_SETTINGS['new10s']}={levels['new10s']}")
    levels["on"] = not problems and bool(levels["new10s"] or levels["failed60s"])
    return levels, problems


def mark_of(value):
    """A mark as nft -j writes it: a number, or its text (decimal or 0x)."""
    return value if isinstance(value, int) else int(str(value), 0)


def braked_map(text):
    """`nft -j list map ... braked`: {address: number}."""
    machines = {}
    for item in json.loads(text).get("nftables", []):
        for elem in item.get("map", {}).get("elem", []) or []:
            if isinstance(elem, list) and len(elem) == 2:
                key = elem[0].get("elem", {}).get("val") if isinstance(elem[0], dict) else elem[0]
                machines[str(key)] = mark_of(elem[1])
    return machines


def mark_counters(text):
    """`nft -j list set` of marks with counters (dropped, resent): {number: packets}."""
    counts = {}
    for item in json.loads(text).get("nftables", []):
        for elem in item.get("set", {}).get("elem", []) or []:
            inner = elem.get("elem") if isinstance(elem, dict) and "elem" in elem else None
            if inner is not None:
                counts[mark_of(inner.get("val"))] = int((inner.get("counter") or {}).get("packets", 0))
    return counts


def rule_comments(text):
    """`nft -j list chain`: each rule's comment, in order (None for a rule without one)."""
    return [item["rule"].get("comment") for item in json.loads(text).get("nftables", []) if "rule" in item]


def share_rule(slow10s):
    """The guard's one rule in the share chain: a braked company's new connections past S per 10 seconds are dropped."""
    family, table = TABLE
    return (f"add rule {family} {table} share update @slowed {{ meta mark limit rate over {slow10s * 6}/minute burst "
            f"{slow10s} packets }} goto braked_drop comment \"slow {slow10s}\"")


class Kernel:
    """The exit's brake rules, read and written in its namespace."""

    def __init__(self, netns):
        self.netns = netns

    def read(self):
        family, table = TABLE
        return {
            "machines": braked_map(nft_json(self.netns, "map", family, table, "braked")),
            "share": rule_comments(nft_json(self.netns, "chain", family, table, "share")),
            "dropped": mark_counters(nft_json(self.netns, "set", family, table, "dropped")),
            "resent": mark_counters(nft_json(self.netns, "set", family, table, "resent")),
        }

    def write(self, statements):
        """One nft batch: all of it or nothing."""
        result = subprocess.run(["ip", "netns", "exec", self.netns, "nft", "-f", "-"], input="\n".join(statements) + "\n",
                                capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip()[:300] or f"nft exited with {result.returncode}")


class Companies:
    """Each machine's company: the agent plug's own copy of its entry (<state-dir>/seen/<address>), only for an entry
    the plug verified (<state-dir>/verified/<address>). All are read again every 10 seconds (a file only when it
    changed); an address not known is looked up at once, then not again for 2 seconds. The plug quarantines an address
    it unplugged for 15 minutes, so a copy a few seconds old never names the next machine's company."""

    def __init__(self, state_dir, clock=time.monotonic):
        self.state_dir = state_dir
        self.clock = clock
        self.files = {}
        self.known = {}
        self.missed = {}
        self.read_at = None

    def entry(self, address):
        seen = os.path.join(self.state_dir, "seen", address)
        try:
            if not os.path.lexists(os.path.join(self.state_dir, "verified", address)):
                return None
            st = os.lstat(seen)
            if not stat.S_ISREG(st.st_mode):
                return None
            key = (st.st_ino, st.st_mtime_ns)
            if address in self.files and self.files[address][0] == key:
                return self.files[address][1]
            with open(seen, encoding="utf-8") as f:
                company = json.load(f).get("company")
        except (OSError, ValueError, AttributeError):
            return None
        company = company if isinstance(company, str) and company else None
        self.files[address] = (key, company)
        return company

    def refresh(self):
        now = self.clock()
        if self.read_at is not None and self.read_at <= now < self.read_at + COMPANIES_EVERY:
            return
        try:
            names = [name for name in os.listdir(os.path.join(self.state_dir, "seen")) if self.agent(name)]
        except OSError:
            names = []
        self.files = {name: self.files[name] for name in names if name in self.files}
        self.known = {name: company for name in names for company in [self.entry(name)] if company}
        self.missed, self.read_at = {}, now

    @staticmethod
    def agent(address):
        try:
            return ipaddress.ip_address(address) in AGENTS
        except ValueError:
            return False

    def of(self, address):
        self.refresh()
        now = self.clock()
        company = self.known.get(address)
        if company is None and isinstance(address, str) and self.agent(address):
            missed = self.missed.get(address)
            if missed is None or not missed <= now < missed + 2.0:
                company = self.entry(address)
                if company:
                    self.known[address] = company
                else:
                    self.missed[address] = now
        return company


class Guard:
    """The line guard's brake (module docstring). see() counts from the readers' threads; step(), every 2 seconds in
    its own thread (at once when a brake starts), keeps the exit's rules equal to the brakes and ends them."""

    def __init__(self, writer, kernel, companies, levels, problems, status_file):
        self.writer = writer
        self.kernel = kernel
        self.companies = companies
        self.levels = levels
        self.setting_problems = problems
        self.status_file = status_file
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.new = {}
        self.failed = {}
        self.braked = {}
        self.counts = None
        self.written = None

    def restore(self, now):
        """Brakes still running when the logger last stopped (its status file): with their numbers, so the rules and
        counts the exit holds for them stay theirs."""
        try:
            with open(self.status_file, encoding="utf-8") as f:
                previous = json.load(f)
            for brake in previous.get("braked", []):
                if brake["until"] > now and isinstance(brake["company"], str):
                    self.braked[brake["company"]] = {
                        "number": int(brake["number"]), "since": float(brake["since"]), "until": float(brake["until"]),
                        "reason": str(brake["reason"]), "dropped": int(brake["dropped"]), "resent": 0}
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            self.braked = {}

    def see(self, record):
        """Counts a line the logger writes (before it writes it; also while it pauses)."""
        if not self.levels["on"]:
            return
        event, ts = record.get("event"), record.get("ts")
        if event == "new":
            failed = None
        elif event in ("destroy", "refused") and not record.get("packets_in"):
            failed = str(record.get("dst"))
        else:
            return
        with self.lock:
            company = self.companies.of(record.get("src"))
            if company is None:
                return
            line = self.count_new(company, ts, 1) if failed is None else self.count_failed(company, ts, failed)
        if line:
            self.writer.write(line)
            self.wake.set()

    def count_new(self, company, ts, n):
        """Under the lock. A braked line when this starts a brake."""
        step = int(ts // 10)
        steps = self.new.setdefault(company, {})
        if steps and step < max(steps) - 1:
            return None
        steps[step] = max(0, steps.get(step, 0) + n)
        for old in [s for s in steps if s < step - 1]:
            del steps[old]
        level = self.levels["new10s"]
        if level and steps[step] > level:
            return self.brake(company, ts, f"{steps[step]} new connections in 10 seconds (level {level})")
        return None

    def count_failed(self, company, ts, dst):
        """Under the lock: distinct failed destinations per minute, each minute's kept up to one past the level."""
        level = self.levels["failed60s"]
        if not level:
            return None
        minute = int(ts // 60)
        minutes = self.failed.setdefault(company, {})
        if minutes and minute < max(minutes) - 1:
            return None
        destinations = minutes.setdefault(minute, set())
        if len(destinations) <= level:
            destinations.add(dst)
        for old in [m for m in minutes if m < minute - 1]:
            del minutes[old]
        if len(destinations) > level:
            return self.brake(company, ts, f"more than {level} failed destinations in a minute")
        return None

    def brake(self, company, now, reason):
        """Under the lock: brakes the company for the set minutes from now, or longer if it is braked already."""
        until = now + self.levels["minutes"] * 60
        if company in self.braked:
            self.braked[company]["until"] = max(self.braked[company]["until"], until)
            return None
        taken = {b["number"] for b in self.braked.values()} | set(self.counts["dropped"] if self.counts else ()) | set(
            self.counts["resent"] if self.counts else ())
        number = secrets.randbelow(0x7FFFFFFF) + 1
        while number in taken:
            number = secrets.randbelow(0x7FFFFFFF) + 1
        self.braked[company] = {"number": number, "since": now, "until": until, "reason": reason, "dropped": 0,
                                "resent": 0}
        return {"ts": now, "event": "braked", "company": company, "reason": reason, "until": until,
                "slow10s": self.levels["slow10s"]}

    def step(self, now=None):
        """Reads the exit's rules and counts, ends the brakes that are over, writes what differs, and the status."""
        now = time.time() if now is None else now
        problems = list(self.setting_problems)
        lines = []
        try:
            kernel = self.kernel.read()
        except Exception as error:  # noqa: BLE001 - a failed read is a problem in the status, never the end
            problems.append(f"cannot read the brake's rules: {str(error)[:300]}")
            kernel = None
        family, table = TABLE
        statements, wanted = [], None
        with self.lock:
            if kernel is not None:
                self.count_dropped(kernel, now, lines)
            for company in sorted(self.braked):
                brake = self.braked[company]
                if not self.levels["on"] or now >= brake["until"]:
                    del self.braked[company]
                    lines.append({"ts": now, "event": "unbraked", "company": company, "since": brake["since"],
                                  "dropped": max(0, brake["dropped"] - brake["resent"])})
            self.companies.refresh()
            wanted = {address: (self.braked[company]["number"], self.braked[company]["until"])
                      for address, company in self.companies.known.items() if company in self.braked}
            if kernel is not None:
                share = [f"slow {self.levels['slow10s']}"] if self.levels["on"] else []
                if kernel["share"] != share:
                    statements += [f"flush chain {family} {table} share", f"flush set {family} {table} slowed"]
                    statements += [share_rule(self.levels["slow10s"])] if share else []
                if kernel["machines"] != {a: n for a, (n, _) in wanted.items()} or self.written != wanted:
                    statements.append(f"flush map {family} {table} braked")
                    if wanted:
                        elements = ", ".join(f"{address} timeout {max(1, int(-(-(until - now) // 1)) + 2)}s : {number}"
                                             for address, (number, until) in sorted(wanted.items()))
                        statements.append(f"add element {family} {table} braked {{ {elements} }}")
            self.prune(now)
            status = self.status_record(now, problems)
        if statements:
            try:
                self.kernel.write(statements)
                self.written = wanted
            except Exception as error:  # noqa: BLE001 - written again next step
                self.written = None
                status["problems"].append(f"cannot write the brake's rules: {str(error)[:300]}")
        for line in lines:
            self.writer.write(line)
        return status

    def count_dropped(self, kernel, now, lines):
        """Under the lock: the new connections the brake dropped since the last read count as new ones of their company
        now, less those let through later on a resend (counted when they started). The first read only sets the base;
        a count that went down (the rules reloaded) is new as a whole."""
        if self.counts is not None:
            by_number = {brake["number"]: company for company, brake in self.braked.items()}
            net = {}
            for name, sign in (("dropped", 1), ("resent", -1)):
                for number, count in kernel[name].items():
                    before = self.counts[name].get(number, 0)
                    delta = count - before if count >= before else count
                    company = by_number.get(number)
                    if delta and company:
                        self.braked[company][name] += delta
                        net[company] = net.get(company, 0) + sign * delta
            for company, n in sorted(net.items()):
                line = self.count_new(company, now, n)
                if line:
                    lines.append(line)
        self.counts = {"dropped": kernel["dropped"], "resent": kernel["resent"]}

    def prune(self, now):
        for counts, width in ((self.new, 10), (self.failed, 60)):
            for company in [c for c, steps in counts.items() if not steps or max(steps) < now // width - 1]:
                del counts[company]

    def status_record(self, now, problems):
        machines = {}
        for address, company in self.companies.known.items():
            if company in self.braked:
                machines[company] = machines.get(company, 0) + 1
        return {
            "schema": "qorpera.agent-exit-brake/v1",
            "at": datetime.datetime.fromtimestamp(now, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "on": self.levels["on"],
            "levels": {key: self.levels[key] for key in ("new10s", "failed60s", "slow10s", "minutes")},
            "braked": [{"company": company, "number": brake["number"], "since": brake["since"], "until": brake["until"],
                        "reason": brake["reason"], "dropped": max(0, brake["dropped"] - brake["resent"]),
                        "machines": machines.get(company, 0)}
                       for company, brake in sorted(self.braked.items())],
            "problems": problems,
        }

    def run(self):
        while True:
            try:
                status = self.step()
                mark(self.status_file, json.dumps(status, sort_keys=True))
            except Exception as error:  # noqa: BLE001 - the guard never ends the logger
                print(f"the brake: {error}", file=sys.stderr, flush=True)
            self.wake.wait(BRAKE_EVERY)
            self.wake.clear()


class Unguarded:
    """No state folder given (a logger run by hand): nothing is counted or braked."""

    def see(self, record):
        pass


class StandInKernel:
    """--guard-test: the exit's brake rules as the guard's own statements leave them (a statement it does not know is
    an error), with the counts a test sets."""

    def __init__(self):
        self.now = 0.0
        self.machines = {}
        self.share = []
        self.counters = {"dropped": {}, "resent": {}}
        self.fail = None

    def read(self):
        if self.fail == "read":
            raise RuntimeError("Error: No such file or directory")
        return {"machines": {a: n for a, (n, ends) in self.machines.items() if ends > self.now},
                "share": list(self.share), "dropped": dict(self.counters["dropped"]),
                "resent": dict(self.counters["resent"])}

    def write(self, statements):
        if self.fail == "write":
            raise RuntimeError("Error: Could not process rule")
        family, table = TABLE
        machines, share = dict(self.machines), list(self.share)
        for statement in statements:
            rule = re.fullmatch(rf'add rule {family} {table} share update @slowed \{{ meta mark limit rate over '
                                rf'(\d+)/minute burst (\d+) packets \}} goto braked_drop comment "slow (\d+)"', statement)
            elements = re.fullmatch(rf"add element {family} {table} braked \{{ (.+) \}}", statement)
            if statement == f"flush chain {family} {table} share":
                share = []
            elif statement == f"flush map {family} {table} braked":
                machines = {}
            elif statement == f"flush set {family} {table} slowed":
                pass
            elif rule and int(rule[1]) == 6 * int(rule[3]) and rule[2] == rule[3]:
                share.append(f"slow {rule[3]}")
            elif elements:
                for element in elements[1].split(", "):
                    parts = re.fullmatch(r"(10\.210\.\d+\.\d+) timeout (\d+)s : (\d+)", element)
                    if not parts:
                        raise RuntimeError(f"not understood: {element}")
                    machines[parts[1]] = (int(parts[3]), self.now + int(parts[2]))
            else:
                raise RuntimeError(f"not understood: {statement}")
        self.machines, self.share = machines, share


def guard_test(state_dir, test):
    """--guard-test: runs the guard on a stand-in kernel. stdin {"levels": {key: text}, "steps": [{"at": T, ...}]}, a
    step one of: "see": [records] (ts defaults to T); "dropped" or "resent": {company: total packets} (the counts the
    exit holds for the company's number); "reload": true (the rules loaded again: all empty); "fail": "read" | "write" |
    null; "restart": true (a new logger, from the status file); "step": true (the guard's step at T: prints what the
    exit holds, the lines written and the status, numbers given as their companies)."""
    clock = {"now": float(test["steps"][0]["at"]) if test["steps"] else 0.0}
    kernel = StandInKernel()
    kernel.now = clock["now"]
    lines = []
    status_file = os.path.join(state_dir, "brake.json")
    levels, problems = brake_levels(test.get("levels", {}))

    class Lines:
        def write(self, record):
            lines.append(record)

    def new_guard():
        guard = Guard(Lines(), kernel, Companies(state_dir, clock=lambda: clock["now"]), levels, problems, status_file)
        guard.restore(clock["now"])
        return guard

    guard = new_guard()
    names = {}
    for step in test["steps"]:
        clock["now"] = kernel.now = float(step["at"])
        names.update({brake["number"]: company for company, brake in guard.braked.items()})
        for record in step.get("see", []):
            guard.see({"ts": step["at"], **record})
        for name in ("dropped", "resent"):
            for company, count in step.get(name, {}).items():
                kernel.counters[name][guard.braked[company]["number"]] = count
        if step.get("reload"):
            kernel.machines, kernel.share, kernel.counters = {}, [], {"dropped": {}, "resent": {}}
        if "fail" in step:
            kernel.fail = step["fail"]
        if step.get("restart"):
            guard = new_guard()
        if step.get("step"):
            status = guard.step(step["at"])
            mark(status_file, json.dumps(status, sort_keys=True))
            names.update({brake["number"]: company for company, brake in guard.braked.items()})
            for brake in status["braked"]:
                brake["number"] = names[brake["number"]]
            held = kernel.read() if kernel.fail != "read" else {"machines": {}, "share": []}
            print(json.dumps({"at": step["at"], "lines": lines[:], "status": status, "share": held["share"],
                              "braked": {a: names.get(n, n) for a, n in sorted(held["machines"].items())},
                              "ends": {a: ends - kernel.now for a, (_, ends) in sorted(kernel.machines.items())}},
                             sort_keys=True))
            lines.clear()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--netns")
    parser.add_argument("--log-dir")
    parser.add_argument("--heartbeat")
    parser.add_argument("--interval", type=float, default=5.0)
    parser.add_argument("--parse-conntrack", action="store_true")
    parser.add_argument("--parse-set", action="store_true")
    parser.add_argument("--diff-sets", action="store_true")
    parser.add_argument("--should-pause", action="store_true")
    parser.add_argument("--pause-file")
    parser.add_argument("--failing-file")
    parser.add_argument("--cap-bytes", type=int, default=CAP_BYTES)
    parser.add_argument("--floor-percent", type=float, default=FLOOR_PERCENT)
    parser.add_argument("--state-dir")
    parser.add_argument("--brake-status")
    for key, setting in BRAKE_SETTINGS.items():
        parser.add_argument("--" + setting.removeprefix("QORPERA_AGENT_EXIT_").lower().replace("_", "-"), dest=key)
    parser.add_argument("--brake-levels", action="store_true")
    parser.add_argument("--parse-brake", action="store_true")
    parser.add_argument("--guard-test", action="store_true")
    args = parser.parse_args()
    if args.brake_levels:
        print(json.dumps(list(brake_levels(json.load(sys.stdin))), sort_keys=True))
        return
    if args.parse_brake:
        answers = json.load(sys.stdin)
        print(json.dumps({"machines": braked_map(json.dumps(answers["map"])),
                          "share": rule_comments(json.dumps(answers["chain"])),
                          "counters": {str(k): v for k, v in mark_counters(json.dumps(answers["set"])).items()}},
                         sort_keys=True))
        return
    if args.guard_test:
        if not args.state_dir:
            parser.error("--guard-test needs --state-dir")
        guard_test(args.state_dir, json.load(sys.stdin))
        return
    if args.should_pause:
        state = json.load(sys.stdin)
        print(json.dumps(should_pause(state["paused"], state["freePercent"], state["bytes"], state["cap"],
                                      state["floor"])))
        return
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
    if not (args.netns and args.log_dir and args.heartbeat and args.pause_file and args.failing_file):
        parser.error("--netns, --log-dir, --heartbeat, --pause-file and --failing-file are required")
    os.makedirs(args.log_dir, mode=0o750, exist_ok=True)
    writer = Writer(args.log_dir, args.failing_file)
    # Markers from an earlier run say nothing about now: the first check and the first line decide afresh.
    unmark(args.pause_file)
    unmark(args.failing_file)

    def check_disk():
        writer.retry()
        try:
            free, size = disk_state(args.log_dir)
        except OSError as error:
            print(f"cannot read the log folder: {error}", file=sys.stderr, flush=True)
            return
        if should_pause(writer.paused, free, size, args.cap_bytes, args.floor_percent):
            writer.pause(True, f"the node's disk has {free:.1f}% free (floor {args.floor_percent:g}%) and the exit's logs "
                               f"hold {size} bytes (cap {args.cap_bytes})", args.pause_file)
            writer.empty_dns_log()
        else:
            writer.pause(False, "", args.pause_file)

    try:
        last_beat = os.stat(args.heartbeat).st_mtime
    except OSError:
        last_beat = None
    # First, before its own pause (if any): so a pause line before "logger started" is always an earlier logger's, which
    # ended with it (E3's lookup reads them so).
    writer.gap("logger started", since=last_beat)
    check_disk()
    guard = Unguarded()
    if args.state_dir and args.brake_status:
        levels, problems = brake_levels({key: getattr(args, key) for key in BRAKE_SETTINGS})
        guard = Guard(writer, Kernel(args.netns), Companies(args.state_dir), levels, problems, args.brake_status)
        guard.restore(time.time())
    reader = {}
    threads = [
        threading.Thread(target=follow_conntrack, args=(args.netns, writer, reader, guard), daemon=True),
        threading.Thread(target=poll_refused, args=(args.netns, writer, args.interval, guard), daemon=True),
    ]
    if isinstance(guard, Guard):
        threads.append(threading.Thread(target=guard.run, daemon=True))
    for thread in threads:
        thread.start()
    # The heartbeat and the alive lines are written only while both readers are alive in the current namespace, so a
    # dead reader shows in `verify` and in the log.
    elsewhere = 0
    last_alive = None
    while True:
        time.sleep(min(5.0, args.interval))
        check_disk()
        if not all(thread.is_alive() for thread in threads):
            sys.exit("the connection logger stopped")
        # Twice in a row, so a reader caught between entering the namespace and starting does not count.
        elsewhere = 0 if "process" not in reader or watches(reader["process"], args.netns) else elsewhere + 1
        if elsewhere >= 2:
            writer.gap("the exit's namespace was replaced; the logger starts again in the new one")
            sys.exit("the conntrack reader watches an old namespace")
        if elsewhere == 0 and (last_alive is None or time.monotonic() - last_alive >= ALIVE_EVERY):
            writer.write({"ts": time.time(), "event": "alive"})
            last_alive = time.monotonic()
        with open(args.heartbeat, "w", encoding="utf-8") as f:
            f.write(f"{time.time():.0f}\n")


if __name__ == "__main__":
    main()
