/**
 * Agent routine scheduling with durable run state.
 *
 * Pure decision logic plus machine-local run state. Each routine belongs to
 * an agent; the desktop host decides when it fires, serializes it against
 * other company writers, coalesces missed intervals, and suspends repeated
 * failures without depending on the failing agent.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
	ROUTINE_WEEKDAYS,
	type RoutineTrigger,
	type ScheduledJob,
	scheduledJobIntervalMinutes,
	scheduledJobStartAt,
} from "@qorpera/pi-coding-agent/company-connections";
import { companyHostStorageFile } from "./company-host-storage.ts";

const LEGACY_SCHEDULED_JOB_ID = "company-orchestration";

/** Consecutive failed runs before the host suspends a routine. */
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

type ScheduleTrigger = Extract<RoutineTrigger, { kind: "schedule" }>;

interface LocalDateParts {
	year: number;
	month: number;
	day: number;
}

function resolvedScheduleTimeZone(trigger: ScheduleTrigger): string {
	return trigger.timeZone === "auto"
		? (Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC")
		: (trigger.timeZone ?? "UTC");
}

function zonedDateTimeParts(timestampMs: number, timeZone: string): LocalDateParts & { hour: number; minute: number } {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		})
			.formatToParts(timestampMs)
			.filter((part) => part.type !== "literal")
			.map((part) => [part.type, Number(part.value)]),
	);
	return {
		year: parts.year,
		month: parts.month,
		day: parts.day,
		hour: parts.hour,
		minute: parts.minute,
	};
}

function shiftedLocalDate(date: LocalDateParts, days: number): LocalDateParts {
	const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
	return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function localDateTimeInstant(date: LocalDateParts, localTime: string, timeZone: string): number | undefined {
	const [hourText, minuteText] = localTime.split(":");
	const hour = Number(hourText);
	const minute = Number(minuteText);
	const targetAsUtc = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
	let candidate = targetAsUtc;
	for (let attempt = 0; attempt < 4; attempt++) {
		const actual = zonedDateTimeParts(candidate, timeZone);
		const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
		const correction = targetAsUtc - actualAsUtc;
		if (correction === 0) break;
		candidate += correction;
	}
	const final = zonedDateTimeParts(candidate, timeZone);
	return final.year === date.year &&
		final.month === date.month &&
		final.day === date.day &&
		final.hour === hour &&
		final.minute === minute
		? candidate
		: undefined;
}

function nearestWeeklyOccurrence(
	trigger: ScheduleTrigger,
	timestampMs: number,
	direction: "before-or-at" | "after",
): number | undefined {
	if (!trigger.weekdays || !trigger.localTime || !trigger.timeZone) return undefined;
	const timeZone = resolvedScheduleTimeZone(trigger);
	const startAt = trigger.startAt ? Date.parse(trigger.startAt) : Number.NaN;
	if (direction === "before-or-at" && Number.isFinite(startAt) && timestampMs < startAt) return undefined;
	const searchFrom =
		direction === "after" && Number.isFinite(startAt) && timestampMs < startAt ? startAt - 1 : timestampMs;
	const current = zonedDateTimeParts(searchFrom, timeZone);
	for (let distance = 0; distance <= 7; distance++) {
		const date = shiftedLocalDate(current, direction === "before-or-at" ? -distance : distance);
		const weekday = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][
			new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
		];
		if (!trigger.weekdays.includes(weekday as (typeof trigger.weekdays)[number])) continue;
		const occurrence = localDateTimeInstant(date, trigger.localTime, timeZone);
		if (occurrence === undefined) continue;
		if (Number.isFinite(startAt) && occurrence < startAt) continue;
		if (direction === "before-or-at" ? occurrence <= timestampMs : occurrence > timestampMs) return occurrence;
	}
	return undefined;
}

function weeklyOccurrencesAfter(trigger: ScheduleTrigger, afterMs: number, throughMs: number): number {
	let count = 0;
	let cursor = afterMs;
	while (count < 10_000) {
		const occurrence = nearestWeeklyOccurrence(trigger, cursor, "after");
		if (occurrence === undefined || occurrence > throughMs) return count;
		count++;
		cursor = occurrence;
	}
	return count;
}

function advancedSchedule(
	trigger: ScheduleTrigger,
): trigger is ScheduleTrigger & { windowStart: string; windowEnd: string; timeZone: string } {
	return Boolean(trigger.windowStart && trigger.windowEnd && trigger.timeZone && !trigger.localTime);
}

function localClockMinutes(value: string): number {
	const [hour, minute] = value.split(":").map(Number);
	return hour * 60 + minute;
}

function advancedDateMatches(trigger: ScheduleTrigger, date: LocalDateParts): boolean {
	if (trigger.months && !trigger.months.includes(date.month)) return false;
	if (!trigger.weekdays) return true;
	const weekday = ROUTINE_WEEKDAYS[new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()];
	return weekday !== undefined && trigger.weekdays.includes(weekday);
}

function advancedDateOccurrences(trigger: ScheduleTrigger, date: LocalDateParts): number[] {
	if (!advancedSchedule(trigger) || !advancedDateMatches(trigger, date)) return [];
	const start = localClockMinutes(trigger.windowStart);
	const end = localClockMinutes(trigger.windowEnd);
	const timeZone = resolvedScheduleTimeZone(trigger);
	const occurrences: number[] = [];
	for (let minute = start; minute <= end; minute += trigger.intervalMinutes) {
		const localTime = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
		const occurrence = localDateTimeInstant(date, localTime, timeZone);
		if (occurrence !== undefined) occurrences.push(occurrence);
	}
	return occurrences;
}

function nearestAdvancedOccurrence(
	trigger: ScheduleTrigger,
	timestampMs: number,
	direction: "before-or-at" | "after",
): number | undefined {
	if (!advancedSchedule(trigger)) return undefined;
	const timeZone = resolvedScheduleTimeZone(trigger);
	const current = zonedDateTimeParts(timestampMs, timeZone);
	for (let distance = 0; distance <= 370; distance++) {
		const date = shiftedLocalDate(current, direction === "before-or-at" ? -distance : distance);
		const occurrences = advancedDateOccurrences(trigger, date);
		if (direction === "before-or-at") {
			for (let index = occurrences.length - 1; index >= 0; index--) {
				const occurrence = occurrences[index];
				if (occurrence !== undefined && occurrence <= timestampMs) return occurrence;
			}
		} else {
			for (const occurrence of occurrences) {
				if (occurrence > timestampMs) return occurrence;
			}
		}
	}
	return undefined;
}

function advancedOccurrencesAfter(trigger: ScheduleTrigger, afterMs: number, throughMs: number): number {
	let count = 0;
	let cursor = afterMs;
	while (count < 10_000) {
		const occurrence = nearestAdvancedOccurrence(trigger, cursor, "after");
		if (occurrence === undefined || occurrence > throughMs) return count;
		count++;
		cursor = occurrence;
	}
	return count;
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
	return companyHostStorageFile(userData, id, "wakes.json");
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
	const schedule = job.triggers.find((trigger): trigger is ScheduleTrigger => trigger.kind === "schedule");
	if (schedule && advancedSchedule(schedule)) {
		const latest = nearestAdvancedOccurrence(schedule, nowMs, "before-or-at");
		if (latest === undefined) return { due: false, coalesced: 0 };
		if (!state.lastWakeAt) {
			const createdAt = Date.parse(job.createdAt);
			return Number.isFinite(createdAt) && latest < createdAt
				? { due: false, coalesced: 0 }
				: { due: true, coalesced: 0 };
		}
		const last = Date.parse(state.lastWakeAt);
		if (!Number.isFinite(last)) return { due: true, coalesced: 0 };
		if (last >= latest) return { due: false, coalesced: 0 };
		return { due: true, coalesced: Math.max(0, advancedOccurrencesAfter(schedule, last, nowMs) - 1) };
	}
	if (schedule?.weekdays && schedule.localTime && schedule.timeZone) {
		const latest = nearestWeeklyOccurrence(schedule, nowMs, "before-or-at");
		if (latest === undefined) return { due: false, coalesced: 0 };
		if (!state.lastWakeAt) {
			const createdAt = Date.parse(job.createdAt);
			return Number.isFinite(createdAt) && latest < createdAt
				? { due: false, coalesced: 0 }
				: { due: true, coalesced: 0 };
		}
		const last = Date.parse(state.lastWakeAt);
		if (!Number.isFinite(last)) return { due: true, coalesced: 0 };
		if (last >= latest) return { due: false, coalesced: 0 };
		return { due: true, coalesced: Math.max(0, weeklyOccurrencesAfter(schedule, last, nowMs) - 1) };
	}
	const intervalMinutes = scheduledJobIntervalMinutes(job);
	if (intervalMinutes === undefined) return { due: false, coalesced: 0 };
	const intervalMs = Math.max(intervalMinutes, 1) * 60_000;
	const startAt = scheduledJobStartAt(job);
	const anchor = startAt ? Date.parse(startAt) : Number.NaN;
	if (Number.isFinite(anchor)) {
		if (nowMs < anchor) return { due: false, coalesced: 0 };
		const latestSlot = Math.floor((nowMs - anchor) / intervalMs);
		if (!state.lastWakeAt) return { due: true, coalesced: Math.max(0, latestSlot) };
		const last = Date.parse(state.lastWakeAt);
		if (!Number.isFinite(last)) return { due: true, coalesced: Math.max(0, latestSlot) };
		const lastSlot = Math.floor((last - anchor) / intervalMs);
		if (lastSlot >= latestSlot) return { due: false, coalesced: 0 };
		return { due: true, coalesced: Math.max(0, latestSlot - lastSlot - 1) };
	}
	if (!state.lastWakeAt) return { due: true, coalesced: 0 };
	const last = Date.parse(state.lastWakeAt);
	if (!Number.isFinite(last)) return { due: true, coalesced: 0 };
	const elapsed = nowMs - last;
	if (elapsed < intervalMs) return { due: false, coalesced: 0 };
	return { due: true, coalesced: Math.max(0, Math.floor(elapsed / intervalMs) - 1) };
}

/**
 * Deterministic identity of the scheduled occurrence a due wake fires for.
 * Machines never compare run state — each derives the key from the job's own
 * schedule and the clock, so two machines firing the same due occurrence
 * derive the same string and the cloud wake claim (SESSIONS.md) lets exactly
 * one of them execute. Unanchored intervals quantize onto the epoch grid:
 * machines racing within one interval window agree, and a machine waking
 * much later derives a fresh slot and legitimately runs the coalesced
 * occurrence itself.
 */
export function scheduledWakeOccurrenceKey(job: ScheduledJob, nowMs: number): string | undefined {
	const schedule = job.triggers.find((trigger): trigger is ScheduleTrigger => trigger.kind === "schedule");
	if (schedule && advancedSchedule(schedule)) {
		const latest = nearestAdvancedOccurrence(schedule, nowMs, "before-or-at");
		return latest === undefined ? undefined : `window:${latest}`;
	}
	if (schedule?.weekdays && schedule.localTime && schedule.timeZone) {
		const latest = nearestWeeklyOccurrence(schedule, nowMs, "before-or-at");
		return latest === undefined ? undefined : `weekly:${latest}`;
	}
	const intervalMinutes = scheduledJobIntervalMinutes(job);
	if (intervalMinutes === undefined) return undefined;
	const intervalMs = Math.max(intervalMinutes, 1) * 60_000;
	const startAt = scheduledJobStartAt(job);
	const anchor = startAt ? Date.parse(startAt) : Number.NaN;
	if (Number.isFinite(anchor)) {
		if (nowMs < anchor) return undefined;
		return `slot:${Math.floor((nowMs - anchor) / intervalMs)}`;
	}
	return `grid:${Math.floor(nowMs / intervalMs)}`;
}

/** A remote machine won the wake claim: consume the occurrence locally so
 * the schedule stops being due here, without recording an outcome this
 * machine never produced — the streak and last outcome stay untouched. */
export function recordRemoteWakeConsumption(state: WakeRunState, jobId: string, nowMs: number): WakeRunState {
	const now = new Date(nowMs).toISOString();
	const consumed = { ...scheduledJobRunState(state, jobId), lastWakeAt: now, lastFinishedAt: now };
	delete consumed.activeTrailFile;
	return { ...state, jobs: { ...state.jobs, [jobId]: consumed } };
}

export function nextScheduledWakeAt(job: ScheduledJob, state: ScheduledJobRunState, nowMs: number): string | undefined {
	if (!job.enabled || job.suspendedReason) return undefined;
	const schedule = job.triggers.find((trigger): trigger is ScheduleTrigger => trigger.kind === "schedule");
	if (!schedule) return undefined;
	if (advancedSchedule(schedule)) {
		if (decideScheduledWake(job, state, nowMs).due) return new Date(nowMs).toISOString();
		const next = nearestAdvancedOccurrence(schedule, nowMs, "after");
		return next === undefined ? undefined : new Date(next).toISOString();
	}
	if (schedule.weekdays && schedule.localTime && schedule.timeZone) {
		if (decideScheduledWake(job, state, nowMs).due) return new Date(nowMs).toISOString();
		const next = nearestWeeklyOccurrence(schedule, nowMs, "after");
		return next === undefined ? undefined : new Date(next).toISOString();
	}
	const intervalMinutes = scheduledJobIntervalMinutes(job);
	if (intervalMinutes === undefined) return undefined;
	const intervalMs = intervalMinutes * 60_000;
	const startAt = scheduledJobStartAt(job);
	const anchor = startAt ? Date.parse(startAt) : Number.NaN;
	if (Number.isFinite(anchor)) {
		if (decideScheduledWake(job, state, nowMs).due) return new Date(nowMs).toISOString();
		if (nowMs < anchor) return new Date(anchor).toISOString();
		return new Date(anchor + (Math.floor((nowMs - anchor) / intervalMs) + 1) * intervalMs).toISOString();
	}
	const last = state.lastWakeAt ? Date.parse(state.lastWakeAt) : Number.NaN;
	return new Date(Number.isFinite(last) ? last + intervalMs : nowMs).toISOString();
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
