// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

	it("a session still going shows in the pill above the composer, working, and leaves when it settles", async () => {
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
		// Nothing of it in the header: the dock stands right above the composer.
		expect(f.view.el.querySelector(".thread-header .coding-pill, .thread-header .coding-badge")).toBeNull();
		const dock = f.view.el.querySelector<HTMLElement>(".thread-conversation > .thread-foot > .coding-dock")!;
		expect(f.view.el.querySelector(".agent-wall + .coding-dock + footer.composer")).not.toBeNull();
		expect(dock.hidden).toBe(false);
		// Only the session still going, and alone it is the pill's one line.
		expect(dock.querySelector(".coding-pill")?.classList.contains("is-single")).toBe(true);
		expect(dock.querySelectorAll(".coding-pill-row")).toHaveLength(0);
		const line = dock.querySelector<HTMLButtonElement>(".coding-pill-summary")!;
		expect(line.dataset.workerId).toBe(id(900));
		expect(line.querySelector(".coding-pill-label")?.textContent).toBe("Fix the delay after send");
		expect(line.querySelector(".coding-badge-codex")).not.toBeNull();
		expect(line.querySelector<HTMLElement>(".coding-pill-note")?.dataset.tone).toBe("working");
		expect(line.querySelector(".coding-pill-action")?.textContent).toBe("Open");
		// It re-reads the sessions on the working clock while one is going.
		vi.mocked(f.api.listCodingSessions).mockClear();
		await vi.advanceTimersByTimeAsync(2_500);
		expect(f.api.listCodingSessions).toHaveBeenCalledWith(session.sessionId);
		await settle();
		expect(dock.querySelector(".coding-pill-summary")).toBe(line);
		expect(line.querySelector(".coding-pill-note")?.textContent).toContain("npm test");
		// The line opens the session; Escape gives focus back to it.
		line.click();
		await settle();
		expect(f.view.el.querySelector(".coding-thread")).not.toBeNull();
		f.view.el
			.querySelector(".coding-thread")!
			.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(document.activeElement).toBe(line);
		// Settled: the pill goes and the reads stop.
		vi.mocked(f.api.listCodingSessions).mockResolvedValue([
			codingSession({ phase: "completed", workerState: "succeeded", updatedAt: "2026-09-22T10:12:00Z" }),
		]);
		await vi.advanceTimersByTimeAsync(2_500);
		await settle();
		expect(dock.hidden).toBe(true);
		const reads = vi.mocked(f.api.listCodingSessions).mock.calls.length;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(f.api.listCodingSessions).toHaveBeenCalledTimes(reads);
		// The line stays in the thread.
		expect(f.view.el.querySelector(".coding-line")).not.toBeNull();
	});

	it("several sessions fold under the pill's count, which unfolds into their lines and folds on Escape", async () => {
		const sessions = [
			codingSession(),
			codingSession({ workerId: id(902), title: "Second", createdAt: "2026-09-22T10:05:00Z" }),
		];
		const f = mount((store) => {
			store.set({
				projection: { items: [message(1, "On it.", "2026-09-22T10:00:30Z")], hiddenCount: 0, lastSequence: 1 },
				codingSessions: sessions,
			});
		});
		vi.mocked(f.api.listCodingSessions).mockImplementation(async () => f.store.get().codingSessions ?? []);
		vi.mocked(f.api.readCodingSession).mockImplementation(async (workerId) => ({
			session: f.store.get().codingSessions?.find((item) => item.workerId === workerId) ?? sessions[0]!,
			isOwner: true,
			events: [],
		}));
		await settle();
		const pill = f.view.el.querySelector<HTMLElement>(".coding-dock .coding-pill")!;
		const summary = pill.querySelector<HTMLButtonElement>(".coding-pill-summary")!;
		expect(summary.querySelector(".coding-pill-label")?.textContent).toBe("2 coding agents");
		expect(summary.querySelector(".coding-pill-note")?.textContent).toBe("Working");
		const rows = () => [...pill.querySelectorAll<HTMLButtonElement>(".coding-pill-row")];
		// Oldest first.
		expect(rows().map((row) => row.dataset.workerId)).toEqual([id(900), id(902)]);
		expect(summary.getAttribute("aria-expanded")).toBe("false");
		summary.focus();
		summary.click();
		expect(pill.dataset.open).toBe("true");
		expect(summary.getAttribute("aria-expanded")).toBe("true");
		// Escape folds it back onto the summary, and goes no further than the pill.
		const second = rows()[1]!;
		second.focus();
		second.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(pill.dataset.open).toBe("false");
		expect(summary.getAttribute("aria-expanded")).toBe("false");
		expect(document.activeElement).toBe(summary);
		// A line opens its own session; focus comes back to the line when it closes.
		summary.click();
		second.click();
		await settle();
		expect(f.view.el.querySelector(".coding-thread")?.getAttribute("aria-label")).toContain("Second");
		f.view.el.querySelector<HTMLButtonElement>(".coding-thread-back")!.click();
		expect(document.activeElement).toBe(second);
		// A line that left while its session was open hands focus to the session's line in the thread.
		const first = rows()[0]!;
		first.click();
		await settle();
		f.store.set({
			codingSessions: [
				codingSession({ phase: "completed", workerState: "succeeded", updatedAt: "2026-09-22T10:12:00Z" }),
				sessions[1]!,
			],
		});
		await settle();
		expect(first.isConnected).toBe(false);
		f.view.el.querySelector<HTMLButtonElement>(".coding-thread-back")!.click();
		expect(document.activeElement).toBe(
			f.view.el.querySelector(`.coding-line[data-worker-id="${id(900)}"] .peer-chip`),
		);
		// One left going: the summary is its line.
		expect(pill.classList.contains("is-single")).toBe(true);
		expect(summary.querySelector(".coding-pill-label")?.textContent).toBe("Second");
	});

	it("a session waiting on its owner asks for the answer in the pill, at the slower pace", async () => {
		const asked = codingSession({ phase: "awaiting_input", workerState: "blocked" });
		const f = mount((store) => {
			store.set({ projection: { items: [], hiddenCount: 0, lastSequence: 0 }, codingSessions: [asked] });
		});
		vi.mocked(f.api.listCodingSessions).mockResolvedValue([asked]);
		await settle();
		const line = f.view.el.querySelector<HTMLElement>(".coding-dock .coding-pill-summary")!;
		expect(line.querySelector<HTMLElement>(".coding-pill-note")?.dataset.tone).toBe("attention");
		expect(line.querySelector(".coding-pill-action")?.textContent).toBe("Answer");
		expect(line.getAttribute("aria-label")).toBe(
			"Fix the delay after send · Needs you · your answer is recorded in this thread. Open the session",
		);
		vi.mocked(f.api.listCodingSessions).mockClear();
		await vi.advanceTimersByTimeAsync(2_500);
		expect(f.api.listCodingSessions).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(3_500);
		expect(f.api.listCodingSessions).toHaveBeenCalledTimes(1);
	});

	it("another member's waiting session reads as theirs in the pill, quietly, and opens with Open", async () => {
		const theirs = codingSession({
			phase: "awaiting_input",
			workerState: "blocked",
			ownerUserId: userB.id,
			isOwner: false,
		});
		const f = mount((store) => {
			store.set({ projection: { items: [], hiddenCount: 0, lastSequence: 0 }, codingSessions: [theirs] });
		});
		vi.mocked(f.api.listCodingSessions).mockResolvedValue([theirs]);
		await settle();
		const line = f.view.el.querySelector<HTMLElement>(".coding-dock .coding-pill-summary")!;
		expect(line.querySelector(".coding-pill-note")?.textContent).toMatch(/^Needs Sofie Lund · paused /);
		expect(line.querySelector<HTMLElement>(".coding-pill-note")?.dataset.tone).toBe("idle");
		expect(line.querySelector(".coding-pill-action")?.textContent).toBe("Open");
	});

	it("the card's computer closes a session open as its own thread", async () => {
		const f = mount((store) => {
			store.set({
				projection: { items: [message(1, "On it.", "2026-09-22T10:00:30Z")], hiddenCount: 0, lastSequence: 1 },
				codingSessions: [codingSession()],
			});
		});
		vi.mocked(f.api.listCodingSessions).mockResolvedValue([codingSession()]);
		vi.mocked(f.api.readCodingSession).mockResolvedValue({ session: codingSession(), isOwner: true, events: [] });
		await settle();
		f.view.el.querySelector<HTMLButtonElement>(".coding-dock .coding-pill-summary")!.click();
		await settle();
		expect(f.view.el.querySelector(".coding-thread")).not.toBeNull();
		expect(f.view.show(staff.id, "computer")).toBe(true);
		expect(f.view.el.querySelector(".coding-thread")).toBeNull();
		expect(document.activeElement).toBe(f.view.el.querySelector(".computer-panel"));
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
		const pill = f.view.el.querySelector<HTMLElement>(".coding-dock .coding-pill")!;
		const summary = pill.querySelector<HTMLButtonElement>(".coding-pill-summary")!;
		summary.focus();
		vi.mocked(f.api.listCodingSessions).mockClear();
		await vi.advanceTimersByTimeAsync(2_500);
		expect(f.api.listCodingSessions).toHaveBeenCalledTimes(1);
		// Back on the tab while the read is on its way: no second loop starts beside it.
		document.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(10_000);
		expect(f.api.listCodingSessions).toHaveBeenCalledTimes(1);
		// The session's step changes: the pill takes it and the thread keeps its nodes.
		finish([codingSession({ lastStep: "npm test", updatedAt: "2026-09-22T10:10:01Z" })]);
		await settle();
		expect(messages.querySelector(".coding-line")).toBe(line);
		expect(summary.querySelector(".coding-pill-note")?.textContent).toContain("npm test");
		await vi.advanceTimersByTimeAsync(2_500);
		expect(f.api.listCodingSessions).toHaveBeenCalledTimes(2);
		// A second session starts: the pill gathers both as lines, and its focused summary keeps focus.
		finish([
			codingSession({ lastStep: "npm test", updatedAt: "2026-09-22T10:10:01Z" }),
			codingSession({ workerId: id(902), title: "Second", createdAt: "2026-09-22T10:20:00Z" }),
		]);
		await settle();
		expect(pill.querySelectorAll(".coding-pill-row")).toHaveLength(2);
		expect(summary.querySelector(".coding-pill-label")?.textContent).toBe("2 coding agents");
		expect(document.activeElement).toBe(summary);
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
		expect(f.view.el.querySelector<HTMLElement>(".coding-dock")?.hidden).toBe(true);
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
		expect(
			f.view.el.querySelector<HTMLElement>(".coding-dock .coding-pill-summary .coding-pill-note")?.dataset.tone,
		).toBe("working");
	});
});

describe("the coding pill on the wall's line", () => {
	// jsdom lays nothing out, so the stylesheet's rules are what is pinned here (checked in headless Chrome at 600, 680
	// and 1200px for PR #1557).
	const conversation = readFileSync(resolve("src/styles/conversation.css"), "utf8");
	const wall = readFileSync(resolve("src/styles/agent-wall.css"), "utf8");

	it("joins the wall's line only on a wide thread, narrow only while folded", () => {
		const shared =
			conversation.match(/@container thread-conversation \(min-width: 48\.6em\) \{([^@]*?)\n\}/)?.[1] ?? "";
		expect(shared).toContain(".agent-wall:not([hidden]) + .coding-dock { height: 0; margin-top: 0; }");
		// Unfolded (hover, focus or a tap) it keeps its usual width over the wall's button.
		expect(shared).toContain(
			'.coding-pill:not(:is(:not([data-folded="true"]):is(:hover, :focus-within), [data-open="true"])) { width: min(300px, calc(50% - 160px)); }',
		);
		expect(shared).toContain(".agent-wall-toggle { max-width: 300px; }");
		expect(conversation).toMatch(/\.thread-conversation \{[^}]*container: thread-conversation \/ inline-size;/);
	});

	it("lays the thread's foot over the messages, with everything its bands hold taking the pointer", () => {
		expect(conversation).toMatch(/\.messages \{[^}]*padding: 16px 16px calc\(40px \+ var\(--thread-foot, 0px\)\);/);
		// Every band passes the pointer through; whatever a band holds (a notice, the execution line's buttons, the pill,
		// the composer's parts) takes it back, so no control is left out by a list.
		expect(conversation).toContain(".thread-foot > * { pointer-events: none; }");
		expect(conversation).toContain(".thread-foot > * > * { pointer-events: auto; }");
		// The composer stands over the coding dock (z-index 6), so its menus open over the pill.
		expect(conversation).toContain(".thread-foot .composer { position: relative; z-index: 7; }");
		expect(conversation).toMatch(/\.coding-dock \{[^}]*z-index: 6;/);
		// The Answering strip is measured inside the composer's shell: no margin of its own.
		expect(conversation).not.toMatch(/\.thread-foot[^{]*\.composer-answer/);
	});

	it("leaves a single draft its own place while coding sessions go", () => {
		const sharing = wall
			.split("\n")
			.filter((line) => line.includes(".composer-drafts") && line.includes(".agent-wall"));
		expect(sharing.length).toBeGreaterThanOrEqual(4);
		for (const line of sharing) expect(line).toContain(".coding-dock[hidden] + .composer");
		expect(wall).not.toMatch(/\.agent-wall[^{]*~ \.composer/);
	});
});
