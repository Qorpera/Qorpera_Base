import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { runOfficialCodexBoundaryProbe } from "./fixtures/official-codex-boundary-probe.ts";

it("rejects the stock native binary before it can create an unfenced model request", async () => {
	const cli = createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js");
	await expect(runOfficialCodexBoundaryProbe([process.execPath, cli])).rejects.toThrow("missing native result fence");
});

it("does not weaken the boundary when using the provider-default model", async () => {
	const cli = createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js");
	await expect(runOfficialCodexBoundaryProbe([process.execPath, cli], "provider-default")).rejects.toThrow(
		"missing native result fence",
	);
});

it("makes the standalone acceptance command fail for an unpatched artifact", async () => {
	const cli = createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js");
	const entry = fileURLToPath(new URL("./fixtures/run-official-codex-boundary-probe.ts", import.meta.url));
	await expect(
		promisify(execFile)(process.execPath, [entry, process.execPath, cli], {
			timeout: 25_000,
			maxBuffer: 1024 * 1024,
		}),
	).rejects.toThrow("missing native result fence");
});
