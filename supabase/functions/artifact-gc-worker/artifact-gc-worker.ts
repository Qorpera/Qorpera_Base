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
}

export interface ArtifactGcWorkerStore {
	claimObjects(job: ArtifactGcWorkerJob): Promise<ArtifactGcWorkerObject[]>;
	renewLease(job: ArtifactGcWorkerJob, sha256s: string[]): Promise<void>;
	acknowledgeObjects(job: ArtifactGcWorkerJob, sha256s: string[]): Promise<void>;
	complete(job: ArtifactGcWorkerJob): Promise<void>;
	fail(job: ArtifactGcWorkerJob, message: string): Promise<"failed" | "retrying">;
}

export interface ArtifactGcStorageProvider {
	remove(objects: readonly ArtifactGcWorkerObject[]): Promise<void>;
}

export interface ArtifactGcWorkerResult {
	claimed: number;
	completed: number;
	retrying: number;
	failed: number;
	failurePending: number;
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
		if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256) || seen.has(sha256)) {
			throw new Error("Invalid artifact cleanup object hash");
		}
		if (!Number.isSafeInteger(bytes) || (bytes as number) < 0 || (bytes as number) > 8 * 1024 * 1024) {
			throw new Error("Invalid artifact cleanup object size");
		}
		if (path !== `${job.profileId}/${sha256}`) throw new Error("Invalid artifact cleanup object path");
		seen.add(sha256);
		return { sha256, bytes: bytes as number, path };
	});
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
				await storage.remove(objects);
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
