import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
	};
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
		expect(gateway.state.calls).toEqual([]);
	});
});
