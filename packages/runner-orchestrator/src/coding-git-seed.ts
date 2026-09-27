import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { type CloudCodingRepository, parseCloudCodingRepository } from "@qorpera/contracts";
import { CodingMachineUnavailable } from "./coding-executor.ts";
import { type CodingBrokerGitRunner, runCodingBrokerGit } from "./coding-git.ts";
import { checkDirectory } from "./lxd-office-journal-files.ts";

export interface CodingGitSeed {
	repository: CloudCodingRepository;
	workerId: string;
	baseSha: string;
}
export interface CodingGitSeedOptions {
	journalRoot: string;
	signal: AbortSignal;
	assertAuthorized(input: Readonly<CodingGitSeed>, signal: AbortSignal): Promise<void>;
	withRepositoryToken<T>(
		repository: CloudCodingRepository,
		use: (token: string) => Promise<T>,
		signal: AbortSignal,
	): Promise<T>;
	runGit?: CodingBrokerGitRunner;
}

export interface CodingGitBaseResolutionOptions {
	journalRoot: string;
	signal: AbortSignal;
	assertAuthorized(repository: CloudCodingRepository, signal: AbortSignal): Promise<void>;
	withRepositoryToken<T>(
		repository: CloudCodingRepository,
		use: (token: string) => Promise<T>,
		signal: AbortSignal,
	): Promise<T>;
	runGit?: CodingBrokerGitRunner;
}

/** Observe the exact configured base ref. Caller durably pins this result for
 * the worker before seed fetch; a later fetch refuses a moved base. */
export async function resolveCloudCodingBase(
	value: CloudCodingRepository,
	options: CodingGitBaseResolutionOptions,
): Promise<string> {
	const repository = parseCloudCodingRepository(value);
	let authorityDeferral: CodingMachineUnavailable | null = null;
	const authorize = async (): Promise<void> => {
		options.signal.throwIfAborted();
		try {
			await options.assertAuthorized(repository, options.signal);
		} catch (error) {
			if (error instanceof CodingMachineUnavailable) authorityDeferral = error;
			throw error;
		}
		options.signal.throwIfAborted();
	};
	await authorize();
	await checkDirectory(options.journalRoot);
	const scratch = await mkdtemp(join(options.journalRoot, ".git-base-"));
	try {
		await checkDirectory(scratch);
		const cwd = join(scratch, "repo.git"),
			remote = `https://github.com/${repository.owner}/${repository.name}.git`,
			ref = `refs/heads/${repository.baseBranch}`;
		const env: Record<string, string> = {
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
			GIT_ALLOW_PROTOCOL: "https",
			GIT_NO_REPLACE_OBJECTS: "1",
		};
		const prefix = [
			"--no-replace-objects",
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"credential.helper=",
			"-c",
			"http.followRedirects=false",
			"-c",
			"http.sslVerify=true",
			"-c",
			"protocol.allow=never",
			"-c",
			"protocol.https.allow=always",
		];
		const run = options.runGit ?? runCodingBrokerGit;
		await run({
			scratchRoot: scratch,
			network: false,
			cwd: scratch,
			args: [...prefix, "init", "--bare", "--template=", cwd],
			env,
			signal: options.signal,
		});
		await authorize();
		const output = await options.withRepositoryToken(
			repository,
			async (token) => {
				if (!/^[A-Za-z0-9_]{20,512}$/.test(token)) throw new Error("CODING_GIT_BASE_CREDENTIAL_UNAVAILABLE");
				await authorize();
				return run({
					scratchRoot: scratch,
					network: true,
					cwd,
					args: [...prefix, "ls-remote", "--refs", "--heads", remote, ref],
					env: {
						...env,
						GIT_CONFIG_COUNT: "1",
						GIT_CONFIG_KEY_0: `http.${remote}.extraHeader`,
						GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
					},
					signal: options.signal,
				});
			},
			options.signal,
		);
		await authorize();
		const match = /^([0-9a-f]{40})\t([^\r\n]+)\n$/.exec(output);
		if (!match || match[2] !== ref) throw new Error("CODING_GIT_BASE_UNCONFIRMED");
		return match[1];
	} catch (error) {
		if (authorityDeferral !== null && error === authorityDeferral) throw error;
		throw new Error("CODING_GIT_BASE_UNCONFIRMED");
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

/** Fetch an authorized pinned base in a fresh bare broker repository and
 * emit one complete worker-branch bundle. No credential, checkout, remote
 * config, hook or provider environment is included in the returned bytes. */
export async function fetchCloudCodingSeed(
	value: CodingGitSeed,
	options: CodingGitSeedOptions,
): Promise<{ headSha: string; bundle: Buffer; bundleSha256: string }> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join() !== "baseSha,repository,workerId" ||
		typeof value.workerId !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.workerId) ||
		typeof value.baseSha !== "string" ||
		!/^[0-9a-f]{40}$/.test(value.baseSha)
	)
		throw new Error("INVALID_CODING_GIT_SEED");
	const input = Object.freeze({ ...value, repository: parseCloudCodingRepository(value.repository) });
	let authorityDeferral: CodingMachineUnavailable | null = null;
	const authorize = async (): Promise<void> => {
		options.signal.throwIfAborted();
		try {
			await options.assertAuthorized(input, options.signal);
		} catch (error) {
			if (error instanceof CodingMachineUnavailable) {
				authorityDeferral = error;
				throw error;
			}
			throw new Error("CODING_GIT_SEED_AUTHORITY_UNAVAILABLE");
		}
		options.signal.throwIfAborted();
	};
	await authorize();
	await checkDirectory(options.journalRoot);
	const scratch = await mkdtemp(join(options.journalRoot, ".git-seed-"));
	try {
		await checkDirectory(scratch);
		const cwd = join(scratch, "repo.git"),
			output = join(scratch, "seed.bundle");
		const remote = `https://github.com/${input.repository.owner}/${input.repository.name}.git`;
		const base = `refs/heads/${input.repository.baseBranch}`,
			branch = `refs/heads/qorpera/coding/${input.workerId}`;
		if (base === branch) throw new Error("INVALID_CODING_GIT_SEED");
		const env: Record<string, string> = {
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
		const prefix = [
			"--no-replace-objects",
			...[
				"core.hooksPath=/dev/null",
				"credential.helper=",
				"credential.interactive=false",
				"http.followRedirects=false",
				"http.sslVerify=true",
				"protocol.allow=never",
				"protocol.https.allow=always",
				"submodule.recurse=false",
				"fetch.recurseSubmodules=false",
				"gc.auto=0",
				"maintenance.auto=false",
				"transfer.fsckObjects=true",
				"fetch.fsckObjects=true",
			].flatMap((config) => ["-c", config]),
		];
		const run = async (args: string[], network = false, directory = cwd): Promise<string> => {
			const invoke = async (token?: string): Promise<string> => {
				await authorize();
				const environment = { ...env };
				if (token !== undefined) {
					if (!/^[A-Za-z0-9_]{20,512}$/.test(token)) throw new Error("CODING_GIT_SEED_CREDENTIAL_UNAVAILABLE");
					environment.GIT_CONFIG_COUNT = "1";
					environment.GIT_CONFIG_KEY_0 = `http.${remote}.extraHeader`;
					environment.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
				}
				const result = await (options.runGit ?? runCodingBrokerGit)({
					cwd: directory,
					scratchRoot: scratch,
					network,
					args: [...prefix, ...args],
					env: environment,
					signal: options.signal,
				});
				await authorize();
				return result;
			};
			try {
				return network
					? await options.withRepositoryToken(input.repository, invoke, options.signal)
					: await invoke();
			} catch (error) {
				if (authorityDeferral !== null && error === authorityDeferral) throw error;
				throw new Error("CODING_GIT_SEED_UNCONFIRMED");
			}
		};
		await run(["init", "--bare", "--template=", cwd], false, scratch);
		await run(
			["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", remote, `${base}:${base}`],
			true,
		);
		if (
			(await run(["rev-parse", "--verify", base])).trim() !== input.baseSha ||
			(await run(["cat-file", "-t", input.baseSha])) !== "commit\n"
		)
			throw new Error("CODING_GIT_SEED_BASE_CHANGED");
		await run(["fsck", "--strict", "--no-reflogs", input.baseSha]);
		await run(["update-ref", branch, input.baseSha]);
		await run(["bundle", "create", output, branch]);
		const stat = await lstat(output);
		if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 64 * 1024 ** 2)
			throw new Error("CODING_GIT_SEED_TOO_LARGE");
		const bundle = await readFile(output);
		if (bundle.length !== stat.size) throw new Error("CODING_GIT_SEED_CHANGED");
		await authorize();
		return { headSha: input.baseSha, bundle, bundleSha256: createHash("sha256").update(bundle).digest("hex") };
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}
