import { createHash } from "node:crypto";
import { ObjectDependencyError } from "./dependency.ts";
import type { ObjectGatewayJournal } from "./journal.ts";
import type { LegacyObjectMigrationItem } from "./migration.ts";
import type { FileSystemObjectStore, ObjectWriteResult } from "./object-store.ts";
import type { ObjectGatewayAuthority } from "./supabase-authority.ts";

export interface ObjectReplicationAuthority extends ObjectGatewayAuthority {
	listLegacyObjects(
		after: { profileId: string; sha256: string } | undefined,
		limit: number,
	): Promise<LegacyObjectMigrationItem[]>;
	authorizeReplication(profileId: string, sha256: string, bytes: number): Promise<void>;
	confirmReplica(profileId: string, sha256: string, bytes: number): Promise<void>;
	writeReplica(profileId: string, sha256: string, bytes: Uint8Array): Promise<void>;
	removeReplica(profileId: string, sha256: string): Promise<void>;
}

interface PendingObject extends LegacyObjectMigrationItem {
	state: "unconfirmed" | "replicate" | "delete" | "deleted" | "blocked";
	authorizationId?: string;
	/** Folder GC (C1D §9.9): when a blocked entry's folder-v2 object was first found with no catalog row. */
	missingSince?: string;
}

/** An entry the reconcile gave up on (`blocked`), for folder GC's check of bytes with no catalog row. */
export interface BlockedObject extends LegacyObjectMigrationItem {
	missingSince?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;

function pendingObject(value: unknown, expectedKey: string): PendingObject {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Replication intent is invalid");
	const entry = value as PendingObject;
	if (
		!UUID.test(entry.profileId ?? "") ||
		!HASH.test(entry.sha256 ?? "") ||
		!Number.isSafeInteger(entry.bytes) ||
		entry.bytes < 0 ||
		entry.bytes > 8 * 1024 * 1024 ||
		!["unconfirmed", "replicate", "delete", "deleted", "blocked"].includes(entry.state) ||
		(["delete", "deleted"].includes(entry.state) && !UUID.test(entry.authorizationId ?? "")) ||
		(entry.missingSince !== undefined &&
			(entry.state !== "blocked" ||
				typeof entry.missingSince !== "string" ||
				!Number.isFinite(Date.parse(entry.missingSince))))
	) {
		throw new Error("Replication intent is invalid");
	}
	if (key(entry) !== expectedKey) throw new Error("Replication intent identity changed");
	return entry;
}

function key(object: LegacyObjectMigrationItem): string {
	return `pending/${object.profileId}-${object.sha256}`;
}

function verify(bytes: Uint8Array, object: LegacyObjectMigrationItem): void {
	if (bytes.byteLength !== object.bytes || createHash("sha256").update(bytes).digest("hex") !== object.sha256) {
		throw new Error("Replica failed integrity verification");
	}
}

/** Cloud-owned reconciliation. A pending intent is never a canonical company mutation or public message. */
export class ObjectGatewayReplication {
	readonly #journal: ObjectGatewayJournal;
	readonly #store: FileSystemObjectStore;
	readonly #authority: ObjectReplicationAuthority;
	#scanCursor: { profileId: string; sha256: string } | undefined;
	#pendingCursor: string | undefined;
	#lastError = false;
	#running = false;

	constructor(journal: ObjectGatewayJournal, store: FileSystemObjectStore, authority: ObjectReplicationAuthority) {
		this.#journal = journal;
		this.#store = store;
		this.#authority = authority;
	}

	async upload(token: string, profileId: string, sha256: string, bytes: Uint8Array): Promise<ObjectWriteResult> {
		return this.uploadWithAuthority(profileId, sha256, bytes, {
			authorize: () => this.#authority.authorizeUpload(token, profileId, sha256, bytes.byteLength),
			confirm: () => this.#authority.confirmUpload(profileId, sha256, bytes.byteLength),
		});
	}

	/** Callbacks belong to the trusted gateway, never to a request body. */
	async uploadWithAuthority(
		profileId: string,
		sha256: string,
		bytes: Uint8Array,
		authority: {
			authorize(): Promise<void>;
			confirm(): Promise<void>;
		},
	): Promise<ObjectWriteResult> {
		const object = { profileId, sha256, bytes: bytes.byteLength };
		verify(bytes, object);
		return this.#journal.exclusive(key(object), async () => {
			// Recheck inside the same lane as cleanup; an earlier request is not a reusable write grant.
			await authority.authorize();
			const prior = await this.#journal.read(key(object));
			if (prior !== undefined && pendingObject(prior, key(object)).state === "delete")
				throw new ObjectDependencyError(409);
			await this.#journal.write(key(object), { ...object, state: "unconfirmed" });
			const result = await this.#store.put(profileId, sha256, bytes);
			await authority.confirm();
			await this.#journal.write(key(object), { ...object, state: "replicate" });
			await this.#journal.audit({
				event: "object_stored_replication_pending",
				at: new Date().toISOString(),
				...object,
			});
			return result;
		});
	}

	/** Runs `operation` under the object's lock: the one its upload, replication, cleanup and folder GC's lane take. */
	async exclusive<T>(profileId: string, sha256: string, operation: () => Promise<T>): Promise<T> {
		return this.#journal.exclusive(key({ profileId, sha256, bytes: 0 }), operation);
	}

	/** Folder GC (C1D §9.8), with the object's lock held: the reconcile copies the object's replica again. An entry of
	 * the deleted-company lane (`delete`, `deleted`) is left alone. */
	async requeueLocked(object: LegacyObjectMigrationItem): Promise<void> {
		const prior = await this.#journal.read(key(object));
		if (prior !== undefined && ["delete", "deleted"].includes(pendingObject(prior, key(object)).state)) return;
		await this.#journal.write(key(object), { ...object, state: "replicate" });
	}

	/** Folder GC, with the object's lock held: the object is gone, so its entry goes, unless it is the deleted-company
	 * lane's. */
	async forgetLocked(profileId: string, sha256: string): Promise<void> {
		const name = key({ profileId, sha256, bytes: 0 });
		const prior = await this.#journal.read(name);
		if (prior === undefined || ["delete", "deleted"].includes(pendingObject(prior, name).state)) return;
		await this.#journal.remove(name);
	}

	/** Up to `limit` blocked entries, by name after `after`, reading at most 500 entries. `next` is where the next call
	 * goes on from, or undefined once the list has been read to its end. */
	async blockedEntries(
		after: string | undefined,
		limit: number,
	): Promise<{ objects: BlockedObject[]; next: string | undefined }> {
		const names = (await this.#journal.list("pending")).filter((name) => after === undefined || name > after);
		const objects: BlockedObject[] = [];
		let read = 0;
		for (const name of names) {
			if (objects.length >= limit || read >= 500) return { objects, next: names[read - 1] };
			read++;
			const stored = await this.#journal.read(name);
			if (stored === undefined) continue;
			const entry = pendingObject(stored, name);
			if (entry.state !== "blocked") continue;
			objects.push({
				profileId: entry.profileId,
				sha256: entry.sha256,
				bytes: entry.bytes,
				...(entry.missingSince === undefined ? {} : { missingSince: entry.missingSince }),
			});
		}
		return { objects, next: undefined };
	}

	/** With the object's lock held: its entry, if it is blocked. */
	async blockedLocked(profileId: string, sha256: string): Promise<BlockedObject | undefined> {
		const name = key({ profileId, sha256, bytes: 0 });
		const stored = await this.#journal.read(name);
		if (stored === undefined) return undefined;
		const entry = pendingObject(stored, name);
		if (entry.state !== "blocked") return undefined;
		return {
			profileId,
			sha256,
			bytes: entry.bytes,
			...(entry.missingSince === undefined ? {} : { missingSince: entry.missingSince }),
		};
	}

	/** With the object's lock held: a blocked entry notes when its object was first found with no catalog row, or,
	 * with no time, forgets it. */
	async markMissingLocked(object: LegacyObjectMigrationItem, since?: string): Promise<void> {
		await this.#journal.write(key(object), {
			profileId: object.profileId,
			sha256: object.sha256,
			bytes: object.bytes,
			state: "blocked",
			...(since === undefined ? {} : { missingSince: since }),
		});
	}

	async audit(event: Record<string, unknown>): Promise<void> {
		await this.#journal.audit(event);
	}

	async remove(profileId: string, sha256: string, bytes: number, authorizationId: string): Promise<void> {
		const object: PendingObject = { profileId, sha256, bytes, state: "delete", authorizationId };
		await this.#journal.exclusive(key(object), async () => {
			await this.#journal.write(key(object), object);
			await this.#delete(object);
		});
	}

	async status(): Promise<{ pending: number; blocked: number; degraded: boolean }> {
		let pending = 0;
		let blocked = 0;
		for (const name of await this.#journal.list("pending")) {
			const entry = pendingObject(await this.#journal.read(name), name);
			if (entry.state === "blocked" || entry.state === "unconfirmed") blocked++;
			else if (entry.state !== "deleted") pending++;
		}
		return { pending, blocked, degraded: this.#lastError || pending > 0 || blocked > 0 };
	}

	async reconcile(limit = 50): Promise<void> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
			throw new Error("Replication batch limit is invalid");
		if (this.#running) return;
		this.#running = true;
		this.#lastError = false;
		try {
			let processed = 0;
			const names = await this.#journal.list("pending");
			const ordered = this.#pendingCursor
				? [
						...names.filter((name) => name > this.#pendingCursor!),
						...names.filter((name) => name <= this.#pendingCursor!),
					]
				: names;
			for (const name of ordered) {
				const stored = await this.#journal.read(name);
				if (stored === undefined) continue;
				const initial = pendingObject(stored, name);
				if (initial.state === "blocked" || initial.state === "deleted") continue;
				if (processed++ >= limit) break;
				this.#pendingCursor = name;
				await this.#journal.exclusive(name, async () => {
					const stored = await this.#journal.read(name);
					if (stored === undefined) return;
					const object = pendingObject(stored, name);
					try {
						if (object.state === "delete") await this.#delete(object);
						else if (object.state !== "blocked" && object.state !== "deleted") await this.#replicate(object);
					} catch (error) {
						this.#lastError = true;
						if (error instanceof ObjectDependencyError && !error.unavailable && object.state !== "delete") {
							await this.#journal.write(name, { ...object, state: "blocked" });
							await this.#journal.audit({
								event: "replication_blocked",
								at: new Date().toISOString(),
								profileId: object.profileId,
								sha256: object.sha256,
							});
						}
					}
				});
			}
			if (processed < limit) this.#pendingCursor = undefined;
			// The durable catalog discovers Supabase-first writes even if a client died before mirroring.
			const discovered = await this.#authority.listLegacyObjects(this.#scanCursor, limit);
			for (const object of discovered) {
				await this.#journal.exclusive(key(object), async () => {
					const prior = await this.#journal.read(key(object));
					if (prior !== undefined) {
						if (!["deleted", "blocked"].includes(pendingObject(prior, key(object)).state)) return;
						// A new, currently authorized upload of the same immutable hash
						// must not be stranded behind an older cleanup tombstone.
						await this.#authority.authorizeReplication(object.profileId, object.sha256, object.bytes);
					}
					await this.#journal.write(key(object), { ...object, state: "unconfirmed" });
					try {
						await this.#replicate({ ...object, state: "unconfirmed" });
					} catch {
						this.#lastError = true;
					}
				});
			}
			this.#scanCursor = discovered.length < limit ? undefined : discovered.at(-1);
		} catch {
			this.#lastError = true;
		} finally {
			this.#running = false;
		}
	}

	async #replicate(object: PendingObject): Promise<void> {
		// Never recreate a missing/deleted catalog row from an old upload intent.
		await this.#authority.authorizeReplication(object.profileId, object.sha256, object.bytes);
		let bytes: Uint8Array;
		try {
			bytes = await this.#store.get(object.profileId, object.sha256, object.bytes);
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "Object not found") throw error;
			bytes = await this.#authority.readLegacyObject(object.profileId, object.sha256);
			verify(bytes, object);
			await this.#store.put(object.profileId, object.sha256, bytes);
		}
		verify(bytes, object);
		await this.#authority.confirmReplica(object.profileId, object.sha256, object.bytes);
		await this.#journal.write(key(object), { ...object, state: "replicate" });
		await this.#authority.writeReplica(object.profileId, object.sha256, bytes);
		verify(await this.#authority.readLegacyObject(object.profileId, object.sha256), object);
		await this.#journal.audit({
			event: "object_replicated",
			at: new Date().toISOString(),
			profileId: object.profileId,
			sha256: object.sha256,
			bytes: object.bytes,
		});
		await this.#journal.remove(key(object));
	}

	async #delete(object: PendingObject): Promise<void> {
		if (!object.authorizationId) throw new Error("Deletion intent lacks authority");
		const authority = await this.#authority.resumeDelete(
			object.authorizationId,
			object.profileId,
			object.sha256,
			object.bytes,
		);
		if (authority.state !== "completed") {
			// The SQL replication guard holds the existing GC fence at Storage insertion time.
			await this.#authority.removeReplica(object.profileId, object.sha256);
			await this.#store.remove(object.profileId, object.sha256);
			await this.#authority.finalizeDelete(object.authorizationId, object.profileId, object.sha256, object.bytes);
		}
		await this.#journal.write(key(object), { ...object, state: "deleted" });
		await this.#journal.audit({
			event: "object_deleted",
			at: new Date().toISOString(),
			profileId: object.profileId,
			sha256: object.sha256,
			authorizationId: object.authorizationId,
		});
	}
}
