import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type CloudCodingRepository, parseCloudCodingRepository } from "@qorpera/contracts";
import { checkDirectory, code, publish, readRecord } from "./lxd-office-journal-files.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const MAX_BUNDLE = 64 * 1024 ** 2;

export interface CodingGitPush {
	repository: CloudCodingRepository;
	workerId: string;
	headSha: string;
	baseSha: string;
	expectedRemoteHeadSha: string | null;
}
export interface CodingBrokerGitCommand {
	readonly cwd: string;
	readonly args: readonly string[];
	/** Trusted broker process environment. Contains a scoped HTTP header only
	 * for a network command; never persist, log or forward it into the VM. */
	readonly env: Readonly<Record<string, string>>;
	readonly signal: AbortSignal;
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
	/** Trusted transport injection for tests; production uses Linux prlimit + git. */
	runGit?: CodingBrokerGitRunner;
}

/** Closed process transport: no shell, inherited environment, error body or
 * unbounded output. Git descendants are killed together on timeout/lease loss. */
export const runCodingBrokerGit: CodingBrokerGitRunner = async ({ cwd, args, env, signal }) => {
	signal.throwIfAborted();
	if (process.platform !== "linux" || process.getuid?.() === 0)
		throw new Error("CODING_GIT_BROKER_REQUIRES_UNPRIVILEGED_LINUX");
	return new Promise<string>((resolve, reject) => {
		const child = spawn(
			"/usr/bin/prlimit",
			[
				"--as=1073741824",
				"--cpu=30",
				"--fsize=268435456",
				"--nofile=64",
				"--nproc=512",
				"--core=0",
				"--",
				"/usr/bin/git",
				...args,
			],
			{
				cwd,
				env: { ...env },
				shell: false,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
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
		const checked = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
		checked.addEventListener("abort", kill, { once: true });
		if (checked.aborted) kill();
		child.stdout.on("data", (value: Buffer) => {
			bytes += value.length;
			if (bytes > 65536) kill();
			else chunks.push(value);
		});
		child.stderr.on("data", (value: Buffer) => {
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
};

/** Publish one complete bundle into the worker's fixed GitHub branch. Objects
 * are imported into a new bare broker repository; no worktree, repository
 * config, hooks, filters, submodules or model code execute in the token lane.
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
		schema: "qorpera.coding-git-target/v1",
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
		const run = async (args: string[], network = false, directory = cwd): Promise<string> => {
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
					args: [...prefix, ...args],
					env,
					signal: options.signal,
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
		const inspectRemote = async (): Promise<string | null> => {
			const output = await run(["ls-remote", "--refs", "--heads", remote, baseRef, ref], true);
			const found = new Map<string, string>();
			for (const line of output.trimEnd().split("\n")) {
				const match = /^([0-9a-f]{40})\t(refs\/heads\/.+)$/.exec(line);
				if (!match || ![baseRef, ref].includes(match[2]) || found.has(match[2]))
					throw new Error("CODING_GIT_REMOTE_UNCONFIRMED");
				found.set(match[2], match[1]);
			}
			if (found.get(baseRef) !== input.baseSha) throw new Error("CODING_GIT_BASE_CHANGED");
			return found.get(ref) ?? null;
		};
		const observed = await inspectRemote();
		if (observed === input.headSha) return { branch, headSha: input.headSha };
		if (claimed) throw new Error("CODING_GIT_RECONCILIATION_REQUIRED");
		if (observed !== input.expectedRemoteHeadSha) throw new Error("CODING_GIT_HEAD_CHANGED");
		const expectedHead = `${input.headSha} ${ref}\n`;
		if ((await run(["bundle", "list-heads", bundlePath])) !== expectedHead)
			throw new Error("CODING_GIT_BUNDLE_TARGET_MISMATCH");
		await run(["bundle", "verify", bundlePath]);
		if ((await run(["bundle", "unbundle", bundlePath])) !== expectedHead)
			throw new Error("CODING_GIT_BUNDLE_TARGET_MISMATCH");
		if ((await run(["cat-file", "-t", input.headSha])) !== "commit\n")
			throw new Error("CODING_GIT_BUNDLE_TARGET_MISMATCH");
		await run(["fsck", "--strict", "--no-reflogs", input.headSha]);
		await run(["merge-base", "--is-ancestor", input.baseSha, input.headSha]);
		if (input.expectedRemoteHeadSha !== null)
			await run(["merge-base", "--is-ancestor", input.expectedRemoteHeadSha, input.headSha]);
		await authorize();
		if (!(await publish(options.journalRoot, claimName, Buffer.from(JSON.stringify(claim)))))
			throw new Error("CODING_GIT_RECONCILIATION_REQUIRED");
		// Ordinary push only. No '+' refspec, --force or automatic second attempt.
		await run(
			["push", "--porcelain", "--no-verify", "--recurse-submodules=no", remote, `${input.headSha}:${ref}`],
			true,
		);
		if ((await inspectRemote()) !== input.headSha) throw new Error("CODING_GIT_RECONCILIATION_REQUIRED");
		return { branch, headSha: input.headSha };
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}
