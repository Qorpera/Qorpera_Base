import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CLOUD_ACTION_REVIEW_INSTRUCTIONS,
	CLOUD_ACTION_REVIEW_SPECIFICATION,
	CloudActionReviewChannel,
	CloudActionReviewGate,
} from "@qorpera/runtime/cloud-action-review";
import { CLOUD_CODEX_BOUNDARY_CONFIG, runCloudCodexToolSession } from "@qorpera/runtime/cloud-codex-tool-session";
import { CloudNativeCaptureImages } from "@qorpera/runtime/cloud-native-capture-images";
import { nativeRuntimeFailureMetadata } from "@qorpera/runtime/cloud-native-failure";
import * as nativeIsolation from "@qorpera/runtime/cloud-native-isolation";
import { nativeProviderUsageSignal } from "@qorpera/runtime/cloud-native-provider-host";
import {
	CLOUD_TOOL_RESULT_INSTRUCTIONS,
	type CloudNativeTool,
	CloudNativeToolBoundary,
} from "@qorpera/runtime/cloud-native-tool-boundary";
import { CloudRuntimeObservability, type CloudRuntimeObservation } from "@qorpera/runtime/cloud-runtime-observability";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const rpcFixture = fileURLToPath(new URL("./fixtures/codex-boundary-rpc-fixture.cjs", import.meta.url));
const binarySha256 = createHash("sha256")
	.update(await readFile(process.execPath))
	.digest("hex");
let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "qorpera-boundary-rpc-test-"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	await rm(root, { recursive: true, force: true });
});

function run(
	mode: string,
	options: {
		model?: string;
		reasoningEffort?: "low" | "medium" | "high";
		timeoutMs?: number;
		identityRoot?: string;
		runtimeInstructions?: string;
		signal?: AbortSignal;
		binarySha256?: string;
		isolation?: nativeIsolation.NativeIsolationConfiguration;
		beforeModelStart?: (signal: AbortSignal) => Promise<void>;
		observability?: CloudRuntimeObservability;
		tools?: CloudNativeTool[];
		recordContextView?: Parameters<typeof runCloudCodexToolSession>[0]["recordContextView"];
	} = {},
) {
	const execute = vi.fn<CloudNativeTool["execute"]>(async () => new Promise(() => undefined));
	const signal = options.signal ?? new AbortController().signal;
	const boundary = new CloudNativeToolBoundary({
		companyId: randomUUID(),
		runId: randomUUID(),
		signal,
		assertActive: async () => undefined,
		tools: options.tools ?? [
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
		...options,
		signal,
	});
	return { result, execute, evidence };
}

function observationCollector() {
	const rows: CloudRuntimeObservation[] = [];
	const observability = new CloudRuntimeObservability({
		assignmentId: randomUUID(),
		publish: async (row) => {
			rows.push(row);
		},
	});
	return { rows, observability };
}

it.each(["response-first", "notify-first", "fence-before-started", "prewarm-before-thread"])(
	"binds valid native turn-start orderings: %s",
	async (mode) => {
		await expect(run(mode).result).resolves.toEqual({
			providerSessionId: "thread_fixture",
			toolCalls: 0,
			codexVersion: "0.155.1",
			fencedRequests: 1,
		});
	},
);

it("rejects an unpatched binary before creating a thread", async () => {
	await expect(run("missing-fence").result).rejects.toThrow("missing native result fence");
});

it.each([
	["provider-default", undefined],
	["gpt-5.6-sol", "gpt-5.6-sol"],
])("starts native threads with model %s and low effort", async (model, expectedModel) => {
	const { result, evidence } = run("model-selection", { model });
	await result;
	const recorded = JSON.parse(await readFile(evidence, "utf8"));
	// provider-default sends no model: the pinned binary picks its own default.
	expect(recorded.threadParameters.model).toBe(expectedModel);
	expect(recorded).toMatchObject({
		turnParameters: { effort: "low" },
		configuration: { model_reasoning_effort: "low" },
	});
});

it("starts a routine turn at the effort its routine chose", async () => {
	const { result, evidence } = run("model-selection", { reasoningEffort: "high" });
	await result;
	const recorded = JSON.parse(await readFile(evidence, "utf8"));
	expect(recorded).toMatchObject({
		turnParameters: { effort: "high" },
		configuration: { model_reasoning_effort: "high" },
	});
	await expect(run("model-selection", { reasoningEffort: "max" as never }).result).rejects.toThrow(
		"Invalid native boundary input",
	);
});

it("requires composition telemetry before admitting a model request", async () => {
	const beforeModelStart = vi.fn(async () => undefined);
	await expect(run("missing-composition", { beforeModelStart }).result).rejects.toThrow("message composition support");
	expect(beforeModelStart).not.toHaveBeenCalled();
});

it("loads the exact host-generated AGENTS.md bytes without enabling ambient instructions", async () => {
	const { result, evidence } = run("bootstrap", { runtimeInstructions: "HOST_OWNED_CONSTITUTION" });
	await result;
	const recorded = JSON.parse(await readFile(evidence, "utf8"));
	expect(recorded.bootstrap).toBe(recorded.threadParameters.developerInstructions);
	expect(recorded.bootstrap).toContain(CLOUD_TOOL_RESULT_INSTRUCTIONS);
	expect(recorded.bootstrap).toContain("HOST_OWNED_CONSTITUTION");
	expect(recorded.bootstrap).not.toContain("Private test input");
	expect(recorded.mode).toBe(0o400);
	expect(CLOUD_CODEX_BOUNDARY_CONFIG).toContain("project_doc_max_bytes=0");
	await expect(stat(recorded.threadParameters.cwd)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["capture-image", "response-first"])(
	"requires the image capability and transports a capture above the text-message budget: %s",
	async (mode) => {
		const pixels = Buffer.alloc(2 * 1024 * 1024);
		const sha256 = createHash("sha256").update(pixels).digest("hex");
		const capture = {
			assetId: randomUUID(),
			screenId: randomUUID(),
			bytes: pixels.length,
			sha256,
			width: 1,
			height: 1,
			mediaType: "image/png" as const,
			surface: "browser" as const,
		};
		const execute = vi.fn(async () => ({ kind: "json" as const, value: capture }));
		const signal = new AbortController().signal;
		const boundary = new CloudNativeToolBoundary({
			companyId: randomUUID(),
			runId: randomUUID(),
			signal,
			assertActive: async () => undefined,
			captures: new CloudNativeCaptureImages({ read: async () => pixels, assertReadable: async () => undefined }),
			tools: [
				{
					name: "computer_screenshot",
					source: "runtime",
					description: "Capture fixture",
					inputSchema: { type: "object", additionalProperties: false },
					parseArguments: () => ({}),
					execute,
				},
			],
		});
		const evidence = join(root, "capture.json");
		const result = runCloudCodexToolSession({
			command: [process.execPath, rpcFixture, mode, evidence],
			binarySha256,
			boundary,
			model: "offline-probe",
			prompt: "Capture fixture",
			signal,
		});
		if (mode === "response-first") {
			await expect(result).rejects.toThrow("requires capture image support");
			expect(execute).not.toHaveBeenCalled();
		} else {
			await expect(result).resolves.toMatchObject({ toolCalls: 1, fencedRequests: 2 });
			expect(JSON.parse(await readFile(evidence, "utf8"))).toMatchObject({
				imageBytes: pixels.length,
				sha256,
				fenced: { outputs: [{ imageSha256: sha256 }] },
			});
		}
	},
);

it("rejects the older result-only patch before model admission", async () => {
	const beforeModelStart = vi.fn(async () => undefined);
	const { result, execute } = run("missing-direct-tools", { beforeModelStart });
	await expect(result).rejects.toThrow("Native boundary requires governed direct tools");
	expect(beforeModelStart).not.toHaveBeenCalled();
	expect(execute).not.toHaveBeenCalled();
});

it("rejects an artifact digest mismatch before spawning", async () => {
	await expect(run("response-first", { binarySha256: "0".repeat(64) }).result).rejects.toThrow("artifact mismatch");
});

it("nests private runtime scratch below its temporary allocation and cleans it after failed containment", async () => {
	let allocation: string | undefined;
	vi.spyOn(nativeIsolation, "launchIsolatedNativeProcess").mockImplementation(async (options) => {
		expect(basename(options.scratchRoot)).toBe("runtime");
		allocation = dirname(options.scratchRoot);
		expect(basename(allocation)).toMatch(/^qorpera-codex-boundary-/);
		expect((await stat(options.scratchRoot)).mode & 0o777).toBe(0o700);
		throw new Error("Synthetic containment startup failure");
	});
	await expect(
		run("response-first", { isolation: { entryPoint: "/unused-synthetic-isolation.mjs" } }).result,
	).rejects.toThrow("Synthetic containment startup failure");
	expect(allocation).toBeDefined();
	await expect(stat(allocation!)).rejects.toMatchObject({ code: "ENOENT" });
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

it.each([
	["terminal-error-notice", "usage_limit"],
	["terminal-rate-error", "rate_limited"],
	["terminal-http-error", "provider_outage"],
	["terminal-context-error", undefined],
	["diagnostic-binding", undefined],
	["unknown-error-notice", undefined],
])("retains a typed usage signal without an optional observer: %s", async (mode, signal) => {
	const error = await run(mode).result.catch((failure: unknown) => failure);
	expect(error).toBeInstanceOf(Error);
	expect(nativeProviderUsageSignal(error)).toBe(signal);
	expect(nativeRuntimeFailureMetadata(error)).toMatchObject({ usageSignal: signal ?? null });
	expect(JSON.stringify(nativeRuntimeFailureMetadata(error))).not.toMatch(/PRIVATE_|thread_fixture|turn_fixture/);
});

it.each([
	["missing-direct-tools", "codex-initialize"],
	["unsafe-config", "codex-configuration"],
	["extra-skills", "codex-skills"],
	["turn-request-rejected", "codex-turn-start"],
])("retains the failing native startup phase without provider text: %s", async (mode, stage) => {
	const error = await run(mode).result.catch((failure: unknown) => failure);
	expect(nativeRuntimeFailureMetadata(error)).toMatchObject({ stage, usageSignal: null });
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

it("rejects a replayed native callback", async () => {
	const { result, execute } = run("duplicate-id");
	await expect(result).rejects.toThrow("Invalid native boundary protocol");
	expect(execute).not.toHaveBeenCalled();
});

it("answers native callbacks far past the removed request cap without failing the run", async () => {
	// No run is capped by its number of tool calls or requests (founder, 2026-09-24).
	const { result, execute } = run("callback-flood");
	await expect(result).resolves.toMatchObject({ toolCalls: 0 });
	expect(execute).not.toHaveBeenCalled();
});

it("keeps no cap on total private diagnostics", async () => {
	// The old 16 MiB output cap is gone; each protocol message stays bounded on its own.
	await expect(run("wire-flood").result).resolves.toMatchObject({ toolCalls: 0 });
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

it.each(["response-first", "notify-first", "fence-before-started", "prewarm-before-thread"])(
	"observes one logical turn and distinct unconfirmed gates without changing ordering: %s",
	async (mode) => {
		const { rows, observability } = observationCollector();
		await expect(run(mode, { observability }).result).resolves.toMatchObject({ fencedRequests: 1 });
		await observability.close();
		const turns = rows.filter((row) => row.operation === "model_turn");
		expect(turns).toHaveLength(2);
		expect(turns[0]).toMatchObject({ phase: "start", status: "started", durationMs: null, inputBytes: 18 });
		expect(turns[1]).toMatchObject({
			phase: "finish",
			status: "succeeded",
			errorCategory: null,
			outputBytes: null,
			inputTokens: null,
			outputTokens: null,
			cachedInputTokens: null,
			cacheWriteInputTokens: null,
			reasoningOutputTokens: null,
			totalTokens: null,
		});
		expect(turns[1].attemptId).toBe(turns[0].attemptId);
		expect(turns[1].logicalOperationSha256).toBe(turns[0].logicalOperationSha256);
		expect(turns[1].durationMs).toBeGreaterThanOrEqual(0);
		const gates = rows.filter((row) => row.operation === "native_result_fence");
		expect(gates).toHaveLength(mode === "prewarm-before-thread" ? 4 : 2);
		for (const gate of gates.filter((row) => row.phase === "finish")) {
			expect(gate.status).toBe("unconfirmed");
			expect(gate.inputTokens).toBeNull();
		}
		expect(gates.filter((row) => row.parentAttemptId === turns[0].attemptId)).toHaveLength(2);
		expect(gates.filter((row) => row.parentAttemptId === null)).toHaveLength(
			mode === "prewarm-before-thread" ? 2 : 0,
		);
		expect(rows.some((row) => row.operation === "model_request")).toBe(false);
		expect(JSON.stringify(rows)).not.toMatch(/PRIVATE_|thread_fixture|turn_fixture/);
	},
);

it.each(["observed-usage", "usage-after-completion"])(
	"keeps the latest native total snapshot without summing retries, estimates or post-completion updates: %s",
	async (mode) => {
		const { rows, observability } = observationCollector();
		await run(mode, { observability }).result;
		await observability.close();
		expect(rows.find((row) => row.operation === "model_turn" && row.phase === "finish")).toMatchObject({
			status: "succeeded",
			inputTokens: 23,
			outputTokens: 7,
			cachedInputTokens: 3,
			cacheWriteInputTokens: 5,
			reasoningOutputTokens: 2,
			totalTokens: 30,
		});
		expect(rows).toHaveLength(4);
	},
);

it("preserves explicit native zero counters while absent usage remains unknown", async () => {
	const { rows, observability } = observationCollector();
	await run("observed-zero-usage", { observability }).result;
	await observability.close();
	expect(rows.find((row) => row.operation === "model_turn" && row.phase === "finish")).toMatchObject({
		inputTokens: 0,
		outputTokens: 0,
		cachedInputTokens: 0,
		cacheWriteInputTokens: 0,
		reasoningOutputTokens: 0,
		totalTokens: 0,
	});
});

it.each(["negative", "unsafe", "fraction", "string", "null", "missing", "extra", "last", "window", "primitive"])(
	"drops malformed optional usage without weakening native execution: %s",
	async (fault) => {
		const { rows, observability } = observationCollector();
		await expect(run(`invalid-usage-${fault}`, { observability }).result).resolves.toMatchObject({
			fencedRequests: 1,
		});
		await observability.close();
		expect(rows.find((row) => row.operation === "model_turn" && row.phase === "finish")).toMatchObject({
			status: "succeeded",
			inputTokens: null,
			outputTokens: null,
			cachedInputTokens: null,
			cacheWriteInputTokens: null,
			reasoningOutputTokens: null,
			totalTokens: null,
		});
		expect(JSON.stringify(rows)).not.toContain("PRIVATE_");
	},
);

it.each([
	["diagnostic-binding", "provider_failed"],
	["terminal-error-notice", "budget_exhausted"],
	["terminal-http-error", "transport_unavailable"],
	["unknown-error-notice", "provider_failed"],
	["failed-turn", "provider_failed"],
])("classifies bound native failure metadata without exposing diagnostic text: %s", async (mode, category) => {
	const { rows, observability } = observationCollector();
	await expect(run(mode, { observability }).result).rejects.toThrow("Native boundary turn did not complete");
	await observability.close();
	expect(rows.find((row) => row.operation === "model_turn" && row.phase === "finish")).toMatchObject({
		status: "failed",
		errorCategory: category,
		inputTokens: null,
		outputTokens: null,
	});
	expect(JSON.stringify(rows)).not.toMatch(/PRIVATE_|unrelated_private|thread_fixture|turn_fixture/);
});

it("does not count retry hints as requests or turn a completed native turn into a failure", async () => {
	const { rows, observability } = observationCollector();
	await expect(run("retry-notice", { observability }).result).resolves.toMatchObject({ fencedRequests: 1 });
	await observability.close();
	expect(rows.find((row) => row.operation === "model_turn" && row.phase === "finish")).toMatchObject({
		status: "succeeded",
		errorCategory: null,
		totalTokens: 30,
	});
	expect(rows).toHaveLength(4);
	expect(rows.some((row) => row.operation === "model_request")).toBe(false);
	expect(JSON.stringify(rows)).not.toContain("PRIVATE_");
});

it.each(["skip-fence", "pending-tool"])(
	"never emits logical success before host completion checks: %s",
	async (mode) => {
		const { rows, observability } = observationCollector();
		await expect(run(mode, { observability }).result).rejects.toThrow();
		await observability.close();
		const turns = rows.filter((row) => row.operation === "model_turn");
		expect(turns).toHaveLength(2);
		expect(turns[1]).toMatchObject({ phase: "finish", status: "failed", errorCategory: "invalid_response" });
		expect(rows.some((row) => row.status === "succeeded")).toBe(false);
	},
);

function publicSendTool(): CloudNativeTool {
	return {
		name: "send_message",
		description: "Public send",
		source: "runtime",
		inputSchema: {
			type: "object",
			properties: { idempotencyKey: { type: "string" }, text: { type: "string" }, phase: { type: "string" } },
			additionalProperties: false,
		},
		parseArguments: (value) => value,
		execute: async (value) => ({
			kind: "text",
			value: JSON.stringify({ messageId: "m1" }),
			completesTurn: (value as { phase?: string }).phase === "final",
		}),
	};
}
it("ends the turn after the fence that follows a confirmed final send", async () => {
	const { rows, observability } = observationCollector();
	const { result, evidence } = run("final-send-ends-turn", { observability, tools: [publicSendTool()] });
	await expect(result).resolves.toEqual({
		providerSessionId: "thread_fixture",
		toolCalls: 1,
		codexVersion: "0.155.1",
		fencedRequests: 2,
	});
	await observability.close();
	const recorded = JSON.parse(await readFile(evidence, "utf8"));
	expect(recorded.interrupt).toEqual({ threadId: "thread_fixture", turnId: "turn_fixture" });
	// The host-only marker never reaches the provider.
	expect(Object.keys(recorded.reply.result).sort()).toEqual(["contentItems", "success"]);
	// The fence reply for the final send arrived before the interrupted completion.
	expect(recorded.fenced).toBeTypeOf("object");
	expect(rows.find((row) => row.operation === "model_turn" && row.phase === "finish")).toMatchObject({
		status: "succeeded",
		errorCategory: null,
	});
});
it("still accepts a natural completion after requesting the turn end", async () => {
	const { result, evidence } = run("final-send-natural", { tools: [publicSendTool()] });
	await expect(result).resolves.toMatchObject({ toolCalls: 1, fencedRequests: 2 });
	const recorded = JSON.parse(await readFile(evidence, "utf8"));
	expect(recorded.interrupt).toEqual({ threadId: "thread_fixture", turnId: "turn_fixture" });
});
it("does not end the turn after a progress send", async () => {
	const { result, evidence } = run("progress-send-no-end", { tools: [publicSendTool()] });
	await expect(result).resolves.toMatchObject({ toolCalls: 1, fencedRequests: 2 });
	const recorded = JSON.parse(await readFile(evidence, "utf8"));
	expect(recorded.interrupt).toBeNull();
});
it("ends an interrupted native turn as cancelled while preserving the public failure", async () => {
	const { rows, observability } = observationCollector();
	await expect(run("interrupted-turn", { observability }).result).rejects.toThrow(
		"Native boundary turn did not complete",
	);
	await observability.close();
	expect(rows.find((row) => row.operation === "model_turn" && row.phase === "finish")).toMatchObject({
		status: "cancelled",
		errorCategory: "cancelled",
	});
});

it.each(["turn-start-stalled", "turn-stalled"])(
	"observes a bounded logical timeout even without a native completion: %s",
	async (mode) => {
		const { rows, observability } = observationCollector();
		await expect(run(mode, { observability, timeoutMs: 1000 }).result).rejects.toThrow(
			"Native boundary execution stopped",
		);
		await observability.close();
		const turns = rows.filter((row) => row.operation === "model_turn");
		expect(turns).toHaveLength(2);
		expect(turns[1]).toMatchObject({ phase: "finish", status: "failed", errorCategory: "timeout" });
		expect(turns[1].durationMs).toBeGreaterThanOrEqual(0);
	},
);

it("records a rejected turn-start request without leaking its error", async () => {
	const { rows, observability } = observationCollector();
	await expect(run("turn-request-rejected", { observability }).result).rejects.toThrow(
		"Native boundary request rejected",
	);
	await observability.close();
	expect(rows).toHaveLength(2);
	expect(rows[1]).toMatchObject({
		operation: "model_turn",
		phase: "finish",
		status: "failed",
		errorCategory: "provider_failed",
	});
	expect(JSON.stringify(rows)).not.toContain("PRIVATE_");
});

it("keeps pre-admission failures out of logical model-turn observations", async () => {
	const { rows, observability } = observationCollector();
	await expect(run("missing-direct-tools", { observability }).result).rejects.toThrow("governed direct tools");
	await observability.close();
	expect(rows).toEqual([]);
});

it("does not end a gate while mandatory context recording is pending", async () => {
	const { rows, observability } = observationCollector();
	let release: () => void = () => undefined;
	const recorded = new Promise<void>((resolve) => {
		release = resolve;
	});
	const { result } = run("response-first", { observability, recordContextView: async () => recorded });
	await vi.waitFor(() =>
		expect(rows.some((row) => row.operation === "native_result_fence" && row.phase === "start")).toBe(true),
	);
	expect(rows.some((row) => row.phase === "finish")).toBe(false);
	release();
	await result;
	await observability.close();
	expect(rows.find((row) => row.operation === "native_result_fence" && row.phase === "finish")?.status).toBe(
		"unconfirmed",
	);
});

it.each(["response-first", "prewarm-before-thread"])(
	"does not hide mandatory context-recording failure behind optional observations: %s",
	async (mode) => {
		const { rows, observability } = observationCollector();
		await expect(
			run(mode, {
				observability,
				recordContextView: async () => {
					throw new Error("PRIVATE_CONTEXT_FAILURE");
				},
			}).result,
		).rejects.toThrow("Native result boundary unavailable");
		await observability.close();
		for (const row of rows.filter((row) => row.phase === "finish")) {
			expect(row).toMatchObject({ status: "failed", errorCategory: "authority_unavailable" });
		}
		expect(rows).toHaveLength(mode === "prewarm-before-thread" ? 2 : 4);
		expect(JSON.stringify(rows)).not.toContain("PRIVATE_");
	},
);

it("records cancellation during context recording without claiming reply delivery", async () => {
	const { rows, observability } = observationCollector();
	const abort = new AbortController();
	await expect(
		run("response-first", {
			observability,
			signal: abort.signal,
			recordContextView: async () => {
				abort.abort(new Error("PRIVATE_CANCEL_REASON"));
			},
		}).result,
	).rejects.toThrow("Native boundary execution stopped");
	await observability.close();
	expect(rows).toHaveLength(4);
	for (const row of rows.filter((row) => row.phase === "finish")) {
		expect(row).toMatchObject({ status: "cancelled", errorCategory: "cancelled" });
	}
	expect(JSON.stringify(rows)).not.toContain("PRIVATE_");
});

it("does not let a failing exporter change native success", async () => {
	const observability = new CloudRuntimeObservability({
		assignmentId: randomUUID(),
		publish: async () => {
			throw new Error("PRIVATE_EXPORT_FAILURE");
		},
	});
	await expect(run("observed-usage", { observability }).result).resolves.toMatchObject({ fencedRequests: 1 });
	await observability.close();
	expect(observability.state.status).toBe("unavailable");
});

it.each(["start", "update", "finish"])("isolates an unexpected optional observer exception at %s", async (method) => {
	const { observability } = observationCollector();
	const start = observability.start.bind(observability);
	vi.spyOn(observability, "start").mockImplementation((operation, options) => {
		if (method === "start") throw new Error("PRIVATE_OBSERVER_FAILURE");
		const span = start(operation, options);
		return {
			...span,
			[method]: () => {
				throw new Error("PRIVATE_OBSERVER_FAILURE");
			},
		};
	});
	await expect(run("observed-usage", { observability }).result).resolves.toMatchObject({ fencedRequests: 1 });
	await observability.close();
});

function composing(mode: string, signal?: AbortSignal) {
	const { rows, observability } = observationCollector();
	const execute = vi.fn<CloudNativeTool["execute"]>(async () => ({ kind: "text", value: "Delivered" }));
	const invocation = run(mode, {
		observability,
		signal,
		tools: [
			{
				name: "send_message",
				source: "runtime",
				description: "Public reply fixture",
				inputSchema: { type: "object", properties: { text: { type: "string" } }, additionalProperties: false },
				parseArguments: () => ({}),
				execute,
			},
		],
	});
	return {
		...invocation,
		execute,
		rows,
		observability,
		release: () => writeFile(`${invocation.evidence}.continue`, "continue"),
	};
}

it("exports writing before the complete send call and renews long composition without retaining text", async () => {
	const f = composing("composition-held");
	const phases = () => f.rows.filter((row) => row.operation === "message_composition");
	try {
		await vi.waitFor(() => expect(phases()).toHaveLength(1));
		expect(f.execute).not.toHaveBeenCalled();
		expect(phases()[0]).toMatchObject({ phase: "start", status: "started", inputBytes: null, outputBytes: null });
		await vi.waitFor(() => expect(phases()).toHaveLength(3), { timeout: 6500 });
		expect(phases().map((row) => row.phase)).toEqual(["start", "start", "finish"]);
		expect(phases()[2].attemptId).toBe(phases()[0].attemptId);
		expect(phases()[1].attemptId).not.toBe(phases()[0].attemptId);
		expect(f.execute).not.toHaveBeenCalled();
		await f.release();
		await f.result;
		await f.observability.close();
		expect(f.execute).toHaveBeenCalledOnce();
		expect(phases()).toHaveLength(4);
		expect(phases()[3]).toMatchObject({ phase: "finish", status: "succeeded", attemptId: phases()[1].attemptId });
		expect(JSON.stringify(f.rows)).not.toMatch(/PRIVATE_|PUBLIC_REPLY|public_reply|thread_fixture|turn_fixture/);
	} finally {
		await f.release();
		await f.result.catch(() => undefined);
		await f.observability.close();
	}
}, 10000);

it("does not revive a composition whose finish preceded its start", async () => {
	const f = composing("composition-replayed");
	await vi.waitFor(async () => expect(JSON.parse(await readFile(f.evidence, "utf8"))).toEqual({ stage: "composing" }));
	await f.release();
	await f.result;
	await f.observability.close();
	expect(f.rows.filter((row) => row.operation === "message_composition")).toEqual([]);
});

it("ends an unfinished composition when its turn completes", async () => {
	const f = composing("composition-unfinished");
	await vi.waitFor(() => expect(f.rows.some((row) => row.operation === "message_composition")).toBe(true));
	await f.release();
	await f.result;
	await f.observability.close();
	expect(
		f.rows.filter((row) => row.operation === "message_composition").map((row) => [row.phase, row.status]),
	).toEqual([
		["start", "started"],
		["finish", "unconfirmed"],
	]);
	expect(f.execute).not.toHaveBeenCalled();
});

it("clears writing and its renewal timer when composition is cancelled", async () => {
	const abort = new AbortController();
	const f = composing("composition-held", abort.signal);
	const failure = expect(f.result).rejects.toThrow("Native boundary execution stopped");
	await vi.waitFor(() => expect(f.rows.some((row) => row.operation === "message_composition")).toBe(true));
	abort.abort();
	await failure;
	await f.observability.close();
	expect(
		f.rows.filter((row) => row.operation === "message_composition").map((row) => [row.phase, row.status]),
	).toEqual([
		["start", "started"],
		["finish", "cancelled"],
	]);
	expect(f.execute).not.toHaveBeenCalled();
});

// Auto-review (v115): the reviewer is a second, fresh thread in the same app-server,
// started while the agent's tool call is open. Its only output is its verdict tool
// call; its model requests pass the fence on their own lane, never as the agent's.
function reviewRun(mode: "review" | "review-no-verdict") {
	const execute = vi.fn<CloudNativeTool["execute"]>(async () => ({ kind: "text", value: "Sent." }));
	const reviewer = new CloudActionReviewChannel();
	const signal = new AbortController().signal;
	const boundary = new CloudNativeToolBoundary({
		companyId: randomUUID(),
		runId: randomUUID(),
		signal,
		assertActive: async () => undefined,
		tools: [
			{
				name: "send_email",
				description: "Send an email",
				source: "connector",
				inputSchema: { type: "object", properties: { to: { type: "string" } }, additionalProperties: false },
				parseArguments: (value) => value,
				execute,
			},
		],
		review: new CloudActionReviewGate({
			binding: { runId: randomUUID() } as never,
			control: {
				call: async (method) =>
					method === "qorpera_begin_action_review"
						? { state: "review", agent: { name: "Tina" }, company: { name: "Acme" }, requester: null, rules: [] }
						: { reviewId: "review-1", decision: "allow", card: false, reason: "Fine." },
			},
			reviewer,
			request: "Email Bob.",
			holdMs: 0,
		}),
	});
	const contextViews: string[] = [];
	const evidence = join(root, "evidence.json");
	const result = runCloudCodexToolSession({
		command: [process.execPath, rpcFixture, mode, evidence],
		binarySha256,
		boundary,
		model: "offline-probe",
		prompt: "Private test input",
		reviewer,
		recordContextView: async (frame) => {
			contextViews.push(frame.threadId);
		},
		signal,
	});
	return { result, execute, evidence, contextViews };
}

it("reviews an acting call in a second thread of the same app-server before running it", async () => {
	const { result, execute, evidence, contextViews } = reviewRun("review");
	await expect(result).resolves.toMatchObject({ providerSessionId: "thread_fixture", toolCalls: 1 });
	expect(execute).toHaveBeenCalledOnce();
	const recorded = JSON.parse(await readFile(evidence, "utf8"));
	expect(recorded.reviewerThread).toMatchObject({
		model: "gpt-6-luna",
		ephemeral: true,
		approvalPolicy: "never",
		sandbox: "read-only",
		developerInstructions: CLOUD_ACTION_REVIEW_INSTRUCTIONS,
		dynamicTools: [CLOUD_ACTION_REVIEW_SPECIFICATION],
	});
	expect(recorded.reviewerThread.cwd).toBe(recorded.mainThread.cwd);
	expect(recorded.reviewerTurn).toMatchObject({ threadId: "thread_review", effort: "low" });
	expect(JSON.parse(recorded.reviewerTurn.input[0].text)).toMatchObject({
		request: "Email Bob.",
		action: { tool: "send_email", target: "bob@acme.test" },
	});
	// The verdict is acknowledged, the reviewer's turn is stopped, and its closing
	// request releases only that acknowledgement, never an agent tool result.
	expect(recorded.verdictReply.result).toEqual({
		contentItems: [{ type: "inputText", text: '{"recorded":true}' }],
		success: true,
	});
	expect(recorded.interrupt).toEqual({ threadId: "thread_review", turnId: "turn_review" });
	expect(recorded.closingFence.outputs).toEqual([
		{ kind: "function_call_output", callId: "verdict_1", output: '{"recorded":true}' },
	]);
	expect(recorded.prewarm).toMatchObject({ threadId: "thread_review", outputs: [] });
	// Only the agent's own requests are recorded as its context.
	expect(contextViews.every((threadId) => threadId === "thread_fixture")).toBe(true);
	expect(JSON.parse(recorded.reply.result.contentItems[0].text)).toMatchObject({ status: "ok" });
});

it("never runs an acting call when the reviewer ends without a verdict", async () => {
	const { result, execute, evidence } = reviewRun("review-no-verdict");
	await expect(result).resolves.toMatchObject({ providerSessionId: "thread_fixture" });
	expect(execute).not.toHaveBeenCalled();
	const recorded = JSON.parse(await readFile(evidence, "utf8"));
	const envelope = JSON.parse(recorded.reply.result.contentItems[0].text);
	expect(envelope).toMatchObject({ status: "denied" });
	expect(envelope.content.text).toMatch(/^REVIEW_UNAVAILABLE: /);
});
