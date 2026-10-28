import { randomUUID } from "node:crypto";
import { HttpCloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-control";
import type { CloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-gateway";
import { CloudControlRpcRefused, cloudControlRetryable } from "@qorpera/runtime/cloud-control-errors";
import {
	CLOUD_NATIVE_CONTEXT_COMPOSITION_SCHEMA,
	type CloudNativeContextRequest,
} from "@qorpera/runtime/cloud-native-context-composition";
import { type CloudNativeToolBinding, CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { type CloudRunLogFolder, CloudRunLogGone, type CloudRunLogPlace } from "@qorpera/runtime/cloud-run-log";
import {
	type CloudRunResumeRequest,
	CloudRunResumeRpc,
	openCloudRunReceiptsResume,
	openCloudRunResume,
	RUN_RESUME_RECEIPTS,
} from "@qorpera/runtime/cloud-run-resume";
import { MemoryCompactLane } from "@qorpera/runtime/memory-tree/compact";
import { cloudRunWorkMessage } from "@qorpera/runtime/memory-tree/run-work";
import { cloudRunStepText, RUN_STEP_OUTCOME_UNKNOWN } from "@qorpera/runtime/memory-tree/step-lines";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const signal = new AbortController().signal;
const opened: NonNullable<Awaited<ReturnType<typeof openCloudRunResume>>>[] = [];
afterEach(async () => {
	for (const result of opened.splice(0)) {
		await result.lines.finish(AbortSignal.abort()).catch(() => undefined);
		await result.log.close(AbortSignal.abort()).catch(() => undefined);
	}
});

function row(j: number, result: unknown = { ok: true }): Record<string, unknown> {
	return {
		j,
		tool: "company_write",
		call: `call_${j}`,
		args: "{}",
		args_bytes: 2,
		args_hash: null,
		result,
		reads: [],
		releases: [],
		paths: [],
		text: "",
		at: "2026-10-09T12:00:00Z",
	};
}
function erased(j: number) {
	return { j, tool: "company_write", call: `call_${j}`, args_bytes: 2, args_hash: null, erased: true };
}
function request(): CloudNativeContextRequest {
	return {
		schema: CLOUD_NATIVE_CONTEXT_COMPOSITION_SCHEMA,
		requestId: "request-1",
		threadId: "thread-1",
		turnId: "turn-1",
		purpose: "turn",
		model: "model",
		items: [{ kind: "message", role: "user", callId: null, id: null, bytes: 100, media: 0 }],
	};
}

function fixture() {
	const binding: CloudNativeToolBinding = {
		runId: randomUUID(),
		leaseId: randomUUID(),
		jobId: randomUUID(),
		runnerId: randomUUID(),
		assignmentId: randomUUID(),
		credentialCapsuleId: randomUUID(),
		computeIdentityId: randomUUID(),
		provider: "openai",
		nativeHarness: "codex-cli",
		model: "model",
	};
	const root = `qorperaos/agents/researcher/memory/thread/runs/${binding.runId}`;
	const place: { -readonly [K in keyof CloudRunLogPlace]: CloudRunLogPlace[K] } = {
		path: root,
		exists: true,
		missing: [],
		last: 2,
		generation: 7,
		origin: { conversation: randomUUID(), parent: null, step: null, continues: null, narrow: false },
	};
	const files = new Map<string, { version: string; text: string }>();
	const block = (first: number, rows: readonly Record<string, unknown>[]) => {
		const path = `${root}/log/${String(first).padStart(8, "0")}.jsonl`;
		files.set(path, { version: randomUUID(), text: rows.map((row) => `${JSON.stringify(row)}\n`).join("") });
		return path;
	};
	block(0, [row(0), erased(1)]);
	block(2, [row(2, null), row(3)]);
	const folder: CloudRunLogFolder = {
		locate: vi.fn(async () => structuredClone(place)),
		read: vi.fn(async (path) => files.get(path) ?? null),
		commit: vi.fn(async () => {
			throw new Error("Unexpected commit");
		}),
	};
	let context: unknown = {
		schema: "qorpera.memory-run-resume/v1",
		why: "restart",
		unknownReceipts: [{ receiptId: randomUUID(), logicalOperationKey: "op.mail-previous-attempt" }],
	};
	// A run that keeps no log (Agent notebooks) reads its receipts instead; null for this one, which keeps a log.
	let receipts: unknown = null;
	const records: CloudRunResumeRequest[] = [];
	const control: CloudCompanyPathControl = {
		call: vi.fn(async (method, args) => {
			if (method === "qorpera_memory_run_resume") return structuredClone(context);
			if (method === "qorpera_memory_run_resume_receipts") return structuredClone(receipts);
			if (method !== "qorpera_memory_run_resume_record") throw new Error(`Unexpected method ${method}`);
			const sent = args.p_request as CloudRunResumeRequest;
			records.push(structuredClone(sent));
			type Receipt = { receiptId: string; logicalOperationKey: string };
			const current = (receipts ?? context) as { why: string; unknownReceipts?: Receipt[]; receipts?: Receipt[] };
			const known = current.receipts ?? current.unknownReceipts!;
			return {
				schema: "qorpera.memory-run-resume-record/v1",
				why: current.why,
				stepsRead: sent.stepsRead,
				unknownCalls: sent.unknownCalls.map((item) => ({
					...item,
					logicalOperationKey:
						item.receiptId === null
							? null
							: known.find((entry) => entry.receiptId === item.receiptId)!.logicalOperationKey,
				})),
			};
		}),
	};
	const run: Pick<CloudNativeToolRun, "binding" | "retry"> = {
		binding,
		retry: async (read, io) => {
			io.throwIfAborted();
			return { value: await read(io), started: 0 };
		},
	};
	const resume = new CloudRunResumeRpc({ run, control });
	const options = {
		resume,
		folder,
		log: {
			runId: binding.runId,
			signal,
			protection: {
				narrow: vi.fn(async () => ({ log: false, narrow: false })),
				hashes: vi.fn(async (_run: string, digests: readonly string[]) => digests),
			},
		},
		lines: {
			lane: new MemoryCompactLane(),
			call: vi.fn(async () => {
				throw new Error("Unexpected model call");
			}),
		},
	};
	const open = async () => {
		const value = await openCloudRunResume(options);
		if (value) opened.push(value);
		return value;
	};
	return {
		binding,
		root,
		place,
		files,
		block,
		folder,
		run,
		resume,
		control,
		records,
		options,
		open,
		get context() {
			return context;
		},
		set context(value: unknown) {
			context = value;
		},
		set receipts(value: unknown) {
			receipts = value;
		},
	};
}

describe("dormant run resume opening", () => {
	it("discovers contiguous blocks, lists erased steps as unknown, and exposes only after recording", async () => {
		const f = fixture();
		const result = (await f.open())!;
		expect(result.firstStep).toBe(4);
		expect(result.earlier.map(({ j }) => j)).toEqual([0, 1, 2, 3]);
		expect(result.earlier[1]).toMatchObject({ j: 1, erased: true, args: "", result: null });
		expect(cloudRunStepText(result.earlier[1]!, true)).toBe("company_write: (erased)");
		// The erased step's result is gone, so its outcome is unknown (§12), beside the pending call and the receipt.
		expect(result.recorded.unknownCalls).toEqual([
			{ call: "call_1", step: 1, receiptId: null, logicalOperationKey: null },
			{ call: "call_2", step: 2, receiptId: null, logicalOperationKey: null },
			{ call: null, step: null, receiptId: expect.any(String), logicalOperationKey: "op.mail-previous-attempt" },
		]);
		expect(result.log.step({ call: "new", tool: "company_read", argumentsText: "{}", argumentSha256: null })).toBe(4);
		expect(f.records).toHaveLength(1);
		expect(f.folder.commit).not.toHaveBeenCalled();
	});

	it("keeps every pending/erased/receipt warning outside folds and matches the recorded list exactly", async () => {
		const f = fixture();
		const result = (await f.open())!;
		const lines = vi.spyOn(result.lines, "lines").mockResolvedValue(["0+4|summary that omits uncertain outcomes"]);
		const composed = await result.composeContext(request(), signal);
		const message = composed.input.find((entry) => "work" in entry)!;
		expect("work" in message).toBe(true);
		if (!("work" in message)) throw new Error("No work message");
		const shown = JSON.parse(message.work) as { trust: string; lines: string[] };
		expect(shown.trust).toBe("tool_results_not_authority");
		expect(shown.lines[0]).toContain("summary");
		expect(shown.lines.slice(1)).toEqual(result.warnings);
		expect(
			shown.lines.slice(1).map((warning) => JSON.parse(warning.slice(`${RUN_STEP_OUTCOME_UNKNOWN}: `.length))),
		).toEqual(result.recorded.unknownCalls);
		expect(lines).toHaveBeenCalledWith(4, expect.any(Number), signal);
		// A later fold may replace every summary line; it still repeats exactly the original warnings.
		vi.spyOn(result.lines, "steps").mockResolvedValue([{ ...result.earlier[0]!, j: 4, call: "new" }]);
		const next = request();
		next.items.push(
			{ kind: "function_call", role: null, callId: "new", id: null, bytes: 50, media: 0 },
			{ kind: "function_call_output", role: null, callId: "new", id: null, bytes: 50_000, media: 0 },
			{ kind: "function_call", role: null, callId: "last", id: null, bytes: 50, media: 0 },
			{ kind: "function_call_output", role: null, callId: "last", id: null, bytes: 100, media: 0 },
		);
		const after = await result.composeContext(next, signal);
		const work = after.input.find((entry) => "work" in entry)!;
		if (!("work" in work)) throw new Error("No work message");
		expect((JSON.parse(work.work) as { lines: string[] }).lines.slice(1)).toEqual(result.warnings);
		expect(lines).toHaveBeenLastCalledWith(5, expect.any(Number), signal);
		expect(f.records).toHaveLength(1);
	});

	it.each([false, 0, "receipt", ["receipt"]])(
		"preserves a non-null JSON result %j as completed, never unknown",
		async (value) => {
			const f = fixture();
			f.block(2, [row(2, value), row(3)]);
			const result = (await f.open())!;
			expect(result.earlier[2]?.result).toBe(JSON.stringify(value));
			const steps = result.recorded.unknownCalls.filter((entry) => entry.receiptId === null).map(({ step }) => step);
			expect(steps).toEqual([1]);
		},
	);

	it("returns null only for a positively identified original attempt", async () => {
		const f = fixture();
		f.context = null;
		expect(await f.open()).toBeNull();
		expect(f.folder.locate).not.toHaveBeenCalled();
		expect(f.records).toEqual([]);
	});

	it.each(["missing", "gone", "hole", "last", "narrow-origin", "narrow-step", "invalid", "moved", "erasing"])(
		"refuses %s without exposing a fresh writer",
		async (mode) => {
			const f = fixture();
			if (mode === "missing") f.place.exists = false;
			if (mode === "gone") vi.mocked(f.folder.locate).mockRejectedValue(new CloudRunLogGone());
			if (mode === "hole") f.files.delete(`${f.root}/log/00000000.jsonl`);
			if (mode === "last") f.files.delete(`${f.root}/log/00000002.jsonl`);
			if (mode === "narrow-origin") f.place.origin = { ...f.place.origin!, narrow: true };
			if (mode === "narrow-step")
				f.block(0, [
					{ j: 0, tool: "company_read", call: "c", args_hash: null, narrow: true, erased: true },
					erased(1),
				]);
			if (mode === "invalid") f.block(0, [row(0), row(2)]);
			if (mode === "moved")
				vi.mocked(f.folder.locate)
					.mockResolvedValueOnce(structuredClone(f.place))
					.mockResolvedValue({ ...f.place, generation: 8 });
			if (mode === "erasing") {
				const call = vi.mocked(f.control.call).getMockImplementation()!;
				vi.mocked(f.control.call).mockImplementation((method, args, io) => {
					if (method === "qorpera_memory_run_resume_record") throw new Error("55000: log unavailable or changed");
					return call(method, args, io);
				});
			}
			await expect(f.open()).rejects.toThrow();
			expect(f.folder.commit).not.toHaveBeenCalled();
			expect(f.options.lines.call).not.toHaveBeenCalled();
		},
	);

	it("supports a live zero-step log with receipt-only warnings without inventing a step", async () => {
		const f = fixture();
		f.files.clear();
		f.place.last = null;
		const result = (await f.open())!;
		vi.spyOn(result.lines, "lines").mockResolvedValue([]);
		const composed = await result.composeContext(request(), signal);
		expect(composed.input.some((entry) => "work" in entry && entry.work.includes("op.mail-previous-attempt"))).toBe(
			true,
		);
		expect(result.firstStep).toBe(0);
		expect(result.recorded.unknownCalls[0]).toMatchObject({ call: null, step: null });
	});

	it("refuses a record that changes what the prompt would show", async () => {
		const f = fixture();
		const record = f.resume.record.bind(f.resume);
		vi.spyOn(f.resume, "record").mockImplementation(async (request, io) => ({
			...(await record(request, io)),
			why: "limit_reset",
		}));
		await expect(f.open()).rejects.toThrow("resume_response_invalid");
	});

	it("refuses oversized explicit warnings rather than dropping receipt entries", async () => {
		const f = fixture();
		f.context = {
			schema: "qorpera.memory-run-resume/v1",
			why: "restart",
			unknownReceipts: Array.from({ length: 1600 }, () => ({
				receiptId: randomUUID(),
				logicalOperationKey: "x".repeat(192),
			})),
		};
		await expect(f.open()).rejects.toThrow("resume_warnings_too_large");
		expect(f.records).toEqual([]);
	});
});

describe("a resumed attempt that keeps no log (Agent notebooks, 20260930539000)", () => {
	const SCHEMA = "qorpera.memory-run-resume-receipts/v1";
	const completed = (logicalOperationKey: string) => ({
		receiptId: randomUUID(),
		logicalOperationKey,
		status: "completed",
	});
	const unknown = (logicalOperationKey: string) => ({
		receiptId: randomUUID(),
		logicalOperationKey,
		status: "outcome_unknown",
	});
	const open = async (f: ReturnType<typeof fixture>) =>
		openCloudRunReceiptsResume({ resume: f.resume, receipts: (await f.resume.receipts(signal))!, signal });
	const shown = ({ receiptId, logicalOperationKey }: { receiptId: string; logicalOperationKey: string }) => ({
		receiptId,
		logicalOperationKey,
	});

	it("tells the attempt each completed effect and each unknown one by its key, no result, and records the unknown ones", async () => {
		const f = fixture();
		// Receipt keys as tools store them: with the tool's own prefix, and one begun in SQL with no tool name.
		const older = completed("manage_todo:todo:plan");
		const done = completed("hire_agent:hire:researcher");
		const unsure = unknown("coworker:ask-sara");
		f.receipts = { schema: SCHEMA, why: "restart", receipts: [older, done, unsure], completedOmitted: 2 };
		const result = await open(f);
		// Oldest first, each by its receipt's key as stored.
		expect(result.lines).toEqual([
			RUN_RESUME_RECEIPTS,
			"earlier: 2 older completed effects are not listed",
			`completed: ${JSON.stringify(shown(older))}`,
			`completed: ${JSON.stringify(shown(done))}`,
			`${RUN_STEP_OUTCOME_UNKNOWN}: ${JSON.stringify({ call: null, step: null, ...shown(unsure) })}`,
		]);
		expect(f.records).toEqual([
			{ stepsRead: 0, unknownCalls: [{ call: null, step: null, receiptId: unsure.receiptId }] },
		]);
		expect(result.recorded).toEqual({
			why: "restart",
			stepsRead: 0,
			unknownCalls: [{ call: null, step: null, ...shown(unsure) }],
		});
		// Every request of the attempt: Codex's items, and the same one work message before the attempt's own work.
		const message = cloudRunWorkMessage(result.lines);
		expect((await result.composeContext(request(), signal)).input).toEqual([{ keep: 0 }, { work: message }]);
		const next = request();
		next.items.push(
			{ kind: "reasoning", role: null, callId: null, id: null, bytes: 50, media: 0 },
			{ kind: "function_call", role: null, callId: "call_1", id: null, bytes: 50, media: 0 },
			{ kind: "function_call_output", role: null, callId: "call_1", id: null, bytes: 90_000, media: 0 },
		);
		expect((await result.composeContext(next, signal)).input).toEqual([
			{ keep: 0 },
			{ work: message },
			{ keep: 1 },
			{ keep: 2 },
			{ keep: 3 },
		]);
		expect(f.records).toHaveLength(1);
		expect(f.folder.locate).not.toHaveBeenCalled();
		expect(f.folder.commit).not.toHaveBeenCalled();
	});

	it("lists completed effects alone after a usage-limit reset, and records no unknown one", async () => {
		const f = fixture();
		const first = completed("company_write:a");
		const second = completed("todo:b");
		f.receipts = { schema: SCHEMA, why: "limit_reset", receipts: [first, second], completedOmitted: 0 };
		const result = await open(f);
		expect(result.lines).toEqual([
			RUN_RESUME_RECEIPTS,
			`completed: ${JSON.stringify(shown(first))}`,
			`completed: ${JSON.stringify(shown(second))}`,
		]);
		expect(f.records).toEqual([{ stepsRead: 0, unknownCalls: [] }]);
		expect(result.recorded.why).toBe("limit_reset");
	});

	it("refuses a record that changes what the prompt would show", async () => {
		const f = fixture();
		f.receipts = { schema: SCHEMA, why: "restart", receipts: [unknown("mail_send:intro")], completedOmitted: 0 };
		const record = f.resume.record.bind(f.resume);
		const spy = vi.spyOn(f.resume, "record");
		spy.mockImplementationOnce(async (request, io) => ({ ...(await record(request, io)), why: "limit_reset" }));
		await expect(open(f)).rejects.toThrow("resume_response_invalid");
		spy.mockImplementationOnce(async (request, io) => {
			const recorded = await record(request, io);
			return {
				...recorded,
				unknownCalls: recorded.unknownCalls.map((item) => ({ ...item, logicalOperationKey: "x" })),
			};
		});
		await expect(open(f)).rejects.toThrow("resume_response_invalid");
	});

	it("refuses oversized receipts rather than leave an unknown effect out", async () => {
		const f = fixture();
		f.receipts = {
			schema: SCHEMA,
			why: "restart",
			receipts: Array.from({ length: 1600 }, () => unknown("x".repeat(192))),
			completedOmitted: 0,
		};
		await expect(open(f)).rejects.toThrow("resume_warnings_too_large");
		expect(f.records).toEqual([]);
	});

	it("reads null for an attempt that does not resume from its receipts", async () => {
		const f = fixture();
		expect(await f.resume.receipts(signal)).toBeNull();
		expect(vi.mocked(f.control.call).mock.calls).toEqual([
			["qorpera_memory_run_resume_receipts", { p_binding: f.binding }, expect.any(AbortSignal)],
		]);
	});

	it.each([
		undefined,
		{},
		{ schema: "wrong", why: "restart", receipts: [], completedOmitted: 0 },
		{ schema: SCHEMA, why: "handoff", receipts: [], completedOmitted: 0 },
		{ schema: SCHEMA, why: "restart", receipts: {}, completedOmitted: 0 },
		{ schema: SCHEMA, why: "restart", receipts: [], completedOmitted: -1 },
		{ schema: SCHEMA, why: "restart", receipts: [], completedOmitted: 0, more: true },
		{ schema: SCHEMA, why: "restart", receipts: [{ ...unknown("key"), receiptId: "bad" }], completedOmitted: 0 },
		{
			schema: SCHEMA,
			why: "restart",
			receipts: [{ ...unknown("key"), logicalOperationKey: "" }],
			completedOmitted: 0,
		},
		{ schema: SCHEMA, why: "restart", receipts: [{ ...unknown("key"), status: "pending" }], completedOmitted: 0 },
		// A receipt is read with no stored result, not even an empty one.
		{
			schema: SCHEMA,
			why: "restart",
			receipts: [{ ...completed("key"), content: { kind: "text", value: "x" } }],
			completedOmitted: 0,
		},
		{ schema: SCHEMA, why: "restart", receipts: [{ ...unknown("key"), content: null }], completedOmitted: 0 },
	])("rejects malformed receipts %j", async (value) => {
		const f = fixture();
		f.receipts = value;
		await expect(f.resume.receipts(signal)).rejects.toThrow("resume_response_invalid");
	});

	it("rejects a receipt listed twice", async () => {
		const f = fixture();
		const item = unknown("key");
		f.receipts = { schema: SCHEMA, why: "restart", receipts: [item, item], completedOmitted: 0 };
		await expect(f.resume.receipts(signal)).rejects.toThrow("resume_response_invalid");
	});
});

describe("resume binding RPC", () => {
	it("uses the immutable full binding and retries an identical record after a lost reply", async () => {
		const f = fixture();
		const normal = f.run.retry;
		let calls = 0;
		f.run.retry = async (read, io) => {
			const first = await normal(read, io);
			if (++calls === 2) return normal(read, io); // first record response lost after durable write
			return first;
		};
		const result = (await f.open())!;
		expect(f.records).toHaveLength(2);
		expect(f.records[0]).toEqual(f.records[1]);
		expect(result.recorded.stepsRead).toBe(4);
		for (const [, args] of vi.mocked(f.control.call).mock.calls) expect(args.p_binding).toEqual(f.binding);
		expect(vi.mocked(f.control.call).mock.calls[0]?.[1]).toEqual({ p_binding: f.binding });
	});

	it.each([
		undefined,
		{},
		{ schema: "wrong", why: "restart", unknownReceipts: [] },
		{ schema: "qorpera.memory-run-resume/v1", why: "handoff", unknownReceipts: [] },
		{
			schema: "qorpera.memory-run-resume/v1",
			why: "restart",
			unknownReceipts: [{ receiptId: "bad", logicalOperationKey: "key" }],
		},
	])("rejects malformed context %j", async (value) => {
		const f = fixture();
		f.context = value;
		await expect(f.open()).rejects.toThrow("resume_response_invalid");
		expect(f.folder.locate).not.toHaveBeenCalled();
	});

	it("rejects duplicate receipt IDs and unpaired/mismatched record identities", async () => {
		const f = fixture();
		const item = { receiptId: randomUUID(), logicalOperationKey: "key" };
		f.context = { schema: "qorpera.memory-run-resume/v1", why: "limit_reset", unknownReceipts: [item, item] };
		await expect(f.open()).rejects.toThrow("resume_response_invalid");
		f.context = { schema: "qorpera.memory-run-resume/v1", why: "limit_reset", unknownReceipts: [item] };
		const call = vi.mocked(f.control.call).getMockImplementation()!;
		vi.mocked(f.control.call).mockImplementation(async (method, args, io) => {
			const value = await call(method, args, io);
			if (method === "qorpera_memory_run_resume_record") {
				const record = value as { unknownCalls: { call: string | null }[] };
				record.unknownCalls[1]!.call = "guessed_link";
			}
			return value;
		});
		await expect(f.open()).rejects.toThrow("resume_response_invalid");
	});

	it("stops before any read on cancellation or a different bound run", async () => {
		const f = fixture();
		await expect(
			openCloudRunResume({ ...f.options, log: { ...f.options.log, signal: AbortSignal.abort() } }),
		).rejects.toBeDefined();
		await expect(
			openCloudRunResume({ ...f.options, log: { ...f.options.log, runId: randomUUID() } }),
		).rejects.toThrow("resume_run_mismatch");
		expect(f.control.call).not.toHaveBeenCalled();
	});

	it("permits the three RPCs in the concrete closed HTTP client", async () => {
		const f = fixture();
		const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response("null"));
		const control = new HttpCloudCompanyPathControl({
			supabaseUrl: "https://test.supabase.example",
			serviceRoleKey: "test-key",
			fetch: fetcher,
		});
		await control.call("qorpera_memory_run_resume", { p_binding: f.binding }, signal);
		await control.call("qorpera_memory_run_resume_receipts", { p_binding: f.binding }, signal);
		fetcher.mockResolvedValue(new Response("{}"));
		await control.call(
			"qorpera_memory_run_resume_record",
			{ p_binding: f.binding, p_request: { stepsRead: 0, unknownCalls: [] } },
			signal,
		);
		expect(fetcher.mock.calls.map(([url]) => String(url).split("/").at(-1))).toEqual([
			"qorpera_memory_run_resume",
			"qorpera_memory_run_resume_receipts",
			"qorpera_memory_run_resume_record",
		]);
	});

	it("refuses a changed record replay (23505) at once through the HTTP client and the run's real retry", async () => {
		const { binding, authority } = nativeToolAuthorityFixture();
		const run = await CloudNativeToolRun.open(binding, { describeToolAuthority: async () => authority }, signal);
		try {
			// The same assignment reopened after appending steps: its stored record has a lower count.
			const sent: CloudRunResumeRequest = {
				stepsRead: 6,
				unknownCalls: [{ call: "call_1", step: 1, receiptId: null }],
			};
			const refusal = { code: "23505", message: "Run resume was recorded otherwise", details: null, hint: null };
			const resumeWith = (fetcher: typeof fetch) =>
				new CloudRunResumeRpc({
					run,
					control: new HttpCloudCompanyPathControl({
						supabaseUrl: "https://test.supabase.example",
						serviceRoleKey: "test-key",
						fetch: fetcher,
					}),
				});
			// PostgREST answers a unique violation with 409.
			const fetcher = vi.fn<typeof fetch>(async () => Response.json(refusal, { status: 409 }));
			const resume = resumeWith(fetcher);
			const error = await resume.record(sent, signal).catch((error: unknown) => error);
			expect(error).toBeInstanceOf(CloudControlRpcRefused);
			expect((error as CloudControlRpcRefused).code).toBe("23505");
			expect((error as CloudControlRpcRefused).detail).toBe(refusal.message);
			expect(cloudControlRetryable(error)).toBe(false);
			expect(fetcher).toHaveBeenCalledOnce();
			expect(String(fetcher.mock.calls[0]?.[0]).split("/").at(-1)).toBe("qorpera_memory_run_resume_record");
			expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ p_binding: binding, p_request: sent });
			// The refusal ends this record only; the run's authority stands.
			expect(run.signal.aborted).toBe(false);

			// The real retry does ask a lost answer again, with the same request, and still stops at the refusal.
			let answers = 0;
			const lossy = vi.fn<typeof fetch>(async () => {
				if (++answers === 1) return new Response("<html>bad gateway</html>", { status: 502 });
				return Response.json(refusal, { status: 409 });
			});
			const retried = resumeWith(lossy);
			const again = await retried.record(sent, signal).catch((error: unknown) => error);
			expect(again).toBeInstanceOf(CloudControlRpcRefused);
			expect((again as CloudControlRpcRefused).code).toBe("23505");
			expect(lossy).toHaveBeenCalledTimes(2);
			expect(lossy.mock.calls[1]?.[1]?.body).toBe(lossy.mock.calls[0]?.[1]?.body);
		} finally {
			run.close();
		}
	});
});
