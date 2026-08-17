import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	parseArtifactGcWorkerJobs,
	parseArtifactGcWorkerObjects,
	runArtifactGcWorkerBatch,
	type ArtifactGcStorageProvider,
	type ArtifactGcWorkerJob,
	type ArtifactGcWorkerStore,
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
		const acknowledged: string[][] = [];
		let completed = false;
		const storage: ArtifactGcStorageProvider = {
			remove: async (objects) => removed.push(objects.map((object) => object.path)),
		};
		const store: ArtifactGcWorkerStore = {
			claimObjects: async () => claimed.shift() ?? [],
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
		assert.deepEqual(acknowledged, [[firstSha256], [secondSha256]]);
		assert.equal(completed, true);
	});

	it("records a retry without exposing object paths in the failure", async () => {
		let failure = "";
		const store: ArtifactGcWorkerStore = {
			claimObjects: async () => [{ sha256: firstSha256, bytes: 42, path: `${profileId}/${firstSha256}` }],
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
});
