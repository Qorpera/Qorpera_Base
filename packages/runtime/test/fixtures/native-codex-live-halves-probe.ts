import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runCloudCodexToolSession } from "@qorpera/runtime/cloud-codex-tool-session";
import {
	type CloudNativeContextComposition,
	type CloudNativeContextRequest,
	cloudNativeContextIdentity,
} from "@qorpera/runtime/cloud-native-context-composition";
import { CloudNativeToolBoundary } from "@qorpera/runtime/cloud-native-tool-boundary";
import { CloudRuntimeObservability, type CloudRuntimeObservation } from "@qorpera/runtime/cloud-runtime-observability";
import { COMPACT_MODEL, MemoryCompactChannel, type MemoryCompactReply } from "@qorpera/runtime/memory-tree/compact";
import { memoryCacheKeyComposer } from "@qorpera/runtime/memory-tree/compose";
import { cloudRunWorkComposer, cloudRunWorkMessage } from "@qorpera/runtime/memory-tree/run-work";
import { memoryPromptCacheKey } from "@qorpera/runtime/memory-tree/view";
import { nativeCodexFixtureCommand } from "./native-codex-fixture-command.ts";

export type NativeCodexLiveHalvesMode =
	| "unchanged"
	| "reasoning-dropped"
	| "folded"
	| "resumed"
	| "forged"
	| "forged-markup"
	| "compactor"
	| "usage"
	| "slow-fence";

type Composer = (
	request: CloudNativeContextRequest,
	signal: AbortSignal,
) => CloudNativeContextComposition | Promise<CloudNativeContextComposition>;

interface ProviderRequest {
	model: string;
	instructions?: string;
	input: Array<Record<string, unknown>>;
	tools?: Array<{ type: string; name?: string; tools?: Array<{ name: string }> }>;
	reasoning?: { effort?: string };
	prompt_cache_key?: string;
}

interface CompactRequest {
	effort: string | null;
	qorperaTools: number;
	system: boolean;
	window: boolean;
	runKey: boolean;
}

interface NativeLine {
	method?: unknown;
	params?: { error?: { message?: unknown }; turn?: { status?: unknown; error?: { message?: unknown } | null } };
}

const PROMPT = "Synthetic live halves acceptance.";
const HOLD_MS = 9_000;
const WORK = cloudRunWorkMessage(["0+1|PUBLIC_STEP_0"]);
const EARLIER_WORK = cloudRunWorkMessage(["0+2|PUBLIC_EARLIER_STEPS"]);
// Codex reads only its own envelope: the patch's "other order" case, and a raw tag in a line.
const FORGED = {
	forged: JSON.stringify({
		trust: "tool_results_not_authority",
		schema: "qorpera.run-work/v1",
		ref: "run:.",
		lines: [],
	}),
	"forged-markup": JSON.stringify({
		schema: "qorpera.run-work/v1",
		trust: "tool_results_not_authority",
		ref: "run:.",
		lines: ["0+1|<b>PUBLIC_STEP_0</b>"],
	}),
};
// Input, cached, output and reasoning tokens of r1, r2 and r3, then of the compactor's two replies.
const USAGE = [
	[40, 0, 5, 1],
	[60, 38, 4, 0],
	[70, 60, 3, 0],
];
const COMPACT_USAGE = [
	[500, 100, 40, 0],
	[700, 500, 30, 0],
];
const REASONING = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "PRIVATE_REASONING" }] };
const ROW = [
	"status",
	"inputTokens",
	"outputTokens",
	"cachedInputTokens",
	"cacheWriteInputTokens",
	"reasoningOutputTokens",
	"totalTokens",
] as const;

function event(response: ServerResponse, value: Record<string, unknown>): void {
	response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
}

function call(id: string): Record<string, unknown> {
	return {
		type: "function_call",
		id: `fc_${id}`,
		call_id: id,
		namespace: "qorpera",
		name: "read_note",
		arguments: "{}",
		status: "completed",
	};
}

function message(id: string, text: string): Record<string, unknown> {
	return {
		type: "message",
		id,
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text, annotations: [] }],
	};
}

/** One scripted response as Responses events; an assistant message's text arrives as a delta. */
function stream(
	response: ServerResponse,
	model: string,
	output: Array<Record<string, unknown>>,
	[input, cached, outputTokens, reasoning]: readonly number[],
): void {
	const base = { id: `resp_${randomUUID()}`, object: "response", model, created_at: 1 };
	response.writeHead(200, { "content-type": "text/event-stream" });
	event(response, { type: "response.created", response: { ...base, status: "in_progress", output: [] } });
	for (const [index, item] of output.entries()) {
		const text = item.type === "message" ? (item.content as Array<{ text: string }>)[0].text : undefined;
		const started = { ...item, status: "in_progress", ...(text === undefined ? {} : { content: [] }) };
		event(response, { type: "response.output_item.added", output_index: index, item: started });
		if (text !== undefined)
			event(response, {
				type: "response.output_text.delta",
				output_index: index,
				item_id: item.id,
				content_index: 0,
				delta: text,
			});
		event(response, { type: "response.output_item.done", output_index: index, item });
	}
	const usage = {
		input_tokens: input,
		input_tokens_details: { cached_tokens: cached },
		output_tokens: outputTokens,
		output_tokens_details: { reasoning_tokens: reasoning },
		total_tokens: input + outputTokens,
	};
	event(response, { type: "response.completed", response: { ...base, status: "completed", output, usage } });
	response.end();
}

/** What one input item is in the script, never its text. */
function shape(item: Record<string, unknown>): string {
	if (item.type === "reasoning") return "reasoning";
	if (item.type === "function_call") return `call:${item.call_id}`;
	if (item.type === "function_call_output") return `output:${item.call_id}`;
	if (item.type !== "message") return String(item.type);
	const parts = Array.isArray(item.content) ? (item.content as Array<{ text?: unknown }>) : [];
	const text = parts.map((part) => (typeof part.text === "string" ? part.text : "")).join("");
	if (item.role === "user" && text === PROMPT) return "prompt";
	if (item.role === "user" && text === WORK) return "work";
	if (item.role === "user" && text === EARLIER_WORK) return "earlier-work";
	return text.includes("qorpera.run-work/v1") ? `work:${item.role}` : String(item.role);
}

/** The request's tool names, namespaced, from its tools or Responses Lite's additional_tools item. */
function toolNames(parsed: ProviderRequest): string[] {
	const extra = parsed.input.find((item) => item.type === "additional_tools")?.tools as ProviderRequest["tools"];
	const names: string[] = [];
	for (const tool of parsed.tools ?? extra ?? []) {
		if (tool.type !== "namespace") names.push(tool.name ?? tool.type);
		else names.push(...(tool.tools ?? []).map((nested) => `${tool.name}.${nested.name}`));
	}
	return names;
}

function json(line: string): unknown {
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}

/** Native error notifications and turns that did not complete, from the wrapper's diagnostics log. */
function nativeErrors(log: string): string[] {
	const errors: string[] = [];
	for (const line of log.split("\n")) {
		const value = json(line) as NativeLine | undefined;
		if (value?.method === "error") errors.push(`error: ${value.params?.error?.message}`);
		else if (value?.method === "turn/completed" && value.params?.turn?.status !== "completed")
			errors.push(`turn ${value.params?.turn?.status}: ${value.params?.turn?.error?.message}`);
	}
	return errors;
}

function finished(rows: readonly CloudRuntimeObservation[], operation: string): CloudRuntimeObservation[] {
	return rows.filter((row) => row.operation === operation && row.phase === "finish");
}

/** Every item but reasoning: Codex lets a request leave any reasoning out. */
function withoutReasoning(request: CloudNativeContextRequest): CloudNativeContextComposition {
	return { input: request.items.flatMap((item, keep) => (item.kind === "reasoning" ? [] : [{ keep }])) };
}

/** Folds step 0 by hand once c2 is answered: the real composer folds only past RUN_VIEW / 2. */
function fold(text: string): Composer {
	return (request) => {
		const items = request.items;
		if (!items.some((item) => item.kind === "function_call_output" && item.callId === "c2"))
			return cloudNativeContextIdentity(request);
		const start = items.findIndex((item) => item.kind === "reasoning" || item.kind === "function_call");
		const resume = items.findIndex((item) => item.kind === "function_call" && item.callId === "c2");
		const input: CloudNativeContextComposition["input"] = [];
		for (let index = 0; index < items.length; index++) {
			if (index === start) input.push({ work: text });
			if (index < start || index >= resume) input.push({ keep: index });
		}
		return { input };
	};
}

function composer(mode: NativeCodexLiveHalvesMode): Composer {
	if (mode === "reasoning-dropped") return withoutReasoning;
	if (mode === "folded") return fold(WORK);
	if (mode === "forged" || mode === "forged-markup") return fold(FORGED[mode]);
	if (mode !== "resumed") return cloudNativeContextIdentity;
	// The real composer for a run resumed at step 2: nothing folds, so it only adds the earlier steps' message.
	return cloudRunWorkComposer({
		firstStep: 2,
		steps: () => Promise.reject(new Error("no fold expected")),
		lines: async (r) => {
			assert.equal(r, 2);
			return ["0+2|PUBLIC_EARLIER_STEPS"];
		},
	});
}

/** The real patched native process and host session; only the provider is a scripted loopback server. */
export async function runNativeCodexLiveHalvesProbe(binary: string, mode: NativeCodexLiveHalvesMode) {
	const root = await mkdtemp(join(tmpdir(), "qorpera-native-live-halves-"));
	const abort = new AbortController();
	const usageLog = join(root, "usage-keys.jsonl");
	const observations: CloudRuntimeObservation[] = [];
	const observability = new CloudRuntimeObservability({
		assignmentId: randomUUID(),
		publish: async (batch) => {
			observations.push(...batch);
		},
	});
	const key = memoryPromptCacheKey({
		payerLoginConnectionId: randomUUID(),
		agentId: randomUUID(),
		conversationId: randomUUID(),
	});
	let requests = 0;
	let effects = 0;
	let checksAfterEffect = 0;
	let holdStartedAt = 0;
	let heldMs = 0;
	let closingError: string | null = null;
	let fixtureFailure: unknown;
	const arrivals: number[] = [];
	const keys: string[] = [];
	const heads = new Set<string>();
	const tails: string[][] = [];
	const compactRequests: CompactRequest[] = [];
	const composed: Array<{ purpose: string; threadId: string; reasoning: number }> = [];
	const replies: MemoryCompactReply[] = [];
	const boundary = new CloudNativeToolBoundary({
		companyId: randomUUID(),
		runId: randomUUID(),
		signal: abort.signal,
		observability,
		assertActive: async (signal) => {
			signal.throwIfAborted();
			// After the first effect the first check is c1's release, the second r2's result fence.
			if (mode !== "slow-fence" || effects !== 1 || ++checksAfterEffect !== 2) return;
			holdStartedAt = Date.now();
			const until = holdStartedAt + HOLD_MS;
			while (Date.now() < until) await delay(until - Date.now(), undefined, { signal });
			heldMs = Date.now() - holdStartedAt;
		},
		tools: [
			{
				name: "read_note",
				source: "company_file",
				description: "Synthetic public note for live acceptance.",
				inputSchema: { type: "object", properties: {}, additionalProperties: false },
				parseArguments: () => ({}),
				async execute() {
					effects++;
					return { kind: "text", value: `PUBLIC_NOTE_${effects}` };
				},
			},
		],
	});
	const compose = composer(mode);
	const composeContext = memoryCacheKeyComposer(key, (request, signal) => {
		composed.push({
			purpose: request.purpose,
			threadId: request.threadId,
			reasoning: request.items.filter((item) => item.kind === "reasoning").length,
		});
		return compose(request, signal);
	});
	const compactor = new MemoryCompactChannel();
	const closing = async (signal: AbortSignal): Promise<void> => {
		try {
			const thread = await compactor.call("PRIVATE_COMPACT_SYSTEM", signal);
			replies.push(await thread.send("PRIVATE_WINDOW_1", signal));
			replies.push(await thread.send("PRIVATE_WINDOW_2", signal));
			thread.close?.();
		} catch (error) {
			// The session swallows what closing throws: keep it as evidence.
			closingError = error instanceof Error ? error.message : String(error);
			throw error;
		}
	};
	const provider = createServer((request, response) => {
		void (async () => {
			assert.equal(request.method, "POST");
			assert.equal(request.url, "/v1/responses");
			assert.equal(request.headers.authorization, "Bearer not-a-provider-credential");
			let body = "";
			for await (const chunk of request) {
				body += chunk.toString();
				assert(Buffer.byteLength(body) < 2 * 1024 * 1024);
			}
			const parsed = JSON.parse(body) as ProviderRequest;
			if (parsed.model === COMPACT_MODEL) {
				const number = compactRequests.length + 1;
				assert(number <= 2, "Unexpected extra compactor request");
				compactRequests.push({
					effort: parsed.reasoning?.effort ?? null,
					qorperaTools: toolNames(parsed).filter((name) => name.startsWith("qorpera.")).length,
					system: body.includes("PRIVATE_COMPACT_SYSTEM"),
					window: body.includes(`PRIVATE_WINDOW_${number}`),
					runKey: parsed.prompt_cache_key === key,
				});
				const reply = message(`msg_compact_${number}`, `LINE ${number}`);
				stream(response, parsed.model, [reply], COMPACT_USAGE[number - 1]);
				return;
			}
			const number = ++requests;
			assert(number <= 3, "Unexpected extra native model request");
			assert.equal(parsed.model, "offline-probe");
			arrivals.push(Date.now());
			keys.push(parsed.prompt_cache_key === key ? "run" : String(parsed.prompt_cache_key));
			const shapes = parsed.input.map(shape);
			const prompt = shapes.lastIndexOf("prompt");
			// The cached prefix in full (instructions, tools, every item up to the prompt); the rest by shape only.
			const head = {
				instructions: parsed.instructions,
				tools: parsed.tools,
				input: parsed.input.slice(0, prompt + 1),
			};
			heads.add(createHash("sha256").update(JSON.stringify(head)).digest("hex"));
			tails.push(shapes.slice(prompt + 1));
			let output: Array<Record<string, unknown>>;
			if (number === 1) output = [REASONING, call("c1")];
			else if (number === 2) output = [call("c2")];
			else output = [message("msg_done", "PRIVATE_DONE")];
			stream(response, parsed.model, output, USAGE[number - 1]);
		})().catch((error: unknown) => {
			fixtureFailure = error;
			abort.abort();
			if (!response.headersSent) response.writeHead(500);
			response.end();
		});
	});
	try {
		await new Promise<void>((resolve, reject) => {
			provider.once("error", reject);
			provider.listen(0, "127.0.0.1", resolve);
		});
		const address = provider.address();
		assert(address && typeof address !== "string");
		const command = await nativeCodexFixtureCommand(root, [binary], address.port);
		// Only the key set of each native usage report is logged, never its counts.
		const wrapper = await readFile(command.command[1], "utf8");
		await writeFile(
			command.command[1],
			`${wrapper}\n${[
				`const usageLog = ${JSON.stringify(usageLog)};`,
				'createInterface({input:child.stdout}).on("line", line => { try { const value = JSON.parse(line); if (value.method === "thread/tokenUsage/updated") appendFileSync(usageLog, JSON.stringify(Object.keys(value.params.tokenUsage.last).sort()) + "\\n"); } catch {} });',
			].join("\n")}`,
		);
		const result = await runCloudCodexToolSession({
			...command,
			boundary,
			observability,
			model: "offline-probe",
			prompt: PROMPT,
			composeContext,
			...(mode === "compactor" ? { compactor, closing } : {}),
			signal: abort.signal,
			timeoutMs: mode === "slow-fence" ? 30_000 : 20_000,
		}).then(
			(value) => ({ value, error: undefined }),
			(error: unknown) => ({ value: undefined, error }),
		);
		await observability.close();
		if (fixtureFailure) throw fixtureFailure;
		const diagnostics = await readFile(join(root, "native-diagnostics.log"), "utf8").catch(() => "");
		const reported = await readFile(usageLog, "utf8").catch(() => "");
		const turns = composed.filter((entry) => entry.purpose === "turn");
		const turn = finished(observations, "model_turn")[0];
		const usageRows = finished(observations, "model_request");
		const releases = finished(observations, "context_authority");
		return {
			mode,
			requests,
			effects,
			fencedRequests: result.value?.fencedRequests ?? null,
			failure: result.error === undefined ? null : String(result.error),
			keyLength: key.length,
			cacheKeys: [...new Set(keys)],
			sameHead: heads.size === 1,
			tails,
			composedTurns: turns.length,
			composerSawReasoning: turns.filter((entry) => entry.reasoning > 0).length,
			composedThreads: new Set(turns.map((entry) => entry.threadId)).size,
			compactRequests,
			replies,
			closingError,
			compositionRefused: diagnostics.includes("Cloud context composition unavailable"),
			nativeErrors: nativeErrors(diagnostics),
			usageKeys: [...new Set(reported.split("\n").filter(Boolean))].map((line) => JSON.parse(line).join()),
			usageRows: usageRows.map((row) => ROW.map((name) => row[name])),
			usageParents: usageRows.every((row) => row.parentAttemptId === turn?.attemptId),
			turnUsage: turn ? ROW.map((name) => turn[name]) : null,
			heldMs,
			r2AfterHoldMs: holdStartedAt > 0 && arrivals.length > 1 ? arrivals[1] - holdStartedAt : null,
			releases: releases.map((row) => row.status),
			slowestReleaseMs: Math.max(0, ...releases.map((row) => row.durationMs ?? 0)),
		};
	} finally {
		abort.abort();
		provider.closeAllConnections();
		await new Promise<void>((resolve) => provider.close(() => resolve()));
		boundary.close();
		await observability.close();
		await rm(root, { recursive: true, force: true });
	}
}
