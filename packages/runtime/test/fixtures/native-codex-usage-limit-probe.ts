import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCloudCodexToolSession } from "@qorpera/runtime/cloud-codex-tool-session";
import { nativeRuntimeFailureMetadata } from "@qorpera/runtime/cloud-native-failure";
import { CloudNativeToolBoundary } from "@qorpera/runtime/cloud-native-tool-boundary";
import { nativeCodexFixtureCommand } from "./native-codex-fixture-command.ts";

/** OpenAI's code for a ChatGPT plan's usage limit (Sign in with ChatGPT). Undocumented upstream in Codex 0.155.1,
 * which retried it as a lost stream or a 429; the pinned patch reads it as a usage limit. */
const PLAN_USAGE_LIMIT = "subscription_sharing_usage_limit_exceeded";

/** Real native process, synthetic provider, no account credential or external request. The provider ends the
 * turn at a ChatGPT plan's usage limit, mid-stream (`response.failed`) or before it (HTTP 429), as OpenAI documents
 * for Sign in with ChatGPT; the live response shape cannot be checked before OpenAI approves the partner track. */
export async function runNativeCodexUsageLimitProbe(binary: string, mode: "mid_stream" | "http_429") {
	const root = await mkdtemp(join(tmpdir(), "qorpera-native-usage-limit-"));
	const abort = new AbortController();
	let requests = 0;
	let fixtureFailure: unknown;
	const boundary = new CloudNativeToolBoundary({
		companyId: randomUUID(),
		runId: randomUUID(),
		signal: abort.signal,
		assertActive: async (signal) => signal.throwIfAborted(),
		tools: [],
	});
	const provider = createServer((request, response) => {
		void (async () => {
			assert.equal(request.method, "POST");
			assert.equal(request.url, "/v1/responses");
			for await (const chunk of request) assert(chunk.length < 2 * 1024 * 1024);
			requests++;
			const error = { code: PLAN_USAGE_LIMIT, message: "You have reached your ChatGPT plan's usage limit." };
			if (mode === "http_429") {
				response.writeHead(429, { "content-type": "application/json" });
				response.end(JSON.stringify({ error }));
				return;
			}
			const base = { id: "resp_plan_limit", object: "response", model: "offline-probe", created_at: 1 };
			const message = { type: "message", id: "msg_partial", role: "assistant", status: "in_progress", content: [] };
			const events = [
				{ type: "response.created", response: { ...base, status: "in_progress", output: [] } },
				{ type: "response.output_item.added", output_index: 0, item: message },
				{
					type: "response.output_text.delta",
					output_index: 0,
					item_id: "msg_partial",
					content_index: 0,
					delta: "Half",
				},
				{ type: "response.failed", response: { ...base, status: "failed", error } },
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
			prompt: "Synthetic usage-limit acceptance.",
			signal: abort.signal,
			timeoutMs: 15_000,
		}).then(
			() => undefined,
			(error: unknown) => error,
		);
		if (fixtureFailure) throw fixtureFailure;
		assert(failure instanceof Error, "The turn must fail at the usage limit");
		const metadata = nativeRuntimeFailureMetadata(failure);
		// Codex's own request retries to the same login are its concern; how many it made is reported, not judged.
		return { mode, requests, category: metadata?.category, usageSignal: metadata?.usageSignal };
	} finally {
		abort.abort();
		provider.closeAllConnections();
		await new Promise<void>((resolve) => provider.close(() => resolve()));
		boundary.close();
		await rm(root, { recursive: true, force: true });
	}
}
