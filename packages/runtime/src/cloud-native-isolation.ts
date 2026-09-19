import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { startNativeCodexEgress } from "./cloud-native-egress.ts";
import { stopNativeNamespaceChild } from "./cloud-native-process-settlement.ts";

export interface NativeIsolationConfiguration {
	/** Root-owned entrypoint installed from the verified guest manifest. */
	entryPoint: string;
}

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
	signal: AbortSignal;
}): Promise<{ child: ChildProcessWithoutNullStreams; close(): Promise<void> }> {
	if (process.platform !== "linux" || !process.getuid?.())
		throw new Error("Native containment requires unprivileged Linux");
	options.signal.throwIfAborted();
	for (const file of ["/usr/bin/bwrap", "/usr/bin/node", options.configuration.entryPoint, options.command])
		await rootOwnedFile(file);
	await privateDirectory(options.scratchRoot);
	await privateDirectory(options.codexHome);
	const directories = ["workspace", "home", "config", "data", "cache"].map((name) => join(options.scratchRoot, name));
	for (const directory of directories) await privateDirectory(directory);
	const relay = await startNativeCodexEgress({ root: options.scratchRoot, signal: options.signal });
	let child: ChildProcessWithoutNullStreams | undefined;
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
		"--clearenv",
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
		relay.path,
		relay.path,
	];
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
			args.push("--ro-bind", options.fenceSocket, options.fenceSocket);
		}
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
			relay.path,
			options.command,
			...options.args,
		);
		options.signal.throwIfAborted();
		child = spawn("/usr/bin/bwrap", args, {
			cwd: options.scratchRoot,
			env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
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
				try {
					await stopNativeNamespaceChild(launched);
				} finally {
					await relay.close();
				}
			},
		};
	} catch (error) {
		let failure = error;
		if (child) {
			try {
				await stopNativeNamespaceChild(child);
			} catch (settlementError) {
				failure = settlementError;
			}
		}
		await relay.close().catch(() => undefined);
		throw failure;
	}
}
