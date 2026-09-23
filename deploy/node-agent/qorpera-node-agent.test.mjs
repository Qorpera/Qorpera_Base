import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildRelease } from "./make-release.mjs";
import { changedRoles, NodeAgent } from "./qorpera-node-agent.mjs";

const keys = generateKeyPairSync("ed25519");
const privatePem = keys.privateKey.export({ type: "pkcs8", format: "pem" });
const publicPem = keys.publicKey.export({ type: "spki", format: "pem" });
const bundle = (character) => character.repeat(64);
const OLD_PROVIDER = "qorpera-native25-phql-provider.service";

async function nodeFixture() {
	const root = await mkdtemp(join(tmpdir(), "qorpera-node-agent-"));
	await mkdir(join(root, "etc/qorpera-node/keys"), { recursive: true });
	await writeFile(join(root, "etc/qorpera-node/keys/release.pem"), publicPem);
	await writeFile(
		join(root, "etc/qorpera-node/node.json"),
		JSON.stringify({
			schema: "qorpera.node/v1",
			restartOrder: ["provider", "orchestrator"],
			roles: {
				provider: { unit: "qorpera-node-provider.service", exec: ["/usr/bin/node", "--jitless"], health: ["http://p/healthz"] },
				orchestrator: { unit: "qorpera-node-orchestrator.service", exec: ["/usr/bin/node", "--jitless"], health: [] },
			},
		}),
	);
	const agentRoot = join(root, "opt/qorpera-node");
	const state = {
		running: [],
		restarts: [],
		unhealthyRevision: null,
		pid: 100,
		units: { [OLD_PROVIDER]: { enabled: true, active: true } },
	};
	const commands = new Map();
	// Like the launcher: a new unit runs exec + the current release's program; the old unit its versioned file.
	const commandFor = async (unit) => {
		if (unit === OLD_PROVIDER) return ["/usr/bin/node", "--jitless", "/opt/qorpera-native25-phql-a1/provider-v82p2.mjs"];
		const target = await readlink(join(agentRoot, "current"));
		const release = JSON.parse(await readFile(join(agentRoot, target, "release.json"), "utf8"));
		const role = unit.includes("provider") ? "provider" : "orchestrator";
		return ["/usr/bin/node", "--jitless", join(agentRoot, target, release.roles[role].component)];
	};
	const ports = {
		instances: async () => state.running.map((name) => ({ name, status: "Running" })),
		restart: async (unit) => {
			state.restarts.push(unit);
			state.units[unit] = { enabled: state.units[unit]?.enabled ?? true, active: true };
		},
		enable: async (unit, now) => {
			state.units[unit] = { enabled: true, active: now || (state.units[unit]?.active ?? false) };
		},
		disable: async (unit, now) => {
			state.units[unit] = { enabled: false, active: !now && (state.units[unit]?.active ?? false) };
		},
		mainPid: async (unit) => {
			if (state.units[unit] && !state.units[unit].active) return 0;
			const pid = ++state.pid;
			commands.set(pid, await commandFor(unit));
			return pid;
		},
		cmdline: async (pid) => commands.get(pid),
		healthy: async () => {
			const target = await readlink(join(agentRoot, "current"));
			return target !== `releases/${state.unhealthyRevision}`;
		},
		journalSince: async () => "",
		sleep: async () => undefined,
	};
	const agent = new NodeAgent({ root, ports, owner: null });
	let sources = 0;
	const release = async ({
		revision,
		previousRevision,
		provider = "p0",
		orchestrator = "o0",
		runtime = "a",
		env = {},
		roles = ["provider", "orchestrator"],
	}) => {
		const folder = join(root, `source-${sources++}`);
		await mkdir(folder);
		await writeFile(join(folder, "provider.mjs"), provider);
		await writeFile(join(folder, "orchestrator.mjs"), orchestrator);
		const out = join(root, `release-${sources++}`);
		await buildRelease(
			{
				revision,
				previousRevision,
				sourceCommit: "c".repeat(40),
				runtimeBundleSha256: bundle(runtime),
				order: "either",
				files: { "provider.mjs": join(folder, "provider.mjs"), "orchestrator.mjs": join(folder, "orchestrator.mjs") },
				roles: Object.fromEntries(
					Object.entries({
						provider: { component: "provider.mjs", env: { QORPERA_LXD_IMAGE_FINGERPRINT: bundle("f"), ...env } },
						orchestrator: { component: "orchestrator.mjs", env: {} },
					}).filter(([role]) => roles.includes(role)),
				),
			},
			privatePem,
			out,
		);
		return out;
	};
	const close = async () => {
		for (const name of await readdir(join(agentRoot, "releases")).catch(() => []))
			await chmod(join(agentRoot, "releases", name), 0o755).catch(() => undefined);
		await rm(root, { recursive: true, force: true });
	};
	return { root, agentRoot, agent, state, release, close };
}

async function adopted(node) {
	await node.agent.stage(await node.release({ revision: 0, previousRevision: null }));
	await node.agent.adopt(0);
}

test("stages only a correctly signed, complete release that follows the current one", async () => {
	const node = await nodeFixture();
	try {
		const first = await node.release({ revision: 0, previousRevision: null });
		assert.deepEqual(await node.agent.stage(first), { staged: 0, already: false });
		assert.deepEqual(await node.agent.stage(first), { staged: 0, already: true });
		const folder = join(node.agentRoot, "releases/0");
		assert.equal((await lstat(folder)).mode & 0o777, 0o555);
		assert.equal((await lstat(join(folder, "provider.mjs"))).mode & 0o777, 0o444);
		await node.agent.adopt(0);

		const unsigned = await node.release({ revision: 1, previousRevision: 0 });
		await writeFile(join(unsigned, "release.sig"), Buffer.alloc(64).toString("base64"));
		await assert.rejects(node.agent.stage(unsigned), /RELEASE_SIGNATURE/);
		const tampered = await node.release({ revision: 1, previousRevision: 0 });
		await writeFile(join(tampered, "provider.mjs"), "changed");
		await assert.rejects(node.agent.stage(tampered), /RELEASE_FILE_MISMATCH provider.mjs/);
		const skipping = await node.release({ revision: 2, previousRevision: 1 });
		await assert.rejects(node.agent.stage(skipping), /STAGE_PREVIOUS expected 0 got 1/);
		assert.deepEqual(await readdir(join(node.agentRoot, "releases")), ["0"]);
	} finally {
		await node.close();
	}
});

test("applies a release in place: previous becomes the rollback, only changed roles restart", async () => {
	const node = await nodeFixture();
	try {
		await adopted(node);
		assert.deepEqual(node.state.restarts, []);
		await node.agent.stage(await node.release({ revision: 1, previousRevision: 0, provider: "p1" }));
		const result = await node.agent.apply(1);
		assert.deepEqual(result.restarted.map((entry) => entry.role), ["provider"]);
		assert.deepEqual(node.state.restarts, ["qorpera-node-provider.service"]);
		assert.equal(await readlink(join(node.agentRoot, "current")), "releases/1");
		assert.equal(await readlink(join(node.agentRoot, "previous")), "releases/0");
	} finally {
		await node.close();
	}
});

test("refuses while a run or login machine runs; the exec host does not count", async () => {
	const node = await nodeFixture();
	try {
		await adopted(node);
		await node.agent.stage(await node.release({ revision: 1, previousRevision: 0, provider: "p1" }));
		node.state.running = ["qorpera-exec-node02", `qorpera-login-${"a".repeat(32)}`];
		await assert.rejects(node.agent.apply(1), /NODE_NOT_QUIET qorpera-login-a+/);
		assert.equal(await readlink(join(node.agentRoot, "current")), "releases/0");
		node.state.running = ["qorpera-exec-node02"];
		await node.agent.apply(1);
		assert.equal(await readlink(join(node.agentRoot, "current")), "releases/1");
	} finally {
		await node.close();
	}
});

test("a failed check rolls back by itself when the release keeps the runtime bundle", async () => {
	const node = await nodeFixture();
	try {
		await adopted(node);
		await node.agent.stage(await node.release({ revision: 1, previousRevision: 0, provider: "p1" }));
		await node.agent.apply(1);
		await node.agent.stage(await node.release({ revision: 2, previousRevision: 1, provider: "p2" }));
		node.state.unhealthyRevision = 2;
		await assert.rejects(node.agent.apply(2), /APPLY_ROLLED_BACK ROLE_HEALTH provider/);
		assert.equal(await readlink(join(node.agentRoot, "current")), "releases/1");
		assert.equal(await readlink(join(node.agentRoot, "previous")), "releases/0");
		assert.deepEqual(node.state.restarts.slice(-2), ["qorpera-node-provider.service", "qorpera-node-provider.service"]);
	} finally {
		await node.close();
	}
});

test("a failed check with a new runtime bundle stops without rolling back: that is a release decision", async () => {
	const node = await nodeFixture();
	try {
		await adopted(node);
		await node.agent.stage(await node.release({ revision: 1, previousRevision: 0, provider: "p1", runtime: "b" }));
		node.state.unhealthyRevision = 1;
		await assert.rejects(node.agent.apply(1), /APPLY_FAILED_NO_AUTOMATIC_ROLLBACK ROLE_HEALTH provider/);
		assert.equal(await readlink(join(node.agentRoot, "current")), "releases/1");
		const journal = await readdir(join(node.root, "var/lib/qorpera-node-agent/journal"));
		assert.ok(journal.some((name) => name.includes("apply-receipt")));
	} finally {
		await node.close();
	}
});

test("a deferred role keeps its process until it is restarted after resume", async () => {
	const node = await nodeFixture();
	try {
		await adopted(node);
		await node.agent.stage(
			await node.release({ revision: 1, previousRevision: 0, provider: "p1", orchestrator: "o1" }),
		);
		const result = await node.agent.apply(1, { defer: ["orchestrator"] });
		assert.deepEqual(result.deferred, ["orchestrator"]);
		assert.deepEqual(node.state.restarts, ["qorpera-node-provider.service"]);
		await node.agent.restart("orchestrator");
		assert.deepEqual(node.state.restarts, ["qorpera-node-provider.service", "qorpera-node-orchestrator.service"]);
	} finally {
		await node.close();
	}
});

test("rolls back on request and collects releases older than previous", async () => {
	const node = await nodeFixture();
	try {
		await adopted(node);
		for (const revision of [1, 2]) {
			await node.agent.stage(
				await node.release({ revision, previousRevision: revision - 1, provider: `p${revision}` }),
			);
			await node.agent.apply(revision);
		}
		await node.agent.stage(await node.release({ revision: 3, previousRevision: 2, provider: "p3" }));
		assert.deepEqual(await node.agent.gc(), { removed: [0] });
		assert.deepEqual((await readdir(join(node.agentRoot, "releases"))).sort(), ["1", "2", "3"]);
		assert.deepEqual(await node.agent.rollback(), {
			rolledBackTo: 1,
			restarted: [{ role: "provider", pid: node.state.pid }],
		});
		assert.equal(await readlink(join(node.agentRoot, "current")), "releases/1");
		assert.equal(await readlink(join(node.agentRoot, "previous")), "releases/2");
	} finally {
		await node.close();
	}
});

test("refuses a release that lacks a role this node runs", async () => {
	const node = await nodeFixture();
	try {
		await adopted(node);
		await node.agent.stage(await node.release({ revision: 1, previousRevision: 0, roles: ["provider"] }));
		await assert.rejects(node.agent.apply(1), /APPLY_RELEASE_LACKS_ROLES orchestrator/);
		assert.equal(await readlink(join(node.agentRoot, "current")), "releases/0");
		assert.deepEqual(node.state.restarts, []);
	} finally {
		await node.close();
	}
});

test("switches a role from its old unit to its new one and records both command lines", async () => {
	const node = await nodeFixture();
	try {
		await adopted(node);
		const result = await node.agent.switch("provider", OLD_PROVIDER);
		assert.deepEqual(result.before, ["/usr/bin/node", "--jitless", "/opt/qorpera-native25-phql-a1/provider-v82p2.mjs"]);
		assert.deepEqual(result.after, ["/usr/bin/node", "--jitless", join(node.agentRoot, "releases/0/provider.mjs")]);
		assert.deepEqual(node.state.units[OLD_PROVIDER], { enabled: false, active: false });
		assert.deepEqual(node.state.units["qorpera-node-provider.service"], { enabled: true, active: true });
		await node.agent.unswitch("provider", OLD_PROVIDER);
		assert.deepEqual(node.state.units[OLD_PROVIDER], { enabled: true, active: true });
		assert.deepEqual(node.state.units["qorpera-node-provider.service"], { enabled: false, active: false });
	} finally {
		await node.close();
	}
});

test("a switch whose new unit fails its checks goes straight back to the old unit", async () => {
	const node = await nodeFixture();
	try {
		await adopted(node);
		node.state.unhealthyRevision = 0;
		await assert.rejects(node.agent.switch("provider", OLD_PROVIDER), /SWITCH_REVERTED ROLE_HEALTH provider/);
		assert.deepEqual(node.state.units[OLD_PROVIDER], { enabled: true, active: true });
		assert.deepEqual(node.state.units["qorpera-node-provider.service"], { enabled: false, active: false });
		node.state.running = [`qorpera-${"b".repeat(32)}`];
		node.state.unhealthyRevision = null;
		await assert.rejects(node.agent.switch("provider", OLD_PROVIDER), /NODE_NOT_QUIET/);
		assert.deepEqual(node.state.units[OLD_PROVIDER], { enabled: true, active: true });
	} finally {
		await node.close();
	}
});

test("a role changes when its program or its release values change", () => {
	const release = (digest, env) => ({
		files: [{ name: "p.mjs", sha256: digest }],
		roles: { provider: { component: "p.mjs", env } },
	});
	assert.deepEqual(changedRoles(release("1", { A: "x" }), release("1", { A: "x" }), ["provider"]), []);
	assert.deepEqual(changedRoles(release("1", { A: "x" }), release("2", { A: "x" }), ["provider"]), ["provider"]);
	assert.deepEqual(changedRoles(release("1", { A: "x" }), release("1", { A: "y" }), ["provider"]), ["provider"]);
	assert.deepEqual(changedRoles(null, release("1", {}), ["provider"]), ["provider"]);
});

test("the installer pins the agent, the launcher and the migration helper it installs", async () => {
	const here = new URL(".", import.meta.url);
	const installer = await readFile(new URL("install-node-agent.sh", here), "utf8");
	for (const [name, file] of [
		["AGENT", "qorpera-node-agent.mjs"],
		["LAUNCHER", "qorpera-node-launch.py"],
		["MIGRATE", "qorpera-node-migrate.py"],
	]) {
		const digest = createHash("sha256")
			.update(await readFile(new URL(file, here)))
			.digest("hex");
		assert.ok(installer.includes(`EXPECTED_${name}_SHA256="${digest}"`), `installer pin for ${file} is stale`);
	}
});
