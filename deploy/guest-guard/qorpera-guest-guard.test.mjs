// deploy/guest-guard: the installer pins, the tool against a stand-in `nft`, and (as root on Linux) the real
// rules on a small stand-in node built from network namespaces: a guest on qorpera0, a guest on coding-net,
// the office network with the NAS and the router, and node 1 on the tailnet. Nothing touches the host's own
// firewall: every rule is loaded inside the stand-in node's namespace.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tool = join(here, "qorpera-guest-guard.sh");
const rules = readFileSync(join(here, "qorpera-guest-guard.nft"), "utf8");
const TABLE = "inet qorpera_guest_guard";

const sha256 = (file) => createHash("sha256").update(readFileSync(join(here, file))).digest("hex");

test("the installer pins the files in this folder", () => {
	const installer = readFileSync(join(here, "install-guest-guard.sh"), "utf8");
	for (const [name, file] of [
		["RULES", "qorpera-guest-guard.nft"],
		["TOOL", "qorpera-guest-guard.sh"],
		["UNIT", "qorpera-guest-guard.service"],
	]) {
		assert.match(installer, new RegExp(`EXPECTED_${name}_SHA256="${sha256(file)}"`), `${file} pin`);
	}
});

describe("the tool against a stand-in nft", () => {
	let dir;
	let env;
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "guest-guard-"));
		// The stand-in keeps the last loaded transaction as the "table"; list prints it, delete removes it.
		writeFileSync(
			join(dir, "nft"),
			`#!/usr/bin/env bash
S="$STUB_STATE"
echo "nft $*" >> "$S/log"
case "$*" in
	"-f /dev/stdin") cat > "$S/table";;
	"-c -f /dev/stdin") cat > "$S/checked"; ! grep -q BROKEN "$S/checked";;
	"list table ${TABLE}") [[ -f "$S/table" ]];;
	"list chain ${TABLE} refuse_input") grep '^add rule' "$S/table" || true;;
	"list counters table ${TABLE}") echo counters;;
	"delete table ${TABLE}") rm -f "$S/table";;
	*) echo "unexpected nft $*" >&2; exit 2;;
esac
`,
		);
		chmodSync(join(dir, "nft"), 0o755);
		env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, STUB_STATE: dir };
	});
	after(() => rmSync(dir, { recursive: true, force: true }));
	const run = (args, extra = {}, input = "") =>
		spawnSync("bash", [tool, ...args], { env: { ...env, ...extra }, encoding: "utf8", input });
	const table = () => readFileSync(join(dir, "table"), "utf8");
	const rejects = (text) => text.split("\n").filter((line) => line.startsWith("add rule"));

	test("observe loads the table in one transaction, with no reject", () => {
		const r = run(["observe"]);
		assert.equal(r.status, 0, r.stderr);
		assert.ok(table().startsWith(`table ${TABLE}\ndelete table ${TABLE}\n`));
		assert.ok(table().includes(rules));
		assert.deepEqual(rejects(table()), []);
		assert.match(r.stdout, /qorpera-guest-guard: observe/);
	});

	test("enforce adds the refusals: reset or ICMP for refused flows, drop for spoofed and quiet ones", () => {
		const r = run(["enforce"]);
		assert.equal(r.status, 0, r.stderr);
		assert.ok(table().includes(rules));
		assert.deepEqual(rejects(table()), [
			`add rule ${TABLE} refuse_forward meta l4proto tcp reject with tcp reset`,
			`add rule ${TABLE} refuse_forward reject with icmpx admin-prohibited`,
			`add rule ${TABLE} refuse_input meta l4proto tcp reject with tcp reset`,
			`add rule ${TABLE} refuse_input reject with icmpx admin-prohibited`,
			`add rule ${TABLE} refuse_spoofed drop`,
			`add rule ${TABLE} refuse_quiet drop`,
		]);
		assert.match(r.stdout, /qorpera-guest-guard: enforce/);
	});

	test("boot loads the mode file's mode, observe without one, and refuses anything else", () => {
		const modeFile = join(dir, "mode");
		writeFileSync(modeFile, "enforce\n");
		assert.match(run(["boot"], { QORPERA_GUEST_GUARD_MODE_FILE: modeFile }).stdout, /: enforce/);
		assert.match(run(["boot"], { QORPERA_GUEST_GUARD_MODE_FILE: join(dir, "missing") }).stdout, /: observe/);
		writeFileSync(modeFile, "off\n");
		const before = table();
		const bad = run(["boot"], { QORPERA_GUEST_GUARD_MODE_FILE: modeFile });
		assert.equal(bad.status, 78);
		assert.match(bad.stderr, /expected observe or enforce/);
		assert.equal(table(), before, "a bad mode file loads nothing");
	});

	test("verify succeeds only when the loaded mode is the mode file's", () => {
		const modeFile = join(dir, "mode");
		writeFileSync(modeFile, "enforce\n");
		run(["enforce"]);
		assert.equal(run(["verify"], { QORPERA_GUEST_GUARD_MODE_FILE: modeFile }).status, 0);
		run(["observe"]);
		const wrong = run(["verify"], { QORPERA_GUEST_GUARD_MODE_FILE: modeFile });
		assert.equal(wrong.status, 1);
		assert.match(wrong.stdout, /loaded observe, wanted enforce/);
	});

	test("an unreadable, foreign or broken rules file never touches the loaded table", () => {
		run(["enforce"]);
		const before = table();
		const missing = run(["observe"], { QORPERA_GUEST_GUARD_RULES: join(dir, "missing.nft") });
		assert.notEqual(missing.status, 0);
		assert.match(missing.stderr, /cannot read .*the loaded table is unchanged/);
		const foreign = join(dir, "foreign.nft");
		writeFileSync(foreign, "table inet something_else {\n}\n");
		const other = run(["observe"], { QORPERA_GUEST_GUARD_RULES: foreign });
		assert.notEqual(other.status, 0);
		assert.match(other.stderr, /does not define the table/);
		const broken = join(dir, "broken.nft");
		writeFileSync(broken, `${rules}\nBROKEN\n`);
		assert.notEqual(run(["observe"], { QORPERA_GUEST_GUARD_RULES: broken }).status, 0);
		assert.equal(table(), before);
	});

	test("remove deletes the table and is a no-op when it is gone", () => {
		run(["observe"]);
		assert.match(run(["remove"]).stdout, /not loaded/);
		assert.match(run(["remove"]).stdout, /not loaded/);
	});

	test("summarize counts refused connections from kernel log lines", () => {
		const line = (dir, inIf, src, dst, proto, dpt) =>
			`qorpera-guest-guard ${dir}: IN=${inIf} OUT= MAC=00:16:3e SRC=${src} DST=${dst} LEN=60 TTL=64 PROTO=${proto} SPT=40000 DPT=${dpt} SYN`;
		const input = [
			line("forward", "qorpera0", "10.41.0.3", "192.168.1.40", "TCP", 2049),
			line("forward", "qorpera0", "10.41.0.3", "192.168.1.40", "TCP", 2049),
			line("input", "qorpera0", "10.41.0.3", "10.41.0.1", "TCP", 22),
			"some other kernel line",
		].join("\n");
		const r = run(["summarize"], {}, input);
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(
			r.stdout.trim().split("\n").map((l) => l.trim()),
			["2 forward qorpera0 10.41.0.3 192.168.1.40 TCP 2049", "1 input qorpera0 10.41.0.3 10.41.0.1 TCP 22"],
		);
	});

	test("an unknown command prints the usage", () => {
		const r = run(["open-everything"]);
		assert.equal(r.status, 64);
		assert.match(r.stderr, /qorpera-guest-guard.sh enforce/);
	});
});

const which = (cmd) => spawnSync("bash", ["-c", `command -v ${cmd}`]).status === 0;
const canRunNamespaces =
	process.platform === "linux" &&
	process.getuid?.() === 0 &&
	["nft", "ip", "python3", "timeout", "ping"].every(which);

describe("the rules on a stand-in node", {
	skip: canRunNamespaces ? false : "needs root on Linux with nft, ip, python3, timeout and ping",
}, () => {
	const id = `${process.pid}`;
	const ns = {
		node: `qgg-n${id}`,
		guest: `qgg-g${id}`,
		guest2: `qgg-h${id}`,
		coding: `qgg-c${id}`,
		lan: `qgg-l${id}`,
		tail: `qgg-t${id}`,
	};
	const listeners = [];
	// br_netfilter is loaded on our nodes, so bridged traffic between two guests reaches the guard there.
	// The test machine does not load it; QORPERA_GUEST_GUARD_TEST_BR_NETFILTER=1 loads it for this run.
	let brNetfilter = false;
	let loadedBrNetfilter = false;
	const sh = (cmd) => {
		const r = spawnSync("bash", ["-c", cmd], { encoding: "utf8" });
		assert.equal(r.status, 0, `${cmd}\n${r.stderr}`);
		return r.stdout;
	};
	const SERVE = `
import socket, sys, threading
socks = []
for a in sys.argv[1:]:
    proto = "tcp"
    if a.startswith("udp:"):
        proto, a = "udp", a[4:]
    host, port = a.rsplit(":", 1)
    family = socket.AF_INET
    if host.startswith("["):
        host, family = host[1:-1], socket.AF_INET6
    s = socket.socket(family, socket.SOCK_STREAM if proto == "tcp" else socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind((host, int(port)))
    if proto == "tcp":
        s.listen(64)
    socks.append((proto, s))
def tcp(s):
    while True:
        c, _ = s.accept()
        c.close()
def udp(s):
    while True:
        data, peer = s.recvfrom(512)
        s.sendto(data, peer)
for proto, s in socks:
    threading.Thread(target=tcp if proto == "tcp" else udp, args=(s,), daemon=True).start()
print("ready", flush=True)
threading.Event().wait()
`;
	const UDP_ASK = `
import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.settimeout(2)
s.connect((sys.argv[1], int(sys.argv[2])))
try:
    s.send(b"q")
    s.recv(64)
    print("open")
except Exception:
    print("closed")
`;
	const FROM = `
import socket, sys
s = socket.socket()
s.settimeout(0.5)
s.bind((sys.argv[1], 0))
try:
    s.connect((sys.argv[2], int(sys.argv[3])))
    print("open")
except Exception:
    print("closed")
`;
	const listen = (name, addresses) =>
		new Promise((resolve, reject) => {
			const child = spawn("ip", ["netns", "exec", name, "python3", "-c", SERVE, ...addresses], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			listeners.push(child);
			let err = "";
			child.stderr.on("data", (d) => {
				err += d;
			});
			child.stdout.on("data", (d) => {
				if (`${d}`.includes("ready")) resolve();
			});
			child.on("exit", (code) => reject(new Error(`listener in ${name} exited ${code}: ${err}`)));
		});
	const inNs = (name, args, timeout = 5000) => spawnSync("ip", ["netns", "exec", name, ...args], { encoding: "utf8", timeout });
	const connect = (from, target) => {
		const host = target.startsWith("[") ? target.slice(1, target.indexOf("]")) : target.slice(0, target.lastIndexOf(":"));
		const port = target.slice(target.lastIndexOf(":") + 1);
		const start = Date.now();
		const r = inNs(from, ["timeout", "3", "bash", "-c", `exec 3<>/dev/tcp/${host}/${port}`]);
		return { open: r.status === 0, ms: Date.now() - start };
	};
	const udpOpen = (from, host, port) => inNs(from, ["python3", "-c", UDP_ASK, host, `${port}`]).stdout.trim() === "open";
	const pingOk = (from, host) => inNs(from, ["ping", "-c", "1", "-W", "1", host]).status === 0;
	const guard = (mode) => sh(`ip netns exec ${ns.node} bash ${tool} ${mode}`);
	const counters = () => {
		const out = sh(`ip netns exec ${ns.node} nft list counters table ${TABLE}`);
		const packets = (name) => Number(new RegExp(`counter ${name} \\{\\s*packets (\\d+)`).exec(out)?.[1] ?? -1);
		return {
			allowed: packets("allowed_services_used"),
			forward: packets("refused_forward"),
			input: packets("refused_input"),
			spoofed: packets("refused_spoofed"),
			quiet: packets("refused_quiet"),
		};
	};

	// TCP targets, by who connects and which hook refuses them in enforce mode.
	const GUEST_OPEN = [
		"10.41.0.1:53",
		"10.41.0.1:8789",
		"100.75.4.70:10000",
		"100.75.4.70:18544",
		"100.80.160.64:10000",
		"1.1.1.1:443",
	];
	const GUEST_REFUSED_FORWARD = [
		"192.168.1.40:2049",
		"192.168.1.40:445",
		"192.168.1.40:5000",
		"192.168.1.27:22",
		"192.168.1.1:80",
		"100.75.4.70:22",
		"93.164.62.162:443",
		"10.200.0.3:22",
	];
	const GUEST_REFUSED_INPUT = ["10.41.0.1:22", "10.41.0.1:111", "192.168.1.42:22", "100.80.160.64:22", "10.200.0.1:53"];
	const SAME_BRIDGE = ["10.41.0.4:9444"];
	const GUEST_IPV6 = ["[fd00:41::1]:22"];
	const CODING_OPEN = ["10.200.0.1:53", "1.1.1.1:443"];
	const CODING_REFUSED_FORWARD = ["100.75.4.70:10000", "192.168.1.40:2049", "10.41.0.3:8082"];
	const CODING_REFUSED_INPUT = ["10.41.0.1:8789", "10.41.0.1:53", "10.200.0.1:22"];
	// Connections the node itself opens to its guests are never checked.
	const NODE_OPEN = ["10.41.0.3:8082", "10.200.0.3:22"];

	const expectAll = (from, targets, open, fast = true) => {
		for (const target of targets) {
			const r = connect(from, target);
			assert.equal(r.open, open, `${from} -> ${target}: expected ${open ? "open" : "refused"}`);
			if (!open && fast) assert.ok(r.ms < 2000, `${from} -> ${target} refused after ${r.ms} ms; a reject answers at once`);
		}
	};
	const guestTargets = () => [
		...GUEST_OPEN,
		...GUEST_REFUSED_FORWARD,
		...GUEST_REFUSED_INPUT,
		...GUEST_IPV6,
		...(brNetfilter ? SAME_BRIDGE : []),
	];
	const everythingConnects = () => {
		expectAll(ns.guest, guestTargets(), true);
		expectAll(ns.coding, [...CODING_OPEN, ...CODING_REFUSED_FORWARD, ...CODING_REFUSED_INPUT], true);
		expectAll(ns.node, NODE_OPEN, true);
		assert.ok(udpOpen(ns.guest, "10.41.0.1", 53), "guest -> 10.41.0.1:53/udp");
		assert.ok(udpOpen(ns.coding, "10.41.0.1", 53), "coding -> 10.41.0.1:53/udp");
		assert.ok(pingOk(ns.guest, "10.41.0.1"), "guest pings its gateway");
		assert.ok(pingOk(ns.guest, "192.168.1.40"), "guest pings the NAS");
	};

	before(async () => {
		if (process.env.QORPERA_GUEST_GUARD_TEST_BR_NETFILTER === "1" && !existsSync("/proc/sys/net/bridge")) {
			sh("modprobe br_netfilter");
			loadedBrNetfilter = true;
		}
		for (const name of Object.values(ns)) sh(`ip netns add ${name} && ip -n ${name} link set lo up`);
		const { node, guest, guest2, coding, lan, tail } = ns;
		if (existsSync("/proc/sys/net/bridge")) {
			sh(`ip netns exec ${node} sysctl -qw net.bridge.bridge-nf-call-iptables=1`);
			brNetfilter = true;
		}
		sh(`ip -n ${node} link add qorpera0 type bridge && ip -n ${node} link set qorpera0 up`);
		sh(`ip -n ${node} addr add 10.41.0.1/24 dev qorpera0 && ip -n ${node} addr add fd00:41::1/64 dev qorpera0 nodad`);
		sh(`ip -n ${node} link add coding-net type bridge && ip -n ${node} addr add 10.200.0.1/24 dev coding-net && ip -n ${node} link set coding-net up`);
		sh(`ip -n ${node} link add vg0 type veth peer name eth0 netns ${guest} && ip -n ${node} link set vg0 master qorpera0 up`);
		sh(`ip -n ${guest} addr add 10.41.0.3/24 dev eth0 && ip -n ${guest} addr add fd00:41::3/64 dev eth0 nodad`);
		sh(`ip -n ${guest} addr add 192.168.1.99/32 dev eth0 && ip -n ${guest} link set eth0 up && ip -n ${guest} route add default via 10.41.0.1`);
		sh(`ip -n ${node} link add vh0 type veth peer name eth0 netns ${guest2} && ip -n ${node} link set vh0 master qorpera0 up`);
		sh(`ip -n ${guest2} addr add 10.41.0.4/24 dev eth0 && ip -n ${guest2} link set eth0 up && ip -n ${guest2} route add default via 10.41.0.1`);
		sh(`ip -n ${node} link add vc0 type veth peer name eth0 netns ${coding} && ip -n ${node} link set vc0 master coding-net up`);
		sh(`ip -n ${coding} addr add 10.200.0.3/24 dev eth0 && ip -n ${coding} link set eth0 up && ip -n ${coding} route add default via 10.200.0.1`);
		// The office network: the router, the NAS and node 1; one internet address and our public address.
		sh(`ip -n ${node} link add lan0 type veth peer name lan1 netns ${lan} && ip -n ${node} addr add 192.168.1.42/24 dev lan0`);
		sh(`ip -n ${node} link set lan0 up && ip -n ${node} route add default via 192.168.1.1`);
		sh(`ip -n ${lan} addr add 192.168.1.1/24 dev lan1 && ip -n ${lan} addr add 192.168.1.40/24 dev lan1`);
		sh(`ip -n ${lan} addr add 192.168.1.27/24 dev lan1 && ip -n ${lan} link set lan1 up`);
		sh(`ip -n ${lan} addr add 1.1.1.1/32 dev lo && ip -n ${lan} addr add 93.164.62.162/32 dev lo && ip -n ${lan} route add 10.0.0.0/8 via 192.168.1.42`);
		// The tailnet: this node is 100.80.160.64, node 1 is 100.75.4.70.
		sh(`ip -n ${node} link add tailscale0 type veth peer name ts1 netns ${tail} && ip -n ${node} addr add 100.80.160.64/32 dev tailscale0`);
		sh(`ip -n ${node} link set tailscale0 up && ip -n ${node} route add 100.64.0.0/10 dev tailscale0`);
		sh(`ip -n ${tail} addr add 100.75.4.70/32 dev ts1 && ip -n ${tail} link set ts1 up && ip -n ${tail} route add 100.80.160.64/32 dev ts1`);
		sh(`ip -n ${tail} route add 10.0.0.0/8 via 100.80.160.64 dev ts1 onlink`);
		sh(`ip netns exec ${node} sysctl -qw net.ipv4.ip_forward=1 net.ipv4.conf.all.rp_filter=0 net.ipv4.conf.qorpera0.rp_filter=0`);
		await Promise.all([
			listen(node, [
				"10.41.0.1:22",
				"10.41.0.1:53",
				"udp:10.41.0.1:53",
				"10.41.0.1:111",
				"10.41.0.1:8789",
				"[fd00:41::1]:22",
				"10.200.0.1:22",
				"10.200.0.1:53",
				"192.168.1.42:22",
				"100.80.160.64:22",
				"100.80.160.64:10000",
			]),
			listen(lan, [
				"192.168.1.40:2049",
				"192.168.1.40:445",
				"192.168.1.40:5000",
				"192.168.1.27:22",
				"192.168.1.1:80",
				"1.1.1.1:443",
				"93.164.62.162:443",
			]),
			listen(tail, ["100.75.4.70:22", "100.75.4.70:10000", "100.75.4.70:18544"]),
			listen(guest, ["10.41.0.3:8082"]),
			listen(guest2, ["10.41.0.4:9444"]),
			listen(coding, ["10.200.0.3:22"]),
		]);
	});

	after(() => {
		for (const child of listeners) {
			child.removeAllListeners("exit");
			child.kill("SIGKILL");
		}
		for (const name of Object.values(ns)) spawnSync("ip", ["netns", "del", name]);
		if (loadedBrNetfilter) spawnSync("modprobe", ["-r", "br_netfilter"]);
	});

	test("without the guard every target answers (the stand-in node works)", (t) => {
		t.diagnostic(`br_netfilter: ${brNetfilter ? "on (guests on one bridge are checked)" : "off (same-bridge cases skipped)"}`);
		everythingConnects();
	});

	test("check parses both modes inside the node and names its bridges", () => {
		const out = guard("check");
		assert.match(out, /rules parse \(both modes\); current mode: not loaded/);
		assert.match(out, /bridge qorpera0: guarded; addresses: 10\.41\.0\.1\/24 .*fd00:41::1\/64/);
		assert.match(out, /bridge qorpera0 has IPv6; the guard refuses all guest IPv6/);
		assert.match(out, /bridge coding-net: guarded/);
	});

	test("observe refuses nothing and counts exactly what enforce would refuse", () => {
		assert.match(guard("observe"), /: observe/);
		everythingConnects();
		const c = counters();
		const sameBridge = brNetfilter ? SAME_BRIDGE.length : 0;
		assert.equal(c.forward, GUEST_REFUSED_FORWARD.length + CODING_REFUSED_FORWARD.length + sameBridge + 1, "refused_forward (+1: ping to the NAS)");
		assert.equal(c.input, GUEST_REFUSED_INPUT.length + CODING_REFUSED_INPUT.length + 1, "refused_input (+1: coding DNS over UDP to qorpera0's gateway)");
		assert.equal(c.allowed, 4, "allowed_services_used");
		assert.equal(c.spoofed, 0);
		assert.ok(c.quiet >= 1, "IPv6 is counted quietly");
		assert.equal(inNs(ns.guest, ["python3", "-c", FROM, "192.168.1.99", "1.1.1.1", "443"]).stdout.trim(), "closed");
		assert.ok(counters().spoofed >= 1, "a packet from an address outside the bridge is counted as spoofed");
		const flows = sh(`ip netns exec ${ns.node} nft list set ${TABLE} logged_flows`);
		assert.match(flows, /"qorpera0" \. 10\.41\.0\.3 \. 192\.168\.1\.40 \. tcp \. 2049/, "each refused flow is recorded once for the log");
	});

	test("enforce refuses our own networks at once and keeps the internet and the listed services", () => {
		assert.match(guard("enforce"), /: enforce/);
		expectAll(ns.guest, GUEST_OPEN, true);
		expectAll(ns.guest, GUEST_REFUSED_FORWARD, false);
		expectAll(ns.guest, GUEST_REFUSED_INPUT, false);
		if (brNetfilter) expectAll(ns.guest, SAME_BRIDGE, false);
		expectAll(ns.guest, GUEST_IPV6, false, false);
		expectAll(ns.coding, CODING_OPEN, true);
		expectAll(ns.coding, CODING_REFUSED_FORWARD, false);
		expectAll(ns.coding, CODING_REFUSED_INPUT, false);
		expectAll(ns.node, NODE_OPEN, true);
		assert.ok(udpOpen(ns.guest, "10.41.0.1", 53), "guest -> its gateway's DNS over UDP");
		assert.ok(!udpOpen(ns.coding, "10.41.0.1", 53), "coding -> another bridge's DNS over UDP is refused");
		assert.ok(pingOk(ns.guest, "10.41.0.1"), "guest pings its gateway");
		assert.ok(!pingOk(ns.guest, "192.168.1.40"), "guest cannot ping the NAS");
		const spoofedBefore = counters().spoofed;
		assert.equal(inNs(ns.guest, ["python3", "-c", FROM, "192.168.1.99", "1.1.1.1", "443"]).stdout.trim(), "closed");
		assert.ok(counters().spoofed > spoofedBefore, "a spoofed source is dropped");
		assert.match(guard("status"), /mode: enforce/);
		const verify = inNs(ns.node, ["bash", tool, "verify"]);
		assert.equal(verify.status, 1, "verify fails when the loaded mode is not the (absent) mode file's observe");
		assert.match(verify.stdout, /loaded enforce, wanted observe/);
	});

	test("switching back to observe and removing the table restore every connection", () => {
		assert.match(guard("observe"), /: observe/);
		everythingConnects();
		assert.match(guard("enforce"), /: enforce/);
		assert.match(guard("remove"), /not loaded/);
		everythingConnects();
	});
});
