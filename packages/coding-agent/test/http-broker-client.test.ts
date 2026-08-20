/**
 * Child side of the kernel HTTP lane (Build 3): frame round-trip.
 */
import type { KernelExecutionIdentity, KernelIntentCapability } from "@qorpera/pi-protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
	brokeredHttpRequest,
	handleHttpBrokerFrame,
	setHttpBrokerIntent,
	setHttpBrokerWriter,
} from "../src/core/http-broker-client.ts";

afterEach(() => {
	setHttpBrokerIntent(undefined);
	setHttpBrokerWriter(undefined);
});

function intent(execution: KernelExecutionIdentity): KernelIntentCapability {
	return {
		nonce: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		sessionId: "session-1",
		requestHash: "a".repeat(64),
		attended: true,
		issuedAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + 60_000).toISOString(),
		budget: { maxCalls: 32, maxInputTokens: 1_000, maxOutputTokens: 1_000, maxCostUsd: 1 },
		execution,
		signature: "signature",
	};
}

describe("http broker client", () => {
	it("round-trips a request frame to a response", async () => {
		const frames: Array<Record<string, unknown>> = [];
		setHttpBrokerWriter((frame) => frames.push(frame as Record<string, unknown>));

		const pending = brokeredHttpRequest({
			method: "GET",
			url: "https://api.test.example/v1/things",
			headers: { authorization: "Bearer secret://token" },
		});
		expect(frames.length).toBe(1);
		expect(frames[0].type).toBe("qorpera_http_request");
		const requestId = frames[0].requestId as string;

		expect(
			handleHttpBrokerFrame({
				type: "qorpera_http_response",
				requestId,
				status: 200,
				headers: { "content-type": "application/json" },
				body: '{"ok":true}',
				bodyBytes: 11,
			}),
		).toBe(true);
		const response = await pending;
		expect(response.status).toBe(200);
		expect(response.body).toContain("ok");
		expect(response.bodyBytes).toBe(11);
	});

	it("rejects on kernel error frames and ignores unrelated frames", async () => {
		const frames: Array<Record<string, unknown>> = [];
		setHttpBrokerWriter((frame) => frames.push(frame as Record<string, unknown>));
		const pending = brokeredHttpRequest({ method: "GET", url: "https://api.test.example/x" });
		const requestId = frames[0].requestId as string;

		expect(handleHttpBrokerFrame({ type: "qorpera_model_event" })).toBe(false);
		expect(handleHttpBrokerFrame({ type: "qorpera_http_response", requestId: "unknown" })).toBe(true);
		expect(
			handleHttpBrokerFrame({ type: "qorpera_http_response", requestId, error: "kernel http request denied: x" }),
		).toBe(true);
		await expect(pending).rejects.toThrow(/denied/);
	});

	it("reuses the execution-derived request id after a runtime restart", async () => {
		const frames: Array<Record<string, unknown>> = [];
		const execution: KernelExecutionIdentity = {
			kind: "wake",
			id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			claimantId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		};
		const capability = intent(execution);
		setHttpBrokerWriter((frame) => frames.push(frame as Record<string, unknown>));
		setHttpBrokerIntent(capability);
		const first = brokeredHttpRequest({ method: "POST", url: "https://api.test.example/x" });
		handleHttpBrokerFrame({
			type: "qorpera_http_response",
			requestId: frames[0].requestId,
			status: 200,
			headers: {},
			body: "ok",
			bodyBytes: 2,
		});
		await first;
		setHttpBrokerIntent(undefined);
		setHttpBrokerIntent(capability);
		const replay = brokeredHttpRequest({ method: "POST", url: "https://api.test.example/x" });
		expect(frames[1].requestId).toBe(frames[0].requestId);
		handleHttpBrokerFrame({
			type: "qorpera_http_response",
			requestId: frames[1].requestId,
			status: 200,
			headers: {},
			body: "ok",
			bodyBytes: 2,
		});
		await replay;
	});
});
