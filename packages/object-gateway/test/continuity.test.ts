import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObjectDependencyError } from "../src/dependency.ts";
import { ObjectGatewayJournal } from "../src/journal.ts";
import { FileSystemObjectStore } from "../src/object-store.ts";
import { ObjectReadLeases } from "../src/read-lease.ts";
import { ObjectGatewayReplication } from "../src/replication.ts";
import { createObjectGatewayHandler } from "../src/service.ts";
import { type AuthorizedObject, SupabaseObjectAuthority } from "../src/supabase-authority.ts";

const profileId = "9ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const otherProfile = "8ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const subjectId = "7ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const sessionId = "6ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const authorizationId = "5ec79fc8-a1a7-4eb6-a764-4bc704d4103f";
const token = "synthetic-member-bearer";
const bytes = Buffer.from("cloud continuity fixture");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const objectKey = `${profileId}/${sha256}`;
type Failure = "healthy" | "unavailable" | "denied" | "denied-stalled-body" | "stalled-headers" | "stalled-body";

class CloudFixture {
	api: Failure = "healthy";
	storage: Failure = "healthy";
	auth: Failure = "healthy";
	now = Date.now();
	readonly catalog = new Map<string, AuthorizedObject>();
	readonly replicas = new Map<string, Uint8Array>();
	readonly calls: string[] = [];
	physicalWrites = 0;
	loseReplicaResponse = false;
	loseConfirmationResponse = false;
	rejectConfirmation = false;
	deletion = false;

	fetch: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		this.calls.push(`${request.method} ${url.pathname}`);
		const mode = url.pathname.startsWith("/storage/")
			? this.storage
			: url.pathname.startsWith("/auth/")
				? this.auth
				: this.api;
		if (mode === "stalled-headers") return new Promise<Response>(() => {});
		if (mode === "stalled-body") return new Response(new ReadableStream());
		if (mode === "denied-stalled-body")
			return new Response(new ReadableStream({ cancel: () => new Promise<void>(() => {}) }), { status: 403 });
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
		const bearer = request.headers.get("authorization");
		if (bearer && (bearer !== `Bearer ${token}` || body.p_profile_id !== profileId))
			return Response.json({}, { status: 403 });
		if (name === "qorpera_authorize_profile_object_upload") return Response.json({ allowed: true });
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
		if (name === "qorpera_issue_profile_object_read_lease") {
			return Response.json({
				...object,
				read_lease: {
					leaseId: randomUUID(),
					profileId,
					sha256: body.p_sha256,
					subjectId,
					sessionId,
					issuedAt: new Date(this.now).toISOString(),
					expiresAt: new Date(this.now + 60_000).toISOString(),
				},
			});
		}
		if (name === "qorpera_authorize_profile_object_download") return Response.json(object);
		throw new Error(`Unexpected synthetic RPC ${name}`);
	};
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function gateway(delegation = true) {
	const root = await mkdtemp(join(tmpdir(), "qorpera-continuity-"));
	const objectsRoot = join(root, "objects");
	await mkdir(objectsRoot, { mode: 0o700 });
	const cloud = new CloudFixture();
	let server: Server;
	let baseUrl = "";
	let journal: ObjectGatewayJournal;
	let objects: FileSystemObjectStore;
	let authority: SupabaseObjectAuthority;
	let leases: ObjectReadLeases;
	let replication: ObjectGatewayReplication;
	const close = async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	};
	const start = async () => {
		journal = new ObjectGatewayJournal(join(root, "state"));
		objects = new FileSystemObjectStore(objectsRoot, 1000);
		leases = new ObjectReadLeases(journal, () => cloud.now);
		authority = new SupabaseObjectAuthority({
			projectUrl: "https://cloud.test",
			publishableKey: "synthetic-public",
			secretKey: "synthetic-secret",
			fetch: cloud.fetch,
			requestTimeoutMs: 30,
			circuitCooldownMs: 100,
			now: () => cloud.now,
			readLeaseSeconds: delegation ? 60 : 0,
		});
		replication = new ObjectGatewayReplication(journal, objects, authority);
		server = createServer(
			createObjectGatewayHandler({
				store: objects,
				authority,
				replication,
				controlToken: "synthetic-cleanup",
				verifierToken: "synthetic-verifier",
				...(delegation ? { readLeases: leases, revocationToken: "synthetic-revocation" } : {}),
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
		get leases() {
			return leases;
		},
		async restart() {
			await close();
			await start();
		},
		async seed(backend: AuthorizedObject["backend"] = "nas-object-gateway") {
			cloud.catalog.set(objectKey, { backend, bytes: bytes.length });
			await objects.put(profileId, sha256, bytes);
		},
		get(profile = profileId, hash = sha256, bearer = token) {
			return fetch(`${baseUrl}/v1/profile-objects/${profile}/${hash}`, {
				headers: { authorization: `Bearer ${bearer}` },
			});
		},
		put() {
			return fetch(`${baseUrl}/v1/profile-objects/${profileId}/${sha256}`, {
				method: "PUT",
				headers: { authorization: `Bearer ${token}` },
				body: bytes,
			});
		},
		request(path: string, init?: RequestInit) {
			return fetch(`${baseUrl}${path}`, init);
		},
	};
}

describe("cloud object outage continuity", () => {
	it("backpressures new journal entries at capacity without losing or blocking existing recovery updates", async () => {
		const fixture = await gateway(false);
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

	it("serves an available NAS replica during Storage-only failure regardless of the catalog backend", async () => {
		const fixture = await gateway();
		await fixture.seed("supabase-storage");
		fixture.cloud.storage = "unavailable";
		const response = await fixture.get();
		expect(response.status).toBe(200);
		expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
		expect(fixture.cloud.calls.some((call) => call.includes("/storage/"))).toBe(false);
	});

	it("continues only established exact reads during API outage, survives restart, and expires without extension", async () => {
		const fixture = await gateway();
		await fixture.seed();
		expect((await fixture.get()).status).toBe(200);
		fixture.cloud.api = "unavailable";
		const response = await fixture.get();
		expect(response.status).toBe(200);
		expect(response.headers.get("x-qorpera-access-mode")).toBe("bounded-read-lease");
		const calls = fixture.cloud.calls.length;
		expect((await fixture.get()).status).toBe(200);
		expect(fixture.cloud.calls).toHaveLength(calls);
		await fixture.restart();
		expect((await fixture.get()).status).toBe(200);
		fixture.cloud.now += 60_001;
		expect((await fixture.get()).status).toBe(403);
		const audit = await readFile(join(fixture.root, "state", "audit.jsonl"), "utf-8");
		expect(audit).toContain("read_lease_used");
		expect(audit).not.toContain(token);
		expect(audit).not.toContain("synthetic-secret");
	});

	it("does not enable read grace by default or delegate the verifier credential", async () => {
		const fixture = await gateway(false);
		await fixture.seed();
		expect((await fixture.get()).status).toBe(200);
		fixture.cloud.api = "unavailable";
		expect((await fixture.get()).status).toBe(503);
		const delegated = await gateway();
		await delegated.seed();
		expect((await delegated.get(profileId, sha256, "synthetic-verifier")).status).toBe(200);
		delegated.cloud.api = "unavailable";
		expect((await delegated.get(profileId, sha256, "synthetic-verifier")).status).toBe(503);
	});

	it("rejects cross-tenant, cross-object and different-session bearer reads before NAS access", async () => {
		const fixture = await gateway();
		await fixture.seed();
		await fixture.get();
		fixture.cloud.api = "unavailable";
		const nas = vi.spyOn(fixture.objects, "get");
		for (const [profile, hash, bearer] of [
			[otherProfile, sha256, token],
			[profileId, "a".repeat(64), token],
			[profileId, sha256, "other-session"],
		]) {
			expect((await fixture.get(profile, hash, bearer)).status).toBe(503);
		}
		expect(nas).not.toHaveBeenCalled();
	});

	it("persists independent revocations and never clears them merely because the API recovers", async () => {
		const fixture = await gateway();
		await fixture.seed();
		await fixture.get();
		fixture.cloud.api = "unavailable";
		const revoked = await fixture.request("/v1/read-leases/revoke", {
			method: "POST",
			headers: { authorization: "Bearer synthetic-revocation" },
			body: JSON.stringify({ profileId, subjectId }),
		});
		expect(revoked.status).toBe(200);
		expect((await fixture.get()).status).toBe(403);
		await fixture.restart();
		expect((await fixture.get()).status).toBe(403);
		fixture.cloud.api = "healthy";
		fixture.cloud.now += 101;
		expect((await fixture.get()).status).toBe(403);
		const denied = await fixture.request("/v1/read-leases/revoke", {
			method: "POST",
			headers: { authorization: "Bearer synthetic-cleanup" },
			body: JSON.stringify({ profileId }),
		});
		expect(denied.status).toBe(401);
	});

	it("does not fall back after an observed permission denial", async () => {
		const fixture = await gateway();
		await fixture.seed();
		await fixture.get();
		fixture.cloud.api = "denied";
		expect((await fixture.get()).status).toBe(403);
		fixture.cloud.api = "unavailable";
		expect((await fixture.get()).status).toBe(403);
	});

	it.each([false, true])("rechecks live permission after NAS I/O with delegation=%s", async (delegation) => {
		const fixture = await gateway(delegation);
		await fixture.seed();
		const read = fixture.objects.get.bind(fixture.objects);
		vi.spyOn(fixture.objects, "get").mockImplementationOnce(async (...args) => {
			const result = await read(...args);
			fixture.cloud.api = "denied";
			return result;
		});
		const response = await fixture.get();
		expect(response.status).toBe(403);
		expect(await response.text()).not.toContain(bytes.toString());
		fixture.cloud.api = "unavailable";
		expect((await fixture.get()).status).toBe(delegation ? 403 : 503);
	});

	it("rechecks independent revocation after live NAS I/O even when the API still allows access", async () => {
		const fixture = await gateway();
		await fixture.seed();
		const read = fixture.objects.get.bind(fixture.objects);
		vi.spyOn(fixture.objects, "get").mockImplementationOnce(async (...args) => {
			const result = await read(...args);
			await fixture.leases.revoke(profileId, subjectId);
			return result;
		});
		const response = await fixture.get();
		expect(response.status).toBe(403);
		expect(await response.text()).not.toContain(bytes.toString());
	});

	it.each(["denied", "unavailable"] as const)(
		"rechecks verifier permission after I/O when authority becomes %s",
		async (failure) => {
			const fixture = await gateway();
			await fixture.seed();
			const read = fixture.objects.get.bind(fixture.objects);
			vi.spyOn(fixture.objects, "get").mockImplementationOnce(async (...args) => {
				const result = await read(...args);
				fixture.cloud.api = failure;
				return result;
			});
			const response = await fixture.get(profileId, sha256, "synthetic-verifier");
			expect(response.status).toBe(failure === "denied" ? 403 : 503);
			expect(await response.text()).not.toContain(bytes.toString());
		},
	);

	it("does not relabel a live read as delegated when authority is lost during I/O", async () => {
		const fixture = await gateway();
		await fixture.seed();
		const read = fixture.objects.get.bind(fixture.objects);
		vi.spyOn(fixture.objects, "get").mockImplementationOnce(async (...args) => {
			const result = await read(...args);
			fixture.cloud.api = "unavailable";
			return result;
		});
		const response = await fixture.get();
		expect(response.status).toBe(503);
		expect(await response.text()).not.toContain(bytes.toString());
		const retried = await fixture.get();
		expect(retried.status).toBe(200);
		expect(retried.headers.get("x-qorpera-access-mode")).toBe("bounded-read-lease");
	});

	it("does not turn a known denial into grace when the error body and cancellation stall", async () => {
		const fixture = await gateway();
		await fixture.seed();
		await fixture.get();
		fixture.cloud.api = "denied-stalled-body";
		expect((await fixture.get()).status).toBe(403);
		await fixture.restart();
		fixture.cloud.api = "unavailable";
		expect((await fixture.get()).status).toBe(403);
	});

	it("rejects overlong leases, expires after slow reads, and fails closed on corrupt private state", async () => {
		const fixture = await gateway();
		await fixture.seed();
		const grant = await fixture.authority.authorizeDownload(token, profileId, sha256);
		await expect(
			fixture.leases.remember(token, profileId, sha256, {
				...grant,
				readLease: { ...grant.readLease!, expiresAt: new Date(fixture.cloud.now + 60_001).toISOString() },
			}),
		).rejects.toThrow("invalid");
		await fixture.get();
		fixture.cloud.api = "unavailable";
		const read = fixture.objects.get.bind(fixture.objects);
		vi.spyOn(fixture.objects, "get").mockImplementation(async (...args) => {
			const result = await read(...args);
			fixture.cloud.now += 60_001;
			return result;
		});
		expect((await fixture.get()).status).toBe(403);
		const [key] = await fixture.journal.list("leases");
		await fixture.journal.write(key!, { lease: "corrupt" });
		expect((await fixture.get()).status).toBe(503);
	});

	it.each(["stalled-headers", "stalled-body"] as const)(
		"bounds %s without losing the valid delegated read",
		async (failure) => {
			const fixture = await gateway();
			await fixture.seed();
			await fixture.get();
			fixture.cloud.api = failure;
			const started = Date.now();
			const response = await fixture.get();
			expect(response.status).toBe(200);
			expect(Date.now() - started).toBeLessThan(1000);
			expect(fixture.authority.health().api.status).toBe("unavailable");
		},
	);

	it("fails closed on clock rollback and unavailable audit storage", async () => {
		const fixture = await gateway();
		await fixture.seed();
		await fixture.get();
		fixture.cloud.api = "unavailable";
		fixture.cloud.now--;
		expect((await fixture.get()).status).toBe(503);
		fixture.cloud.now += 2;
		vi.spyOn(fixture.journal, "audit").mockRejectedValue(new Error("audit disk unavailable"));
		expect((await fixture.get()).status).toBe(503);
	});

	it("stores immutable uploads during Storage-only outage and reconciles after restart without duplicate writes", async () => {
		const fixture = await gateway();
		fixture.cloud.storage = "unavailable";
		expect((await fixture.put()).status).toBe(201);
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
		await fixture.put();
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
		await fixture.put();
		const second = Buffer.from("second immutable object");
		const secondHash = createHash("sha256").update(second).digest("hex");
		await fixture.replication.upload(token, profileId, secondHash, second);
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
		expect((await fixture.put()).status).toBe(503);
		expect(Buffer.from(await fixture.objects.get(profileId, sha256, bytes.length))).toEqual(bytes);
		await fixture.restart();
		fixture.cloud.rejectConfirmation = false;
		await fixture.replication.reconcile();
		expect(fixture.cloud.catalog.size).toBe(0);
		expect(fixture.cloud.physicalWrites).toBe(0);
		expect((await fixture.replication.status()).blocked).toBe(1);
		expect((await fixture.put()).status).toBe(200);
		await fixture.replication.reconcile();
		expect(fixture.cloud.replicas.size).toBe(1);
	});

	it("recovers a lost catalog confirmation using the same immutable identity", async () => {
		const fixture = await gateway();
		fixture.cloud.loseConfirmationResponse = true;
		expect((await fixture.put()).status).toBe(503);
		await fixture.restart();
		await fixture.replication.reconcile();
		expect(fixture.cloud.catalog.size).toBe(1);
		expect(fixture.cloud.physicalWrites).toBe(1);
		expect((await fixture.replication.status()).pending).toBe(0);
	});

	it("retains deletion authority across outages and never replays a pending replica over a deletion", async () => {
		const fixture = await gateway();
		await fixture.put();
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

	it("reports dependency failure separately from liveness and uses immutable Storage replicas if NAS is unavailable", async () => {
		const fixture = await gateway();
		await fixture.seed();
		fixture.cloud.replicas.set(objectKey, Uint8Array.from(bytes));
		vi.spyOn(fixture.objects, "get").mockRejectedValue(new ObjectDependencyError(503));
		expect((await fixture.get()).status).toBe(200);
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
		const fixture = await gateway(false);
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
