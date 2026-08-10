/**
 * MCP client (Build 3): stdio JSON-RPC against a faux MCP server —
 * list, call, server-reported errors, and configuration errors.
 * Implementation discipline: faux servers, no real credentials.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpToolDefinition, disposeMcpConnections } from "../src/core/tools/mcp.ts";

const FAUX_SERVER = `import { createInterface } from "node:readline";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
	if (!line.trim()) return;
	const message = JSON.parse(line);
	if (message.id === undefined) return; // notifications
	if (message.method === "initialize") {
		reply(message.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "faux", version: "1" } });
	} else if (message.method === "tools/list") {
		reply(message.id, { tools: [{ name: "echo", description: "Echoes text back", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] });
	} else if (message.method === "tools/call") {
		if (message.params.name === "echo") {
			reply(message.id, { content: [{ type: "text", text: "echo: " + (message.params.arguments?.text ?? "") }] });
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
	writeFileSync(join(root, "authority.toml"), `[irreversible]\nmode = "auto"\n`, "utf-8");
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
	const definition = createMcpToolDefinition(root);
	const execute = definition.execute as unknown as (toolCallId: string, args: unknown) => Promise<unknown>;
	return (await execute("test-call", input)) as {
		content: Array<{ type: string; text?: string }>;
		details?: { server: string; tool?: string; isError?: boolean };
	};
}

describe("use_mcp_tool", () => {
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
