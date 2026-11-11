import type { CodeCommitEntry } from "./code-host-jobs.ts";
import { CodingJsonSyntaxError, parseCodingJson } from "./coding-setup.ts";

// Stand-in for part B (code-host-jobs.ts) until it is merged. Then this block becomes
// `export { CODE_CHECKS_FILE } from "./code-host-jobs.ts";` and `CodeCommitFile` joins the type import above.
/** Where a repository keeps its checks, read from git at one commit. */
export const CODE_CHECKS_FILE = ".qorpera/checks.json";
/** A path of one commit, as git holds it: its entry (a file's bytes cut after maxBytes + 1), and its blob's id when it
 * is a regular file. */
export interface CodeCommitFile {
	entry: CodeCommitEntry;
	blob: string | null;
}
// End of the stand-in for part B.

/** A repository's checks (own code storage, step 3): the commands Qorpera runs on a clean copy of what would go into
 * its default branch, before it goes in. This file holds what is pure of them: the checks file's rules, the gate, the
 * row's value for a run that passed, and the words a failed turn reports. */

export const MAX_CODE_CHECKS_FILE_BYTES = 16 * 1024;
export const MAX_CODE_CHECKS = 20;
export const CODE_CHECK_DEFAULT_SECONDS = 600;
export const CODE_CHECK_MAX_SECONDS = 1800;
export const CODE_CHECKS_TOTAL_SECONDS = 3600;
const CODE_CHECK_MIN_SECONDS = 10;
const MAX_RUN_BYTES = 4096;
const MAX_CWD_BYTES = 300;

/** One check: `run` is a bash command run from `cwd`, a folder of the repository ("." is its top). */
export interface CodeCheck {
	readonly name: string;
	readonly run: string;
	readonly timeoutSeconds: number;
	readonly cwd: string;
}

/** One problem with the checks file. Any problem refuses the whole file. */
export interface CodeChecksProblem {
	/** A JSON pointer into the file; "" is the whole file. */
	readonly at: string;
	readonly code: string;
	readonly message: string;
}

export type CodeChecksRead =
	| { readonly state: "missing" }
	| { readonly state: "ok"; readonly blob: string; readonly checks: readonly CodeCheck[] }
	/** `blob` is null when the path holds no regular file (a folder, a link or a submodule). */
	| { readonly state: "refused"; readonly blob: string | null; readonly problems: readonly CodeChecksProblem[] };

/** What a change changed in the checks, by name: only in the candidate, only in main, and in both with another `run`,
 * `cwd` or `timeoutSeconds`. */
export interface CodeChecksChanged {
	readonly added: string[];
	readonly removed: string[];
	readonly run: string[];
}

export type CodeChecksGate =
	| {
			readonly gate: "run";
			readonly checks: readonly CodeCheck[];
			readonly blob: string;
			readonly changed: CodeChecksChanged | null;
	  }
	| { readonly gate: "refused"; readonly summary: string };

/** One run of the checks on one candidate. `run` strings are cut to 200 bytes; `tail` is `codeChecksTail` of the
 * failing check's masked output; `log` is the path of its whole output on the session's machine. */
export type CodeChecksRun =
	| { state: "passed"; ms: number; copyMs: number; checks: { name: string; run: string; ms: number }[] }
	| {
			state: "failed";
			ms: number;
			passed: { name: string; ms: number }[];
			failed: {
				name: string;
				run: string;
				ms: number;
				exitCode: number | null;
				atLimit: boolean;
				tail: string;
				log: string;
			};
			notRun: string[];
	  }
	| { state: "not_run"; why: "copy" | "machine" | "transport" | "authority" | "budget"; code: string };

const NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const SHA = /^[0-9a-f]{40}$/;
const UNKNOWN = "This key is not in the checks file's schema.";

type Refuse = (at: string, code: string, message: string) => void;

/** The checks file as git holds it at one commit, read under its rules: JSON with comments and no trailing commas
 * (the setup file's reader), one object whose only keys are `$schema` and `checks`; 1 to 20 checks, each with a unique
 * name, a command of 1 to 4096 bytes without NUL, a time limit of 10 to 1800 s (600 when left out) and a folder of the
 * repository ("." when left out); the limits at most 3600 s together. A file that breaks any rule is refused whole,
 * with every problem found. */
export function readCodeChecks(file: CodeCommitFile): CodeChecksRead {
	const entry = file.entry;
	if (entry.kind === "missing") return { state: "missing" };
	if (entry.kind === "other")
		return {
			state: "refused",
			blob: null,
			problems: [
				{
					at: "",
					code: "NOT_A_FILE",
					message: "The checks file is not a regular file (a folder, a symlink or a submodule).",
				},
			],
		};
	const blob = file.blob;
	if (typeof blob !== "string" || !SHA.test(blob)) throw new Error("INVALID_CODE_COMMIT_FILE");
	const problems: CodeChecksProblem[] = [];
	const checks = parseChecks(entry.bytes, (at, code, message) => problems.push({ at, code, message }));
	if (problems.length > 0 || checks === null) return { state: "refused", blob, problems };
	return { state: "ok", blob, checks };
}

function parseChecks(bytes: Uint8Array, refuse: Refuse): CodeCheck[] | null {
	if (bytes.byteLength > MAX_CODE_CHECKS_FILE_BYTES) {
		refuse("", "TOO_LARGE", "The checks file is over 16 KiB.");
		return null;
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		refuse("", "NOT_UTF8", "The checks file is not UTF-8 text.");
		return null;
	}
	let root: unknown;
	try {
		root = parseCodingJson(text, false);
	} catch (error) {
		if (!(error instanceof CodingJsonSyntaxError)) throw error;
		const before = text.slice(0, error.index);
		const line = before.split("\n").length;
		const column = error.index - before.lastIndexOf("\n");
		refuse("", "SYNTAX", `Line ${line}, column ${column}: ${error.message}`);
		return null;
	}
	if (!isObject(root)) {
		refuse("", "WRONG_TYPE", "The checks file must hold one JSON object.");
		return null;
	}
	let checks: CodeCheck[] = [];
	for (const [key, value] of Object.entries(root)) {
		const at = pointer("", key);
		if (key === "$schema") {
			if (typeof value !== "string") refuse(at, "WRONG_TYPE", "Must be a string.");
		} else if (key === "checks") checks = checksOf(value, at, refuse);
		else refuse(at, "UNKNOWN_KEY", UNKNOWN);
	}
	if (!("checks" in root)) refuse("", "MISSING_KEY", "Needs checks.");
	return checks;
}

function checksOf(value: unknown, at: string, refuse: Refuse): CodeCheck[] {
	if (!Array.isArray(value)) {
		refuse(at, "WRONG_TYPE", "Must be an array.");
		return [];
	}
	if (value.length < 1 || value.length > MAX_CODE_CHECKS)
		refuse(at, "INVALID_VALUE", `Must hold 1 to ${MAX_CODE_CHECKS} checks.`);
	const checks: CodeCheck[] = [];
	const names = new Set<string>();
	let total = 0;
	for (const [index, item] of value.entries()) {
		const itemAt = pointer(at, index);
		if (!isObject(item)) {
			refuse(itemAt, "WRONG_TYPE", "Must be an object.");
			continue;
		}
		let name: string | null = null;
		let run: string | null = null;
		let timeoutSeconds = CODE_CHECK_DEFAULT_SECONDS;
		let cwd = ".";
		for (const [key, field] of Object.entries(item)) {
			const fieldAt = pointer(itemAt, key);
			if (key === "name") {
				if (typeof field !== "string") refuse(fieldAt, "WRONG_TYPE", "Must be a string.");
				else if (!NAME.test(field))
					refuse(
						fieldAt,
						"INVALID_VALUE",
						"Must be 1 to 40 of a-z, 0-9, '.', '_' and '-', starting with a letter or a digit.",
					);
				else if (names.has(field)) refuse(fieldAt, "DUPLICATE", `The name "${field}" is given twice.`);
				else {
					names.add(field);
					name = field;
				}
			} else if (key === "run") {
				if (typeof field !== "string") refuse(fieldAt, "WRONG_TYPE", "Must be a string.");
				else if (field === "" || bytes(field) > MAX_RUN_BYTES || field.includes("\0"))
					refuse(fieldAt, "INVALID_VALUE", `Must be 1 to ${MAX_RUN_BYTES} bytes, without a NUL character.`);
				else run = field;
			} else if (key === "timeoutSeconds") {
				if (
					typeof field !== "number" ||
					!Number.isInteger(field) ||
					field < CODE_CHECK_MIN_SECONDS ||
					field > CODE_CHECK_MAX_SECONDS
				)
					refuse(
						fieldAt,
						"INVALID_VALUE",
						`Must be a whole number of seconds from ${CODE_CHECK_MIN_SECONDS} to ${CODE_CHECK_MAX_SECONDS}.`,
					);
				else timeoutSeconds = field;
			} else if (key === "cwd") {
				if (typeof field !== "string") refuse(fieldAt, "WRONG_TYPE", "Must be a string.");
				else if (!isFolder(field))
					refuse(
						fieldAt,
						"INVALID_PATH",
						`Must be a folder of the repository: a relative path without . or .. parts, at most ${MAX_CWD_BYTES} bytes.`,
					);
				else cwd = field;
			} else refuse(fieldAt, "UNKNOWN_KEY", UNKNOWN);
		}
		if (!("name" in item)) refuse(itemAt, "MISSING_KEY", "Needs name.");
		if (!("run" in item)) refuse(itemAt, "MISSING_KEY", "Needs run.");
		total += timeoutSeconds;
		if (name !== null && run !== null) checks.push({ name, run, timeoutSeconds, cwd });
	}
	if (total > CODE_CHECKS_TOTAL_SECONDS)
		refuse(
			at,
			"TOO_LONG",
			`The time limits add up to ${total} s; all checks together may take at most ${CODE_CHECKS_TOTAL_SECONDS} s.`,
		);
	return checks;
}

/** "." (the top), or a relative path of the repository with no empty, `.` or `..` part (so no leading or trailing `/`
 * either), no control character and no backslash. */
function isFolder(path: string): boolean {
	if (path === ".") return true;
	if (bytes(path) > MAX_CWD_BYTES) return false;
	for (let index = 0; index < path.length; index++) {
		const code = path.charCodeAt(index);
		if (code < 0x20 || code === 0x7f || code === 0x5c) return false;
	}
	return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** The gate (a `to-check` answer: at least one of the two reads is not missing). A candidate whose file is valid runs
 * its checks, whatever main has. A repository that has a checks file keeps one: a candidate with no regular file there
 * is refused. A candidate whose file has problems is refused with them. */
export function codeChecksGate(main: CodeChecksRead, candidate: CodeChecksRead): CodeChecksGate {
	if (candidate.state === "ok")
		return {
			gate: "run",
			checks: candidate.checks,
			blob: candidate.blob,
			changed: changedOf(main.state === "ok" ? main.checks : [], candidate.checks),
		};
	if (main.state === "missing" && candidate.state === "missing") throw new Error("CODE_CHECKS_NOTHING_TO_CHECK");
	return { gate: "refused", summary: codeChecksRefusedSummary(candidate, main.state !== "missing") };
}

/** Against main's valid file (else every check counts as added). Null when nothing changed. */
function changedOf(main: readonly CodeCheck[], candidate: readonly CodeCheck[]): CodeChecksChanged | null {
	const before = new Map(main.map((check) => [check.name, check]));
	const after = new Set(candidate.map((check) => check.name));
	const added: string[] = [];
	const run: string[] = [];
	for (const check of candidate) {
		const was = before.get(check.name);
		if (!was) added.push(check.name);
		else if (was.run !== check.run || was.cwd !== check.cwd || was.timeoutSeconds !== check.timeoutSeconds)
			run.push(check.name);
	}
	const removed = main.filter((check) => !after.has(check.name)).map((check) => check.name);
	return added.length > 0 || removed.length > 0 || run.length > 0 ? { added, removed, run } : null;
}

// The row's value -----------------------------------------------------------------------------------------------------

const MAX_PASSED_RUN_BYTES = 200;
/** The row's `checks` is at most 8 KiB as Postgres stores it (`pg_column_size`). */
const MAX_PASSED_ROW_BYTES = 8192;

/** The change row's `checks` for a run that passed on `commit` (the row's `main_after`; `blob` is the checks file's
 * blob there). Each `run` is cut to 200 bytes at whole characters. A file's checks always fit the row so; were the
 * value still over 8 KiB, every `run` is cut shorter until it fits. A value the row cannot hold throws. */
export function codeChecksPassed(value: {
	commit: string;
	how: "fast-forward" | "merged";
	blob: string;
	run: Extract<CodeChecksRun, { state: "passed" }>;
	changed: CodeChecksChanged | null;
	tries: 1 | 2;
}): Record<string, unknown> {
	const { commit, how, blob, run, changed, tries } = value;
	const names = (list: readonly string[], least: number) =>
		list.length >= least && list.length <= MAX_CODE_CHECKS && list.every((name) => NAME.test(name));
	if (
		!SHA.test(commit) ||
		!SHA.test(blob) ||
		(how !== "fast-forward" && how !== "merged") ||
		(tries !== 1 && tries !== 2) ||
		!names(
			run.checks.map((check) => check.name),
			1,
		) ||
		(changed !== null && !(names(changed.added, 0) && names(changed.removed, 0) && names(changed.run, 0)))
	)
		throw new Error("INVALID_CODE_CHECKS_RESULT");
	for (const limit of [MAX_PASSED_RUN_BYTES, 100, 50, 20, 4]) {
		const result = {
			schema: "qorpera.code-checks/v1",
			commit,
			how,
			file: blob,
			ms: millis(run.ms),
			copyMs: millis(run.copyMs),
			checks: run.checks.map((check) => ({ name: check.name, run: cut(check.run, limit), ms: millis(check.ms) })),
			changed: changed && { added: [...changed.added], removed: [...changed.removed], run: [...changed.run] },
			tries,
		};
		// The datum's own 4-byte length, then the value.
		if (4 + jsonbBytes(result) <= MAX_PASSED_ROW_BYTES) return result;
	}
	throw new Error("INVALID_CODE_CHECKS_RESULT");
}

/** At least as many bytes as Postgres's jsonb takes for `value`, counting each part at its largest: a container's
 * header, its alignment and its entry in its parent, each key's entry and bytes, a string's bytes as they are (no
 * escapes), and a number as a numeric of up to 16 digits. */
function jsonbBytes(value: unknown): number {
	if (typeof value === "string") return 4 + bytes(value);
	if (Array.isArray(value)) return 11 + value.reduce((sum: number, item) => sum + jsonbBytes(item), 0);
	if (isObject(value))
		return 11 + Object.entries(value).reduce((sum, [key, item]) => sum + 4 + bytes(key) + jsonbBytes(item), 0);
	// A number: its entry, alignment, a 4-byte length, the numeric's header and four base-10000 digits.
	return 4 + 3 + 4 + 2 + 8;
}

function millis(ms: number): number {
	return Number.isFinite(ms) && ms > 0 ? Math.min(Math.round(ms), Number.MAX_SAFE_INTEGER) : 0;
}

/** `text` cut to at most `max` bytes of UTF-8, at a whole character, with no mark. */
function cut(text: string, max: number): string {
	if (bytes(text) <= max) return text;
	let kept = "";
	let used = 0;
	for (const character of text) {
		used += bytes(character);
		if (used > max) break;
		kept += character;
	}
	return kept;
}

// The words of a failed turn --------------------------------------------------------------------------------------------

/** The executor keeps its words within this, so the kernel's round sentence and the results file's line fit the 4,000
 * bytes of a turn's summary. */
const MAX_SUMMARY_BYTES = 3500;
const MAX_TAIL_LINES = 30;
const MAX_TAIL_BYTES = 1500;
const INDENT = "    ";

/** The end of a check's output as the words show it: at most 30 lines and 1,500 bytes of UTF-8, cut at whole lines from
 * the end (a last line that alone is longer keeps its end, after an ellipsis). `\r\n` is a line break; every other
 * control character, a separator some readers break a line at, a mark that turns the direction of text around and
 * half of a surrogate pair are shown as U+FFFD. Each line loses its trailing white space, and the empty lines at
 * either end go. Applied twice, it changes nothing more. */
export function codeChecksTail(output: string): string {
	let clean = "";
	for (const character of output.replaceAll("\r\n", "\n")) {
		const point = character.codePointAt(0) as number;
		clean += character !== "\n" && (halfCharacter(point) || unseen(point)) ? "\uFFFD" : character;
	}
	const lines = clean.split("\n").map((line) => line.trimEnd());
	while (lines.length > 0 && lines.at(-1) === "") lines.pop();
	return lastLines(lines, MAX_TAIL_BYTES, 0).join("\n");
}

/** The last of `lines` (at most 30) that fit `max` bytes, each counted with `pad` bytes more and a line break between,
 * without the empty lines they start with. A last line that alone is over keeps its end. */
function lastLines(lines: readonly string[], max: number, pad: number): string[] {
	const kept: string[] = [];
	let used = 0;
	for (let index = lines.length - 1; index >= 0 && kept.length < MAX_TAIL_LINES; index--) {
		const line = lines[index];
		const size = pad + bytes(line) + (kept.length > 0 ? 1 : 0);
		if (used + size <= max) {
			kept.unshift(line);
			used += size;
			continue;
		}
		if (kept.length === 0) kept.unshift(endOf(line, max - pad));
		break;
	}
	while (kept.length > 0 && kept[0] === "") kept.shift();
	return kept;
}

/** The end of `text` in at most `max` bytes, at a whole character, after an ellipsis. */
function endOf(text: string, max: number): string {
	const characters = Array.from(text);
	let used = bytes("…");
	let from = characters.length;
	while (from > 0) {
		const size = bytes(characters[from - 1]);
		if (used + size > max) break;
		used += size;
		from--;
	}
	return `…${characters.slice(from).join("")}`;
}

/** `CODING_CHECKS_FAILED`: a check of the repository failed on the candidate, so nothing went into main. At most 3,500
 * bytes: the output's end gives up its first lines when the rest needs the room. */
export function codeChecksFailedSummary(
	run: Extract<CodeChecksRun, { state: "failed" }>,
	how: "fast-forward" | "merged",
): string {
	const failed = run.failed;
	const exit = failed.exitCode === null ? "ended without an exit code" : `ended with exit code ${failed.exitCode}`;
	const limit = failed.atLimit ? ", at its time limit" : "";
	const killed = failed.exitCode === 137 && !failed.atLimit ? " (killed, often for lack of memory)" : "";
	const head =
		`Nothing went into main: the check "${shown(failed.name, 40)}" failed on this change` +
		`${how === "merged" ? " merged with main as it is now" : ""}. It ran ${code(failed.run, MAX_PASSED_RUN_BYTES)} ` +
		`and ${exit} after ${Math.round(millis(failed.ms) / 1000)} s${limit}${killed}.`;
	const passed = run.passed.length > 0 ? ` Checks that passed before it: ${namesOf(run.passed)}.` : "";
	const foot =
		`Its whole output is in ${shown(failed.log, 200)} on the session's machine.${passed} Fix the cause in the code, ` +
		"never by removing or weakening the check or its tests; run the checks yourself from a clean copy, commit and " +
		"finish again. [code=CODING_CHECKS_FAILED]";
	const tail = codeChecksTail(failed.tail);
	const before = " The end of its output:\n\n";
	const after = "\n\n";
	const room = MAX_SUMMARY_BYTES - bytes(head) - bytes(before) - bytes(after) - bytes(foot);
	const lines = tail === "" ? [] : lastLines(tail.split("\n"), room, INDENT.length);
	if (lines.length === 0) return `${head} It wrote no output. ${foot}`;
	const block = lines.map((line) => (line === "" ? "" : `${INDENT}${line}`)).join("\n");
	return `${head}${before}${block}${after}${foot}`;
}

/** The names of the checks that passed, comma separated, as many as fit 600 bytes, then how many more. */
function namesOf(checks: readonly { name: string }[]): string {
	const names: string[] = [];
	let used = 0;
	for (const check of checks) {
		const name = shown(check.name, 40);
		if (used + bytes(name) + 2 > 600) break;
		names.push(name);
		used += bytes(name) + 2;
	}
	const more = checks.length - names.length;
	return [...names, ...(more > 0 ? [`and ${more} more`] : [])].join(", ");
}

/** `CODING_CHECKS_REFUSED`: the candidate's checks file is not one Qorpera reads, or is gone from a repository whose
 * main has one. At most 5 problems are named. */
export function codeChecksRefusedSummary(candidate: CodeChecksRead, mainHadFile: boolean): string {
	let what: string;
	if (mainHadFile && (candidate.state === "missing" || (candidate.state === "refused" && candidate.blob === null)))
		what = "is gone in this change, and a repository that has checks keeps them";
	else if (candidate.state === "refused") {
		const named = candidate.problems.slice(0, 5).map((problem) => {
			const message = shown(problem.message, 300).replace(/\.$/, "");
			return problem.at === "" ? message : `${shown(problem.at, 100)}: ${message}`;
		});
		const more = candidate.problems.length - named.length;
		what = `is not as Qorpera reads it: ${[...named, ...(more > 0 ? [`and ${more} more`] : [])].join("; ")}`;
	} else throw new Error("CODE_CHECKS_NOT_REFUSED");
	return `Nothing went into main: the repository's checks file, ${CODE_CHECKS_FILE}, ${what}. Fix the file, commit and finish again. [code=CODING_CHECKS_REFUSED]`;
}

/** `CODING_CHECKS_DID_NOT_RUN`: the checks could not run, which is never the code's fault. */
export function codeChecksNotRunSummary(run: Extract<CodeChecksRun, { state: "not_run" }>): string {
	let why: string;
	switch (run.why) {
		case "machine":
			why = "the session's machine stopped";
			break;
		case "copy":
			why = "the clean copy of the commit could not be made";
			break;
		case "budget":
			why = "the checks ran past the time Qorpera gives them";
			break;
		default:
			why = "the session's machine did not answer";
	}
	return `Nothing went into main: Qorpera could not run the repository's checks on this change (${why}). This is not a fault in the code. The work is kept on the session's branch; finishing again runs the checks again. [code=CODING_CHECKS_DID_NOT_RUN]`;
}

/** `CODING_CHECKS_MAIN_MOVED`: main moved during the run and again during the run made once more. */
export const CODE_CHECKS_MAIN_MOVED =
	"Nothing went into main yet: main changed twice while this change's checks ran, so they never ran on what would go in. This is not a fault in the code. The work is kept on the session's branch; finishing again checks it once more. [code=CODING_CHECKS_MAIN_MOVED]";

/** Whether a line may show the character: not a control (C0, DEL, C1), a separator that some readers break a line at
 * (LS, PS), or a mark that turns the direction of the text after it around. */
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

/** Text from a file or a command as part of one line of the words: every character a line may not show is U+FFFD, and
 * at most `max` bytes, cut at a whole character with an ellipsis. */
function shown(text: string, max: number): string {
	let line = "";
	for (const character of text) {
		const point = character.codePointAt(0) as number;
		line += halfCharacter(point) || unseen(point) ? "\uFFFD" : character;
	}
	return bytes(line) <= max ? line : `${cut(line, max - bytes("…"))}…`;
}

/** A command as Markdown code, its fence longer than any run of backticks inside. */
function code(text: string, max: number): string {
	const inner = shown(text, max);
	const longest = Math.max(0, ...(inner.match(/`+/g) ?? []).map((ticks) => ticks.length));
	const fence = "`".repeat(longest + 1);
	// A reader takes one space off each end of code that has one at both: so one is put there for it to take.
	const pad = /^[ `]|[ `]$/.test(inner) ? " " : "";
	return `${fence}${pad}${inner}${pad}${fence}`;
}

function bytes(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pointer(at: string, key: string | number): string {
	return `${at}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}
