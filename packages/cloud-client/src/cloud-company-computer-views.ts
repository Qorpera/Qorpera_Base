import {
	assertCompanyComputerScope,
	assertCompanyComputerScreenBinding,
	COMPANY_COMPUTER_UUID,
	type CompanyComputerScope,
	type CompanyComputerScreenBinding,
	companyComputerRequest,
} from "./cloud-company-computer-contract.ts";
import {
	type CompanyComputerPrivacyChallenge,
	parseCompanyComputerPrivacyChallenge,
} from "./cloud-company-computer-privacy.ts";
import { type CompanyComputerMaintenance, parseCompanyComputerMaintenance } from "./cloud-company-computer-start.ts";
import {
	assertCompanyComputerViewerUrl,
	COMPANY_COMPUTER_VIEW_TOKEN,
	type CompanyComputerViewChannel,
	type CompanyComputerWebSocket,
	connectCompanyComputerViewChannel,
} from "./cloud-company-computer-view-channel.ts";
import { parseCompanyComputerViewerGrant } from "./cloud-company-computer-viewer.ts";
import { withCloudDeadline } from "./cloud-request.ts";

export type CloudCompanyComputerViewsRpc = (
	method:
		| "qorpera_runtime_office_member_status"
		| "qorpera_open_runtime_office_screen"
		| "qorpera_request_runtime_office_drain"
		| "qorpera_create_runtime_office_viewer"
		| "qorpera_cancel_runtime_office_viewer",
	args: Record<string, unknown>,
	signal: AbortSignal,
) => Promise<{ data: unknown; error: unknown }>;

export interface CompanyComputerMemberScreen {
	binding: CompanyComputerScreenBinding;
	epoch: number;
	drainPending: boolean;
	takeoverMemberId: string | null;
	driver: "idle" | "agent" | "member" | "draining";
}
export interface CompanyComputerMemberStatus {
	scope: CompanyComputerScope;
	computerGeneration: number;
	state: "provisioning" | "active" | "maintenance" | "recovering" | "retired";
	privacyState: "shared" | "entering" | "private" | "leaving";
	privacyVersion: number;
	maintenance: CompanyComputerMaintenance | null;
	screens: CompanyComputerMemberScreen[];
	viewers: {
		viewerSessionId: string;
		screenId: string;
		mode: "watch" | "control";
		state: "issued" | "active" | "draining";
	}[];
}
export interface CompanyComputerMemberView {
	connectionId: string;
	binding: CompanyComputerScreenBinding;
	mode: "watch" | "control";
	channel: CompanyComputerViewChannel;
	/** Disconnects immediately, then requests exact durable cancellation. An
	 * acknowledgement records intent; only the runtime can prove input drain. */
	close(): Promise<void>;
}
function keys(value: unknown, expected: string): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== expected)
		throw new Error("INVALID_OFFICE_VIEW_RESPONSE");
}
const bindingKeys =
	"companyComputerId,companyId,computerGeneration,environmentId,logicalComputerId,screenGeneration,screenId,screenOrdinal,staffAgentId";
function epoch(value: unknown): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= Number.MAX_SAFE_INTEGER)
		throw new Error("INVALID_OFFICE_EPOCH");
}

/** Both member clients use this authenticated API. The URL is trusted host
 * configuration, independent of RPC responses and guest content. No runtime
 * credential, direct guest address, provider or local execution is involved. */
export class CloudCompanyComputerViews {
	readonly #scope: CompanyComputerScope;
	readonly #memberId: string;
	readonly #url: string;
	readonly #rpc: CloudCompanyComputerViewsRpc;
	readonly #createWebSocket?: (url: string) => CompanyComputerWebSocket;
	constructor(options: {
		scope: CompanyComputerScope;
		memberId: string;
		url: string;
		rpc: CloudCompanyComputerViewsRpc;
		createWebSocket?: (url: string) => CompanyComputerWebSocket;
	}) {
		assertCompanyComputerScope(options.scope, options.scope);
		if (!COMPANY_COMPUTER_UUID.test(options.memberId)) throw new Error("INVALID_VIEWER_MEMBER");
		assertCompanyComputerViewerUrl(options.url, options.scope.companyComputerId);
		this.#scope = Object.freeze({ ...options.scope });
		this.#memberId = options.memberId;
		this.#url = options.url;
		this.#rpc = options.rpc;
		this.#createWebSocket = options.createWebSocket;
	}
	async #request(
		method: Parameters<CloudCompanyComputerViewsRpc>[0],
		args: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<unknown> {
		try {
			const response = await companyComputerRequest((s) => this.#rpc(method, structuredClone(args), s), signal);
			if (!response || response.error) throw new Error("unconfirmed");
			return response.data;
		} catch {
			throw new Error("OFFICE_VIEW_UNCONFIRMED_REFRESH_STATUS");
		}
	}
	async status(signal: AbortSignal): Promise<CompanyComputerMemberStatus> {
		const value = await this.#request("qorpera_runtime_office_member_status", { p_scope: this.#scope }, signal);
		const withMaintenance = !!value && typeof value === "object" && "maintenance" in value;
		keys(
			value,
			withMaintenance
				? "computerGeneration,maintenance,privacyState,privacyVersion,scope,screens,state,viewers"
				: "computerGeneration,privacyState,privacyVersion,scope,screens,state,viewers",
		);
		keys(value.scope, "companyComputerId,companyId,environmentId,logicalComputerId");
		assertCompanyComputerScope(value.scope as unknown as CompanyComputerScope, this.#scope);
		epoch(value.computerGeneration);
		epoch(value.privacyVersion);
		if (
			value.computerGeneration < 1 ||
			!["provisioning", "active", "maintenance", "recovering", "retired"].includes(value.state as string) ||
			!["shared", "entering", "private", "leaving"].includes(value.privacyState as string) ||
			!Array.isArray(value.screens) ||
			value.screens.length > 32 ||
			!Array.isArray(value.viewers) ||
			value.viewers.length > 64
		)
			throw new Error("INVALID_OFFICE_VIEW_RESPONSE");
		const screens = new Set<string>();
		const ordinals = new Set<number>();
		const viewers = new Set<string>();
		for (const screen of value.screens) {
			keys(screen, "binding,drainPending,driver,epoch,takeoverMemberId");
			keys(screen.binding, bindingKeys);
			epoch(screen.epoch);
			const binding = screen.binding as unknown as CompanyComputerScreenBinding;
			assertCompanyComputerScreenBinding(binding, binding);
			assertCompanyComputerScope(binding, this.#scope);
			if (
				binding.computerGeneration !== value.computerGeneration ||
				screens.has(binding.screenId) ||
				ordinals.has(binding.screenOrdinal) ||
				typeof screen.drainPending !== "boolean" ||
				(screen.takeoverMemberId !== null &&
					(typeof screen.takeoverMemberId !== "string" || !COMPANY_COMPUTER_UUID.test(screen.takeoverMemberId))) ||
				!["idle", "agent", "member", "draining"].includes(screen.driver as string)
			)
				throw new Error("INVALID_OFFICE_VIEW_RESPONSE");
			screens.add(binding.screenId);
			ordinals.add(binding.screenOrdinal);
		}
		for (const viewer of value.viewers) {
			keys(viewer, "mode,screenId,state,viewerSessionId");
			if (
				typeof viewer.viewerSessionId !== "string" ||
				!COMPANY_COMPUTER_UUID.test(viewer.viewerSessionId) ||
				viewers.has(viewer.viewerSessionId) ||
				typeof viewer.screenId !== "string" ||
				!COMPANY_COMPUTER_UUID.test(viewer.screenId) ||
				!["watch", "control"].includes(viewer.mode as string) ||
				!["issued", "active", "draining"].includes(viewer.state as string)
			)
				throw new Error("INVALID_OFFICE_VIEW_RESPONSE");
			viewers.add(viewer.viewerSessionId);
		}
		const status = structuredClone(value) as unknown as CompanyComputerMemberStatus;
		status.maintenance = withMaintenance ? parseCompanyComputerMaintenance(value.maintenance) : null;
		return status;
	}
	/** A member opens an agent's screen so there is a desktop to look at before the
	 * agent's first run leases one. The guest starts it when a viewer connects. */
	async openScreen(
		staffAgentId: string,
		signal: AbortSignal,
	): Promise<
		| { state: "open" }
		| {
				state: "refused";
				reason:
					| "COMPUTER_NOT_ACTIVE"
					| "AGENT_HAS_NO_COMPUTER_ACCESS"
					| "SCREEN_CAPACITY_EXHAUSTED"
					| "SCREEN_OCCUPIED";
		  }
	> {
		if (!COMPANY_COMPUTER_UUID.test(staffAgentId)) throw new Error("INVALID_OFFICE_VIEW_REQUEST");
		const value = (await this.#request(
			"qorpera_open_runtime_office_screen",
			{ p_scope: this.#scope, p_staff_agent_id: staffAgentId },
			signal,
		)) as { state?: unknown; reason?: unknown } | null;
		if (!value || typeof value !== "object") throw new Error("INVALID_OFFICE_VIEW_RESPONSE");
		if (value.state === "open") return { state: "open" };
		if (
			value.state === "refused" &&
			(value.reason === "COMPUTER_NOT_ACTIVE" ||
				value.reason === "AGENT_HAS_NO_COMPUTER_ACCESS" ||
				value.reason === "SCREEN_CAPACITY_EXHAUSTED" ||
				value.reason === "SCREEN_OCCUPIED")
		)
			return { state: "refused", reason: value.reason };
		throw new Error("INVALID_OFFICE_VIEW_RESPONSE");
	}
	/** Explicit intent only. Call status to observe the runtime acknowledgement;
	 * never assume this response means that member input is ready. */
	async requestTakeover(screen: CompanyComputerMemberScreen, signal: AbortSignal): Promise<void> {
		assertCompanyComputerScreenBinding(screen.binding, screen.binding);
		assertCompanyComputerScope(screen.binding, this.#scope);
		epoch(screen.epoch);
		const value = await this.#request(
			"qorpera_request_runtime_office_drain",
			{
				p_scope: this.#scope,
				p_screen_id: screen.binding.screenId,
				p_computer_generation: screen.binding.computerGeneration,
				p_screen_generation: screen.binding.screenGeneration,
				p_epoch: screen.epoch,
				p_takeover: true,
			},
			signal,
		);
		keys(value, "binding,drainId,epoch,state");
		keys(value.binding, bindingKeys);
		assertCompanyComputerScreenBinding(value.binding as unknown as CompanyComputerScreenBinding, screen.binding);
		if (
			value.state !== "draining" ||
			value.epoch !== screen.epoch + 1 ||
			typeof value.drainId !== "string" ||
			!COMPANY_COMPUTER_UUID.test(value.drainId)
		)
			throw new Error("INVALID_OFFICE_VIEW_RESPONSE");
	}
	async cancel(viewerSessionId: string, signal: AbortSignal): Promise<void> {
		if (!COMPANY_COMPUTER_UUID.test(viewerSessionId)) throw new Error("INVALID_VIEWER_SESSION");
		const result = await this.#request(
			"qorpera_cancel_runtime_office_viewer",
			{ p_scope: this.#scope, p_viewer_session_id: viewerSessionId },
			signal,
		);
		keys(result, "state");
		if (result.state !== "released") throw new Error("OFFICE_VIEW_CLEANUP_UNCONFIRMED");
	}
	/** Explicit user connection. Reads fresh authority, submits at most one
	 * takeover, then waits for physical acknowledgement. Unknown mutations are
	 * never replayed. Callers must choose watch again after disconnection. */
	async connectScreen(options: {
		binding: CompanyComputerScreenBinding;
		mode: "watch" | "control";
		signal: AbortSignal;
	}): Promise<CompanyComputerMemberView> {
		const binding = structuredClone(options.binding),
			mode = options.mode;
		assertCompanyComputerScreenBinding(binding, binding);
		assertCompanyComputerScope(binding, this.#scope);
		if (mode !== "watch" && mode !== "control") throw new Error("INVALID_VIEW_MODE");
		const screen = await withCloudDeadline(
			async (signal) => {
				let expectedEpoch: number | undefined;
				let privacyVersion: number | undefined;
				for (;;) {
					const status = await this.status(signal);
					if (
						status.state !== "active" ||
						status.privacyState !== "shared" ||
						(privacyVersion !== undefined && status.privacyVersion !== privacyVersion)
					)
						throw new Error("OFFICE_VIEW_CHANGED");
					privacyVersion = status.privacyVersion;
					const observed = status.screens.find((screen) => screen.binding.screenId === binding.screenId);
					if (!observed) throw new Error("OFFICE_SCREEN_CHANGED");
					assertCompanyComputerScreenBinding(observed.binding, binding);
					if (mode === "watch" && !observed.drainPending) return observed;
					if (mode === "control") {
						if (
							(observed.takeoverMemberId !== null && observed.takeoverMemberId !== this.#memberId) ||
							(expectedEpoch !== undefined &&
								(observed.epoch !== expectedEpoch || observed.takeoverMemberId !== this.#memberId))
						)
							throw new Error("OFFICE_SCREEN_CHANGED");
						if (observed.takeoverMemberId === this.#memberId) {
							expectedEpoch ??= observed.epoch;
							if (!observed.drainPending && observed.driver === "member") return observed;
						} else {
							if (observed.drainPending) throw new Error("OFFICE_SCREEN_DRAINING");
							expectedEpoch = observed.epoch + 1;
							await this.requestTakeover(observed, signal);
						}
					}
					await new Promise<void>((resolve, reject) => {
						const abort = () => {
							clearTimeout(timer);
							reject(signal.reason);
						};
						const timer = setTimeout(() => {
							signal.removeEventListener("abort", abort);
							resolve();
						}, 250);
						signal.addEventListener("abort", abort, { once: true });
						if (signal.aborted) abort();
					});
				}
			},
			20000,
			options.signal,
		);
		options.signal.throwIfAborted();
		return this.connect({ binding, mode, screenEpoch: screen.epoch, signal: options.signal });
	}
	/** Private input is authorized by the owner's acknowledged challenge. It
	 * never requests a shared-screen takeover, including on explicit reconnect. */
	async connectPrivate(options: {
		challenge: CompanyComputerPrivacyChallenge;
		signal: AbortSignal;
	}): Promise<CompanyComputerMemberView> {
		const challenge = parseCompanyComputerPrivacyChallenge(options.challenge, this.#scope);
		if (challenge.memberId !== this.#memberId || challenge.state !== "entering")
			throw new Error("INVALID_PRIVATE_SIGN_IN_OWNER");
		const target = challenge.drains.find((drain) => drain.binding.screenId === challenge.screenId)!;
		const screen = await withCloudDeadline(
			async (signal) => {
				for (;;) {
					const status = await this.status(signal);
					if (
						status.state !== "active" ||
						status.privacyState !== "private" ||
						status.privacyVersion !== challenge.version ||
						status.computerGeneration !== challenge.computerGeneration
					)
						throw new Error("OFFICE_PRIVATE_SIGN_IN_CHANGED");
					const observed = status.screens.find((screen) => screen.binding.screenId === challenge.screenId);
					if (!observed || observed.epoch < target.epoch) throw new Error("OFFICE_SCREEN_CHANGED");
					assertCompanyComputerScreenBinding(observed.binding, target.binding);
					if (!observed.drainPending) return observed;
					await new Promise<void>((resolve, reject) => {
						const abort = () => {
							clearTimeout(timer);
							reject(signal.reason);
						};
						const timer = setTimeout(() => {
							signal.removeEventListener("abort", abort);
							resolve();
						}, 250);
						signal.addEventListener("abort", abort, { once: true });
						if (signal.aborted) abort();
					});
				}
			},
			20000,
			options.signal,
		);
		options.signal.throwIfAborted();
		return this.connect({
			binding: target.binding,
			screenEpoch: screen.epoch,
			mode: "control",
			privateChallenge: challenge,
			signal: options.signal,
		});
	}
	async connect(options: {
		binding: CompanyComputerScreenBinding;
		screenEpoch: number;
		mode?: "watch" | "control";
		privateChallenge?: CompanyComputerPrivacyChallenge;
		signal: AbortSignal;
	}): Promise<CompanyComputerMemberView> {
		const binding = structuredClone(options.binding);
		const mode = options.mode ?? "watch";
		assertCompanyComputerScreenBinding(binding, binding);
		assertCompanyComputerScope(binding, this.#scope);
		epoch(options.screenEpoch);
		if (!["watch", "control"].includes(mode)) throw new Error("INVALID_VIEW_MODE");
		const challenge = options.privateChallenge
			? parseCompanyComputerPrivacyChallenge(options.privateChallenge, this.#scope)
			: null;
		if (
			challenge &&
			(mode !== "control" ||
				challenge.memberId !== this.#memberId ||
				challenge.state !== "entering" ||
				challenge.screenId !== binding.screenId ||
				challenge.computerGeneration !== binding.computerGeneration)
		)
			throw new Error("INVALID_PRIVATE_VIEWER");
		const started = performance.now();
		const value = await this.#request(
			"qorpera_create_runtime_office_viewer",
			{ p_binding: binding, p_epoch: options.screenEpoch, p_mode: mode, p_private_challenge: challenge },
			options.signal,
		);
		if (value && typeof value === "object" && "state" in value && value.state === "refused") {
			keys(value, "reason,state");
			const refusal: Record<string, unknown> = value;
			if (refusal.reason === "SCREEN_OCCUPIED" || refusal.reason === "VIEWER_CAPACITY_EXHAUSTED")
				throw new Error(refusal.reason);
			throw new Error("INVALID_OFFICE_VIEW_RESPONSE");
		}
		keys(value, "capability,grant,state");
		const grant = parseCompanyComputerViewerGrant(value.grant);
		assertCompanyComputerScreenBinding(grant.binding, binding);
		if (
			grant.memberId !== this.#memberId ||
			grant.mode !== mode ||
			grant.screenEpoch !== options.screenEpoch ||
			(challenge
				? grant.privacyVersion !== challenge.version ||
					grant.privateSignIn?.challengeId !== challenge.challengeId ||
					grant.privateSignIn.profileId !== challenge.profileId ||
					grant.privateSignIn.profileVersion !== challenge.profileVersion
				: !!grant.privateSignIn)
		)
			throw new Error("OFFICE_VIEW_GRANT_CHANGED");
		let channel: CompanyComputerViewChannel;
		try {
			if (
				value.state !== "issued" ||
				typeof value.capability !== "string" ||
				!COMPANY_COMPUTER_VIEW_TOKEN.test(value.capability)
			)
				throw new Error("INVALID_OFFICE_VIEW_RESPONSE");
			channel = await connectCompanyComputerViewChannel({
				url: this.#url,
				capability: value.capability,
				binding,
				mode,
				validForMs: Math.floor(grant.validForMs - (performance.now() - started)),
				signal: options.signal,
				createWebSocket: this.#createWebSocket,
			});
		} catch {
			await this.cancel(grant.viewerSessionId, new AbortController().signal).catch(() => undefined);
			throw new Error("OFFICE_VIEW_UNCONFIRMED_REFRESH_STATUS");
		} finally {
			value.capability = "";
		}
		let closing: Promise<void> | undefined;
		const close = (): Promise<void> => {
			channel.close();
			options.signal.removeEventListener("abort", aborted);
			closing ??= this.cancel(grant.viewerSessionId, new AbortController().signal).catch((error) => {
				closing = undefined;
				throw error;
			});
			return closing;
		};
		const aborted = (): void => {
			void close().catch(() => undefined);
		};
		options.signal.addEventListener("abort", aborted, { once: true });
		if (options.signal.aborted) {
			await close();
			throw new Error("VIEW_UNAVAILABLE");
		}
		return { connectionId: grant.viewerSessionId, binding, mode, channel, close };
	}
}
