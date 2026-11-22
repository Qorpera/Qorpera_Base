import {
	CODE_CHECK_NAME_PATTERN,
	type CodeCheck,
	type CodeCheckArtifactFormat,
	type CodeCheckArtifacts,
	type CodeCheckCache,
	type CodeChecksProblem,
	type CodeSiteRecipe,
	codeChecksWallBudget,
	type FailedTestCase,
	filterCodeChecksByPaths,
	MAX_CODE_CHECKS,
	MAX_PARALLEL_CHECKS,
	matchCheckGlob,
	parseCheckFailureArtifacts,
	parseCodeChecksBytes,
	codeChecksPlan as planCodeChecks,
} from "@qorpera/contracts";
import { CODE_CHECKS_FILE, type CodeCommitFile } from "./code-host-jobs.ts";
import { CODE_CHECKS_DRILL, type CodeSiteCollected, type CodeSiteProblem } from "./code-site.ts";
import { bytes, cut, halfCharacter, shown, unseen } from "./code-words.ts";

export {
	codeChecksWallBudget,
	filterCodeChecksByPaths,
	MAX_PARALLEL_CHECKS,
	matchCheckGlob,
	parseCheckFailureArtifacts,
};
export type {
	CodeCheck,
	CodeCheckArtifactFormat,
	CodeCheckArtifacts,
	CodeCheckCache,
	CodeChecksProblem,
	CodeCommitFile,
	CodeSiteRecipe,
	FailedTestCase,
};

export type CodeChecksRead =
	| { readonly state: "missing" }
	| {
			readonly state: "ok";
			readonly blob: string;
			readonly checks: readonly CodeCheck[];
			readonly site: CodeSiteRecipe | null;
			readonly maxParallel?: number;
			readonly failFast?: boolean;
			readonly caches?: readonly CodeCheckCache[];
	  }
	| { readonly state: "refused"; readonly blob: string | null; readonly problems: readonly CodeChecksProblem[] };

export interface CodeChecksChanged {
	readonly added: string[];
	readonly removed: string[];
	readonly run: string[];
}

export interface CodeChecksGateMeta {
	readonly maxParallel?: number;
	readonly failFast?: boolean;
	readonly caches?: readonly CodeCheckCache[];
	readonly checksChanged: boolean;
}

export type CodeChecksGate =
	| {
			readonly gate: "run";
			readonly checks: readonly CodeCheck[];
			readonly blob: string;
			readonly changed: CodeChecksChanged | null;
			readonly site: CodeSiteRecipe | null;
			readonly maxParallel?: number;
			readonly failFast?: boolean;
			readonly caches?: readonly CodeCheckCache[];
	  }
	| { readonly gate: "refused"; readonly summary: string };

export interface CodeCheckPassedEntry {
	name: string;
	run: string;
	ms: number;
	skipped?: "paths_unmatched";
}

export type CodeChecksRun =
	| {
			state: "passed";
			ms: number;
			copyMs: number;
			checks: CodeCheckPassedEntry[];
			site: CodeSiteCollected | null;
			artifactsDir?: string;
	  }
	| {
			state: "failed";
			ms: number;
			passed: { name: string; ms: number; skipped?: "paths_unmatched" }[];
			failed: {
				name: string;
				run: string;
				ms: number;
				exitCode: number | null;
				atLimit: boolean;
				tail: string;
				log: string;
				failedTests?: readonly FailedTestCase[];
				persistedLog?: string;
				artifactsDir?: string;
			};
			notRun: string[];
	  }
	| { state: "not_run"; why: "copy" | "machine" | "transport" | "authority" | "budget"; code: string }
	| CodeChecksSiteRefused;

export interface CodeChecksSiteRefused {
	state: "site_refused";
	ms: number;
	checks: CodeCheckPassedEntry[];
	problem: CodeSiteProblem;
}

const SHA = /^[0-9a-f]{40}$/;

const GATE_META = new WeakMap<object, CodeChecksGateMeta>();

export function codeChecksGateMetadata(checks: readonly CodeCheck[]): CodeChecksGateMeta | undefined {
	return GATE_META.get(checks) ?? (checks[0] !== undefined ? GATE_META.get(checks[0]) : undefined);
}

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
	const parsed = parseCodeChecksBytes(entry.bytes);
	if (!parsed.ok) return { state: "refused", blob, problems: parsed.problems };
	return {
		state: "ok",
		blob,
		checks: parsed.checks,
		site: parsed.site,
		...(parsed.maxParallel !== undefined ? { maxParallel: parsed.maxParallel } : {}),
		...(parsed.failFast !== undefined ? { failFast: parsed.failFast } : {}),
		...(parsed.caches !== undefined ? { caches: parsed.caches } : {}),
	};
}

export function codeChecksPlan(checks: readonly CodeCheck[]): readonly (readonly number[])[] | null {
	return planCodeChecks(checks, CODE_CHECKS_DRILL);
}

export function codeChecksGate(main: CodeChecksRead, candidate: CodeChecksRead): CodeChecksGate {
	if (candidate.state === "ok") {
		const changed = changedOf(main.state === "ok" ? main.checks : [], candidate.checks);
		const checks = candidate.checks.map((check) => ({ ...check }));
		const checksChanged = main.state !== "ok" || main.blob !== candidate.blob || changed !== null;
		const meta: CodeChecksGateMeta = {
			...(candidate.maxParallel !== undefined ? { maxParallel: candidate.maxParallel } : {}),
			...(candidate.failFast !== undefined ? { failFast: candidate.failFast } : {}),
			...(candidate.caches !== undefined ? { caches: candidate.caches } : {}),
			checksChanged,
		};
		// WHY: code-host-repositories.ts forwards gate.checks (or [...gate.checks, drill]) to runChecks without extra args.
		GATE_META.set(checks, meta);
		if (checks[0] !== undefined) GATE_META.set(checks[0], meta);
		return {
			gate: "run",
			checks,
			blob: candidate.blob,
			changed,
			site: candidate.site,
			...(candidate.maxParallel !== undefined ? { maxParallel: candidate.maxParallel } : {}),
			...(candidate.failFast !== undefined ? { failFast: candidate.failFast } : {}),
			...(candidate.caches !== undefined ? { caches: candidate.caches } : {}),
		};
	}
	if (main.state === "missing" && candidate.state === "missing") throw new Error("CODE_CHECKS_NOTHING_TO_CHECK");
	return { gate: "refused", summary: codeChecksRefusedSummary(candidate, main.state !== "missing") };
}

function effectiveNeedsOf(checks: readonly CodeCheck[]): ReadonlyMap<string, readonly string[]> {
	const plan = codeChecksPlan(checks);
	const depsByName = new Map<string, readonly string[]>();
	if (plan === null) return depsByName;
	for (let index = 0; index < checks.length; index++) {
		const check = checks[index] as CodeCheck;
		depsByName.set(
			check.name,
			(plan[index] as readonly number[]).map((dep) => (checks[dep] as CodeCheck).name),
		);
	}
	return depsByName;
}

function sameStringSet(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	if (a.length !== b.length) return false;
	const left = [...a].sort();
	const right = [...b].sort();
	return left.every((name, index) => name === right[index]);
}

function sameEnv(
	a: Readonly<Record<string, string>> | undefined,
	b: Readonly<Record<string, string>> | undefined,
): boolean {
	if (a === undefined || b === undefined) return a === b;
	const aKeys = Object.keys(a).sort();
	const bKeys = Object.keys(b).sort();
	if (aKeys.length !== bKeys.length) return false;
	return aKeys.every((key, index) => key === bKeys[index] && a[key] === b[key]);
}

function sameArtifacts(a: CodeCheckArtifacts | undefined, b: CodeCheckArtifacts | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	return a.when === b.when && a.format === b.format && sameStringSet(a.paths, b.paths);
}

function changedOf(main: readonly CodeCheck[], candidate: readonly CodeCheck[]): CodeChecksChanged | null {
	const before = new Map(main.map((check) => [check.name, check]));
	const beforeNeeds = effectiveNeedsOf(main);
	const afterNeeds = effectiveNeedsOf(candidate);
	const after = new Set(candidate.map((check) => check.name));
	const added: string[] = [];
	const run: string[] = [];
	for (const check of candidate) {
		const was = before.get(check.name);
		if (!was) added.push(check.name);
		else if (
			was.run !== check.run ||
			was.cwd !== check.cwd ||
			was.timeoutSeconds !== check.timeoutSeconds ||
			!sameStringSet(beforeNeeds.get(check.name), afterNeeds.get(check.name)) ||
			(was.exclusive ?? false) !== (check.exclusive ?? false) ||
			(was.retries ?? 0) !== (check.retries ?? 0) ||
			!sameStringSet(was.paths, check.paths) ||
			!sameStringSet(was.pathsIgnore, check.pathsIgnore) ||
			(was.alwaysRun ?? false) !== (check.alwaysRun ?? false) ||
			!sameEnv(was.env, check.env) ||
			!sameStringSet(was.secrets, check.secrets) ||
			!sameArtifacts(was.artifacts, check.artifacts)
		)
			run.push(check.name);
	}
	const removed = main.filter((check) => !after.has(check.name)).map((check) => check.name);
	return added.length > 0 || removed.length > 0 || run.length > 0 ? { added, removed, run } : null;
}

const MAX_PASSED_RUN_BYTES = 200;
const MAX_PASSED_ROW_BYTES = 8192;

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
		list.length >= least &&
		list.length <= MAX_CODE_CHECKS &&
		list.every((name) => CODE_CHECK_NAME_PATTERN.test(name));
	if (
		!SHA.test(commit) ||
		!SHA.test(blob) ||
		(how !== "fast-forward" && how !== "merged") ||
		(tries !== 1 && tries !== 2) ||
		!names(
			run.checks.map((check) => check.name),
			1,
		) ||
		run.checks.some((check) => check.skipped !== undefined && check.skipped !== "paths_unmatched") ||
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
			checks: run.checks.map((check) => ({
				name: check.name,
				run: cut(check.run, limit),
				ms: millis(check.ms),
				...(check.skipped !== undefined ? { skipped: check.skipped } : {}),
			})),
			changed: changed && { added: [...changed.added], removed: [...changed.removed], run: [...changed.run] },
			tries,
		};
		if (4 + jsonbBytes(result) <= MAX_PASSED_ROW_BYTES) return result;
	}
	throw new Error("INVALID_CODE_CHECKS_RESULT");
}

function jsonbBytes(value: unknown): number {
	if (typeof value === "string") return 4 + bytes(value);
	if (Array.isArray(value)) return 11 + value.reduce((sum: number, item) => sum + jsonbBytes(item), 0);
	if (isObject(value))
		return 11 + Object.entries(value).reduce((sum, [key, item]) => sum + 4 + bytes(key) + jsonbBytes(item), 0);
	return 4 + 3 + 4 + 2 + 8;
}

const MAX_MILLIS = 999_999_999_999_999;

function millis(ms: number): number {
	return Number.isFinite(ms) && ms > 0 ? Math.min(Math.round(ms), MAX_MILLIS) : 0;
}

const MAX_SUMMARY_BYTES = 3500;
const MAX_TAIL_LINES = 30;
const MAX_TAIL_BYTES = 1500;
const MAX_SUMMARY_FAILED_TESTS = 10;
const INDENT = "    ";

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
		if (kept.length === 0 && max > pad + bytes("…")) kept.unshift(endOf(line, max - pad));
		break;
	}
	while (kept.length > 0 && kept[0] === "") kept.shift();
	return kept;
}

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

function formatFailedTestsBlock(tests: readonly FailedTestCase[], maxBytes: number): string {
	if (tests.length === 0 || maxBytes < 60) return "";
	const header = ` Failed tests (${tests.length}):\n\n`;
	const limitBytes = maxBytes - 2;
	let used = bytes(header);
	const lines: string[] = [];
	const limit = Math.min(tests.length, MAX_SUMMARY_FAILED_TESTS);
	for (let index = 0; index < limit; index++) {
		const item = tests[index]!;
		const suite = item.suite ? `${shown(item.suite, 60)} › ` : "";
		const name = shown(item.name, 80);
		const location = item.file ? ` (${shown(item.file, 80)}${item.line !== undefined ? `:${item.line}` : ""})` : "";
		const message = item.message ? `: ${shown(item.message, 120)}` : "";
		const line = `${INDENT}- ${suite}${name}${location}${message}`;
		const extra = bytes(line) + (lines.length > 0 ? 1 : 0);
		if (used + extra > limitBytes) break;
		lines.push(line);
		used += extra;
	}
	if (lines.length === 0) return "";
	const omitted = tests.length - lines.length;
	if (omitted > 0) {
		const more = `${INDENT}… and ${omitted} more failed test${omitted === 1 ? "" : "s"}`;
		if (used + 1 + bytes(more) <= limitBytes) lines.push(more);
	}
	return `${header}${lines.join("\n")}\n\n`;
}

export function codeChecksFailedSummary(
	run: Extract<CodeChecksRun, { state: "failed" }>,
	how: "fast-forward" | "merged",
	opening = "",
): string {
	const failed = run.failed;
	const exit = failed.exitCode === null ? "ended without an exit code" : `ended with exit code ${failed.exitCode}`;
	const limit = failed.atLimit ? ", at its time limit" : "";
	const killed = failed.exitCode === 137 && !failed.atLimit ? " (killed, often for lack of memory)" : "";
	const head =
		`${opening}Nothing went into main: the check "${shown(failed.name, 40)}" failed on this change` +
		`${how === "merged" ? " merged with main as it is now" : ""}. It ran ${code(failed.run, MAX_PASSED_RUN_BYTES)} ` +
		`and ${exit} after ${Math.round(millis(failed.ms) / 1000)} s${limit}${killed}.`;
	const persisted = failed.persistedLog ? ` Full masked log saved at ${shown(failed.persistedLog, 200)}.` : "";
	const ranPassed = run.passed.filter((entry) => entry.skipped === undefined);
	const skippedChecks = run.passed.filter((entry) => entry.skipped !== undefined);
	const nameBudget = ranPassed.length > 0 && skippedChecks.length > 0 ? 300 : 600;
	const passed = ranPassed.length > 0 ? ` Checks that passed: ${namesOf(ranPassed, nameBudget)}.` : "";
	const skipped =
		skippedChecks.length > 0 ? ` Checks skipped (no matching changes): ${namesOf(skippedChecks, nameBudget)}.` : "";
	const foot =
		`Its whole output is in ${shown(failed.log, 200)} on the session's machine.${persisted}${passed}${skipped} Fix the cause in the code, ` +
		"never by removing or weakening the check or its tests; run the checks yourself from a clean copy, commit and " +
		"finish again. [code=CODING_CHECKS_FAILED]";
	const tail = codeChecksTail(failed.tail);
	const failedTests = failed.failedTests ?? [];
	const before = " The end of its output:\n\n";
	const after = "\n\n";
	const testsBudget =
		failedTests.length > 0
			? Math.min(1100, Math.max(0, MAX_SUMMARY_BYTES - bytes(head) - bytes(foot) - (tail ? 320 : 32)))
			: 0;
	const testsSection = formatFailedTestsBlock(failedTests, testsBudget);
	const room = MAX_SUMMARY_BYTES - bytes(head) - bytes(testsSection) - bytes(before) - bytes(after) - bytes(foot);
	const lines = tail === "" || room <= INDENT.length + 4 ? [] : lastLines(tail.split("\n"), room, INDENT.length);
	if (lines.length === 0) {
		if (testsSection) return `${head}${testsSection}${foot}`;
		return `${head} It wrote no output. ${foot}`;
	}
	const block = lines.map((line) => (line === "" ? "" : `${INDENT}${line}`)).join("\n");
	if (testsSection) return `${head}${testsSection}The end of its output:\n\n${block}${after}${foot}`;
	return `${head}${before}${block}${after}${foot}`;
}

function namesOf(checks: readonly { name: string }[], maxBytes = 600): string {
	const names: string[] = [];
	let used = 0;
	for (const check of checks) {
		const name = shown(check.name, 40);
		if (used + bytes(name) + 2 > maxBytes) break;
		names.push(name);
		used += bytes(name) + 2;
	}
	const more = checks.length - names.length;
	return [...names, ...(more > 0 ? [`and ${more} more`] : [])].join(", ");
}

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

export const CODE_CHECKS_EARLIER_RUN_NOT_STOPPED = "CODE_CHECKS_EARLIER_RUN_NOT_STOPPED";

export const CODE_CHECKS_COPY_NOT_NEWEST = "CODE_CHECKS_COPY_EXIT_91";

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

export const CODE_CHECKS_MAIN_MOVED =
	"Nothing went into main yet: main changed twice while this change's checks ran, so they never ran on what would go in. This is not a fault in the code. The work is kept on the session's branch; finishing again checks it once more. [code=CODING_CHECKS_MAIN_MOVED]";

function code(text: string, max: number): string {
	const inner = shown(text, max);
	const longest = Math.max(0, ...(inner.match(/`+/g) ?? []).map((ticks) => ticks.length));
	const fence = "`".repeat(longest + 1);
	const pad = /^[ `]|[ `]$/.test(inner) ? " " : "";
	return `${fence}${pad}${inner}${pad}${fence}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
