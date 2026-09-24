import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

async function bundled(name: string, args: string[]) {
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
		return await new Promise<{ code: string | number | null | undefined; stdout: string; stderr: string }>(
			(resolve) => {
				execFile(
					process.execPath,
					[outfile, ...args],
					{ timeout: 10000, maxBuffer: 1024, env: {} },
					(error, stdout, stderr) => resolve({ code: error?.code, stdout, stderr }),
				);
			},
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

describe("coding guest packaged entrypoints", () => {
	it("the command bundle's execute step exits 125 with only a fixed code when refused before starting", async () => {
		// Outside a coding VM there is no guest configuration: the refusal is an
		// errno code, never the path, and the missing log is not created.
		expect(
			await bundled("command", [
				"execute",
				"00000000-0000-4000-8000-000000000002",
				"00000000-0000-4000-8000-000000000001",
			]),
		).toEqual({
			code: 125,
			stdout: "",
			stderr: "CODING_GUEST_COMMAND_REFUSED ERRNO:ENOENT\n",
		});
	});
	it.each([
		["command", "get", "CODING_GUEST_COMMAND_REFUSED\n"],
		["git", "export", "CODING_GIT_GUEST_REFUSED\n"],
	])("the %s bundle has no imported storage CLI side effects", async (name, action, expected) => {
		expect(
			await bundled(name, [action, "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000001"]),
		).toEqual({
			code: 1,
			stdout: "",
			stderr: expected,
		});
	});
});
