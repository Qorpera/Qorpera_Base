import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { type ClaimedSurfaceJobs, SurfaceWorkerLoop } from "../src/surface-worker-loop.ts";

describe("SurfaceWorkerLoop horizontal scaling and drain", () => {
	it("reuses machines under target density and spawns overflow machines when existing VMs are full", async () => {
		const profileId = randomUUID();
		const surfaceId = randomUUID();
		const existingMachineId = randomUUID();
		const overflowMachineId = randomUUID();
		const s1 = randomUUID();
		const s2 = randomUUID();
		const p1 = randomUUID();

		const batch: ClaimedSurfaceJobs = {
			sessions: [
				{
					sessionId: s1,
					surfaceId,
					profileId,
					state: "queued",
					prompt: "Add Danish FAQ",
					originKind: "member",
					originRef: null,
					repositoryKey: "thetaband/website",
					placement: { strategy: "reuse_machine", machineId: existingMachineId, activeTurns: 2, targetDensity: 6 },
				},
				{
					sessionId: s2,
					surfaceId,
					profileId,
					state: "queued",
					prompt: "Refine mobile header",
					originKind: "point_to_change",
					originRef: { selector: "header.site-nav", route: "/" },
					repositoryKey: "thetaband/website",
					placement: { strategy: "spawn_overflow_machine", machineId: null, activeTurns: 0, targetDensity: 6 },
				},
			],
			previews: [
				{
					previewId: p1,
					surfaceId,
					profileId,
					shortHostId: "ab12cd34",
					baseSha: "a".repeat(40),
					selectedChangeIds: [randomUUID()],
					repositoryKey: "thetaband/website",
				},
			],
		};

		const claimPendingJobs = vi.fn().mockResolvedValue(batch);
		const spawnOverflowMachine = vi.fn().mockResolvedValue({ machineId: overflowMachineId });
		const dispatchSessionTurn = vi.fn().mockResolvedValue(undefined);
		const runPreviewJob = vi.fn().mockResolvedValue(undefined);
		const events: Record<string, unknown>[] = [];

		const loop = new SurfaceWorkerLoop({
			claimPendingJobs,
			spawnOverflowMachine,
			dispatchSessionTurn,
			runPreviewJob,
			onEvent: (event) => events.push(event),
		});

		const result = await loop.tick(new AbortController().signal);
		expect(result).toEqual({ startedSessions: 2, startedPreviews: 1 });
		expect(spawnOverflowMachine).toHaveBeenCalledTimes(1);
		expect(spawnOverflowMachine).toHaveBeenCalledWith(profileId, expect.any(AbortSignal));
		expect(dispatchSessionTurn).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: s1 }),
			existingMachineId,
			expect.any(AbortSignal),
		);
		expect(dispatchSessionTurn).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: s2 }),
			overflowMachineId,
			expect.any(AbortSignal),
		);
		expect(runPreviewJob).toHaveBeenCalledWith(expect.objectContaining({ previewId: p1 }), expect.any(AbortSignal));
		expect(loop.inFlightSessionCount).toBe(0);
		expect(loop.inFlightPreviewCount).toBe(0);
		expect(events.some((event) => event.kind === "overflow_machine_spawned")).toBe(true);
	});

	it("deduplicates in-flight sessions across overlapping ticks", async () => {
		const sessionId = randomUUID();
		const machineId = randomUUID();
		let release!: () => void;
		const blocker = new Promise<void>((resolve) => {
			release = resolve;
		});

		const batch: ClaimedSurfaceJobs = {
			sessions: [
				{
					sessionId,
					surfaceId: randomUUID(),
					profileId: randomUUID(),
					state: "queued",
					prompt: "Long task",
					originKind: "member",
					originRef: null,
					repositoryKey: "thetaband/website",
					placement: { strategy: "reuse_machine", machineId, activeTurns: 0, targetDensity: 6 },
				},
			],
			previews: [],
		};

		const dispatchSessionTurn = vi.fn().mockReturnValue(blocker);
		const loop = new SurfaceWorkerLoop({
			claimPendingJobs: vi.fn().mockResolvedValue(batch),
			spawnOverflowMachine: vi.fn(),
			dispatchSessionTurn,
			runPreviewJob: vi.fn(),
		});

		const ac = new AbortController();
		const firstTick = loop.tick(ac.signal);
		await Promise.resolve();
		await Promise.resolve();
		expect(loop.inFlightSessionCount).toBe(1);

		const secondResult = await loop.tick(ac.signal);
		expect(secondResult).toEqual({ startedSessions: 0, startedPreviews: 0 });
		expect(dispatchSessionTurn).toHaveBeenCalledTimes(1);

		release();
		const firstResult = await firstTick;
		expect(firstResult).toEqual({ startedSessions: 1, startedPreviews: 0 });
		expect(loop.inFlightSessionCount).toBe(0);
	});
});
