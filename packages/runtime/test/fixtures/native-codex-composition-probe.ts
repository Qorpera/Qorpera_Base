import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCloudCodexToolSession } from "@qorpera/runtime/cloud-codex-tool-session";
import { CloudNativeToolBoundary } from "@qorpera/runtime/cloud-native-tool-boundary";
import { CloudRuntimeObservability, type CloudRuntimeObservation } from "@qorpera/runtime/cloud-runtime-observability";
import { nativeCodexFixtureCommand } from "./native-codex-fixture-command.ts";

const PUBLIC_TEXT = "PUBLIC_COMPOSITION_TEXT_CANARY";
const PRIVATE_TEXT = "PRIVATE_COMPOSITION_REASONING_CANARY";
const HOLD_MS = 2_200;

function event(response: ServerResponse, value: Record<string, unknown>): void {
	response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
}

async function waitFor(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!check()) {
		assert(Date.now() < deadline, "Native composition notification did not arrive before complete arguments");
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
}

/** Actual native process and the real host observer; only a scripted loopback provider is used. */
export async function runNativeCodexCompositionProbe(
	binary: string,
	mode: "delivery" | "cancelled",
	model: "offline-probe" | "provider-default" = "offline-probe",
): Promise<{
	mode: "delivery" | "cancelled";
	model: string;
	modelRequests: number;
	sends: number;
	heldBeforeCompleteArgumentsMs: number;
	earlyNativeStart: true;
	finishBeforeDispatch: boolean;
	cancelledCompositionClosed: boolean;
	metadataOnly: true;
}> {
	const root = await mkdtemp(join(tmpdir(), "qorpera-native-composition-"));
	const abort = new AbortController();
	const observations: CloudRuntimeObservation[] = [];
	const metadataLog = join(root, "composition-events.jsonl");
	const observability = new CloudRuntimeObservability({
		assignmentId: randomUUID(),
		publish: async (batch) => {
			observations.push(...batch);
		},
	});
	let requests = 0;
	let sends = 0;
	let releasedArguments = false;
	let heldMs = 0;
	let fixtureFailure: unknown;
	const composition = () => observations.filter((row) => row.operation === "message_composition");
	const boundary = new CloudNativeToolBoundary({
		companyId: randomUUID(),
		runId: randomUUID(),
		signal: abort.signal,
		observability,
		assertActive: async (signal) => signal.throwIfAborted(),
		tools: [
			{
				name: "send_message",
				source: "runtime",
				description: "Synthetic public send for composition acceptance.",
				inputSchema: {
					type: "object",
					properties: { text: { type: "string" } },
					required: ["text"],
					additionalProperties: false,
				},
				parseArguments(value) {
					assert(value && typeof value === "object" && !Array.isArray(value));
					assert.equal(value.text, PUBLIC_TEXT);
					return {};
				},
				async execute() {
					assert(releasedArguments, "Native dispatched the send before complete arguments");
					sends++;
					return { kind: "text", value: "Synthetic public send delivered" };
				},
			},
		],
	});
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
			const parsed = JSON.parse(body) as { model: string };
			const number = ++requests;
			assert(number <= 2, "Unexpected extra native model request");
			const base = { id: `resp_composition_${number}`, object: "response", model: parsed.model, created_at: 1 };
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.flushHeaders();
			event(response, { type: "response.created", response: { ...base, status: "in_progress", output: [] } });
			let output: Record<string, unknown>[];
			if (number === 1) {
				const reasoning = {
					type: "reasoning",
					id: "rs_private",
					summary: [{ type: "summary_text", text: PRIVATE_TEXT }],
				};
				event(response, { type: "response.output_item.added", output_index: 0, item: reasoning });
				event(response, { type: "response.output_item.done", output_index: 0, item: reasoning });
				const call = {
					type: "function_call",
					id: "fc_public",
					call_id: "composition_public",
					namespace: "qorpera",
					name: "send_message",
					arguments: "",
					status: "in_progress",
				};
				event(response, { type: "response.output_item.added", output_index: 1, item: call });
				await waitFor(() => composition().some((row) => row.phase === "start"));
				const start = Date.now();
				// A timer can fire a millisecond early by Date.now() (the loop's clock is cached): wait out the rest.
				while (Date.now() - start < HOLD_MS)
					await new Promise<void>((resolve) => setTimeout(resolve, HOLD_MS - (Date.now() - start)));
				heldMs = Date.now() - start;
				assert.equal(sends, 0, "Send executed while its arguments were still being composed");
				assert.equal(composition().filter((row) => row.phase === "finish").length, 0);
				if (mode === "cancelled") {
					abort.abort(new Error("Synthetic cancellation during incomplete message composition"));
					return;
				}
				releasedArguments = true;
				const completed = { ...call, arguments: JSON.stringify({ text: PUBLIC_TEXT }), status: "completed" };
				event(response, { type: "response.output_item.done", output_index: 1, item: completed });
				output = [reasoning, completed];
			} else {
				assert.equal(sends, 1);
				const message = {
					type: "message",
					id: "msg_private",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: PRIVATE_TEXT, annotations: [] }],
				};
				event(response, {
					type: "response.output_item.added",
					output_index: 0,
					item: { ...message, status: "in_progress" },
				});
				event(response, { type: "response.output_item.done", output_index: 0, item: message });
				output = [message];
			}
			event(response, {
				type: "response.completed",
				response: {
					...base,
					status: "completed",
					output,
					usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				},
			});
			response.end();
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
		// Capture exact native notification metadata and dispatch order before the
		// host receives it. No tool arguments or message/reasoning text are logged.
		const wrapper = await readFile(command.command[1], "utf8");
		await writeFile(
			command.command[1],
			`${wrapper}\n${[
				`const compositionLog = ${JSON.stringify(metadataLog)};`,
				'createInterface({input:child.stdout}).on("line", line => { try { const value = JSON.parse(line); if (value.method === "qorpera/messageComposition") appendFileSync(compositionLog, JSON.stringify({kind:"composition",params:value.params}) + "\\n"); else if (value.method === "item/tool/call") appendFileSync(compositionLog, JSON.stringify({kind:"dispatch",callId:value.params.callId}) + "\\n"); } catch {} });',
			].join("\n")}`,
		);
		const result = await runCloudCodexToolSession({
			...command,
			boundary,
			observability,
			model,
			prompt: "Synthetic composition acceptance.",
			signal: abort.signal,
			timeoutMs: 20_000,
		}).then(
			(value) => ({ value, error: undefined }),
			(error: unknown) => ({ value: undefined, error }),
		);
		await observability.close();
		if (fixtureFailure) throw fixtureFailure;
		if (mode === "cancelled") assert(result.error instanceof Error);
		else assert.equal(result.error, undefined);
		assert(heldMs >= HOLD_MS);
		assert.equal(sends, mode === "cancelled" ? 0 : 1);
		assert.equal(requests, mode === "cancelled" ? 1 : 2);
		const rows = (await readFile(metadataLog, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { kind: string; callId?: string; params?: Record<string, unknown> });
		const nativeCompositions = rows.filter((row) => row.kind === "composition");
		assert(nativeCompositions.length >= 1);
		for (const row of nativeCompositions) {
			assert(row.params);
			assert.deepEqual(Object.keys(row.params).sort(), ["callId", "phase", "threadId", "turnId"]);
			assert.equal(row.params.callId, "composition_public");
			assert(["start", "finish"].includes(row.params.phase as string));
		}
		const startIndex = rows.findIndex((row) => row.params?.phase === "start");
		assert.equal(startIndex, 0);
		const finishIndex = rows.findIndex((row) => row.params?.phase === "finish");
		const dispatchIndex = rows.findIndex((row) => row.kind === "dispatch");
		if (mode === "delivery")
			assert(
				finishIndex > startIndex && dispatchIndex > finishIndex,
				"Native finish must precede completed-argument tool dispatch",
			);
		else assert.equal(dispatchIndex, -1);
		const starts = composition().filter((row) => row.phase === "start");
		assert.equal(starts.length, 1, "Private assistant text must not create public composition state");
		for (const start of starts) {
			const finish = composition().find((row) => row.attemptId === start.attemptId && row.phase === "finish");
			assert(finish, "Composition remained active after session termination");
			assert.equal(finish.status, mode === "cancelled" ? "cancelled" : "succeeded");
		}
		const telemetry = JSON.stringify({ rows, observations });
		assert(
			!telemetry.includes(PUBLIC_TEXT) && !telemetry.includes(PRIVATE_TEXT),
			"Composition telemetry retained content",
		);
		return {
			mode,
			model,
			modelRequests: requests,
			sends,
			heldBeforeCompleteArgumentsMs: heldMs,
			earlyNativeStart: true,
			finishBeforeDispatch: mode === "delivery",
			cancelledCompositionClosed: mode === "cancelled",
			metadataOnly: true,
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
