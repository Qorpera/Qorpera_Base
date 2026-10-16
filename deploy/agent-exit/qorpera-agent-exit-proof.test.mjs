// deploy/agent-exit: on Linux with Docker, the root proof in test/proof.sh, run inside a privileged, network-less
// throwaway container that plays a node. It is a file of its own so that `node --test` runs it beside
// qorpera-agent-exit.test.mjs. Every namespace, bridge, link and rule it makes lives inside the container's own network
// namespaces. It never loads or unloads a kernel module itself (the kernel loads nftables' and the bridge's modules on
// demand and keeps them) and changes no sysctl of the machine's own namespace; the test checks that the machine's
// bridges are all still there afterwards, and that the queue modules of E8c-2's server name checker were not loaded
// (the proof covers the exit without them; test/prove-names-vm.sh proves the checker in a throwaway VM). The one thing
// a proof must never do on a shared test machine is unload a module: `modprobe -r br_netfilter` also unloads `bridge`, which destroys every bridge on the machine (3 October, an
// E2b draft run bare on a test machine did that, not this proof).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

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
		// Nor load the queue modules of E8c-2's server name checker: the proof covers the exit without them (a queue rule,
		// even under nft -c, or a queue socket would load them on the machine's kernel).
		const queueModules = () => ["nft_queue", "nfnetlink_queue"].filter((name) => existsSync(`/sys/module/${name}`));
		const modulesBefore = queueModules();
		const proof = spawnSync(
			"docker",
			["run", "--rm", "--privileged", "--network", "none", "-v", `${here}:/w:ro`, image, "bash", "/w/test/proof.sh"],
			{ encoding: "utf8", timeout: 540_000 },
		);
		const after = bridges();
		assert.deepEqual(
			["docker0", "lxdbr0", "testmach0"].filter((name) => before.has(name) && !after.has(name)),
			[],
			"a bridge of the machine running the proof disappeared",
		);
		assert.deepEqual(
			queueModules().filter((name) => !modulesBefore.includes(name)),
			[],
			"the proof loaded a queue module on the machine running it",
		);
		assert.equal(proof.status, 0, `${proof.stdout}\n${proof.stderr}`);
		assert.match(proof.stdout, /ALL PASSED/);
	});
});
