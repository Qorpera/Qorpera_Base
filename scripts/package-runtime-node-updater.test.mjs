import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("node updater package is reproducible and cannot run outside its enrolled root service", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "qorpera-node-updater-package-"));
	try {
		const roots = [join(temporary, "first"), join(temporary, "second")];
		for (const root of roots) {
			const built = spawnSync(process.execPath, ["scripts/package-runtime-node-updater.mjs", "--out", root], { cwd: resolve("."), encoding: "utf8", timeout: 60000 });
			assert.equal(built.status, 0, built.stderr);
			const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
			assert.equal(manifest.schema, "qorpera.node-updater-package/v1");
			assert.deepEqual(manifest.artifacts.map((a) => a.file), ["qorpera-node-updater.cjs", "qorpera-node-updater.service", "qorpera-node-updater.timer"]);
			for (const artifact of manifest.artifacts) {
				const bytes = await readFile(join(root, artifact.file));
				assert.equal(bytes.length, artifact.bytes); assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
			}
			const entry = join(root, "qorpera-node-updater.cjs"), help = spawnSync(process.execPath, ["--jitless", "--disable-proto=throw", "--disallow-code-generation-from-strings", entry, "--help"], { encoding: "utf8", timeout: 10000 });
			assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /process-owned kernel flock/);
			const untrusted = spawnSync(process.execPath, [entry, "--once", "--config", "/etc/qorpera/node-updater/service.json"], { encoding: "utf8", timeout: 10000 });
			assert.equal(untrusted.status, 1); assert.match(untrusted.stderr, /^NODE_UPDATE_ENROLLED_ROOT_SERVICE_REQUIRED\n$/);
		}
		assert.equal(await readFile(join(roots[0], "manifest.json"), "utf8"), await readFile(join(roots[1], "manifest.json"), "utf8"));
	} finally { await rm(temporary, { recursive: true, force: true }); }
});
