import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SupabaseCloudRunnerOrchestratorControlPlane } from "../src/orchestrator.ts";
import { createSurfaceWorkerLoop, runCloudRunnerOrchestratorService } from "../src/service.ts";
import {
	type ClaimedSurfaceJobs,
	type ClaimedSurfaceMergeJob,
	type ClaimedSurfacePublishJob,
	SurfaceWorkerLoop,
} from "../src/surface-worker-loop.ts";

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
					folderRoot: null,
					surfaceSlug: "website",
					surfaceTitle: "Website",
					surfaceArchetype: "live_build",
					briefSummary: "Public marketing website",
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
		expect(result).toEqual({
			startedSessions: 2,
			startedPreviews: 1,
			startedMerges: 0,
			startedPublishes: 0,
			startedAutomations: 0,
		});
		await loop.drain();
		expect(spawnOverflowMachine).toHaveBeenCalledTimes(1);
		expect(spawnOverflowMachine).toHaveBeenCalledWith(profileId, expect.any(AbortSignal));
		expect(dispatchSessionTurn).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: s1,
				surfaceSlug: "website",
				surfaceTitle: "Website",
				surfaceArchetype: "live_build",
				briefSummary: "Public marketing website",
			}),
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
		expect(loop.inFlightMergeCount).toBe(0);
		expect(loop.inFlightPublishCount).toBe(0);
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
		const firstResult = await loop.tick(ac.signal);
		expect(firstResult).toEqual({
			startedSessions: 1,
			startedPreviews: 0,
			startedMerges: 0,
			startedPublishes: 0,
			startedAutomations: 0,
		});
		expect(loop.inFlightSessionCount).toBe(1);

		const secondResult = await loop.tick(ac.signal);
		expect(secondResult).toEqual({
			startedSessions: 0,
			startedPreviews: 0,
			startedMerges: 0,
			startedPublishes: 0,
			startedAutomations: 0,
		});
		expect(dispatchSessionTurn).toHaveBeenCalledTimes(1);

		release();
		await loop.drain();
		expect(loop.inFlightSessionCount).toBe(0);
	});

	it("reports dispatch failures to the database and periodically renews active leases without blocking ticks", async () => {
		const sessionId = randomUUID();
		const slowMergeId = randomUUID();
		const surfaceId = randomUUID();
		const profileId = randomUUID();
		const machineId = randomUUID();
		const sessionLease = randomUUID();
		const mergeLease = randomUUID();
		let releaseMerge!: () => void;
		const mergeBlocker = new Promise<void>((resolve) => {
			releaseMerge = resolve;
		});

		const claimPendingJobs = vi
			.fn()
			.mockResolvedValueOnce({
				sessions: [
					{
						sessionId,
						surfaceId,
						profileId,
						state: "queued" as const,
						prompt: "Run turn",
						originKind: "member",
						originRef: null,
						repositoryKey: null,
						leaseToken: sessionLease,
						placement: { strategy: "reuse_machine" as const, machineId, activeTurns: 0, targetDensity: 6 },
					},
				],
				previews: [],
				merges: [
					{
						jobId: slowMergeId,
						kind: "land_change" as const,
						surfaceId,
						sessionId,
						profileId,
						leaseToken: mergeLease,
						repositoryKey: "thetaband/website",
						folderRoot: null,
						payload: { changeIds: [randomUUID()] },
					},
				],
			})
			.mockResolvedValue({ sessions: [], previews: [], merges: [], publishes: [] });

		const reportSessionFailure = vi.fn().mockResolvedValue(undefined);
		const renewLease = vi.fn().mockResolvedValue({ renewed: true });
		const loop = new SurfaceWorkerLoop(
			{
				claimPendingJobs,
				spawnOverflowMachine: vi.fn(),
				dispatchSessionTurn: vi.fn().mockRejectedValue(new Error("provider rejected turn")),
				runPreviewJob: vi.fn(),
				runMergeJob: vi.fn().mockReturnValue(mergeBlocker),
				reportSessionFailure,
				renewLease,
			},
			{ leaseRenewIntervalMs: 25, leaseExtendSeconds: 300 },
		);

		const ac = new AbortController();
		const first = await loop.tick(ac.signal);
		expect(first.startedSessions).toBe(1);
		expect(first.startedMerges).toBe(1);

		const second = await loop.tick(ac.signal);
		expect(second.startedMerges).toBe(0);
		expect(claimPendingJobs).toHaveBeenCalledTimes(2);

		await new Promise((resolve) => setTimeout(resolve, 65));
		expect(renewLease).toHaveBeenCalledWith(
			{ kind: "job", id: slowMergeId, leaseToken: mergeLease, extendSeconds: 300 },
			expect.any(AbortSignal),
		);
		expect(reportSessionFailure).toHaveBeenCalledWith(
			{ sessionId, leaseToken: sessionLease, errorDetail: "provider rejected turn" },
			expect.any(AbortSignal),
		);

		releaseMerge();
		await loop.drain();
		expect(loop.inFlightTaskCount).toBe(0);
	});

	it("drains merge landing, undo execution, and publish jobs", async () => {
		const profileId = randomUUID();
		const surfaceId = randomUUID();
		const sessionId = randomUUID();
		const siteId = randomUUID();
		const landJobId = randomUUID();
		const undoJobId = randomUUID();
		const publishJobId = randomUUID();
		const changeId = randomUUID();

		const landJob: ClaimedSurfaceMergeJob = {
			jobId: landJobId,
			kind: "land_change",
			surfaceId,
			sessionId,
			profileId,
			repositoryKey: "thetaband/website",
			folderRoot: null,
			payload: { changeIds: [changeId], autoPublish: true },
		};
		const undoJob: ClaimedSurfaceMergeJob = {
			jobId: undoJobId,
			kind: "undo_change",
			surfaceId,
			sessionId,
			profileId,
			repositoryKey: null,
			folderRoot: "identity",
			payload: { changeId, landedMainBefore: "a".repeat(40), landedMainAfter: "b".repeat(40) },
		};
		const publishJob: ClaimedSurfacePublishJob = {
			jobId: publishJobId,
			surfaceId,
			profileId,
			repositoryKey: "thetaband/website",
			siteId,
			payload: { liveHeadSha: "b".repeat(40), repositoryKey: "thetaband/website" },
		};

		const runMergeJob = vi.fn().mockResolvedValue(undefined);
		const runPublishJob = vi.fn().mockResolvedValue(undefined);
		const events: Record<string, unknown>[] = [];

		const loop = new SurfaceWorkerLoop({
			claimPendingJobs: vi.fn().mockResolvedValue({
				sessions: [],
				previews: [],
				merges: [landJob, undoJob],
				publishes: [publishJob],
			}),
			spawnOverflowMachine: vi.fn(),
			dispatchSessionTurn: vi.fn(),
			runPreviewJob: vi.fn(),
			runMergeJob,
			runPublishJob,
			onEvent: (event) => events.push(event),
		});

		const result = await loop.tick(new AbortController().signal);
		expect(result).toEqual({
			startedSessions: 0,
			startedPreviews: 0,
			startedMerges: 2,
			startedPublishes: 1,
			startedAutomations: 0,
		});
		await loop.drain();
		expect(runMergeJob).toHaveBeenNthCalledWith(1, landJob, expect.any(AbortSignal));
		expect(runMergeJob).toHaveBeenNthCalledWith(2, undoJob, expect.any(AbortSignal));
		expect(runPublishJob).toHaveBeenCalledWith(publishJob, expect.any(AbortSignal));
		expect(loop.inFlightMergeCount).toBe(0);
		expect(loop.inFlightPublishCount).toBe(0);
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "merge_completed", jobId: landJobId, mergeKind: "land_change" }),
				expect.objectContaining({ kind: "merge_completed", jobId: undoJobId, mergeKind: "undo_change" }),
				expect.objectContaining({ kind: "publish_completed", jobId: publishJobId, surfaceId }),
			]),
		);
	});

	it("deduplicates in-flight merges and publishes across overlapping ticks", async () => {
		const mergeJobId = randomUUID();
		const publishJobId = randomUUID();
		const surfaceId = randomUUID();
		const profileId = randomUUID();

		let releaseMerge!: () => void;
		let releasePublish!: () => void;
		const mergeBlocker = new Promise<void>((resolve) => {
			releaseMerge = resolve;
		});
		const publishBlocker = new Promise<void>((resolve) => {
			releasePublish = resolve;
		});

		const batch: ClaimedSurfaceJobs = {
			sessions: [],
			previews: [],
			merges: [
				{
					jobId: mergeJobId,
					kind: "land_change",
					surfaceId,
					sessionId: randomUUID(),
					profileId,
					repositoryKey: "thetaband/website",
					folderRoot: null,
					payload: { changeIds: [randomUUID()] },
				},
			],
			publishes: [
				{
					jobId: publishJobId,
					surfaceId,
					profileId,
					repositoryKey: "thetaband/website",
					siteId: randomUUID(),
					payload: { liveHeadSha: "c".repeat(40) },
				},
			],
		};

		const runMergeJob = vi.fn().mockReturnValue(mergeBlocker);
		const runPublishJob = vi.fn().mockReturnValue(publishBlocker);

		const loop = new SurfaceWorkerLoop({
			claimPendingJobs: vi.fn().mockResolvedValue(batch),
			spawnOverflowMachine: vi.fn(),
			dispatchSessionTurn: vi.fn(),
			runPreviewJob: vi.fn(),
			runMergeJob,
			runPublishJob,
		});

		const ac = new AbortController();
		const firstResult = await loop.tick(ac.signal);
		expect(firstResult).toEqual({
			startedSessions: 0,
			startedPreviews: 0,
			startedMerges: 1,
			startedPublishes: 1,
			startedAutomations: 0,
		});
		expect(loop.inFlightMergeCount).toBe(1);
		expect(loop.inFlightPublishCount).toBe(1);

		const secondResult = await loop.tick(ac.signal);
		expect(secondResult).toEqual({
			startedSessions: 0,
			startedPreviews: 0,
			startedMerges: 0,
			startedPublishes: 0,
			startedAutomations: 0,
		});
		expect(runMergeJob).toHaveBeenCalledTimes(1);
		expect(runPublishJob).toHaveBeenCalledTimes(1);

		releaseMerge();
		releasePublish();
		await loop.drain();
		expect(loop.inFlightMergeCount).toBe(0);
		expect(loop.inFlightPublishCount).toBe(0);
	});

	it("drains sessionless decision_card automations, skips session-backed surface_session automations, and deduplicates in-flight automations", async () => {
		const profileId = randomUUID();
		const surfaceId = randomUUID();
		const decisionAutomationId = randomUUID();
		const sessionAutomationId = randomUUID();
		const spawnedSessionId = randomUUID();
		let releaseAutomation!: () => void;
		const blocker = new Promise<void>((resolve) => {
			releaseAutomation = resolve;
		});

		const batch: ClaimedSurfaceJobs = {
			sessions: [],
			previews: [],
			automations: [
				{
					automationId: decisionAutomationId,
					profileId,
					key: "cofounder-pulse",
					title: "Co-Founder Pulse",
					prompt: "Review active surfaces and raise any decisions.",
					targetSurfaceSlug: null,
					outputMode: "decision_card",
					sessionId: null,
					surfaceId: null,
				},
				{
					automationId: sessionAutomationId,
					profileId,
					key: "weekly-website-check",
					title: "Weekly Website Check",
					prompt: "Audit website copy",
					targetSurfaceSlug: "website",
					outputMode: "surface_session",
					sessionId: spawnedSessionId,
					surfaceId,
				},
			],
		};

		const events: Record<string, unknown>[] = [];
		const runAutomationJob = vi.fn().mockReturnValue(blocker);
		const loop = new SurfaceWorkerLoop({
			claimPendingJobs: vi.fn().mockResolvedValue(batch),
			spawnOverflowMachine: vi.fn(),
			dispatchSessionTurn: vi.fn(),
			runPreviewJob: vi.fn(),
			runAutomationJob,
			onEvent: (event) => events.push(event),
		});

		const ac = new AbortController();
		const firstResult = await loop.tick(ac.signal);
		expect(firstResult).toEqual({
			startedSessions: 0,
			startedPreviews: 0,
			startedMerges: 0,
			startedPublishes: 0,
			startedAutomations: 1,
		});
		expect(loop.inFlightAutomationCount).toBe(1);

		const secondResult = await loop.tick(ac.signal);
		expect(secondResult).toEqual({
			startedSessions: 0,
			startedPreviews: 0,
			startedMerges: 0,
			startedPublishes: 0,
			startedAutomations: 0,
		});
		expect(runAutomationJob).toHaveBeenCalledTimes(1);
		expect(runAutomationJob).toHaveBeenCalledWith(
			expect.objectContaining({
				automationId: decisionAutomationId,
				key: "cofounder-pulse",
				outputMode: "decision_card",
			}),
			expect.any(AbortSignal),
		);

		releaseAutomation();
		await loop.drain();
		expect(loop.inFlightAutomationCount).toBe(0);
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "automation_completed",
					automationId: decisionAutomationId,
					key: "cofounder-pulse",
				}),
			]),
		);
	});

	it("wakes immediately on realtime wake signals instead of waiting for pollIntervalMs", async () => {
		const listeners = new Set<() => void>();
		const wake = {
			listening: true,
			subscribe(listener: () => void) {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		};

		let resolveSecondTick!: () => void;
		const secondTickReached = new Promise<void>((resolve) => {
			resolveSecondTick = resolve;
		});
		let claims = 0;
		const claimPendingJobs = vi.fn(async (): Promise<ClaimedSurfaceJobs> => {
			claims += 1;
			if (claims === 2) resolveSecondTick();
			return { sessions: [], previews: [], merges: [], publishes: [] };
		});

		const loop = new SurfaceWorkerLoop(
			{
				claimPendingJobs,
				spawnOverflowMachine: vi.fn(),
				dispatchSessionTurn: vi.fn(),
				runPreviewJob: vi.fn(),
			},
			{ pollIntervalMs: 60_000 },
		);

		const ac = new AbortController();
		const running = loop.run(ac.signal, wake);
		while (claims < 1) await new Promise((resolve) => setTimeout(resolve, 5));
		expect(listeners.size).toBe(1);

		for (const listener of listeners) listener();
		await secondTickReached;
		expect(claims).toBeGreaterThanOrEqual(2);

		ac.abort();
		await running;
		expect(listeners.size).toBe(0);
	});
});

describe("SupabaseCloudRunnerOrchestratorControlPlane surface actions and service wiring", () => {
	it("dispatches all five surface control-plane actions and parses their responses", async () => {
		const orchestratorId = randomUUID();
		const profileId = randomUUID();
		const surfaceId = randomUUID();
		const sessionId = randomUUID();
		const previewId = randomUUID();
		const siteVersionId = randomUUID();
		const siteId = randomUUID();
		const machineId = randomUUID();
		const mergeJobId = randomUUID();
		const publishJobId = randomUUID();
		const changeId = randomUUID();
		const explorationId = randomUUID();
		const automationId = randomUUID();
		const sponsorBindingId = randomUUID();
		const sha1 = "a".repeat(40);
		const sha2 = "b".repeat(40);
		const bodies: Record<string, unknown>[] = [];

		const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			bodies.push(body);
			switch (body.action) {
				case "surface_claim_jobs":
					return Response.json({
						value: {
							sessions: [
								{
									sessionId,
									surfaceId,
									profileId,
									state: "queued",
									prompt: "Refresh pricing",
									originKind: "member",
									originRef: null,
									repositoryKey: "thetaband/website",
									folderRoot: null,
									surfaceSlug: "website",
									surfaceTitle: "Website",
									surfaceArchetype: "live_build",
									surfaceSourceKind: "code_repo",
									surfaceKind: "website",
									explorationId,
									explorationVariantLabel: "Aftenlys",
									siteSlug: "thetaband",
									identityFolderRoot: "identity",
									briefSummary: "Main site",
									retryCount: 2,
									sponsor: { sponsorBindingId, sponsorVersion: 3 },
									placement: { strategy: "reuse_machine", machineId, activeTurns: 1, targetDensity: 6 },
								},
							],
							previews: [
								{
									previewId,
									surfaceId,
									profileId,
									shortHostId: "ab12cd34",
									baseSha: sha1,
									selectedChangeIds: [changeId],
									repositoryKey: "thetaband/website",
								},
							],
							merges: [
								{
									jobId: mergeJobId,
									kind: "land_change",
									surfaceId,
									sessionId,
									profileId,
									repositoryKey: "thetaband/website",
									folderRoot: null,
									payload: { changeIds: [changeId], autoPublish: false },
								},
							],
							publishes: [
								{
									jobId: publishJobId,
									surfaceId,
									profileId,
									repositoryKey: "thetaband/website",
									siteId,
									payload: { liveHeadSha: sha2 },
								},
							],
							automations: [
								{
									automationId,
									profileId,
									key: "cofounder-pulse",
									title: "Co-Founder Pulse",
									prompt: "Check company progress",
									targetSurfaceSlug: null,
									outputMode: "decision_card",
									sessionId: null,
									surfaceId: null,
								},
							],
						},
					});
				case "surface_complete_preview":
					return Response.json({
						value: { previewId, status: "ready", shortHostId: "ab12cd34", compositeTreeSha: sha1 },
					});
				case "surface_complete_session_turn":
					return Response.json({
						value: { id: sessionId, surfaceId, state: "ready", notePaths: ["notes/pricing.md"] },
					});
				case "surface_complete_merge":
					return Response.json({
						value: { jobId: mergeJobId, status: "landed" },
					});
				case "surface_complete_publish":
					return Response.json({
						value: { jobId: publishJobId, status: "published" },
					});
				case "surface_renew_lease":
					return Response.json({
						value: { renewed: true, leaseExpiresAt: "2026-11-22T03:05:00Z" },
					});
				default:
					return Response.json({ value: null });
			}
		});

		const controlPlane = new SupabaseCloudRunnerOrchestratorControlPlane(
			"https://project.supabase.co",
			"publishable-key",
			orchestratorId,
			"c".repeat(43),
			fakeFetch as typeof fetch,
		);

		const claimed = await controlPlane.claimSurfaceJobs(8);
		expect(claimed.sessions).toHaveLength(1);
		expect(claimed.previews).toHaveLength(1);
		expect(claimed.merges).toHaveLength(1);
		expect(claimed.publishes).toHaveLength(1);
		expect(claimed.automations).toHaveLength(1);
		expect(claimed.sessions[0]).toMatchObject({
			surfaceSlug: "website",
			surfaceSourceKind: "code_repo",
			surfaceKind: "website",
			explorationId,
			explorationVariantLabel: "Aftenlys",
			siteSlug: "thetaband",
			identityFolderRoot: "identity",
			retryCount: 2,
			sponsor: { sponsorBindingId, sponsorVersion: 3 },
		});
		expect(claimed.automations?.[0]).toMatchObject({
			automationId,
			key: "cofounder-pulse",
			outputMode: "decision_card",
			sessionId: null,
		});

		const previewDone = await controlPlane.completeSurfacePreview({
			previewId,
			status: "ready",
			compositeTreeSha: sha1,
			siteVersionId,
			conflictReport: null,
			errorDetail: null,
		});
		expect(previewDone).toEqual({
			previewId,
			status: "ready",
			shortHostId: "ab12cd34",
			compositeTreeSha: sha1,
		});

		const turnDone = await controlPlane.completeSurfaceSessionTurn({
			sessionId,
			state: "ready",
			replyText: "Updated pricing table.",
			notePaths: ["notes/pricing.md"],
			branchHeadSha: sha2,
		});
		expect(turnDone.id).toBe(sessionId);
		expect(turnDone.state).toBe("ready");

		const mergeDone = await controlPlane.completeSurfaceMerge({
			jobId: mergeJobId,
			status: "landed",
			mainBefore: sha1,
			mainAfter: sha2,
		});
		expect(mergeDone).toEqual({ jobId: mergeJobId, status: "landed" });

		const leaseToken = randomUUID();
		const renewed = await controlPlane.renewSurfaceLease({
			kind: "session",
			id: sessionId,
			leaseToken,
			extendSeconds: 300,
		});
		expect(renewed).toEqual({ renewed: true, leaseExpiresAt: "2026-11-22T03:05:00.000Z" });

		const publishDone = await controlPlane.completeSurfacePublish({
			jobId: publishJobId,
			status: "published",
			publishedHeadSha: sha2,
			leaseToken,
		});
		expect(publishDone).toEqual({ jobId: publishJobId, status: "published" });

		expect(bodies.map((b) => b.action)).toEqual([
			"surface_claim_jobs",
			"surface_complete_preview",
			"surface_complete_session_turn",
			"surface_complete_merge",
			"surface_renew_lease",
			"surface_complete_publish",
		]);

		const runMergeJob = vi.fn().mockResolvedValue(undefined);
		const runPublishJob = vi.fn().mockResolvedValue(undefined);
		const runAutomationJob = vi.fn().mockResolvedValue(undefined);
		const helperLoop = createSurfaceWorkerLoop(controlPlane, {
			spawnOverflowMachine: vi.fn(),
			dispatchSessionTurn: vi.fn().mockResolvedValue(undefined),
			runPreviewJob: vi.fn().mockResolvedValue(undefined),
			runMergeJob,
			runPublishJob,
			runAutomationJob,
		});
		const tickResult = await helperLoop.tick(new AbortController().signal);
		await helperLoop.drain();
		expect(tickResult).toEqual({
			startedSessions: 1,
			startedPreviews: 1,
			startedMerges: 1,
			startedPublishes: 1,
			startedAutomations: 1,
		});
		expect(runMergeJob).toHaveBeenCalledTimes(1);
		expect(runPublishJob).toHaveBeenCalledTimes(1);
		expect(runAutomationJob).toHaveBeenCalledTimes(1);
	});

	it("runs SurfaceWorkerLoop concurrently inside runCloudRunnerOrchestratorService when surfaceWorker is provided", async () => {
		const dir = await realpath(await mkdtemp(join(tmpdir(), "orch-service-surface-")));
		try {
			const orchestratorId = randomUUID();
			const surfaceId = randomUUID();
			const profileId = randomUUID();
			const publishJobId = randomUUID();
			let surfaceClaimed = false;
			let resolvePublishHandled!: () => void;
			const publishHandled = new Promise<void>((resolve) => {
				resolvePublishHandled = resolve;
			});

			const fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
				const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				if (href.includes("provider.example")) {
					return Response.json({ value: null });
				}
				switch (body.action) {
					case "rotate_control":
					case "reconcile":
						return Response.json({ value: null });
					case "due_summary":
						return Response.json({
							value: {
								workers: false,
								listen: false,
								human_tasks: false,
								machine_events: false,
								office_wakes: false,
								machine_checkins: false,
								coding_checkins: false,
								events: false,
								materialize: false,
								routine_heads: false,
							},
						});
					case "folder_dynamic_routines":
						return Response.json({ value: { items: [], has_more: false } });
					case "retained":
						return Response.json({ value: [] });
					case "claim":
						return Response.json({ value: null });
					case "surface_claim_jobs":
						if (!surfaceClaimed) {
							surfaceClaimed = true;
							return Response.json({
								value: {
									sessions: [],
									previews: [],
									merges: [],
									publishes: [
										{
											jobId: publishJobId,
											surfaceId,
											profileId,
											repositoryKey: "thetaband/website",
											siteId: null,
											payload: { liveHeadSha: "d".repeat(40) },
										},
									],
								},
							});
						}
						return Response.json({ value: { sessions: [], previews: [], merges: [], publishes: [] } });
					case "surface_complete_publish":
						return Response.json({ value: { jobId: publishJobId, status: "published" } });
					default:
						return Response.json({ value: null });
				}
			});

			const controller = new AbortController();
			const serviceRun = runCloudRunnerOrchestratorService({
				config: {
					supabaseUrl: "https://project.supabase.co",
					supabasePublishableKey: "publishable-key",
					orchestratorId,
					orchestratorControlToken: "c".repeat(43),
					orchestratorControlStatePath: join(dir, "control.json"),
					providerUrl: "https://provider.example",
					providerAdapterId: "managed",
					providerServiceToken: "provider-token",
					pollIntervalMs: 50,
					reconcileIntervalMs: 250,
					dispatchConcurrency: 2,
				},
				signal: controller.signal,
				fetchImplementation: fakeFetch as typeof fetch,
				surfaceWorker: ({ controlPlane }) => ({
					pollIntervalMs: 50,
					spawnOverflowMachine: vi.fn(),
					dispatchSessionTurn: vi.fn(),
					runPreviewJob: vi.fn(),
					runMergeJob: vi.fn(),
					runPublishJob: async (job, signal) => {
						await controlPlane.completeSurfacePublish(
							{ jobId: job.jobId, status: "published", publishedHeadSha: "d".repeat(40) },
							signal,
						);
						resolvePublishHandled();
					},
				}),
			});

			await Promise.race([
				publishHandled,
				serviceRun.then(() => {
					throw new Error("Orchestrator service exited before handling surface publish job");
				}),
			]);
			controller.abort();
			await serviceRun;
			expect(surfaceClaimed).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("validates sponsor and retryCount fields when parsing claimed surface sessions", async () => {
		const orchestratorId = randomUUID();
		const baseSession = {
			sessionId: randomUUID(),
			surfaceId: randomUUID(),
			profileId: randomUUID(),
			state: "queued",
			prompt: "Check copy",
			originKind: "member",
			originRef: null,
			repositoryKey: null,
			placement: { strategy: "spawn_overflow_machine", machineId: null, activeTurns: 0, targetDensity: 6 },
		};
		const makePlane = (sessionOverrides: Record<string, unknown>) =>
			new SupabaseCloudRunnerOrchestratorControlPlane(
				"https://project.supabase.co",
				"publishable-key",
				orchestratorId,
				"c".repeat(43),
				vi.fn(async () =>
					Response.json({
						value: {
							sessions: [{ ...baseSession, ...sessionOverrides }],
							previews: [],
							merges: [],
							publishes: [],
						},
					}),
				) as typeof fetch,
			);

		const nullSponsor = await makePlane({ retryCount: 0, sponsor: null }).claimSurfaceJobs(4);
		expect(nullSponsor.sessions[0]?.retryCount).toBe(0);
		expect(nullSponsor.sessions[0]?.sponsor).toBeNull();

		await expect(makePlane({ retryCount: -1 }).claimSurfaceJobs(4)).rejects.toThrow("retry count");
		await expect(
			makePlane({ sponsor: { sponsorBindingId: randomUUID(), sponsorVersion: 0 } }).claimSurfaceJobs(4),
		).rejects.toThrow("sponsor version");
	});

	it("releases the session claim without failing the session when provider dispatch returns HTTP 429", async () => {
		const sessionId = randomUUID();
		const surfaceId = randomUUID();
		const profileId = randomUUID();
		const machineId = randomUUID();
		const leaseToken = randomUUID();
		const events: Record<string, unknown>[] = [];
		const releaseSessionClaim = vi.fn().mockResolvedValue({ sessionId, released: true, state: "queued" });
		const reportSessionFailure = vi.fn().mockResolvedValue(undefined);

		const loop = new SurfaceWorkerLoop({
			claimPendingJobs: vi.fn().mockResolvedValue({
				sessions: [
					{
						sessionId,
						surfaceId,
						profileId,
						state: "queued",
						prompt: "Update homepage",
						originKind: "member",
						originRef: null,
						repositoryKey: "surfaces/website",
						leaseToken,
						placement: { strategy: "reuse_machine", machineId, activeTurns: 0, targetDensity: 6 },
					},
				],
				previews: [],
				merges: [],
				publishes: [],
			}),
			spawnOverflowMachine: vi.fn(),
			dispatchSessionTurn: vi
				.fn()
				.mockRejectedValue(Object.assign(new Error("Provider capacity reached"), { status: 429 })),
			runPreviewJob: vi.fn(),
			releaseSessionClaim,
			reportSessionFailure,
			onEvent: (event) => events.push(event),
		});

		await loop.tick(new AbortController().signal);
		await loop.drain();

		expect(releaseSessionClaim).toHaveBeenCalledExactlyOnceWith({ sessionId, leaseToken }, expect.any(AbortSignal));
		expect(reportSessionFailure).not.toHaveBeenCalled();
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "session_deferred",
					sessionId,
					surfaceId,
				}),
			]),
		);
	});

	it("ignores immediate wake signals after HTTP 429 release until pollIntervalMs has elapsed", async () => {
		vi.useFakeTimers();
		try {
			const sessionId = randomUUID();
			const surfaceId = randomUUID();
			const profileId = randomUUID();
			const machineId = randomUUID();
			const leaseToken = randomUUID();
			const listeners = new Set<() => void>();
			const wake = {
				listening: true,
				subscribe(listener: () => void) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
			};

			const dispatchTimes: number[] = [];
			const dispatchSessionTurn = vi.fn(async () => {
				dispatchTimes.push(Date.now());
				if (dispatchTimes.length === 1) {
					throw Object.assign(new Error("Provider capacity reached"), { status: 429 });
				}
			});
			const releaseSessionClaim = vi.fn(async () => {
				for (const listener of listeners) listener();
				return { sessionId, released: true, state: "queued" };
			});

			const pollIntervalMs = 200;
			const loop = new SurfaceWorkerLoop(
				{
					claimPendingJobs: vi.fn(
						async (): Promise<ClaimedSurfaceJobs> => ({
							sessions:
								dispatchTimes.length < 2
									? [
											{
												sessionId,
												surfaceId,
												profileId,
												state: "queued",
												prompt: "Update homepage",
												originKind: "member",
												originRef: null,
												repositoryKey: "surfaces/website",
												leaseToken,
												placement: {
													strategy: "reuse_machine",
													machineId,
													activeTurns: 0,
													targetDensity: 6,
												},
											},
										]
									: [],
							previews: [],
							merges: [],
							publishes: [],
						}),
					),
					spawnOverflowMachine: vi.fn(),
					dispatchSessionTurn,
					runPreviewJob: vi.fn(),
					releaseSessionClaim,
				},
				{ pollIntervalMs },
			);

			const ac = new AbortController();
			const running = loop.run(ac.signal, wake);
			await vi.advanceTimersByTimeAsync(0);
			expect(releaseSessionClaim).toHaveBeenCalledTimes(1);
			expect(dispatchTimes).toHaveLength(1);

			for (const listener of listeners) listener();
			await vi.advanceTimersByTimeAsync(100);
			for (const listener of listeners) listener();
			await vi.advanceTimersByTimeAsync(50);
			expect(dispatchTimes).toHaveLength(1);

			await vi.advanceTimersByTimeAsync(60);
			expect(dispatchTimes).toHaveLength(2);
			expect(dispatchTimes[1]! - dispatchTimes[0]!).toBeGreaterThanOrEqual(pollIntervalMs);

			ac.abort();
			await running;
		} finally {
			vi.useRealTimers();
		}
	});

	it("uses backstopPollIntervalMs while wake is listening and falls back to pollIntervalMs when disconnected", async () => {
		vi.useFakeTimers();
		try {
			const listeners = new Set<() => void>();
			const wake = {
				listening: true,
				subscribe(listener: () => void) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
			};
			const claimPendingJobs = vi.fn(
				async (): Promise<ClaimedSurfaceJobs> => ({
					sessions: [],
					previews: [],
					merges: [],
					publishes: [],
				}),
			);
			const loop = new SurfaceWorkerLoop(
				{
					claimPendingJobs,
					spawnOverflowMachine: vi.fn(),
					dispatchSessionTurn: vi.fn(),
					runPreviewJob: vi.fn(),
				},
				{ pollIntervalMs: 100, backstopPollIntervalMs: 5_000 },
			);
			const ac = new AbortController();
			const running = loop.run(ac.signal, wake);
			await vi.advanceTimersByTimeAsync(0);
			expect(claimPendingJobs).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(1_000);
			expect(claimPendingJobs).toHaveBeenCalledTimes(1);

			for (const listener of listeners) listener();
			await vi.advanceTimersByTimeAsync(0);
			expect(claimPendingJobs).toHaveBeenCalledTimes(2);

			await vi.advanceTimersByTimeAsync(5_000);
			expect(claimPendingJobs).toHaveBeenCalledTimes(3);

			wake.listening = false;
			for (const listener of listeners) listener();
			await vi.advanceTimersByTimeAsync(0);
			expect(claimPendingJobs).toHaveBeenCalledTimes(4);

			await vi.advanceTimersByTimeAsync(100);
			expect(claimPendingJobs).toHaveBeenCalledTimes(5);

			ac.abort();
			await running;
		} finally {
			vi.useRealTimers();
		}
	});
});
