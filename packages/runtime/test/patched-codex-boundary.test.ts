import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runNativeCodexFenceFailureProbe } from "./fixtures/native-codex-fence-failure-probe.ts";
import { runNativeCodexUsageLimitProbe } from "./fixtures/native-codex-usage-limit-probe.ts";
import { runOfficialCodexBoundaryProbe } from "./fixtures/official-codex-boundary-probe.ts";

// A source-built artifact is an explicit acceptance prerequisite, not an npm dependency or a paid model.
// The standalone acceptance command is mandatory for rollout and fails rather than skipping a missing artifact.
const binary = process.env.QORPERA_CODEX_FENCE_BINARY;
describe.skipIf(!binary)("pinned downstream native artifact (requires QORPERA_CODEX_FENCE_BINARY)", () => {
	it.each(["offline-probe", "provider-default", "gpt-5.6-sol"])(
		"fences every real native result with %s",
		async (model) => {
			if (!binary) throw new Error("Missing pinned downstream native artifact");
			const proof = await runOfficialCodexBoundaryProbe([binary], model);
			expect(proof).toEqual({
				platform: process.platform,
				codexVersion: "0.155.1",
				providerModel: model === "provider-default" ? "gpt-6-astra" : model,
				toolInventory: ["qorpera.read_document", "qorpera.send_message"],
				forcedBypassesDenied: 22,
				canonicalBytesUnchanged: true,
				unbrokeredRequests: 0,
				syntheticSecretExcluded: true,
				controlledResultsFenced: 8,
				nativeResultsFenced: 23,
				unfencedNativeResults: 0,
				publicMessages: 2,
				immediateDelivery: true,
				retryDeduplicated: true,
				privateOutputExcluded: true,
				allNativeResultsFenced: true,
			});
		},
		30_000,
	);

	// A ChatGPT plan's usage limit (Sign in with ChatGPT): OpenAI's code, mid-stream or as a 429, reaches the host as
	// Codex's usageLimitExceeded, so the run stops at the limit instead of reading as a lost stream or a rate limit.
	it.each(["mid_stream", "http_429"] as const)(
		"reads a ChatGPT plan's usage limit (%s) as a usage limit",
		async (mode) => {
			if (!binary) throw new Error("Missing pinned downstream native artifact");
			expect(await runNativeCodexUsageLimitProbe(binary, mode)).toEqual({
				mode,
				requests: 1,
				stage: "codex-turn-completion",
				category: "budget_exhausted",
				usageSignal: "usage_limit",
			});
		},
		30_000,
	);

	it("runs the standalone acceptance entrypoint against the same artifact", async () => {
		if (!binary) throw new Error("Missing pinned downstream native artifact");
		const entry = fileURLToPath(new URL("./fixtures/run-official-codex-boundary-probe.ts", import.meta.url));
		const { stdout } = await promisify(execFile)(process.execPath, [entry, binary], {
			timeout: 30_000,
			maxBuffer: 1024 * 1024,
		});
		const proof = JSON.parse(stdout);
		expect(proof).toMatchObject({
			providerModel: "gpt-6-astra",
			nativeResultsFenced: 23,
			unfencedNativeResults: 0,
			allNativeResultsFenced: true,
		});
		expect(proof.solBoundaryProof).toMatchObject({
			providerModel: "gpt-5.6-sol",
			nativeResultsFenced: 23,
			unfencedNativeResults: 0,
			allNativeResultsFenced: true,
		});
		expect(proof.compactionChecks).toHaveLength(4);
		expect(proof.providerDefaultCompactionChecks).toEqual(proof.compactionChecks);
		for (const mode of ["local", "remote-v2"]) {
			expect(proof.compactionChecks).toContainEqual({
				mode,
				compactions: 1,
				modelRequests: 4,
				fencedCompactionOutputs: 2,
				readEffects: 1,
				writeEffects: 1,
				revoked: false,
				resumedWithLaws: true,
			});
			expect(proof.compactionChecks).toContainEqual({
				mode,
				compactions: 1,
				modelRequests: 2,
				fencedCompactionOutputs: 2,
				readEffects: 1,
				writeEffects: 0,
				revoked: true,
				resumedWithLaws: false,
			});
		}
	}, 35_000);

	it.each(["revoked", "stalled"])(
		"blocks the next native model request when authority is %s",
		async (fault) => {
			if (!binary) throw new Error("Missing pinned downstream native artifact");
			expect(await runNativeCodexFenceFailureProbe(binary, fault as "revoked" | "stalled")).toMatchObject({
				fault,
				requests: 1,
				effects: 0,
				blocked: true,
			});
		},
		20_000,
	);
});
