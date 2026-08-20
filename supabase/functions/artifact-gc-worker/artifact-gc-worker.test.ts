import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	parseArtifactGcWorkerJobs,
	parseArtifactGcWorkerObjects,
	parseCompanyObjectGcWorkerJob,
	runArtifactGcWorkerBatch,
	runCompanyObjectGcWorkerJob,
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
	it("validates service jobs and refuses paths outside the claimed profile", () => {
		assert.deepEqual(
			parseArtifactGcWorkerJobs([
				{ plan_id: planId, profile_id: profileId, lease_id: leaseId, attempt_count: 1 },
			]),
			[job()],
		);
		assert.deepEqual(
			parseArtifactGcWorkerObjects(
				[{ sha256: firstSha256, bytes: 42, path: `${profileId}/${firstSha256}` }],
				job(),
			),
			[{ sha256: firstSha256, bytes: 42, path: `${profileId}/${firstSha256}` }],
		);
		assert.throws(
			() =>
				parseArtifactGcWorkerObjects(
					[{ sha256: firstSha256, bytes: 42, path: `another-profile/${firstSha256}` }],
					job(),
				),
			/path/,
		);
	});

	it("deletes bounded batches, acknowledges them, and completes the plan", async () => {
		const claimed = [
			[{ sha256: firstSha256, bytes: 42, path: `${profileId}/${firstSha256}` }],
			[{ sha256: secondSha256, bytes: 84, path: `${profileId}/${secondSha256}` }],
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
			claimObjects: async () => [{ sha256: firstSha256, bytes: 42, path: `${profileId}/${firstSha256}` }],
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
			claimObjects: async () => [{ sha256: firstSha256, bytes: 42, path: `${profileId}/${firstSha256}` }],
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
			objects: [{ sha256: firstSha256, bytes: 42, path: `${profileId}/${firstSha256}` }],
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
			objects: [{ sha256: firstSha256, bytes: 42, path: `${profileId}/${firstSha256}` }],
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
