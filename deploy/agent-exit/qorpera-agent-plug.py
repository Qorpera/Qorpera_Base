#!/usr/bin/env python3
"""Qorpera agent exit (E2): the agent plug and its client map.

A machine creator (the coding executor, the office units: members of group qorpera-agent-plug) calls `plug` before it
creates a machine that plugs into the agents' bridge qagent0. `plug` gives the machine the lowest free address in
10.210.0.0/16 and a MAC derived from it, and writes two files:
- the client map entry clients/<address>.json (address, MAC, kind, company, machine, member, LXD project and
  instance, since), created exclusively, so two creators never get the same address;
- dnsmasq's static lease dhcp-hosts/<address> ("mac,address"), which dnsmasq reads by itself.
The machine's LXD NIC then carries both: nictype bridged, parent qagent0, hwaddr, ipv4.address, ipv6.address none,
and MAC, IPv4 and IPv6 filtering and port isolation. A repeated `plug` for the same instance returns its entry.

The reconciler (root, the plug unit) reads LXD every few seconds and keeps the map true:
- a machine that stopped (asleep) keeps its address and its entry, and its connections are flushed once;
- a machine that is gone (deleted, or never created within an hour of its plug) is unplugged: its address is
  quarantined for 15 minutes first, then its lease is removed (dnsmasq reloads), its connections are flushed and its
  entry is removed;
- every entry is checked against its machine's LXD config, a running machine's network card must be a port of
  qagent0, and every machine on qagent0 must have an entry. Anything else is a problem, and a problem makes the exit
  unhealthy (`qorpera-agent-exit.sh verify` reads <run-dir>/plug.json).
Flushing covers both connection tables: the exit's own, and the node's masqueraded twin of each connection (phase 1).
It writes a plugged and an unplugged line per entry to <log-dir>/clients-YYYY-MM-DD.jsonl, so an address stays tied
to its company and machine for as long as the flow log is kept, also after the machine is gone.

  qorpera-agent-plug.py plug --kind K --company C --machine M [--member U] --project P --instance I
  qorpera-agent-plug.py list
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
import socket
import subprocess
import sys
import time

AGENTS = ipaddress.ip_network("10.210.0.0/16")
GATEWAY = ipaddress.ip_address("10.210.0.1")
BRIDGE = "qagent0"
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
ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
LXD_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,62}$")
PLUG_NIC = {
    "type": "nic",
    "nictype": "bridged",
    "parent": BRIDGE,
    "ipv6.address": "none",
    "security.mac_filtering": "true",
    "security.ipv4_filtering": "true",
    "security.ipv6_filtering": "true",
    "security.port_isolation": "true",
}


def now_iso(ts=None):
    moment = datetime.datetime.fromtimestamp(time.time() if ts is None else ts, datetime.UTC)
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(text):
    return datetime.datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.UTC).timestamp()


def hwaddr_for(address):
    """The MAC of the machine at this address: locally administered, unicast, the address's last two bytes."""
    packed = ipaddress.ip_address(address).packed
    return "0e:51:%02x:%02x:%02x:%02x" % tuple(packed)


def candidates():
    """Every address a machine may get, lowest first: not the network, not the gateway, no .0 or .255 host."""
    for address in AGENTS.hosts():
        if address == GATEWAY or address.packed[3] in (0, 255):
            continue
        yield str(address)


class Paths:
    def __init__(self, state_dir, run_dir, log_dir):
        self.clients = os.path.join(state_dir, "clients")
        self.dhcp = os.path.join(state_dir, "dhcp-hosts")
        self.quarantine = os.path.join(state_dir, "quarantine")
        self.seen = os.path.join(state_dir, "seen")
        self.lock = os.path.join(state_dir, "plug.lock")
        self.run_dir = run_dir
        self.stopped = os.path.join(run_dir, "plug-stopped")
        self.status = os.path.join(run_dir, "plug.json")
        self.log_dir = log_dir

    def entry(self, address):
        return os.path.join(self.clients, f"{address}.json")


def write_new(directory, name, text, mode):
    """Create directory/name with text, all at once and only if it does not exist yet (link() fails on an existing
    name), so a reader never sees half a file and two writers never share one."""
    tmp = os.path.join(directory, f".tmp-{name}-{os.getpid()}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.link(tmp, os.path.join(directory, name))
    finally:
        os.unlink(tmp)


def write_replace(path, text, mode=0o644):
    tmp = f"{path}.tmp-{os.getpid()}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def remove(path):
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass


def read_entries(paths):
    """{address: entry} for every client map entry, and the names of entries that cannot be read."""
    entries, broken = {}, []
    for name in sorted(os.listdir(paths.clients)):
        if name.startswith(".") or not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(paths.clients, name), encoding="utf-8") as f:
                entry = json.load(f)
            if entry.get("address") != name[: -len(".json")]:
                raise ValueError("the address does not match the file name")
            if ipaddress.ip_address(entry["address"]) not in AGENTS:
                raise ValueError("the address is not in the agents' range")
            entries[entry["address"]] = entry
        except (OSError, ValueError, KeyError, AttributeError, TypeError) as error:
            broken.append(f"{name}: {error}")
    return entries, broken


def quarantined(paths, address, at):
    try:
        with open(os.path.join(paths.quarantine, address), encoding="utf-8") as f:
            return json.load(f).get("until", 0) > at
    except FileNotFoundError:
        return False
    except (OSError, ValueError):
        # An unreadable quarantine file keeps the address out of use; the reconciler replaces or removes it.
        return True


def lock(paths):
    # flock needs no write access: every creator can take the lock, whoever made the file.
    fd = os.open(paths.lock, os.O_RDONLY | os.O_CREAT, 0o644)
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
        for entry in entries.values():
            if (entry["project"], entry["instance"]) != (project, instance):
                continue
            wanted = {"kind": kind, "company": company, "machine": machine, "member": member}
            if any(entry.get(key) != value for key, value in wanted.items()):
                raise SystemExit(f"{project}/{instance} is already plugged in for another machine ({entry['address']})")
            ensure_lease(paths, entry)
            return entry
        at = time.time()
        for address in candidates():
            if address in entries or quarantined(paths, address, at):
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
                write_new(paths.clients, f"{address}.json", json.dumps(entry, sort_keys=True) + "\n", 0o644)
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
        with open(path, encoding="utf-8") as f:
            if f.read() == line:
                return
    except FileNotFoundError:
        pass
    # dnsmasq's unprivileged user reads it.
    write_replace(path, line, 0o644)


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
            return json.load(f)
    connection = UnixHTTPConnection(socket_path)
    try:
        connection.request("GET", "/1.0/instances?recursion=1&all-projects=true")
        response = connection.getresponse()
        body = json.loads(response.read())
    finally:
        connection.close()
    if response.status != 200 or body.get("type") != "sync":
        raise RuntimeError(f"LXD answered {response.status}: {body.get('error', '')}")
    return body["metadata"]


def plug_nics(instance):
    return {
        name: device
        for name, device in (instance.get("expanded_devices") or {}).items()
        if device.get("type") == "nic" and device.get("parent") == BRIDGE
    }


def check_machine(entry, instance):
    """What is wrong with this machine's plug, as problem texts."""
    where = f"{entry['project']}/{entry['instance']} ({entry['address']})"
    nics = plug_nics(instance)
    if len(nics) != 1:
        return [f"{where} has {len(nics)} network cards on {BRIDGE}, not 1"]
    (name, nic), = nics.items()
    problems = []
    wanted = dict(PLUG_NIC, hwaddr=entry["hwaddr"], **{"ipv4.address": entry["address"]})
    for key, value in wanted.items():
        if nic.get(key) != value:
            problems.append(f"{where}: its card's {key} is {nic.get(key)!r}, not {value!r}")
    config = instance.get("expanded_config") or {}
    identity = {"user.qorpera.company_id": entry["company"], MACHINE_KEY[entry["kind"]]: entry["machine"]}
    if entry["kind"] == "coding":
        identity["user.qorpera.member_user_id"] = entry["member"]
    for key, value in identity.items():
        if config.get(key) != value:
            problems.append(f"{where}: {key} is {config.get(key)!r}, not {value!r}")
    if instance.get("status") == "Running":
        key = f"volatile.{name}.host_name"
        host_name = config.get(key) or (instance.get("config") or {}).get(key)
        master = None
        if host_name:
            try:
                master = os.path.basename(os.readlink(f"/sys/class/net/{host_name}/master"))
            except OSError:
                master = None
        if master != BRIDGE:
            problems.append(f"{where} is running, but its network card ({host_name}) is not a port of {BRIDGE}")
    return problems


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


class Reconciler:
    def __init__(self, paths, args):
        self.paths = paths
        self.args = args
        self.problems = []

    def run(self, command, check=False):
        result = subprocess.run(command, capture_output=True, text=True)
        if check and result.returncode != 0:
            raise RuntimeError(f"{' '.join(command)}: {result.stderr.strip()}")
        return result

    def history(self, event, entry, at=None):
        keys = ("address", "hwaddr", "kind", "company", "machine", "member", "project", "instance")
        record = {key: entry.get(key) for key in keys}
        record.update(event=event, ts=time.time() if at is None else at)
        day = time.strftime("%Y-%m-%d", time.gmtime(record["ts"]))
        path = os.path.join(self.paths.log_dir, f"clients-{day}.jsonl")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o640)
        with os.fdopen(fd, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, separators=(",", ":"), sort_keys=True) + "\n")

    def mark_seen(self, entry):
        """The first time the reconciler sees an entry, its plugged line goes to the history (at its plug time)."""
        path = os.path.join(self.paths.seen, entry["address"])
        if os.path.exists(path):
            return False
        self.history("plugged", entry, at=parse_iso(entry["since"]))
        write_replace(path, entry["since"] + "\n")
        return True

    def flush(self, address):
        """Ends every connection of this address: the exit's, the node's masqueraded twins and (if the node tracks the
        bridged leg) the node's own."""
        if self.args.flush_log:
            with open(self.args.flush_log, "a", encoding="utf-8") as f:
                f.write(address + "\n")
            return 0
        listed = self.run(["ip", "netns", "exec", self.args.netns, "conntrack", "-L", "-s", address])
        twins = parse_twins(listed.stdout)
        self.run(["ip", "netns", "exec", self.args.netns, "conntrack", "-D", "-s", address])
        for proto, dst, dport, port in twins:
            command = ["conntrack", "-D", "-p", proto, "-s", UPLINK, "-d", dst]
            command += ["--icmp-id", port] if proto == "icmp" else ["--sport", port, "--dport", dport]
            self.run(command)
        self.run(["conntrack", "-D", "-s", address])
        return len(twins)

    def unplug(self, entry, reason):
        address = entry["address"]
        # Quarantine first: from here on no plug can take the address, whatever happens next.
        quarantine = {"until": time.time() + QUARANTINE_SECONDS, "reason": reason, "company": entry["company"],
                      "machine": entry["machine"], "instance": f"{entry['project']}/{entry['instance']}"}
        write_replace(os.path.join(self.paths.quarantine, address), json.dumps(quarantine, sort_keys=True) + "\n")
        remove(os.path.join(self.paths.dhcp, address))
        reload = self.run(self.args.reload_dns.split())
        if reload.returncode != 0:
            self.problems.append(f"cannot reload the name service after unplugging {address}: {reload.stderr.strip()}")
        self.flush(address)
        self.mark_seen(entry)
        self.history("unplugged", entry)
        remove(os.path.join(self.paths.seen, address))
        remove(os.path.join(self.paths.stopped, address))
        remove(self.paths.entry(address))
        print(f"unplugged {address} ({entry['project']}/{entry['instance']}): {reason}", flush=True)

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
        for address, entry in sorted(entries.items(), key=lambda item: ipaddress.ip_address(item[0])):
            instance = by_name.get((entry["project"], entry["instance"]))
            if instance is None:
                if os.path.exists(os.path.join(self.paths.seen, address)):
                    self.unplug(entry, "the machine is gone")
                elif at - parse_iso(entry["since"]) > PENDING_SECONDS:
                    self.unplug(entry, "the machine was never created")
                continue
            self.mark_seen(entry)
            ensure_lease(self.paths, entry)
            self.problems += check_machine(entry, instance)
            stopped = os.path.join(self.paths.stopped, address)
            if instance.get("status") == "Stopped":
                if not os.path.exists(stopped):
                    twins = self.flush(address)
                    write_replace(stopped, now_iso() + "\n")
                    where = f"{entry['project']}/{entry['instance']}"
                    print(f"flushed {address} ({where}, asleep; {twins} twins on the node)", flush=True)
            else:
                remove(stopped)
        for name in os.listdir(self.paths.quarantine):
            if name.startswith("."):
                continue
            if not quarantined(self.paths, name, at) and not os.path.exists(self.paths.entry(name)):
                remove(os.path.join(self.paths.quarantine, name))
        return self.write_status(at, read_entries(self.paths)[0])

    def write_status(self, at, entries):
        status = {"schema": "qorpera.agent-plug-status/v1", "at": now_iso(at), "clients": len(entries),
                  "problems": self.problems}
        write_replace(self.paths.status, json.dumps(status, sort_keys=True) + "\n")
        for problem in self.problems:
            print(f"problem: {problem}", file=sys.stderr, flush=True)
        return status


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", nargs="?", choices=("plug", "list", "reconcile"))
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
    parser.add_argument("--interval", type=float, default=float(os.environ.get("QORPERA_AGENT_PLUG_INTERVAL", "5")))
    parser.add_argument("--netns", default="qexit")
    parser.add_argument("--lxd-socket", default="/var/snap/lxd/common/lxd/unix.socket")
    # Test only: the instances from a JSON file instead of LXD, another way to reload the name service, and flushes
    # written to a file instead of done.
    parser.add_argument("--lxd-fixture", default=os.environ.get("QORPERA_AGENT_PLUG_LXD_FIXTURE"))
    parser.add_argument("--reload-dns", default=os.environ.get("QORPERA_AGENT_PLUG_RELOAD_DNS",
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
    elif args.command == "reconcile":
        for directory in (paths.quarantine, paths.seen, paths.stopped, args.log_dir):
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
