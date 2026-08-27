import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CLOUD_AGENT_SEND_SCHEMA,
	CloudAgentMouth,
	type CloudAgentMouthConnection,
	type CloudAgentSendInput,
	type CloudAgentSendReceipt,
	parseCloudAgentSendInput,
	parseCloudAgentSendReceipt,
} from "../src/cloud-agent-mouth.ts";
import { runCloudMouthProbe } from "./fixtures/cloud-mouth-probe.ts";

const runId = "19000000-0000-4000-8000-000000000001";
const sessionId = "19000000-0000-4000-8000-000000000002";
const messageId = "19000000-0000-4000-8000-000000000003";
const finalMessageId = "19000000-0000-4000-8000-000000000004";
const mouths: CloudAgentMouth[] = [];

function receipt(input: CloudAgentSendInput): CloudAgentSendReceipt {
	return {
		schema: CLOUD_AGENT_SEND_SCHEMA,
		runId,
		sessionId,
		messageId: input.phase === "final" ? finalMessageId : messageId,
		phase: input.phase,
		sequence: input.phase === "final" ? 2 : 1,
	};
}

async function start(
	send: (input: CloudAgentSendInput) => Promise<CloudAgentSendReceipt>,
	signal?: AbortSignal,
): Promise<{ mouth: CloudAgentMouth; connection: CloudAgentMouthConnection }> {
	const mouth = new CloudAgentMouth(runId, send, signal);
	mouths.push(mouth);
	return { mouth, connection: await mouth.start() };
}

function rpc(
	connection: CloudAgentMouthConnection,
	method: string,
	params?: unknown,
	headers: Record<string, string> = {},
): Promise<Response> {
	return fetch(connection.url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			authorization: `Bearer ${connection.bearerToken}`,
			...headers,
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
}

async function send(connection: CloudAgentMouthConnection, input: unknown): Promise<unknown> {
	const response = await rpc(connection, "tools/call", { name: "send_message", arguments: input });
	expect(response.status).toBe(200);
	return response.json();
}

afterEach(async () => {
	await Promise.all(mouths.splice(0).map((mouth) => mouth.close()));
});

describe("cloud agent public mouth", () => {
	it("runs the native process loop without publishing its reasoning, diagnostics or ordinary text", async () => {
		await expect(runCloudMouthProbe()).resolves.toMatchObject({
			publicMessages: 2,
			immediateDelivery: true,
			retryDeduplicated: true,
			privateOutputExcluded: true,
		});
	});
	it("accepts only text, phase and an idempotency key, never caller-selected authority or reasoning", () => {
		const input = { idempotencyKey: "result-1", text: "Finished", phase: "final" };
		expect(parseCloudAgentSendInput(input)).toEqual(input);
		for (const invalid of [
			{ ...input, sessionId },
			{ ...input, runId },
			{ ...input, agentId: runId },
			{ ...input, thinking: "private" },
			{ ...input, content: [{ type: "toolCall" }] },
			{ ...input, text: " \n\t" },
			{ ...input, text: "secret\0text" },
			{ ...input, text: "é".repeat(32_769) },
			{ ...input, phase: "analysis" },
			{ ...input, idempotencyKey: "../result" },
			{ ...input, idempotencyKey: "" },
		])
			expect(() => parseCloudAgentSendInput(invalid)).toThrow("Invalid send arguments");
		const delivered = receipt({ ...input, phase: "final" });
		for (const invalid of [
			{ ...delivered, runId: sessionId },
			{ ...delivered, sequence: 0 },
			{ ...delivered, text: "unexpected private payload" },
			{ ...delivered, messageId: "invalid" },
		])
			expect(() => parseCloudAgentSendReceipt(invalid, runId)).toThrow("Invalid send receipt");
	});

	it("exposes one run-scoped tool over authenticated loopback MCP", async () => {
		const deliver = vi.fn(async (input: CloudAgentSendInput) => receipt(input));
		const { mouth, connection } = await start(deliver);
		expect(mouth.diagnosticState).toBe("uninitialized");
		expect((await rpc(connection, "tools/list", {}, { authorization: "" })).status).toBe(403);
		expect(mouth.diagnosticState).toBe("uninitialized");
		expect(connection.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
		const initialized = await rpc(connection, "initialize", { protocolVersion: "2025-06-18" });
		expect(mouth.diagnosticState).toBe("initialized");
		expect(await initialized.json()).toMatchObject({
			result: {
				protocolVersion: "2025-06-18",
				instructions: expect.stringContaining("one public voice"),
			},
		});
		const listed = await rpc(connection, "tools/list");
		expect(mouth.diagnosticState).toBe("ready");
		expect(await listed.json()).toMatchObject({
			result: {
				tools: [
					{
						name: "send_message",
						inputSchema: {
							additionalProperties: false,
							required: ["text", "phase", "idempotencyKey"],
						},
					},
				],
			},
		});
		const rejectedHeaders: Record<string, string>[] = [
			{ authorization: "" },
			{ authorization: `Bearer ${"x".repeat(43)}` },
			{ origin: "https://untrusted.example" },
		];
		for (const headers of rejectedHeaders)
			expect((await rpc(connection, "tools/list", {}, headers)).status).toBe(403);
		const reboundStatus = await new Promise<number | undefined>((resolve, reject) => {
			const incoming = request(
				connection.url,
				{
					method: "POST",
					headers: {
						host: "untrusted.example",
						authorization: `Bearer ${connection.bearerToken}`,
					},
				},
				(response) => {
					response.resume();
					resolve(response.statusCode);
				},
			);
			incoming.once("error", reject);
			incoming.end();
		});
		expect(reboundStatus).toBe(403);
		expect((await rpc(connection, "tools/list", {}, { "mcp-protocol-version": "invalid" })).status).toBe(400);
		expect((await rpc(connection, "tools/list", {}, { "content-type": "text/plain" })).status).toBe(400);
		expect(
			(await fetch(connection.url, { headers: { authorization: `Bearer ${connection.bearerToken}` } })).status,
		).toBe(405);
		expect((await rpc({ ...connection, url: `${connection.url}/other` }, "tools/list")).status).toBe(404);
		expect(deliver).not.toHaveBeenCalled();
	});

	it("confirms durable sends immediately and deduplicates replay after a lost response", async () => {
		const durable = new Map<string, CloudAgentSendReceipt>();
		let loseFirstResponse = true;
		const deliver = vi.fn(async (input: CloudAgentSendInput) => {
			const committed = durable.get(input.idempotencyKey) ?? receipt(input);
			durable.set(input.idempotencyKey, committed);
			if (loseFirstResponse) {
				loseFirstResponse = false;
				throw new Error("private database response and credentials");
			}
			return committed;
		});
		const { mouth, connection } = await start(deliver);
		const progress = { idempotencyKey: "progress-1", text: "Checking the Company File", phase: "progress" };
		const failed = await send(connection, progress);
		expect(mouth.diagnosticState).toBe("send-unconfirmed");
		expect(failed).toMatchObject({ result: { isError: true } });
		expect(JSON.stringify(failed)).not.toContain("private database");
		const replayed = await send(connection, progress);
		expect(mouth.diagnosticState).toBe("delivered");
		expect(replayed).toMatchObject({ result: { structuredContent: { messageId, sequence: 1 } } });
		expect(await send(connection, progress)).toEqual(replayed);
		expect(durable.size).toBe(1);
		const final = { idempotencyKey: "final-1", text: "Finished", phase: "final" };
		expect(await send(connection, final)).toMatchObject({
			result: { structuredContent: { messageId: finalMessageId } },
		});
		expect(await mouth.finish()).toEqual({ messageCount: 2, finalMessageId });
		expect(deliver).toHaveBeenCalledTimes(4);
		expect((await rpc(connection, "tools/list")).status).toBe(403);
	});

	it("serializes simultaneous sends and waits for the cloud receipt before acknowledging", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const calls: string[] = [];
		const { mouth, connection } = await start(async (input) => {
			calls.push(input.idempotencyKey);
			if (input.phase === "progress") await gate;
			return receipt(input);
		});
		let acknowledged = false;
		const progress = send(connection, { idempotencyKey: "first", text: "Working", phase: "progress" }).then(() => {
			acknowledged = true;
		});
		await vi.waitFor(() => expect(calls).toEqual(["first"]));
		const final = send(connection, { idempotencyKey: "last", text: "Done", phase: "final" });
		expect(acknowledged).toBe(false);
		release();
		await Promise.all([progress, final]);
		expect(calls).toEqual(["first", "last"]);
		expect(await mouth.finish()).toEqual({ messageCount: 2, finalMessageId });
	});

	it("rejects missing final delivery, but permits an explicitly silent job with no audience", async () => {
		const first = await start(async (input) => receipt(input));
		await expect(first.mouth.finish()).rejects.toThrow("without a final send");
		const second = await start(async (input) => receipt(input));
		await send(second.connection, { idempotencyKey: "ack", text: "On it", phase: "progress" });
		await expect(second.mouth.finish()).rejects.toThrow("without a final send");
		const silent = await start(async (input) => receipt(input));
		await expect(silent.mouth.finish(false)).resolves.toEqual({ messageCount: 0, finalMessageId: null });
	});

	it("revokes a run token on cancellation and does not treat malformed receipts as delivery", async () => {
		const abort = new AbortController();
		const deliver = vi.fn(async (input: CloudAgentSendInput) => ({ ...receipt(input), runId: sessionId }));
		const { mouth, connection } = await start(deliver, abort.signal);
		const input = { idempotencyKey: "final", text: "Done", phase: "final" };
		expect(await send(connection, { ...input, sessionId })).toMatchObject({ result: { isError: true } });
		expect(deliver).not.toHaveBeenCalled();
		expect(await send(connection, input)).toMatchObject({ result: { isError: true } });
		await expect(mouth.finish()).rejects.toThrow("without a final send");
		const active = await start(deliver, abort.signal);
		abort.abort(new Error("run cancelled"));
		expect((await rpc(active.connection, "tools/list")).status).toBe(403);
		await expect(active.mouth.finish()).rejects.toThrow("run cancelled");
	});
});
