import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ObjectGatewayJournal } from "../../object-gateway/src/journal.ts";
import { FileSystemObjectStore } from "../../object-gateway/src/object-store.ts";
import { ObjectGatewayReplication } from "../../object-gateway/src/replication.ts";
import { createObjectGatewayHandler } from "../../object-gateway/src/service.ts";
import { SupabaseObjectAuthority } from "../../object-gateway/src/supabase-authority.ts";
import { HttpNativeCompanyObjectTransport } from "../src/cloud-native-company-objects.ts";
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
		transport() {
			return new HttpNativeCompanyObjectTransport({
				baseUrl: origin,
				token,
				companyId,
				binding: f.binding,
				signal: new AbortController().signal,
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
