import { setTimeout } from "node:timers/promises";
import {
	type CloudCodingPullRequest,
	type CloudCodingRepository,
	parseCloudCodingPullRequest,
	parseCloudCodingRepository,
} from "@qorpera/contracts";
import { withAbortScope } from "./abort-scope.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA40 = /^[0-9a-f]{40}$/;
/** Failure-path cleanup: the custody lookups (normally well under a second)
 * plus stopping the session's commands in the guest and unplugging its
 * folders. The executor unit's TimeoutStopSec must stay well above it. */
export const CLEANUP_STOP_BUDGET_MS = 45_000;
/** A slow database is not a lost lease (R2, 31 Oct 2026). A renewal or a describe whose answer was lost or late is
 * asked again after these pauses (then every 8 s); a refusal is the kernel's answer and is never asked again. */
export const CODING_RETRY_PAUSES_MS = [2000, 4000, 8000] as const;
/** A renewal's attempts and pauses end this long before the lease's end as the turn counts it: the earlier of the
 * deadline the last renewal (or the claim) confirmed, on the database's clock, and the lease's length after it was
 * sent, on this node's. The turn gives its lease up while the kernel still holds it for it, however the clocks drift. */
export const CODING_LEASE_MARGIN_MS = 5000;
/** A claim's and a renewal's lease. */
const LEASE_SECONDS = 60;
/** How long one describe of the turn may stay lost or late, from its first attempt. */
export const CODING_DESCRIBE_BUDGET_MS = 30_000;
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
/** The turn's workspace could not be made, for a reason the host can name: its machine's storage did not answer in
 * time, or its node is not set up for the machine. The turn's model never ran: the turn fails at once, under its lease,
 * with `summary` (what happened, in the member's and the agent's words, and the code), instead of leaving its lease to
 * lapse as if the executor had stopped. The message is the fixed code alone, which is all a log shows. */
/** A landing that conflicts with the default branch of a repository kept in Qorpera: nothing landed, and the session
 * merges the default branch itself (own code storage, slice 1). */
export class CodingLandConflict extends Error {
	readonly paths: readonly string[];
	constructor(paths: readonly string[]) {
		super("CODING_LAND_CONFLICT");
		this.name = "CodingLandConflict";
		this.paths = Object.freeze([...paths]);
	}
}
export class CodingWorkspaceFailed extends Error {
	readonly summary: string;
	constructor(code: string, summary: string, options?: ErrorOptions) {
		super(code, options);
		this.summary = `${summary} [code=${code}]`;
	}
}
/** The kernel refused a call on a busy row (SQLSTATE 55P03, lock_not_available)
 * and rolled its transaction back whole: the call wrote nothing. A control
 * rejects with this only for a complete PostgREST error with that SQLSTATE. */
export class CodingControlBusy extends Error {
	constructor() {
		super("CODING_CONTROL_BUSY");
	}
}
/** The kernel refused the call (SQLSTATE 42501, or 22023 for a coding session's folder view) and rolled its transaction
 * back whole: an answer, unlike an unconfirmed call. A control rejects with this only for the folder view open and
 * close, and a test machine's take-in of reads: a test machine's boot acts on the open's (F3 6d) and the take-in's
 * (6d-3b), a coding session's attach fails with its view's (F3 5g-4), and the code host's open (5e-3b) fails on it as
 * on any other error. It also rejects a turn's renewal and describe with it (42501, 55000 or 22023): the lease is gone,
 * and neither is asked again (R2). */
export class CodingControlRefused extends Error {
	/** The refusal's `qorpera.*` detail, when it gave one. */
	readonly detail: string | null;
	/** The kernel's own message, when it is one the control keeps for the method (a coding session's folder view). */
	readonly reason: string | null;
	constructor(detail: string | null, reason: string | null = null) {
		super("CODING_CONTROL_REFUSED");
		this.detail = detail;
		this.reason = reason;
	}
}
/** What carries one of a session's secret values in a publication (F3 5j-5 b): a commit by its short id, a file
 * or a folder's names by the path the push reached it at ("" for the top folder), or the pull request's title or
 * summary. The id and the path went through the mask, and are null when what is left is not plain text. */
export type CodingPushCarrier =
	| { readonly kind: "commit"; readonly sha: string | null }
	| { readonly kind: "file" | "folder"; readonly path: string | null }
	| { readonly kind: "pull-request" };
/** The broker sent nothing (F3 5j-5 b): the publication carries one of the session's secret values
 * (`CODING_PUSH_CARRIES_SECRET`, with what carries it), or it could not be checked whole (`CODING_PUSH_UNCHECKED`).
 * Neither names or holds the value. */
export class CodingPushRefused extends Error {
	readonly carrier: CodingPushCarrier | null;
	constructor(carrier: CodingPushCarrier | null) {
		super(carrier ? "CODING_PUSH_CARRIES_SECRET" : "CODING_PUSH_UNCHECKED");
		this.carrier = carrier;
	}
}
/** The reason a refused publication's turn fails with, for the model and the member: what to change, never the value. */
function pushRefusal(refused: CodingPushRefused): string {
	const carrier = refused.carrier;
	if (!carrier)
		return "The push was refused: it could not be checked whole for the session's secret values, most likely because it is too large. Publish a smaller change and finish again.";
	if (carrier.kind === "pull-request")
		return "The push was refused: the pull request's title or summary carries one of the session's secret values. Write it without the value and finish again.";
	const where =
		carrier.kind === "commit"
			? carrier.sha === null
				? "a commit"
				: `the commit ${carrier.sha}`
			: carrier.kind === "file"
				? carrier.path === null
					? "a file"
					: `the file "${carrier.path}"`
				: carrier.path === null
					? "a file or folder name"
					: carrier.path === ""
						? "a file or folder name at the top of the repository"
						: `a file or folder name in "${carrier.path}"`;
	return `The push was refused: ${where} carries one of the session's secret values. Remove it from the history and finish again.`;
}
/** The company folder refused a path the session's machine wrote (F3 5j-5 a): its contents or its name carry one of the
 * machine's secret values, or (`unchecked`) its save check could not finish checking it, so it found none. It is not
 * saved and stays on the machine, nothing was published, and the error names no path. */
export class CodingSaveRefused extends Error {
	readonly unchecked: boolean;
	constructor(unchecked = false) {
		super(unchecked ? "CODING_FOLDER_SAVE_UNCHECKED" : "CODING_FOLDER_SAVE_REFUSED");
		this.unchecked = unchecked;
	}
}
/** The git commands that take a refused change out of a repository's storage (RUNTIME-FOLDER-CODING-MACHINES.md, "The
 * way out"): the worktree's log line of the refused commit, then every pack and loose object only it reached. Packs of
 * at most 64 MiB stay within what the check rebuilds (64 times a pack's size, at most 4 GiB). */
const GIT_WAY_OUT =
	"run `git reflog expire --expire-unreachable=now HEAD`, `git repack -a -d --max-pack-size=64m` and `git prune --expire=now`";
/** The reasons a publication held by a refused save fails its turn with: what to change, never the value or the path. */
const SAVE_REFUSAL = `The save was refused: a file this session wrote in the company folder carries one of the session's secret values, in its contents or its name. It was not saved, and nothing was published. Remove the value and finish again. If a git commit carried it, take the value out of the files (and \`git add\` them) or the message, ${GIT_WAY_OUT}, then commit again.`;
const SAVE_UNCHECKED = `The save was refused: a file this session wrote in the company folder could not be checked for the session's secret values. It was not saved, and nothing was published. If it is in a git repository's storage, ${GIT_WAY_OUT}, then commit and finish again. Otherwise remove the file or make it smaller, and finish again. If nothing needs changing, finish again: the check may have been busy.`;
/** A landing that conflicts with the default branch of a repository kept in Qorpera: what to do, and where. */
export function landConflict(baseBranch: string, paths: readonly string[]): string {
	const shown = paths.slice(0, 20).map((path) => JSON.stringify(path));
	const more = paths.length > shown.length ? ` and ${paths.length - shown.length} more` : "";
	return `The change was not landed: it conflicts with what ${baseBranch} got since this session began${shown.length ? `, in ${shown.join(", ")}${more}` : ""}. Nothing changed on ${baseBranch}. Run git merge ${baseBranch} on the session's branch, resolve the conflicts, run the checks, commit and finish again.`;
}
/** Whether a failure says the session's machine needs recovery before anything else runs on it. */
function recoveryRequired(error: unknown): boolean {
	return error instanceof Error && /RECOVERY_REQUIRED$/.test(error.message);
}
/** A workspace that could not be prepared for a reason the host does not name: the turn did not start, nothing changed,
 * and the step's own code, when it is one, travels in the summary for the agent and the session's card. */
export function prepareUnfinished(error: unknown): string {
	const code =
		error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}(?::[A-Z0-9_]{1,80})?$/.test(error.message)
			? error.message
			: "CODING_PREPARE_UNFINISHED";
	return `Preparing the session's workspace did not finish, so the coding turn did not start. Nothing was changed; a follow-up tries again. [code=${code}]`;
}
/** A publication that failed for another reason than a refusal (the step's own code is in the executor's log). */
export const PUBLICATION_UNFINISHED =
	"Handing in the work did not finish, so it may not have reached the repository yet. The work is kept on the session's branch; finishing again hands it in. [code=CODING_PUBLICATION_UNFINISHED]";
/** One housekeeping step on one machine, for the executor's log. */
export interface CodingHousekeepingOutcome {
	/** Null for archive: the quiet sessions of this executor's environments. */
	machineId: string | null;
	/** release: the machine was deleted but its capacity release failed. */
	step: "sleep" | "delete" | "release" | "archive";
	state: "done" | "not-now" | "failed";
	code?: string;
}
/** One keeper step on one attached session (or its whole machine), for the executor's log. */
export interface CodingKeepOutcome {
	machineId: string;
	/** Null when the machine's observation or renewal failed as a whole, and for its secrets. */
	workerId: string | null;
	/** keep: attachment and guest lease renewed; detach: the session was taken off; secrets: the folder service was given
	 * the machine's secret values again (5j-5 (a)), reported only when that failed, or was not-now because the service is
	 * from before the check. */
	step: "keep" | "detach" | "secrets";
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
	/** A repository kept in Qorpera (own code storage, slice 1): where the submitted commit landed on its default
	 * branch. It has no pull request. */
	readonly landed?: { readonly state: "fast-forward" | "merged" | "unchanged"; readonly mainSha: string };
}
export interface CodingExecutorHost {
	/** Plan and wake the member's coding machine on genuine node capacity, attach
	 * the session's NAS folders and seed a credential-free checkout exactly once.
	 * Resolves with the machine and the pinned base; nothing calls the model
	 * before this resolves. Throws CodingMachineUnavailable when the turn must
	 * wait for its machine, and CodingWorkspaceFailed when the turn fails for a
	 * reason the host can name. */
	prepareWorkspace(claim: CodingSessionClaim, turn: CodingTurnState, signal: AbortSignal): Promise<CodingWorkspace>;
	/** The end of a turn, whatever its outcome: nothing more starts, publishes
	 * or seeds for it. The session stays attached for the keeper. */
	endTurn(claim: CodingSessionClaim): void;
	/** Export the submitted commit as a bundle while the session's commands keep
	 * running, validate and push it through the broker and create or verify the
	 * draft PR. Keeps its own effect journals across restarts. */
	publish(
		claim: CodingSessionClaim,
		submission: Extract<CodingSubmission, { kind: "finish" }>,
		signal: AbortSignal,
	): Promise<CodingExecutorPublication>;
	/** A turn that failed, or must wait for its machine, before recording its
	 * session's attachment unplugs what it hot-plugged, with or without the
	 * lease. An attached session is the keeper's. */
	detachSession(claim: CodingSessionClaim, signal: AbortSignal): Promise<void>;
	/** Keep every attached session of this executor's awake machines: renew its
	 * attachment and guest lease, report what runs, take off the released ones. */
	keep(signal: AbortSignal): Promise<CodingKeepOutcome[]>;
	/** Archive quiet sessions, sleep quiet machines, remove the ones due, retire
	 * kept per-session VMs and close released ones; every failure is recorded
	 * and returned. */
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

/** A control call's answer, or its signal's reason once that aborts: a control that ignores its signal cannot hold the
 * turn past the attempt's end, and an answer after that is dropped. */
function answerBefore<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		if (signal.aborted) {
			abort();
			return;
		}
		signal.addEventListener("abort", abort, { once: true });
		Promise.resolve()
			.then(call)
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", abort));
	});
}

export type CodingTurnOutcome = "completed" | "blocked" | "failed" | "deferred" | "recovery-required";

/** Claims coding session turns and runs each to its end, many at once: every
 * member's sessions share that member's machine, and the node's capacity is
 * the only bound. Native model activity, machine custody, Git publication and
 * the kernel's completion have different receipts; none is inferred from
 * another. The host composes the real LXD/Git adapters. A lost lease aborts a
 * turn's work. A turn never detaches its session: the session stands by on its
 * machine under its own attachment, which the host keeps (keep) until the
 * session is archived, its attachment ends or the machine sleeps. */
export class CloudCodingExecutor {
	readonly #control: CodingExecutorControl;
	readonly #host: CodingExecutorHost;
	readonly #owner: string;
	readonly #turnPollMs: number;
	readonly #report: ((stage: "turn" | "stop" | "defer" | "publish", error: unknown) => void) | undefined;
	readonly #turns = new Set<Promise<CodingTurnOutcome>>();
	constructor(options: {
		control: CodingExecutorControl;
		host: CodingExecutorHost;
		owner: string;
		turnPollMs?: number;
		/** Observability only: which stage failed and with what error, before
		 * recovery. Never decides anything; the kernel receipts do. */
		report?: (stage: "turn" | "stop" | "defer" | "publish", error: unknown) => void;
	}) {
		if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(options.owner)) throw new Error("Invalid coding executor owner");
		this.#control = options.control;
		this.#host = options.host;
		this.#owner = options.owner;
		this.#turnPollMs = options.turnPollMs ?? 2000;
		this.#report = options.report;
	}
	/** Observability must never change the outcome: a throwing reporter is ignored. */
	#reported(stage: "turn" | "stop" | "defer" | "publish", error: unknown): void {
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
		const sent = Date.now();
		const value = await withAbortScope(signal, (asking) =>
			this.#control.call(
				"qorpera_claim_coding_session",
				{ p_owner: this.#owner, p_lease_seconds: LEASE_SECONDS },
				AbortSignal.any([asking, AbortSignal.timeout(10000)]),
			),
		);
		if (value === null) return { state: "idle" };
		const claim = parseCodingSessionClaim(value);
		const turn = withAbortScope(signal, (scoped) => this.#turn(claim, sent, scoped));
		this.#turns.add(turn);
		void turn.finally(() => this.#turns.delete(turn)).catch(() => undefined);
		return { state: "claimed", turn };
	}
	/** Every running turn has ended (after a shutdown, each has ended its turn;
	 * attached sessions stay for the next process to keep, within their deadline). */
	async drain(): Promise<void> {
		await Promise.allSettled([...this.#turns]);
	}
	housekeep(signal: AbortSignal): Promise<CodingHousekeepingOutcome[]> {
		return this.#host.housekeep(signal);
	}
	keep(signal: AbortSignal): Promise<CodingKeepOutcome[]> {
		return this.#host.keep(signal);
	}
	/** One turn, serially: it claims nothing else. */
	async runOnce(signal: AbortSignal): Promise<"idle" | CodingTurnOutcome> {
		const claimed = await this.claim(signal);
		return claimed.state === "idle" ? "idle" : claimed.turn;
	}
	/** `claimSent` is when the claim was sent, on this node's clock. */
	async #turn(claim: CodingSessionClaim, claimSent: number, signal: AbortSignal): Promise<CodingTurnOutcome> {
		const stop = new AbortController();
		const heartbeatStop = new AbortController();
		const active = AbortSignal.any([signal, stop.signal]);
		let heartbeat: Promise<void> | undefined;
		let watchdog: ReturnType<typeof globalThis.setTimeout> | undefined;
		const arm = (deadline: string) => {
			const milliseconds = Date.parse(deadline) - Date.now();
			if (!Number.isFinite(milliseconds) || milliseconds < 1 || milliseconds > 305000)
				throw new Error("Invalid coding lease deadline");
			clearTimeout(watchdog);
			// Coded reasons: whatever the abort interrupts reports why (errorCode).
			watchdog = globalThis.setTimeout(() => stop.abort(new Error("CODING_EXECUTOR_LEASE_EXPIRED")), milliseconds);
		};
		// Each call under a scope of its own: the turn's signals last as long as the turn, and a turn of hours polls
		// thousands of times (abort-scope.ts).
		const call = (
			method: (typeof CODING_EXECUTOR_RPCS)[number],
			args: Record<string, unknown>,
			checked = active,
			ms = 10000,
		) =>
			withAbortScope(checked, (scoped) =>
				this.#control.call(method, args, AbortSignal.any([scoped, AbortSignal.timeout(ms)])),
			);
		try {
			const claimed = claim;
			const args = { p_worker_id: claim.workerId, p_lease_token: claim.leaseToken };
			arm(claim.leaseUntil);
			// The lease's renewals, one at a time with the same token: the next waits for the last to settle. An answer
			// lost or late is asked again, every attempt and pause ending by the margin before the lease's end as the
			// turn counts it; there the turn gives the lease up. A refusal gives it up at once (R2, 31 Oct 2026). The
			// watchdog keeps the database's deadline.
			heartbeat = (async () => {
				const checked = AbortSignal.any([active, heartbeatStop.signal]);
				const leaseEnd = (deadline: string, sent: number) =>
					Math.min(Date.parse(deadline), sent + LEASE_SECONDS * 1000);
				let held = leaseEnd(claim.leaseUntil, claimSent);
				try {
					for (let failures = 0; !checked.aborted; ) {
						const by = held - CODING_LEASE_MARGIN_MS;
						const pause = failures ? CODING_RETRY_PAUSES_MS[Math.min(failures, 3) - 1] : 15000;
						await setTimeout(Math.max(0, Math.min(pause, by - Date.now())), undefined, { signal: checked });
						const sent = Date.now();
						const left = by - sent;
						if (left < 1) throw new Error("Coding lease renewal ran out of time");
						let until: unknown;
						try {
							until = await withAbortScope(checked, (scoped) => {
								const attempt = AbortSignal.any([scoped, AbortSignal.timeout(Math.min(10000, left))]);
								return answerBefore(
									() =>
										this.#control.call(
											"qorpera_heartbeat_coding_session",
											{ ...args, p_lease_seconds: LEASE_SECONDS },
											attempt,
										),
									attempt,
								);
							});
						} catch (error) {
							if (checked.aborted || error instanceof CodingControlRefused) throw error;
							failures++;
							continue;
						}
						// An answer after the turn gave its lease up renews nothing.
						if (checked.aborted) return;
						if (typeof until !== "string") throw new Error("Coding heartbeat unconfirmed");
						arm(until);
						held = leaseEnd(until, sent);
						claimed.leaseUntil = until;
						failures = 0;
					}
				} catch {
					if (!heartbeatStop.signal.aborted) stop.abort(new Error("CODING_EXECUTOR_LEASE_LOST"));
				}
			})();
			// The turn as the kernel sees it, asked again while its answer is lost or late, within its own budget; the
			// turn's end cancels it. A refusal, or an answer that is not the turn, is not asked again (R2).
			const describe = async () => {
				const by = Date.now() + CODING_DESCRIBE_BUDGET_MS;
				for (let failures = 0; ; failures++) {
					const attemptMs = Math.max(1, Math.min(10000, by - Date.now()));
					let value: unknown;
					try {
						value = await call("qorpera_describe_coding_turn", args, active, attemptMs);
					} catch (error) {
						const pause = CODING_RETRY_PAUSES_MS[Math.min(failures, 2)];
						if (active.aborted || error instanceof CodingControlRefused || Date.now() + pause >= by) throw error;
						await setTimeout(pause, undefined, { signal: active });
						continue;
					}
					return parseCodingTurnState(value, claimed);
				}
			};
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
			// The end of every turn: nothing more starts or publishes for it. The
			// session stays attached with whatever its commands left running.
			const end = () => this.#host.endTurn(claimed);

			// 1. The workspace: the member's machine, the session's NAS folders, pinned base, seeded checkout.
			let turn = await describe();
			if (turn.phase !== "preparing") throw new Error("Coding turn is not preparing");
			let workspace: CodingWorkspace;
			try {
				workspace = await this.#host.prepareWorkspace(claimed, turn, active);
			} catch (error) {
				if (error instanceof CodingWorkspaceFailed && !active.aborted) {
					// The model never ran: unplug whatever was attached, then fail the turn with its reason while it holds
					// its lease. Should the report not go through, the lease lapses and the session fails all the same.
					this.#reported("turn", error);
					end();
					try {
						await this.#host.detachSession(claimed, active);
					} catch (detachError) {
						this.#reported("stop", detachError);
					}
					await complete("failed", error.summary);
					return "failed";
				}
				if (!(error instanceof CodingMachineUnavailable) && !active.aborted && !recoveryRequired(error)) {
					// Any other failure before the model ran (8 Nov 2026, Lærdom: the vault refused the session's
					// environment) fails the turn now, saying so with its code, instead of leaving the lease to lapse as "the
					// executor stopped responding". Only once what the turn attached came off: a machine that could not be
					// unplugged, or one the host says needs recovery, still lapses (the recovery path).
					this.#reported("turn", error);
					end();
					try {
						await this.#host.detachSession(claimed, active);
					} catch (detachError) {
						this.#reported("stop", detachError);
						return "recovery-required";
					}
					await complete("failed", prepareUnfinished(error));
					return "failed";
				}
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
			// Wake admission never waits for its company's row, and every agent tool
			// call holds that row for its whole transaction, so begin is refused as
			// busy while one runs. A busy refusal wrote nothing: begin again after a
			// short pause, until the lease this turn held at the first try ends.
			const admission = { ...args, p_coding: { vmId: workspace.vmId, turnId: turn.turnId } };
			const admitBy = Date.parse(claimed.leaseUntil);
			let begun: Record<string, unknown> | undefined;
			for (let attempt = 0; !begun; attempt++) {
				try {
					begun = record(await call("qorpera_begin_coding_turn", admission), "Coding turn admission unconfirmed");
				} catch (error) {
					const pause = Math.min(2000, 250 * 2 ** attempt) * (0.5 + Math.random() / 2);
					if (!(error instanceof CodingControlBusy) || Date.now() + pause >= admitBy) throw error;
					await setTimeout(pause, undefined, { signal: active });
				}
			}
			if (begun.state === "refused" && begun.reason === "COMPUTER_HOURS_EXHAUSTED") {
				// The company ran out of computer hours after the machine step: nothing began. The session
				// waits in the queue; an attached one stays with the keeper.
				end();
				try {
					await call("qorpera_defer_coding_session", { ...args, p_reason: begun.reason });
				} catch (deferError) {
					this.#reported("defer", deferError);
					return "recovery-required";
				}
				return "deferred";
			}
			if (begun.workerId !== claimed.workerId || begun.sequence !== claimed.sequence)
				throw new Error("Coding turn admission unconfirmed");
			// One describe at a time: the next poll's pause starts once the last describe, retries and all, settled.
			for (;;) {
				await setTimeout(this.#turnPollMs, undefined, { signal: active });
				turn = await describe();
				if (turnEnded(turn)) break;
			}
			// 3. What the harness left behind decides the outcome; prose never does.
			const submission = turn.submission;
			if (submission?.kind === "finish" && turn.jobStatus === "completed") {
				await progress({
					p_phase: "publishing",
					// A repository kept in Qorpera has no pull request: its work lands (own code storage).
					p_last_step:
						claimed.repository.host === "qorpera" ? "Landing the change" : "Publishing the draft pull request",
				});
				let publication: CodingExecutorPublication;
				try {
					publication = await this.#host.publish(claimed, submission, active);
				} catch (error) {
					if (active.aborted) throw error;
					end();
					if (error instanceof CodingLandConflict) {
						// Nothing landed: the session merges the default branch itself and finishes again.
						await complete("failed", landConflict(claimed.repository.baseBranch, error.paths));
						return "failed";
					}
					if (error instanceof CodingPushRefused || error instanceof CodingSaveRefused) {
						// Nothing went out, and the same work would be refused again (but for a check the node was too busy
						// for): the turn fails with what to change, and the session's next turn can finish again.
						await complete(
							"failed",
							error instanceof CodingSaveRefused
								? error.unchecked
									? SAVE_UNCHECKED
									: SAVE_REFUSAL
								: pushRefusal(error),
						);
						return "failed";
					}
					// Any other publication failure while the turn still holds its lease (8 Nov 2026, session 27038e92: a
					// push GitHub had not shown yet) fails the turn now, saying so, instead of leaving the lease to lapse
					// as "the executor stopped responding". The work stays on the session's branch, and every publication
					// step checks what an earlier one did, so a later finish hands the same commit in again.
					this.#reported("publish", error);
					await complete("failed", PUBLICATION_UNFINISHED);
					return "failed";
				}
				if (!publication.pullRequest && !publication.noChange && !publication.landed)
					throw new Error("Coding publication unconfirmed");
				end();
				await complete("succeeded", submission.summary, {
					p_pull_request: publication.pullRequest,
					p_harness_session_ref: claimed.harnessSessionRef,
					// Where a repository kept in Qorpera got the commit: the session's record, and its agent's report.
					...(publication.landed
						? {
								p_artifacts: [
									{
										kind: "landed",
										state: publication.landed.state,
										branch: claimed.repository.baseBranch,
										headSha: submission.headSha,
										mainSha: publication.landed.mainSha,
									},
								],
							}
						: {}),
				});
				return "completed";
			}
			end();
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
			stop.abort();
			this.#host.endTurn(claim);
			this.#reported("turn", cause);
			// A session hot-plugged by this turn but never attached is unplugged
			// under separate custody after work authority disappears; an attached
			// one stays for the keeper. Never claim completion.
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
