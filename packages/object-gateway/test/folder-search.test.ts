import { describe, expect, it } from "vitest";
import type { CoreEntry } from "../src/folder-service/core.ts";
import { ObjectIntegrityError } from "../src/folder-service/objects.ts";
import type { SearchRequest } from "../src/folder-service/protocol.ts";
import {
	globPattern,
	type SearchAnswer,
	type SearchSource,
	searchView,
	treeOrder,
} from "../src/folder-service/search.ts";
import { type TreeEntry, ViewTree } from "../src/folder-service/view-tree.ts";

const v = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const RECEIPT = {
	resourceId: "aaaaaaaa-0000-4000-8000-000000000001",
	resourceRevision: 3,
	grantId: null,
	grantRevision: null,
};

/** A view of these files (their folders listed too), and a source that reads them from memory. */
function stage(files: Record<string, string | Buffer>, options: { clock?: () => number; broken?: string[] } = {}) {
	const tree = new ViewTree();
	const bytes = new Map<string, Buffer>();
	let n = 0;
	const folders = new Set<string>();
	for (const path of Object.keys(files))
		for (let at = path.indexOf("/"); at >= 0; at = path.indexOf("/", at + 1)) folders.add(path.slice(0, at));
	for (const folder of folders) tree.put({ path: folder, kind: "folder", version: v(++n), authority: RECEIPT });
	for (const [path, content] of Object.entries(files)) {
		const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
		bytes.set(path, body);
		const entry: CoreEntry = {
			path,
			kind: "file",
			version: v(++n),
			manifestSha256: "f".repeat(64),
			fileSha256: "e".repeat(64),
			bytes: body.byteLength,
			authority: RECEIPT,
		};
		tree.put(entry);
	}
	const asked: string[] = [];
	const source: SearchSource = {
		tree,
		now: options.clock ?? (() => 0),
		pieceBytes: 16,
		async read(entry: TreeEntry, offset: number, length: number) {
			asked.push(`${entry.path}@${offset}`);
			if (options.broken?.includes(entry.path)) throw new ObjectIntegrityError("bad chunk");
			return bytes.get(entry.path)!.subarray(offset, offset + length);
		},
	};
	return { tree, source, asked };
}

/** A page's hits as path, line and text. */
const seen = (page: SearchAnswer) => page.hits.map(({ path, line, text }) => ({ path, line, text }));

const request = (query: string, more: Partial<SearchRequest> = {}): SearchRequest => ({
	query,
	path: "",
	glob: null,
	namesOnly: false,
	caseSensitive: false,
	after: null,
	...more,
});

/** Every page until the end, and every hit in order. */
async function all(source: SearchSource, first: SearchRequest): Promise<{ pages: SearchAnswer[]; hits: string[] }> {
	const pages: SearchAnswer[] = [];
	let next: SearchRequest | null = first;
	while (next) {
		const page = await searchView(source, next);
		pages.push(page);
		next = page.next ? { ...first, after: page.next } : null;
		if (pages.length > 1000) throw new Error("The search never ended");
	}
	return { pages, hits: pages.flatMap((p) => p.hits.map((h) => `${h.path}:${h.line}:${h.text}`)) };
}

describe("folder search", () => {
	it("finds text line by line in the order a machine lists, and names every folder and file it drew on", async () => {
		const { source } = stage({
			"docs/plan.md": "The plan\nsecond line\nthe PLAN again\n",
			"docs/b/notes.txt": "nothing here\n",
			"a.md": "plan at the top",
		});
		const page = await searchView(source, request("plan"));
		expect(seen(page)).toEqual([
			{ path: "a.md", line: 1, text: "plan at the top" },
			{ path: "docs/plan.md", line: 1, text: "The plan" },
			{ path: "docs/plan.md", line: 3, text: "the PLAN again" },
		]);
		// Each hit names its version and where its line starts: "The plan\nsecond line\n" is 21 bytes.
		expect(page.hits.map((h) => [h.version, h.offset])).toEqual([
			[v(5), 0],
			[v(3), 0],
			[v(3), 21],
		]);
		expect(page.next).toBeNull();
		expect(page.searched).toBe(3);
		expect(page.reads.map((r) => `${r.kind} ${r.path}`)).toEqual([
			"file a.md",
			"folder docs",
			"folder docs/b",
			"file docs/b/notes.txt",
			"file docs/plan.md",
		]);
		expect(page.reads.every((r) => r.authority === RECEIPT)).toBe(true);
		// Case, a folder, one file, and no hit at all.
		expect((await searchView(source, request("PLAN", { caseSensitive: true }))).hits).toHaveLength(1);
		expect((await searchView(source, request("plan", { path: "docs/b" }))).hits).toEqual([]);
		expect(seen(await searchView(source, request("again", { path: "docs/plan.md" })))).toEqual([
			{ path: "docs/plan.md", line: 3, text: "the PLAN again" },
		]);
	});

	it("keeps to the glob: a name pattern, or a path pattern with **", async () => {
		const { source } = stage({ "a.md": "x", "a.txt": "x", "d/e/f.md": "x", "d/g.txt": "x" });
		const paths = async (glob: string) => [
			...new Set((await searchView(source, request("x", { glob }))).hits.map((h) => h.path)),
		];
		expect(await paths("*.md")).toEqual(["a.md", "d/e/f.md"]);
		expect(await paths("d/**/*.md")).toEqual(["d/e/f.md"]);
		expect(await paths("**/*.txt")).toEqual(["a.txt", "d/g.txt"]);
		expect(await paths("?.txt")).toEqual(["a.txt", "d/g.txt"]);
		expect(globPattern("a.b*").test("a.bc")).toBe(true);
		expect(globPattern("a.b*").test("axbc")).toBe(false);
		expect(globPattern("(x)[y]").test("(x)[y]")).toBe(true);
	});

	it("passes over binary files (still read: that is how it knows) and files whose bytes fail their check", async () => {
		const { source } = stage(
			{ "bin.dat": Buffer.from([0x70, 0x6c, 0x61, 0x6e, 0, 1, 2]), "bad.md": "plan", "good.md": "plan" },
			{ broken: ["bad.md"] },
		);
		const page = await searchView(source, request("plan"));
		expect(page.hits.map((h) => h.path)).toEqual(["good.md"]);
		expect(page.binary).toBe(1);
		expect(page.searched).toBe(1);
		expect(page.reads.map((r) => r.path)).toEqual(["bin.dat", "good.md"]);
	});

	it("searches names with namesOnly, folders too, and reads only the folders it looked through", async () => {
		const { source, asked } = stage({ "plans/a.md": "x", "docs/plan-b.md": "x", "docs/other.md": "x" });
		const page = await searchView(source, request("PLAN", { namesOnly: true }));
		expect(seen(page)).toEqual([
			{ path: "docs/plan-b.md", line: 0, text: "docs/plan-b.md" },
			{ path: "plans", line: 0, text: "plans" },
		]);
		expect(page.reads.map((r) => `${r.kind} ${r.path}`)).toEqual(["folder docs", "folder plans"]);
		expect(asked).toEqual([]);
	});

	it("pages by hits, across the pieces of a file, with no line shown twice or left out", async () => {
		const lines = Array.from({ length: 400 }, (_, i) => `line ${i + 1} has the word plan in it`);
		const { source } = stage({ "big.md": `${lines.join("\n")}\n`, "z.md": "plan\n" });
		const { pages, hits } = await all(source, request("plan"));
		expect(pages.length).toBeGreaterThan(2);
		expect(pages[0]!.next).toMatchObject({ path: "big.md", line: pages[0]!.hits.length });
		expect(pages[0]!.next!.offset).toBeGreaterThan(0);
		expect(hits).toEqual([...lines.map((l, i) => `big.md:${i + 1}:${l}`), "z.md:1:plan"]);
		for (const page of pages)
			expect(Buffer.byteLength(JSON.stringify(page.hits))).toBeLessThanOrEqual(6 * 1024 + 200);
	});

	it("pages by time, from where it left off, and searches a file that changed since from its start", async () => {
		let t = 0;
		const files = { "a.md": "one plan\ntwo\nthree plan\n", "b.md": "plan b\n", "c.md": "plan c\n" };
		const { source, tree } = stage(files, {
			clock: () => {
				t += 1_000;
				return t;
			},
		});
		const first = await searchView(source, request("plan"));
		expect(first.next).not.toBeNull();
		const { hits } = await all(source, request("plan"));
		expect(hits).toEqual(["a.md:1:one plan", "a.md:3:three plan", "b.md:1:plan b", "c.md:1:plan c"]);
		// A cursor into a.md's old version: its new version is searched from its start.
		tree.put({ path: "a.md", kind: "file", version: v(99), manifestSha256: "f".repeat(64), bytes: 24 });
		const resumed = await searchView(
			{ ...source, now: () => 0 },
			request("plan", { after: { path: "a.md", version: v(1), offset: 13, line: 2 } }),
		);
		expect(seen(resumed)[0]).toEqual({ path: "a.md", line: 1, text: "one plan" });
	});

	it("pages by the reads one answer carries", async () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 4_100; i++) files[`f/${String(i).padStart(5, "0")}.md`] = "x";
		const { source } = stage(files);
		const page = await searchView(source, request("zzz"));
		expect(page.reads).toHaveLength(4_000);
		expect(page.next?.path).toBe("f/03999.md");
		const rest = await searchView(source, request("zzz", { after: page.next }));
		expect(rest.next).toBeNull();
		expect(rest.reads).toHaveLength(101);
	});

	it("cuts a hit's line around its match and shows control characters as spaces", async () => {
		const { source } = stage({ "a.md": `${"x".repeat(500)}plan${"y".repeat(500)}\n`, "b.md": "a\u0007plan\r\n" });
		const page = await searchView(source, request("plan"));
		expect(page.hits[0]!.text).toMatch(/^….{200}…$/u);
		expect(page.hits[0]!.text).toContain("plan");
		expect(page.hits[1]!.text).toBe("a plan ");
	});

	it("goes on from any hit, so a page shown only in part loses nothing", async () => {
		const { source } = stage({ "a.md": "plan 1\nx\nplan 2\nplan 3\n", "b.md": "plan b\n" });
		const page = await searchView(source, request("plan"));
		const third = page.hits[2]!;
		const rest = await searchView(
			source,
			request("plan", {
				after: { path: third.path, version: third.version, offset: third.offset, line: third.line - 1 },
			}),
		);
		expect(seen(rest)).toEqual(seen(page).slice(2));
	});

	it("orders paths depth first, name by name", () => {
		const paths = ["a-c", "a/b", "a", "a0", "b"];
		expect(paths.sort(treeOrder)).toEqual(["a", "a/b", "a-c", "a0", "b"]);
	});
});
