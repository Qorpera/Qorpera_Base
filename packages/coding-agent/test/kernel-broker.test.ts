import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyKernelIntentCapability } from "../src/core/kernel-broker.ts";

describe("kernel intent capabilities", () => {
	it("binds founder attendance to one exact RPC frame and consumes the nonce once", () => {
		const pair = generateKeyPairSync("ed25519");
		const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
		const unsignedFrame = { type: "prompt", message: "approved founder instruction" };
		const intent = {
			nonce: "intent-one",
			requestHash: createHash("sha256").update(JSON.stringify(unsignedFrame)).digest("hex"),
			attended: true,
			expiresAt: new Date(Date.now() + 30_000).toISOString(),
		};
		const kernelIntent = {
			...intent,
			signature: sign(null, Buffer.from(JSON.stringify(intent)), pair.privateKey).toString("base64"),
		};
		const frame = { ...unsignedFrame, kernelIntent };
		const consumed = new Set<string>();
		expect(verifyKernelIntentCapability(frame, publicKey, consumed)).toBe(true);
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
