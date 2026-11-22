import { type CloudCodingRepository, isUuid, parseCloudCodingRepository } from "@qorpera/contracts";
import { withAbortScope } from "./abort-scope.ts";
import {
	CODE_CHANGE_ARCHIVE_COMPLETE_LINE,
	type CodeChangeArchiveFile,
	type CodeChangeDiff,
	type CodeChangePath,
	type CodeChangeRecordFile,
	type CodeHostJob,
	CodeHostJobFailure,
	CodeHostRefusal,
	codeAreaPath,
	listCodeChangeArchives,
	writeCodeChangeRecords,
} from "./code-host-jobs.ts";
import type { CodeHostJobs } from "./code-host-views.ts";
import { codeSiteNameValid } from "./code-site.ts";
import { CodingControlBusy } from "./coding-executor.ts";

/** The change record's files (own code storage, step 2b): the coding executor's side. The kernel keeps a numbered row
 * for every movement of a repository's main, and for every landing that was refused (`qorpera_code_changes`, migration
 * `20260930720000`). Each row has a file, `code/<owner>/<name>/changes/<n>.md`, and the newest hundred are listed in
 * `changes/index.md`, under two lines that say which version of the repository's site is live and which change is ready
 * in What's new (step 4), and while sites have hosts of their own a third, which change's site is being prepared for it
 * (step 5), for 30 days after a restore under one that names the changes it took out of main (step 6),
 * and for 30 days after an import that brought other lines of work under one that counts them. The kernel says which
 * are due and what they hold; this renders them; a code host job writes them:
 *
 *   in the landing's or the undo's own job   `inJob`: what is due is written before the job saves, so the files are
 *                                            there when the agent is woken; `confirm` once the job has saved
 *   otherwise, every minute                  `pass`: each repository with a file due, in a job of its own that yields
 *
 * The row is the truth and nothing waits for its file: a file that could not be written stays due, and the pass tries
 * again, with a pause per repository that the kernel doubles up to ten minutes. */

export const CODE_CHANGE_RPCS = [
	"qorpera_code_change_files_due",
	"qorpera_code_change_files",
	"qorpera_code_change_files_written",
	"qorpera_code_change_archive",
] as const;

/** A record file is at most this long, whatever its row holds. */
export const CODE_CHANGE_RECORD_BYTES = 24 * 1024;
/** The paths the kernel is told of one change: at most this many, and at most this much as JSON, so that they fit the
 * row (its `paths` may be 16 KiB as the database measures it). The rest are counted. */
export const CODE_CHANGE_PATHS = 50;
export const CODE_CHANGE_PATHS_BYTES = 12_000;
/** The paths a refusal names for the kernel: its row's `refusal` may be 8 KiB. */
export const CODE_CHANGE_REFUSAL_PATHS = 20;
export const CODE_CHANGE_REFUSAL_BYTES = 6000;
/** The longest path a change's picture may have: an agent names a file in the company folder by a path of at most
 * this many bytes (`qorpera_folder_describe_code_change`, migration `20260930720000`); the record's own copy of a
 * session's picture, `code/<owner>/<name>/changes/<n>.<ext>`, is far shorter. A record shows the path whole: cut, it
 * would name no file. */
export const CODE_CHANGE_PICTURE_PATH_BYTES = 1024;
/** A record's `## Checks` is at most this long, from its heading to its last line, whatever its row holds. */
export const CODE_CHANGE_CHECKS_BYTES = 4096;

/** A repository kept in Qorpera, as the kernel names it for its record's files. */
export interface CodeChangeTarget {
	companyId: string;
	environmentId: string;
	owner: string;
	name: string;
}

/** The picture of a change, as its row holds it: a file the session committed, with the record's own copy at `at`, or
 * a file in the company folder an agent named later. */
export type CodeChangePicture =
	| { source: "commit"; path: string; blob: string; at: string }
	| { source: "folder"; path: string };

/** One change of `qorpera.code-change-files/v1`: a row of the record, as its file is written from. */
export interface CodeChangeFile {
	n: number;
	version: number;
	/** `import`: change 1 of a repository brought in with its history (step 6, migration `20260930736000`). */
	kind: "landing" | "undo" | "restore" | "found" | "import";
	state: "landed" | "reverted" | "conflict" | "refused" | "lost";
	how: "fast-forward" | "merged" | null;
	createdAt: string;
	title: string;
	/** The session's folder path, and its turn. */
	session: string | null;
	turn: number | null;
	mainBefore: string | null;
	mainAfter: string | null;
	headSha: string | null;
	summary: string | null;
	notice: string | null;
	picture: CodeChangePicture | null;
	pictureProblem: string | null;
	filesChanged: number | null;
	paths: CodeChangePath[] | null;
	pathsMore: number;
	/** The row has both ends of main and no count of files yet: the job that writes its file finds what differs. */
	needsDiff: boolean;
	refusal: { code: string; paths: string[] } | null;
	undoes: number[] | null;
	revertedBy: number | null;
	restoredFrom: string | null;
	/** How the checks went (step 3, migration `20260930721000`): passed, none (the repository has no checks file), off
	 * (switched off for the repository), inherited (main's files are exactly those of a change whose checks passed),
	 * not_run (an undo or a restore without such a change), or null (before step 3, or a movement nobody saw). A state
	 * this executor does not know reads as null. */
	checksState: "passed" | "none" | "off" | "inherited" | "not_run" | null;
	/** The row's `checks` as the kernel sends it, never checked on the way in: a value of a shape its file cannot show
	 * reads as unknown there, and stops nothing. */
	checks: unknown;
	/** For an import's row, where the repository came from as the kernel sends it (the registry's `imported_from`:
	 * `branch`, the default branch it had there, `commits`, the earlier changes on it, and `lines`, the other lines of
	 * work that came with it, from migration `20260930741000`), never checked on the way in: a value its file cannot
	 * show is left out of its words, and stops nothing. */
	importedFrom?: unknown;
}
/** One line of the list. `line` is what a customer will notice, or else the change's title. */
export interface CodeChangeLine {
	n: number;
	createdAt: string;
	state: CodeChangeFile["state"];
	kind: CodeChangeFile["kind"];
	line: string;
}

const CALL_MS = 10_000;
const SHA = /^[0-9a-f]{40}$/;
const FIXED = /^[A-Z][A-Z0-9_]{2,80}$/;
const YIELDED = "CODE_HOST_JOB_YIELDED";
const KINDS = ["landing", "undo", "restore", "found", "import"];
const STATES = ["landed", "reverted", "conflict", "refused", "lost"];
const CHANGES = ["added", "changed", "removed"];
const CHECKS_STATES = ["passed", "none", "off", "inherited", "not_run"];
const CHECKS_SCHEMA = "qorpera.code-checks/v1";
/** A check's name as the checks file has it, and how many checks it has at most (step 3). */
const CHECK_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const CHECKS_MOST = 20;
/** A check's command is shown cut at this many bytes, or shorter when the checks would not fit their section. */
const CHECK_RUN_BYTES = 200;
const encoder = new TextEncoder();
const bytes = (text: string): number => encoder.encode(text).byteLength;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
const textOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";
const whole = (value: unknown, least = 0): value is number => Number.isSafeInteger(value) && (value as number) >= least;
const wholeOrNull = (value: unknown, least = 0): value is number | null => value === null || whole(value, least);

/** An error's fixed code: the code host's own, or a message that is one. */
export function codeChangeErrorCode(error: unknown): string {
	if ((error instanceof CodeHostJobFailure || error instanceof CodeHostRefusal) && FIXED.test(error.code))
		return error.code;
	return error instanceof Error && FIXED.test(error.message) ? error.message : "UNCLASSIFIED";
}

/** A call's answer, or its signal's reason once that aborts: a call that does not heed its signal cannot hold a code
 * host job past the time the record has, and an answer after that is dropped. */
export function answeredBefore<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		if (signal.aborted) {
			abort();
			return;
		}
		signal.addEventListener("abort", abort, { once: true });
		Promise.resolve()
			.then(call)
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", abort));
	});
}

// The words ----------------------------------------------------------------------------------------------------------

/** Whether no line of a record holds the character: a control (C0, DEL, C1), a separator that some readers break a
 * line at (LS, PS), or a mark that turns the direction of the text after it around. */
function unseen(code: number): boolean {
	return (
		code < 0x20 ||
		(code >= 0x7f && code <= 0x9f) ||
		code === 0x2028 ||
		code === 0x2029 ||
		(code >= 0x202a && code <= 0x202e) ||
		(code >= 0x2066 && code <= 0x2069)
	);
}
const halfCharacter = (code: number): boolean => code >= 0xd800 && code <= 0xdfff;

/** `text` cut to at most `max` bytes of UTF-8, at a character, with an ellipsis when it was cut. */
function within(text: string, max: number): string {
	if (bytes(text) <= max) return text;
	let kept = "";
	let used = bytes("…");
	for (const character of text) {
		used += bytes(character);
		if (used > max) break;
		kept += character;
	}
	return `${kept.trimEnd()}…`;
}

/** Words as one line: every run of white space and of characters no line holds is one space. */
function oneLine(text: string): string {
	let line = "";
	for (const character of text) {
		const code = character.codePointAt(0) as number;
		line += halfCharacter(code) ? "\uFFFD" : unseen(code) ? " " : character;
	}
	return line.replace(/\s+/g, " ").trim();
}

/** One line of somebody's words inside a line of the file's own (a title in the heading, a line of the list): cut to
 * `max` bytes, and every character Markdown reads as more than itself there written with a backslash, so that a reader
 * shows the words and nothing else: no link, picture, code, emphasis or HTML. */
function words(text: string, max: number): string {
	return within(oneLine(text), max).replace(/[\\`*_[\]<>&~#|]/g, "\\$&");
}

/** A path, or a name, as Markdown code: a reader shows its characters as they are, whatever they are. A character no
 * line holds is shown as the replacement character. The code's fence is longer than any run of backticks inside. */
function code(text: string, max = Number.POSITIVE_INFINITY): string {
	let shown = "";
	for (const character of text) {
		const point = character.codePointAt(0) as number;
		shown += halfCharacter(point) || unseen(point) ? "\uFFFD" : character;
	}
	shown = within(shown, max);
	const longest = Math.max(0, ...(shown.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(longest + 1);
	// A reader takes one space off each end of code that has one at both: so one is put there for it to take.
	const pad = shown === "" || /^[ `]|[ `]$/.test(shown) ? " " : "";
	return `${fence}${pad}${shown}${pad}${fence}`;
}

/** Somebody's words as a Markdown quote, line by line, so that nothing in them can pass for a line of the file's own:
 * each line begins `> `, whatever it holds (a heading, a code fence that never closes, a list). Line breaks of every
 * kind are line breaks; the characters no line holds are taken out; at most `max` bytes, cut at a line. Null when no
 * words are left. */
function quoted(text: string, max: number): string | null {
	let clean = "";
	for (const character of text.replace(/\r\n?|[\v\f\u0085\u2028\u2029]/g, "\n")) {
		const point = character.codePointAt(0) as number;
		if (character === "\n" || character === "\t") clean += character;
		else if (halfCharacter(point)) clean += "\uFFFD";
		else if (!unseen(point)) clean += character;
	}
	const lines = clean.split("\n").map((line) => line.trimEnd());
	while (lines.length && lines[0] === "") lines.shift();
	while (lines.length && lines.at(-1) === "") lines.pop();
	if (!lines.length) return null;
	const kept: string[] = [];
	let used = 0;
	for (const line of lines) {
		const quote = line ? `> ${line}` : ">";
		const size = bytes(quote) + 1;
		if (used + size > max) {
			// The first line alone may be too long: it is cut. Later ones are left out whole.
			const room = max - used - bytes("> ") - 1;
			if (!kept.length) kept.push(`> ${within(line, Math.max(room, 4))}`);
			else kept.push("> …");
			break;
		}
		kept.push(quote);
		used += size;
	}
	return kept.join("\n");
}

/** A list of paths as code, one a line, as many of the first as fit `max` bytes; then how many more there are
 * (`more` counts the ones the list never held). */
function pathList(items: readonly { path: string; prefix?: string }[], more: number, max: number): string[] {
	const lines: string[] = [];
	let used = 0;
	for (const item of items) {
		const line = `- ${item.prefix ? `${item.prefix} ` : ""}${code(item.path)}`;
		const size = bytes(line) + 1;
		if (used + size > max) break;
		lines.push(line);
		used += size;
	}
	const left = more + items.length - lines.length;
	if (left > 0) lines.push(lines.length ? `- and ${left} more` : `- ${left} not named here`);
	return lines;
}

/** A commit's name as it is; anything else that came in its place, as code. */
function commit(name: string): string {
	return SHA.test(name) ? name : code(name, 80);
}

/** A time to the minute, in UTC, and its day. */
function minute(time: string): string {
	const at = Date.parse(time);
	if (!Number.isFinite(at)) return "unknown";
	const iso = new Date(at).toISOString();
	return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
function day(time: string): string {
	const at = Date.parse(time);
	return Number.isFinite(at) ? new Date(at).toISOString().slice(0, 10) : "unknown";
}

function stateWords(change: CodeChangeFile): string {
	switch (change.state) {
		case "landed":
			return "in main";
		case "reverted":
			return change.revertedBy === null ? "undone" : `undone by change ${change.revertedBy}`;
		case "conflict":
			return "not in main: it conflicted with main";
		case "refused": {
			const said = change.refusal?.code ?? "";
			return `not in main: refused (${/^[A-Z][A-Z0-9_:]{0,99}$/.test(said) ? said : "UNKNOWN"})`;
		}
		default:
			return "no longer in the repository: a restore went back past it";
	}
}

function kindWords(change: CodeChangeFile): string {
	switch (change.kind) {
		case "landing":
			return "a change from a coding session";
		case "undo": {
			const undone = [...(change.undoes ?? [])].sort((a, b) => a - b);
			if (!undone.length) return "an undo";
			return undone.length === 1
				? `an undo of change ${undone[0]}`
				: `an undo of changes ${undone[0]} to ${undone.at(-1)}`;
		}
		case "restore": {
			// A stored copy is named by its time: 20261109T021455Z-<main, 12 hex>.
			const at = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})\d{2}Z-[0-9a-f]{12}$/.exec(change.restoredFrom ?? "");
			return at
				? `a restore from the copy of ${at[1]}-${at[2]}-${at[3]} ${at[4]}:${at[5]} UTC`
				: "a restore from a copy";
		}
		case "import":
			return "code brought into Qorpera";
		default:
			return "a change whose record was lost";
	}
}

/** Where the import keeps the other heads it brought (`code-import.ts`): an agent reads them there, and never changes
 * them. */
const IMPORTED_HEADS = "refs/qorpera/imported/heads/";
/** How many other lines of work change 1 names at most, as the look shows them; the rest are counted. */
const OTHER_LINES_SHOWN = 10;
/** The longest name of a line of work the look shows (`codeImportShown`): a longer one is not shown, never cut. */
const OTHER_LINE_NAME_BYTES = 200;
/** The words of the other lines of work are at most this long, from their first line to their last, whatever the row
 * holds: the lines past it are counted. (The registry keeps at most 2,048 bytes of where the code came from, so they
 * fit for every row the kernel sends.) */
const OTHER_LINES_BYTES = 4096;

/** A line of work the look shows (`lines.shown`), or undefined when the value is not of its shape. Only what the
 * record says is read: the kernel checked the rest when it took the look. A name that is not shown, or that the record
 * could not show whole as it is (cut, or with a character no line holds), is null: it would name no ref. */
function otherLineOf(
	value: unknown,
): { name: string | null; ahead: number; behind: number; lastAt: unknown; fits: unknown } | undefined {
	if (!isRecord(value) || !whole(value.ahead, 1) || !whole(value.behind)) return undefined;
	const { name } = value;
	const shown =
		typeof name === "string" &&
		name !== "" &&
		bytes(name) <= OTHER_LINE_NAME_BYTES &&
		![...name].some((character) => {
			const point = character.codePointAt(0) as number;
			return halfCharacter(point) || unseen(point);
		});
	return {
		name: shown ? name : null,
		ahead: value.ahead,
		behind: value.behind,
		lastAt: value.lastAt,
		fits: value.fits,
	};
}

/** The other lines of work a repository brought in came with (the look's `lines`, as the registry keeps them), as its
 * change 1 names them: each as the ref it is kept under, with what it has that main did not and the other way round,
 * when it last changed, and whether the company folder can hold its files; then how many more, and how one is brought
 * into main. At most ten are named, and at most as many as fit 4 KiB. Read leniently: no lines, none counted or a value
 * not of their shape is no words at all, which is the record as it was before the look measured them; a line not of
 * its shape is counted, not named. */
function otherLinesWords(lines: unknown): string[] {
	if (!isRecord(lines) || !whole(lines.count, 1)) return [];
	const count = lines.count;
	const items = (Array.isArray(lines.shown) ? lines.shown : [])
		.map(otherLineOf)
		.filter((line) => line !== undefined)
		.slice(0, Math.min(OTHER_LINES_SHOWN, count))
		.map((line) => {
			const named = line.name === null ? "one whose name is not shown" : code(`${IMPORTED_HEADS}${line.name}`);
			const ahead = `${line.ahead} ${line.ahead === 1 ? "change" : "changes"} main did not have`;
			const behind = `${line.behind} of main's it did not have`;
			const changed = typeof line.lastAt === "string" ? day(line.lastAt) : "unknown";
			const at = changed === "unknown" ? "" : `, last changed ${changed}`;
			const fits = line.fits === false ? "; the company folder cannot hold some of its file names" : "";
			return `- ${named}: ${ahead}, ${behind}${at}${fits}`;
		});
	const listed = `git for-each-ref ${IMPORTED_HEADS} lists them`;
	/** The words with the first `named` lines of work named, and the rest counted. */
	const section = (named: number) => {
		const more = count - named;
		return [
			"",
			`It also brought ${count} other ${count === 1 ? "line" : "lines"} of work, kept apart from main:`,
			"",
			...items.slice(0, named),
			...(more > 0 ? [named ? `- and ${more} more (${listed})` : `- ${more} not named here (${listed})`] : []),
			"",
			"A coding session brings one into main by merging it into its branch and finishing.",
		];
	};
	let fit = items.length;
	while (fit > 0 && bytes(section(fit).join("\n")) > OTHER_LINES_BYTES) fit -= 1;
	return section(fit);
}

/** What came with a repository brought in, as its change 1 says it: the earlier changes on the default branch it had
 * (a name, as code), and its files; then the other lines of work that came with it, when the kernel names any. What
 * the kernel did not send is left out of the sentence. */
function broughtInWords(change: CodeChangeFile): string[] {
	const from = isRecord(change.importedFrom) ? change.importedFrom : {};
	const { commits, branch } = from;
	const earlier = whole(commits, 1)
		? `${commits} earlier ${commits === 1 ? "change" : "changes"}`
		: "Its earlier changes";
	const on = typeof branch === "string" && branch !== "" ? ` on ${code(branch, 200)}` : "";
	const files = change.filesChanged;
	const and = files === null ? "" : ` and ${files} ${files === 1 ? "file" : "files"}`;
	return [
		`${earlier}${on}${and} came with it. Qorpera does not check code brought in.`,
		...otherLinesWords(from.lines),
	];
}

const PICTURE_PROBLEMS: Readonly<Record<string, string>> = {
	missing: "not found",
	not_a_file: "not a file",
	too_large: "too large",
	not_a_picture: "not a picture",
	not_shared: "not in the company's shared folders",
};
/** A passed run's checks (`qorpera.code-checks/v1`), as much of them as a record shows. */
interface Passed {
	how: "fast-forward" | "merged";
	ms: number;
	checks: { name: string; run: string; ms: number }[];
	changed: { added: string[]; removed: string[]; run: string[] } | null;
	tries: 1 | 2;
}
const checkNames = (value: unknown): value is string[] =>
	Array.isArray(value) &&
	value.length <= CHECKS_MOST &&
	value.every((name) => typeof name === "string" && CHECK_NAME.test(name));

/** The checks of a passed run, or undefined when the value is not of their shape. Only what the record shows is read:
 * the kernel checked the rest when it took the report. */
function passedOf(value: Record<string, unknown>): Passed | undefined {
	const { how, ms, checks, changed, tries } = value;
	if (
		(how !== "fast-forward" && how !== "merged") ||
		!whole(ms) ||
		(tries !== 1 && tries !== 2) ||
		!Array.isArray(checks) ||
		checks.length < 1 ||
		checks.length > CHECKS_MOST ||
		!checks.every(
			(check) =>
				isRecord(check) &&
				typeof check.name === "string" &&
				CHECK_NAME.test(check.name) &&
				typeof check.run === "string" &&
				whole(check.ms),
		) ||
		!(
			changed === null ||
			changed === undefined ||
			(isRecord(changed) && checkNames(changed.added) && checkNames(changed.removed) && checkNames(changed.run))
		)
	)
		return undefined;
	return { how, ms, checks: checks as Passed["checks"], changed: (changed ?? null) as Passed["changed"], tries };
}

/** A run's time, in whole minutes and seconds. */
function runTime(ms: number): string {
	const seconds = Math.round(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	if (!minutes) return `${seconds} s`;
	return seconds % 60 ? `${minutes} min ${seconds % 60} s` : `${minutes} min`;
}

/** The section of checks that passed: each check with its time and its command, then what the change changed of the
 * checks. The commands are cut at 200 bytes, all of them shorter when the section would not fit its 4 KiB otherwise,
 * and left out as a last step: every check keeps its name. */
function passedSection(passed: Passed): string[] {
	const where = passed.how === "merged" ? "the merge of this change with main" : "what went into main";
	const again = passed.tries === 2 ? ", and once more, since main moved meanwhile" : "";
	const parts: [string, string[]][] = passed.changed
		? [
				["added", passed.changed.added],
				["removed", passed.changed.removed],
				["changed", passed.changed.run],
			]
		: [];
	const changed = parts
		.filter(([, names]) => names.length)
		.map(([said, names]) => `${said} ${names.map((name) => code(name)).join(", ")}`);
	const section = (cap: number) => [
		"## Checks",
		"",
		`Passed on ${where}, in ${runTime(passed.ms)}${again}:`,
		"",
		...passed.checks.map(
			(check) => `- ${code(check.name)}${cap ? `: ${code(check.run, cap)}` : ""} (${Math.round(check.ms / 1000)} s)`,
		),
		...(changed.length ? ["", `This change changed the checks: ${changed.join("; ")}.`] : []),
	];
	for (let cap = CHECK_RUN_BYTES; cap > 0; cap -= 10) {
		const made = section(cap);
		if (bytes(made.join("\n")) <= CODE_CHANGE_CHECKS_BYTES) return made;
	}
	// Names as the checks file allows them, and twenty of each at most: without their commands they always fit (the
	// test of the most a row can hold says by how much).
	return section(0);
}

const UNKNOWN = {
	head: "unknown",
	section: [
		"## Checks",
		"",
		"Unknown: this change went in before Qorpera ran checks, or Qorpera did not see it go in.",
	],
};

/** A change's checks: the word of its head line and its section. Null for a landing that never went in. What the
 * record cannot say for sure (a state it does not know, a value not of its state's shape, an undo's state on any other
 * row) reads as unknown: it never stops the file. */
function checksWords(change: CodeChangeFile): { head: string; section: string[] } | null {
	if (change.state === "conflict" || change.state === "refused") return null;
	const value = isRecord(change.checks) && change.checks.schema === CHECKS_SCHEMA ? change.checks : undefined;
	const said = (head: string, sentence: string) => ({ head, section: ["## Checks", "", sentence] });
	switch (change.checksState) {
		case "passed": {
			const passed = value && passedOf(value);
			return passed ? { head: "passed", section: passedSection(passed) } : UNKNOWN;
		}
		case "none":
			return said("none", "None: the repository has no checks file (`.qorpera/checks.json`).");
		case "off":
			return said("off", "Not run: checks are switched off for this repository.");
		case "inherited":
			return value && whole(value.as, 1)
				? said(
						`as change ${value.as}`,
						`Not run again: main's files are exactly those of change ${value.as}, whose checks passed.`,
					)
				: UNKNOWN;
		case "not_run":
			if (change.kind === "landing")
				return said(
					"not run",
					"Not run on this intermediate commit: checks ran and passed on the combined batch tip.",
				);
			if (change.kind === "undo")
				return said(
					"not run",
					"Not run: Qorpera does not check an undo. The next change that goes in is checked with these files.",
				);
			// Code brought in: its record's own sentence under the head says so, and it has no section of checks.
			if (change.kind === "import") return { head: "not run", section: [] };
			return change.kind === "restore" ? said("not run", "Not run: Qorpera does not check a restore.") : UNKNOWN;
		default:
			return UNKNOWN;
	}
}

/** What the words under a change are called: a session's report, or why somebody undid or restored. */
const SAID: Readonly<Record<CodeChangeFile["kind"], string>> = {
	landing: "What the session said",
	undo: "Why it was undone",
	restore: "Why it was restored",
	found: "What was said",
	import: "What was said",
};

/** The record's text for one change of `qorpera.code-change-files/v1`: Markdown, UTF-8, at most 24 KiB. Pure. With
 * `diff`, the files are the ones the job found between the change's two ends of main (a row that had none yet).
 *
 * What a session, an agent or a member wrote never becomes a line of the file's own. Their sentences (what a customer
 * will notice, what the session said, why a change was undone) are quoted line by line. A title is one line with
 * every Markdown character written out. A path, a check's name and its command are code. And no line holds a control
 * character. */
export function codeChangeRecordText(change: CodeChangeFile, diff?: CodeChangeDiff): string {
	const filesChanged = diff ? diff.filesChanged : change.filesChanged;
	const checks = checksWords(change);
	const title = words(change.title, 400);
	const head = [
		`# Change ${change.n}${title ? `: ${title}` : ""}`,
		"",
		`- State: ${stateWords(change)}`,
		`- When: ${minute(change.createdAt)}`,
		`- What: ${kindWords(change)}`,
		...(change.session === null
			? []
			: [`- Session: ${code(change.session, 400)}${change.turn === null ? "" : ` (turn ${change.turn})`}`]),
		...(change.how === null ? [] : [`- Went in as: ${change.how === "merged" ? "a merge" : "a fast-forward"}`]),
		...(change.mainBefore === null ? [] : [`- Main before: ${commit(change.mainBefore)}`]),
		...(change.mainAfter === null ? [] : [`- Main after: ${commit(change.mainAfter)}`]),
		...(filesChanged === null ? [] : [`- Files changed: ${filesChanged}`]),
		...(checks ? [`- Checks: ${checks.head}`] : []),
	];
	const notice = change.notice === null ? null : quoted(change.notice, 1000);
	const problem = change.pictureProblem === null ? undefined : PICTURE_PROBLEMS[change.pictureProblem];
	const picture = change.picture
		? code(
				change.picture.source === "commit" ? change.picture.at : change.picture.path,
				CODE_CHANGE_PICTURE_PATH_BYTES,
			)
		: problem
			? `None: the picture given was ${problem}.`
			: "None.";
	const said = change.summary === null ? null : quoted(change.summary, 12 * 1024);
	const why = change.refusal?.paths.length
		? pathList(
				change.refusal.paths.map((path) => ({ path })),
				0,
				2048,
			)
		: [];
	const sections = [
		...head,
		...(change.kind === "import" ? ["", ...broughtInWords(change)] : []),
		"",
		"## What a customer will notice",
		"",
		notice ?? "Nothing was said.",
		"",
		"## Picture",
		"",
		picture,
		...(checks?.section.length ? ["", ...checks.section] : []),
		...(said === null ? [] : ["", `## ${SAID[change.kind]}`, "", said]),
		...(why.length ? ["", "## Why it did not go in", "", ...why] : []),
	];
	const paths = diff ? diff.paths : change.paths;
	if (paths !== null) {
		// The files get what the rest of the record left of its 24 KiB: every part above has a bound of its own (a path
		// as code may be three times its bytes, when it is all backticks), and together they stay under 22 KiB for
		// every row the kernel sends (its commits are commits' names, and a row that has checks never has a refusal).
		const room = CODE_CHANGE_RECORD_BYTES - bytes(sections.join("\n")) - 64;
		const more = diff ? diff.pathsMore : change.pathsMore;
		const files = pathList(
			paths.map((entry) => ({ path: entry.path, prefix: entry.change })),
			more,
			room,
		);
		sections.push("", "## Files", "", ...(files.length ? files : ["None."]));
	}
	return `${sections.join("\n")}\n`;
}

const LISTED: Readonly<Record<CodeChangeFile["state"], string>> = {
	landed: "in main",
	reverted: "undone",
	conflict: "not in main (conflict)",
	refused: "not in main (refused)",
	lost: "lost in a restore",
};

/** What of a repository's site the list says (own code storage, step 4; migration `20260930729000`): the version that
 * is live, and the change that is ready in What's new; from step 5 (migration `20260930756000`), while sites have hosts
 * of their own, also the change whose site is being prepared for What's new. The kernel sends each in the list's
 * `index`, and it is never checked on the way in: a value of a shape the list cannot show reads as absent there, and
 * stops nothing. A key the kernel does not send (a kernel from before step 4, or a repository that makes no site) is
 * no line; null says that nothing is live yet, or that nothing is ready (and, for `preparing`, is no line either). */
export interface CodeChangeReleases {
	/** `{version, kind: "release" | "back", change, since, by, url}`: `by` is the member's name, null once the member
	 * left; a go-back shows the number of the version it put back. */
	live?: unknown;
	/** `{change}`. */
	ready?: unknown;
	/** `{change}`: the change due in What's new whose site is not ready yet, between its landing and the upload. */
	preparing?: unknown;
	/** `{reason}`: Qorpera took the repository's site down (step 5.1, an operator's takedown); the kernel then sends
	 * nothing live and no link, and the list says so in place of what is live. */
	takenDown?: unknown;
}

/** A time as the kernel sends one (a `timestamptz` in JSON): a day, a time and its offset. */
const TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}(:?\d{2})?)$/;
/** A site's link as `qorpera_site_url` makes one for a site of files: the sites' origin, then the site's name. */
const SITE_LINK = /^https:\/\/[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?\/[a-z0-9][a-z0-9-]{1,46}[a-z0-9]\/$/;
/** A site's own host, as `qorpera_site_url` makes its link while sites have hosts of their own (step 5, migration
 * `20260930756000`), by the one host rule (STEP5-BUILD.md): one label before `.qorpera.com`, of runs of a-z and 0-9
 * joined by single hyphens (so never a next host, `<name>--next`), whose name is 3 to 48 long and one a site may have
 * (`codeSiteNameValid`), then `/`. */
const SITE_HOST_LINK = /^https:\/\/([a-z0-9]+(?:-[a-z0-9]+)*)\.qorpera\.(?:com|site)\/$/;

/** Whether `url` is a site's link as the list shows one: today's form, or a site's own host. */
function siteLink(url: unknown): url is string {
	if (typeof url !== "string") return false;
	if (SITE_LINK.test(url)) return true;
	const name = SITE_HOST_LINK.exec(url)?.[1];
	return name !== undefined && codeSiteNameValid(name);
}

/** The line of what is live: undefined when there is none to write. The member's name is their own text: one line of
 * words, "a member" when there is none; a link that is not a site's is left off. */
function liveLine(live: unknown): string | undefined {
	if (live === null) return "Live: nothing yet.";
	if (!isRecord(live)) return undefined;
	const { version, kind, change, since, by, url } = live;
	if (
		!whole(version, 1) ||
		(kind !== "release" && kind !== "back") ||
		!whole(change, 1) ||
		typeof since !== "string" ||
		!TIME.test(since) ||
		!Number.isFinite(Date.parse(since))
	)
		return undefined;
	const back = kind === "back";
	const name = (typeof by === "string" && words(by, 200)) || "a member";
	const link = siteLink(url) ? ` ${url}` : "";
	return `Live: version ${version}${back ? " again" : ""}, made at change ${change}, since ${minute(since)}; ${name} ${back ? "went back" : "said go"}.${link}`;
}

/** The line in place of what is live while Qorpera has the site taken down (step 5.1): the words an agent reads when it
 * would publish to such a site, with the operator's reason as one line of words, and no link; undefined when the
 * kernel does not say so. */
function takenDownLine(takenDown: unknown): string | undefined {
	if (!isRecord(takenDown) || typeof takenDown.reason !== "string") return undefined;
	const reason = words(takenDown.reason, 300);
	return reason
		? `Live: nothing. This site was taken down by Qorpera (${reason}) and cannot be published until Qorpera restores it. Tell a member of the company.`
		: undefined;
}

/** The line of what is ready in What's new: undefined when there is none to write. */
function readyLine(ready: unknown): string | undefined {
	if (ready === null) return "Ready in What's new: nothing.";
	return isRecord(ready) && whole(ready.change, 1) ? `Ready in What's new: change ${ready.change}.` : undefined;
}

/** The line of the change whose site is being prepared for What's new (step 5, while sites have hosts of their own):
 * undefined when nothing is, or the kernel does not say. */
function preparingLine(preparing: unknown): string | undefined {
	return isRecord(preparing) && whole(preparing.change, 1)
		? `Being prepared for What's new: change ${preparing.change} (about a minute).`
		: undefined;
}

/** How long after a restore the list opens with the changes it took out of main. */
const RESTORE_LINE_MS = 30 * 86_400_000;
/** How many numbers, or runs of numbers, that line names at most: the changes past them are counted. */
const RESTORE_LINE_PARTS = 10;

/** The line that opens the list for 30 days after a restore, from the lines' own kinds and states: the day of the
 * newest restore, and every change the record holds as lost in a restore (a restore's own row is no change to make
 * again, and is left out). A lost change is always older than the newest restore, and it is not in main whichever
 * restore took it out. Runs of three or more are `a to b`; after ten numbers or runs the rest are counted. Undefined
 * when no restore is among the lines, its time cannot be read, 30 days have passed since, or no change is lost.
 * `lines` are newest first. (The list is written only when the kernel says it is behind: the line goes the first time
 * it is written after the 30 days.) */
function restoreLine(lines: readonly CodeChangeLine[], now: number): string | undefined {
	const restore = lines.find((line) => line.kind === "restore");
	const at = restore ? Date.parse(restore.createdAt) : Number.NaN;
	if (!restore || !Number.isFinite(at) || now - at >= RESTORE_LINE_MS) return undefined;
	const lost = lines
		.filter((line) => line.state === "lost" && line.kind !== "restore")
		.map((line) => line.n)
		.sort((a, b) => a - b);
	if (!lost.length) return undefined;
	const runs: { from: number; to: number }[] = [];
	for (const n of lost) {
		const run = runs.at(-1);
		if (run && n === run.to + 1) run.to = n;
		else runs.push({ from: n, to: n });
	}
	const parts = runs.flatMap(({ from, to }) =>
		to - from >= 2
			? [{ said: `${from} to ${to}`, count: to - from + 1 }]
			: Array.from({ length: to - from + 1 }, (_, k) => ({ said: `${from + k}`, count: 1 })),
	);
	const more = parts.slice(RESTORE_LINE_PARTS).reduce((sum, part) => sum + part.count, 0);
	const named = [...parts.slice(0, RESTORE_LINE_PARTS).map((part) => part.said), ...(more ? [`${more} more`] : [])];
	const list = named.length > 1 ? `${named.slice(0, -1).join(", ")} and ${named.at(-1)}` : named[0];
	const one = lost.length === 1;
	return `Put back to an earlier copy on ${day(restore.createdAt)}: ${one ? "change" : "changes"} ${list} ${one ? "is" : "are"} no longer in main.`;
}

/** What the list's head says beside the changes, as the kernel sends it in the list's `index`: what of the site is live
 * and what is ready (step 4), and the repository's import while it is new (step 6, migration `20260930741000`). */
export interface CodeChangeIndexHead extends CodeChangeReleases {
	imported?: unknown;
	total?: number;
}

export const CODE_CHANGE_INDEX_LIMIT = 100;
export const CODE_CHANGE_ARCHIVE_BUCKET = 500;
export const CODE_CHANGE_ARCHIVES_PER_JOB = 20;
const CODE_CHANGE_ARCHIVE_SLICE = 200;
const CODE_CHANGE_MAX_BATCH = 200;
const CODE_CHANGE_MAX_CONTINUATIONS = 100;
const CODE_CHANGE_ARCHIVE_CACHE_MAX = 4096;

export function codeChangeArchiveName(start: number, end: number): string {
	return `${String(start).padStart(4, "0")}-${String(end).padStart(4, "0")}.md`;
}

export function codeChangeArchiveRanges(
	total: number,
): { start: number; end: number; name: string; immutable: boolean }[] {
	if (!whole(total, 1) || total <= CODE_CHANGE_INDEX_LIMIT) return [];
	const cutoff = total - CODE_CHANGE_INDEX_LIMIT;
	const ranges: { start: number; end: number; name: string; immutable: boolean }[] = [];
	for (let start = 1; start <= cutoff; start += CODE_CHANGE_ARCHIVE_BUCKET) {
		const end = start + CODE_CHANGE_ARCHIVE_BUCKET - 1;
		ranges.push({ start, end, name: codeChangeArchiveName(start, end), immutable: total >= end });
	}
	return ranges;
}

export function codeChangeArchiveText(
	repository: { owner: string; name: string },
	start: number,
	end: number,
	lines: readonly CodeChangeLine[],
	complete = false,
): string {
	const byNumber = new Map<number, CodeChangeLine>();
	for (const entry of lines) {
		if (entry.n >= start && entry.n <= end) byNumber.set(entry.n, entry);
	}
	const ordered = [...byNumber.values()].sort((a, b) => a.n - b.n);
	const status = complete ? CODE_CHANGE_ARCHIVE_COMPLETE_LINE : `Status: partial (through ${ordered.at(-1)?.n ?? 0}).`;
	return `${[
		`# Changes ${start} to ${end} in ${words(`${repository.owner}/${repository.name}`, 200)}`,
		"",
		status,
		"See changes/<n>.md for current status.",
		"",
		...(ordered.length
			? ordered.map((entry) => {
					const said = words(entry.line, 200);
					return `- ${entry.n} · ${day(entry.createdAt)}${said ? ` · ${said}` : ""}`;
				})
			: ["None yet."]),
	].join("\n")}\n`;
}

/** How long after an import the list opens with the other lines of work that came with it. */
const IMPORTED_LINE_MS = 30 * 86_400_000;

/** The line that opens the list for 30 days after the repository was brought in with other lines of work, in words a
 * member reads too (the record's files are the agents', and members can open them): when, how many lines, how many
 * changes the main version did not have, and where they are named. Undefined when the kernel sent none, or nothing
 * the line can say for sure (a time it cannot read, no line or change counted), or 30 days have passed by `now`. */
function importedLine(imported: unknown, now: number): string | undefined {
	if (!isRecord(imported) || !isRecord(imported.lines)) return undefined;
	const { at } = imported;
	const { count, changes } = imported.lines;
	const time = typeof at === "string" && TIME.test(at) ? Date.parse(at) : Number.NaN;
	if (!Number.isFinite(time) || now - time >= IMPORTED_LINE_MS || !whole(count, 1) || !whole(changes, 1))
		return undefined;
	const lines = `${count} other ${count === 1 ? "line" : "lines"} of work`;
	const said = `${changes} ${changes === 1 ? "change" : "changes"}`;
	return `Brought in on ${day(at as string)} with ${lines} that the main version did not have (${said}): changes/1.md names them.`;
}

/** The list's text, `changes/index.md`: for 30 days after a restore, the changes it took out of main; for 30 days after
 * the repository was brought in with other lines of work, how many; what of the repository's site is live and what is
 * ready, when the kernel says so; then the newest changes, one line each, newest first, at most a hundred. Pure but for
 * the time it is made at (`now`, the clock's by default). Each line's words (what a customer will notice, or the
 * title) are one line of at most 200 bytes with every Markdown character written out. */
export function codeChangeIndexText(
	repository: { owner: string; name: string },
	lines: readonly CodeChangeLine[],
	head: CodeChangeIndexHead = {},
	now: number = Date.now(),
): string {
	const newest = [...lines].sort((a, b) => b.n - a.n).slice(0, CODE_CHANGE_INDEX_LIMIT);
	const total = Math.max(lines.length, whole(head.total, 0) ? head.total : 0);
	const summary =
		total > CODE_CHANGE_INDEX_LIMIT
			? `Showing latest ${CODE_CHANGE_INDEX_LIMIT} of ${total} changes. Older changes are in changes/archive/.`
			: undefined;
	const site = [
		takenDownLine(head.takenDown) ?? liveLine(head.live),
		readyLine(head.ready),
		preparingLine(head.preparing),
	].filter((line) => line !== undefined);
	const opening = [restoreLine(newest, now), importedLine(head.imported, now)].filter((line) => line !== undefined);
	return `${[
		`# Changes in ${words(`${repository.owner}/${repository.name}`, 200)}`,
		"",
		...(opening.length ? [...opening, ""] : []),
		...(site.length ? [...site, ""] : []),
		...(summary ? [summary, ""] : []),
		...(newest.length
			? newest.map((entry) => {
					const said = words(entry.line, 200);
					return `- ${entry.n} · ${day(entry.createdAt)} · ${LISTED[entry.state]}${said ? ` · ${said}` : ""}`;
				})
			: ["None yet."]),
	].join("\n")}\n`;
}

// What the kernel is told of paths -----------------------------------------------------------------------------------

/** The first of `paths` that fit: at most `count` of them, and at most `maximum` bytes as JSON. */
function fitting<T>(paths: readonly T[], count: number, maximum: number): T[] {
	const kept: T[] = [];
	let used = 2;
	for (const entry of paths.slice(0, count)) {
		const size = bytes(JSON.stringify(entry)) + 1;
		if (used + size > maximum) break;
		kept.push(entry);
		used += size;
	}
	return kept;
}

/** What differs, as the kernel takes it into a change's row: the first paths that fit the row, and the count of the
 * rest. */
export function codeChangeDiffReported(diff: CodeChangeDiff): CodeChangeDiff {
	const paths = fitting(diff.paths, CODE_CHANGE_PATHS, CODE_CHANGE_PATHS_BYTES).map((entry) => ({
		path: entry.path,
		change: entry.change,
	}));
	return {
		filesChanged: diff.filesChanged,
		paths,
		pathsMore: Math.max(0, diff.filesChanged - paths.length, diff.pathsMore + diff.paths.length - paths.length),
	};
}

/** The paths a refusal named, as the kernel takes them into the row. */
export function codeChangeRefusalPaths(paths: readonly string[]): string[] {
	return fitting(paths, CODE_CHANGE_REFUSAL_PATHS, CODE_CHANGE_REFUSAL_BYTES);
}

/** What a job found between two commits, as it promises it, or undefined. */
export function codeChangeDiffOf(value: unknown): CodeChangeDiff | undefined {
	if (
		!isRecord(value) ||
		!whole(value.filesChanged) ||
		!whole(value.pathsMore) ||
		!Array.isArray(value.paths) ||
		!value.paths.every(
			(entry) => isRecord(entry) && typeof entry.path === "string" && CHANGES.includes(entry.change as string),
		)
	)
		return undefined;
	return { filesChanged: value.filesChanged, paths: value.paths as CodeChangePath[], pathsMore: value.pathsMore };
}

// The kernel's answers -----------------------------------------------------------------------------------------------

function targetOf(value: unknown): CodeChangeTarget {
	const { companyId, environmentId, owner, name } = isRecord(value) ? value : {};
	if (!isUuid(companyId) || !isUuid(environmentId)) throw new Error("CODE_CHANGE_FILES_UNCONFIRMED");
	const repository = parseCloudCodingRepository({ host: "qorpera", owner, name, baseBranch: "main" });
	return { companyId, environmentId, owner: repository.owner, name: repository.name };
}

function pictureOf(value: unknown, at: string): CodeChangePicture | null {
	if (value === null) return null;
	if (isRecord(value) && typeof value.path === "string") {
		if (value.source === "folder") return { source: "folder", path: value.path };
		// The record's own copy goes where the row says, and that is this change's place and no other.
		if (
			value.source === "commit" &&
			typeof value.blob === "string" &&
			SHA.test(value.blob) &&
			typeof value.at === "string" &&
			[".png", ".jpg", ".webp"].some((end) => value.at === `${at}${end}`)
		)
			return { source: "commit", path: value.path, blob: value.blob, at: value.at };
	}
	throw new Error("CODE_CHANGE_FILES_UNCONFIRMED");
}

function changeOf(value: unknown, target: CodeChangeTarget): CodeChangeFile {
	const row = isRecord(value) ? value : {};
	const sha = (commit: unknown): commit is string | null =>
		commit === null || (typeof commit === "string" && SHA.test(commit));
	const refusal = row.refusal;
	if (
		!whole(row.n, 1) ||
		!whole(row.version, 1) ||
		!KINDS.includes(row.kind as string) ||
		!STATES.includes(row.state as string) ||
		![null, "fast-forward", "merged"].includes(row.how as string | null) ||
		typeof row.createdAt !== "string" ||
		typeof row.title !== "string" ||
		![row.session, row.summary, row.notice, row.pictureProblem, row.restoredFrom].every(textOrNull) ||
		![row.mainBefore, row.mainAfter, row.headSha].every(sha) ||
		!wholeOrNull(row.turn, 1) ||
		!wholeOrNull(row.filesChanged) ||
		!wholeOrNull(row.revertedBy, 1) ||
		!whole(row.pathsMore) ||
		typeof row.needsDiff !== "boolean" ||
		(row.needsDiff && (row.mainBefore === null || row.mainAfter === null)) ||
		!(
			row.paths === null ||
			(Array.isArray(row.paths) &&
				row.paths.every(
					(entry) => isRecord(entry) && typeof entry.path === "string" && CHANGES.includes(entry.change as string),
				))
		) ||
		!(
			refusal === null ||
			(isRecord(refusal) &&
				typeof refusal.code === "string" &&
				Array.isArray(refusal.paths) &&
				refusal.paths.every((path) => typeof path === "string"))
		) ||
		!(row.undoes === null || (Array.isArray(row.undoes) && row.undoes.every((n) => whole(n, 1))))
	)
		throw new Error("CODE_CHANGE_FILES_UNCONFIRMED");
	return {
		n: row.n,
		version: row.version,
		kind: row.kind as CodeChangeFile["kind"],
		state: row.state as CodeChangeFile["state"],
		how: row.how as CodeChangeFile["how"],
		createdAt: row.createdAt,
		title: row.title,
		session: row.session as string | null,
		turn: row.turn,
		mainBefore: row.mainBefore as string | null,
		mainAfter: row.mainAfter as string | null,
		headSha: row.headSha as string | null,
		summary: row.summary as string | null,
		notice: row.notice as string | null,
		picture: pictureOf(row.picture, `code/${target.owner}/${target.name}/changes/${row.n}`),
		pictureProblem: row.pictureProblem as string | null,
		filesChanged: row.filesChanged,
		paths: row.paths as CodeChangePath[] | null,
		pathsMore: row.pathsMore,
		needsDiff: row.needsDiff,
		refusal: refusal as CodeChangeFile["refusal"],
		undoes: row.undoes as number[] | null,
		revertedBy: row.revertedBy,
		restoredFrom: row.restoredFrom as string | null,
		// Read leniently (a kernel from before step 3 sends neither): what the file cannot show reads as unknown there.
		checksState: CHECKS_STATES.includes(row.checksState as string)
			? (row.checksState as CodeChangeFile["checksState"])
			: null,
		checks: row.checks ?? null,
		// Read leniently too (only an import's row has it, and a kernel from before step 6 sends none).
		importedFrom: row.importedFrom ?? null,
	};
}

function lineOf(value: unknown): CodeChangeLine {
	const { n, createdAt, state, kind, line } = isRecord(value) ? value : {};
	if (
		!whole(n, 1) ||
		typeof createdAt !== "string" ||
		!STATES.includes(state as string) ||
		!KINDS.includes(kind as string) ||
		typeof line !== "string"
	)
		throw new Error("CODE_CHANGE_FILES_UNCONFIRMED");
	return { n, createdAt, state: state as CodeChangeLine["state"], kind: kind as CodeChangeLine["kind"], line };
}

/** The answer of `qorpera_code_change_files` for `target`, checked field by field: at most `limit` changes, and the
 * list when it is due. */
function filesOf(
	answer: unknown,
	target: CodeChangeTarget,
	limit: number,
): {
	changes: CodeChangeFile[];
	index: ({ version: number; lines: CodeChangeLine[] } & CodeChangeIndexHead) | null;
	hasMore: boolean;
} {
	if (!isRecord(answer) || answer.schema !== "qorpera.code-change-files/v1" || !Array.isArray(answer.changes))
		throw new Error("CODE_CHANGE_FILES_UNCONFIRMED");
	const named = isRecord(answer.repository) ? answer.repository : {};
	if (
		named.environmentId !== target.environmentId ||
		named.owner !== target.owner ||
		named.name !== target.name ||
		!(named.companyId === null || named.companyId === target.companyId)
	)
		throw new Error("CODE_CHANGE_FILES_UNCONFIRMED");
	if (named.companyId === null) return { changes: [], index: null, hasMore: false };
	const index = answer.index;
	if (index !== null && !(isRecord(index) && whole(index.version) && Array.isArray(index.lines)))
		throw new Error("CODE_CHANGE_FILES_UNCONFIRMED");
	return {
		changes: answer.changes.slice(0, limit).map((change) => changeOf(change, target)),
		index:
			index === null
				? null
				: {
						version: index.version as number,
						lines: (index.lines as unknown[]).map(lineOf),
						live: index.live,
						ready: index.ready,
						imported: index.imported,
						preparing: index.preparing,
						takenDown: index.takenDown,
						...(whole(index.total, 0) ? { total: index.total } : {}),
					},
		hasMore: answer.hasMore === true,
	};
}

function archiveLinesOf(answer: unknown, target: CodeChangeTarget): CodeChangeLine[] {
	if (!isRecord(answer) || answer.schema !== "qorpera.code-change-archive/v1" || !Array.isArray(answer.lines))
		throw new Error("CODE_CHANGE_ARCHIVE_UNCONFIRMED");
	const named = isRecord(answer.repository) ? answer.repository : {};
	if (
		named.environmentId !== target.environmentId ||
		named.owner !== target.owner ||
		named.name !== target.name ||
		!(named.companyId === null || named.companyId === target.companyId)
	)
		throw new Error("CODE_CHANGE_ARCHIVE_UNCONFIRMED");
	if (named.companyId === null) return [];
	return answer.lines.map(lineOf);
}

// The writer ---------------------------------------------------------------------------------------------------------

export interface CodeChangeRecordsOptions {
	control: { call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> };
	/** The executor's code host jobs, with the `yields` option. */
	hosts: Pick<CodeHostJobs, "run">;
	/** `writeCodeChangeRecords` of `code-host-jobs.ts`, as it is. */
	write: typeof writeCodeChangeRecords;
	listArchives?: (job: CodeHostJob, repository: CloudCodingRepository) => Promise<ReadonlySet<string>>;
	owner: string;
	machineIdSha256: string;
	/** The log lines `code-change` and `code-change-error` (whose `error` is the error itself, for the log to redact). */
	report?: (event: Record<string, unknown>) => void;
	/** How many due repositories one pass takes, 1 to 50. Default 20. */
	limit?: number;
	/** How many changes one job writes, 1 to 20. Default 20. */
	changes?: number;
	/** The clock the list's line about a restore is read by. */
	now?: () => number;
}

/** Whether the job that writes a change's file is to find what differs between its two ends of main first. Never for a
 * row a restore went back past, nor for a restore's own row: the repository may no longer hold one of its ends, and
 * the job leaves a record unwritten whose commits are gone. Nor for an import's: no main was there before it. (The
 * kernel says the same; this holds without it.) */
function diffDue(change: CodeChangeFile): boolean {
	return change.needsDiff && change.state !== "lost" && change.kind !== "restore" && change.kind !== "import";
}

/** What one job wrote, for the kernel to be told once the job has saved. `leftOut`: a record the job was handed and
 * did not write, which stays due; the kernel is told of it as a problem, so that it waits before it names the
 * repository again. */
interface Written {
	changes: { n: number; version: number; diff?: CodeChangeDiff }[];
	indexVersion: number | null;
	leftOut: number[];
	hasMore: boolean;
	immutableArchives: string[];
}
/** The problem the kernel is told for a record a job left out. */
const LEFT_OUT = "CODE_CHANGE_RECORD_LEFT_OUT";
/** What one call tells the kernel of written rows, at most: the executor's control sends no request over 128 KiB, and
 * twenty rows with a found diff each can be twice that. */
const WRITTEN_BYTES = 64 * 1024;

export class CodeChangeRecords {
	readonly #control: CodeChangeRecordsOptions["control"];
	readonly #hosts: Pick<CodeHostJobs, "run">;
	readonly #write: typeof writeCodeChangeRecords;
	readonly #listArchives: (job: CodeHostJob, repository: CloudCodingRepository) => Promise<ReadonlySet<string>>;
	readonly #owner: string;
	readonly #machineIdSha256: string;
	readonly #report: (event: Record<string, unknown>) => void;
	readonly #limit: number;
	readonly #changes: number;
	readonly #now: () => number;
	readonly #writtenArchives = new Set<string>();

	constructor(options: CodeChangeRecordsOptions) {
		const limit = options.limit ?? 20,
			changes = options.changes ?? CODE_CHANGE_MAX_BATCH;
		if (
			typeof options.owner !== "string" ||
			!options.owner ||
			typeof options.machineIdSha256 !== "string" ||
			!/^[0-9a-f]{64}$/.test(options.machineIdSha256) ||
			typeof options.write !== "function" ||
			!whole(limit, 1) ||
			limit > 50 ||
			!whole(changes, 1) ||
			changes > CODE_CHANGE_MAX_BATCH
		)
			throw new Error("INVALID_CODE_CHANGE_RECORDS");
		this.#control = options.control;
		this.#hosts = options.hosts;
		this.#write = options.write;
		this.#listArchives =
			options.listArchives ??
			(options.write === writeCodeChangeRecords ? listCodeChangeArchives : async () => new Set<string>());
		this.#owner = options.owner;
		this.#machineIdSha256 = options.machineIdSha256;
		const report = options.report;
		// The log must never change what happens: a reporter that throws is not heard.
		this.#report = (event) => {
			try {
				report?.(event);
			} catch {
				/* not heard */
			}
		};
		this.#limit = limit;
		this.#changes = changes;
		this.#now = options.now ?? Date.now;
	}

	/** Inside a job of the repository's company, which holds that company's line: the files that are due are written,
	 * under `signal` (the time the job gives its record). Answers what to call once the job has saved: it tells the
	 * kernel which files are written. Neither ever rejects: what failed is reported (`code-change-error`) and the files
	 * stay due, for the pass. A job that fails afterwards saved nothing, and its caller then leaves the answer alone. */
	async inJob(job: CodeHostJob, target: CodeChangeTarget, signal: AbortSignal): Promise<() => Promise<void>> {
		let written: Written | undefined;
		try {
			// One read: a job that holds a company's line does not wait for a second.
			written = await answeredBefore(() => this.#writeDue(job, target, signal, [this.#changes]), signal);
		} catch (error) {
			this.#report({ event: "code-change-error", step: "files", where: "job", ...named(target), error });
		}
		const wrote = written;
		if (!wrote) return async () => undefined;
		return async () => {
			this.#rememberArchives(wrote.immutableArchives);
			if (wrote.changes.length === 0 && wrote.indexVersion === null && !wrote.leftOut.length) return;
			if (
				await this.#written(
					target,
					wrote,
					wrote.leftOut.length ? LEFT_OUT : null,
					1,
					AbortSignal.timeout(CALL_MS / 2),
				)
			)
				this.#report({ event: "code-change", step: "written", where: "job", ...named(target), ...said(wrote) });
		};
	}

	async pass(signal: AbortSignal): Promise<{ written: number; failed: number }> {
		const counts = { written: 0, failed: 0 };
		await withAbortScope(signal, async (scoped) => {
			let due: CodeChangeTarget[];
			try {
				due = await this.#due(scoped);
			} catch (error) {
				if (!scoped.aborted) this.#report({ event: "code-change-error", step: "due", error });
				return;
			}
			for (const target of due) {
				if (scoped.aborted) return;
				const seen = new Set<string>();
				let status: "written" | "failed" | undefined;
				for (let round = 0; round < CODE_CHANGE_MAX_CONTINUATIONS && !scoped.aborted; round += 1) {
					const step = await this.#repository(target, scoped);
					if (step.status === "failed") {
						status = "failed";
						break;
					}
					if (step.status === undefined) break;
					status = "written";
					let progressed = false;
					for (const key of step.writtenKeys) {
						if (!seen.has(key)) {
							seen.add(key);
							progressed = true;
						}
					}
					if (!step.hasMore || !progressed) break;
				}
				if (status) counts[status] += 1;
			}
		});
		return counts;
	}

	async #due(signal: AbortSignal): Promise<CodeChangeTarget[]> {
		const answer = await this.#call(
			CODE_CHANGE_RPCS[0],
			{ p_owner: this.#owner, p_machine_id_sha256: this.#machineIdSha256, p_limit: this.#limit },
			signal,
		);
		if (
			!isRecord(answer) ||
			answer.schema !== "qorpera.code-change-files-due/v1" ||
			!Array.isArray(answer.repositories)
		)
			throw new Error("CODE_CHANGE_DUE_UNCONFIRMED");
		const due: CodeChangeTarget[] = [];
		for (const entry of answer.repositories.slice(0, this.#limit)) {
			try {
				due.push(targetOf(entry));
			} catch {
				// One entry that names no repository kept here does not hold up the others.
				this.#report({ event: "code-change-error", step: "due", error: new Error("CODE_CHANGE_DUE_UNCONFIRMED") });
			}
		}
		return due;
	}

	/** One repository's due files, in a job of its own that yields. */
	async #repository(
		target: CodeChangeTarget,
		signal: AbortSignal,
	): Promise<{ status: "written" | "failed" | undefined; hasMore: boolean; writtenKeys: string[] }> {
		let wrote: Written | undefined;
		const limits = [...new Set([this.#changes, 50, 20, 5, 1].filter((n) => n <= this.#changes))];
		try {
			wrote = await this.#hosts.run(
				target.companyId,
				target.environmentId,
				signal,
				(job) => this.#writeDue(job, target, job.signal, limits),
				{ yields: true },
			);
		} catch (error) {
			if (
				signal.aborted ||
				(error instanceof CodeHostJobFailure && error.code === YIELDED) ||
				error instanceof CodingControlBusy
			)
				return { status: undefined, hasMore: false, writtenKeys: [] };
			this.#report({ event: "code-change-error", step: "files", where: "pass", ...named(target), error });
			await this.#written(
				target,
				{ changes: [], indexVersion: null, leftOut: [], hasMore: false, immutableArchives: [] },
				codeChangeErrorCode(error),
				1,
				signal,
			);
			return { status: "failed", hasMore: false, writtenKeys: [] };
		}
		if (!wrote) return { status: undefined, hasMore: false, writtenKeys: [] };
		this.#rememberArchives(wrote.immutableArchives);
		const needsConfirm = wrote.changes.length > 0 || wrote.indexVersion !== null || wrote.leftOut.length > 0;
		if (needsConfirm && !(await this.#written(target, wrote, wrote.leftOut.length ? LEFT_OUT : null, 2, signal)))
			return { status: "failed", hasMore: false, writtenKeys: [] };
		this.#report({ event: "code-change", step: "written", where: "pass", ...named(target), ...said(wrote) });
		if (!wrote.leftOut.length) {
			return {
				status: "written",
				hasMore: wrote.hasMore,
				writtenKeys: [
					...wrote.changes.map((change) => `${change.n}:${change.version}`),
					...wrote.immutableArchives.map((key) => `archive:${key}`),
				],
			};
		}
		this.#report({
			event: "code-change-error",
			step: "files",
			where: "pass",
			...named(target),
			changes: wrote.leftOut,
			error: new Error(LEFT_OUT),
		});
		return { status: "failed", hasMore: false, writtenKeys: [] };
	}

	#rememberArchives(keys: readonly string[]): void {
		for (const key of keys) {
			if (this.#writtenArchives.size >= CODE_CHANGE_ARCHIVE_CACHE_MAX) {
				const oldest = this.#writtenArchives.values().next().value;
				if (oldest !== undefined) this.#writtenArchives.delete(oldest);
			}
			this.#writtenArchives.add(key);
		}
	}

	async #archivesFor(
		writer: CodeHostJob,
		repository: CloudCodingRepository,
		target: CodeChangeTarget,
		due: ReturnType<typeof filesOf>,
		signal: AbortSignal,
	): Promise<{
		files: CodeChangeArchiveFile[];
		immutableKeys: string[];
		moreArchives: boolean;
		incomplete: boolean;
	}> {
		if (!due.index) return { files: [], immutableKeys: [], moreArchives: false, incomplete: false };
		const total = Math.max(due.index.lines.length, whole(due.index.total, 0) ? due.index.total : 0);
		const ranges = codeChangeArchiveRanges(total);
		if (!ranges.length) return { files: [], immutableKeys: [], moreArchives: false, incomplete: false };
		const keyOf = (name: string) => `${target.environmentId}/${target.owner}/${target.name}/${name}`;
		const uncached = ranges.filter((range) => !(range.immutable && this.#writtenArchives.has(keyOf(range.name))));
		if (uncached.some((range) => range.immutable)) {
			try {
				const onDisk = await this.#listArchives(writer, repository);
				const foundKeys: string[] = [];
				for (const range of uncached) {
					if (range.immutable && onDisk.has(range.name)) foundKeys.push(keyOf(range.name));
				}
				if (foundKeys.length) this.#rememberArchives(foundKeys);
			} catch (error) {
				if (signal.aborted) throw error;
				this.#report({ event: "code-change-error", step: "archive-list", ...named(target), error });
			}
		}
		const pending = uncached.filter((range) => !(range.immutable && this.#writtenArchives.has(keyOf(range.name))));
		if (!pending.length) return { files: [], immutableKeys: [], moreArchives: false, incomplete: false };
		const batch = pending.slice(0, CODE_CHANGE_ARCHIVES_PER_JOB);
		const moreArchives = pending.length > batch.length;
		const known = new Map<number, CodeChangeLine>();
		for (const change of due.changes) {
			known.set(change.n, {
				n: change.n,
				createdAt: change.createdAt,
				state: change.state,
				kind: change.kind,
				line: change.notice ?? change.title,
			});
		}
		for (const line of due.index.lines) known.set(line.n, line);
		const files: CodeChangeArchiveFile[] = [];
		const immutableKeys: string[] = [];
		let incomplete = false;
		for (const range of batch) {
			const cacheKey = keyOf(range.name);
			const targetEnd = Math.min(range.end, total);
			let missingStart: number | null = null;
			const missing: { from: number; to: number }[] = [];
			for (let n = range.start; n <= targetEnd; n += 1) {
				if (!known.has(n)) {
					if (missingStart === null) missingStart = n;
				} else if (missingStart !== null) {
					missing.push({ from: missingStart, to: n - 1 });
					missingStart = null;
				}
			}
			if (missingStart !== null) missing.push({ from: missingStart, to: targetEnd });
			let fetchedOk = true;
			for (const span of missing) {
				for (let from = span.from; from <= span.to; from += CODE_CHANGE_ARCHIVE_SLICE) {
					const to = Math.min(span.to, from + CODE_CHANGE_ARCHIVE_SLICE - 1);
					try {
						const answer = await this.#call(
							CODE_CHANGE_RPCS[3],
							{
								p_owner: this.#owner,
								p_machine_id_sha256: this.#machineIdSha256,
								p_environment_id: target.environmentId,
								p_repository_owner: target.owner,
								p_name: target.name,
								p_from: from,
								p_to: to,
							},
							signal,
						);
						for (const line of archiveLinesOf(answer, target)) known.set(line.n, line);
					} catch (error) {
						if (signal.aborted) throw error;
						this.#report({ event: "code-change-error", step: "archive", ...named(target), error });
						fetchedOk = false;
						incomplete = true;
						break;
					}
				}
				if (!fetchedOk) break;
			}
			if (!fetchedOk) continue;
			const bucketLines: CodeChangeLine[] = [];
			for (let n = range.start; n <= targetEnd; n += 1) {
				const found = known.get(n);
				if (found) bucketLines.push(found);
			}
			if (!bucketLines.length) continue;
			files.push({
				name: range.name,
				text: codeChangeArchiveText(target, range.start, range.end, bucketLines, range.immutable),
				immutable: range.immutable,
			});
			if (range.immutable) immutableKeys.push(cacheKey);
		}
		return { files, immutableKeys, moreArchives, incomplete };
	}

	/** Inside a job: asks what is due, renders it and has the code host write it. Answers what was written, or undefined
	 * when nothing was due. `limits`: how many changes to ask for, and then for how many when that answer could not be
	 * read. */
	async #writeDue(
		job: CodeHostJob,
		target: CodeChangeTarget,
		signal: AbortSignal,
		limits: readonly number[],
	): Promise<Written | undefined> {
		let asked = this.#changes;
		let answer: unknown;
		for (const [at, limit] of limits.entries()) {
			asked = Math.min(limit, this.#changes);
			try {
				answer = await this.#call(
					CODE_CHANGE_RPCS[1],
					{
						p_owner: this.#owner,
						p_machine_id_sha256: this.#machineIdSha256,
						p_environment_id: target.environmentId,
						p_repository_owner: target.owner,
						p_name: target.name,
						p_limit: asked,
					},
					signal,
				);
				break;
			} catch (error) {
				// Only an answer that did not come is asked for again: not one the kernel rolled back, nor at the end.
				if (signal.aborted || error instanceof CodingControlBusy || at === limits.length - 1 || limit <= 1)
					throw error;
			}
		}
		const due = filesOf(answer, target, asked);
		if (due.changes.length === 0 && due.index === null) return undefined;
		const repository: CloudCodingRepository = parseCloudCodingRepository({
			host: "qorpera",
			owner: target.owner,
			name: target.name,
			baseBranch: "main",
		});
		// The record's own copy of the picture a session committed, from git.
		const copy = (change: CodeChangeFile) =>
			change.picture?.source === "commit" ? { picture: { blob: change.picture.blob, to: change.picture.at } } : {};
		const records = due.changes.map(
			(change): CodeChangeRecordFile =>
				// A row that has both ends of main and no files yet: the job finds what differs, and the text is made with it.
				diffDue(change) && change.mainBefore !== null && change.mainAfter !== null
					? {
							n: change.n,
							text: (diff) => codeChangeRecordText(change, codeChangeDiffOf(diff)),
							diff: { before: change.mainBefore, after: change.mainAfter },
							...copy(change),
						}
					: { n: change.n, text: codeChangeRecordText(change), ...copy(change) },
		);
		const index = due.index
			? codeChangeIndexText(
					target,
					due.index.lines,
					{
						live: due.index.live,
						ready: due.index.ready,
						imported: due.index.imported,
						preparing: due.index.preparing,
						takenDown: due.index.takenDown,
						...(due.index.total === undefined ? {} : { total: due.index.total }),
					},
					this.#now(),
				)
			: null;
		const writer: CodeHostJob = {
			shell: job.shell,
			layout: job.layout,
			signal,
			...(job.preparedKeptArea === undefined ? {} : { preparedKeptArea: job.preparedKeptArea }),
		};
		const {
			files: archives,
			immutableKeys: immutableArchives,
			moreArchives,
			incomplete: incompleteArchives,
		} = await this.#archivesFor(writer, repository, target, due, signal);
		const wrote = await this.#write(writer, {
			repository,
			records,
			index,
			...(archives.length ? { archives } : {}),
		});
		const held = new Set(Array.isArray(wrote?.written) ? wrote.written : []);
		const without = due.changes.filter((change) => diffDue(change) && !held.has(change.n));
		if (without.length) {
			const again = await this.#write(
				{ ...writer, preparedKeptArea: codeAreaPath(repository) },
				{
					repository,
					records: without.map((change) => ({ n: change.n, text: codeChangeRecordText(change), ...copy(change) })),
					index: null,
				},
			);
			for (const n of Array.isArray(again?.written) ? again.written : []) held.add(n);
		}
		const found = new Map<number, CodeChangeDiff>();
		for (const entry of Array.isArray(wrote?.diffs) ? wrote.diffs : []) {
			const diff = codeChangeDiffOf(entry);
			if (diff && whole(entry?.n, 1)) found.set(entry.n, diff);
		}
		return {
			changes: due.changes
				.filter((change) => held.has(change.n))
				.map((change) => {
					const diff = diffDue(change) ? found.get(change.n) : undefined;
					return { n: change.n, version: change.version, ...(diff ? { diff } : {}) };
				}),
			indexVersion: moreArchives || incompleteArchives ? null : (due.index?.version ?? null),
			leftOut: due.changes.filter((change) => !held.has(change.n)).map((change) => change.n),
			hasMore: due.hasMore || moreArchives,
			immutableArchives,
		};
	}

	async #written(
		target: CodeChangeTarget,
		wrote: Written,
		problem: string | null,
		tries: number,
		signal: AbortSignal,
	): Promise<boolean> {
		const parts: Record<string, unknown>[][] = [[]];
		let size = 0;
		for (const { n, version, diff } of wrote.changes) {
			const entry = { n, version, ...(diff ? codeChangeDiffReported(diff) : {}) };
			const entrySize = bytes(JSON.stringify(entry)) + 1;
			const current = parts.at(-1) as Record<string, unknown>[];
			if (current.length > 0 && (size + entrySize > WRITTEN_BYTES || current.length >= CODE_CHANGE_MAX_BATCH)) {
				parts.push([]);
				size = 0;
			}
			parts.at(-1)?.push(entry);
			size += entrySize;
		}
		for (const [at, changes] of parts.entries()) {
			const told = await this.#told(
				target,
				{ changes, indexVersion: at === parts.length - 1 ? wrote.indexVersion : null, problem },
				tries,
				signal,
			);
			if (!told) return false;
		}
		return true;
	}

	/** One `qorpera_code_change_files_written`, asked `tries` times while no answer comes. */
	async #told(
		target: CodeChangeTarget,
		written: Record<string, unknown>,
		tries: number,
		signal: AbortSignal,
	): Promise<boolean> {
		let failure: unknown;
		for (let tried = 0; tried < tries && !signal.aborted; tried++) {
			try {
				const answer = await this.#call(
					CODE_CHANGE_RPCS[2],
					{
						p_owner: this.#owner,
						p_machine_id_sha256: this.#machineIdSha256,
						p_environment_id: target.environmentId,
						p_repository_owner: target.owner,
						p_name: target.name,
						p_written: written,
					},
					signal,
				);
				if (isRecord(answer) && answer.schema === "qorpera.code-change-files-written/v1") {
					if (answer.state === "recorded") return true;
					// This executor does not hold the company any more, or nobody registered the repository: nothing was
					// recorded, and asking again would change nothing.
					if (answer.state === "lost") {
						failure = new Error("CODE_CHANGE_WRITTEN_LOST");
						break;
					}
				}
				failure = new Error("CODE_CHANGE_WRITTEN_UNCONFIRMED");
			} catch (error) {
				failure = error;
			}
		}
		if (failure !== undefined && !signal.aborted)
			this.#report({ event: "code-change-error", step: "written", ...named(target), error: failure });
		return false;
	}

	#call(method: (typeof CODE_CHANGE_RPCS)[number], args: Record<string, unknown>, signal: AbortSignal) {
		return this.#control.call(method, args, AbortSignal.any([signal, AbortSignal.timeout(CALL_MS)]));
	}
}

function named(target: CodeChangeTarget): Record<string, unknown> {
	return {
		companyId: target.companyId,
		environmentId: target.environmentId,
		repository: `${target.owner}/${target.name}`,
	};
}
function said(wrote: Written): Record<string, unknown> {
	return { changes: wrote.changes.map((change) => change.n), index: wrote.indexVersion !== null };
}
