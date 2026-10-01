import {
	type CreateMemberSponsorInput,
	type NativeExecutionConnections,
	type NativeMemberConnection,
	NativeSubscriptionControlPlane,
	type RequestSponsoredSessionTurnInput,
	type RevokeNativeProviderConnectionInput,
	type SessionTurnProvenance,
	type SessionTurnRequestResult,
} from "@qorpera/cloud-client/cloud-native-subscription-control";
import { readBoundedCloudResponse, withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import {
	type NativeAccountRefreshDescription,
	type NativeAccountRefreshRequest,
	nativeAccountRefreshBody,
	parseNativeAccountRefreshDescription,
	parseNativeAccountRefreshResult,
} from "@qorpera/cloud-client/native-account-refresh";
import { HttpNativeProviderIdentityBridge } from "@qorpera/cloud-client/native-provider-login";
import { type Cloud, CloudRpcError } from "./client.ts";
import { parseCloudConfig } from "./deployment-config.ts";
import { UUID_PATTERN } from "./parse.ts";

export interface WebNativeProviderLoginInput {
	provider: "openai" | "anthropic";
	displayName: string;
	clientIdentityId: string;
	clientLoginId: string;
	clientConnectionId: string;
}

export interface WebNativeProviderLogin {
	loginId: string;
	clientConnectionId: string;
	status: "awaiting_member" | "completed" | "preparing";
	interactionUrl?: string;
	userCode?: string;
	expiresAt: string;
}

/** A member's connection with what the web reads beside the SDK's fields (migration
 * 20260929970000): the login's kind (absent for a node login), whether its member turned
 * on work while away for this version, and when the member's first-routine card was shown. */
export type WebMemberConnection = NativeMemberConnection & {
	loginKind?: "codex" | "chatgpt_plan";
	allowAutonomous?: boolean;
	routineOfferShownAt?: string;
};
export interface WebExecutionConnections extends NativeExecutionConnections {
	connections: readonly WebMemberConnection[];
}
/** A ChatGPT plan login: its member alone turns on work while away (Sign in with ChatGPT). */
export const planLogin = (connection: WebMemberConnection): boolean => connection.loginKind === "chatgpt_plan";

export interface WebNativeSubscription {
	readonly onboardingAvailable: boolean;
	beginProviderLogin(input: WebNativeProviderLoginInput, signal?: AbortSignal): Promise<WebNativeProviderLogin>;
	listConnections(signal?: AbortSignal): Promise<WebExecutionConnections>;
	/** Resolves once account usage is current. `force` asks for a new observation
	 * even inside the window of a completed attempt: the member pressed Refresh. */
	refreshAccountMetadata?(signal?: AbortSignal, force?: boolean): Promise<void>;
	selectSessionAccount?(sessionId: string, signal?: AbortSignal): Promise<string | undefined>;
	listSessionTurnProvenance(sessionId: string, signal?: AbortSignal): Promise<readonly SessionTurnProvenance[]>;
	requestSessionTurn(input: RequestSponsoredSessionTurnInput, signal?: AbortSignal): Promise<SessionTurnRequestResult>;
	createMemberSponsor(
		input: Omit<CreateMemberSponsorInput, "profileId"> & { planLogin?: boolean },
		signal?: AbortSignal,
	): Promise<{ bindingId: string; version: number }>;
	/** The member's own choice for their ChatGPT plan: work while they are away, or not. */
	setWorkWhileAway?(connectionId: string, on: boolean, signal?: AbortSignal): Promise<void>;
	/** Records that the member was shown the first-routine card (once per member and company). */
	recordRoutineOffer?(connectionId: string, signal?: AbortSignal): Promise<string>;
	revokeConnection(
		input: Omit<RevokeNativeProviderConnectionInput, "profileId">,
		signal?: AbortSignal,
	): Promise<{ connectionId: string; status: "revoked" }>;
}

/** The same rule as the server's admission: usage observed within the last
 * minute whose windows have not reset needs no new observation. Requesting one
 * anyway records an attempt, and a stale one boots a login guest. Inside the
 * window of an attempt that already completed (`held`), only a reset that has
 * passed since justifies another: usage that attempt could not observe, or
 * that has merely aged, would not be observed by asking again. */
function usageStale(account: NativeMemberConnection, now: number, held: boolean): boolean {
	const usage = account.providerAccountUsage;
	if (!usage) return !held;
	if (!held) {
		const observedAt = Date.parse(usage.observedAt);
		if (!(observedAt > now - 60_000) || observedAt > now + 30_000) return true;
	}
	return usage.windows.some((window) => window.resetAt !== undefined && Date.parse(window.resetAt) <= now);
}

/** The plan fields of one connection version, from the list's own answer; anything malformed
 * reads as absent (a Codex or node login). */
function withPlanFields(connection: NativeMemberConnection, answer: unknown): WebMemberConnection {
	const entries =
		answer && typeof answer === "object" && Array.isArray((answer as { connections?: unknown }).connections)
			? ((answer as { connections: unknown[] }).connections as unknown[])
			: [];
	const entry = entries.find(
		(item): item is Record<string, unknown> =>
			Boolean(item) &&
			typeof item === "object" &&
			(item as Record<string, unknown>).connection_id === connection.connectionId &&
			(item as Record<string, unknown>).connection_version === connection.connectionVersion,
	);
	if (!entry) return connection;
	const kind = entry.login_kind;
	const shown = entry.routine_offer_shown_at;
	return {
		...connection,
		...(kind === "codex" || kind === "chatgpt_plan" ? { loginKind: kind } : {}),
		...(typeof entry.allow_autonomous === "boolean" ? { allowAutonomous: entry.allow_autonomous } : {}),
		...(typeof shown === "string" && Number.isFinite(Date.parse(shown)) ? { routineOfferShownAt: shown } : {}),
	};
}

/** The SDK owns admission and provenance contracts. This host only supplies
 * member authentication, profile selection and cancellable browser transport.
 * Callers retain mutation request IDs before submission for explicit recovery. */
export function createWebNativeSubscription(
	cloud: Cloud,
	profileId: string,
	memberId: string,
	companySignal: AbortSignal,
	current: (sessionId?: string) => void,
): WebNativeSubscription {
	const origin = new URL(cloud.config.projectUrl);
	if (
		origin.protocol !== "https:" ||
		origin.username ||
		origin.password ||
		origin.pathname !== "/" ||
		origin.search ||
		origin.hash
	)
		throw new Error("Invalid cloud execution configuration.");
	const loginBase =
		cloud.config.nativeProviderLoginUrl === undefined
			? undefined
			: parseCloudConfig(cloud.config).nativeProviderLoginUrl;
	const rpc = (method: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal, sessionId?: string) => {
		// Snapshot SDK arguments before authentication can yield to another UI action.
		const body = JSON.stringify(args);
		return withCloudDeadline(
			async (deadline) => {
				const check = () => {
					deadline.throwIfAborted();
					current(sessionId);
				};
				check();
				const { data, error } = await cloud.supabase.auth.getSession();
				check();
				if (
					error ||
					!data.session ||
					data.session.user.id !== memberId ||
					!/^[A-Za-z0-9._~-]{1,8192}$/.test(data.session.access_token)
				)
					throw new Error("Sign in again to manage cloud execution.");
				const response = await fetch(`${origin.origin}/rest/v1/rpc/${method}`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${data.session.access_token}`,
						apikey: cloud.config.publishableKey,
						"content-type": "application/json",
					},
					body,
					signal: deadline,
					redirect: "error",
					cache: "no-store",
					credentials: "omit",
				});
				try {
					check();
					if (response.status === 401 || response.status === 403)
						throw new CloudRpcError(
							method,
							{ message: "You do not have permission to manage this cloud execution.", code: "42501" },
							response.status,
						);
					if (response.status !== 200) {
						if (method === "qorpera_begin_native_account_refresh") {
							const failure: unknown = JSON.parse(
								new TextDecoder().decode(await readBoundedCloudResponse(response, 64 * 1024, deadline)),
							);
							if (failure && typeof failure === "object" && "code" in failure && failure.code === "55000")
								throw new CloudRpcError(
									method,
									{ message: "Account refresh is in progress", code: "55000" },
									response.status,
								);
						}
						throw new Error("Cloud execution response was unavailable.");
					}
					const value: unknown = JSON.parse(
						new TextDecoder("utf-8", { fatal: true }).decode(
							await readBoundedCloudResponse(response, 1024 * 1024, deadline),
						),
					);
					check();
					return value;
				} finally {
					if (!response.body?.locked) void response.body?.cancel().catch(() => undefined);
				}
			},
			10000,
			AbortSignal.any([companySignal, ...(signal ? [signal] : [])]),
		).catch((error: unknown) => {
			if (
				error instanceof CloudRpcError &&
				(error.denied || (method === "qorpera_begin_native_account_refresh" && error.code === "55000"))
			)
				throw error;
			throw new Error("Cloud execution could not be confirmed. Refresh its status before trying again.");
		});
	};
	const client = (signal?: AbortSignal, sessionId?: string) =>
		new NativeSubscriptionControlPlane({ rpc: (method, args) => rpc(method, args, signal, sessionId) });
	const consent = async (connectionId: string, allow: boolean): Promise<number> => {
		const value = (await cloud.rpc("qorpera_consent_provider_connection_autonomous", {
			p_profile_id: profileId,
			p_connection_id: connectionId,
			p_allow_autonomous: allow,
		})) as { connection_id?: unknown; version?: unknown; allow_autonomous?: unknown } | null;
		if (
			value?.connection_id !== connectionId ||
			value.allow_autonomous !== allow ||
			!Number.isSafeInteger(value.version)
		)
			throw new Error("Invalid cloud response");
		return value.version as number;
	};
	let pendingMetadataRefresh: Promise<void> | undefined;
	let metadataAdmission:
		| { clientRequestId: string; capability: string; expiresAt: number; completed: boolean }
		| undefined;
	const admit = () => {
		const bytes = crypto.getRandomValues(new Uint8Array(32));
		const capability = btoa(String.fromCharCode(...bytes))
			.replaceAll("+", "-")
			.replaceAll("/", "_")
			.replace(/=+$/, "");
		metadataAdmission = {
			clientRequestId: crypto.randomUUID(),
			capability,
			expiresAt: Date.now() + 300_000,
			completed: false,
		};
		return metadataAdmission;
	};
	return {
		onboardingAvailable: loginBase !== undefined,
		beginProviderLogin: (input, signal) => {
			// Admission creates its capability inside the SDK. Calling admission again
			// with the same IDs would create different authority, so never retry it.
			const request = { ...input };
			return withCloudDeadline(
				async (deadline) => {
					const check = () => {
						deadline.throwIfAborted();
						current();
					};
					check();
					if (!loginBase) throw new Error("Native provider login is not configured.");
					if (
						(request.provider !== "openai" && request.provider !== "anthropic") ||
						!request.displayName.trim() ||
						request.displayName.length > 120 ||
						/[\0\r\n]/.test(request.displayName) ||
						![request.clientIdentityId, request.clientLoginId, request.clientConnectionId].every((value) =>
							/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
						)
					)
						throw new Error("Native provider login input is invalid.");
					const control = client(deadline);
					const existing = await control.listConnections(profileId);
					check();
					const identity =
						existing.computeIdentity ??
						(await control.createMemberComputeIdentity({
							profileId,
							clientIdentityId: request.clientIdentityId,
							displayName: request.displayName,
							policy: { credentialExport: false, operatorBlindnessClaimed: false },
						}));
					check();
					if (
						identity.ownerUserId !== memberId ||
						identity.ownershipKind !== "member" ||
						identity.status !== "active"
					)
						throw new Error("Native provider login identity does not match this member.");
					const harness = request.provider === "openai" ? "codex-cli" : "claude-code";
					const authorization = await control.beginNativeProviderLogin({
						profileId,
						computeIdentityId: identity.computeIdentityId,
						provider: request.provider,
						nativeHarness: harness,
						clientLoginId: request.clientLoginId,
						clientConnectionId: request.clientConnectionId,
					});
					check();
					if (
						authorization.computeIdentityId !== identity.computeIdentityId ||
						authorization.computeIdentityOwnershipKind !== "member" ||
						authorization.computeIdentityOwnerUserId !== memberId ||
						authorization.provider !== request.provider ||
						authorization.nativeHarness !== harness ||
						authorization.clientLoginId !== request.clientLoginId ||
						authorization.clientConnectionId !== request.clientConnectionId
					)
						throw new Error("Native provider login authority does not match this request.");
					const endpoint = new URL("login", loginBase).href;
					const bridge = new HttpNativeProviderIdentityBridge(
						loginBase,
						async (url, init) => {
							const checkBridge = () => {
								check();
								init?.signal?.throwIfAborted();
							};
							checkBridge();
							if (String(url) !== endpoint || init?.method !== "POST")
								throw new Error("Unexpected native login destination.");
							const { data, error } = await cloud.supabase.auth.getSession();
							checkBridge();
							if (error || data.session?.user.id !== memberId) throw new Error("Native login account changed.");
							// The bridge supplies only the scoped capability, never the member JWT.
							const response = await fetch(endpoint, {
								...init,
								credentials: "omit",
								cache: "no-store",
								redirect: "error",
							});
							try {
								checkBridge();
								if (response.status === 401 || response.status === 403)
									throw new CloudRpcError(
										"native-provider-login",
										{ message: "You do not have permission to start this provider login.", code: "42501" },
										response.status,
									);
								return response;
							} catch (error) {
								if (!response.body?.locked) void response.body?.cancel().catch(() => undefined);
								throw error;
							}
						},
						{ signal: deadline },
					);
					let prompt = await bridge.beginLogin(authorization);
					check();
					// The node answers `preparing` while it boots or recovers the login
					// machine (up to a few minutes); the same login is posted again.
					while (prompt.status === "preparing") {
						await new Promise<void>((resolve, reject) => {
							const interrupted = () => {
								clearTimeout(timer);
								reject(new Error("Provider login preparation was interrupted."));
							};
							const timer = setTimeout(() => {
								deadline.removeEventListener("abort", interrupted);
								resolve();
							}, 1000);
							deadline.addEventListener("abort", interrupted, { once: true });
						});
						check();
						prompt = await bridge.beginLogin(authorization);
						check();
					}
					return { ...prompt, clientConnectionId: request.clientConnectionId, expiresAt: authorization.expiresAt };
				},
				120000,
				AbortSignal.any([companySignal, ...(signal ? [signal] : [])]),
			)
				.then((result) => {
					companySignal.throwIfAborted();
					signal?.throwIfAborted();
					current();
					return result;
				})
				.catch((error: unknown) => {
					if (error instanceof CloudRpcError && error.denied) throw error;
					throw new Error(
						"Provider login could not be confirmed. Refresh connections before starting a new sign-in attempt.",
					);
				});
		},
		listConnections: async (signal) => {
			// The SDK reads the fields it knows; the plan fields come from the same answer.
			let answer: unknown;
			const listed = await new NativeSubscriptionControlPlane({
				rpc: async (method, args) => {
					const value = await rpc(method, args, signal);
					if (method === "qorpera_list_member_native_execution_connections") answer = value;
					return value;
				},
			}).listConnections(profileId);
			return { ...listed, connections: listed.connections.map((connection) => withPlanFields(connection, answer)) };
		},
		refreshAccountMetadata: async (signal, force = false) => {
			const checked = AbortSignal.any([companySignal, ...(signal ? [signal] : [])]);
			checked.throwIfAborted();
			current();
			if (!pendingMetadataRefresh) {
				const work = withCloudDeadline(
					async (deadline) => {
						const accounts = await client(deadline).listConnections(profileId);
						const eligible = accounts.connections.filter(
							(account) =>
								account.provider === "openai" &&
								account.nativeHarness === "codex-cli" &&
								account.connectionStatus === "active" &&
								account.authorizationState === "active",
						);
						if (!accounts.computeIdentity || !eligible.length) return;
						// A completed attempt keeps its authority until it expires: at most one
						// attempt per expiry window, however often views ask, unless a reset
						// passed in the meantime or the member asked.
						const held = metadataAdmission?.completed === true && metadataAdmission.expiresAt > Date.now();
						if (!force) {
							const now = Date.now();
							if (!eligible.some((account) => usageStale(account, now, held))) return;
						}
						// An attempt that did not complete keeps its authority for a retry.
						const admission =
							!metadataAdmission || held || metadataAdmission.expiresAt <= Date.now()
								? admit()
								: metadataAdmission;
						const settle = (expiresAt: string) => {
							admission.expiresAt = Date.parse(expiresAt);
							admission.completed = true;
						};
						if (!loginBase) throw new Error("Account refresh is not configured");
						const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(admission.capability));
						const pause = (milliseconds: number) =>
							new Promise<void>((resolve, reject) => {
								deadline.throwIfAborted();
								const stop = () => {
									clearTimeout(timer);
									reject(new Error("Account refresh interrupted"));
								};
								const timer = setTimeout(() => {
									deadline.removeEventListener("abort", stop);
									resolve();
								}, milliseconds);
								deadline.addEventListener("abort", stop, { once: true });
							});
						const args = {
							p_profile_id: profileId,
							p_client_request_id: admission.clientRequestId,
							p_capability_sha256: Array.from(new Uint8Array(digest), (byte) =>
								byte.toString(16).padStart(2, "0"),
							).join(""),
						};
						let authority: NativeAccountRefreshDescription;
						// Another attempt of this member is pending (another tab, or one this page left behind).
						// Begin answers 55000 until it settles or expires, so watch that attempt with the read
						// and ask begin again only once it is gone: a steady retry is an error storm.
						let wait = 2000;
						for (;;) {
							try {
								authority = parseNativeAccountRefreshDescription(
									await rpc("qorpera_begin_native_account_refresh", args, deadline),
								);
								break;
							} catch (error) {
								if (!(error instanceof CloudRpcError) || error.code !== "55000") throw error;
							}
							for (;;) {
								const receipt = await rpc(
									"qorpera_get_native_account_refresh",
									{ p_profile_id: profileId },
									deadline,
								);
								let settled = receipt === null;
								if (receipt !== null) {
									const observed = parseNativeAccountRefreshDescription(receipt);
									if (
										observed.profileId !== profileId ||
										observed.requestedByUserId !== memberId ||
										observed.computeIdentityId !== accounts.computeIdentity.computeIdentityId
									)
										throw new Error("Account refresh authority changed");
									settled = Date.parse(observed.expiresAt) <= Date.now();
									if (!settled && observed.status === "completed") {
										settle(observed.expiresAt);
										return;
									}
								}
								await pause(wait);
								wait = Math.min(Math.round(wait * 1.5), 10_000);
								if (settled) break;
							}
						}
						if (
							authority.profileId !== profileId ||
							authority.computeIdentityId !== accounts.computeIdentity.computeIdentityId ||
							authority.requestedByUserId !== memberId ||
							Date.parse(authority.expiresAt) <= Date.now()
						)
							throw new Error("Account refresh authority changed");
						admission.expiresAt = Date.parse(authority.expiresAt);
						if (authority.status === "completed") {
							settle(authority.expiresAt);
							return;
						}
						const request: NativeAccountRefreshRequest = { ...authority, capability: admission.capability };
						const body = JSON.stringify(nativeAccountRefreshBody(request));
						// The host answers "preparing" while the refresh machine boots; ask less often as it takes longer.
						let poll = 1000;
						for (;;) {
							deadline.throwIfAborted();
							current();
							const { data, error } = await cloud.supabase.auth.getSession();
							deadline.throwIfAborted();
							current();
							if (error || data.session?.user.id !== memberId) throw new Error("Account refresh member changed");
							const response = await fetch(new URL("account-refresh", loginBase).href, {
								method: "POST",
								headers: {
									authorization: `Bearer ${admission.capability}`,
									"content-type": "application/json",
								},
								body,
								signal: deadline,
								redirect: "error",
								cache: "no-store",
								credentials: "omit",
							});
							try {
								if (!response.ok) throw new Error("Account refresh unavailable");
								const value: unknown = JSON.parse(
									new TextDecoder("utf-8", { fatal: true }).decode(
										await readBoundedCloudResponse(response, 64 * 1024, deadline),
									),
								);
								deadline.throwIfAborted();
								current();
								if (parseNativeAccountRefreshResult(value, authority.requestId) === "completed") {
									settle(authority.expiresAt);
									return;
								}
							} finally {
								if (!response.body?.locked) void response.body?.cancel().catch(() => undefined);
							}
							await pause(poll);
							poll = Math.min(Math.round(poll * 1.5), 4000);
						}
					},
					120_000,
					companySignal,
				).catch(() => {
					throw new Error("Account usage could not be refreshed. Try again shortly.");
				});
				pendingMetadataRefresh = work;
				void work
					.finally(() => {
						if (pendingMetadataRefresh === work) pendingMetadataRefresh = undefined;
					})
					.catch(() => undefined);
			}
			await withCloudDeadline(() => pendingMetadataRefresh!, 120_000, checked);
			checked.throwIfAborted();
			current();
		},
		selectSessionAccount: async (sessionId, signal) => {
			if (!UUID_PATTERN.test(sessionId)) throw new Error("Invalid conversation account request.");
			const value = await rpc(
				"qorpera_select_member_session_account",
				{
					p_profile_id: profileId,
					p_session_id: sessionId,
				},
				signal,
				sessionId,
			);
			if (value === null) return undefined;
			if (typeof value !== "string" || !UUID_PATTERN.test(value))
				throw new Error("Invalid conversation account response.");
			return value;
		},
		listSessionTurnProvenance: (sessionId, signal) => client(signal, sessionId).listSessionTurnProvenance(sessionId),
		requestSessionTurn: (input, signal) => client(signal, input.sessionId).requestSessionTurn(input),
		// Unattended use is the default (founder decision 2026-09-20), not a setting: binding an account
		// records its owner's consent first and binds the consented version, so routines, coworker wakes
		// and first runs can use the account while nobody is online. A ChatGPT plan is the exception
		// (founder decision 2026-10-01): it is bound for the member's own messages only, and works while
		// they are away once they turn that on themselves.
		createMemberSponsor: async ({ planLogin: plan, ...input }, signal) => {
			signal?.throwIfAborted();
			if (plan) return client(signal).createMemberSponsor({ ...input, allowAutonomous: false, profileId });
			const version = await consent(input.providerConnectionId, true);
			return client(signal).createMemberSponsor({
				...input,
				providerConnectionVersion: version,
				allowAutonomous: true,
				profileId,
			});
		},
		setWorkWhileAway: async (connectionId, on, signal) => {
			signal?.throwIfAborted();
			const version = await consent(connectionId, on);
			// Turned on, the consented version is bound for work while away; turned off, the newer
			// version stops that, and the member's messages are bound again on the next read.
			if (on)
				await client(signal).createMemberSponsor({
					providerConnectionId: connectionId,
					providerConnectionVersion: version,
					allowAutonomous: true,
					profileId,
				});
		},
		recordRoutineOffer: async (connectionId, signal) => {
			signal?.throwIfAborted();
			const value = (await cloud.rpc("qorpera_record_chatgpt_plan_routine_offer", {
				p_profile_id: profileId,
				p_connection_id: connectionId,
			})) as { connection_id?: unknown; shown_at?: unknown } | null;
			if (
				value?.connection_id !== connectionId ||
				typeof value.shown_at !== "string" ||
				!Number.isFinite(Date.parse(value.shown_at))
			)
				throw new Error("Invalid cloud response");
			return value.shown_at;
		},
		revokeConnection: (input, signal) => client(signal).revokeConnection({ ...input, profileId }),
	};
}
