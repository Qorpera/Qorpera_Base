import { describe, expect, it } from "vitest";
import type { CoreEntry } from "../src/folder-service/core.ts";
import { ObjectIntegrityError, ObjectMissingError } from "../src/folder-service/objects.ts";
import { encodeJson, Kind, parseSearch, type SearchRequest } from "../src/folder-service/protocol.ts";
import { compilePattern, foldText, linearRegexAvailable, SearchPatternError } from "../src/folder-service/regex.ts";
import {
	compileGlob,
	globMatches,
	type SearchAnswer,
	type SearchFile,
	type SearchSource,
	SHOWN_BYTES,
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
function stage(
	files: Record<string, string | Buffer>,
	options: { clock?: () => number; broken?: string[]; missing?: string[] } = {},
) {
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
			if (options.missing?.includes(entry.path)) throw new ObjectMissingError("not on the share");
			return bytes.get(entry.path)!.subarray(offset, offset + length);
		},
	};
	return { tree, source, asked };
}

/** A page's hits as path, line and text. */
const seen = (page: SearchAnswer) => page.hits.map(({ path, line, text }) => ({ path, line, text }));

const request = (query: string | null, more: Partial<SearchRequest> = {}): SearchRequest => ({
	version: 1,
	query,
	regex: false,
	path: "",
	glob: null,
	namesOnly: false,
	filesOnly: false,
	caseSensitive: false,
	context: 0,
	after: null,
	...more,
});
/** A version 2 request (keyholes S4). */
const request2 = (query: string | null, more: Partial<SearchRequest> = {}): SearchRequest =>
	request(query, { version: 2, ...more });

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
		const matches = (glob: string, path: string) => globMatches(compileGlob(glob), path);
		expect(matches("a.b*", "a.bc")).toBe(true);
		expect(matches("a.b*", "axbc")).toBe(false);
		expect(matches("(x)[y]", "(x)[y]")).toBe(true);
		expect(matches("a**b", "axxb")).toBe(true);
		expect(matches("a**b", "a/b")).toBe(false);
		expect(matches("**/x.md", "x.md")).toBe(true);
		expect(matches("d/**", "d/e/f")).toBe(true);
		expect(matches("d/**/f", "d/f")).toBe(true);
		expect(matches("*.md", "a\nb.md")).toBe(true);
		// Linear time, whatever the model sends: this pattern against a long name of a's backtracks exponentially in a
		// regular expression.
		const started = performance.now();
		expect(matches("*a*a*a*a*a*a*a*a*a*a*a*a*ab", "a".repeat(255))).toBe(false);
		expect(matches("**/**/**/**/**/**/**/**/**/x", Array.from({ length: 200 }, () => "a").join("/"))).toBe(false);
		expect(performance.now() - started).toBeLessThan(200);
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

	it("searches names with namesOnly, folders too, and reads each name it shows and each folder it looked through", async () => {
		const { source, asked, tree } = stage({
			"plans/a.md": "x",
			"docs/plan-b.md": "x",
			"docs/other.md": "x",
			"plan-top.md": "x",
		});
		// A folder the agent may not list, shown only because it holds a readable path, is never a name hit.
		tree.put({
			path: "hidden-plans/plan.md",
			kind: "file",
			version: v(90),
			manifestSha256: "f".repeat(64),
			bytes: 1,
		});
		const page = await searchView(source, request("PLAN", { namesOnly: true }));
		expect(page.hits.map((h) => [h.path, h.kind, h.line, h.text])).toEqual([
			["docs/plan-b.md", "file", 0, ""],
			["hidden-plans/plan.md", "file", 0, ""],
			["plan-top.md", "file", 0, ""],
			["plans", "folder", 0, ""],
		]);
		expect(page.reads.map((r) => `${r.kind} ${r.path}`)).toEqual([
			"folder docs",
			"file docs/plan-b.md",
			"file hidden-plans/plan.md",
			"file plan-top.md",
			"folder plans",
		]);
		expect(asked).toEqual([]);
	});

	it("finds a link by its name only, with its target, never by its target or through it, and below protocol 4 not at all", async () => {
		const { source, asked, tree } = stage({
			"docs/plan-v2.md": "the plan",
			"docs/notes.md": "plan-latest",
			"plans/a.md": "plan a",
		});
		const links: [string, string, number][] = [
			["docs/plan-latest", "plan-v2.md", 50],
			["docs/current", "plan-v2.md", 51],
			["docs/all-plans", "../plans", 52],
		];
		for (const [path, target, n] of links)
			tree.put({ path, kind: "symlink", version: v(n), target, authority: RECEIPT });
		const p4 = { ...source, links: true };
		const names = await searchView(p4, request("plan", { namesOnly: true }));
		expect(names.hits.map((h) => [h.path, h.kind, h.target])).toEqual([
			["docs/all-plans", "symlink", "../plans"],
			["docs/plan-latest", "symlink", "plan-v2.md"],
			["docs/plan-v2.md", "file", undefined],
			["plans", "folder", undefined],
		]);
		expect(names.hits[0]!.version).toBe(v(52));
		expect(names.reads.map((r) => `${r.kind} ${r.path}`)).toEqual([
			"folder docs",
			"symlink docs/all-plans",
			"symlink docs/plan-latest",
			"file docs/plan-v2.md",
			"folder plans",
		]);
		expect(asked).toEqual([]);
		// Text is looked for in files only: a link's target is never read as its text, nor followed.
		const text = await searchView(p4, request("plan"));
		expect(text.hits.map((h) => h.path)).toEqual(["docs/notes.md", "docs/plan-v2.md", "plans/a.md"]);
		expect(text.reads.map((r) => `${r.kind} ${r.path}`)).toEqual([
			"folder docs",
			"file docs/notes.md",
			"file docs/plan-v2.md",
			"folder plans",
			"file plans/a.md",
		]);
		expect(new Set(asked.map((a) => a.slice(0, a.indexOf("@"))))).toEqual(
			new Set(["docs/notes.md", "docs/plan-v2.md", "plans/a.md"]),
		);
		// Below protocol 4 a link is not there.
		const below = await searchView(source, request("plan", { namesOnly: true }));
		expect(below.hits.map((h) => h.path)).toEqual(["docs/plan-v2.md", "plans"]);
		expect(below.reads.map((r) => `${r.kind} ${r.path}`)).toEqual([
			"folder docs",
			"file docs/plan-v2.md",
			"folder plans",
		]);
	});

	it("ends a page by the encoded size of its reads, so it always fits one frame", async () => {
		const files: Record<string, string> = {};
		const long = "d".repeat(250);
		for (let i = 0; i < 1_000; i++)
			files[`${long}/${long}/${long}/${String(i).padStart(4, "0")}${"x".repeat(200)}.md`] = "x";
		const { source } = stage(files);
		const page = await searchView(source, request("zzz"));
		expect(page.next).not.toBeNull();
		expect(page.reads.length).toBeLessThan(1_000);
		expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(2 * 1024 * 1024 - 1024);
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

	it("passes over a file whose bytes are missing from the share, says so, and goes on", async () => {
		const logged: string[] = [];
		const { source } = stage(
			{ "a.md": "plan a", "gone.md": "plan gone", "z.md": "plan z" },
			{ missing: ["gone.md"] },
		);
		const page = await searchView({ ...source, log: (line) => logged.push(line) }, request("plan"));
		expect(page.hits.map((h) => h.path)).toEqual(["a.md", "z.md"]);
		expect(page.unreadable).toBe(1);
		expect(page.reads.map((r) => r.path)).toEqual(["a.md", "z.md"]);
		expect(logged).toEqual([expect.stringContaining("gone.md")]);
	});

	it("searches a very long line in stretches: one line number, a match across stretches found, one hit per line", async () => {
		const long = `${"x".repeat(100)}pl${"an".slice(0, 2)}${"x".repeat(100)}plan`;
		const { source } = stage({ "a.txt": `first\n${long}\nplan three\n` });
		const page = await searchView({ ...source, longestLine: 40 }, request("plan"));
		expect(page.hits.map((h) => [h.line, h.offset])).toEqual([
			[2, 6],
			[3, 6 + long.length + 1],
		]);
		expect(page.hits[0]!.text).toContain("plan");
		// A match that straddles two stretches of a long line is found.
		const split = `${"y".repeat(38)}plan${"y".repeat(100)}`;
		const straddle = stage({ "b.txt": `${split}\n` });
		expect(
			seen(await searchView({ ...straddle.source, longestLine: 40 }, request("plan"))).map((h) => h.line),
		).toEqual([1]);
	});

	it("never decodes a character a long line's stretch cut in two", async () => {
		// "plan" just before a four-byte character, at every alignment against the stretches' ends.
		for (let pad = 20; pad <= 80; pad++) {
			const { source } = stage({ "a.txt": `${"x".repeat(pad)}plan\u{1F600}${"y".repeat(60)}\n` });
			const page = await searchView({ ...source, longestLine: 40 }, request("plan"));
			expect(page.hits.map((h) => h.line)).toEqual([1]);
			expect(page.hits[0]!.text).not.toContain("\uFFFD");
		}
	});

	it("answers nothing once its view closed or lapsed while the last read was awaited", async () => {
		for (const reason of ["VIEW_CLOSED", "UNAVAILABLE"]) {
			const { source } = stage({ "a.md": "the plan" });
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let serving = true;
			const page = searchView(
				{
					...source,
					read: async (entry, offset, length) => {
						await gate;
						return source.read(entry, offset, length);
					},
					serving: () => {
						if (!serving) throw new Error(reason);
					},
				},
				request("plan"),
			);
			await new Promise((resolve) => setTimeout(resolve, 10));
			serving = false;
			release();
			await expect(page).rejects.toThrow(reason);
		}
	});

	it("shows the match in a hit's text after characters that count double", async () => {
		const { source } = stage({ "e.md": `${"\u{1F600}".repeat(300)} the plan ${"\u{1F600}".repeat(300)}\n` });
		const page = await searchView(source, request("PLAN"));
		expect(page.hits[0]!.text).toContain("plan");
	});

	it("gives the node's event loop a turn while it works, and always moves the search on", async () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 20_000; i++) files[`f/${String(i).padStart(6, "0")}.md`] = "x";
		const { source } = stage(files);
		let turns = 0;
		const ticker = setInterval(() => turns++, 1);
		await searchView({ ...source, sliceMs: 60_000 }, request("zzz", { namesOnly: true }));
		clearInterval(ticker);
		expect(turns).toBeGreaterThan(0);
		// A clock already past every deadline: each page still moves on, and the pages together cover everything.
		const late = stage(
			{ "a.md": "plan", "b.md": "plan", "c/d.md": "plan" },
			{ clock: () => Number.MAX_SAFE_INTEGER },
		);
		let t = 0;
		const jumping = (): number => {
			t += 10_000;
			return t;
		};
		const { pages, hits } = await all({ ...late.source, now: jumping }, request("plan"));
		expect(pages.length).toBeGreaterThan(1);
		expect(hits).toEqual(["a.md:1:plan", "b.md:1:plan", "c/d.md:1:plan"]);
	});

	it("walks from a cursor straight to it, in the same order as a whole walk", () => {
		const { tree } = stage({
			"a-c.md": "x",
			"a/b.md": "x",
			"a/z/q.md": "x",
			"a0.md": "x",
			"b/c/d.md": "x",
			"b/e.md": "x",
		});
		const all = [...tree.walk("")].map((e) => e.path);
		// A cursor never names the root (the request's parser refuses an empty path).
		for (const from of [...all.filter((p) => p !== ""), "a/m", "a/zz", "b/c/a", "zz", "a"]) {
			const expected = all.filter((p) => p !== "" && treeOrder(p, from) >= 0);
			expect(
				[...tree.walk("", from)].map((e) => e.path),
				from,
			).toEqual(expected);
		}
		expect([...tree.walk("a", "a/z")].map((e) => e.path)).toEqual(["a/z", "a/z/q.md"]);
		expect([...tree.walk("b", "a/z")].map((e) => e.path)).toEqual(["b", "b/c", "b/c/d.md", "b/e.md"]);
		expect([...tree.walk("a", "b")].map((e) => e.path)).toEqual([]);
	});

	it("orders paths depth first, name by name", () => {
		const paths = ["a-c", "a/b", "a", "a0", "b"];
		expect(paths.sort(treeOrder)).toEqual(["a", "a/b", "a-c", "a0", "b"]);
	});
});

/** Every page of a search until its end, by any clock, with each page's hits in full (context lines too). */
async function pages(source: SearchSource, first: SearchRequest): Promise<SearchAnswer[]> {
	const out: SearchAnswer[] = [];
	let next: SearchRequest | null = first;
	while (next) {
		const page = await searchView(source, next);
		out.push(page);
		next = page.next ? { ...first, after: page.next } : null;
		if (out.length > 5000) throw new Error("The search never ended");
	}
	return out;
}

/** The files a files-only search counted, a file a page ended inside counted on by the next as one. */
function counted(answers: readonly SearchAnswer[]): { path: string; count: number }[] {
	const out: { path: string; count: number }[] = [];
	let open: SearchFile | undefined;
	for (const file of answers.flatMap((a) => a.files ?? [])) {
		const last = out.at(-1);
		if (open && last && last.path === file.path) last.count += file.count;
		else out.push({ path: file.path, count: file.count });
		open = file.partial ? file : undefined;
	}
	return out;
}

const payload = (body: Record<string, unknown>) => encodeJson(Kind.search, body).subarray(5);
/** A clock a second later at each look: every page's time is up at its first check. */
function ticking(): () => number {
	let t = 0;
	return () => {
		t += 1_000;
		return t;
	};
}
const v1 = { query: "x", path: "", glob: null, namesOnly: false, caseSensitive: false, after: null };
const v2 = { ...v1, version: 2, regex: false, filesOnly: false, context: 0 };

describe("folder search, version 2 (keyholes S4)", () => {
	it("reads a version 1 request as before and a version 2 one with its new parts, and refuses what does not go together", () => {
		expect(parseSearch(payload(v1))).toEqual({
			...v1,
			version: 1,
			regex: false,
			filesOnly: false,
			context: 0,
		});
		expect(parseSearch(payload({ ...v2, regex: true, context: 5 }))).toMatchObject({
			version: 2,
			regex: true,
			context: 5,
		});
		expect(parseSearch(payload({ ...v2, query: null, namesOnly: true, glob: "*.md" }))).toMatchObject({
			query: null,
			namesOnly: true,
		});
		for (const bad of [
			{ ...v1, regex: true },
			{ ...v1, context: 1 },
			{ ...v2, version: 3 },
			{ ...v2, extra: 1 },
			{ ...v2, filesOnly: undefined },
			{ ...v2, query: null },
			{ ...v2, query: null, namesOnly: true, regex: true },
			{ ...v2, filesOnly: true, namesOnly: true },
			{ ...v2, context: 6 },
			{ ...v2, context: 1, filesOnly: true },
			{ ...v2, context: 1, namesOnly: true },
			{ ...v2, regex: "yes" },
		])
			expect(() => parseSearch(payload(bad as Record<string, unknown>)), JSON.stringify(bad)).toThrow();
	});

	it("fills a page with about 26 KiB of hits as the run shows them, and shows each hit once over the pages", async () => {
		const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1} has the word plan in it`);
		const { source } = stage({ "big.md": `${lines.join("\n")}\n`, "z.md": "plan\n" });
		const answers = await pages(source, request2("plan"));
		const hits = answers.flatMap((p) => p.hits.map((h) => `${h.path}:${h.line}:${h.text}`));
		expect(hits).toEqual([...lines.map((l, i) => `big.md:${i + 1}:${l}`), "z.md:1:plan"]);
		const shown = (page: SearchAnswer) =>
			page.hits.reduce(
				(sum, h) => sum + Buffer.byteLength(h.path) + String(h.line).length + Buffer.byteLength(h.text) + 4,
				0,
			);
		expect(answers[0]!.hits.length).toBeGreaterThan(500);
		for (const page of answers) expect(shown(page)).toBeLessThanOrEqual(SHOWN_BYTES);
		expect(shown(answers[0]!)).toBeGreaterThan(SHOWN_BYTES - 100);
		// A version 2 answer always says what it counted.
		expect(answers[0]).toMatchObject({ files: [], longLines: 0 });
		// Version 1 keeps its 6 KiB pages and its answer's shape.
		const old = await searchView(source, request("plan"));
		expect(Buffer.byteLength(JSON.stringify(old.hits))).toBeLessThanOrEqual(6 * 1024 + 200);
		expect(Object.keys(old).sort()).toEqual(["binary", "hits", "next", "reads", "searched", "unreadable"]);
	});

	it("shows lines before and after each hit, none twice, the same whatever the pieces, and goes on from any hit with them", async () => {
		const text = `${Array.from({ length: 14 }, (_, i) => `line ${i + 1}${[4, 5, 10].includes(i + 1) ? " plan" : ""}`).join("\n")}\n`;
		const starts = [0];
		for (let at = text.indexOf("\n"); at >= 0 && at < text.length - 1; at = text.indexOf("\n", at + 1))
			starts.push(at + 1);
		const shown = (page: SearchAnswer) =>
			page.hits.map(({ line, text, before, after, from }) => ({ line, text, before, after, from }));
		const expected = [
			{ line: 4, text: "line 4 plan", before: ["line 2", "line 3"], after: [], from: starts[1] },
			{ line: 5, text: "line 5 plan", before: [], after: ["line 6", "line 7"], from: starts[4] },
			{
				line: 10,
				text: "line 10 plan",
				before: ["line 8", "line 9"],
				after: ["line 11", "line 12"],
				from: starts[7],
			},
		];
		for (const pieceBytes of [7, 16, 64, 4096]) {
			const { source } = stage({ "a.md": text });
			const page = await searchView({ ...source, pieceBytes }, request2("plan", { context: 2 }));
			expect(shown(page), `pieces of ${pieceBytes}`).toEqual(expected);
			// The run shows a page in part and goes on from the first hit it left out, from its first line before.
			const third = page.hits[2]!;
			const rest = await searchView(
				{ ...source, pieceBytes },
				request2("plan", {
					context: 2,
					after: {
						path: "a.md",
						version: third.version,
						offset: third.from!,
						line: third.line - 1 - third.before!.length,
					},
				}),
			);
			expect(shown(rest)).toEqual(expected.slice(2));
		}
		// Pages that end on time keep every line around every hit: each goes on from the lines before the next hit.
		const late = stage({ "a.md": text, "b.md": text });
		const timed = await pages({ ...late.source, now: ticking(), pieceBytes: 8 }, request2("plan", { context: 2 }));
		expect(timed.length).toBeGreaterThan(2);
		const all = (await pages(late.source, request2("plan", { context: 2 }))).flatMap(shown);
		expect(timed.flatMap(shown)).toEqual(all);
		expect(all).toHaveLength(6);
	});

	it("counts the matching lines of each file with filesOnly, a file a page ended inside counted on by the next", async () => {
		const big = Array.from({ length: 500 }, (_, i) => (i % 2 === 0 ? `plan ${i}` : `other ${i}`)).join("\n");
		const { source } = stage({ "a.md": "plan\nx\nplan plan\n", "b.md": "nothing", "c/d.md": "PLAN\n", "e.md": big });
		const page = await searchView(source, request2("plan", { filesOnly: true }));
		expect(page.hits).toEqual([]);
		expect(page.files).toEqual([
			{ path: "a.md", version: v(2), count: 2 },
			{ path: "c/d.md", version: v(4), count: 1 },
			{ path: "e.md", version: v(5), count: 250 },
		]);
		expect(page.searched).toBe(4);
		const timed = await pages({ ...source, now: ticking() }, request2("plan", { filesOnly: true }));
		expect(timed.length).toBeGreaterThan(4);
		expect(timed.flatMap((p) => p.files ?? []).some((f) => f.partial)).toBe(true);
		expect(counted(timed)).toEqual([
			{ path: "a.md", count: 2 },
			{ path: "c/d.md", count: 1 },
			{ path: "e.md", count: 250 },
		]);
		// Many files fill a page by their lines too.
		const files: Record<string, string> = {};
		for (let i = 0; i < 2_000; i++) files[`f/${String(i).padStart(5, "0")}-${"n".repeat(40)}.md`] = "plan\n";
		const many = await pages(stage(files).source, request2("plan", { filesOnly: true }));
		expect(many.length).toBeGreaterThan(2);
		expect(counted(many)).toHaveLength(2_000);
	});

	it("finds names by glob alone", async () => {
		const { source } = stage({ "a.md": "x", "b.txt": "x", "docs/c.md": "x", "docs/notes/d.md": "x" });
		const page = await searchView(source, request2(null, { namesOnly: true, glob: "**/*.md" }));
		expect(page.hits.map((h) => h.path)).toEqual(["a.md", "docs/c.md", "docs/notes/d.md"]);
		expect(page.reads.map((r) => r.path)).toEqual(["a.md", "docs", "docs/c.md", "docs/notes", "docs/notes/d.md"]);
		const folders = await searchView(source, request2(null, { namesOnly: true, glob: "notes" }));
		expect(folders.hits.map((h) => [h.path, h.kind])).toEqual([["docs/notes", "folder"]]);
	});

	it.runIf(linearRegexAvailable())(
		"searches with a regular expression, in text and names, folded unless case-sensitive",
		async () => {
			const { source } = stage({
				"a.md": "Call 555-1234 now\nno number\nPLAN B\n",
				"plan-x.md": "nothing",
				"plans/q.md": "plans 12\n",
			});
			const text = (page: SearchAnswer) => page.hits.map((h) => `${h.path}:${h.line}:${h.text}`);
			expect(text(await searchView(source, request2("\\b\\d{3}-\\d{4}\\b", { regex: true })))).toEqual([
				"a.md:1:Call 555-1234 now",
			]);
			expect(text(await searchView(source, request2("^pl[a-z]n( b)?$", { regex: true })))).toEqual([
				"a.md:3:PLAN B",
			]);
			expect(
				text(await searchView(source, request2("^pl[a-z]n( b)?$", { regex: true, caseSensitive: true }))),
			).toEqual([]);
			// A final sigma is a sigma to a search that is not case-sensitive, in the text as in the pattern or query
			// (review r9 of #1698: the text lowercased whole gave ς at a word's end, the pattern letter by letter σ).
			const greek = stage({ "g.md": "ΟΣ\nΟΣΟ\nκόσμος\nάλλο\n" });
			const sigma = ["g.md:1:ΟΣ", "g.md:2:ΟΣΟ", "g.md:3:κόσμος"];
			expect(text(await searchView(greek.source, request2("ΟΣ", { regex: true })))).toEqual(sigma);
			expect(text(await searchView(greek.source, request2("ΟΣ")))).toEqual(sigma);
			expect(text(await searchView(greek.source, request2("ος", { regex: true })))).toEqual(sigma);
			expect(
				(await searchView(source, request2("^plans?(-x)?(\\.md)?$", { regex: true, namesOnly: true }))).hits.map(
					(h) => h.path,
				),
			).toEqual(["plan-x.md", "plans"]);
			// What RE2 refuses is refused before any work, with why.
			for (const [pattern, code] of [
				["(a)\\1", "REGEX_BACKREFERENCE"],
				["a(?=b)", "REGEX_LOOKAROUND"],
				["(?<!a)b", "REGEX_LOOKAROUND"],
				["(?i)a", "REGEX_FLAGS"],
				["a{1,100}", "REGEX_TOO_LARGE"],
				["(a{1,10}){1,10}", "REGEX_TOO_LARGE"],
				["[a", "REGEX_SYNTAX"],
				["a)", "REGEX_SYNTAX"],
				["\\q", "REGEX_ESCAPE"],
				["\\p{L}", "REGEX_ESCAPE"],
				["[[:alpha:]]", "REGEX_SYNTAX"],
			] as const)
				await expect(searchView(source, request2(pattern, { regex: true })), pattern).rejects.toThrow(
					new RegExp(`^${code}: `),
				);
			// Linear, whatever the pattern: what backtracks exponentially elsewhere takes no time here.
			const evil = stage({ "e.txt": `${"a".repeat(200_000)}\n` });
			const started = performance.now();
			const none = await searchView(
				{ ...evil.source, pieceBytes: 1 << 20 },
				request2("(a|aa)*(a*)*b", { regex: true }),
			);
			expect(none.hits).toEqual([]);
			expect(performance.now() - started).toBeLessThan(2_000);
		},
	);

	it.runIf(linearRegexAvailable())(
		"searches whole lines only with a pattern: a line too long is read past, unsearched, and counted",
		async () => {
			// Its anchors and word boundaries are never judged at a stretch's end: END$ in a line that goes on is no hit.
			const long = `${"x".repeat(100)}plan END${"x".repeat(100)}ENDsuffix`;
			const { source } = stage({ "a.txt": `first\n${long}\nplan three END\ntail` });
			for (const pattern of ["pl.n", "END$", "\\bEND\\b"]) {
				const page = await searchView({ ...source, longestLine: 40 }, request2(pattern, { regex: true }));
				expect(
					page.hits.map((h) => h.line),
					pattern,
				).toEqual([3]);
				expect(page.longLines).toBe(1);
			}
			// Its lines around a hit are kept as any line's: the long one shows its start.
			const around = await searchView(
				{ ...source, longestLine: 40 },
				request2("three", { regex: true, context: 1 }),
			);
			expect(around.hits[0]).toMatchObject({
				line: 3,
				before: [expect.stringMatching(/^x{40,}$/)],
				after: ["tail"],
			});
			// Text is still searched in stretches, as before.
			const literal = await searchView({ ...source, longestLine: 40 }, request2("plan"));
			expect(literal.hits.map((h) => h.line)).toEqual([2, 3]);
			expect(literal.longLines).toBe(0);
		},
	);

	it.runIf(linearRegexAvailable())("judges a pattern's line by its own length, however the pieces fall", async () => {
		// With lines of at most 40 bytes searched: 41 x's are too long, 40 are not, wherever the line starts.
		const lines = (prefix: string) => `${prefix}${"x".repeat(41)}\n${"x".repeat(40)}\nb\n${"x".repeat(41)}`;
		for (const prefix of ["", "a\n", "ab\n"])
			for (const pieceBytes of [7, 16, 41, 64, 4096]) {
				const { source } = stage({ "a.txt": lines(prefix) });
				const page = await searchView(
					{ ...source, pieceBytes, longestLine: 40 },
					request2("^x+$", { regex: true }),
				);
				const at = prefix === "" ? 0 : 1;
				expect(
					page.hits.map((h) => h.line),
					`${JSON.stringify(prefix)} in pieces of ${pieceBytes}`,
				).toEqual([2 + at]);
				expect(page.longLines).toBe(2);
				// So are they when the pattern matches nothing anywhere.
				const none = await searchView({ ...source, pieceBytes, longestLine: 40 }, request2("^q$", { regex: true }));
				expect(none.hits).toEqual([]);
				expect(none.longLines, `${JSON.stringify(prefix)} in pieces of ${pieceBytes}, no match`).toBe(2);
			}
	});

	it.runIf(linearRegexAvailable())("matches a pattern on empty lines too, and counts them", async () => {
		const { source } = stage({ "a.txt": "a\n\nb\n\n\nc" });
		expect((await searchView(source, request2("^$", { regex: true }))).hits.map((h) => h.line)).toEqual([2, 4, 5]);
		expect((await searchView(source, request2("^$", { regex: true, filesOnly: true }))).files).toEqual([
			{ path: "a.txt", version: v(1), count: 3 },
		]);
	});

	it("ends the count of a file a page began inside, with 0 when nothing more matched there", async () => {
		const { source } = stage({ "a.md": `plan\nplan\n${"x\n".repeat(40)}`, "b.md": "plan\n" });
		const timed = await pages({ ...source, now: ticking() }, request2("plan", { filesOnly: true }));
		const a = timed.flatMap((p) => p.files ?? []).filter((f) => f.path === "a.md");
		expect(a[0]).toMatchObject({ count: 2, partial: true });
		expect(a.at(-1)).toEqual({ path: "a.md", version: v(1), count: 0 });
		expect(counted(timed)).toEqual([
			{ path: "a.md", count: 2 },
			{ path: "b.md", count: 1 },
		]);
	});

	it.runIf(linearRegexAvailable())("matches as a case-folding regular expression does", () => {
		const cases: [string, string][] = [
			["Straße", "STRASSE straße"],
			["[A-C]x+", "bXX"],
			["[^a-z]", "ABC"],
			["ÆØÅ", "æøå"],
			["[À-Þ]", "é"],
			["\\u00c9t\\x{E9}", "été"],
			["\\w+\\s\\d", "Word 7"],
			["(?:ab|cd){2}", "ABCD"],
			["ß", "ẞ"],
			["a.c", "A\nC"],
			// A final sigma (review r9 of #1698): JavaScript's /iu folds ς, σ and Σ alike, and so does foldText.
			["ΟΣ", "ΟΣ"],
			["ος", "ΚΟΣΜΟΣ"],
			["[ς]", "Σ"],
			["κόσμος", "ΚΌΣΜΟΣ"],
		];
		for (const [pattern, subject] of cases) {
			const ours = compilePattern(pattern, false).test(foldText(subject));
			const js = new RegExp(pattern.replace("\\x{E9}", "\\u00e9"), "imu").test(subject);
			expect(ours, `${pattern} on ${subject}`).toBe(js);
		}
		expect(() => compilePattern("[😀]", true)).toThrow(SearchPatternError);
	});
});
