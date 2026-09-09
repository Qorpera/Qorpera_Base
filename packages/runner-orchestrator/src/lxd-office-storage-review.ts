import { createHash } from "node:crypto";
import { officeDigest, officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import type { LxdOfficeStorageObservation } from "./lxd-office-inventory-worker.ts";
import { readLxdOfficeProtectedFile } from "./lxd-office-physical-host.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export interface LxdOfficeStorageReview {
	readonly schema: "qorpera.lxd-office-storage-review/v1";
	readonly reviewId: string;
	readonly decision: "initialize_empty" | "migrate_existing";
	readonly observationSha256: string;
	readonly planSha256: string;
	/** Explicit infrastructure-operator evidence, not an inferred NAS lock. The
	 * adoption executor must check the same live writer fence before effects. */
	readonly writerFence: {
		readonly state: "exclusive_writers_confirmed";
		readonly evidenceSha256: string;
	};
}

/** Closed review-document validation, not review authority. Callers must use
 * the protected loader and supply a freshly measured observation and the
 * exact validated adoption plan. This function cannot approve a plan, acquire
 * a writer fence, copy bytes, grant profiles or produce a completed receipt. */
export function parseLxdOfficeStorageReview(
	value: unknown,
	observation: LxdOfficeStorageObservation,
	planSha256: string,
): Readonly<LxdOfficeStorageReview> {
	const record = officeRecord(value, [
		"schema",
		"reviewId",
		"decision",
		"observationSha256",
		"planSha256",
		"writerFence",
	]);
	const fence = officeRecord(record.writerFence, ["state", "evidenceSha256"]);
	if (
		record.schema !== "qorpera.lxd-office-storage-review/v1" ||
		typeof record.reviewId !== "string" ||
		!UUID.test(record.reviewId) ||
		(record.decision !== "initialize_empty" && record.decision !== "migrate_existing") ||
		fence.state !== "exclusive_writers_confirmed" ||
		officeSha(record.observationSha256) !== officeDigest(observation) ||
		officeSha(record.planSha256) !== officeSha(planSha256)
	)
		throw new Error("OFFICE_STORAGE_REVIEW_MISMATCH");
	const inventory = observation.inventory;
	const empty =
		inventory.entries.length === 1 &&
		inventory.entries[0].path === "." &&
		inventory.entries[0].kind === "directory" &&
		inventory.entries[0].bytes === 0 &&
		inventory.entries[0].sha256 === null &&
		inventory.totalBytes === 0;
	if (record.decision === "initialize_empty" && !empty) throw new Error("OFFICE_STORAGE_NOT_EMPTY");
	return Object.freeze({
		schema: "qorpera.lxd-office-storage-review/v1",
		reviewId: record.reviewId,
		decision: record.decision,
		observationSha256: record.observationSha256 as string,
		planSha256: record.planSha256 as string,
		writerFence: Object.freeze({
			state: "exclusive_writers_confirmed",
			evidenceSha256: officeSha(fence.evidenceSha256),
		}),
	});
}

/** Read an operator-installed root-owned review from protected local storage.
 * Approval is never synthesized from inventory, directory names, elapsed time
 * or a member/model argument. The returned hash covers the exact file bytes. */
export async function readLxdOfficeStorageReview(
	path: string,
	observation: LxdOfficeStorageObservation,
	planSha256: string,
	signal: AbortSignal,
): Promise<{ review: Readonly<LxdOfficeStorageReview>; reviewSha256: string }> {
	signal.throwIfAborted();
	const bytes = await readLxdOfficeProtectedFile(path, 16384);
	signal.throwIfAborted();
	const review = parseLxdOfficeStorageReview(
		JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)),
		observation,
		planSha256,
	);
	return Object.freeze({ review, reviewSha256: createHash("sha256").update(bytes).digest("hex") });
}
