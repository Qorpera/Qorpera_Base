// deploy/guest-guard: the installer pins, the tool against a stand-in `nft`, and (as root on Linux) the real
// rules on a small stand-in node built from network namespaces: a guest on qorpera0, a guest on coding-net,
// the office network with the NAS and the router, and node 1 on the tailnet. Nothing touches the host's own
// firewall: every rule is loaded inside the stand-in node's namespace.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	"-c -f /dev/stdin") cat > "$S/checked";;
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

	test("enforce adds a TCP reset and an ICMP reject to both refuse chains", () => {
		const r = run(["enforce"]);
		assert.equal(r.status, 0, r.stderr);
		assert.ok(table().includes(rules));
		assert.deepEqual(rejects(table()), [
			`add rule ${TABLE} refuse_forward meta l4proto tcp reject with tcp reset`,
			`add rule ${TABLE} refuse_forward reject with icmpx admin-prohibited`,
			`add rule ${TABLE} refuse_input meta l4proto tcp reject with tcp reset`,
			`add rule ${TABLE} refuse_input reject with icmpx admin-prohibited`,
		]);
		assert.match(r.stdout, /qorpera-guest-guard: enforce/);
	});

	test("boot loads the mode file's mode, observe without one, and refuses anything else", () => {
		const modeFile = join(dir, "mode");
		writeFileSync(modeFile, "enforce\n");
		assert.match(run(["boot"], { QORPERA_GUEST_GUARD_MODE_FILE: modeFile }).stdout, /: enforce/);
		assert.match(run(["boot"], { QORPERA_GUEST_GUARD_MODE_FILE: join(dir, "missing") }).stdout, /: observe/);
		writeFileSync(modeFile, "off\n");
		const bad = run(["boot"], { QORPERA_GUEST_GUARD_MODE_FILE: modeFile });
		assert.equal(bad.status, 78);
		assert.match(bad.stderr, /expected observe or enforce/);
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
	process.platform === "linux" && process.getuid?.() === 0 && ["nft", "ip", "python3", "timeout"].every(which);

describe("the rules on a stand-in node", { skip: canRunNamespaces ? false : "needs root on Linux with nft, ip, python3" }, () => {
	const id = `${process.pid}`;
	const ns = { node: `qgg-n${id}`, guest: `qgg-g${id}`, coding: `qgg-c${id}`, lan: `qgg-l${id}`, tail: `qgg-t${id}` };
	const listeners = [];
	const sh = (cmd) => {
		const r = spawnSync("bash", ["-c", cmd], { encoding: "utf8" });
		assert.equal(r.status, 0, `${cmd}\n${r.stderr}`);
		return r.stdout;
	};
	const LISTEN = `
import socket, sys, threading
def serve(host, port):
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind((host, int(port)))
    s.listen(64)
    while True:
        c, _ = s.accept()
        c.close()
for a in sys.argv[1:]:
    h, p = a.rsplit(":", 1)
    threading.Thread(target=serve, args=(h, p), daemon=True).start()
print("ready", flush=True)
threading.Event().wait()
`;
	const listen = (name, addresses) =>
		new Promise((resolve, reject) => {
			const child = spawn("ip", ["netns", "exec", name, "python3", "-c", LISTEN, ...addresses], {
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
	const connect = (from, target) => {
		const [host, port] = target.split(":");
		const start = Date.now();
		const r = spawnSync("ip", ["netns", "exec", from, "timeout", "3", "bash", "-c", `exec 3<>/dev/tcp/${host}/${port}`]);
		return { open: r.status === 0, ms: Date.now() - start };
	};
	const guard = (mode) => sh(`ip netns exec ${ns.node} bash ${tool} ${mode}`);
	const counters = () => {
		const out = sh(`ip netns exec ${ns.node} nft list counters table ${TABLE}`);
		const packets = (name) => Number(new RegExp(`counter ${name} \\{\\s*packets (\\d+)`).exec(out)?.[1] ?? -1);
		return { allowed: packets("allowed_services_used"), forward: packets("refused_forward"), input: packets("refused_input") };
	};

	// From the guest on qorpera0 and the guest on coding-net: what must connect and what must be refused.
	const GUEST_OPEN = ["10.41.0.1:53", "10.41.0.1:8789", "100.75.4.70:10000", "100.75.4.70:18544", "100.80.160.64:10000", "1.1.1.1:443"];
	const GUEST_REFUSED = [
		"10.41.0.1:22",
		"10.41.0.1:111",
		"192.168.1.42:22",
		"192.168.1.40:2049",
		"192.168.1.40:445",
		"192.168.1.40:5000",
		"192.168.1.27:22",
		"192.168.1.1:80",
		"100.75.4.70:22",
		"100.80.160.64:22",
		"93.164.62.162:443",
		"10.200.0.1:53",
		"10.200.0.3:22",
	];
	const CODING_OPEN = ["10.200.0.1:53", "1.1.1.1:443"];
	const CODING_REFUSED = ["10.41.0.1:8789", "10.41.0.1:53", "100.75.4.70:10000", "192.168.1.40:2049", "10.200.0.1:22", "10.41.0.3:8082"];
	// Connections the node itself opens to its guests are never checked.
	const NODE_OPEN = ["10.41.0.3:8082", "10.200.0.3:22"];

	const expectAll = (from, targets, open) => {
		for (const target of targets) {
			const r = connect(from, target);
			assert.equal(r.open, open, `${from} -> ${target}: expected ${open ? "open" : "refused"}`);
			if (!open) assert.ok(r.ms < 2000, `${from} -> ${target} refused after ${r.ms} ms; a reject answers at once`);
		}
	};
	const everythingConnects = () => {
		expectAll(ns.guest, [...GUEST_OPEN, ...GUEST_REFUSED], true);
		expectAll(ns.coding, [...CODING_OPEN, ...CODING_REFUSED], true);
		expectAll(ns.node, NODE_OPEN, true);
	};

	before(async () => {
		for (const name of Object.values(ns)) sh(`ip netns add ${name} && ip -n ${name} link set lo up`);
		const { node, guest, coding, lan, tail } = ns;
		sh(`ip -n ${node} link add qorpera0 type bridge && ip -n ${node} addr add 10.41.0.1/24 dev qorpera0 && ip -n ${node} link set qorpera0 up`);
		sh(`ip -n ${node} link add coding-net type bridge && ip -n ${node} addr add 10.200.0.1/24 dev coding-net && ip -n ${node} link set coding-net up`);
		sh(`ip -n ${node} link add vg0 type veth peer name eth0 netns ${guest} && ip -n ${node} link set vg0 master qorpera0 up`);
		sh(`ip -n ${guest} addr add 10.41.0.3/24 dev eth0 && ip -n ${guest} link set eth0 up && ip -n ${guest} route add default via 10.41.0.1`);
		sh(`ip -n ${node} link add vc0 type veth peer name eth0 netns ${coding} && ip -n ${node} link set vc0 master coding-net up`);
		sh(`ip -n ${coding} addr add 10.200.0.3/24 dev eth0 && ip -n ${coding} link set eth0 up && ip -n ${coding} route add default via 10.200.0.1`);
		// The office network: the router, the NAS and node 1; one internet address and our public address.
		sh(`ip -n ${node} link add lan0 type veth peer name lan1 netns ${lan} && ip -n ${node} addr add 192.168.1.42/24 dev lan0 && ip -n ${node} link set lan0 up && ip -n ${node} route add default via 192.168.1.1`);
		sh(`ip -n ${lan} addr add 192.168.1.1/24 dev lan1 && ip -n ${lan} addr add 192.168.1.40/24 dev lan1 && ip -n ${lan} addr add 192.168.1.27/24 dev lan1 && ip -n ${lan} link set lan1 up`);
		sh(`ip -n ${lan} addr add 1.1.1.1/32 dev lo && ip -n ${lan} addr add 93.164.62.162/32 dev lo && ip -n ${lan} route add 10.0.0.0/8 via 192.168.1.42`);
		// The tailnet: this node is 100.80.160.64, node 1 is 100.75.4.70.
		sh(`ip -n ${node} link add tailscale0 type veth peer name ts1 netns ${tail} && ip -n ${node} addr add 100.80.160.64/32 dev tailscale0 && ip -n ${node} link set tailscale0 up && ip -n ${node} route add 100.64.0.0/10 dev tailscale0`);
		sh(`ip -n ${tail} addr add 100.75.4.70/32 dev ts1 && ip -n ${tail} link set ts1 up && ip -n ${tail} route add 100.80.160.64/32 dev ts1 && ip -n ${tail} route add 10.0.0.0/8 via 100.80.160.64 dev ts1 onlink`);
		sh(`ip netns exec ${node} sysctl -qw net.ipv4.ip_forward=1`);
		await Promise.all([
			listen(node, [
				"10.41.0.1:22",
				"10.41.0.1:53",
				"10.41.0.1:111",
				"10.41.0.1:8789",
				"10.200.0.1:22",
				"10.200.0.1:53",
				"192.168.1.42:22",
				"100.80.160.64:22",
				"100.80.160.64:10000",
			]),
			listen(lan, ["192.168.1.40:2049", "192.168.1.40:445", "192.168.1.40:5000", "192.168.1.27:22", "192.168.1.1:80", "1.1.1.1:443", "93.164.62.162:443"]),
			listen(tail, ["100.75.4.70:22", "100.75.4.70:10000", "100.75.4.70:18544"]),
			listen(guest, ["10.41.0.3:8082"]),
			listen(coding, ["10.200.0.3:22"]),
		]);
	});

	after(() => {
		for (const child of listeners) {
			child.removeAllListeners("exit");
			child.kill("SIGKILL");
		}
		for (const name of Object.values(ns)) spawnSync("ip", ["netns", "del", name]);
	});

	test("without the guard every target answers (the stand-in node works)", () => {
		everythingConnects();
	});

	test("check parses both modes inside the node and names its bridges", () => {
		const out = guard("check");
		assert.match(out, /rules parse \(both modes\); current mode: not loaded/);
		assert.match(out, /bridge qorpera0: guarded/);
		assert.match(out, /bridge coding-net: guarded/);
	});

	test("observe refuses nothing but counts what enforce would refuse", () => {
		assert.match(guard("observe"), /: observe/);
		everythingConnects();
		const c = counters();
		assert.ok(c.forward >= 9, `refused_forward ${c.forward}`);
		assert.ok(c.input >= 6, `refused_input ${c.input}`);
		assert.ok(c.allowed >= 4, `allowed_services_used ${c.allowed}`);
	});

	test("enforce refuses our own networks at once and keeps the internet and the listed services", () => {
		assert.match(guard("enforce"), /: enforce/);
		expectAll(ns.guest, GUEST_OPEN, true);
		expectAll(ns.guest, GUEST_REFUSED, false);
		expectAll(ns.coding, CODING_OPEN, true);
		expectAll(ns.coding, CODING_REFUSED, false);
		expectAll(ns.node, NODE_OPEN, true);
		assert.match(guard("status"), /mode: enforce/);
	});

	test("switching back to observe and removing the table restore every connection", () => {
		assert.match(guard("observe"), /: observe/);
		everythingConnects();
		assert.match(guard("enforce"), /: enforce/);
		assert.match(guard("remove"), /not loaded/);
		everythingConnects();
	});
});
