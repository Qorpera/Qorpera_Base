import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createRoutedArtifactGcStorageProvider,
	parseArtifactGcWorkerJobs,
	parseArtifactGcWorkerObjects,
	parseAuthorizedArtifactGcWorkerObjects,
	parseCompanyObjectGcWorkerJob,
	resolveArtifactGcWorkerAuthorization,
	runArtifactGcWorkerBatch,
	runCompanyObjectGcWorkerJob,
	reconcileAuthorizedArtifactGcWorkerObjects,
	type ArtifactGcStorageProvider,
	type ArtifactGcWorkerJob,
	type ArtifactGcWorkerStore,
	type CompanyObjectGcWorkerStore,
} from "./artifact-gc-worker.ts";

const planId = "a8450f9d-c912-43ea-81f6-62c7247d752a";
const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const leaseId = "73dc6943-b71c-4ba4-a38d-78da0861e0dc";
const firstSha256 = "a".repeat(64);
const secondSha256 = "b".repeat(64);

function job(): ArtifactGcWorkerJob {
	return { planId, profileId, leaseId, attemptCount: 1 };
}

describe("artifact cleanup worker", () => {
	it("keeps worker authentication separate from its privileged database credential", () => {
		assert.deepEqual(
			resolveArtifactGcWorkerAuthorization({
				presentedKey: "worker-key",
				workerKey: "worker-key",
				serviceKeys: [undefined, "database-service-key"],
			}),
			{ status: "authorized", serviceKey: "database-service-key" },
		);
		assert.deepEqual(
			resolveArtifactGcWorkerAuthorization({
				presentedKey: "database-service-key",
				workerKey: "worker-key",
				serviceKeys: ["database-service-key"],
			}),
			{ status: "unauthorized" },
		);
		assert.deepEqual(
			resolveArtifactGcWorkerAuthorization({
				presentedKey: "worker-key",
				workerKey: "worker-key",
				serviceKeys: [],
			}),
			{ status: "unconfigured" },
		);
	});

	it("routes each object to its declared backend and carries the exact cleanup lease", async () => {
		const events: string[] = [];
		const storage = createRoutedArtifactGcStorageProvider({
			removeSupabase: async (object, cleanupLeaseId) =>
				events.push(`supabase:${object.path}:${cleanupLeaseId}`),
			removeNas: async (object, cleanupLeaseId) => events.push(`nas:${object.path}:${cleanupLeaseId}`),
		});
		await storage.remove(
			[
				{
					sha256: firstSha256,
					bytes: 42,
					path: `${profileId}/${firstSha256}`,
					backend: "supabase-storage",
				},
				{
					sha256: secondSha256,
					bytes: 84,
					path: `${profileId}/${secondSha256}`,
					backend: "nas-object-gateway",
				},
				{
					sha256: "c".repeat(64),
					bytes: 1,
					path: `${profileId}/${"c".repeat(64)}`,
					backend: "missing",
				},
			],
			leaseId,
		);
		assert.deepEqual(events, [
			`supabase:${profileId}/${firstSha256}:${leaseId}`,
			`nas:${profileId}/${secondSha256}:${leaseId}`,
		]);
	});

	it("parses and reconciles durable deletion authorizations before new claims", async () => {
		const authorizationId = "83dc6943-b71c-4ba4-a38d-78da0861e0dc";
		const objects = parseAuthorizedArtifactGcWorkerObjects([
			{
				authorization_id: authorizationId,
				profile_id: profileId,
				sha256: firstSha256,
				bytes: 42,
				path: `${profileId}/${firstSha256}`,
				backend: "supabase-storage",
			},
		]);
		const removed: string[] = [];
		assert.equal(
			await reconcileAuthorizedArtifactGcWorkerObjects(objects, async (object) => {
				removed.push(`${object.authorizationId}:${object.path}`);
			}),
			1,
		);
		assert.deepEqual(removed, [`${authorizationId}:${profileId}/${firstSha256}`]);
	});

	it("validates service jobs and refuses paths outside the claimed profile", () => {
		assert.deepEqual(
			parseArtifactGcWorkerJobs([
				{ plan_id: planId, profile_id: profileId, lease_id: leaseId, attempt_count: 1 },
			]),
			[job()],
		);
		assert.deepEqual(
			parseArtifactGcWorkerObjects(
				[
					{
						sha256: firstSha256,
						bytes: 42,
						path: `${profileId}/${firstSha256}`,
						backend: "nas-object-gateway",
					},
				],
				job(),
			),
			[
				{
					sha256: firstSha256,
					bytes: 42,
					path: `${profileId}/${firstSha256}`,
					backend: "nas-object-gateway",
				},
			],
		);
		assert.throws(
			() =>
				parseArtifactGcWorkerObjects(
					[
						{
							sha256: firstSha256,
							bytes: 42,
							path: `another-profile/${firstSha256}`,
							backend: "supabase-storage",
						},
					],
					job(),
				),
			/path/,
		);
	});

	it("deletes bounded batches, acknowledges them, and completes the plan", async () => {
		const claimed = [
			[
				{
					sha256: firstSha256,
					bytes: 42,
					path: `${profileId}/${firstSha256}`,
					backend: "supabase-storage" as const,
				},
			],
			[
				{
					sha256: secondSha256,
					bytes: 84,
					path: `${profileId}/${secondSha256}`,
					backend: "nas-object-gateway" as const,
				},
			],
			[],
		];
		const removed: string[][] = [];
		const renewed: string[][] = [];
		const acknowledged: string[][] = [];
		let completed = false;
		const storage: ArtifactGcStorageProvider = {
			remove: async (objects) => removed.push(objects.map((object) => object.path)),
		};
		const store: ArtifactGcWorkerStore = {
			claimObjects: async () => claimed.shift() ?? [],
			renewLease: async (_job, sha256s) => renewed.push(sha256s),
			acknowledgeObjects: async (_job, sha256s) => acknowledged.push(sha256s),
			complete: async () => {
				completed = true;
			},
			fail: async () => "retrying",
		};
		assert.deepEqual(await runArtifactGcWorkerBatch([job()], storage, store), {
			claimed: 1,
			completed: 1,
			retrying: 0,
			failed: 0,
			failurePending: 0,
		});
		assert.deepEqual(removed, [
			[`${profileId}/${firstSha256}`],
			[`${profileId}/${secondSha256}`],
		]);
		assert.deepEqual(renewed, [[firstSha256], [secondSha256]]);
		assert.deepEqual(acknowledged, [[firstSha256], [secondSha256]]);
		assert.equal(completed, true);
	});

	it("records a retry without exposing object paths in the failure", async () => {
		let failure = "";
		const store: ArtifactGcWorkerStore = {
			claimObjects: async () => [
				{
					sha256: firstSha256,
					bytes: 42,
					path: `${profileId}/${firstSha256}`,
					backend: "supabase-storage",
				},
			],
			renewLease: async () => {},
			acknowledgeObjects: async () => {},
			complete: async () => {},
			fail: async (_job, message) => {
				failure = message;
				return "retrying";
			},
		};
		assert.deepEqual(
			await runArtifactGcWorkerBatch(
				[job()],
				{ remove: async () => Promise.reject(new Error("Storage unavailable")) },
				store,
			),
			{ claimed: 1, completed: 0, retrying: 1, failed: 0, failurePending: 0 },
		);
		assert.equal(failure, "Storage unavailable");
		assert.doesNotMatch(failure, new RegExp(firstSha256));
	});

	it("does not remove storage when the lease cannot be renewed", async () => {
		let removed = false;
		let failure = "";
		const store: ArtifactGcWorkerStore = {
			claimObjects: async () => [
				{
					sha256: firstSha256,
					bytes: 42,
					path: `${profileId}/${firstSha256}`,
					backend: "supabase-storage",
				},
			],
			renewLease: async () => Promise.reject(new Error("Lease expired")),
			acknowledgeObjects: async () => {},
			complete: async () => {},
			fail: async (_job, message) => {
				failure = message;
				return "retrying";
			},
		};
		await runArtifactGcWorkerBatch(
			[job()],
			{
				remove: async () => {
					removed = true;
				},
			},
			store,
		);
		assert.equal(removed, false);
		assert.equal(failure, "Lease expired");
	});

	it("reclaims an unreferenced company object only after renewing its profile lease", async () => {
		const parsed = parseCompanyObjectGcWorkerJob({
			profile_id: profileId,
			lease_id: leaseId,
			objects: [
				{
					sha256: firstSha256,
					bytes: 42,
					path: `${profileId}/${firstSha256}`,
					backend: "nas-object-gateway",
				},
			],
		});
		assert.ok(parsed);
		const events: string[] = [];
		const store: CompanyObjectGcWorkerStore = {
			renewLease: async () => {
				events.push("renew");
			},
			complete: async () => {
				events.push("complete");
			},
			release: async () => {
				events.push("release");
			},
		};
		assert.deepEqual(
			await runCompanyObjectGcWorkerJob(
				parsed,
				{
					remove: async (objects) => {
						events.push(`remove:${objects[0]?.path}`);
					},
				},
				store,
			),
			{ claimed: 1, completed: 1, failed: 0 },
		);
		assert.deepEqual(events, ["renew", `remove:${profileId}/${firstSha256}`, "complete"]);
	});

	it("releases a company object lease after storage failure", async () => {
		const parsed = parseCompanyObjectGcWorkerJob({
			profile_id: profileId,
			lease_id: leaseId,
			objects: [
				{
					sha256: firstSha256,
					bytes: 42,
					path: `${profileId}/${firstSha256}`,
					backend: "nas-object-gateway",
				},
			],
		});
		assert.ok(parsed);
		let released = false;
		assert.deepEqual(
			await runCompanyObjectGcWorkerJob(
				parsed,
				{ remove: async () => Promise.reject(new Error("unavailable")) },
				{
					renewLease: async () => {},
					complete: async () => {},
					release: async () => {
						released = true;
					},
				},
			),
			{ claimed: 1, completed: 0, failed: 1 },
		);
		assert.equal(released, true);
	});
});
