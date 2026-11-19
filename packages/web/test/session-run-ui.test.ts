// @vitest-environment jsdom
import type { CloudSessionRunState } from "@qorpera/cloud-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import { ConversationView } from "../src/app/views/conversation.ts";
import { SessionRunView } from "../src/app/views/session-run.ts";
import { deferred, fixture, id, profileA, session, settle, staff, team, userA } from "./fixtures.ts";

let dispose: (() => void) | undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	dispose?.();
	dispose = undefined;
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
});
function state(runId: string | null = id(90)): CloudSessionRunState {
	return {
		sessionId: session.sessionId,
		staffAgentId: staff.id,
		run: runId ? { runId, status: "leased", canCancel: true } : null,
	};
}
function button(label: string): HTMLButtonElement {
	const element = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
	if (!element) throw new Error(`Missing button: ${label}`);
	return element;
}
function setup() {
	const read = vi.fn(async () => state());
	const cancel = vi.fn(async () => "cancelled" as const);
	const lifetime = new AbortController();
	const view = new SessionRunView({ read, cancel }, session.sessionId, lifetime.signal);
	view.update(staff.id, true);
	dispose = () => view.dispose();
	return { read, cancel, view, lifetime };
}

describe("cloud run UI", () => {
	it("reads on opening and stops only the observed run before reading again", async () => {
		const f = setup();
		await settle();
		expect(f.read).toHaveBeenCalledExactlyOnceWith(session.sessionId, staff.id, expect.any(AbortSignal));
		expect(f.view.stoppable).toBe(true);
		f.read.mockResolvedValue(state(null));
		f.view.stop();
		await settle();
		expect(f.cancel).toHaveBeenCalledExactlyOnceWith(session.sessionId, id(90), expect.any(AbortSignal));
		expect(f.read).toHaveBeenCalledTimes(2);
		expect(f.view.stoppable).toBe(false);
	});

	it("blocks a stop replay after a lost response until the status is read again", async () => {
		const f = setup();
		await settle();
		f.cancel.mockRejectedValueOnce(new Error("lost response"));
		f.view.stop();
		await settle();
		expect(f.view.stoppable).toBe(false);
		f.view.stop();
		f.view.messageSent();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(f.cancel).toHaveBeenCalledTimes(1);
		expect(f.read).toHaveBeenCalledTimes(1);
		f.read.mockResolvedValue(state(id(91)));
		await f.view.refresh();
		expect(f.view.stoppable).toBe(true);
		f.view.stop();
		await settle();
		expect(f.cancel).toHaveBeenLastCalledWith(session.sessionId, id(91), expect.any(AbortSignal));
	});

	it("reads on reconnection and reopening without mutating runtime state", async () => {
		const f = setup();
		await settle();
		window.dispatchEvent(new Event("online"));
		await settle();
		expect(f.read).toHaveBeenCalledTimes(2);
		f.view.dispose();
		const reopened = new SessionRunView(f, session.sessionId, f.lifetime.signal);
		dispose = () => reopened.dispose();
		reopened.update(staff.id, true);
		await settle();
		expect(f.read).toHaveBeenCalledTimes(3);
		expect(f.cancel).not.toHaveBeenCalled();
	});

	it("bounds post-send reads and disposal stops polling without stopping work", async () => {
		const f = setup();
		await settle();
		f.view.messageSent();
		await settle();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(f.read).toHaveBeenCalledTimes(6);
		f.view.messageSent();
		await settle();
		f.view.dispose();
		window.dispatchEvent(new Event("online"));
		window.dispatchEvent(new Event("focus"));
		f.view.messageSent();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(f.read).toHaveBeenCalledTimes(7);
		expect(f.cancel).not.toHaveBeenCalled();
	});

	it("discards late reads when access or the selected agent changes", async () => {
		const f = setup();
		await settle();
		const pending = deferred<CloudSessionRunState>();
		f.read.mockReturnValueOnce(pending.promise);
		void f.view.refresh();
		f.view.update(undefined, true);
		pending.resolve(state());
		await settle();
		expect(f.view.stoppable).toBe(false);
		f.read.mockResolvedValue({ ...state(null), staffAgentId: id(99) });
		f.view.update(id(99), true);
		await settle();
		expect(f.read).toHaveBeenLastCalledWith(session.sessionId, id(99), expect.any(AbortSignal));
		expect(f.view.stoppable).toBe(false);
	});

	it("aborts pending cancellation locally on disposal without resubmitting it", async () => {
		const f = setup();
		await settle();
		const pending = deferred<"cancelled">();
		f.cancel.mockReturnValueOnce(pending.promise);
		f.view.stop();
		const signal = vi.mocked(f.cancel).mock.calls[0] as unknown as [string, string, AbortSignal];
		f.lifetime.abort();
		expect(signal[2].aborted).toBe(true);
		pending.resolve("cancelled");
		await settle();
		expect(f.cancel).toHaveBeenCalledTimes(1);
		expect(f.read).toHaveBeenCalledTimes(1);
		expect(f.view.stoppable).toBe(false);
	});

	it("conversation submission refreshes cloud state without using presence as run status", async () => {
		const f = fixture();
		const company = new CompanyController(f.api, profileA, userA.id);
		company.store.set({ team, staff: [staff], sessions: [{ ...session, staffAgentId: staff.id }], loading: false });
		const read = vi.fn(async () => state(null));
		const cancel = vi.fn(async () => "cancelled" as const);
		const sendMessage = vi.fn(async () => true);
		const view = new ConversationView(company, session.sessionId, { runControl: { read, cancel }, sendMessage });
		document.body.append(view.el);
		dispose = () => {
			view.dispose();
			company.stop();
		};
		await settle();
		const input = view.el.querySelector("textarea")!;
		input.value = "Hello";
		input.dispatchEvent(new Event("input"));
		view.update();
		button("Send message").click();
		await settle();
		expect(sendMessage).toHaveBeenCalledExactlyOnceWith(session.sessionId, "Hello", expect.any(AbortSignal));
		expect(read).toHaveBeenCalledTimes(2);
		expect(view.el.querySelector(".thread-activity")).toBeNull();
		view.dispose();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(read).toHaveBeenCalledTimes(2);
		expect(cancel).not.toHaveBeenCalled();
	});

	it("shows the agent working in the thread and turns the empty send button into Stop", async () => {
		const f = fixture();
		const company = new CompanyController(f.api, profileA, userA.id);
		company.store.set({ team, staff: [staff], sessions: [{ ...session, staffAgentId: staff.id }], loading: false });
		company.conversation(session.sessionId).set({
			loading: false,
			projection: {
				items: [
					{ kind: "member", id: id(70), body: "hi", createdAt: "2026-09-17T06:00:00.000Z", actorUserId: userA.id },
				],
			},
		} as never);
		const read = vi.fn(async () => state());
		const cancel = vi.fn(async () => "cancelled" as const);
		const view = new ConversationView(company, session.sessionId, {
			runControl: { read, cancel },
			sendMessage: vi.fn(async () => true),
		});
		document.body.append(view.el);
		dispose = () => {
			view.dispose();
			company.stop();
		};
		await settle();
		expect(view.el.querySelector(".thread-activity")).toBeNull();
		expect(document.querySelector('[aria-label="Stop"]')).toBeNull();
		company.store.set({
			activity: [
				{
					runId: id(90),
					staffAgentId: staff.id,
					sourceKind: "session_turn",
					jobStatus: "queued",
					activity: "waiting",
					updatedAt: "2026-09-17T06:00:01.000Z",
				},
			],
		} as never);
		view.update();
		await settle();
		expect(view.el.querySelector(".thread-activity")).not.toBeNull();
		expect(view.el.textContent).not.toContain("queued");
		// A draft takes the button back for sending.
		const input = view.el.querySelector("textarea")!;
		input.value = "one more thing";
		input.dispatchEvent(new Event("input"));
		view.update();
		expect(document.querySelector('[aria-label="Stop"]')).toBeNull();
		input.value = "";
		input.dispatchEvent(new Event("input"));
		view.update();
		button("Stop").click();
		await settle();
		expect(cancel).toHaveBeenCalledExactlyOnceWith(session.sessionId, id(90), expect.any(AbortSignal));
		company.store.set({ activity: [] });
		view.update();
		await settle();
		expect(view.el.querySelector(".thread-activity")).toBeNull();
	});

	it("lets the member stop a run that waits at its login's usage limit, though the agent shows no work", async () => {
		const f = fixture();
		const company = new CompanyController(f.api, profileA, userA.id);
		company.store.set({ team, staff: [staff], sessions: [{ ...session, staffAgentId: staff.id }], loading: false });
		const read = vi.fn(async () => ({
			...state(),
			run: { runId: id(90), status: "queued" as const, canCancel: true },
		}));
		const cancel = vi.fn(async () => "cancelled" as const);
		const view = new ConversationView(company, session.sessionId, {
			runControl: { read, cancel },
			sendMessage: vi.fn(async () => true),
		});
		document.body.append(view.el);
		dispose = () => {
			view.dispose();
			company.stop();
		};
		await settle();
		company.store.set({
			activity: [
				{
					runId: id(90),
					staffAgentId: staff.id,
					sourceKind: "room_delivery",
					jobStatus: "queued",
					activity: "waiting",
					paused: {
						until: "2099-01-01T00:00:00.000Z",
						sponsorBindingId: id(91),
						paidByChatgptPlan: false,
						paidWhileAway: true,
						movable: true,
					},
					updatedAt: "2026-09-17T06:00:01.000Z",
				},
			],
		});
		view.update();
		await settle();
		// It holds the conversation until it goes on (20260930703000), so the empty send button stops it.
		expect(view.el.querySelector(".thread-activity")).toBeNull();
		button("Stop").click();
		await settle();
		expect(cancel).toHaveBeenCalledExactlyOnceWith(session.sessionId, id(90), expect.any(AbortSignal));
	});
});
