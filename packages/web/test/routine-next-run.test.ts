import type { RoutineFile, RoutineTrigger } from "@qorpera/cloud-client/company-state-files";
import { describe, expect, it } from "vitest";
import { routineNextRun } from "../src/app/routine-next-run.ts";

/* When a routine runs next, from its file (app/routine-next-run.ts), by the orchestrator's schedule rules
 * (packages/runner-orchestrator/src/orchestrator.ts, `nextRoutineOccurrence`). The weekly and window cases marked so
 * are the orchestrator's own test's (packages/runner-orchestrator/test/orchestrator.test.ts). */

const routine = (
	trigger: RoutineTrigger,
	update: Partial<Omit<RoutineFile, "kind" | "trigger">> = {},
): RoutineFile => ({
	kind: "routine",
	id: "00000000-0000-4000-8000-000000000001",
	title: "Brief",
	status: "active",
	trigger,
	timezone: "UTC",
	ends: null,
	runs: null,
	quiet: null,
	effort: "low",
	reply: "required",
	conclusion: null,
	instructions: "Do it.",
	...update,
});

const hourly: RoutineTrigger = { when: "every", minutes: 60, starts: null };
const mondays = (starts: string | null = null): RoutineTrigger => ({
	when: "weekly",
	days: ["mon"],
	time: "09:00",
	starts,
});
const officeHours: RoutineTrigger = {
	when: "window",
	minutes: 30,
	from: "09:00",
	to: "10:00",
	days: ["mon", "tue", "wed", "thu", "fri"],
	months: null,
};

const CASES: readonly {
	readonly name: string;
	readonly file: RoutineFile;
	readonly after: string;
	readonly next: string | null;
}[] = [
	// Every N minutes: from its start, or from 1970 without one.
	{
		name: "every hour, from 1970",
		file: routine(hourly),
		after: "2026-10-06T10:20:00Z",
		next: "2026-10-06T11:00:00.000Z",
	},
	{
		name: "every hour, at a slot",
		file: routine(hourly),
		after: "2026-10-06T11:00:00Z",
		next: "2026-10-06T12:00:00.000Z",
	},
	{
		name: "every 90 minutes, from its start",
		file: routine({ when: "every", minutes: 90, starts: "2026-10-06T08:15:00Z" }),
		after: "2026-10-06T10:20:00Z",
		next: "2026-10-06T11:15:00.000Z",
	},
	{
		name: "every 90 minutes, before its start",
		file: routine({ when: "every", minutes: 90, starts: "2026-10-07T08:15:00Z" }),
		after: "2026-10-06T10:20:00Z",
		next: "2026-10-07T08:15:00.000Z",
	},
	{
		name: "every hour, with no time zone, which it doesn't need",
		file: routine(hourly, { timezone: null }),
		after: "2026-10-06T10:20:00Z",
		next: "2026-10-06T11:00:00.000Z",
	},
	// Weekly, on the routine's own clock, from its start.
	{
		name: "weekly, the next Monday (orchestrator)",
		file: routine(mondays()),
		after: "2026-08-26T14:07:12.345Z",
		next: "2026-08-31T09:00:00.000Z",
	},
	{
		name: "weekly, at its own slot (orchestrator)",
		file: routine(mondays()),
		after: "2026-08-31T09:00:00Z",
		next: "2026-09-07T09:00:00.000Z",
	},
	{
		name: "weekly, waiting for a later start (orchestrator)",
		file: routine(mondays("2026-09-07T09:00:00Z")),
		after: "2026-08-25T12:00:00Z",
		next: "2026-09-07T09:00:00.000Z",
	},
	{
		name: "weekly, on its own time zone's clock",
		file: routine(mondays(), { timezone: "Europe/Copenhagen" }),
		after: "2026-10-06T10:00:00Z",
		next: "2026-10-12T07:00:00.000Z",
	},
	{
		name: "weekly, past a time the clock change skips, to the next day",
		file: routine(
			{ when: "weekly", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], time: "02:30", starts: null },
			{ timezone: "Europe/Copenhagen" },
		),
		after: "2026-03-28T12:00:00Z",
		next: "2026-03-30T00:30:00.000Z",
	},
	// A window: each matching day, from its first minute to its last.
	{
		name: "a window, the next weekday (orchestrator)",
		file: routine(officeHours),
		after: "2026-08-25T12:00:00Z",
		next: "2026-08-26T09:00:00.000Z",
	},
	{
		name: "a window, inside it",
		file: routine(officeHours),
		after: "2026-08-26T09:10:00Z",
		next: "2026-08-26T09:30:00.000Z",
	},
	{
		name: "a window, its last minute",
		file: routine(officeHours),
		after: "2026-08-26T09:30:00Z",
		next: "2026-08-26T10:00:00.000Z",
	},
	{
		name: "a window, over a weekend",
		file: routine(officeHours),
		after: "2026-08-28T10:00:00Z",
		next: "2026-08-31T09:00:00.000Z",
	},
	{
		name: "a window, in its months only",
		file: routine({ when: "window", minutes: 60, from: "08:00", to: "09:00", days: null, months: [12] }),
		after: "2026-10-06T10:00:00Z",
		next: "2026-12-01T08:00:00.000Z",
	},
	{
		name: "a window, past an hour the clock change skips",
		file: routine(
			{ when: "window", minutes: 60, from: "01:00", to: "04:00", days: null, months: null },
			{ timezone: "Europe/Copenhagen" },
		),
		after: "2026-03-29T00:00:00Z",
		next: "2026-03-29T01:00:00.000Z",
	},
	// Once.
	{
		name: "once, ahead",
		file: routine({ when: "once", at: "2026-10-09T09:00:00Z" }),
		after: "2026-10-06T10:00:00Z",
		next: "2026-10-09T09:00:00.000Z",
	},
	{
		name: "once, passed",
		file: routine({ when: "once", at: "2026-10-05T09:00:00Z" }),
		after: "2026-10-06T10:00:00Z",
		next: null,
	},
	// Its end.
	{
		name: "at its end",
		file: routine(mondays(), { ends: "2026-10-12T09:00:00Z" }),
		after: "2026-10-06T10:00:00Z",
		next: "2026-10-12T09:00:00.000Z",
	},
	{
		name: "after its end",
		file: routine(mondays(), { ends: "2026-10-12T08:59:00Z" }),
		after: "2026-10-06T10:00:00Z",
		next: null,
	},
	// No next run.
	{ name: "paused", file: routine(mondays(), { status: "paused" }), after: "2026-10-06T10:00:00Z", next: null },
	{ name: "concluded", file: routine(mondays(), { status: "concluded" }), after: "2026-10-06T10:00:00Z", next: null },
	{
		name: "weekly, with no time zone",
		file: routine(mondays(), { timezone: null }),
		after: "2026-10-06T10:00:00Z",
		next: null,
	},
	{
		name: "a window, with no time zone",
		file: routine(officeHours, { timezone: null }),
		after: "2026-10-06T10:00:00Z",
		next: null,
	},
	{
		name: "once, with no time zone",
		file: routine({ when: "once", at: "2026-10-09T09:00:00Z" }, { timezone: null }),
		after: "2026-10-06T10:00:00Z",
		next: null,
	},
	{
		name: "on a file change",
		file: routine({ when: "file-change", watch: "vision", match: "exact" }),
		after: "2026-10-06T10:00:00Z",
		next: null,
	},
];

describe("a routine's next run", () => {
	it.each(CASES)("$name", ({ file, after, next }) => {
		expect(routineNextRun(file, Date.parse(after))).toBe(next);
	});
});
