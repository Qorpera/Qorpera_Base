// deploy/agent-exit: the installer pins, the connection logger's parsers, and (on Linux with Docker) the root proof in
// test/proof.sh, run inside a privileged, network-less throwaway container that plays a node. Nothing touches the
// host's network: every namespace, bridge and rule lives inside the container.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const logger = join(here, "qorpera-agent-exit-log.py");
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
