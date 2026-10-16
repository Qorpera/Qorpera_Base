import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, mkdtemp, open, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { join, resolve } from "node:path";
import {
	assertCompanyComputerScope,
	assertCompanyComputerScreenBinding,
	type CompanyComputerScope,
	type CompanyComputerScreenBinding,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import {
	type CompanyComputerDesktopCompany,
	openCompanyComputerFolderParent,
} from "./cloud-company-computer-desktop-folder.ts";
import type { CompanyComputerGuestBoundary } from "./cloud-company-computer-guest.ts";
import { assertCompanyComputerGuestLayout, type CompanyComputerGuestLayout } from "./cloud-company-computer-layout.ts";
import {
	assertCompanyComputerCommandLimits,
	assertCompanyComputerImageArtifact,
	assertCompanyComputerLinuxHost,
	assertCompanyComputerWorkbenchMount,
	type CompanyComputerCommandLimits,
	companyComputerLinuxSandboxArgs,
	openCompanyComputerLinuxDirectory,
} from "./cloud-company-computer-linux-host.ts";
import {
	COMPANY_COMPUTER_HOSTS,
	COMPANY_COMPUTER_RESOLV_CONF,
	plumbCompanyComputerNetwork,
} from "./cloud-company-computer-linux-network.ts";
import { spawnCompanyComputerLinuxProcess } from "./cloud-company-computer-linux-process.ts";
import {
	type CompanyComputerScreenLauncher,
	type CompanyComputerScreenSessionHandle,
	companyComputerScreenDisplay,
	waitForCompanyComputerScreenReady,
} from "./cloud-company-computer-screens.ts";
import type { RecoveryDirectoryMount } from "./cloud-identity-recovery-filesystems.ts";
import { cloudToolRequest } from "./cloud-native-tool-authority.ts";

interface Desktop {
	binding: CompanyComputerScreenBinding;
	stop: AbortController;
	ready: boolean;
	pending?: Promise<CompanyComputerScreenSessionHandle>;
	handle?: CompanyComputerScreenSessionHandle;
	xSocket?: string;
	rfbSocket?: string;
	sessionDirectory?: string;
	connections: Set<Socket>;
	/** The names of the last notices left for the desktop's watcher, oldest first. */
	notices: string[];
	noticed: number;
}

async function privateChild(parent: FileHandle, name: string): Promise<FileHandle> {
	if (!/^[a-zA-Z0-9-]+$/.test(name)) throw new Error("INVALID_OFFICE_CHILD_DIRECTORY");
	const directory = await open(
		`/proc/self/fd/${parent.fd}/${name}`,
		constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
	);
	try {
		const info = await directory.stat();
		if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
			throw new Error("UNSAFE_OFFICE_DIRECTORY");
		return directory;
	} catch (error) {
		await directory.close();
		throw error;
	}
}

/** Name of the dock launcher's request inside the service-owned session directory (`/run/qorpera` in the desktop). */
export const COMPANY_COMPUTER_BROWSER_REQUEST_FILE = "browser-request";

/**
 * Consume the dock launcher's "open the browser" request. The desktop namespace
 * can write anything into this directory, and this runs as the service outside
 * the sandbox, so the request is only the presence of a regular file: nothing
 * is opened or read, and removal never descends. `unlink` and `rmdir` act on
 * the directory entry itself and never follow a link, so even an entry swapped
 * between the look and the removal costs the desktop only its own entry. What
 * cannot be removed that way (a non-empty directory) is left alone; it merely
 * blocks dock requests on that desktop. Every other fact (which screen, which
 * profile, who may open it) comes from the service and SQL.
 */
export async function takeCompanyComputerBrowserRequest(
	sessionDirectory: string,
	/** Test seam: runs between the look and the removal, where a hostile desktop would swap the entry. */
	afterInspect?: () => Promise<void>,
): Promise<boolean> {
	const path = join(sessionDirectory, COMPANY_COMPUTER_BROWSER_REQUEST_FILE);
	const info = await lstat(path).catch(() => undefined);
	if (!info) return false;
	await afterInspect?.();
	if (info.isDirectory()) {
		await rmdir(path).catch(() => undefined);
		return false;
	}
	const removed = await unlink(path).then(
		() => true,
		() => false,
	);
	return removed && info.isFile();
}

/** Name prefix of the notices the service leaves in the session directory; the desktop's own watcher shows and removes
 * them (`qorpera-screen-xfce`). */
export const COMPANY_COMPUTER_DESKTOP_NOTICE_PREFIX = "folder-notice.";
/** Notices left and not yet taken that a desktop keeps; an older one is removed unseen. */
export const COMPANY_COMPUTER_DESKTOP_NOTICES_KEPT = 4;
const DESKTOP_NOTICE_BYTES = 512;

function assertDesktopNotice(text: string): void {
	if (
		typeof text !== "string" ||
		!text ||
		Buffer.byteLength(text) > DESKTOP_NOTICE_BYTES ||
		/[\x00-\x09\x0b-\x1f\x7f<>&]/.test(text)
	)
		throw new Error("INVALID_OFFICE_DESKTOP_NOTICE");
}

/**
 * Leave a notice in a desktop's session directory for its own watcher (`qorpera-screen-xfce`), which shows it with
 * `notify-send` in the desktop's session and removes it, so the service never enters the desktop. The desktop can
 * write the directory, so nothing there is read and nothing is opened through a link: the text is written whole under
 * a fresh hidden name (`wx`) and renamed into place, so the watcher never takes half of one, and only the newest
 * `COMPANY_COMPUTER_DESKTOP_NOTICES_KEPT` the service left (`left`, the desktop's) are kept, an older one removed by
 * its name. A hostile desktop can only lose its own notices. Plain text of one line or more, without markup.
 */
export async function leaveCompanyComputerDesktopNotice(
	sessionDirectory: string,
	left: { notices: string[]; noticed: number },
	text: string,
): Promise<void> {
	assertDesktopNotice(text);
	const name = `${COMPANY_COMPUTER_DESKTOP_NOTICE_PREFIX}${String(++left.noticed).padStart(12, "0")}.${randomUUID()}`;
	left.notices.push(name);
	const older = left.notices.splice(0, Math.max(0, left.notices.length - COMPANY_COMPUTER_DESKTOP_NOTICES_KEPT));
	await Promise.all(older.map((old) => unlink(join(sessionDirectory, old)).catch(() => undefined)));
	const written = join(sessionDirectory, `.${COMPANY_COMPUTER_DESKTOP_NOTICE_PREFIX}${randomUUID()}`);
	try {
		await writeFile(written, text, { mode: 0o600, flag: "wx" });
		await rename(written, join(sessionDirectory, name));
	} catch (error) {
		await unlink(written).catch(() => undefined);
		throw error;
	}
}

/** Real persistent desktop launcher. Only the admitted supervisor supplies
 * bindings; this is never a native/member tool. Existing adopted screen state
 * and a prepared wallpaper are required. Each Xvnc/XFCE process tree has its
 * own namespaces, while every desktop shares the same noncanonical workbench.
 * Viewers use the private broker socket; no TCP RFB/X listener is exposed. */
export class CompanyComputerLinuxDesktopLauncher implements CompanyComputerScreenLauncher {
	readonly #options: {
		scope: CompanyComputerScope;
		computerGeneration: number;
		layout: CompanyComputerGuestLayout;
		workbenchMount: RecoveryDirectoryMount;
		limits: CompanyComputerCommandLimits;
		runtimeRoot: string;
		boundary: CompanyComputerGuestBoundary;
		plumbSocket?: string;
	};
	readonly #desktops = new Map<number, Desktop>();
	readonly #stop = new AbortController();
	#closing?: Promise<void>;

	constructor(options: {
		scope: CompanyComputerScope;
		computerGeneration: number;
		layout: CompanyComputerGuestLayout;
		workbenchMount: RecoveryDirectoryMount;
		limits: CompanyComputerCommandLimits;
		/** Existing private local directory with root-owned ancestors; never persistent screen state. */
		runtimeRoot: string;
		boundary: CompanyComputerGuestBoundary;
		/** Test seam for the root plumber's socket. */
		plumbSocket?: string;
	}) {
		assertCompanyComputerScope(options.scope, options.scope);
		assertCompanyComputerGuestLayout(options.layout);
		if (!Number.isSafeInteger(options.computerGeneration) || options.computerGeneration < 1)
			throw new Error("INVALID_OFFICE_GENERATION");
		if (
			options.runtimeRoot === "/" ||
			options.runtimeRoot !== resolve(options.runtimeRoot) ||
			options.runtimeRoot.length > 4096 ||
			/[\x00-\x1f\x7f\\]/.test(options.runtimeRoot) ||
			Object.values(options.layout).some(
				(path) =>
					path === options.runtimeRoot ||
					path.startsWith(`${options.runtimeRoot}/`) ||
					options.runtimeRoot.startsWith(`${path}/`),
			)
		)
			throw new Error("UNSAFE_OFFICE_CONTROL_PATH");
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
		this.#options = {
			...options,
			scope: Object.freeze({ ...options.scope }),
			layout: Object.freeze({ ...options.layout }),
			limits: Object.freeze({ ...options.limits }),
			workbenchMount: Object.freeze({ ...options.workbenchMount }),
		};
	}

	async #assertReady(binding: CompanyComputerScreenBinding, signal: AbortSignal): Promise<void> {
		this.#stop.signal.throwIfAborted();
		await cloudToolRequest((checked) => this.#options.boundary.assertReady(binding, checked), signal);
		await assertCompanyComputerLinuxHost(this.#options.limits, signal);
	}

	/** With `company`, the desktop binds that mount's parent and finds the company folder at `/company`. */
	async launch(
		binding: CompanyComputerScreenBinding,
		signal: AbortSignal,
		options: { company?: CompanyComputerDesktopCompany } = {},
	): Promise<CompanyComputerScreenSessionHandle> {
		assertCompanyComputerScreenBinding(binding, binding);
		assertCompanyComputerScope(binding, this.#options.scope);
		if (binding.computerGeneration !== this.#options.computerGeneration)
			throw new Error("OFFICE_GENERATION_MISMATCH");
		this.#stop.signal.throwIfAborted();
		signal.throwIfAborted();
		if (this.#desktops.has(binding.screenOrdinal)) throw new Error("OFFICE_DESKTOP_ALREADY_OCCUPIED");
		const desktop: Desktop = {
			binding: Object.freeze({ ...binding }),
			stop: new AbortController(),
			ready: false,
			connections: new Set(),
			notices: [],
			noticed: 0,
		};
		this.#desktops.set(binding.screenOrdinal, desktop);
		desktop.pending = this.#launch(desktop, signal, options.company);
		try {
			return await cloudToolRequest(() => desktop.pending!, new AbortController().signal, 15000);
		} catch (error) {
			desktop.stop.abort();
			throw error;
		}
	}

	async #launch(
		desktop: Desktop,
		request: AbortSignal,
		company: CompanyComputerDesktopCompany | undefined,
	): Promise<CompanyComputerScreenSessionHandle> {
		const binding = desktop.binding;
		const lifetime = AbortSignal.any([desktop.stop.signal, this.#stop.signal]);
		const startup = AbortSignal.any([request, lifetime]);
		const { layout, runtimeRoot } = this.#options;
		const files: FileHandle[] = [];
		let temporary: string | undefined;
		let ownedByProcess = false;
		const remove = async (): Promise<void> => {
			await Promise.all(files.map((file) => file.close()));
			if (temporary) await rm(temporary, { recursive: true, force: true });
			if (this.#desktops.get(binding.screenOrdinal) === desktop) this.#desktops.delete(binding.screenOrdinal);
		};
		try {
			await this.#assertReady(binding, startup);
			for (const path of [
				"/usr/bin/bwrap",
				"/usr/bin/tini",
				"/usr/bin/bash",
				"/usr/bin/Xtigervnc",
				"/usr/bin/xfce4-session",
				"/usr/local/bin/qorpera-screen-session",
				"/usr/local/bin/qorpera-screen-xfce",
			])
				await assertCompanyComputerImageArtifact(path);
			await assertCompanyComputerImageArtifact("/usr", true);
			files.push(await openCompanyComputerLinuxDirectory(layout.workbenchRoot, false));
			files.push(await openCompanyComputerLinuxDirectory(layout.desktopHome, true));
			const parent = await openCompanyComputerLinuxDirectory(layout.screenStateRoot, true);
			try {
				files.push(await privateChild(parent, binding.screenId));
			} finally {
				await parent.close();
			}
			await assertCompanyComputerWorkbenchMount(files[0], this.#options.workbenchMount, [
				layout.workbenchRoot,
				layout.desktopHome,
				layout.screenStateRoot,
			]);
			const runtime = await openCompanyComputerLinuxDirectory(runtimeRoot, true);
			try {
				temporary = await mkdtemp(join(runtimeRoot, `screen-${binding.screenOrdinal}-`));
			} finally {
				await runtime.close();
			}
			for (const name of ["x11", "session"]) {
				await mkdir(join(temporary, name), { mode: 0o700 });
				files.push(
					await open(join(temporary, name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW),
				);
			}
			await writeFile(join(temporary, "machine-id"), `${randomUUID().replaceAll("-", "")}\n`, {
				mode: 0o400,
				flag: "wx",
			});
			files.push(await open(join(temporary, "machine-id"), constants.O_RDONLY | constants.O_NOFOLLOW));
			// The desktop's own network, for its Terminal and what it starts.
			await writeFile(join(temporary, "hosts"), COMPANY_COMPUTER_HOSTS, { mode: 0o444, flag: "wx" });
			await writeFile(join(temporary, "resolv.conf"), COMPANY_COMPUTER_RESOLV_CONF, { mode: 0o444, flag: "wx" });
			const args = [
				...companyComputerLinuxSandboxArgs(),
				"--bind-fd",
				"3",
				layout.workbenchRoot,
				"--bind-fd",
				"4",
				"/home/qorpera",
				"--bind-fd",
				"5",
				`/screen-state/${binding.screenId}`,
				"--bind-fd",
				"6",
				"/tmp/.X11-unix",
				"--bind-fd",
				"7",
				"/run/qorpera",
				"--ro-bind-fd",
				"8",
				"/etc/machine-id",
				"--size",
				"33554432",
				"--tmpfs",
				"/var/tmp",
				"--ro-bind",
				join(temporary, "hosts"),
				"/etc/hosts",
				"--ro-bind",
				join(temporary, "resolv.conf"),
				"/etc/resolv.conf",
			];
			// The public CA store too: the Terminal's curl, git and the like check certificates against it.
			for (const [path, directory] of [
				["/etc/passwd", false],
				["/etc/group", false],
				["/etc/nsswitch.conf", false],
				["/etc/fonts", true],
				["/etc/xdg", true],
				["/etc/X11", true],
				["/etc/dbus-1", true],
				["/etc/ssl/certs", true],
			] as const) {
				await assertCompanyComputerImageArtifact(path, directory);
				args.push("--ro-bind", path, path);
			}
			// LibreOffice's registry links into /etc/libreoffice; without it LibreOffice cannot start. An image without
			// LibreOffice has none.
			if (await lstat("/etc/libreoffice").catch(() => undefined)) {
				await assertCompanyComputerImageArtifact("/etc/libreoffice", true);
				args.push("--ro-bind", "/etc/libreoffice", "/etc/libreoffice");
			}
			args.push("--symlink", "../usr/lib/os-release", "/etc/os-release");
			if (company) {
				// The mount's parent, not its mountpoint: a mount made again under it reaches this desktop (Q3, #1007).
				files.push(await openCompanyComputerFolderParent(company.name));
				args.push(
					"--bind-fd",
					"9",
					"/run/qorpera-company",
					"--symlink",
					"/run/qorpera-company/company",
					"/company",
				);
			}
			for (const [name, value] of Object.entries({
				HOME: "/home/qorpera",
				PATH: "/usr/local/bin:/usr/bin:/bin",
				LANG: "C.UTF-8",
				QORPERA_WORKBENCH_ROOT: layout.workbenchRoot,
				QORPERA_DESKTOP_HOME: "/home/qorpera",
				QORPERA_SCREEN_STATE_ROOT: "/screen-state",
				QORPERA_SCREEN_RUNTIME_ROOT: "/run/qorpera",
				QORPERA_SCREEN_WALLPAPER: `/screen-state/${binding.screenId}/wallpaper.png`,
				...(company ? { QORPERA_COMPANY_FOLDER: "/company" } : {}),
			}))
				args.push("--setenv", name, value);
			// It starts in its home; the screen session moves into /company when the folder is there (F3 4f-1b).
			args.push("--chdir", "/home/qorpera", "--remount-ro", "/");
			startup.throwIfAborted();
			const launched = spawnCompanyComputerLinuxProcess({
				args,
				files,
				stdin: "ignore",
				// Its own filtered network before the session starts; without the
				// plumber the desktop starts with loopback only.
				beforeStart: async (pid) => {
					await plumbCompanyComputerNetwork({
						ordinal: binding.screenOrdinal,
						role: "desktop",
						pid,
						...(this.#options.plumbSocket ? { socket: this.#options.plumbSocket } : {}),
					});
				},
				command: [
					"/usr/local/bin/qorpera-screen-session",
					binding.screenId,
					String(binding.screenOrdinal),
					companyComputerScreenDisplay(binding.screenOrdinal),
				],
			});
			const { child } = launched;
			ownedByProcess = true;
			desktop.xSocket = join(temporary, "x11", `X${binding.screenOrdinal}`);
			desktop.rfbSocket = join(temporary, "session", binding.screenId, "viewer.sock");
			desktop.sessionDirectory = join(temporary, "session");
			const kill = (): void => {
				desktop.ready = false;
				for (const socket of desktop.connections) socket.destroy();
				launched.stop();
			};
			lifetime.addEventListener("abort", kill, { once: true });
			request.addEventListener("abort", kill, { once: true });
			let recordResolve: () => void = () => undefined;
			let recordReject: (error: Error) => void = () => undefined;
			const record = new Promise<void>((resolveRecord, reject) => {
				recordResolve = resolveRecord;
				recordReject = reject;
			});
			void launched.started.catch((error: Error) => {
				recordReject(error);
				kill();
			});
			let output = Buffer.alloc(0);
			let stderrBytes = 0;
			const expected = `${JSON.stringify({ schema: "qorpera.screen-ready/v1", screenId: binding.screenId, ordinal: binding.screenOrdinal })}\n`;
			child.stdout!.on("data", (bytes: Buffer) => {
				if (output.length + bytes.length > 1024) {
					recordReject(new Error("OFFICE_DESKTOP_INVALID_READY"));
					kill();
					return;
				}
				output = Buffer.concat([output, bytes]);
				if (output.includes(10)) {
					if (output.toString("utf8") !== expected) {
						recordReject(new Error("OFFICE_DESKTOP_INVALID_READY"));
						kill();
					} else recordResolve();
				}
			});
			// Never release desktop logs (which can contain working bytes) to a
			// member/model. Bound the stream and fail the service if it floods.
			child.stderr!.on("data", (bytes: Buffer) => {
				stderrBytes += bytes.length;
				if (stderrBytes > 1048576) kill();
			});
			child.once("error", () => recordReject(new Error("OFFICE_DESKTOP_START_FAILED")));
			const exited = new Promise<void>((resolveExit, reject) => {
				child.once("close", () => {
					desktop.ready = false;
					for (const socket of desktop.connections) socket.destroy();
					request.removeEventListener("abort", kill);
					lifetime.removeEventListener("abort", kill);
					recordReject(new Error("OFFICE_DESKTOP_EXITED"));
					void remove().then(resolveExit, reject);
				});
			});
			void exited.catch(() => undefined);
			const stop = (): Promise<void> => {
				desktop.stop.abort();
				kill();
				return cloudToolRequest(() => exited, new AbortController().signal, 10000);
			};
			const ready = cloudToolRequest(
				async (checked) => {
					await record;
					// Xorg initializes its conventional socket directory as 1777. The
					// outer private directory protects startup; restore broker-only mode
					// before admitting any command or viewer to the ready display.
					await files[3].chmod(0o700);
					await waitForCompanyComputerScreenReady(desktop.rfbSocket!, checked, 2000);
					await this.#assertReady(binding, checked);
					checked.throwIfAborted();
					if (this.#desktops.get(binding.screenOrdinal) !== desktop) throw new Error("OFFICE_DESKTOP_EXITED");
					desktop.ready = true;
					// Startup cancellation does not own the persistent desktop lifetime.
					request.removeEventListener("abort", kill);
				},
				startup,
				15000,
			).catch(async (error) => {
				await stop();
				throw error;
			});
			void ready.catch(() => undefined);
			desktop.handle = { ready, exited, stop };
			if (startup.aborted) kill();
			return desktop.handle;
		} catch (error) {
			if (!ownedByProcess) await remove();
			throw error;
		}
	}

	#live(binding: CompanyComputerScreenBinding): Desktop {
		this.#stop.signal.throwIfAborted();
		const desktop = this.#desktops.get(binding.screenOrdinal);
		if (!desktop?.ready || desktop.stop.signal.aborted) throw new Error("OFFICE_DESKTOP_NOT_READY");
		assertCompanyComputerScreenBinding(binding, desktop.binding);
		return desktop;
	}

	/** Broker-only path for receipt-admitted xdotool/scrot and browser launch. */
	xSocket(binding: CompanyComputerScreenBinding): string {
		return this.#live(binding).xSocket!;
	}

	/** True once per dock-launcher request on this ready desktop; see `takeCompanyComputerBrowserRequest`. */
	async takeBrowserRequest(binding: CompanyComputerScreenBinding): Promise<boolean> {
		return takeCompanyComputerBrowserRequest(this.#live(binding).sessionDirectory!);
	}

	/** Leave a notice for whoever looks at this ready desktop (`leaveCompanyComputerDesktopNotice`). */
	async notify(binding: CompanyComputerScreenBinding, text: string): Promise<void> {
		assertDesktopNotice(text);
		const desktop = this.#live(binding);
		await leaveCompanyComputerDesktopNotice(desktop.sessionDirectory!, desktop, text);
	}

	/** Private raw RFB transport. The caller still applies the existing viewer
	 * admission, input sequencing and output/clipboard filters to this socket. */
	async connectRfb(binding: CompanyComputerScreenBinding, signal: AbortSignal): Promise<Socket> {
		const desktop = this.#live(binding);
		await this.#assertReady(binding, signal);
		if (this.#live(binding) !== desktop) throw new Error("OFFICE_DESKTOP_NOT_READY");
		return cloudToolRequest(
			(checked) =>
				new Promise<Socket>((resolveSocket, reject) => {
					const socket = connect(desktop.rfbSocket!);
					desktop.connections.add(socket);
					const abort = (): void => {
						socket.destroy();
						reject(new Error("OFFICE_DESKTOP_CONNECTION_CANCELLED"));
					};
					checked.addEventListener("abort", abort, { once: true });
					socket.once("error", () => reject(new Error("OFFICE_DESKTOP_RFB_UNAVAILABLE")));
					socket.once("close", () => {
						checked.removeEventListener("abort", abort);
						desktop.connections.delete(socket);
					});
					socket.once("connect", () => {
						try {
							checked.throwIfAborted();
							if (this.#live(binding) !== desktop) throw new Error("OFFICE_DESKTOP_NOT_READY");
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
	}

	/** A timed-out launch can still own pending namespace setup without having
	 * returned a handle. Wait for that exact setup and its physical cleanup. */
	async drain(binding: CompanyComputerScreenBinding): Promise<void> {
		assertCompanyComputerScreenBinding(binding, binding);
		assertCompanyComputerScope(binding, this.#options.scope);
		if (binding.computerGeneration !== this.#options.computerGeneration)
			throw new Error("OFFICE_GENERATION_MISMATCH");
		const desktop = this.#desktops.get(binding.screenOrdinal);
		if (!desktop) return;
		assertCompanyComputerScreenBinding(binding, desktop.binding);
		desktop.stop.abort();
		try {
			await cloudToolRequest(
				async () => {
					await desktop.pending?.catch(() => undefined);
					await desktop.handle?.stop();
					if (this.#desktops.get(binding.screenOrdinal) === desktop) throw new Error("unconfirmed");
				},
				new AbortController().signal,
				15000,
			);
		} catch {
			throw new Error("OFFICE_DESKTOP_DRAIN_UNCONFIRMED");
		}
	}

	close(): Promise<void> {
		this.#stop.abort();
		for (const desktop of this.#desktops.values()) desktop.stop.abort();
		this.#closing ??= cloudToolRequest(
			async () => {
				const desktops = [...this.#desktops.values()];
				await Promise.allSettled(desktops.map((desktop) => desktop.pending));
				await Promise.all(desktops.map((desktop) => desktop.handle?.stop()));
				if (this.#desktops.size) throw new Error("OFFICE_DESKTOP_DRAIN_UNCONFIRMED");
			},
			new AbortController().signal,
			15000,
		);
		return this.#closing;
	}
}
