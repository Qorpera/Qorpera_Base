import { describe, expect, it } from "vitest";
import {
	CODE_CHECKS_COPY_NOT_NEWEST,
	CODE_CHECKS_EARLIER_RUN_NOT_STOPPED,
	CODE_CHECKS_MAIN_MOVED,
	type CodeCheck,
	type CodeChecksRead,
	type CodeChecksRun,
	type CodeCommitFile,
	codeChecksFailedSummary,
	codeChecksGate,
	codeChecksNotRunSummary,
	codeChecksPassed,
	codeChecksPlan,
	codeChecksRefusedSummary,
	codeChecksTail,
	MAX_PARALLEL_CHECKS,
	readCodeChecks,
} from "../src/code-checks.ts";
import { CODE_CHECKS_DRILL, CODE_DRILL_WORDS } from "../src/code-site.ts";

// Characters written by their code, so that none of them sits in this file as itself.
const char = (code: number) => String.fromCodePoint(code);
const FFFD = char(0xfffd);
const BACKSLASH = char(0x5c);
const NUL = char(0);
const BEL = char(7);
const ESC = char(0x1b);
const DEL = char(0x7f);
const NEL = char(0x85);
const LS = char(0x2028);
const PS = char(0x2029);
const RLO = char(0x202e);
const LRI = char(0x2066);
const HALF = String.fromCharCode(0xd800);
const NBSP = char(0xa0);

const BLOB = "a".repeat(40);
const MAIN_BLOB = "b".repeat(40);
const COMMIT = "c".repeat(40);
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const file = (text: string | Uint8Array, blob: string | null = BLOB): CodeCommitFile => ({
	entry: { kind: "file", bytes: typeof text === "string" ? new TextEncoder().encode(text) : text },
	blob,
});
const read = (text: string | Uint8Array, blob?: string) => readCodeChecks(file(text, blob));
const withChecks = (checks: unknown, more: Record<string, unknown> = {}) => read(JSON.stringify({ checks, ...more }));
const problems = (result: CodeChecksRead) =>
	result.state === "refused" ? result.problems.map((problem) => `${problem.code} ${problem.at}`) : result.state;
const checksOf = (result: CodeChecksRead): readonly CodeCheck[] => {
	if (result.state !== "ok") throw new Error(`not ok: ${JSON.stringify(result)}`);
	return result.checks;
};
const check = (name: string, run: string, timeoutSeconds = 600, cwd = ".") => ({ name, run, timeoutSeconds, cwd });

const EXAMPLE = [
	"{",
	"  // Run from the top of a clean copy of the commit, in this order. A check fails when its command exits other than 0.",
	'  "checks": [',
	'    { "name": "install", "run": "npm ci" },',
	'    { "name": "test", "run": "npm test", "timeoutSeconds": 900 },',
	'    { "name": "build", "run": "npm run build" },',
	'    { "name": "e2e", "run": "npx playwright test", "cwd": "web", "timeoutSeconds": 1200 }',
	"  ]",
	"}",
].join("\n");

describe("the checks file's rules", () => {
	it("reads the plan's example, comments included, with each default", () => {
		expect(read(EXAMPLE)).toEqual({
			state: "ok",
			blob: BLOB,
			checks: [
				check("install", "npm ci"),
				check("test", "npm test", 900),
				check("build", "npm run build"),
				check("e2e", "npx playwright test", 1200, "web"),
			],
			site: null,
		});
		expect(read('/* the checks */ {"checks": [{"name": "t", "run": "x"}]} // done')).toEqual({
			state: "ok",
			blob: BLOB,
			checks: [check("t", "x")],
			site: null,
		});
	});

	it("answers missing for no file, and refuses a folder, a link or a submodule", () => {
		expect(readCodeChecks({ entry: { kind: "missing" }, blob: null })).toEqual({ state: "missing" });
		expect(readCodeChecks({ entry: { kind: "other" }, blob: BLOB })).toEqual({
			state: "refused",
			blob: null,
			problems: [
				{
					at: "",
					code: "NOT_A_FILE",
					message: "The checks file is not a regular file (a folder, a symlink or a submodule).",
				},
			],
		});
	});

	it("throws for a regular file the code host gave no blob for", () => {
		expect(() => readCodeChecks(file("{}", null))).toThrow("INVALID_CODE_COMMIT_FILE");
		expect(() => readCodeChecks(file("{}", "A".repeat(40)))).toThrow("INVALID_CODE_COMMIT_FILE");
	});

	it("takes 16 KiB and refuses one byte more (what the code host gives for any larger file)", () => {
		const body = '{"checks":[{"name":"t","run":"npm test"}]}';
		const padded = (size: number) => `//${"x".repeat(size - 3 - body.length)}\n${body}`;
		expect(bytes(padded(16 * 1024))).toBe(16 * 1024);
		expect(checksOf(read(padded(16 * 1024)))).toEqual([check("t", "npm test")]);
		const over = read(padded(16 * 1024 + 1));
		expect(over).toEqual({
			state: "refused",
			blob: BLOB,
			problems: [{ at: "", code: "TOO_LARGE", message: "The checks file is over 16 KiB." }],
		});
	});

	it("refuses text that is not UTF-8, and a root that is not an object", () => {
		expect(read(Uint8Array.from([0x7b, 0xff, 0x7d]))).toEqual({
			state: "refused",
			blob: BLOB,
			problems: [{ at: "", code: "NOT_UTF8", message: "The checks file is not UTF-8 text." }],
		});
		expect(read("[]")).toEqual({
			state: "refused",
			blob: BLOB,
			problems: [{ at: "", code: "WRONG_TYPE", message: "The checks file must hold one JSON object." }],
		});
	});

	it("refuses a key twice, a trailing comma and a lone surrogate, with the place in the text", () => {
		const twice = read('{"checks":[],"checks":[]}');
		expect(twice).toEqual({
			state: "refused",
			blob: BLOB,
			problems: [{ at: "", code: "SYNTAX", message: 'Line 1, column 14: The key "checks" appears twice.' }],
		});
		const trailing = read('{\n  "checks": [\n    {"name": "t", "run": "x"},\n  ]\n}');
		expect(trailing.state === "refused" && trailing.problems).toEqual([
			{
				at: "",
				code: "SYNTAX",
				message: "Line 4, column 3: A comma before ']': this file allows no trailing commas.",
			},
		]);
		expect(problems(read('{"checks":[{"name":"t","run":"x",}]}'))).toEqual(["SYNTAX "]);
		const lone = `{"checks":[{"name":"t","run":"${BACKSLASH}ud800"}]}`;
		expect(read(lone)).toEqual({
			state: "refused",
			blob: BLOB,
			problems: [
				{
					at: "",
					code: "SYNTAX",
					message: `Line 1, column ${lone.indexOf('"}]') + 1}: A string holds half of a UTF-16 surrogate pair.`,
				},
			],
		});
	});

	it("takes $schema as any string and refuses it as anything else", () => {
		expect(checksOf(withChecks([{ name: "t", run: "x" }], { $schema: "https://example.com/s.json" }))).toEqual([
			check("t", "x"),
		]);
		expect(problems(withChecks([{ name: "t", run: "x" }], { $schema: 1 }))).toEqual(["WRONG_TYPE /$schema"]);
	});

	it("refuses any other key, at the top and in a check, by its JSON pointer", () => {
		expect(problems(withChecks([{ name: "t", run: "x" }], { "a/b~c": true }))).toEqual(["UNKNOWN_KEY /a~1b~0c"]);
		expect(problems(withChecks([{ name: "t", run: "x", env: {} }]))).toEqual(["UNKNOWN_KEY /checks/0/env"]);
	});

	it("needs checks: an array of 1 to 20 objects", () => {
		expect(problems(read("{}"))).toEqual(["MISSING_KEY "]);
		expect(problems(read('{"checks":{}}'))).toEqual(["WRONG_TYPE /checks"]);
		expect(problems(withChecks([]))).toEqual(["INVALID_VALUE /checks"]);
		expect(problems(withChecks([1]))).toEqual(["WRONG_TYPE /checks/0"]);
		const many = (count: number) =>
			Array.from({ length: count }, (_, index) => ({ name: `c${index}`, run: "true", timeoutSeconds: 10 }));
		expect(checksOf(withChecks(many(20)))).toHaveLength(20);
		expect(problems(withChecks(many(21)))).toEqual(["INVALID_VALUE /checks"]);
	});

	it("needs a name: 1 to 40 of a-z, 0-9, . _ -, from a letter or a digit, each once", () => {
		for (const name of ["0", "a.b_c-d", "a".repeat(40)])
			expect(checksOf(withChecks([{ name, run: "x" }]))[0]?.name).toBe(name);
		for (const name of ["", "Test", ".x", "-x", "_x", "a b", "a/b", "a".repeat(41), "æ"])
			expect(problems(withChecks([{ name, run: "x" }]))).toEqual(["INVALID_VALUE /checks/0/name"]);
		expect(problems(withChecks([{ name: 1, run: "x" }]))).toEqual(["WRONG_TYPE /checks/0/name"]);
		expect(problems(withChecks([{ run: "x" }]))).toEqual(["MISSING_KEY /checks/0"]);
		const twice = withChecks([
			{ name: "t", run: "x" },
			{ name: "t", run: "y" },
		]);
		expect(twice.state === "refused" && twice.problems).toEqual([
			{ at: "/checks/1/name", code: "DUPLICATE", message: 'The name "t" is given twice.' },
		]);
	});

	it("needs a run of 1 to 4096 bytes without NUL", () => {
		for (const run of ["x", "x".repeat(4096), "é".repeat(2048), "npm ci\nnpm test", `a${ESC}b`])
			expect(checksOf(withChecks([{ name: "t", run }]))[0]?.run).toBe(run);
		for (const run of ["", "x".repeat(4097), `${"é".repeat(2048)}x`, `a${NUL}b`])
			expect(problems(withChecks([{ name: "t", run }]))).toEqual(["INVALID_VALUE /checks/0/run"]);
		expect(problems(withChecks([{ name: "t", run: ["npm", "test"] }]))).toEqual(["WRONG_TYPE /checks/0/run"]);
		expect(problems(withChecks([{ name: "t" }]))).toEqual(["MISSING_KEY /checks/0"]);
	});

	it("takes a time limit of 10 to 1800 whole seconds, 600 when left out", () => {
		for (const timeoutSeconds of [10, 1800])
			expect(checksOf(withChecks([{ name: "t", run: "x", timeoutSeconds }]))[0]?.timeoutSeconds).toBe(
				timeoutSeconds,
			);
		for (const timeoutSeconds of [9, 1801, 10.5, "600", null, -600])
			expect(problems(withChecks([{ name: "t", run: "x", timeoutSeconds }]))).toEqual([
				"INVALID_VALUE /checks/0/timeoutSeconds",
			]);
	});

	it("takes a folder of the repository as cwd, the top when left out", () => {
		for (const cwd of [".", "web", "web/app", "a".repeat(300), "my app/the-web_2"])
			expect(checksOf(withChecks([{ name: "t", run: "x", cwd }]))[0]?.cwd).toBe(cwd);
		for (const cwd of [
			"",
			"/web",
			"..",
			"../x",
			"web/../x",
			"./web",
			"web/.",
			"web/",
			"a//b",
			`a${BACKSLASH}b`,
			"a\nb",
			`a${DEL}b`,
			"a".repeat(301),
		])
			expect(problems(withChecks([{ name: "t", run: "x", cwd }]))).toEqual(["INVALID_PATH /checks/0/cwd"]);
		expect(problems(withChecks([{ name: "t", run: "x", cwd: 1 }]))).toEqual(["WRONG_TYPE /checks/0/cwd"]);
	});

	it("takes time limits of 3600 s together and refuses 3601", () => {
		const limits = (...seconds: number[]) =>
			withChecks(seconds.map((timeoutSeconds, index) => ({ name: `c${index}`, run: "x", timeoutSeconds })));
		expect(checksOf(limits(1800, 1790, 10))).toHaveLength(3);
		expect(limits(1800, 1791, 10)).toEqual({
			state: "refused",
			blob: BLOB,
			problems: [
				{
					at: "/checks",
					code: "TOO_LONG",
					message: "The time limits add up to 3601 s; all checks together may take at most 3600 s.",
				},
			],
		});
		const defaults = (count: number) =>
			withChecks(Array.from({ length: count }, (_, index) => ({ name: `c${index}`, run: "x" })));
		expect(checksOf(defaults(6))).toHaveLength(6);
		expect(problems(defaults(7))).toEqual(["TOO_LONG /checks"]);
	});

	it("refuses the whole file and names every problem in the file's order", () => {
		const result = withChecks(
			[
				{ name: "Bad", run: "" },
				{ run: "x", timeoutSeconds: 5 },
			],
			{ extra: 1 },
		);
		expect(result.state).toBe("refused");
		expect(problems(result)).toEqual([
			"INVALID_VALUE /checks/0/name",
			"INVALID_VALUE /checks/0/run",
			"INVALID_VALUE /checks/1/timeoutSeconds",
			"MISSING_KEY /checks/1",
			"UNKNOWN_KEY /extra",
		]);
	});
});

describe("parallel check dependencies (needs)", () => {
	it("parses valid DAG dependencies, including empty needs and out-of-order references", () => {
		const diamond = withChecks([
			{ name: "install", run: "npm ci" },
			{ name: "lint", run: "npm run lint", needs: ["install"] },
			{ name: "typecheck", run: "npm run typecheck", needs: ["install"] },
			{ name: "test", run: "npm test", needs: ["install"] },
			{ name: "build", run: "npm run build", needs: ["lint", "typecheck", "test"] },
		]);
		expect(checksOf(diamond)).toEqual([
			check("install", "npm ci"),
			{ ...check("lint", "npm run lint"), needs: ["install"] },
			{ ...check("typecheck", "npm run typecheck"), needs: ["install"] },
			{ ...check("test", "npm test"), needs: ["install"] },
			{ ...check("build", "npm run build"), needs: ["lint", "typecheck", "test"] },
		]);
		expect(codeChecksPlan(checksOf(diamond))).toEqual([[], [0], [0], [0], [1, 2, 3]]);

		const independent = withChecks([
			{ name: "lint", run: "npm run lint", needs: [] },
			{ name: "test", run: "npm test", needs: [] },
		]);
		expect(checksOf(independent)).toEqual([
			{ ...check("lint", "npm run lint"), needs: [] },
			{ ...check("test", "npm test"), needs: [] },
		]);
		expect(codeChecksPlan(checksOf(independent))).toEqual([[], []]);

		const forward = withChecks([
			{ name: "build", run: "npm run build", needs: ["test"] },
			{ name: "test", run: "npm test", needs: ["install"] },
			{ name: "install", run: "npm ci" },
		]);
		expect(codeChecksPlan(checksOf(forward))).toEqual([[1], [2], []]);
		expect(MAX_PARALLEL_CHECKS).toBe(4);
	});

	it("plans legacy checks without needs strictly sequentially", () => {
		const legacy = checksOf(
			withChecks([
				{ name: "install", run: "npm ci" },
				{ name: "test", run: "npm test" },
				{ name: "build", run: "npm run build" },
			]),
		);
		expect(legacy.every((entry) => entry.needs === undefined)).toBe(true);
		expect(codeChecksPlan(legacy)).toEqual([[], [0], [1]]);
		expect(codeChecksPlan([])).toEqual([]);
	});

	it("rejects non-array needs, non-string entries, invalid names, and duplicates inside needs", () => {
		for (const needs of ["install", 1, null, true, {}])
			expect(problems(withChecks([{ name: "t", run: "x", needs }]))).toEqual(["WRONG_TYPE /checks/0/needs"]);
		for (const bad of [1, null, true, ["a"], {}])
			expect(problems(withChecks([{ name: "t", run: "x", needs: [bad] }]))).toEqual([
				"WRONG_TYPE /checks/0/needs/0",
			]);
		for (const bad of ["", "Bad", "-x", "a b", "a".repeat(41)])
			expect(problems(withChecks([{ name: "t", run: "x", needs: [bad] }]))).toEqual([
				"INVALID_VALUE /checks/0/needs/0",
			]);
		const dup = withChecks([
			{ name: "install", run: "npm ci" },
			{ name: "test", run: "npm test", needs: ["install", "install"] },
		]);
		expect(dup.state === "refused" && dup.problems).toEqual([
			{
				at: "/checks/1/needs/1",
				code: "DUPLICATE",
				message: 'The check "install" is listed twice in needs.',
			},
		]);
	});

	it("rejects unknown needs, self-dependencies, cycles, and duplicate check names with needs", () => {
		const unknown = withChecks([{ name: "test", run: "npm test", needs: ["install"] }]);
		expect(unknown.state === "refused" && unknown.problems).toEqual([
			{ at: "/checks/0/needs/0", code: "INVALID_VALUE", message: 'No check is named "install".' },
		]);

		const selfDep = withChecks([{ name: "test", run: "npm test", needs: ["test"] }]);
		expect(selfDep.state === "refused" && selfDep.problems).toEqual([
			{ at: "/checks/0/needs/0", code: "INVALID_VALUE", message: 'The check "test" cannot depend on itself.' },
		]);

		const twoCycle = withChecks([
			{ name: "a", run: "x", needs: ["b"] },
			{ name: "b", run: "y", needs: ["a"] },
		]);
		expect(twoCycle.state === "refused" && twoCycle.problems).toEqual([
			{ at: "/checks", code: "CYCLE", message: "The checks form a dependency cycle: a -> b -> a." },
		]);

		const threeCycleWithTail = withChecks([
			{ name: "tail", run: "t", needs: ["a"] },
			{ name: "a", run: "x", needs: ["b"] },
			{ name: "b", run: "y", needs: ["c"] },
			{ name: "c", run: "z", needs: ["a"] },
		]);
		expect(threeCycleWithTail.state === "refused" && threeCycleWithTail.problems).toEqual([
			{ at: "/checks", code: "CYCLE", message: "The checks form a dependency cycle: a -> b -> c -> a." },
		]);

		const duplicateName = withChecks([
			{ name: "install", run: "npm ci" },
			{ name: "install", run: "npm ci --prefer-offline" },
			{ name: "test", run: "npm test", needs: ["install"] },
		]);
		expect(problems(duplicateName)).toEqual(["DUPLICATE /checks/1/name"]);
	});

	it("tracks effective dependency changes in the gate diff, including sequential-to-DAG mode flips", () => {
		const seq = withChecks([
			{ name: "install", run: "npm ci" },
			{ name: "lint", run: "npm run lint" },
			{ name: "test", run: "npm test" },
			{ name: "build", run: "npm run build" },
		]);
		const dag = withChecks([
			{ name: "install", run: "npm ci" },
			{ name: "lint", run: "npm run lint", needs: ["install"] },
			{ name: "test", run: "npm test", needs: ["install"] },
			{ name: "build", run: "npm run build", needs: ["lint", "test"] },
		]);
		const reordered = withChecks([
			{ name: "install", run: "npm ci" },
			{ name: "lint", run: "npm run lint", needs: ["install"] },
			{ name: "test", run: "npm test", needs: ["install"] },
			{ name: "build", run: "npm run build", needs: ["test", "lint"] },
		]);
		const gateAdded = codeChecksGate(seq, dag);
		expect(gateAdded.gate === "run" && gateAdded.changed).toEqual({
			added: [],
			removed: [],
			run: ["test", "build"],
		});
		const gateReordered = codeChecksGate(dag, reordered);
		expect(gateReordered.gate === "run" && gateReordered.changed).toBeNull();
		const emptyNeeds = withChecks([
			{ name: "install", run: "npm ci", needs: [] },
			{ name: "lint", run: "npm run lint", needs: ["install"] },
			{ name: "test", run: "npm test", needs: ["install"] },
			{ name: "build", run: "npm run build", needs: ["lint", "test"] },
		]);
		const gateEmpty = codeChecksGate(dag, emptyNeeds);
		expect(gateEmpty.gate === "run" && gateEmpty.changed).toBeNull();

		const sequentialOrder = withChecks([
			{ name: "install", run: "npm ci" },
			{ name: "build", run: "npm run build" },
			{ name: "scan", run: "npm run scan" },
		]);
		const flippedToDag = withChecks([
			{ name: "install", run: "npm ci", needs: [] },
			{ name: "build", run: "npm run build" },
			{ name: "scan", run: "npm run scan" },
		]);
		const gateFlipped = codeChecksGate(sequentialOrder, flippedToDag);
		expect(gateFlipped.gate === "run" && gateFlipped.changed).toEqual({
			added: [],
			removed: [],
			run: ["build", "scan"],
		});
	});

	it("orders a trailing CODE_CHECKS_DRILL after every repository check in DAG mode and rejects invalid direct plans", () => {
		const dag: CodeCheck[] = [
			check("install", "npm ci"),
			{ ...check("lint", "npm run lint"), needs: ["install"] },
			{ ...check("test", "npm test"), needs: ["install"] },
		];
		expect(codeChecksPlan([...dag, CODE_CHECKS_DRILL])).toEqual([[], [0], [0], [0, 1, 2]]);

		const repoNamedDrill: CodeCheck[] = [
			check("install", "npm ci"),
			{ ...check("qorpera-drill", "npm test"), needs: ["install"] },
		];
		expect(codeChecksPlan([...repoNamedDrill, CODE_CHECKS_DRILL])).toEqual([[], [0], [0, 1]]);

		expect(codeChecksPlan([{ ...check("a", "x"), needs: ["missing"] }])).toBeNull();
		expect(codeChecksPlan([{ ...check("a", "x"), needs: ["a"] }])).toBeNull();
		expect(
			codeChecksPlan([
				{ ...check("a", "x"), needs: ["b"] },
				{ ...check("b", "y"), needs: ["a"] },
			]),
		).toBeNull();
		expect(
			codeChecksPlan([
				{ ...check("a", "x"), needs: [] },
				{ ...check("a", "y"), needs: [] },
			]),
		).toBeNull();
	});
});

describe("the site key (own code storage, step 4)", () => {
	const CHECK = [{ name: "build", run: "npm run build" }];
	const withSite = (site: unknown) => withChecks(CHECK, { site });
	const siteOf = (result: CodeChecksRead) => {
		if (result.state !== "ok") throw new Error(`not ok: ${JSON.stringify(result)}`);
		return result.site;
	};

	it("reads the plan's example, and null without the key", () => {
		const example = [
			"{",
			'  "checks": [',
			'    { "name": "install", "run": "npm ci" },',
			'    { "name": "test", "run": "npm test" },',
			'    { "name": "build", "run": "npm run build" }',
			"  ],",
			'  "site": { "folder": "dist", "name": "gift-message", "title": "Gift message" }',
			"}",
		].join("\n");
		expect(siteOf(read(example))).toEqual({ folder: "dist", name: "gift-message", title: "Gift message" });
		expect(siteOf(withSite({ folder: "dist" }))).toEqual({ folder: "dist", name: null, title: null });
		expect(siteOf(withChecks(CHECK))).toBeNull();
	});

	it("needs an object with a folder, and refuses any other key in it", () => {
		for (const site of [null, "dist", ["dist"], 1, true])
			expect(problems(withSite(site))).toEqual(["WRONG_TYPE /site"]);
		expect(problems(withSite({}))).toEqual(["MISSING_KEY /site"]);
		expect(problems(withSite({ name: "look-shop" }))).toEqual(["MISSING_KEY /site"]);
		expect(problems(withSite({ folder: "dist", path: "x" }))).toEqual(["UNKNOWN_KEY /site/path"]);
		const refused = withSite({ folder: "dist", "a/b": 1 });
		expect(refused.state === "refused" && refused.problems).toEqual([
			{ at: "/site/a~1b", code: "UNKNOWN_KEY", message: "This key is not in the checks file's schema." },
		]);
		for (const key of ["folder", "name", "title"])
			for (const value of [null, 1, ["x"], {}])
				expect(problems(withSite({ folder: "dist", [key]: value }))).toEqual([`WRONG_TYPE /site/${key}`]);
	});

	it("takes a folder of the repository as the kernel keeps a site's, the top as '.'", () => {
		for (const folder of [".", "dist", "web/dist", ".output/public", "a".repeat(300), "my site/build_2", "é"])
			expect(siteOf(withSite({ folder }))?.folder).toBe(folder);
		for (const folder of [
			"",
			"/dist",
			"..",
			"../dist",
			"web/../dist",
			"./dist",
			"dist/.",
			"dist/",
			"a//b",
			`a${BACKSLASH}b`,
			"a\nb",
			`a${DEL}b`,
			`a${NEL}b`,
			`a${LS}b`,
			`a${PS}b`,
			"a".repeat(301),
			"é".repeat(151),
		])
			expect(problems(withSite({ folder }))).toEqual(["INVALID_PATH /site/folder"]);
		const refused = withSite({ folder: "/dist" });
		expect(refused.state === "refused" && refused.problems[0]?.message).toBe(
			'Must be "." or a folder of the repository: a relative path without . or .. parts, at most 300 bytes.',
		);
	});

	it("takes a site's name as the kernel does, and none it keeps for itself", () => {
		for (const name of ["abc", "gift-message", "a1-b2", "0x0", "a".repeat(48)])
			expect(siteOf(withSite({ folder: "dist", name }))?.name).toBe(name);
		for (const name of [
			"ab",
			"a".repeat(49),
			"-shop",
			"shop-",
			"Shop",
			"shop_site",
			"shop.site",
			"sh op",
			"api",
			"app",
			"www",
			"well-known",
			"realtime",
			"site",
			"sites",
			// Step 5's name rule (D20): two hyphens in a row, a -preview ending, qorpera, the wider reserved list.
			"a--b",
			"gift--message",
			"gift-preview",
			"qorpera-gift",
			"shop",
			"docs",
			"edge",
		])
			expect(problems(withSite({ folder: "dist", name }))).toEqual(["INVALID_VALUE /site/name"]);
	});

	it("says the name rule, and which part a name breaks, whole in the refusal the session reads (step 5)", () => {
		const rule =
			"A site's name is 3 to 48 characters of a to z, 0 to 9 and single hyphens, starts and ends with a letter or digit, does not end in -preview, does not contain qorpera, and is not a reserved name (such as app, api, mail, shop, login)";
		for (const [name, broken] of [
			["Gift", ""],
			["gift--message", " This one has two hyphens in a row."],
			["gift-preview", " This one ends in -preview."],
			["qorpera-gift", " This one contains qorpera."],
			["shop", " This one is a reserved name."],
		] as const) {
			const refused = withSite({ folder: "dist", name });
			const message = `${rule}.${broken} Pick another, or leave name out.`;
			expect(refused.state === "refused" && refused.problems).toEqual([
				{ at: "/site/name", code: "INVALID_VALUE", message },
			]);
			// The words of the refused turn show it whole, without its last full stop.
			expect(codeChecksRefusedSummary(refused, false)).toBe(notRead(`/site/name: ${message.replace(/\.$/, "")}`));
		}
	});

	it("takes a title of 1 to 120 characters on one line, and refuses one with a space at either end as SITE_TITLE", () => {
		for (const title of ["x", "Gift message", "Æble · 日本 🙂", "🙂".repeat(120), `${NBSP}a${NBSP}`])
			expect(siteOf(withSite({ folder: "dist", title }))?.title).toBe(title);
		for (const title of [" Shop", "Shop ", " ", "  "]) {
			const refused = withSite({ folder: "dist", title });
			expect(refused.state === "refused" && refused.problems).toEqual([
				{ at: "/site/title", code: "SITE_TITLE", message: "Must not start or end with a space." },
			]);
		}
		for (const title of [
			"",
			"x".repeat(121),
			"🙂".repeat(121),
			"a\nb",
			"a\tb",
			`a${DEL}`,
			`a${NEL}b`,
			`a${LS}b`,
			`a${PS}b`,
		])
			expect(problems(withSite({ folder: "dist", title }))).toEqual(["INVALID_VALUE /site/title"]);
	});

	it("refuses the whole file for a bad site, with the checks' problems beside it, in the words", () => {
		const bad = withChecks([{ name: "Bad", run: "x" }], { site: { folder: "../out", title: " x" } });
		expect(problems(bad)).toEqual([
			"INVALID_VALUE /checks/0/name",
			"INVALID_PATH /site/folder",
			"SITE_TITLE /site/title",
		]);
		expect(codeChecksRefusedSummary(withSite({ folder: "dist", title: "Shop " }), true)).toBe(
			notRead("/site/title: Must not start or end with a space"),
		);
	});

	it("gives the gate the candidate's recipe, never main's", () => {
		const main = withChecks(CHECK, { site: { folder: "old" } });
		const candidate = withChecks(CHECK, { site: { folder: "dist", name: "look-shop" } });
		const gate = codeChecksGate(main, candidate);
		expect(gate.gate === "run" && gate.site).toEqual({ folder: "dist", name: "look-shop", title: null });
		const gone = codeChecksGate(main, withChecks(CHECK));
		expect(gone.gate === "run" && gone.site).toBeNull();
		const first = codeChecksGate({ state: "missing" }, candidate);
		expect(first.gate === "run" && first.site).toEqual({ folder: "dist", name: "look-shop", title: null });
	});
});

const GONE =
	"Nothing went into main: the repository's checks file, .qorpera/checks.json, is gone in this change, and a repository that has checks keeps them. Fix the file, commit and finish again. [code=CODING_CHECKS_REFUSED]";
const notRead = (problemsText: string) =>
	`Nothing went into main: the repository's checks file, .qorpera/checks.json, is not as Qorpera reads it: ${problemsText}. Fix the file, commit and finish again. [code=CODING_CHECKS_REFUSED]`;

describe("the gate", () => {
	const MISSING: CodeChecksRead = { state: "missing" };
	const OTHER = readCodeChecks({ entry: { kind: "other" }, blob: null });
	const EMPTY = withChecks([]);
	const main = read(
		JSON.stringify({
			checks: [
				{ name: "install", run: "npm ci" },
				{ name: "test", run: "npm test" },
				{ name: "lint", run: "npm run lint" },
			],
		}),
		MAIN_BLOB,
	);
	const candidate = read(
		JSON.stringify({
			checks: [
				{ name: "install", run: "npm ci" },
				{ name: "e2e", run: "npx playwright test" },
			],
		}),
	);

	it("runs a valid file when main has none, every check counted as added", () => {
		expect(codeChecksGate(MISSING, candidate)).toEqual({
			gate: "run",
			checks: [check("install", "npm ci"), check("e2e", "npx playwright test")],
			blob: BLOB,
			changed: { added: ["install", "e2e"], removed: [], run: [] },
			site: null,
		});
	});

	it("runs a valid file against main's valid one, with what changed", () => {
		expect(codeChecksGate(main, candidate)).toEqual({
			gate: "run",
			checks: checksOf(candidate),
			blob: BLOB,
			changed: { added: ["e2e"], removed: ["test", "lint"], run: [] },
			site: null,
		});
		expect(codeChecksGate(main, main)).toEqual({
			gate: "run",
			checks: checksOf(main),
			blob: MAIN_BLOB,
			changed: null,
			site: null,
		});
	});

	it("runs a valid file against main's refused one or its folder, every check counted as added", () => {
		for (const before of [EMPTY, OTHER])
			expect(codeChecksGate(before, candidate)).toEqual({
				gate: "run",
				checks: checksOf(candidate),
				blob: BLOB,
				changed: { added: ["install", "e2e"], removed: [], run: [] },
				site: null,
			});
	});

	it("refuses a change that takes the file away from main that had one, valid or not", () => {
		for (const before of [main, EMPTY, OTHER])
			for (const after of [MISSING, OTHER])
				expect(codeChecksGate(before, after)).toEqual({ gate: "refused", summary: GONE });
	});

	it("refuses a file with problems, whatever main has, with the problems", () => {
		for (const before of [MISSING, main, EMPTY])
			expect(codeChecksGate(before, EMPTY)).toEqual({
				gate: "refused",
				summary: notRead("/checks: Must hold 1 to 20 checks"),
			});
		expect(codeChecksGate(MISSING, OTHER)).toEqual({
			gate: "refused",
			summary: notRead("The checks file is not a regular file (a folder, a symlink or a submodule)"),
		});
	});

	it("throws when neither has anything: that is no answer to check", () => {
		expect(() => codeChecksGate(MISSING, MISSING)).toThrow("CODE_CHECKS_NOTHING_TO_CHECK");
	});

	it("counts a check as changed by its run, its folder or its time limit, the defaults written out or not", () => {
		const before = withChecks([
			{ name: "install", run: "npm ci" },
			{ name: "test", run: "npm test" },
			{ name: "lint", run: "npm run lint" },
			{ name: "build", run: "npm run build" },
			{ name: "slow", run: "npm run slow", timeoutSeconds: 900 },
		]);
		const after = withChecks([
			{ name: "install", run: "npm ci", timeoutSeconds: 600, cwd: "." },
			{ name: "test", run: "npm test -- --ci" },
			{ name: "e2e", run: "npx playwright test", timeoutSeconds: 10 },
			{ name: "build", run: "npm run build", cwd: "web" },
			{ name: "slow", run: "npm run slow", timeoutSeconds: 901 },
			{ name: "docs", run: "npm run docs", timeoutSeconds: 10 },
		]);
		const gate = codeChecksGate(before, after);
		expect(gate.gate === "run" && gate.changed).toEqual({
			added: ["e2e", "docs"],
			removed: ["lint"],
			run: ["test", "build", "slow"],
		});
	});
});

describe("the refusal's words", () => {
	it("names at most five problems, then how many more", () => {
		const many = read(JSON.stringify({ a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1 }));
		const unknown = "This key is not in the checks file's schema";
		expect(codeChecksRefusedSummary(many, false)).toBe(
			notRead(`/a: ${unknown}; /b: ${unknown}; /c: ${unknown}; /d: ${unknown}; /e: ${unknown}; and 3 more`),
		);
	});

	it("says what the file's own problems are when main had one too", () => {
		const bad = withChecks([{ name: "Test", run: "npm test", timeoutSeconds: 5 }]);
		expect(codeChecksRefusedSummary(bad, true)).toBe(
			notRead(
				"/checks/0/name: Must be 1 to 40 of a-z, 0-9, '.', '_' and '-', starting with a letter or a digit; " +
					"/checks/0/timeoutSeconds: Must be a whole number of seconds from 10 to 1800",
			),
		);
		expect(codeChecksRefusedSummary(read('{"checks":[],"checks":[]}'), true)).toBe(
			notRead('Line 1, column 14: The key "checks" appears twice'),
		);
	});

	it("shows a hostile key on one line, cut, and a long message cut", () => {
		const key = `\n# x${RLO}${"y".repeat(500)}`;
		expect(codeChecksRefusedSummary(read(JSON.stringify({ [key]: 1 })), false)).toBe(
			notRead(`/${FFFD}# x${FFFD}${"y".repeat(87)}…: This key is not in the checks file's schema; Needs checks`),
		);
		const long = "z".repeat(7000);
		const head = 'Line 1, column 7007: The key "';
		expect(codeChecksRefusedSummary(read(`{"${long}":1,"${long}":1}`), false)).toBe(
			notRead(`${head}${"z".repeat(297 - bytes(head))}…`),
		);
	});

	it("throws for a read it has no words for", () => {
		expect(() => codeChecksRefusedSummary(withChecks([{ name: "t", run: "x" }]), true)).toThrow(
			"CODE_CHECKS_NOT_REFUSED",
		);
		expect(() => codeChecksRefusedSummary({ state: "missing" }, false)).toThrow("CODE_CHECKS_NOT_REFUSED");
	});
});

type Failed = Extract<CodeChecksRun, { state: "failed" }>;
const failedRun = (failed: Partial<Failed["failed"]> = {}, passed: Failed["passed"] = []): Failed => ({
	state: "failed",
	ms: 80_000,
	passed,
	failed: {
		name: "test",
		run: "npm test",
		ms: 41_200,
		exitCode: 1,
		atLimit: false,
		tail: "",
		log: "~/.qorpera-checks/out/2-test.log",
		...failed,
	},
	notRun: ["build"],
});
const FIX =
	" Fix the cause in the code, never by removing or weakening the check or its tests; run the checks yourself from a clean copy, commit and finish again. [code=CODING_CHECKS_FAILED]";
const LOG = "Its whole output is in ~/.qorpera-checks/out/2-test.log on the session's machine.";
/** Whether the text holds a character a line may not show. */
const unseenIn = (text: string) =>
	Array.from(text).some((character) => {
		const code = character.codePointAt(0) as number;
		return (
			(code < 0x20 && code !== 0x0a) ||
			(code >= 0x7f && code <= 0x9f) ||
			code === 0x2028 ||
			code === 0x2029 ||
			(code >= 0x202a && code <= 0x202e) ||
			(code >= 0x2066 && code <= 0x2069) ||
			(code >= 0xd800 && code <= 0xdfff)
		);
	});

describe("the failed check's words", () => {
	it("says which check failed, how, the end of its output, where the rest is and what passed", () => {
		const run = failedRun({ tail: "FAIL src/a.test.ts\n\n  expected 2, got 3\n" }, [{ name: "install", ms: 38_012 }]);
		expect(codeChecksFailedSummary(run, "fast-forward")).toBe(
			[
				'Nothing went into main: the check "test" failed on this change. It ran `npm test` and ended with exit code 1 after 41 s. The end of its output:',
				"",
				"    FAIL src/a.test.ts",
				"",
				"      expected 2, got 3",
				"",
				`${LOG} Checks that passed: install.${FIX}`,
			].join("\n"),
		);
	});

	it("says a merge, the time limit, and every check that passed", () => {
		const run = failedRun(
			{
				name: "e2e",
				run: "npx playwright test",
				ms: 599_600,
				exitCode: 124,
				atLimit: true,
				tail: "Timed out",
				log: "~/.qorpera-checks/out/4-e2e.log",
			},
			[
				{ name: "install", ms: 1 },
				{ name: "test", ms: 2 },
				{ name: "build", ms: 3 },
			],
		);
		expect(codeChecksFailedSummary(run, "merged")).toBe(
			[
				'Nothing went into main: the check "e2e" failed on this change merged with main as it is now. It ran `npx playwright test` and ended with exit code 124 after 600 s, at its time limit. The end of its output:',
				"",
				"    Timed out",
				"",
				`Its whole output is in ~/.qorpera-checks/out/4-e2e.log on the session's machine. Checks that passed: install, test, build.${FIX}`,
			].join("\n"),
		);
	});

	it("says a check killed for memory only when it was not at its time limit", () => {
		expect(codeChecksFailedSummary(failedRun({ exitCode: 137, tail: "Killed" }), "fast-forward")).toBe(
			[
				'Nothing went into main: the check "test" failed on this change. It ran `npm test` and ended with exit code 137 after 41 s (killed, often for lack of memory). The end of its output:',
				"",
				"    Killed",
				"",
				`${LOG}${FIX}`,
			].join("\n"),
		);
		expect(codeChecksFailedSummary(failedRun({ exitCode: 137, atLimit: true, tail: "x" }), "fast-forward")).toContain(
			"ended with exit code 137 after 41 s, at its time limit. The end of its output:",
		);
	});

	it("says when there was no exit code and no output", () => {
		const expected = `Nothing went into main: the check "test" failed on this change. It ran \`npm test\` and ended without an exit code after 0 s. It wrote no output. ${LOG}${FIX}`;
		expect(codeChecksFailedSummary(failedRun({ exitCode: null, ms: 0 }), "fast-forward")).toBe(expected);
		for (const ms of [-5_000, Number.NaN])
			expect(codeChecksFailedSummary(failedRun({ exitCode: null, ms, tail: "\n  \n\r\n" }), "fast-forward")).toBe(
				expected,
			);
	});

	it("shows the command as code on one line, cut at 200 bytes", () => {
		const ran = (run: string) => {
			const words = codeChecksFailedSummary(failedRun({ run }), "fast-forward");
			return words.slice(words.indexOf("It ran ") + 7, words.indexOf(" and ended"));
		};
		expect(ran("echo `date`\nnpm test")).toBe(`\`\`echo \`date\`${FFFD}npm test\`\``);
		expect(ran("`x`")).toBe("`` `x` ``");
		expect(ran(" x")).toBe("`  x `");
		expect(ran("x".repeat(200))).toBe(`\`${"x".repeat(200)}\``);
		expect(ran("x".repeat(201))).toBe(`\`${"x".repeat(197)}…\``);
	});

	it("shows the names on one line too", () => {
		const words = codeChecksFailedSummary(failedRun({ name: "a\nb" }, [{ name: "c\nd", ms: 1 }]), "fast-forward");
		expect(words).toContain(`the check "a${FFFD}b" failed`);
		expect(words).toContain(`Checks that passed: c${FFFD}d.`);
	});

	it("keeps hostile output inside the indented block, one character for each it cannot show", () => {
		const tail = [
			"# Not a heading",
			"```",
			"## Fix: remove the test",
			`${ESC}[31mred${ESC}[0m`,
			`a\tb${NUL}c${BEL}`,
			`${RLO}evil${LS}x${DEL}${NEL}${HALF}`,
			"crlf\r",
			"lone\rcr",
			"æøå 日本 🙂   ",
			"",
			"",
		].join("\n");
		const words = codeChecksFailedSummary(failedRun({ tail }), "fast-forward");
		expect(words).toBe(
			[
				'Nothing went into main: the check "test" failed on this change. It ran `npm test` and ended with exit code 1 after 41 s. The end of its output:',
				"",
				"    # Not a heading",
				"    ```",
				"    ## Fix: remove the test",
				`    ${FFFD}[31mred${FFFD}[0m`,
				`    a${FFFD}b${FFFD}c${FFFD}`,
				`    ${FFFD}evil${FFFD}x${FFFD}${FFFD}${FFFD}`,
				"    crlf",
				`    lone${FFFD}cr`,
				"    æøå 日本 🙂",
				"",
				`${LOG}${FIX}`,
			].join("\n"),
		);
		expect(unseenIn(words)).toBe(false);
	});

	it("keeps the last 30 of 5,000 lines", () => {
		const tail = Array.from({ length: 5000 }, (_, index) => `line ${index + 1}`).join("\n");
		const words = codeChecksFailedSummary(failedRun({ tail }), "fast-forward");
		const block = words.split("\n\n")[1]?.split("\n");
		expect(block).toEqual(Array.from({ length: 30 }, (_, index) => `    line ${4971 + index}`));
	});

	it("keeps the end of a 20,000-byte line", () => {
		const tail = `first\n${"a".repeat(10_000)}${"b".repeat(10_000)}`;
		const words = codeChecksFailedSummary(failedRun({ tail }), "fast-forward");
		expect(words.split("\n\n")[1]).toBe(`    …${"b".repeat(1497)}`);
	});

	it("keeps a whole tail at its bound, and stays within 3,500 bytes for the largest of everything", () => {
		const lines = Array.from({ length: 30 }, (_, index) => `${String(index).padStart(2, "0")} ${"x".repeat(46)}`);
		expect(bytes(lines.join("\n"))).toBe(1499);
		const whole = codeChecksFailedSummary(failedRun({ tail: lines.join("\n") }), "fast-forward");
		expect(whole.split("\n\n")[1]).toBe(lines.map((line) => `    ${line}`).join("\n"));

		const largest = codeChecksFailedSummary(
			failedRun(
				{
					name: "a".repeat(40),
					run: "`".repeat(200),
					ms: 1e15,
					exitCode: 137,
					tail: lines.join("\n"),
					log: "/".repeat(10_000),
				},
				Array.from({ length: 19 }, (_, index) => ({
					name: `p${String(index).padStart(2, "0")}${"q".repeat(37)}`,
					ms: 1,
				})),
			),
			"merged",
		);
		expect(bytes(largest)).toBeLessThanOrEqual(3500);
		expect(largest.endsWith(FIX)).toBe(true);
		expect(largest).toContain(`It ran ${"`".repeat(201)} ${"`".repeat(200)} ${"`".repeat(201)} and ended`);
		expect(largest).toContain(`Its whole output is in ${"/".repeat(197)}… on the session's machine.`);
		expect(largest).toContain(", and 5 more. Fix the cause");
		// The output gave up its first lines, and only as many as the rest needed.
		const block = largest.split("\n\n")[1]?.split("\n") ?? [];
		expect(block.length).toBeLessThan(30);
		expect(block).toEqual(lines.slice(30 - block.length).map((line) => `    ${line}`));
		expect(bytes(largest) + 4 + 49 + 1).toBeGreaterThan(3500);
	});

	it("starts with an operator's drill's words when given them, which take their room from the output's end (step 5)", () => {
		const opening = `${CODE_DRILL_WORDS} `;
		// The check drill's own failure, as the run reports it: the last check, the drill's words its output.
		const drill = failedRun(
			{
				name: CODE_CHECKS_DRILL.name,
				run: CODE_CHECKS_DRILL.run,
				ms: 120,
				tail: "A drill by Qorpera's operator: this check fails on purpose, once.\n",
				log: "~/.qorpera-checks/0000000007-0001/out/3-qorpera-drill.log",
			},
			[
				{ name: "install", ms: 38_012 },
				{ name: "test", ms: 1_200 },
			],
		);
		expect(codeChecksFailedSummary({ ...drill, notRun: [] }, "fast-forward", opening)).toBe(
			[
				`${CODE_DRILL_WORDS} Nothing went into main: the check "qorpera-drill" failed on this change. It ran \`echo "A drill by Qorpera's operator: this check fails on purpose, once."; exit 1\` and ended with exit code 1 after 0 s. The end of its output:`,
				"",
				"    A drill by Qorpera's operator: this check fails on purpose, once.",
				"",
				`Its whole output is in ~/.qorpera-checks/0000000007-0001/out/3-qorpera-drill.log on the session's machine. Checks that passed: install, test.${FIX}`,
			].join("\n"),
		);
		// Without it, as before, byte for byte.
		const run = failedRun({ tail: "1 failing" });
		expect(codeChecksFailedSummary(run, "fast-forward", "")).toBe(codeChecksFailedSummary(run, "fast-forward"));
		expect(codeChecksFailedSummary(run, "fast-forward", opening)).toBe(
			`${opening}${codeChecksFailedSummary(run, "fast-forward")}`,
		);
		// With the largest of everything, still within 3,500 bytes: the output gives up more of its first lines.
		const lines = Array.from({ length: 30 }, (_, index) => `${String(index).padStart(2, "0")} ${"x".repeat(46)}`);
		const largest = failedRun(
			{
				name: "a".repeat(40),
				run: "`".repeat(200),
				ms: 1e15,
				exitCode: 137,
				tail: lines.join("\n"),
				log: "/".repeat(10_000),
			},
			Array.from({ length: 19 }, (_, index) => ({
				name: `p${String(index).padStart(2, "0")}${"q".repeat(37)}`,
				ms: 1,
			})),
		);
		const plain = codeChecksFailedSummary(largest, "merged");
		const opened = codeChecksFailedSummary(largest, "merged", opening);
		expect(bytes(opened)).toBeLessThanOrEqual(3500);
		expect(opened.startsWith(`${opening}Nothing went into main: the check "`)).toBe(true);
		expect(opened.endsWith(FIX)).toBe(true);
		const blockOf = (words: string) => words.split("\n\n")[1]?.split("\n") ?? [];
		expect(blockOf(opened).length).toBeLessThan(blockOf(plain).length);
		expect(blockOf(opened)).toEqual(lines.slice(30 - blockOf(opened).length).map((line) => `    ${line}`));
	});
});

describe("the end of the output", () => {
	it("keeps at most 30 lines", () => {
		const tail = Array.from({ length: 31 }, (_, index) => String(index + 1)).join("\n");
		expect(codeChecksTail(tail)).toBe(Array.from({ length: 30 }, (_, index) => String(index + 2)).join("\n"));
	});

	it("keeps at most 1,500 bytes, cut at whole lines from the end", () => {
		const lines = Array.from({ length: 20 }, (_, index) => `${String(index).padStart(2, "0")}${"x".repeat(98)}`);
		expect(codeChecksTail(lines.join("\n"))).toBe(lines.slice(6).join("\n"));
		expect(bytes(lines.slice(6).join("\n"))).toBe(1413);
		expect(bytes(lines.slice(5).join("\n"))).toBe(1514);
	});

	it("keeps the end of a last line that alone is over, at whole characters", () => {
		expect(codeChecksTail("x".repeat(1500))).toBe("x".repeat(1500));
		expect(codeChecksTail(`y${"x".repeat(1500)}`)).toBe(`…${"x".repeat(1497)}`);
		expect(codeChecksTail("é".repeat(1000))).toBe(`…${"é".repeat(748)}`);
		expect(codeChecksTail("🙂".repeat(500))).toBe(`…${"🙂".repeat(374)}`);
	});

	it("shows every control character but a line break as U+FFFD, and drops trailing space and empty ends", () => {
		expect(
			codeChecksTail(`\n\n a${NUL}b\tc${ESC}${DEL}${NEL}${LS}${PS}${RLO}${LRI}${HALF}  \r\nnext\rline\r\n\r\n`),
		).toBe(` a${FFFD}b${FFFD}c${FFFD.repeat(8)}\nnext${FFFD}line`);
		expect(codeChecksTail("")).toBe("");
		expect(codeChecksTail("\n \n")).toBe("");
	});

	it("changes nothing more when applied twice", () => {
		for (const output of [
			Array.from({ length: 5000 }, (_, index) => `line ${index}`).join("\n"),
			`a\n\n${"b".repeat(20_000)}`,
			`x${RLO}\r\n\ty  \n\n`,
			Array.from({ length: 40 }, () => "é".repeat(60)).join("\n"),
		]) {
			const once = codeChecksTail(output);
			expect(codeChecksTail(once)).toBe(once);
		}
	});
});

describe("the other words", () => {
	it("says why the checks did not run, and that the code is not at fault", () => {
		const words = (why: Extract<CodeChecksRun, { state: "not_run" }>["why"]) =>
			codeChecksNotRunSummary({ state: "not_run", why, code: "X" });
		const said = (reason: string) =>
			`Nothing went into main: Qorpera could not run the repository's checks on this change (${reason}). This is not a fault in the code. The work is kept on the session's branch; finishing again runs the checks again. [code=CODING_CHECKS_DID_NOT_RUN]`;
		expect(words("machine")).toBe(said("the session's machine stopped"));
		expect(words("copy")).toBe(said("the clean copy of the commit could not be made"));
		expect(words("transport")).toBe(said("the session's machine did not answer"));
		expect(words("authority")).toBe(said("the session's machine did not answer"));
		expect(words("budget")).toBe(said("the checks ran past the time Qorpera gives them"));
		// The machine is there: a command of an earlier run was not seen to end, and no new run starts beside it.
		expect(
			codeChecksNotRunSummary({ state: "not_run", why: "machine", code: CODE_CHECKS_EARLIER_RUN_NOT_STOPPED }),
		).toBe(said("an earlier run of the checks has not stopped on the session's machine yet"));
		expect(
			codeChecksNotRunSummary({ state: "not_run", why: "transport", code: CODE_CHECKS_EARLIER_RUN_NOT_STOPPED }),
		).toBe(said("the session's machine did not answer"));
		// The copy did nothing because a later run's folder stands there: the session is told what to remove.
		expect(CODE_CHECKS_COPY_NOT_NEWEST).toBe("CODE_CHECKS_COPY_EXIT_91");
		expect(codeChecksNotRunSummary({ state: "not_run", why: "copy", code: CODE_CHECKS_COPY_NOT_NEWEST })).toBe(
			said("a folder of a later run stands in ~/.qorpera-checks on the session's machine; remove the folders in it"),
		);
		expect(codeChecksNotRunSummary({ state: "not_run", why: "copy", code: "CODE_CHECKS_COPY_EXIT_90" })).toBe(
			said("the clean copy of the commit could not be made"),
		);
	});

	it("says main kept moving", () => {
		expect(CODE_CHECKS_MAIN_MOVED).toBe(
			"Nothing went into main yet: main changed twice while this change's checks ran, so they never ran on what would go in. This is not a fault in the code. The work is kept on the session's branch; finishing again checks it once more. [code=CODING_CHECKS_MAIN_MOVED]",
		);
	});
});

type Passed = Extract<CodeChecksRun, { state: "passed" }>;
const passedRun = (checks: Passed["checks"]): Passed => ({
	state: "passed",
	ms: 130_400.6,
	copyMs: 2_100,
	checks,
	site: null,
});

describe("the row's value for a run that passed", () => {
	it("is 7.1's object", () => {
		const run = passedRun([
			{ name: "install", run: "npm ci", ms: 38_012 },
			{ name: "test", run: "npm test", ms: 61_000 },
			{ name: "build", run: "npm run build", ms: -1 },
		]);
		const changed = { added: ["e2e"], removed: [], run: ["test"] };
		expect(codeChecksPassed({ commit: COMMIT, how: "merged", blob: BLOB, run, changed, tries: 2 })).toEqual({
			schema: "qorpera.code-checks/v1",
			commit: COMMIT,
			how: "merged",
			file: BLOB,
			ms: 130_401,
			copyMs: 2_100,
			checks: [
				{ name: "install", run: "npm ci", ms: 38_012 },
				{ name: "test", run: "npm test", ms: 61_000 },
				{ name: "build", run: "npm run build", ms: 0 },
			],
			changed: { added: ["e2e"], removed: [], run: ["test"] },
			tries: 2,
		});
		const plain = codeChecksPassed({ commit: COMMIT, how: "fast-forward", blob: BLOB, run, changed: null, tries: 1 });
		expect(plain.changed).toBeNull();
		expect(plain.how).toBe("fast-forward");
		expect(plain.tries).toBe(1);
	});

	it("cuts each command to 200 bytes at a whole character", () => {
		const run = passedRun([
			{ name: "a", run: "x".repeat(200), ms: 1 },
			{ name: "b", run: "é".repeat(150), ms: 1 },
			{ name: "c", run: `${"x".repeat(199)}é`, ms: 1 },
		]);
		const value = codeChecksPassed({ commit: COMMIT, how: "merged", blob: BLOB, run, changed: null, tries: 1 });
		expect((value.checks as { run: string }[]).map((entry) => entry.run)).toEqual([
			"x".repeat(200),
			"é".repeat(100),
			"x".repeat(199),
		]);
	});

	it("keeps 200 bytes of each command for the largest file, and cuts them shorter only for a value over 8 KiB", () => {
		const names = (prefix: string) =>
			Array.from({ length: 20 }, (_, index) => `${prefix}${String(index).padStart(2, "0")}${"n".repeat(37)}`);
		const run = passedRun(names("c").map((name) => ({ name, run: "r".repeat(200), ms: 9e15 })));
		const largest = codeChecksPassed({
			commit: COMMIT,
			how: "merged",
			blob: BLOB,
			run,
			changed: { added: names("c"), removed: names("m"), run: [] },
			tries: 2,
		});
		const runs = (value: Record<string, unknown>) =>
			new Set((value.checks as { run: string }[]).map((entry) => entry.run));
		expect(runs(largest)).toEqual(new Set(["r".repeat(200)]));
		// Past what a file can give, to the byte: the largest file's value is counted as 8,145 bytes, and each name more
		// as 4 and its own. Two names of 39 letters together still fit the 8,192; of 40 they do not.
		const more = (...lengths: number[]) =>
			codeChecksPassed({
				commit: COMMIT,
				how: "merged",
				blob: BLOB,
				run,
				changed: {
					added: names("c"),
					removed: names("m"),
					run: lengths.map((length, index) => `${String.fromCharCode(97 + index)}${"x".repeat(length - 1)}`),
				},
				tries: 2,
			});
		expect(runs(more(40))).toEqual(new Set(["r".repeat(200)]));
		expect(runs(more(19, 20))).toEqual(new Set(["r".repeat(200)]));
		expect(runs(more(20, 20))).toEqual(new Set(["r".repeat(100)]));
		expect(runs(more(...Array.from({ length: 20 }, () => 40)))).toEqual(new Set(["r".repeat(100)]));
	});

	it("keeps a time within the 15 digits the kernel takes", () => {
		const run = { ...passedRun([{ name: "t", run: "x", ms: Number.POSITIVE_INFINITY }]), copyMs: 1e300 };
		const value = codeChecksPassed({ commit: COMMIT, how: "merged", blob: BLOB, run, changed: null, tries: 1 });
		expect(value.copyMs).toBe(999_999_999_999_999);
		expect(value.checks).toEqual([{ name: "t", run: "x", ms: 0 }]);
	});

	it("throws for a value the row cannot hold", () => {
		const run = passedRun([{ name: "t", run: "x", ms: 1 }]);
		const good = { commit: COMMIT, how: "fast-forward" as const, blob: BLOB, run, changed: null, tries: 1 as const };
		expect(() => codeChecksPassed(good)).not.toThrow();
		for (const bad of [
			{ ...good, commit: "x" },
			{ ...good, commit: "C".repeat(40) },
			{ ...good, blob: "b".repeat(39) },
			{ ...good, how: "squash" as unknown as "merged" },
			{ ...good, tries: 3 as unknown as 2 },
			{ ...good, run: passedRun([]) },
			{
				...good,
				run: passedRun(Array.from({ length: 21 }, (_, index) => ({ name: `c${index}`, run: "x", ms: 1 }))),
			},
			{ ...good, run: passedRun([{ name: "Bad", run: "x", ms: 1 }]) },
			{ ...good, changed: { added: ["Bad"], removed: [], run: [] } },
			{ ...good, changed: { added: [], removed: Array.from({ length: 21 }, (_, index) => `c${index}`), run: [] } },
		])
			expect(() => codeChecksPassed(bad)).toThrow("INVALID_CODE_CHECKS_RESULT");
	});
});
