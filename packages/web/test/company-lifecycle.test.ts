// @vitest-environment jsdom

import type {
	NativeExecutionConnections,
	SessionTurnRequestResult,
} from "@qorpera/cloud-client/cloud-native-subscription-control";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { ApprovalsView } from "../src/app/views/approvals.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import type { SessionInputWriter } from "../src/cloud/session-input.ts";
import type { HostedSessionEvent } from "../src/cloud/types.ts";
import { deferred, event, fixture, id, pending, profileA, session, settle, staff, team, userA } from "./fixtures.ts";

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
	it("refuses writes to unknown, closed or another member's private conversation", async () => {
		const { api, controller } = company();
		const append = vi.spyOn(api, "appendPrompt");
		controller.store.set({ team, sessions: [] });
		expect(await controller.sendPrompt(session.sessionId, "Draft")).toBe(false);
		controller.store.set({ sessions: [{ ...session, status: "closed" }] });
		expect(await controller.sendPrompt(session.sessionId, "Draft")).toBe(false);
		controller.store.set({ sessions: [{ ...session, audience: { kind: "member_private", userId: "other" } }] });
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

describe("approvals lifecycle regressions", () => {
	it("reports failure to discover sessions instead of an empty inbox", async () => {
		const { api, controller } = company();
		vi.mocked(api.listSessions).mockRejectedValue(new Error("Discovery unavailable"));
		await controller.refreshAll();
		const view = new ApprovalsView(controller);
		cleanup.push(() => view.dispose());
		await settle();
		expect(view.el.textContent).toContain("Approvals are incomplete");
		expect(view.el.textContent).not.toContain("Nothing is waiting");
	});
	it("scans sessions arriving after mount, then rescans when they change", async () => {
		const { api, controller } = company();
		vi.mocked(api.readSessionEvents).mockResolvedValueOnce([
			{ ...event(1), eventType: "authorization_request", body: { operation: "Publish" } },
		]);
		const view = new ApprovalsView(controller);
		cleanup.push(() => view.dispose());
		expect(view.el.textContent).not.toContain("Nothing is waiting");
		controller.store.set({ loading: false, sessions: [session] });
		await settle();
		expect(view.el.textContent).toContain("Waiting for a decision (1)");
		vi.mocked(api.readSessionEvents).mockResolvedValueOnce([
			{
				...event(2),
				eventType: "authorization_decision",
				body: { requestEventId: event(1).eventId, decision: "approved" },
			},
		]);
		controller.store.set({ sessions: [{ ...session, updatedAt: "2026-09-05T11:00:00Z" }] });
		await settle();
		expect(view.el.textContent).toContain("Waiting for a decision (0)");
		expect(api.readSessionEvents).toHaveBeenCalledTimes(2);
	});

	it("reports failed scans and retries explicitly without a request loop", async () => {
		const { api, controller } = company();
		controller.store.set({ loading: false, sessions: [session] });
		vi.mocked(api.readSessionEvents).mockRejectedValue(new Error("Permission check unavailable"));
		const view = new ApprovalsView(controller);
		cleanup.push(() => view.dispose());
		await settle();
		expect(view.el.textContent).toContain("Approvals are incomplete");
		expect(view.el.textContent).not.toContain("Nothing is waiting");
		controller.store.set({ activity: [] });
		await settle();
		expect(api.readSessionEvents).toHaveBeenCalledTimes(1);
		vi.mocked(api.readSessionEvents).mockResolvedValue([]);
		view.el.querySelector("button")!.click();
		await settle();
		expect(api.readSessionEvents).toHaveBeenCalledTimes(2);
		expect(view.el.textContent).toContain("Nothing is waiting");
	});

	it("refreshes all company authorities when realtime is degraded", async () => {
		vi.useFakeTimers();
		const { api, controller } = company();
		await controller.start();
		await vi.advanceTimersByTimeAsync(30_000);
		for (const method of [api.getTeam, api.listStaff, api.listSessions, api.getOrganization, api.listStaffActivity])
			expect(vi.mocked(method).mock.calls.length).toBeGreaterThan(1);
	});
});
