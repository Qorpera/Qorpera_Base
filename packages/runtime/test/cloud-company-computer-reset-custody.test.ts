import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("preserves exact stopped-outbox custody through Linux archive, root loss and restore, rejecting unsafe metadata and interference", async () => {
	const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
	const temporary = await mkdtemp(join(tmpdir(), "reset-custody-test-"));
	try {
		await build({
			entryPoints: [join(root, "packages/runtime/test/fixtures/company-computer-reset-custody-probe.ts")],
			outfile: join(temporary, "probe.mjs"),
			bundle: true,
			platform: "node",
			format: "esm",
			target: "node22",
			tsconfig: join(root, "tsconfig.json"),
			alias: { "@qorpera/contracts": join(root, "packages/contracts/src/index.ts") },
		});
		// Cached image only; disabled networking, no host filesystem access beyond
		// the read-only test bundle. Docker volume/root is disposable --rm state.
		const output = execFileSync(
			"docker",
			[
				"run",
				"--rm",
				"--pull=never",
				"--network",
				"none",
				"--read-only",
				"--tmpfs",
				"/tmp:rw,nosuid,nodev,size=256m",
				"-v",
				`${temporary}:/probe:ro`,
				"node:22-bookworm-slim",
				"node",
				"/probe/probe.mjs",
			],
			{ encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024 },
		);
		const proof = JSON.parse(output.trim());
		expect(proof.checks).toBeGreaterThanOrEqual(20);
		expect(proof.recoveredPrefixFsyncOrdering).toBe(true);
		expect(proof.powerLossDurabilityProof).toBe(false);
		expect(proof.realLinuxFilesystem).toBe(true);
		expect(proof.originalBytesAndHistoricalStartupPreserved).toBe(true);
		expect(proof.actualResetWorker).toBe(false);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}, 90000);
