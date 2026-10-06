#!/usr/bin/env python3
"""Qorpera agent exit: the logs (E3: on the node, on the NAS, and who used an address) and the line guard's counts
(E7; the brake itself is in the logger).

The exit writes its logs on the node's own disk, in <log-dir> (/var/log/qorpera-agent-exit): the connection log
flows-YYYY-MM-DD.jsonl (the logger), the client history clients-YYYY-MM-DD.jsonl (the agent plug) and dns.log (dnsmasq).
`tend` runs every 5 minutes (qorpera-agent-exit-logs.timer, root) and keeps them small and safe for the node:
- it seals each open file into a compressed part (<kind>-YYYY-MM-DD.pNNN.jsonl.gz) once its day is closed, or sooner
  once it holds 64 MiB. A day is closed two hours after it ends (UTC): the plug's "plugged" lines carry the entry's
  time, normally less than an hour back. The writers open the file for each line, so a renamed file takes no new
  lines. The open file is first renamed to <kind>-YYYY-MM-DD.pNNN.sealing, so a pass cut short finishes the same part
  and never seals a line twice;
- it copies dns.log into dns-YYYY-MM-DDTHHMMSSZ.log (then compressed) and truncates it once a day, or sooner once it
  holds 64 MiB. The copy stops at what was there plus one part, however fast dnsmasq writes; dnsmasq appends, so it
  writes on from the start, and what it wrote between the copy's end and the truncate is lost;
- it counts each closed day once, per company, from that day's parts (counts-YYYY-MM-DD.json): the line guard's
  numbers (RUNTIME-AGENT-EXIT.md §8: new connections, refusals, bursts and failed connections to many addresses),
  which the founder reads (`report`) to set the brake's levels, and how often the brake held each company and how many
  new connections it dropped (its "braked" and "unbraked" lines). Counting never slows or refuses anything. A day is
  counted once all its files are sealed, and its counts never change after. A part that turns up for a day already
  counted (the plug's reconciler was down for a while, say) is counted with the next day the tender counts, under its
  own day ("late"); it never changes the day it belongs to;
- it keeps 90 days, and deletes the oldest parts while the logs hold more than 80% of their cap (2 GiB unless set) or
  the disk has less than its floor (10% unless set) plus 5 points free: the DNS record's and the connection log's
  first, the client history's last. One rule for the connection log and the client history, at 90 days and under
  pressure alike: a part goes only once a counts file names it. The open files and the counts never go under
  pressure; at 90 days a counts file goes after every part it names, and the newest one (the checkpoint) never. Each
  deleted file has its own record, lost/<name>.json, written whole (temporary file, synced, renamed) before the file
  goes, and lost/ and the log folder are synced before every deletion: a record exists complete or not at all, and the
  next pass first finishes every recorded deletion whose file is still there, whatever the pressure is then (a lookup
  knows that day is unknown). The records count toward the cap, though they never go.
<run-dir>/logs.json says when it last ran and what it could not do; `qorpera-agent-exit.sh verify` fails while it is
older than 15 minutes or names a problem (the logs still over their cap, or the disk under its floor, with every
part it may delete gone; a part it cannot seal; a closed day it cannot count). The logger pauses by itself at the
same two lines (qorpera-agent-exit-log.py) and keeps dns.log empty meanwhile, and the exit is unhealthy while it does,
so the node takes no new agent road machines and its disk never fills.

`ship` runs every 5 minutes too (qorpera-agent-exit-ship.timer, root) and copies every sealed part, DNS part, counts
file and deletion record to the NAS: <nas-dir>/<host>/<day>/<name> (a deletion record in <day>/lost/), written beside
it, synced, renamed, then read back from the NAS and compared (sha256). Only then does shipped/<name>.json on the node
say it went; the tender removes a shipped part from the node once it is a week old, or sooner under pressure (shipped
parts first), with no deletion record: the NAS holds it. A file of that name already on the NAS with other content is
never overwritten. <nas-dir> must hold the marker file .qorpera-agent-exit-logs (so an empty mount point is never
written to). A pass opens <nas-dir> once, after it finds the marker there, and does every step on the NAS through that
open folder and the folders it opens in it: an unmount meanwhile fails (the share is busy), and a lazy one leaves the
pass writing to the NAS, never into the empty mount point. Each pass writes <nas-dir>/<host>/status.json: the time it
covers ("through") and the days whose lines are not all on the NAS yet (the open files, dns.log, what waits). The NAS
keeps 90 days too: each node removes its own day folders past them. <run-dir>/ship.json says when it last ran and what
waits; `verify` fails while it is older than 30 minutes, while no NAS folder is set, or while a file has waited more
than 24 hours.

`lookup` answers "who used this address at this time": every connection from the agents to an address (or from an
agent address) open around a time, on this node and on every node with a folder on the NAS, with the company, the
machine and the name the machine looked up. Whatever the logs cannot say (a gap, a deleted file, a file not on the NAS
yet, a node that has not shipped, a logger paused, failing or not running now, a silence in the connection log) is
listed as not known: never as "no one". The logger writes an "alive" line every minute while it logs (none while it
pauses or cannot write), so a stretch of the connection log with none says the log may miss connections there,
whatever the cause, also one that began before the days read or ends after them.

An address belongs to a company from its "plugged" line to its "unplugged" one. Each counts file keeps who was
plugged in when its day ended, so the newest one is the checkpoint the next day starts from (attribution.json is a
copy). Traffic from an address with no company at that moment counts as "unattributed", also when a late plug for it
turns up afterwards.

  qorpera-agent-exit-logs.py tend --log-dir DIR --status FILE [--cap-bytes N] [--floor-percent P] [--now T]
  qorpera-agent-exit-logs.py count --log-dir DIR --day YYYY-MM-DD   (a day's counts from what is there; writes nothing)
  qorpera-agent-exit-logs.py report --log-dir DIR [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--json]
  qorpera-agent-exit-logs.py ship --log-dir DIR --nas-dir DIR --status FILE [--host NAME] [--now T]
  qorpera-agent-exit-logs.py lookup --log-dir DIR [--nas-dir DIR] --at TIME (--remote ADDR [--remote-port N] |
      --agent ADDR) [--window SECONDS] [--days N] [--heartbeat FILE] [--pause-file FILE] [--failing-file FILE]
      [--host NAME] [--json]
"""

import argparse
import bisect
import contextlib
import datetime
import fcntl
import gzip
import hashlib
import json
import os
import re
import shutil
import socket
import stat
import sys
import time

DAY = 86400
# A day is closed two hours after it ends: the plug's "plugged" line carries its entry's time, normally less than an
# hour back.
GRACE = 2 * 3600
PART_BYTES = 64 * 1024 * 1024
KEEP_DAYS = 90
CAP_BYTES = 2 * 1024 * 1024 * 1024
FLOOR_PERCENT = 10.0
# The tender starts deleting before the logger has to pause: at 80% of the cap, or with less than the floor plus 5
# points of the disk free.
CAP_SHARE = 0.8
LOW_WATER_MARGIN = 5.0
# How long the renamed files wait for a line already being written (the writers open the file for each line).
SETTLE_SECONDS = 2.0
# Distinct destinations are kept up to this many per company and day; past it the count says "at least".
DESTINATIONS_KEPT = 100_000

OPEN = re.compile(r"^(flows|clients)-(\d{4}-\d{2}-\d{2})\.jsonl$")
SEALING = re.compile(r"^(flows|clients)-(\d{4}-\d{2}-\d{2})\.p(\d{3,})\.sealing$")
PART = re.compile(r"^(flows|clients)-(\d{4}-\d{2}-\d{2})\.p(\d{3,})\.jsonl\.gz$")
DNS_PART = re.compile(r"^dns-(\d{4}-\d{2}-\d{2})T\d{6}Z\.log\.gz$")
DNS_COPY = re.compile(r"^dns-(\d{4}-\d{2}-\d{2})T\d{6}Z\.log$")
COUNTS = re.compile(r"^counts-(\d{4}-\d{2}-\d{2})\.json$")
TEMPORARY = re.compile(r"^\..+\.tmp$")
DAY_NAME = re.compile(r"^\d{4}-\d{2}-\d{2}$")
HOST_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$")

# The NAS (E3): the NAS folder is a mount point, and an empty file of this name in it says the NAS is mounted there.
# The bare folder under the mount has none, and with one left in it by mistake it is still no mount point, so nothing
# is ever written into the node's own disk by mistake.
NAS_MARKER = ".qorpera-agent-exit-logs"
# shipped/<name>.json (shipped/lost/<name>.json for a deletion record): what went to the NAS, with its sha256.
SHIPPED = "shipped"
# A part on the NAS stays this long on the node too, then goes without a deletion record: the NAS holds it.
LOCAL_DAYS = 7
# A file still not on the NAS this long after it was written makes `verify` fail.
WAIT_LIMIT = DAY
# A long pass writes its status again this often, so `verify` sees it alive.
STATUS_EVERY = 60
NO_NAS = "no NAS folder is set (QORPERA_AGENT_EXIT_NAS_DIR in /etc/default/qorpera-agent-exit)"
# The logger's "alive" lines come every minute while it logs: a longer stretch without one is a time the connection log
# may miss connections.
SILENCE = 180


def day_of(ts):
    return time.strftime("%Y-%m-%d", time.gmtime(ts))


def day_start(day):
    return datetime.datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=datetime.UTC).timestamp()


def next_day(day, step=1):
    return day_of(day_start(day) + step * DAY)


def iso(ts):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


def write_atomic(path, data, mode=0o640, dir_fd=None):
    """With dir_fd, path is a name in that open folder."""
    tmp = os.path.join(os.path.dirname(path), f".{os.path.basename(path)}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC, mode, dir_fd=dir_fd)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
        os.fchmod(f.fileno(), mode)
    os.replace(tmp, path, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)


def write_json(path, value, mode=0o640, dir_fd=None):
    write_atomic(path, (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode(), mode, dir_fd)


def regular_files(log_dir):
    """Name to size of the regular files directly in the log folder; links and folders are never followed."""
    files = {}
    with os.scandir(log_dir) as entries:
        for entry in entries:
            if entry.is_file(follow_symlinks=False):
                files[entry.name] = entry.stat(follow_symlinks=False).st_size
    return files


def free_percent(log_dir):
    st = os.statvfs(log_dir)
    return st.f_bavail * 100.0 / st.f_blocks if st.f_blocks else 0.0


def compress(source, final):
    """`source` into the gzip file `final`: written beside it, synced, then renamed into place."""
    tmp = os.path.join(os.path.dirname(final), f".{os.path.basename(final)}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC, 0o640)
    with os.fdopen(fd, "wb") as raw:
        with open(source, "rb") as src, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as gz:
            shutil.copyfileobj(src, gz, 1024 * 1024)
        raw.flush()
        os.fsync(raw.fileno())
    os.chmod(tmp, 0o640)
    os.replace(tmp, final)


def next_part(files, kind, day, used=()):
    """The next part number for a day: past every part there is, and every one a counts file or a deletion record names
    (a name is never used twice, so a part deleted after it was counted is never mistaken for a new one)."""
    numbers = [int(m.group(3)) for name in [*files, *used] if (m := PART.match(name) or SEALING.match(name))
               and m.group(1) == kind and m.group(2) == day]
    return max(numbers, default=0) + 1


LOST = "lost"
LOST_RECORD = re.compile(r"^(?!\.)(.+)\.json$")


def lost_records(log_dir):
    """File name to its deletion record (lost/<name>.json): every file deleted, with when, why and its size."""
    return records_in(os.path.join(log_dir, LOST))


def shipped_records(log_dir, sub=""):
    """File name to its shipped record (shipped/<name>.json; shipped/lost/<name>.json for a deletion record)."""
    return records_in(os.path.join(log_dir, SHIPPED, sub))


def records_in(folder):
    """File name to its record (<folder>/<name>.json); a record that cannot be read is {}."""
    records = {}
    try:
        entries = list(os.scandir(folder))
    except (FileNotFoundError, NotADirectoryError):
        return records
    for entry in entries:
        m = LOST_RECORD.match(entry.name)
        if not m or not entry.is_file(follow_symlinks=False):
            continue
        try:
            with open(entry.path, encoding="utf-8") as f:
                value = json.load(f)
        except (OSError, ValueError):
            value = {}
        records[m.group(1)] = value if isinstance(value, dict) else {}
    return records


def lost_names(log_dir):
    """Every file a deletion record names."""
    return set(lost_records(log_dir))


def record_bytes(log_dir):
    """The deletion records' size: they count toward the cap like the logs, though they never go."""
    try:
        return sum(regular_files(os.path.join(log_dir, LOST)).values())
    except (FileNotFoundError, NotADirectoryError):
        return 0


def kept_bytes(log_dir):
    """What the logs hold against their cap: the log folder's files and the deletion records."""
    return sum(regular_files(log_dir).values()) + record_bytes(log_dir)


def sync_folder(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def records_on_disk(log_dir):
    """Every file goes only after this: lost/ is synced (each record's name in it, also one a pass cut short wrote) and
    the log folder (lost/'s own name, also when a pass was cut short right after making it). A failed sync raises, so
    nothing goes."""
    sync_folder(os.path.join(log_dir, LOST))
    sync_folder(log_dir)


def seal_files(log_dir, now, part_bytes, settle=SETTLE_SECONDS):
    """Seals each open file whose day is closed or which holds `part_bytes`. It is renamed to its part's .sealing name
    first; a .sealing file whose part is already there (a pass cut short after publishing it) is only removed."""
    files = regular_files(log_dir)
    used = None
    renamed = False
    for name, size in sorted(files.items()):
        m = OPEN.match(name)
        if not m or not (now >= day_start(m.group(2)) + DAY + GRACE or size >= part_bytes):
            continue
        used = counted_parts(log_dir, files) | lost_names(log_dir) | set(shipped_records(log_dir)) \
            if used is None else used
        target = f"{m.group(1)}-{m.group(2)}.p{next_part(files, m.group(1), m.group(2), used):03d}.sealing"
        os.rename(os.path.join(log_dir, name), os.path.join(log_dir, target))
        files[target] = files.pop(name)
        renamed = True
    if renamed:
        time.sleep(settle)
    sealed = 0
    for name in sorted(files):
        m = SEALING.match(name)
        if not m:
            continue
        final = f"{m.group(1)}-{m.group(2)}.p{m.group(3)}.jsonl.gz"
        if final not in files:
            compress(os.path.join(log_dir, name), os.path.join(log_dir, final))
            sealed += 1
        os.unlink(os.path.join(log_dir, name))
    return sealed


def compress_dns_copies(log_dir):
    """A copy of dns.log not yet compressed (the pass that made it was cut short) is compressed now."""
    for name in sorted(regular_files(log_dir)):
        if DNS_COPY.match(name):
            compress(os.path.join(log_dir, name), os.path.join(log_dir, f"{name}.gz"))
            os.unlink(os.path.join(log_dir, name))


def rotate_dns(log_dir, now, part_bytes):
    """Copies dns.log and truncates it, once a day or once it holds `part_bytes`. The copy stops at what was there plus
    one part, however fast dnsmasq writes, so the pass always ends."""
    path = os.path.join(log_dir, "dns.log")
    marker = os.path.join(log_dir, ".dns-rotated")
    compress_dns_copies(log_dir)
    try:
        size = os.lstat(path).st_size
    except FileNotFoundError:
        return False
    try:
        with open(marker, encoding="utf-8") as f:
            rotated = f.read().strip()
    except FileNotFoundError:
        # The first pass only notes the day; the file is rotated when the day changes (or it grows past a part).
        write_atomic(marker, f"{day_of(now)}\n".encode())
        rotated = day_of(now)
    if size == 0 or (rotated == day_of(now) and size < part_bytes):
        return False
    copy = os.path.join(log_dir, f"dns-{time.strftime('%Y-%m-%dT%H%M%SZ', time.gmtime(now))}.log")
    if os.path.lexists(f"{copy}.gz"):
        # A copy from this very second is there already; the next pass cuts it.
        return False
    left = size + part_bytes
    fd = os.open(copy, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o640)
    with open(path, "rb") as src, os.fdopen(fd, "wb") as dst:
        while left > 0 and (chunk := src.read(min(left, 1024 * 1024))):
            dst.write(chunk)
            left -= len(chunk)
        dst.flush()
        os.fsync(dst.fileno())
    os.truncate(path, 0)
    write_atomic(marker, f"{day_of(now)}\n".encode())
    compress_dns_copies(log_dir)
    return True


def read_lines(paths):
    """JSON records from these files (plain or gzip), in order; an unreadable line is counted, never fatal."""
    bad = 0
    for path in paths:
        opener = gzip.open if path.endswith(".gz") else open
        try:
            with opener(path, "rt", encoding="utf-8", errors="replace") as f:
                for line in f:
                    try:
                        record = json.loads(line)
                    except ValueError:
                        bad += 1
                        continue
                    if isinstance(record, dict) and isinstance(record.get("ts"), (int, float)):
                        yield record
                    else:
                        bad += 1
        except (OSError, EOFError):
            bad += 1
    if bad:
        yield {"ts": None, "event": "unreadable", "count": bad}


def day_files(log_dir, kind, day, files=None):
    """A day's parts in order (a part being sealed as its plain file, once), then its open file."""
    files = regular_files(log_dir) if files is None else files
    return [os.path.join(log_dir, name) for name in day_names(files, kind, day)]


def day_names(files, kind, day):
    parts = {}
    for name in files:
        m = PART.match(name) or SEALING.match(name)
        if m and m.group(1) == kind and m.group(2) == day and (PART.match(name) or int(m.group(3)) not in parts):
            parts[int(m.group(3))] = name
    names = [parts[number] for number in sorted(parts)]
    if f"{kind}-{day}.jsonl" in files:
        names.append(f"{kind}-{day}.jsonl")
    return names


WHO = ("company", "machine", "kind", "member")


def attribution_intervals(start, events):
    """Address to [(from, to, who)] for one day: `start` (address to who, still plugged in when the day began) and
    the day's plugged and unplugged lines. Returns the intervals and who is still plugged in at the end."""
    open_now = {address: dict(who) for address, who in start.items()}
    intervals = {}
    for event in sorted((e for e in events if e.get("event") in ("plugged", "unplugged")), key=lambda e: e["ts"]):
        address = event.get("address")
        if not isinstance(address, str):
            continue
        if address in open_now:
            # A late line older than what is known of the address now (a later plug) changes nothing.
            since = open_now[address].get("since")
            if isinstance(since, (int, float)) and event["ts"] < since:
                continue
            began = open_now.pop(address)
            intervals.setdefault(address, []).append((began.pop("since", None), event["ts"], began))
        if event["event"] == "plugged":
            open_now[address] = {key: event.get(key) for key in WHO} | {"since": event["ts"]}
    for address, who in open_now.items():
        who = dict(who)
        intervals.setdefault(address, []).append((who.pop("since", None), None, who))
    for spans in intervals.values():
        spans.sort(key=lambda span: -1e18 if span[0] is None else span[0])
    return intervals, open_now


def who_at(intervals, address, ts):
    spans = intervals.get(address)
    if not spans:
        return None
    starts = [-1e18 if span[0] is None else span[0] for span in spans]
    i = bisect.bisect_right(starts, ts) - 1
    if i < 0:
        return None
    began, ended, who = spans[i]
    return who if ended is None or ts < ended else None


def normalised(reason):
    return re.sub(r"\d+", "N", str(reason))[:120]


def tally(flow_paths, intervals, client_records=()):
    """The line guard's numbers, per company, for these connection log files: each line's company from `intervals`."""
    companies = {}
    node = {"records": 0, "gaps": 0, "gapReasons": {}, "unreadableLines": 0}
    machine_buckets = {}
    failed_windows = {}

    def company(who):
        key = who.get("company") if who and isinstance(who.get("company"), str) else "unattributed"
        if key not in companies:
            companies[key] = {"machines": set(), "connections": 0, "byProto": {}, "buckets": {}, "refused": 0,
                              "refusedByRule": {}, "unanswered": 0, "failed": set(), "failedPast": False,
                              "peakFailed60s": 0, "peakFailed60sAt": None, "brakes": 0, "droppedByBrake": 0}
        return key, companies[key]

    def failed(key, entry, ts, dst):
        if dst not in entry["failed"]:
            if len(entry["failed"]) < DESTINATIONS_KEPT:
                entry["failed"].add(dst)
            else:
                entry["failedPast"] = True
        window = failed_windows.setdefault(key, {})
        minute = int(ts // 60)
        window.setdefault(minute, set()).add(dst)
        for old in [m for m in window if m < minute - 1]:
            size = len(window.pop(old))
            if size > entry["peakFailed60s"]:
                entry["peakFailed60s"], entry["peakFailed60sAt"] = size, iso(old * 60)

    for record in read_lines(flow_paths):
        event = record.get("event")
        if event == "unreadable":
            node["unreadableLines"] += record["count"]
            continue
        if event == "alive":
            continue
        node["records"] += 1
        if event == "gap":
            node["gaps"] += 1
            reason = normalised(record.get("reason"))
            node["gapReasons"][reason] = node["gapReasons"].get(reason, 0) + 1
            continue
        if event in ("braked", "unbraked"):
            # The brake's own lines (qorpera-agent-exit-log.py) name the company; an unbraked line says how many new
            # connections the brake dropped, so they count on the day the brake ended.
            key, entry = company(record)
            if event == "braked":
                entry["brakes"] += 1
            elif isinstance(record.get("dropped"), int) and record["dropped"] > 0:
                entry["droppedByBrake"] += record["dropped"]
            continue
        src = record.get("src")
        who = who_at(intervals, src, record["ts"]) if isinstance(src, str) else None
        key, entry = company(who)
        if who and isinstance(who.get("machine"), str):
            entry["machines"].add(who["machine"])
        if event == "new":
            entry["connections"] += 1
            proto = str(record.get("proto"))
            entry["byProto"][proto] = entry["byProto"].get(proto, 0) + 1
            bucket = int(record["ts"] // 10)
            entry["buckets"][bucket] = entry["buckets"].get(bucket, 0) + 1
            machine = (key, who.get("machine") if who else src)
            per = machine_buckets.setdefault(machine, {})
            per[bucket] = per.get(bucket, 0) + 1
        elif event == "destroy":
            if not record.get("packets_in"):
                entry["unanswered"] += 1
                failed(key, entry, record["ts"], str(record.get("dst")))
        elif event == "refused":
            entry["refused"] += 1
            rule = str(record.get("rule"))
            entry["refusedByRule"][rule] = entry["refusedByRule"].get(rule, 0) + 1
            failed(key, entry, record["ts"], str(record.get("dst")))
    for unreadable in (r for r in client_records if r.get("event") == "unreadable"):
        node["unreadableLines"] += unreadable["count"]

    result = {}
    for key, entry in companies.items():
        for minute, destinations in failed_windows.get(key, {}).items():
            if len(destinations) > entry["peakFailed60s"]:
                entry["peakFailed60s"], entry["peakFailed60sAt"] = len(destinations), iso(minute * 60)
        peak_bucket, peak = max(entry["buckets"].items(), key=lambda item: (item[1], -item[0]), default=(None, 0))
        top = max(((machine[1], max(per.values())) for machine, per in machine_buckets.items() if machine[0] == key),
                  key=lambda item: (item[1], str(item[0])), default=(None, 0))
        result[key] = {
            "machines": len(entry["machines"]),
            "connections": entry["connections"],
            "byProto": dict(sorted(entry["byProto"].items())),
            "peakNew10s": peak,
            "peakNew10sAt": iso(peak_bucket * 10) if peak_bucket is not None else None,
            "peakNew10sOneMachine": top[1],
            "refused": entry["refused"],
            "refusedByRule": dict(sorted(entry["refusedByRule"].items())),
            "unanswered": entry["unanswered"],
            # Past the destinations kept the number is a lower bound.
            "failedDestinations": len(entry["failed"]),
            "failedDestinationsAtLeast": entry["failedPast"],
            "peakFailedDestinations60s": entry["peakFailed60s"],
            "peakFailedDestinations60sAt": entry["peakFailed60sAt"],
            "brakes": entry["brakes"],
            "droppedByBrake": entry["droppedByBrake"],
        }
    return {"companies": dict(sorted(result.items())), "node": node}


def count_day(log_dir, day, start, files=None, late=()):
    """The line guard's numbers for `day` from its own files, per company, with `late` client history parts (names of
    other days' parts) applied first; and who is still plugged in when it ends, and the intervals."""
    files = regular_files(log_dir) if files is None else files
    client_records = list(read_lines(day_files(log_dir, "clients", day, files)
                                     + [os.path.join(log_dir, name) for name in late if name.startswith("clients-")]))
    intervals, end = attribution_intervals(start, [r for r in client_records if r.get("ts") is not None])
    counts = tally(day_files(log_dir, "flows", day, files), intervals, client_records)
    return counts, end, intervals


def advance(log_dir, day, start, files=None):
    """Who is plugged in when `day` ends, from who was when it began and the day's client history alone."""
    files = regular_files(log_dir) if files is None else files
    events = [r for r in read_lines(day_files(log_dir, "clients", day, files)) if r.get("ts") is not None]
    return attribution_intervals(start, events)[1]


EXPIRED = f"kept {KEEP_DAYS} days"


def deleted_early(log_dir):
    """Day to the number of its files deleted before their 90 days (over the cap, or the disk low), from the records."""
    days = {}
    for record in lost_records(log_dir).values():
        if record.get("reason") != EXPIRED and isinstance(record.get("day"), str):
            days[record["day"]] = days.get(record["day"], 0) + 1
    return days


def read_counts(log_dir, day):
    """A counted day's counts, or None (none, or not readable)."""
    try:
        with open(os.path.join(log_dir, f"counts-{day}.json"), encoding="utf-8") as f:
            value = json.load(f)
        return value if isinstance(value, dict) and isinstance(value.get("companies"), dict) else None
    except (OSError, ValueError):
        return None


def counted_parts(log_dir, files):
    """Every part named in a counts file: its day's own parts, and the late parts it counted."""
    names = set()
    for name in files:
        m = COUNTS.match(name)
        counts = read_counts(log_dir, m.group(1)) if m else None
        if counts:
            names.update(p for p in counts.get("parts") or [] if isinstance(p, str))
            for late in counts.get("late") or []:
                if isinstance(late, dict):
                    names.update(p for p in late.get("parts") or [] if isinstance(p, str))
    return names


def checkpoint(log_dir, files):
    """The last day counted and who was plugged in when it ended. The newest counts file is the commit point;
    attribution.json is only a copy of it, used when no counts file is left (all past 90 days)."""
    for day in sorted((m.group(1) for name in files if (m := COUNTS.match(name))), reverse=True):
        counts = read_counts(log_dir, day)
        if counts and isinstance(counts.get("pluggedInAtEnd"), dict):
            return day, counts["pluggedInAtEnd"]
    try:
        with open(os.path.join(log_dir, "attribution.json"), encoding="utf-8") as f:
            value = json.load(f)
        if isinstance(value.get("through"), str) and isinstance(value.get("open"), dict):
            return value["through"], value["open"]
    except (OSError, ValueError, AttributeError):
        pass
    return None, {}


def first_day(log_dir, files, kinds=("flows", "clients")):
    days = [m.group(2) for name in files if (m := OPEN.match(name) or SEALING.match(name) or PART.match(name))
            and m.group(1) in kinds]
    return min(days, default=None)


def unsealed(files, day):
    """A day's files not sealed yet: an open file, or one being sealed."""
    return sorted(name for name in files if (m := OPEN.match(name) or SEALING.match(name)) and m.group(2) == day)


def copy_matches(log_dir, through, plugged):
    try:
        with open(os.path.join(log_dir, "attribution.json"), encoding="utf-8") as f:
            value = json.load(f)
        return value.get("through") == through and value.get("open") == plugged
    except (OSError, ValueError, AttributeError):
        return False


def write_attribution(log_dir, through, plugged):
    """The checkpoint's copy. A failure is only reported: the newest counts file is the checkpoint (tidy never deletes
    it), and the next pass writes the copy again."""
    try:
        write_json(os.path.join(log_dir, "attribution.json"),
                   {"schema": "qorpera.agent-exit-attribution/v1", "through": through, "open": plugged})
    except OSError as error:
        print(f"qorpera-agent-exit-logs: cannot write attribution.json: {error}", file=sys.stderr, flush=True)


def count_closed_days(log_dir, now, host):
    """Counts each closed day once, in order, once all its files are sealed (each counted part keeps its name). A part
    that turns up for a day already counted (a late one) is counted with the next day counted, under its own day: it
    never changes a day already counted. The counts file is the one commit point (written whole, then renamed): it
    lists the parts it counted and who was plugged in when its day ended. Returns how many days it counted and the
    closed days it could not count yet."""
    files = regular_files(log_dir)
    through, plugged = checkpoint(log_dir, files)
    if through and not copy_matches(log_dir, through, plugged):
        # The copy is behind the checkpoint (an earlier write failed): written again before anything else.
        write_attribution(log_dir, through, plugged)
    day = next_day(through) if through else first_day(log_dir, files)
    counted = counted_parts(log_dir, files)
    done = 0
    while day is not None and now >= day_start(day) + DAY + GRACE:
        waiting = unsealed(files, day)
        if waiting:
            return done, [f"{day} is closed but not counted: {', '.join(waiting)} not sealed"]
        own = sorted(name for name in files if PART.match(name) and file_day(name) == day)
        late = sorted(name for name in files if PART.match(name) and file_day(name) < day and name not in counted)
        counts, end, intervals = count_day(log_dir, day, plugged, files, late)
        late_counts = []
        for original in sorted({file_day(name) for name in late}):
            parts = [name for name in late if file_day(name) == original]
            flows = [os.path.join(log_dir, name) for name in parts if name.startswith("flows-")]
            late_counts.append({"day": original, "parts": parts, **tally(flows, intervals)})
        write_json(os.path.join(log_dir, f"counts-{day}.json"),
                   {"schema": "qorpera.agent-exit-counts/v1", "day": day, "host": host, "countedAt": iso(now),
                    "parts": own, "late": late_counts, "pluggedInAtEnd": end, **counts})
        write_attribution(log_dir, day, end)
        counted |= set(own) | set(late)
        plugged = end
        done += 1
        day = next_day(day)
    return done, []


def file_day(name):
    for pattern, group in ((PART, 2), (DNS_PART, 1), (DNS_COPY, 1), (COUNTS, 1), (OPEN, 2), (SEALING, 2)):
        m = pattern.match(name)
        if m:
            return m.group(group)
    return None


def kind_of(name):
    """flows, clients, dns or counts."""
    m = PART.match(name) or OPEN.match(name) or SEALING.match(name)
    if m:
        return m.group(1)
    if DNS_PART.match(name) or DNS_COPY.match(name) or name == "dns.log":
        return "dns"
    return "counts" if COUNTS.match(name) else None


def delete_recorded(log_dir, now, name, size, reason):
    """Deletes a file, its record written first: lost/<name>.json, whole (a temporary file, synced, renamed), then
    lost/ and the log folder synced, so a record exists complete or not at all, and a deletion is never unrecorded. A
    record a pass cut short left is not written again, but synced all the same."""
    folder = os.path.join(log_dir, LOST)
    if not os.path.isdir(folder):
        os.makedirs(folder, mode=0o750, exist_ok=True)
        sync_folder(log_dir)
    record = os.path.join(folder, f"{name}.json")
    if not os.path.lexists(record):
        write_json(record, {"ts": now, "recordedAt": time.time_ns(), "file": name, "bytes": size, "day": file_day(name),
                            "reason": reason})
    records_on_disk(log_dir)
    os.unlink(os.path.join(log_dir, name))


def replay_deletions(log_dir):
    """Recorded deletions whose file is still there (a pass cut short between the record and the unlink) are finished
    first, every pass, whatever the pressure is now: their names are never used again. Their records are synced first
    (the pass may have been cut short before it synced them)."""
    files = regular_files(log_dir)
    pending = [name for name in sorted(lost_names(log_dir))
               if name in files and (PART.match(name) or DNS_PART.match(name))]
    if pending:
        records_on_disk(log_dir)
    for name in pending:
        os.unlink(os.path.join(log_dir, name))
    return pending


def tidy(log_dir, now, cap, floor, free=free_percent):
    """Removes the parts the NAS holds once they are a week old, deletes what is older than 90 days, then the oldest
    parts while the logs are over 80% of their cap or the disk has less than the floor plus 5 points free: those the
    NAS holds first, then the DNS record's and the connection log's, the client history's last. A connection log or
    client history part goes only once a counts file names it (the one rule, at 90 days and under pressure alike); the
    open files and the counts never go under pressure. A part the NAS holds goes without a deletion record (its shipped
    record says where it is). Returns what it deleted (recorded), what it removed (on the NAS), and whether, after
    that, the logs are still over their cap or the disk under the floor: the lines where the logger pauses."""
    deleted = replay_deletions(log_dir)
    files = regular_files(log_dir)
    counted = counted_parts(log_dir, files)
    shipped = set(shipped_records(log_dir))
    oldest_kept = day_of(now - KEEP_DAYS * DAY)
    removed = []

    def may_go(name):
        return DNS_PART.match(name) or (PART.match(name) and name in counted)

    def expire(name):
        delete_recorded(log_dir, now, name, files.pop(name), EXPIRED)
        deleted.append(name)

    def remove(name):
        if not removed:
            # The shipped records' names are on disk before any file they stand for goes.
            sync_folder(os.path.join(log_dir, SHIPPED))
        os.unlink(os.path.join(log_dir, name))
        files.pop(name)
        removed.append(name)

    local_kept = day_of(now - LOCAL_DAYS * DAY)
    for name in sorted(files):
        if name in shipped and may_go(name) and file_day(name) < local_kept:
            remove(name)
    # The parts first, the counts after: a counts file goes only once no part it names is left (so a part never
    # outlives the counts that name it, also when a pass is cut short), and the newest one, the checkpoint, never.
    for name in sorted(files):
        day = file_day(name)
        if day is not None and day < oldest_kept and may_go(name):
            expire(name)
    newest = max((m.group(1) for name in files if (m := COUNTS.match(name))), default=None)
    for name in sorted(files):
        m = COUNTS.match(name)
        if not m or m.group(1) >= oldest_kept or m.group(1) == newest:
            continue
        counts = read_counts(log_dir, m.group(1)) or {}
        named = set(counts.get("parts") or []) | {p for late in counts.get("late") or [] if isinstance(late, dict)
                                                  for p in late.get("parts") or []}
        if named & set(files):
            continue
        expire(name)
    files = regular_files(log_dir)
    candidates = sorted(
        (name for name in files if may_go(name)),
        key=lambda name: (name not in shipped, name.startswith("clients-"), file_day(name), name),
    )
    low_water = floor + LOW_WATER_MARGIN
    for name in candidates:
        # The records count toward the cap too, though they never go.
        total = sum(files.values()) + record_bytes(log_dir)
        if total <= cap * CAP_SHARE and free(log_dir) >= low_water:
            break
        if name in shipped:
            remove(name)
            continue
        reason = "over the cap" if total > cap * CAP_SHARE else "the disk is low"
        delete_recorded(log_dir, now, name, files.pop(name), reason)
        deleted.append(name)
    still = kept_bytes(log_dir) > cap or free(log_dir) < floor
    return deleted, removed, still


def tend(log_dir, status, cap, floor, now=None, part_bytes=PART_BYTES, settle=SETTLE_SECONDS, free=free_percent):
    """One pass. Returns its record, or None when another pass holds the folder's lock."""
    lock = os.open(os.path.join(log_dir, ".tend.lock"), os.O_RDONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(lock)
        return None
    try:
        return tend_locked(log_dir, status, cap, floor, now, part_bytes, settle, free)
    finally:
        os.close(lock)


def tend_locked(log_dir, status, cap, floor, now, part_bytes, settle, free):
    now = time.time() if now is None else now
    problems = []
    result = {"schema": "qorpera.agent-exit-logs/v1", "ranAt": iso(time.time()), "capBytes": cap,
              "floorPercent": floor}
    for name in regular_files(log_dir):
        if TEMPORARY.match(name):
            os.unlink(os.path.join(log_dir, name))
    if os.path.isdir(os.path.join(log_dir, LOST)):
        for name in regular_files(os.path.join(log_dir, LOST)):
            if TEMPORARY.match(name):
                os.unlink(os.path.join(log_dir, LOST, name))
    steps = (
        ("sealed", lambda: seal_files(log_dir, now, part_bytes, settle)),
        ("dnsRotated", lambda: rotate_dns(log_dir, now, part_bytes)),
        ("daysCounted", lambda: count_closed_days(log_dir, now, socket.gethostname())),
    )
    for key, step in steps:
        if key == "daysCounted":
            # Counting a busy day takes minutes: the status says the pass is alive (and the disk's steps done) meanwhile.
            write_json(status, result | {"problems": problems, "counting": True}, 0o644)
        try:
            result[key] = step()
            if key == "daysCounted":
                # A closed day not counted keeps its parts (they go only once counted): a problem, not a silence.
                result[key], waiting = result[key]
                problems.extend(waiting)
        except Exception as error:  # noqa: BLE001 - every step is tried; a failure is a problem, never the end
            result[key] = None
            problems.append(f"{key}: {error}"[:300])
            print(f"qorpera-agent-exit-logs: {key}: {error}", file=sys.stderr, flush=True)
    try:
        deleted, removed, still = tidy(log_dir, now, cap, floor, free)
        result["deleted"] = len(deleted)
        result["removedShipped"] = len(removed)
        if still:
            problems.append("the logs are over their cap, or the disk under its floor, with every part it may delete gone")
    except Exception as error:  # noqa: BLE001
        problems.append(f"tidy: {error}"[:300])
        print(f"qorpera-agent-exit-logs: tidy: {error}", file=sys.stderr, flush=True)
    try:
        result["bytes"] = kept_bytes(log_dir)
        result["freePercent"] = round(free(log_dir), 1)
    except OSError as error:
        problems.append(f"cannot read the log folder: {error}"[:300])
    result["problems"] = problems
    write_json(status, result, 0o644)
    return result


class ShipError(Exception):
    """One file could not go (a different file of its name is on the NAS, or its copy read back wrong); the next goes."""


def file_sha256(path, uncached=False, dir_fd=None):
    """A file's sha256. `uncached` drops what the node's page cache holds of it first, so a copy on the NAS is read
    back from the NAS, not from what this node just wrote. With dir_fd, path is a name in that open folder."""
    digest = hashlib.sha256()
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=dir_fd)
    with os.fdopen(fd, "rb") as f:
        if uncached and hasattr(os, "posix_fadvise"):
            os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
        while chunk := f.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def is_mount(path, fd=None):
    """Whether the folder `path` (open as `fd`, if given) is a mount point: the share mounted there, not the bare
    folder under it on the node's own disk (where a marker left by mistake would otherwise pass)."""
    try:
        here = os.fstat(fd) if fd is not None else os.stat(path)
        parent = os.stat(os.path.join(path, ".."))
    except OSError:
        return False
    return here.st_dev != parent.st_dev or here.st_ino == parent.st_ino


def nas_open(parent_fd, name):
    """Opens the folder `name` in the open NAS folder `parent_fd`, made first if it is not there (never a link)."""
    try:
        os.mkdir(name, 0o750, dir_fd=parent_fd)
        os.fsync(parent_fd)
    except FileExistsError:
        pass
    return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent_fd)


def nas_copy(source, folder_fd, name, where):
    """Copies `source` to `name` in the open NAS folder `folder_fd` and returns its sha256: written beside it, synced,
    renamed into place, then read back from the NAS. A file already there with the same content is kept; one with
    other content is never overwritten (a ShipError). Only this node's pass writes in its folder (the lock). `where` is
    the copy's path, for the messages."""
    tmp = f".{name}.tmp"
    with contextlib.suppress(FileNotFoundError):
        os.unlink(tmp, dir_fd=folder_fd)
    try:
        os.stat(name, dir_fd=folder_fd, follow_symlinks=False)
    except FileNotFoundError:
        pass
    else:
        ours, theirs = file_sha256(source), file_sha256(name, uncached=True, dir_fd=folder_fd)
        if ours != theirs:
            raise ShipError(f"{where} is on the NAS with other content (sha256 {theirs[:12]}, ours {ours[:12]}): "
                            "left as it is, and this file stays on the node")
        return ours
    digest = hashlib.sha256()
    with open(os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC), "rb") as src:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o640,
                     dir_fd=folder_fd)
        with os.fdopen(fd, "wb") as dst:
            while chunk := src.read(1024 * 1024):
                digest.update(chunk)
                dst.write(chunk)
            dst.flush()
            os.fsync(dst.fileno())
    os.rename(tmp, name, src_dir_fd=folder_fd, dst_dir_fd=folder_fd)
    os.fsync(folder_fd)
    if file_sha256(name, uncached=True, dir_fd=folder_fd) != digest.hexdigest():
        os.unlink(name, dir_fd=folder_fd)
        raise ShipError(f"{where} read back from the NAS is not what was written: removed, tried again next pass")
    return digest.hexdigest()


def waiting_files(log_dir, now):
    """What is still to go to the NAS, oldest day first: (day, sub, name, path, written), sub "lost" for a deletion
    record. The sealed parts, the DNS parts, the counts and the deletion records go; nothing past its 90 days."""
    oldest_kept = day_of(now - KEEP_DAYS * DAY)
    shipped, shipped_lost = set(shipped_records(log_dir)), set(shipped_records(log_dir, LOST))
    candidates = [(file_day(name), "", name, os.path.join(log_dir, name)) for name in regular_files(log_dir)
                  if (PART.match(name) or DNS_PART.match(name) or COUNTS.match(name)) and name not in shipped]
    candidates += [(file_day(name), LOST, name, os.path.join(log_dir, LOST, f"{name}.json"))
                   for name in lost_names(log_dir) if file_day(name) and name not in shipped_lost]
    waiting = []
    for day, sub, name, path in sorted(candidates):
        if day < oldest_kept:
            continue
        try:
            waiting.append((day, sub, name, path, os.lstat(path).st_mtime))
        except FileNotFoundError:
            continue
    return waiting


def not_shipped(log_dir, now, waiting=True):
    """Kind (flows, clients, dns, counts) to the days whose lines are not all on the NAS: what waits (unless not
    `waiting`), the open files, and dns.log since the last cut."""
    days = {}
    for day, _, name, _, _ in waiting_files(log_dir, now) if waiting else ():
        days.setdefault(kind_of(name), set()).add(day)
    files = regular_files(log_dir)
    for name in files:
        if OPEN.match(name) or SEALING.match(name) or DNS_COPY.match(name):
            days.setdefault(kind_of(name), set()).add(file_day(name))
    if files.get("dns.log"):
        cuts = [file_day(name) for name in [*files, *shipped_records(log_dir), *lost_names(log_dir)]
                if DNS_PART.match(name)]
        day = max(cuts, default=None) or first_day(log_dir, files) or day_of(now)
        while day <= day_of(now):
            days.setdefault("dns", set()).add(day)
            day = next_day(day)
    return {kind: sorted(each) for kind, each in sorted(days.items())}


def ship(log_dir, nas_dir, status, host, now=None, mount_check=True):
    """One pass. Returns its record, or None when another pass holds the lock. Without `mount_check` (tests), the NAS
    folder need not be a mount point."""
    lock = os.open(os.path.join(log_dir, ".ship.lock"), os.O_RDONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(lock)
        return None
    try:
        return ship_locked(log_dir, nas_dir, status, host, now, mount_check)
    finally:
        os.close(lock)


def overdue(waiting, now, errors):
    late = [written for *_, written in waiting if written < now - WAIT_LIMIT]
    if not late:
        return []
    last = f"; the last error: {errors[-1]}" if errors else ""
    return [f"{len(late)} files have waited more than {WAIT_LIMIT // 3600} hours to go to the NAS, the oldest since "
            f"{iso(min(late))}{last}"[:600]]


def ship_locked(log_dir, nas_dir, status, host, now, mount_check=True):
    now = time.time() if now is None else now
    result = {"schema": "qorpera.agent-exit-ship/v1", "ranAt": iso(time.time()), "host": host, "nasDir": nas_dir,
              "shipped": 0}
    errors = []
    try:
        with open(status, encoding="utf-8") as f:
            if json.load(f).get("shipping"):
                errors.append("the last pass did not finish (cut short, or the NAS stopped answering)")
    except (OSError, ValueError, AttributeError):
        pass
    for folder in (os.path.join(log_dir, SHIPPED), os.path.join(log_dir, SHIPPED, LOST)):
        os.makedirs(folder, mode=0o750, exist_ok=True)
        for name in regular_files(folder):
            if TEMPORARY.match(name):
                os.unlink(os.path.join(folder, name))
    # What waits, and since when, is known from the node alone, before the NAS is touched: a NAS that hangs cannot
    # hide it.
    waiting = waiting_files(log_dir, now)
    # Every line written before the pass began is on the NAS by its end, or in a file still waiting then, or in a file
    # not yet sealed or cut now (one sealed or cut meanwhile may have left the lists taken at the end).
    pending = not_shipped(log_dir, now, waiting=False)
    problems = overdue(waiting, now, errors) if nas_dir else [NO_NAS]
    last_status = time.monotonic()

    def interim():
        nonlocal last_status
        write_json(status, result | {"shipping": True, "waiting": len(waiting), "errors": errors,
                                     "problems": problems}, 0o644)
        last_status = time.monotonic()

    if nas_dir:
        interim()
        # Every step on the NAS goes through folders opened in the one checked as a mount point holding the marker (a
        # marker left on the bare folder under it does not pass): an unmount meanwhile fails (busy), and a lazy one
        # leaves these on the NAS, so nothing is ever written into the bare mount point.
        fds = {}

        def nas(*names):
            if names not in fds:
                fds[names] = nas_open(nas(*names[:-1]), names[-1])
            return fds[names]

        try:
            fds[()] = os.open(nas_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
            if mount_check and not is_mount(nas_dir, fds[()]):
                raise ShipError(f"{nas_dir} is not a mount point: the NAS is not mounted there")
            try:
                marker = os.stat(NAS_MARKER, dir_fd=fds[()], follow_symlinks=False)
            except FileNotFoundError:
                marker = None
            if marker is None or not stat.S_ISREG(marker.st_mode):
                raise ShipError(f"{nas_dir} has no {NAS_MARKER}: the NAS is not mounted there")
            host_fd = nas(host)
            current = None
            for day, sub, name, path, _ in waiting:
                if day != current:
                    for key in [key for key in fds if len(key) > 1]:
                        os.close(fds.pop(key))
                    current = day
                folder_fd = nas(host, day, sub) if sub else nas(host, day)
                target = f"{name}.json" if sub else name
                where = os.path.join(nas_dir, host, day, sub, target)
                try:
                    digest = nas_copy(path, folder_fd, target, where)
                    size = os.lstat(path).st_size
                except ShipError as error:
                    errors.append(str(error)[:300])
                    continue
                except FileNotFoundError:
                    if os.path.lexists(path):
                        raise
                    # The tender deleted it meanwhile; its deletion record goes next pass.
                    continue
                write_json(os.path.join(log_dir, SHIPPED, sub, f"{name}.json"),
                           {"file": name, "bytes": size, "sha256": digest, "day": day,
                            "to": "/".join(p for p in (host, day, sub, target) if p), "shippedAt": iso(time.time())})
                result["shipped"] += 1
                if time.monotonic() - last_status >= STATUS_EVERY:
                    interim()
            # The other nodes' lookups read here what this node has not shipped yet.
            for kind, days in not_shipped(log_dir, now).items():
                pending[kind] = sorted(set(pending.get(kind, [])) | set(days))
            write_json("status.json", {"schema": "qorpera.agent-exit-ship-host/v1", "host": host, "through": iso(now),
                                       "notShipped": pending}, 0o644, dir_fd=host_fd)
            result["removedFromNas"] = expire_nas(log_dir, host_fd, now)
        except (OSError, ShipError) as error:
            errors.append(f"{error}"[:300])
            print(f"qorpera-agent-exit-logs: ship: {error}", file=sys.stderr, flush=True)
        finally:
            for fd in fds.values():
                os.close(fd)
        waiting = waiting_files(log_dir, now)
        problems = overdue(waiting, now, errors)
    result |= {"waiting": len(waiting), "oldestWaiting": iso(min(w[4] for w in waiting)) if waiting else None,
               "errors": errors[-20:], "problems": problems}
    write_json(status, result, 0o644)
    return result


def expire_nas(log_dir, host_fd, now):
    """This node's day folders on the NAS (the open folder `host_fd`) past their 90 days go, and the node's shipped
    records of them."""
    oldest_kept = day_of(now - KEEP_DAYS * DAY)
    gone = 0
    with os.scandir(host_fd) as entries:
        old = sorted(entry.name for entry in entries
                     if DAY_NAME.match(entry.name) and entry.name < oldest_kept and entry.is_dir(follow_symlinks=False))
    for day in old:
        shutil.rmtree(day, dir_fd=host_fd)
        gone += 1
    for sub in ("", LOST):
        for name, record in shipped_records(log_dir, sub).items():
            day = record.get("day") if isinstance(record.get("day"), str) else file_day(name)
            if day is None or day < oldest_kept:
                os.unlink(os.path.join(log_dir, SHIPPED, sub, f"{name}.json"))
    return gone


def report(log_dir, start, end, as_json):
    days = sorted(m.group(1) for name in regular_files(log_dir) if (m := COUNTS.match(name)) and
                  (start is None or m.group(1) >= start) and (end is None or m.group(1) <= end))
    companies = {}
    early = deleted_early(log_dir)
    node = {"days": len(days), "gaps": 0, "deletedEarly": sum(early.get(day, 0) for day in days), "unreadableLines": 0}
    for day in days:
        with open(os.path.join(log_dir, f"counts-{day}.json"), encoding="utf-8") as f:
            counts = json.load(f)
        for key in ("gaps", "unreadableLines"):
            node[key] += counts["node"].get(key, 0)
            node[key] += sum((late.get("node") or {}).get(key, 0) for late in counts.get("late") or [])
        # A day's own numbers, then the late ones counted with it (added up, but no day of their own).
        booked = [(True, counts["companies"])] + [(False, late.get("companies") or {}) for late in counts.get("late") or []]
        for own, company, c in ((own, company, c) for own, each in booked for company, c in each.items()):
            total = companies.setdefault(company, {"days": 0, "connections": 0, "maxConnectionsDay": 0, "maxMachines": 0,
                                                   "peakNew10s": 0, "peakNew10sOneMachine": 0, "refused": 0,
                                                   "unanswered": 0, "peakFailedDestinations60s": 0, "brakes": 0,
                                                   "droppedByBrake": 0})
            total["connections"] += c["connections"]
            if own:
                total["days"] += 1
                total["maxConnectionsDay"] = max(total["maxConnectionsDay"], c["connections"])
                total["maxMachines"] = max(total["maxMachines"], c["machines"])
            for key in ("peakNew10s", "peakNew10sOneMachine", "peakFailedDestinations60s"):
                total[key] = max(total[key], c[key])
            total["refused"] += c["refused"]
            total["unanswered"] += c["unanswered"]
            # Days counted before the brake have neither.
            total["brakes"] += c.get("brakes", 0)
            total["droppedByBrake"] += c.get("droppedByBrake", 0)
    result = {"from": days[0] if days else start, "to": days[-1] if days else end, "node": node,
              "companies": dict(sorted(companies.items(), key=lambda item: -item[1]["connections"]))}
    if as_json:
        print(json.dumps(result, indent=2, sort_keys=False))
        return
    print(f"Agent exit counts on {socket.gethostname()}, {result['from']} to {result['to']}: {node['days']} days counted, "
          f"{node['gaps']} gap lines, {node['deletedEarly']} files deleted before their 90 days.")
    print("Per company: days with traffic, new connections (all days, busiest day), most machines on a day, the most new")
    print("connections in 10 seconds (the company, one machine), refused, unanswered, the most failed destinations in")
    print("one minute, times braked, new connections the brake dropped.")
    header = ("company", "days", "conns", "busiest", "machines", "peak10s", "machine10s", "refused", "unanswered",
              "failed60s", "brakes", "dropped")
    print("  ".join(f"{h:>10}" if i else f"{h:<36}" for i, h in enumerate(header)))
    for company, t in result["companies"].items():
        row = (company, t["days"], t["connections"], t["maxConnectionsDay"], t["maxMachines"], t["peakNew10s"],
               t["peakNew10sOneMachine"], t["refused"], t["unanswered"], t["peakFailedDestinations60s"], t["brakes"],
               t["droppedByBrake"])
        print("  ".join(f"{v:>10}" if i else f"{v:<36}" for i, v in enumerate(row)))


MONTHS = {name: number for number, name in enumerate(
    ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"), 1)}
# dnsmasq's lines (--log-queries=extra, to a file): "Oct  6 12:03:04 dnsmasq[pid]: <serial> <client>/<port> query[A]
# <name> from <client>", then "... reply <name> is <address>" or "... cached <name> is <address>" with the same serial
# (a CNAME chain answers under each name in turn).
DNS_LINE = re.compile(r"^(\w{3}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) dnsmasq\[\d+\]: (\d+) ([0-9A-Fa-f.:]+)/\d+ "
                      r"(query\[\w+\]|reply|cached) (\S+) (?:from|is) (\S+)")


def read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            value = json.load(f)
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def parse_time(text):
    """Seconds since the epoch, or an ISO time (UTC unless it says otherwise)."""
    try:
        return float(text)
    except ValueError:
        value = datetime.datetime.fromisoformat(text)
        return (value if value.tzinfo else value.replace(tzinfo=datetime.UTC)).timestamp()


def cut_time(name):
    return datetime.datetime.strptime(name[4:22], "%Y-%m-%dT%H%M%SZ").replace(tzinfo=datetime.UTC).timestamp()


def dns_time(m, reference):
    """A dnsmasq line's time. dnsmasq writes its local time, and runs with TZ=UTC (qorpera-agent-exit.sh dns), so it is
    UTC whatever the node's zone. It has no year: the year of `reference` (the file's cut, or now), or the one before
    for a line that would then come more than a day after it."""
    month = MONTHS.get(m.group(1))
    year = time.gmtime(reference).tm_year
    for each in (year, year - 1):
        try:
            ts = datetime.datetime(each, month or 0, int(m.group(2)), int(m.group(3)), int(m.group(4)),
                                   int(m.group(5)), tzinfo=datetime.UTC).timestamp()
        except ValueError:
            continue
        if ts <= reference + DAY:
            return ts
    return None


def resolutions(sources, clients, addresses):
    """(client, address) to [(time, name)], oldest first: each answer the exit's DNS gave a client, under the name the
    client asked for (the first of a CNAME chain). `sources` are (path, the time its lines end) in order."""
    found, unreadable, asked = {}, [], {}
    needles = [f" {client}/" for client in clients]
    for path, reference in sources:
        opener = gzip.open if path.endswith(".gz") else open
        try:
            with opener(path, "rt", encoding="utf-8", errors="replace") as f:
                for line in f:
                    if not any(needle in line for needle in needles):
                        continue
                    m = DNS_LINE.match(line)
                    if not m or m.group(7) not in clients:
                        continue
                    if m.group(8).startswith("query"):
                        asked[(m.group(7), m.group(6))] = m.group(9)
                    elif m.group(10) in addresses and (ts := dns_time(m, reference)) is not None:
                        name = asked.get((m.group(7), m.group(6)), m.group(9))
                        found.setdefault((m.group(7), m.group(10)), []).append((ts, name))
        except (OSError, EOFError) as error:
            unreadable.append(f"{path}: {error}")
    for answers in found.values():
        answers.sort()
    return found, unreadable


def flow_records(paths, needles):
    """The connection log's lines that hold one of `needles` (a quick test; the caller matches exactly), every gap
    line, with the time of the line before it ("after"; an alive line or the brake's line, written at the clock's time
    while conntrack's can lag, never counts as that), and every alive line. A file, or one of those lines, that cannot
    be read is an "unreadable" record."""
    previous = None
    for path in paths:
        opener = gzip.open if path.endswith(".gz") else open
        try:
            with opener(path, "rt", encoding="utf-8", errors="replace") as f:
                for line in f:
                    gap, alive = '"event":"gap"' in line, '"event":"alive"' in line
                    brake = '"event":"braked"' in line or '"event":"unbraked"' in line
                    if gap or alive or (not brake and any(needle in line for needle in needles)):
                        record = read_line(line)
                        if record is None:
                            yield {"event": "unreadable", "path": path, "error": "a line that cannot be read"}
                        else:
                            if gap:
                                before = read_line(previous)
                                record["after"] = before.get("ts") if before else None
                            yield record
                    if not alive and not brake:
                        previous = line
        except (OSError, EOFError) as error:
            yield {"event": "unreadable", "path": path, "error": str(error)}


def read_line(line):
    try:
        value = json.loads(line) if line else None
    except ValueError:
        return None
    return value if isinstance(value, dict) and isinstance(value.get("ts"), (int, float)) else None


def days_between(first, last):
    days, day = [], first
    while day <= last:
        days.append(day)
        day = next_day(day)
    return days


def merged_spans(spans):
    """(start, end, reason) spans (start None: before what was read), overlapping ones joined: (start, end, the last
    reason, how many)."""
    joined = []
    for start, end, reason in sorted(spans, key=lambda span: (-1e18 if span[0] is None else span[0], span[1])):
        if joined and (start is None or start <= joined[-1][1]):
            first, last, _, count = joined[-1]
            joined[-1] = (first, max(last, end), reason, count + 1)
        else:
            joined.append((start, end, reason, 1))
    return joined


def silences(beats, start, end, covered=(), outer=None):
    """The stretches of more than SILENCE seconds with no line of the logger's own (`beats`, their times), each judged
    at its full length within `outer` (from its last line before `start` to its first after `end`, or as far as is
    known; `start` and `end` unless given), then cut to `start`..`end`, less the (from, to) spans in `covered` (already
    not known): (from, to) pairs, however short what is left of one."""
    low, high = outer or (start, end)
    if start >= end or low >= high:
        return []
    points = sorted({low, high, *(beat for beat in beats if low < beat < high)})
    # The spans already not known, joined, so each stretch is cut by the few it meets.
    spans = []
    for a, b in sorted(covered):
        if spans and a <= spans[-1][1]:
            spans[-1] = (spans[-1][0], max(spans[-1][1], b))
        else:
            spans.append((a, b))
    ends = [b for _, b in spans]
    found = []
    for a, b in zip(points, points[1:]):
        if b - a <= SILENCE:
            continue
        a, b = max(a, start), min(b, end)
        for index in range(bisect.bisect_right(ends, a), len(spans)):
            span_from, span_to = spans[index]
            if a >= b or span_from >= b:
                break
            if span_from > a:
                found.append((a, span_from))
            a = span_to
        if a < b:
            found.append((a, b))
    return found


def is_sign(record):
    """A line that says the logger was logging then, written at the clock's time: an alive line, or a gap line it never
    writes in the middle of a pause (its start, its pause and its resume; each opens or closes a span the lookup lists
    already). Other gap lines (lost events, unlogged refusals, lines it could not write, the DNS record emptied) come
    also from a paused logger."""
    if record.get("event") == "alive":
        return True
    reason = str(record.get("reason")) if record.get("event") == "gap" else ""
    return reason == "logger started" or reason.startswith("resumed: ") or (
        reason.startswith("paused: ") and "DNS record" not in reason)


def first_sign(paths):
    """The time of the first line of the logger's own that says it was logging (is_sign) in these files."""
    for record in flow_records(paths, []):
        if is_sign(record):
            return record["ts"]
    return None


def last_sign(paths):
    """The time of the last line of the logger's own that says it was logging in these files (the last that holds one
    is read)."""
    for path in reversed(paths):
        times = [record["ts"] for record in flow_records([path], []) if is_sign(record)]
        if times:
            return max(times)
    return None


def nas_days(host_dir):
    try:
        with os.scandir(host_dir) as entries:
            return {entry.name for entry in entries if DAY_NAME.match(entry.name) and entry.is_dir(follow_symlinks=False)}
    except OSError:
        return set()


def host_index(local_dir, host_dir, days):
    """A node's log files for these days, name to path (the node's own first, then the NAS), its deletion records (name
    to record) and the NAS folders it could not read."""
    names, lost, unreadable = {}, {}, []
    wanted = set(days)
    if local_dir:
        for name in regular_files(local_dir):
            if file_day(name) in wanted or name == "dns.log":
                names[name] = os.path.join(local_dir, name)
        lost = {name: record for name, record in lost_records(local_dir).items() if file_day(name) in wanted}
    if host_dir:
        for day in sorted(wanted & nas_days(host_dir)):
            folder = os.path.join(host_dir, day)
            try:
                files = regular_files(folder)
            except OSError as error:
                unreadable.append((day, f"{folder}: {error}"))
                continue
            for name in files:
                names.setdefault(name, os.path.join(folder, name))
            for name, record in records_in(os.path.join(folder, LOST)).items():
                lost.setdefault(name, record)
    return names, lost, unreadable


def counts_before(local_dir, host_dir, day):
    """The newest counts before `day`, the node's own or on the NAS: (its day, who was plugged in when it ended)."""
    paths = {each: os.path.join(host_dir, each, f"counts-{each}.json") for each in nas_days(host_dir) if each < day} \
        if host_dir else {}
    for name in regular_files(local_dir) if local_dir else ():
        m = COUNTS.match(name)
        if m and m.group(1) < day:
            paths[m.group(1)] = os.path.join(local_dir, name)
    for each in sorted(paths, reverse=True):
        counts = read_json(paths[each])
        if counts and isinstance(counts.get("pluggedInAtEnd"), dict):
            return each, counts["pluggedInAtEnd"]
    return None, {}


KIND_WHAT = {"flows": "connections", "clients": "companies", "dns": "names"}


def lookup(log_dir, nas_dir, host, at, window, margin, remote, port, agent, now, heartbeat=None, pause_file=None,
           failing_file=None, mount_check=True):
    """Who used an address at a time: the connections from the agents (to `remote`, from `agent`, or both) that were
    open within `window` seconds of `at`, on this node (its own logs, then the NAS) and on every node with a folder on
    the NAS, each with its company, machine and the name the machine had looked up. Read: the days from `margin` days
    before the window to `margin` days after (a connection is found by its start line or its end line in them). What
    the logs cannot say (a gap, a deleted file, a file not on the NAS yet, a node that has not shipped, a logger paused,
    failing or not running now, a stretch with no alive line) is listed as not known, never as no one; the answer is
    complete only with no such gap for connections or companies."""
    low, high = at - window, at + window
    first, last = day_of(low - margin * DAY), day_of(high + margin * DAY)
    scanned = days_between(first, last)
    oldest_kept = day_of(now - KEEP_DAYS * DAY)
    unknown, connections, refused = [], [], []
    # Node ("*" for all) to the spans already not known for connections, wherever they are: no silence is listed again
    # within one.
    covered = {}

    def not_known(node, start, end, what, why):
        # Connections: where it touches the window. Companies: anywhere before the window ends (a plugged line missed
        # earlier changes who an address belonged to). Names: where it touches the window, or the day before it.
        if what == "companies":
            touches = start is None or start <= high
        else:
            touches = (start is None or start <= high) and (end is None or end >= low - (DAY if what == "names" else 0))
        if what == "connections":
            covered.setdefault(node, []).append((-float("inf") if start is None else start,
                                                 float("inf") if end is None else end))
        entry = {"node": node, "from": iso(start) if start is not None else None,
                 "to": iso(end) if end is not None else None, "what": what, "why": str(why)[:300]}
        if touches and entry not in unknown:
            unknown.append(entry)

    hosts = [(host, True)]
    mounted = bool(nas_dir) and (not mount_check or is_mount(nas_dir))
    nas_ok = mounted and os.path.isfile(os.path.join(nas_dir, NAS_MARKER))
    if not nas_dir:
        not_known("*", low, high, "connections", f"{NO_NAS}: the other nodes were not searched")
    elif not mounted:
        not_known("*", low, high, "connections", f"{nas_dir} is not a mount point: the NAS is not mounted, so the "
                                                 "other nodes and what this one shipped were not searched")
    elif not nas_ok:
        not_known("*", low, high, "connections", f"{nas_dir} has no {NAS_MARKER}: the NAS is not mounted, so the "
                                                 "other nodes and what this one shipped were not searched")
    else:
        try:
            with os.scandir(nas_dir) as entries:
                hosts += sorted((entry.name, False) for entry in entries if HOST_NAME.match(entry.name)
                                and entry.name != host and entry.is_dir(follow_symlinks=False))
        except OSError as error:
            not_known("*", low, high, "connections", f"the other nodes were not searched: {error}")
    if first < oldest_kept:
        not_known("*", day_start(first), day_start(oldest_kept), "connections", f"logs are kept {KEEP_DAYS} days")
    if heartbeat:
        # The logger's own sign of life (every 5 seconds): a logger not running now writes its gap only once it starts.
        try:
            beat = os.stat(heartbeat).st_mtime
        except OSError:
            beat = None
        if beat is None or beat < now - 60:
            not_known(host, beat, None, "connections", "the connection logger is not running now" +
                      (f" (its last sign of life: {iso(beat)})" if beat is not None else ""))
    # The logger's markers: each there exactly while it pauses, or while it cannot write, and written when that began.
    # Its gap line comes only when that ends, and a pause writes no alive lines from its start.
    for marker, state in ((pause_file, "the connection log is paused now"),
                          (failing_file, "the connection logger is failing now")):
        if not marker:
            continue
        try:
            since = os.stat(marker).st_mtime
            with open(marker, encoding="utf-8", errors="replace") as f:
                said = f.read(300).strip()
        except FileNotFoundError:
            continue
        except OSError as error:
            not_known(host, None, None, "connections", f"{marker} cannot be read ({error}): it is not known "
                                                       f"whether {state}")
            continue
        not_known(host, since, None, "connections", f"{state}: {said}" if said else state)
    needles = [f'"{address}"' for address in (remote, agent) if address]

    def wanted(record):
        return ((remote is None or record.get("dst") == remote) and (agent is None or record.get("src") == agent)
                and (port is None or record.get("dport") == port))

    for name, local in hosts:
        own_dir = log_dir if local else None
        host_dir = os.path.join(nas_dir, name) if nas_ok else None
        counted_day, plugged = counts_before(own_dir, host_dir, first)
        start_day = next_day(counted_day) if counted_day else first
        names, lost, unreadable = host_index(own_dir, host_dir, days_between(start_day, next_day(last)))
        for day, why in unreadable:
            for what in ("connections", "companies", "names"):
                not_known(name, day_start(day), day_start(day) + DAY, what, why)
        # Every day the node has logs of, here or on the NAS.
        kept = nas_days(host_dir) if host_dir else set()
        kept |= {day for each in (regular_files(own_dir) if own_dir else ()) if (day := file_day(each))}
        earlier = {day for day in kept if day < first}
        if counted_day is None and earlier:
            not_known(name, None, day_start(first), "companies", f"no counts before {first} say who was plugged in")
        # What should be there and is not: a deleted file (its record), a file the node shipped (the node's own
        # records) or counted (any node's counts) that cannot be found.
        for each, record in lost.items():
            if each not in names and kind_of(each) in KIND_WHAT:
                day = day_start(file_day(each))
                span = (day - DAY, day + DAY) if kind_of(each) == "dns" else (day, day + DAY + GRACE)
                not_known(name, *span, KIND_WHAT[kind_of(each)], f"{each} was deleted ({record.get('reason')})")
        expected = set(shipped_records(log_dir)) if local else set()
        for each in [n for n in names if COUNTS.match(n) and file_day(n) in scanned]:
            counts = read_json(names[each]) or {}
            expected |= {p for p in counts.get("parts") or [] if isinstance(p, str)}
            expected |= {p for late in counts.get("late") or [] if isinstance(late, dict)
                         for p in late.get("parts") or [] if isinstance(p, str)}
        for each in sorted(expected):
            if each not in names and each not in lost and kind_of(each) in KIND_WHAT and file_day(each) in scanned:
                day = day_start(file_day(each))
                not_known(name, day, day + DAY, KIND_WHAT[kind_of(each)], f"{each} is not on the node or the NAS")
        through = None
        if not local:
            status = read_json(os.path.join(host_dir, "status.json")) or {}
            try:
                through = parse_time(status["through"])
            except (TypeError, KeyError, ValueError):
                through = None
            if through is None:
                not_known(name, None, None, "connections", "this node has written no status to the NAS: what it has "
                                                           "not shipped is not known")
            elif through < high:
                not_known(name, through, None, "connections", f"this node has shipped nothing since {iso(through)}")
            not_shipped_days = status.get("notShipped") if isinstance(status.get("notShipped"), dict) else {}
            for kind, days in not_shipped_days.items():
                for day in days if kind in KIND_WHAT and isinstance(days, list) else ():
                    if isinstance(day, str) and DAY_NAME.match(day):
                        not_known(name, day_start(day), day_start(day) + DAY, KIND_WHAT[kind],
                                  f"its {kind} of {day} are not on the NAS yet")

        # Who had which address: from the counts' checkpoint on, the client history.
        client_records = list(read_lines([names[each] for day in days_between(start_day, last)
                                          for each in day_names(names, "clients", day)]))
        if any(record.get("event") == "unreadable" for record in client_records):
            not_known(name, None, day_start(last) + DAY, "companies", "a client history line could not be read")
        intervals, _ = attribution_intervals(plugged, [r for r in client_records if r.get("ts") is not None])

        opened, pairs, pause, dns_gaps, beats = {}, [], None, [], []
        cuts = sorted(cut_time(each) for each in [*names, *lost] if DNS_PART.match(each) or DNS_COPY.match(each))
        paths = [names[each] for day in scanned for each in day_names(names, "flows", day)]
        for record in flow_records(paths, needles):
            event, ts = record.get("event"), record.get("ts")
            if event == "unreadable":
                day = file_day(os.path.basename(record["path"])) or first
                not_known(name, day_start(day), day_start(day) + DAY, "connections",
                          f"{record['path']}: {record['error']}")
            elif event == "gap":
                if is_sign(record):
                    beats.append(ts)
                reason = str(record.get("reason"))
                since = record.get("since") if isinstance(record.get("since"), (int, float)) else None
                begun = since if since is not None else record.get("after")
                begun = day_start(first) if begun is None else begun
                if reason.startswith("paused: ") and "DNS record" in reason:
                    # What dnsmasq wrote since the last cut (or since the logger last emptied it): from that cut on.
                    dns_gaps.append((max((cut for cut in cuts if cut <= ts), default=None), ts, reason))
                    if not pause:
                        # Written only while the logger pauses: its pause began before what was read.
                        pause = (None, f"the logger paused before what was read, its line says: {reason}")
                elif reason.startswith("paused: "):
                    if pause:
                        # Two pauses with no "resumed" line between (not written so): the first ran until the second.
                        not_known(name, pause[0], ts, "connections", pause[1])
                    pause = (ts, reason)
                else:
                    if pause and reason == "logger started":
                        # The logger stopped while it paused: its pause ended with it. (A starting logger writes
                        # "logger started" before its own pause line.)
                        not_known(name, pause[0], ts, "connections", pause[1])
                    if reason == "logger started" or reason.startswith("resumed: "):
                        pause = None
                    not_known(name, begun, ts, "connections", reason)
            elif event == "alive":
                beats.append(ts)
            elif event in ("new", "destroy") and wanted(record):
                key = tuple(record.get(field) for field in ("id", "src", "dst", "sport", "dport", "proto"))
                if event == "new":
                    if key in opened:
                        pairs.append((opened[key], None))
                    opened[key] = record
                else:
                    pairs.append((opened.pop(key, None), record))
            elif event == "refused" and wanted(record) and low <= ts <= high:
                who = who_at(intervals, record.get("src"), ts) or {}
                refused.append({"node": name, "at": iso(ts), **{key: who.get(key) for key in WHO},
                                **{key: record.get(key) for key in ("src", "dst", "dport", "proto", "rule")}})
        if pause:
            not_known(name, pause[0], None, "connections", f"{pause[1]} (and not resumed in what was read)")
        # A paused logger empties dns.log every 5 seconds, each time with a gap line: the lines of one pause are one.
        for start, end, reason, lines in merged_spans(dns_gaps):
            not_known(name, start, end, "names", reason if lines == 1 else
                      f"{lines} gap lines say the DNS record was not kept, the last: {reason}")
        # The logger writes an alive line every minute while it logs. A stretch of more than 3 minutes with no line that
        # says it was logging (is_sign), from the node's first log day on, to now or to what it has shipped, is a time it was down, paused
        # or could not write: also when no line read says so (it stopped and has not started again, or its pause or
        # outage began before the days read and ends after them). A node whose first log day is after the days read
        # did not log then: nothing is missed. Each stretch is judged at its full length, so one across the edge of
        # the days read is not cut short: from the logger's last line of the day before (none there: a long one) to
        # its first of the day after (none there: now, or what the node has shipped).
        born = min({day for each in [*names, *lost] if (day := file_day(each))} | kept, default=None)
        known_from = day_start(max(first, born) if born else first)
        known_to = min(now, day_start(last) + DAY, *(() if through is None else (through,)))
        before = None
        if born and born < first:
            earlier, _, _ = host_index(own_dir, host_dir, [next_day(first, -1)])
            before = last_sign([earlier[each] for each in day_names(earlier, "flows", next_day(first, -1))])
            before = known_from - SILENCE if before is None else before
        after = first_sign([names[each] for each in day_names(names, "flows", next_day(last))])
        outer = (known_from if before is None else before,
                 (now if through is None else min(now, through)) if after is None else after)
        for a, b in silences(beats, known_from, known_to, covered.get(name, []) + covered.get("*", []), outer):
            not_known(name, a, b, "connections", "the connection logger wrote no line then (it writes one every "
                                                 "minute while it logs): it was down, paused or could not write")
        pairs += [(began, None) for began in opened.values()]

        found = []
        for began, ended in pairs:
            start, end = (began or {}).get("ts"), (ended or {}).get("ts")
            if (start is not None and start > high) or (end is not None and end < low):
                continue
            # The company that had the address at the time asked, within the connection's own span.
            moment = min(max(at, start if start is not None else at), end if end is not None else at)
            record = began or ended
            who = who_at(intervals, record.get("src"), moment) or {}
            found.append({"node": name, "start": iso(start) if start is not None else None,
                          "end": iso(end) if end is not None else None, "opened": moment if start is None else start,
                          **{key: who.get(key) for key in WHO},
                          **{key: record.get(key) for key in ("src", "sport", "dst", "dport", "proto")},
                          "bytesOut": (ended or {}).get("bytes_out"), "bytesIn": (ended or {}).get("bytes_in"),
                          "name": None})
        if found:
            # The name the machine looked up: the last answer for that address before the connection opened (a DNS
            # part holds the lines before its cut, so the day after the window too).
            dns = sorted(each for each in names if (DNS_PART.match(each) or DNS_COPY.match(each))
                         and first <= file_day(each) <= next_day(last))
            sources = [(names[each], cut_time(each)) for each in dns]
            if local and "dns.log" in names:
                sources.append((names["dns.log"], now))
            answers, bad = resolutions(sources, {c["src"] for c in found}, {c["dst"] for c in found})
            for why in bad:
                not_known(name, low, high, "names", why)
            for c in found:
                before = [n for ts, n in answers.get((c["src"], c["dst"]), []) if ts <= c["opened"] + 1]
                c["name"] = before[-1] if before else None
        connections += found
    for c in connections:
        c.pop("opened")
    connections.sort(key=lambda c: (c["start"] or c["end"] or "", c["node"]))
    return {"schema": "qorpera.agent-exit-lookup/v1",
            "query": {"at": iso(at), "window": window, "remote": remote, "remotePort": port, "agent": agent},
            "read": {"from": first, "to": last}, "nodes": [name for name, _ in hosts], "connections": connections,
            "refused": refused, "unknown": unknown,
            "complete": not any(u["what"] in ("connections", "companies") for u in unknown)}


def print_lookup(result):
    q = result["query"]
    target = " and ".join(part for part in (
        q["remote"] and f"{q['remote']}{':' + str(q['remotePort']) if q['remotePort'] is not None else ''}",
        q["agent"] and f"agent address {q['agent']}") if part)
    print(f"Who used {target} around {q['at']} (within {q['window']:g} seconds). Read {result['read']['from']} to "
          f"{result['read']['to']} on {', '.join(result['nodes'])}.")
    print(f"{len(result['connections'])} connections:" if result["connections"] else "No connection found.")
    for c in result["connections"]:
        who = (f"company {c['company']}, {c['kind'] or 'machine'} {c['machine']}" + (f", member {c['member']}" if
               c["member"] else "")) if c["company"] else "no company known for the address then"
        port = f":{c['dport']}" if c["dport"] is not None else ""
        print(f"  {c['start'] or 'start not read'} to {c['end'] or 'end not read'} on {c['node']}: {who}; "
              f"{c['src']}:{c['sport']} to {c['dst']}{port} {c['proto']}"
              + (f", looked up as {c['name']}" if c["name"] else "")
              + (f"; {c['bytesOut']} bytes out, {c['bytesIn']} in" if c["bytesOut"] is not None else ""))
    if result["refused"]:
        print(f"{len(result['refused'])} refused:")
        for r in result["refused"]:
            print(f"  {r['at']} on {r['node']}: company {r['company']}, machine {r['machine']}; {r['src']} to "
                  f"{r['dst']}{':' + str(r['dport']) if r['dport'] is not None else ''} {r['proto']} ({r['rule']})")
    if result["unknown"]:
        print("Not known (the logs cannot say what happened here; it never means no one):")
        for u in result["unknown"]:
            print(f"  {u['node']}, {u['from'] or 'before what was read'} to {u['to'] or 'now'}: {u['what']}: {u['why']}")
    print("The answer is complete." if result["complete"] else
          "The answer is NOT complete: connections or companies are not known for part of the time (above).")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("tend", "count", "report", "ship", "lookup"))
    parser.add_argument("--log-dir", required=True)
    parser.add_argument("--status")
    parser.add_argument("--nas-dir", default="")
    parser.add_argument("--host", default=socket.gethostname())
    parser.add_argument("--at")
    parser.add_argument("--window", type=float, default=300.0)
    parser.add_argument("--days", dest="margin", type=int, default=1)
    parser.add_argument("--remote")
    parser.add_argument("--remote-port", type=int)
    parser.add_argument("--agent")
    parser.add_argument("--heartbeat")
    parser.add_argument("--pause-file")
    parser.add_argument("--failing-file")
    parser.add_argument("--cap-bytes", type=int, default=CAP_BYTES)
    parser.add_argument("--floor-percent", type=float, default=FLOOR_PERCENT)
    parser.add_argument("--day")
    parser.add_argument("--from", dest="start")
    parser.add_argument("--to", dest="end")
    parser.add_argument("--json", action="store_true")
    # Tests: a fixed clock, smaller parts, no wait for lines in flight, the disk's free share, and a NAS folder that is
    # not a mount point.
    parser.add_argument("--now", type=float)
    parser.add_argument("--part-bytes", type=int, default=PART_BYTES)
    parser.add_argument("--settle", type=float, default=SETTLE_SECONDS)
    parser.add_argument("--free-percent", type=float)
    parser.add_argument("--nas-any-folder", action="store_true")
    args = parser.parse_args()
    if not HOST_NAME.match(args.host):
        parser.error(f"--host {args.host!r} is not a host name")
    if args.nas_dir and not os.path.isabs(args.nas_dir):
        parser.error("--nas-dir must be an absolute path")
    if args.command == "ship":
        if not args.status:
            parser.error("ship needs --status")
        result = ship(args.log_dir, args.nas_dir, args.status, args.host, args.now, not args.nas_any_folder)
        if result is None:
            print("qorpera-agent-exit-logs: another pass is running", file=sys.stderr)
            return
        print(json.dumps(result, sort_keys=True))
        sys.exit(1 if result["problems"] else 0)
    if args.command == "lookup":
        if not (args.remote or args.agent):
            parser.error("lookup needs --remote or --agent")
        if not args.at:
            parser.error("lookup needs --at (an ISO time, UTC unless it says otherwise, or seconds since the epoch)")
        try:
            at = parse_time(args.at)
        except ValueError:
            parser.error(f"--at {args.at!r} is not a time")
        if args.window < 0 or not 0 <= args.margin <= KEEP_DAYS:
            parser.error(f"--window must be 0 or more and --days between 0 and {KEEP_DAYS}")
        now = time.time() if args.now is None else args.now
        result = lookup(args.log_dir, args.nas_dir, args.host, at, args.window, args.margin, args.remote,
                        args.remote_port, args.agent, now, args.heartbeat, args.pause_file, args.failing_file,
                        not args.nas_any_folder)
        if args.json:
            print(json.dumps(result, indent=2))
        else:
            print_lookup(result)
        return
    if args.command == "tend":
        if not args.status:
            parser.error("tend needs --status")
        if args.cap_bytes < 1 or not 0 <= args.floor_percent < 100:
            parser.error("--cap-bytes must be positive and --floor-percent between 0 and 100")
        os.makedirs(args.log_dir, mode=0o750, exist_ok=True)
        free = free_percent if args.free_percent is None else (lambda _log_dir: args.free_percent)
        result = tend(args.log_dir, args.status, args.cap_bytes, args.floor_percent, args.now, args.part_bytes,
                      args.settle, free)
        if result is None:
            print("qorpera-agent-exit-logs: another pass is running", file=sys.stderr)
            return
        print(json.dumps(result, sort_keys=True))
        sys.exit(1 if result["problems"] else 0)
    if args.command == "count":
        if not args.day:
            parser.error("count needs --day")
        saved = read_counts(args.log_dir, args.day)
        if saved is not None:
            # A counted day never changes.
            print(json.dumps(saved | {"deletedEarly": deleted_early(args.log_dir).get(args.day, 0)}, indent=2))
            return
        files = regular_files(args.log_dir)
        through, plugged = checkpoint(args.log_dir, files)
        partial = through is None or through >= args.day
        # Who was plugged in when the day began: from the checkpoint on, or replayed from the oldest client history.
        day = first_day(args.log_dir, files, ("clients",)) if partial else next_day(through)
        if partial:
            plugged = {}
        while day is not None and day < args.day:
            plugged = advance(args.log_dir, day, plugged, files)
            day = next_day(day)
        counts, _, _ = count_day(args.log_dir, args.day, plugged, files)
        print(json.dumps({"schema": "qorpera.agent-exit-counts/v1", "day": args.day, "attributionPartial": partial,
                          "deletedEarly": deleted_early(args.log_dir).get(args.day, 0), **counts}, indent=2))
        return
    report(args.log_dir, args.start, args.end, args.json)


if __name__ == "__main__":
    main()
