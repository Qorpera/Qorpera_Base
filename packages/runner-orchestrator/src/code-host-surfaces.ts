import {
	type CloudCodingRepository,
	compileIdentityTokensCss,
	isUuid,
	SURFACE_IDENTITY_CSS_MOUNT_PATH,
} from "@qorpera/contracts";
import { CODE_FOLDER_ANY_SESSION, codeFolderRefuses } from "./code-folder-names.ts";
import {
	CODE_AREA_CONFIG,
	CODE_AREA_IN_QORPERA_REF,
	type CodeHostJob,
	CodeHostJobFailure,
	CodeHostRefusal,
	keptRepositoryOf,
	MAX_READ,
	moveBase,
	type Run,
	SHA,
	tail,
	WORKTREE_IN_PROGRESS,
	withJob,
	ZERO,
} from "./code-host-jobs.ts";

const PREVIEW_ID = /^[a-z0-9]{8}$/;
const PLATFORM_COMMITTER = ["-c", "user.name=Qorpera", "-c", "user.email=qorpera@users.noreply.qorpera.com"] as const;

export interface CodeHostChangeRange {
	readonly changeId: string;
	readonly parentSha: string;
	readonly headSha: string;
	readonly title: string;
	readonly summary?: string;
}

export class CodeHostChangeConflict extends CodeHostRefusal {
	readonly changeId: string;
	constructor(code: string, changeId: string, paths: readonly string[]) {
		super(code, paths);
		this.name = "CodeHostChangeConflict";
		this.changeId = changeId;
	}
}

export interface CherryPickChangeUnitsInput {
	readonly repository: CloudCodingRepository;
	readonly changes: readonly CodeHostChangeRange[];
	readonly expectMainSha?: string;
}

export interface CherryPickChangeUnitsResult {
	readonly mainBefore: string;
	readonly mainAfter: string;
	readonly landedCommits: readonly { readonly changeId: string; readonly commitSha: string }[];
	readonly diff: { readonly filesChanged: number; readonly paths: readonly string[] };
	readonly restored: readonly string[];
}

export interface RebaseSessionChangesInput {
	readonly repository: CloudCodingRepository;
	readonly workerId: string;
	readonly ontoSha: string;
	readonly remainingChanges: readonly CodeHostChangeRange[];
	readonly updateBranchRef?: boolean;
	readonly allowedBranchTips?: readonly string[];
}

export type RebaseDeferReason = "branch_advanced" | "worktree_dirty" | "worktree_unsafe" | "cas_race" | "rebase_failed";

export type RebaseSessionChangesResult =
	| {
			readonly status: "clean";
			readonly ontoSha: string;
			readonly branchHeadSha: string;
			readonly rebasedChanges: readonly {
				readonly changeId: string;
				readonly parentSha: string;
				readonly headSha: string;
			}[];
			readonly worktreeSynced?: boolean;
			readonly restored: readonly string[];
	  }
	| {
			readonly status: "conflicted";
			readonly ontoSha: string;
			readonly conflictedChangeId: string;
			readonly conflictPaths: readonly string[];
			readonly rebasedBeforeConflict: readonly {
				readonly changeId: string;
				readonly parentSha: string;
				readonly headSha: string;
			}[];
			readonly restored: readonly string[];
	  }
	| {
			readonly status: "deferred";
			readonly ontoSha: string;
			readonly reason: RebaseDeferReason;
			readonly errorCode?: string;
			readonly restored: readonly string[];
	  };

export interface ComposePreviewTreeInput {
	readonly repository: CloudCodingRepository;
	readonly baseSha?: string;
	readonly exploration?: {
		readonly sessionId: string;
		readonly baseSha: string;
		readonly headSha: string;
	};
	readonly changes: readonly Pick<CodeHostChangeRange, "changeId" | "parentSha" | "headSha">[];
	readonly previewRefId?: string;
}

export type ComposePreviewTreeResult =
	| {
			readonly status: "ready";
			readonly baseSha: string;
			readonly compositeCommitSha: string;
			readonly compositeTreeSha: string;
			readonly appliedChangeIds: readonly string[];
			readonly previewRef: string | null;
			readonly restored: readonly string[];
	  }
	| {
			readonly status: "conflicted";
			readonly baseSha: string;
			readonly lastCleanCommitSha: string;
			readonly lastCleanTreeSha: string;
			readonly appliedChangeIds: readonly string[];
			readonly conflictingChangeId: string;
			readonly explorationConflicted?: boolean;
			readonly conflictPaths: readonly string[];
			readonly restored: readonly string[];
	  };

export interface InspectChangeRangeInput {
	readonly repository: CloudCodingRepository;
	readonly workerId: string;
	readonly parentSha: string;
	readonly headSha: string;
}

export interface InspectChangeRangeResult {
	readonly parentSha: string;
	readonly headSha: string;
	readonly affectedPaths: readonly string[];
	readonly diffStats: { readonly filesChanged: number; readonly additions: number; readonly deletions: number };
	readonly restored: readonly string[];
}

function assertSha(value: unknown, code = "INVALID_CODE_HOST_JOB"): string {
	if (typeof value !== "string" || !SHA.test(value)) throw new Error(code);
	return value;
}

function assertChangeRange(value: CodeHostChangeRange): void {
	if (!isUuid(value.changeId)) throw new Error("INVALID_CODE_HOST_JOB");
	assertSha(value.parentSha);
	assertSha(value.headSha);
	if (typeof value.title !== "string" || value.title.trim().length === 0 || value.title.includes("\0")) {
		throw new Error("INVALID_CODE_HOST_JOB");
	}
}

async function prepareKeptArea(run: Run) {
	const area = await run.prepare();
	if (!area.seeded) throw new CodeHostRefusal("CODE_HOST_NOT_SEEDED", [run.area]);
	if ((await run.ref(CODE_AREA_IN_QORPERA_REF)) === null) {
		throw new CodeHostRefusal("CODE_HOST_AREA_FROM_GITHUB", [run.area]);
	}
	const base = `refs/heads/${run.repository.baseBranch}`;
	const mainSha = await run.ref(base);
	if (!mainSha) throw new CodeHostRefusal("CODE_HOST_AREA_NO_BASE", [base]);
	return { area, base, mainSha };
}

async function treeOfCommit(run: Run, commitSha: string, errorCode: string): Promise<string> {
	const tree = (await run.gitOk(run.repo, ["rev-parse", "--verify", `${commitSha}^{tree}`], errorCode))
		.toString("latin1")
		.trim();
	if (!SHA.test(tree)) throw new CodeHostJobFailure(errorCode, "missing tree");
	return tree;
}

// WHY: Git 2.38/2.39 (macOS dev) lacks --merge-base on merge-tree, so fall back to synthetic parented commits only on exit 129.
async function applyRange(
	run: Run,
	cursorCommit: string,
	parentSha: string,
	headSha: string,
	errorCode: string,
): Promise<
	{ readonly ok: true; readonly treeSha: string } | { readonly ok: false; readonly paths: readonly string[] }
> {
	let merged = await run.git(
		run.repo,
		[
			"merge-tree",
			"--write-tree",
			"-z",
			"--name-only",
			"--no-messages",
			`--merge-base=${parentSha}`,
			cursorCommit,
			headSha,
		],
		{ maximumOutputBytes: MAX_READ },
	);
	if (merged.status === 129 && /merge-base/i.test(merged.stderr)) {
		const cursorTree = await treeOfCommit(run, cursorCommit, errorCode);
		const headTree = await treeOfCommit(run, headSha, errorCode);
		const ours = await commitTree(run, cursorTree, parentSha, "qorpera merge ours", [], errorCode);
		const theirs = await commitTree(run, headTree, parentSha, "qorpera merge theirs", [], errorCode);
		merged = await run.git(
			run.repo,
			["merge-tree", "--write-tree", "-z", "--name-only", "--no-messages", ours, theirs],
			{ maximumOutputBytes: MAX_READ },
		);
	}
	const fields = merged.stdout.toString("utf8").split("\0");
	if (merged.status === 1) {
		return { ok: false, paths: [...new Set(fields.slice(1).filter(Boolean))] };
	}
	if (merged.status !== 0 || !SHA.test(fields[0] ?? "")) {
		throw new CodeHostJobFailure(errorCode, tail(merged.stderr));
	}
	return { ok: true, treeSha: fields[0] as string };
}

async function assertOrderedRange(run: Run, parentSha: string, headSha: string, errorCode: string): Promise<void> {
	if (parentSha === headSha) return;
	const ordered = await run.git(run.repo, ["merge-base", "--is-ancestor", parentSha, headSha]);
	if (ordered.status === 1) {
		throw new CodeHostRefusal("CODE_HOST_INVALID_CHANGE_RANGE", [parentSha, headSha]);
	}
	if (ordered.status !== 0) {
		throw new CodeHostJobFailure(errorCode, tail(ordered.stderr));
	}
}

async function assertAllCommits(run: Run, shas: readonly string[]): Promise<void> {
	const unique = [...new Set(shas)];
	if (unique.length === 0) return;
	const ok = await run.areCommits(run.repo, unique);
	const missing = unique.filter((_, index) => !ok[index]);
	if (missing.length > 0) {
		throw new CodeHostRefusal("CODE_HOST_UNKNOWN_COMMIT", missing);
	}
}

async function commitTree(
	run: Run,
	treeSha: string,
	parentSha: string,
	message: string,
	trailers: readonly string[],
	errorCode: string,
): Promise<string> {
	const args: string[] = [...PLATFORM_COMMITTER, "commit-tree", treeSha, "-p", parentSha, "-m", message];
	for (const trailer of trailers) args.push("-m", trailer);
	const commitSha = (await run.gitOk(run.repo, args, errorCode)).toString("latin1").trim();
	if (!SHA.test(commitSha)) throw new CodeHostJobFailure(errorCode, "commit-tree produced no SHA");
	return commitSha;
}

async function diffPathsBetween(run: Run, fromSha: string, toSha: string, errorCode: string): Promise<string[]> {
	const out = await run.gitOk(run.repo, ["diff", "--name-only", "-z", fromSha, toSha], errorCode, {
		maximumOutputBytes: MAX_READ,
	});
	return out.toString("utf8").split("\0").filter(Boolean);
}

export async function cherryPickChangeUnits(
	job: CodeHostJob,
	input: CherryPickChangeUnitsInput,
): Promise<CherryPickChangeUnitsResult> {
	const repository = keptRepositoryOf(input.repository);
	if (!Array.isArray(input.changes) || input.changes.length === 0) throw new Error("INVALID_CODE_HOST_JOB");
	for (const change of input.changes) assertChangeRange(change);
	if (input.expectMainSha !== undefined) assertSha(input.expectMainSha);

	return withJob(job, repository, async (run) => {
		const { area, base, mainSha } = await prepareKeptArea(run);
		if (input.expectMainSha && mainSha !== input.expectMainSha) {
			throw new CodeHostJobFailure("CODE_HOST_LAND_STALE", "default branch moved before cherry-pick");
		}
		await assertAllCommits(
			run,
			input.changes.flatMap((change) => [change.parentSha, change.headSha]),
		);
		for (const change of input.changes) {
			await assertOrderedRange(run, change.parentSha, change.headSha, "CODE_HOST_CHERRY_PICK_FAILED");
		}

		let cursor = mainSha;
		let cursorTree = await treeOfCommit(run, cursor, "CODE_HOST_CHERRY_PICK_FAILED");
		const landedCommits: { changeId: string; commitSha: string }[] = [];
		for (const change of input.changes) {
			if (change.parentSha === change.headSha) {
				landedCommits.push({ changeId: change.changeId, commitSha: cursor });
				continue;
			}
			const applied = await applyRange(
				run,
				cursor,
				change.parentSha,
				change.headSha,
				"CODE_HOST_CHERRY_PICK_FAILED",
			);
			if (!applied.ok) {
				throw new CodeHostChangeConflict("CODE_HOST_CHERRY_PICK_CONFLICT", change.changeId, applied.paths);
			}
			if (applied.treeSha === cursorTree) {
				landedCommits.push({ changeId: change.changeId, commitSha: cursor });
				continue;
			}
			const body = change.summary?.trim()
				? `${change.title.trim()}\n\n${change.summary.trim()}`
				: change.title.trim();
			cursor = await commitTree(
				run,
				applied.treeSha,
				cursor,
				body,
				[`Qorpera-Change: ${change.changeId}`],
				"CODE_HOST_CHERRY_PICK_FAILED",
			);
			cursorTree = applied.treeSha;
			landedCommits.push({ changeId: change.changeId, commitSha: cursor });
		}

		if (cursor !== mainSha) {
			const { records } = await run.checkNamesIncremental(run.repo, mainSha, cursor);
			const refused = codeFolderRefuses(run.area, records, CODE_FOLDER_ANY_SESSION);
			if (refused.length > 0) throw new CodeHostRefusal("CODE_HOST_NAMES_FOLDER_REFUSES", refused);
		}

		const paths =
			cursor === mainSha ? [] : await diffPathsBetween(run, mainSha, cursor, "CODE_HOST_CHERRY_PICK_FAILED");
		if (cursor !== mainSha) {
			await moveBase(run, area.main, base, cursor, mainSha);
		}
		return {
			mainBefore: mainSha,
			mainAfter: cursor,
			landedCommits,
			diff: { filesChanged: paths.length, paths },
			restored: run.restored,
		};
	});
}

async function inspectWorktreeForRebase(
	run: Run,
	workerId: string,
	branchRef: string,
	oldTip: string | null,
): Promise<{ readonly exists: false } | { readonly exists: true; readonly defer: RebaseDeferReason | null }> {
	const wtTree = `${run.code}/worktrees/${workerId}`;
	const wtAdmin = `${run.repo}/worktrees/${workerId}`;
	const [treeType, adminType, linkType, backType, commonType, headType, refsType, ...progress] = await run.types([
		wtTree,
		wtAdmin,
		`${wtTree}/.git`,
		`${wtAdmin}/gitdir`,
		`${wtAdmin}/commondir`,
		`${wtAdmin}/HEAD`,
		`${wtAdmin}/refs`,
		...WORKTREE_IN_PROGRESS.map((name) => `${wtAdmin}/${name}`),
	]);
	if (treeType === "none" && adminType === "none") return { exists: false };
	if (
		treeType !== "directory" ||
		adminType !== "directory" ||
		linkType !== "file" ||
		backType !== "file" ||
		commonType !== "file" ||
		headType !== "file"
	) {
		return { exists: true, defer: "worktree_unsafe" };
	}
	const [linkBytes, backBytes, commonBytes, headBytes] = await run.readMany([
		`${wtTree}/.git`,
		`${wtAdmin}/gitdir`,
		`${wtAdmin}/commondir`,
		`${wtAdmin}/HEAD`,
	]);
	if (
		!linkBytes?.equals(Buffer.from(`gitdir: ${wtAdmin}\n`)) ||
		!backBytes?.equals(Buffer.from(`${wtTree}/.git\n`)) ||
		!commonBytes?.equals(Buffer.from("../..\n")) ||
		!headBytes?.equals(Buffer.from(`ref: ${branchRef}\n`))
	) {
		return { exists: true, defer: "worktree_unsafe" };
	}
	if (!oldTip) return { exists: true, defer: "worktree_unsafe" };
	if (progress.some((type) => type !== "none")) return { exists: true, defer: "worktree_dirty" };
	if (refsType !== "none") {
		if (refsType !== "directory") return { exists: true, defer: "worktree_unsafe" };
		const own = await run.command([
			"/usr/bin/find",
			`${wtAdmin}/refs`,
			"-mindepth",
			"1",
			"!",
			"-type",
			"d",
			"-print",
			"-quit",
		]);
		if (own.status !== 0) throw new CodeHostJobFailure("CODE_HOST_INSPECT_FAILED", tail(own.stderr));
		if (own.stdout.length) return { exists: true, defer: "worktree_dirty" };
	}
	// WHY: A session controls its worktree; reject gitlinks and nested .git before any git status/reset touches disk so submodule configs cannot execute filter drivers on the code host.
	const headRecords = await run.checkNames(run.repo, oldTip).catch((error: unknown) => {
		if (error instanceof CodeHostRefusal) return null;
		throw error;
	});
	if (
		!headRecords ||
		codeFolderRefuses(run.area, headRecords, `worktrees/${workerId}`).length > 0 ||
		headRecords.some((record) => record.type === "commit")
	) {
		return { exists: true, defer: "worktree_unsafe" };
	}
	const nested = await run.command(["/usr/bin/find", wtTree, "-mindepth", "2", "-iname", ".git", "-print", "-quit"]);
	if (nested.status !== 0) throw new CodeHostJobFailure("CODE_HOST_INSPECT_FAILED", tail(nested.stderr));
	if (nested.stdout.length) return { exists: true, defer: "worktree_unsafe" };
	// WHY: Edits flagged assume-unchanged or skip-worktree are hidden from porcelain status and would be overwritten by reset --hard.
	const plain = await run.sh(
		'out=$1; shift; "$@" >"$out" || exit 2; grep -q -v "^H " "$out"; case $? in 1) exit 0 ;; 0) exit 1 ;; *) exit 2 ;; esac',
		[
			`${run.directory}/rebase-index.out`,
			run.layout.git,
			"--no-replace-objects",
			`--git-dir=${wtAdmin}`,
			`--work-tree=${wtTree}`,
			"ls-files",
			"-v",
		],
	);
	if (plain.status !== 0) return { exists: true, defer: "worktree_dirty" };
	const clean = await run.clean([
		`--git-dir=${wtAdmin}`,
		`--work-tree=${wtTree}`,
		"status",
		"--porcelain",
		"-z",
		"--untracked-files=normal",
		"--ignore-submodules=all",
	]);
	if (!clean) return { exists: true, defer: "worktree_dirty" };
	return { exists: true, defer: null };
}

export async function rebaseSessionChanges(
	job: CodeHostJob,
	input: RebaseSessionChangesInput,
): Promise<RebaseSessionChangesResult> {
	const repository = keptRepositoryOf(input.repository);
	if (!isUuid(input.workerId)) throw new Error("INVALID_CODE_HOST_JOB");
	const ontoSha = assertSha(input.ontoSha);
	if (!Array.isArray(input.remainingChanges)) throw new Error("INVALID_CODE_HOST_JOB");
	for (const change of input.remainingChanges) assertChangeRange(change);
	if (input.allowedBranchTips !== undefined) {
		for (const tip of input.allowedBranchTips) assertSha(tip);
	}

	return withJob(job, repository, async (run) => {
		await prepareKeptArea(run);
		await assertAllCommits(run, [
			ontoSha,
			...input.remainingChanges.flatMap((change) => [change.parentSha, change.headSha]),
		]);
		for (const change of input.remainingChanges) {
			await assertOrderedRange(run, change.parentSha, change.headSha, "CODE_HOST_REBASE_FAILED");
		}

		const branchRef = `refs/heads/qorpera/coding/${input.workerId}`;
		const wtAdmin = `${run.repo}/worktrees/${input.workerId}`;
		const wtTree = `${run.code}/worktrees/${input.workerId}`;
		const oldTip = input.updateBranchRef ? await run.ref(branchRef) : null;
		let hasWorktree = false;
		if (input.updateBranchRef) {
			const expectedTips = new Set<string>(
				input.allowedBranchTips && input.allowedBranchTips.length > 0
					? input.allowedBranchTips
					: input.remainingChanges.length > 0
						? [input.remainingChanges[input.remainingChanges.length - 1]!.headSha]
						: [],
			);
			// WHY: If an active peer session committed past its last staged change, moving its branch and resetting its worktree would destroy unrecorded commits.
			if (oldTip !== null && expectedTips.size > 0 && !expectedTips.has(oldTip)) {
				return { status: "deferred" as const, ontoSha, reason: "branch_advanced" as const, restored: run.restored };
			}
			const inspected = await inspectWorktreeForRebase(run, input.workerId, branchRef, oldTip);
			if (inspected.exists) {
				if (inspected.defer !== null) {
					return { status: "deferred" as const, ontoSha, reason: inspected.defer, restored: run.restored };
				}
				hasWorktree = true;
			}
		}

		let cursor = ontoSha;
		let cursorTree = await treeOfCommit(run, cursor, "CODE_HOST_REBASE_FAILED");
		const rebased: { changeId: string; parentSha: string; headSha: string }[] = [];
		for (const change of input.remainingChanges) {
			if (change.parentSha === change.headSha) {
				rebased.push({ changeId: change.changeId, parentSha: cursor, headSha: cursor });
				continue;
			}
			const applied = await applyRange(run, cursor, change.parentSha, change.headSha, "CODE_HOST_REBASE_FAILED");
			if (!applied.ok) {
				return {
					status: "conflicted" as const,
					ontoSha,
					conflictedChangeId: change.changeId,
					conflictPaths: applied.paths,
					rebasedBeforeConflict: rebased,
					restored: run.restored,
				};
			}
			if (applied.treeSha === cursorTree) {
				rebased.push({ changeId: change.changeId, parentSha: cursor, headSha: cursor });
				continue;
			}
			const body = change.summary?.trim()
				? `${change.title.trim()}\n\n${change.summary.trim()}`
				: change.title.trim();
			const nextSha = await commitTree(
				run,
				applied.treeSha,
				cursor,
				body,
				[`Qorpera-Change: ${change.changeId}`],
				"CODE_HOST_REBASE_FAILED",
			);
			rebased.push({ changeId: change.changeId, parentSha: cursor, headSha: nextSha });
			cursor = nextSha;
			cursorTree = applied.treeSha;
		}

		let worktreeSynced = true;
		if (input.updateBranchRef) {
			if (hasWorktree) {
				const cursorRecords = await run.checkNames(run.repo, cursor);
				if (cursorRecords.some((record) => record.type === "commit")) {
					return {
						status: "deferred" as const,
						ontoSha,
						reason: "worktree_unsafe" as const,
						restored: run.restored,
					};
				}
				const refused = codeFolderRefuses(run.area, cursorRecords, `worktrees/${input.workerId}`);
				if (refused.length > 0) throw new CodeHostRefusal("CODE_HOST_NAMES_FOLDER_REFUSES", refused);
			} else if (cursor !== ontoSha) {
				const { records } = await run.checkNamesIncremental(run.repo, ontoSha, cursor);
				const refused = codeFolderRefuses(run.area, records, `worktrees/${input.workerId}`);
				if (refused.length > 0) throw new CodeHostRefusal("CODE_HOST_NAMES_FOLDER_REFUSES", refused);
			}
			// WHY: Compare-and-swap avoids clobbering a concurrent commit; resetting the linked worktree keeps disk and index aligned with the moved branch ref.
			const updated = await run.git(run.repo, ["update-ref", branchRef, cursor, oldTip ?? ZERO]);
			if (updated.status !== 0) {
				return { status: "deferred" as const, ontoSha, reason: "cas_race" as const, restored: run.restored };
			}
			if (hasWorktree) {
				// WHY: On reset failure, CAS-rollback the ref and best-effort restore oldTip; if restore fails too, mark worktree_unsafe so half-checked-out files aren't mistaken for untouched.
				const reset = await run.git(wtAdmin, [`--work-tree=${wtTree}`, "reset", "--hard", "--quiet", cursor]);
				if (reset.status !== 0) {
					const rollbackArgs = oldTip
						? ["update-ref", branchRef, oldTip, cursor]
						: ["update-ref", "-d", branchRef, cursor];
					const rolledBack = await run.git(run.repo, rollbackArgs);
					if (rolledBack.status === 0) {
						const restoredTree = oldTip
							? await run.git(wtAdmin, [`--work-tree=${wtTree}`, "reset", "--hard", "--quiet", oldTip])
							: { status: 1 };
						// WHY: A partial checkout can leave files newly added in cursor as untracked on disk even after reset --hard oldTip exits 0; re-verify cleanliness before reporting worktree_dirty.
						const cleanAfterRestore =
							restoredTree.status === 0 &&
							(await run.clean([
								`--git-dir=${wtAdmin}`,
								`--work-tree=${wtTree}`,
								"status",
								"--porcelain",
								"-z",
								"--untracked-files=normal",
								"--ignore-submodules=all",
							]));
						return {
							status: "deferred" as const,
							ontoSha,
							reason: cleanAfterRestore ? ("worktree_dirty" as const) : ("worktree_unsafe" as const),
							restored: run.restored,
						};
					}
					worktreeSynced = false;
				}
			}
		}
		return {
			status: "clean" as const,
			ontoSha,
			branchHeadSha: cursor,
			rebasedChanges: rebased,
			...(input.updateBranchRef ? { worktreeSynced } : {}),
			restored: run.restored,
		};
	});
}

export async function composePreviewTree(
	job: CodeHostJob,
	input: ComposePreviewTreeInput,
): Promise<ComposePreviewTreeResult> {
	const repository = keptRepositoryOf(input.repository);
	if (input.baseSha !== undefined) assertSha(input.baseSha);
	if (input.exploration !== undefined) {
		if (!isUuid(input.exploration.sessionId)) throw new Error("INVALID_CODE_HOST_JOB");
		assertSha(input.exploration.baseSha);
		assertSha(input.exploration.headSha);
	}
	if (!Array.isArray(input.changes)) throw new Error("INVALID_CODE_HOST_JOB");
	for (const change of input.changes) {
		if (!isUuid(change.changeId)) throw new Error("INVALID_CODE_HOST_JOB");
		assertSha(change.parentSha);
		assertSha(change.headSha);
	}
	if (input.previewRefId !== undefined && !PREVIEW_ID.test(input.previewRefId)) {
		throw new Error("INVALID_CODE_HOST_JOB");
	}

	return withJob(job, repository, async (run) => {
		const { mainSha } = await prepareKeptArea(run);
		const baseSha = input.baseSha ?? mainSha;
		await assertAllCommits(run, [
			baseSha,
			...(input.exploration ? [input.exploration.baseSha, input.exploration.headSha] : []),
			...input.changes.flatMap((change) => [change.parentSha, change.headSha]),
		]);

		let cursorCommit = baseSha;
		let cursorTree = await treeOfCommit(run, baseSha, "CODE_HOST_PREVIEW_FAILED");
		const appliedChangeIds: string[] = [];

		if (input.exploration && input.exploration.baseSha !== input.exploration.headSha) {
			const applied = await applyRange(
				run,
				cursorCommit,
				input.exploration.baseSha,
				input.exploration.headSha,
				"CODE_HOST_PREVIEW_FAILED",
			);
			if (!applied.ok) {
				return {
					status: "conflicted" as const,
					baseSha,
					lastCleanCommitSha: cursorCommit,
					lastCleanTreeSha: cursorTree,
					appliedChangeIds,
					conflictingChangeId: input.exploration.sessionId,
					explorationConflicted: true,
					conflictPaths: applied.paths,
					restored: run.restored,
				};
			}
			if (applied.treeSha !== cursorTree) {
				cursorTree = applied.treeSha;
				cursorCommit = await commitTree(
					run,
					cursorTree,
					cursorCommit,
					`Preview exploration ${input.exploration.sessionId}`,
					[],
					"CODE_HOST_PREVIEW_FAILED",
				);
			}
		}

		for (const change of input.changes) {
			if (change.parentSha === change.headSha) {
				appliedChangeIds.push(change.changeId);
				continue;
			}
			const applied = await applyRange(
				run,
				cursorCommit,
				change.parentSha,
				change.headSha,
				"CODE_HOST_PREVIEW_FAILED",
			);
			if (!applied.ok) {
				return {
					status: "conflicted" as const,
					baseSha,
					lastCleanCommitSha: cursorCommit,
					lastCleanTreeSha: cursorTree,
					appliedChangeIds,
					conflictingChangeId: change.changeId,
					conflictPaths: applied.paths,
					restored: run.restored,
				};
			}
			if (applied.treeSha !== cursorTree) {
				cursorTree = applied.treeSha;
				cursorCommit = await commitTree(
					run,
					cursorTree,
					cursorCommit,
					`Preview change ${change.changeId}`,
					[],
					"CODE_HOST_PREVIEW_FAILED",
				);
			}
			appliedChangeIds.push(change.changeId);
		}

		let previewRef: string | null = null;
		if (input.previewRefId) {
			previewRef = `refs/qorpera/previews/${input.previewRefId}`;
			await run.gitOk(run.repo, ["update-ref", previewRef, cursorCommit], "CODE_HOST_PREVIEW_FAILED");
		}
		return {
			status: "ready" as const,
			baseSha,
			compositeCommitSha: cursorCommit,
			compositeTreeSha: cursorTree,
			appliedChangeIds,
			previewRef,
			restored: run.restored,
		};
	});
}

export async function inspectChangeRange(
	job: CodeHostJob,
	input: InspectChangeRangeInput,
): Promise<InspectChangeRangeResult> {
	const repository = keptRepositoryOf(input.repository);
	if (!isUuid(input.workerId)) throw new Error("INVALID_CODE_HOST_JOB");
	const parentSha = assertSha(input.parentSha);
	const headSha = assertSha(input.headSha);

	return withJob(job, repository, async (run) => {
		await prepareKeptArea(run);
		const branchRef = `refs/heads/qorpera/coding/${input.workerId}`;
		const branchTip = await run.ref(branchRef);
		if (!branchTip) throw new CodeHostRefusal("CODE_HOST_EXPORT_NO_BRANCH", [branchRef]);

		const onBranch = await run.git(run.repo, ["merge-base", "--is-ancestor", headSha, branchTip]);
		if (onBranch.status !== 0) throw new CodeHostRefusal("CODE_HOST_EXPORT_MOVED", [branchRef]);
		const ordered = await run.git(run.repo, ["merge-base", "--is-ancestor", parentSha, headSha]);
		if (ordered.status !== 0) throw new CodeHostRefusal("CODE_HOST_INVALID_CHANGE_RANGE", [parentSha, headSha]);

		const numstat = (
			await run.gitOk(
				run.repo,
				["diff", "--numstat", "--no-renames", "-z", parentSha, headSha],
				"CODE_HOST_INSPECT_FAILED",
				{ maximumOutputBytes: MAX_READ },
			)
		).toString("utf8");
		const entries = numstat.split("\0").filter(Boolean);
		const paths: string[] = [];
		let additions = 0;
		let deletions = 0;
		for (const entry of entries) {
			const parts = entry.split("\t");
			if (parts.length < 3) continue;
			const add = Number.parseInt(parts[0] ?? "0", 10);
			const del = Number.parseInt(parts[1] ?? "0", 10);
			if (Number.isFinite(add)) additions += add;
			if (Number.isFinite(del)) deletions += del;
			const filePath = parts.slice(2).join("\t");
			if (filePath) paths.push(filePath);
		}

		return {
			parentSha,
			headSha,
			affectedPaths: paths,
			diffStats: { filesChanged: paths.length, additions, deletions },
			restored: run.restored,
		};
	});
}

export interface EnsureSurfaceStarterRepositoryInput {
	readonly repository: CloudCodingRepository;
	readonly title?: string;
	readonly slug?: string;
}

export interface EnsureSurfaceStarterRepositoryResult {
	readonly status: "existing" | "created";
	readonly mainSha: string;
	readonly restored: readonly string[];
}

const STARTER_SURFACE_CHECKS_JSON = `${JSON.stringify(
	{
		site: { folder: "." },
		preview: { run: "true", folder: ".", cwd: ".", timeoutSeconds: 60 },
		checks: [{ name: "build", run: "true" }],
	},
	null,
	2,
)}\n`;

const STARTER_SURFACE_IDENTITY_CSS = compileIdentityTokensCss(
	JSON.stringify({
		colors: {
			surface: "#ffffff",
			ink: "#161615",
			muted: "#6b6966",
			accent: "#d76f45",
		},
		typography: {
			heading: "Georgia, serif",
			body: "system-ui, -apple-system, sans-serif",
		},
	}),
);

const STARTER_SURFACE_STYLES_CSS = `* {
	box-sizing: border-box;
}

body {
	margin: 0;
	background: var(--q-color-surface);
	color: var(--q-color-ink);
	font-family: var(--q-font-body);
	line-height: 1.5;
}

h1 {
	font-family: var(--q-font-heading);
	color: var(--q-color-ink);
}

a {
	color: var(--q-color-accent);
}

.surface-shell {
	max-width: 48rem;
	margin: 0 auto;
	padding: 4rem 1.5rem;
}

.surface-shell p {
	color: var(--q-color-muted);
}
`;

function escapeStarterHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function starterSurfaceIndexHtml(title: string): string {
	const safeTitle = escapeStarterHtml(title);
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>${safeTitle}</title>
	<link rel="stylesheet" href="./${SURFACE_IDENTITY_CSS_MOUNT_PATH}" />
	<link rel="stylesheet" href="./styles.css" />
</head>
<body>
	<main class="surface-shell">
		<h1>${safeTitle}</h1>
		<p>Ready for your first change.</p>
	</main>
</body>
</html>
`;
}

export async function ensureSurfaceStarterRepository(
	job: CodeHostJob,
	input: EnsureSurfaceStarterRepositoryInput,
): Promise<EnsureSurfaceStarterRepositoryResult> {
	const repository = keptRepositoryOf(input.repository);
	const base = `refs/heads/${repository.baseBranch}`;
	const displayTitle = input.title?.trim() || input.slug?.trim() || repository.name;

	return withJob(job, repository, async (run) => {
		const area = await run.prepare();
		if (!area.seeded) {
			await run.gitOk(
				run.repo,
				[
					"init",
					"--quiet",
					"--bare",
					"--template=",
					"--ref-format=files",
					`--initial-branch=${repository.baseBranch}`,
					run.repo,
				],
				"CODE_HOST_START_FAILED",
			);
			await run.write(`${run.repo}/config`, CODE_AREA_CONFIG);
			if (area.made) run.restored.push(run.relative(`${run.repo}/HEAD`));
		}

		let kept = await run.ref(CODE_AREA_IN_QORPERA_REF);
		const head = await run.ref(base);
		if (kept === null && head !== null) {
			throw new CodeHostRefusal("CODE_HOST_AREA_FROM_GITHUB", [run.area]);
		}
		if (head !== null) {
			const at =
				area.main === "present" &&
				(await run.read(`${run.repo}/worktrees/main/HEAD`))?.equals(Buffer.from(`${head}\n`)) === true;
			if (!at) {
				const records = await run.checkNames(run.repo, head);
				const refused = codeFolderRefuses(run.area, records, "main");
				if (refused.length > 0) throw new CodeHostRefusal("CODE_HOST_NAMES_FOLDER_REFUSES", refused);
				await moveBase(run, area.main, base, head, head);
			}
			return { status: "existing" as const, mainSha: head, restored: run.restored };
		}

		if (kept === null) {
			const encoder = new TextEncoder();
			const writeBlob = async (content: string): Promise<string> => {
				const sha = (
					await run.gitOk(run.repo, ["hash-object", "-w", "--stdin"], "CODE_HOST_START_FAILED", {
						stdin: encoder.encode(content),
					})
				)
					.toString("latin1")
					.trim();
				if (!SHA.test(sha)) throw new CodeHostJobFailure("CODE_HOST_START_FAILED", "hash-object produced no SHA");
				return sha;
			};
			const writeTree = async (entries: string): Promise<string> => {
				const sha = (
					await run.gitOk(run.repo, ["mktree"], "CODE_HOST_START_FAILED", {
						stdin: encoder.encode(entries),
					})
				)
					.toString("latin1")
					.trim();
				if (!SHA.test(sha)) throw new CodeHostJobFailure("CODE_HOST_START_FAILED", "mktree produced no SHA");
				return sha;
			};

			const checksBlob = await writeBlob(STARTER_SURFACE_CHECKS_JSON);
			const indexBlob = await writeBlob(starterSurfaceIndexHtml(displayTitle));
			const identityCssBlob = await writeBlob(STARTER_SURFACE_IDENTITY_CSS);
			const stylesBlob = await writeBlob(STARTER_SURFACE_STYLES_CSS);
			const qorperaTree = await writeTree(`100644 blob ${checksBlob}\tchecks.json\n`);
			const rootTree = await writeTree(
				`040000 tree ${qorperaTree}\t.qorpera\n100644 blob ${indexBlob}\tindex.html\n100644 blob ${identityCssBlob}\t${SURFACE_IDENTITY_CSS_MOUNT_PATH}\n100644 blob ${stylesBlob}\tstyles.css\n`,
			);
			const initialCommit = (
				await run.gitOk(
					run.repo,
					[...PLATFORM_COMMITTER, "commit-tree", rootTree, "-m", `Initialize ${displayTitle} surface`],
					"CODE_HOST_START_FAILED",
				)
			)
				.toString("latin1")
				.trim();
			if (!SHA.test(initialCommit)) {
				throw new CodeHostJobFailure("CODE_HOST_START_FAILED", "commit-tree produced no SHA");
			}
			await run.gitOk(
				run.repo,
				["update-ref", "--no-deref", CODE_AREA_IN_QORPERA_REF, initialCommit, ZERO],
				"CODE_HOST_START_FAILED",
			);
			kept = initialCommit;
		}

		await moveBase(run, area.main, base, kept, ZERO);
		return { status: "created" as const, mainSha: kept, restored: run.restored };
	});
}

export interface VerifyStagedSurfaceBranchInput {
	readonly repository: CloudCodingRepository;
	readonly workerId: string;
	readonly baseSha: string;
	readonly headSha: string;
}

export interface VerifyStagedSurfaceBranchResult {
	readonly branch: string;
	readonly baseSha: string;
	readonly headSha: string;
	readonly changed: boolean;
	readonly filesChanged: number;
	readonly restored: readonly string[];
}

export async function verifyStagedSurfaceBranch(
	job: CodeHostJob,
	input: VerifyStagedSurfaceBranchInput,
): Promise<VerifyStagedSurfaceBranchResult> {
	const repository = keptRepositoryOf(input.repository);
	if (!isUuid(input.workerId)) throw new Error("INVALID_CODE_HOST_JOB");
	const baseSha = assertSha(input.baseSha);
	const headSha = assertSha(input.headSha);
	const branch = `qorpera/coding/${input.workerId}`;
	const ref = `refs/heads/${branch}`;
	return await withJob(job, repository, async (run) => {
		const { area } = await prepareKeptArea(run);
		void area;
		const branchTip = await run.ref(ref);
		if (!branchTip) throw new CodeHostRefusal("CODE_HOST_EXPORT_NO_BRANCH", [ref]);
		const [hasBase, hasHead] = await run.areCommits(run.repo, [baseSha, headSha]);
		if (!hasBase) throw new CodeHostRefusal("CODE_HOST_BASE_UNKNOWN", [baseSha]);
		if (!hasHead) throw new CodeHostRefusal("CODE_HOST_EXPORT_MOVED", [ref]);
		const held = await run.git(run.repo, ["merge-base", "--is-ancestor", headSha, branchTip]);
		if (held.status === 1) throw new CodeHostRefusal("CODE_HOST_EXPORT_MOVED", [ref]);
		if (held.status !== 0) throw new CodeHostJobFailure("CODE_HOST_EXPORT_FAILED", tail(held.stderr));
		await assertOrderedRange(run, baseSha, headSha, "CODE_HOST_EXPORT_FAILED");
		const beyond = await run.gitOk(
			run.repo,
			["rev-list", "--max-count=1", headSha, `^${baseSha}`],
			"CODE_HOST_EXPORT_FAILED",
		);
		if (!beyond.length) {
			return { branch, baseSha, headSha, changed: false, filesChanged: 0, restored: run.restored };
		}
		const { records } = await run.checkNamesIncremental(run.repo, baseSha, headSha);
		const refused = codeFolderRefuses(run.area, records, CODE_FOLDER_ANY_SESSION);
		if (refused.length > 0) throw new CodeHostRefusal("CODE_HOST_NAMES_FOLDER_REFUSES", refused);
		const changedPaths = await diffPathsBetween(run, baseSha, headSha, "CODE_HOST_EXPORT_FAILED");
		return {
			branch,
			baseSha,
			headSha,
			changed: true,
			filesChanged: changedPaths.length,
			restored: run.restored,
		};
	});
}
