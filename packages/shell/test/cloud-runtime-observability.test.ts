import { randomUUID } from "node:crypto";
import { type CloudNativeTool, CloudNativeToolBoundary } from "@qorpera/runtime/cloud-native-tool-boundary";
import {
	assertCloudRuntimeObservationReceipt,
	CLOUD_RUNTIME_OBSERVATION_SCHEMA,
	CLOUD_RUNTIME_OPERATIONS,
	CLOUD_RUNTIME_TOOL_OPERATIONS,
	CloudRuntimeDiagnosticError,
	CloudRuntimeObservability,
	type CloudRuntimeObservation,
	cloudRuntimeErrorCategory,
	cloudRuntimeOperationHash,
	cloudRuntimeToolOperation,
	parseCloudRuntimeObservation,
} from "@qorpera/runtime/cloud-runtime-observability";
import { describe, expect, it, vi } from "vitest";

function syntheticTool(
	name: string,
	source: CloudNativeTool["source"],
	execute: CloudNativeTool["execute"] = async () => ({ kind: "text" as const, value: "safe" }),
): CloudNativeTool {
	return {
		name,
		source,
		description: `Synthetic ${name}`,
		inputSchema: { type: "object", additionalProperties: false },
		parseArguments: () => ({}),
		execute,
	};
}

function observer(publish?: (row: CloudRuntimeObservation, signal: AbortSignal) => Promise<unknown>) {
	const rows: CloudRuntimeObservation[] = [];
	const metrics = new CloudRuntimeObservability({
		assignmentId: randomUUID(),
		publish:
			publish ??
			(async (row) => {
				rows.push(row);
			}),
	});
	return { metrics, rows };
}

function sample(): CloudRuntimeObservation {
	return {
		schema: CLOUD_RUNTIME_OBSERVATION_SCHEMA,
		attemptId: randomUUID(),
		parentAttemptId: null,
		assignmentId: randomUUID(),
		phase: "start",
		operation: "company_read",
		logicalOperationSha256: null,
		observedAt: "2026-08-31T12:34:56.000Z",
		durationMs: null,
		status: "started",
		errorCategory: null,
		receiptId: null,
		readId: null,
		inputBytes: null,
		outputBytes: null,
		inputTokens: null,
		outputTokens: null,
		cachedInputTokens: null,
		cacheWriteInputTokens: null,
		reasoningOutputTokens: null,
		totalTokens: null,
	};
}

describe("closed runtime diagnostics", () => {
	it("retains unknown measurements as null and clones the closed record", () => {
		const row = sample();
		const parsed = parseCloudRuntimeObservation(row);
		expect(parsed).toEqual(row);
		expect(parsed).not.toBe(row);
		expect(parsed.outputBytes).toBeNull();
		expect(parsed.inputTokens).toBeNull();
	});

	it.each(["message", "error", "path", "arguments", "prompt", "headers", "cookie", "secret", "token", "body"])(
		"rejects an undeclared %s field",
		(key) => {
			expect(() => parseCloudRuntimeObservation({ ...sample(), [key]: "PRIVATE_CANARY" })).toThrow(
				"Invalid runtime observation",
			);
		},
	);

	it.each([
		{ attemptId: "not-a-uuid" },
		{ receiptId: "private receipt" },
		{ assignmentId: "private assignment" },
		{ operation: "print_secret" },
		{ logicalOperationSha256: "private-key" },
		{ inputTokens: -1 },
		{ outputTokens: Number.MAX_SAFE_INTEGER + 1 },
		{ inputBytes: 1.5 },
		{ cachedInputTokens: "10" },
		{ totalTokens: Infinity },
		{ outputBytes: NaN },
		{ observedAt: "infinity" },
		{ observedAt: "0000-01-01T00:00:00.000Z" },
		{ observedAt: "2026-02-30T12:00:00.000Z" },
		{ observedAt: "2026-08-31T12:00:00+02:00" },
		{ phase: "finish", status: "started" },
		{ status: "succeeded" },
		{ durationMs: 0 },
		{ errorCategory: "a token from an upstream error" },
	])("rejects malformed metadata %#", (patch) => {
		expect(() => parseCloudRuntimeObservation({ ...sample(), ...patch })).toThrow("Invalid runtime observation");
	});

	it("does not accept a missing nullable field", () => {
		const { outputBytes: _, ...row } = sample();
		expect(() => parseCloudRuntimeObservation(row)).toThrow();
	});

	it("requires the exact closed ingestion receipt and accepts PostgreSQL timestamp precision", () => {
		const row = sample();
		const runId = randomUUID();
		const receipt = {
			schema: "qorpera.runtime-observation-receipt/v1",
			runId,
			attemptId: row.attemptId,
			phase: row.phase,
			ingestedAt: "2026-08-31T12:34:56.123456+00:00",
			replayed: false,
		};
		for (const ingestedAt of [receipt.ingestedAt, "2026-08-31T14:34:56+02:00", row.observedAt])
			expect(() => assertCloudRuntimeObservationReceipt({ ...receipt, ingestedAt }, runId, row)).not.toThrow();
		for (const value of [
			null,
			[],
			{},
			{ ...receipt, secret: "PRIVATE_RECEIPT" },
			{ ...receipt, schema: "other" },
			{ ...receipt, runId: randomUUID() },
			{ ...receipt, attemptId: randomUUID() },
			{ ...receipt, phase: "finish" },
			{ ...receipt, replayed: "false" },
			{ ...receipt, ingestedAt: undefined },
			{ ...receipt, ingestedAt: "PRIVATE_RECEIPT" },
			{ ...receipt, ingestedAt: "0000-01-01T00:00:00Z" },
			{ ...receipt, ingestedAt: "2026-02-30T00:00:00Z" },
			{ ...receipt, ingestedAt: "2026-08-31T24:00:00Z" },
			{ ...receipt, ingestedAt: "2026-08-31T14:34:56+25:00" },
		])
			expect(() => assertCloudRuntimeObservationReceipt(value, runId, row)).toThrow(
				"Runtime observation acknowledgement unavailable",
			);
	});

	it("pins child spans to their parent and returns an immutable copy of replay metadata", async () => {
		const { metrics, rows } = observer();
		const parent = metrics.start("connector");
		const receiptId = randomUUID();
		parent.finish("succeeded", { receiptId });
		const copy = parent.result!;
		copy.status = "failed";
		copy.receiptId = null;
		parent.child("context_authority").finish("denied", { errorCategory: "authority_unavailable" });
		await metrics.close();
		expect(parent.result).toMatchObject({ status: "succeeded", receiptId });
		expect(
			rows
				.filter((row) => row.operation === "context_authority")
				.every((row) => row.parentAttemptId === parent.attemptId),
		).toBe(true);
	});

	it("separates attempt identity, logical retries and canonical receipt identity", async () => {
		const { metrics, rows } = observer();
		const runId = randomUUID();
		const key = cloudRuntimeOperationHash(runId, "company_write", "member-selected-key");
		const receiptId = randomUUID();
		metrics.start("company_write", { logicalOperationSha256: key }).finish("succeeded", { receiptId, inputBytes: 8 });
		metrics.start("company_write", { logicalOperationSha256: key }).finish("replayed", { receiptId });
		await metrics.close();
		expect(rows).toHaveLength(4);
		expect(rows[0].attemptId).not.toBe(rows[2].attemptId);
		expect(rows[0].logicalOperationSha256).toBe(rows[2].logicalOperationSha256);
		expect(rows[1].receiptId).toBe(rows[3].receiptId);
		expect(JSON.stringify(rows)).not.toContain("member-selected-key");
	});

	it("uses monotonic duration and retains wall-clock movement instead of inventing zero latency", async () => {
		const rows: CloudRuntimeObservation[] = [];
		let wall = Date.parse("2026-08-31T12:34:56.000Z");
		let monotonic = 10;
		const metrics = new CloudRuntimeObservability({
			assignmentId: null,
			clock: () => wall,
			monotonicClock: () => monotonic,
			publish: async (row) => {
				rows.push(row);
			},
		});
		const span = metrics.start("model_turn");
		wall -= 2000;
		monotonic += 125;
		span.finish("cancelled", { errorCategory: "cancelled" });
		span.finish("succeeded");
		await metrics.close();
		expect(rows).toHaveLength(2);
		expect(rows[1].durationMs).toBe(125);
		expect(rows[1].observedAt < rows[0].observedAt).toBe(true);
		expect(rows[1].status).toBe("cancelled");
	});

	it("keeps a start with no observed completion incomplete", async () => {
		const { metrics, rows } = observer();
		metrics.start("model_turn");
		await metrics.close();
		expect(rows.map((row) => row.phase)).toEqual(["start"]);
		expect(rows[0].durationMs).toBeNull();
	});

	it("does not derive categories from arbitrary error messages", () => {
		expect(cloudRuntimeErrorCategory(new Error("PRIVATE secret; permission denied; quota exceeded"))).toBe("unknown");
		expect(cloudRuntimeErrorCategory(new CloudRuntimeDiagnosticError("stale_version"))).toBe("stale_version");
		const aborted = new AbortController();
		aborted.abort(new Error("PRIVATE_REASON"));
		expect(cloudRuntimeErrorCategory(new Error("PRIVATE"), aborted.signal)).toBe("cancelled");
	});

	it("does not spread extra metadata onto a span", async () => {
		const { metrics, rows } = observer();
		const span = metrics.start("company_read");
		span.update({ outputBytes: 4, path: "PRIVATE_PATH" } as unknown as Parameters<typeof span.update>[0]);
		span.finish("succeeded");
		await metrics.close();
		expect(rows[1].outputBytes).toBeNull();
		expect(JSON.stringify(rows)).not.toContain("PRIVATE_PATH");
	});
});

describe("optional exporter isolation", () => {
	it("absorbs a synchronous exporter failure without retrying or echoing it", async () => {
		const publish = vi.fn(() => {
			throw new Error("PRIVATE_CREDENTIAL");
		});
		const { metrics } = observer(publish);
		metrics.start("company_write").finish("succeeded");
		await metrics.close();
		expect(publish).toHaveBeenCalledTimes(1);
		expect(metrics.state.status).toBe("unavailable");
		expect(metrics.state.dropped).toBe(2);
		expect(JSON.stringify(metrics.state)).not.toContain("PRIVATE_CREDENTIAL");
	});

	it("bounds a stalled exporter, its queue and all later work", async () => {
		const publish = vi.fn(async () => new Promise(() => undefined));
		const metrics = new CloudRuntimeObservability({ assignmentId: randomUUID(), publish, timeoutMs: 20 });
		for (let index = 0; index < 600; index++) metrics.start("company_read").finish("succeeded");
		expect(metrics.state.pending).toBeLessThanOrEqual(257);
		expect(metrics.state.dropped).toBeGreaterThan(0);
		const begin = Date.now();
		await metrics.close();
		expect(Date.now() - begin).toBeLessThan(1000);
		expect(publish).toHaveBeenCalledTimes(1);
		expect(metrics.state.status).toBe("unavailable");
		metrics.start("company_write").finish("failed");
		expect(publish).toHaveBeenCalledTimes(1);
	});

	it("cannot alter a tool effect or turn it into a retry when diagnostic delivery fails", async () => {
		const { metrics } = observer(async () => {
			throw new Error("export unavailable");
		});
		const effect = vi.fn(async () => ({ kind: "text" as const, value: "safe" }));
		const boundary = new CloudNativeToolBoundary({
			companyId: randomUUID(),
			runId: randomUUID(),
			tools: [
				{
					name: "effect",
					description: "Synthetic effect",
					source: "connector",
					inputSchema: { type: "object", additionalProperties: false },
					parseArguments: () => ({}),
					execute: effect,
				},
			],
			assertActive: async () => undefined,
			signal: new AbortController().signal,
			observability: metrics,
		});
		expect((await boundary.invoke("call-1", "qorpera", "effect", {})).success).toBe(true);
		expect((await boundary.invoke("call-1", "qorpera", "effect", {})).success).toBe(true);
		expect(effect).toHaveBeenCalledTimes(1);
		await metrics.close();
		boundary.close();
	});

	it.each(["start-nan", "start-throw", "finish-nan", "finish-throw", "ticks-throw"])(
		"contains a %s clock fault before and after an effect",
		async (mode) => {
			let executed = false;
			const rows: CloudRuntimeObservation[] = [];
			const metrics = new CloudRuntimeObservability({
				assignmentId: randomUUID(),
				clock: () => {
					if (mode.startsWith(executed ? "finish" : "start")) {
						if (mode.endsWith("throw")) throw new Error("PRIVATE_CLOCK_ERROR");
						return NaN;
					}
					return Date.now();
				},
				monotonicClock: () => {
					if (mode === "ticks-throw") throw new Error("PRIVATE_CLOCK_ERROR");
					return performance.now();
				},
				publish: async (row) => {
					rows.push(row);
				},
			});
			const effect = vi.fn(async () => {
				executed = true;
				return { kind: "text" as const, value: "safe" };
			});
			const boundary = new CloudNativeToolBoundary({
				companyId: randomUUID(),
				runId: randomUUID(),
				tools: [
					{
						name: "effect",
						source: "connector",
						description: "Synthetic effect",
						inputSchema: { type: "object", additionalProperties: false },
						parseArguments: () => ({}),
						execute: effect,
					},
				],
				assertActive: async () => undefined,
				signal: new AbortController().signal,
				observability: metrics,
			});
			await expect(boundary.invoke("call-1", "qorpera", "effect", {})).resolves.toMatchObject({ success: true });
			expect(effect).toHaveBeenCalledTimes(1);
			await metrics.close();
			boundary.close();
			expect(JSON.stringify(rows)).not.toContain("PRIVATE_CLOCK_ERROR");
			if (mode === "ticks-throw")
				expect(rows.filter((row) => row.phase === "finish").every((row) => row.durationMs === null)).toBe(true);
			else expect(metrics.state.dropped).toBeGreaterThan(0);
		},
	);
});

describe("tool outcome diagnostics", () => {
	const tool = (execute: CloudNativeTool["execute"]) => syntheticTool("company_write", "company_file", execute);
	async function invoke(definition: CloudNativeTool, input: unknown, active = true) {
		const { metrics, rows } = observer();
		const boundary = new CloudNativeToolBoundary({
			companyId: randomUUID(),
			runId: randomUUID(),
			tools: [definition],
			observability: metrics,
			assertActive: async () => {
				if (!active) throw new Error("SECRET_AUTH_ERROR");
			},
			signal: new AbortController().signal,
		});
		const response = await boundary.invoke("call-private", "qorpera", definition.name, input);
		await metrics.close();
		boundary.close();
		return { rows, response };
	}
	it("records a proposal as proposed, not a completed Company File change", async () => {
		const { rows, response } = await invoke(
			tool(async () => ({
				kind: "json",
				value: {
					schema: "qorpera.company-path-result/v1",
					state: "proposed",
					path: "PRIVATE_PATH",
					text: "PRIVATE_CONTENT",
				},
			})),
			{},
		);
		expect(response.success).toBe(true);
		expect(rows[1].status).toBe("proposed");
		expect(rows[1].errorCategory).toBe("protected_path");
		expect(JSON.stringify(rows)).not.toMatch(/PRIVATE_PATH|PRIVATE_CONTENT|call-private/);
	});
	it("retains exact trusted byte/read metadata and never content", async () => {
		const readId = randomUUID();
		const { rows } = await invoke(
			tool(async (_, context) => {
				context.observation?.update({ readId, outputBytes: 4 });
				return { kind: "text", value: "SECRET_VALUE" };
			}),
			{},
		);
		expect(rows[1]).toMatchObject({ readId, outputBytes: 4, inputBytes: null, status: "succeeded" });
		expect(JSON.stringify(rows)).not.toContain("SECRET_VALUE");
	});
	it("marks authorization failure as denied without executing", async () => {
		const execute = vi.fn(async () => ({ kind: "text" as const, value: "never" }));
		const { rows, response } = await invoke(tool(execute), {}, false);
		expect(execute).not.toHaveBeenCalled();
		expect(response.success).toBe(false);
		expect(rows.find((row) => row.operation === "company_write" && row.phase === "finish")).toMatchObject({
			status: "denied",
			errorCategory: "authority_unavailable",
		});
		expect(JSON.stringify(rows)).not.toContain("SECRET_AUTH_ERROR");
	});
	it("keeps an ambiguous effect unconfirmed and classifies only trusted errors", async () => {
		const { rows, response } = await invoke(
			tool(async () => {
				throw new CloudRuntimeDiagnosticError("stale_version", "PRIVATE_UPSTREAM_DETAIL");
			}),
			{},
		);
		expect(response.success).toBe(false);
		expect(rows[1]).toMatchObject({ status: "unconfirmed", errorCategory: "stale_version" });
		expect(JSON.stringify(rows)).not.toContain("PRIVATE_UPSTREAM_DETAIL");
	});
	it("does not make a valid null tool result fail because its diagnostics lack a proposal", async () => {
		const { response } = await invoke(
			tool(async () => ({ kind: "json", value: null })),
			{},
		);
		expect(response.success).toBe(true);
	});

	it("preserves proposed status through truncation and exact cached replay", async () => {
		const { metrics, rows } = observer();
		const execute = vi.fn(async () => ({
			kind: "json" as const,
			value: { schema: "qorpera.company-path-result/v1", state: "proposed", path: "<".repeat(4096) },
		}));
		const boundary = new CloudNativeToolBoundary({
			companyId: randomUUID(),
			runId: randomUUID(),
			tools: [tool(execute)],
			observability: metrics,
			assertActive: async () => undefined,
			signal: new AbortController().signal,
		});
		for (let index = 0; index < 2; index++) {
			const response = await boundary.invoke("same-call", "qorpera", "company_write", {});
			expect(JSON.parse(response.contentItems[0].text).content.truncated).toBe(true);
		}
		await metrics.close();
		boundary.close();
		expect(execute).toHaveBeenCalledTimes(1);
		const finishes = rows.filter((row) => row.operation === "company_write" && row.phase === "finish");
		expect(finishes).toHaveLength(2);
		expect(finishes.map((row) => row.status)).toEqual(["proposed", "proposed"]);
	});

	it("separates a completed effect and cached replay from revoked result release", async () => {
		const { metrics, rows } = observer();
		let completed = false;
		const receiptId = randomUUID();
		const execute = vi.fn<CloudNativeTool["execute"]>(async (_, context) => {
			context.observation?.update({ receiptId, inputBytes: 7 });
			completed = true;
			return { kind: "json", value: { schema: "qorpera.company-path-result/v1", state: "applied" } };
		});
		const boundary = new CloudNativeToolBoundary({
			companyId: randomUUID(),
			runId: randomUUID(),
			tools: [tool(execute)],
			observability: metrics,
			assertActive: async () => {
				if (completed) throw new Error("PRIVATE_POST_EFFECT_DENIAL");
			},
			signal: new AbortController().signal,
		});
		for (let index = 0; index < 2; index++)
			expect((await boundary.invoke("same-call", "qorpera", "company_write", {})).success).toBe(false);
		await metrics.close();
		boundary.close();
		expect(execute).toHaveBeenCalledTimes(1);
		const finishes = rows.filter((row) => row.operation === "company_write" && row.phase === "finish");
		expect(finishes.map((row) => row.status)).toEqual(["succeeded", "replayed"]);
		expect(finishes.every((row) => row.receiptId === receiptId)).toBe(true);
		expect(
			rows.filter((row) => row.operation === "context_authority" && row.phase === "finish").map((row) => row.status),
		).toEqual(["denied", "denied"]);
		expect(JSON.stringify(rows)).not.toContain("PRIVATE_POST_EFFECT_DENIAL");
	});
});

describe("tool operation names", () => {
	it("keeps the tool names inside the closed vocabulary without duplicates", () => {
		for (const name of CLOUD_RUNTIME_TOOL_OPERATIONS) expect(CLOUD_RUNTIME_OPERATIONS).toContain(name);
		expect(new Set(CLOUD_RUNTIME_OPERATIONS).size).toBe(CLOUD_RUNTIME_OPERATIONS.length);
		expect(CLOUD_RUNTIME_TOOL_OPERATIONS).not.toContain("connector");
		expect(CLOUD_RUNTIME_TOOL_OPERATIONS).not.toContain("unknown_tool");
	});

	it("names runtime tools by their registered name, connectors as connector and the rest unknown", () => {
		for (const name of CLOUD_RUNTIME_TOOL_OPERATIONS)
			expect(cloudRuntimeToolOperation(syntheticTool(name, "runtime"))).toBe(name);
		expect(cloudRuntimeToolOperation(syntheticTool("gmail_send", "connector"))).toBe("connector");
		expect(cloudRuntimeToolOperation(syntheticTool("manage_routine", "connector"))).toBe("connector");
		expect(cloudRuntimeToolOperation(syntheticTool("company_context", "runtime"))).toBe("unknown_tool");
		expect(cloudRuntimeToolOperation(syntheticTool("report_work", "worker"))).toBe("report_work");
		expect(cloudRuntimeToolOperation(syntheticTool("worker_start", "worker"))).toBe("unknown_tool");
		expect(cloudRuntimeToolOperation(undefined)).toBe("unknown_tool");
	});

	it("records the Step 8 tools and the other runtime tools under their own operation", async () => {
		const { metrics, rows } = observer();
		const names = [
			"manage_routine",
			"hire_agent",
			"create_group_chat",
			"read_context",
			"send_coworker_message",
			"computer_start",
			"computer_shell",
			"report_work",
			"manage_todo",
			"manage_worker",
		] as const;
		const boundary = new CloudNativeToolBoundary({
			companyId: randomUUID(),
			runId: randomUUID(),
			tools: [
				...names.map((name) => syntheticTool(name, name === "report_work" ? "worker" : "runtime")),
				syntheticTool("lookup", "connector"),
			],
			assertActive: async () => undefined,
			signal: new AbortController().signal,
			observability: metrics,
		});
		const invoked = [...names, "lookup", "missing"];
		for (const [index, name] of invoked.entries()) await boundary.invoke(`call-${index}`, "qorpera", name, {});
		await metrics.close();
		boundary.close();
		// Each invocation also records its own context_authority child span.
		const finished = rows.filter((row) => row.phase === "finish" && row.operation !== "context_authority");
		expect(finished.map((row) => row.operation)).toEqual([...names, "connector", "unknown_tool"]);
		expect(rows.some((row) => row.operation === "company_context")).toBe(false);
		for (const row of finished) expect(CLOUD_RUNTIME_OPERATIONS).toContain(row.operation);
		expect(JSON.stringify(rows)).not.toContain("missing");
	});
});
