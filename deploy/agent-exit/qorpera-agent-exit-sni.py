#!/usr/bin/env python3
"""Qorpera agent exit (E8c-2): the server name check of "only listed" companies.

"Only listed" (E8c-1) lets a machine's TCP 443 out only to an address its company's resolver gave out for an allowed
name. An address can serve many names (a CDN), so this checker also reads the name the machine asks that server for,
the server name (SNI) in the TLS ClientHello it sends first, and lets the connection on only when the company's rules
allow that name and block none over it (as its resolver answers names).

The company's chain only_<port> marks each such flow (ct mark 1) as it lets the flow's first packet on to the chain
open. When the kernel has nft_queue and nfnetlink_queue loaded (and only then: nft and this checker would load them),
the exit's base chain sni (forward, after the filter chain) sends every packet of a marked flow to queue 0, which this
checker (root, in the exit's namespace) reads. A packet from a machine's address (10.210.0.0/16; agent_out drops any
other source from the bridge) is the machine's, any other the server's:
- a packet from the machine with no data (the SYN, an ACK) goes on at once; its SYN says where the flow's data starts;
  a SYN queued for a flow judged already is a new connection's on the same ports (a judged flow is queued no more);
- the machine's data is held (the kernel keeps the packets, the checker their bytes) until the flow's first bytes are
  a whole ClientHello: at most 16 KiB of it (and its record headers), for at most 5 seconds, in at most 64 packets,
  with at most 512 packets held for one machine's flows together. The node has one queue, of 8192 packets, for every
  company: so one machine cannot fill it. A packet that brings no new byte (its bytes held already, or past what a
  ClientHello can take) is dropped, not held, and TCP sends it again;
- a ClientHello with one server name the rules allow lets every held packet on, as they were. The flow stays marked
  until the server acknowledges the ClientHello's bytes; until then the machine's packets that carry any of them again
  must carry the same bytes. That server packet goes back to the chain with the meta mark 0x80000001, and the chain
  marks the flow 2: its later packets are not queued;
- anything else is refused: no TLS, no server name or more than one, a name not allowed or blocked, a ClientHello too
  big, too slow or in too many packets, a machine holding too many packets, bytes sent again that differ, urgent data,
  a flow whose SYN this checker did not see (it started after the SYN), a machine not verified, a company not in the
  rules file or with rules that cannot be used. The machine's packet goes back to the chain with the meta mark
  0x80000002: the chain marks the flow 3 and refuses it (counter refused_name; the machine's connection is reset), and
  the other held packets are dropped.
A company without rules now (it was "only listed" when the flow started) has its flows let on, and one in "open"
mode now has them let on unless the name is blocked.

There is no bypass and no fail-open: with no checker bound to the queue the kernel drops the packets, and when the
checker's socket closes it drops the ones held. TCP sends them again; the checker started again (the unit's
Restart=always, one second later) judges the new flows, and refuses the data of the ones whose SYN came before it.
The checker leaves when the exit's namespace is made again (`up`), so systemd starts it in the new one. Its status
names the kernel's drops from the queue (full, or the checker behind) for a minute after the last one.

  qorpera-agent-exit-sni.py check     (root, in the exit's namespace; the sni unit)
"""

import argparse
import importlib.util
import ipaddress
import json
import os
import re
import select
import socket
import struct
import sys
import time


def load_names():
    """The names reconciler's module (the rules file and the verified machines), from beside this file."""
    path = os.environ.get("QORPERA_AGENT_EXIT_NAMES") or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "qorpera-agent-exit-names.py")
    spec = importlib.util.spec_from_file_location("qorpera_agent_exit_names", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


names = load_names()
plug = names.plug

STATUS_SCHEMA = "qorpera.agent-exit-sni/v1"
QUEUE = 0
LISTED = 0x80000001
REFUSED = 0x80000002
HELLO_MAX = 16 * 1024
STREAM_MAX = HELLO_MAX + 1024
HOLD_TIME = 5
FLOW_HELD = 64              # a whole 16 KiB ClientHello is 12 full segments, or 31 of 536 bytes
MACHINE_HELD = 512
FLOW_IDLE = 120
DROPS_SHOWN = 60
AGENTS = ipaddress.ip_network("10.210.0.0/16")    # AGENTS in qorpera-agent-exit.sh
QUEUE_MODULE = "/sys/module/nfnetlink_queue"
QUEUE_ROWS = "/proc/net/netfilter/nfnetlink_queue"
HOST = re.compile(rf"(?:{names.LABEL}\.)*{names.LABEL}")

DROP, ACCEPT, REPEAT = 0, 1, 4
SYN, RST, ACK, URG = 0x02, 0x04, 0x10, 0x20


class Reader:
    """A ClientHello's fields, each length checked: any that does not fit raises ValueError."""

    def __init__(self, data):
        self.data, self.at = data, 0

    def take(self, size):
        if self.at + size > len(self.data):
            raise ValueError("short")
        self.at += size
        return self.data[self.at - size:self.at]

    def number(self, size):
        return int.from_bytes(self.take(size), "big")

    def vector(self, size, least, most):
        length = self.number(size)
        if not least <= length <= most:
            raise ValueError("length")
        return self.take(length)

    def done(self):
        return self.at == len(self.data)


def host_name(data):
    """The host name of a server_name extension: exactly one entry, of type host_name, a name as the rules write one."""
    entries = Reader(Reader(data).vector(2, 1, 65535))
    if len(data) != 2 + len(entries.data):
        raise ValueError("server_name")
    kind, name = entries.number(1), entries.vector(2, 1, 65535)
    if kind != 0 or not entries.done():
        return None
    name = name.decode("ascii", "replace").lower()
    return name if HOST.fullmatch(name) and names.valid_name(name) else None


def server_name(body, end):
    """("name", (name, end)) for a ClientHello body with one server name, ("bad", why) otherwise."""
    try:
        hello = Reader(body)
        hello.take(2 + 32)
        hello.vector(1, 0, 32)
        hello.vector(2, 2, 65534)
        hello.vector(1, 1, 255)
        if hello.done():
            return "bad", "no server name"
        extensions = Reader(hello.vector(2, 0, 65535))
        if not hello.done():
            return "bad", "not a ClientHello"
        seen, name = set(), None
        while not extensions.done():
            kind, data = extensions.number(2), extensions.vector(2, 0, 65535)
            if kind in seen:
                return "bad", "an extension twice"
            seen.add(kind)
            if kind == 0:
                name = host_name(data)
                if name is None:
                    return "bad", "a server name that is not one host name"
    except ValueError:
        return "bad", "not a ClientHello"
    return ("name", (name, end)) if name else ("bad", "no server name")


def client_hello(data):
    """What a flow's first bytes say: ("more", None) while they may still become a ClientHello within STREAM_MAX bytes,
    ("name", (name, end)) for a whole one with one server name (end: where the record with its last byte ends; nothing
    else may be in its records), ("bad", why) otherwise."""
    hello, at = b"", 0
    while True:
        if len(data) < at + 5:
            return ("more", None) if at + 5 <= STREAM_MAX else ("bad", "a ClientHello over 16 KiB")
        kind, major, length = data[at], data[at + 1], int.from_bytes(data[at + 3:at + 5], "big")
        if kind != 22 or major != 3 or not 0 < length <= 16384:
            return "bad", "not TLS"
        if at + 5 + length > STREAM_MAX:
            return "bad", "a ClientHello over 16 KiB"
        if len(data) < at + 5 + length:
            return "more", None
        hello += data[at + 5:at + 5 + length]
        at += 5 + length
        if len(hello) >= 4:
            if hello[0] != 1:
                return "bad", "not a ClientHello"
            size = 4 + int.from_bytes(hello[1:4], "big")
            if size > 4 + HELLO_MAX:
                return "bad", "a ClientHello over 16 KiB"
            if len(hello) > size:
                return "bad", "more than a ClientHello in its records"
            if len(hello) == size:
                return server_name(hello[4:], at)


def matches(rule, name):
    """Whether a name in the rules covers `name`: itself and every name under it, `*.x` only the names under x."""
    base = rule.removeprefix("*.")
    return name.endswith("." + base) or (name == base and not rule.startswith("*."))


def allowed(rules, name):
    """Whether a company's rules let its machines ask a server for `name`. "Only listed": an allowed name covers it and
    no blocked one does, as its resolver answers names (a blocked name under an allowed one stays unanswered). "Open":
    every name not blocked, and no rules: every name (its machines go to the chain open now). Rules that cannot be used
    (False): none."""
    if rules is None:
        return True
    if not rules:
        return False
    if any(matches(b, name) for b in rules["block"]):
        return False
    return rules["mode"] == "open" or any(matches(a, name) for a in rules["allow"])


def tcp_packet(data):
    """(client side, server side, sequence, acknowledgement, flags, payload) of an IPv4 TCP packet, "other" for another
    protocol, None for one that cannot be read."""
    if len(data) < 20 or data[0] >> 4 != 4:
        return None
    head, total = (data[0] & 15) * 4, int.from_bytes(data[2:4], "big")
    if data[9] != 6:
        return "other"
    if head < 20 or total > len(data) or total < head + 20 or int.from_bytes(data[6:8], "big") & 0x3FFF:
        return None
    tcp = data[head:total]
    offset = (tcp[12] >> 4) * 4
    if offset < 20 or offset > len(tcp):
        return None
    source = (socket.inet_ntoa(data[12:16]), int.from_bytes(tcp[0:2], "big"))
    target = (socket.inet_ntoa(data[16:20]), int.from_bytes(tcp[2:4], "big"))
    return (source, target, int.from_bytes(tcp[4:8], "big"), int.from_bytes(tcp[8:12], "big"), tcp[13],
            bytes(tcp[offset:]))


class Flow:
    def __init__(self, start, at):
        self.start = start          # the sequence number of the flow's first data byte (the SYN's + 1)
        self.state = "waiting"      # waiting -> passed (server not past the hello yet) -> done; or refused
        self.held = []
        self.since = None
        self.seen = at
        self.data = None
        self.known = None
        self.filled = 0
        self.hello = b""


class Judge:
    """The checker's flows and verdicts, apart from the queue (the proof drives it with made-up packets). Each call
    gives back (packet id, verdict, mark) for the packets it judged: ACCEPT (on as it was), REPEAT (back to the chain
    with the mark), DROP."""

    def __init__(self, decide, report=lambda line: print(line, file=sys.stderr, flush=True)):
        self.decide = decide        # (machine address, server name) -> None when allowed, or why not
        self.report = report
        self.flows = {}
        self.holding = {}           # machine address -> the packets its flows hold
        self.refused = 0

    def packet(self, ident, data, at):
        """One queued packet: the machine's when it comes from a machine's address, else the server's."""
        parsed = tcp_packet(data)
        if parsed is None:
            return [(ident, DROP, 0)]
        if parsed == "other":
            return [(ident, ACCEPT, 0)]
        source, target, seq, ack, flags, payload = parsed
        outbound = ipaddress.IPv4Address(source[0]) in AGENTS
        key = (source, target) if outbound else (target, source)
        flow = self.flows.get(key)
        if flow:
            flow.seen = at
        if not outbound:
            return self.inbound(key, flow, ident, ack, flags)
        if flags & URG:
            # The server takes an urgent byte out of the bytes it reads, so it would not read the ClientHello judged.
            flow = flow or self.flows.setdefault(key, Flow(None, at))
            return [(ident, DROP, 0)] if flow.state == "refused" else self.refuse(key, flow, ident, "urgent data")
        if flags & RST:
            self.flows.pop(key, None)
            return ([(i, DROP, 0) for i in self.release(key, flow)] if flow else []) + [(ident, ACCEPT, 0)]
        if flags & SYN:
            # A flow judged (ct mark 2 or 3) is queued no more, so a SYN queued for it is a new connection's.
            if (flow is None or flow.state in ("done", "refused") or
                    (flow.state == "waiting" and not flow.held and flow.data is None)):
                flow = self.flows[key] = Flow((seq + 1) & 0xFFFFFFFF, at)
            elif flow.start != (seq + 1) & 0xFFFFFFFF:
                return self.refuse(key, flow, ident, "a SYN again, with another sequence number")
            if not payload:
                return [(ident, ACCEPT, 0)]
            seq = flow.start
        elif flow is None:
            if not payload:
                return [(ident, ACCEPT, 0)]
            flow = self.flows[key] = Flow(None, at)
            return self.refuse(key, flow, ident, "data of a flow whose SYN came before the checker started")
        if flow.state == "refused":
            return [(ident, DROP, 0)]
        if not payload:
            return [(ident, ACCEPT, 0)]
        offset = (seq - flow.start) & 0xFFFFFFFF
        if offset >= 1 << 31:
            return self.refuse(key, flow, ident, "data before the flow's start")
        if flow.state != "waiting":
            hello = flow.hello[offset:offset + len(payload)]
            if payload[:len(hello)] != hello:
                return self.refuse(key, flow, ident, "the ClientHello's bytes again, other ones")
            return [(ident, ACCEPT, 0)]
        if flow.data is None:
            flow.data, flow.known, flow.since = bytearray(STREAM_MAX), bytearray(STREAM_MAX), at
        end = min(offset + len(payload), STREAM_MAX)
        known = flow.known[offset:end]
        if known.count(1) and any(k and a != b for k, a, b in zip(known, flow.data[offset:end], payload)):
            return self.refuse(key, flow, ident, "the ClientHello's bytes again, other ones")
        if not known.count(0):
            # No new byte (all held already, or past what a ClientHello can take): holding it would only fill the
            # queue every company shares. TCP sends it again after the verdict.
            return [(ident, DROP, 0)]
        machine = key[0][0]
        if len(flow.held) >= FLOW_HELD:
            return self.refuse(key, flow, ident, f"more than {FLOW_HELD} packets for one ClientHello")
        if self.holding.get(machine, 0) >= MACHINE_HELD:
            return self.refuse(key, flow, ident, f"its machine holds {MACHINE_HELD} packets already")
        flow.data[offset:end], flow.known[offset:end] = payload[:end - offset], b"\x01" * (end - offset)
        while flow.filled < STREAM_MAX and flow.known[flow.filled]:
            flow.filled += 1
        flow.held.append(ident)
        self.holding[machine] = self.holding.get(machine, 0) + 1
        kind, value = client_hello(bytes(flow.data[:flow.filled]))
        if kind == "more":
            return []
        if kind == "bad":
            return self.refuse(key, flow, ident, value)
        name, hello_end = value
        why = self.decide(key[0][0], name)
        if why:
            return self.refuse(key, flow, ident, f"{name}: {why}")
        flow.state, flow.hello = "passed", bytes(flow.data[:hello_end])
        flow.data = flow.known = None
        return [(i, ACCEPT, 0) for i in self.release(key, flow)]

    def inbound(self, key, flow, ident, ack, flags):
        """A packet from the server: the one that acknowledges a passed ClientHello unmarks the flow."""
        if flow is None or flow.state == "waiting":
            return [(ident, ACCEPT, 0)]
        if flow.state == "refused":
            return [(ident, DROP, 0)]
        if flow.state == "passed" and flags & ACK:
            past = (ack - flow.start) & 0xFFFFFFFF
            if len(flow.hello) <= past < 1 << 31:
                flow.state = "done"
                return [(ident, REPEAT, LISTED)]
        return [(ident, ACCEPT, 0)]

    def refuse(self, key, flow, ident, why):
        (machine, port), (server, server_port) = key
        self.refused += 1
        self.report(f"refused {machine}:{port} -> {server}:{server_port}: {why}")
        held = [i for i in self.release(key, flow) if i != ident]
        flow.state, flow.data, flow.known = "refused", None, None
        return [(i, DROP, 0) for i in held] + [(ident, REPEAT, REFUSED)]

    def release(self, key, flow):
        """The packets the flow held, which it holds no more."""
        held, flow.held = flow.held, []
        machine = key[0][0]
        left = self.holding.get(machine, 0) - len(held)
        if left > 0:
            self.holding[machine] = left
        else:
            self.holding.pop(machine, None)
        return held

    def expire(self, at):
        """Refuses the flows that held data too long and forgets the ones not seen for FLOW_IDLE seconds."""
        verdicts = []
        for key, flow in list(self.flows.items()):
            if flow.state == "waiting" and flow.held and at - flow.since > HOLD_TIME:
                first = flow.held[0]
                verdicts += self.refuse(key, flow, first, f"no whole ClientHello within {HOLD_TIME} seconds")
            elif at - flow.seen > FLOW_IDLE:
                del self.flows[key]
        return verdicts


NETLINK_NETFILTER = 12
NFNL_SUBSYS_QUEUE = 3
MSG_PACKET, MSG_VERDICT, MSG_CONFIG = 0, 1, 2
NLMSG_ERROR = 2
NLM_F_REQUEST, NLM_F_ACK = 1, 4
CFG_CMD, CFG_PARAMS, CFG_QUEUE_MAXLEN = 1, 2, 3
CMD_BIND = 1
COPY_PACKET = 2
A_PACKET_HDR, A_VERDICT_HDR, A_MARK, A_PAYLOAD = 1, 2, 3, 10
SO_RCVBUFFORCE = 33


def attribute(kind, value):
    return struct.pack("=HH", 4 + len(value), kind) + value + b"\0" * (-len(value) % 4)


def attributes(data):
    found, at = {}, 0
    while at + 4 <= len(data):
        length, kind = struct.unpack_from("=HH", data, at)
        if length < 4:
            break
        found[kind & 0x3FFF] = data[at + 4:at + length]
        at += (length + 3) & ~3
    return found


class Queue:
    """A queue of this namespace over nfnetlink (python3 alone, no library): bound, copying whole packets."""

    def __init__(self, number, length):
        self.number, self.seq = number, 0
        self.sock = socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, NETLINK_NETFILTER)
        self.sock.setsockopt(socket.SOL_SOCKET, SO_RCVBUFFORCE, 16 << 20)
        self.sock.bind((0, 0))
        self.request(attribute(CFG_CMD, struct.pack("!BxH", CMD_BIND, 0)))
        self.request(attribute(CFG_PARAMS, struct.pack("!IB", 0xFFFF, COPY_PACKET)))
        self.request(attribute(CFG_QUEUE_MAXLEN, struct.pack("!I", length)))

    def message(self, kind, payload, flags):
        self.seq += 1
        body = struct.pack("!BBH", socket.AF_UNSPEC, 0, self.number) + payload
        return struct.pack("=IHHII", 16 + len(body), (NFNL_SUBSYS_QUEUE << 8) | kind, flags, self.seq, 0) + body

    def request(self, payload):
        """One config message, answered: an error raises OSError. Packets queued meanwhile (before the copy mode is
        set they come without their bytes) are dropped; TCP sends them again. Their verdicts take sequence numbers of
        their own, so the answer is matched to the request's."""
        self.sock.send(self.message(MSG_CONFIG, payload, NLM_F_REQUEST | NLM_F_ACK))
        asked = self.seq
        while True:
            for kind, seq, body in self.receive():
                if kind == NLMSG_ERROR and seq == asked:
                    error = struct.unpack_from("=i", body)[0]
                    if error:
                        raise OSError(-error, os.strerror(-error))
                    return
                if kind == (NFNL_SUBSYS_QUEUE << 8) | MSG_PACKET:
                    ident = self.packet(body)[0]
                    if ident is not None:
                        self.verdict(ident, DROP, 0)

    def receive(self):
        """The messages of one read: (type, sequence, body). A full socket (ENOBUFS) raises: the checker leaves, and
        the kernel drops what it held."""
        data, at, found = self.sock.recv(1 << 20), 0, []
        while at + 16 <= len(data):
            length, kind, _flags, seq, _pid = struct.unpack_from("=IHHII", data, at)
            if length < 16:
                break
            found.append((kind, seq, data[at + 16:at + length]))
            at += (length + 3) & ~3
        return found

    @staticmethod
    def packet(body):
        """(packet id, payload) of a packet message (after its nfgenmsg)."""
        found = attributes(body[4:])
        head = found.get(A_PACKET_HDR)
        if not head or len(head) < 4:
            return None, b""
        return struct.unpack_from("!I", head)[0], found.get(A_PAYLOAD, b"")

    def verdict(self, ident, verdict, mark):
        payload = attribute(A_VERDICT_HDR, struct.pack("!II", verdict, ident))
        if verdict == REPEAT:
            payload += attribute(A_MARK, struct.pack("!I", mark))
        self.sock.send(self.message(MSG_VERDICT, payload, NLM_F_REQUEST))


class Checker:
    """The sni unit: the queue, the rules and the verified machines, the namespace and the status file."""

    def __init__(self, args):
        self.args = args
        self.rules, self.rules_key, self.rules_at = None, None, None
        self.machines, self.machines_cache, self.machines_at = {}, {}, None
        self.problems = []
        self.judge = Judge(self.decide)
        self.namespace = os.stat("/proc/self/ns/net").st_ino
        self.status_path = os.path.join(args.run_dir, "sni.json")
        self.queue_rows = QUEUE_ROWS
        self.dropped, self.dropped_at = 0, None

    def decide(self, machine, name):
        """None when the machine's company allows `name` now, or why not (rules and machines read at most once a
        second)."""
        at = time.monotonic()
        if self.rules_at is None or at - self.rules_at >= 1:
            self.rules_at = at
            self.read_rules()
        if self.machines_at is None or at - self.machines_at >= 1:
            self.machines_at = at
            self.machines = names.verified_clients(self.args.state_dir, self.machines_cache)
        company = self.machines.get(machine)
        if company is None:
            return "not a verified machine"
        if self.rules is None or company not in self.rules:
            return "its company is not in the rules file"
        return None if allowed(self.rules[company], name) else "not allowed"

    def read_rules(self):
        """As the names reconciler reads them: no file, no rules (every flow is refused); a file that cannot be used
        keeps the rules last read."""
        try:
            data, key = names.read_whole(self.args.rules, names.MAX_RULES_BYTES)
            if key != self.rules_key:
                self.rules, self.rules_key = names.parse_rules(data), key
            self.problems = []
        except FileNotFoundError:
            self.rules, self.rules_key = None, None
            self.problems = ["no rules file: every flow is refused"]
        except (OSError, ValueError, UnicodeDecodeError, RecursionError) as error:
            self.problems = [f"cannot use the rules file: {error}"[:300] + ("" if self.rules is None else
                                                                             "; the rules last read stay")]

    def moved(self):
        """Whether the exit's namespace is no longer the one this checker runs in (`up` made it again)."""
        try:
            return os.stat(self.args.netns_path).st_ino != self.namespace
        except OSError:
            return True

    def queue_counts(self):
        """The kernel's row for this checker's queue (none until it is bound): the packets in it now, and those the
        kernel dropped since the checker bound it, as the queue was full or the checker's socket was."""
        with open(self.queue_rows) as rows:
            for row in rows:
                fields = row.split()
                if len(fields) >= 7 and fields[0] == str(self.args.queue):
                    return {"queued": int(fields[2]), "queue_dropped": int(fields[5]), "user_dropped": int(fields[6])}
        return None

    def write_status(self, at):
        problems = list(self.problems)
        try:
            kernel = self.queue_counts()
        except (OSError, ValueError) as error:
            kernel = None
            problems.append(f"cannot read {self.queue_rows}: {error}"[:300])
        if kernel and kernel["queue_dropped"] + kernel["user_dropped"] > self.dropped:
            self.dropped, self.dropped_at = kernel["queue_dropped"] + kernel["user_dropped"], at
        if self.dropped_at is not None and at - self.dropped_at < DROPS_SHOWN:
            problems.append(f"the kernel dropped packets of queue {self.args.queue} {int(at - self.dropped_at)}s ago, "
                            f"{self.dropped} since this checker started: the queue was full, or the checker behind")
        status = {"schema": STATUS_SCHEMA, "at": plug.now_iso(at), "queue": self.args.queue,
                  "flows": len(self.judge.flows), "held": sum(self.judge.holding.values()), "kernel": kernel,
                  "refused": self.judge.refused, "problems": problems}
        plug.write_replace(self.status_path, json.dumps(status, sort_keys=True) + "\n")

    def run(self):
        queue = Queue(self.args.queue, self.args.queue_length)
        print(f"checking queue {self.args.queue}", file=sys.stderr, flush=True)
        last = expired = 0
        while True:
            if select.select([queue.sock], [], [], 0.5)[0]:
                for kind, _seq, body in queue.receive():
                    if kind != (NFNL_SUBSYS_QUEUE << 8) | MSG_PACKET:
                        continue
                    ident, data = queue.packet(body)
                    if ident is None:
                        continue
                    for verdict in self.judge.packet(ident, data, time.monotonic()):
                        queue.verdict(*verdict)
            if time.monotonic() - expired >= 0.25:
                expired = time.monotonic()
                for verdict in self.judge.expire(expired):
                    queue.verdict(*verdict)
            if time.time() - last >= 2:
                last = time.time()
                if self.moved():
                    print("the exit's namespace was made again: leaving, to be started in the new one",
                          file=sys.stderr, flush=True)
                    return
                # The status says how the rules file is now, also when no flow is being judged.
                self.rules_at = time.monotonic()
                self.read_rules()
                self.write_status(last)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("check",))
    env = os.environ.get
    parser.add_argument("--state-dir", default=env("QORPERA_AGENT_EXIT_STATE_DIR", "/var/lib/qorpera-agent-exit"))
    parser.add_argument("--run-dir", default=env("QORPERA_AGENT_EXIT_RUN_DIR", "/run/qorpera-agent-exit"))
    parser.add_argument("--rules", default=env("QORPERA_AGENT_EXIT_NETWORK_RULES"))
    parser.add_argument("--netns-path", default="/run/netns/qexit")
    parser.add_argument("--queue", type=int, default=QUEUE)
    parser.add_argument("--queue-length", type=int, default=8192)
    args = parser.parse_args()
    args.rules = args.rules or os.path.join(args.state_dir, "rules", "rules.json")
    # nfnetlink loads nfnetlink_queue for the first queue message: only a node whose modules were loaded on purpose
    # (ROLLOUT.md) gets the check. The unit's condition says the same; this keeps a hand-started checker from loading it.
    if not os.path.isdir(QUEUE_MODULE):
        print("nfnetlink_queue is not loaded: no server name check (only listed goes by address alone)",
              file=sys.stderr, flush=True)
        return
    try:
        checker = Checker(args)
    except OSError as error:
        sys.exit(f"cannot start (the kernel drops what the sni chain queues): {error}")
    try:
        checker.run()
    except OSError as error:
        sys.exit(f"the queue failed (the kernel drops what it held): {error}")


if __name__ == "__main__":
    main()
