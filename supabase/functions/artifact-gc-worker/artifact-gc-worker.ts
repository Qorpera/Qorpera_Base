const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface ArtifactGcWorkerJob {
	planId: string;
	profileId: string;
	leaseId: string;
	attemptCount: number;
}

export interface ArtifactGcWorkerObject {
	sha256: string;
	bytes: number;
	path: string;
	backend: "missing" | "nas-object-gateway" | "supabase-storage";
}

export interface AuthorizedArtifactGcWorkerObject extends ArtifactGcWorkerObject {
	authorizationId: string;
	profileId: string;
}

export interface CompanyObjectGcWorkerJob {
	profileId: string;
	leaseId: string;
	objects: ArtifactGcWorkerObject[];
}

export interface CompanyObjectGcWorkerStore {
	renewLease(job: CompanyObjectGcWorkerJob): Promise<void>;
	complete(job: CompanyObjectGcWorkerJob): Promise<void>;
	release(job: CompanyObjectGcWorkerJob): Promise<void>;
}

export interface ArtifactGcWorkerStore {
	claimObjects(job: ArtifactGcWorkerJob): Promise<ArtifactGcWorkerObject[]>;
	renewLease(job: ArtifactGcWorkerJob, sha256s: string[]): Promise<void>;
	acknowledgeObjects(job: ArtifactGcWorkerJob, sha256s: string[]): Promise<void>;
	complete(job: ArtifactGcWorkerJob): Promise<void>;
	fail(job: ArtifactGcWorkerJob, message: string): Promise<"failed" | "retrying">;
}

export interface ArtifactGcStorageProvider {
	remove(objects: readonly ArtifactGcWorkerObject[], leaseId: string): Promise<void>;
}

export type ArtifactGcWorkerAuthorization =
	| { status: "authorized"; serviceKey: string }
	| { status: "unauthorized" }
	| { status: "unconfigured" };

export function resolveArtifactGcWorkerAuthorization(options: {
	presentedKey: string | undefined;
	workerKey: string | undefined;
	serviceKeys: readonly (string | undefined)[];
}): ArtifactGcWorkerAuthorization {
	if (!options.workerKey) return { status: "unconfigured" };
	if (!options.presentedKey || options.presentedKey !== options.workerKey) {
		return { status: "unauthorized" };
	}
	const serviceKey = options.serviceKeys.find((value): value is string => Boolean(value));
	return serviceKey ? { status: "authorized", serviceKey } : { status: "unconfigured" };
}

export function createRoutedArtifactGcStorageProvider(options: {
	removeSupabase(object: ArtifactGcWorkerObject, leaseId: string): Promise<void>;
	removeNas(object: ArtifactGcWorkerObject, leaseId: string): Promise<void>;
}): ArtifactGcStorageProvider {
	return {
		remove: async (objects, leaseId) => {
			for (const object of objects) {
				if (object.backend === "supabase-storage") await options.removeSupabase(object, leaseId);
				if (object.backend === "nas-object-gateway") await options.removeNas(object, leaseId);
			}
		},
	};
}

export interface ArtifactGcWorkerResult {
	claimed: number;
	completed: number;
	retrying: number;
	failed: number;
	failurePending: number;
}

export interface CompanyObjectGcWorkerResult {
	claimed: number;
	completed: number;
	failed: number;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
	return value as Record<string, unknown>;
}

function uuid(value: unknown, label: string): string {
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new Error(`Invalid ${label}`);
	return value;
}

function positiveInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`Invalid ${label}`);
	return value as number;
}

export function parseArtifactGcWorkerJobs(value: unknown): ArtifactGcWorkerJob[] {
	if (!Array.isArray(value) || value.length > 20) throw new Error("Invalid artifact cleanup job list");
	return value.map((entry) => {
		const input = record(entry, "artifact cleanup job");
		return {
			planId: uuid(input.plan_id, "artifact cleanup plan id"),
			profileId: uuid(input.profile_id, "artifact cleanup profile id"),
			leaseId: uuid(input.lease_id, "artifact cleanup lease id"),
			attemptCount: positiveInteger(input.attempt_count, "artifact cleanup attempt count"),
		};
	});
}

export function parseArtifactGcWorkerObjects(
	value: unknown,
	job: ArtifactGcWorkerJob,
): ArtifactGcWorkerObject[] {
	if (!Array.isArray(value) || value.length > 100) throw new Error("Invalid artifact cleanup object list");
	const seen = new Set<string>();
	return value.map((entry) => {
		const input = record(entry, "artifact cleanup object");
		const sha256 = input.sha256;
		const bytes = input.bytes;
		const path = input.path;
		const backend = input.backend;
		if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256) || seen.has(sha256)) {
			throw new Error("Invalid artifact cleanup object hash");
		}
		if (!Number.isSafeInteger(bytes) || (bytes as number) < 0 || (bytes as number) > 8 * 1024 * 1024) {
			throw new Error("Invalid artifact cleanup object size");
		}
		if (path !== `${job.profileId}/${sha256}`) throw new Error("Invalid artifact cleanup object path");
		if (backend !== "missing" && backend !== "nas-object-gateway" && backend !== "supabase-storage") {
			throw new Error("Invalid artifact cleanup object backend");
		}
		seen.add(sha256);
		return { sha256, bytes: bytes as number, path, backend };
	});
}

export function parseCompanyObjectGcWorkerJob(value: unknown): CompanyObjectGcWorkerJob | undefined {
	if (value === null) return undefined;
	const input = record(value, "company object cleanup job");
	const profileId = uuid(input.profile_id, "company object cleanup profile id");
	const leaseId = uuid(input.lease_id, "company object cleanup lease id");
	const job = { planId: leaseId, profileId, leaseId, attemptCount: 1 };
	const objects = parseArtifactGcWorkerObjects(input.objects, job);
	if (objects.length === 0) throw new Error("Invalid empty company object cleanup job");
	return { profileId, leaseId, objects };
}

export function parseAuthorizedArtifactGcWorkerObjects(value: unknown): AuthorizedArtifactGcWorkerObject[] {
	if (!Array.isArray(value) || value.length > 100) throw new Error("Invalid authorized object cleanup list");
	const seen = new Set<string>();
	return value.map((entry) => {
		const input = record(entry, "authorized object cleanup");
		const authorizationId = uuid(input.authorization_id, "object deletion authorization id");
		const profileId = uuid(input.profile_id, "authorized object cleanup profile id");
		const parsed = parseArtifactGcWorkerObjects(
			[
				{
					sha256: input.sha256,
					bytes: input.bytes,
					path: input.path,
					backend: input.backend,
				},
			],
			{ planId: authorizationId, profileId, leaseId: authorizationId, attemptCount: 1 },
		)[0];
		if (!parsed || seen.has(authorizationId)) throw new Error("Invalid object deletion authorization list");
		seen.add(authorizationId);
		return { ...parsed, authorizationId, profileId };
	});
}

export async function reconcileAuthorizedArtifactGcWorkerObjects(
	objects: readonly AuthorizedArtifactGcWorkerObject[],
	remove: (object: AuthorizedArtifactGcWorkerObject) => Promise<void>,
): Promise<number> {
	for (const object of objects) await remove(object);
	return objects.length;
}

function cleanupError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return (message.trim() || "Storage cleanup failed").slice(0, 1000);
}

export async function runArtifactGcWorkerBatch(
	jobs: readonly ArtifactGcWorkerJob[],
	storage: ArtifactGcStorageProvider,
	store: ArtifactGcWorkerStore,
): Promise<ArtifactGcWorkerResult> {
	const result: ArtifactGcWorkerResult = {
		claimed: jobs.length,
		completed: 0,
		retrying: 0,
		failed: 0,
		failurePending: 0,
	};
	for (const job of jobs) {
		try {
			while (true) {
				const objects = await store.claimObjects(job);
				if (objects.length === 0) break;
				await store.renewLease(
					job,
					objects.map((object) => object.sha256),
				);
				await storage.remove(objects, job.leaseId);
				await store.acknowledgeObjects(
					job,
					objects.map((object) => object.sha256),
				);
			}
			await store.complete(job);
			result.completed += 1;
		} catch (error) {
			try {
				const status = await store.fail(job, cleanupError(error));
				result[status] += 1;
			} catch {
				result.failurePending += 1;
			}
		}
	}
	return result;
}

export async function runCompanyObjectGcWorkerJob(
	job: CompanyObjectGcWorkerJob | undefined,
	storage: ArtifactGcStorageProvider,
	store: CompanyObjectGcWorkerStore,
): Promise<CompanyObjectGcWorkerResult> {
	if (!job) return { claimed: 0, completed: 0, failed: 0 };
	try {
		await store.renewLease(job);
		await storage.remove(job.objects, job.leaseId);
		await store.complete(job);
		return { claimed: job.objects.length, completed: job.objects.length, failed: 0 };
	} catch {
		try {
			await store.release(job);
		} catch {
			// The lease expires server-side; a later invocation can safely reclaim it.
		}
		return { claimed: job.objects.length, completed: 0, failed: job.objects.length };
	}
}

/** A deleted company's Storage object that no catalog row names (company delete D5a): a credential
 * capsule, or the company's identity recovery prefix. */
export interface CompanyStorageDeletion {
	bucket: "qorpera-native-compute-capsules" | "qorpera-identity-recovery";
	path: string;
}
export interface CompanyStorageDeletionStore {
	/** Up to 100 object names directly under the prefix. */
	list(bucket: CompanyStorageDeletion["bucket"], prefix: string): Promise<string[]>;
	remove(bucket: CompanyStorageDeletion["bucket"], paths: string[]): Promise<void>;
	complete(entry: CompanyStorageDeletion, error?: string): Promise<void>;
}
const CAPSULE_PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.capsule$/;
const RECOVERY_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/$/;
const RECOVERY_OBJECT = /^[0-9a-f]{64}$/;

export function parseCompanyStorageDeletions(value: unknown): CompanyStorageDeletion[] {
	if (!Array.isArray(value) || value.length > 100) throw new Error("Company storage cleanup claim is invalid");
	return value.map((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).sort().join() !== "bucket,path")
			throw new Error("Company storage cleanup claim is invalid");
		const { bucket, path } = item as Record<string, unknown>;
		if (
			typeof path !== "string" ||
			!(
				(bucket === "qorpera-native-compute-capsules" && CAPSULE_PATH.test(path)) ||
				(bucket === "qorpera-identity-recovery" && RECOVERY_PREFIX.test(path))
			)
		)
			throw new Error("Company storage cleanup claim is invalid");
		return { bucket, path };
	});
}

/** Removes each entry and completes it; a failure is recorded on its entry and it is offered again.
 * A recovery prefix is emptied in rounds of 100 and completed only once it lists nothing. A listed name
 * that is not a recovery object (a folder is listed with a trailing slash) stops that prefix before
 * anything more is removed, and the entry keeps failing until an operator looks. */
export async function runCompanyStorageDeletions(
	entries: readonly CompanyStorageDeletion[],
	store: CompanyStorageDeletionStore,
): Promise<{ claimed: number; completed: number; failed: number }> {
	const result = { claimed: entries.length, completed: 0, failed: 0 };
	for (const entry of entries) {
		try {
			if (entry.bucket === "qorpera-native-compute-capsules") await store.remove(entry.bucket, [entry.path]);
			else {
				for (let round = 0; ; round++) {
					const names = await store.list(entry.bucket, entry.path);
					if (!names.length) break;
					if (names.some((name) => !RECOVERY_OBJECT.test(name)))
						throw new Error("The recovery prefix holds an unexpected object");
					if (round >= 10) throw new Error("Recovery objects remain");
					await store.remove(
						entry.bucket,
						names.map((name) => `${entry.path}${name}`),
					);
				}
			}
			await store.complete(entry);
			result.completed += 1;
		} catch (error) {
			result.failed += 1;
			try {
				// At most 500 characters (code points, as SQL counts them), never a NUL.
				await store.complete(entry, Array.from(cleanupError(error).replaceAll("\u0000", "")).slice(0, 500).join(""));
			} catch {
				// The lease expires server-side; a later invocation offers the entry again.
			}
		}
	}
	return result;
}
