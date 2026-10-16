import { describe, expect, it } from "vitest";
import { runNativeCodexLiveHalvesProbe } from "./fixtures/native-codex-live-halves-probe.ts";

// Each request's input after the prompt, by shape: r2 answers c1 after r1's reasoning, r3 answers c2 too.
const R2 = ["reasoning", "call:c1", "output:c1"];
const R3 = [...R2, "call:c2", "output:c2"];

// The no-login halves of the live acceptance, on the pinned artifact and a scripted loopback provider.
const binary = process.env.QORPERA_CODEX_FENCE_BINARY;
describe.skipIf(!binary)("live halves on the native artifact (requires QORPERA_CODEX_FENCE_BINARY)", () => {
	it("D1 sends Codex's own context unchanged under the run's 51-character cache key", async () => {
		if (!binary) throw new Error("Missing pinned downstream native artifact");
		expect(await runNativeCodexLiveHalvesProbe(binary, "unchanged")).toMatchObject({
			requests: 3,
			effects: 2,
			fencedRequests: 3,
			failure: null,
			keyLength: 51,
			cacheKeys: ["run"],
			sameHead: true,
			tails: [[], R2, R3],
			nativeErrors: [],
		});
	}, 20_000);

	it("D1 leaves out the reasoning the composer drops", async () => {
		if (!binary) throw new Error("Missing pinned downstream native artifact");
		expect(await runNativeCodexLiveHalvesProbe(binary, "reasoning-dropped")).toMatchObject({
			requests: 3,
			effects: 2,
			fencedRequests: 3,
			failure: null,
			cacheKeys: ["run"],
			sameHead: true,
			composerSawReasoning: 2,
			tails: [[], ["call:c1", "output:c1"], ["call:c1", "output:c1", "call:c2", "output:c2"]],
			nativeErrors: [],
		});
	}, 20_000);

	it("D1 sends a folded step as the run's work message where the step was", async () => {
		if (!binary) throw new Error("Missing pinned downstream native artifact");
		expect(await runNativeCodexLiveHalvesProbe(binary, "folded")).toMatchObject({
			requests: 3,
			effects: 2,
			fencedRequests: 3,
			failure: null,
			cacheKeys: ["run"],
			sameHead: true,
			tails: [[], R2, ["work", "call:c2", "output:c2"]],
			nativeErrors: [],
		});
	}, 20_000);

	it("D1 puts a resumed run's earlier steps before its first raw step", async () => {
		if (!binary) throw new Error("Missing pinned downstream native artifact");
		expect(await runNativeCodexLiveHalvesProbe(binary, "resumed")).toMatchObject({
			requests: 3,
			effects: 2,
			fencedRequests: 3,
			failure: null,
			cacheKeys: ["run"],
			sameHead: true,
			tails: [["earlier-work"], ["earlier-work", ...R2], ["earlier-work", ...R3]],
			nativeErrors: [],
		});
	}, 20_000);

	it("D1 refuses a work message in another key order before it reaches the provider", async () => {
		if (!binary) throw new Error("Missing pinned downstream native artifact");
		expect(await runNativeCodexLiveHalvesProbe(binary, "forged")).toMatchObject({
			requests: 2,
			effects: 2,
			failure: expect.any(String),
			compositionRefused: true,
			cacheKeys: ["run"],
			tails: [[], R2],
		});
	}, 20_000);

	it("D1 refuses a work message with unescaped markup", async () => {
		if (!binary) throw new Error("Missing pinned downstream native artifact");
		expect(await runNativeCodexLiveHalvesProbe(binary, "forged-markup")).toMatchObject({
			requests: 2,
			effects: 2,
			failure: expect.any(String),
			compositionRefused: true,
			cacheKeys: ["run"],
			tails: [[], R2],
		});
	}, 20_000);

	it("D2 runs the run's compactor in the real app-server, without tools or the run's key", async () => {
		if (!binary) throw new Error("Missing pinned downstream native artifact");
		const compactRequest = { effort: "low", qorperaTools: 0, system: true, window: true, runKey: false };
		expect(await runNativeCodexLiveHalvesProbe(binary, "compactor")).toMatchObject({
			requests: 3,
			effects: 2,
			fencedRequests: 3,
			failure: null,
			closingError: null,
			composedThreads: 1,
			compactRequests: [compactRequest, compactRequest],
			replies: [
				{ text: "LINE 1", usage: { input: 500, cached: 100, output: 40 } },
				{ text: "LINE 2", usage: { input: 700, cached: 500, output: 30 } },
			],
		});
	}, 20_000);

	it("D3 records one usage row per provider request from Codex's six counters", async () => {
		if (!binary) throw new Error("Missing pinned downstream native artifact");
		expect(await runNativeCodexLiveHalvesProbe(binary, "usage")).toMatchObject({
			requests: 3,
			failure: null,
			usageKeys: [
				"cacheWriteInputTokens,cachedInputTokens,inputTokens,outputTokens,reasoningOutputTokens,totalTokens",
			],
			usageRows: [
				["succeeded", 40, 5, 0, 0, 1, 45],
				["succeeded", 60, 4, 38, 0, 0, 64],
				["succeeded", 70, 3, 60, 0, 0, 73],
			],
			usageParents: true,
			turnUsage: ["succeeded", 170, 12, 98, 0, 1, 182],
		});
	}, 20_000);

	it("D4 sends the next request after a result fence slower than 8 s", async () => {
		if (!binary) throw new Error("Missing pinned downstream native artifact");
		const proof = await runNativeCodexLiveHalvesProbe(binary, "slow-fence");
		expect(proof).toMatchObject({
			requests: 3,
			effects: 2,
			fencedRequests: 3,
			failure: null,
			nativeErrors: [],
			releases: ["succeeded", "succeeded"],
		});
		// The held check is r2's fence, not c1's release.
		expect(proof.heldMs).toBeGreaterThanOrEqual(9_000);
		expect(proof.r2AfterHoldMs).toBeGreaterThanOrEqual(9_000);
		expect(proof.slowestReleaseMs).toBeLessThan(9_000);
	}, 40_000);
});
