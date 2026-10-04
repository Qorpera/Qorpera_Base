import type { CloudRoutineReplyPolicy, CloudRoutineTrigger, CloudRoutineWeekday } from "./cloud-routines.ts";
import {
	type CompanyStateSetting,
	canonicalCompanyStateInstant,
	type RoutineDay,
	type RoutineFile,
	type RoutineTrigger,
} from "./company-state-files.ts";

/*
 * A routine's file and the routine as members' clients see it (folder core C4, P34r;
 * deploy/first-node/RUNTIME-COMPANY-FOLDER-C4-MEMBERS.md §6). `cloudRoutineTriggerOfFile` is the twin of the index's
 * `qorpera_company_state_routine_trigger`: what a file's trigger reads as in the routine list. `routineFileTrigger` is
 * its inverse for what a member's editor makes, and `routineFileSettings` the settings an edit changes, so a save
 * rewrites only those keys (`setCompanyStateSettings`) and every other byte of the file stays.
 */

const FILE_DAYS: Readonly<Record<CloudRoutineWeekday, RoutineDay>> = {
	sunday: "sun",
	monday: "mon",
	tuesday: "tue",
	wednesday: "wed",
	thursday: "thu",
	friday: "fri",
	saturday: "sat",
};
const CLOUD_DAYS: Readonly<Record<RoutineDay, CloudRoutineWeekday>> = {
	sun: "sunday",
	mon: "monday",
	tue: "tuesday",
	wed: "wednesday",
	thu: "thursday",
	fri: "friday",
	sat: "saturday",
};

/** An instant as the index keeps a schedule's start: to the millisecond, in UTC. */
function indexInstant(text: string): string {
	return new Date(text).toISOString();
}

/** What a routine file's trigger reads as in the routine list, as the index makes it: its id is always `file`, a start
 * is kept to the millisecond, and the reply is the file's. Null for a trigger the index does not schedule
 * (`file-change`, until the folder's file events reach routines). */
export function cloudRoutineTriggerOfFile(file: RoutineFile): CloudRoutineTrigger | null {
	const trigger = file.trigger;
	const base = { id: "file", replyPolicy: file.reply as CloudRoutineReplyPolicy };
	const start = (starts: string | null) => (starts === null ? {} : { startAt: indexInstant(starts) });
	switch (trigger.when) {
		case "every":
			return { ...base, kind: "schedule", intervalMinutes: trigger.minutes, ...start(trigger.starts) };
		case "weekly":
			if (file.timezone === null) return null;
			return {
				...base,
				kind: "schedule",
				intervalMinutes: 1440,
				weekdays: trigger.days.map((day) => CLOUD_DAYS[day]),
				localTime: trigger.time,
				timeZone: file.timezone,
				...start(trigger.starts),
			};
		case "window":
			if (file.timezone === null) return null;
			return {
				...base,
				kind: "schedule",
				intervalMinutes: trigger.minutes,
				windowStart: trigger.from,
				windowEnd: trigger.to,
				timeZone: file.timezone,
				...(trigger.days === null ? {} : { weekdays: trigger.days.map((day) => CLOUD_DAYS[day]) }),
				...(trigger.months === null ? {} : { months: [...trigger.months] }),
			};
		case "once":
			if (file.timezone === null) return null;
			return { ...base, kind: "once", at: trigger.at, timeZone: file.timezone };
		case "file-change":
			return null;
	}
}

/** The file's trigger and time zone for a trigger a member's editor makes: every N minutes, or days at a time with
 * the member's zone. Null for anything else (a window, a file change, an event, a dynamic routine's next run), which a
 * member's editor does not make. */
export function routineFileTrigger(
	trigger: CloudRoutineTrigger,
): { readonly trigger: RoutineTrigger; readonly timezone: string | null } | null {
	if (trigger.kind !== "schedule" || "windowStart" in trigger) return null;
	const starts = trigger.startAt === undefined ? null : canonicalCompanyStateInstant(trigger.startAt);
	if (trigger.startAt !== undefined && starts === null) return null;
	if (!("localTime" in trigger))
		return { trigger: { when: "every", minutes: trigger.intervalMinutes, starts }, timezone: null };
	return {
		trigger: { when: "weekly", days: trigger.weekdays.map((day) => FILE_DAYS[day]), time: trigger.localTime, starts },
		timezone: trigger.timeZone,
	};
}

type FlatTrigger = Partial<
	Record<
		"when" | "minutes" | "starts" | "days" | "time" | "from" | "to" | "months" | "at" | "watch" | "match",
		CompanyStateSetting
	>
>;

function flat(trigger: RoutineTrigger): FlatTrigger {
	switch (trigger.when) {
		case "every":
			return { when: "every", minutes: trigger.minutes, starts: trigger.starts };
		case "weekly":
			return { when: "weekly", days: trigger.days, time: trigger.time, starts: trigger.starts };
		case "window":
			return {
				when: "window",
				minutes: trigger.minutes,
				from: trigger.from,
				to: trigger.to,
				days: trigger.days,
				months: trigger.months === null ? null : trigger.months.map(String),
			};
		case "once":
			return { when: "once", at: trigger.at };
		case "file-change":
			return { when: "file-change", watch: trigger.watch, match: trigger.match };
	}
}

const same = (a: CompanyStateSetting | undefined, b: CompanyStateSetting | undefined) =>
	JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The settings an edit changes in a routine file: the title, the trigger's keys (those of the trigger it had and the
 * new one does not are removed), the time zone when the new trigger names one (it is never removed: quiet hours without
 * their own zone take it), and the reply. Empty when the edit changes none of them. The instructions are the body,
 * which `setCompanyStateSettings` leaves as it is. */
export function routineFileSettings(
	file: RoutineFile,
	edit: {
		readonly title: string;
		readonly trigger: RoutineTrigger;
		readonly timezone: string | null;
		readonly reply: RoutineFile["reply"];
	},
): Record<string, CompanyStateSetting> {
	const changes: Record<string, CompanyStateSetting> = {};
	if (edit.title !== file.title) changes.title = edit.title;
	const before = flat(file.trigger);
	const after = flat(edit.trigger);
	for (const key of new Set([...Object.keys(before), ...Object.keys(after)]) as Set<keyof FlatTrigger>) {
		const next = after[key] ?? null;
		if (!same(before[key], next)) changes[key] = next;
	}
	if (edit.timezone !== null && edit.timezone !== file.timezone) changes.timezone = edit.timezone;
	if (edit.reply !== file.reply) changes.reply = edit.reply;
	return changes;
}
