import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
