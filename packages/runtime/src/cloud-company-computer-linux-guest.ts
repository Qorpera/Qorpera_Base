import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import {
	assertCompanyComputerLease,
	assertCompanyComputerScope,
	assertCompanyComputerScreenBinding,
	type CompanyComputerScope,
	type CompanyComputerScreenBinding,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import {
	type CompanyComputerPrivacyChallenge,
	parseCompanyComputerPrivacyChallenge,
} from "@qorpera/cloud-client/cloud-company-computer-privacy";
import { parseCompanyComputerViewerGrant } from "@qorpera/cloud-client/cloud-company-computer-viewer";
import type { CompanyComputerFillKey } from "./cloud-company-account-fill-box.ts";
import { CompanyComputerFilledValues } from "./cloud-company-computer-account-fill.ts";
import {
	CloudCompanyComputerBrowserControl,
	CloudCompanyComputerScreenBrowserControl,
	type CompanyComputerScreenBrowserOpener,
} from "./cloud-company-computer-browser-control.ts";
import {
	CompanyComputerBrowserLogins,
	type CompanyComputerLoginContext,
} from "./cloud-company-computer-browser-logins.ts";
import type { CompanyComputerCommandFolders } from "./cloud-company-computer-command-folder.ts";
import { prepareCompanyComputerScreenWallpaper } from "./cloud-company-computer-desktop.ts";
import {
	COMPANY_COMPUTER_CAPTURE_RESTARTED,
	type CompanyComputerDesktopCompany,
	type CompanyComputerDesktopFolders,
	type CompanyComputerScreenHolder,
} from "./cloud-company-computer-desktop-folder.ts";
import { CompanyComputerGuestEndpoint } from "./cloud-company-computer-endpoint.ts";
import {
	type CompanyComputerBrowserSession,
	CompanyComputerGuestAutomation,
	type CompanyComputerGuestBoundary,
	type CompanyComputerScreenshotPublisher,
	PersistentCompanyComputerBrowser,
} from "./cloud-company-computer-guest.ts";
import { CompanyComputerHookCaptureBoxes } from "./cloud-company-computer-hook-capture.ts";
import { assertCompanyComputerGuestLayout, type CompanyComputerGuestLayout } from "./cloud-company-computer-layout.ts";
import {
	CompanyComputerActionFailedError,
	type CompanyComputerScreenActionGate,
	companyComputerActionCheck,
} from "./cloud-company-computer-leases.ts";
import { createCompanyComputerLinuxBrowserLaunch } from "./cloud-company-computer-linux-browser.ts";
import { CompanyComputerLinuxCommands } from "./cloud-company-computer-linux-commands.ts";
import { CompanyComputerLinuxDesktopLauncher } from "./cloud-company-computer-linux-desktop.ts";
import type { CompanyComputerCommandLimits } from "./cloud-company-computer-linux-host.ts";
import { startCompanyComputerLinuxPrivateSurface } from "./cloud-company-computer-linux-private-surface.ts";
import {
	CompanyComputerLinuxShell,
	CompanyComputerShellPressureGuard,
	type CompanyComputerShellReport,
	companyComputerShellBusy,
	createCompanyComputerLinuxShellLauncher,
	readCompanyComputerShellUsage,
} from "./cloud-company-computer-linux-shell.ts";
import { parseCompanyComputerNativeDescriptor } from "./cloud-company-computer-native-client.ts";
import {
	CompanyComputerGuestSessionRefusedError,
	type CompanyComputerNativeGuestSession,
} from "./cloud-company-computer-native-gateway.ts";
import { CloudCompanyComputerPrivateSurfaceControl } from "./cloud-company-computer-private-surface-control.ts";
import {
	COMPANY_COMPUTER_REGISTRY_REQUEST_MAX_BYTES,
	COMPANY_COMPUTER_UNANSWERED_GRACE_MS,
	companyComputerAuthorityUnanswered,
	type HttpCloudCompanyComputerRegistry,
} from "./cloud-company-computer-registry-http.ts";
import type {
	CompanyComputerScreenLifecycle,
	CompanyComputerScreenLifetime,
	ScreenClosingReason,
} from "./cloud-company-computer-screen-lifecycle.ts";
import type { CompanyComputerScreenSessionHandle } from "./cloud-company-computer-screens.ts";
import type { CompanyComputerServiceGuest } from "./cloud-company-computer-service.ts";
import { CloudCompanyComputerSharedSurfaceControl } from "./cloud-company-computer-shared-surface-control.ts";
import { CompanyComputerSiteStops } from "./cloud-company-computer-site-stops.ts";
import type { CompanyComputerFolderRefusal } from "./cloud-company-computer-tools.ts";
import type { RecoveryDirectoryMount } from "./cloud-identity-recovery-filesystems.ts";
import { type CloudNativeToolRun, cloudToolRequest } from "./cloud-native-tool-authority.ts";

interface NativeSession {
	binding: CompanyComputerScreenBinding;
	stop: AbortController;
	close(): Promise<void>;
}
/** The screen's one browser. It belongs to the desktop, like any window on it:
 * agent runs attach to it and detach, members use it through their viewer. It
 * stays open while SQL keeps its grant; its network only while somebody
 * entitled is present (see `#ensureBrowser`). */
interface ScreenBrowser {
	manager: PersistentCompanyComputerBrowser;
	opening?: Promise<CompanyComputerBrowserSession>;
	detachLogins?: () => Promise<void>;
	closing?: Promise<void>;
}
/**
 * Bring a minimised browser window back, without choosing a tab for the member:
 * only the window state changes (CDP refuses minimised to maximised directly,
 * so it goes through normal). Raising a window that is merely covered is the
 * dock launcher's part, which sees the desktop's windows; this one cannot fail
 * the request it serves.
 */
export async function restoreCompanyComputerBrowserWindow(
	context: CompanyComputerBrowserSession["context"],
	signal: AbortSignal,
): Promise<void> {
	await cloudToolRequest(
		async () => {
			const page = context.pages()[0];
			if (!page) return;
			const session = await context.newCDPSession(page);
			try {
				const { windowId, bounds } = await session.send("Browser.getWindowForTarget");
				if (bounds.windowState !== "minimized") return;
				await session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
				await session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "maximized" } });
			} finally {
				await session.detach().catch(() => undefined);
			}
		},
		signal,
		2000,
	).catch(() => undefined);
}
interface SharedScreen {
	binding: CompanyComputerScreenBinding;
	stop: AbortController;
	opening: Promise<void>;
	handle?: CompanyComputerScreenSessionHandle;
	closing?: Promise<void>;
	timer?: ReturnType<typeof setTimeout>;
	/** Polls the dock launcher's request file while the desktop is ready. */
	requests?: ReturnType<typeof setTimeout>;
	browser?: ScreenBrowser;
	/** The screen agent's long-running shell; its commands outlive runs, not the screen. */
	shell?: CompanyComputerLinuxShell;
	lifecycle?: CompanyComputerScreenLifetime;
	/** The mount of the company folder the running desktop binds (`CompanyComputerDesktopCompany.epoch`), if any. */
	companyEpoch?: number;
	/** Counts the desktop's starts on this screen: a run's commands and browser belong to one of them. */
	desktop: number;
}
interface PrivateSurface {
	challenge: CompanyComputerPrivacyChallenge;
	stop: AbortController;
	opening: ReturnType<typeof startCompanyComputerLinuxPrivateSurface>;
	closing?: Promise<void>;
	lifecycle?: CompanyComputerScreenLifetime;
	timer?: ReturnType<typeof setTimeout>;
}

/** One physical Linux office, owned by the headless service. Native sessions
 * bind adapters without effects; first physical preparation occurs inside the
 * admitted endpoint. Desktop lifetime survives native session/viewer closure.
 * Privacy and resource drains own all pending starts as well as ready handles. */
export interface CompanyComputerLinuxGuestOptions {
	scope: CompanyComputerScope;
	computerGeneration: number;
	/** This service's boot key for company account fills (A1-3); without it a vault_fill is refused. */
	fillKey?: CompanyComputerFillKey;
	layout: CompanyComputerGuestLayout;
	limits: CompanyComputerCommandLimits;
	workbenchMount: RecoveryDirectoryMount;
	privateWorkbenchMount: RecoveryDirectoryMount;
	displayRuntimeRoot: string;
	browserRuntimeRoot: string;
	captureRoot: string;
	/** Optional provider-configured IANA zone for the desktop's local day; absent keeps the image default (UTC). */
	desktopTimeZone?: string;
	registry: Pick<HttpCloudCompanyComputerRegistry, "call">;
	/** Required by the production service composition; physical-only fixtures can omit this port. */
	screenLifecycle?: CompanyComputerScreenLifecycle;
	/** Verify adopted VM/image/mount identity. This does not assert that an X display already exists. */
	boundary: CompanyComputerGuestBoundary;
	screenshots: (run: CloudNativeToolRun) => CompanyComputerScreenshotPublisher;
	/** Each desktop's mount of the company folder (F3 4d); without the folder helper, desktops have no `/company`. */
	folders?: CompanyComputerDesktopFolders;
	/** Each shell command's mount of the company folder (F3 4d); without the folder helper, shells have no `/company`. */
	commandFolders?: CompanyComputerCommandFolders;
	onFailure(error: Error): void;
}

/** Shell reports in a row (30 s apart) after which ends the registry keeps refusing are let go. */
const SHELL_REPORT_ATTEMPTS = 10;
/** The most commands of each kind (open, ended) one report names for a screen. */
const SHELL_REPORT_ITEMS = 64;

/** One screen's shell in a report: whole when its lists name every command it has, open and ended. */
export interface CompanyComputerShellReportScreen {
	screenId: string;
	busy: boolean;
	whole: boolean;
	open: CompanyComputerShellReport["open"];
	ended: CompanyComputerShellReport["ended"];
}

/**
 * Fits a shell report into one registry request of at most maxBytes for its
 * screens (the transport's bound less the rest of the request). Every screen
 * and whether it was busy always go; then the ends the platform has not heard
 * of, oldest first, then the open commands, latest worked first, as many as
 * fit, at most SHELL_REPORT_ITEMS of each kind a screen. A screen whose lists
 * were cut is not whole, so the platform ends none of its commands for being
 * missing; ends that did not fit go with a later report.
 */
export function fitCompanyComputerShellReport(
	screens: readonly {
		screenId: string;
		busy: boolean;
		open: CompanyComputerShellReport["open"];
		ended: CompanyComputerShellReport["ended"];
	}[],
	maxBytes: number,
): CompanyComputerShellReportScreen[] {
	const fitted = screens.map(({ screenId, busy }) => ({
		screenId,
		busy,
		whole: false,
		open: [] as CompanyComputerShellReport["open"],
		ended: [] as CompanyComputerShellReport["ended"],
	}));
	// Each screen with empty lists, and a comma; "false" is the longer flag, so the count stays an upper bound.
	let bytes = 2 + fitted.reduce((sum, screen) => sum + Buffer.byteLength(JSON.stringify(screen)) + 1, 0);
	const fits = (list: readonly unknown[], item: unknown): boolean => {
		const cost = Buffer.byteLength(JSON.stringify(item)) + 1;
		if (list.length >= SHELL_REPORT_ITEMS || bytes + cost > maxBytes) return false;
		bytes += cost;
		return true;
	};
	const ends = screens
		.flatMap((screen, index) => screen.ended.map((item) => ({ index, item })))
		.sort((a, b) => a.item.endedAt.localeCompare(b.item.endedAt));
	for (const { index, item } of ends) if (fits(fitted[index].ended, item)) fitted[index].ended.push(item);
	const open = screens
		.flatMap((screen, index) => screen.open.map((item) => ({ index, item })))
		.sort((a, b) => b.item.workedAt.localeCompare(a.item.workedAt));
	for (const { index, item } of open) if (fits(fitted[index].open, item)) fitted[index].open.push(item);
	for (const [index, screen] of fitted.entries())
		screen.whole =
			screen.open.length === screens[index].open.length && screen.ended.length === screens[index].ended.length;
	return fitted;
}

export class CompanyComputerLinuxGuest implements CompanyComputerServiceGuest {
	readonly #options: CompanyComputerLinuxGuestOptions;
	readonly #desktop: CompanyComputerLinuxDesktopLauncher;
	readonly #sharedControl: CloudCompanyComputerSharedSurfaceControl;
	readonly #privateControl: CloudCompanyComputerPrivateSurfaceControl;
	readonly #screenBrowserControl: CloudCompanyComputerScreenBrowserControl;
	readonly #stop = new AbortController();
	readonly #screens = new Map<number, SharedScreen>();
	/** The secrets typed on each screen, kept while this service runs: a screen's tabs outlive its runs. */
	readonly #filled = new Map<number, CompanyComputerFilledValues>();
	/** The sites this computer stopped on (A1-4c), for all its screens while the service runs. */
	readonly #siteStops = new CompanyComputerSiteStops();
	readonly #sessions = new Set<NativeSession>();
	/** The company's one set of website sign-ins, shared by every agent's browser. */
	readonly #logins: CompanyComputerBrowserLogins;
	#private?: PrivateSurface;
	#privacy?: CompanyComputerPrivacyChallenge;
	/** Confirmed shared version while the registry retains no challenge. */
	#sharedVersion = 0;
	#gate?: CompanyComputerScreenActionGate;
	#closing?: Promise<void>;
	/** Whether the last shell report named a busy screen or an open command. */
	#shellReported = false;
	/** Shell reports the registry refused or did not answer, in a row. */
	#shellReportFailures = 0;
	/** Each screen's last processor sample of its shell's namespace, for its busy measure. */
	readonly #shellSamples = new Map<string, { pid: number; cpuTicks: number; ioBytes: number; at: number }>();
	/** Shells closed with their screens, whose last commands the platform has not heard of yet. */
	#closedShells: { screenId: string; shell: CompanyComputerLinuxShell }[] = [];
	readonly #shellActivity: ReturnType<typeof setInterval>;
	/** Ends the heaviest shell before the machine runs out of memory or tasks. */
	readonly #shellPressure: CompanyComputerShellPressureGuard;

	constructor(options: CompanyComputerLinuxGuestOptions) {
		assertCompanyComputerScope(options.scope, options.scope);
		assertCompanyComputerGuestLayout(options.layout);
		this.#options = {
			...options,
			scope: Object.freeze({ ...options.scope }),
			layout: Object.freeze({ ...options.layout }),
			limits: Object.freeze({ ...options.limits }),
			workbenchMount: Object.freeze({ ...options.workbenchMount }),
			privateWorkbenchMount: Object.freeze({ ...options.privateWorkbenchMount }),
		};
		this.#sharedControl = new CloudCompanyComputerSharedSurfaceControl({ ...options, control: options.registry });
		this.#privateControl = new CloudCompanyComputerPrivateSurfaceControl({ ...options, control: options.registry });
		this.#screenBrowserControl = new CloudCompanyComputerScreenBrowserControl({
			...options,
			control: options.registry,
		});
		// Layout version 2 keeps the company's sign-ins in the company root, which a
		// later generation carries over; version 1 offices keep them beside the profiles.
		this.#logins = new CompanyComputerBrowserLogins({
			path:
				this.#options.layout.companyRoot !== undefined
					? join(this.#options.layout.companyRoot, "browser-logins.json")
					: join(this.#options.layout.browserProfilesRoot, "company-logins.json"),
		});
		this.#desktop = new CompanyComputerLinuxDesktopLauncher({
			...this.#options,
			runtimeRoot: options.displayRuntimeRoot,
			boundary: {
				assertReady: async (binding, signal) => {
					await this.#assertShared(binding, signal);
				},
			},
		});
		this.#shellActivity = setInterval(() => void this.#reportShellActivity(), 30000);
		this.#shellActivity.unref?.();
		this.#shellPressure = new CompanyComputerShellPressureGuard({
			shells: () => [...this.#screens.values()].flatMap((screen) => (screen.shell ? [screen.shell] : [])),
		});
	}

	/**
	 * Every 30 seconds the office tells the platform about each screen's shell:
	 * whether it was busy since the last sample (the one idle rule: about 5% of
	 * one core, or about 17 KB a second read or written by its commands), the
	 * commands still open, and those that ended since, each with the run that
	 * started it, as many as fit one request (fitCompanyComputerShellReport).
	 * A busy shell is demand: SQL keeps the computer on,
	 * and the screen with its agent, while a report is fresh (90 seconds). A
	 * shell that only waits is not; when the computer sleeps, its commands end
	 * and their runs are told. A registry without the report (older kernel)
	 * only loses that demand, never a command.
	 */
	async #reportShellActivity(): Promise<void> {
		// One entry per screen: its open shell, and shells closed with it whose
		// last ends the platform has not heard of yet.
		const entries = new Map<string, { shell?: CompanyComputerLinuxShell; closed: CompanyComputerLinuxShell[] }>();
		for (const screen of this.#screens.values())
			if (screen.shell) entries.set(screen.binding.screenId, { shell: screen.shell, closed: [] });
		for (const { screenId, shell } of this.#closedShells) {
			const entry = entries.get(screenId) ?? { closed: [] };
			// A screen still draining holds the shell it just closed.
			if (entry.shell !== shell) entry.closed.push(shell);
			entries.set(screenId, entry);
		}
		const pids = [...entries.values()].flatMap(({ shell }) =>
			shell?.namespacePid !== undefined ? [shell.namespacePid] : [],
		);
		const usage = pids.length ? await readCompanyComputerShellUsage(pids).catch(() => undefined) : undefined;
		const at = Date.now();
		const screens = [...entries].map(([screenId, { shell, closed }]) => {
			const pid = shell?.namespacePid;
			const now = pid === undefined ? undefined : usage?.get(pid);
			const before = this.#shellSamples.get(screenId);
			// The first sample of a namespace is never busy, as on coding machines.
			const busy =
				!!now &&
				before !== undefined &&
				before.pid === pid &&
				companyComputerShellBusy(before, { cpuTicks: now.cpuTicks, ioBytes: now.ioBytes, at });
			if (pid !== undefined && now)
				this.#shellSamples.set(screenId, { pid, cpuTicks: now.cpuTicks, ioBytes: now.ioBytes, at });
			else this.#shellSamples.delete(screenId);
			const report: CompanyComputerShellReport | undefined = shell?.report();
			return {
				screenId,
				busy,
				open: report?.open ?? [],
				ended: [...(report?.ended ?? []), ...closed.flatMap((old) => old.report().ended)],
				shells: shell ? [shell, ...closed] : closed,
			};
		});
		const speaks = screens.some((screen) => screen.busy || screen.open.length > 0 || screen.ended.length > 0);
		if (!speaks && !this.#shellReported) return;
		// One request, whatever the screens hold: what does not fit goes with a later report.
		const request = {
			p_scope: this.#options.scope,
			p_computer_generation: this.#options.computerGeneration,
			p_report: { schema: "qorpera.office-shell-report/v1", screens: [] as CompanyComputerShellReportScreen[] },
		};
		const fitted = fitCompanyComputerShellReport(
			screens,
			COMPANY_COMPUTER_REGISTRY_REQUEST_MAX_BYTES - Buffer.byteLength(JSON.stringify(request)),
		);
		request.p_report.screens = fitted;
		const reported = fitted.map((screen, index) => ({ ended: screen.ended, shells: screens[index].shells }));
		let response: unknown;
		try {
			response = await this.#options.registry.call(
				"qorpera_report_runtime_office_shell_activity",
				request,
				this.#stop.signal,
			);
		} catch {
			// The next report tries again; sleep ends what is still open. Ends that
			// still fail after SHELL_REPORT_ATTEMPTS reports are let go, so that
			// nothing in them can hold up the computer's demand for long.
			if (++this.#shellReportFailures >= SHELL_REPORT_ATTEMPTS) this.#shellReportsDone(reported);
			return;
		}
		this.#shellReportsDone(reported);
		this.#shellReported = screens.some((screen) => screen.busy || screen.open.length > 0);
		// The operator paused the company: nothing keeps running in a shell. The
		// report ended every command as paused, and new commands are refused until the pause ends.
		if (typeof response !== "object" || response === null || (response as { paused?: unknown }).paused !== true)
			return;
		this.#shellReported = false;
		await Promise.all(
			[...this.#screens.values()].map((screen) =>
				screen.shell
					?.pause("Stopped because the company was paused; start the command again when work resumes.")
					.catch(() => undefined),
			),
		);
	}

	/** The ends a report carried are done with: delivered, or let go after repeated failures. */
	#shellReportsDone(
		screens: readonly { ended: readonly { id: string }[]; shells: readonly CompanyComputerLinuxShell[] }[],
	): void {
		this.#shellReportFailures = 0;
		for (const screen of screens)
			for (const shell of screen.shells) shell.reported(screen.ended.map((ended) => ended.id));
		this.#closedShells = this.#closedShells.filter(({ shell }) => shell.report().ended.length > 0);
	}

	/** The screen agent's shell, created on first use. Its namespace starts with the first command. */
	#screenShell(screen: SharedScreen): CompanyComputerLinuxShell {
		if (screen.closing || screen.stop.signal.aborted) throw new Error("OFFICE_SCREEN_DRAINING");
		const binding = screen.binding;
		const folders = this.#options.commandFolders;
		screen.shell ??= new CompanyComputerLinuxShell(
			createCompanyComputerLinuxShellLauncher({
				...this.#options,
				binding,
				runtimeRoot: this.#options.displayRuntimeRoot,
				timeZone: this.#options.desktopTimeZone,
				company: folders !== undefined,
				boundary: {
					assertReady: async (exact, signal) => {
						await this.#assertShared(exact, AbortSignal.any([signal, screen.stop.signal]));
					},
				},
			}),
			folders ? { folders, environmentId: binding.environmentId, screenId: binding.screenId } : {},
		);
		return screen.shell;
	}
	#fail(cause?: unknown): void {
		void this.close().catch(() => undefined);
		try {
			this.#options.onFailure(new Error("OFFICE_GUEST_FAILED", { cause }));
		} catch {
			/* Cleanup remains owned even if its observer throws. */
		}
	}
	#binding(binding: CompanyComputerScreenBinding): void {
		this.#stop.signal.throwIfAborted();
		assertCompanyComputerScreenBinding(binding, binding);
		assertCompanyComputerScope(binding, this.#options.scope);
		if (binding.computerGeneration !== this.#options.computerGeneration)
			throw new Error("OFFICE_GENERATION_MISMATCH");
	}
	async #assertShared(binding: CompanyComputerScreenBinding, signal: AbortSignal) {
		this.#binding(binding);
		if (this.#private || this.#privacy?.state === "entering") throw new Error("OFFICE_PRIVACY_FENCED");
		const combined = AbortSignal.any([signal, this.#stop.signal]);
		await this.#options.boundary.assertReady(binding, combined);
		const state = await this.#sharedControl.check(binding, combined);
		combined.throwIfAborted();
		if (this.#private || state.privacyVersion !== Math.max(this.#privacy?.version ?? 0, this.#sharedVersion))
			throw new Error("OFFICE_PRIVACY_FENCED");
		return state;
	}
	/**
	 * Reuse or start the screen's desktop. With a holder, the screen's mount of the company folder takes the holder's
	 * view first (F3 4d, "A desktop's mount"). A run whose view the core refused, or did not open by `replyBy`
	 * (performance.now()), gets that answer and no desktop; a member keeps the desktop, without `/company` when it
	 * starts now. A run's desktop that runs on an older mount, or on none, starts again on the new one.
	 */
	async #ensureScreen(
		binding: CompanyComputerScreenBinding,
		signal: AbortSignal,
		holder?: CompanyComputerScreenHolder,
		replyBy?: number,
	): Promise<CompanyComputerFolderRefusal | undefined> {
		await this.#assertShared(binding, signal);
		const folders = this.#options.folders;
		let company: CompanyComputerDesktopCompany | undefined;
		if (folders && holder) {
			// A mount that no desktop will use goes, unless one starts or the screen is held again first. The release
			// runs after the screen's helper requests before it, so it also finds a mount made after its caller left.
			const unused = (): void => {
				if (!this.#screens.has(binding.screenOrdinal))
					folders.releaseLater(binding.screenId, () => !this.#screens.has(binding.screenOrdinal));
			};
			const held = await folders
				.hold(binding, holder, AbortSignal.any([signal, this.#stop.signal]), replyBy ?? performance.now() + 5000)
				.catch((error: unknown) => {
					// Cancelled while the helper works on.
					unused();
					throw error;
				});
			if (!("code" in held)) company = held;
			else if (holder.kind === "run") {
				unused();
				return held;
			}
		} else company = folders?.mounted(binding.screenId);
		let screen = this.#screens.get(binding.screenOrdinal);
		if (screen) {
			assertCompanyComputerScreenBinding(binding, screen.binding);
			if (screen.closing || screen.stop.signal.aborted) throw new Error("OFFICE_SCREEN_DRAINING");
		} else {
			const current: SharedScreen = {
				binding: Object.freeze({ ...binding }),
				stop: new AbortController(),
				opening: Promise.resolve(),
				lifecycle: this.#options.screenLifecycle?.create(binding, null),
				companyEpoch: company?.epoch,
				desktop: 0,
			};
			this.#screens.set(binding.screenOrdinal, current);
			// A desktop start belongs to the office, not to whoever asked first: a
			// viewer that gives up, or whose gateway deadline passes, must not cancel
			// a start the next caller would simply have to repeat.
			const startup = AbortSignal.any([this.#stop.signal, current.stop.signal]);
			current.opening = (async () => {
				await current.lifecycle?.requested(startup);
				// The backdrop is the agent's own avatar. An office whose database has
				// not yet learned this read keeps the id-derived figure; a missing
				// avatar never blocks the desktop.
				const appearance = await this.#sharedControl.appearance(binding, startup).catch(() => undefined);
				startup.throwIfAborted();
				await prepareCompanyComputerScreenWallpaper(
					{
						binding,
						creature: appearance?.creature,
						templateId: appearance?.templateId,
						layout: this.#options.layout,
						timeZone: this.#options.desktopTimeZone,
						boundary: {
							assertReady: async (exact, checked) => {
								await this.#assertShared(exact, checked);
							},
						},
					},
					startup,
				);
				const handle = await this.#desktop.launch(binding, startup, { company });
				current.handle = handle;
				await handle.ready;
				startup.throwIfAborted();
				this.#watchDesktop(current, handle);
				await current.lifecycle?.ready(startup);
				startup.throwIfAborted();
				let confirmedAt = performance.now();
				const renew = (): void => {
					if (current.closing || this.#closing) return;
					current.timer = setTimeout(() => {
						void cloudToolRequest(
							async (checked) => {
								await this.#assertShared(binding, checked);
							},
							AbortSignal.any([this.#stop.signal, current.stop.signal]),
							3000,
						).then(
							async () => {
								confirmedAt = performance.now();
								await current.lifecycle
									?.heartbeat(AbortSignal.any([this.#stop.signal, current.stop.signal]))
									.catch(() => undefined);
								renew();
							},
							(pulseError) => {
								if (this.#screens.get(binding.screenOrdinal) !== current || current.closing) return;
								// A check that got no answer keeps the desktop and its apps. It
								// authorizes nothing meanwhile: every agent action, viewer input
								// and browser connection asks again for itself. Only a clear
								// refusal, or no answer for the whole grace, ends the desktop.
								if (
									companyComputerAuthorityUnanswered(pulseError) &&
									performance.now() - confirmedAt < COMPANY_COMPUTER_UNANSWERED_GRACE_MS
								) {
									renew();
									return;
								}
								void this.stopResources(binding, new AbortController().signal, {
									reason: "AUTHORITY_LOST",
								}).catch((error) =>
									this.#fail(
										new Error("OFFICE_SHARED_PULSE_FAILED", {
											cause: new AggregateError([pulseError, error]),
										}),
									),
								);
							},
						);
					}, 1000);
				};
				renew();
				this.#watchBrowserRequests(current);
			})().catch(async (error) => {
				current.stop.abort();
				await current.lifecycle
					?.failed("DESKTOP_START_FAILED", new AbortController().signal)
					.catch(() => undefined);
				try {
					if (current.handle) await current.handle.stop();
					else await this.#desktop.drain(binding);
				} catch (drainError) {
					await current.lifecycle
						?.failed("DESKTOP_DRAIN_UNCONFIRMED", new AbortController().signal)
						.catch(() => undefined);
					throw drainError;
				}
				await current.lifecycle?.closed(new AbortController().signal).catch(() => undefined);
				// Confirmed reaped: the next request starts a fresh desktop instead of
				// finding this failed one forever.
				if (this.#screens.get(binding.screenOrdinal) === current) this.#screens.delete(binding.screenOrdinal);
				void folders?.release(binding.screenId, () => !this.#screens.has(binding.screenOrdinal));
				throw error;
			});
			void current.opening.catch(() => undefined);
			screen = current;
		}
		for (;;) {
			const opening = screen.opening;
			await cloudToolRequest(() => opening, signal, 20000);
			signal.throwIfAborted();
			if (screen.opening !== opening) continue;
			if (!screen.handle) {
				// A desktop that rule 4's way out stopped starts again for whoever comes next: on the holder's mount if
				// it is still the screen's, and for anyone else on the screen's mount as it is now.
				const now = folders?.mounted(binding.screenId);
				company = !holder || (company && now?.epoch === company.epoch) ? now : undefined;
			} else if (!company || holder?.kind !== "run" || screen.companyEpoch === company.epoch) break;
			if (screen.closing || screen.stop.signal.aborted) throw new Error("OFFICE_SCREEN_DRAINING");
			screen.opening = this.#relaunch(screen, company);
			void screen.opening.catch(() => undefined);
		}
		await this.#assertShared(binding, signal);
	}

	/** A desktop that exits by itself fails the office; one its screen stopped (a drain, a new mount) does not. */
	#watchDesktop(screen: SharedScreen, handle: CompanyComputerScreenSessionHandle): void {
		void handle.exited.then(
			() => {
				if (screen.handle === handle && !screen.closing && !screen.stop.signal.aborted && !this.#closing) {
					void screen.lifecycle
						?.failed("DESKTOP_EXITED", new AbortController().signal)
						.then(() => screen.lifecycle?.closed(new AbortController().signal))
						.catch(() => undefined);
					this.#fail(new Error("OFFICE_DESKTOP_EXITED"));
				}
			},
			(error) => {
				void screen.lifecycle
					?.failed("DESKTOP_DRAIN_UNCONFIRMED", new AbortController().signal)
					.catch(() => undefined);
				this.#fail(new Error("OFFICE_DESKTOP_DRAIN_UNCONFIRMED", { cause: error }));
			},
		);
	}

	/**
	 * Start the screen's desktop again, on the screen's current mount when it has one: a mount made again never
	 * reaches a desktop that runs on the old one (Q3, #1007). A start that fails drains the screen.
	 */
	async #relaunch(screen: SharedScreen, company: CompanyComputerDesktopCompany | undefined): Promise<void> {
		const startup = AbortSignal.any([this.#stop.signal, screen.stop.signal]);
		try {
			await this.#stopDesktop(screen);
			startup.throwIfAborted();
			const handle = await this.#desktop.launch(screen.binding, startup, { company });
			screen.handle = handle;
			await handle.ready;
			startup.throwIfAborted();
			screen.companyEpoch = company?.epoch;
			this.#watchDesktop(screen, handle);
		} catch (error) {
			void this.stopResources(screen.binding, new AbortController().signal, { reason: "AUTHORITY_LOST" }).catch(
				(drainError) =>
					this.#fail(
						new Error("OFFICE_DESKTOP_RESTART_FAILED", { cause: new AggregateError([error, drainError]) }),
					),
			);
			throw error;
		}
	}

	/** The screen's desktop stops: its windows and its browser end, as at a restart; its shell and the commands in it
	 * go on. A run's commands and browser belong to the desktop that stopped. */
	async #stopDesktop(screen: SharedScreen): Promise<void> {
		await this.#closeBrowser(screen);
		screen.browser = undefined;
		const old = screen.handle;
		screen.handle = undefined;
		screen.companyEpoch = undefined;
		screen.desktop++;
		await old?.stop();
	}

	/**
	 * Rule 4's way out on the screen's mount (`CompanyComputerDesktopFolders.capture`): the desktop that uses it stops
	 * before the mount goes, after the screen's start or restart under way, and starts again for whoever comes next. A
	 * screen being drained stops its desktop itself. A stop that fails drains the screen: the mount goes once the drain
	 * confirms the desktop and its browser gone, and stays for the stop control when it cannot.
	 */
	#stopForRefusal(screen: SharedScreen): Promise<void> {
		// Not inside the screen's opening: the drain waits for that.
		if (screen.closing) return screen.closing;
		const before = screen.opening;
		const stopping = (async () => {
			await before.catch(() => undefined);
			if (this.#screens.get(screen.binding.screenOrdinal) !== screen) return;
			await this.#stopDesktop(screen);
		})();
		screen.opening = stopping;
		return stopping.catch((error: unknown) => {
			void this.stopResources(screen.binding, new AbortController().signal, { reason: "AUTHORITY_LOST" }).catch(
				(drainError) =>
					this.#fail(new Error("OFFICE_DESKTOP_STOP_FAILED", { cause: new AggregateError([error, drainError]) })),
			);
			throw error;
		});
	}

	/** The secrets typed on one screen, one store per screen for this service's lifetime. */
	#filledOn(screenOrdinal: number): CompanyComputerFilledValues {
		let filled = this.#filled.get(screenOrdinal);
		if (!filled) {
			filled = new CompanyComputerFilledValues();
			this.#filled.set(screenOrdinal, filled);
		}
		return filled;
	}

	/**
	 * The dock's browser icon touches an empty file in the service-owned session
	 * directory. The file says only "open the browser on this screen"; which
	 * profile that is and whether anybody present may open it is decided by SQL
	 * (`CloudCompanyComputerScreenBrowserControl`). A refusal or failure is
	 * silent here: the launcher tells the person at the screen after its wait.
	 */
	#watchBrowserRequests(screen: SharedScreen): void {
		const poll = (): void => {
			if (screen.closing || screen.stop.signal.aborted || this.#closing || this.#stop.signal.aborted) return;
			screen.requests = setTimeout(() => {
				void Promise.resolve()
					.then(() => this.#desktop.takeBrowserRequest(screen.binding))
					.then(async (requested) => {
						if (!requested || screen.closing || screen.stop.signal.aborted) return;
						await this.#ensureBrowser(
							screen.binding,
							"desktop",
							AbortSignal.any([this.#stop.signal, screen.stop.signal]),
						);
					})
					.catch(() => undefined)
					.then(poll);
			}, 500);
		};
		poll();
	}

	/**
	 * Open, or join, the one browser of this screen. No run and no viewer owns the
	 * process, so a run ending or a viewer closing does not by itself stop it. The
	 * egress relay asks SQL every second. Once no agent holds the lease and no
	 * member with input permission is live on the screen (after SQL's tolerance of
	 * at most a minute for a network blip), SQL answers `idle`: the window stays
	 * on the desktop, like any app between runs, with its network paused until
	 * somebody entitled is back. A refusal closes it, and so do a drain, the
	 * privacy fence, a lost grant and the service. A check that gets no answer
	 * pauses the network too, and closes the browser only after the grace.
	 * Chromium locks a profile to one process, and the manager keeps exactly one
	 * per profile, so an agent run arriving while it is open gets the same context.
	 */
	async #ensureBrowser(
		binding: CompanyComputerScreenBinding,
		opener: CompanyComputerScreenBrowserOpener,
		signal: AbortSignal,
	): Promise<CompanyComputerBrowserSession> {
		await this.#ensureScreen(binding, signal);
		const screen = this.#screens.get(binding.screenOrdinal);
		if (!screen || screen.closing || screen.stop.signal.aborted) throw new Error("OFFICE_SCREEN_DRAINING");
		assertCompanyComputerScreenBinding(binding, screen.binding);
		const lifetime = AbortSignal.any([this.#stop.signal, screen.stop.signal]);
		const boundary = {
			assertReady: async (exact: CompanyComputerScreenBinding, checked: AbortSignal): Promise<void> => {
				await this.#assertShared(exact, AbortSignal.any([lifetime, checked]));
			},
		};
		screen.browser ??= {
			manager: new PersistentCompanyComputerBrowser({
				layout: this.#options.layout,
				boundary,
				access: this.#screenBrowserControl,
				launch: createCompanyComputerLinuxBrowserLaunch({
					...this.#options,
					runtimeRoot: this.#options.browserRuntimeRoot,
					boundary,
					access: this.#screenBrowserControl,
					xSocket: (exact) => this.#desktop.xSocket(exact),
				}),
			}),
		};
		const owned = screen.browser;
		if (owned.closing) throw new Error("OFFICE_SCREEN_DRAINING");
		const current = await owned.opening?.catch(() => undefined);
		if (current && !current.isEnded?.()) {
			await current.assertActive(signal);
			// Somebody at the screen asked for a browser that is already open: the
			// answer is its window, brought back if it was minimised.
			if (opener === "desktop") await restoreCompanyComputerBrowserWindow(current.context, signal);
			return current;
		}
		if (current) {
			// Somebody closed the window, or authority ended it. Confirm the old
			// process is gone before the same profile is opened again.
			await owned.detachLogins?.().catch(() => undefined);
			owned.detachLogins = undefined;
			await current.close();
			if (owned.opening && (await owned.opening.catch(() => undefined)) === current) owned.opening = undefined;
		}
		owned.opening ??= (async () => {
			// SQL resolves the screen agent's grant and records who was present.
			const grant = await this.#screenBrowserControl.open(binding, opener, lifetime);
			const session = await owned.manager.open(binding, grant, lifetime);
			// Signed in wherever the company is; a failure here never blocks browsing.
			owned.detachLogins = await this.#logins
				.attach(binding.screenId, session.context as unknown as CompanyComputerLoginContext)
				.catch(() => undefined);
			return session;
		})();
		const opening = owned.opening;
		void opening.catch(() => {
			if (owned.opening === opening) owned.opening = undefined;
		});
		return cloudToolRequest(() => opening, signal, 30000);
	}

	/** Physical browser drain for this screen; an unconfirmed exit rejects. */
	#closeBrowser(screen: SharedScreen): Promise<void> {
		const owned = screen.browser;
		if (!owned) return Promise.resolve();
		owned.closing ??= (async () => {
			await owned.opening?.catch(() => undefined);
			// A last look at this browser's sign-ins before it closes.
			await owned.detachLogins?.().catch(() => undefined);
			owned.detachLogins = undefined;
			await owned.manager.close();
		})();
		return owned.closing;
	}

	async createSession(
		input: Parameters<CompanyComputerServiceGuest["createSession"]>[0],
	): Promise<CompanyComputerNativeGuestSession> {
		this.#binding(input.lease.binding);
		// A session would hold the physical drain a private sign-in waits for.
		if (this.#private || this.#privacy?.state === "entering")
			throw new CompanyComputerGuestSessionRefusedError("OFFICE_PRIVACY_FENCED");
		if (this.#gate && this.#gate !== input.gate) throw new Error("OFFICE_GATE_CHANGED");
		this.#gate = input.gate;
		const descriptor = parseCompanyComputerNativeDescriptor(input.descriptor, input.run);
		if (!descriptor) throw new Error("OFFICE_NATIVE_UNAVAILABLE");
		assertCompanyComputerScope(descriptor.scope, this.#options.scope);
		const lease = structuredClone(input.lease);
		const binding = lease.binding;
		assertCompanyComputerLease(lease, binding, {
			kind: "agent",
			runId: input.run.identity.runId,
			staffAgentId: input.run.identity.staffAgentId,
		});
		const stop = new AbortController();
		const active = new Set<Promise<unknown>>();
		let closing: Promise<void> | undefined;
		let ended = false;
		let commands: CompanyComputerLinuxCommands | undefined;
		let shell: CompanyComputerLinuxShell | undefined;
		let browser: CompanyComputerBrowserSession | undefined;
		/** The screen browser THIS run drives (or is in the middle of joining). A run
		 * that never touched the browser has no say over a window a member opened. */
		let driving: CompanyComputerBrowserSession | "attaching" | undefined;
		let automation: CompanyComputerGuestAutomation | undefined;
		/** The screen's desktop start this run's commands and automation were made for. */
		let seen: number | undefined;
		// One publisher for the session's whole life: a capture it keeps for the perform answer outlives a new automation.
		const screenshots = this.#options.screenshots(input.run);
		// So are the boxes its hook captures sealed (E3c-3), each kept for its perform answer only.
		const captures = new CompanyComputerHookCaptureBoxes();
		const signal = AbortSignal.any([stop.signal, this.#stop.signal, input.run.signal]);
		const admitted = async (exact: CompanyComputerScreenBinding, checked: AbortSignal): Promise<void> => {
			assertCompanyComputerScreenBinding(exact, binding);
			signal.throwIfAborted();
			const state = await this.#assertShared(exact, AbortSignal.any([signal, checked]));
			if (state.privacyVersion !== descriptor.resources.officePrivacyVersion)
				throw new Error("OFFICE_PRIVACY_CHANGED");
		};
		const boundary = { assertReady: admitted };
		const access = new CloudCompanyComputerBrowserControl({
			run: input.run,
			scope: descriptor.scope,
			lease: () => lease,
			control: this.#options.registry,
		});
		// The run's own grant, as its descriptor admitted it. Every agent browser
		// action still proves this grant under the run's current screen lease.
		const runGrant = (): { profileId: string; grantId: string; version: number } => ({
			profileId: descriptor.resources.browserProfileId as string,
			grantId: descriptor.resources.browserGrantId as string,
			version: descriptor.resources.browserGrantVersion as number,
		});
		/** Join the screen's browser. The run never owns the process: `close` only lets go of it. */
		const attach = async (checked: AbortSignal): Promise<CompanyComputerBrowserSession> => {
			const grant = runGrant();
			// First the run's authority; a run without a current grant starts nothing.
			await companyComputerActionCheck(boundary.assertReady(binding, checked));
			await companyComputerActionCheck(access.assertGranted(grant, binding, checked));
			// From here on this run may have automation in flight against the browser.
			driving = "attaching";
			let shared: CompanyComputerBrowserSession;
			try {
				shared = await this.#ensureBrowser(binding, "agent", checked);
			} catch (error) {
				// Joining the open window only checked it, and that check got no answer:
				// this run started nothing there, so it has nothing to stop.
				if (
					error instanceof Error &&
					error.message === "BROWSER_ACCESS_UNCONFIRMED" &&
					companyComputerAuthorityUnanswered(error)
				) {
					driving = undefined;
					throw new CompanyComputerActionFailedError(error);
				}
				throw error;
			}
			driving = shared;
			if (
				shared.grant.profileId !== grant.profileId ||
				shared.grant.grantId !== grant.grantId ||
				shared.grant.version !== grant.version
			)
				throw new Error("BROWSER_PROFILE_IN_USE");
			return {
				binding,
				grant,
				context: shared.context,
				isEnded: () => shared.isEnded?.() ?? false,
				assertActive: async (requestSignal) => {
					const current = AbortSignal.any([signal, requestSignal]);
					try {
						await boundary.assertReady(binding, current);
						await access.assertGranted(grant, binding, current);
					} catch (cause) {
						throw new Error(
							companyComputerAuthorityUnanswered(cause) ? "BROWSER_ACCESS_UNCONFIRMED" : "BROWSER_ACCESS_ENDED",
							{ cause },
						);
					}
					// Screen authority and physical liveness; a lost grant closes the browser.
					await shared.assertActive(current);
				},
				close: async () => undefined,
			};
		};
		const track = <T>(work: () => Promise<T>): Promise<T> => {
			if (closing || signal.aborted) return Promise.reject(new Error("OFFICE_SESSION_CLOSED"));
			const pending = Promise.resolve().then(() => {
				signal.throwIfAborted();
				return work();
			});
			active.add(pending);
			void pending.finally(() => active.delete(pending)).catch(() => undefined);
			return pending;
		};
		const session: NativeSession = {
			binding,
			stop,
			close: () => {
				stop.abort();
				closing ??= cloudToolRequest(
					async () => {
						await Promise.allSettled([...active]);
						// The run lets go of the screen's browser instead of closing it. It
						// stays on the desktop; its network pauses once nobody entitled
						// remains (the relay's per-second SQL check decides). Every action of this run has settled
						// above, so no automation command of the run is still in flight.
						// Drop local handles without closing any shared desktop tab.
						const leaving = automation;
						if (leaving)
							await cloudToolRequest(() => leaving.release(), new AbortController().signal, 2000).catch(
								() => undefined,
							);
						browser = undefined;
						driving = undefined;
						automation = undefined;
						captures.clear();
						// Settled failures whose drain got no answer mid-run get one more try
						// before the lease is released, so an outage does not drain the desktop.
						await cloudToolRequest(
							(checked) => endpoint.drainSettled(checked),
							new AbortController().signal,
							5000,
						).catch(() => undefined);
						const results = await Promise.allSettled([commands?.close()]);
						const rejected = results.find((result) => result.status === "rejected");
						if (rejected) throw new Error("OFFICE_SESSION_DRAIN_UNCONFIRMED", { cause: rejected.reason });
						this.#sessions.delete(session);
						ended = true;
					},
					new AbortController().signal,
					30000,
				);
				return closing;
			},
		};
		this.#sessions.add(session);
		const endpoint = new CompanyComputerGuestEndpoint({
			binding,
			capabilities: descriptor.capabilities,
			resourceTarget: descriptor.resources,
			gate: input.gate,
			effects: input.effects,
			assertScreenAdmitted: admitted,
			prepareScreen: async (exact, checked, replyBy) => {
				// The mount takes this run's view first; the rest of the reply budget is for the way back.
				const refusal = await this.#ensureScreen(
					exact,
					AbortSignal.any([signal, checked]),
					{ kind: "run", runId: input.run.identity.runId },
					replyBy - 2000,
				);
				if (refusal) return refusal;
				signal.throwIfAborted();
				checked.throwIfAborted();
				const screen = this.#screens.get(binding.screenOrdinal);
				if (!screen) throw new Error("OFFICE_SCREEN_DRAINING");
				if (seen !== undefined && seen !== screen.desktop) {
					// The desktop started again on a new mount: what this run held on the old one is gone.
					const leaving = { commands, automation };
					commands = undefined;
					browser = undefined;
					driving = undefined;
					automation = undefined;
					await leaving.automation?.release().catch(() => undefined);
					await leaving.commands?.close();
				}
				seen = screen.desktop;
				commands ??= new CompanyComputerLinuxCommands({
					...this.#options,
					binding,
					boundary,
					xSocket: this.#desktop.xSocket(binding),
				});
				shell ??= this.#screenShell(screen);
			},
			automation: {
				// The gate calls this for every failed or cancelled action of the run,
				// shell and pixel actions included. If this run drove the browser it may
				// have automation commands in flight, and only a confirmed physical close
				// proves they stopped, exactly as before; the next browser use or the dock
				// icon opens it again. A run that never joined the browser closes nothing:
				// the window on the screen may be one a member opened from the dock.
				stopBrowser: async () => {
					const mine = driving;
					browser = undefined;
					driving = undefined;
					automation = undefined;
					if (!mine) return;
					const screen = this.#screens.get(binding.screenOrdinal);
					const owned = screen?.browser;
					if (!screen || !owned) return;
					const current = await owned.opening?.catch(() => undefined);
					if (mine !== "attaching" && current !== mine) {
						// The browser this run drove has already been replaced; make sure
						// the old process is gone and leave the new window alone.
						await mine.close();
						return;
					}
					await owned.detachLogins?.().catch(() => undefined);
					owned.detachLogins = undefined;
					await current?.close();
					if (owned.opening && (await owned.opening.catch(() => undefined)) === current) owned.opening = undefined;
				},
				perform: async (action, currentLease, context, operation, replyBy) => {
					const checked = AbortSignal.any([signal, context.signal]);
					checked.throwIfAborted();
					if (action.kind === "browser" || (action.kind === "screenshot" && action.surface === "browser")) {
						// A member may have closed the window since the last action.
						if (browser?.isEnded?.()) {
							browser = undefined;
							driving = undefined;
						}
						if (!browser) {
							browser = await attach(checked);
							automation = undefined;
						}
					}
					automation ??= new CompanyComputerGuestAutomation({
						binding,
						layout: this.#options.layout,
						boundary,
						browser,
						screenBrowser: async (checked) => {
							const owned = this.#screens.get(binding.screenOrdinal)?.browser;
							const current = await cloudToolRequest(
								() => owned?.opening?.catch(() => undefined) ?? Promise.resolve(undefined),
								checked,
								30000,
							);
							return current && !current.isEnded?.() ? current.context : undefined;
						},
						commands: commands!,
						shell,
						screenshots,
						fillKey: this.#options.fillKey,
						filled: this.#filledOn(binding.screenOrdinal),
						siteStops: this.#siteStops,
						// Asked with the mount the desktop runs on now. Rule 4's way out stops that desktop, never this
						// session: the action holds the capture back until the way out ends, and no longer.
						capture: (captured, until) => {
							const folders = this.#options.folders;
							const screen = this.#screens.get(binding.screenOrdinal);
							if (!folders) return Promise.resolve(undefined);
							// The desktop stopped or started again since the action began: what it shows may come from a
							// mount that went.
							if (!screen || screen.desktop !== seen) return Promise.resolve(COMPANY_COMPUTER_CAPTURE_RESTARTED);
							return folders.capture(binding.screenId, screen.companyEpoch, captured, until, () =>
								this.#stopForRefusal(screen),
							);
						},
						captureTarget: (target, checked) => input.effects.hookCaptureTarget(target, checked),
						captures,
					});
					return automation.perform(action, currentLease, { ...context, signal: checked }, operation, replyBy);
				},
				settle: (action, content, requestSignal, replyBy, runId, receiptId) =>
					automation
						? automation.settle(
								action,
								content,
								AbortSignal.any([signal, requestSignal]),
								replyBy,
								runId,
								receiptId,
							)
						: Promise.resolve(content),
			},
		});
		return {
			close: session.close,
			ended: () => ended,
			screenshot: (receiptId) => screenshots.takeInline?.(receiptId),
			capture: (receiptId) => captures.take(receiptId),
			endpoint: {
				capabilities: endpoint.capabilities,
				resourceTarget: endpoint.resourceTarget,
				authorize: (...args) => track(() => endpoint.authorize(...args)),
				perform: (...args) => track(() => endpoint.perform(...args)),
			},
		};
	}

	#closePrivate(): Promise<void> {
		const current = this.#private;
		if (!current) return Promise.resolve();
		current.stop.abort();
		clearTimeout(current.timer);
		current.closing ??= cloudToolRequest(
			async () => {
				await current.lifecycle?.closing("PRIVACY_FENCE", new AbortController().signal).catch(() => undefined);
				let surface: Awaited<PrivateSurface["opening"]> | undefined;
				try {
					surface = await current.opening;
				} catch (error) {
					// Failed startup has already attempted physical cleanup. A ready
					// surface's close failure, however, must never be swallowed.
					if (error instanceof Error && /DRAIN_UNCONFIRMED|DRAIN_FAILED/.test(error.message)) throw error;
				}
				try {
					await surface?.close();
				} catch (error) {
					await current.lifecycle
						?.failed("DESKTOP_DRAIN_UNCONFIRMED", new AbortController().signal)
						.catch(() => undefined);
					throw error;
				}
				await current.lifecycle?.closed(new AbortController().signal);
				if (this.#private === current) this.#private = undefined;
			},
			new AbortController().signal,
			30000,
		);
		return current.closing;
	}
	async #preparePrivate(challenge: CompanyComputerPrivacyChallenge, signal: AbortSignal) {
		if (!this.#privacy || !isDeepStrictEqual(challenge, this.#privacy)) throw new Error("OFFICE_PRIVACY_CHANGED");
		if (!this.#private) {
			const stop = new AbortController();
			const cancelStartup = (): void => stop.abort();
			signal.addEventListener("abort", cancelStartup, { once: true });
			if (signal.aborted) cancelStartup();
			const current: PrivateSurface = {
				challenge,
				stop,
				lifecycle: this.#options.screenLifecycle?.create(
					challenge.drains.find((d) => d.binding.screenId === challenge.screenId)!.binding,
					challenge,
				),
				opening: Promise.resolve()
					.then(() => current.lifecycle?.requested(AbortSignal.any([this.#stop.signal, stop.signal])))
					.then(() =>
						startCompanyComputerLinuxPrivateSurface({
							...this.#options,
							challenge,
							authority: {
								assertActive: async (exact, checked) => {
									await this.#options.boundary.assertReady(
										exact.drains.find((drain) => drain.binding.screenId === exact.screenId)!.binding,
										checked,
									);
									await this.#privateControl.assertActive(exact, checked);
								},
							},
							signal: AbortSignal.any([this.#stop.signal, stop.signal]),
							assertDrained: async () => {
								if (this.#screens.size || this.#sessions.size)
									throw new Error("OFFICE_PHYSICAL_DRAIN_REQUIRED");
							},
							onFailure: (error) => {
								if (error.message === "PRIVATE_SURFACE_DRAIN_UNCONFIRMED") {
									void current.lifecycle
										?.failed("DESKTOP_DRAIN_UNCONFIRMED", new AbortController().signal)
										.catch(() => undefined);
									this.#fail(error);
									return;
								}
								// Lost private authority (for example the SQL check refusing while a
								// viewer-disconnect drain is pending) or a private display/browser
								// exit ends only this private surface, which has already begun its
								// own physical teardown. The office keeps its retained privacy fence;
								// the drain supervisor, a later viewer or the owner's exit prepares a
								// fresh surface. Only an unconfirmed teardown is fatal for the guest.
								void current.lifecycle
									?.failed("DESKTOP_EXITED", new AbortController().signal)
									.catch(() => undefined);
								current.stop.abort();
								clearTimeout(current.timer);
								current.closing ??= cloudToolRequest(
									async () => {
										let surface: Awaited<PrivateSurface["opening"]> | undefined;
										try {
											surface = await current.opening;
										} catch {
											surface = undefined;
										}
										await surface?.closed;
										if (this.#private === current) this.#private = undefined;
									},
									new AbortController().signal,
									30000,
								).catch((cause) => {
									this.#fail(new Error("PRIVATE_SURFACE_DRAIN_UNCONFIRMED", { cause }));
									throw cause;
								});
								void current.closing.catch(() => undefined);
							},
						}),
					)
					.then(async (surface) => {
						try {
							await current.lifecycle?.ready(AbortSignal.any([this.#stop.signal, stop.signal]));
							const pulse = (): void => {
								if (current.closing || stop.signal.aborted || this.#stop.signal.aborted) return;
								current.timer = setTimeout(() => {
									void current.lifecycle
										?.heartbeat(AbortSignal.any([this.#stop.signal, stop.signal]))
										.then(pulse, pulse);
								}, 5000);
							};
							if (current.lifecycle) pulse();
							return surface;
						} catch (error) {
							try {
								await surface.close();
							} catch {
								throw new Error("PRIVATE_SURFACE_DRAIN_UNCONFIRMED");
							}
							throw error;
						}
					})
					.catch(async (error) => {
						await current.lifecycle
							?.failed("DESKTOP_START_FAILED", new AbortController().signal)
							.catch(() => undefined);
						throw error;
					})
					.finally(() => signal.removeEventListener("abort", cancelStartup)),
			};
			this.#private = current;
			void current.opening.catch(() => undefined);
		}
		if (this.#private.closing || !isDeepStrictEqual(this.#private.challenge, challenge))
			throw new Error("OFFICE_PRIVACY_CHANGED");
		return cloudToolRequest(() => this.#private!.opening, signal, 25000);
	}
	readonly viewer: CompanyComputerServiceGuest["viewer"] = {
		connect: async (value, signal) => {
			const grant = parseCompanyComputerViewerGrant(value);
			this.#binding(grant.binding);
			if (grant.privateSignIn) {
				if (!this.#privacy || this.#privacy.state !== "entering") throw new Error("OFFICE_PRIVACY_UNAVAILABLE");
				const challenge = this.#privacy;
				const binding = challenge.drains.find((drain) => drain.binding.screenId === challenge.screenId)!.binding;
				assertCompanyComputerScreenBinding(grant.binding, binding);
				if (
					grant.memberId !== challenge.memberId ||
					grant.privacyVersion !== challenge.version ||
					grant.privateSignIn.challengeId !== challenge.challengeId ||
					grant.privateSignIn.profileId !== challenge.profileId ||
					grant.privateSignIn.profileVersion !== challenge.profileVersion
				)
					throw new Error("OFFICE_PRIVATE_VIEWER_CHANGED");
				return (await this.#preparePrivate(this.#privacy, signal)).connect(grant, signal);
			}
			const state = await this.#assertShared(grant.binding, signal);
			if (
				state.privacyVersion !== grant.privacyVersion ||
				(grant.mode === "control" && state.epoch !== grant.screenEpoch)
			)
				throw new Error("OFFICE_VIEWER_CHANGED");
			// A member in control holds the mount for their own view; one only watching changes nothing.
			await this.#ensureScreen(
				grant.binding,
				signal,
				grant.mode === "control" ? { kind: "member", userId: grant.memberId } : undefined,
				performance.now() + 5000,
			);
			const socket = await this.#desktop.connectRfb(grant.binding, signal);
			socket.pause();
			// A viewer arriving opens nothing: the desktop is shown as it is. The
			// browser starts from the dock icon or from an agent run, never on its own.
			return { socket, remainder: Buffer.alloc(0) };
		},
	};
	readonly privacy: CompanyComputerServiceGuest["privacy"] = {
		shared: (privacyVersion) => {
			if (Number.isSafeInteger(privacyVersion) && privacyVersion > this.#sharedVersion)
				this.#sharedVersion = privacyVersion;
		},
		fence: async (value, signal) => {
			const challenge = parseCompanyComputerPrivacyChallenge(value, this.#options.scope);
			if (
				challenge.computerGeneration !== this.#options.computerGeneration ||
				(this.#privacy && challenge.version < this.#privacy.version)
			)
				throw new Error("OFFICE_PRIVACY_CHANGED");
			if (this.#privacy?.version === challenge.version) {
				if (!isDeepStrictEqual(this.#privacy, challenge)) throw new Error("OFFICE_PRIVACY_CHANGED");
				return;
			}
			this.#privacy = challenge;
			for (const session of this.#sessions) session.stop.abort();
			for (const screen of this.#screens.values()) screen.stop.abort();
			await this.#closePrivate();
			signal.throwIfAborted();
		},
		secureSurface: async (value, signal) => {
			const challenge = parseCompanyComputerPrivacyChallenge(value, this.#options.scope);
			if (!isDeepStrictEqual(challenge, this.#privacy) || this.#screens.size || this.#sessions.size)
				throw new Error("OFFICE_PHYSICAL_DRAIN_REQUIRED");
			if (challenge.state === "entering") await this.#preparePrivate(challenge, signal);
			else await this.#closePrivate();
			signal.throwIfAborted();
		},
	};
	/**
	 * `reason` names a stop the service decided itself; a drain request or privacy fence is inferred. A drain request
	 * gives `until` (performance.now()): the screen's mount gets the drain's boundary, and each mount of its shell's
	 * commands its final boundary, before it answers (F3 4d, "Drains and stops"), and the drain fails when a mount is
	 * still there by then. Any other stop lets the mount go after it. A stop that cannot confirm what it closed gone (the
	 * screen's sessions, private surface, browser or shell) fails, and the mount stays for the stop control: the
	 * browser's namespace, say, may still read it.
	 */
	async stopResources(
		binding: CompanyComputerScreenBinding,
		signal: AbortSignal,
		stop: { reason?: Extract<ScreenClosingReason, "AUTHORITY_LOST">; until?: number } = {},
	): Promise<void> {
		assertCompanyComputerScreenBinding(binding, binding);
		assertCompanyComputerScope(binding, this.#options.scope);
		if (binding.computerGeneration !== this.#options.computerGeneration)
			throw new Error("OFFICE_GENERATION_MISMATCH");
		const screen = this.#screens.get(binding.screenOrdinal);
		if (screen) assertCompanyComputerScreenBinding(binding, screen.binding);
		const sessions = [...this.#sessions].filter((session) => session.binding.screenId === binding.screenId);
		for (const session of sessions) assertCompanyComputerScreenBinding(binding, session.binding);
		for (const session of sessions) session.stop.abort();
		if (screen) {
			screen.stop.abort();
			clearTimeout(screen.timer);
			clearTimeout(screen.requests);
		}
		const drain = async (): Promise<void> => {
			await screen?.lifecycle
				?.closing(
					this.#closing
						? "OFFICE_SERVICE_STOPPING"
						: this.#privacy?.state === "entering"
							? "PRIVACY_FENCE"
							: (stop.reason ?? "SCREEN_DRAIN_REQUESTED"),
					new AbortController().signal,
				)
				.catch(() => undefined);
			const results = await Promise.allSettled([
				this.#closePrivate(),
				...sessions.map((session) => session.close()),
			]);
			// The screen's shell, with the commands still running in it, and its
			// browser end with the screen: after its runs have let go, before the
			// desktop they draw on stops. Side by side, within the drain's budget.
			if (screen)
				results.push(
					...(await Promise.allSettled([this.#closeBrowser(screen), screen.shell?.close() ?? Promise.resolve()])),
				);
			// Its last commands ended with it: the next report says why, once.
			if (screen?.shell && screen.shell.report().ended.length > 0)
				this.#closedShells = [
					...this.#closedShells,
					{ screenId: screen.binding.screenId, shell: screen.shell },
				].slice(-32);
			if (screen) this.#shellSamples.delete(screen.binding.screenId);
			const rejected = results.find((result) => result.status === "rejected");
			if (screen) {
				await screen.opening.catch(() => undefined);
				try {
					if (screen.handle) await screen.handle.stop();
					else await this.#desktop.drain(binding);
				} catch (error) {
					await screen.lifecycle
						?.failed("DESKTOP_DRAIN_UNCONFIRMED", new AbortController().signal)
						.catch(() => undefined);
					throw error;
				}
				// No desktop uses the screen's mount now; it goes, unless a new desktop of the screen took it meanwhile, or
				// something else that may use it is not confirmed gone. A drain request's boundary follows below instead.
				if (stop.until === undefined && !rejected)
					void this.#options.folders?.release(binding.screenId, () => {
						const now = this.#screens.get(binding.screenOrdinal);
						return !now || now === screen;
					});
				await screen.lifecycle?.closed(new AbortController().signal);
			}
			if (rejected) throw new Error("OFFICE_GUEST_DRAIN_UNCONFIRMED", { cause: rejected.reason });
			if (screen && this.#screens.get(binding.screenOrdinal) === screen) this.#screens.delete(binding.screenOrdinal);
		};
		if (screen) screen.closing ??= drain();
		await cloudToolRequest(() => screen?.closing ?? drain(), signal, 30000);
		// With or without a desktop: the mount goes now, with the run's last changes, unless a new desktop took it; and
		// the mounts of the shell's commands, which ended with it, go once their final boundaries have their answers.
		if (stop.until !== undefined) {
			const until = stop.until;
			const drained = await Promise.allSettled([
				this.#options.folders?.drain(
					binding.screenId,
					signal,
					until,
					() => !this.#screens.has(binding.screenOrdinal),
				),
				this.#options.commandFolders?.drain(binding.screenId, signal, until),
			]);
			const failed = drained.find((result): result is PromiseRejectedResult => result.status === "rejected");
			if (failed) throw failed.reason;
		}
	}
	close(): Promise<void> {
		this.#stop.abort();
		clearInterval(this.#shellActivity);
		this.#shellPressure.close();
		this.#closing ??= Promise.resolve().then(() =>
			cloudToolRequest(
				async () => {
					const results = await Promise.allSettled([
						this.#closePrivate(),
						...[...this.#sessions].map((session) => session.close()),
						...[...this.#screens.values()].map((screen) =>
							this.stopResources(screen.binding, new AbortController().signal),
						),
					]);
					await this.#logins.close().catch(() => undefined);
					await this.#desktop.close();
					const rejected = results.find((result) => result.status === "rejected");
					if (this.#private || this.#screens.size || this.#sessions.size || rejected)
						throw new Error("OFFICE_GUEST_DRAIN_UNCONFIRMED", { cause: rejected?.reason });
				},
				new AbortController().signal,
				45000,
			),
		);
		return this.#closing;
	}
}
