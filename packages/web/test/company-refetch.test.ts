// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyController } from "../src/app/company.ts";
import type { PageCursor } from "../src/cloud/pagination.ts";
import type { HostedSession, HostedSessionEvent, HostedStaffExecutionActivity } from "../src/cloud/types.ts";
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

const working = (): HostedStaffExecutionActivity[] => [
	{
		runId: id(70),
		staffAgentId: staff.id,
		sourceKind: "session_turn",
		jobStatus: "leased",
		activity: "working",
		updatedAt: new Date().toISOString(),
	},
];

/** A company with two agents' threads, the member reading the first (its agent working, unless
 * not); `write` has an agent add an event to a thread, which changes the thread's row and sends a
 * sessions hint (unless not); `status` is the Realtime channel's own status callback. With
 * `history`, the open thread already holds that many messages, one a minute, and the cloud has the
 * newest-first read (20260929410000): the thread opens at its newest events. `holds` keeps the next
 * newest-first or forward read of the open thread on its way until released. */
async function company(realtime: "connected" | "degraded", busy = true, history = 0) {
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
		[
			open.sessionId,
			Array.from({ length: history }, (_, index) => ({
				...event(index + 1),
				sessionId: open.sessionId,
				createdAt: new Date(Date.now() - (history - index) * 60_000).toISOString(),
			})),
		],
		[other.sessionId, []],
	]);
	const after = (item: HostedSession, since: PageCursor) =>
		item.updatedAt > since.time || (item.updatedAt === since.time && item.sessionId > since.id);
	/** A delta read that is slow (held until released) or fails. */
	const delta: { hold?: Promise<void>; fail?: boolean } = {};
	vi.mocked(f.api.listSessions).mockImplementation(async (_environment, _signal, since) => {
		const read = [...sessions.values()]
			.filter((item) => !since || after(item, since))
			.sort((a, b) =>
				a.updatedAt === b.updatedAt ? a.sessionId.localeCompare(b.sessionId) : a.updatedAt < b.updatedAt ? -1 : 1,
			);
		if (since && delta.fail) throw new Error("Network blip");
		if (since && delta.hold) await delta.hold;
		return read;
	});
	const holds: { tail?: Promise<void>; forward?: Promise<void> } = {};
	/** The next held read of the open thread waits for its release; the ones after it do not. */
	const held = async (sessionId: string, kind: keyof typeof holds) => {
		const hold = sessionId === open.sessionId ? holds[kind] : undefined;
		if (hold) {
			holds[kind] = undefined;
			await hold;
		}
	};
	vi.mocked(f.api.readSessionEvents).mockImplementation(async (sessionId, afterSequence) => {
		await held(sessionId, "forward");
		return (events.get(sessionId) ?? []).filter((item) => item.sequence > (afterSequence ?? 0));
	});
	if (history)
		vi.mocked(f.api.readSessionEventsTail).mockImplementation(async (sessionId, before, limit) => {
			await held(sessionId, "tail");
			return (events.get(sessionId) ?? [])
				.filter((item) => before === undefined || item.sequence < before)
				.slice(-limit);
		});
	const activity = { rows: busy ? working() : [] };
	vi.mocked(f.api.listStaffActivity).mockImplementation(async () => activity.rows);
	vi.mocked(f.api.listMemberMentions).mockResolvedValue([]);
	const controller = new CompanyController(f.api, profileA, userA.id);
	cleanup.push(() => controller.stop());
	await controller.start();
	const channel = vi.mocked(f.cloud.supabase.channel).mock.results[0]?.value as {
		subscribe: ReturnType<typeof vi.fn>;
	};
	const status = channel.subscribe.mock.calls[0]?.[0] as (state: string) => void;
	status(realtime === "connected" ? "SUBSCRIBED" : "CHANNEL_ERROR");
	controller.setOpenSession(open.sessionId);
	const store = controller.conversation(open.sessionId);
	await vi.advanceTimersByTimeAsync(1_000);
	const hint = () => f.hints.get("qorpera_shared_sessions")?.();
	const write = (sessionId: string, notify = true) => {
		const list = events.get(sessionId)!;
		list.push({ ...event(list.length + 1), sessionId, createdAt: new Date().toISOString() });
		sessions.set(sessionId, { ...sessions.get(sessionId)!, updatedAt: new Date().toISOString() });
		if (notify) hint();
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
	return { f, controller, store, events, sessions, write, hint, status, activity, delta, holds, rpcs, minute };
}

/** Seconds until `seen` holds, one second at a time (at most a minute). */
async function secondsUntil(seen: () => boolean): Promise<number> {
	for (let second = 1; second <= 60; second++) {
		await vi.advanceTimersByTimeAsync(1_000);
		if (seen()) return second;
	}
	return Number.POSITIVE_INFINITY;
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
		// within ten seconds of their last read, also with no later hint.
		busy.write(open.sessionId);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(reads()).toBe(before.reads + 1);
		expect(inputs()).toBe(before.inputs);
		expect(busy.store.get().events).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(9_000);
		expect(inputs()).toBe(before.inputs + 1);
	});

	it("reads a thread's waiting inputs within ten seconds of their hint, also when no later hint comes", async () => {
		const busy = await company("connected", false);
		await vi.advanceTimersByTimeAsync(40_000);
		busy.write(open.sessionId);
		await vi.advanceTimersByTimeAsync(2_000);
		const inputs = () => vi.mocked(busy.f.api.listSessionInputs).mock.calls.length;
		const before = inputs();
		await vi.advanceTimersByTimeAsync(1_000);
		// Another member's message is queued: its conversation's row changes, one hint.
		busy.sessions.set(open.sessionId, { ...busy.sessions.get(open.sessionId)!, updatedAt: new Date().toISOString() });
		busy.hint();
		expect(await secondsUntil(() => inputs() > before)).toBeLessThanOrEqual(10);
	});

	it("keeps reading the agents' activity while one works, also for a change no hint announces", async () => {
		const busy = await company("connected");
		await vi.advanceTimersByTimeAsync(5_000);
		// The run fails to start: its job changes, no conversation does, so no hint comes.
		busy.activity.rows = [{ ...working()[0]!, jobStatus: "failed", activity: "needs_attention" }];
		expect(
			await secondsUntil(() => busy.controller.store.get().activity[0]?.activity === "needs_attention"),
		).toBeLessThanOrEqual(3);
	});

	it("keeps the open thread live when Realtime says connected but no hints arrive", async () => {
		const busy = await company("connected");
		let worst = 0;
		const written: number[] = [];
		for (let tick = 1; tick <= 240; tick++) {
			if (tick % 3 === 0) {
				busy.write(open.sessionId, false);
				written.push(Date.now());
			}
			await vi.advanceTimersByTimeAsync(500);
			const seen = busy.store.get().events.length;
			if (seen < written.length) worst = Math.max(worst, Date.now() - written[seen]!);
		}
		// One watch at most (two seconds, rounded to the half-second steps).
		expect(worst).toBeLessThanOrEqual(2_500);
	});

	it("catches up once when Realtime comes back after an error", async () => {
		const busy = await company("connected", false);
		await vi.advanceTimersByTimeAsync(5_000);
		busy.status("CHANNEL_ERROR");
		// While it is away, another conversation is archived and the open thread gets a message;
		// neither hint arrives.
		busy.sessions.set(other.sessionId, {
			...busy.sessions.get(other.sessionId)!,
			status: "closed",
			updatedAt: new Date().toISOString(),
		});
		busy.write(open.sessionId, false);
		await vi.advanceTimersByTimeAsync(5_000);
		const closed = () =>
			busy.controller.store.get().sessions.find((item) => item.sessionId === other.sessionId)?.status === "closed";
		expect(closed()).toBe(false);
		busy.status("SUBSCRIBED");
		await vi.advanceTimersByTimeAsync(1_000);
		expect(closed()).toBe(true);
		expect(busy.store.get().events).toHaveLength(1);
	});

	it("does not let a delta that started before a whole read put back older copies", async () => {
		const busy = await company("connected", false);
		await vi.advanceTimersByTimeAsync(5_000);
		let release = () => {};
		busy.delta.hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		busy.write(other.sessionId);
		await vi.advanceTimersByTimeAsync(300);
		// Renamed while the delta is on its way; a whole read (a send, the clock) lands first.
		busy.sessions.set(other.sessionId, {
			...busy.sessions.get(other.sessionId)!,
			title: "Renamed",
			updatedAt: new Date().toISOString(),
		});
		await busy.controller.refreshSessions();
		const title = () =>
			busy.controller.store.get().sessions.find((item) => item.sessionId === other.sessionId)?.title;
		expect(title()).toBe("Renamed");
		busy.delta.hold = undefined;
		release();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(title()).toBe("Renamed");
	});

	it("still reads what a hint touches when its delta read fails", async () => {
		const busy = await company("connected", false);
		await vi.advanceTimersByTimeAsync(40_000);
		const reads = () =>
			vi.mocked(busy.f.api.readSessionEvents).mock.calls.filter((call) => call[0] === open.sessionId).length;
		const before = reads();
		busy.delta.fail = true;
		busy.write(open.sessionId);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(reads()).toBe(before + 1);
		expect(busy.store.get().events).toHaveLength(1);
		expect(busy.controller.store.get().sessionsError).toBe("Network blip");
		busy.delta.fail = false;
		busy.write(open.sessionId);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(busy.controller.store.get().sessionsError).toBeUndefined();
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

describe("hints on a thread that opened at its newest events", () => {
	const sequences = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
	/** Where each read of the open thread started: forward reads after this sequence, newest-first
	 * reads before it. */
	const reads = (busy: Awaited<ReturnType<typeof company>>) => ({
		forward: vi
			.mocked(busy.f.api.readSessionEvents)
			.mock.calls.filter((call) => call[0] === open.sessionId)
			.map((call) => call[1]),
		tail: vi
			.mocked(busy.f.api.readSessionEventsTail)
			.mock.calls.filter((call) => call[0] === open.sessionId)
			.map((call) => call[1]),
	});

	it("appends what a hint brings after the newest event read, and never reads the history from the start", async () => {
		const busy = await company("connected", false, 1000);
		expect(reads(busy)).toEqual({ forward: [], tail: [undefined] });
		expect(busy.store.get().events.map((item) => item.sequence)).toEqual(sequences(801, 1000));
		expect(busy.store.get().hasEarlier).toBe(true);
		busy.write(open.sessionId);
		await vi.advanceTimersByTimeAsync(1_000);
		// The hint's read of new events: forward from the newest event read, nothing before it.
		expect(reads(busy)).toEqual({ forward: [1000], tail: [undefined] });
		expect(busy.store.get().events.map((item) => item.sequence)).toEqual(sequences(801, 1001));
		// The trailing full read (waiting inputs, coding sessions) reads events the same way.
		const inputs = vi.mocked(busy.f.api.listSessionInputs).mock.calls.length;
		await vi.advanceTimersByTimeAsync(10_000);
		expect(vi.mocked(busy.f.api.listSessionInputs).mock.calls.length).toBe(inputs + 1);
		expect(reads(busy)).toEqual({ forward: [1000, 1001], tail: [undefined] });
		expect(busy.store.get()).toMatchObject({ hasEarlier: true, complete: true });
		expect(busy.store.get().events).toHaveLength(201);
	});

	it("keeps the window through a busy minute of hints and watches", async () => {
		const busy = await company("connected", true, 1000);
		const { total } = await busy.minute();
		await vi.advanceTimersByTimeAsync(2_500);
		const { forward, tail } = reads(busy);
		expect(tail).toEqual([undefined]);
		expect(Math.min(...forward.map((after) => after ?? 0))).toBeGreaterThanOrEqual(1000);
		// 40 new messages after the 200 it opened with; the rest of the history stays unread.
		expect(busy.store.get().events.map((item) => item.sequence)).toEqual(sequences(801, 1040));
		expect(busy.store.get().hasEarlier).toBe(true);
		expect(total).toBeLessThan(160);
	});

	it("catches up after Realtime returns from the newest event read, and Show earlier goes on from the window", async () => {
		const busy = await company("connected", false, 1000);
		await vi.advanceTimersByTimeAsync(5_000);
		busy.status("CHANNEL_ERROR");
		for (let count = 0; count < 3; count++) busy.write(open.sessionId, false);
		await vi.advanceTimersByTimeAsync(5_000);
		busy.status("SUBSCRIBED");
		await vi.advanceTimersByTimeAsync(1_000);
		expect(busy.store.get().events.map((item) => item.sequence)).toEqual(sequences(801, 1003));
		const { forward, tail } = reads(busy);
		expect(tail).toEqual([undefined]);
		expect(forward.length).toBeGreaterThan(0);
		expect(Math.min(...forward.map((after) => after ?? 0))).toBeGreaterThanOrEqual(1000);
		expect(busy.store.get().hasEarlier).toBe(true);
		await busy.controller.loadEarlier(open.sessionId);
		expect(reads(busy).tail).toEqual([undefined, 801]);
		expect(busy.store.get().events.map((item) => item.sequence)).toEqual(sequences(601, 1003));
	});

	it("keeps both a Show earlier page and a hint's new events, whichever lands first", async () => {
		// The older page is on its way while the hint's read lands.
		const first = await company("connected", false, 1000);
		await vi.advanceTimersByTimeAsync(5_000);
		let release = () => {};
		first.holds.tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		const showing = first.controller.loadEarlier(open.sessionId);
		first.write(open.sessionId);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(first.store.get().events.map((item) => item.sequence)).toEqual(sequences(801, 1001));
		expect(first.store.get().earlierLoading).toBe(true);
		release();
		await showing;
		expect(first.store.get().events.map((item) => item.sequence)).toEqual(sequences(601, 1001));
		expect(first.store.get()).toMatchObject({ hasEarlier: true, earlierLoading: false });
		first.controller.stop();

		// The hint's read is on its way while Show earlier lands, and reaches the start.
		const second = await company("connected", false, 350);
		expect(second.store.get().events.map((item) => item.sequence)).toEqual(sequences(151, 350));
		await vi.advanceTimersByTimeAsync(5_000);
		second.holds.forward = new Promise<void>((resolve) => {
			release = resolve;
		});
		second.write(open.sessionId);
		await vi.advanceTimersByTimeAsync(1_000);
		await second.controller.loadEarlier(open.sessionId);
		expect(second.store.get()).toMatchObject({ hasEarlier: false, earlierLoading: false });
		expect(second.store.get().events.map((item) => item.sequence)).toEqual(sequences(1, 350));
		release();
		await vi.advanceTimersByTimeAsync(1_000);
		// The older read of new events adds its message and leaves the start where Show earlier found it.
		expect(second.store.get().events.map((item) => item.sequence)).toEqual(sequences(1, 351));
		expect(second.store.get().hasEarlier).toBe(false);
		expect(reads(second).tail).toEqual([undefined, 151]);
	});

	it("does not bring back Show earlier when a shorter read-back lands after it reached the start", async () => {
		const busy = await company("connected", false, 1000);
		await vi.advanceTimersByTimeAsync(5_000);
		// Everything before the window is run receipts, which show nothing: Show earlier reads back
		// to the start. A message taken at minute 700 has no event yet: its read-back stops at 601.
		const history = busy.events.get(open.sessionId)!;
		for (let index = 0; index < 800; index++)
			history[index] = {
				...history[index]!,
				eventType: "run_receipt",
				body: { schema: "qorpera.run-receipt/v1" },
			};
		vi.mocked(busy.f.api.listSessionInputs).mockResolvedValue({
			items: [
				{
					inputId: id(3700),
					position: 1,
					kind: "user_message",
					authorUserId: userA.id,
					authorDisplayName: "Account A",
					body: { schema: "qorpera.session-prompt/v1", text: "Taken long ago", images: [] },
					createdAt: history[699]!.createdAt,
					status: "processing",
				},
			],
			hasMore: false,
			nextAfterPosition: 1,
		});
		let release = () => {};
		busy.holds.tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		const loading = busy.controller.loadConversation(open.sessionId);
		await vi.advanceTimersByTimeAsync(0);
		expect(reads(busy).tail).toEqual([undefined, 801]);
		await busy.controller.loadEarlier(open.sessionId);
		expect(busy.store.get()).toMatchObject({ hasEarlier: false });
		expect(busy.store.get().events[0]?.sequence).toBe(1);
		release();
		await loading;
		expect(busy.store.get().hasEarlier).toBe(false);
		expect(busy.store.get().events).toHaveLength(1000);
	});
});
