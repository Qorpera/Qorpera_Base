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

/** An orchestrator over a queue the test fills, with a provider whose starts take `acquireMs`. */
function loop(
	options: {
		wake?: CloudRunnerWakeSource;
		pollIntervalMs?: number;
		wakeBackstopMs?: number;
		wakeActiveMs?: number;
		dispatchConcurrency?: number;
		acquireMs?: number;
	} = {},
) {
	const queue = new FakeClaimQueue(orchestratorId);
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
		reconcileIntervalMs: 60_000,
		shutdownGraceMs: 100,
		...(options.wake ? { wake: options.wake, wakeBackstopMs: options.wakeBackstopMs ?? 400 } : {}),
		...(options.wakeActiveMs !== undefined ? { wakeActiveMs: options.wakeActiveMs } : {}),
		onError: (error) => errors.push(error),
	});
	cleanup.push(async () => {
		stop.abort();
		await running;
	});
	const calls = () => claimNext.mock.calls.length;
	return { queue, acquired, errors, starts, calls };
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
		expect(realtime.pongs).toHaveLength(2);
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
		expect(topic).toMatch(/^qorpera-orchestrator-wake-[0-9a-f]{64}$/);
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
