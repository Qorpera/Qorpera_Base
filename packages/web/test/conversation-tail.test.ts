// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import { PairTranscriptView } from "../src/app/views/pair-transcript.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import type { CodingSession } from "../src/cloud/coding-session.ts";
import { projectTranscript, type TranscriptItem } from "../src/cloud/transcript.ts";
import type { HostedSessionEvent } from "../src/cloud/types.ts";
import { deferred, event, fixture, id, pending, profileA, session, settle, staff, team, userA } from "./fixtures.ts";

/* A thread opens at its newest events (migration 20260928279410) and reads older ones a page
 * at a time on "Show earlier"; a cloud without that read gets the whole history, as before. */

const cleanup: (() => void)[] = [];
beforeEach(() => {
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
	for (const dispose of cleanup.splice(0)) dispose();
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const at = (n: number) => new Date(Date.parse("2026-09-05T10:00:00Z") + n * 60_000).toISOString();
/** A member's message at minute `n`, with sequence `n`. */
const message = (n: number): HostedSessionEvent => ({ ...event(n, `Message ${n}`), createdAt: at(n) });
/** An event the thread does not show (a run receipt). */
const receipt = (n: number): HostedSessionEvent => ({
	...message(n),
	eventType: "run_receipt",
	body: { schema: "qorpera.run-receipt/v1" },
});
/** A transcript of `count` messages, and a tail read over it as the cloud answers it. */
function transcript(count: number, make: (n: number) => HostedSessionEvent = message) {
	const events = Array.from({ length: count }, (_, index) => make(index + 1));
	const tail = async (_session: string, before: number | undefined, limit: number) =>
		events.filter((item) => before === undefined || item.sequence < before).slice(-limit);
	return { events, tail };
}

function company() {
	const f = fixture();
	const controller = new CompanyController(f.api, profileA, userA.id);
	controller.store.set({ team, staff: [staff], sessions: [{ ...session, staffAgentId: staff.id }], loading: false });
	cleanup.push(() => controller.stop());
	return { ...f, controller };
}

describe("a thread opens at its newest events", () => {
	it("reads the newest page, not the whole history, and knows more lies before it", async () => {
		const { api, controller } = company();
		const history = transcript(1000);
		vi.mocked(api.readSessionEventsTail).mockImplementation(history.tail);
		const store = controller.conversation(session.sessionId, false);
		await controller.loadConversation(session.sessionId);
		expect(api.readSessionEventsTail).toHaveBeenCalledOnce();
		expect(api.readSessionEventsTail).toHaveBeenCalledWith(session.sessionId, undefined, 200);
		expect(api.readSessionEvents).not.toHaveBeenCalled();
		expect(store.get().events.map((item) => item.sequence)).toEqual(
			Array.from({ length: 200 }, (_, index) => 801 + index),
		);
		expect(store.get()).toMatchObject({ hasEarlier: true, complete: true, loading: false });
		expect(store.get().projection.items).toHaveLength(200);
		expect(store.get().projection.lastSequence).toBe(1000);
		// Later reads bring what is new, forward from the newest event read.
		vi.mocked(api.readSessionEvents).mockResolvedValue([message(1001)]);
		await controller.loadConversation(session.sessionId);
		expect(api.readSessionEvents).toHaveBeenCalledWith(session.sessionId, 1000, 500);
		expect(store.get().events).toHaveLength(201);
		expect(store.get().hasEarlier).toBe(true);
	});

	it("reads further back while the page shows too little (hidden events take no place)", async () => {
		const { api, controller } = company();
		// 700 receipts, then 300 messages: the newest page shows 200, the next one 100 more.
		const history = transcript(1000, (n) => (n <= 700 ? receipt(n) : message(n)));
		vi.mocked(api.readSessionEventsTail).mockImplementation(history.tail);
		const store = controller.conversation(session.sessionId, false);
		await controller.loadConversation(session.sessionId);
		expect(vi.mocked(api.readSessionEventsTail).mock.calls.map((call) => call[1])).toEqual([undefined]);
		expect(store.get().projection.items).toHaveLength(200);
		// A receipt-only stretch: at most five pages on open.
		const quiet = transcript(3000, (n) => (n <= 2900 ? receipt(n) : message(n)));
		const other = company();
		vi.mocked(other.api.readSessionEventsTail).mockImplementation(quiet.tail);
		const otherStore = other.controller.conversation(session.sessionId, false);
		await other.controller.loadConversation(session.sessionId);
		expect(vi.mocked(other.api.readSessionEventsTail).mock.calls.map((call) => call[1])).toEqual([
			undefined,
			2801,
			2601,
			2401,
			2201,
		]);
		expect(otherStore.get()).toMatchObject({ hasEarlier: true });
		expect(otherStore.get().events).toHaveLength(1000);
	});

	it("has no Show earlier for a thread whose start it read", async () => {
		const { api, controller } = company();
		const history = transcript(120);
		vi.mocked(api.readSessionEventsTail).mockImplementation(history.tail);
		const store = controller.conversation(session.sessionId, false);
		await controller.loadConversation(session.sessionId);
		expect(store.get().hasEarlier).toBe(false);
		expect(store.get().events).toHaveLength(120);
	});

	it("reads back to the place of a waiting input sent before the oldest event read", async () => {
		const { api, controller } = company();
		// Minute 10's message is an input the cloud took long ago; it is still listed while it runs.
		const history = transcript(1000);
		vi.mocked(api.readSessionEventsTail).mockImplementation(history.tail);
		const taken = { ...pending(10, "Message 10"), inputId: history.events[9]!.sessionInputId!, createdAt: at(10) };
		taken.status = "processing";
		vi.mocked(api.listSessionInputs).mockResolvedValue({ items: [taken], hasMore: false, nextAfterPosition: 10 });
		const store = controller.conversation(session.sessionId, false);
		await controller.loadConversation(session.sessionId);
		expect(store.get().events[0]!.sequence).toBeLessThanOrEqual(10);
		// Shown once, where the transcript has it, and not again as waiting.
		const shown = store.get().projection.items.filter((item) => item.kind === "member" && item.text === "Message 10");
		expect(shown).toHaveLength(1);
		expect(shown[0]).not.toHaveProperty("pending");
	});

	it("does not read back for a taken message whose event it has, and reads back for one only once", async () => {
		const { api, controller } = company();
		// Sent at minute 10 while the agent was busy, taken at sequence 2,990: its event carries its
		// send time but stands in the newest page.
		const history = transcript(3000);
		const inputId = id(3010);
		history.events[2989] = { ...history.events[2989]!, sessionInputId: inputId, createdAt: at(10) };
		vi.mocked(api.readSessionEventsTail).mockImplementation(history.tail);
		const taken = { ...pending(10, "Message 2990"), inputId, createdAt: at(10), status: "processing" as const };
		vi.mocked(api.listSessionInputs).mockResolvedValue({ items: [taken], hasMore: false, nextAfterPosition: 10 });
		const store = controller.conversation(session.sessionId, false);
		await controller.loadConversation(session.sessionId);
		expect(api.readSessionEventsTail).toHaveBeenCalledOnce();
		expect(store.get().events).toHaveLength(200);
		// A taken input with no event yet (a run queued for hours): read back once (five pages at
		// most), never again, however often the thread is read.
		const waiting = { ...pending(11, "Still queued"), createdAt: at(11), status: "processing" as const };
		vi.mocked(api.listSessionInputs).mockResolvedValue({ items: [waiting], hasMore: false, nextAfterPosition: 11 });
		await controller.loadConversation(session.sessionId);
		expect(api.readSessionEventsTail).toHaveBeenCalledTimes(6);
		await controller.loadConversation(session.sessionId);
		await controller.loadConversation(session.sessionId);
		expect(api.readSessionEventsTail).toHaveBeenCalledTimes(6);
		expect(store.get().events).toHaveLength(1200);
		expect(store.get().hasEarlier).toBe(true);
	});

	it("falls back to reading forward on a cloud without the newest-first read, once", async () => {
		const { api, controller } = company();
		vi.mocked(api.readSessionEvents).mockImplementation(async (_session, after) =>
			after === 0 ? Array.from({ length: 3 }, (_, index) => message(index + 1)) : [],
		);
		const store = controller.conversation(session.sessionId, false);
		await controller.loadConversation(session.sessionId);
		expect(api.readSessionEventsTail).toHaveBeenCalledOnce();
		expect(api.readSessionEvents).toHaveBeenCalledWith(session.sessionId, 0, 500);
		expect(store.get()).toMatchObject({ complete: true, error: undefined, hasEarlier: false });
		expect(store.get().events).toHaveLength(3);
		// Another thread of the company does not ask again.
		const other = controller.conversation(id(77), false);
		await controller.loadConversation(id(77));
		expect(api.readSessionEventsTail).toHaveBeenCalledOnce();
		expect(other.get().complete).toBe(true);
	});

	it("also when the database says the function does not exist", async () => {
		const { api, controller } = company();
		vi.mocked(api.readSessionEventsTail).mockRejectedValue(
			new CloudRpcError(
				"qorpera_read_session_events_tail",
				{ message: "function does not exist", code: "42883" },
				404,
			),
		);
		vi.mocked(api.readSessionEvents).mockResolvedValue([message(1)]);
		const store = controller.conversation(session.sessionId, false);
		await controller.loadConversation(session.sessionId);
		expect(store.get()).toMatchObject({ complete: true, error: undefined });
		expect(store.get().events).toHaveLength(1);
	});

	it("shows any other failure of the newest-first read as the thread's error", async () => {
		const { api, controller } = company();
		vi.mocked(api.readSessionEventsTail).mockRejectedValue(
			new CloudRpcError(
				"qorpera_read_session_events_tail",
				{ message: "session read access is required", code: "42501" },
				403,
			),
		);
		const store = controller.conversation(session.sessionId, false);
		await controller.loadConversation(session.sessionId);
		expect(api.readSessionEvents).not.toHaveBeenCalled();
		expect(store.get()).toMatchObject({ complete: false, error: "session read access is required" });
	});
});

describe("Show earlier", () => {
	it("reads the page before the oldest event and keeps what a forward read brings meanwhile", async () => {
		const { api, controller } = company();
		const history = transcript(1000);
		vi.mocked(api.readSessionEventsTail).mockImplementation(history.tail);
		const store = controller.conversation(session.sessionId, false);
		await controller.loadConversation(session.sessionId);
		const earlier = deferred<HostedSessionEvent[]>();
		vi.mocked(api.readSessionEventsTail).mockReturnValueOnce(earlier.promise);
		const showing = controller.loadEarlier(session.sessionId);
		expect(store.get().earlierLoading).toBe(true);
		expect(api.readSessionEventsTail).toHaveBeenLastCalledWith(session.sessionId, 801, 200);
		// A new message arrives while the older page is on its way.
		vi.mocked(api.readSessionEvents).mockResolvedValue([message(1001)]);
		await controller.loadConversation(session.sessionId);
		earlier.resolve(history.events.slice(600, 800));
		await showing;
		expect(store.get().events.map((item) => item.sequence)).toEqual(
			Array.from({ length: 401 }, (_, index) => 601 + index),
		);
		expect(store.get()).toMatchObject({ hasEarlier: true, earlierLoading: false });
		// Back to the start: nothing more before it.
		for (let round = 0; round < 3; round++) await controller.loadEarlier(session.sessionId);
		expect(store.get().events).toHaveLength(1001);
		expect(store.get().hasEarlier).toBe(false);
	});

	it("says why it could not read, and tries again", async () => {
		const { api, controller } = company();
		const history = transcript(1000);
		vi.mocked(api.readSessionEventsTail).mockImplementation(history.tail);
		const store = controller.conversation(session.sessionId, false);
		await controller.loadConversation(session.sessionId);
		vi.mocked(api.readSessionEventsTail).mockRejectedValueOnce(new Error("Network down"));
		await controller.loadEarlier(session.sessionId);
		expect(store.get()).toMatchObject({ earlierLoading: false, earlierError: "Network down", hasEarlier: true });
		await controller.loadEarlier(session.sessionId);
		expect(store.get().earlierError).toBeUndefined();
		expect(store.get().events).toHaveLength(400);
	});
});

describe("the thread view with unread history", () => {
	function view(items: TranscriptItem[], patch: Record<string, unknown> = {}) {
		const f = fixture();
		const controller = new CompanyController(f.api, profileA, userA.id);
		controller.store.set({
			team,
			staff: [staff],
			sessions: [{ ...session, staffAgentId: staff.id }],
			loading: false,
		});
		const store = controller.conversation(session.sessionId, false);
		store.set({
			loading: false,
			complete: true,
			hasEarlier: true,
			projection: { items, hiddenCount: 0, lastSequence: items.length },
			...patch,
		});
		const thread = new ConversationView(controller, session.sessionId);
		document.body.append(thread.el);
		cleanup.push(() => {
			thread.dispose();
			controller.stop();
		});
		const log = thread.el.querySelector<HTMLElement>('[role="log"]')!;
		const scroller = thread.el.querySelector<HTMLElement>(".messages")!;
		return { controller, store, log, scroller, thread };
	}
	const item = (n: number): TranscriptItem => ({
		kind: "member",
		id: id(500 + n),
		sequence: n,
		authorUserId: userA.id,
		text: `Message ${n}`,
		attachmentCount: 0,
		createdAt: at(n),
	});

	it("offers Show earlier above the thread, keeps the messages it has as older ones come in, and goes at the start", async () => {
		const { controller, store, log, scroller } = view([item(3), item(4)]);
		const loadEarlier = vi.spyOn(controller, "loadEarlier").mockResolvedValue();
		const button = scroller.firstElementChild?.querySelector<HTMLButtonElement>("button");
		expect(button?.textContent).toBe("Show earlier messages");
		expect(log.contains(button!)).toBe(false);
		const kept = [...log.querySelectorAll("[data-message-id]")];
		button!.focus();
		button!.click();
		expect(loadEarlier).toHaveBeenCalledWith(session.sessionId);
		store.set({ earlierLoading: true });
		await settle();
		expect(button?.textContent).toBe("Loading earlier messages…");
		expect(button?.getAttribute("aria-disabled")).toBe("true");
		store.set({
			earlierLoading: false,
			hasEarlier: false,
			projection: { items: [item(1), item(2), item(3), item(4)], hiddenCount: 0, lastSequence: 4 },
		});
		await settle();
		expect(
			[...scroller.querySelectorAll<HTMLElement>("[data-message-id]")].map((node) => node.dataset.messageId),
		).toEqual([1, 2, 3, 4].map((n) => id(500 + n)));
		// The older messages stand above the live log; the log keeps the ones it had.
		expect([...log.querySelectorAll("[data-message-id]")]).toEqual(kept);
		expect(scroller.querySelector("button.thread-earlier-button")).toBeNull();
		// The keyboard stays in the thread.
		expect(document.activeElement).toBe(scroller);
	});

	/** A layout for jsdom (which has none): the thread shows 300 px, each row (the Show earlier
	 * block, a separator, a message) is 100 px tall, in the order the page has them. */
	function layout(scroller: HTMLElement) {
		let scrollTop = 0;
		const rows = () => [
			...scroller.querySelectorAll(
				":scope > .thread-earlier, :scope > .thread-older > *, :scope > .messages-log > *",
			),
		];
		Object.defineProperty(scroller, "scrollTop", {
			configurable: true,
			get: () => scrollTop,
			set: (value: number) => {
				scrollTop = Math.max(0, Math.min(value, rows().length * 100 - 300));
			},
		});
		Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => rows().length * 100 });
		Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 300 });
		const rect = (top: number, height: number) =>
			({ top, bottom: top + height, left: 0, right: 800, width: 800, height, x: 0, y: top }) as DOMRect;
		vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
			if (this === scroller) return rect(0, 300);
			const row = rows().indexOf(this);
			return row < 0 ? rect(0, 0) : rect(row * 100 - scrollTop, 100);
		});
		return {
			top: (node: Element) => node.getBoundingClientRect().top,
			scroll(to: number) {
				scroller.scrollTop = to;
				scroller.dispatchEvent(new Event("scroll"));
			},
		};
	}

	it("keeps the reader on the message they were reading when older ones come in above", async () => {
		const items = [3, 4, 5, 6, 7, 8].map(item);
		const { store, scroller } = view(items);
		const screen = layout(scroller);
		// Scrolled to the top: "Show earlier" is in view, the first message below it.
		screen.scroll(0);
		const reading = scroller.querySelector<HTMLElement>(`[data-message-id="${id(503)}"]`)!;
		const before = screen.top(reading);
		expect(screen.top(scroller.querySelector(".thread-earlier")!)).toBe(0);
		store.set({ earlierLoading: true });
		await settle();
		store.set({
			earlierLoading: false,
			projection: { items: [1, 2, 3, 4, 5, 6, 7, 8].map(item), hiddenCount: 0, lastSequence: 8 },
		});
		await settle();
		// The two older messages came in above; the reader still sees message 3 where it was.
		expect(scroller.querySelector(`[data-message-id="${id(501)}"]`)).not.toBeNull();
		expect(screen.top(reading)).toBe(before);
		expect(scroller.scrollTop).toBe(200);
	});

	it("brings older messages in outside the live log, says how many in one line, and still announces a new one", async () => {
		const { store, log, scroller, thread } = view([item(3), item(4)]);
		store.set({ earlierLoading: true });
		await settle();
		const heard: string[] = [];
		const observer = new MutationObserver((records) => {
			for (const record of records)
				for (const node of record.addedNodes)
					if (node instanceof HTMLElement && node.dataset.messageId) heard.push(node.textContent ?? "");
		});
		observer.observe(log, { childList: true, subtree: true });
		store.set({
			earlierLoading: false,
			hasEarlier: false,
			projection: { items: [item(1), item(2), item(3), item(4)], hiddenCount: 0, lastSequence: 4 },
		});
		await settle();
		// The older messages stand above the log, outside it: it hears none of them, and is never muted.
		expect(heard).toEqual([]);
		expect(log.getAttribute("aria-live")).toBe("polite");
		expect(
			scroller.querySelector(".thread-older")?.contains(scroller.querySelector(`[data-message-id="${id(501)}"]`)),
		).toBe(true);
		const status = thread.el.querySelector<HTMLElement>(".visually-hidden[role='status']");
		expect(log.contains(status)).toBe(false);
		expect(status?.textContent).toBe("Loaded 2 earlier messages. This is the start of the conversation.");
		// A new message a moment later goes into the live log, which announces it.
		await new Promise((resolve) => setTimeout(resolve, 100));
		store.set({ projection: { items: [1, 2, 3, 4, 5].map(item), hiddenCount: 0, lastSequence: 5 } });
		await settle();
		observer.disconnect();
		expect(heard).toEqual(["Message 5"]);
		expect(log.getAttribute("aria-live")).toBe("polite");
	});

	it("keeps older messages out of the live log when a waiting message was sent before the first one shown", async () => {
		// Sent between minutes 2 and 3 and still waiting; the thread opens at messages 5 and 6. The
		// transcript places a waiting message by its send time, before the first message sent after it.
		const queued = { ...pending(90, "Still waiting"), createdAt: new Date(Date.parse(at(2)) + 30_000).toISOString() };
		const read = (last: number, first = 5) =>
			projectTranscript(
				Array.from({ length: last - first + 1 }, (_, index) => message(first + index)),
				[queued],
			);
		const opened = read(6);
		const { store, log, scroller, thread } = view(opened.items);
		const ids = (part: Element) =>
			[...part.querySelectorAll<HTMLElement>("[data-message-id]")].map((node) => node.dataset.messageId);
		const idOf = (n: number) => read(n, n).items.find((item) => item.kind === "member" && !item.pending)!.id;
		expect(ids(scroller)).toEqual([queued.inputId, idOf(5), idOf(6)]);
		expect(ids(log)).toEqual([idOf(5), idOf(6)]);
		store.set({ earlierLoading: true });
		await settle();
		const heard: string[] = [];
		const observer = new MutationObserver((records) => {
			for (const record of records)
				for (const node of record.addedNodes)
					if (node instanceof HTMLElement && node.dataset.messageId) heard.push(node.textContent ?? "");
		});
		observer.observe(log, { childList: true, subtree: true });
		store.set({ earlierLoading: false, hasEarlier: false, projection: read(6, 1) });
		await settle();
		// The waiting message moved to its place among the older ones; none of them came into the log.
		expect(ids(scroller)).toEqual([idOf(1), idOf(2), queued.inputId, idOf(3), idOf(4), idOf(5), idOf(6)]);
		expect(ids(log)).toEqual([idOf(5), idOf(6)]);
		expect(heard).toEqual([]);
		const status = thread.el.querySelector<HTMLElement>(".visually-hidden[role='status']");
		expect(status?.textContent).toBe("Loaded 4 earlier messages. This is the start of the conversation.");
		// A new message still goes into the live log, which announces it.
		store.set({ projection: read(7, 1) });
		await settle();
		observer.disconnect();
		expect(heard).toEqual(["Message 7"]);
		expect(ids(log)).toEqual([idOf(5), idOf(6), idOf(7)]);
	});

	it("says when older messages could not be read", async () => {
		const { scroller } = view([item(3)], { earlierError: "Network down" });
		expect(scroller.querySelector(".thread-earlier-note")?.textContent).toBe(
			"Earlier messages could not be loaded. Network down",
		);
	});

	it("leaves out a coding session and a decision whose place lies in the unread history", async () => {
		const early: CodingSession = {
			workerId: id(900),
			workerKey: "fix",
			title: "An older coding session",
			agentId: staff.id,
			ownerUserId: userA.id,
			harness: "codex",
			repository: { host: "github.com", owner: "Qorpera", name: "Qorpera_Base", baseBranch: "master" },
			branch: "qorpera/coding/fix",
			sequence: 1,
			workerState: "settled",
			phase: "completed",
			filesChanged: 0,
			checks: [],
			artifacts: [],
			updatedAt: at(1),
			createdAt: at(1),
			sessionId: session.sessionId,
			isOwner: true,
			standby: false,
			attached: false,
			runningCommands: 0,
			machineAsleep: false,
		};
		const decision: TranscriptItem = {
			kind: "authorization_decision",
			id: id(700),
			sequence: 4,
			actorUserId: userA.id,
			body: { requestEventId: id(699), decision: "approved" },
			createdAt: at(4),
		};
		const { store, log } = view([item(3), decision], { codingSessions: [early] });
		expect(log.querySelector(".coding-line")).toBeNull();
		expect(log.querySelector(".auth-card")).toBeNull();
		// With the whole history read, both show, as before.
		store.set({ hasEarlier: false });
		await settle();
		expect(log.querySelector(".coding-line")).not.toBeNull();
		expect(log.querySelector(".auth-card")).not.toBeNull();
	});
});

describe("the two agents' view-only conversation", () => {
	it("offers Show earlier while its older messages are unread", async () => {
		const f = fixture();
		const controller = new CompanyController(f.api, profileA, userA.id);
		const coworker = { ...staff, id: id(97), displayName: "Helper" };
		controller.store.set({ team, staff: [staff, coworker], sessions: [], loading: false });
		const pair = id(98);
		const reply: TranscriptItem = {
			kind: "agent",
			id: id(501),
			sequence: 400,
			text: "Done",
			attachmentCount: 0,
			phase: "final",
			staffSpeaker: { runId: id(502), staffAgentId: staff.id, staffVersion: 1 },
			createdAt: at(400),
		};
		controller.conversation(pair, false).set({
			loading: false,
			complete: true,
			hasEarlier: true,
			projection: { items: [reply], hiddenCount: 0, lastSequence: 400 },
		});
		const loadEarlier = vi.spyOn(controller, "loadEarlier").mockResolvedValue();
		vi.spyOn(controller, "loadConversation").mockResolvedValue();
		const transcript = new PairTranscriptView(controller, pair, [coworker.id, staff.id], () => {});
		document.body.append(transcript.el);
		cleanup.push(() => {
			transcript.dispose();
			controller.stop();
		});
		const button = transcript.el.querySelector<HTMLButtonElement>(".thread-earlier-button");
		expect(button?.textContent).toBe("Show earlier messages");
		button!.click();
		expect(loadEarlier).toHaveBeenCalledWith(pair);
		controller.conversation(pair).set({ hasEarlier: false });
		await settle();
		expect(transcript.el.querySelector(".thread-earlier-button")).toBeNull();
	});
});
