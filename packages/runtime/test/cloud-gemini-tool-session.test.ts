import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { CloudActionReviewChannel } from "@qorpera/runtime/cloud-action-review";
import {
	GeminiCapReachedError,
	GeminiKeyRevokedError,
	type GeminiToolSessionUsage,
	geminiFunctionDeclarations,
	runCloudGeminiToolSession,
} from "@qorpera/runtime/cloud-gemini-tool-session";
import { type CloudNativeTool, CloudNativeToolBoundary } from "@qorpera/runtime/cloud-native-tool-boundary";
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
		expect(requests[0]?.path).toBe("/v1beta/models/gemini-4-neon:generateContent");
		expect(requests[0]?.apiKeyHeader).toBe(CANARY_KEY);
		expect(requests[0]?.body.generationConfig).toEqual({ thinkingConfig: { thinkingLevel: "high" } });
		expect(requests[0]?.body.tools).toEqual([
			{ functionDeclarations: expect.arrayContaining([expect.objectContaining({ name: "read_report" })]) },
			{ google_search: {} },
		]);

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
});
