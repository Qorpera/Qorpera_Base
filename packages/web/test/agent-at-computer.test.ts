// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AtComputerWatch, HINT_SETTLE_MS, READ_PAST_END_MS, RETRY_MS } from "../src/app/agents-at-computers.ts";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import { ComputerPanels } from "../src/app/views/computer.ts";
import { AUTO_CLOSE_MS, ComputerByItself } from "../src/app/views/computer-by-itself.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import { renderRail } from "../src/app/views/shell.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import { parseScreensInUse, type ScreensInUse } from "../src/cloud/screens-in-use.ts";
import type { HostedStaffAgent, HostedStaffExecutionActivity } from "../src/cloud/types.ts";
import { atComputerFrame, atComputerSeed } from "../src/ui/at-computer-motion.ts";
import { setLanguagePreference, untranslated } from "../src/ui/preferences.ts";
import { fixture, id, profileA, session, settle, staff, stubFigureMotion, team, timestamp, userA } from "./fixtures.ts";

/* An agent at its desktop computer (Jonas, 13 Nov 2026; 20260930742000): the database says which agents use their
 * computers now; the rail shows such a working agent "using its computer", and its thread shows the computer's window by
 * itself, once per stretch of use. */

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const dispose of cleanup.splice(0).reverse()) dispose();
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	setLanguagePreference("en");
});

const machine = id(70);
const other: HostedStaffAgent = { ...staff, id: id(41), displayName: "Bob" };
const missing = () =>
	new CloudRpcError("qorpera_list_company_screens_in_use", { message: "missing", code: "PGRST202" }, 404);
/** The database's answer at `now`: each agent at `machine`, used `ago` ms before, its window 90 s. */
const answer = (now: number, screens: { agent: string; since?: string; ago?: number }[]): ScreensInUse => ({
	now: new Date(now).toISOString(),
	screens: screens.map((screen) => ({
		staffAgentId: screen.agent,
		machineId: machine,
		since: screen.since ?? "2026-11-13T03:00:00Z",
		usedAt: new Date(now - (screen.ago ?? 0)).toISOString(),
		until: new Date(now - (screen.ago ?? 0) + 90_000).toISOString(),
	})),
});
const run = (agent = staff.id, extra: Partial<HostedStaffExecutionActivity> = {}): HostedStaffExecutionActivity => ({
	runId: id(90),
	staffAgentId: agent,
	sourceKind: "session_turn",
	jobStatus: "leased",
	activity: "working",
	updatedAt: timestamp,
	...extra,
});

describe("the list of agents at their computers", () => {
	it("reads the database's answer, and refuses one for another company or of another shape", () => {
		const value = {
			schema: "qorpera.company-screens-in-use/v1",
			profileId: profileA.profileId.toUpperCase(),
			now: "2026-11-13T03:00:00Z",
			screens: [
				{
					staffAgentId: staff.id,
					machineId: machine,
					since: "2026-11-13T02:59:00Z",
					usedAt: "2026-11-13T02:59:50Z",
					until: "2026-11-13T03:01:20Z",
				},
			],
		};
		expect(parseScreensInUse(value, profileA.profileId).screens[0]).toEqual(value.screens[0]);
		expect(() => parseScreensInUse({ ...value, profileId: id(99) }, profileA.profileId)).toThrow();
		expect(() => parseScreensInUse({ ...value, schema: "other" }, profileA.profileId)).toThrow();
		expect(() =>
			parseScreensInUse({ ...value, screens: [{ ...value.screens[0], until: "soon" }] }, profileA.profileId),
		).toThrow();
	});
});

describe("the page's watch", () => {
	function watch(read: () => Promise<ScreensInUse>, resting = () => false) {
		const changes: Record<string, unknown>[] = [];
		const unavailable = vi.fn();
		const w = new AtComputerWatch({
			read,
			onChange: (agents) => changes.push({ ...agents }),
			onUnavailable: unavailable,
			resting,
		});
		cleanup.push(() => w.dispose());
		return { w, changes, unavailable };
	}

	it("places each end on the page's clock, reads again just after it, and drops what the database no longer lists", async () => {
		vi.useFakeTimers({ now: 1_000_000 });
		// The database's clock runs 5 s ahead of the page's.
		const read = vi.fn(async () => answer(Date.now() + 5_000, [{ agent: staff.id, ago: 30_000 }]));
		const f = watch(read);
		f.w.read();
		await vi.advanceTimersByTimeAsync(0);
		expect(read).toHaveBeenCalledTimes(1);
		// Used 30 s ago on the database's clock: 60 s left on the page's.
		expect(f.w.agents[staff.id]).toEqual({ machineId: machine, since: "2026-11-13T03:00:00Z", until: 1_060_000 });
		// Nothing more is read until just past the end.
		await vi.advanceTimersByTimeAsync(60_000 + READ_PAST_END_MS - 1);
		expect(read).toHaveBeenCalledTimes(1);
		read.mockImplementation(async () => answer(Date.now() + 5_000, []));
		await vi.advanceTimersByTimeAsync(1);
		expect(read).toHaveBeenCalledTimes(2);
		expect(f.w.agents).toEqual({});
		// With nobody at a computer nothing is read on any clock.
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(read).toHaveBeenCalledTimes(2);
		expect(f.changes).toHaveLength(2);
	});

	it("keeps an agent that called again, and makes one read of a burst of hints", async () => {
		vi.useFakeTimers({ now: 1_000_000 });
		const read = vi.fn(async () => answer(Date.now(), [{ agent: staff.id }]));
		const f = watch(read);
		f.w.hinted();
		f.w.hinted();
		f.w.hinted();
		await vi.advanceTimersByTimeAsync(HINT_SETTLE_MS);
		expect(read).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(90_000 + READ_PAST_END_MS);
		expect(read).toHaveBeenCalledTimes(2);
		expect(f.w.agents[staff.id]?.until).toBe(Date.now() + 90_000);
	});

	it("reads once more after a read that was on its way", async () => {
		let answerNow: (value: ScreensInUse) => void = () => {};
		const read = vi.fn(
			() =>
				new Promise<ScreensInUse>((resolve) => {
					answerNow = resolve;
				}),
		);
		const f = watch(read);
		f.w.read();
		f.w.read();
		expect(read).toHaveBeenCalledTimes(1);
		answerNow(answer(Date.now(), []));
		await settle();
		expect(read).toHaveBeenCalledTimes(2);
	});

	it("waits for the page's return while it rests hidden", async () => {
		let resting = true;
		const read = vi.fn(async () => answer(Date.now(), []));
		const f = watch(read, () => resting);
		f.w.read();
		expect(read).not.toHaveBeenCalled();
		resting = false;
		f.w.returned();
		await settle();
		expect(read).toHaveBeenCalledTimes(1);
		f.w.returned();
		expect(read).toHaveBeenCalledTimes(1);
	});

	it("keeps reading after a failed read at an entry's end, until a read answers (review r1 F2)", async () => {
		vi.useFakeTimers({ now: 1_000_000 });
		const read = vi.fn(async () => answer(Date.now(), [{ agent: staff.id }]));
		const f = watch(read);
		f.w.read();
		await vi.advanceTimersByTimeAsync(0);
		expect(f.w.agents[staff.id]).toBeDefined();
		// The read at the end fails: the entry goes, and the watch tries again.
		read.mockImplementation(async () => {
			throw new Error("network");
		});
		await vi.advanceTimersByTimeAsync(90_000 + READ_PAST_END_MS);
		expect(read).toHaveBeenCalledTimes(2);
		expect(f.w.agents).toEqual({});
		await vi.advanceTimersByTimeAsync(RETRY_MS);
		expect(read).toHaveBeenCalledTimes(3);
		// Back: the agent still uses its computer, and shows again.
		read.mockImplementation(async () => answer(Date.now(), [{ agent: staff.id }]));
		await vi.advanceTimersByTimeAsync(2 * RETRY_MS);
		expect(read).toHaveBeenCalledTimes(4);
		expect(f.w.agents[staff.id]).toBeDefined();
		// An answered read with nobody at a computer ends the reading.
		read.mockImplementation(async () => answer(Date.now(), []));
		await vi.advanceTimersByTimeAsync(90_000 + READ_PAST_END_MS);
		expect(read).toHaveBeenCalledTimes(5);
		await vi.advanceTimersByTimeAsync(30 * 60_000);
		expect(read).toHaveBeenCalledTimes(5);
	});

	it("gives up for good on a cloud without the list", async () => {
		vi.useFakeTimers();
		const read = vi.fn(async () => {
			throw missing();
		});
		const f = watch(read);
		f.w.read();
		await vi.advanceTimersByTimeAsync(0);
		expect(f.unavailable).toHaveBeenCalledTimes(1);
		f.w.hinted();
		f.w.read();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(read).toHaveBeenCalledTimes(1);
	});
});

function company(agents: HostedStaffAgent[] = [staff]) {
	stubFigureMotion();
	const f = fixture();
	const controller = new CompanyController(f.api, profileA, userA.id);
	controller.store.set({ team, staff: agents, sessions: [{ ...session, staffAgentId: staff.id }], loading: false });
	cleanup.push(() => controller.stop());
	return { ...f, controller };
}
const at = (since = "2026-11-13T03:00:00Z", left = 60_000) => ({ machineId: machine, since, until: Date.now() + left });

describe("the agent's state", () => {
	it("is at its computer only while its run works and the database says it uses its computer", () => {
		const f = company();
		f.controller.store.set({ activity: [run()], atComputers: { [staff.id]: at() } });
		expect(f.controller.agentState(staff.id)).toBe("computer");
		// Writing its answer is writing.
		f.controller.store.set({ activity: [run(staff.id, { phase: "writing" })] });
		expect(f.controller.agentState(staff.id)).toBe("writing");
		// A run that ended a moment ago, its stamp still young: not at its computer.
		f.controller.store.set({ activity: [] });
		expect(f.controller.agentState(staff.id)).toBe("idle");
		// Past the entry's end: working.
		f.controller.store.set({ activity: [run()], atComputers: { [staff.id]: at(undefined, -1) } });
		expect(f.controller.agentState(staff.id)).toBe("working");
	});

	it("reads the list when the company opens and on a machines hint; a cloud without it has the feature off", async () => {
		const f = company();
		const list = vi.mocked(f.api.listScreensInUse);
		// The fixture's cloud is before 20260930742000.
		await f.controller.start();
		await settle();
		expect(list).toHaveBeenCalledWith(profileA.profileId);
		expect(f.controller.store.get().atComputersUnavailable).toBe(true);
		f.controller.store.set({ activity: [run()] });
		expect(f.controller.agentState(staff.id)).toBe("working");
	});

	it("is read at a machines hint, and the rail shows it", async () => {
		const f = company();
		const list = vi.mocked(f.api.listScreensInUse).mockResolvedValue(answer(Date.now(), []));
		await f.controller.start();
		await settle();
		expect(list).toHaveBeenCalledTimes(1);
		list.mockResolvedValue(answer(Date.now(), [{ agent: staff.id }]));
		// The hint the database sends at a new stretch.
		f.hints.get("qorpera_company_machines")?.();
		await new Promise((resolve) => setTimeout(resolve, HINT_SETTLE_MS + 20));
		await settle();
		expect(list).toHaveBeenCalledTimes(2);
		f.controller.store.set({ activity: [run()] });
		expect(f.controller.agentState(staff.id)).toBe("computer");
	});
});

describe("the rail", () => {
	function rail() {
		const f = company();
		const motion = stubFigureMotion();
		const auth = new AuthController(f.cloud);
		cleanup.push(() => auth.dispose());
		const el = document.createElement("aside");
		document.body.append(el);
		const draw = () =>
			renderRail(el, f.controller, {
				profiles: [profileA],
				user: userA,
				auth,
				invitations: 0,
				route: { name: "company", profileId: profileA.profileId, section: "home" },
				openSettings() {},
				openFeedback() {},
				openFriends() {},
			});
		const row = () => el.querySelector<HTMLElement>(`.rail-row[data-agent-id="${staff.id}"]`)!;
		return { ...f, draw, row, motion };
	}

	it("says it under the name, in the name, and plays the figure's own state", () => {
		const f = rail();
		f.controller.store.set({ activity: [run()], atComputers: { [staff.id]: at() } });
		f.draw();
		expect(f.row().querySelector(".rail-row-copy small")?.textContent).toBe("Using its computer");
		expect(f.row().getAttribute("aria-label")).toBe(`${staff.displayName} · Using its computer`);
		expect(f.motion.mock.calls.some((call) => call[4]?.activity === "AtComputer")).toBe(true);
		// The working disc stays: it works.
		expect(f.row().querySelector(".rail-row-status")).not.toBeNull();
	});

	it("says it in Danish", () => {
		setLanguagePreference("da");
		const f = rail();
		f.controller.store.set({ activity: [run()], atComputers: { [staff.id]: at() } });
		f.draw();
		expect(f.row().querySelector(".rail-row-copy small")?.textContent).toBe("Bruger sin computer");
		expect(untranslated()).toEqual([]);
	});
});

describe("the figure's motion", () => {
	it("moves only in steps: a hold draws nothing new, and two agents do not move in step", () => {
		const seed = atComputerSeed(staff.id);
		const keys = Array.from({ length: 40 * 60 }, (_, frame) => atComputerFrame(frame / 60, seed, false).key);
		const changes = keys.filter((key, index) => index > 0 && key !== keys[index - 1]).length;
		// At most a third of the frames of a 60 Hz screen draw anything.
		expect(changes / keys.length).toBeLessThan(1 / 3);
		const others = Array.from(
			{ length: 600 },
			(_, frame) => atComputerFrame(frame / 60, atComputerSeed(other.id), false).key,
		);
		expect(others).not.toEqual(keys.slice(0, 600));
		// Reduced motion: one still frame.
		expect(new Set([0, 3, 17].map((s) => atComputerFrame(s, seed, true).key)).size).toBe(1);
	});
});

describe("the window's rules", () => {
	/** A company's windows as the rule sees them: the agent's current window, and whether it is the member's. */
	function windows() {
		const shown = new Map<string, { el: HTMLElement; theirs: boolean }>();
		const close = vi.fn((agentId: string) => {
			shown.delete(agentId);
			rules.released(agentId);
		});
		const rules = new ComputerByItself({ current: (agentId) => shown.get(agentId), close });
		cleanup.push(() => rules.dispose());
		/** The member's own click opens the agent's window (a new one). */
		const open = (agentId: string) => {
			const el = document.createElement("div");
			shown.set(agentId, { el, theirs: false });
			return el;
		};
		/** The rule opens it. */
		const auto = (agentId: string, since: string) => {
			const el = open(agentId);
			rules.opened(agentId, since, el);
			return el;
		};
		/** The member closes it by hand. */
		const shut = (agentId: string, since: string | undefined) => {
			shown.delete(agentId);
			rules.closed(agentId, since);
		};
		return { rules, close, shown, open, auto, shut };
	}

	it("shows once per stretch, never while open or busy, and a closed one stays closed through its stretch", () => {
		const w = windows();
		expect(w.rules.wanted(staff.id, undefined, false, false)).toBe(false);
		expect(w.rules.wanted(staff.id, "s1", true, false)).toBe(false);
		expect(w.rules.wanted(staff.id, "s1", false, true)).toBe(false);
		expect(w.rules.wanted(staff.id, "s1", false, false)).toBe(true);
		w.auto(staff.id, "s1");
		w.shut(staff.id, "s1");
		expect(w.rules.wanted(staff.id, "s1", false, false)).toBe(false);
		// A pause (writing, between runs) in the same stretch: still closed.
		w.rules.seen(staff.id, undefined);
		expect(w.rules.wanted(staff.id, "s1", false, false)).toBe(false);
		// The agent stopped and began again.
		expect(w.rules.wanted(staff.id, "s2", false, false)).toBe(true);
	});

	it("takes a window that came by itself away a minute after the agent stopped, unless touched or begun again", () => {
		vi.useFakeTimers();
		const w = windows();
		w.auto(staff.id, "s1");
		w.rules.seen(staff.id, undefined);
		vi.advanceTimersByTime(AUTO_CLOSE_MS - 1);
		// Began again before the minute: it stays.
		w.rules.seen(staff.id, "s1");
		vi.advanceTimersByTime(AUTO_CLOSE_MS);
		expect(w.close).not.toHaveBeenCalled();
		w.rules.seen(staff.id, undefined);
		vi.advanceTimersByTime(AUTO_CLOSE_MS);
		expect(w.close).toHaveBeenCalledWith(staff.id);
		// It does not come back in that stretch.
		expect(w.rules.wanted(staff.id, "s1", false, false)).toBe(false);
		// Touched: it is the member's.
		const touched = w.auto(other.id, "t1");
		touched.dispatchEvent(new Event("pointerdown"));
		w.rules.seen(other.id, undefined);
		vi.advanceTimersByTime(10 * AUTO_CLOSE_MS);
		expect(w.close).toHaveBeenCalledTimes(1);
		expect(w.rules.owns(other.id)).toBe(false);
	});

	it("never closes a window the member opened after it closed one by itself, used or not (review r1 F1)", () => {
		vi.useFakeTimers();
		const w = windows();
		w.auto(staff.id, "s1");
		w.rules.seen(staff.id, undefined);
		vi.advanceTimersByTime(AUTO_CLOSE_MS);
		expect(w.close).toHaveBeenCalledTimes(1);
		// The member opens it by hand, and uses it; the agent is still not at its computer.
		const theirs = w.open(staff.id);
		theirs.dispatchEvent(new Event("pointerdown"));
		for (let i = 0; i < 5; i++) {
			w.rules.seen(staff.id, undefined);
			vi.advanceTimersByTime(AUTO_CLOSE_MS);
		}
		expect(w.close).toHaveBeenCalledTimes(1);
		expect(w.shown.get(staff.id)?.el).toBe(theirs);
		// Opened by hand while the rule's timer ran (the rule's window closed some other way): the timer closes nothing.
		w.auto(other.id, "t1");
		w.rules.seen(other.id, undefined);
		w.shown.delete(other.id);
		w.open(other.id);
		vi.advanceTimersByTime(AUTO_CLOSE_MS);
		expect(w.close).toHaveBeenCalledTimes(1);
	});

	it("never closes a window through which the member holds a desktop or has its large view open", () => {
		vi.useFakeTimers();
		const w = windows();
		w.auto(staff.id, "s1");
		w.rules.seen(staff.id, undefined);
		// A take-over from the agent's card: no touch on the window, but the member holds its desktop.
		w.shown.get(staff.id)!.theirs = true;
		vi.advanceTimersByTime(AUTO_CLOSE_MS);
		expect(w.close).not.toHaveBeenCalled();
		// Given back: the rule let go of it for good.
		w.shown.get(staff.id)!.theirs = false;
		w.rules.seen(staff.id, undefined);
		vi.advanceTimersByTime(AUTO_CLOSE_MS);
		expect(w.close).not.toHaveBeenCalled();
		expect(w.rules.owns(staff.id)).toBe(false);
	});

	it("follows the company's word for every window it owns, whatever thread shows (review r1 F3)", () => {
		vi.useFakeTimers();
		const w = windows();
		w.auto(staff.id, "s1");
		w.auto(other.id, "t1");
		const using = new Map<string, string | undefined>([
			[staff.id, "s1"],
			[other.id, "t1"],
		]);
		const feed = () => w.rules.refresh((agentId) => using.get(agentId));
		// Both stop while no thread of theirs is shown; one begins again within the minute.
		using.set(staff.id, undefined);
		using.set(other.id, undefined);
		feed();
		vi.advanceTimersByTime(AUTO_CLOSE_MS / 2);
		using.set(other.id, "t1");
		feed();
		vi.advanceTimersByTime(AUTO_CLOSE_MS);
		expect(w.close.mock.calls).toEqual([[staff.id]]);
		expect(w.rules.owns(other.id)).toBe(true);
	});

	it("owns nothing once the company is left", () => {
		vi.useFakeTimers();
		const w = windows();
		w.auto(staff.id, "s1");
		w.rules.seen(staff.id, undefined);
		w.rules.dispose();
		vi.advanceTimersByTime(AUTO_CLOSE_MS);
		expect(w.close).not.toHaveBeenCalled();
		expect(w.rules.wanted(staff.id, "s2", false, false)).toBe(false);
	});
});

describe("the agent's thread", () => {
	function thread(actions: { computerPanels?: ComputerPanels } = {}) {
		const f = company([staff, other]);
		const panels = actions.computerPanels ?? new ComputerPanels(undefined, f.controller.signal);
		const view = new ConversationView(f.controller, session.sessionId, { computerPanels: panels });
		document.body.append(view.el);
		cleanup.push(() => view.dispose());
		const panel = () => view.el.querySelector<HTMLElement>(".computer-panel");
		const composer = view.el.querySelector<HTMLTextAreaElement>(".composer-input")!;
		return { ...f, view, panel, composer, panels };
	}

	it("shows the computer by itself, small and without taking the keyboard", async () => {
		const f = thread();
		f.composer.focus();
		expect(f.panel()).toBeNull();
		f.controller.store.set({ activity: [run()], atComputers: { [staff.id]: at() } });
		await settle();
		expect(f.panel()).not.toBeNull();
		expect(f.panel()?.classList.contains("is-entered")).toBe(false);
		expect(document.activeElement).toBe(f.composer);
	});

	it("does not show it for another agent, for an agent that does not work, or while the member is busy", async () => {
		const f = thread();
		f.controller.store.set({ activity: [run(other.id)], atComputers: { [other.id]: at() } });
		await settle();
		expect(f.panel()).toBeNull();
		f.controller.store.set({ activity: [], atComputers: { [staff.id]: at() } });
		await settle();
		expect(f.panel()).toBeNull();
		vi.spyOn(f.panels, "busy").mockReturnValue(true);
		f.controller.store.set({ activity: [run()] });
		await settle();
		expect(f.panel()).toBeNull();
	});

	it("stays closed once the member closed it, until the agent begins again", async () => {
		const f = thread();
		f.controller.store.set({ activity: [run()], atComputers: { [staff.id]: at("s1") } });
		await settle();
		const shown = f.panel()!;
		shown.focus();
		shown.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await settle();
		expect(f.panel()).toBeNull();
		f.controller.store.set({ atComputers: { [staff.id]: at("s1", 50_000) } });
		await settle();
		expect(f.panel()).toBeNull();
		f.controller.store.set({ activity: [], atComputers: {} });
		await settle();
		f.controller.store.set({ activity: [run()], atComputers: { [staff.id]: at("s2") } });
		await settle();
		expect(f.panel()).not.toBeNull();
	});

	it("takes an untouched window away a minute after the agent stopped, and leaves a touched one", async () => {
		vi.useFakeTimers();
		const f = thread();
		f.controller.store.set({ activity: [run()], atComputers: { [staff.id]: at("s1") } });
		await settle();
		expect(f.panel()).not.toBeNull();
		f.controller.store.set({ activity: [] });
		await settle();
		vi.advanceTimersByTime(AUTO_CLOSE_MS);
		// The window leaves with its closing motion.
		vi.advanceTimersByTime(1_000);
		await settle();
		expect(f.panel()).toBeNull();
		// The next stretch: touched, it stays.
		f.controller.store.set({ activity: [run()], atComputers: { [staff.id]: at("s2") } });
		await settle();
		f.panel()!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		f.controller.store.set({ activity: [] });
		await settle();
		vi.advanceTimersByTime(5 * AUTO_CLOSE_MS);
		expect(f.panel()).not.toBeNull();
	});

	it("leaves a window the member reopened by hand after one went by itself (review r1 F1)", async () => {
		vi.useFakeTimers();
		const f = thread();
		f.controller.store.set({ activity: [run()], atComputers: { [staff.id]: at("s1") } });
		await settle();
		f.controller.store.set({ activity: [] });
		await settle();
		vi.advanceTimersByTime(AUTO_CLOSE_MS + 1_000);
		await settle();
		expect(f.panel()).toBeNull();
		// The member opens it from the agent's card, and uses it.
		expect(f.view.show(staff.id, "computer")).toBe(true);
		f.panel()!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		for (let i = 0; i < 3; i++) {
			f.controller.store.set({ activity: [], atComputers: {} });
			await settle();
			vi.advanceTimersByTime(AUTO_CLOSE_MS + 1_000);
			await settle();
		}
		expect(f.panel()).not.toBeNull();
	});
});
