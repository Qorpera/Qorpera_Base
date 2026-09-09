import { randomBytes, randomUUID } from "node:crypto";
import {
	createStep2SecretCanaryAdapter,
	STEP2_SECRET_CANARY_ADAPTER_SHA256,
	STEP2_SECRET_CANARY_DESTINATION_ORIGIN,
} from "@qorpera/runtime/cloud-secret-canary-adapter";
import { expect, it, vi } from "vitest";

function input(overrides: Partial<Parameters<ReturnType<typeof createStep2SecretCanaryAdapter>["execute"]>[0]> = {}) {
	return {
		arguments: { label: "effect-41", behavior: "safe" } as const,
		credentials: { api_key: randomBytes(32).toString("base64url") },
		credentialName: "api_key",
		destinationOrigin: STEP2_SECRET_CANARY_DESTINATION_ORIGIN,
		idempotencyKey: "effect-41",
		signal: new AbortController().signal,
		...overrides,
	};
}

it("pins one exact canary destination and puts the credential only in its authorization header", async () => {
	const credential = randomBytes(32).toString("base64url");
	const destination = vi.fn<typeof fetch>(async (url, init) => {
		expect(String(url)).toBe(`${STEP2_SECRET_CANARY_DESTINATION_ORIGIN}/v1/effects`);
		expect(init?.method).toBe("POST");
		expect(init?.headers).toMatchObject({
			authorization: `Bearer ${credential}`,
			"content-type": "application/json",
			"idempotency-key": "effect-41",
		});
		expect(String(init?.body)).not.toContain(credential);
		return Response.json({
			schema: "qorpera.step2-secret-canary-result/v1",
			status: "completed",
			effectId: randomUUID(),
			reused: false,
		});
	});
	const adapter = createStep2SecretCanaryAdapter(destination);
	expect(adapter).toMatchObject({
		connectorId: "step2_canary",
		operationId: "record_marker",
		operationVersion: 1,
		adapterSha256: STEP2_SECRET_CANARY_ADAPTER_SHA256,
		destinationOrigin: STEP2_SECRET_CANARY_DESTINATION_ORIGIN,
	});
	await expect(adapter.execute(input({ credentials: { api_key: credential } }))).resolves.toMatchObject({
		status: "completed",
		reused: false,
	});
	expect(destination).toHaveBeenCalledTimes(1);
});

it("rejects destination, credential-shape, and argument drift before network access", async () => {
	const destination = vi.fn<typeof fetch>();
	const adapter = createStep2SecretCanaryAdapter(destination);
	await expect(adapter.execute(input({ destinationOrigin: "https://example.com" }))).rejects.toThrow("authority");
	await expect(
		adapter.execute(input({ credentials: { api_key: randomBytes(32).toString("base64url"), extra: "x" } })),
	).rejects.toThrow("authority");
	await expect(adapter.execute(input({ arguments: { label: "effect-41", behavior: "unknown" } }))).rejects.toThrow(
		"arguments",
	);
	expect(destination).not.toHaveBeenCalled();
});

it("returns reflected material to the independent broker fence instead of masking inside the adapter", async () => {
	const credential = randomBytes(32).toString("base64url");
	const adapter = createStep2SecretCanaryAdapter(async () =>
		Response.json({
			schema: "qorpera.step2-secret-canary-result/v1",
			status: "completed",
			effectId: randomUUID(),
			reused: false,
			reflection: credential,
		}),
	);
	await expect(adapter.execute(input({ credentials: { api_key: credential } }))).resolves.toMatchObject({
		reflection: credential,
	});
});

it("fails closed on an open response shape", async () => {
	const adapter = createStep2SecretCanaryAdapter(async () =>
		Response.json({
			schema: "qorpera.step2-secret-canary-result/v1",
			status: "completed",
			effectId: randomUUID(),
			reused: false,
			debug: "must-not-cross",
		}),
	);
	await expect(adapter.execute(input())).rejects.toThrow("result is invalid");
});
