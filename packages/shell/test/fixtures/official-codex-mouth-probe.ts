import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CloudAgentMouth,
	type CloudAgentSendInput,
	type CloudAgentSendReceipt,
} from "@qorpera/runtime/cloud-agent-mouth";
import { OfficialCliNativeHarnessDriver } from "@qorpera/runtime/cloud-native-provider-host";

/** Exercises the installed official CLI, with a loopback scripted provider and no real credentials or model calls. */
export async function runOfficialCodexMouthProbe(codexCommand: readonly [string, ...string[]]): Promise<{
	platform: string;
	publicMessages: number;
	immediateDelivery: boolean;
	retryDeduplicated: boolean;
	privateOutputExcluded: boolean;
}> {
	const root = await mkdtemp(join(tmpdir(), "qorpera-official-mouth-"));
	const runId = randomUUID();
	const sessionId = randomUUID();
	const messages = new Map<string, { input: CloudAgentSendInput; receipt: CloudAgentSendReceipt }>();
	const requestSendCounts: number[] = [];
	let executionFinished = false;
	let immediateDelivery = false;
	let deliveries = 0;
	let fixtureFailure: unknown;
	const mouth = new CloudAgentMouth(runId, async (input) => {
		deliveries++;
		const previous = messages.get(input.idempotencyKey);
		if (previous) {
			assert.deepEqual(previous.input, input);
			return previous.receipt;
		}
		const receipt: CloudAgentSendReceipt = {
			schema: "qorpera.agent-send/v1",
			runId,
			sessionId,
			messageId: randomUUID(),
			phase: input.phase,
			sequence: messages.size + 1,
		};
		messages.set(input.idempotencyKey, { input, receipt });
		if (input.phase === "progress") {
			immediateDelivery = !executionFinished;
			throw new Error("PRIVATE_LOST_RECEIPT_CANARY");
		}
		return receipt;
	});
	const provider = createServer((request, response) => {
		void (async () => {
			assert.equal(request.method, "POST");
			assert.equal(request.url, "/v1/responses");
			assert.equal(request.headers.authorization, "Bearer not-a-provider-credential");
			const chunks: Buffer[] = [];
			let bytes = 0;
			for await (const chunk of request) {
				const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
				bytes += buffer.length;
				assert(bytes < 1024 * 1024);
				chunks.push(buffer);
			}
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
				tools?: Array<{ type: string; name?: string; tools?: Array<{ name: string }> }>;
			};
			const toolNamespace = body.tools?.find((tool) => tool.type === "namespace" && tool.name === "mcp__qorpera");
			assert(toolNamespace);
			assert(toolNamespace.tools?.some((tool) => tool.name === "send_message"));
			requestSendCounts.push(messages.size);
			const index = requestSendCounts.length;
			assert(index <= 4);
			const phase = index <= 2 ? "progress" : "final";
			const output: Array<Record<string, unknown>> = [];
			if (index === 1) {
				output.push({
					type: "reasoning",
					id: "rs_private",
					summary: [{ type: "summary_text", text: "PRIVATE_REASONING_CANARY" }],
				});
			}
			output.push(
				index <= 3
					? {
							type: "function_call",
							id: `fc_${index}`,
							call_id: `call_${index}`,
							namespace: toolNamespace.name,
							name: "send_message",
							arguments: JSON.stringify({
								text: `PUBLIC_${phase.toUpperCase()}`,
								phase,
								idempotencyKey: `probe-${phase}`,
							}),
							status: "completed",
						}
					: {
							type: "message",
							id: "msg_private",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "PRIVATE_ORDINARY_TEXT_CANARY", annotations: [] }],
						},
			);
			const base = { id: `resp_${index}`, object: "response", model: "offline-probe", created_at: 1 };
			const events: Array<Record<string, unknown>> = [
				{ type: "response.created", response: { ...base, status: "in_progress", output: [] } },
			];
			for (const [outputIndex, item] of output.entries()) {
				events.push(
					{
						type: "response.output_item.added",
						output_index: outputIndex,
						item: { ...item, status: "in_progress" },
					},
					{ type: "response.output_item.done", output_index: outputIndex, item },
				);
			}
			events.push({
				type: "response.completed",
				response: {
					...base,
					status: "completed",
					output,
					usage: {
						input_tokens: 1,
						output_tokens: 1,
						total_tokens: 2,
						input_tokens_details: { cached_tokens: 0 },
						output_tokens_details: { reasoning_tokens: 0 },
					},
				},
			});
			response.writeHead(200, { "content-type": "text/event-stream" });
			for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
			response.end();
		})().catch((error: unknown) => {
			fixtureFailure = error;
			response.writeHead(500).end();
		});
	});
	try {
		const connection = await mouth.start();
		await new Promise<void>((resolve, reject) => {
			provider.once("error", reject);
			provider.listen(0, "127.0.0.1", resolve);
		});
		const address = provider.address();
		assert(address && typeof address !== "string");
		const providerConfiguration = `model_providers.qorpera_fixture={name="Offline mouth fixture",base_url="http://127.0.0.1:${address.port}/v1",env_key="QORPERA_OFFLINE_PROBE_KEY",wire_api="responses",requires_openai_auth=false}`;
		const wrapper = join(root, "codex-fixture.cjs");
		await writeFile(
			wrapper,
			[
				`#!${process.execPath}`,
				'const { spawn } = require("node:child_process");',
				`const [command, ...prefix] = ${JSON.stringify(codexCommand)};`,
				"const args = process.argv.slice(2);",
				`const child = spawn(command, [...prefix, args[0], "-c", 'model_provider="qorpera_fixture"', "-c", ${JSON.stringify(providerConfiguration)}, ...args.slice(1)], {`,
				'  env: { ...process.env, QORPERA_OFFLINE_PROBE_KEY: "not-a-provider-credential" },',
				'  stdio: "inherit",',
				"});",
				'process.on("SIGTERM", () => child.kill("SIGTERM"));',
				'child.on("error", () => process.exit(125));',
				'child.on("exit", code => process.exit(code ?? 1));',
			].join("\n"),
			{ mode: 0o700 },
		);
		const companyRoot = join(root, "company");
		await mkdir(companyRoot);
		const driver = new OfficialCliNativeHarnessDriver(wrapper);
		const result = await driver.execute({
			harness: "codex-cli",
			model: "offline-probe",
			identityRoot: join(root, "identity"),
			companyRoot,
			mouth: connection,
			prompt: "Offline scripted transport test. The provider is a loopback fixture, not a model service.",
			signal: AbortSignal.timeout(20_000),
		});
		executionFinished = true;
		if (fixtureFailure) throw fixtureFailure;
		assert.deepEqual(requestSendCounts, [0, 1, 1, 2]);
		assert.equal(deliveries, 3);
		assert.equal(messages.size, 2);
		assert.equal(immediateDelivery, true);
		assert.equal(mouth.diagnosticState, "delivered");
		assert.equal((await mouth.finish()).messageCount, 2);
		assert.deepEqual(
			[...messages.values()].map(({ input }) => input.text),
			["PUBLIC_PROGRESS", "PUBLIC_FINAL"],
		);
		assert(!JSON.stringify({ result, messages: [...messages.values()] }).includes("PRIVATE_"));
		return {
			platform: process.platform,
			publicMessages: messages.size,
			immediateDelivery,
			retryDeduplicated: true,
			privateOutputExcluded: true,
		};
	} finally {
		provider.closeAllConnections();
		await new Promise<void>((resolve) => provider.close(() => resolve()));
		await mouth.close();
		await rm(root, { recursive: true, force: true });
	}
}
