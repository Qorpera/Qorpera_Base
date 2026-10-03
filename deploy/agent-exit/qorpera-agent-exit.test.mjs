// deploy/agent-exit: the installer pins, the connection logger's parsers, the agent plug's client map and reconciler
// (against a stand-in for LXD), and (on Linux with Docker) the root proof in test/proof.sh, run inside a privileged,
// network-less throwaway container that plays a node. Nothing touches the host's network: every namespace, bridge and
// rule lives inside the container.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
		for (const sub of ["clients", "dhcp-hosts", "quarantine", "seen"]) mkdirSync(join(state, sub), { recursive: true });
		mkdirSync(run);
		lxd = join(dir, "lxd.json");
		flushes = join(dir, "flushes");
		writeFileSync(lxd, "[]");
	});
	after(() => rmSync(dir, { recursive: true, force: true }));
	const dirs = () => ["--state-dir", state, "--run-dir", run, "--log-dir", log];
	const plug = (...args) => spawnSync("python3", [plugTool, "plug", ...dirs(), ...args], { encoding: "utf8" });
	const plugged = (...args) => {
		const r = plug(...args);
		assert.equal(r.status, 0, r.stderr);
		return JSON.parse(r.stdout);
	};
	const reconcile = () => {
		const r = spawnSync(
			"python3",
			[plugTool, "reconcile", "--once", ...dirs(), "--lxd-fixture", lxd, "--reload-dns", "true", "--flush-log", flushes],
			{ encoding: "utf8" },
		);
		assert.equal(r.status, 0, r.stderr);
		return JSON.parse(readFileSync(join(run, "plug.json"), "utf8"));
	};
	const entry = (address) => JSON.parse(readFileSync(join(state, "clients", `${address}.json`), "utf8"));
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
				"security.ipv4_filtering": "true",
				"security.ipv6_filtering": "true",
				"security.port_isolation": "true",
				...nic,
			},
		},
	});
	const history = () =>
		readdirSync(log)
			.filter((name) => name.startsWith("clients-"))
			.flatMap((name) => readFileSync(join(log, name), "utf8").trim().split("\n"))
			.map((line) => JSON.parse(line));
	const flushed = () => (existsSync(flushes) ? readFileSync(flushes, "utf8").trim().split("\n") : []);

	test("plug gives the lowest free address with its MAC and lease, and the same again for the same machine", () => {
		const first = plugged("--kind", "coding", "--company", "c1", "--machine", "m1", "--member", "u1", "--project", "qp", "--instance", "vm1");
		assert.deepEqual(first, { address: "10.210.0.2", hwaddr: "0e:51:0a:d2:00:02" });
		assert.deepEqual(
			plugged("--kind", "coding", "--company", "c1", "--machine", "m1", "--member", "u1", "--project", "qp", "--instance", "vm1"),
			first,
		);
		assert.equal(readFileSync(join(state, "dhcp-hosts", "10.210.0.2"), "utf8"), "0e:51:0a:d2:00:02,10.210.0.2\n");
		const e = entry("10.210.0.2");
		assert.deepEqual(
			{ ...e, since: undefined },
			{
				schema: "qorpera.agent-plug/v1",
				address: "10.210.0.2",
				hwaddr: "0e:51:0a:d2:00:02",
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
		assert.match(other.stderr, /qp\/vm1 is already plugged in for another machine \(10\.210\.0\.2\)/);
	});

	test("plug refuses unknown kinds, a member on anything but a coding machine, and names that are not ids", () => {
		for (const [args, message] of [
			[["--kind", "laptop", "--company", "c", "--machine", "m", "--project", "qp", "--instance", "x"], /invalid choice|kind must be/],
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
							"--kind",
							"machine",
							"--company",
							"c",
							"--machine",
							`race${i}`,
							"--project",
							"qp",
							"--instance",
							`race${i}`,
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
		const addresses = results.map((r) => JSON.parse(r.out).address);
		assert.equal(new Set(addresses).size, 12);
		const until = (seconds) => JSON.stringify({ until: Date.now() / 1000 + seconds });
		writeFileSync(join(state, "quarantine", "10.210.0.15"), until(900));
		writeFileSync(join(state, "quarantine", "10.210.0.16"), until(-1));
		assert.equal(plugged("--kind", "office", "--company", "c3", "--machine", "o3", "--project", "qp", "--instance", "vm3").address, "10.210.0.16");
	});

	test("the reconciler checks every plugged machine against LXD, and every machine on the bridge against the map", () => {
		const e = entry("10.210.0.2");
		const office = entry("10.210.0.16");
		writeFileSync(
			lxd,
			JSON.stringify([
				machine(e, { company: "c9" }),
				machine(office, { nic: { "security.port_isolation": "false" } }),
				{ name: "stray", project: "qp", status: "Stopped", expanded_config: {}, expanded_devices: { eth0: { type: "nic", parent: "qagent0" } } },
				{ name: "other", project: "qp", status: "Running", expanded_config: {}, expanded_devices: { eth0: { type: "nic", network: "qorpera0" } } },
			]),
		);
		const status = reconcile();
		assert.deepEqual(
			status.problems.filter((p) => !p.includes("is running, but its network card")),
			[
				"qp/stray is on qagent0 without a client map entry",
				"qp/vm1 (10.210.0.2): user.qorpera.company_id is 'c9', not 'c1'",
				"qp/vm3 (10.210.0.16): its card's security.port_isolation is 'false', not 'true'",
			],
		);
		// Running machines whose card is not a port of qagent0 (here: no such interface at all).
		assert.equal(status.problems.filter((p) => p.includes("is not a port of qagent0")).length, 2);
		const plugs = history().filter((r) => r.event === "plugged");
		assert.deepEqual(plugs.map((r) => r.address).sort(), ["10.210.0.16", "10.210.0.2"]);
		assert.equal(plugs.find((r) => r.address === "10.210.0.2").ts, Date.parse(e.since) / 1000);
	});

	test("a sleeping machine keeps its address and is flushed once; a deleted one is quarantined, then unplugged", () => {
		const e = entry("10.210.0.2");
		const office = entry("10.210.0.16");
		writeFileSync(lxd, JSON.stringify([machine(e, { status: "Stopped" }), machine(office, { status: "Stopped" })]));
		assert.deepEqual(reconcile().problems, []);
		reconcile();
		assert.deepEqual(flushed().sort(), ["10.210.0.16", "10.210.0.2"], "flushed once per sleep");
		assert.ok(existsSync(join(state, "clients", "10.210.0.2.json")));
		assert.ok(existsSync(join(state, "dhcp-hosts", "10.210.0.2")));
		writeFileSync(lxd, JSON.stringify([machine(office, { status: "Stopped" })]));
		assert.deepEqual(reconcile().problems, []);
		assert.ok(!existsSync(join(state, "clients", "10.210.0.2.json")));
		assert.ok(!existsSync(join(state, "dhcp-hosts", "10.210.0.2")));
		assert.ok(!existsSync(join(state, "seen", "10.210.0.2")));
		const quarantine = JSON.parse(readFileSync(join(state, "quarantine", "10.210.0.2"), "utf8"));
		assert.equal(quarantine.reason, "the machine is gone");
		assert.ok(quarantine.until > Date.now() / 1000 + 890);
		assert.deepEqual(flushed().filter((a) => a === "10.210.0.2").length, 2, "flushed again when unplugged");
		const gone = history().filter((r) => r.address === "10.210.0.2");
		assert.deepEqual(gone.map((r) => r.event), ["plugged", "unplugged"]);
		assert.equal(gone[1].company, "c1");
		assert.equal(
			plugged("--kind", "coding", "--company", "c1", "--machine", "m1", "--member", "u1", "--project", "qp", "--instance", "vm1").address !==
				"10.210.0.2",
			true,
			"a quarantined address is not given out again",
		);
	});

	test("a plug whose machine never appears is given up after an hour; expired quarantines are cleared", () => {
		const pending = readdirSync(join(state, "clients")).filter((n) => n.endsWith(".json") && n !== "10.210.0.16.json");
		assert.ok(pending.length > 0);
		reconcile();
		assert.equal(readdirSync(join(state, "clients")).filter((n) => n.endsWith(".json")).length, pending.length + 1, "not yet an hour");
		for (const name of pending) {
			const path = join(state, "clients", name);
			writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), since: "2000-01-01T00:00:00Z" }));
		}
		writeFileSync(join(state, "quarantine", "10.210.0.200"), JSON.stringify({ until: 1 }));
		reconcile();
		assert.deepEqual(
			readdirSync(join(state, "clients")).filter((n) => n.endsWith(".json")),
			["10.210.0.16.json"],
		);
		assert.ok(!existsSync(join(state, "quarantine", "10.210.0.200")));
		const lines = history().filter((r) => pending.includes(`${r.address}.json`));
		assert.equal(lines.filter((r) => r.event === "unplugged").length, pending.length);
		assert.equal(lines.filter((r) => r.event === "plugged").length, pending.length, "a plugged line even when never seen");
	});

	test("an unreadable LXD or entry is a problem, and LXD unreadable changes nothing", () => {
		writeFileSync(join(state, "clients", "10.210.0.99.json"), "{");
		writeFileSync(lxd, "not json");
		const before = readdirSync(join(state, "clients")).sort();
		const status = reconcile();
		assert.match(status.problems[0], /^cannot read LXD/);
		assert.deepEqual(readdirSync(join(state, "clients")).sort(), before);
		writeFileSync(lxd, "[]");
		assert.ok(reconcile().problems.some((p) => p.startsWith("unreadable client map entry 10.210.0.99.json")));
		rmSync(join(state, "clients", "10.210.0.99.json"));
	});

	test("conntrack lines from the exit become the node's twins: masqueraded TCP, UDP and ICMP only", () => {
		const lines = [
			"tcp      6 431999 ESTABLISHED src=10.210.0.2 dst=1.1.1.1 sport=40000 dport=443 src=1.1.1.1 dst=10.209.255.2 sport=443 dport=61000 [ASSURED] mark=0 use=1",
			"udp      17 25 src=10.210.0.2 dst=9.9.9.9 sport=5353 dport=53 src=10.210.0.1 dst=10.210.0.2 sport=53 dport=5353 mark=0 use=1",
			"udp      17 25 src=10.210.0.2 dst=8.8.4.4 sport=5000 dport=3478 src=8.8.4.4 dst=10.209.255.2 sport=3478 dport=5001 mark=0 use=1",
			"icmp     1 29 src=10.210.0.2 dst=1.1.1.1 type=8 code=0 id=7 src=1.1.1.1 dst=10.209.255.2 type=0 code=0 id=9 mark=0 use=1",
			"unknown  253 599 src=10.210.0.2 dst=1.1.1.1 src=1.1.1.1 dst=10.209.255.2 mark=0 use=1",
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

describe("the exit on a stand-in node", { skip: dockerUsable ? false : "needs Linux with Docker" }, () => {
	test("the root proof passes inside a privileged, network-less container", () => {
		const image = `qorpera-agent-exit-test:${sha256(DOCKERFILE).slice(0, 12)}`;
		if (spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" }).status !== 0) {
			const build = spawnSync("docker", ["build", "-t", image, "-"], { input: DOCKERFILE, encoding: "utf8" });
			assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
		}
		const proof = spawnSync(
			"docker",
			["run", "--rm", "--privileged", "--network", "none", "-v", `${here}:/w:ro`, image, "bash", "/w/test/proof.sh"],
			{ encoding: "utf8", timeout: 300_000 },
		);
		assert.equal(proof.status, 0, `${proof.stdout}\n${proof.stderr}`);
		assert.match(proof.stdout, /ALL PASSED/);
	});
});
