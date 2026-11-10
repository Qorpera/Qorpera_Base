import { type CloudCodingRepository, isUuid, parseCloudCodingRepository } from "@qorpera/contracts";
import { withAbortScope } from "./abort-scope.ts";
import {
	type CodeChangeDiff,
	type CodeChangePath,
	type CodeChangeRecordFile,
	type CodeHostJob,
	CodeHostJobFailure,
	CodeHostRefusal,
	type writeCodeChangeRecords,
} from "./code-host-jobs.ts";
import type { CodeHostJobs } from "./code-host-views.ts";
import { CodingControlBusy } from "./coding-executor.ts";

/** The change record's files (own code storage, step 2b): the coding executor's side. The kernel keeps a numbered row
 * for every movement of a repository's main, and for every landing that was refused (`qorpera_code_changes`, migration
 * `20260930720000`). Each row has a file, `code/<owner>/<name>/changes/<n>.md`, and the newest hundred are listed in
 * `changes/index.md`. The kernel says which are due and what they hold; this renders them; a code host job writes them:
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
	kind: "landing" | "undo" | "restore" | "found";
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
const KINDS = ["landing", "undo", "restore", "found"];
const STATES = ["landed", "reverted", "conflict", "refused", "lost"];
const CHANGES = ["added", "changed", "removed"];
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
		default:
			return "a change whose record was lost";
	}
}

const PICTURE_PROBLEMS: Readonly<Record<string, string>> = {
	missing: "not found",
	not_a_file: "not a file",
	too_large: "too large",
	not_a_picture: "not a picture",
	not_shared: "not in the company's shared folders",
};
/** What the words under a change are called: a session's report, or why somebody undid or restored. */
const SAID: Readonly<Record<CodeChangeFile["kind"], string>> = {
	landing: "What the session said",
	undo: "Why it was undone",
	restore: "Why it was restored",
	found: "What was said",
};

/** The record's text for one change of `qorpera.code-change-files/v1`: Markdown, UTF-8, at most 24 KiB. Pure. With
 * `diff`, the files are the ones the job found between the change's two ends of main (a row that had none yet).
 *
 * What a session, an agent or a member wrote never becomes a line of the file's own. Their sentences (what a customer
 * will notice, what the session said, why a change was undone) are quoted line by line. A title is one line with
 * every Markdown character written out. A path is code. And no line holds a control character. */
export function codeChangeRecordText(change: CodeChangeFile, diff?: CodeChangeDiff): string {
	const filesChanged = diff ? diff.filesChanged : change.filesChanged;
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
	];
	const notice = change.notice === null ? null : quoted(change.notice, 1000);
	const problem = change.pictureProblem === null ? undefined : PICTURE_PROBLEMS[change.pictureProblem];
	const picture = change.picture
		? code(change.picture.source === "commit" ? change.picture.at : change.picture.path, 800)
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
		"",
		"## What a customer will notice",
		"",
		notice ?? "Nothing was said.",
		"",
		"## Picture",
		"",
		picture,
		...(said === null ? [] : ["", `## ${SAID[change.kind]}`, "", said]),
		...(why.length ? ["", "## Why it did not go in", "", ...why] : []),
	];
	const paths = diff ? diff.paths : change.paths;
	if (paths !== null) {
		// The files get what the rest of the record left of its 24 KiB: every part above has a bound of its own (a path
		// as code may be three times its bytes, when it is all backticks), and together they stay under 21 KiB.
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

/** The list's text, `changes/index.md`: the newest changes, one line each, newest first, at most a hundred. Pure. Each
 * line's words (what a customer will notice, or the title) are one line of at most 200 bytes with every Markdown
 * character written out. */
export function codeChangeIndexText(
	repository: { owner: string; name: string },
	lines: readonly CodeChangeLine[],
): string {
	const newest = [...lines].sort((a, b) => b.n - a.n).slice(0, 100);
	return `${[
		`# Changes in ${words(`${repository.owner}/${repository.name}`, 200)}`,
		"",
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
): { changes: CodeChangeFile[]; index: { version: number; lines: CodeChangeLine[] } | null } {
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
	// The kernel names no company: this executor does not hold it, or nobody registered the repository. Nothing is due
	// here.
	if (named.companyId === null) return { changes: [], index: null };
	const index = answer.index;
	if (index !== null && !(isRecord(index) && whole(index.version) && Array.isArray(index.lines)))
		throw new Error("CODE_CHANGE_FILES_UNCONFIRMED");
	return {
		changes: answer.changes.slice(0, limit).map((change) => changeOf(change, target)),
		index:
			index === null ? null : { version: index.version as number, lines: (index.lines as unknown[]).map(lineOf) },
	};
}

// The writer ---------------------------------------------------------------------------------------------------------

export interface CodeChangeRecordsOptions {
	control: { call(method: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> };
	/** The executor's code host jobs, with the `yields` option. */
	hosts: Pick<CodeHostJobs, "run">;
	/** `writeCodeChangeRecords` of `code-host-jobs.ts`, as it is. */
	write: typeof writeCodeChangeRecords;
	owner: string;
	machineIdSha256: string;
	/** The log lines `code-change` and `code-change-error` (whose `error` is the error itself, for the log to redact). */
	report?: (event: Record<string, unknown>) => void;
	/** How many due repositories one pass takes, 1 to 50. Default 20. */
	limit?: number;
	/** How many changes one job writes, 1 to 20. Default 20. */
	changes?: number;
}

/** Whether the job that writes a change's file is to find what differs between its two ends of main first. Never for a
 * row a restore went back past, nor for a restore's own row: the repository may no longer hold one of its ends, and
 * the job leaves a record unwritten whose commits are gone. (The kernel says the same; this holds without it.) */
function diffDue(change: CodeChangeFile): boolean {
	return change.needsDiff && change.state !== "lost" && change.kind !== "restore";
}

/** What one job wrote, for the kernel to be told once the job has saved. `leftOut`: a record the job was handed and
 * did not write, which stays due; the kernel is told of it as a problem, so that it waits before it names the
 * repository again. */
interface Written {
	changes: { n: number; version: number; diff?: CodeChangeDiff }[];
	indexVersion: number | null;
	leftOut: number[];
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
	readonly #owner: string;
	readonly #machineIdSha256: string;
	readonly #report: (event: Record<string, unknown>) => void;
	readonly #limit: number;
	readonly #changes: number;

	constructor(options: CodeChangeRecordsOptions) {
		const limit = options.limit ?? 20,
			changes = options.changes ?? 20;
		if (
			typeof options.owner !== "string" ||
			!options.owner ||
			typeof options.machineIdSha256 !== "string" ||
			!/^[0-9a-f]{64}$/.test(options.machineIdSha256) ||
			typeof options.write !== "function" ||
			!whole(limit, 1) ||
			limit > 50 ||
			!whole(changes, 1) ||
			changes > 20
		)
			throw new Error("INVALID_CODE_CHANGE_RECORDS");
		this.#control = options.control;
		this.#hosts = options.hosts;
		this.#write = options.write;
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

	/** One pass: every repository with a file due, each in a code host job of its own that yields to a turn's. It never
	 * throws for one repository, nor for a kernel that does not answer: those are reported (`code-change-error`).
	 * `written` counts the repositories whose due files were written and the kernel told, `failed` those whose job or
	 * calls failed, or whose job left a record out; the kernel is told of a failure, and waits longer before it names
	 * that repository again. One whose job gave way to a turn, or found nothing due any more, is in neither. */
	async pass(signal: AbortSignal): Promise<{ written: number; failed: number }> {
		const counts = { written: 0, failed: 0 };
		// The pass's signal may live as long as the process: it is handed to no `AbortSignal.any` (abort-scope.ts).
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
				const ended = await this.#repository(target, scoped);
				if (ended) counts[ended] += 1;
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
	async #repository(target: CodeChangeTarget, signal: AbortSignal): Promise<"written" | "failed" | undefined> {
		let wrote: Written | undefined;
		try {
			wrote = await this.#hosts.run(
				target.companyId,
				target.environmentId,
				signal,
				// An answer too large for the control to take (many long rows at once) is asked for again in smaller parts.
				(job) => this.#writeDue(job, target, job.signal, [this.#changes, 5, 1]),
				{ yields: true },
			);
		} catch (error) {
			// A turn's job joined the line, the kernel's rows were busy, or the pass was stopped: nothing was saved, and
			// nothing failed. The files stay due.
			if (
				signal.aborted ||
				(error instanceof CodeHostJobFailure && error.code === YIELDED) ||
				error instanceof CodingControlBusy
			)
				return undefined;
			this.#report({ event: "code-change-error", step: "files", where: "pass", ...named(target), error });
			// The kernel counts the failure and names the repository again after a pause that doubles.
			await this.#written(
				target,
				{ changes: [], indexVersion: null, leftOut: [] },
				codeChangeErrorCode(error),
				1,
				signal,
			);
			return "failed";
		}
		if (!wrote) return undefined;
		if (!(await this.#written(target, wrote, wrote.leftOut.length ? LEFT_OUT : null, 2, signal))) return "failed";
		this.#report({ event: "code-change", step: "written", where: "pass", ...named(target), ...said(wrote) });
		if (!wrote.leftOut.length) return "written";
		this.#report({
			event: "code-change-error",
			step: "files",
			where: "pass",
			...named(target),
			changes: wrote.leftOut,
			error: new Error(LEFT_OUT),
		});
		return "failed";
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
		const index = due.index ? codeChangeIndexText(target, due.index.lines) : null;
		const writer = { shell: job.shell, layout: job.layout, signal };
		const wrote = await this.#write(writer, { repository, records, index });
		// The job names the records whose file now holds its text, also one that held it already. It leaves out a record
		// whose two ends of main the repository no longer holds (a restore went back past them): that one is written
		// once more, without its files, or it would stay due for good.
		const held = new Set(Array.isArray(wrote?.written) ? wrote.written : []);
		const without = due.changes.filter((change) => diffDue(change) && !held.has(change.n));
		if (without.length) {
			const again = await this.#write(writer, {
				repository,
				records: without.map((change) => ({ n: change.n, text: codeChangeRecordText(change), ...copy(change) })),
				index: null,
			});
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
			indexVersion: due.index?.version ?? null,
			leftOut: due.changes.filter((change) => !held.has(change.n)).map((change) => change.n),
		};
	}

	/** Tells the kernel which files are written, or of a problem that left them due. Answers whether it heard; an
	 * answer that did not come is reported, and the files stay due. Rows whose diffs together would pass what one call
	 * carries are told in several calls, the list's version with the last. */
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
			if (size + entrySize > WRITTEN_BYTES && parts.at(-1)?.length) {
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
