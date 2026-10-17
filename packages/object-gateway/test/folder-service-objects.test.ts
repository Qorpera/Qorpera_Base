import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { folderServiceActor } from "../src/folder-service-objects.ts";
import { ObjectGatewayJournal } from "../src/journal.ts";
import { FileSystemObjectStore } from "../src/object-store.ts";
import { ObjectGatewayReplication } from "../src/replication.ts";
import { createObjectGatewayHandler } from "../src/service.ts";
import { SupabaseObjectAuthority } from "../src/supabase-authority.ts";

/** The folder service's byte route (F3 step 3): its own token, a view's actor, the folder core's per-object checks. */
const companyId = "31000000-0000-4000-8000-000000000010";
const environmentId = "31000000-0000-4000-8000-000000000020";
const intentId = "31000000-0000-4000-8000-000000000030";
const member = { kind: "member", userId: "31000000-0000-4000-8000-000000000001" };
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "qorpera-folder-service-objects-"));
	await mkdir(join(root, "objects"), { mode: 0o700 });
	const store = new FileSystemObjectStore(join(root, "objects"));
	const token = randomBytes(32).toString("base64url");
	const nativeToken = randomBytes(32).toString("base64url");
	const sql = {
		calls: [] as Array<{ method: string; args: Record<string, unknown> }>,
		/** The objects the intent lists, by hash: their sizes. */
		listed: new Map<string, number>(),
		/** The core refuses this actor's intent (42501), as for an intent of another actor. */
		refuse: false,
	};
	const authority = new SupabaseObjectAuthority({
		projectUrl: "https://cloud.test",
		publishableKey: "sb_publishable_fixture",
		secretKey: "sb_secret_fixture",
		requestTimeoutMs: 1_000,
		circuitCooldownMs: 0,
		fetch: async (input, init) => {
			const request = new Request(input, init);
			const pathname = new URL(request.url).pathname;
			if (pathname.startsWith("/storage/")) return Response.json({});
			const method = pathname.split("/").at(-1)!;
			const args = (await request.json()) as Record<string, unknown>;
			if (
				["qorpera_authorize_profile_object_replication", "qorpera_confirm_profile_object_replica"].includes(method)
			)
				return Response.json(true);
			sql.calls.push({ method, args });
			if (sql.refuse || args.p_intent !== intentId || sql.listed.get(args.p_sha256 as string) !== args.p_bytes)
				return Response.json({ code: "42501", message: "Upload intent is unavailable" }, { status: 403 });
			if (method === "qorpera_folder_authorize_object_upload")
				return Response.json({ schema: "qorpera.folder-object-upload/v1", profileId: companyId });
			if (method === "qorpera_folder_confirm_object")
				return Response.json({
					schema: "qorpera.folder-object/v1",
					sha256: args.p_sha256,
					bytes: args.p_bytes,
					stored: true,
				});
			return Response.json({ code: "42883" }, { status: 404 });
		},
	});
	const replication = new ObjectGatewayReplication(new ObjectGatewayJournal(join(root, "journal")), store, authority);
	const server = createServer(
		createObjectGatewayHandler({
			store,
			authority,
			replication,
			controlToken: "synthetic-control",
			nativeObjects: { token: nativeToken, folder: authority },
			folderServiceObjects: { token, authority },
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
	const put = (
		body: string,
		options: { hash?: string; actor?: string; bearer?: string; intent?: string | null; route?: string } = {},
	) =>
		fetch(`${origin}${options.route ?? "/v1/folder-service-objects"}/${environmentId}/${options.hash ?? sha(body)}`, {
			method: "PUT",
			body,
			headers: {
				authorization: `Bearer ${options.bearer ?? token}`,
				"x-qorpera-folder-actor": options.actor ?? encode(member),
				...(options.intent === null ? {} : { "x-qorpera-upload-intent": options.intent ?? intentId }),
				"content-type": "application/octet-stream",
			},
		});
	return { sql, store, put, origin, token, nativeToken, authority, replication };
}

describe("the folder service's byte route", () => {
	it("puts an object its view's actor listed, through the folder core's checks", async () => {
		const { sql, store, put } = await fixture();
		sql.listed.set(sha("chunk"), 5);
		const response = await put("chunk");
		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({ status: "stored", sha256: sha("chunk"), bytes: 5 });
		expect(Buffer.from(await store.get(companyId, sha("chunk"), 5)).toString()).toBe("chunk");
		// Authorized before the body is read and again in the write lane, then confirmed, each as the member.
		expect(sql.calls.map((call) => call.method)).toEqual([
			"qorpera_folder_authorize_object_upload",
			"qorpera_folder_authorize_object_upload",
			"qorpera_folder_confirm_object",
		]);
		for (const call of sql.calls)
			expect(call.args).toEqual({
				p_environment_id: environmentId,
				p_actor: member,
				p_intent: intentId,
				p_sha256: sha("chunk"),
				p_bytes: 5,
			});
		// The same object again is the same put.
		expect((await put("chunk")).status).toBe(200);
	});

	it("passes a view's and the platform's actor to the folder core as named", async () => {
		const { sql, put } = await fixture();
		sql.listed.set(sha("v"), 1);
		const view = { kind: "view", viewId: "31000000-0000-4000-8000-000000000040", pass: "p".repeat(43) };
		expect((await put("v", { actor: encode(view) })).status).toBe(201);
		expect((await put("v", { actor: encode({ kind: "platform" }) })).status).toBe(200);
		expect(sql.calls.map((call) => call.args.p_actor)).toEqual([
			view,
			view,
			view,
			{ kind: "platform" },
			{ kind: "platform" },
			{ kind: "platform" },
		]);
	});

	it("refuses another credential, and its own credential on the other routes", async () => {
		const { sql, put, nativeToken } = await fixture();
		sql.listed.set(sha("x"), 1);
		expect((await put("x", { bearer: nativeToken })).status).toBe(401);
		expect((await put("x", { bearer: "synthetic-control" })).status).toBe(401);
		expect((await put("x", { route: "/v1/folder-objects" })).status).toBe(401);
		expect(sql.calls).toEqual([]);
	});

	it("refuses a request that is not a put of the object it names, before anything is stored", async () => {
		const { sql, store, put, origin, token } = await fixture();
		sql.listed.set(sha("right"), 5);
		// Five bytes under the five-byte object, but not its bytes: refused before the confirm.
		expect((await put("wrong", { hash: sha("right") })).status).toBe(400);
		expect(sql.calls.map((call) => call.method)).toEqual(["qorpera_folder_authorize_object_upload"]);
		await expect(store.get(companyId, sha("right"), 5)).rejects.toThrow();
		expect((await put("right", { intent: null })).status).toBe(400);
		expect((await put("right", { intent: "not-an-intent" })).status).toBe(400);
		const get = await fetch(`${origin}/v1/folder-service-objects/${environmentId}/${sha("right")}`, {
			headers: { authorization: `Bearer ${token}`, "x-qorpera-folder-actor": encode(member) },
		});
		expect(get.status).toBe(405);
		expect(
			(
				await fetch(`${origin}/v1/folder-service-objects/not-an-environment/${sha("right")}`, {
					method: "PUT",
					body: "right",
					headers: { authorization: `Bearer ${token}` },
				})
			).status,
		).toBe(404);
	});

	it("answers the folder core's refusal as its own", async () => {
		const { sql, store, put } = await fixture();
		sql.listed.set(sha("mine"), 4);
		sql.refuse = true;
		expect((await put("mine")).status).toBe(403);
		await expect(store.get(companyId, sha("mine"), 4)).rejects.toThrow();
	});
});

describe("the folder service's actor header", () => {
	it("takes exactly a member's, the platform's or a view's fields, in canonical base64url JSON", () => {
		const view = { kind: "view", viewId: "31000000-0000-4000-8000-000000000040", pass: "A".repeat(43) };
		expect(folderServiceActor(encode(member))).toEqual(member);
		expect(folderServiceActor(encode({ kind: "platform" }))).toEqual({ kind: "platform" });
		expect(folderServiceActor(encode(view))).toEqual(view);
		const refused = [
			undefined,
			"",
			`${encode(member)}=`,
			encode({ ...member, extra: 1 }),
			encode({ kind: "member", userId: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE" }),
			encode({ kind: "platform", userId: member.userId }),
			encode({ ...view, pass: "short" }),
			encode({
				kind: "run",
				runId: member.userId,
				jobId: member.userId,
				runnerId: member.userId,
				assignmentId: member.userId,
			}),
			encode([member]),
			Buffer.from("{not json").toString("base64url"),
			"x".repeat(1025),
		];
		for (const value of refused) expect(() => folderServiceActor(value), String(value)).toThrow();
	});
});

describe("the folder service's credential", () => {
	it("must be its own, and needs replication", async () => {
		const root = await mkdtemp(join(tmpdir(), "qorpera-folder-service-objects-"));
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		const store = new FileSystemObjectStore(root);
		const authority = new SupabaseObjectAuthority({
			projectUrl: "https://cloud.test",
			publishableKey: "sb_publishable_fixture",
			secretKey: "sb_secret_fixture",
		});
		const replication = new ObjectGatewayReplication(
			new ObjectGatewayJournal(join(root, "journal")),
			store,
			authority,
		);
		const token = randomBytes(32).toString("base64url");
		const base = { store, authority, controlToken: "synthetic-control" };
		expect(() => createObjectGatewayHandler({ ...base, folderServiceObjects: { token, authority } })).toThrow();
		expect(() =>
			createObjectGatewayHandler({ ...base, replication, folderServiceObjects: { token: "short", authority } }),
		).toThrow();
		expect(() =>
			createObjectGatewayHandler({
				...base,
				replication,
				nativeObjects: { token, folder: authority },
				folderServiceObjects: { token, authority },
			}),
		).toThrow();
		expect(() =>
			createObjectGatewayHandler({ ...base, replication, folderServiceObjects: { token, authority } }),
		).not.toThrow();
	});
});
