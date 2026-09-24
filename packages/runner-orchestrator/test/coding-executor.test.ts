import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CloudCodingExecutor,
	type CodingExecutorControl,
	type CodingExecutorHost,
	type CodingSessionClaim,
	type CodingSubmission,
	type CodingTurnState,
	parseCodingSessionClaim,
	parseCodingTurnState,
} from "../src/coding-executor.ts";
import { codingHostId } from "../src/coding-executor-host.ts";

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
	calls: { method: string; args: Record<string, unknown> }[];
}

function world(): {
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
			vmId: turn.vmAllocationId ?? codingHostId("allocation", workerId),
			baseSha,
		})),
		refreshLease: vi.fn(async () => {}),
		publish: vi.fn(async (_claim: CodingSessionClaim, submission: Extract<CodingSubmission, { kind: "finish" }>) => ({
			pullRequest: { url: "https://github.com/Qorpera/app/pull/12", number: 12, headSha: submission.headSha },
			noChange: false,
		})),
		stopWorkspace: vi.fn(async () => {}),
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
			p_vm_allocation_id: codingHostId("allocation", w.world.claim.workerId),
		});
		const begun = w.world.calls.find((c) => c.method === "qorpera_begin_coding_turn")!.args;
		expect(begun.p_coding).toEqual({
			vmId: codingHostId("allocation", w.world.claim.workerId),
			turnId: codingHostId("turn", `${w.world.claim.workerId}:1`),
		});
		expect(w.host.publish).toHaveBeenCalledTimes(1);
		expect(w.host.stopWorkspace).toHaveBeenCalledTimes(1);
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

	it("a question blocks the session with its choices and stops the VM", async () => {
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
		expect(w.host.stopWorkspace).toHaveBeenCalledTimes(1);
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
			expect(w.host.stopWorkspace).toHaveBeenCalledTimes(1);
		}
	});

	it("a failed workspace preparation stops what it can and asks for recovery, never completion", async () => {
		const w = world();
		vi.mocked(w.host.prepareWorkspace).mockRejectedValueOnce(new Error("CODING_HOST_VM_RECOVERY_REQUIRED"));
		const executor = new CloudCodingExecutor({ control: w.control, host: w.host, owner: "exec-test", turnPollMs: 1 });
		expect(await executor.runOnce(new AbortController().signal)).toBe("recovery-required");
		expect(w.host.stopWorkspace).toHaveBeenCalledTimes(1);
		expect(w.world.calls.some((c) => c.method === "qorpera_complete_coding_turn")).toBe(false);
		expect(w.world.calls.some((c) => c.method === "qorpera_begin_coding_turn")).toBe(false);
	});

	it("a lost heartbeat aborts the turn and requests physical stop", async () => {
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
		const executor = new CloudCodingExecutor({ control, host: w.host, owner: "exec-test", turnPollMs: 50 });
		const run = executor.runOnce(new AbortController().signal);
		await vi.advanceTimersByTimeAsync(16000);
		expect(await run).toBe("recovery-required");
		expect(w.host.stopWorkspace).toHaveBeenCalled();
		expect(w.world.calls.some((c) => c.method === "qorpera_complete_coding_turn")).toBe(false);
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
