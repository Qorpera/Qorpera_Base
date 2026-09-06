// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { ApprovalsView } from "../src/app/views/approvals.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import { CloudRpcError } from "../src/cloud/client.ts";
import type { HostedSessionEvent } from "../src/cloud/types.ts";
import { deferred, event, fixture, pending, profileA, session, settle, staff, team, userA } from "./fixtures.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const dispose of cleanup.splice(0)) dispose();
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
});
function company() {
	const f = fixture();
	const controller = new CompanyController(f.api, profileA, userA.id);
	cleanup.push(() => controller.stop());
	return { ...f, controller };
}

describe("conversation lifecycle regressions", () => {
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
		const { api, controller } = company();
		const read = deferred<HostedSessionEvent[]>();
		vi.mocked(api.readSessionEvents).mockReturnValueOnce(read.promise);
		const append = vi.spyOn(api, "appendPrompt").mockRejectedValue(new Error("Fixture write failed"));
		controller.store.set({ loading: false, team, sessions: [session] });
		const view = new ConversationView(controller, session.sessionId);
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
		controller.conversation(session.sessionId, false);
		vi.mocked(api.listSessionInputs).mockResolvedValue({
			items: [pending(1, "One message")],
			hasMore: false,
			nextAfterPosition: 1,
		});
		vi.spyOn(api, "appendPrompt").mockResolvedValue({ inputId: pending(1).inputId, position: 1 });
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
