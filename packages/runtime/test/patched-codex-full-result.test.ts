import { describe, expect, it } from "vitest";
import { runNativeCodexFullResultProbe } from "./fixtures/native-codex-full-result-probe.ts";
import { pinnedCodexBinary } from "./fixtures/pinned-codex-binary.ts";

// One result at the full 32 KiB bound, on the pinned artifact and a scripted loopback provider: the host fits a
// 40,000-byte page to one envelope, Codex keeps it whole in its history, its fence releases it, and the next provider
// request carries exactly that envelope. A binary with the 8 KiB fence refuses it before the provider sees it.
const binary = pinnedCodexBinary();
describe.skipIf(!binary)("a full result on the native artifact (requires QORPERA_CODEX_FENCE_BINARY)", () => {
	for (const model of ["offline-probe", "gpt-6-astra"])
		it(`sends a 32 KiB result whole to the provider (${model})`, async () => {
			if (!binary) throw new Error("Missing pinned downstream native artifact");
			const proof = await runNativeCodexFullResultProbe(binary, model);
			expect(proof).toMatchObject({
				requests: 2,
				failure: null,
				fenceRefused: false,
				sentAsIssued: true,
				status: "ok",
				truncated: true,
				pageStart: true,
			});
			expect(proof.issuedBytes).toHaveLength(1);
			expect(proof.issuedBytes[0]).toBeGreaterThan(proof.bound - 1024);
			expect(proof.issuedBytes[0]).toBeLessThanOrEqual(proof.bound);
			expect(proof.sentBytes).toEqual(proof.issuedBytes);
			expect(proof.includedBytes).toBeGreaterThan(29_000);
		}, 30_000);
});
