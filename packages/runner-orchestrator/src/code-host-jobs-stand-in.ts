import type { CloudCodingRepository } from "@qorpera/contracts";
import type { CodeBranchLanded, CodeBranchLanding, CodeHostJob } from "./code-host-jobs.ts";

// STAND-IN, to be removed when step 2b's parts are merged (own code storage, STEP2B-CHANGE-RECORD-PLAN.md 13.1).
//
// Part B builds the code host's jobs of the change record in `code-host-jobs.ts` at the same time as part C builds the
// executor's side. Until both are in one tree, what part C needs of part B is declared here and nowhere else, as part
// B's branch has it (`runtime/own-code-record-jobs` at 15b394a5b: the plan's "Part B" block, and the name
// `CodeChangeUndone` for an undo's answer). Only types are imported from this file, so nothing of it runs.
//
// At the merge: delete this file and import the same names from `./code-host-jobs.ts` where they are imported from
// here (`code-change-records.ts`, `code-host-requests.ts`, `code-host-repositories.ts`, `coding-folder-repositories.ts`
// and the tests of the first three). `LandCodeBranch` has no name there: in `code-host-repositories.ts` its cast goes
// (`landCodeBranch` is that type then) and `Landed` becomes `CodeBranchLanded`. The test
// `code-host-repositories.test.ts` wraps `landCodeBranch` to add what part B's answers already hold: that wrapper goes
// too (it passes part B's answers on as they are, so the tests hold either way).

export interface CodeChangePath {
	path: string;
	change: "added" | "changed" | "removed";
}
export interface CodeChangeDiff {
	filesChanged: number;
	paths: CodeChangePath[];
	pathsMore: number;
}
export type CodePictureChecked =
	| { state: "ok"; blob: string; bytes: number; type: "png" | "jpeg" | "webp" }
	| { state: "missing" | "not_a_file" | "too_large" | "not_a_picture" };

/** `landCodeBranch` as part B leaves it: a landing may name a picture (a path in the repository), and its answer says
 * where main was, which commit of main first held the head when nothing changed, what differs, and how the picture
 * checked out. Only this stand-in has the name: with part B's types, `landCodeBranch` is this as it is. */
export type LandCodeBranch = (
	job: CodeHostJob,
	value: CodeBranchLanding & { picture?: string },
) => Promise<
	CodeBranchLanded & {
		/** Main before the landing; main itself when unchanged. */
		mainBefore: string;
		/** Unchanged only: the commit of main that first held headSha. */
		containedAt: string | null;
		/** Zero and empty when unchanged. */
		diff: CodeChangeDiff;
		/** Null when none was given, or when unchanged. */
		picture: CodePictureChecked | null;
	}
>;

export interface CodeChangeRecordFile {
	n: number;
	/** The file's text; with `diff`, a function of what the job found between the two commits. */
	text: string | ((diff: CodeChangeDiff) => string);
	diff?: { before: string; after: string };
	/** The picture's git blob and the folder path it is copied to (`code/<owner>/<name>/changes/<n>.<ext>`). */
	picture?: { blob: string; to: string };
}
/** Writes changes/<n>.md (and a picture) for each record and, when given, changes/index.md. A file that already
 * holds its bytes is left. Never touches a ref. At most 100 records, each text and the list at most 256 KiB and not
 * empty. `written` names the records whose file now holds its text; a record whose `diff` names a commit the
 * repository no longer holds is left unwritten and out of it, and a picture whose blob is not there is not copied
 * while its record is written. */
export declare function writeCodeChangeRecords(
	job: CodeHostJob,
	value: { repository: CloudCodingRepository; records: readonly CodeChangeRecordFile[]; index: string | null },
): Promise<{ written: number[]; diffs: ({ n: number } & CodeChangeDiff)[]; restored: string[] }>;

/** An undo's answer. `undone`: main moved from `mainBefore` to the undo's commit `mainAfter`, which changed `diff`;
 * `replayed` when an earlier run of the same request had made it. `nothing`: main no longer holds what the change did. */
export type CodeChangeUndone =
	| { state: "undone"; mainBefore: string; mainAfter: string; diff: CodeChangeDiff; replayed: boolean }
	| { state: "nothing"; mainSha: string };

/** Refusals: CODE_HOST_UNDO_CONFLICT (every conflicted path), CODE_HOST_UNDO_NOT_IN_MAIN,
 * CODE_HOST_UNDO_UNKNOWN_COMMIT, and a landing's own (names, not seeded, no mark). `message` is 1 to 4096 bytes. */
export declare function undoCodeChange(
	job: CodeHostJob,
	value: {
		repository: CloudCodingRepository;
		requestId: string;
		change: { n: number; mainBefore: string; mainAfter: string };
		andLater: boolean;
		message: string;
	},
): Promise<CodeChangeUndone>;

/** `maximumBytes` defaults to 200 MiB; CODE_HOST_DOWNLOAD_TOO_LARGE over it. `fileName` is
 * `^[A-Za-z0-9_][A-Za-z0-9_.-]{0,190}\.(zip|bundle)$`, `.zip` for `files` and `.bundle` for `history`. The file
 * replaces whatever of its kind stood in downloads/. */
export declare function archiveCodeArea(
	job: CodeHostJob,
	value: { repository: CloudCodingRepository; file: "files" | "history"; fileName: string },
	options?: { maximumBytes?: number },
): Promise<{ path: string; bytes: number; sha256: string; mainSha: string }>;
/** At most 20 names, by name only; one that is not there is left out of `removed`. */
export declare function removeCodeDownloads(
	job: CodeHostJob,
	value: { repository: CloudCodingRepository; fileNames: readonly string[] },
): Promise<{ removed: string[] }>;
