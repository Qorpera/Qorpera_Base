import { randomUUID } from "node:crypto";
import { cloudFolderFileTools } from "@qorpera/runtime/cloud-folder-file-tools";
import { type CloudNativeTool, CloudNativeToolBoundary } from "@qorpera/runtime/cloud-native-tool-boundary";
import {
	assertCloudRuntimeObservationBatchReceipt,
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
import { folderWriterFixture } from "./fixtures/folder-writer-fixture.ts";

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

function observer(
	publish?: (batch: readonly CloudRuntimeObservation[], signal: AbortSignal) => Promise<unknown>,
	options: { flushMs?: number; batchDelayMs?: number } = {},
) {
	const rows: CloudRuntimeObservation[] = [];
	const metrics = new CloudRuntimeObservability({
		assignmentId: randomUUID(),
		publish:
			publish ??
			(async (batch) => {
				rows.push(...batch);
			}),
		...options,
	});
	return { metrics, rows };
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
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

	it("requires one exact receipt or a known refusal per batch row, in row order", () => {
		const rows = [sample(), sample(), sample()];
		const runId = randomUUID();
		const receipt = (row: CloudRuntimeObservation) => ({
			schema: "qorpera.runtime-observation-receipt/v1",
			runId,
			attemptId: row.attemptId,
			phase: row.phase,
			ingestedAt: "2026-08-31T12:34:56.123456+00:00",
			replayed: false,
		});
		const refusal = (code: string) => ({ schema: "qorpera.runtime-observation-refusal/v1", code });
		const batch = (receipts: unknown[]) => ({
			schema: "qorpera.runtime-observation-batch-receipt/v1",
			runId,
			receipts,
		});
		expect(assertCloudRuntimeObservationBatchReceipt(batch(rows.map(receipt)), runId, rows)).toBe(0);
		expect(
			assertCloudRuntimeObservationBatchReceipt(
				batch([receipt(rows[0]), refusal("22023"), refusal("23505")]),
				runId,
				rows,
			),
		).toBe(2);
		for (const value of [
			null,
			[],
			{ ...batch(rows.map(receipt)), secret: "PRIVATE_RECEIPT" },
			{ ...batch(rows.map(receipt)), schema: "qorpera.runtime-observation-receipt/v1" },
			{ ...batch(rows.map(receipt)), runId: randomUUID() },
			batch(rows.slice(1).map(receipt)),
			batch([...rows.map(receipt), receipt(rows[0])]),
			batch([receipt(rows[1]), receipt(rows[0]), receipt(rows[2])]),
			batch([receipt(rows[0]), refusal("PT409"), receipt(rows[2])]),
			batch([receipt(rows[0]), { ...refusal("22023"), message: "PRIVATE" }, receipt(rows[2])]),
			batch([receipt(rows[0]), null, receipt(rows[2])]),
		])
			expect(() => assertCloudRuntimeObservationBatchReceipt(value, runId, rows)).toThrow(
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
			publish: async (batch) => {
				rows.push(...batch);
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
	it("sends queued rows in order, at most 50 a call and one call at a time", async () => {
		const gate = deferred();
		const batches: CloudRuntimeObservation[][] = [];
		let inFlight = 0;
		let maxInFlight = 0;
		const { metrics } = observer(async (batch) => {
			maxInFlight = Math.max(maxInFlight, ++inFlight);
			batches.push([...batch]);
			if (batches.length === 1) await gate.promise;
			inFlight--;
		});
		const spans = Array.from({ length: 60 }, () => metrics.start("company_read"));
		for (const span of spans) span.finish("succeeded");
		gate.resolve();
		await metrics.close();
		// Rows gather until 50 wait; close() sends the rest at once.
		expect(batches.map((batch) => batch.length)).toEqual([50, 50, 20]);
		expect(maxInFlight).toBe(1);
		const sent = batches.flat();
		expect(sent.map((row) => `${row.attemptId}:${row.phase}`)).toEqual([
			...spans.map((span) => `${span.attemptId}:start`),
			...spans.map((span) => `${span.attemptId}:finish`),
		]);
		expect(metrics.state).toEqual({ sent: 120, dropped: 0, pending: 0, status: "closed" });
	});

	it("gathers rows for a second before a call that is not full", async () => {
		vi.useFakeTimers();
		try {
			const sizes: number[] = [];
			const { metrics } = observer(async (batch) => {
				sizes.push(batch.length);
			});
			metrics.start("company_read").finish("succeeded");
			await vi.advanceTimersByTimeAsync(900);
			metrics.start("company_read");
			expect(sizes).toEqual([]);
			await vi.advanceTimersByTimeAsync(100);
			expect(sizes).toEqual([3]);
			for (let index = 0; index < 50; index++) metrics.start("company_read");
			await vi.advanceTimersByTimeAsync(0);
			expect(sizes).toEqual([3, 50]);
			await metrics.close();
		} finally {
			vi.useRealTimers();
		}
	});

	it("sends a live writing row at once, with the rows gathered before it", async () => {
		vi.useFakeTimers();
		try {
			const batches: string[][] = [];
			const { metrics } = observer(async (batch) => {
				batches.push(batch.map((row) => `${row.operation}:${row.phase}`));
			});
			metrics.start("company_read").finish("succeeded");
			await vi.advanceTimersByTimeAsync(100);
			expect(batches).toEqual([]);
			// The member-visible writing phase (20260920011000) does not wait for the gather.
			const writing = metrics.start("message_composition");
			await vi.advanceTimersByTimeAsync(0);
			expect(batches).toEqual([["company_read:start", "company_read:finish", "message_composition:start"]]);
			// Its finish is live too.
			writing.finish("succeeded");
			await vi.advanceTimersByTimeAsync(0);
			expect(batches.at(-1)).toEqual(["message_composition:finish"]);
			await metrics.close();
		} finally {
			vi.useRealTimers();
		}
	});

	it("retries a failed batch with backoff, resending the same rows in order", async () => {
		vi.useFakeTimers();
		try {
			const calls: string[][] = [];
			const { metrics } = observer(
				async (batch) => {
					calls.push(batch.map((row) => row.phase));
					if (calls.length <= 2) throw new Error("PRIVATE_EXPORT_DOWN");
				},
				{ batchDelayMs: 0 },
			);
			metrics.start("company_write").finish("succeeded");
			await vi.advanceTimersByTimeAsync(0);
			expect(calls).toEqual([["start", "finish"]]);
			expect(metrics.state.status).toBe("unavailable");
			// Backoff: nothing is sent again at once; then the same rows go first, a newer one after them.
			metrics.start("company_read");
			await vi.advanceTimersByTimeAsync(100);
			expect(calls).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(5000);
			expect(calls).toEqual([
				["start", "finish"],
				["start", "finish", "start"],
				["start", "finish", "start"],
			]);
			expect(metrics.state).toMatchObject({ sent: 3, dropped: 0, pending: 0, status: "active" });
			await metrics.close();
		} finally {
			vi.useRealTimers();
		}
	});

	it("drops a batch that fails every attempt and goes on with the next", async () => {
		vi.useFakeTimers();
		try {
			let calls = 0;
			const sent: CloudRuntimeObservation[] = [];
			const { metrics } = observer(
				async (batch) => {
					if (++calls <= 4) throw new Error("PRIVATE_EXPORT_DOWN");
					sent.push(...batch);
				},
				{ batchDelayMs: 0 },
			);
			const first = metrics.start("company_write");
			await vi.advanceTimersByTimeAsync(0);
			for (let index = 0; index < 60; index++) metrics.start("company_read");
			await vi.advanceTimersByTimeAsync(20_000);
			// The first batch (its one row plus 49 queued meanwhile) failed four times and was dropped.
			expect(calls).toBe(5);
			expect(sent).toHaveLength(11);
			expect(sent.some((row) => row.attemptId === first.attemptId)).toBe(false);
			expect(metrics.state).toMatchObject({ sent: 11, dropped: 50, status: "active" });
			await metrics.close();
		} finally {
			vi.useRealTimers();
		}
	});

	it("counts rows the database refused as dropped, not sent", async () => {
		// The database refused the start row (its only row), then took the finish.
		const answers = [1, 0];
		const { metrics } = observer(async () => answers.shift());
		metrics.start("company_write").finish("succeeded");
		await metrics.close();
		expect(metrics.state).toMatchObject({ sent: 1, dropped: 1 });
	});

	it("absorbs a synchronous exporter failure without echoing it", async () => {
		const publish = vi.fn(() => {
			throw new Error("PRIVATE_CREDENTIAL");
		});
		const { metrics } = observer(publish, { flushMs: 50 });
		metrics.start("company_write").finish("succeeded");
		await metrics.close();
		expect(publish.mock.calls.length).toBeGreaterThanOrEqual(1);
		expect(publish.mock.calls.length).toBeLessThanOrEqual(4);
		expect(metrics.state.status).toBe("unavailable");
		expect(metrics.state.dropped).toBe(2);
		expect(JSON.stringify(metrics.state)).not.toContain("PRIVATE_CREDENTIAL");
	});

	it("bounds a stalled exporter, its queue, its flush and all later work", async () => {
		const publish = vi.fn(async () => new Promise(() => undefined));
		const metrics = new CloudRuntimeObservability({
			assignmentId: randomUUID(),
			publish,
			timeoutMs: 20,
			flushMs: 100,
		});
		for (let index = 0; index < 600; index++) metrics.start("company_read").finish("succeeded");
		expect(metrics.state.pending).toBeLessThanOrEqual(256);
		expect(metrics.state.dropped).toBeGreaterThan(0);
		const begin = Date.now();
		await metrics.close();
		expect(Date.now() - begin).toBeLessThan(1000);
		// One call at a time: the first, then at most one retry within the flush bound.
		expect(publish.mock.calls.length).toBeLessThanOrEqual(2);
		expect(metrics.state).toMatchObject({ sent: 0, dropped: 1200, pending: 0, status: "unavailable" });
		const calls = publish.mock.calls.length;
		metrics.start("company_write").finish("failed");
		expect(publish).toHaveBeenCalledTimes(calls);
		expect(metrics.state.dropped).toBe(1202);
	});

	it("flushes what is queued on close within its bound", async () => {
		const sent: CloudRuntimeObservation[] = [];
		const { metrics } = observer(async (batch) => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			sent.push(...batch);
		});
		for (let index = 0; index < 100; index++) metrics.start("company_read").finish("succeeded");
		await metrics.close();
		expect(sent).toHaveLength(200);
		expect(metrics.state).toEqual({ sent: 200, dropped: 0, pending: 0, status: "closed" });
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
				publish: async (batch) => {
					rows.push(...batch);
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
	it("records a folder-v2 write parked for review as proposed through the receipt executor (P40b)", async () => {
		const f = await folderWriterFixture(
			{ folders: ["docs"] },
			{
				hook: (path) =>
					path === "docs/parked.md" ? { outcome: "waiting_for_review", reason: "review_required" } : null,
			},
		);
		try {
			const write = cloudFolderFileTools({ folder: f.folder, operations: f.operations(), identity: f.identity })[2];
			const call = async (path: string, operationKey: string) => {
				const { rows, response } = await invoke(write as CloudNativeTool, {
					path,
					operationKey,
					expectedVersion: null,
					text: "PRIVATE_CONTENT",
				});
				const finish = rows.find((row) => row.operation === write?.name && row.phase === "finish");
				return { rows, response, finish };
			};
			const parked = await call("docs/parked.md", "parked-1");
			expect(parked.response.success).toBe(true);
			expect(parked.finish).toMatchObject({ status: "proposed", errorCategory: "protected_path" });
			expect(parked.finish?.receiptId).toEqual(expect.any(String));
			expect(JSON.stringify(parked.rows)).not.toMatch(/PRIVATE_CONTENT|parked\.md|call-private/);
			const saved = await call("docs/saved.md", "saved-1");
			expect(saved.finish).toMatchObject({ status: "succeeded", errorCategory: null });
		} finally {
			f.run.close();
		}
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
