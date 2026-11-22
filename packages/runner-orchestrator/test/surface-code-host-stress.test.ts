import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { parseCodeChecksText } from "../../runtime/src/cloud-code-checks.ts";
import { readCodeChecks } from "../src/code-checks.ts";
import { CODE_FOLDER_ANY_SESSION, CODE_FOLDER_KEY_BYTES, codeFolderRefuses } from "../src/code-folder-names.ts";
import {
	addCodeWorktree,
	type CodeHostCommand,
	type CodeHostJob,
	CodeHostJobFailure,
	type CodeHostShell,
	startCodeArea,
} from "../src/code-host-jobs.ts";
import { CodeSiteTreeInvalid, readSurfaceSiteTree } from "../src/code-host-sites.ts";
import {
	CodeHostChangeConflict,
	cherryPickChangeUnits,
	ensureSurfaceStarterRepository,
	inspectChangeRange,
	rebaseSessionChanges,
} from "../src/code-host-surfaces.ts";
import {
	SURFACE_CODE_HOST_RPCS,
	type SurfaceCodeHostRpc,
	SurfaceCodeHostWorker,
} from "../src/surface-code-host-worker.ts";
import { undoSurfaceCodeRepoChange } from "../src/surface-execution-bridge.ts";
import { localShell } from "./helpers/code-host-shell.ts";

const exec = promisify(execFile);
const GIT = "/usr/bin/git";
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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

async function createStressFixture(repoName = "brooks") {
	const root = await realpath(await mkdtemp(join(tmpdir(), "surface-stress-")));
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
	const repository = { host: "qorpera" as const, owner: "surfaces", name: repoName, baseBranch: "main" };
	const started = await startCodeArea(job, { repository });
	const code = join(companyRoot, `code/surfaces/${repoName}`);
	const repo = join(code, "repo.git");
	const mainWorktree = join(code, "main");
	const env = {
		PATH: "/usr/bin:/bin",
		HOME: root,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_AUTHOR_NAME: "Stress",
		GIT_AUTHOR_EMAIL: "stress@example.invalid",
		GIT_COMMITTER_NAME: "Stress",
		GIT_COMMITTER_EMAIL: "stress@example.invalid",
	};
	const git = async (cwd: string, ...args: string[]) => (await exec(GIT, args, { cwd, env })).stdout.trim();
	const commitMain = async (files: Record<string, string>, message: string) => {
		for (const [filePath, content] of Object.entries(files)) {
			await mkdir(dirname(join(mainWorktree, filePath)), { recursive: true });
			await writeFile(join(mainWorktree, filePath), content);
		}
		await git(mainWorktree, "add", "--all");
		await git(mainWorktree, "commit", "--quiet", "-m", message);
		const sha = await git(mainWorktree, "rev-parse", "HEAD");
		await git(repo, "update-ref", "refs/heads/main", sha);
		return sha;
	};
	const startSession = async (baseSha: string) => {
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
			return await git(worktree, "rev-parse", "HEAD");
		};
		return { workerId, worktree, commit };
	};
	return {
		companyRoot,
		scratchRoot,
		job,
		repository,
		code,
		repo,
		mainWorktree,
		baseSha: started.baseSha,
		git,
		commitMain,
		startSession,
		log,
	};
}

describe("surface code_repo parallel work, merge conflicts, previews, and scale stress tests", () => {
	it("handles 8 parallel sessions, selective merges, 3-way same-file merges, conflicts, and worktree disk+index sync without reverting main", async () => {
		const f = await createStressFixture("website");
		const initialSha = await f.commitMain(
			{
				".gitignore": "node_modules/\n.DS_Store\n",
				"index.html": [
					"<!doctype html>",
					"<html>",
					"<head><title>Brooks</title></head>",
					"<body>",
					'<header id="top">Original Header</header>',
					'<main id="hero">Original Hero</main>',
					'<section id="pricing">100 DKK</section>',
					'<section id="faq">Original FAQ</section>',
					'<footer id="foot">Original Footer</footer>',
					"</body>",
					"</html>",
					"",
				].join("\n"),
				"styles.css": "body { margin: 0; }\n",
			},
			"Initial site",
		);

		const sessions = await Promise.all(Array.from({ length: 8 }, () => f.startSession(initialSha)));
		const [s0, s1, s2, s3, s4, s5, s6, s7] = sessions as [
			(typeof sessions)[number],
			(typeof sessions)[number],
			(typeof sessions)[number],
			(typeof sessions)[number],
			(typeof sessions)[number],
			(typeof sessions)[number],
			(typeof sessions)[number],
			(typeof sessions)[number],
		];

		const c0a = {
			changeId: randomUUID(),
			parentSha: initialSha,
			headSha: await s0.commit({ "about.html": "<h1>About</h1>\n" }, "About"),
			title: "Add about",
		};
		const c0b = {
			changeId: randomUUID(),
			parentSha: c0a.headSha,
			headSha: await s0.commit({ "contact.html": "<h1>Contact</h1>\n" }, "Contact"),
			title: "Add contact",
		};
		const c1 = {
			changeId: randomUUID(),
			parentSha: initialSha,
			headSha: await s1.commit({ "blog.html": "<h1>Blog</h1>\n" }, "Blog"),
			title: "Add blog",
		};
		const c2 = {
			changeId: randomUUID(),
			parentSha: initialSha,
			headSha: await s2.commit({ "legal.html": "<h1>Legal</h1>\n" }, "Legal"),
			title: "Add legal",
		};
		const c3 = {
			changeId: randomUUID(),
			parentSha: initialSha,
			headSha: await s3.commit({ "careers.html": "<h1>Careers</h1>\n" }, "Careers"),
			title: "Add careers",
		};

		const baseHtml = await readFile(join(f.mainWorktree, "index.html"), "utf8");
		const c4 = {
			changeId: randomUUID(),
			parentSha: initialSha,
			headSha: await s4.commit(
				{ "index.html": baseHtml.replace("Original Header", "Updated Header v2") },
				"Update header",
			),
			title: "Update header",
		};
		const c5 = {
			changeId: randomUUID(),
			parentSha: initialSha,
			headSha: await s5.commit(
				{ "index.html": baseHtml.replace("Original Footer", "Updated Footer v2") },
				"Update footer",
			),
			title: "Update footer",
		};

		const c6 = {
			changeId: randomUUID(),
			parentSha: initialSha,
			headSha: await s6.commit({ "index.html": baseHtml.replace("100 DKK", "199 DKK") }, "Price 199"),
			title: "Set price 199",
		};
		const c7 = {
			changeId: randomUUID(),
			parentSha: initialSha,
			headSha: await s7.commit({ "index.html": baseHtml.replace("100 DKK", "249 DKK") }, "Price 249"),
			title: "Set price 249",
		};

		const mergeStart = performance.now();
		let mainSha = initialSha;
		for (const change of [c0a, c1, c2, c3, c4, c5, c6]) {
			const landed = await cherryPickChangeUnits(f.job, {
				repository: f.repository,
				expectMainSha: mainSha,
				changes: [change],
			});
			mainSha = landed.mainAfter;
		}
		const mergeMs = performance.now() - mergeStart;
		expect(mergeMs).toBeLessThan(10_000);

		const mergedHtml = await readFile(join(f.mainWorktree, "index.html"), "utf8");
		expect(mergedHtml).toContain("Updated Header v2");
		expect(mergedHtml).toContain("Updated Footer v2");
		expect(mergedHtml).toContain("199 DKK");

		await expect(
			cherryPickChangeUnits(f.job, { repository: f.repository, expectMainSha: mainSha, changes: [c7] }),
		).rejects.toSatisfy(
			(err: unknown) =>
				err instanceof CodeHostChangeConflict && err.changeId === c7.changeId && err.paths.includes("index.html"),
		);
		expect(await f.git(f.repo, "rev-parse", "refs/heads/main")).toBe(mainSha);

		const rebasedS0 = await rebaseSessionChanges(f.job, {
			repository: f.repository,
			workerId: s0.workerId,
			ontoSha: mainSha,
			remainingChanges: [c0b],
			updateBranchRef: true,
		});
		expect(rebasedS0.status).toBe("clean");
		if (rebasedS0.status !== "clean") throw new Error("expected clean rebase");

		expect(await f.git(s0.worktree, "status", "--porcelain")).toBe("");
		const s0DiskHtml = await readFile(join(s0.worktree, "index.html"), "utf8");
		expect(s0DiskHtml).toContain("Updated Header v2");
		expect(s0DiskHtml).toContain("Updated Footer v2");
		expect(s0DiskHtml).toContain("199 DKK");
		expect(await readFile(join(s0.worktree, "blog.html"), "utf8")).toContain("Blog");

		const followUpHead = await s0.commit({ "extra.html": "<p>Follow-up</p>\n" }, "Follow-up after rebase");
		const rebasedC0b = rebasedS0.rebasedChanges[0]!;
		const landedFollowUp = await cherryPickChangeUnits(f.job, {
			repository: f.repository,
			expectMainSha: mainSha,
			changes: [
				{ changeId: c0b.changeId, parentSha: rebasedC0b.parentSha, headSha: rebasedC0b.headSha, title: c0b.title },
				{ changeId: randomUUID(), parentSha: rebasedC0b.headSha, headSha: followUpHead, title: "Follow-up" },
			],
		});
		const finalHtml = await readFile(join(f.mainWorktree, "index.html"), "utf8");
		expect(finalHtml).toContain("Updated Header v2");
		expect(finalHtml).toContain("Updated Footer v2");
		expect(finalHtml).toContain("199 DKK");
		expect(await readFile(join(f.mainWorktree, "contact.html"), "utf8")).toContain("Contact");
		expect(await readFile(join(f.mainWorktree, "extra.html"), "utf8")).toContain("Follow-up");
		expect(landedFollowUp.mainAfter).toMatch(/^[0-9a-f]{40}$/);
	}, 30_000);

	it("protects dirty/active worktrees, prevents dangling SHAs on mid-chain conflict, rejects inverted ranges, and tracks renames", async () => {
		const f = await createStressFixture("conflicts");
		const baseSha = await f.commitMain(
			{ "index.html": "<h1>V1</h1>\n", "old-name.js": "export const x = 1;\n" },
			"Base",
		);

		const active = await f.startSession(baseSha);
		const committedHead = await active.commit({ "feature.js": "export const a = 1;\n" }, "Committed part");
		await writeFile(join(active.worktree, "feature.js"), "export const a = 2; // WIP uncommitted\n");

		const other = await f.startSession(baseSha);
		const otherHead = await other.commit({ "other.js": "export const b = 1;\n" }, "Other");
		const landedOther = await cherryPickChangeUnits(f.job, {
			repository: f.repository,
			changes: [{ changeId: randomUUID(), parentSha: baseSha, headSha: otherHead, title: "Other" }],
		});

		const dirtyChangeId = randomUUID();
		const dirtyRebase = await rebaseSessionChanges(f.job, {
			repository: f.repository,
			workerId: active.workerId,
			ontoSha: landedOther.mainAfter,
			remainingChanges: [
				{ changeId: dirtyChangeId, parentSha: baseSha, headSha: committedHead, title: "Committed" },
			],
			updateBranchRef: true,
		});
		expect(dirtyRebase).toMatchObject({ status: "deferred", reason: "worktree_dirty" });
		expect(await readFile(join(active.worktree, "feature.js"), "utf8")).toContain("WIP uncommitted");
		expect(await f.git(f.repo, "rev-parse", `refs/heads/qorpera/coding/${active.workerId}`)).toBe(committedHead);

		const advancedPeer = await f.startSession(baseSha);
		const stagedChangeId = randomUUID();
		const stagedH1 = await advancedPeer.commit({ "staged.js": "export const s = 1;\n" }, "Staged H1");
		const unstagedH2 = await advancedPeer.commit({ "wip-next.js": "export const s = 2;\n" }, "Follow-up H2");
		const advancedRebase = await rebaseSessionChanges(f.job, {
			repository: f.repository,
			workerId: advancedPeer.workerId,
			ontoSha: landedOther.mainAfter,
			remainingChanges: [{ changeId: stagedChangeId, parentSha: baseSha, headSha: stagedH1, title: "Staged H1" }],
			updateBranchRef: true,
		});
		expect(advancedRebase).toMatchObject({ status: "deferred", reason: "branch_advanced" });
		expect(await f.git(f.repo, "rev-parse", `refs/heads/qorpera/coding/${advancedPeer.workerId}`)).toBe(unstagedH2);
		expect(await readFile(join(advancedPeer.worktree, "wip-next.js"), "utf8")).toContain("export const s = 2;");

		const assumePeer = await f.startSession(baseSha);
		const assumeHead = await assumePeer.commit({ "hidden.js": "export const h = 1;\n" }, "Hidden base");
		await f.git(assumePeer.worktree, "update-index", "--assume-unchanged", "hidden.js");
		await writeFile(join(assumePeer.worktree, "hidden.js"), "export const h = 999;\n");
		const assumeRebase = await rebaseSessionChanges(f.job, {
			repository: f.repository,
			workerId: assumePeer.workerId,
			ontoSha: landedOther.mainAfter,
			remainingChanges: [{ changeId: randomUUID(), parentSha: baseSha, headSha: assumeHead, title: "Hidden" }],
			updateBranchRef: true,
		});
		expect(assumeRebase).toMatchObject({ status: "deferred", reason: "worktree_dirty" });
		expect(await readFile(join(assumePeer.worktree, "hidden.js"), "utf8")).toContain("export const h = 999;");

		const subPeer = await f.startSession(baseSha);
		const nestedRepoDir = join(subPeer.worktree, "submod");
		await mkdir(nestedRepoDir, { recursive: true });
		await f.git(nestedRepoDir, "init", "--quiet");
		await writeFile(join(nestedRepoDir, "inner.txt"), "nested\n");
		await f.git(nestedRepoDir, "add", "inner.txt");
		await f.git(nestedRepoDir, "commit", "--quiet", "-m", "Nested");
		await f.git(subPeer.worktree, "add", "submod");
		await f.git(subPeer.worktree, "commit", "--quiet", "-m", "Add gitlink");
		const subHead = await f.git(subPeer.worktree, "rev-parse", "HEAD");
		const logCountBeforeSub = f.log.length;
		const subRebase = await rebaseSessionChanges(f.job, {
			repository: f.repository,
			workerId: subPeer.workerId,
			ontoSha: landedOther.mainAfter,
			remainingChanges: [{ changeId: randomUUID(), parentSha: baseSha, headSha: subHead, title: "Submod" }],
			updateBranchRef: true,
		});
		expect(subRebase).toMatchObject({ status: "deferred", reason: "worktree_unsafe" });
		const subCommands = f.log.slice(logCountBeforeSub);
		expect(subCommands.some((cmd) => cmd.argv.includes("status") || cmd.argv.includes("reset"))).toBe(false);

		const lockedPeer = await f.startSession(baseSha);
		const lockedHead = await lockedPeer.commit({ "locked.js": "export const l = 1;\n" }, "Locked peer");
		const lockPath = join(f.repo, "worktrees", lockedPeer.workerId, "index.lock");
		await writeFile(lockPath, "");
		const lockedRebase = await rebaseSessionChanges(f.job, {
			repository: f.repository,
			workerId: lockedPeer.workerId,
			ontoSha: landedOther.mainAfter,
			remainingChanges: [{ changeId: randomUUID(), parentSha: baseSha, headSha: lockedHead, title: "Locked" }],
			updateBranchRef: true,
		});
		expect(lockedRebase).toMatchObject({ status: "deferred", reason: "worktree_unsafe" });
		expect(await f.git(f.repo, "rev-parse", `refs/heads/qorpera/coding/${lockedPeer.workerId}`)).toBe(lockedHead);
		expect(await readFile(join(lockedPeer.worktree, "locked.js"), "utf8")).toContain("export const l = 1;");
		expect(existsSync(join(lockedPeer.worktree, "other.js"))).toBe(false);
		await rm(lockPath, { force: true });

		await expect(
			cherryPickChangeUnits(f.job, {
				repository: f.repository,
				changes: [{ changeId: randomUUID(), parentSha: committedHead, headSha: baseSha, title: "Inverted" }],
			}),
		).rejects.toMatchObject({ code: "CODE_HOST_INVALID_CHANGE_RANGE" });

		const renamer = await f.startSession(landedOther.mainAfter);
		await f.git(renamer.worktree, "mv", "old-name.js", "new-name.js");
		await f.git(renamer.worktree, "commit", "-m", "Rename file");
		const renameHead = await f.git(renamer.worktree, "rev-parse", "HEAD");
		const inspected = await inspectChangeRange(f.job, {
			repository: f.repository,
			workerId: renamer.workerId,
			parentSha: landedOther.mainAfter,
			headSha: renameHead,
		});
		expect([...inspected.affectedPaths].sort()).toEqual(["new-name.js", "old-name.js"]);

		const multi = await f.startSession(baseSha);
		const m1Id = randomUUID();
		const m2Id = randomUUID();
		const m3Id = randomUUID();
		const m1Head = await multi.commit({ "m1.html": "<p>m1</p>\n" }, "M1");
		const m2Head = await multi.commit({ "m2.html": "<p>m2</p>\n" }, "M2");
		const m3Head = await multi.commit({ "index.html": "<h1>Conflict from M3</h1>\n" }, "M3");
		const blocker = await f.startSession(landedOther.mainAfter);
		const blockerHead = await blocker.commit({ "index.html": "<h1>Main Winner</h1>\n" }, "Main winner");
		const landedBlocker = await cherryPickChangeUnits(f.job, {
			repository: f.repository,
			changes: [
				{ changeId: randomUUID(), parentSha: landedOther.mainAfter, headSha: blockerHead, title: "Main winner" },
			],
		});

		const rebaseRpcs: Record<string, unknown>[] = [];
		const workerEvents: Record<string, unknown>[] = [];
		const profileId = randomUUID();
		const environmentId = randomUUID();
		const surfaceId = randomUUID();
		const sessionId = randomUUID();
		const advancedPeerSessionId = randomUUID();
		let claimed = false;
		const worker = new SurfaceCodeHostWorker({
			report: (ev) => workerEvents.push(ev),
			control: {
				async call(method: SurfaceCodeHostRpc, args: Record<string, unknown>) {
					if (method === "qorpera_surface_claim_pending_jobs_for_lane") {
						if (claimed) return { sessions: [], previews: [], merges: [], publishes: [], automations: [] };
						claimed = true;
						return {
							sessions: [],
							previews: [],
							publishes: [],
							automations: [],
							merges: [
								{
									jobId: randomUUID(),
									kind: "land_change",
									surfaceId,
									sessionId,
									profileId,
									environmentId,
									leaseToken: randomUUID(),
									sourceKind: "code_repo",
									repositoryKey: "surfaces/conflicts",
									folderRoot: null,
									expectMainSha: landedBlocker.mainAfter,
									sessionWorkerId: multi.workerId,
									sessionState: "ready",
									sessionHasActiveChat: false,
									payload: { changeIds: [m1Id] },
									allSessionChangeStatuses: [
										{ changeId: m1Id, status: "merging" },
										{ changeId: m2Id, status: "staged" },
										{ changeId: m3Id, status: "staged" },
									],
									approvedChanges: [
										{
											changeId: m1Id,
											kind: "git_range",
											parentSha: baseSha,
											headSha: m1Head,
											title: "M1",
											summary: "",
											patchManifest: null,
											affectedPaths: ["m1.html"],
										},
									],
									siblingRemainingChanges: [
										{ changeId: m2Id, parentSha: m1Head, headSha: m2Head, title: "M2" },
										{ changeId: m3Id, parentSha: m2Head, headSha: m3Head, title: "M3" },
									],
									peerSessions: [
										{
											sessionId: advancedPeerSessionId,
											workerId: advancedPeer.workerId,
											remainingChanges: [
												{
													changeId: stagedChangeId,
													parentSha: baseSha,
													headSha: stagedH1,
													title: "Staged H1",
												},
											],
										},
									],
								},
							],
						};
					}
					if (method === "qorpera_surface_update_rebased_changes") {
						rebaseRpcs.push(args);
						return { updated: 1 };
					}
					if (method === "qorpera_surface_complete_merge") return { ok: true };
					if (method === "qorpera_surface_renew_lease") return { renewed: true };
					throw new Error(`Unexpected RPC ${method}`);
				},
			},
			hosts: {
				async run(_c, _e, _s, fn) {
					return await fn(f.job, undefined as never);
				},
			},
		});
		const pass = await worker.pass(new AbortController().signal);
		expect(pass).toEqual({ previews: 0, merges: 1, publishes: 0, failed: 0 });
		expect(rebaseRpcs).toHaveLength(1);
		expect(rebaseRpcs[0]).toMatchObject({
			p_branch_head_sha: null,
			p_rebased_changes: [],
			p_conflicted_change_id: m3Id,
			p_conflict_paths: ["index.html"],
		});
		expect(workerEvents).toContainEqual(
			expect.objectContaining({
				event: "surface-code-host-rebase-deferred",
				sessionId: advancedPeerSessionId,
				reason: "branch_advanced",
			}),
		);
		expect(await f.git(f.repo, "rev-parse", `refs/heads/qorpera/coding/${advancedPeer.workerId}`)).toBe(unstagedH2);
	}, 25_000);

	it("handles 20 rapid preview toggles outside hosts.run lock, parallel multi-part uploads, zero leaked refs, and CODE_HOST_JOB_YIELDED retries", async () => {
		const f = await createStressFixture("previewburst");
		const bigJs = `// ${"a".repeat(220 * 1024)}\nexport const ok = true;\n`;
		const baseSha = await f.commitMain(
			{
				".gitignore": "node_modules/\n",
				"index.html": "<!doctype html><h1>Base</h1>\n",
				"bundle.js": bigJs,
			},
			"Base",
		);
		const s1 = await f.startSession(baseSha);
		const s2 = await f.startSession(baseSha);
		const s3 = await f.startSession(baseSha);
		const c1 = {
			changeId: randomUUID(),
			parentSha: baseSha,
			headSha: await s1.commit({ "a.html": "<p>A</p>\n" }, "A"),
			title: "A",
		};
		const c2 = {
			changeId: randomUUID(),
			parentSha: baseSha,
			headSha: await s2.commit({ "b.html": "<p>B</p>\n" }, "B"),
			title: "B",
		};
		const c3 = {
			changeId: randomUUID(),
			parentSha: baseSha,
			headSha: await s3.commit({ "c.html": "<p>C</p>\n" }, "C"),
			title: "C",
		};

		let insideHostsRun = false;
		let uploadWhileLocked = false;
		let maxConcurrentPuts = 0;
		let activePuts = 0;
		let hostCalls = 0;
		const completedStatuses: string[] = [];
		const uploadedContent = new Map<string, Map<string, Buffer>>();
		const profileId = randomUUID();
		const environmentId = randomUUID();
		const surfaceId = randomUUID();
		const siteId = randomUUID();

		const previews = Array.from({ length: 20 }, (_, i) => {
			const subset = [c1, c2, c3].filter((_, bit) => ((i + 1) & (1 << bit)) !== 0);
			return {
				previewId: randomUUID(),
				surfaceId,
				profileId,
				environmentId,
				shortHostId: `p${String(i).padStart(7, "0")}`,
				baseSha,
				selectedChangeIds: subset.map((c) => c.changeId),
				repositoryKey: "surfaces/previewburst",
				leaseToken: randomUUID(),
				changes: subset,
			};
		});

		let queueIndex = 0;
		const worker = new SurfaceCodeHostWorker({
			batchLimit: 20,
			uploadConcurrency: 6,
			yieldRetryDelaysMs: [5, 5],
			control: {
				async call(method: SurfaceCodeHostRpc, args: Record<string, unknown>) {
					expect(SURFACE_CODE_HOST_RPCS).toContain(method);
					if (method.startsWith("qorpera_surface_site_version_") && insideHostsRun) {
						uploadWhileLocked = true;
					}
					if (method === "qorpera_surface_claim_pending_jobs_for_lane") {
						const batch = previews.slice(queueIndex);
						queueIndex = previews.length;
						return { sessions: [], previews: batch, merges: [], publishes: [], automations: [] };
					}
					if (method === "qorpera_surface_site_version_begin") {
						const versionId = randomUUID();
						uploadedContent.set(versionId, new Map());
						return { state: "uploading", versionId, siteId, siteSlug: "previewburst", listed: false };
					}
					if (method === "qorpera_surface_site_version_list") {
						return { state: "listed", missing: 1 };
					}
					if (method === "qorpera_surface_site_version_put") {
						activePuts += 1;
						maxConcurrentPuts = Math.max(maxConcurrentPuts, activePuts);
						await new Promise((resolve) => setTimeout(resolve, 2));
						const map = uploadedContent.get(String(args.p_version_id))!;
						for (const part of (args.p_parts as { parts: { path: string; contentBase64: string }[] }).parts) {
							const prev = map.get(part.path) ?? Buffer.alloc(0);
							map.set(part.path, Buffer.concat([prev, Buffer.from(part.contentBase64, "base64")]));
						}
						activePuts -= 1;
						return { state: "kept", filed: 1 };
					}
					if (method === "qorpera_surface_site_version_finish") {
						return { state: "ready", versionId: args.p_version_id, siteId, siteSlug: "previewburst" };
					}
					if (method === "qorpera_surface_complete_preview") {
						completedStatuses.push(String(args.p_status));
						return { ok: true };
					}
					if (method === "qorpera_surface_renew_lease") return { renewed: true };
					throw new Error(`Unexpected RPC ${method}`);
				},
			},
			hosts: {
				async run(_c, _e, _s, fn, opts) {
					expect(opts?.yields).toBe(true);
					hostCalls += 1;
					if (hostCalls <= 2) {
						throw new CodeHostJobFailure("CODE_HOST_JOB_YIELDED", "preempted by merge");
					}
					insideHostsRun = true;
					try {
						return await fn(f.job, undefined as never);
					} finally {
						insideHostsRun = false;
					}
				},
			},
		});

		const startedAt = performance.now();
		const res = await worker.pass(new AbortController().signal);
		const elapsedMs = performance.now() - startedAt;

		expect(res).toEqual({ previews: 20, merges: 0, publishes: 0, failed: 0 });
		expect(completedStatuses.every((s) => s === "ready")).toBe(true);
		expect(uploadWhileLocked).toBe(false);
		expect(maxConcurrentPuts).toBeGreaterThanOrEqual(2);
		expect(elapsedMs).toBeLessThan(15_000);

		const firstVersionFiles = [...uploadedContent.values()][0]!;
		expect(firstVersionFiles.get("bundle.js")?.toString("utf8")).toBe(bigJs);

		const leakedRefs = await f.git(f.repo, "for-each-ref", "refs/qorpera/previews");
		expect(leakedRefs).toBe("");

		const yieldedEvents: Record<string, unknown>[] = [];
		const completeOnYield: string[] = [];
		let yieldClaimed = false;
		const yieldWorker = new SurfaceCodeHostWorker({
			yieldRetryDelaysMs: [1],
			report: (ev) => yieldedEvents.push(ev),
			control: {
				async call(method: SurfaceCodeHostRpc, args: Record<string, unknown>) {
					if (method === "qorpera_surface_claim_pending_jobs_for_lane") {
						if (yieldClaimed) return { sessions: [], previews: [], merges: [], publishes: [], automations: [] };
						yieldClaimed = true;
						return { sessions: [], previews: [previews[0]], merges: [], publishes: [], automations: [] };
					}
					if (method === "qorpera_surface_complete_preview") {
						completeOnYield.push(String(args.p_status));
						return { ok: true };
					}
					return { renewed: true };
				},
			},
			hosts: {
				async run() {
					throw new CodeHostJobFailure("CODE_HOST_JOB_YIELDED", "still busy");
				},
			},
		});
		const yieldPass = await yieldWorker.pass(new AbortController().signal);
		expect(yieldPass).toEqual({ previews: 0, merges: 0, publishes: 0, failed: 0 });
		expect(completeOnYield).toEqual([]);
		expect(yieldedEvents.some((ev) => ev.event === "surface-code-host-yielded")).toBe(true);
	}, 25_000);

	it("executes distinct companies concurrently and aborts work if lease renewal returns renewed=false", async () => {
		const fixtures = await Promise.all([
			createStressFixture("co1"),
			createStressFixture("co2"),
			createStressFixture("co3"),
			createStressFixture("co4"),
		]);
		const baseShas = await Promise.all(
			fixtures.map((f, i) => f.commitMain({ "index.html": `<h1>Company ${i}</h1>\n` }, "Init")),
		);
		const byProfile = new Map<string, (typeof fixtures)[number]>();
		const previewJobs = fixtures.map((f, i) => {
			const profileId = randomUUID();
			byProfile.set(profileId, f);
			return {
				previewId: randomUUID(),
				surfaceId: randomUUID(),
				profileId,
				environmentId: randomUUID(),
				shortHostId: `co${i}00000`,
				baseSha: baseShas[i]!,
				selectedChangeIds: [],
				repositoryKey: `surfaces/co${i + 1}`,
				leaseToken: randomUUID(),
				changes: [],
			};
		});

		let activeCompanies = 0;
		let peakCompanies = 0;
		let claimed = false;
		const worker = new SurfaceCodeHostWorker({
			companyConcurrency: 4,
			control: {
				async call(method: SurfaceCodeHostRpc) {
					if (method === "qorpera_surface_claim_pending_jobs_for_lane") {
						if (claimed) return { sessions: [], previews: [], merges: [], publishes: [], automations: [] };
						claimed = true;
						return { sessions: [], previews: previewJobs, merges: [], publishes: [], automations: [] };
					}
					if (method === "qorpera_surface_site_version_begin") {
						return {
							state: "uploading",
							versionId: randomUUID(),
							siteId: randomUUID(),
							siteSlug: "co",
							listed: false,
						};
					}
					if (method === "qorpera_surface_site_version_list") return { state: "listed", missing: 1 };
					if (method === "qorpera_surface_site_version_put") return { state: "kept", filed: 1 };
					if (method === "qorpera_surface_site_version_finish") return { state: "ready" };
					if (method === "qorpera_surface_complete_preview") return { ok: true };
					return { renewed: true };
				},
			},
			hosts: {
				async run(profileId, _e, _s, fn) {
					activeCompanies += 1;
					peakCompanies = Math.max(peakCompanies, activeCompanies);
					await new Promise((resolve) => setTimeout(resolve, 25));
					try {
						return await fn(byProfile.get(profileId)!.job, undefined as never);
					} finally {
						activeCompanies -= 1;
					}
				},
			},
		});

		const res = await worker.pass(new AbortController().signal);
		expect(res).toEqual({ previews: 4, merges: 0, publishes: 0, failed: 0 });
		expect(peakCompanies).toBe(4);
	}, 20_000);

	it("handles Brooks-style 250-file monorepo preview discovery, root config filtering, starter checks.json schema, and 2600-byte folder limit", async () => {
		const f = await createStressFixture("brooks");
		const files: Record<string, string> = {
			".gitignore": "node_modules/\ndist/\n.env\n",
			".qorpera/checks.json": `// JSONC comment in checks.json\n${JSON.stringify({
				preview: { run: "true", folder: "apps/brooks-produktkoncept", cwd: ".", timeoutSeconds: 60 },
				checks: [{ name: "test", run: "npm test" }],
			})}`,
			"package.json": '{"name":"brooks-monorepo","private":true}\n',
			"package-lock.json": `{"lockfileVersion":3,"pad":"${"x".repeat(120 * 1024)}"}\n`,
			"docs/product-spec.md": "# Brooks Product Spec\n",
			"apps/brooks-produktkoncept/index.html":
				"<!doctype html><title>Brooks</title><script src='./app.js'></script>\n",
			"apps/brooks-produktkoncept/app.js": "console.log('brooks');\n",
			"apps/brooks-produktkoncept/style.css": "body { color: #111; }\n",
		};
		for (let i = 0; i < 80; i += 1) {
			files[`node_modules/pkg-${i}/index.js`] = `module.exports = ${i};\n`;
		}
		for (let i = 0; i < 160; i += 1) {
			files[`apps/brooks-produktkoncept/assets/item-${i}.json`] = JSON.stringify({ id: i, ok: true });
		}
		const monorepoSha = await f.commitMain(files, "Brooks monorepo");
		const monorepoTreeSha = await f.git(f.repo, "rev-parse", `${monorepoSha}^{tree}`);

		const checksText = files[".qorpera/checks.json"]!;
		const checksBytes = Buffer.from(checksText, "utf8");
		const checksBlobSha = createHash("sha1")
			.update(`blob ${checksBytes.byteLength}\0`)
			.update(checksBytes)
			.digest("hex");
		const parsedOrch = readCodeChecks({ entry: { kind: "file", bytes: checksBytes }, blob: checksBlobSha });
		expect(parsedOrch.state).toBe("ok");
		const parsedRuntime = parseCodeChecksText(checksText);
		expect(parsedRuntime.ok).toBe(true);

		const t0 = performance.now();
		const siteTree = await readSurfaceSiteTree(f.job, { repository: f.repository, tree: monorepoTreeSha });
		const readMs = performance.now() - t0;
		expect(readMs).toBeLessThan(5_000);
		expect(siteTree.files.length).toBe(163);
		expect(siteTree.files.some((file) => file.path === "index.html")).toBe(true);
		expect(siteTree.files.some((file) => file.path.includes("node_modules"))).toBe(false);
		expect(siteTree.files.some((file) => file.path.includes(".gitignore"))).toBe(false);
		expect(siteTree.files.some((file) => file.path.includes("package-lock.json"))).toBe(false);

		const rootFixture = await createStressFixture("rootapp");
		const rootSha = await rootFixture.commitMain(
			{
				".gitignore": "dist/\n",
				"index.html": "<!doctype html><h1>Root App</h1>\n",
				"app.js": "console.log('hi');\n",
				"package.json": '{"name":"rootapp"}\n',
				"package-lock.json": '{"lockfileVersion":3}\n',
				"vite.config.js": "export default {};\n",
				"tsconfig.app.json": '{"compilerOptions":{}}\n',
			},
			"Root app with configs",
		);
		const rootTreeSha = await rootFixture.git(rootFixture.repo, "rev-parse", `${rootSha}^{tree}`);
		const rootSite = await readSurfaceSiteTree(rootFixture.job, {
			repository: rootFixture.repository,
			tree: rootTreeSha,
		});
		expect(rootSite.files.map((file) => file.path)).toEqual(["app.js", "index.html"]);

		const missingFolderSha = await rootFixture.commitMain(
			{
				".qorpera/checks.json": JSON.stringify({
					site: { folder: "dist-not-built" },
					checks: [{ name: "b", run: "true" }],
				}),
			},
			"Explicit missing dist",
		);
		const missingTreeSha = await rootFixture.git(rootFixture.repo, "rev-parse", `${missingFolderSha}^{tree}`);
		await expect(
			readSurfaceSiteTree(rootFixture.job, { repository: rootFixture.repository, tree: missingTreeSha }),
		).rejects.toSatisfy(
			(err: unknown) => err instanceof CodeSiteTreeInvalid && err.problem.code === "SITE_FOLDER_MISSING",
		);

		const starterFixture = await createStressFixture("startercheck");
		const starterRepo = { host: "qorpera" as const, owner: "surfaces", name: "fresh-surface", baseBranch: "main" };
		await ensureSurfaceStarterRepository(starterFixture.job, { repository: starterRepo, title: "Fresh Surface" });
		const starterChecks = await readFile(
			join(starterFixture.companyRoot, "code/surfaces/fresh-surface/main/.qorpera/checks.json"),
			"utf8",
		);
		const starterBytes = Buffer.from(starterChecks, "utf8");
		const starterBlob = createHash("sha1")
			.update(`blob ${starterBytes.byteLength}\0`)
			.update(starterBytes)
			.digest("hex");
		expect(readCodeChecks({ entry: { kind: "file", bytes: starterBytes }, blob: starterBlob }).state).toBe("ok");
		expect(parseCodeChecksText(starterChecks).ok).toBe(true);

		const area = "code/surfaces/brooks";
		const makePath = (bytes: number) => {
			const parts = Array.from({ length: Math.floor(bytes / 201) }, () => "d".repeat(200));
			return [...parts, "e".repeat(bytes - parts.length * 201)].join("/");
		};
		expect(CODE_FOLDER_KEY_BYTES).toBe(2600);
		expect(codeFolderRefuses(area, [{ type: "blob", path: Buffer.from(makePath(2574)) }], "main")).toEqual([]);
		expect(codeFolderRefuses(area, [{ type: "blob", path: Buffer.from(makePath(2575)) }], "main")).toHaveLength(1);
		expect(
			codeFolderRefuses(area, [{ type: "blob", path: Buffer.from(makePath(2532)) }], CODE_FOLDER_ANY_SESSION),
		).toEqual([]);
		expect(
			codeFolderRefuses(area, [{ type: "blob", path: Buffer.from(makePath(2533)) }], CODE_FOLDER_ANY_SESSION),
		).toHaveLength(1);
	}, 25_000);

	it("handles selective undo, detects CODE_HOST_UNDO_CONFLICT without mutating main, and aborts work when lease renewal returns renewed=false", async () => {
		const f = await createStressFixture("undostress");
		const baseSha = await f.commitMain(
			{ "index.html": "<h1>V0</h1>\n", "faq.html": "<p>V0</p>\n", "footer.html": "<p>V0</p>\n" },
			"V0",
		);
		const s1 = await f.startSession(baseSha);
		const s2 = await f.startSession(baseSha);
		const h1 = await s1.commit({ "index.html": "<h1>V1</h1>\n" }, "C1");
		const h2 = await s2.commit({ "faq.html": "<p>V1</p>\n" }, "C2");
		const land1 = await cherryPickChangeUnits(f.job, {
			repository: f.repository,
			expectMainSha: baseSha,
			changes: [{ changeId: randomUUID(), parentSha: baseSha, headSha: h1, title: "C1" }],
		});
		const land2 = await cherryPickChangeUnits(f.job, {
			repository: f.repository,
			expectMainSha: land1.mainAfter,
			changes: [{ changeId: randomUUID(), parentSha: baseSha, headSha: h2, title: "C2" }],
		});
		const s3 = await f.startSession(land2.mainAfter);
		const h3 = await s3.commit({ "index.html": "<h1>V2 overwrites V1</h1>\n" }, "C3");
		const land3 = await cherryPickChangeUnits(f.job, {
			repository: f.repository,
			expectMainSha: land2.mainAfter,
			changes: [{ changeId: randomUUID(), parentSha: land2.mainAfter, headSha: h3, title: "C3" }],
		});

		const undo2 = await undoSurfaceCodeRepoChange(f.job, {
			jobId: randomUUID(),
			changeId: randomUUID(),
			repository: f.repository,
			landedMainBefore: land2.mainBefore,
			landedMainAfter: land2.mainAfter,
		});
		expect(undo2.status).toBe("landed");
		expect(await readFile(join(f.mainWorktree, "faq.html"), "utf8")).toBe("<p>V0</p>\n");
		expect(await readFile(join(f.mainWorktree, "index.html"), "utf8")).toBe("<h1>V2 overwrites V1</h1>\n");

		const mainBeforeConflictUndo = await f.git(f.repo, "rev-parse", "refs/heads/main");
		const undo1 = await undoSurfaceCodeRepoChange(f.job, {
			jobId: randomUUID(),
			changeId: randomUUID(),
			repository: f.repository,
			landedMainBefore: land1.mainBefore,
			landedMainAfter: land1.mainAfter,
		});
		expect(undo1.status).toBe("conflicted");
		if (undo1.status !== "conflicted") throw new Error("expected undo conflict");
		expect(undo1.conflictPaths).toEqual(["index.html"]);
		expect(await f.git(f.repo, "rev-parse", "refs/heads/main")).toBe(mainBeforeConflictUndo);
		expect(land3.mainAfter).toMatch(/^[0-9a-f]{40}$/);

		let observedSignalAborted = false;
		let claimed = false;
		const leaseWorker = new SurfaceCodeHostWorker({
			leaseRenewIntervalMs: 50,
			control: {
				async call(method: SurfaceCodeHostRpc) {
					if (method === "qorpera_surface_claim_pending_jobs_for_lane") {
						if (claimed) return { sessions: [], previews: [], merges: [], publishes: [], automations: [] };
						claimed = true;
						return {
							sessions: [],
							previews: [
								{
									previewId: randomUUID(),
									surfaceId: randomUUID(),
									profileId: randomUUID(),
									environmentId: randomUUID(),
									shortHostId: "lease001",
									baseSha: mainBeforeConflictUndo,
									selectedChangeIds: [],
									repositoryKey: "surfaces/undostress",
									leaseToken: randomUUID(),
									changes: [],
								},
							],
							merges: [],
							publishes: [],
							automations: [],
						};
					}
					if (method === "qorpera_surface_renew_lease") {
						return { renewed: false };
					}
					return { ok: true };
				},
			},
			hosts: {
				async run<T>(_c: string, _e: string, jobSignal: AbortSignal): Promise<T> {
					await new Promise<void>((resolve, reject) => {
						const timer = setTimeout(() => resolve(), 2_000);
						jobSignal.addEventListener(
							"abort",
							() => {
								clearTimeout(timer);
								observedSignalAborted = true;
								reject(jobSignal.reason);
							},
							{ once: true },
						);
					});
					return undefined as T;
				},
			},
		});
		const leasePass = await leaseWorker.pass(new AbortController().signal);
		expect(observedSignalAborted).toBe(true);
		expect(leasePass.failed).toBe(1);
	}, 20_000);
});
