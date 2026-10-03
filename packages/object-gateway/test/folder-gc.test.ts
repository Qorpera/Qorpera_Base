import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObjectDependencyError } from "../src/dependency.ts";
import { ObjectGatewayFolderGc } from "../src/folder-gc.ts";
import { ObjectGatewayJournal } from "../src/journal.ts";
import { FileSystemObjectStore } from "../src/object-store.ts";
import { ObjectGatewayReplication } from "../src/replication.ts";
import { createObjectGatewayHandler } from "../src/service.ts";
import { SupabaseObjectAuthority } from "../src/supabase-authority.ts";

/** Folder GC's unlink lane and its scan (C1D §9.8) on a real NAS store and journal, with the folder core's GC SQL
 * (C1d-2a, tests 766 and 767) simulated as the gateway reaches it: the catalog, the GC row and its lease, the roots and
 * the quarantine state; and Storage's replicas. */
const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const bytes = Buffer.from("folder gc fixture");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const identity = `${profileId}/${sha256}`;
const entryKey = `pending/${profileId}-${sha256}`;

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}
function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

class FolderGcCloud {
	now = 0;
	api: "healthy" | "unavailable" = "healthy";
	storage: "healthy" | "unavailable" = "healthy";
	readonly catalog = new Map<string, { bytes: number; backend: string }>();
	readonly gc = new Map<string, { lease: string | null; expires: number }>();
	readonly rooted = new Set<string>();
	readonly deleting = new Set<string>();
	readonly replicas = new Map<string, Uint8Array>();
	/** snapshot-v1's cleanup fence on replication (20260913000200): QRC01 too, with its own message. */
	legacyFence = false;
	readonly calls: string[] = [];
	/** One-shot PostgREST 500s, by RPC, with their SQLSTATE. */
	readonly failures = new Map<string, string>();
	/** Runs before an RPC or Storage call (`storage-delete`, `storage-write`, `storage-read`) is answered: a pause. */
	readonly before = new Map<string, () => void | Promise<void>>();
	/** Runs once the call is answered: an outage that starts right after it. */
	readonly after = new Map<string, () => void>();

	#live(key: string, lease?: string): boolean {
		const mark = this.gc.get(key);
		return !!mark && mark.lease !== null && mark.expires > this.now && (lease === undefined || mark.lease === lease);
	}

	fetch: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		const operation = url.pathname.startsWith("/storage/")
			? request.method === "DELETE"
				? "storage-delete"
				: request.method === "POST"
					? "storage-write"
					: "storage-read"
			: url.pathname.split("/").at(-1)!;
		this.calls.push(operation);
		await this.before.get(operation)?.();
		const response = await (url.pathname.startsWith("/storage/")
			? this.#storageAnswer(request, url)
			: this.#rpcAnswer(operation, (await request.json()) as Record<string, unknown>));
		this.after.get(operation)?.();
		return response;
	};

	async #storageAnswer(request: Request, url: URL): Promise<Response> {
		if (this.storage === "unavailable") return Response.json({}, { status: 503 });
		if (request.method === "DELETE") {
			for (const prefix of ((await request.json()) as { prefixes: string[] }).prefixes) this.replicas.delete(prefix);
			return Response.json([]);
		}
		const key = url.pathname.split("/").slice(-2).join("/");
		if (request.method === "POST") {
			if (this.replicas.has(key)) return Response.json({ statusCode: "409" }, { status: 409 });
			this.replicas.set(key, new Uint8Array(await request.arrayBuffer()));
			return Response.json({ Key: key });
		}
		const replica = this.replicas.get(key);
		return replica ? new Response(Uint8Array.from(replica)) : Response.json({}, { status: 404 });
	}

	#rpcAnswer(name: string, body: Record<string, unknown>): Response {
		if (this.api === "unavailable") return Response.json({}, { status: 503 });
		const failure = this.failures.get(name);
		if (failure) {
			this.failures.delete(name);
			return Response.json({ code: failure, message: "injected" }, { status: 500 });
		}
		const key = `${body.p_profile_id}/${body.p_sha256}`;
		const lease = body.p_lease as string;
		switch (name) {
			case "qorpera_list_profile_objects_for_migration":
				return Response.json([]);
			case "qorpera_folder_gc_unlink_begin": {
				const object = this.catalog.get(key);
				if (!object || !this.#live(key, lease))
					return Response.json({ code: "55000", message: "GC lease is not current" }, { status: 500 });
				const mark = this.gc.get(key)!;
				mark.expires = Math.max(mark.expires, this.now + 600_000);
				return Response.json({ schema: "qorpera.folder-object-gc-unlink/v1", ...object, leaseExpiresAt: "x" });
			}
			case "qorpera_folder_gc_unlink_finish":
				if (!this.catalog.has(key)) return Response.json("removed");
				if (!this.#live(key, lease)) return Response.json("stale");
				if (this.rooted.has(key)) {
					this.gc.delete(key);
					return Response.json("restore");
				}
				this.catalog.delete(key);
				this.gc.delete(key);
				return Response.json("removed");
			case "qorpera_folder_gc_unlink_abandon": {
				const mark = this.gc.get(key);
				if (!mark || mark.lease !== lease) return Response.json(false);
				mark.lease = null;
				return Response.json(true);
			}
			case "qorpera_folder_gc_quarantine_state":
				if (this.#live(key, lease)) return Response.json("live");
				if (!this.catalog.has(key) || this.deleting.has(body.p_profile_id as string))
					return Response.json("remove");
				return Response.json("restore");
			case "qorpera_authorize_profile_object_replication":
				if (!this.catalog.has(key))
					return Response.json({ code: "42501", message: "unavailable" }, { status: 403 });
				if (this.legacyFence)
					return Response.json(
						{ code: "QRC01", message: "replication is fenced by cleanup", details: null, hint: null },
						{ status: 409 },
					);
				// C1D §9.7: an object GC holds is the conflict envelope.
				if (this.#live(key))
					return Response.json(
						{
							code: "QRC01",
							message: "Company folder object is being collected; retry",
							details: null,
							hint: null,
						},
						{ status: 409 },
					);
				return Response.json(true);
			case "qorpera_confirm_profile_object_replica":
				return Response.json(this.catalog.has(key));
		}
		throw new Error(`Unexpected synthetic RPC ${name}`);
	}
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "qorpera-folder-gc-"));
	const objectsRoot = join(root, "objects");
	await mkdir(objectsRoot, { mode: 0o700 });
	const cloud = new FolderGcCloud();
	const store = new FileSystemObjectStore(objectsRoot, 1000);
	const journal = new ObjectGatewayJournal(join(root, "state"));
	const authority = new SupabaseObjectAuthority({
		projectUrl: "https://cloud.test",
		publishableKey: "synthetic-public",
		secretKey: "synthetic-secret",
		fetch: cloud.fetch,
		requestTimeoutMs: 1000,
		circuitCooldownMs: 0,
	});
	const replication = new ObjectGatewayReplication(journal, store, authority);
	const gc = new ObjectGatewayFolderGc(store, replication, authority);
	const server: Server = createServer(
		createObjectGatewayHandler({
			store,
			authority,
			replication,
			folderGc: gc,
			controlToken: "synthetic-cleanup",
			verifierToken: "synthetic-verifier",
		}),
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture server address");
	cleanups.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	});
	const nasPath = join(objectsRoot, profileId, sha256);
	const quarantine = join(objectsRoot, ".quarantine", profileId);
	const base = `http://127.0.0.1:${address.port}`;
	return {
		cloud,
		base,
		quarantine,
		stateRoot: join(root, "state"),
		store,
		journal,
		authority,
		replication,
		gc,
		nasPath,
		/** The object, catalogued NAS-backed, with its NAS file and Storage replica as asked, marked under `lease`. */
		async seed(lease: string, options: { nas?: boolean; replica?: boolean } = {}) {
			cloud.catalog.set(identity, { bytes: bytes.length, backend: "nas-object-gateway" });
			if (options.nas ?? true) await store.put(profileId, sha256, bytes);
			if (options.replica ?? true) cloud.replicas.set(identity, Uint8Array.from(bytes));
			cloud.gc.set(identity, { lease, expires: cloud.now + 600_000 });
		},
		/** The quarantine entries of the company, by name. */
		async quarantined(): Promise<string[]> {
			return existsSync(quarantine) ? (await readdir(quarantine)).sort() : [];
		},
		async nasBytes(): Promise<Buffer | undefined> {
			return existsSync(nasPath) ? readFile(nasPath) : undefined;
		},
		lane(lease: string, headers: Record<string, string> = {}, init: RequestInit = { method: "DELETE" }) {
			return fetch(`${base}/v1/folder-gc/${profileId}/${sha256}`, {
				...init,
				headers: { authorization: "Bearer synthetic-cleanup", "x-qorpera-gc-lease-id": lease, ...headers },
			});
		},
		/** An upload of the object through the gateway's upload lane, as the folder route makes it: authorized again
		 * under the object's lock (a marked object is the conflict envelope), stored, then catalogued. */
		upload() {
			return replication.uploadWithAuthority(profileId, sha256, bytes, {
				authorize: async () => {
					const mark = cloud.gc.get(identity);
					if (mark && mark.lease !== null && mark.expires > cloud.now) throw new ObjectDependencyError(409);
				},
				confirm: async () => {
					cloud.catalog.set(identity, { bytes: bytes.length, backend: "nas-object-gateway" });
				},
			});
		},
	};
}

describe("folder GC's unlink lane", () => {
	it("removes an object nothing roots: quarantine, replica, finish, then the file and its journal entry", async () => {
		const f = await fixture();
		const lease = randomUUID();
		await f.seed(lease);
		// A replication entry left blocked for the object goes with it.
		await f.journal.write(entryKey, { profileId, sha256, bytes: bytes.length, state: "blocked" });
		const response = await f.lane(lease);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ outcome: "removed" });
		expect(f.cloud.calls).toEqual([
			"qorpera_folder_gc_unlink_begin",
			"storage-delete",
			"qorpera_folder_gc_unlink_finish",
		]);
		expect(f.cloud.catalog.has(identity)).toBe(false);
		expect(f.cloud.replicas.has(identity)).toBe(false);
		expect(await f.nasBytes()).toBeUndefined();
		expect(await f.quarantined()).toEqual([]);
		expect(await f.journal.read(entryKey)).toBeUndefined();
		const audit = await readFile(join(f.stateRoot, "audit.jsonl"), "utf-8");
		expect(audit).toContain('"event":"folder_object_removed"');
	});

	it("answers only the control token, a lease and a well-formed object", async () => {
		const f = await fixture();
		const lease = randomUUID();
		await f.seed(lease);
		expect((await f.lane(lease, { authorization: "Bearer synthetic-verifier" })).status).toBe(401);
		expect((await f.lane(lease, { "x-qorpera-gc-lease-id": "not-a-lease" })).status).toBe(400);
		expect((await f.lane(lease, {}, { method: "GET" })).status).toBe(405);
		for (const path of [
			`${profileId}/${sha256.toUpperCase()}`,
			`not-a-company/${sha256}`,
			`${profileId}/${sha256}/more`,
		]) {
			const bad = await fetch(`${f.base}/v1/folder-gc/${path}`, {
				method: "DELETE",
				headers: { authorization: "Bearer synthetic-cleanup", "x-qorpera-gc-lease-id": lease },
			});
			expect(bad.status).toBe(404);
		}
		expect(f.cloud.calls).toEqual([]);
		expect(await f.nasBytes()).toEqual(bytes);
	});

	it("restores a rooted object and copies its replica again", async () => {
		const f = await fixture();
		const lease = randomUUID();
		await f.seed(lease);
		f.cloud.rooted.add(identity);
		expect(await f.gc.collect(profileId, sha256, lease)).toBe("restored");
		expect(await f.nasBytes()).toEqual(bytes);
		expect(await f.quarantined()).toEqual([]);
		// The replica went while the mark was live; the reconcile writes it again.
		expect(f.cloud.replicas.has(identity)).toBe(false);
		expect(await f.journal.read(entryKey)).toMatchObject({ state: "replicate" });
		await f.replication.reconcile();
		expect(Buffer.from(f.cloud.replicas.get(identity)!)).toEqual(bytes);
		expect(await f.journal.read(entryKey)).toBeUndefined();
	});

	it("does nothing under a lease that is not current", async () => {
		const f = await fixture();
		await f.seed(randomUUID());
		const response = await f.lane(randomUUID());
		expect(await response.json()).toEqual({ outcome: "stale" });
		expect(f.cloud.calls).toEqual(["qorpera_folder_gc_unlink_begin"]);
		expect(await f.nasBytes()).toEqual(bytes);
		expect(f.cloud.replicas.has(identity)).toBe(true);
		// An expired mark is no mark.
		const lease = randomUUID();
		await f.seed(lease);
		f.cloud.now += 600_001;
		expect(await f.gc.collect(profileId, sha256, lease)).toBe("stale");
		expect(await f.quarantined()).toEqual([]);
	});

	it("never collects a row the begin reports Storage-backed, and gives its mark up", async () => {
		const f = await fixture();
		const lease = randomUUID();
		await f.seed(lease);
		f.cloud.catalog.set(identity, { bytes: bytes.length, backend: "supabase-storage" });
		expect(await f.gc.collect(profileId, sha256, lease)).toBe("stale");
		expect(f.cloud.calls).toEqual(["qorpera_folder_gc_unlink_begin", "qorpera_folder_gc_unlink_abandon"]);
		expect(f.cloud.replicas.has(identity)).toBe(true);
		expect(await f.nasBytes()).toEqual(bytes);
	});

	it("settles a lease that went stale at the finish by the quarantine state", async () => {
		const f = await fixture();
		const lease = randomUUID();
		await f.seed(lease);
		f.cloud.before.set("qorpera_folder_gc_unlink_finish", () => {
			f.cloud.now += 600_001;
		});
		expect(await f.gc.collect(profileId, sha256, lease)).toBe("stale");
		// The row is still there: back in place, with its replica queued again.
		expect(await f.nasBytes()).toEqual(bytes);
		expect(await f.journal.read(entryKey)).toMatchObject({ state: "replicate" });
		expect(f.cloud.calls.at(-1)).toBe("qorpera_folder_gc_quarantine_state");
	});

	it("gives its mark up on its own error, and puts the object back at once", async () => {
		const f = await fixture();
		const lease = randomUUID();
		await f.seed(lease);
		f.cloud.storage = "unavailable";
		const response = await f.lane(lease);
		expect(response.status).toBe(503);
		expect(f.cloud.calls).toEqual([
			"qorpera_folder_gc_unlink_begin",
			"storage-delete",
			"qorpera_folder_gc_unlink_abandon",
			"qorpera_folder_gc_quarantine_state",
		]);
		expect(f.cloud.gc.get(identity)?.lease).toBeNull();
		expect(await f.nasBytes()).toEqual(bytes);
		expect(await f.quarantined()).toEqual([]);
		expect(f.cloud.catalog.has(identity)).toBe(true);
	});

	it("answers a lock conflict 409 and a busy NAS lane 503, and leaves the circuit closed", async () => {
		const f = await fixture();
		const lease = randomUUID();
		await f.seed(lease);
		f.cloud.failures.set("qorpera_folder_gc_unlink_begin", "55P03");
		expect((await f.lane(lease)).status).toBe(409);
		expect(f.authority.health().api.status).toBe("healthy");
		vi.spyOn(f.store, "quarantine").mockRejectedValueOnce(new ObjectDependencyError(503));
		expect((await f.lane(lease)).status).toBe(503);
		// The mark was given up and nothing moved.
		expect(f.cloud.gc.get(identity)?.lease).toBeNull();
		expect(await f.nasBytes()).toEqual(bytes);
		expect(f.cloud.replicas.has(identity)).toBe(true);
	});

	it("keeps the replica of an object with no NAS file until the finish removes the row", async () => {
		const f = await fixture();
		const lease = randomUUID();
		await f.seed(lease, { nas: false });
		f.cloud.before.set("qorpera_folder_gc_unlink_finish", async () => {
			expect(f.cloud.replicas.has(identity)).toBe(true);
			expect(await f.quarantined()).toEqual([`${sha256}.${lease}.${bytes.length}.replica`]);
		});
		expect(await f.gc.collect(profileId, sha256, lease)).toBe("removed");
		expect(f.cloud.calls).toEqual([
			"qorpera_folder_gc_unlink_begin",
			"qorpera_folder_gc_unlink_finish",
			"storage-delete",
		]);
		expect(f.cloud.replicas.has(identity)).toBe(false);
		expect(await f.quarantined()).toEqual([]);
		// Rooted instead: the marker goes, and the reconcile copies the replica back to the NAS.
		const again = randomUUID();
		await f.seed(again, { nas: false });
		f.cloud.before.clear();
		f.cloud.rooted.add(identity);
		expect(await f.gc.collect(profileId, sha256, again)).toBe("restored");
		expect(await f.quarantined()).toEqual([]);
		expect(f.cloud.replicas.has(identity)).toBe(true);
		await f.replication.reconcile();
		expect(await f.nasBytes()).toEqual(bytes);
	});
});

describe("folder GC's scan", () => {
	/** The lane loses the database right after `step` is answered: neither its abandon nor its quarantine state gets
	 * through, as when the gateway stops there. */
	function crashAfter(f: Awaited<ReturnType<typeof fixture>>, step: string) {
		f.cloud.after.set(step, () => {
			f.cloud.api = "unavailable";
		});
	}

	it("puts back what a lane left when the database went away before the finish, once its lease is over", async () => {
		const f = await fixture();
		const lease = randomUUID();
		await f.seed(lease);
		crashAfter(f, "storage-delete");
		await expect(f.gc.collect(profileId, sha256, lease)).rejects.toBeInstanceOf(ObjectDependencyError);
		expect(await f.quarantined()).toEqual([`${sha256}.${lease}`]);
		expect(f.cloud.replicas.has(identity)).toBe(false);
		f.cloud.after.clear();
		f.cloud.api = "healthy";
		// While the lease lives the lane may still be in flight: the scan leaves it.
		await f.gc.recover();
		expect(await f.quarantined()).toEqual([`${sha256}.${lease}`]);
		// A replicate entry meanwhile is refused as a conflict and stays pending: nothing is put back from Storage.
		await f.journal.write(entryKey, { profileId, sha256, bytes: bytes.length, state: "replicate" });
		await f.replication.reconcile();
		expect(await f.journal.read(entryKey)).toMatchObject({ state: "replicate" });
		expect(await f.nasBytes()).toBeUndefined();
		expect(f.authority.health().api.status).toBe("healthy");
		f.cloud.now += 600_001;
		await f.gc.recover();
		expect(await f.nasBytes()).toEqual(bytes);
		expect(await f.quarantined()).toEqual([]);
		await f.replication.reconcile();
		expect(Buffer.from(f.cloud.replicas.get(identity)!)).toEqual(bytes);
		expect(await f.journal.read(entryKey)).toBeUndefined();
		expect(f.gc.degraded()).toBe(false);
	});

	it("keeps snapshot-v1's cleanup fence a refusal that blocks the entry, as before", async () => {
		const f = await fixture();
		f.cloud.catalog.set(identity, { bytes: bytes.length, backend: "nas-object-gateway" });
		await f.store.put(profileId, sha256, bytes);
		await f.journal.write(entryKey, { profileId, sha256, bytes: bytes.length, state: "replicate" });
		f.cloud.legacyFence = true;
		await f.replication.reconcile();
		expect(await f.journal.read(entryKey)).toMatchObject({ state: "blocked" });
		expect(f.authority.health().api.status).toBe("healthy");
	});

	it("reports a scan that met an error as degraded health until a scan succeeds", async () => {
		const f = await fixture();
		const lease = randomUUID();
		await f.seed(lease);
		crashAfter(f, "storage-delete");
		await expect(f.gc.collect(profileId, sha256, lease)).rejects.toBeInstanceOf(ObjectDependencyError);
		f.cloud.now += 600_001;
		await f.gc.recover();
		expect(f.gc.degraded()).toBe(true);
		const health = (await (await fetch(`${f.base}/healthz`)).json()) as { folderGc?: { degraded: boolean } };
		expect(health.folderGc).toEqual({ degraded: true });
		f.cloud.after.clear();
		f.cloud.api = "healthy";
		await f.gc.recover();
		expect(f.gc.degraded()).toBe(false);
		expect(await f.nasBytes()).toEqual(bytes);
	});

	it("removes what a lane left after the finish removed the row", async () => {
		const f = await fixture();
		const lease = randomUUID();
		await f.seed(lease);
		await f.journal.write(entryKey, { profileId, sha256, bytes: bytes.length, state: "replicate" });
		crashAfter(f, "qorpera_folder_gc_unlink_finish");
		vi.spyOn(f.store, "removeQuarantined").mockRejectedValueOnce(new Error("stopped"));
		await expect(f.gc.collect(profileId, sha256, lease)).rejects.toThrow("stopped");
		expect(await f.quarantined()).toEqual([`${sha256}.${lease}`]);
		f.cloud.after.clear();
		f.cloud.api = "healthy";
		await f.gc.recover();
		expect(await f.quarantined()).toEqual([]);
		expect(await f.nasBytes()).toBeUndefined();
		expect(f.cloud.replicas.has(identity)).toBe(false);
		expect(await f.journal.read(entryKey)).toBeUndefined();
	});

	it("removes the only replica a lane left behind its marker after the row went", async () => {
		const f = await fixture();
		const lease = randomUUID();
		await f.seed(lease, { nas: false });
		crashAfter(f, "qorpera_folder_gc_unlink_finish");
		f.cloud.storage = "unavailable";
		await expect(f.gc.collect(profileId, sha256, lease)).rejects.toBeInstanceOf(ObjectDependencyError);
		expect(await f.quarantined()).toEqual([`${sha256}.${lease}.${bytes.length}.replica`]);
		f.cloud.after.clear();
		f.cloud.api = "healthy";
		f.cloud.storage = "healthy";
		await f.gc.recover();
		expect(f.cloud.replicas.has(identity)).toBe(false);
		expect(await f.quarantined()).toEqual([]);
	});

	it("restores what a lane left after the finish answered restore", async () => {
		const f = await fixture();
		const lease = randomUUID();
		await f.seed(lease);
		f.cloud.rooted.add(identity);
		crashAfter(f, "qorpera_folder_gc_unlink_finish");
		vi.spyOn(f.store, "restoreQuarantined").mockRejectedValueOnce(new Error("stopped"));
		await expect(f.gc.collect(profileId, sha256, lease)).rejects.toThrow("stopped");
		// The replicate entry went first, so the replica is copied again once the file is back.
		expect(await f.journal.read(entryKey)).toMatchObject({ state: "replicate" });
		f.cloud.after.clear();
		f.cloud.api = "healthy";
		await f.gc.recover();
		await f.replication.reconcile();
		expect(await f.nasBytes()).toEqual(bytes);
		expect(Buffer.from(f.cloud.replicas.get(identity)!)).toEqual(bytes);
		expect(await f.quarantined()).toEqual([]);
	});

	it("waits for a lane in flight on the object, and then leaves what the lane settled", async () => {
		const f = await fixture();
		const lease = randomUUID();
		await f.seed(lease);
		const finish = deferred();
		const reached = deferred();
		f.cloud.before.set("qorpera_folder_gc_unlink_finish", async () => {
			reached.resolve();
			await finish.promise;
		});
		const lane = f.gc.collect(profileId, sha256, lease);
		await reached.promise;
		const scan = f.gc.recover();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(f.cloud.calls).not.toContain("qorpera_folder_gc_quarantine_state");
		finish.resolve();
		expect(await lane).toBe("removed");
		await scan;
		expect(f.cloud.calls).not.toContain("qorpera_folder_gc_quarantine_state");
		expect(await f.quarantined()).toEqual([]);
	});

	it("removes a quarantined object of a company being deleted, whose row the deleted-company GC collects", async () => {
		const f = await fixture();
		const lease = randomUUID();
		await f.seed(lease);
		// The deleted-company lane's own entry for the object is left alone.
		const authorizationId = randomUUID();
		await f.journal.write(entryKey, { profileId, sha256, bytes: bytes.length, state: "deleted", authorizationId });
		crashAfter(f, "storage-delete");
		await expect(f.gc.collect(profileId, sha256, lease)).rejects.toBeInstanceOf(ObjectDependencyError);
		f.cloud.after.clear();
		f.cloud.api = "healthy";
		f.cloud.deleting.add(profileId);
		f.cloud.now += 600_001;
		await f.gc.recover();
		expect(await f.quarantined()).toEqual([]);
		expect(await f.nasBytes()).toBeUndefined();
		expect(f.cloud.catalog.has(identity)).toBe(true);
		expect(await f.journal.read(entryKey)).toMatchObject({ state: "deleted", authorizationId });
	});

	it("leaves names that are not entries, and removes an empty company folder", async () => {
		const f = await fixture();
		const lease = randomUUID();
		await f.seed(lease);
		f.cloud.rooted.add(identity);
		expect(await f.gc.collect(profileId, sha256, lease)).toBe("restored");
		expect(existsSync(f.quarantine)).toBe(true);
		await f.gc.recover();
		expect(existsSync(f.quarantine)).toBe(false);
		await mkdir(f.quarantine, { mode: 0o700 });
		await writeFile(join(f.quarantine, "notes.txt"), "x");
		await f.gc.recover();
		expect(await f.quarantined()).toEqual(["notes.txt"]);
		expect(f.cloud.calls.filter((call) => call === "qorpera_folder_gc_quarantine_state")).toHaveLength(0);
	});
});

describe("folder GC against uploads and other lanes", () => {
	it("holds an upload of the object behind the lane: refused while marked, stored fresh once removed", async () => {
		const f = await fixture();
		const lease = randomUUID();
		await f.seed(lease);
		const finish = deferred();
		const reached = deferred();
		f.cloud.before.set("qorpera_folder_gc_unlink_finish", async () => {
			reached.resolve();
			await finish.promise;
		});
		const lane = f.gc.collect(profileId, sha256, lease);
		await reached.promise;
		let uploaded = false;
		const upload = f.upload().then((result) => {
			uploaded = true;
			return result;
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		// The put waits for the object's lock: it never lands between the rename and the finish.
		expect(uploaded).toBe(false);
		expect(await f.nasBytes()).toBeUndefined();
		finish.resolve();
		expect(await lane).toBe("removed");
		expect(await upload).toBe("stored");
		expect(await f.nasBytes()).toEqual(bytes);
		expect(await f.quarantined()).toEqual([]);
		// The fresh upload's replica is written by the reconcile, and no later scan removes it.
		await f.replication.reconcile();
		await f.gc.recover();
		expect(Buffer.from(f.cloud.replicas.get(identity)!)).toEqual(bytes);
		// While a mark is live, the upload is refused as a conflict.
		const marked = randomUUID();
		f.cloud.gc.set(identity, { lease: marked, expires: f.cloud.now + 600_000 });
		await expect(f.upload()).rejects.toMatchObject({ status: 409 });
	});

	it("runs two lanes of one object one after the other: the second finds nothing to do", async () => {
		const f = await fixture();
		const lease = randomUUID();
		await f.seed(lease);
		const outcomes = await Promise.all([
			f.gc.collect(profileId, sha256, lease),
			f.gc.collect(profileId, sha256, lease),
		]);
		expect(outcomes).toEqual(["removed", "stale"]);
		expect(f.cloud.calls.filter((call) => call === "qorpera_folder_gc_unlink_finish")).toHaveLength(1);
		expect(await f.quarantined()).toEqual([]);
	});

	it("finishes a lane sent again under the same lease after it stopped past the rename", async () => {
		const f = await fixture();
		const lease = randomUUID();
		await f.seed(lease);
		f.cloud.storage = "unavailable";
		vi.spyOn(f.authority, "abandonFolderUnlink").mockRejectedValueOnce(new ObjectDependencyError(503));
		vi.spyOn(f.authority, "folderQuarantineState").mockRejectedValueOnce(new ObjectDependencyError(503));
		await expect(f.gc.collect(profileId, sha256, lease)).rejects.toBeInstanceOf(ObjectDependencyError);
		expect(await f.quarantined()).toEqual([`${sha256}.${lease}`]);
		f.cloud.storage = "healthy";
		expect(await f.gc.collect(profileId, sha256, lease)).toBe("removed");
		expect(await f.quarantined()).toEqual([]);
		expect(f.cloud.replicas.has(identity)).toBe(false);
	});
});
