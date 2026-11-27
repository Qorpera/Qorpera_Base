import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { JsonValue } from "@qorpera/contracts";
import { CloudActionReviewChannel } from "@qorpera/runtime/cloud-action-review";
import {
	GeminiCapReachedError,
	GeminiKeyRevokedError,
	GeminiProviderError,
	type GeminiToolSessionUsage,
	geminiFunctionDeclarations,
	geminiProviderDiagnostic,
	geminiProviderErrorCode,
	geminiProviderFailureCode,
	runCloudGeminiToolSession,
	stripGeminiGroundingCitations,
} from "@qorpera/runtime/cloud-gemini-tool-session";
import { nativeRuntimeFailureMetadata } from "@qorpera/runtime/cloud-native-failure";
import { type CloudNativeTool, CloudNativeToolBoundary } from "@qorpera/runtime/cloud-native-tool-boundary";
import type { CloudRuntimeObservability } from "@qorpera/runtime/cloud-runtime-observability";
import { cloudRunWorkComposer } from "@qorpera/runtime/memory-tree/run-work";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const CANARY_KEY = "AIzaSyCanaryGeminiSession0123456789abcdef";
const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

interface CapturedGeminiRequest {
	path: string;
	apiKeyHeader: string | string[] | undefined;
	body: Record<string, unknown>;
}

let server: Server | undefined;

afterEach(async () => {
	vi.restoreAllMocks();
	await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
	server = undefined;
});

async function startMockGemini(
	handler: (req: CapturedGeminiRequest, index: number) => { status?: number; body: unknown },
) {
	const requests: CapturedGeminiRequest[] = [];
	server = createServer(async (request: IncomingMessage, reply) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(chunk as Buffer);
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
		const captured: CapturedGeminiRequest = {
			path: request.url ?? "/",
			apiKeyHeader: request.headers["x-goog-api-key"],
			body,
		};
		const index = requests.length;
		requests.push(captured);
		const answer = handler(captured, index);
		reply.writeHead(answer.status ?? 200, { "content-type": "application/json" });
		reply.end(JSON.stringify(answer.body));
	});
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
	const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return { baseUrl, requests };
}

function makeBoundary(tools: CloudNativeTool[]) {
	const f = nativeToolAuthorityFixture();
	return new CloudNativeToolBoundary({
		companyId: f.authority.identity.companyId,
		runId: f.authority.identity.runId,
		identity: f.authority.identity,
		tools,
		assertActive: vi.fn(async () => undefined),
		signal: new AbortController().signal,
	});
}

describe("geminiFunctionDeclarations schema conversion", () => {
	it("converts JSON Schema to Gemini OpenAPI 3.0 schemas and drops unsupported keywords", () => {
		const declarations = geminiFunctionDeclarations({
			tools: [
				{
					type: "function",
					name: "sample_tool",
					description: "A sample tool",
					inputSchema: {
						$schema: "https://json-schema.org/draft/2020-12/schema",
						type: "object",
						additionalProperties: false,
						properties: {
							path: { type: "string", pattern: "^[a-z]+$", minLength: 1 },
							note: { type: ["string", "null"], description: "Optional note" },
							tags: { type: "array", items: { type: "string" }, maxItems: 5 },
							mode: { anyOf: [{ const: "fast" }, { type: "null" }] },
						},
						required: ["path"],
					},
				},
			],
		});
		expect(declarations).toHaveLength(1);
		expect(declarations[0]).toEqual({
			name: "sample_tool",
			description: "A sample tool",
			parameters: {
				type: "OBJECT",
				properties: {
					path: { type: "STRING", description: "Pattern: ^[a-z]+$", minLength: 1 },
					note: { type: "STRING", description: "Optional note", nullable: true },
					tags: { type: "ARRAY", items: { type: "STRING" }, maxItems: 5 },
					mode: { type: "STRING", enum: ["fast"], nullable: true },
				},
				required: ["path"],
			},
		});
	});
});

describe("runCloudGeminiToolSession", () => {
	it("runs tools, preserves thoughtSignature verbatim, forwards PNG images, enables google_search, and fences every turn", async () => {
		const executeRead = vi.fn<CloudNativeTool["execute"]>(async () => ({
			kind: "text",
			value: "Quarterly revenue is 420k",
		}));
		const pngBytes = Buffer.from(TINY_PNG_BASE64, "base64");
		const pngSha256 = createHash("sha256").update(pngBytes).digest("hex");
		const executeShot = vi.fn<CloudNativeTool["execute"]>(async () => ({
			kind: "json",
			value: { captured: true, imageSha256: pngSha256 },
			image: { png: pngBytes, sha256: pngSha256 },
		}));
		const boundary = makeBoundary([
			{
				name: "read_report",
				description: "Read a report",
				source: "company_file",
				inputSchema: {
					type: "object",
					additionalProperties: false,
					properties: { name: { type: "string" } },
					required: ["name"],
				},
				parseArguments: (args) => args,
				execute: executeRead,
			},
			{
				name: "capture_view",
				description: "Capture a PNG screenshot",
				source: "runtime",
				images: true,
				inputSchema: { type: "object", additionalProperties: false },
				parseArguments: () => ({}),
				execute: executeShot,
			},
		]);
		const signature = "opaque-thought-sig-abc123==";
		const { baseUrl, requests } = await startMockGemini((_req, index) => {
			if (index === 0) {
				return {
					body: {
						candidates: [
							{
								content: {
									role: "model",
									parts: [
										{ thought: true, text: "Checking report and view" },
										{
											functionCall: { id: "call_1", name: "read_report", args: { name: "q4" } },
											thoughtSignature: signature,
										},
										{
											functionCall: { id: "call_2", name: "capture_view", args: {} },
										},
									],
								},
							},
						],
						usageMetadata: {
							promptTokenCount: 10_000,
							cachedContentTokenCount: 4_000,
							candidatesTokenCount: 120,
							thoughtsTokenCount: 80,
						},
					},
				};
			}
			return {
				body: {
					candidates: [
						{
							content: {
								role: "model",
								parts: [{ text: "Revenue is 420k." }],
							},
						},
					],
					usageMetadata: {
						promptTokenCount: 12_000,
						cachedContentTokenCount: 9_000,
						candidatesTokenCount: 40,
						thoughtsTokenCount: 10,
					},
				},
			};
		});

		const recordedViews = vi.fn(async () => undefined);
		const usageCalls: GeminiToolSessionUsage[] = [];
		const result = await runCloudGeminiToolSession({
			boundary,
			model: "gemini-4-neon",
			effort: "high",
			apiKey: CANARY_KEY,
			apiBaseUrl: baseUrl,
			allowLoopback: true,
			initialSpendMicrodollars: 0,
			monthlyCapCents: 10_000,
			prompt: "Check the Q4 report",
			runtimeInstructions: "Be concise.",
			recordContextView: recordedViews,
			onUsage: async (usage) => {
				usageCalls.push(usage);
				return { monthSpendMicrodollars: 0, monthlyCapCents: 10_000, capReached: false };
			},
			signal: AbortSignal.timeout(10_000),
		});

		expect(result.toolCalls).toBe(2);
		expect(result.fencedRequests).toBe(2);
		expect(result.codexVersion).toBe("gemini-4-neon");
		expect(recordedViews).toHaveBeenCalledTimes(2);
		expect(requests).toHaveLength(2);
		expect(requests[0]?.path).toBe("/v1beta/models/gemini-4-neon:streamGenerateContent?alt=sse");
		expect(requests[0]?.apiKeyHeader).toBe(CANARY_KEY);
		expect(requests[0]?.body.generationConfig).toEqual({ thinkingConfig: { thinkingLevel: "high" } });
		expect(requests[0]?.body.tools).toEqual([
			{ functionDeclarations: expect.arrayContaining([expect.objectContaining({ name: "read_report" })]) },
			{ google_search: {} },
		]);
		expect(requests[0]?.body.toolConfig).toEqual({ includeServerSideToolInvocations: true });

		const secondContents = requests[1]?.body.contents as Array<{
			role: string;
			parts: Array<Record<string, unknown>>;
		}>;
		expect(secondContents[1]?.role).toBe("model");
		expect(secondContents[1]?.parts[1]?.thoughtSignature).toBe(signature);
		expect(secondContents[2]?.role).toBe("user");
		expect(secondContents[2]?.parts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					functionResponse: expect.objectContaining({ id: "call_1", name: "read_report" }),
				}),
				expect.objectContaining({
					inlineData: { mimeType: "image/png", data: TINY_PNG_BASE64 },
				}),
			]),
		);

		expect(usageCalls).toEqual([
			{ inputTokens: 10_000, cachedTokens: 4_000, outputTokens: 200 },
			{ inputTokens: 22_000, cachedTokens: 13_000, outputTokens: 250 },
		]);
	});

	it("wires the Gemini action reviewer with forced review_verdict calling and supports turnCorrection once", async () => {
		const reviewer = new CloudActionReviewChannel();
		let reviewVerdict: unknown;
		const boundary = makeBoundary([
			{
				name: "sensitive_action",
				description: "Runs action review",
				source: "company_file",
				inputSchema: { type: "object", additionalProperties: false },
				parseArguments: () => ({}),
				execute: async (_args, context) => {
					reviewVerdict = await reviewer.review(
						{
							instructions: "Review this action.",
							prompt: "Send invoice to customer",
							model: "gemini-4-neon",
							effort: "low",
						},
						context.signal,
					);
					return { kind: "text", value: "Reviewed" };
				},
			},
		]);

		const { baseUrl, requests } = await startMockGemini((req, index) => {
			if (index === 0) {
				return {
					body: {
						candidates: [
							{
								content: {
									role: "model",
									parts: [{ functionCall: { name: "sensitive_action", args: {} } }],
								},
							},
						],
						usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 20 },
					},
				};
			}
			if (index === 1) {
				expect(req.body.toolConfig).toEqual({
					functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["review_verdict"] },
				});
				return {
					body: {
						candidates: [
							{
								content: {
									role: "model",
									parts: [
										{
											functionCall: {
												name: "review_verdict",
												args: { decision: "allow", reason: "Matches request" },
											},
										},
									],
								},
							},
						],
						usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 30 },
					},
				};
			}
			return {
				body: {
					candidates: [{ content: { role: "model", parts: [{ text: index === 2 ? "Draft" : "Sent" }] } }],
					usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 15 },
				},
			};
		});

		const turnCorrection = vi.fn(async () => "Please call send_message to reply.");
		const result = await runCloudGeminiToolSession({
			boundary,
			model: "gemini-4-neon",
			effort: "medium",
			apiKey: CANARY_KEY,
			apiBaseUrl: baseUrl,
			allowLoopback: true,
			initialSpendMicrodollars: 0,
			monthlyCapCents: null,
			prompt: "Send invoice",
			reviewer,
			turnCorrection,
			signal: AbortSignal.timeout(10_000),
		});

		expect(reviewVerdict).toEqual({ decision: "allow", reason: "Matches request" });
		expect(turnCorrection).toHaveBeenCalledTimes(1);
		expect(result.fencedRequests).toBe(3);
		expect(requests).toHaveLength(4);
	});

	it("stops mid-turn before the next Gemini request when the monthly spend cap is crossed", async () => {
		const boundary = makeBoundary([
			{
				name: "step_tool",
				description: "One step",
				source: "company_file",
				inputSchema: { type: "object", additionalProperties: false },
				parseArguments: () => ({}),
				execute: async () => ({ kind: "text", value: "ok" }),
			},
		]);
		const { baseUrl, requests } = await startMockGemini(() => ({
			body: {
				candidates: [
					{
						content: {
							role: "model",
							parts: [{ functionCall: { name: "step_tool", args: {} } }],
						},
					},
				],
				usageMetadata: { promptTokenCount: 400_000, candidatesTokenCount: 1_000 },
			},
		}));

		await expect(
			runCloudGeminiToolSession({
				boundary,
				model: "gemini-4-neon",
				effort: "low",
				apiKey: CANARY_KEY,
				apiBaseUrl: baseUrl,
				allowLoopback: true,
				initialSpendMicrodollars: 0,
				monthlyCapCents: 100,
				prompt: "Keep working",
				signal: AbortSignal.timeout(10_000),
			}),
		).rejects.toBeInstanceOf(GeminiCapReachedError);
		expect(requests).toHaveLength(1);
	});

	it("retries transient 429 responses and fails immediately with GeminiKeyRevokedError on 401", async () => {
		const boundary = makeBoundary([]);
		const { baseUrl, requests } = await startMockGemini((_req, index) => {
			if (index === 0) return { status: 429, body: { error: { message: "rate limited" } } };
			if (index === 1) {
				return {
					body: {
						candidates: [{ content: { role: "model", parts: [{ text: "Recovered" }] } }],
						usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 },
					},
				};
			}
			return { status: 401, body: { error: { message: "invalid api key" } } };
		});

		const ok = await runCloudGeminiToolSession({
			boundary,
			model: "gemini-4-neon",
			effort: "low",
			apiKey: CANARY_KEY,
			apiBaseUrl: baseUrl,
			allowLoopback: true,
			initialSpendMicrodollars: 0,
			monthlyCapCents: null,
			prompt: "Hello",
			signal: AbortSignal.timeout(10_000),
		});
		expect(ok.fencedRequests).toBe(1);
		expect(requests).toHaveLength(2);

		await expect(
			runCloudGeminiToolSession({
				boundary,
				model: "gemini-4-neon",
				effort: "low",
				apiKey: CANARY_KEY,
				apiBaseUrl: baseUrl,
				allowLoopback: true,
				initialSpendMicrodollars: 0,
				monthlyCapCents: null,
				prompt: "Hello again",
				signal: AbortSignal.timeout(10_000),
			}),
		).rejects.toBeInstanceOf(GeminiKeyRevokedError);
	});

	it("flushes final usage in finally after a transient onUsage failure and logs if all flushes fail", async () => {
		const boundary = makeBoundary([]);
		const { baseUrl } = await startMockGemini(() => ({
			body: {
				candidates: [{ content: { role: "model", parts: [{ text: "Done." }] } }],
				usageMetadata: { promptTokenCount: 2000, candidatesTokenCount: 100 },
			},
		}));

		let attempts = 0;
		const received: GeminiToolSessionUsage[] = [];
		await runCloudGeminiToolSession({
			boundary,
			model: "gemini-4-neon",
			effort: "low",
			apiKey: CANARY_KEY,
			apiBaseUrl: baseUrl,
			allowLoopback: true,
			initialSpendMicrodollars: 0,
			monthlyCapCents: null,
			prompt: "Summarize",
			onUsage: async (usage) => {
				attempts += 1;
				received.push(usage);
				if (attempts === 1) throw new Error("transient db blip");
				return { monthSpendMicrodollars: 7500, monthlyCapCents: null, capReached: false };
			},
			signal: AbortSignal.timeout(10_000),
		});
		expect(attempts).toBe(2);
		expect(received).toEqual([
			{ inputTokens: 2000, cachedTokens: 0, outputTokens: 100 },
			{ inputTokens: 2000, cachedTokens: 0, outputTokens: 100 },
		]);

		const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
		let failingAttempts = 0;
		await runCloudGeminiToolSession({
			boundary,
			model: "gemini-4-neon",
			effort: "low",
			apiKey: CANARY_KEY,
			apiBaseUrl: baseUrl,
			allowLoopback: true,
			initialSpendMicrodollars: 0,
			monthlyCapCents: null,
			prompt: "Summarize again",
			onUsage: async () => {
				failingAttempts += 1;
				throw new Error("db unreachable");
			},
			signal: AbortSignal.timeout(10_000),
		});
		expect(failingAttempts).toBe(3);
		expect(logged).toHaveBeenCalledWith("Gemini run usage was not recorded");
	});

	it("applies opened.composeContext so a resumed Gemini attempt receives its earlier run work envelope", async () => {
		const boundary = makeBoundary([]);
		const { baseUrl, requests } = await startMockGemini(() => ({
			body: {
				candidates: [{ content: { role: "model", parts: [{ text: "Continued." }] } }],
				usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 20 },
			},
		}));
		const workEnvelope = JSON.stringify({
			schema: "qorpera.run-work/v1",
			note: "Earlier attempt already checked the invoice.",
		});

		await runCloudGeminiToolSession({
			boundary,
			model: "gemini-4-neon",
			effort: "high",
			apiKey: CANARY_KEY,
			apiBaseUrl: baseUrl,
			allowLoopback: true,
			initialSpendMicrodollars: 0,
			monthlyCapCents: null,
			opening: async () => ({
				prompt: "Finish the task",
				runtimeInstructions: "Follow instructions.",
				composeContext: async (request) => ({
					input: [...request.items.map((_, keep) => ({ keep })), { work: workEnvelope }],
				}),
			}),
			signal: AbortSignal.timeout(10_000),
		});

		expect(requests).toHaveLength(1);
		const contents = requests[0]?.body.contents as Array<{ role: string; parts: Array<{ text?: string }> }>;
		expect(contents).toHaveLength(1);
		expect(contents[0]?.role).toBe("user");
		expect(contents[0]?.parts).toEqual([{ text: "Finish the task" }, { text: workEnvelope }]);
	});

	it("folds earlier mixed text and tool-call turns through cloudRunWorkComposer without orphaned functionCall parts", async () => {
		const bigText = "A".repeat(36_000);
		const boundary = makeBoundary([
			{
				name: "big_read",
				description: "Read a chunk",
				source: "company_file",
				inputSchema: {
					type: "object",
					additionalProperties: false,
					properties: { part: { type: "integer" } },
					required: ["part"],
				},
				parseArguments: (args) => args,
				execute: async (args) => {
					const part = (args as { part: number }).part;
					return { kind: "text", value: part === 1 ? bigText : "small-part-2" };
				},
			},
		]);
		const composer = cloudRunWorkComposer({
			steps: async () => [
				{ j: 0, call: "call_1" },
				{ j: 1, call: "call_2" },
			],
			lines: async (r) => (r >= 1 ? ["0+1|Read part 1"] : []),
		});
		const { baseUrl, requests } = await startMockGemini((_req, index) => {
			if (index === 0) {
				return {
					body: {
						candidates: [
							{
								content: {
									role: "model",
									parts: [
										{ thought: true, text: "Thinking about part 1" },
										{ text: `Checking part 1... ${"x".repeat(70_000)}` },
										{
											functionCall: { id: "call_1", name: "big_read", args: { part: 1 } },
											thoughtSignature: "sig-1",
										},
									],
								},
							},
						],
						usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 40 },
					},
				};
			}
			if (index === 1) {
				return {
					body: {
						candidates: [
							{
								content: {
									role: "model",
									parts: [
										{ text: "Checking part 2..." },
										{
											functionCall: { id: "call_2", name: "big_read", args: { part: 2 } },
											thoughtSignature: "sig-2",
										},
									],
								},
							},
						],
						usageMetadata: { promptTokenCount: 10_000, candidatesTokenCount: 40 },
					},
				};
			}
			return {
				body: {
					candidates: [{ content: { role: "model", parts: [{ text: "Both parts checked." }] } }],
					usageMetadata: { promptTokenCount: 2000, candidatesTokenCount: 20 },
				},
			};
		});

		await runCloudGeminiToolSession({
			boundary,
			model: "gemini-4-neon",
			effort: "high",
			apiKey: CANARY_KEY,
			apiBaseUrl: baseUrl,
			allowLoopback: true,
			initialSpendMicrodollars: 0,
			monthlyCapCents: null,
			prompt: "Read both parts",
			composeContext: composer,
			signal: AbortSignal.timeout(10_000),
		});

		expect(requests).toHaveLength(3);
		const thirdContents = requests[2]?.body.contents as Array<{
			role: string;
			parts: Array<Record<string, unknown>>;
		}>;
		expect(thirdContents.map((entry) => entry.role)).toEqual(["user", "model", "user"]);
		expect(thirdContents[0]?.parts).toHaveLength(2);
		expect(String(thirdContents[0]?.parts[1]?.text)).toContain("0+1|Read part 1");
		expect(thirdContents[1]?.parts).toEqual([
			{ text: "Checking part 2..." },
			{
				functionCall: { id: "call_2", name: "big_read", args: { part: 2 } },
				thoughtSignature: "sig-2",
			},
		]);
		const callIds = thirdContents.flatMap((entry) =>
			entry.parts
				.map((part) => (part.functionCall as { id?: string } | undefined)?.id)
				.filter((id): id is string => Boolean(id)),
		);
		const responseIds = thirdContents.flatMap((entry) =>
			entry.parts
				.map((part) => (part.functionResponse as { id?: string } | undefined)?.id)
				.filter((id): id is string => Boolean(id)),
		);
		expect(callIds).toEqual(["call_2"]);
		expect(responseIds).toEqual(["call_2"]);
	});

	it("drops folded function_call parts at part granularity even when the same response's visible text is kept", async () => {
		const boundary = makeBoundary([
			{
				name: "step_read",
				description: "Read step",
				source: "company_file",
				inputSchema: { type: "object", additionalProperties: false },
				parseArguments: () => ({}),
				execute: async () => ({ kind: "text", value: "ok" }),
			},
		]);
		const workEnvelope = JSON.stringify({ schema: "qorpera.run-work/v1", lines: ["0+1|Folded call_1"] });
		const { baseUrl, requests } = await startMockGemini((_req, index) => {
			if (index === 0) {
				return {
					body: {
						candidates: [
							{
								content: {
									role: "model",
									parts: [
										{ text: "Let me check..." },
										{ functionCall: { id: "call_1", name: "step_read", args: {} } },
									],
								},
							},
						],
						usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 20 },
					},
				};
			}
			return {
				body: {
					candidates: [{ content: { role: "model", parts: [{ text: "Finished." }] } }],
					usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 10 },
				},
			};
		});

		await runCloudGeminiToolSession({
			boundary,
			model: "gemini-4-neon",
			effort: "low",
			apiKey: CANARY_KEY,
			apiBaseUrl: baseUrl,
			allowLoopback: true,
			initialSpendMicrodollars: 0,
			monthlyCapCents: null,
			prompt: "Run one step",
			composeContext: async (request) => {
				if (request.items.length <= 1) return { input: request.items.map((_, keep) => ({ keep })) };
				return { input: [{ keep: 0 }, { keep: 1 }, { work: workEnvelope }] };
			},
			signal: AbortSignal.timeout(10_000),
		});

		expect(requests).toHaveLength(2);
		const secondContents = requests[1]?.body.contents as Array<{
			role: string;
			parts: Array<Record<string, unknown>>;
		}>;
		expect(secondContents).toEqual([
			{ role: "user", parts: [{ text: "Run one step" }] },
			{ role: "model", parts: [{ text: "Let me check..." }] },
			{ role: "user", parts: [{ text: workEnvelope }] },
		]);
	});

	it("retries mid-stream body failures on 200 OK responses without calling AbortSignal.any", async () => {
		const boundary = makeBoundary([]);
		const anySpy = vi.spyOn(AbortSignal, "any");
		let attempts = 0;
		const customFetch: typeof fetch = async () => {
			attempts += 1;
			if (attempts === 1) {
				const broken = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('{"candidates":'));
						controller.error(new Error("socket reset mid-body"));
					},
				});
				return new Response(broken, { status: 200, headers: { "content-type": "application/json" } });
			}
			return new Response(
				JSON.stringify({
					candidates: [{ content: { role: "model", parts: [{ text: "Recovered." }] } }],
					usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};
		const result = await runCloudGeminiToolSession({
			boundary,
			model: "gemini-4-neon",
			effort: "low",
			apiKey: CANARY_KEY,
			apiBaseUrl: "http://127.0.0.1:1",
			allowLoopback: true,
			fetch: customFetch,
			initialSpendMicrodollars: 0,
			monthlyCapCents: null,
			prompt: "Retry stream error",
			timeoutMs: 10_000,
			signal: new AbortController().signal,
		});
		expect(attempts).toBe(2);
		expect(result.fencedRequests).toBe(1);
		expect(anySpy).not.toHaveBeenCalled();
	});

	it("fails closed with provider_failed without retrying when a 200 OK body exceeds the byte limit", async () => {
		let attempts = 0;
		const customFetch: typeof fetch = async () => {
			attempts += 1;
			let sent = 0;
			const huge = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (sent >= 17 * 1024 * 1024) {
						controller.close();
						return;
					}
					const chunk = new Uint8Array(1024 * 1024);
					sent += chunk.byteLength;
					controller.enqueue(chunk);
				},
			});
			return new Response(huge, { status: 200, headers: { "content-type": "application/json" } });
		};
		const error = await runCloudGeminiToolSession({
			boundary: makeBoundary([]),
			model: "gemini-4-neon",
			effort: "low",
			apiKey: CANARY_KEY,
			apiBaseUrl: "http://127.0.0.1:1",
			allowLoopback: true,
			fetch: customFetch,
			initialSpendMicrodollars: 0,
			monthlyCapCents: null,
			prompt: "Too large",
			signal: AbortSignal.timeout(10_000),
		}).catch((failure: unknown) => failure);
		expect(attempts).toBe(1);
		expect(nativeRuntimeFailureMetadata(error)).toMatchObject({ category: "provider_failed" });
	});

	it("aborts with TimeoutError DOMException when timeoutMs expires so downstream classifiers report timeout", async () => {
		const customFetch: typeof fetch = (_url, init) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			});
		const error = await runCloudGeminiToolSession({
			boundary: makeBoundary([]),
			model: "gemini-4-neon",
			effort: "low",
			apiKey: CANARY_KEY,
			apiBaseUrl: "http://127.0.0.1:1",
			allowLoopback: true,
			fetch: customFetch,
			initialSpendMicrodollars: 0,
			monthlyCapCents: null,
			prompt: "Slow session",
			timeoutMs: 40,
			signal: new AbortController().signal,
		}).catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(DOMException);
		expect((error as DOMException).name).toBe("TimeoutError");
	});

	it("bounds unbounded tool loops with budget_exhausted, excludes turnCorrection and timeout-bounded runs, and prunes folded inlineData", async () => {
		const loopBoundary = makeBoundary([
			{
				name: "spin_tool",
				description: "Spin",
				source: "company_file",
				inputSchema: { type: "object", additionalProperties: false },
				parseArguments: () => ({}),
				execute: async () => ({ kind: "text", value: "again" }),
			},
		]);
		let spinRequests = 0;
		const spinFetch: typeof fetch = async () => {
			spinRequests += 1;
			return new Response(
				JSON.stringify({
					candidates: [
						{
							content: {
								role: "model",
								parts: [{ functionCall: { id: `call_${spinRequests}`, name: "spin_tool", args: {} } }],
							},
						},
					],
					usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};
		const capError = await runCloudGeminiToolSession({
			boundary: loopBoundary,
			model: "gemini-4-neon",
			effort: "low",
			apiKey: CANARY_KEY,
			apiBaseUrl: "http://127.0.0.1:1",
			allowLoopback: true,
			fetch: spinFetch,
			initialSpendMicrodollars: 0,
			monthlyCapCents: null,
			prompt: "Loop",
			maxTurns: 3,
			signal: new AbortController().signal,
		}).catch((failure: unknown) => failure);
		expect(spinRequests).toBe(3);
		expect(nativeRuntimeFailureMetadata(capError)).toMatchObject({ category: "budget_exhausted" });

		let correctionRequests = 0;
		const correctionFetch: typeof fetch = async () => {
			correctionRequests += 1;
			return new Response(
				JSON.stringify({
					candidates: [
						{
							content: {
								role: "model",
								parts: [{ text: correctionRequests === 1 ? "Draft." : "Final." }],
							},
						},
					],
					usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};
		const corrected = await runCloudGeminiToolSession({
			boundary: makeBoundary([]),
			model: "gemini-4-neon",
			effort: "low",
			apiKey: CANARY_KEY,
			apiBaseUrl: "http://127.0.0.1:1",
			allowLoopback: true,
			fetch: correctionFetch,
			initialSpendMicrodollars: 0,
			monthlyCapCents: null,
			prompt: "Draft then fix",
			maxTurns: 1,
			turnCorrection: async () => "Send your final reply.",
			signal: new AbortController().signal,
		});
		expect(correctionRequests).toBe(2);
		expect(corrected.fencedRequests).toBe(2);

		let boundedRequests = 0;
		const boundedFetch: typeof fetch = async () => {
			boundedRequests += 1;
			if (boundedRequests <= 201) {
				return new Response(
					JSON.stringify({
						candidates: [
							{
								content: {
									role: "model",
									parts: [{ functionCall: { id: `long_${boundedRequests}`, name: "spin_tool", args: {} } }],
								},
							},
						],
						usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response(
				JSON.stringify({
					candidates: [{ content: { role: "model", parts: [{ text: "Completed after 201 tool turns." }] } }],
					usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};
		const longBounded = await runCloudGeminiToolSession({
			boundary: loopBoundary,
			model: "gemini-4-neon",
			effort: "low",
			apiKey: CANARY_KEY,
			apiBaseUrl: "http://127.0.0.1:1",
			allowLoopback: true,
			fetch: boundedFetch,
			initialSpendMicrodollars: 0,
			monthlyCapCents: null,
			timeoutMs: 60_000,
			prompt: "Long timeout-bounded run",
			signal: new AbortController().signal,
		});
		expect(longBounded.toolCalls).toBe(201);
		expect(boundedRequests).toBe(202);

		const pngBytes = Buffer.from(TINY_PNG_BASE64, "base64");
		const pngSha256 = createHash("sha256").update(pngBytes).digest("hex");
		const imgBoundary = makeBoundary([
			{
				name: "take_shot",
				description: "Take a screenshot",
				source: "runtime",
				images: true,
				inputSchema: { type: "object", additionalProperties: false },
				parseArguments: () => ({}),
				execute: async () => ({
					kind: "json",
					value: { captured: true, imageSha256: pngSha256 },
					image: { png: pngBytes, sha256: pngSha256 },
				}),
			},
		]);
		const bodies: Array<Record<string, unknown>> = [];
		let imgTurn = 0;
		const imgFetch: typeof fetch = async (_url, init) => {
			bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
			imgTurn += 1;
			if (imgTurn <= 3) {
				return new Response(
					JSON.stringify({
						candidates: [
							{
								content: {
									role: "model",
									parts: [{ functionCall: { id: `shot_${imgTurn}`, name: "take_shot", args: {} } }],
								},
							},
						],
						usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response(
				JSON.stringify({
					candidates: [{ content: { role: "model", parts: [{ text: "Done." }] } }],
					usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};
		await runCloudGeminiToolSession({
			boundary: imgBoundary,
			model: "gemini-4-neon",
			effort: "low",
			apiKey: CANARY_KEY,
			apiBaseUrl: "http://127.0.0.1:1",
			allowLoopback: true,
			fetch: imgFetch,
			initialSpendMicrodollars: 0,
			monthlyCapCents: null,
			prompt: "Take screenshots",
			composeContext: async (request) => {
				if (request.items.length < 5) return { input: request.items.map((_, keep) => ({ keep })) };
				if (request.items.length === 5) {
					return {
						input: [
							{ keep: 0 },
							{ work: JSON.stringify({ schema: "qorpera.run-work/v1", lines: ["0+1|Shot 1 folded"] }) },
							{ keep: 3 },
							{ keep: 4 },
						],
					};
				}
				return { input: [{ keep: 0 }, { keep: 2 }] };
			},
			signal: new AbortController().signal,
		});
		expect(bodies).toHaveLength(4);
		expect(JSON.stringify(bodies[1])).toContain(TINY_PNG_BASE64);
		expect(JSON.stringify(bodies[2])).toContain("Shot 1 folded");
		expect(JSON.stringify(bodies[2])).toContain(TINY_PNG_BASE64);
		expect(JSON.stringify(bodies[3])).not.toContain(TINY_PNG_BASE64);
	});

	it("records model_request observations, preserves server-side tool parts, and classifies HTTP errors without leaking raw text", async () => {
		const observed: Array<{ kind: string; status?: string; errorCategory?: string }> = [];
		const observability = {
			start: (kind: string) => {
				const entry: { kind: string; status?: string; errorCategory?: string } = { kind };
				observed.push(entry);
				return {
					finish: (status: string, extra?: { errorCategory?: string }) => {
						entry.status = status;
						if (extra?.errorCategory) entry.errorCategory = extra.errorCategory;
					},
				};
			},
		} as unknown as CloudRuntimeObservability;
		const boundary = makeBoundary([
			{
				name: "lookup_note",
				description: "Read a note",
				source: "company_file",
				inputSchema: { type: "object", additionalProperties: false },
				parseArguments: () => ({}),
				execute: async () => ({ kind: "text", value: "ok" }),
			},
		]);
		const serverToolCall = { id: "srv_1", toolType: "GOOGLE_SEARCH_WEB", args: { queries: ["qorpera"] } };
		const serverToolResponse = { id: "srv_1", toolType: "GOOGLE_SEARCH_WEB", response: { result: "found" } };
		const { baseUrl, requests } = await startMockGemini((_req, index) => {
			if (index === 0) {
				return {
					body: {
						candidates: [
							{
								content: {
									role: "model",
									parts: [
										{ toolCall: serverToolCall },
										{ toolResponse: serverToolResponse },
										{ functionCall: { id: "call_1", name: "lookup_note", args: {} } },
									],
								},
							},
						],
						usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 15 },
					},
				};
			}
			return {
				body: {
					candidates: [{ content: { role: "model", parts: [{ text: "Verified." }] } }],
					usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 10 },
				},
			};
		});

		await runCloudGeminiToolSession({
			boundary,
			observability,
			model: "gemini-4-neon",
			effort: "low",
			apiKey: CANARY_KEY,
			apiBaseUrl: baseUrl,
			allowLoopback: true,
			initialSpendMicrodollars: 0,
			monthlyCapCents: null,
			prompt: "Search then check note",
			signal: AbortSignal.timeout(10_000),
		});

		expect(observed).toEqual([
			{ kind: "model_request", status: "succeeded" },
			{ kind: "model_request", status: "succeeded" },
		]);
		expect(requests[0]?.body.toolConfig).toEqual({ includeServerSideToolInvocations: true });
		const secondContents = requests[1]?.body.contents as Array<{
			role: string;
			parts: Array<Record<string, unknown>>;
		}>;
		expect(secondContents[1]?.parts).toEqual([
			{ toolCall: serverToolCall },
			{ toolResponse: serverToolResponse },
			{ functionCall: { id: "call_1", name: "lookup_note", args: {} } },
		]);

		const cases = [
			{
				status: 403,
				body: {
					error: {
						status: "PERMISSION_DENIED",
						message: "secret billing account 12345",
						details: [{ reason: "BILLING_DISABLED" }],
					},
				},
				expectedCode: "billing_required",
				expectedDetail: "billing_disabled",
				expectedFailure: "GEMINI_API:BILLING_REQUIRED",
				expectedAttempts: 1,
			},
			{
				status: 429,
				body: {
					error: {
						status: "RESOURCE_EXHAUSTED",
						message: "Quota exceeded for secret project free_tier_requests, limit: 0",
						details: [
							{
								violations: [
									{
										quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
										quotaValue: "0",
									},
								],
							},
						],
					},
				},
				expectedCode: "billing_required",
				expectedDetail: "free_tier_limit_zero",
				expectedFailure: "GEMINI_API:BILLING_REQUIRED",
				expectedAttempts: 1,
			},
			{
				status: 429,
				body: {
					error: {
						status: "RESOURCE_EXHAUSTED",
						message: "Daily quota exceeded for secret project",
						details: [
							{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel", quotaValue: "100" }] },
						],
					},
				},
				expectedCode: "quota_exhausted",
				expectedDetail: "daily_quota_exhausted",
				expectedFailure: "GEMINI_API:QUOTA_EXHAUSTED",
				expectedAttempts: 1,
			},
			{
				status: 400,
				body: {
					error: {
						status: "INVALID_ARGUMENT",
						message: "secret prompt fragment",
					},
				},
				expectedCode: "invalid_request",
				expectedDetail: null,
				expectedFailure: "GEMINI_API:REQUEST_REJECTED",
				expectedAttempts: 1,
			},
			{
				status: 404,
				body: {
					error: {
						status: "NOT_FOUND",
						message: "model not found",
					},
				},
				expectedCode: "model_unavailable",
				expectedDetail: "model_not_found",
				expectedFailure: "GEMINI_API:MODEL_UNAVAILABLE",
				expectedAttempts: 1,
			},
			{
				status: 429,
				body: {
					error: {
						status: "RESOURCE_EXHAUSTED",
						message: "quota exceeded for secret project",
					},
				},
				expectedCode: "quota_exhausted",
				expectedDetail: "rate_limited",
				expectedFailure: "GEMINI_API:QUOTA_EXHAUSTED",
				expectedAttempts: 3,
			},
			{
				status: 503,
				body: {
					error: {
						status: "UNAVAILABLE",
						message: "overloaded backend",
					},
				},
				expectedCode: "provider_outage",
				expectedDetail: "overloaded",
				expectedFailure: "GEMINI_API:PROVIDER_OUTAGE",
				expectedAttempts: 3,
			},
		] as const;

		for (const item of cases) {
			let attempts = 0;
			const errorFetch: typeof fetch = async () => {
				attempts += 1;
				return new Response(JSON.stringify(item.body), {
					status: item.status,
					headers: { "content-type": "application/json" },
				});
			};
			const err = await runCloudGeminiToolSession({
				boundary: makeBoundary([]),
				observability,
				model: "gemini-4-neon",
				effort: "low",
				apiKey: CANARY_KEY,
				apiBaseUrl: "http://127.0.0.1:1",
				allowLoopback: true,
				fetch: errorFetch,
				initialSpendMicrodollars: 0,
				monthlyCapCents: null,
				prompt: "Check error classification",
				signal: AbortSignal.timeout(15_000),
			}).catch((failure: unknown) => failure);
			expect(attempts).toBe(item.expectedAttempts);
			expect(err).toBeInstanceOf(GeminiProviderError);
			expect(geminiProviderErrorCode(err)).toBe(item.expectedCode);
			expect(geminiProviderFailureCode(err)).toBe(item.expectedFailure);
			const diag = geminiProviderDiagnostic(err) ?? "";
			expect(diag).toContain(`geminiCode=${item.expectedCode}`);
			if (item.expectedDetail) expect(diag).toContain(`geminiDetail=${item.expectedDetail}`);
			expect(diag).toContain(`httpStatus=${item.status}`);
			expect(diag).not.toContain("secret");
		}
	});

	it("stops retries on long RetryInfo delays and honors bounded Retry-After and RetryInfo waits", async () => {
		let longDelayAttempts = 0;
		const longDelayErr = await runCloudGeminiToolSession({
			boundary: makeBoundary([]),
			model: "gemini-4-neon",
			effort: "low",
			apiKey: CANARY_KEY,
			apiBaseUrl: "http://127.0.0.1:1",
			allowLoopback: true,
			fetch: async () => {
				longDelayAttempts += 1;
				return new Response(
					JSON.stringify({
						error: {
							status: "RESOURCE_EXHAUSTED",
							message: "Quota temporarily exhausted",
							details: [{ retryDelay: "30s" }],
						},
					}),
					{ status: 429, headers: { "content-type": "application/json" } },
				);
			},
			initialSpendMicrodollars: 0,
			monthlyCapCents: null,
			prompt: "Stop on long retry delay",
			signal: AbortSignal.timeout(10_000),
		}).catch((failure: unknown) => failure);
		expect(longDelayAttempts).toBe(1);
		expect(longDelayErr).toBeInstanceOf(GeminiProviderError);
		expect(geminiProviderErrorCode(longDelayErr)).toBe("quota_exhausted");

		vi.useFakeTimers();
		try {
			let attempts = 0;
			const controller = new AbortController();
			const run = runCloudGeminiToolSession({
				boundary: makeBoundary([]),
				model: "gemini-4-neon",
				effort: "low",
				apiKey: CANARY_KEY,
				apiBaseUrl: "http://127.0.0.1:1",
				allowLoopback: true,
				fetch: async () => {
					attempts += 1;
					if (attempts === 1) {
						return new Response(
							JSON.stringify({ error: { status: "RESOURCE_EXHAUSTED", message: "Rate limited" } }),
							{ status: 429, headers: { "content-type": "application/json", "retry-after": "2" } },
						);
					}
					if (attempts === 2) {
						return new Response(
							JSON.stringify({
								error: { status: "UNAVAILABLE", message: "Overloaded", details: [{ retryDelay: "20s" }] },
							}),
							{ status: 503, headers: { "content-type": "application/json" } },
						);
					}
					return new Response(
						JSON.stringify({
							candidates: [{ content: { role: "model", parts: [{ text: "Recovered." }] } }],
							usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 },
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				},
				initialSpendMicrodollars: 0,
				monthlyCapCents: null,
				prompt: "Retry with bounded waits",
				signal: controller.signal,
			});

			await vi.advanceTimersByTimeAsync(1_999);
			expect(attempts).toBe(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(attempts).toBe(2);

			await vi.advanceTimersByTimeAsync(14_999);
			expect(attempts).toBe(2);
			await vi.advanceTimersByTimeAsync(1);
			expect(attempts).toBe(3);

			const result = await run;
			expect(result.codexVersion).toBe("gemini-4-neon");
		} finally {
			vi.useRealTimers();
		}
	});

	it("parses SSE streams incrementally, assembles split UTF-8 text/thoughts/tool calls, and emits live message_composition", async () => {
		const observed: Array<{
			operation: string;
			phase: "start" | "finish";
			status?: string;
			parentAttemptId?: string;
			logicalOperationSha256?: string;
		}> = [];
		let attemptCounter = 0;
		const observability = {
			start: (operation: string, opts?: { logicalOperationSha256?: string; parentAttemptId?: string }) => {
				const attemptId = `attempt-${++attemptCounter}`;
				observed.push({
					operation,
					phase: "start",
					parentAttemptId: opts?.parentAttemptId,
					logicalOperationSha256: opts?.logicalOperationSha256,
				});
				return {
					attemptId,
					finish: (status: string) => {
						observed.push({
							operation,
							phase: "finish",
							status,
							parentAttemptId: opts?.parentAttemptId,
							logicalOperationSha256: opts?.logicalOperationSha256,
						});
					},
				};
			},
		} as unknown as CloudRuntimeObservability;

		const executeLookup = vi.fn<CloudNativeTool["execute"]>(async () => ({
			kind: "text",
			value: "Q4 revenue is 420k",
		}));
		const boundary = makeBoundary([
			{
				name: "lookup_metric",
				description: "Lookup a metric",
				source: "company_file",
				inputSchema: {
					type: "object",
					additionalProperties: false,
					properties: { key: { type: "string" } },
					required: ["key"],
				},
				parseArguments: (args) => args,
				execute: executeLookup,
			},
		]);

		let sawCompositionMidStream = false;
		let releaseSecondTextChunk!: () => void;
		const secondChunkGate = new Promise<void>((resolve) => {
			releaseSecondTextChunk = resolve;
		});
		const seenUrls: string[] = [];
		const seenBodies: Array<Record<string, unknown>> = [];
		let callCount = 0;
		const sseFetch: typeof fetch = async (input, init) => {
			seenUrls.push(String(input));
			seenBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
			callCount += 1;
			const enc = new TextEncoder();
			if (callCount === 1) {
				// WHY: Thought-only + tool-call turn must preserve thoughtSignature verbatim without emitting message_composition.
				const frames = [
					`: keepalive\n\n`,
					`data: ${JSON.stringify({
						candidates: [{ content: { role: "model", parts: [{ thought: true, text: "Need to " }] } }],
						usageMetadata: { promptTokenCount: 1000 },
					})}\n\n`,
					`data: ${JSON.stringify({
						candidates: [
							{
								content: {
									role: "model",
									parts: [
										{ thought: true, text: "check metric", thoughtSignature: "sig-thought-1" },
										{
											functionCall: { id: "call_sse_1", name: "lookup_metric", args: { key: "rev" } },
											thoughtSignature: "sig-call-1",
										},
									],
								},
								finishReason: "STOP",
							},
						],
						usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 30, thoughtsTokenCount: 20 },
					})}\n\n`,
				];
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						for (const frame of frames) controller.enqueue(enc.encode(frame));
						controller.close();
					},
				});
				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream; charset=utf-8" },
				});
			}

			// WHY: Split a multi-byte UTF-8 character across chunks and gate the final chunk to prove message_composition starts live.
			const euroFrame = enc.encode(
				`data: ${JSON.stringify({
					candidates: [{ content: { role: "model", parts: [{ text: "Revenue €" }] } }],
					usageMetadata: { promptTokenCount: 1200 },
				})}\n\n`,
			);
			const euroIdx = euroFrame.indexOf(0xe2);
			const firstHalf = euroFrame.slice(0, euroIdx + 1);
			const secondHalf = euroFrame.slice(euroIdx + 1);
			const finalFrame = enc.encode(
				`data: ${JSON.stringify({
					candidates: [
						{
							content: { role: "model", parts: [{ text: "420k." }] },
							finishReason: "STOP",
							groundingMetadata: { webSearchQueries: ["q4 revenue"] },
						},
					],
					usageMetadata: {
						promptTokenCount: 1200,
						cachedContentTokenCount: 400,
						candidatesTokenCount: 25,
						thoughtsTokenCount: 5,
					},
				})}\n\n`,
			);
			const stream = new ReadableStream<Uint8Array>({
				async start(controller) {
					controller.enqueue(firstHalf);
					controller.enqueue(secondHalf);
					await secondChunkGate;
					controller.enqueue(finalFrame);
					controller.close();
				},
			});
			return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
		};

		const usageCalls: GeminiToolSessionUsage[] = [];
		const runPromise = runCloudGeminiToolSession({
			boundary,
			observability,
			model: "gemini-4-neon",
			effort: "high",
			apiKey: CANARY_KEY,
			apiBaseUrl: "http://127.0.0.1:1",
			allowLoopback: true,
			fetch: sseFetch,
			initialSpendMicrodollars: 0,
			monthlyCapCents: null,
			prompt: "What is Q4 revenue?",
			onUsage: async (usage) => {
				usageCalls.push(usage);
				return { monthSpendMicrodollars: 0, monthlyCapCents: null, capReached: false };
			},
			signal: AbortSignal.timeout(10_000),
		});

		await vi.waitFor(() => {
			if (observed.some((row) => row.operation === "message_composition" && row.phase === "start")) {
				sawCompositionMidStream = true;
			}
			expect(sawCompositionMidStream).toBe(true);
		});
		// WHY: While the SSE stream is still open, message_composition must be started and not yet finished.
		expect(observed.filter((row) => row.operation === "message_composition")).toHaveLength(1);
		releaseSecondTextChunk();

		const result = await runPromise;
		expect(result.toolCalls).toBe(1);
		expect(seenUrls).toEqual([
			"http://127.0.0.1:1/v1beta/models/gemini-4-neon:streamGenerateContent?alt=sse",
			"http://127.0.0.1:1/v1beta/models/gemini-4-neon:streamGenerateContent?alt=sse",
		]);
		expect(usageCalls).toEqual([
			{ inputTokens: 1000, cachedTokens: 0, outputTokens: 50 },
			{ inputTokens: 2200, cachedTokens: 400, outputTokens: 80 },
		]);

		const secondTurnContents = seenBodies[1]?.contents as Array<{
			role: string;
			parts: Array<Record<string, unknown>>;
		}>;
		expect(secondTurnContents[1]?.parts).toEqual([
			{ thought: true, text: "Need to check metric", thoughtSignature: "sig-thought-1" },
			{
				functionCall: { id: "call_sse_1", name: "lookup_metric", args: { key: "rev" } },
				thoughtSignature: "sig-call-1",
			},
		]);

		const compositions = observed.filter((row) => row.operation === "message_composition");
		expect(compositions).toHaveLength(2);
		expect(compositions[0]).toMatchObject({ operation: "message_composition", phase: "start" });
		expect(compositions[1]).toMatchObject({
			operation: "message_composition",
			phase: "finish",
			status: "succeeded",
			logicalOperationSha256: compositions[0]?.logicalOperationSha256,
			parentAttemptId: compositions[0]?.parentAttemptId,
		});
	});

	it("handles SSE errors: retries mid-stream disconnect, fails closed on malformed JSON, byte limit, and in-stream error frames", async () => {
		const enc = new TextEncoder();

		let disconnectAttempts = 0;
		const disconnectResult = await runCloudGeminiToolSession({
			boundary: makeBoundary([]),
			model: "gemini-4-neon",
			effort: "low",
			apiKey: CANARY_KEY,
			apiBaseUrl: "http://127.0.0.1:1",
			allowLoopback: true,
			fetch: async () => {
				disconnectAttempts += 1;
				if (disconnectAttempts === 1) {
					const broken = new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(
								enc.encode(
									`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "Part" }] } }] })}\n\n`,
								),
							);
							controller.error(new Error("stream reset"));
						},
					});
					return new Response(broken, { status: 200, headers: { "content-type": "text/event-stream" } });
				}
				return new Response(
					`data: ${JSON.stringify({
						candidates: [{ content: { role: "model", parts: [{ text: "Recovered." }] } }],
						usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
					})}`,
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				);
			},
			initialSpendMicrodollars: 0,
			monthlyCapCents: null,
			prompt: "Recover from SSE drop",
			signal: AbortSignal.timeout(10_000),
		});
		expect(disconnectAttempts).toBe(2);
		expect(disconnectResult.fencedRequests).toBe(1);

		let malformedAttempts = 0;
		const malformedErr = await runCloudGeminiToolSession({
			boundary: makeBoundary([]),
			model: "gemini-4-neon",
			effort: "low",
			apiKey: CANARY_KEY,
			apiBaseUrl: "http://127.0.0.1:1",
			allowLoopback: true,
			fetch: async () => {
				malformedAttempts += 1;
				return new Response("data: {not-valid-json\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			},
			initialSpendMicrodollars: 0,
			monthlyCapCents: null,
			prompt: "Malformed SSE",
			signal: AbortSignal.timeout(10_000),
		}).catch((failure: unknown) => failure);
		expect(malformedAttempts).toBe(1);
		expect(nativeRuntimeFailureMetadata(malformedErr)).toMatchObject({ category: "provider_failed" });

		let streamErrAttempts = 0;
		const streamErr = await runCloudGeminiToolSession({
			boundary: makeBoundary([]),
			model: "gemini-4-neon",
			effort: "low",
			apiKey: CANARY_KEY,
			apiBaseUrl: "http://127.0.0.1:1",
			allowLoopback: true,
			fetch: async () => {
				streamErrAttempts += 1;
				return new Response(
					`data: ${JSON.stringify({
						error: { code: 403, status: "PERMISSION_DENIED", details: [{ reason: "BILLING_DISABLED" }] },
					})}\n\n`,
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				);
			},
			initialSpendMicrodollars: 0,
			monthlyCapCents: null,
			prompt: "In-stream error",
			signal: AbortSignal.timeout(10_000),
		}).catch((failure: unknown) => failure);
		expect(streamErrAttempts).toBe(1);
		expect(streamErr).toBeInstanceOf(GeminiProviderError);
		expect(geminiProviderErrorCode(streamErr)).toBe("billing_required");

		let oversizedAttempts = 0;
		const oversizedErr = await runCloudGeminiToolSession({
			boundary: makeBoundary([]),
			model: "gemini-4-neon",
			effort: "low",
			apiKey: CANARY_KEY,
			apiBaseUrl: "http://127.0.0.1:1",
			allowLoopback: true,
			fetch: async () => {
				oversizedAttempts += 1;
				let sent = 0;
				const huge = new ReadableStream<Uint8Array>({
					pull(controller) {
						if (sent >= 17 * 1024 * 1024) {
							controller.close();
							return;
						}
						const chunk = new Uint8Array(1024 * 1024).fill(0x20);
						sent += chunk.byteLength;
						controller.enqueue(chunk);
					},
				});
				return new Response(huge, { status: 200, headers: { "content-type": "text/event-stream" } });
			},
			initialSpendMicrodollars: 0,
			monthlyCapCents: null,
			prompt: "Oversized SSE",
			signal: AbortSignal.timeout(10_000),
		}).catch((failure: unknown) => failure);
		expect(oversizedAttempts).toBe(1);
		expect(nativeRuntimeFailureMetadata(oversizedErr)).toMatchObject({ category: "provider_failed" });
	});

	it("instructs against inline grounding citations and strips them from send_message and ask_member", async () => {
		expect(
			stripGeminiGroundingCitations(
				"IKEA Kreativ is locked to IKEA's catalog [1.1.3, 1.1.4]. One store [1.1.4], and 3D [1.1.4, 1.1.5]. Pro tiers cost $14-$127 [1.2.5, 1.2.9].",
			),
		).toBe("IKEA Kreativ is locked to IKEA's catalog. One store, and 3D. Pro tiers cost $14-$127.");
		expect(
			stripGeminiGroundingCitations("Release [1.2.3] adds `[1.1.3, 1.1.4]` and [1.1.4](https://example.com)"),
		).toBe("Release adds `[1.1.3, 1.1.4]` and [1.1.4](https://example.com)");
		expect(stripGeminiGroundingCitations("## [1.2.3]\n- [1.2.4] Fixed bug")).toBe("## [1.2.3]\n- [1.2.4] Fixed bug");
		expect(stripGeminiGroundingCitations("Summary [1.2].")).toBe("Summary [1.2].");
		expect(stripGeminiGroundingCitations("Adjacent [1.1.3] [1.1.4]. Next.")).toBe("Adjacent. Next.");
		expect(stripGeminiGroundingCitations("Summary [1.2] and detail [2.4, 3.1].", true)).toBe("Summary and detail.");

		const sentMessages: JsonValue[] = [];
		const askMessages: JsonValue[] = [];
		const sendTool: CloudNativeTool = {
			name: "send_message",
			description: "Send message to the user",
			source: "runtime",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				properties: { text: { type: "string" } },
				required: ["text"],
			},
			parseArguments: (args) => args,
			execute: vi.fn<CloudNativeTool["execute"]>(async (args) => {
				sentMessages.push(args);
				return { kind: "text", value: "ok" };
			}),
		};
		const askTool: CloudNativeTool = {
			name: "ask_member",
			description: "Ask a company member",
			source: "runtime",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				properties: { text: { type: "string" } },
				required: ["text"],
			},
			parseArguments: (args) => args,
			execute: vi.fn<CloudNativeTool["execute"]>(async (args) => {
				askMessages.push(args);
				return { kind: "text", value: "asked" };
			}),
		};
		const seenBodies: Record<string, unknown>[] = [];
		let turn = 0;
		const { baseUrl } = await startMockGemini((req) => {
			seenBodies.push(req.body);
			turn += 1;
			if (turn === 1) {
				return {
					body: {
						candidates: [
							{
								content: {
									role: "model",
									parts: [
										{
											functionCall: {
												id: "call_send",
												name: "send_message",
												args: {
													text: "On the consumer side, IKEA Kreativ uses one catalog [1.1.3, 1.1.4]. One store [1.1.4], and stagers pay every week [1.2].",
												},
											},
										},
									],
								},
								groundingMetadata: { webSearchQueries: ["ikea kreativ"] },
								finishReason: "STOP",
							},
						],
						usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 15 },
					},
				};
			}
			if (turn === 2) {
				return {
					body: {
						candidates: [
							{
								content: {
									role: "model",
									parts: [
										{
											functionCall: {
												id: "call_ask",
												name: "ask_member",
												args: { text: "Should we prioritize pros [1.2.5, 1.2.9]?" },
											},
										},
									],
								},
								finishReason: "STOP",
							},
						],
						usageMetadata: { promptTokenCount: 25, candidatesTokenCount: 10 },
					},
				};
			}
			return {
				body: {
					candidates: [{ content: { role: "model", parts: [{ text: "Done." }] }, finishReason: "STOP" }],
					usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 3 },
				},
			};
		});

		await runCloudGeminiToolSession({
			boundary: makeBoundary([sendTool, askTool]),
			model: "gemini-4-neon",
			effort: "low",
			apiKey: CANARY_KEY,
			apiBaseUrl: baseUrl,
			allowLoopback: true,
			initialSpendMicrodollars: 0,
			monthlyCapCents: null,
			prompt: "Compare consumer vs pro markets",
			runtimeInstructions: "Be concise.",
			signal: AbortSignal.timeout(10_000),
		});

		const sysParts = (
			(seenBodies[0]?.systemInstruction as { parts?: Array<{ text?: string }> } | undefined)?.parts ?? []
		)
			.map((p) => p.text ?? "")
			.join("\n");
		expect(sysParts).toContain("never include inline bracketed citation markers");
		expect(sentMessages).toEqual([
			{ text: "On the consumer side, IKEA Kreativ uses one catalog. One store, and stagers pay every week." },
		]);
		expect(askMessages).toEqual([{ text: "Should we prioritize pros?" }]);

		const ungroundedSent: JsonValue[] = [];
		const ungroundedSendTool: CloudNativeTool = {
			...sendTool,
			execute: vi.fn<CloudNativeTool["execute"]>(async (args) => {
				ungroundedSent.push(args);
				return { kind: "text", value: "ok" };
			}),
		};
		let ungroundedTurn = 0;
		const ungroundedMock = await startMockGemini(() => {
			ungroundedTurn += 1;
			if (ungroundedTurn === 1) {
				return {
					body: {
						candidates: [
							{
								content: {
									role: "model",
									parts: [
										{ executableCode: { language: "PYTHON", code: "print(1)" } },
										{
											functionCall: {
												id: "call_ip",
												name: "send_message",
												args: { text: "The staging box is [10.0.0.5]." },
											},
										},
									],
								},
								finishReason: "STOP",
							},
						],
						usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 8 },
					},
				};
			}
			return {
				body: {
					candidates: [{ content: { role: "model", parts: [{ text: "Done." }] }, finishReason: "STOP" }],
					usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 3 },
				},
			};
		});
		await runCloudGeminiToolSession({
			boundary: makeBoundary([ungroundedSendTool]),
			model: "gemini-4-neon",
			effort: "low",
			apiKey: CANARY_KEY,
			apiBaseUrl: ungroundedMock.baseUrl,
			allowLoopback: true,
			initialSpendMicrodollars: 0,
			monthlyCapCents: null,
			prompt: "Report staging IP",
			runtimeInstructions: "Be concise.",
			signal: AbortSignal.timeout(10_000),
		});
		expect(ungroundedSent).toEqual([{ text: "The staging box is [10.0.0.5]." }]);
	});
});
