import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCloudCodexToolSession } from "@qorpera/runtime/cloud-codex-tool-session";
import {
	CloudNativeToolBoundary,
	type CloudToolResult,
	MAX_CLOUD_TOOL_RESULT_BYTES,
} from "@qorpera/runtime/cloud-native-tool-boundary";
import { nativeCodexFixtureCommand } from "./native-codex-fixture-command.ts";

const PROMPT = "Synthetic full result acceptance.";
/** A page of 40,000 bytes of numbered lines: more than one result holds, with a line break to escape on every line. */
const PAGE = Array.from(
	{ length: 1200 },
	(_, index) => `line ${String(index).padStart(5, "0")} of a long file, in words.\n`,
)
	.join("")
	.slice(0, 40_000);

function event(response: ServerResponse, value: Record<string, unknown>): void {
	response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
}

function stream(response: ServerResponse, model: string, item: Record<string, unknown>): void {
	const base = { id: `resp_${randomUUID()}`, object: "response", model, created_at: 1 };
	response.writeHead(200, { "content-type": "text/event-stream" });
	event(response, { type: "response.created", response: { ...base, status: "in_progress", output: [] } });
	event(response, { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress" } });
	event(response, { type: "response.output_item.done", output_index: 0, item });
	const usage = { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, total_tokens: 11 };
	event(response, { type: "response.completed", response: { ...base, status: "completed", output: [item], usage } });
	response.end();
}

/**
 * The real patched native process and host session on a scripted loopback provider: the model reads one page whose
 * text is longer than a result holds, and the next request must carry the host's envelope for it exactly as the host
 * issued it, at the full result bound. `model` is Codex's: `offline-probe` has no metadata in Codex (a 10,000-byte
 * fallback policy), `gpt-6-astra` is in the catalog the binary carries (10,000 tokens). Either way the boundary's
 * `tool_output_token_limit=65536` is what Codex's history keeps of one output, so the envelope stays whole.
 */
export async function runNativeCodexFullResultProbe(binary: string, model: string) {
	const root = await mkdtemp(join(tmpdir(), "qorpera-native-full-result-"));
	const abort = new AbortController();
	const issued: string[] = [];
	const outputs: string[] = [];
	let requests = 0;
	let fixtureFailure: unknown;
	const boundary = new CloudNativeToolBoundary({
		companyId: randomUUID(),
		runId: randomUUID(),
		signal: abort.signal,
		assertActive: async (signal) => signal.throwIfAborted(),
		tools: [
			{
				name: "read_page",
				source: "company_file",
				description: "Synthetic page of a long file.",
				inputSchema: { type: "object", properties: {}, additionalProperties: false },
				parseArguments: () => ({}),
				async execute() {
					return { kind: "text", value: PAGE };
				},
			},
		],
	});
	// What the host issued for each call, to compare with what the provider got.
	const invoke = boundary.invoke.bind(boundary);
	boundary.invoke = async (...args: Parameters<CloudNativeToolBoundary["invoke"]>) => {
		const response = await invoke(...args);
		issued.push(response.contentItems[0].text);
		return response;
	};
	const provider = createServer((request, response) => {
		void (async () => {
			// Codex may ask for a model list; this provider has none.
			if (request.method !== "POST" || request.url !== "/v1/responses") {
				response.writeHead(404);
				response.end();
				return;
			}
			let body = "";
			for await (const chunk of request) body += chunk.toString();
			const parsed = JSON.parse(body) as { model: string; input: Array<Record<string, unknown>> };
			const number = ++requests;
			assert(number <= 2, "Unexpected extra native model request");
			for (const item of parsed.input) if (item.type === "function_call_output") outputs.push(String(item.output));
			if (number === 1)
				stream(response, parsed.model, {
					type: "function_call",
					id: "fc_c1",
					call_id: "c1",
					namespace: "qorpera",
					name: "read_page",
					arguments: "{}",
					status: "completed",
				});
			else
				stream(response, parsed.model, {
					type: "message",
					id: "msg_done",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "PRIVATE_DONE", annotations: [] }],
				});
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
		const result = await runCloudCodexToolSession({
			...command,
			boundary,
			model,
			prompt: PROMPT,
			signal: abort.signal,
			timeoutMs: 20_000,
		}).then(
			() => null,
			(error: unknown) => String(error),
		);
		if (fixtureFailure) throw fixtureFailure;
		const diagnostics = await readFile(join(root, "native-diagnostics.log"), "utf8").catch(() => "");
		const sent = outputs[0];
		const envelope = sent === undefined ? undefined : (JSON.parse(sent) as CloudToolResult);
		return {
			requests,
			failure: result,
			fenceRefused: diagnostics.includes("Cloud result boundary unavailable"),
			issuedBytes: issued.map((text) => Buffer.byteLength(text)),
			sentBytes: outputs.map((text) => Buffer.byteLength(text)),
			sentAsIssued: sent !== undefined && sent === issued[0],
			status: envelope?.status ?? null,
			includedBytes: envelope?.content.includedBytes ?? null,
			truncated: envelope?.content.truncated ?? null,
			pageStart: envelope ? PAGE.startsWith(envelope.content.text) : false,
			bound: MAX_CLOUD_TOOL_RESULT_BYTES,
		};
	} finally {
		abort.abort();
		provider.closeAllConnections();
		await new Promise<void>((resolve) => provider.close(() => resolve()));
		boundary.close();
		await rm(root, { recursive: true, force: true });
	}
}
