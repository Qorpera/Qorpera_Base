import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { runOfficialCodexMouthProbe } from "./fixtures/official-codex-mouth-probe.ts";

it("keeps actual Codex output private and delivers only committed sends, including receipt retries", async () => {
	const cli = createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js");
	await expect(runOfficialCodexMouthProbe([process.execPath, cli])).resolves.toMatchObject({
		publicMessages: 2,
		immediateDelivery: true,
		retryDeduplicated: true,
		privateOutputExcluded: true,
	});
});

it("runs the standalone probe entry point and emits explicit proof values", async () => {
	const cli = createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js");
	const entry = fileURLToPath(new URL("./fixtures/run-official-codex-mouth-probe.ts", import.meta.url));
	const { stdout } = await promisify(execFile)(process.execPath, [entry, process.execPath, cli], {
		timeout: 25_000,
		maxBuffer: 1024 * 1024,
	});
	expect(JSON.parse(stdout)).toEqual({
		platform: process.platform,
		publicMessages: 2,
		immediateDelivery: true,
		retryDeduplicated: true,
		privateOutputExcluded: true,
	});
});
