import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	addCodeWorktree,
	type CodeHostCommand,
	type CodeHostJob,
	type CodeHostShell,
	startCodeArea,
} from "../src/code-host-jobs.ts";
import { cherryPickChangeUnits } from "../src/code-host-surfaces.ts";
import { SupabaseCloudRunnerOrchestratorControlPlane } from "../src/orchestrator.ts";
import {
	assertSurfaceFolderPatchPath,
	collectSharedCompanyAssets,
	createSurfaceExecutionHandlers,
	InMemorySurfaceFolderSnapshotStore,
	parseSurfaceRepositoryKey,
	type SurfaceCompanyFolderPort,
	undoSurfaceCodeRepoChange,
} from "../src/surface-execution-bridge.ts";
import { SurfaceWorkerLoop } from "../src/surface-worker-loop.ts";
import { localShell } from "./helpers/code-host-shell.ts";

const exec = promisify(execFile);
const GIT = "/usr/bin/git";
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// WHY: Adapts GNU coreutils paths and Apple Git 2.39 flags solely within local macOS tests.
function crossPlatformLocalShell(log: CodeHostCommand[]): CodeHostShell {
	const inner = localShell(log);
	return {
		run(command, signal) {
			let argv = [...command.argv];
			const bin = argv[0];
			if (bin?.startsWith("/usr/bin/") && !existsSync(bin)) {
				const alt = `/bin/${bin.slice("/usr/bin/".length)}`;
				if (existsSync(alt)) argv[0] = alt;
			}
			if (process.platform === "darwin") {
				if (argv[0] === GIT && argv.includes("--ref-format=files")) {
					argv = argv.filter((arg) => arg !== "--ref-format=files");
				}
				if (
					(argv[0] === "/bin/sh" || argv[0] === "/usr/bin/sh") &&
					argv[1] === "-c" &&
					typeof argv[2] === "string"
				) {
					argv[2] = argv[2].replaceAll("mv -fT ", "mv -f ");
				}
			}
			return inner.run({ ...command, argv }, signal);
		},
	};
}

async function createGitSurfaceFixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "surface-bridge-")));
	roots.push(root);
	const companyRoot = join(root, "folder");
	const scratchRoot = join(root, "scratch");
	await mkdir(companyRoot, { recursive: true });
	await mkdir(scratchRoot, { recursive: true });
	const log: CodeHostCommand[] = [];
	const job: CodeHostJob = {
		shell: crossPlatformLocalShell(log),
		layout: { companyRoot, scratchRoot, git: GIT },
		signal: new AbortController().signal,
	};
	const repository = { host: "qorpera" as const, owner: "thetaband", name: "website", baseBranch: "main" };
	const started = await startCodeArea(job, { repository });
	const code = join(companyRoot, "code/thetaband/website");
	const env = {
		PATH: "/usr/bin:/bin",
		HOME: root,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_AUTHOR_NAME: "Session",
		GIT_AUTHOR_EMAIL: "session@example.invalid",
		GIT_COMMITTER_NAME: "Session",
		GIT_COMMITTER_EMAIL: "session@example.invalid",
	};
	const git = async (cwd: string, ...args: string[]) => (await exec(GIT, args, { cwd, env })).stdout.trim();
	const startSession = async (baseSha = started.baseSha) => {
		const workerId = randomUUID();
		await addCodeWorktree(job, { repository, workerId, baseSha });
		const worktree = join(code, "worktrees", workerId);
		const commit = async (files: Record<string, string>, message: string) => {
			for (const [filePath, content] of Object.entries(files)) {
				await mkdir(dirname(join(worktree, filePath)), { recursive: true });
				await writeFile(join(worktree, filePath), content);
			}
			await git(worktree, "add", "--all");
			await git(worktree, "commit", "--quiet", "-m", message);
			return git(worktree, "rev-parse", "HEAD");
		};
		return { workerId, commit };
	};
	return { job, repository, baseSha: started.baseSha, code, startSession };
}

function createInMemoryCompanyFolder(initial: Record<string, string> = {}) {
	const files = new Map<string, string>(Object.entries(initial));
	const versions = new Map<string, number>();
	for (const key of files.keys()) versions.set(key, 1);
	let seq = 1;
	const writeCalls: { path: string; content: string }[] = [];
	const deleteCalls: string[] = [];
	const commitCalls: readonly { path: string; expectedVersion: string | null; content: string | null }[][] = [];
	const versionOf = (path: string): string | null => {
		const ver = versions.get(path);
		return ver === undefined ? null : `v${ver}`;
	};
	const mutateExternal = (path: string, content: string | null): void => {
		seq += 1;
		if (content === null) {
			files.delete(path);
			versions.delete(path);
		} else {
			files.set(path, content);
			versions.set(path, seq);
		}
	};
	const folder: SurfaceCompanyFolderPort = {
		async readFiles({ paths }) {
			const out: Record<string, string | null> = {};
			for (const path of paths) {
				out[path] = files.has(path) ? (files.get(path) as string) : null;
			}
			return out;
		},
		async readFilesWithVersions({ paths }) {
			const out: Record<string, { readonly content: string | null; readonly version: string | null }> = {};
			for (const path of paths) {
				out[path] = {
					content: files.has(path) ? (files.get(path) as string) : null,
					version: versionOf(path),
				};
			}
			return out;
		},
		async commitFiles({ operations }) {
			const conflictPaths: string[] = [];
			for (const op of operations) {
				if (versionOf(op.path) !== op.expectedVersion) {
					conflictPaths.push(op.path);
				}
			}
			if (conflictPaths.length > 0) {
				return { status: "conflict", conflictPaths };
			}
			(commitCalls as { path: string; expectedVersion: string | null; content: string | null }[][]).push(
				operations.map((op) => ({ ...op })),
			);
			seq += 1;
			const versionsAfter: Record<string, string | null> = {};
			for (const op of operations) {
				if (op.content === null) {
					deleteCalls.push(op.path);
					files.delete(op.path);
					versions.delete(op.path);
					versionsAfter[op.path] = null;
				} else {
					writeCalls.push({ path: op.path, content: op.content });
					files.set(op.path, op.content);
					versions.set(op.path, seq);
					versionsAfter[op.path] = `v${seq}`;
				}
			}
			return { status: "saved", versionsAfter };
		},
	};
	return { files, writeCalls, deleteCalls, commitCalls, mutateExternal, folder };
}

describe("surface execution bridge helpers", () => {
	it("parses repositoryKey and confines folder patch paths strictly within folderRoot", () => {
		expect(parseSurfaceRepositoryKey("thetaband/website")).toEqual({
			host: "qorpera",
			owner: "thetaband",
			name: "website",
			baseBranch: "main",
		});
		expect(parseSurfaceRepositoryKey("invalid")).toBeNull();
		expect(parseSurfaceRepositoryKey("a/b/c")).toBeNull();
		expect(parseSurfaceRepositoryKey(null)).toBeNull();

		expect(assertSurfaceFolderPatchPath("identity/tokens.json", "identity")).toBe("identity/tokens.json");
		expect(assertSurfaceFolderPatchPath("identity/sub/voice.md", "identity/")).toBe("identity/sub/voice.md");
		expect(() => assertSurfaceFolderPatchPath("identity/../secrets.md", "identity")).toThrow(/traversal/i);
		expect(() => assertSurfaceFolderPatchPath("finance/budget.md", "identity")).toThrow(/outside/i);
		expect(() => assertSurfaceFolderPatchPath("identity-other/tokens.json", "identity")).toThrow(/outside/i);
		expect(() => assertSurfaceFolderPatchPath("/identity/tokens.json", "identity")).toThrow(/escapes/i);
	});
});

describe("surface execution bridge codebase previews and merges", () => {
	it("composes multi-change codebase previews with exploration overlay and detects toggle conflicts", async () => {
		const f = await createGitSurfaceFixture();
		const seed = await f.startSession();
		const seedHead = await seed.commit({ "index.html": "<main>Baseline</main>\n" }, "Seed baseline");
		const base = await cherryPickChangeUnits(f.job, {
			repository: f.repository,
			changes: [{ changeId: randomUUID(), parentSha: f.baseSha, headSha: seedHead, title: "Seed baseline" }],
		});

		const explorationSession = await f.startSession(base.mainAfter);
		const expSessionId = randomUUID();
		const expHead = await explorationSession.commit({ "theme.css": ":root { --bg: #f8f6f2; }\n" }, "Aftenlys theme");

		const s1 = await f.startSession(base.mainAfter);
		const c1Id = randomUUID();
		const c1Head = await s1.commit({ "faq.html": "<section>FAQ</section>\n" }, "Add FAQ");

		const s2 = await f.startSession(base.mainAfter);
		const c2Id = randomUUID();
		const c2Head = await s2.commit({ "index.html": "<main>Hero A</main>\n" }, "Hero A");

		const s3 = await f.startSession(base.mainAfter);
		const c3Id = randomUUID();
		const c3Head = await s3.commit({ "index.html": "<main>Hero B</main>\n" }, "Hero B");

		const surfaceId = randomUUID();
		const profileId = randomUUID();
		const siteVersionId = randomUUID();

		const completeSurfacePreview = vi.fn().mockResolvedValue(undefined);
		const buildAndUploadPreview = vi.fn().mockResolvedValue({ siteVersionId });
		const handlers = createSurfaceExecutionHandlers({
			controlPlane: {
				completeSurfacePreview,
				completeSurfaceMerge: vi.fn(),
				completeSurfacePublish: vi.fn(),
			},
			resolveCodeHostJob: () => f.job,
			buildAndUploadPreview,
		});

		const previewId1 = randomUUID();
		await handlers.runPreviewJob(
			{
				previewId: previewId1,
				surfaceId,
				profileId,
				shortHostId: "a1b2c3d4",
				baseSha: base.mainAfter,
				selectedChangeIds: [c1Id, c2Id],
				repositoryKey: "thetaband/website",
				exploration: { sessionId: expSessionId, baseSha: base.mainAfter, headSha: expHead },
				changes: [
					{ changeId: c1Id, parentSha: base.mainAfter, headSha: c1Head, title: "Add FAQ" },
					{ changeId: c2Id, parentSha: base.mainAfter, headSha: c2Head, title: "Hero A" },
				],
			},
			new AbortController().signal,
		);

		expect(buildAndUploadPreview).toHaveBeenCalledTimes(1);
		expect(completeSurfacePreview).toHaveBeenCalledWith(
			expect.objectContaining({
				previewId: previewId1,
				status: "ready",
				siteVersionId,
				conflictReport: null,
			}),
			expect.any(AbortSignal),
		);

		buildAndUploadPreview.mockClear();
		completeSurfacePreview.mockClear();
		const previewId2 = randomUUID();
		await handlers.runPreviewJob(
			{
				previewId: previewId2,
				surfaceId,
				profileId,
				shortHostId: "e5f6a7b8",
				baseSha: base.mainAfter,
				selectedChangeIds: [c2Id, c3Id],
				repositoryKey: "thetaband/website",
				exploration: null,
				changes: [
					{ changeId: c2Id, parentSha: base.mainAfter, headSha: c2Head, title: "Hero A" },
					{ changeId: c3Id, parentSha: base.mainAfter, headSha: c3Head, title: "Hero B" },
				],
			},
			new AbortController().signal,
		);

		expect(buildAndUploadPreview).not.toHaveBeenCalled();
		expect(completeSurfacePreview).toHaveBeenCalledWith(
			expect.objectContaining({
				previewId: previewId2,
				status: "conflicted",
				conflictReport: { changeIds: [c2Id, c3Id], paths: ["index.html"] },
			}),
			expect.any(AbortSignal),
		);

		completeSurfacePreview.mockClear();
		const previewId3 = randomUUID();
		await handlers.runPreviewJob(
			{
				previewId: previewId3,
				surfaceId,
				profileId,
				shortHostId: "99aabbcc",
				baseSha: base.mainAfter,
				selectedChangeIds: [],
				repositoryKey: "not-valid-key",
			},
			new AbortController().signal,
		);
		expect(completeSurfacePreview).toHaveBeenCalledWith(
			expect.objectContaining({
				previewId: previewId3,
				status: "failed",
				errorDetail: expect.stringContaining("Invalid surface repositoryKey"),
			}),
			expect.any(AbortSignal),
		);
	}, 20_000);

	it("lands selective cherry-picks, rebases sibling and peer sessions, reports conflicts, and supports code_repo undo", async () => {
		const f = await createGitSurfaceFixture();
		const seed = await f.startSession();
		const seedHead = await seed.commit({ "hero.html": "<h1>Old</h1>\n" }, "Seed hero");
		const base = await cherryPickChangeUnits(f.job, {
			repository: f.repository,
			changes: [{ changeId: randomUUID(), parentSha: f.baseSha, headSha: seedHead, title: "Seed hero" }],
		});

		const mainSession = await f.startSession(base.mainAfter);
		const c1Id = randomUUID();
		const c2Id = randomUUID();
		const c1Head = await mainSession.commit({ "hero.html": "<h1>Aftenlys</h1>\n" }, "Hero headline");
		const c2Head = await mainSession.commit({ "faq.html": "<section>FAQ</section>\n" }, "FAQ section");

		const peerClean = await f.startSession(base.mainAfter);
		const peerCleanSessionId = randomUUID();
		const peerCleanChangeId = randomUUID();
		const peerCleanHead = await peerClean.commit({ "footer.html": "<footer>DK</footer>\n" }, "Footer");

		const peerConflict = await f.startSession(base.mainAfter);
		const peerConflictSessionId = randomUUID();
		const peerConflictChangeId = randomUUID();
		const peerConflictHead = await peerConflict.commit({ "hero.html": "<h1>Varmt studie</h1>\n" }, "Alt hero");

		const surfaceId = randomUUID();
		const profileId = randomUUID();
		const sessionId = randomUUID();
		const completeSurfaceMerge = vi.fn().mockResolvedValue(undefined);
		const onSessionChangesRebased = vi.fn().mockResolvedValue(undefined);

		const handlers = createSurfaceExecutionHandlers({
			controlPlane: {
				completeSurfacePreview: vi.fn(),
				completeSurfaceMerge,
				completeSurfacePublish: vi.fn(),
			},
			resolveCodeHostJob: () => f.job,
			onSessionChangesRebased,
			undoCodeRepoChange: (input) => undoSurfaceCodeRepoChange(f.job, { ...input, andLater: true }),
		});

		const landJobId = randomUUID();
		await handlers.runMergeJob(
			{
				jobId: landJobId,
				kind: "land_change",
				surfaceId,
				sessionId,
				profileId,
				sourceKind: "code_repo",
				repositoryKey: "thetaband/website",
				folderRoot: null,
				autoPublish: false,
				expectMainSha: base.mainAfter,
				sessionWorkerId: mainSession.workerId,
				sessionState: "ready",
				sessionHasActiveChat: false,
				payload: { changeIds: [c1Id], autoPublish: false },
				allSessionChangeStatuses: [
					{ changeId: c1Id, status: "merging" },
					{ changeId: c2Id, status: "staged" },
				],
				approvedChanges: [
					{
						changeId: c1Id,
						kind: "git_range",
						parentSha: base.mainAfter,
						headSha: c1Head,
						title: "Hero headline",
						summary: "Update hero",
						patchManifest: null,
						affectedPaths: ["hero.html"],
					},
				],
				siblingRemainingChanges: [{ changeId: c2Id, parentSha: c1Head, headSha: c2Head, title: "FAQ section" }],
				peerSessions: [
					{
						sessionId: peerCleanSessionId,
						workerId: peerClean.workerId,
						remainingChanges: [
							{
								changeId: peerCleanChangeId,
								parentSha: base.mainAfter,
								headSha: peerCleanHead,
								title: "Footer",
							},
						],
					},
					{
						sessionId: peerConflictSessionId,
						workerId: peerConflict.workerId,
						remainingChanges: [
							{
								changeId: peerConflictChangeId,
								parentSha: base.mainAfter,
								headSha: peerConflictHead,
								title: "Alt hero",
							},
						],
					},
				],
			},
			new AbortController().signal,
		);

		expect(completeSurfaceMerge).toHaveBeenCalledTimes(1);
		const landCall = completeSurfaceMerge.mock.calls[0]?.[0];
		expect(landCall).toMatchObject({
			jobId: landJobId,
			status: "landed",
			mainBefore: base.mainAfter,
		});
		expect(typeof landCall.mainAfter).toBe("string");
		expect(await readFile(join(f.code, "main/hero.html"), "utf8")).toBe("<h1>Aftenlys</h1>\n");
		expect(existsSync(join(f.code, "main/faq.html"))).toBe(false);

		expect(onSessionChangesRebased).toHaveBeenCalledTimes(1);
		const rebasedEvent = onSessionChangesRebased.mock.calls[0]?.[0];
		expect(rebasedEvent.siblingRebase?.status).toBe("clean");
		expect(rebasedEvent.peerSync[0]?.result.status).toBe("clean");
		expect(rebasedEvent.peerSync[1]?.result.status).toBe("conflicted");
		expect(rebasedEvent.peerSync[1]?.result.conflictPaths).toEqual(["hero.html"]);

		completeSurfaceMerge.mockClear();
		const conflictJobId = randomUUID();
		await handlers.runMergeJob(
			{
				jobId: conflictJobId,
				kind: "land_change",
				surfaceId,
				sessionId: peerConflictSessionId,
				profileId,
				sourceKind: "code_repo",
				repositoryKey: "thetaband/website",
				folderRoot: null,
				expectMainSha: landCall.mainAfter,
				sessionWorkerId: peerConflict.workerId,
				payload: { changeIds: [peerConflictChangeId] },
				approvedChanges: [
					{
						changeId: peerConflictChangeId,
						kind: "git_range",
						parentSha: base.mainAfter,
						headSha: peerConflictHead,
						title: "Alt hero",
						summary: "",
						patchManifest: null,
						affectedPaths: ["hero.html"],
					},
				],
				siblingRemainingChanges: [],
				peerSessions: [],
			},
			new AbortController().signal,
		);

		expect(completeSurfaceMerge).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: conflictJobId,
				status: "conflicted",
				conflictChangeId: peerConflictChangeId,
				conflictPaths: ["hero.html"],
			}),
			expect.any(AbortSignal),
		);

		completeSurfaceMerge.mockClear();
		const undoJobId = randomUUID();
		await handlers.runMergeJob(
			{
				jobId: undoJobId,
				kind: "undo_change",
				surfaceId,
				sessionId,
				profileId,
				sourceKind: "code_repo",
				repositoryKey: "thetaband/website",
				folderRoot: null,
				payload: {
					changeId: c1Id,
					landedMainBefore: landCall.mainBefore,
					landedMainAfter: landCall.mainAfter,
				},
			},
			new AbortController().signal,
		);

		expect(completeSurfaceMerge).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: undoJobId,
				status: "landed",
				mainBefore: landCall.mainAfter,
			}),
			expect.any(AbortSignal),
		);
		expect(await readFile(join(f.code, "main/hero.html"), "utf8")).toBe("<h1>Old</h1>\n");

		const noUndoComplete = vi.fn().mockResolvedValue(undefined);
		const noUndoHandlers = createSurfaceExecutionHandlers({
			controlPlane: {
				completeSurfacePreview: vi.fn(),
				completeSurfaceMerge: noUndoComplete,
				completeSurfacePublish: vi.fn(),
			},
		});
		const failedUndoJobId = randomUUID();
		await noUndoHandlers.runMergeJob(
			{
				jobId: failedUndoJobId,
				kind: "undo_change",
				surfaceId,
				sessionId,
				profileId,
				sourceKind: "code_repo",
				repositoryKey: "thetaband/website",
				folderRoot: null,
				payload: {
					changeId: c1Id,
					landedMainBefore: landCall.mainBefore,
					landedMainAfter: landCall.mainAfter,
				},
			},
			new AbortController().signal,
		);
		expect(noUndoComplete).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: failedUndoJobId,
				status: "failed",
				errorDetail: expect.stringContaining("undo handler is not configured"),
			}),
			expect.any(AbortSignal),
		);
	}, 20_000);
});

describe("surface execution bridge Company Folder studio patches and publishing", () => {
	it("lands multi-change folder_patch into Company Files, enforces folderRoot confinement, detects conflicts, and restores undo snapshots", async () => {
		const profileId = randomUUID();
		const surfaceId = randomUUID();
		const sessionId = randomUUID();
		const c1Id = randomUUID();
		const c2Id = randomUUID();

		const mem = createInMemoryCompanyFolder({
			"identity/tokens.json": `${JSON.stringify({ colors: { ink: "#161615" } }, null, 2)}\n`,
			"identity/deprecated.md": "Legacy copy\n",
		});
		const snapshots = new InMemorySurfaceFolderSnapshotStore();
		const completeSurfaceMerge = vi.fn().mockResolvedValue(undefined);
		const handlers = createSurfaceExecutionHandlers({
			controlPlane: {
				completeSurfacePreview: vi.fn(),
				completeSurfaceMerge,
				completeSurfacePublish: vi.fn(),
			},
			folder: mem.folder,
			folderSnapshots: snapshots,
		});

		const landJobId = randomUUID();
		await handlers.runMergeJob(
			{
				jobId: landJobId,
				kind: "land_change",
				surfaceId,
				sessionId,
				profileId,
				sourceKind: "folder",
				repositoryKey: null,
				folderRoot: "identity",
				payload: { changeIds: [c1Id, c2Id] },
				approvedChanges: [
					{
						changeId: c1Id,
						kind: "folder_patch",
						parentSha: null,
						headSha: null,
						title: "Set accent color",
						summary: "",
						patchManifest: [
							{ op: "merge_json", path: "identity/tokens.json", patch: { colors: { accent: "#d76f45" } } },
							{ op: "write_text", path: "identity/voice.md", content: "Warm, Nordic, concise.\n" },
						],
						affectedPaths: ["identity/tokens.json", "identity/voice.md"],
					},
					{
						changeId: c2Id,
						kind: "folder_patch",
						parentSha: null,
						headSha: null,
						title: "Set paper color and remove legacy doc",
						summary: "",
						patchManifest: [
							{ op: "merge_json", path: "identity/tokens.json", patch: { colors: { paper: "#f8f6f2" } } },
							{ op: "delete", path: "identity/deprecated.md" },
						],
						affectedPaths: ["identity/tokens.json", "identity/deprecated.md"],
					},
				],
			},
			new AbortController().signal,
		);

		expect(completeSurfaceMerge).toHaveBeenCalledTimes(1);
		const landReport = completeSurfaceMerge.mock.calls[0]?.[0];
		expect(landReport.status).toBe("landed");
		expect(landReport.mainBefore).toMatch(/^[0-9a-f]{64}$/);
		expect(landReport.mainAfter).toMatch(/^[0-9a-f]{64}$/);
		expect(landReport.mainBefore).not.toBe(landReport.mainAfter);

		expect(JSON.parse(mem.files.get("identity/tokens.json") ?? "{}")).toEqual({
			colors: { ink: "#161615", accent: "#d76f45", paper: "#f8f6f2" },
		});
		const compiledCss = mem.files.get("identity/tokens.css") ?? "";
		expect(compiledCss).toContain("--q-color-ink: #161615;");
		expect(compiledCss).toContain("--q-color-accent: #d76f45;");
		expect(compiledCss).toContain("--q-color-paper: #f8f6f2;");
		expect(mem.files.get("identity/voice.md")).toBe("Warm, Nordic, concise.\n");
		expect(mem.files.has("identity/deprecated.md")).toBe(false);

		completeSurfaceMerge.mockClear();
		const writesBeforeEscape = mem.writeCalls.length;
		const escapeJobId = randomUUID();
		await handlers.runMergeJob(
			{
				jobId: escapeJobId,
				kind: "land_change",
				surfaceId,
				sessionId,
				profileId,
				sourceKind: "folder",
				repositoryKey: null,
				folderRoot: "identity",
				payload: { changeIds: [randomUUID()] },
				approvedChanges: [
					{
						changeId: randomUUID(),
						kind: "folder_patch",
						parentSha: null,
						headSha: null,
						title: "Escape attempt",
						summary: "",
						patchManifest: [{ op: "write_text", path: "finance/budget.md", content: "hacked\n" }],
						affectedPaths: ["finance/budget.md"],
					},
				],
			},
			new AbortController().signal,
		);

		expect(mem.writeCalls.length).toBe(writesBeforeEscape);
		expect(mem.files.has("finance/budget.md")).toBe(false);
		expect(completeSurfaceMerge).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: escapeJobId,
				status: "failed",
				errorDetail: expect.stringContaining("outside surface folderRoot"),
			}),
			expect.any(AbortSignal),
		);

		completeSurfaceMerge.mockClear();
		const conflictChange1 = randomUUID();
		const conflictChange2 = randomUUID();
		const writesBeforeConflict = mem.writeCalls.length;
		const conflictJobId = randomUUID();
		await handlers.runMergeJob(
			{
				jobId: conflictJobId,
				kind: "land_change",
				surfaceId,
				sessionId,
				profileId,
				sourceKind: "folder",
				repositoryKey: null,
				folderRoot: "identity",
				payload: { changeIds: [conflictChange1, conflictChange2] },
				approvedChanges: [
					{
						changeId: conflictChange1,
						kind: "folder_patch",
						parentSha: null,
						headSha: null,
						title: "Warm accent",
						summary: "",
						patchManifest: [
							{ op: "merge_json", path: "identity/tokens.json", patch: { colors: { accent: "#c9643b" } } },
						],
						affectedPaths: ["identity/tokens.json"],
					},
					{
						changeId: conflictChange2,
						kind: "folder_patch",
						parentSha: null,
						headSha: null,
						title: "Cool accent",
						summary: "",
						patchManifest: [
							{ op: "merge_json", path: "identity/tokens.json", patch: { colors: { accent: "#1f5e5b" } } },
						],
						affectedPaths: ["identity/tokens.json"],
					},
				],
			},
			new AbortController().signal,
		);

		expect(mem.writeCalls.length).toBe(writesBeforeConflict);
		expect(completeSurfaceMerge).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: conflictJobId,
				status: "conflicted",
				conflictChangeId: conflictChange2,
				conflictPaths: ["identity/tokens.json"],
			}),
			expect.any(AbortSignal),
		);

		completeSurfaceMerge.mockClear();
		const undoJobId = randomUUID();
		await handlers.runMergeJob(
			{
				jobId: undoJobId,
				kind: "undo_change",
				surfaceId,
				sessionId,
				profileId,
				sourceKind: "folder",
				repositoryKey: null,
				folderRoot: "identity",
				payload: {
					changeId: c1Id,
					landedMainBefore: landReport.mainBefore,
					landedMainAfter: landReport.mainAfter,
				},
			},
			new AbortController().signal,
		);

		expect(completeSurfaceMerge).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: undoJobId,
				status: "landed",
				mainBefore: landReport.mainAfter,
				mainAfter: landReport.mainBefore,
			}),
			expect.any(AbortSignal),
		);
		expect(JSON.parse(mem.files.get("identity/tokens.json") ?? "{}")).toEqual({
			colors: { ink: "#161615" },
		});
		expect(mem.files.has("identity/tokens.css")).toBe(false);
		expect(mem.files.has("identity/voice.md")).toBe(false);
		expect(mem.files.get("identity/deprecated.md")).toBe("Legacy copy\n");
	});

	it("recompiles existing identity/tokens.css on tokens.json folder_patch and restores prior CSS on undo_change", async () => {
		const profileId = randomUUID();
		const surfaceId = randomUUID();
		const sessionId = randomUUID();
		const changeId = randomUUID();
		const priorTokens = `${JSON.stringify({ colors: { accent: "#111111" } }, null, 2)}\n`;
		const priorCss = ":root {\n  --q-color-accent: #111111;\n}\n";
		const mem = createInMemoryCompanyFolder({
			"identity/tokens.json": priorTokens,
			"identity/tokens.css": priorCss,
		});
		const snapshots = new InMemorySurfaceFolderSnapshotStore();
		const completeSurfaceMerge = vi.fn().mockResolvedValue(undefined);
		const handlers = createSurfaceExecutionHandlers({
			controlPlane: {
				completeSurfacePreview: vi.fn(),
				completeSurfaceMerge,
				completeSurfacePublish: vi.fn(),
			},
			folder: mem.folder,
			folderSnapshots: snapshots,
		});

		const landJobId = randomUUID();
		await handlers.runMergeJob(
			{
				jobId: landJobId,
				kind: "land_change",
				surfaceId,
				sessionId,
				profileId,
				sourceKind: "folder",
				repositoryKey: null,
				folderRoot: "identity",
				payload: { changeIds: [changeId] },
				approvedChanges: [
					{
						changeId,
						kind: "folder_patch",
						parentSha: null,
						headSha: null,
						title: "Update brand accent",
						summary: "",
						patchManifest: [
							{ op: "merge_json", path: "identity/tokens.json", patch: { colors: { accent: "#226655" } } },
						],
						affectedPaths: ["identity/tokens.json"],
					},
				],
			},
			new AbortController().signal,
		);

		const landReport = completeSurfaceMerge.mock.calls[0]?.[0];
		expect(landReport.status).toBe("landed");
		expect(mem.files.get("identity/tokens.css")).toContain("--q-color-accent: #226655;");
		expect(mem.files.get("identity/tokens.css")).toContain("--brand-accent: #226655;");

		completeSurfaceMerge.mockClear();
		const undoJobId = randomUUID();
		await handlers.runMergeJob(
			{
				jobId: undoJobId,
				kind: "undo_change",
				surfaceId,
				sessionId,
				profileId,
				sourceKind: "folder",
				repositoryKey: null,
				folderRoot: "identity",
				payload: {
					changeId,
					landedMainBefore: landReport.mainBefore,
					landedMainAfter: landReport.mainAfter,
				},
			},
			new AbortController().signal,
		);

		expect(completeSurfaceMerge).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: undoJobId,
				status: "landed",
				mainBefore: landReport.mainAfter,
				mainAfter: landReport.mainBefore,
			}),
			expect.any(AbortSignal),
		);
		expect(mem.files.get("identity/tokens.json")).toBe(priorTokens);
		expect(mem.files.get("identity/tokens.css")).toBe(priorCss);
	});

	it("fails closed without atomic CAS, rejects concurrent folder edits atomically, and restores undo from durable DB snapshots after restart", async () => {
		const profileId = randomUUID();
		const surfaceId = randomUUID();
		const sessionId = randomUUID();
		const changeId = randomUUID();
		const leaseToken = randomUUID();
		const priorTokens = `${JSON.stringify({ colors: { accent: "#111111" } }, null, 2)}\n`;
		const priorVoice = "Calm and crisp.\n";

		const legacyWrite = vi.fn().mockResolvedValue(undefined);
		const legacyComplete = vi.fn().mockResolvedValue(undefined);
		const legacyHandlers = createSurfaceExecutionHandlers({
			controlPlane: {
				completeSurfacePreview: vi.fn(),
				completeSurfaceMerge: legacyComplete,
				completeSurfacePublish: vi.fn(),
			},
			folder: {
				readFiles: vi.fn().mockResolvedValue({ "identity/voice.md": priorVoice }),
				writeFile: legacyWrite,
				deleteFile: vi.fn(),
			},
		});
		const legacyJobId = randomUUID();
		await legacyHandlers.runMergeJob(
			{
				jobId: legacyJobId,
				kind: "land_change",
				surfaceId,
				sessionId,
				profileId,
				leaseToken,
				sourceKind: "folder",
				repositoryKey: null,
				folderRoot: "identity",
				payload: { changeIds: [changeId] },
				approvedChanges: [
					{
						changeId,
						kind: "folder_patch",
						parentSha: null,
						headSha: null,
						title: "Rewrite voice",
						summary: "",
						patchManifest: [{ op: "write_text", path: "identity/voice.md", content: "New voice.\n" }],
						affectedPaths: ["identity/voice.md"],
					},
				],
			},
			new AbortController().signal,
		);
		expect(legacyWrite).not.toHaveBeenCalled();
		expect(legacyComplete).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: legacyJobId,
				status: "failed",
				leaseToken,
				errorDetail: expect.stringContaining("compare-and-swap"),
			}),
			expect.any(AbortSignal),
		);

		const mem = createInMemoryCompanyFolder({
			"identity/tokens.json": priorTokens,
			"identity/voice.md": priorVoice,
		});
		const racingFolder: SurfaceCompanyFolderPort = {
			...mem.folder,
			async readFilesWithVersions(input, signal) {
				const snap = await mem.folder.readFilesWithVersions!(input, signal);
				mem.mutateExternal("identity/voice.md", "Concurrent edit from another session.\n");
				return snap;
			},
		};
		const raceComplete = vi.fn().mockResolvedValue(undefined);
		const raceHandlers = createSurfaceExecutionHandlers({
			controlPlane: {
				completeSurfacePreview: vi.fn(),
				completeSurfaceMerge: raceComplete,
				completeSurfacePublish: vi.fn(),
			},
			folder: racingFolder,
		});
		const raceJobId = randomUUID();
		await raceHandlers.runMergeJob(
			{
				jobId: raceJobId,
				kind: "land_change",
				surfaceId,
				sessionId,
				profileId,
				leaseToken,
				sourceKind: "folder",
				repositoryKey: null,
				folderRoot: "identity",
				payload: { changeIds: [changeId] },
				approvedChanges: [
					{
						changeId,
						kind: "folder_patch",
						parentSha: null,
						headSha: null,
						title: "Update tokens and voice",
						summary: "",
						patchManifest: [
							{ op: "merge_json", path: "identity/tokens.json", patch: { colors: { accent: "#ff0000" } } },
							{ op: "write_text", path: "identity/voice.md", content: "Stale overwrite.\n" },
						],
						affectedPaths: ["identity/tokens.json", "identity/voice.md"],
					},
				],
			},
			new AbortController().signal,
		);
		expect(raceComplete).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: raceJobId,
				status: "conflicted",
				conflictChangeId: changeId,
				conflictPaths: ["identity/voice.md"],
				leaseToken,
			}),
			expect.any(AbortSignal),
		);
		expect(mem.files.get("identity/tokens.json")).toBe(priorTokens);
		expect(mem.files.get("identity/voice.md")).toBe("Concurrent edit from another session.\n");

		const durableComplete = vi.fn().mockResolvedValue(undefined);
		const writerHandlers = createSurfaceExecutionHandlers({
			controlPlane: {
				completeSurfacePreview: vi.fn(),
				completeSurfaceMerge: durableComplete,
				completeSurfacePublish: vi.fn(),
			},
			folder: mem.folder,
		});
		const landJobId = randomUUID();
		await writerHandlers.runMergeJob(
			{
				jobId: landJobId,
				kind: "land_change",
				surfaceId,
				sessionId,
				profileId,
				leaseToken,
				sourceKind: "folder",
				repositoryKey: null,
				folderRoot: "identity",
				payload: { changeIds: [changeId] },
				approvedChanges: [
					{
						changeId,
						kind: "folder_patch",
						parentSha: null,
						headSha: null,
						title: "Set durable accent",
						summary: "",
						patchManifest: [
							{ op: "merge_json", path: "identity/tokens.json", patch: { colors: { accent: "#334455" } } },
						],
						affectedPaths: ["identity/tokens.json"],
					},
				],
			},
			new AbortController().signal,
		);
		const landCall = durableComplete.mock.calls[0]?.[0];
		expect(landCall.status).toBe("landed");
		expect(landCall.leaseToken).toBe(leaseToken);
		expect(landCall.preMergeSnapshot).toMatchObject({
			snapshotId: landCall.mainBefore,
			folderRoot: "identity",
			changeIds: [changeId],
			filesBefore: { "identity/tokens.json": priorTokens, "identity/tokens.css": null },
		});

		const restartedComplete = vi.fn().mockResolvedValue(undefined);
		const restartedHandlers = createSurfaceExecutionHandlers({
			controlPlane: {
				completeSurfacePreview: vi.fn(),
				completeSurfaceMerge: restartedComplete,
				completeSurfacePublish: vi.fn(),
			},
			folder: mem.folder,
		});
		const undoJobId = randomUUID();
		const undoLease = randomUUID();
		await restartedHandlers.runMergeJob(
			{
				jobId: undoJobId,
				kind: "undo_change",
				surfaceId,
				sessionId,
				profileId,
				leaseToken: undoLease,
				sourceKind: "folder",
				repositoryKey: null,
				folderRoot: "identity",
				payload: {
					changeId,
					landedMainBefore: landCall.mainBefore,
					landedMainAfter: landCall.mainAfter,
				},
				preMergeSnapshot: landCall.preMergeSnapshot,
			},
			new AbortController().signal,
		);
		expect(restartedComplete).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: undoJobId,
				status: "landed",
				mainBefore: landCall.mainAfter,
				mainAfter: landCall.mainBefore,
				leaseToken: undoLease,
			}),
			expect.any(AbortSignal),
		);
		expect(mem.files.get("identity/tokens.json")).toBe(priorTokens);
		expect(mem.files.has("identity/tokens.css")).toBe(false);
	});

	it("collects shared company assets with auto-compiled tokens.css and forwards sharedAssets into previews and publishes", async () => {
		const f = await createGitSurfaceFixture();
		const seed = await f.startSession();
		const seedHead = await seed.commit({ "index.html": "<main>Shared assets</main>\n" }, "Seed");
		const base = await cherryPickChangeUnits(f.job, {
			repository: f.repository,
			changes: [{ changeId: randomUUID(), parentSha: f.baseSha, headSha: seedHead, title: "Seed" }],
		});

		const profileId = randomUUID();
		const surfaceId = randomUUID();
		const siteId = randomUUID();
		const siteVersionId = randomUUID();
		const specsJson = `${JSON.stringify({ name: "Thetaband", priceDkk: 1995 })}\n`;
		const tokensJson = `${JSON.stringify({ colors: { accent: "#d76f45", surface: "#f8f6f2" }, typography: { body: "Inter, sans-serif" } })}\n`;
		const mem = createInMemoryCompanyFolder({
			"identity/tokens.json": tokensJson,
			"product/specs.json": specsJson,
		});

		const collected = await collectSharedCompanyAssets(mem.folder, profileId, new AbortController().signal);
		expect(collected["qorpera-identity.css"]).toContain("--q-color-accent: #d76f45;");
		expect(collected["qorpera-identity.css"]).toContain("--q-font-body: Inter, sans-serif;");
		expect(collected["public/qorpera-shared/identity/tokens.css"]).toBe(collected["qorpera-identity.css"]);
		expect(collected["public/qorpera-shared/identity/tokens.json"]).toBe(tokensJson);
		expect(collected["public/qorpera-shared/product/specs.json"]).toBe(specsJson);
		expect(collected["public/qorpera-shared/identity/logo.svg"]).toBeUndefined();

		const buildAndUploadPreview = vi.fn().mockResolvedValue({ siteVersionId });
		const publishSurface = vi.fn().mockResolvedValue({ publishedHeadSha: base.mainAfter });
		const handlers = createSurfaceExecutionHandlers({
			controlPlane: {
				completeSurfacePreview: vi.fn().mockResolvedValue(undefined),
				completeSurfaceMerge: vi.fn().mockResolvedValue(undefined),
				completeSurfacePublish: vi.fn().mockResolvedValue(undefined),
			},
			resolveCodeHostJob: () => f.job,
			folder: mem.folder,
			buildAndUploadPreview,
			publishSurface,
		});

		await handlers.runPreviewJob(
			{
				previewId: randomUUID(),
				surfaceId,
				profileId,
				shortHostId: "deadbeef",
				baseSha: base.mainAfter,
				selectedChangeIds: [],
				repositoryKey: "thetaband/website",
				exploration: null,
				changes: [],
			},
			new AbortController().signal,
		);
		expect(buildAndUploadPreview).toHaveBeenCalledWith(
			expect.objectContaining({
				sharedAssets: expect.objectContaining({
					"qorpera-identity.css": expect.stringContaining("--q-color-accent: #d76f45;"),
					"public/qorpera-shared/product/specs.json": specsJson,
				}),
			}),
			expect.any(AbortSignal),
		);

		await handlers.runPublishJob(
			{
				jobId: randomUUID(),
				surfaceId,
				profileId,
				repositoryKey: "thetaband/website",
				siteId,
				payload: { liveHeadSha: base.mainAfter, repositoryKey: "thetaband/website" },
			},
			new AbortController().signal,
		);
		expect(publishSurface).toHaveBeenCalledWith(
			expect.objectContaining({
				sharedAssets: expect.objectContaining({
					"qorpera-identity.css": expect.stringContaining("--q-color-accent: #d76f45;"),
					"public/qorpera-shared/product/specs.json": specsJson,
				}),
			}),
			expect.any(AbortSignal),
		);
	}, 20_000);

	it("publishes site versions and reports both publish success and failure", async () => {
		const profileId = randomUUID();
		const surfaceId = randomUUID();
		const siteId = randomUUID();
		const sha = "c".repeat(40);
		const completeSurfacePublish = vi.fn().mockResolvedValue(undefined);
		const publishSurface = vi
			.fn()
			.mockResolvedValueOnce({ publishedHeadSha: sha })
			.mockRejectedValueOnce(new Error("Static site bundle upload failed"));

		const handlers = createSurfaceExecutionHandlers({
			controlPlane: {
				completeSurfacePreview: vi.fn(),
				completeSurfaceMerge: vi.fn(),
				completeSurfacePublish,
			},
			publishSurface,
		});

		const okJobId = randomUUID();
		await handlers.runPublishJob(
			{
				jobId: okJobId,
				surfaceId,
				profileId,
				repositoryKey: "thetaband/website",
				siteId,
				payload: { liveHeadSha: sha, repositoryKey: "thetaband/website" },
			},
			new AbortController().signal,
		);
		expect(publishSurface).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId: okJobId,
				surfaceId,
				siteId,
				liveHeadSha: sha,
				repository: { host: "qorpera", owner: "thetaband", name: "website", baseBranch: "main" },
			}),
			expect.any(AbortSignal),
		);
		expect(completeSurfacePublish).toHaveBeenCalledWith(
			{
				jobId: okJobId,
				status: "published",
				publishedHeadSha: sha,
			},
			expect.any(AbortSignal),
		);

		completeSurfacePublish.mockClear();
		const failJobId = randomUUID();
		await handlers.runPublishJob(
			{
				jobId: failJobId,
				surfaceId,
				profileId,
				repositoryKey: "thetaband/website",
				siteId,
				payload: { liveHeadSha: sha },
			},
			new AbortController().signal,
		);
		expect(completeSurfacePublish).toHaveBeenCalledWith(
			{
				jobId: failJobId,
				status: "failed",
				errorDetail: "Static site bundle upload failed",
			},
			expect.any(AbortSignal),
		);
	});

	it("parses enriched claimSurfaceJobs payloads and plugs directly into SurfaceWorkerLoop", async () => {
		const orchestratorId = randomUUID();
		const profileId = randomUUID();
		const surfaceId = randomUUID();
		const sessionId = randomUUID();
		const changeId = randomUUID();
		const mergeJobId = randomUUID();
		const mem = createInMemoryCompanyFolder({ "identity/tokens.json": "{}\n" });
		const completeActions: Record<string, unknown>[] = [];

		const fakeFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			if (body.action === "surface_claim_jobs") {
				return Response.json({
					value: {
						sessions: [],
						previews: [],
						merges: [
							{
								jobId: mergeJobId,
								kind: "land_change",
								surfaceId,
								sessionId,
								profileId,
								sourceKind: "folder",
								repositoryKey: null,
								folderRoot: "identity",
								autoPublish: false,
								expectMainSha: null,
								sessionWorkerId: null,
								sessionState: "ready",
								sessionHasActiveChat: false,
								payload: { changeIds: [changeId] },
								allSessionChangeStatuses: [{ changeId, status: "merging" }],
								approvedChanges: [
									{
										changeId,
										kind: "folder_patch",
										parentSha: null,
										headSha: null,
										title: "Write brand note",
										summary: "Set accent",
										patchManifest: [
											{ op: "merge_json", path: "identity/tokens.json", patch: { accent: "#d76f45" } },
										],
										affectedPaths: ["identity/tokens.json"],
									},
								],
								siblingRemainingChanges: [],
								peerSessions: [],
							},
						],
						publishes: [],
					},
				});
			}
			completeActions.push(body);
			return Response.json({ value: { jobId: mergeJobId, status: "landed" } });
		});

		const controlPlane = new SupabaseCloudRunnerOrchestratorControlPlane(
			"https://project.supabase.co",
			"publishable-key",
			orchestratorId,
			"c".repeat(43),
			fakeFetch as typeof fetch,
		);
		const handlers = createSurfaceExecutionHandlers({
			controlPlane,
			folder: mem.folder,
		});
		const loop = new SurfaceWorkerLoop({
			claimPendingJobs: (limit, signal) => controlPlane.claimSurfaceJobs(limit, signal),
			spawnOverflowMachine: vi.fn(),
			dispatchSessionTurn: vi.fn(),
			...handlers,
		});

		const tick = await loop.tick(new AbortController().signal);
		await loop.drain();
		expect(tick).toEqual({
			startedSessions: 0,
			startedPreviews: 0,
			startedMerges: 1,
			startedPublishes: 0,
			startedAutomations: 0,
		});
		expect(JSON.parse(mem.files.get("identity/tokens.json") ?? "{}")).toEqual({ accent: "#d76f45" });
		expect(completeActions).toHaveLength(1);
		expect(completeActions[0]).toMatchObject({
			action: "surface_complete_merge",
			jobId: mergeJobId,
			status: "landed",
		});
	});

	it("auto-scaffolds an unseeded greenfield surfaces/<slug> repo before building its first preview", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "surface-bridge-greenfield-")));
		roots.push(root);
		const companyRoot = join(root, "folder");
		const scratchRoot = join(root, "scratch");
		await mkdir(companyRoot, { recursive: true });
		await mkdir(scratchRoot, { recursive: true });
		const log: CodeHostCommand[] = [];
		const codeHostJob: CodeHostJob = {
			shell: crossPlatformLocalShell(log),
			layout: { companyRoot, scratchRoot, git: GIT },
			signal: new AbortController().signal,
		};

		const previewId = randomUUID();
		const siteVersionId = randomUUID();
		const completeSurfacePreview = vi.fn().mockResolvedValue(undefined);
		const buildAndUploadPreview = vi.fn().mockResolvedValue({ siteVersionId });
		const handlers = createSurfaceExecutionHandlers({
			controlPlane: {
				completeSurfacePreview,
				completeSurfaceMerge: vi.fn(),
				completeSurfacePublish: vi.fn(),
			},
			resolveCodeHostJob: () => codeHostJob,
			buildAndUploadPreview,
		});

		await handlers.runPreviewJob(
			{
				previewId,
				surfaceId: randomUUID(),
				profileId: randomUUID(),
				shortHostId: "aa11bb22",
				baseSha: "0".repeat(40),
				selectedChangeIds: [],
				repositoryKey: "surfaces/website",
				exploration: null,
				changes: [],
			},
			new AbortController().signal,
		);

		expect(buildAndUploadPreview).toHaveBeenCalledTimes(1);
		expect(completeSurfacePreview).toHaveBeenCalledWith(
			expect.objectContaining({
				previewId,
				status: "ready",
				siteVersionId,
			}),
			expect.any(AbortSignal),
		);
		expect(existsSync(join(companyRoot, "code/surfaces/website/main/.qorpera/checks.json"))).toBe(true);
	}, 20_000);

	it("rejects oversized inline pre-merge snapshots before commitFiles and supports large folders via folderSnapshots", async () => {
		const bigBody = "A".repeat(100 * 1024);
		const memInline = createInMemoryCompanyFolder({ "identity/brand.md": bigBody });
		const completeInline = vi.fn().mockResolvedValue(undefined);
		const inlineHandlers = createSurfaceExecutionHandlers({
			controlPlane: {
				completeSurfacePreview: vi.fn(),
				completeSurfaceMerge: completeInline,
				completeSurfacePublish: vi.fn(),
			},
			folder: memInline.folder,
			completionRetryDelaysMs: [1, 1],
		});

		const surfaceId = randomUUID();
		const profileId = randomUUID();
		const sessionId = randomUUID();
		const changeId = randomUUID();
		const jobId = randomUUID();
		const makeLandJob = (id: string) => ({
			jobId: id,
			surfaceId,
			profileId,
			sessionId,
			kind: "land_change" as const,
			payload: {},
			repositoryKey: null,
			folderRoot: "identity",
			sourceKind: "folder" as const,
			approvedChanges: [
				{
					changeId,
					title: "Update large brand file",
					summary: "",
					kind: "folder_patch" as const,
					parentSha: null,
					headSha: null,
					affectedPaths: ["identity/brand.md"],
					patchManifest: [{ op: "write_text", path: "identity/brand.md", content: "Updated brief\n" }],
				},
			],
		});

		await inlineHandlers.runMergeJob(makeLandJob(jobId), new AbortController().signal);
		expect(memInline.commitCalls).toHaveLength(0);
		expect(memInline.files.get("identity/brand.md")).toBe(bigBody);
		expect(completeInline).toHaveBeenCalledWith(
			expect.objectContaining({
				jobId,
				status: "failed",
				errorDetail: expect.stringMatching(/96 KiB/i),
			}),
			expect.any(AbortSignal),
		);

		const memExternal = createInMemoryCompanyFolder({ "identity/brand.md": bigBody });
		const snapshotStore = new InMemorySurfaceFolderSnapshotStore();
		const completeExternal = vi.fn().mockResolvedValue(undefined);
		const externalHandlers = createSurfaceExecutionHandlers({
			controlPlane: {
				completeSurfacePreview: vi.fn(),
				completeSurfaceMerge: completeExternal,
				completeSurfacePublish: vi.fn(),
			},
			folder: memExternal.folder,
			folderSnapshots: snapshotStore,
			completionRetryDelaysMs: [1, 1],
		});

		const extJobId = randomUUID();
		await externalHandlers.runMergeJob(makeLandJob(extJobId), new AbortController().signal);
		expect(memExternal.commitCalls).toHaveLength(1);
		expect(memExternal.files.get("identity/brand.md")).toBe("Updated brief\n");
		const extPayload = completeExternal.mock.calls[0]?.[0] as {
			status: string;
			mainBefore: string;
			mainAfter: string;
			preMergeSnapshot: Record<string, unknown>;
		};
		expect(extPayload.status).toBe("landed");
		expect(extPayload.preMergeSnapshot.externalSnapshot).toBe(true);
		expect(extPayload.preMergeSnapshot.filesBefore).toBeUndefined();
		expect(Buffer.byteLength(JSON.stringify(extPayload.preMergeSnapshot), "utf-8")).toBeLessThan(2048);

		const undoJobId = randomUUID();
		await externalHandlers.runMergeJob(
			{
				jobId: undoJobId,
				surfaceId,
				profileId,
				sessionId,
				kind: "undo_change",
				payload: {
					changeId,
					landedMainBefore: extPayload.mainBefore,
					landedMainAfter: extPayload.mainAfter,
				},
				repositoryKey: null,
				folderRoot: "identity",
				sourceKind: "folder",
				preMergeSnapshot: extPayload.preMergeSnapshot,
			},
			new AbortController().signal,
		);
		expect(memExternal.files.get("identity/brand.md")).toBe(bigBody);
		expect(completeExternal).toHaveBeenLastCalledWith(
			expect.objectContaining({ jobId: undoJobId, status: "landed" }),
			expect.any(AbortSignal),
		);
	});

	it("retries transient completion errors after folder commit without re-running commitFiles", async () => {
		const mem = createInMemoryCompanyFolder({ "identity/tokens.json": '{"accent":"#111111"}\n' });
		let attempts = 0;
		const completeSurfaceMerge = vi.fn().mockImplementation(async () => {
			attempts += 1;
			if (attempts < 3) {
				throw new Error("Transient 503 from control plane");
			}
		});
		const handlers = createSurfaceExecutionHandlers({
			controlPlane: {
				completeSurfacePreview: vi.fn(),
				completeSurfaceMerge,
				completeSurfacePublish: vi.fn(),
			},
			folder: mem.folder,
			completionRetryDelaysMs: [1, 1],
		});

		const jobId = randomUUID();
		const changeId = randomUUID();
		const sessionId = randomUUID();
		await handlers.runMergeJob(
			{
				jobId,
				surfaceId: randomUUID(),
				profileId: randomUUID(),
				sessionId,
				kind: "land_change",
				payload: {},
				repositoryKey: null,
				folderRoot: "identity",
				sourceKind: "folder",
				approvedChanges: [
					{
						changeId,
						title: "Set accent",
						summary: "",
						kind: "folder_patch",
						parentSha: null,
						headSha: null,
						affectedPaths: ["identity/tokens.json"],
						patchManifest: [{ op: "merge_json", path: "identity/tokens.json", patch: { accent: "#222222" } }],
					},
				],
			},
			new AbortController().signal,
		);

		expect(mem.commitCalls).toHaveLength(1);
		expect(completeSurfaceMerge).toHaveBeenCalledTimes(3);
		expect(completeSurfaceMerge).toHaveBeenLastCalledWith(
			expect.objectContaining({ jobId, status: "landed" }),
			expect.any(AbortSignal),
		);
	});

	it("refuses folder undo as conflicted when a later edit changed the file after landing", async () => {
		const mem = createInMemoryCompanyFolder({ "identity/tokens.json": '{"accent":"#111111"}\n' });
		const completeSurfaceMerge = vi.fn().mockResolvedValue(undefined);
		const handlers = createSurfaceExecutionHandlers({
			controlPlane: {
				completeSurfacePreview: vi.fn(),
				completeSurfaceMerge,
				completeSurfacePublish: vi.fn(),
			},
			folder: mem.folder,
			completionRetryDelaysMs: [1, 1],
		});

		const surfaceId = randomUUID();
		const profileId = randomUUID();
		const sessionId = randomUUID();
		const changeA = randomUUID();
		const landJobId = randomUUID();

		await handlers.runMergeJob(
			{
				jobId: landJobId,
				surfaceId,
				profileId,
				sessionId,
				kind: "land_change",
				payload: {},
				repositoryKey: null,
				folderRoot: "identity",
				sourceKind: "folder",
				approvedChanges: [
					{
						changeId: changeA,
						title: "Change A accent",
						summary: "",
						kind: "folder_patch",
						parentSha: null,
						headSha: null,
						affectedPaths: ["identity/tokens.json"],
						patchManifest: [{ op: "merge_json", path: "identity/tokens.json", patch: { accent: "#aaaaaa" } }],
					},
				],
			},
			new AbortController().signal,
		);

		const landedCall = completeSurfaceMerge.mock.calls[0]?.[0] as {
			status: string;
			mainBefore: string;
			mainAfter: string;
			preMergeSnapshot: Record<string, unknown>;
		};
		expect(landedCall.status).toBe("landed");
		expect(landedCall.preMergeSnapshot.versionsAfter).toMatchObject({
			"identity/tokens.json": expect.any(String),
			"identity/tokens.css": expect.any(String),
		});

		const laterContent = '{"accent":"#bbbbbb","from":"change-b"}\n';
		mem.mutateExternal("identity/tokens.json", laterContent);
		const commitsBeforeUndo = mem.commitCalls.length;

		const undoJobId = randomUUID();
		await handlers.runMergeJob(
			{
				jobId: undoJobId,
				surfaceId,
				profileId,
				sessionId,
				kind: "undo_change",
				payload: {
					changeId: changeA,
					landedMainBefore: landedCall.mainBefore,
					landedMainAfter: landedCall.mainAfter,
				},
				repositoryKey: null,
				folderRoot: "identity",
				sourceKind: "folder",
				preMergeSnapshot: landedCall.preMergeSnapshot,
			},
			new AbortController().signal,
		);

		expect(mem.commitCalls).toHaveLength(commitsBeforeUndo);
		expect(mem.files.get("identity/tokens.json")).toBe(laterContent);
		expect(completeSurfaceMerge).toHaveBeenLastCalledWith(
			expect.objectContaining({
				jobId: undoJobId,
				status: "conflicted",
				conflictChangeId: changeA,
				conflictPaths: ["identity/tokens.json"],
			}),
			expect.any(AbortSignal),
		);
	});
});
