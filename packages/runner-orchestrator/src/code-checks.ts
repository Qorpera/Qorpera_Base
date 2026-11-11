import { CODE_CHECKS_FILE, type CodeCommitFile } from "./code-host-jobs.ts";
import {
	type CodeSiteCollected,
	type CodeSiteProblem,
	codeSiteFolderValid,
	codeSiteNameValid,
	codeSiteTitleValid,
} from "./code-site.ts";
import { bytes, cut, halfCharacter, shown, unseen } from "./code-words.ts";
import { CodingJsonSyntaxError, parseCodingJson } from "./coding-setup.ts";

export { CODE_CHECKS_FILE, type CodeCommitFile };

/** A repository's checks (own code storage, step 3): the commands Qorpera runs on a clean copy of what would go into
 * its default branch, before it goes in. This file holds what is pure of them: the checks file's rules, the gate, the
 * row's value for a run that passed, and the words a failed turn reports. From step 4 the file may also say where the
 * checks leave the repository's website (`site`; its rules and commands are `code-site.ts`'). */

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

/** A repository's website (own code storage, step 4; STEP4-RELEASES-PLAN.md 5.1): the folder of the repository its
 * checks leave the built site in (`.` is its top), the site's name (its link's last part, used once, when the site is
 * made) and its title, each null when the file leaves it out. */
export interface CodeSiteRecipe {
	readonly folder: string;
	readonly name: string | null;
	readonly title: string | null;
}

export type CodeChecksRead =
	| { readonly state: "missing" }
	/** `site` is the file's recipe, null without one. `readCodeChecks` always says it; it is optional only while the
	 * executor's runner (part C2) is not built on it. */
	| {
			readonly state: "ok";
			readonly blob: string;
			readonly checks: readonly CodeCheck[];
			readonly site?: CodeSiteRecipe | null;
	  }
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
			/** The candidate's recipe (null: no site). `codeChecksGate` always says it; optional as `CodeChecksRead`'s. */
			readonly site?: CodeSiteRecipe | null;
	  }
	| { readonly gate: "refused"; readonly summary: string };

/** One run of the checks on one candidate. `run` strings are cut to 200 bytes; `tail` is `codeChecksTail` of the
 * failing check's masked output; `log` is the path of its whole output on the session's machine. A run that passed
 * says what became of the site (step 4): null when there was none to take (no recipe, or sites switched off). */
export type CodeChecksRun =
	| {
			state: "passed";
			ms: number;
			copyMs: number;
			checks: { name: string; run: string; ms: number }[];
			site?: CodeSiteCollected | null;
	  }
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

/** A run whose checks all passed, but whose site the code made wrong (step 4; STEP4-RELEASES-PLAN.md 8.1): nothing goes
 * in, and the turn fails with `codeSiteRefusedSummary`'s words. Part C2 makes it one of `CodeChecksRun`'s answers when
 * its runner gives it, with the landing that reads it. */
export interface CodeChecksSiteRefused {
	state: "site_refused";
	ms: number;
	checks: { name: string; run: string; ms: number }[];
	problem: CodeSiteProblem;
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const SHA = /^[0-9a-f]{40}$/;
const UNKNOWN = "This key is not in the checks file's schema.";

type Refuse = (at: string, code: string, message: string) => void;

/** The checks file as git holds it at one commit, read under its rules: JSON with comments and no trailing commas
 * (the setup file's reader), one object whose only keys are `$schema`, `checks` and `site`; 1 to 20 checks, each with a
 * unique name, a command of 1 to 4096 bytes without NUL, a time limit of 10 to 1800 s (600 when left out) and a folder
 * of the repository ("." when left out); the limits at most 3600 s together. `site`, when there, is the repository's
 * website (`CodeSiteRecipe`): an object with `folder` (a folder of the repository as the kernel keeps a site's), and
 * optionally `name` (a site's name) and `title` (1 to 120 characters on one line, no space at either end:
 * `SITE_TITLE`). A file that breaks any rule is refused whole, with every problem found. */
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
	const parsed = parseChecks(entry.bytes, (at, code, message) => problems.push({ at, code, message }));
	if (problems.length > 0 || parsed === null) return { state: "refused", blob, problems };
	return { state: "ok", blob, checks: parsed.checks, site: parsed.site };
}

function parseChecks(bytes: Uint8Array, refuse: Refuse): { checks: CodeCheck[]; site: CodeSiteRecipe | null } | null {
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
	let site: CodeSiteRecipe | null = null;
	for (const [key, value] of Object.entries(root)) {
		const at = pointer("", key);
		if (key === "$schema") {
			if (typeof value !== "string") refuse(at, "WRONG_TYPE", "Must be a string.");
		} else if (key === "checks") checks = checksOf(value, at, refuse);
		else if (key === "site") site = siteOf(value, at, refuse);
		else refuse(at, "UNKNOWN_KEY", UNKNOWN);
	}
	if (!("checks" in root)) refuse("", "MISSING_KEY", "Needs checks.");
	return { checks, site };
}

/** The `site` key (STEP4-RELEASES-PLAN.md 5.1): what the kernel keeps of a made site, so that a recipe this reads is
 * never one a report cannot carry. */
function siteOf(value: unknown, at: string, refuse: Refuse): CodeSiteRecipe | null {
	if (!isObject(value)) {
		refuse(at, "WRONG_TYPE", "Must be an object.");
		return null;
	}
	let folder: string | null = null;
	let name: string | null = null;
	let title: string | null = null;
	for (const [key, field] of Object.entries(value)) {
		const fieldAt = pointer(at, key);
		if (key !== "folder" && key !== "name" && key !== "title") refuse(fieldAt, "UNKNOWN_KEY", UNKNOWN);
		else if (typeof field !== "string") refuse(fieldAt, "WRONG_TYPE", "Must be a string.");
		else if (key === "folder") {
			if (codeSiteFolderValid(field)) folder = field;
			else
				refuse(
					fieldAt,
					"INVALID_PATH",
					'Must be "." or a folder of the repository: a relative path without . or .. parts, at most 300 bytes.',
				);
		} else if (key === "name") {
			if (codeSiteNameValid(field)) name = field;
			else
				refuse(
					fieldAt,
					"INVALID_VALUE",
					"Must be 3 to 48 of a-z, 0-9 and '-', starting and ending with a letter or a digit, and not a name a site never gets (such as api, app or www).",
				);
		} else if (field.startsWith(" ") || field.endsWith(" "))
			refuse(fieldAt, "SITE_TITLE", "Must not start or end with a space.");
		else if (codeSiteTitleValid(field)) title = field;
		else refuse(fieldAt, "INVALID_VALUE", "Must be 1 to 120 characters on one line.");
	}
	if (!("folder" in value)) refuse(at, "MISSING_KEY", "Needs folder.");
	return folder === null ? null : { folder, name, title };
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
 * its checks, whatever main has, and its recipe says what site they leave (main's never counts). A repository that has
 * a checks file keeps one: a candidate with no regular file there is refused. A candidate whose file has problems is
 * refused with them. */
export function codeChecksGate(main: CodeChecksRead, candidate: CodeChecksRead): CodeChecksGate {
	if (candidate.state === "ok")
		return {
			gate: "run",
			checks: candidate.checks,
			blob: candidate.blob,
			changed: changedOf(main.state === "ok" ? main.checks : [], candidate.checks),
			site: candidate.site ?? null,
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

/** The longest a time can say: the kernel takes a whole number of at most 15 digits (qorpera_code_json_count). */
const MAX_MILLIS = 999_999_999_999_999;

function millis(ms: number): number {
	return Number.isFinite(ms) && ms > 0 ? Math.min(Math.round(ms), MAX_MILLIS) : 0;
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

/** The code of a run that was not started because a command of an earlier run of the session's checks was not seen to
 * end: the machine is there, and the checks run again once that command has stopped. */
export const CODE_CHECKS_EARLIER_RUN_NOT_STOPPED = "CODE_CHECKS_EARLIER_RUN_NOT_STOPPED";

/** The code of a run whose copy found the folder of a later run on the machine and did nothing (the copy's own exit
 * 91): a copy whose start landed late, or a folder somebody made under `~/.qorpera-checks`. The session can remove it. */
export const CODE_CHECKS_COPY_NOT_NEWEST = "CODE_CHECKS_COPY_EXIT_91";

/** `CODING_CHECKS_DID_NOT_RUN`: the checks could not run, which is never the code's fault. */
export function codeChecksNotRunSummary(run: Extract<CodeChecksRun, { state: "not_run" }>): string {
	let why: string;
	switch (run.why) {
		case "machine":
			why =
				run.code === CODE_CHECKS_EARLIER_RUN_NOT_STOPPED
					? "an earlier run of the checks has not stopped on the session's machine yet"
					: "the session's machine stopped";
			break;
		case "copy":
			why =
				run.code === CODE_CHECKS_COPY_NOT_NEWEST
					? "a folder of a later run stands in ~/.qorpera-checks on the session's machine; remove the folders in it"
					: "the clean copy of the commit could not be made";
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

/** A command as Markdown code, its fence longer than any run of backticks inside. */
function code(text: string, max: number): string {
	const inner = shown(text, max);
	const longest = Math.max(0, ...(inner.match(/`+/g) ?? []).map((ticks) => ticks.length));
	const fence = "`".repeat(longest + 1);
	// A reader takes one space off each end of code that has one at both: so one is put there for it to take.
	const pad = /^[ `]|[ `]$/.test(inner) ? " " : "";
	return `${fence}${pad}${inner}${pad}${fence}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pointer(at: string, key: string | number): string {
	return `${at}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}
