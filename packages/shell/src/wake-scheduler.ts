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

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { WakeSchedule } from "@qorpera/pi-coding-agent/company-connections";

/** Consecutive failed wake sessions before the kernel suspends the schedule. */
export const WAKE_FAILURE_SUSPENSION_THRESHOLD = 3;

export interface WakeRunState {
	version: 1;
	lastWakeAt?: string;
	failureStreak: number;
}

export interface WakeDecision {
	due: boolean;
	/** Whole missed intervals collapsed into this wake (0 when on time). */
	coalesced: number;
}

export function wakeRunStatePath(userData: string, root: string): string {
	const normalized = process.platform === "win32" ? resolve(root).toLowerCase() : resolve(root);
	const id = createHash("sha256").update(normalized).digest("hex");
	return join(userData, "company-kernel-state", id, "wakes.json");
}

export function readWakeRunState(path: string): WakeRunState {
	if (!existsSync(path)) return { version: 1, failureStreak: 0 };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as WakeRunState;
		if (parsed.version !== 1 || !Number.isInteger(parsed.failureStreak)) return { version: 1, failureStreak: 0 };
		return parsed;
	} catch {
		return { version: 1, failureStreak: 0 };
	}
}

export function writeWakeRunState(path: string, state: WakeRunState): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(state, null, "\t")}\n`, "utf-8");
}

/**
 * Is a scheduled wake due? Missed-wake policy (manifesto §9): when the host
 * slept or the environment was closed, missed intervals COALESCE into one
 * wake, and the count is recorded so the wake's trail entry shows what was
 * skipped. A first-ever wake fires immediately.
 */
export function decideScheduledWake(
	schedule: WakeSchedule | undefined,
	state: WakeRunState,
	nowMs: number,
): WakeDecision {
	if (!schedule?.enabled || schedule.suspendedReason) return { due: false, coalesced: 0 };
	const intervalMs = Math.max(schedule.intervalMinutes, 1) * 60_000;
	if (!state.lastWakeAt) return { due: true, coalesced: 0 };
	const last = Date.parse(state.lastWakeAt);
	if (!Number.isFinite(last)) return { due: true, coalesced: 0 };
	const elapsed = nowMs - last;
	if (elapsed < intervalMs) return { due: false, coalesced: 0 };
	return { due: true, coalesced: Math.max(0, Math.floor(elapsed / intervalMs) - 1) };
}

export function recordWakeStart(state: WakeRunState, nowMs: number): WakeRunState {
	return { ...state, lastWakeAt: new Date(nowMs).toISOString() };
}

/** Track the failure streak; at the threshold the caller suspends the schedule. */
export function recordWakeOutcome(state: WakeRunState, success: boolean): { state: WakeRunState; suspend: boolean } {
	const failureStreak = success ? 0 : state.failureStreak + 1;
	return { state: { ...state, failureStreak }, suspend: failureStreak >= WAKE_FAILURE_SUSPENSION_THRESHOLD };
}
