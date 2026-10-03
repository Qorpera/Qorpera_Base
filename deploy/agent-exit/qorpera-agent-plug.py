#!/usr/bin/env python3
"""Qorpera agent exit (E2): the agent plug and its client map.

A machine creator (the coding executor, the office units: members of group qorpera-agent-plug) calls `plug` before it
creates a machine that plugs into the agents' bridge qagent0. `plug` gives the machine the lowest free address in
10.210.0.0/16 outside 10.210.0.0/24 (kept for the exit's own services) and a MAC made from all four bytes of it, and
writes two files:
- the client map entry clients/<address>.json (address, MAC, kind, company, machine, member, LXD project and
  instance, since), created exclusively, so two creators never get the same address;
- dnsmasq's static lease dhcp-hosts/<address> ("mac,address"), which dnsmasq reads by itself.
The machine's LXD card then carries both: nictype bridged, parent qagent0, hwaddr, ipv4.address, ipv6.address none,
MAC and IPv6 filtering and port isolation, and not LXD's IPv4 filtering (its forward chain has no DHCP exception, so on
a bridge LXD does not manage it drops every DHCP request on its way to the exit). The exit's own bridge rules
(qorpera-agent-exit-bridge.nft) tie each port to its MAC and each MAC to its address instead: a set of LXD ports and
their MACs, a set of MAC and address pairs, and one DHCP rule per machine (its own MAC, naming itself). Only entries
LXD backs get into them: a claim LXD does not back gets no traffic at all.

A creator calls `plug` right before each create, after the old instance (if any) is gone, and never reuses an address
it stored: `plug` is the only source of a machine's address. A repeated `plug` for the
same instance returns its entry, with a new time when the machine it was given to has been seen (it is being made
again).

The reconciler (root, the plug unit) reads LXD every few seconds and keeps the map true:
- a machine that stopped (asleep) keeps its address and its entry, and its connections are flushed once;
- a machine that is gone (missing from two reads of LXD in a row after it was seen, or never created within an hour of
  its plug) is unplugged under the plug lock: its address is quarantined for 15 minutes first, then its lease is
  removed (dnsmasq reloads), its connections and the exit's per-machine counts are cleared, and its entry is removed;
- every entry is checked against its machine's LXD config, a running machine's card must be a port of qagent0, and
  every machine on qagent0 must have an entry. Anything else is a problem, and a problem makes the exit unhealthy
  (`qorpera-agent-exit.sh verify` reads <run-dir>/plug.json);
- the bridge rules (the ports and pairs sets and the per-machine DHCP rules) are kept equal to the entries LXD backs.
Flushing covers both connection tables: the exit's own, and the node's masqueraded twin of each connection (phase 1).
A flush that fails is tried again every pass, and its address is not given out until it succeeds.

Creators write the entries, so an entry is only a claim until the reconciler has matched it with LXD. The history,
<log-dir>/clients-YYYY-MM-DD.jsonl, ties an address to a company only for a matched entry: "plugged" (at the entry's
time) once it matches, "unplugged" when it goes. An entry that does not match gets a "mismatch" line with the claim,
what LXD says and the problems (again whenever they change), and is never "plugged"; one that goes without ever
matching gets "dropped". A machine on qagent0 without an entry gets an "unattributed" line. So the log stays honest
also against a forged entry, and an address stays tied to its company as long as the flow log is kept.

  qorpera-agent-plug.py plug --kind K --company C --machine M [--member U] --project P --instance I
  qorpera-agent-plug.py list
  qorpera-agent-plug.py elements                      (nft statements that fill the bridge rules for `up`)
  qorpera-agent-plug.py reconcile [--once]            (root)
  qorpera-agent-plug.py --parse-conntrack             (test: stdin conntrack -L lines; stdout: twins as JSON lines)
"""

import argparse
import datetime
import fcntl
import http.client
import ipaddress
import json
import os
import re
import secrets
import socket
import stat
import subprocess
import sys
import time

AGENTS = ipaddress.ip_network("10.210.0.0/16")
# The exit (10.210.0.1) and any later service of its own live here; machines never get one of these.
RESERVED = ipaddress.ip_network("10.210.0.0/24")
BRIDGE = "qagent0"
EXIT_TABLE = ("inet", "qorpera_agent_exit")
BRIDGE_TABLE = ("bridge", "qorpera_agent_exit_bridge")
# The exit's per-machine sets: a machine's counts and refused flows go with it.
EXIT_SETS = ("new_by_client", "refused_by_client", "open_by_client", "refusal_rate", "refused_flows", "refused_other")
# The exit's side of its uplink: in phase 1 the node masquerades it, so each agent connection has a twin on the node.
UPLINK = "10.209.255.2"
KINDS = ("machine", "coding", "office")
# The LXD key that names each kind's machine (the creators set it; company-machine.ts, coding-machine.ts,
# lxd-office-guest.ts).
MACHINE_KEY = {
    "machine": "user.qorpera.machine_id",
    "coding": "user.qorpera.machine_id",
    "office": "user.qorpera.office_id",
}
QUARANTINE_SECONDS = 15 * 60
# A plug whose machine never appears in LXD is given up after this long.
PENDING_SECONDS = 60 * 60
# Temporary files older than this in the creators' folders are left from a crash and removed.
STALE_TMP_SECONDS = 10 * 60
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
LXD_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,62}$")
PLUG_NIC = {
    "type": "nic",
    "nictype": "bridged",
    "parent": BRIDGE,
    "ipv6.address": "none",
    "security.mac_filtering": "true",
    "security.ipv6_filtering": "true",
    "security.port_isolation": "true",
}


def now_iso(ts=None):
    moment = datetime.datetime.fromtimestamp(time.time() if ts is None else ts, datetime.UTC)
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(text):
    return datetime.datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.UTC).timestamp()


def hwaddr_for(address):
    """The MAC of the machine at this address: locally administered, unicast, then the address's four bytes."""
    return "0e:51:%02x:%02x:%02x:%02x" % tuple(ipaddress.ip_address(address).packed)


def candidates():
    """Every address a machine may get, lowest first: outside the reserved /24, no .0 or .255 host."""
    for address in AGENTS.hosts():
        if address in RESERVED or address.packed[3] in (0, 255):
            continue
        yield str(address)


class Paths:
    def __init__(self, state_dir, run_dir, log_dir):
        # Written by creators (group qorpera-agent-plug, setgid and sticky):
        self.clients = os.path.join(state_dir, "clients")
        self.dhcp = os.path.join(state_dir, "dhcp-hosts")
        self.lock = os.path.join(state_dir, "plug.lock")
        # The reconciler's alone (root, 0755): creators only read them.
        self.quarantine = os.path.join(state_dir, "quarantine")
        self.seen = os.path.join(state_dir, "seen")
        self.verified = os.path.join(state_dir, "verified")
        self.run_dir = run_dir
        self.stopped = os.path.join(run_dir, "plug-stopped")
        self.missing = os.path.join(run_dir, "plug-missing")
        self.unflushed = os.path.join(run_dir, "plug-unflushed")
        self.noted = os.path.join(run_dir, "plug-noted")
        self.status = os.path.join(run_dir, "plug.json")
        self.log_dir = log_dir

    def entry(self, address):
        return os.path.join(self.clients, f"{address}.json")

    def root_dirs(self):
        return (self.quarantine, self.seen, self.verified, self.stopped, self.missing, self.unflushed, self.noted)


def read_file(path, limit=65536):
    """A regular file's text, never through a link and never blocking (the creators' folders are group-writable, so a
    link or a FIFO there must not lead the reconciler anywhere)."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("not a regular file")
        data = os.read(fd, limit + 1)
    finally:
        os.close(fd)
    if len(data) > limit:
        raise ValueError("too large")
    return data.decode("utf-8")


def _write_tmp(directory, name, text, mode):
    """A new temporary file in directory: a hidden, random name (dnsmasq skips hidden files), created exclusively and
    never through a link, with exactly this mode whatever the caller's umask."""
    tmp = os.path.join(directory, f".tmp-{name}-{os.getpid()}-{secrets.token_hex(8)}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, mode)
    try:
        os.fchmod(fd, mode)
        os.write(fd, text.encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)
    return tmp


def write_new(directory, name, text, mode=0o644):
    """Create directory/name all at once, only if it does not exist yet (link() fails on an existing name), so a
    reader never sees half a file and two writers never share one."""
    tmp = _write_tmp(directory, name, text, mode)
    try:
        os.link(tmp, os.path.join(directory, name))
    finally:
        os.unlink(tmp)


def write_replace(path, text, mode=0o644):
    tmp = _write_tmp(os.path.dirname(path), os.path.basename(path), text, mode)
    os.replace(tmp, path)


def remove(path):
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass


def entry_problem(entry):
    """What makes an entry unusable, or None. Nothing in it is trusted unchecked."""
    if not isinstance(entry, dict) or entry.get("schema") != "qorpera.agent-plug/v1":
        return "unknown schema"
    try:
        address = ipaddress.ip_address(entry.get("address"))
        if address not in AGENTS:
            return "the address is not in the agents' range"
        if address in RESERVED:
            return "the address is kept for the exit's own services"
        if address.packed[3] in (0, 255):
            return "the address is a .0 or .255 host"
    except ValueError:
        return "the address is not an address"
    if entry.get("hwaddr") != hwaddr_for(entry["address"]):
        return "the MAC is not the address's"
    if entry.get("kind") not in KINDS:
        return "unknown kind"
    for key in ("company", "machine") + (("member",) if entry["kind"] == "coding" else ()):
        if not isinstance(entry.get(key), str) or not ID.match(entry[key]):
            return f"{key} is not an id"
    if entry["kind"] != "coding" and entry.get("member") is not None:
        return "only a coding machine names a member"
    for key in ("project", "instance"):
        if not isinstance(entry.get(key), str) or not LXD_NAME.match(entry[key]):
            return f"{key} is not an LXD name"
    try:
        if parse_iso(entry.get("since")) > time.time() + 300:
            return "since is in the future"
    except (TypeError, ValueError):
        return "since is not a time"
    return None


def read_entry(path, address):
    entry = json.loads(read_file(path))
    problem = entry_problem(entry)
    if problem:
        raise ValueError(problem)
    if entry["address"] != address:
        raise ValueError("the address does not match the file name")
    return entry


def read_entries(paths):
    """{address: entry} for every usable client map entry, and the problems with the others."""
    entries, broken = {}, []
    for name in sorted(os.listdir(paths.clients)):
        if name.startswith(".") or not name.endswith(".json"):
            continue
        try:
            address = name[: -len(".json")]
            entries[address] = read_entry(os.path.join(paths.clients, name), address)
        except (OSError, ValueError, UnicodeDecodeError, RecursionError) as error:
            broken.append(f"{name}: {error}"[:300])
    return entries, broken


def held(paths, address, at):
    """True when the address may not be given out: quarantined, still owned by a machine the reconciler tracks, or
    waiting for a flush."""
    if os.path.lexists(os.path.join(paths.seen, address)) or os.path.lexists(os.path.join(paths.unflushed, address)):
        return True
    try:
        return json.loads(read_file(os.path.join(paths.quarantine, address))).get("until", 0) > at
    except FileNotFoundError:
        return False
    except (OSError, ValueError, AttributeError):
        # An unreadable quarantine file keeps the address out of use; the reconciler replaces or removes it.
        return True


def seen_since(paths, address):
    """The time of the entry whose machine the reconciler saw at this address, or None."""
    try:
        return json.loads(read_file(os.path.join(paths.seen, address))).get("since")
    except (OSError, ValueError, AttributeError):
        return None


def lock(paths):
    # flock needs no write access: every creator can take the lock, whoever made the file.
    fd = os.open(paths.lock, os.O_RDONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644)
    fcntl.flock(fd, fcntl.LOCK_EX)
    return fd


def plug(paths, kind, company, machine, member, project, instance):
    if kind not in KINDS:
        raise SystemExit(f"kind must be one of {', '.join(KINDS)}")
    for label, value in (("company", company), ("machine", machine)) + ((("member", member),) if member else ()):
        if not ID.match(value):
            raise SystemExit(f"{label} is not an id: {value!r}")
    if (kind == "coding") != bool(member):
        raise SystemExit("a coding machine names its member, and only a coding machine does")
    for label, value in (("project", project), ("instance", instance)):
        if not LXD_NAME.match(value):
            raise SystemExit(f"{label} is not an LXD name: {value!r}")
    fd = lock(paths)
    try:
        entries, _ = read_entries(paths)
        at = time.time()
        for entry in entries.values():
            if (entry["project"], entry["instance"]) != (project, instance):
                continue
            wanted = {"kind": kind, "company": company, "machine": machine, "member": member}
            if any(entry.get(key) != value for key, value in wanted.items()):
                raise SystemExit(f"{project}/{instance} is already plugged in for another machine ({entry['address']})")
            if seen_since(paths, entry["address"]) == entry["since"]:
                # Its machine was seen, and the creator plugs it again: the machine is being made again. A new time
                # tells the reconciler that this entry's machine is a new one, so it is not unplugged as gone.
                entry = dict(entry, since=now_iso(max(at, parse_iso(entry["since"]) + 1)))
                try:
                    write_replace(paths.entry(entry["address"]), json.dumps(entry, sort_keys=True) + "\n")
                except PermissionError:
                    raise SystemExit(f"{project}/{instance}'s entry belongs to another creator") from None
            ensure_lease(paths, entry)
            return entry
        for address in candidates():
            if address in entries or held(paths, address, at):
                continue
            entry = {
                "schema": "qorpera.agent-plug/v1",
                "address": address,
                "hwaddr": hwaddr_for(address),
                "kind": kind,
                "company": company,
                "machine": machine,
                "member": member,
                "project": project,
                "instance": instance,
                "since": now_iso(at),
            }
            try:
                write_new(paths.clients, f"{address}.json", json.dumps(entry, sort_keys=True) + "\n")
            except FileExistsError:
                continue
            ensure_lease(paths, entry)
            return entry
        raise SystemExit("no free address in the agents' range")
    finally:
        os.close(fd)


def ensure_lease(paths, entry):
    line = f"{entry['hwaddr']},{entry['address']}\n"
    path = os.path.join(paths.dhcp, entry["address"])
    try:
        if read_file(path) == line and stat.S_IMODE(os.lstat(path).st_mode) & 0o004:
            return
    except (OSError, ValueError, UnicodeDecodeError):
        pass
    # dnsmasq's unprivileged user reads it: mode 0644 whatever the caller's umask.
    write_replace(path, line, 0o644)


def dhcp_rule(entry):
    """A machine's DHCP rule: its own MAC, from no address or its own, naming its own MAC as the client (chaddr) and
    no relay (giaddr 0, so dnsmasq never sends its answer anywhere else)."""
    mac = entry["hwaddr"]
    return (f"ether saddr {mac} ip saddr {{ 0.0.0.0, {entry['address']} }} @th,256,32 0 "
            f"@th,288,48 0x{mac.replace(':', '')} accept comment \"{entry['address']}\"")


def elements(entries, ports, fresh=False):
    """nft statements that fill the bridge rules: entries are the client map entries LXD backs, ports the (port, MAC)
    pairs of their running machines. For `up`, after the table file (its dhcp chain holds the final drop, the
    machines' rules go above it); with fresh, as one replacement of everything."""
    family, table = BRIDGE_TABLE
    ordered = sorted(entries.values(), key=lambda e: ipaddress.ip_address(e["address"]))
    lines = []
    if fresh:
        lines += [f"flush set {family} {table} ports", f"flush set {family} {table} clients",
                  f"flush chain {family} {table} dhcp"]
    if ports:
        named = ", ".join('"%s" . %s' % (port, mac) for port, mac in sorted(ports))
        lines.append(f"add element {family} {table} ports {{ {named} }}")
    if ordered:
        pairs = ", ".join(f"{e['hwaddr']} . {e['address']}" for e in ordered)
        lines.append(f"add element {family} {table} clients {{ {pairs} }}")
    verb = "add" if fresh else "insert"
    lines += [f"{verb} rule {family} {table} dhcp {dhcp_rule(e)}" for e in ordered]
    if fresh:
        lines.append(f'add rule {family} {table} dhcp counter name "dropped_unbound" drop')
    return lines


def current_ports():
    """The (port, MAC) pairs the loaded bridge rules hold, or none when they are not loaded."""
    family, table = BRIDGE_TABLE
    try:
        result = subprocess.run(["nft", "-j", "list", "set", family, table, "ports"], capture_output=True, text=True)
    except OSError:
        return set()
    if result.returncode != 0:
        return set()
    found = set()
    for item in json.loads(result.stdout).get("nftables", []):
        for elem in item.get("set", {}).get("elem", []) or []:
            value = elem.get("elem", {}).get("val") if isinstance(elem, dict) and "elem" in elem else elem
            parts = value.get("concat") if isinstance(value, dict) else None
            if parts and len(parts) == 2:
                found.add((str(parts[0]), str(parts[1]).lower()))
    return found


def host_port(instance):
    """The node's side of a running machine's plug card, or None."""
    nics = plug_nics(instance)
    if len(nics) != 1 or instance.get("status") != "Running":
        return None
    key = f"volatile.{next(iter(nics))}.host_name"
    name = (instance.get("expanded_config") or {}).get(key) or (instance.get("config") or {}).get(key)
    return name if isinstance(name, str) and re.match(r"^[A-Za-z0-9_.-]{1,15}$", name) else None


def backed(paths, entries, instances):
    """The entries LXD backs (each matched once and still matching its machine, if it has one now), and the ports of
    their running machines."""
    by_name = {(i.get("project", "default"), i["name"]): i for i in instances}
    ok, ports = {}, set()
    for address, entry in entries.items():
        if not os.path.lexists(os.path.join(paths.verified, address)):
            continue
        instance = by_name.get((entry["project"], entry["instance"]))
        if instance is not None and check_machine(entry, instance):
            continue
        ok[address] = entry
        port = host_port(instance) if instance is not None else None
        if port:
            ports.add((port, entry["hwaddr"]))
    return ok, ports


# --- The reconciler (root) ----------------------------------------------------------------------------------------


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__("lxd")
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(30)
        self.sock.connect(self.path)


def lxd_instances(socket_path, fixture):
    """Every instance in every project, with its expanded config and devices and its status."""
    if fixture:
        with open(fixture, encoding="utf-8") as f:
            instances = json.load(f)
    else:
        connection = UnixHTTPConnection(socket_path)
        try:
            connection.request("GET", "/1.0/instances?recursion=1&all-projects=true")
            response = connection.getresponse()
            body = json.loads(response.read())
        finally:
            connection.close()
        if response.status != 200 or body.get("type") != "sync":
            raise RuntimeError(f"LXD answered {response.status}: {body.get('error', '')}")
        instances = body["metadata"]
    if not isinstance(instances, list) or not all(isinstance(i, dict) and i.get("name") for i in instances):
        raise RuntimeError("LXD's answer is not a list of instances")
    return instances


def plug_nics(instance):
    return {
        name: device
        for name, device in (instance.get("expanded_devices") or {}).items()
        if isinstance(device, dict) and device.get("type") == "nic" and device.get("parent") == BRIDGE
    }


def where(entry):
    return f"{entry['project']}/{entry['instance']} ({entry['address']})"


def check_machine(entry, instance):
    """Where the machine differs from its entry (its plug card, its identity), as problem texts."""
    nics = plug_nics(instance)
    if len(nics) != 1:
        return [f"{where(entry)} has {len(nics)} network cards on {BRIDGE}, not 1"]
    nic = next(iter(nics.values()))
    problems = []
    wanted = dict(PLUG_NIC, hwaddr=entry["hwaddr"], **{"ipv4.address": entry["address"]})
    for key, value in wanted.items():
        if nic.get(key) != value:
            problems.append(f"{where(entry)}: its card's {key} is {nic.get(key)!r}, not {value!r}")
    if nic.get("security.ipv4_filtering") == "true":
        problems.append(f"{where(entry)}: its card has LXD's IPv4 filter on, which drops its DHCP requests")
    config = instance.get("expanded_config") or {}
    identity = {"user.qorpera.company_id": entry["company"], MACHINE_KEY[entry["kind"]]: entry["machine"]}
    if entry["kind"] == "coding":
        identity["user.qorpera.member_user_id"] = entry["member"]
    for key, value in identity.items():
        if config.get(key) != value:
            problems.append(f"{where(entry)}: {key} is {config.get(key)!r}, not {value!r}")
    return problems


def check_port(entry, instance):
    """A running machine's plug card must be a port of the agents' bridge (after a rebuild of the bridge it is not)."""
    if len(plug_nics(instance)) != 1 or instance.get("status") != "Running":
        return []
    host_name = host_port(instance)
    master = None
    if host_name:
        try:
            master = os.path.basename(os.readlink(f"/sys/class/net/{host_name}/master"))
        except OSError:
            master = None
    if master == BRIDGE:
        return []
    return [f"{where(entry)} is running, but its network card ({host_name}) is not a port of {BRIDGE}"]


def parse_twins(text):
    """`conntrack -L` lines from the exit to the node's twin of each connection: (proto, dst, dport or icmp id, the
    exit's masqueraded source port). Connections of other protocols have no ports to tell them apart and are left to
    their timeouts."""
    twins = []
    for line in text.splitlines():
        tokens = line.split()
        if len(tokens) < 3 or tokens[0] not in ("tcp", "udp", "icmp"):
            continue
        # The first src, dst, ports and icmp id are the original direction, the second ones the reply.
        original, reply = {}, {}
        for token in tokens:
            key, _, value = token.partition("=")
            if value and key in ("src", "dst", "sport", "dport", "id"):
                (reply if key in original else original).setdefault(key, value)
        if reply.get("dst") != UPLINK or "dst" not in original:
            continue
        if tokens[0] == "icmp":
            if "id" in reply:
                twins.append(("icmp", original["dst"], None, reply["id"]))
        elif "dport" in original and "dport" in reply:
            twins.append((tokens[0], original["dst"], original["dport"], reply["dport"]))
    return twins


def set_keys(text, address):
    """The keys of an `nft -j list set` answer that belong to this address (alone, or first in a concatenation)."""
    keys = []
    for item in json.loads(text).get("nftables", []):
        for elem in item.get("set", {}).get("elem", []) or []:
            value = elem.get("elem", {}).get("val") if isinstance(elem, dict) and "elem" in elem else elem
            parts = value.get("concat") if isinstance(value, dict) else [value]
            if parts and parts[0] == address:
                keys.append(" . ".join(str(p) for p in parts))
    return keys


class Reconciler:
    def __init__(self, paths, args):
        self.paths = paths
        self.args = args
        self.problems = []
        self.nft = os.environ.get("QORPERA_AGENT_PLUG_NFT", "1") != "0"

    def run(self, command):
        return subprocess.run(command, capture_output=True, text=True)

    def history(self, event, entry, at=None, **extra):
        keys = ("address", "hwaddr", "kind", "company", "machine", "member", "project", "instance")
        record = {key: entry.get(key) for key in keys if key in entry}
        record.update(extra, event=event, ts=time.time() if at is None else at)
        day = time.strftime("%Y-%m-%d", time.gmtime(record["ts"]))
        path = os.path.join(self.paths.log_dir, f"clients-{day}.jsonl")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW | os.O_CLOEXEC, 0o640)
        with os.fdopen(fd, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, separators=(",", ":"), sort_keys=True) + "\n")

    def note(self, key, text, write):
        """Writes a history line once per distinct finding (key: what it is about; text: the finding)."""
        path = os.path.join(self.paths.noted, key)
        try:
            if read_file(path) == text:
                return
        except (OSError, ValueError):
            pass
        write()
        write_replace(path, text)

    def mark_seen(self, entry):
        """The entry's machine is in LXD: from now on its absence means it is gone. The marker keeps a copy of the
        entry, so the reconciler can unplug the address even if the entry is removed by hand."""
        path = os.path.join(self.paths.seen, entry["address"])
        if seen_since(self.paths, entry["address"]) != entry["since"]:
            write_replace(path, json.dumps(entry, sort_keys=True) + "\n")

    def mark_verified(self, entry):
        """The entry matches its machine: the history ties the address to it, from the entry's time on."""
        path = os.path.join(self.paths.verified, entry["address"])
        if not os.path.lexists(path):
            self.history("plugged", entry, at=parse_iso(entry["since"]))
            write_replace(path, now_iso() + "\n")
        remove(os.path.join(self.paths.noted, entry["address"]))

    def mismatch(self, entry, instance, problems):
        config = instance.get("expanded_config") or {}
        found = {key: config.get(key) for key in sorted({"user.qorpera.company_id", MACHINE_KEY[entry["kind"]],
                                                          "user.qorpera.member_user_id"})}
        nic = next(iter(plug_nics(instance).values()), {})
        found.update({"hwaddr": nic.get("hwaddr"), "ipv4.address": nic.get("ipv4.address")})
        self.note(entry["address"], "\n".join(problems),
                  lambda: self.history("mismatch", entry, lxd=found, problems=problems))

    def conntrack(self, *command, netns=None):
        """True when conntrack did what was asked; finding nothing to list or delete counts as done."""
        prefix = ["ip", "netns", "exec", netns] if netns else []
        result = self.run([*prefix, "conntrack", *command])
        if result.returncode == 0 or (result.returncode == 1 and "0 flow entries" in result.stderr):
            return result
        self.problems.append(f"conntrack {' '.join(command)} failed: {result.stderr.strip()[:200]}")
        return None

    def flush(self, address):
        """Ends every connection of this address: the exit's, the node's masqueraded twins and (if the node tracks the
        bridged leg) the node's own. Returns the number of twins, or None when part of it failed."""
        if self.args.flush_log:
            with open(self.args.flush_log, "a", encoding="utf-8") as f:
                f.write(address + "\n")
            return 0
        listed = self.conntrack("-L", "-s", address, netns=self.args.netns)
        if listed is None:
            return None
        twins = parse_twins(listed.stdout)
        done = self.conntrack("-D", "-s", address, netns=self.args.netns) is not None
        for proto, dst, dport, port in twins:
            command = ["-D", "-p", proto, "-s", UPLINK, "-d", dst]
            command += ["--icmp-type", "8", "--icmp-code", "0", "--icmp-id", port] if proto == "icmp" else [
                "--sport", port, "--dport", dport]
            done = self.conntrack(*command) is not None and done
        done = self.conntrack("-D", "-s", address) is not None and done
        return len(twins) if done else None

    def forget(self, address):
        """Takes the address out of the exit's per-machine sets: its counts and refused flows are not the next
        machine's."""
        if not self.nft:
            return
        family, table = EXIT_TABLE
        statements = []
        for name in EXIT_SETS:
            listed = self.run(["ip", "netns", "exec", self.args.netns, "nft", "-j", "list", "set", family, table, name])
            if listed.returncode == 0:
                statements += [f"delete element {family} {table} {name} {{ {key} }}"
                               for key in set_keys(listed.stdout, address)]
        if statements:
            result = subprocess.run(["ip", "netns", "exec", self.args.netns, "nft", "-f", "-"],
                                    input="\n".join(statements) + "\n", capture_output=True, text=True)
            if result.returncode != 0:
                print(f"cannot clear {address} from the exit's sets: {result.stderr.strip()[:200]}", flush=True)

    def bridge_state(self):
        """What the bridge rules hold now: the ports and pairs sets, the dhcp chain's per-machine rules (by their
        comment), and whether that chain still ends in its bare drop. None when they cannot be read."""
        family, table = BRIDGE_TABLE
        answers = [self.run(["nft", "-j", "list", what, family, table, name])
                   for what, name in (("set", "ports"), ("set", "clients"), ("chain", "dhcp"))]
        failed = [a for a in answers if a.returncode != 0]
        if failed:
            self.problems.append(f"cannot read the bridge rules: {failed[0].stderr.strip()[:200]}")
            return None

        def pairs(text):
            found = set()
            for item in json.loads(text).get("nftables", []):
                for elem in item.get("set", {}).get("elem", []) or []:
                    value = elem.get("elem", {}).get("val") if isinstance(elem, dict) and "elem" in elem else elem
                    parts = value.get("concat") if isinstance(value, dict) else None
                    found.add(tuple(str(p).lower() for p in parts) if parts and len(parts) == 2 else ("?",))
            return found

        rules = [item["rule"] for item in json.loads(answers[2].stdout).get("nftables", []) if "rule" in item]
        comments = sorted(r.get("comment", "") for r in rules[:-1])
        last = [next(iter(e)) for e in rules[-1].get("expr", [])] if rules else []
        bare_drop = bool(rules) and "comment" not in rules[-1] and last == ["counter", "drop"]
        return pairs(answers[0].stdout), pairs(answers[1].stdout), comments, bare_drop

    def sync_bridge(self, entries, ports):
        """Keeps the bridge rules equal to the entries LXD backs and their ports, in one transaction. Read back every
        pass, so a restart or a crash (and the plain hand edits) are set right within a pass."""
        if not self.nft:
            return
        state = self.bridge_state()
        if state is None:
            return
        wanted = ({(p.lower(), m) for p, m in ports}, {(e["hwaddr"], e["address"]) for e in entries.values()},
                  sorted(entries), True)
        if state == wanted:
            return
        batch = elements(entries, ports, fresh=True)
        result = subprocess.run(["nft", "-f", "-"], input="\n".join(batch) + "\n", capture_output=True, text=True)
        if result.returncode != 0:
            self.problems.append(f"cannot update the bridge rules: {result.stderr.strip()[:200]}")

    def unplug(self, entry, reason):
        """Under the plug lock, so no plug runs in between; the entry is read again first, and a re-plug (a new time)
        or a removal by hand since this pass's read keeps or changes what is done."""
        address = entry["address"]
        fd = lock(self.paths)
        try:
            try:
                now = read_entry(self.paths.entry(address), address)
            except FileNotFoundError:
                now = None
            except (OSError, ValueError, UnicodeDecodeError, RecursionError):
                now = entry
            if now is not None and now["since"] != entry["since"]:
                return False
            # Quarantine first: from here on no plug can take the address, whatever happens next.
            quarantine = {"until": time.time() + QUARANTINE_SECONDS, "reason": reason, "company": entry["company"],
                          "machine": entry["machine"], "instance": f"{entry['project']}/{entry['instance']}"}
            write_replace(os.path.join(self.paths.quarantine, address), json.dumps(quarantine, sort_keys=True) + "\n")
            remove(os.path.join(self.paths.dhcp, address))
            reload = self.run(self.args.reload_dns.split())
            if reload.returncode != 0:
                self.problems.append(f"cannot reload the name service after unplugging {address}: {reload.stderr.strip()}")
            if self.flush(address) is None:
                write_replace(os.path.join(self.paths.unflushed, address), now_iso() + "\n")
            self.forget(address)
            verified = os.path.lexists(os.path.join(self.paths.verified, address))
            self.history("unplugged" if verified else "dropped", entry, reason=reason)
            for directory in (self.paths.verified, self.paths.noted, self.paths.stopped, self.paths.missing):
                remove(os.path.join(directory, address))
            remove(self.paths.entry(address))
            # Last: while the seen marker is there, no plug takes the address.
            remove(os.path.join(self.paths.seen, address))
        finally:
            os.close(fd)
        print(f"unplugged {address} ({entry['project']}/{entry['instance']}): {reason}", flush=True)
        return True

    def tidy(self, at):
        """Temporary files left by a crash in the creators' folders, leases that belong to no entry (dnsmasq reads every
        file there), and quarantines that ended."""
        for directory in (self.paths.clients, self.paths.dhcp):
            for name in os.listdir(directory):
                path = os.path.join(directory, name)
                age = at - os.lstat(path).st_mtime
                if name.startswith(".tmp-") and age > STALE_TMP_SECONDS:
                    remove(path)
                elif (directory == self.paths.dhcp and not name.startswith(".") and age > 60
                      and not os.path.lexists(self.paths.entry(name))):
                    try:
                        os.unlink(path)
                    except IsADirectoryError:
                        self.problems.append(f"dhcp-hosts/{name} is a folder; remove it by hand")
                    except FileNotFoundError:
                        pass
        for name in os.listdir(self.paths.quarantine):
            if name.startswith("."):
                continue
            if not held(self.paths, name, at) and not os.path.lexists(self.paths.entry(name)):
                remove(os.path.join(self.paths.quarantine, name))

    def pass_once(self):
        self.problems = []
        at = time.time()
        # LXD first, then the map: a plug always comes before its machine, so every machine in this view of LXD
        # already has its entry, and an entry's machine missing from it was really gone when LXD was read.
        try:
            instances = lxd_instances(self.args.lxd_socket, self.args.lxd_fixture)
        except Exception as error:  # noqa: BLE001 - LXD unreadable: change nothing, report it
            self.problems.append(f"cannot read LXD: {error}")
            return self.write_status(at, read_entries(self.paths)[0])
        entries, broken = read_entries(self.paths)
        self.problems += [f"unreadable client map entry {b}" for b in broken]
        by_name = {(i.get("project", "default"), i["name"]): i for i in instances}
        known = {(e["project"], e["instance"]) for e in entries.values()}
        for (project, name), instance in sorted(by_name.items()):
            if plug_nics(instance) and (project, name) not in known:
                self.problems.append(f"{project}/{name} is on {BRIDGE} without a client map entry")
                cards = [{"hwaddr": n.get("hwaddr"), "ipv4.address": n.get("ipv4.address")}
                         for n in plug_nics(instance).values()]
                stray = {"project": project, "instance": name}
                self.note(f"stray-{project}-{name}", json.dumps(cards, sort_keys=True),
                          lambda: self.history("unattributed", stray, cards=cards))
        for address, entry in sorted(entries.items(), key=lambda item: ipaddress.ip_address(item[0])):
            try:
                self.reconcile_entry(at, address, entry, by_name.get((entry["project"], entry["instance"])))
            except Exception as error:  # noqa: BLE001 - one entry never stops the pass for the others
                self.problems.append(f"{where(entry)}: {type(error).__name__}: {error}"[:300])
        self.after_entries(at, entries)
        entries = read_entries(self.paths)[0]
        ok, ports = backed(self.paths, entries, instances)
        self.sync_bridge(ok, ports)
        return self.write_status(at, entries)

    def reconcile_entry(self, at, address, entry, instance):
        """One entry against its machine in this view of LXD (None: not there)."""
        missing = os.path.join(self.paths.missing, address)
        if instance is None:
            if seen_since(self.paths, address) == entry["since"]:
                # Gone only when two reads in a row miss it: one odd read of LXD never unplugs anything.
                if os.path.lexists(missing):
                    self.unplug(entry, "the machine is gone")
                else:
                    write_replace(missing, now_iso() + "\n")
            elif at - parse_iso(entry["since"]) > PENDING_SECONDS:
                self.unplug(entry, "the machine was never created")
            return
        remove(missing)
        self.mark_seen(entry)
        try:
            ensure_lease(self.paths, entry)
        except OSError as error:
            self.problems.append(f"{where(entry)}: cannot write its lease: {error}")
        self.problems += check_port(entry, instance)
        problems = check_machine(entry, instance)
        if problems:
            # A claim LXD does not back: unhealthy, logged, never attributed.
            self.problems += problems
            self.mismatch(entry, instance, problems)
        else:
            self.mark_verified(entry)
        stopped = os.path.join(self.paths.stopped, address)
        if instance.get("status") == "Stopped":
            if not os.path.lexists(stopped):
                twins = self.flush(address)
                if twins is not None:
                    write_replace(stopped, now_iso() + "\n")
                    print(f"flushed {address} ({where(entry)}, asleep; {twins} twins on the node)", flush=True)
        else:
            remove(stopped)

    def after_entries(self, at, entries):
        # A seen marker without its entry: the entry was removed by hand. Unplug the address from the marker's copy.
        for name in os.listdir(self.paths.seen):
            if name.startswith(".") or name in entries or os.path.lexists(self.paths.entry(name)):
                continue
            try:
                copy = read_entry(os.path.join(self.paths.seen, name), name)
            except (OSError, ValueError, UnicodeDecodeError, RecursionError):
                remove(os.path.join(self.paths.seen, name))
                continue
            self.unplug(copy, "its entry was removed by hand")
        for name in os.listdir(self.paths.unflushed):
            if name.startswith("."):
                continue
            if self.flush(name) is None:
                self.problems.append(f"the connections of {name}, unplugged, could not be ended yet")
            else:
                remove(os.path.join(self.paths.unflushed, name))
        self.tidy(at)

    def write_status(self, at, entries):
        status = {"schema": "qorpera.agent-plug-status/v1", "at": now_iso(at), "clients": len(entries),
                  "problems": self.problems}
        write_replace(self.paths.status, json.dumps(status, sort_keys=True) + "\n")
        for problem in self.problems:
            print(f"problem: {problem}", file=sys.stderr, flush=True)
        return status


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", nargs="?", choices=("plug", "list", "elements", "reconcile"))
    env = os.environ.get
    parser.add_argument("--state-dir", default=env("QORPERA_AGENT_EXIT_STATE_DIR", "/var/lib/qorpera-agent-exit"))
    parser.add_argument("--run-dir", default=env("QORPERA_AGENT_EXIT_RUN_DIR", "/run/qorpera-agent-exit"))
    parser.add_argument("--log-dir", default=env("QORPERA_AGENT_EXIT_LOG_DIR", "/var/log/qorpera-agent-exit"))
    parser.add_argument("--kind")
    parser.add_argument("--company")
    parser.add_argument("--machine")
    parser.add_argument("--member")
    parser.add_argument("--project")
    parser.add_argument("--instance")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--interval", type=float, default=float(env("QORPERA_AGENT_PLUG_INTERVAL", "5")))
    parser.add_argument("--netns", default="qexit")
    parser.add_argument("--lxd-socket", default="/var/snap/lxd/common/lxd/unix.socket")
    # Test only: the instances from a JSON file instead of LXD, another way to reload the name service, and flushes
    # written to a file instead of done (QORPERA_AGENT_PLUG_NFT=0 also leaves nft alone).
    parser.add_argument("--lxd-fixture", default=env("QORPERA_AGENT_PLUG_LXD_FIXTURE"))
    parser.add_argument("--reload-dns", default=env("QORPERA_AGENT_PLUG_RELOAD_DNS",
                                                    "systemctl reload qorpera-agent-exit-dns.service"))
    parser.add_argument("--flush-log")
    parser.add_argument("--parse-conntrack", action="store_true")
    args = parser.parse_args()
    if args.parse_conntrack:
        for twin in parse_twins(sys.stdin.read()):
            print(json.dumps(list(twin)))
        return
    paths = Paths(args.state_dir, args.run_dir, args.log_dir)
    if args.command == "plug":
        if not (args.kind and args.company and args.machine and args.project and args.instance):
            parser.error("plug needs --kind, --company, --machine, --project and --instance")
        entry = plug(paths, args.kind, args.company, args.machine, args.member, args.project, args.instance)
        print(json.dumps({"address": entry["address"], "hwaddr": entry["hwaddr"]}))
    elif args.command == "list":
        entries = sorted(read_entries(paths)[0].values(), key=lambda e: ipaddress.ip_address(e["address"]))
        print(json.dumps(entries, indent=1))
    elif args.command == "elements":
        # For `up`: entries LXD backed when last seen, and the ports the bridge rules hold now (LXD is never asked:
        # at boot it waits for the exit). The reconciler sets both right within a pass.
        entries = {a: e for a, e in read_entries(paths)[0].items() if os.path.lexists(os.path.join(paths.verified, a))}
        for line in elements(entries, current_ports()):
            print(line)
    elif args.command == "reconcile":
        for directory in (*paths.root_dirs(), args.log_dir):
            os.makedirs(directory, exist_ok=True)
        reconciler = Reconciler(paths, args)
        while True:
            reconciler.pass_once()
            if args.once:
                return
            time.sleep(args.interval)
    else:
        parser.error("a command is required")


if __name__ == "__main__":
    main()
