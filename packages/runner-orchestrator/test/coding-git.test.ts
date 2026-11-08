import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CodingPushCarrier, CodingPushRefused } from "../src/coding-executor.ts";
import {
	type CodingBrokerGitCommand,
	type CodingBrokerGitRunner,
	type CodingGitPush,
	type CodingGitPushOptions,
	createCodingBrokerGitRunner,
	pushCloudCodingBundle,
} from "../src/coding-git.ts";
import { CodingSecretMask } from "../src/coding-secret-mask.ts";

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
	const put = async (stdin: string, ...args: string[]): Promise<string> => {
		const running = exec("/usr/bin/git", ["--git-dir", source, ...args], { cwd: root, env });
		running.child.stdin?.end(stdin);
		return (await running).stdout.trim();
	};
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
		noEffect = false,
		// Reads after a push that still show the branch's earlier head (a GitHub copy that has not seen the push yet).
		lag = 0,
		staleReads = 0,
		staleHead: string | null = null;
	const calls: CodingBrokerGitCommand[] = [];
	const runGit = vi.fn(async (command: CodingBrokerGitCommand): Promise<string> => {
		calls.push(command);
		if (command.args.includes("ls-remote")) {
			const shown = staleReads > 0 ? (staleReads--, staleHead) : remoteHead;
			return `${remoteBase}\trefs/heads/main\n${shown ? `${shown}\t${ref}\n` : ""}`;
		}
		if (command.args.includes("push")) {
			staleHead = remoteHead;
			staleReads = lag;
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
		confirmPausesMs: [1, 1, 1],
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
		put,
		setBase: (head: string) => {
			remoteBase = head;
		},
		setRemote: (head: string | null) => {
			remoteHead = head;
		},
		lagReads: (reads: number) => {
			lag = reads;
		},
		loseReply: (effect = true) => {
			loseReply = true;
			noEffect = !effect;
		},
	};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

// The push check (F3 5j-5 b). Made-up values only.
const secret = "made-up-canary-5j5b-push-value";
const spanning = "canary-left/canary-right";
const linux = process.platform === "linux";
const percent = (text: string): string =>
	[...Buffer.from(text)].map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");
/** A tree with `files` by path, and the folders they are in. */
async function tree(f: Fixture, files: Readonly<Record<string, string>>): Promise<string> {
	const folders = new Map<string, Record<string, string>>();
	const entries: string[] = [];
	for (const [path, contents] of Object.entries(files)) {
		const [name, ...rest] = path.split("/");
		if (rest.length > 0) folders.set(name, { ...folders.get(name), [rest.join("/")]: contents });
		else entries.push(`100644 blob ${await f.put(contents, "hash-object", "-w", "--stdin")}\t${name}\0`);
	}
	for (const [name, inner] of folders) entries.push(`040000 tree ${await tree(f, inner)}\t${name}\0`);
	return f.put(entries.join(""), "mktree", "-z");
}
async function commit(f: Fixture, parent: string, files: Readonly<Record<string, string>>, message: string) {
	return f.git("commit-tree", await tree(f, files), "-p", parent, "-m", message);
}
/** A complete bundle of the worker branch at `head`. */
async function bundled(f: Fixture, head: string): Promise<Buffer> {
	await f.git("update-ref", ref, head);
	const path = join(f.root, `${head}.bundle`);
	await f.git("bundle", "create", path, ref);
	return readFile(path);
}
/** Pushing `head` is refused, and nothing it says carries a value. */
async function refusal(f: Fixture, head: string, input: Partial<CodingGitPush> = {}): Promise<CodingPushRefused> {
	const error = await pushCloudCodingBundle(
		{ ...f.input, headSha: head, ...input },
		await bundled(f, head),
		f.options,
	).then(
		() => null,
		(error: unknown) => error,
	);
	expect(error).toBeInstanceOf(CodingPushRefused);
	for (const text of [String(error), (error as Error).stack, JSON.stringify(error)]) {
		expect(text).not.toContain(secret);
		expect(text).not.toContain(spanning);
	}
	return error as CodingPushRefused;
}
/** `git`, but what the check's `step` writes goes through `change` first, `size` bytes a write. A write that throws
 * fails the command, as the runner kills Git then. */
function rewritten(
	git: CodingBrokerGitRunner,
	step: "rev-list" | "cat-file",
	change: (bytes: Buffer) => Buffer,
	size = 7,
): CodingBrokerGitRunner {
	return async (command) => {
		const { output } = command;
		if (!output || !command.args.includes(step)) return git(command);
		const chunks: Buffer[] = [];
		await git({ ...command, output: { limit: output.limit, write: (chunk) => void chunks.push(chunk) } });
		const bytes = change(Buffer.concat(chunks));
		for (let at = 0; at < bytes.length; at += size) output.write(bytes.subarray(at, at + size));
		return "";
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
	it("reads the branch again while GitHub still shows its head from before the push", async () => {
		const f = await fixture();
		f.lagReads(2);
		expect(await pushCloudCodingBundle(f.input, f.bundle, f.options)).toEqual({ branch, headSha: f.input.headSha });
		expect(f.calls.filter((call) => call.args.includes("push"))).toHaveLength(1);
		// Before the push, then two stale reads and the one that shows the push.
		expect(f.calls.filter((call) => call.args.includes("ls-remote"))).toHaveLength(4);
	});
	it("gives up when the pushed branch never shows the push, and never pushes again", async () => {
		const f = await fixture();
		f.lagReads(10);
		await expect(pushCloudCodingBundle(f.input, f.bundle, f.options)).rejects.toThrow(
			/^CODING_GIT_RECONCILIATION_REQUIRED$/,
		);
		// One read before the push, then one per pause and a last one.
		expect(f.calls.filter((call) => call.args.includes("ls-remote"))).toHaveLength(5);
		// Once GitHub shows it, the same publication is confirmed without a second push.
		f.lagReads(0);
		expect(await pushCloudCodingBundle(f.input, f.bundle, f.options)).toEqual({ branch, headSha: f.input.headSha });
		expect(f.calls.filter((call) => call.args.includes("push"))).toHaveLength(1);
	});
	it("does not wait for a branch that moved to another head after the push", async () => {
		const f = await fixture();
		const other = "c".repeat(40);
		const runGit = f.options.runGit as CodingBrokerGitRunner;
		let pushed = false,
			readsAfter = 0;
		f.options.runGit = async (command) => {
			if (command.args.includes("push")) {
				pushed = true;
				return "ok\n";
			}
			if (pushed && command.args.includes("ls-remote")) {
				readsAfter++;
				return `${f.input.baseSha}\trefs/heads/main\n${other}\t${ref}\n`;
			}
			return runGit(command);
		};
		await expect(pushCloudCodingBundle(f.input, f.bundle, f.options)).rejects.toThrow(
			/^CODING_GIT_RECONCILIATION_REQUIRED$/,
		);
		expect(readsAfter).toBe(1);
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
	it("fetches a thin bundle's prerequisites before verify and a base tip it lacks after the checks", async () => {
		const f = await fixture(),
			path = join(f.root, "thin.bundle");
		// The base moved on without the worker.
		const tree = await f.git("rev-parse", `${f.input.baseSha}^{tree}`);
		const upstream = await f.git("commit-tree", tree, "-p", f.input.baseSha, "-m", "upstream");
		await f.git("push", "--quiet", join(f.root, "remote.git"), `${upstream}:refs/heads/main`);
		f.setBase(upstream);
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
		expect(fetches[1].args.slice(-7)).toEqual([...depthOne, `${upstream}:refs/qorpera/base`]);
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
	it("keeps the head's history whole when the base took or merged the worker's first push", async () => {
		for (const merged of [false, true]) {
			const f = await fixture(),
				remote = join(f.root, "remote.git"),
				path = join(f.root, "after-merge.bundle");
			// The base took the worker's first push (as is, or in a merge) and the
			// worker built on the base; the remote branch is still that first push.
			const tree = await f.git("rev-parse", `${f.input.headSha}^{tree}`);
			let base = f.input.headSha;
			if (merged) {
				const upstream = await f.git("commit-tree", tree, "-p", f.input.baseSha, "-m", "upstream");
				base = await f.git("commit-tree", tree, "-p", upstream, "-p", f.input.headSha, "-m", "merge");
			}
			const next = await f.git("commit-tree", tree, "-p", base, "-m", "after the merge");
			await f.git("update-ref", ref, next);
			await f.git("push", "--quiet", remote, `${base}:refs/heads/main`, `${f.input.headSha}:${ref}`);
			f.setBase(base);
			f.setRemote(f.input.headSha);
			await f.git("bundle", "create", path, ref, `^${f.input.baseSha}`);
			// The push is real here, from the broker's shallow repository, so Git's
			// own fast-forward check walks the head's history.
			const fake = f.options.runGit,
				local = `file://${remote}`;
			if (!fake) throw new Error("fixture missing");
			f.options.runGit = async (command) => {
				if (command.args.includes("push"))
					await exec(
						"/usr/bin/git",
						command.args.map((arg) => (arg === "https://github.com/qorpera/example.git" ? local : arg)),
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
			// The base tip came in the bundle, so it is not fetched (shallow) again.
			expect(f.calls.filter((call) => call.args.includes("fetch"))).toHaveLength(1);
			expect(await f.git("ls-remote", remote, ref)).toBe(`${next}\t${ref}`);
		}
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
describe("the push check against the session's secret values", () => {
	it("checks nothing when the session has no values", async () => {
		const f = await fixture();
		f.options.secrets = new CodingSecretMask();
		expect(await pushCloudCodingBundle(f.input, f.bundle, f.options)).toEqual({ branch, headSha: f.input.headSha });
		expect(f.calls.some((call) => call.output !== undefined || call.args.includes("--objects"))).toBe(false);
	});
	it.runIf(linux)("refuses a value anywhere the push adds it, and names only the masked path", async () => {
		const f = await fixture();
		f.options.secrets = new CodingSecretMask([secret, spanning]);
		const base = f.input.baseSha;
		const message = await commit(f, base, { "notes.txt": "clean\n" }, `notes for ${secret}`);
		const cases: [string, CodingPushCarrier][] = [
			[await commit(f, base, { "notes.txt": `token = ${secret}\n` }, "notes"), { kind: "file", path: "notes.txt" }],
			[
				await commit(f, base, { "a/b.txt": Buffer.from(`token: ${secret}`).toString("base64") }, "notes"),
				{ kind: "file", path: "a/b.txt" },
			],
			[
				await commit(f, base, { "notes.txt": `https://example.invalid/?token=${percent(secret)}` }, "notes"),
				{ kind: "file", path: "notes.txt" },
			],
			// A folder's names are read before the files in it.
			[await commit(f, base, { [`${secret}.txt`]: "clean\n" }, "notes"), { kind: "folder", path: "" }],
			[await commit(f, base, { [`keys/${secret}.txt`]: "clean\n" }, "notes"), { kind: "folder", path: "keys" }],
			// No one name carries a value split by a folder, but the path the refusal shows would.
			[
				await commit(f, base, { [`${spanning}/notes.txt`]: `${secret}\n` }, "notes"),
				{ kind: "file", path: "***/notes.txt" },
			],
			[message, { kind: "commit", sha: message.slice(0, 12) }],
			// Committed, then removed: the history still carries it.
			[
				await commit(f, await commit(f, base, { "notes.txt": `${secret}\n` }, "add"), {}, "remove"),
				{ kind: "file", path: "notes.txt" },
			],
		];
		for (const [head, carrier] of cases) {
			const error = await refusal(f, head);
			expect(error.message).toBe("CODING_PUSH_CARRIES_SECRET");
			expect(error.carrier).toEqual(carrier);
		}
		expect(f.calls.some((call) => call.args.includes("push"))).toBe(false);
		expect((await readdir(f.root)).some((name) => name.endsWith(".git-push.json"))).toBe(false);
		for (const call of f.calls) expect(JSON.stringify(call.args)).not.toContain(secret);
		// A near miss is not a value.
		const clean = await commit(f, base, { "notes.txt": `${secret.slice(0, -1)}\n` }, secret.slice(1));
		expect(await pushCloudCodingBundle({ ...f.input, headSha: clean }, await bundled(f, clean), f.options)).toEqual({
			branch,
			headSha: clean,
		});
	});
	it.runIf(linux)("checks only what the push adds to the base and the branch head the remote showed", async () => {
		const f = await fixture();
		f.options.secrets = new CodingSecretMask([secret]);
		// The value was on the repository before it was a secret: in the base, and in the branch's last push.
		const base = await commit(f, f.input.baseSha, { "old.txt": `${secret}\n` }, `old ${secret}`);
		const last = await commit(f, base, { "old.txt": `${secret}\n`, "last.txt": `${secret}\n` }, `last ${secret}`);
		const head = await commit(
			f,
			last,
			{ "old.txt": `${secret}\n`, "last.txt": `${secret}\n`, "src/new.txt": "clean\n" },
			"new",
		);
		f.setRemote(last);
		const input = { ...f.input, baseSha: base, headSha: head, expectedRemoteHeadSha: last };
		expect(await pushCloudCodingBundle(input, await bundled(f, head), f.options)).toEqual({ branch, headSha: head });
		const checked = f.calls.filter((call) => call.output !== undefined);
		expect(
			checked.map((call) => call.args.slice(call.args.findIndex((arg) => arg === "rev-list" || arg === "cat-file"))),
		).toEqual([
			["rev-list", "--objects", head, `^${base}`, `^${last}`],
			["cat-file", "--batch"],
		]);
		expect(checked.map((call) => [call.long, call.network, call.output?.limit])).toEqual([
			[true, false, 16 * 1024 ** 2],
			[true, false, 256 * 1024 ** 2],
		]);
		expect(checked[0].input).toBeUndefined();
		// The new commit, its top folder, src and src/new.txt.
		expect(
			Buffer.from(checked[1].input as Uint8Array)
				.toString()
				.split("\n"),
		).toHaveLength(5);
		// A file the work changes is a new file, and carries the value again.
		const next = await commit(
			f,
			head,
			{ "old.txt": `${secret}\nchanged\n`, "last.txt": `${secret}\n`, "src/new.txt": "clean\n" },
			"change",
		);
		const error = await refusal(f, next, { baseSha: base, expectedRemoteHeadSha: head });
		expect(error.carrier).toEqual({ kind: "file", path: "old.txt" });
	});
	it.runIf(linux)("reads the check's output however Git splits it, and refuses output it doesn't expect", async () => {
		const f = await fixture();
		f.options.secrets = new CodingSecretMask([secret]);
		const git = f.options.runGit as CodingBrokerGitRunner;
		const base = f.input.baseSha;
		const carrying = await commit(f, base, { "a.txt": "clean\n", "b/c.txt": `${secret}\n` }, "carrying");
		// Both steps' output, a byte at a time.
		const bytewise = rewritten(
			rewritten(git, "rev-list", (bytes) => bytes, 1),
			"cat-file",
			(bytes) => bytes,
			1,
		);
		f.options.runGit = bytewise;
		expect((await refusal(f, carrying)).carrier).toEqual({ kind: "file", path: "b/c.txt" });
		const head = await commit(f, base, { "a.txt": "clean\n", "b/c.txt": "clean\n" }, "clean");
		const many = Array.from({ length: 100_001 }, (_, index) => `${index.toString(16).padStart(40, "0")}\n`).join("");
		const latin1 = (bytes: Buffer, from: string, to: string) =>
			Buffer.from(bytes.toString("latin1").replace(from, to), "latin1");
		const surprises: [CodingBrokerGitRunner, string][] = [
			[rewritten(git, "rev-list", (bytes) => bytes.subarray(0, -1)), "a line without its newline"],
			[rewritten(git, "rev-list", (bytes) => Buffer.concat([Buffer.from("abc\n"), bytes])), "a short name"],
			[rewritten(git, "rev-list", (bytes) => latin1(bytes, " ", "\t")), "another separator"],
			[rewritten(git, "rev-list", (bytes) => Buffer.concat([bytes, bytes.subarray(0, 41)])), "an object twice"],
			[rewritten(git, "rev-list", () => Buffer.from(many), 65536), "over the object bound"],
			[rewritten(git, "cat-file", (bytes) => latin1(bytes, " commit ", " tag ")), "a tag"],
			[rewritten(git, "cat-file", () => Buffer.from(`${head} missing\n`)), "a missing object"],
			[
				rewritten(git, "cat-file", (bytes) => Buffer.concat([Buffer.from("f".repeat(40)), bytes.subarray(40)])),
				"another object",
			],
			[rewritten(git, "cat-file", (bytes) => bytes.subarray(0, -2)), "an object cut short"],
			[rewritten(git, "cat-file", (bytes) => bytes.subarray(0, -1)), "no last newline"],
			[rewritten(git, "cat-file", (bytes) => Buffer.concat([bytes, bytes])), "more than asked"],
			[rewritten(git, "cat-file", () => Buffer.alloc(0)), "nothing"],
			[
				async (command) => {
					if (command.output && command.args.includes("cat-file")) throw new Error(`killed ${secret}`);
					return git(command);
				},
				"a failed step",
			],
		];
		for (const [runGit, surprise] of surprises) {
			f.options.runGit = runGit;
			const error = await refusal(f, head);
			expect([surprise, error.message, error.carrier]).toEqual([surprise, "CODING_PUSH_UNCHECKED", null]);
		}
		// The first push and the cat-file surprises read objects: a surprise in the list stops the check before.
		expect(f.calls.filter((call) => call.args.includes("cat-file") && call.output !== undefined)).toHaveLength(8);
		f.options.runGit = bytewise;
		expect(await pushCloudCodingBundle({ ...f.input, headSha: head }, await bundled(f, head), f.options)).toEqual({
			branch,
			headSha: head,
		});
	});
	it.runIf(linux)("keeps a lost authority's or a cancel's own error when a check step fails", async () => {
		const f = await fixture();
		f.options.secrets = new CodingSecretMask([secret]);
		const git = f.options.runGit as CodingBrokerGitRunner;
		const head = await commit(f, f.input.baseSha, { "a.txt": "clean\n" }, "clean");
		let revoked = false;
		f.options.assertAuthorized = async () => {
			if (revoked) throw new Error("revoked");
		};
		f.options.runGit = async (command) => {
			if (!command.output || !command.args.includes("cat-file")) return git(command);
			revoked = true;
			throw new Error("killed");
		};
		await expect(
			pushCloudCodingBundle({ ...f.input, headSha: head }, await bundled(f, head), f.options),
		).rejects.toThrow(/^CODING_GIT_AUTHORITY_UNAVAILABLE$/);
		revoked = false;
		const controller = new AbortController();
		f.options.signal = controller.signal;
		f.options.runGit = async (command) => {
			if (!command.output || !command.args.includes("rev-list")) return git(command);
			controller.abort();
			throw new Error("killed");
		};
		await expect(
			pushCloudCodingBundle({ ...f.input, headSha: head }, await bundled(f, head), f.options),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(f.calls.some((call) => call.args.includes("push"))).toBe(false);
	});
});
