// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import type { CodingSession } from "../src/cloud/coding-session.ts";
import type { TranscriptMessage } from "../src/cloud/transcript.ts";
import {
	fixture,
	id,
	profileA,
	session,
	settle,
	staff,
	stubFigureMotion,
	team,
	timestamp,
	userA,
	userB,
} from "./fixtures.ts";

let dispose: (() => void) | undefined;
beforeEach(() => {
	vi.useFakeTimers({ now: Date.parse("2026-09-22T10:10:00Z") });
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	vi.stubGlobal("innerWidth", 1280);
	stubFigureMotion();
	history.replaceState(null, "", `/#/c/${profileA.profileId}/chat/${session.sessionId}`);
});
afterEach(() => {
	dispose?.();
	dispose = undefined;
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function message(
	sequence: number,
	text: string,
	createdAt: string,
	kind: "member" | "agent" = "agent",
): TranscriptMessage {
	return {
		kind,
		id: id(800 + sequence),
		sequence,
		text,
		attachmentCount: 0,
		phase: kind === "agent" ? "final" : undefined,
		createdAt,
		authorUserId: userA.id,
	};
}

function codingSession(overrides: Partial<CodingSession> = {}): CodingSession {
	return {
		workerId: id(900),
		workerKey: "fix-send",
		title: "Fix the delay after send",
		agentId: staff.id,
		ownerUserId: userA.id,
		harness: "codex",
		repository: { host: "github.com", owner: "Qorpera", name: "Qorpera_Base", baseBranch: "master" },
		branch: `qorpera/coding/${id(900)}`,
		sequence: 1,
		workerState: "active",
		phase: "running",
		filesChanged: 0,
		checks: [],
		artifacts: [],
		startedAt: "2026-09-22T10:01:00Z",
		updatedAt: "2026-09-22T10:02:00Z",
		createdAt: "2026-09-22T10:01:00Z",
		sessionId: session.sessionId,
		isOwner: true,
		standby: true,
		attached: false,
		runningCommands: 0,
		machineAsleep: false,
		...overrides,
	};
}

/** The view over a conversation whose state is set before it loads (the store
 * exists first, so the view's own load does not overwrite the test's state). */
function mount(prepare: (store: ReturnType<CompanyController["conversation"]>) => void = () => {}) {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	company.store.set({
		team: {
			...team,
			members: [
				{
					userId: userB.id,
					displayName: "Sofie Lund",
					role: "contributor",
					email: "s@example.invalid",
					joinedAt: timestamp,
				},
			],
		},
		staff: [staff],
		sessions: [{ ...session, staffAgentId: staff.id }],
		loading: false,
	});
	const store = company.conversation(session.sessionId, false);
	store.set({ loading: false, complete: true });
	prepare(store);
	const view = new ConversationView(company, session.sessionId);
	document.body.append(view.el);
	dispose = () => {
		view.dispose();
		company.stop();
	};
	return { ...f, company, view, store };
}

const rows = (messages: HTMLElement) => [...messages.children].filter((node) => node.tagName !== "TIME");

describe("coding sessions in the thread", () => {
	it("is one line where the agent started it, like a message to a coworker, and opens the session", async () => {
		const f = mount((store) => {
			store.set({
				projection: {
					items: [
						message(1, "Can you fix it?", "2026-09-22T10:00:00Z", "member"),
						message(2, "Starting a coding session.", "2026-09-22T10:00:30Z"),
						message(3, "While that runs: anything else?", "2026-09-22T10:05:00Z"),
					],
					hiddenCount: 0,
					lastSequence: 3,
				},
				codingSessions: [codingSession({ phase: "completed", workerState: "succeeded" })],
			});
		});
		vi.mocked(f.api.readCodingSession).mockResolvedValue({
			session: codingSession({ ownerUserId: userB.id, isOwner: false, phase: "completed" }),
			isOwner: false,
			events: [],
		});
		const store = f.store;
		await settle();
		const messages = f.view.el.querySelector<HTMLElement>('[role="log"]')!;
		// Date separators (<time>) are not part of the order under test.
		const order = rows(messages).map((node) =>
			node.classList.contains("coding-line")
				? "coding"
				: node.classList.contains("message")
					? "message"
					: node.tagName,
		);
		expect(order).toEqual(["message", "message", "coding", "message"]);
		const line = messages.querySelector<HTMLElement>(".coding-line")!;
		const chip = line.querySelector<HTMLButtonElement>(".peer-chip")!;
		// No subject (the agent is the thread's own), no status, no fold: the harness with its mark.
		expect(chip.textContent).toBe("Started a coding session inCodex");
		expect([...chip.children].map((node) => node.tagName.toLowerCase())).toEqual(["span", "svg", "span"]);
		expect(chip.querySelector("svg.coding-mark-codex")).not.toBeNull();
		expect(chip.getAttribute("aria-label")).toBe(
			"Started a coding session in Codex · Fix the delay after send. Open the session",
		);
		expect(chip.title).toContain("Fix the delay after send");
		expect(line.querySelector(".coding-status, .coding-body, .coding-field-input")).toBeNull();
		// Another owner reads the same line.
		store.set({
			codingSessions: [
				codingSession({
					ownerUserId: userB.id,
					isOwner: false,
					phase: "completed",
					workerState: "succeeded",
					updatedAt: "2026-09-22T10:09:00Z",
				}),
			],
		});
		await settle();
		const again = messages.querySelector<HTMLButtonElement>(".coding-line .peer-chip")!;
		expect(again.textContent).toBe("Started a coding session inCodex");
		// A keyboard user on the line keeps it through a redraw (a new message here).
		again.focus();
		store.set({
			projection: {
				items: [...store.get().projection.items, message(4, "Done.", "2026-09-22T10:09:30Z")],
				hiddenCount: 0,
				lastSequence: 4,
			},
		});
		await settle();
		expect(messages.querySelector(".coding-line .peer-chip")).toBe(again);
		expect(document.activeElement).toBe(again);
		// The line opens the session as its own thread over the conversation; the back arrow comes back to it.
		again.click();
		await settle();
		const thread = f.view.el.querySelector(".coding-thread")!;
		expect(thread).not.toBeNull();
		expect(thread.querySelector("h1")?.textContent).toBe("Fixture agent ⇄ Codex");
		expect(thread.getAttribute("aria-label")).toBe("Fixture agent ⇄ Codex · Fix the delay after send");
		expect(thread.querySelector(".coding-thread-subtitle")?.textContent).toBe("Fix the delay after send");
		expect(thread.querySelector(".coding-session .coding-body")).not.toBeNull();
		// No footer and no Close: the lock line stands where the owner's composer would, the back arrow returns.
		expect(thread.querySelector(".coding-thread-footer")).toBeNull();
		expect([...thread.querySelectorAll("button")].some((b) => b.textContent === "Close")).toBe(false);
		expect(thread.querySelector(".coding-footer .coding-talk-locked")?.textContent).toBe(
			"Only Sofie Lund can write to this session. Steer it through Fixture agent.",
		);
		thread.querySelector<HTMLButtonElement>(".coding-thread-back")!.click();
		expect(f.view.el.querySelector(".coding-thread")).toBeNull();
		expect(document.activeElement).toBe(messages.querySelector(".coding-line .peer-chip"));
	});

	it("a session still going sits beside the agent in the header, working, and leaves when it settles", async () => {
		const f = mount((store) => {
			store.set({
				projection: { items: [message(1, "On it.", "2026-09-22T10:00:30Z")], hiddenCount: 0, lastSequence: 1 },
				codingSessions: [
					codingSession(),
					codingSession({
						workerId: id(901),
						title: "Older work",
						phase: "completed",
						createdAt: "2026-09-22T09:00:00Z",
					}),
				],
			});
		});
		const running = codingSession({ lastStep: "npm test", updatedAt: "2026-09-22T10:10:01Z" });
		vi.mocked(f.api.listCodingSessions).mockResolvedValue([running]);
		vi.mocked(f.api.readCodingSession).mockResolvedValue({ session: running, isOwner: true, events: [] });
		await settle();
		const header = f.view.el.querySelector<HTMLElement>(".thread-header")!;
		const slots = header.querySelector<HTMLElement>(".thread-coding-sessions")!;
		// Right after the agent, before who is here and the computer button; only the session still going.
		expect([...header.children].map((node) => node.className)).toEqual([
			"mobile-navigation-toggle icon-button",
			"thread-identity",
			"thread-coding-sessions",
			"thread-presence",
			"icon-button thread-computer",
		]);
		expect(slots.hidden).toBe(false);
		const slot = slots.querySelector<HTMLButtonElement>(".coding-slot")!;
		expect(slots.querySelectorAll(".coding-slot")).toHaveLength(1);
		expect(slot.dataset.workerId).toBe(id(900));
		expect(slot.querySelector(".coding-slot-name")?.textContent).toBe("Fix the delay after send");
		expect(slot.querySelector(".coding-badge-codex")).not.toBeNull();
		expect(slot.dataset.tone).toBe("working");
		// It re-reads the sessions on the working clock while one is going.
		vi.mocked(f.api.listCodingSessions).mockClear();
		await vi.advanceTimersByTimeAsync(2_500);
		expect(f.api.listCodingSessions).toHaveBeenCalledWith(session.sessionId);
		await settle();
		expect(header.querySelector(".coding-slot")).toBe(slot);
		expect(slot.title).toContain("npm test");
		// The figure opens the session; Escape gives focus back to it.
		slot.click();
		await settle();
		expect(f.view.el.querySelector(".coding-thread")).not.toBeNull();
		f.view.el
			.querySelector(".coding-thread")!
			.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(document.activeElement).toBe(slot);
		// Settled: the figure leaves the header and the reads stop.
		vi.mocked(f.api.listCodingSessions).mockResolvedValue([
			codingSession({ phase: "completed", workerState: "succeeded", updatedAt: "2026-09-22T10:12:00Z" }),
		]);
		await vi.advanceTimersByTimeAsync(2_500);
		await settle();
		expect(header.querySelector(".coding-slot")).toBeNull();
		expect(slots.hidden).toBe(true);
		const reads = vi.mocked(f.api.listCodingSessions).mock.calls.length;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(f.api.listCodingSessions).toHaveBeenCalledTimes(reads);
		// The line stays in the thread.
		expect(f.view.el.querySelector(".coding-line")).not.toBeNull();
	});

	it("an open title pill steps aside over the next figure, so that figure opens its own session", async () => {
		const f = mount((store) => {
			store.set({
				projection: { items: [], hiddenCount: 0, lastSequence: 0 },
				codingSessions: [
					codingSession(),
					codingSession({ workerId: id(902), title: "Second", createdAt: "2026-09-22T10:05:00Z" }),
				],
			});
		});
		vi.mocked(f.api.listCodingSessions).mockImplementation(async () => f.store.get().codingSessions ?? []);
		await settle();
		const slots = f.view.el.querySelector<HTMLElement>(".thread-coding-sessions")!;
		const [first, second] = [...slots.querySelectorAll<HTMLElement>(".coding-slot")];
		// jsdom lays nothing out: the figures stand 30 px wide, 14 px apart, at the header's height.
		const box = (left: number) => ({ left, right: left + 30, top: 6, bottom: 42 }) as DOMRect;
		vi.spyOn(first!, "getBoundingClientRect").mockReturnValue(box(100));
		vi.spyOn(second!, "getBoundingClientRect").mockReturnValue(box(144));
		const move = (x: number) =>
			first!.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x, clientY: 20 }));
		// Over the first figure: it keeps the pointer (the others step aside, which changes nothing here).
		move(120);
		expect(first!.classList.contains("coding-slot-yield")).toBe(false);
		expect(second!.classList.contains("coding-slot-yield")).toBe(true);
		// Over the second figure, under the first one's pill: the first steps aside.
		move(150);
		expect(first!.classList.contains("coding-slot-yield")).toBe(true);
		expect(second!.classList.contains("coding-slot-yield")).toBe(false);
		// Beyond the figures, on the first pill's title: it takes the pointer again.
		move(260);
		expect(first!.classList.contains("coding-slot-yield")).toBe(false);
		move(150);
		slots.dispatchEvent(new PointerEvent("pointerleave"));
		expect(first!.classList.contains("coding-slot-yield")).toBe(false);
	});

	it("a session waiting on its owner waits in the header at the slower pace", async () => {
		const asked = codingSession({ phase: "awaiting_input", workerState: "blocked" });
		const f = mount((store) => {
			store.set({ projection: { items: [], hiddenCount: 0, lastSequence: 0 }, codingSessions: [asked] });
		});
		vi.mocked(f.api.listCodingSessions).mockResolvedValue([asked]);
		await settle();
		const slot = f.view.el.querySelector<HTMLElement>(".thread-header .coding-slot")!;
		expect(slot.dataset.tone).toBe("attention");
		expect(slot.title).toBe("Fix the delay after send · Needs you · your answer is recorded in this thread");
		vi.mocked(f.api.listCodingSessions).mockClear();
		await vi.advanceTimersByTimeAsync(2_500);
		expect(f.api.listCodingSessions).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(3_500);
		expect(f.api.listCodingSessions).toHaveBeenCalledTimes(1);
	});

	it("follows the sessions without redrawing the thread, one read at a time, backing off on errors", async () => {
		const f = mount((store) => {
			store.set({
				projection: { items: [message(1, "On it.", "2026-09-22T10:00:30Z")], hiddenCount: 0, lastSequence: 1 },
				codingSessions: [codingSession()],
			});
		});
		vi.mocked(f.api.readCodingSession).mockResolvedValue({ session: codingSession(), isOwner: true, events: [] });
		let finish: (sessions: CodingSession[]) => void = () => {};
		vi.mocked(f.api.listCodingSessions).mockImplementation(
			() =>
				new Promise<CodingSession[]>((resolve) => {
					finish = resolve;
				}),
		);
		await settle();
		const messages = f.view.el.querySelector<HTMLElement>(".messages")!;
		const line = messages.querySelector(".coding-line")!;
		const slot = f.view.el.querySelector<HTMLButtonElement>(".thread-header .coding-slot")!;
		slot.focus();
		vi.mocked(f.api.listCodingSessions).mockClear();
		await vi.advanceTimersByTimeAsync(2_500);
		expect(f.api.listCodingSessions).toHaveBeenCalledTimes(1);
		// Back on the tab while the read is on its way: no second loop starts beside it.
		document.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(10_000);
		expect(f.api.listCodingSessions).toHaveBeenCalledTimes(1);
		// The session's step changes: the header takes it and the thread keeps its nodes.
		finish([codingSession({ lastStep: "npm test", updatedAt: "2026-09-22T10:10:01Z" })]);
		await settle();
		expect(messages.querySelector(".coding-line")).toBe(line);
		expect(slot.title).toContain("npm test");
		await vi.advanceTimersByTimeAsync(2_500);
		expect(f.api.listCodingSessions).toHaveBeenCalledTimes(2);
		// A second session starts: the header takes both, and the focused figure keeps focus.
		finish([
			codingSession({ lastStep: "npm test", updatedAt: "2026-09-22T10:10:01Z" }),
			codingSession({ workerId: id(902), title: "Second", createdAt: "2026-09-22T10:20:00Z" }),
		]);
		await settle();
		expect(f.view.el.querySelectorAll(".thread-header .coding-slot")).toHaveLength(2);
		expect(document.activeElement).toBe(slot);
		await vi.advanceTimersByTimeAsync(2_500);
		expect(f.api.listCodingSessions).toHaveBeenCalledTimes(3);
		// A failed read waits twice as long before the next one.
		vi.mocked(f.api.listCodingSessions).mockRejectedValue(new Error("offline"));
		finish([codingSession({ updatedAt: "2026-09-22T10:10:02Z" })]);
		await settle();
		await vi.advanceTimersByTimeAsync(2_500);
		expect(f.api.listCodingSessions).toHaveBeenCalledTimes(4);
		await vi.advanceTimersByTimeAsync(2_500);
		expect(f.api.listCodingSessions).toHaveBeenCalledTimes(4);
		await vi.advanceTimersByTimeAsync(2_500);
		expect(f.api.listCodingSessions).toHaveBeenCalledTimes(5);
	});

	it("an older read never undoes a newer state the thread already has", async () => {
		const f = mount((store) => {
			store.set({
				projection: { items: [], hiddenCount: 0, lastSequence: 0 },
				codingSessions: [codingSession({ phase: "input_ready", sequence: 2, updatedAt: "2026-09-22T10:04:00Z" })],
			});
		});
		vi.mocked(f.api.listCodingSessions).mockResolvedValue([
			codingSession({ phase: "awaiting_input", workerState: "blocked", updatedAt: "2026-09-22T10:03:00Z" }),
		]);
		await f.company.refreshCodingSessions(session.sessionId);
		expect(f.store.get().codingSessions?.[0]).toMatchObject({ phase: "input_ready", sequence: 2 });
		vi.mocked(f.api.listCodingSessions).mockResolvedValue([
			codingSession({ phase: "running", sequence: 2, updatedAt: "2026-09-22T10:05:00Z" }),
		]);
		await f.company.refreshCodingSessions(session.sessionId);
		expect(f.store.get().codingSessions?.[0]).toMatchObject({ phase: "running" });
	});

	it("a cloud without coding sessions renders the thread as before", async () => {
		const f = mount();
		vi.mocked(f.api.readSessionEvents).mockResolvedValue([]);
		vi.mocked(f.api.listCodingSessions).mockRejectedValue(
			new CloudRpcError(
				"qorpera_list_coding_sessions",
				{ message: "Could not find the function", code: "PGRST202" },
				404,
			),
		);
		await f.company.loadConversation(session.sessionId);
		await settle();
		const state = f.company.conversation(session.sessionId).get();
		expect(state.error).toBeUndefined();
		expect(state.codingSessions).toEqual([]);
		expect(f.view.el.querySelector(".coding-line")).toBeNull();
		expect(f.view.el.querySelector<HTMLElement>(".thread-coding-sessions")?.hidden).toBe(true);
		expect(f.view.el.querySelector(".messages")?.textContent).toContain("No messages yet.");
	});

	it("the owner's answer in the session's thread goes through the controller and refreshes the listing", async () => {
		const asked = codingSession({
			phase: "awaiting_input",
			workerState: "blocked",
			updatedAt: "2026-09-22T10:03:00Z",
		});
		const f = mount((store) => {
			store.set({ projection: { items: [], hiddenCount: 0, lastSequence: 0 }, codingSessions: [asked] });
		});
		vi.mocked(f.api.listCodingSessions).mockResolvedValue([asked]);
		vi.mocked(f.api.readCodingSession).mockResolvedValue({
			session: asked,
			isOwner: true,
			events: [
				{
					id: 1,
					sequence: 1,
					kind: "needs_input",
					actor: "executor",
					body: { needs: "Keep 250 ms?" },
					at: asked.updatedAt,
				},
			],
		});
		const answered = codingSession({ phase: "input_ready", sequence: 2, updatedAt: "2026-09-22T10:04:00Z" });
		vi.mocked(f.api.answerCodingSession).mockResolvedValue(answered);
		const store = f.store;
		await settle();
		f.view.el.querySelector<HTMLButtonElement>(".coding-line .peer-chip")!.click();
		await settle();
		const field = f.view.el.querySelector<HTMLTextAreaElement>(".coding-thread .coding-field-input")!;
		// The session asks, so the caret lands in its composer when it opens.
		expect(document.activeElement).toBe(field);
		// On a touch screen the same session opens on its back arrow: the caret would bring up the keyboard.
		f.view.el.querySelector<HTMLButtonElement>(".coding-thread-back")!.click();
		vi.stubGlobal("matchMedia", (query: string) => ({
			matches: query === "(pointer: coarse)",
			addEventListener() {},
			removeEventListener() {},
		}));
		try {
			f.view.el.querySelector<HTMLButtonElement>(".coding-line .peer-chip")!.click();
			await settle();
			expect(document.activeElement).toBe(f.view.el.querySelector(".coding-thread-back"));
		} finally {
			vi.unstubAllGlobals();
		}
		f.view.el.querySelector<HTMLButtonElement>(".coding-thread-back")!.click();
		f.view.el.querySelector<HTMLButtonElement>(".coding-line .peer-chip")!.click();
		await settle();
		const reopened = f.view.el.querySelector<HTMLTextAreaElement>(".coding-thread .coding-field-input")!;
		expect(document.activeElement).toBe(reopened);
		// Escape keeps a draft being written in the composer.
		reopened.value = "Keep it.";
		reopened.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(f.view.el.querySelector(".coding-thread")).not.toBeNull();
		reopened.dispatchEvent(new Event("input", { bubbles: true }));
		reopened.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await settle();
		expect(f.api.answerCodingSession).toHaveBeenCalledWith(id(900), "Keep it.", expect.any(String));
		expect(store.get().codingSessions?.[0]).toMatchObject({ phase: "input_ready", sequence: 2, isOwner: true });
		expect(f.view.el.querySelector<HTMLElement>(".thread-header .coding-slot")?.dataset.tone).toBe("working");
	});
});
