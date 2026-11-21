import { ObjectDependencyError } from "./dependency.ts";
import type { ObjectGatewayJournal } from "./journal.ts";
import { createSerialGate, type MaintenanceGate } from "./maintenance.ts";
import type { LegacyObjectMigrationItem } from "./migration.ts";
import {
	type FileSystemObjectStore,
	isVerifiedObjectBytes,
	type ObjectWriteResult,
	type VerifiedObjectBytes,
	verifyObjectBytes,
} from "./object-store.ts";
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
/** Stored objects' audit lines kept for one later sync. At this many an upload writes them itself. */
const MAX_STORED_LINES = 1000;
const RECONCILE_CONCURRENCY = 4;
const STATUS_CONCURRENCY = 16;

interface AuditWaiter {
	readonly events: readonly Record<string, unknown>[];
	readonly resolve: () => void;
	readonly reject: (error: unknown) => void;
}

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

function verify(bytes: Uint8Array, object: LegacyObjectMigrationItem): VerifiedObjectBytes {
	if (bytes.byteLength !== object.bytes) throw new Error("Replica failed integrity verification");
	try {
		return verifyObjectBytes(object.sha256, bytes);
	} catch {
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
	readonly #maxStoredLines: number;
	readonly #storedLines: Record<string, unknown>[] = [];
	#storedLinesRefused = false;
	readonly #pendingAudit: AuditWaiter[] = [];
	#auditInFlight = false;
	readonly #deletedKeys = new Set<string>();
	readonly #keyVersions = new Map<string, number>();
	#mutationEpoch = 0;
	readonly #nasGate: MaintenanceGate;

	constructor(
		journal: ObjectGatewayJournal,
		store: FileSystemObjectStore,
		authority: ObjectReplicationAuthority,
		maxStoredLines = MAX_STORED_LINES,
		nasGate: MaintenanceGate = createSerialGate(),
	) {
		this.#journal = journal;
		this.#store = store;
		this.#authority = authority;
		this.#maxStoredLines = maxStoredLines;
		this.#nasGate = nasGate;
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
		verified?: VerifiedObjectBytes,
	): Promise<ObjectWriteResult> {
		const object = { profileId, sha256, bytes: bytes.byteLength };
		const proven = isVerifiedObjectBytes(verified, sha256, bytes) ? verified! : verify(bytes, object);
		return this.#journal.exclusive(key(object), async () => {
			// A line the audit refused stops uploads until it is written, as it did when each upload wrote its own.
			if (this.#storedLinesRefused || this.#storedLines.length >= this.#maxStoredLines)
				await this.flushStoredLines();
			// Recheck inside the same lane as cleanup; an earlier request is not a reusable write grant.
			await authority.authorize();
			const prior = await this.#journal.read(key(object));
			if (prior !== undefined && pendingObject(prior, key(object)).state === "delete")
				throw new ObjectDependencyError(409);
			this.#invalidateDeleted(key(object));
			await this.#journal.write(key(object), { ...object, state: "unconfirmed" });
			const result = await this.#store.put(profileId, sha256, bytes, proven);
			await authority.confirm();
			// The answer waits for the intent and the bytes only: on the NAS each synchronous write is a disk flush. The
			// entry stays `unconfirmed`, which the reconcile treats as it treats `replicate` (a crash just here left it so
			// already). The audit line waits in memory for the next audit write (`#append`). A crash before that loses it;
			// the bytes, the catalog row and the entry stand (RUNTIME-COMPANY-FOLDER-C1D.md §9.9).
			this.#storedLines.push({
				event: "object_stored_replication_pending",
				at: new Date().toISOString(),
				...object,
			});
			return result;
		});
	}

	/** Writes the stored objects' audit lines waiting, with one sync, after any write already going. */
	flushStoredLines(): Promise<void> {
		return this.#append([]);
	}

	/** Appends `events` after the stored objects' lines waiting, in one write with one sync, one call at a time. So an
	 * object's stored line comes before any later line about that object: its upload and whoever writes that line hold
	 * the object's lock in turn. A refused write keeps the lines waiting and refuses uploads until a later try writes
	 * them. A write whose sync failed may have landed, so that try can repeat its lines, same text and time. */
	#append(events: readonly Record<string, unknown>[]): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			this.#pendingAudit.push({ events, resolve, reject });
			if (!this.#auditInFlight) void this.#drainAudit();
		});
	}

	async #drainAudit(): Promise<void> {
		this.#auditInFlight = true;
		try {
			while (this.#pendingAudit.length > 0) {
				const batch = this.#pendingAudit.splice(0);
				const lines = this.#storedLines.splice(0);
				const events: Record<string, unknown>[] = [...lines];
				for (const item of batch) {
					for (const event of item.events) events.push(event);
				}
				if (events.length === 0) {
					for (const item of batch) item.resolve();
					continue;
				}
				try {
					await this.#journal.audit(...events);
					this.#storedLinesRefused = false;
					for (const item of batch) item.resolve();
				} catch (error) {
					if (lines.length > 0) {
						this.#storedLines.unshift(...lines);
						this.#storedLinesRefused = true;
					}
					for (const item of batch) item.reject(error);
				}
			}
		} finally {
			this.#auditInFlight = false;
		}
	}

	/** Runs `operation` under the object's lock: the one its upload, replication, cleanup and folder GC's lane take. */
	async exclusive<T>(profileId: string, sha256: string, operation: () => Promise<T>): Promise<T> {
		return this.#journal.exclusive(key({ profileId, sha256, bytes: 0 }), operation);
	}

	/** Folder GC (C1D §9.8), with the object's lock held: the reconcile copies the object's replica again. An entry of
	 * the deleted-company lane (`delete`, `deleted`) is left alone. */
	async requeueLocked(object: LegacyObjectMigrationItem): Promise<void> {
		const name = key(object);
		const prior = await this.#journal.read(name);
		if (prior !== undefined && ["delete", "deleted"].includes(pendingObject(prior, name).state)) return;
		this.#invalidateDeleted(name);
		await this.#journal.write(name, { ...object, state: "replicate" });
	}

	/** Folder GC, with the object's lock held: the object is gone, so its entry goes, unless it is the deleted-company
	 * lane's. */
	async forgetLocked(profileId: string, sha256: string): Promise<void> {
		const name = key({ profileId, sha256, bytes: 0 });
		const prior = await this.#journal.read(name);
		if (prior === undefined || ["delete", "deleted"].includes(pendingObject(prior, name).state)) return;
		this.#invalidateDeleted(name);
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
		const name = key(object);
		this.#invalidateDeleted(name);
		await this.#journal.write(name, {
			profileId: object.profileId,
			sha256: object.sha256,
			bytes: object.bytes,
			state: "blocked",
			...(since === undefined ? {} : { missingSince: since }),
		});
	}

	audit(event: Record<string, unknown>): Promise<void> {
		return this.#append([event]);
	}

	async remove(profileId: string, sha256: string, bytes: number, authorizationId: string): Promise<void> {
		const object: PendingObject = { profileId, sha256, bytes, state: "delete", authorizationId };
		const name = key(object);
		await this.#journal.exclusive(name, async () => {
			this.#invalidateDeleted(name);
			await this.#journal.write(name, object);
			await this.#delete(object, false);
		});
	}

	#invalidateDeleted(name: string): void {
		this.#deletedKeys.delete(name);
		this.#keyVersions.set(name, ++this.#mutationEpoch);
	}

	#rememberDeletedIfUnchanged(name: string, versionBeforeRead: number | undefined): void {
		// WHY: Reject stale unlocked reads that raced with an upload or revive invalidating the same key.
		if (this.#keyVersions.get(name) === versionBeforeRead) this.#deletedKeys.add(name);
	}

	#pruneDeletedCache(names: readonly string[]): void {
		if (this.#deletedKeys.size === 0 && this.#keyVersions.size === 0) return;
		const present = new Set(names);
		for (const cached of this.#deletedKeys) {
			if (!present.has(cached)) this.#deletedKeys.delete(cached);
		}
		for (const key of this.#keyVersions.keys()) {
			if (!present.has(key)) this.#keyVersions.delete(key);
		}
	}

	async status(): Promise<{ pending: number; blocked: number; degraded: boolean }> {
		const names = await this.#journal.list("pending");
		this.#pruneDeletedCache(names);
		const toRead = names.filter((name) => !this.#deletedKeys.has(name));
		let pending = 0;
		let blocked = 0;
		let cursor = 0;
		const worker = async (): Promise<void> => {
			while (cursor < toRead.length) {
				const name = toRead[cursor++]!;
				const version = this.#keyVersions.get(name);
				const stored = await this.#journal.read(name);
				if (stored === undefined) continue;
				const entry = pendingObject(stored, name);
				if (entry.state === "deleted") this.#rememberDeletedIfUnchanged(name, version);
				else if (entry.state === "blocked") blocked++;
				else pending++;
			}
		};
		await Promise.all(Array.from({ length: Math.min(STATUS_CONCURRENCY, toRead.length) }, () => worker()));
		return {
			pending,
			blocked,
			degraded: this.#lastError || this.#storedLinesRefused || pending > 0 || blocked > 0,
		};
	}

	async reconcile(limit = 50): Promise<void> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
			throw new Error("Replication batch limit is invalid");
		if (this.#running) return;
		this.#running = true;
		this.#lastError = false;
		try {
			// A refused audit shows as degraded and stops uploads; the entries below still go on.
			await this.flushStoredLines().catch(() => {
				this.#lastError = true;
			});
			const names = await this.#journal.list("pending");
			this.#pruneDeletedCache(names);
			const ordered = this.#pendingCursor
				? [
						...names.filter((name) => name > this.#pendingCursor!),
						...names.filter((name) => name <= this.#pendingCursor!),
					]
				: names;
			const candidates = ordered.filter((name) => !this.#deletedKeys.has(name));
			const selected: string[] = [];
			for (let offset = 0; offset < candidates.length && selected.length < limit; offset += STATUS_CONCURRENCY) {
				const slice = candidates.slice(offset, offset + STATUS_CONCURRENCY);
				const versions = slice.map((name) => this.#keyVersions.get(name));
				const records = await Promise.all(slice.map((name) => this.#journal.read(name)));
				for (let i = 0; i < slice.length && selected.length < limit; i++) {
					const name = slice[i]!;
					const stored = records[i];
					if (stored === undefined) continue;
					const initial = pendingObject(stored, name);
					if (initial.state === "deleted") {
						this.#rememberDeletedIfUnchanged(name, versions[i]);
						continue;
					}
					if (initial.state === "blocked") continue;
					selected.push(name);
				}
			}
			this.#pendingCursor = selected.length >= limit ? selected.at(-1) : undefined;
			let pendingIndex = 0;
			let pendingAborted = false;
			const pendingWorker = async (): Promise<void> => {
				while (!pendingAborted && pendingIndex < selected.length) {
					const name = selected[pendingIndex++]!;
					try {
						await this.#journal.exclusive(name, async () => {
							const stored = await this.#journal.read(name);
							if (stored === undefined) return;
							const object = pendingObject(stored, name);
							try {
								if (object.state === "delete") await this.#delete(object, true);
								else if (object.state !== "blocked" && object.state !== "deleted")
									await this.#replicate(object);
							} catch (error) {
								this.#lastError = true;
								if (error instanceof ObjectDependencyError && !error.unavailable && object.state !== "delete") {
									this.#invalidateDeleted(name);
									await this.#journal.write(name, { ...object, state: "blocked" });
									await this.audit({
										event: "replication_blocked",
										at: new Date().toISOString(),
										profileId: object.profileId,
										sha256: object.sha256,
									});
								}
							}
						});
					} catch {
						pendingAborted = true;
						this.#lastError = true;
					}
				}
			};
			await Promise.allSettled(
				Array.from({ length: Math.min(RECONCILE_CONCURRENCY, selected.length) }, () => pendingWorker()),
			);
			if (pendingAborted) return;
			// The durable catalog discovers Supabase-first writes even if a client died before mirroring.
			const discovered = await this.#authority.listLegacyObjects(this.#scanCursor, limit);
			let discoveredIndex = 0;
			let discoveredAborted = false;
			const discoveredWorker = async (): Promise<void> => {
				while (!discoveredAborted && discoveredIndex < discovered.length) {
					const object = discovered[discoveredIndex++]!;
					const name = key(object);
					try {
						await this.#journal.exclusive(name, async () => {
							const prior = await this.#journal.read(name);
							if (prior !== undefined) {
								if (!["deleted", "blocked"].includes(pendingObject(prior, name).state)) return;
								// A new, currently authorized upload of the same immutable hash
								// must not be stranded behind an older cleanup tombstone.
								await this.#authority.authorizeReplication(object.profileId, object.sha256, object.bytes);
							}
							this.#invalidateDeleted(name);
							await this.#journal.write(name, { ...object, state: "unconfirmed" });
							try {
								await this.#replicate({ ...object, state: "unconfirmed" });
							} catch {
								this.#lastError = true;
							}
						});
					} catch {
						discoveredAborted = true;
						this.#lastError = true;
					}
				}
			};
			await Promise.allSettled(
				Array.from({ length: Math.min(RECONCILE_CONCURRENCY, discovered.length) }, () => discoveredWorker()),
			);
			if (!discoveredAborted) this.#scanCursor = discovered.length < limit ? undefined : discovered.at(-1);
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
			bytes = await this.#nasGate.run(() => this.#store.get(object.profileId, object.sha256, object.bytes));
			if (bytes.byteLength !== object.bytes) throw new Error("Replica failed integrity verification");
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "Object not found") throw error;
			bytes = await this.#authority.readLegacyObject(object.profileId, object.sha256);
			const verified = verify(bytes, object);
			await this.#nasGate.run(() => this.#store.put(object.profileId, object.sha256, bytes, verified));
		}
		await this.#authority.confirmReplica(object.profileId, object.sha256, object.bytes);
		// WHY: reconcile treats `unconfirmed` identically to `replicate`, avoiding an extra NFS temp+fsync+rename here.
		await this.#authority.writeReplica(object.profileId, object.sha256, bytes);
		verify(await this.#authority.readLegacyObject(object.profileId, object.sha256), object);
		await this.audit({
			event: "object_replicated",
			at: new Date().toISOString(),
			profileId: object.profileId,
			sha256: object.sha256,
			bytes: object.bytes,
		});
		await this.#journal.remove(key(object));
	}

	async #delete(object: PendingObject, gated: boolean): Promise<void> {
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
			const removeLocal = () => this.#store.remove(object.profileId, object.sha256);
			await (gated ? this.#nasGate.run(removeLocal) : removeLocal());
			await this.#authority.finalizeDelete(object.authorizationId, object.profileId, object.sha256, object.bytes);
		}
		const name = key(object);
		await this.#journal.write(name, { ...object, state: "deleted" });
		this.#deletedKeys.add(name);
		await this.audit({
			event: "object_deleted",
			at: new Date().toISOString(),
			profileId: object.profileId,
			sha256: object.sha256,
			authorizationId: object.authorizationId,
		});
	}
}
