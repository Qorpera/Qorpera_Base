import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CloudCodingCommandScope } from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudCodingCommandGateway } from "../src/cloud-coding-command-tools.ts";
import {
	buildFinishConflictPreflightCommand,
	CODING_FINISH_CONFLICT_SCHEMA,
	decodeFinishConflictPreflightOutput,
	formatCodingFinishConflictFeedback,
	inspectCodingChangeDiff,
} from "../src/cloud-coding-preflight-land.ts";
import type { CloudToolContext } from "../src/cloud-native-tool-boundary.ts";
import type { CloudNativeToolOperations } from "../src/cloud-native-tool-operations.ts";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const exec = promisify(execFile);
const GIT = "git";
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const GIT_ENV = {
	PATH: process.env.PATH ?? "/usr/bin:/bin",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_AUTHOR_NAME: "Tester",
	GIT_AUTHOR_EMAIL: "tester@example.invalid",
	GIT_COMMITTER_NAME: "Tester",
	GIT_COMMITTER_EMAIL: "tester@example.invalid",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
	return (await exec(GIT, args, { cwd, env: GIT_ENV })).stdout.trim();
}

async function runPreflightBash(cwd: string, baseBranch: string, headSha: string): Promise<string> {
	const command = buildFinishConflictPreflightCommand(baseBranch, headSha);
	try {
		return (await exec("bash", ["-c", command], { cwd, env: GIT_ENV })).stdout;
	} catch (error) {
		const stdout = (error as { stdout?: unknown }).stdout;
		return typeof stdout === "string" ? stdout : "";
	}
}

async function setupFixture() {
	const root = await mkdtemp(join(tmpdir(), "coding-preflight-land-"));
	roots.push(root);
	const repo = join(root, "repo.git");
	const mainWorktree = join(root, "main");
	const sessionWorktree = join(root, "session");
	await mkdir(repo, { recursive: true });
	await git(repo, "init", "--bare", "--initial-branch=main");
	await git(root, "clone", repo, mainWorktree);
	await writeFile(join(mainWorktree, "app.ts"), "export const v = 1;\n");
	await writeFile(join(mainWorktree, "other.ts"), "export const o = 1;\n");
	await git(mainWorktree, "add", ".");
	await git(mainWorktree, "commit", "-m", "initial");
	await git(mainWorktree, "push", "origin", "main");
	const baseSha = await git(mainWorktree, "rev-parse", "HEAD");
	await git(repo, "worktree", "add", "-b", "qorpera/coding/session-1", sessionWorktree, baseSha);
	return { root, repo, mainWorktree, sessionWorktree, baseSha };
}

describe("cloud-coding-preflight-land", () => {
	it("passes fast-forward commits and clean 3-way merges even with untracked files in worktree", async () => {
		const f = await setupFixture();
		await writeFile(join(f.sessionWorktree, "app.ts"), "export const v = 2;\n");
		await writeFile(join(f.sessionWorktree, "scratch-untracked.tmp"), "ignored\n");
		await git(f.sessionWorktree, "add", "app.ts");
		await git(f.sessionWorktree, "commit", "-m", "session edit");
		const headSha = await git(f.sessionWorktree, "rev-parse", "HEAD");

		const ffOut = await runPreflightBash(f.sessionWorktree, "main", headSha);
		expect(decodeFinishConflictPreflightOutput(ffOut)).toEqual({
			baseSha: f.baseSha,
			headSha,
			mergeClean: true,
			conflictedPaths: [],
			conflictMessages: [],
		});

		await writeFile(join(f.mainWorktree, "other.ts"), "export const o = 2;\n");
		await git(f.mainWorktree, "add", "other.ts");
		await git(f.mainWorktree, "commit", "-m", "main edit other");
		await git(f.mainWorktree, "push", "origin", "main");
		const mainTip = await git(f.mainWorktree, "rev-parse", "HEAD");

		const cleanMergeOut = await runPreflightBash(f.sessionWorktree, "main", headSha);
		expect(decodeFinishConflictPreflightOutput(cleanMergeOut)).toEqual({
			baseSha: mainTip,
			headSha,
			mergeClean: true,
			conflictedPaths: [],
			conflictMessages: [],
		});
	});

	it("detects merge-tree conflicts and returns conflict paths and messages", async () => {
		const f = await setupFixture();
		await writeFile(join(f.sessionWorktree, "app.ts"), "export const v = 2;\n");
		await git(f.sessionWorktree, "add", "app.ts");
		await git(f.sessionWorktree, "commit", "-m", "session edit app");
		const headSha = await git(f.sessionWorktree, "rev-parse", "HEAD");

		await writeFile(join(f.mainWorktree, "app.ts"), "export const v = 999;\n");
		await git(f.mainWorktree, "add", "app.ts");
		await git(f.mainWorktree, "commit", "-m", "concurrent main edit app");
		await git(f.mainWorktree, "push", "origin", "main");
		const mainTip = await git(f.mainWorktree, "rev-parse", "HEAD");

		const out = await runPreflightBash(f.sessionWorktree, "main", headSha);
		const decoded = decodeFinishConflictPreflightOutput(out);
		expect(decoded).not.toBeNull();
		expect(decoded?.mergeClean).toBe(false);
		expect(decoded?.conflictedPaths).toEqual(["app.ts"]);
		expect(decoded?.conflictMessages.some((line) => line.includes("app.ts"))).toBe(true);
		const feedback = JSON.parse(
			formatCodingFinishConflictFeedback({
				conflicted: true,
				baseBranch: "main",
				baseSha: mainTip,
				headSha,
				conflictedPaths: decoded?.conflictedPaths ?? [],
				conflictMessages: decoded?.conflictMessages ?? [],
			}),
		) as Record<string, unknown>;
		expect(feedback).toMatchObject({
			schema: CODING_FINISH_CONFLICT_SCHEMA,
			state: "conflict",
			baseBranch: "main",
			baseSha: mainTip,
			headSha,
			conflictedPaths: ["app.ts"],
		});
		expect(String(feedback.summary)).toContain("git merge main");
	});

	it("fails open cleanly when base branch or commit cannot be checked", async () => {
		const f = await setupFixture();
		const out = await runPreflightBash(f.sessionWorktree, "nonexistent-branch", f.baseSha);
		expect(decodeFinishConflictPreflightOutput(out)).toEqual({
			baseSha: f.baseSha,
			headSha: f.baseSha,
			mergeClean: true,
			conflictedPaths: [],
			conflictMessages: [],
		});
		expect(decodeFinishConflictPreflightOutput("not a marker")).toBeNull();
	});

	it("inspectCodingChangeDiff parses real git numstat output and rejects truncated, failed, or invalid inputs", async () => {
		const f = await setupFixture();
		await writeFile(join(f.sessionWorktree, "app.ts"), "export const v = 2;\nexport const extra = 3;\n");
		await writeFile(join(f.sessionWorktree, "logo.bin"), Buffer.from([0, 1, 2, 3, 255]));
		await git(f.sessionWorktree, "add", "app.ts", "logo.bin");
		await git(f.sessionWorktree, "commit", "-m", "edit app and add binary");
		const headSha = await git(f.sessionWorktree, "rev-parse", "HEAD");

		const { binding, authority } = nativeToolAuthorityFixture();
		const scope: CloudCodingCommandScope = {
			workerId: randomUUID(),
			vmId: randomUUID(),
			requestId: randomUUID(),
			turn: 1,
		};
		const context: CloudToolContext = {
			companyId: authority.identity.companyId,
			runId: binding.runId,
			identity: authority.identity,
			callId: "diff-1",
			argumentSha256: "a".repeat(64),
			signal: new AbortController().signal,
		};
		const makeOps = (): Pick<CloudNativeToolOperations, "execute"> => ({
			execute: vi.fn(async (input) => {
				const out = await input.perform(input.operation, {
					receiptId: randomUUID(),
					inputSha256: "b".repeat(64),
					signal: input.signal,
				});
				return out.content;
			}),
		});

		const realGateway: CloudCodingCommandGateway = {
			authorize: vi.fn().mockResolvedValue(undefined),
			start: vi.fn(async (_scope, input) => {
				const { stdout } = await exec("bash", ["-c", input.command], { cwd: f.sessionWorktree, env: GIT_ENV });
				const bytes = Buffer.byteLength(stdout, "utf8");
				return {
					schema: "qorpera.coding-command-result/v2",
					workerId: scope.workerId,
					commandId: input.commandId,
					inputSha256: input.inputSha256,
					state: "succeeded",
					exitCode: 0,
					output: stdout,
					truncated: false,
					log: { offset: 0, nextOffset: bytes, totalBytes: bytes, limitBytes: 67108864, limitReached: false },
				};
			}),
			read: vi.fn(),
			cancel: vi.fn(),
		};

		const realSummary = await inspectCodingChangeDiff({
			scope,
			operations: makeOps(),
			gateway: realGateway,
			checkAuthority: vi.fn().mockResolvedValue(undefined),
			parentSha: f.baseSha,
			commitSha: headSha,
			context,
		});
		expect(realSummary).toEqual({
			affectedPaths: ["app.ts", "logo.bin"],
			diffStats: { filesChanged: 2, additions: 2, deletions: 1 },
		});

		const noopOps = makeOps();
		expect(
			await inspectCodingChangeDiff({
				scope,
				operations: noopOps,
				gateway: realGateway,
				checkAuthority: vi.fn().mockResolvedValue(undefined),
				parentSha: f.baseSha,
				commitSha: f.baseSha,
				context,
			}),
		).toBeNull();
		expect(
			await inspectCodingChangeDiff({
				scope,
				operations: noopOps,
				gateway: realGateway,
				checkAuthority: vi.fn().mockResolvedValue(undefined),
				parentSha: "not-a-sha",
				commitSha: headSha,
				context,
			}),
		).toBeNull();
		expect(noopOps.execute).not.toHaveBeenCalled();

		const encodedPayload = Buffer.from("4\t1\tsrc/a.ts\0", "utf8").toString("base64");
		const fullOutput = `__QORPERA_CHANGE_DIFF_V1__:${encodedPayload}:__QORPERA_CHANGE_DIFF_END__\n`;
		const splitAt = Math.floor(fullOutput.length / 2);
		const pagedGateway: CloudCodingCommandGateway = {
			authorize: vi.fn().mockResolvedValue(undefined),
			start: vi.fn(async (_scope, input) => ({
				schema: "qorpera.coding-command-result/v2",
				workerId: scope.workerId,
				commandId: input.commandId,
				inputSha256: input.inputSha256,
				state: "succeeded",
				exitCode: 0,
				output: fullOutput.slice(0, splitAt),
				truncated: true,
				log: {
					offset: 0,
					nextOffset: splitAt,
					totalBytes: fullOutput.length,
					limitBytes: 67108864,
					limitReached: false,
				},
			})),
			read: vi.fn(async (_scope, input) => ({
				schema: "qorpera.coding-command-result/v2",
				workerId: scope.workerId,
				commandId: input.commandId,
				inputSha256: "b".repeat(64),
				state: "succeeded",
				exitCode: 0,
				output: fullOutput.slice(input.offset),
				truncated: false,
				log: {
					offset: input.offset,
					nextOffset: fullOutput.length,
					totalBytes: fullOutput.length,
					limitBytes: 67108864,
					limitReached: false,
				},
			})),
			cancel: vi.fn(),
		};
		expect(
			await inspectCodingChangeDiff({
				scope,
				operations: makeOps(),
				gateway: pagedGateway,
				checkAuthority: vi.fn().mockResolvedValue(undefined),
				parentSha: f.baseSha,
				commitSha: headSha,
				context,
			}),
		).toEqual({
			affectedPaths: ["src/a.ts"],
			diffStats: { filesChanged: 1, additions: 4, deletions: 1 },
		});

		const limitReachedGateway: CloudCodingCommandGateway = {
			authorize: vi.fn().mockResolvedValue(undefined),
			start: vi.fn(async (_scope, input) => ({
				schema: "qorpera.coding-command-result/v2",
				workerId: scope.workerId,
				commandId: input.commandId,
				inputSha256: input.inputSha256,
				state: "succeeded",
				exitCode: 0,
				output: fullOutput,
				truncated: true,
				log: {
					offset: 0,
					nextOffset: fullOutput.length,
					totalBytes: fullOutput.length,
					limitBytes: fullOutput.length,
					limitReached: true,
				},
			})),
			read: vi.fn(),
			cancel: vi.fn(),
		};
		expect(
			await inspectCodingChangeDiff({
				scope,
				operations: makeOps(),
				gateway: limitReachedGateway,
				checkAuthority: vi.fn().mockResolvedValue(undefined),
				parentSha: f.baseSha,
				commitSha: headSha,
				context,
			}),
		).toBeNull();

		const truncatedGateway: CloudCodingCommandGateway = {
			authorize: vi.fn().mockResolvedValue(undefined),
			start: vi.fn(async (_scope, input) => ({
				schema: "qorpera.coding-command-result/v2",
				workerId: scope.workerId,
				commandId: input.commandId,
				inputSha256: input.inputSha256,
				state: "succeeded",
				exitCode: 0,
				output: fullOutput.slice(0, splitAt),
				truncated: false,
				log: {
					offset: 0,
					nextOffset: splitAt,
					totalBytes: splitAt,
					limitBytes: 67108864,
					limitReached: false,
				},
			})),
			read: vi.fn(),
			cancel: vi.fn(),
		};
		expect(
			await inspectCodingChangeDiff({
				scope,
				operations: makeOps(),
				gateway: truncatedGateway,
				checkAuthority: vi.fn().mockResolvedValue(undefined),
				parentSha: f.baseSha,
				commitSha: headSha,
				context,
			}),
		).toBeNull();

		const failedGateway: CloudCodingCommandGateway = {
			authorize: vi.fn().mockResolvedValue(undefined),
			start: vi.fn(async (_scope, input) => ({
				schema: "qorpera.coding-command-result/v2",
				workerId: scope.workerId,
				commandId: input.commandId,
				inputSha256: input.inputSha256,
				state: "failed",
				exitCode: 128,
				output: "",
				truncated: false,
				log: { offset: 0, nextOffset: 0, totalBytes: 0, limitBytes: 67108864, limitReached: false },
			})),
			read: vi.fn(),
			cancel: vi.fn(),
		};
		expect(
			await inspectCodingChangeDiff({
				scope,
				operations: makeOps(),
				gateway: failedGateway,
				checkAuthority: vi.fn().mockResolvedValue(undefined),
				parentSha: f.baseSha,
				commitSha: headSha,
				context,
			}),
		).toBeNull();
	});
});
