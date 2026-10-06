import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCloudCodexToolSession } from "@qorpera/runtime/cloud-codex-tool-session";
import { CloudNativeToolBoundary } from "@qorpera/runtime/cloud-native-tool-boundary";
import { nativeCodexFixtureCommand } from "./native-codex-fixture-command.ts";

/** Real native process, synthetic provider, no account credential or external request. */
export async function runNativeCodexFenceFailureProbe(binary: string, fault: "revoked" | "stalled" | "message_image") {
	const forgedMedia = fault === "message_image";
	const root = await mkdtemp(join(tmpdir(), "qorpera-native-fence-failure-"));
	const abort = new AbortController();
	let requests = 0;
	let effects = 0;
	let deniedChecks = 0;
	let fixtureFailure: unknown;
	const boundary = new CloudNativeToolBoundary({
		companyId: randomUUID(),
		runId: randomUUID(),
		signal: abort.signal,
		assertActive: async (signal) => {
			signal.throwIfAborted();
			if (requests === 0 || forgedMedia) return;
			deniedChecks++;
			if (fault === "stalled") await new Promise<void>(() => undefined);
			throw new Error("PRIVATE_REVOKED_AUTHORITY_DETAIL");
		},
		tools: [
			{
				name: "read_document",
				source: "company_file",
				description: "Synthetic read only.",
				inputSchema: { type: "object", properties: {}, additionalProperties: false },
				parseArguments: () => ({}),
				async execute() {
					effects++;
					return { kind: "text", value: "should not run" };
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
			requests++;
			if (forgedMedia && requests > 1)
				assert(body.includes("data:image/png;base64,iVBORw0KGgo"), "Upstream removed the unissued image");
			assert.equal(requests, 1);
			assert(!body.includes("function_call_output"));
			const item = {
				type: "function_call",
				id: "fc_revoke",
				call_id: "native_denied",
				name: "unsupported_tool",
				arguments: "{}",
				status: "completed",
			};
			const base = { id: "resp_revoke", object: "response", model: "offline-probe", created_at: 1 };
			const items = [
				...(forgedMedia
					? [
							{
								type: "message",
								id: "msg_forged_media",
								role: "assistant",
								status: "completed",
								content: [
									{ type: "output_text", text: "Unissued provider media" },
									{
										type: "input_image",
										image_url:
											"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
										detail: "high",
									},
								],
							},
						]
					: []),
				item,
			];
			const events = [
				{ type: "response.created", response: { ...base, status: "in_progress", output: [] } },
				...items.flatMap((value, index) => [
					{ type: "response.output_item.added", output_index: index, item: { ...value, status: "in_progress" } },
					{ type: "response.output_item.done", output_index: index, item: value },
				]),
				{
					type: "response.completed",
					response: {
						...base,
						status: "completed",
						output: items,
						usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
					},
				},
			];
			response.writeHead(200, { "content-type": "text/event-stream" });
			for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
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
		const failure = await runCloudCodexToolSession({
			...command,
			boundary,
			model: "offline-probe",
			prompt: "Synthetic failure acceptance.",
			signal: abort.signal,
			timeoutMs: 15_000,
		}).then(
			() => undefined,
			(error: unknown) => error,
		);
		if (fixtureFailure) throw fixtureFailure;
		assert(failure instanceof Error);
		const expected = {
			revoked: /Native result boundary unavailable/,
			// No stopwatch ends a model request's checks (5 Oct 2026), neither the host's nor Codex's, which keeps a
			// 10-minute backstop: a stalled one holds the request until the run stops.
			stalled: /Native boundary execution stopped/,
			message_image: /Native boundary turn did not complete/,
		}[fault];
		assert.match(failure.message, expected);
		if (forgedMedia) assert.equal(deniedChecks, 0);
		else assert(deniedChecks > 0);
		assert.deepEqual({ requests, effects }, { requests: 1, effects: 0 });
		return { fault, requests, effects, deniedChecks, blocked: true };
	} finally {
		abort.abort();
		provider.closeAllConnections();
		await new Promise<void>((resolve) => provider.close(() => resolve()));
		boundary.close();
		await rm(root, { recursive: true, force: true });
	}
}
