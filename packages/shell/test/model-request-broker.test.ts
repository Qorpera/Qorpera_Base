import type { KernelIntentCapability, KernelModelIntentBudget } from "@qorpera/pi-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
	getModel: vi.fn((provider: string, id: string) =>
		provider === "openai" && id === "approved-model"
			? {
					provider,
					id,
					api: "openai-responses",
					baseUrl: "https://api.openai.com/v1",
					maxTokens: 100,
					cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.25 },
				}
			: undefined,
	),
	streamSimple: vi.fn(
		(_model: unknown, context: { systemPrompt?: string }, options: { signal?: AbortSignal; maxTokens?: number }) => ({
			async *[Symbol.asyncIterator]() {
				if (context.systemPrompt === "wait") {
					await new Promise<void>((_resolve, reject) => {
						const abort = () => reject(new Error("aborted"));
						if (options.signal?.aborted) abort();
						else options.signal?.addEventListener("abort", abort, { once: true });
					});
				}
				if (context.systemPrompt === "provider-error") {
					yield {
						type: "error",
						reason: "error",
						error: {
							role: "assistant",
							content: [],
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								cost: { total: 0 },
							},
						},
					};
					return;
				}
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
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0.000001, output: 0.000002, cacheRead: 0, cacheWrite: 0, total: 0.000003 },
						},
						stopReason: "stop",
						timestamp: 0,
					},
				};
			},
		}),
	),
}));

vi.mock("@qorpera/pi-coding-agent", () => ({
	ModelRuntime: { create: vi.fn(async () => runtime) },
}));

import {
	type ModelRequestAccountRouter,
	type ModelRequestRuntime,
	startModelRequestBroker,
} from "../src/legacy-local-model-request-broker.ts";
import { brokerCredentialProjection } from "../src/model-request-scope.ts";

const DEFAULT_BUDGET: KernelModelIntentBudget = {
	maxCalls: 4,
	maxInputTokens: 100_000,
	maxOutputTokens: 1_000,
	maxCostUsd: 1,
};

function intent(
	nonce: string,
	budget: KernelModelIntentBudget = DEFAULT_BUDGET,
	lifetimeMs = 30_000,
): KernelIntentCapability {
	const issuedAtMs = Date.now();
	return {
		nonce,
		sessionId: "session-one",
		requestHash: "a".repeat(64),
		attended: true,
		issuedAt: new Date(issuedAtMs).toISOString(),
		expiresAt: new Date(issuedAtMs + lifetimeMs).toISOString(),
		budget,
		signature: "kernel-signature",
	};
}

function request(
	handle: string,
	capability: KernelIntentCapability,
	requestId: string,
	context: { systemPrompt?: string; messages: unknown[]; tools?: unknown[] } = { messages: [] },
	options: Record<string, unknown> = { transport: "sse", maxTokens: 100 },
): object {
	return {
		type: "qorpera_model_request",
		requestId,
		handle,
		intent: capability,
		model: { provider: "openai", id: "approved-model" },
		context,
		options,
	};
}

afterEach(() => {
	vi.clearAllMocks();
});

describe("host model-request broker", () => {
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

	it("binds requests to one session and rejects semantic replay after completion", async () => {
		const broker = await startModelRequestBroker({
			authPath: "auth.json",
			modelsPath: "models.json",
			allowedProviders: new Set(["openai"]),
		});
		const child = broker.registerChild("session-one", { openai: { type: "api_key", key: "raw-secret" } }, []);
		const handle = child.handles.openai;
		const capability = intent("11111111-1111-4111-8111-111111111111");
		expect(child.authorizeIntent(capability)).toBe(true);
		const send = vi.fn();
		const first = request(handle, capability, "22222222-2222-4222-8222-222222222222");
		expect(child.handleFrame(first, send)).toBe(true);
		await vi.waitFor(() =>
			expect(send).toHaveBeenCalledWith({
				type: "qorpera_model_end",
				requestId: "22222222-2222-4222-8222-222222222222",
			}),
		);
		const replay = request(handle, capability, "33333333-3333-4333-8333-333333333333");
		expect(child.handleFrame(replay, send)).toBe(true);
		await vi.waitFor(() =>
			expect(send).toHaveBeenCalledWith({
				type: "qorpera_model_end",
				requestId: "33333333-3333-4333-8333-333333333333",
				error: "host model request denied",
			}),
		);
		expect(runtime.streamSimple).toHaveBeenCalledOnce();

		const completedTurn = intent("12121212-1212-4212-8212-121212121212");
		expect(child.authorizeIntent(completedTurn)).toBe(true);
		child.endTurn("completed");
		child.handleFrame(
			request(child.handles.openai, completedTurn, "13131313-1313-4313-8313-131313131313", {
				systemPrompt: "new call after turn completion",
				messages: [],
			}),
			send,
		);
		await vi.waitFor(() =>
			expect(send).toHaveBeenCalledWith(
				expect.objectContaining({
					requestId: "13131313-1313-4313-8313-131313131313",
					error: "host model request denied",
				}),
			),
		);
		child.release();
		broker.close();
	});

	it("rejects expired intents and revokes all requests when a turn is aborted", async () => {
		const broker = await startModelRequestBroker({
			authPath: "auth.json",
			modelsPath: "models.json",
			allowedProviders: new Set(["openai"]),
		});
		const child = broker.registerChild("session-one", { openai: { type: "api_key", key: "secret" } }, []);
		const expired = intent("44444444-4444-4444-8444-444444444444", DEFAULT_BUDGET, 5);
		expect(child.authorizeIntent(expired)).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 15));
		const send = vi.fn();
		child.handleFrame(request(child.handles.openai, expired, "55555555-5555-4555-8555-555555555555"), send);
		await vi.waitFor(() =>
			expect(send).toHaveBeenCalledWith(expect.objectContaining({ error: "host model request denied" })),
		);

		const active = intent("66666666-6666-4666-8666-666666666666");
		expect(child.authorizeIntent(active)).toBe(true);
		const waiting = request(child.handles.openai, active, "77777777-7777-4777-8777-777777777777", {
			systemPrompt: "wait",
			messages: [],
		});
		child.handleFrame(waiting, send);
		await vi.waitFor(() => expect(runtime.streamSimple).toHaveBeenCalled());
		child.handleFrame({ type: "qorpera_model_abort", requestId: "77777777-7777-4777-8777-777777777777" }, send);
		await vi.waitFor(() =>
			expect(send).toHaveBeenCalledWith(
				expect.objectContaining({
					requestId: "77777777-7777-4777-8777-777777777777",
					error: "host model execution failed",
				}),
			),
		);
		child.handleFrame(
			request(child.handles.openai, active, "88888888-8888-4888-8888-888888888888", {
				systemPrompt: "after abort",
				messages: [],
			}),
			send,
		);
		await vi.waitFor(() =>
			expect(send).toHaveBeenCalledWith(
				expect.objectContaining({
					requestId: "88888888-8888-4888-8888-888888888888",
					error: "host model request denied",
				}),
			),
		);
		child.release();
		broker.close();
	});

	it("enforces call, token, output, and cost budgets across a bounded tool loop", async () => {
		const broker = await startModelRequestBroker({
			authPath: "auth.json",
			modelsPath: "models.json",
			allowedProviders: new Set(["openai"]),
		});
		const child = broker.registerChild("session-one", { openai: { type: "api_key", key: "secret" } }, []);
		const bounded = intent("99999999-9999-4999-8999-999999999999", {
			maxCalls: 1,
			maxInputTokens: 10_000,
			maxOutputTokens: 7,
			maxCostUsd: 1,
		});
		expect(child.authorizeIntent(bounded)).toBe(true);
		const send = vi.fn();
		child.handleFrame(request(child.handles.openai, bounded, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), send);
		await vi.waitFor(() => expect(runtime.streamSimple).toHaveBeenCalled());
		expect(runtime.streamSimple.mock.calls.at(-1)?.[2]).toMatchObject({ maxTokens: 7 });
		child.handleFrame(
			request(child.handles.openai, bounded, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", {
				systemPrompt: "second call",
				messages: [],
			}),
			send,
		);
		await vi.waitFor(() =>
			expect(send).toHaveBeenCalledWith(
				expect.objectContaining({
					requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
					error: "host model request denied",
				}),
			),
		);

		const noTokens = intent("cccccccc-cccc-4ccc-8ccc-cccccccccccc", {
			maxCalls: 2,
			maxInputTokens: 1,
			maxOutputTokens: 100,
			maxCostUsd: 1,
		});
		expect(child.authorizeIntent(noTokens)).toBe(true);
		child.handleFrame(request(child.handles.openai, noTokens, "dddddddd-dddd-4ddd-8ddd-dddddddddddd"), send);

		const noCost = intent("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", {
			maxCalls: 2,
			maxInputTokens: 10_000,
			maxOutputTokens: 100,
			maxCostUsd: 0,
		});
		expect(child.authorizeIntent(noCost)).toBe(true);
		child.handleFrame(request(child.handles.openai, noCost, "ffffffff-ffff-4fff-8fff-ffffffffffff"), send);
		await vi.waitFor(() => {
			expect(send).toHaveBeenCalledWith(
				expect.objectContaining({
					requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
					error: "host model request denied",
				}),
			);
			expect(send).toHaveBeenCalledWith(
				expect.objectContaining({
					requestId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
					error: "host model request denied",
				}),
			);
		});
		child.release();
		broker.close();
	});

	it("accepts priority service and reserves its multiplied cost", async () => {
		const broker = await startModelRequestBroker({
			authPath: "auth.json",
			modelsPath: "models.json",
			allowedProviders: new Set(["openai"]),
		});
		const child = broker.registerChild("session-one", { openai: { type: "api_key", key: "secret" } }, []);
		const capability = intent("14141414-1414-4414-8414-141414141414");
		expect(child.authorizeIntent(capability)).toBe(true);
		const send = vi.fn();
		child.handleFrame(
			request(
				child.handles.openai,
				capability,
				"15151515-1515-4515-8515-151515151515",
				{ messages: [] },
				{ transport: "sse", maxTokens: 100, serviceTier: "priority" },
			),
			send,
		);
		await vi.waitFor(() => expect(runtime.streamSimple).toHaveBeenCalled());
		expect(runtime.streamSimple.mock.calls.at(-1)?.[2]).toMatchObject({ serviceTier: "priority" });
		child.release();
		broker.close();
	});

	it("charges only observed usage on provider failure — a failed call cannot drain the budget", async () => {
		// The old contract charged the full worst-case reservation on failure:
		// one dead call at 128k reserved output billed $13 of budget for zero
		// work, and a handful of transient failures exhausted an intent
		// entirely (observed 2026-08-13 on the founder's first prompt).
		const observations: Array<{ status: string }> = [];
		const broker = await startModelRequestBroker({
			authPath: "auth.json",
			modelsPath: "models.json",
			allowedProviders: new Set(["openai"]),
		});
		const child = broker.registerChild("session-one", { openai: { type: "api_key", key: "secret" } }, [], (event) =>
			observations.push(event),
		);
		const capability = intent("16161616-1616-4616-8616-161616161616", {
			maxCalls: 4,
			maxInputTokens: 100_000,
			maxOutputTokens: 1_000,
			maxCostUsd: 0.0008,
		});
		expect(child.authorizeIntent(capability)).toBe(true);
		const send = vi.fn();
		child.handleFrame(
			request(
				child.handles.openai,
				capability,
				"17171717-1717-4717-8717-171717171717",
				{ systemPrompt: "provider-error", messages: [] },
				{ transport: "sse", maxTokens: 100, serviceTier: "priority" },
			),
			send,
		);
		await vi.waitFor(() => expect(observations.at(-1)?.status).toBe("failed"));
		child.handleFrame(
			request(
				child.handles.openai,
				capability,
				"18181818-1818-4818-8818-181818181818",
				{ systemPrompt: "after charged failure", messages: [] },
				{ transport: "sse", maxTokens: 100, serviceTier: "priority" },
			),
			send,
		);
		// The failure charged its observed usage (zero here), so the follow-up
		// request rides the same intent instead of being denied.
		await vi.waitFor(() =>
			expect(send).toHaveBeenCalledWith({
				type: "qorpera_model_end",
				requestId: "18181818-1818-4818-8818-181818181818",
			}),
		);
		expect(send).not.toHaveBeenCalledWith(
			expect.objectContaining({
				requestId: "18181818-1818-4818-8818-181818181818",
				error: "host model request denied",
			}),
		);
		expect(runtime.streamSimple).toHaveBeenCalledTimes(2);
		child.release();
		broker.close();
	});

	it("holds one account lease across provider authentication and streaming", async () => {
		let insideLease = false;
		const release = vi.fn();
		const run = async <T>(operation: () => Promise<T>): Promise<T> => {
			insideLease = true;
			try {
				return await operation();
			} finally {
				insideLease = false;
			}
		};
		const lease = vi.fn<ModelRequestAccountRouter["lease"]>(async () => ({
			accountId: "account-two",
			run,
			release,
		}));
		const routedRuntime = {
			getModel: runtime.getModel,
			streamSimple: vi.fn((...args: Parameters<typeof runtime.streamSimple>) => {
				expect(insideLease).toBe(true);
				return runtime.streamSimple(...args);
			}),
		} as unknown as ModelRequestRuntime;
		const broker = await startModelRequestBroker({
			authPath: "auth.json",
			modelsPath: "models.json",
			allowedProviders: new Set(["openai"]),
			runtime: routedRuntime,
			accountRouter: { lease, markRateLimited: vi.fn() },
		});
		const child = broker.registerChild("session-one", { openai: { type: "api_key", key: "secret" } }, []);
		const capability = intent("19191919-1919-4919-8919-191919191919");
		expect(child.authorizeIntent(capability)).toBe(true);
		const send = vi.fn();
		child.handleFrame(request(child.handles.openai, capability, "20202020-2020-4020-8020-202020202020"), send);
		await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
		expect(lease).toHaveBeenCalledWith("openai");
		expect(routedRuntime.streamSimple).toHaveBeenCalledOnce();
		child.release();
		broker.close();
	});
});
