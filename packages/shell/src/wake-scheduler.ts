/**
 * Wake scheduling (Build 4 — durable autonomy with integrity).
 *
 * Pure decision logic plus the machine-local run state. The founder binds
 * the schedule (`qorpera company wake set <minutes>`, kernel-side store);
 * the kernel decides WHEN a wake fires — single-flight, serialized against
 * chat and merge children by the caller, missed intervals coalesced into
 * one wake with the coalescing recorded — and the controller decides what
 * the wake MEANS. Repeated wake failures suspend the schedule and escalate
 * to the founder without the controller's cooperation: the entity that
 * reports a broken controller must not be the broken controller
 * (manifesto §4.3).
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type ScheduledJob, scheduledJobIntervalMinutes } from "@qorpera/pi-coding-agent/company-connections";

const LEGACY_SCHEDULED_JOB_ID = "company-orchestration";

/** Consecutive failed wake sessions before the kernel suspends the schedule. */
export const WAKE_FAILURE_SUSPENSION_THRESHOLD = 3;

export interface ScheduledJobRunState {
	lastWakeAt?: string;
	failureStreak: number;
	lastOutcome?: "succeeded" | "failed";
	lastTrailFile?: string;
	lastFinishedAt?: string;
	/** Trail owned by an unfinished run; cleared when its outcome is recorded. */
	activeTrailFile?: string;
}

export interface WakeRunState {
	version: 2;
	jobs: Record<string, ScheduledJobRunState>;
}

export interface WakeDecision {
	due: boolean;
	/** Whole missed intervals collapsed into this wake (0 when on time). */
	coalesced: number;
}

/** A settled agent turn is still a failed wake when its assistant call errored. */
export function wakeFrameFailed(frame: unknown): boolean {
	if (!frame || typeof frame !== "object" || Array.isArray(frame)) return false;
	const event = frame as Record<string, unknown>;
	if (event.type !== "message_end" || !event.message || typeof event.message !== "object") return false;
	const message = event.message as Record<string, unknown>;
	return message.role === "assistant" && message.stopReason === "error";
}

export function wakeRunStatePath(userData: string, root: string): string {
	const normalized = process.platform === "win32" ? resolve(root).toLowerCase() : resolve(root);
	const id = createHash("sha256").update(normalized).digest("hex");
	return join(userData, "company-kernel-state", id, "wakes.json");
}

export function readWakeRunState(path: string): WakeRunState {
	if (!existsSync(path)) return { version: 2, jobs: {} };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as
			| WakeRunState
			| { version: 1; lastWakeAt?: string; failureStreak?: number };
		if (parsed.version === 1) {
			return {
				version: 2,
				jobs: {
					[LEGACY_SCHEDULED_JOB_ID]: {
						...(typeof parsed.lastWakeAt === "string" ? { lastWakeAt: parsed.lastWakeAt } : {}),
						failureStreak: Number.isInteger(parsed.failureStreak) ? (parsed.failureStreak ?? 0) : 0,
					},
				},
			};
		}
		if (parsed.version !== 2 || !parsed.jobs || typeof parsed.jobs !== "object") return { version: 2, jobs: {} };
		const jobs: Record<string, ScheduledJobRunState> = {};
		for (const [id, value] of Object.entries(parsed.jobs)) {
			if (!id || !value || typeof value !== "object" || !Number.isInteger(value.failureStreak)) continue;
			if (value.failureStreak < 0) continue;
			jobs[id] = {
				failureStreak: value.failureStreak,
				...(typeof value.lastWakeAt === "string" ? { lastWakeAt: value.lastWakeAt } : {}),
				...(value.lastOutcome === "succeeded" || value.lastOutcome === "failed"
					? { lastOutcome: value.lastOutcome }
					: {}),
				...(typeof value.lastTrailFile === "string" ? { lastTrailFile: value.lastTrailFile } : {}),
				...(typeof value.lastFinishedAt === "string" ? { lastFinishedAt: value.lastFinishedAt } : {}),
				...(typeof value.activeTrailFile === "string" ? { activeTrailFile: value.activeTrailFile } : {}),
			};
		}
		return { version: 2, jobs };
	} catch {
		return { version: 2, jobs: {} };
	}
}

export function writeWakeRunState(path: string, state: WakeRunState): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(state, null, "\t")}\n`, { encoding: "utf-8", mode: 0o600 });
	try {
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

/**
 * Is a scheduled wake due? Missed-wake policy (manifesto §9): when the host
 * slept or the environment was closed, missed intervals COALESCE into one
 * wake, and the count is recorded so the wake's trail entry shows what was
 * skipped. A first-ever wake fires immediately.
 */
export function decideScheduledWake(
	job: ScheduledJob | undefined,
	state: ScheduledJobRunState,
	nowMs: number,
): WakeDecision {
	if (!job?.enabled || job.suspendedReason) return { due: false, coalesced: 0 };
	const intervalMinutes = scheduledJobIntervalMinutes(job);
	if (intervalMinutes === undefined) return { due: false, coalesced: 0 };
	const intervalMs = Math.max(intervalMinutes, 1) * 60_000;
	if (!state.lastWakeAt) return { due: true, coalesced: 0 };
	const last = Date.parse(state.lastWakeAt);
	if (!Number.isFinite(last)) return { due: true, coalesced: 0 };
	const elapsed = nowMs - last;
	if (elapsed < intervalMs) return { due: false, coalesced: 0 };
	return { due: true, coalesced: Math.max(0, Math.floor(elapsed / intervalMs) - 1) };
}

export function scheduledJobRunState(state: WakeRunState, jobId: string): ScheduledJobRunState {
	return state.jobs[jobId] ?? { failureStreak: 0 };
}

/** True when a prior run started but never persisted a terminal outcome. */
export function scheduledJobRunInterrupted(state: ScheduledJobRunState): boolean {
	if (!state.lastWakeAt) return false;
	const startedAt = Date.parse(state.lastWakeAt);
	if (!Number.isFinite(startedAt)) return false;
	const finishedAt = state.lastFinishedAt ? Date.parse(state.lastFinishedAt) : Number.NaN;
	return !Number.isFinite(finishedAt) || finishedAt < startedAt;
}

export function removeScheduledJobRunState(state: WakeRunState, jobId: string): WakeRunState {
	if (!(jobId in state.jobs)) return state;
	const jobs = { ...state.jobs };
	delete jobs[jobId];
	return { ...state, jobs };
}

export function recordWakeStart(
	state: WakeRunState,
	jobId: string,
	nowMs: number,
	activeTrailFile?: string,
): WakeRunState {
	return {
		...state,
		jobs: {
			...state.jobs,
			[jobId]: {
				...scheduledJobRunState(state, jobId),
				lastWakeAt: new Date(nowMs).toISOString(),
				...(activeTrailFile ? { activeTrailFile } : {}),
			},
		},
	};
}

/** Track the failure streak; at the threshold the caller suspends the schedule. */
export function recordWakeOutcome(
	state: WakeRunState,
	jobId: string,
	success: boolean,
	nowMs: number,
	trailFile?: string,
): { state: WakeRunState; suspend: boolean } {
	const current = scheduledJobRunState(state, jobId);
	const failureStreak = success ? 0 : current.failureStreak + 1;
	const completed = {
		...current,
		failureStreak,
		lastOutcome: success ? ("succeeded" as const) : ("failed" as const),
		lastFinishedAt: new Date(nowMs).toISOString(),
		...(trailFile ? { lastTrailFile: trailFile } : {}),
	};
	delete completed.activeTrailFile;
	if (!trailFile) delete completed.lastTrailFile;
	return {
		state: {
			...state,
			jobs: {
				...state.jobs,
				[jobId]: completed,
			},
		},
		suspend: failureStreak >= WAKE_FAILURE_SUSPENSION_THRESHOLD,
	};
}
