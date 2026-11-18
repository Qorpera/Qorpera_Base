import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	NATIVE_CHATGPT_PLAN_EGRESS_HOSTS,
	NATIVE_CLAUDE_CODE_EGRESS_HOSTS,
	NATIVE_CLAUDE_SIGN_IN_EGRESS_HOSTS,
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

export type NativeClaudeRead = "usage" | "screen";
export const NATIVE_CLAUDE_TERMINAL = Object.freeze({ rows: 40, cols: 200 });

/** A root-owned file no one else may write, every folder above it root's too (also the Claude Code box's check). */
export async function rootOwnedFile(path: string): Promise<void> {
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

async function rootOwnedFolders(path: string): Promise<void> {
	let current = path;
	while (true) {
		const metadata = await lstat(current);
		if (metadata.uid !== 0 || (metadata.mode & 0o022) !== 0 || !metadata.isDirectory())
			throw new Error("Unsafe native isolation artifact ownership");
		if (current === "/") break;
		current = dirname(current);
	}
}

export async function rootOwnedProgram(path: string): Promise<string> {
	if (!isAbsolute(path) || path !== resolve(path))
		throw new Error("Native isolation requires physical absolute artifacts");
	const real = await realpath(path);
	const metadata = await lstat(real);
	// WHY: no single-link check: Ubuntu 26.04's stty is a symlink to one of the uutils binary's many hard links.
	if (metadata.uid !== 0 || (metadata.mode & 0o022) !== 0 || !metadata.isFile())
		throw new Error("Unsafe native isolation artifact ownership");
	await rootOwnedFolders(dirname(real));
	return real;
}

/** A folder of this account's own that no one else may enter (also the Claude Code box's check). */
export async function privateDirectory(path: string): Promise<void> {
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

/** The hosts a native process may reach: OpenAI's API alone for a ChatGPT plan run, Anthropic's sign-in hosts for a
 * Claude sign-in, the Codex login's hosts otherwise. */
export function nativeIsolationEgressHosts(
	chatGptPlan: NativeChatGptPlanAccess | undefined,
	harness?: "claude-code",
	claudeRead?: NativeClaudeRead,
): readonly string[] {
	if (harness === "claude-code")
		return claudeRead ? NATIVE_CLAUDE_CODE_EGRESS_HOSTS : NATIVE_CLAUDE_SIGN_IN_EGRESS_HOSTS;
	return chatGptPlan ? NATIVE_CHATGPT_PLAN_EGRESS_HOSTS : NATIVE_CODEX_EGRESS_HOSTS;
}

function claudeReadEnvironment(read: NativeClaudeRead | undefined): Record<string, string> {
	if (read === "usage") return { DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" };
	if (read === "screen")
		return {
			CLAUDE_CODE_SANDBOXED: "1",
			TERM: "xterm-256color",
			COLUMNS: String(NATIVE_CLAUDE_TERMINAL.cols),
			LINES: String(NATIVE_CLAUDE_TERMINAL.rows),
		};
	return { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
}

export function nativeTerminalCommand(stty: string, program: string, args: readonly string[]): string[] {
	const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	const { rows, cols } = NATIVE_CLAUDE_TERMINAL;
	return [
		"-q",
		"-e",
		"-c",
		`${quote(stty)} rows ${rows} cols ${cols} && exec ${[program, ...args].map(quote).join(" ")}`,
		"/dev/null",
	];
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
	/** The agent's home (slice 1): the host's socket in this same scratch root, which Codex reaches with
	 * `stdio-to-uds` to run its own shell and file tools on the run's machine. Never a path outside the root. */
	homeSocket?: string;
	chatGptPlan?: NativeChatGptPlanAccess;
	harness?: "claude-code";
	claudeRead?: NativeClaudeRead;
}): { args: string[]; environment: Record<string, string> } {
	const plan = options.chatGptPlan;
	const claude = options.harness === "claude-code";
	if (claude && (plan || options.fenceSocket || options.homeSocket)) throw new Error("A Claude sign-in runs alone");
	if (options.claudeRead && !claude) throw new Error("A Claude read runs Claude Code");
	if (options.homeSocket && dirname(options.homeSocket) !== options.scratchRoot)
		throw new Error("The home's socket is the run's own");
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
		// Read-only, as the fence's socket is: the namespace writes JSON-RPC lines to it, nothing else.
		...(options.homeSocket ? ["--ro-bind", options.homeSocket, options.homeSocket] : []),
	];
	const environment = {
		HOME: join(options.scratchRoot, "home"),
		// Claude Code keeps its login in its config directory; it never updates itself or calls home beyond its sign-in.
		...(claude
			? {
					CLAUDE_CONFIG_DIR: options.codexHome,
					DISABLE_AUTOUPDATER: "1",
					...claudeReadEnvironment(options.claudeRead),
				}
			: { CODEX_HOME: options.codexHome }),
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
	/** The agent's home socket, in the scratch root beside the fence's (cloud-codex-home.ts). */
	homeSocket?: string;
	chatGptPlan?: NativeChatGptPlanAccess;
	/** A Claude sign-in: `codexHome` is Claude Code's config directory (the vault's helper only). */
	harness?: "claude-code";
	claudeRead?: NativeClaudeRead;
	signal: AbortSignal;
}): Promise<{
	child: ChildProcessWithoutNullStreams;
	close(): Promise<void>;
	/** The relay's voice call window (NativeEgressRelay.allowRealtime): a Codex login's process only. */
	allowRealtime?: () => () => void;
	/** The relay's window for a picture call (NativeEgressRelay.allowLongWaits): a Codex login's process only. */
	allowLongWaits?: () => () => void;
}> {
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
	const terminal =
		options.claudeRead === "screen"
			? { script: await rootOwnedProgram("/usr/bin/script"), stty: await rootOwnedProgram("/usr/bin/stty") }
			: undefined;
	await privateDirectory(options.scratchRoot);
	await privateDirectory(options.codexHome);
	if (planDirectory) await privateDirectory(planDirectory);
	for (const name of ["workspace", "home", "config", "data", "cache"])
		await privateDirectory(join(options.scratchRoot, name));
	const relay = await startNativeCodexEgress({
		root: options.scratchRoot,
		signal: options.signal,
		hosts: nativeIsolationEgressHosts(plan, options.harness, options.claudeRead),
	});
	let child: ChildProcessWithoutNullStreams | undefined;
	try {
		for (const [socket, what] of [
			[options.fenceSocket, "result-fence"],
			[options.homeSocket, "home"],
		] as const) {
			if (!socket) continue;
			const metadata = await lstat(socket);
			if (
				dirname(socket) !== options.scratchRoot ||
				!metadata.isSocket() ||
				metadata.uid !== process.getuid?.() ||
				(metadata.mode & 0o077) !== 0
			)
				throw new Error(`Unsafe native ${what} socket`);
		}
		const invocation = nativeIsolationInvocation({ ...options, relayPath: relay.path });
		options.signal.throwIfAborted();
		child = terminal
			? spawn(terminal.script, nativeTerminalCommand(terminal.stty, "/usr/bin/bwrap", invocation.args), {
					cwd: options.scratchRoot,
					env: { ...invocation.environment, SHELL: "/bin/sh" },
					stdio: ["pipe", "pipe", "pipe"],
					detached: true,
				})
			: spawn("/usr/bin/bwrap", invocation.args, {
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
			...(relay.allowRealtime ? { allowRealtime: relay.allowRealtime } : {}),
			...(relay.allowLongWaits ? { allowLongWaits: relay.allowLongWaits } : {}),
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
