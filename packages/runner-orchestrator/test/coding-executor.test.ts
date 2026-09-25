import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CLEANUP_STOP_BUDGET_MS,
	CloudCodingExecutor,
	CodingControlBusy,
	type CodingExecutorControl,
	type CodingExecutorHost,
	CodingMachineUnavailable,
	type CodingSessionClaim,
	type CodingSubmission,
	type CodingTurnState,
	parseCodingSessionClaim,
	parseCodingTurnState,
} from "../src/coding-executor.ts";
import { CODING_VM_STOP_BUDGET_MS, codingHostId } from "../src/coding-executor-host.ts";

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
		refreshLease: vi.fn(async () => {}),
		publish: vi.fn(async (_claim: CodingSessionClaim, submission: Extract<CodingSubmission, { kind: "finish" }>) => ({
			pullRequest: { url: "https://github.com/Qorpera/app/pull/12", number: 12, headSha: submission.headSha },
			noChange: false,
		})),
		detachSession: vi.fn(async () => {}),
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
		expect(w.host.detachSession).toHaveBeenCalledTimes(1);
		// The session's folders are unplugged before the kernel hears the outcome.
		const calls = vi.mocked(w.control.call).mock;
		const completed = calls.calls.findIndex((c) => c[0] === "qorpera_complete_coding_turn");
		expect(vi.mocked(w.host.detachSession).mock.invocationCallOrder[0]).toBeLessThan(
			calls.invocationCallOrder[completed]!,
		);
		expect(vi.mocked(w.host.publish).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(w.host.detachSession).mock.invocationCallOrder[0]!,
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

	it("a question blocks the session with its choices and detaches it", async () => {
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
		expect(w.host.detachSession).toHaveBeenCalledTimes(1);
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
			expect(w.host.detachSession).toHaveBeenCalledTimes(1);
		}
	});

	it("a failed workspace preparation detaches what it can and asks for recovery, never completion", async () => {
		const w = world();
		vi.mocked(w.host.prepareWorkspace).mockRejectedValueOnce(new Error("CODING_HOST_VM_RECOVERY_REQUIRED"));
		const executor = new CloudCodingExecutor({ control: w.control, host: w.host, owner: "exec-test", turnPollMs: 1 });
		expect(await executor.runOnce(new AbortController().signal)).toBe("recovery-required");
		expect(w.host.detachSession).toHaveBeenCalledTimes(1);
		expect(w.world.calls.some((c) => c.method === "qorpera_complete_coding_turn")).toBe(false);
		expect(w.world.calls.some((c) => c.method === "qorpera_begin_coding_turn")).toBe(false);
	});

	it("a lost heartbeat aborts the turn and detaches the session", async () => {
		const w = world();
		let admitted = false;
		const control: CodingExecutorControl = {
			call: (method, args, signal) => {
				if (method === "qorpera_begin_coding_turn") admitted = true;
				if (method === "qorpera_heartbeat_coding_session" && admitted)
					return Promise.reject(new Error("lease gone"));
				return w.control.call(method, args, signal);
			},
		};
		const report = vi.fn();
		const executor = new CloudCodingExecutor({ control, host: w.host, owner: "exec-test", turnPollMs: 50, report });
		const run = executor.runOnce(new AbortController().signal);
		await vi.advanceTimersByTimeAsync(16000);
		expect(await run).toBe("recovery-required");
		expect(w.host.detachSession).toHaveBeenCalled();
		expect(w.world.calls.some((c) => c.method === "qorpera_complete_coding_turn")).toBe(false);
		// The log names the cause, not whichever await the abort interrupted.
		expect(report.mock.calls.map(([stage, error]) => [stage, (error as Error).message])).toEqual([
			["turn", "CODING_EXECUTOR_LEASE_LOST"],
		]);
	});

	it("a shutdown mid-turn is reported as the shutdown and still detaches the session", async () => {
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
		expect(w.host.detachSession).toHaveBeenCalledTimes(1);
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
					return Promise.reject(new Error("Coding session lease unavailable"));
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
		expect(a.host.detachSession).toHaveBeenCalledTimes(2);
	});

	it("hands housekeeping to the host", async () => {
		const w = world();
		const outcome = { machineId: w.world.machineId, step: "sleep" as const, state: "done" as const };
		vi.mocked(w.host.housekeep).mockResolvedValueOnce([outcome]);
		const executor = new CloudCodingExecutor({ control: w.control, host: w.host, owner: "exec-test" });
		expect(await executor.housekeep(new AbortController().signal)).toEqual([outcome]);
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
