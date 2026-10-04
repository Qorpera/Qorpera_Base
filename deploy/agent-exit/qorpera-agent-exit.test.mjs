// deploy/agent-exit: the installer pins, the connection logger's parsers and pause, the logs' tender and counts, the
// agent plug's client map and reconciler (against a stand-in for LXD), and (on Linux with Docker) the root proof in
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
		assert.deepEqual(c.attributionAtStart, {});
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
		// next part, and the days from it are counted again: the address's traffic gets its company.
		assert.equal(counts(day).companies.unattributed.connections, 1);
		append(`clients-${day}.jsonl`, [machine("10.210.1.7", "cE", "mE", t0 + 350)]);
		const again = tend(t0 + 2 * DAY + 3600 * 7);
		assert.equal(again.status, 0, again.stderr);
		assert.ok(files().includes(`clients-${day}.p002.jsonl.gz`), files().join(" "));
		assert.equal(again.result.daysCounted, 2, "the first day and the next");
		assert.equal(counts(day).companies.cE.connections, 1);
		assert.equal(counts(day).companies.unattributed, undefined);
		assert.equal(counts(next).attributionAtStart["10.210.1.7"].company, "cE");
		const carried = JSON.parse(readFileSync(join(log, "attribution.json"), "utf8"));
		assert.equal(carried.through, next);
		assert.equal(carried.open["10.210.1.7"].company, "cE");
		assert.ok(carried.clientParts.includes(`clients-${day}.p002.jsonl.gz`));
		assert.equal(tend(t0 + 2 * DAY + 3600 * 8).result.daysCounted, 0, "counted once");
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

	test("over the cap the oldest parts go first; never the client history, the counts or an open file", () => {
		append(`flows-${third}.jsonl`, [opened("10.210.1.1", t0 + 2 * DAY + 50)]);
		const r = tend(t0 + 2 * DAY + 3600 * 9, "--cap-bytes", "1");
		assert.equal(r.status, 1, "still over a 1-byte cap: a problem");
		assert.match(r.result.problems[0], /over their cap, or the disk under its floor/);
		const lost = readFileSync(join(log, "lost.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		const order = lost.map((entry) => entry.file);
		assert.ok(order.every((name) => name.startsWith("flows-") || name.startsWith("dns-")), order.join(" "));
		assert.ok(files().includes(`clients-${day}.p001.jsonl.gz`) && files().includes(`clients-${day}.p002.jsonl.gz`));
		assert.ok(order.indexOf(`flows-${day}.p001.jsonl.gz`) < order.indexOf(`flows-${third}.p001.jsonl.gz`), "oldest first");
		assert.ok(lost.every((entry) => entry.reason === "over the cap" && entry.bytes > 0));
		assert.equal(lost.find((entry) => entry.file === `flows-${day}.p001.jsonl.gz`).day, day);
		for (const kept of [`counts-${day}.json`, `counts-${next}.json`, `flows-${third}.jsonl`, "attribution.json", "dns.log"])
			assert.ok(files().includes(kept), kept);
		assert.equal(JSON.parse(readFileSync(status, "utf8")).problems.length, 1);
		// The report says how many files went before their time, from the ledger as it is now.
		const report = JSON.parse(spawnSync("python3", [logsTool, "report", "--log-dir", log, "--json"], { encoding: "utf8" }).stdout);
		assert.equal(report.node.deletedEarly, lost.filter((entry) => [day, next].includes(entry.day)).length);
		assert.ok(report.node.deletedEarly > 0);
		// A late line for a day whose connection log lost parts: its numbers stay as first counted, and only who is
		// plugged in moves on.
		const before = counts(next).companies;
		append(`clients-${next}.jsonl`, [machine("10.210.1.8", "cF", "mF", t0 + DAY + 100)]);
		const late = tend(t0 + 2 * DAY + 3600 * 10);
		assert.equal(late.status, 0, late.stderr);
		assert.deepEqual(counts(next).companies, before);
		assert.match(counts(next).lateClientHistory, /not counted again/);
		assert.equal(JSON.parse(readFileSync(join(log, "attribution.json"), "utf8")).open["10.210.1.8"].company, "cF");
	});

	test("a count that fails keeps the client history it has not read, past 90 days, until it reads it", () => {
		const failing = mkdtempSync(join(dir, "failing-"));
		const second = t0 + DAY;
		writeFileSync(join(failing, `clients-${day}.jsonl`), lines([machine("10.210.1.1", "cA", "mA", t0 + 100)]));
		writeFileSync(join(failing, `flows-${day}.jsonl`), lines([opened("10.210.1.1", t0 + 200)]));
		writeFileSync(
			join(failing, `clients-${next}.jsonl`),
			lines([machine("10.210.1.1", "cA", "mA", second + 100, "unplugged"), machine("10.210.1.1", "cB", "mB", second + 200)]),
		);
		writeFileSync(join(failing, `flows-${next}.jsonl`), lines([opened("10.210.1.1", second + 300)]));
		// The first day's counts cannot be written: counting fails before it reads anything.
		mkdirSync(join(failing, `counts-${day}.json`));
		const run = () =>
			spawnSync("python3", [logsTool, "tend", "--log-dir", failing, "--status", join(failing, "s.json"), "--now", String(t0 + 100 * DAY), "--settle", "0", "--free-percent", "50"], { encoding: "utf8" });
		const failed = run();
		assert.equal(failed.status, 0, failed.stderr);
		assert.ok(JSON.parse(failed.stdout).countProblems.length > 0);
		const kept = readdirSync(failing);
		assert.ok(kept.includes(`clients-${day}.p001.jsonl.gz`) && kept.includes(`clients-${next}.p001.jsonl.gz`), kept.join(" "));
		assert.ok(!kept.includes(`flows-${day}.p001.jsonl.gz`), "the connection log expires all the same");
		rmSync(join(failing, `counts-${day}.json`), { recursive: true });
		const recovered = run();
		assert.equal(recovered.status, 0, recovered.stderr);
		assert.equal(JSON.parse(readFileSync(join(failing, "attribution.json"), "utf8")).open["10.210.1.1"].company, "cB");
		assert.ok(!readdirSync(failing).some((name) => name.startsWith("clients-")), "read now, and past 90 days");
	});

	test("a recount cut short goes on from where it stopped, keeping early-deleted days' numbers and unread history", () => {
		// Two days: the first plugs 10.210.1.1 in for cA; the second unplugs it and plugs it in for cB.
		const fixture = () => {
			const folder = mkdtempSync(join(dir, "replay-"));
			const second = t0 + DAY;
			writeFileSync(join(folder, `clients-${day}.jsonl`), lines([machine("10.210.1.1", "cA", "mA", t0 + 100)]));
			writeFileSync(join(folder, `flows-${day}.jsonl`), lines([opened("10.210.1.1", t0 + 200), opened("10.210.1.2", t0 + 300)]));
			writeFileSync(
				join(folder, `clients-${next}.jsonl`),
				lines([machine("10.210.1.1", "cA", "mA", second + 100, "unplugged"), machine("10.210.1.1", "cB", "mB", second + 200)]),
			);
			writeFileSync(join(folder, `flows-${next}.jsonl`), lines([opened("10.210.1.1", second + 300), opened("10.210.1.2", second + 400)]));
			return folder;
		};
		const run = (folder, now, ...extra) =>
			spawnSync("python3", [logsTool, "tend", "--log-dir", folder, "--status", join(folder, "s.json"), "--now", String(now), "--settle", "0", "--free-percent", "50", ...extra], { encoding: "utf8" });
		const read = (folder, name) => JSON.parse(readFileSync(join(folder, name), "utf8"));
		// A late line for the first day (10.210.1.2 was cC's) arrives while the second day's counts cannot be written.
		const lateAndCut = (folder) => {
			writeFileSync(join(folder, `clients-${day}.jsonl`), lines([machine("10.210.1.2", "cC", "mC", t0 + 250)]));
			mkdirSync(join(folder, `.counts-${next}.json.tmp`));
		};

		// Both days lost their connection log early (over the cap) after they were counted.
		const early = fixture();
		assert.equal(run(early, t0 + 2 * DAY + 3 * 3600).status, 0);
		const counted = read(early, `counts-${next}.json`).companies;
		assert.equal(counted.cB.connections, 1);
		run(early, t0 + 2 * DAY + 4 * 3600, "--cap-bytes", "1");
		assert.ok(!readdirSync(early).some((name) => name.startsWith("flows-")));
		lateAndCut(early);
		const cut = run(early, t0 + 2 * DAY + 5 * 3600);
		assert.ok(JSON.parse(cut.stdout).countProblems.length > 0, cut.stdout);
		assert.equal(read(early, "attribution.json").through, day, "the checkpoint moved on to the first day only");
		rmSync(join(early, `.counts-${next}.json.tmp`), { recursive: true });
		assert.equal(run(early, t0 + 2 * DAY + 6 * 3600).status, 0);
		assert.deepEqual(read(early, `counts-${next}.json`).companies, counted, "never counted again from what is left");
		assert.match(read(early, `counts-${next}.json`).lateClientHistory, /not counted again/);
		const carried = read(early, "attribution.json");
		assert.equal(carried.through, next);
		assert.deepEqual([carried.open["10.210.1.1"].company, carried.open["10.210.1.2"].company], ["cB", "cC"]);

		// The same recount cut short after 90 days: the second day's history is not in the checkpoint, so it stays.
		const old = fixture();
		assert.equal(run(old, t0 + 2 * DAY + 3 * 3600).status, 0);
		lateAndCut(old);
		const far = t0 + 100 * DAY;
		run(old, far);
		assert.equal(read(old, "attribution.json").through, day);
		assert.ok(readdirSync(old).includes(`clients-${next}.p001.jsonl.gz`), readdirSync(old).join(" "));
		assert.ok(!readdirSync(old).includes(`clients-${day}.p001.jsonl.gz`), "the first day's history is in the checkpoint");
		rmSync(join(old, `.counts-${next}.json.tmp`), { recursive: true });
		assert.equal(run(old, far).status, 0);
		assert.equal(read(old, "attribution.json").open["10.210.1.1"].company, "cB", "cA's unplug and cB's plug were kept");
		assert.ok(!readdirSync(old).some((name) => name.startsWith("clients-")), "read now, and past 90 days");

		// Cut short on the first day counted again, past 90 days: the rewind is on disk first, so the expiry after it
		// keeps both days' history and the counts the recount starts from.
		const first = fixture();
		assert.equal(run(first, t0 + 2 * DAY + 3 * 3600).status, 0);
		writeFileSync(join(first, `clients-${day}.jsonl`), lines([machine("10.210.1.2", "cC", "mC", t0 + 250)]));
		mkdirSync(join(first, `.counts-${day}.json.tmp`));
		run(first, far);
		assert.equal(read(first, "attribution.json").through, "2026-08-31", "back to the day before the first late one");
		for (const kept of [`clients-${day}.p001.jsonl.gz`, `clients-${day}.p002.jsonl.gz`, `clients-${next}.p001.jsonl.gz`, `counts-${day}.json`, `counts-${next}.json`])
			assert.ok(readdirSync(first).includes(kept), `${kept}: ${readdirSync(first).join(" ")}`);
		rmSync(join(first, `.counts-${day}.json.tmp`), { recursive: true });
		assert.equal(run(first, far).status, 0);
		const recovered = read(first, "attribution.json");
		assert.deepEqual([recovered.open["10.210.1.1"].company, recovered.open["10.210.1.2"].company], ["cB", "cC"]);
		assert.deepEqual(recovered.lateUnapplied, []);
		assert.ok(!readdirSync(first).some((name) => name.startsWith("clients-") || name === `counts-${day}.json`));
	});

	test("late history for a day whose counts are gone is marked unapplied, and no good numbers are counted again", () => {
		const gone = mkdtempSync(join(dir, "gone-"));
		writeFileSync(join(gone, `clients-${day}.jsonl`), lines([machine("10.210.1.1", "cA", "mA", t0 + 100)]));
		writeFileSync(join(gone, `flows-${day}.jsonl`), lines([opened("10.210.1.1", t0 + 200)]));
		writeFileSync(join(gone, `flows-${next}.jsonl`), lines([opened("10.210.1.1", t0 + DAY + 300), opened("10.210.1.2", t0 + DAY + 400)]));
		const run = (now) =>
			spawnSync("python3", [logsTool, "tend", "--log-dir", gone, "--status", join(gone, "s.json"), "--now", String(now), "--settle", "0", "--free-percent", "50"], { encoding: "utf8" });
		assert.equal(run(t0 + 2 * DAY + 3 * 3600).status, 0);
		const second = readFileSync(join(gone, `counts-${next}.json`), "utf8");
		// The first day's counts are gone (as after 90 days); a late line for it cannot be applied exactly.
		rmSync(join(gone, `counts-${day}.json`));
		writeFileSync(join(gone, `clients-${day}.jsonl`), lines([machine("10.210.1.2", "cC", "mC", t0 + 250)]));
		const r = run(t0 + 2 * DAY + 4 * 3600);
		assert.equal(r.status, 0, r.stderr);
		assert.equal(JSON.parse(r.stdout).daysCounted, 0);
		assert.equal(readFileSync(join(gone, `counts-${next}.json`), "utf8"), second, "the second day's numbers stay");
		const carried = JSON.parse(readFileSync(join(gone, "attribution.json"), "utf8"));
		assert.deepEqual(carried.lateUnapplied, [`clients-${day}.p002.jsonl.gz`]);
		assert.ok(carried.clientParts.includes(`clients-${day}.p002.jsonl.gz`));
		assert.equal(carried.through, next);
		assert.equal(JSON.parse(run(t0 + 2 * DAY + 5 * 3600).stdout).daysCounted, 0, "once");
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
		const reasons = readFileSync(join(fresh, "lost.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line).reason);
		assert.deepEqual([...new Set(reasons)], ["kept 90 days", "the disk is low"]);
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
