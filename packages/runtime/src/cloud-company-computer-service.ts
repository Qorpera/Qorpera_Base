import type {
	CompanyComputerScope,
	CompanyComputerScreenBinding,
} from "@qorpera/cloud-client/cloud-company-computer-contract";
import { CompanyComputerDrainSupervisor } from "./cloud-company-computer-drain.ts";
import { CompanyComputerScreenActionGate } from "./cloud-company-computer-leases.ts";
import {
	CompanyComputerNativeGateway,
	type CompanyComputerNativeGuestSessionFactory,
	startCompanyComputerNativeGateway,
} from "./cloud-company-computer-native-gateway.ts";
import {
	type CompanyComputerPrivacyBoundary,
	CompanyComputerPrivacySupervisor,
} from "./cloud-company-computer-privacy.ts";
import type { HttpCloudCompanyComputerRegistry } from "./cloud-company-computer-registry-http.ts";
import { CompanyComputerOfficeSupervisor } from "./cloud-company-computer-supervisor.ts";
import { CloudCompanyComputerViewerControl } from "./cloud-company-computer-viewer-control.ts";
import type {
	CompanyComputerViewerAuthority,
	CompanyComputerViewerGuestTransport,
} from "./cloud-company-computer-viewer-gateway.ts";
import { startCompanyComputerViewerWebSocketGateway } from "./cloud-company-computer-viewer-websocket.ts";
import { cloudToolRequest } from "./cloud-native-tool-authority.ts";

/** Physical office adapters, supplied by the Linux guest entrypoint. No local
 * client fallback. Session construction must only bind adapters; guest work
 * starts inside the receipt-admitted endpoint using the supplied shared gate. */
export interface CompanyComputerServiceGuest {
	createSession(
		options: Parameters<CompanyComputerNativeGuestSessionFactory>[0] & {
			gate: CompanyComputerScreenActionGate;
		},
	): ReturnType<CompanyComputerNativeGuestSessionFactory>;
	viewer: CompanyComputerViewerGuestTransport;
	privacy: CompanyComputerPrivacyBoundary;
	stopResources(binding: CompanyComputerScreenBinding, signal: AbortSignal): Promise<void>;
	/** Await all process trees, capture/input/browser channels and desktops
	 * stopping. Unknown cleanup must reject; persistent work/profile bytes stay. */
	close(): Promise<void>;
}

/** One service lifetime owns native work, viewers and reconciliation. Listener
 * readiness follows the first authoritative reconciliation and privacy fence.
 * Loss of supervision closes both transports and drains physical resources;
 * closing a member viewer never ends this lifetime. */
export async function startCompanyComputerOfficeService(options: {
	scope: CompanyComputerScope;
	computerGeneration: number;
	registry: HttpCloudCompanyComputerRegistry;
	guest: CompanyComputerServiceGuest;
	native: { host: string; port: number; token: string; tls: { cert: Buffer; key: Buffer } };
	viewer: { host: string; port: number; origins: readonly string[]; tls: { cert: Buffer; key: Buffer } };
	signal: AbortSignal;
	/** Both listeners are bound with admission closed. Resolve only after the
	 * provider activates this exact service invocation. Rejection drains both. */
	waitForActivation?: (listeners: { nativePort: number; viewerPort: number }, signal: AbortSignal) => Promise<void>;
}): Promise<{ nativePort: number; viewerPort: number; finished: Promise<void>; close(): Promise<void> }> {
	const stop = new AbortController();
	const signal = AbortSignal.any([options.signal, stop.signal]);
	const gate = new CompanyComputerScreenActionGate();
	let ready = false;
	let listenerFailed = false;
	const onListenerFailure = (): void => {
		ready = false;
		listenerFailed = true;
		stop.abort();
	};
	let native: Awaited<ReturnType<typeof startCompanyComputerNativeGateway>> | undefined;
	let viewer: Awaited<ReturnType<typeof startCompanyComputerViewerWebSocketGateway>> | undefined;
	let nativeGateway: CompanyComputerNativeGateway | undefined;
	let supervisor: CompanyComputerOfficeSupervisor | undefined;
	let closing: Promise<void> | undefined;
	const cleanup = (): Promise<void> => {
		ready = false;
		stop.abort();
		closing ??= cloudToolRequest(
			async (cleanupSignal) => {
				const listeners = await Promise.allSettled([
					native ? native.close() : nativeGateway?.close(),
					viewer?.close(),
				]);
				// Always attempt the whole-guest drain even if an individual session's
				// cleanup was unknown. Never translate that uncertainty into success.
				await options.guest.close();
				cleanupSignal.throwIfAborted();
				const rejected = listeners.find((result) => result.status === "rejected");
				if (rejected) throw new Error("OFFICE_SERVICE_DRAIN_UNCONFIRMED", { cause: rejected.reason });
			},
			new AbortController().signal,
			55000,
		);
		return closing;
	};
	const assertServing = (): void => {
		signal.throwIfAborted();
		if (!ready) throw new Error("OFFICE_SERVICE_NOT_READY");
	};
	// New viewer admission and new native work additionally require the
	// supervisor's latest status poll to have confirmed the durable state. An
	// already-admitted viewer's periodic check, its per-input admission and its
	// release are each confirmed by SQL on their own and stay on assertServing,
	// so a bounded transport gap never destroys an authorized stream.
	const assertAdmitting = (): void => {
		assertServing();
		supervisor?.assertConfirmed();
	};
	try {
		signal.throwIfAborted();
		const control = new CloudCompanyComputerViewerControl({ scope: options.scope, control: options.registry });
		const authority: CompanyComputerViewerAuthority = {
			redeem: async (capability, checked) => {
				assertAdmitting();
				return control.redeem(capability, AbortSignal.any([signal, checked]));
			},
			check: async (grant, checked) => {
				assertServing();
				return control.check(grant, AbortSignal.any([signal, checked]));
			},
			forwardInput: async (grant, input, forward, checked) => {
				assertServing();
				return control.forwardInput(
					grant,
					input,
					() => {
						assertServing();
						forward();
					},
					AbortSignal.any([signal, checked]),
				);
			},
			// Exact cleanup remains valid after service cancellation.
			release: (...args) => control.release(...args),
		};
		viewer = await startCompanyComputerViewerWebSocketGateway({
			...options.viewer,
			onFailure: onListenerFailure,
			path: `/office/${options.scope.companyComputerId}/view`,
			authority,
			guest: {
				connect: async (grant, checked) => {
					assertAdmitting();
					const combined = AbortSignal.any([signal, checked]);
					const connected = await options.guest.viewer.connect(grant, combined);
					try {
						combined.throwIfAborted();
						assertAdmitting();
						return connected;
					} catch (error) {
						connected.socket.destroy();
						throw error;
					}
				},
			},
		});
		const connections = viewer.connections;
		const privacyFence: CompanyComputerPrivacyBoundary["fence"] = async (challenge, checked) => {
			await connections.fencePrivacy(challenge, checked);
			await options.guest.privacy.fence(challenge, checked);
		};
		const drains = new CompanyComputerDrainSupervisor({
			scope: options.scope,
			gate,
			control: options.registry,
			stopResources: (binding, checked) => options.guest.stopResources(binding, checked),
		});
		const privacy = new CompanyComputerPrivacySupervisor({
			scope: options.scope,
			drains,
			control: options.registry,
			boundary: {
				fence: privacyFence,
				secureSurface: (challenge, checked) => options.guest.privacy.secureSurface(challenge, checked),
			},
		});
		supervisor = new CompanyComputerOfficeSupervisor({
			scope: options.scope,
			computerGeneration: options.computerGeneration,
			viewers: {
				fencePrivacy: privacyFence,
				fenceScreen: (challenge, checked) => connections.fenceScreen(challenge, checked),
				close: () => connections.close(),
			},
			drains,
			privacy,
			sharedBaseline: (privacyVersion) => options.guest.privacy.shared?.(privacyVersion),
			control: {
				call: async (...args) => {
					const state = await options.registry.call(...args);
					// An inactive/replaced office cannot retain a serving listener. Its
					// durable drain challenges remain for the next admitted recovery.
					if (!state || typeof state !== "object" || !("state" in state) || state.state !== "active")
						throw new Error("OFFICE_SERVICE_UNAVAILABLE");
					return state;
				},
			},
		});
		nativeGateway = new CompanyComputerNativeGateway({
			scope: options.scope,
			computerGeneration: options.computerGeneration,
			token: options.native.token,
			registry: options.registry,
			admit: assertServing,
			admitWork: assertAdmitting,
			createSession: async (session) => {
				assertAdmitting();
				return options.guest.createSession({ ...session, gate });
			},
		});
		native = await startCompanyComputerNativeGateway({
			...options.native,
			gateway: nativeGateway,
			onFailure: onListenerFailure,
		});
		if (options.waitForActivation)
			await options.waitForActivation({ nativePort: native.port, viewerPort: viewer.port }, signal);
		await supervisor.reconcile(signal);
		signal.throwIfAborted();
		ready = true;
		const finished = (async () => {
			let failed = false;
			let failure: unknown;
			try {
				await supervisor.run(signal);
			} catch (error) {
				failed = true;
				failure = error;
			}
			try {
				await cleanup();
			} catch (error) {
				throw new Error("OFFICE_SERVICE_DRAIN_UNCONFIRMED", {
					cause: failed ? new AggregateError([failure, error]) : error,
				});
			}
			if (failed) throw new Error("OFFICE_SERVICE_SUPERVISION_FAILED", { cause: failure });
			if (listenerFailed) throw new Error("OFFICE_SERVICE_LISTENER_FAILED");
		})();
		// The entrypoint awaits finished. Handling it here also prevents an
		// unhandled rejection before a caller attaches its lifetime observer.
		void finished.catch(() => undefined);
		return {
			nativePort: native.port,
			viewerPort: viewer.port,
			finished,
			close: async () => {
				ready = false;
				stop.abort();
				await finished;
			},
		};
	} catch (error) {
		try {
			await cleanup();
		} catch (drainError) {
			throw new Error("OFFICE_SERVICE_DRAIN_UNCONFIRMED", { cause: new AggregateError([error, drainError]) });
		}
		throw new Error("OFFICE_SERVICE_START_FAILED", { cause: error });
	}
}
