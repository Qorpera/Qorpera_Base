import type { CloudCodingRepository } from "@qorpera/contracts";
import { describe, expect, it, vi } from "vitest";
import type { CodeChangeTarget } from "../src/code-change-records.ts";
import {
	type CodeChangeDiff,
	type CodeHostGcBlock,
	type CodeHostJob,
	CodeHostJobFailure,
	CodeHostRefusal,
} from "../src/code-host-jobs.ts";
import {
	CODE_REQUEST_RPCS,
	CodeHostRequests,
	type CodeHostRequestsOptions,
	type CodeRequestJobs,
	type CodeRequestOutcome,
	type CodeRestoreRequest,
} from "../src/code-host-requests.ts";
import { CODE_HOST_LAYOUT, type CodeHostJobOptions, type CodeHostJobs } from "../src/code-host-views.ts";
import { type CodeImportOutcome, type CodeImportRequest, codeImportRequestOf } from "../src/code-import.ts";
import { CodingControlBusy } from "../src/coding-executor.ts";
import { watchAbortSignalAny } from "./helpers/abort-any.ts";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT = "33333333-3333-4333-8333-333333333333";
const R1 = "aaaaaaaa-0000-4000-8000-000000000001";
const R2 = "aaaaaaaa-0000-4000-8000-000000000002";
const R3 = "aaaaaaaa-0000-4000-8000-000000000003";
const T1 = "bbbbbbbb-0000-4000-8000-000000000001";
const T2 = "bbbbbbbb-0000-4000-8000-000000000002";
const T3 = "bbbbbbbb-0000-4000-8000-000000000003";
const OWNER = "coding-node-1";
const MACHINE = "d".repeat(64);
const BEFORE = "a".repeat(40);
const AFTER = "b".repeat(40);
const MAIN = "c".repeat(40);
const UNDONE = "e".repeat(40);
const SCHEMA = "qorpera.code-request-outcome/v1";
const FINISH = "qorpera.code-request-finish/v1";
const STEP = "qorpera.code-request-step/v1";
const STRAND = "qorpera.code-restore-strand/v1";
/** What a claim asks for without an import runner, or while an import runs. */
const KINDS = ["undo", "download", "restore"];
const REPOSITORY: CloudCodingRepository = { host: "qorpera", owner: "qorpera", name: "shop", baseBranch: "main" };
const TARGET: CodeChangeTarget = { companyId: COMPANY, environmentId: ENVIRONMENT, owner: "qorpera", name: "shop" };
const WHERE = { companyId: COMPANY, environmentId: ENVIRONMENT, owner: "qorpera", name: "shop" };
const UNDO = {
	requestId: R1,
	token: T1,
	leaseUntil: "2026-11-10T12:05:00+00:00",
	...WHERE,
	kind: "undo",
	change: { n: 12, mainBefore: BEFORE, mainAfter: AFTER },
	andLater: false,
	message: "Undo change 12: A banner on the front page",
};
const DOWNLOAD = {
	requestId: R2,
	token: T2,
	leaseUntil: "2026-11-10T12:30:00+00:00",
	...WHERE,
	kind: "download",
	work: "make",
	file: "files",
	fileName: "shop-2026-11-10.zip",
	path: "code/qorpera/shop/downloads/shop-2026-11-10.zip",
};
const RESTORE = {
	requestId: R3,
	token: T3,
	leaseUntil: "2026-11-10T14:00:00+00:00",
	...WHERE,
	kind: "restore",
	mode: "restore",
	bundle: "fresh",
	damaged: "keep",
	progress: null,
	path: null,
	sessions: [{ workerId: R1, baseSha: BEFORE }],
};
const DIFF: CodeChangeDiff = {
	filesChanged: 2,
	paths: [
		{ path: "src/banner.tsx", change: "removed" },
		{ path: "src/front.tsx", change: "changed" },
	],
	pathsMore: 0,
};
const MADE = { path: DOWNLOAD.path, bytes: 5_242_880, sha256: "f".repeat(64), mainSha: MAIN };
const BLOCK: CodeHostGcBlock = {
	begin: async () => ({ state: "blocking", held: 0 }),
	end: async () => undefined,
};
const SHELL = {
	run: async () => {
		throw new Error("the stand-ins run no command");
	},
};
const WHO = { p_owner: OWNER, p_machine_id_sha256: MACHINE };
const yielded = () => new CodeHostJobFailure("CODE_HOST_JOB_YIELDED", "another job of the company joined the line");
const finishOf = (requestId: string, token: string, outcome: unknown) => ({
	method: "qorpera_code_request_finish",
	args: { ...WHO, p_request_id: requestId, p_token: token, p_outcome: outcome },
});

/** Something a test holds until it lets it go. */
function held() {
	let give!: () => void;
	const turn = new Promise<void>((resolve) => {
		give = resolve;
	});
	return { turn, give };
}

/** The kernel's three calls, the code hosts' jobs, the code host's own jobs and the record's files, as stand-ins a test
 * changes. `order` is what happened, in order. */
function setup(options: Partial<CodeHostRequestsOptions> = {}) {
	const calls: { method: string; args: Record<string, unknown> }[] = [];
	const order: string[] = [];
	const kernel = {
		/** What the next claims hand out, a batch a claim. */
		claims: [] as unknown[][],
		/** A test's own answer for a call, by its method; undefined leaves the usual one. */
		answer: undefined as ((method: string, args: Record<string, unknown>) => unknown) | undefined,
		async call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
			signal.throwIfAborted();
			calls.push({ method, args: structuredClone(args) });
			order.push(
				method.replace("qorpera_code_request", "").replace("qorpera_code_restore_", "").replace(/^s?_/, ""),
			);
			const forced = await kernel.answer?.(method, args);
			if (forced !== undefined) return forced;
			if (method === "qorpera_code_requests_claim")
				return { schema: "qorpera.code-requests/v1", requests: kernel.claims.shift() ?? [] };
			if (method === "qorpera_code_request_step")
				return { schema: STEP, state: "go", leaseUntil: "2026-11-10T12:35:00+00:00" };
			if (method === "qorpera_code_request_finish") return { schema: FINISH, state: "recorded", change: 15 };
			// Every session named was archived: none was at work.
			if (method === "qorpera_code_restore_strand")
				return { schema: STRAND, state: "done", archived: (args.p_stranded as unknown[]).length, active: 0 };
			throw new Error(`not a request call: ${method}`);
		},
	};
	const runs: { companyId: string; environmentId: string; options: CodeHostJobOptions | undefined }[] = [];
	const host = {
		/** What a job's save does, after its steps: a test makes it fail. */
		save: undefined as (() => void) | undefined,
	};
	const hosts: Pick<CodeHostJobs, "run"> = {
		async run<T>(
			companyId: string,
			environmentId: string,
			signal: AbortSignal,
			job: (job: CodeHostJob, gc: CodeHostGcBlock) => Promise<T>,
			jobOptions?: CodeHostJobOptions,
		): Promise<T> {
			runs.push({ companyId, environmentId, options: jobOptions });
			signal.throwIfAborted();
			order.push("job");
			const result = await job({ shell: SHELL, layout: CODE_HOST_LAYOUT, signal }, BLOCK);
			host.save?.();
			order.push("saved");
			return result;
		},
	};
	const jobs = {
		undo: vi.fn<CodeRequestJobs["undo"]>(async () => {
			order.push("undo");
			return { state: "undone", mainBefore: MAIN, mainAfter: UNDONE, diff: DIFF, replayed: false };
		}),
		archive: vi.fn<CodeRequestJobs["archive"]>(async () => {
			order.push("archive");
			return { ...MADE };
		}),
		removeDownloads: vi.fn<CodeRequestJobs["removeDownloads"]>(async (_job, value) => {
			order.push("remove");
			return { removed: [...value.fileNames] };
		}),
	};
	const confirm = vi.fn(async () => {
		order.push("confirm");
	});
	const inJob = vi.fn<CodeHostRequestsOptions["records"]["inJob"]>(async () => {
		order.push("records");
		return confirm;
	});
	const events: Record<string, unknown>[] = [];
	const requests = new CodeHostRequests({
		control: kernel,
		hosts,
		jobs,
		records: { inJob },
		owner: OWNER,
		machineIdSha256: MACHINE,
		report: (event) => events.push(event),
		...options,
	});
	return {
		requests,
		kernel,
		calls,
		order,
		runs,
		host,
		jobs,
		inJob,
		confirm,
		events,
		pass: () => requests.pass(new AbortController().signal),
		/** One pass, then everything that ran on beside it, and what the two passes after counted together. */
		async whole() {
			const first = await requests.pass(new AbortController().signal);
			await requests.settled();
			const after = await requests.pass(new AbortController().signal);
			return {
				done: first.done + after.done,
				refused: first.refused + after.refused,
				failed: first.failed + after.failed,
				busy: first.busy + after.busy,
			};
		},
		finishes: () => calls.filter((call) => call.method === "qorpera_code_request_finish"),
		errors: () =>
			events
				.filter((event) => event.event === "code-request-error")
				.map((event) => `${event.step}:${(event.error as Error).message}`),
		finished: () => events.filter((event) => event.event === "code-request"),
	};
}
const NONE = { done: 0, refused: 0, failed: 0, busy: 0 };

describe("CodeHostRequests", () => {
	it("names the control's RPCs", () => {
		expect(CODE_REQUEST_RPCS).toEqual([
			"qorpera_code_requests_claim",
			"qorpera_code_request_step",
			"qorpera_code_request_finish",
			"qorpera_code_restore_record",
			"qorpera_code_restore_strand",
			"qorpera_code_import_looked",
			"qorpera_code_import_record",
		]);
	});

	it("refuses options that are not a loop's", () => {
		const t = setup();
		const make = (extra: Record<string, unknown>) => () =>
			new CodeHostRequests({
				control: t.kernel,
				hosts: { run: async () => undefined as never },
				jobs: t.jobs,
				records: { inJob: t.inJob },
				owner: OWNER,
				machineIdSha256: MACHINE,
				...extra,
			});
		for (const extra of [{ owner: "" }, { machineIdSha256: "x" }, { limit: 0 }, { limit: 21 }, { recordMs: 0 }])
			expect(make(extra)).toThrow("INVALID_CODE_HOST_REQUESTS");
		expect(make({ limit: 20, recordMs: 1 })).not.toThrow();
	});

	it("claims nothing and does nothing when no request waits", async () => {
		const t = setup();
		await expect(t.pass()).resolves.toEqual(NONE);
		expect(t.calls).toEqual([
			{ method: "qorpera_code_requests_claim", args: { ...WHO, p_limit: 10, p_kinds: KINDS } },
		]);
		expect(t.runs).toEqual([]);
		expect(t.events).toEqual([]);
	});

	describe("undo", () => {
		const undone = {
			schema: SCHEMA,
			state: "done",
			result: "undone",
			mainBefore: MAIN,
			mainAfter: UNDONE,
			filesChanged: 2,
			paths: DIFF.paths,
			pathsMore: 0,
		};

		it("makes the undo in a job that does not yield, finishes it inside the job, writes the record's files there and confirms them after the save", async () => {
			const t = setup();
			t.kernel.claims = [[UNDO]];
			await expect(t.pass()).resolves.toEqual({ ...NONE, done: 1 });
			// In the company's line, as a landing is: never a job that gives way.
			expect(t.runs).toEqual([{ companyId: COMPANY, environmentId: ENVIRONMENT, options: undefined }]);
			// The finish is made while the line is held, so the kernel writes the undo's row in main's order; then the files.
			expect(t.order).toEqual(["claim", "job", "undo", "finish", "records", "saved", "confirm"]);
			expect(t.jobs.undo.mock.calls[0]?.[1]).toEqual({
				repository: REPOSITORY,
				requestId: R1,
				change: { n: 12, mainBefore: BEFORE, mainAfter: AFTER },
				andLater: false,
				message: "Undo change 12: A banner on the front page",
			});
			expect(t.finishes()).toEqual([finishOf(R1, T1, undone)]);
			expect(Object.keys(t.finishes()[0]?.args.p_outcome as object)).toEqual([
				"schema",
				"state",
				"result",
				"mainBefore",
				"mainAfter",
				"filesChanged",
				"paths",
				"pathsMore",
			]);
			// The record's files, for this repository, with the job's own shell and a signal that ends with the record's time.
			expect(t.inJob).toHaveBeenCalledTimes(1);
			const [job, target, signal] = t.inJob.mock.calls[0] ?? [];
			expect(job?.shell).toBe(SHELL);
			expect(job?.layout).toBe(CODE_HOST_LAYOUT);
			expect(job?.signal).toBe(signal);
			expect(target).toEqual(TARGET);
			expect(t.events).toEqual([
				{
					event: "code-request",
					step: "finished",
					requestId: R1,
					kind: "undo",
					companyId: COMPANY,
					environmentId: ENVIRONMENT,
					repository: "qorpera/shop",
					state: "done",
					result: "undone",
					recorded: true,
				},
			]);
		});

		it("takes the change and every later one out when asked, and says so when main held nothing of it", async () => {
			const t = setup();
			t.kernel.claims = [[{ ...UNDO, andLater: true, message: "Go back to before change 12" }]];
			t.jobs.undo.mockResolvedValueOnce({ state: "nothing", mainSha: MAIN });
			await expect(t.pass()).resolves.toEqual({ ...NONE, done: 1 });
			expect(t.jobs.undo.mock.calls[0]?.[1]).toMatchObject({
				andLater: true,
				message: "Go back to before change 12",
			});
			expect(t.finishes()).toEqual([
				finishOf(R1, T1, { schema: SCHEMA, state: "done", result: "nothing", mainSha: MAIN }),
			]);
			// Nothing moved: no row, so no files.
			expect(t.inJob).not.toHaveBeenCalled();
			expect(t.order).toEqual(["claim", "job", "finish", "saved"]);
		});

		it("finishes a refusal after the job, with its code and the files it named, and anything else as a failure with its code", async () => {
			const cases: [unknown, unknown, "refused" | "failed", string[]][] = [
				[
					new CodeHostRefusal("CODE_HOST_UNDO_CONFLICT", ["src/a.ts", "src/b.ts"]),
					{ schema: SCHEMA, state: "refused", code: "CODE_HOST_UNDO_CONFLICT", paths: ["src/a.ts", "src/b.ts"] },
					"refused",
					[],
				],
				[
					new CodeHostRefusal("CODE_HOST_UNDO_NOT_IN_MAIN"),
					{ schema: SCHEMA, state: "refused", code: "CODE_HOST_UNDO_NOT_IN_MAIN", paths: [] },
					"refused",
					[],
				],
				[
					new CodeHostRefusal("CODE_HOST_NAMES_DIFFER_BY_CASE", ["a.ts", "A.ts"]),
					{ schema: SCHEMA, state: "refused", code: "CODE_HOST_NAMES_DIFFER_BY_CASE", paths: ["a.ts", "A.ts"] },
					"refused",
					[],
				],
				// A commit that is not in the repository any more: a refusal too, which names no file.
				[
					new CodeHostRefusal("CODE_HOST_UNDO_UNKNOWN_COMMIT", [BEFORE]),
					{ schema: SCHEMA, state: "refused", code: "CODE_HOST_UNDO_UNKNOWN_COMMIT", paths: [] },
					"refused",
					[],
				],
				// A refusal that is not the undo's own, and anything else: a failure.
				[
					new CodeHostRefusal("CODE_HOST_NOT_SEEDED", ["code/qorpera/shop"]),
					{ schema: SCHEMA, state: "failed", code: "CODE_HOST_NOT_SEEDED" },
					"failed",
					["job:CODE_HOST_NOT_SEEDED: code/qorpera/shop"],
				],
				[
					new CodeHostJobFailure("CODE_HOST_VIEW_UNAVAILABLE", "fetch failed"),
					{ schema: SCHEMA, state: "failed", code: "CODE_HOST_VIEW_UNAVAILABLE" },
					"failed",
					["job:CODE_HOST_VIEW_UNAVAILABLE: fetch failed"],
				],
				[
					new Error("something else"),
					{ schema: SCHEMA, state: "failed", code: "UNCLASSIFIED" },
					"failed",
					["job:something else"],
				],
			];
			for (const [error, outcome, ended, errors] of cases) {
				const t = setup();
				t.kernel.claims = [[UNDO]];
				t.jobs.undo.mockRejectedValueOnce(error);
				await expect(t.pass()).resolves.toEqual({ ...NONE, [ended]: 1 });
				expect(t.finishes()).toEqual([finishOf(R1, T1, outcome)]);
				expect(t.order).toEqual(["claim", "job", "finish"]);
				expect(t.inJob).not.toHaveBeenCalled();
				expect(t.errors()).toEqual(errors);
			}
			// A refusal names at most twenty files to the kernel.
			const t = setup();
			t.kernel.claims = [[UNDO]];
			const many = Array.from({ length: 30 }, (_, at) => `src/${at}.ts`);
			t.jobs.undo.mockRejectedValueOnce(new CodeHostRefusal("CODE_HOST_UNDO_CONFLICT", many));
			await t.pass();
			expect((t.finishes()[0]?.args.p_outcome as { paths: string[] }).paths).toEqual(many.slice(0, 20));
		});

		it("makes an undo that lost main to a landing once more, and no more than that", async () => {
			const moved = () => new CodeHostJobFailure("CODE_HOST_BASE_MOVED", "main moved");
			const once = setup();
			once.kernel.claims = [[UNDO]];
			once.jobs.undo.mockRejectedValueOnce(moved());
			await expect(once.pass()).resolves.toEqual({ ...NONE, done: 1 });
			expect(once.jobs.undo).toHaveBeenCalledTimes(2);
			expect(once.runs).toHaveLength(2);
			expect(once.finishes()).toEqual([finishOf(R1, T1, undone)]);
			const twice = setup();
			twice.kernel.claims = [[UNDO]];
			twice.jobs.undo.mockRejectedValueOnce(moved()).mockRejectedValueOnce(moved());
			await expect(twice.pass()).resolves.toEqual({ ...NONE, failed: 1 });
			expect(twice.jobs.undo).toHaveBeenCalledTimes(2);
			expect(twice.finishes()).toEqual([
				finishOf(R1, T1, { schema: SCHEMA, state: "failed", code: "CODE_HOST_BASE_MOVED" }),
			]);
		});

		it("makes a finish the kernel did not take inside the job again after it, and writes no files for a row it has not heard of", async () => {
			const t = setup();
			t.kernel.claims = [[UNDO]];
			let asked = 0;
			t.kernel.answer = (method) => {
				if (method !== "qorpera_code_request_finish") return undefined;
				asked += 1;
				if (asked === 1) throw new Error("CODING_CONTROL_UNCONFIRMED");
				return undefined;
			};
			await expect(t.pass()).resolves.toEqual({ ...NONE, done: 1 });
			// The job saved main all the same; the second finish comes once it has.
			expect(t.order).toEqual(["claim", "job", "undo", "finish", "saved", "finish"]);
			expect(t.finishes()).toEqual([finishOf(R1, T1, undone), finishOf(R1, T1, undone)]);
			expect(t.inJob).not.toHaveBeenCalled();
			expect(t.errors()).toEqual(["finish:CODING_CONTROL_UNCONFIRMED"]);

			// Never heard: asked once in the job and twice after it, then left to the request's lease.
			const never = setup();
			never.kernel.claims = [[UNDO]];
			never.kernel.answer = (method) => {
				if (method === "qorpera_code_request_finish") throw new Error("CODING_CONTROL_UNCONFIRMED");
				return undefined;
			};
			await expect(never.pass()).resolves.toEqual({ ...NONE, failed: 1 });
			expect(never.finishes()).toHaveLength(3);
			expect(never.order.at(-3)).toBe("saved");
			expect(never.finished()).toEqual([
				expect.objectContaining({ state: "done", result: "undone", recorded: false }),
			]);

			// The lease was another's: nothing was recorded, and no files are written for it.
			const lost = setup();
			lost.kernel.claims = [[UNDO]];
			lost.kernel.answer = (method) =>
				method === "qorpera_code_request_finish" ? { schema: FINISH, state: "lost" } : undefined;
			await expect(lost.pass()).resolves.toEqual({ ...NONE, failed: 1 });
			expect(lost.finishes()).toHaveLength(1);
			expect(lost.inJob).not.toHaveBeenCalled();
			expect(lost.errors()).toEqual(["finish:CODE_REQUEST_FINISH_LOST"]);
		});

		it("lets nothing of the record fail an undo or hold its job past the record's time", async () => {
			// The record's files fail, in the job and at their confirmation.
			const files = setup();
			files.kernel.claims = [[UNDO], [UNDO]];
			files.inJob.mockRejectedValueOnce(new Error("CODE_HOST_WRITE_FAILED"));
			await expect(files.pass()).resolves.toEqual({ ...NONE, done: 1 });
			expect(files.confirm).not.toHaveBeenCalled();
			files.confirm.mockRejectedValueOnce(new Error("CODING_CONTROL_UNCONFIRMED"));
			await expect(files.pass()).resolves.toEqual({ ...NONE, done: 1 });
			expect(files.errors()).toEqual(["record:CODE_HOST_WRITE_FAILED", "files:CODING_CONTROL_UNCONFIRMED"]);

			// A finish that never answers, from a control that does not heed its signal: the job goes on at the end of the
			// record's time and saves main; the finish is asked again after it.
			const slow = setup({ recordMs: 30 });
			slow.kernel.claims = [[UNDO]];
			let asked = 0;
			slow.kernel.answer = (method) => {
				if (method !== "qorpera_code_request_finish") return undefined;
				asked += 1;
				return asked === 1 ? new Promise(() => undefined) : undefined;
			};
			await expect(slow.pass()).resolves.toEqual({ ...NONE, done: 1 });
			expect(slow.order).toEqual(["claim", "job", "undo", "finish", "saved", "finish"]);
			expect(slow.inJob).not.toHaveBeenCalled();

			// An answer of the job that is no undo's is not finished as one.
			const odd = setup();
			odd.kernel.claims = [[UNDO]];
			odd.jobs.undo.mockResolvedValueOnce({ state: "undone", mainBefore: "main", mainAfter: UNDONE } as never);
			await expect(odd.pass()).resolves.toEqual({ ...NONE, failed: 1 });
			expect(odd.finishes()).toEqual([
				finishOf(R1, T1, { schema: SCHEMA, state: "failed", code: "CODE_REQUEST_ANSWER_INVALID" }),
			]);
		});

		it("finishes an undo whose job failed after main moved as undone, and confirms no files that were not saved", async () => {
			const t = setup();
			t.kernel.claims = [[UNDO]];
			t.host.save = () => {
				throw new CodeHostJobFailure("CODE_HOST_PUBLISH_REFUSED", "code/qorpera/shop/main/a.ts: refused");
			};
			await expect(t.pass()).resolves.toEqual({ ...NONE, done: 1 });
			expect(t.finishes()).toEqual([finishOf(R1, T1, undone)]);
			expect(t.inJob).toHaveBeenCalledTimes(1);
			expect(t.confirm).not.toHaveBeenCalled();
			expect(t.errors()).toEqual(["job:CODE_HOST_PUBLISH_REFUSED: code/qorpera/shop/main/a.ts: refused"]);
		});
	});

	describe("download", () => {
		const made = { schema: SCHEMA, state: "done", result: "made", ...MADE };

		it("makes the file in a job that yields, after asking the kernel, finishes after the save, and runs on beside the passes", async () => {
			const t = setup();
			t.kernel.claims = [[DOWNLOAD]];
			const making = held();
			t.jobs.archive.mockImplementationOnce(async () => {
				t.order.push("archive");
				await making.turn;
				return { ...MADE };
			});
			// The pass that claimed it does not wait for it.
			await expect(t.pass()).resolves.toEqual(NONE);
			expect(t.order).toEqual(["claim", "job", "step", "archive"]);
			await expect(t.pass()).resolves.toEqual(NONE);
			making.give();
			await t.requests.settled();
			expect(t.order).toEqual(["claim", "job", "step", "archive", "claim", "saved", "finish"]);
			// What it came to is counted in the next pass.
			await expect(t.pass()).resolves.toEqual({ ...NONE, done: 1 });
			await expect(t.pass()).resolves.toEqual(NONE);
			expect(t.runs).toEqual([{ companyId: COMPANY, environmentId: ENVIRONMENT, options: { yields: true } }]);
			expect(t.calls[1]).toEqual({
				method: "qorpera_code_request_step",
				args: { ...WHO, p_request_id: R2, p_token: T2, p_progress: null },
			});
			expect(t.jobs.archive.mock.calls[0]?.slice(1)).toEqual([
				{ repository: REPOSITORY, file: "files", fileName: "shop-2026-11-10.zip" },
			]);
			expect(t.finishes()).toEqual([finishOf(R2, T2, made)]);
			expect(t.finished()).toEqual([
				expect.objectContaining({ requestId: R2, kind: "download", state: "done", result: "made", recorded: true }),
			]);
			// The history, for a developer, is the same job with another file.
			const history = setup();
			const path = "code/qorpera/shop/downloads/shop-2026-11-10.bundle";
			history.kernel.claims = [[{ ...DOWNLOAD, file: "history", fileName: "shop-2026-11-10.bundle", path }]];
			history.jobs.archive.mockResolvedValueOnce({ ...MADE, path });
			await expect(history.whole()).resolves.toEqual({ ...NONE, done: 1 });
			expect(history.jobs.archive.mock.calls[0]?.[1]).toEqual({
				repository: REPOSITORY,
				file: "history",
				fileName: "shop-2026-11-10.bundle",
			});
		});

		it("puts a download off when its job gives way to a turn's, when the kernel says so or when its rows are busy", async () => {
			const busy = { schema: SCHEMA, state: "busy" };
			const gaveWay = setup();
			gaveWay.kernel.claims = [[DOWNLOAD]];
			gaveWay.jobs.archive.mockRejectedValueOnce(yielded());
			await expect(gaveWay.whole()).resolves.toEqual({ ...NONE, busy: 1 });
			expect(gaveWay.finishes()).toEqual([finishOf(R2, T2, busy)]);
			expect(gaveWay.errors()).toEqual([]);

			const told = setup();
			told.kernel.claims = [[DOWNLOAD]];
			told.kernel.answer = (method) =>
				method === "qorpera_code_request_step" ? { schema: STEP, state: "busy" } : undefined;
			await expect(told.whole()).resolves.toEqual({ ...NONE, busy: 1 });
			expect(told.jobs.archive).not.toHaveBeenCalled();
			expect(told.finishes()).toEqual([finishOf(R2, T2, busy)]);

			const rows = setup();
			rows.kernel.claims = [[DOWNLOAD]];
			rows.kernel.answer = (method) => {
				if (method === "qorpera_code_request_step") throw new CodingControlBusy();
				return undefined;
			};
			await expect(rows.whole()).resolves.toEqual({ ...NONE, busy: 1 });
			expect(rows.jobs.archive).not.toHaveBeenCalled();

			// A lease that is another's by now is nobody's to finish here.
			const lost = setup();
			lost.kernel.claims = [[DOWNLOAD]];
			lost.kernel.answer = (method) =>
				method === "qorpera_code_request_step" ? { schema: STEP, state: "lost" } : undefined;
			await expect(lost.whole()).resolves.toEqual({ ...NONE, failed: 1 });
			expect(lost.jobs.archive).not.toHaveBeenCalled();
			expect(lost.finishes()).toEqual([]);
			expect(lost.errors()).toEqual(["step:CODE_REQUEST_LEASE_LOST"]);
		});

		it("refuses code that is too large in plain terms, and fails a job that failed with its code", async () => {
			const large = setup();
			large.kernel.claims = [[DOWNLOAD]];
			large.jobs.archive.mockRejectedValueOnce(new CodeHostRefusal("CODE_HOST_DOWNLOAD_TOO_LARGE"));
			await expect(large.whole()).resolves.toEqual({ ...NONE, refused: 1 });
			expect(large.finishes()).toEqual([
				finishOf(R2, T2, { schema: SCHEMA, state: "refused", code: "CODE_HOST_DOWNLOAD_TOO_LARGE" }),
			]);
			expect(large.errors()).toEqual([]);

			const failed = setup();
			failed.kernel.claims = [[DOWNLOAD]];
			failed.jobs.archive.mockRejectedValueOnce(new CodeHostJobFailure("CODE_HOST_ARCHIVE_FAILED", "No space left"));
			await expect(failed.whole()).resolves.toEqual({ ...NONE, failed: 1 });
			expect(failed.finishes()).toEqual([
				finishOf(R2, T2, { schema: SCHEMA, state: "failed", code: "CODE_HOST_ARCHIVE_FAILED" }),
			]);
			expect(failed.errors()).toEqual(["job:CODE_HOST_ARCHIVE_FAILED: No space left"]);

			// A file that is not the one the request names, or no file at all, is not said to be ready.
			for (const answer of [
				{ ...MADE, path: "code/qorpera/shop/downloads/other.zip" },
				{ ...MADE, sha256: "f".repeat(40) },
				{ ...MADE, bytes: -1 },
				{ ...MADE, mainSha: "main" },
			]) {
				const odd = setup();
				odd.kernel.claims = [[DOWNLOAD]];
				odd.jobs.archive.mockResolvedValueOnce(answer);
				await expect(odd.whole()).resolves.toEqual({ ...NONE, failed: 1 });
				expect(odd.finishes()).toEqual([
					finishOf(R2, T2, { schema: SCHEMA, state: "failed", code: "CODE_REQUEST_ANSWER_INVALID" }),
				]);
			}
			// A finish the kernel did not take is asked once more, and then left to the request's lease.
			const unheard = setup();
			unheard.kernel.claims = [[DOWNLOAD]];
			unheard.kernel.answer = (method) => {
				if (method === "qorpera_code_request_finish") throw new Error("CODING_CONTROL_UNCONFIRMED");
				return undefined;
			};
			await expect(unheard.whole()).resolves.toEqual({ ...NONE, failed: 1 });
			expect(unheard.finishes()).toHaveLength(2);
			expect(unheard.errors()).toEqual(["finish:CODING_CONTROL_UNCONFIRMED"]);
		});

		it("removes a file that is past its time, in a job that yields", async () => {
			const t = setup();
			t.kernel.claims = [[{ ...DOWNLOAD, work: "remove" }]];
			await expect(t.whole()).resolves.toEqual({ ...NONE, done: 1 });
			expect(t.runs).toEqual([{ companyId: COMPANY, environmentId: ENVIRONMENT, options: { yields: true } }]);
			expect(t.order.slice(0, 6)).toEqual(["claim", "job", "step", "remove", "saved", "finish"]);
			expect(t.jobs.removeDownloads.mock.calls[0]?.[1]).toEqual({
				repository: REPOSITORY,
				fileNames: ["shop-2026-11-10.zip"],
			});
			expect(t.jobs.archive).not.toHaveBeenCalled();
			expect(t.finishes()).toEqual([finishOf(R2, T2, { schema: SCHEMA, state: "done", result: "removed" })]);
		});
	});

	describe("restore", () => {
		it("finishes a restore as not built when it was given none", async () => {
			const t = setup();
			t.kernel.claims = [[RESTORE]];
			await expect(t.whole()).resolves.toEqual({ ...NONE, failed: 1 });
			expect(t.runs).toEqual([]);
			expect(t.finishes()).toEqual([finishOf(R3, T3, { schema: SCHEMA, state: "failed", code: "NOT_BUILT" })]);
		});

		it("hands a restore to the one it was given, as the kernel handed it out, and finishes what it came to", async () => {
			const seen: CodeRestoreRequest[] = [];
			const outcome: CodeRequestOutcome = {
				schema: SCHEMA,
				state: "done",
				result: "verified",
				mainSha: MAIN,
				refsSha256: "9".repeat(64),
				refs: 4,
			};
			const t = setup({
				restore: {
					run: async (request) => {
						seen.push(request);
						return outcome;
					},
				},
			});
			t.kernel.claims = [[{ ...RESTORE, mode: "verify", bundle: "20261109T021455Z-aaaaaaaaaaaa" }]];
			await expect(t.whole()).resolves.toEqual({ ...NONE, done: 1 });
			expect(seen).toEqual([
				{
					requestId: R3,
					token: T3,
					...WHERE,
					kind: "restore",
					mode: "verify",
					bundle: "20261109T021455Z-aaaaaaaaaaaa",
					damaged: "keep",
					progress: null,
					path: null,
					sessions: [{ workerId: R1, baseSha: BEFORE }],
				},
			]);
			expect(t.finishes()).toEqual([finishOf(R3, T3, outcome)]);

			// One that throws is finished failed with its code; one that answers nothing of an outcome, the same.
			const thrown = setup({
				restore: {
					run: async () => {
						throw new CodeHostJobFailure("CODE_HOST_RESTORE_BUNDLE_DIFFERS", "sha256");
					},
				},
			});
			thrown.kernel.claims = [[RESTORE]];
			await expect(thrown.whole()).resolves.toEqual({ ...NONE, failed: 1 });
			expect(thrown.finishes()).toEqual([
				finishOf(R3, T3, { schema: SCHEMA, state: "failed", code: "CODE_HOST_RESTORE_BUNDLE_DIFFERS" }),
			]);
			const odd = setup({ restore: { run: async () => ({ state: "restored" }) as never } });
			odd.kernel.claims = [[RESTORE]];
			await expect(odd.whole()).resolves.toEqual({ ...NONE, failed: 1 });
			expect(odd.finishes()).toEqual([
				finishOf(R3, T3, { schema: SCHEMA, state: "failed", code: "CODE_REQUEST_ANSWER_INVALID" }),
			]);
		});

		describe("the sessions a restore stranded", () => {
			const session = (at: number) => `cccccccc-0000-4000-8000-${String(at).padStart(12, "0")}`;
			const S1 = session(1);
			const S2 = session(2);
			const restored = (stranded: unknown[]): CodeRequestOutcome =>
				({
					schema: SCHEMA,
					state: "done",
					result: "restored",
					bundle: "20261109T021455Z-aaaaaaaaaaaa",
					mainSha: MAIN,
					previousMainSha: AFTER,
					refsSha256: "9".repeat(64),
					refs: 4,
					stranded,
					movedTo: "code/_set-aside/qorpera/at-20261110T120000Z/shop",
				}) as CodeRequestOutcome;
			const strandOf = (ids: string[]) => ({
				method: "qorpera_code_restore_strand",
				args: { ...WHO, p_request_id: R3, p_stranded: ids },
			});
			/** A restore that answers `outcome`, after it said so in `order`. */
			function restoring(outcome: CodeRequestOutcome, options: Partial<CodeHostRequestsOptions> = {}) {
				const t = setup({
					restore: {
						run: async () => {
							t.order.push("restore");
							return outcome;
						},
					},
					...options,
				});
				t.kernel.claims = [[RESTORE]];
				return t;
			}
			const strands = (t: ReturnType<typeof setup>) =>
				t.calls.filter((call) => call.method === "qorpera_code_restore_strand");
			const said = (t: ReturnType<typeof setup>) => t.events.filter((event) => event.step === "stranded");

			it("archives them before the restore's finish, and once more after it the ones a session was at work in", async () => {
				const outcome = restored([S1, S2]);
				const t = restoring(outcome);
				let asked = 0;
				t.kernel.answer = (method) => {
					if (method !== "qorpera_code_restore_strand") return undefined;
					asked += 1;
					// A turn began in one of them after the open: it is counted and left, and asked for again after the finish.
					return { schema: STRAND, state: "done", archived: 1, active: asked === 1 ? 1 : 0 };
				};
				const lasting = new AbortController();
				const watch = watchAbortSignalAny();
				try {
					await expect(t.requests.pass(lasting.signal)).resolves.toEqual(NONE);
					await t.requests.settled();
					await expect(t.requests.pass(lasting.signal)).resolves.toEqual({ ...NONE, done: 1 });
					expect(watch.on(lasting.signal)).toBe(0);
				} finally {
					watch.restore();
				}
				expect(t.order).toEqual(["claim", "restore", "strand", "finish", "strand", "claim"]);
				expect(strands(t)).toEqual([strandOf([S1, S2]), strandOf([S1, S2])]);
				// The finish is the restore's own outcome, whatever the calls around it said.
				expect(t.finishes()).toEqual([finishOf(R3, T3, outcome)]);
				const where = {
					requestId: R3,
					kind: "restore",
					companyId: COMPANY,
					environmentId: ENVIRONMENT,
					repository: "qorpera/shop",
				};
				expect(said(t)).toEqual([
					{ event: "code-request", step: "stranded", ...where, at: "before", sessions: 2, archived: 1, active: 1 },
					{ event: "code-request", step: "stranded", ...where, at: "after", sessions: 2, archived: 1, active: 0 },
				]);
				expect(t.finished().filter((event) => event.step === "finished")).toEqual([
					expect.objectContaining({ result: "restored", recorded: true }),
				]);
				expect(t.errors()).toEqual([]);

				// Every one archived before the finish: nothing is left to ask for after it.
				const all = restoring(outcome);
				await expect(all.whole()).resolves.toEqual({ ...NONE, done: 1 });
				expect(all.order).toEqual(["claim", "restore", "strand", "finish", "claim"]);
				expect(strands(all)).toEqual([strandOf([S1, S2])]);
			});

			it("names at most 200 a call, each session once, and asks again after the finish only for a call that left some", async () => {
				const ids = Array.from({ length: 450 }, (_, at) => session(at + 1));
				// The restore's list as the kernel's outcome might carry it: a session twice, and what is no session.
				const t = restoring(restored([...ids, ids[0], "not-a-session", 7, null]));
				let asked = 0;
				t.kernel.answer = (method, args) => {
					if (method !== "qorpera_code_restore_strand") return undefined;
					asked += 1;
					const named = (args.p_stranded as unknown[]).length;
					// Before the finish: the second call is not heard, the third finds a session at work.
					if (asked === 2) throw new Error("CODING_CONTROL_UNCONFIRMED");
					return {
						schema: STRAND,
						state: "done",
						archived: asked === 3 ? named - 1 : named,
						active: asked === 3 ? 1 : 0,
					};
				};
				await expect(t.whole()).resolves.toEqual({ ...NONE, done: 1 });
				expect(t.order).toEqual([
					"claim",
					"restore",
					"strand",
					"strand",
					"strand",
					"finish",
					"strand",
					"strand",
					"claim",
				]);
				expect(strands(t)).toEqual([
					strandOf(ids.slice(0, 200)),
					strandOf(ids.slice(200, 400)),
					strandOf(ids.slice(400)),
					// After it: what the two calls that left some named, in calls of at most 200 again.
					strandOf(ids.slice(200, 400)),
					strandOf(ids.slice(400)),
				]);
				expect(t.errors()).toEqual(["strand:CODING_CONTROL_UNCONFIRMED"]);
				expect(t.events.find((event) => event.step === "strand")).toMatchObject({ at: "before", requestId: R3 });
			});

			it("never fails a restore, nor holds its finish up, for a call that failed, was lost, was not understood or never answered", async () => {
				const outcome = restored([S1]);
				const cases: [string, () => unknown, string[], number][] = [
					[
						"not heard",
						() => {
							throw new Error("CODING_CONTROL_UNCONFIRMED");
						},
						["strand:CODING_CONTROL_UNCONFIRMED", "strand:CODING_CONTROL_UNCONFIRMED"],
						2,
					],
					[
						"rows busy",
						() => {
							throw new CodingControlBusy();
						},
						["strand:CODING_CONTROL_BUSY", "strand:CODING_CONTROL_BUSY"],
						2,
					],
					[
						"no counts",
						() => ({ schema: STRAND, state: "done" }),
						["strand:CODE_RESTORE_STRAND_UNCONFIRMED", "strand:CODE_RESTORE_STRAND_UNCONFIRMED"],
						2,
					],
					[
						"no schema",
						() => ({ state: "done", archived: 1, active: 0 }),
						["strand:CODE_RESTORE_STRAND_UNCONFIRMED", "strand:CODE_RESTORE_STRAND_UNCONFIRMED"],
						2,
					],
					[
						"another state",
						() => ({ schema: STRAND, state: "archived", archived: 1, active: 0 }),
						["strand:CODE_RESTORE_STRAND_UNCONFIRMED", "strand:CODE_RESTORE_STRAND_UNCONFIRMED"],
						2,
					],
					// Not this executor's, or a restore the kernel has not recorded: asking again would change nothing.
					["lost", () => ({ schema: STRAND, state: "lost" }), ["strand:CODE_RESTORE_STRAND_LOST"], 1],
					[
						"never answers, nor heeds its signal",
						() => new Promise(() => undefined),
						["strand:TIMEOUT", "strand:TIMEOUT"],
						2,
					],
				];
				for (const [what, answer, errors, asked] of cases) {
					const t = restoring(outcome, { strandMs: 30 });
					t.kernel.answer = (method) => (method === "qorpera_code_restore_strand" ? answer() : undefined);
					await expect(t.whole(), what).resolves.toEqual({ ...NONE, done: 1 });
					expect(t.finishes(), what).toEqual([finishOf(R3, T3, outcome)]);
					expect(strands(t), what).toHaveLength(asked);
					expect(t.order.indexOf("finish"), what).toBe(3);
					expect(
						t.errors().map((error) => (error.includes("timeout") ? "strand:TIMEOUT" : error)),
						what,
					).toEqual(errors);
					expect(said(t), what).toEqual([]);
				}
			});

			it("asks nothing for any other outcome, nor for a restore that stranded no session", async () => {
				for (const outcome of [
					{
						schema: SCHEMA,
						state: "done",
						result: "verified",
						mainSha: MAIN,
						refsSha256: "9".repeat(64),
						refs: 4,
					},
					{ schema: SCHEMA, state: "done", result: "discarded" },
					{ schema: SCHEMA, state: "busy" },
					{ schema: SCHEMA, state: "failed", code: "CODE_HOST_RESTORE_BUNDLE_DIFFERS" },
					{ schema: SCHEMA, state: "refused", code: "CODE_HOST_RESTORE_IN_PROGRESS" },
					// Sessions named by an outcome that put nothing back are not a restore's.
					{ schema: SCHEMA, state: "busy", stranded: [S1] },
					{ schema: SCHEMA, state: "done", result: "discarded", stranded: [S1] },
					restored([]),
					restored(["not-a-session", 7]),
					{ ...restored([S1]), stranded: undefined },
				] as CodeRequestOutcome[]) {
					const t = restoring(outcome);
					await t.whole();
					expect(strands(t), JSON.stringify(outcome)).toEqual([]);
					expect(t.finishes()).toEqual([finishOf(R3, T3, outcome)]);
				}
				// An undo and a download never ask it.
				const t = setup();
				t.kernel.claims = [[UNDO, DOWNLOAD]];
				await expect(t.whole()).resolves.toEqual({ ...NONE, done: 2 });
				expect(strands(t)).toEqual([]);
			});

			it("asks nothing once the executor is stopping: the finish keeps its few seconds", async () => {
				const outcome = restored([S1, S2]);
				const stopped = new AbortController();
				const t = setup({
					restore: {
						run: async () => {
							stopped.abort(new Error("CODING_EXECUTOR_SHUTDOWN"));
							return outcome;
						},
					},
				});
				t.kernel.claims = [[RESTORE]];
				await t.requests.pass(stopped.signal);
				await t.requests.settled();
				expect(strands(t)).toEqual([]);
				expect(t.finishes()).toEqual([finishOf(R3, T3, outcome)]);
				expect(t.errors()).toEqual([]);
				// Stopped during the call before the finish: none after it either.
				const during = new AbortController();
				const later = restoring(outcome);
				later.kernel.answer = (method) => {
					if (method !== "qorpera_code_restore_strand") return undefined;
					during.abort(new Error("CODING_EXECUTOR_SHUTDOWN"));
					return new Promise(() => undefined);
				};
				await later.requests.pass(during.signal);
				await later.requests.settled();
				expect(strands(later)).toHaveLength(1);
				expect(later.finishes()).toEqual([finishOf(R3, T3, outcome)]);
				expect(later.errors()).toEqual([]);
			});

			it("refuses a strand time that is not one", () => {
				for (const strandMs of [0, -1, 1.5])
					expect(() => setup({ strandMs })).toThrow("INVALID_CODE_HOST_REQUESTS");
				expect(() => setup({ strandMs: 1 })).not.toThrow();
			});
		});
	});

	describe("import", () => {
		const COMPANY2 = "22222222-2222-4222-8222-222222222222";
		const ENVIRONMENT2 = "44444444-4444-4444-8444-444444444444";
		const R4 = "aaaaaaaa-0000-4000-8000-000000000004";
		const T4 = "bbbbbbbb-0000-4000-8000-000000000004";
		const R5 = "aaaaaaaa-0000-4000-8000-000000000005";
		const T5 = "bbbbbbbb-0000-4000-8000-000000000005";
		/** An import of another company, as the kernel hands it out (A2): a first claim, nothing done yet. */
		const IMPORT = {
			requestId: R4,
			token: T4,
			leaseUntil: "2026-11-12T15:15:00+00:00",
			companyId: COMPANY2,
			environmentId: ENVIRONMENT2,
			owner: "qorpera",
			name: "saml-storefront",
			kind: "import",
			input: {
				from: { github: "Qorpera/saml-storefront" },
				via: "connection",
				look: false,
				maximumBytes: 1_073_741_824,
			},
			progress: null,
			looked: null,
		};
		const IMPORTED: CodeImportOutcome = {
			schema: SCHEMA,
			state: "done",
			result: "imported",
			change: 1,
			mainSha: MAIN,
			bundle: `20261112T150000Z-${MAIN.slice(0, 12)}`,
			rawBundle: `import-20261112T145000Z-${MAIN.slice(0, 12)}`,
			setAside: "code/_set-aside/qorpera/at-20261112T145500Z/saml-storefront",
		};
		const BUSY = { schema: SCHEMA, state: "busy" };
		const ALL = [...KINDS, "import"];
		const kinds = (t: ReturnType<typeof setup>) =>
			t.calls.filter((call) => call.method === "qorpera_code_requests_claim").map((call) => call.args.p_kinds);

		/** The requests with a stand-in of part C3's import runner: it says so in `order`, waits while `gate.held`
		 * holds, then throws `gate.throws` or answers `gate.outcome`. */
		function importing(options: Partial<CodeHostRequestsOptions> = {}) {
			const taken: { request: CodeImportRequest; signal: AbortSignal }[] = [];
			const gate = {
				outcome: IMPORTED as unknown,
				held: undefined as ReturnType<typeof held> | undefined,
				throws: undefined as unknown,
				run: undefined as ((signal: AbortSignal) => Promise<unknown>) | undefined,
			};
			const t = setup({
				imports: {
					run: async (request, signal) => {
						taken.push({ request, signal });
						t.order.push("import");
						if (gate.run) return (await gate.run(signal)) as CodeImportOutcome;
						if (gate.held) await gate.held.turn;
						if (gate.throws !== undefined) throw gate.throws;
						return gate.outcome as CodeImportOutcome;
					},
				},
				...options,
			});
			return { ...t, taken, gate };
		}

		it("hands an import to the import runner as part C1 reads it, beside the passes, and finishes its outcome after the run", async () => {
			const t = importing();
			t.kernel.claims = [[IMPORT]];
			await expect(t.whole()).resolves.toEqual({ ...NONE, done: 1 });
			expect(t.taken.map((run) => run.request)).toEqual([codeImportRequestOf(IMPORT)]);
			expect(t.taken[0]?.request).toMatchObject({
				requestId: R4,
				kind: "import",
				input: { from: { github: "Qorpera/saml-storefront" }, via: "connection", look: false },
				progress: {},
				looked: null,
			});
			// The run is the request's whole work: no job, no step of this loop's own; the finish once it has ended.
			expect(t.order).toEqual(["claim", "import", "finish", "claim"]);
			expect(t.taken[0]?.signal.aborted).toBe(false);
			expect(t.finishes()).toEqual([finishOf(R4, T4, IMPORTED)]);
			expect(t.finished()).toEqual([
				expect.objectContaining({
					requestId: R4,
					kind: "import",
					companyId: COMPANY2,
					repository: "qorpera/saml-storefront",
					state: "done",
					result: "imported",
					recorded: true,
				}),
			]);
			// Asked for again once it has ended.
			expect(kinds(t)).toEqual([ALL, ALL]);
			expect(t.errors()).toEqual([]);
			// The progress and the look an earlier claim left are handed on as C1 reads them.
			const again = importing();
			const progress = { step: "look", relayRefused: 1 };
			again.kernel.claims = [[{ ...IMPORT, progress }]];
			await again.whole();
			expect(again.taken[0]?.request.progress).toEqual(progress);
		});

		it("finishes each outcome as the run answered it, and anything else as a failure", async () => {
			const outcomes: [unknown, keyof typeof NONE][] = [
				[IMPORTED, "done"],
				[{ schema: SCHEMA, state: "done", result: "looked" }, "done"],
				[{ schema: SCHEMA, state: "refused", code: "IMPORT_SOURCE_REFUSED" }, "refused"],
				[{ schema: SCHEMA, state: "failed", code: "IMPORT_NO_SPACE:PLACE_AS_BEFORE" }, "failed"],
				[BUSY, "busy"],
			];
			for (const [outcome, ended] of outcomes) {
				const t = importing();
				t.gate.outcome = outcome;
				t.kernel.claims = [[IMPORT]];
				await expect(t.whole(), JSON.stringify(outcome)).resolves.toEqual({ ...NONE, [ended]: 1 });
				expect(t.finishes()).toEqual([finishOf(R4, T4, outcome)]);
				expect(t.errors()).toEqual([]);
				// Busy or not, the request is the kernel's again: the next claim asks for an import.
				expect(kinds(t)).toEqual([ALL, ALL]);
			}
			const invalid = { schema: SCHEMA, state: "failed", code: "CODE_REQUEST_ANSWER_INVALID" };
			for (const outcome of [
				{ schema: SCHEMA, state: "done", result: "imported" },
				{ ...IMPORTED, extra: 1 },
				{ ...IMPORTED, schema: "qorpera.code-import/v1" },
				{ state: "busy" },
				{ schema: SCHEMA, state: "refused", code: "not a code" },
				{ schema: SCHEMA, state: "done", result: "restored" },
				null,
			]) {
				const t = importing();
				t.gate.outcome = outcome;
				t.kernel.claims = [[IMPORT]];
				await expect(t.whole(), JSON.stringify(outcome)).resolves.toEqual({ ...NONE, failed: 1 });
				expect(t.finishes()).toEqual([finishOf(R4, T4, invalid)]);
				expect(t.errors()).toEqual(["job:CODE_REQUEST_ANSWER_INVALID"]);
			}
			// A run that throws: failed with its code, or put off when its job gave way to a turn's.
			const cases: [unknown, unknown, string[]][] = [
				[
					new CodeHostJobFailure("CODE_HOST_VIEW_UNAVAILABLE", "fetch failed"),
					{ schema: SCHEMA, state: "failed", code: "CODE_HOST_VIEW_UNAVAILABLE" },
					["job:CODE_HOST_VIEW_UNAVAILABLE: fetch failed"],
				],
				[
					new Error("something else"),
					{ schema: SCHEMA, state: "failed", code: "UNCLASSIFIED" },
					["job:something else"],
				],
				[yielded(), BUSY, []],
			];
			for (const [error, outcome, errors] of cases) {
				const t = importing();
				t.gate.throws = error;
				t.kernel.claims = [[IMPORT]];
				await t.whole();
				expect(t.finishes()).toEqual([finishOf(R4, T4, outcome)]);
				expect(t.errors()).toEqual(errors);
			}
		});

		it("ends an import item it cannot read as failed, as the other kinds, and runs nothing for it", async () => {
			const { looked: _, ...lookless } = IMPORT;
			for (const entry of [
				{ ...IMPORT, extra: 1 },
				lookless,
				{ ...IMPORT, leaseUntil: "soon" },
				{ ...IMPORT, input: { ...IMPORT.input, via: "file" } },
				{ ...IMPORT, input: { ...IMPORT.input, maximumBytes: 3 * 1024 ** 3 } },
				{ ...IMPORT, progress: { step: "elsewhere" } },
				{ ...IMPORT, looked: { schema: "qorpera.code-import-look/v1" } },
				{ ...IMPORT, owner: "Qorpera" },
			]) {
				const t = importing();
				t.kernel.claims = [[entry]];
				await expect(t.whole(), JSON.stringify(entry)).resolves.toEqual(NONE);
				expect(t.taken).toEqual([]);
				expect(t.finishes()).toEqual([
					finishOf(R4, T4, { schema: SCHEMA, state: "failed", code: "REQUEST_INVALID" }),
				]);
				expect(t.errors()).toHaveLength(1);
				// C1's own code says which part was wrong (the place's name is read before the kind, as for every kind).
				expect(t.errors()[0]).toMatch(
					/^claim:INVALID_(?:CODE_IMPORT_(?:REQUEST|INPUT|PROGRESS|LOOK)|CODING_REPOSITORY)$/,
				);
			}
		});

		it("runs one at a time: while one runs no claim asks for another, and one handed out anyway is put back", async () => {
			const t = importing();
			t.gate.held = held();
			t.kernel.claims = [[IMPORT, { ...IMPORT, requestId: R5, token: T5, name: "shop" }], [], []];
			const counts = [await t.pass(), await t.pass(), await t.pass()];
			expect(kinds(t)).toEqual([ALL, KINDS, KINDS]);
			expect(t.taken.map((run) => run.request.requestId)).toEqual([R4]);
			// The second was not asked for (the kernel hands out one a claim): it goes back to wait, unrun.
			await vi.waitFor(() => expect(t.finishes()).toEqual([finishOf(R5, T5, BUSY)]));
			expect(t.errors()).toEqual(["claim:CODE_IMPORT_NOT_ASKED"]);
			t.gate.held.give();
			await t.requests.settled();
			counts.push(await t.pass());
			expect(kinds(t)).toEqual([ALL, KINDS, KINDS, ALL]);
			expect(t.finishes()).toEqual([finishOf(R5, T5, BUSY), finishOf(R4, T4, IMPORTED)]);
			expect(
				counts.reduce((sum, count) => ({
					done: sum.done + count.done,
					refused: sum.refused + count.refused,
					failed: sum.failed + count.failed,
					busy: sum.busy + count.busy,
				})),
			).toEqual({ ...NONE, done: 1, busy: 1 });
		});

		it("never holds a pass up: other companies' undos, downloads and restores run to their finish while an import runs", async () => {
			const verified = {
				schema: SCHEMA,
				state: "done",
				result: "verified",
				mainSha: MAIN,
				refsSha256: "9".repeat(64),
				refs: 4,
			} as CodeRequestOutcome;
			const t = importing({ restore: { run: async () => verified } });
			t.gate.held = held();
			t.kernel.claims = [[IMPORT], [UNDO], [DOWNLOAD], [RESTORE]];
			let done = 0;
			await expect(t.pass()).resolves.toEqual(NONE);
			// The undo's pass ends when the undo is finished: in its own pass, with the import still running.
			await expect(t.pass()).resolves.toEqual({ ...NONE, done: 1 });
			done += 1;
			done += (await t.pass()).done;
			done += (await t.pass()).done;
			await vi.waitFor(() => expect(t.finishes().map((call) => call.args.p_request_id)).toEqual([R1, R2, R3]));
			expect(kinds(t)).toEqual([ALL, KINDS, KINDS, KINDS]);
			// The import still runs, unfinished.
			expect(t.taken).toHaveLength(1);
			expect(t.taken[0]?.signal.aborted).toBe(false);
			t.gate.held.give();
			await t.requests.settled();
			done += (await t.pass()).done;
			expect(done).toBe(4);
			expect(t.finishes().map((call) => call.args.p_request_id)).toEqual([R1, R2, R3, R4]);
		});

		it("asks for no import without an import runner, and puts one handed out anyway back", async () => {
			const t = setup();
			t.kernel.claims = [[IMPORT]];
			await expect(t.whole()).resolves.toEqual({ ...NONE, busy: 1 });
			expect(kinds(t)).toEqual([KINDS, KINDS]);
			expect(t.order).toEqual(["claim", "finish", "claim"]);
			expect(t.finishes()).toEqual([finishOf(R4, T4, BUSY)]);
			expect(t.errors()).toEqual(["claim:CODE_IMPORT_NOT_ASKED"]);
		});

		it("stops the import with the executor: its signal ends, the pass does not wait, and its finish gets the few seconds", async () => {
			const stopped = new AbortController();
			const t = importing();
			// As the runner stops: it ends at its signal, put off.
			t.gate.run = (signal) =>
				new Promise((resolve) => signal.addEventListener("abort", () => resolve(BUSY), { once: true }));
			t.kernel.claims = [[IMPORT]];
			await expect(t.requests.pass(stopped.signal)).resolves.toEqual(NONE);
			expect(t.taken[0]?.signal.aborted).toBe(false);
			stopped.abort(new Error("CODING_EXECUTOR_SHUTDOWN"));
			expect(t.taken[0]?.signal.aborted).toBe(true);
			await t.requests.settled();
			// Finished busy with the stop's own time for it: the kernel puts it back for the next claim.
			expect(t.finishes()).toEqual([finishOf(R4, T4, BUSY)]);
			await expect(t.pass()).resolves.toEqual({ ...NONE, busy: 1 });
			expect(t.errors()).toEqual([]);
			// One that throws as it stops is put off too, with nothing reported; one that got to its end says so.
			for (const [run, outcome] of [
				[
					async (signal: AbortSignal) => {
						await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
						signal.throwIfAborted();
					},
					BUSY,
				],
				[
					async (signal: AbortSignal) => {
						await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
						return IMPORTED;
					},
					IMPORTED,
				],
			] as const) {
				const stop = new AbortController();
				const one = importing();
				one.gate.run = run;
				one.kernel.claims = [[IMPORT]];
				await one.requests.pass(stop.signal);
				stop.abort(new Error("CODING_EXECUTOR_SHUTDOWN"));
				await one.requests.settled();
				expect(one.finishes()).toEqual([finishOf(R4, T4, outcome)]);
				expect(one.errors()).toEqual([]);
			}
			// A finish not heard as it stops leaves the request leased: it is claimed again when its lease runs out.
			const unheard = importing();
			const stop = new AbortController();
			unheard.gate.run = (signal) =>
				new Promise((resolve) => signal.addEventListener("abort", () => resolve(BUSY), { once: true }));
			unheard.kernel.answer = (method) => {
				if (method === "qorpera_code_request_finish") throw new Error("CODING_CONTROL_UNCONFIRMED");
				return undefined;
			};
			unheard.kernel.claims = [[IMPORT]];
			await unheard.requests.pass(stop.signal);
			stop.abort(new Error("CODING_EXECUTOR_SHUTDOWN"));
			await unheard.requests.settled();
			expect(unheard.finishes()).toHaveLength(2);
			expect(unheard.errors()).toEqual(["finish:CODING_CONTROL_UNCONFIRMED"]);
		});
	});

	it("never keeps an undo behind a download: the undo runs to its finish while the download goes on beside the passes", async () => {
		const t = setup();
		t.kernel.claims = [[DOWNLOAD, UNDO]];
		const making = held();
		t.jobs.archive.mockImplementationOnce(async () => {
			t.order.push("archive");
			await making.turn;
			return { ...MADE };
		});
		await expect(t.pass()).resolves.toEqual({ ...NONE, done: 1 });
		// The undo first, though it was claimed second; the download only started.
		expect(t.order).toEqual([
			"claim",
			"job",
			"undo",
			"finish",
			"records",
			"saved",
			"confirm",
			"job",
			"step",
			"archive",
		]);
		expect(t.runs.map((run) => run.options)).toEqual([undefined, { yields: true }]);
		// A later undo is claimed and done while the download is still being made.
		t.kernel.claims = [[{ ...UNDO, requestId: R3, token: T3 }]];
		await expect(t.pass()).resolves.toEqual({ ...NONE, done: 1 });
		expect(t.finishes().map((call) => call.args.p_request_id)).toEqual([R1, R3]);
		making.give();
		await t.requests.settled();
		await expect(t.pass()).resolves.toEqual({ ...NONE, done: 1 });
		expect(t.finishes().map((call) => call.args.p_request_id)).toEqual([R1, R3, R2]);
	});

	it("ends a request it cannot read as failed when it names its lease, and goes on to the others", async () => {
		const t = setup();
		t.kernel.claims = [
			[
				{ ...UNDO, change: { n: 12, mainBefore: "main", mainAfter: AFTER } },
				{ ...DOWNLOAD, requestId: R3, token: T3, path: "code/qorpera/shop/main/index.html" },
				{ kind: "undo" },
				{ ...UNDO, requestId: R2, token: T2, kind: "publish" },
				{ ...UNDO, requestId: "aaaaaaaa-0000-4000-8000-000000000009" },
			],
		];
		await expect(t.pass()).resolves.toEqual({ ...NONE, done: 1 });
		const invalid = { schema: SCHEMA, state: "failed", code: "REQUEST_INVALID" };
		expect(t.finishes().slice(0, 3)).toEqual([
			finishOf(R1, T1, invalid),
			finishOf(R3, T3, invalid),
			finishOf(R2, T2, invalid),
		]);
		expect(t.finishes()).toHaveLength(4);
		expect(t.finishes()[3]?.args.p_request_id).toBe("aaaaaaaa-0000-4000-8000-000000000009");
		expect(t.errors()).toEqual(Array.from({ length: 4 }, () => "claim:CODE_REQUEST_INVALID"));
		// Nothing was made or removed for the ones it could not read.
		expect(t.jobs.archive).not.toHaveBeenCalled();
		expect(t.jobs.undo).toHaveBeenCalledTimes(1);
		// A download whose file is not of its kind, or not under the repository's downloads, is one of them.
		for (const entry of [
			{ ...DOWNLOAD, file: "history" },
			{ ...DOWNLOAD, fileName: "../main/x.zip", path: "code/qorpera/shop/downloads/../main/x.zip" },
			{ ...DOWNLOAD, work: "send" },
			{ ...DOWNLOAD, owner: "Qorpera" },
		]) {
			const other = setup();
			other.kernel.claims = [[entry]];
			await expect(other.whole()).resolves.toEqual(NONE);
			expect(other.runs).toEqual([]);
			expect(other.errors()[0]).toMatch(/^claim:/);
		}
	});

	it("never throws for a kernel that does not answer, a job that throws anything, or a log that throws", async () => {
		const t = setup();
		t.kernel.answer = () => {
			throw new Error("CODING_CONTROL_UNCONFIRMED");
		};
		await expect(t.pass()).resolves.toEqual(NONE);
		expect(t.errors()).toEqual(["claim:CODING_CONTROL_UNCONFIRMED"]);
		const odd = setup();
		odd.kernel.answer = (method) => (method === "qorpera_code_requests_claim" ? { requests: [UNDO] } : undefined);
		await expect(odd.pass()).resolves.toEqual(NONE);
		expect(odd.errors()).toEqual(["claim:CODE_REQUESTS_UNCONFIRMED"]);
		const loud = setup({
			report: () => {
				throw new Error("the log is full");
			},
		});
		loud.kernel.claims = [[UNDO, DOWNLOAD]];
		loud.jobs.archive.mockRejectedValueOnce(null);
		await expect(loud.whole()).resolves.toEqual({ ...NONE, done: 1, failed: 1 });
	});

	it("puts what it holds off when the executor stops, with a few seconds of its own for the finish", async () => {
		const t = setup();
		t.kernel.claims = [[UNDO, DOWNLOAD]];
		const stopped = new AbortController();
		const reason = new Error("CODING_EXECUTOR_SHUTDOWN");
		t.jobs.undo.mockImplementationOnce(async (job) => {
			stopped.abort(reason);
			job.signal.throwIfAborted();
			throw new Error("unreachable");
		});
		await expect(t.requests.pass(stopped.signal)).resolves.toEqual({ ...NONE, busy: 1 });
		await t.requests.settled();
		const busy = { schema: SCHEMA, state: "busy" };
		// The undo's job was cut off, and the download never got its turn: both go back to wait, neither failed.
		expect(t.finishes()).toEqual([finishOf(R1, T1, busy), finishOf(R2, T2, busy)]);
		expect(t.jobs.archive).not.toHaveBeenCalled();
		expect(t.errors()).toEqual([]);
		await expect(t.pass()).resolves.toEqual({ ...NONE, busy: 1 });
		// A pass stopped before it began claims nothing.
		const never = setup();
		never.kernel.claims = [[UNDO]];
		await expect(never.requests.pass(stopped.signal)).resolves.toEqual(NONE);
		expect(never.calls).toEqual([]);
	});

	it("hangs nothing off the signal its passes are given, which may last as long as the process (abort-scope.ts)", async () => {
		const t = setup();
		t.kernel.claims = [[UNDO, DOWNLOAD], [{ ...DOWNLOAD, work: "remove" }]];
		const lasting = new AbortController();
		const watch = watchAbortSignalAny();
		try {
			await expect(t.requests.pass(lasting.signal)).resolves.toEqual({ ...NONE, done: 1 });
			await t.requests.settled();
			await expect(t.requests.pass(lasting.signal)).resolves.toEqual({ ...NONE, done: 1 });
			await t.requests.settled();
			expect(watch.made()).toBeGreaterThan(6);
			expect(watch.on(lasting.signal)).toBe(0);
		} finally {
			watch.restore();
		}
	});
});
