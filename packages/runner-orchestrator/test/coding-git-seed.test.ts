import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CodingBrokerGitCommand, runCodingBrokerGit } from "../src/coding-git.ts";
import { type CodingGitSeedOptions, fetchCloudCodingSeed, resolveCloudCodingBase } from "../src/coding-git-seed.ts";

const exec = promisify(execFile),
	roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "coding-seed-test-")));
	roots.push(root);
	const source = join(root, "source");
	await mkdir(source);
	const env = {
		PATH: "/usr/bin:/bin",
		HOME: root,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.invalid",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.invalid",
	};
	const git = async (...args: string[]) => (await exec("/usr/bin/git", args, { cwd: source, env })).stdout.trim();
	await git("init", "--template=", "--initial-branch=main", ".");
	await writeFile(join(source, "README.md"), "seed\n");
	await git("add", "README.md");
	await git("commit", "-m", "seed");
	const baseSha = await git("rev-parse", "HEAD"),
		incoming = join(root, "remote.bundle");
	await git("bundle", "create", incoming, "refs/heads/main");
	const input = {
		repository: { host: "github.com" as const, owner: "qorpera", name: "example", baseBranch: "main" },
		workerId: randomUUID(),
		baseSha,
	};
	const calls: CodingBrokerGitCommand[] = [];
	const real = (command: CodingBrokerGitCommand): Promise<string> =>
		process.platform === "linux"
			? runCodingBrokerGit(command)
			: exec("/usr/bin/git", [...command.args], { cwd: command.cwd, env: command.env }).then(
					(result) => result.stdout,
				);
	const runGit = async (command: CodingBrokerGitCommand) => {
		calls.push(command);
		if (command.args.includes("fetch")) {
			expect(command.args.slice(-2)).toEqual([
				"https://github.com/qorpera/example.git",
				"refs/heads/main:refs/heads/main",
			]);
			await real({ ...command, env, args: ["bundle", "unbundle", incoming] });
			return real({ ...command, env, args: ["update-ref", "refs/heads/main", baseSha] });
		}
		return real(command);
	};
	const options: CodingGitSeedOptions = {
		journalRoot: root,
		signal: new AbortController().signal,
		runGit,
		assertAuthorized: vi.fn(async () => undefined),
		withRepositoryToken: async (_repository, use) => use("github_pat_fixture_token_1234567890"),
	};
	return { root, input, options, calls, git };
}
describe("trusted GitHub seed bundle broker", () => {
	it("resolves only the exact base ref in a clean broker process", async () => {
		const f = await fixture();
		const result = await resolveCloudCodingBase(f.input.repository, {
			...f.options,
			assertAuthorized: async () => undefined,
			runGit: async (command) => {
				if (command.args.includes("ls-remote")) {
					expect(command.args.slice(-2)).toEqual(["https://github.com/qorpera/example.git", "refs/heads/main"]);
					expect(command.env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/qorpera/example.git.extraHeader");
					return `${f.input.baseSha}\trefs/heads/main\n`;
				}
				if (!f.options.runGit) throw new Error("fixture missing");
				return f.options.runGit(command);
			},
		});
		expect(result).toBe(f.input.baseSha);
	});
	it("rejects another branch in base-resolution output", async () => {
		const f = await fixture();
		await expect(
			resolveCloudCodingBase(f.input.repository, {
				...f.options,
				assertAuthorized: async () => undefined,
				runGit: async (command) => {
					if (command.args.includes("ls-remote")) return `${f.input.baseSha}\trefs/heads/other\n`;
					if (!f.options.runGit) throw new Error("fixture missing");
					return f.options.runGit(command);
				},
			}),
		).rejects.toThrow("CODING_GIT_BASE_UNCONFIRMED");
	});
	it("fetches pinned base and emits a complete single worker-ref bundle without credentials or checkout", async () => {
		const f = await fixture();
		const result = await fetchCloudCodingSeed(f.input, f.options);
		expect(result.headSha).toBe(f.input.baseSha);
		expect(createHash("sha256").update(result.bundle).digest("hex")).toBe(result.bundleSha256);
		const bundle = join(f.root, "result.bundle");
		await writeFile(bundle, result.bundle);
		expect(await f.git("bundle", "list-heads", bundle)).toBe(
			`${f.input.baseSha} refs/heads/qorpera/coding/${f.input.workerId}`,
		);
		expect((await readFile(bundle)).includes(Buffer.from("github_pat_fixture"))).toBe(false);
		expect(f.calls.some((call) => call.args.includes("checkout"))).toBe(false);
		for (const call of f.calls) if (!call.args.includes("fetch")) expect(call.env.GIT_CONFIG_VALUE_0).toBeUndefined();
		expect((await readdir(f.root)).some((name) => name.startsWith(".git-seed-"))).toBe(false);
	});
	it("rejects a moved base instead of silently seeding a different commit", async () => {
		const f = await fixture();
		await expect(fetchCloudCodingSeed({ ...f.input, baseSha: "f".repeat(40) }, f.options)).rejects.toThrow(
			"BASE_CHANGED",
		);
	});
	it("fails before any Git process when authorization is revoked", async () => {
		const f = await fixture();
		f.options.assertAuthorized = async () => {
			throw new Error("revoked");
		};
		await expect(fetchCloudCodingSeed(f.input, f.options)).rejects.toThrow("AUTHORITY_UNAVAILABLE");
		expect(f.calls).toHaveLength(0);
	});
});
