import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ObjectDependency,
	ObjectDependencyError,
	ObjectLockConflict,
	ObjectStatementTimeout,
} from "../src/dependency.ts";
import { ObjectGatewayJournal } from "../src/journal.ts";
import { SupabaseMemberCompanyAuthority } from "../src/member-company-authority.ts";
import { FileSystemObjectStore } from "../src/object-store.ts";
import { ObjectGatewayReplication } from "../src/replication.ts";
import { createObjectGatewayHandler } from "../src/service.ts";
import { SupabaseObjectAuthority } from "../src/supabase-authority.ts";

// PostgREST answers SQLSTATE classes 40 and 55, and 57014, with HTTP 500. One company's lock conflict or stop
// must not open the gateway's shared database circuit for every other company; real outages still must.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

const companies = {
	a: { companyId: "40000000-0000-4000-8000-00000000000a", environmentId: "40000000-0000-4000-8000-0000000000ea" },
	b: { companyId: "40000000-0000-4000-8000-00000000000b", environmentId: "40000000-0000-4000-8000-0000000000eb" },
};
type Company = keyof typeof companies;
const path = "documents/plan.md";
const bytes = Buffer.from("Company bytes for the circuit test.");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const memberToken = "synthetic-member-jwt";
const nativeToken = randomBytes(32).toString("base64url");
const holder = `job.40000000-0000-4000-8000-000000000103.${randomBytes(32).toString("base64url")}`;
const intent = "40000000-0000-4000-8000-000000000401";
const binding = Buffer.from(
	JSON.stringify({
		leaseId: "40000000-0000-4000-8000-000000000101",
		runId: "40000000-0000-4000-8000-000000000102",
		jobId: "40000000-0000-4000-8000-000000000103",
		runnerId: "40000000-0000-4000-8000-000000000104",
		assignmentId: "40000000-0000-4000-8000-000000000105",
		credentialCapsuleId: "40000000-0000-4000-8000-000000000106",
		computeIdentityId: "40000000-0000-4000-8000-000000000107",
		provider: "openai",
		nativeHarness: "codex-cli",
		model: "gpt-synthetic",
	}),
).toString("base64url");

function postgrest(code: string): Response {
	return Response.json({ code, message: "synthetic", details: null, hint: null }, { status: 500 });
}

/** Failures that mean the database or its path is down, answered for every company. */
const outages: Array<[string, (signal: AbortSignal) => Promise<Response>]> = [
	["500 with another SQLSTATE", async () => postgrest("XX000")],
	["500 with an I/O SQLSTATE", async () => postgrest("58030")],
	["500 for an administrator shutdown", async () => postgrest("57P01")],
	["500 without a body", async () => new Response(null, { status: 500 })],
	["500 that is not JSON", async () => new Response("<html>upstream</html>", { status: 500 })],
	["502", async () => new Response("bad gateway", { status: 502 })],
	["503", async () => Response.json({ code: "PGRST000" }, { status: 503 })],
	["504", async () => new Response(null, { status: 504 })],
	[
		"connection refused",
		async () => {
			throw new TypeError("fetch failed", {
				cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
			});
		},
	],
	[
		"no answer before the deadline",
		(signal) =>
			new Promise<Response>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			}),
	],
];

async function gateway() {
	const root = await mkdtemp(join(tmpdir(), "qorpera-company-state-circuit-"));
	await mkdir(join(root, "objects"), { mode: 0o700 });
	const store = new FileSystemObjectStore(join(root, "objects"));
	for (const company of Object.values(companies)) await store.put(company.companyId, sha256, bytes);
	const state = {
		// A failure for one company's RPCs; every other call is answered normally.
		fail: undefined as undefined | { company: Company; respond: (signal: AbortSignal) => Promise<Response> },
		rpcCalls: [] as Array<{ name: string; company: Company | undefined }>,
		replicas: new Map<string, Uint8Array>(),
	};
	const companyOf = (args: Record<string, unknown>): Company | undefined =>
		(Object.keys(companies) as Company[]).find(
			(key) =>
				args.p_profile_id === companies[key].companyId || args.p_environment_id === companies[key].environmentId,
		);
	const authority = new SupabaseObjectAuthority({
		projectUrl: "https://cloud.test",
		publishableKey: "sb_publishable_fixture",
		secretKey: "sb_secret_fixture",
		requestTimeoutMs: 1_000,
		// The clock stands still: once open, the circuit stays open for the whole test.
		now: () => 1_800_000_000_000,
		fetch: async (input, init) => {
			const request = new Request(input, init);
			const pathname = new URL(request.url).pathname;
			if (pathname.startsWith("/storage/v1/object/")) {
				const key = pathname.split("/").slice(-2).join("/");
				if (request.method === "POST") {
					state.replicas.set(key, new Uint8Array(await request.arrayBuffer()));
					return Response.json({});
				}
				const replica = state.replicas.get(key);
				return replica ? new Response(Uint8Array.from(replica)) : Response.json({}, { status: 404 });
			}
			const name = pathname.split("/").at(-1)!;
			const args = (await request.json()) as Record<string, unknown>;
			const company = companyOf(args);
			state.rpcCalls.push({ name, company });
			if (company && state.fail?.company === company) return state.fail.respond(init!.signal!);
			if (name === "qorpera_native_binding_proven") return Response.json(true);
			if (name === "qorpera_folder_authorize_object_download")
				return Response.json({
					schema: "qorpera.folder-object-download/v1",
					profileId: companies[company!].companyId,
					bytes: bytes.length,
				});
			if (name === "qorpera_folder_authorize_object_upload")
				return Response.json({
					schema: "qorpera.folder-object-upload/v1",
					profileId: companies[company!].companyId,
				});
			if (name === "qorpera_folder_confirm_object")
				return Response.json({ schema: "qorpera.folder-object/v1", sha256, bytes: bytes.length });
			if (["qorpera_authorize_profile_object_replication", "qorpera_confirm_profile_object_replica"].includes(name))
				return Response.json(true);
			if (name === "qorpera_list_profile_objects_for_migration") return Response.json([]);
			if (name === "qorpera_member_folder_object")
				return Response.json({
					schema: "qorpera.folder-object-download/v1",
					profileId: companies[company!].companyId,
					bytes: bytes.length,
				});
			return Response.json({}, { status: 403 });
		},
	});
	const journal = new ObjectGatewayJournal(join(root, "journal"));
	const replication = new ObjectGatewayReplication(journal, store, authority);
	const server = createServer(
		createObjectGatewayHandler({
			store,
			authority,
			replication,
			memberFolderObjects: authority,
			nativeObjects: { token: nativeToken, folder: authority },
			controlToken: "synthetic-control",
		}),
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture server");
	const origin = `http://127.0.0.1:${address.port}`;
	cleanups.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	});
	const routes = {
		"folder read": (company: Company) =>
			fetch(`${origin}/v1/folder-objects/${companies[company].environmentId}/${sha256}`, {
				headers: {
					authorization: `Bearer ${nativeToken}`,
					"x-qorpera-native-binding": binding,
					"x-qorpera-identity": holder,
				},
			}),
		"folder write": (company: Company) =>
			fetch(`${origin}/v1/folder-objects/${companies[company].environmentId}/${sha256}`, {
				method: "PUT",
				headers: {
					authorization: `Bearer ${nativeToken}`,
					"x-qorpera-native-binding": binding,
					"x-qorpera-identity": holder,
					"x-qorpera-upload-intent": intent,
				},
				body: bytes,
			}),
		"member read": (company: Company) =>
			fetch(`${origin}/v1/member-folder-objects/${companies[company].environmentId}/${sha256}`, {
				headers: { authorization: `Bearer ${memberToken}` },
			}),
	};
	return { authority, journal, replication, state, routes };
}

type Route = "folder read" | "folder write" | "member read";
const routes: Route[] = ["folder read", "folder write", "member read"];
const served = (response: Response) => [200, 201].includes(response.status);

describe("one company's database state and the shared circuit", () => {
	it.each(
		routes.flatMap((route) =>
			(
				[
					["40P01", 409],
					["40001", 409],
					["55P03", 409],
					["55000", 423],
				] as const
			).map(([code, status]) => [route, code, status] as const),
		),
	)("%s: %s answers %s and does not refuse another company", async (route, code, status) => {
		const { authority, state, routes } = await gateway();
		state.fail = { company: "a", respond: async () => postgrest(code) };
		const refused = await routes[route]("a");
		expect(refused.status).toBe(status);
		expect(await refused.json()).toEqual({ error: "Object authority rejected the operation" });
		expect(authority.health().api.status).toBe("healthy");
		// Within the cooldown, another company's request reaches the database and is served. (The folder route's lease
		// proof names no company.)
		const before = state.rpcCalls.length;
		const other = await routes[route]("b");
		expect(served(other)).toBe(true);
		expect(state.rpcCalls.slice(before).some((call) => call.company === "b")).toBe(true);
		expect(state.rpcCalls.slice(before).some((call) => call.company === "a")).toBe(false);
		// And the same company is asked again, not refused by the gateway.
		state.fail = undefined;
		expect(served(await routes[route]("a"))).toBe(true);
	});

	it.each(routes.flatMap((route) => outages.map(([label, respond]) => [route, label, respond] as const)))(
		"%s: %s still opens the circuit for every company",
		async (route, _label, respond) => {
			const { authority, state, routes } = await gateway();
			state.fail = { company: "a", respond };
			expect((await routes[route]("a")).status).toBe(503);
			expect(authority.health().api.status).toBe("unavailable");
			const before = state.rpcCalls.length;
			const other = await routes[route]("b");
			expect(other.status).toBe(503);
			expect(state.rpcCalls.length).toBe(before);
		},
	);

	it("a statement timeout is 503, and opens the circuit only when nothing else succeeded meanwhile", async () => {
		const { authority, state, routes } = await gateway();
		// Company A's statement runs out while company B is served: the database is answering, so A's slow
		// statement is A's. A gets 503 and B keeps being served.
		let release!: () => void;
		const bServed = new Promise<void>((resolve) => {
			release = resolve;
		});
		state.fail = {
			company: "a",
			respond: async () => {
				await bServed;
				return postgrest("57014");
			},
		};
		const slow = routes["folder read"]("a");
		await expect.poll(() => state.rpcCalls.some((call) => call.company === "a")).toBe(true);
		expect(served(await routes["member read"]("b"))).toBe(true);
		release();
		expect((await slow).status).toBe(503);
		expect(authority.health().api.status).toBe("healthy");
		expect(served(await routes["folder read"]("b"))).toBe(true);

		// With no success while it ran, a statement timeout is the database being slow for everyone.
		state.fail = { company: "a", respond: async () => postgrest("57014") };
		expect((await routes["member read"]("a")).status).toBe(503);
		expect(authority.health().api.status).toBe("unavailable");
		const before = state.rpcCalls.length;
		expect((await routes["folder read"]("b")).status).toBe(503);
		expect(state.rpcCalls.length).toBe(before);
	});

	it.each(["55P03", "40P01", "40001"])(
		"a %s on one company's replication neither blocks its object nor refuses another company",
		async (code) => {
			// The reconciler blocks an object for good on any refusal that is not "unavailable", so a lock conflict
			// on these RPCs stays a 503 to the reconciler, and it leaves the shared circuit closed.
			const { authority, replication, state, routes } = await gateway();
			for (const company of ["a", "b"] as const) expect((await routes["folder write"](company)).status).toBe(200);
			state.fail = { company: "a", respond: async () => postgrest(code) };
			const failure = await authority
				.authorizeReplication(companies.a.companyId, sha256, bytes.length)
				.catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(ObjectLockConflict);
			expect(failure).toMatchObject({ status: 503, unavailable: true });
			await replication.reconcile();
			expect(await replication.status()).toMatchObject({ pending: 1, blocked: 0 });
			expect([...state.replicas.keys()]).toEqual([`${companies.b.companyId}/${sha256}`]);
			expect(authority.health().api.status).toBe("healthy");
			expect(served(await routes["folder read"]("b"))).toBe(true);
			// Once A's rows are free, the same object replicates.
			state.fail = undefined;
			await replication.reconcile();
			expect(await replication.status()).toMatchObject({ pending: 0, blocked: 0 });
			expect(state.replicas.size).toBe(2);
		},
	);

	it.each([
		// PostgREST's own 409: the garbage collector's write fence, which lasts until its deletion ends.
		[
			"a GC write fence (409 QRC01)",
			async () => Response.json({ code: "QRC01", message: "fenced" }, { status: 409 }),
		],
		["a denial (403 42501)", async () => Response.json({ code: "42501", message: "denied" }, { status: 403 })],
		["a stop (55000)", async () => postgrest("55000")],
		["a statement timeout (57014)", async () => postgrest("57014")],
		["another 500", async () => postgrest("XX000")],
	] as const)("answers %s with nothing but its error", async (_label, respond) => {
		const { state, routes: send } = await gateway();
		state.fail = { company: "a", respond };
		for (const route of routes)
			expect(Object.keys((await (await send[route]("a")).json()) as object)).toEqual(["error"]);
	});

	it("refuses a write during the same object's deletion with nothing but its error", async () => {
		const { journal, routes } = await gateway();
		// The deletion lane owns the object until it ends: 409, and not a request to send again at once.
		await journal.write(`pending/${companies.a.companyId}-${sha256}`, {
			profileId: companies.a.companyId,
			sha256,
			bytes: bytes.length,
			state: "delete",
			authorizationId: "40000000-0000-4000-8000-000000000301",
		});
		const refused = await routes["folder write"]("a");
		expect(refused.status).toBe(409);
		expect(await refused.json()).toEqual({ error: "Object authority rejected the operation" });
	});

	it("keeps other 500s on profile and replication RPCs dependency failures", async () => {
		const { authority, state } = await gateway();
		state.fail = { company: "a", respond: async () => postgrest("55000") };
		const failure = await authority
			.authorizeReplication(companies.a.companyId, sha256, bytes.length)
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(ObjectDependencyError);
		expect(failure).toMatchObject({ status: 500, unavailable: true });
		expect(authority.health().api.status).toBe("unavailable");
	});
});

describe("folder core byte RPCs", () => {
	// #560's folder RPCs read one company's state like any company RPC, and #582 adds the storage allowance: a
	// check violation (23514, a 400 from PostgREST) is 413. None of these opens the circuit for another company.
	const actor = {
		kind: "run" as const,
		runId: "40000000-0000-4000-8000-000000000102",
		jobId: "40000000-0000-4000-8000-000000000103",
		runnerId: "40000000-0000-4000-8000-000000000104",
		assignmentId: "40000000-0000-4000-8000-000000000105",
	};
	function folderAuthority(fail: (signal: AbortSignal) => Promise<Response>) {
		const calls: Company[] = [];
		const authority = new SupabaseObjectAuthority({
			projectUrl: "https://cloud.test",
			publishableKey: "sb_publishable_fixture",
			secretKey: "sb_secret_fixture",
			requestTimeoutMs: 1_000,
			now: () => 1_800_000_000_000,
			fetch: async (_input, init) => {
				const args = JSON.parse(String(init?.body)) as Record<string, unknown>;
				const company = args.p_environment_id === companies.a.environmentId ? "a" : "b";
				calls.push(company);
				if (company === "a") return fail(init!.signal!);
				return Response.json({ schema: "qorpera.folder-object/v1", sha256, bytes: bytes.length });
			},
		});
		const confirm = (company: Company) =>
			authority.confirmFolderObject(companies[company].environmentId, actor, intent, sha256, bytes.length);
		return { authority, calls, confirm };
	}

	it.each([
		[
			"a full company (400 23514)",
			async () => Response.json({ code: "23514", message: "full" }, { status: 400 }),
			413,
		],
		["another 400", async () => Response.json({ code: "22023", message: "invalid" }, { status: 400 }), 400],
		["a stop (55000)", async () => postgrest("55000"), 423],
		["a lock conflict (55P03)", async () => postgrest("55P03"), 409],
	] as const)("answers %s with %s and serves another company next", async (_label, fail, status) => {
		const { authority, calls, confirm } = folderAuthority(fail);
		await expect(confirm("a")).rejects.toMatchObject({ status, unavailable: false });
		expect(authority.health().api.status).toBe("healthy");
		await expect(confirm("b")).resolves.toBeUndefined();
		expect(calls).toEqual(["a", "b"]);
	});

	it("keeps another 500 a dependency failure that opens the circuit", async () => {
		const { authority, calls, confirm } = folderAuthority(async () => postgrest("XX000"));
		await expect(confirm("a")).rejects.toMatchObject({ status: 500, unavailable: true });
		expect(authority.health().api.status).toBe("unavailable");
		await expect(confirm("b")).rejects.toMatchObject({ status: 503 });
		expect(calls).toEqual(["a"]);
	});
});

describe("member Company File authority", () => {
	function memberAuthority(respond: (args: Record<string, unknown>, signal: AbortSignal) => Promise<Response>) {
		const calls: Array<Record<string, unknown>> = [];
		const authority = new SupabaseMemberCompanyAuthority({
			projectUrl: "https://cloud.test",
			publishableKey: "public",
			secretKey: "secret",
			requestTimeoutMs: 1_000,
			fetch: async (_input, init) => {
				const args = JSON.parse(String(init?.body)) as Record<string, unknown>;
				calls.push(args);
				return respond(args, init!.signal!);
			},
		});
		const call = (company: Company, signal = new AbortController().signal) =>
			authority.member(
				"qorpera_company_presence_scope",
				memberToken,
				{ p_environment_id: companies[company].environmentId },
				signal,
			);
		return { calls, call };
	}

	const hangUntilAborted = (signal: AbortSignal) =>
		new Promise<Response>((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		});

	it.each([
		["its client disconnects", (caller: AbortController) => setTimeout(() => caller.abort(), 20)],
		[
			"its own deadline passes",
			(caller: AbortController) => setTimeout(() => caller.abort(new DOMException("", "TimeoutError")), 20),
		],
	] as const)("leaves the circuit closed when a caller gives up because %s", async (_label, giveUp) => {
		// The reviewer's probe on #568: a caller abort used to count as a dependency failure, so the next
		// company's call got 503 without reaching the database.
		const { calls, call } = memberAuthority(async (args, signal) =>
			args.p_environment_id === companies.a.environmentId ? hangUntilAborted(signal) : Response.json({ ok: true }),
		);
		const caller = new AbortController();
		const abandoned = call("a", caller.signal);
		giveUp(caller);
		await expect(abandoned).rejects.toBeInstanceOf(ObjectDependencyError);
		await expect(call("b")).resolves.toEqual({ ok: true });
		expect(calls).toHaveLength(2);
	});

	it("still opens its circuit on its own deadline, even when the caller gives up at the same moment", async () => {
		const caller = new AbortController();
		const { calls, call } = memberAuthority(async (args, signal) => {
			if (args.p_environment_id !== companies.a.environmentId) return Response.json({ ok: true });
			// The gateway's deadline aborts the fetch; the caller gives up in the same tick.
			signal.addEventListener("abort", () => caller.abort(), { once: true });
			return hangUntilAborted(signal);
		});
		await expect(call("a", caller.signal)).rejects.toMatchObject({ status: 503 });
		expect(caller.signal.aborted).toBe(true);
		await expect(call("b")).rejects.toMatchObject({ status: 503 });
		expect(calls).toHaveLength(1);
	});

	it.each([
		["40P01", 409],
		["40001", 409],
		["55P03", 409],
		["55000", 423],
	] as const)("answers %s with %s and serves another company next", async (code, status) => {
		const { calls, call } = memberAuthority(async (args) =>
			args.p_environment_id === companies.a.environmentId ? postgrest(code) : Response.json({ ok: true }),
		);
		await expect(call("a")).rejects.toMatchObject({ status, unavailable: false });
		await expect(call("b")).resolves.toEqual({ ok: true });
		expect(calls).toHaveLength(2);
	});

	it.each(outages)("still opens its circuit for %s", async (_label, respond) => {
		const { calls, call } = memberAuthority(async (args, signal) =>
			args.p_environment_id === companies.a.environmentId ? respond(signal) : Response.json({ ok: true }),
		);
		await expect(call("a")).rejects.toMatchObject({ unavailable: true });
		await expect(call("b")).rejects.toMatchObject({ status: 503 });
		expect(calls).toHaveLength(1);
	});
});

describe("member presence route and the caller's own abort", () => {
	const token = "a".repeat(64);
	async function presence() {
		const calls: Company[] = [];
		const abandoned: Company[] = [];
		const authority = new SupabaseMemberCompanyAuthority({
			projectUrl: "https://cloud.test",
			publishableKey: "public",
			secretKey: "secret",
			requestTimeoutMs: 5_000,
			fetch: async (_input, init) => {
				const args = JSON.parse(String(init?.body)) as Record<string, unknown>;
				const company = (Object.keys(companies) as Company[]).find(
					(key) => args.p_environment_id === companies[key].environmentId,
				)!;
				calls.push(company);
				// Company A's scope waits on its locks until the request is abandoned.
				if (company === "a")
					return new Promise<Response>((_resolve, reject) => {
						init!.signal!.addEventListener(
							"abort",
							() => {
								abandoned.push(company);
								reject(init!.signal!.reason);
							},
							{ once: true },
						);
					});
				return Response.json({
					schema: "qorpera.company-presence-scope/v1",
					companyId: companies.b.companyId,
					environmentId: companies.b.environmentId,
					paths: [{ path, routes: [{ path, token }] }],
				});
			},
		});
		const server = createServer(
			createObjectGatewayHandler({
				store: {} as never,
				authority: {} as never,
				controlToken: "synthetic-control",
				memberPresence: authority,
			}),
		);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing fixture server");
		cleanups.push(async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		});
		const post = (company: Company, signal?: AbortSignal) =>
			fetch(
				`http://127.0.0.1:${address.port}/v1/member-company-presence/${companies[company].companyId}/${companies[company].environmentId}`,
				{
					method: "POST",
					headers: { authorization: `Bearer ${memberToken}`, "content-type": "application/json" },
					body: JSON.stringify({ paths: [path], candidates: [], truncated: false }),
					...(signal ? { signal } : {}),
				},
			);
		return { calls, abandoned, post };
	}

	it("serves another company after one member closes the tab mid-request", async () => {
		const { calls, abandoned, post } = await presence();
		const tab = new AbortController();
		const closed = post("a", tab.signal).catch((error: unknown) => error);
		await expect.poll(() => calls.includes("a")).toBe(true);
		tab.abort();
		await closed;
		// The gateway sees the disconnect and abandons A's call; B's presence still reaches the database.
		await expect.poll(() => abandoned).toEqual(["a"]);
		await new Promise((resolve) => setImmediate(resolve));
		const other = await post("b");
		expect(other.status).toBe(200);
		expect(await other.json()).toMatchObject({ view: { state: "available" } });
		expect(calls).toEqual(["a", "b", "b"]);
	});

	it("serves another company after one presence request passes its 2.5 s deadline", async () => {
		const { calls, abandoned, post } = await presence();
		const late = await post("a");
		expect(abandoned).toEqual(["a"]);
		expect(late.status).toBe(503);
		const other = await post("b");
		expect(other.status).toBe(200);
		expect(calls).toEqual(["a", "b", "b"]);
	}, 10_000);
});

describe("dependency circuit and statement timeouts", () => {
	it("leaves the circuit as it is when another call succeeded during the statement", async () => {
		const dependency = new ObjectDependency(1_000, 5_000, () => 0);
		let finish!: () => void;
		const slow = dependency.run(
			() =>
				new Promise<never>((_resolve, reject) => {
					finish = () => reject(new ObjectStatementTimeout());
				}),
		);
		await dependency.run(async () => "served");
		finish();
		await expect(slow).rejects.toBeInstanceOf(ObjectStatementTimeout);
		await expect(dependency.run(async () => "next")).resolves.toBe("next");
	});

	it("does not let a statement timeout close a circuit another failure opened", async () => {
		const dependency = new ObjectDependency(1_000, 5_000, () => 0);
		let finish!: () => void;
		const slow = dependency.run(
			() =>
				new Promise<never>((_resolve, reject) => {
					finish = () => reject(new ObjectStatementTimeout());
				}),
		);
		await dependency.run(async () => "served");
		await expect(
			dependency.run(async () => {
				throw new ObjectDependencyError(502);
			}),
		).rejects.toMatchObject({ status: 502 });
		finish();
		await expect(slow).rejects.toBeInstanceOf(ObjectStatementTimeout);
		expect(dependency.health().status).toBe("unavailable");
		await expect(dependency.run(async () => "refused")).rejects.toMatchObject({ status: 503 });
	});

	it("opens on a statement timeout when nothing succeeded while it ran", async () => {
		const dependency = new ObjectDependency(1_000, 5_000, () => 0);
		await dependency.run(async () => "earlier success");
		await expect(
			dependency.run(async () => {
				throw new ObjectStatementTimeout();
			}),
		).rejects.toMatchObject({ status: 503, unavailable: true });
		expect(dependency.health().status).toBe("unavailable");
		await expect(dependency.run(async () => "refused")).rejects.toMatchObject({ status: 503 });
	});
});
