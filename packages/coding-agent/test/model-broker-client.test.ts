import type { Api, Model } from "@qorpera/pi-ai";
import { fauxAssistantMessage } from "@qorpera/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	brokeredStreamSimple,
	handleModelBrokerFrame,
	installModelBrokerFetch,
	setModelBrokerWriter,
	withModelBrokerTurn,
} from "../src/core/model-broker-client.ts";

const model: Model<Api> = {
	id: "faux-1",
	name: "Faux",
	api: "faux",
	provider: "faux",
	baseUrl: "https://must-not-reach-child.example",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

describe("model broker client", () => {
	it("uses one intent-bound structured IPC request and disables child network", async () => {
		const handle = "qorpera-model-11111111-1111-4111-8111-111111111111";
		process.env.QORPERA_MODEL_BROKER_HANDLES = JSON.stringify({ faux: handle });
		const frames: object[] = [];
		setModelBrokerWriter((frame) => frames.push(frame));
		installModelBrokerFetch();
		const issuedAt = new Date().toISOString();
		const intent = {
			nonce: "22222222-2222-4222-8222-222222222222",
			sessionId: "session-one",
			requestHash: "a".repeat(64),
			attended: true,
			issuedAt,
			expiresAt: new Date(Date.now() + 30_000).toISOString(),
			budget: { maxCalls: 4, maxInputTokens: 10_000, maxOutputTokens: 2_000, maxCostUsd: 1 },
			signature: "kernel-signature",
		};

		const stream = withModelBrokerTurn(intent, () => brokeredStreamSimple(model, { messages: [] }));
		expect(stream).toBeDefined();
		expect(frames).toHaveLength(1);
		expect(frames[0]).toMatchObject({
			type: "qorpera_model_request",
			handle,
			intent,
			model: { provider: "faux", id: "faux-1" },
			options: { transport: "sse" },
		});
		const serialized = JSON.stringify(frames[0]);
		expect(serialized).not.toContain(model.baseUrl);
		expect(serialized).not.toContain("authorization");
		await expect(fetch("https://example.com/unbrokered")).rejects.toThrow(
			"all child HTTP requests are disabled by the desktop host",
		);

		const requestId = (frames[0] as { requestId: string }).requestId;
		const result = fauxAssistantMessage("brokered");
		expect(
			handleModelBrokerFrame({
				type: "qorpera_model_event",
				requestId,
				event: { type: "done", reason: "stop", message: result },
			}),
		).toBe(true);
		expect(handleModelBrokerFrame({ type: "qorpera_model_end", requestId })).toBe(true);
		await expect(stream!.result()).resolves.toEqual(result);
		expect(vi.isMockFunction(globalThis.fetch)).toBe(false);
	});
});
