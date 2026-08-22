import { createHash } from "node:crypto";
import type { FileSystemObjectStore } from "./object-store.ts";

export interface LegacyObjectMigrationItem {
	profileId: string;
	sha256: string;
	bytes: number;
}

export interface LegacyObjectMigrationAuthority {
	listLegacyObjects(
		after: { profileId: string; sha256: string } | undefined,
		limit: number,
	): Promise<LegacyObjectMigrationItem[]>;
	readLegacyObject(profileId: string, sha256: string): Promise<Uint8Array>;
	confirmUpload(profileId: string, sha256: string, bytes: number): Promise<void>;
}

export async function migrateLegacyObjects(
	authority: LegacyObjectMigrationAuthority,
	store: FileSystemObjectStore,
	batchSize = 100,
): Promise<number> {
	if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) {
		throw new Error("Object migration batch size must be between 1 and 500");
	}
	let cursor: { profileId: string; sha256: string } | undefined;
	let migrated = 0;
	while (true) {
		const batch = await authority.listLegacyObjects(cursor, batchSize);
		if (batch.length === 0) return migrated;
		if (batch.length > batchSize) throw new Error("Object migration authority returned an oversized batch");
		for (const object of batch) {
			const bytes = await authority.readLegacyObject(object.profileId, object.sha256);
			if (bytes.byteLength !== object.bytes || createHash("sha256").update(bytes).digest("hex") !== object.sha256) {
				throw new Error("Legacy object failed integrity verification");
			}
			await store.put(object.profileId, object.sha256, bytes);
			await authority.confirmUpload(object.profileId, object.sha256, object.bytes);
			migrated += 1;
			cursor = { profileId: object.profileId, sha256: object.sha256 };
		}
		if (batch.length < batchSize) return migrated;
	}
}
