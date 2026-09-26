import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { linuxRootProbeEnabled, runLinuxRootProbe } from "./fixtures/linux-root-probe.ts";

if (!linuxRootProbeEnabled)
	console.info(
		"Skipping Linux root filesystem probe: requires explicit QORPERA_LINUX_ROOT_PROBES=1 on a disposable Linux host with sudo and Bubblewrap.",
	);

it.runIf(linuxRootProbeEnabled)(
	"measures only fixed protected bytes through real Linux descriptors and rejects replacement/interference",
	async () => {
		const root = fileURLToPath(new URL("../../..", import.meta.url)),
			temporary = await mkdtemp(join(tmpdir(), "office-software-file-"));
		try {
			await build({
				entryPoints: [join(root, "packages/runtime/test/fixtures/company-computer-service-software-file-probe.ts")],
				outfile: join(temporary, "probe.mjs"),
				bundle: true,
				platform: "node",
				format: "esm",
				target: "node22",
				tsconfig: join(root, "tsconfig.json"),
				alias: { "@qorpera/contracts": join(root, "packages/contracts/src/index.ts") },
			});
			const proof = JSON.parse(runLinuxRootProbe(join(temporary, "probe.mjs")));
			expect(proof.checks).toBe(17);
			expect(proof.actualLinuxFileDescriptors).toBe(true);
			expect(proof.runtimeOrSqlAuthority).toBe(false);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	},
	90000,
);
