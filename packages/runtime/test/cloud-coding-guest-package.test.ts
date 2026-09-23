import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

describe("coding guest packaged entrypoints", () => {
	it.each([
		["command", "get", "CODING_GUEST_COMMAND_REFUSED\n"],
		["git", "export", "CODING_GIT_GUEST_REFUSED\n"],
	])("the %s bundle has no imported storage CLI side effects", async (name, action, expected) => {
		const directory = await realpath(await mkdtemp(join(tmpdir(), "coding-package-")));
		try {
			const outfile = join(directory, "guest.mjs");
			await build({
				entryPoints: [fileURLToPath(new URL(`../src/cloud-coding-${name}-guest.ts`, import.meta.url))],
				outfile,
				bundle: true,
				platform: "node",
				format: "esm",
				target: "node22.19",
				logLevel: "silent",
			});
			const result = await new Promise<{ code: string | number | null | undefined; stdout: string; stderr: string }>(
				(resolve) => {
					execFile(
						process.execPath,
						[outfile, action, "00000000-0000-4000-8000-000000000001"],
						{
							timeout: 10000,
							maxBuffer: 1024,
							env: {},
						},
						(error, stdout, stderr) => resolve({ code: error?.code, stdout, stderr }),
					);
				},
			);
			expect(result).toEqual({ code: 1, stdout: "", stderr: expected });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
