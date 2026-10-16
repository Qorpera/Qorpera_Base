import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CodingBrokerGitCommand,
	type CodingGitPush,
	type CodingGitPushOptions,
	createCodingBrokerGitRunner,
	pushCloudCodingBundle,
} from "../src/coding-git.ts";

const exec = promisify(execFile);
const workerId = "00000000-0000-4000-8000-000000000001";
const branch = `qorpera/coding/${workerId}`,
	ref = `refs/heads/${branch}`;
const token = "github_pat_scoped_test_token_123456789";
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "coding-git-test-")));
	roots.push(root);
	const env = {
		PATH: "/usr/bin:/bin",
		HOME: root,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@example.invalid",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@example.invalid",
	};
	const source = join(root, "source.git");
	const git = async (...args: string[]): Promise<string> =>
		(await exec("/usr/bin/git", ["--git-dir", source, ...args], { cwd: root, env })).stdout.trim();
	await exec("/usr/bin/git", ["init", "--bare", "--template=", source], { cwd: root, env });
	const tree = await git("hash-object", "-w", "-t", "tree", "/dev/null");
	const baseSha = await git("commit-tree", tree, "-m", "base");
	const headSha = await git("commit-tree", tree, "-p", baseSha, "-m", "change");
	await git("update-ref", ref, headSha);
	const bundlePath = join(root, "export.bundle");
	await git("bundle", "create", bundlePath, ref);
	const bundle = await readFile(bundlePath);
	// The fetchable "GitHub" side holds only the base, as main.
	const remote = join(root, "remote.git");
	await exec("/usr/bin/git", ["init", "--bare", "--template=", remote], { cwd: root, env });
	await git("push", "--quiet", remote, `${baseSha}:refs/heads/main`);
	const input: CodingGitPush = {
		repository: { host: "github.com", owner: "qorpera", name: "example", baseBranch: "main" },
		workerId,
		headSha,
		baseSha,
		expectedRemoteHeadSha: null,
	};
	let remoteBase = baseSha;
	let remoteHead: string | null = null,
		loseReply = false,
		noEffect = false;
	const calls: CodingBrokerGitCommand[] = [];
	const runGit = vi.fn(async (command: CodingBrokerGitCommand): Promise<string> => {
		calls.push(command);
		if (command.args.includes("ls-remote"))
			return `${remoteBase}\trefs/heads/main\n${remoteHead ? `${remoteHead}\t${ref}\n` : ""}`;
		if (command.args.includes("push")) {
			if (!noEffect) remoteHead = command.args.at(-1)?.split(":")[0] ?? null;
			if (loseReply) throw new Error(`untrusted stderr ${token}`);
			return "ok\n";
		}
		if (command.args.includes("fetch"))
			return (
				await exec(
					"/usr/bin/git",
					command.args.map((arg) => (arg === "https://github.com/qorpera/example.git" ? `file://${remote}` : arg)),
					{ cwd: command.cwd, env: { ...command.env, GIT_ALLOW_PROTOCOL: "file" }, signal: command.signal },
				)
			).stdout;
		if (process.platform === "linux")
			return createCodingBrokerGitRunner({ bubblewrapPath: process.env.QORPERA_TEST_BWRAP })(command);
		// Supplemental macOS fixture executes Git directly; production transport
		// is deliberately Linux-only and exercised by the isolated node run.
		return (
			await exec("/usr/bin/git", [...command.args], {
				cwd: command.cwd,
				env: command.env,
				signal: command.signal,
				maxBuffer: 65536,
				timeout: 60000,
			})
		).stdout;
	});
	const options: CodingGitPushOptions = {
		journalRoot: root,
		signal: new AbortController().signal,
		runGit,
		assertAuthorized: vi.fn(async () => undefined),
		withRepositoryToken: async (repository, use) => {
			expect(repository).toEqual(input.repository);
			return use(token);
		},
	};
	return {
		root,
		input,
		bundle,
		options,
		calls,
		git,
		setBase: (head: string) => {
			remoteBase = head;
		},
		setRemote: (head: string | null) => {
			remoteHead = head;
		},
		loseReply: (effect = true) => {
			loseReply = true;
			noEffect = !effect;
		},
	};
}
describe("credential-isolated coding Git publication", () => {
	it("validates a real complete bundle in a bare broker repo and pushes only the fixed branch without force", async () => {
		const f = await fixture();
		expect(await pushCloudCodingBundle(f.input, f.bundle, f.options)).toEqual({ branch, headSha: f.input.headSha });
		const pushes = f.calls.filter((call) => call.args.includes("push"));
		expect(pushes).toHaveLength(1);
		expect(pushes[0].args.slice(-6)).toEqual([
			"push",
			"--porcelain",
			"--no-verify",
			"--recurse-submodules=no",
			"https://github.com/qorpera/example.git",
			`${f.input.headSha}:${ref}`,
		]);
		expect(f.calls.some((call) => call.args.includes("checkout"))).toBe(false);
		expect(f.calls.some((call) => call.args.includes("fetch"))).toBe(false);
		expect(f.calls.some((call) => call.args.includes("fsck"))).toBe(true);
		for (const command of f.calls) {
			expect(command.args.join(" ")).not.toContain(token);
			expect(command.args).toContain("core.hooksPath=/dev/null");
			expect(command.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
			expect(command.env.GIT_ALLOW_PROTOCOL).toBe("https");
			if (command.args.includes("push") || command.args.includes("ls-remote")) {
				expect(command.env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/qorpera/example.git.extraHeader");
			} else expect(command.env.GIT_CONFIG_VALUE_0).toBeUndefined();
		}
		const journal = (await readdir(f.root)).filter((name) => name.endsWith(".json"));
		for (const name of journal) expect(await readFile(join(f.root, name), "utf8")).not.toContain(token);
		expect((await readdir(f.root)).some((name) => name.startsWith(".git-broker-"))).toBe(false);
	});
	it("reconciles a lost successful push with ls-remote and never pushes twice", async () => {
		const f = await fixture();
		f.loseReply();
		await expect(pushCloudCodingBundle(f.input, f.bundle, f.options)).rejects.toThrow(
			/^CODING_GIT_OPERATION_UNCONFIRMED$/,
		);
		expect(await pushCloudCodingBundle(f.input, f.bundle, f.options)).toEqual({ branch, headSha: f.input.headSha });
		expect(f.calls.filter((call) => call.args.includes("push"))).toHaveLength(1);
	});
	it("retains an ambiguous nonobserved push even when remote remains unchanged", async () => {
		const f = await fixture();
		f.loseReply(false);
		await expect(pushCloudCodingBundle(f.input, f.bundle, f.options)).rejects.toThrow();
		await expect(pushCloudCodingBundle(f.input, f.bundle, f.options)).rejects.toThrow(
			"CODING_GIT_RECONCILIATION_REQUIRED",
		);
		expect(f.calls.filter((call) => call.args.includes("push"))).toHaveLength(1);
	});
	it("one concurrent publication dispatches a push", async () => {
		const f = await fixture();
		const result = await Promise.allSettled([
			pushCloudCodingBundle(f.input, f.bundle, f.options),
			pushCloudCodingBundle(f.input, f.bundle, f.options),
		]);
		expect(result.some((entry) => entry.status === "fulfilled")).toBe(true);
		expect(f.calls.filter((call) => call.args.includes("push"))).toHaveLength(1);
	});
	it("refuses a changed worker branch before importing objects", async () => {
		const f = await fixture();
		f.setRemote("a".repeat(40));
		await expect(pushCloudCodingBundle(f.input, f.bundle, f.options)).rejects.toThrow("CODING_GIT_HEAD_CHANGED");
		expect(f.calls.some((call) => call.args.includes("unbundle"))).toBe(false);
	});
	it("allows upstream base advancement but refuses pinned base and repository retargeting", async () => {
		const f = await fixture();
		f.setBase("b".repeat(40));
		await pushCloudCodingBundle(f.input, f.bundle, f.options);
		await expect(pushCloudCodingBundle({ ...f.input, baseSha: "a".repeat(40) }, f.bundle, f.options)).rejects.toThrow(
			"CODING_GIT_TARGET_CONFLICT",
		);
		await expect(
			pushCloudCodingBundle(
				{ ...f.input, repository: { ...f.input.repository, name: "other" } },
				f.bundle,
				f.options,
			),
		).rejects.toThrow("CODING_GIT_TARGET_CONFLICT");
	});
	it("rejects extra bundle refs and arbitrary command arguments", async () => {
		const f = await fixture();
		await f.git("update-ref", "refs/heads/extra", f.input.headSha);
		const path = join(f.root, "extra.bundle");
		await f.git("bundle", "create", path, "--all");
		await expect(pushCloudCodingBundle(f.input, await readFile(path), f.options)).rejects.toThrow(
			"CODING_GIT_BUNDLE_TARGET_MISMATCH",
		);
		await expect(
			pushCloudCodingBundle({ ...f.input, headSha: "--upload-pack=evil" }, f.bundle, f.options),
		).rejects.toThrow("INVALID_CODING_GIT_PUSH");
		expect(f.calls.some((call) => call.args.includes("push"))).toBe(false);
	});
	it("fails closed when scope is revoked and never requests a token", async () => {
		const f = await fixture();
		f.options.assertAuthorized = async () => {
			throw new Error("revoked");
		};
		await expect(pushCloudCodingBundle(f.input, f.bundle, f.options)).rejects.toThrow(
			"CODING_GIT_AUTHORITY_UNAVAILABLE",
		);
		expect(f.calls).toHaveLength(0);
	});
	it("publishes a followup only as a descendant of the exact previous worker head", async () => {
		const f = await fixture();
		await pushCloudCodingBundle(f.input, f.bundle, f.options);
		const tree = await f.git("rev-parse", `${f.input.headSha}^{tree}`);
		const next = await f.git("commit-tree", tree, "-p", f.input.headSha, "-m", "followup");
		await f.git("update-ref", ref, next);
		const path = join(f.root, "next.bundle");
		await f.git("bundle", "create", path, ref);
		expect(
			await pushCloudCodingBundle(
				{ ...f.input, headSha: next, expectedRemoteHeadSha: f.input.headSha },
				await readFile(path),
				f.options,
			),
		).toEqual({ branch, headSha: next });
		expect(f.calls.filter((call) => call.args.includes("push"))).toHaveLength(2);
	});
	it("fetches a thin bundle's prerequisites before verify and the base tip after the checks", async () => {
		const f = await fixture(),
			path = join(f.root, "thin.bundle");
		await f.git("bundle", "create", path, ref, `^${f.input.baseSha}`);
		expect(await pushCloudCodingBundle(f.input, await readFile(path), f.options)).toEqual({
			branch,
			headSha: f.input.headSha,
		});
		const fetches = f.calls.filter((call) => call.args.includes("fetch"));
		expect(fetches).toHaveLength(2);
		// The base's history may be large: both fetches get a seed's limits.
		expect(f.calls.filter((call) => call.long)).toEqual(fetches);
		const depthOne = [
			"fetch",
			"--depth=1",
			"--no-tags",
			"--no-recurse-submodules",
			"--no-write-fetch-head",
			"https://github.com/qorpera/example.git",
		];
		expect(fetches[0].args.slice(-7)).toEqual([...depthOne, `${f.input.baseSha}:refs/qorpera/prerequisite/0`]);
		expect(fetches[1].args.slice(-7)).toEqual([...depthOne, "refs/heads/main:refs/qorpera/base"]);
		for (const call of fetches) {
			expect(call.network).toBe(true);
			expect(call.env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/qorpera/example.git.extraHeader");
			expect(call.env.GIT_ALLOW_PROTOCOL).toBe("https");
		}
		const at = (word: string) => f.calls.findIndex((call) => call.args.includes(word));
		expect(at("list-heads")).toBeLessThan(f.calls.indexOf(fetches[0]));
		expect(f.calls.indexOf(fetches[0])).toBeLessThan(at("verify"));
		expect(at("merge-base")).toBeLessThan(f.calls.indexOf(fetches[1]));
		expect(f.calls.indexOf(fetches[1])).toBeLessThan(at("push"));
		expect(f.calls.filter((call) => call.args.includes("push"))).toHaveLength(1);
	});
	it("checks the head's history before it fetches a base tip that took a worker commit", async () => {
		const f = await fixture(),
			remote = join(f.root, "remote.git"),
			path = join(f.root, "after-merge.bundle");
		// The base took the worker's first push, and the worker built on it.
		const tree = await f.git("rev-parse", `${f.input.headSha}^{tree}`);
		const next = await f.git("commit-tree", tree, "-p", f.input.headSha, "-m", "after the merge");
		await f.git("update-ref", ref, next);
		await f.git("push", "--quiet", remote, `${f.input.headSha}:refs/heads/main`, `${f.input.headSha}:${ref}`);
		f.setBase(f.input.headSha);
		f.setRemote(f.input.headSha);
		await f.git("bundle", "create", path, ref, `^${f.input.baseSha}`);
		// The push is real here, from the broker's shallow repository.
		const fake = f.options.runGit;
		if (!fake) throw new Error("fixture missing");
		f.options.runGit = async (command) => {
			if (command.args.includes("push"))
				await exec(
					"/usr/bin/git",
					command.args.map((arg) => (arg === "https://github.com/qorpera/example.git" ? `file://${remote}` : arg)),
					{ cwd: command.cwd, env: { ...command.env, GIT_ALLOW_PROTOCOL: "file" }, signal: command.signal },
				);
			return fake(command);
		};
		expect(
			await pushCloudCodingBundle(
				{ ...f.input, headSha: next, expectedRemoteHeadSha: f.input.headSha },
				await readFile(path),
				f.options,
			),
		).toEqual({ branch, headSha: next });
		expect(await f.git("ls-remote", remote, ref)).toBe(`${next}\t${ref}`);
	});
	it("refuses a thin bundle whose prerequisite the repository does not have", async () => {
		const f = await fixture(),
			path = join(f.root, "elsewhere.bundle");
		const tree = await f.git("rev-parse", `${f.input.headSha}^{tree}`);
		const local = await f.git("commit-tree", tree, "-p", f.input.baseSha, "-m", "local only");
		const next = await f.git("commit-tree", tree, "-p", local, "-m", "on local");
		await f.git("update-ref", ref, next);
		await f.git("bundle", "create", path, ref, `^${local}`);
		await expect(
			pushCloudCodingBundle({ ...f.input, headSha: next }, await readFile(path), f.options),
		).rejects.toThrow(/^CODING_GIT_OPERATION_UNCONFIRMED$/);
		expect(f.calls.some((call) => call.args.includes("fetch"))).toBe(true);
		expect(f.calls.some((call) => call.args.includes("unbundle"))).toBe(false);
		expect(f.calls.some((call) => call.args.includes("push"))).toBe(false);
	});
	it("refuses malformed or too many prerequisites before any Git command", async () => {
		const f = await fixture();
		const header = (lines: string[]) =>
			Buffer.from(`# v2 git bundle\n${lines.join("")}${f.input.headSha} ${ref}\n\nPACK`, "latin1");
		const many = Array.from({ length: 65 }, (_, index) => `-${index.toString(16).padStart(40, "0")} c\n`);
		for (const bundle of [header(["-xyz\n"]), header([`-${f.input.baseSha}x\n`]), header(many)])
			await expect(pushCloudCodingBundle(f.input, bundle, f.options)).rejects.toThrow("INVALID_CODING_GIT_PUSH");
		expect(f.calls).toHaveLength(0);
	});
	it("cannot change the next head for an already claimed branch predecessor", async () => {
		const f = await fixture();
		f.loseReply(false);
		await expect(pushCloudCodingBundle(f.input, f.bundle, f.options)).rejects.toThrow();
		await expect(pushCloudCodingBundle({ ...f.input, headSha: "f".repeat(40) }, f.bundle, f.options)).rejects.toThrow(
			"CODING_GIT_PUSH_CONFLICT",
		);
		expect(f.calls.filter((call) => call.args.includes("push"))).toHaveLength(1);
	});
	it("does not forward real Git failure output", async () => {
		const f = await fixture();
		await expect(pushCloudCodingBundle(f.input, Buffer.from("not a bundle"), f.options)).rejects.toThrow(
			/^CODING_GIT_OPERATION_UNCONFIRMED$/,
		);
		expect(f.calls.some((call) => call.args.includes("push"))).toBe(false);
	});
});
