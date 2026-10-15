#!/usr/bin/env python3
"""Qorpera agent exit (E8b, E8c-1): each company's names, and where its machines may go.

The rules reader (E8b-1, qorpera-agent-exit-rules.service) keeps the network rules of every company with a machine
plugged in in one file, <state-dir>/rules/rules.json: null for a company without rules, its mode and its block and allow
lists otherwise; a company not listed is not known yet. This reconciler (root, the names unit) reads it and the agent
plug's verified machines every 2 seconds and keeps the exit's names true to it:
- a company with rules and a machine gets a resolver of its own: dnsmasq in the exit's namespace on 10.210.0.1, on a
  port of its own (10001-19999, kept in <state-dir>/names/ports.json, so a company keeps its port across restarts),
  run as qorpera-agent-exit-resolver@<port>.service. Its servers file, <run-dir>/names/<port>.servers, holds a line
  `server=/name/` for each blocked name: dnsmasq answers it itself, with no hosts to look in, "no such name", for the
  name and every name under it (`server=/*.name/` for `*.name`: only the names under it). In "open" mode every other
  name goes to the main dnsmasq's upstreams. In "only listed" mode (<port>.mode says which) the file starts with
  `server=/#/`, so every name is "no such name", and names each upstream for each allowed name not blocked; the
  resolver then has no upstreams of its own and puts each address it answers in the set allow_<port>. A wider list
  rewrites the file and reloads the resolver (SIGHUP: dnsmasq reads the servers file again and empties its cache), so
  a change applies within seconds. A narrower "only listed" list, or a switch of mode, restarts it instead (about a
  second without names): the marker <port>.owed is written first, then the resolver is stopped, its set emptied and it
  is started again; a marker left by a reconciler that stopped half way is carried out at the next start;
- the exit's map dns_port sends each verified machine's DNS (to any address, the exit's own included) to its company's
  resolver, or to the main dnsmasq on 53 for a company without rules, and the set dns_allowed lets in exactly that. A
  machine whose company is not known yet, whose company's rules are not usable or whose company has no port yet has no
  element, and its DNS is dropped: the exit fails closed. A company that just got rules keeps the main dnsmasq until its
  new resolver answers (at most 10 seconds after it was started; then its machines have no DNS). A machine whose
  resolver changes has its DNS connections ended, so none goes on to the old one;
- the exit's map reach (E8c-1, set in the same transaction as dns_port) sends each verified machine's new flows to
  the chain open (a company without rules or in "open" mode), or to its company's chain only_<port> ("only listed":
  TCP 443 to an address in allow_<port>, nothing else). A machine without an element (company not known yet, rules
  not usable, no port, no chain yet) is refused everything, and a machine whose element went has its connections
  ended. When a company becomes "only listed", or its list narrower, its machines' connections are ended once the map
  is right, so none made before goes on;
- a resolver no machine needs any more is stopped, its files removed and its port given back; then its chain and set.
Each pass ends in <run-dir>/names.json with its problems; `qorpera-agent-exit.sh verify` fails on any: no rules file or
one that cannot be used, a company not in it for 30 seconds or with rules that cannot be used, the rules reader silent
for 30 seconds or failing for 2 minutes, a resolver not answering, a map, chain or set that cannot be read or set.

"Only listed" goes by address: an allowed name's address lets out any name on it. E8c-2 checks the name too.

  qorpera-agent-exit-names.py reconcile [--once]     (root)
  qorpera-agent-exit-names.py elements               (nft statements for `up`: the only-listed sets and chains, and
                                                      the elements of dns_port, dns_allowed and reach)
"""

import argparse
import importlib.util
import ipaddress
import json
import os
import re
import stat
import subprocess
import sys
import time


def load_plug():
    """The agent plug's module (its client map entries, files and times), from beside this file."""
    path = os.environ.get("QORPERA_AGENT_EXIT_PLUG") or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "qorpera-agent-plug.py")
    spec = importlib.util.spec_from_file_location("qorpera_agent_plug", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


plug = load_plug()

RULES_SCHEMA = "qorpera.agent-exit-rules/v1"
STATUS_SCHEMA = "qorpera.agent-exit-names/v1"
GATEWAY = "10.210.0.1"
MAIN_PORT = 53
PORTS = range(10001, 20000)
UNIT = re.compile(r"^qorpera-agent-exit-resolver@([0-9]{1,5})\.service$")
MODES = ("open", "only-listed")
# The name rule of RUNTIME-AGENT-EXIT.md §10 (packages/cloud-client/src/network-rules.ts, and the database's).
LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
NAME = re.compile(rf"(?:\*\.)?(?:{LABEL}\.)*{LABEL}")
LAST_LABEL_DIGITS = re.compile(r"(?:^|\.)[0-9]+\Z")
MAX_NAMES = 1000
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
MAX_RULES_BYTES = 64 * 1024 * 1024
# A resolver has this long to answer after it was started before it is a problem.
START_GRACE = 10
# The rules reader writes its status every 2 seconds; it may fail this long (the last rules stay in force) before it is a
# problem.
READER_SILENT = 30
READER_FAILING = 120
# The rules reader adds a new machine's company within a pass or two; a company it still has not listed after this long is
# a problem (its machines have no DNS meanwhile).
UNKNOWN_GRACE = 30


def valid_name(value):
    if not isinstance(value, str) or not NAME.fullmatch(value):
        return False
    name = value[2:] if value.startswith("*.") else value
    return len(name) <= 253 and not LAST_LABEL_DIGITS.search(name)


def company_rules(value):
    """One company's rules as the rules reader writes them (its companyRules), or None when anything is not."""
    if not isinstance(value, dict) or sorted(value) != ["allow", "block", "mode", "version"]:
        return None
    if not isinstance(value["version"], str) or not UUID.fullmatch(value["version"]) or value["mode"] not in MODES:
        return None
    for key in ("block", "allow"):
        names = value[key]
        if not isinstance(names, list) or len(names) > MAX_NAMES or not all(valid_name(n) for n in names):
            return None
        if len(set(names)) != len(names):
            return None
    if set(value["block"]) & set(value["allow"]):
        return None
    return value


def read_whole(path, limit):
    """A regular file's bytes, never through a link (as the plug reads its folders)."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise ValueError("not a regular file")
        chunks, size = [], 0
        while chunk := os.read(fd, 1 << 20):
            chunks.append(chunk)
            size += len(chunk)
            if size > limit:
                raise ValueError("too large")
    finally:
        os.close(fd)
    return b"".join(chunks), (st.st_ino, st.st_mtime_ns, st.st_size)


def parse_rules(data):
    """{company: None (no rules) | rules | False (not usable)} from rules.json's bytes. Raises ValueError when the file
    as a whole is not as the reader writes it."""
    value = json.loads(data.decode("utf-8"))
    if not isinstance(value, dict) or value.get("schema") != RULES_SCHEMA or not isinstance(value.get("companies"), dict):
        raise ValueError("not a rules file")
    companies = {}
    for company, entry in value["companies"].items():
        if not plug.ID.match(company):
            raise ValueError("a company that is not an id")
        companies[company] = None if entry is None else (company_rules(entry) or False)
    return companies


def covers(block, name):
    """Whether the blocked name `block` covers every name the allowed name `name` does (a name covers itself and every
    name under it, `*.x` only the names under x)."""
    wide, narrow = block.removeprefix("*."), name.removeprefix("*.")
    if narrow.endswith("." + wide):
        return True
    return narrow == wide and (not block.startswith("*.") or name.startswith("*."))


def servers_text(rules, upstreams=()):
    """A company's servers file. Both modes: one line per blocked name. "Only listed" (E8c) adds `server=/#/`, so the
    resolver answers every name itself ("no such name"), and a line per upstream for each allowed name no blocked one
    covers, so those (and only those) are asked; a blocked name under an allowed one stays unanswered, as dnsmasq takes
    the most specific line."""
    blocked = "".join(f"server=/{name}/\n" for name in sorted(set(rules["block"])))
    if rules["mode"] != "only-listed":
        return blocked
    allowed = [name for name in sorted(set(rules["allow"])) if not any(covers(b, name) for b in rules["block"])]
    return "server=/#/\n" + "".join(f"server=/{name}/{u}\n" for name in allowed for u in upstreams) + blocked


def narrower(before, after):
    """Whether the servers file `after` leaves a name unanswered that `before` asked the upstreams for: a line asking
    is gone, or a new one answers itself."""
    def lines(text, asking):
        return {line for line in text.splitlines() if line.startswith("server=/") and
                (not line.endswith("/")) == asking}
    return bool(lines(before, True) - lines(after, True)) or bool(lines(after, False) - lines(before, False))


def object_lines(port):
    """An only-listed company's allow_P set and only_P chain (E8c), made again if they are there: TCP 443 to an address
    its resolver gave out for an allowed name goes on to the open chain, everything else is refused (with the mark the
    logger reads as not_listed)."""
    family, table = plug.EXIT_TABLE
    return [f"add set {family} {table} allow_{port} {{ type ipv4_addr; size 65536; }}",
            f"add chain {family} {table} only_{port}",
            f"flush chain {family} {table} only_{port}",
            f"add rule {family} {table} only_{port} tcp dport 443 ip daddr @allow_{port} goto open",
            f'add rule {family} {table} only_{port} meta mark set 0x80000004 counter name "refused_not_listed" goto refuse']


def only_chains(text, table):
    """The ports of the only_P chains in the exit's table, from `nft -j list chains`."""
    found = set()
    for item in json.loads(text).get("nftables", []):
        chain = item.get("chain") or {}
        m = re.fullmatch(r"only_([0-9]{5})", str(chain.get("name", "")))
        if chain.get("table") == table and m:
            found.add(int(m.group(1)))
    return found


def verified_clients(state_dir, cache=None):
    """{address: company} for each machine the agent plug verified: the company of its own copy of the entry
    (<state-dir>/seen/<address>), only while <state-dir>/verified/<address> exists (the logger reads it the same way)."""
    cache = {} if cache is None else cache
    seen = os.path.join(state_dir, "seen")
    found = {}
    try:
        names = os.listdir(seen)
    except FileNotFoundError:
        names = []
    for address in names:
        if address.startswith(".") or not os.path.lexists(os.path.join(state_dir, "verified", address)):
            continue
        path = os.path.join(seen, address)
        try:
            st = os.lstat(path)
            key = (st.st_ino, st.st_mtime_ns, st.st_size)
            if cache.get(address, (None,))[0] != key:
                cache[address] = (key, plug.read_entry(path, address)["company"])
            found[address] = cache[address][1]
        except (OSError, ValueError, UnicodeDecodeError, RecursionError):
            continue
    for address in set(cache) - set(found):
        del cache[address]
    return found


def read_ports(path):
    """{company: port} as last kept: entries out of range, or a port held twice, are left out. A file that cannot be
    read raises: the ports are never handed out again from nothing while resolvers may still hold them."""
    try:
        value = json.loads(plug.read_file(path))
    except FileNotFoundError:
        return {}
    ports, used = {}, set()
    for company, port in (value.items() if isinstance(value, dict) else ()):
        if plug.ID.match(company) and isinstance(port, int) and port in PORTS and port not in used:
            ports[company] = port
            used.add(port)
    return ports


def wanted_map(clients, rules, ports):
    """{address: port}: a machine of a company without rules to the main dnsmasq, one of a company with usable rules and
    a port to its resolver. Anything else is left out (its DNS is dropped)."""
    mapped = {}
    for address, company in clients.items():
        if company not in rules or rules[company] is False:
            continue
        if rules[company] is None:
            mapped[address] = MAIN_PORT
        elif company in ports:
            mapped[address] = ports[company]
    return mapped


def wanted_reach(clients, rules, ports, present=None):
    """{address: chain} for the reach map (E8c): "open" for a machine of a company without rules or in "open" mode,
    "only_P" for one in "only listed" mode whose resolver has port P and whose chain is there (present: those ports,
    None for all). Anything else is left out: the exit refuses its connections."""
    reach = {}
    for address, company in clients.items():
        entry = rules.get(company, False)
        if entry is False:
            continue
        if entry is None or entry["mode"] != "only-listed":
            reach[address] = "open"
        elif company in ports and (present is None or ports[company] in present):
            reach[address] = f"only_{ports[company]}"
    return reach


def reach_lines(reach, fresh=False):
    family, table = plug.EXIT_TABLE
    ordered = sorted(reach.items(), key=lambda item: ipaddress.ip_address(item[0]))
    lines = [f"flush map {family} {table} reach"] if fresh else []
    if ordered:
        lines.append(f"add element {family} {table} reach {{ {', '.join(f'{a} : goto {c}' for a, c in ordered)} }}")
    return lines


def loaded_reach(text):
    """The reach map as `nft -j list map` gives it: {address: chain}."""
    reach = {}
    for item in json.loads(text).get("nftables", []):
        for elem in item.get("map", {}).get("elem", []) or []:
            if isinstance(elem, list) and len(elem) == 2 and isinstance(elem[1], dict):
                verdict = elem[1].get("goto") or {}
                if isinstance(verdict, dict) and isinstance(verdict.get("target"), str):
                    reach[str(elem[0])] = verdict["target"]
    return reach


def element_lines(mapped, fresh=False):
    family, table = plug.EXIT_TABLE
    ordered = sorted(mapped.items(), key=lambda item: ipaddress.ip_address(item[0]))
    lines = [f"flush map {family} {table} dns_port", f"flush set {family} {table} dns_allowed"] if fresh else []
    if ordered:
        lines.append(f"add element {family} {table} dns_port {{ {', '.join(f'{a} : {p}' for a, p in ordered)} }}")
        lines.append(f"add element {family} {table} dns_allowed {{ {', '.join(f'{a} . {p}' for a, p in ordered)} }}")
    return lines


def loaded_map(text_map, text_set):
    """The map dns_port and the set dns_allowed as `nft -j list` gives them: ({address: port}, {(address, port)})."""
    mapped, allowed = {}, set()
    for item in json.loads(text_map).get("nftables", []):
        for elem in item.get("map", {}).get("elem", []) or []:
            if isinstance(elem, list) and len(elem) == 2:
                mapped[str(elem[0])] = elem[1]
    for item in json.loads(text_set).get("nftables", []):
        for elem in item.get("set", {}).get("elem", []) or []:
            parts = elem.get("concat") if isinstance(elem, dict) else None
            if isinstance(parts, list) and len(parts) == 2:
                allowed.add((str(parts[0]), parts[1]))
    return mapped, allowed


def table_handle(text, name):
    """The handle of the exit's table as `nft -j list tables` gives it. The kernel numbers each new table anew, so a
    table `up` made again has another one than the table before it."""
    for item in json.loads(text).get("nftables", []):
        found = item.get("table") or {}
        if found.get("name") == name:
            return found.get("handle")
    return None


class Names:
    def __init__(self, args):
        self.args = args
        self.kernel = os.environ.get("QORPERA_AGENT_EXIT_NAMES_NFT", "1") != "0"
        self.systemctl = os.environ.get("QORPERA_AGENT_EXIT_SYSTEMCTL", "systemctl").split()
        self.names_dir = os.path.join(args.run_dir, "names")
        self.ports_path = os.path.join(args.state_dir, "names", "ports.json")
        self.status_path = os.path.join(args.run_dir, "names.json")
        self.started_at = time.time()
        self.rules_key = None
        self.rules = None
        self.clients_cache = {}
        self.reader_bad_since = None
        self.unknown_since = {}
        self.reload_pending = set()
        self.started = {}
        self.restarted = {}
        self.unflushed = set()
        # What a reconciler before this one still owed (a reload after replacing a servers file, connections to end
        # after changing the map) is known only to it. So the first pass reloads every resolver that runs, and every
        # table not seen yet (the first, or one `up` made again from the files) has every machine's DNS connections
        # ended once its map is right.
        self.reload_all = True
        self.table = None
        self.flush_all = False
        self.machines = set()
        self.upstreams = args.upstreams.split()
        # "Only listed" (E8c): a resolver whose list got narrower is owed a restart with its set emptied, and its
        # machines' connections are ended once the reach map is right. A marker <port>.owed (written before the servers
        # file) keeps that across a restart of this reconciler: "cut" when connections are to end too.
        self.owed = {}
        self.cut = set()
        for name in os.listdir(self.names_dir) if os.path.isdir(self.names_dir) else ():
            if re.fullmatch(r"[0-9]{5}\.owed", name):
                port = int(name.removesuffix(".owed"))
                self.owed[port] = plug.read_file(os.path.join(self.names_dir, name)).strip() == "cut"
        self.objects_table = None
        self.reach_right = False
        self.reach_now = {}
        # A machine whose reach element went has every connection ended (the exit lets an established one go on): those
        # still to end. A table not seen yet has it done for every machine without an element, which keeps it across a
        # restart of this reconciler.
        self.uncut = set()
        self.problems = []

    def run(self, command):
        return subprocess.run(command, capture_output=True, text=True)

    def in_exit(self, *command):
        return self.run(["ip", "netns", "exec", self.args.netns, *command])

    def unit(self, port):
        return f"qorpera-agent-exit-resolver@{port}.service"

    # --- what is wanted ---

    def check_reader(self, at):
        """The rules reader's status: alive, and not failing for long. The last rules stay in force meanwhile."""
        try:
            status = json.loads(plug.read_file(self.args.rules_status))
            checked = plug.parse_iso(status["checkedAt"][:19] + "Z")
        except FileNotFoundError:
            self.problems.append("the rules reader is not running (no status)")
            return
        except (OSError, ValueError, KeyError, TypeError, UnicodeDecodeError):
            self.problems.append("cannot read the rules reader's status")
            return
        if at - checked > READER_SILENT:
            self.problems.append(f"the rules reader silent for {int(at - checked)}s")
        if status.get("ok") is True:
            self.reader_bad_since = None
            return
        self.reader_bad_since = self.reader_bad_since or at
        code = status.get("problem")
        code = code if isinstance(code, str) and re.fullmatch(r"[A-Z0-9_]{1,32}", code) else "unknown"
        if at - self.reader_bad_since > READER_FAILING:
            self.problems.append(f"the rules reader failing for {int(at - self.reader_bad_since)}s ({code})")

    def read_rules(self):
        """The companies' rules from rules.json (read again only when it changed). None when there are none yet; a file
        that cannot be used keeps the rules last read, and is a problem."""
        try:
            data, key = read_whole(self.args.rules, MAX_RULES_BYTES)
            if key != self.rules_key:
                self.rules, self.rules_key = parse_rules(data), key
        except FileNotFoundError:
            self.problems.append("no rules file yet: every machine's DNS is dropped until the rules reader writes it")
            self.rules, self.rules_key = None, None
        except (OSError, ValueError, UnicodeDecodeError, RecursionError) as error:
            self.problems.append(f"cannot use the rules file: {error}"[:300] +
                                 ("" if self.rules is None else "; the rules last read stay"))
        return self.rules

    def assign_ports(self, wanted, held):
        """Each wanted company keeps its port, a new one gets the lowest free one; a company no longer wanted gives its
        port back. held: ports a resolver unit still has (a port given back is not given out again until its unit is
        gone)."""
        before = read_ports(self.ports_path)
        ports = {company: port for company, port in before.items() if company in wanted}
        used = set(ports.values()) | set(before.values()) | held
        for company in sorted(wanted - set(ports)):
            free = next((port for port in PORTS if port not in used), None)
            if free is None:
                self.problems.append(f"no resolver port left for {company}: its machines get no DNS and no way out")
                continue
            ports[company] = free
            used.add(free)
        if ports != before:
            os.makedirs(os.path.dirname(self.ports_path), exist_ok=True)
            plug.write_replace(self.ports_path, json.dumps(ports, sort_keys=True) + "\n", 0o644)
        return ports

    # --- the resolvers ---

    def units(self):
        """{port: active state} of the resolver units systemd has loaded, or None when systemd cannot be asked."""
        result = self.run([*self.systemctl, "list-units", "--all", "--plain", "--no-legend", "--full",
                           "qorpera-agent-exit-resolver@*.service"])
        if result.returncode != 0:
            self.problems.append(f"cannot list the resolvers: {result.stderr.strip()[:200]}")
            return None
        found = {}
        for line in result.stdout.splitlines():
            fields = line.split()
            # A failed unit's line may start with a mark; the unit's name is the first field that is one.
            for i, field in enumerate(fields[:2]):
                m = UNIT.match(field)
                if m and len(fields) > i + 2:
                    found[int(m.group(1))] = fields[i + 2]
                    break
        return found

    def listening(self):
        """The ports on 10.210.0.1 that have both a UDP and a TCP socket listening, in the exit."""
        result = self.in_exit("ss", "-Hlntu")
        if result.returncode != 0:
            self.problems.append(f"cannot list the exit's sockets: {result.stderr.strip()[:200]}")
            return None
        found = {}
        for line in result.stdout.splitlines():
            fields = line.split()
            if len(fields) >= 5 and fields[0] in ("udp", "tcp") and fields[4].startswith(GATEWAY + ":"):
                port = fields[4].rsplit(":", 1)[1]
                if port.isdigit():
                    found.setdefault(int(port), set()).add(fields[0])
        return {port for port, kinds in found.items() if kinds == {"udp", "tcp"}}

    def write_servers(self, ports, rules, units):
        """Each wanted resolver's servers file; a resolver that runs reloads one that changed."""
        os.makedirs(self.names_dir, mode=0o755, exist_ok=True)
        for company, port in ports.items():
            path = os.path.join(self.names_dir, f"{port}.servers")
            text, mode = servers_text(rules[company], self.upstreams), rules[company]["mode"]
            try:
                before = plug.read_file(path, MAX_RULES_BYTES)
            except FileNotFoundError:
                before = None
            try:
                mode_before = plug.read_file(os.path.join(self.names_dir, f"{port}.mode")).strip()
            except FileNotFoundError:
                mode_before = None if before is None else "open"
            if before == text and mode_before == mode:
                continue
            # A reload only adds: dnsmasq reads the file again, but an address it already put in the set stays, and
            # whether it asks with --nftset is fixed when it starts. So an "only listed" resolver that is new or whose
            # list got narrower, and one that switches mode, restarts instead, with its set emptied; its machines'
            # connections then end ("cut") unless it is open now.
            restart = (mode == "only-listed" and (before is None or mode_before != mode or narrower(before, text))) or (
                mode_before == "only-listed" and mode != "only-listed")
            if restart:
                plug.write_replace(os.path.join(self.names_dir, f"{port}.owed"),
                                   "cut\n" if mode == "only-listed" else "restart\n")
                self.owed[port] = mode == "only-listed"
            # dnsmasq reads it as nobody on a reload: 0644. The lists are the company's rules, which its agents
            # and members read anyway. The mode file says how the resolver starts (qorpera-agent-exit.sh resolver).
            plug.write_replace(path, text, 0o644)
            plug.write_replace(os.path.join(self.names_dir, f"{port}.mode"), mode + "\n", 0o644)
            if not restart:
                self.reload_pending.add(port)
        if self.reload_all:
            # A reconciler before this one may have replaced a file and stopped before its reload.
            self.reload_pending |= set(ports.values())
            self.reload_all = False
        for port in sorted(self.reload_pending):
            if units.get(port) != "active" or port in self.owed:
                # Not running, or to be restarted: it reads the new file when it starts.
                self.reload_pending.discard(port)
                continue
            result = self.run([*self.systemctl, "reload", self.unit(port)])
            if result.returncode == 0:
                self.reload_pending.discard(port)
            else:
                self.problems.append(f"cannot reload the resolver on port {port}: {result.stderr.strip()[:200]}")

    def restart_owed(self, ports, units, sets):
        """Stops each wanted resolver owed a restart (`systemctl stop` returns once it is gone, so it puts no address in
        its set after this) and empties its set (sets: the ports that have one, None when that is not known: then every
        restart stays owed, and each resolver goes on with the set it has); the pass then starts it as any stopped one.
        Its machines' connections are ended after the reach map (cut_owed)."""
        if sets is None:
            return
        family, table = plug.EXIT_TABLE
        for port, cut in sorted(self.owed.items()):
            if port not in ports.values():
                continue
            if units.get(port) not in (None, "inactive", "failed"):
                result = self.run([*self.systemctl, "stop", self.unit(port)])
                if result.returncode != 0:
                    self.problems.append(f"cannot stop the resolver on port {port}: {result.stderr.strip()[:200]}")
                    continue
                units[port] = "inactive"
            if port in sets and self.kernel:
                result = self.in_exit("nft", "flush", "set", family, table, f"allow_{port}")
                if result.returncode != 0:
                    self.problems.append(f"cannot empty the set of port {port}: {result.stderr.strip()[:200]}")
                    continue
            del self.owed[port]
            if cut:
                self.cut.add(port)
            else:
                plug.remove(os.path.join(self.names_dir, f"{port}.owed"))

    def cut_owed(self, clients, ports):
        """Ends every connection of each machine of a company whose list got narrower, once the reach map is right:
        a connection let through before goes on otherwise, as the exit judges only new ones."""
        if not self.reach_right:
            return
        for port in sorted(self.cut):
            companies = {c for c, p in ports.items() if p == port}
            done = True
            for address in sorted(a for a, c in clients.items() if c in companies and self.kernel):
                result = self.in_exit("conntrack", "-D", "-s", address)
                if result.returncode != 0 and not (result.returncode == 1 and "0 flow entries" in result.stderr):
                    done = False
            if done:
                plug.remove(os.path.join(self.names_dir, f"{port}.owed"))
                self.cut.discard(port)
            else:
                self.problems.append(f"the connections of the machines on port {port} could not be ended yet")

    def start(self, port, at, again=False):
        """Starts a resolver's unit; again: restarts one that runs but does not answer (stuck, or left in an old
        namespace by an up that rebuilt it and stopped before it restarted the resolvers), then gives it START_GRACE
        before it restarts it again."""
        if again:
            if at - self.restarted.get(port, 0) <= START_GRACE:
                return
            self.restarted[port] = at
        self.run([*self.systemctl, "reset-failed", self.unit(port)])
        result = self.run([*self.systemctl, "restart" if again else "start", "--no-block", self.unit(port)])
        if result.returncode != 0:
            self.problems.append(f"cannot start the resolver on port {port}: {result.stderr.strip()[:200]}")
        self.started.setdefault(port, at)

    def stop_unwanted(self, ports, units):
        """Stops each resolver no company needs, then removes its file."""
        wanted = set(ports.values())
        stopped = set()
        for port in sorted(set(units) - wanted):
            if units[port] not in ("inactive", "failed"):
                result = self.run([*self.systemctl, "stop", self.unit(port)])
                if result.returncode != 0:
                    self.problems.append(f"cannot stop the resolver on port {port}: {result.stderr.strip()[:200]}")
                    continue
            self.run([*self.systemctl, "reset-failed", self.unit(port)])
            stopped.add(port)
        for name in os.listdir(self.names_dir):
            port, _, kind = name.partition(".")
            if kind in ("servers", "mode", "owed") and port.isdigit() and int(port) not in wanted and (
                    int(port) in stopped or int(port) not in units):
                plug.remove(os.path.join(self.names_dir, name))
        for times in (self.started, self.restarted):
            for port in set(times) - wanted:
                del times[port]
        self.reload_pending &= wanted
        self.owed = {port: cut for port, cut in self.owed.items() if port in wanted}
        self.cut &= wanted

    # --- the map ---

    def sync_map(self, mapped, waiting=frozenset(), reach=None):
        """Makes dns_port and dns_allowed hold `mapped` and the reach map `reach` (None: empty, every machine refused),
        in one transaction, and ends the DNS connections of every machine whose resolver changed or went, and of every
        machine once in each table not seen before; and every connection of a machine whose reach element went (the
        exit judges only new ones), and once in each table not seen before of every machine without one. While a
        resolver is in `waiting` (started under START_GRACE ago, not answering yet) a machine of it keeps the element
        it has if that is the main dnsmasq or this resolver, and gets none otherwise: a company that just got rules has
        names meanwhile, and its rules apply once its resolver answers. Returns the map as it is now ({} when it cannot
        be read)."""
        self.reach_right, self.reach_now, reach = False, {}, {} if reach is None else reach
        if not self.kernel:
            self.reach_right, self.reach_now = True, reach
            return mapped
        family, table = plug.EXIT_TABLE
        answers = [self.in_exit("nft", "-j", "list", "tables", family)]
        answers += [self.in_exit("nft", "-j", "list", what, family, table, name)
                    for what, name in (("map", "dns_port"), ("set", "dns_allowed"), ("map", "reach"))]
        failed = [a for a in answers if a.returncode != 0]
        if failed:
            self.problems.append(f"cannot read the exit's DNS map: {failed[0].stderr.strip()[:200]}")
            return {}
        handle = table_handle(answers[0].stdout, table)
        if handle != self.table:
            # Connections made before this table may still go where an older map sent them, to the main dnsmasq
            # before a company had rules (an exit upgraded to E8b-2 included).
            self.table, self.flush_all = handle, True
        loaded, allowed = loaded_map(answers[1].stdout, answers[2].stdout)
        reached = self.reach_now = loaded_reach(answers[3].stdout)
        mapped = {address: loaded[address] if port in waiting else port for address, port in mapped.items()
                  if port not in waiting or loaded.get(address) in (MAIN_PORT, port)}
        if loaded != mapped or allowed != set(mapped.items()) or reached != reach:
            # The reach map in the same transaction (E8c): a machine's names and where it may go change together.
            lines = element_lines(mapped, fresh=True) + reach_lines(reach, fresh=True)
            result = subprocess.run(["ip", "netns", "exec", self.args.netns, "nft", "-f", "-"],
                                    input="\n".join(lines) + "\n", capture_output=True, text=True)
            if result.returncode != 0:
                self.problems.append(f"cannot set the exit's DNS map: {result.stderr.strip()[:200]}")
                return loaded
            self.unflushed |= {address for address, port in loaded.items() if mapped.get(address) != port}
            self.uncut |= set(reached) - set(reach)
        self.reach_right, self.reach_now = True, reach
        if self.flush_all:
            self.unflushed |= set(loaded) | set(mapped) | self.machines
            self.uncut |= (set(loaded) | set(reached) | self.machines) - set(reach)
            self.flush_all = False
        for address in sorted(self.uncut):
            result = self.in_exit("conntrack", "-D", "-s", address)
            if result.returncode == 0 or (result.returncode == 1 and "0 flow entries" in result.stderr):
                self.uncut.discard(address)
            else:
                self.problems.append(f"the connections of {address} could not be ended yet")
        for address in sorted(self.unflushed):
            if self.flush(address):
                self.unflushed.discard(address)
            else:
                self.problems.append(f"the DNS connections of {address} could not be ended yet")
        return mapped

    def flush(self, address):
        """Ends a machine's DNS connections in the exit: to any address on 53, and to the exit's own address."""
        done = True
        for command in (("-p", "udp", "--dport", "53"), ("-p", "tcp", "--dport", "53"), ("-d", GATEWAY)):
            result = self.in_exit("conntrack", "-D", "-s", address, *command)
            if result.returncode != 0 and not (result.returncode == 1 and "0 flow entries" in result.stderr):
                done = False
        return done

    # --- "only listed" (E8c): each such company's set and chain ---

    def sync_objects(self, needed):
        """Makes the exit's table hold allow_P and only_P for each port in `needed`, before its resolver starts and its
        machines' reach elements go to only_P. A table not seen before (one `up` made again, with its sets empty) has
        those resolvers reloaded, so they ask again (a reload empties dnsmasq's cache; an answer from it fills no set).
        Returns the ports that have them now, and the ports that have them and are not needed; None and an empty set
        when the table cannot be read (which ports have a set is not known then)."""
        if not self.kernel:
            return set(needed), set()
        family, table = plug.EXIT_TABLE
        answers = [self.in_exit("nft", "-j", "list", what, family) for what in ("tables", "chains")]
        failed = [a for a in answers if a.returncode != 0]
        if failed:
            self.problems.append(f"cannot read the exit's chains: {failed[0].stderr.strip()[:200]}")
            return None, set()
        handle = table_handle(answers[0].stdout, table)
        have = only_chains(answers[1].stdout, table)
        if needed - have:
            lines = [line for port in sorted(needed - have) for line in object_lines(port)]
            result = subprocess.run(["ip", "netns", "exec", self.args.netns, "nft", "-f", "-"],
                                    input="\n".join(lines) + "\n", capture_output=True, text=True)
            if result.returncode != 0:
                self.problems.append(f"cannot make the only-listed chains: {result.stderr.strip()[:200]}")
                return have & needed, have - needed
        if handle != self.objects_table:
            self.objects_table = handle
            self.reload_pending |= needed
        return set(needed), have - needed

    def drop_objects(self, extra):
        """Removes the set and chain of each port in `extra` (no company in "only listed" has it now), once no reach
        element goes to the chain any more."""
        if not extra or not self.kernel or not self.reach_right:
            return
        family, table = plug.EXIT_TABLE
        lines = [line for port in sorted(extra) for line in (
            f"flush chain {family} {table} only_{port}", f"delete chain {family} {table} only_{port}",
            f"destroy set {family} {table} allow_{port}")]
        result = subprocess.run(["ip", "netns", "exec", self.args.netns, "nft", "-f", "-"],
                                input="\n".join(lines) + "\n", capture_output=True, text=True)
        if result.returncode != 0:
            self.problems.append(f"cannot remove the only-listed chains: {result.stderr.strip()[:200]}")

    # --- one pass ---

    def pass_once(self):
        self.problems = []
        at = time.time()
        self.check_reader(at)
        rules = self.read_rules()
        clients = verified_clients(self.args.state_dir, self.clients_cache)
        self.machines = set(clients)
        if rules is None:
            return self.write_status(at, {}, self.sync_map({}))
        for company in sorted({c for c in clients.values() if rules.get(c) is False}):
            self.problems.append(
                f"{company}: its rules are not as the rules reader writes them; its machines get no DNS and no way out")
        self.unknown_since = {c: self.unknown_since.get(c, at) for c in clients.values() if c not in rules}
        for company, since in sorted(self.unknown_since.items()):
            if at - since > UNKNOWN_GRACE:
                self.problems.append(
                    f"{company}: not in the rules file for {int(at - since)}s; its machines get no DNS and no way out")
        wanted = {c for c in clients.values() if rules.get(c)}
        units = self.units()
        if units is None:
            # Without systemd's view no port is handed out or given back (one may still have a resolver): the
            # machines of the companies with a port keep it, and nothing is started or stopped.
            ports = {c: p for c, p in read_ports(self.ports_path).items() if c in wanted}
            present, _ = self.sync_objects({p for c, p in ports.items() if rules[c]["mode"] == "only-listed"})
            return self.write_status(at, ports, self.sync_map(wanted_map(clients, rules, ports),
                                                              reach=wanted_reach(clients, rules, ports, present or set())))
        ports = self.assign_ports(wanted, set(units))
        present, extra = self.sync_objects({p for c, p in ports.items() if rules[c]["mode"] == "only-listed"})
        self.write_servers(ports, rules, units)
        self.restart_owed(ports, units, None if present is None else present | extra)
        for port in sorted(set(ports.values())):
            if units.get(port) in (None, "inactive", "failed"):
                self.start(port, at)
        waiting = set()
        answering = self.listening() if self.kernel and ports else set(ports.values())
        for company, port in sorted(ports.items()):
            if answering is None:
                break
            if port in answering:
                self.started.pop(port, None)
                self.restarted.pop(port, None)
            elif at - self.started.setdefault(port, at) <= START_GRACE:
                waiting.add(port)
            else:
                # Waited on once (start keeps the first time), not again: its machines have no DNS until it answers.
                # One that is not running was started above.
                self.problems.append(f"the resolver of {company} (port {port}) is not answering")
                if units.get(port) == "active":
                    self.start(port, at, again=True)
        mapped = self.sync_map(wanted_map(clients, rules, ports), waiting,
                               wanted_reach(clients, rules, ports, present or set()))
        self.cut_owed(clients, ports)
        self.stop_unwanted(ports, units)
        self.drop_objects(extra)
        return self.write_status(at, ports, mapped)

    def write_status(self, at, ports, mapped):
        status = {"schema": STATUS_SCHEMA, "at": plug.now_iso(at), "resolvers": ports, "mapped": mapped,
                  "reach": self.reach_now, "problems": self.problems}
        plug.write_replace(self.status_path, json.dumps(status, sort_keys=True) + "\n")
        for problem in self.problems:
            print(f"problem: {problem}", file=sys.stderr, flush=True)
        return status


def elements(args):
    """For `up`: the maps as the files say now (the rules, the verified machines, the ports kept), with the set and
    chain of each company in "only listed" before its machines' reach elements. Prints nothing when there are no rules
    yet; the reconciler sets the maps right within a pass."""
    try:
        rules = parse_rules(read_whole(args.rules, MAX_RULES_BYTES)[0])
        ports = read_ports(os.path.join(args.state_dir, "names", "ports.json"))
    except (OSError, ValueError, UnicodeDecodeError, RecursionError):
        return []
    clients = verified_clients(args.state_dir)
    only = sorted({port for company, port in ports.items() if (rules.get(company) or {}).get("mode") == "only-listed"})
    return ([line for port in only for line in object_lines(port)] + element_lines(wanted_map(clients, rules, ports)) +
            reach_lines(wanted_reach(clients, rules, ports)))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("reconcile", "elements"))
    env = os.environ.get
    parser.add_argument("--state-dir", default=env("QORPERA_AGENT_EXIT_STATE_DIR", "/var/lib/qorpera-agent-exit"))
    parser.add_argument("--run-dir", default=env("QORPERA_AGENT_EXIT_RUN_DIR", "/run/qorpera-agent-exit"))
    parser.add_argument("--rules", default=env("QORPERA_AGENT_EXIT_NETWORK_RULES"))
    parser.add_argument("--rules-status", default=env("QORPERA_AGENT_EXIT_RULES_STATUS",
                                                      "/run/qorpera-agent-exit-rules/status.json"))
    parser.add_argument("--netns", default="qexit")
    # The main dnsmasq's upstreams (qorpera-agent-exit.sh passes its own): an "only listed" servers file names them.
    parser.add_argument("--upstreams", default=env("QORPERA_AGENT_EXIT_UPSTREAMS", "9.9.9.9 1.1.1.1"))
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--interval", type=float, default=float(env("QORPERA_AGENT_EXIT_NAMES_INTERVAL", "2")))
    args = parser.parse_args()
    args.rules = args.rules or os.path.join(args.state_dir, "rules", "rules.json")
    if not all(re.fullmatch(r"[0-9a-fA-F.:]+(?:#[0-9]{1,5})?", u) for u in args.upstreams.split()):
        parser.error("--upstreams: addresses (with #port), separated by spaces")
    if args.command == "elements":
        for line in elements(args):
            print(line)
        return
    os.makedirs(os.path.join(args.run_dir, "names"), mode=0o755, exist_ok=True)
    names = Names(args)
    while True:
        try:
            names.pass_once()
        except Exception as error:  # noqa: BLE001 - one bad pass is reported; the next one runs
            names.problems = [f"{type(error).__name__}: {error}"[:300]]
            names.write_status(time.time(), {}, {})
        if args.once:
            return
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
