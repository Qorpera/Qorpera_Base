import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpCloudCompanyFolderBytes } from "@qorpera/runtime/cloud-company-folder-bytes";
import { CloudCompanyFolderError, type CloudCompanyFolderFile } from "@qorpera/runtime/cloud-company-folder-client";
import type { CloudCompanyPathControl, CloudCompanyPathRpc } from "@qorpera/runtime/cloud-company-path-gateway";
import { CloudCompanyFolderRpcError } from "@qorpera/runtime/cloud-company-path-refusal";
import { afterEach, expect, it, vi } from "vitest";
import { ObjectDependencyError } from "../../object-gateway/src/dependency.ts";
import { ObjectGatewayJournal } from "../../object-gateway/src/journal.ts";
import { FileSystemObjectStore, type ObjectWriteResult } from "../../object-gateway/src/object-store.ts";
import { ObjectGatewayReplication } from "../../object-gateway/src/replication.ts";
import { createObjectGatewayHandler } from "../../object-gateway/src/service.ts";
import { SupabaseObjectAuthority } from "../../object-gateway/src/supabase-authority.ts";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

/** The real object gateway and its NAS store, with the folder core's SQL (C1d-1a, tests 761 and 762) simulated: the
 * intents, the catalog, the proofs and the download rule, as the gateway and the control reach them. */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

interface Intent {
	actor: string;
	manifest: string;
	objects: Map<string, number>;
	/** Objects the actor could already read at open, and objects it put under this intent. */
	held: Set<string>;
	put: Set<string>;
	state: "open" | "sealed";
	/** On the adapter's clock: 15 minutes after open or renew. */
	expiresAt: number;
}

/** The NAS store, whose next puts or gets can meet a busy lane (503), as when two operations are in flight. */
class BusyObjectStore extends FileSystemObjectStore {
	busyPuts = 0;
	busyGets = 0;

	async put(profileId: string, sha256: string, bytes: Uint8Array): Promise<ObjectWriteResult> {
		if (this.busyPuts > 0) {
			this.busyPuts -= 1;
			throw new ObjectDependencyError(503);
		}
		return super.put(profileId, sha256, bytes);
	}

	async get(profileId: string, sha256: string, expectedBytes: number): Promise<Uint8Array> {
		if (this.busyGets > 0) {
			this.busyGets -= 1;
			throw new ObjectDependencyError(503);
		}
		return super.get(profileId, sha256, expectedBytes);
	}
}

/** `productionCircuit` keeps the gateway's own 5 s circuit cooldown; the other tests turn it off. */
async function fixture(options: { upperCaseBinding?: boolean; productionCircuit?: boolean } = {}) {
	const f = nativeToolAuthorityFixture();
	const environmentId = f.authority.identity.environmentId;
	const companyId = f.authority.identity.companyId;
	const token = randomBytes(32).toString("base64url");
	// G2-6a: the run's own lease, which the gateway's proof (answered below) accepts.
	const holder = `job.${f.binding.jobId.toLowerCase()}.${"h".repeat(43)}`;
	const root = await mkdtemp(join(tmpdir(), "qorpera-folder-bytes-test-"));
	await mkdir(join(root, "objects"), { mode: 0o700 });
	const actor = JSON.stringify({
		kind: "run",
		runId: f.binding.runId,
		jobId: f.binding.jobId,
		runnerId: f.binding.runnerId,
		assignmentId: f.binding.assignmentId,
	});
	const sql = {
		intents: new Map<string, Intent>(),
		catalog: new Map<string, number>(),
		/** Manifests an entry the run may read references. */
		readable: new Set<string>(),
		/** The company's work is stopped after the intent opened. */
		stopped: false,
		/** How many more of the gateway's folder calls meet a deadlock. */
		deadlocks: 0,
		/** How many more times the catalog loses an object put under this hash. */
		lose: new Map<string, number>(),
		/** The next confirms' PostgREST 500s, by SQLSTATE, one per confirm. */
		confirmFailures: [] as string[],
		/** When set, how many more download authorizations pass before the run's read is revoked. */
		downloadGrants: undefined as number | undefined,
		/** The company's storage allowance has no room: authorizing a new object is refused (23514, a 400). */
		full: false,
		/** The next authorization's 400: another SQLSTATE's body, or one that is not JSON. */
		badRequest: undefined as string | undefined,
		/** When set, fields renew answers with in place of its own. */
		renewAnswer: undefined as Record<string, unknown> | undefined,
		/** Objects folder GC holds (C1D §9.7): authorizing their upload is the conflict envelope, QRC01 409. */
		collecting: new Set<string>(),
	};
	const puts: string[] = [];
	/** The folder RPCs the gateway made, in order. */
	const gatewayCalls: string[] = [];
	let clock = 0;
	/** The download rule: the hash is a manifest an entry the run may read references, or one of its chunks. */
	const readable = (hash: string) =>
		[...sql.readable].some(
			(manifest) =>
				manifest === hash ||
				[...sql.intents.values()].some((intent) => sha(intent.manifest) === manifest && intent.objects.has(hash)),
		);
	// The gateway's Supabase: the folder core's per-object checks.
	const rpc = vi.fn<typeof fetch>(async (url, init) => {
		const request = new Request(url, init);
		const pathname = new URL(request.url).pathname;
		// Storage has no copy of a folder object until replication runs; the fixture never replicates.
		if (pathname.startsWith("/storage/v1/object/authenticated/")) return Response.json({}, { status: 404 });
		if (pathname.startsWith("/storage/")) return Response.json({});
		const method = pathname.split("/").at(-1)!;
		const args = (await request.json()) as Record<string, unknown>;
		if (method === "qorpera_list_profile_objects_for_migration") return Response.json([]);
		if (["qorpera_authorize_profile_object_replication", "qorpera_confirm_profile_object_replica"].includes(method))
			return Response.json(true);
		if (method === "qorpera_native_binding_proven")
			return args.p_holder === holder
				? Response.json(true)
				: Response.json({ code: "42501", message: "native binding proof is refused" }, { status: 403 });
		gatewayCalls.push(method);
		if (args.p_environment_id !== environmentId || JSON.stringify(args.p_actor) !== actor)
			return Response.json({ code: "42501" }, { status: 403 });
		// PostgREST answers the folder core's stop (55000) and its lock conflicts (40P01) with 500.
		if (sql.stopped) return Response.json({ code: "55000", message: "Company execution is paused" }, { status: 500 });
		if (sql.deadlocks > 0) {
			sql.deadlocks -= 1;
			return Response.json({ code: "40P01", message: "deadlock detected" }, { status: 500 });
		}
		if (method === "qorpera_folder_authorize_object_upload" || method === "qorpera_folder_confirm_object") {
			const intent = sql.intents.get(args.p_intent as string);
			if (
				!intent ||
				intent.state !== "open" ||
				intent.expiresAt <= clock ||
				intent.objects.get(args.p_sha256 as string) !== args.p_bytes
			)
				return Response.json({ code: "42501" }, { status: 403 });
			if (method === "qorpera_folder_authorize_object_upload") {
				if (sql.collecting.has(args.p_sha256 as string))
					return Response.json(
						{
							code: "QRC01",
							message: "Company folder object is being collected; retry",
							details: null,
							hint: null,
						},
						{ status: 409 },
					);
				if (sql.full && !sql.catalog.has(args.p_sha256 as string))
					return Response.json({ code: "23514", message: "company storage allowance exceeded" }, { status: 400 });
				if (sql.badRequest !== undefined) {
					const body = sql.badRequest;
					sql.badRequest = undefined;
					return new Response(body, { status: 400 });
				}
				return Response.json({ schema: "qorpera.folder-object-upload/v1", profileId: companyId });
			}
			const failure = sql.confirmFailures.shift();
			if (failure) return Response.json({ code: failure, message: "refused" }, { status: 500 });
			puts.push(args.p_sha256 as string);
			intent.put.add(args.p_sha256 as string);
			const losses = sql.lose.get(args.p_sha256 as string) ?? 0;
			if (losses > 0) sql.lose.set(args.p_sha256 as string, losses - 1);
			else sql.catalog.set(args.p_sha256 as string, args.p_bytes as number);
			return Response.json({
				schema: "qorpera.folder-object/v1",
				sha256: args.p_sha256,
				bytes: args.p_bytes,
				stored: true,
			});
		}
		if (method === "qorpera_folder_authorize_object_download") {
			const hash = args.p_sha256 as string;
			const bytes = sql.catalog.get(hash);
			if (sql.downloadGrants !== undefined) {
				if (sql.downloadGrants < 1) return Response.json({ code: "42501" }, { status: 403 });
				sql.downloadGrants -= 1;
			}
			if (!readable(hash) || bytes === undefined) return Response.json({ code: "42501" }, { status: 403 });
			return Response.json({ schema: "qorpera.folder-object-download/v1", profileId: companyId, bytes });
		}
		return Response.json({}, { status: 404 });
	});
	// The runtime's control: opening, sealing and renewing intents.
	const calls: { method: CloudCompanyPathRpc; args: Record<string, unknown> }[] = [];
	const control: CloudCompanyPathControl = {
		call: vi.fn(async (method: CloudCompanyPathRpc, args: Record<string, unknown>) => {
			calls.push({ method, args });
			expect(args.p_environment_id).toBe(environmentId);
			expect(JSON.stringify(args.p_actor)).toBe(actor);
			if (method === "qorpera_folder_open_upload") {
				const text = args.p_manifest as string;
				const manifest = JSON.parse(text) as { chunks: { sha256: string; bytes: number }[] };
				const objects = new Map(manifest.chunks.map((chunk) => [chunk.sha256, chunk.bytes] as const));
				objects.set(sha(text), Buffer.byteLength(text));
				const intentId = randomUUID();
				// Present: what the catalog has and the run may already read; the run puts every other object.
				const held = new Set([...objects.keys()].filter((hash) => sql.catalog.has(hash) && readable(hash)));
				sql.intents.set(intentId, {
					actor,
					manifest: text,
					objects,
					held,
					put: new Set(),
					state: "open",
					expiresAt: clock + 900_000,
				});
				return {
					schema: "qorpera.folder-upload/v1",
					intentId,
					manifestSha256: sha(text),
					expiresAt: new Date(Date.now() + 900_000).toISOString(),
					present: [...held].sort(),
				};
			}
			const intent = sql.intents.get(args.p_intent as string)!;
			if (intent.expiresAt <= clock) throw new Error("The intent lapsed");
			if (method === "qorpera_folder_renew_upload") {
				intent.expiresAt = clock + 900_000;
				return {
					schema: "qorpera.folder-upload-renew/v1",
					intentId: args.p_intent,
					state: intent.state,
					expiresAt: new Date(intent.expiresAt).toISOString(),
					...sql.renewAnswer,
				};
			}
			const missing = [...intent.objects.keys()]
				.filter((hash) => !(intent.held.has(hash) || intent.put.has(hash)) || !sql.catalog.has(hash))
				.sort();
			if (missing.length)
				return { schema: "qorpera.folder-seal/v1", state: "incomplete", intentId: args.p_intent, missing };
			intent.state = "sealed";
			const manifest = JSON.parse(intent.manifest) as CloudCompanyFolderFile & { chunks: unknown };
			return {
				schema: "qorpera.folder-seal/v1",
				state: "sealed",
				intentId: args.p_intent,
				file: {
					manifestSha256: sha(intent.manifest),
					fileSha256: manifest.fileSha256,
					bytes: manifest.bytes,
					mediaType: manifest.mediaType,
					executable: manifest.executable,
				},
			};
		}),
	};
	const authority = new SupabaseObjectAuthority({
		projectUrl: "https://cloud.test",
		publishableKey: "synthetic-public-key",
		secretKey: "synthetic-service-key",
		fetch: rpc,
		...(options.productionCircuit ? {} : { circuitCooldownMs: 0 }),
	});
	const store = new BusyObjectStore(join(root, "objects"));
	const replication = new ObjectGatewayReplication(new ObjectGatewayJournal(join(root, "journal")), store, authority);
	const server: Server = createServer(
		createObjectGatewayHandler({
			store,
			authority,
			replication,
			controlToken: "synthetic-cleanup",
			verifierToken: "synthetic-verifier",
			nativeObjects: { token, authority, folder: authority },
		}),
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing test server");
	const origin = `http://127.0.0.1:${address.port}`;
	cleanups.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	});
	/** Minutes each gateway request takes, on the adapter's clock. */
	let requestMinutes = 0;
	// Upper-case ids are the same run: the gateway and the adapter both send SQL the lower-case actor.
	const binding = options.upperCaseBinding
		? {
				...f.binding,
				runId: f.binding.runId.toUpperCase(),
				jobId: f.binding.jobId.toUpperCase(),
				runnerId: f.binding.runnerId.toUpperCase(),
				assignmentId: f.binding.assignmentId.toUpperCase(),
			}
		: f.binding;
	const bytes = new HttpCloudCompanyFolderBytes({
		baseUrl: origin,
		token,
		binding,
		holder: () => holder,
		identity: { ...f.authority.identity, runId: binding.runId, jobId: binding.jobId },
		control,
		now: () => clock,
		fetch: (input, init) => {
			clock += requestMinutes * 60_000;
			return fetch(input, init);
		},
	});
	return {
		...f,
		sql,
		calls,
		puts,
		bytes,
		companyId,
		root,
		origin,
		token,
		holder,
		authority,
		control,
		store,
		replication,
		gatewayCalls,
		environmentId,
		actor: JSON.parse(actor) as Record<string, string>,
		slowRequests(minutes: number) {
			requestMinutes = minutes;
		},
	};
}

it("stages a file's chunks and manifest under an intent, seals it, and reads it back", async () => {
	const { bytes, sql, calls, puts, gatewayCalls } = await fixture();
	// Nine MiB: three chunks, the last one short.
	const content = randomBytes(9 * 1024 * 1024);
	const reference = await bytes.put(content, "application/octet-stream", false, new AbortController().signal);
	const open = calls.find((call) => call.method === "qorpera_folder_open_upload")!;
	const manifest = JSON.parse(open.args.p_manifest as string);
	expect(Object.keys(manifest)).toEqual(["schema", "fileSha256", "bytes", "mediaType", "executable", "chunks"]);
	expect(manifest.chunks.map((chunk: { bytes: number }) => chunk.bytes)).toEqual([4194304, 4194304, 1048576]);
	expect(reference).toEqual({
		manifestSha256: sha(open.args.p_manifest as string),
		fileSha256: sha(content),
		bytes: content.byteLength,
		mediaType: "application/octet-stream",
	});
	expect(puts).toHaveLength(4);
	expect(calls.map((call) => call.method)).toEqual(["qorpera_folder_open_upload", "qorpera_folder_seal_upload"]);
	// Each put is authorized, authorized again inside the gateway's journal lane, and confirmed.
	expect(gatewayCalls).toEqual(
		Array.from({ length: 4 }, () => [
			"qorpera_folder_authorize_object_upload",
			"qorpera_folder_authorize_object_upload",
			"qorpera_folder_confirm_object",
		]).flat(),
	);
	sql.readable.add(reference.manifestSha256);
	const read = await bytes.get({ ...reference, executable: false }, new AbortController().signal);
	expect(Buffer.from(read).equals(content)).toBe(true);
});

it("reads a window of a file from only the chunks it falls in", async () => {
	const { bytes, sql, gatewayCalls } = await fixture();
	const content = randomBytes(9 * 1024 * 1024);
	const signal = new AbortController().signal;
	const reference = await bytes.put(content, "application/octet-stream", false, signal);
	sql.readable.add(reference.manifestSha256);
	const file = { ...reference, executable: false };
	// Each object is authorized twice: as the request comes in, and again inside the gateway's lane.
	const downloads = () =>
		gatewayCalls.filter((call) => call === "qorpera_folder_authorize_object_download").length / 2;
	// Across the first two chunks: the manifest and those two.
	let before = downloads();
	const across = await bytes.range(file, 4 * 1024 * 1024 - 2, 4, signal);
	expect(Buffer.from(across).equals(content.subarray(4 * 1024 * 1024 - 2, 4 * 1024 * 1024 + 2))).toBe(true);
	expect(downloads() - before).toBe(3);
	// Inside the last chunk, cut at the file's end: the manifest and that chunk.
	before = downloads();
	const tail = await bytes.range(file, content.byteLength - 3, 4096, signal);
	expect(Buffer.from(tail).equals(content.subarray(content.byteLength - 3))).toBe(true);
	expect(downloads() - before).toBe(2);
	// Past the end, nothing is fetched.
	before = downloads();
	expect((await bytes.range(file, content.byteLength, 4, signal)).byteLength).toBe(0);
	expect(downloads() - before).toBe(0);
	await expect(bytes.range(file, -1, 4, signal)).rejects.toThrow("Invalid Company folder byte range");
});

it("gives the same reference for the same file, putting only what the run may not already read", async () => {
	const { bytes, sql, puts } = await fixture();
	const signal = new AbortController().signal;
	const first = await bytes.put(Buffer.from("same text"), "text/markdown", false, signal);
	expect(puts).toHaveLength(2);
	// Stored but not yet readable (no entry references it): the run proves it has the bytes by putting them again.
	expect(await bytes.put(Buffer.from("same text"), "text/markdown", false, signal)).toEqual(first);
	expect(puts).toHaveLength(4);
	// Once an entry the run may read references it, nothing is put.
	sql.readable.add(first.manifestSha256);
	expect(await bytes.put(Buffer.from("same text"), "text/markdown", false, signal)).toEqual(first);
	expect(puts).toHaveLength(4);
	// Another bit or media type is another manifest over the same chunk.
	const executable = await bytes.put(Buffer.from("same text"), "text/markdown", true, signal);
	expect(executable.manifestSha256).not.toBe(first.manifestSha256);
	expect(executable.fileSha256).toBe(first.fileSha256);
	expect(puts).toHaveLength(5);
	// An empty file is its manifest alone.
	const empty = await bytes.put(new Uint8Array(0), "text/plain", false, signal);
	expect(empty).toMatchObject({ bytes: 0, fileSha256: sha("") });
});

it("puts an object the catalog lost once more before sealing, and gives up if it is lost again", async () => {
	const { bytes, sql, puts } = await fixture();
	const content = Buffer.from("lost once");
	sql.lose.set(sha(content), 1);
	await bytes.put(content, "text/plain", false, new AbortController().signal);
	expect(puts.filter((hash) => hash === sha(content))).toHaveLength(2);
	const again = Buffer.from("lost twice");
	sql.lose.set(sha(again), 2);
	await expect(bytes.put(again, "text/plain", false, new AbortController().signal)).rejects.toMatchObject({
		failure: "contended",
	});
	expect(puts.filter((hash) => hash === sha(again))).toHaveLength(2);
});

it("renews a long upload's intent before it lapses", async () => {
	const { bytes, sql, calls, slowRequests } = await fixture();
	// Four puts (three chunks and the manifest) of six minutes each: the third starts twelve minutes in, past the
	// ten-minute mark, so the intent is renewed once, before it.
	slowRequests(6);
	await bytes.put(randomBytes(9 * 1024 * 1024), "application/octet-stream", false, new AbortController().signal);
	expect(calls.map((call) => call.method)).toEqual([
		"qorpera_folder_open_upload",
		"qorpera_folder_renew_upload",
		"qorpera_folder_seal_upload",
	]);
	// A renew that does not answer for this open intent is not trusted.
	for (const answer of [{ state: "sealed" }, { intentId: randomUUID() }]) {
		sql.renewAnswer = answer;
		await expect(
			bytes.put(randomBytes(9 * 1024 * 1024), "application/octet-stream", false, new AbortController().signal),
		).rejects.toMatchObject({ category: "invalid_response" });
	}
});

it("refuses bytes it may not read, and bytes that are not the entry's", async () => {
	const { bytes, sql, root, companyId } = await fixture();
	const signal = new AbortController().signal;
	const reference = await bytes.put(Buffer.from("private"), "text/plain", false, signal);
	await expect(bytes.get({ ...reference, executable: false }, signal)).rejects.toBeInstanceOf(CloudCompanyFolderError);
	sql.readable.add(reference.manifestSha256);
	// A reference that says another media type than its manifest.
	await expect(bytes.get({ ...reference, mediaType: "text/markdown", executable: false }, signal)).rejects.toThrow(
		"Company folder response is invalid",
	);
	// Bytes changed on the NAS under their hash.
	await writeFile(join(root, "objects", companyId, sha("private")), "changed");
	await expect(bytes.get({ ...reference, executable: false }, signal)).rejects.toThrow();
});

it("stops when the company's work stops, without taking the gateway's database out for other companies", async () => {
	const { bytes, sql, authority } = await fixture();
	const signal = new AbortController().signal;
	const reference = await bytes.put(Buffer.from("before"), "text/plain", false, signal);
	sql.readable.add(reference.manifestSha256);
	sql.stopped = true;
	await expect(bytes.put(Buffer.from("x"), "text/plain", false, signal)).rejects.toMatchObject({ failure: "stopped" });
	await expect(bytes.get({ ...reference, executable: false }, signal)).rejects.toMatchObject({ failure: "stopped" });
	expect(authority.health().api.status).toBe("healthy");
	// A lock conflict is the run's to retry, not an outage either.
	sql.stopped = false;
	sql.deadlocks = 1;
	await expect(bytes.put(Buffer.from("y"), "text/plain", false, signal)).rejects.toMatchObject({
		failure: "contended",
	});
	expect(authority.health().api.status).toBe("healthy");
	expect(await bytes.put(Buffer.from("y"), "text/plain", false, signal)).toMatchObject({ fileSha256: sha("y") });
});

it("serves the folder route only on the native credential, with a run binding and an intent", async () => {
	const { origin, token, binding, sql, holder } = await fixture();
	const url = `${origin}/v1/folder-objects/${randomUUID()}/${sha("x")}`;
	const encoded = Buffer.from(JSON.stringify(binding)).toString("base64url");
	expect((await fetch(url, { method: "GET" })).status).toBe(401);
	expect((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status).toBe(400);
	expect(
		(
			await fetch(url, {
				method: "PUT",
				body: "x",
				headers: {
					authorization: `Bearer ${token}`,
					"x-qorpera-native-binding": encoded,
					"x-qorpera-identity": holder,
				},
			})
		).status,
	).toBe(400);
	expect(
		(
			await fetch(url, {
				method: "DELETE",
				headers: {
					authorization: `Bearer ${token}`,
					"x-qorpera-native-binding": encoded,
					"x-qorpera-identity": holder,
				},
			})
		).status,
	).toBe(405);
	expect(sql.intents.size).toBe(0);
});

it("writes the canonical manifest text the folder core checks", async () => {
	const { bytes, calls } = await fixture();
	const signal = new AbortController().signal;
	await bytes.put(new Uint8Array(0), "text/plain", false, signal);
	await bytes.put(Buffer.from("a"), "text/plain", true, signal);
	expect(
		calls.filter((call) => call.method === "qorpera_folder_open_upload").map((call) => call.args.p_manifest),
	).toEqual([
		`{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"${sha("")}","bytes":0,"mediaType":"text/plain","executable":false,"chunks":[]}`,
		`{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"${sha("a")}","bytes":1,"mediaType":"text/plain","executable":true,"chunks":[{"sha256":"${sha("a")}","bytes":1}]}`,
	]);
	// A file over one manifest's 256 MiB is refused before anything is hashed or sent.
	await expect(
		bytes.put({ byteLength: 64 * 4 * 1024 * 1024 + 1 } as unknown as Uint8Array, "text/plain", false, signal),
	).rejects.toMatchObject({ category: "invalid_arguments" });
	expect(calls).toHaveLength(4);
});

it("refuses a body that is not the object it names, before the folder core confirms it", async () => {
	const { origin, token, binding, control, environmentId, actor, gatewayCalls, puts, holder } = await fixture();
	const text = `{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"${sha("right")}","bytes":5,"mediaType":"text/plain","executable":false,"chunks":[{"sha256":"${sha("right")}","bytes":5}]}`;
	const open = (await control.call(
		"qorpera_folder_open_upload",
		{ p_environment_id: environmentId, p_actor: actor, p_manifest: text },
		new AbortController().signal,
	)) as { intentId: string };
	// Five bytes under the intent's five-byte object, but not its bytes.
	const response = await fetch(`${origin}/v1/folder-objects/${environmentId}/${sha("right")}`, {
		method: "PUT",
		body: "wrong",
		headers: {
			authorization: `Bearer ${token}`,
			"x-qorpera-native-binding": Buffer.from(JSON.stringify(binding)).toString("base64url"),
			"x-qorpera-identity": holder,
			"x-qorpera-upload-intent": open.intentId,
			"content-type": "application/octet-stream",
		},
	});
	expect(response.status).toBe(400);
	expect(gatewayCalls).toEqual(["qorpera_folder_authorize_object_upload"]);
	expect(puts).toEqual([]);
});

it("refuses a read whose authority is revoked while the gateway reads it", async () => {
	const { bytes, sql } = await fixture();
	const signal = new AbortController().signal;
	// An empty file is its manifest alone, so the read is one object: authorized, read, authorized again.
	const reference = await bytes.put(new Uint8Array(0), "text/plain", false, signal);
	sql.readable.add(reference.manifestSha256);
	// The first authorization passes; the one after the NAS read does not.
	sql.downloadGrants = 1;
	await expect(bytes.get({ ...reference, executable: false }, signal)).rejects.toMatchObject({
		failure: "unavailable",
	});
});

it("reads a stop, a lock conflict and a lock timeout at confirm as the run's", async () => {
	const { bytes, sql, authority, gatewayCalls } = await fixture();
	const signal = new AbortController().signal;
	sql.confirmFailures.push("55000");
	await expect(bytes.put(Buffer.from("s"), "text/plain", false, signal)).rejects.toMatchObject({ failure: "stopped" });
	for (const code of ["40001", "40P01", "55P03"]) {
		sql.confirmFailures.push(code);
		await expect(bytes.put(Buffer.from(code), "text/plain", false, signal)).rejects.toMatchObject({
			failure: "contended",
		});
	}
	expect(authority.health().api.status).toBe("healthy");
	expect(gatewayCalls.filter((method) => method === "qorpera_folder_confirm_object")).toHaveLength(4);
});

it("reads an object folder GC holds as contended, at the control and at the gateway", async () => {
	const { bytes, sql, control, authority } = await fixture();
	const signal = new AbortController().signal;
	// Open (or seal) refuses a present object GC holds with the conflict envelope; the writer asks again later.
	vi.mocked(control.call).mockRejectedValueOnce(
		new CloudCompanyFolderRpcError("QRC01", "Company folder object is being collected; retry"),
	);
	await expect(bytes.put(Buffer.from("held"), "text/plain", false, signal)).rejects.toMatchObject({
		failure: "contended",
	});
	// The gateway passes the 409 on, and the database circuit stays closed.
	sql.collecting.add(sha("held"));
	await expect(bytes.put(Buffer.from("held"), "text/plain", false, signal)).rejects.toMatchObject({
		failure: "contended",
	});
	expect(authority.health().api.status).toBe("healthy");
	sql.collecting.clear();
	await expect(bytes.put(Buffer.from("held"), "text/plain", false, signal)).resolves.toMatchObject({
		fileSha256: sha("held"),
	});
});

it("fails fast on any other database 500, which opens the gateway's circuit", async () => {
	const { bytes, sql, authority, gatewayCalls } = await fixture({ productionCircuit: true });
	// A statement timeout is the database's: the gateway answers 503, and the adapter's two more tries meet the open
	// circuit (5 s) without reaching the database again.
	sql.confirmFailures.push("57014");
	await expect(
		bytes.put(Buffer.from("timeout"), "text/plain", false, new AbortController().signal),
	).rejects.toMatchObject({ category: "transport_unavailable" });
	expect(gatewayCalls).toEqual([
		"qorpera_folder_authorize_object_upload",
		"qorpera_folder_authorize_object_upload",
		"qorpera_folder_confirm_object",
	]);
	expect(authority.health().api.status).toBe("unavailable");
});

it("rides out a busy NAS lane on put and on read, twice at most", async () => {
	const { bytes, sql, store, replication } = await fixture();
	const signal = new AbortController().signal;
	store.busyPuts = 2;
	const reference = await bytes.put(Buffer.from("busy lane"), "text/plain", false, signal);
	expect((await replication.status()).blocked).toBe(0);
	sql.readable.add(reference.manifestSha256);
	// Right after staging Storage has no copy, so a busy lane is the gateway's 503, asked again, not Storage's miss.
	store.busyGets = 2;
	expect(Buffer.from(await bytes.get({ ...reference, executable: false }, signal)).toString()).toBe("busy lane");
	store.busyPuts = 3;
	await expect(bytes.put(Buffer.from("still busy"), "text/plain", false, signal)).rejects.toMatchObject({
		category: "transport_unavailable",
	});
	store.busyGets = 3;
	await expect(bytes.get({ ...reference, executable: false }, signal)).rejects.toMatchObject({
		category: "transport_unavailable",
	});
});

it("does not ask again for an object that is on neither the NAS nor Storage", async () => {
	const { bytes, sql, gatewayCalls } = await fixture();
	// Catalogued and readable, but its bytes are nowhere: Storage's 404, once.
	const text = `{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"${sha("")}","bytes":0,"mediaType":"text/plain","executable":false,"chunks":[]}`;
	sql.catalog.set(sha(text), Buffer.byteLength(text));
	sql.readable.add(sha(text));
	await expect(
		bytes.get(
			{ manifestSha256: sha(text), fileSha256: sha(""), bytes: 0, mediaType: "text/plain", executable: false },
			new AbortController().signal,
		),
	).rejects.toMatchObject({ category: "transport_unavailable" });
	expect(gatewayCalls).toEqual(["qorpera_folder_authorize_object_download"]);
});

it("checks the whole file against its reference, not only each chunk against its hash", async () => {
	const { bytes, sql, store, companyId, gatewayCalls } = await fixture();
	// A manifest whose chunks are real but whose fileSha256 is not theirs.
	const text = `{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"${sha("claims")}","bytes":6,"mediaType":"text/plain","executable":false,"chunks":[{"sha256":"${sha("actual")}","bytes":6}]}`;
	for (const object of ["actual", text]) {
		await store.put(companyId, sha(object), Buffer.from(object));
		sql.catalog.set(sha(object), Buffer.byteLength(object));
	}
	// Readable as an entry's manifest and chunk (the fixture finds chunks through staged intents; this one was not).
	sql.readable.add(sha(text));
	sql.readable.add(sha("actual"));
	await expect(
		bytes.get(
			{ manifestSha256: sha(text), fileSha256: sha("claims"), bytes: 6, mediaType: "text/plain", executable: false },
			new AbortController().signal,
		),
	).rejects.toThrow("Company folder bytes do not match their entry");
	// A manifest whose chunk sizes do not add up to its file's is refused before any chunk is fetched.
	const short = `{"schema":"qorpera.cloud-file-manifest/v2","fileSha256":"${sha("actual")}","bytes":7,"mediaType":"text/plain","executable":false,"chunks":[{"sha256":"${sha("actual")}","bytes":6}]}`;
	await store.put(companyId, sha(short), Buffer.from(short));
	sql.catalog.set(sha(short), Buffer.byteLength(short));
	sql.readable.add(sha(short));
	gatewayCalls.length = 0;
	await expect(
		bytes.get(
			{
				manifestSha256: sha(short),
				fileSha256: sha("actual"),
				bytes: 7,
				mediaType: "text/plain",
				executable: false,
			},
			new AbortController().signal,
		),
	).rejects.toThrow("Company folder response is invalid");
	expect(gatewayCalls).toEqual([
		"qorpera_folder_authorize_object_download",
		"qorpera_folder_authorize_object_download",
	]);
});

it("sends the folder core the lower-case run for a binding with upper-case ids", async () => {
	const { bytes, sql } = await fixture({ upperCaseBinding: true });
	const signal = new AbortController().signal;
	const reference = await bytes.put(Buffer.from("upper"), "text/plain", false, signal);
	sql.readable.add(reference.manifestSha256);
	expect(Buffer.from(await bytes.get({ ...reference, executable: false }, signal)).toString()).toBe("upper");
});

it("reports a full company before any byte is written", async () => {
	const { bytes, sql, root, companyId, gatewayCalls, authority } = await fixture();
	const signal = new AbortController().signal;
	const stored = await bytes.put(Buffer.from("stored before"), "text/plain", false, signal);
	sql.readable.add(stored.manifestSha256);
	sql.full = true;
	gatewayCalls.length = 0;
	await expect(bytes.put(Buffer.from("no room"), "text/plain", false, signal)).rejects.toMatchObject({
		failure: "full",
		category: "budget_exhausted",
	});
	expect(gatewayCalls).toEqual(["qorpera_folder_authorize_object_upload"]);
	expect(existsSync(join(root, "objects", companyId, sha("no room")))).toBe(false);
	expect(authority.health().api.status).toBe("healthy");
	// Bytes the company already holds cost nothing more.
	expect(await bytes.put(Buffer.from("stored before"), "text/plain", false, signal)).toEqual(stored);
});

it("keeps any other refusal's 400, which never opens the gateway's circuit", async () => {
	const { bytes, sql, authority } = await fixture();
	const signal = new AbortController().signal;
	for (const body of [JSON.stringify({ code: "22023", message: "invalid" }), "not json"]) {
		sql.badRequest = body;
		await expect(bytes.put(Buffer.from(`refused ${body.length}`), "text/plain", false, signal)).rejects.toMatchObject(
			{
				category: "transport_unavailable",
			},
		);
		expect(authority.health().api.status).toBe("healthy");
	}
});
