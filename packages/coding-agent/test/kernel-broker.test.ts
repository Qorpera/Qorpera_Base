import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyKernelIntentCapability } from "../src/core/kernel-broker.ts";

describe("kernel intent capabilities", () => {
	it("binds founder attendance to one exact RPC frame and consumes the nonce once", () => {
		const pair = generateKeyPairSync("ed25519");
		const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
		const unsignedFrame = { type: "prompt", message: "approved founder instruction" };
		const issuedAt = new Date().toISOString();
		const intent = {
			nonce: "intent-one",
			sessionId: "session-one",
			requestHash: createHash("sha256").update(JSON.stringify(unsignedFrame)).digest("hex"),
			attended: true,
			issuedAt,
			expiresAt: new Date(Date.now() + 30_000).toISOString(),
			execution: {
				kind: "turn" as const,
				id: "10000000-0000-4000-8000-000000000001",
				claimantId: "10000000-0000-4000-8000-000000000002",
			},
			budget: { maxCalls: 4, maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostUsd: 1 },
		};
		const kernelIntent = {
			...intent,
			signature: sign(null, Buffer.from(JSON.stringify(intent)), pair.privateKey).toString("base64"),
		};
		const frame = { ...unsignedFrame, kernelIntent };
		const consumed = new Set<string>();
		expect(verifyKernelIntentCapability(frame, publicKey, consumed)).toEqual(kernelIntent);
		expect(verifyKernelIntentCapability(frame, publicKey, consumed)).toBeUndefined();
		expect(
			verifyKernelIntentCapability(
				{ ...frame, message: "renderer substituted a different instruction" },
				publicKey,
				new Set(),
			),
		).toBeUndefined();
	});
});
