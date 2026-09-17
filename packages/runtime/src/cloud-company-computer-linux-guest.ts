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
import { CloudCompanyComputerBrowserControl } from "./cloud-company-computer-browser-control.ts";
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
import type { CompanyComputerScreenActionGate } from "./cloud-company-computer-leases.ts";
import { createCompanyComputerLinuxBrowserLaunch } from "./cloud-company-computer-linux-browser.ts";
import { CompanyComputerLinuxCommands } from "./cloud-company-computer-linux-commands.ts";
import { CompanyComputerLinuxDesktopLauncher } from "./cloud-company-computer-linux-desktop.ts";
import type { CompanyComputerCommandLimits } from "./cloud-company-computer-linux-host.ts";
import { startCompanyComputerLinuxPrivateSurface } from "./cloud-company-computer-linux-private-surface.ts";
import { parseCompanyComputerNativeDescriptor } from "./cloud-company-computer-native-client.ts";
import type { CompanyComputerNativeGuestSession } from "./cloud-company-computer-native-gateway.ts";
import { CloudCompanyComputerPrivateSurfaceControl } from "./cloud-company-computer-private-surface-control.ts";
import type { HttpCloudCompanyComputerRegistry } from "./cloud-company-computer-registry-http.ts";
import type {
	CompanyComputerScreenLifecycle,
	CompanyComputerScreenLifetime,
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
interface SharedScreen {
	binding: CompanyComputerScreenBinding;
	stop: AbortController;
	opening: Promise<void>;
	handle?: CompanyComputerScreenSessionHandle;
	closing?: Promise<void>;
	timer?: ReturnType<typeof setTimeout>;
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
	readonly #stop = new AbortController();
	readonly #screens = new Map<number, SharedScreen>();
	readonly #sessions = new Set<NativeSession>();
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
				await prepareCompanyComputerScreenWallpaper(
					{
						binding,
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
								await current.lifecycle
									?.heartbeat(AbortSignal.any([this.#stop.signal, current.stop.signal]))
									.catch(() => undefined);
								renew();
							},
							(pulseError) => {
								if (this.#screens.get(binding.screenOrdinal) === current && !current.closing)
									void this.stopResources(binding, new AbortController().signal).catch((error) =>
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

	async createSession(
		input: Parameters<CompanyComputerServiceGuest["createSession"]>[0],
	): Promise<CompanyComputerNativeGuestSession> {
		this.#binding(input.lease.binding);
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
		let commands: CompanyComputerLinuxCommands | undefined;
		let browser: CompanyComputerBrowserSession | undefined;
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
		const manager = new PersistentCompanyComputerBrowser({
			layout: this.#options.layout,
			boundary,
			access,
			launch: createCompanyComputerLinuxBrowserLaunch({
				...this.#options,
				runtimeRoot: this.#options.browserRuntimeRoot,
				boundary,
				access,
				xSocket: (exact) => this.#desktop.xSocket(exact),
			}),
		});
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
						const results = await Promise.allSettled([manager.close(), commands?.close()]);
						const rejected = results.find((result) => result.status === "rejected");
						if (rejected) throw new Error("OFFICE_SESSION_DRAIN_UNCONFIRMED", { cause: rejected.reason });
						this.#sessions.delete(session);
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
				stopBrowser: () => manager.close(),
				perform: async (action, currentLease, context, operation) => {
					const checked = AbortSignal.any([signal, context.signal]);
					checked.throwIfAborted();
					if (action.kind === "browser" || (action.kind === "screenshot" && action.surface === "browser")) {
						if (!browser) {
							const startup = new AbortController();
							const cancel = (): void => startup.abort();
							checked.addEventListener("abort", cancel, { once: true });
							if (checked.aborted) cancel();
							try {
								browser = await manager.open(
									binding,
									{
										profileId: descriptor.resources.browserProfileId as string,
										grantId: descriptor.resources.browserGrantId as string,
										version: descriptor.resources.browserGrantVersion as number,
									},
									AbortSignal.any([signal, startup.signal]),
								);
							} finally {
								checked.removeEventListener("abort", cancel);
							}
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
	async stopResources(binding: CompanyComputerScreenBinding, signal: AbortSignal): Promise<void> {
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
		}
		const drain = async (): Promise<void> => {
			await screen?.lifecycle
				?.closing(
					this.#closing
						? "OFFICE_SERVICE_STOPPING"
						: this.#privacy?.state === "entering"
							? "PRIVACY_FENCE"
							: "SCREEN_DRAIN_REQUESTED",
					new AbortController().signal,
				)
				.catch(() => undefined);
			const results = await Promise.allSettled([
				this.#closePrivate(),
				...sessions.map((session) => session.close()),
			]);
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
