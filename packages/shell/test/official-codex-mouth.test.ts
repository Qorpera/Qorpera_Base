import { createRequire } from "node:module";
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
