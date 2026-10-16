import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, open, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type CloudCodingRepository, parseCloudCodingRepository } from "@qorpera/contracts";
import { type CodingGitSandboxOptions, codingGitSandboxPlan, codingGitSocketFilter } from "./coding-git-sandbox.ts";
import { checkDirectory, code, publish, readRecord } from "./lxd-office-journal-files.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const MAX_BUNDLE = 64 * 1024 ** 2;
const MAX_PREREQUISITES = 64;

/** The `-<sha>` prerequisite lines of a v2/v3 bundle header. Anything that is
 * not a bundle yields none, so Git itself refuses the bytes. */
function bundlePrerequisites(bytes: Buffer): string[] {
	const signature = bytes.subarray(0, 16).toString("latin1");
	if (signature !== "# v2 git bundle\n" && signature !== "# v3 git bundle\n") return [];
	const end = bytes.indexOf("\n\n");
	if (end < 0) return [];
	const found = new Set<string>();
	for (const line of bytes.subarray(16, end).toString("latin1").split("\n")) {
		if (!line.startsWith("-")) continue;
		const sha = line.slice(1, 41);
		if (!SHA.test(sha) || (line.length > 41 && line[41] !== " ")) throw new Error("INVALID_CODING_GIT_PUSH");
		found.add(sha);
	}
	if (found.size > MAX_PREREQUISITES) throw new Error("INVALID_CODING_GIT_PUSH");
	return [...found];
}

export interface CodingGitPush {
	repository: CloudCodingRepository;
	workerId: string;
	headSha: string;
	baseSha: string;
	expectedRemoteHeadSha: string | null;
}
export interface CodingBrokerGitCommand {
	readonly cwd: string;
	readonly scratchRoot: string;
	readonly network: boolean;
	readonly args: readonly string[];
	/** Trusted broker process environment. Contains a scoped HTTP header only
	 * for a network command; never persist, log or forward it into the VM. */
	readonly env: Readonly<Record<string, string>>;
	readonly signal: AbortSignal;
	/** A whole-repository step (a seed's fetch, fsck or bundle, a push's two
	 * fetches): 240 s of CPU and 300 s in all instead of 30 s and 60 s. */
	readonly long?: boolean;
}
export type CodingBrokerGitRunner = (command: CodingBrokerGitCommand) => Promise<string>;
export interface CodingGitPushOptions {
	/** Existing private persistent root; deployment must enforce disk quota
	 * and service memory limits when importing compressed untrusted objects. */
	journalRoot: string;
	signal: AbortSignal;
	assertAuthorized(input: Readonly<CodingGitPush>, signal: AbortSignal): Promise<void>;
	withRepositoryToken<T>(
		repository: CloudCodingRepository,
		use: (token: string) => Promise<T>,
		signal: AbortSignal,
	): Promise<T>;
	/** Trusted transport injection for tests; production uses mandatory Linux namespace isolation + prlimit + git. */
	runGit?: CodingBrokerGitRunner;
}

/** Closed process transport: no shell, inherited environment, error body or
 * unbounded output. Git descendants are killed together on timeout/lease loss. */
export function createCodingBrokerGitRunner(options: CodingGitSandboxOptions = {}): CodingBrokerGitRunner {
	return async ({ cwd, scratchRoot, network, args, env, signal, long = false }) => {
		signal.throwIfAborted();
		if (process.platform !== "linux" || process.getuid?.() === 0)
			throw new Error("CODING_GIT_BROKER_REQUIRES_UNPRIVILEGED_LINUX");
		const sandbox = await codingGitSandboxPlan({ cwd, scratchRoot, network }, options);
		if (
			env.HOME !== scratchRoot ||
			env.XDG_CONFIG_HOME !== scratchRoot ||
			(!network && Object.keys(env).some((key) => key.startsWith("GIT_CONFIG_VALUE_")))
		)
			throw new Error("CODING_GIT_SANDBOX_ENV_INVALID");
		const filterPath = join(scratchRoot, `.seccomp-${randomUUID()}`);
		await writeFile(filterPath, codingGitSocketFilter(), { flag: "wx", mode: 0o600 });
		const filter = await open(filterPath, "r");
		try {
			return await new Promise<string>((resolve, reject) => {
				const child = spawn(
					"/usr/bin/prlimit",
					[
						"--as=1073741824",
						long ? "--cpu=240" : "--cpu=30",
						"--fsize=268435456",
						"--nofile=64",
						"--nproc=512",
						"--core=0",
						"--",
						sandbox.executable,
						...sandbox.args,
						"/usr/bin/git",
						...args,
					],
					{
						cwd,
						env: { ...env },
						shell: false,
						detached: true,
						stdio: ["ignore", "pipe", "pipe", filter.fd],
					},
				);
				const chunks: Buffer[] = [];
				let bytes = 0,
					failed = false;
				const kill = (): void => {
					failed = true;
					try {
						if (child.pid) process.kill(-child.pid, "SIGKILL");
					} catch {
						child.kill("SIGKILL");
					}
				};
				const checked = AbortSignal.any([signal, AbortSignal.timeout(long ? 300_000 : 60_000)]);
				checked.addEventListener("abort", kill, { once: true });
				if (checked.aborted) kill();
				child.stdout?.on("data", (value: Buffer) => {
					bytes += value.length;
					if (bytes > 65536) kill();
					else chunks.push(value);
				});
				child.stderr?.on("data", (value: Buffer) => {
					bytes += value.length;
					if (bytes > 65536) kill();
				});
				child.once("error", () => {
					checked.removeEventListener("abort", kill);
					reject(new Error("CODING_GIT_PROCESS_UNCONFIRMED"));
				});
				child.once("close", (status) => {
					checked.removeEventListener("abort", kill);
					if (failed || status !== 0) reject(new Error("CODING_GIT_PROCESS_UNCONFIRMED"));
					else resolve(Buffer.concat(chunks).toString("utf8"));
				});
			});
		} finally {
			await filter.close();
			await unlink(filterPath);
		}
	};
}

export const runCodingBrokerGit = createCodingBrokerGitRunner();

/** Publish one bundle into the worker's fixed GitHub branch. Objects are
 * imported into a new bare broker repository; no worktree, repository config,
 * hooks, filters, submodules or model code execute in the token lane. A thin
 * bundle's prerequisites are fetched from the repository at depth 1 before it
 * is verified, and the base branch tip, when the bundle did not bring it, after
 * the checks, so the push sends only new objects.
 * The caller holds exclusive branch publication authority through draft PR
 * creation. An uncertain push is observed with ls-remote and never reissued. */
export async function pushCloudCodingBundle(
	value: CodingGitPush,
	bundle: Uint8Array,
	options: CodingGitPushOptions,
): Promise<{ branch: string; headSha: string }> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join() !== "baseSha,expectedRemoteHeadSha,headSha,repository,workerId" ||
		typeof value.workerId !== "string" ||
		!UUID.test(value.workerId) ||
		![value.headSha, value.baseSha].every((sha) => typeof sha === "string" && SHA.test(sha)) ||
		(value.expectedRemoteHeadSha !== null &&
			(typeof value.expectedRemoteHeadSha !== "string" || !SHA.test(value.expectedRemoteHeadSha))) ||
		!(bundle instanceof Uint8Array) ||
		bundle.byteLength < 1 ||
		bundle.byteLength > MAX_BUNDLE
	)
		throw new Error("INVALID_CODING_GIT_PUSH");
	const input = Object.freeze({ ...value, repository: parseCloudCodingRepository(value.repository) });
	const bytes = Buffer.from(bundle);
	const prerequisites = bundlePrerequisites(bytes);
	const branch = `qorpera/coding/${input.workerId}`,
		ref = `refs/heads/${branch}`,
		baseRef = `refs/heads/${input.repository.baseBranch}`;
	if (branch === input.repository.baseBranch) throw new Error("INVALID_CODING_GIT_PUSH");
	const remote = `https://github.com/${input.repository.owner}/${input.repository.name}.git`;
	const authorize = async (): Promise<void> => {
		options.signal.throwIfAborted();
		try {
			await options.assertAuthorized(input, options.signal);
		} catch {
			throw new Error("CODING_GIT_AUTHORITY_UNAVAILABLE");
		}
		options.signal.throwIfAborted();
	};
	await authorize();
	await checkDirectory(options.journalRoot);
	const target = {
		schema: "qorpera.coding-git-target/v2",
		baseSha: input.baseSha,
		workerId: input.workerId,
		repository: input.repository,
		branch,
	};
	const targetName = `${input.workerId}.git-target.json`;
	await publish(options.journalRoot, targetName, Buffer.from(JSON.stringify(target)));
	if (!isDeepStrictEqual((await readRecord(join(options.journalRoot, targetName))).value, target))
		throw new Error("CODING_GIT_TARGET_CONFLICT");
	const claim = {
		...target,
		headSha: input.headSha,
		baseSha: input.baseSha,
		expectedRemoteHeadSha: input.expectedRemoteHeadSha,
		bundleSha256: createHash("sha256").update(bytes).digest("hex"),
	};
	const claimName = `${input.workerId}.${input.expectedRemoteHeadSha ?? "unborn"}.git-push.json`;
	let claimed = false;
	try {
		const saved = await readRecord(join(options.journalRoot, claimName));
		if (!isDeepStrictEqual(saved.value, claim)) throw new Error("CODING_GIT_PUSH_CONFLICT");
		claimed = true;
	} catch (error) {
		if (!code(error, "ENOENT")) throw error;
	}
	const scratch = await mkdtemp(join(options.journalRoot, ".git-broker-"));
	try {
		await checkDirectory(scratch);
		const cwd = join(scratch, "repo.git"),
			bundlePath = join(scratch, "input.bundle");
		await writeFile(bundlePath, bytes, { flag: "wx", mode: 0o600 });
		const baseEnv: Record<string, string> = {
			PATH: "/usr/bin:/bin",
			HOME: scratch,
			XDG_CONFIG_HOME: scratch,
			LANG: "C",
			LC_ALL: "C",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_TERMINAL_PROMPT: "0",
			GIT_ASKPASS: "/bin/false",
			GIT_NO_REPLACE_OBJECTS: "1",
			GIT_ALLOW_PROTOCOL: "https",
			GIT_OPTIONAL_LOCKS: "0",
		};
		const configs = [
			"core.hooksPath=/dev/null",
			"credential.helper=",
			"credential.interactive=false",
			"http.followRedirects=false",
			"http.sslVerify=true",
			"protocol.allow=never",
			"protocol.https.allow=always",
			"submodule.recurse=false",
			"fetch.recurseSubmodules=false",
			"fetch.writeCommitGraph=false",
			"maintenance.auto=false",
			"gc.auto=0",
			"transfer.fsckObjects=true",
			"fetch.fsckObjects=true",
			"receive.fsckObjects=true",
		];
		const prefix = ["--no-replace-objects", ...configs.flatMap((config) => ["-c", config])];
		const run = async (args: string[], network = false, directory = cwd, long = false): Promise<string> => {
			await authorize();
			const invoke = async (token?: string): Promise<string> => {
				await authorize();
				const env = { ...baseEnv };
				if (token !== undefined) {
					if (!/^[A-Za-z0-9_]{20,512}$/.test(token)) throw new Error("CODING_GIT_CREDENTIAL_UNAVAILABLE");
					env.GIT_CONFIG_COUNT = "1";
					env.GIT_CONFIG_KEY_0 = `http.${remote}.extraHeader`;
					env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
				}
				const output = await (options.runGit ?? runCodingBrokerGit)({
					cwd: directory,
					scratchRoot: scratch,
					network,
					args: [...prefix, ...args],
					env,
					signal: options.signal,
					...(long ? { long } : {}),
				});
				await authorize();
				return output;
			};
			try {
				return network
					? await options.withRepositoryToken(input.repository, invoke, options.signal)
					: await invoke();
			} catch {
				throw new Error("CODING_GIT_OPERATION_UNCONFIRMED");
			}
		};
		await run(["init", "--bare", "--template=", cwd], false, scratch);
		const inspectRemote = async (): Promise<{ base: string; head: string | null }> => {
			const output = await run(["ls-remote", "--refs", "--heads", remote, baseRef, ref], true);
			const found = new Map<string, string>();
			for (const line of output.trimEnd().split("\n")) {
				const match = /^([0-9a-f]{40})\t(refs\/heads\/.+)$/.exec(line);
				if (!match || ![baseRef, ref].includes(match[2]) || found.has(match[2]))
					throw new Error("CODING_GIT_REMOTE_UNCONFIRMED");
				found.set(match[2], match[1]);
			}
			// Base branch may advance normally. Worker ancestry remains pinned to the
			// immutable original base below; its repository/branch cannot be retargeted.
			const base = found.get(baseRef);
			if (base === undefined) throw new Error("CODING_GIT_BASE_UNAVAILABLE");
			return { base, head: found.get(ref) ?? null };
		};
		const observed = await inspectRemote();
		if (observed.head === input.headSha) return { branch, headSha: input.headSha };
		if (claimed) throw new Error("CODING_GIT_RECONCILIATION_REQUIRED");
		if (observed.head !== input.expectedRemoteHeadSha) throw new Error("CODING_GIT_HEAD_CHANGED");
		const expectedHead = `${input.headSha} ${ref}\n`;
		if ((await run(["bundle", "list-heads", bundlePath])) !== expectedHead)
			throw new Error("CODING_GIT_BUNDLE_TARGET_MISMATCH");
		const depthOne = ["fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", remote];
		if (prerequisites.length > 0)
			await run(
				[...depthOne, ...prerequisites.map((sha, index) => `${sha}:refs/qorpera/prerequisite/${index}`)],
				true,
				cwd,
				true,
			);
		await run(["bundle", "verify", bundlePath]);
		if ((await run(["bundle", "unbundle", bundlePath])) !== expectedHead)
			throw new Error("CODING_GIT_BUNDLE_TARGET_MISMATCH");
		if ((await run(["cat-file", "-t", input.headSha])) !== "commit\n")
			throw new Error("CODING_GIT_BUNDLE_TARGET_MISMATCH");
		// A prerequisite the head does not reach is not reported.
		await run(["fsck", "--strict", "--no-reflogs", "--no-dangling", input.headSha]);
		await run(["merge-base", "--is-ancestor", input.baseSha, input.headSha]);
		if (input.expectedRemoteHeadSha !== null)
			await run(["merge-base", "--is-ancestor", input.expectedRemoteHeadSha, input.headSha]);
		// The base tip lets the push leave out what the base already has. Fetched at
		// depth 1 it is shallow, so it is fetched only when the broker lacks it: then
		// it is on none of the head's history, and the walks above and the push's own
		// fast-forward check see that history whole.
		if (prerequisites.length > 0 && (await run(["rev-list", "--no-walk", "--ignore-missing", observed.base])) === "")
			await run([...depthOne, `${observed.base}:refs/qorpera/base`], true, cwd, true);
		await authorize();
		if (!(await publish(options.journalRoot, claimName, Buffer.from(JSON.stringify(claim)))))
			throw new Error("CODING_GIT_RECONCILIATION_REQUIRED");
		// Ordinary push only. No '+' refspec, --force or automatic second attempt.
		await run(
			["push", "--porcelain", "--no-verify", "--recurse-submodules=no", remote, `${input.headSha}:${ref}`],
			true,
		);
		if ((await inspectRemote()).head !== input.headSha) throw new Error("CODING_GIT_RECONCILIATION_REQUIRED");
		return { branch, headSha: input.headSha };
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}
