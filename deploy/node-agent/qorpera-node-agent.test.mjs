import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildRelease } from "./make-release.mjs";
import { NodeAgent, roleChanged, withNodeLock } from "./qorpera-node-agent.mjs";

const keys = generateKeyPairSync("ed25519");
const privatePem = keys.privateKey.export({ type: "pkcs8", format: "pem" });
const publicPem = keys.publicKey.export({ type: "spki", format: "pem" });
const bundle = (character) => character.repeat(64);
const OLD_PROVIDER = "qorpera-native25-phql-provider.service";
const UNITS = { provider: "qorpera-node-provider.service", orchestrator: "qorpera-node-orchestrator.service" };

async function nodeFixture() {
	const root = await mkdtemp(join(tmpdir(), "qorpera-node-agent-"));
	await mkdir(join(root, "etc/qorpera-node/keys"), { recursive: true });
	await writeFile(join(root, "etc/qorpera-node/keys/release.pem"), publicPem);
	await writeFile(
		join(root, "etc/qorpera-node/node.json"),
		JSON.stringify({
			schema: "qorpera.node/v1",
			restartOrder: ["provider", "orchestrator"],
			pauseDeferredRoles: ["orchestrator"],
			roles: {
				provider: { unit: UNITS.provider, exec: ["/usr/bin/node", "--jitless"], health: ["http://p/healthz"] },
				orchestrator: { unit: UNITS.orchestrator, exec: ["/usr/bin/node", "--jitless"], health: [] },
			},
		}),
	);
	const agentRoot = join(root, "opt/qorpera-node");
	const state = {
		running: [],
		runningAfterChecks: null,
		instanceChecks: 0,
		restarts: [],
		unhealthyRevision: null,
		launcherPolls: 0,
		pid: 100,
		units: { [OLD_PROVIDER]: { enabled: true, active: true, pid: 99 } },
		conflicts: { [UNITS.provider]: [OLD_PROVIDER], [UNITS.orchestrator]: [] },
		restartFailsAfter: null,
	};
	const polls = new Map();
	const roleOf = (unit) => Object.entries(UNITS).find(([, name]) => name === unit)?.[0];
	// Like the launcher: a new unit's process first runs the python launcher, which then execs node with the program
	// of the release its role link names. The old unit runs its versioned file.
	const commandFor = async (unit, pid) => {
		if (unit === OLD_PROVIDER) return ["/usr/bin/node", "--jitless", "/opt/qorpera-native25-phql-a1/provider-v82p2.mjs"];
		const role = roleOf(unit);
		if ((polls.get(pid) ?? 0) <= state.launcherPolls) return ["/usr/bin/python3", "-I", "launch.py", role];
		const target = await readlink(join(agentRoot, "roles", role));
		const revision = target.slice("../releases/".length);
		const release = JSON.parse(await readFile(join(agentRoot, "releases", revision, "release.json"), "utf8"));
		return ["/usr/bin/node", "--jitless", join(agentRoot, "releases", revision, release.roles[role].component)];
	};
	const ports = {
		instances: async () => {
			state.instanceChecks++;
			if (state.runningAfterChecks && state.instanceChecks > state.runningAfterChecks.after)
				return state.runningAfterChecks.names.map((name) => ({ name, status: "Running" }));
			return state.running.map((name) => ({ name, status: "Running" }));
		},
		restart: async (unit) => {
			state.restarts.push(unit);
			if (state.restartFailsAfter !== null && state.restarts.length > state.restartFailsAfter)
				throw new Error(`systemctl restart ${unit} failed`);
			state.units[unit] = { enabled: state.units[unit]?.enabled ?? false, active: true, pid: ++state.pid };
		},
		enable: async (unit, now) => {
			const current = state.units[unit];
			state.units[unit] = {
				enabled: true,
				active: now || (current?.active ?? false),
				pid: now && !current?.active ? ++state.pid : current?.pid,
			};
		},
		disable: async (unit, now) => {
			const current = state.units[unit];
			state.units[unit] = { enabled: false, active: !now && (current?.active ?? false), pid: now ? 0 : current?.pid };
		},
		isEnabled: async (unit) => state.units[unit]?.enabled ?? false,
		conflicts: async (unit) => state.conflicts[unit] ?? [],
		mainPid: async (unit) => {
			const current = state.units[unit];
			return current?.active ? current.pid : 0;
		},
		cmdline: async (pid) => {
			const unit = Object.entries(state.units).find(([, value]) => value.pid === pid)?.[0];
			polls.set(pid, (polls.get(pid) ?? 0) + 1);
			return commandFor(unit, pid);
		},
		healthy: async (url) => {
			const target = await readlink(join(agentRoot, "roles", url.includes("//p/") ? "provider" : "orchestrator"));
			return target !== `../releases/${state.unhealthyRevision}`;
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
		order = "either",
		roles = ["provider", "orchestrator"],
	}) => {
		const folder = join(root, `source-${sources++}`);
		await mkdir(folder);
		await writeFile(join(folder, "provider.mjs"), provider);
		await writeFile(join(folder, "orchestrator.mjs"), orchestrator);
		const out = join(root, `release-${sources++}`);
		const all = {
			provider: { component: "provider.mjs", env: { QORPERA_LXD_IMAGE_FINGERPRINT: bundle("f") } },
			orchestrator: { component: "orchestrator.mjs", env: {} },
		};
		await buildRelease(
			{
				revision,
				previousRevision,
				sourceCommit: "c".repeat(40),
				runtimeBundleSha256: bundle(runtime),
				order,
				files: { "provider.mjs": join(folder, "provider.mjs"), "orchestrator.mjs": join(folder, "orchestrator.mjs") },
				roles: Object.fromEntries(Object.entries(all).filter(([role]) => roles.includes(role))),
			},
			privatePem,
			out,
		);
		return out;
	};
	const link = (name) => readlink(join(agentRoot, name));
	const close = async () => {
		for (const name of await readdir(join(agentRoot, "releases")).catch(() => []))
			await chmod(join(agentRoot, "releases", name), 0o755).catch(() => undefined);
		await rm(root, { recursive: true, force: true });
	};
	return { root, agentRoot, agent, state, release, link, close };
}

async function adopted(node, { switched = true } = {}) {
	await node.agent.stage(await node.release({ revision: 0, previousRevision: null }));
	await node.agent.adopt(0);
	// Every role already runs under its new unit, as after the migration.
	if (switched)
		for (const unit of Object.values(UNITS)) node.state.units[unit] = { enabled: true, active: true, pid: ++node.state.pid };
}

async function staged(node, revision, options = {}) {
	await node.agent.stage(await node.release({ revision, previousRevision: revision - 1, ...options }));
}

const journal = (node) => readdir(join(node.root, "var/lib/qorpera-node-agent/journal"));
const lastRecord = async (node, pattern) => {
	const name = (await journal(node))
		.filter((entry) => pattern.test(entry))
		.sort()
		.at(-1);
	return JSON.parse(await readFile(join(node.root, "var/lib/qorpera-node-agent/journal", name), "utf8"));
};

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
		assert.equal(await node.link("roles/provider"), "../releases/0");
		assert.equal(await node.link("roles/orchestrator"), "../releases/0");

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

test("refuses a release folder whose signed revision is not its name", async () => {
	const node = await nodeFixture();
	try {
		await adopted(node);
		await staged(node, 1, { provider: "p1" });
		await chmod(join(node.agentRoot, "releases/1"), 0o755);
		await rm(join(node.agentRoot, "releases/1"), { recursive: true });
		await cp(join(node.agentRoot, "releases/0"), join(node.agentRoot, "releases/1"), { recursive: true });
		await assert.rejects(node.agent.apply(1), /RELEASE_FOLDER_HOLDS 0 NOT 1/);
		await chmod(join(node.agentRoot, "releases/1"), 0o755);
	} finally {
		await node.close();
	}
});

test("applies a release in place and waits for the launcher to exec before checking the command", async () => {
	const node = await nodeFixture();
	try {
		await adopted(node);
		await staged(node, 1, { provider: "p1" });
		node.state.launcherPolls = 3;
		const result = await node.agent.apply(1);
		assert.deepEqual(result.restarted, ["provider"]);
		assert.deepEqual(node.state.restarts, [UNITS.provider]);
		assert.equal(await node.link("current"), "releases/1");
		assert.equal(await node.link("previous"), "releases/0");
		assert.equal(await node.link("roles/provider"), "../releases/1");
		assert.equal(await node.link("roles/orchestrator"), "../releases/0");
		assert.ok((await journal(node)).some((name) => /-apply-receipt-r1-/.test(name)));
	} finally {
		await node.close();
	}
});

test("refuses while a run or login machine runs, and re-checks before each role", async () => {
	const node = await nodeFixture();
	try {
		await adopted(node);
		await staged(node, 1, { provider: "p1", orchestrator: "o1" });
		node.state.running = ["qorpera-exec-node02", `qorpera-login-${"a".repeat(32)}`];
		await assert.rejects(node.agent.apply(1), /NODE_NOT_QUIET qorpera-login-a+/);
		assert.equal(await node.link("current"), "releases/0");
		node.state.running = ["qorpera-exec-node02"];
		// Quiet for the gate and the provider; a run machine starts before the orchestrator's turn.
		node.state.instanceChecks = 0;
		node.state.runningAfterChecks = { after: 2, names: [`qorpera-${"c".repeat(32)}`] };
		await assert.rejects(node.agent.apply(1), /NODE_NOT_QUIET/);
		assert.equal(await node.link("roles/orchestrator"), "../releases/0");
	} finally {
		await node.close();
	}
});

test("a machine that starts during an apply stops it where it is, without a rollback", async () => {
	const node = await nodeFixture();
	try {
		await adopted(node);
		await staged(node, 1, { provider: "p1", orchestrator: "o1" });
		node.state.runningAfterChecks = { after: 2, names: [`qorpera-login-${"d".repeat(32)}`] };
		await assert.rejects(node.agent.apply(1), /APPLY_STOPPED_NOT_QUIET NODE_NOT_QUIET/);
		assert.equal(await node.link("current"), "releases/1");
		assert.equal(await node.link("roles/provider"), "../releases/1");
		assert.equal(await node.link("roles/orchestrator"), "../releases/0");
		assert.deepEqual(node.state.restarts, [UNITS.provider]);
		node.state.runningAfterChecks = null;
		assert.deepEqual(await node.agent.restart("orchestrator"), { restarted: "orchestrator", revision: 1, from: 0 });
	} finally {
		await node.close();
	}
});

test("a rollback whose restart fails leaves a receipt", async () => {
	const node = await nodeFixture();
	try {
		await adopted(node);
		await staged(node, 1, { provider: "p1" });
		node.state.unhealthyRevision = 1;
		node.state.restartFailsAfter = 1;
		await assert.rejects(node.agent.apply(1), /APPLY_ROLLBACK_FAILED ROLE_HEALTH provider .*; systemctl restart/);
		const receipt = await lastRecord(node, /-apply-receipt-r1-/);
		assert.equal(receipt.state, "rollback-failed");
		assert.deepEqual(receipt.onNew, ["provider"]);
	} finally {
		await node.close();
	}
});

test("a release with a pause must defer the pause-deferred roles, and --defer names are checked", async () => {
	const node = await nodeFixture();
	try {
		await adopted(node);
		await staged(node, 1, { provider: "p1", orchestrator: "o1", order: "pause" });
		await assert.rejects(node.agent.apply(1), /APPLY_PAUSE_REQUIRES_DEFER orchestrator/);
		await assert.rejects(node.agent.apply(1, { defer: ["orchestrater"] }), /DEFER_UNKNOWN_ROLES orchestrater/);
		assert.deepEqual(await node.agent.apply(1, { defer: ["orchestrator"] }), {
			applied: 1,
			restarted: ["provider"],
			deferred: ["orchestrator"],
		});
		// A systemd restart of the deferred orchestrator still starts its old release: its link did not move.
		assert.equal(await node.link("roles/orchestrator"), "../releases/0");
		await staged(node, 2, { provider: "p2", orchestrator: "o1" });
		await assert.rejects(node.agent.apply(2), /APPLY_ROLES_STILL_DEFERRED orchestrator/);
		assert.deepEqual(await node.agent.restart("orchestrator"), { restarted: "orchestrator", revision: 1, from: 0 });
		assert.equal(await node.link("roles/orchestrator"), "../releases/1");
		assert.deepEqual((await node.agent.apply(2)).restarted, ["provider"]);
	} finally {
		await node.close();
	}
});

test("a failed check rolls back by itself when the release keeps the runtime bundle", async () => {
	const node = await nodeFixture();
	try {
		await adopted(node);
		await staged(node, 1, { provider: "p1" });
		await node.agent.apply(1);
		await staged(node, 2, { provider: "p2" });
		node.state.unhealthyRevision = 2;
		await assert.rejects(node.agent.apply(2), /APPLY_ROLLED_BACK ROLE_HEALTH provider/);
		assert.equal(await node.link("current"), "releases/1");
		assert.equal(await node.link("previous"), "releases/0");
		assert.equal(await node.link("roles/provider"), "../releases/1");
		assert.deepEqual(node.state.restarts.slice(-2), [UNITS.provider, UNITS.provider]);
	} finally {
		await node.close();
	}
});

test("a failed check with a new runtime bundle stops without rolling back: that is a release decision", async () => {
	const node = await nodeFixture();
	try {
		await adopted(node);
		await staged(node, 1, { provider: "p1", runtime: "b" });
		node.state.unhealthyRevision = 1;
		await assert.rejects(node.agent.apply(1), /APPLY_FAILED_NO_AUTOMATIC_ROLLBACK ROLE_HEALTH provider/);
		assert.equal(await node.link("current"), "releases/1");
		assert.ok((await journal(node)).some((name) => /-apply-receipt-r1-/.test(name)));
	} finally {
		await node.close();
	}
});

test("gc keeps every release a role still runs and prunes the records of the releases it deletes", async () => {
	const node = await nodeFixture();
	try {
		await adopted(node);
		await staged(node, 1, { provider: "p1", orchestrator: "o1" });
		await node.agent.apply(1);
		await staged(node, 2, { provider: "p2", orchestrator: "o1" });
		await node.agent.apply(2);
		await staged(node, 3, { provider: "p3", orchestrator: "o3", order: "pause" });
		await node.agent.apply(3, { defer: ["orchestrator"] });
		// The deferred orchestrator still runs release 1; previous is 2; current is 3. Only release 0 goes.
		const result = await node.agent.gc();
		assert.deepEqual(result.removed, [0]);
		assert.ok(result.prunedRecords >= 1);
		assert.deepEqual((await readdir(join(node.agentRoot, "releases"))).sort(), ["1", "2", "3"]);
		assert.ok(!(await journal(node)).some((name) => /-r0-/.test(name)));
	} finally {
		await node.close();
	}
});

test("rolls back on request and records a rollback that fails", async () => {
	const node = await nodeFixture();
	try {
		await adopted(node);
		await staged(node, 1, { provider: "p1" });
		await node.agent.apply(1);
		assert.deepEqual(await node.agent.rollback(), { rolledBackTo: 0, restarted: ["provider"], deferred: [] });
		assert.equal(await node.link("current"), "releases/0");
		assert.equal(await node.link("previous"), "releases/1");
		assert.equal(await node.link("roles/provider"), "../releases/0");
		node.state.unhealthyRevision = 1;
		await assert.rejects(node.agent.rollback(), /ROLLBACK_FAILED ROLE_HEALTH provider/);
		assert.ok((await journal(node)).some((name) => /-rollback-receipt-r1-/.test(name)));
	} finally {
		await node.close();
	}
});

test("refuses a release that lacks a role this node runs", async () => {
	const node = await nodeFixture();
	try {
		await adopted(node);
		await staged(node, 1, { roles: ["provider"] });
		await assert.rejects(node.agent.apply(1), /APPLY_RELEASE_LACKS_ROLES orchestrator/);
		assert.equal(await node.link("current"), "releases/0");
		assert.deepEqual(node.state.restarts, []);
	} finally {
		await node.close();
	}
});

test("switches a role from its old unit to its new one and back, checking each unit's command", async () => {
	const node = await nodeFixture();
	try {
		await adopted(node, { switched: false });
		await staged(node, 1, { provider: "p1" });
		await assert.rejects(node.agent.apply(1), /ROLES_NOT_SWITCHED provider,orchestrator/);
		await assert.rejects(node.agent.unswitch("provider", OLD_PROVIDER), /UNSWITCH_NO_SWITCH_FROM/);
		node.state.launcherPolls = 2;
		const result = await node.agent.switch("provider", OLD_PROVIDER);
		const oldCommand = ["/usr/bin/node", "--jitless", "/opt/qorpera-native25-phql-a1/provider-v82p2.mjs"];
		assert.deepEqual(result.before, oldCommand);
		assert.deepEqual(result.after, ["/usr/bin/node", "--jitless", join(node.agentRoot, "releases/0/provider.mjs")]);
		assert.deepEqual(node.state.units[OLD_PROVIDER], { enabled: false, active: false, pid: 0 });
		assert.equal(node.state.units[UNITS.provider].enabled, true);
		assert.equal(node.state.units[UNITS.provider].active, true);
		await assert.rejects(node.agent.switch("provider", OLD_PROVIDER), /SWITCH_ALREADY_SWITCHED provider/);
		// Half the node switched: releases still do not apply.
		await assert.rejects(node.agent.apply(1), /ROLES_NOT_SWITCHED orchestrator/);
		assert.deepEqual((await node.agent.unswitch("provider", OLD_PROVIDER)).command, oldCommand);
		assert.equal(node.state.units[OLD_PROVIDER].enabled, true);
		assert.equal(node.state.units[OLD_PROVIDER].active, true);
		assert.equal(node.state.units[UNITS.provider].enabled, false);
		assert.equal(node.state.units[UNITS.provider].active, false);
		assert.ok((await journal(node)).some((name) => /-unswitch-receipt-rnone-/.test(name)));
	} finally {
		await node.close();
	}
});

test("switches only away from a unit the new unit conflicts with", async () => {
	const node = await nodeFixture();
	try {
		await adopted(node, { switched: false });
		node.state.units["qorpera-native25-phql-orchestrator.service"] = { enabled: true, active: true, pid: 98 };
		await assert.rejects(
			node.agent.switch("provider", "qorpera-native25-phql-orchestrator.service"),
			/SWITCH_OLD_UNIT_NOT_CONFLICTED/,
		);
		assert.equal(node.state.units["qorpera-native25-phql-orchestrator.service"].active, true);
		assert.deepEqual(node.state.restarts, []);
	} finally {
		await node.close();
	}
});

test("a switch whose new unit fails its checks goes straight back to the old unit", async () => {
	const node = await nodeFixture();
	try {
		await adopted(node, { switched: false });
		node.state.unhealthyRevision = 0;
		await assert.rejects(node.agent.switch("provider", OLD_PROVIDER), /SWITCH_REVERTED ROLE_HEALTH provider/);
		assert.equal(node.state.units[OLD_PROVIDER].active, true);
		assert.equal(node.state.units[OLD_PROVIDER].enabled, true);
		assert.equal(node.state.units[UNITS.provider].active, false);
		assert.equal(node.state.units[UNITS.provider].enabled, false);
		node.state.unhealthyRevision = null;
		node.state.running = [`qorpera-${"b".repeat(32)}`];
		await assert.rejects(node.agent.switch("provider", OLD_PROVIDER), /NODE_NOT_QUIET/);
		assert.equal(node.state.units[OLD_PROVIDER].active, true);
	} finally {
		await node.close();
	}
});

test("a switch that cannot bring the old unit back records that and says so", async () => {
	const node = await nodeFixture();
	try {
		await adopted(node, { switched: false });
		node.state.unhealthyRevision = 0;
		const enable = node.agent.ports.enable;
		node.agent.ports.enable = async (unit, now) => {
			if (unit === OLD_PROVIDER) throw new Error("systemctl enable failed");
			return enable(unit, now);
		};
		await assert.rejects(node.agent.switch("provider", OLD_PROVIDER), /SWITCH_BACK_FAILED ROLE_HEALTH provider/);
		const receipt = await lastRecord(node, /-switch-receipt-rnone-/);
		assert.equal(receipt.state, "switch-back-failed");
	} finally {
		await node.close();
	}
});

test("refuses a lock file root does not own instead of trusting it", async () => {
	const folder = await mkdtemp(join(tmpdir(), "qorpera-node-lock-"));
	try {
		// The test runs unprivileged, so the lock file it creates is not root-owned and must be refused.
		let ran = false;
		await assert.rejects(
			withNodeLock(async () => {
				ran = true;
			}, join(folder, "qorpera-node-update.lock")),
			/NODE_LOCK_UNSAFE/,
		);
		assert.equal(ran, false);
	} finally {
		await rm(folder, { recursive: true, force: true });
	}
});

test("a role changes when its program or its release values change", () => {
	const release = (digest, env) => ({
		files: [{ name: "p.mjs", sha256: digest }],
		roles: { provider: { component: "p.mjs", env } },
	});
	assert.equal(roleChanged(release("1", { A: "x" }), release("1", { A: "x" }), "provider"), false);
	assert.equal(roleChanged(release("1", { A: "x" }), release("2", { A: "x" }), "provider"), true);
	assert.equal(roleChanged(release("1", { A: "x" }), release("1", { A: "y" }), "provider"), true);
	assert.equal(roleChanged(null, release("1", {}), "provider"), true);
});

test("the installer pins the agent and the launcher it installs", async () => {
	const here = new URL(".", import.meta.url);
	const installer = await readFile(new URL("install-node-agent.sh", here), "utf8");
	for (const [name, file] of [
		["AGENT", "qorpera-node-agent.mjs"],
		["LAUNCHER", "qorpera-node-launch.py"],
	]) {
		const digest = createHash("sha256")
			.update(await readFile(new URL(file, here)))
			.digest("hex");
		assert.ok(installer.includes(`EXPECTED_${name}_SHA256="${digest}"`), `installer pin for ${file} is stale`);
	}
});
