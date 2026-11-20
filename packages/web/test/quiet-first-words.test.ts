// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import type { TranscriptItem, TranscriptMessage } from "../src/cloud/transcript.ts";
import type { HostedStaffExecutionActivity } from "../src/cloud/types.ts";
import { fixture, id, profileA, session, settle, staff, stubFigureMotion, team, timestamp, userA } from "./fixtures.ts";

const cleanup: (() => void)[] = [];
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
	vi.useRealTimers();
	for (const dispose of cleanup.splice(0).reverse()) dispose();
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const RUN = id(90);
const NEXT = id(91);
const working: HostedStaffExecutionActivity = {
	runId: RUN,
	staffAgentId: staff.id,
	sourceKind: "session_turn",
	jobStatus: "leased",
	activity: "working",
	updatedAt: timestamp,
};
const at = (n: number) => new Date(Date.parse("2026-11-20T08:00:00Z") + n * 1000).toISOString();
const asked: TranscriptMessage = {
	kind: "member",
	id: id(70),
	sequence: 1,
	text: "Where is the refund?",
	attachmentCount: 0,
	authorUserId: userA.id,
	createdAt: at(0),
};
const say = (n: number, text: string, phase: "progress" | "final", runId = RUN): TranscriptMessage => ({
	kind: "agent",
	id: id(70 + n),
	sequence: n,
	text,
	attachmentCount: 0,
	phase,
	runId,
	createdAt: at(n),
});
const heard = say(2, "Checking the refund log.", "progress");

function setup(room = false, first: TranscriptItem[] = []) {
	stubFigureMotion();
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	const opened = room ? { ...session, executionScope: { roomId: id(79) } } : { ...session, staffAgentId: staff.id };
	company.store.set({ team, staff: [staff], sessions: [opened], loading: false });
	company
		.conversation(session.sessionId, false)
		.set({ loading: false, projection: { items: first, hiddenCount: 0, lastSequence: first.length } });
	const view = new ConversationView(company, session.sessionId);
	document.body.append(view.el);
	cleanup.push(() => {
		view.dispose();
		company.stop();
	});
	const show = async (items: TranscriptItem[], activity: HostedStaffExecutionActivity[], more: object = {}) => {
		company.store.set({ activity });
		company
			.conversation(session.sessionId)
			.set({ projection: { items, hiddenCount: 0, lastSequence: items.length }, ...more });
		view.update();
		await settle();
	};
	const messages = () =>
		[...view.el.querySelectorAll<HTMLElement>("article.message")].map((el) =>
			[...el.querySelectorAll(".bubble")].map((bubble) => bubble.textContent).join(" "),
		);
	const row = () => view.el.querySelector<HTMLElement>(".thread-activity");
	const words = () => row()?.querySelector<HTMLElement>(".thread-activity-words");
	const wait = async (ms: number) => {
		vi.advanceTimersByTime(ms);
		await settle();
	};
	return { company, view, show, messages, row, words, wait };
}

describe("the agent's first words while it works", () => {
	it("stand beside the working figure, not as a message, and go when the answer comes", async () => {
		const f = setup();
		await f.show([asked], [working]);
		const row = f.row()!;
		expect(f.words()?.hidden).toBe(true);
		expect(row.getAttribute("aria-label")).toBe(`${staff.displayName} is working`);
		await f.show([asked, heard], [working]);
		expect(f.messages()).toEqual(["Where is the refund?"]);
		expect(f.row()).toBe(row);
		expect(f.words()?.hidden).toBe(false);
		expect(f.words()?.textContent).toBe("Checking the refund log.");
		expect(row.getAttribute("aria-label")).toBe(`${staff.displayName} is working. Checking the refund log.`);
		await f.show([asked, heard, say(3, "It was paid on Monday.", "final")], []);
		expect(f.messages()).toEqual(["Where is the refund?", "It was paid on Monday."]);
		expect(f.row()).toBeNull();
		expect(f.view.el.textContent).not.toContain("Checking the refund log.");
	});

	it("show as plain words, whatever the agent marked up", async () => {
		const f = setup();
		await f.show([asked, say(2, "**Checking** the [refund log](https://example.test/log).", "progress")], [working]);
		expect(f.words()?.textContent).toBe("Checking the refund log.");
		expect(f.words()?.children).toHaveLength(0);
	});

	it("go from the row when the run says more, and its later progress stays a message", async () => {
		const f = setup();
		await f.show([asked, heard, say(3, "Half way: the log has two entries.", "progress")], [working]);
		expect(f.messages()).toEqual(["Where is the refund?", "Half way: the log has two entries."]);
		expect(f.words()?.hidden).toBe(true);
		expect(f.row()?.getAttribute("aria-label")).toBe(`${staff.displayName} is working`);
	});

	it("stay as a message when the work ended with nothing more, also once newer work runs", async () => {
		const f = setup();
		await f.show([asked, heard], [working]);
		expect(f.messages()).toEqual(["Where is the refund?"]);
		await f.show([asked, heard], []);
		expect(f.messages()).toEqual(["Where is the refund?"]);
		await f.wait(4_999);
		expect(f.messages()).toEqual(["Where is the refund?"]);
		await f.wait(1);
		expect(f.messages()).toEqual(["Where is the refund?", "Checking the refund log."]);
		expect(f.view.el.querySelector("article.message-progress")?.textContent).toBe("Checking the refund log.");
		await f.show([asked, heard], [{ ...working, runId: NEXT }]);
		expect(f.messages()).toEqual(["Where is the refund?", "Checking the refund log."]);
		expect(f.words()?.hidden).toBe(true);
		await f.show([asked, heard, say(3, "Looking again.", "progress", NEXT)], [{ ...working, runId: NEXT }]);
		expect(f.messages()).toEqual(["Where is the refund?", "Checking the refund log."]);
		expect(f.words()?.textContent).toBe("Looking again.");
	});

	it("never flash as a message when the thread is read a moment before or after the agent's state", async () => {
		const f = setup();
		await f.show([asked], []);
		await f.show([asked, heard], []);
		expect(f.messages()).toEqual(["Where is the refund?"]);
		await f.wait(2_000);
		await f.show([asked, heard], [working]);
		expect(f.messages()).toEqual(["Where is the refund?"]);
		expect(f.words()?.textContent).toBe("Checking the refund log.");
		await f.show([asked, heard], []);
		expect(f.row()).toBeNull();
		expect(f.messages()).toEqual(["Where is the refund?"]);
		await f.wait(2_000);
		await f.show([asked, heard, say(3, "It was paid on Monday.", "final")], []);
		await f.wait(10_000);
		expect(f.messages()).toEqual(["Where is the refund?", "It was paid on Monday."]);
	});

	it("show at once as the message they were when the thread opens on work that ended long ago", async () => {
		const f = setup(false, [asked, heard]);
		await settle();
		expect(f.messages()).toEqual(["Where is the refund?", "Checking the refund log."]);
	});

	it("go from a group thread when their run says more, also while another agent's run speaks in between", async () => {
		const f = setup(true);
		const other = say(3, "Looking at the bank file.", "progress", NEXT);
		await f.show([asked, heard, other], []);
		expect(f.row()).toBeNull();
		expect(f.messages()).toEqual(["Where is the refund?", "Checking the refund log.", "Looking at the bank file."]);
		const answers = [say(4, "It was paid on Monday.", "final"), say(5, "The bank file agrees.", "final", NEXT)];
		await f.show([asked, heard, other, ...answers], []);
		expect(f.messages()).toEqual(["Where is the refund?", "It was paid on Monday.", "The bank file agrees."]);
		await f.show([asked, heard, other, ...answers], [], { hasEarlier: true });
		expect(f.messages()).toHaveLength(5);
	});

	it("leave a longer or formatted first message as the message it is", async () => {
		const f = setup();
		const long = say(2, "Checking the refund log.\n\nThen I will write to the bank.", "progress");
		await f.show([asked, long], [working]);
		expect(f.messages()).toHaveLength(2);
		expect(f.words()?.hidden).toBe(true);
	});

	it("keep an old run's progress at the top of a thread that has earlier messages to read", async () => {
		const f = setup();
		const items = [say(2, "Still on the second file.", "progress"), say(3, "Done.", "final")];
		await f.show(items, [], { hasEarlier: true });
		expect(f.messages()).toEqual(["Still on the second file.", "Done."]);
		await f.show(items, [], { hasEarlier: false });
		expect(f.messages()).toEqual(["Done."]);
	});
});
