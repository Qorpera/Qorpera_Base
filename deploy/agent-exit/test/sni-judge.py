#!/usr/bin/env python3
"""The server name checker's judge (E8c-2), driven with made-up packets, and its queue's config with made-up answers:
no queue, no kernel module.

  python3 sni-judge.py <qorpera-agent-exit-sni.py>
"""

import errno
import importlib.util
import json
import os
import re
import socket
import ssl
import struct
import sys
import tempfile
import time
import types

spec = importlib.util.spec_from_file_location("qorpera_agent_exit_sni", sys.argv[1])
sni = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sni)
ACCEPT, DROP, REPEAT, LISTED, REFUSED = sni.ACCEPT, sni.DROP, sni.REPEAT, sni.LISTED, sni.REFUSED

VERSION = "00000000-0000-4000-8000-000000000001"
RULES = {"c1": {"mode": "only-listed", "allow": ["x.test", "*.y.test"], "block": ["a.x.test"], "version": VERSION},
         "c2": None, "c3": False,
         "c4": {"mode": "open", "allow": [], "block": ["bad.test"], "version": VERSION}}
MACHINES = {"10.210.1.1": "c1", "10.210.1.2": "c2", "10.210.1.3": "c3", "10.210.1.4": "c4", "10.210.1.5": "c9"}
SERVER = "192.0.2.10"


def fail(what):
    print(f"FAIL: {what}")
    sys.exit(1)


def check(ok, what):
    if not ok:
        fail(what)


def decide(machine, name):
    company = MACHINES.get(machine)
    if company is None:
        return "not a verified machine"
    if company not in RULES:
        return "its company is not in the rules file"
    return None if sni.allowed(RULES[company], name) else "not allowed"


def hello(name):
    """A real ClientHello (python's TLS client) asking for `name`, or with no server name for None."""
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname, context.verify_mode = False, ssl.CERT_NONE
    incoming, outgoing = ssl.MemoryBIO(), ssl.MemoryBIO()
    client = context.wrap_bio(incoming, outgoing, server_hostname=name)
    try:
        client.do_handshake()
    except ssl.SSLWantReadError:
        pass
    return outgoing.read()


def record(body, kind=22):
    return bytes([kind, 3, 1]) + len(body).to_bytes(2, "big") + body


def extension(kind, data):
    return kind.to_bytes(2, "big") + len(data).to_bytes(2, "big") + data


def server_names(*entries):
    data = b"".join(bytes([kind]) + len(n).to_bytes(2, "big") + n for kind, n in entries)
    return extension(0, len(data).to_bytes(2, "big") + data)


def handshake(extensions):
    body = b"\x03\x03" + bytes(32) + b"\x00" + b"\x00\x02\x13\x01" + b"\x01\x00" + len(extensions).to_bytes(2, "big")
    body += extensions
    return b"\x01" + len(body).to_bytes(3, "big") + body


def made(names_extension):
    return record(handshake(names_extension))


def packet(machine, port, seq, flags, payload=b"", ack=0, inbound=False, protocol=6, fragment=0):
    a, b = (machine, port), (SERVER, 443)
    source, target = (b, a) if inbound else (a, b)
    tcp = (source[1].to_bytes(2, "big") + target[1].to_bytes(2, "big") + seq.to_bytes(4, "big") +
           ack.to_bytes(4, "big") + bytes([5 << 4, flags]) + b"\xff\xff" + b"\0\0" + b"\0\0" + payload)
    total = 20 + len(tcp)
    return (bytes([0x45, 0]) + total.to_bytes(2, "big") + b"\0\0" + fragment.to_bytes(2, "big") +
            bytes([64, protocol]) + b"\0\0" + socket.inet_aton(source[0]) + socket.inet_aton(target[0]) + tcp)


SYN, ACK, PSH, RST, URG = 0x02, 0x10, 0x08, 0x04, 0x20


class Run:
    """One judge; each send gives the packet a new id."""

    def __init__(self):
        self.lines = []
        self.judge = sni.Judge(decide, self.lines.append)
        self.ident, self.at = 0, 1000.0

    def send(self, data):
        self.ident += 1
        return self.ident, self.judge.packet(self.ident, data, self.at)

    def flow(self, machine="10.210.1.1", port=40000, seq=5000, data=b""):
        """A SYN, then `data` from the machine at the flow's start: the verdicts on the data."""
        _, verdicts = self.send(packet(machine, port, seq, SYN))
        check(verdicts == [(self.ident, ACCEPT, 0)], f"a SYN goes on: {verdicts}")
        return self.send(packet(machine, port, seq + 1, ACK | PSH, data))

    def reply(self, ack, flags=ACK, machine="10.210.1.1", seq=9001):
        """A packet from the server to the machine: the verdicts on it."""
        return self.send(packet(machine, 40000, seq, flags, ack=ack, inbound=True))


def main():
    for rules, name, want in [(RULES["c1"], "x.test", True), (RULES["c1"], "b.x.test", True),
                              (RULES["c1"], "a.x.test", False), (RULES["c1"], "z.a.x.test", False),
                              (RULES["c1"], "y.test", False), (RULES["c1"], "q.y.test", True),
                              (RULES["c1"], "xx.test", False), (RULES["c4"], "bad.test", False),
                              (RULES["c4"], "any.test", True), (None, "any.test", True), (False, "x.test", False)]:
        check(sni.allowed(rules, name) == want, f"allowed({name}) under {rules} is {not want}")
    print("PASS: a name is allowed as the company's resolver answers it (blocked under allowed, *.x, open, no rules)")

    run = Run()
    data = hello("x.test")
    ident, verdicts = run.flow(data=data)
    check(verdicts == [(ident, ACCEPT, 0)], f"an allowed ClientHello goes on: {verdicts}")
    _, verdicts = run.reply(5001, SYN | ACK, seq=9000)
    check(verdicts == [(run.ident, ACCEPT, 0)], f"a server packet before the hello is acknowledged: {verdicts}")
    _, verdicts = run.send(packet("10.210.1.1", 40000, 5001, ACK | PSH, data))
    check(verdicts == [(run.ident, ACCEPT, 0)], f"the same hello again goes on: {verdicts}")
    _, verdicts = run.send(packet("10.210.1.1", 40000, 5001, ACK | PSH, data[:-1] + b"\0"))
    check(verdicts == [(run.ident, REPEAT, REFUSED)], f"other bytes for the hello are refused: {verdicts}")
    run = Run()
    run.flow(data=data)
    _, verdicts = run.reply(5001 + len(data) - 1)
    check(verdicts == [(run.ident, ACCEPT, 0)], f"an ack short of the hello's end changes nothing: {verdicts}")
    _, verdicts = run.reply(5001 + len(data))
    check(verdicts == [(run.ident, REPEAT, LISTED)], f"the server's ack of the hello unmarks the flow: {verdicts}")
    _, verdicts = run.send(packet("10.210.1.1", 40000, 5001, ACK | PSH, data))
    check(verdicts == [(run.ident, ACCEPT, 0)], f"a packet queued before the unmarking goes on: {verdicts}")
    print("PASS: an allowed name goes on; its bytes sent again must be the same until the server acknowledges them")

    for name, machine in [("evil.test", "10.210.1.1"), ("a.x.test", "10.210.1.1"), ("x.test", "10.210.1.3"),
                          ("x.test", "10.210.1.5"), ("x.test", "10.210.1.9"), ("bad.test", "10.210.1.4")]:
        run = Run()
        ident, verdicts = run.flow(machine=machine, data=hello(name))
        check(verdicts == [(ident, REPEAT, REFUSED)], f"{name} from {machine} is refused: {verdicts}")
        check(len(run.lines) == 1 and name in run.lines[0], f"the refusal is reported: {run.lines}")
        _, verdicts = run.send(packet(machine, 40000, 5001, ACK, hello(name)))
        check(verdicts == [(run.ident, DROP, 0)], f"a refused flow's packets are dropped: {verdicts}")
        _, verdicts = run.reply(5001, machine=machine)
        check(verdicts == [(run.ident, DROP, 0)], f"the server's too: {verdicts}")
    for machine in ("10.210.1.2", "10.210.1.4"):
        run = Run()
        ident, verdicts = run.flow(machine=machine, data=hello("any.test"))
        check(verdicts == [(ident, ACCEPT, 0)], f"any name from a company now open or without rules: {verdicts}")
    print("PASS: a name not allowed or blocked, a machine not verified, a company not in the rules or with rules that "
          "cannot be used: refused, and the flow's later packets dropped")

    for what, data in [("no server name", hello(None)), ("not TLS", b"GET / HTTP/1.1\r\nHost: x.test\r\n\r\n"),
                       ("two host names", made(server_names((0, b"x.test"), (0, b"q.y.test")))),
                       ("another name type", made(server_names((1, b"x.test")))),
                       ("server_name twice", made(server_names((0, b"x.test")) + server_names((0, b"x.test")))),
                       ("a name with a dot at its end", made(server_names((0, b"x.test.")))),
                       ("an address", made(server_names((0, b"192.0.2.10")))),
                       ("more than a hello in its record", record(handshake(server_names((0, b"x.test"))) + b"\x14")),
                       ("an alert first", record(b"\x02\x28", kind=21)),
                       ("a hello over 16 KiB", record(handshake(server_names((0, b"x.test")) +
                                                                extension(21, bytes(16400)))[:16384]) +
                        record(handshake(server_names((0, b"x.test")) + extension(21, bytes(16400)))[16384:]))]:
        run = Run()
        ident, verdicts = run.flow(data=data)
        check(verdicts == [(ident, REPEAT, REFUSED)], f"{what}: {verdicts} {run.lines}")
    run = Run()
    ident, verdicts = run.flow(data=made(server_names((0, b"X.Test"))))
    check(verdicts == [(ident, ACCEPT, 0)], f"a name in capitals is the same name: {verdicts}")
    whole = handshake(server_names((0, b"x.test")))
    ident, verdicts = Run().flow(data=record(whole[:40]) + record(whole[40:]))
    check(verdicts == [(ident, ACCEPT, 0)], f"a hello in two records: {verdicts}")
    print("PASS: no server name, not TLS, two names, a bad name, more than a hello, a hello over 16 KiB: refused; "
          "capitals and a hello in two records go on")

    run = Run()
    data = hello("q.y.test")
    parts = [data[:100], data[100:300], data[300:]]
    starts = [5001, 5101, 5301]
    _, verdicts = run.send(packet("10.210.1.1", 40000, 5000, SYN))
    order = [1, 2, 0]
    got = []
    for i in order:
        ident, verdicts = run.send(packet("10.210.1.1", 40000, starts[i], ACK | PSH, parts[i]))
        got.append(ident)
        if i != 0:
            check(verdicts == [], f"part {i} of the hello is held: {verdicts}")
    check(sorted(verdicts) == sorted((g, ACCEPT, 0) for g in got), f"the whole hello lets all three on: {verdicts}")
    run = Run()
    run.send(packet("10.210.1.1", 40000, 5000, SYN))
    ident, verdicts = run.send(packet("10.210.1.1", 40000, 5001, ACK | PSH, parts[0]))
    check(verdicts == [], "a first part is held")
    ident2, verdicts = run.send(packet("10.210.1.1", 40000, 5051, ACK | PSH, b"\0" * 100))
    check(verdicts == [(ident, DROP, 0), (ident2, REPEAT, REFUSED)], f"bytes sent again that differ: {verdicts}")
    run = Run()
    run.send(packet("10.210.1.1", 40000, 5000, SYN))
    ident, _ = run.send(packet("10.210.1.1", 40000, 5001, ACK | PSH, parts[0]))
    _, verdicts = run.send(packet("10.210.1.1", 40000, 5001, ACK | PSH, parts[0]))
    check(verdicts == [(run.ident, DROP, 0)], f"a part sent again, no byte of it new, is dropped, not held: {verdicts}")
    ident2, verdicts = run.send(packet("10.210.1.1", 40000, 5051, ACK | PSH, data[50:150]))
    check(verdicts == [], f"a part with some bytes new is held: {verdicts}")
    check(run.judge.holding == {"10.210.1.1": 2}, f"the machine holds two packets: {run.judge.holding}")
    check(run.judge.expire(run.at + sni.HOLD_TIME - 1) == [], "held under 5 seconds")
    verdicts = run.judge.expire(run.at + sni.HOLD_TIME + 1)
    check(verdicts == [(ident2, DROP, 0), (ident, REPEAT, REFUSED)], f"a hello not whole in 5 seconds: {verdicts}")
    check(run.judge.holding == {}, f"a refused flow holds nothing: {run.judge.holding}")
    run = Run()
    run.send(packet("10.210.1.1", 40000, 5000, SYN))
    for seq in (5001 + sni.STREAM_MAX, 5001 + 20000):
        _, verdicts = run.send(packet("10.210.1.1", 40000, seq, ACK | PSH, b"x"))
        flow = run.judge.flows[(("10.210.1.1", 40000), (SERVER, 443))]
        check(verdicts == [(run.ident, DROP, 0)] and flow.data is None and flow.known is None and not flow.held,
              f"a byte past what a hello can take is dropped, and the flow gets no buffers: {verdicts}")
    _, verdicts = run.send(packet("10.210.1.1", 40000, 5001 + sni.STREAM_MAX - 1, ACK | PSH, b"xy"))
    check(verdicts == [] and flow.data is not None and flow.held == [run.ident],
          f"a part with one byte a hello can take is held, with the flow's buffers: {verdicts}")
    print("PASS: a hello in parts out of order is held and then let on whole; parts that differ or a hello not whole "
          "within 5 seconds are refused; a part sent again, or past what a hello can take, is dropped (no buffers)")

    run = Run()
    _, verdicts = run.send(packet("10.210.1.1", 40000, 5000, SYN, hello("x.test")))
    check(verdicts == [(run.ident, ACCEPT, 0)], f"a SYN with an allowed hello (TCP fast open): {verdicts}")
    run = Run()
    _, verdicts = run.send(packet("10.210.1.1", 40000, 5000, SYN, hello("evil.test")))
    check(verdicts == [(run.ident, REPEAT, REFUSED)], f"a SYN with another hello: {verdicts}")
    run = Run()
    _, verdicts = run.send(packet("10.210.1.1", 40000, 5001, ACK))
    check(verdicts == [(run.ident, REPEAT, REFUSED)], f"an ack of a flow whose SYN was not seen: {verdicts}")
    _, verdicts = run.send(packet("10.210.1.1", 40000, 5001, ACK | PSH, hello("x.test")))
    check(verdicts == [(run.ident, DROP, 0)], f"then its data: {verdicts}")
    run = Run()
    _, verdicts = run.reply(5001)
    check(verdicts == [(run.ident, REPEAT, REFUSED)] and "a server's packet" in run.lines[-1],
          f"a server's packet of a flow whose SYN was not seen: {verdicts} {run.lines}")
    _, verdicts = run.send(packet("10.210.1.1", 40000, 5001, ACK))
    check(verdicts == [(run.ident, DROP, 0)], f"then the machine's packet: {verdicts}")
    run = Run()
    _, verdicts = run.send(packet("10.210.1.1", 40000, 5001, RST))
    check(verdicts == [(run.ident, ACCEPT, 0)], f"the machine's reset of a flow not seen goes on: {verdicts}")
    _, verdicts = run.send(packet("10.210.1.1", 40000, 5001, ACK | PSH, hello("x.test")))
    check(verdicts == [(run.ident, DROP, 0)], f"then its data is dropped: {verdicts}")
    run = Run()
    run.send(packet("10.210.1.1", 40000, 5000, SYN))
    _, verdicts = run.send(packet("10.210.1.1", 40000, 5001, ACK | URG))
    check(verdicts == [(run.ident, REPEAT, REFUSED)], f"urgent data: {verdicts}")
    run = Run()
    _, verdicts = run.flow(seq=5000, data=b"")
    _, verdicts = run.send(packet("10.210.1.1", 40000, 4990, ACK | PSH, hello("x.test")))
    check(verdicts == [(run.ident, REPEAT, REFUSED)], f"data before the flow's start: {verdicts}")
    run = Run()
    run.send(packet("10.210.1.1", 40000, 5000, SYN))
    ident, _ = run.send(packet("10.210.1.1", 40000, 5001, ACK | PSH, parts[0]))
    _, verdicts = run.send(packet("10.210.1.1", 40000, 7000, SYN))
    check(verdicts == [(ident, DROP, 0), (run.ident, REPEAT, REFUSED)], f"a SYN again, another start: {verdicts}")
    run = Run()
    run.send(packet("10.210.1.1", 40000, 5000, SYN))
    ident, _ = run.send(packet("10.210.1.1", 40000, 5001, ACK | PSH, parts[0]))
    _, verdicts = run.send(packet("10.210.1.1", 40000, 5101, RST))
    check(verdicts == [(ident, DROP, 0), (run.ident, ACCEPT, 0)], f"the machine's reset: {verdicts}")
    check([(f.state, f.held) for f in run.judge.flows.values()] == [("reset", [])] and run.judge.holding == {},
          f"a reset flow holds nothing: {run.judge.holding}")
    _, verdicts = run.send(packet("10.210.1.1", 40000, 5101, ACK | PSH, parts[1]))
    check(verdicts == [(run.ident, DROP, 0)], f"a reset flow's later data is dropped: {verdicts}")
    _, verdicts = run.reply(5001)
    check(verdicts == [(run.ident, DROP, 0)], f"and the server's packets: {verdicts}")
    ident, verdicts = run.flow(seq=80000, data=hello("x.test"))
    check(verdicts == [(ident, ACCEPT, 0)], f"a SYN on its ports starts a new flow: {verdicts}")
    print("PASS: TCP fast open is judged; a flow not seen from its SYN (the machine's packet or the server's), urgent "
          "data, data before the start and a second SYN are refused; a reset goes on and drops what was held")

    def bytes_apart(run, port, count, machine="10.210.1.1"):
        """A SYN, then `count` bytes one packet each, the first byte never: each one held (the hello is never whole)."""
        run.send(packet(machine, port, 5000, SYN))
        for at in range(count):
            _, verdicts = run.send(packet(machine, port, 5002 + at, ACK | PSH, b"\x16"))
            check(verdicts == [], f"byte {at + 1} of port {port} is held: {verdicts}")

    run = Run()
    bytes_apart(run, 40000, sni.FLOW_HELD)
    first = run.ident - sni.FLOW_HELD + 1
    _, verdicts = run.send(packet("10.210.1.1", 40000, 5002 + sni.FLOW_HELD, ACK | PSH, b"\x16"))
    check(verdicts == [(i, DROP, 0) for i in range(first, run.ident)] + [(run.ident, REPEAT, REFUSED)],
          f"a hello in more than {sni.FLOW_HELD} packets: {verdicts}")
    check(run.judge.holding == {} and f"more than {sni.FLOW_HELD} packets" in run.lines[-1], f"{run.lines}")
    run = Run()
    flows = sni.MACHINE_HELD // (sni.FLOW_HELD // 2)
    for port in range(40000, 40000 + flows):
        bytes_apart(run, port, sni.FLOW_HELD // 2)
    check(run.judge.holding == {"10.210.1.1": sni.MACHINE_HELD}, f"the machine's packets: {run.judge.holding}")
    ident, verdicts = run.flow(port=50000, data=hello("x.test")[:10])
    check(verdicts == [(ident, REPEAT, REFUSED)], f"a flow of a machine holding {sni.MACHINE_HELD}: {verdicts}")
    check(f"its machine holds {sni.MACHINE_HELD}" in run.lines[-1], f"{run.lines}")
    ident, verdicts = run.flow(machine="10.210.1.4", port=50000, data=hello("any.test"))
    check(verdicts == [(ident, ACCEPT, 0)], f"another machine's flow is judged as before: {verdicts}")
    _, verdicts = run.send(packet("10.210.1.1", 40000, 5000, RST))
    check(len(verdicts) == sni.FLOW_HELD // 2 + 1, f"a reset lets go of its flow's packets: {verdicts}")
    check(run.judge.holding == {"10.210.1.1": sni.MACHINE_HELD - sni.FLOW_HELD // 2}, f"{run.judge.holding}")
    ident, verdicts = run.flow(port=50001, data=hello("x.test"))
    check(verdicts == [(ident, ACCEPT, 0)], f"then the machine's next hello is judged again: {verdicts}")
    verdicts = run.judge.expire(run.at + sni.HOLD_TIME + 1)
    check(len([v for v in verdicts if v[1] == REPEAT]) == flows - 1 and run.judge.holding == {},
          f"flows past 5 seconds let go of theirs: {len(verdicts)} {run.judge.holding}")
    print(f"PASS: a hello in more than {sni.FLOW_HELD} packets, and a flow of a machine holding {sni.MACHINE_HELD} "
          "already, are refused; another machine goes on; a pass, a refusal, a reset and the 5 seconds let go")

    run = Run()
    run.send(packet("10.210.1.1", 40000, 5000, SYN))
    _, verdicts = run.send(packet("10.210.1.1", 40000, 9001, ACK | PSH, hello("evil.test"), ack=5001, inbound=True))
    check(verdicts == [(run.ident, ACCEPT, 0)] and not run.lines, f"the server's bytes are not judged: {verdicts}")
    ident, verdicts = run.send(packet("10.210.1.1", 40000, 5001, ACK | PSH, hello("evil.test")))
    check(verdicts == [(ident, REPEAT, REFUSED)], f"the machine's are, known by its address alone: {verdicts}")
    print("PASS: a packet is the machine's when it comes from a machine's address, the server's otherwise")

    run = Run()
    data = hello("x.test")
    run.flow(data=data)
    _, verdicts = run.reply(5001 + len(data))
    check(verdicts == [(run.ident, REPEAT, LISTED)], f"the flow is judged: {verdicts}")
    ident, verdicts = run.flow(seq=70000, data=data)
    check(verdicts == [(ident, ACCEPT, 0)], f"a new connection on the ports of one judged: {verdicts} {run.lines}")
    run = Run()
    run.flow(data=hello("evil.test"))
    ident, verdicts = run.flow(seq=70000, data=data)
    check(verdicts == [(ident, ACCEPT, 0)], f"a new connection on the ports of one refused: {verdicts} {run.lines}")
    _, verdicts = run.send(packet("10.210.1.1", 40000, 70001, ACK | PSH, data))
    check(verdicts == [(run.ident, ACCEPT, 0)], f"its own hello again goes on: {verdicts}")
    print("PASS: a SYN on the ports of a flow judged starts a new flow (the old one is queued no more)")

    run = Run()
    run.flow(data=b"")
    for _ in range(sni.FLOW_QUEUED - 2):
        _, verdicts = run.send(packet("10.210.1.1", 40000, 5001, ACK))
        check(verdicts == [(run.ident, ACCEPT, 0)], f"an ACK with no data goes on: {verdicts}")
    _, verdicts = run.send(packet("10.210.1.1", 40000, 5001, ACK))
    check(verdicts == [(run.ident, REPEAT, REFUSED)] and f"more than {sni.FLOW_QUEUED} packets" in run.lines[-1],
          f"ACKs with no data, more than {sni.FLOW_QUEUED}: {verdicts} {run.lines}")
    _, verdicts = run.send(packet("10.210.1.1", 40000, 5001, ACK))
    check(verdicts == [(run.ident, DROP, 0)], f"then the flow's packets are dropped: {verdicts}")
    run = Run()
    data = hello("x.test")
    run.flow(data=data)
    for _ in range(sni.FLOW_QUEUED - 2):
        _, verdicts = run.reply(5001)
        check(verdicts == [(run.ident, ACCEPT, 0)], f"a server's packet that does not acknowledge the hello: {verdicts}")
    _, verdicts = run.reply(5001)
    check(verdicts == [(run.ident, REPEAT, REFUSED)] and f"more than {sni.FLOW_QUEUED} packets" in run.lines[-1],
          f"the server's packets of a passed flow, more than {sni.FLOW_QUEUED}: {verdicts} {run.lines}")
    _, verdicts = run.send(packet("10.210.1.1", 40000, 5001 + len(data), ACK))
    check(verdicts == [(run.ident, DROP, 0)], f"then the machine's packets are dropped: {verdicts}")
    for side in ("server", "machine"):
        run = Run()
        run.flow(data=data)
        run.at += sni.HOLD_TIME - 1
        _, verdicts = run.reply(5001)
        check(verdicts == [(run.ident, ACCEPT, 0)], f"a passed flow within {sni.HOLD_TIME} seconds: {verdicts}")
        run.at += 2
        _, verdicts = (run.reply(5001 + len(data)) if side == "server" else
                       run.send(packet("10.210.1.1", 40000, 5001 + len(data), ACK)))
        check(verdicts == [(run.ident, REPEAT, REFUSED)] and "did not acknowledge" in run.lines[-1],
              f"the {side}'s packet of a passed flow its server did not confirm: {verdicts} {run.lines}")
    run = Run()
    run.flow(data=b"")
    run.at += sni.HELLO_TIME - 1
    _, verdicts = run.reply(5001)
    check(verdicts == [(run.ident, ACCEPT, 0)], f"a flow within {sni.HELLO_TIME} seconds of its SYN: {verdicts}")
    run.at += 2
    _, verdicts = run.send(packet("10.210.1.1", 40000, 5001, ACK | PSH, data))
    check(verdicts == [(run.ident, REPEAT, REFUSED)] and "no whole ClientHello within" in run.lines[-1],
          f"a hello {sni.HELLO_TIME} seconds after the SYN: {verdicts} {run.lines}")
    run = Run()
    run.send(packet("10.210.1.1", 40000, 5000, SYN))
    run.at += sni.HELLO_TIME - 1
    run.send(packet("10.210.1.1", 40000, 5000, SYN))
    run.at += sni.HELLO_TIME - 1
    _, verdicts = run.send(packet("10.210.1.1", 40000, 5001, ACK | PSH, data))
    check(verdicts == [(run.ident, ACCEPT, 0)], f"a SYN sent again starts the time again: {verdicts} {run.lines}")
    run = Run()
    for _ in range(sni.FLOW_QUEUED):
        _, verdicts = run.send(packet("10.210.1.1", 40000, 5000, SYN))
        check(verdicts == [(run.ident, ACCEPT, 0)], f"a SYN sent again: {verdicts}")
    _, verdicts = run.send(packet("10.210.1.1", 40000, 5000, SYN))
    check(verdicts == [(run.ident, REPEAT, REFUSED)], f"a SYN sent again still counts: {verdicts}")
    run = Run()
    for protocol in (6, 17):
        stray = packet("10.210.1.1", 40000, 5000, SYN, protocol=protocol)
        _, verdicts = run.send(stray[:12] + socket.inet_aton("10.211.1.1") + stray[16:])
        check(verdicts == [(run.ident, DROP, 0)] and run.judge.flows == {},
              f"a packet with no machine on either side (protocol {protocol}): {verdicts}")
    here = os.path.dirname(os.path.abspath(sys.argv[1]))
    with open(os.path.join(here, "qorpera-agent-exit.sh")) as file:
        pool = re.search(r"^AGENTS=(\S+)$", file.read(), re.M)
    with open(os.path.join(here, "qorpera-agent-exit-sni.nft")) as file:
        chain = set(re.findall(r"\d+\.\d+\.\d+\.\d+/\d+", file.read()))
    check(pool and str(sni.AGENTS) == pool.group(1) and chain == {pool.group(1)},
          f"the checker's machines are the exit's pool and the sni chain's: {sni.AGENTS} {pool} {chain}")
    print(f"PASS: a flow is refused past {sni.FLOW_QUEUED} packets both ways (ACKs with no data, the server's, SYNs "
          f"again), with no whole hello {sni.HELLO_TIME} seconds after its last SYN, or with its hello not acknowledged "
          f"{sni.HOLD_TIME} seconds after it went on; a packet with no machine on either side is dropped; the checker's "
          "machines are the exit's pool")

    run = Run()
    _, verdicts = run.send(packet("10.210.1.1", 40000, 5000, SYN, protocol=17))
    check(verdicts == [(run.ident, ACCEPT, 0)], f"another protocol (an ICMP error of the flow): {verdicts}")
    _, verdicts = run.send(packet("10.210.1.1", 40000, 5000, SYN, fragment=0x2000))
    check(verdicts == [(run.ident, DROP, 0)], f"a TCP fragment: {verdicts}")
    _, verdicts = run.send(b"\x60" + bytes(40))
    check(verdicts == [(run.ident, DROP, 0)], f"not IPv4: {verdicts}")
    run = Run()
    run.flow(port=40001, data=b"")
    run.at += sni.FLOW_IDLE + 1
    run.judge.expire(run.at)
    check(run.judge.flows == {}, "a flow not seen for FLOW_IDLE seconds is forgotten")
    print("PASS: other protocols go on, fragments and packets that cannot be read are dropped; idle flows are forgotten")

    queue = sni.Queue.__new__(sni.Queue)
    queue.number, queue.seq = 0, 0
    # Packet 7 comes before the answer to config 1; its verdict (message 2) fails, as one for a packet gone would.
    held = netlink((sni.NFNL_SUBSYS_QUEUE << 8) | sni.MSG_PACKET, 0,
                   struct.pack("!BBH", 2, 0, 0) + sni.attribute(sni.A_PACKET_HDR, struct.pack("!IHB", 7, 0x0800, 2)))
    queue.sock = Kernel([held, answer(2, errno.ENOENT) + answer(1, 0), answer(3, errno.EPERM)])
    queue.request(sni.attribute(sni.CFG_CMD, struct.pack("!BxH", sni.CMD_BIND, 0)))
    sent = [struct.unpack_from("=IHHII", data) for data in queue.sock.sent]
    check([(kind, seq) for _, kind, _, seq, _ in sent] == [((3 << 8) | 2, 1), ((3 << 8) | 1, 2)],
          f"one config message, then a verdict: {sent}")
    verdict = sni.attributes(queue.sock.sent[1][20:]).get(sni.A_VERDICT_HDR, b"")
    check(verdict == struct.pack("!II", DROP, 7), f"a packet queued before the answer is dropped: {verdict}")
    try:
        queue.request(sni.attribute(sni.CFG_QUEUE_MAXLEN, struct.pack("!I", 8)))
        fail("a config the kernel refuses is not an error")
    except OSError as error:
        check(error.errno == errno.EPERM, f"the kernel's answer is the error: {error}")
    print("PASS: a queue config takes the kernel's answer to it, not a verdict's, and drops a packet queued meanwhile")

    with tempfile.TemporaryDirectory() as run_dir:
        checker = sni.Checker(types.SimpleNamespace(run_dir=run_dir, queue=0))
        checker.queue_rows = os.path.join(run_dir, "nfnetlink_queue")
        checker.judge.packet(1, packet("10.210.1.1", 40000, 5000, SYN), 0)
        checker.judge.packet(2, packet("10.210.1.1", 40000, 5001, ACK | PSH, hello("x.test")[:10]), 0)

        def status(at, rows):
            if rows is not None:
                with open(checker.queue_rows, "w") as file:
                    file.write(rows)
            elif os.path.exists(checker.queue_rows):
                os.unlink(checker.queue_rows)
            checker.write_status(at)
            with open(checker.status_path) as file:
                return json.load(file)

        at, other = time.time(), "    1   3017     0 2 65531     9     9        0  1\n"
        got = status(at, other + "    0   3018     1 2 65531     0     0        2  1\n")
        check(got["kernel"] == {"queued": 1, "queue_dropped": 0, "user_dropped": 0} and got["problems"] == [] and
              got["flows"] == 1 and got["held"] == 1, f"the status with the kernel's row for queue 0: {got}")
        row = "    0   3018     0 2 65531 {}     {}      900  1\n"
        # One burst (drops in one status write), then none, then drops in two writes in a row: counted, no problem.
        for step, (queue_dropped, user_dropped, dropping) in enumerate([(5, 1, 1), (5, 1, 0), (7, 1, 1), (7, 2, 2)]):
            got = status(at + 2 + 2 * step, other + row.format(queue_dropped, user_dropped))
            check(got["kernel"]["queue_dropped"] == queue_dropped and got["dropping"] == dropping and
                  got["problems"] == [], f"drops in {dropping} status writes in a row are no problem: {got}")
        last = at + 2 + 2 * 4
        got = status(last, other + row.format(8, 2))
        check(got["dropping"] == sni.DROPS_LASTING and len(got["problems"]) == 1 and
              f"in {sni.DROPS_LASTING} status writes in a row, the last 0s ago, 10 since" in got["problems"][0],
              f"drops in {sni.DROPS_LASTING} status writes in a row are a problem: {got}")
        got = status(last + sni.DROPS_SHOWN - 1, other + row.format(8, 2))
        check(got["dropping"] == 0 and len(got["problems"]) == 1, f"for a minute: {got}")
        got = status(last + sni.DROPS_SHOWN + 1, other + row.format(8, 2))
        check(got["problems"] == [], f"a minute after the last, not any more: {got}")
        got = status(at + 90, other)
        check(got["kernel"] is None and got["problems"] == [], f"no row before the checker binds its queue: {got}")
        got = status(at + 92, None)
        check(got["kernel"] is None and "cannot read" in got["problems"][0], f"no queue file: {got}")
    print(f"PASS: the status names the packets held and counts the kernel's drops of the queue; drops in "
          f"{sni.DROPS_LASTING} status writes in a row are a problem for a minute after the last, a burst is not")


class Kernel:
    """The queue socket's stand-in: what the kernel answers, one read at a time, and what was sent."""

    def __init__(self, reads):
        self.reads, self.sent = list(reads), []

    def send(self, data):
        self.sent.append(data)

    def recv(self, _size):
        if not self.reads:
            fail("the queue waits for an answer the kernel already gave")
        return self.reads.pop(0)


def netlink(kind, seq, body):
    return struct.pack("=IHHII", 16 + len(body), kind, 0, seq, 0) + body


def answer(seq, error):
    return netlink(sni.NLMSG_ERROR, seq, struct.pack("=i", -error) + bytes(16))


main()
