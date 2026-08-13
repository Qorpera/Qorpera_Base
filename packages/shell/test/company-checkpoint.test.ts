import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureCompanyGitBaseline, checkpointCompanyGit, snapshotFounderGitState } from "../src/company-checkpoint.ts";

function git(root: string, args: string[]): string {
	const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf-8", shell: false, windowsHide: true });
	if (result.status !== 0) throw new Error(result.stderr || result.stdout || "git failed");
	return result.stdout.trim();
}

function repository(): string {
	const root = join(tmpdir(), `qorpera-checkpoint-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(root, "trail"), { recursive: true });
	git(root, ["init"]);
	writeFileSync(join(root, "company.md"), "# Company\n", "utf-8");
	git(root, ["add", "company.md"]);
	git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);
	return root;
}

describe("company checkpoints", () => {
	it("excludes generated Python bytecode from controller checkpoints", () => {
		const root = repository();
		try {
			const baseline = captureCompanyGitBaseline(root);
			mkdirSync(join(root, "app", "tools", "__pycache__"), { recursive: true });
			writeFileSync(join(root, "app", "tools", "__pycache__", "routine.cpython-313.pyc"), "generated", "utf-8");
			writeFileSync(join(root, "app", "plan.md"), "real company state\n", "utf-8");
			writeFileSync(join(root, "trail", "wake.jsonl"), "{}\n", "utf-8");

			expect(checkpointCompanyGit(root, baseline, "wake.jsonl").success).toBe(true);
			const committed = git(root, ["show", "--pretty=format:", "--name-only", "HEAD"]);
			expect(committed).toContain("app/plan.md");
			expect(committed).toContain("trail/wake.jsonl");
			expect(committed).not.toContain("__pycache__");
			expect(git(root, ["status", "--short", "--untracked-files=all"])).toContain("__pycache__");
		} finally {
			if (existsSync(root)) rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not create a founder snapshot for bytecode-only working state", () => {
		const root = repository();
		try {
			const before = git(root, ["rev-parse", "HEAD"]);
			mkdirSync(join(root, "app", "tools", "__pycache__"), { recursive: true });
			writeFileSync(join(root, "app", "tools", "__pycache__", "routine.cpython-313.pyc"), "generated", "utf-8");

			snapshotFounderGitState(root);
			expect(git(root, ["rev-parse", "HEAD"])).toBe(before);
			expect(git(root, ["status", "--short", "--untracked-files=all"])).toContain("__pycache__");
		} finally {
			if (existsSync(root)) rmSync(root, { recursive: true, force: true });
		}
	});
});
