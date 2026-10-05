import { describe, expect, it } from "vitest";
import { cloudRoutineTriggerOfFile, routineFileSettings, routineFileTrigger } from "../src/cloud-routine-file.ts";
import {
	parseCompanyStateFile,
	type RoutineFile,
	setCompanyStateSettings,
	writeRoutineFile,
} from "../src/company-state-files.ts";

const PATH = "agents/nora/routines/inbox.md";
const id = "89900000-0000-4000-8000-0000000000e1";

function file(update: Partial<Omit<RoutineFile, "kind">> = {}): RoutineFile {
	return {
		kind: "routine",
		id,
		title: "Inbox",
		status: "active",
		trigger: { when: "every", minutes: 30, starts: null },
		timezone: null,
		ends: null,
		runs: null,
		quiet: null,
		effort: "low",
		reply: "required",
		conclusion: null,
		instructions: "Read the inbox and say what needs an answer.",
		...update,
	};
}
const text = (routine: RoutineFile) => {
	const { kind: _kind, ...rest } = routine;
	return writeRoutineFile(rest);
};
const parse = (source: string): RoutineFile => {
	const parsed = parseCompanyStateFile(PATH, source);
	if (!parsed?.ok || parsed.file.kind !== "routine") throw new Error(`Not a routine: ${JSON.stringify(parsed)}`);
	return parsed.file;
};

describe("a routine file's trigger as the routine list reads it", () => {
	it("mirrors the index: id file, a start to the millisecond, the file's reply", () => {
		expect(
			cloudRoutineTriggerOfFile(file({ trigger: { when: "every", minutes: 30, starts: "2026-10-04T08:00:00Z" } })),
		).toEqual({
			id: "file",
			kind: "schedule",
			intervalMinutes: 30,
			startAt: "2026-10-04T08:00:00.000Z",
			replyPolicy: "required",
		});
		expect(
			cloudRoutineTriggerOfFile(
				file({
					trigger: { when: "weekly", days: ["mon", "fri"], time: "09:30", starts: null },
					timezone: "Europe/Copenhagen",
					reply: "optional",
				}),
			),
		).toEqual({
			id: "file",
			kind: "schedule",
			intervalMinutes: 1440,
			weekdays: ["monday", "friday"],
			localTime: "09:30",
			timeZone: "Europe/Copenhagen",
			replyPolicy: "optional",
		});
		expect(
			cloudRoutineTriggerOfFile(
				file({
					trigger: { when: "window", minutes: 60, from: "08:00", to: "17:00", days: ["mon"], months: [1, 2] },
					timezone: "UTC",
				}),
			),
		).toEqual({
			id: "file",
			kind: "schedule",
			intervalMinutes: 60,
			windowStart: "08:00",
			windowEnd: "17:00",
			timeZone: "UTC",
			weekdays: ["monday"],
			months: [1, 2],
			replyPolicy: "required",
		});
		expect(
			cloudRoutineTriggerOfFile(file({ trigger: { when: "once", at: "2026-10-05T07:00:00Z" }, timezone: "UTC" })),
		).toEqual({ id: "file", kind: "once", at: "2026-10-05T07:00:00Z", timeZone: "UTC", replyPolicy: "required" });
		expect(
			cloudRoutineTriggerOfFile(file({ trigger: { when: "file-change", watch: "notes", match: "subtree" } })),
		).toBeNull();
	});

	it("reads an event routine as W2's listener on its hook, as the index compiles it (E2)", () => {
		const hook = "89900000-0000-4000-8000-0000000000b1";
		expect(
			cloudRoutineTriggerOfFile(
				file({ trigger: { when: "event", hook, only: ["invoice.paid", "charge.refunded"] }, timezone: "UTC" }),
			),
		).toEqual({
			id: "file",
			kind: "listener",
			source: "event",
			hookId: hook,
			only: ["invoice.paid", "charge.refunded"],
			timeZone: "UTC",
			replyPolicy: "required",
		});
		expect(
			cloudRoutineTriggerOfFile(
				file({ trigger: { when: "event", hook, only: null }, timezone: "Europe/Oslo", reply: "silent" }),
			),
		).toEqual({
			id: "file",
			kind: "listener",
			source: "event",
			hookId: hook,
			timeZone: "Europe/Oslo",
			replyPolicy: "silent",
		});
		expect(cloudRoutineTriggerOfFile(file({ trigger: { when: "event", hook, only: null } }))).toBeNull();
		expect(
			routineFileTrigger({ id: "file", kind: "listener", source: "event", hookId: hook, timeZone: "UTC" }),
		).toBeNull();
	});
});

describe("what a member's editor makes, as a file's trigger", () => {
	it("maps every N minutes and days at a time, and nothing else", () => {
		expect(routineFileTrigger({ id: "t", kind: "schedule", intervalMinutes: 45 })).toEqual({
			trigger: { when: "every", minutes: 45, starts: null },
			timezone: null,
		});
		expect(
			routineFileTrigger({
				id: "t",
				kind: "schedule",
				intervalMinutes: 1440,
				weekdays: ["sunday", "wednesday"],
				localTime: "07:15",
				timeZone: "America/New_York",
				startAt: "2026-10-08T11:15:00.000Z",
			}),
		).toEqual({
			trigger: { when: "weekly", days: ["sun", "wed"], time: "07:15", starts: "2026-10-08T11:15:00Z" },
			timezone: "America/New_York",
		});
		expect(
			routineFileTrigger({
				id: "t",
				kind: "schedule",
				intervalMinutes: 60,
				windowStart: "08:00",
				windowEnd: "17:00",
				timeZone: "UTC",
			}),
		).toBeNull();
		expect(routineFileTrigger({ id: "t", kind: "once", at: "2026-10-05T07:00:00Z", timeZone: "UTC" })).toBeNull();
		expect(
			routineFileTrigger({
				id: "t",
				kind: "listener",
				source: "company-file",
				path: "notes",
				match: "exact",
				timeZone: "UTC",
			}),
		).toBeNull();
		expect(routineFileTrigger({ id: "t", kind: "schedule", intervalMinutes: 45, startAt: "not a time" })).toBeNull();
	});
});

describe("the settings an edit changes", () => {
	it("is empty when the edit changes nothing, so nothing is written", () => {
		const before = file({ trigger: { when: "every", minutes: 30, starts: "2026-10-04T08:00:00Z" } });
		expect(
			routineFileSettings(before, {
				title: before.title,
				trigger: before.trigger,
				timezone: null,
				reply: before.reply,
			}),
		).toEqual({});
		// A start the index spells to the millisecond is the same start.
		const mapped = routineFileTrigger({
			id: "file",
			kind: "schedule",
			intervalMinutes: 30,
			startAt: "2026-10-04T08:00:00.000Z",
		})!;
		expect(routineFileSettings(before, { title: before.title, ...mapped, reply: before.reply })).toEqual({});
	});

	it("rewrites only what changed, and the file reads back as the edit", () => {
		const before = file({
			quiet: { start: "22:00", end: "06:00", timezone: "Europe/Copenhagen" },
			timezone: "Europe/Copenhagen",
		});
		const source = `${text(before).replace("---\n", "---\n# kept note\n")}`;
		const edit = {
			title: "Inbox, mornings",
			trigger: { when: "weekly", days: ["mon", "tue"], time: "08:30", starts: null } as const,
			timezone: "Europe/Copenhagen",
			reply: "silent" as const,
		};
		const changes = routineFileSettings(parse(source), edit);
		expect(changes).toEqual({
			title: "Inbox, mornings",
			when: "weekly",
			minutes: null,
			days: ["mon", "tue"],
			time: "08:30",
			reply: "silent",
		});
		const after = setCompanyStateSettings(source, changes);
		expect(after).toContain("# kept note");
		const read = parse(after);
		expect(read.title).toBe(edit.title);
		expect(read.trigger).toEqual(edit.trigger);
		expect(read.timezone).toBe("Europe/Copenhagen");
		expect(read.reply).toBe("silent");
		expect(read.quiet).toEqual(before.quiet);
		expect(read.effort).toBe(before.effort);
		expect(read.instructions).toBe(before.instructions);
	});

	it("keeps the time zone when an edit moves to every N minutes, and removes a let-go start", () => {
		const before = file({
			trigger: { when: "weekly", days: ["mon"], time: "09:00", starts: "2026-10-05T07:00:00Z" },
			timezone: "Europe/Copenhagen",
		});
		const changes = routineFileSettings(before, {
			title: before.title,
			trigger: { when: "every", minutes: 90, starts: null },
			timezone: null,
			reply: before.reply,
		});
		expect(changes).toEqual({ when: "every", minutes: 90, starts: null, days: null, time: null });
		const read = parse(setCompanyStateSettings(text(before), changes));
		expect(read.trigger).toEqual({ when: "every", minutes: 90, starts: null });
		expect(read.timezone).toBe("Europe/Copenhagen");
	});

	it("keeps an event routine's hook and types through an edit of the rest, and drops them for a clock", () => {
		const trigger = { when: "event", hook: "89900000-0000-4000-8000-0000000000b1", only: ["form.posted"] } as const;
		const before = file({ trigger, timezone: "UTC" });
		const renamed = routineFileSettings(before, { title: "Forms", trigger, timezone: "UTC", reply: "optional" });
		expect(renamed).toEqual({ title: "Forms", reply: "optional" });
		expect(parse(setCompanyStateSettings(text(before), renamed))).toMatchObject({ title: "Forms", trigger });
		const clock = routineFileSettings(before, {
			title: before.title,
			trigger: { when: "every", minutes: 60, starts: null },
			timezone: null,
			reply: before.reply,
		});
		expect(clock).toEqual({ when: "every", minutes: 60, hook: null, only: null });
		expect(parse(setCompanyStateSettings(text(before), clock)).trigger).toEqual({
			when: "every",
			minutes: 60,
			starts: null,
		});
	});

	it("keeps quiet hours in the zone they went by when an edit changes the routine's zone", () => {
		// Quiet hours without a zone of their own go by the routine's: the file has no quiet_timezone.
		const quiet = { start: "22:00", end: "06:00", timezone: "Europe/Copenhagen" };
		const source = text(file({ timezone: "Europe/Copenhagen", quiet }));
		expect(source).not.toMatch(/^quiet_timezone:/m);
		const edit = {
			title: "Inbox",
			trigger: { when: "weekly", days: ["mon"], time: "08:30", starts: null } as const,
			timezone: "America/New_York",
			reply: "required" as const,
		};
		const changes = routineFileSettings(parse(source), edit);
		expect(changes).toMatchObject({ timezone: "America/New_York", quiet_timezone: "Europe/Copenhagen" });
		const after = setCompanyStateSettings(source, changes);
		expect(parse(after)).toMatchObject({ timezone: "America/New_York", quiet });
		// A file that names their zone, even the routine's own, reads the same.
		const named = source.replace("quiet: ", "quiet_timezone: Europe/Copenhagen\nquiet: ");
		expect(parse(named).quiet).toEqual(quiet);
		expect(parse(setCompanyStateSettings(named, routineFileSettings(parse(named), edit))).quiet).toEqual(quiet);

		// Quiet hours with a zone of their own keep it, and nothing about them is written.
		const own = { ...quiet, timezone: "UTC" };
		const ownSource = text(file({ timezone: "Europe/Copenhagen", quiet: own }));
		const ownChanges = routineFileSettings(parse(ownSource), edit);
		expect(ownChanges).not.toHaveProperty("quiet_timezone");
		expect(parse(setCompanyStateSettings(ownSource, ownChanges)).quiet).toEqual(own);
		// The zone as it was: nothing about quiet hours either.
		expect(routineFileSettings(parse(source), { ...edit, timezone: "Europe/Copenhagen" })).not.toHaveProperty(
			"quiet_timezone",
		);
	});
});
