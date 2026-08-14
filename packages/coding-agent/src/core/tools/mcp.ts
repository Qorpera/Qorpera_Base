/**
 * MCP client (Build 3 — generic connectivity, manifesto §8).
 *
 * MCP client = the company can use external tools. The company declares
 * servers in `connections/mcp.json` — an ordinary agent-writable file, not
 * a platform registry:
 *
 *   { "servers": { "<name>": { "command": "node", "args": ["path.js"], "env": {"K":"V"} } } }
 *
 * Local servers are ordinary subprocesses of the host-capable controller:
 * they inherit the signed-in user's environment, filesystem access, network,
 * and credential helpers. Remote servers may instead use the kernel HTTP
 * lane with bound destinations and secret references. The transport is MCP's stdio
 * framing — newline-delimited JSON-RPC 2.0 — hand-rolled here so Base
 * carries no MCP SDK dependency (MCP is interoperability at the edges,
 * not an internal company model).
 *
 * One gateway tool (`use_mcp_tool`) lists and calls server tools; the
 * founder scopes it with an ordinary [tools] override. There is no MCP
 * server surface here: exposing the company to external agent hosts is
 * an optional kernel module, outside the minimum.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AgentTool } from "@qorpera/pi-agent-core";
import { Text } from "@qorpera/pi-tui";
import { type Static, Type } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { spawn } from "../../utils/child-process.ts";
import { discoverAuthority } from "../authority.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { brokeredHttpRequest } from "../http-broker-client.ts";
import { getTextOutput, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, truncateHead } from "./truncate.ts";

export const MCP_TOOL_NAME = "use_mcp_tool";
export const MCP_CONFIG_PATH = join("connections", "mcp.json");
const MCP_PROTOCOL_VERSION = "2025-06-18";
const CALL_TIMEOUT_MS = 60_000;
const SPAWN_TIMEOUT_MS = 30_000;

interface McpServerConfig {
	/** Local stdio server: spawned with the controller's host access. */
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	/**
	 * Remote server: MCP streamable-HTTP over the kernel lane. Rides the
	 * founder's destination capabilities and causal intents; header values
	 * may carry secret://<name> references, dereferenced kernel-side.
	 */
	url?: string;
	headers?: Record<string, string>;
}

interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema?: unknown;
}

function readMcpConfig(root: string): Record<string, McpServerConfig> {
	const path = join(root, MCP_CONFIG_PATH);
	if (!existsSync(path)) {
		throw new Error(
			`No MCP servers declared. Create ${MCP_CONFIG_PATH} with {"servers": {"<name>": {"command": …, "args": […]}}}`,
		);
	}
	const parsed = JSON.parse(readFileSync(path, "utf-8")) as { servers?: Record<string, McpServerConfig> };
	if (!parsed.servers || typeof parsed.servers !== "object") {
		throw new Error(`${MCP_CONFIG_PATH} must carry a "servers" object`);
	}
	for (const [name, server] of Object.entries(parsed.servers)) {
		const hasCommand = typeof server?.command === "string" && server.command.length > 0;
		const hasUrl = typeof server?.url === "string" && server.url.startsWith("https://");
		if (!server || hasCommand === hasUrl) {
			throw new Error(`MCP server ${name} needs exactly one of "command" (local stdio) or an https "url" (remote)`);
		}
		if (server.args !== undefined && !Array.isArray(server.args)) {
			throw new Error(`MCP server ${name}: "args" must be an array`);
		}
	}
	return parsed.servers;
}

function serverEnvironment(declared: Record<string, string> | undefined): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (value !== undefined) env[name] = value;
	}
	env.ELECTRON_RUN_AS_NODE = "1";
	// Declared values override the inherited host environment. Avoid writing
	// raw secrets here when a secret:// reference over remote MCP is suitable.
	for (const [name, value] of Object.entries(declared ?? {})) {
		if (typeof value === "string") env[name] = value;
	}
	return env;
}

/** One live stdio MCP server connection with JSON-RPC correlation. */
class McpConnection {
	private child: ChildProcessWithoutNullStreams;
	private nextId = 1;
	private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private closed = false;

	private constructor(child: ChildProcessWithoutNullStreams) {
		this.child = child;
		createInterface({ input: child.stdout }).on("line", (line) => {
			if (!line.trim()) return;
			let message: { id?: unknown; result?: unknown; error?: { message?: unknown } };
			try {
				message = JSON.parse(line) as typeof message;
			} catch {
				return;
			}
			if (typeof message.id !== "number") return;
			const entry = this.pending.get(message.id);
			if (!entry) return;
			this.pending.delete(message.id);
			if (message.error) {
				entry.reject(new Error(`MCP server error: ${String(message.error.message ?? "unknown")}`));
			} else {
				entry.resolve(message.result);
			}
		});
		child.once("close", () => {
			this.closed = true;
			for (const entry of this.pending.values()) entry.reject(new Error("MCP server exited"));
			this.pending.clear();
		});
	}

	static async open(root: string, name: string, config: McpServerConfig): Promise<McpConnection> {
		if (!config.command) throw new Error(`MCP server ${name} has no command`);
		const child = spawn(config.command, config.args ?? [], {
			cwd: root,
			env: serverEnvironment(config.env),
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
		});
		await new Promise<void>((resolvePromise, rejectPromise) => {
			const onError = (error: Error): void =>
				rejectPromise(new Error(`MCP server ${name} failed to start: ${error.message}`));
			child.once("error", onError);
			child.once("spawn", () => {
				child.removeListener("error", onError);
				resolvePromise();
			});
		});
		const connection = new McpConnection(child);
		await connection.request(
			"initialize",
			{
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "qorpera-base", version: "1" },
			},
			SPAWN_TIMEOUT_MS,
		);
		connection.notify("notifications/initialized");
		return connection;
	}

	request(method: string, params: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
		if (this.closed) return Promise.reject(new Error("MCP server exited"));
		const id = this.nextId++;
		return new Promise((resolvePromise, rejectPromise) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				rejectPromise(new Error(`MCP ${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolvePromise(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					rejectPromise(error);
				},
			});
			this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	}

	notify(method: string, params?: unknown): void {
		if (this.closed) return;
		this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) })}\n`);
	}

	dispose(): Promise<void> {
		this.closed = true;
		if (this.child.exitCode !== null) return Promise.resolve();
		return new Promise((resolvePromise) => {
			this.child.once("close", () => resolvePromise());
			this.child.kill("SIGKILL");
		});
	}
}

/** Session-lifetime pool: servers spawn lazily on first use, die with the process. */
const connections = new Map<string, Promise<McpServerConnection>>();

/** What both transports provide to the tool. */
interface McpServerConnection {
	request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
	notify(method: string, params?: unknown): void;
	dispose(): Promise<void>;
}

/**
 * Remote MCP over the kernel HTTP lane: streamable-HTTP JSON-RPC POSTs.
 * By construction this inherits the whole trusted boundary — the server's
 * host must be a founder-bound destination, header values may carry
 * `secret://` references (dereferenced kernel-side), every call rides the
 * turn's causal intent, and everything is trail-observed. Responses may be
 * `application/json` or a bounded `text/event-stream` body (parsed for the
 * matching JSON-RPC id — our lane is request/response, not streaming).
 */
class RemoteMcpConnection implements McpServerConnection {
	private nextId = 1;
	private sessionId: string | undefined;
	private negotiatedVersion: string | undefined;
	private readonly url: string;
	private readonly extraHeaders: Record<string, string>;

	private constructor(url: string, extraHeaders: Record<string, string>) {
		this.url = url;
		this.extraHeaders = extraHeaders;
	}

	static async open(url: string, headers: Record<string, string>): Promise<RemoteMcpConnection> {
		const connection = new RemoteMcpConnection(url, headers);
		const initialized = (await connection.request("initialize", {
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "qorpera-base", version: "1" },
		})) as { protocolVersion?: unknown } | undefined;
		// Streamable HTTP 2025-06-18: every request after initialization must
		// carry the negotiated protocol version, and normal operations must not
		// start until the initialized notification has reached the server.
		connection.negotiatedVersion =
			typeof initialized?.protocolVersion === "string" ? initialized.protocolVersion : MCP_PROTOCOL_VERSION;
		await connection.post({ jsonrpc: "2.0", method: "notifications/initialized" });
		return connection;
	}

	private async post(message: object): Promise<{ status: number; headers: Record<string, string>; body: string }> {
		const response = await brokeredHttpRequest({
			method: "POST",
			url: this.url,
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
				...(this.negotiatedVersion ? { "mcp-protocol-version": this.negotiatedVersion } : {}),
				...this.extraHeaders,
			},
			body: JSON.stringify(message),
		});
		const granted = response.headers["mcp-session-id"];
		if (granted) this.sessionId = granted;
		return response;
	}

	async request(method: string, params: unknown): Promise<unknown> {
		const id = this.nextId++;
		const response = await this.post({ jsonrpc: "2.0", id, method, params });
		if (response.status < 200 || response.status >= 300) {
			throw new Error(`MCP server error: HTTP ${response.status}`);
		}
		const contentType = response.headers["content-type"] ?? "";
		const candidates: string[] = contentType.includes("text/event-stream")
			? response.body
					.split(/\r?\n/)
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trim())
			: [response.body];
		for (const candidate of candidates) {
			try {
				const message = JSON.parse(candidate) as { id?: unknown; result?: unknown; error?: { message?: unknown } };
				if (message.id !== id) continue;
				if (message.error) throw new Error(`MCP server error: ${String(message.error.message ?? "unknown")}`);
				return message.result;
			} catch (error) {
				if (error instanceof Error && error.message.startsWith("MCP server error")) throw error;
			}
		}
		throw new Error(`MCP ${method}: no JSON-RPC response matched the request`);
	}

	notify(method: string, params?: unknown): void {
		void this.post({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }).catch(() => {});
	}

	dispose(): Promise<void> {
		return Promise.resolve();
	}
}

async function connect(root: string, name: string): Promise<McpServerConnection> {
	// NUL separator (written as an escape: a raw NUL byte makes git treat this file as binary).
	const key = `${root}\u0000${name}`;
	const existing = connections.get(key);
	if (existing) return existing;
	const servers = readMcpConfig(root);
	const config = servers[name];
	if (!config) {
		throw new Error(`Unknown MCP server: ${name}. Declared servers: ${Object.keys(servers).join(", ") || "(none)"}`);
	}
	const pending: Promise<McpServerConnection> = (
		config.url ? RemoteMcpConnection.open(config.url, config.headers ?? {}) : McpConnection.open(root, name, config)
	).catch((error) => {
		connections.delete(key);
		throw error;
	});
	connections.set(key, pending);
	return pending;
}

process.once("exit", () => {
	for (const pending of connections.values()) {
		void pending.then((connection) => connection.dispose()).catch(() => {});
	}
});

/** Kill all pooled server connections (session teardown and tests). */
export async function disposeMcpConnections(): Promise<void> {
	const all = [...connections.values()];
	connections.clear();
	for (const pending of all) {
		try {
			await (await pending).dispose();
		} catch {
			// A server that failed to start has nothing to dispose.
		}
	}
}

function renderToolList(result: unknown): string {
	const tools = ((result as { tools?: McpToolInfo[] })?.tools ?? []).filter(
		(tool): tool is McpToolInfo => typeof tool?.name === "string",
	);
	if (tools.length === 0) return "(the server exposes no tools)";
	return tools
		.map(
			(tool) =>
				`${tool.name}${tool.description ? ` — ${tool.description}` : ""}${tool.inputSchema ? `\n  input: ${JSON.stringify(tool.inputSchema)}` : ""}`,
		)
		.join("\n");
}

function renderCallResult(result: unknown): { text: string; isError: boolean } {
	const record = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
	const parts = (record?.content ?? [])
		.map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : JSON.stringify(part)))
		.join("\n");
	return { text: parts || JSON.stringify(result), isError: record?.isError === true };
}

const mcpSchema = Type.Object({
	server: Type.String({ description: `Server name declared in ${MCP_CONFIG_PATH}` }),
	tool: Type.Optional(Type.String({ description: "Tool to call. Omit to list the server's tools." })),
	arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Tool arguments" })),
});

export type McpToolInput = Static<typeof mcpSchema>;

export interface McpToolDetails {
	server: string;
	tool?: string;
	isError?: boolean;
}

export function createMcpToolDefinition(cwd: string): ToolDefinition<typeof mcpSchema, McpToolDetails | undefined> {
	return {
		name: MCP_TOOL_NAME,
		label: "mcp",
		description: `Use a tool from an external MCP server the company has declared in ${MCP_CONFIG_PATH}. Omit "tool" to list a server's tools first. Local servers inherit the controller's full host environment and permissions; remote servers use the kernel's brokered HTTP lane.`,
		promptSnippet: "Call tools on company-declared MCP servers",
		parameters: mcpSchema,
		async execute(_toolCallId, { server, tool, arguments: toolArguments }: McpToolInput) {
			const authority = discoverAuthority(cwd);
			if (!authority) throw new Error("use_mcp_tool requires a company folder (no authority root found)");
			const connection = await connect(authority.root, server);
			if (!tool) {
				const result = await connection.request("tools/list", {});
				return {
					content: [{ type: "text", text: `Tools on ${server}:\n${renderToolList(result)}` }],
					details: { server },
				};
			}
			const result = await connection.request("tools/call", { name: tool, arguments: toolArguments ?? {} });
			const rendered = renderCallResult(result);
			const shown = truncateHead(rendered.text, { maxBytes: DEFAULT_MAX_BYTES });
			return {
				content: [
					{
						type: "text",
						text: `${rendered.isError ? `[${server}/${tool} returned an error]\n` : ""}${shown.content}${shown.truncated ? "\n[display truncated]" : ""}`,
					},
				],
				details: { server, tool, ...(rendered.isError ? { isError: true as const } : {}) },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const target = args?.tool ? `${str(args.server)}/${str(args.tool)}` : `${str(args?.server)} (list tools)`;
			text.setText(`${theme.fg("toolTitle", theme.bold("mcp"))} ${theme.fg("toolOutput", target)}`);
			return text;
		},
		renderResult(result, options: ToolRenderResultOptions, theme: Theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const output = getTextOutput(result as never, context.showImages).trim();
			const lines = output.split("\n");
			const maxLines = options.expanded ? lines.length : 15;
			const shown = lines.slice(0, maxLines).map((line) => theme.fg("toolOutput", line));
			const remaining = lines.length - maxLines;
			text.setText(
				`\n${shown.join("\n")}${remaining > 0 ? theme.fg("muted", `\n... (${remaining} more lines)`) : ""}`,
			);
			return text;
		},
	};
}

export function createMcpTool(cwd: string): AgentTool<typeof mcpSchema> {
	return wrapToolDefinition(createMcpToolDefinition(cwd));
}
