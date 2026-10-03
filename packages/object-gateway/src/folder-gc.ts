import type { FileSystemObjectStore } from "./object-store.ts";
import type { ObjectGatewayReplication } from "./replication.ts";
import type { ObjectBackend } from "./supabase-authority.ts";

/** The folder core's GC calls the unlink lane makes (deploy/first-node/RUNTIME-COMPANY-FOLDER-C1D.md §9.8), all under
 * the GC lease the worker's claim committed. */
export interface FolderGcAuthority {
	/** The mark is live and its lease is this one; its expiry moves to at least 10 minutes on. `stale` otherwise. */
	beginFolderUnlink(
		profileId: string,
		sha256: string,
		leaseId: string,
	): Promise<{ bytes: number; backend: ObjectBackend } | "stale">;
	/** Under the catalog row's lock: `removed` (the row is gone), `restore` (rooted again, or grace moved: the mark is
	 * cleared) or `stale` (the lease is no longer current). */
	finishFolderUnlink(profileId: string, sha256: string, leaseId: string): Promise<"removed" | "restore" | "stale">;
	/** Clears this lease's mark now, rather than when it expires. */
	abandonFolderUnlink(profileId: string, sha256: string, leaseId: string): Promise<boolean>;
	/** What to do with a quarantined object: `live` (its lease is current: a lane is in flight), `restore` or
	 * `remove` (no catalog row, or the company is being deleted). */
	folderQuarantineState(profileId: string, sha256: string, leaseId: string): Promise<"live" | "restore" | "remove">;
	/** Whether an object is catalogued (C1D §9.9): `missing` only for a company folder GC serves, with no catalog row
	 * and no upload intent that still roots it; `other` for any other company, which folder GC leaves alone. */
	folderCatalogState(profileId: string, sha256: string): Promise<"catalogued" | "listed" | "missing" | "other">;
	removeReplica(profileId: string, sha256: string): Promise<void>;
}

/** How long a folder-v2 object's bytes stay after the gateway first found them with no catalog row (C1D §9.9), as
 * GC's own grace (§9.4). */
const UNCATALOGUED_GRACE_MS = 24 * 60 * 60 * 1000;

export type FolderGcOutcome = "removed" | "restored" | "stale";

interface Quarantined {
	profileId: string;
	sha256: string;
	leaseId: string;
	bytes: number;
}

/**
 * Folder GC's unlink lane and its recovery (C1D §9.8). The lane collects one object the worker's claim marked: it
 * moves the NAS file into quarantine, removes the Storage replica while the mark is live, and asks the folder core to
 * finish, which deletes the catalog row only if nothing roots the object again; then the quarantined file is removed
 * or put back. The quarantine directory is the lane's journal: the scan finds what a lane left behind, and asks the
 * folder core what to do with it. Lane and scan take the object's lock, which its upload and replication take too, so
 * none of them runs at once on one object; under it they use only the journal's unlocked operations.
 */
export class ObjectGatewayFolderGc {
	readonly #store: FileSystemObjectStore;
	readonly #replication: ObjectGatewayReplication;
	readonly #authority: FolderGcAuthority;
	readonly #now: () => number;
	#running = false;
	#lastError = false;
	#blockedCursor: string | undefined;

	constructor(
		store: FileSystemObjectStore,
		replication: ObjectGatewayReplication,
		authority: FolderGcAuthority,
		now: () => number = Date.now,
	) {
		this.#store = store;
		this.#replication = replication;
		this.#authority = authority;
		this.#now = now;
	}

	/** The lane for one marked object: DELETE /v1/folder-gc/<profileId>/<sha256> with its GC lease. */
	async collect(profileId: string, sha256: string, leaseId: string): Promise<FolderGcOutcome> {
		return this.#replication.exclusive(profileId, sha256, async () => {
			const begun = await this.#authority.beginFolderUnlink(profileId, sha256, leaseId);
			if (begun === "stale") return "stale";
			const object = { profileId, sha256, leaseId, bytes: begun.bytes };
			// The claim marks only NAS-backed rows. Removing a Storage-backed row's Storage file would delete the
			// catalog row through the mirror trigger, past the finish's re-check, so such a row is never collected here.
			if (begun.backend !== "nas-object-gateway") {
				await this.#authority.abandonFolderUnlink(profileId, sha256, leaseId);
				return "stale";
			}
			try {
				// The replica goes while the mark is live, and only once the quarantined NAS file is a copy to put back.
				// With no NAS file the replica is the only copy: a marker records that, and it stays until `removed`.
				const moved = (await this.#store.quarantine(profileId, sha256, leaseId)) === "moved";
				if (moved) await this.#authority.removeReplica(profileId, sha256);
				else await this.#store.markReplicaOnly(profileId, sha256, leaseId, object.bytes);
				const finished = await this.#authority.finishFolderUnlink(profileId, sha256, leaseId);
				if (finished === "removed") {
					await this.#remove(object, !moved);
					await this.#audit("folder_object_removed", object);
					return "removed";
				}
				if (finished === "restore") {
					await this.#restore(object);
					await this.#audit("folder_object_restored", object);
					return "restored";
				}
				await this.#settle(object);
				return "stale";
			} catch (error) {
				// The lane's own failure: its mark goes now, so the object is put back now rather than when the lease
				// expires. What cannot be settled here is the scan's.
				await this.#authority.abandonFolderUnlink(profileId, sha256, leaseId).catch(() => false);
				await this.#settle(object).catch(() => undefined);
				throw error;
			}
		});
	}

	/** The scan: each quarantined object, under its lock, as the folder core says; then the blocked entries of bytes
	 * with no catalog row. Runs at start and with every reconcile, before replication, so a replicate entry finds its
	 * object back in place. */
	async recover(limit = 50): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		this.#lastError = false;
		try {
			await this.#quarantined(limit);
			await this.#uncatalogued(limit);
		} finally {
			this.#running = false;
		}
	}

	async #quarantined(limit: number): Promise<void> {
		try {
			for (const entry of await this.#store.listQuarantine(limit)) {
				try {
					await this.#replication.exclusive(entry.profileId, entry.sha256, async () => {
						// A lane of this object that held the lock meanwhile has settled the entry itself.
						if (!(await this.#store.isQuarantined(entry))) return;
						const state = await this.#authority.folderQuarantineState(
							entry.profileId,
							entry.sha256,
							entry.leaseId,
						);
						if (state === "restore") await this.#restore(entry);
						else if (state === "remove") await this.#remove(entry, true);
					});
				} catch {
					this.#lastError = true;
				}
			}
		} catch {
			this.#lastError = true;
		}
	}

	/**
	 * Bytes with no catalog row (C1D §9.9): a NAS put whose confirm never ran. Its entry ends `blocked`, because folder
	 * replication refuses a missing row, and the gateway reports degraded for it. Under the object's lock (an upload
	 * holds it from its put to its confirm), each blocked entry's object is checked again: once a folder-v2 object has
	 * had no catalog row and no upload intent rooting it for the grace window from when this gateway first found it so,
	 * its NAS file and any Storage replica are removed and the entry dropped. Entries of any other company, and of
	 * catalogued objects, stay as they are. A pass reads up to 500 entries and checks up to `limit`, going on next time.
	 */
	async #uncatalogued(limit: number): Promise<void> {
		let objects: Awaited<ReturnType<ObjectGatewayReplication["blockedEntries"]>>["objects"];
		try {
			const page = await this.#replication.blockedEntries(this.#blockedCursor, limit);
			objects = page.objects;
			this.#blockedCursor = page.next;
		} catch {
			this.#lastError = true;
			return;
		}
		for (const listed of objects) {
			try {
				await this.#replication.exclusive(listed.profileId, listed.sha256, async () => {
					const entry = await this.#replication.blockedLocked(listed.profileId, listed.sha256);
					if (!entry) return;
					if ((await this.#authority.folderCatalogState(entry.profileId, entry.sha256)) !== "missing") return;
					if (entry.missingSince === undefined) {
						await this.#replication.markMissingLocked(entry, new Date(this.#now()).toISOString());
						return;
					}
					if (this.#now() - Date.parse(entry.missingSince) < UNCATALOGUED_GRACE_MS) return;
					await this.#store.remove(entry.profileId, entry.sha256);
					await this.#authority.removeReplica(entry.profileId, entry.sha256);
					await this.#replication.forgetLocked(entry.profileId, entry.sha256);
					await this.#audit("folder_object_uncatalogued_removed", entry);
				});
			} catch {
				this.#lastError = true;
			}
		}
	}

	/** Whether the last scan met an error. */
	degraded(): boolean {
		return this.#lastError;
	}

	async #settle(object: Quarantined): Promise<void> {
		const state = await this.#authority.folderQuarantineState(object.profileId, object.sha256, object.leaseId);
		if (state === "restore") await this.#restore(object);
		else if (state === "remove") await this.#remove(object, true);
	}

	/** Put back: first the replicate entry, so a stop between the two still copies the replica again once the file is
	 * back; then the file returns to its NAS path, or the marker goes (the reconcile then copies the replica to the
	 * NAS). */
	async #restore(object: Quarantined): Promise<void> {
		await this.#replication.requeueLocked({
			profileId: object.profileId,
			sha256: object.sha256,
			bytes: object.bytes,
		});
		await this.#store.restoreQuarantined(object.profileId, object.sha256, object.leaseId, object.bytes);
	}

	/** Removed for good: the replica (if the lane has not removed it already), then the quarantined file and marker, the
	 * lane's own record, last; then the object's journal entry, unless it is the deleted-company lane's. */
	async #remove(object: Quarantined, replica: boolean): Promise<void> {
		if (replica) await this.#authority.removeReplica(object.profileId, object.sha256);
		await this.#store.removeQuarantined(object.profileId, object.sha256, object.leaseId, object.bytes);
		await this.#replication.forgetLocked(object.profileId, object.sha256);
	}

	async #audit(event: string, object: { profileId: string; sha256: string; leaseId?: string }): Promise<void> {
		// The outcome stands; a lost audit line is reported as degraded, not as a failed lane.
		await this.#replication
			.audit({
				event,
				at: new Date().toISOString(),
				profileId: object.profileId,
				sha256: object.sha256,
				...(object.leaseId === undefined ? {} : { leaseId: object.leaseId }),
			})
			.catch(() => {
				this.#lastError = true;
			});
	}
}
