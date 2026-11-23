import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SURFACE_IDENTITY_CSS_MOUNT_PATH } from "@qorpera/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
	addCodeWorktree,
	type CodeHostCommand,
	type CodeHostJob,
	type CodeHostShell,
	startCodeArea,
} from "../src/code-host-jobs.ts";
import { readCodeSiteTree, readSurfaceSiteTree } from "../src/code-host-sites.ts";
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
		expect(previewPass).toEqual({ previews: 1, merges: 0, publishes: 0, failed: 0 });
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
		expect(mergePass).toEqual({ previews: 0, merges: 1, publishes: 0, failed: 0 });
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
		expect(publishPass).toEqual({ previews: 0, merges: 0, publishes: 1, failed: 0 });
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
		expect(failedPass).toEqual({ previews: 0, merges: 0, publishes: 0, failed: 1 });
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
		expect(undoPass).toEqual({ previews: 0, merges: 1, publishes: 0, failed: 0 });
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
		expect(pass).toEqual({ previews: 0, merges: 1, publishes: 0, failed: 0 });
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
		expect(firstPass).toEqual({ previews: 0, merges: 1, publishes: 0, failed: 0 });
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
		expect(secondPass).toEqual({ previews: 0, merges: 0, publishes: 0, failed: 1 });
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
