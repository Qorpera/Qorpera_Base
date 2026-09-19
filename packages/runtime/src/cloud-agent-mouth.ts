import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

const PROTOCOL_VERSION = "2025-06-18";
const MAX_REQUEST_BYTES = 256 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const CLOUD_AGENT_SEND_SCHEMA = "qorpera.agent-send/v1";
export const CLOUD_AGENT_SEND_INSTRUCTIONS =
	"Qorpera has one public voice: send_message. Ordinary assistant text, reasoning, tool calls and tool results are private. " +
	"Follow the admitted delivery policy. Satisfy an outstanding human acknowledgement before work; do not repeat an acknowledgement already confirmed for this run. " +
	"A progress message does not finish the turn. Send final when this turn has delivered its result, concrete blocker, or required decision request; the underlying task may remain unfinished. " +
	"Reuse the same idempotencyKey and exact arguments when retrying a send. Never expose private reasoning or credentials.";

export interface CloudAgentSendInput {
	idempotencyKey: string;
	text: string;
	phase: "progress" | "final";
}

export interface CloudAgentSendReceipt {
	schema: typeof CLOUD_AGENT_SEND_SCHEMA;
	runId: string;
	sessionId: string;
	messageId: string;
	phase: "progress" | "final";
	sequence: number;
}

export interface CloudAgentMouthConnection {
	url: string;
	bearerToken: string;
}

export function parseCloudAgentSendInput(value: unknown): CloudAgentSendInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid send arguments");
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).some((key) => !["idempotencyKey", "text", "phase"].includes(key)) ||
		typeof input.idempotencyKey !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.idempotencyKey) ||
		typeof input.text !== "string" ||
		!input.text.trim() ||
		input.text.includes("\0") ||
		Buffer.byteLength(input.text, "utf-8") > 64 * 1024 ||
		(input.phase !== "progress" && input.phase !== "final")
	) {
		throw new Error("Invalid send arguments");
	}
	return { idempotencyKey: input.idempotencyKey, text: input.text, phase: input.phase };
}

export function parseCloudAgentSendReceipt(value: unknown, runId: string): CloudAgentSendReceipt {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid send receipt");
	const receipt = value as Record<string, unknown>;
	if (
		receipt.schema !== CLOUD_AGENT_SEND_SCHEMA ||
		receipt.runId !== runId ||
		typeof receipt.sessionId !== "string" ||
		!UUID_PATTERN.test(receipt.sessionId) ||
		typeof receipt.messageId !== "string" ||
		!UUID_PATTERN.test(receipt.messageId) ||
		(receipt.phase !== "progress" && receipt.phase !== "final") ||
		!Number.isSafeInteger(receipt.sequence) ||
		(receipt.sequence as number) < 1 ||
		Object.keys(receipt).some(
			(key) => !["schema", "runId", "sessionId", "messageId", "phase", "sequence"].includes(key),
		)
	) {
		throw new Error("Invalid send receipt");
	}
	return {
		schema: CLOUD_AGENT_SEND_SCHEMA,
		runId,
		sessionId: receipt.sessionId,
		messageId: receipt.messageId,
		phase: receipt.phase,
		sequence: receipt.sequence as number,
	};
}

/** Run-scoped MCP endpoint inside the cloud VM, never a desktop service.
 * The callback commits through the cloud authority before returning a receipt.
 * No provider output stream is connected to this endpoint or to the transcript.
 */
export class CloudAgentMouth {
	readonly #runId: string;
	readonly #send: (input: CloudAgentSendInput) => Promise<CloudAgentSendReceipt>;
	readonly #signal?: AbortSignal;
	readonly #token = randomBytes(32).toString("base64url");
	readonly #receipts = new Map<string, CloudAgentSendReceipt>();
	#server?: Server;
	#connection?: CloudAgentMouthConnection;
	#pending: Promise<void> = Promise.resolve();
	#closed = false;
	#initialized = false;
	#toolsListed = false;
	#sendAttempted = false;

	constructor(
		runId: string,
		send: (input: CloudAgentSendInput) => Promise<CloudAgentSendReceipt>,
		signal?: AbortSignal,
	) {
		if (!UUID_PATTERN.test(runId)) throw new Error("Invalid mouth run id");
		this.#runId = runId;
		this.#send = send;
		this.#signal = signal;
	}

	/** Closed diagnostic vocabulary: never includes messages, arguments, credentials or endpoint details. */
	get diagnosticState(): "uninitialized" | "initialized" | "ready" | "send-unconfirmed" | "delivered" {
		if (this.#receipts.size > 0) return "delivered";
		if (this.#sendAttempted) return "send-unconfirmed";
		if (this.#toolsListed) return "ready";
		return this.#initialized ? "initialized" : "uninitialized";
	}

	async start(): Promise<CloudAgentMouthConnection> {
		if (this.#server || this.#closed) throw new Error("Mouth already started or closed");
		this.#signal?.throwIfAborted();
		const server = createServer((request, response) => {
			void this.#handle(request, response).catch(() => {
				if (!response.headersSent) response.writeHead(500);
				response.end();
			});
		});
		this.#server = server;
		server.requestTimeout = 30_000;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Mouth address is unavailable");
		this.#connection = { url: `http://127.0.0.1:${address.port}/mcp`, bearerToken: this.#token };
		return { ...this.#connection };
	}

	async finish(requireFinalSend = true): Promise<{ messageCount: number; finalMessageId: string | null }> {
		await this.#pending;
		this.#closed = true;
		this.#signal?.throwIfAborted();
		const final = [...this.#receipts.values()].find((receipt) => receipt.phase === "final");
		if (!final && (requireFinalSend || this.#receipts.size > 0)) {
			throw new Error("Native agent turn ended without a final send");
		}
		return { messageCount: this.#receipts.size, finalMessageId: final?.messageId ?? null };
	}

	/** Trusted in-process tool adapter. No extra listener, bearer or recipient selector. */
	send(value: CloudAgentSendInput): Promise<CloudAgentSendReceipt> {
		this.#sendAttempted = true;
		const input = parseCloudAgentSendInput(value);
		const delivery = this.#pending.then(async () => {
			if (this.#closed) throw new Error("Mouth is closed");
			this.#signal?.throwIfAborted();
			const receipt = parseCloudAgentSendReceipt(await this.#send(input), this.#runId);
			if (receipt.phase !== input.phase) throw new Error("Send receipt phase changed");
			this.#receipts.set(receipt.messageId, receipt);
			return receipt;
		});
		this.#pending = delivery.then(
			() => undefined,
			() => undefined,
		);
		return delivery;
	}

	async close(): Promise<void> {
		this.#closed = true;
		const server = this.#server;
		this.#server = undefined;
		if (server) {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
		await this.#pending;
	}

	async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		response.setHeader("cache-control", "no-store");
		const expectedHost = this.#connection ? new URL(this.#connection.url).host : "";
		const authorization = Buffer.from(request.headers.authorization ?? "", "utf-8");
		const expected = Buffer.from(`Bearer ${this.#token}`, "utf-8");
		if (
			this.#closed ||
			this.#signal?.aborted ||
			request.headers.host !== expectedHost ||
			(request.headers.origin !== undefined && request.headers.origin !== `http://${expectedHost}`) ||
			authorization.byteLength !== expected.byteLength ||
			!timingSafeEqual(authorization, expected)
		) {
			response.writeHead(403).end();
			return;
		}
		if (request.url !== "/mcp") {
			response.writeHead(404).end();
			return;
		}
		if (request.method !== "POST") {
			response.writeHead(405, { allow: "POST" }).end();
			return;
		}
		if (
			!request.headers["content-type"]?.startsWith("application/json") ||
			!request.headers.accept?.includes("application/json") ||
			(request.headers["mcp-protocol-version"] !== undefined &&
				request.headers["mcp-protocol-version"] !== PROTOCOL_VERSION)
		) {
			response.writeHead(400).end();
			return;
		}
		let id: string | number | null = null;
		try {
			const chunks: Buffer[] = [];
			let size = 0;
			for await (const chunk of request) {
				const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
				size += bytes.length;
				if (size > MAX_REQUEST_BYTES) {
					response.writeHead(413).end();
					return;
				}
				chunks.push(bytes);
			}
			const message: unknown = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
			if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Invalid request");
			const rpc = message as Record<string, unknown>;
			if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") throw new Error("Invalid request");
			if (rpc.id === undefined && rpc.method.startsWith("notifications/")) {
				response.writeHead(202).end();
				return;
			}
			if (typeof rpc.id !== "string" && (typeof rpc.id !== "number" || !Number.isSafeInteger(rpc.id))) {
				throw new Error("Invalid request id");
			}
			id = rpc.id as string | number;
			let result: unknown;
			if (rpc.method === "initialize") {
				this.#initialized = true;
				result = {
					protocolVersion: PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: "qorpera-cloud-mouth", version: "1" },
					instructions: CLOUD_AGENT_SEND_INSTRUCTIONS,
				};
			} else if (rpc.method === "ping") {
				result = {};
			} else if (rpc.method === "tools/list") {
				this.#toolsListed = true;
				result = {
					tools: [
						{
							name: "send_message",
							description: CLOUD_AGENT_SEND_INSTRUCTIONS,
							inputSchema: {
								type: "object",
								properties: {
									text: {
										type: "string",
										minLength: 1,
										maxLength: 65_536,
										description:
											"The message to the current conversation. No internal reasoning or credentials.",
									},
									phase: {
										type: "string",
										enum: ["progress", "final"],
										description:
											"Progress keeps working; final delivers the result and closes public output.",
									},
									idempotencyKey: {
										type: "string",
										pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
										description: "Unique within this turn. Reuse unchanged for retries.",
									},
								},
								required: ["text", "phase", "idempotencyKey"],
								additionalProperties: false,
							},
							annotations: {
								readOnlyHint: false,
								destructiveHint: false,
								idempotentHint: true,
								openWorldHint: false,
							},
						},
					],
				};
			} else if (rpc.method === "tools/call") {
				const params = rpc.params as Record<string, unknown> | undefined;
				if (!params || params.name !== "send_message") throw new Error("Unknown tool");
				this.#sendAttempted = true;
				try {
					const receipt = await this.send(parseCloudAgentSendInput(params.arguments));
					result = { content: [{ type: "text", text: JSON.stringify(receipt) }], structuredContent: receipt };
				} catch {
					result = {
						isError: true,
						content: [
							{
								type: "text",
								text: "Send not confirmed. Retry with the same idempotencyKey and unchanged arguments. A final send closes public output; authority or invalid arguments may also reject a send.",
							},
						],
					};
				}
			} else {
				response
					.writeHead(200, { "content-type": "application/json" })
					.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }));
				return;
			}
			response
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
		} catch {
			response
				.writeHead(400, { "content-type": "application/json" })
				.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid request" } }));
		}
	}
}
