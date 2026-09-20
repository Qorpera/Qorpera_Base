// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import type { HostedRunRecovery, HostedStaffExecutionActivity } from "../src/cloud/types.ts";
import { deferred, fixture, id, profileA, session, settle, staff, team, timestamp, userA } from "./fixtures.ts";

const cleanup: (() => void)[] = [];
let visibility: DocumentVisibilityState;
beforeEach(() => {
	vi.useFakeTimers();
	visibility = "visible";
	vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("No cloud transport in this UI fixture")));
	history.replaceState(null, "", `/#/c/${profileA.profileId}/chat/${session.sessionId}`);
});
afterEach(() => {
	for (const dispose of cleanup.splice(0)) dispose();
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const failedRun: HostedStaffExecutionActivity = {
	runId: id(70),
	staffAgentId: staff.id,
	sourceKind: "session_turn",
	jobStatus: "failed",
	activity: "needs_attention",
	updatedAt: timestamp,
};
const recovery: HostedRunRecovery = {
	runId: failedRun.runId,
	sourceKind: "session_turn",
	jobStatus: "failed",
	unsettledOperations: 0,
};

function setup(details = recovery, run = failedRun) {
	const f = fixture();
	const company = new CompanyController(f.api, profileA, userA.id);
	const acknowledge = vi.spyOn(f.api, "acknowledgeFailedRun").mockResolvedValue();
	const discard = vi.spyOn(f.api, "discardFailedRun");
	vi.spyOn(f.api, "getRunRecovery").mockResolvedValue(details);
	const send = vi.spyOn(company, "sendPrompt");
	company.store.set({
		team,
		staff: [staff],
		sessions: [{ ...session, staffAgentId: staff.id }],
		activity: [run],
		recoveries: { [run.runId]: details },
		loading: false,
	});
	const view = new ConversationView(company, session.sessionId);
	document.body.append(view.el);
	cleanup.push(() => {
		view.dispose();
		company.stop();
	});
	return { ...f, company, view, acknowledge, discard, send };
}

function changeVisibility(value: DocumentVisibilityState) {
	visibility = value;
	document.dispatchEvent(new Event("visibilitychange"));
}

describe("viewed conversation failures", () => {
	it.each(["failed", "cancelled"] as const)(
		"acknowledges a %s run after viewing it and exposes current work without replaying messages",
		async (jobStatus) => {
			const f = setup({ ...recovery, jobStatus }, { ...failedRun, jobStatus });
			vi.mocked(f.api.listStaffActivity).mockResolvedValue([
				{ ...failedRun, runId: id(71), jobStatus: "leased", activity: "working" },
			]);
			await settle();
			const conversation = f.company.conversation(session.sessionId);
			const projection = {
				items: [
					{
						kind: "member" as const,
						id: id(72),
						sequence: 1,
						text: "Existing message",
						attachmentCount: 0,
						createdAt: timestamp,
					},
				],
				hiddenCount: 0,
				lastSequence: 1,
			};
			conversation.set({ projection });
			const composer = f.view.el.querySelector<HTMLTextAreaElement>("textarea")!;
			composer.value = "Unsent draft";
			composer.dispatchEvent(new Event("input", { bubbles: true }));
			expect(f.company.agentState(staff.id)).toBe("failed");
			expect(f.view.el.querySelector(".notification-card")?.textContent).toBe("A run did not finish");
			await vi.advanceTimersByTimeAsync(4_999);
			expect(f.acknowledge).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(100);
			expect(f.acknowledge).toHaveBeenCalledExactlyOnceWith(failedRun.runId);
			expect(f.company.agentState(staff.id)).toBe("working");
			expect(f.view.el.querySelector(".notification-card")).toBeNull();
			expect(conversation.get().projection).toEqual(projection);
			expect(composer.value).toBe("Unsent draft");
			expect(f.send).not.toHaveBeenCalled();
		},
	);

	it.each(["unsettled", "unknown", "reader"] as const)(
		"acknowledges %s failures without resolving or replaying work",
		async (kind) => {
			const f = setup({ ...recovery, unsettledOperations: 1 });
			if (kind === "unknown") f.company.store.set({ recoveries: {} });
			if (kind === "reader")
				f.company.store.set({ team: { ...team, capabilities: { ...team.capabilities, write: false } } });
			await vi.advanceTimersByTimeAsync(5_100);
			expect(f.acknowledge).toHaveBeenCalledExactlyOnceWith(failedRun.runId);
			expect(f.discard).not.toHaveBeenCalled();
			expect(f.send).not.toHaveBeenCalled();
			expect(f.company.agentState(staff.id)).toBe("idle");
		},
	);

	it("requires a fresh uninterrupted visible period after hiding the tab", async () => {
		const f = setup();
		await vi.advanceTimersByTimeAsync(4_000);
		changeVisibility("hidden");
		await vi.advanceTimersByTimeAsync(20_000);
		expect(f.acknowledge).not.toHaveBeenCalled();
		changeVisibility("visible");
		await vi.advanceTimersByTimeAsync(4_000);
		expect(f.acknowledge).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1_100);
		expect(f.acknowledge).toHaveBeenCalledExactlyOnceWith(failedRun.runId);
	});

	it("preserves a delayed proposal's review action after automatic acknowledgment and navigation", async () => {
		const f = setup();
		f.company.store.set({ recoveries: {} });
		vi.mocked(f.api.listStaffActivity).mockResolvedValue([failedRun]);
		vi.mocked(f.api.getRunRecovery).mockResolvedValue({ ...recovery, proposalId: id(76) });
		await vi.advanceTimersByTimeAsync(5_100);
		expect(f.acknowledge).toHaveBeenCalledExactlyOnceWith(failedRun.runId);
		expect(f.view.el.querySelector(".notification-card a")?.textContent).toBe("Review");
		f.view.dispose();
		f.view.el.remove();
		const reopened = new ConversationView(f.company, session.sessionId);
		document.body.append(reopened.el);
		cleanup.push(() => reopened.dispose());
		expect(reopened.el.querySelector(".notification-card a")?.textContent).toBe("Review");
		expect(f.discard).not.toHaveBeenCalled();
	});

	it("does not acknowledge a conversation opened in a background tab", async () => {
		visibility = "hidden";
		const f = setup();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(f.acknowledge).not.toHaveBeenCalled();
		changeVisibility("visible");
		await vi.advanceTimersByTimeAsync(5_100);
		expect(f.acknowledge).toHaveBeenCalledExactlyOnceWith(failedRun.runId);
	});

	it.each(["dispose", "detach", "stop"] as const)("cancels acknowledgment on %s", async (action) => {
		const f = setup();
		await vi.advanceTimersByTimeAsync(4_000);
		if (action === "dispose") f.view.dispose();
		if (action === "detach") f.view.el.remove();
		if (action === "stop") f.company.stop();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(f.acknowledge).not.toHaveBeenCalled();
	});

	it.each(["unreadable", "access-lost", "closed", "group", "proposal", "review"] as const)(
		"preserves failures when they become ineligible: %s",
		async (reason) => {
			const f = setup();
			await vi.advanceTimersByTimeAsync(4_000);
			if (reason === "unreadable") f.company.store.set({ team: undefined });
			if (reason === "access-lost") f.company.store.set({ accessLost: true });
			if (reason === "closed")
				f.company.store.set({ sessions: [{ ...session, staffAgentId: staff.id, status: "closed" }] });
			if (reason === "group")
				f.company.store.set({
					sessions: [{ ...session, executionScope: { roomId: id(75) } }],
				});
			if (reason === "proposal")
				f.company.store.set({ recoveries: { [failedRun.runId]: { ...recovery, proposalId: id(76) } } });
			if (reason === "review") f.company.store.set({ activity: [{ ...failedRun, sourceKind: "proposal_review" }] });
			await vi.advanceTimersByTimeAsync(10_000);
			expect(f.acknowledge).not.toHaveBeenCalled();
			expect(f.send).not.toHaveBeenCalled();
		},
	);

	it("gives a replacement failure its own viewing period", async () => {
		const f = setup();
		await vi.advanceTimersByTimeAsync(4_000);
		const next = { ...failedRun, runId: id(71) };
		f.company.store.set({ activity: [next], recoveries: { [next.runId]: { ...recovery, runId: next.runId } } });
		await vi.advanceTimersByTimeAsync(4_000);
		expect(f.acknowledge).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1_100);
		expect(f.acknowledge).toHaveBeenCalledExactlyOnceWith(next.runId);
	});

	it("explicitly acknowledges an unresolved failure immediately without discarding it", async () => {
		const f = setup({ ...recovery, unsettledOperations: 1 });
		await settle();
		f.view.el.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification"]')!.click();
		await settle();
		expect(f.acknowledge).toHaveBeenCalledExactlyOnceWith(failedRun.runId);
		expect(f.discard).not.toHaveBeenCalled();
		expect(f.company.agentState(staff.id)).toBe("idle");
		await vi.advanceTimersByTimeAsync(10_000);
		expect(f.acknowledge).toHaveBeenCalledTimes(1);
	});

	it("does not duplicate an explicit acknowledgment while its response is pending", async () => {
		const f = setup();
		const pending = deferred<void>();
		f.acknowledge.mockReturnValueOnce(pending.promise);
		await vi.advanceTimersByTimeAsync(4_000);
		f.view.el.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification"]')!.click();
		expect(f.acknowledge).toHaveBeenCalledExactlyOnceWith(failedRun.runId);
		f.company.store.set({ activity: [{ ...failedRun }] });
		await vi.advanceTimersByTimeAsync(15_000);
		expect(f.acknowledge).toHaveBeenCalledTimes(1);
		pending.resolve();
		await settle();
		expect(f.company.agentState(staff.id)).toBe("idle");
	});

	it("does not repeat rejected automatic attempts and still allows an explicit retry", async () => {
		const f = setup();
		f.acknowledge.mockRejectedValueOnce(new Error("Dismissal could not be confirmed"));
		vi.mocked(f.api.listStaffActivity).mockResolvedValue([failedRun]);
		await vi.advanceTimersByTimeAsync(5_100);
		expect(f.acknowledge).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(30_000);
		f.company.store.set({});
		changeVisibility("hidden");
		changeVisibility("visible");
		await vi.advanceTimersByTimeAsync(10_000);
		expect(f.acknowledge).toHaveBeenCalledTimes(1);
		expect(f.view.el.querySelector(".notification-card")).not.toBeNull();
		vi.mocked(f.api.listStaffActivity).mockResolvedValue([]);
		f.view.el.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification"]')!.click();
		await settle();
		expect(f.acknowledge).toHaveBeenCalledTimes(2);
		expect(f.company.agentState(staff.id)).toBe("idle");
	});

	it("allows a fresh visit to retry an acknowledgment that failed on the previous visit", async () => {
		const f = setup();
		f.acknowledge.mockRejectedValueOnce(new Error("Connection lost"));
		vi.mocked(f.api.listStaffActivity).mockResolvedValue([failedRun]);
		await vi.advanceTimersByTimeAsync(5_100);
		expect(f.acknowledge).toHaveBeenCalledTimes(1);
		f.view.dispose();
		f.view.el.remove();
		vi.mocked(f.api.listStaffActivity).mockResolvedValue([]);
		const reopened = new ConversationView(f.company, session.sessionId);
		document.body.append(reopened.el);
		cleanup.push(() => reopened.dispose());
		await vi.advanceTimersByTimeAsync(4_999);
		expect(f.acknowledge).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(100);
		expect(f.acknowledge).toHaveBeenCalledTimes(2);
		expect(f.company.agentState(staff.id)).toBe("idle");
	});
});
