// deploy/agent-exit: the installer pins, the connection logger's parsers and pause, the logs' tender and counts, their
// shipper to the NAS and the lookup, the agent plug's client map and reconciler (against a stand-in for LXD), and (on
// Linux with Docker) the root proof in
// test/proof.sh, run inside a privileged,
// network-less throwaway container that plays a node. Every namespace, bridge, link and rule it makes lives inside the
// container's own network namespaces. It never loads or unloads a kernel module itself (the kernel loads nftables'
// and the bridge's modules on demand and keeps them) and changes no sysctl of the machine's own namespace; the test
// checks that the machine's bridges are all still there afterwards. The one thing a proof must never do on a shared
// test machine is unload a module: `modprobe -r br_netfilter` also unloads `bridge`, which destroys every bridge on
// the machine (3 October, an E2b draft run bare on a test machine did that, not this proof).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const logger = join(here, "qorpera-agent-exit-log.py");
const plugTool = join(here, "qorpera-agent-plug.py");
const logsTool = join(here, "qorpera-agent-exit-logs.py");
// The deletion records of a log folder (lost/<name>.json), in the order they were written.
const lostRecords = (folder) =>
	(existsSync(join(folder, "lost")) ? readdirSync(join(folder, "lost")) : [])
		.filter((name) => name.endsWith(".json") && !name.startsWith("."))
		.map((name) => JSON.parse(readFileSync(join(folder, "lost", name), "utf8")))
		.sort((a, b) => a.recordedAt - b.recordedAt);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

test("the installer pins the files in this folder", () => {
	const installer = readFileSync(join(here, "install-agent-exit.sh"), "utf8");
	for (const [name, file] of [
		["TOOL", "qorpera-agent-exit.sh"],
		["EXIT_RULES", "qorpera-agent-exit.nft"],
		["HOST_RULES", "qorpera-agent-exit-host.nft"],
		["LOGGER", "qorpera-agent-exit-log.py"],
		["UNIT", "qorpera-agent-exit.service"],
		["DNS_UNIT", "qorpera-agent-exit-dns.service"],
		["LOG_UNIT", "qorpera-agent-exit-log.service"],
		["PLUG", "qorpera-agent-plug.py"],
		["PLUG_UNIT", "qorpera-agent-plug.service"],
		["BRIDGE_RULES", "qorpera-agent-exit-bridge.nft"],
		["HEALTH_UNIT", "qorpera-agent-exit-health.service"],
		["HEALTH_TIMER", "qorpera-agent-exit-health.timer"],
		["LOGS", "qorpera-agent-exit-logs.py"],
		["LOGS_UNIT", "qorpera-agent-exit-logs.service"],
		["LOGS_TIMER", "qorpera-agent-exit-logs.timer"],
		["SHIP_UNIT", "qorpera-agent-exit-ship.service"],
		["SHIP_TIMER", "qorpera-agent-exit-ship.timer"],
	]) {
		assert.match(installer, new RegExp(`EXPECTED_${name}_SHA256="${sha256(readFileSync(join(here, file)))}"`), `${file} pin`);
	}
});

describe("the connection logger", () => {
	const run = (flag, input) => {
		const r = spawnSync("python3", [logger, flag], { input, encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		return r.stdout
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	};

	test("conntrack lines become records for agent connections only, with bytes each way", () => {
		const lines = [
			"[1790990000.123456]\t    [NEW] ipv4     2 tcp      6 120 SYN_SENT src=10.210.0.10 dst=1.1.1.1 sport=40000 dport=443 [UNREPLIED] src=1.1.1.1 dst=10.209.255.2 sport=443 dport=40000 id=77",
			"[1790990005.500000]\t[DESTROY] ipv4     2 tcp      6 src=10.210.0.10 dst=1.1.1.1 sport=40000 dport=443 packets=6 bytes=380 src=1.1.1.1 dst=10.209.255.2 sport=443 dport=40000 packets=4 bytes=232 [ASSURED] id=77",
			"[1790990006.000000]\t[DESTROY] ipv4     2 udp      17 src=10.209.255.2 dst=9.9.9.9 sport=5353 dport=53 packets=1 bytes=60 src=9.9.9.9 dst=10.209.255.2 sport=53 dport=5353 packets=1 bytes=76 id=78",
			"[1790990006.500000]\t    [NEW] ipv4     2 udp      17 30 src=10.210.0.1 dst=10.210.0.10 sport=67 dport=68 [UNREPLIED] src=10.210.0.10 dst=10.210.0.1 sport=68 dport=67 id=80",
			"[1790990007.000000]\t[DESTROY] ipv4     2 icmp     1 src=10.210.0.10 dst=1.1.1.1 type=8 code=0 id=4321 packets=1 bytes=84 src=1.1.1.1 dst=10.209.255.2 type=0 code=0 id=4321 packets=1 bytes=84 id=79",
			"conntrack v1.4.8 (conntrack-tools): 4 flow events have been shown.",
		].join("\n");
		assert.deepEqual(run("--parse-conntrack", lines), [
			{ ts: 1790990000.123456, event: "new", proto: "tcp", src: "10.210.0.10", dst: "1.1.1.1", sport: 40000, dport: 443, id: 77 },
			{
				ts: 1790990005.5,
				event: "destroy",
				proto: "tcp",
				src: "10.210.0.10",
				dst: "1.1.1.1",
				sport: 40000,
				dport: 443,
				packets_out: 6,
				bytes_out: 380,
				packets_in: 4,
				bytes_in: 232,
				id: 77,
			},
			{
				ts: 1790990007,
				event: "destroy",
				proto: "icmp",
				src: "10.210.0.10",
				dst: "1.1.1.1",
				packets_out: 1,
				bytes_out: 84,
				packets_in: 1,
				bytes_in: 84,
				id: 79,
			},
		]);
	});

	test("the refused-flow sets become one key per element, with or without timeouts, any protocol as text", () => {
		const set = JSON.stringify({
			nftables: [
				{ metainfo: { version: "1.1.6" } },
				{
					set: {
						family: "inet",
						name: "refused_flows",
						table: "qorpera_agent_exit",
						elem: [
							{ elem: { val: { concat: ["10.210.0.10", "192.168.1.40", "tcp", 2049] }, timeout: 3600, expires: 3590 } },
							{ concat: ["10.210.0.11", "1.1.1.1", "tcp", 25] },
							{ elem: { val: { concat: ["10.210.0.10", "192.168.1.40", 253] }, timeout: 3600, expires: 3500 } },
						],
					},
				},
			],
		});
		assert.deepEqual(run("--parse-set", set), [
			[["10.210.0.10", "192.168.1.40", "tcp", 2049], 3590],
			[["10.210.0.11", "1.1.1.1", "tcp", 25], null],
			[["10.210.0.10", "192.168.1.40", "253"], 3500],
		]);
	});

	test("a refused flow is logged when new or added again, with the rule that refused it", () => {
		const nas = ["10.210.0.10", "192.168.1.40", "tcp", 2049];
		const mail = ["10.210.0.10", "1.1.1.1", "tcp", 25];
		const other = ["10.210.0.10", "192.168.1.40", "253"];
		const busy = ["10.210.0.11", "8.8.4.4", "tcp", 443];
		const diff = run(
			"--diff-sets",
			JSON.stringify({
				previous: [
					[nas, 1200],
					[busy, 900],
				],
				current: [
					[nas, 1195],
					[mail, 3600],
					[other, 3600],
					[busy, 3599],
				],
			}),
		);
		assert.deepEqual(diff, [
			[mail, "mail"],
			[other, "our_networks"],
			[busy, "open_limit"],
		]);
	});
});

test("the logger pauses past the logs' cap or under the disk's floor, and goes on only with room again", () => {
	const cap = 1000;
	const decide = (paused, freePercent, bytes) => {
		const r = spawnSync("python3", [logger, "--should-pause"], {
			input: JSON.stringify({ paused, freePercent, bytes, cap, floor: 10 }),
			encoding: "utf8",
		});
		assert.equal(r.status, 0, r.stderr);
		return JSON.parse(r.stdout);
	};
	assert.equal(decide(false, 50, 999), false, "under both lines");
	assert.equal(decide(false, 50, 1001), true, "over the cap");
	assert.equal(decide(false, 9.9, 10), true, "under the floor");
	assert.equal(decide(true, 11, 10), true, "still within 2 points of the floor");
	assert.equal(decide(true, 50, 960), true, "still over 95% of the cap");
	assert.equal(decide(true, 12.5, 940), false, "room again");
});

test("the logger names refusals with the same private ranges the exit refuses", () => {
	const nft = readFileSync(join(here, "qorpera-agent-exit.nft"), "utf8");
	const set = /set internal4 \{[\s\S]*?elements = \{([\s\S]*?)\}/.exec(nft)[1];
	const exitRanges = set
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean)
		.map((range) => (range.includes("/") ? range : `${range}/32`))
		.sort();
	const py = readFileSync(logger, "utf8");
	const loggerRanges = [...py.slice(py.indexOf("INTERNAL = ["), py.indexOf("]\n", py.indexOf("INTERNAL = ["))).matchAll(/"([0-9./]+)"/g)]
		.map((m) => m[1])
		.sort();
	assert.deepEqual(loggerRanges, exitRanges);
});

const pythonUsable =
	spawnSync("python3", ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)"]).status === 0;

describe("the agent plug", { skip: pythonUsable ? false : "needs Python 3.11 or later" }, () => {
	let dir;
	let state;
	let run;
	let log;
	let lxd;
	let flushes;
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-plug-"));
		state = join(dir, "state");
		run = join(dir, "run");
		log = join(dir, "log");
		for (const sub of ["clients", "dhcp-hosts", "quarantine", "seen", "verified"]) mkdirSync(join(state, sub), { recursive: true });
		mkdirSync(run);
		lxd = join(dir, "lxd.json");
		flushes = join(dir, "flushes");
		writeFileSync(lxd, "[]");
	});
	after(() => rmSync(dir, { recursive: true, force: true }));
	const dirs = () => ["--state-dir", state, "--run-dir", run, "--log-dir", log];
	// Creators run with UMask=0077; plug must still leave files dnsmasq can read.
	const plug = (...args) =>
		spawnSync("sh", ["-c", 'umask 077; exec python3 "$@"', "sh", plugTool, "plug", ...dirs(), ...args], { encoding: "utf8" });
	const plugged = (...args) => {
		const r = plug(...args);
		assert.equal(r.status, 0, r.stderr);
		return JSON.parse(r.stdout);
	};
	const reconcile = () => {
		const r = spawnSync(
			"python3",
			[plugTool, "reconcile", "--once", ...dirs(), "--lxd-fixture", lxd, "--reload-dns", "true", "--flush-log", flushes],
			{ encoding: "utf8", env: { ...process.env, QORPERA_AGENT_PLUG_NFT: "0" } },
		);
		assert.equal(r.status, 0, r.stderr);
		return JSON.parse(readFileSync(join(run, "plug.json"), "utf8"));
	};
	const entry = (address) => JSON.parse(readFileSync(join(state, "clients", `${address}.json`), "utf8"));
	const has = (sub, name) => existsSync(join(state, sub, name));
	const machine = (e, { status = "Running", company = e.company, nic = {} } = {}) => ({
		name: e.instance,
		project: e.project,
		status,
		expanded_config: {
			"user.qorpera.company_id": company,
			[e.kind === "office" ? "user.qorpera.office_id" : "user.qorpera.machine_id"]: e.machine,
			...(e.member ? { "user.qorpera.member_user_id": e.member } : {}),
		},
		expanded_devices: {
			agent: {
				type: "nic",
				nictype: "bridged",
				parent: "qagent0",
				name: "eth1",
				hwaddr: e.hwaddr,
				"ipv6.address": "none",
				"security.mac_filtering": "true",
				"security.ipv6_filtering": "true",
				"security.port_isolation": "true",
				...nic,
			},
		},
	});
	const lxdHas = (...machines) => writeFileSync(lxd, JSON.stringify(machines));
	const history = () =>
		readdirSync(log)
			.filter((name) => name.startsWith("clients-"))
			.flatMap((name) => readFileSync(join(log, name), "utf8").trim().split("\n"))
			.map((line) => JSON.parse(line));
	const flushed = () => (existsSync(flushes) ? readFileSync(flushes, "utf8").trim().split("\n") : []);
	const vm1 = ["--kind", "coding", "--company", "c1", "--machine", "m1", "--member", "u1", "--project", "qp", "--instance", "vm1"];

	test("plug gives the lowest free address outside the exit's /24, with its MAC and a lease dnsmasq can read", () => {
		const first = plugged(...vm1);
		assert.deepEqual(first, { address: "10.210.1.1", hwaddr: "0e:51:0a:d2:01:01" });
		assert.deepEqual(plugged(...vm1), first, "the same again for the same machine");
		const lease = join(state, "dhcp-hosts", "10.210.1.1");
		assert.equal(readFileSync(lease, "utf8"), "0e:51:0a:d2:01:01,10.210.1.1\n");
		assert.equal(statSync(lease).mode & 0o777, 0o644, "readable by dnsmasq under the creator's umask 077");
		assert.equal(statSync(join(state, "clients", "10.210.1.1.json")).mode & 0o777, 0o644);
		const e = entry("10.210.1.1");
		assert.deepEqual(
			{ ...e, since: undefined },
			{
				schema: "qorpera.agent-plug/v1",
				address: "10.210.1.1",
				hwaddr: "0e:51:0a:d2:01:01",
				kind: "coding",
				company: "c1",
				machine: "m1",
				member: "u1",
				project: "qp",
				instance: "vm1",
				since: undefined,
			},
		);
		assert.match(e.since, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
		const other = plug("--kind", "machine", "--company", "c2", "--machine", "m2", "--project", "qp", "--instance", "vm1");
		assert.equal(other.status, 1);
		assert.match(other.stderr, /qp\/vm1 is already plugged in for another machine \(10\.210\.1\.1\)/);
		assert.deepEqual(readdirSync(join(state, "dhcp-hosts")), ["10.210.1.1"], "no temporary file left behind");
	});

	test("plug refuses unknown kinds, a member on anything but a coding machine, and names that are not ids", () => {
		for (const [args, message] of [
			[["--kind", "laptop", "--company", "c", "--machine", "m", "--project", "qp", "--instance", "x"], /kind must be/],
			[["--kind", "coding", "--company", "c", "--machine", "m", "--project", "qp", "--instance", "x"], /names its member/],
			[["--kind", "machine", "--company", "c", "--machine", "m", "--member", "u", "--project", "qp", "--instance", "x"], /names its member/],
			[["--kind", "machine", "--company", "c/1", "--machine", "m", "--project", "qp", "--instance", "x"], /company is not an id/],
			[["--kind", "machine", "--company", "c", "--machine", "m", "--project", "qp", "--instance", "a_b"], /instance is not an LXD name/],
		]) {
			const r = plug(...args);
			assert.notEqual(r.status, 0, args.join(" "));
			assert.match(r.stderr, message);
		}
	});

	test("plugs at once never share an address, and a quarantined address is skipped until it expires", async () => {
		const results = await Promise.all(
			Array.from(
				{ length: 12 },
				(_, i) =>
					new Promise((resolve) => {
						const child = spawn("python3", [
							plugTool,
							"plug",
							...dirs(),
							...["--kind", "machine", "--company", "c", "--machine", `race${i}`, "--project", "qp", "--instance", `race${i}`],
						]);
						let out = "";
						child.stdout.on("data", (chunk) => {
							out += chunk;
						});
						child.on("close", (code) => resolve({ code, out }));
					}),
			),
		);
		assert.ok(results.every((r) => r.code === 0));
		assert.equal(new Set(results.map((r) => JSON.parse(r.out).address)).size, 12);
		const until = (seconds) => JSON.stringify({ until: Date.now() / 1000 + seconds });
		writeFileSync(join(state, "quarantine", "10.210.1.14"), until(900));
		writeFileSync(join(state, "quarantine", "10.210.1.15"), until(-1));
		const office = ["--kind", "office", "--company", "c3", "--machine", "o3", "--project", "qp", "--instance", "vm3"];
		assert.equal(plugged(...office).address, "10.210.1.15");
	});

	test("an entry is attributed only once LXD backs it; a forged one is a problem and a mismatch line, never plugged", () => {
		const e = entry("10.210.1.1");
		const office = entry("10.210.1.15");
		// vm1's entry says company c1, LXD says c9: a forged (or wrong) claim.
		lxdHas(
			machine(e, { company: "c9" }),
			machine(office, { nic: { "security.ipv4_filtering": "true" } }),
			{ name: "stray", project: "qp", status: "Stopped", expanded_config: {}, expanded_devices: { eth0: { type: "nic", parent: "qagent0", hwaddr: "0e:51:0a:d2:09:09" } } },
			{ name: "other", project: "qp", status: "Running", expanded_config: {}, expanded_devices: { eth0: { type: "nic", network: "qorpera0" } } },
		);
		const status = reconcile();
		assert.deepEqual(
			status.problems.filter((p) => !p.includes("is running, but its network card")),
			[
				"qp/stray is on qagent0 without a client map entry",
				"qp/vm1 (10.210.1.1): user.qorpera.company_id is 'c9', not 'c1'",
				"qp/vm3 (10.210.1.15): its card has LXD's IPv4 filter on, which drops its DHCP requests",
			],
		);
		assert.equal(status.problems.filter((p) => p.includes("is not a port of qagent0")).length, 2, "running, no such port");
		reconcile();
		const lines = history();
		assert.deepEqual(
			lines.map((r) => [r.event, r.address ?? r.instance]),
			[
				["unattributed", "stray"],
				["mismatch", "10.210.1.1"],
				["mismatch", "10.210.1.15"],
			],
			"each finding once, nothing plugged",
		);
		const forged = lines.find((r) => r.event === "mismatch" && r.address === "10.210.1.1");
		assert.equal(forged.company, "c1");
		assert.equal(forged.lxd["user.qorpera.company_id"], "c9");
		assert.deepEqual(lines[0].cards, [{ hwaddr: "0e:51:0a:d2:09:09", "ipv4.address": null }]);
		assert.ok(!has("verified", "10.210.1.1"));
	});

	test("a sleeping machine keeps its address and is flushed once; a machine missing twice is quarantined, then unplugged", () => {
		const e = entry("10.210.1.1");
		const office = entry("10.210.1.15");
		lxdHas(machine(e, { status: "Stopped" }), machine(office, { status: "Stopped" }));
		assert.deepEqual(reconcile().problems, []);
		reconcile();
		assert.deepEqual(flushed().sort(), ["10.210.1.1", "10.210.1.15"], "flushed once per sleep");
		const plugs = history().filter((r) => r.event === "plugged");
		assert.deepEqual(plugs.map((r) => r.address).sort(), ["10.210.1.1", "10.210.1.15"], "attributed once it matches");
		assert.equal(plugs.find((r) => r.address === "10.210.1.1").ts, Date.parse(e.since) / 1000, "from the entry's time");
		lxdHas(machine(office, { status: "Stopped" }));
		reconcile();
		assert.ok(has("clients", "10.210.1.1.json"), "one read without the machine unplugs nothing");
		reconcile();
		assert.ok(!has("clients", "10.210.1.1.json"));
		assert.ok(!has("dhcp-hosts", "10.210.1.1"));
		assert.ok(!has("seen", "10.210.1.1"));
		const quarantine = JSON.parse(readFileSync(join(state, "quarantine", "10.210.1.1"), "utf8"));
		assert.equal(quarantine.reason, "the machine is gone");
		assert.ok(quarantine.until > Date.now() / 1000 + 890);
		assert.equal(flushed().filter((a) => a === "10.210.1.1").length, 2, "flushed again when unplugged");
		const gone = history().filter((r) => r.address === "10.210.1.1");
		assert.deepEqual(gone.map((r) => r.event), ["mismatch", "plugged", "unplugged"]);
		assert.notEqual(plugged(...vm1).address, "10.210.1.1", "a quarantined address is not given out again");
	});

	test("a machine made again gets its entry back with a new time and is not unplugged in between", () => {
		const office = entry("10.210.1.15");
		lxdHas(machine(office));
		reconcile();
		const office3 = ["--kind", "office", "--company", "c3", "--machine", "o3", "--project", "qp", "--instance", "vm3"];
		// The creator deletes vm3 and plugs it again before it makes it again.
		lxdHas();
		const again = plugged(...office3);
		assert.equal(again.address, "10.210.1.15");
		assert.notEqual(entry("10.210.1.15").since, office.since);
		reconcile();
		reconcile();
		assert.ok(has("clients", "10.210.1.15.json"), "the new machine's entry stays while it is being made");
		lxdHas(machine(entry("10.210.1.15")));
		assert.deepEqual(reconcile().problems.filter((p) => !p.includes("is not a port")), []);
		assert.equal(JSON.parse(readFileSync(join(state, "seen", "10.210.1.15"), "utf8")).since, entry("10.210.1.15").since);
	});

	test("an entry removed by hand is unplugged from the reconciler's copy; its address stays held until then", () => {
		lxdHas(machine(entry("10.210.1.15")));
		reconcile();
		rmSync(join(state, "clients", "10.210.1.15.json"));
		const held = plugged("--kind", "machine", "--company", "c4", "--machine", "m4", "--project", "qp", "--instance", "vm4");
		assert.notEqual(held.address, "10.210.1.15", "a seen address is never given to another machine");
		reconcile();
		assert.ok(!has("seen", "10.210.1.15"));
		assert.ok(has("quarantine", "10.210.1.15"));
		const last = history().filter((r) => r.address === "10.210.1.15").at(-1);
		assert.equal(last.event, "unplugged");
		assert.equal(last.reason, "its entry was removed by hand");
	});

	test("a plug repeated for a machine never seen gives it a new hour: a create retried late is not dropped", () => {
		lxdHas();
		const late = ["--kind", "machine", "--company", "c9", "--machine", "m9", "--project", "qp", "--instance", "late"];
		const first = plugged(...late);
		const path = join(state, "clients", `${first.address}.json`);
		writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), since: "2000-01-01T00:00:00Z" }));
		assert.deepEqual(plugged(...late), first, "the same address and MAC");
		assert.ok(Date.now() / 1000 - Date.parse(entry(first.address).since) / 1000 < 60, "a new time");
		reconcile();
		assert.ok(existsSync(path), "not given up: its hour starts again");
	});

	test("a plug whose machine never appears is given up after an hour as dropped; expired quarantines are cleared", () => {
		lxdHas();
		const pending = readdirSync(join(state, "clients")).filter((n) => n.endsWith(".json"));
		assert.ok(pending.length > 0);
		reconcile();
		assert.equal(readdirSync(join(state, "clients")).filter((n) => n.endsWith(".json")).length, pending.length, "not yet an hour");
		for (const name of pending) {
			const path = join(state, "clients", name);
			writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), since: "2000-01-01T00:00:00Z" }));
		}
		writeFileSync(join(state, "quarantine", "10.210.1.200"), JSON.stringify({ until: 1 }));
		reconcile();
		assert.deepEqual(readdirSync(join(state, "clients")).filter((n) => n.endsWith(".json")), []);
		assert.ok(!has("quarantine", "10.210.1.200"));
		const lines = history().filter((r) => pending.includes(`${r.address}.json`) && r.event !== "mismatch");
		assert.ok(lines.length >= pending.length);
		for (const name of pending) {
			const mine = lines.filter((r) => `${r.address}.json` === name);
			assert.equal(mine.at(-1).event, "dropped", `${name}: never matched, never attributed`);
			assert.equal(mine.at(-1).reason, "the machine was never created");
		}
	});

	test("unusable entries and links are problems, never followed; LXD unreadable changes nothing", () => {
		const forgedKind = { schema: "qorpera.agent-plug/v1", address: "10.210.1.99", hwaddr: "0e:51:0a:d2:01:63" };
		writeFileSync(join(state, "clients", "10.210.1.99.json"), JSON.stringify({ ...forgedKind, kind: "laptop" }));
		writeFileSync(join(state, "clients", "10.210.1.98.json"), JSON.stringify({ ...forgedKind, address: "10.210.1.98" }));
		writeFileSync(join(state, "clients", "10.210.0.7.json"), "{}");
		const later = { ...forgedKind, address: "10.210.1.96", hwaddr: "0e:51:0a:d2:01:60", kind: "machine" };
		writeFileSync(join(state, "clients", "10.210.1.96.json"), JSON.stringify({ ...later, company: "c", machine: "m", project: "qp", instance: "x", since: "2100-01-01T00:00:00Z" }));
		writeFileSync(join(state, "clients", "10.210.1.255.json"), JSON.stringify({ ...forgedKind, address: "10.210.1.255", hwaddr: "0e:51:0a:d2:01:ff" }));
		writeFileSync(join(state, "clients", "10.210.1.95.json"), `${"[".repeat(30000)}${"]".repeat(30000)}`);
		symlinkSync("/etc/passwd", join(state, "clients", "10.210.1.97.json"));
		symlinkSync("/etc/passwd", join(state, "dhcp-hosts", "10.210.1.97"));
		writeFileSync(lxd, "not json");
		const before = readdirSync(join(state, "clients")).sort();
		const status = reconcile();
		assert.match(status.problems[0], /^cannot read LXD/);
		assert.deepEqual(readdirSync(join(state, "clients")).sort(), before);
		lxdHas();
		const problems = reconcile().problems.join("\n");
		assert.match(problems, /unreadable client map entry 10\.210\.1\.99\.json: unknown kind/);
		assert.match(problems, /unreadable client map entry 10\.210\.1\.98\.json: the MAC is not the address's/);
		assert.match(problems, /unreadable client map entry 10\.210\.0\.7\.json: unknown schema/);
		assert.match(problems, /unreadable client map entry 10\.210\.1\.97\.json: .*(Too many levels|symbolic link)/i);
		assert.match(problems, /unreadable client map entry 10\.210\.1\.96\.json: since is in the future/);
		assert.match(problems, /unreadable client map entry 10\.210\.1\.255\.json: the address is a \.0 or \.255 host/);
		assert.match(problems, /unreadable client map entry 10\.210\.1\.95\.json:/, "a deep nesting is a problem, not a crash");
		for (const name of ["10.210.1.99.json", "10.210.1.98.json", "10.210.0.7.json", "10.210.1.97.json", "10.210.1.96.json", "10.210.1.255.json", "10.210.1.95.json"]) {
			rmSync(join(state, "clients", name));
		}
		rmSync(join(state, "dhcp-hosts", "10.210.1.97"));
	});

	test("the bridge rules hold only entries LXD backed: the pairs, and one DHCP rule per machine naming its own MAC", () => {
		const fresh = plugged("--kind", "machine", "--company", "c5", "--machine", "m5", "--project", "qp", "--instance", "vm5");
		const statements = () => {
			const r = spawnSync("python3", [plugTool, "elements", ...dirs()], { encoding: "utf8" });
			assert.equal(r.status, 0, r.stderr);
			return r.stdout.trim().split("\n").filter(Boolean);
		};
		assert.deepEqual(statements(), [], "a plug LXD has not backed yet gets nothing");
		lxdHas(machine(entry(fresh.address)));
		reconcile();
		const hex = fresh.hwaddr.replaceAll(":", "");
		assert.deepEqual(statements(), [
			`add element bridge qorpera_agent_exit_bridge clients { ${fresh.hwaddr} . ${fresh.address} }`,
			`insert rule bridge qorpera_agent_exit_bridge dhcp ether saddr ${fresh.hwaddr} ip saddr { 0.0.0.0, ${fresh.address} } @th,256,32 0 @th,288,48 0x${hex} accept comment "${fresh.address}"`,
		]);
	});

	test("ports: a machine's own while LXD has its card (not stopped), never the exit's links; a missed read keeps it once", () => {
		const script = String.raw`
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("plug", sys.argv[1])
plug = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plug)
root = sys.argv[2]
paths = plug.Paths(os.path.join(root, "state"), os.path.join(root, "run"), os.path.join(root, "log"))
for d in (paths.clients, paths.dhcp, *paths.root_dirs()):
    os.makedirs(d, exist_ok=True)
def card(port, status="Running", **nic):
    device = dict(plug.PLUG_NIC, hwaddr="0e:51:0a:d2:02:01", **nic)
    config = {"user.qorpera.company_id": "c", "user.qorpera.machine_id": "m", "volatile.eth0.host_name": port}
    return {"name": "m", "project": "qp", "status": status, "expanded_config": config, "expanded_devices": {"eth0": device}}
out = {"statuses": {s: plug.host_port(card("tap1a2b", s)) for s in ("Running", "Ready", "Frozen", "Error", "Stopped")},
       "names": {n: plug.host_port(card(n)) for n in ("qx-br", "qx-up", "qagent0", "bad name!", "veth9f8e7d6c")}}
entry = {"schema": "qorpera.agent-plug/v1", "address": "10.210.2.1", "hwaddr": "0e:51:0a:d2:02:01", "kind": "machine",
         "company": "c", "machine": "m", "member": None, "project": "qp", "instance": "m", "since": "2026-10-03T00:00:00Z"}
entries = {"10.210.2.1": entry}
loaded = {("tapold", "0e:51:0a:d2:02:01")}
open(os.path.join(paths.verified, "10.210.2.1"), "w").write("x")
out["running"] = sorted(plug.backed(paths, entries, [card("tapnew")], loaded)[1])
out["mismatch"] = sorted(plug.backed(paths, entries, [card("tapnew", **{"security.port_isolation": "false"})], loaded)[0])
out["absent"] = sorted(plug.backed(paths, entries, [], loaded)[1])
open(os.path.join(paths.missing, "10.210.2.1"), "w").write("x")
open(os.path.join(paths.seen, "10.210.2.1"), "w").write(json.dumps(entry))
out["first_miss"] = sorted(plug.backed(paths, entries, [], loaded)[1])
open(os.path.join(paths.seen, "10.210.2.1"), "w").write(json.dumps(dict(entry, since="2026-10-02T00:00:00Z")))
out["made_again"] = sorted(plug.backed(paths, entries, [], loaded)[1])
print(json.dumps(out))
`;
		const root = mkdtempSync(join(tmpdir(), "agent-plug-ports-"));
		const r = spawnSync("python3", ["-c", script, plugTool, root], { encoding: "utf8" });
		rmSync(root, { recursive: true, force: true });
		assert.equal(r.status, 0, r.stderr);
		const out = JSON.parse(r.stdout);
		assert.deepEqual(out.statuses, { Running: "tap1a2b", Ready: "tap1a2b", Frozen: "tap1a2b", Error: "tap1a2b", Stopped: null });
		assert.deepEqual(out.names, { "qx-br": null, "qx-up": null, qagent0: null, "bad name!": null, veth9f8e7d6c: "veth9f8e7d6c" });
		assert.deepEqual(out.running, [["tapnew", "0e:51:0a:d2:02:01"]], "a running machine's own port, never the loaded one");
		assert.deepEqual(out.mismatch, [], "a machine LXD no longer backs gets nothing");
		assert.deepEqual(out.absent, [], "missing, and not yet once: no port");
		assert.deepEqual(out.first_miss, [["tapold", "0e:51:0a:d2:02:01"]], "the first missed read keeps the loaded port");
		assert.deepEqual(out.made_again, [], "a machine being made again does not keep the old one's port");
	});

	test("a stale temporary folder in a creators' folder is a problem, never a crash", () => {
		const folder = join(state, "clients", ".tmp-left");
		mkdirSync(folder);
		const old = new Date(Date.now() - 3600_000);
		utimesSync(folder, old, old);
		lxdHas();
		assert.ok(reconcile().problems.some((p) => p.includes("clients/.tmp-left is a folder")));
		rmSync(folder, { recursive: true });
	});

	test("conntrack lines from the exit become the node's twins: masqueraded TCP, UDP and ICMP only", () => {
		const lines = [
			"tcp      6 431999 ESTABLISHED src=10.210.1.2 dst=1.1.1.1 sport=40000 dport=443 src=1.1.1.1 dst=10.209.255.2 sport=443 dport=61000 [ASSURED] mark=0 use=1",
			"udp      17 25 src=10.210.1.2 dst=9.9.9.9 sport=5353 dport=53 src=10.210.0.1 dst=10.210.1.2 sport=53 dport=5353 mark=0 use=1",
			"udp      17 25 src=10.210.1.2 dst=8.8.4.4 sport=5000 dport=3478 src=8.8.4.4 dst=10.209.255.2 sport=3478 dport=5001 mark=0 use=1",
			"icmp     1 29 src=10.210.1.2 dst=1.1.1.1 type=8 code=0 id=7 src=1.1.1.1 dst=10.209.255.2 type=0 code=0 id=9 mark=0 use=1",
			"unknown  253 599 src=10.210.1.2 dst=1.1.1.1 src=1.1.1.1 dst=10.209.255.2 mark=0 use=1",
		].join("\n");
		const r = spawnSync("python3", [plugTool, "--parse-conntrack"], { input: lines, encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(
			r.stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
			[
				["tcp", "1.1.1.1", "443", "61000"],
				["udp", "8.8.4.4", "3478", "5001"],
				["icmp", "1.1.1.1", null, "9"],
			],
		);
	});
});

describe("the logs on the node", { skip: pythonUsable ? false : "needs Python 3.11 or later" }, () => {
	const DAY = 86400;
	const day = "2026-09-01";
	const t0 = Date.UTC(2026, 8, 1) / 1000;
	const next = "2026-09-02";
	const third = "2026-09-03";
	let dir;
	let log;
	let status;
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-exit-logs-"));
		log = join(dir, "log");
		status = join(dir, "logs.json");
		mkdirSync(log);
	});
	after(() => rmSync(dir, { recursive: true, force: true }));
	const lines = (records) => `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
	const append = (name, records, raw = "") => writeFileSync(join(log, name), lines(records) + raw, { flag: "a" });
	const files = () => readdirSync(log).sort();
	// The disk's free share is set (50%) so the result never depends on the machine running the test.
	const tend = (now, ...extra) => {
		const r = spawnSync(
			"python3",
			[logsTool, "tend", "--log-dir", log, "--status", status, "--now", String(now), "--settle", "0", "--free-percent", "50", ...extra],
			{ encoding: "utf8" },
		);
		return { status: r.status, result: r.stdout ? JSON.parse(r.stdout) : null, stderr: r.stderr };
	};
	const counts = (d) => JSON.parse(readFileSync(join(log, `counts-${d}.json`), "utf8"));
	const machine = (address, company, machineId, ts, event = "plugged") => ({ event, address, company, machine: machineId, kind: "machine", ts });
	const opened = (src, ts, proto = "tcp") => ({ event: "new", src, dst: "1.1.1.1", proto, sport: 40000, dport: 443, ts });

	test("a day is sealed, compressed and counted only once it is closed, two hours after it ends", () => {
		append(`clients-${day}.jsonl`, [
			machine("10.210.1.1", "cA", "mA", t0 + 100),
			machine("10.210.1.2", "cB", "mB", t0 + 200),
			machine("10.210.1.9", "cZ", "mZ", t0 + 300, "dropped"),
			machine("10.210.1.2", "cB", "mB", t0 + 5000, "unplugged"),
			{ ...machine("10.210.1.2", "cC", "mC", t0 + 6000), kind: "coding", member: "u1" },
		]);
		append(
			`flows-${day}.jsonl`,
			[
				{ event: "gap", reason: "logger started", ts: t0 + 50 },
				opened("10.210.1.1", t0 + 150),
				// A burst: twelve new connections in one 10-second step.
				...Array.from({ length: 12 }, (_, i) => opened("10.210.1.1", t0 + 1000 + i / 2)),
				opened("10.210.1.2", t0 + 300, "udp"),
				opened("10.210.1.2", t0 + 7000),
				opened("10.210.1.7", t0 + 400, "icmp"),
				// Unanswered connections to five addresses and a refusal, in one minute: six failed destinations.
				...Array.from({ length: 5 }, (_, i) => ({ event: "destroy", src: "10.210.1.1", dst: `203.0.113.${i}`, proto: "tcp", packets_out: 1, bytes_out: 60, packets_in: 0, bytes_in: 0, ts: t0 + 1985 + i })),
				{ event: "destroy", src: "10.210.1.1", dst: "1.1.1.1", proto: "tcp", packets_out: 5, bytes_out: 500, packets_in: 4, bytes_in: 900, ts: t0 + 1989 },
				{ event: "refused", src: "10.210.1.1", dst: "192.168.1.40", proto: "tcp", dport: 2049, rule: "our_networks", ts: t0 + 1990 },
			],
			"not json\n",
		);
		writeFileSync(join(log, "dns.log"), "line1\n");
		const early = tend(t0 + DAY + 3600);
		assert.equal(early.status, 0, early.stderr);
		assert.deepEqual(early.result.problems, []);
		assert.equal(early.result.sealed, 0, "not closed an hour after the day ends");
		assert.ok(files().includes(`flows-${day}.jsonl`) && !files().includes(`counts-${day}.json`));
		assert.equal(readFileSync(join(log, "dns.log"), "utf8"), "line1\n", "the first pass only notes the day");
		const closed = tend(t0 + DAY + 3 * 3600);
		assert.equal(closed.status, 0, closed.stderr);
		assert.equal(closed.result.sealed, 2);
		assert.equal(closed.result.daysCounted, 1);
		assert.ok(!files().includes(`flows-${day}.jsonl`) && !files().includes(`clients-${day}.jsonl`));
		const part = gunzipSync(readFileSync(join(log, `flows-${day}.p001.jsonl.gz`))).toString("utf8");
		assert.equal(part.split("\n").filter(Boolean).length, 25, "every line, the unreadable one too");
		assert.equal(statSync(join(log, `flows-${day}.p001.jsonl.gz`)).mode & 0o777, 0o640);
		const c = counts(day);
		assert.deepEqual(c.companies.cA, {
			machines: 1,
			connections: 13,
			byProto: { tcp: 13 },
			peakNew10s: 12,
			peakNew10sAt: "2026-09-01T00:16:40Z",
			peakNew10sOneMachine: 12,
			refused: 1,
			refusedByRule: { our_networks: 1 },
			unanswered: 5,
			failedDestinations: 6,
			failedDestinationsAtLeast: false,
			peakFailedDestinations60s: 6,
			peakFailedDestinations60sAt: "2026-09-01T00:33:00Z",
		});
		// The address goes from cB to cC the moment it is plugged in again; one never matched (dropped) has no company.
		assert.equal(c.companies.cB.connections, 1);
		assert.equal(c.companies.cC.connections, 1);
		assert.equal(c.companies.unattributed.connections, 1);
		assert.equal(c.companies.unattributed.machines, 0);
		assert.equal(c.companies.cZ, undefined);
		assert.deepEqual(c.node, { records: 24, gaps: 1, gapReasons: { "logger started": 1 }, unreadableLines: 1 });
		assert.deepEqual(c.parts, [`clients-${day}.p001.jsonl.gz`, `flows-${day}.p001.jsonl.gz`]);
		assert.deepEqual(c.late, []);
		assert.equal(c.pluggedInAtEnd["10.210.1.2"].company, "cC");
		const carried = JSON.parse(readFileSync(join(log, "attribution.json"), "utf8"));
		assert.equal(carried.through, day);
		assert.deepEqual(Object.keys(carried.open).sort(), ["10.210.1.1", "10.210.1.2"]);
		assert.equal(carried.open["10.210.1.2"].company, "cC");
	});

	test("a machine plugged in on an earlier day keeps its company, and dns.log is cut once a day", () => {
		append(`flows-${next}.jsonl`, [opened("10.210.1.1", t0 + DAY + 10)]);
		const r = tend(t0 + 2 * DAY + 3 * 3600);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(r.result.daysCounted, 1);
		assert.equal(counts(next).companies.cA.connections, 1, "its plugged line is a day back, in a sealed part");
		assert.equal(r.result.dnsRotated, true);
		assert.equal(readFileSync(join(log, "dns.log"), "utf8"), "");
		const rotated = files().filter((name) => /^dns-2026-09-03T030000Z\.log\.gz$/.test(name));
		assert.equal(rotated.length, 1, files().join(" "));
		assert.equal(gunzipSync(readFileSync(join(log, rotated[0]))).toString("utf8"), "line1\n");
	});

	test("an open file is sealed in parts once it holds a part's size, and a day's count reads every part", () => {
		append(`flows-${third}.jsonl`, [opened("10.210.1.1", t0 + 2 * DAY + 10), opened("10.210.1.1", t0 + 2 * DAY + 20)]);
		assert.equal(tend(t0 + 2 * DAY + 3600 * 5, "--part-bytes", "10").result.sealed, 1);
		append(`flows-${third}.jsonl`, [opened("10.210.1.1", t0 + 2 * DAY + 30)]);
		assert.equal(tend(t0 + 2 * DAY + 3600 * 6, "--part-bytes", "10").result.sealed, 1);
		append(`flows-${third}.jsonl`, [opened("10.210.1.1", t0 + 2 * DAY + 40)]);
		assert.ok(files().includes(`flows-${third}.p001.jsonl.gz`) && files().includes(`flows-${third}.p002.jsonl.gz`));
		const r = spawnSync("python3", [logsTool, "count", "--log-dir", log, "--day", third], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		const today = JSON.parse(r.stdout);
		assert.equal(today.companies.cA.connections, 4, "both parts and the open file");
		assert.equal(today.attributionPartial, false);
		// A late line for a counted day (the reconciler was down: its "plugged" line is days back) becomes that day's
		// next part; the counted day never changes.
		const counted = readFileSync(join(log, `counts-${day}.json`), "utf8");
		append(`clients-${day}.jsonl`, [machine("10.210.1.7", "cE", "mE", t0 + 350)]);
		const again = tend(t0 + 2 * DAY + 3600 * 7);
		assert.equal(again.status, 0, again.stderr);
		assert.ok(files().includes(`clients-${day}.p002.jsonl.gz`), files().join(" "));
		assert.equal(again.result.daysCounted, 0, "no day closed since");
		assert.equal(readFileSync(join(log, `counts-${day}.json`), "utf8"), counted);
	});

	test("the report adds the days up per company", () => {
		const r = spawnSync("python3", [logsTool, "report", "--log-dir", log, "--json"], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		const report = JSON.parse(r.stdout);
		assert.equal(report.node.days, 2);
		assert.deepEqual(
			{ days: report.companies.cA.days, connections: report.companies.cA.connections, peak: report.companies.cA.peakNew10s },
			{ days: 2, connections: 14, peak: 12 },
		);
		const text = spawnSync("python3", [logsTool, "report", "--log-dir", log], { encoding: "utf8" });
		assert.equal(text.status, 0, text.stderr);
		assert.match(text.stdout, /^cA\s+2\s+14\s+13\s+1\s+12\s+12\s+1\s+5\s+6$/m);
	});

	test("over the cap the oldest counted parts go first, the client history last; never an uncounted part", () => {
		append(`flows-${third}.jsonl`, [opened("10.210.1.1", t0 + 2 * DAY + 50)]);
		const r = tend(t0 + 2 * DAY + 3600 * 9, "--cap-bytes", "1");
		assert.equal(r.status, 1, "still over a 1-byte cap: a problem");
		assert.match(r.result.problems[0], /over their cap, or the disk under its floor/);
		const lost = lostRecords(log);
		const order = lost.map((entry) => entry.file);
		assert.deepEqual(order, [
			`flows-${day}.p001.jsonl.gz`,
			`flows-${next}.p001.jsonl.gz`,
			"dns-2026-09-03T030000Z.log.gz",
			`clients-${day}.p001.jsonl.gz`,
		]);
		assert.ok(lost.every((entry) => entry.reason === "over the cap" && entry.bytes > 0));
		assert.equal(lost.find((entry) => entry.file === `flows-${day}.p001.jsonl.gz`).day, day);
		// The third day is not counted yet, and the late part for the first day is counted nowhere yet: both stay.
		for (const kept of [`flows-${third}.p001.jsonl.gz`, `flows-${third}.p002.jsonl.gz`, `clients-${day}.p002.jsonl.gz`,
			`counts-${day}.json`, `counts-${next}.json`, `flows-${third}.jsonl`, "attribution.json", "dns.log"])
			assert.ok(files().includes(kept), kept);
		assert.equal(JSON.parse(readFileSync(status, "utf8")).problems.length, 1);
		// The report says how many files went before their time, from the ledger as it is now.
		const report = JSON.parse(spawnSync("python3", [logsTool, "report", "--log-dir", log, "--json"], { encoding: "utf8" }).stdout);
		assert.equal(report.node.deletedEarly, 3, "the DNS part's day is the third, not counted yet");
	});

	test("a late part is counted with the next day counted, under its own day; the day it belongs to never changes", () => {
		const first = readFileSync(join(log, `counts-${day}.json`), "utf8");
		const second = readFileSync(join(log, `counts-${next}.json`), "utf8");
		// A late connection line for the second day, from the address the late plug (first day) gives to cE.
		append(`flows-${next}.jsonl`, [opened("10.210.1.7", t0 + DAY + 500), { event: "gap", reason: "logger started", ts: t0 + DAY + 501 }]);
		const r = tend(t0 + 3 * DAY + 3 * 3600);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(r.result.daysCounted, 1);
		assert.equal(readFileSync(join(log, `counts-${day}.json`), "utf8"), first);
		assert.equal(readFileSync(join(log, `counts-${next}.json`), "utf8"), second);
		const c = counts(third);
		assert.deepEqual(c.parts, [`flows-${third}.p001.jsonl.gz`, `flows-${third}.p002.jsonl.gz`, `flows-${third}.p003.jsonl.gz`]);
		assert.equal(c.companies.cA.connections, 5);
		assert.deepEqual(
			c.late.map((late) => [late.day, late.parts, late.companies.cE?.connections ?? 0]),
			[
				[day, [`clients-${day}.p002.jsonl.gz`], 0],
				[next, [`flows-${next}.p002.jsonl.gz`], 1],
			],
		);
		assert.equal(c.pluggedInAtEnd["10.210.1.7"].company, "cE");
		const report = JSON.parse(spawnSync("python3", [logsTool, "report", "--log-dir", log, "--json"], { encoding: "utf8" }).stdout);
		assert.deepEqual([report.companies.cE.connections, report.companies.cE.days], [1, 0], "the report adds the late numbers");
		assert.equal(report.node.gaps, 2, "and the late part's gap lines");
		assert.equal(tend(t0 + 3 * DAY + 4 * 3600).result.daysCounted, 0, "counted once");
	});

	test("the counts file is the one commit point: a pass cut short after it never counts a day twice", () => {
		const cut = mkdtempSync(join(dir, "cut-"));
		const second = t0 + DAY;
		writeFileSync(join(cut, `clients-${day}.jsonl`), lines([machine("10.210.1.1", "cA", "mA", t0 + 100)]));
		writeFileSync(join(cut, `flows-${day}.jsonl`), lines([opened("10.210.1.1", t0 + 200)]));
		writeFileSync(
			join(cut, `clients-${next}.jsonl`),
			lines([machine("10.210.1.1", "cA", "mA", second + 100, "unplugged"), machine("10.210.1.1", "cB", "mB", second + 200)]),
		);
		writeFileSync(join(cut, `flows-${next}.jsonl`), lines([opened("10.210.1.1", second + 300)]));
		const run = (now, ...extra) =>
			spawnSync("python3", [logsTool, "tend", "--log-dir", cut, "--status", join(cut, "s.json"), "--now", String(now), "--settle", "0", "--free-percent", "50", ...extra], { encoding: "utf8" });
		// attribution.json cannot be written: the counts files are.
		mkdirSync(join(cut, ".attribution.json.tmp"));
		const r = run(t0 + 2 * DAY + 3 * 3600);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(JSON.parse(r.stdout).daysCounted, 2);
		assert.ok(!readdirSync(cut).includes("attribution.json"));
		const both = [day, next].map((d) => readFileSync(join(cut, `counts-${d}.json`), "utf8"));
		rmSync(join(cut, ".attribution.json.tmp"), { recursive: true });
		assert.equal(JSON.parse(run(t0 + 2 * DAY + 4 * 3600).stdout).daysCounted, 0, "never counted twice");
		assert.deepEqual([day, next].map((d) => readFileSync(join(cut, `counts-${d}.json`), "utf8")), both);
		// The next day starts from the newest counts file: 10.210.1.1 is cB's.
		writeFileSync(join(cut, `flows-${third}.jsonl`), lines([opened("10.210.1.1", t0 + 2 * DAY + 300)]));
		assert.equal(JSON.parse(run(t0 + 3 * DAY + 3 * 3600).stdout).daysCounted, 1);
		assert.equal(JSON.parse(readFileSync(join(cut, `counts-${third}.json`), "utf8")).companies.cB.connections, 1);
		assert.equal(JSON.parse(readFileSync(join(cut, "attribution.json"), "utf8")).through, third);
	});

	test("a closed day that cannot be counted is a problem, and its parts stay, past 90 days and over the cap", () => {
		const stuck = mkdtempSync(join(dir, "stuck-"));
		writeFileSync(join(stuck, `clients-${day}.jsonl`), lines([machine("10.210.1.1", "cA", "mA", t0 + 100)]));
		writeFileSync(join(stuck, `flows-${day}.jsonl`), lines([opened("10.210.1.1", t0 + 200)]));
		writeFileSync(join(stuck, `flows-${next}.jsonl`), lines([opened("10.210.1.1", t0 + DAY + 200)]));
		const run = (...extra) =>
			spawnSync("python3", [logsTool, "tend", "--log-dir", stuck, "--status", join(stuck, "s.json"), "--now", String(t0 + 100 * DAY), "--settle", "0", "--free-percent", "50", ...extra], { encoding: "utf8" });
		// The second day's connection log cannot be sealed (compressing it fails), and the checkpoint's copy cannot be
		// written either.
		mkdirSync(join(stuck, `.flows-${next}.p001.jsonl.gz.tmp`));
		mkdirSync(join(stuck, ".attribution.json.tmp"));
		const failed = run("--cap-bytes", "1");
		assert.equal(failed.status, 1);
		const problems = JSON.parse(failed.stdout).problems.join(" | ");
		assert.match(problems, /sealed: /);
		assert.match(problems, new RegExp(`${next} is closed but not counted: flows-${next}\\.p001\\.sealing not sealed`));
		assert.equal(JSON.parse(failed.stdout).daysCounted, 1, "the first day, which could be sealed");
		// The first day's parts are counted, so they go (past 90 days); the second day's stay, whatever the cap.
		const left = readdirSync(stuck);
		assert.ok(!left.includes(`flows-${day}.p001.jsonl.gz`) && left.includes(`flows-${next}.p001.sealing`), left.join(" "));
		// The first day's counts are the newest, the checkpoint (its copy cannot be written): they stay past 90 days.
		assert.ok(left.includes(`counts-${day}.json`) && !left.includes("attribution.json"), left.join(" "));
		rmSync(join(stuck, `.flows-${next}.p001.jsonl.gz.tmp`), { recursive: true });
		rmSync(join(stuck, ".attribution.json.tmp"), { recursive: true });
		const recovered = run();
		assert.equal(recovered.status, 0, recovered.stderr);
		assert.ok(!readdirSync(stuck).some((name) => name.startsWith("flows-") || name.startsWith("clients-")), "counted, then past 90 days");
		assert.equal(JSON.parse(readFileSync(join(stuck, "attribution.json"), "utf8")).open["10.210.1.1"].company, "cA");
		assert.ok(!readdirSync(stuck).includes(`counts-${day}.json`), "gone once newer counts came and its parts went");
	});

	test("expiry takes the parts before the counts that name them, so a pass cut short never counts a part twice", () => {
		const expiring = mkdtempSync(join(dir, "expiring-"));
		writeFileSync(join(expiring, `clients-${day}.jsonl`), lines([machine("10.210.1.1", "cA", "mA", t0 + 100)]));
		writeFileSync(join(expiring, `flows-${day}.jsonl`), lines([opened("10.210.1.1", t0 + 200)]));
		writeFileSync(join(expiring, `flows-${next}.jsonl`), lines([opened("10.210.1.1", t0 + DAY + 200)]));
		const run = (now) =>
			spawnSync("python3", [logsTool, "tend", "--log-dir", expiring, "--status", join(dir, "expiring.json"), "--now", String(now), "--settle", "0", "--free-percent", "50"], { encoding: "utf8" });
		assert.equal(run(t0 + 2 * DAY + 3 * 3600).status, 0);
		// 92 days on, the first two days expire. The first pass cannot delete or write anything (a read-only folder):
		// cut short before any expiry.
		const later = t0 + 92 * DAY + 3 * 3600;
		chmodSync(expiring, 0o555);
		try {
			assert.equal(run(later).status, 1);
		} finally {
			chmodSync(expiring, 0o755);
		}
		assert.equal(run(later).status, 0);
		const left = readdirSync(expiring);
		assert.ok(!left.some((name) => name.startsWith("flows-") || name.startsWith("clients-")), left.join(" "));
		const counted = left.filter((name) => name.startsWith("counts-"));
		assert.ok(counted.length > 80);
		for (const name of counted)
			assert.deepEqual(JSON.parse(readFileSync(join(expiring, name), "utf8")).late, [], `${name}: nothing counted twice`);
		const lost = lostRecords(expiring).map((record) => record.file);
		for (const [part, counts] of [[`flows-${day}.p001.jsonl.gz`, `counts-${day}.json`], [`clients-${day}.p001.jsonl.gz`, `counts-${day}.json`], [`flows-${next}.p001.jsonl.gz`, `counts-${next}.json`]])
			assert.ok(lost.indexOf(part) >= 0 && lost.indexOf(part) < lost.indexOf(counts), lost.join(" "));
	});

	test("a deletion is never unrecorded: its record comes first, whole, and a deleted name is never used again", () => {
		const ledger = mkdtempSync(join(dir, "ledger-"));
		writeFileSync(join(ledger, `clients-${day}.jsonl`), lines([machine("10.210.1.1", "cA", "mA", t0 + 100)]));
		writeFileSync(join(ledger, `flows-${day}.jsonl`), lines([opened("10.210.1.1", t0 + 200)]));
		writeFileSync(join(ledger, `flows-${next}.jsonl`), lines([opened("10.210.1.1", t0 + DAY + 200)]));
		const run = (now) =>
			spawnSync("python3", [logsTool, "tend", "--log-dir", ledger, "--status", join(dir, "ledger.json"), "--now", String(now), "--settle", "0", "--free-percent", "50"], { encoding: "utf8" });
		const counted = t0 + 2 * DAY + 3 * 3600;
		assert.equal(run(counted).status, 0);
		// A pass cut short under pressure, after the second day's record and before its unlink. The pressure is gone
		// now: the recorded deletion is finished all the same, first, and not recorded twice.
		const pending = `flows-${next}.p001.jsonl.gz`;
		mkdirSync(join(ledger, "lost"));
		writeFileSync(join(ledger, "lost", `${pending}.json`), JSON.stringify({ ts: counted, recordedAt: 1, file: pending, bytes: 1, day: next, reason: "over the cap" }));
		assert.equal(run(counted + 3600).status, 0);
		assert.ok(!readdirSync(ledger).includes(pending));
		assert.ok(readdirSync(ledger).includes(`flows-${day}.p001.jsonl.gz`), "no pressure, no expiry: the rest stays");
		assert.equal(lostRecords(ledger).length, 1);
		// 92 days on, the first day expires. A record that cannot be written (a folder where its temporary file goes):
		// that file is not deleted.
		const later = t0 + 92 * DAY + 3 * 3600;
		const blocked = join(ledger, "lost", `.flows-${day}.p001.jsonl.gz.json.tmp`);
		mkdirSync(blocked);
		assert.equal(run(later).status, 1);
		assert.ok(readdirSync(ledger).includes(`flows-${day}.p001.jsonl.gz`), "kept without its record");
		assert.ok(!lostRecords(ledger).some((record) => record.file === `flows-${day}.p001.jsonl.gz`));
		rmSync(blocked, { recursive: true });
		// Then each deletion with its own record.
		assert.equal(run(later).status, 0);
		assert.deepEqual(
			lostRecords(ledger).map((record) => record.file).sort(),
			[`clients-${day}.p001.jsonl.gz`, `counts-${day}.json`, `counts-${next}.json`, `flows-${day}.p001.jsonl.gz`, pending].sort(),
		);
		assert.ok(!readdirSync(ledger).some((name) => name.startsWith("flows-") || name.startsWith("clients-")));
		// The first day's counts are gone too; a late part for it gets a name never used before, and is counted late.
		writeFileSync(join(ledger, `clients-${day}.jsonl`), lines([machine("10.210.1.2", "cC", "mC", t0 + 300)]));
		assert.equal(run(later + DAY).status, 0);
		const newest = readdirSync(ledger).filter((name) => name.startsWith("counts-")).sort().at(-1);
		assert.deepEqual(JSON.parse(readFileSync(join(ledger, newest), "utf8")).late.map((late) => late.parts), [[`clients-${day}.p002.jsonl.gz`]]);
	});

	test("nothing goes until its record is synced: a failed sync of lost/ keeps the part, also when a later pass finishes it", () => {
		const unsynced = mkdtempSync(join(dir, "unsynced-"));
		writeFileSync(join(unsynced, `flows-${day}.jsonl`), lines([opened("10.210.1.1", t0 + 200)]));
		const part = `flows-${day}.p001.jsonl.gz`;
		// The tender in this process, 92 days on (the part expires), every folder sync and unlink noted. In the first two
		// passes syncing lost/ fails (a disk error), after the record's rename.
		const script = String.raw`
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("logs", sys.argv[1])
logs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(logs)
log_dir, now, part = sys.argv[2], float(sys.argv[3]), sys.argv[4]
events, failing = [], [True]
sync, unlink = logs.sync_folder, os.unlink
def noted_sync(path):
    events.append(["sync", os.path.relpath(path, log_dir)])
    if failing[0] and os.path.basename(path) == "lost":
        raise OSError(5, "Input/output error")
    sync(path)
def noted_unlink(path, *args, **kwargs):
    events.append(["unlink", os.path.relpath(path, log_dir)])
    unlink(path, *args, **kwargs)
logs.sync_folder = noted_sync
os.unlink = noted_unlink
passes = []
for fail in (True, True, False):
    failing[0] = fail
    events.clear()
    result = logs.tend(log_dir, os.path.join(log_dir, "s.json"), 1 << 30, 10.0, now=now, settle=0, free=lambda _: 50.0)
    record = os.path.join(log_dir, "lost", part + ".json")
    passes.append({"problems": result["problems"], "events": list(events), "files": sorted(os.listdir(log_dir)),
                   "records": sorted(os.listdir(os.path.join(log_dir, "lost"))),
                   "record": open(record).read() if os.path.exists(record) else None})
print(json.dumps(passes))
`;
		const r = spawnSync("python3", ["-c", script, logsTool, unsynced, String(t0 + 92 * DAY + 3 * 3600), part], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		const [first, second, third] = JSON.parse(r.stdout);
		const unlinked = (pass) => pass.events.some(([what, name]) => what === "unlink" && name === part);
		// The record is renamed into place, then its sync fails: the part stays. lost/ was made, and the log folder synced.
		assert.match(first.problems.join(" | "), /tidy: .*Input\/output error/);
		assert.ok(first.files.includes(part) && !unlinked(first));
		assert.deepEqual(first.records, [`${part}.json`]);
		assert.deepEqual(first.events.filter(([what]) => what === "sync"), [["sync", "."], ["sync", "lost"]]);
		// The next pass finds the recorded deletion; its sync fails too: the part still stays, the record unchanged.
		assert.match(second.problems.join(" | "), /tidy: .*Input\/output error/);
		assert.ok(second.files.includes(part) && !unlinked(second));
		assert.equal(second.record, first.record);
		// Then the sync works: lost/ and the log folder are synced, and only then does the part go. Its counts go after.
		assert.deepEqual(third.problems, []);
		assert.ok(!third.files.includes(part));
		const at = third.events.findIndex(([what, name]) => what === "unlink" && name === part);
		assert.deepEqual(third.events.slice(0, at), [["sync", "lost"], ["sync", "."]]);
		assert.equal(third.record, first.record, "not written again");
		assert.deepEqual(third.records, [`counts-${day}.json.json`, `counts-${next}.json.json`, `${part}.json`]);
	});

	test("the deletion records count toward the cap, for the tender and the logger, though they never go", () => {
		const full = mkdtempSync(join(dir, "records-"));
		writeFileSync(join(full, `flows-${day}.jsonl`), lines([opened("10.210.1.1", t0 + 200)]));
		const part = `flows-${day}.p001.jsonl.gz`;
		const run = (cap) =>
			spawnSync("python3", [logsTool, "tend", "--log-dir", full, "--status", join(dir, "records.json"), "--now", String(t0 + DAY + 3 * 3600), "--settle", "0", "--free-percent", "50", "--cap-bytes", String(cap)], { encoding: "utf8" });
		const bytes = (folder) =>
			readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isFile()).reduce((sum, entry) => sum + statSync(join(folder, entry.name)).size, 0);
		assert.equal(run(2 ** 30).status, 0);
		// A cap the logs alone are well under: nothing goes.
		const cap = Math.ceil(bytes(full) / 0.8) + 100;
		const quiet = run(cap);
		assert.equal(quiet.status, 0, quiet.stderr);
		assert.equal(JSON.parse(quiet.stdout).deleted, 0);
		// Records of earlier deletions that hold more than the cap by themselves: the counted part goes, and the logs are
		// still over their cap. The records all stay.
		const old = "flows-2026-06-01.p001.jsonl.gz";
		mkdirSync(join(full, "lost"));
		writeFileSync(join(full, "lost", `${old}.json`), JSON.stringify({ ts: t0, recordedAt: 1, file: old, bytes: 1, day: "2026-06-01", reason: "kept 90 days", pad: "x".repeat(cap) }));
		const over = run(cap);
		assert.equal(over.status, 1);
		const result = JSON.parse(over.stdout);
		assert.match(result.problems.join(" | "), /over their cap, or the disk under its floor/);
		assert.ok(!readdirSync(full).includes(part));
		assert.deepEqual(lostRecords(full).map((record) => [record.file, record.reason]), [[old, "kept 90 days"], [part, "over the cap"]]);
		assert.equal(result.bytes, bytes(full) + bytes(join(full, "lost")), "logs.json counts the records");
		// The logger's pressure check counts them too: it pauses.
		const script = String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("logger", sys.argv[1])
logger = importlib.util.module_from_spec(spec)
spec.loader.exec_module(logger)
free, size = logger.disk_state(sys.argv[2])
print(json.dumps({"size": size, "pause": logger.should_pause(False, 50.0, size, int(sys.argv[3]), 10.0)}))
`;
		const r = spawnSync("python3", ["-c", script, logger, full, String(cap)], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual(JSON.parse(r.stdout), { size: result.bytes, pause: true });
	});

	test("a pass cut short never seals a line twice, and a DNS copy left plain is compressed", () => {
		const crashed = mkdtempSync(join(dir, "crashed-"));
		const line = lines([opened("10.210.1.1", t0 + 10)]);
		// Cut short after publishing the part, before removing its source.
		writeFileSync(join(crashed, `flows-${day}.p001.jsonl.gz`), gzipSync(line));
		writeFileSync(join(crashed, `flows-${day}.p001.sealing`), line);
		// Cut short before publishing: the source alone.
		writeFileSync(join(crashed, `clients-${day}.p001.sealing`), lines([machine("10.210.1.1", "cA", "mA", t0 + 5)]));
		writeFileSync(join(crashed, "dns-2026-09-01T030000Z.log"), "q\n");
		const r = spawnSync(
			"python3",
			[logsTool, "tend", "--log-dir", crashed, "--status", join(crashed, "s.json"), "--now", String(t0 + DAY + 3 * 3600), "--settle", "0", "--free-percent", "50"],
			{ encoding: "utf8" },
		);
		assert.equal(r.status, 0, r.stderr);
		const left = readdirSync(crashed).filter((name) => !name.startsWith("."));
		assert.deepEqual(left.filter((name) => name.endsWith(".sealing") || name.endsWith(".log")), []);
		assert.ok(!left.includes(`flows-${day}.p002.jsonl.gz`), left.join(" "));
		assert.equal(gunzipSync(readFileSync(join(crashed, `flows-${day}.p001.jsonl.gz`))).toString("utf8"), line);
		assert.equal(gunzipSync(readFileSync(join(crashed, "dns-2026-09-01T030000Z.log.gz"))).toString("utf8"), "q\n");
		const c = JSON.parse(readFileSync(join(crashed, `counts-${day}.json`), "utf8"));
		assert.equal(c.companies.cA.connections, 1, "counted once");
	});

	test("under the disk's floor the connection log and DNS parts go, and the pass says so; after 90 days all goes", () => {
		const fresh = mkdtempSync(join(dir, "fresh-"));
		const now = t0 + 100 * DAY;
		// 90 days before the clock is 2026-09-11.
		const old = "2026-09-01";
		const kept = "2026-11-01";
		for (const name of [`flows-${old}.p001.jsonl.gz`, `counts-${old}.json`, `dns-${old}T000000Z.log.gz`, `flows-${kept}.p001.jsonl.gz`, `counts-${kept}.json`])
			writeFileSync(join(fresh, name), "x");
		const run = (free) =>
			spawnSync("python3", [logsTool, "tend", "--log-dir", fresh, "--status", join(fresh, "s.json"), "--now", String(now), "--settle", "0", "--free-percent", free], { encoding: "utf8" });
		const first = run("50");
		assert.equal(first.status, 0, first.stderr);
		const left = readdirSync(fresh).filter((name) => !name.startsWith("."));
		assert.deepEqual(left.filter((name) => name.includes(old)), [], "older than 90 days");
		assert.ok(left.includes(`flows-${kept}.p001.jsonl.gz`) && left.includes(`counts-${kept}.json`));
		const low = run("9");
		assert.equal(low.status, 1);
		assert.ok(!readdirSync(fresh).includes(`flows-${kept}.p001.jsonl.gz`), "the disk is low");
		assert.ok(readdirSync(fresh).includes(`counts-${kept}.json`), "counts stay");
		const reasons = lostRecords(fresh).map((record) => record.reason);
		assert.deepEqual([...new Set(reasons)], ["kept 90 days", "the disk is low"]);
	});
});

describe("the logs on the NAS", { skip: pythonUsable ? false : "needs Python 3.11 or later" }, () => {
	const DAY = 86400;
	const day = "2026-09-01";
	const next = "2026-09-02";
	const third = "2026-09-03";
	const t0 = Date.UTC(2026, 8, 1) / 1000;
	const iso = (ts) => new Date(ts * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
	let dir;
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "agent-exit-nas-"));
	});
	after(() => rmSync(dir, { recursive: true, force: true }));
	const lines = (records) => `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
	const machine = (address, company, machineId, ts) => ({ event: "plugged", address, company, machine: machineId, kind: "machine", ts });
	const opened = (src, ts) => ({ event: "new", src, dst: "1.1.1.1", proto: "tcp", sport: 40000, dport: 443, ts });
	const closed = (src, ts, bytes) => ({ event: "destroy", src, dst: "1.1.1.1", proto: "tcp", sport: 40000, dport: 443, packets_out: 5, bytes_out: bytes, packets_in: 4, bytes_in: 900, ts });
	const gap = (reason, ts, since) => ({ event: "gap", reason, ts, ...(since === undefined ? {} : { since }) });
	// The logger's alive lines, one a minute from `from` until before `to`.
	const alive = (from, to) => Array.from({ length: Math.ceil((to - from) / 60) }, (_, i) => ({ event: "alive", ts: from + 60 * i }));
	// A node: its log folder and status files, and the NAS (mounted: its marker is there), its own or another node's.
	// The NAS here is a plain folder, not a mount point: the helpers below say a folder will do (--nas-any-folder).
	const node = (name, nas) => {
		const root = mkdtempSync(join(dir, `${name}-`));
		mkdirSync(join(root, "log"));
		if (!nas) {
			mkdirSync(join(root, "nas"));
			writeFileSync(join(root, "nas", ".qorpera-agent-exit-logs"), "");
		}
		return { root, log: join(root, "log"), nas: nas ?? join(root, "nas") };
	};
	const python = (args) => {
		const r = spawnSync("python3", [logsTool, ...args], { encoding: "utf8" });
		return { status: r.status, result: r.stdout ? JSON.parse(r.stdout) : null, stderr: r.stderr };
	};
	const tend = (n, now, ...extra) =>
		python(["tend", "--log-dir", n.log, "--status", join(n.root, "logs.json"), "--now", String(now), "--settle", "0", "--free-percent", "50", ...extra]);
	const shipArgs = (n, now, host = "node-a", nas = n.nas) => ["ship", "--log-dir", n.log, "--nas-dir", nas, "--status", join(n.root, "ship.json"), "--host", host, "--now", String(now)];
	const ship = (...args) => python([...shipArgs(...args), "--nas-any-folder"]);
	const lookupArgs = (n, now, at) => ["lookup", "--log-dir", n.log, "--nas-dir", n.nas, "--host", "node-a", "--now", String(now), "--at", String(at), "--remote", "1.1.1.1", "--remote-port", "443", "--nas-any-folder"];
	const lookup = (n, now, at, ...extra) => {
		const r = python([...lookupArgs(n, now, at), "--json", ...extra]);
		assert.equal(r.status, 0, r.stderr);
		return r.result;
	};

	test("each sealed file goes to <nas>/<host>/<day>/ once, read back and compared; the node says what is not there yet", () => {
		const a = node("ship");
		writeFileSync(join(a.log, `clients-${day}.jsonl`), lines([machine("10.210.1.1", "cA", "mA", t0 + 100)]));
		writeFileSync(join(a.log, `flows-${day}.jsonl`), lines([opened("10.210.1.1", t0 + 150)]));
		writeFileSync(join(a.log, "dns.log"), "q\n");
		assert.equal(tend(a, t0 + DAY + 3 * 3600).status, 0);
		writeFileSync(join(a.log, `flows-${next}.jsonl`), lines([opened("10.210.1.1", t0 + DAY + 10)]));
		const first = ship(a, t0 + DAY + 4 * 3600);
		assert.equal(first.status, 0, first.stderr);
		assert.deepEqual([first.result.shipped, first.result.waiting, first.result.problems], [3, 0, []]);
		const sent = [`clients-${day}.p001.jsonl.gz`, `counts-${day}.json`, `flows-${day}.p001.jsonl.gz`];
		assert.deepEqual(readdirSync(join(a.nas, "node-a", day)).sort(), sent);
		for (const name of sent) {
			const record = JSON.parse(readFileSync(join(a.log, "shipped", `${name}.json`), "utf8"));
			assert.deepEqual(
				[record.file, record.day, record.to, record.sha256, record.bytes],
				[name, day, `node-a/${day}/${name}`, sha256(readFileSync(join(a.log, name))), statSync(join(a.log, name)).size],
			);
			assert.deepEqual(readFileSync(join(a.nas, "node-a", day, name)), readFileSync(join(a.log, name)));
			assert.equal(statSync(join(a.nas, "node-a", day, name)).mode & 0o007, 0, "no one else reads the logs");
		}
		// For the other nodes' lookups: the time it covers, and what is on this node only (the second day's open
		// connection log, and dns.log, not cut since the logs began).
		const shipped = JSON.parse(readFileSync(join(a.nas, "node-a", "status.json"), "utf8"));
		assert.deepEqual(
			[shipped.host, shipped.through, shipped.notShipped],
			["node-a", iso(t0 + DAY + 4 * 3600), { dns: [day, next], flows: [next] }],
		);
		assert.equal(ship(a, t0 + DAY + 4 * 3600 + 300).result.shipped, 0, "each file once");
		// The next day the second day is sealed and dns.log cut: a DNS part goes under the day of its cut.
		assert.equal(tend(a, t0 + 2 * DAY + 3 * 3600).status, 0);
		assert.equal(ship(a, t0 + 2 * DAY + 4 * 3600).result.shipped, 3);
		assert.deepEqual(readdirSync(join(a.nas, "node-a", third)), ["dns-2026-09-03T030000Z.log.gz"]);
		assert.deepEqual(JSON.parse(readFileSync(join(a.nas, "node-a", "status.json"), "utf8")).notShipped, {});
	});

	test("a file of its name with other content on the NAS is never overwritten; one waiting a day is a problem", () => {
		const a = node("conflict");
		writeFileSync(join(a.log, `flows-${day}.jsonl`), lines([opened("10.210.1.1", t0 + 150)]));
		assert.equal(tend(a, t0 + DAY + 3 * 3600).status, 0);
		const part = `flows-${day}.p001.jsonl.gz`;
		mkdirSync(join(a.nas, "node-a", day), { recursive: true });
		writeFileSync(join(a.nas, "node-a", day, part), "theirs");
		const r = ship(a, t0 + DAY + 4 * 3600);
		assert.equal(r.status, 0, "not a problem before it has waited a day");
		assert.deepEqual([r.result.shipped, r.result.waiting], [1, 1]);
		assert.match(r.result.errors.join(" | "), /flows-2026-09-01\.p001\.jsonl\.gz is on the NAS with other content/);
		assert.equal(readFileSync(join(a.nas, "node-a", day, part), "utf8"), "theirs");
		assert.ok(!existsSync(join(a.log, "shipped", `${part}.json`)));
		// Sealed more than a day before the pass and still on the node only: the exit is unhealthy until it goes.
		utimesSync(join(a.log, part), t0 + DAY + 3 * 3600, t0 + DAY + 3 * 3600);
		const late = ship(a, t0 + 2 * DAY + 4 * 3600);
		assert.equal(late.status, 1);
		assert.match(
			late.result.problems[0],
			/^1 files have waited more than 24 hours to go to the NAS, the oldest since 2026-09-02T03:00:00Z; the last error: .*other content/,
		);
		assert.deepEqual(JSON.parse(readFileSync(join(a.nas, "node-a", "status.json"), "utf8")).notShipped, { flows: [day] });
		rmSync(join(a.nas, "node-a", day, part));
		const fixed = ship(a, t0 + 2 * DAY + 5 * 3600);
		assert.deepEqual([fixed.status, fixed.result.shipped, fixed.result.problems], [0, 1, []]);
	});

	test("a NAS folder that is not a mount point, or has no marker, is never written to; no NAS folder is a problem at once", () => {
		const a = node("unmounted");
		writeFileSync(join(a.log, `flows-${day}.jsonl`), lines([opened("10.210.1.1", t0 + 150)]));
		assert.equal(tend(a, t0 + DAY + 3 * 3600).status, 0);
		// The bare folder under the mount point, a marker left in it by mistake: the share is not mounted there.
		const bare = python(shipArgs(a, t0 + DAY + 4 * 3600));
		assert.equal(bare.status, 0, bare.stderr);
		assert.deepEqual([bare.result.shipped, bare.result.waiting], [0, 2]);
		assert.match(bare.result.errors[0], /is not a mount point: the NAS is not mounted there$/);
		assert.deepEqual(readdirSync(a.nas), [".qorpera-agent-exit-logs"]);
		rmSync(join(a.nas, ".qorpera-agent-exit-logs"));
		// A pass cut short (the NAS stopped answering) left its status saying it was shipping.
		writeFileSync(join(a.root, "ship.json"), JSON.stringify({ shipping: true }));
		const r = ship(a, t0 + DAY + 4 * 3600);
		assert.equal(r.status, 0, r.stderr);
		assert.deepEqual([r.result.shipped, r.result.waiting], [0, 2]);
		assert.match(r.result.errors[0], /^the last pass did not finish/);
		assert.match(r.result.errors[1], /has no \.qorpera-agent-exit-logs: the NAS is not mounted there$/);
		assert.deepEqual(readdirSync(a.nas), []);
		const none = ship(a, t0 + DAY + 4 * 3600, "node-a", "");
		assert.equal(none.status, 1);
		assert.deepEqual(none.result.problems, ["no NAS folder is set (QORPERA_AGENT_EXIT_NAS_DIR in /etc/default/qorpera-agent-exit)"]);
		assert.equal(JSON.parse(readFileSync(join(a.root, "ship.json"), "utf8")).waiting, 2);
	});

	test("a copy that reads back wrong from the NAS is removed, not recorded, and goes again next pass", () => {
		const a = node("readback");
		writeFileSync(join(a.log, `flows-${day}.jsonl`), lines([opened("10.210.1.1", t0 + 150)]));
		assert.equal(tend(a, t0 + DAY + 3 * 3600).status, 0);
		// The shipper in this process. In the first pass every read back from the NAS gives other bytes.
		const script = String.raw`
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("logs", sys.argv[1])
logs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(logs)
log_dir, nas_dir, status, now = sys.argv[2], sys.argv[3], sys.argv[4], float(sys.argv[5])
real, wrong = logs.file_sha256, [True]
def read_back(path, uncached=False, dir_fd=None):
    return "0" * 64 if uncached and wrong[0] else real(path, uncached, dir_fd)
logs.file_sha256 = read_back
passes = []
for each in (True, False):
    wrong[0] = each
    result = logs.ship(log_dir, nas_dir, status, "node-a", now, mount_check=False)
    passes.append({"shipped": result["shipped"], "errors": result["errors"],
                   "nas": sorted(os.listdir(os.path.join(nas_dir, "node-a", "2026-09-01"))),
                   "records": sorted(os.listdir(os.path.join(log_dir, "shipped")))})
print(json.dumps(passes))
`;
		const r = spawnSync("python3", ["-c", script, logsTool, a.log, a.nas, join(a.root, "ship.json"), String(t0 + DAY + 4 * 3600)], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		const [wrong, right] = JSON.parse(r.stdout);
		assert.deepEqual([wrong.shipped, wrong.nas, wrong.records], [0, [], ["lost"]]);
		assert.equal(wrong.errors.length, 2);
		for (const error of wrong.errors) assert.match(error, / read back from the NAS is not what was written: removed, tried again next pass$/);
		assert.deepEqual(
			[right.shipped, right.nas, right.records],
			[2, [`counts-${day}.json`, `flows-${day}.p001.jsonl.gz`], [`counts-${day}.json.json`, `flows-${day}.p001.jsonl.gz.json`, "lost"]],
		);
	});

	test("the tender removes a part the NAS holds after a week, or first under pressure, with no deletion record", () => {
		const shippedNode = (name) => {
			const n = node(name);
			writeFileSync(join(n.log, `clients-${day}.jsonl`), lines([machine("10.210.1.1", "cA", "mA", t0 + 100)]));
			writeFileSync(join(n.log, `flows-${day}.jsonl`), lines([opened("10.210.1.1", t0 + 150)]));
			assert.equal(tend(n, t0 + DAY + 3 * 3600).status, 0);
			assert.equal(ship(n, t0 + DAY + 4 * 3600).result.shipped, 3);
			// The second day's part is sealed after the pass: not on the NAS.
			writeFileSync(join(n.log, `flows-${next}.jsonl`), lines([opened("10.210.1.1", t0 + DAY + 150)]));
			assert.equal(tend(n, t0 + 2 * DAY + 3 * 3600).status, 0);
			return n;
		};
		const week = shippedNode("week");
		assert.equal(tend(week, t0 + 7 * DAY + 3 * 3600).result.removedShipped, 0, "not a week old yet");
		const old = tend(week, t0 + 8 * DAY + 3 * 3600);
		assert.equal(old.status, 0, old.stderr);
		assert.equal(old.result.removedShipped, 2);
		assert.deepEqual(readdirSync(week.log).filter((name) => name.endsWith(".gz")), [`flows-${next}.p001.jsonl.gz`]);
		assert.ok(existsSync(join(week.log, `counts-${day}.json`)), "counts stay");
		assert.deepEqual(lostRecords(week.log), []);
		// Over the cap the parts the NAS holds go first; then the oldest others, each with its deletion record.
		const pressed = shippedNode("pressure");
		const r = tend(pressed, t0 + 2 * DAY + 4 * 3600, "--cap-bytes", "1");
		assert.equal(r.status, 1);
		assert.deepEqual([r.result.removedShipped, r.result.deleted], [2, 1]);
		assert.deepEqual(lostRecords(pressed.log).map((record) => [record.file, record.reason]), [[`flows-${next}.p001.jsonl.gz`, "over the cap"]]);
		// The deletion record goes to the NAS too, so a lookup on any node knows that part is gone.
		const then = ship(pressed, t0 + 2 * DAY + 5 * 3600);
		assert.equal(then.result.shipped, 2, "the second day's counts and the record");
		const record = join(pressed.nas, "node-a", next, "lost", `flows-${next}.p001.jsonl.gz.json`);
		assert.equal(JSON.parse(readFileSync(record, "utf8")).reason, "over the cap");
		assert.ok(existsSync(join(pressed.log, "shipped", "lost", `flows-${next}.p001.jsonl.gz.json`)));
	});

	test("each node removes its own day folders on the NAS past 90 days, and its records of them", () => {
		const a = node("expire");
		for (const host of ["node-a", "node-b"]) {
			mkdirSync(join(a.nas, host, "2026-05-01"), { recursive: true });
			writeFileSync(join(a.nas, host, "2026-05-01", "flows-2026-05-01.p001.jsonl.gz"), "x");
		}
		mkdirSync(join(a.nas, "node-a", day));
		mkdirSync(join(a.log, "shipped"));
		for (const d of ["2026-05-01", day])
			writeFileSync(join(a.log, "shipped", `flows-${d}.p001.jsonl.gz.json`), JSON.stringify({ file: `flows-${d}.p001.jsonl.gz`, day: d }));
		const r = ship(a, t0 + 3600);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(r.result.removedFromNas, 1);
		assert.deepEqual(readdirSync(join(a.nas, "node-a")).sort(), [day, "status.json"]);
		assert.ok(existsSync(join(a.nas, "node-b", "2026-05-01")), "another node's folder is its own to remove");
		assert.deepEqual(readdirSync(join(a.log, "shipped")).sort(), [`flows-${day}.p001.jsonl.gz.json`, "lost"]);
	});

	test("lookup: who used an address, on this node and every node on the NAS, with company, machine and name", () => {
		const a = node("lookup-a");
		const b = node("lookup-b", a.nas);
		// The same agent address on both nodes at the same time (each node has its own client map), for two companies.
		// Each machine looked its name up first; the answer came by a CNAME.
		const fill = (n, company, machineId, start, name, bytes, extra = []) => {
			writeFileSync(join(n.log, `clients-${day}.jsonl`), lines([machine("10.210.1.1", company, machineId, t0 + 100)]));
			writeFileSync(
				join(n.log, `flows-${day}.jsonl`),
				lines([gap("logger started", t0 + 50), ...extra, opened("10.210.1.1", start), closed("10.210.1.1", start + 100, bytes), ...alive(t0 + 55, t0 + DAY)]),
			);
			writeFileSync(
				join(n.log, "dns.log"),
				[
					`Sep  1 00:13:00 dnsmasq[12]: 7 10.210.1.1/5353 query[A] ${name} from 10.210.1.1`,
					`Sep  1 00:13:00 dnsmasq[12]: 7 10.210.1.1/5353 reply ${name} is <CNAME>`,
					"Sep  1 00:13:00 dnsmasq[12]: 7 10.210.1.1/5353 reply edge.example.net is 1.1.1.1",
					"",
				].join("\n"),
			);
			// The first pass notes the day; the next day's seals the first and cuts dns.log.
			assert.equal(tend(n, t0 + 3600).status, 0);
			assert.equal(tend(n, t0 + DAY + 3 * 3600).status, 0);
		};
		const refusal = { event: "refused", src: "10.210.1.1", dst: "1.1.1.1", proto: "udp", dport: 443, rule: "open_limit", ts: t0 + 700 };
		fill(a, "cA", "mA", t0 + 800, "www.example.com", 500, [refusal]);
		fill(b, "cB", "mB", t0 + 850, "api.example.org", 300);
		assert.equal(ship(a, t0 + DAY + 4 * 3600).result.shipped, 4);
		assert.equal(ship(b, t0 + DAY + 4 * 3600, "node-b").result.shipped, 4);
		// Node a's own copy of its connection log is gone (the tender removes it after a week): the NAS's is read. Node
		// b's own folder is never read.
		rmSync(join(a.log, `flows-${day}.p001.jsonl.gz`));
		rmSync(b.log, { recursive: true });
		const now = t0 + DAY + 5 * 3600;
		const result = lookup(a, now, t0 + 900);
		assert.deepEqual([result.nodes, result.read], [["node-a", "node-b"], { from: "2026-08-31", to: next }]);
		assert.deepEqual(
			result.connections.map((c) => [c.node, c.company, c.machine, c.src, c.sport, c.dst, c.dport, c.name, c.start, c.end, c.bytesOut]),
			[
				["node-a", "cA", "mA", "10.210.1.1", 40000, "1.1.1.1", 443, "www.example.com", iso(t0 + 800), iso(t0 + 900), 500],
				["node-b", "cB", "mB", "10.210.1.1", 40000, "1.1.1.1", 443, "api.example.org", iso(t0 + 850), iso(t0 + 950), 300],
			],
		);
		assert.deepEqual(result.refused, [
			{ node: "node-a", at: iso(t0 + 700), company: "cA", machine: "mA", kind: "machine", member: null, src: "10.210.1.1", dst: "1.1.1.1", dport: 443, proto: "udp", rule: "open_limit" },
		]);
		assert.deepEqual([result.unknown, result.complete], [[], true]);
		// With every log there, nothing in the window means no one.
		const quiet = lookup(a, now, t0 + 2000);
		assert.deepEqual([quiet.connections, quiet.unknown, quiet.complete], [[], [], true]);
		const text = spawnSync("python3", [logsTool, ...lookupArgs(a, now, "2026-09-01T00:15:00Z")], { encoding: "utf8" });
		assert.equal(text.status, 0, text.stderr);
		assert.match(
			text.stdout,
			/^ {2}2026-09-01T00:13:20Z to 2026-09-01T00:15:00Z on node-a: company cA, machine mA; 10\.210\.1\.1:40000 to 1\.1\.1\.1:443 tcp, looked up as www\.example\.com; 500 bytes out, 900 in$/m,
		);
		assert.match(text.stdout, /^The answer is complete\.$/m);
	});

	test("lookup lists what the logs cannot say as not known, never as no one", () => {
		const g = node("gaps");
		const now = t0 + 3600;
		writeFileSync(join(g.log, `clients-${day}.jsonl`), lines([machine("10.210.1.1", "cA", "mA", t0 + 100)]));
		const unknownIn = (records, ...extra) => {
			writeFileSync(join(g.log, `flows-${day}.jsonl`), lines(records));
			const result = lookup(g, now, t0 + 900, ...extra);
			return [result.unknown.map((u) => [u.node, u.from, u.to, u.what, u.why]), result.complete];
		};
		// The logger's alive lines all along, besides what the records say.
		const unknownFor = (records, ...extra) => unknownIn([...alive(t0, now), ...records], ...extra);
		const seen = [opened("10.210.1.1", t0 + 800), closed("10.210.1.1", t0 + 900, 500)];
		assert.deepEqual(unknownFor(seen), [[], true]);
		// A stretch of more than 3 minutes with no alive line, and no gap line to say why (the logger was stopped, or
		// it stopped and has not started again): not known from its last line on.
		const silent = "the connection logger wrote no line then (it writes one every minute while it logs): it was down, paused or could not write";
		assert.deepEqual(unknownIn([...alive(t0, t0 + 700), ...seen, ...alive(t0 + 1000, now)]), [
			[["node-a", iso(t0 + 660), iso(t0 + 1000), "connections", silent]],
			false,
		]);
		assert.deepEqual(unknownIn(seen), [[["node-a", iso(t0), iso(now), "connections", silent]], false]);
		// A pause as the logger writes it (no alive lines while paused): its own lines say so, once.
		const paused = "paused: the logs hold 2147483648 bytes, past their cap";
		const resumed = "resumed: 3 lines not written while paused";
		assert.deepEqual(unknownIn([...alive(t0, t0 + 700), gap(paused, t0 + 700), gap(resumed, t0 + 1000, t0 + 700), ...alive(t0 + 1000, now)]), [
			[["node-a", iso(t0 + 700), iso(t0 + 1000), "connections", resumed]],
			false,
		]);
		// Events conntrack could not deliver: since the line before.
		assert.deepEqual(unknownFor([opened("10.210.1.1", t0 + 100), gap("conntrack lost events", t0 + 860)]), [
			[["node-a", iso(t0 + 100), iso(t0 + 860), "connections", "conntrack lost events"]],
			false,
		]);
		// A pause, from its line to the one that says what it missed.
		assert.deepEqual(unknownFor([gap(paused, t0 + 700), gap(resumed, t0 + 1000, t0 + 700)]), [
			[["node-a", iso(t0 + 700), iso(t0 + 1000), "connections", resumed]],
			false,
		]);
		// The logger stopped while it paused: its pause ends where the next logger starts.
		assert.deepEqual(unknownFor([gap(paused, t0 + 700), gap("logger started", t0 + 1000, t0 + 690)]), [
			[
				["node-a", iso(t0 + 700), iso(t0 + 1000), "connections", paused],
				["node-a", iso(t0 + 690), iso(t0 + 1000), "connections", "logger started"],
			],
			false,
		]);
		// A pause not resumed in what was read: until now.
		assert.deepEqual(unknownFor([gap(paused, t0 + 700)]), [
			[["node-a", iso(t0 + 700), null, "connections", `${paused} (and not resumed in what was read)`]],
			false,
		]);
		// While paused, the logger empties dns.log every 5 seconds: the names since the last cut are not known, once.
		writeFileSync(join(g.log, "dns-2026-09-01T000500Z.log.gz"), gzipSync(""));
		const dropped = "paused: 120 bytes of the DNS record not kept";
		const emptied = [0, 5, 10].map((s) => gap(dropped, t0 + 700 + s));
		assert.deepEqual(unknownFor([...seen, gap(paused, t0 + 690), ...emptied, gap(resumed, t0 + 1000, t0 + 690)]), [
			[
				["node-a", iso(t0 + 690), iso(t0 + 1000), "connections", resumed],
				["node-a", iso(t0 + 300), iso(t0 + 710), "names", `3 gap lines say the DNS record was not kept, the last: ${dropped}`],
			],
			false,
		]);
		// Those lines come only while the logger pauses: with no pause line before them, it paused before what was read.
		assert.deepEqual(unknownFor([...seen, ...emptied]), [
			[
				["node-a", null, null, "connections", `the logger paused before what was read, its line says: ${dropped} (and not resumed in what was read)`],
				["node-a", iso(t0 + 300), iso(t0 + 710), "names", `3 gap lines say the DNS record was not kept, the last: ${dropped}`],
			],
			false,
		]);
		rmSync(join(g.log, "dns-2026-09-01T000500Z.log.gz"));
		// A deleted part: its day, and the grace for late lines.
		mkdirSync(join(g.log, "lost"));
		writeFileSync(join(g.log, "lost", `flows-${day}.p001.jsonl.gz.json`), JSON.stringify({ file: `flows-${day}.p001.jsonl.gz`, day, reason: "over the cap" }));
		assert.deepEqual(unknownFor(seen), [
			[["node-a", iso(t0), iso(t0 + DAY + 2 * 3600), "connections", `flows-${day}.p001.jsonl.gz was deleted (over the cap)`]],
			false,
		]);
		rmSync(join(g.log, "lost"), { recursive: true });
		// Another node that has shipped nothing since before the window ends, and has open files of the day.
		mkdirSync(join(g.nas, "node-b"));
		writeFileSync(join(g.nas, "node-b", "status.json"), JSON.stringify({ through: iso(t0 + 600), notShipped: { dns: [day], flows: [day] } }));
		assert.deepEqual(unknownFor(seen), [
			[
				["node-b", iso(t0 + 600), null, "connections", `this node has shipped nothing since ${iso(t0 + 600)}`],
				["node-b", iso(t0), iso(t0 + DAY), "names", `its dns of ${day} are not on the NAS yet`],
				["node-b", iso(t0), iso(t0 + DAY), "connections", `its flows of ${day} are not on the NAS yet`],
			],
			false,
		]);
		rmSync(join(g.nas, "node-b"), { recursive: true });
		// Another node whose logger stopped, then shipped its day: no line on the NAS says so, its silence does, to
		// what it has shipped.
		mkdirSync(join(g.nas, "node-b", day), { recursive: true });
		writeFileSync(join(g.nas, "node-b", "status.json"), JSON.stringify({ through: iso(t0 + 3000), notShipped: {} }));
		writeFileSync(join(g.nas, "node-b", day, `flows-${day}.p001.jsonl.gz`), gzipSync(lines(alive(t0, t0 + 700))));
		assert.deepEqual(unknownFor(seen), [[["node-b", iso(t0 + 660), iso(t0 + 3000), "connections", silent]], false]);
		// A node whose logs begin after the days read did not log then.
		rmSync(join(g.nas, "node-b", day), { recursive: true });
		mkdirSync(join(g.nas, "node-b", "2026-09-05"));
		assert.deepEqual(unknownFor(seen), [[], true]);
		rmSync(join(g.nas, "node-b"), { recursive: true });
		// The logger paused, or unable to write, now: its marker file, written when that began, says since when. (Its
		// gap line comes only when that ends.)
		const marker = join(g.root, "logger.marker");
		const full = "the node's disk has 4.0% free (floor 10%) and the exit's logs hold 2147483648 bytes (cap 1073741824)";
		writeFileSync(marker, `${full}\n`);
		utimesSync(marker, t0 + 900, t0 + 900);
		assert.deepEqual(unknownFor(seen, "--pause-file", marker), [
			[["node-a", iso(t0 + 900), null, "connections", `the connection log is paused now: ${full}`]],
			false,
		]);
		writeFileSync(marker, "cannot write the connection log: No space left on device\n");
		utimesSync(marker, t0 + 1000, t0 + 1000);
		assert.deepEqual(unknownFor(seen, "--failing-file", marker), [
			[["node-a", iso(t0 + 1000), null, "connections", "the connection logger is failing now: cannot write the connection log: No space left on device"]],
			false,
		]);
		utimesSync(marker, t0 + 2000, t0 + 2000);
		assert.deepEqual(unknownFor(seen, "--failing-file", marker), [[], true], "begun after the window");
		rmSync(marker);
		assert.deepEqual(unknownFor(seen, "--pause-file", marker, "--failing-file", marker), [[], true]);
		// The logger not running now (no sign of life for a minute): from its last one on, here within the window.
		const beat = join(g.root, "logger.heartbeat");
		writeFileSync(beat, "");
		utimesSync(beat, now - 5, now - 5);
		assert.deepEqual(unknownFor(seen, "--heartbeat", beat), [[], true]);
		utimesSync(beat, t0 + 1000, t0 + 1000);
		assert.deepEqual(unknownFor(seen, "--heartbeat", beat), [
			[["node-a", iso(t0 + 1000), null, "connections", `the connection logger is not running now (its last sign of life: ${iso(t0 + 1000)})`]],
			false,
		]);
		rmSync(beat);
		assert.deepEqual(unknownFor(seen, "--heartbeat", beat), [[["node-a", null, null, "connections", "the connection logger is not running now"]], false]);
		// No NAS, or one not mounted (no mount point there, or no marker in it): the other nodes are not searched.
		const alone = lookup({ ...g, nas: "" }, now, t0 + 900);
		assert.equal(alone.connections.length, 1);
		assert.deepEqual(alone.unknown.map((u) => [u.node, u.from, u.to, u.what]), [["*", iso(t0 + 600), iso(t0 + 1200), "connections"]]);
		assert.match(alone.unknown[0].why, /^no NAS folder is set .*: the other nodes were not searched$/);
		const bare = python([...lookupArgs(g, now, t0 + 900).filter((arg) => arg !== "--nas-any-folder"), "--json"]);
		assert.equal(bare.status, 0, bare.stderr);
		assert.equal(bare.result.connections.length, 1);
		assert.deepEqual(bare.result.unknown.map((u) => [u.node, u.from, u.to, u.what]), [["*", iso(t0 + 600), iso(t0 + 1200), "connections"]]);
		assert.match(bare.result.unknown[0].why, /is not a mount point: the NAS is not mounted, so the other nodes and what this one shipped were not searched$/);
		rmSync(join(g.nas, ".qorpera-agent-exit-logs"));
		assert.match(lookup(g, now, t0 + 900).unknown[0].why, /has no \.qorpera-agent-exit-logs: the NAS is not mounted, so the other nodes/);
	});

	test("lookup judges a silence at its full length, also where it crosses the edge of the days read", () => {
		const a = node("midnight");
		const now = t0 + DAY + 3 * 3600;
		// Both loggers stop after their alive line of 23:57:10; this node's starts again at 00:02 the next day, which it
		// has not shipped yet. The other node's stop runs past what it has shipped of the next day.
		const stopped = t0 + DAY - 170;
		writeFileSync(join(a.log, `flows-${day}.jsonl`), lines(alive(t0 + 10, stopped + 1)));
		writeFileSync(join(a.log, `flows-${next}.jsonl`), lines([gap("logger started", t0 + DAY + 120, stopped), ...alive(t0 + DAY + 125, now)]));
		mkdirSync(join(a.nas, "node-b", day), { recursive: true });
		writeFileSync(join(a.nas, "node-b", day, `flows-${day}.p001.jsonl.gz`), gzipSync(lines(alive(t0 + 10, stopped + 1))));
		const through = iso(now - 300);
		writeFileSync(join(a.nas, "node-b", "status.json"), JSON.stringify({ through, notShipped: { flows: [next] } }));
		// Each day's counts say who was plugged in at its end, so a read from the next day on knows the companies.
		writeFileSync(join(a.log, `counts-${day}.json`), JSON.stringify({ pluggedInAtEnd: {} }));
		writeFileSync(join(a.nas, "node-b", day, `counts-${day}.json`), JSON.stringify({ pluggedInAtEnd: {} }));
		const silent = "the connection logger wrote no line then (it writes one every minute while it logs): it was down, paused or could not write";
		const unknownAt = (at, ...extra) => {
			const result = lookup(a, now, at, "--window", "60", ...extra);
			return [result.unknown.map((u) => [u.node, u.from, u.to, u.what, u.why]), result.complete];
		};
		// Asked about 23:58:30: 170 seconds of the stop fall in the day, the rest past midnight, which node-b has not
		// shipped (listed on its own, from midnight on).
		assert.deepEqual(unknownAt(t0 + DAY - 90), [
			[
				["node-a", iso(stopped), iso(t0 + DAY + 120), "connections", "logger started"],
				["node-b", iso(stopped), iso(t0 + DAY), "connections", silent],
			],
			false,
		]);
		// Only that day read: the line that ends this node's stop is in the next, read only for that.
		assert.deepEqual(unknownAt(t0 + DAY - 90, "--days", "0"), [
			[
				["node-a", iso(stopped), iso(t0 + DAY), "connections", silent],
				["node-b", iso(stopped), iso(t0 + DAY), "connections", silent],
			],
			false,
		]);
		// The start of the days read: node-b has shipped the next day, its first line there at 00:02. Its stop began in
		// the day before, read only for its last line.
		mkdirSync(join(a.nas, "node-b", next));
		writeFileSync(join(a.nas, "node-b", next, `flows-${next}.p001.jsonl.gz`), gzipSync(lines(alive(t0 + DAY + 120, now))));
		writeFileSync(join(a.nas, "node-b", "status.json"), JSON.stringify({ through, notShipped: {} }));
		assert.deepEqual(unknownAt(t0 + DAY + 60, "--days", "0"), [
			[
				["node-a", iso(stopped), iso(t0 + DAY + 120), "connections", "logger started"],
				["node-b", iso(t0 + DAY), iso(t0 + DAY + 120), "connections", silent],
			],
			false,
		]);
		// With every line there, a stop of under 3 minutes across midnight is no silence.
		writeFileSync(join(a.log, `flows-${next}.jsonl`), lines(alive(stopped + 170, now)));
		writeFileSync(join(a.nas, "node-b", next, `flows-${next}.p001.jsonl.gz`), gzipSync(lines(alive(stopped + 170, now))));
		assert.deepEqual(unknownAt(t0 + DAY - 90, "--days", "0"), [[], true]);
		assert.deepEqual(unknownAt(t0 + DAY + 60, "--days", "0"), [[], true]);
	});

	test("lookup counts only the lines a paused logger never writes as signs that it was logging", () => {
		const a = node("paused-gaps");
		const now = t0 + DAY + 6 * 3600;
		// The logger paused before the day and went on at 05:00 the next day. All the day long a machine went over its
		// share of refusals: a paused logger still writes that gap line, one a minute, the last at 23:58:20.
		const unlogged = (from, to) => Array.from({ length: Math.ceil((to - from) / 60) }, (_, i) => gap("12 refused packets of unlogged flows", from + 60 * i));
		writeFileSync(join(a.log, `flows-${day}.jsonl`), lines(unlogged(t0 + 20, t0 + DAY - 60)));
		writeFileSync(join(a.log, `flows-${next}.jsonl`), lines([...unlogged(t0 + DAY + 20, t0 + DAY + 5 * 3600), gap("resumed: 0 lines not written while paused", t0 + DAY + 5 * 3600), ...alive(t0 + DAY + 5 * 3600 + 5, now)]));
		const silent = "the connection logger wrote no line then (it writes one every minute while it logs): it was down, paused or could not write";
		const result = lookup(a, now, t0 + DAY - 60, "--window", "30", "--days", "0");
		assert.deepEqual(
			[result.unknown.map((u) => [u.node, u.from, u.to, u.what, u.why]), result.complete],
			[[["node-a", iso(t0 + DAY - 100), iso(t0 + DAY), "connections", silent]], false],
		);
	});
});

const DOCKERFILE = `FROM ubuntu:26.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
	nftables iproute2 dnsmasq-base conntrack python3 busybox procps && rm -rf /var/lib/apt/lists/*
`;
const dockerUsable = process.platform === "linux" && spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

// Default-on again (E2a): #748 made it opt-in after docker0 vanished on node01's test machine; the cause was an E2b
// draft run's `modprobe -r br_netfilter` bare on that machine, not this proof (see the header).
describe("the exit on a stand-in node", { skip: dockerUsable ? false : "needs Linux with Docker" }, () => {
	test("the root proof passes inside a privileged, network-less container", () => {
		const image = `qorpera-agent-exit-test:${sha256(DOCKERFILE).slice(0, 12)}`;
		if (spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" }).status !== 0) {
			const build = spawnSync("docker", ["build", "-t", image, "-"], { input: DOCKERFILE, encoding: "utf8" });
			assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
		}
		// The proof must never change the machine it runs on: its bridges (docker0 above all) are all still there after.
		const bridges = () =>
			new Set(
				spawnSync("ip", ["-br", "link", "show", "type", "bridge"], { encoding: "utf8" })
					.stdout.split("\n")
					.map((line) => line.split(/\s+/)[0])
					.filter(Boolean),
			);
		const before = bridges();
		const proof = spawnSync(
			"docker",
			["run", "--rm", "--privileged", "--network", "none", "-v", `${here}:/w:ro`, image, "bash", "/w/test/proof.sh"],
			{ encoding: "utf8", timeout: 300_000 },
		);
		const after = bridges();
		assert.deepEqual(
			["docker0", "lxdbr0", "testmach0"].filter((name) => before.has(name) && !after.has(name)),
			[],
			"a bridge of the machine running the proof disappeared",
		);
		assert.equal(proof.status, 0, `${proof.stdout}\n${proof.stderr}`);
		assert.match(proof.stdout, /ALL PASSED/);
	});
});
