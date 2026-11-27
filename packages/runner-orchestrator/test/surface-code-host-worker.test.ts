import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SURFACE_IDENTITY_CSS_MOUNT_PATH } from "@qorpera/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
	addCodeWorktree,
	type CodeHostCommand,
	type CodeHostJob,
	CodeHostJobFailure,
	type CodeHostShell,
	startCodeArea,
} from "../src/code-host-jobs.ts";
import { readCodeSiteTree, readSurfacePreviewPlan, readSurfaceSiteTree } from "../src/code-host-sites.ts";
import { ensureSurfaceStarterRepository } from "../src/code-host-surfaces.ts";
import {
	SURFACE_CODE_HOST_RPCS,
	type SurfaceCodeHostRpc,
	SurfaceCodeHostWorker,
} from "../src/surface-code-host-worker.ts";
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

async function createCodeHostFixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "surface-code-host-")));
	roots.push(root);
	const companyRoot = join(root, "folder");
	const scratchRoot = join(root, "scratch");
	await mkdir(join(companyRoot, "identity"), { recursive: true });
	await mkdir(scratchRoot, { recursive: true });
	await writeFile(
		join(companyRoot, "identity/tokens.json"),
		JSON.stringify({ colors: { accent: "#c84b31", surface: "#faf7f2" } }),
	);
	const log: CodeHostCommand[] = [];
	const job: CodeHostJob = {
		shell: crossPlatformLocalShell(log),
		layout: { companyRoot, scratchRoot, git: GIT },
		signal: new AbortController().signal,
	};
	const repository = { host: "qorpera" as const, owner: "thetaband", name: "website", baseBranch: "main" };
	await startCodeArea(job, { repository });
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
	const mainWorktree = join(code, "main");
	await writeFile(join(mainWorktree, "index.html"), "<!doctype html><h1>Original</h1>\n");
	await git(mainWorktree, "add", "index.html");
	await git(mainWorktree, "commit", "-m", "Add index.html");
	const baseSha = await git(mainWorktree, "rev-parse", "HEAD");
	await git(join(code, "repo.git"), "update-ref", "refs/heads/main", baseSha);
	return { companyRoot, job, repository, code, baseSha, git };
}

describe("SurfaceCodeHostWorker", () => {
	it("composes previews, lands selective merges after view publish, persists rebases, and publishes live sites with synced identity CSS", async () => {
		const f = await createCodeHostFixture();
		const profileId = randomUUID();
		const environmentId = randomUUID();
		const surfaceId = randomUUID();
		const siteId = randomUUID();
		const sessionId = randomUUID();
		const workerId = randomUUID();
		const changeA = randomUUID();
		const changeB = randomUUID();

		await addCodeWorktree(f.job, { repository: f.repository, workerId, baseSha: f.baseSha });
		const sessionWorktree = join(f.code, "worktrees", workerId);

		await writeFile(join(sessionWorktree, "index.html"), "<!doctype html><h1>Updated Hero</h1>\n");
		await f.git(sessionWorktree, "add", "index.html");
		await f.git(sessionWorktree, "commit", "-m", "Update hero");
		const shaA = await f.git(sessionWorktree, "rev-parse", "HEAD");

		await writeFile(join(sessionWorktree, "pricing.html"), "<!doctype html><p>149 DKK</p>\n");
		await f.git(sessionWorktree, "add", "pricing.html");
		await f.git(sessionWorktree, "commit", "-m", "Add pricing");
		const shaB = await f.git(sessionWorktree, "rev-parse", "HEAD");

		const rpcCalls: { method: SurfaceCodeHostRpc; args: Record<string, unknown> }[] = [];
		const uploadedFilesByVersion = new Map<string, Map<string, Buffer>>();
		const versionStates = new Map<string, string>();
		let pendingClaim: Record<string, unknown> = {
			sessions: [],
			previews: [],
			merges: [],
			publishes: [],
			automations: [],
		};

		const control = {
			async call(method: SurfaceCodeHostRpc, args: Record<string, unknown>): Promise<unknown> {
				expect(SURFACE_CODE_HOST_RPCS).toContain(method);
				rpcCalls.push({ method, args });
				switch (method) {
					case "qorpera_surface_claim_pending_jobs_for_lane": {
						expect(args.p_lane).toBe("code_repo");
						const res = pendingClaim;
						pendingClaim = { sessions: [], previews: [], merges: [], publishes: [], automations: [] };
						return res;
					}
					case "qorpera_surface_site_version_begin": {
						const versionId = randomUUID();
						uploadedFilesByVersion.set(versionId, new Map());
						versionStates.set(versionId, "uploading");
						return { state: "uploading", versionId, siteId, siteSlug: "thetaband-website", listed: false };
					}
					case "qorpera_surface_site_version_list": {
						const files = (args.p_files as { files: unknown[]; last: boolean }).files;
						return {
							state: (args.p_files as { last: boolean }).last ? "listed" : "listing",
							missing: files.length,
						};
					}
					case "qorpera_surface_site_version_put": {
						const versionId = String(args.p_version_id);
						const store = uploadedFilesByVersion.get(versionId)!;
						const parts = (args.p_parts as { parts: { path: string; contentBase64: string }[] }).parts;
						for (const part of parts) {
							const prev = store.get(part.path) ?? Buffer.alloc(0);
							store.set(part.path, Buffer.concat([prev, Buffer.from(part.contentBase64, "base64")]));
						}
						return { state: "kept", filed: parts.length };
					}
					case "qorpera_surface_site_version_finish": {
						const versionId = String(args.p_version_id);
						const state = args.p_promote_live === true ? "live" : "ready";
						versionStates.set(versionId, state);
						return { state, versionId, siteId, siteSlug: "thetaband-website" };
					}
					case "qorpera_surface_complete_preview":
						return { previewId: args.p_preview_id, status: args.p_status };
					case "qorpera_surface_complete_merge":
						return { jobId: args.p_job_id, status: args.p_status };
					case "qorpera_surface_complete_publish":
						return { jobId: args.p_job_id, status: args.p_status };
					case "qorpera_surface_update_rebased_changes":
						return { updated: 1, sessionId: args.p_session_id };
					case "qorpera_surface_renew_lease":
						return { renewed: true };
					case "qorpera_surface_shared_product_folder_roots":
						return [];
					default:
						throw new Error(`Unexpected RPC ${method}`);
				}
			},
		};

		const hostRunOrder: string[] = [];
		const hosts = {
			async run<T>(
				_companyId: string,
				_envId: string,
				_signal: AbortSignal,
				fn: (job: CodeHostJob, gc: never) => Promise<T>,
			): Promise<T> {
				hostRunOrder.push("enter");
				const result = await fn(f.job, undefined as never);
				hostRunOrder.push("published");
				return result;
			},
		};

		const worker = new SurfaceCodeHostWorker({ control, hosts, readTree: readCodeSiteTree });

		const previewId = randomUUID();
		const previewLease = randomUUID();
		pendingClaim = {
			sessions: [],
			previews: [
				{
					previewId,
					surfaceId,
					profileId,
					environmentId,
					shortHostId: "ab12cd34",
					baseSha: f.baseSha,
					selectedChangeIds: [changeA],
					repositoryKey: "thetaband/website",
					leaseToken: previewLease,
					changes: [{ changeId: changeA, parentSha: f.baseSha, headSha: shaA, title: "Update hero" }],
				},
			],
			merges: [],
			publishes: [],
			automations: [],
		};

		const previewPass = await worker.pass(new AbortController().signal);
		expect(previewPass).toEqual({ previews: 1, merges: 0, publishes: 0, cleanups: 0, failed: 0 });
		const previewComplete = rpcCalls.find((c) => c.method === "qorpera_surface_complete_preview");
		expect(previewComplete?.args).toMatchObject({
			p_preview_id: previewId,
			p_status: "ready",
			p_lease_token: previewLease,
		});
		const previewVersionId = String(previewComplete?.args.p_site_version_id);
		expect(versionStates.get(previewVersionId)).toBe("ready");
		const previewFiles = uploadedFilesByVersion.get(previewVersionId)!;
		expect(previewFiles.get("index.html")?.toString("utf8")).toContain("Updated Hero");
		expect(previewFiles.get(SURFACE_IDENTITY_CSS_MOUNT_PATH)?.toString("utf8")).toContain("#c84b31");

		rpcCalls.length = 0;
		hostRunOrder.length = 0;
		const mergeJobId = randomUUID();
		const mergeLease = randomUUID();
		pendingClaim = {
			sessions: [],
			previews: [],
			merges: [
				{
					jobId: mergeJobId,
					kind: "land_change",
					surfaceId,
					sessionId,
					profileId,
					environmentId,
					leaseToken: mergeLease,
					sourceKind: "code_repo",
					repositoryKey: "thetaband/website",
					folderRoot: null,
					expectMainSha: f.baseSha,
					sessionWorkerId: workerId,
					sessionState: "ready",
					sessionHasActiveChat: false,
					payload: { changeIds: [changeA] },
					allSessionChangeStatuses: [
						{ changeId: changeA, status: "merging" },
						{ changeId: changeB, status: "staged" },
					],
					approvedChanges: [
						{
							changeId: changeA,
							kind: "git_range",
							parentSha: f.baseSha,
							headSha: shaA,
							title: "Update hero",
							summary: "Updates hero heading",
							patchManifest: null,
							affectedPaths: ["index.html"],
						},
					],
					siblingRemainingChanges: [{ changeId: changeB, parentSha: shaA, headSha: shaB, title: "Add pricing" }],
					peerSessions: [],
				},
			],
			publishes: [],
			automations: [],
		};

		const mergePass = await worker.pass(new AbortController().signal);
		expect(mergePass).toEqual({ previews: 0, merges: 1, publishes: 0, cleanups: 0, failed: 0 });
		expect(hostRunOrder).toEqual(["enter", "published"]);
		const mergeComplete = rpcCalls.find((c) => c.method === "qorpera_surface_complete_merge");
		expect(mergeComplete?.args).toMatchObject({
			p_job_id: mergeJobId,
			p_status: "landed",
			p_main_before: f.baseSha,
			p_lease_token: mergeLease,
		});
		const rebaseCall = rpcCalls.find((c) => c.method === "qorpera_surface_update_rebased_changes");
		expect(rebaseCall?.args).toMatchObject({
			p_surface_id: surfaceId,
			p_session_id: sessionId,
		});
		const landedMainAfter = String(mergeComplete?.args.p_main_after);
		expect(landedMainAfter).toMatch(/^[0-9a-f]{40}$/);

		rpcCalls.length = 0;
		const publishJobId = randomUUID();
		const publishLease = randomUUID();
		pendingClaim = {
			sessions: [],
			previews: [],
			merges: [],
			publishes: [
				{
					jobId: publishJobId,
					surfaceId,
					profileId,
					environmentId,
					sourceKind: "code_repo",
					liveHeadSha: landedMainAfter,
					leaseToken: publishLease,
					repositoryKey: "thetaband/website",
					siteId,
					payload: {},
				},
			],
			automations: [],
		};

		const publishPass = await worker.pass(new AbortController().signal);
		expect(publishPass).toEqual({ previews: 0, merges: 0, publishes: 1, cleanups: 0, failed: 0 });
		const finishLive = rpcCalls.find(
			(c) => c.method === "qorpera_surface_site_version_finish" && c.args.p_promote_live === true,
		);
		expect(finishLive).toBeTruthy();
		const publishComplete = rpcCalls.find((c) => c.method === "qorpera_surface_complete_publish");
		expect(publishComplete?.args).toMatchObject({
			p_job_id: publishJobId,
			p_status: "published",
			p_published_head_sha: landedMainAfter,
			p_lease_token: publishLease,
		});
	});

	it("handles undo_change cleanly and marks merges failed when code-host view publication throws", async () => {
		const f = await createCodeHostFixture();
		const profileId = randomUUID();
		const environmentId = randomUUID();
		const surfaceId = randomUUID();
		const sessionId = randomUUID();
		const workerId = randomUUID();
		const changeA = randomUUID();

		await addCodeWorktree(f.job, { repository: f.repository, workerId, baseSha: f.baseSha });
		const sessionWorktree = join(f.code, "worktrees", workerId);
		await writeFile(join(sessionWorktree, "index.html"), "<!doctype html><h1>Reversible</h1>\n");
		await f.git(sessionWorktree, "add", "index.html");
		await f.git(sessionWorktree, "commit", "-m", "Reversible update");
		const shaA = await f.git(sessionWorktree, "rev-parse", "HEAD");

		const rpcCalls: { method: SurfaceCodeHostRpc; args: Record<string, unknown> }[] = [];
		let pendingClaim: Record<string, unknown> = {
			sessions: [],
			previews: [],
			merges: [],
			publishes: [],
			automations: [],
		};

		const control = {
			async call(method: SurfaceCodeHostRpc, args: Record<string, unknown>): Promise<unknown> {
				rpcCalls.push({ method, args });
				if (method === "qorpera_surface_claim_pending_jobs_for_lane") {
					const res = pendingClaim;
					pendingClaim = { sessions: [], previews: [], merges: [], publishes: [], automations: [] };
					return res;
				}
				if (method === "qorpera_surface_complete_merge") {
					return { jobId: args.p_job_id, status: args.p_status };
				}
				if (method === "qorpera_surface_renew_lease") {
					return { renewed: true };
				}
				if (method === "qorpera_surface_shared_product_folder_roots") {
					return [];
				}
				throw new Error(`Unexpected RPC ${method}`);
			},
		};

		let failViewPublish = false;
		const hosts = {
			async run<T>(
				_companyId: string,
				_envId: string,
				_signal: AbortSignal,
				fn: (job: CodeHostJob, gc: never) => Promise<T>,
			): Promise<T> {
				const result = await fn(f.job, undefined as never);
				if (failViewPublish) throw new Error("view publication rejected");
				return result;
			},
		};

		const worker = new SurfaceCodeHostWorker({ control, hosts, readTree: readCodeSiteTree });

		const failedMergeJobId = randomUUID();
		const failedMergeLease = randomUUID();
		failViewPublish = true;
		pendingClaim = {
			sessions: [],
			previews: [],
			merges: [
				{
					jobId: failedMergeJobId,
					kind: "land_change",
					surfaceId,
					sessionId,
					profileId,
					environmentId,
					leaseToken: failedMergeLease,
					sourceKind: "code_repo",
					repositoryKey: "thetaband/website",
					folderRoot: null,
					expectMainSha: f.baseSha,
					sessionWorkerId: workerId,
					sessionState: "ready",
					sessionHasActiveChat: false,
					payload: { changeIds: [changeA] },
					allSessionChangeStatuses: [{ changeId: changeA, status: "merging" }],
					approvedChanges: [
						{
							changeId: changeA,
							kind: "git_range",
							parentSha: f.baseSha,
							headSha: shaA,
							title: "Reversible update",
							summary: "Updates heading",
							patchManifest: null,
							affectedPaths: ["index.html"],
						},
					],
					siblingRemainingChanges: [],
					peerSessions: [],
				},
			],
			publishes: [],
			automations: [],
		};

		const failedPass = await worker.pass(new AbortController().signal);
		expect(failedPass).toEqual({ previews: 0, merges: 0, publishes: 0, cleanups: 0, failed: 1 });
		const failedComplete = rpcCalls.find((c) => c.method === "qorpera_surface_complete_merge");
		expect(failedComplete?.args).toMatchObject({
			p_job_id: failedMergeJobId,
			p_status: "failed",
			p_lease_token: failedMergeLease,
		});
		expect(String(failedComplete?.args.p_error_detail ?? "")).toContain("view publication rejected");

		rpcCalls.length = 0;
		failViewPublish = false;
		const mainHeadAfterFailedPublish = await f.git(join(f.code, "repo.git"), "rev-parse", "refs/heads/main");
		const undoJobId = randomUUID();
		const undoLease = randomUUID();
		pendingClaim = {
			sessions: [],
			previews: [],
			merges: [
				{
					jobId: undoJobId,
					kind: "undo_change",
					surfaceId,
					sessionId,
					profileId,
					environmentId,
					leaseToken: undoLease,
					sourceKind: "code_repo",
					repositoryKey: "thetaband/website",
					folderRoot: null,
					expectMainSha: mainHeadAfterFailedPublish,
					sessionWorkerId: workerId,
					sessionState: "ready",
					sessionHasActiveChat: false,
					payload: {
						changeId: changeA,
						landedMainBefore: f.baseSha,
						landedMainAfter: mainHeadAfterFailedPublish,
					},
					allSessionChangeStatuses: [{ changeId: changeA, status: "merged" }],
					approvedChanges: [],
					siblingRemainingChanges: [],
					peerSessions: [],
				},
			],
			publishes: [],
			automations: [],
		};

		const undoPass = await worker.pass(new AbortController().signal);
		expect(undoPass).toEqual({ previews: 0, merges: 1, publishes: 0, cleanups: 0, failed: 0 });
		const undoComplete = rpcCalls.find((c) => c.method === "qorpera_surface_complete_merge");
		expect(undoComplete?.args).toMatchObject({
			p_job_id: undoJobId,
			p_status: "landed",
			p_main_before: mainHeadAfterFailedPublish,
			p_lease_token: undoLease,
		});
		const revertedHtml = await f.git(
			join(f.code, "repo.git"),
			"show",
			`${String(undoComplete?.args.p_main_after)}:index.html`,
		);
		expect(revertedHtml).toContain("Original");
	});

	it("retries completeSurfaceMerge after view publication before persisting rebases best-effort", async () => {
		const f = await createCodeHostFixture();
		const profileId = randomUUID();
		const environmentId = randomUUID();
		const surfaceId = randomUUID();
		const sessionId = randomUUID();
		const workerId = randomUUID();
		const changeA = randomUUID();
		const changeB = randomUUID();

		await addCodeWorktree(f.job, { repository: f.repository, workerId, baseSha: f.baseSha });
		const sessionWorktree = join(f.code, "worktrees", workerId);
		await writeFile(join(sessionWorktree, "index.html"), "<!doctype html><h1>Landed V2</h1>\n");
		await f.git(sessionWorktree, "add", "index.html");
		await f.git(sessionWorktree, "commit", "-m", "Update hero v2");
		const shaA = await f.git(sessionWorktree, "rev-parse", "HEAD");

		await writeFile(join(sessionWorktree, "about.html"), "<!doctype html><p>About</p>\n");
		await f.git(sessionWorktree, "add", "about.html");
		await f.git(sessionWorktree, "commit", "-m", "Add about");
		const shaB = await f.git(sessionWorktree, "rev-parse", "HEAD");

		const callOrder: string[] = [];
		let completeAttempts = 0;
		const mergeJobId = randomUUID();
		const mergeLease = randomUUID();
		let pendingClaim: Record<string, unknown> = {
			sessions: [],
			previews: [],
			merges: [
				{
					jobId: mergeJobId,
					kind: "land_change",
					surfaceId,
					sessionId,
					profileId,
					environmentId,
					leaseToken: mergeLease,
					sourceKind: "code_repo",
					repositoryKey: "thetaband/website",
					folderRoot: null,
					expectMainSha: f.baseSha,
					sessionWorkerId: workerId,
					sessionState: "ready",
					sessionHasActiveChat: false,
					payload: { changeIds: [changeA] },
					allSessionChangeStatuses: [
						{ changeId: changeA, status: "merging" },
						{ changeId: changeB, status: "staged" },
					],
					approvedChanges: [
						{
							changeId: changeA,
							kind: "git_range",
							parentSha: f.baseSha,
							headSha: shaA,
							title: "Update hero v2",
							summary: "Updates hero heading",
							patchManifest: null,
							affectedPaths: ["index.html"],
						},
					],
					siblingRemainingChanges: [{ changeId: changeB, parentSha: shaA, headSha: shaB, title: "Add about" }],
					peerSessions: [],
				},
			],
			publishes: [],
			automations: [],
		};

		const reported: Record<string, unknown>[] = [];
		const control = {
			async call(method: SurfaceCodeHostRpc, args: Record<string, unknown>): Promise<unknown> {
				if (method === "qorpera_surface_claim_pending_jobs_for_lane") {
					const res = pendingClaim;
					pendingClaim = { sessions: [], previews: [], merges: [], publishes: [], automations: [] };
					return res;
				}
				if (method === "qorpera_surface_complete_merge") {
					completeAttempts += 1;
					callOrder.push(`complete:${completeAttempts}:${String(args.p_status)}`);
					if (completeAttempts === 1) {
						throw new Error("transient HTTP 503");
					}
					return { jobId: args.p_job_id, status: args.p_status };
				}
				if (method === "qorpera_surface_update_rebased_changes") {
					callOrder.push("rebase");
					throw new Error("transient rebase RPC failure");
				}
				if (method === "qorpera_surface_renew_lease") {
					return { renewed: true };
				}
				if (method === "qorpera_surface_shared_product_folder_roots") {
					return [];
				}
				throw new Error(`Unexpected RPC ${method}`);
			},
		};

		const hosts = {
			async run<T>(
				_companyId: string,
				_envId: string,
				_signal: AbortSignal,
				fn: (job: CodeHostJob, gc: never) => Promise<T>,
			): Promise<T> {
				const result = await fn(f.job, undefined as never);
				callOrder.push("published");
				return result;
			},
		};

		const worker = new SurfaceCodeHostWorker({
			control,
			hosts,
			readTree: readCodeSiteTree,
			completionRetryDelaysMs: [5, 5],
			report: (ev) => reported.push(ev),
		});

		const pass = await worker.pass(new AbortController().signal);
		expect(pass).toEqual({ previews: 0, merges: 1, publishes: 0, cleanups: 0, failed: 0 });
		expect(callOrder).toEqual(["published", "complete:1:landed", "complete:2:landed", "rebase", "rebase", "rebase"]);
		expect(reported.some((ev) => ev.event === "surface-code-host-rebase-persist-failed")).toBe(true);
	});

	it("treats 55000 not-running on completion retry as landed and still persists rebases if completion fails", async () => {
		const f = await createCodeHostFixture();
		const profileId = randomUUID();
		const environmentId = randomUUID();
		const surfaceId = randomUUID();
		const sessionId = randomUUID();
		const workerId = randomUUID();
		const changeA = randomUUID();
		const changeB = randomUUID();
		const changeC = randomUUID();

		await addCodeWorktree(f.job, { repository: f.repository, workerId, baseSha: f.baseSha });
		const sessionWorktree = join(f.code, "worktrees", workerId);
		await writeFile(join(sessionWorktree, "index.html"), "<!doctype html><h1>Landed V3</h1>\n");
		await f.git(sessionWorktree, "add", "index.html");
		await f.git(sessionWorktree, "commit", "-m", "Update hero v3");
		const shaA = await f.git(sessionWorktree, "rev-parse", "HEAD");

		await writeFile(join(sessionWorktree, "faq.html"), "<!doctype html><p>FAQ</p>\n");
		await f.git(sessionWorktree, "add", "faq.html");
		await f.git(sessionWorktree, "commit", "-m", "Add faq");
		const shaB = await f.git(sessionWorktree, "rev-parse", "HEAD");

		const callOrder: string[] = [];
		let mode: "not_running_retry" | "permanent_failure" = "not_running_retry";
		let completeAttempts = 0;
		let rebaseAttempts = 0;
		let pendingClaim: Record<string, unknown> = {
			sessions: [],
			previews: [],
			merges: [],
			publishes: [],
			automations: [],
		};

		const control = {
			async call(method: SurfaceCodeHostRpc, args: Record<string, unknown>): Promise<unknown> {
				if (method === "qorpera_surface_claim_pending_jobs_for_lane") {
					const res = pendingClaim;
					pendingClaim = { sessions: [], previews: [], merges: [], publishes: [], automations: [] };
					return res;
				}
				if (method === "qorpera_surface_complete_merge") {
					completeAttempts += 1;
					callOrder.push(`complete:${completeAttempts}`);
					if (mode === "not_running_retry") {
						if (completeAttempts === 1) throw new Error("attempt 1 timed out after commit");
						throw new Error("CODING_CONTROL_UNCONFIRMED", {
							cause: new Error("qorpera_surface_complete_merge: HTTP 500 55000 Surface job is not running"),
						});
					}
					throw new Error("persistent HTTP 503");
				}
				if (method === "qorpera_surface_update_rebased_changes") {
					rebaseAttempts += 1;
					callOrder.push(`rebase:${rebaseAttempts}`);
					if (mode === "permanent_failure" && rebaseAttempts === 1) {
						throw new Error("transient rebase error");
					}
					return { updated: 1, sessionId: args.p_session_id };
				}
				if (method === "qorpera_surface_renew_lease") {
					return { renewed: true };
				}
				if (method === "qorpera_surface_shared_product_folder_roots") {
					return [];
				}
				throw new Error(`Unexpected RPC ${method}`);
			},
		};

		const hosts = {
			async run<T>(
				_companyId: string,
				_envId: string,
				_signal: AbortSignal,
				fn: (job: CodeHostJob, gc: never) => Promise<T>,
			): Promise<T> {
				const result = await fn(f.job, undefined as never);
				callOrder.push("published");
				return result;
			},
		};

		const worker = new SurfaceCodeHostWorker({
			control,
			hosts,
			readTree: readCodeSiteTree,
			completionRetryDelaysMs: [5, 5],
		});

		pendingClaim = {
			sessions: [],
			previews: [],
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
					repositoryKey: "thetaband/website",
					folderRoot: null,
					expectMainSha: f.baseSha,
					sessionWorkerId: workerId,
					sessionState: "ready",
					sessionHasActiveChat: false,
					payload: { changeIds: [changeA] },
					allSessionChangeStatuses: [
						{ changeId: changeA, status: "merging" },
						{ changeId: changeB, status: "staged" },
					],
					approvedChanges: [
						{
							changeId: changeA,
							kind: "git_range",
							parentSha: f.baseSha,
							headSha: shaA,
							title: "Update hero v3",
							summary: "Updates hero heading",
							patchManifest: null,
							affectedPaths: ["index.html"],
						},
					],
					siblingRemainingChanges: [{ changeId: changeB, parentSha: shaA, headSha: shaB, title: "Add faq" }],
					peerSessions: [],
				},
			],
			publishes: [],
			automations: [],
		};

		const firstPass = await worker.pass(new AbortController().signal);
		expect(firstPass).toEqual({ previews: 0, merges: 1, publishes: 0, cleanups: 0, failed: 0 });
		expect(callOrder).toEqual(["published", "complete:1", "complete:2", "rebase:1"]);

		callOrder.length = 0;
		completeAttempts = 0;
		rebaseAttempts = 0;
		mode = "permanent_failure";
		const mainAfterFirst = await f.git(join(f.code, "repo.git"), "rev-parse", "refs/heads/main");
		const rebasedWorktreeHead = await f.git(sessionWorktree, "rev-parse", "HEAD");
		const rebasedParent = await f.git(sessionWorktree, "rev-parse", "HEAD~1");
		await writeFile(join(sessionWorktree, "contact.html"), "<!doctype html><p>Contact v2</p>\n");
		await f.git(sessionWorktree, "add", "contact.html");
		await f.git(sessionWorktree, "commit", "-m", "Add contact v2");
		const shaC2 = await f.git(sessionWorktree, "rev-parse", "HEAD");

		pendingClaim = {
			sessions: [],
			previews: [],
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
					repositoryKey: "thetaband/website",
					folderRoot: null,
					expectMainSha: mainAfterFirst,
					sessionWorkerId: workerId,
					sessionState: "ready",
					sessionHasActiveChat: false,
					payload: { changeIds: [changeB] },
					allSessionChangeStatuses: [
						{ changeId: changeB, status: "merging" },
						{ changeId: changeC, status: "staged" },
					],
					approvedChanges: [
						{
							changeId: changeB,
							kind: "git_range",
							parentSha: rebasedParent,
							headSha: rebasedWorktreeHead,
							title: "Add faq",
							summary: "Adds faq page",
							patchManifest: null,
							affectedPaths: ["faq.html"],
						},
					],
					siblingRemainingChanges: [
						{ changeId: changeC, parentSha: rebasedWorktreeHead, headSha: shaC2, title: "Add contact" },
					],
					peerSessions: [],
				},
			],
			publishes: [],
			automations: [],
		};
		expect(shaC2).toMatch(/^[0-9a-f]{40}$/);

		const secondPass = await worker.pass(new AbortController().signal);
		expect(secondPass).toEqual({ previews: 0, merges: 0, publishes: 0, cleanups: 0, failed: 1 });
		expect(callOrder).toEqual(["published", "complete:1", "complete:2", "complete:3", "rebase:1", "rebase:2"]);
	});

	it("reads surface starter repositories with readSurfaceSiteTree, skipping dotfiles/README/node_modules and honoring site.folder", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "surface-site-tree-")));
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
		const repository = { host: "qorpera" as const, owner: "surfaces", name: "hjemmeside", baseBranch: "main" };
		const starter = await ensureSurfaceStarterRepository(job, { repository, title: "Hjemmeside" });

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
		const repo = join(companyRoot, "code/surfaces/hjemmeside/repo.git");
		const starterTreeSha = await git(repo, "rev-parse", `${starter.mainSha}^{tree}`);

		const starterTree = await readSurfaceSiteTree(job, { repository, tree: starterTreeSha });
		const starterPaths = starterTree.files.map((file) => file.path).sort();
		expect(starterPaths).toEqual(["index.html", "qorpera-identity.css", "styles.css"]);

		const mainWorktree = join(companyRoot, "code/surfaces/hjemmeside/main");
		await mkdir(join(mainWorktree, "dist"), { recursive: true });
		await mkdir(join(mainWorktree, "node_modules/pkg"), { recursive: true });
		await writeFile(join(mainWorktree, "dist/index.html"), "<!doctype html><h1>Built</h1>\n");
		await writeFile(join(mainWorktree, "dist/app.js"), "console.log('ok');\n");
		await writeFile(join(mainWorktree, "node_modules/pkg/index.js"), "module.exports = {};\n");
		await writeFile(
			join(mainWorktree, ".qorpera/checks.json"),
			JSON.stringify({ checks: [], site: { folder: "dist" } }),
		);
		await git(mainWorktree, "add", "dist", "node_modules", ".qorpera/checks.json");
		await git(mainWorktree, "commit", "-m", "Add dist site folder");
		const builtSha = await git(mainWorktree, "rev-parse", "HEAD");
		const builtTreeSha = await git(repo, "rev-parse", `${builtSha}^{tree}`);

		const builtTree = await readSurfaceSiteTree(job, { repository, tree: builtTreeSha });
		expect(builtTree.files.map((file) => file.path).sort()).toEqual(["app.js", "index.html"]);
		const builtIndex = builtTree.files.find((file) => file.path === "index.html");
		expect(builtIndex ? Buffer.from(builtIndex.content).toString("utf8") : "").toContain("Built");
	});
});

type RpcCall = { method: SurfaceCodeHostRpc; args: Record<string, unknown> };

function buildHarness(f: Awaited<ReturnType<typeof createCodeHostFixture>>, buildAnswers: Record<string, unknown>[]) {
	const calls: RpcCall[] = [];
	const uploads = new Map<string, Map<string, Buffer>>();
	let pendingClaim: Record<string, unknown> = {
		sessions: [],
		previews: [],
		merges: [],
		publishes: [],
		automations: [],
	};
	const control = {
		async call(method: SurfaceCodeHostRpc, args: Record<string, unknown>): Promise<unknown> {
			expect(SURFACE_CODE_HOST_RPCS).toContain(method);
			calls.push({ method, args });
			switch (method) {
				case "qorpera_surface_claim_pending_jobs_for_lane": {
					const res = pendingClaim;
					pendingClaim = { sessions: [], previews: [], merges: [], publishes: [], automations: [] };
					return res;
				}
				case "qorpera_surface_request_build": {
					const answer = buildAnswers.shift();
					if (!answer) throw new Error("No build answer left");
					return answer;
				}
				case "qorpera_surface_site_version_begin": {
					const versionId = randomUUID();
					uploads.set(versionId, new Map());
					return { state: "uploading", versionId, siteId: randomUUID(), siteSlug: "shop", listed: false };
				}
				case "qorpera_surface_site_version_list":
					return { state: "listed", missing: 0 };
				case "qorpera_surface_site_version_put": {
					const store = uploads.get(String(args.p_version_id))!;
					for (const part of (args.p_parts as { parts: { path: string; contentBase64: string }[] }).parts) {
						store.set(
							part.path,
							Buffer.concat([
								store.get(part.path) ?? Buffer.alloc(0),
								Buffer.from(part.contentBase64, "base64"),
							]),
						);
					}
					return { state: "kept" };
				}
				case "qorpera_surface_site_version_finish":
					return { state: args.p_promote_live === true ? "live" : "ready" };
				case "qorpera_surface_complete_preview":
				case "qorpera_surface_complete_publish":
				case "qorpera_surface_complete_cleanup":
					return {};
				case "qorpera_surface_renew_lease":
					return { renewed: true };
				case "qorpera_surface_shared_product_folder_roots":
					return [];
				default:
					throw new Error(`Unexpected RPC ${method}`);
			}
		},
	};
	const hosts = {
		async run<T>(
			_c: string,
			_e: string,
			_s: AbortSignal,
			fn: (job: CodeHostJob, gc: never) => Promise<T>,
		): Promise<T> {
			return await fn(f.job, undefined as never);
		},
	};
	return {
		calls,
		uploads,
		worker: new SurfaceCodeHostWorker({ control, hosts }),
		claim(value: Record<string, unknown>) {
			pendingClaim = { sessions: [], previews: [], merges: [], publishes: [], automations: [], ...value };
		},
	};
}

async function commitFiles(
	f: Awaited<ReturnType<typeof createCodeHostFixture>>,
	files: Record<string, string>,
	message: string,
): Promise<{ commit: string; tree: string }> {
	const mainWorktree = join(f.code, "main");
	for (const [path, text] of Object.entries(files)) {
		await mkdir(join(mainWorktree, path, ".."), { recursive: true });
		await writeFile(join(mainWorktree, path), text);
		await f.git(mainWorktree, "add", path);
	}
	await f.git(mainWorktree, "commit", "-m", message);
	const commit = await f.git(mainWorktree, "rev-parse", "HEAD");
	await f.git(join(f.code, "repo.git"), "update-ref", "refs/heads/main", commit);
	return { commit, tree: await f.git(join(f.code, "repo.git"), "rev-parse", `${commit}^{tree}`) };
}

const RECIPE_CHECKS = JSON.stringify({
	checks: [{ name: "build", run: "npm run build" }],
	preview: { run: "npm ci && npm run build", folder: "dist", timeoutSeconds: 120 },
});

function previewClaim(baseSha: string, previewId: string, lease: string) {
	return {
		previews: [
			{
				previewId,
				surfaceId: randomUUID(),
				profileId: randomUUID(),
				environmentId: randomUUID(),
				shortHostId: "ab12cd34",
				baseSha,
				selectedChangeIds: [],
				repositoryKey: "thetaband/website",
				leaseToken: lease,
				changes: [],
			},
		],
	};
}

describe("SurfaceCodeHostWorker previews built by the platform", () => {
	it("keeps a repository without a real recipe on the static path and asks for no build", async () => {
		const f = await createCodeHostFixture();
		const committed = await commitFiles(
			f,
			{
				".qorpera/checks.json": JSON.stringify({ checks: [], preview: { run: "true", folder: "." } }),
				"package.json": "{}\n",
			},
			"Starter recipe",
		);
		const h = buildHarness(f, []);
		h.claim(previewClaim(committed.commit, randomUUID(), randomUUID()));
		expect(await h.worker.pass(new AbortController().signal)).toEqual({
			previews: 1,
			merges: 0,
			publishes: 0,
			cleanups: 0,
			failed: 0,
		});
		expect(h.calls.some((c) => c.method === "qorpera_surface_request_build")).toBe(false);
		const done = h.calls.find((c) => c.method === "qorpera_surface_complete_preview");
		expect(done?.args).toMatchObject({ p_status: "ready", p_composite_tree_sha: committed.tree });
		const [files] = [...h.uploads.values()];
		expect(files?.get("index.html")?.toString("utf8")).toContain("Original");

		const e = await createCodeHostFixture();
		const noPackage = await commitFiles(e, { ".qorpera/checks.json": RECIPE_CHECKS }, "Recipe without package.json");
		const g = buildHarness(e, []);
		g.claim(previewClaim(noPackage.commit, randomUUID(), randomUUID()));
		await g.worker.pass(new AbortController().signal);
		expect(g.calls.some((c) => c.method === "qorpera_surface_request_build")).toBe(false);
		expect(g.calls.find((c) => c.method === "qorpera_surface_complete_preview")?.args.p_status).toBe("ready");
	});

	it("parks a preview on its build, then serves the build's output, asking again for a built tree that is gone", async () => {
		const f = await createCodeHostFixture();
		const output = await commitFiles(
			f,
			{ "dist/index.html": "<!doctype html><h1>Built</h1>\n", "dist/assets/app-Ab12_x.js": "console.log(1);\n" },
			"Output",
		);
		const builtTree = await f.git(join(f.code, "repo.git"), "rev-parse", `${output.commit}:dist`);
		const source = await commitFiles(
			f,
			{ ".qorpera/checks.json": RECIPE_CHECKS, "package.json": "{}\n", "src/main.tsx": "export {};\n" },
			"Source",
		);
		const buildId = randomUUID();
		const previewId = randomUUID();
		const lease = randomUUID();
		const h = buildHarness(f, [
			{ state: "waiting", buildId },
			{ state: "built", buildId, builtTreeSha: "f".repeat(40) },
			{ state: "built", buildId, builtTreeSha: builtTree },
		]);
		h.claim(previewClaim(source.commit, previewId, lease));
		expect(await h.worker.pass(new AbortController().signal)).toEqual({
			previews: 1,
			merges: 0,
			publishes: 0,
			cleanups: 0,
			failed: 0,
		});
		const asked = h.calls.filter((c) => c.method === "qorpera_surface_request_build");
		expect(asked).toHaveLength(1);
		expect(asked[0]?.args).toMatchObject({
			p_kind: "preview",
			p_id: previewId,
			p_lease_token: lease,
			p_tree_sha: source.tree,
			p_recipe: { run: "npm ci && npm run build", cwd: ".", folder: "dist", timeoutSeconds: 120 },
			p_stale_built_tree: null,
		});
		expect(h.calls.some((c) => c.method === "qorpera_surface_complete_preview")).toBe(false);

		h.claim(previewClaim(source.commit, previewId, lease));
		await h.worker.pass(new AbortController().signal);
		const again = h.calls.filter((c) => c.method === "qorpera_surface_request_build");
		expect(again.map((c) => c.args.p_stale_built_tree)).toEqual([null, null, "f".repeat(40)]);
		const done = h.calls.find((c) => c.method === "qorpera_surface_complete_preview");
		expect(done?.args).toMatchObject({ p_status: "ready", p_composite_tree_sha: source.tree, p_lease_token: lease });
		const begin = h.calls.find((c) => c.method === "qorpera_surface_site_version_begin");
		expect(begin?.args.p_main_sha).toBe(source.commit);
		const [files] = [...h.uploads.values()];
		expect(
			[...(files?.keys() ?? [])]
				.filter((path) => !path.startsWith("public/") && !path.startsWith("qorpera-"))
				.sort(),
		).toEqual(["assets/app-Ab12_x.js", "index.html"]);
		expect(files?.get("index.html")?.toString("utf8")).toContain("Built");
	});

	it("leaves a preview the build request already failed (a company out of computer hours) without completing it again", async () => {
		const f = await createCodeHostFixture();
		const source = await commitFiles(f, { ".qorpera/checks.json": RECIPE_CHECKS, "package.json": "{}\n" }, "Source");
		const h = buildHarness(f, [
			{
				state: "failed",
				buildId: null,
				errorDetail: "PREVIEW_BUILD_NO_HOURS\nThe company has no computer hours left.",
			},
		]);
		h.claim(previewClaim(source.commit, randomUUID(), randomUUID()));
		expect(await h.worker.pass(new AbortController().signal)).toEqual({
			previews: 1,
			merges: 0,
			publishes: 0,
			cleanups: 0,
			failed: 0,
		});
		expect(h.calls.some((c) => c.method === "qorpera_surface_complete_preview")).toBe(false);
		expect(h.calls.some((c) => c.method === "qorpera_surface_site_version_begin")).toBe(false);
	});

	it("publishes main's built tree from the same plan and fails a checks file that declares a build but is not valid", async () => {
		const f = await createCodeHostFixture();
		const output = await commitFiles(f, { "dist/index.html": "<!doctype html><h1>Live</h1>\n" }, "Output");
		const builtTree = await f.git(join(f.code, "repo.git"), "rev-parse", `${output.commit}:dist`);
		const source = await commitFiles(f, { ".qorpera/checks.json": RECIPE_CHECKS, "package.json": "{}\n" }, "Source");
		const jobId = randomUUID();
		const lease = randomUUID();
		const h = buildHarness(f, [{ state: "built", buildId: randomUUID(), builtTreeSha: builtTree }]);
		h.claim({
			publishes: [
				{
					jobId,
					surfaceId: randomUUID(),
					profileId: randomUUID(),
					environmentId: randomUUID(),
					sourceKind: "code_repo",
					liveHeadSha: source.commit,
					leaseToken: lease,
					repositoryKey: "thetaband/website",
					siteId: randomUUID(),
					payload: {},
				},
			],
		});
		expect(await h.worker.pass(new AbortController().signal)).toEqual({
			previews: 0,
			merges: 0,
			publishes: 1,
			cleanups: 0,
			failed: 0,
		});
		expect(h.calls.find((c) => c.method === "qorpera_surface_request_build")?.args).toMatchObject({
			p_kind: "publish",
			p_id: jobId,
			p_commit_sha: source.commit,
			p_tree_sha: source.tree,
		});
		expect(h.calls.find((c) => c.method === "qorpera_surface_site_version_finish")?.args.p_promote_live).toBe(true);
		expect(h.calls.find((c) => c.method === "qorpera_surface_complete_publish")?.args).toMatchObject({
			p_status: "published",
			p_published_head_sha: source.commit,
		});
		const [files] = [...h.uploads.values()];
		expect(files?.get("index.html")?.toString("utf8")).toContain("Live");

		const broken = await commitFiles(
			f,
			{ ".qorpera/checks.json": JSON.stringify({ preview: { run: "vite build", folder: "../out" } }) },
			"Broken checks",
		);
		const g = buildHarness(f, []);
		g.claim(previewClaim(broken.commit, randomUUID(), randomUUID()));
		await g.worker.pass(new AbortController().signal);
		const failed = g.calls.find((c) => c.method === "qorpera_surface_complete_preview");
		expect(failed?.args.p_status).toBe("failed");
		expect(String(failed?.args.p_error_detail).split("\n")[0]).toBe("PREVIEW_BUILD_FAILED");
		expect(g.calls.some((c) => c.method === "qorpera_surface_request_build")).toBe(false);
	});

	it("skips duplicate compose on Pass 2 after a parked preview build and passes readOnly for read-only passes", async () => {
		const f = await createCodeHostFixture();
		const output = await commitFiles(f, { "dist/index.html": "<!doctype html><h1>Cached Plan</h1>\n" }, "Output");
		const builtTree = await f.git(join(f.code, "repo.git"), "rev-parse", `${output.commit}:dist`);
		const source = await commitFiles(
			f,
			{ ".qorpera/checks.json": RECIPE_CHECKS, "package.json": "{}\n", "src/main.tsx": "export {};\n" },
			"Source",
		);
		const buildId = randomUUID();
		const previewId = randomUUID();
		const lease = randomUUID();
		const buildAnswers: Record<string, unknown>[] = [
			{ state: "waiting", buildId },
			{ state: "built", buildId, builtTreeSha: builtTree },
			{ state: "built", buildId, builtTreeSha: builtTree },
		];
		const runOpts: { yields?: boolean; readOnly?: boolean }[] = [];
		const calls: { method: SurfaceCodeHostRpc; args: Record<string, unknown> }[] = [];
		let pendingClaim: Record<string, unknown> = {
			sessions: [],
			previews: [],
			merges: [],
			publishes: [],
			automations: [],
		};
		const worker = new SurfaceCodeHostWorker({
			control: {
				async call(method, args) {
					calls.push({ method, args });
					if (method === "qorpera_surface_claim_pending_jobs_for_lane") {
						const res = pendingClaim;
						pendingClaim = { sessions: [], previews: [], merges: [], publishes: [], automations: [] };
						return res;
					}
					if (method === "qorpera_surface_request_build") return buildAnswers.shift()!;
					if (method === "qorpera_surface_site_version_begin") {
						return {
							state: "uploading",
							versionId: randomUUID(),
							siteId: randomUUID(),
							siteSlug: "shop",
							listed: false,
						};
					}
					if (method === "qorpera_surface_site_version_list") return { state: "listed", missing: 0 };
					if (method === "qorpera_surface_site_version_put") return { state: "kept" };
					if (method === "qorpera_surface_site_version_finish") {
						return { state: args.p_promote_live === true ? "live" : "ready" };
					}
					if (method === "qorpera_surface_renew_lease") return { renewed: true };
					if (method === "qorpera_surface_shared_product_folder_roots") return [];
					return {};
				},
			},
			hosts: {
				async run(_c, _e, _s, fn, opts) {
					runOpts.push({ yields: opts?.yields, readOnly: opts?.readOnly });
					return await fn(f.job, undefined as never);
				},
			},
		});

		const preview = previewClaim(source.commit, previewId, lease);
		pendingClaim = { ...pendingClaim, ...preview };
		expect(await worker.pass(new AbortController().signal)).toEqual({
			previews: 1,
			merges: 0,
			publishes: 0,
			cleanups: 0,
			failed: 0,
		});
		expect(runOpts).toEqual([{ yields: true, readOnly: true }]);

		pendingClaim = { ...pendingClaim, ...preview };
		expect(await worker.pass(new AbortController().signal)).toEqual({
			previews: 1,
			merges: 0,
			publishes: 0,
			cleanups: 0,
			failed: 0,
		});
		// WHY: Pass 2 reuses the cached Pass 1 compose plan, so hosts.run only executes once to read the built tree.
		expect(runOpts).toEqual([
			{ yields: true, readOnly: true },
			{ yields: true, readOnly: true },
		]);

		runOpts.length = 0;
		pendingClaim = {
			sessions: [],
			previews: [],
			merges: [],
			automations: [],
			publishes: [
				{
					jobId: randomUUID(),
					surfaceId: randomUUID(),
					profileId: randomUUID(),
					environmentId: randomUUID(),
					sourceKind: "code_repo",
					liveHeadSha: source.commit,
					leaseToken: randomUUID(),
					repositoryKey: "thetaband/website",
					siteId: randomUUID(),
					payload: {},
				},
			],
		};
		expect(await worker.pass(new AbortController().signal)).toEqual({
			previews: 0,
			merges: 0,
			publishes: 1,
			cleanups: 0,
			failed: 0,
		});
		expect(runOpts).toEqual([
			{ yields: true, readOnly: true },
			{ yields: true, readOnly: true },
		]);
	});
});

describe("SurfaceCodeHostWorker discarded session worktree cleanup", () => {
	it("runs two yieldable code-host passes to remove a discarded session worktree, git admin folder, and branch", async () => {
		const f = await createCodeHostFixture();
		const discardedWorkerId = randomUUID();
		const peerWorkerId = randomUUID();
		await addCodeWorktree(f.job, { repository: f.repository, workerId: discardedWorkerId, baseSha: f.baseSha });
		await addCodeWorktree(f.job, { repository: f.repository, workerId: peerWorkerId, baseSha: f.baseSha });

		const discardedTree = join(f.code, "worktrees", discardedWorkerId);
		const discardedAdmin = join(f.code, "repo.git", "worktrees", discardedWorkerId);
		const peerTree = join(f.code, "worktrees", peerWorkerId);
		await writeFile(join(discardedTree, "draft.html"), "<h1>Discarded</h1>\n");
		await f.git(discardedTree, "add", "draft.html");
		await f.git(discardedTree, "commit", "-m", "Discarded draft");
		await writeFile(join(discardedTree, "dirty.txt"), "uncommitted\n");

		const hostRuns: { yields: boolean | undefined; treeExistedBefore: boolean }[] = [];
		const jobId = randomUUID();
		const sessionId = randomUUID();
		const leaseToken = randomUUID();
		const rpcCalls: RpcCall[] = [];
		let claimed = false;

		const worker = new SurfaceCodeHostWorker({
			control: {
				async call(method: SurfaceCodeHostRpc, args: Record<string, unknown>): Promise<unknown> {
					expect(SURFACE_CODE_HOST_RPCS).toContain(method);
					rpcCalls.push({ method, args });
					if (method === "qorpera_surface_claim_pending_jobs_for_lane") {
						if (claimed)
							return { sessions: [], previews: [], merges: [], publishes: [], cleanups: [], automations: [] };
						claimed = true;
						return {
							sessions: [],
							previews: [],
							merges: [],
							publishes: [],
							cleanups: [
								{
									jobId,
									surfaceId: randomUUID(),
									sessionId,
									profileId: randomUUID(),
									environmentId: randomUUID(),
									sourceKind: "code_repo",
									leaseToken,
									repositoryKey: "thetaband/website",
									workerId: discardedWorkerId,
								},
							],
							automations: [],
						};
					}
					if (method === "qorpera_surface_complete_cleanup") return { jobId, status: args.p_status };
					if (method === "qorpera_surface_renew_lease") return { renewed: true };
					throw new Error(`Unexpected RPC ${method}`);
				},
			},
			hosts: {
				async run(_c, _e, _s, fn, opts) {
					hostRuns.push({ yields: opts?.yields, treeExistedBefore: existsSync(discardedTree) });
					return await fn(f.job, undefined as never);
				},
			},
		});

		const pass = await worker.pass(new AbortController().signal);
		expect(pass).toEqual({ previews: 0, merges: 0, publishes: 0, cleanups: 1, failed: 0 });
		expect(hostRuns).toEqual([
			{ yields: true, treeExistedBefore: true },
			{ yields: true, treeExistedBefore: false },
		]);
		expect(existsSync(discardedTree)).toBe(false);
		expect(existsSync(discardedAdmin)).toBe(false);
		expect(
			await f.git(join(f.code, "repo.git"), "for-each-ref", `refs/heads/qorpera/coding/${discardedWorkerId}`),
		).toBe("");
		expect(existsSync(peerTree)).toBe(true);
		expect(await f.git(join(f.code, "repo.git"), "rev-parse", `refs/heads/qorpera/coding/${peerWorkerId}`)).toBe(
			f.baseSha,
		);
		expect(rpcCalls.find((c) => c.method === "qorpera_surface_complete_cleanup")?.args).toEqual({
			p_job_id: jobId,
			p_status: "completed",
			p_error_detail: null,
			p_lease_token: leaseToken,
		});
	});

	it("leaves yielded cleanups uncompleted and reports failed on invalid cleanup metadata", async () => {
		const f = await createCodeHostFixture();
		const events: Record<string, unknown>[] = [];
		const yieldRpcCalls: RpcCall[] = [];
		let yieldClaimed = false;
		const yieldWorker = new SurfaceCodeHostWorker({
			yieldRetryDelaysMs: [1],
			report: (ev) => events.push(ev),
			control: {
				async call(method: SurfaceCodeHostRpc, args: Record<string, unknown>): Promise<unknown> {
					yieldRpcCalls.push({ method, args });
					if (method === "qorpera_surface_claim_pending_jobs_for_lane") {
						if (yieldClaimed) return { sessions: [], previews: [], merges: [], publishes: [], cleanups: [] };
						yieldClaimed = true;
						return {
							sessions: [],
							previews: [],
							merges: [],
							publishes: [],
							cleanups: [
								{
									jobId: randomUUID(),
									surfaceId: randomUUID(),
									sessionId: randomUUID(),
									profileId: randomUUID(),
									environmentId: randomUUID(),
									sourceKind: "code_repo",
									leaseToken: randomUUID(),
									repositoryKey: "thetaband/website",
									workerId: randomUUID(),
								},
							],
						};
					}
					return { renewed: true };
				},
			},
			hosts: {
				async run() {
					throw new CodeHostJobFailure("CODE_HOST_JOB_YIELDED", "busy");
				},
			},
		});
		expect(await yieldWorker.pass(new AbortController().signal)).toEqual({
			previews: 0,
			merges: 0,
			publishes: 0,
			cleanups: 0,
			failed: 0,
		});
		expect(yieldRpcCalls.some((c) => c.method === "qorpera_surface_complete_cleanup")).toBe(false);
		expect(events).toContainEqual(expect.objectContaining({ event: "surface-code-host-yielded", kind: "cleanup" }));

		const h = buildHarness(f, []);
		const badJobId = randomUUID();
		h.claim({
			cleanups: [
				{
					jobId: badJobId,
					surfaceId: randomUUID(),
					sessionId: randomUUID(),
					profileId: randomUUID(),
					environmentId: null,
					sourceKind: "code_repo",
					leaseToken: randomUUID(),
					repositoryKey: "thetaband/website",
					workerId: randomUUID(),
				},
			],
		});
		expect(await h.worker.pass(new AbortController().signal)).toEqual({
			previews: 0,
			merges: 0,
			publishes: 0,
			cleanups: 1,
			failed: 0,
		});
		expect(h.calls.find((c) => c.method === "qorpera_surface_complete_cleanup")?.args).toMatchObject({
			p_job_id: badJobId,
			p_status: "failed",
		});
	});

	it("decouples peer session rebases off Approve into yieldable background work", async () => {
		const f = await createCodeHostFixture();
		const profileId = randomUUID();
		const environmentId = randomUUID();
		const surfaceId = randomUUID();
		const sessionA = randomUUID();
		const sessionB = randomUUID();
		const workerA = randomUUID();
		const workerB = randomUUID();
		const changeA = randomUUID();
		const changeB = randomUUID();

		await addCodeWorktree(f.job, { repository: f.repository, workerId: workerA, baseSha: f.baseSha });
		await addCodeWorktree(f.job, { repository: f.repository, workerId: workerB, baseSha: f.baseSha });
		const wtA = join(f.code, "worktrees", workerA);
		const wtB = join(f.code, "worktrees", workerB);
		await writeFile(join(wtA, "hero.html"), "<h1>Hero</h1>\n");
		await f.git(wtA, "add", "hero.html");
		await f.git(wtA, "commit", "-m", "Add hero");
		const shaA = await f.git(wtA, "rev-parse", "HEAD");

		await writeFile(join(wtB, "footer.html"), "<footer>Footer</footer>\n");
		await f.git(wtB, "add", "footer.html");
		await f.git(wtB, "commit", "-m", "Add footer");
		const shaB = await f.git(wtB, "rev-parse", "HEAD");

		const timeline: string[] = [];
		const hostRuns: Array<{ yields?: boolean }> = [];
		const rpcCalls: { method: SurfaceCodeHostRpc; args: Record<string, unknown> }[] = [];
		let claimed = false;
		const worker = new SurfaceCodeHostWorker({
			control: {
				async call(method: SurfaceCodeHostRpc, args: Record<string, unknown>): Promise<unknown> {
					rpcCalls.push({ method, args });
					if (method === "qorpera_surface_claim_pending_jobs_for_lane") {
						if (claimed) return { sessions: [], previews: [], merges: [], publishes: [], cleanups: [] };
						claimed = true;
						return {
							sessions: [],
							previews: [],
							publishes: [],
							cleanups: [],
							merges: [
								{
									jobId: randomUUID(),
									kind: "land_change",
									surfaceId,
									sessionId: sessionA,
									profileId,
									environmentId,
									leaseToken: randomUUID(),
									sourceKind: "code_repo",
									repositoryKey: "thetaband/website",
									folderRoot: null,
									expectMainSha: f.baseSha,
									sessionWorkerId: workerA,
									sessionState: "ready",
									sessionHasActiveChat: false,
									payload: { changeIds: [changeA] },
									approvedChanges: [
										{
											changeId: changeA,
											kind: "git_range",
											parentSha: f.baseSha,
											headSha: shaA,
											title: "Add hero",
											summary: "",
											patchManifest: null,
											affectedPaths: ["hero.html"],
										},
									],
									siblingRemainingChanges: [],
									peerSessions: [
										{
											sessionId: sessionB,
											workerId: workerB,
											sessionState: "ready",
											sessionHasActiveChat: false,
											remainingChanges: [
												{ changeId: changeB, parentSha: f.baseSha, headSha: shaB, title: "Add footer" },
											],
										},
									],
								},
							],
						};
					}
					if (method === "qorpera_surface_complete_merge") {
						timeline.push("complete_merge");
						return { jobId: args.p_job_id, status: args.p_status };
					}
					if (method === "qorpera_surface_update_rebased_changes") {
						timeline.push(`rebased:${String(args.p_session_id)}`);
						return { updated: 1, sessionId: args.p_session_id };
					}
					return { renewed: true };
				},
			},
			hosts: {
				async run(_companyId, _envId, _signal, fn, options) {
					hostRuns.push({ yields: options?.yields });
					timeline.push(options?.yields ? "host:yieldable" : "host:urgent");
					return fn(f.job, undefined as never);
				},
			},
		});

		const pass = await worker.pass(new AbortController().signal);
		expect(pass).toEqual({ previews: 0, merges: 1, publishes: 0, cleanups: 0, failed: 0 });
		await worker.drainBackgroundPeerSyncs();

		expect(hostRuns).toEqual([{ yields: undefined }, { yields: true }]);
		expect(timeline.indexOf("complete_merge")).toBeGreaterThan(-1);
		expect(timeline.indexOf("host:yieldable")).toBeGreaterThan(timeline.indexOf("complete_merge"));
		expect(timeline.indexOf(`rebased:${sessionB}`)).toBeGreaterThan(timeline.indexOf("host:yieldable"));

		const peerUpdate = rpcCalls.find(
			(c) => c.method === "qorpera_surface_update_rebased_changes" && c.args.p_session_id === sessionB,
		);
		expect(peerUpdate).toBeTruthy();
		const landedMain = String(rpcCalls.find((c) => c.method === "qorpera_surface_complete_merge")?.args.p_main_after);
		expect(await f.git(join(f.code, "repo.git"), "--git-dir=.", "rev-parse", "refs/heads/main")).toBe(landedMain);
		const peerHead = await f.git(
			join(f.code, "repo.git"),
			"--git-dir=.",
			"rev-parse",
			`refs/heads/qorpera/coding/${workerB}`,
		);
		expect(peerHead).not.toBe(shaB);
	}, 20_000);

	it("prefers claimed liveHeadSha over a stale payload.liveHeadSha when publishing", async () => {
		const f = await createCodeHostFixture();
		const profileId = randomUUID();
		const environmentId = randomUUID();
		const surfaceId = randomUUID();
		const siteId = randomUUID();
		const workerId = randomUUID();

		await addCodeWorktree(f.job, { repository: f.repository, workerId, baseSha: f.baseSha });
		const wt = join(f.code, "worktrees", workerId);
		await writeFile(join(wt, "index.html"), "<!doctype html><h1>Fresh Main</h1>\n");
		await f.git(wt, "add", "index.html");
		await f.git(wt, "commit", "-m", "Fresh main commit");
		const freshSha = await f.git(wt, "rev-parse", "HEAD");
		await f.git(join(f.code, "repo.git"), "--git-dir=.", "update-ref", "refs/heads/main", freshSha);

		const publishJobId = randomUUID();
		const publishLease = randomUUID();
		const uploadedHtml: string[] = [];
		const rpcCalls: { method: SurfaceCodeHostRpc; args: Record<string, unknown> }[] = [];
		let claimedOnce = false;

		const worker = new SurfaceCodeHostWorker({
			control: {
				async call(method, args) {
					rpcCalls.push({ method, args });
					if (method === "qorpera_surface_claim_pending_jobs_for_lane") {
						if (claimedOnce) return { sessions: [], previews: [], merges: [], publishes: [], automations: [] };
						claimedOnce = true;
						return {
							sessions: [],
							previews: [],
							merges: [],
							publishes: [
								{
									jobId: publishJobId,
									surfaceId,
									profileId,
									environmentId,
									sourceKind: "code_repo",
									liveHeadSha: freshSha,
									leaseToken: publishLease,
									repositoryKey: "thetaband/website",
									siteId,
									payload: { liveHeadSha: f.baseSha, repositoryKey: "thetaband/website" },
								},
							],
							automations: [],
						};
					}
					if (method === "qorpera_surface_site_version_begin") {
						return { state: "uploading", versionId: randomUUID(), siteId, siteSlug: "thetaband", listed: false };
					}
					if (method === "qorpera_surface_site_version_put") {
						const parts = (args.p_parts as { parts: { path: string; contentBase64: string }[] }).parts;
						for (const part of parts) {
							if (part.path === "index.html") {
								uploadedHtml.push(Buffer.from(part.contentBase64, "base64").toString("utf8"));
							}
						}
						return { state: "ok" };
					}
					return { state: "ok" };
				},
			},
			hosts: {
				async run(_companyId, _envId, _signal, fn) {
					return fn(f.job, undefined as never);
				},
			},
		});

		const pass = await worker.pass(new AbortController().signal);
		expect(pass).toEqual({ previews: 0, merges: 0, publishes: 1, cleanups: 0, failed: 0 });
		expect(uploadedHtml.join("")).toContain("Fresh Main");
		const complete = rpcCalls.find((c) => c.method === "qorpera_surface_complete_publish");
		expect(complete?.args).toMatchObject({
			p_job_id: publishJobId,
			p_status: "published",
			p_published_head_sha: freshSha,
			p_lease_token: publishLease,
		});
	});

	it("scopes preview plans, site reads, and publishing to monorepo repositorySubpath and defaultBranch", async () => {
		const f = await createCodeHostFixture();
		const profileId = randomUUID();
		const environmentId = randomUUID();
		const surfaceId = randomUUID();
		const siteId = randomUUID();
		const workerId = randomUUID();

		await addCodeWorktree(f.job, { repository: f.repository, workerId, baseSha: f.baseSha });
		const wt = join(f.code, "worktrees", workerId);
		await mkdir(join(wt, "packages/web/dist"), { recursive: true });
		await mkdir(join(wt, "packages/web/.qorpera"), { recursive: true });
		await mkdir(join(wt, "packages/docs"), { recursive: true });
		await writeFile(join(wt, "index.html"), "<!doctype html><h1>Repo Root</h1>\n");
		await writeFile(join(wt, "packages/docs/index.html"), "<!doctype html><h1>Other Package</h1>\n");
		await writeFile(join(wt, "packages/web/package.json"), JSON.stringify({ name: "web-subapp" }));
		await writeFile(join(wt, "packages/web/dist/index.html"), "<!doctype html><h1>Web Subapp</h1>\n");
		await writeFile(join(wt, "packages/web/dist/app.js"), "console.log('subapp');\n");
		await writeFile(
			join(wt, "packages/web/.qorpera/checks.json"),
			JSON.stringify({
				checks: [{ name: "build", run: "npm run build" }],
				site: { folder: "dist" },
				preview: { run: "npm run build", cwd: ".", folder: "dist" },
			}),
		);
		await f.git(wt, "add", ".");
		await f.git(wt, "commit", "-m", "Add monorepo web subapp");
		const mainSha = await f.git(wt, "rev-parse", "HEAD");
		await f.git(join(f.code, "repo.git"), "--git-dir=.", "update-ref", "refs/heads/main", mainSha);
		const mainTreeSha = await f.git(join(f.code, "repo.git"), "--git-dir=.", "rev-parse", `${mainSha}^{tree}`);

		const plan = await readSurfacePreviewPlan(f.job, {
			repository: f.repository,
			tree: mainTreeSha,
			subpath: "packages/web",
		});
		expect(plan.kind).toBe("build");
		if (plan.kind === "build") {
			expect(plan.recipe.cwd).toBe("packages/web");
			expect(plan.recipe.folder).toBe("packages/web/dist");
		}

		const subTree = await readSurfaceSiteTree(f.job, {
			repository: f.repository,
			tree: mainTreeSha,
			subpath: "packages/web",
		});
		expect(subTree.files.map((file) => file.path).sort()).toEqual(["app.js", "index.html"]);
		expect(Buffer.from(subTree.files.find((file) => file.path === "index.html")!.content).toString("utf8")).toContain(
			"Web Subapp",
		);

		await writeFile(
			join(wt, "packages/web/.qorpera/checks.json"),
			JSON.stringify({ checks: [{ name: "lint", run: "true" }], site: { folder: "dist" } }),
		);
		await f.git(wt, "add", "packages/web/.qorpera/checks.json");
		await f.git(wt, "commit", "-m", "Static subapp output");
		const staticMainSha = await f.git(wt, "rev-parse", "HEAD");
		await f.git(join(f.code, "repo.git"), "--git-dir=.", "update-ref", "refs/heads/main", staticMainSha);

		const publishJobId = randomUUID();
		const publishLease = randomUUID();
		const uploadedPaths: string[] = [];
		const uploadedHtml: string[] = [];
		const rpcCalls: { method: SurfaceCodeHostRpc; args: Record<string, unknown> }[] = [];
		let claimedOnce = false;

		const worker = new SurfaceCodeHostWorker({
			control: {
				async call(method, args) {
					rpcCalls.push({ method, args });
					if (method === "qorpera_surface_claim_pending_jobs_for_lane") {
						if (claimedOnce) return { sessions: [], previews: [], merges: [], publishes: [], automations: [] };
						claimedOnce = true;
						return {
							sessions: [],
							previews: [],
							merges: [],
							publishes: [
								{
									jobId: publishJobId,
									surfaceId,
									profileId,
									environmentId,
									sourceKind: "code_repo",
									liveHeadSha: null,
									leaseToken: publishLease,
									repositoryKey: "thetaband/website",
									repositorySubpath: "packages/web",
									defaultBranch: "master",
									siteId,
									payload: { repositoryKey: "thetaband/website" },
								},
							],
							automations: [],
						};
					}
					if (method === "qorpera_surface_site_version_begin") {
						return { state: "uploading", versionId: randomUUID(), siteId, siteSlug: "thetaband", listed: false };
					}
					if (method === "qorpera_surface_site_version_put") {
						const parts = (args.p_parts as { parts: { path: string; contentBase64: string }[] }).parts;
						for (const part of parts) {
							uploadedPaths.push(part.path);
							if (part.path === "index.html") {
								uploadedHtml.push(Buffer.from(part.contentBase64, "base64").toString("utf8"));
							}
						}
						return { state: "ok" };
					}
					return { state: "ok" };
				},
			},
			hosts: {
				async run(_companyId, _envId, _signal, fn) {
					return fn(f.job, undefined as never);
				},
			},
		});

		const pass = await worker.pass(new AbortController().signal);
		expect(pass).toEqual({ previews: 0, merges: 0, publishes: 1, cleanups: 0, failed: 0 });
		expect(uploadedPaths.filter((p) => !p.includes("qorpera-")).sort()).toEqual(["app.js", "index.html"]);
		expect(uploadedHtml.join("")).toContain("Web Subapp");
		const complete = rpcCalls.find((c) => c.method === "qorpera_surface_complete_publish");
		expect(complete?.args).toMatchObject({
			p_job_id: publishJobId,
			p_status: "published",
			p_published_head_sha: staticMainSha,
			p_lease_token: publishLease,
		});
	});

	it("deploys server and hybrid surface previews and publishes via qorpera-app-host with zero-downtime ordering and stale preview cleanup", async () => {
		const f = await createCodeHostFixture();
		const workerId = randomUUID();
		await addCodeWorktree(f.job, { repository: f.repository, workerId, baseSha: f.baseSha });
		const src = join(f.code, "worktrees", workerId);
		await mkdir(join(src, ".qorpera"), { recursive: true });
		await writeFile(
			join(src, ".qorpera", "checks.json"),
			JSON.stringify({
				checks: [{ name: "test", run: "true" }],
				site: {
					kind: "server",
					folder: ".",
					port: 4000,
					healthPath: "/healthz",
					idleTimeoutSec: 300,
					memoryMb: 512,
					vcpuLimit: 1,
				},
			}),
		);
		await writeFile(join(src, "server.js"), "console.log('v1');\n");
		await f.git(src, "add", ".");
		await f.git(src, "commit", "-m", "server app");
		const serverMainSha = await f.git(src, "rev-parse", "HEAD");
		await f.git(join(f.code, "repo.git"), "--git-dir=.", "update-ref", "refs/heads/main", serverMainSha);

		const profileId = randomUUID();
		const environmentId = randomUUID();
		const surfaceId = randomUUID();
		const siteId = randomUUID();
		const previewId = randomUUID();
		const publishJobId = randomUUID();
		const previewLease = randomUUID();
		const publishLease = randomUUID();
		const previewDepId = randomUUID();
		const previewVerId = randomUUID();
		const liveDepId = randomUUID();
		const liveVerId = randomUUID();
		const staleDepId = randomUUID();
		const imageRef = `127.0.0.1:5000/qorpera-apps/thetaband-website@sha256:${"a".repeat(64)}`;

		const rpcCalls: { method: string; args: Record<string, unknown> }[] = [];
		const appHostCalls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
		let claimPass = 0;

		const worker = new SurfaceCodeHostWorker({
			staleSweepIntervalMs: 60_000,
			nativeEdge: {
				routerInternalUrl: "http://127.0.0.1:8094",
				controlToken: "edge-token",
				appHostInternalUrl: "http://127.0.0.1:8096",
				appHostControlToken: "app-token",
				buildAppImage: async () => ({ ociImageRef: imageRef, builtMs: 15 }),
				appHostFetchImpl: async (url, init) => {
					const parsedBody = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
					appHostCalls.push({ url, method: init.method, ...(parsedBody ? { body: parsedBody } : {}) });
					if (url.endsWith("/_internal/apps/deploy")) {
						const depId = String(parsedBody?.deployment_id ?? "");
						return {
							status: 200,
							body: JSON.stringify({
								upstream_addr: depId === previewDepId ? "127.0.0.1:42001" : "127.0.0.1:42002",
							}),
						};
					}
					if (url.endsWith("/stop")) {
						return { status: 200, body: JSON.stringify({ stopped: true }) };
					}
					return { status: 404, body: "{}" };
				},
			},
			control: {
				async call(method, args) {
					rpcCalls.push({ method, args });
					if (method === "qorpera_surface_claim_pending_jobs_for_lane") {
						claimPass += 1;
						if (claimPass === 1) {
							return {
								sessions: [],
								previews: [
									{
										previewId,
										surfaceId,
										profileId,
										environmentId,
										sourceKind: "code_repo",
										shortHostId: "ab12cd34",
										repositoryKey: "thetaband/website",
										baseSha: serverMainSha,
										selectedChangeIds: [],
										changes: [],
										leaseToken: previewLease,
									},
								],
								merges: [],
								publishes: [],
								cleanups: [],
								automations: [],
							};
						}
						if (claimPass === 2) {
							return {
								sessions: [],
								previews: [],
								merges: [],
								publishes: [
									{
										jobId: publishJobId,
										surfaceId,
										profileId,
										environmentId,
										sourceKind: "code_repo",
										liveHeadSha: serverMainSha,
										leaseToken: publishLease,
										repositoryKey: "thetaband/website",
										siteId,
										payload: { liveHeadSha: serverMainSha, repositoryKey: "thetaband/website" },
									},
								],
								cleanups: [],
								automations: [],
							};
						}
						return { sessions: [], previews: [], merges: [], publishes: [], cleanups: [], automations: [] };
					}
					if (method === "qorpera_surface_site_deployment_register") {
						const isPreview = typeof args.p_title === "string" && args.p_title.startsWith("Preview ");
						return {
							siteId,
							slug: "thetaband",
							versionId: isPreview ? previewVerId : liveVerId,
							deploymentId: isPreview ? previewDepId : liveDepId,
							versionNumber: isPreview ? 1 : 2,
							kind: args.p_kind ?? "static",
							state: args.p_promote_live === true ? "live" : "ready",
						};
					}
					if (method === "qorpera_surface_stale_app_deployments_due") {
						return [{ deploymentId: staleDepId, siteId, profileId, upstreamAddr: "127.0.0.1:41999" }];
					}
					if (method === "qorpera_surface_app_deployment_mark_stopped" && args.p_claim_only === true) {
						return { claimed: true, stopped: false, deploymentId: args.p_deployment_id };
					}
					return { ok: true };
				},
			},
			hosts: {
				async run(_companyId, _envId, _signal, fn) {
					return fn(f.job, undefined as never);
				},
			},
		});

		const pass1 = await worker.pass(new AbortController().signal);
		expect(pass1).toEqual({ previews: 1, merges: 0, publishes: 0, cleanups: 0, failed: 0 });

		const previewDeployCall = appHostCalls.find(
			(c) => c.url.endsWith("/_internal/apps/deploy") && c.body?.deployment_id === previewDepId,
		);
		expect(previewDeployCall?.body).toMatchObject({
			deployment_id: previewDepId,
			site_id: siteId,
			oci_image_ref: imageRef,
			health_path: "/healthz",
			is_preview: true,
		});
		expect(rpcCalls.find((c) => c.method === "qorpera_surface_site_deployment_set_upstream")?.args).toEqual({
			p_deployment_id: previewDepId,
			p_upstream_addr: "127.0.0.1:42001",
		});
		expect(rpcCalls.find((c) => c.method === "qorpera_surface_complete_preview")?.args).toMatchObject({
			p_preview_id: previewId,
			p_status: "ready",
			p_site_version_id: previewVerId,
		});

		const staleStopCall = appHostCalls.find((c) => c.url.endsWith(`/_internal/apps/${staleDepId}/stop`));
		expect(staleStopCall?.body).toEqual({ expected_upstream_addr: "127.0.0.1:41999" });
		const markStoppedCalls = rpcCalls.filter((c) => c.method === "qorpera_surface_app_deployment_mark_stopped");
		expect(markStoppedCalls.map((c) => c.args)).toEqual([
			{
				p_deployment_id: staleDepId,
				p_expected_upstream_addr: "127.0.0.1:41999",
				p_claim_only: true,
			},
			{
				p_deployment_id: staleDepId,
				p_expected_upstream_addr: "127.0.0.1:41999",
			},
		]);

		const pass2 = await worker.pass(new AbortController().signal);
		expect(pass2).toEqual({ previews: 0, merges: 0, publishes: 1, cleanups: 0, failed: 0 });

		const liveRegisters = rpcCalls.filter(
			(c) => c.method === "qorpera_surface_site_deployment_register" && c.args.p_title === null,
		);
		expect(liveRegisters).toHaveLength(2);
		expect(liveRegisters[0]?.args).toMatchObject({
			p_promote_live: false,
			p_upstream_addr: null,
			p_kind: "server",
			p_oci_image_ref: imageRef,
			p_app_port: 4000,
		});
		expect(liveRegisters[1]?.args).toMatchObject({
			p_promote_live: true,
			p_upstream_addr: "127.0.0.1:42002",
			p_kind: "server",
			p_oci_image_ref: imageRef,
		});
		const liveDeployCall = appHostCalls.find(
			(c) => c.url.endsWith("/_internal/apps/deploy") && c.body?.deployment_id === liveDepId,
		);
		expect(liveDeployCall?.body?.is_preview).toBeUndefined();
		expect(rpcCalls.find((c) => c.method === "qorpera_surface_complete_publish")?.args).toMatchObject({
			p_job_id: publishJobId,
			p_status: "published",
			p_published_head_sha: serverMainSha,
		});
		expect(rpcCalls.filter((c) => c.method === "qorpera_surface_stale_app_deployments_due")).toHaveLength(1);
	});

	it("defers static settle on hybrid preview Pass 1 and deploys built assets plus OCI container on Pass 2", async () => {
		const f = await createCodeHostFixture();
		const workerId = randomUUID();
		await addCodeWorktree(f.job, { repository: f.repository, workerId, baseSha: f.baseSha });
		const src = join(f.code, "worktrees", workerId);
		await mkdir(join(src, ".qorpera"), { recursive: true });
		await writeFile(join(src, "package.json"), JSON.stringify({ name: "hybrid-app" }));
		await writeFile(
			join(src, ".qorpera", "checks.json"),
			JSON.stringify({
				checks: [{ name: "test", run: "true" }],
				preview: { run: "npm run build", cwd: ".", folder: "dist", timeoutSeconds: 120 },
				site: {
					kind: "hybrid",
					folder: "dist",
					port: 3000,
					healthPath: "/api/health",
					spaFallback: "index.html",
				},
			}),
		);
		await f.git(src, "add", ".");
		await f.git(src, "commit", "-m", "hybrid app");
		const hybridMainSha = await f.git(src, "rev-parse", "HEAD");
		await f.git(join(f.code, "repo.git"), "--git-dir=.", "update-ref", "refs/heads/main", hybridMainSha);

		const profileId = randomUUID();
		const environmentId = randomUUID();
		const surfaceId = randomUUID();
		const siteId = randomUUID();
		const previewId = randomUUID();
		const buildId = randomUUID();
		const previewDepId = randomUUID();
		const previewVerId = randomUUID();
		const lease1 = randomUUID();
		const lease2 = randomUUID();
		const imageRef = `127.0.0.1:5000/qorpera-apps/thetaband-website@sha256:${"b".repeat(64)}`;
		const manifestSha = "c".repeat(64);
		const fileSha = "d".repeat(64);

		const rpcCalls: { method: string; args: Record<string, unknown> }[] = [];
		let passCount = 0;

		const worker = new SurfaceCodeHostWorker({
			nativeEdge: {
				routerInternalUrl: "http://127.0.0.1:8094",
				controlToken: "edge-token",
				appHostInternalUrl: "http://127.0.0.1:8096",
				appHostControlToken: "app-token",
				buildAppImage: async () => ({ ociImageRef: imageRef, builtMs: 10 }),
				fetchImpl: async (url) => {
					if (url.endsWith("/_internal/blobs/exists")) {
						return { status: 200, body: JSON.stringify({ missing: [] }) };
					}
					return { status: 200, body: "{}" };
				},
				appHostFetchImpl: async () => ({
					status: 200,
					body: JSON.stringify({ upstream_addr: "127.0.0.1:43001" }),
				}),
			},
			control: {
				async call(method, args) {
					rpcCalls.push({ method, args });
					if (method === "qorpera_surface_claim_pending_jobs_for_lane") {
						passCount += 1;
						return {
							sessions: [],
							previews: [
								{
									previewId,
									surfaceId,
									profileId,
									environmentId,
									sourceKind: "code_repo",
									shortHostId: "hy123456",
									repositoryKey: "thetaband/website",
									baseSha: hybridMainSha,
									selectedChangeIds: [],
									changes: [],
									leaseToken: passCount === 1 ? lease1 : lease2,
								},
							],
							merges: [],
							publishes: [],
							cleanups: [],
							automations: [],
						};
					}
					if (method === "qorpera_surface_request_build") {
						if (passCount === 1) {
							return { state: "waiting", buildId };
						}
						return {
							state: "built",
							buildId,
							builtTreeSha: null,
							manifestSha256: manifestSha,
							manifestJson: {
								files: {
									"index.html": {
										sha256: fileSha,
										bytes: 32,
										content_type: "text/html; charset=utf-8",
										immutable: false,
									},
								},
								redirects: [],
								headers: [],
								spa_fallback: "index.html",
								not_found_page: null,
							},
							fileCount: 1,
							totalBytes: 32,
							hasCredentialInputs: false,
						};
					}
					if (method === "qorpera_surface_site_deployment_register") {
						return {
							siteId,
							slug: "thetaband",
							versionId: previewVerId,
							deploymentId: previewDepId,
							versionNumber: 1,
							kind: "hybrid",
							state: "ready",
						};
					}
					if (method === "qorpera_surface_stale_app_deployments_due") return [];
					return { ok: true };
				},
			},
			hosts: {
				async run(_companyId, _envId, _signal, fn) {
					return fn(f.job, undefined as never);
				},
			},
		});

		const p1 = await worker.pass(new AbortController().signal);
		expect(p1).toEqual({ previews: 1, merges: 0, publishes: 0, cleanups: 0, failed: 0 });
		expect(rpcCalls.find((c) => c.method === "qorpera_surface_request_build")?.args).toMatchObject({
			p_kind: "preview",
			p_id: previewId,
			p_defer_settle: true,
		});
		expect(rpcCalls.some((c) => c.method === "qorpera_surface_complete_preview")).toBe(false);

		const p2 = await worker.pass(new AbortController().signal);
		expect(p2).toEqual({ previews: 1, merges: 0, publishes: 0, cleanups: 0, failed: 0 });
		expect(rpcCalls.find((c) => c.method === "qorpera_surface_site_deployment_register")?.args).toMatchObject({
			p_kind: "hybrid",
			p_oci_image_ref: imageRef,
			p_file_count: 4,
			p_promote_live: false,
		});
		expect(rpcCalls.find((c) => c.method === "qorpera_surface_site_deployment_set_upstream")?.args).toEqual({
			p_deployment_id: previewDepId,
			p_upstream_addr: "127.0.0.1:43001",
		});
		expect(rpcCalls.find((c) => c.method === "qorpera_surface_complete_preview")?.args).toMatchObject({
			p_preview_id: previewId,
			p_status: "ready",
			p_site_version_id: previewVerId,
		});
	});

	it("pre-checks public promote refusals before touching app-host, rolls back containers on promote failure, and backs off failing stops", async () => {
		const f = await createCodeHostFixture();
		const workerId = randomUUID();
		await addCodeWorktree(f.job, { repository: f.repository, workerId, baseSha: f.baseSha });
		const src = join(f.code, "worktrees", workerId);
		await mkdir(join(src, ".qorpera"), { recursive: true });
		await writeFile(
			join(src, ".qorpera", "checks.json"),
			JSON.stringify({
				checks: [{ name: "test", run: "true" }],
				site: { kind: "server", port: 3000, healthPath: "/health" },
			}),
		);
		await writeFile(join(src, "server.js"), "console.log('app');\n");
		await f.git(src, "add", ".");
		await f.git(src, "commit", "-m", "server app");
		const serverMainSha = await f.git(src, "rev-parse", "HEAD");
		await f.git(join(f.code, "repo.git"), "--git-dir=.", "update-ref", "refs/heads/main", serverMainSha);

		const profileId = randomUUID();
		const environmentId = randomUUID();
		const surfaceId = randomUUID();
		const siteId = randomUUID();
		const jobId = randomUUID();
		const leaseToken = randomUUID();
		const depId = randomUUID();
		const verId = randomUUID();
		const staleDepId = randomUUID();
		const imageRef = `127.0.0.1:5000/qorpera-apps/demo@sha256:${"9".repeat(64)}`;
		const rpcCalls: Array<{ method: string; args: Record<string, unknown> }> = [];
		const appHostCalls: Array<{ url: string; body?: string }> = [];
		let registerCount = 0;

		const worker = new SurfaceCodeHostWorker({
			exportSource: async (_job, input) => ({ sourceDir: input.tree }),
			staleSweepIntervalMs: 0,
			nativeEdge: {
				routerInternalUrl: "http://127.0.0.1:8088",
				controlToken: "router-secret",
				appHostInternalUrl: "http://127.0.0.1:8089",
				appHostControlToken: "apphost-secret",
				buildAppImage: async () => ({ ociImageRef: imageRef, builtMs: 10 }),
				appHostFetchImpl: async (url, init) => {
					appHostCalls.push({ url, ...(init.body !== undefined ? { body: init.body } : {}) });
					if (url.endsWith("/_internal/apps/deploy")) {
						return { status: 200, body: JSON.stringify({ upstream_addr: "127.0.0.1:44001" }) };
					}
					if (url.includes(`/${staleDepId}/stop`)) {
						return { status: 500, body: "boom" };
					}
					return { status: 200, body: JSON.stringify({ stopped: true }) };
				},
			},
			control: {
				async call(method, args) {
					rpcCalls.push({ method, args });
					if (method === "qorpera_surface_claim_pending_jobs_for_lane") {
						return {
							sessions: [],
							previews: [],
							merges: [],
							publishes: [
								{
									jobId,
									surfaceId,
									profileId,
									environmentId,
									sourceKind: "code_repo",
									liveHeadSha: serverMainSha,
									repositoryKey: `${f.repository.owner}/${f.repository.name}`,
									siteId,
									siteSlug: "thetaband",
									leaseToken,
									payload: {
										liveHeadSha: serverMainSha,
										repositoryKey: `${f.repository.owner}/${f.repository.name}`,
									},
								},
							],
							cleanups: [],
							automations: [],
						};
					}
					if (method === "qorpera_surface_site_deployment_register") {
						registerCount += 1;
						if (registerCount === 2) {
							throw new Error("DB_PROMOTE_TIMEOUT");
						}
						return {
							siteId,
							slug: "thetaband",
							versionId: verId,
							deploymentId: depId,
							versionNumber: 1,
							kind: "server",
							state: "ready",
						};
					}
					if (method === "qorpera_surface_stale_app_deployments_due") {
						return [{ deploymentId: staleDepId, siteId, profileId, upstreamAddr: "127.0.0.1:44002" }];
					}
					if (method === "qorpera_surface_app_deployment_mark_stopped" && args.p_claim_only === true) {
						return { claimed: true, stopped: false, isLive: false, deploymentId: args.p_deployment_id };
					}
					return { ok: true };
				},
			},
			hosts: {
				async run(_companyId, _envId, _signal, fn) {
					return fn(f.job, undefined as never);
				},
			},
		});

		const result = await worker.pass(new AbortController().signal);
		expect(result).toEqual({ previews: 0, merges: 0, publishes: 1, cleanups: 0, failed: 0 });
		expect(rpcCalls.find((c) => c.method === "qorpera_surface_complete_publish")?.args).toMatchObject({
			p_job_id: jobId,
			p_status: "failed",
		});
		const firstRegister = rpcCalls.find((c) => c.method === "qorpera_surface_site_deployment_register");
		expect(firstRegister?.args).toMatchObject({ p_promote_live: false, p_check_public_promote: true });
		const rollbackStopCall = appHostCalls.find((c) => c.url.endsWith(`/_internal/apps/${depId}/stop`));
		expect(rollbackStopCall?.body).toBe(JSON.stringify({ expected_upstream_addr: "127.0.0.1:44001" }));
		expect(
			rpcCalls.some(
				(c) =>
					c.method === "qorpera_surface_app_deployment_mark_stopped" &&
					c.args.p_deployment_id === depId &&
					c.args.p_force === true &&
					c.args.p_claim_only === true,
			),
		).toBe(true);
		expect(
			rpcCalls.some(
				(c) =>
					c.method === "qorpera_surface_app_deployment_mark_stopped" &&
					c.args.p_deployment_id === depId &&
					c.args.p_force === true &&
					c.args.p_claim_only === undefined,
			),
		).toBe(true);
		expect(
			rpcCalls.some(
				(c) =>
					c.method === "qorpera_surface_app_deployment_mark_stopped" &&
					c.args.p_deployment_id === staleDepId &&
					c.args.p_expected_upstream_addr === "127.0.0.1:44002" &&
					c.args.p_stop_failed === true,
			),
		).toBe(true);
	});

	it("skips app-host stop when rollback finds deployment is already live or sweep sees claim refusal or 409 mismatch", async () => {
		const f = await createCodeHostFixture();
		const workerId = randomUUID();
		await addCodeWorktree(f.job, { repository: f.repository, workerId, baseSha: f.baseSha });
		const src = join(f.code, "worktrees", workerId);
		await mkdir(join(src, ".qorpera"), { recursive: true });
		await writeFile(
			join(src, ".qorpera", "checks.json"),
			JSON.stringify({
				checks: [{ name: "test", run: "true" }],
				site: { kind: "server", port: 3000, healthPath: "/health" },
			}),
		);
		await writeFile(join(src, "server.js"), "console.log('app');\n");
		await f.git(src, "add", ".");
		await f.git(src, "commit", "-m", "server app");
		const serverMainSha = await f.git(src, "rev-parse", "HEAD");
		await f.git(join(f.code, "repo.git"), "--git-dir=.", "update-ref", "refs/heads/main", serverMainSha);

		const profileId = randomUUID();
		const environmentId = randomUUID();
		const surfaceId = randomUUID();
		const siteId = randomUUID();
		const jobId = randomUUID();
		const leaseToken = randomUUID();
		const depId = randomUUID();
		const verId = randomUUID();
		const unclaimedDepId = randomUUID();
		const conflictDepId = randomUUID();
		const imageRef = `127.0.0.1:5000/qorpera-apps/demo@sha256:${"8".repeat(64)}`;
		const rpcCalls: Array<{ method: string; args: Record<string, unknown> }> = [];
		const appHostCalls: Array<{ url: string; body?: string }> = [];
		let registerCount = 0;
		let rollbackClaimAttempts = 0;

		const worker = new SurfaceCodeHostWorker({
			exportSource: async (_job, input) => ({ sourceDir: input.tree }),
			staleSweepIntervalMs: 0,
			nativeEdge: {
				routerInternalUrl: "http://127.0.0.1:8088",
				controlToken: "router-secret",
				appHostInternalUrl: "http://127.0.0.1:8089",
				appHostControlToken: "apphost-secret",
				buildAppImage: async () => ({ ociImageRef: imageRef, builtMs: 10 }),
				appHostFetchImpl: async (url, init) => {
					appHostCalls.push({ url, ...(init.body !== undefined ? { body: init.body } : {}) });
					if (url.endsWith("/_internal/apps/deploy")) {
						return { status: 200, body: JSON.stringify({ upstream_addr: "127.0.0.1:45001" }) };
					}
					if (url.includes(`/${conflictDepId}/stop`)) {
						return { status: 409, body: JSON.stringify({ stopped: false, error: "upstream_mismatch" }) };
					}
					return { status: 200, body: JSON.stringify({ stopped: true }) };
				},
			},
			control: {
				async call(method, args) {
					rpcCalls.push({ method, args });
					if (method === "qorpera_surface_claim_pending_jobs_for_lane") {
						return {
							sessions: [],
							previews: [],
							merges: [],
							publishes: [
								{
									jobId,
									surfaceId,
									profileId,
									environmentId,
									sourceKind: "code_repo",
									liveHeadSha: serverMainSha,
									repositoryKey: `${f.repository.owner}/${f.repository.name}`,
									siteId,
									siteSlug: "thetaband",
									leaseToken,
									payload: {
										liveHeadSha: serverMainSha,
										repositoryKey: `${f.repository.owner}/${f.repository.name}`,
									},
								},
							],
							cleanups: [],
							automations: [],
						};
					}
					if (method === "qorpera_surface_site_deployment_register") {
						registerCount += 1;
						if (registerCount === 2) {
							throw new Error("LOST_HTTP_RESPONSE");
						}
						return {
							siteId,
							slug: "thetaband",
							versionId: verId,
							deploymentId: depId,
							versionNumber: 1,
							kind: "server",
							state: "ready",
							deploymentState: "ready",
						};
					}
					if (method === "qorpera_surface_stale_app_deployments_due") {
						return [
							{ deploymentId: unclaimedDepId, siteId, profileId, upstreamAddr: "127.0.0.1:45002" },
							{ deploymentId: conflictDepId, siteId, profileId, upstreamAddr: "127.0.0.1:45003" },
						];
					}
					if (method === "qorpera_surface_app_deployment_mark_stopped" && args.p_claim_only === true) {
						if (args.p_deployment_id === depId) {
							rollbackClaimAttempts += 1;
							if (rollbackClaimAttempts === 1) {
								throw new Error("LOCK_TIMEOUT");
							}
							return { claimed: false, stopped: false, isLive: true, deploymentId: depId };
						}
						if (args.p_deployment_id === unclaimedDepId) {
							return { claimed: false, stopped: false, deploymentId: unclaimedDepId };
						}
						return { claimed: true, stopped: false, deploymentId: args.p_deployment_id };
					}
					return { ok: true };
				},
			},
			hosts: {
				async run(_companyId, _envId, _signal, fn) {
					return fn(f.job, undefined as never);
				},
			},
		});

		const result = await worker.pass(new AbortController().signal);
		expect(result).toEqual({ previews: 0, merges: 0, publishes: 1, cleanups: 0, failed: 0 });
		expect(rpcCalls.find((c) => c.method === "qorpera_surface_complete_publish")?.args).toMatchObject({
			p_job_id: jobId,
			p_status: "published",
		});
		expect(appHostCalls.some((c) => c.url.endsWith(`/_internal/apps/${depId}/stop`))).toBe(false);
		expect(appHostCalls.some((c) => c.url.endsWith(`/_internal/apps/${unclaimedDepId}/stop`))).toBe(false);
		expect(appHostCalls.some((c) => c.url.endsWith(`/_internal/apps/${conflictDepId}/stop`))).toBe(true);
		expect(
			rpcCalls.some(
				(c) =>
					c.method === "qorpera_surface_app_deployment_mark_stopped" &&
					c.args.p_deployment_id === conflictDepId &&
					c.args.p_claim_only === undefined,
			),
		).toBe(false);
	});

	it("yields publish instead of reporting failure when rollback live-check remains locked out", async () => {
		const f = await createCodeHostFixture();
		const workerId = randomUUID();
		await addCodeWorktree(f.job, { repository: f.repository, workerId, baseSha: f.baseSha });
		const src = join(f.code, "worktrees", workerId);
		await mkdir(join(src, ".qorpera"), { recursive: true });
		await writeFile(
			join(src, ".qorpera", "checks.json"),
			JSON.stringify({
				checks: [{ name: "test", run: "true" }],
				site: { kind: "server", port: 3000, healthPath: "/health" },
			}),
		);
		await writeFile(join(src, "server.js"), "console.log('app');\n");
		await f.git(src, "add", ".");
		await f.git(src, "commit", "-m", "server app");
		const serverMainSha = await f.git(src, "rev-parse", "HEAD");
		await f.git(join(f.code, "repo.git"), "--git-dir=.", "update-ref", "refs/heads/main", serverMainSha);

		const profileId = randomUUID();
		const environmentId = randomUUID();
		const surfaceId = randomUUID();
		const siteId = randomUUID();
		const jobId = randomUUID();
		const leaseToken = randomUUID();
		const depId = randomUUID();
		const verId = randomUUID();
		const imageRef = `127.0.0.1:5000/qorpera-apps/demo@sha256:${"7".repeat(64)}`;
		const rpcCalls: Array<{ method: string; args: Record<string, unknown> }> = [];
		const appHostCalls: Array<{ url: string; body?: string }> = [];
		const reportedEvents: Array<Record<string, unknown>> = [];
		let registerCount = 0;

		const worker = new SurfaceCodeHostWorker({
			exportSource: async (_job, input) => ({ sourceDir: input.tree }),
			staleSweepIntervalMs: 60_000,
			report: (ev) => reportedEvents.push(ev),
			nativeEdge: {
				routerInternalUrl: "http://127.0.0.1:8088",
				controlToken: "router-secret",
				appHostInternalUrl: "http://127.0.0.1:8089",
				appHostControlToken: "apphost-secret",
				buildAppImage: async () => ({ ociImageRef: imageRef, builtMs: 10 }),
				appHostFetchImpl: async (url, init) => {
					appHostCalls.push({ url, ...(init.body !== undefined ? { body: init.body } : {}) });
					if (url.endsWith("/_internal/apps/deploy")) {
						return { status: 200, body: JSON.stringify({ upstream_addr: "127.0.0.1:46001" }) };
					}
					return { status: 200, body: JSON.stringify({ stopped: true }) };
				},
			},
			control: {
				async call(method, args) {
					rpcCalls.push({ method, args });
					if (method === "qorpera_surface_claim_pending_jobs_for_lane") {
						return {
							sessions: [],
							previews: [],
							merges: [],
							publishes: [
								{
									jobId,
									surfaceId,
									profileId,
									environmentId,
									sourceKind: "code_repo",
									liveHeadSha: serverMainSha,
									repositoryKey: `${f.repository.owner}/${f.repository.name}`,
									siteId,
									siteSlug: "thetaband",
									leaseToken,
									payload: {
										liveHeadSha: serverMainSha,
										repositoryKey: `${f.repository.owner}/${f.repository.name}`,
									},
								},
							],
							cleanups: [],
							automations: [],
						};
					}
					if (method === "qorpera_surface_site_deployment_register") {
						registerCount += 1;
						if (registerCount === 2) {
							throw new Error("LOST_HTTP_RESPONSE");
						}
						return {
							siteId,
							slug: "thetaband",
							versionId: verId,
							deploymentId: depId,
							versionNumber: 1,
							kind: "server",
							state: "ready",
							deploymentState: "ready",
						};
					}
					if (method === "qorpera_surface_app_deployment_mark_stopped" && args.p_claim_only === true) {
						throw new Error("LOCK_TIMEOUT");
					}
					return { ok: true };
				},
			},
			hosts: {
				async run(_companyId, _envId, _signal, fn) {
					return fn(f.job, undefined as never);
				},
			},
		});

		const result = await worker.pass(new AbortController().signal);
		expect(result).toEqual({ previews: 0, merges: 0, publishes: 0, cleanups: 0, failed: 0 });
		expect(rpcCalls.some((c) => c.method === "qorpera_surface_complete_publish")).toBe(false);
		expect(appHostCalls.some((c) => c.url.endsWith(`/_internal/apps/${depId}/stop`))).toBe(false);
		expect(
			rpcCalls.filter(
				(c) =>
					c.method === "qorpera_surface_app_deployment_mark_stopped" &&
					c.args.p_deployment_id === depId &&
					c.args.p_claim_only === true,
			),
		).toHaveLength(3);
		expect(reportedEvents).toContainEqual({
			event: "surface-code-host-rollback-uncertain",
			kind: "publish",
			jobId,
			surfaceId,
			deploymentId: depId,
			upstreamAddr: "127.0.0.1:46001",
		});
	});

	it("exports only the monorepo subpath as the build context for subpath-configured server apps", async () => {
		const f = await createCodeHostFixture();
		const workerId = randomUUID();
		await addCodeWorktree(f.job, { repository: f.repository, workerId, baseSha: f.baseSha });
		const src = join(f.code, "worktrees", workerId);
		await mkdir(join(src, "apps/api/.qorpera"), { recursive: true });
		await writeFile(join(src, "Dockerfile"), "FROM scratch\n# root decoy\n");
		await writeFile(join(src, "root-only.txt"), "decoy\n");
		await writeFile(join(src, "apps/api/Dockerfile"), "FROM node:22-alpine\nCOPY server.js .\n");
		await writeFile(join(src, "apps/api/server.js"), "console.log('subpath-api');\n");
		await writeFile(
			join(src, "apps/api/.qorpera/checks.json"),
			JSON.stringify({
				checks: [{ name: "test", run: "true" }],
				site: { kind: "server", port: 4100, dockerfile: "Dockerfile", healthPath: "/health" },
			}),
		);
		await f.git(src, "add", ".");
		await f.git(src, "commit", "-m", "monorepo subpath server app");
		const serverMainSha = await f.git(src, "rev-parse", "HEAD");
		await f.git(join(f.code, "repo.git"), "--git-dir=.", "update-ref", "refs/heads/main", serverMainSha);

		const profileId = randomUUID();
		const environmentId = randomUUID();
		const surfaceId = randomUUID();
		const siteId = randomUUID();
		const jobId = randomUUID();
		const leaseToken = randomUUID();
		const depId = randomUUID();
		const verId = randomUUID();
		const imageRef = `127.0.0.1:5000/qorpera-apps/subpath-api@sha256:${"6".repeat(64)}`;
		let seenDockerfile: string | null = null;
		let seenEntries: string[] = [];
		let seenServerContent = "";

		const worker = new SurfaceCodeHostWorker({
			staleSweepIntervalMs: 60_000,
			nativeEdge: {
				routerInternalUrl: "http://127.0.0.1:8088",
				controlToken: "router-secret",
				appHostInternalUrl: "http://127.0.0.1:8089",
				appHostControlToken: "apphost-secret",
				buildAppImage: async (buildInput) => {
					seenDockerfile = buildInput.dockerfile;
					seenEntries = (await readdir(buildInput.sourceDir)).sort();
					seenServerContent = await readFile(join(buildInput.sourceDir, "server.js"), "utf8");
					return { ociImageRef: imageRef, builtMs: 12 };
				},
				appHostFetchImpl: async () => ({
					status: 200,
					body: JSON.stringify({ upstream_addr: "127.0.0.1:47001" }),
				}),
			},
			control: {
				async call(method, args) {
					if (method === "qorpera_surface_claim_pending_jobs_for_lane") {
						return {
							sessions: [],
							previews: [],
							merges: [],
							publishes: [
								{
									jobId,
									surfaceId,
									profileId,
									environmentId,
									sourceKind: "code_repo",
									liveHeadSha: serverMainSha,
									repositoryKey: `${f.repository.owner}/${f.repository.name}`,
									repositorySubpath: "apps/api",
									siteId,
									siteSlug: "thetaband",
									leaseToken,
									payload: {
										liveHeadSha: serverMainSha,
										repositoryKey: `${f.repository.owner}/${f.repository.name}`,
									},
								},
							],
							cleanups: [],
							automations: [],
						};
					}
					if (method === "qorpera_surface_site_deployment_register") {
						return {
							siteId,
							slug: "thetaband",
							versionId: verId,
							deploymentId: depId,
							versionNumber: 1,
							kind: "server",
							state: args.p_promote_live === true ? "live" : "ready",
						};
					}
					return { ok: true };
				},
			},
			hosts: {
				async run(_companyId, _envId, _signal, fn) {
					return fn(f.job, undefined as never);
				},
			},
		});

		const result = await worker.pass(new AbortController().signal);
		expect(result).toEqual({ previews: 0, merges: 0, publishes: 1, cleanups: 0, failed: 0 });
		expect(seenDockerfile).toBe("Dockerfile");
		expect(seenEntries).toEqual([".qorpera", "Dockerfile", "server.js"]);
		expect(seenServerContent).toContain("subpath-api");
	});

	it("injects granted broker secrets and linked DATABASE_URL into app-host while keeping persisted envSpec secret-free and masking deploy errors", async () => {
		const f = await createCodeHostFixture();
		const workerId = randomUUID();
		await addCodeWorktree(f.job, { repository: f.repository, workerId, baseSha: f.baseSha });
		const src = join(f.code, "worktrees", workerId);
		await mkdir(join(src, ".qorpera"), { recursive: true });
		await writeFile(
			join(src, ".qorpera", "checks.json"),
			JSON.stringify({
				checks: [{ name: "test", run: "true" }],
				site: { kind: "server", port: 3000, healthPath: "/health" },
			}),
		);
		await writeFile(join(src, "server.js"), "console.log('secrets-app');\n");
		await f.git(src, "add", ".");
		await f.git(src, "commit", "-m", "secrets server app");
		const serverMainSha = await f.git(src, "rev-parse", "HEAD");
		await f.git(join(f.code, "repo.git"), "--git-dir=.", "update-ref", "refs/heads/main", serverMainSha);

		const profileId = randomUUID();
		const environmentId = randomUUID();
		const surfaceId = randomUUID();
		const siteId = randomUUID();
		const jobId = randomUUID();
		const leaseToken = randomUUID();
		const depId = randomUUID();
		const verId = randomUUID();
		const imageRef = `127.0.0.1:5000/qorpera-apps/secrets@sha256:${"5".repeat(64)}`;
		const stripeSecret = "sk-live-surface-secret-554433";
		const dbUrl = "postgresql://shop_rw:pg-secret-221100@10.99.0.10:5432/co_shop?sslmode=require";
		const rpcCalls: Array<{ method: string; args: Record<string, unknown> }> = [];
		const appHostPayloads: Array<Record<string, unknown>> = [];
		let failWithSecret = false;

		const makeWorker = () =>
			new SurfaceCodeHostWorker({
				exportSource: async (_job, input) => ({ sourceDir: input.tree }),
				staleSweepIntervalMs: 60_000,
				nativeEdge: {
					routerInternalUrl: "http://127.0.0.1:8088",
					controlToken: "router-secret",
					appHostInternalUrl: "http://127.0.0.1:8089",
					appHostControlToken: "apphost-secret",
					companyDataUrl: "http://127.0.0.1:8091",
					companyDataPublicUrl: "https://data.qorpera.com",
					companyDataDirectLoginToken: "direct-login-tok",
					companyDataFetchImpl: async () => ({
						status: 200,
						body: JSON.stringify({
							connectionString: dbUrl,
							host: "10.99.0.10",
							port: 5432,
							database: "co_shop",
							schema: "public",
							user: "shop_rw",
						}),
					}),
					broker: {
						origin: "https://broker.internal",
						executorToken: "exec-tok",
						executorOwner: "node-1",
						machineIdSha256: "e".repeat(64),
						fetchImpl: async () =>
							new Response(
								JSON.stringify({
									schema: "qorpera.app-secrets/v1",
									siteId,
									slug: "thetaband",
									scope: "runtime",
									targetEnv: "prod",
									secrets: { STRIPE_KEY: stripeSecret },
								}),
								{ status: 200, headers: { "content-type": "application/json" } },
							),
					},
					buildAppImage: async () => ({ ociImageRef: imageRef, builtMs: 8 }),
					appHostFetchImpl: async (_url, init) => {
						appHostPayloads.push(JSON.parse(init.body ?? "{}") as Record<string, unknown>);
						if (failWithSecret) {
							throw new Error(`container failed with ${stripeSecret} and ${dbUrl}`);
						}
						return { status: 200, body: JSON.stringify({ upstream_addr: "127.0.0.1:48001" }) };
					},
				},
				control: {
					async call(method, args) {
						rpcCalls.push({ method, args });
						if (method === "qorpera_surface_claim_pending_jobs_for_lane") {
							return {
								sessions: [],
								previews: [],
								merges: [],
								publishes: [
									{
										jobId,
										surfaceId,
										profileId,
										environmentId,
										sourceKind: "code_repo",
										liveHeadSha: serverMainSha,
										repositoryKey: `${f.repository.owner}/${f.repository.name}`,
										siteId,
										siteSlug: "thetaband",
										leaseToken,
										payload: {
											liveHeadSha: serverMainSha,
											repositoryKey: `${f.repository.owner}/${f.repository.name}`,
										},
									},
								],
								cleanups: [],
								automations: [],
							};
						}
						if (method === "qorpera_surface_site_runtime_config") {
							return {
								schema: "qorpera.surface-site-runtime-config/v1",
								found: true,
								siteId,
								slug: "thetaband",
								runtimeEnvConfig: { PUBLIC_API_BASE: "https://api.example.com" },
								linkedDatabaseName: "shop",
								hasRuntimeDevSecrets: false,
								hasRuntimeProdSecrets: true,
							};
						}
						if (method === "qorpera_surface_site_deployment_register") {
							return {
								siteId,
								slug: "thetaband",
								versionId: verId,
								deploymentId: depId,
								versionNumber: 1,
								kind: "server",
								state: args.p_promote_live === true ? "live" : "ready",
							};
						}
						return { ok: true };
					},
				},
				hosts: {
					async run(_companyId, _envId, _signal, fn) {
						return fn(f.job, undefined as never);
					},
				},
			});

		const worker = makeWorker();
		const result = await worker.pass(new AbortController().signal);
		expect(result).toEqual({ previews: 0, merges: 0, publishes: 1, cleanups: 0, failed: 0 });

		const registerCalls = rpcCalls.filter((c) => c.method === "qorpera_surface_site_deployment_register");
		expect(registerCalls).toHaveLength(2);
		for (const reg of registerCalls) {
			const persistedEnv = reg.args.p_env_spec as Record<string, string>;
			expect(persistedEnv.PUBLIC_API_BASE).toBe("https://api.example.com");
			expect(persistedEnv.QORPERA_COMPANY_DATA_PUBLIC_URL).toBe("https://data.qorpera.com");
			expect(persistedEnv.STRIPE_KEY).toBeUndefined();
			expect(persistedEnv.DATABASE_URL).toBeUndefined();
		}
		expect(appHostPayloads[0]?.env).toEqual({
			PUBLIC_API_BASE: "https://api.example.com",
			PORT: "3000",
			NODE_ENV: "production",
			QORPERA_REPOSITORY: `${f.repository.owner}/${f.repository.name}`,
			QORPERA_COMPANY_DATA_URL: "http://127.0.0.1:8091",
			QORPERA_COMPANY_DATA_PUBLIC_URL: "https://data.qorpera.com",
			STRIPE_KEY: stripeSecret,
			DATABASE_URL: dbUrl,
		});

		failWithSecret = true;
		rpcCalls.length = 0;
		const workerFail = makeWorker();
		await workerFail.pass(new AbortController().signal);
		const failedPublish = rpcCalls.find((c) => c.method === "qorpera_surface_complete_publish");
		expect(failedPublish?.args.p_status).toBe("failed");
		expect(String(failedPublish?.args.p_error_detail ?? "")).not.toContain(stripeSecret);
		expect(String(failedPublish?.args.p_error_detail ?? "")).not.toContain(dbUrl);
	});
});
