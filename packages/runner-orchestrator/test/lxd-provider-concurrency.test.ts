import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LxdUnixClient } from "../src/lxd-client.ts";
import { HttpLxdGuestTransport, LxdCloudRunnerProviderBackend, type LxdGuestTransport } from "../src/lxd-provider.ts";
import {
	type CloudRunnerAssignmentDelivery,
	type CloudRunnerInstance,
	CloudRunnerOrchestrator,
	type CloudRunnerProviderAdapter,
} from "../src/orchestrator.ts";
import { readRuntimeNodeHost } from "../src/runtime-node-host.ts";
import {
	FakeClaimQueue,
	FakeLxdSocket,
	type FakeLxdTimings,
	fakeProviderConfig,
	fakeWork,
} from "./helpers/lxd-socket-fake.ts";

vi.mock("../src/runtime-node-host.ts", () => ({ readRuntimeNodeHost: vi.fn() }));
beforeEach(() => {
	vi.mocked(readRuntimeNodeHost)
		.mockReset()
		.mockResolvedValue({ machineIdSha256: "e".repeat(64), cpuMillis: 64000, memoryBytes: 256 * 1024 ** 3 });
});

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

const orchestratorId = "11111111-1111-4111-8111-111111111111";
const runIds = [1, 2, 3, 4].map((n) => `30000000-0000-4000-8000-00000000000${n}`);
const instance = FakeLxdSocket.instanceName;

async function fixture(options: { timings?: Partial<FakeLxdTimings>; guestReadyTimeoutMs?: number } = {}) {
	const lxd = new FakeLxdSocket(options.timings);
	await lxd.start();
	const directory = await mkdtemp(join(tmpdir(), "qorpera-lxd-concurrency-"));
	cleanup.push(async () => {
		await lxd.close();
		await rm(directory, { recursive: true, force: true });
	});
	const client = new LxdUnixClient(lxd.socket, 30);
	const settings = {
		...fakeProviderConfig(join(directory, "state")),
		guestReadyTimeoutMs: options.guestReadyTimeoutMs ?? 10_000,
	};
	const provider = (guest: LxdGuestTransport = new HttpLxdGuestTransport(client, lxd.fetch)) =>
		new LxdCloudRunnerProviderBackend(settings, client, guest, lxd.fetch);
	return {
		lxd,
		provider,
		stateRoot: settings.stateRoot,
		backend: provider(),
		journal: async (acquisitionId: string) =>
			JSON.parse(await readFile(join(settings.stateRoot, acquisitionId, "journal.json"), "utf8")) as Record<
				string,
				unknown
			>,
		releases: () => lxd.rpcCalls.filter((call) => call.name === "qorpera_release_runtime_machine").length,
	};
}

function delivery(runId: string, runner: CloudRunnerInstance): CloudRunnerAssignmentDelivery {
	const work = fakeWork(runId);
	return {
		assignment: {
			assignmentId: runId.replace(/^.{8}/, "50000000"),
			claimId: runId.replace(/^.{8}/, "60000000"),
			runId,
			jobId: work.jobId,
			runnerId: runner.runnerId,
			capabilitySha256: "c".repeat(64),
			expiresAt: "2099-08-21T18:00:00.000Z",
		},
		capability: "d".repeat(43),
		work,
	};
}

async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
	while (!(await condition())) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
}

describe("LXD provider concurrency", () => {
	it("boots independent runs side by side and creates their shared identity volume once", async () => {
		const f = await fixture();
		const runners = await Promise.all(
			runIds.map((runId) => f.backend.acquire(runId, fakeWork(runId), new AbortController().signal)),
		);
		// Before 29 Sep 2026 one provider-wide lock held each acquisition through its boot: one VM at a time.
		expect(f.lxd.peakBooting).toBe(4);
		expect(new Set(runners.map((runner) => runner.runnerId)).size).toBe(4);
		expect(f.lxd.volumes.size).toBe(1);
		for (const runId of runIds) expect(await f.journal(runId)).toMatchObject({ physicalState: "registered" });
		await Promise.all(runners.map((runner, index) => f.backend.deliver(runner, delivery(runIds[index]!, runner))));
		expect(f.lxd.deliveries.sort()).toEqual(runIds.map(instance).sort());
		await Promise.all(runners.map((runner) => f.backend.stop(runner, "idle")));
		expect(f.lxd.instances.size).toBe(0);
		expect(f.releases()).toBe(4);
		expect(f.lxd.unexpected).toEqual([]);
	});

	it("keeps the node ceiling when acquisitions run side by side", async () => {
		const f = await fixture();
		f.lxd.nodeCeiling = 2;
		const results = await Promise.allSettled(
			runIds.map((runId) => f.backend.acquire(runId, fakeWork(runId), new AbortController().signal)),
		);
		const admitted = runIds.flatMap((runId, index) => {
			const result = results[index];
			return result?.status === "fulfilled" ? [{ runId, runner: result.value }] : [];
		});
		const refused = runIds.filter((_, index) => results[index]?.status === "rejected");
		expect(admitted).toHaveLength(2);
		expect(results.filter((result) => result.status === "rejected").map((result) => result.reason)).toEqual([
			expect.objectContaining({ name: "LxdMachineAdmissionRefused", reason: "NODE_CAPACITY_EXHAUSTED" }),
			expect.objectContaining({ name: "LxdMachineAdmissionRefused", reason: "NODE_CAPACITY_EXHAUSTED" }),
		]);
		expect(f.lxd.peakInstances).toBe(2);
		for (const runId of refused) {
			const journal = await f.journal(runId);
			expect(journal).toMatchObject({ physicalState: "reserving", capacityRegistered: true });
			expect(journal.nodeCapacity).toBeUndefined();
		}
		// A retired guest frees its slot, and a refused acquisition starts when it is tried again.
		await f.backend.stop(admitted[0]!.runner, "idle");
		await f.backend.acquire(refused[0]!, fakeWork(refused[0]!), new AbortController().signal);
		await expect(
			f.backend.acquire(refused[1]!, fakeWork(refused[1]!), new AbortController().signal),
		).rejects.toMatchObject({ reason: "NODE_CAPACITY_EXHAUSTED" });
		expect(f.lxd.peakInstances).toBe(2);
		expect(f.lxd.unexpected).toEqual([]);
	});

	it("starts, delivers, stops and reconciles other runs while one guest hangs in its boot", async () => {
		const f = await fixture({ guestReadyTimeoutMs: 60_000 });
		const [slow, failed, first, second] = runIds as [string, string, string, string];
		f.lxd.neverReady.add(instance(slow));
		f.lxd.failCreate.add(instance(failed));
		const cancel = new AbortController();
		let slowSettled = false;
		const slowAcquire = f.backend.acquire(slow, fakeWork(slow), cancel.signal).finally(() => {
			slowSettled = true;
		});
		slowAcquire.catch(() => undefined);
		await expect(f.backend.acquire(failed, fakeWork(failed), new AbortController().signal)).rejects.toMatchObject({
			category: "provider_step",
			stage: "create",
		});
		const [one, two] = await Promise.all(
			[first, second].map((runId) => f.backend.acquire(runId, fakeWork(runId), new AbortController().signal)),
		);
		await until(async () => (await f.journal(slow)).physicalState === "bootstrapping");
		// Reconcile leaves the journal an acquisition holds to it and settles the others.
		await f.backend.reconcile();
		await f.backend.deliver(one!, delivery(first, one!));
		await f.backend.stop(two!, "idle");
		expect(slowSettled).toBe(false);
		expect(await f.journal(slow)).toMatchObject({ physicalState: "bootstrapping" });
		expect(await f.journal(failed)).toMatchObject({ physicalState: "lost", capacityReleased: true });
		expect(await f.journal(first)).toMatchObject({ physicalState: "assigned" });
		expect(await f.journal(second)).toMatchObject({ physicalState: "stopped", capacityReleased: true });

		// A cancelled boot is marked for retirement, and the next pass retires it.
		cancel.abort();
		await expect(slowAcquire).rejects.toThrow();
		expect(await f.journal(slow)).toMatchObject({ physicalState: "stopping", stopReason: "delivery_failed" });
		await f.backend.reconcile();
		expect(await f.journal(slow)).toMatchObject({ physicalState: "stopped", capacityReleased: true });
		expect([...f.lxd.instances.keys()]).toEqual([instance(first)]);
		expect(f.lxd.unexpected).toEqual([]);
	});

	it("retires ended runs' guests under their own locks and leaves one a delivery holds", async () => {
		const f = await fixture();
		const [held, idle] = runIds as [string, string];
		const [heldRunner, idleRunner] = await Promise.all(
			[held, idle].map((runId) => f.backend.acquire(runId, fakeWork(runId), new AbortController().signal)),
		);
		// Both guests waited past the grace period for their one assignment, and both jobs ended.
		for (const runId of [held, idle]) {
			const path = join(f.stateRoot, runId, "journal.json");
			const journal = await f.journal(runId);
			await writeFile(
				path,
				JSON.stringify({ ...journal, updatedAt: new Date(Date.now() - 3 * 60_000).toISOString() }),
				{
					mode: 0o600,
				},
			);
		}
		f.lxd.endedRunners.add(heldRunner!.runnerId).add(idleRunner!.runnerId);
		f.lxd.deliveryMs = 500;
		const delivering = f.backend.deliver(heldRunner!, delivery(held, heldRunner!));
		await until(() => f.lxd.deliveries.length === 1);
		await f.backend.reconcile();
		expect(await f.journal(idle)).toMatchObject({ physicalState: "stopped", stopReason: "revoked" });
		expect(await f.journal(held)).toMatchObject({ physicalState: "registered" });
		await delivering;
		expect(await f.journal(held)).toMatchObject({ physicalState: "assigned" });
		expect([...f.lxd.instances.keys()]).toEqual([instance(held)]);
		expect(f.lxd.unexpected).toEqual([]);
	});

	it("resumes boots a stopped provider left behind while new runs start beside them", async () => {
		const f = await fixture();
		const [first, second, third] = runIds as [string, string, string];
		// A provider that stopped responding after starting each guest's bootstrap unit.
		const frozen: LxdGuestTransport = {
			waitReady: () => new Promise<string>(() => undefined),
			deliver: async () => undefined,
		};
		const stopped = f.provider(frozen);
		for (const runId of [first, second])
			void stopped.acquire(runId, fakeWork(runId), new AbortController().signal).catch(() => undefined);
		await until(async () => {
			const journals = await Promise.all([first, second].map((runId) => f.journal(runId).catch(() => undefined)));
			return journals.every((journal) => journal?.physicalState === "bootstrapping");
		});
		const restarted = f.provider();
		const [runner] = await Promise.all([
			restarted.acquire(third, fakeWork(third), new AbortController().signal),
			restarted.reconcile(),
		]);
		for (const runId of [first, second, third]) {
			expect(await f.journal(runId)).toMatchObject({
				physicalState: "registered",
				guestAddress: expect.any(String),
			});
			// The one-shot bootstrap unit is never started a second time.
			expect(f.lxd.bootstrapRuns.get(instance(runId))).toBe(1);
		}
		expect(runner.runnerId).toBe(f.lxd.runnerFor(third));
		expect(f.lxd.unexpected).toEqual([]);
	});
});

describe("orchestrator over the LXD provider", () => {
	function inProcess(backend: LxdCloudRunnerProviderBackend): CloudRunnerProviderAdapter {
		return {
			adapterId: backend.adapterId,
			reconcile: (signal) => backend.reconcile(signal),
			acquire: (work, signal) => backend.acquire(work.runId, work, signal),
			deliver: (runner, assignment, signal) => backend.deliver(runner, assignment, signal),
			stop: (runner, reason, signal) => backend.stop(runner, reason, signal),
		};
	}

	it("claims and starts a second run while the first guest is still booting", async () => {
		const f = await fixture({ timings: { agent: 300, ready: 300 } });
		const queue = new FakeClaimQueue(orchestratorId);
		const orchestrator = new CloudRunnerOrchestrator({
			orchestratorId,
			controlPlane: queue,
			providerAdapter: inProcess(f.backend),
			dispatchConcurrency: 8,
		});
		const stop = new AbortController();
		const errors: unknown[] = [];
		const running = orchestrator.run(stop.signal, {
			pollIntervalMs: 20,
			reconcileIntervalMs: 20,
			shutdownGraceMs: 1000,
			onError: (error) => errors.push(error),
		});
		cleanup.push(async () => {
			stop.abort();
			await running;
		});
		const [first, second] = runIds as [string, string];
		const booted = (runId: string) =>
			f.lxd.events.find((event) => event.instance === instance(runId) && event.event === "ready")?.at;
		queue.queued.push(fakeWork(first));
		await until(() => f.lxd.events.some((event) => event.instance === instance(first) && event.event === "start"));
		const passesAtStart = queue.reconcilePasses;
		queue.queued.push(fakeWork(second));
		await until(() => queue.claimed.has(second));
		expect(booted(first)).toBeUndefined();
		await until(() => f.lxd.deliveries.length === 2);
		// Reconcile kept its own pace while the first guest booted, and the two guests booted together.
		expect(queue.reconcilePasses - passesAtStart).toBeGreaterThan(2);
		expect(queue.claimed.get(second)!).toBeLessThan(booted(first)!);
		expect(f.lxd.peakBooting).toBe(2);
		expect(errors).toEqual([]);
		expect(f.lxd.unexpected).toEqual([]);
	});
});
