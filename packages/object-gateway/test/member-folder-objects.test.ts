import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MEMBER_OBSERVATIONS_PATH, MemberCompanyObservations } from "../src/member-observability.ts";
import { FileSystemObjectStore } from "../src/object-store.ts";
import { createObjectGatewayHandler } from "../src/service.ts";
import { SupabaseObjectAuthority } from "../src/supabase-authority.ts";

const companyId = "30000000-0000-4000-8000-000000000010";
const environmentId = "30000000-0000-4000-8000-000000000020";
const bytes = Buffer.from('{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"a","bytes":1}');
const sha256 = createHash("sha256").update(bytes).digest("hex");
const memberToken = "synthetic-member-jwt";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(options: { onNas?: boolean } = {}) {
	const root = await mkdtemp(join(tmpdir(), "qorpera-member-folder-read-"));
	const store = new FileSystemObjectStore(root);
	if (options.onNas !== false) await store.put(companyId, sha256, bytes);
	const state = {
		answers: [] as Array<{ status: number; body?: unknown }>,
		calls: [] as Array<{ path: string; apikey: string | null; authorization: string | null; body: unknown }>,
		storage: 0,
		storagePaths: [] as string[],
		storageStatus: 200,
	};
	const observations = new MemberCompanyObservations();
	const authority = new SupabaseObjectAuthority({
		projectUrl: "https://cloud.test",
		publishableKey: "sb_publishable_fixture",
		secretKey: "sb_secret_fixture",
		requestTimeoutMs: 100,
		fetch: async (input, init) => {
			const request = new Request(input, init);
			const url = new URL(request.url);
			if (url.pathname.startsWith("/storage/")) {
				state.storage++;
				state.storagePaths.push(url.pathname);
				expect(request.headers.get("authorization")).not.toBe(`Bearer ${memberToken}`);
				if (state.storageStatus !== 200) return new Response(null, { status: state.storageStatus });
				return new Response(Uint8Array.from(bytes));
			}
			state.calls.push({
				path: url.pathname,
				apikey: request.headers.get("apikey"),
				authorization: request.headers.get("authorization"),
				body: await request.json(),
			});
			const answer = state.answers.shift() ?? {
				status: 200,
				body: { schema: "qorpera.folder-object-download/v1", profileId: companyId, bytes: bytes.length },
			};
			return Response.json(answer.body ?? {}, { status: answer.status });
		},
	});
	const server = createServer(
		createObjectGatewayHandler({
			store,
			authority,
			memberFolderObjects: authority,
			memberObservations: observations,
			controlToken: "synthetic-control",
			verifierToken: "synthetic-verifier",
		}),
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture server");
	cleanups.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	});
	const origin = `http://127.0.0.1:${address.port}`;
	return {
		state,
		observations,
		origin,
		get(route = `/v1/member-folder-objects/${environmentId}/${sha256}`, init: RequestInit = {}) {
			return fetch(`${origin}${route}`, {
				...init,
				headers: { authorization: `Bearer ${memberToken}`, ...(init.headers ?? {}) },
			});
		},
	};
}

const allowed = { schema: "qorpera.folder-object-download/v1", profileId: companyId, bytes: bytes.length };

describe("a member's folder-v2 bytes", () => {
	it("serves one verified object with the member's own token, checked before and after the read", async () => {
		const gateway = await fixture();
		const response = await gateway.get();
		expect(response.status).toBe(200);
		expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("x-qorpera-access-mode")).toBe("live-path-authority");
		expect(response.headers.get("etag")).toBe(`"sha256-${sha256}"`);
		expect(gateway.state.calls).toEqual([
			{
				path: "/rest/v1/rpc/qorpera_member_folder_object",
				apikey: "sb_publishable_fixture",
				authorization: `Bearer ${memberToken}`,
				body: { p_environment_id: environmentId, p_sha256: sha256 },
			},
			{
				path: "/rest/v1/rpc/qorpera_member_folder_object",
				apikey: "sb_publishable_fixture",
				authorization: `Bearer ${memberToken}`,
				body: { p_environment_id: environmentId, p_sha256: sha256 },
			},
		]);
	});

	it("falls back to the Storage copy when the NAS has none yet", async () => {
		const gateway = await fixture({ onNas: false });
		const response = await gateway.get();
		expect(response.status).toBe(200);
		expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
		expect(gateway.state.storage).toBe(1);
		expect(gateway.state.storagePaths[0]).toContain(`${companyId}/${sha256}`);

		// Neither the NAS nor Storage has it: nothing is served.
		const missing = await fixture({ onNas: false });
		missing.state.storageStatus = 404;
		expect((await missing.get()).status).not.toBe(200);
	});

	it("serves nothing when the second check names another company or size", async () => {
		for (const changed of [
			{ ...allowed, profileId: "30000000-0000-4000-8000-000000000099" },
			{ ...allowed, bytes: bytes.length - 1 },
		]) {
			const gateway = await fixture();
			gateway.state.answers.push({ status: 200, body: allowed }, { status: 200, body: changed });
			const response = await gateway.get();
			expect(response.status).toBe(503);
			expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(false);
		}
	});

	it("serves nothing the database refuses, and nothing once access ends during the read", async () => {
		const refused = await fixture();
		refused.state.answers.push({ status: 403 });
		expect((await refused.get()).status).toBe(403);
		expect(refused.state.calls).toHaveLength(1);

		const ended = await fixture();
		ended.state.answers.push({ status: 200, body: allowed }, { status: 403 });
		const response = await ended.get();
		expect(response.status).toBe(403);
		expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(false);
	});

	it("fails closed on an answer it does not know", async () => {
		for (const body of [
			{ ...allowed, extra: true },
			{ ...allowed, schema: "qorpera.folder-object/v1" },
			{ ...allowed, profileId: "not-a-uuid" },
			{ ...allowed, bytes: 8 * 1024 * 1024 + 1 },
			null,
		]) {
			const gateway = await fixture();
			gateway.state.answers.push({ status: 200, body });
			expect((await gateway.get()).status).toBe(403);
		}
	});

	it("refuses bytes that are not the object the database named", async () => {
		const gateway = await fixture();
		gateway.state.answers.push({ status: 200, body: { ...allowed, bytes: bytes.length + 1 } });
		expect((await gateway.get()).status).toBe(503);
	});

	it("takes only its own route, a GET and a member's bearer token", async () => {
		const gateway = await fixture();
		expect((await gateway.get(`/v1/member-folder-objects/${environmentId}/${"z".repeat(64)}`)).status).toBe(404);
		expect(
			(await gateway.get(`/v1/member-folder-objects/not-a-uuid-at-all-not-a-uuid-at-all00/${sha256}`)).status,
		).toBe(404);
		expect((await gateway.get(undefined, { method: "PUT", body: "x" })).status).toBe(405);
		expect((await gateway.get(undefined, { headers: { authorization: "Basic x" } })).status).toBe(401);
		// snapshot-v1's member routes are gone (legacy removal, step C).
		for (const route of ["member-company-objects", "member-company-snapshot-objects"])
			expect((await gateway.get(`/v1/${route}/${environmentId}/${companyId}/${sha256}`)).status).toBe(404);
		expect(gateway.state.calls).toEqual([]);
	});

	it("records the company and payload of a read without sensitive content", async () => {
		const gateway = await fixture();
		await (await gateway.get()).arrayBuffer();
		const result = gateway.observations.snapshot({ limit: 10, companyId });
		expect(result.observations).toHaveLength(1);
		expect(result.observations[0]).toMatchObject({
			companyId,
			environmentId,
			actorUserId: null,
			operation: "object_read",
			responseOutcome: "succeeded",
			httpStatus: 200,
			effectOutcome: "none",
			logicalObjectReadBytes: bytes.length,
			responseBodyBytes: bytes.length,
			commandId: null,
		});
		for (const forbidden of [memberToken, sha256, bytes.toString(), "sb_secret_fixture", "sb_publishable_fixture"])
			expect(JSON.stringify(result)).not.toContain(forbidden);
		expect(gateway.state.calls).toHaveLength(2);
	});

	it("does not attribute a refused read to a company", async () => {
		const gateway = await fixture();
		gateway.state.answers.push({ status: 403 });
		const response = await gateway.get();
		const body = await response.text();
		expect(response.status).toBe(403);
		expect(gateway.observations.snapshot({ limit: 1 }).observations[0]).toMatchObject({
			companyId: null,
			environmentId: null,
			actorUserId: null,
			responseOutcome: "denied",
			errorCategory: "forbidden",
			logicalObjectReadBytes: null,
			responseBodyBytes: Buffer.byteLength(body),
		});
	});

	it("keeps the payload it read when the second check refuses the result", async () => {
		const gateway = await fixture();
		gateway.state.answers.push({ status: 200, body: allowed }, { status: 403 });
		await (await gateway.get()).text();
		expect(gateway.observations.snapshot({ limit: 1 }).observations[0]).toMatchObject({
			companyId,
			environmentId,
			responseOutcome: "denied",
			errorCategory: "forbidden",
			logicalObjectReadBytes: bytes.length,
			effectOutcome: "none",
		});
		expect(gateway.state.calls).toHaveLength(2);
	});

	it("serves the read when the optional observer fails", async () => {
		const gateway = await fixture();
		vi.spyOn(gateway.observations, "start").mockImplementation(() => {
			throw new Error("PRIVATE_OBSERVER_ERROR");
		});
		const response = await gateway.get();
		expect(response.status).toBe(200);
		expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
		expect(gateway.state.calls).toHaveLength(2);
	});
});

describe("operator-only human observation query", () => {
	it.each([undefined, "wrong", memberToken, "synthetic-verifier", "synthetic-native"])(
		"rejects %s before reading observations",
		async (token) => {
			const gateway = await fixture();
			const snapshot = vi.spyOn(gateway.observations, "snapshot");
			const response = await fetch(`${gateway.origin}${MEMBER_OBSERVATIONS_PATH}`, {
				headers: token ? { authorization: `Bearer ${token}` } : {},
			});
			expect(response.status).toBe(401);
			expect(snapshot).not.toHaveBeenCalled();
			expect(gateway.state.calls).toHaveLength(0);
		},
	);
	it("serves only filtered bounded metadata to the existing control token", async () => {
		const gateway = await fixture();
		await (await gateway.get()).arrayBuffer();
		const response = await fetch(`${gateway.origin}${MEMBER_OBSERVATIONS_PATH}?companyId=${companyId}&limit=1`, {
			headers: { authorization: "Bearer synthetic-control" },
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toMatchObject({
			schema: "qorpera.member-request-observation-window/v1",
			matched: 1,
			observations: [{ companyId, environmentId }],
		});
		expect(gateway.state.calls).toHaveLength(2);
	});
	it.each(["/extra", "?limit=101", "?limit=1&limit=2", "?path=secret"])(
		"rejects invalid operator route %s without reading observations",
		async (suffix) => {
			const gateway = await fixture();
			const snapshot = vi.spyOn(gateway.observations, "snapshot");
			const response = await fetch(`${gateway.origin}${MEMBER_OBSERVATIONS_PATH}${suffix}`, {
				headers: { authorization: "Bearer synthetic-control" },
			});
			expect([400, 404]).toContain(response.status);
			expect(snapshot).not.toHaveBeenCalled();
		},
	);
	it("does not expose observations on public health or permit a mutating query", async () => {
		const gateway = await fixture();
		await (await gateway.get()).arrayBuffer();
		const snapshot = vi.spyOn(gateway.observations, "snapshot");
		const health = await fetch(`${gateway.origin}/healthz`);
		expect(await health.json()).not.toHaveProperty("observations");
		expect(
			(
				await fetch(`${gateway.origin}${MEMBER_OBSERVATIONS_PATH}`, {
					method: "POST",
					headers: { authorization: "Bearer synthetic-control" },
				})
			).status,
		).toBe(404);
		expect(snapshot).not.toHaveBeenCalled();
	});
	it("contains an observation-export failure without changing member access", async () => {
		const gateway = await fixture();
		vi.spyOn(gateway.observations, "snapshot").mockImplementation(() => {
			throw new Error("PRIVATE_OBSERVER_ERROR");
		});
		const response = await fetch(`${gateway.origin}${MEMBER_OBSERVATIONS_PATH}`, {
			headers: { authorization: "Bearer synthetic-control" },
		});
		expect(response.status).toBe(503);
		expect(await response.text()).not.toContain("PRIVATE_OBSERVER_ERROR");
		expect((await gateway.get()).status).toBe(200);
	});
});
