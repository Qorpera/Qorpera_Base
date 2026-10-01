import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	NATIVE_CHATGPT_PLAN_EGRESS_HOSTS,
	NATIVE_CODEX_EGRESS_HOSTS,
	startNativeCodexEgress,
} from "./cloud-native-egress.ts";

export interface NativeIsolationConfiguration {
	/** Root-owned entrypoint installed from the verified guest manifest. */
	entryPoint: string;
}

/** A run on a member's ChatGPT plan (Sign in with ChatGPT) finds the plan's access token, which its host
 * keeps fresh from the vault, at `<identity root>/chatgpt-plan/access-token`. Never a refresh token. */
export const CHATGPT_PLAN_DIRECTORY = "chatgpt-plan";
export const CHATGPT_PLAN_TOKEN_FILE = "access-token";

/** The environment variable that carries a ChatGPT plan's access token in the fallback mode. */
export const CHATGPT_PLAN_TOKEN_ENVIRONMENT = "QORPERA_CHATGPT_PLAN_ACCESS_TOKEN";

/** A run on a member's ChatGPT plan (Sign in with ChatGPT). Either the host's private directory holding
 * the plan's access token, bound read-only at the same path for the provider's token command, or (the
 * fallback) the token itself, given to the process's environment and never to an argument. Either way the
 * run reaches OpenAI's API alone. */
export type NativeChatGptPlanAccess = { readonly directory: string } | { readonly accessToken: string };

async function rootOwnedFile(path: string): Promise<void> {
	if (!isAbsolute(path) || path !== resolve(path) || (await realpath(path)) !== path)
		throw new Error("Native isolation requires physical absolute artifacts");
	let current = path;
	while (true) {
		const metadata = await lstat(current);
		if (
			metadata.uid !== 0 ||
			(metadata.mode & 0o022) !== 0 ||
			metadata.isSymbolicLink() ||
			(current === path ? !metadata.isFile() || metadata.nlink !== 1 : !metadata.isDirectory())
		)
			throw new Error("Unsafe native isolation artifact ownership");
		if (current === "/") break;
		current = dirname(current);
	}
}

async function privateDirectory(path: string): Promise<void> {
	const metadata = await lstat(path);
	if (
		!isAbsolute(path) ||
		path !== resolve(path) ||
		(await realpath(path)) !== path ||
		!metadata.isDirectory() ||
		metadata.isSymbolicLink() ||
		metadata.uid !== process.getuid?.() ||
		(metadata.mode & 0o077) !== 0 ||
		path.split("/").length < 4
	)
		throw new Error("Unsafe native isolation working directory");
}

/** The hosts a native process may reach: OpenAI's API alone for a ChatGPT plan run, the Codex login's
 * hosts otherwise. */
export function nativeIsolationEgressHosts(chatGptPlan: NativeChatGptPlanAccess | undefined): readonly string[] {
	return chatGptPlan ? NATIVE_CHATGPT_PLAN_EGRESS_HOSTS : NATIVE_CODEX_EGRESS_HOSTS;
}

/** What the namespace of one native process sees: bwrap's arguments and the environment bwrap starts with.
 * No file system checks (the launcher makes them first), so a run's shape can be checked anywhere. */
export function nativeIsolationInvocation(options: {
	configuration: NativeIsolationConfiguration;
	command: string;
	args: readonly string[];
	scratchRoot: string;
	codexHome: string;
	relayPath: string;
	fenceSocket?: string;
	chatGptPlan?: NativeChatGptPlanAccess;
}): { args: string[]; environment: Record<string, string> } {
	const plan = options.chatGptPlan;
	const planDirectory = plan && "directory" in plan ? plan.directory : undefined;
	const planToken = plan && "accessToken" in plan ? plan.accessToken : undefined;
	if (planToken !== undefined && !/^[\x21-\x7e]{1,16384}$/.test(planToken))
		throw new Error("Invalid ChatGPT plan access token");
	const directories = ["workspace", "home", "config", "data", "cache"].map((name) => join(options.scratchRoot, name));
	const args = [
		"--unshare-user",
		"--unshare-pid",
		"--unshare-net",
		"--unshare-ipc",
		"--unshare-uts",
		"--unshare-cgroup",
		"--disable-userns",
		"--assert-userns-disabled",
		"--die-with-parent",
		"--new-session",
		"--cap-drop",
		"ALL",
		// The fallback's token reaches the namespace only through bwrap's own environment (below, readable by
		// this user alone), never through an argument; nothing else is in that environment to keep.
		...(planToken === undefined ? ["--clearenv"] : []),
		"--ro-bind",
		"/usr",
		"/usr",
		"--symlink",
		"usr/bin",
		"/bin",
		"--symlink",
		"usr/lib",
		"/lib",
		"--symlink",
		"usr/lib64",
		"/lib64",
		"--ro-bind",
		"/etc/ssl/certs",
		"/etc/ssl/certs",
		"--ro-bind",
		"/etc/ld.so.cache",
		"/etc/ld.so.cache",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--size",
		"67108864",
		"--tmpfs",
		"/tmp",
		"--ro-bind",
		options.command,
		options.command,
		"--ro-bind",
		options.configuration.entryPoint,
		"/qorpera/native-entry.mjs",
		...directories.flatMap((path) => ["--bind", path, path]),
		"--bind",
		options.codexHome,
		options.codexHome,
		"--ro-bind",
		options.relayPath,
		options.relayPath,
		// Read-only, as a directory: the host swaps the token file inside it, and the token command sees
		// each newer token.
		...(planDirectory ? ["--ro-bind", planDirectory, planDirectory] : []),
		...(options.fenceSocket ? ["--ro-bind", options.fenceSocket, options.fenceSocket] : []),
	];
	const environment = {
		HOME: join(options.scratchRoot, "home"),
		CODEX_HOME: options.codexHome,
		XDG_CONFIG_HOME: join(options.scratchRoot, "config"),
		XDG_DATA_HOME: join(options.scratchRoot, "data"),
		XDG_CACHE_HOME: join(options.scratchRoot, "cache"),
		PATH: "/usr/bin:/bin",
		LANG: "C.UTF-8",
		TZ: "UTC",
		NO_COLOR: "1",
		...(options.fenceSocket ? { QORPERA_NATIVE_RESULT_FENCE_SOCKET: options.fenceSocket } : {}),
	};
	for (const [name, value] of Object.entries(environment)) args.push("--setenv", name, value);
	args.push(
		"--chdir",
		join(options.scratchRoot, "workspace"),
		"--remount-ro",
		"/",
		"--",
		"/usr/bin/node",
		"/qorpera/native-entry.mjs",
		options.relayPath,
		options.command,
		...options.args,
	);
	return {
		args,
		// Without --clearenv bwrap passes this on; the variables set above replace PATH and LANG.
		environment: {
			PATH: "/usr/bin:/bin",
			LANG: "C.UTF-8",
			...(planToken === undefined ? {} : { [CHATGPT_PLAN_TOKEN_ENVIRONMENT]: planToken }),
		},
	};
}

/** No fallback: unsupported kernels, permissions, namespace failures or helper
 * failures never start the native binary outside containment. The caller's
 * private scratch root contains only these five newly created directories.
 * Identity is an auth-only directory; neither its parent nor host home is bound.
 */
export async function launchIsolatedNativeProcess(options: {
	configuration: NativeIsolationConfiguration;
	command: string;
	args: readonly string[];
	scratchRoot: string;
	codexHome: string;
	fenceSocket?: string;
	chatGptPlan?: NativeChatGptPlanAccess;
	signal: AbortSignal;
}): Promise<{ child: ChildProcessWithoutNullStreams; close(): Promise<void> }> {
	if (process.platform !== "linux" || !process.getuid?.())
		throw new Error("Native containment requires unprivileged Linux");
	options.signal.throwIfAborted();
	const plan = options.chatGptPlan;
	const planDirectory = plan && "directory" in plan ? plan.directory : undefined;
	// The token command (`cat`) runs from the read-only /usr inside the namespace.
	for (const file of [
		"/usr/bin/bwrap",
		"/usr/bin/node",
		...(planDirectory ? ["/usr/bin/cat"] : []),
		options.configuration.entryPoint,
		options.command,
	])
		await rootOwnedFile(file);
	await privateDirectory(options.scratchRoot);
	await privateDirectory(options.codexHome);
	if (planDirectory) await privateDirectory(planDirectory);
	for (const name of ["workspace", "home", "config", "data", "cache"])
		await privateDirectory(join(options.scratchRoot, name));
	const relay = await startNativeCodexEgress({
		root: options.scratchRoot,
		signal: options.signal,
		hosts: nativeIsolationEgressHosts(plan),
	});
	let child: ChildProcessWithoutNullStreams | undefined;
	try {
		if (options.fenceSocket) {
			const metadata = await lstat(options.fenceSocket);
			if (
				dirname(options.fenceSocket) !== options.scratchRoot ||
				!metadata.isSocket() ||
				metadata.uid !== process.getuid?.() ||
				(metadata.mode & 0o077) !== 0
			)
				throw new Error("Unsafe native result-fence socket");
		}
		const invocation = nativeIsolationInvocation({ ...options, relayPath: relay.path });
		options.signal.throwIfAborted();
		child = spawn("/usr/bin/bwrap", invocation.args, {
			cwd: options.scratchRoot,
			env: invocation.environment,
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
		});
		const launched = child;
		// Killing the namespace's init removes descendants, including processes
		// that called setsid. The unit's cgroup is a second kill/resource boundary.
		const stop = (): void => {
			launched.kill("SIGKILL");
		};
		options.signal.addEventListener("abort", stop, { once: true });
		if (options.signal.aborted) stop();
		launched.once("close", () => {
			options.signal.removeEventListener("abort", stop);
			void relay.close();
		});
		return {
			child: launched,
			async close() {
				options.signal.removeEventListener("abort", stop);
				stop();
				if (launched.exitCode === null && launched.signalCode === null) {
					await new Promise<void>((resolveExit) => {
						const timer = setTimeout(resolveExit, 2000);
						launched.once("close", () => {
							clearTimeout(timer);
							resolveExit();
						});
					});
				}
				await relay.close();
			},
		};
	} catch (error) {
		child?.kill("SIGKILL");
		await relay.close();
		throw error;
	}
}
