import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendKernelObservation,
	applyKernelWriteFrame,
	bindTrailSession,
	commitTrailAppend,
	parseTrailAppendFrame,
	protectedControllerPaths,
	sandboxCommandArgs,
	writeSandboxProfile,
} from "../src/agent-runtime.ts";
import {
	captureCompanyGitBaseline,
	checkpointCompanyGit,
	commitCompanyMaterialization,
	reconcilePendingCompanyCheckpoints,
	savePendingCompanyCheckpoint,
} from "../src/company-checkpoint.ts";

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
		const append = parseTrailAppendFrame({ type: "qorpera_trail_append", token: binding.token, entry }, binding);
		expect(append?.entry).toMatchObject({ type: "custom", id: "one", parentId: null, customType: "x" });
		expect(append?.entry.kernel).toMatchObject({ sequence: 1, previousHash: null });
		expect(append?.entry.provenance).toEqual({ source: "child", trust: "assertion" });
		commitTrailAppend(binding, append!);
		expect(
			parseTrailAppendFrame({ type: "qorpera_trail_append", token: binding.token, entry }, binding),
		).toBeUndefined();
		appendFileSync(binding.path, `${JSON.stringify(append!.entry)}\n`);
		appendKernelObservation(binding, {
			frameType: "prompt",
			message: "founder instruction",
			attended: true,
			origin: "native-founder-confirmation",
		});
		expect(
			bindTrailSession(company, company, { actor: "controller", attended: true }, binding.file).audit.sequence,
		).toBe(2);
		const unknown = { ...entry, id: "two", type: "fabricated_root_event" };
		expect(
			parseTrailAppendFrame({ type: "qorpera_trail_append", token: binding.token, entry: unknown }, binding),
		).toBeUndefined();

		const hash = "a".repeat(64);
		expect(
			applyKernelWriteFrame(
				{
					type: "qorpera_kernel_write",
					token: binding.token,
					operation: "create_gate",
					gate: {
						id: "gate-aaaaaaaa",
						file: "gate-aaaaaaaa.md",
						effectClass: "authority",
						toolName: "bash",
						hash,
						what: "test gate",
						args: { command: "echo ok" },
					},
				},
				binding,
				company,
			),
		).toBe(true);
		const gatePath = join(company, "inbox", "gate-aaaaaaaa.md");
		expect(readFileSync(gatePath, "utf-8")).toContain("status: pending");
		writeFileSync(gatePath, readFileSync(gatePath, "utf-8").replace("pending", "approved"), "utf-8");
		let response: { granted: boolean } | undefined;
		applyKernelWriteFrame(
			{
				type: "qorpera_kernel_write",
				token: binding.token,
				operation: "consume_gate",
				file: "gate-aaaaaaaa.md",
				requestId: "request-1",
				hash,
				status: "consumed",
			},
			binding,
			company,
			(value) => {
				response = value;
			},
		);
		expect(response).toMatchObject({ granted: true });
		expect(readFileSync(gatePath, "utf-8")).toContain("status: consumed");
		response = undefined;
		applyKernelWriteFrame(
			{
				type: "qorpera_kernel_write",
				token: binding.token,
				operation: "consume_gate",
				file: "gate-aaaaaaaa.md",
				requestId: "request-2",
				hash,
				status: "consumed",
			},
			binding,
			company,
			(value) => {
				response = value;
			},
		);
		expect(response).toMatchObject({ granted: false });

		const forged = readFileSync(gatePath, "utf-8").replace("status: consumed", "status: pending\nstatus: approved");
		writeFileSync(gatePath, forged, "utf-8");
		response = undefined;
		applyKernelWriteFrame(
			{
				type: "qorpera_kernel_write",
				token: binding.token,
				operation: "consume_gate",
				file: "gate-aaaaaaaa.md",
				requestId: "request-3",
				hash,
				status: "consumed",
			},
			binding,
			company,
			(value) => {
				response = value;
			},
		);
		expect(response).toMatchObject({ granted: false });
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
			[root],
			["api.openai.com"],
		);
		let config = readFileSync(join(configDir, "config.toml"), "utf-8");
		expect(config).not.toContain('":root" = "read"');
		expect(config).toContain("network_proxy = true");
		expect(config).toContain('"api.openai.com" = "allow"');
		expect(config).toContain("[permissions.qorpera-agent.network]\nenabled = false");
		expect(config).toContain(`${JSON.stringify(company)} = "write"`);
		expect(config).toContain(`${JSON.stringify(join(company, repository))} = "read"`);
		expect(config).toContain(`${JSON.stringify(join(company, "inbox", "messages"))} = "write"`);
		expect(config).toContain(`${JSON.stringify(join(company, ".qorpera", "settings.json"))} = "read"`);

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
			[root],
			["api.openai.com"],
		);
		config = readFileSync(join(configDir, "config.toml"), "utf-8");
		expect(config).toContain(`${JSON.stringify(company)} = "read"`);
		expect(config).toContain(`${JSON.stringify(join(company, worktree))} = "write"`);
		expect(sandboxCommandArgs("codex.js", runtimeDir, "node", ["rpc.js", "--mode", "rpc"])).toEqual(
			expect.arrayContaining(["-C", runtimeDir, "--", "node", "rpc.js", "--mode", "rpc"]),
		);
	});

	it("checkpoints content changed by the session while preserving untouched baseline dirt", () => {
		const company = join(root, "company");
		writeFileSync(join(company, "company.md"), "seed\n", "utf-8");
		writeFileSync(join(company, "founder.md"), "seed\n", "utf-8");
		for (const args of [
			["init"],
			["add", "company.md"],
			["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"],
		]) {
			expect(spawnSync("git", args, { cwd: company, stdio: "ignore" }).status).toBe(0);
		}
		writeFileSync(join(company, "preexisting.md"), "founder work\n", "utf-8");
		writeFileSync(join(company, "shared.md"), "founder baseline\n", "utf-8");
		writeFileSync(join(company, "founder.md"), "founder staged\n", "utf-8");
		expect(spawnSync("git", ["add", "founder.md"], { cwd: company, stdio: "ignore" }).status).toBe(0);
		const baseline = captureCompanyGitBaseline(company);
		writeFileSync(join(company, "shared.md"), "founder baseline\ncontroller continuation\n", "utf-8");
		writeFileSync(join(company, "agent.md"), "controller work\n", "utf-8");
		writeFileSync(join(company, "trail", "session.jsonl"), "trail\n", "utf-8");
		expect(checkpointCompanyGit(company, baseline, "session.jsonl").success).toBe(true);
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
		expect(spawnSync("git", ["ls-files", "shared.md"], { cwd: company, encoding: "utf-8" }).stdout.trim()).toBe(
			"shared.md",
		);
		expect(
			spawnSync("git", ["ls-files", "trail/session.jsonl"], { cwd: company, encoding: "utf-8" }).stdout.trim(),
		).toBe("trail/session.jsonl");
		expect(
			spawnSync("git", ["diff", "--cached", "--name-only"], { cwd: company, encoding: "utf-8" }).stdout,
		).toContain("founder.md");
	});

	it("reconciles a durable checkpoint left by an interrupted agent", () => {
		const company = join(root, "company");
		writeFileSync(join(company, "company.md"), "seed\n", "utf-8");
		for (const args of [
			["init"],
			["add", "company.md"],
			["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"],
		]) {
			expect(spawnSync("git", args, { cwd: company, stdio: "ignore" }).status).toBe(0);
		}
		const baseline = captureCompanyGitBaseline(company);
		const checkpointDir = join(root, "checkpoint-state");
		const statePath = join(checkpointDir, "interrupted.json");
		savePendingCompanyCheckpoint(statePath, company, baseline, "interrupted.jsonl");
		writeFileSync(join(company, "recovered.md"), "preserve me\n", "utf-8");
		reconcilePendingCompanyCheckpoints(checkpointDir, company);
		expect(existsSync(statePath)).toBe(false);
		expect(spawnSync("git", ["ls-files", "recovered.md"], { cwd: company, encoding: "utf-8" }).stdout.trim()).toBe(
			"recovered.md",
		);
	});

	it("commits kernel materialization into an existing company repository before baseline capture", () => {
		const company = join(root, "company");
		writeFileSync(join(company, "seed.md"), "existing repository\n", "utf-8");
		for (const args of [
			["init"],
			["add", "seed.md"],
			["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"],
		]) {
			expect(spawnSync("git", args, { cwd: company, stdio: "ignore" }).status).toBe(0);
		}
		mkdirSync(join(company, "userland"), { recursive: true });
		writeFileSync(join(company, "userland", "index.html"), "evolved\n", "utf-8");
		commitCompanyMaterialization(company, ["userland"]);
		expect(
			spawnSync("git", ["ls-files", "userland/index.html"], { cwd: company, encoding: "utf-8" }).stdout.trim(),
		).toBe("userland/index.html");
		expect(spawnSync("git", ["log", "-1", "--format=%B"], { cwd: company, encoding: "utf-8" }).stdout).toContain(
			"Qorpera-Trigger: desktop kernel open",
		);
	});
});
