// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { dayLabel, idleLine } from "../src/app/agent-line.ts";
import { AgentNotes, type AgentNotesSource, nextRuns, unsettledRuns } from "../src/app/agent-notes.ts";
import { setLanguagePreference } from "../src/ui/preferences.ts";

/* The line under an idle agent's name in the rail (Jonas, 11 Nov 2026, option A): the most useful thing that holds.
 * Since 14 Nov 2026 nothing of the agent's wall is in it (Jonas: "rather drop the wall - it's the wrong medium for
 * activity"; of the wall's Now line: "Let it go too"): a run that did not finish, a rest at the usage limit, the next
 * planned run, else when the agent was hired. */

const NOW = new Date("2026-11-11T10:00:00Z");
const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000).toISOString();

afterEach(() => {
	vi.useRealTimers();
	setLanguagePreference("en");
});

describe("the idle line", () => {
	const base = { failed: false, hiredAt: "2026-11-01T09:00:00Z" };
	const note = { next: { title: "Market check", at: at(3) } };

	it("says a run did not finish before anything else, in red", () => {
		expect(idleLine({ ...base, failed: true, restingUntil: at(2), note }, NOW)).toEqual({
			text: "Didn't finish",
			tone: "failed",
		});
	});

	it("then that the agent rests at its usage limit, while the pause holds", () => {
		expect(idleLine({ ...base, restingUntil: at(2), note }, NOW).text).toMatch(/^Resting until \d/);
		// A pause that has ended says nothing: the next run shows.
		expect(idleLine({ ...base, restingUntil: at(-1), note }, NOW).text).toMatch(/^Next: Market check · \d/);
	});

	it("then its next planned run, however far off", () => {
		expect(idleLine({ ...base, note }, NOW)).toEqual({ text: expect.stringMatching(/^Next: Market check · \d/) });
		// No 12-hour rule any more: it only ranked the run against the wall's last-done line.
		const later = { next: { title: "Market check", at: at(30) } };
		expect(idleLine({ ...base, note: later }, NOW).text).toMatch(/^Next: Market check · tomorrow \d/);
		const weeks = { next: { title: "Quarterly report", at: at(24 * 20) } };
		expect(idleLine({ ...base, note: weeks }, NOW).text).toMatch(/^Next: Quarterly report · Dec 1 \d/);
		// A next run that has passed is not shown before the routines are read again.
		expect(idleLine({ ...base, note: { next: { title: "Market check", at: at(-1) } } }, NOW).text).toBe(
			`Hired ${dayLabel("2026-11-01", NOW)}`,
		);
	});

	it("falls back to when the agent was hired, so every row has a line", () => {
		expect(idleLine(base, NOW).text).toBe(`Hired ${dayLabel("2026-11-01", NOW)}`);
		expect(idleLine({ ...base, note: {} }, NOW).text).toBe(`Hired ${dayLabel("2026-11-01", NOW)}`);
		expect(idleLine({ ...base, hiredAt: "" }, NOW).text).toBe("Hired");
	});

	it("names days in few words", () => {
		expect(dayLabel("2026-11-11", NOW)).toBe("today");
		expect(dayLabel("2026-11-10", NOW)).toBe("yesterday");
		expect(dayLabel("2026-11-08", NOW)).toBe("Sun");
		expect(dayLabel("2026-11-01", NOW)).toBe("Nov 1");
		expect(dayLabel("2025-12-24", NOW)).toBe("Dec 24, 2025");
	});

	it("speaks Danish", () => {
		setLanguagePreference("da");
		expect(idleLine({ ...base, failed: true }, NOW).text).toBe("Blev ikke færdig");
		expect(idleLine({ ...base, restingUntil: at(2) }, NOW).text).toMatch(/^Hviler til \d/);
		expect(idleLine({ ...base, note }, NOW).text).toMatch(/^Næste: Market check · \d/);
		expect(idleLine(base, NOW).text).toMatch(/^Ansat /);
		expect(dayLabel("2026-11-10", NOW)).toBe("i går");
	});
});

describe("agent notes", () => {
	it("keeps each agent's active routine that runs next", () => {
		const routine = (staffAgentId: string, title: string, nextRunAt: string | null, status = "active" as const) => ({
			staffAgentId,
			title,
			nextRunAt,
			status,
		});
		const next = nextRuns(
			[
				routine("a", "Weekly report", at(48)),
				routine("a", " Market check ", at(3)),
				routine("a", "Old", at(-2)),
				routine("b", "Paused one", at(1), "paused" as never),
				routine("b", "Never", null),
			],
			NOW.getTime(),
		);
		expect([...next]).toEqual([["a", { title: "Market check", at: at(3) }]]);
	});

	it("lists the routines once, publishes only changes, lists again after a settled hint", async () => {
		vi.useFakeTimers({ now: NOW });
		const listRoutines = vi.fn(async () => [
			{ staffAgentId: "b", title: "Market check", nextRunAt: at(3), status: "active" as const },
		]);
		const controller = new AbortController();
		const source: AgentNotesSource = {
			agents: () => ["a", "b"],
			listRoutines,
			signal: controller.signal,
		};
		const publish = vi.fn();
		const notes = new AgentNotes(source, publish);
		notes.open();
		await vi.advanceTimersByTimeAsync(0);
		expect(publish).toHaveBeenCalledTimes(1);
		// An agent with no next run has no note: its line is when it was hired.
		expect(publish).toHaveBeenLastCalledWith({ b: { next: { title: "Market check", at: at(3) } } });
		// A hint is read for once the folder settles and the last read is 15 s old; nothing new publishes nothing.
		notes.changed();
		notes.changed();
		await vi.advanceTimersByTimeAsync(14_000);
		expect(listRoutines).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(listRoutines).toHaveBeenCalledTimes(2);
		expect(publish).toHaveBeenCalledTimes(1);
		// The routines are listed again once the next run has run.
		listRoutines.mockClear();
		await vi.advanceTimersByTimeAsync(3 * 3_600_000 + 90_000);
		expect(listRoutines).toHaveBeenCalledTimes(1);
		// The run has passed and the list still names it: it is no agent's next run, and the line goes.
		expect(publish).toHaveBeenLastCalledWith({});
		// Closed, nothing more is read.
		controller.abort();
		listRoutines.mockClear();
		notes.changed();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(listRoutines).not.toHaveBeenCalled();
	});

	it("reads a roster that arrives after the company opened at once, and the same roster not again", async () => {
		vi.useFakeTimers({ now: NOW });
		let agents: string[] = [];
		const listRoutines = vi.fn(async () => [
			{ staffAgentId: "a", title: "Market check", nextRunAt: at(30), status: "active" as const },
		]);
		const publish = vi.fn();
		const notes = new AgentNotes(
			{ agents: () => agents, listRoutines, signal: new AbortController().signal },
			publish,
		);
		notes.open();
		await vi.advanceTimersByTimeAsync(0);
		expect(listRoutines).toHaveBeenCalledTimes(1);
		expect(publish).toHaveBeenLastCalledWith({});
		agents = ["a"];
		notes.agentsChanged();
		await vi.advanceTimersByTimeAsync(0);
		expect(publish).toHaveBeenLastCalledWith({ a: { next: { title: "Market check", at: at(30) } } });
		notes.agentsChanged();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(listRoutines).toHaveBeenCalledTimes(2);
		// A hint reads whoever the roster holds by then.
		agents = ["a", "b"];
		notes.changed();
		await vi.advanceTimersByTimeAsync(15_000);
		expect(listRoutines).toHaveBeenCalledTimes(3);
		notes.dispose();
	});

	it("lists the routines every five minutes while a scheduled next run is unsettled", async () => {
		vi.useFakeTimers({ now: NOW });
		const schedule = [{ kind: "schedule" as const }] as never;
		const listener = [{ kind: "listener" as const }] as never;
		const routine = (nextRunAt: string | null, triggers = schedule) => ({
			staffAgentId: "a",
			title: "Market check",
			status: "active" as const,
			nextRunAt,
			triggers,
		});
		expect(unsettledRuns([routine(null)], NOW.getTime())).toBe(true);
		expect(unsettledRuns([routine(at(-1))], NOW.getTime())).toBe(true);
		expect(unsettledRuns([routine(at(1))], NOW.getTime())).toBe(false);
		// A routine that waits for a file change or an event has no next run to wait for.
		expect(unsettledRuns([routine(null, listener)], NOW.getTime())).toBe(false);
		let listed = [routine(null)];
		const listRoutines = vi.fn(async () => listed);
		const publish = vi.fn();
		const notes = new AgentNotes(
			{ agents: () => ["a"], listRoutines, signal: new AbortController().signal },
			publish,
		);
		notes.open();
		await vi.advanceTimersByTimeAsync(0);
		expect(publish).toHaveBeenLastCalledWith({});
		// The scheduler works the next run out with no change to the folder: the next look finds it.
		listed = [routine(at(30))];
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(listRoutines).toHaveBeenCalledTimes(2);
		expect(publish).toHaveBeenLastCalledWith({ a: { next: { title: "Market check", at: at(30) } } });
		// Settled, it waits for that run, not five minutes.
		await vi.advanceTimersByTimeAsync(60 * 60_000);
		expect(listRoutines).toHaveBeenCalledTimes(2);
		notes.dispose();
	});
});
