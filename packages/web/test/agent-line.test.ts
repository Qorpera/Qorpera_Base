// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { dayLabel, idleLine } from "../src/app/agent-line.ts";
import { AgentNotes, nextRuns, unsettledRuns, wallNote } from "../src/app/agent-notes.ts";
import { setLanguagePreference } from "../src/ui/preferences.ts";

/* The line under an idle agent's name in the rail (Jonas, 11 Nov 2026, option A): the most useful thing that holds. */

const NOW = new Date("2026-11-11T10:00:00Z");
const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000).toISOString();
const WALL = [
	"# Wall",
	"",
	"## Waits on you",
	"- Pick a shop name",
	"  My pick is Båndklar. [The names](folder:research/names.md)",
	"",
	"## Working on",
	"- Checking five shops' prices",
	"",
	"## Done",
	"- 2026-11-10: Made the new logo",
	"- 2026-11-05: Team hired",
	"",
].join("\n");

afterEach(() => {
	vi.useRealTimers();
	setLanguagePreference("en");
});

describe("the idle line", () => {
	const base = { failed: false, hiredAt: "2026-11-01T09:00:00Z" };
	const note = {
		waits: "Pick a shop name",
		done: { text: "Made the new logo", day: "2026-11-10" },
		next: { title: "Market check", at: at(3) },
	};

	it("says a run did not finish before anything else, in red", () => {
		expect(idleLine({ ...base, failed: true, restingUntil: at(2), note }, NOW)).toEqual({
			text: "Didn't finish",
			tone: "failed",
		});
	});

	it("then that the agent rests at its usage limit, while the pause holds", () => {
		expect(idleLine({ ...base, restingUntil: at(2), note }, NOW).text).toMatch(/^Resting until \d/);
		// A pause that has ended says nothing.
		expect(idleLine({ ...base, restingUntil: at(-1), note }, NOW).text).toBe("Waits on you: Pick a shop name");
	});

	it("then what its wall says waits on the member", () => {
		expect(idleLine({ ...base, note }, NOW)).toEqual({ text: "Waits on you: Pick a shop name" });
	});

	it("then its wall's Now line, before any planned run or what was done", () => {
		const { waits: _, ...rest } = note;
		expect(idleLine({ ...base, note: { ...rest, now: "Prices set, now choosing suppliers" } }, NOW)).toEqual({
			text: "Prices set, now choosing suppliers",
		});
	});

	it("puts a next run within 12 hours before what was done, and a later one after it", () => {
		const { waits: _, ...rest } = note;
		expect(idleLine({ ...base, note: rest }, NOW).text).toMatch(/^Next: Market check · \d/);
		const later = { ...rest, next: { title: "Market check", at: at(30) } };
		expect(idleLine({ ...base, note: later }, NOW).text).toBe("Made the new logo · yesterday");
		const { done: __, ...onlyNext } = later;
		expect(idleLine({ ...base, note: onlyNext }, NOW).text).toMatch(/^Next: Market check · tomorrow \d/);
		// A next run that has passed is not shown before the routines are read again.
		expect(idleLine({ ...base, note: { next: { title: "Market check", at: at(-1) } } }, NOW).text).toBe(
			`Hired ${dayLabel("2026-11-01", NOW)}`,
		);
	});

	it("falls back to when the agent was hired, so every row has a line", () => {
		expect(idleLine(base, NOW).text).toBe(`Hired ${dayLabel("2026-11-01", NOW)}`);
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
		expect(idleLine({ ...base, note }, NOW).text).toBe("Venter på dig: Pick a shop name");
		expect(dayLabel("2026-11-10", NOW)).toBe("i går");
	});
});

describe("agent notes", () => {
	it("reads the Now line, the first waiting item and the newest done item from a wall", () => {
		expect(
			wallNote(`# Wall\n\n## Now\n- Prices set, now choosing suppliers\n${WALL.slice("# Wall\n".length)}`),
		).toEqual({
			now: "Prices set, now choosing suppliers",
			waits: "Pick a shop name",
			done: { text: "Made the new logo", day: "2026-11-10" },
		});
		expect(wallNote(WALL)).toEqual({
			waits: "Pick a shop name",
			done: { text: "Made the new logo", day: "2026-11-10" },
		});
		expect(wallNote("# Wall\n\n## Working on\n- Something\n")).toEqual({});
	});

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

	it("reads every agent once, publishes only changes, and reads again after a settled hint", async () => {
		vi.useFakeTimers({ now: NOW });
		const walls = new Map<string, string | null>([
			["a", WALL],
			["b", null],
		]);
		const readWall = vi.fn(async (id: string) => {
			const text = walls.get(id);
			if (text === undefined) throw new Error("unreachable");
			return text;
		});
		const listRoutines = vi.fn(async () => [
			{ staffAgentId: "b", title: "Market check", nextRunAt: at(3), status: "active" as const },
		]);
		const controller = new AbortController();
		const publish = vi.fn();
		const notes = new AgentNotes(
			{ agents: () => ["a", "b"], readWall, listRoutines, signal: controller.signal },
			publish,
		);
		notes.open();
		await vi.advanceTimersByTimeAsync(0);
		expect(publish).toHaveBeenCalledTimes(1);
		expect(publish).toHaveBeenLastCalledWith({
			a: { waits: "Pick a shop name", done: { text: "Made the new logo", day: "2026-11-10" } },
			b: { next: { title: "Market check", at: at(3) } },
		});
		// A hint is read for once the folder settles and the last read is 15 s old; nothing new publishes nothing.
		notes.changed();
		notes.changed();
		await vi.advanceTimersByTimeAsync(14_000);
		expect(readWall).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(readWall).toHaveBeenCalledTimes(4);
		expect(publish).toHaveBeenCalledTimes(1);
		// A wall that can't be read keeps what it showed; one that is gone drops it.
		walls.delete("a");
		walls.set("b", "# Wall\n\n## Done\n- 2026-11-11: Price list sent\n");
		notes.changed();
		await vi.advanceTimersByTimeAsync(15_000);
		expect(publish).toHaveBeenLastCalledWith({
			a: { waits: "Pick a shop name", done: { text: "Made the new logo", day: "2026-11-10" } },
			b: { done: { text: "Price list sent", day: "2026-11-11" }, next: { title: "Market check", at: at(3) } },
		});
		// The routines are listed again once the next run has run.
		listRoutines.mockClear();
		await vi.advanceTimersByTimeAsync(3 * 3_600_000 + 90_000);
		expect(listRoutines).toHaveBeenCalledTimes(1);
		// Closed, nothing more is read.
		controller.abort();
		readWall.mockClear();
		notes.changed();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(readWall).not.toHaveBeenCalled();
	});

	it("reads a roster that arrives after the company opened at once, and the same roster not again", async () => {
		vi.useFakeTimers({ now: NOW });
		let agents: string[] = [];
		const readWall = vi.fn(async () => WALL);
		const publish = vi.fn();
		const notes = new AgentNotes(
			{ agents: () => agents, readWall, listRoutines: async () => [], signal: new AbortController().signal },
			publish,
		);
		notes.open();
		await vi.advanceTimersByTimeAsync(0);
		expect(readWall).not.toHaveBeenCalled();
		agents = ["a"];
		notes.agentsChanged();
		await vi.advanceTimersByTimeAsync(0);
		expect(publish).toHaveBeenLastCalledWith({
			a: { waits: "Pick a shop name", done: { text: "Made the new logo", day: "2026-11-10" } },
		});
		notes.agentsChanged();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(readWall).toHaveBeenCalledTimes(1);
		// A hint reads whoever the roster holds by then.
		agents = ["a", "b"];
		notes.changed();
		await vi.advanceTimersByTimeAsync(15_000);
		expect(readWall).toHaveBeenCalledTimes(3);
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
			{ agents: () => ["a"], readWall: async () => null, listRoutines, signal: new AbortController().signal },
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
