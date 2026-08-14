/**
 * MCP client (Build 3): stdio JSON-RPC against a faux MCP server —
 * list, call, server-reported errors, and configuration errors.
 * Implementation discipline: faux servers, no real credentials.
 */
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
import { createMcpServerEnvironment, mcpServerConfigurationFingerprint } from "../src/core/tools/mcp-config.ts";

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

	it("binds dependencies of a directly executed local server script", async () => {
		writeFileSync(join(root, "connections", "payload.mjs"), `export const payload = "reviewed";\n`, "utf-8");
		writeFileSync(join(root, "connections", "direct-server.mjs"), `import "./payload.mjs";\n${FAUX_SERVER}`, "utf-8");
		writeFileSync(
			join(root, "connections", "mcp.json"),
			JSON.stringify({ servers: { faux: { command: join(root, "connections", "direct-server.mjs") } } }),
			"utf-8",
		);
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
		await expect(execute("changed-direct-import", input)).rejects.toThrow(
			/configuration changed after authority approval/,
		);
	});

	it("rejects local servers whose dependency closure cannot be proven", async () => {
		declareFauxServer();
		writeFileSync(join(root, "connections", "payload.mjs"), `export const payload = "dynamic";\n`, "utf-8");
		writeFileSync(
			join(root, "connections", "faux-server.mjs"),
			`const dependency = "./payload.mjs";\nawait import(dependency);\n${FAUX_SERVER}`,
			"utf-8",
		);
		await expect(run({ server: "faux", tool: "echo" })).rejects.toThrow(/dependency closure cannot be proven/);
	});

	it("rejects computed alternate module loaders", async () => {
		declareFauxServer();
		writeFileSync(join(root, "connections", "payload.cjs"), `module.exports = "dynamic";\n`, "utf-8");
		writeFileSync(
			join(root, "connections", "faux-server.mjs"),
			`const load = eval("requ" + "ire");\nload("./payload.cjs");\n${FAUX_SERVER}`,
			"utf-8",
		);
		await expect(run({ server: "faux", tool: "echo" })).rejects.toThrow(/dependency closure cannot be proven/);
	});

	it("binds literal runtime inputs inside dependency trees", async () => {
		declareFauxServer();
		mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
		const payloadPath = join(root, "node_modules", "pkg", "payload.json");
		writeFileSync(payloadPath, JSON.stringify({ command: "reviewed" }), "utf-8");
		writeFileSync(
			join(root, "connections", "faux-server.mjs"),
			`import { readFileSync } from "node:fs";\nimport { spawnSync } from "node:child_process";\nif (false) spawnSync(JSON.parse(readFileSync("node_modules/pkg/payload.json", "utf-8")).command);\n${FAUX_SERVER}`,
			"utf-8",
		);
		const input = { server: "faux", tool: "echo", arguments: { text: "bound" } };
		const authority = discoverAuthority(root)!;
		const decision = await finalizeAuthorityDecision(
			authority,
			evaluateToolCall(authority, MCP_TOOL_NAME, input, root),
			MCP_TOOL_NAME,
			input,
		);
		expect(decision.kind).toBe("allow");

		writeFileSync(payloadPath, JSON.stringify({ command: "changed" }), "utf-8");
		const definition = createMcpToolDefinition(root);
		const execute = definition.execute as unknown as (toolCallId: string, args: unknown) => Promise<unknown>;
		await expect(execute("changed-runtime-input", input)).rejects.toThrow(
			/configuration changed after authority approval/,
		);
	});

	it("rejects dynamic runtime file inputs", async () => {
		declareFauxServer();
		writeFileSync(join(root, "payload.json"), JSON.stringify({ command: "dynamic" }), "utf-8");
		writeFileSync(
			join(root, "connections", "faux-server.mjs"),
			`import { readFileSync } from "node:fs";\nconst input = "payload.json";\nreadFileSync(input);\n${FAUX_SERVER}`,
			"utf-8",
		);
		await expect(run({ server: "faux", tool: "echo" })).rejects.toThrow(/runtime input closure cannot be proven/);
	});

	it("rejects aliased filesystem read imports", async () => {
		declareFauxServer();
		writeFileSync(join(root, "payload.json"), JSON.stringify({ command: "aliased" }), "utf-8");
		writeFileSync(
			join(root, "connections", "faux-server.mjs"),
			`import { readFileSync as load } from "node:fs";\nload("payload.json");\n${FAUX_SERVER}`,
			"utf-8",
		);
		await expect(run({ server: "faux", tool: "echo" })).rejects.toThrow(/read imports cannot be aliased/);
	});

	it("resolves query-bearing ESM dependencies", () => {
		declareFauxServer();
		writeFileSync(join(root, "connections", "payload.mjs"), `export const payload = "reviewed";\n`, "utf-8");
		writeFileSync(
			join(root, "connections", "faux-server.mjs"),
			`import "./payload.mjs?runtime";\n${FAUX_SERVER}`,
			"utf-8",
		);
		const before = mcpServerConfigurationFingerprint(root, "faux");
		writeFileSync(join(root, "connections", "payload.mjs"), `export const payload = "changed";\n`, "utf-8");
		expect(mcpServerConfigurationFingerprint(root, "faux")).not.toBe(before);
	});

	it("binds literal child-process scripts", () => {
		declareFauxServer();
		writeFileSync(join(root, "payload.mjs"), `console.log("reviewed");\n`, "utf-8");
		writeFileSync(
			join(root, "connections", "faux-server.mjs"),
			`import { spawnSync } from "node:child_process";\nif (false) spawnSync(process.execPath, ["payload.mjs"]);\n${FAUX_SERVER}`,
			"utf-8",
		);
		const before = mcpServerConfigurationFingerprint(root, "faux");
		writeFileSync(join(root, "payload.mjs"), `console.log("changed");\n`, "utf-8");
		expect(mcpServerConfigurationFingerprint(root, "faux")).not.toBe(before);
	});

	it("binds no-substitution template-literal child-process scripts", () => {
		declareFauxServer();
		writeFileSync(join(root, "payload.mjs"), `console.log("reviewed");\n`, "utf-8");
		writeFileSync(
			join(root, "connections", "faux-server.mjs"),
			`import { spawnSync } from "node:child_process";\nif (false) spawnSync(process.execPath, [\`payload.mjs\`]);\n${FAUX_SERVER}`,
			"utf-8",
		);
		const before = mcpServerConfigurationFingerprint(root, "faux");
		writeFileSync(join(root, "payload.mjs"), `console.log("changed");\n`, "utf-8");
		expect(mcpServerConfigurationFingerprint(root, "faux")).not.toBe(before);
	});

	it.each([
		["escaped quoted", `["payload\\u002emjs"]`],
		["escaped template", `[\`payload\\u002emjs\`]`],
	])("binds %s child-process scripts", (_name, childArguments) => {
		declareFauxServer();
		writeFileSync(join(root, "payload.mjs"), `console.log("reviewed");\n`, "utf-8");
		writeFileSync(
			join(root, "connections", "faux-server.mjs"),
			`import { spawnSync } from "node:child_process";\nif (false) spawnSync(process.execPath, ${childArguments});\n${FAUX_SERVER}`,
			"utf-8",
		);
		const before = mcpServerConfigurationFingerprint(root, "faux");
		writeFileSync(join(root, "payload.mjs"), `console.log("changed");\n`, "utf-8");
		expect(mcpServerConfigurationFingerprint(root, "faux")).not.toBe(before);
	});

	it("rejects computed child-process script paths", async () => {
		declareFauxServer();
		writeFileSync(join(root, "payload.mjs"), `console.log("reviewed");\n`, "utf-8");
		writeFileSync(
			join(root, "connections", "faux-server.mjs"),
			`import { spawnSync } from "node:child_process";\nconst script = "payload" + ".mjs";\nif (false) spawnSync(process.execPath, [script]);\n${FAUX_SERVER}`,
			"utf-8",
		);
		await expect(run({ server: "faux", tool: "echo" })).rejects.toThrow(/interpreter arguments must be static/);
	});

	it.each([
		["separated Node eval", process.execPath, ["-e", `import('./payload.mjs')`]],
		["attached Python command", "python3", [`-cexec(open('payload.mjs').read())`]],
		["attached Bun eval", "bun", [`-eimport('./payload.mjs')`]],
		["wrapped attached Python command", "env", ["python3", `-cexec(open('payload.mjs').read())`]],
		["split wrapper command", "env", ["-S", `python3 -cexec(open('payload.mjs').read())`]],
		["abbreviated split wrapper command", "env", [`--s=python3 -cexec(open('payload.mjs').read())`]],
	])("rejects %s whose dependency closure cannot be bound", async (_name, command, args) => {
		writeFileSync(join(root, "connections", "payload.mjs"), `export const payload = "reviewed";\n`, "utf-8");
		writeFileSync(
			join(root, "connections", "mcp.json"),
			JSON.stringify({
				servers: { faux: { command, args } },
			}),
			"utf-8",
		);
		await expect(run({ server: "faux", tool: "echo" })).rejects.toThrow(
			/inline interpreter programs are not allowed/,
		);
	});

	it("checks the resolved interpreter when its configured name identifies another launcher", async () => {
		if (process.platform === "win32") return;
		const launcher = join(root, "env");
		symlinkSync(process.execPath, launcher);
		writeFileSync(
			join(root, "connections", "mcp.json"),
			JSON.stringify({ servers: { faux: { command: launcher, args: ["-e", `import('./payload.mjs')`] } } }),
			"utf-8",
		);
		await expect(run({ server: "faux", tool: "echo" })).rejects.toThrow(
			/inline interpreter programs are not allowed/,
		);
	});

	it.each([
		[
			"aliased child-process APIs",
			`import { spawnSync as runChild } from "node:child_process";\nif (false) runChild(process.env.CMD);`,
			/child-process APIs cannot be aliased/,
		],
		[
			"unrelated file reads in dynamic executable expressions",
			`import { readFileSync } from "node:fs";\nimport { spawnSync } from "node:child_process";\nif (false) spawnSync((readFileSync("payload.txt"), process.env.CMD));`,
			/child-process executables must be static/,
		],
		[
			"shell expansion through spawn options",
			`import { spawnSync } from "node:child_process";\nif (false) spawnSync("exec $(cat command)", { shell: true });`,
			/shell commands cannot use runtime expansion/,
		],
		[
			"computed child-process namespace properties",
			`import * as childProcess from "node:child_process";\nconst runChild = childProcess["sp" + "awnSync"];\nif (false) runChild(process.env.CMD);`,
			/child-process namespace properties cannot be computed/,
		],
		[
			"destructured child-process aliases without whitespace",
			`import * as childProcess from "node:child_process";\nconst { spawnSync:runChild } = childProcess;\nif (false) runChild(process.env.CMD);`,
			/child-process APIs cannot be aliased/,
		],
		[
			"shell expansion through spawn arguments",
			`import { spawnSync } from "node:child_process";\nif (false) spawnSync("printf", ["$(cat command)"], { shell: true });`,
			/shell commands cannot use runtime expansion/,
		],
	])("rejects %s", async (_name, source, expected) => {
		declareFauxServer();
		writeFileSync(join(root, "payload.txt"), "reviewed\n", "utf-8");
		writeFileSync(join(root, "connections", "faux-server.mjs"), `${source}\n${FAUX_SERVER}`, "utf-8");
		await expect(run({ server: "faux", tool: "echo" })).rejects.toThrow(expected);
	});

	it("does not bind unrelated company files to a local server", () => {
		declareFauxServer();
		const before = mcpServerConfigurationFingerprint(root, "faux");
		writeFileSync(join(root, "unrelated.txt"), "ordinary company edit\n", "utf-8");
		expect(mcpServerConfigurationFingerprint(root, "faux")).toBe(before);
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
