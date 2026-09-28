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
import {
	CloudCompanyComputerBrowserControl,
	CloudCompanyComputerScreenBrowserControl,
	type CompanyComputerScreenBrowserOpener,
} from "./cloud-company-computer-browser-control.ts";
import {
	CompanyComputerBrowserLogins,
	type CompanyComputerLoginContext,
} from "./cloud-company-computer-browser-logins.ts";
import { prepareCompanyComputerScreenWallpaper } from "./cloud-company-computer-desktop.ts";
import { CompanyComputerGuestEndpoint } from "./cloud-company-computer-endpoint.ts";
import {
	type CompanyComputerBrowserSession,
	CompanyComputerGuestAutomation,
	type CompanyComputerGuestBoundary,
	type CompanyComputerScreenshotPublisher,
	PersistentCompanyComputerBrowser,
} from "./cloud-company-computer-guest.ts";
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
import { parseCompanyComputerNativeDescriptor } from "./cloud-company-computer-native-client.ts";
import {
	CompanyComputerGuestSessionRefusedError,
	type CompanyComputerNativeGuestSession,
} from "./cloud-company-computer-native-gateway.ts";
import { CloudCompanyComputerPrivateSurfaceControl } from "./cloud-company-computer-private-surface-control.ts";
import {
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
	lifecycle?: CompanyComputerScreenLifetime;
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
	fileImports?: (
		run: CloudNativeToolRun,
	) => import("./cloud-company-computer-file-imports.ts").CompanyComputerFileImporter;
	fileExports?: (
		run: CloudNativeToolRun,
	) => import("./cloud-company-computer-file-transfers.ts").CompanyComputerFileExportPublisher;
	onFailure(error: Error): void;
}

export class CompanyComputerLinuxGuest implements CompanyComputerServiceGuest {
	readonly #options: CompanyComputerLinuxGuestOptions;
	readonly #desktop: CompanyComputerLinuxDesktopLauncher;
	readonly #sharedControl: CloudCompanyComputerSharedSurfaceControl;
	readonly #privateControl: CloudCompanyComputerPrivateSurfaceControl;
	readonly #screenBrowserControl: CloudCompanyComputerScreenBrowserControl;
	readonly #stop = new AbortController();
	readonly #screens = new Map<number, SharedScreen>();
	readonly #sessions = new Set<NativeSession>();
	/** The company's one set of website sign-ins, shared by every agent's browser. */
	readonly #logins: CompanyComputerBrowserLogins;
	#private?: PrivateSurface;
	#privacy?: CompanyComputerPrivacyChallenge;
	/** Confirmed shared version while the registry retains no challenge. */
	#sharedVersion = 0;
	#gate?: CompanyComputerScreenActionGate;
	#closing?: Promise<void>;

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
		// Each computer of the company writes its own file there and reads the others'.
		this.#logins = new CompanyComputerBrowserLogins({
			path:
				this.#options.layout.companyRoot !== undefined
					? join(this.#options.layout.companyRoot, "browser-logins.json")
					: join(this.#options.layout.browserProfilesRoot, "company-logins.json"),
			computerId: this.#options.scope.companyComputerId,
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
	async #ensureScreen(binding: CompanyComputerScreenBinding, signal: AbortSignal): Promise<void> {
		await this.#assertShared(binding, signal);
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
				current.handle = await this.#desktop.launch(binding, startup);
				await current.handle.ready;
				startup.throwIfAborted();
				void current.handle.exited.then(
					() => {
						if (!current.closing && !current.stop.signal.aborted && !this.#closing) {
							void current.lifecycle
								?.failed("DESKTOP_EXITED", new AbortController().signal)
								.then(() => current.lifecycle?.closed(new AbortController().signal))
								.catch(() => undefined);
							this.#fail(new Error("OFFICE_DESKTOP_EXITED"));
						}
					},
					(error) => {
						void current.lifecycle
							?.failed("DESKTOP_DRAIN_UNCONFIRMED", new AbortController().signal)
							.catch(() => undefined);
						this.#fail(new Error("OFFICE_DESKTOP_DRAIN_UNCONFIRMED", { cause: error }));
					},
				);
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
								void this.stopResources(binding, new AbortController().signal, "AUTHORITY_LOST").catch(
									(error) =>
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
				throw error;
			});
			void current.opening.catch(() => undefined);
			screen = current;
		}
		await cloudToolRequest(() => screen.opening, signal, 20000);
		signal.throwIfAborted();
		await this.#assertShared(binding, signal);
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
		let browser: CompanyComputerBrowserSession | undefined;
		/** The screen browser THIS run drives (or is in the middle of joining). A run
		 * that never touched the browser has no say over a window a member opened. */
		let driving: CompanyComputerBrowserSession | "attaching" | undefined;
		let automation: CompanyComputerGuestAutomation | undefined;
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
			prepareScreen: async (exact, checked) => {
				await this.#ensureScreen(exact, AbortSignal.any([signal, checked]));
				signal.throwIfAborted();
				checked.throwIfAborted();
				commands ??= new CompanyComputerLinuxCommands({
					...this.#options,
					binding,
					boundary,
					xSocket: this.#desktop.xSocket(binding),
				});
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
				perform: async (action, currentLease, context, operation) => {
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
						commands: commands!,
						screenshots: this.#options.screenshots(input.run),
						fileExports: this.#options.fileExports?.(input.run),
						fileImports: this.#options.fileImports?.(input.run),
					});
					return automation.perform(action, currentLease, { ...context, signal: checked }, operation);
				},
			},
		});
		return {
			close: session.close,
			ended: () => ended,
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
			await this.#ensureScreen(grant.binding, signal);
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
	/** `reason` names a stop the service decided itself; a drain request or privacy fence is inferred. */
	async stopResources(
		binding: CompanyComputerScreenBinding,
		signal: AbortSignal,
		reason?: Extract<ScreenClosingReason, "AUTHORITY_LOST">,
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
							: (reason ?? "SCREEN_DRAIN_REQUESTED"),
					new AbortController().signal,
				)
				.catch(() => undefined);
			const results = await Promise.allSettled([
				this.#closePrivate(),
				...sessions.map((session) => session.close()),
			]);
			// The screen's browser ends with the screen: after its runs have let go,
			// before the desktop it draws on stops.
			if (screen) results.push(...(await Promise.allSettled([this.#closeBrowser(screen)])));
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
				await screen.lifecycle?.closed(new AbortController().signal);
			}
			const rejected = results.find((result) => result.status === "rejected");
			if (rejected) throw new Error("OFFICE_GUEST_DRAIN_UNCONFIRMED", { cause: rejected.reason });
			if (screen && this.#screens.get(binding.screenOrdinal) === screen) this.#screens.delete(binding.screenOrdinal);
		};
		if (screen) screen.closing ??= drain();
		await cloudToolRequest(() => screen?.closing ?? drain(), signal, 30000);
	}
	close(): Promise<void> {
		this.#stop.abort();
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
