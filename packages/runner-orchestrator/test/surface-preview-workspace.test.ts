import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	PREVIEW_WORKSPACE_CHECK,
	PREVIEW_WORKSPACE_SYNC,
	parseLeadingPackageInstall,
	previewWorkspaceDir,
	previewWorkspaceKey,
} from "../src/surface-preview-workspace.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function runGit(cwd: string, args: readonly string[]): string {
	return execFileSync("git", [...args], {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@example.com",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
		},
	}).trim();
}

function runBash(script: string, cwd: string, env: Record<string, string>): { status: number; output: string } {
	try {
		const stdout = execFileSync("bash", ["--noprofile", "--norc", "-c", script], {
			cwd,
			encoding: "utf8",
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { status: 0, output: stdout };
	} catch (error) {
		const err = error as { status?: number | null; stdout?: string; stderr?: string };
		return { status: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
	}
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("parseLeadingPackageInstall", () => {
	it("splits pure npm, pnpm, yarn, and bun install prefixes from the build command", () => {
		expect(parseLeadingPackageInstall("npm ci && npm run build")).toEqual({
			manager: "npm",
			installCommand: "npm ci",
			buildCommand: "npm run build",
		});
		expect(
			parseLeadingPackageInstall(
				"npm ci --no-audit --no-fund --prefer-offline && npm run typecheck && npm run build",
			),
		).toEqual({
			manager: "npm",
			installCommand: "npm ci --no-audit --no-fund --prefer-offline",
			buildCommand: "npm run typecheck && npm run build",
		});
		expect(parseLeadingPackageInstall("npm install --legacy-peer-deps --loglevel=error && vite build")).toEqual({
			manager: "npm",
			installCommand: "npm install --legacy-peer-deps --loglevel=error",
			buildCommand: "vite build",
		});
		expect(parseLeadingPackageInstall("pnpm install --frozen-lockfile && pnpm run build")).toEqual({
			manager: "pnpm",
			installCommand: "pnpm install --frozen-lockfile",
			buildCommand: "pnpm run build",
		});
		expect(parseLeadingPackageInstall("yarn --frozen-lockfile && yarn build")).toEqual({
			manager: "yarn",
			installCommand: "yarn --frozen-lockfile",
			buildCommand: "yarn build",
		});
		expect(parseLeadingPackageInstall("yarn install --immutable && yarn build")).toEqual({
			manager: "yarn",
			installCommand: "yarn install --immutable",
			buildCommand: "yarn build",
		});
		expect(parseLeadingPackageInstall("bun install --frozen-lockfile && bun run build")).toEqual({
			manager: "bun",
			installCommand: "bun install --frozen-lockfile",
			buildCommand: "bun run build",
		});
	});

	it("returns null for non-install commands, package additions, env prefixes, or shell metacharacters", () => {
		expect(parseLeadingPackageInstall("npm run build")).toBeNull();
		expect(parseLeadingPackageInstall("npm install react && npm run build")).toBeNull();
		expect(parseLeadingPackageInstall("npm ci || npm install && npm run build")).toBeNull();
		expect(parseLeadingPackageInstall("NODE_ENV=production npm ci && npm run build")).toBeNull();
		expect(parseLeadingPackageInstall("npm ci; npm run build")).toBeNull();
		expect(parseLeadingPackageInstall("npm ci &&")).toBeNull();
		expect(parseLeadingPackageInstall("cd web && npm ci && npm run build")).toBeNull();
	});

	it("derives deterministic workspace keys and paths", () => {
		const k1 = previewWorkspaceKey("code/surfaces/shop", ".");
		const k2 = previewWorkspaceKey("code/surfaces/shop", "web");
		expect(k1).toMatch(/^[0-9a-f]{24}$/);
		expect(k2).toMatch(/^[0-9a-f]{24}$/);
		expect(k1).not.toBe(k2);
		expect(previewWorkspaceDir(200001, k1)).toBe(`/home/qorpera-200001/.qorpera-preview-workspaces/${k1}`);
		expect(Buffer.byteLength(PREVIEW_WORKSPACE_SYNC, "utf8")).toBeLessThanOrEqual(16384);
		expect(Buffer.byteLength(PREVIEW_WORKSPACE_CHECK, "utf8")).toBeLessThanOrEqual(16384);
	});
});

describe("PREVIEW_WORKSPACE_SYNC", () => {
	it("preserves mtime of unchanged files and warm caches while syncing changed/deleted files and cleaning stale dist", () => {
		const root = makeTempDir("qorpera-pws-");
		const work = join(root, "work");
		const bare = join(root, "repo.git");
		const checksRoot = join(root, "checks");
		const wsRoot = join(root, "workspaces");
		mkdirSync(work, { recursive: true });
		runGit(work, ["init", "-b", "main"]);
		runGit(work, ["init", "--bare", bare]);
		mkdirSync(join(work, "src"), { recursive: true });
		writeFileSync(join(work, "src/unchanged.ts"), "export const stable = 1;\n");
		writeFileSync(join(work, "src/changed.ts"), "export const v = 1;\n");
		writeFileSync(join(work, "src/removed.ts"), "export const gone = true;\n");
		runGit(work, ["add", "."]);
		runGit(work, ["commit", "-m", "v1"]);
		const c1 = runGit(work, ["rev-parse", "HEAD"]);
		runGit(work, ["push", bare, "HEAD:refs/heads/main"]);

		const wsKey = previewWorkspaceKey("code/surfaces/shop", ".");
		const first = runBash(PREVIEW_WORKSPACE_SYNC, root, {
			QORPERA_CHECKS_ROOT: checksRoot,
			QORPERA_CHECKS_NAME: "0000000001-0001",
			QORPERA_CHECKS_REPOSITORY: bare,
			QORPERA_CHECKS_COMMIT: c1,
			QORPERA_PREVIEW_WORKSPACES_ROOT: wsRoot,
			QORPERA_PREVIEW_WORKSPACE_KEY: wsKey,
			QORPERA_PREVIEW_OUTPUT_FOLDER: "dist",
		});
		expect(first.status).toBe(0);

		const srcDir = join(wsRoot, wsKey, "src");
		expect(readFileSync(join(srcDir, "src/unchanged.ts"), "utf8")).toBe("export const stable = 1;\n");
		expect(runGit(srcDir, ["rev-parse", "HEAD"])).toBe(c1);

		const unchangedMtimeBefore = statSync(join(srcDir, "src/unchanged.ts")).mtimeMs;
		mkdirSync(join(srcDir, "node_modules/pkg"), { recursive: true });
		writeFileSync(join(srcDir, "node_modules/pkg/index.js"), "module.exports = 42;\n");
		mkdirSync(join(srcDir, ".vite"), { recursive: true });
		writeFileSync(join(srcDir, ".vite/deps.json"), "{}");
		mkdirSync(join(srcDir, "dist/assets"), { recursive: true });
		writeFileSync(join(srcDir, "dist/assets/stale-11111111.js"), "old chunk");

		writeFileSync(join(work, "src/changed.ts"), "export const v = 2;\n");
		rmSync(join(work, "src/removed.ts"));
		writeFileSync(join(work, "src/added.ts"), "export const added = true;\n");
		runGit(work, ["add", "-A"]);
		runGit(work, ["commit", "-m", "v2"]);
		const c2 = runGit(work, ["rev-parse", "HEAD"]);
		runGit(work, ["push", bare, "HEAD:refs/heads/main"]);

		const second = runBash(PREVIEW_WORKSPACE_SYNC, root, {
			QORPERA_CHECKS_ROOT: checksRoot,
			QORPERA_CHECKS_NAME: "0000000002-0001",
			QORPERA_CHECKS_REPOSITORY: bare,
			QORPERA_CHECKS_COMMIT: c2,
			QORPERA_PREVIEW_WORKSPACES_ROOT: wsRoot,
			QORPERA_PREVIEW_WORKSPACE_KEY: wsKey,
			QORPERA_PREVIEW_OUTPUT_FOLDER: "dist",
		});
		expect(second.status).toBe(0);
		expect(statSync(join(srcDir, "src/unchanged.ts")).mtimeMs).toBe(unchangedMtimeBefore);
		expect(readFileSync(join(srcDir, "src/changed.ts"), "utf8")).toBe("export const v = 2;\n");
		expect(readFileSync(join(srcDir, "src/added.ts"), "utf8")).toBe("export const added = true;\n");
		expect(() => statSync(join(srcDir, "src/removed.ts"))).toThrow();
		expect(readFileSync(join(srcDir, "node_modules/pkg/index.js"), "utf8")).toBe("module.exports = 42;\n");
		expect(readFileSync(join(srcDir, ".vite/deps.json"), "utf8")).toBe("{}");
		expect(() => statSync(join(srcDir, "dist"))).toThrow();
		expect(runGit(srcDir, ["rev-parse", "HEAD"])).toBe(c2);
	});
});

describe("PREVIEW_WORKSPACE_CHECK", () => {
	it("skips leading install on lockfile hit, re-installs on dep change, and self-heals on missing module", () => {
		const root = makeTempDir("qorpera-pwc-");
		const checksRoot = join(root, "checks");
		const wsDir = join(root, "ws");
		const srcDir = join(wsDir, "src");
		const installCountFile = join(root, "install.count");
		const buildCountFile = join(root, "build.count");
		mkdirSync(join(checksRoot, "0000000001-0001/out"), { recursive: true });
		mkdirSync(srcDir, { recursive: true });

		writeFileSync(
			join(srcDir, "package.json"),
			JSON.stringify({
				name: "demo",
				version: "1.0.0",
				dependencies: { a: "1.0.0" },
				scripts: { build: "echo ok" },
			}),
		);
		writeFileSync(join(srcDir, "package-lock.json"), '{"lockfileVersion":3,"packages":{"a":"1.0.0"}}');

		const installCmd = `mkdir -p node_modules/a && echo ok > node_modules/a/ok && echo 1 >> "${installCountFile}"`;
		const buildCmd = `test -f node_modules/a/ok || { echo "Error: Cannot find module 'a'"; exit 1; }; echo 1 >> "${buildCountFile}"`;

		const runOne = (seq: string) => {
			mkdirSync(join(checksRoot, seq, "out"), { recursive: true });
			return runBash(PREVIEW_WORKSPACE_CHECK, srcDir, {
				QORPERA_CHECKS_ROOT: checksRoot,
				QORPERA_CHECKS_NAME: seq,
				QORPERA_CHECK_CWD: ".",
				QORPERA_CHECK_RUN: `${installCmd} && ${buildCmd}`,
				QORPERA_CHECK_LOG: join(checksRoot, seq, "out/1-preview.log"),
				QORPERA_PREVIEW_WORKSPACE_DIR: wsDir,
				QORPERA_PREVIEW_INSTALL_MANAGER: "npm",
				QORPERA_PREVIEW_INSTALL_CMD: installCmd,
				QORPERA_PREVIEW_BUILD_CMD: buildCmd,
			});
		};

		const countLines = (path: string) => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).length;

		expect(runOne("0000000001-0001").status).toBe(0);
		expect(countLines(installCountFile)).toBe(1);
		expect(countLines(buildCountFile)).toBe(1);

		writeFileSync(
			join(srcDir, "package.json"),
			JSON.stringify({
				name: "demo",
				version: "1.0.1",
				dependencies: { a: "1.0.0" },
				scripts: { build: "echo ok2" },
			}),
		);
		expect(runOne("0000000002-0001").status).toBe(0);
		expect(countLines(installCountFile)).toBe(1);
		expect(countLines(buildCountFile)).toBe(2);

		writeFileSync(join(srcDir, "package-lock.json"), '{"lockfileVersion":3,"packages":{"a":"2.0.0"}}');
		expect(runOne("0000000003-0001").status).toBe(0);
		expect(countLines(installCountFile)).toBe(2);
		expect(countLines(buildCountFile)).toBe(3);

		rmSync(join(srcDir, "node_modules/a/ok"));
		expect(runOne("0000000004-0001").status).toBe(0);
		expect(countLines(installCountFile)).toBe(3);
		expect(countLines(buildCountFile)).toBe(4);
	});
});
