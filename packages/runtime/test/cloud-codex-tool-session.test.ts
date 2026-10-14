import { createHash, createHmac, randomUUID } from "node:crypto";
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
import {
	CLOUD_CODEX_BOUNDARY_CONFIG,
	CodexLineReader,
	disposeCloudCodexSpares,
	prefetchCloudCodexArtifact,
	prepareCloudCodexSpare,
	runCloudCodexToolSession,
} from "@qorpera/runtime/cloud-codex-tool-session";
import { CloudNativeCaptureImages } from "@qorpera/runtime/cloud-native-capture-images";
import {
	CLOUD_NATIVE_CONTEXT_COMPOSITION_SCHEMA,
	type CloudNativeContextRequest,
} from "@qorpera/runtime/cloud-native-context-composition";
import { nativeRuntimeFailureMetadata } from "@qorpera/runtime/cloud-native-failure";
import * as nativeIsolation from "@qorpera/runtime/cloud-native-isolation";
import { nativeProviderUsageSignal } from "@qorpera/runtime/cloud-native-provider-host";
import {
	CLOUD_TOOL_RESULT_INSTRUCTIONS,
	type CloudNativeTool,
	CloudNativeToolBoundary,
} from "@qorpera/runtime/cloud-native-tool-boundary";
import { CloudRunLog } from "@qorpera/runtime/cloud-run-log";
import { CloudRuntimeObservability, type CloudRuntimeObservation } from "@qorpera/runtime/cloud-runtime-observability";
import { MemoryCompactChannel, MemoryCompactStop } from "@qorpera/runtime/memory-tree/compact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
		serviceTier?: "fast" | "standard";
		timeoutMs?: number;
		identityRoot?: string;
		runtimeInstructions?: string;
		signal?: AbortSignal;
		binarySha256?: string;
		isolation?: nativeIsolation.NativeIsolationConfiguration;
		chatGptPlanAuth?: "command" | "environment";
		beforeModelStart?: (signal: AbortSignal) => Promise<void>;
		observability?: CloudRuntimeObservability;
		tools?: CloudNativeTool[];
		recordContextView?: Parameters<typeof runCloudCodexToolSession>[0]["recordContextView"];
		composeContext?: Parameters<typeof runCloudCodexToolSession>[0]["composeContext"];
		runLog?: CloudRunLog;
		compactor?: MemoryCompactChannel;
		closing?: Parameters<typeof runCloudCodexToolSession>[0]["closing"];
	} = {},
) {
	const execute = vi.fn<CloudNativeTool["execute"]>(async () => new Promise(() => undefined));
	const signal = options.signal ?? new AbortController().signal;
	const boundary = new CloudNativeToolBoundary({
		companyId: randomUUID(),
		runId: options.runLog?.runId ?? randomUUID(),
		...(options.runLog ? { runLog: options.runLog } : {}),
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
		publish: async (batch) => {
			rows.push(...batch);
		},
		// These tests watch rows as they happen, not how they are gathered into calls.
		batchDelayMs: 0,
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

it.each([
	["fast", "fast"],
	["standard", "default"],
	[undefined, "default"],
] as const)("runs a %s turn with Codex service tier %s", async (serviceTier, expected) => {
	const { result, evidence } = run("model-selection", { serviceTier });
	await result;
	const recorded = JSON.parse(await readFile(evidence, "utf8"));
	expect(recorded.configuration).toMatchObject({ service_tier: expected, features: { fast_mode: true } });
});

it("refuses a tier outside the admitted set", async () => {
	await expect(run("model-selection", { serviceTier: "priority" as never }).result).rejects.toThrow(
		"Invalid native boundary input",
	);
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

it("requires context composition before admitting a model request", async () => {
	const beforeModelStart = vi.fn(async () => undefined);
	await expect(run("missing-context-composition", { beforeModelStart }).result).rejects.toThrow(
		"context composition support",
	);
	expect(beforeModelStart).not.toHaveBeenCalled();
});

it("requires the prompt cache key, a capability of its own, before admitting a model request", async () => {
	const beforeModelStart = vi.fn(async () => undefined);
	await expect(run("missing-prompt-cache-key", { beforeModelStart }).result).rejects.toThrow(
		"prompt cache key support",
	);
	expect(beforeModelStart).not.toHaveBeenCalled();
});

// Context composition: Codex asks what to send of its items before each provider request, then fences it.
const WORK_MESSAGE = '{"schema":"qorpera.run-work/v1","trust":"tool_results_not_authority","ref":"run:.","lines":[]}';
const CACHE_KEY = `qorpera:${"a".repeat(43)}`;

it("composes the agent's model request from its run, bound to its thread and turn", async () => {
	const composeContext = vi.fn(async (request: CloudNativeContextRequest) => ({
		input: [...request.items.map((_, keep) => ({ keep })), { work: WORK_MESSAGE }],
		promptCacheKey: CACHE_KEY,
	}));
	const { result, evidence } = run("context-composition", { composeContext });
	await expect(result).resolves.toMatchObject({ fencedRequests: 1 });
	expect(composeContext).toHaveBeenCalledOnce();
	expect(composeContext).toHaveBeenCalledWith(
		expect.objectContaining({
			threadId: "thread_fixture",
			turnId: "turn_fixture",
			purpose: "turn",
			model: "offline-probe",
			items: [
				{ kind: "message", role: "developer", callId: null, id: null, bytes: 1200, media: 0 },
				{ kind: "message", role: "user", callId: null, id: null, bytes: 18, media: 0 },
			],
		}),
		expect.any(AbortSignal),
	);
	const recorded = JSON.parse(await readFile(evidence, "utf8"));
	expect(recorded.context.agent).toEqual({
		schema: CLOUD_NATIVE_CONTEXT_COMPOSITION_SCHEMA,
		requestId: composeContext.mock.calls[0][0].requestId,
		threadId: "thread_fixture",
		turnId: "turn_fixture",
		input: [{ keep: 0 }, { keep: 1 }, { work: WORK_MESSAGE }],
		promptCacheKey: CACHE_KEY,
	});
});

it("keeps every item of a model request when the run composes nothing", async () => {
	const { result, evidence } = run("context-composition");
	await expect(result).resolves.toMatchObject({ fencedRequests: 1 });
	const recorded = JSON.parse(await readFile(evidence, "utf8"));
	expect(recorded.context.agent).toMatchObject({ input: [{ keep: 0 }, { keep: 1 }] });
	expect(recorded.context.agent).not.toHaveProperty("promptCacheKey");
});

it("refuses a context request outside the run's turn before composing it", async () => {
	const composeContext = vi.fn(async () => ({ input: [] }));
	await expect(run("context-wrong-turn", { composeContext }).result).rejects.toThrow(
		"Native result boundary unavailable",
	);
	expect(composeContext).not.toHaveBeenCalled();
});

it("ends the run when its composition is not one Codex can send", async () => {
	// A position past the request's items: refused here, before Codex sees it.
	const composeContext = vi.fn(async () => ({ input: [{ keep: 2 }] }));
	const { result, evidence } = run("context-composition", { composeContext });
	await expect(result).rejects.toThrow("Native result boundary unavailable");
	expect(composeContext).toHaveBeenCalledOnce();
	await expect(readFile(evidence, "utf8")).rejects.toThrow();
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

it("runs with a digest hashed ahead of the session", async () => {
	await prefetchCloudCodexArtifact(process.execPath);
	await expect(run("response-first").result).resolves.toMatchObject({ providerSessionId: "thread_fixture" });
});

it("hashes again when the artifact changed after its early hash", async () => {
	const artifact = join(root, "codex");
	await writeFile(artifact, "one", { mode: 0o755 });
	await prefetchCloudCodexArtifact(artifact);
	await writeFile(artifact, "changed");
	const pinned = createHash("sha256").update("one").digest("hex");
	const session = runCloudCodexToolSession({
		command: [artifact],
		binarySha256: pinned,
		boundary: new CloudNativeToolBoundary({
			companyId: randomUUID(),
			runId: randomUUID(),
			signal: new AbortController().signal,
			assertActive: async () => undefined,
			tools: [],
		}),
		model: "offline-probe",
		prompt: "Private test input",
		signal: new AbortController().signal,
	});
	await expect(session).rejects.toThrow("artifact mismatch");
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

it("reads a message near the wire limit that arrives over many pipe reads", async () => {
	await expect(run("large-line").result).resolves.toEqual({
		providerSessionId: "thread_fixture",
		toolCalls: 0,
		codexVersion: "0.155.1",
		fencedRequests: 1,
	});
});

describe("Codex stdout lines", () => {
	const limit = 12 * 1024 * 1024;
	const feed = (reader: CodexLineReader, bytes: Buffer, size: number, lines: string[]) => {
		for (let offset = 0; offset < bytes.length; offset += size)
			reader.push(bytes.subarray(offset, offset + size), limit, (line) => lines.push(line));
	};
	it("joins a 10.7 MiB line from 64 KiB reads, split inside multi-byte characters", () => {
		const large = JSON.stringify({ method: "capture", data: `${"\u20ac".repeat(200_000)}${"x".repeat(10_700_000)}` });
		expect(Buffer.byteLength(large)).toBeGreaterThan(10.7 * 1024 * 1024);
		const reader = new CodexLineReader();
		const lines: string[] = [];
		feed(reader, Buffer.from(`${large}\n{"next":1}\n\n{"partial"`), 64 * 1024, lines);
		expect(lines).toHaveLength(3);
		expect(lines[0] === large).toBe(true);
		expect(lines.slice(1)).toEqual(['{"next":1}', ""]);
		reader.push(Buffer.from(':true}\n{"a"'), limit, (line) => lines.push(line));
		expect(lines.at(-1)).toBe('{"partial":true}');
	});
	it("refuses a line over the limit, finished or not", () => {
		const lines: string[] = [];
		const reader = new CodexLineReader();
		reader.push(Buffer.from("x".repeat(10)), 10, (line) => lines.push(line));
		expect(() => reader.push(Buffer.from("x"), 10, (line) => lines.push(line))).toThrow("too large");
		const complete = new CodexLineReader();
		complete.push(Buffer.from(`${"x".repeat(10)}\n`), 10, (line) => lines.push(line));
		expect(() => complete.push(Buffer.from(`${"x".repeat(6)}\u20ac\n`), 8, (line) => lines.push(line))).toThrow(
			"too large",
		);
		expect(lines).toEqual(["x".repeat(10)]);
	});
});

it("rejects a different provider binary version before starting a thread", async () => {
	await expect(run("wrong-version").result).rejects.toThrow("Unsupported Codex boundary version");
});

it.each([
	"unsafe-config",
	"extra-mcp",
	"unsafe-code-mode",
	"nested-cloud-tools",
	"skill-route",
	"fast-mode-off",
	"tier-dropped",
])("rejects effective configuration drift before a model request: %s", async (mode) => {
	await expect(run(mode).result).rejects.toThrow("Native boundary configuration was not applied");
});

it("rejects provider skills outside the controlled result boundary", async () => {
	await expect(run("extra-skills").result).rejects.toThrow("Native boundary requires an empty provider skill catalog");
});

/** An identity root as a run host writes it for a ChatGPT plan login: the plan's access token alone. */
async function planRoot(token = "plan-access-1", mode = 0o600): Promise<string> {
	const identity = join(root, "plan-identity");
	await mkdir(join(identity, "codex"), { recursive: true, mode: 0o700 });
	await mkdir(join(identity, "chatgpt-plan"), { mode: 0o700 });
	await writeFile(join(identity, "chatgpt-plan", "access-token"), token, { mode });
	return identity;
}

describe("a run on a member's ChatGPT plan (Sign in with ChatGPT)", () => {
	it("calls OpenAI's API with the plan's token from the token command, at standard speed, with an empty Codex home", async () => {
		const identityRoot = await planRoot();
		const { result, evidence } = run("response-first", { identityRoot, serviceTier: "fast" });
		await expect(result).resolves.toMatchObject({ providerSessionId: "thread_fixture" });
		expect(JSON.parse(await readFile(`${evidence}.plan`, "utf8"))).toEqual({
			provider: "qorpera_chatgpt_plan",
			baseUrl: "https://api.openai.com/v1",
			serviceTier: "default",
			token: "plan-access-1",
			codexHomeEntries: [],
		});
	});

	it("gives the token in the environment instead in the fallback mode", async () => {
		const identityRoot = await planRoot("plan-access-env");
		const { result, evidence } = run("response-first", { identityRoot, chatGptPlanAuth: "environment" });
		await expect(result).resolves.toMatchObject({ providerSessionId: "thread_fixture" });
		expect(JSON.parse(await readFile(`${evidence}.plan`, "utf8"))).toMatchObject({
			provider: "qorpera_chatgpt_plan",
			token: "plan-access-env",
		});
	});

	it("refuses a root holding both kinds of login, or a token file others could read", async () => {
		const both = await planRoot();
		await writeFile(join(both, "codex", "auth.json"), "{}", { mode: 0o600 });
		await expect(run("response-first", { identityRoot: both }).result).rejects.toThrow(
			"Native boundary requires one login per identity",
		);
		await rm(both, { recursive: true, force: true });
		const open = await planRoot("plan-access-1", 0o644);
		await expect(run("response-first", { identityRoot: open }).result).rejects.toThrow(
			"Invalid ChatGPT plan identity",
		);
	});

	it("refuses a plan run whose provider Codex did not apply, and a Codex login's run on the plan provider", async () => {
		const identityRoot = await planRoot();
		await expect(run("plan-provider-dropped", { identityRoot }).result).rejects.toThrow(
			"configuration was not applied",
		);
		await expect(run("plan-provider-on-codex").result).rejects.toThrow("configuration was not applied");
		// A Codex login's run keeps any other provider its command sets (the real-Codex probes use one).
		await expect(run("test-provider").result).resolves.toMatchObject({ providerSessionId: "thread_fixture" });
	});

	it("starts no warm spare for a plan run in the environment fallback, whose process keeps its first token", async () => {
		const identityRoot = await planRoot();
		const evidence = join(root, "spare-evidence.json");
		const command = [process.execPath, rpcFixture, "response-first", evidence] as const;
		prepareCloudCodexSpare({ command, binarySha256, identityRoot, chatGptPlanAuth: "environment" }, 60_000);
		prepareCloudCodexSpare({ command, binarySha256, identityRoot }, 60_000);
		// Only the command mode's spare starts: exactly one spare uses this root.
		await vi.waitFor(async () => expect(await readFile(`${evidence}.handshakes`, "utf8")).toMatch(/^\d+\n$/), {
			timeout: 10_000,
		});
		expect(await disposeCloudCodexSpares(identityRoot)).toBe(1);
	});

	it("takes a plan run's 429 for the plan's usage limit, which stops the work", async () => {
		const identityRoot = await planRoot();
		const error = await run("terminal-rate-error", { identityRoot }).result.catch((failure: unknown) => failure);
		expect(nativeProviderUsageSignal(error)).toBe("usage_limit");
		// A Codex login's 429 stays a rate limit.
		const codex = await run("terminal-rate-error").result.catch((failure: unknown) => failure);
		expect(nativeProviderUsageSignal(codex)).toBe("rate_limited");
	});
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

it("records each provider response's usage once, without repeats, estimates or a filled context window", async () => {
	const { rows, observability } = observationCollector();
	await expect(run("per-request-usage", { observability }).result).resolves.toMatchObject({ fencedRequests: 1 });
	await observability.close();
	const turn = rows.find((row) => row.operation === "model_turn" && row.phase === "finish");
	expect(turn).toMatchObject({ status: "succeeded", inputTokens: 70, cachedInputTokens: 60, totalTokens: 8265 });
	const requests = rows.filter((row) => row.operation === "model_request");
	expect(requests.filter((row) => row.phase === "start")).toHaveLength(3);
	expect(requests.every((row) => row.parentAttemptId === turn?.attemptId)).toBe(true);
	expect(
		requests
			.filter((row) => row.phase === "finish")
			.map((row) => [
				row.status,
				row.inputTokens,
				row.outputTokens,
				row.cachedInputTokens,
				row.cacheWriteInputTokens,
				row.reasoningOutputTokens,
				row.totalTokens,
			]),
	).toEqual([
		["succeeded", 40, 5, 0, 0, 1, 45],
		["succeeded", 60, 4, 38, 0, 0, 64],
		["succeeded", 70, 3, 60, 0, 0, 73],
	]);
});

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

it("keeps the agent's own words, never its reasoning, with the next step of its work log", async () => {
	const runId = randomUUID();
	const files = new Map<string, string>();
	const log = new CloudRunLog({
		runId,
		conversationId: randomUUID(),
		signal: new AbortController().signal,
		protection: {
			narrow: async () => ({ log: false, narrow: false }),
			hashes: async (run, digests) =>
				digests.map((digest) =>
					createHmac("sha256", "codex-session-test-platform-key").update(`${run}:${digest}`).digest("hex"),
				),
		},
		folder: {
			locate: async () => ({ path: `runs/${runId}`, exists: true, missing: [], last: null, generation: 0 }),
			read: async (path) => (files.has(path) ? { version: path, text: files.get(path)! } : null),
			commit: async (_key, units) => ({
				commitId: randomUUID(),
				seq: 1,
				replay: false,
				units: units.map((unit, index) => {
					if (unit.op !== "write" || !("text" in unit.content)) throw new Error("Unexpected unit");
					files.set(unit.path, unit.content.text);
					return {
						unit: index,
						op: unit.op,
						path: unit.path,
						to: null,
						version: unit.path,
						outcome: "saved" as const,
						reason: null,
						problems: [],
					};
				}),
			}),
		},
	});
	const execute = vi.fn<CloudNativeTool["execute"]>(async () => ({ kind: "text", value: "Delivered" }));
	const { result, evidence } = run("composition-replayed", {
		runLog: log,
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
	await vi.waitFor(async () => expect(JSON.parse(await readFile(evidence, "utf8"))).toEqual({ stage: "composing" }));
	await writeFile(`${evidence}.continue`, "continue");
	await result;
	await log.close(new AbortController().signal);
	expect(execute).toHaveBeenCalledOnce();
	expect(log.steps()).toEqual([
		expect.objectContaining({ tool: "send_message", args: "", hashOnly: true, text: "PRIVATE_OUTPUT_CANARY" }),
	]);
	const stored = [...files.values()].join("");
	expect(stored).toContain("PRIVATE_OUTPUT_CANARY");
	expect(stored).not.toMatch(/PRIVATE_REASONING_CANARY|PUBLIC_REPLY_CANARY/);
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

// Auto-review (v130): the reviewer is a second, fresh thread in the same app-server,
// started while the agent's tool call is open. Its only output is its verdict tool
// call; its model requests pass the fence on their own lane, never as the agent's.
function reviewRun(
	mode: "review" | "review-no-verdict" | "review-wrong-tool" | "review-context" | "review-compact",
	composeContext?: Parameters<typeof runCloudCodexToolSession>[0]["composeContext"],
	compactor?: MemoryCompactChannel,
) {
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
		...(composeContext ? { composeContext } : {}),
		...(compactor ? { compactor } : {}),
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

it("composes only the agent's requests from its run, never a reviewer's", async () => {
	const composeContext = vi.fn(async (request: CloudNativeContextRequest) => ({
		input: [...request.items.map((_, keep) => ({ keep })), { work: WORK_MESSAGE }],
	}));
	const { result, execute, evidence } = reviewRun("review-context", composeContext);
	await expect(result).resolves.toMatchObject({ providerSessionId: "thread_fixture", toolCalls: 1 });
	expect(execute).toHaveBeenCalledOnce();
	expect(composeContext).toHaveBeenCalledOnce();
	expect(composeContext.mock.calls[0][0]).toMatchObject({ threadId: "thread_fixture", turnId: "turn_fixture" });
	const recorded = JSON.parse(await readFile(evidence, "utf8"));
	expect(recorded.context.agent).toMatchObject({
		threadId: "thread_fixture",
		input: [{ keep: 0 }, { keep: 1 }, { work: WORK_MESSAGE }],
	});
	expect(recorded.context.reviewer).toMatchObject({
		threadId: "thread_review",
		turnId: "turn_review",
		input: [{ keep: 0 }, { keep: 1 }],
	});
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

it("refuses the reviewer any tool but its verdict, and never runs the call without one", async () => {
	const { result, execute, evidence } = reviewRun("review-wrong-tool");
	await expect(result).resolves.toMatchObject({ providerSessionId: "thread_fixture" });
	expect(execute).not.toHaveBeenCalled();
	const recorded = JSON.parse(await readFile(evidence, "utf8"));
	expect(recorded.wrongTool.error).toMatchObject({ code: -32601 });
	expect(JSON.parse(recorded.reply.result.contentItems[0].text).content.text).toMatch(/^REVIEW_UNAVAILABLE: /);
});

// Memory compactor (RUNTIME-AGENT-MEMORY-TREE.md §7.1): fresh tool-less threads in the run's own app-server, their
// requests on a fence lane of their own. Closing opens them after the agent's verified turn, before the process ends.
it("compacts at closing in a fresh tool-less thread, never as the agent's context", async () => {
	const compactor = new MemoryCompactChannel();
	const replies: unknown[] = [];
	const composeContext = vi.fn(async (request: CloudNativeContextRequest) => ({
		input: request.items.map((_, keep) => ({ keep })),
	}));
	const contextViews: string[] = [];
	const { result, evidence } = run("compact", {
		compactor,
		composeContext,
		recordContextView: async (frame) => {
			contextViews.push(frame.threadId);
		},
		closing: async (signal) => {
			const thread = await compactor.call("PRIVATE_COMPACT_SYSTEM", signal);
			replies.push(await thread.send("PRIVATE_WINDOW_1", signal));
			replies.push(await thread.send("PRIVATE_WINDOW_2", signal));
			thread.close?.();
		},
	});
	// The compactor's requests are not the agent's: only the agent's one request is counted.
	await expect(result).resolves.toMatchObject({ providerSessionId: "thread_fixture", fencedRequests: 1 });
	// Each reply used what its thread's cumulative usage grew by since the reply before it.
	expect(replies).toEqual([
		{ text: "LINE 1", usage: { input: 500, cached: 100, output: 40 } },
		{ text: "LINE 2", usage: { input: 700, cached: 500, output: 30 } },
	]);
	const recorded = JSON.parse(await readFile(evidence, "utf8"));
	expect(recorded.compactThreads).toEqual([
		expect.objectContaining({
			model: "gpt-6-luna",
			ephemeral: true,
			approvalPolicy: "never",
			sandbox: "read-only",
			developerInstructions: "PRIVATE_COMPACT_SYSTEM",
			dynamicTools: [],
		}),
	]);
	expect(recorded.compactThreads[0].cwd).toBe(recorded.mainThread.cwd);
	const sent = (text: string) => ({
		threadId: "thread_compact",
		input: [{ type: "text", text, text_elements: [] }],
		effort: "low",
		environments: [],
		runtimeWorkspaceRoots: [],
		sandboxPolicy: { type: "readOnly", networkAccess: false },
	});
	expect(recorded.compactTurns).toEqual([sent("PRIVATE_WINDOW_1"), sent("PRIVATE_WINDOW_2")]);
	expect(recorded.prewarms).toEqual([expect.objectContaining({ threadId: "thread_compact", outputs: [] })]);
	expect(recorded.fenced).toEqual([
		expect.objectContaining({ threadId: "thread_compact", turnId: "turn_compact_1", outputs: [] }),
		expect.objectContaining({ threadId: "thread_compact", turnId: "turn_compact_2", outputs: [] }),
	]);
	// Never composed from the agent's run, never recorded as the agent's context.
	expect(composeContext).not.toHaveBeenCalled();
	expect(recorded.composed).toMatchObject({ threadId: "thread_compact", input: [{ keep: 0 }, { keep: 1 }] });
	expect(contextViews).toContain("thread_fixture");
	expect(contextViews).not.toContain("thread_compact");
	expect(recorded.interrupt).toBeNull();
});

it("refuses the compactor any tool and answers its outputs as unavailable", async () => {
	const compactor = new MemoryCompactChannel();
	let failure: unknown;
	const { result, evidence } = run("compact-tool", {
		compactor,
		closing: async (signal) => {
			const thread = await compactor.call("PRIVATE_COMPACT_SYSTEM", signal);
			failure = await thread.send("PRIVATE_WINDOW_1", signal).catch((error: unknown) => error);
		},
	});
	await expect(result).resolves.toMatchObject({ providerSessionId: "thread_fixture" });
	// The pinned Codex takes the unavailable answer for no cloud tool result and fails the turn: no line is built.
	expect((failure as Error).message).toBe("Native compaction did not complete");
	const recorded = JSON.parse(await readFile(evidence, "utf8"));
	expect(recorded.refused.error).toMatchObject({ code: -32601 });
	expect(recorded.fenced[1].outputs).toEqual([
		{ kind: "function_call_output", callId: "compact_call", output: '{"available":false}' },
	]);
});

it.each([
	["compact-usage-limit", "usage-limit", undefined],
	["compact-rate-limit", "rate-limit", undefined],
	["compact-outage", "outage", undefined],
	["compact-failed", "Native compaction did not complete", { input: 300, cached: 50, output: 20 }],
	["compact-large", "Native compaction reply too large", undefined],
])("ends the compactor's thread on %s, and the agent's turn stands", async (mode, expected, used) => {
	const compactor = new MemoryCompactChannel();
	let failure: unknown;
	let after: unknown;
	let unreported: unknown;
	const { result } = run(mode, {
		compactor,
		closing: async (signal) => {
			const thread = await compactor.call("PRIVATE_COMPACT_SYSTEM", signal);
			failure = await thread.send("PRIVATE_WINDOW_1", signal).catch((error: unknown) => error);
			after = await thread.send("PRIVATE_WINDOW_2", signal).catch((error: unknown) => error);
			unreported = thread.unreported?.();
		},
	});
	await expect(result).resolves.toMatchObject({ providerSessionId: "thread_fixture" });
	// A usage limit, rate limit or outage stops the run's compactor (§7.2); any other failure only its request.
	expect(failure instanceof MemoryCompactStop ? failure.reason : (failure as Error).message).toBe(expected);
	expect((after as Error).message).toBe("Native compaction ended");
	// What a failed request used is still counted, once.
	expect(unreported).toEqual(used);
});

it.each([
	["compact-open-usage-limit", "usage-limit"],
	["compact-open-done", "outage"],
])("stops a compactor send still open when the run ends: %s", async (mode, reason) => {
	const compactor = new MemoryCompactChannel();
	const { result } = run(mode, { compactor });
	const signal = new AbortController().signal;
	// Attached once the agent's thread is bound; until then a call stops as an outage does.
	const thread = await vi.waitFor(() => compactor.call("PRIVATE_COMPACT_SYSTEM", signal), { timeout: 10_000 });
	const failure = await thread.send("PRIVATE_WINDOW_1", signal).catch((error: unknown) => error);
	// The run's failure stops it with the provider's signal; a process that closes with none stops it as an outage.
	expect(failure).toBeInstanceOf(MemoryCompactStop);
	expect((failure as MemoryCompactStop).reason).toBe(reason);
	const ended = await result.catch((error: unknown) => error);
	if (mode === "compact-open-done") expect(ended).toMatchObject({ providerSessionId: "thread_fixture" });
	else expect(nativeProviderUsageSignal(ended)).toBe("usage_limit");
});

it("keeps a reviewer's late prewarm off a compactor thread starting during the agent's turn", async () => {
	const compactor = new MemoryCompactChannel();
	const { result, execute, evidence } = reviewRun("review-compact", undefined, compactor);
	// The compactor thread starts once the reviewer's has; the fixture sends the reviewer's prewarm only then.
	await vi.waitFor(() => stat(`${evidence}.review-started`), { timeout: 10_000 });
	const signal = new AbortController().signal;
	const thread = await compactor.call("PRIVATE_COMPACT_SYSTEM", signal);
	await expect(thread.send("PRIVATE_WINDOW_1", signal)).resolves.toEqual({ text: "LINE 1" });
	thread.close?.();
	await expect(result).resolves.toMatchObject({ providerSessionId: "thread_fixture", toolCalls: 1 });
	expect(execute).toHaveBeenCalledOnce();
	const recorded = JSON.parse(await readFile(evidence, "utf8"));
	expect(recorded.prewarm).toMatchObject({ threadId: "thread_review", outputs: [] });
	expect(recorded.compact.prewarms).toEqual([expect.objectContaining({ threadId: "thread_compact", outputs: [] })]);
	expect(recorded.compact.compactTurns).toHaveLength(1);
});

it("interrupts a compactor turn its caller stopped waiting for", async () => {
	const compactor = new MemoryCompactChannel();
	const evidence = join(root, "evidence.json");
	let failure: unknown;
	const { result } = run("compact-stalled", {
		compactor,
		closing: async (signal) => {
			const thread = await compactor.call("PRIVATE_COMPACT_SYSTEM", signal);
			const stop = new AbortController();
			const sending = thread.send("PRIVATE_WINDOW_1", stop.signal).catch((error: unknown) => error);
			await vi.waitFor(async () => expect(JSON.parse(await readFile(evidence, "utf8")).fenced).toHaveLength(1));
			stop.abort();
			failure = await sending;
			await vi.waitFor(async () => expect(JSON.parse(await readFile(evidence, "utf8")).interrupt).not.toBeNull());
		},
	});
	await expect(result).resolves.toMatchObject({ providerSessionId: "thread_fixture" });
	expect((failure as Error).message).toBe("Native compaction cancelled");
	expect(JSON.parse(await readFile(evidence, "utf8")).interrupt).toEqual({
		threadId: "thread_compact",
		turnId: "turn_compact_1",
	});
});

it("keeps the agent's turn when closing fails, and stops the compactor once the run is over", async () => {
	const compactor = new MemoryCompactChannel();
	const { result } = run("compact", {
		compactor,
		closing: async () => {
			throw new Error("PRIVATE_CLOSING_FAILURE");
		},
	});
	await expect(result).resolves.toMatchObject({ providerSessionId: "thread_fixture", toolCalls: 0 });
	// With no process to answer, a call stops the lane as an outage does; the next run builds what is missing.
	await expect(compactor.call("PRIVATE_COMPACT_SYSTEM", new AbortController().signal)).rejects.toMatchObject({
		reason: "outage",
	});
});

async function starts(evidence: string): Promise<number> {
	try {
		return (await readFile(`${evidence}.starts`, "utf8")).split("\n").filter(Boolean).length;
	} catch {
		return 0;
	}
}

/** A spare is taken only once ready: its last handshake answer was sent and handled. */
async function spareReady(evidence: string, count = 1): Promise<void> {
	await until(async () => {
		try {
			return (await readFile(`${evidence}.handshakes`, "utf8")).split("\n").filter(Boolean).length >= count;
		} catch {
			return false;
		}
	});
	await new Promise((resolve) => setTimeout(resolve, 200));
}

async function until(check: () => Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt++) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Condition not reached");
}

describe("warm conversations: spare Codex processes", () => {
	afterEach(async () => {
		await disposeCloudCodexSpares();
	});

	it("gives the next run with identical inputs a started process, once", async () => {
		const evidence = join(root, "evidence.json");
		const command = [process.execPath, rpcFixture, "response-first", evidence] as const;
		prepareCloudCodexSpare({ command, binarySha256 }, 60_000);
		await spareReady(evidence);
		await expect(run("response-first").result).resolves.toMatchObject({ providerSessionId: "thread_fixture" });
		expect(await starts(evidence)).toBe(1);
		// The spare was taken: the following run starts a process of its own.
		await expect(run("response-first").result).resolves.toMatchObject({ providerSessionId: "thread_fixture" });
		expect(await starts(evidence)).toBe(2);
	});

	it("never gives a spare to a run with other process inputs", async () => {
		const evidence = join(root, "evidence.json");
		const command = [process.execPath, rpcFixture, "response-first", evidence] as const;
		prepareCloudCodexSpare({ command, binarySha256, reasoningEffort: "medium" }, 60_000);
		await until(async () => (await starts(evidence)) === 1);
		await expect(run("response-first", { reasoningEffort: "low" }).result).resolves.toMatchObject({
			providerSessionId: "thread_fixture",
		});
		expect(await starts(evidence)).toBe(2);
	});

	it("gives a spare only to a run on the same service tier", async () => {
		const evidence = join(root, "evidence.json");
		const command = [process.execPath, rpcFixture, "response-first", evidence] as const;
		prepareCloudCodexSpare({ command, binarySha256, serviceTier: "fast" }, 60_000);
		await until(async () => (await starts(evidence)) === 1);
		// A standard run does not take the Fast spare: it starts its own process.
		await expect(run("response-first", { serviceTier: "standard" }).result).resolves.toMatchObject({
			providerSessionId: "thread_fixture",
		});
		expect(await starts(evidence)).toBe(2);
		prepareCloudCodexSpare({ command, binarySha256, serviceTier: "fast" }, 60_000);
		// Wait for the spare's handshake, not just its process: a spare still starting is never handed over.
		await spareReady(evidence, 3);
		// A Fast run takes it.
		await expect(run("response-first", { serviceTier: "fast" }).result).resolves.toMatchObject({
			providerSessionId: "thread_fixture",
		});
		expect(await starts(evidence)).toBe(3);
		expect(() => prepareCloudCodexSpare({ command, binarySha256, serviceTier: "priority" as never }, 60_000)).toThrow(
			"Invalid spare service tier",
		);
	});

	it("stops a spare nobody takes within its window, and one whose root is released", async () => {
		const evidence = join(root, "evidence.json");
		const command = [process.execPath, rpcFixture, "response-first", evidence] as const;
		prepareCloudCodexSpare({ command, binarySha256 }, 50);
		await until(async () => (await starts(evidence)) === 1);
		// The window counts from the end of the handshake, which follows the first line here.
		await new Promise((resolve) => setTimeout(resolve, 500));
		await expect(run("response-first").result).resolves.toMatchObject({ providerSessionId: "thread_fixture" });
		expect(await starts(evidence)).toBe(2);
		prepareCloudCodexSpare({ command, binarySha256 }, 60_000);
		await until(async () => (await starts(evidence)) === 3);
		await disposeCloudCodexSpares();
		await expect(run("response-first").result).resolves.toMatchObject({ providerSessionId: "thread_fixture" });
		expect(await starts(evidence)).toBe(4);
	});

	it.each(["fence-before-bind", "tool-before-bind"])(
		"never uses a spare that was asked for work before a run was bound (%s)",
		async (mode) => {
			const evidence = join(root, "evidence.json");
			const command = [process.execPath, rpcFixture, mode, evidence] as const;
			prepareCloudCodexSpare({ command, binarySha256 }, 60_000);
			await until(async () => (await starts(evidence)) === 1);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const spare = Number((await readFile(`${evidence}.starts`, "utf8")).split("\n")[0]);
			// The spare failed closed and is not taken: the run starts its own process.
			await run(mode).result.catch(() => undefined);
			expect(await starts(evidence)).toBe(2);
			expect(() => process.kill(spare, 0)).toThrow();
		},
	);

	it("keeps a kept Codex home auth-only for a fresh start when the spare does not fit", async () => {
		const identityRoot = join(root, "identity");
		await mkdir(join(identityRoot, "codex"), { recursive: true, mode: 0o700 });
		await writeFile(join(identityRoot, "codex", "auth.json"), "{}", { mode: 0o600 });
		const evidence = join(root, "evidence.json");
		const command = [process.execPath, rpcFixture, "writes-home", evidence] as const;
		prepareCloudCodexSpare({ command, binarySha256, reasoningEffort: "medium", identityRoot }, 60_000);
		await until(async () => (await starts(evidence)) === 1);
		await until(
			async () => (await stat(join(identityRoot, "codex", "state_5.sqlite")).catch(() => undefined)) !== undefined,
		);
		const spare = Number((await readFile(`${evidence}.starts`, "utf8")).split("\n")[0]);
		await expect(run("writes-home", { identityRoot, reasoningEffort: "low" }).result).resolves.toMatchObject({
			providerSessionId: "thread_fixture",
		});
		expect(await starts(evidence)).toBe(2);
		expect(() => process.kill(spare, 0)).toThrow();
	});

	it("never waits for a spare that is still starting", async () => {
		const evidence = join(root, "evidence.json");
		const command = [process.execPath, rpcFixture, "stall-first", evidence] as const;
		prepareCloudCodexSpare({ command, binarySha256 }, 60_000);
		await until(async () => (await starts(evidence)) === 1);
		await expect(run("stall-first").result).resolves.toMatchObject({ providerSessionId: "thread_fixture" });
		expect(await starts(evidence)).toBe(2);
	});

	it("binds the run before any thread: the spare's handshake saw no run", async () => {
		const evidence = join(root, "evidence.json");
		const command = [process.execPath, rpcFixture, "bootstrap", evidence] as const;
		prepareCloudCodexSpare({ command, binarySha256 }, 60_000);
		await spareReady(evidence);
		await expect(run("bootstrap", { runtimeInstructions: "Spare-run law" }).result).resolves.toMatchObject({
			providerSessionId: "thread_fixture",
		});
		expect(await starts(evidence)).toBe(1);
		const bootstrap = JSON.parse(await readFile(evidence, "utf8")) as { bootstrap: string };
		expect(bootstrap.bootstrap).toContain("Spare-run law");
	});
});
