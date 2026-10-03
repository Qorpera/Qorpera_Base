import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	CloudMemberFolderClient,
	parseCloudMemberFolderBy,
	parseCloudMemberFolderChanges,
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
			{ ...entry, mediaType: "Text/Plain" },
		])
			expect(() =>
				parseCloudMemberFolderRead({ schema: "qorpera.folder-read/v1", asOfSeq: 9, found: true, entry: bad }),
			).toThrow("Invalid company folder entry");
		expect(() => parseCloudMemberFolderRead({ schema: "qorpera.folder-read/v1", asOfSeq: 9, found: true })).toThrow();
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

function stored(content: string) {
	const bytes = new TextEncoder().encode(content);
	const manifest = new TextEncoder().encode(
		JSON.stringify({
			schema: "qorpera.cloud-file-manifest/v2",
			fileSha256: sha(bytes),
			bytes: bytes.length,
			mediaType: "text/plain",
			executable: false,
			chunks: [{ sha256: sha(bytes), bytes: bytes.length }],
		}),
	);
	return {
		store: new Map([
			[sha(manifest), manifest],
			[sha(bytes), bytes],
		]),
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
		await expect(client(objects(new Map())).folder.readFile(file, signal)).rejects.toThrow("unavailable (403)");
	});
});
