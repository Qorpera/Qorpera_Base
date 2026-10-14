import { randomUUID } from "node:crypto";
import { HttpCloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-control";
import type { CloudCompanyPathControl } from "@qorpera/runtime/cloud-company-path-gateway";
import {
	CLOUD_NATIVE_CONTEXT_COMPOSITION_SCHEMA,
	type CloudNativeContextRequest,
} from "@qorpera/runtime/cloud-native-context-composition";
import type { CloudNativeToolBinding, CloudNativeToolRun } from "@qorpera/runtime/cloud-native-tool-authority";
import { type CloudRunLogFolder, CloudRunLogGone, type CloudRunLogPlace } from "@qorpera/runtime/cloud-run-log";
import { type CloudRunResumeRequest, CloudRunResumeRpc, openCloudRunResume } from "@qorpera/runtime/cloud-run-resume";
import { MemoryCompactLane } from "@qorpera/runtime/memory-tree/compact";
import { cloudRunStepText, RUN_STEP_OUTCOME_UNKNOWN } from "@qorpera/runtime/memory-tree/step-lines";
import { afterEach, describe, expect, it, vi } from "vitest";

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
	const root = `agents/researcher/memory/thread/runs/${binding.runId}`;
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
	const records: CloudRunResumeRequest[] = [];
	const control: CloudCompanyPathControl = {
		call: vi.fn(async (method, args) => {
			if (method === "qorpera_memory_run_resume") return structuredClone(context);
			if (method !== "qorpera_memory_run_resume_record") throw new Error(`Unexpected method ${method}`);
			const sent = args.p_request as CloudRunResumeRequest;
			records.push(structuredClone(sent));
			const current = context as {
				why: string;
				unknownReceipts: { receiptId: string; logicalOperationKey: string }[];
			};
			return {
				schema: "qorpera.memory-run-resume-record/v1",
				why: current.why,
				stepsRead: sent.stepsRead,
				unknownCalls: sent.unknownCalls.map((item) => ({
					...item,
					logicalOperationKey:
						item.receiptId === null
							? null
							: current.unknownReceipts.find((entry) => entry.receiptId === item.receiptId)!.logicalOperationKey,
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

	it("permits both RPCs in the concrete closed HTTP client", async () => {
		const f = fixture();
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("null"));
		const control = new HttpCloudCompanyPathControl({
			supabaseUrl: "https://test.supabase.example",
			serviceRoleKey: "test-key",
			fetch: fetcher,
		});
		await control.call("qorpera_memory_run_resume", { p_binding: f.binding }, signal);
		fetcher.mockResolvedValue(new Response("{}"));
		await control.call(
			"qorpera_memory_run_resume_record",
			{ p_binding: f.binding, p_request: { stepsRead: 0, unknownCalls: [] } },
			signal,
		);
		expect(fetcher.mock.calls.map(([url]) => String(url).split("/").at(-1))).toEqual([
			"qorpera_memory_run_resume",
			"qorpera_memory_run_resume_record",
		]);
	});
});
