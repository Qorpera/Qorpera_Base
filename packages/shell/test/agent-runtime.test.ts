import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyKernelWriteFrame,
	bindTrailSession,
	parseTrailAppendFrame,
	protectedControllerPaths,
	sandboxCommandArgs,
	writeSandboxProfile,
} from "../src/agent-runtime.ts";
import { captureCompanyGitBaseline, checkpointCompanyGit } from "../src/company-checkpoint.ts";

let root: string;

beforeEach(() => {
	root = join(tmpdir(), `qorpera-agent-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(root, "company", "trail"), { recursive: true });
	mkdirSync(join(root, "company", "inbox", "messages"), { recursive: true });
});

afterEach(() => {
	if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe("kernel-bound agent runtime", () => {
	it("binds role and worktree scope into an immutable trail header", () => {
		const company = join(root, "company");
		const binding = bindTrailSession(company, company, { actor: "controller", attended: true });
		const header = JSON.parse(readFileSync(binding.path, "utf-8").split("\n")[0]);
		expect(header.qorpera).toEqual({ actor: "controller", attended: true });
		expect(() =>
			bindTrailSession(
				company,
				company,
				{
					actor: "product-worker",
					attended: true,
					department: "departments/widget-development",
					worktree: "departments/widget-development/worktrees/task-a",
				},
				binding.file,
			),
		).toThrow("authority does not match");
	});

	it("accepts only token-bound append frames and kernel-owned gate transitions", () => {
		const company = join(root, "company");
		const binding = bindTrailSession(company, company, { actor: "controller", attended: true });
		const entry = { type: "custom", id: "one", parentId: null, timestamp: new Date().toISOString(), customType: "x" };
		expect(parseTrailAppendFrame({ type: "qorpera_trail_append", token: "wrong", entry }, binding)).toBeUndefined();
		expect(
			parseTrailAppendFrame({ type: "qorpera_trail_append", token: binding.token, entry }, binding)?.entry,
		).toEqual(entry);

		const gateContent = "---\nid: gate-abcd\nstatus: pending\nhash: abcd\n---\n";
		expect(
			applyKernelWriteFrame(
				{
					type: "qorpera_kernel_write",
					token: binding.token,
					operation: "create_gate",
					file: "gate-abcd.md",
					content: gateContent,
				},
				binding,
				company,
			),
		).toBe(true);
		const gatePath = join(company, "inbox", "gate-abcd.md");
		expect(readFileSync(gatePath, "utf-8")).toContain("status: pending");
		writeFileSync(gatePath, gateContent.replace("pending", "approved"), "utf-8");
		applyKernelWriteFrame(
			{
				type: "qorpera_kernel_write",
				token: binding.token,
				operation: "consume_gate",
				file: "gate-abcd.md",
				status: "consumed",
			},
			binding,
			company,
		);
		expect(readFileSync(gatePath, "utf-8")).toContain("status: consumed");
	});

	it("generates controller and worker sandbox profiles with nested read-only boundaries", () => {
		const company = join(root, "company");
		const configDir = join(root, "config");
		const runtimeDir = join(root, "runtime");
		const repository = "departments/widget-development/repository";
		const worktrees = "departments/widget-development/worktrees";
		const worktree = `${worktrees}/task-a`;
		for (const path of [repository, worktree, ".git"]) mkdirSync(join(company, path), { recursive: true });
		writeSandboxProfile(
			configDir,
			runtimeDir,
			company,
			{ actor: "controller", attended: true },
			protectedControllerPaths(company, [{ repository, worktrees }]),
		);
		let config = readFileSync(join(configDir, "config.toml"), "utf-8");
		expect(config).toContain(`${JSON.stringify(company)} = "write"`);
		expect(config).toContain(`${JSON.stringify(join(company, repository))} = "read"`);
		expect(config).toContain(`${JSON.stringify(join(company, "inbox", "messages"))} = "write"`);

		writeSandboxProfile(
			configDir,
			runtimeDir,
			company,
			{
				actor: "product-worker",
				attended: true,
				department: "departments/widget-development",
				worktree,
			},
			protectedControllerPaths(company, [{ repository, worktrees }]),
		);
		config = readFileSync(join(configDir, "config.toml"), "utf-8");
		expect(config).toContain(`${JSON.stringify(company)} = "read"`);
		expect(config).toContain(`${JSON.stringify(join(company, worktree))} = "write"`);
		expect(sandboxCommandArgs("codex.js", runtimeDir, "node", ["rpc.js", "--mode", "rpc"])).toEqual(
			expect.arrayContaining(["-C", runtimeDir, "node", "--", "rpc.js", "--mode", "rpc"]),
		);
	});

	it("checkpoints only clean-at-start controller paths with trail provenance", () => {
		const company = join(root, "company");
		writeFileSync(join(company, "company.md"), "seed\n", "utf-8");
		for (const args of [
			["init"],
			["add", "company.md"],
			["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"],
		]) {
			expect(spawnSync("git", args, { cwd: company, stdio: "ignore" }).status).toBe(0);
		}
		writeFileSync(join(company, "preexisting.md"), "founder work\n", "utf-8");
		const baseline = captureCompanyGitBaseline(company);
		writeFileSync(join(company, "agent.md"), "controller work\n", "utf-8");
		checkpointCompanyGit(company, baseline, "session.jsonl");
		const log = spawnSync("git", ["log", "-1", "--format=%B"], { cwd: company, encoding: "utf-8" }).stdout;
		expect(log).toContain("Qorpera-Trigger: trail/session.jsonl");
		expect(log).toContain("Qorpera-Rationale:");
		expect(spawnSync("git", ["ls-files", "agent.md"], { cwd: company, encoding: "utf-8" }).stdout.trim()).toBe(
			"agent.md",
		);
		expect(statSync(join(company, "preexisting.md")).isFile()).toBe(true);
		expect(spawnSync("git", ["ls-files", "preexisting.md"], { cwd: company, encoding: "utf-8" }).stdout.trim()).toBe(
			"",
		);
	});
});
