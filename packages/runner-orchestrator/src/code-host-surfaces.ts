import { type CloudCodingRepository, isUuid } from "@qorpera/contracts";
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
}

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

// WHY: Synthetic commits parented on parentSha pin merge-base universally on Git 2.38+ without mutating refs or worktrees.
async function applyRange(
	run: Run,
	cursorCommit: string,
	parentSha: string,
	headSha: string,
	errorCode: string,
): Promise<
	{ readonly ok: true; readonly treeSha: string } | { readonly ok: false; readonly paths: readonly string[] }
> {
	const cursorTree = await treeOfCommit(run, cursorCommit, errorCode);
	const headTree = await treeOfCommit(run, headSha, errorCode);
	const ours = await commitTree(run, cursorTree, parentSha, "qorpera merge ours", [], errorCode);
	const theirs = await commitTree(run, headTree, parentSha, "qorpera merge theirs", [], errorCode);
	const merged = await run.git(
		run.repo,
		["merge-tree", "--write-tree", "-z", "--name-only", "--no-messages", ours, theirs],
		{ maximumOutputBytes: MAX_READ },
	);
	const fields = merged.stdout.toString("utf8").split("\0");
	if (merged.status === 1) {
		return { ok: false, paths: [...new Set(fields.slice(1).filter(Boolean))] };
	}
	if (merged.status !== 0 || !SHA.test(fields[0] ?? "")) {
		throw new CodeHostJobFailure(errorCode, tail(merged.stderr));
	}
	return { ok: true, treeSha: fields[0] as string };
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
		for (const change of input.changes) {
			if (!(await run.isCommit(run.repo, change.parentSha)) || !(await run.isCommit(run.repo, change.headSha))) {
				throw new CodeHostRefusal("CODE_HOST_UNKNOWN_COMMIT", [change.parentSha, change.headSha]);
			}
		}

		let cursor = mainSha;
		const landedCommits: { changeId: string; commitSha: string }[] = [];
		for (const change of input.changes) {
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
			const cursorTree = await treeOfCommit(run, cursor, "CODE_HOST_CHERRY_PICK_FAILED");
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
			landedCommits.push({ changeId: change.changeId, commitSha: cursor });
		}

		const records = await run.checkNames(run.repo, cursor);
		const refused = codeFolderRefuses(run.area, records, CODE_FOLDER_ANY_SESSION);
		if (refused.length > 0) throw new CodeHostRefusal("CODE_HOST_NAMES_FOLDER_REFUSES", refused);

		const paths = await diffPathsBetween(run, mainSha, cursor, "CODE_HOST_CHERRY_PICK_FAILED");
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

export async function rebaseSessionChanges(
	job: CodeHostJob,
	input: RebaseSessionChangesInput,
): Promise<RebaseSessionChangesResult> {
	const repository = keptRepositoryOf(input.repository);
	if (!isUuid(input.workerId)) throw new Error("INVALID_CODE_HOST_JOB");
	const ontoSha = assertSha(input.ontoSha);
	if (!Array.isArray(input.remainingChanges)) throw new Error("INVALID_CODE_HOST_JOB");
	for (const change of input.remainingChanges) assertChangeRange(change);

	return withJob(job, repository, async (run) => {
		await prepareKeptArea(run);
		if (!(await run.isCommit(run.repo, ontoSha))) {
			throw new CodeHostRefusal("CODE_HOST_UNKNOWN_COMMIT", [ontoSha]);
		}

		let cursor = ontoSha;
		const rebased: { changeId: string; parentSha: string; headSha: string }[] = [];
		for (const change of input.remainingChanges) {
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
			const nextSha = await commitTree(
				run,
				applied.treeSha,
				cursor,
				change.title.trim(),
				[`Qorpera-Change: ${change.changeId}`],
				"CODE_HOST_REBASE_FAILED",
			);
			rebased.push({ changeId: change.changeId, parentSha: cursor, headSha: nextSha });
			cursor = nextSha;
		}

		if (input.updateBranchRef) {
			const branchRef = `refs/heads/qorpera/coding/${input.workerId}`;
			await run.gitOk(run.repo, ["update-ref", branchRef, cursor], "CODE_HOST_REBASE_FAILED");
		}
		return {
			status: "clean" as const,
			ontoSha,
			branchHeadSha: cursor,
			rebasedChanges: rebased,
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
		if (!(await run.isCommit(run.repo, baseSha))) {
			throw new CodeHostRefusal("CODE_HOST_UNKNOWN_COMMIT", [baseSha]);
		}

		let cursorCommit = baseSha;
		let cursorTree = await treeOfCommit(run, baseSha, "CODE_HOST_PREVIEW_FAILED");
		const appliedChangeIds: string[] = [];

		if (input.exploration) {
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
					conflictPaths: applied.paths,
					restored: run.restored,
				};
			}
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

		for (const change of input.changes) {
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
			cursorTree = applied.treeSha;
			cursorCommit = await commitTree(
				run,
				cursorTree,
				cursorCommit,
				`Preview change ${change.changeId}`,
				[],
				"CODE_HOST_PREVIEW_FAILED",
			);
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
			await run.gitOk(run.repo, ["diff", "--numstat", "-z", parentSha, headSha], "CODE_HOST_INSPECT_FAILED", {
				maximumOutputBytes: MAX_READ,
			})
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

const STARTER_SURFACE_STYLES_CSS = `:root {
	--surface-bg: #ffffff;
	--surface-ink: #161615;
	--surface-muted: #6b6966;
	--surface-accent: #d76f45;
	--surface-font-sans: system-ui, -apple-system, sans-serif;
}

* {
	box-sizing: border-box;
}

body {
	margin: 0;
	background: var(--surface-bg);
	color: var(--surface-ink);
	font-family: var(--surface-font-sans);
	line-height: 1.5;
}

.surface-shell {
	max-width: 48rem;
	margin: 0 auto;
	padding: 4rem 1.5rem;
}

.surface-shell p {
	color: var(--surface-muted);
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
			if (!at) await moveBase(run, area.main, base, head, head);
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
			const stylesBlob = await writeBlob(STARTER_SURFACE_STYLES_CSS);
			const qorperaTree = await writeTree(`100644 blob ${checksBlob}\tchecks.json\n`);
			const rootTree = await writeTree(
				`040000 tree ${qorperaTree}\t.qorpera\n100644 blob ${indexBlob}\tindex.html\n100644 blob ${stylesBlob}\tstyles.css\n`,
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
