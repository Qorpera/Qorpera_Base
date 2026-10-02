// deploy/guest-guard: the installer pins, the tool against a stand-in `nft` and `ip`, and (as root on Linux) the
// real rules on a small stand-in node built from network namespaces: two guests on qorpera0, a guest on
// coding-net, the office network with the NAS and the router, and node 1 on the tailnet. Nothing touches the
// host's own firewall: every rule is loaded inside the stand-in node's namespace.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const tool = join(here, "qorpera-guest-guard.sh");
const rules = readFileSync(join(here, "qorpera-guest-guard.nft"), "utf8");
const TABLE = "inet qorpera_guest_guard";

const sha256 = (file) => createHash("sha256").update(readFileSync(join(here, file))).digest("hex");
// The tool needs bash 4.4 (inherit_errexit, associative arrays), as on the nodes; macOS ships bash 3.2.
const modernBash =
	spawnSync("bash", ["-c", "((BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4)))"]).status === 0;

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

describe("the tool against a stand-in nft and ip", { skip: modernBash ? false : "needs bash 4.4 or later" }, () => {
	let dir;
	let env;
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "guest-guard-"));
		// The stand-in nft keeps the last loaded batch as the "table"; list prints it, delete removes it.
		writeFileSync(
			join(dir, "nft"),
			`#!/usr/bin/env bash
S="$STUB_STATE"
echo "nft $*" >> "$S/log"
case "$*" in
	"-f /dev/stdin") cat > "$S/table";;
	"-c -f /dev/stdin") cat > "$S/checked"; ! grep -q BROKEN "$S/checked";;
	"list table ${TABLE}") [[ -f "$S/table" ]] || { echo "Error: No such file or directory" >&2; exit 1; };;
	"list chain ${TABLE} refuse_input") grep '^add rule' "$S/table" || true;;
	"list counters table ${TABLE}") echo counters;;
	"delete table ${TABLE}") rm -f "$S/table";;
	*) echo "unexpected nft $*" >&2; exit 2;;
esac
`,
		);
		// The stand-in ip lists the bridges in $S/bridges and answers from $S/route.<bridge> and $S/v6.<bridge>.
		writeFileSync(
			join(dir, "ip"),
			`#!/usr/bin/env bash
S="$STUB_STATE"
case "$*" in
	"-o link show type bridge") n=1; for b in $(cat "$S/bridges" 2>/dev/null); do echo "$n: $b: <BROADCAST,UP>"; n=$((n + 1)); done;;
	"-o -4 route show dev "*" proto kernel scope link") cat "$S/route.$6" 2>/dev/null || true;;
	"-o -6 addr show dev "*" scope global") cat "$S/v6.$6" 2>/dev/null || true;;
	*) echo "unexpected ip $*" >&2; exit 2;;
esac
`,
		);
		chmodSync(join(dir, "nft"), 0o755);
		chmodSync(join(dir, "ip"), 0o755);
		writeFileSync(join(dir, "brnf"), "1\n");
		env = {
			...process.env,
			PATH: `${dir}:${process.env.PATH}`,
			STUB_STATE: dir,
			QORPERA_GUEST_GUARD_MODE_FILE: join(dir, "mode"),
			QORPERA_GUEST_GUARD_BR_NETFILTER: join(dir, "brnf"),
		};
	});
	after(() => rmSync(dir, { recursive: true, force: true }));
	const run = (args, extra = {}, input = "") =>
		spawnSync("bash", [tool, ...args], { env: { ...env, ...extra }, encoding: "utf8", input });
	const table = () => readFileSync(join(dir, "table"), "utf8");
	const added = (text) => text.split("\n").filter((line) => line.startsWith("add rule"));
	const bridges = (spec) => {
		for (const [name, { route = "", v6 = "" }] of Object.entries(spec)) {
			writeFileSync(join(dir, `route.${name}`), route);
			writeFileSync(join(dir, `v6.${name}`), v6);
		}
		writeFileSync(join(dir, "bridges"), Object.keys(spec).join(" "));
	};
	const mode = (value) =>
		value ? writeFileSync(join(dir, "mode"), `${value}\n`) : rmSync(join(dir, "mode"), { force: true });
	const QORPERA0 = "10.41.0.0/24 proto kernel scope link src 10.41.0.1\n";

	test("observe loads the table in one transaction, with no refusal", () => {
		bridges({});
		const r = run(["observe"]);
		assert.equal(r.status, 0, r.stderr);
		assert.ok(table().startsWith(`table ${TABLE}\ndelete table ${TABLE}\n`));
		assert.ok(table().includes(rules));
		assert.deepEqual(added(table()), []);
		assert.match(r.stdout, /qorpera-guest-guard: observe/);
	});

	test("enforce adds the refusals: reset or ICMP for refused flows, drop for the quiet ones", () => {
		const r = run(["enforce"]);
		assert.equal(r.status, 0, r.stderr);
		assert.ok(table().includes(rules));
		assert.deepEqual(added(table()), [
			`add rule ${TABLE} refuse_forward meta l4proto tcp reject with tcp reset`,
			`add rule ${TABLE} refuse_forward reject with icmpx admin-prohibited`,
			`add rule ${TABLE} refuse_input meta l4proto tcp reject with tcp reset`,
			`add rule ${TABLE} refuse_input reject with icmpx admin-prohibited`,
			`add rule ${TABLE} refuse_spoofed drop`,
			`add rule ${TABLE} refuse_invalid drop`,
			`add rule ${TABLE} refuse_related drop`,
			`add rule ${TABLE} refuse_quiet drop`,
		]);
		assert.match(r.stdout, /qorpera-guest-guard: enforce/);
	});

	test("check and enforce compare the node's bridges with the rules", () => {
		bridges({
			qorpera0: { route: QORPERA0 },
			"coding-net": { route: "10.200.0.0/24 proto kernel scope link src 10.200.0.1 linkdown\n" },
		});
		const ok = run(["check"]);
		assert.equal(ok.status, 0, ok.stdout + ok.stderr);
		assert.match(ok.stdout, /bridge qorpera0: matches \(10\.41\.0\.1\/24\)/);
		assert.match(ok.stdout, /bridge coding-net: matches \(10\.200\.0\.1\/24\)/);

		bridges({ qorpera0: { route: QORPERA0 }, docker0: {} });
		const unguarded = run(["check"]);
		assert.equal(unguarded.status, 2);
		assert.match(unguarded.stdout, /NOT GUARDED bridge docker0/);
		assert.equal(run(["enforce"]).status, 0, "an unguarded bridge does not stop enforce on the others");

		run(["observe"]);
		const before = table();
		bridges({ "machine-net": { route: "10.88.4.0/24 proto kernel scope link src 10.88.4.1\n" } });
		const wrong = run(["enforce"]);
		assert.equal(wrong.status, 1);
		assert.match(
			wrong.stderr,
			/MISMATCH bridge machine-net: has '10\.88\.4\.0\/24 10\.88\.4\.1'.*rules say '10\.88\.0\.0\/22 10\.88\.0\.1'/,
		);
		assert.match(wrong.stderr, /refusing to enforce/);
		assert.equal(table(), before, "a refused enforce leaves the loaded table alone");
		assert.equal(run(["observe"]).status, 0, "observe never refuses");

		bridges({ qorpera0: { route: QORPERA0, v6: "5: qorpera0    inet6 fd00:41::1/64 scope global\n" } });
		const v6 = run(["check"]);
		assert.equal(v6.status, 1);
		assert.match(v6.stdout, /MISMATCH bridge qorpera0: has IPv6 fd00:41::1\/64/);
		assert.equal(run(["enforce"], { QORPERA_GUEST_GUARD_FORCE: "1" }).status, 0, "QORPERA_GUEST_GUARD_FORCE=1 overrides");
		bridges({});
	});

	test("boot loads the mode file's mode and refuses a missing or unknown one", () => {
		bridges({});
		mode("enforce");
		assert.match(run(["boot"]).stdout, /: enforce/);
		const before = table();
		mode(undefined);
		const none = run(["boot"]);
		assert.equal(none.status, 1);
		assert.match(none.stderr, /no mode file/);
		mode("off");
		const bad = run(["boot"]);
		assert.equal(bad.status, 78);
		assert.match(bad.stderr, /expected observe or enforce/);
		assert.equal(table(), before, "neither loads anything");
	});

	test("verify compares the loaded mode with the mode file and needs br_netfilter while loaded", () => {
		bridges({});
		mode("enforce");
		run(["enforce"]);
		assert.equal(run(["verify"]).status, 0);
		run(["observe"]);
		const wrong = run(["verify"]);
		assert.equal(wrong.status, 1);
		assert.match(wrong.stdout, /loaded observe, wanted enforce/);
		run(["enforce"]);
		writeFileSync(join(dir, "brnf"), "0\n");
		assert.equal(run(["verify"]).status, 1, "br_netfilter off");
		writeFileSync(join(dir, "brnf"), "1\n");
		bridges({ "machine-net": { route: "10.88.4.0/24 src 10.88.4.1\n" } });
		const drifted = run(["verify"]);
		assert.equal(drifted.status, 1, "a bridge changed after enforce");
		assert.match(drifted.stderr, /a bridge no longer matches the rules/);
		bridges({});
		run(["remove"]);
		mode(undefined);
		const off = run(["verify"]);
		assert.equal(off.status, 0, "no mode file and no table is the undone state");
		assert.match(off.stdout, /loaded not loaded, wanted not loaded/);
	});

	test("an unreadable, foreign or broken rules file never touches the loaded table", () => {
		bridges({});
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
		// cat fails after the checks pass: the half-built batch is abandoned, never applied.
		const fake = join(dir, "fake");
		mkdirSync(fake, { recursive: true });
		writeFileSync(join(fake, "cat"), "#!/usr/bin/env bash\nexit 1\n");
		chmodSync(join(fake, "cat"), 0o755);
		const catFails = run(["observe"], { PATH: `${fake}:${env.PATH}` });
		assert.notEqual(catFails.status, 0);
		assert.equal(table(), before);
	});

	test("remove deletes the table, is a no-op when it is gone, and stops when nft cannot read it", () => {
		run(["observe"]);
		assert.match(run(["remove"]).stdout, /not loaded/);
		assert.match(run(["remove"]).stdout, /not loaded/);
		const fake = join(dir, "denied");
		mkdirSync(fake, { recursive: true });
		writeFileSync(join(fake, "nft"), "#!/usr/bin/env bash\necho 'Error: Operation not permitted' >&2\nexit 1\n");
		chmodSync(join(fake, "nft"), 0o755);
		const denied = run(["remove"], { PATH: `${fake}:${env.PATH}` });
		assert.equal(denied.status, 1);
		assert.match(denied.stderr, /nft cannot read the table: Error: Operation not permitted/);
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
			r.stdout
				.trim()
				.split("\n")
				.map((l) => l.trim()),
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
	modernBash &&
	process.platform === "linux" &&
	process.getuid?.() === 0 &&
	["nft", "ip", "python3", "timeout", "ping"].every(which);

describe(
	"the rules on a stand-in node",
	{ skip: canRunNamespaces ? false : "needs root on Linux with bash 4.4, nft, ip, python3, timeout and ping" },
	() => {
		const id = `${process.pid}`;
		const ns = {
			node: `qgg-n${id}`,
			guest: `qgg-g${id}`,
			guest2: `qgg-h${id}`,
			coding: `qgg-c${id}`,
			lan: `qgg-l${id}`,
			tail: `qgg-t${id}`,
		};
		const children = [];
		const state = mkdtempSync(join(tmpdir(), "guest-guard-root-"));
		const modeFile = join(state, "mode");
		// br_netfilter is loaded on our nodes, so bridged traffic between two guests reaches the guard there.
		// The test machine does not load it; QORPERA_GUEST_GUARD_TEST_BR_NETFILTER=1 loads it for this run.
		let brNetfilter = false;
		let loadedBrNetfilter = false;
		let dhcpSeen = [];
		let nodeNfsPort = 0;
		const sh = (cmd) => {
			const r = spawnSync("bash", ["-c", cmd], { encoding: "utf8" });
			assert.equal(r.status, 0, `${cmd}\n${r.stdout}${r.stderr}`);
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
		// A DHCP server stand-in on the node: prints the source of every datagram to port 67.
		const DHCP_SEEN = `
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
s.bind(("0.0.0.0", 67))
print("ready", flush=True)
while True:
    data, peer = s.recvfrom(512)
    print("from %s %s" % (peer[0], data.decode()), flush=True)
`;
		const DHCP_SEND = `
import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
s.bind((sys.argv[1], 68))
s.sendto(sys.argv[3].encode(), (sys.argv[2], 67))
`;
		// The node's own connection to the NAS, held open: the target of a forged ICMP error.
		const HOLD = `
import socket, threading
s = socket.create_connection(("192.168.1.40", 2049))
print("ready", flush=True)
print("port %d" % s.getsockname()[1], flush=True)
threading.Event().wait()
`;
		// A forged ICMP port-unreachable about the node's NFS connection, sent from a guest.
		const FORGE = `
import socket, struct, sys
def csum(b):
    if len(b) % 2:
        b += b"\\0"
    s = sum(struct.unpack("!%dH" % (len(b) // 2), b))
    while s >> 16:
        s = (s & 0xffff) + (s >> 16)
    return ~s & 0xffff
def ip(src, dst, proto, payload):
    h = struct.pack("!BBHHHBBH4s4s", 0x45, 0, 20 + len(payload), 0x1234, 0, 64, proto, 0, socket.inet_aton(src), socket.inet_aton(dst))
    return h[:10] + struct.pack("!H", csum(h)) + h[12:] + payload
src, dst, isrc, isport, idst, idport = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5], int(sys.argv[6])
inner = ip(isrc, idst, 6, struct.pack("!HHI", isport, idport, 1))
icmp = struct.pack("!BBHI", 3, 3, 0, 0) + inner
icmp = icmp[:2] + struct.pack("!H", csum(icmp)) + icmp[4:]
r = socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_RAW)
r.sendto(ip(src, dst, 1, icmp), (dst, 0))
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
		// Runs a Python helper in a namespace; resolves on its "ready" line and passes later lines to onLine.
		const background = (name, script, args, onLine) =>
			new Promise((resolve, reject) => {
				const child = spawn("ip", ["netns", "exec", name, "python3", "-c", script, ...args], {
					stdio: ["ignore", "pipe", "pipe"],
				});
				children.push(child);
				let err = "";
				let buffered = "";
				child.stderr.on("data", (d) => {
					err += d;
				});
				child.stdout.on("data", (d) => {
					buffered += d;
					const lines = buffered.split("\n");
					buffered = lines.pop();
					for (const line of lines) {
						if (line === "ready") resolve();
						else onLine?.(line);
					}
				});
				child.on("exit", (code) => reject(new Error(`${name} python exited ${code}: ${err}`)));
			});
		const listen = (name, addresses) => background(name, SERVE, addresses);
		const inNs = (name, args, timeout = 5000) =>
			spawnSync("ip", ["netns", "exec", name, ...args], { encoding: "utf8", timeout });
		const connect = (from, target) => {
			const host = target.startsWith("[")
				? target.slice(1, target.indexOf("]"))
				: target.slice(0, target.lastIndexOf(":"));
			const port = target.slice(target.lastIndexOf(":") + 1);
			const start = Date.now();
			const r = inNs(from, ["timeout", "3", "bash", "-c", `exec 3<>/dev/tcp/${host}/${port}`]);
			return { open: r.status === 0, ms: Date.now() - start };
		};
		const udpOpen = (from, host, port) =>
			inNs(from, ["python3", "-c", UDP_ASK, host, `${port}`]).stdout.trim() === "open";
		const pingOk = (from, host) => inNs(from, ["ping", "-c", "1", "-W", "1", host]).status === 0;
		const guardRun = (mode, extra) =>
			inNs(ns.node, ["env", `QORPERA_GUEST_GUARD_MODE_FILE=${modeFile}`, ...(extra ? [extra] : []), "bash", tool, mode]);
		// The stand-in node has IPv6 on qorpera0 and a mismatched machine-net on purpose, so enforce needs FORCE.
		const guard = (mode) => {
			const r = guardRun(mode, mode === "enforce" ? "QORPERA_GUEST_GUARD_FORCE=1" : undefined);
			assert.equal(r.status, 0, `${mode}\n${r.stdout}${r.stderr}`);
			return r.stdout;
		};
		const counters = () => {
			const out = sh(`ip netns exec ${ns.node} nft list counters table ${TABLE}`);
			const packets = (name) => Number(new RegExp(`counter ${name} \\{\\s*packets (\\d+)`).exec(out)?.[1] ?? -1);
			return {
				allowed: packets("allowed_services_used"),
				forward: packets("refused_forward"),
				input: packets("refused_input"),
				spoofed: packets("refused_spoofed"),
				invalid: packets("refused_invalid"),
				related: packets("refused_related"),
			};
		};
		const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

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
		const ALL_DHCP = ["from 10.200.0.3 other-gateway", "from 10.41.0.3 broadcast", "from 10.41.0.3 own-gateway"];

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
		const dhcp = async () => {
			dhcpSeen = [];
			inNs(ns.guest, ["python3", "-c", DHCP_SEND, "10.41.0.3", "255.255.255.255", "broadcast"]);
			inNs(ns.guest, ["python3", "-c", DHCP_SEND, "10.41.0.3", "10.41.0.1", "own-gateway"]);
			inNs(ns.coding, ["python3", "-c", DHCP_SEND, "10.200.0.3", "10.41.0.1", "other-gateway"]);
			await settle();
			return [...dhcpSeen].sort();
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
			sh(`ip -n ${node} link add coding-net type bridge && ip -n ${node} addr add 10.200.0.1/24 dev coding-net`);
			sh(`ip -n ${node} link set coding-net up`);
			// A bridge whose subnet differs from the rules: enforce must refuse it without FORCE.
			sh(`ip -n ${node} link add machine-net type bridge && ip -n ${node} addr add 10.88.4.1/24 dev machine-net`);
			sh(`ip -n ${node} link set machine-net up`);
			sh(`ip -n ${node} link add vg0 type veth peer name eth0 netns ${guest} && ip -n ${node} link set vg0 master qorpera0 up`);
			sh(`ip -n ${guest} addr add 10.41.0.3/24 dev eth0 && ip -n ${guest} addr add fd00:41::3/64 dev eth0 nodad`);
			sh(`ip -n ${guest} addr add 192.168.1.99/32 dev eth0 && ip -n ${guest} link set eth0 up`);
			sh(`ip -n ${guest} route add default via 10.41.0.1`);
			sh(`ip -n ${node} link add vh0 type veth peer name eth0 netns ${guest2} && ip -n ${node} link set vh0 master qorpera0 up`);
			sh(`ip -n ${guest2} addr add 10.41.0.4/24 dev eth0 && ip -n ${guest2} link set eth0 up`);
			sh(`ip -n ${guest2} route add default via 10.41.0.1`);
			sh(`ip -n ${node} link add vc0 type veth peer name eth0 netns ${coding} && ip -n ${node} link set vc0 master coding-net up`);
			sh(`ip -n ${coding} addr add 10.200.0.3/24 dev eth0 && ip -n ${coding} link set eth0 up`);
			sh(`ip -n ${coding} route add default via 10.200.0.1`);
			// The office network: the router, the NAS and node 1; one internet address and our public address.
			sh(`ip -n ${node} link add lan0 type veth peer name lan1 netns ${lan} && ip -n ${node} addr add 192.168.1.42/24 dev lan0`);
			sh(`ip -n ${node} link set lan0 up && ip -n ${node} route add default via 192.168.1.1`);
			sh(`ip -n ${lan} addr add 192.168.1.1/24 dev lan1 && ip -n ${lan} addr add 192.168.1.40/24 dev lan1`);
			sh(`ip -n ${lan} addr add 192.168.1.27/24 dev lan1 && ip -n ${lan} link set lan1 up`);
			sh(`ip -n ${lan} addr add 1.1.1.1/32 dev lo && ip -n ${lan} addr add 93.164.62.162/32 dev lo`);
			sh(`ip -n ${lan} route add 10.0.0.0/8 via 192.168.1.42`);
			// The tailnet: this node is 100.80.160.64, node 1 is 100.75.4.70.
			sh(`ip -n ${node} link add tailscale0 type veth peer name ts1 netns ${tail}`);
			sh(`ip -n ${node} addr add 100.80.160.64/32 dev tailscale0 && ip -n ${node} link set tailscale0 up`);
			sh(`ip -n ${node} route add 100.64.0.0/10 dev tailscale0`);
			sh(`ip -n ${tail} addr add 100.75.4.70/32 dev ts1 && ip -n ${tail} link set ts1 up`);
			sh(`ip -n ${tail} route add 100.80.160.64/32 dev ts1 && ip -n ${tail} route add 10.0.0.0/8 via 100.80.160.64 dev ts1 onlink`);
			sh(
				`ip netns exec ${node} sysctl -qw net.ipv4.ip_forward=1 net.ipv4.conf.all.rp_filter=0 net.ipv4.conf.qorpera0.rp_filter=0`,
			);
			// LXD's own NAT, as on a node: it also keeps connection tracking on before the guard loads.
			sh(
				`printf 'table ip lxd_nat_stub {\n chain pstrt {\n  type nat hook postrouting priority srcnat; policy accept;\n  oifname "lan0" ip saddr 10.0.0.0/8 masquerade\n }\n}\n' | ip netns exec ${node} nft -f -`,
			);
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
				background(node, DHCP_SEEN, [], (line) => {
					dhcpSeen.push(line);
				}),
			]);
			// The node's own NFS connection exists before the guard loads, as on a real node.
			await new Promise((resolve, reject) => {
				background(node, HOLD, [], (line) => {
					nodeNfsPort = Number(line.split(" ")[1]);
					resolve();
				}).catch(reject);
			});
		});

		after(() => {
			for (const child of children) {
				child.removeAllListeners("exit");
				child.kill("SIGKILL");
			}
			for (const name of Object.values(ns)) spawnSync("ip", ["netns", "del", name]);
			if (loadedBrNetfilter) spawnSync("modprobe", ["-r", "br_netfilter"]);
			rmSync(state, { recursive: true, force: true });
		});

		test("without the guard every target answers (the stand-in node works)", async (t) => {
			t.diagnostic(
				`br_netfilter: ${brNetfilter ? "on (guests on one bridge are checked)" : "off (same-bridge cases skipped)"}`,
			);
			everythingConnects();
			assert.deepEqual(await dhcp(), ALL_DHCP);
		});

		test("check names every bridge and finds the ones that do not match the rules", () => {
			const r = guardRun("check");
			assert.equal(r.status, 1, r.stdout + r.stderr);
			assert.match(r.stdout, /rules parse \(both modes\); current mode: not loaded; mode file: not loaded/);
			assert.match(r.stdout, /MISMATCH bridge qorpera0: has IPv6 fd00:41::1\/64/);
			assert.match(r.stdout, /bridge coding-net: matches \(10\.200\.0\.1\/24\)/);
			assert.match(r.stdout, /MISMATCH bridge machine-net: has '10\.88\.4\.0\/24 10\.88\.4\.1'/);
			const refused = guardRun("enforce");
			assert.equal(refused.status, 1);
			assert.match(refused.stderr, /refusing to enforce/);
		});

		test("observe refuses nothing and counts exactly what enforce would refuse", async () => {
			assert.match(guard("observe"), /: observe/);
			everythingConnects();
			const c = counters();
			const sameBridge = brNetfilter ? SAME_BRIDGE.length : 0;
			assert.equal(
				c.forward,
				GUEST_REFUSED_FORWARD.length + CODING_REFUSED_FORWARD.length + sameBridge + 1,
				"refused_forward (+1: ping to the NAS)",
			);
			assert.equal(
				c.input,
				GUEST_REFUSED_INPUT.length + CODING_REFUSED_INPUT.length + 1,
				"refused_input (+1: coding DNS over UDP to qorpera0's gateway)",
			);
			assert.equal(c.allowed, 4, "allowed_services_used");
			assert.equal(c.spoofed, 0);
			assert.equal(c.related, 0);
			assert.equal(inNs(ns.guest, ["python3", "-c", FROM, "192.168.1.99", "1.1.1.1", "443"]).stdout.trim(), "closed");
			const spoofed = counters().spoofed;
			assert.ok(spoofed >= 1, "a packet from an address outside the bridge is counted as spoofed");
			const forward = counters().forward;
			assert.deepEqual(await dhcp(), ALL_DHCP);
			assert.equal(counters().spoofed, spoofed, "DHCP broadcast copies to other guests are not counted as spoofed");
			assert.equal(counters().forward, forward, "nor as refused flows");
			const flows = sh(`ip netns exec ${ns.node} nft list set ${TABLE} logged_flows`);
			assert.match(flows, /"qorpera0" \. 10\.41\.0\.3 \. 192\.168\.1\.40 \. tcp \. 2049/, "a refused flow is recorded once");
			const other = sh(`ip netns exec ${ns.node} nft list set ${TABLE} logged_other`);
			assert.match(other, /"qorpera0" \. 10\.41\.0\.3 \. 192\.168\.1\.40 \. icmp/, "ICMP is recorded per protocol");
		});

		test("enforce refuses our own networks at once and keeps the internet and the listed services", async () => {
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
			assert.deepEqual(
				await dhcp(),
				["from 10.41.0.3 broadcast", "from 10.41.0.3 own-gateway"],
				"DHCP: broadcast and own gateway only",
			);
			const before = counters();
			assert.equal(inNs(ns.guest, ["python3", "-c", FROM, "192.168.1.99", "1.1.1.1", "443"]).stdout.trim(), "closed");
			inNs(ns.guest, [
				"python3",
				"-c",
				FORGE,
				"10.41.0.3",
				"192.168.1.42",
				"192.168.1.42",
				`${nodeNfsPort}`,
				"192.168.1.40",
				"2049",
			]);
			await settle();
			const afterwards = counters();
			assert.ok(afterwards.spoofed > before.spoofed, "a spoofed source is dropped");
			assert.equal(afterwards.related, before.related + 1, "an ICMP error about the node's NFS connection is dropped");
			assert.match(guard("status"), /mode: enforce/);
			const verify = guardRun("verify");
			assert.equal(verify.status, 1, "no mode file: verify wants the guard not loaded");
			assert.match(verify.stdout, /loaded enforce, wanted not loaded/);
		});

		test("switching back to observe and removing the table restore every connection", async () => {
			assert.match(guard("observe"), /: observe/);
			everythingConnects();
			assert.match(guard("enforce"), /: enforce/);
			assert.match(guard("remove"), /not loaded/);
			everythingConnects();
			assert.deepEqual(await dhcp(), ALL_DHCP);
		});
	},
);
