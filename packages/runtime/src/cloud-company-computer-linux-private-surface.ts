import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	assertCompanyComputerScope,
	assertCompanyComputerScreenBinding,
	type CompanyComputerScope,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import {
	type CompanyComputerPrivacyChallenge,
	parseCompanyComputerPrivacyChallenge,
} from "@qorpera/cloud-client/cloud-company-computer-privacy";
import { parseCompanyComputerViewerGrant } from "@qorpera/cloud-client/cloud-company-computer-viewer";
import type { CompanyComputerBrowserEgressTransport } from "./cloud-company-computer-browser-egress.ts";
import type { CompanyComputerBrowserLaunch } from "./cloud-company-computer-guest.ts";
import { assertCompanyComputerGuestLayout, type CompanyComputerGuestLayout } from "./cloud-company-computer-layout.ts";
import { createCompanyComputerLinuxBrowserLaunch } from "./cloud-company-computer-linux-browser.ts";
import {
	assertCompanyComputerWorkbenchMount,
	type CompanyComputerCommandLimits,
	openCompanyComputerLinuxDirectory,
} from "./cloud-company-computer-linux-host.ts";
import { startCompanyComputerLinuxPrivateDisplay } from "./cloud-company-computer-linux-private-display.ts";
import type { CloudCompanyComputerPrivateSurfaceControl } from "./cloud-company-computer-private-surface-control.ts";
import { companyComputerScreenDisplay } from "./cloud-company-computer-screens.ts";
import type { CompanyComputerViewerGuestTransport } from "./cloud-company-computer-viewer-gateway.ts";
import type { RecoveryDirectoryMount } from "./cloud-identity-recovery-filesystems.ts";
import { cloudToolRequest } from "./cloud-native-tool-authority.ts";

/** A single private sign-in lifetime. No automation/context/capture/X handle is
 * returned. Only the exact owner's separately authorized private viewer can
 * reach it. The containing service must fence all ordinary tools and viewers,
 * prove every physical drain, and retain that barrier until shared recovery. */
export async function startCompanyComputerLinuxPrivateSurface(options: {
	scope: CompanyComputerScope;
	computerGeneration: number;
	challenge: CompanyComputerPrivacyChallenge;
	layout: CompanyComputerGuestLayout;
	limits: CompanyComputerCommandLimits;
	displayRuntimeRoot: string;
	browserRuntimeRoot: string;
	/** Dedicated empty tmpfs, distinct from every shared/persistent directory. */
	privateWorkbenchMount: RecoveryDirectoryMount;
	authority: Pick<CloudCompanyComputerPrivateSurfaceControl, "assertActive">;
	assertDrained(challenge: CompanyComputerPrivacyChallenge, signal: AbortSignal): Promise<void>;
	/** Escalate unexpected exit or unconfirmed cleanup to the owning service. */
	onFailure(error: Error): void;
	signal: AbortSignal;
	/** Disposable probe only; never native/member configuration. */
	egressTransport?: CompanyComputerBrowserEgressTransport;
}): Promise<CompanyComputerViewerGuestTransport & { close(): Promise<void>; closed: Promise<void> }> {
	options = {
		...options,
		layout: { ...options.layout },
		limits: { ...options.limits },
		privateWorkbenchMount: { ...options.privateWorkbenchMount },
	};
	assertCompanyComputerScope(options.scope, options.scope);
	assertCompanyComputerGuestLayout(options.layout);
	const challenge = parseCompanyComputerPrivacyChallenge(options.challenge, options.scope);
	if (challenge.state !== "entering" || challenge.computerGeneration !== options.computerGeneration)
		throw new Error("PRIVATE_SURFACE_CHALLENGE_DIFFERS");
	const binding = challenge.drains.find((drain) => drain.binding.screenId === challenge.screenId)!.binding;
	const mount = options.privateWorkbenchMount;
	if (mount.filesystem !== "tmpfs" || mount.root !== "/" || mount.source !== "tmpfs")
		throw new Error("PRIVATE_SURFACE_TMPFS_REQUIRED");
	// Validate against all shared roots before replacing the browser's workbench.
	for (const root of [...Object.values(options.layout), options.displayRuntimeRoot, options.browserRuntimeRoot])
		if (
			root === mount.mountPoint ||
			root.startsWith(`${mount.mountPoint}/`) ||
			mount.mountPoint.startsWith(`${root}/`)
		)
			throw new Error("PRIVATE_SURFACE_SHARED_PATH");
	const layout = { ...options.layout, workbenchRoot: mount.mountPoint };
	assertCompanyComputerGuestLayout(layout);
	const runtimeRoots = [options.displayRuntimeRoot, options.browserRuntimeRoot];
	for (const [index, root] of runtimeRoots.entries()) {
		if (
			root !== resolve(root) ||
			root === "/" ||
			root.length > 4096 ||
			/[\x00-\x1f\x7f\\]/.test(root) ||
			[
				...Object.values(options.layout),
				mount.mountPoint,
				...runtimeRoots.filter((_, other) => other !== index),
			].some((path) => root === path || root.startsWith(`${path}/`) || path.startsWith(`${root}/`))
		)
			throw new Error("PRIVATE_SURFACE_SHARED_PATH");
	}
	const lifetime = new AbortController();
	const signal = AbortSignal.any([options.signal, lifetime.signal]);
	let display: Awaited<ReturnType<typeof startCompanyComputerLinuxPrivateDisplay>> | undefined;
	let browser: Awaited<ReturnType<CompanyComputerBrowserLaunch>> | undefined;
	let closing: Promise<void> | undefined;
	let ready = false;
	let ownsWorkbench = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let renewal: Promise<void> | undefined;
	let resolveClosed!: () => void;
	let rejectClosed!: (error: Error) => void;
	const closed = new Promise<void>((resolve, reject) => {
		resolveClosed = resolve;
		rejectClosed = reject;
	});
	void closed.catch(() => undefined);
	const assertActive = async (checked: AbortSignal): Promise<void> => {
		signal.throwIfAborted();
		if (closing) throw new Error("PRIVATE_SURFACE_CLOSED");
		await options.authority.assertActive(structuredClone(challenge), AbortSignal.any([signal, checked]));
		checked.throwIfAborted();
		signal.throwIfAborted();
	};
	const close = (): Promise<void> => {
		ready = false;
		clearTimeout(timer);
		display?.fence();
		closing ??= Promise.resolve()
			.then(() =>
				cloudToolRequest(
					async () => {
						// Preserve cookies if possible, but failure never skips physical X
						// teardown or frees this lifetime for reuse without confirmed drain.
						const browserResult = await Promise.allSettled([browser?.close()]);
						const displayResult = await Promise.allSettled([display?.close()]);
						lifetime.abort();
						await renewal?.catch(() => undefined);
						for (const result of [...browserResult, ...displayResult])
							if (result.status === "rejected") throw result.reason;
						// This root was checked empty and pinned to dedicated tmpfs before
						// launch. Clear only its entries, after every process has stopped.
						if (ownsWorkbench) {
							const root = await openCompanyComputerLinuxDirectory(layout.workbenchRoot, true);
							try {
								await assertCompanyComputerWorkbenchMount(root, mount, [layout.workbenchRoot]);
								for (const name of await readdir(layout.workbenchRoot))
									await rm(join(layout.workbenchRoot, name), { recursive: true, force: true });
							} finally {
								await root.close();
							}
						}
						signal.removeEventListener("abort", aborted);
					},
					new AbortController().signal,
					30000,
				),
			)
			.then(resolveClosed, (cause) => {
				lifetime.abort();
				const error = new Error("PRIVATE_SURFACE_DRAIN_UNCONFIRMED", { cause });
				rejectClosed(error);
				throw error;
			});
		return closing;
	};
	const notifyFailure = (message: string, cause?: unknown): void => {
		try {
			options.onFailure(new Error(message, { cause }));
		} catch {
			/* A failing service callback cannot interrupt physical cleanup. */
		}
	};
	const failed = (message: string, cause?: unknown): void => {
		if (closing) return;
		void close().catch((error) => notifyFailure("PRIVATE_SURFACE_DRAIN_UNCONFIRMED", error));
		notifyFailure(message, cause);
	};
	const aborted = (): void => {
		void close().catch((error) => notifyFailure("PRIVATE_SURFACE_DRAIN_UNCONFIRMED", error));
	};
	const schedule = (): void => {
		if (closing) return;
		timer = setTimeout(() => {
			renewal = cloudToolRequest(assertActive, signal, 3000);
			void renewal.then(schedule, (error) => failed("PRIVATE_SURFACE_AUTHORITY_UNCONFIRMED", error));
		}, 1000);
	};
	try {
		await cloudToolRequest(assertActive, signal, 3000);
		await cloudToolRequest((checked) => options.assertDrained(structuredClone(challenge), checked), signal);
		const workbench = await openCompanyComputerLinuxDirectory(layout.workbenchRoot, true);
		try {
			await assertCompanyComputerWorkbenchMount(workbench, mount, [layout.workbenchRoot]);
			if ((await readdir(layout.workbenchRoot)).length) throw new Error("PRIVATE_SURFACE_WORKBENCH_NOT_EMPTY");
			ownsWorkbench = true;
		} finally {
			await workbench.close();
		}
		display = await startCompanyComputerLinuxPrivateDisplay({
			ordinal: binding.screenOrdinal,
			runtimeRoot: options.displayRuntimeRoot,
			limits: options.limits,
			assertActive,
			signal,
		});
		const grant = {
			profileId: challenge.profileId,
			grantId: challenge.challengeId,
			version: challenge.profileVersion,
		};
		const launch = createCompanyComputerLinuxBrowserLaunch({
			scope: challenge.scope,
			computerGeneration: challenge.computerGeneration,
			layout,
			limits: options.limits,
			workbenchMount: mount,
			runtimeRoot: options.browserRuntimeRoot,
			boundary: {
				assertReady: async (exact, checked) => {
					assertCompanyComputerScreenBinding(exact, binding);
					await assertActive(checked);
				},
			},
			access: {
				assertGranted: async (exact, screen, checked) => {
					assertCompanyComputerScreenBinding(screen, binding);
					if (
						exact.profileId !== grant.profileId ||
						exact.grantId !== grant.grantId ||
						exact.version !== grant.version
					)
						throw new Error("PRIVATE_SURFACE_PROFILE_DIFFERS");
					await assertActive(checked);
				},
			},
			xSocket: (exact) => {
				assertCompanyComputerScreenBinding(exact, binding);
				return display!.xSocket;
			},
			egressTransport: options.egressTransport,
		});
		const profiles = await openCompanyComputerLinuxDirectory(layout.browserProfilesRoot, true);
		try {
			await mkdir(join(layout.browserProfilesRoot, challenge.profileId), { mode: 0o700, recursive: true });
		} finally {
			await profiles.close();
		}
		browser = await launch(join(layout.browserProfilesRoot, challenge.profileId), {
			binding,
			grant,
			display: companyComputerScreenDisplay(binding.screenOrdinal),
			home: layout.desktopHome,
			signal,
		});
		await cloudToolRequest(assertActive, signal, 3000);
		signal.addEventListener("abort", aborted, { once: true });
		signal.throwIfAborted();
		ready = true;
		void display.exited.then(
			() => failed("PRIVATE_SURFACE_DISPLAY_EXITED"),
			(error) => failed("PRIVATE_SURFACE_DISPLAY_EXITED", error),
		);
		browser.context.once("close", () => failed("PRIVATE_SURFACE_BROWSER_EXITED"));
		if (!browser.context.browser()?.isConnected()) throw new Error("PRIVATE_SURFACE_ENDED");
		schedule();
		return {
			close,
			closed,
			connect: async (value, checked) => {
				const viewer = parseCompanyComputerViewerGrant(value);
				assertCompanyComputerScreenBinding(viewer.binding, binding);
				if (
					!ready ||
					closing ||
					viewer.mode !== "control" ||
					viewer.memberId !== challenge.memberId ||
					viewer.privacyVersion !== challenge.version ||
					viewer.privateSignIn?.challengeId !== challenge.challengeId ||
					viewer.privateSignIn.profileId !== challenge.profileId ||
					viewer.privateSignIn.profileVersion !== challenge.profileVersion
				)
					throw new Error("PRIVATE_SURFACE_VIEWER_DIFFERS");
				await cloudToolRequest(assertActive, checked, 3000);
				const socket = await display!.connectRfb(checked);
				if (!ready || closing || checked.aborted) {
					socket.destroy();
					throw new Error("PRIVATE_SURFACE_CLOSED");
				}
				return { socket, remainder: Buffer.alloc(0) };
			},
		};
	} catch (error) {
		await close();
		throw error;
	}
}
