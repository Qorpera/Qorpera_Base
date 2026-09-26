import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CLOUD_CODEX_BOUNDARY_VERSION } from "@qorpera/runtime/cloud-codex-tool-session";
import { expect, it } from "vitest";
import { runOfficialCodexBoundaryProbe } from "./fixtures/official-codex-boundary-probe.ts";

it("pins the stock test binary to the native boundary protocol version", async () => {
	const manifest = createRequire(import.meta.url).resolve("@openai/codex-boundary-test/package.json");
	expect(JSON.parse(await readFile(manifest, "utf8"))).toMatchObject({ version: CLOUD_CODEX_BOUNDARY_VERSION });
});

it("rejects the stock native binary before it can create an unfenced model request", async () => {
	const cli = createRequire(import.meta.url).resolve("@openai/codex-boundary-test/bin/codex.js");
	await expect(runOfficialCodexBoundaryProbe([process.execPath, cli])).rejects.toThrow("missing native result fence");
});

it("does not weaken the boundary when using the provider-default model", async () => {
	const cli = createRequire(import.meta.url).resolve("@openai/codex-boundary-test/bin/codex.js");
	await expect(runOfficialCodexBoundaryProbe([process.execPath, cli], "provider-default")).rejects.toThrow(
		"missing native result fence",
	);
});

it("makes the standalone acceptance command fail for an unpatched artifact", async () => {
	const cli = createRequire(import.meta.url).resolve("@openai/codex-boundary-test/bin/codex.js");
	const entry = fileURLToPath(new URL("./fixtures/run-official-codex-boundary-probe.ts", import.meta.url));
	await expect(
		promisify(execFile)(process.execPath, [entry, process.execPath, cli], {
			timeout: 25_000,
			maxBuffer: 1024 * 1024,
		}),
	).rejects.toThrow("missing native result fence");
});
