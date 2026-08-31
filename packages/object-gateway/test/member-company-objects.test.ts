import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObjectDependencyError } from "../src/dependency.ts";
import { MEMBER_OBSERVATIONS_PATH, MemberCompanyObservations } from "../src/member-observability.ts";
import { FileSystemObjectStore } from "../src/object-store.ts";
import { createObjectGatewayHandler } from "../src/service.ts";
import { SupabaseObjectAuthority } from "../src/supabase-authority.ts";

const companyId = "30000000-0000-4000-8000-000000000010";
const environmentId = "30000000-0000-4000-8000-000000000020";
const version = "30000000-0000-4000-8000-000000000030";
const actorUserId = "30000000-0000-4000-8000-000000000001";
const resourceId = "30000000-0000-4000-8000-000000000041";
const resourceVersion = "30000000-0000-4000-8000-000000000042";
const path = "documents/company.md";
const bytes = Buffer.from("Only this authorized human may receive these bytes.");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const memberToken = "synthetic-member-jwt";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "qorpera-member-path-read-"));
	const store = new FileSystemObjectStore(root);
	await store.put(companyId, sha256, bytes);
	const state = {
		status: 200,
		afterStorage: () => {},
		override: {} as Record<string, unknown>,
		storageBytes: bytes,
	};
	const calls: Request[] = [];
	const observations = new MemberCompanyObservations();
	const authority = new SupabaseObjectAuthority({
		projectUrl: "https://cloud.test",
		publishableKey: "sb_publishable_fixture",
		secretKey: "sb_secret_fixture",
		requestTimeoutMs: 100,
		fetch: async (input, init) => {
			const request = new Request(input, init);
			calls.push(request.clone());
			expect(request.redirect).toBe("error");
			const url = new URL(request.url);
			if (url.pathname.startsWith("/storage/")) {
				expect(request.headers.get("apikey")).toBe("sb_secret_fixture");
				expect(request.headers.get("authorization")).toBeNull();
				state.afterStorage();
				return new Response(Uint8Array.from(state.storageBytes));
			}
			if (url.pathname !== "/rest/v1/rpc/qorpera_authorize_member_company_path_object")
				return Response.json({}, { status: 403 });
			expect(request.headers.get("apikey")).toBe("sb_publishable_fixture");
			if (request.headers.get("authorization") !== `Bearer ${memberToken}`)
				return Response.json({}, { status: 403 });
			if (state.status !== 200) return Response.json({}, { status: state.status });
			const body: unknown = await request.json();
			if (
				JSON.stringify(body) !==
				JSON.stringify({
					p_environment_id: environmentId,
					p_path: path,
					p_version: version,
					p_sha256: sha256,
				})
			)
				return Response.json({}, { status: 403 });
			return Response.json({
				schema: "qorpera.member-company-object/v2",
				companyId,
				actorUserId,
				resourceId,
				resourceVersion,
				environmentId,
				path,
				version,
				sha256,
				bytes: bytes.length,
				backend: "nas-object-gateway",
				...state.override,
			});
		},
	});
	const server = createServer(
		createObjectGatewayHandler({
			store,
			authority,
			memberObjects: authority,
			memberObservations: observations,
			controlToken: "synthetic-control",
			verifierToken: "synthetic-verifier",
		}),
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture server");
	const origin = `http://127.0.0.1:${address.port}`;
	const route = `/v1/member-company-objects/${environmentId}/${version}/${sha256}`;
	cleanups.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	});
	return {
		store,
		observations,
		origin,
		state,
		calls,
		authority,
		route,
		get(options: { route?: string; method?: string; token?: string; encodedPath?: string } = {}) {
			return fetch(`${origin}${options.route ?? route}`, {
				method: options.method ?? "GET",
				headers: {
					authorization: `Bearer ${options.token ?? memberToken}`,
					"x-qorpera-company-path": options.encodedPath ?? Buffer.from(path).toString("base64url"),
				},
			});
		},
	};
}

describe("human Company File object reads", () => {
	it("uses current path authority before and after NAS I/O without model or native credentials", async () => {
		const service = await fixture();
		const response = await service.get();
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("x-qorpera-access-mode")).toBe("live-path-authority");
		expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
		expect(service.calls).toHaveLength(2);
	});

	it("can use immutable Storage bytes without forwarding the member JWT to Storage", async () => {
		const service = await fixture();
		vi.spyOn(service.store, "get").mockRejectedValue(new ObjectDependencyError(503));
		const response = await service.get();
		expect(response.status).toBe(200);
		expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
		expect(service.calls.map((call) => new URL(call.url).pathname)).toEqual([
			"/rest/v1/rpc/qorpera_authorize_member_company_path_object",
			`/storage/v1/object/authenticated/qorpera-profile-objects/${companyId}/${sha256}`,
			"/rest/v1/rpc/qorpera_authorize_member_company_path_object",
		]);
	});

	it.each(["nas", "storage"] as const)("does not release %s bytes after permission is revoked", async (backend) => {
		const service = await fixture();
		if (backend === "nas") {
			vi.spyOn(service.store, "get").mockImplementation(async () => {
				service.state.status = 403;
				return bytes;
			});
		} else {
			vi.spyOn(service.store, "get").mockRejectedValue(new ObjectDependencyError(503));
			service.state.afterStorage = () => {
				service.state.status = 403;
			};
		}
		const response = await service.get();
		expect(response.status).toBe(403);
		expect(await response.text()).not.toContain(bytes.toString());
	});

	it("does not fall back to raw object or offline authority when the path check is unavailable", async () => {
		const service = await fixture();
		service.state.status = 503;
		const read = vi.spyOn(service.store, "get");
		expect((await service.get()).status).toBe(503);
		expect(read).not.toHaveBeenCalled();
		expect(service.calls).toHaveLength(1);
	});

	it("returns a stale-version precondition without reading, retrying or falling back", async () => {
		const service = await fixture();
		service.state.status = 412;
		const read = vi.spyOn(service.store, "get");
		const response = await service.get();
		expect(response.status).toBe(412);
		expect(await response.text()).not.toContain(bytes.toString());
		expect(read).not.toHaveBeenCalled();
		expect(service.calls).toHaveLength(1);
	});

	it("does not release bytes when their path version changes during storage I/O", async () => {
		const service = await fixture();
		vi.spyOn(service.store, "get").mockImplementation(async () => {
			service.state.status = 412;
			return bytes;
		});
		const response = await service.get();
		expect(response.status).toBe(412);
		expect(await response.text()).not.toContain(bytes.toString());
		expect(service.calls).toHaveLength(2);
	});

	it.each(["synthetic-control", "synthetic-verifier", "synthetic-native", "other-member"])(
		"does not accept %s as human path authority",
		async (token) => {
			const service = await fixture();
			const read = vi.spyOn(service.store, "get");
			expect((await service.get({ token })).status).toBe(403);
			expect(read).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ route: `/v1/member-company-objects/${companyId}/${version}/${sha256}` },
		{ route: `/v1/member-company-objects/${environmentId}/${companyId}/${sha256}` },
		{ route: `/v1/member-company-objects/${environmentId}/${version}/${"b".repeat(64)}` },
		{ encodedPath: Buffer.from("members/other/private.md").toString("base64url") },
	])("does not turn a known hash into another path or principal's authority: %j", async (options) => {
		const service = await fixture();
		const read = vi.spyOn(service.store, "get");
		expect((await service.get(options)).status).toBe(403);
		expect(read).not.toHaveBeenCalled();
	});

	it.each(["POST", "PUT", "DELETE", "HEAD"])(
		"rejects %s rather than providing an ungoverned write surface",
		async (method) => {
			const service = await fixture();
			expect((await service.get({ method })).status).toBe(405);
			expect(service.calls).toHaveLength(0);
		},
	);

	it.each(["invalid=", "_w", Buffer.alloc(4097, 65).toString("base64url")])(
		"rejects invalid or oversized path encoding before authorization",
		async (encodedPath) => {
			const service = await fixture();
			expect((await service.get({ encodedPath })).status).toBe(400);
			expect(service.calls).toHaveLength(0);
		},
	);

	it.each([
		{ schema: "qorpera.member-company-object/v1" },
		{ actorUserId: undefined },
		{ resourceId: undefined },
		{ resourceVersion: undefined },
		{ actorUserId: "invalid" },
		{ resourceId: "invalid" },
		{ resourceVersion: 1 },
		{ resourceVersion: "invalid" },
		{ version: companyId },
		{ environmentId: companyId },
		{ sha256: "b".repeat(64) },
		{ path: "other.md" },
		{ companyId: "invalid" },
		{ bytes: 8 * 1024 * 1024 + 1 },
		{ bytes: -1 },
		{ backend: "untrusted" },
		{ readLease: "not-admitted" },
	])("rejects mismatched or overbroad authority responses: %j", async (override) => {
		const service = await fixture();
		service.state.override = override;
		const read = vi.spyOn(service.store, "get");
		expect((await service.get()).status).toBe(503);
		expect(read).not.toHaveBeenCalled();
	});

	it("refuses corrupt storage bytes without leaking them", async () => {
		const service = await fixture();
		vi.spyOn(service.store, "get").mockRejectedValue(new ObjectDependencyError(503));
		service.state.storageBytes = Buffer.alloc(bytes.length, 65);
		const response = await service.get();
		expect(response.status).toBe(503);
		expect(await response.text()).not.toContain(service.state.storageBytes.toString());
	});

	it("keeps the old raw-hash route denied for governed human reads", async () => {
		const service = await fixture();
		expect((await service.get({ route: `/v1/profile-objects/${companyId}/${sha256}` })).status).toBe(403);
	});

	it("records validated human/resource identity and logical object payload without sensitive content", async () => {
		const service = await fixture();
		const response = await service.get();
		await response.arrayBuffer();
		const result = service.observations.snapshot({ limit: 10, actorUserId });
		expect(result.observations).toHaveLength(1);
		expect(result.observations[0]).toMatchObject({
			companyId,
			environmentId,
			actorUserId,
			resourceId,
			resourceVersion,
			operation: "object_read",
			responseOutcome: "succeeded",
			httpStatus: 200,
			effectOutcome: "none",
			logicalObjectReadBytes: bytes.length,
			responseBodyBytes: bytes.length,
			commandId: null,
		});
		for (const forbidden of [
			memberToken,
			path,
			sha256,
			bytes.toString(),
			"sb_secret_fixture",
			"sb_publishable_fixture",
		])
			expect(JSON.stringify(result)).not.toContain(forbidden);
		expect(service.calls).toHaveLength(2);
	});

	it("does not attribute denied user-supplied IDs to a canonical actor or company", async () => {
		const service = await fixture();
		const response = await service.get({
			route: `/v1/member-company-objects/${companyId}/${version}/${sha256}`,
			token: "other-member",
		});
		const body = await response.text();
		expect(response.status).toBe(403);
		expect(service.observations.snapshot({ limit: 1 }).observations[0]).toMatchObject({
			companyId: null,
			environmentId: null,
			actorUserId: null,
			resourceId: null,
			resourceVersion: null,
			responseOutcome: "denied",
			errorCategory: "forbidden",
			logicalObjectReadBytes: null,
			responseBodyBytes: Buffer.byteLength(body),
		});
	});

	it("retains verified payload measurements after a separate result-release denial", async () => {
		const service = await fixture();
		vi.spyOn(service.store, "get").mockImplementation(async () => {
			service.state.status = 403;
			return bytes;
		});
		const response = await service.get();
		await response.text();
		expect(service.observations.snapshot({ limit: 1 }).observations[0]).toMatchObject({
			actorUserId,
			resourceId,
			responseOutcome: "denied",
			errorCategory: "forbidden",
			logicalObjectReadBytes: bytes.length,
			effectOutcome: "none",
		});
		expect(service.calls).toHaveLength(2);
	});

	it("does not let an optional observer failure prevent the authorized request", async () => {
		const service = await fixture();
		vi.spyOn(service.observations, "start").mockImplementation(() => {
			throw new Error("PRIVATE_OBSERVER_ERROR");
		});
		const response = await service.get();
		expect(response.status).toBe(200);
		expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
		expect(service.calls).toHaveLength(2);
	});
});

describe("operator-only human observation query", () => {
	it.each([undefined, "wrong", memberToken, "synthetic-verifier", "synthetic-native"])(
		"rejects %s before reading observations",
		async (token) => {
			const service = await fixture();
			const snapshot = vi.spyOn(service.observations, "snapshot");
			const response = await fetch(`${service.origin}${MEMBER_OBSERVATIONS_PATH}`, {
				headers: token ? { authorization: `Bearer ${token}` } : {},
			});
			expect(response.status).toBe(401);
			expect(snapshot).not.toHaveBeenCalled();
			expect(service.calls).toHaveLength(0);
		},
	);
	it("serves only filtered bounded metadata to the existing control token", async () => {
		const service = await fixture();
		await (await service.get()).arrayBuffer();
		const response = await fetch(`${service.origin}${MEMBER_OBSERVATIONS_PATH}?actorUserId=${actorUserId}&limit=1`, {
			headers: { authorization: "Bearer synthetic-control" },
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toMatchObject({
			schema: "qorpera.member-request-observation-window/v1",
			matched: 1,
			observations: [{ actorUserId, resourceId }],
		});
		expect(service.calls).toHaveLength(2);
	});
	it.each(["/extra", "?limit=101", "?limit=1&limit=2", "?path=secret"])(
		"rejects invalid operator route %s without reading observations",
		async (suffix) => {
			const service = await fixture();
			const snapshot = vi.spyOn(service.observations, "snapshot");
			const response = await fetch(`${service.origin}${MEMBER_OBSERVATIONS_PATH}${suffix}`, {
				headers: { authorization: "Bearer synthetic-control" },
			});
			expect([400, 404]).toContain(response.status);
			expect(snapshot).not.toHaveBeenCalled();
		},
	);
	it("does not expose observations on public health or permit a mutating query", async () => {
		const service = await fixture();
		await (await service.get()).arrayBuffer();
		const snapshot = vi.spyOn(service.observations, "snapshot");
		const health = await fetch(`${service.origin}/healthz`);
		expect(await health.json()).not.toHaveProperty("observations");
		expect(
			(
				await fetch(`${service.origin}${MEMBER_OBSERVATIONS_PATH}`, {
					method: "POST",
					headers: { authorization: "Bearer synthetic-control" },
				})
			).status,
		).toBe(404);
		expect(snapshot).not.toHaveBeenCalled();
	});
	it("contains an observation-export failure without changing member access", async () => {
		const service = await fixture();
		vi.spyOn(service.observations, "snapshot").mockImplementation(() => {
			throw new Error("PRIVATE_OBSERVER_ERROR");
		});
		const response = await fetch(`${service.origin}${MEMBER_OBSERVATIONS_PATH}`, {
			headers: { authorization: "Bearer synthetic-control" },
		});
		expect(response.status).toBe(503);
		expect(await response.text()).not.toContain("PRIVATE_OBSERVER_ERROR");
		expect((await service.get()).status).toBe(200);
	});
});
