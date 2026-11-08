import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CLEANUP_STOP_BUDGET_MS,
	CloudCodingExecutor,
	CODING_DESCRIBE_BUDGET_MS,
	CODING_LEASE_MARGIN_MS,
	CODING_RETRY_PAUSES_MS,
	CodingControlBusy,
	CodingControlRefused,
	type CodingExecutorControl,
	type CodingExecutorHost,
	CodingMachineUnavailable,
	type CodingPushCarrier,
	CodingPushRefused,
	PUBLICATION_UNFINISHED,
	CodingSaveRefused,
	type CodingSessionClaim,
	type CodingSubmission,
	type CodingTurnState,
	CodingWorkspaceFailed,
	parseCodingSessionClaim,
	parseCodingTurnState,
} from "../src/coding-executor.ts";
import { CODING_VM_STOP_BUDGET_MS, codingHostId } from "../src/coding-executor-host.ts";
import { watchAbortSignalAny } from "./helpers/abort-any.ts";

// The executor's pauses (heartbeat, poll, busy retry) follow the fake clock too.
// An abort rejects like Node's: an AbortError carrying the reason as its cause.
vi.mock("node:timers/promises", () => ({
	setTimeout: (ms: number, value?: unknown, options?: { signal?: AbortSignal }) =>
		new Promise((resolve, reject) => {
			const signal = options?.signal;
			const aborted = () =>
				Object.assign(new Error("The operation was aborted", { cause: signal?.reason }), {
					name: "AbortError",
					code: "ABORT_ERR",
				});
			if (signal?.aborted) return reject(aborted());
			const abort = () => {
				globalThis.clearTimeout(timer);
				reject(aborted());
			};
			const timer = globalThis.setTimeout(() => {
				signal?.removeEventListener("abort", abort);
				resolve(value);
			}, ms);
			signal?.addEventListener("abort", abort, { once: true });
		}),
}));

const repository = { host: "github.com" as const, owner: "Qorpera", name: "app", baseBranch: "main" };
const headSha = "b".repeat(40);
const baseSha = "a".repeat(40);

function claimJson(workerId: string, leaseToken: string, extra: Record<string, unknown> = {}) {
	return {
		schema: "qorpera.coding-session-claim/v1",
		workerId,
		sequence: 1,
		leaseToken,
		leaseUntil: new Date(Date.now() + 60000).toISOString(),
		profileId: randomUUID(),
		environmentId: randomUUID(),
		agentId: randomUUID(),
		ownerUserId: randomUUID(),
		sponsor: { bindingId: randomUUID(), version: 1 },
		harness: "codex",
		model: null,
		repository,
		branch: `qorpera/coding/${workerId}`,
		baseSha: null,
		harnessSessionRef: null,
		pullRequest: null,
		title: "Fix the delay after send",
		dispatch: { goal: "Post first, refresh after.", definitionOfDone: "Tests pass.", context: "" },
		followUp: null,
		todoId: randomUUID(),
		...extra,
	};
}

interface World {
	claim: ReturnType<typeof claimJson>;
	phase: string;
	jobStatus: string | null;
	submission: Record<string, unknown> | null;
	vmAllocationId: string | null;
	machineId: string;
	calls: { method: string; args: Record<string, unknown> }[];
}

function world(machineId = randomUUID()): {
	world: World;
	control: CodingExecutorControl;
	host: CodingExecutorHost & Record<string, ReturnType<typeof vi.fn>>;
} {
	const workerId = randomUUID();
	const leaseToken = randomUUID();
	const state: World = {
		claim: claimJson(workerId, leaseToken),
		phase: "preparing",
		jobStatus: null,
		submission: null,
		vmAllocationId: null,
		machineId,
		calls: [],
	};
	const turnState = (): Record<string, unknown> => ({
		schema: "qorpera.coding-turn-state/v1",
		workerId,
		sequence: 1,
		turnId: codingHostId("turn", `${workerId}:1`),
		phase: state.phase,
		workerState: "active",
		vmAllocationId: state.vmAllocationId,
		storageVolumeId: null,
		baseSha: state.vmAllocationId ? baseSha : null,
		occurrenceId: state.phase === "running" || state.phase === "publishing" ? randomUUID() : null,
		occurrenceStatus: state.jobStatus ? "materialized" : null,
		runId: state.jobStatus ? randomUUID() : null,
		jobStatus: state.jobStatus,
		jobError: state.jobStatus === "failed" ? "provider request failed" : null,
		submission: state.submission,
		pullRequest: null,
	});
	const control: CodingExecutorControl = {
		call: vi.fn(async (method, args) => {
			state.calls.push({ method, args });
			switch (method) {
				case "qorpera_claim_coding_session":
					return state.claim;
				case "qorpera_heartbeat_coding_session":
					return new Date(Date.now() + 60000).toISOString();
				case "qorpera_record_coding_progress":
					if (typeof args.p_vm_allocation_id === "string") state.vmAllocationId = args.p_vm_allocation_id;
					if (typeof args.p_phase === "string") state.phase = args.p_phase;
					return { workerId };
				case "qorpera_begin_coding_turn":
					if (state.phase !== "preparing") throw new Error("Coding turn cannot begin");
					state.phase = "running";
					return { schema: "qorpera.coding-turn/v1", workerId, sequence: 1, occurrenceId: randomUUID() };
				case "qorpera_describe_coding_turn":
					return turnState();
				case "qorpera_defer_coding_session":
					state.phase = "queued";
					return { schema: "qorpera.coding-session/v1", workerId, phase: state.phase };
				case "qorpera_complete_coding_turn":
					state.phase =
						args.p_outcome === "succeeded"
							? "completed"
							: args.p_outcome === "blocked"
								? "awaiting_input"
								: "failed";
					return { schema: "qorpera.coding-session/v1", workerId, phase: state.phase };
				default:
					throw new Error(`Unexpected control method ${String(method)}`);
			}
		}),
	};
	const host = {
		prepareWorkspace: vi.fn(async (_claim: CodingSessionClaim, turn: CodingTurnState) => ({
			vmId: turn.vmAllocationId ?? machineId,
			baseSha,
		})),
		endTurn: vi.fn(() => {}),
		publish: vi.fn(async (_claim: CodingSessionClaim, submission: Extract<CodingSubmission, { kind: "finish" }>) => ({
			pullRequest: { url: "https://github.com/Qorpera/app/pull/12", number: 12, headSha: submission.headSha },
			noChange: false,
		})),
		detachSession: vi.fn(async () => {}),
		keep: vi.fn(async () => []),
		housekeep: vi.fn(async () => []),
	};
	return {
		world: state,
		control,
		host: host as unknown as CodingExecutorHost & Record<string, ReturnType<typeof vi.fn>>,
	};
}

/** The harness's turn ends at the first poll after admission, with this submission. */
function endTurnOnPoll(w: World, jobStatus: string, submission: Record<string, unknown> | null) {
	const original = vi.mocked(w.calls) && undefined;
	void original;
	let admitted = false;
	return (method: string) => {
		if (method === "qorpera_begin_coding_turn") admitted = true;
		if (method === "qorpera_describe_coding_turn" && admitted && !w.jobStatus) {
			w.jobStatus = jobStatus;
			w.submission = submission;
		}
	};
}

function withHook(control: CodingExecutorControl, hook: (method: string) => void): CodingExecutorControl {
	const inner = control.call;
	return {
		call: (method, args, signal) => {
			hook(method);
			return inner(method, args, signal);
		},
	};
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => vi.useRealTimers());

describe("the coding executor over a session turn", () => {
	it("hangs nothing off the signal that lasts as long as its process, and its turn's own signals gather nothing as it polls (abort-scope.ts)", async () => {
		const most = async (polls: number) => {
			const w = world();
			const finish = {
				schema: "qorpera.coding-submission/v1",
				workerId: w.world.claim.workerId,
				sequence: 1,
				kind: "finish",
				state: "submitted",
				summary: "Tests passed",
				headSha,
				operationKey: "done",
			};
			let admitted = false;
			let described = 0;
			const control = withHook(w.control, (method) => {
				if (method === "qorpera_begin_coding_turn") admitted = true;
				if (method === "qorpera_describe_coding_turn" && admitted && ++described >= polls && !w.world.jobStatus) {
					w.world.jobStatus = "completed";
					w.world.submission = finish;
				}
			});
			const lasting = new AbortController();
			const watch = watchAbortSignalAny();
			try {
				const executor = new CloudCodingExecutor({ control, host: w.host, owner: "exec-test", turnPollMs: 1 });
				expect(await executor.runOnce(lasting.signal)).toBe("completed");
				expect(described).toBeGreaterThanOrEqual(polls);
				expect(watch.on(lasting.signal)).toBe(0);
				return watch.most();
			} finally {
				watch.restore();
			}
		};
		expect(await most(40)).toBe(await most(3));
	});

	it("is idle when nothing is claimed", async () => {
		const { control, host } = world();
		vi.mocked(control.call).mockResolvedValueOnce(null);
		const executor = new CloudCodingExecutor({ control, host, owner: "exec-test", turnPollMs: 1 });
		expect(await executor.runOnce(new AbortController().signal)).toBe("idle");
		expect(host.prepareWorkspace).not.toHaveBeenCalled();
	});

	it("prepares the workspace, admits the turn, publishes the submitted commit and completes the session", async () => {
		const w = world();
		const finish = {
			schema: "qorpera.coding-submission/v1",
			workerId: w.world.claim.workerId,
			sequence: 1,
			kind: "finish",
			state: "submitted",
			summary: "Tests passed",
			headSha,
			operationKey: "done",
		};
		const control = withHook(w.control, endTurnOnPoll(w.world, "completed", finish));
		const executor = new CloudCodingExecutor({ control, host: w.host, owner: "exec-test", turnPollMs: 1 });
		expect(await executor.runOnce(new AbortController().signal)).toBe("completed");
		const methods = w.world.calls.map((c) => c.method);
		expect(methods.slice(0, 4)).toEqual([
			"qorpera_claim_coding_session",
			"qorpera_describe_coding_turn",
			"qorpera_record_coding_progress",
			"qorpera_begin_coding_turn",
		]);
		const progress = w.world.calls.find((c) => c.method === "qorpera_record_coding_progress")!.args;
		expect(progress).toMatchObject({
			p_base_sha: baseSha,
			p_vm_allocation_id: w.world.machineId,
			p_events: [{ kind: "step", actor: "executor", body: { text: "Prepared the repository at aaaaaaa" } }],
		});
		const begun = w.world.calls.find((c) => c.method === "qorpera_begin_coding_turn")!.args;
		expect(begun.p_coding).toEqual({
			vmId: w.world.machineId,
			turnId: codingHostId("turn", `${w.world.claim.workerId}:1`),
		});
		expect(w.host.publish).toHaveBeenCalledTimes(1);
		// The turn ends before the kernel hears the outcome; its session stays attached.
		expect(w.host.endTurn).toHaveBeenCalledTimes(1);
		expect(w.host.detachSession).not.toHaveBeenCalled();
		const calls = vi.mocked(w.control.call).mock;
		const completed = calls.calls.findIndex((c) => c[0] === "qorpera_complete_coding_turn");
		expect(vi.mocked(w.host.endTurn).mock.invocationCallOrder[0]).toBeLessThan(calls.invocationCallOrder[completed]!);
		expect(vi.mocked(w.host.publish).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(w.host.endTurn).mock.invocationCallOrder[0]!,
		);
		const completion = w.world.calls.find((c) => c.method === "qorpera_complete_coding_turn")!.args;
		expect(completion).toMatchObject({
			p_outcome: "succeeded",
			p_summary: "Tests passed",
			p_pull_request: { number: 12, headSha },
		});
		// The publishing phase was recorded before the broker ran.
		expect(w.world.calls.filter((c) => c.method === "qorpera_record_coding_progress").at(-1)?.args.p_phase).toBe(
			"publishing",
		);
	});

	it("a publication refused for a secret value fails the turn with what to change, and leaves the session attached", async () => {
		const sha = "abcdef012345";
		for (const [carrier, reason] of [
			[{ kind: "file", path: "config/settings.json" }, 'the file "config/settings.json" carries one'],
			[{ kind: "file", path: null }, "a file carries one"],
			[{ kind: "folder", path: "" }, "a file or folder name at the top of the repository carries one"],
			[{ kind: "folder", path: "src/***" }, 'a file or folder name in "src/***" carries one'],
			[{ kind: "commit", sha }, `the commit ${sha} carries one`],
			[{ kind: "pull-request" }, "the pull request's title or summary carries one"],
			[null, "could not be checked whole"],
		] as [CodingPushCarrier | null, string][]) {
			const w = world();
			vi.mocked(w.host.publish).mockRejectedValueOnce(new CodingPushRefused(carrier));
			const finish = {
				schema: "qorpera.coding-submission/v1",
				workerId: w.world.claim.workerId,
				sequence: 1,
				kind: "finish",
				state: "submitted",
				summary: "Tests passed",
				headSha,
				operationKey: "done",
			};
			const control = withHook(w.control, endTurnOnPoll(w.world, "completed", finish));
			const executor = new CloudCodingExecutor({ control, host: w.host, owner: "exec-test", turnPollMs: 1 });
			expect(await executor.runOnce(new AbortController().signal)).toBe("failed");
			const completion = w.world.calls.find((c) => c.method === "qorpera_complete_coding_turn")!.args;
			expect(completion.p_outcome).toBe("failed");
			expect(String(completion.p_summary)).toMatch(/^The push was refused: .+ finish again\.$/);
			expect(String(completion.p_summary)).toContain(reason);
			expect(completion.p_pull_request).toBeNull();
			expect(w.host.endTurn).toHaveBeenCalledTimes(1);
			expect(w.host.detachSession).not.toHaveBeenCalled();
		}
	});

	it("a publication held by a refused save fails the turn with what to change, and leaves the session attached", async () => {
		const reasons: [CodingSaveRefused, string][] = [
			[
				new CodingSaveRefused(),
				"The save was refused: a file this session wrote in the company folder carries one of the session's secret values, in its contents or its name. It was not saved, and nothing was published. Remove the value and finish again. If a git commit carried it, take the value out of the files (and `git add` them) or the message, run `git reflog expire --expire-unreachable=now HEAD`, `git repack -a -d --max-pack-size=64m` and `git prune --expire=now`, then commit again.",
			],
			// One the check could not finish (5j-5 (c)): the same way out for git's storage, and another for a file.
			[
				new CodingSaveRefused(true),
				"The save was refused: a file this session wrote in the company folder could not be checked for the session's secret values. It was not saved, and nothing was published. If it is in a git repository's storage, run `git reflog expire --expire-unreachable=now HEAD`, `git repack -a -d --max-pack-size=64m` and `git prune --expire=now`, then commit and finish again. Otherwise remove the file or make it smaller, and finish again. If nothing needs changing, finish again: the check may have been busy.",
			],
		];
		expect(reasons.map(([error]) => error.message)).toEqual([
			"CODING_FOLDER_SAVE_REFUSED",
			"CODING_FOLDER_SAVE_UNCHECKED",
		]);
		for (const [error, reason] of reasons) {
			const w = world();
			vi.mocked(w.host.publish).mockRejectedValueOnce(error);
			const finish = {
				schema: "qorpera.coding-submission/v1",
				workerId: w.world.claim.workerId,
				sequence: 1,
				kind: "finish",
				state: "submitted",
				summary: "Tests passed",
				headSha,
				operationKey: "done",
			};
			const control = withHook(w.control, endTurnOnPoll(w.world, "completed", finish));
			const executor = new CloudCodingExecutor({ control, host: w.host, owner: "exec-test", turnPollMs: 1 });
			expect(await executor.runOnce(new AbortController().signal)).toBe("failed");
			const completion = w.world.calls.find((c) => c.method === "qorpera_complete_coding_turn")!.args;
			expect(completion.p_outcome).toBe("failed");
			expect(completion.p_summary).toBe(reason);
			expect(completion.p_pull_request).toBeNull();
			expect(w.host.endTurn).toHaveBeenCalledTimes(1);
			expect(w.host.detachSession).not.toHaveBeenCalled();
		}
	});

	it("a publication that fails for another reason fails the turn and says so, instead of letting the lease lapse", async () => {
		const w = world();
		const report = vi.fn();
		vi.mocked(w.host.publish).mockRejectedValueOnce(new Error("CODING_GIT_RECONCILIATION_REQUIRED"));
		const finish = {
			schema: "qorpera.coding-submission/v1",
			workerId: w.world.claim.workerId,
			sequence: 1,
			kind: "finish",
			state: "submitted",
			summary: "Tests passed",
			headSha,
			operationKey: "done",
		};
		const control = withHook(w.control, endTurnOnPoll(w.world, "completed", finish));
		const executor = new CloudCodingExecutor({ control, host: w.host, owner: "exec-test", turnPollMs: 1, report });
		expect(await executor.runOnce(new AbortController().signal)).toBe("failed");
		const completion = w.world.calls.find((c) => c.method === "qorpera_complete_coding_turn")!.args;
		expect(completion.p_outcome).toBe("failed");
		expect(completion.p_summary).toBe(PUBLICATION_UNFINISHED);
		expect(completion.p_pull_request).toBeNull();
		expect(report).toHaveBeenCalledWith("publish", expect.objectContaining({ message: "CODING_GIT_RECONCILIATION_REQUIRED" }));
		expect(w.host.endTurn).toHaveBeenCalledTimes(1);
		expect(w.host.detachSession).not.toHaveBeenCalled();
	});

	it("a question blocks the session with its choices and leaves it standing by", async () => {
		const w = world();
		const ask = {
			schema: "qorpera.coding-submission/v1",
			workerId: w.world.claim.workerId,
			sequence: 1,
			kind: "ask",
			state: "submitted",
			summary: "Composer fixed.",
			question: "Keep 250 ms?",
			options: ["Keep 250 ms", "Raise to 500 ms"],
			operationKey: "poll",
		};
		const control = withHook(w.control, endTurnOnPoll(w.world, "completed", ask));
		const executor = new CloudCodingExecutor({ control, host: w.host, owner: "exec-test", turnPollMs: 1 });
		expect(await executor.runOnce(new AbortController().signal)).toBe("blocked");
		expect(w.host.publish).not.toHaveBeenCalled();
		expect(w.host.endTurn).toHaveBeenCalledTimes(1);
		expect(w.host.detachSession).not.toHaveBeenCalled();
		const completion = w.world.calls.find((c) => c.method === "qorpera_complete_coding_turn")!.args;
		expect(completion).toMatchObject({
			p_outcome: "blocked",
			p_needs: "Keep 250 ms?",
			p_options: ["Keep 250 ms", "Raise to 500 ms"],
		});
	});

	it("a turn that ends without a submission, or whose run failed, fails the session visibly", async () => {
		for (const [jobStatus, expected] of [
			["completed", "without a submission"],
			["failed", "did not finish: provider request failed"],
			["cancelled", "stopped before it finished"],
		] as const) {
			const w = world();
			const control = withHook(w.control, endTurnOnPoll(w.world, jobStatus, null));
			const executor = new CloudCodingExecutor({ control, host: w.host, owner: "exec-test", turnPollMs: 1 });
			expect(await executor.runOnce(new AbortController().signal)).toBe("failed");
			const completion = w.world.calls.find((c) => c.method === "qorpera_complete_coding_turn")!.args;
			expect(completion.p_outcome).toBe("failed");
			expect(String(completion.p_summary)).toContain(expected);
			expect(w.host.endTurn).toHaveBeenCalledTimes(1);
			expect(w.host.detachSession).not.toHaveBeenCalled();
		}
	});

	it("a failed workspace preparation unplugs what the turn plugged and asks for recovery, never completion", async () => {
		const w = world();
		vi.mocked(w.host.prepareWorkspace).mockRejectedValueOnce(new Error("CODING_HOST_VM_RECOVERY_REQUIRED"));
		const executor = new CloudCodingExecutor({ control: w.control, host: w.host, owner: "exec-test", turnPollMs: 1 });
		expect(await executor.runOnce(new AbortController().signal)).toBe("recovery-required");
		// The host unplugs only a session this turn plugged and never attached.
		expect(w.host.endTurn).toHaveBeenCalledTimes(1);
		expect(w.host.detachSession).toHaveBeenCalledTimes(1);
		expect(w.world.calls.some((c) => c.method === "qorpera_complete_coding_turn")).toBe(false);
		expect(w.world.calls.some((c) => c.method === "qorpera_begin_coding_turn")).toBe(false);
	});

	it("a workspace the host could not make for a reason it names fails the turn at once, with that reason, under its lease", async () => {
		const w = world();
		// As the wake of 26 Oct 2026 04:41Z (C8 C4-1) would have ended, had its storage stayed slow past the host's tries.
		const failure = new CodingWorkspaceFailed(
			"CODING_HOST_STORAGE_TIMEOUT",
			"The coding machine's storage did not answer in time, so the turn could not start.",
		);
		vi.mocked(w.host.prepareWorkspace).mockRejectedValueOnce(failure);
		const report = vi.fn();
		const executor = new CloudCodingExecutor({
			control: w.control,
			host: w.host,
			owner: "exec-test",
			turnPollMs: 1,
			report,
		});
		expect(await executor.runOnce(new AbortController().signal)).toBe("failed");
		const completion = w.world.calls.find((c) => c.method === "qorpera_complete_coding_turn")!.args;
		expect(completion).toMatchObject({
			p_worker_id: w.world.claim.workerId,
			p_lease_token: w.world.claim.leaseToken,
			p_outcome: "failed",
			p_summary:
				"The coding machine's storage did not answer in time, so the turn could not start. [code=CODING_HOST_STORAGE_TIMEOUT]",
		});
		expect(w.world.phase).toBe("failed");
		// Nothing began; what the turn attached came off first; the log names the code.
		expect(w.world.calls.some((c) => c.method === "qorpera_begin_coding_turn")).toBe(false);
		expect(w.host.endTurn).toHaveBeenCalledTimes(1);
		expect(w.host.detachSession).toHaveBeenCalledTimes(1);
		const completed = vi.mocked(w.control.call).mock.calls.findIndex((c) => c[0] === "qorpera_complete_coding_turn");
		expect(vi.mocked(w.host.detachSession).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(w.control.call).mock.invocationCallOrder[completed]!,
		);
		expect(report.mock.calls).toEqual([["turn", failure]]);
	});

	it("a named workspace failure whose report does not go through leaves the lease to lapse, as any other failure", async () => {
		const w = world();
		vi.mocked(w.host.prepareWorkspace).mockRejectedValueOnce(
			new CodingWorkspaceFailed("CODING_MACHINE_PROJECT_REFUSES_AGENT_CARD", "No computer could start."),
		);
		const inner = w.control.call;
		const control: CodingExecutorControl = {
			call: (method, args, signal) =>
				method === "qorpera_complete_coding_turn"
					? Promise.reject(new Error("Coding session lease unavailable"))
					: inner(method, args, signal),
		};
		const executor = new CloudCodingExecutor({ control, host: w.host, owner: "exec-test", turnPollMs: 1 });
		expect(await executor.runOnce(new AbortController().signal)).toBe("recovery-required");
		expect(w.world.phase).toBe("preparing");
		expect(w.host.detachSession).toHaveBeenCalled();
	});

	it("a refused heartbeat aborts the turn at once and ends it", async () => {
		const w = world();
		let admitted = false;
		let heartbeats = 0;
		const control: CodingExecutorControl = {
			call: (method, args, signal) => {
				if (method === "qorpera_begin_coding_turn") admitted = true;
				if (method === "qorpera_heartbeat_coding_session" && admitted) {
					heartbeats++;
					return Promise.reject(new CodingControlRefused(null));
				}
				return w.control.call(method, args, signal);
			},
		};
		const report = vi.fn();
		const executor = new CloudCodingExecutor({ control, host: w.host, owner: "exec-test", turnPollMs: 50, report });
		const run = executor.runOnce(new AbortController().signal);
		await vi.advanceTimersByTimeAsync(16000);
		expect(await run).toBe("recovery-required");
		// The lease is gone: it is not asked again.
		expect(heartbeats).toBe(1);
		expect(w.host.endTurn).toHaveBeenCalledTimes(1);
		expect(w.host.detachSession).toHaveBeenCalled();
		expect(w.world.calls.some((c) => c.method === "qorpera_complete_coding_turn")).toBe(false);
		// The log names the cause, not whichever await the abort interrupted.
		expect(report.mock.calls.map(([stage, error]) => [stage, (error as Error).message])).toEqual([
			["turn", "CODING_EXECUTOR_LEASE_LOST"],
		]);
	});

	it("a shutdown mid-turn is reported as the shutdown and still ends the turn", async () => {
		const w = world();
		const parent = new AbortController();
		const control: CodingExecutorControl = {
			call: (method, args, signal) => {
				if (method === "qorpera_begin_coding_turn")
					globalThis.setTimeout(() => parent.abort(new Error("CODING_EXECUTOR_SHUTDOWN")), 10);
				return w.control.call(method, args, signal);
			},
		};
		const report = vi.fn();
		const executor = new CloudCodingExecutor({ control, host: w.host, owner: "exec-test", turnPollMs: 50, report });
		const run = executor.runOnce(parent.signal);
		await vi.advanceTimersByTimeAsync(1000);
		expect(await run).toBe("recovery-required");
		expect(w.host.detachSession).toHaveBeenCalledTimes(1);
		expect(report.mock.calls.map(([stage, error]) => [stage, (error as Error).message])).toEqual([
			["turn", "CODING_EXECUTOR_SHUTDOWN"],
		]);
	});

	it("begins the turn again after a busy refusal until it is admitted", async () => {
		// Wake admission is fail-fast on the company row every agent tool call holds (55P03).
		const w = world();
		const finish = {
			schema: "qorpera.coding-submission/v1",
			workerId: w.world.claim.workerId,
			sequence: 1,
			kind: "finish",
			state: "submitted",
			summary: "Tests passed",
			headSha,
			operationKey: "done",
		};
		const inner = withHook(w.control, endTurnOnPoll(w.world, "completed", finish));
		let busy = 3;
		const control: CodingExecutorControl = {
			call: (method, args, signal) => {
				if (method === "qorpera_begin_coding_turn" && busy-- > 0) {
					w.world.calls.push({ method, args });
					return Promise.reject(new CodingControlBusy());
				}
				return inner.call(method, args, signal);
			},
		};
		const report = vi.fn();
		const executor = new CloudCodingExecutor({ control, host: w.host, owner: "exec-test", turnPollMs: 1, report });
		const run = executor.runOnce(new AbortController().signal);
		await vi.advanceTimersByTimeAsync(5000);
		expect(await run).toBe("completed");
		const begins = w.world.calls.filter((c) => c.method === "qorpera_begin_coding_turn");
		expect(begins).toHaveLength(4);
		for (const begin of begins) expect(begin.args).toEqual(begins[0]!.args);
		expect(w.world.calls.filter((c) => c.method === "qorpera_complete_coding_turn")).toHaveLength(1);
		expect(w.host.endTurn).toHaveBeenCalledTimes(1);
		expect(w.host.detachSession).not.toHaveBeenCalled();
		expect(report).not.toHaveBeenCalled();
	});

	it("begins again only after a busy refusal", async () => {
		const w = world();
		const control: CodingExecutorControl = {
			call: (method, args, signal) => {
				if (method !== "qorpera_begin_coding_turn") return w.control.call(method, args, signal);
				w.world.calls.push({ method, args });
				return Promise.reject(new Error("CODING_CONTROL_UNCONFIRMED"));
			},
		};
		const report = vi.fn();
		const executor = new CloudCodingExecutor({ control, host: w.host, owner: "exec-test", turnPollMs: 1, report });
		const run = executor.runOnce(new AbortController().signal);
		await vi.advanceTimersByTimeAsync(5000);
		expect(await run).toBe("recovery-required");
		expect(w.world.calls.filter((c) => c.method === "qorpera_begin_coding_turn")).toHaveLength(1);
		expect(report.mock.calls.map(([stage, error]) => [stage, (error as Error).message])).toEqual([
			["turn", "CODING_CONTROL_UNCONFIRMED"],
		]);
	});

	it("stops beginning again when the lease held at the first busy refusal ends, though heartbeats extend it", async () => {
		const w = world();
		const leaseUntil = Date.parse(w.world.claim.leaseUntil);
		const begins: number[] = [];
		let heartbeats = 0;
		const control: CodingExecutorControl = {
			call: (method, args, signal) => {
				if (method === "qorpera_heartbeat_coding_session") heartbeats++;
				if (method !== "qorpera_begin_coding_turn") return w.control.call(method, args, signal);
				begins.push(Date.now());
				return Promise.reject(new CodingControlBusy());
			},
		};
		const report = vi.fn();
		const executor = new CloudCodingExecutor({ control, host: w.host, owner: "exec-test", turnPollMs: 1, report });
		const run = executor.runOnce(new AbortController().signal);
		await vi.advanceTimersByTimeAsync(70000);
		expect(await run).toBe("recovery-required");
		expect(heartbeats).toBeGreaterThanOrEqual(3);
		expect(begins.length).toBeGreaterThan(20);
		expect(begins.at(-1)!).toBeLessThan(leaseUntil);
		// Short pauses: never back to back, never more than 2 s apart.
		for (let i = 1; i < begins.length; i++) {
			expect(begins[i]! - begins[i - 1]!).toBeGreaterThanOrEqual(125);
			expect(begins[i]! - begins[i - 1]!).toBeLessThanOrEqual(2000);
		}
		expect(report.mock.calls.map(([stage, error]) => [stage, (error as Error).message])).toEqual([
			["turn", "CODING_CONTROL_BUSY"],
		]);
		expect(w.host.detachSession).toHaveBeenCalledTimes(1);
		expect(w.world.calls.some((c) => c.method === "qorpera_complete_coding_turn")).toBe(false);
	});

	it("stops beginning again when the lease is lost", async () => {
		const w = world();
		let lost = 0;
		const begins: number[] = [];
		const control: CodingExecutorControl = {
			call: (method, args, signal) => {
				if (method === "qorpera_heartbeat_coding_session") {
					lost = Date.now();
					return Promise.reject(new CodingControlRefused(null));
				}
				if (method !== "qorpera_begin_coding_turn") return w.control.call(method, args, signal);
				begins.push(Date.now());
				return Promise.reject(new CodingControlBusy());
			},
		};
		const report = vi.fn();
		const executor = new CloudCodingExecutor({ control, host: w.host, owner: "exec-test", turnPollMs: 1, report });
		const run = executor.runOnce(new AbortController().signal);
		await vi.advanceTimersByTimeAsync(20000);
		expect(await run).toBe("recovery-required");
		expect(lost).toBeGreaterThan(0);
		expect(begins.every((at) => at <= lost)).toBe(true);
		expect(report.mock.calls.map(([stage, error]) => [stage, (error as Error).message])).toEqual([
			["turn", "CODING_EXECUTOR_LEASE_LOST"],
		]);
		expect(w.host.detachSession).toHaveBeenCalledTimes(1);
	});

	it("the executor unit outlives the cleanup detach it runs on SIGTERM", async () => {
		const unit = await readFile(
			new URL("../../../deploy/coding-worker/qorpera-coding-executor.service", import.meta.url),
			"utf8",
		);
		const timeouts = [...unit.matchAll(/^TimeoutStopSec=(\d+)s$/gm)];
		expect(timeouts).toHaveLength(1);
		expect(CLEANUP_STOP_BUDGET_MS).toBeGreaterThan(CODING_VM_STOP_BUDGET_MS);
		// A kill between a stop's dispatch and acceptance leaves it recovery-required.
		expect(Number(timeouts[0][1]) * 1000).toBeGreaterThanOrEqual(CLEANUP_STOP_BUDGET_MS + 20_000);
	});

	it("a reporter that throws never changes the outcome or skips the detach", async () => {
		const w = world();
		vi.mocked(w.host.prepareWorkspace).mockRejectedValueOnce(new Error("CODING_HOST_GUEST_NOT_READY"));
		vi.mocked(w.host.detachSession).mockRejectedValueOnce(new Error("CODING_HOST_VM_RECOVERY_REQUIRED"));
		const report = vi.fn((_stage: "turn" | "stop" | "defer", _error: unknown) => {
			throw new Error("log sink down");
		});
		const executor = new CloudCodingExecutor({
			control: w.control,
			host: w.host,
			owner: "exec-test",
			turnPollMs: 1,
			report,
		});
		expect(await executor.runOnce(new AbortController().signal)).toBe("recovery-required");
		expect(w.host.detachSession).toHaveBeenCalledTimes(1);
		expect(report.mock.calls.map(([stage, error]) => [stage, (error as Error).message])).toEqual([
			["turn", "CODING_HOST_GUEST_NOT_READY"],
			["stop", "CODING_HOST_VM_RECOVERY_REQUIRED"],
		]);
	});

	it("a turn whose member's machine is not available yet waits in the queue", async () => {
		const w = world();
		vi.mocked(w.host.prepareWorkspace).mockRejectedValueOnce(new CodingMachineUnavailable("NODE_CAPACITY_EXHAUSTED"));
		const executor = new CloudCodingExecutor({ control: w.control, host: w.host, owner: "exec-test", turnPollMs: 1 });
		expect(await executor.runOnce(new AbortController().signal)).toBe("deferred");
		// Anything attached is unplugged before the session goes back to the queue.
		expect(w.host.detachSession).toHaveBeenCalledTimes(1);
		const deferral = w.world.calls.find((c) => c.method === "qorpera_defer_coding_session")!.args;
		expect(deferral).toEqual({
			p_worker_id: w.world.claim.workerId,
			p_lease_token: w.world.claim.leaseToken,
			p_reason: "NODE_CAPACITY_EXHAUSTED",
		});
		expect(w.world.calls.map((c) => c.method)).not.toContain("qorpera_begin_coding_turn");
		expect(w.world.calls.map((c) => c.method)).not.toContain("qorpera_complete_coding_turn");
		expect(w.world.phase).toBe("queued");
	});

	it("a turn whose company ran out of computer hours before it began waits in the queue", async () => {
		const w = world();
		// Computer hours (20260928319760): begin answers a refusal instead of beginning.
		const control: CodingExecutorControl = {
			call: (method, args, signal) =>
				method === "qorpera_begin_coding_turn"
					? Promise.resolve({ state: "refused", reason: "COMPUTER_HOURS_EXHAUSTED" })
					: w.control.call(method, args, signal),
		};
		const executor = new CloudCodingExecutor({ control, host: w.host, owner: "exec-test", turnPollMs: 1 });
		expect(await executor.runOnce(new AbortController().signal)).toBe("deferred");
		expect(w.host.endTurn).toHaveBeenCalled();
		// An attached session stays with the keeper: nothing is unplugged.
		expect(w.host.detachSession).not.toHaveBeenCalled();
		expect(w.world.calls.find((c) => c.method === "qorpera_defer_coding_session")!.args).toEqual({
			p_worker_id: w.world.claim.workerId,
			p_lease_token: w.world.claim.leaseToken,
			p_reason: "COMPUTER_HOURS_EXHAUSTED",
		});
		expect(w.world.calls.map((c) => c.method)).not.toContain("qorpera_complete_coding_turn");
		expect(w.world.phase).toBe("queued");
	});

	it("a begin refusal for any other reason is never taken for a wait", async () => {
		const w = world();
		const control: CodingExecutorControl = {
			call: (method, args, signal) =>
				method === "qorpera_begin_coding_turn"
					? Promise.resolve({ state: "refused", reason: "NODE_CAPACITY_EXHAUSTED" })
					: w.control.call(method, args, signal),
		};
		const executor = new CloudCodingExecutor({ control, host: w.host, owner: "exec-test", turnPollMs: 1 });
		expect(await executor.runOnce(new AbortController().signal)).toBe("recovery-required");
		expect(w.world.calls.map((c) => c.method)).not.toContain("qorpera_defer_coding_session");
		expect(w.world.calls.map((c) => c.method)).not.toContain("qorpera_complete_coding_turn");
	});

	it("a deferral after an hours refusal that fails is reported and left to recovery", async () => {
		const w = world();
		const report = vi.fn();
		const control: CodingExecutorControl = {
			call: (method, args, signal) =>
				method === "qorpera_begin_coding_turn"
					? Promise.resolve({ state: "refused", reason: "COMPUTER_HOURS_EXHAUSTED" })
					: method === "qorpera_defer_coding_session"
						? Promise.reject(new Error("CODING_CONTROL_UNCONFIRMED"))
						: w.control.call(method, args, signal),
		};
		const executor = new CloudCodingExecutor({ control, host: w.host, owner: "exec-test", turnPollMs: 1, report });
		expect(await executor.runOnce(new AbortController().signal)).toBe("recovery-required");
		expect(report.mock.calls.map(([stage, error]) => [stage, (error as Error).message])).toEqual([
			["defer", "CODING_CONTROL_UNCONFIRMED"],
		]);
		expect(w.world.calls.map((c) => c.method)).not.toContain("qorpera_complete_coding_turn");
	});

	it("a deferral that fails is reported and left to recovery, never completed", async () => {
		const w = world();
		vi.mocked(w.host.prepareWorkspace).mockRejectedValueOnce(new CodingMachineUnavailable("MACHINE_RETIRING"));
		vi.mocked(w.host.detachSession).mockRejectedValueOnce(new Error("CODING_SESSION_DETACH_UNCONFIRMED"));
		const report = vi.fn();
		const control: CodingExecutorControl = {
			call: (method, args, signal) =>
				method === "qorpera_defer_coding_session"
					? Promise.reject(new Error("Coding session lease unavailable"))
					: w.control.call(method, args, signal),
		};
		const executor = new CloudCodingExecutor({ control, host: w.host, owner: "exec-test", turnPollMs: 1, report });
		expect(await executor.runOnce(new AbortController().signal)).toBe("recovery-required");
		expect(report.mock.calls.map(([stage, error]) => [stage, (error as Error).message])).toEqual([
			["stop", "CODING_SESSION_DETACH_UNCONFIRMED"],
			["defer", "Coding session lease unavailable"],
		]);
		expect(w.world.calls.map((c) => c.method)).not.toContain("qorpera_complete_coding_turn");
	});

	it("runs many turns at once and drains them all", async () => {
		const machineId = randomUUID();
		const a = world(machineId),
			b = world(machineId);
		const queue = [a, b];
		const hooks = new Map(
			[a, b].map((w) => [
				w.world.claim.workerId,
				endTurnOnPoll(w.world, "completed", {
					schema: "qorpera.coding-submission/v1",
					workerId: w.world.claim.workerId,
					sequence: 1,
					kind: "ask",
					state: "submitted",
					summary: "Done so far.",
					question: "Continue?",
					options: [],
					operationKey: "ask",
				}),
			]),
		);
		const control: CodingExecutorControl = {
			call: (method, args, signal) => {
				if (method === "qorpera_claim_coding_session") {
					const next = queue.shift();
					return next ? next.control.call(method, args, signal) : Promise.resolve(null);
				}
				hooks.get(String(args.p_worker_id))?.(method);
				return (args.p_worker_id === a.world.claim.workerId ? a : b).control.call(method, args, signal);
			},
		};
		let open: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		const prepare = vi.mocked(a.host.prepareWorkspace).getMockImplementation()!;
		vi.mocked(a.host.prepareWorkspace).mockImplementation(async (...args) => {
			await gate;
			return prepare(...args);
		});
		const executor = new CloudCodingExecutor({ control, host: a.host, owner: "exec-test", turnPollMs: 1 });
		const signal = new AbortController().signal;
		const first = await executor.claim(signal);
		const second = await executor.claim(signal);
		expect(await executor.claim(signal)).toEqual({ state: "idle" });
		expect([first.state, second.state]).toEqual(["claimed", "claimed"]);
		await vi.waitFor(() => expect(a.host.prepareWorkspace).toHaveBeenCalledTimes(2));
		expect(executor.active).toBe(2);
		open?.();
		await executor.drain();
		expect(executor.active).toBe(0);
		expect(a.world.phase).toBe("awaiting_input");
		expect(b.world.phase).toBe("awaiting_input");
		expect(a.host.endTurn).toHaveBeenCalledTimes(2);
		expect(a.host.detachSession).not.toHaveBeenCalled();
	});

	it("hands housekeeping and keeping to the host", async () => {
		const w = world();
		const outcome = { machineId: w.world.machineId, step: "sleep" as const, state: "done" as const };
		vi.mocked(w.host.housekeep).mockResolvedValueOnce([outcome]);
		const kept = {
			machineId: w.world.machineId,
			workerId: randomUUID(),
			step: "keep" as const,
			state: "done" as const,
		};
		vi.mocked(w.host.keep).mockResolvedValueOnce([kept]);
		const executor = new CloudCodingExecutor({ control: w.control, host: w.host, owner: "exec-test" });
		expect(await executor.housekeep(new AbortController().signal)).toEqual([outcome]);
		expect(await executor.keep(new AbortController().signal)).toEqual([kept]);
	});

	it("parses the kernel's claim and turn state strictly", () => {
		const workerId = randomUUID();
		const claim = parseCodingSessionClaim(claimJson(workerId, randomUUID()));
		expect(claim).toMatchObject({
			workerId,
			sequence: 1,
			harness: "codex",
			goal: "Post first, refresh after.",
			followUp: null,
		});
		expect(() => parseCodingSessionClaim(claimJson(workerId, randomUUID(), { branch: "main" }))).toThrow(
			"Invalid coding claim",
		);
		expect(() => parseCodingSessionClaim(claimJson(workerId, randomUUID(), { harness: "cursor" }))).toThrow(
			"Invalid coding claim",
		);
		// Runtime v92: a session takes any number of turns (the claim of turn 65 used to be refused
		// forever while the kernel admitted it).
		expect(parseCodingSessionClaim(claimJson(workerId, randomUUID(), { sequence: 65 })).sequence).toBe(65);
		const turn = parseCodingTurnState(
			{
				schema: "qorpera.coding-turn-state/v1",
				workerId,
				sequence: 1,
				turnId: codingHostId("turn", `${workerId}:1`),
				phase: "running",
				workerState: "active",
				vmAllocationId: randomUUID(),
				storageVolumeId: null,
				baseSha,
				occurrenceId: randomUUID(),
				occurrenceStatus: "materialized",
				runId: randomUUID(),
				jobStatus: "leased",
				jobError: null,
				submission: null,
				pullRequest: null,
			},
			claim,
		);
		expect(turn.jobStatus).toBe("leased");
		expect(() => parseCodingTurnState({ schema: "other" }, claim)).toThrow("Invalid coding turn state");
	});
});

// A slow database (R2, 31 Oct 2026): the S05 coding attempt of 30 Oct ended "lease lost" on one renewal that took
// longer than its 10 s.
describe("the lease and the turn's reads through a slow database", () => {
	// An attempt's own bound runs on the fake clock, as the executor's pauses do.
	beforeEach(() => {
		vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
			const bound = new AbortController();
			globalThis.setTimeout(
				() => bound.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
				ms,
			);
			return bound.signal;
		});
	});
	afterEach(() => vi.restoreAllMocks());

	/** `at` is `ms` from the start, within the fake clock's slack. */
	const near = (at: number | undefined, ms: number) => {
		expect(Math.abs((at ?? Number.NaN) - ms)).toBeLessThan(500);
	};
	/** Each of `ats` is its `ms`, as `near` has it. */
	const timeline = (ats: readonly (number | undefined)[], mss: readonly number[]) => {
		for (const [i, ms] of mss.entries()) near(ats[i], ms);
	};
	/** A call that never answers: it rejects, as the real control does, once its signal aborts. */
	const hang = (signal: AbortSignal) =>
		new Promise<never>((_, reject) => {
			if (signal.aborted) reject(new Error("CODING_CONTROL_UNCONFIRMED"));
			signal.addEventListener("abort", () => reject(new Error("CODING_CONTROL_UNCONFIRMED")), { once: true });
		});
	/** An answer `ms` from now, whatever the call's signal says. */
	const later = <T>(ms: number, answer: () => T) =>
		new Promise<T>((resolve) => globalThis.setTimeout(() => resolve(answer()), ms));
	const renewed = () => new Date(Date.now() + 60000).toISOString();
	const unconfirmed = () => Promise.reject(new Error("CODING_CONTROL_UNCONFIRMED"));

	/** The world's control, each call answered by `answer` (the nth call of its method, from 0; `pass` asks the world),
	 * and the harness's turn ended with a question at the first describe after admission from `endAt` on. Times are
	 * kept from the start. */
	function slow(
		w: ReturnType<typeof world>,
		answer: (call: {
			method: string;
			n: number;
			signal: AbortSignal;
			pass: () => Promise<unknown>;
		}) => Promise<unknown>,
		endAt = Number.POSITIVE_INFINITY,
	) {
		const start = Date.now();
		const inner = withHook(w.control, (method) => {
			if (method !== "qorpera_describe_coding_turn" || w.world.phase !== "running" || w.world.jobStatus) return;
			if (Date.now() - start < endAt) return;
			w.world.jobStatus = "completed";
			w.world.submission = {
				schema: "qorpera.coding-submission/v1",
				workerId: w.world.claim.workerId,
				sequence: 1,
				kind: "ask",
				state: "submitted",
				summary: "Composer fixed.",
				question: "Keep 250 ms?",
				options: [],
				operationKey: "poll",
			};
		});
		const calls: { method: string; at: number; args: Record<string, unknown> }[] = [];
		let ended: number | undefined;
		vi.mocked(w.host.endTurn).mockImplementation(() => {
			ended = Date.now() - start;
		});
		const control: CodingExecutorControl = {
			call: (method, args, signal) => {
				const n = calls.filter((c) => c.method === method).length;
				calls.push({ method, at: Date.now() - start, args });
				return answer({ method, n, signal, pass: () => inner.call(method, args, signal) });
			},
		};
		return {
			control,
			start,
			calls,
			at: (method: string) => calls.filter((c) => c.method === method).map((c) => c.at),
			ended: () => ended,
		};
	}
	const HEARTBEAT = "qorpera_heartbeat_coding_session";
	const DESCRIBE = "qorpera_describe_coding_turn";

	function run(w: ReturnType<typeof world>, control: CodingExecutorControl, turnPollMs = 1000) {
		const report = vi.fn();
		const executor = new CloudCodingExecutor({ control, host: w.host, owner: "exec-test", turnPollMs, report });
		const reported = () => report.mock.calls.map(([stage, error]) => [stage, (error as Error).message]);
		return { outcome: executor.runOnce(new AbortController().signal), reported };
	}

	it("asks a renewal whose answer was lost or late again after a short pause, and the turn goes on under the lease it renewed", async () => {
		const w = world();
		let last: string | undefined;
		const s = slow(
			w,
			({ method, n, signal, pass }) => {
				if (method !== HEARTBEAT) return pass();
				if (n === 0) return unconfirmed();
				// Cut by its own 10 s bound.
				if (n === 1) return hang(signal);
				if (n === 2) return Promise.reject(new CodingControlBusy());
				last = renewed();
				return Promise.resolve(last);
			},
			65000,
		);
		const r = run(w, s.control);
		await vi.advanceTimersByTimeAsync(70000);
		// Past the claim's 60 s: the renewal re-armed the watchdog.
		expect(await r.outcome).toBe("blocked");
		expect(r.reported()).toEqual([]);
		// 15 s, then 2 s after the lost answer, 4 s after the attempt its bound cut, 8 s after the busy one; then 15 s.
		const renewals = s.at(HEARTBEAT);
		expect(renewals).toHaveLength(5);
		timeline(renewals, [15000, 17000, 31000, 39000, 54000]);
		// The same worker, token and lease every time; the turn holds the lease the last renewal confirmed.
		for (const c of s.calls.filter((c) => c.method === HEARTBEAT))
			expect(c.args).toEqual({
				p_worker_id: w.world.claim.workerId,
				p_lease_token: w.world.claim.leaseToken,
				p_lease_seconds: 60,
			});
		expect(vi.mocked(w.host.endTurn).mock.calls[0]![0].leaseUntil).toBe(last);
	});

	it("gives the lease up by the margin before its end when no renewal is answered, every attempt inside it", async () => {
		const w = world();
		const cuts: number[] = [];
		const s = slow(w, ({ method, n, signal, pass }) => {
			if (method !== HEARTBEAT) return pass();
			if (n === 0) return unconfirmed();
			signal.addEventListener("abort", () => cuts.push(Date.now() - s.start), { once: true });
			return hang(signal);
		});
		const r = run(w, s.control);
		await vi.advanceTimersByTimeAsync(60000);
		expect(await r.outcome).toBe("recovery-required");
		// The lease's end less the margin, before the watchdog's deadline: the turn gave it up while it still held it.
		near(s.ended(), 60000 - CODING_LEASE_MARGIN_MS);
		expect(r.reported()).toEqual([["turn", "CODING_EXECUTOR_LEASE_LOST"]]);
		// 15 s; 2 s after the lost answer; 4 s and 8 s after each attempt its 10 s bound cut, the last bound clamped to 6 s.
		const renewals = s.at(HEARTBEAT);
		expect(renewals).toHaveLength(4);
		timeline(renewals, [15000, 17000, 31000, 49000]);
		timeline(cuts, [27000, 41000, 55000]);
		expect(s.calls.every((c) => c.at <= 55000 + 500)).toBe(true);
		expect(w.world.calls.some((c) => c.method === "qorpera_complete_coding_turn")).toBe(false);
	});

	it("gives the lease up at once when a renewal is refused, however many were lost before it", async () => {
		const w = world();
		const s = slow(w, ({ method, n, pass }) =>
			method !== HEARTBEAT ? pass() : n === 0 ? unconfirmed() : Promise.reject(new CodingControlRefused(null)),
		);
		const r = run(w, s.control);
		await vi.advanceTimersByTimeAsync(30000);
		expect(await r.outcome).toBe("recovery-required");
		expect(r.reported()).toEqual([["turn", "CODING_EXECUTOR_LEASE_LOST"]]);
		const renewals = s.at(HEARTBEAT);
		expect(renewals).toHaveLength(2);
		near(renewals[1], 17000);
		near(s.ended(), 17000);
	});

	it("drops a renewal's late answer: it moves no lease, and nothing runs after the turn gave the lease up", async () => {
		const w = world();
		const first = w.world.claim.leaseUntil;
		const answered: number[] = [];
		// A control that ignores its signal and answers 15 s later, each time with a renewed lease.
		const s = slow(w, ({ method, pass }) =>
			method !== HEARTBEAT
				? pass()
				: later(15000, () => {
						answered.push(Date.now() - s.start);
						return renewed();
					}),
		);
		const r = run(w, s.control);
		await vi.advanceTimersByTimeAsync(80000);
		expect(await r.outcome).toBe("recovery-required");
		expect(r.reported()).toEqual([["turn", "CODING_EXECUTOR_LEASE_LOST"]]);
		near(s.ended(), 55000);
		// Each attempt was cut by its bound before it answered; the last answered after the turn had ended.
		timeline(s.at(HEARTBEAT), [15000, 27000, 41000]);
		timeline(answered, [30000, 42000, 56000]);
		expect(s.at(HEARTBEAT)).toHaveLength(3);
		expect(vi.mocked(w.host.endTurn).mock.calls[0]![0].leaseUntil).toBe(first);
		expect(s.calls.every((c) => c.at <= 55000 + 500)).toBe(true);
	});

	it("renews one at a time: a slow renewal holds the next one back, which starts 15 s after it settled", async () => {
		const w = world();
		let inFlight = 0;
		let most = 0;
		const settled: number[] = [];
		const s = slow(
			w,
			({ method, pass }) => {
				if (method !== HEARTBEAT) return pass();
				most = Math.max(most, ++inFlight);
				return later(9000, () => {
					inFlight--;
					settled.push(Date.now() - s.start);
					return renewed();
				});
			},
			100000,
		);
		const r = run(w, s.control);
		await vi.advanceTimersByTimeAsync(105000);
		expect(await r.outcome).toBe("blocked");
		expect(most).toBe(1);
		const renewals = s.at(HEARTBEAT);
		expect(renewals).toHaveLength(4);
		timeline(renewals, [15000, 39000, 63000, 87000]);
		for (let i = 1; i < renewals.length; i++) near(renewals[i]! - settled[i - 1]!, 15000);
	});

	it("counts the lease down on this node's clock too: a database clock 10 s ahead never stretches the retries", async () => {
		const w = world();
		// The database's clock runs 10 s ahead of this node's: its 60 s leases end 70 s from now here.
		w.world.claim.leaseUntil = new Date(Date.now() + 70000).toISOString();
		const s = slow(w, ({ method, n, pass }) =>
			method !== HEARTBEAT
				? pass()
				: n === 0
					? Promise.resolve(new Date(Date.now() + 70000).toISOString())
					: unconfirmed(),
		);
		const r = run(w, s.control);
		await vi.advanceTimersByTimeAsync(90000);
		expect(await r.outcome).toBe("recovery-required");
		expect(r.reported()).toEqual([["turn", "CODING_EXECUTOR_LEASE_LOST"]]);
		// 60 s after the renewal was sent, less the margin; not the database's 70 s, and not its watchdog.
		near(s.ended(), 15000 + 60000 - CODING_LEASE_MARGIN_MS);
		const renewals = s.at(HEARTBEAT);
		timeline(renewals, [15000, 30000, 32000, 36000, 44000, 52000, 60000, 68000]);
		expect(renewals).toHaveLength(8);
	});

	it("asks a describe whose answer was lost or late again within its own budget, and the turn goes on", async () => {
		const w = world();
		const s = slow(
			w,
			({ method, n, signal, pass }) =>
				method !== DESCRIBE || n > 1 ? pass() : n === 0 ? unconfirmed() : hang(signal),
			20000,
		);
		const r = run(w, s.control);
		await vi.advanceTimersByTimeAsync(25000);
		expect(await r.outcome).toBe("blocked");
		expect(r.reported()).toEqual([]);
		// 2 s after the lost answer, then 4 s after the attempt its 10 s bound cut.
		timeline(s.at(DESCRIBE), [0, CODING_RETRY_PAUSES_MS[0], 12000 + CODING_RETRY_PAUSES_MS[1]]);
		expect(w.host.prepareWorkspace).toHaveBeenCalledTimes(1);
	});

	it("never asks a refused describe again", async () => {
		const w = world();
		const s = slow(w, ({ method, pass }) =>
			method === DESCRIBE && w.world.phase === "running" ? Promise.reject(new CodingControlRefused(null)) : pass(),
		);
		const r = run(w, s.control);
		await vi.advanceTimersByTimeAsync(10000);
		expect(await r.outcome).toBe("recovery-required");
		expect(r.reported()).toEqual([["turn", "CODING_CONTROL_REFUSED"]]);
		// The one before the workspace, and the refused one.
		expect(s.at(DESCRIBE)).toHaveLength(2);
		expect(w.world.calls.some((c) => c.method === "qorpera_complete_coding_turn")).toBe(false);
	});

	it("ends the turn when a describe stays lost past its budget", async () => {
		const w = world();
		const s = slow(w, ({ method, pass }) =>
			method === DESCRIBE && w.world.phase === "running" ? unconfirmed() : pass(),
		);
		const r = run(w, s.control);
		await vi.advanceTimersByTimeAsync(40000);
		expect(await r.outcome).toBe("recovery-required");
		expect(r.reported()).toEqual([["turn", "CODING_CONTROL_UNCONFIRMED"]]);
		const [, first, ...rest] = s.at(DESCRIBE);
		// 2, 4, 8 and 8 s apart; the next pause would end past the budget.
		timeline(
			rest.map((at) => at - first!),
			[2000, 6000, 14000, 22000],
		);
		expect(rest).toHaveLength(4);
		near(s.ended()! - first!, 22000);
		expect(s.ended()! - first!).toBeLessThan(CODING_DESCRIBE_BUDGET_MS);
	});

	it("a lost lease cancels a describe's retries at once", async () => {
		const w = world();
		const s = slow(w, ({ method, pass }) =>
			method === HEARTBEAT
				? Promise.reject(new CodingControlRefused(null))
				: method === DESCRIBE && w.world.phase === "running"
					? unconfirmed()
					: pass(),
		);
		const r = run(w, s.control, 2000);
		await vi.advanceTimersByTimeAsync(30000);
		expect(await r.outcome).toBe("recovery-required");
		expect(r.reported()).toEqual([["turn", "CODING_EXECUTOR_LEASE_LOST"]]);
		near(s.ended(), 15000);
		// The describe's pause from 8 s to 16 s was cut at the refusal; nothing was asked after it.
		timeline(s.at(DESCRIBE).slice(1), [2000, 4000, 8000]);
		expect(s.at(DESCRIBE)).toHaveLength(4);
	});

	it("polls one describe at a time: a describe still asking holds the next poll back", async () => {
		const w = world();
		let inFlight = 0;
		let most = 0;
		const settled: number[] = [];
		const s = slow(
			w,
			({ method, n, signal, pass }) => {
				if (method !== DESCRIBE || n === 0) return pass();
				most = Math.max(most, ++inFlight);
				// The first poll's describe is cut by its bound, and asked again; that answer takes 3 s.
				const answer = n === 1 ? hang(signal) : n === 2 ? later(3000, () => undefined).then(pass) : pass();
				return answer.finally(() => {
					inFlight--;
					settled.push(Date.now() - s.start);
				});
			},
			25000,
		);
		const r = run(w, s.control, 2000);
		await vi.advanceTimersByTimeAsync(30000);
		expect(await r.outcome).toBe("blocked");
		expect(most).toBe(1);
		const [, ...polls] = s.at(DESCRIBE);
		timeline(polls, [2000, 14000, 19000, 21000, 23000, 25000]);
		// The next poll waits its 2 s from the moment the describe and its retries settled.
		near(polls[2]! - settled[1]!, 2000);
	});
});
