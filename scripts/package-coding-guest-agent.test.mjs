import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function packageAgent(output) {
	return spawnSync(process.execPath, ["scripts/package-coding-guest-agent.mjs", "--out", output], {
		cwd: repositoryRoot,
		encoding: "utf-8",
	});
}

test("packages the coding guest agent as one pinned file that runs on its own", async () => {
	const root = await mkdtemp(join(tmpdir(), "qorpera-coding-guest-agent-package-test-"));
	try {
		const output = join(root, "out");
		const packaged = packageAgent(output);
		assert.equal(packaged.status, 0, packaged.stderr);
		assert.equal((await stat(output)).mode & 0o777, 0o700);
		assert.deepEqual((await readdir(output)).sort(), ["agent.mjs", "manifest.json"]);
		const agent = await readFile(join(output, "agent.mjs"));
		const sha256 = createHash("sha256").update(agent).digest("hex");
		assert.ok(agent.length <= 262144, `agent is ${agent.length} bytes`);
		assert.deepEqual(JSON.parse(await readFile(join(output, "manifest.json"), "utf-8")), {
			schema: "qorpera.coding-guest-agent-package/v1",
			artifacts: [
				{
					file: "agent.mjs",
					source: "packages/runtime/src/cloud-coding-guest-agent.ts",
					installedPath: "/opt/qorpera-guest/agent.mjs",
					owner: "root:root",
					mode: "0444",
					sha256,
					bytes: agent.length,
				},
			],
			installationPerformed: false,
		});
		assert.deepEqual(JSON.parse(packaged.stdout), { output, agentSha256: sha256, bytes: agent.length });
		// Nothing is left to resolve in the guest, which has no node_modules.
		assert.doesNotMatch(agent.toString("utf-8"), /["']@qorpera\//);
		// The bundled file is still its own entry: an unknown verb gets one refusal line, and the agent exits 0.
		const ran = spawnSync(process.execPath, [join(output, "agent.mjs"), "exec"], { input: "", encoding: "utf-8" });
		assert.equal(ran.status, 0, ran.stderr);
		assert.equal(ran.stdout, '{"schema":"qorpera.coding-guest-refusal/v1","code":"CODING_GUEST_ARGUMENTS_INVALID"}\n');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("never packages into a directory that already exists, and takes only --out", async () => {
	const root = await mkdtemp(join(tmpdir(), "qorpera-coding-guest-agent-package-test-"));
	try {
		assert.notEqual(packageAgent(root).status, 0);
		assert.deepEqual(await readdir(root), []);
		const usage = spawnSync(process.execPath, ["scripts/package-coding-guest-agent.mjs", join(root, "out")], {
			cwd: repositoryRoot,
			encoding: "utf-8",
		});
		assert.notEqual(usage.status, 0);
		assert.match(usage.stderr, /Usage: package-coding-guest-agent\.mjs --out <new-directory>/);
		assert.deepEqual(await readdir(root), []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
