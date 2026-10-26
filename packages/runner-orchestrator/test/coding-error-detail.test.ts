import { describe, expect, it } from "vitest";
import { CodeHostJobFailure, CodeHostRefusal } from "../src/code-host-jobs.ts";
import { codeHostErrorCode, codingErrorDetail, redactCodingErrorText } from "../src/coding-error-detail.ts";
import { CodingWorkspaceFailed } from "../src/coding-executor.ts";

const worktree = "/company/code/qorpera/example/worktrees/0a1b2c3d-0000-4000-8000-000000000001";

describe("a coding error's code and detail for the executor's log", () => {
	it("names a code host's own error by its code, and nothing else by one", () => {
		expect(codeHostErrorCode(new CodeHostJobFailure("CODE_HOST_WORKTREE_FAILED", "fatal: no"))).toBe(
			"CODE_HOST_WORKTREE_FAILED",
		);
		expect(codeHostErrorCode(new CodeHostRefusal("CODE_HOST_WORKTREE_INCOMPLETE", ["a", "b"]))).toBe(
			"CODE_HOST_WORKTREE_INCOMPLETE",
		);
		expect(codeHostErrorCode(new Error("CODE_HOST_WORKTREE_FAILED: fatal: no"))).toBeUndefined();
		expect(codeHostErrorCode(new CodeHostJobFailure("not a code", "x"))).toBeUndefined();
		expect(codeHostErrorCode("CODE_HOST_WORKTREE_FAILED")).toBeUndefined();
	});
	it("keeps git's message of a failed step, on one line (C8 C4-1, 26 Oct 2026)", () => {
		const failure = new CodeHostJobFailure(
			"CODE_HOST_WORKTREE_FAILED",
			`Preparing worktree (new branch 'qorpera/coding/x')\nfatal: could not create work tree dir '${worktree}': Input/output error\n`,
		);
		expect(codingErrorDetail(failure)).toBe(
			`Preparing worktree (new branch 'qorpera/coding/x') fatal: could not create work tree dir '${worktree}': Input/output error`,
		);
		// Wrapped as the turn's failure, the detail is its cause's.
		expect(codingErrorDetail(new CodingWorkspaceFailed(failure.code, "Making it failed.", { cause: failure }))).toBe(
			codingErrorDetail(failure),
		);
	});
	it("keeps the paths a code host's rule names, and says nothing more for a bare code", () => {
		expect(
			codingErrorDetail(
				new CodeHostRefusal("CODE_HOST_WORKTREE_INCOMPLETE", ["code/a/worktrees/x", "code/a/repo.git"]),
			),
		).toBe("code/a/worktrees/x, code/a/repo.git");
		expect(codingErrorDetail(new CodeHostRefusal("CODE_HOST_NOT_SEEDED"))).toBe("");
		expect(codingErrorDetail(new CodeHostJobFailure("CODE_HOST_TREE_UNREADABLE"))).toBe("");
		expect(codingErrorDetail(new Error("CODING_HOST_VM_RECOVERY_REQUIRED"))).toBe("");
		expect(codingErrorDetail(undefined)).toBe("");
	});
	it("keeps another error's own text, or its cause's under a bare code", () => {
		expect(codingErrorDetail(new Error("LXD: Instance is not running"))).toBe("LXD: Instance is not running");
		expect(codingErrorDetail(new Error("CODING_X", { cause: new Error("connect ECONNREFUSED /run/x.sock") }))).toBe(
			"connect ECONNREFUSED /run/x.sock",
		);
		expect(codingErrorDetail("thrown text")).toBe("thrown text");
		// Never deeper than three causes.
		const deep = new Error("A_CODE", {
			cause: new Error("B_CODE", {
				cause: new Error("C_CODE", { cause: new Error("D_CODE", { cause: new Error("x") }) }),
			}),
		});
		expect(codingErrorDetail(deep)).toBe("");
	});
	it("takes out what could carry a credential, and keeps paths, digests and names", () => {
		const token = "ghs_16C7e42F292c6912E7710c838347Ae178B4a";
		const said = [
			`fatal: unable to access 'https://x-access-token:${token}@github.com/Qorpera/app.git/': The requested URL returned error: 403`,
			"Authorization: Basic eC1hY2Nlc3MtdG9rZW46Z2hzX3NlY3JldA==",
			"authorization=Bearer abcdefghijklmnop",
			"bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl",
			"x-access-token:plainsecretvalue",
			"github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
			"gho_abcdefghijklmnop1234",
			"https://example.invalid/hook?access_token=abc123&ok=1 password=hunter2",
			"opaque KbXz3QeR7tLmN2pV9sWcY4uH8jD6fG1aZ0oE5iT",
			`kept ${"a".repeat(64)} 0a1b2c3d-0000-4000-8000-000000000001 qorpera-coding-machine-${"0".repeat(32)} ${worktree}`,
		].join(" ");
		const redacted = redactCodingErrorText(said);
		for (const secret of [
			token,
			"eC1hY2Nlc3MtdG9rZW46Z2hzX3NlY3JldA",
			"abcdefghijklmnop",
			"eyJhbGciOiJIUzI1NiJ9",
			"plainsecretvalue",
			"github_pat_11ABCDEFG",
			"gho_abcdefghijklmnop1234",
			"abc123",
			"hunter2",
			"KbXz3QeR7tLmN2pV9sWcY4uH8jD6fG1aZ0oE5iT",
		])
			expect(redacted).not.toContain(secret);
		expect(redacted).toContain(
			"'https://[redacted]@github.com/Qorpera/app.git/': The requested URL returned error: 403",
		);
		expect(redacted).toContain("Authorization: [redacted]");
		expect(redacted).toContain("access_token=[redacted]&ok=1 password=[redacted]");
		expect(redacted).toContain(
			`kept ${"a".repeat(64)} 0a1b2c3d-0000-4000-8000-000000000001 qorpera-coding-machine-${"0".repeat(32)} ${worktree}`,
		);
		expect(redactCodingErrorText("fatal: not a git repository: '/company/code/a/repo.git'")).toBe(
			"fatal: not a git repository: '/company/code/a/repo.git'",
		);
	});
	it("cuts a long detail to its first and last characters, 500 in all, after taking credentials out", () => {
		const said = `start ${"w".repeat(600)} https://user:${"S".repeat(40)}@github.com/x end`;
		const detail = codingErrorDetail(new CodeHostJobFailure("CODE_HOST_SEED_FAILED", said));
		expect([...detail]).toHaveLength(500);
		expect(detail.startsWith("start www")).toBe(true);
		expect(detail.endsWith("https://[redacted]@github.com/x end")).toBe(true);
		expect(detail).toContain(" ... ");
		expect(detail).not.toContain("SSSS");
	});
});
