import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("measures only fixed protected bytes through real Linux descriptors and rejects replacement/interference", async () => {
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
		const proof = JSON.parse(
			execFileSync(
				"docker",
				[
					"run",
					"--rm",
					"--pull=never",
					"--network",
					"none",
					"--read-only",
					"--tmpfs",
					"/opt:rw,nosuid,nodev,mode=0755,size=64m",
					"-v",
					`${temporary}:/probe:ro`,
					"node:22-bookworm-slim",
					"node",
					"/probe/probe.mjs",
				],
				{ encoding: "utf8", timeout: 60000, maxBuffer: 1048576 },
			),
		);
		expect(proof.checks).toBe(17);
		expect(proof.actualLinuxFileDescriptors).toBe(true);
		expect(proof.runtimeOrSqlAuthority).toBe(false);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}, 90000);
