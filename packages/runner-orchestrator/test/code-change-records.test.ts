import type { CloudCodingRepository } from "@qorpera/contracts";
import { describe, expect, it, vi } from "vitest";
import {
	answeredBefore,
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
				"",
				"## What a customer will notice",
				"",
				'> Each price now says "Free returns within 30 days".',
				"",
				"## Picture",
				"",
				"`code/qorpera/shop/changes/14.png`",
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
				"",
				"## What a customer will notice",
				"",
				"Nothing was said.",
				"",
				"## Picture",
				"",
				"None.",
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
		expect(worst.endsWith("\n## Files\n\n- 9050 not named here\n")).toBe(true);
		expect(worst).toContain("\n## Why it did not go in\n\n- 20 not named here\n");
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
