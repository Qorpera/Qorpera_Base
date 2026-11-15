import { presentationDay, presentationLocale, previousDay, t, timeZoneOption } from "../ui/preferences.ts";
import type { AgentNote } from "./agent-notes.ts";

/* The line under an agent's name in the rail while it does not work (Jonas, 11 Nov 2026, option A: "the most useful
 * thing first"). A working or writing agent, and one that needs the member, keep their own line (ui/agent-activity.ts);
 * otherwise the first of these that holds is shown:
 *   1. its run did not finish;
 *   2. it rests at its login's usage limit until the reset;
 *   3. its next planned run, however far off;
 *   4. when it was hired.
 * So every agent's row has a line. The agent's wall gave three more lines here (what waits on the member, its Now line,
 * what it last got done); they went with the wall (Jonas, 14 Nov 2026: "rather drop the wall - it's the wrong medium
 * for activity", and of the Now line: "Let it go too"). The next run no longer needs a 12-hour rule: that only ranked
 * it against the wall's last-done line. */

export interface IdleLineInput {
	failed: boolean;
	/** The end of a pause at the login's usage limit. */
	restingUntil?: string;
	note?: AgentNote;
	/** When the agent was hired (its row's creation). */
	hiredAt: string;
}

export interface IdleLine {
	text: string;
	/** A failure reads in the failure's red. */
	tone?: "failed";
}

const WEEK_DAYS = 6;

export function idleLine(input: IdleLineInput, now = new Date()): IdleLine {
	if (input.failed) return { text: t("Didn't finish"), tone: "failed" };
	const until = input.restingUntil && Date.parse(input.restingUntil);
	if (until && until > now.getTime()) return { text: t("Resting until {time}", { time: moment(until, now) }) };
	const next = input.note?.next;
	const nextAt = next ? Date.parse(next.at) : Number.NaN;
	if (next && nextAt > now.getTime())
		return { text: t("Next: {title} · {time}", { title: next.title, time: moment(nextAt, now) }) };
	const hired = Date.parse(input.hiredAt);
	return Number.isFinite(hired)
		? { text: t("Hired {day}", { day: dayLabel(presentationDay(new Date(hired), timeZoneOption().timeZone), now) }) }
		: { text: t("Hired") };
}

/** A calendar day (`YYYY-MM-DD`) in few words: today, yesterday, a weekday this past week, else the date. */
export function dayLabel(day: string, now = new Date()): string {
	const zone = timeZoneOption();
	const today = presentationDay(now, zone.timeZone);
	if (day === today) return t("today");
	if (day === previousDay(today)) return t("yesterday");
	const [year, month, date] = day.split("-").map(Number);
	if (!year || !month || !date) return day;
	// Noon UTC of that day names it in every zone.
	const noon = new Date(Date.UTC(year, month - 1, date, 12));
	const back = (Date.parse(`${today}T12:00:00Z`) - noon.getTime()) / 86_400_000;
	return noon.toLocaleDateString(
		presentationLocale(),
		back > 0 && back <= WEEK_DAYS
			? { weekday: "short", timeZone: "UTC" }
			: {
					month: "short",
					day: "numeric",
					...(day.slice(0, 4) !== today.slice(0, 4) ? { year: "numeric" as const } : {}),
					timeZone: "UTC",
				},
	);
}

/** A coming moment in few words: the clock today, "tomorrow" and the clock, a weekday and the clock this week, else
 * the date and the clock. */
function moment(at: number, now: Date): string {
	const zone = timeZoneOption();
	const date = new Date(at);
	const clock = date.toLocaleTimeString(presentationLocale(), { hour: "numeric", minute: "2-digit", ...zone });
	const day = presentationDay(date, zone.timeZone);
	const today = presentationDay(now, zone.timeZone);
	if (day === today) return clock;
	if (previousDay(day) === today) return t("tomorrow {time}", { time: clock });
	const ahead = (at - now.getTime()) / 86_400_000;
	const shown = date.toLocaleDateString(
		presentationLocale(),
		ahead < WEEK_DAYS ? { weekday: "short", ...zone } : { month: "short", day: "numeric", ...zone },
	);
	return `${shown} ${clock}`;
}
