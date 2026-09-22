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

describe("coding sessions in the thread", () => {
	it("stands where the agent started it and keeps its element across renders", async () => {
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
				codingSessions: [codingSession()],
			});
		});
		vi.mocked(f.api.readCodingSession).mockResolvedValue({ session: codingSession(), isOwner: true, events: [] });
		const store = f.store;
		await settle();
		const messages = f.view.el.querySelector<HTMLElement>(".messages")!;
		// Date separators (<time>) are not part of the order under test.
		const rows = () => [...messages.children].filter((node) => node.tagName !== "TIME");
		const order = rows().map((node) =>
			node.classList.contains("coding-session")
				? "coding"
				: node.classList.contains("message")
					? "message"
					: node.tagName,
		);
		expect(order).toEqual(["message", "message", "coding", "message"]);
		const element = messages.querySelector(".coding-session")!;
		expect(element.querySelector(".coding-chip")?.textContent).toBe(
			"Fixture agent started a coding session with you in Codex",
		);
		expect(element.querySelector(".coding-status-title")?.textContent).toBe("Fix the delay after send");
		// A new message re-renders the thread; the session's element is the same node.
		store.set({
			projection: {
				items: [...store.get().projection.items, message(4, "Done with the other thing.", "2026-09-22T10:08:00Z")],
				hiddenCount: 0,
				lastSequence: 4,
			},
		});
		await settle();
		expect(messages.querySelector(".coding-session")).toBe(element);
		expect(rows()).toHaveLength(5);
		// The listing names the owner by the roster when it is someone else.
		store.set({
			codingSessions: [codingSession({ ownerUserId: userB.id, isOwner: false, updatedAt: "2026-09-22T10:09:00Z" })],
		});
		await settle();
		expect(messages.querySelector(".coding-chip")?.textContent).toContain("with Sofie Lund in Codex");
		// The chip opens the session as its own thread over the conversation; Close comes back.
		messages.querySelector<HTMLButtonElement>(".coding-chip")!.click();
		await settle();
		const thread = f.view.el.querySelector(".coding-thread")!;
		expect(thread).not.toBeNull();
		expect(thread.querySelector("h1")?.textContent).toBe("Fixture agent ⇄ Codex");
		expect(thread.querySelector(".coding-thread-subtitle")?.textContent).toBe("Fix the delay after send");
		expect(thread.querySelector(".coding-session-thread .coding-body")).not.toBeNull();
		expect(thread.querySelector(".coding-thread-footer")?.textContent).toContain(
			"This session is view-only. Only Sofie Lund can type",
		);
		[...thread.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Close")!.click();
		expect(f.view.el.querySelector(".coding-thread")).toBeNull();
		expect(document.activeElement).toBe(messages.querySelector(".coding-chip"));
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
		expect(f.view.el.querySelector(".coding-session")).toBeNull();
		expect(f.view.el.querySelector(".messages")?.textContent).toContain("No messages yet.");
	});

	it("the owner's answer goes through the controller and refreshes the listing", async () => {
		const asked = codingSession({
			phase: "awaiting_input",
			workerState: "blocked",
			updatedAt: "2026-09-22T10:03:00Z",
		});
		const f = mount((store) => {
			store.set({ projection: { items: [], hiddenCount: 0, lastSequence: 0 }, codingSessions: [asked] });
		});
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
		const field = f.view.el.querySelector<HTMLInputElement>(".coding-field-input")!;
		field.value = "Keep it.";
		field.dispatchEvent(new Event("input", { bubbles: true }));
		field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await settle();
		expect(f.api.answerCodingSession).toHaveBeenCalledWith(id(900), "Keep it.", expect.any(String));
		expect(store.get().codingSessions?.[0]).toMatchObject({ phase: "input_ready", sequence: 2, isOwner: true });
	});
});
