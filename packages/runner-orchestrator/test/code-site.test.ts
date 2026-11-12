import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
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
	CODE_CHECKS_NEWER_RUN,
	CODE_SITE_COLLECT,
	CODE_SITE_DROP,
	CODE_SITE_EXTENSIONS,
	CODE_SITE_MAX_BYTES,
	CODE_SITE_MAX_FILE_BYTES,
	CODE_SITE_MAX_FILES,
	CODE_SITE_MAX_FOLDERS,
	CODE_SITE_MAX_PATH_BYTES,
	CODE_SITE_PATH,
	type CodeSiteProblem,
	codeSiteCollectAnswer,
	codeSiteDropAnswer,
	codeSiteFolderValid,
	codeSiteManifest,
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

describe("the site's rules, as the database's", () => {
	it("has the plan's bounds", () => {
		expect([CODE_SITE_MAX_FILES, CODE_SITE_MAX_BYTES, CODE_SITE_MAX_FILE_BYTES]).toEqual([500, 25 * MiB, 10 * MiB]);
		expect([CODE_SITE_MAX_FOLDERS, CODE_SITE_MAX_PATH_BYTES]).toEqual([100, 512]);
	});

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

	it("takes a site's name as qorpera_site_slug_valid does", () => {
		const body = sqlFunction("qorpera_site_slug_valid");
		const reserved = [...(/not in \(([^)]+)\)/.exec(body)?.[1] ?? "").matchAll(/'([a-z-]+)'/g)].map(
			(m) => m[1] as string,
		);
		expect(reserved.length).toBeGreaterThan(20);
		expect(body).toContain("'^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$'");
		for (const name of reserved) expect(codeSiteNameValid(name)).toBe(false);
		for (const name of ["abc", "gift-message", "a".repeat(48), "a--b", "000"])
			expect(codeSiteNameValid(name)).toBe(true);
		for (const name of ["ab", "a".repeat(49), "-ab", "ab-", "aBc", "a_b", "a.b", ""])
			expect(codeSiteNameValid(name)).toBe(false);
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
		// A link from the root: the file (a path of the site, no space in it), then the link as the file writes it.
		expect(refused("SITE_LINKS_FROM_ROOT index.html /src/style.css\n")).toEqual({
			problem: { code: "SITE_LINKS_FROM_ROOT", path: "index.html", variable: null, link: "/src/style.css" },
		});
		expect(refused("SITE_LINKS_FROM_ROOT css/a.css  /img/caf\\xc3\\xa9 1.png\\x0a\n")).toEqual({
			problem: { code: "SITE_LINKS_FROM_ROOT", path: "css/a.css", variable: null, link: " /img/café 1.png\n" },
		});
		// A detail of 1,000 bytes, the most the collect writes.
		expect(refused(`SITE_FILE_NAME ${"\\xc3\\xa9".repeat(125)}\n`)).toEqual({
			problem: problem("SITE_FILE_NAME", "\u00e9".repeat(125)),
		});
		for (const line of [
			"SITE_FILE_NAME\n",
			"SITE_FILE_TOO_LARGE\n",
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
			"SITE_LINKS_FROM_ROOT\n",
			"SITE_LINKS_FROM_ROOT index.html\n",
			"SITE_LINKS_FROM_ROOT index.html \n",
			"SITE_LINKS_FROM_ROOT  /a.css\n",
			"SITE_LINKS_FROM_ROOT index.html /a\\x41PI-KEY.css\n",
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
		expect(codeSiteReported({ ...MADE, folder: ".", name: "shop", title: "The shop", files: 500, bytes: 0 })).toEqual(
			{
				state: "made",
				site: {
					schema: "qorpera.code-site/v1",
					tree: TREE,
					files: 500,
					bytes: 0,
					folder: ".",
					name: "shop",
					title: "The shop",
				},
			},
		);
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
		// A link from the root, with its file and link; a link the host's mask took away; neither (no mask to be had).
		const relative =
			'. A site is served under an address of its own, never at the top of a domain: link its files with relative links (src/app.js, ../img/logo.png), in its scripts too, which Qorpera does not read; for a bundler, set its base path, such as Vite\'s base: "./".';
		expect(said({ code: "SITE_LINKS_FROM_ROOT", path: "index.html", variable: null, link: "/src/style.css" })).toBe(
			`${head}has a link that starts with /: index.html links to /src/style.css${relative}${foot}`,
		);
		expect(said({ code: "SITE_LINKS_FROM_ROOT", path: "index.html", variable: null, link: null })).toBe(
			`${head}has a link that starts with / in index.html${relative}${foot}`,
		);
		expect(said({ code: "SITE_LINKS_FROM_ROOT", path: null, variable: null, link: null })).toBe(
			`${head}has a link that starts with /${relative}${foot}`,
		);
		expect(said(problem("SITE_FILE_NAME"))).toBe(
			`${head}has a file whose name a site cannot serve (only letters, digits, dots, hyphens and underscores, each part starting with a letter, a digit or an underscore and at most 200 bytes, at most 16 parts and 512 bytes in all).${foot}`,
		);
	});

	it("shows a hostile name on one line, cut, and stays within 3,500 bytes", () => {
		const words = codeSiteRefusedSummary(problem("SITE_FILE_NAME", `a\nb‮${"x".repeat(5000)}.html`), "web/‮dist");
		expect(words).toContain('the site in "web/�dist" has a file whose name a site cannot serve: a�b�xx');
		expect(words).toContain("x… (only letters");
		expect(words.split("\n")).toHaveLength(1);
		const largest = codeSiteRefusedSummary(
			{ code: "SITE_HOLDS_SECRET", path: "é".repeat(5000), variable: "A".repeat(128) },
			"é".repeat(150),
		);
		expect(bytes(largest)).toBeLessThanOrEqual(3500);
		expect(largest.endsWith("[code=CODING_CHECKS_SITE_REFUSED]")).toBe(true);
		const link = codeSiteRefusedSummary(
			{ code: "SITE_LINKS_FROM_ROOT", path: "é".repeat(5000), variable: null, link: `/\n${"é".repeat(5000)}` },
			"é".repeat(150),
		);
		expect(bytes(link)).toBeLessThanOrEqual(3500);
		expect(link).toContain(" links to /\uFFFDéé");
		expect(link.split("\n")).toHaveLength(1);
	});
});

describe("the commands' texts", () => {
	it("begin with the run's guard, are ASCII and within the guest's 16 KiB", () => {
		for (const command of [CODE_SITE_COLLECT, CODE_SITE_DROP]) {
			expect(command.startsWith(`${CODE_CHECKS_NEWER_RUN.join("\n")}\nexec 2>`)).toBe(true);
			expect(bytes(command)).toBeLessThanOrEqual(16384);
			expect(/^[\t\n\x20-\x7e]*$/.test(command)).toBe(true);
		}
		expect(CODE_SITE_COLLECT).toContain('exec 2>"$QORPERA_CHECKS_ROOT/$QORPERA_CHECKS_NAME/site.err"\n');
		expect(CODE_SITE_DROP).toContain('exec 2>>"$QORPERA_CHECKS_ROOT/$QORPERA_CHECKS_NAME/site.err"\n');
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

	it("cuts a long name's spelling at a whole byte's, so the answer still reads", async () => {
		// Five parts of 100 two-byte characters: 4,000 bytes spelled, cut within 1,000 at a whole \xHH.
		const path = `a${"/".concat("\u00e9".repeat(100)).repeat(5)}.js`;
		const { run, answer } = await judged({ ...index, [path]: "x" });
		expect(run.code).toBe(3);
		const detail = run.output.slice("SITE_FILE_NAME ".length, -1);
		// "a/", the first part's 100 characters, "/", then 24 whole characters and the first byte of the next: 999 bytes,
		// the next byte's spelling would pass 1,000. A half character reads as U+FFFD.
		expect(detail.length).toBe(999);
		expect(detail).toMatch(/^a\/(\\xc3\\xa9){100}\/(\\xc3\\xa9){24}\\xc3$/);
		expect(answer).toEqual({
			problem: problem("SITE_FILE_NAME", `a/${"\u00e9".repeat(100)}/${"\u00e9".repeat(24)}\ufffd`),
		});
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

	it("refuses a page that links from the root in any attribute that loads or leads somewhere, naming the file and the link", async () => {
		for (const [body, link] of [
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
		])
			await refusedWith({ "index.html": page(body) }, `SITE_LINKS_FROM_ROOT index.html ${link}\n`);
	});

	it("refuses a style sheet that links from the root, in url() or @import", async () => {
		for (const [css, link] of [
			['@import "/base.css";', "/base.css"],
			["@import '/print.css' print;", "/print.css"],
			["@import url(/u.css);", "/u.css"],
			['@font-face { src: url("/f.woff2") format("woff2"); }', "/f.woff2"],
			["a { background: URL(  /x.png  ) }", "/x.png"],
		])
			await refusedWith(
				{ "index.html": page("x"), "css/site.css": css },
				`SITE_LINKS_FROM_ROOT css/site.css ${link}\n`,
			);
		// A page of any case of its extension; the first link in C order of the files: a.css before index.html.
		await refusedWith(
			{ "index.html": page("x"), "Page.HTM": page('<a href="/x">x</a>') },
			"SITE_LINKS_FROM_ROOT Page.HTM /x\n",
		);
		await refusedWith(
			{ "index.html": page('<link href="/i.css">'), "a.css": "b { background: url(/a.png) }" },
			"SITE_LINKS_FROM_ROOT a.css /a.png\n",
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
			'<meta http-equiv="refresh" content="30"><meta name="description" content="/not-a-link">',
			'<div data="/not-object" title="/x" data-href="/x" class="/x">x</div><object data="o.svg"></object>',
			'<!-- <link rel="stylesheet" href="/commented.css"> --><!--[if IE]><script src="/ie.js"></script><![endif]-->',
			"<script>var s = '<img src=\"/in-script.png\">'; fetch('/api/x');</script>",
			'<pre>&lt;a href="/in-pre"&gt;</pre><p>text with href="/x" in it</p>',
			'<style>/* url(/in-comment.png) */ a::after { content: "url(/in-string.png)"; } b { background: url(c.png) }</style>',
			'<div style="background: url(rel.png)">x</div>',
		].join("\n");
		const files = {
			"index.html": page(body),
			"a.css": '/* @import "/c.css"; */ b { background: url("img/b.png"), url(data:image/png;base64,/9j/x) }',
			"app.js": "fetch('/api/items'); const u = '/src/x.js';",
			"notes.txt": '<a href="/x">',
			"img/x.svg": '<svg><image href="/i.png"/></svg>',
		};
		const run = await collectOf(files);
		expect(run.output).toMatch(/^tree [0-9a-f]{40}\nfiles 5\n/);
	});

	it("never names a file or a link that holds a secret value, in any spelling: only the variable", async () => {
		const environment = { QORPERA_SITE_SECRET_NAMES: "LINK_KEY", LINK_KEY: "link-secret-4242" };
		// Written plainly the file's bytes hold it, and the scan of the bytes names the file as before.
		const plain = await collectOf({ "index.html": page('<a href="/k/link-secret-4242">x</a>') }, environment);
		expect(plain.output).toBe("SITE_HOLDS_SECRET LINK_KEY index.html\n");
		// By character references, only the link the parser reads holds it: the variable alone.
		const spelled = await collectOf({ "index.html": page('<a href="/k/&#108;ink-secret-4242">x</a>') }, environment);
		expect(spelled).toMatchObject({ code: 3, output: "SITE_HOLDS_SECRET LINK_KEY\n" });
		const err = await readFile(join(spelled.m.root, spelled.name, "site.err"), "utf8");
		for (const text of [plain.output, spelled.output, err]) expect(text).not.toContain("link-secret-4242");
		expect(await spelled.m.wrote(spelled.name)).toEqual([]);
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
		console.log(
			`links: 25 MiB of dense pages and styles ${Math.round(made.ms)} ms, odd shapes ${Math.round(slow.ms)} ms`,
		);
		expect(made.ms).toBeLessThan(60_000);
		expect(slow.ms).toBeLessThan(60_000);
	});
});
