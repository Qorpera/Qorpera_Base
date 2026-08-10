import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { provisionWindowsSandbox, sandboxCommandArgs, writeSandboxProfile } from "../src/agent-runtime.ts";

const RUN_WINDOWS_INTEGRATION = process.platform === "win32" && process.env.QORPERA_WINDOWS_SANDBOX_INTEGRATION === "1";
const CODEX_ENTRY = fileURLToPath(import.meta.resolve("@openai/codex/bin/codex.js"));
let integrationRoot: string | undefined;

function cleanEnvironment(configDir: string, runtimeDir: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const name of [
		"PATH",
		"SystemRoot",
		"SYSTEMROOT",
		"WINDIR",
		"COMSPEC",
		"PATHEXT",
		"LOCALAPPDATA",
		"PROGRAMDATA",
		"ProgramFiles",
		"ProgramFiles(x86)",
		"USERNAME",
		"USERDOMAIN",
	]) {
		if (process.env[name]) env[name] = process.env[name];
	}
	env.CODEX_HOME = configDir;
	env.HOME = runtimeDir;
	env.USERPROFILE = runtimeDir;
	env.APPDATA = runtimeDir;
	env.TEMP = runtimeDir;
	env.TMP = runtimeDir;
	return env;
}

afterEach(() => {
	if (integrationRoot && existsSync(integrationRoot)) rmSync(integrationRoot, { recursive: true, force: true });
	integrationRoot = undefined;
});

describe.skipIf(!RUN_WINDOWS_INTEGRATION)("bundled Codex Windows sandbox integration", () => {
	it(
		"provisions a clean profile and enforces filesystem and network authority",
		async () => {
			const parent = process.env.LOCALAPPDATA ?? tmpdir();
			integrationRoot = join(parent, "QorperaSandboxIntegration", `run-${randomUUID()}`);
			const configDir = join(integrationRoot, "codex-home");
			const runtimeDir = join(integrationRoot, "runtime");
			const companyRoot = join(integrationRoot, "company");
			const repositoryPath = join("departments", "widget-development", "repository");
			const worktreesPath = join("departments", "widget-development", "worktrees");
			const worktreePath = join(worktreesPath, "task-reviewed");
			const worktreeRoot = join(companyRoot, worktreePath);
			const outsideRoot = join(integrationRoot, "outside");
			for (const directory of [
				configDir,
				runtimeDir,
				worktreeRoot,
				join(companyRoot, repositoryPath),
				outsideRoot,
			]) {
				mkdirSync(directory, { recursive: true });
			}
			const env = cleanEnvironment(configDir, runtimeDir);
			writeSandboxProfile(
				configDir,
				runtimeDir,
				companyRoot,
				{
					actor: "product-worker",
					attended: false,
					department: join("departments", "widget-development"),
					worktree: worktreePath,
				},
				[join(companyRoot, repositoryPath), join(companyRoot, worktreesPath)],
				[dirname(process.execPath), resolve(CODEX_ENTRY, "..", "..", "..")],
			);
			expect(existsSync(join(configDir, ".sandbox", "setup_marker.json"))).toBe(false);
			expect(existsSync(join(configDir, ".sandbox-secrets", "sandbox_users.json"))).toBe(false);

			provisionWindowsSandbox({
				codexEntry: CODEX_ENTRY,
				configDir,
				runtimeDir,
				nodeExecutable: process.execPath,
				env,
			});
			// The supported Codex setup path owns and validates these records.
			expect(existsSync(join(configDir, ".sandbox", "setup_marker.json"))).toBe(true);
			expect(existsSync(join(configDir, ".sandbox-secrets", "sandbox_users.json"))).toBe(true);
			// Provisioning is idempotent and refreshes the Codex-owned ACL state.
			provisionWindowsSandbox({
				codexEntry: CODEX_ENTRY,
				configDir,
				runtimeDir,
				nodeExecutable: process.execPath,
				env,
			});
			const identityProbe = join(runtimeDir, "identity-probe.mjs");
			writeFileSync(
				identityProbe,
				'import { userInfo } from "node:os"; console.log(userInfo().username);\n',
				"utf-8",
			);
			const identity = spawnSync(
				process.execPath,
				sandboxCommandArgs(CODEX_ENTRY, runtimeDir, process.execPath, [identityProbe]),
				{ cwd: runtimeDir, env, encoding: "utf-8", timeout: 120_000 },
			);
			expect(identity.status, identity.stderr).toBe(0);
			expect(identity.stdout.trim().toLowerCase()).toContain("codexsandboxoffline");

			const writeProbe = join(runtimeDir, "write-probe.mjs");
			writeFileSync(
				writeProbe,
				[
					'import { writeFileSync } from "node:fs";',
					"const [target, expected] = process.argv.slice(2);",
					"try {",
					'  writeFileSync(target, "sandbox write\\n", "utf-8");',
					'  process.exit(expected === "allow" ? 0 : 42);',
					"} catch {",
					'  process.exit(expected === "deny" ? 0 : 43);',
					"}",
				].join("\n"),
				"utf-8",
			);
			const runProbe = (target: string, expected: "allow" | "deny") =>
				spawnSync(
					process.execPath,
					sandboxCommandArgs(CODEX_ENTRY, runtimeDir, process.execPath, [writeProbe, target, expected]),
					{ cwd: runtimeDir, env, encoding: "utf-8", timeout: 120_000 },
				);

			const assignedTarget = join(worktreeRoot, "authorized.txt");
			const allowed = runProbe(assignedTarget, "allow");
			expect({ status: allowed.status, stderr: allowed.stderr }).toMatchObject({ status: 0 });
			expect(existsSync(assignedTarget)).toBe(true);

			const deniedTarget = join(outsideRoot, "blocked.txt");
			const denied = runProbe(deniedTarget, "deny");
			expect({ status: denied.status, stderr: denied.stderr }).toMatchObject({ status: 0 });
			expect(existsSync(deniedTarget)).toBe(false);

			const networkProbe = join(runtimeDir, "network-probe.mjs");
			writeFileSync(
				networkProbe,
				[
					"try {",
					"  await fetch(process.argv[2]);",
					"  process.exit(42);",
					"} catch {",
					"  process.exit(0);",
					"}",
				].join("\n"),
				"utf-8",
			);
			const networkTarget = "https://example.com/";
			const hostNetwork = spawnSync(process.execPath, [networkProbe, networkTarget], {
				cwd: runtimeDir,
				env,
				encoding: "utf-8",
				timeout: 120_000,
			});
			expect(hostNetwork.status, "integration host must have direct network access before sandboxing").toBe(42);
			const network = spawnSync(
				process.execPath,
				sandboxCommandArgs(CODEX_ENTRY, runtimeDir, process.execPath, [networkProbe, networkTarget]),
				{ cwd: runtimeDir, env, encoding: "utf-8", timeout: 120_000 },
			);
			expect({ status: network.status, stderr: network.stderr }).toMatchObject({ status: 0 });
		},
		15 * 60 * 1000,
	);
});
