#!/usr/bin/env python3
"""Qorpera agent exit: the logs on the node (E3, its node half) and the line guard's counts (E7, counting only).

The exit writes its logs on the node's own disk, in <log-dir> (/var/log/qorpera-agent-exit): the connection log
flows-YYYY-MM-DD.jsonl (the logger), the client history clients-YYYY-MM-DD.jsonl (the agent plug) and dns.log (dnsmasq).
`tend` runs every 5 minutes (qorpera-agent-exit-logs.timer, root) and keeps them small and safe for the node:
- it seals each open file into a compressed part (<kind>-YYYY-MM-DD.pNNN.jsonl.gz) once its day is closed, or sooner
  once it holds 64 MiB. A day is closed two hours after it ends (UTC): the plug's "plugged" lines carry the entry's
  time, at most an hour back. The writers open the file for each line, so a renamed file takes no new lines;
- it copies dns.log into dns-YYYY-MM-DDTHHMMSSZ.log.gz and truncates it once a day, or sooner once it holds 64 MiB
  (dnsmasq appends, so it writes on from the start; a line written in the moment between the copy and the truncate
  is lost);
- it counts each closed day, per company, from that day's parts (counts-YYYY-MM-DD.json): the line guard's numbers
  (RUNTIME-AGENT-EXIT.md §8: new connections, refusals, bursts and failed connections to many addresses), which the
  founder reads (`report`) to set the brake's levels. Counting never slows or refuses anything;
- it keeps 90 days, and deletes the oldest sealed parts first while the logs hold more than 80% of their cap (2 GiB
  unless set) or the disk has less than its floor (10% unless set) plus 5 points free: the connection log and the DNS
  record before the client history, which is small and ties addresses to companies. The open files are never
  deleted. Each deleted file is a line in lost.jsonl (its day is unknown to a lookup from then on).
<run-dir>/logs.json says when it last ran and what it could not do; `qorpera-agent-exit.sh verify` fails while it is
older than 15 minutes or names a problem (the logs still over their cap, or the disk under its floor, with every
sealed part gone). The logger pauses by itself at the same two lines (qorpera-agent-exit-log.py), and the exit is
unhealthy while it does, so the node takes no new agent road machines and its disk never fills. Shipping to the NAS and the
"who used this address" lookup come with E3.

An address belongs to a company from its "plugged" line to its "unplugged" one. attribution.json carries the
addresses still plugged in from one counted day to the next, so a machine plugged in long ago keeps its company after
its plugged line is gone. Traffic from an address with no company at that moment counts as "unattributed".

  qorpera-agent-exit-logs.py tend --log-dir DIR --status FILE [--cap-bytes N] [--floor-percent P] [--now T]
  qorpera-agent-exit-logs.py count --log-dir DIR --day YYYY-MM-DD   (a day's counts from what is there; writes nothing)
  qorpera-agent-exit-logs.py report --log-dir DIR [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--json]
"""

import argparse
import bisect
import datetime
import fcntl
import gzip
import json
import os
import re
import shutil
import socket
import sys
import time

DAY = 86400
# A day is closed two hours after it ends: the plug's "plugged" line carries its entry's time, at most an hour back.
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
SEALING = re.compile(r"^(flows|clients)-(\d{4}-\d{2}-\d{2})\.sealing$")
PART = re.compile(r"^(flows|clients)-(\d{4}-\d{2}-\d{2})\.p(\d{3,})\.jsonl\.gz$")
DNS_PART = re.compile(r"^dns-(\d{4}-\d{2}-\d{2})T\d{6}Z\.log\.gz$")
COUNTS = re.compile(r"^counts-(\d{4}-\d{2}-\d{2})\.json$")
TEMPORARY = re.compile(r"^\..+\.tmp$")


def day_of(ts):
    return time.strftime("%Y-%m-%d", time.gmtime(ts))


def day_start(day):
    return datetime.datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=datetime.UTC).timestamp()


def next_day(day, step=1):
    return day_of(day_start(day) + step * DAY)


def iso(ts):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


def write_atomic(path, data, mode=0o640):
    tmp = os.path.join(os.path.dirname(path), f".{os.path.basename(path)}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC, mode)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def write_json(path, value, mode=0o640):
    write_atomic(path, (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode(), mode)


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


def next_part(log_dir, kind, day):
    numbers = [int(m.group(3)) for name in regular_files(log_dir) if (m := PART.match(name)) and m.group(1) == kind
               and m.group(2) == day]
    return max(numbers, default=0) + 1


def seal_files(log_dir, now, part_bytes, settle=SETTLE_SECONDS):
    """Seals each open file whose day is closed or which holds `part_bytes`, and any left half sealed by a crash."""
    files = regular_files(log_dir)
    sealing = [(m.group(1), m.group(2)) for name in files if (m := SEALING.match(name))]
    for name, size in files.items():
        m = OPEN.match(name)
        if not m or (kind_day := (m.group(1), m.group(2))) in sealing:
            continue
        if now >= day_start(m.group(2)) + DAY + GRACE or size >= part_bytes:
            os.rename(os.path.join(log_dir, name), os.path.join(log_dir, f"{m.group(1)}-{m.group(2)}.sealing"))
            sealing.append(kind_day)
    if sealing:
        time.sleep(settle)
    for kind, day in sorted(sealing):
        source = os.path.join(log_dir, f"{kind}-{day}.sealing")
        compress(source, os.path.join(log_dir, f"{kind}-{day}.p{next_part(log_dir, kind, day):03d}.jsonl.gz"))
        os.unlink(source)
    return len(sealing)


def rotate_dns(log_dir, now, part_bytes):
    """Copies dns.log into a compressed part and truncates it, once a day or once it holds `part_bytes`."""
    path = os.path.join(log_dir, "dns.log")
    marker = os.path.join(log_dir, ".dns-rotated")
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
    compress(path, os.path.join(log_dir, f"dns-{time.strftime('%Y-%m-%dT%H%M%SZ', time.gmtime(now))}.log.gz"))
    os.truncate(path, 0)
    write_atomic(marker, f"{day_of(now)}\n".encode())
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
    """A day's parts in order, then its open or half-sealed file (for a day that is not closed yet)."""
    files = regular_files(log_dir) if files is None else files
    parts = sorted((int(m.group(3)), name) for name in files if (m := PART.match(name)) and m.group(1) == kind
                   and m.group(2) == day)
    paths = [os.path.join(log_dir, name) for _, name in parts]
    for name in (f"{kind}-{day}.sealing", f"{kind}-{day}.jsonl"):
        if name in files:
            paths.append(os.path.join(log_dir, name))
    return paths


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


def count_day(log_dir, day, start, files=None):
    """The line guard's numbers for `day`, per company, and who is still plugged in when it ends."""
    files = regular_files(log_dir) if files is None else files
    client_records = list(read_lines(day_files(log_dir, "clients", day, files)))
    intervals, end = attribution_intervals(start, [r for r in client_records if r.get("ts") is not None])
    companies = {}
    node = {"records": 0, "gaps": 0, "gapReasons": {}, "unreadableLines": 0}
    machine_buckets = {}
    failed_windows = {}

    def company(who):
        key = who.get("company") if who and isinstance(who.get("company"), str) else "unattributed"
        if key not in companies:
            companies[key] = {"machines": set(), "connections": 0, "byProto": {}, "buckets": {}, "refused": 0,
                              "refusedByRule": {}, "unanswered": 0, "failed": set(), "failedPast": 0,
                              "peakFailed60s": 0, "peakFailed60sAt": None}
        return key, companies[key]

    def failed(key, entry, ts, dst):
        if dst not in entry["failed"]:
            if len(entry["failed"]) < DESTINATIONS_KEPT:
                entry["failed"].add(dst)
            else:
                entry["failedPast"] += 1
        window = failed_windows.setdefault(key, {})
        minute = int(ts // 60)
        window.setdefault(minute, set()).add(dst)
        for old in [m for m in window if m < minute - 1]:
            size = len(window.pop(old))
            if size > entry["peakFailed60s"]:
                entry["peakFailed60s"], entry["peakFailed60sAt"] = size, iso(old * 60)

    for record in read_lines(day_files(log_dir, "flows", day, files)):
        event = record.get("event")
        if event == "unreadable":
            node["unreadableLines"] += record["count"]
            continue
        node["records"] += 1
        if event == "gap":
            node["gaps"] += 1
            reason = normalised(record.get("reason"))
            node["gapReasons"][reason] = node["gapReasons"].get(reason, 0) + 1
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
            "failedDestinations": len(entry["failed"]) + entry["failedPast"],
            "failedDestinationsAtLeast": entry["failedPast"] > 0,
            "peakFailedDestinations60s": entry["peakFailed60s"],
            "peakFailedDestinations60sAt": entry["peakFailed60sAt"],
        }
    return {"companies": dict(sorted(result.items())), "node": node}, end


def advance(log_dir, day, start, files=None):
    """Who is plugged in when `day` ends, from who was when it began and the day's client history alone."""
    files = regular_files(log_dir) if files is None else files
    events = [r for r in read_lines(day_files(log_dir, "clients", day, files)) if r.get("ts") is not None]
    return attribution_intervals(start, events)[1]


def lost_on(log_dir, day):
    path = os.path.join(log_dir, "lost.jsonl")
    lost = 0
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    lost += json.loads(line).get("day") == day
                except ValueError:
                    continue
    except FileNotFoundError:
        pass
    return lost


def load_attribution(log_dir):
    try:
        with open(os.path.join(log_dir, "attribution.json"), encoding="utf-8") as f:
            value = json.load(f)
        if isinstance(value.get("through"), str) and isinstance(value.get("open"), dict):
            return value["through"], value["open"]
    except (OSError, ValueError, AttributeError):
        pass
    return None, {}


def first_day(log_dir, files):
    days = [m.group(2) for name in files if (m := OPEN.match(name) or SEALING.match(name) or PART.match(name))]
    return min(days, default=None)


def count_closed_days(log_dir, now, host):
    """Counts each closed day after the last one counted, in order, and carries who is plugged in from day to day."""
    files = regular_files(log_dir)
    through, plugged = load_attribution(log_dir)
    day = next_day(through) if through else first_day(log_dir, files)
    counted = 0
    while day is not None and now >= day_start(day) + DAY + GRACE:
        counts, plugged = count_day(log_dir, day, plugged, files)
        counts["node"]["lostFiles"] = lost_on(log_dir, day)
        write_json(os.path.join(log_dir, f"counts-{day}.json"),
                   {"schema": "qorpera.agent-exit-counts/v1", "day": day, "host": host, "countedAt": iso(now), **counts})
        write_json(os.path.join(log_dir, "attribution.json"),
                   {"schema": "qorpera.agent-exit-attribution/v1", "through": day, "open": plugged})
        counted += 1
        day = next_day(day)
    return counted


def file_day(name):
    for pattern, group in ((PART, 2), (DNS_PART, 1), (COUNTS, 1), (OPEN, 2), (SEALING, 2)):
        m = pattern.match(name)
        if m:
            return m.group(group)
    return None


def record_lost(log_dir, now, name, size, reason):
    line = json.dumps({"ts": now, "file": name, "bytes": size, "day": file_day(name), "reason": reason},
                      sort_keys=True, separators=(",", ":"))
    fd = os.open(os.path.join(log_dir, "lost.jsonl"), os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o640)
    with os.fdopen(fd, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def tidy(log_dir, now, cap, floor, free=free_percent):
    """Deletes what is older than 90 days, then the oldest sealed parts while the logs are over 80% of their cap or
    the disk has less than the floor plus 5 points free. Returns what it deleted, and whether, after that, the logs
    are still over their cap or the disk under the floor: the lines where the logger pauses."""
    deleted = []
    files = regular_files(log_dir)
    oldest_kept = day_of(now - KEEP_DAYS * DAY)
    for name in sorted(files):
        day = file_day(name)
        if day is not None and day < oldest_kept and not OPEN.match(name) and not SEALING.match(name):
            os.unlink(os.path.join(log_dir, name))
            record_lost(log_dir, now, name, files[name], f"kept {KEEP_DAYS} days")
            deleted.append(name)
    files = regular_files(log_dir)
    # Oldest first; the connection log and the DNS record before the client history, which ties addresses to companies.
    candidates = sorted(
        (name for name in files if PART.match(name) or DNS_PART.match(name)),
        key=lambda name: (name.startswith("clients-"), file_day(name), name),
    )
    low_water = floor + LOW_WATER_MARGIN
    for name in candidates:
        total = sum(files.values())
        if total <= cap * CAP_SHARE and free(log_dir) >= low_water:
            break
        reason = "over the cap" if total > cap * CAP_SHARE else "the disk is low"
        os.unlink(os.path.join(log_dir, name))
        record_lost(log_dir, now, name, files.pop(name), reason)
        deleted.append(name)
    still = sum(regular_files(log_dir).values()) > cap or free(log_dir) < floor
    return deleted, still


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
        except Exception as error:  # noqa: BLE001 - every step is tried; a failure is a problem, never the end
            result[key] = None
            # A failed count is reported but never makes the exit unhealthy: only the disk's safety does.
            (result.setdefault("countProblems", []) if key == "daysCounted" else problems).append(
                f"{key}: {error}"[:300])
            print(f"qorpera-agent-exit-logs: {key}: {error}", file=sys.stderr, flush=True)
    try:
        deleted, still = tidy(log_dir, now, cap, floor, free)
        result["deleted"] = len(deleted)
        if still:
            problems.append("the logs are over their cap, or the disk under its floor, with every sealed part deleted")
    except Exception as error:  # noqa: BLE001
        problems.append(f"tidy: {error}"[:300])
        print(f"qorpera-agent-exit-logs: tidy: {error}", file=sys.stderr, flush=True)
    try:
        result["bytes"] = sum(regular_files(log_dir).values())
        result["freePercent"] = round(free(log_dir), 1)
    except OSError as error:
        problems.append(f"cannot read the log folder: {error}"[:300])
    result["problems"] = problems
    write_json(status, result, 0o644)
    return result


def report(log_dir, start, end, as_json):
    days = sorted(m.group(1) for name in regular_files(log_dir) if (m := COUNTS.match(name)) and
                  (start is None or m.group(1) >= start) and (end is None or m.group(1) <= end))
    companies = {}
    node = {"days": len(days), "gaps": 0, "lostFiles": 0, "unreadableLines": 0}
    for day in days:
        with open(os.path.join(log_dir, f"counts-{day}.json"), encoding="utf-8") as f:
            counts = json.load(f)
        for key in ("gaps", "lostFiles", "unreadableLines"):
            node[key] += counts["node"].get(key, 0)
        for company, c in counts["companies"].items():
            total = companies.setdefault(company, {"days": 0, "connections": 0, "maxConnectionsDay": 0, "maxMachines": 0,
                                                   "peakNew10s": 0, "peakNew10sOneMachine": 0, "refused": 0,
                                                   "unanswered": 0, "peakFailedDestinations60s": 0})
            total["days"] += 1
            total["connections"] += c["connections"]
            total["maxConnectionsDay"] = max(total["maxConnectionsDay"], c["connections"])
            total["maxMachines"] = max(total["maxMachines"], c["machines"])
            for key in ("peakNew10s", "peakNew10sOneMachine", "peakFailedDestinations60s"):
                total[key] = max(total[key], c[key])
            total["refused"] += c["refused"]
            total["unanswered"] += c["unanswered"]
    result = {"from": days[0] if days else start, "to": days[-1] if days else end, "node": node,
              "companies": dict(sorted(companies.items(), key=lambda item: -item[1]["connections"]))}
    if as_json:
        print(json.dumps(result, indent=2, sort_keys=False))
        return
    print(f"Agent exit counts on {socket.gethostname()}, {result['from']} to {result['to']}: {node['days']} days counted, "
          f"{node['gaps']} gap lines, {node['lostFiles']} files deleted early.")
    print("Per company: days with traffic, new connections (all days, busiest day), most machines on a day, the most new")
    print("connections in 10 seconds (the company, one machine), refused, unanswered, the most failed destinations in")
    print("one minute.")
    header = ("company", "days", "conns", "busiest", "machines", "peak10s", "machine10s", "refused", "unanswered",
              "failed60s")
    print("  ".join(f"{h:>10}" if i else f"{h:<36}" for i, h in enumerate(header)))
    for company, t in result["companies"].items():
        row = (company, t["days"], t["connections"], t["maxConnectionsDay"], t["maxMachines"], t["peakNew10s"],
               t["peakNew10sOneMachine"], t["refused"], t["unanswered"], t["peakFailedDestinations60s"])
        print("  ".join(f"{v:>10}" if i else f"{v:<36}" for i, v in enumerate(row)))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("tend", "count", "report"))
    parser.add_argument("--log-dir", required=True)
    parser.add_argument("--status")
    parser.add_argument("--cap-bytes", type=int, default=CAP_BYTES)
    parser.add_argument("--floor-percent", type=float, default=FLOOR_PERCENT)
    parser.add_argument("--day")
    parser.add_argument("--from", dest="start")
    parser.add_argument("--to", dest="end")
    parser.add_argument("--json", action="store_true")
    # Tests: a fixed clock, smaller parts, no wait for lines in flight, and the disk's free share.
    parser.add_argument("--now", type=float)
    parser.add_argument("--part-bytes", type=int, default=PART_BYTES)
    parser.add_argument("--settle", type=float, default=SETTLE_SECONDS)
    parser.add_argument("--free-percent", type=float)
    args = parser.parse_args()
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
        through, plugged = load_attribution(args.log_dir)
        files = regular_files(args.log_dir)
        partial = False
        if through is None or through >= args.day:
            # No carried state for this day: replay every client history there is before it.
            plugged, partial, day = {}, True, first_day(args.log_dir, files)
        else:
            day = next_day(through)
        while day is not None and day < args.day:
            plugged = advance(args.log_dir, day, plugged, files)
            day = next_day(day)
        counts, _ = count_day(args.log_dir, args.day, plugged, files)
        counts["node"]["lostFiles"] = lost_on(args.log_dir, args.day)
        print(json.dumps({"schema": "qorpera.agent-exit-counts/v1", "day": args.day, "attributionPartial": partial,
                          **counts}, indent=2))
        return
    report(args.log_dir, args.start, args.end, args.json)


if __name__ == "__main__":
    main()
