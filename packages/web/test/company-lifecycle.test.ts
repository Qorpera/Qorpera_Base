// @vitest-environment jsdom

import type {
	NativeExecutionConnections,
	SessionTurnRequestResult,
} from "@qorpera/cloud-client/cloud-native-subscription-control";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { OpenQuestions } from "../src/app/open-questions.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import { DecisionDock } from "../src/app/views/decision-dock.ts";
import { QuestionDock, type QuestionDockHost } from "../src/app/views/question-dock.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import type { OpenDecision } from "../src/cloud/open-decisions.ts";
import type { SessionInputWriter } from "../src/cloud/session-input.ts";
import type {
	HostedRunRecovery,
	HostedSession,
	HostedSessionEvent,
	HostedStaffExecutionActivity,
} from "../src/cloud/types.ts";
import {
	deferred,
	event,
	fixture,
	id,
	pending,
	profileA,
	session,
	settle,
	staff,
	team,
	userA,
	userB,
} from "./fixtures.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const dispose of cleanup.splice(0)) dispose();
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
});
const connections: NativeExecutionConnections = {
	computeIdentity: {
		computeIdentityId: id(82),
		ownershipKind: "member",
		ownerUserId: userA.id,
		displayName: "Member computer",
		templateKey: "member",
		templateVersion: "v1",
		capabilities: ["agent_turn"],
		policy: {},
		status: "active",
		createdAt: "2026-09-12T00:00:00Z",
		updatedAt: "2026-09-12T00:00:00Z",
	},
	connections: [
		{
			connectionId: id(80),
			clientConnectionId: id(180),
			connectionVersion: 1,
			provider: "openai",
			nativeHarness: "codex-cli",
			authorizationState: "active",
			maxNativeConcurrency: 1,
			billingSource: "member",
			consentVersion: "v1",
			consentedAt: "2026-09-12T00:00:00Z",
			connectionStatus: "active",
			sponsorBindingId: id(81),
			sponsorVersion: 1,
			policy: { implementationStatus: "supported", enablementStatus: "enabled", policyVersion: 1 },
		},
	],
};
const receipt: SessionTurnRequestResult = {
	inputId: pending(1).inputId,
	turnRequestId: id(92),
	status: "queued",
	sponsorMode: "member_connection",
};
function company() {
	const f = fixture();
	const write = vi.fn<SessionInputWriter>().mockResolvedValue(receipt);
	const controller = new CompanyController(f.api, profileA, userA.id, write);
	controller.store.set({ team, sessions: [session] });
	controller.setExecutionSponsor(session.sessionId, connections, id(80));
	cleanup.push(() => controller.stop());
	return { ...f, controller, write };
}

describe("answering an approval card of an agent's action (auto-review, v130)", () => {
	const reviewed = {
		reviewId: id(597),
		answer: "allow_once" as const,
		inputId: id(598),
		savedRuleId: null,
		woke: false,
	};

	it("answers on the member's selected model account and shows the answer at once", async () => {
		const f = company();
		const answer = vi.spyOn(f.api, "answerActionReview").mockResolvedValue(reviewed);
		await f.controller.answerActionReview(session.sessionId, id(597), "allow_once");
		expect(answer).toHaveBeenCalledOnce();
		expect(answer.mock.calls[0]!.slice(2)).toEqual([
			"allow_once",
			undefined,
			{ sponsorBindingId: id(81), sponsorVersion: 1 },
		]);
		const saved = f.controller.conversation(session.sessionId).get().interactionAnswers?.[id(597)];
		expect(saved).toMatchObject({ outcome: "approved", answer: { answer: "allow_once" }, inputId: id(598) });
	});

	it("saves the edited rule with Always allow, and records Deny as declined", async () => {
		const f = company();
		const answer = vi.spyOn(f.api, "answerActionReview").mockResolvedValue({ ...reviewed, answer: "always_allow" });
		await f.controller.answerActionReview(session.sessionId, id(597), "always_allow", "renewing our domains");
		expect(answer.mock.calls[0]!.slice(2, 4)).toEqual(["always_allow", "renewing our domains"]);
		answer.mockResolvedValue({ ...reviewed, reviewId: id(599), answer: "deny" });
		await f.controller.answerActionReview(session.sessionId, id(599), "deny");
		expect(f.controller.conversation(session.sessionId).get().interactionAnswers?.[id(599)]?.outcome).toBe(
			"declined",
		);
	});

	it("still answers a waiting card without a selected account; the kernel needs one only to wake the agent", async () => {
		const f = company();
		f.controller.conversation(session.sessionId).set({ executionSponsor: undefined });
		const answer = vi.spyOn(f.api, "answerActionReview").mockResolvedValue(reviewed);
		await f.controller.answerActionReview(session.sessionId, id(597), "allow_once");
		expect(answer.mock.calls[0]![4]).toBeUndefined();
	});

	function review(sequence: number, approverScope: "member" | "owners_admins"): HostedSessionEvent {
		const eventId = id(4000 + sequence);
		return {
			...event(sequence),
			eventId,
			actorUserId: userA.id,
			sessionInputId: undefined,
			eventType: "authorization_request",
			body: {
				schema: "qorpera.runner-transcript-entry/v1",
				entry: {
					type: "custom",
					customType: "authorization_request",
					id: eventId,
					parentId: null,
					timestamp: "2026-09-25T10:00:00.000Z",
					data: {
						schema: "qorpera.action-review/v1",
						reviewId: eventId,
						title: "Send an email",
						summary: "The company asks first before emailing outside the company.",
						target: "bob@acme.test",
						rules: [
							{ id: id(4999), scope: "company", when: "emailing outside the company", outcome: "ask_first" },
						],
						approverScope,
						...(approverScope === "member" ? { approverUserId: userB.id, approverName: "Bea" } : {}),
						alwaysAllow: false,
					},
				},
			},
		};
	}

	it("draws the approval card with its outcome, never a second card for its decision, and answers it", async () => {
		const f = company();
		f.controller.store.set({ loading: false });
		const decided = review(1, "owners_admins");
		const decision: HostedSessionEvent = {
			...event(2),
			eventId: id(4100),
			actorUserId: userA.id,
			sessionInputId: id(4101),
			eventType: "authorization_decision",
			body: {
				schema: "qorpera.runner-transcript-entry/v1",
				entry: {
					type: "custom",
					customType: "authorization_decision",
					id: id(4101),
					parentId: null,
					timestamp: "2026-09-25T10:01:00.000Z",
					data: {
						schema: "qorpera.interaction-answer/v1",
						interactionId: decided.eventId,
						requestEventId: decided.eventId,
						surface: "approval",
						outcome: "approved",
						decision: "approved",
						answer: { answer: "allow_once" },
						answeredBy: userA.id,
					},
				},
			},
		};
		vi.mocked(f.api.readSessionEvents).mockResolvedValue([
			decided,
			decision,
			review(3, "owners_admins"),
			review(4, "member"),
		]);
		const answer = vi.spyOn(f.api, "answerActionReview").mockResolvedValue(reviewed);
		void f.controller.loadConversation(session.sessionId);
		const view = new ConversationView(f.controller, session.sessionId, {
			sendMessage: (sessionId, text) => f.controller.sendPrompt(sessionId, text),
		});
		cleanup.push(() => view.dispose());
		document.body.append(view.el);
		await settle();
		expect(view.el.querySelectorAll(".auth-card")).toHaveLength(3);
		const cards = [...view.el.querySelectorAll<HTMLElement>(".action-review-card")];
		expect(cards.map((card) => card.dataset.decisionState)).toEqual(["approved", "pending", "pending"]);
		expect(cards[0]!.querySelector("button")).toBeNull();
		// An owner answers a company rule's card; a personal rule's card waits for its member.
		expect(cards[2]!.querySelector("button")).toBeNull();
		expect(cards[2]!.textContent).toContain("Waiting for Bea to approve.");
		[...cards[1]!.querySelectorAll("button")].find((button) => button.textContent === "Allow once")!.click();
		await settle();
		expect(answer).toHaveBeenCalledWith(id(4003), expect.any(String), "allow_once", undefined, {
			sponsorBindingId: id(81),
			sponsorVersion: 1,
		});
		// The answered card keeps the keyboard through the redraws that follow the answer.
		expect(document.activeElement).toBe(
			[...view.el.querySelectorAll<HTMLElement>(".action-review-card")].find(
				(card) => card.dataset.reviewId === id(4003),
			),
		);
	});

	it("takes the controls away when the conversation is closed, and keeps an Always allow draft across redraws", async () => {
		const f = company();
		f.controller.store.set({ loading: false });
		const card = review(5, "owners_admins");
		const data = (card.body as { entry: { data: Record<string, unknown> } }).entry.data;
		data.builtIn = "money";
		data.alwaysAllow = true;
		data.proposedRule = "paying for anything";
		vi.mocked(f.api.readSessionEvents).mockResolvedValue([card]);
		void f.controller.loadConversation(session.sessionId);
		const view = new ConversationView(f.controller, session.sessionId, {
			sendMessage: (sessionId, text) => f.controller.sendPrompt(sessionId, text),
		});
		cleanup.push(() => view.dispose());
		document.body.append(view.el);
		await settle();
		const open = () => view.el.querySelector<HTMLElement>(".action-review-card")!;
		[...open().querySelectorAll("button")].find((button) => button.textContent === "Always allow…")!.click();
		const input = open().querySelector<HTMLInputElement>(".review-rule-input")!;
		input.focus();
		input.value = "paying invoices under 100 EUR";
		input.dispatchEvent(new Event("input"));
		input.setSelectionRange(7, 15);
		// Something else in the thread changes: the card is drawn again.
		f.controller.store.set({ team: { ...team, members: [...team.members] } });
		vi.mocked(f.api.readSessionEvents).mockResolvedValue([card, event(6)]);
		await f.controller.loadConversation(session.sessionId);
		await settle();
		const redrawn = open().querySelector<HTMLInputElement>(".review-rule-input")!;
		expect(redrawn.closest<HTMLElement>(".review-always")!.hidden).toBe(false);
		expect(redrawn.value).toBe("paying invoices under 100 EUR");
		expect(document.activeElement).toBe(redrawn);
		expect([redrawn.selectionStart, redrawn.selectionEnd]).toEqual([7, 15]);
		// A refused answer keeps the rule as the member narrowed it.
		vi.spyOn(f.api, "answerActionReview").mockRejectedValue(
			new Error("Select an active model account, then try again."),
		);
		[...open().querySelectorAll("button")].find((button) => button.textContent === "Save rule and allow")!.click();
		await settle();
		expect(open().dataset.decisionState).toBe("pending");
		const kept = open().querySelector<HTMLInputElement>(".review-rule-input")!;
		expect(kept.closest<HTMLElement>(".review-always")!.hidden).toBe(false);
		expect(kept.value).toBe("paying invoices under 100 EUR");
		expect(document.activeElement).toBe(open());
		// The conversation is closed: no controls the cloud would refuse.
		f.controller.store.set({ sessions: [{ ...session, status: "closed" }] });
		await settle();
		expect(open().querySelector("button")).toBeNull();
	});

	it("shows an answer still on its way on the card, and opens it again when its delivery failed", async () => {
		const f = company();
		f.controller.store.set({ loading: false });
		const card = review(7, "owners_admins");
		vi.mocked(f.api.readSessionEvents).mockResolvedValue([card]);
		vi.mocked(f.api.listSessionInputs).mockResolvedValue({
			items: [
				{
					inputId: id(4201),
					position: 9,
					kind: "user_message",
					authorUserId: userB.id,
					authorDisplayName: "Bea",
					body: {
						schema: "qorpera.interaction-answer/v1",
						interactionId: card.eventId,
						surface: "approval",
						outcome: "approved",
						answer: { answer: "allow_once" },
					},
					createdAt: "2026-09-25T10:02:00.000Z",
					status: "queued",
				},
			],
			hasMore: false,
			nextAfterPosition: 9,
		});
		void f.controller.loadConversation(session.sessionId);
		const view = new ConversationView(f.controller, session.sessionId, {
			sendMessage: (sessionId, text) => f.controller.sendPrompt(sessionId, text),
		});
		cleanup.push(() => view.dispose());
		document.body.append(view.el);
		await settle();
		const shown = () => view.el.querySelector<HTMLElement>(".action-review-card")!;
		expect(shown().dataset.decisionState).toBe("approved");
		expect(shown().querySelector("button")).toBeNull();
		// The answer never reached the agent: the card is open again for whoever answers it.
		const queued = (await f.api.listSessionInputs(session.sessionId, 0)).items[0]!;
		vi.mocked(f.api.listSessionInputs).mockResolvedValue({
			items: [{ ...queued, status: "failed", failureReason: "The selected sponsor quota is unavailable" }],
			hasMore: false,
			nextAfterPosition: 9,
		});
		await f.controller.loadConversation(session.sessionId);
		await settle();
		expect(shown().dataset.decisionState).toBe("pending");
		expect(shown().textContent).toContain("That answer did not reach the agent. Answer again.");
		expect([...shown().querySelectorAll("button")].map((button) => button.textContent)).toContain("Allow once");
	});

	it("keeps the card open and says in plain words why someone outside the agent's thread cannot start its work", async () => {
		const f = company();
		vi.spyOn(f.api, "answerActionReview").mockRejectedValue(
			new CloudRpcError(
				"qorpera_answer_action_review",
				{ code: "42501", message: "Only a member of this thread can wake its agent" },
				403,
			),
		);
		await expect(f.controller.answerActionReview(session.sessionId, id(598), "allow_once")).rejects.toThrow();
		const state = f.controller.conversation(session.sessionId).get();
		expect(state.interactionError).toBe(
			"Your answer did not go. It would start this agent's work, and only members of the agent's thread can do that. Ask someone in that thread to answer.",
		);
		expect(state.interactionAnswers).toBeUndefined();
	});

	it("keeps the card open, saying why, where the cloud has no approvals yet", async () => {
		const f = company();
		vi.spyOn(f.api, "answerActionReview").mockRejectedValue(
			new CloudRpcError("qorpera_answer_action_review", { code: "PGRST202", message: "Could not find" }, 404),
		);
		await expect(f.controller.answerActionReview(session.sessionId, id(597), "allow_once")).rejects.toThrow();
		const state = f.controller.conversation(session.sessionId).get();
		expect(state.interactionError).toBe("Approvals are not available here yet. Reply in a message instead.");
		expect(state.interactionAnswers).toBeUndefined();
	});
});

describe("answering a card", () => {
	const thread: HostedSession = {
		...session,
		staffAgentId: staff.id,
		executionScope: { roomId: id(95), agentThread: true },
	};
	const answered = { inputId: id(96), position: 7 };
	function card(sequence: number, actorUserId: string): HostedSessionEvent {
		const eventId = id(3000 + sequence);
		return {
			...event(sequence),
			eventId,
			actorUserId,
			sessionInputId: undefined,
			eventType: "interaction_request",
			body: {
				schema: "qorpera.runner-transcript-entry/v1",
				entry: {
					type: "custom",
					customType: "interaction_request",
					id: eventId,
					parentId: null,
					timestamp: "2026-09-24T20:00:00.000Z",
					data: {
						schema: "qorpera.interaction/v1",
						surface: "question",
						title: "Which channel?",
						payload: { options: [{ label: "#general", value: "general" }] },
					},
				},
			},
		};
	}

	it("saves a coding value for the company and gives it to the card's repository (20260930693000)", async () => {
		const f = company();
		f.controller.store.set({ sessions: [thread] });
		const request = {
			surface: "secret" as const,
			title: "Token for private packages",
			payload: {
				name: "npm_token",
				label: "NPM_TOKEN",
				purpose: "Installs the private packages.",
				connectorId: "environment",
				repository: "acme/web",
			},
		};
		vi.spyOn(f.api, "listSecretConnections").mockResolvedValue([]);
		const begin = vi.spyOn(f.api, "beginSecretCapture").mockResolvedValue({} as never);
		vi.spyOn(f.api, "captureSecret").mockResolvedValue({ secretId: id(70) } as never);
		const answer = vi.spyOn(f.api, "answerInteraction").mockResolvedValue(answered);
		vi.mocked(f.cloud.rpc).mockImplementation(async (name: string) => {
			if (name !== "qorpera_grant_coding_environment_secret") throw new Error(`Unexpected ${name}`);
			return {
				schema: "qorpera.coding-environment-grant/v1",
				status: "active",
				secretId: id(70),
				grantId: id(71),
				repository: "acme/web",
				issuedByUserId: userA.id,
				createdAt: "2026-11-09T10:00:00Z",
			};
		});
		await f.controller.provideSecret(thread.sessionId, id(593), request, "npm_value_123456");
		expect(begin.mock.calls[0]![0]).toMatchObject({
			ownerKind: "company",
			connectorId: "environment",
			secretName: "npm_token",
		});
		expect(f.cloud.rpc).toHaveBeenCalledWith("qorpera_grant_coding_environment_secret", {
			p_profile_id: profileA.profileId,
			p_secret_id: id(70),
			p_repository: "acme/web",
		});
		expect(answer).toHaveBeenCalledOnce();
		expect(answer.mock.calls[0]![3]).toBe("provided");

		// A card with no repository: the member's own value, which reaches their coding sessions everywhere; no grant.
		vi.mocked(f.cloud.rpc).mockClear();
		begin.mockClear();
		const { repository: _, ...anywhere } = request.payload;
		await f.controller.provideSecret(
			thread.sessionId,
			id(594),
			{ ...request, payload: anywhere },
			"npm_value_123456",
		);
		expect(begin.mock.calls[0]![0]).toMatchObject({ ownerKind: "member", ownerUserId: userA.id });
		expect(f.cloud.rpc).not.toHaveBeenCalledWith("qorpera_grant_coding_environment_secret", expect.anything());
		expect(f.controller.secretSavedForCompany(request)).toBe(true);
		expect(f.controller.secretSavedForCompany({ ...request, payload: anywhere })).toBe(false);

		// A contributor on a card with a repository saves their own, with no grant: the card tells them so.
		f.controller.store.set({ team: { ...team, role: "contributor" } });
		expect(f.controller.secretSavedForCompany(request)).toBe(false);
		vi.mocked(f.cloud.rpc).mockClear();
		begin.mockClear();
		await f.controller.provideSecret(thread.sessionId, id(595), request, "npm_value_123456");
		expect(begin.mock.calls[0]![0]).toMatchObject({ ownerKind: "member", ownerUserId: userA.id });
		expect(f.cloud.rpc).not.toHaveBeenCalledWith("qorpera_grant_coding_environment_secret", expect.anything());
	});

	it("keeps a coding value's card open, saying so, when the value is saved but not given to the repository", async () => {
		const f = company();
		f.controller.store.set({ sessions: [thread] });
		vi.spyOn(f.api, "listSecretConnections").mockResolvedValue([]);
		vi.spyOn(f.api, "beginSecretCapture").mockResolvedValue({} as never);
		vi.spyOn(f.api, "captureSecret").mockResolvedValue({ secretId: id(70) } as never);
		const answer = vi.spyOn(f.api, "answerInteraction").mockResolvedValue(answered);
		vi.mocked(f.cloud.rpc).mockRejectedValue(new Error("Network unavailable"));
		await expect(
			f.controller.provideSecret(
				thread.sessionId,
				id(593),
				{
					surface: "secret",
					title: "Token",
					payload: {
						name: "npm_token",
						label: "NPM_TOKEN",
						purpose: "Packages.",
						connectorId: "environment",
						repository: "acme/web",
					},
				},
				"npm_value_123456",
			),
		).rejects.toThrow();
		expect(answer).not.toHaveBeenCalled();
		expect(f.controller.conversation(thread.sessionId).get().interactionError).toContain(
			"NPM_TOKEN is saved, but it could not be given to acme/web",
		);
	});

	it("in an agent's thread, answers on the member's selected model account", async () => {
		const f = company();
		f.controller.store.set({ sessions: [thread] });
		const answer = vi.spyOn(f.api, "answerInteraction").mockResolvedValue(answered);
		await f.controller.answerInteraction(thread.sessionId, id(593), "answered", { values: ["general"] });
		expect(answer).toHaveBeenCalledOnce();
		expect(answer.mock.calls[0]![5]).toEqual({ sponsorBindingId: id(81), sponsorVersion: 1 });
	});

	it("keeps the card open where the cloud cannot deliver an answer in an agent's thread yet", async () => {
		const f = company();
		f.controller.store.set({ sessions: [thread] });
		const answer = vi
			.spyOn(f.api, "answerInteraction")
			.mockRejectedValue(
				new CloudRpcError("qorpera_answer_interaction", { code: "PGRST202", message: "Could not find" }, 404),
			);
		await expect(
			f.controller.answerInteraction(thread.sessionId, id(593), "answered", { values: ["general"] }),
		).rejects.toThrow();
		expect(answer).toHaveBeenCalledOnce();
		const state = f.controller.conversation(thread.sessionId).get();
		expect(state.interactionError).toBe("Answering cards here is not available yet. Reply in a message instead.");
		expect(state.interactionAnswers).toBeUndefined();
	});

	it("in an agent's thread without a selected account, sends nothing and says so", async () => {
		const f = company();
		f.controller.store.set({ sessions: [thread] });
		f.controller.conversation(thread.sessionId).set({ executionSponsor: undefined });
		const answer = vi.spyOn(f.api, "answerInteraction");
		await expect(
			f.controller.answerInteraction(thread.sessionId, id(593), "answered", { values: ["general"] }),
		).rejects.toThrow();
		expect(answer).not.toHaveBeenCalled();
		const state = f.controller.conversation(thread.sessionId).get();
		expect(state.interactionError).toBe("Select an active model account, then try again.");
		expect(state.interactionAnswers).toBeUndefined();
	});

	it("in a plain conversation, answers on the member's selected model account, as a message there runs", async () => {
		const f = company();
		const answer = vi.spyOn(f.api, "answerInteraction").mockResolvedValue(answered);
		await f.controller.answerInteraction(session.sessionId, id(593), "answered", { values: ["general"] });
		expect(answer).toHaveBeenCalledOnce();
		expect(answer.mock.calls[0]![5]).toEqual({ sponsorBindingId: id(81), sponsorVersion: 1 });
	});

	it("in a plain conversation without a selected account, sends nothing and says so", async () => {
		const f = company();
		f.controller.conversation(session.sessionId).set({ executionSponsor: undefined });
		const answer = vi.spyOn(f.api, "answerInteraction");
		await expect(
			f.controller.answerInteraction(session.sessionId, id(593), "answered", { values: ["general"] }),
		).rejects.toThrow();
		expect(answer).not.toHaveBeenCalled();
		expect(f.controller.conversation(session.sessionId).get().interactionError).toBe(
			"Select an active model account, then try again.",
		);
	});

	it("opens the card again when the answer's delivery fails after the cloud accepted it", async () => {
		const f = company();
		f.controller.store.set({ loading: false });
		const request = card(1, userA.id);
		vi.mocked(f.api.readSessionEvents).mockResolvedValue([{ ...request, eventId: id(593) }]);
		vi.spyOn(f.api, "answerInteraction").mockResolvedValue(answered);
		// The listing the answer's own reload reads has not caught up with the answer yet.
		await f.controller.answerInteraction(session.sessionId, id(593), "answered", { values: ["general"] });
		await settle();
		expect(f.controller.conversation(session.sessionId).get().interactionAnswers?.[id(593)]).toMatchObject({
			pending: true,
			inputId: answered.inputId,
		});
		vi.mocked(f.api.listSessionInputs).mockResolvedValue({
			items: [
				{
					...pending(7),
					inputId: answered.inputId,
					body: {
						schema: "qorpera.interaction-answer/v1",
						interactionId: id(593),
						surface: "question",
						outcome: "answered",
						answer: { values: ["general"] },
					},
					status: "failed",
					failureReason: "The selected sponsor quota or model authority is unavailable",
				},
			],
			hasMore: false,
			nextAfterPosition: 7,
		});
		await f.controller.loadConversation(session.sessionId);
		const state = f.controller.conversation(session.sessionId).get();
		expect(state.interactionAnswers).toBeUndefined();
		const item = state.projection?.items.find((entry) => entry.kind === "interaction");
		expect(item?.kind === "interaction" && item.answerFailed).toBe(true);
	});

	it("says in plain words when the cloud refuses the model account, and keeps the card open", async () => {
		const f = company();
		vi.spyOn(f.api, "answerInteraction").mockRejectedValue(
			new CloudRpcError(
				"qorpera_answer_interaction",
				{ code: "42501", message: "Room sponsor is unavailable" },
				403,
			),
		);
		await expect(
			f.controller.answerInteraction(session.sessionId, id(593), "answered", { values: ["finance"] }),
		).rejects.toThrow("Room sponsor is unavailable");
		const state = f.controller.conversation(session.sessionId).get();
		expect(state.interactionError).toBe("Select an active model account, then try again.");
		expect(state.interactionAnswers).toBeUndefined();
	});

	it("shows the question being answered in the composer, until the member takes it back", async () => {
		const f = company();
		f.controller.store.set({ loading: false, sessions: [thread] });
		void f.controller.loadConversation(thread.sessionId);
		const view = new ConversationView(f.controller, thread.sessionId, {
			sendMessage: (sessionId, text) => f.controller.sendPrompt(sessionId, text),
		});
		cleanup.push(() => view.dispose());
		document.body.append(view.el);
		await settle();
		const strip = view.el.querySelector<HTMLElement>(".composer-answer")!;
		const field = view.el.querySelector<HTMLTextAreaElement>(".composer-input")!;
		expect(strip.hidden).toBe(true);
		f.controller.conversation(thread.sessionId).set({ answering: "Who first?" });
		await settle();
		expect(strip.hidden).toBe(false);
		expect(strip.textContent).toContain("Answering");
		expect(strip.textContent).toContain("Who first?");
		expect(field.placeholder).toBe("Your answer…");
		field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await settle();
		expect(strip.hidden).toBe(true);
		expect(f.controller.conversation(thread.sessionId).get().answering).toBeUndefined();
		expect(field.placeholder).toBe("Message…");
	});

	it("in an agent's thread, gives live controls only on the cards raised for this member", async () => {
		const f = company();
		f.controller.store.set({ loading: false, sessions: [thread] });
		vi.mocked(f.api.readSessionEvents).mockResolvedValue([card(1, userA.id), card(2, userB.id)]);
		void f.controller.loadConversation(thread.sessionId);
		const view = new ConversationView(f.controller, thread.sessionId, {
			sendMessage: (sessionId, text) => f.controller.sendPrompt(sessionId, text),
		});
		cleanup.push(() => view.dispose());
		document.body.append(view.el);
		await settle();
		const cards = [...view.el.querySelectorAll<HTMLElement>(".interaction-card")];
		expect(cards).toHaveLength(2);
		expect(cards[0]!.querySelector("button")).not.toBeNull();
		expect(cards[1]!.querySelector("button")).toBeNull();
	});
	describe("the address card", () => {
		const mailbox = (local: string, status: "active" | "paused" = "active", n = 0) => ({
			schema: "qorpera.event-hook/v1",
			id: id(700 + n),
			name: `mail-${local}`,
			purpose: local,
			proof: "mail",
			status,
			email: `${local}@inbox.qorpera.com`,
			createdAt: "2026-11-17T10:00:00Z",
		});
		function mail(f: ReturnType<typeof company>, existing: Record<string, unknown>[] = []) {
			const hooks: Record<string, unknown>[] = [...existing];
			const calls: { name: string; args: Record<string, unknown> }[] = [];
			const base = vi.mocked(f.cloud.rpc).getMockImplementation();
			vi.mocked(f.cloud.rpc).mockImplementation(async (name: string, args: Record<string, unknown> = {}) => {
				calls.push({ name, args });
				if (name === "qorpera_list_event_hooks") return hooks;
				if (name === "qorpera_create_company_mailbox") {
					const made = mailbox(String(args.p_local_part), "active", hooks.length + 1);
					hooks.push(made);
					return made;
				}
				if (name === "qorpera_set_event_hook_status") {
					for (const hook of hooks) if (hook.id === args.p_hook_id) hook.status = args.p_status;
					return null;
				}
				if (name === "qorpera_company_mail_handles") return { domain: "inbox.qorpera.com", handles: [] };
				if (name === "qorpera_company_mail_handle_status") return "free";
				return base?.(name, args);
			});
			const named = (rpc: string) => calls.filter((call) => call.name === rpc).map((call) => call.args);
			return { hooks, named };
		}

		it("makes hello.<handle> as the member, then answers the card with its address", async () => {
			const f = company();
			f.controller.store.set({ sessions: [thread] });
			const { named } = mail(f);
			const answer = vi.spyOn(f.api, "answerInteraction").mockResolvedValue(answered);
			await f.controller.chooseMailAddress(thread.sessionId, id(593), "lerhave");
			expect(named("qorpera_create_company_mailbox")).toEqual([
				{
					p_profile_id: profileA.profileId,
					p_environment_id: profileA.environmentId,
					p_local_part: "hello.lerhave",
					p_purpose: "The company's main email",
				},
			]);
			expect(answer).toHaveBeenCalledOnce();
			expect(answer.mock.calls[0]!.slice(2, 5)).toEqual([
				id(593),
				"answered",
				{ values: ["hello.lerhave@inbox.qorpera.com"] },
			]);
		});

		it("uses an address the company has already, resuming it when it is paused, and makes none twice", async () => {
			const f = company();
			f.controller.store.set({ sessions: [thread] });
			const { named } = mail(f, [mailbox("hello.lerhave", "paused")]);
			const answer = vi
				.spyOn(f.api, "answerInteraction")
				.mockRejectedValueOnce(new Error("Network unavailable"))
				.mockResolvedValue(answered);
			await expect(f.controller.chooseMailAddress(thread.sessionId, id(593), "lerhave")).rejects.toThrow(
				"Network unavailable",
			);
			expect(named("qorpera_set_event_hook_status")).toEqual([{ p_hook_id: id(700), p_status: "active" }]);
			await f.controller.chooseMailAddress(thread.sessionId, id(593), "lerhave");
			expect(named("qorpera_create_company_mailbox")).toEqual([]);
			expect(named("qorpera_set_event_hook_status")).toHaveLength(1);
			expect(answer).toHaveBeenCalledTimes(2);
			expect(answer.mock.calls[1]![4]).toEqual({ values: ["hello.lerhave@inbox.qorpera.com"] });
		});

		it("answers once when the address is made but the answer fails, and the retry makes no second one", async () => {
			const f = company();
			f.controller.store.set({ sessions: [thread] });
			const { named } = mail(f);
			vi.spyOn(f.api, "answerInteraction")
				.mockRejectedValueOnce(new Error("Network unavailable"))
				.mockResolvedValue(answered);
			await expect(f.controller.chooseMailAddress(thread.sessionId, id(593), "lerhave")).rejects.toThrow();
			await f.controller.chooseMailAddress(thread.sessionId, id(593), "lerhave");
			expect(named("qorpera_create_company_mailbox")).toHaveLength(1);
		});

		it("says why in plain words when the cloud refuses the address, and answers nothing", async () => {
			const f = company();
			f.controller.store.set({ sessions: [thread] });
			vi.mocked(f.cloud.rpc).mockImplementation(async (name: string) => {
				if (name === "qorpera_list_event_hooks") return [];
				throw new CloudRpcError(name, { code: "23505", message: "This address is taken" }, 409);
			});
			const answer = vi.spyOn(f.api, "answerInteraction");
			await expect(f.controller.chooseMailAddress(thread.sessionId, id(593), "brooks")).rejects.toThrow(
				"This address is taken.",
			);
			expect(answer).not.toHaveBeenCalled();
		});

		it("is drawn in the thread for the member it waits for, and follows their role", async () => {
			const f = company();
			f.controller.store.set({ loading: false, sessions: [thread] });
			mail(f);
			const request = card(1, userA.id);
			const entry = (request.body as unknown as { entry: { data: Record<string, unknown> } }).entry;
			entry.data = {
				...entry.data,
				title: "Your company's email address",
				payload: {
					allowCustom: true,
					input: { kind: "mail_address" },
					options: [{ label: "lerhave", value: "lerhave" }],
				},
			};
			vi.mocked(f.api.readSessionEvents).mockResolvedValue([request, card(2, userB.id)]);
			void f.controller.loadConversation(thread.sessionId);
			const view = new ConversationView(f.controller, thread.sessionId, {
				sendMessage: (sessionId, text) => f.controller.sendPrompt(sessionId, text),
			});
			cleanup.push(() => view.dispose());
			document.body.append(view.el);
			await settle();
			const field = () => view.el.querySelector<HTMLInputElement>(".interaction-address-handle");
			expect(field()?.value).toBe("lerhave");
			expect(field()?.disabled).toBe(false);
			expect(view.el.querySelectorAll(".interaction-address")).toHaveLength(1);
			f.controller.store.set({ team: { ...team, role: "contributor" } });
			await settle();
			expect(field()?.disabled).toBe(true);
			expect(view.el.querySelector(".interaction-address-check")?.textContent).toBe(
				"Only founders and admins can choose the address",
			);
		});
	});
});

describe("conversation lifecycle regressions", () => {
	it("requires explicit sponsorship", async () => {
		const f = fixture();
		const controller = new CompanyController(f.api, profileA, userA.id);
		cleanup.push(() => controller.stop());
		controller.store.set({ team, sessions: [session] });
		expect(await controller.sendPrompt(session.sessionId, "Draft")).toBe(false);
		controller.setExecutionSponsor(session.sessionId, connections, id(80));
		expect(await controller.sendPrompt(session.sessionId, "Draft")).toBe(false);
		expect(controller.conversation(session.sessionId).get().draft).toBe("Draft");
	});
	it.each(["revoked", "reauthentication", "disabled", "planned", "identity", "binding"])(
		"rejects unavailable observed sponsorship: %s",
		(reason) => {
			const { controller } = company();
			const observed = structuredClone(connections);
			const connection = observed.connections[0]!;
			if (reason === "revoked") connection.connectionStatus = "revoked";
			if (reason === "reauthentication") connection.authorizationState = "reauthentication_required";
			if (reason === "disabled") connection.policy.enablementStatus = "disabled";
			if (reason === "planned") connection.policy.implementationStatus = "planned";
			if (reason === "identity") observed.computeIdentity!.ownerUserId = id(99);
			if (reason === "binding") connection.sponsorVersion = undefined;
			expect(() => controller.setExecutionSponsor(session.sessionId, observed, id(80))).toThrow("unavailable");
		},
	);
	it("opens a message with the line its draft answers, the same on a retry, and only that message", async () => {
		const { controller, write } = company();
		write.mockRejectedValueOnce(new Error("Lost response"));
		const state = controller.conversation(session.sessionId, false);
		state.set({ answering: "Who first?" });
		expect(await controller.sendPrompt(session.sessionId, "  ")).toBe(false);
		expect(write).not.toHaveBeenCalled();
		expect(await controller.sendPrompt(session.sessionId, "Young couples")).toBe(false);
		expect(state.get().answering).toBe("Who first?");
		expect(await controller.sendPrompt(session.sessionId, "Young couples")).toBe(true);
		expect(write.mock.calls[1]![1]).toBe(write.mock.calls[0]![1]);
		expect(write.mock.calls[0]![2]).toBe("> Who first?\n\nYoung couples");
		expect(write.mock.calls[1]![2]).toBe("> Who first?\n\nYoung couples");
		expect(state.get().answering).toBeUndefined();
		expect(await controller.sendPrompt(session.sessionId, "Thanks")).toBe(true);
		expect(write.mock.calls[2]![2]).toBe("Thanks");
	});
	it("retains the exact sponsor, IDs and files on retry after newer discovery and another choice", async () => {
		const { controller, write } = company();
		write.mockRejectedValueOnce(new Error("Lost response"));
		const file = new File(["bytes"], "image.png", { type: "image/png" });
		const state = controller.conversation(session.sessionId, false);
		state.set({ attachments: [file] });
		expect(await controller.sendPrompt(session.sessionId, "Draft")).toBe(false);
		const retained = state.get().retrySend!;
		const updated = structuredClone(connections);
		updated.connections[0]!.sponsorVersion = 2;
		updated.connections[0]!.sponsorBindingId = id(83);
		controller.setExecutionSponsor(session.sessionId, updated, id(80));
		expect(await controller.sendPrompt(session.sessionId, "Draft")).toBe(true);
		expect(write.mock.calls[1]![1]).toBe(retained.clientInputId);
		expect(retained.clientRequestId).toBe(retained.clientInputId);
		expect(write.mock.calls[1]![5]).toEqual(write.mock.calls[0]![5]);
		expect(write.mock.calls[1]![5]?.sponsorVersion).toBe(1);
		expect(write.mock.calls[1]![4]?.[0]).toBe(file);
		expect(state.get().retrySend).toBeUndefined();
	});
	it.each(["draft", "replacement image", "removed image"])(
		"requires explicit abandonment after changing the %s of an uncertain send",
		async (change) => {
			const { controller, write } = company();
			write.mockRejectedValueOnce(new Error("Lost response"));
			const original = new File(["original"], "image.png", { type: "image/png" });
			const state = controller.conversation(session.sessionId, false);
			state.set({ attachments: [original] });
			expect(await controller.sendPrompt(session.sessionId, "Original")).toBe(false);
			const retained = state.get().retrySend!;
			const draft = change === "draft" ? "Edited" : "Original";
			const files =
				change === "removed image"
					? []
					: change === "replacement image"
						? [new File(["replacement"], "image.png", { type: "image/png" })]
						: [original];
			state.set({ draft, attachments: files });
			expect(await controller.sendPrompt(session.sessionId, draft)).toBe(false);
			expect(write).toHaveBeenCalledTimes(1);
			expect(state.get().retrySend).toBe(retained);
			expect(retained.files[0]).toBe(original);
			expect(retained.executionSponsor).toEqual(write.mock.calls[0]![5]);
			expect(state.get()).toMatchObject({ draft, attachments: files });
			controller.discardSendRetry(session.sessionId);
			expect(state.get()).toMatchObject({ draft, attachments: files });
			expect(await controller.sendPrompt(session.sessionId, draft)).toBe(true);
			expect(write.mock.calls[1]![1]).not.toBe(retained.clientInputId);
			expect(write.mock.calls[1]![4]).toEqual(files);
		},
	);
	it("only explicit abandonment releases a failed replay while preserving the edited draft and files", async () => {
		const { controller, write } = company();
		write.mockRejectedValueOnce(new Error("Sponsor revoked"));
		const file = new File(["bytes"], "image.png", { type: "image/png" });
		const state = controller.conversation(session.sessionId, false);
		state.set({ attachments: [file] });
		expect(await controller.sendPrompt(session.sessionId, "Original draft")).toBe(false);
		const failedId = state.get().retrySend!.clientInputId;
		state.set({ draft: "Edited draft" });
		controller.discardSendRetry(session.sessionId);
		expect(state.get()).toMatchObject({ draft: "Edited draft", attachments: [file] });
		expect(state.get().retrySend).toBeUndefined();
		expect(state.get().sendError).toBeUndefined();
		expect(write).toHaveBeenCalledTimes(1);
		const updated = structuredClone(connections);
		updated.connections[0]!.sponsorVersion = 2;
		controller.setExecutionSponsor(session.sessionId, updated, id(80));
		expect(await controller.sendPrompt(session.sessionId, "Edited draft")).toBe(true);
		expect(write.mock.calls[1]![1]).not.toBe(failedId);
		expect(write.mock.calls[1]![5]?.sponsorVersion).toBe(2);
		expect(write.mock.calls[1]![4]?.[0]).toBe(file);
	});
	it("refuses abandoning replay during submission or after losing session write authority", () => {
		const { controller } = company();
		const state = controller.conversation(session.sessionId, false);
		state.set({ sending: true });
		expect(() => controller.discardSendRetry(session.sessionId)).toThrow("Wait");
		state.set({ sending: false });
		controller.store.set({ sessions: [] });
		expect(() => controller.discardSendRetry(session.sessionId)).toThrow("not available");
	});
	it("refuses a write from an already closed view", async () => {
		const { controller, write } = company();
		controller.store.set({ team, sessions: [session], loading: false });
		const view = new AbortController();
		view.abort();
		expect(await controller.sendPrompt(session.sessionId, "Draft", view.signal)).toBe(false);
		expect(write).not.toHaveBeenCalled();
	});
	it("preserves the request identity after the view closes with an uncertain send", async () => {
		const { controller, write } = company();
		controller.store.set({ team, sessions: [session], loading: false });
		const view = new AbortController(),
			response = deferred<SessionTurnRequestResult>();
		const append = write.mockReturnValueOnce(response.promise).mockResolvedValue(receipt);
		const sending = controller.sendPrompt(session.sessionId, "Draft", view.signal);
		view.abort();
		response.resolve(receipt);
		expect(await sending).toBe(false);
		expect(controller.conversation(session.sessionId).get().sending).toBe(false);
		expect(controller.conversation(session.sessionId).get().draft).toBe("Draft");
		await controller.sendPrompt(session.sessionId, "Draft");
		expect(append.mock.calls[1]?.[1]).toBe(append.mock.calls[0]?.[1]);
	});
	it("refuses writes to unknown or closed conversations", async () => {
		const { controller, write } = company();
		controller.store.set({ team, sessions: [] });
		expect(await controller.sendPrompt(session.sessionId, "Draft")).toBe(false);
		controller.store.set({ sessions: [{ ...session, status: "closed" }] });
		expect(await controller.sendPrompt(session.sessionId, "Draft")).toBe(false);
		expect(write).not.toHaveBeenCalled();
	});
	it("does not let an older roster response overwrite the current roster", async () => {
		const { api, controller } = company();
		const old = deferred<(typeof staff)[]>();
		vi.mocked(api.listStaff)
			.mockReturnValueOnce(old.promise)
			.mockResolvedValueOnce([{ ...staff, displayName: "Current name" }]);
		const first = controller.refreshStaff();
		await controller.refreshStaff();
		old.resolve([staff]);
		await first;
		expect(controller.store.get().staff[0]?.displayName).toBe("Current name");
	});
	it("renders asynchronous reads and failed sends, preserving the draft and retry ID", async () => {
		const { api, controller, write } = company();
		const read = deferred<HostedSessionEvent[]>();
		vi.mocked(api.readSessionEvents).mockReturnValueOnce(read.promise);
		const append = write.mockRejectedValue(new Error("Fixture write failed"));
		controller.store.set({ loading: false, team, sessions: [session] });
		// This fixture supplies the explicit sponsored writer.
		void controller.loadConversation(session.sessionId);
		const view = new ConversationView(controller, session.sessionId, {
			sendMessage: (id, text) => controller.sendPrompt(id, text),
		});
		cleanup.push(() => view.dispose());
		document.body.append(view.el);
		read.resolve([event(1, "New public message")]);
		await settle();
		expect(view.el.textContent).toContain("New public message");
		const input = view.el.querySelector("textarea")!;
		input.value = "Important unsent draft";
		input.dispatchEvent(new Event("input"));
		await settle();
		view.el.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click();
		await settle();
		expect(view.el.textContent).toContain("Fixture write failed");
		expect(input.value).toBe("Important unsent draft");
		expect(view.el.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.disabled).toBe(false);
		await controller.sendPrompt(session.sessionId, input.value);
		expect(append.mock.calls[0]?.[1]).toBe(append.mock.calls[1]?.[1]);
	});

	it("reconciles the browser operation with the server input ID exactly once", async () => {
		const { api, controller } = company();
		controller.store.set({ loading: false, team, sessions: [session] });
		controller.conversation(session.sessionId, false);
		vi.mocked(api.listSessionInputs).mockResolvedValue({
			items: [pending(1, "One message")],
			hasMore: false,
			nextAfterPosition: 1,
		});

		await controller.sendPrompt(session.sessionId, "One message");
		const state = controller.conversation(session.sessionId).get();
		expect(state.optimistic).toEqual([]);
		expect(state.projection.items).toHaveLength(1);
		expect(state.sending).toBe(false);
		expect(state.draft).toBe("");
	});

	it("serializes reloads and resumes from the latest canonical sequence", async () => {
		const { api, controller } = company();
		controller.conversation(session.sessionId, false);
		const first = deferred<HostedSessionEvent[]>();
		const second = deferred<HostedSessionEvent[]>();
		vi.mocked(api.readSessionEvents).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const load = controller.loadConversation(session.sessionId);
		const reload = controller.loadConversation(session.sessionId);
		// This cloud has no newest-first read: the first load reads forward once it has said so.
		await settle();
		expect(api.readSessionEvents).toHaveBeenCalledTimes(1);
		first.resolve([event(1)]);
		await settle();
		expect(api.readSessionEvents).toHaveBeenNthCalledWith(2, session.sessionId, 1, 500, controller.signal);
		second.resolve([event(2)]);
		await Promise.all([load, reload]);
		expect(controller.conversation(session.sessionId).get().projection.lastSequence).toBe(2);
		expect(controller.conversation(session.sessionId).get().events).toHaveLength(2);
	});

	it("reads all pending input pages before marking the transcript complete", async () => {
		const { api, controller } = company();
		vi.mocked(api.listSessionInputs).mockImplementation(async (_id, after) =>
			after === 0
				? { items: Array.from({ length: 100 }, (_, i) => pending(i + 1)), hasMore: true, nextAfterPosition: 100 }
				: { items: [pending(101)], hasMore: false, nextAfterPosition: 101 },
		);
		controller.conversation(session.sessionId, false);
		await controller.loadConversation(session.sessionId);
		const state = controller.conversation(session.sessionId).get();
		expect(state.pending).toHaveLength(101);
		expect(state.projection.items).toHaveLength(101);
		expect(state.complete).toBe(true);
		expect(api.listSessionInputs).toHaveBeenNthCalledWith(2, session.sessionId, 100, 100, controller.signal);
	});

	it("reads the history, the waiting inputs and the coding sessions side by side and draws once", async () => {
		const { api, controller } = company();
		const history = Array.from({ length: 501 }, (_, index) => event(index + 1));
		const firstPage = deferred<HostedSessionEvent[]>();
		const lastPage = deferred<HostedSessionEvent[]>();
		const inputs = deferred<Awaited<ReturnType<typeof api.listSessionInputs>>>();
		const coding = deferred<Awaited<ReturnType<typeof api.listCodingSessions>>>();
		vi.mocked(api.readSessionEvents).mockReturnValueOnce(firstPage.promise).mockReturnValueOnce(lastPage.promise);
		vi.mocked(api.listSessionInputs).mockReturnValueOnce(inputs.promise);
		vi.mocked(api.listCodingSessions).mockReturnValueOnce(coding.promise);
		const store = controller.conversation(session.sessionId, false);
		await settle();
		const drawn: number[] = [];
		store.subscribe((state) => drawn.push(state.projection.items.length));
		const load = controller.loadConversation(session.sessionId);
		// None of the three waits for another (the forward read once the newest-first read is known missing).
		await settle();
		expect(api.readSessionEvents).toHaveBeenCalledTimes(1);
		expect(api.listSessionInputs).toHaveBeenCalledTimes(1);
		expect(api.listCodingSessions).toHaveBeenCalledTimes(1);
		inputs.resolve({ items: [pending(900, "Still waiting")], hasMore: false, nextAfterPosition: 900 });
		coding.resolve([]);
		firstPage.resolve(history.slice(0, 500));
		await settle();
		// The next page follows the first; nothing is drawn halfway through the history.
		expect(api.readSessionEvents).toHaveBeenNthCalledWith(2, session.sessionId, 500, 500, controller.signal);
		expect(drawn).toEqual([]);
		lastPage.resolve(history.slice(500));
		await load;
		await settle();
		expect(drawn).toEqual([502]);
		expect(store.get()).toMatchObject({ loading: false, complete: true, codingSessions: [] });
		expect(store.get().events).toHaveLength(501);
	});

	it("keeps the history read before a page that failed, and resumes after it", async () => {
		const { api, controller } = company();
		const history = Array.from({ length: 500 }, (_, index) => event(index + 1));
		vi.mocked(api.readSessionEvents)
			.mockResolvedValueOnce(history)
			.mockRejectedValueOnce(new Error("Fixture page failed"))
			.mockResolvedValueOnce([event(501)]);
		const store = controller.conversation(session.sessionId, false);
		await controller.loadConversation(session.sessionId);
		expect(store.get()).toMatchObject({ complete: false, error: "Fixture page failed" });
		expect(store.get().events).toHaveLength(500);
		expect(store.get().projection.lastSequence).toBe(500);
		await controller.loadConversation(session.sessionId);
		expect(api.readSessionEvents).toHaveBeenLastCalledWith(session.sessionId, 500, 500, controller.signal);
		expect(store.get()).toMatchObject({ complete: true, error: undefined });
		expect(store.get().events).toHaveLength(501);
	});

	it("writes nothing and reads no further page when membership is revoked during a load", async () => {
		const { api, controller } = company();
		const page = deferred<HostedSessionEvent[]>();
		const inputs = deferred<Awaited<ReturnType<typeof api.listSessionInputs>>>();
		vi.mocked(api.readSessionEvents).mockReturnValueOnce(page.promise);
		vi.mocked(api.listSessionInputs).mockReturnValueOnce(inputs.promise);
		const store = controller.conversation(session.sessionId, false);
		const load = controller.loadConversation(session.sessionId);
		// Both reads are on their way when the membership goes.
		await settle();
		vi.mocked(api.getTeam).mockRejectedValue(new CloudRpcError("team", { code: "42501", message: "revoked" }, 403));
		await controller.refreshTeam();
		// Both would ask for another page.
		page.resolve(Array.from({ length: 500 }, (_, index) => event(index + 1, "Private data")));
		inputs.resolve({ items: [pending(1, "Private input")], hasMore: true, nextAfterPosition: 1 });
		await load;
		await settle();
		expect(controller.store.get().accessLost).toBe(true);
		expect(store.get().events).toEqual([]);
		expect(store.get().pending).toEqual([]);
		expect(store.get().projection.items).toEqual([]);
		expect(api.readSessionEvents).toHaveBeenCalledTimes(1);
		expect(api.listSessionInputs).toHaveBeenCalledTimes(1);
	});

	it("discards outstanding reads after membership is revoked", async () => {
		const { api, controller } = company();
		const read = deferred<HostedSessionEvent[]>();
		vi.mocked(api.readSessionEvents).mockReturnValueOnce(read.promise);
		const store = controller.conversation(session.sessionId);
		vi.mocked(api.getTeam).mockRejectedValue(new CloudRpcError("team", { code: "42501", message: "revoked" }, 403));
		await controller.refreshTeam();
		read.resolve([event(1, "Private data")]);
		await settle();
		expect(controller.store.get().accessLost).toBe(true);
		expect(store.get().events).toEqual([]);
		expect(api.listSessionInputs).not.toHaveBeenCalled();
	});
});

describe("company refresh regressions", () => {
	it("refreshes all company authorities when realtime is degraded", async () => {
		vi.useFakeTimers();
		const { api, controller } = company();
		await controller.start();
		await vi.advanceTimersByTimeAsync(30_000);
		for (const method of [api.getTeam, api.listStaff, api.listSessions, api.getOrganization, api.listStaffActivity])
			expect(vi.mocked(method).mock.calls.length).toBeGreaterThan(1);
	});
});

describe("agent execution state", () => {
	const row = (
		jobStatus: HostedStaffExecutionActivity["jobStatus"],
		activity: HostedStaffExecutionActivity["activity"],
	): HostedStaffExecutionActivity => ({
		runId: id(70),
		staffAgentId: staff.id,
		sourceKind: "session_turn",
		jobStatus,
		activity,
		updatedAt: "2026-09-19T00:00:00Z",
	});
	const recovery = (extra: Partial<HostedRunRecovery> = {}): HostedRunRecovery => ({
		runId: id(70),
		sourceKind: "session_turn",
		jobStatus: "failed",
		unsettledOperations: 0,
		...extra,
	});
	function controller() {
		const f = fixture();
		const company = new CompanyController(f.api, profileA, userA.id);
		cleanup.push(() => company.stop());
		return { ...f, company };
	}

	it("maps every activity row the server can send to what the member sees", () => {
		const { company } = controller();
		const state = (activity?: HostedStaffExecutionActivity, recoveries: Record<string, HostedRunRecovery> = {}) => {
			company.store.set({ activity: activity ? [activity] : [], recoveries });
			return company.agentState(staff.id);
		};
		expect(state()).toBe("idle");
		expect(state(row("queued", "waiting"))).toBe("working");
		expect(state(row("leased", "working"))).toBe("working");
		expect(state(row("completed", "needs_attention"))).toBe("decision");
		expect(state(row("failed", "needs_attention"))).toBe("failed");
		// A failed run that left Company File changes waits on a decision.
		expect(state(row("failed", "needs_attention"), { [id(70)]: recovery({ proposalId: id(71) }) })).toBe("decision");
		// A run a member stopped is never a failure. The cloud lists one only while the
		// Company File changes it left wait, so it is a decision until its details say
		// it left none; then it is settled (an older cloud still lists every stop).
		const stopped = (extra: Partial<HostedRunRecovery> = {}) => ({
			[id(70)]: recovery({ jobStatus: "cancelled", ...extra }),
		});
		expect(state(row("cancelled", "needs_attention"))).toBe("decision");
		expect(state(row("cancelled", "needs_attention"), stopped({ proposalId: id(71) }))).toBe("decision");
		expect(state(row("cancelled", "needs_attention"), stopped())).toBe("idle");
		expect(company.agentState(undefined)).toBe("idle");
	});

	it("never reads a run a member stopped as a failure, and never offers to repeat it", () => {
		const { company } = controller();
		const stopped = { ...row("cancelled", "needs_attention"), sourceKind: "room_delivery" as const };
		const details = recovery({
			sourceKind: "room_delivery",
			jobStatus: "cancelled",
			lastError: "Runner job was cancelled by a company member",
		});
		// An older cloud still lists the stop, ranked above the agent's other work.
		company.store.set({ team, activity: [stopped], recoveries: { [id(70)]: details } });
		expect(company.agentState(staff.id)).toBe("idle");
		expect(company.activityFor(staff.id)).toBeUndefined();
		expect(company.failedRunFor(staff.id)).toBeUndefined();
		// Try again is for failures: the same post, had it failed, could be tried again.
		expect(
			company.canRetryFailedRun({
				activity: { ...stopped, jobStatus: "failed" },
				recovery: { ...details, jobStatus: "failed" },
			}),
		).toBe(true);
		expect(company.canRetryFailedRun({ activity: stopped, recovery: details })).toBe(false);
		// A stop that left Company File changes asks for that decision, still without Try again.
		company.store.set({ recoveries: { [id(70)]: { ...details, proposalId: id(71) } } });
		expect(company.agentState(staff.id)).toBe("decision");
		const decision = company.failedRunFor(staff.id);
		expect(decision?.recovery?.proposalId).toBe(id(71));
		expect(company.canRetryFailedRun(decision!)).toBe(false);
		// Until its details arrive, a listed stop shows no line at all.
		company.store.set({ recoveries: {} });
		expect(company.agentState(staff.id)).toBe("decision");
		expect(company.failedRunFor(staff.id)).toBeUndefined();
	});

	it("never offers Try again for a run the cloud refuses to repeat", () => {
		const { company } = controller();
		company.store.set({ team });
		const failed = row("failed", "needs_attention");
		const post = { ...failed, sourceKind: "room_delivery" as const };
		const retry = (extra: Partial<HostedRunRecovery>, activity = failed) =>
			company.canRetryFailedRun({ activity, recovery: recovery({ sourceKind: activity.sourceKind, ...extra }) });
		expect(retry({})).toBe(true);
		expect(retry({}, post)).toBe(true);
		// Work that took effect (WB-001 hired an agent before it stopped), or may have, is never repeated.
		expect(retry({ durableOutcome: true })).toBe(false);
		expect(retry({ durableOutcome: true }, post)).toBe(false);
		// Only the member whose ChatGPT plan paid for a turn tries it again; a post runs on the account selected here.
		expect(retry({ paidByChatgptPlan: true, requestedByUserId: userA.id })).toBe(true);
		expect(retry({ paidByChatgptPlan: true, requestedByUserId: userB.id })).toBe(false);
		expect(retry({ paidByChatgptPlan: true })).toBe(false);
		expect(retry({ paidByChatgptPlan: false, requestedByUserId: userB.id })).toBe(true);
		expect(retry({ paidByChatgptPlan: true, requestedByUserId: userB.id }, post)).toBe(true);
	});

	it("acknowledges a stop an older cloud still lists, so the work it hid shows again", async () => {
		const { api, company } = controller();
		company.store.set({ team });
		const working = { ...row("leased", "working"), runId: id(72), sourceKind: "wake" as const };
		vi.spyOn(api, "getRunRecovery").mockResolvedValue(recovery({ jobStatus: "cancelled" }));
		// Acknowledged, the stop no longer outranks the routine run it hid.
		const acknowledge = vi.spyOn(api, "acknowledgeFailedRun").mockImplementation(async () => {
			vi.mocked(api.listStaffActivity).mockResolvedValue([working]);
		});
		vi.mocked(api.listStaffActivity).mockResolvedValue([row("cancelled", "needs_attention")]);
		await company.refreshActivity();
		await settle();
		expect(acknowledge).toHaveBeenCalledExactlyOnceWith(id(70));
		expect(company.agentState(staff.id)).toBe("working");
		expect(company.activityFor(staff.id)?.runId).toBe(id(72));
		await company.refreshActivity();
		await settle();
		expect(acknowledge).toHaveBeenCalledOnce();
	});

	it("leaves a stop's decision and a reader's company alone, and tries a refused acknowledgment again", async () => {
		const reader = controller();
		reader.company.store.set({ team: { ...team, capabilities: { ...team.capabilities, write: false } } });
		vi.spyOn(reader.api, "getRunRecovery").mockResolvedValue(recovery({ jobStatus: "cancelled" }));
		const readerAcknowledge = vi.spyOn(reader.api, "acknowledgeFailedRun").mockResolvedValue();
		vi.mocked(reader.api.listStaffActivity).mockResolvedValue([row("cancelled", "needs_attention")]);
		await reader.company.refreshActivity();
		await settle();
		// A reader writes nothing; the stop still reads as settled.
		expect(readerAcknowledge).not.toHaveBeenCalled();
		expect(reader.company.agentState(staff.id)).toBe("idle");
		const writer = controller();
		writer.company.store.set({ team });
		vi.spyOn(writer.api, "getRunRecovery").mockResolvedValue(
			recovery({ jobStatus: "cancelled", proposalId: id(71) }),
		);
		const acknowledge = vi.spyOn(writer.api, "acknowledgeFailedRun").mockRejectedValueOnce(new Error("offline"));
		vi.mocked(writer.api.listStaffActivity).mockResolvedValue([row("cancelled", "needs_attention")]);
		await writer.company.refreshActivity();
		await settle();
		// Its Company File changes wait for a decision, which acknowledging would not make.
		expect(acknowledge).not.toHaveBeenCalled();
		expect(writer.company.agentState(staff.id)).toBe("decision");
		// Decided: now it is a plain stop. The first acknowledgment does not reach the cloud.
		writer.company.store.set({ recoveries: { [id(70)]: recovery({ jobStatus: "cancelled" }) } });
		await writer.company.refreshActivity();
		await settle();
		expect(acknowledge).toHaveBeenCalledOnce();
		expect(writer.company.agentState(staff.id)).toBe("idle");
		acknowledge.mockResolvedValue();
		await writer.company.refreshActivity();
		await settle();
		expect(acknowledge).toHaveBeenCalledTimes(2);
		await writer.company.refreshActivity();
		await settle();
		expect(acknowledge).toHaveBeenCalledTimes(2);
	});

	// Recovery reads are timed with performance.now(), so the fake clock must drive it too.
	const fakeClock = () =>
		vi.useFakeTimers({
			toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
		});

	it("reads a plain failure once and forgets it once the server stops reporting it", async () => {
		fakeClock();
		const { api, company } = controller();
		const read = vi.spyOn(api, "getRunRecovery").mockResolvedValue(recovery({ lastError: "Provider failed" }));
		vi.mocked(api.listStaffActivity).mockResolvedValue([row("failed", "needs_attention")]);
		await company.refreshActivity();
		await settle();
		expect(read).toHaveBeenCalledWith(id(70));
		expect(company.agentState(staff.id)).toBe("failed");
		expect(company.failedRunFor(staff.id)?.recovery?.lastError).toBe("Provider failed");
		// A plain failure changes only by being dismissed, so it is not read again.
		vi.advanceTimersByTime(120_000);
		await company.refreshActivity();
		await settle();
		expect(read).toHaveBeenCalledTimes(1);
		vi.mocked(api.listStaffActivity).mockResolvedValue([]);
		await company.refreshActivity();
		expect(company.agentState(staff.id)).toBe("idle");
		expect(company.store.get().recoveries).toEqual({});
	});

	it("rereads a run waiting on a proposal, at once after a Company File change, without redundant redraws", async () => {
		fakeClock();
		const { api, company, hints } = controller();
		const read = vi.spyOn(api, "getRunRecovery").mockResolvedValue(recovery({ proposalId: id(71) }));
		vi.mocked(api.listStaffActivity).mockResolvedValue([row("failed", "needs_attention")]);
		await company.start();
		await settle();
		expect(company.agentState(staff.id)).toBe("decision");
		// WHY: Unchanged activity and recovery responses emit zero store notifications.
		let notices = 0;
		company.store.subscribe(() => notices++);
		vi.advanceTimersByTime(25_000);
		await company.refreshActivity();
		await settle();
		expect(read).toHaveBeenCalledTimes(2);
		expect(notices).toBe(0);
		// Accepting the proposal moves the Company File head; the run is read again right away.
		read.mockResolvedValue(recovery());
		hints.get("qorpera_company_files")!();
		await settle();
		expect(read).toHaveBeenCalledTimes(3);
		expect(company.agentState(staff.id)).toBe("failed");
	});

	it("retries a failed read soon and stops asking a cloud without the RPC", async () => {
		fakeClock();
		const { api, company } = controller();
		const read = vi
			.spyOn(api, "getRunRecovery")
			.mockRejectedValueOnce(new Error("Network error"))
			.mockResolvedValue(recovery());
		vi.mocked(api.listStaffActivity).mockResolvedValue([row("failed", "needs_attention")]);
		await company.refreshActivity();
		await settle();
		expect(company.failedRunFor(staff.id)?.recovery).toBeUndefined();
		vi.advanceTimersByTime(5_000);
		await company.refreshActivity();
		await settle();
		expect(read).toHaveBeenCalledTimes(2);
		expect(company.failedRunFor(staff.id)?.recovery).toEqual(recovery());
		const other = controller();
		const missing = vi
			.spyOn(other.api, "getRunRecovery")
			.mockRejectedValue(
				new CloudRpcError("qorpera_get_execution_run_recovery", { message: "Missing", code: "PGRST202" }, 404),
			);
		vi.mocked(other.api.listStaffActivity).mockResolvedValue([row("failed", "needs_attention")]);
		await other.company.refreshActivity();
		await settle();
		vi.advanceTimersByTime(60_000);
		await other.company.refreshActivity();
		await settle();
		expect(missing).toHaveBeenCalledTimes(1);
		expect(other.company.agentState(staff.id)).toBe("failed");
	});

	it("falls back to discard when the cloud cannot acknowledge, and keeps an open proposal as a decision", async () => {
		const { api, company } = controller();
		const first = deferred<HostedRunRecovery>();
		const read = vi
			.spyOn(api, "getRunRecovery")
			.mockReturnValueOnce(first.promise)
			.mockResolvedValueOnce(recovery({ proposalId: id(71) }));
		const acknowledge = vi
			.spyOn(api, "acknowledgeFailedRun")
			.mockRejectedValue(
				new CloudRpcError(
					"qorpera_resolve_failed_execution_run",
					{ message: "execution recovery action is unavailable", code: "55000" },
					400,
				),
			);
		const discard = vi
			.spyOn(api, "discardFailedRun")
			.mockRejectedValue(new Error("execution recovery still has an unresolved durable outcome"));
		vi.mocked(api.listStaffActivity).mockResolvedValue([row("failed", "needs_attention")]);
		await company.refreshActivity();
		await expect(company.dismissFailedRun(id(70))).resolves.toBeUndefined();
		await settle();
		expect(acknowledge).toHaveBeenCalledExactlyOnceWith(id(70));
		expect(discard).toHaveBeenCalledExactlyOnceWith(id(70));
		expect(read).toHaveBeenCalledTimes(2);
		// Dismissed, but the run left an open proposal: that decision is still the member's.
		expect(company.agentState(staff.id)).toBe("decision");
		// The first read answers last and must not undo the newer one.
		first.resolve(recovery());
		await settle();
		expect(company.agentState(staff.id)).toBe("decision");
	});

	// A stop already reads as settled, but an older cloud still ranks it above the
	// new message's run, so sending dismisses it the same way.
	it.each([
		["failed", "failed"],
		["cancelled", "idle"],
	] as const)("dismisses the agent's %s run when the member sends a new message", async (jobStatus, before) => {
		const { api, controller, write } = company();
		// The thread belongs to the agent whose run failed.
		controller.store.set({ sessions: [{ ...session, staffAgentId: staff.id }] });
		const read = vi.spyOn(api, "getRunRecovery").mockResolvedValue(recovery({ jobStatus }));
		const acknowledge = vi.spyOn(api, "acknowledgeFailedRun").mockResolvedValue();
		vi.mocked(api.listStaffActivity).mockResolvedValue([row(jobStatus, "needs_attention")]);
		await controller.refreshActivity();
		await settle();
		expect(controller.agentState(staff.id)).toBe(before);
		expect(read).toHaveBeenCalledTimes(1);
		vi.mocked(api.listStaffActivity).mockResolvedValue([]);
		expect(await controller.sendPrompt(session.sessionId, "Once more, please.")).toBe(true);
		await settle();
		expect(write).toHaveBeenCalledTimes(1);
		expect(acknowledge).toHaveBeenCalledExactlyOnceWith(id(70));
		// The send's own activity read covers the dismissal: no second read of the run.
		expect(read).toHaveBeenCalledTimes(1);
		expect(controller.agentState(staff.id)).toBe("idle");
	});

	it("shows the failure again when the cloud refuses the acknowledgment outright", async () => {
		const { api, company } = controller();
		vi.spyOn(api, "getRunRecovery").mockResolvedValue(recovery());
		const acknowledge = vi
			.spyOn(api, "acknowledgeFailedRun")
			.mockRejectedValue(
				new CloudRpcError("qorpera_resolve_failed_execution_run", { message: "denied", code: "42501" }, 403),
			);
		const discard = vi.spyOn(api, "discardFailedRun");
		vi.mocked(api.listStaffActivity).mockResolvedValue([row("failed", "needs_attention")]);
		await company.refreshActivity();
		await settle();
		await expect(company.dismissFailedRun(id(70))).rejects.toThrow("denied");
		await settle();
		expect(acknowledge).toHaveBeenCalledExactlyOnceWith(id(70));
		expect(discard).not.toHaveBeenCalled();
		// Not settled anywhere: the run stands in for the agent again.
		expect(company.agentState(staff.id)).toBe("failed");
		expect(company.failedRunFor(staff.id)?.activity.runId).toBe(id(70));
	});

	it("keeps a failed run whose details cannot be read, and dismisses it durably", async () => {
		const { api, company } = controller();
		vi.spyOn(api, "getRunRecovery").mockRejectedValue(new Error("execution recovery is unavailable"));
		const acknowledge = vi.spyOn(api, "acknowledgeFailedRun").mockResolvedValue();
		const discard = vi.spyOn(api, "discardFailedRun");
		vi.mocked(api.listStaffActivity).mockResolvedValue([row("failed", "needs_attention")]);
		await company.refreshActivity();
		await settle();
		expect(company.agentState(staff.id)).toBe("failed");
		expect(company.failedRunFor(staff.id)).toEqual({ activity: row("failed", "needs_attention") });
		vi.mocked(api.listStaffActivity).mockResolvedValue([]);
		await company.dismissFailedRun(id(70));
		expect(acknowledge).toHaveBeenCalledWith(id(70));
		expect(discard).not.toHaveBeenCalled();
		expect(company.agentState(staff.id)).toBe("idle");
		expect(company.failedRunFor(staff.id)).toBeUndefined();
	});

	// Stale failure card, 29 October 2026: a failure from before the agent's newer run (20260930542000).
	it("takes the agent's state from its newer work and shows the earlier failure apart", async () => {
		const { api, company } = controller();
		company.store.set({ team });
		const earlier = { ...row("failed", "needs_attention"), superseded: true as const };
		const newer = { ...row("leased", "working"), runId: id(72) };
		const details = recovery({ lastError: "Provider failed" });
		const read = vi.spyOn(api, "getRunRecovery").mockResolvedValue(details);
		vi.mocked(api.listStaffActivity).mockResolvedValue([earlier, newer]);
		await company.refreshActivity();
		await settle();
		// Listed first and as new as the newer run: neither makes the failure the agent's state.
		expect(company.agentState(staff.id)).toBe("working");
		expect(company.activityFor(staff.id)?.runId).toBe(id(72));
		// Its details are read, and it keeps its card, as the earlier failure, with Try again as before.
		expect(read).toHaveBeenCalledExactlyOnceWith(id(70));
		expect(company.failedRunFor(staff.id)).toEqual({ activity: earlier, recovery: details, earlier: true });
		expect(company.canRetryFailedRun(company.failedRunFor(staff.id)!)).toBe(true);
		// A queued newer run is the agent's work as well.
		vi.mocked(api.listStaffActivity).mockResolvedValue([
			earlier,
			{ ...newer, jobStatus: "queued", activity: "waiting" },
		]);
		await company.refreshActivity();
		expect(company.agentState(staff.id)).toBe("working");
		// Done, it leaves no failed state behind.
		vi.mocked(api.listStaffActivity).mockResolvedValue([earlier]);
		await company.refreshActivity();
		await settle();
		expect(company.agentState(staff.id)).toBe("idle");
		expect(company.activityFor(staff.id)).toBeUndefined();
		expect(company.failedRunFor(staff.id)?.earlier).toBe(true);
		// Dismissed, it is gone for this member before the cloud's next read.
		const acknowledge = vi.spyOn(api, "acknowledgeFailedRun").mockResolvedValue();
		await company.dismissFailedRun(id(70), { refresh: false });
		expect(acknowledge).toHaveBeenCalledExactlyOnceWith(id(70));
		expect(company.failedRunFor(staff.id)).toBeUndefined();
		expect(company.agentState(staff.id)).toBe("idle");
	});

	it("still lets a failure that is the agent's state outrank its newer work, and shows that one", () => {
		const { company } = controller();
		const current = { ...row("failed", "needs_attention"), runId: id(72) };
		const earlier = { ...row("failed", "needs_attention"), superseded: true as const };
		company.store.set({ activity: [earlier, current] });
		expect(company.agentState(staff.id)).toBe("failed");
		expect(company.failedRunFor(staff.id)).toEqual({ activity: current });
		// Once the current one is dismissed, the earlier one is shown, without making the agent failed.
		company.store.set({ acknowledgedRuns: { [id(72)]: true } });
		expect(company.agentState(staff.id)).toBe("idle");
		expect(company.failedRunFor(staff.id)).toEqual({ activity: earlier, earlier: true });
		// An open proposal is still a decision first.
		company.store.set({
			acknowledgedRuns: {},
			recoveries: { [id(72)]: recovery({ runId: id(72), proposalId: id(71) }) },
		});
		expect(company.agentState(staff.id)).toBe("decision");
		expect(company.failedRunFor(staff.id)?.activity.runId).toBe(id(72));
		// The same failure without the key, from a cloud before 20260930542000, is the agent's state.
		company.store.set({ activity: [row("failed", "needs_attention")], recoveries: {} });
		expect(company.agentState(staff.id)).toBe("failed");
		expect(company.failedRunFor(staff.id)).toEqual({ activity: row("failed", "needs_attention") });
	});

	it("dismisses the agent's earlier failure when the member sends a new message", async () => {
		const { api, controller, write } = company();
		controller.store.set({ sessions: [{ ...session, staffAgentId: staff.id }] });
		const newer = { ...row("leased", "working"), runId: id(72) };
		vi.spyOn(api, "getRunRecovery").mockResolvedValue(recovery());
		const acknowledge = vi.spyOn(api, "acknowledgeFailedRun").mockResolvedValue();
		vi.mocked(api.listStaffActivity).mockResolvedValue([
			newer,
			{ ...row("failed", "needs_attention"), superseded: true },
		]);
		await controller.refreshActivity();
		await settle();
		expect(controller.agentState(staff.id)).toBe("working");
		vi.mocked(api.listStaffActivity).mockResolvedValue([newer]);
		expect(await controller.sendPrompt(session.sessionId, "Once more, please.")).toBe(true);
		await settle();
		expect(write).toHaveBeenCalledTimes(1);
		expect(acknowledge).toHaveBeenCalledExactlyOnceWith(id(70));
		expect(controller.agentState(staff.id)).toBe("working");
		expect(controller.failedRunFor(staff.id)).toBeUndefined();
	});

	it("skips no-op poll store updates, backs off failing app icon reads, and bounds cached conversations", async () => {
		const { api, controller } = company();
		controller.store.set({ loading: false, team, sessions: [session] });
		vi.mocked(api.readSessionEvents).mockResolvedValueOnce([event(1, "Hello")]);
		await controller.loadConversation(session.sessionId);
		const convStore = controller.conversation(session.sessionId, false);
		const firstProjection = convStore.get().projection;
		const firstEvents = convStore.get().events;
		let convNotifies = 0;
		const unsubConv = convStore.subscribe(() => {
			convNotifies += 1;
		});
		cleanup.push(unsubConv);

		vi.mocked(api.readSessionEvents).mockResolvedValueOnce([]);
		await controller.loadConversation(session.sessionId, { eventsOnly: true });
		vi.mocked(api.readSessionEvents).mockResolvedValueOnce([]);
		await controller.loadConversation(session.sessionId);
		await settle();
		expect(convNotifies).toBe(0);
		expect(convStore.get().projection).toBe(firstProjection);
		expect(convStore.get().events).toBe(firstEvents);

		const actRow = row("leased", "working");
		vi.mocked(api.listStaffActivity).mockResolvedValue([actRow]);
		await controller.refreshActivity();
		await settle();
		let companyNotifies = 0;
		const unsubCompany = controller.store.subscribe(() => {
			companyNotifies += 1;
		});
		cleanup.push(unsubCompany);
		await controller.refreshActivity();
		await settle();
		expect(companyNotifies).toBe(0);

		const iconReader = vi.fn(async () => {
			throw new Error("icons down");
		});
		controller.appIconReader = iconReader;
		await controller.loadAppIcons("trips");
		await controller.loadAppIcons("trips");
		expect(iconReader).toHaveBeenCalledTimes(1);
		await controller.loadAppIcons("trips", { force: true });
		expect(iconReader).toHaveBeenCalledTimes(2);
		controller.store.set({ appIcons: { trips: [] } });
		controller.refreshAppIcons();
		await settle();
		expect(iconReader).toHaveBeenCalledTimes(3);

		controller.setOpenSession(session.sessionId);
		const protectedIds = {
			draft: id(201),
			subscribed: id(202),
			loading: id(203),
			attachments: id(204),
			retrySend: id(205),
			interactionAnswers: id(206),
			interactionError: id(207),
			sendError: id(208),
			discardingProposals: id(209),
			earlierLoading: id(210),
			earlierError: id(211),
			quoteRecords: id(212),
			answering: id(213),
			sending: id(214),
			optimistic: id(215),
		};
		controller.conversation(protectedIds.draft, false).set({ draft: "keep me" });
		const unsubProtected = controller.conversation(protectedIds.subscribed, false).subscribe(() => {});
		cleanup.push(unsubProtected);
		controller.conversation(protectedIds.loading, false);
		const inflightGate = deferred<HostedSessionEvent[]>();
		vi.mocked(api.readSessionEvents).mockReturnValueOnce(inflightGate.promise);
		const inflightLoad = controller.loadConversation(protectedIds.loading);
		controller
			.conversation(protectedIds.attachments, false)
			.set({ attachments: [new File(["x"], "a.png", { type: "image/png" })] });
		controller.conversation(protectedIds.retrySend, false).set({
			retrySend: {
				clientInputId: id(301),
				clientRequestId: id(302),
				text: "",
				files: [],
				executionSponsor: {
					connectionId: id(80),
					provider: "openai",
					nativeHarness: "codex-cli",
					sponsorBindingId: id(81),
					sponsorVersion: 1,
					computeIdentityId: id(82),
					workerClass: "managed_sandbox",
				},
			},
		});
		controller.conversation(protectedIds.interactionAnswers, false).set({
			interactionAnswers: {
				[id(303)]: {
					outcome: "answered",
					answer: { values: ["yes"] },
					answeredBy: userA.id,
					answeredAt: "2026-09-05T10:00:00Z",
					pending: true,
				},
			},
		});
		controller.conversation(protectedIds.interactionError, false).set({ interactionError: "refused" });
		controller.conversation(protectedIds.sendError, false).set({ sendError: "offline" });
		controller.conversation(protectedIds.discardingProposals, false).set({ discardingProposals: [id(304)] });
		controller.conversation(protectedIds.earlierLoading, false).set({ earlierLoading: true });
		controller.conversation(protectedIds.earlierError, false).set({ earlierError: "timeout" });
		controller.conversation(protectedIds.quoteRecords, false).set({
			quoteRecords: [{ words: "hello", source: "Alice", ref: id(305) }],
		});
		controller.conversation(protectedIds.answering, false).set({ answering: "note line" });
		controller.conversation(protectedIds.sending, false).set({ sending: true });
		controller.conversation(protectedIds.optimistic, false).set({
			optimistic: [
				{
					clientInputId: id(306),
					text: "hi",
					createdAt: "2026-09-05T10:00:00Z",
					authorUserId: userA.id,
				},
			],
		});
		for (let i = 0; i < 30; i += 1) {
			controller.conversation(id(400 + i), false);
		}
		expect(controller.conversations.size).toBeLessThanOrEqual(25);
		expect(controller.conversations.has(session.sessionId)).toBe(true);
		for (const protectedId of Object.values(protectedIds)) {
			expect(controller.conversations.has(protectedId)).toBe(true);
		}
		inflightGate.resolve([]);
		await inflightLoad;

		for (let i = 0; i < 26; i += 1) {
			controller.conversation(id(500 + i), false).set({ draft: `keep ${i}` });
		}
		const freshId = id(599);
		const freshStore = controller.conversation(freshId, false);
		expect(controller.conversations.has(freshId)).toBe(true);
		let freshFired = 0;
		cleanup.push(
			freshStore.subscribe(() => {
				freshFired += 1;
			}),
		);
		freshStore.set({ complete: true });
		await settle();
		expect(freshFired).toBe(1);
	});

	it("clears read-back state on eviction and avoids conversation cache thrash when docks list many sessions", async () => {
		const { api, controller } = company();
		controller.store.set({ loading: false, team, staff: [staff], sessions: [session] });

		const evictableId = id(601);
		const tailEvents = Array.from({ length: 200 }, (_, i) => ({
			...event(201 + i, `Message ${201 + i}`),
			createdAt: new Date(Date.parse("2026-09-05T10:00:00Z") + (201 + i) * 60_000).toISOString(),
		}));
		const takenInput = {
			...pending(1, "Old taken"),
			createdAt: "2026-09-05T09:00:00Z",
			status: "processing" as const,
		};
		vi.mocked(api.readSessionEventsTail).mockImplementation(async (_sid, before) => {
			if (before === undefined) return tailEvents;
			return [];
		});
		vi.mocked(api.listSessionInputs).mockResolvedValue({
			items: [takenInput],
			hasMore: false,
			nextAfterPosition: 1,
		});
		controller.conversation(evictableId, false);
		await controller.loadConversation(evictableId);
		const callsAfterFirstLoad = vi.mocked(api.readSessionEventsTail).mock.calls.length;
		expect(callsAfterFirstLoad).toBe(2);

		for (let i = 0; i < 30; i += 1) {
			controller.conversation(id(620 + i), false);
		}
		expect(controller.conversations.has(evictableId)).toBe(false);

		vi.mocked(api.readSessionEventsTail).mockClear();
		controller.conversation(evictableId, false);
		await controller.loadConversation(evictableId);
		expect(vi.mocked(api.readSessionEventsTail).mock.calls.length).toBe(2);

		const existingCount = controller.conversations.size;
		const open = new OpenQuestions(controller, {
			listConnections: async () => ({ connections: [] }),
		} as never);
		const manyDecisions: OpenDecision[] = Array.from({ length: 35 }, (_, i) => ({
			kind: "question",
			interactionId: id(700 + i),
			sessionId: id(800 + i),
			staffAgentId: staff.id,
			actorUserId: userA.id,
			sequence: i + 1,
			request: {
				surface: "question",
				title: `Q ${i}`,
				payload: { options: [{ label: "A", value: "a", preview: "app:shop" }] },
			},
			createdAt: "2026-11-10T10:00:00Z",
		}));
		open.store.set({
			decisions: manyDecisions,
			questions: manyDecisions.filter((item) => item.kind === "question"),
			read: true,
			unavailable: false,
		});
		const dockHost: QuestionDockHost = {
			questions: open,
			agent: (agentId) => controller.staffById(agentId),
			memberName: () => "Alice",
			conversation: (sid) => controller.conversation(sid, false),
		};
		const decisionDock = new DecisionDock(dockHost);
		const questionDock = new QuestionDock(dockHost, (apps) => apps.has("shop"));
		cleanup.push(() => {
			decisionDock.dispose();
			questionDock.dispose();
		});
		expect(controller.conversations.size).toBeLessThanOrEqual(existingCount + 1);
		expect(controller.conversations.has(evictableId)).toBe(true);
		expect(controller.conversations.has(id(810))).toBe(false);
		expect(controller.conversations.has(id(834))).toBe(false);
	});

	it("forwards controller.signal to CloudApi reads so stop() aborts in-flight requests", async () => {
		const { api, controller } = company();
		controller.store.set({
			team,
			staff: [staff],
			sessions: [{ ...session, staffAgentId: staff.id }],
			loading: false,
		});
		const signals: (AbortSignal | undefined)[] = [];
		vi.spyOn(api, "getTeam").mockImplementation((_id, signal) => {
			signals.push(signal);
			return new Promise(() => {});
		});
		vi.spyOn(api, "listStaff").mockImplementation((_id, signal) => {
			signals.push(signal);
			return new Promise(() => {});
		});
		vi.spyOn(api, "getOrganization").mockImplementation((_id, signal) => {
			signals.push(signal);
			return new Promise(() => {});
		});
		vi.spyOn(api, "readCompanySidebar").mockImplementation((_id, signal) => {
			signals.push(signal);
			return new Promise(() => {});
		});
		vi.spyOn(api, "readMemberAppLayout").mockImplementation((_id, signal) => {
			signals.push(signal);
			return new Promise(() => {});
		});
		vi.spyOn(api, "listStaffActivity").mockImplementation((_id, signal) => {
			signals.push(signal);
			return new Promise(() => {});
		});
		vi.spyOn(api, "readSessionEventsTail").mockImplementation((_id, _before, _limit, signal) => {
			signals.push(signal);
			return new Promise((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
			});
		});
		vi.spyOn(api, "listSessionInputs").mockImplementation((_id, _after, _limit, signal) => {
			signals.push(signal);
			return new Promise(() => {});
		});
		vi.spyOn(api, "listCodingSessions").mockImplementation((_id, signal) => {
			signals.push(signal);
			return new Promise(() => {});
		});
		vi.spyOn(api, "listAgentProposals").mockImplementation((_env, _agent, signal) => {
			signals.push(signal);
			return new Promise(() => {});
		});
		vi.spyOn(api, "readSessionMemoryGeneration").mockImplementation((_id, signal) => {
			signals.push(signal);
			return new Promise(() => {});
		});
		vi.spyOn(api, "readCodingSession").mockImplementation((_worker, _after, _limit, signal) => {
			signals.push(signal);
			return new Promise(() => {});
		});
		vi.spyOn(api, "listCodingSessionLogins").mockImplementation((_worker, signal) => {
			signals.push(signal);
			return new Promise(() => {});
		});
		vi.spyOn(api, "listSecretConnections").mockImplementation((_profile, _env, signal) => {
			signals.push(signal);
			return new Promise(() => {});
		});

		void controller.refreshTeam();
		void controller.refreshStaff();
		void controller.refreshOrganization();
		void controller.refreshSidebar();
		void controller.refreshAppLayout();
		void controller.refreshActivity();
		const load = controller.loadConversation(session.sessionId);
		void controller.readCodingSession(id(901));
		void controller.listCodingSessionLogins(id(901));
		void controller.provideSecret(
			session.sessionId,
			id(902),
			{
				surface: "secret",
				title: "API key",
				payload: { name: "API_KEY", connectorId: "vault", purpose: "auth" },
			},
			"secret-value",
		);

		expect(signals).toHaveLength(14);
		for (const signal of signals) {
			expect(signal).toBe(controller.signal);
			expect(signal?.aborted).toBe(false);
		}
		controller.stop();
		await load;
		for (const signal of signals) expect(signal?.aborted).toBe(true);
		// WHY: Aborting loadConversation via stop() must not write an AbortError back into the cleared store.
		expect(controller.conversation(session.sessionId, false).get().error).toBeUndefined();
	});

	it("forwards controller.signal on sidebar reset app-layout reload and group-chat image capability check", async () => {
		const { api, controller } = company();
		const ownSidebar = {
			sections: [],
			placements: {},
			pinned: [],
			hidden: [],
			own: {
				changes: 1,
				moved: [],
				sections: [],
				pinned: 0,
				hidden: 0,
				contacts: 0,
				pages: 0,
				apps: 0,
				surfaces: 0,
			},
			groupChats: true,
		};
		controller.store.set({
			team,
			staff: [staff],
			sessions: [
				{
					...session,
					staffAgentId: undefined,
					executionScope: { roomId: id(903), groupChat: true },
				},
			],
			loading: false,
		});
		const sidebarSignals: (AbortSignal | undefined)[] = [];
		vi.spyOn(api, "readCompanySidebar").mockImplementation(async (_id, signal) => {
			sidebarSignals.push(signal);
			return ownSidebar;
		});
		const image = new File(["x"], "a.png", { type: "image/png" });
		controller.conversation(session.sessionId, false).set({ draft: "Look", attachments: [image] });
		await controller.sendPrompt(session.sessionId, "Look").catch(() => {});
		expect(sidebarSignals[0]).toBe(controller.signal);

		const layoutSignals: (AbortSignal | undefined)[] = [];
		vi.spyOn(api, "manageCompanySidebar").mockResolvedValue(ownSidebar);
		vi.spyOn(api, "readMemberAppLayout").mockImplementation(async (_id, signal) => {
			layoutSignals.push(signal);
			return {
				layout: { schema: "qorpera.member-app-layout/v1" as const, places: {}, groups: {} },
				updatedAt: "2026-09-05T10:00:00Z",
			};
		});
		controller.store.set({ sidebar: ownSidebar });
		await controller.resetSidebar();
		expect(layoutSignals).toContain(controller.signal);
	});
});
