// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import type { PageCursor } from "../src/cloud/pagination.ts";
import type { HostedSession, HostedSessionEvent } from "../src/cloud/types.ts";
import { event, fixture, id, profileA, session, settle, staff, userA } from "./fixtures.ts";

/* Realtime hints carry no bodies, and every transcript event touches its conversation's row: a
 * busy company sends a sessions hint for each event. A hint reads only the conversations changed
 * since the newest one read, and then only what they touch; with live hints the work watch reads
 * only the open thread's new events. Without live hints everything is polled, as before. */

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const dispose of cleanup.splice(0)) dispose();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

// Agents' shared threads, as the kernel binds them to the agents' rooms.
const open: HostedSession = {
	...session,
	staffAgentId: staff.id,
	executionScope: { roomId: id(63), agentThread: true },
};
const other: HostedSession = {
	...session,
	sessionId: id(60),
	clientSessionId: id(61),
	staffAgentId: id(62),
	title: "Another agent's thread",
	executionScope: { roomId: id(64), agentThread: true },
};

/** A company with two agents' threads, the member reading the first (its agent working, unless
 * not); `write` has an agent add an event to a thread, which changes the thread's row and sends a
 * sessions hint. */
async function company(realtime: "connected" | "degraded", working = true) {
	vi.useFakeTimers({
		now: Date.parse("2026-09-29T10:00:00Z"),
		toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
	});
	const f = fixture();
	const sessions = new Map<string, HostedSession>([
		[open.sessionId, { ...open, updatedAt: new Date().toISOString() }],
		[other.sessionId, { ...other, updatedAt: new Date().toISOString() }],
	]);
	const events = new Map<string, HostedSessionEvent[]>([
		[open.sessionId, []],
		[other.sessionId, []],
	]);
	const after = (item: HostedSession, since: PageCursor) =>
		item.updatedAt > since.time || (item.updatedAt === since.time && item.sessionId > since.id);
	vi.mocked(f.api.listSessions).mockImplementation(async (_environment, _signal, since) => {
		return [...sessions.values()]
			.filter((item) => !since || after(item, since))
			.sort((a, b) =>
				a.updatedAt === b.updatedAt ? a.sessionId.localeCompare(b.sessionId) : a.updatedAt < b.updatedAt ? -1 : 1,
			);
	});
	vi.mocked(f.api.readSessionEvents).mockImplementation(async (sessionId, afterSequence) =>
		(events.get(sessionId) ?? []).filter((item) => item.sequence > (afterSequence ?? 0)),
	);
	vi.mocked(f.api.listStaffActivity).mockImplementation(async () =>
		working
			? [
					{
						runId: id(70),
						staffAgentId: staff.id,
						sourceKind: "session_turn",
						jobStatus: "leased",
						activity: "working",
						updatedAt: new Date().toISOString(),
					},
				]
			: [],
	);
	vi.mocked(f.api.listMemberMentions).mockResolvedValue([]);
	const controller = new CompanyController(f.api, profileA, userA.id);
	cleanup.push(() => controller.stop());
	await controller.start();
	controller.store.set({ realtime });
	controller.setOpenSession(open.sessionId);
	const store = controller.conversation(open.sessionId);
	await vi.advanceTimersByTimeAsync(1_000);
	const write = (sessionId: string) => {
		const list = events.get(sessionId)!;
		list.push({ ...event(list.length + 1), sessionId, createdAt: new Date().toISOString() });
		sessions.set(sessionId, { ...sessions.get(sessionId)!, updatedAt: new Date().toISOString() });
		f.hints.get("qorpera_shared_sessions")?.();
	};
	/** Every read the controller sent, by name. */
	const rpcs = () => {
		const counts: Record<string, number> = {};
		for (const name of Object.getOwnPropertyNames(f.api)) {
			const value = (f.api as unknown as Record<string, unknown>)[name];
			if (vi.isMockFunction(value) && value.mock.calls.length) counts[name] = value.mock.calls.length;
		}
		const direct = vi.mocked(f.cloud.rpc).mock.calls.length;
		if (direct) counts.rpc = direct;
		return counts;
	};
	/** One minute of an agent writing in the open thread every 1.5 s and another agent in its own
	 * thread every 3 s; returns what the controller read in it. */
	const minute = async () => {
		const start = rpcs();
		for (let tick = 1; tick <= 120; tick++) {
			if (tick % 3 === 0) write(open.sessionId);
			if (tick % 6 === 0) write(other.sessionId);
			await vi.advanceTimersByTimeAsync(500);
		}
		const end = rpcs();
		const read = Object.fromEntries(
			Object.entries(end)
				.map(([name, count]) => [name, count - (start[name] ?? 0)] as const)
				.filter(([, count]) => count > 0),
		);
		return { read, total: Object.values(read).reduce((sum, count) => sum + count, 0) };
	};
	return { f, controller, store, events, sessions, write, rpcs, minute };
}

describe("reading again after a hint", () => {
	it("keeps an open thread with a working agent live on a fraction of the reads", async () => {
		const busy = await company("connected");
		const { read, total } = await busy.minute();
		console.info("RPCs in one minute, live hints:", total, JSON.stringify(read));
		// The member sees every event: the last one arrived at most one watch ago.
		await vi.advanceTimersByTimeAsync(2_500);
		expect(busy.store.get().events).toHaveLength(busy.events.get(open.sessionId)!.length);
		expect(busy.controller.store.get().sessions.find((item) => item.sessionId === other.sessionId)?.updatedAt).toBe(
			busy.sessions.get(other.sessionId)!.updatedAt,
		);
		// Before: about 390 reads a minute for this company (every hint read every conversation,
		// the open thread's events, inputs and coding sessions, the activity and the mentions, and
		// the watch all of the thread and the activity every two seconds).
		expect(total).toBeLessThan(160);
		// The waiting inputs and coding sessions are read when the open thread itself changed, not
		// for every event anywhere; the watch reads only events.
		expect(read.listSessionInputs ?? 0).toBeLessThanOrEqual(read.readSessionEvents ?? 0);
	});

	it("reads only the conversations changed since the newest one read, and the open thread only when it changed", async () => {
		// No work watch here: only hints read.
		const busy = await company("connected", false);
		const listed = vi.mocked(busy.f.api.listSessions).mock.calls.length;
		const reads = () =>
			vi.mocked(busy.f.api.readSessionEvents).mock.calls.filter((call) => call[0] === open.sessionId).length;
		const inputs = () => vi.mocked(busy.f.api.listSessionInputs).mock.calls.length;
		const before = { reads: reads(), inputs: inputs() };
		busy.write(other.sessionId);
		await vi.advanceTimersByTimeAsync(1_000);
		const call = vi.mocked(busy.f.api.listSessions).mock.calls[listed];
		// From the newest conversation read, a minute back for changes that committed late.
		expect(call?.[2]).toMatchObject({ id: "00000000-0000-0000-0000-000000000000" });
		expect(Date.parse(call?.[2]?.time ?? "")).toBeLessThan(Date.parse(busy.sessions.get(other.sessionId)!.updatedAt));
		expect(vi.mocked(busy.f.api.listSessions).mock.calls).toHaveLength(listed + 1);
		// Another thread changed: the open one is not read again.
		expect(reads()).toBe(before.reads);
		// The open thread changed: its new events at once; its waiting inputs and coding sessions
		// again once ten seconds passed since they were last read.
		busy.write(open.sessionId);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(reads()).toBe(before.reads + 1);
		expect(inputs()).toBe(before.inputs);
		expect(busy.store.get().events).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(9_000);
		busy.write(open.sessionId);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(inputs()).toBe(before.inputs + 1);
		expect(busy.store.get().events).toHaveLength(2);
	});

	it("reads the whole list again every five minutes, so nothing a delta missed stays missed", async () => {
		const busy = await company("connected");
		const whole = () => vi.mocked(busy.f.api.listSessions).mock.calls.filter((call) => call[2] === undefined).length;
		const before = whole();
		await vi.advanceTimersByTimeAsync(4 * 60_000);
		expect(whole()).toBe(before);
		await vi.advanceTimersByTimeAsync(90_000);
		expect(whole()).toBe(before + 1);
	});

	it("reads everything on the watch and the clock when hints are not live, as before", async () => {
		const busy = await company("degraded");
		const inputs = vi.mocked(busy.f.api.listSessionInputs).mock.calls.length;
		const activity = vi.mocked(busy.f.api.listStaffActivity).mock.calls.length;
		await vi.advanceTimersByTimeAsync(4_100);
		// Two watches: the open thread in full and the activity, each time.
		expect(vi.mocked(busy.f.api.listSessionInputs).mock.calls.length).toBeGreaterThanOrEqual(inputs + 2);
		expect(vi.mocked(busy.f.api.listStaffActivity).mock.calls.length).toBeGreaterThanOrEqual(activity + 2);
		const whole = vi.mocked(busy.f.api.listSessions).mock.calls.filter((call) => call[2] === undefined).length;
		await vi.advanceTimersByTimeAsync(30_000);
		expect(vi.mocked(busy.f.api.listSessions).mock.calls.filter((call) => call[2] === undefined).length).toBe(
			whole + 1,
		);
		await settle();
	});
});
