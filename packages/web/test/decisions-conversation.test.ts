// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController, type ConversationState } from "../src/app/company.ts";
import type { OpenQuestions, OpenQuestionsState } from "../src/app/open-questions.ts";
import { Store } from "../src/app/state.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import type { QuestionDockHost } from "../src/app/views/question-dock.ts";
import type { OpenDraft } from "../src/cloud/open-decisions.ts";
import type { OpenQuestion } from "../src/cloud/open-questions.ts";
import { actionReviewCard } from "../src/cloud/review-rules.ts";
import type { TranscriptCard, TranscriptInteraction, TranscriptItem } from "../src/cloud/transcript.ts";
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
	const store = new Store<OpenQuestionsState>({
		questions: [listed],
		decisions: [{ ...listed, kind: "question" }],
		read: true,
		unavailable: false,
	});
	const stopped = vi.fn();
	const answered = vi.fn(async () => {});
	const approved = vi.fn(async () => {});
	const decisions: QuestionDockHost = {
		questions: {
			store,
			watch: () => stopped,
			refresh: async () => {},
			forget: () => {},
			answer: answered,
			answerApproval: approved,
			hold: () => {},
			release: () => {},
			draftEditor: (draft: OpenDraft) => company.emailDraftEditor(draft.interactionId),
			loadDraft: async () => ({
				from: "jonas@mywave.test",
				content: { to: ["ada@acme.test"], cc: [], subject: "Our offer", body: "Hello Ada" },
				status: "ready",
			}),
		} as unknown as OpenQuestions,
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
	const show = (items: TranscriptItem[]) =>
		company
			.conversation(session.sessionId)
			.set({ loading: false, projection: { items, hiddenCount: 0, lastSequence: items.length } });
	const reopen = () =>
		company.conversation(session.sessionId).set({
			projection: { items: [{ ...card, answerFailed: true }], hiddenCount: 0, lastSequence: 1 },
		});
	return { view, company, store, stopped, answered, approved, reopen, show };
}

function waitingApproval(f: ReturnType<typeof setup>, reviewId: string): TranscriptCard {
	const data = {
		schema: "qorpera.action-review/v1",
		reviewId,
		title: "Send an email",
		summary: "It writes to someone outside the company.",
		builtIn: "none",
		approverScope: "member",
		approverUserId: userA.id,
		alwaysAllow: false,
	};
	const request: TranscriptCard = {
		kind: "authorization_request",
		id: reviewId,
		sequence: 1,
		actorUserId: userA.id,
		body: { entry: { type: "custom", customType: "authorization_request", data } },
		createdAt: "2026-09-05T10:00:00Z",
	};
	f.show([request]);
	const review = actionReviewCard(data);
	if (!review) throw new Error("review expected");
	f.store.set({
		questions: [],
		decisions: [
			{
				kind: "approval",
				sessionId: session.sessionId,
				interactionId: reviewId,
				staffAgentId: staff.id,
				createdAt: request.createdAt,
				review,
			},
		],
	});
	return request;
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

		f.store.set({ questions: [], decisions: [] });
		await settle();
		expect(f.view.el.querySelector<HTMLElement>(".decision-dock")?.hidden).toBe(true);
		expect(f.view.el.querySelector(".messages .interaction-card .interaction-title")?.textContent).toBe(
			"Approve the mission?",
		);

		f.view.dispose();
		expect(f.stopped).toHaveBeenCalled();
		expect(document.querySelector(".decision-dock")).toBeNull();
	});

	it("become a block of their own in the chat when decided, with Undo while the answer is held", async () => {
		const f = setup(true);
		await settle();
		f.view.el.querySelector<HTMLButtonElement>(".decision-dock .interaction-options .btn")?.click();
		await settle();
		const block = f.view.el.querySelector<HTMLElement>(".messages .decided");
		expect(block?.querySelector(".decided-rule")?.textContent).toBe("Decided");
		expect(block?.querySelector(".decided-ask")?.textContent).toBe("Approve the mission?");
		expect(block?.querySelector(".decided-answer")?.textContent).toBe("Approve");
		expect(f.view.el.querySelector<HTMLElement>(".decision-dock")?.hidden).toBe(true);
		expect(f.view.el.querySelector(".messages .interaction-card")).toBeNull();
		expect(f.answered).not.toHaveBeenCalled();

		block?.querySelector<HTMLButtonElement>(".decided-undo")?.click();
		await settle();
		expect(f.view.el.querySelector(".messages .decided")).toBeNull();
		expect(f.view.el.querySelector<HTMLElement>(".decision-dock")?.hidden).toBe(false);
		expect(f.answered).not.toHaveBeenCalled();

		f.view.el.querySelector<HTMLButtonElement>(".decision-dock .interaction-options .btn")?.click();
		await settle();
		f.view.dispose();
		expect(f.answered).toHaveBeenCalledTimes(1);
		expect(f.answered).toHaveBeenCalledWith({ ...listed, kind: "question" }, "answered", { values: ["Approve"] });
	});

	it("show the card again when a sent answer never reached the agent", async () => {
		const f = setup(true);
		await settle();
		f.view.el.querySelector<HTMLButtonElement>(".decision-dock .interaction-options .btn")?.click();
		await settle();
		window.dispatchEvent(new Event("pagehide"));
		await settle();
		expect(f.answered).toHaveBeenCalledTimes(1);
		expect(f.view.el.querySelector(".messages .decided .decided-by span")?.textContent).toBe(
			`Sent to ${staff.displayName}`,
		);
		expect(f.view.el.querySelector(".messages .interaction-card")).toBeNull();

		f.store.set({ questions: [], decisions: [] });
		f.reopen();
		await settle();
		expect(f.view.el.querySelector(".messages .decided")).toBeNull();
		expect(f.view.el.querySelector(".messages .interaction-card .interaction-title")?.textContent).toBe(
			"Approve the mission?",
		);
	});

	it("show a docked approval once: not in the thread as well, and back there when the dock lets go", async () => {
		const f = setup(true);
		waitingApproval(f, id(731));
		await settle();
		expect(f.view.el.querySelector(".decision-dock .auth-card h3")?.textContent).toBe("Send an email");
		expect(f.view.el.querySelector(".messages .auth-card")).toBeNull();

		f.store.set({ decisions: [] });
		await settle();
		expect(f.view.el.querySelector(".decision-dock .auth-card")).toBeNull();
		expect(f.view.el.querySelector(".messages .auth-card h3")?.textContent).toBe("Send an email");
	});

	it("show an approval again when its sent answer never reached the agent", async () => {
		const f = setup(true);
		const request = waitingApproval(f, id(732));
		await settle();
		[...f.view.el.querySelectorAll<HTMLButtonElement>(".decision-dock button")]
			.find((button) => button.textContent === "Allow once")
			?.click();
		await settle();
		window.dispatchEvent(new Event("pagehide"));
		await settle();
		expect(f.approved).toHaveBeenCalledTimes(1);
		expect(f.view.el.querySelector(".messages .decided .decided-rule")?.textContent).toBe("Allowed once");
		expect(f.view.el.querySelector(".messages .decided .decided-by span")?.textContent).toBe(
			`Sent to ${staff.displayName}`,
		);
		expect(f.view.el.querySelector(".messages .auth-card")).toBeNull();

		f.store.set({ decisions: [] });
		f.show([{ ...request, answerFailed: true }]);
		await settle();
		expect(f.view.el.querySelector(".messages .decided")).toBeNull();
		expect(f.view.el.querySelector(".messages .auth-card h3")?.textContent).toBe("Send an email");
		expect(f.view.el.querySelector(".messages .auth-card")?.textContent).toContain("Answer again");
	});

	it("put a refused approval back, open, with the reason in plain words", async () => {
		const f = setup(true);
		waitingApproval(f, id(733));
		await settle();
		const refusal =
			"Your answer did not go. It would start this agent's work, and only members of the agent's thread can do that. Ask someone in that thread to answer.";
		f.approved.mockImplementationOnce(async () => {
			f.company.conversation(session.sessionId).set({ interactionError: refusal });
			throw new Error("Only a member of this thread can wake its agent");
		});
		const press = (label: string) =>
			[...f.view.el.querySelectorAll<HTMLButtonElement>(".decision-dock button")].find(
				(button) => button.textContent === label,
			);
		press("Allow once")?.click();
		await settle();
		window.dispatchEvent(new Event("pagehide"));
		await settle();
		expect(f.approved).toHaveBeenCalledTimes(1);
		expect(f.view.el.querySelector(".messages .decided")).toBeNull();
		expect(f.view.el.querySelector(".decision-dock .auth-card h3")?.textContent).toBe("Send an email");
		expect(press("Allow once")?.disabled).toBe(false);
		expect(f.view.el.querySelector(".decision-dock .decision-error")?.textContent).toBe(refusal);
	});

	it("show a docked Gmail draft once: not in the thread as well, and back there when the dock lets go", async () => {
		const f = setup(true);
		const letter: TranscriptInteraction = {
			kind: "interaction",
			id: id(734),
			sequence: 1,
			actorUserId: userA.id,
			createdAt: "2026-09-05T10:00:00Z",
			request: {
				surface: "draft",
				title: "New email",
				payload: {
					platform: "email",
					connectorId: "gmail",
					to: ["ada@acme.test"],
					cc: [],
					subject: "Our offer",
					body: "Hello Ada",
				},
			},
		};
		f.show([letter]);
		f.store.set({
			questions: [],
			decisions: [
				{
					kind: "draft",
					sessionId: session.sessionId,
					interactionId: letter.id,
					sequence: 1,
					actorUserId: userA.id,
					staffAgentId: staff.id,
					request: letter.request,
					createdAt: letter.createdAt,
				},
			],
		});
		await settle();
		expect(f.view.el.querySelector<HTMLTextAreaElement>(".decision-dock .email-draft-body")?.value).toBe("Hello Ada");
		expect(f.view.el.querySelector(".messages .email-draft-card")).toBeNull();

		f.view.el.querySelector<HTMLTextAreaElement>(".decision-dock .email-draft-body")!.value = "Hello Ada, again";
		f.view.el
			.querySelector<HTMLTextAreaElement>(".decision-dock .email-draft-body")
			?.dispatchEvent(new Event("input", { bubbles: true }));
		f.store.set({ decisions: [] });
		await settle();
		expect(f.view.el.querySelector(".decision-dock .email-draft-card")).toBeNull();
		expect(f.view.el.querySelector<HTMLTextAreaElement>(".messages .email-draft-body")?.value).toBe(
			"Hello Ada, again",
		);
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
