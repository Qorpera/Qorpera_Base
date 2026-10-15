#!/usr/bin/env python3
"""The server name checker's judge (E8c-2), driven with made-up packets: no queue, no kernel module.

  python3 sni-judge.py <qorpera-agent-exit-sni.py>
"""

import importlib.util
import socket
import ssl
import sys

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

    def send(self, data, inbound=False):
        self.ident += 1
        return self.ident, self.judge.packet(self.ident, data, not inbound, self.at)

    def flow(self, machine="10.210.1.1", port=40000, seq=5000, data=b""):
        """A SYN, then `data` from the machine at the flow's start: the verdicts on the data."""
        _, verdicts = self.send(packet(machine, port, seq, SYN))
        check(verdicts == [(self.ident, ACCEPT, 0)], f"a SYN goes on: {verdicts}")
        return self.send(packet(machine, port, seq + 1, ACK | PSH, data))

    def reply(self, ack, flags=ACK, machine="10.210.1.1", seq=9001):
        """A packet from the server to the machine: the verdicts on it."""
        return self.send(packet(machine, 40000, seq, flags, ack=ack, inbound=True), inbound=True)


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
    ident2, _ = run.send(packet("10.210.1.1", 40000, 5001, ACK | PSH, parts[0]))
    check(run.judge.expire(run.at + sni.HOLD_TIME - 1) == [], "held under 5 seconds")
    verdicts = run.judge.expire(run.at + sni.HOLD_TIME + 1)
    check(verdicts == [(ident2, DROP, 0), (ident, REPEAT, REFUSED)], f"a hello not whole in 5 seconds: {verdicts}")
    print("PASS: a hello in parts out of order is held and then let on whole; parts that differ or a hello not whole "
          "within 5 seconds are refused")

    run = Run()
    _, verdicts = run.send(packet("10.210.1.1", 40000, 5000, SYN, hello("x.test")))
    check(verdicts == [(run.ident, ACCEPT, 0)], f"a SYN with an allowed hello (TCP fast open): {verdicts}")
    run = Run()
    _, verdicts = run.send(packet("10.210.1.1", 40000, 5000, SYN, hello("evil.test")))
    check(verdicts == [(run.ident, REPEAT, REFUSED)], f"a SYN with another hello: {verdicts}")
    run = Run()
    _, verdicts = run.send(packet("10.210.1.1", 40000, 5001, ACK))
    check(verdicts == [(run.ident, ACCEPT, 0)], f"an ack of a flow not seen: {verdicts}")
    _, verdicts = run.send(packet("10.210.1.1", 40000, 5001, ACK | PSH, hello("x.test")))
    check(verdicts == [(run.ident, REPEAT, REFUSED)], f"data of a flow whose SYN was not seen: {verdicts}")
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
    check(run.judge.flows == {}, "a reset flow is forgotten")
    print("PASS: TCP fast open is judged; data of a flow not seen from its SYN, urgent data, data before the start and "
          "a second SYN are refused; a reset goes on and drops what was held")

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


main()
