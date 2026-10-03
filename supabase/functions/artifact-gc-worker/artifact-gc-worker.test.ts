import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createRoutedArtifactGcStorageProvider,
	parseArtifactGcWorkerJobs,
	parseArtifactGcWorkerObjects,
	parseAuthorizedArtifactGcWorkerObjects,
	parseCompanyObjectGcWorkerJob,
	parseCompanyStorageDeletions,
	parseFolderObjectGcClaim,
	resolveArtifactGcWorkerAuthorization,
	runArtifactGcWorkerBatch,
	runCompanyObjectGcWorkerJob,
	runCompanyStorageDeletions,
	runFolderObjectGc,
	reconcileAuthorizedArtifactGcWorkerObjects,
	type ArtifactGcStorageProvider,
	type ArtifactGcWorkerJob,
	type ArtifactGcWorkerStore,
	type CompanyObjectGcWorkerStore,
	type CompanyStorageDeletion,
	type CompanyStorageDeletionStore,
	type FolderObjectGcClaim,
	type FolderObjectGcStore,
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

describe("a deleted company's Storage objects (company delete D5a)", () => {
	const company = "30000000-0000-4000-8000-000000000010";
	const capsule: CompanyStorageDeletion = {
		bucket: "qorpera-native-compute-capsules",
		path: "30000000-0000-4000-8000-0000000001a1.capsule",
	};
	const recovery: CompanyStorageDeletion = { bucket: "qorpera-identity-recovery", path: `${company}/` };
	const fakeStorage = (objects: Record<string, string[]>) => {
		const calls: string[] = [];
		const completed: Array<{ path: string; error?: string }> = [];
		const store: CompanyStorageDeletionStore = {
			list: async (bucket, prefix) => {
				calls.push(`list ${bucket} ${prefix}`);
				return (objects[bucket] ?? [])
					.filter((path) => path.startsWith(prefix))
					.slice(0, 100)
					.map((path) => path.slice(prefix.length));
			},
			remove: async (bucket, paths) => {
				calls.push(`remove ${bucket} ${paths.length}`);
				objects[bucket] = (objects[bucket] ?? []).filter((path) => !paths.includes(path));
			},
			complete: async (entry, error) => {
				completed.push({ path: entry.path, ...(error ? { error } : {}) });
			},
		};
		return { store, calls, completed, objects };
	};
	it("accepts only a capsule object or a company's recovery prefix", () => {
		assert.deepEqual(parseCompanyStorageDeletions([capsule, recovery]), [capsule, recovery]);
		for (const bad of [
			[{ bucket: "qorpera-profile-objects", path: `${company}/x` }],
			[{ bucket: "qorpera-identity-recovery", path: `${company}` }],
			[{ bucket: "qorpera-identity-recovery", path: `${company}/../` }],
			[{ bucket: "qorpera-native-compute-capsules", path: `${company}/` }],
			[{ bucket: "qorpera-identity-recovery", path: capsule.path }],
			[{ bucket: "qorpera-native-compute-capsules", path: "30000000-0000-4000-8000-0000000001a1.capsule/x" }],
			[{ bucket: "qorpera-native-compute-capsules", path: "30000000-0000-4000-8000-0000000001A1.capsule" }],
			[{ ...capsule, extra: 1 }],
			{ ...capsule },
			Array.from({ length: 101 }, () => capsule),
		])
			assert.throws(() => parseCompanyStorageDeletions(bad), /invalid/);
	});
	it("removes a capsule and empties the recovery prefix in rounds, then completes both", async () => {
		const backups = Array.from({ length: 150 }, (_, index) => `${company}/${index.toString(16).padStart(64, "0")}`);
		const fake = fakeStorage({
			"qorpera-native-compute-capsules": [capsule.path, "30000000-0000-4000-8000-0000000001a9.capsule"],
			"qorpera-identity-recovery": [...backups, "30000000-0000-4000-8000-000000000099/" + "e".repeat(64)],
		});
		assert.deepEqual(await runCompanyStorageDeletions([capsule, recovery], fake.store), {
			claimed: 2,
			completed: 2,
			failed: 0,
		});
		assert.deepEqual(fake.objects["qorpera-native-compute-capsules"], ["30000000-0000-4000-8000-0000000001a9.capsule"]);
		assert.deepEqual(fake.objects["qorpera-identity-recovery"], ["30000000-0000-4000-8000-000000000099/" + "e".repeat(64)]);
		assert.deepEqual(fake.completed, [{ path: capsule.path }, { path: recovery.path }]);
		assert.equal(fake.calls.filter((call) => call.startsWith("remove qorpera-identity-recovery")).length, 2);
	});
	it("records a failure on its entry, leaves anything unexpected under the prefix, and goes on", async () => {
		const fake = fakeStorage({ "qorpera-identity-recovery": [`${company}/journal`, `${company}/${"a".repeat(64)}`] });
		const store: CompanyStorageDeletionStore = {
			...fake.store,
			remove: async (bucket, paths) => {
				if (bucket === "qorpera-native-compute-capsules") throw new Error("Storage object removal failed");
				await fake.store.remove(bucket, paths);
			},
		};
		assert.deepEqual(await runCompanyStorageDeletions([capsule, recovery], store), {
			claimed: 2,
			completed: 0,
			failed: 2,
		});
		assert.deepEqual(fake.completed, [
			{ path: capsule.path, error: "Storage object removal failed" },
			{ path: recovery.path, error: "The recovery prefix holds an unexpected object" },
		]);
		assert.equal(fake.objects["qorpera-identity-recovery"]?.length, 2);
	});
	it("stops a prefix that does not empty after ten rounds, and records a short error without NUL", async () => {
		const stuck = fakeStorage({ "qorpera-identity-recovery": [`${company}/${"b".repeat(64)}`] });
		let removes = 0;
		const store: CompanyStorageDeletionStore = {
			...stuck.store,
			remove: async () => {
				removes += 1;
			},
		};
		assert.deepEqual(await runCompanyStorageDeletions([recovery], store), { claimed: 1, completed: 0, failed: 1 });
		assert.equal(removes, 10);
		assert.deepEqual(stuck.completed, [{ path: recovery.path, error: "Recovery objects remain" }]);
		const noisy = fakeStorage({});
		await runCompanyStorageDeletions([capsule], {
			...noisy.store,
			remove: async () => {
				throw new Error(`\u0000${"😀".repeat(600)}`);
			},
		});
		const recorded = noisy.completed[0]?.error ?? "";
		// 500 code points, as SQL counts them (a UTF-16 cut would split the last pair).
		assert.equal(Array.from(recorded).length, 500);
		assert.equal(recorded, "😀".repeat(500));
		const blank = fakeStorage({});
		await runCompanyStorageDeletions([capsule], {
			...blank.store,
			remove: async () => {
				throw new Error("\u0000\u0000");
			},
		});
		assert.deepEqual(blank.completed, [{ path: capsule.path, error: "Storage cleanup failed" }]);
	});
});

describe("folder object cleanup (C1D §9.10)", () => {
	const folderLease = "64dc6943-b71c-4ba4-a38d-78da0861e0dc";
	const claimed = (sha: string, extra: Record<string, unknown> = {}) => ({
		profileId,
		sha256: sha,
		bytes: 7,
		backend: "nas-object-gateway",
		leaseId: folderLease,
		leaseExpiresAt: "2026-10-03T06:00:00.000Z",
		...extra,
	});
	const claim = (...objects: Record<string, unknown>[]) => ({ schema: "qorpera.folder-object-gc-claim/v1", objects });
	function fakeFolder(options: {
		enabled?: boolean;
		answers?: Array<"removed" | "restored" | "stale" | "busy" | Error>;
		objects?: Record<string, unknown>[];
	}) {
		const calls: string[] = [];
		const answers = [...(options.answers ?? [])];
		const store: FolderObjectGcStore = {
			enabled: async () => {
				calls.push("enabled");
				return options.enabled ?? true;
			},
			sweep: async (limit) => {
				calls.push(`sweep ${limit}`);
				return 3;
			},
			claim: async (limit, leaseId) => {
				calls.push(`claim ${limit} ${leaseId}`);
				return claim(...(options.objects ?? []));
			},
			collect: async (object: FolderObjectGcClaim) => {
				calls.push(`collect ${object.sha256.slice(0, 1)} ${object.leaseId}`);
				const answer = answers.shift() ?? "removed";
				if (answer instanceof Error) throw answer;
				return answer;
			},
		};
		return { store, calls };
	}

	it("reads the claim: NAS-backed objects under this run's lease, each once", () => {
		assert.deepEqual(parseFolderObjectGcClaim(claim(claimed(firstSha256)), folderLease), [
			{ profileId, sha256: firstSha256, bytes: 7, leaseId: folderLease },
		]);
		assert.deepEqual(parseFolderObjectGcClaim(claim(), folderLease), []);
		for (const bad of [
			{ schema: "qorpera.folder-object-gc-claim/v2", objects: [] },
			{ ...claim(), extra: true },
			claim(claimed(firstSha256, { leaseId: leaseId })),
			claim(claimed(firstSha256, { backend: "supabase-storage" })),
			claim(claimed(firstSha256), claimed(firstSha256)),
			claim(claimed("A".repeat(64))),
			claim(claimed(firstSha256, { bytes: 8 * 1024 * 1024 + 1 })),
			claim(claimed(firstSha256, { profileId: "not-a-company" })),
			claim(...Array.from({ length: 101 }, (_, index) => claimed(index.toString(16).padStart(64, "0")))),
		])
			assert.throws(() => parseFolderObjectGcClaim(bad, folderLease));
	});

	it("does nothing while its switch is off", async () => {
		const fake = fakeFolder({ enabled: false, objects: [claimed(firstSha256)] });
		assert.deepEqual(await runFolderObjectGc(fake.store, folderLease), {
			enabled: false,
			swept: 0,
			claimed: 0,
			removed: 0,
			restored: 0,
			stale: 0,
			failed: 0,
			stopped: false,
		});
		assert.deepEqual(fake.calls, ["enabled"]);
	});

	it("sweeps, claims, and collects each object in order, counting each outcome; a failure leaves its mark", async () => {
		const fake = fakeFolder({
			objects: [claimed(firstSha256), claimed(secondSha256), claimed("c".repeat(64)), claimed("d".repeat(64))],
			answers: ["removed", new Error("lane failed"), "restored", "stale"],
		});
		assert.deepEqual(await runFolderObjectGc(fake.store, folderLease, { sweep: 5, claim: 6, budgetMs: 60_000 }), {
			enabled: true,
			swept: 3,
			claimed: 4,
			removed: 1,
			restored: 1,
			stale: 1,
			failed: 1,
			stopped: false,
		});
		assert.deepEqual(fake.calls, [
			"enabled",
			"sweep 5",
			`claim 6 ${folderLease}`,
			`collect a ${folderLease}`,
			`collect b ${folderLease}`,
			`collect c ${folderLease}`,
			`collect d ${folderLease}`,
		]);
	});

	it("stops for this run when the gateway is busy, leaving the rest of the claim to expire", async () => {
		const fake = fakeFolder({
			objects: [claimed(firstSha256), claimed(secondSha256), claimed("c".repeat(64))],
			answers: ["removed", "busy"],
		});
		const result = await runFolderObjectGc(fake.store, folderLease);
		assert.equal(result.stopped, true);
		assert.equal(result.removed, 1);
		assert.equal(result.claimed, 3);
		assert.deepEqual(
			fake.calls.filter((call) => call.startsWith("collect")),
			[`collect a ${folderLease}`, `collect b ${folderLease}`],
		);
	});

	it("stops for this run once its time budget is spent", async () => {
		const fake = fakeFolder({ objects: [claimed(firstSha256), claimed(secondSha256), claimed("c".repeat(64))] });
		let clock = 0;
		const store: FolderObjectGcStore = {
			...fake.store,
			collect: async (object) => {
				clock += 30_000;
				return fake.store.collect(object);
			},
		};
		const result = await runFolderObjectGc(store, folderLease, { sweep: 25, claim: 25, budgetMs: 60_000 }, () => clock);
		assert.equal(result.stopped, true);
		assert.equal(result.removed, 2);
		assert.equal(fake.calls.filter((call) => call.startsWith("collect")).length, 2);
	});

	it("fails the phase on an unreadable claim, before any lane", async () => {
		const fake = fakeFolder({ objects: [claimed(firstSha256, { leaseId })] });
		await assert.rejects(runFolderObjectGc(fake.store, folderLease), /lease/);
		assert.equal(fake.calls.filter((call) => call.startsWith("collect")).length, 0);
	});
});
