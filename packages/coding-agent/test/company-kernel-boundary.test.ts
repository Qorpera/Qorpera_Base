import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let root: string;

beforeEach(() => {
	root = join(tmpdir(), `qorpera-company-kernel-boundary-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(root, { recursive: true });
});

afterEach(() => {
	if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe("company CLI kernel boundary", () => {
	it("refuses a company trail selected from an unrelated startup directory", () => {
		const company = join(root, "company");
		const trail = join(company, "trail");
		const session = join(trail, "forged.jsonl");
		const outside = join(root, "outside");
		const agentDir = join(root, "agent-home");
		mkdirSync(trail, { recursive: true });
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(company, "authority.toml"), '[authority]\nmode = "gate"\n', "utf-8");
		writeFileSync(
			session,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "11111111-1111-4111-8111-111111111111",
				timestamp: new Date().toISOString(),
				cwd: company,
				qorpera: { actor: "controller", attended: true },
			})}\n`,
			"utf-8",
		);

		const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
		const repositoryRoot = resolve(packageRoot, "..", "..");
		const result = spawnSync(
			process.execPath,
			[
				join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs"),
				"--tsconfig",
				join(repositoryRoot, "tsconfig.json"),
				join(packageRoot, "src", "cli.ts"),
				"--offline",
				"--mode",
				"rpc",
				"--session",
				session,
			],
			{
				cwd: outside,
				env: {
					...process.env,
					QORPERA_CODING_AGENT_DIR: agentDir,
					QORPERA_SKIP_VERSION_CHECK: "1",
				},
				encoding: "utf-8",
				timeout: 30_000,
			},
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"Company sessions require a live Qorpera Base desktop kernel binding after session resolution.",
		);
	});
});
