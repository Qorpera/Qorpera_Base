/**
 * Child side of the kernel HTTP lane (Build 3): frame round-trip.
 */
import { describe, expect, it } from "vitest";
import { brokeredHttpRequest, handleHttpBrokerFrame, setHttpBrokerWriter } from "../src/core/http-broker-client.ts";

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
});
