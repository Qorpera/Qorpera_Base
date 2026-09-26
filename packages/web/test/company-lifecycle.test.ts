// @vitest-environment jsdom

import type {
	NativeExecutionConnections,
	SessionTurnRequestResult,
} from "@qorpera/cloud-client/cloud-native-subscription-control";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
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
});

describe("conversation lifecycle regressions", () => {
	it("requires explicit sponsorship and never falls back to ordinary append", async () => {
		const f = fixture();
		vi.spyOn(f.api, "appendPrompt");
		const controller = new CompanyController(f.api, profileA, userA.id);
		cleanup.push(() => controller.stop());
		controller.store.set({ team, sessions: [session] });
		expect(await controller.sendPrompt(session.sessionId, "Draft")).toBe(false);
		controller.setExecutionSponsor(session.sessionId, connections, id(80));
		expect(await controller.sendPrompt(session.sessionId, "Draft")).toBe(false);
		expect(f.api.appendPrompt).not.toHaveBeenCalled();
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
		const { controller } = company();
		controller.store.set({ team, sessions: [session], loading: false });
		const view = new AbortController();
		const write = vi.spyOn(controller, "assertCanSend");
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
		const { api, controller } = company();
		const append = vi.spyOn(api, "appendPrompt");
		controller.store.set({ team, sessions: [] });
		expect(await controller.sendPrompt(session.sessionId, "Draft")).toBe(false);
		controller.store.set({ sessions: [{ ...session, status: "closed" }] });
		expect(await controller.sendPrompt(session.sessionId, "Draft")).toBe(false);
		expect(append).not.toHaveBeenCalled();
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
		expect(api.readSessionEvents).toHaveBeenCalledTimes(1);
		first.resolve([event(1)]);
		await settle();
		expect(api.readSessionEvents).toHaveBeenNthCalledWith(2, session.sessionId, 1, 500);
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
		expect(api.listSessionInputs).toHaveBeenNthCalledWith(2, session.sessionId, 100, 100);
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
		// The same answer again causes no store notification beyond the activity read's own.
		let notices = 0;
		company.store.subscribe(() => notices++);
		vi.advanceTimersByTime(25_000);
		await company.refreshActivity();
		await settle();
		expect(read).toHaveBeenCalledTimes(2);
		expect(notices).toBe(1);
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
});
