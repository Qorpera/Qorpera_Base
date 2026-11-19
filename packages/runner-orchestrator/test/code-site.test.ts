import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { inflateSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import {
	CODE_CHECKS_DRILL,
	CODE_CHECKS_NEWER_RUN,
	CODE_DRILL_WORDS,
	CODE_SITE_COLLECT,
	CODE_SITE_DRILL_FOLDER,
	CODE_SITE_DROP,
	CODE_SITE_EXTENSIONS,
	CODE_SITE_NAME_RULE,
	CODE_SITE_PATH,
	CODE_SITE_RESERVED_NAMES,
	type CodeSiteProblem,
	codeSiteCollectAnswer,
	codeSiteDropAnswer,
	codeSiteFolderValid,
	codeSiteManifest,
	codeSiteNameRefusal,
	codeSiteNameValid,
	codeSiteRefusedSummary,
	codeSiteReported,
	codeSiteTitleValid,
	codeSiteTreeProblem,
} from "../src/code-site.ts";

const exec = promisify(execFile);
const MiB = 1024 * 1024;
const TREE = "a".repeat(40);
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const sha1 = (data: Buffer | string) => createHash("sha1").update(data).digest("hex");
const blobId = (data: Buffer | string) => {
	const content = typeof data === "string" ? Buffer.from(data) : data;
	return sha1(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content]));
};
const SITES_SQL = readFileSync(
	new URL("../../../supabase/migrations/20260930550000_company_sites.sql", import.meta.url),
	"utf8",
);
/** One body of a function of the sites' migration. */
const sqlFunction = (name: string) => {
	const start = SITES_SQL.indexOf(`create function public.${name}(`);
	return SITES_SQL.slice(start, SITES_SQL.indexOf("$$;", start));
};
/** The names a site never takes, as the newest migration that defines `qorpera_site_reserved_names()` has them, with
 * that migration's name and text; null while no migration of this tree names the function (step 5's,
 * `20260930756000_site_hosts.sql`, is not in it yet). One that names it in a way this does not read throws. */
const RESERVED_SQL = () => {
	const folder = new URL("../../../supabase/migrations/", import.meta.url);
	const naming = readdirSync(folder)
		.filter((name) => name.endsWith(".sql"))
		.sort()
		.map((name) => ({ name, text: readFileSync(new URL(name, folder), "utf8") }))
		.filter(({ text }) => text.includes("qorpera_site_reserved_names"));
	if (naming.length === 0) return null;
	const newest = naming.filter(({ text }) => text.includes("function public.qorpera_site_reserved_names()")).at(-1);
	const text =
		newest &&
		/function public\.qorpera_site_reserved_names\(\)[^$]*\$\$\s*--[^\n]*\n\s*select '([^']*)'::text\s*\$\$;/.exec(
			newest.text,
		)?.[1];
	if (!newest || text === undefined) throw new Error("qorpera_site_reserved_names() is not as this test reads it");
	return { name: newest.name, text, migration: newest.text };
};

describe("the site's rules, as the database's", () => {
	it("serves exactly the 30 extensions qorpera_site_content_type maps, and its path rule", () => {
		const mapped = [...sqlFunction("qorpera_site_content_type").matchAll(/when '([a-z0-9]+)' then/g)].map(
			(m) => m[1],
		);
		expect(mapped).toHaveLength(30);
		expect([...CODE_SITE_EXTENSIONS].sort()).toEqual([...mapped].sort());
		const rule = /p_path ~ '([^']+)'/.exec(sqlFunction("qorpera_site_path_valid"))?.[1];
		expect(CODE_SITE_PATH.source.replaceAll("\\/", "/")).toBe(rule);
		expect(sqlFunction("qorpera_site_path_valid")).toContain("char_length(p_path) <= 512");
	});

	it("takes a site's name as qorpera_site_slug_valid does: its rule and D20 of 756000", () => {
		for (const name of ["abc", "gift-message", "saml-gift-message", "a".repeat(48), "000", "a-b-c"])
			expect(codeSiteNameValid(name), name).toBe(true);
		for (const name of ["ab", "a".repeat(49), "-ab", "ab-", "aBc", "a_b", "a.b", "", " abc", "abc\n", "ab c"])
			expect(codeSiteNameValid(name), JSON.stringify(name)).toBe(false);
		// D20 (STEP5-BUILD.md): never two hyphens in a row, never ending -preview, never holding qorpera, and none of the
		// 118 names. A1's own cases (1252, section 3) among them: look-shop, webshop and shop-next are names; shop is not.
		for (const name of [
			"look-shop",
			"webshop",
			"shop-next",
			"next-shop",
			"preview-shop",
			"shop-previews",
			"shoppreview",
			"my-app",
			"qorper-a",
			`${"a".repeat(39)}-preview1`,
		])
			expect(codeSiteNameValid(name), name).toBe(true);
		for (const name of [
			"a--b",
			"shop--app",
			"look--shop",
			"xn--abc",
			"ab--next",
			"shop---next",
			"x--next--next",
			"shop-preview",
			"app-preview",
			"a-preview",
			"qorpera",
			"qorpera-shop",
			"myqorpera",
			"shop-qorpera-x",
			"shop",
			"docs",
			"next",
			"preview",
			"screens",
			"edge",
			"inbox",
			"beta",
		])
			expect(codeSiteNameValid(name), name).toBe(false);
	});

	it("keeps the reserved text byte for byte as migration 20260930756000 has it, and fails while they differ", () => {
		const names = CODE_SITE_RESERVED_NAMES.split(" ");
		expect(names).toHaveLength(118);
		expect(new Set(names).size).toBe(118);
		for (const name of names) {
			expect(name, name).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
			expect(codeSiteNameValid(name), name).toBe(false);
			// Only the name itself is refused: one more part makes it a name (but where it then holds qorpera).
			if (!name.includes("qorpera")) expect(codeSiteNameValid(`${name}-x1`), name).toBe(true);
		}
		const kept = RESERVED_SQL();
		if (kept === null) return;
		expect(kept.text).toBe(CODE_SITE_RESERVED_NAMES);
	});

	it("says the rule in the kernel's one sentence, byte for byte", () => {
		// The lead's words (13 Nov 2026, the cross-check's seam 2), the same on every path that refuses a name.
		expect(CODE_SITE_NAME_RULE).toBe(
			"A site's name is 3 to 48 characters of a to z, 0 to 9 and single hyphens, starts and ends with a letter or digit, does not end in -preview, does not contain qorpera, and is not a reserved name (such as app, api, mail, shop, login).",
		);
	});

	it("says which part of the rule a name breaks, within the 300 bytes a refusal shows whole", () => {
		const rule = CODE_SITE_NAME_RULE;
		const after = " Pick another, or leave name out.";
		for (const [name, broken] of [
			["ab", ""],
			["Shop", ""],
			["a".repeat(49), ""],
			["a--b", " This one has two hyphens in a row."],
			["shop--preview", " This one has two hyphens in a row."],
			["shop-preview", " This one ends in -preview."],
			["qorpera-shop", " This one contains qorpera."],
			["shopqorpera", " This one contains qorpera."],
			["qorpera", " This one contains qorpera."],
			["shop", " This one is a reserved name."],
			["well-known", " This one is a reserved name."],
		] as const) {
			const words = codeSiteNameRefusal(name);
			expect(words, name).toBe(`${rule}${broken}${after}`);
			expect(bytes(words as string)).toBeLessThanOrEqual(300);
		}
		for (const name of ["look-shop", "saml-gift-message", "a".repeat(48)])
			expect(codeSiteNameRefusal(name)).toBeNull();
	});

	it("takes a folder and a title as the kernel keeps a made site's", () => {
		for (const folder of [".", "dist", "a/b", ".output/public", "a".repeat(300)])
			expect(codeSiteFolderValid(folder)).toBe(true);
		for (const folder of ["", "/a", "a/", "a//b", "./a", "a/..", "a\u0085b", "a b", "a\\b", "a".repeat(301)])
			expect(codeSiteFolderValid(folder)).toBe(false);
		for (const title of ["x", "Shop", " Shop", "🙂".repeat(120)]) expect(codeSiteTitleValid(title)).toBe(true);
		for (const title of ["", " x", "x ", "a\nb", "a\u0085b", "a b", "x".repeat(121)])
			expect(codeSiteTitleValid(title)).toBe(false);
	});
});

const file = (path: string, size = 10, mode = "100644") => ({ mode, type: "blob", path, bytes: size });
const problem = (code: CodeSiteProblem["code"], path: string | null = null): CodeSiteProblem => ({
	code,
	path,
	variable: null,
});

describe("the tree's rules (codeSiteTreeProblem), for the upload pass", () => {
	it("takes a site and names the first problem in C order, a rule at a time", () => {
		expect(codeSiteTreeProblem([file("index.html"), file("a/b.css"), file("A.JS")])).toBeNull();
		expect(codeSiteTreeProblem([file("a.css")])).toEqual(problem("SITE_NO_INDEX"));
		expect(codeSiteTreeProblem([file("x/index.html")])).toEqual(problem("SITE_NO_INDEX"));
		expect(codeSiteTreeProblem([])).toEqual(problem("SITE_NO_INDEX"));
		for (const bad of [
			file("index.html", 1, "120000"),
			file("index.html", 1, "160000"),
			file(".well-known/a.json"),
			file("a b.html"),
			file("notes.md"),
			file("LICENSE"),
			file("-a.js"),
		])
			expect(codeSiteTreeProblem([bad, file("index.html")])).toEqual(problem("SITE_FILE_NAME", bad.path));
		expect(codeSiteTreeProblem([file("index.html"), file("b.png", 10 * MiB + 1), file("a b.html")])).toEqual(
			problem("SITE_FILE_NAME", "a b.html"),
		);
		expect(codeSiteTreeProblem([file("index.html"), file("b.png", 10 * MiB + 1)])).toEqual(
			problem("SITE_FILE_TOO_LARGE", "b.png"),
		);
	});

	it("holds each bound and refuses one more", () => {
		const many = (count: number) => [
			file("index.html"),
			...Array.from({ length: count - 1 }, (_, i) => file(`f/${i}.js`)),
		];
		expect(codeSiteTreeProblem(many(500))).toBeNull();
		expect(codeSiteTreeProblem(many(501))).toEqual(problem("SITE_TOO_MANY_FILES"));
		const folders = (count: number) => [
			file("index.html"),
			file("n/m/deep.js"),
			...Array.from({ length: count - 2 }, (_, i) => file(`f${i}/a.js`)),
		];
		expect(codeSiteTreeProblem(folders(100))).toBeNull();
		expect(codeSiteTreeProblem(folders(101))).toEqual(problem("SITE_TOO_MANY_FOLDERS"));
		expect(codeSiteTreeProblem([file("index.html", 10 * MiB)])).toBeNull();
		const total = (extra: number) => [
			file("index.html", 10 * MiB),
			file("a.png", 10 * MiB),
			file("b.png", 5 * MiB + extra),
		];
		expect(codeSiteTreeProblem(total(0))).toBeNull();
		expect(codeSiteTreeProblem(total(1))).toEqual(problem("SITE_TOO_LARGE"));
		const deep = (parts: number) => `${Array.from({ length: parts - 1 }, () => "d").join("/")}/x.js`;
		expect(codeSiteTreeProblem([file("index.html"), file(deep(16))])).toBeNull();
		expect(codeSiteTreeProblem([file("index.html"), file(deep(17))])).toEqual(problem("SITE_FILE_NAME", deep(17)));
		const long = (length: number) => `${"a".repeat(200)}/${"b".repeat(200)}/${"c".repeat(length - 405)}.js`;
		expect(long(512)).toHaveLength(512);
		expect(codeSiteTreeProblem([file("index.html"), file(long(512))])).toBeNull();
		expect(codeSiteTreeProblem([file("index.html"), file(long(513))])).toEqual(problem("SITE_FILE_NAME", long(513)));
	});
});

describe("the manifest", () => {
	it("is site-tools': a fixed vector, whatever order the files come in", () => {
		const files = [
			{ path: "index.html", bytes: 12, sha256: "737e6daf77521604fc482aa91e8bed8c47f4815c624e61e49c45ecbb5832f708" },
			{ path: "a/b.css", bytes: 7, sha256: "2708d73bf31c36cdfa1aa466551ed101017280fa546caba4473cfef6e92a93b5" },
			{ path: "a.js", bytes: 2, sha256: "73cb3858a687a8494ca3323053016282f3dad39d42cf62ca4e79dda2aac7d9ac" },
			{ path: "Z.txt", bytes: 0, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
		];
		// Computed by Python's hashlib from the lines "Z.txt", "a.js", "a/b.css", "index.html" (bytes' order).
		const expected = "e331ce30e6728fee58f95aa8e4c2feef97899382c96a3903f9a5f76902203ed2";
		expect(codeSiteManifest(files)).toBe(expected);
		expect(codeSiteManifest([...files].reverse())).toBe(expected);
	});
});

describe("the collect's and the drop's answers", () => {
	const made = (lines: string) => codeSiteCollectAnswer(lines, 0);
	it("reads the three lines of a made site, and nothing else as made", () => {
		expect(made(`tree ${TREE}\nfiles 3\nbytes 1024\n`)).toEqual({ made: { tree: TREE, files: 3, bytes: 1024 } });
		expect(made(`tree ${TREE}\nfiles 500\nbytes 26214400\n`)).toEqual({
			made: { tree: TREE, files: 500, bytes: 26214400 },
		});
		expect(made(`tree ${TREE}\nfiles 1\nbytes 0\n`)).toEqual({ made: { tree: TREE, files: 1, bytes: 0 } });
		for (const output of [
			`tree ${TREE}\nfiles 3\nbytes 1024`,
			`tree ${TREE}\nfiles 3\nbytes 1024\nmanifest ${"b".repeat(64)}\n`,
			`tree ${TREE}\nfiles 3\n`,
			`tree ${"A".repeat(40)}\nfiles 3\nbytes 1\n`,
			`tree ${"a".repeat(39)}\nfiles 3\nbytes 1\n`,
			`tree ${TREE}\nfiles 0\nbytes 1\n`,
			`tree ${TREE}\nfiles 501\nbytes 1\n`,
			`tree ${TREE}\nfiles 03\nbytes 1\n`,
			`tree ${TREE}\nfiles 3\nbytes 26214401\n`,
			`tree ${TREE}\nfiles 3\nbytes ********\n`,
			`warning: x\ntree ${TREE}\nfiles 3\nbytes 1\n`,
			`tree ${TREE}\r\nfiles 3\r\nbytes 1\r\n`,
			"",
		])
			expect(made(output)).toBeNull();
		for (const exitCode of [1, 2, 4, 91, 137, null])
			expect(codeSiteCollectAnswer(`tree ${TREE}\nfiles 3\nbytes 1\n`, exitCode)).toBeNull();
	});

	it("reads each code of a refused site with the detail it has", () => {
		const refused = (line: string) => codeSiteCollectAnswer(line, 3);
		for (const code of [
			"SITE_FOLDER_MISSING",
			"SITE_NO_INDEX",
			"SITE_TOO_MANY_FILES",
			"SITE_TOO_MANY_FOLDERS",
			"SITE_TOO_LARGE",
		] as const) {
			expect(refused(`${code}\n`)).toEqual({ problem: problem(code) });
			expect(refused(`${code} x\n`)).toBeNull();
			expect(codeSiteCollectAnswer(`${code}\n`, 0)).toBeNull();
		}
		expect(refused("SITE_FILE_TOO_LARGE media/movie.mp4\n")).toEqual({
			problem: problem("SITE_FILE_TOO_LARGE", "media/movie.mp4"),
		});
		expect(refused("SITE_FILE_NAME my page.html\n")).toEqual({ problem: problem("SITE_FILE_NAME", "my page.html") });
		// Bytes outside printable ASCII, and backslashes, come as \xHH: read back as the name's UTF-8.
		expect(refused("SITE_FILE_NAME caf\\xc3\\xa9/a\\x5cb\\x0a.html\n")).toEqual({
			problem: problem("SITE_FILE_NAME", "café/a\\b\n.html"),
		});
		expect(refused("SITE_FILE_NAME bad\\xff.js\n")).toEqual({ problem: problem("SITE_FILE_NAME", "bad�.js") });
		expect(refused("SITE_HOLDS_SECRET STRIPE_KEY js/app.js\n")).toEqual({
			problem: { code: "SITE_HOLDS_SECRET", path: "js/app.js", variable: "STRIPE_KEY" },
		});
		// The variable alone: the value is in a path the collect does not name.
		expect(refused("SITE_HOLDS_SECRET STRIPE_KEY\n")).toEqual({
			problem: { code: "SITE_HOLDS_SECRET", path: null, variable: "STRIPE_KEY" },
		});
		// Links from the root: the file (a path of the site, no space in it) and how many it has, never a link (review
		// round 3 of #1691).
		expect(refused("SITE_LINKS_FROM_ROOT index.html 3\n")).toEqual({
			problem: { code: "SITE_LINKS_FROM_ROOT", path: "index.html", variable: null, links: 3 },
		});
		expect(refused("SITE_LINKS_FROM_ROOT css/a.css 1\n")).toEqual({
			problem: { code: "SITE_LINKS_FROM_ROOT", path: "css/a.css", variable: null, links: 1 },
		});
		// A detail that would not fit whole is left out (review of #1691, F1): the code alone.
		expect(refused("SITE_FILE_NAME\n")).toEqual({ problem: problem("SITE_FILE_NAME") });
		expect(refused("SITE_FILE_TOO_LARGE\n")).toEqual({ problem: problem("SITE_FILE_TOO_LARGE") });
		expect(refused("SITE_LINKS_FROM_ROOT\n")).toEqual({
			problem: { code: "SITE_LINKS_FROM_ROOT", path: null, variable: null, links: null },
		});
		// A detail of 1,000 bytes, the most the collect writes.
		expect(refused(`SITE_FILE_NAME ${"\\xc3\\xa9".repeat(125)}\n`)).toEqual({
			problem: problem("SITE_FILE_NAME", "\u00e9".repeat(125)),
		});
		for (const line of [
			"SITE_HOLDS_SECRET\n",
			"SITE_HOLDS_SECRET 1KEY\n",
			"SITE_HOLDS_SECRET STRIPE_KEY \n",
			// Only the collect's own spelling (release review, F1): a printable byte written as an escape, an escape in
			// upper case or cut, a backslash or a byte outside printable ASCII as itself, more than 1,000 bytes.
			"SITE_FILE_NAME a\\x41PI-KEY.js\n",
			"SITE_FILE_TOO_LARGE big/\\x2fetc.mp4\n",
			"SITE_HOLDS_SECRET KEY a\\x20b.js\n",
			"SITE_FILE_NAME caf\\xC3\\xA9.js\n",
			"SITE_FILE_NAME caf\\xc3\\xa.js\n",
			"SITE_FILE_NAME caf\\xc3\\xa\n",
			"SITE_FILE_NAME a\\b.js\n",
			"SITE_FILE_NAME caf\u00e9.js\n",
			"SITE_FILE_NAME a\tb.js\n",
			`SITE_FILE_NAME ${"\\xc3\\xa9".repeat(125)}a\n`,
			"SITE_HOLDS_SECRET 1KEY js/app.js\n",
			"SITE_HOLDS_SECRET KEY-1 js/app.js\n",
			"SITE_LINKS_FROM_ROOT index.html\n",
			"SITE_LINKS_FROM_ROOT index.html /src/style.css\n",
			"SITE_LINKS_FROM_ROOT index.html 1 /src/style.css\n",
			"SITE_LINKS_FROM_ROOT index.html 0\n",
			"SITE_LINKS_FROM_ROOT index.html 03\n",
			"SITE_LINKS_FROM_ROOT index.html 1234567890\n",
			"SITE_LINKS_FROM_ROOT index.html 3 \n",
			"SITE_LINKS_FROM_ROOT  3\n",
			"SITE_LINKS_FROM_ROOT 3\n",
			"SITE_UNHEARD_OF\n",
			"SITE_NO_INDEX",
			"SITE_NO_INDEX\nSITE_NO_INDEX\n",
			"warning: x\nSITE_NO_INDEX\n",
			"site_no_index\n",
			"",
		])
			expect(refused(line)).toBeNull();
	});

	it("reads the drop's one line", () => {
		expect(codeSiteDropAnswer("dropped 0\n", 0)).toBe(0);
		expect(codeSiteDropAnswer("dropped 601\n", 0)).toBe(601);
		for (const [output, exitCode] of [
			["dropped 3\n", 91],
			["dropped 3\n", 1],
			["dropped 3\n", null],
			["dropped 3", 0],
			["dropped -1\n", 0],
			["dropped 03\n", 0],
			["x\ndropped 3\n", 0],
			["", 0],
		] as const)
			expect(codeSiteDropAnswer(output, exitCode)).toBeNull();
	});
});

describe("the report's site", () => {
	const MADE = { state: "made", tree: TREE, files: 3, bytes: 1024, folder: "dist", name: null, title: null } as const;
	it("is exactly what the kernel takes", () => {
		expect(codeSiteReported(null)).toBeNull();
		expect(codeSiteReported(MADE)).toEqual({
			state: "made",
			site: {
				schema: "qorpera.code-site/v1",
				tree: TREE,
				files: 3,
				bytes: 1024,
				folder: "dist",
				name: null,
				title: null,
			},
		});
		expect(
			codeSiteReported({ ...MADE, folder: ".", name: "look-shop", title: "The shop", files: 500, bytes: 0 }),
		).toEqual({
			state: "made",
			site: {
				schema: "qorpera.code-site/v1",
				tree: TREE,
				files: 500,
				bytes: 0,
				folder: ".",
				name: "look-shop",
				title: "The shop",
			},
		});
		expect(codeSiteReported({ state: "missed", code: "CODE_SITE_COLLECT_EXIT_4" })).toEqual({
			state: "missed",
			code: "CODE_SITE_COLLECT_EXIT_4",
		});
	});

	it("throws for a value the kernel would refuse", () => {
		for (const bad of [
			{ ...MADE, tree: "A".repeat(40) },
			{ ...MADE, files: 0 },
			{ ...MADE, files: 501 },
			{ ...MADE, files: 1.5 },
			{ ...MADE, bytes: -1 },
			{ ...MADE, bytes: 25 * MiB + 1 },
			{ ...MADE, folder: "../x" },
			{ ...MADE, name: "api" },
			// The name rule of step 5 (D20), which the kernel holds from migration 20260930756000 on.
			{ ...MADE, name: "shop" },
			{ ...MADE, name: "look--shop" },
			{ ...MADE, name: "look-preview" },
			{ ...MADE, name: "qorpera-look" },
			{ ...MADE, title: " x" },
			{ ...MADE, title: "" },
		])
			expect(() => codeSiteReported(bad)).toThrow("INVALID_CODE_SITE");
		for (const code of ["", "lower", "A".repeat(121), "A B"])
			expect(() => codeSiteReported({ state: "missed", code })).toThrow("INVALID_CODE_SITE");
	});
});

describe("the words of a refused site", () => {
	const head = 'Nothing went into main: every check passed, but the site in "dist" ';
	const foot = ` Fix it in the code or in the checks file's "site", and finish again. [code=CODING_CHECKS_SITE_REFUSED]`;
	const key = " A key must never be built into the site.";
	it("says what is wrong, byte for byte", () => {
		const said = (value: CodeSiteProblem) => codeSiteRefusedSummary(value, "dist");
		expect(said(problem("SITE_FOLDER_MISSING"))).toBe(
			`${head}is not there (no folder of that name once the checks ran; a link is not followed).${foot}`,
		);
		expect(said(problem("SITE_NO_INDEX"))).toBe(`${head}has no index.html at its top.${foot}`);
		expect(said(problem("SITE_TOO_MANY_FILES"))).toBe(`${head}has more than 500 web files.${foot}`);
		expect(said(problem("SITE_TOO_MANY_FOLDERS"))).toBe(`${head}has web files in more than 100 folders.${foot}`);
		expect(said(problem("SITE_FILE_TOO_LARGE", "media/a.mp4"))).toBe(
			`${head}has a file over 10 MB: media/a.mp4.${foot}`,
		);
		expect(said(problem("SITE_TOO_LARGE"))).toBe(`${head}is over 25 MB.${foot}`);
		expect(said(problem("SITE_FILE_NAME", "my page.html"))).toBe(
			`${head}has a file whose name a site cannot serve: my page.html (only letters, digits, dots, hyphens and underscores, each part starting with a letter, a digit or an underscore and at most 200 bytes, at most 16 parts and 512 bytes in all).${foot}`,
		);
		expect(said({ code: "SITE_HOLDS_SECRET", path: "js/app.js", variable: "STRIPE_KEY" })).toBe(
			`${head}holds the value of STRIPE_KEY in js/app.js.${key}${foot}`,
		);
		expect(said(problem("SITE_HOLDS_SECRET"))).toBe(`${head}holds one of this session's secret values.${key}${foot}`);
		// A path that holds a secret value is never named (release review, F1).
		expect(said({ code: "SITE_HOLDS_SECRET", path: null, variable: "STRIPE_KEY" })).toBe(
			`${head}holds the value of STRIPE_KEY in one of its files or file names.${key}${foot}`,
		);
		expect(said(problem("SITE_FILE_TOO_LARGE"))).toBe(`${head}has a file over 10 MB.${foot}`);
		// Links from the root: the file and how many, never a link; one; no file to be shown.
		const relative =
			'. A site is served under an address of its own, never at the top of a domain: link its files with relative links (src/app.js, ../img/logo.png), in its scripts too, which Qorpera does not read, or set your bundler\'s base path (Vite: base: "./").';
		expect(said({ code: "SITE_LINKS_FROM_ROOT", path: "index.html", variable: null, links: 3 })).toBe(
			`${head}has links that start with / in index.html (3 of them)${relative}${foot}`,
		);
		expect(said({ code: "SITE_LINKS_FROM_ROOT", path: "css/a.css", variable: null, links: 1 })).toBe(
			`${head}has a link that starts with / in css/a.css${relative}${foot}`,
		);
		expect(said({ code: "SITE_LINKS_FROM_ROOT", path: null, variable: null, links: null })).toBe(
			`${head}has a link that starts with /${relative}${foot}`,
		);
		expect(said(problem("SITE_FILE_NAME"))).toBe(
			`${head}has a file whose name a site cannot serve (only letters, digits, dots, hyphens and underscores, each part starting with a letter, a digit or an underscore and at most 200 bytes, at most 16 parts and 512 bytes in all).${foot}`,
		);
	});

	it("shows a hostile name on one line and whole, and leaves it out rather than cut it past 3,500 bytes", () => {
		const fits = codeSiteRefusedSummary(problem("SITE_FILE_NAME", `a\nb‮${"x".repeat(900)}.html`), "web/‮dist");
		expect(fits).toContain(
			`the site in "web/�dist" has a file whose name a site cannot serve: a�b�${"x".repeat(900)}.html (only letters`,
		);
		expect(fits.split("\n")).toHaveLength(1);
		// Review of #1691, F1: a path is never cut, since a cut one can carry the start of a secret value no mask knows
		// whole. Past the words' 3,500 bytes it is left out.
		const name = codeSiteRefusedSummary(problem("SITE_FILE_NAME", `a${"x".repeat(5000)}.html`), "dist");
		expect(name).toContain('the site in "dist" has a file whose name a site cannot serve (only letters');
		expect(name).not.toContain("xxxxxxxx");
		const largest = codeSiteRefusedSummary(
			{ code: "SITE_HOLDS_SECRET", path: "é".repeat(5000), variable: "A".repeat(128) },
			"é".repeat(150),
		);
		expect(bytes(largest)).toBeLessThanOrEqual(3500);
		expect(largest).toContain(`holds the value of ${"A".repeat(128)} in one of its files or file names.`);
		expect(largest.endsWith("[code=CODING_CHECKS_SITE_REFUSED]")).toBe(true);
		const links = (path: string) =>
			codeSiteRefusedSummary({ code: "SITE_LINKS_FROM_ROOT", path, variable: null, links: 2 }, "é".repeat(150));
		const long = links("p".repeat(3000));
		expect(bytes(long)).toBeLessThanOrEqual(3500);
		expect(long).toContain("has a link that starts with /. A site is served");
		expect(long).not.toContain("pppppppp");
		const whole = links(`a/${"b".repeat(500)}.html`);
		expect(whole).toContain(`has links that start with / in a/${"b".repeat(500)}.html (2 of them). A site`);
	});

	it("starts with an operator's drill's words when given them, counted within the 3,500 bytes (step 5)", () => {
		expect(CODE_DRILL_WORDS).toBe(
			"This was a drill by Qorpera's operator: nothing is wrong with your work, and the next try goes through. Finish again.",
		);
		const opening = `${CODE_DRILL_WORDS} `;
		// The site drill's own refusal, byte for byte.
		expect(codeSiteRefusedSummary(problem("SITE_FOLDER_MISSING"), CODE_SITE_DRILL_FOLDER, opening)).toBe(
			`${CODE_DRILL_WORDS} Nothing went into main: every check passed, but the site in "qorpera-drill-missing" is not there (no folder of that name once the checks ran; a link is not followed). Fix it in the code or in the checks file's "site", and finish again. [code=CODING_CHECKS_SITE_REFUSED]`,
		);
		for (const value of [problem("SITE_NO_INDEX"), problem("SITE_FILE_NAME", "a b.html")])
			expect(codeSiteRefusedSummary(value, "dist", opening)).toBe(
				`${opening}${codeSiteRefusedSummary(value, "dist")}`,
			);
		// A path that fits without the words but not with them is left out, never cut; the words stay.
		const path = `a/${"b".repeat(3000)}.html`;
		const without = codeSiteRefusedSummary(problem("SITE_FILE_NAME", path), "dist");
		expect(without).toContain(path);
		const said = codeSiteRefusedSummary(
			problem("SITE_FILE_NAME", path),
			"dist",
			`${"w".repeat(3500 - bytes(without) + 1)} `,
		);
		expect(bytes(said)).toBeLessThanOrEqual(3500);
		expect(said).not.toContain("bbbbbbbb");
		expect(said.startsWith("www")).toBe(true);
	});
});

describe("an operator's drill (step 5, D17)", () => {
	it("is a check the checks file could hold, which says it is a drill and fails, and a folder that can be a site's", async () => {
		expect(CODE_CHECKS_DRILL).toEqual({
			name: "qorpera-drill",
			run: `echo "A drill by Qorpera's operator: this check fails on purpose, once."; exit 1`,
			timeoutSeconds: 10,
			cwd: ".",
		});
		expect(CODE_SITE_DRILL_FOLDER).toBe("qorpera-drill-missing");
		expect(codeSiteFolderValid(CODE_SITE_DRILL_FOLDER)).toBe(true);
		// Run as a check runs it (bash -c, no profile): its words, then exit 1.
		const ran = await exec("bash", ["--noprofile", "--norc", "-c", CODE_CHECKS_DRILL.run]).then(
			(done) => ({ code: 0, out: done.stdout }),
			(error: { code: number; stdout: string }) => ({ code: error.code, out: error.stdout }),
		);
		expect(ran).toEqual({ code: 1, out: "A drill by Qorpera's operator: this check fails on purpose, once.\n" });
	});
});

describe("the commands' texts", () => {
	it("begin with the run's guard, are ASCII and within the guest's 16 KiB", () => {
		for (const command of [CODE_SITE_COLLECT, CODE_SITE_DROP]) {
			expect(command.startsWith(`${CODE_CHECKS_NEWER_RUN.join("\n")}\nexec 2>`)).toBe(true);
			expect(bytes(command)).toBeLessThanOrEqual(16384);
			expect(/^[\t\n\x20-\x7e]*$/.test(command)).toBe(true);
		}
	});
});

// The commands on the machine: run for real with bash, python3 and git, as the guest runs them (bash -c, the run's
// folder in a home of the test's own, stdout and stderr into one output), against a bare repository as the
// repository's storage. -------------------------------------------------------------------------------------------------

const roots: string[] = [];
afterAll(async () => {
	for (const root of roots.splice(0)) {
		await exec("chmod", ["-R", "u+rwx", root]).catch(() => undefined);
		await rm(root, { recursive: true, force: true });
	}
});

const runName = (sequence: number, attempt = 1) =>
	`${String(sequence).padStart(10, "0")}-${String(attempt).padStart(4, "0")}`;
const PATH = "/usr/local/bin:/usr/bin:/bin";
type Content = string | Buffer | { link: string } | { fifo: true };

async function machine() {
	const top = await realpath(await mkdtemp(join(tmpdir(), "code-site-")));
	roots.push(top);
	const home = join(top, "home"),
		root = join(home, ".qorpera-checks"),
		repository = join(top, "repo.git");
	await mkdir(root, { recursive: true });
	const gitEnv = { PATH, HOME: top, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
	/** git as the test runs it, on the repository's storage unless told otherwise. A git that ends before it read its
	 * stdin (EPIPE on the pipe; git commands that take no input do) is not an error of the test: the call is judged by
	 * git's exit code and output, as `localShell` judges a host command. */
	const git = async (args: string[], options: { input?: Buffer; env?: Record<string, string> } = {}) => {
		const child = spawn("git", [`--git-dir=${repository}`, ...args], {
			env: { ...gitEnv, ...options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
		child.stdin.on("error", () => {});
		child.stdin.end(options.input ?? Buffer.alloc(0));
		const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
		if (code !== 0) throw new Error(`git ${args.join(" ")}: ${Buffer.concat(err).toString()}`);
		return Buffer.concat(out);
	};
	await exec("git", ["init", "--quiet", "--bare", repository], { env: gitEnv });
	let outputs = 0;
	/** One command as the guest runs it: bash -c, stdout and stderr into one output, its exit code. */
	const command = async (script: string, env: Record<string, string>, cwd: string, wrap: string[] = []) => {
		const at = join(top, `output-${outputs++}`);
		const handle = await open(at, "w");
		const argv = [...wrap, "bash", "--noprofile", "--norc", "-c", script];
		const child = spawn(argv[0] as string, argv.slice(1), { cwd, env, stdio: ["ignore", handle.fd, handle.fd] });
		const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
			child.on("exit", (code, signal) => resolve({ code, signal })),
		);
		return {
			child,
			ended: ended.then(async (end) => {
				await handle.close();
				return { ...end, output: await readFile(at, "utf8") };
			}),
		};
	};
	const environment = (name: string, more: Record<string, string> = {}): Record<string, string> => ({
		PATH,
		HOME: home,
		LANG: "C.UTF-8",
		TMPDIR: tmpdir(),
		QORPERA_CHECKS_ROOT: root,
		QORPERA_CHECKS_NAME: name,
		QORPERA_CHECKS_REPOSITORY: repository,
		QORPERA_SITE_FOLDER: "dist",
		QORPERA_SITE_SECRET_NAMES: "",
		...more,
	});
	/** The run's folder with a copy whose `folder` holds `files`. */
	const site = async (name: string, files: Record<string, Content>, folder = "dist") => {
		const top = folder === "." ? join(root, name, "src") : join(root, name, "src", folder);
		await mkdir(top, { recursive: true });
		for (const [path, content] of Object.entries(files)) {
			const at = join(top, path);
			await mkdir(dirname(at), { recursive: true });
			if (typeof content === "object" && "link" in content) await symlink(content.link, at);
			else if (typeof content === "object" && "fifo" in content) await exec("mkfifo", [at]);
			else await writeFile(at, content);
		}
		return top;
	};
	const collect = (name: string, more: Record<string, string> = {}, wrap: string[] = []) =>
		command(CODE_SITE_COLLECT, environment(name, more), join(root, name, "src"), wrap);
	const collected = async (name: string, more: Record<string, string> = {}) => (await collect(name, more)).ended;
	const drop = async (name: string, more: Record<string, string> = {}) =>
		(await command(CODE_SITE_DROP, environment(name, more), join(root, name, "src"))).ended;
	/** Every file in the storage's object folders (`xx/name`), temporary ones too. */
	const loose = async () => {
		const found: string[] = [];
		for (const folder of await readdir(join(repository, "objects")))
			if (/^[0-9a-f]{2}$/.test(folder))
				for (const entry of await readdir(join(repository, "objects", folder))) found.push(`${folder}/${entry}`);
		return found.sort();
	};
	/** Each file at an object's name is that object whole: it inflates, and its bytes are its id's. */
	const whole = async () => {
		for (const entry of await loose()) {
			if (!/^[0-9a-f]{2}\/[0-9a-f]{38}$/.test(entry)) continue;
			const inflated = inflateSync(await readFile(join(repository, "objects", entry)));
			expect(sha1(inflated), entry).toBe(entry.replace("/", ""));
		}
	};
	const wrote = async (name: string) =>
		(await readFile(join(root, name, "site.wrote"), "utf8")).split("\n").filter((line) => line !== "");
	/** The tree as git reads it back from the storage: each path's mode and bytes. */
	const treeOf = async (tree: string) => {
		const files = new Map<string, { mode: string; content: Buffer }>();
		for (const record of (await git(["ls-tree", "-r", "-z", tree])).toString("latin1").split("\0")) {
			if (record === "") continue;
			const [head, path] = record.split("\t") as [string, string];
			const [mode, , id] = head.split(" ") as [string, string, string];
			files.set(Buffer.from(path, "latin1").toString("utf8"), {
				mode,
				content: await git(["cat-file", "blob", id]),
			});
		}
		return files;
	};
	return {
		top,
		home,
		root,
		repository,
		git,
		command,
		environment,
		site,
		collect,
		collected,
		drop,
		loose,
		whole,
		wrote,
		treeOf,
	};
}
type Machine = Awaited<ReturnType<typeof machine>>;

/** The tree line of a made collect's output. */
const treeIn = (output: string) => /^tree ([0-9a-f]{40})\n/.exec(output)?.[1] as string;
const exists = (path: string) =>
	lstat(path).then(
		() => true,
		() => false,
	);

describe("the collect on the machine", { timeout: 120_000 }, () => {
	it("takes exactly the web files: regular, not hidden, of a served extension, links never followed", async () => {
		const m = await machine();
		const outside = join(m.top, "outside");
		await mkdir(outside);
		await writeFile(join(outside, "stolen.js"), "outside\n");
		const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0x0a, 0x0d, 0x0a]), randomBytes(4000)]);
		const listed: Record<string, Buffer | string> = {
			"index.html": "<h1>Gift message</h1>\r\n",
			"css/app.css": "body { color: #a0a; }\n",
			"js/app.js": "console.log('a');\n",
			"img/logo.png": png,
			"UPPER.HTML": "<p>upper</p>",
			"empty.txt": "",
			"a/b/c/deep.json": "{}",
			"fonts/x.woff2": randomBytes(300),
		};
		const name = runName(1);
		await m.site(name, {
			...listed,
			".env": "SECRET=1\n",
			".cache/x.js": "hidden\n",
			"a/.hidden/y.css": "hidden\n",
			"notes.md": "not served\n",
			"server.php": "<?php\n",
			LICENSE: "no extension\n",
			"x.tar.gz": "gz",
			"link.html": { link: "index.html" },
			ext: { link: outside },
			"pipe.txt": { fifo: true },
		});
		const { code, output } = await m.collected(name);
		const total = Object.values(listed).reduce((sum, content) => sum + Buffer.byteLength(content), 0);
		expect(code).toBe(0);
		expect(output).toMatch(new RegExp(`^tree [0-9a-f]{40}\\nfiles 8\\nbytes ${total}\\n$`));
		const tree = await m.treeOf(treeIn(output));
		expect([...tree.keys()].sort()).toEqual(Object.keys(listed).sort());
		for (const [path, content] of Object.entries(listed)) {
			expect(tree.get(path)?.mode).toBe("100644");
			expect(tree.get(path)?.content.equals(Buffer.from(content)), path).toBe(true);
		}
		// What it wrote, and nothing else: each object whole at its name, each named in site.wrote.
		const written = await m.wrote(name);
		expect((await m.loose()).map((entry) => entry.replace("/", "")).sort()).toEqual([...written].sort());
		await m.whole();
		// Blobs first, then trees from the leaves; the top tree last.
		expect(written.at(-1)).toBe(treeIn(output));
		expect(written.slice(0, 8).sort()).toEqual(
			Object.values(listed)
				.map((content) => blobId(content))
				.sort(),
		);
		expect(await readFile(join(m.root, name, "site.err"), "utf8")).toBe("");
	});

	it("takes the exact bytes: no filter, attribute, setting or variable of the session's or of the copy's", async () => {
		const m = await machine();
		const name = runName(2);
		const elsewhere = join(m.top, "elsewhere.git");
		await exec("git", ["init", "--quiet", "--bare", elsewhere], { env: { PATH, HOME: m.top } });
		const hostile = [
			"[core]",
			"\tautocrlf = true",
			"\tbigFileThreshold = 1",
			"\tcompression = 9",
			`\tattributesFile = ${join(m.top, "attributes")}`,
			'[filter "evil"]',
			"\tclean = sed s/a/EVIL/g",
			"\trequired = true",
			"[init]",
			`\ttemplateDir = ${join(m.top, "templates")}`,
		].join("\n");
		await writeFile(join(m.top, "attributes"), "* text eol=crlf filter=evil\n");
		await writeFile(join(m.home, ".gitconfig"), hostile);
		await mkdir(join(m.home, ".config", "git"), { recursive: true });
		await writeFile(join(m.home, ".config", "git", "config"), hostile);
		await writeFile(join(m.top, "global"), hostile);
		const listed = {
			"index.html": "a line\r\nanother\r\n",
			"lf.txt": "abc\nabc\n",
			"bin.png": Buffer.from([0, 0x0d, 0x0a, 0x61, 0xff]),
		};
		const top = await m.site(name, { ...listed, ".gitattributes": "* text eol=crlf filter=evil\n" });
		// The copy is a repository whose configuration the repository's own code may have written.
		const src = join(m.root, name, "src");
		await exec("git", ["init", "--quiet", src], { env: { PATH, HOME: m.top, GIT_CONFIG_GLOBAL: "/dev/null" } });
		await writeFile(join(src, ".git", "config"), hostile);
		await writeFile(join(src, ".gitattributes"), "* text eol=crlf filter=evil\n");
		// Python modules of the copy's, and in the variables Python would read: none is imported.
		const marker = join(m.top, "imported");
		const module = `open(${JSON.stringify(marker)}, "w").write("imported")\n`;
		for (const at of [src, top, join(m.top, "pythonpath")]) {
			await mkdir(at, { recursive: true });
			for (const moduleName of ["re.py", "os.py", "subprocess.py", "hashlib.py", "sitecustomize.py"])
				await writeFile(join(at, moduleName), module);
		}
		const { code, output } = await m.collected(name, {
			GIT_DIR: elsewhere,
			GIT_OBJECT_DIRECTORY: join(elsewhere, "objects"),
			GIT_ALTERNATE_OBJECT_DIRECTORIES: join(elsewhere, "objects"),
			GIT_INDEX_FILE: join(m.top, "index"),
			GIT_WORK_TREE: top,
			GIT_CONFIG_GLOBAL: join(m.top, "global"),
			GIT_CONFIG_PARAMETERS: "'core.bigfilethreshold'='1' 'core.autocrlf'='true'",
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "core.autocrlf",
			GIT_CONFIG_VALUE_0: "true",
			GIT_TEMPLATE_DIR: join(m.top, "templates"),
			XDG_CONFIG_HOME: join(m.home, ".config"),
			PYTHONPATH: join(m.top, "pythonpath"),
			PYTHONSTARTUP: join(m.top, "pythonpath", "re.py"),
			PYTHONHOME: join(m.top, "nowhere"),
			PYTHONWARNINGS: "error",
		});
		const total = Object.values(listed).reduce((sum, content) => sum + Buffer.byteLength(content), 0);
		expect({ code, output }).toEqual({
			code: 0,
			output: expect.stringMatching(new RegExp(`^tree [0-9a-f]{40}\\nfiles 3\\nbytes ${total}\\n$`)),
		});
		const tree = await m.treeOf(treeIn(output));
		expect([...tree.keys()].sort()).toEqual(Object.keys(listed).sort());
		for (const [path, content] of Object.entries(listed))
			expect(tree.get(path)?.content.equals(Buffer.from(content)), path).toBe(true);
		expect(await exists(marker)).toBe(false);
		expect((await readdir(join(elsewhere, "objects"))).sort()).toEqual(["info", "pack"]);
		expect(await exists(join(m.top, "index"))).toBe(false);
		await m.whole();
	});

	it("prints nothing but its answer when git and python warn: stderr goes to site.err", async () => {
		const m = await machine();
		const shims = join(m.top, "shims");
		await mkdir(shims);
		const real = async (tool: string) =>
			(await exec("bash", ["-c", `command -v ${tool}`], { env: { PATH } })).stdout.trim();
		for (const tool of ["git", "python3"])
			await writeFile(
				join(shims, tool),
				`#!/bin/bash\necho "warning: the ${tool} shim speaks" >&2\nexec ${await real(tool)} "$@"\n`,
				{ mode: 0o755 },
			);
		const shimmed = { PATH: `${shims}:${PATH}` };
		const name = runName(3);
		await m.site(name, { "index.html": "<p>x</p>" });
		const made = await m.collected(name, shimmed);
		expect(made.code).toBe(0);
		expect(made.output).toMatch(/^tree [0-9a-f]{40}\nfiles 1\nbytes 8\n$/);
		const err = await readFile(join(m.root, name, "site.err"), "utf8");
		expect(err).toContain("warning: the python3 shim speaks");
		expect(err).toContain("warning: the git shim speaks");
		expect(await m.drop(name, shimmed)).toEqual({ code: 0, signal: null, output: "dropped 2\n" });
		expect(
			(await readFile(join(m.root, name, "site.err"), "utf8")).split("warning: the python3 shim speaks"),
		).toHaveLength(3);
		const refused = runName(4);
		await m.site(refused, { "a.html": "<p>x</p>" });
		expect(await m.collected(refused, shimmed)).toEqual({ code: 3, signal: null, output: "SITE_NO_INDEX\n" });
		expect(await readFile(join(m.root, refused, "site.err"), "utf8")).toBe("warning: the python3 shim speaks\n");
	});

	it("writes no object the storage holds: a second collect writes nothing, also once they are packed", async () => {
		const m = await machine();
		const files = {
			"index.html": "<p>again</p>",
			"js/app.js": randomBytes(5000),
			"js/same.js": "same\n",
			"css/same.js": "same\n",
		};
		const first = runName(5);
		await m.site(first, files);
		const made = await m.collected(first);
		expect(made.code).toBe(0);
		const objects = await m.loose();
		expect((await m.wrote(first)).length).toBe(objects.length);
		// Each later run: the same answer, an empty site.wrote and the same files in the storage.
		let sequence = 6;
		const again = async (readOnly: boolean) => {
			const name = runName(sequence++);
			await m.site(name, files);
			if (readOnly) await exec("chmod", ["-R", "a-w", join(m.repository, "objects")]);
			try {
				const run = await m.collected(name);
				expect(run).toEqual({ code: 0, signal: null, output: made.output });
				expect(await m.wrote(name)).toEqual([]);
			} finally {
				await exec("chmod", ["-R", "u+w", join(m.repository, "objects")]);
			}
		};
		await again(false);
		expect(await m.loose()).toEqual(objects);
		// A storage it cannot write: it asks git and writes nothing, so nothing fails.
		await again(true);
		// Packed, the way nightly care keeps them: reachable in a pack (no loose file left), then unreachable in a cruft pack.
		await m.git(["update-ref", "refs/test/site", treeIn(made.output)]);
		await m.git(["repack", "-a", "-d", "--quiet"]);
		expect(await m.loose()).toEqual([]);
		await again(true);
		await m.git(["update-ref", "-d", "refs/test/site"]);
		await m.git(["repack", "-a", "-d", "--cruft", "--quiet"]);
		expect((await readdir(join(m.repository, "objects", "pack"))).some((entry) => entry.endsWith(".mtimes"))).toBe(
			true,
		);
		await again(true);
		expect(await m.loose()).toEqual([]);
	});

	it("names in site.wrote, before the first write, what it is about to write; a write that fails leaves nothing at an object's name", async () => {
		const m = await machine();
		const name = runName(9);
		await m.site(name, { "index.html": "<p>x</p>", "a.js": "a" });
		// Every object folder there and not writable: the first temporary file fails.
		for (let folder = 0; folder < 256; folder++)
			await mkdir(join(m.repository, "objects", folder.toString(16).padStart(2, "0")));
		await exec("chmod", ["-R", "a-w", join(m.repository, "objects")]);
		try {
			const run = await m.collected(name);
			expect(run.code).toBe(1);
			expect(run.output).toBe("");
		} finally {
			await exec("chmod", ["-R", "u+w", join(m.repository, "objects")]);
		}
		expect(await exists(join(m.root, name, "site.wrote"))).toBe(true);
		expect(await m.wrote(name)).toEqual([]);
		expect(await m.loose()).toEqual([]);
		expect(await readFile(join(m.root, name, "site.err"), "utf8")).toContain("PermissionError");
	});

	it("stopped half way through a write, leaves no partial file at an object's name, and site.wrote names what is there", async () => {
		const m = await machine();
		const files: Record<string, Buffer | string> = { "index.html": "<p>big</p>" };
		for (let index = 0; index < 8; index++) files[`media/${index}.png`] = randomBytes(2 * MiB);
		let failed = false;
		for (let attempt = 0; attempt < 4 && !failed; attempt++) {
			const name = runName(10 + attempt);
			await m.site(name, files);
			const run = await m.collect(name);
			// The moment its first object is named: stop it, let no file of it grow past 1 MiB, go on. The next large
			// object's write then fails half way (EFBIG; Python ignores SIGXFSZ).
			const wroteAt = join(m.root, name, "site.wrote");
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				try {
					if (statSync(wroteAt).size > 0) break;
				} catch {
					/* not made yet */
				}
			}
			process.kill(run.child.pid as number, "SIGSTOP");
			await exec("prlimit", ["--pid", String(run.child.pid), `--fsize=${MiB}:${MiB}`]);
			process.kill(run.child.pid as number, "SIGCONT");
			const end = await run.ended;
			const there = (await m.loose()).filter((entry) => /^[0-9a-f]{2}\/[0-9a-f]{38}$/.test(entry));
			await m.whole();
			expect((await m.loose()).filter((entry) => entry.includes("tmp_obj_"))).toEqual([]);
			expect([...(await m.wrote(name))].sort()).toEqual(there.map((entry) => entry.replace("/", "")).sort());
			if (end.code === 0) continue;
			expect(end).toEqual({ code: 1, signal: null, output: "" });
			expect(await readFile(join(m.root, name, "site.err"), "utf8")).toContain("File too large");
			failed = true;
		}
		expect(failed).toBe(true);
	});

	it("killed right after an object's rename, has named it in site.wrote, and the drop takes it away", async () => {
		const m = await machine();
		const name = runName(20);
		await m.site(name, { "index.html": "<p>one</p>", "a.js": "a\n", "b.css": "b{}\n" });
		// strace holds the collect for 3 s right after its first rename (only Python's own: the git it starts is not
		// traced), so it is killed with that object at its name and the next not written. strace's own words share the
		// output.
		const renames = "rename,renameat,renameat2";
		const run = await m.collect(name, {}, [
			"strace",
			"-qq",
			"-o",
			"/dev/null",
			"-e",
			`trace=${renames}`,
			"-e",
			`inject=${renames}:delay_exit=3000000:when=1`,
		]);
		const traced = () =>
			Number(readFileSync(`/proc/${run.child.pid}/task/${run.child.pid}/children`, "utf8").trim().split(" ")[0]);
		const deadline = Date.now() + 30_000;
		let there: string[] = [];
		while (Date.now() < deadline) {
			there = (await m.loose()).filter((entry) => /^[0-9a-f]{2}\/[0-9a-f]{38}$/.test(entry));
			if (there.length > 0) break;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(there).toHaveLength(1);
		process.kill(traced(), "SIGKILL");
		const end = await run.ended;
		expect(end.output).not.toMatch(/tree|files|bytes/);
		expect(await m.wrote(name)).toEqual([there[0]?.replace("/", "")]);
		await m.whole();
		expect(await m.drop(name)).toEqual({ code: 0, signal: null, output: "dropped 1\n" });
		expect((await m.loose()).filter((entry) => !entry.includes("tmp_obj_"))).toEqual([]);
	});

	it("passes over an object something put at its name meanwhile, and does not name it", async () => {
		const m = await machine();
		const shims = join(m.top, "shims");
		await mkdir(shims);
		const real = (await exec("bash", ["-c", "command -v git"], { env: { PATH } })).stdout.trim();
		// Git runs with an environment of the collect's own: the shim knows its paths by itself.
		const done = join(m.top, "done");
		// Right after git said what the storage lacks, another writer puts one of those objects there (git's own write).
		await writeFile(
			join(shims, "git"),
			[
				"#!/bin/bash",
				`if [[ " $* " == *" cat-file "* && -n "\${GIT_OBJECT_DIRECTORY:-}" && ! -e ${done} ]]; then`,
				`\tout="$(${real} "$@")"; c=$?`,
				`\t: >${done}`,
				`\tprintf 'concurrent\\n' | ${real} "$1" hash-object -w --stdin >/dev/null`,
				'\tprintf "%s\\n" "$out"; exit "$c"',
				"fi",
				`exec ${real} "$@"`,
			].join("\n"),
			{ mode: 0o755 },
		);
		const name = runName(21);
		await m.site(name, { "index.html": "<p>x</p>", "same.txt": "concurrent\n" });
		const run = await m.collected(name, { PATH: `${shims}:${PATH}` });
		expect(await exists(done)).toBe(true);
		expect(run.code).toBe(0);
		const concurrent = blobId("concurrent\n");
		const written = await m.wrote(name);
		expect(written).not.toContain(concurrent);
		expect([...written, concurrent].sort()).toEqual((await m.loose()).map((entry) => entry.replace("/", "")).sort());
		expect((await m.treeOf(treeIn(run.output))).get("same.txt")?.content.toString()).toBe("concurrent\n");
		await m.whole();
	});

	it("takes no file that changed while it was taken", async () => {
		const m = await machine();
		const shims = join(m.top, "shims");
		await mkdir(shims);
		const real = (await exec("bash", ["-c", "command -v git"], { env: { PATH } })).stdout.trim();
		const name = runName(22);
		const top = await m.site(name, { "index.html": "<p>x</p>" });
		// Git runs with an environment of the collect's own: the shim knows the file by itself.
		await writeFile(
			join(shims, "git"),
			`#!/bin/bash\n[[ " $* " == *" hash-object "* ]] && printf 'changed' >>${join(top, "index.html")}\nexec ${real} "$@"\n`,
			{ mode: 0o755 },
		);
		const run = await m.collected(name, { PATH: `${shims}:${PATH}` });
		expect(run).toEqual({ code: 4, signal: null, output: "" });
		expect(await m.wrote(name)).toEqual([]);
		expect(await m.loose()).toEqual([]);
	});

	it("does nothing when a newer run's folder stands: exits 91 and writes nothing, and so does the drop", async () => {
		const m = await machine();
		const name = runName(30);
		await m.site(name, { "index.html": "<p>x</p>" });
		const made = await m.collected(name);
		expect(made.code).toBe(0);
		const objects = await m.loose();
		const older = runName(29);
		await m.site(older, { "index.html": "<p>other</p>" });
		const entries = async () => (await readdir(join(m.root, older))).sort();
		const before = await entries();
		expect(await m.collected(older)).toEqual({ code: 91, signal: null, output: "" });
		expect(await entries()).toEqual(before);
		expect(await m.loose()).toEqual(objects);
		// The drop of a run that is not the newest removes nothing, though its site.wrote names objects.
		await writeFile(join(m.root, older, "site.wrote"), (await m.wrote(name)).map((id) => `${id}\n`).join(""));
		expect(await m.drop(older)).toEqual({ code: 91, signal: null, output: "" });
		expect(await m.loose()).toEqual(objects);
		expect(await exists(join(m.root, older, "site.err"))).toBe(false);
		// A later turn's name is higher whatever its attempt: a run of turn 31 makes run 30 attempt 2 the older one.
		await m.site(runName(30, 2), { "index.html": "<p>x</p>" });
		await mkdir(join(m.root, runName(31, 1)));
		expect(await m.collected(runName(30, 2))).toEqual({ code: 91, signal: null, output: "" });
	});
});

describe("the drop on the machine", { timeout: 60_000 }, () => {
	it("removes exactly the objects site.wrote names, and passes over what it cannot remove", async () => {
		const m = await machine();
		const name = runName(40);
		await m.site(name, { "index.html": "<p>x</p>", "a/b.js": "b", "a/c.css": "c" });
		expect((await m.collected(name)).code).toBe(0);
		const written = await m.wrote(name);
		// Three files and two trees (the top and a/).
		expect(written).toHaveLength(5);
		// An object of the repository's own, that the collect did not write.
		const own = (await m.git(["hash-object", "-w", "--stdin"], { input: Buffer.from("the repository's\n") }))
			.toString()
			.trim();
		const locked = written[0] as string;
		const lockedFolder = join(m.repository, "objects", locked.slice(0, 2));
		const sameFolder = written.filter((id) => id.startsWith(locked.slice(0, 2)));
		await chmod(lockedFolder, 0o555);
		try {
			expect(await m.drop(name)).toEqual({
				code: 0,
				signal: null,
				output: `dropped ${written.length - sameFolder.length}\n`,
			});
		} finally {
			await chmod(lockedFolder, 0o755);
		}
		expect((await m.loose()).map((entry) => entry.replace("/", "")).sort()).toEqual([own, ...sameFolder].sort());
		// Again: what is left of its own goes; an id it lists that is not there, or a line that is no id, is no object.
		await writeFile(
			join(m.root, name, "site.wrote"),
			[...written, "f".repeat(40), "not an id", `${own.slice(0, 39)}`].join("\n"),
		);
		expect(await m.drop(name)).toEqual({ code: 0, signal: null, output: `dropped ${sameFolder.length}\n` });
		expect((await m.loose()).map((entry) => entry.replace("/", ""))).toEqual([own]);
		await rm(join(m.root, name, "site.wrote"));
		expect(await m.drop(name)).toEqual({ code: 0, signal: null, output: "dropped 0\n" });
	});
});

describe("the collect's rules on the machine, as the tree's", { timeout: 180_000 }, () => {
	let shared: Promise<Machine> | undefined;
	const machineOnce = () => {
		shared ??= machine();
		return shared;
	};
	let sequence = 100;
	/** A site in a run of its own: the collect's answer, and the tree's rules on what it would list. */
	const judged = async (files: Record<string, Content>, folder = "dist") => {
		const m = await machineOnce();
		const name = runName(sequence++);
		await m.site(name, files, folder);
		const run = await m.collected(name, { QORPERA_SITE_FOLDER: folder });
		const answer = codeSiteCollectAnswer(run.output, run.code);
		return { run, answer, name };
	};
	/** The tree's rules agree on what the collect lists. */
	const agree = (files: Record<string, Content>, answer: ReturnType<typeof codeSiteCollectAnswer>) => {
		const listed = Object.entries(files)
			.filter(([, content]) => typeof content === "string" || Buffer.isBuffer(content))
			.filter(([path]) => !path.split("/").some((part) => part.startsWith(".")))
			.filter(([path]) =>
				CODE_SITE_EXTENSIONS.includes(
					/\.([A-Za-z0-9]{1,12})$/.exec(path.split("/").at(-1) ?? "")?.[1]?.toLowerCase() ?? "",
				),
			)
			.map(([path, content]) => file(path, Buffer.byteLength(content as string | Buffer)));
		const expected = codeSiteTreeProblem(listed);
		expect(answer && "problem" in answer ? answer.problem : null).toEqual(expected);
	};
	const index = { "index.html": "<p>site</p>" };

	it("takes 500 files and refuses 501", async () => {
		const files = (count: number) =>
			Object.fromEntries([
				...Object.entries(index),
				...Array.from({ length: count - 1 }, (_, i) => [`f${i % 50}/${i}.js`, `${i}`]),
			]);
		const taken = await judged(files(500));
		expect(taken.answer).toEqual({ made: { tree: expect.any(String), files: 500, bytes: expect.any(Number) } });
		agree(files(500), taken.answer);
		const refused = await judged(files(501));
		expect(refused.run).toEqual({ code: 3, signal: null, output: "SITE_TOO_MANY_FILES\n" });
		agree(files(501), refused.answer);
	});

	it("takes 100 folders, counted on every file's way, and refuses 101", async () => {
		const files = (count: number) =>
			Object.fromEntries([
				...Object.entries(index),
				["n/m/deep.js", "deep"],
				...Array.from({ length: count - 2 }, (_, i) => [`f${i}/a.js`, "a"]),
			]);
		const taken = await judged(files(100));
		expect(taken.run.code).toBe(0);
		const m = await machineOnce();
		expect([...(await m.treeOf(treeIn(taken.run.output))).keys()]).toHaveLength(100);
		const refused = await judged(files(101));
		expect(refused.run).toEqual({ code: 3, signal: null, output: "SITE_TOO_MANY_FOLDERS\n" });
		agree(files(101), refused.answer);
	});

	it("takes a file of 10 MiB and a site of 25 MiB, and refuses one byte more of either", async () => {
		const big = randomBytes(10 * MiB);
		const taken = await judged({ ...index, "big.png": big });
		expect(taken.run.code).toBe(0);
		const m = await machineOnce();
		expect((await m.treeOf(treeIn(taken.run.output))).get("big.png")?.content.equals(big)).toBe(true);
		const over = { ...index, "a/big.png": Buffer.concat([big, Buffer.from([1])]) };
		const refused = await judged(over);
		expect(refused.run).toEqual({ code: 3, signal: null, output: "SITE_FILE_TOO_LARGE a/big.png\n" });
		agree(over, refused.answer);
		const total = (extra: number) => ({
			"index.html": "x".repeat(1000),
			"a.png": big,
			"b.png": big,
			"c.mp4": Buffer.alloc(5 * MiB - 1000 + extra, 7),
		});
		const whole = await judged(total(0));
		expect(whole.run.output).toMatch(/\nfiles 4\nbytes 26214400\n$/);
		const past = await judged(total(1));
		expect(past.run).toEqual({ code: 3, signal: null, output: "SITE_TOO_LARGE\n" });
		agree(total(1), past.answer);
	});

	it("refuses a web file whose name a site cannot serve, naming it on one line", async () => {
		const deep = (parts: number) => `${Array.from({ length: parts - 1 }, () => "d").join("/")}/x.js`;
		const long = (length: number) => `${"a".repeat(200)}/${"b".repeat(200)}/${"c".repeat(length - 405)}.js`;
		expect(
			(await judged({ ...index, [deep(16)]: "x", [long(512)]: "x", [`${"p".repeat(197)}.js`]: "x" })).run.code,
		).toBe(0);
		for (const [path, shownAs] of [
			["a b.html", "a b.html"],
			["café.html", "caf\\xc3\\xa9.html"],
			["-x.js", "-x.js"],
			["a\\b.css", "a\\x5cb.css"],
			["line\nbreak.js", "line\\x0abreak.js"],
			[deep(17), deep(17)],
			[long(513), long(513)],
			[`${"p".repeat(198)}.js`, `${"p".repeat(198)}.js`],
		]) {
			const files = { ...index, [path as string]: "x" };
			const refused = await judged(files);
			expect(refused.run, path).toEqual({ code: 3, signal: null, output: `SITE_FILE_NAME ${shownAs}\n` });
			expect(refused.answer).toEqual({ problem: problem("SITE_FILE_NAME", path as string) });
			if (!path?.includes("\n")) agree(files, refused.answer);
		}
	});

	it("needs index.html at the top, a regular file", async () => {
		for (const files of [
			{ "a.html": "x" },
			{ "sub/index.html": "x" },
			{ "INDEX.HTML": "x" },
			{ "index.html": { link: "a.html" }, "a.html": "x" },
			{ "index.html/a.css": "x" },
			{},
		] as Record<string, Content>[]) {
			const refused = await judged(files);
			expect(refused.run).toEqual({ code: 3, signal: null, output: "SITE_NO_INDEX\n" });
			agree(files, refused.answer);
		}
	});

	it("needs the folder to be one, with no link on its way; '.' is the copy's top", async () => {
		const { run } = await judged(index, "out");
		expect(run.output).toMatch(/^tree /);
		const m = await machineOnce();
		const missing = runName(sequence++);
		await mkdir(join(m.root, missing, "src"), { recursive: true });
		expect(await m.collected(missing, { QORPERA_SITE_FOLDER: "dist" })).toEqual({
			code: 3,
			signal: null,
			output: "SITE_FOLDER_MISSING\n",
		});
		// A file, a link to a folder of the copy, and a link on the folder's way.
		for (const [files, folder] of [
			[{ dist: "x" }, "dist"],
			[{ dist: "x" }, "dist/x"],
			[{ "real/index.html": "x", dist: { link: "real" } }, "dist"],
			[{ "real/dist/index.html": "x", web: { link: "real" } }, "web/dist"],
		] as const) {
			const name = runName(sequence++);
			await m.site(name, files, ".");
			expect(await m.collected(name, { QORPERA_SITE_FOLDER: folder }), folder).toEqual({
				code: 3,
				signal: null,
				output: "SITE_FOLDER_MISSING\n",
			});
		}
		// The copy's top: its .git and other hidden parts are left out.
		const whole = await judged({ "index.html": "x", ".git/config": "x", "app.js": "y" }, ".");
		expect(whole.run.output).toMatch(/\nfiles 2\nbytes 2\n$/);
		// A recipe that is not as the host makes it is not the code's fault.
		const recipe = runName(sequence++);
		await m.site(recipe, index);
		for (const folder of ["", "../x", "a//b", "/abs"])
			expect(await m.collected(recipe, { QORPERA_SITE_FOLDER: folder }), folder).toEqual({
				code: 2,
				signal: null,
				output: "",
			});
	});

	it("finds a secret value byte for byte in a listed file, by its variable, and never prints it", async () => {
		const value = "sk_live_0123456789abcdef";
		const multiline = "-----BEGIN KEY-----\nline two of it\n";
		const files = {
			...index,
			"js/app.js": `const key = "${value}";\n`,
			"a.txt": `before\n${multiline}after\n`,
			".env": "HIDDEN_ONLY_VALUE=yes\n",
			"notes.md": "UNSERVED_VALUE_HERE\n",
			"b.txt": "short 1234567 seven\n",
		};
		const names = "UNSET_NAME 1BAD HIDDEN HIDDEN_FILE NOT_SERVED SEVEN MULTI STRIPE_KEY";
		const environment = {
			QORPERA_SITE_SECRET_NAMES: names,
			HIDDEN: "HIDDEN_ONLY_VALUE",
			HIDDEN_FILE: "HIDDEN_ONLY_VALUE=yes",
			NOT_SERVED: "UNSERVED_VALUE_HERE",
			SEVEN: "1234567",
			MULTI: multiline,
			STRIPE_KEY: value,
		};
		const m = await machineOnce();
		const name = runName(sequence++);
		await m.site(name, files);
		const before = await m.loose();
		const found = await m.collected(name, environment);
		expect(found).toEqual({ code: 3, signal: null, output: "SITE_HOLDS_SECRET MULTI a.txt\n" });
		expect(codeSiteCollectAnswer(found.output, found.code)).toEqual({
			problem: { code: "SITE_HOLDS_SECRET", path: "a.txt", variable: "MULTI" },
		});
		const err = await readFile(join(m.root, name, "site.err"), "utf8");
		for (const secret of [value, multiline, "line two of it"]) {
			expect(found.output).not.toContain(secret);
			expect(err).not.toContain(secret);
		}
		expect(await m.loose()).toEqual(before);
		expect(await m.wrote(name)).toEqual([]);
		expect(await exists(join(m.root, name, "site.git"))).toBe(false);
		// Without the multi-line value, the next: the key in app.js.
		const next = runName(sequence++);
		await m.site(next, files);
		expect((await m.collected(next, { ...environment, MULTI: "nowhere in it" })).output).toBe(
			"SITE_HOLDS_SECRET STRIPE_KEY js/app.js\n",
		);
		// Byte for byte: the value with a line break after it is not in the file, a seven-byte one is never looked for,
		// and a value only a hidden or an unserved file holds is no part of the site.
		const clean = runName(sequence++);
		await m.site(clean, files);
		const made = await m.collected(clean, { ...environment, MULTI: `${multiline}\n`, STRIPE_KEY: `${value}\n` });
		expect(made.code).toBe(0);
		expect(made.output).toMatch(/\nfiles 4\n/);
	});

	it("never names a path that holds a secret value, whatever rule it met: only the variable (release review, F1)", async () => {
		const m = await machineOnce();
		const environment = {
			QORPERA_SITE_SECRET_NAMES: "FIRST_KEY BACKSLASH_KEY UNICODE_KEY PLAIN_KEY",
			FIRST_KEY: "first-secret-0001",
			BACKSLASH_KEY: "live_key\\foo-1234",
			UNICODE_KEY: "cl\u00e9-secr\u00e8te-42",
			PLAIN_KEY: "token-abcdefgh12",
		};
		for (const [files, output] of [
			// A name a site cannot serve, with a backslash or a byte outside printable ASCII the answer would spell \xHH.
			[{ ...index, "assets/live_key\\foo-1234.js": "x" }, "SITE_HOLDS_SECRET BACKSLASH_KEY\n"],
			[{ ...index, "cl\u00e9-secr\u00e8te-42.css": "x" }, "SITE_HOLDS_SECRET UNICODE_KEY\n"],
			// A file over 10 MiB whose path holds a value.
			[{ ...index, "big/token-abcdefgh12.mp4": Buffer.alloc(10 * MiB + 1) }, "SITE_HOLDS_SECRET PLAIN_KEY\n"],
			// A path a site serves that holds a value, its bytes clean: the scan reads the paths too.
			[{ ...index, "js/token-abcdefgh12.js": "clean" }, "SITE_HOLDS_SECRET PLAIN_KEY\n"],
			// A file whose bytes hold one value and whose path holds another: the bytes' variable, no path.
			[{ ...index, "token-abcdefgh12.txt": "first-secret-0001" }, "SITE_HOLDS_SECRET FIRST_KEY\n"],
			// The bytes hold a value and the path holds none: named as before.
			[{ ...index, "js/app.js": "token-abcdefgh12" }, "SITE_HOLDS_SECRET PLAIN_KEY js/app.js\n"],
		] as const) {
			const name = runName(sequence++);
			await m.site(name, files);
			const run = await m.collected(name, environment);
			expect(run, output).toEqual({ code: 3, signal: null, output });
			const answer = codeSiteCollectAnswer(run.output, run.code);
			expect(answer).not.toBeNull();
			for (const value of Object.values(environment).slice(1)) {
				expect(run.output).not.toContain(value);
				expect(JSON.stringify(answer)).not.toContain(JSON.stringify(value).slice(1, -1));
			}
		}
	});

	it("leaves out a name whose spelling would not fit whole, never cuts it (review of #1691, F1)", async () => {
		// Five parts of 100 two-byte characters: 4,000 bytes spelled. A cut at 1,000 would carry the name's start, and a
		// value only the host's mask knows could begin there: the answer is the code alone.
		const path = `a${"/".concat("\u00e9".repeat(100)).repeat(5)}.js`;
		const { run, answer } = await judged({ ...index, [path]: "x" });
		expect(run).toEqual({ code: 3, signal: null, output: "SITE_FILE_NAME\n" });
		expect(answer).toEqual({ problem: problem("SITE_FILE_NAME") });
		// One of 1,000 bytes spelled is named whole; one byte more and it is left out.
		const name = `${"\u00e9".repeat(124)}.js`;
		expect((await judged({ ...index, [`abcd/${name}`]: "x" })).run.output).toBe(
			`SITE_FILE_NAME abcd/${"\\xc3\\xa9".repeat(124)}.js\n`,
		);
		expect((await judged({ ...index, [`abcde/${name}`]: "x" })).run.output).toBe("SITE_FILE_NAME\n");
	});
});

// The first live site (Wristband, 11 November 2026) loaded /src/style.css and /src/app.js from the top of the sites'
// domain, where no site is served: its page showed with no design and no script. -----------------------------------------
describe("the links from the root, on the machine", { timeout: 180_000 }, () => {
	let shared: Promise<Machine> | undefined;
	let sequence = 300;
	/** The collect over a site of `files` in a run of its own, with `environment`. */
	const collectOf = async (files: Record<string, Content>, environment: Record<string, string> = {}) => {
		shared ??= machine();
		const m = await shared;
		const name = runName(sequence++);
		await m.site(name, files);
		const started = performance.now();
		const run = await m.collected(name, environment);
		return { ...run, ms: performance.now() - started, m, name };
	};
	const refusedWith = async (files: Record<string, Content>, line: string) =>
		expect(await collectOf(files), line).toMatchObject({ code: 3, signal: null, output: line });
	const page = (body: string) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;

	it("refuses a page that links from the root in any attribute that loads or leads somewhere, naming its file", async () => {
		// Each with the link it holds (review round 3 of #1691: the answer names the file and how many, never a link).
		for (const [body] of [
			['<link rel="stylesheet" href="/src/style.css">', "/src/style.css"],
			['<script type="module" src="/src/app.js"></script>', "/src/app.js"],
			['<img src="a.png" srcset="small.png 1x, /big.png 2x">', "/big.png"],
			['<picture><source srcset="/a.webp" type="image/webp"></picture>', "/a.webp"],
			['<link rel="preload" as="image" imagesrcset="a.png 1x, /b.png 2x">', "/b.png"],
			['<video poster="/poster.jpg" src="v.mp4"></video>', "/poster.jpg"],
			['<form action="/send"><button formaction="b">x</button></form>', "/send"],
			['<form><button formaction="/other">x</button></form>', "/other"],
			['<object data="/o.svg"></object>', "/o.svg"],
			['<svg><use xlink:href="/sprite.svg#i"></use></svg>', "/sprite.svg#i"],
			['<a href="/">Home</a>', "/"],
			['<base href="/app/">', "/app/"],
			["<A HREF=/about.html>About</A>", "/about.html"],
			["<iframe SRC = '/frame.html'></iframe>", "/frame.html"],
			['<a href="&#47;x.html">x</a>', "/x.html"],
			['<a href="  /spaced.html ">x</a>', "  /spaced.html "],
			['<a href="\\x.html">x</a>', "\\x5cx.html"],
			['<meta http-equiv="Refresh" content="0; URL=\'/next.html\'">', "/next.html"],
			['<meta http-equiv="refresh" content="5;url=/later.html">', "/later.html"],
			['<div style="background: url(/bg.png) no-repeat">x</div>', "/bg.png"],
			["<style>body { background: URL( '/bg2.png' ) }</style>", "/bg2.png"],
			['<style>@import "/base.css";</style>', "/base.css"],
			// Review of #1691: the spellings looked for once more.
			['<a ping="https://t.example/p /ping">x</a>', "/ping"],
			['<table background="/t.gif"><tr><td>x</td></tr></table>', "/t.gif"],
			['<svg><image href="/i.png"></image></svg>', "/i.png"],
			['<a href="&sol;x">x</a>', "/x"],
			['<a href="&Tab;/tab">x</a>', "\\x09/tab"],
			['<a href="/&NewLine;nl">x</a>', "/\\x0anl"],
			['<style>a { background: image-set("/set.png" 1x) }</style>', "/set.png"],
			// Review round 4 of #1691: what a browser loads where Python 3.14's parser reads otherwise.
			// An empty comment ends at once, also when a later "-->" stands in the page.
			['<!--><img src="/after-empty-comment.png"><!-- later -->', "/after-empty-comment.png"],
			['<!---><img src="/after-empty-comment-2.png"><!-- later -->', "/after-empty-comment-2.png"],
			['<p><![CDATA[ x > <img src="/after-bogus-comment.png"> ]]>', "/after-bogus-comment.png"],
			['<script><!-- <script> </script> --></script><img src="/after-script.png">', "/after-script.png"],
			['<svg><title><a href="/svg-title-link">t</a></title></svg>', "/svg-title-link"],
			['<svg><style><img src="/breaks-out.png"></style></svg>', "/breaks-out.png"],
			['<template><img src="/in-template.png"></template>', "/in-template.png"],
			['<noscript><img src="/in-noscript.png"></noscript>', "/in-noscript.png"],
			['<a href="/first" href="second">x</a>', "/first"],
			['<img src="/nul\u0000in-value.png">', "/nul\ufffdin-value.png"],
			['<a href="&#47x">x</a>', "/x"],
			// Foreign content as the tree builder keeps it: an SVG <style>'s own text is its sheet (CDATA and character
			// references included, comments and child elements between its pieces), and a text-only element's name in
			// SVG or MathML opens no text, so an <img> there breaks out and loads.
			["<svg><style><![CDATA[ a { fill: url(/in-cdata.svg#g) } ]]></style></svg>", "/in-cdata.svg#g"],
			["<svg><style>a { background: url(<![CDATA[/split.png]]>) }</style></svg>", "/split.png"],
			["<svg><style>a { background: url(/sp<!-- c -->lit.png) }</style></svg>", "/split.png"],
			["<svg><style>a { background: url(&#47;ref.png) }</style></svg>", "/ref.png"],
			["<svg><style><a></a>b { background: url(/after-child.png) }</style></svg>", "/after-child.png"],
			["<style>a { b: url(/first-sheet.png) }</style><style>b { }</style>", "/first-sheet.png"],
			['<svg><svg/><style><img src="/still-in-svg.png"></style></svg>', "/still-in-svg.png"],
			['<svg><title/><style><img src="/after-closed-title.png"></style></svg>', "/after-closed-title.png"],
			['<math><title><style><img src="/math-title.png"></style></title></math>', "/math-title.png"],
			['<svg><math><mi><style><img src="/svg-math-mi.png"></style></mi></math></svg>', "/svg-math-mi.png"],
			[
				'<math><annotation-xml><style><img src="/annotation.png"></style></annotation-xml></math>',
				"/annotation.png",
			],
			['<math><mi><mglyph><style><img src="/mglyph.png"></style></mglyph></mi></math>', "/mglyph.png"],
			['<svg><font><style><img src="/plain-font.png"></style></font></svg>', "/plain-font.png"],
			['<svg><g><foreignObject></g><style><img src="/after-walk.png"></style></svg>', "/after-walk.png"],
			[
				'<svg><foreignObject><svg><g></g><style><img src="/inner-svg.png"></style></svg></foreignObject></svg>',
				"/inner-svg.png",
			],
			// A breakout stops at the integration point, so its end tag still finds it, and the SVG around is foreign again.
			[
				'<svg><foreignObject><svg><p></p></foreignObject><style><img src="/back-in-svg.png"></style></svg>',
				"/back-in-svg.png",
			],
			// Review round 5 of #1691, F2: an HTML element inside an integration point is the current node, so <![CDATA[
			// there is a bogus comment to the first ">" (a self-closed <div/> is open too: HTML ignores its slash).
			['<svg><foreignObject><div><![CDATA[ x > <img src="/real.png"> ]]></div></foreignObject></svg>', "/real.png"],
			[
				'<svg><foreignObject><div/><![CDATA[ x > <img src="/after-div.png"> ]]></foreignObject></svg>',
				"/after-div.png",
			],
			// An end tag that pops past an HTML element the reader still holds open may be one a browser ignores (it would
			// stay in HTML): CDATA after it is also read as markup after its first ">".
			[
				'<svg><foreignObject><div></foreignObject><![CDATA[ x > <img src="/after-doubt.png"> ]]></svg>',
				"/after-doubt.png",
			],
			// A void element under an HTML element breaks nothing out: the <div> stays the current node.
			[
				'<svg><foreignObject><div><img src="a.png"><![CDATA[ x > <img src="/after-img.png"> ]]></div></foreignObject></svg>',
				"/after-img.png",
			],
			// mglyph right above a MathML text point is MathML; under an HTML element the reader holds (which may have
			// ended unseen) it is taken as MathML too, so its <style> is no text and the <img> loads: where it must guess,
			// the reader counts.
			[
				'<math><mi><b><mglyph><style><img src="/mglyph-under-b.png"></style></mglyph></b></mi></math>',
				"/mglyph-under-b.png",
			],
		])
			await refusedWith({ "index.html": page(body as string) }, "SITE_LINKS_FROM_ROOT index.html 1\n");
		// A sheet the page ends inside is still read: an HTML <style> and an SVG one.
		for (const content of ["<style>a { b: url(/never-closed.png) }", "<svg><style>a { b: url(/never-closed.png) }"])
			await refusedWith({ "index.html": content }, "SITE_LINKS_FROM_ROOT index.html 1\n");
	});

	it("never names a link: its file and how many it has (review round 3 of #1691)", async () => {
		// The review of round 1's case, a long link ending in 32 bytes of ASCII, and three links in one page.
		await refusedWith(
			{ "index.html": page(`<a href="/${"é".repeat(120)}OLDsecret-0123456789abcdefghijKL">x</a>`) },
			"SITE_LINKS_FROM_ROOT index.html 1\n",
		);
		await refusedWith(
			{ "index.html": page('<link href="/a.css"><a href="b.html">b</a><img src="/c.png"><a href="/">home</a>') },
			"SITE_LINKS_FROM_ROOT index.html 3\n",
		);
		await refusedWith(
			{ "index.html": page("x"), "a.css": "a { background: url(/a.png) } @import '/b.css'; b { c: url(c.png) }" },
			"SITE_LINKS_FROM_ROOT a.css 2\n",
		);
	});

	it("refuses a style sheet that links from the root, in url() or @import", async () => {
		for (const [css] of [
			['@import "/base.css";', "/base.css"],
			["@import '/print.css' print;", "/print.css"],
			["@import url(/u.css);", "/u.css"],
			['@font-face { src: url("/f.woff2") format("woff2"); }', "/f.woff2"],
			["a { background: URL(  /x.png  ) }", "/x.png"],
			// Review of #1691, F2: comments wherever CSS allows them, any case, image-set's strings, escapes.
			['@import /* shared styles */ "/base.css";', "/base.css"],
			["@import/**/url(/x.css);", "/x.css"],
			["@IMPORT /* a */\n/* b */ '/u2.css';", "/u2.css"],
			['a { background-image: image-set("/a.png" 1x, "b.png" 2x) }', "/a.png"],
			['a { background-image: -webkit-image-set("/w.png" 1x, url(w2.png) 2x) }', "/w.png"],
			["a { background-image: IMAGE-SET('b.png' 1x, '/c.png' 2x) }", "/c.png"],
			["a { background: url(\\2f esc.png) }", "/esc.png"],
			['a { background: url("\\2f q.png") }', "/q.png"],
			["a { background: url(/*x*/) }", "/*x*/"],
			['@font-face { font-family: A; src: local("A"), url(/font.woff) }', "/font.woff"],
			// Review round 3 of #1691, F2: escapes as CSS Syntax decodes them, in names, strings and URLs.
			['@im\\70ort "/base.css";', "/base.css"],
			["a { background:u\\72l(/image.png) }", "/image.png"],
			["a { background: \\75 rl(/x.png) }", "/x.png"],
			["a { background: U\\52L(/y.png) }", "/y.png"],
			['a { background: image-\\73 et("/z.png" 1x) }', "/z.png"],
			['a { mask-image: src("/s.png") }', "/s.png"],
			["a { background: url(\\/x.png) }", "/x.png"],
			['@\\69MPORT "\\2f q.css";', "/q.css"],
			["a { background: url(/a\\ b.png) }", "/a b.png"],
			["a { background: url(/prefix-secret-1234\\)tail-5678) }", "/prefix-secret-1234)tail-5678"],
			// Review round 4 of #1691: CSS's input normalized first (CR LF, CR and FF to LF, NUL to U+FFFD).
			['a { background: url("\\\r\n/continued.png") }', "/continued.png"],
			["a { background: url(/a\u0000b.png) }", "/a\ufffdb.png"],
			// A string or a URL the file ends inside is still one.
			['@import "/at-the-end.css', "/at-the-end.css"],
			["a { background: url(/at-the-end.png", "/at-the-end.png"],
			// Review round 5 of #1691, F1: a backslash the file ends on. In a string it is dropped, so the string is "/";
			// elsewhere it is U+FFFD, so the URL token is "/x<U+FFFD>". Spaces before the end of a URL token are no part of it.
			['@import "/\\', "/"],
			['a { background: url("/fn\\', "/fn"],
			["a { background: url(/x\\", "/x�"],
			["a { background: url(  /spaces-at-the-end.png  ", "/spaces-at-the-end.png"],
		])
			await refusedWith({ "index.html": page("x"), "css/site.css": css }, "SITE_LINKS_FROM_ROOT css/site.css 1\n");
		// A page of any case of its extension; the first link in C order of the files: a.css before index.html.
		await refusedWith(
			{ "index.html": page("x"), "Page.HTM": page('<a href="/x">x</a>') },
			"SITE_LINKS_FROM_ROOT Page.HTM 1\n",
		);
		await refusedWith(
			{ "index.html": page('<link href="/i.css">'), "a.css": "b { background: url(/a.png) }" },
			"SITE_LINKS_FROM_ROOT a.css 1\n",
		);
	});

	it("takes every link that is not from the root, and what is no link at all", async () => {
		const body = [
			'<script src="//cdn.example/x.js"></script>',
			'<a href="https://example.com/x">x</a><a href="HTTP://EXAMPLE.COM/">x</a>',
			'<a href="mailto:a@example.com">m</a><a href="tel:+4512345678">t</a><a href="javascript:void(0)">j</a>',
			'<a href="#top">top</a><a href="?q=/x">q</a><a href="">e</a><a href=" ">s</a><a href>bare</a>',
			'<img src="data:image/png;base64,AAAA"><img srcset="data:image/jpeg;base64,/9j/4AAQSkZJRg 1x, b.png 2x">',
			'<img srcset="a.png 1x,b.png 2x"><img src="src/app.png"><img src="../img/logo.png">',
			'<a href="/\\evil.example/x">x</a><a href="/&#10;/cdn.example/x">x</a>',
			'<p>a url(/not-css.png) in words, and @import "/not-css.css"</p>',
			'<meta http-equiv="refresh" content="/no-time"><meta name="description" content="2; url=/not-a-refresh">',
			// Review round 4 of #1691: text, not elements, as a browser reads them.
			'<textarea><img src="/in-textarea.png"></textarea><title><img src="/in-title.png"></title>',
			'<xmp><img src="/in-xmp.png"></xmp><iframe><img src="/in-iframe.png"></iframe>',
			'<noembed><img src="/in-noembed.png"></noembed><noframes><img src="/in-noframes.png"></noframes>',
			'<iframe/><img src="/after-closed-iframe.png"></iframe><script/><img src="/after-closed-script.png"></script>',
			'<script><!-- <script> </script> <img src="/in-double-escaped.png"> --></script>',
			'<a href="second" href="/first">x</a><img\u0000src="/nul-in-tag.png">',
			'<svg><![CDATA[ <image href="/in-cdata.png"/> ]]></svg><p><![CDATA[ <img src="/in-bogus.png"> ]]>',
			'<svg><style>a { fill: red }</style><title>t</title></svg><style>/* <img src="/in-style.png"> */</style>',
			// In SVG a <p> breaks back out to HTML, and a foreignObject holds HTML: their text-only elements are text again.
			'<svg><p></p><style><img src="/after-breakout.png"></style></svg>',
			'<svg><foreignObject><textarea><img src="/in-foreign-object.png"></textarea></foreignObject></svg>',
			// One dash before ">" leaves a script's escaped text escaped, so its "<script>" still opens the double escape.
			'<script><!-- -> <script> </script> <img src="/in-script-after-one-dash.png"> --> </script>',
			// A self-closed SVG <style> holds no text; a MathML <style> is no sheet; an SVG <style>'s child elements'
			// text is not its sheet.
			"<svg><style/>url(/not-css.png)</svg><math><style>a { b: url(/math-style.png) }</style></math>",
			"<svg><style>a { } <a>b { c: url(/in-child.png) }</a></style></svg>",
			// Out to HTML: a <font> with color, face or size, an end tag </p> or </br>, an annotation-xml that holds HTML
			// (and mglyph there is HTML too), an SVG inside MathML's <mi>; and CDATA at an integration point is text.
			'<svg><font color="red"><style><img src="/after-font.png"></style></font></svg>',
			'<svg></p><style><img src="/after-end-p.png"></style></svg><svg></br><style><img src="/after-end-br.png"></style></svg>',
			'<math><annotation-xml encoding="TEXT/HTML"><style><img src="/annotation-html.png"></style></annotation-xml></math>',
			'<math><annotation-xml encoding="text/html"><mglyph><style><img src="/html-mglyph.png"></style></mglyph></annotation-xml></math>',
			'<math><mi><svg><foreignObject><style><img src="/in-svg-in-math.png"></style></foreignObject></svg></mi></math>',
			'<math><annotation-xml><svg><foreignObject><style><img src="/svg-in-annotation.png"></style></foreignObject></svg></annotation-xml></math>',
			// Review round 5 of #1691: once an HTML element inside an integration point ends, or a void one never opens, the
			// point is the current node again and CDATA there is text; an end tag from a nested SVG pops it to its element.
			'<svg><foreignObject><p>a</p><br><![CDATA[ x > <img src="/cdata-at-the-point.png"> ]]></foreignObject></svg>',
			'<svg><foreignObject><div><svg><g></div><style><img src="/after-inner-svg.png"></style></foreignObject></svg>',
			// Read again, CDATA is markup only after its first ">" (before it, a bogus comment), and only until foreign
			// content ends.
			'<svg><foreignObject><div></foreignObject><![CDATA[ <img src="/in-the-bogus-comment.png"> ]]></svg>',
			'<svg><foreignObject><div></foreignObject></svg><svg><![CDATA[ x > <img src="/after-foreign-content-ended.png"> ]]></svg>',
			'<svg><foreignObject><![CDATA[ a > <img src="/in-cdata-at-point.png"> ]]></foreignObject></svg>',
			// HTML's whitespace is ASCII's: a no-break space splits no ping or srcset, starts no refresh, and is no
			// URL's blank; an http-equiv with a space is no refresh, nor a time not followed by ;, , or a space.
			'<a ping="https://t.example/p /not-split">p</a><img srcset=" /nbsp.png 1x">',
			'<meta http-equiv="refresh" content=" 0; url=/nbsp-time"><meta http-equiv="refresh" content="0; url= /nbsp-url">',
			'<meta http-equiv=" refresh" content="0; url=/spaced-equiv"><meta http-equiv="refresh" content="0/next">',

			'<meta http-equiv="refresh" content="30"><meta name="description" content="/not-a-link">',
			'<div data="/not-object" title="/x" data-href="/x" class="/x">x</div><object data="o.svg"></object>',
			'<!-- <link rel="stylesheet" href="/commented.css"> --><!--[if IE]><script src="/ie.js"></script><![endif]-->',
			"<script>var s = '<img src=\"/in-script.png\">'; fetch('/api/x');</script>",
			'<pre>&lt;a href="/in-pre"&gt;</pre><p>text with href="/x" in it</p>',
			'<style>/* url(/in-comment.png) */ a::after { content: "url(/in-string.png)"; } b { background: url(c.png) }</style>',
			'<div style="background: url(rel.png)">x</div>',
		].join("\n");
		const files = {
			"index.html": page(`${body}<form><button>send</button></form><a ping="https://t.example/p">p</a>`),
			"a.css": '/* @import "/c.css"; */ b { background: url("img/b.png"), url(data:image/png;base64,/9j/x) }',
			// A comment inside url() makes no URL at all: CSS drops the declaration, and so the collect takes no link there.
			// Strings elsewhere are no links.
			"b.css": [
				"a { background: url( /* c */ /x.png ) }",
				'b { background: url( /* c */ "/y.png") }',
				'c { background: image-set("rel.png" type("image/png")) }',
				'd { content: "/x"; font-family: "/odd" }',
				'f { font-family: var(--x, "/fallback") }',
				"@import url(rel.css) layer(base) supports(display: grid);",
				'@media print { e { content: "/p" } }',
				'@import foo "/not-an-import.css";',
				// No url token: a hash, another function's name, a space inside a bare URL, a comment, a string.
				"g { background: #url(/x) } h { background: myurl(/x) } i { background: url(/a b.png) }",
				'/* u\\72l(/in-comment.png) */ j { content: "u\\72l(/in-string.png)" }',
				// A bad URL runs to its own ")", an escaped one inside it is no end; a control inside a URL makes it bad.
				"k { b: url(x y\\) url(/z.png) } l { b: url(/a\u0001b.png) }",
				// Escapes decoded before a URL is judged: "//" to another host, and a scheme.
				'@import "\\2f\\2f cdn.example/x.css"; m { b: image-set("\\68ttps://x.example/a.png" 1x) }',
				// Review round 4 of #1691: a string a line break ends is a bad string (no import), CR and FF are line
				// breaks, a URL of only spaces is empty, a continued string is one string.
				'@import "/bad-string.css\n;',
				'@import "/form-feed.css\f"; @import "/carriage-return.css\r";',
				'n { b: url(   ) } o { content: "\\\r\n/continued-text" }',
			].join("\n"),
			"app.js": "fetch('/api/items'); const u = '/src/x.js';",
			"notes.txt": '<a href="/x">',
			// A text-only element that never ends: everything after it is text.
			"plain.html": '<p>x</p><plaintext><img src="/in-plaintext.png"></plaintext><img src="/after.png">',
			// Review round 5 of #1691: the file's end inside a comment, and a backslash at the end of a string (dropped) and
			// of a URL (U+FFFD): no link from the root.
			"c.css": "p { b: url(rel.png) } /* url(/in-a-comment-never-closed.png)",
			"d.css": '@import "rel\\',
			"e.css": "a { b: url(\\",
			"img/x.svg": '<svg><image href="/i.png"/></svg>',
		};
		const run = await collectOf(files);
		expect(run.output).toMatch(/^tree [0-9a-f]{40}\nfiles 10\n/);
	});

	it("never prints a byte of a link, so a value in one stays unseen in any spelling (review round 3 of #1691)", async () => {
		const environment = {
			QORPERA_SITE_SECRET_NAMES: "LINK_KEY ESCAPED_KEY",
			LINK_KEY: "link-secret-4242",
			ESCAPED_KEY: "prefix-secret-1234)tail-5678",
		};
		// Written plainly the file's bytes hold it, and the scan of the bytes names the file as before.
		const plain = await collectOf({ "index.html": page('<a href="/k/link-secret-4242">x</a>') }, environment);
		expect(plain.output).toBe("SITE_HOLDS_SECRET LINK_KEY index.html\n");
		// By character references, or by a CSS escape (the review's case: the URL token takes the escaped parenthesis,
		// and the bytes never hold the value): a link from the root, with no byte of it printed.
		const spelled = await collectOf({ "index.html": page('<a href="/k/&#108;ink-secret-4242">x</a>') }, environment);
		expect(spelled).toMatchObject({ code: 3, output: "SITE_LINKS_FROM_ROOT index.html 1\n" });
		const escaped = await collectOf(
			{ "index.html": page("x"), "a.css": "a{background:url(/prefix-secret-1234\\)tail-5678)}" },
			environment,
		);
		expect(escaped).toMatchObject({ code: 3, output: "SITE_LINKS_FROM_ROOT a.css 1\n" });
		for (const run of [plain, spelled, escaped]) {
			const err = await readFile(join(run.m.root, run.name, "site.err"), "utf8");
			for (const value of [environment.LINK_KEY, environment.ESCAPED_KEY])
				for (let at = 0; at + 8 <= value.length; at++)
					for (const text of [run.output, err]) expect(text).not.toContain(value.slice(at, at + 8));
			expect(await run.m.wrote(run.name)).toEqual([]);
		}
	});

	it("lets links from the root through only while QORPERA_SITE_ROOT_LINKS is exactly allowed (step 5, D15)", async () => {
		// The first live site's page (11 Nov), and a style sheet that links from the root.
		const rooted = {
			"index.html": page(
				'<link rel="stylesheet" href="/src/style.css"><script type="module" src="/src/app.js"></script>',
			),
			"src/style.css": "body { background: url(/img/bg.png) }",
			"src/app.js": "import '/src/x.js';",
		};
		// Refused as before: the host's `refused`, no variable at all (a host before step 5), and every other value.
		const refusing: Record<string, string>[] = [
			{ QORPERA_SITE_ROOT_LINKS: "refused" },
			{},
			...["ALLOWED", "allowed ", " allowed", "yes", "1", ""].map((v) => ({ QORPERA_SITE_ROOT_LINKS: v })),
		];
		for (const value of refusing)
			expect(await collectOf(rooted, value), JSON.stringify(value)).toMatchObject({
				code: 3,
				signal: null,
				output: "SITE_LINKS_FROM_ROOT index.html 2\n",
			});
		// Allowed: the site is made, its files whole.
		const made = await collectOf(rooted, { QORPERA_SITE_ROOT_LINKS: "allowed" });
		expect(made).toMatchObject({ code: 0, signal: null });
		expect(made.output).toMatch(/^tree [0-9a-f]{40}\nfiles 3\nbytes \d+\n$/);
		const tree = await made.m.treeOf(treeIn(made.output));
		expect([...tree.keys()].sort()).toEqual(Object.keys(rooted).sort());
		// Every other rule still holds: a secret value, a missing index, a missing folder.
		const environment = {
			QORPERA_SITE_ROOT_LINKS: "allowed",
			QORPERA_SITE_SECRET_NAMES: "LINK_KEY",
			LINK_KEY: "link-secret-4242",
		};
		expect(await collectOf({ ...rooted, "a.js": "link-secret-4242" }, environment)).toMatchObject({
			code: 3,
			output: "SITE_HOLDS_SECRET LINK_KEY a.js\n",
		});
		expect(await collectOf({ "a.html": page('<a href="/">x</a>') }, environment)).toMatchObject({
			code: 3,
			output: "SITE_NO_INDEX\n",
		});
		expect(await collectOf(rooted, { ...environment, QORPERA_SITE_FOLDER: CODE_SITE_DRILL_FOLDER })).toMatchObject({
			code: 3,
			output: "SITE_FOLDER_MISSING\n",
		});
	});

	it("reads 25 MiB of pages and styles within the collect's time", async () => {
		const unit =
			'<li><a href="p/x.html" class="c"><img src="i/a.png" srcset="i/a.png 1x, i/b.png 2x" alt="x"></a></li>\n';
		const fill = (bytes: number, text: string) => text.repeat(Math.floor(bytes / text.length));
		const dense = {
			"index.html": page(fill(10 * MiB - 200, unit)),
			"b.html": fill(10 * MiB, unit),
			"c.css": fill(5 * MiB - 10_000, "a { background: url(i/a.png) } /* c */ b { content: 'x' }\n"),
		};
		const made = await collectOf(dense);
		expect(made.output).toMatch(/^tree [0-9a-f]{40}\nfiles 3\n/);
		// Shapes the parser must not take long over: a comment never closed, a tag never closed, a value never closed,
		// a page of angle brackets; and a style sheet of unclosed strings and comments.
		const odd = {
			"index.html": `<p>x</p><!--${"a<b>".repeat(MiB)}`,
			"a.html": `<a href="x" title="${"&amp;<".repeat(MiB / 2)}`,
			"b.html": "<".repeat(5 * MiB),
			"c.html": `<div ${"a=b ".repeat(MiB)}`,
			"d.css": `"${"x/*".repeat(MiB)}`,
			"e.css": `/*${"url(".repeat(MiB)}`,
		};
		const slow = await collectOf(odd);
		expect(slow.output).toMatch(/^tree [0-9a-f]{40}\nfiles 6\n/);
		// Style sheets of as many tokens as bytes: the tokenizer stays linear.
		const tokens = await collectOf({
			"index.html": "<p>x</p>",
			"t.css": "a/".repeat(5 * MiB),
			"u.css": "(".repeat(5 * MiB),
			"v.css": '"x" '.repeat((9 * MiB) / 4),
		});
		expect(tokens.output).toMatch(/^tree [0-9a-f]{40}\nfiles 4\n/);
		// Scripts the escaped states must not take long over: dashes, angle brackets, nested script openings.
		const scripts = await collectOf({
			"index.html": `<script>${"-".repeat(8 * MiB)}</script>`,
			"a.html": `<script><!--${"<s".repeat(4 * MiB)}`,
			"b.html": `<script><!--${"<script>-".repeat(MiB / 2)}`,
		});
		expect(scripts.output).toMatch(/^tree [0-9a-f]{40}\nfiles 3\n/);
		// Foreign content: a million open SVG elements and as many end tags that match none, a quarter million SVG
		// sheets, and breakouts that leave a MathML element open each time.
		const foreign = await collectOf({
			"index.html": `<svg>${"<g>".repeat(MiB)}${"</x>".repeat(MiB)}`,
			"a.html": "<svg><style>a</style>".repeat(MiB / 4),
			"b.html": "<math><mi><svg><g><p>".repeat(MiB / 4),
		});
		expect(foreign.output).toMatch(/^tree [0-9a-f]{40}\nfiles 3\n/);
		// HTML inside an integration point: a million open elements an end tag pops at once, and CDATA read again as
		// markup, in one long section and in half a million short ones.
		const doubt = "<svg><foreignObject><div></foreignObject>";
		const html = await collectOf({
			"index.html": `<svg><foreignObject>${"<div>".repeat(MiB)}</svg>`,
			"a.html": `${doubt}<![CDATA[>${"<img src=a>".repeat(MiB / 2)}]]>`,
			"b.html": `${doubt}${"<![CDATA[>a]]>".repeat(MiB / 2)}`,
		});
		expect(html.output).toMatch(/^tree [0-9a-f]{40}\nfiles 3\n/);
		console.log(
			`links: 25 MiB of dense pages and styles ${Math.round(made.ms)} ms, odd shapes ${Math.round(slow.ms)} ms, style sheets of a token a byte ${Math.round(tokens.ms)} ms, scripts ${Math.round(scripts.ms)} ms, foreign content ${Math.round(foreign.ms)} ms, HTML in foreign content ${Math.round(html.ms)} ms`,
		);
		expect(html.ms).toBeLessThan(60_000);
		expect(made.ms).toBeLessThan(60_000);
		expect(slow.ms).toBeLessThan(60_000);
		expect(tokens.ms).toBeLessThan(60_000);
		expect(scripts.ms).toBeLessThan(60_000);
		expect(foreign.ms).toBeLessThan(60_000);
	});
});
