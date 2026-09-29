import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpCloudCompanyFolderBytes } from "@qorpera/runtime/cloud-company-folder-bytes";
import { CloudCompanyFolderError, type CloudCompanyFolderFile } from "@qorpera/runtime/cloud-company-folder-client";
import type { CloudCompanyPathControl, CloudCompanyPathRpc } from "@qorpera/runtime/cloud-company-path-gateway";
import { afterEach, expect, it, vi } from "vitest";
import { ObjectGatewayJournal } from "../../object-gateway/src/journal.ts";
import { FileSystemObjectStore } from "../../object-gateway/src/object-store.ts";
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
}

async function fixture() {
	const f = nativeToolAuthorityFixture();
	const environmentId = f.authority.identity.environmentId;
	const companyId = f.authority.identity.companyId;
	const token = randomBytes(32).toString("base64url");
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
		stopped: false,
		/** How many more times the catalog loses an object put under this hash. */
		lose: new Map<string, number>(),
	};
	const puts: string[] = [];
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
		if (pathname.startsWith("/storage/")) return Response.json({});
		const method = pathname.split("/").at(-1)!;
		const args = (await request.json()) as Record<string, unknown>;
		if (method === "qorpera_list_profile_objects_for_migration") return Response.json([]);
		if (["qorpera_authorize_profile_object_replication", "qorpera_confirm_profile_object_replica"].includes(method))
			return Response.json(true);
		if (args.p_environment_id !== environmentId || JSON.stringify(args.p_actor) !== actor || sql.stopped)
			return Response.json({ code: "42501" }, { status: 403 });
		if (method === "qorpera_folder_authorize_object_upload" || method === "qorpera_folder_confirm_object") {
			const intent = sql.intents.get(args.p_intent as string);
			if (!intent || intent.state !== "open" || intent.objects.get(args.p_sha256 as string) !== args.p_bytes)
				return Response.json({ code: "42501" }, { status: 403 });
			if (method === "qorpera_folder_authorize_object_upload")
				return Response.json({ schema: "qorpera.folder-object-upload/v1", profileId: companyId });
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
				sql.intents.set(intentId, { actor, manifest: text, objects, held, put: new Set(), state: "open" });
				return {
					schema: "qorpera.folder-upload/v1",
					intentId,
					manifestSha256: sha(text),
					expiresAt: new Date(Date.now() + 900_000).toISOString(),
					present: [...held].sort(),
				};
			}
			const intent = sql.intents.get(args.p_intent as string)!;
			if (method === "qorpera_folder_renew_upload")
				return {
					schema: "qorpera.folder-upload-renew/v1",
					intentId: args.p_intent,
					state: intent.state,
					expiresAt: "later",
				};
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
		circuitCooldownMs: 0,
	});
	const store = new FileSystemObjectStore(join(root, "objects"));
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
	let clock = 0;
	/** Minutes each gateway request takes, on the adapter's clock. */
	let requestMinutes = 0;
	const bytes = new HttpCloudCompanyFolderBytes({
		baseUrl: origin,
		token,
		binding: f.binding,
		identity: f.authority.identity,
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
		slowRequests(minutes: number) {
			requestMinutes = minutes;
		},
	};
}

it("stages a file's chunks and manifest under an intent, seals it, and reads it back", async () => {
	const { bytes, sql, calls, puts } = await fixture();
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
	sql.readable.add(reference.manifestSha256);
	const read = await bytes.get({ ...reference, executable: false }, new AbortController().signal);
	expect(Buffer.from(read).equals(content)).toBe(true);
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
	const { bytes, calls, slowRequests } = await fixture();
	// Four puts (three chunks and the manifest) of six minutes each: the third starts twelve minutes in, past the
	// ten-minute mark, so the intent is renewed once, before it.
	slowRequests(6);
	await bytes.put(randomBytes(9 * 1024 * 1024), "application/octet-stream", false, new AbortController().signal);
	expect(calls.map((call) => call.method)).toEqual([
		"qorpera_folder_open_upload",
		"qorpera_folder_renew_upload",
		"qorpera_folder_seal_upload",
	]);
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

it("stops when the folder core refuses the run", async () => {
	const { bytes, sql } = await fixture();
	sql.stopped = true;
	await expect(bytes.put(Buffer.from("x"), "text/plain", false, new AbortController().signal)).rejects.toBeInstanceOf(
		CloudCompanyFolderError,
	);
});

it("serves the folder route only on the native credential, with a run binding and an intent", async () => {
	const { origin, token, binding, sql } = await fixture();
	const url = `${origin}/v1/folder-objects/${randomUUID()}/${sha("x")}`;
	const encoded = Buffer.from(JSON.stringify(binding)).toString("base64url");
	expect((await fetch(url, { method: "GET" })).status).toBe(401);
	expect((await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status).toBe(400);
	expect(
		(
			await fetch(url, {
				method: "PUT",
				body: "x",
				headers: { authorization: `Bearer ${token}`, "x-qorpera-native-binding": encoded },
			})
		).status,
	).toBe(400);
	expect(
		(
			await fetch(url, {
				method: "DELETE",
				headers: { authorization: `Bearer ${token}`, "x-qorpera-native-binding": encoded },
			})
		).status,
	).toBe(405);
	expect(sql.intents.size).toBe(0);
});
