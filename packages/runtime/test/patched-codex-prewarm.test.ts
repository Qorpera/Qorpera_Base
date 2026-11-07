import { describe, expect, it } from "vitest";
import { runNativeCodexPrewarmProbe } from "./fixtures/native-codex-prewarm-probe.ts";

// The real executable, on a scripted loopback provider that speaks WebSocket: no login, no model, no network.
const binary = process.env.QORPERA_CODEX_FENCE_BINARY;
describe.skipIf(!binary)("a declined prewarm on the native artifact (requires QORPERA_CODEX_FENCE_BINARY)", () => {
	it("sends no prewarm, and the turn opens its own connection and completes", async () => {
		if (!binary) throw new Error("Missing pinned downstream native artifact");
		expect(await runNativeCodexPrewarmProbe(binary)).toMatchObject({
			failure: null,
			prewarmFrames: 0,
			turnFrames: 2,
			handshakes: 1,
			httpRequests: 0,
			effects: 1,
			toolCalls: 1,
			fencedRequests: 2,
			nativeErrors: [],
			firstTurnFollowsPrewarm: false,
			modelRequests: ["succeeded", "succeeded"],
			turn: ["succeeded"],
		});
	}, 30_000);
});
