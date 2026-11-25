import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildFinishConflictPreflightCommand,
	CODING_FINISH_CONFLICT_SCHEMA,
	decodeFinishConflictPreflightOutput,
	formatCodingFinishConflictFeedback,
} from "../src/cloud-coding-preflight-land.ts";

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
});
