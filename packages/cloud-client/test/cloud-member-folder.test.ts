import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	CLOUD_MEMBER_FOLDER_PAGE,
	CLOUD_MEMBER_FOLDER_READ_MANY,
	CloudMemberFolderAccessDenied,
	CloudMemberFolderClient,
	CloudMemberFolderFileCache,
	CloudMemberFolderHints,
	cloudMemberFolderHintTopic,
	parseCloudMemberCompanyStateFolders,
	parseCloudMemberFolderBy,
	parseCloudMemberFolderChanges,
	parseCloudMemberFolderCommit,
	parseCloudMemberFolderHint,
	parseCloudMemberFolderHistory,
	parseCloudMemberFolderList,
	parseCloudMemberFolderPathHistory,
	parseCloudMemberFolderRead,
} from "../src/cloud-member-folder.ts";

const env = "63000000-0000-4000-8000-000000000020";
const member = "63000000-0000-4000-8000-000000000001";
const version = "63000000-0000-4000-8000-0000000000a1";
const version2 = "63000000-0000-4000-8000-0000000000a2";
const at = "2026-10-03T09:12:33.123456+00:00";
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const fileFields = {
	manifestSha256: "a".repeat(64),
	fileSha256: "b".repeat(64),
	bytes: 5,
	mediaType: "text/plain",
	executable: false,
};

// The shapes test 834 pins on the real SQL.
describe("member folder answers", () => {
	it("reads an entry, a folder and an absent path", () => {
		const read = parseCloudMemberFolderRead({
			schema: "qorpera.folder-read/v1",
			asOfSeq: 9,
			found: true,
			entry: { path: "notes/a.txt", kind: "file", version, seq: 4, updatedAt: at, ...fileFields },
		});
		expect(read.entry?.file?.mediaType).toBe("text/plain");
		expect(
			parseCloudMemberFolderRead({
				schema: "qorpera.folder-read/v1",
				asOfSeq: 9,
				found: true,
				entry: { path: "notes", kind: "folder", version, seq: 1, updatedAt: at },
			}).entry?.file,
		).toBeNull();
		expect(
			parseCloudMemberFolderRead({ schema: "qorpera.folder-read/v1", asOfSeq: 9, found: false, entry: null }),
		).toEqual({ asOfSeq: 9, entry: null });
		expect(() =>
			parseCloudMemberFolderRead({ schema: "qorpera.folder-read/v1", asOfSeq: 9, found: false }),
		).toThrow();
	});

	it("refuses an entry with a field it does not know, a folder with content, or half of the content", () => {
		const entry = { path: "notes/a.txt", kind: "file", version, seq: 4, updatedAt: at, ...fileFields };
		for (const bad of [
			{ ...entry, authority: {} },
			{ ...entry, kind: "folder" },
			{ path: "notes/a.txt", kind: "file", version, seq: 4, updatedAt: at, bytes: 5 },
			{ ...entry, seq: -1 },
			{ ...entry, seq: 0 },
			{ ...entry, mediaType: "Text/Plain" },
		])
			expect(() =>
				parseCloudMemberFolderRead({ schema: "qorpera.folder-read/v1", asOfSeq: 9, found: true, entry: bad }),
			).toThrow("Invalid company folder entry");
		expect(() => parseCloudMemberFolderRead({ schema: "qorpera.folder-read/v1", asOfSeq: 9, found: true })).toThrow();
	});

	it("reads a link with the target it holds, and refuses a target out of the core's bounds or on another kind", () => {
		const read = (entry: unknown) =>
			parseCloudMemberFolderRead({ schema: "qorpera.folder-read/v1", asOfSeq: 9, found: true, entry }).entry;
		const bare = { path: "docs/latest", kind: "symlink", version, seq: 5, updatedAt: at };
		const link = { ...bare, target: "../q3 plan.md" };
		expect(read(link)).toEqual({ ...link, file: null });
		// The bound is 4,095 bytes, not characters.
		expect(read({ ...link, target: `${"é".repeat(2047)}x` })?.target).toHaveLength(2048);
		expect(read({ path: "notes", kind: "folder", version, seq: 1, updatedAt: at })?.target).toBeNull();
		const listed = parseCloudMemberFolderList(
			{ schema: "qorpera.folder-list/v1", asOfSeq: 3, entries: [link], next: null },
			2,
		);
		expect(listed.entries[0]?.target).toBe("../q3 plan.md");
		for (const bad of [
			bare,
			{ ...link, target: "" },
			{ ...link, target: "é".repeat(2048) },
			{ ...link, target: 7 },
			{ ...link, ...fileFields },
			{ path: "notes", kind: "folder", version, seq: 1, updatedAt: at, target: "a" },
			{ path: "notes/a.txt", kind: "file", version, seq: 4, updatedAt: at, ...fileFields, target: "a" },
		])
			expect(() => read(bad)).toThrow("Invalid company folder entry");
	});

	it("pages a listing only when it is full, from its last path", () => {
		const entries = ["a", "b"].map((name) => ({ path: name, kind: "folder", version, seq: 1, updatedAt: at }));
		expect(
			parseCloudMemberFolderList({ schema: "qorpera.folder-list/v1", asOfSeq: 3, entries, next: "b" }, 2).next,
		).toBe("b");
		expect(() =>
			parseCloudMemberFolderList({ schema: "qorpera.folder-list/v1", asOfSeq: 3, entries, next: "a" }, 2),
		).toThrow();
		expect(() =>
			parseCloudMemberFolderList({ schema: "qorpera.folder-list/v1", asOfSeq: 3, entries, next: null }, 2),
		).toThrow();
		expect(
			parseCloudMemberFolderList({ schema: "qorpera.folder-list/v1", asOfSeq: 3, entries, next: null }, 3).entries,
		).toHaveLength(2);
	});

	it("reads a path's versions: writes, moves, deletes and folders", () => {
		const page = parseCloudMemberFolderPathHistory(
			{
				schema: "qorpera.folder-path-history/v1",
				asOfSeq: 11,
				items: [
					{
						version,
						seq: 8,
						op: "delete",
						kind: "file",
						path: "papers/a.txt",
						at,
						by: { kind: "member", userId: member },
					},
					{
						version: version2,
						seq: 5,
						op: "move_in",
						kind: "file",
						path: "papers/a.txt",
						at,
						by: { kind: "platform" },
						from: "docs/a.txt",
						...fileFields,
					},
				],
				next: version2,
			},
			2,
		);
		expect(page.items.map((item) => [item.op, item.from, item.to, item.file === null])).toEqual([
			["delete", null, null, true],
			["move_in", "docs/a.txt", null, false],
		]);
		expect(page.next).toBe(version2);
		expect(() =>
			parseCloudMemberFolderPathHistory(
				{
					schema: "qorpera.folder-path-history/v1",
					asOfSeq: 11,
					items: [
						{ version, seq: 2, op: "write", kind: "file", path: "a", at, by: { kind: "platform" }, to: "b" },
					],
					next: null,
				},
				10,
			),
		).toThrow("Invalid company folder version");
	});

	it("reads the change sets newest first, with at most 20 paths each", () => {
		const history = parseCloudMemberFolderHistory({
			schema: "qorpera.folder-history/v1",
			asOfSeq: 12,
			items: [
				{
					seq: 12,
					at,
					by: { kind: "platform" },
					paths: [{ path: "wide", op: "mkdir", kind: "folder", version }],
					more: true,
				},
				{
					seq: 10,
					at,
					by: { kind: "member", userId: member },
					paths: [{ path: "n", op: "write", kind: "file", version }],
					more: false,
				},
			],
			next: 10,
		});
		expect(history.items.map((item) => item.seq)).toEqual([12, 10]);
		const out = { schema: "qorpera.folder-history/v1", asOfSeq: 12, next: null };
		expect(() =>
			parseCloudMemberFolderHistory({
				...out,
				items: [
					{
						seq: 10,
						at,
						by: { kind: "platform" },
						paths: [{ path: "a", op: "write", kind: "file", version }],
						more: false,
					},
					{
						seq: 12,
						at,
						by: { kind: "platform" },
						paths: [{ path: "a", op: "write", kind: "file", version }],
						more: false,
					},
				],
			}),
		).toThrow("Invalid company folder history");
		expect(() =>
			parseCloudMemberFolderHistory({
				...out,
				items: [{ seq: 10, at, by: { kind: "platform" }, paths: [], more: false }],
			}),
		).toThrow();
	});

	it("reads the feed's change sets with their authors, and authority rows as they are", () => {
		const page = parseCloudMemberFolderChanges({
			schema: "qorpera.folder-feed/v1",
			asOfSeq: 8,
			resync: false,
			events: [
				{ seq: 7, kind: "authority" },
				{
					seq: 8,
					kind: "change_set",
					commitId: version,
					at,
					by: { kind: "member", userId: member },
					changes: [{ unitNo: 1, op: "delete", kind: "file", path: "papers/a.txt", version: version2 }],
				},
			],
			next: { afterSeq: 8, cursor: null },
			more: false,
		});
		expect(page.events.map((event) => event.kind)).toEqual(["authority", "change_set"]);
		expect(() =>
			parseCloudMemberFolderChanges({
				schema: "qorpera.folder-feed/v1",
				asOfSeq: 8,
				resync: false,
				events: [{ seq: 7, kind: "authority", by: { kind: "platform" } }],
				next: { afterSeq: 8, cursor: null },
				more: false,
			}),
		).toThrow("Invalid company folder feed event");
		for (const bad of [
			{ next: null },
			{
				events: [
					{
						seq: 8,
						kind: "change_set",
						commitId: version,
						at,
						by: { kind: "platform" },
						changes: [{ unitNo: 1, op: "mkdir", kind: "folder", path: "a", version, ...fileFields }],
					},
				],
			},
		])
			expect(() =>
				parseCloudMemberFolderChanges({
					schema: "qorpera.folder-feed/v1",
					asOfSeq: 8,
					resync: false,
					events: [],
					next: { afterSeq: 8, cursor: null },
					more: false,
					...bad,
				}),
			).toThrow();
		expect(
			parseCloudMemberFolderChanges({
				schema: "qorpera.folder-feed/v1",
				asOfSeq: 8,
				resync: true,
				events: [],
				next: null,
				more: false,
			}).resync,
		).toBe(true);
	});

	it("reads a link's versions and changes with the target each holds, and a link's delete without one", () => {
		const version3 = "63000000-0000-4000-8000-0000000000a3";
		const path = "docs/latest";
		const by = { kind: "member", userId: member };
		const deleted = { version, seq: 9, op: "delete", kind: "symlink", path, at, by };
		const linked = { version: version2, seq: 7, op: "write", kind: "symlink", path, at, by, target: "a.md" };
		const written = { version: version3, seq: 4, op: "write", kind: "file", path, at, by, ...fileFields };
		const history = (items: unknown[]) =>
			parseCloudMemberFolderPathHistory(
				{ schema: "qorpera.folder-path-history/v1", asOfSeq: 9, items, next: null },
				10,
			);
		const versions = history([deleted, linked, written]).items;
		expect(versions.map((item) => [item.op, item.kind, item.target, item.file === null])).toEqual([
			["delete", "symlink", null, true],
			["write", "symlink", "a.md", true],
			["write", "file", null, false],
		]);
		for (const bad of [
			{ ...deleted, target: "a.md" },
			{ version: version2, seq: 7, op: "write", kind: "symlink", path, at, by },
			{ ...linked, ...fileFields },
			{ ...written, target: "a.md" },
		])
			expect(() => history([bad])).toThrow("Invalid company folder version");
		const sets = parseCloudMemberFolderHistory({
			schema: "qorpera.folder-history/v1",
			asOfSeq: 9,
			items: [{ seq: 7, at, by, paths: [{ path, op: "write", kind: "symlink", version: version2 }], more: false }],
			next: null,
		});
		expect(sets.items[0]?.paths[0]?.kind).toBe("symlink");
		const feed = (changes: unknown[]) =>
			parseCloudMemberFolderChanges({
				schema: "qorpera.folder-feed/v1",
				asOfSeq: 9,
				resync: false,
				events: [{ seq: 9, kind: "change_set", commitId: version, at, by, changes }],
				next: { afterSeq: 9, cursor: null },
				more: false,
			});
		const moved = { unitNo: 1, op: "move_in", kind: "symlink", path, version: version2, target: "a.md" };
		const gone = { unitNo: 2, op: "delete", kind: "symlink", path: "docs/old", version };
		expect(feed([moved, gone]).events[0]).toMatchObject({
			changes: [
				{ op: "move_in", kind: "symlink", target: "a.md", file: null },
				{ op: "delete", kind: "symlink", target: null, file: null },
			],
		});
		for (const bad of [
			{ ...gone, target: "a.md" },
			{ unitNo: 1, op: "write", kind: "symlink", path, version: version2 },
			{ ...moved, target: "x".repeat(4096) },
			{ ...moved, ...fileFields },
			{ unitNo: 1, op: "write", kind: "file", path, version: version2, ...fileFields, target: "a.md" },
		])
			expect(() => feed([bad])).toThrow("Invalid company folder feed change");
	});

	it("names an author exactly", () => {
		expect(parseCloudMemberFolderBy({ kind: "agent", staffAgentId: version })).toEqual({
			kind: "agent",
			staffAgentId: version,
		});
		for (const bad of [
			{ kind: "agent", staffAgentId: version, requesterUserId: member },
			{ kind: "platform", userId: member },
			{ kind: "run" },
		])
			expect(() => parseCloudMemberFolderBy(bad)).toThrow("Invalid company folder author");
	});
});

function client(
	responder: (url: URL, init: RequestInit) => Response | Promise<Response>,
	files?: CloudMemberFolderFileCache,
) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	return {
		calls,
		folder: new CloudMemberFolderClient({
			...(files ? { files } : {}),
			environmentId: env,
			supabaseUrl: "https://cloud.test/",
			objectGatewayUrl: "https://objects.test/",
			publishableKey: "sb_publishable_fixture",
			accessToken: async () => "member-token",
			fetch: async (input, init) => {
				calls.push({ url: String(input), init: init ?? {} });
				return responder(new URL(String(input)), init ?? {});
			},
		}),
	};
}

function objects(store: Map<string, Uint8Array>, mode = "live-path-authority") {
	return (url: URL) => {
		const bytes = store.get(url.pathname.split("/").at(-1)!);
		if (!bytes) return new Response(null, { status: 403 });
		return new Response(Uint8Array.from(bytes), {
			headers: { "x-qorpera-access-mode": mode, "content-length": String(bytes.length) },
		});
	};
}

/** A file cut into chunks of the given sizes (the whole by default), with a manifest that may say otherwise. */
function stored(content: string, sizes?: number[], manifestOverride: Record<string, unknown> = {}) {
	const bytes = new TextEncoder().encode(content);
	const store = new Map<string, Uint8Array>();
	const chunks: { sha256: string; bytes: number }[] = [];
	let offset = 0;
	for (const size of sizes ?? (bytes.length ? [bytes.length] : [])) {
		const chunk = bytes.subarray(offset, offset + size);
		store.set(sha(chunk), chunk);
		chunks.push({ sha256: sha(chunk), bytes: chunk.length });
		offset += size;
	}
	const manifest = new TextEncoder().encode(
		JSON.stringify({
			schema: "qorpera.cloud-file-manifest/v2",
			fileSha256: sha(bytes),
			bytes: bytes.length,
			mediaType: "text/plain",
			executable: false,
			chunks,
			...manifestOverride,
		}),
	);
	store.set(sha(manifest), manifest);
	return {
		store,
		file: {
			manifestSha256: sha(manifest),
			fileSha256: sha(bytes),
			bytes: bytes.length,
			mediaType: "text/plain",
			executable: false,
		},
	};
}

describe("the member folder client", () => {
	it("calls the member functions with the member's own token and the environment", async () => {
		const { folder, calls } = client(() =>
			Response.json({ schema: "qorpera.folder-read/v1", asOfSeq: 0, found: false, entry: null }),
		);
		await folder.read("notes/a.txt", new AbortController().signal);
		expect(calls[0]!.url).toBe("https://cloud.test/rest/v1/rpc/qorpera_member_folder_read");
		expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer member-token");
		expect(new Headers(calls[0]!.init.headers).get("apikey")).toBe("sb_publishable_fixture");
		expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ p_environment_id: env, p_path: "notes/a.txt" });
		// With "no-store" Chrome sends the CORS preflight again on every call; no browser stores a POST's answer anyway.
		expect(new Request(calls[0]!.url, calls[0]!.init).cache).toBe("default");
		expect(() => folder.list(null, null, 0, new AbortController().signal)).toThrow();
		expect(() => folder.pathHistory("a", "not-a-version", 10, new AbortController().signal)).toThrow();
	});

	it("reads several paths in one call, each as its own read answers, and refuses an answer of the wrong length", async () => {
		const read = (found: boolean) =>
			found
				? {
						schema: "qorpera.folder-read/v1",
						asOfSeq: 4,
						found: true,
						entry: { path: "apps/a/index.html", kind: "folder", version, seq: 3, updatedAt: at },
					}
				: { schema: "qorpera.folder-read/v1", asOfSeq: 4, found: false, entry: null };
		const { folder, calls } = client(() =>
			Response.json({ schema: "qorpera.folder-read-many/v1", reads: [read(true), read(false)] }),
		);
		const reads = await folder.readMany(["apps/a/index.html", "apps/a/gone.png"], new AbortController().signal);
		expect(calls[0]!.url).toBe("https://cloud.test/rest/v1/rpc/qorpera_member_folder_read_many");
		expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
			p_environment_id: env,
			p_paths: ["apps/a/index.html", "apps/a/gone.png"],
		});
		expect(reads.map((one) => one.entry?.path ?? null)).toEqual(["apps/a/index.html", null]);
		await expect(folder.readMany(["apps/a/index.html"], new AbortController().signal)).rejects.toThrow(
			"Invalid company folder reads",
		);
		expect(() => folder.readMany([], new AbortController().signal)).toThrow("Invalid company folder reads");
		expect(() =>
			folder.readMany(
				Array.from({ length: CLOUD_MEMBER_FOLDER_READ_MANY + 1 }, (_, index) => `f${index}`),
				new AbortController().signal,
			),
		).toThrow("Invalid company folder reads");
		// A database without the call answers 404: the caller reads each path alone.
		const missing = client(() => new Response(null, { status: 404 }));
		await expect(missing.folder.readMany(["a"], new AbortController().signal)).rejects.toMatchObject({ status: 404 });
	});

	it("reads a page of 200 links with the longest paths and targets, each character escaped at worst", async () => {
		const target = "\u0001".repeat(4095);
		const entries = Array.from({ length: CLOUD_MEMBER_FOLDER_PAGE }, (_, index) => ({
			path: `${String(index).padStart(3, "0")}${'"'.repeat(4093)}`,
			kind: "symlink",
			version,
			seq: index + 1,
			updatedAt: at,
			target,
		}));
		const listing = { schema: "qorpera.folder-list/v1", asOfSeq: 200, entries, next: entries.at(-1)!.path };
		const changes = entries.map(({ path }, index) => ({
			unitNo: index + 1,
			op: "write",
			kind: "symlink",
			path,
			version,
			target,
		}));
		const by = { kind: "member", userId: member };
		const feed = {
			schema: "qorpera.folder-feed/v1",
			asOfSeq: 201,
			resync: false,
			events: [{ seq: 201, kind: "change_set", commitId: version2, at, by, changes }],
			next: { afterSeq: 201, cursor: null },
			more: false,
		};
		for (const answer of [listing, feed])
			expect(Buffer.byteLength(JSON.stringify(answer))).toBeGreaterThan(6_500_000);
		const { folder } = client((url) => Response.json(url.pathname.endsWith("_list") ? listing : feed));
		const signal = new AbortController().signal;
		const page = await folder.list(null, null, CLOUD_MEMBER_FOLDER_PAGE, signal);
		expect(page.entries.map((entry) => entry.target)).toEqual(entries.map(() => target));
		expect(page.next).toBe(entries.at(-1)!.path);
		const changed = await folder.changes({ afterSeq: 0, cursor: null }, CLOUD_MEMBER_FOLDER_PAGE, signal);
		expect(changed.events.flatMap((event) => (event.kind === "change_set" ? event.changes : []))).toHaveLength(200);
		// A larger page could pass the answer's bound.
		expect(() => folder.list(null, null, CLOUD_MEMBER_FOLDER_PAGE + 1, signal)).toThrow(
			"Invalid company folder listing",
		);
		expect(() => folder.changes({ afterSeq: 0, cursor: null }, CLOUD_MEMBER_FOLDER_PAGE + 1, signal)).toThrow(
			"Invalid company folder feed position",
		);
	});

	it("reads a file through the member folder route, every object checked", async () => {
		const { store, file } = stored("Hello, folder.");
		const { folder, calls } = client(objects(store));
		const bytes = await folder.readFile(file, new AbortController().signal);
		expect(new TextDecoder().decode(bytes)).toBe("Hello, folder.");
		expect(calls.map((call) => call.url)).toEqual([
			`https://objects.test/v1/member-folder-objects/${env}/${file.manifestSha256}`,
			`https://objects.test/v1/member-folder-objects/${env}/${file.fileSha256}`,
		]);
		// The route answers "private, no-store" itself (object-gateway's member-folder-objects test); asking here too would
		// only make Chrome send the CORS preflight again on every read.
		expect(calls.map((call) => new Request(call.url, call.init).cache)).toEqual(["default", "default"]);
	});

	it("refuses bytes that are not what the entry and its manifest name", async () => {
		const { store, file } = stored("Hello, folder.");
		const signal = new AbortController().signal;
		await expect(client(objects(store)).folder.readFile({ ...file, bytes: file.bytes + 1 }, signal)).rejects.toThrow(
			"Invalid company folder manifest",
		);
		await expect(client(objects(store)).folder.readFile({ ...file, executable: true }, signal)).rejects.toThrow(
			"Invalid company folder manifest",
		);
		const swapped = new Map(store);
		swapped.set(file.fileSha256, new TextEncoder().encode("Hello, FOLDER."));
		await expect(client(objects(swapped)).folder.readFile(file, signal)).rejects.toThrow("integrity");
		await expect(client(objects(store, "other")).folder.readFile(file, signal)).rejects.toThrow("unavailable");
		await expect(client(objects(new Map())).folder.readFile(file, signal)).rejects.toThrow("refused (403)");
	});

	it("assembles chunks of any size up to 4 MiB, and an empty file", async () => {
		const signal = new AbortController().signal;
		const uneven = stored("Hello, folder of chunks.", [3, 10, 11]);
		expect(new TextDecoder().decode(await client(objects(uneven.store)).folder.readFile(uneven.file, signal))).toBe(
			"Hello, folder of chunks.",
		);
		const empty = stored("");
		expect((await client(objects(empty.store)).folder.readFile(empty.file, signal)).byteLength).toBe(0);
	});

	it("refuses a manifest past its bounds or one whose chunks are not the file", async () => {
		const signal = new AbortController().signal;
		const tooMany = stored("x".repeat(65), Array(65).fill(1));
		await expect(client(objects(tooMany.store)).folder.readFile(tooMany.file, signal)).rejects.toThrow(
			"Invalid company folder manifest",
		);
		const short = stored("abcdef", [3, 3], {
			chunks: [{ sha256: sha("abc"), bytes: 3 }],
		});
		await expect(client(objects(short.store)).folder.readFile(short.file, signal)).rejects.toThrow(
			"Invalid company folder manifest",
		);
		// The manifest names real chunks of another text under this file's hash: each chunk checks, the whole does not.
		const other = new TextEncoder().encode("abcdeF");
		const lying = stored("abcdef", [6], { chunks: [{ sha256: sha(other), bytes: 6 }] });
		lying.store.set(sha(other), other);
		await expect(client(objects(lying.store)).folder.readFile(lying.file, signal)).rejects.toThrow(
			"do not match their entry",
		);
		const big = stored("big", [3], { padding: "x".repeat(33 * 1024) });
		await expect(client(objects(big.store)).folder.readFile(big.file, signal)).rejects.toThrow();
	});

	it("stops when its caller does, and tells a refusal from an outage", async () => {
		const { store, file } = stored("Hello, folder.");
		const aborted = new AbortController();
		aborted.abort();
		await expect(client(objects(store)).folder.readFile(file, aborted.signal)).rejects.toThrow();
		const signal = new AbortController().signal;
		await expect(client(() => new Response(null, { status: 403 })).folder.read("a", signal)).rejects.toBeInstanceOf(
			CloudMemberFolderAccessDenied,
		);
		const outage = client(() => new Response(null, { status: 503 })).folder.read("a", signal);
		await expect(outage).rejects.toThrow("unavailable (503)");
		await expect(outage).rejects.not.toBeInstanceOf(CloudMemberFolderAccessDenied);
	});
});

describe("the member's file cache", () => {
	const signal = new AbortController().signal;
	const cached = { cached: true } as const;

	it("answers a version read before with no round trip, a copy each time, across the member's clients", async () => {
		const { store, file } = stored("Hello, cached folder.", [5, 16]);
		const files = new CloudMemberFolderFileCache();
		const first = client(objects(store), files);
		const bytes = await first.folder.readFile(file, signal, undefined, cached);
		expect(first.calls).toHaveLength(3);
		bytes.fill(0);
		const second = client(objects(store), files);
		expect(new TextDecoder().decode(await second.folder.readFile(file, signal, undefined, cached))).toBe(
			"Hello, cached folder.",
		);
		expect(second.calls).toHaveLength(0);
		expect(files.bytes).toBe(file.bytes);
		// Another version, and the same version under a limit it does not fit, are not answered from it.
		const other = stored("Hello, other version.");
		await second.folder.readFile(other.file, signal, undefined, cached).catch(() => undefined);
		expect(second.calls).toHaveLength(1);
		expect(() => second.folder.readFile(file, signal, file.bytes - 1, cached)).toThrow("limit");
		files.clear();
		await second.folder.readFile(file, signal, undefined, cached);
		expect(second.calls).toHaveLength(4);
		// A caller that did not just read the entry live (a reference kept from an earlier listing) reads uncached: the
		// gateway decides again.
		await second.folder.readFile(file, signal);
		expect(second.calls).toHaveLength(7);
	});

	it("keeps nothing a read under way when it was cleared brings back", async () => {
		const { store, file } = stored("Bytes read before a sign-out.");
		const files = new CloudMemberFolderFileCache();
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const reader = client(async (url) => {
			await gate;
			return objects(store)(url);
		}, files);
		const reading = reader.folder.readFile(file, signal, undefined, cached);
		files.clear();
		release();
		expect(new TextDecoder().decode(await reading)).toBe("Bytes read before a sign-out.");
		expect(files.bytes).toBe(0);
		await reader.folder.readFile(file, signal, undefined, cached);
		expect(reader.calls).toHaveLength(4);
		expect(files.bytes).toBe(file.bytes);

		// A reader that waited for a read under way, cleared and then stopped, reads for itself and keeps nothing either.
		const later = stored("Bytes a waiter read after a sign-out.");
		const shared = new CloudMemberFolderFileCache();
		const stop = new AbortController();
		let open: () => void = () => {};
		const opened = new Promise<void>((resolve) => {
			open = resolve;
		});
		const slow = client(async (url, init) => {
			await opened;
			init.signal?.throwIfAborted();
			return objects(later.store)(url);
		}, shared);
		const first = slow.folder.readFile(later.file, stop.signal, undefined, cached);
		const waiter = slow.folder.readFile(later.file, signal, undefined, cached);
		shared.clear();
		stop.abort();
		await expect(first).rejects.toThrow();
		open();
		expect(new TextDecoder().decode(await waiter)).toBe("Bytes a waiter read after a sign-out.");
		expect(shared.bytes).toBe(0);
		const before = slow.calls.length;
		await slow.folder.readFile(later.file, signal, undefined, cached);
		expect(slow.calls.length).toBe(before + 2);
	});

	it("shares a read under way, and a second reader reads for itself when the first stops", async () => {
		const { store, file } = stored("Shared bytes.");
		const files = new CloudMemberFolderFileCache();
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const slow = client(async (url) => {
			await gate;
			return objects(store)(url);
		}, files);
		const [a, b] = [
			slow.folder.readFile(file, signal, undefined, cached),
			slow.folder.readFile(file, signal, undefined, cached),
		];
		release();
		expect(new TextDecoder().decode(await a)).toBe("Shared bytes.");
		expect(new TextDecoder().decode(await b)).toBe("Shared bytes.");
		expect(slow.calls).toHaveLength(2);

		const later = stored("Bytes after a stop.");
		const stop = new AbortController();
		const reader = client((url, init) => {
			init.signal?.throwIfAborted();
			return objects(later.store)(url);
		}, new CloudMemberFolderFileCache());
		const stopped = reader.folder.readFile(later.file, stop.signal, undefined, cached);
		const waiting = reader.folder.readFile(later.file, signal, undefined, cached);
		stop.abort();
		await expect(stopped).rejects.toThrow();
		expect(new TextDecoder().decode(await waiting)).toBe("Bytes after a stop.");
	});

	it("keeps the most recently read up to its size, and never a file over a quarter of it", async () => {
		const files = new CloudMemberFolderFileCache(40);
		const a = stored("a".repeat(10));
		const b = stored("b".repeat(10));
		const c = stored("c".repeat(10));
		const d = stored("d".repeat(10));
		const big = stored("e".repeat(11));
		const store = new Map([...a.store, ...b.store, ...c.store, ...d.store, ...big.store]);
		const reader = client(objects(store), files);
		for (const file of [a.file, b.file, c.file, d.file])
			await reader.folder.readFile(file, signal, undefined, cached);
		expect(files.bytes).toBe(40);
		await reader.folder.readFile(a.file, signal, undefined, cached);
		await reader.folder.readFile(big.file, signal, undefined, cached);
		expect(files.bytes).toBe(40);
		const e = stored("f".repeat(10));
		for (const [key, value] of e.store) store.set(key, value);
		await reader.folder.readFile(e.file, signal, undefined, cached);
		const before = reader.calls.length;
		// b was the least recently read: it went; a, read again, stayed.
		await reader.folder.readFile(a.file, signal, undefined, cached);
		expect(reader.calls.length).toBe(before);
		await reader.folder.readFile(b.file, signal, undefined, cached);
		expect(reader.calls.length).toBe(before + 2);
		expect(() => new CloudMemberFolderFileCache(-1)).toThrow("cache size");
	});
});

describe("objects kept outside the client", () => {
	const signal = new AbortController().signal;
	const live = { cached: true } as const;

	function keeper(held = new Map<string, Uint8Array>()) {
		const taken: string[] = [];
		return {
			held,
			taken,
			kept: {
				take: async (hash: string) => {
					taken.push(hash);
					const bytes = held.get(hash);
					return bytes ? Uint8Array.from(bytes) : undefined;
				},
				keep: (hash: string, bytes: Uint8Array) => {
					held.set(hash, Uint8Array.from(bytes));
				},
			},
		};
	}
	function reader(store: Map<string, Uint8Array>, kept: ReturnType<typeof keeper>["kept"]) {
		const asked: string[] = [];
		const folder = new CloudMemberFolderClient({
			environmentId: env,
			supabaseUrl: "https://cloud.test/",
			objectGatewayUrl: "https://objects.test/",
			publishableKey: "sb_publishable_fixture",
			accessToken: async () => "member-token",
			pieceRetryMs: 1,
			kept,
			fetch: async (input) => {
				asked.push(String(input).split("/").at(-1)!);
				return objects(store)(new URL(String(input)));
			},
		});
		return { folder, asked };
	}
	const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
	const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

	it("keeps what a live read fetched and reads it again with no request, whole and in pieces", async () => {
		const { store, file } = stored("Kept between visits.", [4, 16]);
		const k = keeper();
		const first = reader(store, k.kept);
		expect(text(await first.folder.readFile(file, signal, undefined, live))).toBe("Kept between visits.");
		expect(first.asked).toHaveLength(3);
		await settled();
		expect([...k.held.keys()].sort()).toEqual([...store.keys()].sort());
		const second = reader(store, k.kept);
		expect(text(await second.folder.readFile(file, signal, undefined, live))).toBe("Kept between visits.");
		const pieces: string[] = [];
		await second.folder.readFilePieces(file, signal, (piece) => pieces.push(text(piece)), live);
		expect(pieces.join("")).toBe("Kept between visits.");
		expect(second.asked).toEqual([]);
	});

	it("neither takes nor keeps for a read that did not read the entry live", async () => {
		const { store, file } = stored("Read from an earlier listing.", [29]);
		const k = keeper(new Map(store));
		const listed = reader(store, k.kept);
		await listed.folder.readFile(file, signal);
		await listed.folder.readFilePieces(file, signal, () => {});
		expect(listed.asked).toHaveLength(4);
		expect(k.taken).toEqual([]);
		const empty = keeper();
		const again = reader(store, empty.kept);
		await again.folder.readFile(file, signal);
		await settled();
		expect(empty.held.size).toBe(0);
	});

	it("asks the folder for an object whose kept bytes fail their hash, are too large or cannot be taken", async () => {
		const { store, file } = stored("Checked every time it is used.", [10, 20]);
		const [first, second] = [...store.keys()].filter((hash) => hash !== file.manifestSha256) as [string, string];
		const k = keeper(new Map(store));
		k.held.set(first, new TextEncoder().encode("X".repeat(store.get(first)!.length)));
		k.held.set(second, new Uint8Array(store.get(second)!.length + 1));
		const tampered = reader(store, k.kept);
		expect(text(await tampered.folder.readFile(file, signal, undefined, live))).toBe(
			"Checked every time it is used.",
		);
		expect(tampered.asked.sort()).toEqual([first, second].sort());
		await settled();
		expect(k.held.get(first)).toEqual(Uint8Array.from(store.get(first)!));
		const broken = reader(store, {
			take: async () => {
				throw new Error("the store is gone");
			},
			keep: () => {
				throw new Error("the store is gone");
			},
		});
		expect(text(await broken.folder.readFile(file, signal, undefined, live))).toBe("Checked every time it is used.");
		expect(broken.asked).toHaveLength(3);
		await settled();
	});

	it("still refuses a file whose kept pieces are not the entry's bytes", async () => {
		const { file } = stored("The entry's hash decides.", [25]);
		const other = stored("Another file, equal size.", [25], { fileSha256: file.fileSha256 });
		const k = keeper(new Map(other.store));
		const wrong = reader(other.store, k.kept);
		await expect(
			wrong.folder.readFile({ ...file, manifestSha256: other.file.manifestSha256 }, signal, undefined, live),
		).rejects.toThrow("do not match their entry");
	});
});

describe("a file read piece by piece", () => {
	const MIB = 1024 * 1024;
	const signal = new AbortController().signal;

	/** A file cut into pieces of the given sizes, every 64 KiB of it its own bytes, with its manifest. `claimed` is
	 * the hash its entry and manifest give it, the bytes' own unless a test says otherwise. */
	function large(sizes: number[], claimed?: string) {
		const bytes = new Uint8Array(sizes.reduce((total, size) => total + size, 0));
		for (let at = 0; at < bytes.length; at += 65536) bytes.fill((at / 65536) % 251, at, at + 65536);
		const store = new Map<string, Uint8Array>();
		const chunks: { sha256: string; bytes: number }[] = [];
		let offset = 0;
		for (const size of sizes) {
			const chunk = bytes.subarray(offset, offset + size);
			store.set(sha(chunk), chunk);
			chunks.push({ sha256: sha(chunk), bytes: size });
			offset += size;
		}
		const fileSha256 = claimed ?? sha(bytes);
		const manifest = new TextEncoder().encode(
			JSON.stringify({
				schema: "qorpera.cloud-file-manifest/v2",
				fileSha256,
				bytes: bytes.length,
				mediaType: "application/zip",
				executable: false,
				chunks,
			}),
		);
		store.set(sha(manifest), manifest);
		const file = {
			manifestSha256: sha(manifest),
			fileSha256,
			bytes: bytes.length,
			mediaType: "application/zip",
			executable: false,
		};
		return { store, file, bytes, chunks };
	}

	/** A client whose second and third tries follow at once, over a responder that may take its time. `calls` names
	 * the object each request asked for. */
	function piecewise(
		responder: (hash: string, call: number) => Response | Promise<Response>,
		options: { timeoutMs?: number } = {},
	) {
		const calls: string[] = [];
		const folder = new CloudMemberFolderClient({
			environmentId: env,
			supabaseUrl: "https://cloud.test/",
			objectGatewayUrl: "https://objects.test/",
			publishableKey: "sb_publishable_fixture",
			accessToken: async () => "member-token",
			pieceRetryMs: 1,
			...options,
			fetch: async (input) => {
				const hash = String(input).split("/").at(-1)!;
				calls.push(hash);
				return responder(hash, calls.length);
			},
		});
		return { folder, calls };
	}
	const answer = (bytes: Uint8Array | undefined) =>
		bytes
			? new Response(Uint8Array.from(bytes), {
					headers: { "x-qorpera-access-mode": "live-path-authority", "content-length": String(bytes.length) },
				})
			: new Response(null, { status: 403 });
	/** Reads a file's pieces, noting each as it is handed out. */
	function pieces(folder: CloudMemberFolderClient, file: Parameters<CloudMemberFolderClient["readFilePieces"]>[0]) {
		const got: { index: number; count: number; piece: Uint8Array }[] = [];
		const read = folder.readFilePieces(file, signal, (piece, index, count) => got.push({ piece, index, count }));
		return { got, read };
	}

	it("reads a file over 8 MiB as its pieces, in order, each asked for once and checked", async () => {
		const { store, file, chunks } = large([4 * MIB, 4 * MIB, MIB]);
		const { folder, calls } = piecewise((hash) => answer(store.get(hash)));
		const { got, read } = pieces(folder, file);
		await read;
		expect(got.map(({ index, count, piece }) => [index, count, piece.byteLength])).toEqual([
			[0, 3, 4 * MIB],
			[1, 3, 4 * MIB],
			[2, 3, MIB],
		]);
		expect(sha(Buffer.concat(got.map(({ piece }) => piece)))).toBe(file.fileSha256);
		expect(calls).toEqual([file.manifestSha256, ...chunks.map((chunk) => chunk.sha256)]);
	});

	it("asks again for a piece that fails its hash or is lost, and refuses a file whose piece stays bad", async () => {
		const { store, file, chunks } = large([4 * MIB, 4 * MIB, MIB]);
		const second = chunks[1]!.sha256;
		const wrong = Uint8Array.from(store.get(second)!);
		wrong[7] = 255;
		// The manifest is lost once, and the second piece arrives damaged once: both are asked for again.
		let damaged = 0;
		const healing = piecewise((hash, call) => {
			if (call === 1) return new Response(null, { status: 503 });
			if (hash === second && damaged++ === 0) return answer(wrong);
			return answer(store.get(hash));
		});
		const healed = pieces(healing.folder, file);
		await healed.read;
		expect(healing.calls).toEqual([
			file.manifestSha256,
			file.manifestSha256,
			chunks[0]!.sha256,
			second,
			second,
			chunks[2]!.sha256,
		]);
		expect(sha(Buffer.concat(healed.got.map(({ piece }) => piece)))).toBe(file.fileSha256);
		// A piece that is bad three times ends the read: only the piece before it was handed out, and none after.
		const bad = piecewise((hash) => answer(hash === second ? wrong : store.get(hash)));
		const refused = pieces(bad.folder, file);
		await expect(refused.read).rejects.toThrow("integrity");
		expect(bad.calls).toEqual([file.manifestSha256, chunks[0]!.sha256, second, second, second]);
		expect(refused.got.map(({ index }) => index)).toEqual([0]);
	});

	it("does not ask again where the member is refused, or once its caller has stopped", async () => {
		const { store, file, chunks } = large([4 * MIB, 4 * MIB, MIB]);
		const denied = piecewise((hash) => answer(hash === chunks[1]!.sha256 ? undefined : store.get(hash)));
		const refused = pieces(denied.folder, file);
		await expect(refused.read).rejects.toBeInstanceOf(CloudMemberFolderAccessDenied);
		expect(denied.calls).toEqual([file.manifestSha256, chunks[0]!.sha256, chunks[1]!.sha256]);
		const stop = new AbortController();
		const stopped = piecewise((hash) => answer(store.get(hash)));
		await expect(stopped.folder.readFilePieces(file, stop.signal, () => stop.abort())).rejects.toThrow();
		expect(stopped.calls).toEqual([file.manifestSha256, chunks[0]!.sha256]);
	});

	it("gives the manifest and every piece the deadline to itself", async () => {
		const { store, file, chunks } = large(Array<number>(9).fill(MIB));
		const later = (ms: number, bytes: Uint8Array | undefined) =>
			new Promise<Response>((resolve) => setTimeout(() => resolve(answer(bytes)), ms));
		// Ten answers of 120 ms each pass a deadline of 400 ms one at a time; under one deadline they do not, even with
		// readFile asking for four chunks at once (the manifest, then three rounds: 480 ms).
		const slow = piecewise((hash) => later(120, store.get(hash)), { timeoutMs: 400 });
		const each = pieces(slow.folder, file);
		await each.read;
		expect(each.got).toHaveLength(9);
		await expect(slow.folder.readFile(file, signal)).rejects.toThrow("request deadline");
		// A piece that never answers in time is asked for three times, then the read ends.
		const stuck = piecewise((hash) => later(hash === chunks[1]!.sha256 ? 1000 : 0, store.get(hash)), {
			timeoutMs: 200,
		});
		const late = pieces(stuck.folder, file);
		await expect(late.read).rejects.toThrow("request deadline");
		expect(stuck.calls.filter((hash) => hash === chunks[1]!.sha256)).toHaveLength(3);
		expect(late.got.map(({ index }) => index)).toEqual([0]);
	});

	it("checks a file of at most 8 MiB whole before it hands out a piece, and a larger one by its pieces alone", async () => {
		const small = stored("Hello, folder of chunks.", [3, 10, 11]);
		const whole = pieces(piecewise((hash) => answer(small.store.get(hash))).folder, small.file);
		await whole.read;
		expect(whole.got.map(({ index, count }) => [index, count])).toEqual([
			[0, 3],
			[1, 3],
			[2, 3],
		]);
		expect(new TextDecoder().decode(Buffer.concat(whole.got.map(({ piece }) => piece)))).toBe(
			"Hello, folder of chunks.",
		);
		const empty = stored("");
		const none = pieces(piecewise((hash) => answer(empty.store.get(hash))).folder, empty.file);
		await none.read;
		expect(none.got).toEqual([]);
		// The manifest names real pieces of another text under this file's hash: each piece checks, the whole does not.
		const other = new TextEncoder().encode("abcdeF");
		const lying = stored("abcdef", [6], { chunks: [{ sha256: sha(other), bytes: 6 }] });
		lying.store.set(sha(other), other);
		const refused = pieces(piecewise((hash) => answer(lying.store.get(hash))).folder, lying.file);
		await expect(refused.read).rejects.toThrow("do not match their entry");
		expect(refused.got).toEqual([]);
		// Over 8 MiB the entry's manifest alone says what the file is: no second copy is made to hash it whole.
		const claimed = large([4 * MIB, 4 * MIB, MIB], "f".repeat(64));
		const taken = pieces(piecewise((hash) => answer(claimed.store.get(hash))).folder, claimed.file);
		await taken.read;
		expect(taken.got).toHaveLength(3);
	});

	it("refuses a manifest that is not the entry's, a file past the folder's bounds and a pause that is no time", async () => {
		const { store, file } = large([4 * MIB, 4 * MIB, MIB]);
		const { folder, calls } = piecewise((hash) => answer(store.get(hash)));
		await expect(folder.readFilePieces({ ...file, bytes: file.bytes + 1 }, signal, () => {})).rejects.toThrow(
			"Invalid company folder manifest",
		);
		// What the manifest says is read once: asking again would not change it.
		expect(calls).toEqual([file.manifestSha256]);
		await expect(folder.readFilePieces({ ...file, bytes: 257 * MIB }, signal, () => {})).rejects.toThrow(
			"exceeds this viewer's limit",
		);
		expect(calls).toHaveLength(1);
		expect(
			() =>
				new CloudMemberFolderClient({
					environmentId: env,
					supabaseUrl: "https://cloud.test/",
					objectGatewayUrl: "https://objects.test/",
					publishableKey: "sb_publishable_fixture",
					accessToken: async () => "member-token",
					pieceRetryMs: -1,
				}),
		).toThrow("Invalid company folder deadline");
	});
});

describe("member writes (P34a)", () => {
	const agent = "63000000-0000-4000-8000-0000000000c1";
	const room = "63000000-0000-4000-8000-0000000000b1";
	const commitId = "63000000-0000-4000-8000-0000000000d1";

	it("reads the agents' and group chats' files as test 898 pins them", () => {
		const answer = {
			schema: "qorpera.member-company-state-folders/v1",
			agents: [{ staffAgentId: agent, file: "QorperaOS/agents/nora/agent.md" }],
			groups: [{ roomId: room, file: "QorperaOS/agents/groups/launch/group.md" }],
		};
		// Before P34r's SQL the answer has no routines: routines' files are not known.
		expect(parseCloudMemberCompanyStateFolders(answer)).toEqual({
			agents: [{ staffAgentId: agent, file: "QorperaOS/agents/nora/agent.md" }],
			groups: [{ roomId: room, file: "QorperaOS/agents/groups/launch/group.md" }],
			routines: null,
		});
		expect(parseCloudMemberCompanyStateFolders({ ...answer, agents: [], groups: [] })).toEqual({
			agents: [],
			groups: [],
			routines: null,
		});
		// As test 899 pins them.
		const routine = { routineId: commitId, staffAgentId: agent, file: "QorperaOS/agents/nora/routines/inbox.md" };
		expect(parseCloudMemberCompanyStateFolders({ ...answer, routines: [routine] }).routines).toEqual([routine]);
		expect(parseCloudMemberCompanyStateFolders({ ...answer, routines: [] }).routines).toEqual([]);
		for (const bad of [
			{ ...answer, schema: "qorpera.member-company-state-folders/v2" },
			{ ...answer, extra: 1 },
			{ ...answer, agents: [{ staffAgentId: agent, file: "QorperaOS/agents/nora/agent.md", path: "x" }] },
			{ ...answer, groups: [{ roomId: "nope", file: "QorperaOS/agents/groups/launch/group.md" }] },
			{ ...answer, routines: {} },
			{ ...answer, routines: [{ routineId: commitId, file: "QorperaOS/agents/nora/routines/inbox.md" }] },
			{
				...answer,
				routines: [{ routineId: commitId, staffAgentId: "nope", file: "QorperaOS/agents/nora/routines/inbox.md" }],
			},
		])
			expect(() => parseCloudMemberCompanyStateFolders(bad)).toThrow();
	});

	it("reads a commit's answer unit by unit, as the core gives it", () => {
		const units = [
			{ op: "write", path: "QorperaOS/agents/nora/agent.md", text: "x" },
			{ op: "delete", path: "QorperaOS/agents/otto", expectedVersion: version, asOfSeq: 3 },
		] as const;
		expect(
			parseCloudMemberFolderCommit(
				{
					schema: "qorpera.folder-commit/v1",
					commitId,
					seq: 9,
					replay: false,
					units: [
						{ unit: 1, op: "write", path: "QorperaOS/agents/nora/agent.md", outcome: "saved", version },
						{
							unit: 2,
							op: "delete",
							path: "QorperaOS/agents/otto",
							outcome: "refused",
							reason: "structured_rule",
							problems: [
								{ code: "value", message: "a todo here has a worker at work; cancel the worker first" },
							],
						},
					],
				},
				units,
			),
		).toEqual({
			commitId,
			seq: 9,
			replay: false,
			units: [
				{
					unit: 1,
					op: "write",
					path: "QorperaOS/agents/nora/agent.md",
					to: null,
					version,
					outcome: "saved",
					reason: null,
					problems: [],
				},
				{
					unit: 2,
					op: "delete",
					path: "QorperaOS/agents/otto",
					to: null,
					version: null,
					outcome: "refused",
					reason: "structured_rule",
					problems: [
						{
							line: null,
							key: null,
							code: "value",
							message: "a todo here has a worker at work; cancel the worker first",
						},
					],
				},
			],
		});
		const refused = {
			schema: "qorpera.folder-commit/v1",
			commitId,
			seq: null,
			replay: false,
			units: [{ unit: 1, op: "write", path: "a", outcome: "refused", reason: "x" }],
		};
		expect(parseCloudMemberFolderCommit(refused, [{ op: "write", path: "a", text: "" }]).seq).toBeNull();
		for (const bad of [
			{ ...refused, seq: 4 },
			{ ...refused, units: [] },
			{ ...refused, units: [{ unit: 1, op: "mkdir", path: "a", outcome: "refused", reason: "x" }] },
			{ ...refused, units: [{ unit: 1, op: "write", path: "a", outcome: "saved", reason: "x" }] },
			{ ...refused, units: [{ unit: 1, op: "write", path: "a", outcome: "lost", reason: "x" }] },
			{ ...refused, extra: true },
		])
			expect(() => parseCloudMemberFolderCommit(bad, [{ op: "write", path: "a", text: "" }])).toThrow();
	});

	it("sends a change set to the gateway's member commit route with the member's own token", async () => {
		const units = [{ op: "mkdir", path: "drafts" }] as const;
		const { folder, calls } = client(() =>
			Response.json({
				schema: "qorpera.folder-commit/v1",
				commitId,
				seq: 4,
				replay: false,
				units: [{ unit: 1, op: "mkdir", path: "drafts", outcome: "saved", version }],
			}),
		);
		const result = await folder.commit("web:1", units, new AbortController().signal);
		expect(result.units[0]?.outcome).toBe("saved");
		expect(calls[0]!.url).toBe(`https://objects.test/v1/member-folder-commits/${env}`);
		expect(calls[0]!.init.method).toBe("POST");
		expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer member-token");
		expect(new Headers(calls[0]!.init.headers).get("apikey")).toBeNull();
		expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
			schema: "qorpera.member-folder-commit/v1",
			operationKey: "web:1",
			units: [{ op: "mkdir", path: "drafts" }],
		});
		expect(() => folder.commit("has space", units, new AbortController().signal)).toThrow();
		expect(() => folder.commit("web:2", [], new AbortController().signal)).toThrow();
		const denied = client(() => new Response(null, { status: 403 })).folder.commit(
			"web:3",
			units,
			new AbortController().signal,
		);
		await expect(denied).rejects.toBeInstanceOf(CloudMemberFolderAccessDenied);
		// A lock conflict keeps its status, so the caller sends the same change set again with the same key.
		const busy = client(() => new Response(null, { status: 409 })).folder.commit(
			"web:4",
			units,
			new AbortController().signal,
		);
		await expect(busy).rejects.toMatchObject({ status: 409 });
		await expect(busy).rejects.not.toBeInstanceOf(CloudMemberFolderAccessDenied);
	});

	it("reads the files through the member function", async () => {
		const { folder, calls } = client(() =>
			Response.json({ schema: "qorpera.member-company-state-folders/v1", agents: [], groups: [] }),
		);
		expect(await folder.stateFolders(new AbortController().signal)).toEqual({
			agents: [],
			groups: [],
			routines: null,
		});
		expect(calls[0]!.url).toBe("https://cloud.test/rest/v1/rpc/qorpera_member_company_state_folders");
		expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ p_environment_id: env });
	});
});

describe("the folder hint", () => {
	function realtime(removeAnswers: string[] = []) {
		const channels: {
			topic: string;
			config: unknown;
			onBroadcast?: (message: { payload?: unknown }) => void;
			onStatus?: (status: string) => void;
		}[] = [];
		const removed: unknown[] = [];
		const client = {
			channel: (topic: string, options: { config: unknown }) => {
				const channel = {
					topic,
					config: options.config,
					on(_type: string, _filter: unknown, callback: (message: { payload?: unknown }) => void) {
						channel.onBroadcast = callback;
						return channel;
					},
					subscribe(callback: (status: string) => void) {
						channel.onStatus = callback;
						return channel;
					},
				} as (typeof channels)[number] & Record<string, unknown>;
				channels.push(channel);
				return channel;
			},
			removeChannel: async (channel: unknown) => {
				removed.push(channel);
				return removeAnswers.shift() ?? "ok";
			},
		};
		return { client: client as never, channels, removed };
	}

	it("joins the company's private topic and passes on each well-formed hint", () => {
		const { client, channels } = realtime();
		const seqs: number[] = [];
		new CloudMemberFolderHints({
			environmentId: env,
			client,
			signal: new AbortController().signal,
			onHint: (seq) => seqs.push(seq),
		});
		expect(channels).toHaveLength(1);
		expect(channels[0]!.topic).toBe(`qorpera-folder-${env}`);
		expect(channels[0]!.config).toEqual({ private: true });
		for (const payload of [
			{ schema: "qorpera.folder-hint/v1", seq: 7 },
			{ schema: "qorpera.folder-hint/v1", seq: 0 },
			{ schema: "qorpera.folder-hint/v1", seq: "8" },
			{ schema: "qorpera.folder-hint/v2", seq: 9 },
			{ schema: "qorpera.folder-hint/v1", seq: 10, path: "a" },
			null,
		])
			channels[0]!.onBroadcast?.({ payload });
		expect(seqs).toEqual([7]);
		expect(cloudMemberFolderHintTopic(env)).toBe(`qorpera-folder-${env}`);
		expect(parseCloudMemberFolderHint({ schema: "qorpera.folder-hint/v1", seq: 3 })).toBe(3);
	});

	it("joins again with a fresh channel once the closed one is removed, and only then", async () => {
		vi.useFakeTimers();
		try {
			const { client, channels, removed } = realtime(["timed out", "ok"]);
			new CloudMemberFolderHints({ environmentId: env, client, signal: new AbortController().signal, onHint() {} });
			channels[0]!.onStatus?.("CLOSED");
			await vi.advanceTimersByTimeAsync(0);
			expect(removed).toEqual([channels[0]]);
			await vi.advanceTimersByTimeAsync(10_000);
			// Not removed yet: removing is tried again, no new channel is made.
			expect(channels).toHaveLength(1);
			expect(removed).toHaveLength(2);
			await vi.advanceTimersByTimeAsync(10_000);
			expect(channels).toHaveLength(2);
			// A status from the old channel changes nothing.
			channels[0]!.onStatus?.("CLOSED");
			await vi.advanceTimersByTimeAsync(20_000);
			expect(channels).toHaveLength(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("closes once, on close() or when its signal ends, and joins no more", async () => {
		vi.useFakeTimers();
		try {
			const { client, channels, removed } = realtime();
			const stop = new AbortController();
			const hints = new CloudMemberFolderHints({ environmentId: env, client, signal: stop.signal, onHint() {} });
			stop.abort();
			await hints.close();
			await vi.advanceTimersByTimeAsync(0);
			expect(removed).toEqual([channels[0]]);
			channels[0]!.onStatus?.("CLOSED");
			await vi.advanceTimersByTimeAsync(30_000);
			expect(channels).toHaveLength(1);
			const aborted = new AbortController();
			aborted.abort();
			const before = channels.length;
			new CloudMemberFolderHints({ environmentId: env, client, signal: aborted.signal, onHint() {} });
			expect(channels).toHaveLength(before);
		} finally {
			vi.useRealTimers();
		}
	});
});
