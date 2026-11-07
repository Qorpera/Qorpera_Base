import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { runCloudCodexToolSession } from "@qorpera/runtime/cloud-codex-tool-session";
import { CloudNativeToolBoundary } from "@qorpera/runtime/cloud-native-tool-boundary";
import { CloudRuntimeObservability, type CloudRuntimeObservation } from "@qorpera/runtime/cloud-runtime-observability";
import { nativeCodexFixtureCommand } from "./native-codex-fixture-command.ts";

interface Frame {
	type?: unknown;
	generate?: unknown;
	model?: unknown;
	previous_response_id?: unknown;
}

/** One text frame from the server, unmasked. */
function sendText(socket: Duplex, text: string): void {
	const body = Buffer.from(text);
	const head = Buffer.alloc(body.length < 126 ? 2 : body.length < 65536 ? 4 : 10);
	head[0] = 0x81;
	if (body.length < 126) head[1] = body.length;
	else if (body.length < 65536) {
		head[1] = 126;
		head.writeUInt16BE(body.length, 2);
	} else {
		head[1] = 127;
		head.writeBigUInt64BE(BigInt(body.length), 2);
	}
	socket.write(Buffer.concat([head, body]));
}

/** Calls `onText` with each whole text message of a client's masked frames, and answers pings and a close. */
function readTextMessages(socket: Duplex, onText: (text: string) => void): void {
	let buffered = Buffer.alloc(0);
	let parts: Buffer[] = [];
	socket.on("data", (chunk: Buffer) => {
		buffered = Buffer.concat([buffered, chunk]);
		while (buffered.length >= 2) {
			const length = buffered[1] & 0x7f;
			const start = length === 126 ? 4 : length === 127 ? 10 : 2;
			if (buffered.length < start) return;
			const size =
				length === 126 ? buffered.readUInt16BE(2) : length === 127 ? Number(buffered.readBigUInt64BE(2)) : length;
			if (buffered.length < start + 4 + size) return;
			const body = Buffer.alloc(size);
			for (let index = 0; index < size; index++)
				body[index] = buffered[start + 4 + index] ^ buffered[start + (index % 4)];
			const [first] = buffered;
			buffered = buffered.subarray(start + 4 + size);
			const opcode = first & 0x0f;
			if (opcode === 8) {
				socket.end();
				return;
			}
			if (opcode === 9) socket.write(Buffer.concat([Buffer.from([0x8a, body.length]), body]));
			if (opcode > 1) continue;
			parts.push(body);
			if (first & 0x80) {
				onText(Buffer.concat(parts).toString());
				parts = [];
			}
		}
	});
}

function line(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * The pinned native artifact on a scripted loopback provider that speaks the WebSocket transport, as OpenAI's does: only
 * there does Codex prewarm, so only here does the real executable meet a declined prewarm. The provider answers a first
 * request with one tool call and the next with a message, and records what reached it.
 */
export async function runNativeCodexPrewarmProbe(binary: string) {
	const root = await mkdtemp(join(tmpdir(), "qorpera-native-prewarm-"));
	const abort = new AbortController();
	const observations: CloudRuntimeObservation[] = [];
	const observability = new CloudRuntimeObservability({
		assignmentId: randomUUID(),
		publish: async (batch) => {
			observations.push(...batch);
		},
	});
	const frames: Frame[] = [];
	let handshakes = 0;
	let httpRequests = 0;
	let effects = 0;
	let fixtureFailure: unknown;
	const boundary = new CloudNativeToolBoundary({
		companyId: randomUUID(),
		runId: randomUUID(),
		signal: abort.signal,
		observability,
		assertActive: async (signal) => signal.throwIfAborted(),
		tools: [
			{
				name: "read_note",
				source: "company_file",
				description: "Synthetic public note.",
				inputSchema: { type: "object", properties: {}, additionalProperties: false },
				parseArguments: () => ({}),
				async execute() {
					effects++;
					return { kind: "text", value: `PUBLIC_NOTE_${effects}` };
				},
			},
		],
	});
	const provider = createServer((_request, response) => {
		httpRequests++;
		response.writeHead(404).end();
	});
	const sockets = new Set<Duplex>();
	provider.on("upgrade", (request, socket) => {
		assert.equal(request.url, "/v1/responses");
		handshakes++;
		sockets.add(socket);
		socket.on("error", () => undefined);
		const accept = createHash("sha1")
			.update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
			.digest("base64");
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
		readTextMessages(socket, (data) => {
			try {
				const frame = JSON.parse(data) as Frame;
				assert.equal(frame.type, "response.create");
				frames.push(frame);
				const id = `resp_${randomUUID()}`;
				const base = { id, object: "response", model: frame.model, created_at: 1 };
				const send = (value: Record<string, unknown>) => sendText(socket, JSON.stringify(value));
				send({ type: "response.created", response: { ...base, status: "in_progress", output: [] } });
				const generated = frames.filter((entry) => entry.generate !== false).length;
				const output =
					frame.generate === false
						? []
						: generated === 1
							? [
									{
										type: "function_call",
										id: "fc_c1",
										call_id: "c1",
										namespace: "qorpera",
										name: "read_note",
										arguments: "{}",
										status: "completed",
									},
								]
							: [
									{
										type: "message",
										id: "msg_done",
										role: "assistant",
										status: "completed",
										content: [{ type: "output_text", text: "Done.", annotations: [] }],
									},
								];
				for (const [index, item] of output.entries())
					send({ type: "response.output_item.done", output_index: index, item });
				send({
					type: "response.completed",
					response: {
						...base,
						status: "completed",
						output,
						usage: {
							input_tokens: 40,
							input_tokens_details: { cached_tokens: 0 },
							output_tokens: 5,
							output_tokens_details: { reasoning_tokens: 0 },
							total_tokens: 45,
						},
					},
				});
			} catch (error) {
				fixtureFailure = error;
				socket.destroy();
			}
		});
	});
	try {
		await new Promise<void>((resolve, reject) => {
			provider.once("error", reject);
			provider.listen(0, "127.0.0.1", () => {
				provider.removeListener("error", reject);
				resolve();
			});
		});
		const address = provider.address();
		assert(address && typeof address !== "string");
		const command = await nativeCodexFixtureCommand(root, [binary], address.port, undefined, true);
		const started = Date.now();
		const result = await runCloudCodexToolSession({
			...command,
			boundary,
			observability,
			model: "offline-probe",
			prompt: "Synthetic declined prewarm.",
			signal: abort.signal,
			timeoutMs: 20_000,
		}).then(
			(value) => ({ value, error: undefined }),
			(error: unknown) => ({ value: undefined, error }),
		);
		await observability.close();
		if (fixtureFailure) throw fixtureFailure;
		const diagnostics = await readFile(join(root, "native-diagnostics.log"), "utf8").catch(() => "");
		const nativeErrors: string[] = [];
		for (const text of diagnostics.split("\n")) {
			const value = line(text) as
				| { method?: unknown; params?: { error?: { message?: unknown }; turn?: { status?: unknown } } }
				| undefined;
			if (value?.method === "error") nativeErrors.push(String(value.params?.error?.message));
			else if (value?.method === "turn/completed" && value.params?.turn?.status !== "completed")
				nativeErrors.push(`turn ${value.params?.turn?.status}`);
		}
		const finished = (operation: string) =>
			observations.filter((row) => row.operation === operation && row.phase === "finish");
		return {
			failure: result.error === undefined ? null : String(result.error),
			fencedRequests: result.value?.fencedRequests ?? null,
			toolCalls: result.value?.toolCalls ?? null,
			effects,
			handshakes,
			httpRequests,
			prewarmFrames: frames.filter((frame) => frame.generate === false).length,
			turnFrames: frames.filter((frame) => frame.generate !== false).length,
			firstTurnFollowsPrewarm:
				typeof frames.find((frame) => frame.generate !== false)?.previous_response_id === "string",
			nativeErrors,
			modelRequests: finished("model_request").map((row) => row.status),
			turn: finished("model_turn").map((row) => row.status),
			ms: Date.now() - started,
		};
	} finally {
		abort.abort();
		for (const socket of sockets) socket.destroy();
		provider.closeAllConnections();
		await new Promise<void>((resolve) => provider.close(() => resolve()));
		boundary.close();
		await observability.close();
		await rm(root, { recursive: true, force: true });
	}
}
