import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { linuxRootProbeEnabled, runLinuxRootProbe } from "./fixtures/linux-root-probe.ts";

if (!linuxRootProbeEnabled)
	console.info(
		"Skipping Linux root filesystem probe: requires explicit QORPERA_LINUX_ROOT_PROBES=1 on a disposable Linux host with sudo and Bubblewrap.",
	);

it.runIf(linuxRootProbeEnabled)(
	"preserves exact stopped-outbox custody through Linux archive, root loss and restore, rejecting unsafe metadata and interference",
	async () => {
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
			const output = runLinuxRootProbe(join(temporary, "probe.mjs"));
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
	},
	90000,
);
