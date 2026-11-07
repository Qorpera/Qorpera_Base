import { createHash } from "node:crypto";
import { type FileHandle, mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObjectDependencyError } from "../src/dependency.ts";
import { ObjectGatewayJournal } from "../src/journal.ts";
import { FileSystemObjectStore } from "../src/object-store.ts";
import { ObjectGatewayReplication } from "../src/replication.ts";
import { createObjectGatewayHandler } from "../src/service.ts";
import { type ObjectBackend, SupabaseObjectAuthority } from "../src/supabase-authority.ts";

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const authorizationId = "5ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const bytes = Buffer.from("cloud continuity fixture");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const objectKey = `${profileId}/${sha256}`;
type Failure = "healthy" | "unavailable" | "denied";

class CloudFixture {
	api: Failure = "healthy";
	storage: Failure = "healthy";
	auth: Failure = "healthy";
	now = Date.now();
	readonly catalog = new Map<string, { backend: ObjectBackend; bytes: number }>();
	readonly replicas = new Map<string, Uint8Array>();
	physicalWrites = 0;
	loseReplicaResponse = false;
	loseConfirmationResponse = false;
	rejectConfirmation = false;
	deletion = false;

	fetch: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		const mode = url.pathname.startsWith("/storage/")
			? this.storage
			: url.pathname.startsWith("/auth/")
				? this.auth
				: this.api;
		if (mode === "unavailable" || mode === "denied")
			return Response.json({ error: "injected" }, { status: mode === "denied" ? 403 : 503 });
		if (url.pathname.startsWith("/auth/") || url.pathname.includes("/bucket/"))
			return Response.json({ status: "ok" });
		if (url.pathname.startsWith("/storage/")) {
			if (request.method === "DELETE") {
				const body = (await request.json()) as { prefixes: string[] };
				for (const prefix of body.prefixes) this.replicas.delete(prefix);
				return Response.json([]);
			}
			const identity = url.pathname.split("/").slice(-2).join("/");
			if (request.method === "POST") {
				if (this.deletion || !this.catalog.has(identity)) return Response.json({}, { status: 403 });
				if (this.replicas.has(identity)) return Response.json({ statusCode: "409" }, { status: 409 });
				expect(request.headers.get("apikey")).toBe("synthetic-secret");
				expect(request.headers.get("authorization")).toBeNull();
				expect(JSON.parse(Buffer.from(request.headers.get("x-metadata")!, "base64").toString())).toEqual({
					qorpera_nas_replica: true,
					qorpera_nas_replica_bytes: Number(request.headers.get("content-length")),
				});
				this.replicas.set(identity, new Uint8Array(await request.arrayBuffer()));
				this.physicalWrites++;
				if (this.loseReplicaResponse) {
					this.loseReplicaResponse = false;
					throw new Error("injected lost receipt");
				}
				return Response.json({ Key: identity });
			}
			const replica = this.replicas.get(identity);
			return replica ? new Response(Uint8Array.from(replica)) : Response.json({}, { status: 404 });
		}
		const name = url.pathname.split("/").at(-1);
		const body = (await request.json()) as Record<string, unknown>;
		const identity = `${body.p_profile_id}/${body.p_sha256}`;
		if (name === "qorpera_confirm_profile_object_upload") {
			if (this.rejectConfirmation) return Response.json({}, { status: 503 });
			this.catalog.set(identity, { backend: "nas-object-gateway", bytes: body.p_bytes as number });
			if (this.loseConfirmationResponse) {
				this.loseConfirmationResponse = false;
				throw new Error("injected lost confirmation");
			}
			return Response.json(true);
		}
		if (name === "qorpera_list_profile_objects_for_migration") {
			return Response.json(
				[...this.catalog.entries()]
					.filter(([, value]) => value.backend === "supabase-storage")
					.map(([key, value]) => ({
						profile_id: key.split("/")[0],
						sha256: key.split("/")[1],
						bytes: value.bytes,
					}))
					.slice(0, body.p_limit as number),
			);
		}
		if (name === "qorpera_describe_profile_object_deletion_authorization") {
			return Response.json(
				this.catalog.has(identity)
					? { state: "authorized", authorization_id: authorizationId }
					: { state: "completed" },
			);
		}
		if (name === "qorpera_finalize_profile_object_deletion") {
			this.catalog.delete(identity);
			return Response.json(true);
		}
		const object = this.catalog.get(identity);
		if (!object) return Response.json({}, { status: 403 });
		if (
			name === "qorpera_authorize_profile_object_replication" ||
			name === "qorpera_confirm_profile_object_replica"
		) {
			if (this.deletion) return Response.json({}, { status: 503 });
			if (name === "qorpera_confirm_profile_object_replica") object.backend = "nas-object-gateway";
			return Response.json(true);
		}
		throw new Error(`Unexpected synthetic RPC ${name}`);
	};
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function gateway() {
	const root = await mkdtemp(join(tmpdir(), "qorpera-continuity-"));
	const objectsRoot = join(root, "objects");
	await mkdir(objectsRoot, { mode: 0o700 });
	const cloud = new CloudFixture();
	let server: Server;
	let baseUrl = "";
	let journal: ObjectGatewayJournal;
	let objects: FileSystemObjectStore;
	let authority: SupabaseObjectAuthority;
	let replication: ObjectGatewayReplication;
	const close = async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	};
	const start = async () => {
		journal = new ObjectGatewayJournal(join(root, "state"));
		objects = new FileSystemObjectStore(objectsRoot, 1000);
		authority = new SupabaseObjectAuthority({
			projectUrl: "https://cloud.test",
			publishableKey: "synthetic-public",
			secretKey: "synthetic-secret",
			fetch: cloud.fetch,
			requestTimeoutMs: 30,
			circuitCooldownMs: 100,
			now: () => cloud.now,
		});
		replication = new ObjectGatewayReplication(journal, objects, authority);
		server = createServer(
			createObjectGatewayHandler({
				store: objects,
				authority,
				replication,
				controlToken: "synthetic-cleanup",
			}),
		);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing fixture server address");
		baseUrl = `http://127.0.0.1:${address.port}`;
	};
	await start();
	cleanups.push(async () => {
		await close();
		await rm(root, { recursive: true, force: true });
	});
	return {
		root,
		cloud,
		get objects() {
			return objects;
		},
		get journal() {
			return journal;
		},
		get authority() {
			return authority;
		},
		get replication() {
			return replication;
		},
		async restart() {
			await close();
			await start();
		},
		async seed() {
			cloud.catalog.set(objectKey, { backend: "nas-object-gateway", bytes: bytes.length });
			await objects.put(profileId, sha256, bytes);
		},
		/** An upload already authorized by its route, confirmed in the catalog as the gateway confirms one. */
		upload(hash = sha256, body: Uint8Array = bytes) {
			return replication.uploadWithAuthority(profileId, hash, body, {
				authorize: async () => undefined,
				confirm: () => authority.confirmUpload(profileId, hash, body.byteLength),
			});
		},
		request(path: string, init?: RequestInit) {
			return fetch(`${baseUrl}${path}`, init);
		},
	};
}

describe("cloud object outage continuity", () => {
	it("backpressures new journal entries at capacity without losing or blocking existing recovery updates", async () => {
		const fixture = await gateway();
		const journal = new ObjectGatewayJournal(join(fixture.root, "bounded-state"), 1);
		const attempts = await Promise.allSettled([
			journal.write("pending/a", { identity: "a" }),
			journal.write("pending/b", { identity: "b" }),
		]);
		expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
		const [key] = await journal.list("pending");
		await journal.write(key!, { retained: true });
		expect(await journal.read(key!)).toEqual({ retained: true });
		await journal.remove(key!);
		await expect(journal.write("pending/c", { recovered: true })).resolves.toBeUndefined();
	});

	it("stores immutable uploads during Storage-only outage and reconciles after restart without duplicate writes", async () => {
		const fixture = await gateway();
		fixture.cloud.storage = "unavailable";
		expect(await fixture.upload()).toBe("stored");
		await fixture.replication.reconcile();
		expect((await fixture.replication.status()).pending).toBe(1);
		await fixture.restart();
		fixture.cloud.storage = "healthy";
		fixture.cloud.loseReplicaResponse = true;
		await fixture.replication.reconcile();
		expect(fixture.cloud.physicalWrites).toBe(1);
		await fixture.restart();
		await fixture.replication.reconcile();
		expect(fixture.cloud.physicalWrites).toBe(1);
		expect(fixture.cloud.replicas.size).toBe(1);
		expect(await fixture.replication.status()).toEqual({ pending: 0, blocked: 0, degraded: false });
	});

	it("discovers missed client mirrors from the durable Supabase catalog", async () => {
		const fixture = await gateway();
		fixture.cloud.catalog.set(objectKey, { backend: "supabase-storage", bytes: bytes.length });
		fixture.cloud.replicas.set(objectKey, Uint8Array.from(bytes));
		await fixture.replication.reconcile();
		await fixture.restart();
		await fixture.replication.reconcile();
		expect(Buffer.from(await fixture.objects.get(profileId, sha256, bytes.length))).toEqual(bytes);
		expect(fixture.cloud.catalog.get(objectKey)?.backend).toBe("nas-object-gateway");
		expect(fixture.cloud.physicalWrites).toBe(0);
	});

	it("answers an upload after two synchronous file writes: the intent and the bytes", async () => {
		const fixture = await gateway();
		const probe = await open(join(fixture.root, "sync-probe"), "w");
		const prototype = Object.getPrototypeOf(probe) as { sync(): Promise<void> };
		await probe.close();
		const sync = prototype.sync;
		let fileSyncs = 0;
		const spy = vi.spyOn(prototype, "sync").mockImplementation(async function (this: FileHandle) {
			// A directory's sync writes nothing on NFS; a file's is the disk flush on the storage server.
			if ((await this.stat()).isFile()) fileSyncs++;
			return sync.call(this);
		});
		try {
			expect(await fixture.upload()).toBe("stored");
		} finally {
			spy.mockRestore();
		}
		expect(fileSyncs).toBe(2);
		expect(fixture.cloud.catalog.has(objectKey)).toBe(true);
		expect(await fixture.journal.read(`pending/${profileId}-${sha256}`)).toMatchObject({ state: "unconfirmed" });
		expect(await fixture.replication.status()).toEqual({ pending: 1, blocked: 0, degraded: true });
		await fixture.replication.reconcile();
		expect(fixture.cloud.replicas.size).toBe(1);
		expect(await fixture.replication.status()).toEqual({ pending: 0, blocked: 0, degraded: false });
	});

	it("writes stored objects' audit lines with the reconcile's next sync, all in one", async () => {
		const fixture = await gateway();
		const second = Buffer.from("second immutable object");
		await fixture.upload();
		await fixture.upload(createHash("sha256").update(second).digest("hex"), second);
		const audit = vi.spyOn(fixture.journal, "audit");
		await fixture.replication.reconcile();
		expect(audit.mock.calls[0]).toHaveLength(2);
		const events = (await readFile(join(fixture.root, "state", "audit.jsonl"), "utf-8"))
			.trim()
			.split("\n")
			.map((line) => (JSON.parse(line) as { event: string }).event);
		expect(events.filter((event) => event === "object_stored_replication_pending")).toHaveLength(2);
		expect(events.filter((event) => event === "object_replicated")).toHaveLength(2);
	});

	it("still replicates an answered upload after a crash that lost its audit line", async () => {
		const fixture = await gateway();
		expect(await fixture.upload()).toBe("stored");
		await fixture.restart();
		await fixture.replication.reconcile();
		expect(fixture.cloud.replicas.size).toBe(1);
		expect(await fixture.replication.status()).toEqual({ pending: 0, blocked: 0, degraded: false });
		const audit = await readFile(join(fixture.root, "state", "audit.jsonl"), "utf-8");
		expect(audit).toContain("object_replicated");
		expect(audit).not.toContain("object_stored_replication_pending");
	});

	it("refuses uploads while the audit refuses its lines, and writes them once it takes them", async () => {
		const fixture = await gateway();
		const second = Buffer.from("second immutable object");
		const secondHash = createHash("sha256").update(second).digest("hex");
		await fixture.upload();
		const audit = vi
			.spyOn(fixture.journal, "audit")
			.mockRejectedValue(new Error("Gateway audit capacity requires operator attention"));
		await fixture.replication.reconcile();
		expect((await fixture.replication.status()).degraded).toBe(true);
		await expect(fixture.upload(secondHash, second)).rejects.toThrow("capacity");
		await expect(fixture.objects.get(profileId, secondHash, second.length)).rejects.toThrow("not found");
		audit.mockRestore();
		expect(await fixture.upload(secondHash, second)).toBe("stored");
		await fixture.replication.flushStoredLines();
		const lines = (await readFile(join(fixture.root, "state", "audit.jsonl"), "utf-8")).trim().split("\n");
		expect(lines.filter((line) => line.includes("object_stored_replication_pending"))).toHaveLength(2);
	});

	it("refuses every upload at once while the audit refuses, and a flush waits for the write before it", async () => {
		const fixture = await gateway();
		const second = Buffer.from("second immutable object");
		const secondHash = createHash("sha256").update(second).digest("hex");
		const third = Buffer.from("third immutable object");
		const thirdHash = createHash("sha256").update(third).digest("hex");
		await fixture.upload();
		const refused = vi
			.spyOn(fixture.journal, "audit")
			.mockRejectedValue(new Error("Gateway audit capacity requires operator attention"));
		await expect(fixture.replication.flushStoredLines()).rejects.toThrow("capacity");
		const answers = await Promise.allSettled([fixture.upload(secondHash, second), fixture.upload(thirdHash, third)]);
		expect(answers.map((answer) => answer.status)).toEqual(["rejected", "rejected"]);
		await expect(fixture.objects.get(profileId, secondHash, second.length)).rejects.toThrow("not found");
		await expect(fixture.objects.get(profileId, thirdHash, third.length)).rejects.toThrow("not found");
		refused.mockRestore();

		// The first write is still going: a second flush finds no lines, and must not answer before it.
		const write = fixture.journal.audit.bind(fixture.journal);
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const audit = vi.spyOn(fixture.journal, "audit").mockImplementationOnce(async (...events) => {
			await held;
			await write(...events);
		});
		const order: string[] = [];
		const first = fixture.replication.flushStoredLines().then(() => order.push("first"));
		const later = fixture.replication.flushStoredLines().then(() => order.push("later"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(order).toEqual([]);
		release();
		await Promise.all([first, later]);
		expect(order).toEqual(["first", "later"]);
		expect(audit).toHaveBeenCalledTimes(1);
		expect((await fixture.replication.status()).degraded).toBe(true);
		await fixture.replication.reconcile();
		expect((await fixture.replication.status()).degraded).toBe(false);
	});

	it("writes an object's stored line before any later line about it, with no crash in between", async () => {
		const fixture = await gateway();
		const events = async (): Promise<string[]> =>
			(await readFile(join(fixture.root, "state", "audit.jsonl"), "utf-8"))
				.trim()
				.split("\n")
				.map((line) => (JSON.parse(line) as { event: string }).event);
		// The upload is at its confirm, its entry there, while a reconcile flushes, lists and waits for the object's lock.
		let confirm = () => {};
		const confirming = new Promise<void>((resolve) => {
			confirm = resolve;
		});
		const list = fixture.journal.list.bind(fixture.journal);
		let listed = () => {};
		const hasListed = new Promise<void>((resolve) => {
			listed = resolve;
		});
		vi.spyOn(fixture.journal, "list").mockImplementation(async (section) => {
			const names = await list(section);
			if (names.length > 0) listed();
			return names;
		});
		const upload = fixture.replication.uploadWithAuthority(profileId, sha256, bytes, {
			authorize: async () => undefined,
			confirm: async () => {
				await confirming;
				await fixture.authority.confirmUpload(profileId, sha256, bytes.byteLength);
			},
		});
		await vi.waitFor(async () => expect(await list("pending")).toHaveLength(1));
		const pass = fixture.replication.reconcile();
		await hasListed;
		confirm();
		await upload;
		await pass;
		expect(fixture.cloud.replicas.size).toBe(1);
		expect(await events()).toEqual(["object_stored_replication_pending", "object_replicated"]);

		// The same for the deleted-company lane's line.
		const second = Buffer.from("second immutable object");
		const secondHash = createHash("sha256").update(second).digest("hex");
		await fixture.upload(secondHash, second);
		fixture.cloud.deletion = true;
		await fixture.replication.remove(profileId, secondHash, second.length, authorizationId);
		expect((await events()).slice(2)).toEqual(["object_stored_replication_pending", "object_deleted"]);
	});

	it("writes the lines waiting itself at the cap, before its own bytes", async () => {
		const fixture = await gateway();
		const replication = new ObjectGatewayReplication(fixture.journal, fixture.objects, fixture.authority, 2);
		const audit = vi.spyOn(fixture.journal, "audit");
		const put = (name: string) => {
			const body = Buffer.from(name);
			const hash = createHash("sha256").update(body).digest("hex");
			return replication.uploadWithAuthority(profileId, hash, body, {
				authorize: async () => undefined,
				confirm: () => fixture.authority.confirmUpload(profileId, hash, body.byteLength),
			});
		};
		await put("one");
		await put("two");
		expect(audit).not.toHaveBeenCalled();
		await put("three");
		expect(audit).toHaveBeenCalledTimes(1);
		expect(audit.mock.calls[0]).toHaveLength(2);
		await replication.flushStoredLines();
		expect(audit).toHaveBeenCalledTimes(2);
		expect(audit.mock.calls[1]).toHaveLength(1);
	});

	it("keeps the lines when a sync fails after the write: a retry repeats them exactly and loses none", async () => {
		const fixture = await gateway();
		await fixture.upload();
		const write = fixture.journal.audit.bind(fixture.journal);
		vi.spyOn(fixture.journal, "audit").mockImplementationOnce(async (...events) => {
			await write(...events);
			throw new Error("injected sync failure");
		});
		await expect(fixture.replication.flushStoredLines()).rejects.toThrow("injected");
		expect((await fixture.replication.status()).degraded).toBe(true);
		await fixture.replication.flushStoredLines();
		const lines = (await readFile(join(fixture.root, "state", "audit.jsonl"), "utf-8")).trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe(lines[1]);
	});

	it("does not strand a newly authorized upload of a previously cleaned immutable identity", async () => {
		const fixture = await gateway();
		await fixture.upload();
		fixture.cloud.deletion = true;
		await fixture.replication.remove(profileId, sha256, bytes.length, authorizationId);
		fixture.cloud.deletion = false;
		fixture.cloud.catalog.set(objectKey, { backend: "supabase-storage", bytes: bytes.length });
		fixture.cloud.replicas.set(objectKey, Uint8Array.from(bytes));
		await fixture.restart();
		await fixture.replication.reconcile();
		expect(Buffer.from(await fixture.objects.get(profileId, sha256, bytes.length))).toEqual(bytes);
		expect((await fixture.replication.status()).degraded).toBe(false);
	});

	it("does not let an unavailable object starve the rest of a bounded reconciliation batch", async () => {
		const fixture = await gateway();
		await fixture.upload();
		const second = Buffer.from("second immutable object");
		const secondHash = createHash("sha256").update(second).digest("hex");
		await fixture.upload(secondHash, second);
		const firstHash = [sha256, secondHash].sort()[0]!;
		const authorize = fixture.authority.authorizeReplication.bind(fixture.authority);
		vi.spyOn(fixture.authority, "authorizeReplication").mockImplementation(async (profile, hash, length) => {
			if (hash === firstHash) throw new ObjectDependencyError(503);
			await authorize(profile, hash, length);
		});
		await fixture.replication.reconcile(1);
		await fixture.replication.reconcile(1);
		expect(fixture.cloud.physicalWrites).toBe(1);
		expect((await fixture.replication.status()).pending).toBe(1);
	});

	it("retains unconfirmed bytes but never invents catalog authority during reconciliation", async () => {
		const fixture = await gateway();
		fixture.cloud.rejectConfirmation = true;
		await expect(fixture.upload()).rejects.toMatchObject({ status: 503 });
		expect(Buffer.from(await fixture.objects.get(profileId, sha256, bytes.length))).toEqual(bytes);
		await fixture.restart();
		fixture.cloud.rejectConfirmation = false;
		await fixture.replication.reconcile();
		expect(fixture.cloud.catalog.size).toBe(0);
		expect(fixture.cloud.physicalWrites).toBe(0);
		expect((await fixture.replication.status()).blocked).toBe(1);
		expect(await fixture.upload()).toBe("exists");
		await fixture.replication.reconcile();
		expect(fixture.cloud.replicas.size).toBe(1);
	});

	it("recovers a lost catalog confirmation using the same immutable identity", async () => {
		const fixture = await gateway();
		fixture.cloud.loseConfirmationResponse = true;
		await expect(fixture.upload()).rejects.toMatchObject({ status: 503 });
		await fixture.restart();
		await fixture.replication.reconcile();
		expect(fixture.cloud.catalog.size).toBe(1);
		expect(fixture.cloud.physicalWrites).toBe(1);
		expect((await fixture.replication.status()).pending).toBe(0);
	});

	it("retains deletion authority across outages and never replays a pending replica over a deletion", async () => {
		const fixture = await gateway();
		await fixture.upload();
		fixture.cloud.deletion = true;
		fixture.cloud.storage = "unavailable";
		await expect(fixture.replication.remove(profileId, sha256, bytes.length, authorizationId)).rejects.toBeInstanceOf(
			ObjectDependencyError,
		);
		await fixture.restart();
		fixture.cloud.storage = "healthy";
		await fixture.replication.reconcile();
		await fixture.replication.reconcile();
		expect(fixture.cloud.catalog.size).toBe(0);
		expect(fixture.cloud.replicas.size).toBe(0);
		expect(fixture.cloud.physicalWrites).toBe(0);
		await expect(fixture.objects.get(profileId, sha256, bytes.length)).rejects.toThrow("not found");
	});

	it("reports dependency failure separately from liveness and readiness", async () => {
		const fixture = await gateway();
		fixture.cloud.auth = "unavailable";
		fixture.cloud.storage = "unavailable";
		await fixture.authority.probeHealth();
		await fixture.objects.probe();
		const health = await fixture.request("/healthz");
		expect(health.status).toBe(503);
		expect(await health.json()).toMatchObject({
			status: "degraded",
			dependencies: {
				api: { status: "healthy" },
				auth: { status: "unavailable" },
				storage: { status: "unavailable" },
			},
		});
		expect((await fixture.request("/livez")).status).toBe(200);
		expect((await fixture.request("/readyz")).status).toBe(200);
	});

	it("does not report rejected service probes as healthy and recovers health on failback", async () => {
		const fixture = await gateway();
		await fixture.seed();
		await fixture.objects.probe();
		fixture.cloud.api = "denied";
		fixture.cloud.storage = "denied";
		await fixture.authority.probeHealth();
		expect(fixture.authority.health()).toMatchObject({
			api: { status: "unavailable" },
			storage: { status: "unavailable" },
		});
		expect((await fixture.request("/healthz")).status).toBe(503);
		expect((await fixture.request("/readyz")).status).toBe(503);
		fixture.cloud.api = "healthy";
		fixture.cloud.storage = "healthy";
		await fixture.authority.probeHealth();
		expect((await fixture.request("/healthz")).status).toBe(200);
	});
});
