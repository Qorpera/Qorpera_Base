import { describe, expect, it } from "vitest";
import { runNativeCodexWebSearchProbe } from "./fixtures/native-codex-web-search-probe.ts";
import { pinnedCodexBinary } from "./fixtures/pinned-codex-binary.ts";

const binary = pinnedCodexBinary();
describe.skipIf(!binary)("web search on the native artifact (requires QORPERA_CODEX_FENCE_BINARY)", () => {
	for (const model of ["offline-probe", "gpt-6-astra", "gpt-6.2-sol"])
		it(`searches through Codex's own web.run and the fence admits the result (${model})`, async () => {
			if (!binary) throw new Error("Missing pinned downstream native artifact");
			const proof = await runNativeCodexWebSearchProbe(binary, model);
			expect(proof).toEqual({
				requests: 2,
				failure: null,
				fenceRefused: false,
				inventories: [
					["qorpera.read_document", "web.run"],
					["qorpera.read_document", "web.run"],
				],
				searches: 1,
				searchedFor: "qorpera web search probe",
				externalWebAccess: false,
				envelope: {
					trust: "untrusted_data",
					status: "unconfirmed",
					callId: "ws1",
					text: "SEARCH_RESULT_CANARY: the probe's one result.",
				},
				step: { tool: "web_search", args: JSON.stringify({ query: "qorpera web search probe" }), finished: true },
			});
		}, 30_000);

	it("refuses the provider's hosted search, whose item the pinned fence never admits", async () => {
		if (!binary) throw new Error("Missing pinned downstream native artifact");
		const proof = await runNativeCodexWebSearchProbe(binary, "offline-probe", true);
		expect(proof).toMatchObject({ requests: 1, fenceRefused: true, searches: 0, envelope: null, step: null });
		expect(proof.failure).not.toBeNull();
	}, 30_000);
});
