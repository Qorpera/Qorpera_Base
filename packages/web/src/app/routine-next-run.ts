import { cloudRoutineTriggerOfFile } from "@qorpera/cloud-client/cloud-routine-file";
import {
	CLOUD_ROUTINE_WEEKDAYS,
	type CloudRoutineWeeklyTrigger,
	type CloudRoutineWindowTrigger,
} from "@qorpera/cloud-client/cloud-routines";
import type { RoutineFile } from "@qorpera/cloud-client/company-state-files";

/* When a routine runs next, from its file: the `next` column of the interfaces' `routines` source
 * (deploy/first-node/RUNTIME-INTERFACES.md §4). The file's trigger reads as the routine index reads it
 * (`cloudRoutineTriggerOfFile`), and the next time follows the orchestrator's schedule rules
 * (packages/runner-orchestrator/src/orchestrator.ts, `nextRoutineOccurrence`): an interval counts from its start, or
 * from 1970 without one; a weekly time is on the routine's own clock, from its start; a window steps through each
 * matching day from its first minute to its last. Only what the file says is known here: a routine that is not
 * active, waits for a file change, or has no time zone where it needs one has no next run, and so has one whose
 * `once` time or `ends` has passed. Quiet hours and a routine's count of runs are the orchestrator's to apply. */

/** A day's calendar date and clock time in a time zone. */
function calendarParts(
	instant: Date,
	timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number } {
	const values = new Map(
		new Intl.DateTimeFormat("en-CA", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
		})
			.formatToParts(instant)
			.map((part) => [part.type, part.value]),
	);
	return {
		year: Number(values.get("year")),
		month: Number(values.get("month")),
		day: Number(values.get("day")),
		hour: Number(values.get("hour")),
		minute: Number(values.get("minute")),
	};
}

/** The instant a zone's clock shows a date and time, or undefined when it never does (a skipped hour). */
function zonedInstant(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	timeZone: string,
): number | undefined {
	const target = Date.UTC(year, month - 1, day, hour, minute);
	let candidate = target;
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const actual = calendarParts(new Date(candidate), timeZone);
		const delta = target - Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
		if (delta === 0) break;
		candidate += delta;
	}
	const actual = calendarParts(new Date(candidate), timeZone);
	return actual.year === year &&
		actual.month === month &&
		actual.day === day &&
		actual.hour === hour &&
		actual.minute === minute
		? candidate
		: undefined;
}

/** The UTC date `offset` days from a zone's calendar day, as year, month and day. */
function dayAfter(local: { year: number; month: number; day: number }, offset: number) {
	const date = new Date(Date.UTC(local.year, local.month - 1, local.day + offset));
	return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), weekday: date.getUTCDay() };
}

function nextWeekly(trigger: CloudRoutineWeeklyTrigger, after: number): number | undefined {
	const startAt = trigger.startAt ? Date.parse(trigger.startAt) : Number.NaN;
	const searchAfter = Number.isFinite(startAt) && after < startAt ? startAt - 1 : after;
	const local = calendarParts(new Date(searchAfter), trigger.timeZone);
	const [hour, minute] = trigger.localTime.split(":").map(Number);
	for (let offset = 0; offset <= 14; offset += 1) {
		const day = dayAfter(local, offset);
		if (!trigger.weekdays.includes(CLOUD_ROUTINE_WEEKDAYS[day.weekday] ?? "sunday")) continue;
		const candidate = zonedInstant(day.year, day.month, day.day, hour ?? 0, minute ?? 0, trigger.timeZone);
		if (candidate !== undefined && candidate > after && (!Number.isFinite(startAt) || candidate >= startAt))
			return candidate;
	}
	return undefined;
}

function nextInWindow(trigger: CloudRoutineWindowTrigger, after: number): number | undefined {
	const local = calendarParts(new Date(after), trigger.timeZone);
	const start = Number(trigger.windowStart.slice(0, 2)) * 60 + Number(trigger.windowStart.slice(3));
	const end = Number(trigger.windowEnd.slice(0, 2)) * 60 + Number(trigger.windowEnd.slice(3));
	for (let offset = 0; offset <= 370; offset += 1) {
		const day = dayAfter(local, offset);
		if (trigger.months && !trigger.months.includes(day.month)) continue;
		if (trigger.weekdays && !trigger.weekdays.includes(CLOUD_ROUTINE_WEEKDAYS[day.weekday] ?? "sunday")) continue;
		for (let minute = start; minute <= end; minute += trigger.intervalMinutes) {
			const at = zonedInstant(day.year, day.month, day.day, Math.floor(minute / 60), minute % 60, trigger.timeZone);
			if (at !== undefined && at > after) return at;
		}
	}
	return undefined;
}

/** When the routine in `file` runs next after `after` (epoch milliseconds), as an instant, or null. */
export function routineNextRun(file: RoutineFile, after: number): string | null {
	if (file.status !== "active") return null;
	const trigger = cloudRoutineTriggerOfFile(file);
	if (trigger === null || trigger.kind === "listener") return null;
	let next: number | undefined;
	if (trigger.kind === "once") next = Date.parse(trigger.at);
	else if ("windowStart" in trigger) next = nextInWindow(trigger, after);
	else if ("localTime" in trigger) next = nextWeekly(trigger, after);
	else if (trigger.intervalMinutes > 0) {
		const interval = trigger.intervalMinutes * 60_000;
		const anchor = trigger.startAt ? Date.parse(trigger.startAt) : 0;
		next = anchor + Math.max(0, Math.floor((after - anchor) / interval) + 1) * interval;
	}
	if (next === undefined || !Number.isFinite(next) || next <= after) return null;
	if (file.ends !== null && next > Date.parse(file.ends)) return null;
	return new Date(next).toISOString();
}
