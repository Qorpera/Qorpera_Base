import { constants } from "node:fs";
import { type FileHandle, lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	assertCompanyComputerScreenBinding,
	type CompanyComputerScreenBinding,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import { readCompanyComputerWorkbenchFile } from "./cloud-company-computer-file-reader.ts";
import { writeCompanyComputerWorkbenchFile } from "./cloud-company-computer-file-writer.ts";
import type { CompanyComputerGuestBoundary, CompanyComputerGuestCommands } from "./cloud-company-computer-guest.ts";
import { assertCompanyComputerGuestLayout, type CompanyComputerGuestLayout } from "./cloud-company-computer-layout.ts";
import {
	assertCompanyComputerCommandLimits,
	assertCompanyComputerLinuxHost,
	assertCompanyComputerWorkbenchMount,
	assertCompanyComputerImageArtifact as assertRootOwned,
	type CompanyComputerCommandLimits,
	companyComputerLinuxSandboxArgs,
	openCompanyComputerLinuxDirectory,
} from "./cloud-company-computer-linux-host.ts";
import { spawnCompanyComputerLinuxProcess } from "./cloud-company-computer-linux-process.ts";
import { companyComputerScreenDisplay } from "./cloud-company-computer-screens.ts";
import type { RecoveryDirectoryMount } from "./cloud-identity-recovery-filesystems.ts";
import { cloudToolRequest } from "./cloud-native-tool-authority.ts";

export {
	assertCompanyComputerCommandLimits,
	assertCompanyComputerCommandProcess,
	type CompanyComputerCommandLimits,
} from "./cloud-company-computer-linux-host.ts";

interface CommandProcess {
	stop(): void;
	exited: Promise<{ code: number; stdout: string; stderr: string }>;
}

/** Linux command adapter for the existing receipt-admitted guest automation.
 * Bubblewrap mounts opened directory descriptors, never an ambient host root.
 * No provider/profile/service paths, host PID view or host network are present.
 * An assigned X socket is the sole control channel. Per-screen boundaries do
 * not partition company work: every command shares the same workbench. */
export class CompanyComputerLinuxCommands implements CompanyComputerGuestCommands {
	readonly #binding: CompanyComputerScreenBinding;
	readonly #layout: CompanyComputerGuestLayout;
	readonly #boundary: CompanyComputerGuestBoundary;
	readonly #mount: RecoveryDirectoryMount;
	readonly #limits: CompanyComputerCommandLimits;
	readonly #xSocket: string;
	readonly #captureRoot: string;
	readonly #active = new Set<CommandProcess>();
	readonly #calls = new Set<Promise<unknown>>();
	readonly #stop = new AbortController();
	#closing?: Promise<void>;

	#track<T>(work: (deadline: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
		// Also bound preflight/mount/capture I/O. A late filesystem operation
		// remains tracked after this caller times out; close cannot claim it drained.
		return cloudToolRequest(
			async (deadline) => {
				const pending = Promise.resolve().then(() => work(deadline));
				this.#calls.add(pending);
				try {
					return await pending;
				} finally {
					this.#calls.delete(pending);
				}
			},
			new AbortController().signal,
			timeoutMs,
		);
	}

	constructor(options: {
		binding: CompanyComputerScreenBinding;
		layout: CompanyComputerGuestLayout;
		boundary: CompanyComputerGuestBoundary;
		/** Pinned by office provisioning/adoption; never inferred from a live
		 * directory or supplied by the model. Prevents a lost NAS mount fallback. */
		workbenchMount: RecoveryDirectoryMount;
		limits: CompanyComputerCommandLimits;
		/** Broker-owned socket of the currently bound X server. */
		xSocket: string;
		/** Existing broker-private local directory, outside every persistent root. */
		captureRoot: string;
	}) {
		assertCompanyComputerScreenBinding(options.binding, options.binding);
		assertCompanyComputerGuestLayout(options.layout);
		for (const path of [options.xSocket, options.captureRoot]) {
			if (
				path === "/" ||
				path !== resolve(path) ||
				/[\x00-\x1f\x7f\\]/.test(path) ||
				Object.values(options.layout).some(
					(root) => path === root || path.startsWith(`${root}/`) || root.startsWith(`${path}/`),
				)
			)
				throw new Error("UNSAFE_OFFICE_CONTROL_PATH");
		}
		assertCompanyComputerCommandLimits(options.limits, {
			memory: String(options.limits.memoryBytes),
			pids: String(options.limits.pids),
			cpu: `${options.limits.cpuQuota} ${options.limits.cpuPeriod}`,
		});
		if (
			Object.keys(options.workbenchMount).sort().join() !== "filesystem,mountPoint,root,source" ||
			Object.values(options.workbenchMount).some(
				(value) => typeof value !== "string" || !value || value.length > 4096 || /[\x00-\x1f\x7f\\]/.test(value),
			)
		)
			throw new Error("INVALID_OFFICE_WORKBENCH_MOUNT");
		this.#binding = Object.freeze({ ...options.binding });
		this.#layout = Object.freeze({ ...options.layout });
		this.#boundary = options.boundary;
		this.#mount = Object.freeze({ ...options.workbenchMount });
		this.#limits = Object.freeze({ ...options.limits });
		this.#xSocket = options.xSocket;
		this.#captureRoot = options.captureRoot;
	}

	async #ready(signal: AbortSignal): Promise<void> {
		if (process.platform !== "linux" || !process.getuid?.() || !process.geteuid?.())
			throw new Error("UNPRIVILEGED_LINUX_OFFICE_REQUIRED");
		this.#stop.signal.throwIfAborted();
		await cloudToolRequest((checked) => this.#boundary.assertReady(this.#binding, checked), signal);
		await assertCompanyComputerLinuxHost(this.#limits, signal);
		signal.throwIfAborted();
	}

	async #execute(
		input: Parameters<CompanyComputerGuestCommands["run"]>[0],
		capture?: string,
	): Promise<{ code: number; stdout: string; stderr: string }> {
		const signal = AbortSignal.any([input.signal, this.#stop.signal]);
		await this.#ready(signal);
		const program = input.program === "/bin/bash" ? "/usr/bin/bash" : input.program;
		for (const path of ["/usr/bin/bwrap", "/usr/bin/tini", "/usr/bin/bash", program]) await assertRootOwned(path);
		await assertRootOwned("/usr", true);
		const handles: FileHandle[] = [];
		try {
			const workbench = await openCompanyComputerLinuxDirectory(this.#layout.workbenchRoot, false);
			handles.push(workbench);
			const home = await openCompanyComputerLinuxDirectory(this.#layout.desktopHome, true);
			handles.push(home);
			await assertCompanyComputerWorkbenchMount(workbench, this.#mount, [
				this.#layout.workbenchRoot,
				this.#layout.desktopHome,
			]);
			const socket = await lstat(this.#xSocket);
			if (
				!socket.isSocket() ||
				socket.uid !== process.getuid?.() ||
				(await realpath(this.#xSocket)) !== this.#xSocket
			)
				throw new Error("OFFICE_X_SOCKET_UNAVAILABLE");
			const socketParent = await lstat(dirname(this.#xSocket));
			if (
				!socketParent.isDirectory() ||
				socketParent.uid !== process.getuid?.() ||
				(socketParent.mode & 0o077) !== 0
			)
				throw new Error("UNSAFE_OFFICE_X_SOCKET_DIRECTORY");
			const args = [
				...companyComputerLinuxSandboxArgs(),
				"--bind-fd",
				"3",
				this.#layout.workbenchRoot,
				"--bind-fd",
				"4",
				"/home/qorpera",
				"--ro-bind",
				this.#xSocket,
				`/tmp/.X11-unix/X${this.#binding.screenOrdinal}`,
			];
			if (capture) {
				const handle = await open(capture, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
				handles.push(handle);
				args.push("--bind-fd", "5", "/qorpera-capture");
			}
			for (const [name, value] of Object.entries({
				HOME: "/home/qorpera",
				DISPLAY: companyComputerScreenDisplay(this.#binding.screenOrdinal),
				PATH: "/usr/local/bin:/usr/bin:/bin",
				LANG: "C.UTF-8",
			}))
				args.push("--setenv", name, value);
			args.push("--chdir", this.#layout.workbenchRoot, "--remount-ro", "/");
			signal.throwIfAborted();
			const launched = spawnCompanyComputerLinuxProcess({
				args,
				command: [program, ...input.args],
				files: handles,
				stdin: "pipe",
			});
			const { child, stop } = launched;
			let failure: Error | undefined;
			void launched.started.catch((error: Error) => {
				failure ??= error;
				stop();
			});
			let length = 0;
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			const collect = (target: Buffer[], bytes: Buffer): void => {
				length += bytes.length;
				if (length > input.maxOutputBytes) {
					failure ??= new Error("OFFICE_COMMAND_OUTPUT_LIMIT");
					stop();
				} else target.push(bytes);
			};
			child.stdout!.on("data", (bytes: Buffer) => collect(stdout, bytes));
			child.stderr!.on("data", (bytes: Buffer) => collect(stderr, bytes));
			child.stdin!.on("error", () => undefined);
			child.once("error", () => {
				failure ??= new Error("OFFICE_COMMAND_START_FAILED");
			});
			const exited = new Promise<{ code: number; stdout: string; stderr: string }>((resolveExit, reject) => {
				child.once("close", (code) => {
					this.#active.delete(activeChild);
					if (failure || code === null) reject(failure ?? new Error("OFFICE_COMMAND_STOPPED"));
					else
						resolveExit({
							code,
							stdout: Buffer.concat(stdout).toString("utf8"),
							stderr: Buffer.concat(stderr).toString("utf8"),
						});
				});
			});
			const activeChild: CommandProcess = { stop, exited };
			this.#active.add(activeChild);
			void exited.catch(() => undefined);
			const cancelled = (): void => {
				failure ??= new Error("OFFICE_COMMAND_CANCELLED");
				stop();
			};
			signal.addEventListener("abort", cancelled, { once: true });
			const timeout = setTimeout(() => {
				failure ??= new Error("OFFICE_COMMAND_TIMEOUT");
				stop();
			}, input.timeoutMs);
			if (signal.aborted) cancelled();
			child.stdin!.end(input.stdin ?? "");
			try {
				// This deadline can report uncertainty, never successful drain. The
				// active entry remains until the actual namespace process closes.
				const result = await cloudToolRequest(() => exited, new AbortController().signal, input.timeoutMs + 5000);
				await launched.started;
				signal.throwIfAborted();
				await this.#ready(signal);
				if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > input.maxOutputBytes)
					throw new Error("OFFICE_COMMAND_OUTPUT_LIMIT");
				return result;
			} finally {
				clearTimeout(timeout);
				signal.removeEventListener("abort", cancelled);
				stop();
			}
		} finally {
			await Promise.all(handles.map((handle) => handle.close()));
		}
	}

	async run(
		input: Parameters<CompanyComputerGuestCommands["run"]>[0],
	): Promise<{ code: number; stdout: string; stderr: string }> {
		if (
			!["/bin/bash", "/usr/bin/xdotool"].includes(input.program) ||
			!Array.isArray(input.args) ||
			input.args.length > 64 ||
			input.args.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
			Buffer.byteLength(JSON.stringify(input.args)) > 20000 ||
			(input.stdin !== undefined && (typeof input.stdin !== "string" || Buffer.byteLength(input.stdin) > 16384)) ||
			input.workingDirectory !== this.#layout.workbenchRoot ||
			!isDeepStrictEqual(input.environment, {
				DISPLAY: companyComputerScreenDisplay(this.#binding.screenOrdinal),
				PATH: "/usr/local/bin:/usr/bin:/bin",
				LANG: "C.UTF-8",
			}) ||
			!Number.isSafeInteger(input.timeoutMs) ||
			input.timeoutMs < 1 ||
			input.timeoutMs > 15000 ||
			!Number.isSafeInteger(input.maxOutputBytes) ||
			input.maxOutputBytes < 1 ||
			input.maxOutputBytes > 16384
		)
			throw new Error("INVALID_OFFICE_COMMAND");
		const copied = { ...input, args: [...input.args], environment: { ...input.environment } };
		return this.#track(
			(deadline) => this.#execute({ ...copied, signal: AbortSignal.any([copied.signal, deadline]) }),
			input.timeoutMs + 15000,
		);
	}

	async readFile(input: { path: string; signal: AbortSignal }): Promise<Uint8Array> {
		const { path, signal: caller } = input;
		return this.#track(async (deadline) => {
			const signal = AbortSignal.any([caller, this.#stop.signal, deadline]);
			await this.#ready(signal);
			const root = await openCompanyComputerLinuxDirectory(this.#layout.workbenchRoot, false);
			try {
				await assertCompanyComputerWorkbenchMount(root, this.#mount, [
					this.#layout.workbenchRoot,
					this.#layout.desktopHome,
				]);
				const bytes = await readCompanyComputerWorkbenchFile(root, path, signal);
				await this.#ready(signal);
				return bytes;
			} finally {
				await root.close();
			}
		}, 15000);
	}
	async writeFile(input: { path: string; bytes: Uint8Array; sha256: string; signal: AbortSignal }): Promise<void> {
		const file = { path: input.path, bytes: Uint8Array.from(input.bytes), sha256: input.sha256 },
			caller = input.signal;
		return this.#track(async (deadline) => {
			const signal = AbortSignal.any([caller, this.#stop.signal, deadline]);
			await this.#ready(signal);
			const handles: FileHandle[] = [];
			const closeFiles = async () => {
				const closed = await Promise.allSettled(handles.map((handle) => handle.close()));
				const failed = closed.find((entry) => entry.status === "rejected");
				if (failed?.status === "rejected") throw failed.reason;
			};
			try {
				const root = await openCompanyComputerLinuxDirectory(this.#layout.workbenchRoot, false);
				handles.push(root);
				// Only individual screen UUID children are mounted into desktops;
				// the parent is broker-private and shares the persistent NAS mount.
				const staging = await openCompanyComputerLinuxDirectory(this.#layout.screenStateRoot, true);
				handles.push(staging);
				for (const handle of handles)
					await assertCompanyComputerWorkbenchMount(handle, this.#mount, Object.values(this.#layout));
				await writeCompanyComputerWorkbenchFile(root, staging, file, signal);
				await this.#ready(signal);
			} finally {
				await closeFiles();
			}
		}, 15000);
	}
	async capturePng(input: Parameters<CompanyComputerGuestCommands["capturePng"]>[0]): Promise<Uint8Array> {
		const copied = { ...input };
		return this.#track(
			(deadline) => this.#capture({ ...copied, signal: AbortSignal.any([copied.signal, deadline]) }),
			20000,
		);
	}

	async #capture(input: Parameters<CompanyComputerGuestCommands["capturePng"]>[0]): Promise<Uint8Array> {
		if (
			input.display !== companyComputerScreenDisplay(this.#binding.screenOrdinal) ||
			!Number.isSafeInteger(input.maxBytes) ||
			input.maxBytes < 33 ||
			input.maxBytes > 16 * 1024 * 1024
		)
			throw new Error("INVALID_OFFICE_CAPTURE");
		const signal = AbortSignal.any([input.signal, this.#stop.signal]);
		await this.#ready(signal);
		const root = await openCompanyComputerLinuxDirectory(this.#captureRoot, true);
		await root.close();
		const directory = await mkdtemp(join(this.#captureRoot, "capture-"));
		try {
			const result = await this.#execute(
				{
					program: "/usr/bin/scrot",
					args: ["--silent", "/qorpera-capture/screen.png"],
					environment: {},
					workingDirectory: this.#layout.workbenchRoot,
					timeoutMs: 5000,
					maxOutputBytes: 4096,
					signal,
				},
				directory,
			);
			if (result.code !== 0) throw new Error("OFFICE_CAPTURE_FAILED");
			const file = await open(join(directory, "screen.png"), constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				const info = await file.stat();
				if (!info.isFile() || info.nlink !== 1 || info.size < 33 || info.size > input.maxBytes)
					throw new Error("INVALID_OFFICE_CAPTURE");
				const bytes = await file.readFile();
				if (bytes.length !== info.size) throw new Error("INVALID_OFFICE_CAPTURE");
				signal.throwIfAborted();
				return Uint8Array.from(bytes);
			} finally {
				await file.close();
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}

	close(): Promise<void> {
		this.#stop.abort();
		this.#closing ??= cloudToolRequest(
			async () => {
				const processes = [...this.#active];
				for (const process of processes) process.stop();
				await Promise.allSettled(processes.map((process) => process.exited));
				await Promise.allSettled([...this.#calls]);
				if (this.#active.size) throw new Error("OFFICE_COMMAND_DRAIN_UNCONFIRMED");
			},
			new AbortController().signal,
			5000,
		);
		return this.#closing;
	}
}
