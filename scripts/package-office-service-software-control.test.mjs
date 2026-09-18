import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
test("packages both pinned temporary software tools with independent digests and safe CLI refusals", async () => {
	const temporary = await mkdtemp(join(tmpdir(), "qorpera-office-software-control-"));
	try {
		const output = join(temporary, "package");
		const built = spawnSync(process.execPath, ["scripts/package-office-service-software-control.mjs", "--out", output], { cwd: root, timeout: 120000, encoding: "utf8" });
		assert.equal(built.status, 0, built.stderr);
		const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
		assert.equal(manifest.schema, "qorpera.office-software-control-package/v2");
		assert.equal(manifest.historicalOfficeImageUnchanged, true);
		assert.deepEqual(manifest.artifacts.map((artifact) => [artifact.purpose, artifact.file, artifact.path, artifact.mode]), [
			["install", "software-control.mjs", "/run/qorpera-office-preparation/software-control.mjs", 256],
			["measure", "software-measurement-control.mjs", "/run/qorpera-office-preparation/software-measurement-control.mjs", 256],
		]);
		assert.equal(new Set(manifest.artifacts.map((artifact) => artifact.sha256)).size, 2);
		for (const artifact of manifest.artifacts) {
			const bytes = await readFile(join(output, artifact.file));
			assert.equal(bytes.length, artifact.bytes);
			assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
			assert.equal((await stat(join(output, artifact.file))).mode & 0o777, 0o400);
			const help = spawnSync(process.execPath, [join(output, artifact.file), "--help"], { cwd: temporary, encoding: "utf8", timeout: 20000, env: {} });
			assert.equal(help.status, 0, help.stderr);
			assert.match(help.stdout, /^Pinned temporary root software/);
			for (const invalid of [[], ["unexpected"], ["--locked"], ["a", "b", "c", "d", "e", "f"]]) {
				const refused = spawnSync(process.execPath, [join(output, artifact.file), ...invalid], { cwd: temporary, encoding: "utf8", timeout: 20000, env: {} });
				assert.equal(refused.status, 1);
				assert.equal(refused.stdout, "");
				assert.equal(refused.stderr, artifact.purpose === "install" ? "OFFICE_SOFTWARE_CONTROL_UNCONFIRMED\n" : "OFFICE_SOFTWARE_MEASUREMENT_UNCONFIRMED\n");
			}
		}
		const again = spawnSync(process.execPath, ["scripts/package-office-service-software-control.mjs", "--out", output], { cwd: root, timeout: 120000, encoding: "utf8" });
		assert.notEqual(again.status, 0);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});
