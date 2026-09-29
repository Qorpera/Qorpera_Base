import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { HttpNativeCompanyObjectTransport } from "@qorpera/runtime/cloud-native-company-objects";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObjectGatewayJournal } from "../../object-gateway/src/journal.ts";
import { FileSystemObjectStore } from "../../object-gateway/src/object-store.ts";
import { ObjectGatewayReplication } from "../../object-gateway/src/replication.ts";
import { createObjectGatewayHandler } from "../../object-gateway/src/service.ts";
import { SupabaseObjectAuthority } from "../../object-gateway/src/supabase-authority.ts";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});
const bytes = Buffer.from("synthetic company object");
const hash = createHash("sha256").update(bytes).digest("hex");

async function fixture() {
	const f = nativeToolAuthorityFixture();
	const companyId = f.authority.identity.companyId;
	const path = `${companyId}/${hash}`;
	const token = randomBytes(32).toString("base64url");
	const root = await mkdtemp(join(tmpdir(), "qorpera-native-objects-test-"));
	await mkdir(join(root, "objects"), { mode: 0o700 });
	const cloud = {
		allowed: true,
		storage: true,
		catalog: new Map<string, number>(),
		replicas: new Map<string, Uint8Array>(),
		/** How many more times an RPC answers a lock timeout (PostgREST's 500 with 55P03) before it runs. */
		lockConflicts: new Map<string, number>(),
	};
	const rpc = vi.fn<typeof fetch>(async (url, init) => {
		const request = new Request(url, init);
		expect(request.headers.get("apikey")).toBe("synthetic-service-key");
		expect(request.headers.get("authorization")).toBeNull();
		const pathname = new URL(request.url).pathname;
		if (pathname.startsWith("/storage/")) {
			if (!cloud.storage) return Response.json({}, { status: 503 });
			const object = pathname.split("/").slice(-2).join("/");
			if (request.method === "POST") {
				if (!cloud.catalog.has(object)) return Response.json({}, { status: 403 });
				cloud.replicas.set(object, new Uint8Array(await request.arrayBuffer()));
				return Response.json({});
			}
			const value = cloud.replicas.get(object);
			return value ? new Response(Uint8Array.from(value)) : Response.json({}, { status: 404 });
		}
		const method = pathname.split("/").at(-1)!;
		const args = (await request.json()) as Record<string, unknown>;
		const object = `${args.p_profile_id}/${args.p_sha256}`;
		if (method.includes("native_company_object")) {
			const conflicts = cloud.lockConflicts.get(method) ?? 0;
			if (conflicts > 0) {
				cloud.lockConflicts.set(method, conflicts - 1);
				return Response.json({ code: "55P03", message: "synthetic", details: null, hint: null }, { status: 500 });
			}
			if (
				!cloud.allowed ||
				args.p_profile_id !== companyId ||
				JSON.stringify(args.p_binding) !== JSON.stringify(f.binding)
			)
				return Response.json({ error: "SYNTHETIC_PRIVATE_DENIAL" }, { status: 403 });
			if (method === "qorpera_authorize_native_company_object_download") {
				const length = cloud.catalog.get(object);
				return length === undefined
					? Response.json({}, { status: 403 })
					: Response.json({ backend: "nas-object-gateway", bytes: length });
			}
			if (method === "qorpera_confirm_native_company_object_upload")
				cloud.catalog.set(object, args.p_bytes as number);
			return Response.json(true);
		}
		if (method === "qorpera_list_profile_objects_for_migration") return Response.json([]);
		if (["qorpera_authorize_profile_object_replication", "qorpera_confirm_profile_object_replica"].includes(method))
			return Response.json(cloud.catalog.get(object) === args.p_bytes);
		return Response.json({}, { status: 403 });
	});
	const authority = new SupabaseObjectAuthority({
		projectUrl: "https://cloud.test",
		publishableKey: "synthetic-public-key",
		secretKey: "synthetic-service-key",
		fetch: rpc,
		circuitCooldownMs: 0,
	});
	const store = new FileSystemObjectStore(join(root, "objects"));
	let replication: ObjectGatewayReplication;
	let server: Server;
	let origin: string;
	const start = async (): Promise<void> => {
		replication = new ObjectGatewayReplication(new ObjectGatewayJournal(join(root, "journal")), store, authority);
		server = createServer(
			createObjectGatewayHandler({
				store,
				authority,
				replication,
				controlToken: "synthetic-cleanup",
				verifierToken: "synthetic-verifier",
				nativeObjects: { token, authority },
			}),
		);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing test server");
		origin = `http://127.0.0.1:${address.port}`;
	};
	const close = async (): Promise<void> => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	};
	await start();
	cleanups.push(async () => {
		await close();
		await rm(root, { recursive: true, force: true });
	});
	return {
		...f,
		companyId,
		path,
		token,
		cloud,
		rpc,
		store,
		authority,
		get replication() {
			return replication;
		},
		transport(request?: typeof fetch) {
			return new HttpNativeCompanyObjectTransport({
				baseUrl: origin,
				token,
				companyId,
				binding: f.binding,
				signal: new AbortController().signal,
				...(request ? { fetch: request } : {}),
			});
		},
		request(init: RequestInit) {
			return fetch(`${origin}/v1/native-company-objects/${path}`, init);
		},
		headers(binding: unknown = f.binding, bearer = token) {
			return {
				authorization: `Bearer ${bearer}`,
				"x-qorpera-native-binding": Buffer.from(JSON.stringify(binding)).toString("base64url"),
			};
		},
		async restart() {
			await close();
			await start();
		},
	};
}

it("stages native objects durably and reconciles them after restart without a human/client token", async () => {
	const f = await fixture();
	f.cloud.storage = false;
	expect(await f.transport().put(f.path, bytes, "application/octet-stream")).toBe("stored");
	expect(await f.transport().put(f.path, bytes, "application/octet-stream")).toBe("exists");
	expect(Buffer.from(await f.transport().get(f.path))).toEqual(bytes);
	expect((await f.replication.status()).pending).toBe(1);
	await f.replication.reconcile();
	expect(f.cloud.replicas.size).toBe(0);
	await f.restart();
	f.cloud.storage = true;
	await f.replication.reconcile();
	expect(f.cloud.replicas.size).toBe(1);
	expect(await f.replication.status()).toEqual({ pending: 0, blocked: 0, degraded: false });
});

it("rejects other gateway tokens, extra principals, malformed bindings and deletion", async () => {
	const f = await fixture();
	for (const bearer of ["synthetic-verifier", "synthetic-cleanup", "member-token"]) {
		const response = await f.request({ headers: f.headers(f.binding, bearer) });
		expect(response.status).toBe(401);
	}
	expect((await f.request({ headers: f.headers({ ...f.binding, userId: f.companyId }) })).status).toBe(400);
	expect((await f.request({ headers: f.headers({ ...f.binding, runId: "bad" }) })).status).toBe(400);
	expect((await f.request({ method: "DELETE", headers: f.headers() })).status).toBe(405);
	expect(f.rpc).not.toHaveBeenCalled();
});

it("requires current cloud authority even when immutable bytes exist on NAS", async () => {
	const f = await fixture();
	await f.transport().put(f.path, bytes, "application/octet-stream");
	f.cloud.allowed = false;
	const read = vi.spyOn(f.store, "get");
	await expect(f.transport().get(f.path)).rejects.toThrow("(403)");
	expect(read).not.toHaveBeenCalled();
	const response = await f.request({ headers: f.headers() });
	expect(await response.text()).not.toContain("SYNTHETIC_PRIVATE_DENIAL");
});

it("rechecks revocation after physical storage before acknowledging or releasing bytes", async () => {
	const f = await fixture();
	const put = f.store.put.bind(f.store);
	vi.spyOn(f.store, "put").mockImplementation(async (...args) => {
		const result = await put(...args);
		f.cloud.allowed = false;
		return result;
	});
	await expect(f.transport().put(f.path, bytes, "application/octet-stream")).rejects.toThrow("(403)");
	expect(f.cloud.catalog.size).toBe(0);
	expect((await f.replication.status()).blocked).toBe(1);
	f.cloud.allowed = true;
	vi.mocked(f.store.put).mockRestore();
	await f.transport().put(f.path, bytes, "application/octet-stream");
	const get = f.store.get.bind(f.store);
	vi.spyOn(f.store, "get").mockImplementation(async (...args) => {
		const result = await get(...args);
		f.cloud.allowed = false;
		return result;
	});
	await expect(f.transport().get(f.path)).rejects.toThrow("(403)");
});

it("rejects object rebinding and company/URL selection before issuing a request", async () => {
	const f = await fixture();
	await expect(f.transport().get(`${f.binding.runId}/${hash}`)).rejects.toThrow("outside the admitted company");
	await expect(f.transport().get(`${f.companyId}/../${hash}`)).rejects.toThrow();
	await expect(f.transport().put(f.path, Buffer.from("different"), "application/octet-stream")).rejects.toThrow();
	expect(f.rpc).not.toHaveBeenCalled();
});

it.each(["headers", "body", "denial"])("bounds stalled %s and never reissues an uncertain upload", async (kind) => {
	const f = nativeToolAuthorityFixture();
	const request = vi.fn<typeof fetch>(async (_input, init) => {
		expect(init?.redirect).toBe("error");
		if (kind === "headers") return new Promise<Response>(() => {});
		return new Response(new ReadableStream({ cancel: () => new Promise<void>(() => {}) }), {
			status: kind === "denial" ? 403 : 201,
		});
	});
	const transport = new HttpNativeCompanyObjectTransport({
		baseUrl: "https://objects.test",
		token: "n".repeat(43),
		companyId: f.authority.identity.companyId,
		binding: f.binding,
		signal: new AbortController().signal,
		fetch: request,
		timeoutMs: 20,
	});
	await expect(
		transport.put(`${f.authority.identity.companyId}/${hash}`, bytes, "application/octet-stream"),
	).rejects.toThrow(kind === "denial" ? "(403)" : "Cloud tool authority unavailable");
	expect(request).toHaveBeenCalledOnce();
});

describe("lock conflicts on the native object route", () => {
	const confirm = "qorpera_confirm_native_company_object_upload";
	const authorizeUpload = "qorpera_authorize_native_company_object_upload";
	const authorizeDownload = "qorpera_authorize_native_company_object_download";
	const calls = (f: Awaited<ReturnType<typeof fixture>>, method: string) =>
		f.rpc.mock.calls.filter(([url]) => String(url).endsWith(`/${method}`)).length;

	it("sends a PUT again after a lock conflict on its confirmation and leaves the journal clean", async () => {
		const f = await fixture();
		f.cloud.lockConflicts.set(confirm, 1);
		const request = vi.fn<typeof fetch>((input, init) => fetch(input, init));
		// The first attempt stored the bytes before its confirmation rolled back: the retry finds them.
		expect(await f.transport(request).put(f.path, bytes, "application/octet-stream")).toBe("exists");
		expect(request).toHaveBeenCalledTimes(2);
		expect(calls(f, confirm)).toBe(2);
		expect(f.cloud.catalog.get(f.path)).toBe(bytes.length);
		// Nothing is left unconfirmed or blocked: the object waits for replication like any other.
		expect(await f.replication.status()).toEqual({ pending: 1, blocked: 0, degraded: true });
		await f.replication.reconcile();
		expect(await f.replication.status()).toEqual({ pending: 0, blocked: 0, degraded: false });
		expect(f.cloud.replicas.size).toBe(1);
	});

	it("clears a block the reconciler set between the failed attempt and its retry", async () => {
		const f = await fixture();
		f.cloud.lockConflicts.set(confirm, 1);
		const between: unknown[] = [];
		const request = vi.fn<typeof fetch>(async (input, init) => {
			const response = await fetch(input, init);
			if (response.status === 409) {
				// The reconciler's pass lands in the pause: the uncatalogued bytes are blocked.
				await f.replication.reconcile();
				between.push(await f.replication.status());
			}
			return response;
		});
		expect(await f.transport(request).put(f.path, bytes, "application/octet-stream")).toBe("exists");
		expect(between).toEqual([{ pending: 0, blocked: 1, degraded: true }]);
		expect(await f.replication.status()).toMatchObject({ pending: 1, blocked: 0 });
		await f.replication.reconcile();
		expect(await f.replication.status()).toEqual({ pending: 0, blocked: 0, degraded: false });
		expect(f.cloud.replicas.size).toBe(1);
	});

	it("sends a PUT again after a lock conflict on its authority check", async () => {
		const f = await fixture();
		f.cloud.lockConflicts.set(authorizeUpload, 2);
		expect(await f.transport().put(f.path, bytes, "application/octet-stream")).toBe("stored");
		expect(await f.replication.status()).toMatchObject({ pending: 1, blocked: 0 });
	});

	it("sends a GET again after a lock conflict on either of its authority checks", async () => {
		const f = await fixture();
		await f.transport().put(f.path, bytes, "application/octet-stream");
		// The check before the NAS read.
		f.cloud.lockConflicts.set(authorizeDownload, 1);
		let request = vi.fn<typeof fetch>((input, init) => fetch(input, init));
		expect(Buffer.from(await f.transport(request).get(f.path))).toEqual(bytes);
		expect(request).toHaveBeenCalledTimes(2);
		// The recheck after it.
		const get = f.store.get.bind(f.store);
		vi.spyOn(f.store, "get").mockImplementationOnce(async (...args) => {
			const result = await get(...args);
			f.cloud.lockConflicts.set(authorizeDownload, 1);
			return result;
		});
		request = vi.fn<typeof fetch>((input, init) => fetch(input, init));
		expect(Buffer.from(await f.transport(request).get(f.path))).toEqual(bytes);
		expect(request).toHaveBeenCalledTimes(2);
		// Each retry runs both checks again: 1 + 2, then 2 + 2.
		expect(calls(f, authorizeDownload)).toBe(7);
	});

	it("keeps three lock conflicts unconfirmed, as before, within the call's budget", async () => {
		const f = await fixture();
		f.cloud.lockConflicts.set(confirm, 3);
		const request = vi.fn<typeof fetch>((input, init) => fetch(input, init));
		const started = performance.now();
		await expect(f.transport(request).put(f.path, bytes, "application/octet-stream")).rejects.toThrow("(409)");
		expect(performance.now() - started).toBeLessThan(5_000);
		expect(request).toHaveBeenCalledTimes(3);
		expect(f.cloud.catalog.size).toBe(0);
		// As today after a failed confirmation: the uncatalogued bytes stay unconfirmed.
		expect((await f.replication.status()).blocked).toBe(1);
	});
});

describe("which refusals the native object transport sends again", () => {
	const conflict = { error: "Object authority rejected the operation", code: "lock_conflict" };
	function transport(answer: (attempt: number) => Promise<Response> | Response, timeoutMs?: number) {
		const f = nativeToolAuthorityFixture();
		const starts: number[] = [];
		const started = performance.now();
		const request = vi.fn<typeof fetch>(async () => {
			starts.push(performance.now() - started);
			return answer(starts.length);
		});
		const objects = new HttpNativeCompanyObjectTransport({
			baseUrl: "https://objects.test",
			token: "n".repeat(43),
			companyId: f.authority.identity.companyId,
			binding: f.binding,
			signal: new AbortController().signal,
			fetch: request,
			...(timeoutMs ? { timeoutMs } : {}),
		});
		const path = `${f.authority.identity.companyId}/${hash}`;
		return {
			request,
			starts,
			started,
			put: () => objects.put(path, bytes, "application/octet-stream"),
			get: () => objects.get(path),
		};
	}
	const stored = () =>
		Response.json({ status: "stored", sha256: hash, bytes: bytes.length, replication: "pending" }, { status: 201 });

	it.each([
		["a denial", 403, { error: "Object authority rejected the operation" }],
		["a denial that claims a lock conflict", 403, conflict],
		["a bad token", 401, conflict],
		["a stop", 423, conflict],
		["a stale precondition", 412, conflict],
		["another 409 (a GC fence, a deletion in progress)", 409, { error: "Object authority rejected the operation" }],
		["an unavailable dependency", 503, { error: "Object dependency is unavailable" }],
		["a statement timeout", 503, { error: "Object dependency is unavailable", code: "statement_timeout" }],
		["a lock conflict code that is not a string match", 409, { error: "x", code: ["lock_conflict"] }],
	] as const)("does not send %s again", async (_label, status, body) => {
		const t = transport(() => Response.json(body, { status }));
		await expect(t.put()).rejects.toThrow(`(${status})`);
		await expect(t.get()).rejects.toThrow(`(${status})`);
		expect(t.request).toHaveBeenCalledTimes(2);
	});

	it("never reads a denial's body", async () => {
		const pulls = vi.fn();
		const t = transport(
			() =>
				new Response(new ReadableStream({ pull: pulls, cancel: () => undefined }, { highWaterMark: 0 }), {
					status: 403,
				}),
		);
		await expect(t.put()).rejects.toThrow("(403)");
		expect(pulls).not.toHaveBeenCalled();
	});

	it("does not send an oversized or stalled conflict body again, and a stall waits at most 250 ms", async () => {
		const huge = transport(
			() => new Response(JSON.stringify({ ...conflict, pad: "x".repeat(2048) }), { status: 409 }),
		);
		await expect(huge.put()).rejects.toThrow("(409)");
		expect(huge.request).toHaveBeenCalledOnce();
		const stalled = transport(
			() =>
				new Response(
					new ReadableStream({
						start: (controller) => controller.enqueue(Buffer.from('{"code":')),
						cancel: () => {},
					}),
					{ status: 409 },
				),
		);
		const started = performance.now();
		await expect(stalled.put()).rejects.toThrow("(409)");
		expect(performance.now() - started).toBeLessThan(1_000);
		expect(stalled.request).toHaveBeenCalledOnce();
	});

	it.each([
		[409, 0],
		[503, 1],
	])("sends a %s lock conflict again after a jittered pause (random %s)", async (status, random) => {
		vi.spyOn(Math, "random").mockReturnValue(random);
		const t = transport((attempt) => (attempt < 3 ? Response.json(conflict, { status }) : stored()));
		expect(await t.put()).toBe("stored");
		expect(t.request).toHaveBeenCalledTimes(3);
		// 100–300 ms, then 300–700 ms.
		const [first, second] = [t.starts[1]! - t.starts[0]!, t.starts[2]! - t.starts[1]!];
		expect(first).toBeGreaterThanOrEqual(random ? 295 : 95);
		expect(first).toBeLessThan(random ? 450 : 250);
		expect(second).toBeGreaterThanOrEqual(random ? 695 : 295);
		expect(second).toBeLessThan(random ? 850 : 450);
		vi.mocked(Math.random).mockRestore();
	});

	it("never starts a retry that its budget cannot hold, and never outlasts the budget", async () => {
		// Each conflict answers after 400 ms, as a lock wait would; the budget here is 1.5 s.
		const t = transport(
			() =>
				new Promise<Response>((resolve) =>
					setTimeout(() => resolve(Response.json(conflict, { status: 409 })), 400),
				),
			1_500,
		);
		await expect(t.put()).rejects.toThrow("(409)");
		const elapsed = performance.now() - t.started;
		// The second attempt's answer came after ~0.9 s; a third would start after its 300 ms pause with less than
		// 500 ms of the budget left, so it is not sent.
		expect(t.request).toHaveBeenCalledTimes(2);
		expect(elapsed).toBeLessThan(1_500);
		for (const start of t.starts) expect(start).toBeLessThanOrEqual(1_500 - 500);
	});

	it("counts the 5 s tool budget even when its own deadline is longer", async () => {
		vi.spyOn(Math, "random").mockReturnValue(1);
		// Conflicts answer after 2 s, a writer's lock wait (#550); the transport's own deadline is 8 s.
		const t = transport(
			() =>
				new Promise<Response>((resolve) =>
					setTimeout(() => resolve(Response.json(conflict, { status: 409 })), 2_000),
				),
		);
		await expect(t.put()).rejects.toThrow("(409)");
		vi.mocked(Math.random).mockRestore();
		const elapsed = performance.now() - t.started;
		// Attempt 2 starts at ~2.3 s and answers at ~4.3 s; a third would start past 4.5 s.
		expect(t.request).toHaveBeenCalledTimes(2);
		expect(elapsed).toBeLessThan(5_000);
	}, 10_000);

	it("ends with the caller's deadline during a pause", async () => {
		const t = transport(() => Response.json(conflict, { status: 409 }), 150);
		const started = performance.now();
		await expect(t.put()).rejects.toThrow();
		expect(performance.now() - started).toBeLessThan(400);
		expect(t.request).toHaveBeenCalledOnce();
	});
});
