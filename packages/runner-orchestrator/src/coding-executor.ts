import { setTimeout } from "node:timers/promises";
import {
	type CloudCodingPullRequest,
	type CloudCodingRepository,
	parseCloudCodingPullRequest,
	parseCloudCodingRepository,
} from "@qorpera/contracts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA40 = /^[0-9a-f]{40}$/;
/** Failure-path cleanup: the custody lookups (normally well under a second)
 * plus stopping the session's commands in the guest and unplugging its
 * folders. The executor unit's TimeoutStopSec must stay well above it. */
export const CLEANUP_STOP_BUDGET_MS = 45_000;
export const CODING_EXECUTOR_RPCS = [
	"qorpera_claim_coding_session",
	"qorpera_heartbeat_coding_session",
	"qorpera_record_coding_progress",
	"qorpera_begin_coding_turn",
	"qorpera_describe_coding_turn",
	"qorpera_complete_coding_turn",
	"qorpera_defer_coding_session",
] as const;
/** The turn cannot have its member's machine yet (a full node, a machine being
 * removed, the session still on another machine): it waits in the queue. */
export class CodingMachineUnavailable extends Error {
	readonly reason: string;
	constructor(reason: string) {
		super(`CODING_MACHINE_UNAVAILABLE:${reason}`);
		this.reason = reason;
	}
}
/** One housekeeping step on one machine, for the executor's log. */
export interface CodingHousekeepingOutcome {
	machineId: string;
	step: "sleep" | "delete";
	state: "done" | "not-now" | "failed";
	code?: string;
}
export interface CodingExecutorControl {
	call(
		method: (typeof CODING_EXECUTOR_RPCS)[number],
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown>;
}

/** One leased turn of a coding session, as qorpera_claim_coding_session hands it out. */
export interface CodingSessionClaim {
	workerId: string;
	leaseToken: string;
	leaseUntil: string;
	sequence: number;
	profileId: string;
	environmentId: string;
	agentId: string;
	ownerUserId: string;
	harness: "codex" | "claude-code";
	model: string | null;
	repository: CloudCodingRepository;
	branch: string;
	baseSha: string | null;
	harnessSessionRef: string | null;
	pullRequest: CloudCodingPullRequest | null;
	title: string;
	goal: string;
	definitionOfDone: string;
	context: string;
	followUp: string | null;
}

/** What the harness left behind at the end of its turn (qorpera_submit_coding_turn). */
export type CodingSubmission =
	| { kind: "finish"; summary: string; headSha: string; operationKey: string }
	| { kind: "ask"; summary: string; question: string; options: string[]; operationKey: string };

/** The turn as qorpera_describe_coding_turn reports it. */
export interface CodingTurnState {
	workerId: string;
	sequence: number;
	turnId: string;
	phase: string;
	workerState: string;
	vmAllocationId: string | null;
	storageVolumeId: string | null;
	baseSha: string | null;
	occurrenceId: string | null;
	occurrenceStatus: string | null;
	runId: string | null;
	jobStatus: string | null;
	jobError: string | null;
	submission: CodingSubmission | null;
	pullRequest: CloudCodingPullRequest | null;
}

export interface CodingWorkspace {
	vmId: string;
	baseSha: string;
}
export interface CodingExecutorPublication {
	readonly pullRequest: CloudCodingPullRequest | null;
	/** True only after a trusted comparison against the pinned original head. */
	readonly noChange: boolean;
}
export interface CodingExecutorHost {
	/** Plan and wake the member's coding machine on genuine node capacity, attach
	 * the session's NAS folders and seed a credential-free checkout exactly once.
	 * Resolves with the machine and the pinned base; nothing calls the model
	 * before this resolves. Throws CodingMachineUnavailable when the turn must
	 * wait for its machine. */
	prepareWorkspace(claim: CodingSessionClaim, turn: CodingTurnState, signal: AbortSignal): Promise<CodingWorkspace>;
	/** Refresh the guest monotonic lease only from the confirmed SQL deadline;
	 * never beyond the remaining session lease. */
	refreshLease(claim: CodingSessionClaim, signal: AbortSignal): Promise<void>;
	/** Quiesce guest commands, export the submitted commit as a bundle, validate
	 * and push it through the broker and create or verify the draft PR. Keeps its
	 * own effect journals across restarts. */
	publish(
		claim: CodingSessionClaim,
		submission: Extract<CodingSubmission, { kind: "finish" }>,
		signal: AbortSignal,
	): Promise<CodingExecutorPublication>;
	/** The end of the turn: stop the session's commands, flush the guest and
	 * unplug the session's folders, with or without the lease. The machine keeps
	 * running for the member's other sessions and sleeps later. */
	detachSession(claim: CodingSessionClaim, signal: AbortSignal): Promise<void>;
	/** Sleep idle machines, remove the ones due, retire kept per-session VMs and
	 * close released ones; every failure is recorded and returned. */
	housekeep(signal: AbortSignal): Promise<CodingHousekeepingOutcome[]>;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(label);
	return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 8192): string {
	if (typeof value !== "string" || Buffer.byteLength(value) > maximum) throw new Error("Invalid coding claim");
	return value;
}
function optionalText(value: unknown, maximum = 8192): string | null {
	return value === null || value === undefined ? null : text(value, maximum);
}

export function parseCodingSessionClaim(value: unknown): CodingSessionClaim {
	const item = record(value, "Invalid coding claim");
	const dispatch = record(item.dispatch, "Invalid coding claim");
	if (
		item.schema !== "qorpera.coding-session-claim/v1" ||
		![item.workerId, item.leaseToken, item.profileId, item.environmentId, item.agentId, item.ownerUserId].every(
			(id) => typeof id === "string" && UUID.test(id),
		) ||
		typeof item.leaseUntil !== "string" ||
		!Number.isFinite(Date.parse(item.leaseUntil)) ||
		Date.parse(item.leaseUntil) <= Date.now() ||
		!Number.isSafeInteger(item.sequence) ||
		Number(item.sequence) < 1 ||
		(item.harness !== "codex" && item.harness !== "claude-code") ||
		typeof item.branch !== "string" ||
		item.branch !== `qorpera/coding/${item.workerId}` ||
		(item.baseSha !== null && item.baseSha !== undefined && !SHA40.test(String(item.baseSha))) ||
		typeof dispatch.goal !== "string" ||
		!dispatch.goal.trim()
	)
		throw new Error("Invalid coding claim");
	return {
		workerId: String(item.workerId),
		leaseToken: String(item.leaseToken),
		leaseUntil: item.leaseUntil,
		sequence: Number(item.sequence),
		profileId: String(item.profileId),
		environmentId: String(item.environmentId),
		agentId: String(item.agentId),
		ownerUserId: String(item.ownerUserId),
		harness: item.harness,
		model: optionalText(item.model, 96),
		repository: parseCloudCodingRepository(item.repository),
		branch: item.branch,
		baseSha: item.baseSha === undefined ? null : (item.baseSha as string | null),
		harnessSessionRef: optionalText(item.harnessSessionRef, 512),
		pullRequest:
			item.pullRequest === null || item.pullRequest === undefined
				? null
				: parseCloudCodingPullRequest(item.pullRequest, parseCloudCodingRepository(item.repository)),
		title: text(item.title, 400),
		goal: text(dispatch.goal),
		definitionOfDone: text(dispatch.definitionOfDone ?? "", 4000),
		context: text(dispatch.context ?? "", 16384),
		followUp: optionalText(item.followUp, 8192),
	};
}

export function parseCodingSubmission(value: unknown): CodingSubmission | null {
	if (value === null || value === undefined) return null;
	const item = record(value, "Invalid coding submission");
	if (
		item.schema !== "qorpera.coding-submission/v1" ||
		item.state !== "submitted" ||
		typeof item.summary !== "string" ||
		typeof item.operationKey !== "string"
	)
		throw new Error("Invalid coding submission");
	if (item.kind === "finish") {
		if (typeof item.headSha !== "string" || !SHA40.test(item.headSha)) throw new Error("Invalid coding submission");
		return { kind: "finish", summary: item.summary, headSha: item.headSha, operationKey: item.operationKey };
	}
	if (item.kind === "ask") {
		if (typeof item.question !== "string" || !item.question.trim()) throw new Error("Invalid coding submission");
		const options = Array.isArray(item.options) ? item.options.filter((o): o is string => typeof o === "string") : [];
		return { kind: "ask", summary: item.summary, question: item.question, options, operationKey: item.operationKey };
	}
	throw new Error("Invalid coding submission");
}

export function parseCodingTurnState(
	value: unknown,
	claim: Pick<CodingSessionClaim, "workerId" | "sequence" | "repository">,
): CodingTurnState {
	const item = record(value, "Invalid coding turn state");
	const optionalUuid = (v: unknown) =>
		v === null || v === undefined ? null : UUID.test(String(v)) ? String(v) : undefined;
	const vmAllocationId = optionalUuid(item.vmAllocationId);
	const storageVolumeId = optionalUuid(item.storageVolumeId);
	const occurrenceId = optionalUuid(item.occurrenceId);
	const runId = optionalUuid(item.runId);
	if (
		item.schema !== "qorpera.coding-turn-state/v1" ||
		item.workerId !== claim.workerId ||
		item.sequence !== claim.sequence ||
		typeof item.turnId !== "string" ||
		!UUID.test(item.turnId) ||
		typeof item.phase !== "string" ||
		typeof item.workerState !== "string" ||
		[vmAllocationId, storageVolumeId, occurrenceId, runId].includes(undefined) ||
		(item.baseSha !== null && item.baseSha !== undefined && !SHA40.test(String(item.baseSha)))
	)
		throw new Error("Invalid coding turn state");
	return {
		workerId: claim.workerId,
		sequence: claim.sequence,
		turnId: item.turnId,
		phase: item.phase,
		workerState: item.workerState,
		vmAllocationId: vmAllocationId ?? null,
		storageVolumeId: storageVolumeId ?? null,
		baseSha: (item.baseSha as string | null | undefined) ?? null,
		occurrenceId: occurrenceId ?? null,
		occurrenceStatus: optionalText(item.occurrenceStatus, 64),
		runId: runId ?? null,
		jobStatus: optionalText(item.jobStatus, 64),
		jobError: optionalText(item.jobError, 4000),
		submission: parseCodingSubmission(item.submission),
		pullRequest:
			item.pullRequest === null || item.pullRequest === undefined
				? null
				: parseCloudCodingPullRequest(item.pullRequest, claim.repository),
	};
}

/** A turn's run has ended when its job did, or when the wake never produced one. */
function turnEnded(turn: CodingTurnState): boolean {
	if (turn.jobStatus) return ["completed", "failed", "cancelled"].includes(turn.jobStatus);
	return ["failed", "cancelled", "refused", "expired", "skipped"].includes(turn.occurrenceStatus ?? "");
}

export type CodingTurnOutcome = "completed" | "blocked" | "failed" | "deferred" | "recovery-required";

/** Claims coding session turns and runs each to its end, many at once: every
 * member's sessions share that member's machine, and the node's capacity is
 * the only bound. Native model activity, machine custody, Git publication and
 * the kernel's completion have different receipts; none is inferred from
 * another. The host composes the real LXD/Git adapters. A lost lease aborts a
 * turn's work, and its session is detached under separate custody. */
export class CloudCodingExecutor {
	readonly #control: CodingExecutorControl;
	readonly #host: CodingExecutorHost;
	readonly #owner: string;
	readonly #turnPollMs: number;
	readonly #report: ((stage: "turn" | "stop" | "defer", error: unknown) => void) | undefined;
	readonly #turns = new Set<Promise<CodingTurnOutcome>>();
	constructor(options: {
		control: CodingExecutorControl;
		host: CodingExecutorHost;
		owner: string;
		turnPollMs?: number;
		/** Observability only: which stage failed and with what error, before
		 * recovery. Never decides anything; the kernel receipts do. */
		report?: (stage: "turn" | "stop" | "defer", error: unknown) => void;
	}) {
		if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(options.owner)) throw new Error("Invalid coding executor owner");
		this.#control = options.control;
		this.#host = options.host;
		this.#owner = options.owner;
		this.#turnPollMs = options.turnPollMs ?? 2000;
		this.#report = options.report;
	}
	/** Observability must never change the outcome: a throwing reporter is ignored. */
	#reported(stage: "turn" | "stop" | "defer", error: unknown): void {
		try {
			this.#report?.(stage, error);
		} catch {
			/* ignored */
		}
	}
	/** The turns still running. */
	get active(): number {
		return this.#turns.size;
	}
	/** Claims one turn and starts it; it runs on beside the others. Resolves
	 * "idle" when nothing is claimable, else with the running turn's outcome. */
	async claim(
		signal: AbortSignal,
	): Promise<{ state: "idle" } | { state: "claimed"; turn: Promise<CodingTurnOutcome> }> {
		const value = await this.#control.call(
			"qorpera_claim_coding_session",
			{ p_owner: this.#owner, p_lease_seconds: 60 },
			AbortSignal.any([signal, AbortSignal.timeout(10000)]),
		);
		if (value === null) return { state: "idle" };
		const claim = parseCodingSessionClaim(value);
		const turn = this.#turn(claim, signal);
		this.#turns.add(turn);
		void turn.finally(() => this.#turns.delete(turn)).catch(() => undefined);
		return { state: "claimed", turn };
	}
	/** Every running turn has ended (after a shutdown, each detaches its session). */
	async drain(): Promise<void> {
		await Promise.allSettled([...this.#turns]);
	}
	housekeep(signal: AbortSignal): Promise<CodingHousekeepingOutcome[]> {
		return this.#host.housekeep(signal);
	}
	/** One turn, serially: it claims nothing else. */
	async runOnce(signal: AbortSignal): Promise<"idle" | CodingTurnOutcome> {
		const claimed = await this.claim(signal);
		return claimed.state === "idle" ? "idle" : claimed.turn;
	}
	async #turn(claim: CodingSessionClaim, signal: AbortSignal): Promise<CodingTurnOutcome> {
		const stop = new AbortController();
		const heartbeatStop = new AbortController();
		const active = AbortSignal.any([signal, stop.signal]);
		let heartbeat: Promise<void> | undefined;
		let workspaceReady = false;
		let leaseRefresh = Promise.resolve();
		let watchdog: ReturnType<typeof globalThis.setTimeout> | undefined;
		const arm = (deadline: string) => {
			const milliseconds = Date.parse(deadline) - Date.now();
			if (!Number.isFinite(milliseconds) || milliseconds < 1 || milliseconds > 305000)
				throw new Error("Invalid coding lease deadline");
			clearTimeout(watchdog);
			// Coded reasons: whatever the abort interrupts reports why (errorCode).
			watchdog = globalThis.setTimeout(() => stop.abort(new Error("CODING_EXECUTOR_LEASE_EXPIRED")), milliseconds);
		};
		const call = (method: (typeof CODING_EXECUTOR_RPCS)[number], args: Record<string, unknown>, checked = active) =>
			this.#control.call(method, args, AbortSignal.any([checked, AbortSignal.timeout(10000)]));
		try {
			const claimed = claim;
			const args = { p_worker_id: claim.workerId, p_lease_token: claim.leaseToken };
			const refresh = () => {
				leaseRefresh = leaseRefresh.then(async () => {
					if (workspaceReady) await this.#host.refreshLease(claimed, active);
				});
				return leaseRefresh;
			};
			arm(claim.leaseUntil);
			heartbeat = (async () => {
				const checked = AbortSignal.any([active, heartbeatStop.signal]);
				try {
					while (!checked.aborted) {
						await setTimeout(15000, undefined, { signal: checked });
						const until = await call(
							"qorpera_heartbeat_coding_session",
							{ ...args, p_lease_seconds: 60 },
							checked,
						);
						if (typeof until !== "string") throw new Error("Coding heartbeat unconfirmed");
						arm(until);
						claimed.leaseUntil = until;
						if (workspaceReady) await refresh();
					}
				} catch {
					if (!heartbeatStop.signal.aborted) stop.abort(new Error("CODING_EXECUTOR_LEASE_LOST"));
				}
			})();
			const describe = async () => parseCodingTurnState(await call("qorpera_describe_coding_turn", args), claimed);
			const progress = (extra: Record<string, unknown>) =>
				call("qorpera_record_coding_progress", { ...args, ...extra });
			const complete = async (
				outcome: "succeeded" | "blocked" | "failed",
				summary: string,
				extra: Record<string, unknown> = {},
			) => {
				active.throwIfAborted();
				const view = record(
					await call("qorpera_complete_coding_turn", {
						...args,
						p_outcome: outcome,
						p_summary: summary.slice(0, 4000),
						p_needs: null,
						p_pull_request: null,
						p_checks: null,
						p_artifacts: null,
						p_harness_session_ref: null,
						p_files_changed: null,
						p_options: null,
						...extra,
					}),
					"Coding completion unconfirmed",
				);
				if (view.workerId !== claimed.workerId) throw new Error("Coding completion unconfirmed");
			};
			// The end of every turn: stop the session's commands and unplug its
			// folders before the kernel hears the outcome.
			const detach = async () => {
				workspaceReady = false;
				await leaseRefresh;
				await this.#host.detachSession(claimed, active);
			};

			// 1. The workspace: the member's machine, the session's NAS folders, pinned base, seeded checkout.
			let turn = await describe();
			if (turn.phase !== "preparing") throw new Error("Coding turn is not preparing");
			let workspace: CodingWorkspace;
			try {
				workspace = await this.#host.prepareWorkspace(claimed, turn, active);
			} catch (error) {
				if (!(error instanceof CodingMachineUnavailable) || active.aborted) throw error;
				// Nothing ran yet: unplug whatever was attached, then wait in the queue.
				try {
					await this.#host.detachSession(claimed, active);
				} catch (detachError) {
					this.#reported("stop", detachError);
				}
				try {
					await call("qorpera_defer_coding_session", { ...args, p_reason: error.reason });
				} catch (deferError) {
					// The lease lapses; the session then fails visibly, never silently.
					this.#reported("defer", deferError);
					return "recovery-required";
				}
				return "deferred";
			}
			workspaceReady = true;
			await refresh();
			await progress({
				p_last_step: "Workspace ready",
				p_vm_allocation_id: workspace.vmId,
				p_base_sha: workspace.baseSha,
				p_events: [
					{
						kind: "step",
						actor: "executor",
						body: { text: `Prepared the repository at ${workspace.baseSha.slice(0, 7)}` },
					},
				],
			});
			// 2. The model turn: admitted through the wake bus under the owner's sponsor.
			const begun = record(
				await call("qorpera_begin_coding_turn", {
					...args,
					p_coding: { vmId: workspace.vmId, turnId: turn.turnId },
				}),
				"Coding turn admission unconfirmed",
			);
			if (begun.workerId !== claimed.workerId || begun.sequence !== claimed.sequence)
				throw new Error("Coding turn admission unconfirmed");
			for (;;) {
				await setTimeout(this.#turnPollMs, undefined, { signal: active });
				turn = await describe();
				if (turnEnded(turn)) break;
			}
			// 3. What the harness left behind decides the outcome; prose never does.
			const submission = turn.submission;
			if (submission?.kind === "finish" && turn.jobStatus === "completed") {
				await progress({ p_phase: "publishing", p_last_step: "Publishing the draft pull request" });
				const publication = await this.#host.publish(claimed, submission, active);
				if (!publication.pullRequest && !publication.noChange) throw new Error("Coding publication unconfirmed");
				await detach();
				await complete("succeeded", submission.summary, {
					p_pull_request: publication.pullRequest,
					p_harness_session_ref: claimed.harnessSessionRef,
				});
				return "completed";
			}
			await detach();
			if (submission?.kind === "ask" && turn.jobStatus === "completed") {
				await complete("blocked", submission.summary, {
					p_needs: submission.question,
					p_options: submission.options.length ? submission.options : null,
					p_harness_session_ref: claimed.harnessSessionRef,
				});
				return "blocked";
			}
			const reason =
				turn.jobStatus === "completed"
					? "The coding turn ended without a submission."
					: turn.jobStatus === "cancelled"
						? "The coding turn was stopped before it finished."
						: `The coding turn did not finish${turn.jobError ? `: ${turn.jobError.slice(0, 500)}` : "."}`;
			await complete("failed", reason);
			return "failed";
		} catch (error) {
			// A lost or expired lease, or shutdown, is the cause, whatever await
			// it interrupted.
			const cause = active.aborted ? active.reason : error;
			workspaceReady = false;
			stop.abort();
			await leaseRefresh.catch(() => undefined);
			this.#reported("turn", cause);
			// A separate custody must permit unplugging the session after work
			// authority disappears. Never claim completion.
			try {
				await this.#host.detachSession(claim, AbortSignal.timeout(CLEANUP_STOP_BUDGET_MS));
			} catch (stopError) {
				/* recovery still required */
				this.#reported("stop", stopError);
			}
			return "recovery-required";
		} finally {
			heartbeatStop.abort();
			clearTimeout(watchdog);
			await heartbeat;
		}
	}
}
