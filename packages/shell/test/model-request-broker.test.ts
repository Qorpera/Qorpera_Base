import { afterEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
	getModel: vi.fn((provider: string, id: string) =>
		provider === "openai" && id === "approved-model"
			? { provider, id, api: "openai-responses", baseUrl: "https://api.openai.com/v1" }
			: undefined,
	),
	streamSimple: vi.fn(() => ({
		async *[Symbol.asyncIterator]() {
			yield {
				type: "done",
				reason: "stop",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					api: "openai-responses",
					provider: "openai",
					model: "approved-model",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 0,
				},
			};
		},
	})),
	close: vi.fn(),
}));

vi.mock("@qorpera/pi-coding-agent", () => ({
	ModelRuntime: { create: vi.fn(async () => runtime) },
}));

import { startModelRequestBroker } from "../src/model-request-broker.ts";
import { brokerCredentialProjection } from "../src/model-request-scope.ts";

afterEach(() => {
	vi.clearAllMocks();
});

describe("kernel model-request broker", () => {
	it("projects opaque handles without copying API keys or OAuth tokens", () => {
		const projection = brokerCredentialProjection(
			{
				openai: { type: "api_key", key: "raw-openai-secret", env: { ALSO_SECRET: "value" } },
				"openai-codex": {
					type: "oauth",
					access: "raw-access-token",
					refresh: "raw-refresh-token",
					expires: 0,
				},
				github: { type: "api_key", key: "raw-github-secret" },
			},
			["anthropic"],
			new Set(["openai", "openai-codex", "anthropic"]),
		);
		const serialized = JSON.stringify(projection.credentials);
		expect(serialized).not.toContain("raw-");
		expect(serialized).not.toContain("ALSO_SECRET");
		expect(serialized).not.toContain("github");
		expect(projection.handles.size).toBe(3);
		expect(projection.credentials.openai).toMatchObject({ type: "api_key" });
		expect(projection.credentials["openai-codex"]).toMatchObject({ type: "oauth" });
	});

	it("executes only a registered handle with an exact kernel-issued intent", async () => {
		const broker = await startModelRequestBroker({
			authPath: "auth.json",
			modelsPath: "models.json",
			allowedProviders: new Set(["openai"]),
		});
		const child = broker.registerChild({ openai: { type: "api_key", key: "raw-secret" } }, []);
		const handle = child.handles.openai;
		const intent = {
			nonce: "11111111-1111-4111-8111-111111111111",
			requestHash: "a".repeat(64),
			attended: true,
			expiresAt: "2026-08-10T12:00:00.000Z",
			signature: "kernel-signature",
		};
		child.authorizeIntent(intent);
		const send = vi.fn();
		const frame = {
			type: "qorpera_model_request",
			requestId: "22222222-2222-4222-8222-222222222222",
			handle,
			intent,
			model: { provider: "openai", id: "approved-model" },
			context: { messages: [] },
			options: { transport: "sse" },
		};
		expect(broker.handleFrame(frame, send)).toBe(true);
		await vi.waitFor(() =>
			expect(send).toHaveBeenCalledWith({ type: "qorpera_model_end", requestId: frame.requestId }),
		);
		expect(runtime.streamSimple).toHaveBeenCalledOnce();
		expect(JSON.stringify(frame)).not.toContain("raw-secret");

		const forged = {
			...frame,
			requestId: "33333333-3333-4333-8333-333333333333",
			intent: { ...intent, requestHash: "b".repeat(64) },
		};
		expect(broker.handleFrame(forged, send)).toBe(true);
		await vi.waitFor(() =>
			expect(send).toHaveBeenCalledWith({
				type: "qorpera_model_end",
				requestId: forged.requestId,
				error: "kernel model request denied",
			}),
		);
		expect(runtime.streamSimple).toHaveBeenCalledOnce();
		child.release();
		broker.close();
	});
});
