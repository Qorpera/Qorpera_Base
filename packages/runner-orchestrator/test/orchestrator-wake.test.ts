import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeWebSocket } from "../src/node-websocket.ts";
import {
	type CloudRunnerInstance,
	CloudRunnerOrchestrator,
	type CloudRunnerProviderAdapter,
	CloudRunnerWakeMissed,
	type CloudRunnerWakeSource,
	type CloudRunnerWork,
	cloudRunnerOrchestratorWakeTopic,
} from "../src/orchestrator.ts";
import { RealtimeOrchestratorWake, type RealtimeOrchestratorWakeState } from "../src/orchestrator-wake.ts";
import { FakeClaimQueue, fakeWork } from "./helpers/lxd-socket-fake.ts";
import { FakeRealtime, serverFrame } from "./helpers/realtime-fake.ts";

const orchestratorId = "11111111-1111-4111-8111-111111111111";
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

function runId(n: number): string {
	return `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("condition was not met in time");
		await new Promise((resolveWait) => setTimeout(resolveWait, 5));
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function fakeRealtime(): Promise<FakeRealtime> {
	const realtime = new FakeRealtime();
	await realtime.start();
	cleanup.push(() => realtime.close());
	return realtime;
}

class ManualWake implements CloudRunnerWakeSource {
	listening = true;
	readonly #listeners = new Set<() => void>();
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	fire(): void {
		for (const listener of this.#listeners) listener();
	}
}

function runner(work: CloudRunnerWork): CloudRunnerInstance {
	return {
		runnerId: randomUUID(),
		...(work.computeIdentityId ? { computeIdentityId: work.computeIdentityId } : {}),
		workerClass: work.workerClass,
		providerAdapter: "local",
		capabilities: ["agent_turn"],
		templateKey: work.computeTemplateKey!,
		templateVersion: work.computeTemplateVersion!,
		policySha256: work.computePolicySha256!,
	};
}

/** A queue that also answers the one pass summary call (all lists quiet unless `passDue` says otherwise). */
class SummaryQueue extends FakeClaimQueue {
	passDue: () => Promise<Readonly<Record<string, boolean>>> = async () => ({});
	async readPassDue(): Promise<Readonly<Record<string, boolean>>> {
		return this.passDue();
	}
}

/** An orchestrator over a queue the test fills, with a provider whose starts take `acquireMs`. */
function loop(
	options: {
		wake?: CloudRunnerWakeSource;
		pollIntervalMs?: number;
		reconcileIntervalMs?: number;
		wakeBackstopMs?: number;
		wakeActiveMs?: number;
		wakePassGapMs?: number;
		dispatchConcurrency?: number;
		acquireMs?: number;
		reconcileDelayMs?: number;
		/** The pass summary call's answer; `false` for a control plane without the call. */
		passDue?: false | (() => Promise<Readonly<Record<string, boolean>>>);
	} = {},
) {
	let queue: FakeClaimQueue;
	if (options.passDue === false) queue = new FakeClaimQueue(orchestratorId);
	else {
		const summary = new SummaryQueue(orchestratorId);
		if (options.passDue) summary.passDue = options.passDue;
		queue = summary;
	}
	queue.reconcileDelayMs = options.reconcileDelayMs ?? 0;
	// Each pass ends with reconcileExpired, which holds the pass for reconcileDelayMs.
	const passes: Array<{ start: number; end?: number }> = [];
	const reconcileExpired = FakeClaimQueue.prototype.reconcileExpired.bind(queue);
	vi.spyOn(queue, "reconcileExpired").mockImplementation(async (...args) => {
		const pass: { start: number; end?: number } = { start: performance.now() };
		passes.push(pass);
		await reconcileExpired(...args);
		pass.end = performance.now();
	});
	const claimNext = vi.spyOn(queue, "claimNext");
	const acquired: string[] = [];
	const errors: unknown[] = [];
	const starts = { active: 0, peak: 0 };
	const provider: CloudRunnerProviderAdapter = {
		adapterId: "local",
		reconcile: async () => undefined,
		acquire: async (work) => {
			starts.active++;
			starts.peak = Math.max(starts.peak, starts.active);
			acquired.push(work.runId);
			await sleep(options.acquireMs ?? 0);
			starts.active--;
			return runner(work);
		},
		deliver: async () => undefined,
		stop: async () => undefined,
	};
	const orchestrator = new CloudRunnerOrchestrator({
		orchestratorId,
		controlPlane: queue,
		providerAdapter: provider,
		dispatchConcurrency: options.dispatchConcurrency ?? 8,
	});
	const stop = new AbortController();
	const running = orchestrator.run(stop.signal, {
		pollIntervalMs: options.pollIntervalMs ?? 20,
		reconcileIntervalMs: options.reconcileIntervalMs ?? 60_000,
		shutdownGraceMs: 100,
		...(options.wake ? { wake: options.wake, wakeBackstopMs: options.wakeBackstopMs ?? 400 } : {}),
		...(options.wakeActiveMs !== undefined ? { wakeActiveMs: options.wakeActiveMs } : {}),
		...(options.wakePassGapMs !== undefined ? { wakePassGapMs: options.wakePassGapMs } : {}),
		onError: (error) => errors.push(error),
	});
	cleanup.push(async () => {
		stop.abort();
		await running;
	});
	const calls = () => claimNext.mock.calls.length;
	return { queue, acquired, errors, starts, calls, passes };
}

describe("node WebSocket client", () => {
	it("exchanges text, answers pings and puts fragmented messages back together", async () => {
		const realtime = await fakeRealtime();
		const received: string[] = [];
		const socket = await NodeWebSocket.connect(
			new URL(`${realtime.url.replace("http", "ws")}/realtime/v1/websocket?apikey=k`),
			{ message: (text) => received.push(text), close: () => undefined },
		);
		cleanup.push(() => socket.close());
		// 200 bytes out takes the 16-bit length; the server reads it back as a join.
		socket.send(
			JSON.stringify({ topic: "realtime:t", event: "phx_join", payload: { pad: "x".repeat(200) }, ref: "1" }),
		);
		await until(() => received.length === 1);
		expect(JSON.parse(received[0]!)).toMatchObject({ event: "phx_reply", payload: { status: "ok" } });
		realtime.sendRaw(serverFrame(0x9, Buffer.from("are you there")));
		await until(() => realtime.pongs.length === 1);
		expect(realtime.pongs[0]!.toString()).toBe("are you there");
		// A 70,000-byte message in three frames takes the 64-bit length and continuation frames.
		const big = JSON.stringify({ event: "broadcast", payload: "y".repeat(70_000) });
		const bytes = Buffer.from(big);
		realtime.sendRaw(
			Buffer.concat([
				serverFrame(0x1, bytes.subarray(0, 10), false),
				serverFrame(0x0, bytes.subarray(10, 69_000), false),
				serverFrame(0x9, Buffer.from("between fragments")),
				serverFrame(0x0, bytes.subarray(69_000), true),
			]),
		);
		await until(() => received.length === 2);
		expect(received[1]).toBe(big);
		// The pong written between fragments reaches the server on its own schedule.
		await until(() => realtime.pongs.length === 2);
		expect(realtime.pongs[1]!.toString()).toBe("between fragments");
		socket.close();
		await until(() => realtime.closes.length === 1);
		expect(realtime.closes).toEqual([1000]);
	});

	it("closes on a masked or reserved-bit frame from the server", async () => {
		for (const frame of [
			serverFrame(0x1, Buffer.from("masked"), true, true),
			Buffer.from([0xc1, 0x00]),
			serverFrame(0x3, Buffer.from("unknown opcode")),
		]) {
			const realtime = await fakeRealtime();
			const closed: string[] = [];
			await NodeWebSocket.connect(new URL(`${realtime.url.replace("http", "ws")}/realtime/v1/websocket`), {
				message: () => undefined,
				close: (reason) => closed.push(reason),
			});
			realtime.sendRaw(frame);
			await until(() => closed.length === 1);
		}
	});
});

describe("Realtime wake-up channel", () => {
	function channel(realtime: FakeRealtime, topic: () => string, options: { heartbeatMs?: number } = {}) {
		const states: Array<[RealtimeOrchestratorWakeState, string | undefined]> = [];
		const wake = new RealtimeOrchestratorWake({
			supabaseUrl: realtime.url,
			publishableKey: "sb_publishable_test",
			topic,
			heartbeatMs: options.heartbeatMs ?? 60_000,
			reconnectInitialMs: 20,
			reconnectMaximumMs: 100,
			onState: (state, reason) => states.push([state, reason]),
		});
		let wakeUps = 0;
		wake.subscribe(() => wakeUps++);
		wake.start();
		cleanup.push(() => wake.stop());
		return { wake, states, wakeUps: () => wakeUps };
	}

	it("joins the orchestrator's private topic with the publishable key and passes its wake-ups on", async () => {
		const realtime = await fakeRealtime();
		const topic = cloudRunnerOrchestratorWakeTopic("c".repeat(43));
		// The database derives the same name from the stored sha256 (0c49d892…); its SQL test pins this value.
		expect(topic).toBe("qorpera-orchestrator-wake-cab2795dd16fc7b4a1303f59434bd9ff1be1cac1204e30dcf267af3c56a1da88");
		const { wake, states, wakeUps } = channel(realtime, () => topic);
		await until(() => wake.listening);
		expect(realtime.apikeys).toEqual(["sb_publishable_test"]);
		expect(realtime.joins).toEqual([
			{
				topic,
				payload: {
					config: {
						broadcast: { ack: false, self: false },
						presence: { key: "", enabled: false },
						postgres_changes: [],
						private: true,
					},
				},
			},
		]);
		expect(states).toEqual([["joined", undefined]]);
		// The join itself counts as a wake-up: anything announced before it is looked for.
		expect(wakeUps()).toBe(1);
		expect(realtime.wake(topic)).toBe(1);
		expect(realtime.wake(cloudRunnerOrchestratorWakeTopic("d".repeat(43)))).toBe(0);
		await until(() => wakeUps() === 2);
		await sleep(50);
		expect(wakeUps()).toBe(2);
	});

	it("stays off while Realtime refuses the channel and joins once it accepts", async () => {
		const realtime = await fakeRealtime();
		realtime.refuseJoins = true;
		const topic = cloudRunnerOrchestratorWakeTopic("c".repeat(43));
		const { wake, states } = channel(realtime, () => topic);
		await until(() => realtime.joins.length >= 2);
		expect(wake.listening).toBe(false);
		expect(states[0]).toEqual(["refused", "Realtime refused the wake-up channel"]);
		realtime.refuseJoins = false;
		await until(() => wake.listening);
		expect(states.at(-1)).toEqual(["joined", undefined]);
	});

	it("reconnects after a dropped connection and after an unanswered heartbeat", async () => {
		const realtime = await fakeRealtime();
		const topic = cloudRunnerOrchestratorWakeTopic("c".repeat(43));
		const { wake, states, wakeUps } = channel(realtime, () => topic, { heartbeatMs: 50 });
		await until(() => wake.listening);
		realtime.dropAll();
		await until(() => !wake.listening);
		// Losing the channel is reported to the claim loop, which then asks for work at once.
		expect(wakeUps()).toBe(2);
		await until(() => wake.listening && realtime.connections === 2);
		realtime.answerHeartbeats = false;
		await until(() => states.some(([state, reason]) => state === "dropped" && /heartbeat/.test(reason ?? "")));
		realtime.answerHeartbeats = true;
		await until(() => wake.listening && realtime.connections >= 3);
		expect(realtime.wake(topic)).toBe(1);
		const before = wakeUps();
		await until(() => wakeUps() === before + 1);
	});

	it("moves to the new topic at once when told the control token rotated", async () => {
		const realtime = await fakeRealtime();
		let token = "c".repeat(43);
		const { wake } = channel(realtime, () => cloudRunnerOrchestratorWakeTopic(token));
		await until(() => wake.listening);
		token = "e".repeat(43);
		const next = cloudRunnerOrchestratorWakeTopic(token);
		wake.refresh();
		// Not listening until the new topic is joined, so the loop polls meanwhile.
		expect(wake.listening).toBe(false);
		await until(() => wake.listening, 1000);
		expect(realtime.joins.at(-1)?.topic).toBe(next);
		expect(realtime.wake(next)).toBe(1);
	});

	it("drops and rejoins a channel whose join is never answered", async () => {
		const realtime = await fakeRealtime();
		realtime.ignoreJoins = true;
		const topic = cloudRunnerOrchestratorWakeTopic("c".repeat(43));
		const states: string[] = [];
		const wake = new RealtimeOrchestratorWake({
			supabaseUrl: realtime.url,
			publishableKey: "sb_publishable_test",
			topic: () => topic,
			heartbeatMs: 50,
			connectTimeoutMs: 100,
			reconnectInitialMs: 20,
			reconnectMaximumMs: 20,
			onState: (state, reason) => states.push(`${state}: ${reason ?? ""}`),
		});
		wake.start();
		cleanup.push(() => wake.stop());
		await until(() => states.includes("dropped: Realtime did not answer the join"));
		realtime.ignoreJoins = false;
		await until(() => wake.listening);
		expect(realtime.connections).toBeGreaterThanOrEqual(2);
	});

	it("moves to the new topic when the control token rotates", async () => {
		const realtime = await fakeRealtime();
		let token = "c".repeat(43);
		const { wake, wakeUps } = channel(realtime, () => cloudRunnerOrchestratorWakeTopic(token), { heartbeatMs: 30 });
		await until(() => wake.listening);
		const old = cloudRunnerOrchestratorWakeTopic(token);
		token = "e".repeat(43);
		const next = cloudRunnerOrchestratorWakeTopic(token);
		await until(() => realtime.joins.some((join) => join.topic === next) && wake.listening);
		expect(realtime.leaves).toEqual([old]);
		expect(realtime.wake(old)).toBe(0);
		const before = wakeUps();
		expect(realtime.wake(next)).toBe(1);
		await until(() => wakeUps() === before + 1);
	});
});

describe("claim loop with wake-ups", () => {
	it("asks for work at the backstop while wake-ups arrive, and at once on a wake-up", async () => {
		const wake = new ManualWake();
		const f = loop({ wake, wakeBackstopMs: 1000 });
		await until(() => f.calls() === 1);
		await sleep(2100);
		// Without wake-ups the loop asks every 20 ms (about 100 times in these two seconds); with them, every 1 s.
		expect(f.calls()).toBeGreaterThanOrEqual(2);
		expect(f.calls()).toBeLessThanOrEqual(4);
		f.queue.queued.push(fakeWork(runId(1)));
		const queuedAt = Date.now();
		wake.fire();
		await until(() => f.acquired.length === 1);
		expect(f.queue.claimed.get(runId(1))! - queuedAt).toBeLessThan(300);
		// An announced job never counts as a missed wake-up.
		await sleep(2300);
		expect(f.errors).toEqual([]);
	});

	it("still claims within the backstop when a wake-up is lost, and then polls as without wake-ups", async () => {
		const wake = new ManualWake();
		const f = loop({ wake });
		await until(() => f.calls() === 1);
		await sleep(100);
		f.queue.queued.push(fakeWork(runId(1)));
		const queuedAt = Date.now();
		await until(() => f.acquired.length === 1);
		expect(f.queue.claimed.get(runId(1))! - queuedAt).toBeLessThanOrEqual(700);
		await until(() => f.errors.length === 1, 5000);
		expect(f.errors[0]).toBeInstanceOf(CloudRunnerWakeMissed);
	});

	it("treats a burst of wake-ups as one", async () => {
		const wake = new ManualWake();
		const f = loop({ wake, dispatchConcurrency: 1 });
		await until(() => f.calls() === 1);
		await sleep(50);
		f.queue.queued.push(fakeWork(runId(1)));
		const before = f.calls();
		const firedAt = performance.now();
		for (let index = 0; index < 100; index++) wake.fire();
		await until(() => f.acquired.length === 1);
		await sleep(150);
		const elapsed = performance.now() - firedAt;
		// However many wake-ups arrive, they add at most one claim per 20 ms poll interval.
		expect(f.calls() - before).toBeLessThanOrEqual(2 * Math.ceil(elapsed / 20) + 2);
		expect(f.acquired).toEqual([runId(1)]);
	});

	it("does not storm the control plane when many jobs arrive", async () => {
		const wake = new ManualWake();
		const f = loop({ wake, dispatchConcurrency: 4, acquireMs: 30 });
		await until(() => f.calls() === 1);
		const before = f.calls();
		const started = performance.now();
		for (let n = 1; n <= 30; n++) {
			f.queue.queued.push(fakeWork(runId(n)));
			wake.fire();
			await sleep(5);
		}
		await until(() => f.acquired.length === 30);
		const elapsed = performance.now() - started;
		expect(new Set(f.acquired).size).toBe(30);
		expect(f.starts.peak).toBeLessThanOrEqual(4);
		// Each claim batch asks until it has a job for every free slot or the queue is empty: at most one
		// call per job plus one empty answer per batch; batches follow the 20 ms poll, and wake-ups add at
		// most one more per interval.
		expect(f.calls() - before).toBeLessThanOrEqual(30 + 2 * Math.ceil(elapsed / 20) + 2);
	});

	it("claims work announced while every slot was busy as soon as a slot frees", async () => {
		const wake = new ManualWake();
		const f = loop({ wake, wakeBackstopMs: 5000, wakeActiveMs: 50, dispatchConcurrency: 1, acquireMs: 400 });
		await until(() => f.calls() === 1);
		f.queue.queued.push(fakeWork(runId(1)));
		wake.fire();
		await until(() => f.acquired.length === 1);
		// The only slot is busy for 400 ms, long after the 50 ms activity window: the loop is back on its
		// 5 s backstop when the second job is announced.
		await sleep(150);
		f.queue.queued.push(fakeWork(runId(2)));
		wake.fire();
		const announcedAt = Date.now();
		await until(() => f.acquired.length === 2);
		expect(Date.now() - announcedAt).toBeLessThan(1000);
	});

	it("does not report a missed wake-up that arrives while the claim that finds its work is in flight", async () => {
		const wake = new ManualWake();
		const f = loop({ wake, wakeBackstopMs: 300 });
		await until(() => f.calls() === 1);
		const claimNext = FakeClaimQueue.prototype.claimNext.bind(f.queue);
		vi.spyOn(f.queue, "claimNext").mockImplementation(async (...args) => {
			const claim = await claimNext(...args);
			// The job's wake-up lands while this backstop claim is still on its way back.
			if (claim) wake.fire();
			await sleep(50);
			return claim;
		});
		f.queue.queued.push(fakeWork(runId(1)));
		await until(() => f.acquired.length === 1);
		await sleep(2300);
		expect(f.errors).toEqual([]);
	});

	it("keeps a poll interval above the backstop when wake-ups are off", async () => {
		const f = loop({ pollIntervalMs: 6000 });
		await until(() => f.calls() === 1);
		expect(f.errors).toEqual([]);
	});

	it("asks every poll interval while wake-ups are not being delivered", async () => {
		const wake = new ManualWake();
		wake.listening = false;
		const f = loop({ wake });
		await until(() => f.calls() === 1);
		await sleep(400);
		expect(f.calls()).toBeGreaterThanOrEqual(10);
	});

	it("falls back to polling while the Realtime channel is down and slows down again once it rejoins", async () => {
		const realtime = await fakeRealtime();
		const token = "c".repeat(43);
		const topic = cloudRunnerOrchestratorWakeTopic(token);
		const wake = new RealtimeOrchestratorWake({
			supabaseUrl: realtime.url,
			publishableKey: "sb_publishable_test",
			topic: () => topic,
			heartbeatMs: 60_000,
			reconnectInitialMs: 400,
			reconnectMaximumMs: 400,
		});
		wake.start();
		cleanup.push(() => wake.stop());
		await until(() => wake.listening);
		const f = loop({ wake, wakeBackstopMs: 1000 });
		await until(() => f.calls() >= 1);
		await sleep(500);
		expect(f.calls()).toBeLessThanOrEqual(2);
		realtime.dropAll();
		await until(() => !wake.listening);
		const down = f.calls();
		await sleep(300);
		// While the channel is down the loop asks every 20 ms.
		expect(f.calls() - down).toBeGreaterThanOrEqual(8);
		await until(() => wake.listening);
		f.queue.queued.push(fakeWork(runId(1)));
		const queuedAt = Date.now();
		realtime.wake(topic);
		await until(() => f.acquired.length === 1);
		expect(f.queue.claimed.get(runId(1))! - queuedAt).toBeLessThan(300);
		expect(f.errors).toEqual([]);
	});
});

describe("reconcile passes with wake-ups", () => {
	// The loop's reconcile interval is 60 s, so every pass after the first is one a wake-up brought forward.
	it("starts the next pass on a wake-up instead of waiting for the reconcile interval", async () => {
		const wake = new ManualWake();
		const f = loop({ wake, wakeBackstopMs: 20, wakePassGapMs: 100 });
		await until(() => f.queue.reconcilePasses === 1);
		await sleep(300);
		expect(f.queue.reconcilePasses).toBe(1);
		const firedAt = performance.now();
		wake.fire();
		await until(() => f.queue.reconcilePasses === 2, 1000);
		expect(performance.now() - firedAt).toBeLessThan(150);
		expect(f.errors).toEqual([]);
	});

	it("keeps passes it brings forward at least the gap apart, however many wake-ups arrive", async () => {
		const wake = new ManualWake();
		const f = loop({ wake, wakeBackstopMs: 20, wakePassGapMs: 200 });
		await until(() => f.queue.reconcilePasses === 1);
		const before = f.queue.reconcilePasses;
		const started = performance.now();
		while (performance.now() - started < 1000) {
			wake.fire();
			await sleep(5);
		}
		await sleep(250);
		const elapsed = performance.now() - started;
		const added = f.queue.reconcilePasses - before;
		// About 200 wake-ups in a second: one pass per 200 ms gap, never one per wake-up.
		expect(added).toBeGreaterThanOrEqual(3);
		expect(added).toBeLessThanOrEqual(Math.ceil(elapsed / 200) + 1);
	});

	it("follows a pass that was running when the wake-up came with another as soon as it ends", async () => {
		const wake = new ManualWake();
		const f = loop({ wake, wakeBackstopMs: 20, wakePassGapMs: 0, reconcileDelayMs: 300 });
		await sleep(100);
		// The first pass is still in reconcileExpired: it may have listed before the row the wake-up announces.
		expect(f.queue.reconcilePasses).toBe(0);
		wake.fire();
		await until(() => f.queue.reconcilePasses === 1);
		const firstEnded = performance.now();
		await until(() => f.queue.reconcilePasses === 2, 1000);
		expect(performance.now() - firstEnded).toBeLessThan(450);
	});

	it("leaves the reconcile interval alone without wake-ups", async () => {
		const f = loop({});
		await until(() => f.queue.reconcilePasses === 1);
		await sleep(400);
		expect(f.queue.reconcilePasses).toBe(1);
	});

	/** Wake-ups every 5 ms for `ms`, then the rests between the passes (one's end to the next one's start). */
	async function restsUnderWakeUps(f: ReturnType<typeof loop>, wake: ManualWake, ms: number): Promise<number[]> {
		await until(() => f.passes.length >= 1 && f.passes[0]!.end !== undefined);
		const started = performance.now();
		while (performance.now() - started < ms) {
			wake.fire();
			await sleep(5);
		}
		const done = f.passes.filter((pass) => pass.end !== undefined);
		return done.slice(1).map((pass, index) => pass.start - done[index]!.end!);
	}

	it("rests the gap after a long pass, however many wake-ups arrive during it", async () => {
		const wake = new ManualWake();
		const f = loop({ wake, wakeBackstopMs: 20, wakePassGapMs: 200, reconcileDelayMs: 300 });
		const rests = await restsUnderWakeUps(f, wake, 1600);
		// Passes of 300 ms with wake-ups throughout: one follow-up each, never back to back.
		expect(rests.length).toBeGreaterThanOrEqual(2);
		for (const rest of rests) expect(rest).toBeGreaterThanOrEqual(180);
	});

	it("brings no pass sooner than the reconcile interval while the summary call fails", async () => {
		const wake = new ManualWake();
		const f = loop({
			wake,
			wakeBackstopMs: 20,
			wakePassGapMs: 50,
			reconcileIntervalMs: 400,
			passDue: async () => {
				throw new Error("summary unavailable");
			},
		});
		// Each such pass asks every list itself: wake-ups must not raise their rate.
		const rests = await restsUnderWakeUps(f, wake, 1500);
		expect(rests.length).toBeGreaterThanOrEqual(2);
		for (const rest of rests) expect(rest).toBeGreaterThanOrEqual(350);
		expect(f.errors.some((error) => error instanceof Error && error.message === "summary unavailable")).toBe(true);
	});

	it("brings no pass sooner than the reconcile interval when the control plane has no summary call", async () => {
		const wake = new ManualWake();
		const f = loop({ wake, wakeBackstopMs: 20, wakePassGapMs: 50, reconcileIntervalMs: 400, passDue: false });
		const rests = await restsUnderWakeUps(f, wake, 1500);
		expect(rests.length).toBeGreaterThanOrEqual(2);
		for (const rest of rests) expect(rest).toBeGreaterThanOrEqual(350);
	});

	it("lets a pass that starts on its own take the place of one a wake-up was waiting for", async () => {
		const wake = new ManualWake();
		// The interval (600 ms) is shorter than the gap (1500 ms): the pass the wake-up waits for is never needed.
		const f = loop({ wake, wakeBackstopMs: 20, wakePassGapMs: 1500, reconcileIntervalMs: 600 });
		await until(() => f.passes.length === 1 && f.passes[0]!.end !== undefined);
		await sleep(100);
		wake.fire();
		await sleep(2000);
		const starts = f.passes.map((pass) => pass.start);
		expect(starts.length).toBeGreaterThanOrEqual(3);
		// Without the hand-over the wake-up's own pass lands 1.5 s after the first, between two interval passes.
		for (let index = 1; index < starts.length; index++) {
			expect(starts[index]! - starts[index - 1]!).toBeGreaterThanOrEqual(550);
		}
	});
});
