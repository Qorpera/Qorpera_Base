import { constants } from "node:fs";
import { type FileHandle, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { join, resolve } from "node:path";
import {
	assertCompanyComputerImageArtifact,
	assertCompanyComputerLinuxHost,
	type CompanyComputerCommandLimits,
	companyComputerLinuxSandboxArgs,
	openCompanyComputerLinuxDirectory,
} from "./cloud-company-computer-linux-host.ts";
import { spawnCompanyComputerLinuxProcess } from "./cloud-company-computer-linux-process.ts";
import { companyComputerScreenDisplay, waitForCompanyComputerScreenReady } from "./cloud-company-computer-screens.ts";
import { cloudToolRequest } from "./cloud-native-tool-authority.ts";

/** Fresh X server only. No XFCE, DBus, autostart, persistent HOME, workbench,
 * screen state or other display enters this namespace. Its caller owns the
 * privacy barrier and must drain ordinary desktops before requesting it. */
export async function startCompanyComputerLinuxPrivateDisplay(options: {
	ordinal: number;
	runtimeRoot: string;
	limits: CompanyComputerCommandLimits;
	assertActive(signal: AbortSignal): Promise<void>;
	signal: AbortSignal;
}): Promise<{
	xSocket: string;
	fence(): void;
	connectRfb(signal: AbortSignal): Promise<Socket>;
	exited: Promise<void>;
	close(): Promise<void>;
}> {
	options = { ...options, limits: Object.freeze({ ...options.limits }) };
	const display = companyComputerScreenDisplay(options.ordinal);
	if (
		options.runtimeRoot !== resolve(options.runtimeRoot) ||
		options.runtimeRoot === "/" ||
		/[\x00-\x1f\x7f\\]/.test(options.runtimeRoot)
	)
		throw new Error("INVALID_PRIVATE_DISPLAY_CONFIGURATION");
	const files: FileHandle[] = [];
	const sockets = new Set<Socket>();
	let temporary: string | undefined;
	let launched: ReturnType<typeof spawnCompanyComputerLinuxProcess> | undefined;
	let exited: Promise<void> | undefined;
	let closing: Promise<void> | undefined;
	let ready = false;
	let stopped = false;
	const fence = (): void => {
		ready = false;
		for (const socket of sockets) socket.destroy();
	};
	const kill = (): void => {
		stopped = true;
		fence();
		launched?.stop();
	};
	const remove = async (): Promise<void> => {
		options.signal.removeEventListener("abort", kill);
		await Promise.all(files.map((file) => file.close()));
		if (temporary) await rm(temporary, { recursive: true, force: true });
	};
	const close = (): Promise<void> => {
		kill();
		closing ??= cloudToolRequest(
			async () => {
				if (exited) await exited;
				else await remove();
			},
			new AbortController().signal,
			10000,
		).catch(() => {
			throw new Error("PRIVATE_DISPLAY_DRAIN_UNCONFIRMED");
		});
		return closing;
	};
	try {
		await cloudToolRequest(async (checked) => {
			await options.assertActive(checked);
			await assertCompanyComputerLinuxHost(options.limits, checked);
		}, options.signal);
		for (const path of ["/usr/bin/bwrap", "/usr/bin/tini", "/usr/bin/bash", "/usr/bin/Xtigervnc"])
			await assertCompanyComputerImageArtifact(path);
		const runtime = await openCompanyComputerLinuxDirectory(options.runtimeRoot, true);
		try {
			temporary = await mkdtemp(join(options.runtimeRoot, "private-"));
		} finally {
			await runtime.close();
		}
		for (const name of ["x11", "session"]) {
			await mkdir(join(temporary, name), { mode: 0o700 });
			files.push(
				await open(join(temporary, name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW),
			);
		}
		const xSocket = join(temporary, "x11", `X${options.ordinal}`);
		const rfbSocket = join(temporary, "session", "viewer.sock");
		if (Buffer.byteLength(rfbSocket) > 103 || Buffer.byteLength(xSocket) > 103)
			throw new Error("INVALID_PRIVATE_DISPLAY_CONFIGURATION");
		const args = [
			...companyComputerLinuxSandboxArgs(),
			"--bind-fd",
			"3",
			"/tmp/.X11-unix",
			"--bind-fd",
			"4",
			"/run/qorpera",
			"--size",
			"33554432",
			"--tmpfs",
			"/home/qorpera",
		];
		for (const path of ["/etc/passwd", "/etc/group", "/etc/nsswitch.conf", "/etc/fonts"]) {
			await assertCompanyComputerImageArtifact(path, path === "/etc/fonts");
			args.push("--ro-bind", path, path);
		}
		for (const [name, value] of Object.entries({ HOME: "/home/qorpera", PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }))
			args.push("--setenv", name, value);
		args.push("--chdir", "/home/qorpera", "--remount-ro", "/");
		options.signal.throwIfAborted();
		launched = spawnCompanyComputerLinuxProcess({
			args,
			files,
			stdin: "ignore",
			command: [
				"/usr/bin/Xtigervnc",
				display,
				"-rfbport",
				"-1",
				"-rfbunixpath",
				"/run/qorpera/viewer.sock",
				"-rfbunixmode",
				"0600",
				"-nolisten",
				"tcp",
				"-ac",
				"-noreset",
				"-rendernode",
				"",
				"-SecurityTypes",
				"None",
				"-AlwaysShared",
				"-DisconnectClients=0",
				"-AcceptSetDesktopSize=0",
				"-AcceptCutText=0",
				"-SendCutText=0",
				"-SendPrimary=0",
				"-SetPrimary=0",
				"-AllowOverride",
				"",
				"-geometry",
				"1920x1200",
				"-depth",
				"24",
				"-desktop",
				"Qorpera Private Sign-in",
			],
		});
		options.signal.addEventListener("abort", kill, { once: true });
		let outputBytes = 0;
		// Discard all X output; it must never become an agent or member result.
		for (const stream of [launched.child.stdout!, launched.child.stderr!])
			stream.on("data", (bytes: Buffer) => {
				outputBytes += bytes.length;
				if (outputBytes > 1048576) kill();
			});
		exited = new Promise<void>((resolveExit, reject) => {
			launched!.child.once("close", () => {
				kill();
				void remove().then(resolveExit, reject);
			});
		});
		void exited.catch(() => undefined);
		if (options.signal.aborted) kill();
		await cloudToolRequest(
			async (checked) => {
				await launched!.started;
				await waitForCompanyComputerScreenReady(rfbSocket, checked, 10000);
				await files[0].chmod(0o700);
				await options.assertActive(checked);
				checked.throwIfAborted();
				if (stopped || closing || launched!.child.exitCode !== null || launched!.child.signalCode !== null)
					throw new Error("PRIVATE_DISPLAY_EXITED");
				ready = true;
			},
			options.signal,
			15000,
		);
		return {
			xSocket,
			fence,
			exited,
			close,
			connectRfb: async (signal) => {
				const assertLive = (): void => {
					options.signal.throwIfAborted();
					if (!ready || closing) throw new Error("PRIVATE_DISPLAY_NOT_READY");
				};
				assertLive();
				await cloudToolRequest(options.assertActive, signal, 3000);
				assertLive();
				return cloudToolRequest(
					(checked) =>
						new Promise<Socket>((resolveSocket, reject) => {
							const socket = connect(rfbSocket);
							socket.pause();
							sockets.add(socket);
							const abort = (): void => {
								socket.destroy();
								reject(new Error("PRIVATE_DISPLAY_CONNECTION_CANCELLED"));
							};
							checked.addEventListener("abort", abort, { once: true });
							socket.once("error", () => reject(new Error("PRIVATE_DISPLAY_RFB_UNAVAILABLE")));
							socket.once("close", () => {
								checked.removeEventListener("abort", abort);
								sockets.delete(socket);
								reject(new Error("PRIVATE_DISPLAY_RFB_CLOSED"));
							});
							socket.once("connect", () => {
								try {
									checked.throwIfAborted();
									assertLive();
									checked.removeEventListener("abort", abort);
									resolveSocket(socket);
								} catch {
									abort();
								}
							});
							if (checked.aborted) abort();
						}),
					signal,
					5000,
				);
			},
		};
	} catch (error) {
		await close();
		throw error;
	}
}
