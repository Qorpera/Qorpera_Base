import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	CLOUD_MEMBER_FOLDER_PAGE,
	CloudMemberFolderAccessDenied,
	CloudMemberFolderClient,
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

function client(responder: (url: URL, init: RequestInit) => Response) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	return {
		calls,
		folder: new CloudMemberFolderClient({
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
		expect(() => folder.list(null, null, 0, new AbortController().signal)).toThrow();
		expect(() => folder.pathHistory("a", "not-a-version", 10, new AbortController().signal)).toThrow();
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

describe("member writes (P34a)", () => {
	const agent = "63000000-0000-4000-8000-0000000000c1";
	const room = "63000000-0000-4000-8000-0000000000b1";
	const commitId = "63000000-0000-4000-8000-0000000000d1";

	it("reads the agents' and group chats' files as test 898 pins them", () => {
		const answer = {
			schema: "qorpera.member-company-state-folders/v1",
			agents: [{ staffAgentId: agent, file: "agents/nora/agent.md" }],
			groups: [{ roomId: room, file: "agents/groups/launch/group.md" }],
		};
		// Before P34r's SQL the answer has no routines: routines' files are not known.
		expect(parseCloudMemberCompanyStateFolders(answer)).toEqual({
			agents: [{ staffAgentId: agent, file: "agents/nora/agent.md" }],
			groups: [{ roomId: room, file: "agents/groups/launch/group.md" }],
			routines: null,
		});
		expect(parseCloudMemberCompanyStateFolders({ ...answer, agents: [], groups: [] })).toEqual({
			agents: [],
			groups: [],
			routines: null,
		});
		// As test 899 pins them.
		const routine = { routineId: commitId, staffAgentId: agent, file: "agents/nora/routines/inbox.md" };
		expect(parseCloudMemberCompanyStateFolders({ ...answer, routines: [routine] }).routines).toEqual([routine]);
		expect(parseCloudMemberCompanyStateFolders({ ...answer, routines: [] }).routines).toEqual([]);
		for (const bad of [
			{ ...answer, schema: "qorpera.member-company-state-folders/v2" },
			{ ...answer, extra: 1 },
			{ ...answer, agents: [{ staffAgentId: agent, file: "agents/nora/agent.md", path: "x" }] },
			{ ...answer, groups: [{ roomId: "nope", file: "agents/groups/launch/group.md" }] },
			{ ...answer, routines: {} },
			{ ...answer, routines: [{ routineId: commitId, file: "agents/nora/routines/inbox.md" }] },
			{
				...answer,
				routines: [{ routineId: commitId, staffAgentId: "nope", file: "agents/nora/routines/inbox.md" }],
			},
		])
			expect(() => parseCloudMemberCompanyStateFolders(bad)).toThrow();
	});

	it("reads a commit's answer unit by unit, as the core gives it", () => {
		const units = [
			{ op: "write", path: "agents/nora/agent.md", text: "x" },
			{ op: "delete", path: "agents/otto", expectedVersion: version, asOfSeq: 3 },
		] as const;
		expect(
			parseCloudMemberFolderCommit(
				{
					schema: "qorpera.folder-commit/v1",
					commitId,
					seq: 9,
					replay: false,
					units: [
						{ unit: 1, op: "write", path: "agents/nora/agent.md", outcome: "saved", version },
						{
							unit: 2,
							op: "delete",
							path: "agents/otto",
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
					path: "agents/nora/agent.md",
					to: null,
					version,
					outcome: "saved",
					reason: null,
					problems: [],
				},
				{
					unit: 2,
					op: "delete",
					path: "agents/otto",
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
