import { randomBytes } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { isAbsolute, join } from "node:path";
import { assertNativeSocketPath } from "./cloud-native-egress.ts";
import type { CloudDynamicToolResponse, CloudNativeToolBoundary } from "./cloud-native-tool-boundary.ts";

export const CLOUD_CLAUDE_MCP_SOCKET_NAME = "mcp.sock";
export const CLOUD_CLAUDE_MCP_SERVER_NAME = "qorpera";
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";
const SUPPORTED_PROTOCOL_VERSIONS: ReadonlySet<string> = new Set([
	"2024-11-05",
	"2025-03-26",
	"2025-06-18",
	"2025-11-25",
]);
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_CONNECTIONS = 8;
const DATA_IMAGE_URL = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/;

export interface CloudClaudeMcpToolDescriptor {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
}

interface JsonRpcRequest {
	readonly jsonrpc?: unknown;
	readonly id?: unknown;
	readonly method?: unknown;
	readonly params?: unknown;
}

type McpContentBlock =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "image"; readonly data: string; readonly mimeType: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRpcId(value: unknown): value is string | number | null {
	return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function boundaryTools(boundary: CloudNativeToolBoundary): CloudClaudeMcpToolDescriptor[] {
	const spec = boundary.specification;
	if (!isRecord(spec) || !Array.isArray(spec.tools)) return [];
	const out: CloudClaudeMcpToolDescriptor[] = [];
	for (const tool of spec.tools) {
		if (!isRecord(tool) || typeof tool.name !== "string" || typeof tool.description !== "string") continue;
		const schema = isRecord(tool.inputSchema) ? tool.inputSchema : { type: "object", properties: {} };
		out.push({ name: tool.name, description: tool.description, inputSchema: schema });
	}
	return out;
}

function responseToMcpContent(response: CloudDynamicToolResponse): McpContentBlock[] {
	const blocks: McpContentBlock[] = [];
	for (const item of response.contentItems) {
		if (item.type === "inputText") {
			blocks.push({ type: "text", text: item.text });
		} else if (item.type === "inputImage") {
			const parsed = DATA_IMAGE_URL.exec(item.imageUrl);
			if (parsed) {
				blocks.push({ type: "image", mimeType: parsed[1] as string, data: parsed[2] as string });
			} else {
				blocks.push({ type: "text", text: item.imageUrl });
			}
		}
	}
	return blocks;
}

export class CloudClaudeMcpBridge {
	readonly #boundary: CloudNativeToolBoundary;
	readonly #signal: AbortSignal;
	readonly #onBeforeToolCall?: (name: string) => string | undefined;
	readonly #onAfterToolCall?: (name: string, response: CloudDynamicToolResponse) => void;
	readonly #sockets = new Set<Socket>();
	readonly #tools: readonly CloudClaudeMcpToolDescriptor[];
	#server?: Server;
	#path?: string;
	#seq = 0;

	constructor(options: {
		readonly boundary: CloudNativeToolBoundary;
		readonly signal: AbortSignal;
		readonly onBeforeToolCall?: (name: string) => string | undefined;
		readonly onAfterToolCall?: (name: string, response: CloudDynamicToolResponse) => void;
	}) {
		this.#boundary = options.boundary;
		this.#signal = options.signal;
		this.#onBeforeToolCall = options.onBeforeToolCall;
		this.#onAfterToolCall = options.onAfterToolCall;
		this.#tools = Object.freeze(boundaryTools(options.boundary));
	}

	get socketPath(): string {
		if (!this.#path) throw new Error("The Claude Code MCP socket is not open");
		return this.#path;
	}

	get declaredMcpToolNames(): readonly string[] {
		return this.#tools.map((tool) => `mcp__${CLOUD_CLAUDE_MCP_SERVER_NAME}__${tool.name}`);
	}

	async listen(root: string): Promise<void> {
		if (!isAbsolute(root)) throw new Error("Invalid MCP socket root");
		const path = join(root, CLOUD_CLAUDE_MCP_SOCKET_NAME);
		assertNativeSocketPath(path, "The Claude Code MCP bridge's");
		const server = createServer((socket) => this.#serve(socket));
		server.on("error", () => undefined);
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(path, () => {
				server.removeListener("error", reject);
				resolve();
			});
		});
		await chmod(path, 0o600);
		this.#server = server;
		this.#path = path;
	}

	async close(): Promise<void> {
		for (const socket of this.#sockets) socket.destroy();
		this.#sockets.clear();
		this.#server?.close();
		this.#server = undefined;
		if (this.#path) {
			const toRemove = this.#path;
			this.#path = undefined;
			await rm(toRemove, { force: true }).catch(() => undefined);
		}
	}

	#serve(socket: Socket): void {
		if (this.#sockets.size >= MAX_CONNECTIONS || this.#signal.aborted) {
			socket.destroy();
			return;
		}
		this.#sockets.add(socket);
		socket.on("error", () => undefined);
		const onAbort = (): void => {
			socket.destroy();
		};
		this.#signal.addEventListener("abort", onAbort, { once: true });
		socket.once("close", () => {
			this.#signal.removeEventListener("abort", onAbort);
			this.#sockets.delete(socket);
		});

		const send = (payload: Record<string, unknown>): void => {
			if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(payload)}\n`);
		};

		let pending: Buffer = Buffer.alloc(0);
		let chain = Promise.resolve();
		const enqueue = (line: string): void => {
			chain = chain.then(() => this.#handleLine(line, send)).catch(() => undefined);
		};

		socket.on("data", (chunk: Buffer) => {
			if (pending.byteLength + chunk.byteLength > MAX_LINE_BYTES && !chunk.includes(0x0a)) {
				socket.destroy();
				return;
			}
			pending = pending.byteLength === 0 ? chunk : Buffer.concat([pending, chunk]);
			let newline = pending.indexOf(0x0a);
			while (newline >= 0) {
				if (newline > MAX_LINE_BYTES) {
					socket.destroy();
					return;
				}
				const line = pending.subarray(0, newline).toString("utf8").replace(/\r$/, "");
				pending = pending.subarray(newline + 1);
				if (line.length > 0) enqueue(line);
				newline = pending.indexOf(0x0a);
			}
			if (pending.byteLength > MAX_LINE_BYTES) socket.destroy();
		});
	}

	async #handleLine(line: string, send: (payload: Record<string, unknown>) => void): Promise<void> {
		if (this.#signal.aborted) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
			return;
		}
		if (!isRecord(parsed)) {
			send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
			return;
		}
		const request = parsed as JsonRpcRequest;
		const hasId = Object.hasOwn(parsed, "id");
		const id = isRpcId(request.id) ? request.id : null;
		const method = typeof request.method === "string" ? request.method : "";
		if (!method) {
			if (hasId) send({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } });
			return;
		}
		if (method.startsWith("notifications/")) return;

		if (method === "initialize") {
			const requestedVersion =
				isRecord(request.params) &&
				typeof request.params.protocolVersion === "string" &&
				SUPPORTED_PROTOCOL_VERSIONS.has(request.params.protocolVersion)
					? request.params.protocolVersion
					: DEFAULT_PROTOCOL_VERSION;
			if (hasId) {
				send({
					jsonrpc: "2.0",
					id,
					result: {
						protocolVersion: requestedVersion,
						capabilities: { tools: {} },
						serverInfo: { name: "qorpera-coding-mcp", version: "1.0.0" },
					},
				});
			}
			return;
		}

		if (method === "ping") {
			if (hasId) send({ jsonrpc: "2.0", id, result: {} });
			return;
		}

		if (method === "tools/list") {
			if (hasId) {
				send({
					jsonrpc: "2.0",
					id,
					result: {
						tools: this.#tools.map((tool) => ({
							name: tool.name,
							description: tool.description,
							inputSchema: tool.inputSchema,
						})),
					},
				});
			}
			return;
		}

		if (method === "tools/call") {
			if (!hasId) return;
			const params = isRecord(request.params) ? request.params : undefined;
			const name = typeof params?.name === "string" ? params.name : "";
			const args = params?.arguments === undefined ? {} : params.arguments;
			if (!name) {
				send({ jsonrpc: "2.0", id, error: { code: -32602, message: "Missing tool name" } });
				return;
			}
			const blockedReason = this.#onBeforeToolCall?.(name);
			if (blockedReason !== undefined) {
				send({
					jsonrpc: "2.0",
					id,
					result: {
						content: [{ type: "text", text: blockedReason }],
						isError: true,
					},
				});
				return;
			}
			const callId = `mcp_${++this.#seq}_${randomBytes(4).toString("hex")}`;
			try {
				const response = await this.#boundary.invoke(callId, CLOUD_CLAUDE_MCP_SERVER_NAME, name, args);
				if (this.#signal.aborted) return;
				send({
					jsonrpc: "2.0",
					id,
					result: {
						content: responseToMcpContent(response),
						isError: !response.success,
					},
				});
				this.#onAfterToolCall?.(name, response);
			} catch {
				if (this.#signal.aborted) return;
				send({ jsonrpc: "2.0", id, error: { code: -32603, message: "Tool execution unavailable" } });
			}
			return;
		}

		if (hasId) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
	}
}
