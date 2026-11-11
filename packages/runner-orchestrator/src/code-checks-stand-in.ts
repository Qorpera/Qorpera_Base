import type { CodeBranchLanded, CodeBranchLanding, CodeCommitEntry, CodeHostJob } from "./code-host-jobs.ts";

// STAND-IN, to be removed when step 3's parts are merged (own code storage, STEP3-CHECKS-PLAN.md 12.1).
//
// Part B builds the landing's two jobs in `code-host-jobs.ts`, and part C1 the checks file's reader, the gate and the
// words in `code-checks.ts`, at the same time as part C2 builds the runner and the landing's flow. Until all three are
// in one tree, what part C2 needs of them is declared here and nowhere else, with the plan's names and shapes (8.1 and
// 12.1; B's own differences from build3/B.md). The functions here only throw: every test that reaches one replaces it.
//
// At the merge: delete this file, and import each name from where its part has it (`code-host-jobs.ts`: `CodeCommitFile`,
// `CodeBranchToCheck`; `code-checks.ts`: everything else). `LandCodeBranch` has no name there: in
// `code-host-repositories.ts` its two casts go (`landCodeBranch` has that type then).

// Part B, `code-host-jobs.ts`.

/** A path of one commit, as git holds it: its entry (a file's bytes cut after maxBytes + 1), and its blob's id when it
 * is a regular file. */
export interface CodeCommitFile {
	entry: CodeCommitEntry;
	blob: string | null;
}
export interface CodeBranchToCheck {
	state: "to-check";
	how: "fast-forward" | "merged";
	/** The default branch now. */
	mainBefore: string;
	/** The candidate: headSha, or the merge commit this job wrote (no ref names it; it stays an object). */
	mainAfter: string;
	/** .qorpera/checks.json at mainAfter and at mainBefore, read with maxBytes 16 KiB. */
	checks: CodeCommitFile;
	mainChecks: CodeCommitFile;
	restored: string[];
}
/** `landCodeBranch` as part B leaves it (its two signatures, build3/B.md item 1). Only this stand-in has the name. */
export interface LandCodeBranch {
	(
		job: CodeHostJob,
		value: CodeBranchLanding & {
			checks?: undefined;
			expect?: { how: "fast-forward" | "merged"; mainBefore: string; mainAfter: string };
		},
	): Promise<CodeBranchLanded>;
	(
		job: CodeHostJob,
		value: CodeBranchLanding & {
			checks?: true;
			expect?: { how: "fast-forward" | "merged"; mainBefore: string; mainAfter: string };
		},
	): Promise<CodeBranchLanded | CodeBranchToCheck>;
}

// Part C1, `code-checks.ts`.

export interface CodeCheck {
	readonly name: string;
	readonly run: string;
	readonly timeoutSeconds: number;
	readonly cwd: string;
}
export interface CodeChecksProblem {
	readonly at: string;
	readonly code: string;
	readonly message: string;
}
export type CodeChecksRead =
	| { readonly state: "missing" }
	| { readonly state: "ok"; readonly blob: string; readonly checks: readonly CodeCheck[] }
	| { readonly state: "refused"; readonly blob: string | null; readonly problems: readonly CodeChecksProblem[] };
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
/** One run of a repository's checks on one candidate (6.4). */
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
				/** The path of its whole output on the machine. */
				log: string;
			};
			notRun: string[];
	  }
	| { state: "not_run"; why: "copy" | "machine" | "transport" | "authority" | "budget"; code: string };

const STAND_IN = "CODE_CHECKS_STAND_IN";

/** The file as git holds it at one commit (B's CodeCommitFile), read under section 5.1's rules. Pure. */
export function readCodeChecks(_file: CodeCommitFile): CodeChecksRead {
	throw new Error(STAND_IN);
}
/** Section 5.2 for a `to-check` answer (at least one of the two is not missing). Pure. */
export function codeChecksGate(_main: CodeChecksRead, _candidate: CodeChecksRead): CodeChecksGate {
	throw new Error(STAND_IN);
}
/** The row's `checks` for a passed run (7.1). Pure; within 8 KiB. */
export function codeChecksPassed(_value: {
	commit: string;
	how: "fast-forward" | "merged";
	blob: string;
	run: Extract<CodeChecksRun, { state: "passed" }>;
	changed: CodeChecksChanged | null;
	tries: 1 | 2;
}): Record<string, unknown> {
	throw new Error(STAND_IN);
}
/** 6.4's tail of a failed check's output (C1's addition, build3/C1.md item 1): at most 30 lines and 1,500 bytes, cut at
 * whole lines from the end, every character a line may not hold shown as U+FFFD. Pure. */
export function codeChecksTail(_output: string): string {
	throw new Error(STAND_IN);
}
/** 11.4's `CODING_CHECKS_FAILED` text, within 3,500 bytes. Pure. */
export function codeChecksFailedSummary(
	_run: Extract<CodeChecksRun, { state: "failed" }>,
	_how: "fast-forward" | "merged",
): string {
	throw new Error(STAND_IN);
}
/** 11.4's `CODING_CHECKS_DID_NOT_RUN` text, within 3,500 bytes. Pure. */
export function codeChecksNotRunSummary(_run: Extract<CodeChecksRun, { state: "not_run" }>): string {
	throw new Error(STAND_IN);
}
/** 11.4's `CODING_CHECKS_MAIN_MOVED` text. */
export const CODE_CHECKS_MAIN_MOVED: string = STAND_IN;
