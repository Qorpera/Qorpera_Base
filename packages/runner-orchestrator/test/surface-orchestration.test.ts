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
import { approveAndSyncSurfaceChanges } from "../src/surface-change-dispatcher.ts";
import { buildCompositeSurfacePreview, readSurfacePreviewRecipe } from "../src/surface-preview-runner.ts";
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

async function surfaceRepoFixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "surface-orchestration-")));
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

describe("surface preview runner and change dispatcher", () => {
	it("reads the preview block as the only build contract", () => {
		const checks = [{ name: "test", run: "npm test" }];
		expect(
			readSurfacePreviewRecipe(
				JSON.stringify({
					checks,
					preview: { run: "npm ci && npm run build", folder: "dist", timeoutSeconds: 120 },
					site: { folder: "public" },
				}),
			),
		).toEqual({
			kind: "recipe",
			recipe: { run: "npm ci && npm run build", cwd: ".", folder: "dist", timeoutSeconds: 120 },
		});
		expect(
			readSurfacePreviewRecipe(
				JSON.stringify({ checks, preview: { run: "vite build", cwd: "web" }, site: { folder: "web/dist" } }),
			),
		).toEqual({ kind: "recipe", recipe: { run: "vite build", cwd: "web", folder: "web/dist", timeoutSeconds: 180 } });
		expect(
			readSurfacePreviewRecipe(
				JSON.stringify({ checks: [...checks, { name: "build", run: "vite build" }], site: { folder: "dist" } }),
			),
		).toEqual({ kind: "none" });
		expect(readSurfacePreviewRecipe(JSON.stringify({ checks, preview: { run: "true", folder: "." } }))).toEqual({
			kind: "none",
		});
		expect(readSurfacePreviewRecipe(null)).toEqual({ kind: "none" });
		expect(readSurfacePreviewRecipe("{ not json")).toEqual({ kind: "none" });
		const invalid = readSurfacePreviewRecipe(JSON.stringify({ preview: { run: "vite build", folder: "../dist" } }));
		expect(invalid.kind).toBe("invalid");
		expect(invalid.kind === "invalid" && invalid.detail.split("\n")[0]).toBe("PREVIEW_BUILD_FAILED");
		expect(invalid.kind === "invalid" && invalid.detail).toContain("/preview/folder");
	});

	it("builds clean composite previews and skips building on toggle conflicts", async () => {
		const f = await surfaceRepoFixture();
		const seed = await f.startSession();
		const seedHead = await seed.commit({ "index.html": "<main>Home</main>\n" }, "Seed");
		const base = await cherryPickChangeUnits(f.job, {
			repository: f.repository,
			changes: [{ changeId: randomUUID(), parentSha: f.baseSha, headSha: seedHead, title: "Seed" }],
		});

		const s1 = await f.startSession(base.mainAfter);
		const c1Id = randomUUID();
		const c1Head = await s1.commit({ "faq.html": "<section>FAQ</section>\n" }, "FAQ");

		const s2 = await f.startSession(base.mainAfter);
		const c2Id = randomUUID();
		const c2Head = await s2.commit({ "index.html": "<main>Variant A</main>\n" }, "Variant A");

		const s3 = await f.startSession(base.mainAfter);
		const c3Id = randomUUID();
		const c3Head = await s3.commit({ "index.html": "<main>Variant B</main>\n" }, "Variant B");

		const surfaceId = randomUUID();
		const previewId1 = randomUUID();
		const siteVersionId = randomUUID();
		const buildAndUploadPreview = vi.fn().mockResolvedValue({ siteVersionId });
		const completePreview = vi.fn().mockResolvedValue(undefined);

		const ready = await buildCompositeSurfacePreview(
			f.job,
			{
				previewId: previewId1,
				surfaceId,
				shortHostId: "a1b2c3d4",
				repository: f.repository,
				baseSha: base.mainAfter,
				changes: [
					{ changeId: c1Id, parentSha: base.mainAfter, headSha: c1Head },
					{ changeId: c2Id, parentSha: base.mainAfter, headSha: c2Head },
				],
			},
			{ buildAndUploadPreview, completePreview },
		);

		expect(ready.status).toBe("ready");
		expect(ready.siteVersionId).toBe(siteVersionId);
		expect(buildAndUploadPreview).toHaveBeenCalledTimes(1);
		expect(completePreview).toHaveBeenCalledWith(
			previewId1,
			expect.objectContaining({ status: "ready", siteVersionId }),
		);

		const previewId2 = randomUUID();
		buildAndUploadPreview.mockClear();
		completePreview.mockClear();
		const conflicted = await buildCompositeSurfacePreview(
			f.job,
			{
				previewId: previewId2,
				surfaceId,
				shortHostId: "e5f6g7h8",
				repository: f.repository,
				baseSha: base.mainAfter,
				changes: [
					{ changeId: c2Id, parentSha: base.mainAfter, headSha: c2Head },
					{ changeId: c3Id, parentSha: base.mainAfter, headSha: c3Head },
				],
			},
			{ buildAndUploadPreview, completePreview },
		);

		expect(conflicted.status).toBe("conflicted");
		expect(conflicted.conflictReport).toEqual({ changeIds: [c2Id, c3Id], paths: ["index.html"] });
		expect(buildAndUploadPreview).not.toHaveBeenCalled();
	}, 20_000);

	it("runs full partial approval cascade, sibling + peer rebases, lifecycle close, and optional auto-publish", async () => {
		const f = await surfaceRepoFixture();
		const seed = await f.startSession();
		const seedHead = await seed.commit({ "hero.html": "<h1>Old</h1>\n" }, "Seed hero");
		const base = await cherryPickChangeUnits(f.job, {
			repository: f.repository,
			changes: [{ changeId: randomUUID(), parentSha: f.baseSha, headSha: seedHead, title: "Seed hero" }],
		});

		const multi = await f.startSession(base.mainAfter);
		const c1Id = randomUUID();
		const c2Id = randomUUID();
		const c1Head = await multi.commit({ "hero.html": "<h1>Aftenlys</h1>\n" }, "Hero headline");
		const c2Head = await multi.commit({ "faq.html": "<section>Spørgsmål</section>\n" }, "FAQ section");

		const peerClean = await f.startSession(base.mainAfter);
		const peerCleanId = randomUUID();
		const peerCleanHead = await peerClean.commit({ "footer.html": "<footer>DK</footer>\n" }, "Footer");

		const peerConflict = await f.startSession(base.mainAfter);
		const peerConflictId = randomUUID();
		const peerConflictHead = await peerConflict.commit({ "hero.html": "<h1>Varmt studie</h1>\n" }, "Other hero");

		const surfaceId = randomUUID();
		const publishSurface = vi.fn().mockResolvedValue(undefined);

		const step1 = await approveAndSyncSurfaceChanges(
			f.job,
			{
				surfaceId,
				sessionId: randomUUID(),
				workerId: multi.workerId,
				repository: f.repository,
				expectMainSha: base.mainAfter,
				autoPublish: false,
				sessionState: "ready",
				sessionHasActiveChat: false,
				allSessionChangeStatuses: [
					{ changeId: c1Id, status: "staged" },
					{ changeId: c2Id, status: "staged" },
				],
				approvedChanges: [{ changeId: c1Id, parentSha: base.mainAfter, headSha: c1Head, title: "Hero headline" }],
				siblingRemainingChanges: [{ changeId: c2Id, parentSha: c1Head, headSha: c2Head, title: "FAQ section" }],
				peerSessions: [
					{
						sessionId: randomUUID(),
						workerId: peerClean.workerId,
						remainingChanges: [
							{ changeId: peerCleanId, parentSha: base.mainAfter, headSha: peerCleanHead, title: "Footer" },
						],
					},
					{
						sessionId: randomUUID(),
						workerId: peerConflict.workerId,
						remainingChanges: [
							{
								changeId: peerConflictId,
								parentSha: base.mainAfter,
								headSha: peerConflictHead,
								title: "Other hero",
							},
						],
					},
				],
			},
			{ publishSurface },
		);

		expect(step1.status).toBe("landed");
		if (step1.status !== "landed") throw new Error("expected landed");
		expect(step1.nextSessionState).toBe("ready");
		expect(step1.published).toBe(false);
		expect(publishSurface).not.toHaveBeenCalled();
		expect(step1.siblingRebase?.status).toBe("clean");
		expect(step1.peerSync[0]?.result.status).toBe("clean");
		expect(step1.peerSync[1]?.result.status).toBe("conflicted");
		if (step1.peerSync[1]?.result.status === "conflicted") {
			expect(step1.peerSync[1].result.conflictPaths).toEqual(["hero.html"]);
		}

		if (step1.siblingRebase?.status !== "clean") throw new Error("expected clean sibling rebase");
		const rebasedC2 = step1.siblingRebase.rebasedChanges[0]!;

		const step2 = await approveAndSyncSurfaceChanges(
			f.job,
			{
				surfaceId,
				sessionId: randomUUID(),
				workerId: multi.workerId,
				repository: f.repository,
				expectMainSha: step1.mainAfter,
				autoPublish: true,
				sessionState: "ready",
				sessionHasActiveChat: false,
				allSessionChangeStatuses: [
					{ changeId: c1Id, status: "merged" },
					{ changeId: c2Id, status: "staged" },
				],
				approvedChanges: [
					{ changeId: c2Id, parentSha: rebasedC2.parentSha, headSha: rebasedC2.headSha, title: "FAQ section" },
				],
				siblingRemainingChanges: [],
				peerSessions: [],
			},
			{ publishSurface },
		);

		expect(step2.status).toBe("landed");
		if (step2.status !== "landed") throw new Error("expected landed step 2");
		expect(step2.nextSessionState).toBe("completed");
		expect(step2.published).toBe(true);
		expect(publishSurface).toHaveBeenCalledWith(surfaceId, step2.mainAfter);
		expect(await readFile(join(f.code, "main/faq.html"), "utf8")).toBe("<section>Spørgsmål</section>\n");
	}, 20_000);
});
