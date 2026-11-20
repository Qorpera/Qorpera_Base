// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController, type ConversationState } from "../src/app/company.ts";
import type { OpenQuestions, OpenQuestionsState } from "../src/app/open-questions.ts";
import { Store } from "../src/app/state.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import type { QuestionDockHost } from "../src/app/views/question-dock.ts";
import type { OpenQuestion } from "../src/cloud/open-questions.ts";
import type { TranscriptInteraction } from "../src/cloud/transcript.ts";
import { fixture, id, profileA, session, settle, staff, team, userA } from "./fixtures.ts";

const card: TranscriptInteraction = {
	kind: "interaction",
	id: id(730),
	sequence: 1,
	actorUserId: userA.id,
	createdAt: "2026-09-05T10:00:00Z",
	request: { surface: "question", title: "Approve the mission?", payload: { options: [{ label: "Approve" }] } },
};
const listed: OpenQuestion = {
	sessionId: session.sessionId,
	interactionId: card.id,
	sequence: 1,
	actorUserId: userA.id,
	staffAgentId: staff.id,
	request: card.request,
	createdAt: card.createdAt,
};

let dispose: (() => void) | undefined;
beforeEach(() => {
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("No external requests in this fixture")));
});
afterEach(() => {
	dispose?.();
	dispose = undefined;
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	localStorage.clear();
	sessionStorage.clear();
});

function setup(cofounder: boolean) {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	vi.spyOn(company, "loadConversation").mockResolvedValue();
	vi.spyOn(company, "cofounderId").mockReturnValue(cofounder ? staff.id : id(799));
	company.store.set({ team, staff: [staff], sessions: [{ ...session, staffAgentId: staff.id }], loading: false });
	company
		.conversation(session.sessionId)
		.set({ loading: false, projection: { items: [card], hiddenCount: 0, lastSequence: 1 } });
	const store = new Store<OpenQuestionsState>({ questions: [listed], read: true, unavailable: false });
	const stopped = vi.fn();
	const decisions: QuestionDockHost = {
		questions: { store, watch: () => stopped, refresh: async () => {}, forget: () => {} } as unknown as OpenQuestions,
		agent: (agentId) => company.staffById(agentId),
		memberName: () => "Jonas",
		conversation: (sessionId) => company.conversation(sessionId, false) as Store<ConversationState>,
	};
	const view = new ConversationView(company, session.sessionId, { decisions });
	document.body.append(view.el);
	dispose = () => {
		view.dispose();
		company.stop();
	};
	return { view, store, stopped };
}

describe("open decisions in the Co-Founder's chat", () => {
	it("stand right above the message box, and a docked card is not drawn in the thread as well", async () => {
		const f = setup(true);
		await settle();
		const dock = f.view.el.querySelector<HTMLElement>(".thread-foot > .decision-dock");
		expect(dock?.hidden).toBe(false);
		expect(dock?.nextElementSibling?.classList.contains("composer")).toBe(true);
		expect(dock?.querySelector(".interaction-title")?.textContent).toBe("Approve the mission?");
		expect(f.view.el.querySelectorAll(".interaction-card")).toHaveLength(1);
		expect(f.view.el.querySelector(".messages .interaction-card")).toBeNull();

		f.store.set({ questions: [] });
		await settle();
		expect(f.view.el.querySelector<HTMLElement>(".decision-dock")?.hidden).toBe(true);
		expect(f.view.el.querySelector(".messages .interaction-card .interaction-title")?.textContent).toBe(
			"Approve the mission?",
		);

		f.view.dispose();
		expect(f.stopped).toHaveBeenCalled();
		expect(document.querySelector(".decision-dock")).toBeNull();
	});

	it("are gathered in no other agent's thread", async () => {
		const f = setup(false);
		await settle();
		expect(f.view.el.querySelector(".decision-dock")).toBeNull();
		expect(f.view.el.querySelector(".messages .interaction-card .interaction-title")?.textContent).toBe(
			"Approve the mission?",
		);
	});
});
