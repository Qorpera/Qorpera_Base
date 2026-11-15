// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AtComputerWatch, HINT_SETTLE_MS, READ_PAST_END_MS, RETRY_MS } from "../src/app/agents-at-computers.ts";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import { ComputerPanels } from "../src/app/views/computer.ts";
import { ComputerByItself } from "../src/app/views/computer-by-itself.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import { renderRail } from "../src/app/views/shell.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import { parseScreensInUse, type ScreensInUse } from "../src/cloud/screens-in-use.ts";
import type { TranscriptMessage } from "../src/cloud/transcript.ts";
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

	it("cheers when a run ends straight from its computer, and pops as working when it starts there", () => {
		const f = rail();
		const play = vi.fn();
		f.motion.mockReturnValue({ dispose: () => {}, play });
		f.controller.store.set({ activity: [run()], atComputers: { [staff.id]: at() } });
		f.draw();
		f.controller.store.set({ activity: [] });
		f.draw();
		expect(f.controller.agentState(staff.id)).toBe("idle");
		expect(play).toHaveBeenCalledWith("cheer");
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
	it("shows once per stretch, never while open or busy, and a closed one stays closed through its stretch", () => {
		const rules = new ComputerByItself();
		cleanup.push(() => rules.dispose());
		expect(rules.wanted(staff.id, undefined, false, false)).toBe(false);
		expect(rules.wanted(staff.id, "s1", true, false)).toBe(false);
		expect(rules.wanted(staff.id, "s1", false, true)).toBe(false);
		expect(rules.wanted(staff.id, "s1", false, false)).toBe(true);
		rules.opened(staff.id, "s1");
		// Shown once in the stretch: it does not come by itself again in it.
		expect(rules.wanted(staff.id, "s1", false, false)).toBe(false);
		rules.closed(staff.id, "s1");
		expect(rules.wanted(staff.id, "s1", false, false)).toBe(false);
		// The agent stopped and began again.
		expect(rules.wanted(staff.id, "s2", false, false)).toBe(true);
		// A close while the agent was not at its computer declines nothing.
		rules.closed(other.id, undefined);
		expect(rules.wanted(other.id, "t1", false, false)).toBe(true);
	});

	it("shows nothing once the company is left", () => {
		const rules = new ComputerByItself();
		rules.dispose();
		expect(rules.wanted(staff.id, "s2", false, false)).toBe(false);
	});
});

describe("the agent's thread", () => {
	/** The agent's message `n`, written `minutes` after the first. */
	const said = (n: number, minutes: number): TranscriptMessage => ({
		kind: "agent",
		id: id(180 + n),
		sequence: n,
		text: `Message ${n}`,
		attachmentCount: 0,
		phase: "final",
		createdAt: new Date(Date.parse("2026-11-14T08:00:00Z") + minutes * 60_000).toISOString(),
		authorUserId: userA.id,
	});
	const items = (...list: TranscriptMessage[]) =>
		({ loading: false, projection: { items: list, hiddenCount: 0, lastSequence: list.length } }) as const;
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

	/** The log's rows, without its day lines. */
	const rows = (f: ReturnType<typeof thread>) =>
		[...f.view.el.querySelectorAll(".messages-log > :not(time)")].map((row) =>
			row.classList.contains("thread-computer") ? "computer" : (row.textContent ?? "").trim(),
		);

	it("stands as a row beside the working figure at the thread's end while the agent uses it (Jonas, 14 Nov 2026)", async () => {
		const f = thread();
		// The thread's own first read lands first; then the transcript it shows.
		await settle();
		f.controller.conversation(session.sessionId).set(items(said(1, 0)));
		f.controller.store.set({ activity: [run()], atComputers: { [staff.id]: at() } });
		await settle();
		const row = f.panel()?.closest<HTMLElement>(".thread-computer");
		expect(row?.parentElement?.classList.contains("messages-log")).toBe(true);
		expect(rows(f)).toEqual(["Message 1", "computer"]);
		// In the working figure's place, the figure beside the window, and the line under it says what it does.
		expect(f.view.el.querySelector(".thread-activity")).toBeNull();
		expect(row?.querySelector(".thread-computer-figure .figure")).not.toBeNull();
		expect(row?.querySelector(".thread-computer-caption")?.textContent).toBe("Fixture agent is using its computer");
		// A message while it works comes in above it: the row stays the live end.
		f.controller.conversation(session.sessionId).set(items(said(1, 0), said(2, 3)));
		await settle();
		expect(rows(f)).toEqual(["Message 1", "Message 2", "computer"]);
	});

	it("stays where it stood once the agent stops using it, and what comes after goes under it", async () => {
		const f = thread();
		// The thread's own first read lands first; then the transcript it shows.
		await settle();
		f.controller.conversation(session.sessionId).set(items(said(1, 0)));
		f.controller.store.set({ activity: [run()], atComputers: { [staff.id]: at() } });
		await settle();
		const panel = f.panel();
		f.controller.store.set({ activity: [], atComputers: {} });
		f.controller.conversation(session.sessionId).set(items(said(1, 0), said(2, 5)));
		await settle();
		expect(f.panel()).toBe(panel);
		expect(rows(f)).toEqual(["Message 1", "computer", "Message 2"]);
		expect(f.view.el.querySelector<HTMLElement>(".thread-computer-caption")?.hidden).toBe(true);
		// Opened again by the member's click it stays where it is; used again, it is the live end once more.
		expect(f.view.show(staff.id, "computer")).toBe(true);
		await settle();
		expect(rows(f)).toEqual(["Message 1", "computer", "Message 2"]);
		f.controller.store.set({ activity: [run()], atComputers: { [staff.id]: at("s2") } });
		await settle();
		expect(rows(f)).toEqual(["Message 1", "Message 2", "computer"]);
	});

	it("waits at the end while the thread reads, and takes its place from what the read brought (review r1 F1 of #1787)", async () => {
		const f = thread();
		await settle();
		// The member opens the computer of an agent not at it while the thread is still reading.
		f.controller.conversation(session.sessionId).set({
			loading: true,
			projection: { items: [], hiddenCount: 0, lastSequence: 0 },
		});
		expect(f.view.show(staff.id, "computer")).toBe(true);
		expect(f.panel()?.closest(".messages-log")).not.toBeNull();
		await settle();
		// The read fails first (review r2 F1): nothing is fixed by it.
		f.controller.conversation(session.sessionId).set({ loading: false, error: "Could not load" });
		await settle();
		f.controller.conversation(session.sessionId).set({ ...items(said(1, 0), said(2, 2)), error: undefined });
		await settle();
		expect(rows(f)).toEqual(["Message 1", "Message 2", "computer"]);
		f.controller.conversation(session.sessionId).set(items(said(1, 0), said(2, 2), said(3, 4)));
		await settle();
		expect(rows(f)).toEqual(["Message 1", "Message 2", "computer", "Message 3"]);
	});

	it("covers what the thread draws while its large view is open, and what stood there when it comes back entered (review r2 F2)", async () => {
		const panels = new ComputerPanels(undefined, company().controller.signal);
		const f = thread({ computerPanels: panels });
		await settle();
		f.controller.conversation(session.sessionId).set(items(said(1, 0)));
		await settle();
		// A window left entered in another thread comes into this one: what stands in the thread is covered at once.
		panels.open(staff)!.el.classList.add("is-entered");
		expect(f.view.show(staff.id, "computer")).toBe(true);
		const first = f.view.el.querySelector<HTMLElement>(".messages-log > .message")!;
		expect(first.inert).toBe(true);
		// A message drawn while it is open is covered too.
		f.controller.conversation(session.sessionId).set(items(said(1, 0), said(2, 2)));
		await settle();
		const messages = [...f.view.el.querySelectorAll<HTMLElement>(".messages-log > .message")];
		expect(messages.map((message) => message.inert)).toEqual([true, true]);
		expect(f.panel()?.closest<HTMLElement>(".thread-computer")?.inert).not.toBe(true);
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

	it('keeps a window that came by itself after the agent stopped, touched or not (Jonas, 14 Nov 2026: "Yes, keep it")', async () => {
		vi.useFakeTimers();
		const f = thread();
		f.controller.store.set({ activity: [run()], atComputers: { [staff.id]: at("s1") } });
		await settle();
		const panel = f.panel();
		expect(panel).not.toBeNull();
		f.controller.store.set({ activity: [], atComputers: {} });
		await settle();
		vi.advanceTimersByTime(10 * 60_000);
		await settle();
		expect(f.panel()).toBe(panel);
		expect(panel?.closest(".thread-computer")?.parentElement?.classList.contains("messages-log")).toBe(true);
	});

	/* Found on the live app, 15 Nov 2026: the member pressed Computer on the agent's card and the window came in at the
	 * thread's end, under the composer; the thread stayed where it was. The thread goes to the window the member opened. */
	/** The thread's scroller with a height of its own: `full` is all it holds, 300 of it shows. */
	const scrolling = (f: ReturnType<typeof thread>, full: { value: number }) => {
		const scroller = f.view.el.querySelector<HTMLElement>(".messages")!;
		let top = 0;
		Object.defineProperty(scroller, "scrollTop", {
			configurable: true,
			get: () => top,
			set: (value: number) => {
				top = Math.max(0, Math.min(value, full.value - 300));
			},
		});
		Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => full.value });
		Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 300 });
		/** The member scrolls to `to`. */
		const scroll = (to: number) => {
			scroller.scrollTop = to;
			scroller.dispatchEvent(new Event("scroll"));
		};
		return { scroller, scroll };
	};
	/** The page's size observers, told by hand that something grew. */
	const observers = () => {
		const told: (() => void)[] = [];
		vi.stubGlobal(
			"ResizeObserver",
			class {
				constructor(callback: () => void) {
					told.push(callback);
				}
				observe(): void {}
				unobserve(): void {}
				disconnect(): void {}
			},
		);
		return () => {
			for (const callback of told) callback();
		};
	};

	it("goes to the window the member opened: the thread is at its end and follows the window while it grows, from wherever the member had scrolled, and the window takes the keyboard without a scroll of the browser's own", async () => {
		const grew = observers();
		const f = thread();
		await settle();
		f.controller.conversation(session.sessionId).set(items(said(1, 0), said(2, 2)));
		await settle();
		const full = { value: 1000 };
		const { scroller, scroll } = scrolling(f, full);
		// The member reads further up: the thread no longer follows its end.
		scroll(100);
		full.value = 1100;
		grew();
		expect(scroller.scrollTop).toBe(100);
		const focus = vi.spyOn(HTMLElement.prototype, "focus");
		expect(f.view.show(staff.id, "computer", true)).toBe(true);
		// The row is in the thread at once, small; the thread is at its end once the row has its place.
		full.value = 1120;
		await settle();
		expect(scroller.scrollTop).toBe(820);
		// The window grows into its place (the start scene, then the picture): the thread stays at its end.
		full.value = 1500;
		grew();
		expect(scroller.scrollTop).toBe(1200);
		// The keyboard is the window's, and the browser was told not to scroll for it.
		const panel = f.panel();
		expect(document.activeElement).toBe(panel);
		const calls = focus.mock.calls.filter((_call, index) => focus.mock.contexts[index] === panel);
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.every(([options]) => options?.preventScroll === true)).toBe(true);
	});

	it("brings a window that stands further up into view, between the thread's top and the foot laid over its bottom", async () => {
		const f = thread();
		await settle();
		f.controller.conversation(session.sessionId).set(items(said(1, 0)));
		f.controller.store.set({ activity: [run()], atComputers: { [staff.id]: at() } });
		await settle();
		f.controller.store.set({ activity: [], atComputers: {} });
		f.controller.conversation(session.sessionId).set(items(said(1, 0), said(2, 5)));
		await settle();
		expect(rows(f)).toEqual(["Message 1", "computer", "Message 2"]);
		const full = { value: 2000 };
		const { scroller, scroll } = scrolling(f, full);
		const row = f.panel()!.closest<HTMLElement>(".thread-computer")!;
		Object.defineProperty(f.view.el.querySelector<HTMLElement>(".thread-foot")!, "offsetHeight", {
			configurable: true,
			get: () => 60,
		});
		// The row holds 120 of the thread's height, from 500 on; 300 of the thread shows, the foot over its last 60.
		const rect = (top: number, height: number) =>
			({
				top,
				bottom: top + height,
				height,
				left: 0,
				right: 0,
				width: 0,
				x: 0,
				y: top,
				toJSON: () => ({}),
			}) as DOMRect;
		vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
			if (this === scroller) return rect(0, 300);
			if (this === row) return rect(500 - scroller.scrollTop, 120);
			return rect(0, 0);
		});
		// Below what shows: its bottom comes to the foot (300 - 60 - 12).
		scroll(0);
		expect(f.view.show(staff.id, "computer", true)).toBe(true);
		await settle();
		expect(scroller.scrollTop).toBe(392);
		expect(row.getBoundingClientRect().bottom).toBe(228);
		// Above what shows: its top comes to the thread's top (12 under it).
		scroll(900);
		expect(f.view.show(staff.id, "computer", true)).toBe(true);
		await settle();
		expect(scroller.scrollTop).toBe(488);
		// In view already: the thread stays.
		scroll(400);
		expect(f.view.show(staff.id, "computer", true)).toBe(true);
		await settle();
		expect(scroller.scrollTop).toBe(400);
		expect(rows(f)).toEqual(["Message 1", "computer", "Message 2"]);
	});

	it("leaves a thread the member scrolled where it is when the window shows by itself", async () => {
		const grew = observers();
		const f = thread();
		await settle();
		f.controller.conversation(session.sessionId).set(items(said(1, 0), said(2, 2)));
		await settle();
		const full = { value: 1000 };
		const { scroller, scroll } = scrolling(f, full);
		scroll(100);
		f.controller.store.set({ activity: [run()], atComputers: { [staff.id]: at() } });
		full.value = 1500;
		await settle();
		grew();
		expect(f.panel()).not.toBeNull();
		expect(scroller.scrollTop).toBe(100);
		// At its end, the thread follows the window that came by itself, as it follows anything that grows there.
		scroll(1200);
		full.value = 1600;
		grew();
		expect(scroller.scrollTop).toBe(1300);
	});
});
