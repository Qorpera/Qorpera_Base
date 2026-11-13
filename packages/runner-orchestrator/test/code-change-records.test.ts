import type { CloudCodingRepository } from "@qorpera/contracts";
import { describe, expect, it, vi } from "vitest";
import {
	answeredBefore,
	CODE_CHANGE_CHECKS_BYTES,
	CODE_CHANGE_PICTURE_PATH_BYTES,
	CODE_CHANGE_RECORD_BYTES,
	CODE_CHANGE_RPCS,
	type CodeChangeFile,
	type CodeChangeLine,
	CodeChangeRecords,
	type CodeChangeRecordsOptions,
	codeChangeDiffReported,
	codeChangeErrorCode,
	codeChangeIndexText,
	codeChangeRecordText,
	codeChangeRefusalPaths,
} from "../src/code-change-records.ts";
import {
	type CodeChangeDiff,
	type CodeChangeRecordFile,
	type CodeHostGcBlock,
	type CodeHostJob,
	CodeHostJobFailure,
	CodeHostRefusal,
} from "../src/code-host-jobs.ts";
import { CODE_HOST_LAYOUT, type CodeHostJobOptions, type CodeHostJobs } from "../src/code-host-views.ts";
import { CodingControlBusy } from "../src/coding-executor.ts";
import { watchAbortSignalAny } from "./helpers/abort-any.ts";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT = "33333333-3333-4333-8333-333333333333";
const OWNER = "coding-node-1";
const MACHINE = "d".repeat(64);
const BEFORE = "5564b36e".padEnd(40, "0");
const AFTER = "c3082dc1".padEnd(40, "1");
const BLOB = "b".repeat(40);
const TARGET = { companyId: COMPANY, environmentId: ENVIRONMENT, owner: "qorpera", name: "shop" };
const REPOSITORY: CloudCodingRepository = { host: "qorpera", owner: "qorpera", name: "shop", baseBranch: "main" };
const bytes = (text: string) => Buffer.byteLength(text);
// Characters a record must never hold, made here so that no editor or tool can change them on the way.
const NUL = String.fromCharCode(0);
const ESC = String.fromCharCode(27);
const BELL = String.fromCharCode(7);
const DEL = String.fromCharCode(0x7f);
const C1 = String.fromCharCode(0x9b);
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const NEL = String.fromCharCode(0x85);
const RLO = String.fromCharCode(0x202e);
const ISOLATE = String.fromCharCode(0x2067);
const HALF = String.fromCharCode(0xd83d);
const GONE = String.fromCharCode(0xfffd);

/** The checks of a landing whose every check passed (step 3, `checks` of the row), as the plan's example has them. */
const PASSED = {
	schema: "qorpera.code-checks/v1",
	commit: AFTER,
	how: "fast-forward",
	file: "f".repeat(40),
	ms: 130_400,
	copyMs: 2100,
	checks: [
		{ name: "install", run: "npm ci", ms: 38_012 },
		{ name: "test", run: "npm test", ms: 60_600 },
		{ name: "build", run: "npm run build", ms: 30_501 },
	],
	changed: null,
	tries: 1,
};

/** The plan's own example: change 14, a landing. */
function change(extra: Partial<CodeChangeFile> = {}): CodeChangeFile {
	return {
		n: 14,
		version: 1,
		kind: "landing",
		state: "landed",
		how: "fast-forward",
		createdAt: "2026-11-10T12:11:05.123456+00:00",
		title: "Free returns line under each price",
		session: "QorperaOS/agents/cto/todos/shop/returns-line",
		turn: 2,
		mainBefore: BEFORE,
		mainAfter: AFTER,
		headSha: AFTER,
		summary: "Added the line under each price and a test for it. Ran npm test: 21 passed.",
		notice: 'Each price now says "Free returns within 30 days".',
		picture: {
			source: "commit",
			path: "docs/changes/free-returns.png",
			blob: BLOB,
			at: "code/qorpera/shop/changes/14.png",
		},
		pictureProblem: null,
		filesChanged: 3,
		paths: [
			{ path: "src/price.tsx", change: "changed" },
			{ path: "tests/price.test.tsx", change: "added" },
			{ path: "docs/changes/free-returns.png", change: "added" },
		],
		pathsMore: 0,
		needsDiff: false,
		refusal: null,
		undoes: null,
		revertedBy: null,
		restoredFrom: null,
		checksState: "passed",
		checks: PASSED,
		...extra,
	};
}
/** A change as the kernel sends it: the row's picture whole. */
function sent(extra: Partial<CodeChangeFile> = {}): Record<string, unknown> {
	const row = change(extra);
	return {
		...row,
		picture:
			row.picture?.source === "commit" ? { ...row.picture, bytes: 51_234, type: "png" } : (row.picture ?? null),
	};
}
const text = (...lines: string[]) => `${lines.join("\n")}\n`;
/** A record's checks: its head line, and its section without the heading; undefined where it has none. */
function checksIn(made: string): { head: string | undefined; section: string | undefined } {
	return {
		head: made.split("\n").find((line) => line.startsWith("- Checks: ")),
		section: made.split("\n## Checks\n\n")[1]?.split("\n\n## ")[0]?.replace(/\n$/, ""),
	};
}
/** The section of the plan's example, as the record writes it. */
const EXAMPLE = [
	"Passed on what went into main, in 2 min 10 s:",
	"",
	"- `install`: `npm ci` (38 s)",
	"- `test`: `npm test` (61 s)",
	"- `build`: `npm run build` (31 s)",
];

describe("codeChangeRecordText", () => {
	it("writes a landing as the plan's example, byte for byte", () => {
		expect(codeChangeRecordText(change())).toBe(
			text(
				"# Change 14: Free returns line under each price",
				"",
				"- State: in main",
				"- When: 2026-11-10 12:11 UTC",
				"- What: a change from a coding session",
				"- Session: `QorperaOS/agents/cto/todos/shop/returns-line` (turn 2)",
				"- Went in as: a fast-forward",
				`- Main before: ${BEFORE}`,
				`- Main after: ${AFTER}`,
				"- Files changed: 3",
				"- Checks: passed",
				"",
				"## What a customer will notice",
				"",
				'> Each price now says "Free returns within 30 days".',
				"",
				"## Picture",
				"",
				"`code/qorpera/shop/changes/14.png`",
				"",
				"## Checks",
				"",
				...EXAMPLE,
				"",
				"## What the session said",
				"",
				"> Added the line under each price and a test for it. Ran npm test: 21 passed.",
				"",
				"## Files",
				"",
				"- changed `src/price.tsx`",
				"- added `tests/price.test.tsx`",
				"- added `docs/changes/free-returns.png`",
			),
		);
	});

	it("says what is missing, and leaves out what a row does not have", () => {
		expect(
			codeChangeRecordText(
				change({
					how: "merged",
					session: null,
					turn: null,
					notice: null,
					picture: null,
					summary: null,
					filesChanged: null,
					paths: null,
					checksState: null,
					checks: null,
				}),
			),
		).toBe(
			text(
				"# Change 14: Free returns line under each price",
				"",
				"- State: in main",
				"- When: 2026-11-10 12:11 UTC",
				"- What: a change from a coding session",
				"- Went in as: a merge",
				`- Main before: ${BEFORE}`,
				`- Main after: ${AFTER}`,
				// With no count of files, the checks' line is the head's last.
				"- Checks: unknown",
				"",
				"## What a customer will notice",
				"",
				"Nothing was said.",
				"",
				"## Picture",
				"",
				"None.",
				"",
				"## Checks",
				"",
				"Unknown: this change went in before Qorpera ran checks, or Qorpera did not see it go in.",
			),
		);
		// Each picture that was given and did not pass, in words; a picture an agent named later, by its folder path.
		const picture = (extra: Partial<CodeChangeFile>) =>
			codeChangeRecordText(change({ picture: null, ...extra }))
				.split("\n## Picture\n\n")[1]
				?.split("\n")[0];
		expect(picture({ pictureProblem: "missing" })).toBe("None: the picture given was not found.");
		expect(picture({ pictureProblem: "not_a_file" })).toBe("None: the picture given was not a file.");
		expect(picture({ pictureProblem: "too_large" })).toBe("None: the picture given was too large.");
		expect(picture({ pictureProblem: "not_a_picture" })).toBe("None: the picture given was not a picture.");
		expect(picture({ pictureProblem: "not_shared" })).toBe(
			"None: the picture given was not in the company's shared folders.",
		);
		expect(picture({ pictureProblem: "something else" })).toBe("None.");
		expect(picture({ picture: { source: "folder", path: "QorperaOS/pictures/new price.png" } })).toBe(
			"`QorperaOS/pictures/new price.png`",
		);
		// The path of a picture an agent named may be as long as `manage_code describe` takes one: 1024 bytes. It comes
		// through whole, so a reader can open the file it names.
		for (const long of [
			`pictures/${"a".repeat(801 - 13)}.png`,
			`pictures/${"a".repeat(1024 - 13)}.png`,
			`pictures/${"é".repeat((1024 - 13) / 2 - 1)}xy.png`,
		]) {
			expect(bytes(long)).toBeGreaterThan(800);
			expect(bytes(long)).toBeLessThanOrEqual(1024);
			expect(picture({ picture: { source: "folder", path: long } })).toBe(`\`${long}\``);
		}
		expect(bytes(`pictures/${"a".repeat(1024 - 13)}.png`)).toBe(CODE_CHANGE_PICTURE_PATH_BYTES);
		// No row holds a longer one; if one came, it would be cut there, with the mark of a cut.
		expect(picture({ picture: { source: "folder", path: `pictures/${"a".repeat(2000)}.png` } })).toBe(
			`\`pictures/${"a".repeat(1024 - 9 - 3)}…\``,
		);
		// A landing that changed no file, and a time that is none.
		const empty = codeChangeRecordText(change({ filesChanged: 0, paths: [], createdAt: "soon" }));
		expect(empty).toContain("\n- When: unknown\n");
		expect(empty.endsWith("\n- Files changed: 0\n\n## What a customer will notice\n")).toBe(false);
		expect(empty.endsWith("\n## Files\n\nNone.\n")).toBe(true);
	});

	it("writes each state and each kind in its own words", () => {
		const head = (extra: Partial<CodeChangeFile>) =>
			codeChangeRecordText(change({ session: null, turn: null, how: null, ...extra }))
				.split("\n")
				.slice(2, 5);
		expect(head({ state: "reverted", revertedBy: 15 })).toEqual([
			"- State: undone by change 15",
			"- When: 2026-11-10 12:11 UTC",
			"- What: a change from a coding session",
		]);
		expect(head({ state: "lost" })[0]).toBe("- State: no longer in the repository: a restore went back past it");
		expect(head({ kind: "found" })[2]).toBe("- What: a change whose record was lost");
		expect(head({ kind: "undo", undoes: [12] })[2]).toBe("- What: an undo of change 12");
		expect(head({ kind: "undo", undoes: [14, 12, 13] })[2]).toBe("- What: an undo of changes 12 to 14");
		expect(head({ kind: "restore", restoredFrom: "20261109T021455Z-aaaaaaaaaaaa" })[2]).toBe(
			"- What: a restore from the copy of 2026-11-09 02:14 UTC",
		);
		expect(head({ kind: "restore", restoredFrom: "the newest one" })[2]).toBe("- What: a restore from a copy");
		// The words under an undo and a restore are why, not a session's report.
		expect(codeChangeRecordText(change({ kind: "undo", undoes: [12], summary: "It broke the checkout." }))).toContain(
			"\n## Why it was undone\n\n> It broke the checkout.\n",
		);
		expect(
			codeChangeRecordText(change({ kind: "restore", restoredFrom: null, summary: "Disk fault on node 1." })),
		).toContain("\n## Why it was restored\n\n> Disk fault on node 1.\n");
	});

	it("writes a landing that never went in with why, and no commit of main", () => {
		const refused = {
			how: null,
			mainBefore: null,
			mainAfter: null,
			filesChanged: null,
			paths: null,
			notice: null,
			picture: null,
			summary: null,
			session: null,
			turn: null,
		};
		expect(
			codeChangeRecordText(
				change({
					...refused,
					state: "conflict",
					refusal: { code: "CODE_HOST_LAND_CONFLICT", paths: ["src/a.ts", "src/b.ts"] },
				}),
			),
		).toBe(
			text(
				"# Change 14: Free returns line under each price",
				"",
				"- State: not in main: it conflicted with main",
				"- When: 2026-11-10 12:11 UTC",
				"- What: a change from a coding session",
				"",
				"## What a customer will notice",
				"",
				"Nothing was said.",
				"",
				"## Picture",
				"",
				"None.",
				"",
				"## Why it did not go in",
				"",
				"- `src/a.ts`",
				"- `src/b.ts`",
			),
		);
		const state = (code: string) =>
			codeChangeRecordText(change({ ...refused, state: "refused", refusal: { code, paths: [] } })).split("\n")[2];
		expect(state("CODE_HOST_NAMES_DIFFER_BY_CASE")).toBe(
			"- State: not in main: refused (CODE_HOST_NAMES_DIFFER_BY_CASE)",
		);
		// A code is a code, or it is not shown.
		expect(state("[x](http://evil.example)")).toBe("- State: not in main: refused (UNKNOWN)");
		expect(state(`CODE\n- State: in main`)).toBe("- State: not in main: refused (UNKNOWN)");
	});

	it("makes the text with what the job found, for a row that had no files yet", () => {
		const row = change({ filesChanged: null, paths: null, needsDiff: true });
		const diff: CodeChangeDiff = {
			filesChanged: 53,
			paths: [
				{ path: "a.ts", change: "removed" },
				{ path: "b.ts", change: "changed" },
			],
			pathsMore: 51,
		};
		const made = codeChangeRecordText(row, diff);
		expect(made).toContain("\n- Files changed: 53\n");
		expect(made.endsWith("\n## Files\n\n- removed `a.ts`\n- changed `b.ts`\n- and 51 more\n")).toBe(true);
		// Without it, the record says nothing of files.
		expect(codeChangeRecordText(row)).not.toContain("Files");
	});

	it("keeps a hostile title to one line of words: no heading, link, code, HTML, control or turned text of its own", () => {
		const title =
			"Fix `price` [see](http://evil.example) <b>now</b>" +
			NUL +
			"\n## State: undone\r\n" +
			RLO +
			"\t*x* _y_ ~z~ #1 a&b c|d \\" +
			BELL +
			ESC +
			"[2J" +
			LS +
			"# Change 99: fake" +
			PS +
			DEL +
			C1 +
			ISOLATE +
			HALF +
			" end   ";
		const made = codeChangeRecordText(change({ title }));
		expect(made.split("\n")[0]).toBe(
			"# Change 14: Fix \\`price\\` \\[see\\](http://evil.example) \\<b\\>now\\</b\\> \\#\\# State: undone \\*x\\* \\_y\\_ \\~z\\~ \\#1 a\\&b c\\|d \\\\ \\[2J \\# Change 99: fake " +
				GONE +
				" end",
		);
		// The rest of the record is as it was: the title made no line.
		expect(made.split("\n").slice(1)).toEqual(codeChangeRecordText(change()).split("\n").slice(1));
		// A title that is nothing but such characters leaves the heading alone.
		expect(codeChangeRecordText(change({ title: `${NUL}\n\t${RLO}` })).split("\n")[0]).toBe("# Change 14");
	});

	it("quotes a session's and an agent's sentences line by line, whatever they hold", () => {
		const summary =
			"\n\n# Change 99: fake\n\n## Files\n- removed everything  \n```\nnever closed\n[State]: http://evil.example\n<script>alert(1)</script>\r\n- State: in main" +
			NUL +
			ESC +
			"[31m\rtab\there" +
			LS +
			"after a separator" +
			NEL +
			RLO +
			"turned" +
			HALF +
			"\n> quoted already\n\n\n";
		const notice = `It works.\n## Picture\n\n![x](http://evil.example/p.png)${NUL}`;
		const made = codeChangeRecordText(change({ summary, notice }));
		expect(made).toBe(
			text(
				"# Change 14: Free returns line under each price",
				"",
				"- State: in main",
				"- When: 2026-11-10 12:11 UTC",
				"- What: a change from a coding session",
				"- Session: `QorperaOS/agents/cto/todos/shop/returns-line` (turn 2)",
				"- Went in as: a fast-forward",
				`- Main before: ${BEFORE}`,
				`- Main after: ${AFTER}`,
				"- Files changed: 3",
				"- Checks: passed",
				"",
				"## What a customer will notice",
				"",
				"> It works.",
				"> ## Picture",
				">",
				"> ![x](http://evil.example/p.png)",
				"",
				"## Picture",
				"",
				"`code/qorpera/shop/changes/14.png`",
				"",
				"## Checks",
				"",
				...EXAMPLE,
				"",
				"## What the session said",
				"",
				"> # Change 99: fake",
				">",
				"> ## Files",
				"> - removed everything",
				"> ```",
				"> never closed",
				"> [State]: http://evil.example",
				"> <script>alert(1)</script>",
				"> - State: in main[31m",
				"> tab\there",
				"> after a separator",
				`> turned${GONE}`,
				"> > quoted already",
				"",
				"## Files",
				"",
				"- changed `src/price.tsx`",
				"- added `tests/price.test.tsx`",
				"- added `docs/changes/free-returns.png`",
			),
		);
		// Every line of the file is the file's own, or a quoted one: none begins with what the session wrote.
		const own = new Set(codeChangeRecordText(change({ summary: "x", notice: "y" })).split("\n"));
		for (const line of made.split("\n")) expect(own.has(line) || line.startsWith(">")).toBe(true);
		// Words that are nothing but such characters are no words.
		const none = codeChangeRecordText(change({ summary: `${NUL}\n \t\r\n${RLO}`, notice: ` ${ESC}\n` }));
		expect(none).toContain("\n## What a customer will notice\n\nNothing was said.\n");
		expect(none).not.toContain("What the session said");
	});

	it("writes every path as code, whatever it holds", () => {
		const paths = [
			"src/`x`.ts",
			"a\nb.ts",
			"app/[id]/page.tsx",
			" lead.md",
			"weird``two.md",
			"`",
			`<img src=x onerror=alert(1)>${NUL}`,
			`${RLO}gnp.exe`,
			"src/__init__.py",
			"# Change 1",
		];
		const made = codeChangeRecordText(
			change({
				filesChanged: paths.length,
				paths: paths.map((path) => ({ path, change: "added" })),
				session: "QorperaOS/agents/`cto`/todos/x\ny",
				picture: { source: "folder", path: "pictures/[new](http://evil.example).png" },
			}),
		);
		expect(made.split("\n## Files\n\n")[1]).toBe(
			text(
				"- added ``src/`x`.ts``",
				`- added \`a${GONE}b.ts\``,
				"- added `app/[id]/page.tsx`",
				"- added `  lead.md `",
				"- added ```weird``two.md```",
				"- added `` ` ``",
				`- added \`<img src=x onerror=alert(1)>${GONE}\``,
				`- added \`${GONE}gnp.exe\``,
				"- added `src/__init__.py`",
				"- added `# Change 1`",
			),
		);
		expect(made).toContain(`\n- Session: \`\`QorperaOS/agents/\`cto\`/todos/x${GONE}y\`\` (turn 2)\n`);
		expect(made).toContain("\n## Picture\n\n`pictures/[new](http://evil.example).png`\n");
		// The paths a refusal named are the repository's own bytes too: a line break in one makes no line of the file.
		const refused = codeChangeRecordText(
			change({
				state: "refused",
				refusal: {
					code: "CODE_HOST_NAMES_NOT_NFC",
					paths: ["docs/a\n## Files\n\n- added `evil`", `x\ry${NUL}`, "`"],
				},
			}),
		);
		expect(refused.split("\n## Why it did not go in\n\n")[1]?.split("\n\n## Files\n")[0]).toBe(
			[
				`- \`\` docs/a${GONE}## Files${GONE}${GONE}- added \`evil\` \`\``,
				`- \`x${GONE}y${GONE}\``,
				"- `` ` ``",
			].join("\n"),
		);
		// A commit that is no commit's name is code too.
		expect(codeChangeRecordText(change({ mainBefore: "[main](http://evil.example)" }))).toContain(
			"\n- Main before: `[main](http://evil.example)`\n",
		);
	});

	it("holds no control character and no half character, and is whole UTF-8", () => {
		const every = Array.from({ length: 0xa0 }, (_, code) => String.fromCharCode(code)).join("");
		const hostile = `${every}${LS}${PS}${RLO}${ISOLATE}${HALF}`;
		const made = codeChangeRecordText(
			change({
				title: hostile,
				summary: hostile,
				notice: hostile,
				session: hostile,
				paths: [{ path: hostile, change: "changed" }],
				refusal: { code: hostile, paths: [hostile] },
				state: "refused",
				picture: { source: "folder", path: hostile },
			}),
		);
		for (const character of made) {
			const code = character.codePointAt(0) as number;
			const allowed = code === 0x0a || code === 0x09 || (code >= 0x20 && code < 0x7f) || code > 0x9f;
			expect(allowed, `U+${code.toString(16)}`).toBe(true);
			expect(code >= 0xd800 && code <= 0xdfff).toBe(false);
			expect([0x2028, 0x2029, 0x202e, 0x2067].includes(code)).toBe(false);
		}
		expect(Buffer.from(made, "utf8").toString("utf8")).toBe(made);
		// A tab stays only in quoted words.
		for (const line of made.split("\n")) if (line.includes("\t")) expect(line.startsWith("> ")).toBe(true);
	});

	it("is at most 24 KiB whatever a row holds, and says how much it left out", () => {
		expect(CODE_CHANGE_RECORD_BYTES).toBe(24 * 1024);
		// A title of 500 bytes is cut at 400, with the mark of a cut.
		const long = codeChangeRecordText(change({ title: "a".repeat(500) }));
		expect(long.split("\n")[0]).toBe(`# Change 14: ${"a".repeat(397)}…`);
		// A summary in one line of 20,000 bytes is cut within its 12 KiB; one of many lines, at a line.
		const one = codeChangeRecordText(change({ summary: "x".repeat(20_000) }));
		expect(one).toContain(`\n## What the session said\n\n> ${"x".repeat(12 * 1024 - 6)}…\n\n## Files\n`);
		const many = codeChangeRecordText(change({ summary: Array.from({ length: 5000 }, () => "line").join("\n") }));
		const quotedLines =
			many.split("\n## What the session said\n\n")[1]?.split("\n\n## Files\n")[0]?.split("\n") ?? [];
		expect(quotedLines.at(-1)).toBe("> …");
		expect(quotedLines.slice(0, -1).every((line) => line === "> line")).toBe(true);
		expect(quotedLines.length).toBe(Math.floor((12 * 1024) / 7) + 1);
		// Fifty paths of 1,000 bytes each: as many of the first as fit, and the count of the rest with the row's own.
		const paths = Array.from({ length: 50 }, (_, at) => ({
			path: `${String(at).padStart(2, "0")}-${"p".repeat(997)}`,
			change: "changed" as const,
		}));
		const wide = codeChangeRecordText(change({ filesChanged: 120, paths, pathsMore: 70 }));
		expect(bytes(wide)).toBeLessThanOrEqual(CODE_CHANGE_RECORD_BYTES);
		const listed = wide.split("\n## Files\n\n")[1]?.trimEnd().split("\n") ?? [];
		const shown = listed.length - 1;
		expect(shown).toBeGreaterThan(15);
		expect(shown).toBeLessThan(50);
		expect(listed.slice(0, shown)).toEqual(paths.slice(0, shown).map((entry) => `- changed \`${entry.path}\``));
		expect(listed.at(-1)).toBe(`- and ${120 - shown} more`);
		// The worst a row can hold: every part at its bound, of characters that take the most room.
		const tick = "`".repeat(4000);
		const worst = codeChangeRecordText(
			change({
				title: "*".repeat(400),
				session: tick,
				summary: Array.from({ length: 4000 }, () => "").join("x\n"),
				notice: "é".repeat(200),
				picture: { source: "folder", path: tick },
				state: "refused",
				refusal: { code: "X".repeat(200), paths: Array.from({ length: 20 }, () => tick) },
				filesChanged: 50,
				paths: Array.from({ length: 50 }, () => ({ path: tick, change: "removed" as const })),
				pathsMore: 9000,
				mainBefore: tick,
				mainAfter: tick,
			}),
		);
		expect(bytes(worst)).toBeLessThanOrEqual(CODE_CHANGE_RECORD_BYTES);
		// Everything but the files, with the picture's path at its whole length: the files keep 2 KiB at the least.
		expect(bytes(worst.split("\n## Files\n")[0] ?? "")).toBeLessThan(22 * 1024);
		expect(worst.endsWith("\n## Files\n\n- 9050 not named here\n")).toBe(true);
		expect(worst).toContain("\n## Why it did not go in\n\n- 20 not named here\n");
	});
});

describe("codeChangeRecordText: the checks (step 3)", () => {
	const passed = (checks: Record<string, unknown>, extra: Partial<CodeChangeFile> = {}) =>
		checksIn(codeChangeRecordText(change({ ...extra, checks: { ...PASSED, ...checks } })));

	it("writes checks that passed on a merge, ran once more and changed the checks, byte for byte", () => {
		expect(
			passed(
				{ how: "merged", tries: 2, changed: { added: ["e2e"], removed: ["lint"], run: ["test"] } },
				{ how: "merged" },
			),
		).toEqual({
			head: "- Checks: passed",
			section: [
				"Passed on the merge of this change with main, in 2 min 10 s, and once more, since main moved meanwhile:",
				"",
				"- `install`: `npm ci` (38 s)",
				"- `test`: `npm test` (61 s)",
				"- `build`: `npm run build` (31 s)",
				"",
				"This change changed the checks: added `e2e`; removed `lint`; changed `test`.",
			].join("\n"),
		});
		// A part of the last paragraph only when it has names, and the paragraph only when one has.
		const changed = (value: unknown) => passed({ changed: value }).section?.split("\n\n")[2];
		expect(changed({ added: ["install", "test", "build"], removed: [], run: [] })).toBe(
			"This change changed the checks: added `install`, `test`, `build`.",
		);
		expect(changed({ added: [], removed: ["lint", "e2e"], run: ["test"] })).toBe(
			"This change changed the checks: removed `lint`, `e2e`; changed `test`.",
		);
		expect(changed({ added: [], removed: [], run: [] })).toBeUndefined();
		expect(changed(null)).toBeUndefined();
		expect(changed(undefined)).toBeUndefined();
		expect(passed({ changed: undefined }).section).toBe(EXAMPLE.join("\n"));
	});

	it("gives the run's time in minutes and seconds and a check's in seconds", () => {
		const times = (ms: number, check: number) =>
			passed({ ms, checks: [{ name: "test", run: "npm test", ms: check }] }).section?.split("\n");
		expect(times(45_000, 400)).toEqual(["Passed on what went into main, in 45 s:", "", "- `test`: `npm test` (0 s)"]);
		expect(times(120_000, 500)).toEqual([
			"Passed on what went into main, in 2 min:",
			"",
			"- `test`: `npm test` (1 s)",
		]);
		expect(times(3_599_499, 1_800_000)).toEqual([
			"Passed on what went into main, in 59 min 59 s:",
			"",
			"- `test`: `npm test` (1800 s)",
		]);
		expect(times(0, 0)?.[0]).toBe("Passed on what went into main, in 0 s:");
	});

	it("says a repository with no checks file had none", () => {
		expect(checksIn(codeChangeRecordText(change({ checksState: "none", checks: null })))).toEqual({
			head: "- Checks: none",
			section: "None: the repository has no checks file (`.qorpera/checks.json`).",
		});
		// A value the state carries none of changes nothing.
		expect(codeChangeRecordText(change({ checksState: "none" }))).toBe(
			codeChangeRecordText(change({ checksState: "none", checks: null })),
		);
	});

	it("says checks that are switched off did not run", () => {
		expect(checksIn(codeChangeRecordText(change({ checksState: "off", checks: null })))).toEqual({
			head: "- Checks: off",
			section: "Not run: checks are switched off for this repository.",
		});
	});

	it("names the change whose checks an undo or a restore takes over", () => {
		const inherited = { checksState: "inherited" as const, checks: { schema: "qorpera.code-checks/v1", as: 11 } };
		const expected = {
			head: "- Checks: as change 11",
			section: "Not run again: main's files are exactly those of change 11, whose checks passed.",
		};
		expect(checksIn(codeChangeRecordText(change({ kind: "undo", undoes: [12, 13], ...inherited })))).toEqual(
			expected,
		);
		expect(checksIn(codeChangeRecordText(change({ kind: "restore", ...inherited })))).toEqual(expected);
	});

	it("says Qorpera does not check an undo or a restore", () => {
		const notRun = (extra: Partial<CodeChangeFile>) =>
			checksIn(codeChangeRecordText(change({ checksState: "not_run", checks: null, ...extra })));
		expect(notRun({ kind: "undo", undoes: [12] })).toEqual({
			head: "- Checks: not run",
			section: "Not run: Qorpera does not check an undo. The next change that goes in is checked with these files.",
		});
		expect(notRun({ kind: "restore", restoredFrom: "20261109T021455Z-aaaaaaaaaaaa" })).toEqual({
			head: "- Checks: not run",
			section: "Not run: Qorpera does not check a restore.",
		});
	});

	it("says unknown for a row from before Qorpera ran checks, and for a movement nobody saw", () => {
		const unknown = {
			head: "- Checks: unknown",
			section: "Unknown: this change went in before Qorpera ran checks, or Qorpera did not see it go in.",
		};
		for (const extra of [{}, { kind: "found" as const }, { kind: "undo" as const, undoes: [3] }])
			expect(checksIn(codeChangeRecordText(change({ ...extra, checksState: null, checks: null })))).toEqual(unknown);
	});

	it("writes no checks for a landing that never went in, and keeps them for one that went in and went out again", () => {
		for (const state of ["conflict", "refused"] as const)
			expect(
				checksIn(codeChangeRecordText(change({ state, refusal: { code: "CODE_HOST_LAND_CONFLICT", paths: [] } }))),
			).toEqual({ head: undefined, section: undefined });
		expect(checksIn(codeChangeRecordText(change({ state: "reverted", revertedBy: 15 })))).toEqual({
			head: "- Checks: passed",
			section: EXAMPLE.join("\n"),
		});
		expect(checksIn(codeChangeRecordText(change({ state: "lost" }))).head).toBe("- Checks: passed");
	});

	it("reads checks that are not of their shape as unknown, and the rest of the record is as it was", () => {
		const as = (extra: Partial<CodeChangeFile>) => {
			const made = codeChangeRecordText(change(extra));
			expect(checksIn(made).head).toBe("- Checks: unknown");
			expect(made).toBe(codeChangeRecordText(change({ ...extra, checksState: null, checks: null })));
		};
		const named = (count: number, name = (at: number) => `c${at}`) =>
			Array.from({ length: count }, (_, at) => ({ name: name(at), run: "true", ms: 1 }));
		for (const checks of [
			null,
			"passed",
			[],
			7,
			{ ...PASSED, schema: "qorpera.code-checks/v2" },
			{ ...PASSED, schema: undefined },
			{ ...PASSED, how: "rebased" },
			{ ...PASSED, ms: -1 },
			{ ...PASSED, ms: 1.5 },
			{ ...PASSED, ms: "130400" },
			{ ...PASSED, tries: 3 },
			{ ...PASSED, tries: undefined },
			{ ...PASSED, checks: [] },
			{ ...PASSED, checks: named(21) },
			{ ...PASSED, checks: named(1, () => "Install") },
			{ ...PASSED, checks: named(1, () => "in`stall") },
			{ ...PASSED, checks: named(1, () => "a".repeat(41)) },
			{ ...PASSED, checks: [{ name: "install", run: null, ms: 1 }] },
			{ ...PASSED, checks: [{ name: "install", run: "npm ci" }] },
			{ ...PASSED, checks: ["install"] },
			{ ...PASSED, changed: [] },
			{ ...PASSED, changed: "test" },
			{ ...PASSED, changed: { added: ["e2e"], removed: [] } },
			{ ...PASSED, changed: { added: ["E2E"], removed: [], run: [] } },
			{ ...PASSED, changed: { added: named(21).map((check) => check.name), removed: [], run: [] } },
			{ schema: "qorpera.code-checks/v1", as: 11 },
		])
			as({ checksState: "passed", checks });
		for (const checks of [
			null,
			{},
			PASSED,
			{ schema: "qorpera.code-checks/v1", as: 0 },
			{ schema: "qorpera.code-checks/v1", as: 1.5 },
			{ schema: "qorpera.code-checks/v1", as: "11" },
			{ schema: "qorpera.code-checks/v2", as: 11 },
		])
			as({ kind: "undo", undoes: [12], checksState: "inherited", checks });
		// A state this executor does not know, and not run for a row that is neither an undo nor a restore.
		as({ checksState: "skipped" as CodeChangeFile["checksState"] });
		as({ checksState: "not_run" });
		as({ checksState: "not_run", kind: "found" });
	});

	it("keeps twenty checks with commands of 200 bytes within the section's 4 KiB, each named with its time, and the record within 24 KiB", () => {
		expect(CODE_CHANGE_CHECKS_BYTES).toBe(4096);
		const names = Array.from({ length: 20 }, (_, at) => `check-${String(at + 1).padStart(2, "0")}`);
		const run = (name: string) => `npm run ${name} -- `.padEnd(200, "x");
		const twenty = {
			...PASSED,
			checks: names.map((name) => ({ name, run: run(name), ms: 30_000 })),
			changed: { added: names, removed: [], run: [] },
		};
		expect(twenty.checks.every((check) => bytes(check.run) === 200)).toBe(true);
		const section = checksIn(codeChangeRecordText(change({ checks: twenty }))).section ?? "";
		expect(bytes(`## Checks\n\n${section}`)).toBeLessThanOrEqual(CODE_CHANGE_CHECKS_BYTES);
		// Every command is cut at one length, the longest that lets all twenty fit: 160 bytes.
		expect(section.split("\n")).toEqual([
			"Passed on what went into main, in 2 min 10 s:",
			"",
			...names.map((name) => `- \`${name}\`: \`${run(name).slice(0, 157)}…\` (30 s)`),
			"",
			`This change changed the checks: added ${names.map((name) => `\`${name}\``).join(", ")}.`,
		]);
		// Commands that fit are whole, and a command longer than 200 bytes is cut there.
		const fit = {
			...twenty,
			changed: null,
			checks: twenty.checks.map((check) => ({ ...check, run: check.run.slice(0, 150) })),
		};
		expect(
			checksIn(codeChangeRecordText(change({ checks: fit })))
				.section?.split("\n")
				.slice(2),
		).toEqual(names.map((name) => `- \`${name}\`: \`${run(name).slice(0, 150)}\` (30 s)`));
		expect(passed({ checks: [{ name: "long", run: "y".repeat(300), ms: 1000 }] }).section?.split("\n")[2]).toBe(
			`- \`long\`: \`${"y".repeat(197)}…\` (1 s)`,
		);
		// With every other part of the record at its bound, of characters that take the most room.
		const tick = "`".repeat(4000);
		const worst = codeChangeRecordText(
			change({
				title: "*".repeat(400),
				session: tick,
				summary: Array.from({ length: 4000 }, () => "").join("x\n"),
				notice: "é".repeat(200),
				picture: { source: "folder", path: tick },
				filesChanged: 50,
				paths: Array.from({ length: 50 }, () => ({ path: tick, change: "removed" as const })),
				pathsMore: 9000,
				checks: twenty,
			}),
		);
		expect(bytes(worst)).toBeLessThanOrEqual(CODE_CHANGE_RECORD_BYTES);
		expect(checksIn(worst).section).toBe(section);
		// Everything but the files: they keep 2 KiB at the least.
		expect(bytes(worst.split("\n## Files\n")[0] ?? "")).toBeLessThan(22 * 1024);
		expect(worst.endsWith("\n## Files\n\n- 9050 not named here\n")).toBe(true);
	});

	it("keeps the most a row's checks can hold within 4 KiB, with every check named", () => {
		// Names of 40 characters, commands of 200 backticks, three lists of twenty changed names, the longest time.
		const name = (letter: string, at: number) => `${letter}${String(at).padStart(2, "0")}`.padEnd(40, "-");
		const list = (letter: string) => Array.from({ length: 20 }, (_, at) => name(letter, at));
		const checks = list("c").map((check) => ({ name: check, run: "`".repeat(200), ms: Number.MAX_SAFE_INTEGER }));
		const section =
			passed(
				{
					how: "merged",
					tries: 2,
					ms: Number.MAX_SAFE_INTEGER,
					checks,
					changed: { added: list("a"), removed: list("r"), run: list("c") },
				},
				{ how: "merged" },
			).section ?? "";
		expect(bytes(`## Checks\n\n${section}`)).toBeLessThanOrEqual(CODE_CHANGE_CHECKS_BYTES);
		const lines = section.split("\n");
		expect(lines[0]).toBe(
			"Passed on the merge of this change with main, in 150119987579 min 1 s, and once more, since main moved meanwhile:",
		);
		// No room is left for the commands: each check is named with its time.
		expect(lines.slice(2, 22)).toEqual(checks.map((check) => `- \`${check.name}\` (9007199254741 s)`));
		expect(lines.slice(22)).toEqual([
			"",
			`This change changed the checks: added ${list("a")
				.map((entry) => `\`${entry}\``)
				.join(", ")}; removed ${list("r")
				.map((entry) => `\`${entry}\``)
				.join(", ")}; changed ${list("c")
				.map((entry) => `\`${entry}\``)
				.join(", ")}.`,
		]);
	});

	it("shows a command as code on its own line, whatever it holds", () => {
		const run = `npm test\n## Files\n- added \`evil\`${NUL}${ESC}[2J${RLO}${LS}${HALF}\`\`\` fence`;
		expect(passed({ checks: [{ name: "test", run, ms: 1000 }] }).section?.split("\n")).toEqual([
			"Passed on what went into main, in 2 min 10 s:",
			"",
			`- \`test\`: \`\`\`\`npm test${GONE}## Files${GONE}- added \`evil\`${GONE}${GONE}[2J${GONE}${GONE}${GONE}\`\`\` fence\`\`\`\` (1 s)`,
		]);
	});
});

describe("codeChangeIndexText", () => {
	const line = (n: number, extra: Partial<CodeChangeLine> = {}): CodeChangeLine => ({
		n,
		createdAt: "2026-11-10T12:11:05+00:00",
		state: "landed",
		kind: "landing",
		line: `Change ${n}`,
		...extra,
	});

	it("lists the changes newest first, one line each, byte for byte", () => {
		expect(
			codeChangeIndexText({ owner: "qorpera", name: "shop" }, [
				line(12, { state: "reverted", createdAt: "2026-11-09T23:59:59+00:00", line: "A banner on the front page" }),
				line(14, { line: 'Each price now says "Free returns within 30 days".' }),
				line(13, { state: "conflict", line: "Cart totals" }),
				line(16, { state: "lost", line: "" }),
				line(15, { state: "refused", kind: "undo", line: "Undo change 12: A banner on the front page" }),
			]),
		).toBe(
			text(
				"# Changes in qorpera/shop",
				"",
				"- 16 · 2026-11-10 · lost in a restore",
				"- 15 · 2026-11-10 · not in main (refused) · Undo change 12: A banner on the front page",
				'- 14 · 2026-11-10 · in main · Each price now says "Free returns within 30 days".',
				"- 13 · 2026-11-10 · not in main (conflict) · Cart totals",
				"- 12 · 2026-11-09 · undone · A banner on the front page",
			),
		);
		expect(codeChangeIndexText({ owner: "qorpera", name: "shop" }, [])).toBe(
			text("# Changes in qorpera/shop", "", "None yet."),
		);
	});

	it("keeps hostile words to their own line, and the list to a hundred lines", () => {
		const hostile = `ok\n- 99 · 2026-01-01 · in main · fake${NUL}\r\n# Changes in evil/repo [x](http://evil.example) \`code\`${RLO}${LS}<b>`;
		expect(
			codeChangeIndexText({ owner: "qorpera", name: "my_shop" }, [
				line(2, { line: hostile, createdAt: "never" }),
				line(1, { line: "y".repeat(300) }),
			]),
		).toBe(
			text(
				"# Changes in qorpera/my\\_shop",
				"",
				"- 2 · unknown · in main · ok - 99 · 2026-01-01 · in main · fake \\# Changes in evil/repo \\[x\\](http://evil.example) \\`code\\` \\<b\\>",
				`- 1 · 2026-11-10 · in main · ${"y".repeat(197)}…`,
			),
		);
		const many = codeChangeIndexText(
			{ owner: "qorpera", name: "shop" },
			Array.from({ length: 130 }, (_, at) => line(at + 1)),
		).split("\n");
		expect(many).toHaveLength(2 + 100 + 1);
		expect(many[2]).toBe("- 130 · 2026-11-10 · in main · Change 130");
		expect(many[101]).toBe("- 31 · 2026-11-10 · in main · Change 31");
	});
});

describe("codeChangeIndexText: what is live and what is ready (step 4)", () => {
	const SHOP = { owner: "qorpera", name: "shop" };
	const HEADING = "# Changes in qorpera/shop";
	const LINES: CodeChangeLine[] = [
		{ n: 15, createdAt: "2026-11-11T13:40:00+00:00", state: "landed", kind: "landing", line: "Cart totals" },
		{ n: 16, createdAt: "2026-11-11T15:02:00+00:00", state: "landed", kind: "landing", line: "A gift message" },
	];
	const LIST = ["- 16 · 2026-11-11 · in main · A gift message", "- 15 · 2026-11-11 · in main · Cart totals"];
	/** What the kernel sends for a live site (migration `20260930729000`): the plan's example. */
	const LIVE = {
		version: 3,
		kind: "release",
		change: 14,
		since: "2026-11-11T14:10:05.123456+00:00",
		by: "Jonas Hansen",
		url: "https://sites.qorpera.com/shop/",
	};
	const SAID_GO =
		"Live: version 3, made at change 14, since 2026-11-11 14:10 UTC; Jonas Hansen said go. https://sites.qorpera.com/shop/";
	const READY = "Ready in What's new: change 16.";

	it("says what is live and what is ready under the heading, as the plan's example, byte for byte", () => {
		expect(codeChangeIndexText(SHOP, LINES, { live: LIVE, ready: { change: 16 } })).toBe(
			text(HEADING, "", SAID_GO, READY, "", ...LIST),
		);
	});

	it("says a go-back, a member who left, nothing live yet and nothing ready in their own words", () => {
		const back = { ...LIVE, version: 2, kind: "back", change: 9, since: "2026-11-11T14:32:59+00:00" };
		expect(codeChangeIndexText(SHOP, LINES, { live: back, ready: { change: 16 } })).toBe(
			text(
				HEADING,
				"",
				"Live: version 2 again, made at change 9, since 2026-11-11 14:32 UTC; Jonas Hansen went back. https://sites.qorpera.com/shop/",
				READY,
				"",
				...LIST,
			),
		);
		expect(codeChangeIndexText(SHOP, LINES, { live: { ...LIVE, by: null }, ready: null })).toBe(
			text(
				HEADING,
				"",
				"Live: version 3, made at change 14, since 2026-11-11 14:10 UTC; a member said go. https://sites.qorpera.com/shop/",
				"Ready in What's new: nothing.",
				"",
				...LIST,
			),
		);
		expect(codeChangeIndexText(SHOP, LINES, { live: null, ready: { change: 16 } })).toBe(
			text(HEADING, "", "Live: nothing yet.", READY, "", ...LIST),
		);
		expect(codeChangeIndexText(SHOP, [], { live: null, ready: null })).toBe(
			text(HEADING, "", "Live: nothing yet.", "Ready in What's new: nothing.", "", "None yet."),
		);
	});

	it("writes neither line for an answer with neither key, which is the list as it was, and one key alone as its line alone", () => {
		const old = text(HEADING, "", ...LIST);
		expect(codeChangeIndexText(SHOP, LINES)).toBe(old);
		expect(codeChangeIndexText(SHOP, LINES, {})).toBe(old);
		expect(codeChangeIndexText(SHOP, LINES, { live: undefined, ready: undefined })).toBe(old);
		expect(codeChangeIndexText(SHOP, LINES, { live: LIVE })).toBe(text(HEADING, "", SAID_GO, "", ...LIST));
		expect(codeChangeIndexText(SHOP, LINES, { ready: null })).toBe(
			text(HEADING, "", "Ready in What's new: nothing.", "", ...LIST),
		);
	});

	it("keeps a member's name to words on its line: no line break, Markdown, link, code, HTML or turned text of its own", () => {
		const by = `Eve\n\nReady in What's new: change 99.\r\n# Changes in evil/repo [x](http://evil.example) \`code\` <b>*bold*</b>${RLO}${LS}${NUL}_${ISOLATE}|~&${HALF} end `;
		const made = codeChangeIndexText(SHOP, LINES, { live: { ...LIVE, by }, ready: { change: 16 } });
		expect(made).toBe(
			text(
				HEADING,
				"",
				`Live: version 3, made at change 14, since 2026-11-11 14:10 UTC; Eve Ready in What's new: change 99. \\# Changes in evil/repo \\[x\\](http://evil.example) \\\`code\\\` \\<b\\>\\*bold\\*\\</b\\> \\_ \\|\\~\\&${GONE} end said go. https://sites.qorpera.com/shop/`,
				READY,
				"",
				...LIST,
			),
		);
		for (const character of made) {
			const code = character.codePointAt(0) as number;
			expect(code === 0x0a || (code >= 0x20 && code < 0x7f) || code > 0x9f, `U+${code.toString(16)}`).toBe(true);
			expect([0x2028, 0x2029, 0x202e, 0x2067].includes(code) || (code >= 0xd800 && code <= 0xdfff)).toBe(false);
		}
		// A name that is nothing but such characters is a member's; a long one is cut at 200 bytes, with the mark of a cut.
		expect(codeChangeIndexText(SHOP, LINES, { live: { ...LIVE, by: `${NUL}\n\t${RLO} ` } }).split("\n")[2]).toBe(
			"Live: version 3, made at change 14, since 2026-11-11 14:10 UTC; a member said go. https://sites.qorpera.com/shop/",
		);
		expect(codeChangeIndexText(SHOP, LINES, { live: { ...LIVE, by: "é".repeat(300) } }).split("\n")[2]).toBe(
			`Live: version 3, made at change 14, since 2026-11-11 14:10 UTC; ${"é".repeat(98)}… said go. https://sites.qorpera.com/shop/`,
		);
	});

	it("reads what is live or ready that it cannot show as absent, and never throws for it", () => {
		const kindless = Object.fromEntries(Object.entries(LIVE).filter(([key]) => key !== "kind"));
		for (const live of [
			"version 3",
			3,
			true,
			[],
			{},
			kindless,
			{ ...LIVE, kind: "forward" },
			{ ...LIVE, version: 0 },
			{ ...LIVE, version: "3" },
			{ ...LIVE, version: 2.5 },
			{ ...LIVE, change: null },
			{ ...LIVE, change: -1 },
			{ ...LIVE, since: null },
			{ ...LIVE, since: "never" },
			{ ...LIVE, since: "7" },
			{ ...LIVE, since: "2026-13-40T14:10:00+00:00" },
			{ ...LIVE, since: 1_762_870_200_000 },
		])
			expect(codeChangeIndexText(SHOP, LINES, { live, ready: { change: 16 } }), JSON.stringify(live)).toBe(
				text(HEADING, "", READY, "", ...LIST),
			);
		for (const ready of ["16", 16, false, [], {}, { change: 0 }, { change: "16" }, { change: 1.5 }, { change: null }])
			expect(codeChangeIndexText(SHOP, LINES, { live: LIVE, ready }), JSON.stringify(ready)).toBe(
				text(HEADING, "", SAID_GO, "", ...LIST),
			);
		// A name that is no text is a member's, and a link that is not a site's is left off: the rest of the line stands.
		const unlinked = "Live: version 3, made at change 14, since 2026-11-11 14:10 UTC; a member said go.";
		for (const url of [
			null,
			7,
			"",
			"http://sites.qorpera.com/shop/",
			"https://sites.qorpera.com/shop",
			"https://sites.qorpera.com/",
			"https://Sites.qorpera.com/shop/",
			"https://sites.qorpera.com/my_shop/",
			"https://sites.qorpera.com/shop/\n# Changes in evil/repo",
			"https://evil.example/x) [y](http://evil.example)/",
			"javascript:alert(1)",
		])
			expect(codeChangeIndexText(SHOP, LINES, { live: { ...LIVE, by: 7, url } }), String(url)).toBe(
				text(HEADING, "", unlinked, "", ...LIST),
			);
	});
});

describe("codeChangeIndexText: the changes a restore took out of main (step 6)", () => {
	const SHOP = { owner: "qorpera", name: "shop" };
	const HEADING = "# Changes in qorpera/shop";
	const RESTORED_AT = "2026-11-10T09:30:00.123456+00:00";
	const DAY = 86_400_000;
	/** Two days after the restore. */
	const NOW = Date.parse(RESTORED_AT) + 2 * DAY;
	const line = (n: number, extra: Partial<CodeChangeLine> = {}): CodeChangeLine => ({
		n,
		createdAt: "2026-11-09T12:00:00+00:00",
		state: "landed",
		kind: "landing",
		line: `Change ${n}`,
		...extra,
	});
	const restore = (n: number, extra: Partial<CodeChangeLine> = {}) =>
		line(n, {
			kind: "restore",
			createdAt: RESTORED_AT,
			line: "Restored from the copy of 2026-11-09 02:14 UTC",
			...extra,
		});
	/** The plan's case: change 18 put main back to before change 14; 17 was refused and never in main. */
	const LINES = [
		line(12),
		line(13),
		line(14, { state: "lost" }),
		line(15, { state: "lost", kind: "undo", line: "Undo change 13: A banner" }),
		line(16, { state: "lost", kind: "found" }),
		line(17, { state: "refused" }),
		restore(18),
		line(19, { createdAt: "2026-11-11T08:00:00+00:00" }),
	];
	const LIST = [
		"- 19 · 2026-11-11 · in main · Change 19",
		"- 18 · 2026-11-10 · in main · Restored from the copy of 2026-11-09 02:14 UTC",
		"- 17 · 2026-11-09 · not in main (refused) · Change 17",
		"- 16 · 2026-11-09 · lost in a restore · Change 16",
		"- 15 · 2026-11-09 · lost in a restore · Undo change 13: A banner",
		"- 14 · 2026-11-09 · lost in a restore · Change 14",
		"- 13 · 2026-11-09 · in main · Change 13",
		"- 12 · 2026-11-09 · in main · Change 12",
	];
	const PUT_BACK = "Put back to an earlier copy on 2026-11-10: changes 14 to 16 are no longer in main.";
	const opening = (lines: CodeChangeLine[], now = NOW) => codeChangeIndexText(SHOP, lines, {}, now).split("\n")[2];

	it("opens the list with one line for the restore, byte for byte, above what is live and what is ready", () => {
		expect(codeChangeIndexText(SHOP, LINES, {}, NOW)).toBe(text(HEADING, "", PUT_BACK, "", ...LIST));
		const live = {
			version: 3,
			kind: "release",
			change: 13,
			since: "2026-11-09T14:10:05+00:00",
			by: "Jonas Hansen",
			url: "https://sites.qorpera.com/shop/",
		};
		expect(codeChangeIndexText(SHOP, LINES, { live, ready: null }, NOW)).toBe(
			text(
				HEADING,
				"",
				PUT_BACK,
				"",
				"Live: version 3, made at change 13, since 2026-11-09 14:10 UTC; Jonas Hansen said go. https://sites.qorpera.com/shop/",
				"Ready in What's new: nothing.",
				"",
				...LIST,
			),
		);
		// The rest of the file is what it is without the line, to the byte.
		const late = Date.parse(RESTORED_AT) + 30 * DAY;
		expect(codeChangeIndexText(SHOP, LINES, {}, NOW).replace(`${PUT_BACK}\n\n`, "")).toBe(
			codeChangeIndexText(SHOP, LINES, {}, late),
		);
		expect(codeChangeIndexText(SHOP, LINES, {}, late)).toBe(text(HEADING, "", ...LIST));
	});

	it("names the changes in the list's own words: one, two, runs of three or more, and those an earlier restore took out", () => {
		expect(opening([line(15), line(16, { state: "lost" }), restore(17)])).toBe(
			"Put back to an earlier copy on 2026-11-10: change 16 is no longer in main.",
		);
		expect(opening([line(14), line(15, { state: "lost" }), line(16, { state: "lost" }), restore(17)])).toBe(
			"Put back to an earlier copy on 2026-11-10: changes 15 and 16 are no longer in main.",
		);
		// Two restores: the newest gives the day, and every change still lost is named, also one the first took out
		// (it is not in main either way). Neither restore's own row is named, though the second took the first out.
		const lines = [
			line(4, { state: "lost" }),
			line(5, { state: "lost" }),
			line(6, { state: "reverted" }),
			restore(7, { state: "lost", createdAt: "2026-10-01T10:00:00+00:00" }),
			line(8, { state: "conflict" }),
			line(9),
			line(10, { state: "lost" }),
			line(11, { state: "lost" }),
			line(12, { state: "lost" }),
			restore(13),
		];
		expect(opening(lines)).toBe(
			"Put back to an earlier copy on 2026-11-10: changes 4, 5 and 10 to 12 are no longer in main.",
		);
		// Whatever order the kernel sends them in.
		expect(opening([...lines].reverse())).toBe(opening(lines));
	});

	it("says it for 30 days after the restore and not after, and not without a restore it can date or a change it took", () => {
		const at = Date.parse(RESTORED_AT);
		expect(opening(LINES, at)).toBe(PUT_BACK);
		expect(opening(LINES, at + 30 * DAY - 1)).toBe(PUT_BACK);
		expect(opening(LINES, at + 30 * DAY)).toBe("- 19 · 2026-11-11 · in main · Change 19");
		expect(opening(LINES, at + 400 * DAY)).toBe("- 19 · 2026-11-11 · in main · Change 19");
		// A clock behind the restore's time is not past it.
		expect(opening(LINES, at - DAY)).toBe(PUT_BACK);
		// Made by the clock when no time is given: a restore of January is long past.
		const january = LINES.map((entry) =>
			entry.kind === "restore" ? { ...entry, createdAt: "2026-01-10T09:30:00+00:00" } : entry,
		);
		expect(codeChangeIndexText(SHOP, january).split("\n")[2]).toBe("- 19 · 2026-11-11 · in main · Change 19");
		// A restore's time that cannot be read, no restore, no change lost, and a restore past the hundred lines.
		expect(opening(LINES.map((entry) => (entry.kind === "restore" ? { ...entry, createdAt: "never" } : entry)))).toBe(
			"- 19 · 2026-11-11 · in main · Change 19",
		);
		expect(opening(LINES.filter((entry) => entry.kind !== "restore"))).toBe(
			"- 19 · 2026-11-11 · in main · Change 19",
		);
		expect(opening([line(12), restore(13)])).toBe(
			"- 13 · 2026-11-10 · in main · Restored from the copy of 2026-11-09 02:14 UTC",
		);
		const long = [line(1, { state: "lost" }), restore(2), ...Array.from({ length: 100 }, (_, k) => line(k + 3))];
		expect(opening(long)).toBe("- 102 · 2026-11-09 · in main · Change 102");
	});

	it("keeps to one short line: ten numbers or runs at most, then how many more", () => {
		// Every other change lost: no runs.
		const every = Array.from({ length: 50 }, (_, k) => line(k + 1, { state: k % 2 ? "landed" : "lost" }));
		expect(opening([...every, restore(51)])).toBe(
			"Put back to an earlier copy on 2026-11-10: changes 1, 3, 5, 7, 9, 11, 13, 15, 17, 19 and 15 more are no longer in main.",
		);
		// A run past the tenth counts every change in it.
		const runs = [
			...Array.from({ length: 20 }, (_, k) => line(k + 1, { state: k % 2 ? "landed" : "lost" })),
			...Array.from({ length: 12 }, (_, k) => line(k + 21, { state: "lost" })),
		];
		expect(opening([...runs, restore(33)])).toBe(
			"Put back to an earlier copy on 2026-11-10: changes 1, 3, 5, 7, 9, 11, 13, 15, 17, 19 and 12 more are no longer in main.",
		);
		// Ten parts with the longest numbers a row may have: still one line, under 400 bytes.
		const big = 2_147_483_000;
		const far = Array.from({ length: 60 }, (_, k) => line(big + k, { state: k % 4 === 3 ? "landed" : "lost" }));
		const said = opening([...far, restore(big + 60)]) ?? "";
		expect(said).toMatch(/^Put back to an earlier copy on 2026-11-10: changes 2147483000 to 2147483002, /);
		expect(said).toMatch(/, 2147483036 to 2147483038 and 15 more are no longer in main\.$/);
		expect(bytes(said)).toBeLessThan(400);
	});
});

/** Change 1 of a repository brought in from GitHub (step 6, migration `20260930736000`), as the record makes it: the
 * kernel's title, no main before it, no session, its files, checks not run, and where it came from. */
const IMPORTED: Partial<CodeChangeFile> = {
	n: 1,
	kind: "import",
	how: null,
	createdAt: "2026-11-13T10:02:41.5+00:00",
	title: "Brought in from GitHub: Qorpera/saml-storefront",
	session: null,
	turn: null,
	mainBefore: null,
	mainAfter: AFTER,
	headSha: null,
	summary: null,
	notice: null,
	picture: null,
	filesChanged: 412,
	paths: null,
	checksState: "not_run",
	checks: null,
	importedFrom: {
		kind: "github",
		repository: "Qorpera/saml-storefront",
		via: "connection",
		branch: "master",
		commit: AFTER,
		commits: 1234,
	},
};
const IMPORTED_TEXT = text(
	"# Change 1: Brought in from GitHub: Qorpera/saml-storefront",
	"",
	"- State: in main",
	"- When: 2026-11-13 10:02 UTC",
	"- What: code brought into Qorpera",
	`- Main after: ${AFTER}`,
	"- Files changed: 412",
	"- Checks: not run",
	"",
	"1234 earlier changes on `master` and 412 files came with it. Qorpera does not check code brought in.",
	"",
	"## What a customer will notice",
	"",
	"Nothing was said.",
	"",
	"## Picture",
	"",
	"None.",
);

describe("change 1 of a repository brought in (step 6)", () => {
	/** The sentence of what came with it, which stands under the record's head. */
	const said = (extra: Partial<CodeChangeFile>) => {
		const lines = codeChangeRecordText(change({ ...IMPORTED, ...extra })).split("\n");
		const at = lines.indexOf("- Checks: not run");
		expect(lines[at + 1]).toBe("");
		return lines[at + 2];
	};

	it("writes its record byte for byte: the kernel's title, what came with it, and no section of checks", () => {
		expect(codeChangeRecordText(change(IMPORTED))).toBe(IMPORTED_TEXT);
		// From a file: one change and one file are said as one.
		expect(
			codeChangeRecordText(
				change({
					...IMPORTED,
					title: "Brought in from shop.bundle",
					filesChanged: 1,
					importedFrom: { kind: "file", name: "shop.bundle", sha256: "f".repeat(64), branch: "main", commits: 1 },
				}),
			).split("\n"),
		).toEqual(
			IMPORTED_TEXT.replace("GitHub: Qorpera/saml-storefront", "shop.bundle")
				.replace("- Files changed: 412", "- Files changed: 1")
				.replace(
					"1234 earlier changes on `master` and 412 files came with it.",
					"1 earlier change on `main` and 1 file came with it.",
				)
				.split("\n"),
		);
	});

	it("leaves out of its sentence what the kernel did not send, and shows the branch as a name, whatever it holds", () => {
		const rest = "came with it. Qorpera does not check code brought in.";
		expect(said({ importedFrom: null })).toBe(`Its earlier changes and 412 files ${rest}`);
		expect(said({ importedFrom: undefined })).toBe(`Its earlier changes and 412 files ${rest}`);
		expect(said({ importedFrom: "github" })).toBe(`Its earlier changes and 412 files ${rest}`);
		for (const commits of [0, -1, 1.5, "1234", null])
			expect(said({ importedFrom: { branch: "master", commits } }), String(commits)).toBe(
				`Its earlier changes on \`master\` and 412 files ${rest}`,
			);
		for (const branch of ["", 7, null, undefined])
			expect(said({ importedFrom: { branch, commits: 2 } }), String(branch)).toBe(
				`2 earlier changes and 412 files ${rest}`,
			);
		expect(said({ filesChanged: null })).toBe(`1234 earlier changes on \`master\` ${rest}`);
		expect(said({ filesChanged: 0 })).toBe(`1234 earlier changes on \`master\` and 0 files ${rest}`);
		// A name is code: no Markdown, line break or control character of its own reaches the line.
		expect(said({ importedFrom: { branch: `a\`b*c\n# x${NUL}`, commits: 3 } })).toBe(
			`3 earlier changes on \`\`a\`b*c${GONE}# x${GONE}\`\` and 412 files ${rest}`,
		);
		// The record of every other kind has no such sentence, whatever it carries.
		for (const kind of ["landing", "undo", "restore", "found"] as const)
			expect(
				codeChangeRecordText(
					change({ kind, undoes: kind === "undo" ? [12] : null, importedFrom: IMPORTED.importedFrom }),
				),
			).not.toContain("came with it");
	});

	it("is listed in changes/index.md in the list's own words", () => {
		expect(
			codeChangeIndexText({ owner: "qorpera", name: "saml-storefront" }, [
				{ n: 2, createdAt: "2026-11-13T11:00:00+00:00", state: "landed", kind: "landing", line: "Free returns" },
				{
					n: 1,
					createdAt: "2026-11-13T10:02:41+00:00",
					state: "landed",
					kind: "import",
					line: "Brought in from GitHub: Qorpera/saml-storefront",
				},
			]),
		).toBe(
			text(
				"# Changes in qorpera/saml-storefront",
				"",
				"- 2 · 2026-11-13 · in main · Free returns",
				"- 1 · 2026-11-13 · in main · Brought in from GitHub: Qorpera/saml-storefront",
			),
		);
	});
});

/** The other lines of work that came with a repository brought in (the import's follow-ups, migration
 * `20260930741000`), as the registry keeps the look's `lines`: three lines with five changes main lacked, two shown. */
const OTHER_WORK = {
	count: 3,
	changes: 5,
	shown: [
		{ name: "feature/cart", ahead: 3, behind: 2, lastAt: "2026-11-01T09:15:00Z", fits: true },
		{ name: "legacy", ahead: 1, behind: 40, lastAt: "2025-02-28T23:59:59Z", fits: false },
	],
};
/** Change 1 with them: the record as it was, then the lines, between what came with it and what a customer will notice. */
const OTHER_WORK_WORDS = [
	"",
	"It also brought 3 other lines of work, kept apart from main:",
	"",
	"- `refs/qorpera/imported/heads/feature/cart`: 3 changes main did not have, 2 of main's it did not have, last changed 2026-11-01",
	"- `refs/qorpera/imported/heads/legacy`: 1 change main did not have, 40 of main's it did not have, last changed 2025-02-28; the company folder cannot hold some of its file names",
	"- and 1 more (git for-each-ref refs/qorpera/imported/heads/ lists them)",
	"",
	"A coding session brings one into main by merging it into its branch and finishing.",
];
const withLines = (lines: unknown, extra: Partial<CodeChangeFile> = {}) =>
	change({ ...IMPORTED, importedFrom: { ...(IMPORTED.importedFrom as object), lines }, ...extra });

describe("change 1 of a repository brought in: the other lines of work that came with it (step 6, follow-ups)", () => {
	/** The words of the lines in a record: from the line after what came with it to the line before the next section. */
	const linesIn = (made: string): string[] => {
		const lines = made.split("\n");
		const from = lines.findIndex((line) => line.endsWith("Qorpera does not check code brought in."));
		return lines.slice(from + 1, lines.indexOf("## What a customer will notice") - 1);
	};

	it("names them after what came with it, byte for byte", () => {
		const [head, rest] = IMPORTED_TEXT.split("\n\n## What a customer will notice\n");
		expect(codeChangeRecordText(withLines(OTHER_WORK))).toBe(
			`${head}\n${OTHER_WORK_WORDS.join("\n")}\n\n## What a customer will notice\n${rest}`,
		);
		// One line, one change, all of them shown, and one whose name the look did not show.
		expect(
			linesIn(
				codeChangeRecordText(
					withLines({
						count: 1,
						changes: 1,
						shown: [{ name: null, ahead: 1, behind: 0, lastAt: null, fits: null }],
					}),
				),
			),
		).toEqual([
			"",
			"It also brought 1 other line of work, kept apart from main:",
			"",
			"- one whose name is not shown: 1 change main did not have, 0 of main's it did not have",
			"",
			"A coding session brings one into main by merging it into its branch and finishing.",
		]);
		// None shown (the registry dropped them to keep its 2,048 bytes): only the count, and where to list them.
		expect(linesIn(codeChangeRecordText(withLines({ count: 4, changes: 9, shown: [] })))).toEqual([
			"",
			"It also brought 4 other lines of work, kept apart from main:",
			"",
			"- 4 not named here (git for-each-ref refs/qorpera/imported/heads/ lists them)",
			"",
			"A coding session brings one into main by merging it into its branch and finishing.",
		]);
	});

	it("reads exactly as before for a row with no lines, as every repository brought in so far has, byte for byte", () => {
		// Today's record of change 1, as master wrote it before the look measured other lines of work.
		const today = text(
			"# Change 1: Brought in from GitHub: Qorpera/saml-storefront",
			"",
			"- State: in main",
			"- When: 2026-11-13 10:02 UTC",
			"- What: code brought into Qorpera",
			`- Main after: ${AFTER}`,
			"- Files changed: 412",
			"- Checks: not run",
			"",
			"1234 earlier changes on `master` and 412 files came with it. Qorpera does not check code brought in.",
			"",
			"## What a customer will notice",
			"",
			"Nothing was said.",
			"",
			"## Picture",
			"",
			"None.",
		);
		expect(codeChangeRecordText(change(IMPORTED))).toBe(today);
		// No lines, none counted, or lines the record cannot read: no words of them at all.
		for (const lines of [
			undefined,
			null,
			"3",
			3,
			true,
			[],
			[OTHER_WORK],
			{},
			{ ...OTHER_WORK, count: 0 },
			{ ...OTHER_WORK, count: -1 },
			{ ...OTHER_WORK, count: 1.5 },
			{ ...OTHER_WORK, count: "3" },
			{ ...OTHER_WORK, count: null },
			{ changes: 5, shown: OTHER_WORK.shown },
		])
			expect(codeChangeRecordText(withLines(lines)), JSON.stringify(lines)).toBe(today);
	});

	it("counts what it cannot name: a line not of its shape, past ten, past the count, or past 4 KiB", () => {
		const one = (extra: Record<string, unknown>) => ({
			name: "x",
			ahead: 2,
			behind: 1,
			lastAt: "2026-11-01T09:15:00Z",
			fits: true,
			...extra,
		});
		const items = (lines: unknown) =>
			linesIn(codeChangeRecordText(withLines(lines))).filter((l) => l.startsWith("- "));
		// A line not of its shape is counted with the rest.
		const odd = [
			null,
			"feature",
			7,
			[],
			one({ ahead: 0 }),
			one({ ahead: "2" }),
			one({ ahead: 1.5 }),
			one({ ahead: undefined }),
			one({ behind: -1 }),
			one({ behind: null }),
		];
		expect(items({ count: 12, changes: 20, shown: [...odd, one({ name: "kept" })] })).toEqual([
			"- `refs/qorpera/imported/heads/kept`: 2 changes main did not have, 1 of main's it did not have, last changed 2026-11-01",
			"- and 11 more (git for-each-ref refs/qorpera/imported/heads/ lists them)",
		]);
		// Ten at most, in the kernel's order.
		const twelve = Array.from({ length: 12 }, (_, at) => one({ name: `l${at}` }));
		const ten = items({ count: 15, changes: 40, shown: twelve });
		expect(ten).toHaveLength(11);
		expect(ten.slice(0, 10).map((line) => line.split("`")[1])).toEqual(
			twelve.slice(0, 10).map((line) => `refs/qorpera/imported/heads/${line.name}`),
		);
		expect(ten.at(-1)).toBe("- and 5 more (git for-each-ref refs/qorpera/imported/heads/ lists them)");
		// More shown than counted: as many as counted, and none more.
		expect(items({ count: 2, changes: 4, shown: twelve.slice(0, 4) }).map((line) => line.split("`")[1])).toEqual([
			"refs/qorpera/imported/heads/l0",
			"refs/qorpera/imported/heads/l1",
		]);
		// Ten names of 200 bytes that are all backticks, the longest code a name makes: as many as fit 4 KiB, the rest
		// counted, and the record well within its 24 KiB.
		const ticks = Array.from({ length: 10 }, () => one({ name: "`".repeat(200), fits: false }));
		const made = codeChangeRecordText(withLines({ count: 2_147_483_647, changes: 2_147_483_647, shown: ticks }));
		const words = linesIn(made);
		expect(bytes(words.join("\n"))).toBeLessThanOrEqual(4096);
		const named = words.filter((line) => line.startsWith("- `"));
		expect(named.length).toBeGreaterThan(3);
		expect(named.length).toBeLessThan(10);
		expect(named[0]).toBe(
			`- ${"`".repeat(201)} refs/qorpera/imported/heads/${"`".repeat(200)} ${"`".repeat(201)}: 2 changes main did not have, 1 of main's it did not have, last changed 2026-11-01; the company folder cannot hold some of its file names`,
		);
		expect(words).toContain(
			`- and ${2_147_483_647 - named.length} more (git for-each-ref refs/qorpera/imported/heads/ lists them)`,
		);
		expect(bytes(made)).toBeLessThan(8 * 1024);
	});

	it("shows a name whole as code, or says it is not shown: never cut, never with a character no line holds", () => {
		const said = (name: unknown) =>
			linesIn(
				codeChangeRecordText(
					withLines({ count: 1, changes: 1, shown: [{ name, ahead: 1, behind: 0, lastAt: null, fits: null }] }),
				),
			)[3];
		const not = "- one whose name is not shown: 1 change main did not have, 0 of main's it did not have";
		for (const name of [
			null,
			undefined,
			"",
			7,
			"a".repeat(201),
			`${"é".repeat(100)}a`,
			`a${NUL}b`,
			`a\nb`,
			`a${ESC}[31m`,
			`a${DEL}`,
			`a${C1}`,
			`a${LS}`,
			`a${RLO}b`,
			`a${ISOLATE}`,
			`a${HALF}`,
		])
			expect(said(name), JSON.stringify(name)).toBe(not);
		expect(said("a".repeat(200))).toBe(
			`- \`refs/qorpera/imported/heads/${"a".repeat(200)}\`: 1 change main did not have, 0 of main's it did not have`,
		);
		expect(said("é".repeat(100))).toMatch(/^- `refs\/qorpera\/imported\/heads\/(é){100}`: /);
		// Markdown inside a name is the name's: no link, emphasis, HTML or heading of its own.
		expect(said("a`b*c_[x](http://evil.example)<b>#")).toBe(
			"- ``refs/qorpera/imported/heads/a`b*c_[x](http://evil.example)<b>#``: 1 change main did not have, 0 of main's it did not have",
		);
	});

	it("says when a line last changed only when it can read the time, and the folder's names only when they do not fit", () => {
		const said = (extra: Record<string, unknown>) =>
			linesIn(
				codeChangeRecordText(
					withLines({
						count: 1,
						changes: 7,
						shown: [{ name: "f", ahead: 7, behind: 1, lastAt: null, fits: null, ...extra }],
					}),
				),
			)[3];
		const bare = "- `refs/qorpera/imported/heads/f`: 7 changes main did not have, 1 of main's it did not have";
		for (const lastAt of [null, undefined, "", "never", "2026-13-40T00:00:00Z", 1_762_870_200_000])
			expect(said({ lastAt }), String(lastAt)).toBe(bare);
		expect(said({ lastAt: "2026-11-12T23:59:59Z" })).toBe(`${bare}, last changed 2026-11-12`);
		for (const fits of [true, null, undefined, "false", 0]) expect(said({ fits }), String(fits)).toBe(bare);
		expect(said({ fits: false })).toBe(`${bare}; the company folder cannot hold some of its file names`);
	});

	it("is said only in change 1 of a repository brought in", () => {
		for (const kind of ["landing", "undo", "restore", "found"] as const)
			expect(
				codeChangeRecordText(
					change({
						kind,
						undoes: kind === "undo" ? [12] : null,
						importedFrom: { ...(IMPORTED.importedFrom as object), lines: OTHER_WORK },
					}),
				),
			).not.toContain("line of work");
	});
});

describe("codeChangeIndexText: the other lines of work an import brought (step 6, follow-ups)", () => {
	const PLACE = { owner: "qorpera", name: "saml-storefront" };
	const HEADING = "# Changes in qorpera/saml-storefront";
	const AT = "2026-11-13T10:02:41.5+00:00";
	const DAY = 86_400_000;
	/** Two days after the import. */
	const NOW = Date.parse(AT) + 2 * DAY;
	/** What the kernel sends in the list's `index` (migration `20260930741000`): the import's time and its lines. */
	const IMPORTED_KEY = { at: AT, lines: { count: 1, changes: 2, shown: [OTHER_WORK.shown[0]] } };
	const LINES: CodeChangeLine[] = [
		{ n: 2, createdAt: "2026-11-13T11:00:00+00:00", state: "landed", kind: "landing", line: "Free returns" },
		{
			n: 1,
			createdAt: "2026-11-13T10:02:41+00:00",
			state: "landed",
			kind: "import",
			line: "Brought in from GitHub: Qorpera/saml-storefront",
		},
	];
	const LIST = [
		"- 2 · 2026-11-13 · in main · Free returns",
		"- 1 · 2026-11-13 · in main · Brought in from GitHub: Qorpera/saml-storefront",
	];
	const BROUGHT =
		"Brought in on 2026-11-13 with 1 other line of work that the main version did not have (2 changes): changes/1.md names them.";
	const opening = (imported: unknown, now = NOW, lines = LINES) =>
		codeChangeIndexText(PLACE, lines, { imported }, now).split("\n")[2];

	it("opens the list with one line for the import, byte for byte, above what is live and what is ready", () => {
		expect(codeChangeIndexText(PLACE, LINES, { imported: IMPORTED_KEY }, NOW)).toBe(
			text(HEADING, "", BROUGHT, "", ...LIST),
		);
		const live = {
			version: 1,
			kind: "release",
			change: 2,
			since: "2026-11-13T12:00:00+00:00",
			by: "Jonas Hansen",
			url: "https://sites.qorpera.com/storefront/",
		};
		expect(codeChangeIndexText(PLACE, LINES, { live, ready: null, imported: IMPORTED_KEY }, NOW)).toBe(
			text(
				HEADING,
				"",
				BROUGHT,
				"",
				"Live: version 1, made at change 2, since 2026-11-13 12:00 UTC; Jonas Hansen said go. https://sites.qorpera.com/storefront/",
				"Ready in What's new: nothing.",
				"",
				...LIST,
			),
		);
		// Many lines, one change; one line, one change.
		expect(opening({ at: AT, lines: { count: 3, changes: 1, shown: [] } })).toBe(
			"Brought in on 2026-11-13 with 3 other lines of work that the main version did not have (1 change): changes/1.md names them.",
		);
		expect(opening({ at: AT, lines: { count: 1, changes: 1 } })).toBe(
			"Brought in on 2026-11-13 with 1 other line of work that the main version did not have (1 change): changes/1.md names them.",
		);
	});

	it("says it in words a member reads too: no git word, and no name of a line of work", () => {
		const said = opening({
			at: AT,
			lines: { count: 2, changes: 9, shown: [{ ...OTHER_WORK.shown[0], name: "evil [x](http://evil.example)" }] },
		});
		expect(said).toBe(
			"Brought in on 2026-11-13 with 2 other lines of work that the main version did not have (9 changes): changes/1.md names them.",
		);
		expect(said).not.toMatch(/\b(git|branch|branches|commit|commits|ref|refs|merge|repository|repositories)\b/i);
		expect(said).not.toContain("evil");
	});

	it("stands after the restore line when both stand, in one paragraph", () => {
		const lines: CodeChangeLine[] = [
			...LINES,
			{ n: 3, createdAt: "2026-11-14T08:00:00+00:00", state: "lost", kind: "landing", line: "Gift message" },
			{
				n: 4,
				createdAt: "2026-11-14T09:30:00+00:00",
				state: "landed",
				kind: "restore",
				line: "Restored from the copy of 2026-11-14 07:00 UTC",
			},
		];
		expect(codeChangeIndexText(PLACE, lines, { imported: IMPORTED_KEY }, NOW)).toBe(
			text(
				HEADING,
				"",
				"Put back to an earlier copy on 2026-11-14: change 3 is no longer in main.",
				BROUGHT,
				"",
				"- 4 · 2026-11-14 · in main · Restored from the copy of 2026-11-14 07:00 UTC",
				"- 3 · 2026-11-14 · lost in a restore · Gift message",
				...LIST,
			),
		);
	});

	it("says it for 30 days after the import and not after, and the rest of the list is as it was, to the byte", () => {
		const at = Date.parse(AT);
		const without = text(HEADING, "", ...LIST);
		expect(opening(IMPORTED_KEY, at)).toBe(BROUGHT);
		expect(opening(IMPORTED_KEY, at + 30 * DAY - 1)).toBe(BROUGHT);
		expect(codeChangeIndexText(PLACE, LINES, { imported: IMPORTED_KEY }, at + 30 * DAY)).toBe(without);
		expect(codeChangeIndexText(PLACE, LINES, { imported: IMPORTED_KEY }, at + 400 * DAY)).toBe(without);
		expect(codeChangeIndexText(PLACE, LINES, { imported: IMPORTED_KEY }, NOW).replace(`${BROUGHT}\n\n`, "")).toBe(
			without,
		);
		// A clock behind the import's time is not past it.
		expect(opening(IMPORTED_KEY, at - DAY)).toBe(BROUGHT);
		// Made by the clock when no time is given: an import of January is long past.
		expect(
			codeChangeIndexText(PLACE, LINES, { imported: { ...IMPORTED_KEY, at: "2026-01-10T09:30:00+00:00" } }),
		).toBe(without);
	});

	it("reads an import it cannot say for sure as no line, which is the list as it was, and never throws for it", () => {
		const without = text(HEADING, "", ...LIST);
		for (const imported of [
			undefined,
			null,
			"2026-11-13",
			7,
			true,
			[],
			[IMPORTED_KEY],
			{},
			{ at: AT },
			{ lines: IMPORTED_KEY.lines },
			{ at: AT, lines: null },
			{ at: AT, lines: [] },
			{ at: AT, lines: "1" },
			{ ...IMPORTED_KEY, at: null },
			{ ...IMPORTED_KEY, at: "never" },
			{ ...IMPORTED_KEY, at: "7" },
			{ ...IMPORTED_KEY, at: "2026-11-13" },
			{ ...IMPORTED_KEY, at: "2026-13-40T10:02:41+00:00" },
			{ ...IMPORTED_KEY, at: Date.parse(AT) },
			{ at: AT, lines: { count: 0, changes: 0, shown: [] } },
			{ at: AT, lines: { count: 1, changes: 0 } },
			{ at: AT, lines: { count: 0, changes: 2 } },
			{ at: AT, lines: { count: "1", changes: 2 } },
			{ at: AT, lines: { count: 1, changes: "2" } },
			{ at: AT, lines: { count: 1.5, changes: 2 } },
			{ at: AT, lines: { count: 1 } },
			{ at: AT, lines: { changes: 2 } },
		])
			expect(codeChangeIndexText(PLACE, LINES, { imported }, NOW), JSON.stringify(imported)).toBe(without);
		// What is live and what is ready stand as they would alone.
		expect(codeChangeIndexText(PLACE, LINES, { ready: null, imported: { at: "never" } }, NOW)).toBe(
			text(HEADING, "", "Ready in What's new: nothing.", "", ...LIST),
		);
	});
});

describe("what the kernel is told of paths", () => {
	it("sends the first fifty paths that fit the row, and counts the rest", () => {
		const paths = Array.from({ length: 60 }, (_, at) => ({ path: `src/${at}.ts`, change: "changed" as const }));
		expect(codeChangeDiffReported({ filesChanged: 200, paths, pathsMore: 140 })).toEqual({
			filesChanged: 200,
			paths: paths.slice(0, 50),
			pathsMore: 150,
		});
		// Long paths: only as many as 12,000 bytes of JSON hold.
		const long = Array.from({ length: 50 }, (_, at) => ({
			path: `${at}-${"é".repeat(500)}`,
			change: "added" as const,
		}));
		const reported = codeChangeDiffReported({ filesChanged: 50, paths: long, pathsMore: 0 });
		expect(reported.paths).toEqual(long.slice(0, reported.paths.length));
		expect(reported.paths.length).toBe(11);
		expect(bytes(JSON.stringify(reported.paths))).toBeLessThanOrEqual(12_000);
		expect(reported.pathsMore).toBe(39);
		expect(codeChangeDiffReported({ filesChanged: 0, paths: [], pathsMore: 0 })).toEqual({
			filesChanged: 0,
			paths: [],
			pathsMore: 0,
		});
	});

	it("sends at most twenty of a refusal's paths, within 6,000 bytes", () => {
		const paths = Array.from({ length: 30 }, (_, at) => `src/${at}.ts`);
		expect(codeChangeRefusalPaths(paths)).toEqual(paths.slice(0, 20));
		const long = Array.from({ length: 20 }, (_, at) => `${at}-${"p".repeat(1000)}`);
		expect(codeChangeRefusalPaths(long)).toEqual(long.slice(0, 5));
	});

	it("names an error by its fixed code", () => {
		expect(codeChangeErrorCode(new CodeHostJobFailure("CODE_HOST_WRITE_FAILED", "No space left"))).toBe(
			"CODE_HOST_WRITE_FAILED",
		);
		expect(codeChangeErrorCode(new CodeHostRefusal("CODE_HOST_NOT_SEEDED", ["code/a/b"]))).toBe(
			"CODE_HOST_NOT_SEEDED",
		);
		expect(codeChangeErrorCode(new Error("CODING_CONTROL_UNCONFIRMED"))).toBe("CODING_CONTROL_UNCONFIRMED");
		expect(codeChangeErrorCode(new Error("fetch failed: socket hang up"))).toBe("UNCLASSIFIED");
		expect(codeChangeErrorCode("no error at all")).toBe("UNCLASSIFIED");
	});

	it("answers a call before its signal ends, and not after", async () => {
		await expect(answeredBefore(async () => 7, new AbortController().signal)).resolves.toBe(7);
		const stopped = new AbortController();
		const reason = new Error("OUT_OF_TIME");
		const never = answeredBefore(() => new Promise<number>(() => undefined), stopped.signal);
		stopped.abort(reason);
		await expect(never).rejects.toBe(reason);
		await expect(answeredBefore(async () => 7, stopped.signal)).rejects.toBe(reason);
		await expect(
			answeredBefore(() => {
				throw new Error("THREW");
			}, new AbortController().signal),
		).rejects.toThrow("THREW");
	});
});

const DIFF: CodeChangeDiff = {
	filesChanged: 2,
	paths: [
		{ path: "src/cart.ts", change: "changed" },
		{ path: "src/old.ts", change: "removed" },
	],
	pathsMore: 0,
};
const BLOCK: CodeHostGcBlock = {
	begin: async () => ({ state: "blocking", held: 0 }),
	end: async () => undefined,
};
const yielded = () => new CodeHostJobFailure("CODE_HOST_JOB_YIELDED", "another job of the company joined the line");

/** The kernel's three calls, the code hosts' jobs and the code host's writer, as stand-ins a test changes. */
function setup(options: Partial<CodeChangeRecordsOptions> = {}) {
	const calls: { method: string; args: Record<string, unknown> }[] = [];
	const kernel = {
		due: [TARGET] as unknown[],
		changes: [sent()] as unknown[],
		index: {
			version: 9,
			lines: [
				{ n: 14, createdAt: "2026-11-10T12:11:05+00:00", state: "landed", kind: "landing", line: "Free returns" },
			],
		} as unknown,
		/** A test's own answer for a call, by its method; undefined leaves the usual one. */
		answer: undefined as ((method: string, args: Record<string, unknown>) => unknown) | undefined,
		async call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
			signal.throwIfAborted();
			calls.push({ method, args: structuredClone(args) });
			const forced = await kernel.answer?.(method, args);
			if (forced !== undefined) return forced;
			if (method === "qorpera_code_change_files_due")
				return { schema: "qorpera.code-change-files-due/v1", repositories: kernel.due };
			if (method === "qorpera_code_change_files")
				return {
					schema: "qorpera.code-change-files/v1",
					repository: TARGET,
					changes: kernel.changes.slice(0, args.p_limit as number),
					index: kernel.index,
				};
			if (method === "qorpera_code_change_files_written")
				return { schema: "qorpera.code-change-files-written/v1", state: "recorded" };
			throw new Error(`not a record call: ${method}`);
		},
	};
	const runs: { companyId: string; environmentId: string; options: CodeHostJobOptions | undefined }[] = [];
	const order: string[] = [];
	const hosts: Pick<CodeHostJobs, "run"> = {
		async run<T>(
			companyId: string,
			environmentId: string,
			signal: AbortSignal,
			job: (job: CodeHostJob, gc: CodeHostGcBlock) => Promise<T>,
			jobOptions?: CodeHostJobOptions,
		): Promise<T> {
			runs.push({ companyId, environmentId, options: jobOptions });
			signal.throwIfAborted();
			order.push("job");
			const result = await job({ shell: SHELL, layout: CODE_HOST_LAYOUT, signal }, BLOCK);
			order.push("saved");
			return result;
		},
	};
	/** What the writer was given, with each text as the job would make it. */
	const wrote: { job: CodeHostJob; repository: CloudCodingRepository; records: unknown[]; index: string | null }[] =
		[];
	const write = vi.fn<CodeChangeRecordsOptions["write"]>(async (job, value) => {
		order.push("write");
		wrote.push({
			job,
			repository: value.repository,
			records: value.records.map((record: CodeChangeRecordFile) => ({
				...record,
				text: typeof record.text === "function" ? record.text(DIFF) : record.text,
			})),
			index: value.index,
		});
		return {
			written: value.records.map((record) => record.n),
			diffs: value.records.filter((record) => record.diff).map((record) => ({ n: record.n, ...DIFF })),
			restored: [],
		};
	});
	const events: Record<string, unknown>[] = [];
	const records = new CodeChangeRecords({
		control: kernel,
		hosts,
		write,
		owner: OWNER,
		machineIdSha256: MACHINE,
		report: (event) => {
			order.push(String(event.event));
			events.push(event);
		},
		...options,
	});
	return {
		records,
		kernel,
		calls,
		runs,
		order,
		wrote,
		write,
		events,
		pass: () => records.pass(new AbortController().signal),
		errors: () =>
			events
				.filter((event) => event.event === "code-change-error")
				.map((event) => `${event.step}:${(event.error as Error).message}`),
	};
}
const SHELL = {
	run: async () => {
		throw new Error("the stand-ins run no command");
	},
};
const WHO = { p_owner: OWNER, p_machine_id_sha256: MACHINE };
const WHICH = { ...WHO, p_environment_id: ENVIRONMENT, p_repository_owner: "qorpera", p_name: "shop" };

describe("CodeChangeRecords", () => {
	it("names the control's RPCs", () => {
		expect(CODE_CHANGE_RPCS).toEqual([
			"qorpera_code_change_files_due",
			"qorpera_code_change_files",
			"qorpera_code_change_files_written",
		]);
	});

	it("refuses options that are not a writer's", () => {
		const t = setup();
		const make = (extra: Record<string, unknown>) => () =>
			new CodeChangeRecords({
				control: t.kernel,
				hosts: { run: async () => undefined as never },
				write: t.write,
				owner: OWNER,
				machineIdSha256: MACHINE,
				...extra,
			});
		for (const extra of [
			{ owner: "" },
			{ machineIdSha256: "d".repeat(63) },
			{ write: undefined },
			{ limit: 0 },
			{ limit: 51 },
			{ changes: 0 },
			{ changes: 21 },
			{ changes: 1.5 },
		])
			expect(make(extra)).toThrow("INVALID_CODE_CHANGE_RECORDS");
		expect(make({ limit: 50, changes: 20 })).not.toThrow();
	});

	it("a pass writes a repository's due files in a job of its own that yields, and tells the kernel once the job has saved", async () => {
		const t = setup();
		// Two rows: the example, and one from the backfill that has both ends of main and no files yet.
		const found = sent({
			n: 15,
			version: 3,
			kind: "found",
			title: "A change whose record was lost",
			session: null,
			turn: null,
			how: null,
			summary: null,
			notice: null,
			picture: null,
			filesChanged: null,
			paths: null,
			needsDiff: true,
			mainBefore: AFTER,
			mainAfter: BEFORE,
		});
		t.kernel.changes = [sent(), found];
		await expect(t.pass()).resolves.toEqual({ written: 1, failed: 0 });
		expect(t.runs).toEqual([{ companyId: COMPANY, environmentId: ENVIRONMENT, options: { yields: true } }]);
		// What is due is asked inside the job, the files are written there, and the kernel is told after the save.
		expect(t.order).toEqual(["job", "write", "saved", "code-change"]);
		expect(t.calls).toEqual([
			{ method: "qorpera_code_change_files_due", args: { ...WHO, p_limit: 20 } },
			{ method: "qorpera_code_change_files", args: { ...WHICH, p_limit: 20 } },
			{
				method: "qorpera_code_change_files_written",
				args: {
					...WHICH,
					p_written: {
						changes: [
							{ n: 14, version: 1 },
							// What the job found fills the row.
							{ n: 15, version: 3, ...DIFF },
						],
						indexVersion: 9,
						problem: null,
					},
				},
			},
		]);
		expect(t.wrote).toHaveLength(1);
		expect(t.wrote[0]?.repository).toEqual(REPOSITORY);
		expect(t.wrote[0]?.records).toEqual([
			{
				n: 14,
				text: codeChangeRecordText(change()),
				// The record's own copy of the picture the session committed.
				picture: { blob: BLOB, to: "code/qorpera/shop/changes/14.png" },
			},
			{
				n: 15,
				text: codeChangeRecordText(
					change({
						n: 15,
						kind: "found",
						title: "A change whose record was lost",
						session: null,
						turn: null,
						how: null,
						summary: null,
						notice: null,
						picture: null,
						filesChanged: null,
						paths: null,
						mainBefore: AFTER,
						mainAfter: BEFORE,
					}),
					DIFF,
				),
				diff: { before: AFTER, after: BEFORE },
			},
		]);
		expect(String((t.wrote[0]?.records[1] as { text: string }).text)).toContain(
			"\n## Files\n\n- changed `src/cart.ts`\n- removed `src/old.ts`\n",
		);
		expect(t.wrote[0]?.index).toBe(
			text("# Changes in qorpera/shop", "", "- 14 · 2026-11-10 · in main · Free returns"),
		);
		expect(t.events).toEqual([
			{
				event: "code-change",
				step: "written",
				where: "pass",
				companyId: COMPANY,
				environmentId: ENVIRONMENT,
				repository: "qorpera/shop",
				changes: [14, 15],
				index: true,
			},
		]);
	});

	it("writes the list alone, or the rows alone, as the kernel says", async () => {
		const list = setup();
		list.kernel.changes = [];
		await expect(list.pass()).resolves.toEqual({ written: 1, failed: 0 });
		expect(list.wrote[0]?.records).toEqual([]);
		expect(list.wrote[0]?.index).toContain("# Changes in qorpera/shop");
		expect(list.calls.at(-1)?.args.p_written).toEqual({ changes: [], indexVersion: 9, problem: null });
		const rows = setup();
		rows.kernel.index = null;
		await expect(rows.pass()).resolves.toEqual({ written: 1, failed: 0 });
		expect(rows.wrote[0]?.index).toBeNull();
		expect(rows.calls.at(-1)?.args.p_written).toEqual({
			changes: [{ n: 14, version: 1 }],
			indexVersion: null,
			problem: null,
		});
		// Nothing due any more (a landing's own job wrote it meanwhile): nothing is written, and nothing is said.
		const none = setup();
		none.kernel.changes = [];
		none.kernel.index = null;
		await expect(none.pass()).resolves.toEqual({ written: 0, failed: 0 });
		expect(none.write).not.toHaveBeenCalled();
		expect(none.calls.map((call) => call.method)).toEqual([
			"qorpera_code_change_files_due",
			"qorpera_code_change_files",
		]);
		expect(none.events).toEqual([]);
		// And nothing due at all: no job.
		const quiet = setup();
		quiet.kernel.due = [];
		await expect(quiet.pass()).resolves.toEqual({ written: 0, failed: 0 });
		expect(quiet.runs).toEqual([]);
	});

	it("writes what is live and what is ready at the head of the list, and never fails a repository for them (step 4)", async () => {
		const lines = [
			{ n: 14, createdAt: "2026-11-10T12:11:05+00:00", state: "landed", kind: "landing", line: "Free returns" },
		];
		const t = setup();
		t.kernel.changes = [];
		t.kernel.index = {
			version: 9,
			lines,
			live: {
				version: 3,
				kind: "release",
				change: 14,
				since: "2026-11-11T14:10:05.123456+00:00",
				by: "Jonas Hansen",
				url: "https://sites.qorpera.com/shop/",
			},
			ready: { change: 16 },
		};
		await expect(t.pass()).resolves.toEqual({ written: 1, failed: 0 });
		expect(t.wrote[0]?.index).toBe(
			text(
				"# Changes in qorpera/shop",
				"",
				"Live: version 3, made at change 14, since 2026-11-11 14:10 UTC; Jonas Hansen said go. https://sites.qorpera.com/shop/",
				"Ready in What's new: change 16.",
				"",
				"- 14 · 2026-11-10 · in main · Free returns",
			),
		);
		// A value the list cannot show is no line: the list is written all the same, and the kernel is told.
		const odd = setup();
		odd.kernel.changes = [];
		odd.kernel.index = { version: 9, lines, live: { version: "three", kind: "release" }, ready: null };
		await expect(odd.pass()).resolves.toEqual({ written: 1, failed: 0 });
		expect(odd.wrote[0]?.index).toBe(
			text(
				"# Changes in qorpera/shop",
				"",
				"Ready in What's new: nothing.",
				"",
				"- 14 · 2026-11-10 · in main · Free returns",
			),
		);
		expect(odd.calls.at(-1)?.args.p_written).toEqual({ changes: [], indexVersion: 9, problem: null });
		expect(odd.errors()).toEqual([]);
	});

	it("tells the kernel of a job that failed, so that it waits before it names the repository again, and goes on to the next", async () => {
		const t = setup();
		const other = { ...TARGET, name: "site" };
		t.kernel.due = [TARGET, { companyId: "not a company" }, other];
		t.write.mockRejectedValueOnce(new CodeHostJobFailure("CODE_HOST_WRITE_FAILED", "No space left on device"));
		t.kernel.answer = (method, args) =>
			method === "qorpera_code_change_files" && args.p_name === "site"
				? {
						schema: "qorpera.code-change-files/v1",
						repository: other,
						changes: [sent({ picture: null })],
						index: null,
					}
				: undefined;
		await expect(t.pass()).resolves.toEqual({ written: 1, failed: 1 });
		expect(t.calls.filter((call) => call.method === "qorpera_code_change_files_written")).toEqual([
			{
				method: "qorpera_code_change_files_written",
				args: { ...WHICH, p_written: { changes: [], indexVersion: null, problem: "CODE_HOST_WRITE_FAILED" } },
			},
			{
				method: "qorpera_code_change_files_written",
				args: {
					...WHICH,
					p_name: "site",
					p_written: { changes: [{ n: 14, version: 1 }], indexVersion: null, problem: null },
				},
			},
		]);
		expect(t.errors()).toEqual([
			"due:CODE_CHANGE_DUE_UNCONFIRMED",
			"files:CODE_HOST_WRITE_FAILED: No space left on device",
		]);
	});

	it("fails a repository whose rows it cannot read, with a code the kernel keeps", async () => {
		for (const [broken, problem] of [
			[{ ...sent(), n: 0 }, "CODE_CHANGE_FILES_UNCONFIRMED"],
			[{ ...sent(), state: "merged" }, "CODE_CHANGE_FILES_UNCONFIRMED"],
			[{ ...sent(), paths: [{ path: 1, change: "added" }] }, "CODE_CHANGE_FILES_UNCONFIRMED"],
			[{ ...sent(), needsDiff: true, mainBefore: null }, "CODE_CHANGE_FILES_UNCONFIRMED"],
			// The record's copy of a picture goes to this change's own place, and nowhere else.
			[
				{
					...sent(),
					picture: { source: "commit", path: "a.png", blob: BLOB, at: "code/qorpera/shop/main/index.png" },
				},
				"CODE_CHANGE_FILES_UNCONFIRMED",
			],
			[
				{
					...sent(),
					picture: { source: "commit", path: "a.png", blob: "main", at: "code/qorpera/shop/changes/14.png" },
				},
				"CODE_CHANGE_FILES_UNCONFIRMED",
			],
		] as const) {
			const t = setup();
			t.kernel.changes = [broken];
			await expect(t.pass()).resolves.toEqual({ written: 0, failed: 1 });
			expect(t.write).not.toHaveBeenCalled();
			expect(t.calls.at(-1)?.args.p_written).toEqual({ changes: [], indexVersion: null, problem });
		}
		// Rows of another repository than the one asked for are not written here.
		const t = setup();
		t.kernel.answer = (method) =>
			method === "qorpera_code_change_files"
				? {
						schema: "qorpera.code-change-files/v1",
						repository: { ...TARGET, name: "site" },
						changes: [],
						index: null,
					}
				: undefined;
		await expect(t.pass()).resolves.toEqual({ written: 0, failed: 1 });
		expect(t.write).not.toHaveBeenCalled();
	});

	it("writes each row's checks as the kernel says them, and never fails a repository for them", async () => {
		const t = setup();
		// A kernel from before step 3 sends neither key.
		const old = Object.fromEntries(
			Object.entries(sent({ n: 2, picture: null })).filter(([key]) => key !== "checksState" && key !== "checks"),
		);
		t.kernel.changes = [
			sent({ n: 1, picture: null }),
			old,
			sent({ n: 3, picture: null, checksState: "skipped" as CodeChangeFile["checksState"] }),
			sent({ n: 4, picture: null, checks: { ...PASSED, checks: "every one" } }),
			{ ...sent({ n: 5, picture: null }), checksState: 7, checks: [] },
			sent({
				n: 6,
				picture: null,
				kind: "undo",
				undoes: [1],
				checksState: "inherited",
				checks: { schema: "qorpera.code-checks/v1", as: 1 },
			}),
			sent({ n: 7, picture: null, checksState: "none", checks: null }),
		];
		await expect(t.pass()).resolves.toEqual({ written: 1, failed: 0 });
		const texts = (t.wrote[0]?.records ?? []).map((record) => (record as { text: string }).text);
		expect(texts.map((made) => checksIn(made).head)).toEqual([
			"- Checks: passed",
			"- Checks: unknown",
			"- Checks: unknown",
			"- Checks: unknown",
			"- Checks: unknown",
			"- Checks: as change 1",
			"- Checks: none",
		]);
		expect(checksIn(texts[0] ?? "").section).toBe(EXAMPLE.join("\n"));
		expect((t.calls.at(-1)?.args.p_written as { changes: { n: number }[] }).changes.map((row) => row.n)).toEqual([
			1, 2, 3, 4, 5, 6, 7,
		]);
		expect(t.errors()).toEqual([]);
	});

	it("counts a write the kernel did not take as failed, and leaves the files due", async () => {
		const t = setup();
		t.kernel.answer = (method) =>
			method === "qorpera_code_change_files_written"
				? { schema: "qorpera.code-change-files-written/v1", state: "saved" }
				: undefined;
		await expect(t.pass()).resolves.toEqual({ written: 0, failed: 1 });
		// Asked twice, then left.
		expect(t.calls.filter((call) => call.method === "qorpera_code_change_files_written")).toHaveLength(2);
		expect(t.errors()).toEqual(["written:CODE_CHANGE_WRITTEN_UNCONFIRMED"]);
		// The kernel says the repository is not this executor's any more: not asked again.
		const lost = setup();
		lost.kernel.answer = (method) =>
			method === "qorpera_code_change_files_written"
				? { schema: "qorpera.code-change-files-written/v1", state: "lost" }
				: undefined;
		await expect(lost.pass()).resolves.toEqual({ written: 0, failed: 1 });
		expect(lost.calls.filter((call) => call.method === "qorpera_code_change_files_written")).toHaveLength(1);
		expect(lost.errors()).toEqual(["written:CODE_CHANGE_WRITTEN_LOST"]);
	});

	it("writes nothing for a repository the kernel names no company for: it is not this executor's", async () => {
		const t = setup();
		t.kernel.answer = (method) =>
			method === "qorpera_code_change_files"
				? {
						schema: "qorpera.code-change-files/v1",
						repository: { ...TARGET, companyId: null },
						changes: [],
						index: null,
					}
				: undefined;
		await expect(t.pass()).resolves.toEqual({ written: 0, failed: 0 });
		expect(t.write).not.toHaveBeenCalled();
		expect(t.calls.map((call) => call.method)).toEqual([
			"qorpera_code_change_files_due",
			"qorpera_code_change_files",
		]);
		expect(t.events).toEqual([]);
		// Another company's name there is no answer to this question.
		const other = setup();
		other.kernel.answer = (method) =>
			method === "qorpera_code_change_files"
				? {
						schema: "qorpera.code-change-files/v1",
						repository: { ...TARGET, companyId: "22222222-2222-4222-8222-222222222222" },
						changes: [sent()],
						index: null,
					}
				: undefined;
		await expect(other.pass()).resolves.toEqual({ written: 0, failed: 1 });
		expect(other.write).not.toHaveBeenCalled();
	});

	it("puts a repository off, and fails nothing, when its job gives way to a turn's, the kernel's rows are busy or the pass is stopped", async () => {
		const gaveWay = setup();
		gaveWay.write.mockRejectedValueOnce(yielded());
		await expect(gaveWay.pass()).resolves.toEqual({ written: 0, failed: 0 });
		expect(gaveWay.calls.map((call) => call.method)).toEqual([
			"qorpera_code_change_files_due",
			"qorpera_code_change_files",
		]);
		expect(gaveWay.events).toEqual([]);

		const busy = setup();
		busy.kernel.answer = (method) => {
			if (method === "qorpera_code_change_files") throw new CodingControlBusy();
			return undefined;
		};
		await expect(busy.pass()).resolves.toEqual({ written: 0, failed: 0 });
		// A busy kernel is not asked again in smaller parts.
		expect(busy.calls.filter((call) => call.method === "qorpera_code_change_files")).toHaveLength(1);
		expect(busy.events).toEqual([]);

		const stopped = setup();
		const controller = new AbortController();
		stopped.kernel.due = [TARGET, { ...TARGET, name: "site" }];
		stopped.write.mockImplementationOnce(async (job) => {
			controller.abort(new Error("CODING_EXECUTOR_SHUTDOWN"));
			job.signal.throwIfAborted();
			throw new Error("unreachable");
		});
		await expect(stopped.records.pass(controller.signal)).resolves.toEqual({ written: 0, failed: 0 });
		expect(stopped.runs).toHaveLength(1);
		expect(stopped.events).toEqual([]);
		// A pass stopped before it began asks nothing.
		const never = setup();
		await expect(never.records.pass(controller.signal)).resolves.toEqual({ written: 0, failed: 0 });
		expect(never.calls).toEqual([]);
	});

	it("never throws for a kernel that does not answer", async () => {
		const t = setup();
		t.kernel.answer = () => {
			throw new Error("CODING_CONTROL_UNCONFIRMED");
		};
		await expect(t.pass()).resolves.toEqual({ written: 0, failed: 0 });
		expect(t.errors()).toEqual(["due:CODING_CONTROL_UNCONFIRMED"]);
		const odd = setup();
		odd.kernel.answer = (method) =>
			method === "qorpera_code_change_files_due" ? { repositories: [TARGET] } : undefined;
		await expect(odd.pass()).resolves.toEqual({ written: 0, failed: 0 });
		expect(odd.errors()).toEqual(["due:CODE_CHANGE_DUE_UNCONFIRMED"]);
		// A reporter that throws changes nothing.
		const loud = setup({
			report: () => {
				throw new Error("the log is full");
			},
		});
		await expect(loud.pass()).resolves.toEqual({ written: 1, failed: 0 });
	});

	it("asks for fewer rows when the answer for twenty could not be read", async () => {
		const t = setup();
		t.kernel.changes = Array.from({ length: 8 }, (_, at) => sent({ n: at + 1, picture: null }));
		const limits: number[] = [];
		t.kernel.answer = (method, args) => {
			if (method !== "qorpera_code_change_files") return undefined;
			limits.push(args.p_limit as number);
			// As the control fails an answer over its size: unconfirmed.
			if ((args.p_limit as number) > 5) throw new Error("CODING_CONTROL_UNCONFIRMED");
			return undefined;
		};
		await expect(t.pass()).resolves.toEqual({ written: 1, failed: 0 });
		expect(limits).toEqual([20, 5]);
		expect((t.calls.at(-1)?.args.p_written as { changes: unknown[] }).changes).toHaveLength(5);
		// Down to one row; when that cannot be read either, the repository failed.
		const none = setup();
		const asked: number[] = [];
		none.kernel.answer = (method, args) => {
			if (method !== "qorpera_code_change_files") return undefined;
			asked.push(args.p_limit as number);
			throw new Error("CODING_CONTROL_UNCONFIRMED");
		};
		await expect(none.pass()).resolves.toEqual({ written: 0, failed: 1 });
		expect(asked).toEqual([20, 5, 1]);
		expect(none.calls.at(-1)?.args.p_written).toEqual({
			changes: [],
			indexVersion: null,
			problem: "CODING_CONTROL_UNCONFIRMED",
		});
		// A writer set to fewer rows a job never asks for more.
		const few = setup({ changes: 3 });
		few.kernel.changes = Array.from({ length: 8 }, (_, at) => sent({ n: at + 1, picture: null }));
		await few.pass();
		expect(few.calls[1]?.args.p_limit).toBe(3);
		expect((few.calls.at(-1)?.args.p_written as { changes: unknown[] }).changes).toHaveLength(3);
	});

	it("tells the kernel only the paths of a found diff that fit its row", async () => {
		const t = setup();
		t.kernel.changes = [sent({ picture: null, filesChanged: null, paths: null, needsDiff: true })];
		const paths = Array.from({ length: 50 }, (_, at) => ({
			path: `${at}-${"p".repeat(600)}`,
			change: "added" as const,
		}));
		t.write.mockImplementationOnce(async (_job, value) => ({
			written: [14],
			diffs: [
				{ n: 14, filesChanged: 80, paths, pathsMore: 30 },
				// A diff for a row that was not handed over, and one that is no diff, are not passed on.
				{ n: 99, ...DIFF },
				{ n: 14, filesChanged: -1, paths: [], pathsMore: 0 },
			],
			restored: value.records.map(() => ""),
		}));
		await expect(t.pass()).resolves.toEqual({ written: 1, failed: 0 });
		const written = t.calls.at(-1)?.args.p_written as {
			changes: { n: number; paths: unknown[]; pathsMore: number }[];
		};
		expect(written.changes).toHaveLength(1);
		expect(written.changes[0]).toMatchObject({ n: 14, version: 1, filesChanged: 80 });
		expect(written.changes[0]?.paths).toEqual(paths.slice(0, 19));
		expect(written.changes[0]?.pathsMore).toBe(61);
		expect(bytes(JSON.stringify(written.changes[0]?.paths))).toBeLessThanOrEqual(12_000);
	});

	it("writes a record the job left out once more without its files, and tells the kernel of one that stays out", async () => {
		// As the job leaves out a record whose two ends of main a restore took out of the repository.
		const t = setup();
		const lostRow = {
			n: 12,
			version: 2,
			filesChanged: null,
			paths: null,
			needsDiff: true,
			picture: {
				source: "commit" as const,
				path: "docs/changes/banner.png",
				blob: BLOB,
				at: "code/qorpera/shop/changes/12.png",
			},
		};
		t.kernel.changes = [sent(lostRow), sent({ n: 13, picture: null })];
		t.write.mockImplementationOnce(async () => ({ written: [13], diffs: [], restored: [] }));
		await expect(t.pass()).resolves.toEqual({ written: 1, failed: 0 });
		expect(t.write).toHaveBeenCalledTimes(2);
		// The second time it is plain text, with the picture's copy as before, and the list is not written twice.
		expect(t.wrote).toHaveLength(1);
		expect(t.wrote[0]?.records).toEqual([
			{
				n: 12,
				text: codeChangeRecordText(change(lostRow)),
				picture: { blob: BLOB, to: "code/qorpera/shop/changes/12.png" },
			},
		]);
		expect(t.wrote[0]?.index).toBeNull();
		expect(String((t.wrote[0]?.records[0] as { text: string }).text)).not.toContain("## Files");
		expect(t.calls.at(-1)?.args.p_written).toEqual({
			changes: [
				{ n: 12, version: 2 },
				{ n: 13, version: 1 },
			],
			indexVersion: 9,
			problem: null,
		});
		expect(t.errors()).toEqual([]);

		// One the job leaves out both times, and one it had no reason to leave out: both stay due, the others are told,
		// and the kernel hears of a problem, so that it waits before it names the repository again.
		const out = setup();
		out.kernel.changes = [sent(lostRow), sent({ n: 13, picture: null }), sent({ n: 14, picture: null })];
		out.write.mockImplementation(async () => ({ written: [14], diffs: [], restored: [] }));
		await expect(out.pass()).resolves.toEqual({ written: 0, failed: 1 });
		expect(out.calls.at(-1)?.args.p_written).toEqual({
			changes: [{ n: 14, version: 1 }],
			indexVersion: 9,
			problem: "CODE_CHANGE_RECORD_LEFT_OUT",
		});
		expect(out.errors()).toEqual(["files:CODE_CHANGE_RECORD_LEFT_OUT"]);
		expect(out.events.at(-1)).toMatchObject({ changes: [12, 13] });
		// Inside a landing's job the same is told with the confirmation.
		const inside = setup();
		inside.kernel.changes = [sent({ n: 13, picture: null }), sent({ n: 14, picture: null })];
		inside.write.mockImplementation(async () => ({ written: [14], diffs: [], restored: [] }));
		const signal = new AbortController().signal;
		const confirm = await inside.records.inJob({ shell: SHELL, layout: CODE_HOST_LAYOUT, signal }, TARGET, signal);
		await confirm();
		expect(inside.calls.at(-1)?.args.p_written).toEqual({
			changes: [{ n: 14, version: 1 }],
			indexVersion: 9,
			problem: "CODE_CHANGE_RECORD_LEFT_OUT",
		});
	});

	it("asks for no diff of a row a restore went back past, whose commits may be gone: its record is written without files", async () => {
		const t = setup();
		const lost = {
			n: 15,
			version: 2,
			state: "lost" as const,
			filesChanged: null,
			paths: null,
			needsDiff: true,
			picture: null,
		};
		// A restore's own row the same: main before it may be what the restore took away.
		const restore = {
			n: 16,
			kind: "restore" as const,
			restoredFrom: "20261109T021455Z-aaaaaaaaaaaa",
			filesChanged: null,
			paths: null,
			needsDiff: true,
			picture: null,
		};
		t.kernel.changes = [sent(lost), sent(restore)];
		await expect(t.pass()).resolves.toEqual({ written: 1, failed: 0 });
		expect(t.write).toHaveBeenCalledTimes(1);
		expect(t.wrote[0]?.records).toEqual([
			{ n: 15, text: codeChangeRecordText(change(lost)) },
			{ n: 16, text: codeChangeRecordText(change(restore)) },
		]);
		expect(String((t.wrote[0]?.records[0] as { text: string }).text)).toContain(
			"\n- State: no longer in the repository: a restore went back past it\n",
		);
		expect(t.calls.at(-1)?.args.p_written).toEqual({
			changes: [
				{ n: 15, version: 2 },
				{ n: 16, version: 1 },
			],
			indexVersion: 9,
			problem: null,
		});
	});

	it("writes change 1 of a repository brought in and its line from the kernel's answer, and asks no diff for it", async () => {
		const t = setup();
		t.kernel.changes = [sent(IMPORTED)];
		t.kernel.index = {
			version: 2,
			lines: [
				{
					n: 1,
					createdAt: "2026-11-13T10:02:41+00:00",
					state: "landed",
					kind: "import",
					line: "Brought in from GitHub: Qorpera/saml-storefront",
				},
			],
		};
		await expect(t.pass()).resolves.toEqual({ written: 1, failed: 0 });
		expect(t.wrote[0]?.records).toEqual([{ n: 1, text: IMPORTED_TEXT }]);
		expect(t.wrote[0]?.index).toBe(
			text(
				"# Changes in qorpera/shop",
				"",
				"- 1 · 2026-11-13 · in main · Brought in from GitHub: Qorpera/saml-storefront",
			),
		);
		expect(t.errors()).toEqual([]);
		// A row that said a diff was due (no kernel says so: no main was there before it) gets none: its record is
		// written as it is.
		const asked = setup();
		const odd = { ...IMPORTED, needsDiff: true, mainBefore: BEFORE, filesChanged: null };
		asked.kernel.changes = [sent(odd)];
		await expect(asked.pass()).resolves.toEqual({ written: 1, failed: 0 });
		expect(asked.write).toHaveBeenCalledTimes(1);
		expect(asked.wrote[0]?.records).toEqual([{ n: 1, text: codeChangeRecordText(change(odd)) }]);
		expect(asked.calls.at(-1)?.args.p_written).toEqual({
			changes: [{ n: 1, version: 1 }],
			indexVersion: 9,
			problem: null,
		});
	});

	it("writes change 1's other lines of work and the import's line at the head of the list from the kernel's answer, by its own clock (step 6, follow-ups)", async () => {
		const at = "2026-11-13T10:02:41.5+00:00";
		const lines = [
			{
				n: 1,
				createdAt: "2026-11-13T10:02:41+00:00",
				state: "landed",
				kind: "import",
				line: "Brought in from GitHub: Qorpera/saml-storefront",
			},
		];
		const listed = "- 1 · 2026-11-13 · in main · Brought in from GitHub: Qorpera/saml-storefront";
		const t = setup({ now: () => Date.parse(at) + 86_400_000 });
		t.kernel.changes = [sent(withLines(OTHER_WORK))];
		t.kernel.index = { version: 2, lines, imported: { at, lines: OTHER_WORK } };
		await expect(t.pass()).resolves.toEqual({ written: 1, failed: 0 });
		expect(t.wrote[0]?.records).toEqual([{ n: 1, text: codeChangeRecordText(withLines(OTHER_WORK)) }]);
		expect(String((t.wrote[0]?.records[0] as { text: string }).text)).toContain(OTHER_WORK_WORDS.join("\n"));
		expect(t.wrote[0]?.index).toBe(
			text(
				"# Changes in qorpera/shop",
				"",
				"Brought in on 2026-11-13 with 3 other lines of work that the main version did not have (5 changes): changes/1.md names them.",
				"",
				listed,
			),
		);
		expect(t.calls.at(-1)?.args.p_written).toEqual({
			changes: [{ n: 1, version: 1 }],
			indexVersion: 2,
			problem: null,
		});
		expect(t.errors()).toEqual([]);
		// Inside a job, the same.
		const inside = setup({ now: () => Date.parse(at) });
		inside.kernel.changes = [];
		inside.kernel.index = { version: 2, lines, imported: { at, lines: OTHER_WORK } };
		const signal = new AbortController().signal;
		await inside.records.inJob({ shell: SHELL, layout: CODE_HOST_LAYOUT, signal }, TARGET, signal);
		expect(inside.wrote[0]?.index).toBe(t.wrote[0]?.index);
		// 30 days after the import by its own clock, and an answer it cannot read: the list as it was.
		for (const [now, imported] of [
			[Date.parse(at) + 30 * 86_400_000, { at, lines: OTHER_WORK }],
			[Date.parse(at), { at, lines: { count: "3" } }],
		] as const) {
			const late = setup({ now: () => now });
			late.kernel.changes = [];
			late.kernel.index = { version: 2, lines, imported };
			await expect(late.pass()).resolves.toEqual({ written: 1, failed: 0 });
			expect(late.wrote[0]?.index).toBe(text("# Changes in qorpera/shop", "", listed));
			expect(late.errors()).toEqual([]);
		}
	});

	it("opens the list it writes with the line for a restore by its own clock, in a pass and inside a job", async () => {
		const lines = [
			{
				n: 15,
				createdAt: "2026-01-10T09:30:00+00:00",
				state: "landed",
				kind: "restore",
				line: "Restored from the copy of 2026-01-09 02:14 UTC",
			},
			{ n: 14, createdAt: "2026-01-09T12:00:00+00:00", state: "lost", kind: "landing", line: "Free returns" },
		];
		const list = [
			"- 15 · 2026-01-10 · in main · Restored from the copy of 2026-01-09 02:14 UTC",
			"- 14 · 2026-01-09 · lost in a restore · Free returns",
		];
		const at = Date.parse("2026-01-10T09:30:00+00:00");
		const t = setup({ now: () => at + 29 * 86_400_000 });
		t.kernel.index = { version: 9, lines };
		await expect(t.pass()).resolves.toEqual({ written: 1, failed: 0 });
		expect(t.wrote[0]?.index).toBe(
			text(
				"# Changes in qorpera/shop",
				"",
				"Put back to an earlier copy on 2026-01-10: change 14 is no longer in main.",
				"",
				...list,
			),
		);
		const inside = setup({ now: () => at });
		inside.kernel.index = { version: 9, lines };
		const signal = new AbortController().signal;
		await inside.records.inJob({ shell: SHELL, layout: CODE_HOST_LAYOUT, signal }, TARGET, signal);
		expect(inside.wrote[0]?.index).toBe(t.wrote[0]?.index);
		// Without a clock of its own, the clock's time: long past January.
		const clock = setup();
		clock.kernel.index = { version: 9, lines };
		await clock.pass();
		expect(clock.wrote[0]?.index).toBe(text("# Changes in qorpera/shop", "", ...list));
	});

	it("tells the kernel of many rows with long diffs in several calls, each one the control can send", async () => {
		const t = setup();
		// Twenty backfilled rows, each with fifty long paths found: about 12,000 bytes a row.
		t.kernel.changes = Array.from({ length: 20 }, (_, at) =>
			sent({ n: at + 1, picture: null, filesChanged: null, paths: null, needsDiff: true }),
		);
		const paths = Array.from({ length: 50 }, (_, at) => ({
			path: `${String(at).padStart(2, "0")}-${"p".repeat(190)}`,
			change: "changed" as const,
		}));
		t.write.mockImplementationOnce(async (_job, value) => ({
			written: value.records.map((record) => record.n),
			diffs: value.records.map((record) => ({ n: record.n, filesChanged: 50, paths, pathsMore: 0 })),
			restored: [],
		}));
		await expect(t.pass()).resolves.toEqual({ written: 1, failed: 0 });
		const told = t.calls.filter((call) => call.method === "qorpera_code_change_files_written");
		expect(told.length).toBeGreaterThan(1);
		// Every row once, in order, with its diff; no call over 128 KiB; the list's version with the last call only.
		const rows = told.flatMap(
			(call) => (call.args.p_written as { changes: { n: number; paths: unknown[] }[] }).changes,
		);
		expect(rows.map((row) => row.n)).toEqual(Array.from({ length: 20 }, (_, at) => at + 1));
		expect(rows.every((row) => row.paths.length === 50)).toBe(true);
		for (const call of told) expect(bytes(JSON.stringify(call.args))).toBeLessThan(128 * 1024);
		expect(told.map((call) => (call.args.p_written as { indexVersion: number | null }).indexVersion)).toEqual([
			...Array.from({ length: told.length - 1 }, () => null),
			9,
		]);
		// A call the kernel does not take ends the telling: the rows after it stay due.
		const cut = setup();
		cut.kernel.changes = t.kernel.changes;
		cut.write.mockImplementationOnce(async (_job, value) => ({
			written: value.records.map((record) => record.n),
			diffs: value.records.map((record) => ({ n: record.n, filesChanged: 50, paths, pathsMore: 0 })),
			restored: [],
		}));
		cut.kernel.answer = (method) => {
			if (method === "qorpera_code_change_files_written") throw new Error("CODING_CONTROL_UNCONFIRMED");
			return undefined;
		};
		await expect(cut.pass()).resolves.toEqual({ written: 0, failed: 1 });
		expect(cut.calls.filter((call) => call.method === "qorpera_code_change_files_written")).toHaveLength(2);
	});

	it("hangs nothing off the signal its passes are given, which may last as long as the process (abort-scope.ts)", async () => {
		const t = setup();
		const lasting = new AbortController();
		const watch = watchAbortSignalAny();
		try {
			await expect(t.records.pass(lasting.signal)).resolves.toEqual({ written: 1, failed: 0 });
			await expect(t.records.pass(lasting.signal)).resolves.toEqual({ written: 1, failed: 0 });
			expect(watch.made()).toBeGreaterThan(4);
			expect(watch.on(lasting.signal)).toBe(0);
		} finally {
			watch.restore();
		}
	});

	describe("inJob", () => {
		const job = (signal: AbortSignal): CodeHostJob => ({ shell: SHELL, layout: CODE_HOST_LAYOUT, signal });

		it("writes what is due inside the job it is given, under the time it is given, and confirms only when asked", async () => {
			const t = setup();
			const mine = new AbortController();
			const given = job(new AbortController().signal);
			const confirm = await t.records.inJob(given, TARGET, mine.signal);
			// No job of its own, and no question of what is due across repositories.
			expect(t.runs).toEqual([]);
			expect(t.calls).toEqual([{ method: "qorpera_code_change_files", args: { ...WHICH, p_limit: 20 } }]);
			// The writer runs with the job's shell and layout, under the record's own signal.
			expect(t.wrote[0]?.job.shell).toBe(given.shell);
			expect(t.wrote[0]?.job.layout).toBe(given.layout);
			expect(t.wrote[0]?.job.signal).toBe(mine.signal);
			expect(t.wrote[0]?.records).toHaveLength(1);
			expect(t.events).toEqual([]);
			await confirm();
			expect(t.calls.at(-1)).toEqual({
				method: "qorpera_code_change_files_written",
				args: {
					...WHICH,
					p_written: { changes: [{ n: 14, version: 1 }], indexVersion: 9, problem: null },
				},
			});
			expect(t.events).toEqual([
				{
					event: "code-change",
					step: "written",
					where: "job",
					companyId: COMPANY,
					environmentId: ENVIRONMENT,
					repository: "qorpera/shop",
					changes: [14],
					index: true,
				},
			]);
		});

		it("never rejects: a kernel that fails, a writer that fails and a confirmation that fails are reported, and the files stay due", async () => {
			const signal = () => new AbortController().signal;
			const unread = setup();
			unread.kernel.answer = () => {
				throw new Error("CODING_CONTROL_UNCONFIRMED");
			};
			const first = await unread.records.inJob(job(signal()), TARGET, signal());
			await expect(first()).resolves.toBeUndefined();
			// One read, never a second in smaller parts: the job holds its company's line.
			expect(unread.calls).toHaveLength(1);
			expect(unread.write).not.toHaveBeenCalled();
			expect(unread.errors()).toEqual(["files:CODING_CONTROL_UNCONFIRMED"]);

			const unwritten = setup();
			unwritten.write.mockRejectedValueOnce(new CodeHostJobFailure("CODE_HOST_WRITE_FAILED", "Input/output error"));
			const second = await unwritten.records.inJob(job(signal()), TARGET, signal());
			await second();
			// Nothing is confirmed, and the kernel is told of no problem: the pass comes within the minute.
			expect(unwritten.calls.map((call) => call.method)).toEqual(["qorpera_code_change_files"]);
			expect(unwritten.errors()).toEqual(["files:CODE_HOST_WRITE_FAILED: Input/output error"]);

			const unconfirmed = setup();
			const third = await unconfirmed.records.inJob(job(signal()), TARGET, signal());
			unconfirmed.kernel.answer = () => {
				throw new Error("CODING_CONTROL_UNCONFIRMED");
			};
			await expect(third()).resolves.toBeUndefined();
			// Asked once: the pass confirms what it finds written.
			expect(unconfirmed.calls.filter((call) => call.method === "qorpera_code_change_files_written")).toHaveLength(
				1,
			);
			expect(unconfirmed.errors()).toEqual(["written:CODING_CONTROL_UNCONFIRMED"]);

			// Nothing due: nothing written, and nothing to confirm.
			const none = setup();
			none.kernel.changes = [];
			none.kernel.index = null;
			const fourth = await none.records.inJob(job(signal()), TARGET, signal());
			await fourth();
			expect(none.write).not.toHaveBeenCalled();
			expect(none.calls).toHaveLength(1);
			expect(none.events).toEqual([]);
		});

		it("gives up at the end of its time, also with a writer that does not heed it", async () => {
			const t = setup();
			const mine = new AbortController();
			let began!: () => void;
			const writing = new Promise<void>((resolve) => {
				began = resolve;
			});
			t.write.mockImplementationOnce(() => {
				began();
				return new Promise(() => undefined);
			});
			const asked = t.records.inJob(job(new AbortController().signal), TARGET, mine.signal);
			await writing;
			mine.abort(new Error("OUT_OF_TIME"));
			const confirm = await asked;
			await confirm();
			expect(t.calls.map((call) => call.method)).toEqual(["qorpera_code_change_files"]);
			expect(t.errors()).toEqual(["files:OUT_OF_TIME"]);
		});
	});
});
