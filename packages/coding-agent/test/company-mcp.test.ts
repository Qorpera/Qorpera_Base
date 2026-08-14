/**
 * MCP client (Build 3): stdio JSON-RPC against a faux MCP server —
 * list, call, server-reported errors, and configuration errors.
 * Implementation discipline: faux servers, no real credentials.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	discoverAuthority,
	evaluateToolCall,
	finalizeAuthorityDecision,
	MCP_TOOL_NAME,
} from "../src/core/authority.ts";
import { handleHttpBrokerFrame, setHttpBrokerWriter } from "../src/core/http-broker-client.ts";
import { createMcpToolDefinition, disposeMcpConnections } from "../src/core/tools/mcp.ts";
import { createMcpServerEnvironment } from "../src/core/tools/mcp-config.ts";

const FAUX_SERVER = `import { createInterface } from "node:readline";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
	if (!line.trim()) return;
	const message = JSON.parse(line);
	if (message.id === undefined) return; // notifications
	if (message.method === "initialize") {
		reply(message.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "faux", version: "1" } });
	} else if (message.method === "tools/list") {
		reply(message.id, { tools: [{ name: "echo", description: "Echoes text back", inputSchema: { type: "object", properties: { text: { type: "string" } } } }, { name: "host_env", description: "Reads a host environment value", inputSchema: { type: "object" } }] });
	} else if (message.method === "tools/call") {
		if (message.params.name === "echo") {
			reply(message.id, { content: [{ type: "text", text: "echo: " + (message.params.arguments?.text ?? "") }] });
		} else if (message.params.name === "host_env") {
			reply(message.id, { content: [{ type: "text", text: [process.env.QORPERA_MCP_HOST_ACCESS_TEST ?? "missing", process.env.QORPERA_TRAIL_BROKER_TOKEN ?? "trail-missing", process.env.QORPERA_MODEL_BROKER_HANDLES ?? "handles-missing"].join("|") }] });
		} else {
			reply(message.id, { content: [{ type: "text", text: "no such tool" }], isError: true });
		}
	}
});
`;

let root: string;

beforeEach(() => {
	root = join(tmpdir(), `qorpera-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(root, "connections"), { recursive: true });
	writeFileSync(
		join(root, "authority.toml"),
		`[irreversible]\nmode = "auto"\n\n[tools]\nuse_mcp_tool = "none"\n`,
		"utf-8",
	);
});

afterEach(async () => {
	await disposeMcpConnections();
	// Windows releases a killed child's cwd handle asynchronously.
	if (root && existsSync(root)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function declareFauxServer(): void {
	writeFileSync(join(root, "connections", "faux-server.mjs"), FAUX_SERVER, "utf-8");
	writeFileSync(
		join(root, "connections", "mcp.json"),
		JSON.stringify({
			servers: { faux: { command: process.execPath, args: [join(root, "connections", "faux-server.mjs")] } },
		}),
		"utf-8",
	);
}

async function run(input: { server: string; tool?: string; arguments?: Record<string, unknown> }) {
	const authority = discoverAuthority(root)!;
	const decision = await finalizeAuthorityDecision(
		authority,
		evaluateToolCall(authority, MCP_TOOL_NAME, input, root),
		MCP_TOOL_NAME,
		input,
	);
	if (decision.kind === "block") throw new Error(decision.reason);
	const definition = createMcpToolDefinition(root);
	const execute = definition.execute as unknown as (toolCallId: string, args: unknown) => Promise<unknown>;
	return (await execute("test-call", input)) as {
		content: Array<{ type: string; text?: string }>;
		details?: { server: string; tool?: string; isError?: boolean };
	};
}

describe("use_mcp_tool", () => {
	it("defaults to the always-gated authority class before execution", () => {
		writeFileSync(join(root, "authority.toml"), `[irreversible]\nmode = "auto"\n`, "utf-8");
		const authority = discoverAuthority(root)!;
		const decision = evaluateToolCall(authority, MCP_TOOL_NAME, { server: "faux", tool: "external_effect" }, root);
		expect(decision.kind).toBe("block");
		expect((decision as { effectClass: string }).effectClass).toBe("authority");
	});

	it("rejects a server configuration changed after authority evaluation", async () => {
		declareFauxServer();
		const input = { server: "faux", tool: "echo", arguments: { text: "bound" } };
		const authority = discoverAuthority(root)!;
		const evaluated = evaluateToolCall(authority, MCP_TOOL_NAME, input, root);
		writeFileSync(
			join(root, "connections", "mcp.json"),
			JSON.stringify({ servers: { faux: { command: process.execPath, args: ["different-server.mjs"] } } }),
			"utf-8",
		);
		const decision = await finalizeAuthorityDecision(authority, evaluated, MCP_TOOL_NAME, input);
		expect(decision.kind).toBe("block");
		expect((decision as { reason: string }).reason).toContain("configuration changed after policy evaluation");
	});

	it("rejects a server configuration changed after authority finalization", async () => {
		declareFauxServer();
		const input = { server: "faux", tool: "echo", arguments: { text: "bound" } };
		const authority = discoverAuthority(root)!;
		const decision = await finalizeAuthorityDecision(
			authority,
			evaluateToolCall(authority, MCP_TOOL_NAME, input, root),
			MCP_TOOL_NAME,
			input,
		);
		expect(decision.kind).toBe("allow");

		writeFileSync(
			join(root, "connections", "mcp.json"),
			JSON.stringify({ servers: { faux: { command: process.execPath, args: ["different-server.mjs"] } } }),
			"utf-8",
		);
		const definition = createMcpToolDefinition(root);
		const execute = definition.execute as unknown as (toolCallId: string, args: unknown) => Promise<unknown>;
		await expect(execute("changed-config", input)).rejects.toThrow(/configuration changed after authority approval/);
	});

	it("rejects local server code changed after authority finalization", async () => {
		declareFauxServer();
		const input = { server: "faux", tool: "echo", arguments: { text: "bound" } };
		const authority = discoverAuthority(root)!;
		const decision = await finalizeAuthorityDecision(
			authority,
			evaluateToolCall(authority, MCP_TOOL_NAME, input, root),
			MCP_TOOL_NAME,
			input,
		);
		expect(decision.kind).toBe("allow");

		writeFileSync(join(root, "connections", "faux-server.mjs"), `${FAUX_SERVER}\n// changed after review\n`, "utf-8");
		const definition = createMcpToolDefinition(root);
		const execute = definition.execute as unknown as (toolCallId: string, args: unknown) => Promise<unknown>;
		await expect(execute("changed-code", input)).rejects.toThrow(/configuration changed after authority approval/);
	});

	it("rejects imported local server code changed after authority finalization", async () => {
		declareFauxServer();
		writeFileSync(join(root, "connections", "payload.mjs"), `export const payload = "reviewed";\n`, "utf-8");
		writeFileSync(join(root, "connections", "faux-server.mjs"), `import "./payload.mjs";\n${FAUX_SERVER}`, "utf-8");
		const input = { server: "faux", tool: "echo", arguments: { text: "bound" } };
		const authority = discoverAuthority(root)!;
		const decision = await finalizeAuthorityDecision(
			authority,
			evaluateToolCall(authority, MCP_TOOL_NAME, input, root),
			MCP_TOOL_NAME,
			input,
		);
		expect(decision.kind).toBe("allow");

		writeFileSync(join(root, "connections", "payload.mjs"), `export const payload = "changed";\n`, "utf-8");
		const definition = createMcpToolDefinition(root);
		const execute = definition.execute as unknown as (toolCallId: string, args: unknown) => Promise<unknown>;
		await expect(execute("changed-import", input)).rejects.toThrow(/configuration changed after authority approval/);
	});

	it("lists a declared server's tools", async () => {
		declareFauxServer();
		const result = await run({ server: "faux" });
		expect(result.content[0]?.text).toContain("echo — Echoes text back");
		expect(result.content[0]?.text).toContain('"type":"object"');
	});

	it("calls a tool and returns its content", async () => {
		declareFauxServer();
		const result = await run({ server: "faux", tool: "echo", arguments: { text: "hello mcp" } });
		expect(result.content[0]?.text).toContain("echo: hello mcp");
		expect(result.details?.isError).toBeUndefined();
	});

	it("gives local servers the host environment without controller broker capabilities", async () => {
		const previousHostAccess = process.env.QORPERA_MCP_HOST_ACCESS_TEST;
		const previousTrailToken = process.env.QORPERA_TRAIL_BROKER_TOKEN;
		const previousModelHandles = process.env.QORPERA_MODEL_BROKER_HANDLES;
		process.env.QORPERA_MCP_HOST_ACCESS_TEST = "available";
		process.env.QORPERA_TRAIL_BROKER_TOKEN = "controller-secret";
		process.env.QORPERA_MODEL_BROKER_HANDLES = "controller-handles";
		try {
			declareFauxServer();
			const result = await run({ server: "faux", tool: "host_env" });
			expect(result.content[0]?.text).toContain("available|trail-missing|handles-missing");
		} finally {
			if (previousHostAccess === undefined) delete process.env.QORPERA_MCP_HOST_ACCESS_TEST;
			else process.env.QORPERA_MCP_HOST_ACCESS_TEST = previousHostAccess;
			if (previousTrailToken === undefined) delete process.env.QORPERA_TRAIL_BROKER_TOKEN;
			else process.env.QORPERA_TRAIL_BROKER_TOKEN = previousTrailToken;
			if (previousModelHandles === undefined) delete process.env.QORPERA_MODEL_BROKER_HANDLES;
			else process.env.QORPERA_MODEL_BROKER_HANDLES = previousModelHandles;
		}
	});

	it("withholds controller broker capabilities regardless of environment-name casing", () => {
		const environment = createMcpServerEnvironment({
			Qorpera_Trail_Broker_Token: "controller-secret",
			qorpera_model_broker_handles: "controller-handles",
			QORPERA_MCP_DECLARED_TEST: "available",
		});
		expect(Object.keys(environment).some((name) => name.toUpperCase() === "QORPERA_TRAIL_BROKER_TOKEN")).toBe(false);
		expect(Object.keys(environment).some((name) => name.toUpperCase() === "QORPERA_MODEL_BROKER_HANDLES")).toBe(
			false,
		);
		expect(environment.QORPERA_MCP_DECLARED_TEST).toBe("available");
	});

	it("surfaces server-reported tool errors", async () => {
		declareFauxServer();
		const result = await run({ server: "faux", tool: "nope" });
		expect(result.content[0]?.text).toContain("returned an error");
		expect(result.details?.isError).toBe(true);
	});

	it("errors on unknown servers and missing configuration", async () => {
		await expect(run({ server: "faux" })).rejects.toThrow(/No MCP servers declared/);
		declareFauxServer();
		await expect(run({ server: "ghost" })).rejects.toThrow(/Unknown MCP server: ghost.*faux/);
	});
});

describe("remote MCP over the kernel lane", () => {
	it("initializes, tracks the session id, and calls tools through brokered HTTP", async () => {
		writeFileSync(
			join(root, "connections", "mcp.json"),
			JSON.stringify({
				servers: {
					remote: { url: "https://mcp.test.example/rpc", headers: { authorization: "Bearer secret://mcp-token" } },
				},
			}),
			"utf-8",
		);
		const capturedHeaders: Array<Record<string, string>> = [];
		const capturedMethods: Array<string | undefined> = [];
		setHttpBrokerWriter((frame) => {
			const record = frame as { requestId: string; body?: string; headers?: Record<string, string> };
			capturedHeaders.push(record.headers ?? {});
			const message = JSON.parse(record.body ?? "{}") as {
				id?: number;
				method?: string;
				params?: { name?: string };
			};
			capturedMethods.push(message.method);
			const reply = (result: unknown, headers?: Record<string, string>) =>
				handleHttpBrokerFrame({
					type: "qorpera_http_response",
					requestId: record.requestId,
					status: 200,
					headers: { "content-type": "application/json", ...headers },
					body: JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
					bodyBytes: 1,
				});
			if (message.id === undefined) {
				// Notification: acknowledge without a JSON-RPC body.
				handleHttpBrokerFrame({
					type: "qorpera_http_response",
					requestId: record.requestId,
					status: 202,
					headers: {},
					body: "",
					bodyBytes: 0,
				});
			} else if (message.method === "initialize") {
				reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} } }, { "mcp-session-id": "session-42" });
			} else if (message.method === "tools/list") {
				reply({ tools: [{ name: "search", description: "Remote search" }] });
			} else if (message.method === "tools/call" && message.params?.name === "search") {
				reply({ content: [{ type: "text", text: "remote result" }] });
			}
		});

		const listed = await run({ server: "remote" });
		expect(listed.content[0]?.text).toContain("search — Remote search");
		const called = await run({ server: "remote", tool: "search", arguments: { q: "x" } });
		expect(called.content[0]?.text).toContain("remote result");
		// The initialized notification must complete before normal operations start.
		expect(capturedMethods).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
		// The session id and negotiated protocol version from initialize ride
		// every later call; the secret reference is passed through untouched
		// for the kernel to resolve.
		expect(capturedHeaders[0]?.["mcp-protocol-version"]).toBeUndefined();
		const last = capturedHeaders.at(-1);
		expect(last?.["mcp-session-id"]).toBe("session-42");
		expect(last?.["mcp-protocol-version"]).toBe("2025-06-18");
		expect(last?.authorization).toBe("Bearer secret://mcp-token");
	});
});
