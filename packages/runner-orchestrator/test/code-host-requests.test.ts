import type { CloudCodingRepository } from "@qorpera/contracts";
import { describe, expect, it, vi } from "vitest";
import type { CodeChangeTarget } from "../src/code-change-records.ts";
import { type CodeHostGcBlock, type CodeHostJob, CodeHostJobFailure, CodeHostRefusal } from "../src/code-host-jobs.ts";
import type { CodeChangeDiff } from "../src/code-host-jobs-stand-in.ts";
import {
	CODE_REQUEST_RPCS,
	CodeHostRequests,
	type CodeHostRequestsOptions,
	type CodeRequestJobs,
	type CodeRequestOutcome,
	type CodeRestoreRequest,
} from "../src/code-host-requests.ts";
import { CODE_HOST_LAYOUT, type CodeHostJobOptions, type CodeHostJobs } from "../src/code-host-views.ts";
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
	tips: [{ n: 14, mainAfter: MAIN }],
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
			order.push(method.replace("qorpera_code_request", "").replace(/^s?_/, ""));
			const forced = await kernel.answer?.(method, args);
			if (forced !== undefined) return forced;
			if (method === "qorpera_code_requests_claim")
				return { schema: "qorpera.code-requests/v1", requests: kernel.claims.shift() ?? [] };
			if (method === "qorpera_code_request_step")
				return { schema: STEP, state: "go", leaseUntil: "2026-11-10T12:35:00+00:00" };
			if (method === "qorpera_code_request_finish") return { schema: FINISH, state: "recorded", change: 15 };
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
		expect(t.calls).toEqual([{ method: "qorpera_code_requests_claim", args: { ...WHO, p_limit: 10 } }]);
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
					tips: [{ n: 14, mainAfter: MAIN }],
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
