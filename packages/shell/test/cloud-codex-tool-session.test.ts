import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CLOUD_CODEX_BOUNDARY_CONFIG, runCloudCodexToolSession } from "../src/cloud-codex-tool-session.ts";
import { type CloudNativeTool, CloudNativeToolBoundary } from "../src/cloud-native-tool-boundary.ts";

const rpcFixture = fileURLToPath(new URL("./fixtures/codex-boundary-rpc-fixture.cjs", import.meta.url));
const binarySha256 = createHash("sha256")
	.update(await readFile(process.execPath))
	.digest("hex");
let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "qorpera-boundary-rpc-test-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function run(
	mode: string,
	options: { timeoutMs?: number; identityRoot?: string; signal?: AbortSignal; binarySha256?: string } = {},
) {
	const execute = vi.fn<CloudNativeTool["execute"]>(async () => new Promise(() => undefined));
	const signal = options.signal ?? new AbortController().signal;
	const boundary = new CloudNativeToolBoundary({
		companyId: randomUUID(),
		runId: randomUUID(),
		signal,
		assertActive: async () => undefined,
		tools: [
			{
				name: "read_document",
				description: "Read a test document",
				source: "company_file",
				inputSchema: { type: "object", properties: {}, additionalProperties: false },
				parseArguments: () => ({}),
				execute,
			},
		],
	});
	const evidence = join(root, "evidence.json");
	const result = runCloudCodexToolSession({
		command: [process.execPath, rpcFixture, mode, evidence],
		binarySha256,
		boundary,
		model: "offline-probe",
		prompt: "Private test input",
		signal,
		...options,
	});
	return { result, execute, evidence };
}

it.each(["response-first", "notify-first", "fence-before-started", "prewarm-before-thread"])(
	"binds valid native turn-start orderings: %s",
	async (mode) => {
		await expect(run(mode).result).resolves.toEqual({
			providerSessionId: "thread_fixture",
			toolCalls: 0,
			codexVersion: "0.147.0",
			fencedRequests: 1,
		});
	},
);

it("rejects an unpatched binary before creating a thread", async () => {
	await expect(run("missing-fence").result).rejects.toThrow("missing native result fence");
});

it("rejects an artifact digest mismatch before spawning", async () => {
	await expect(run("response-first", { binarySha256: "0".repeat(64) }).result).rejects.toThrow("artifact mismatch");
});

it("cannot report success with only a capability marker and no result-fence requests", async () => {
	await expect(run("skip-fence").result).rejects.toThrow("Native boundary turn is incomplete");
});

it.each(["wrong-fence-thread", "wrong-fence-turn"])("rejects a cross-session result frame: %s", async (mode) => {
	await expect(run(mode).result).rejects.toThrow("Native result boundary unavailable");
});

it.each(["wrong-thread", "wrong-turn", "wrong-namespace"])(
	"denies mismatched native callbacks before dispatch: %s",
	async (mode) => {
		const { result, execute } = run(mode);
		await expect(result).rejects.toThrow("Invalid native boundary protocol");
		expect(execute).not.toHaveBeenCalled();
	},
);

it.each(["invalid-json", "oversized", "missing-result"])(
	"fails closed on malformed native transport: %s",
	async (mode) => {
		await expect(run(mode).result).rejects.toThrow("Invalid native boundary protocol");
	},
);

it("rejects a different provider binary version before starting a thread", async () => {
	await expect(run("wrong-version").result).rejects.toThrow("Unsupported Codex boundary version");
});

it.each(["unsafe-config", "extra-mcp", "unsafe-code-mode", "nested-cloud-tools", "skill-route"])(
	"rejects effective configuration drift before a model request: %s",
	async (mode) => {
		await expect(run(mode).result).rejects.toThrow("Native boundary configuration was not applied");
	},
);

it("rejects provider skills outside the controlled result boundary", async () => {
	await expect(run("extra-skills").result).rejects.toThrow("Native boundary requires an empty provider skill catalog");
});

it("does not return success while a tool call is pending", async () => {
	await expect(run("pending-tool").result).rejects.toThrow("Invalid native boundary protocol");
});

it("keeps native failures private", async () => {
	await expect(run("failed-turn").result).rejects.toThrow("Native boundary turn did not complete");
});

it("rejects native approval callbacks instead of forwarding them as a human approval", async () => {
	const { result, evidence } = run("approval");
	await expect(result).resolves.toMatchObject({ toolCalls: 0 });
	expect(JSON.parse(await readFile(evidence, "utf8"))).toEqual({
		id: "approval",
		error: { code: -32601, message: "Operation not available in this cloud tool boundary" },
	});
});

it("bounds a stalled startup and preserves no raw diagnostics", async () => {
	const started = Date.now();
	await expect(run("stalled", { timeoutMs: 100 }).result).rejects.toThrow("Native boundary execution stopped");
	expect(Date.now() - started).toBeLessThan(2500);
});

it.each(["duplicate-id", "callback-budget"])("rejects native callback replay or floods: %s", async (mode) => {
	const { result, execute } = run(mode);
	await expect(result).rejects.toThrow("Invalid native boundary protocol");
	expect(execute).not.toHaveBeenCalled();
});

it("bounds total private diagnostics independently of individual protocol messages", async () => {
	await expect(run("wire-budget").result).rejects.toThrow("Native boundary output limit exceeded");
});

it("kills the process group, including a descendant that ignores graceful shutdown", async () => {
	const { result, evidence } = run("descendant", { timeoutMs: 300 });
	await expect(result).rejects.toThrow("Native boundary execution stopped");
	await new Promise<void>((resolve) => setTimeout(resolve, 1700));
	await expect(stat(evidence)).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects pre-cancelled work before spawning", async () => {
	const abort = new AbortController();
	abort.abort(new Error("run cancelled"));
	await expect(run("response-first", { signal: abort.signal }).result).rejects.toThrow("run cancelled");
});

it("accepts a host-restored auth-only identity without exposing it in the result", async () => {
	const codexHome = join(root, "identity", "codex");
	await mkdir(codexHome, { recursive: true });
	await writeFile(join(codexHome, "auth.json"), "SYNTHETIC_AUTH_ONLY", { mode: 0o600 });
	await expect(run("response-first", { identityRoot: join(root, "identity") }).result).resolves.toMatchObject({
		providerSessionId: "thread_fixture",
	});
	expect(await readFile(join(codexHome, "auth.json"), "utf8")).toBe("SYNTHETIC_AUTH_ONLY");
});

it.each(["config.toml", "AGENTS.md", "hooks.json", "skills"])(
	"refuses identity content that could add an uncontrolled tool source: %s",
	async (entry) => {
		const codexHome = join(root, "identity", "codex");
		await mkdir(codexHome, { recursive: true });
		await writeFile(join(codexHome, entry), "PRIVATE_UNTRUSTED_CONFIG");
		await expect(run("response-first", { identityRoot: join(root, "identity") }).result).rejects.toThrow(
			"Native boundary requires an auth-only identity",
		);
	},
);

it("does not accept a linked Codex home", async () => {
	await mkdir(join(root, "identity"));
	await mkdir(join(root, "other"));
	await symlink(join(root, "other"), join(root, "identity", "codex"));
	await expect(run("response-first", { identityRoot: join(root, "identity") }).result).rejects.toThrow(
		"Invalid native identity directory",
	);
});

it("pins the no-execution configuration and enough result budget to retain the envelope", () => {
	expect(CLOUD_CODEX_BOUNDARY_CONFIG).toEqual(
		expect.arrayContaining([
			'approval_policy="never"',
			'sandbox_mode="read-only"',
			'web_search="disabled"',
			"features.shell_tool=false",
			"features.unified_exec=false",
			"features.multi_agent=false",
			"features.multi_agent_v2=false",
			"features.apps=false",
			"features.plugins=false",
			"features.hooks=false",
			"features.browser_use=false",
			"features.computer_use=false",
			'features.code_mode={enabled=false,direct_only_tool_namespaces=["qorpera"],excluded_tool_namespaces=["skills"]}',
			"features.code_mode_host=false",
			"mcp_servers={}",
			"skills.bundled.enabled=false",
			"skills.include_instructions=false",
			"orchestrator.skills.enabled=false",
			"orchestrator.mcp.enabled=false",
			"tools.update_plan.enabled=false",
			"tools.experimental_request_user_input.enabled=false",
			"project_doc_max_bytes=0",
			"tool_output_token_limit=65536",
		]),
	);
});
