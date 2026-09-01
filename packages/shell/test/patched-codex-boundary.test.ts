import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runNativeCodexFenceFailureProbe } from "./fixtures/native-codex-fence-failure-probe.ts";
import { runOfficialCodexBoundaryProbe } from "./fixtures/official-codex-boundary-probe.ts";

// A source-built artifact is an explicit acceptance prerequisite, not an npm dependency or a paid model.
// The standalone acceptance command is mandatory for rollout and fails rather than skipping a missing artifact.
const binary = process.env.QORPERA_CODEX_FENCE_BINARY;
describe.skipIf(!binary)("pinned downstream native artifact (requires QORPERA_CODEX_FENCE_BINARY)", () => {
	it.each(["offline-probe", "provider-default"])(
		"fences every real native result with %s",
		async (model) => {
			if (!binary) throw new Error("Missing pinned downstream native artifact");
			const proof = await runOfficialCodexBoundaryProbe([binary], model);
			expect(proof).toEqual({
				platform: process.platform,
				codexVersion: "0.147.0",
				providerModel: model === "provider-default" ? "gpt-5.6-sol" : model,
				toolInventory: [
					...(model === "provider-default" ? ["functions.exec", "functions.wait"] : []),
					"qorpera.read_document",
					"qorpera.send_message",
				],
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

	it("runs the standalone acceptance entrypoint against the same artifact", async () => {
		if (!binary) throw new Error("Missing pinned downstream native artifact");
		const entry = fileURLToPath(new URL("./fixtures/run-official-codex-boundary-probe.ts", import.meta.url));
		const { stdout } = await promisify(execFile)(process.execPath, [entry, binary], {
			timeout: 30_000,
			maxBuffer: 1024 * 1024,
		});
		const proof = JSON.parse(stdout);
		expect(proof).toMatchObject({
			nativeResultsFenced: 23,
			unfencedNativeResults: 0,
			allNativeResultsFenced: true,
		});
		expect(proof.compactionChecks).toHaveLength(6);
		for (const mode of ["local", "remote", "remote-v2"]) {
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
