import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCloudCodexToolSession } from "@qorpera/runtime/cloud-codex-tool-session";
import { CloudNativeToolBoundary, type CloudToolResult } from "@qorpera/runtime/cloud-native-tool-boundary";
import { CloudRunLog } from "@qorpera/runtime/cloud-run-log";
import { nativeCodexFixtureCommand } from "./native-codex-fixture-command.ts";

const QUERY = "qorpera web search probe";
const RESULT = "SEARCH_RESULT_CANARY: the probe's one result.";

function event(response: ServerResponse, value: Record<string, unknown>): void {
	response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
}

function stream(response: ServerResponse, model: string, ...items: Record<string, unknown>[]): void {
	const base = { id: `resp_${randomUUID()}`, object: "response", model, created_at: 1 };
	response.writeHead(200, { "content-type": "text/event-stream" });
	event(response, { type: "response.created", response: { ...base, status: "in_progress", output: [] } });
	items.forEach((item, index) => {
		event(response, {
			type: "response.output_item.added",
			output_index: index,
			item: { ...item, status: "in_progress" },
		});
		event(response, { type: "response.output_item.done", output_index: index, item });
	});
	const usage = { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, total_tokens: 11 };
	event(response, { type: "response.completed", response: { ...base, status: "completed", output: items, usage } });
	response.end();
}

function toolNames(parsed: { tools?: unknown[]; input: Array<Record<string, unknown>> }): string[] {
	const tools = [
		...(parsed.tools ?? []),
		...parsed.input.filter((item) => item.type === "additional_tools").flatMap((item) => item.tools as unknown[]),
	] as Array<{ type: string; name?: string; tools?: Array<{ name: string }> }>;
	return tools
		.flatMap((tool) =>
			tool.type === "namespace"
				? (tool.tools ?? []).map((nested) => `${tool.name}.${nested.name}`)
				: [tool.name ?? tool.type],
		)
		.sort();
}

export async function runNativeCodexWebSearchProbe(binary: string, model: string, hosted = false) {
	const root = await mkdtemp(join(tmpdir(), "qorpera-native-web-search-"));
	const abort = new AbortController();
	const runId = randomUUID();
	const log = new CloudRunLog({
		runId,
		conversationId: randomUUID(),
		signal: abort.signal,
		protection: {
			narrow: async () => ({ log: false, narrow: false }),
			hashes: async (run, digests) =>
				digests.map((digest) => createHmac("sha256", "web-search-probe").update(`${run}:${digest}`).digest("hex")),
		},
		folder: {
			locate: async () => ({ path: `runs/${runId}`, exists: true, missing: [], last: null, generation: 0 }),
			read: async () => null,
			commit: async (_key, units) => ({
				commitId: randomUUID(),
				seq: 1,
				replay: false,
				units: units.map((unit, index) => {
					if (unit.op !== "write") throw new Error("Unexpected unit");
					return {
						unit: index,
						op: unit.op,
						path: unit.path,
						to: null,
						version: unit.path,
						outcome: "saved" as const,
						reason: null,
						problems: [],
					};
				}),
			}),
		},
	});
	const boundary = new CloudNativeToolBoundary({
		companyId: randomUUID(),
		runId,
		runLog: log,
		signal: abort.signal,
		assertActive: async (signal) => signal.throwIfAborted(),
		tools: [
			{
				name: "read_document",
				source: "company_file",
				description: "Synthetic document.",
				inputSchema: { type: "object", properties: {}, additionalProperties: false },
				parseArguments: () => ({}),
				async execute() {
					return { kind: "text", value: "unused" };
				},
			},
		],
	});
	const inventories: string[][] = [];
	const searches: Array<Record<string, unknown>> = [];
	const outputs: Array<{ callId: string; output: string }> = [];
	let requests = 0;
	let fixtureFailure: unknown;
	const provider = createServer((request, response) => {
		void (async () => {
			let body = "";
			for await (const chunk of request) body += chunk.toString();
			if (request.method === "POST" && request.url?.endsWith("/alpha/search")) {
				searches.push(JSON.parse(body) as Record<string, unknown>);
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ output: RESULT, results: [{ type: "probe", url: "https://example.com/" }] }));
				return;
			}
			if (request.method !== "POST" || request.url !== "/v1/responses") {
				response.writeHead(404);
				response.end();
				return;
			}
			const parsed = JSON.parse(body) as {
				model: string;
				tools?: unknown[];
				input: Array<Record<string, unknown>>;
			};
			const number = ++requests;
			assert(number <= 2, "Unexpected extra native model request");
			inventories.push(toolNames(parsed));
			for (const item of parsed.input)
				if (item.type === "function_call_output")
					outputs.push({ callId: String(item.call_id), output: String(item.output) });
			if (number === 1 && hosted)
				stream(
					response,
					parsed.model,
					{
						type: "web_search_call",
						id: "ws_hosted",
						status: "completed",
						action: { type: "search", query: QUERY },
					},
					{
						type: "function_call",
						id: "fc_read",
						call_id: "read1",
						namespace: "qorpera",
						name: "read_document",
						arguments: "{}",
						status: "completed",
					},
				);
			else if (number === 1)
				stream(response, parsed.model, {
					type: "function_call",
					id: "fc_ws1",
					call_id: "ws1",
					namespace: "web",
					name: "run",
					arguments: JSON.stringify({ search_query: [{ q: QUERY }] }),
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
		const command = await nativeCodexFixtureCommand(root, [binary], address.port, undefined, true);
		const failure = await runCloudCodexToolSession({
			...command,
			boundary,
			model,
			prompt: "Synthetic web search acceptance.",
			signal: abort.signal,
			timeoutMs: 20_000,
		}).then(
			() => null,
			(error: unknown) => String(error),
		);
		if (fixtureFailure) throw fixtureFailure;
		await log.close(new AbortController().signal);
		const diagnostics = await readFile(join(root, "native-diagnostics.log"), "utf8").catch(() => "");
		const sent = outputs.find((output) => output.callId === "ws1");
		const envelope = sent ? (JSON.parse(sent.output) as CloudToolResult) : undefined;
		const settings = searches[0]?.settings as Record<string, unknown> | undefined;
		const step = log.steps().find((entry) => entry.call === "ws1");
		return {
			requests,
			failure,
			fenceRefused: diagnostics.includes("Cloud result boundary unavailable"),
			inventories,
			searches: searches.length,
			searchedFor: (searches[0]?.commands as { search_query?: Array<{ q: string }> } | undefined)?.search_query?.[0]
				?.q,
			externalWebAccess: settings?.external_web_access,
			envelope: envelope
				? {
						trust: envelope.trust,
						status: envelope.status,
						callId: envelope.provenance.callId,
						text: envelope.content.text,
					}
				: null,
			step: step ? { tool: step.tool, args: step.args, finished: step.result !== null } : null,
		};
	} finally {
		abort.abort();
		provider.closeAllConnections();
		await new Promise<void>((resolve) => provider.close(() => resolve()));
		boundary.close();
		await rm(root, { recursive: true, force: true });
	}
}
