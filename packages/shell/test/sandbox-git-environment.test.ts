import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sandboxGitEnvironment } from "../src/agent-runtime.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("sandbox Git environment", () => {
	it("marks only exact authorized repositories as safe command-scope config", () => {
		const root = mkdtempSync(join(tmpdir(), "qorpera-sandbox-git-"));
		roots.push(root);
		expect(spawnSync("git", ["init"], { cwd: root, stdio: "ignore" }).status).toBe(0);

		const env = sandboxGitEnvironment([root, root]);
		expect(env.GIT_CONFIG_COUNT).toBe("1");
		expect(env.GIT_CONFIG_KEY_0).toBe("safe.directory");
		expect(env.GIT_CONFIG_VALUE_0).toBe(
			process.platform === "win32" ? resolve(root).replaceAll("\\", "/") : resolve(root),
		);
		expect(env.GIT_CONFIG_KEY_1).toBeUndefined();

		const configured = spawnSync("git", ["config", "--get-all", "safe.directory"], {
			cwd: root,
			encoding: "utf-8",
			env: { ...process.env, ...env },
		});
		expect(configured.status).toBe(0);
		expect(configured.stdout.trim()).toBe(env.GIT_CONFIG_VALUE_0);
	});

	it("disables inherited Git config and credential prompts", () => {
		const env = sandboxGitEnvironment([]);
		expect(env).toMatchObject({
			GIT_ATTR_NOSYSTEM: "1",
			GIT_CONFIG_COUNT: "0",
			GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
		});
	});
});
