// deploy/agent-exit: the installer pins, the connection logger's parsers, the agent plug's client map and reconciler
// (against a stand-in for LXD), and (on Linux with Docker) the root proof in test/proof.sh, run inside a privileged,
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
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const logger = join(here, "qorpera-agent-exit-log.py");
const plugTool = join(here, "qorpera-agent-plug.py");
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
				"ipv4.address": e.address,
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
