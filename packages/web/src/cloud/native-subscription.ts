import {
	type CreateMemberSponsorInput,
	type NativeExecutionConnections,
	NativeSubscriptionControlPlane,
	type RequestSponsoredSessionTurnInput,
	type RevokeNativeProviderConnectionInput,
	type SessionTurnProvenance,
	type SessionTurnRequestResult,
} from "@qorpera/cloud-client/cloud-native-subscription-control";
import { readBoundedCloudResponse, withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import { HttpNativeProviderIdentityBridge } from "@qorpera/cloud-client/native-provider-login";
import { type Cloud, CloudRpcError } from "./client.ts";
import { parseCloudConfig } from "./deployment-config.ts";

export interface WebNativeProviderLoginInput {
	provider: "openai" | "anthropic";
	displayName: string;
	clientIdentityId: string;
	clientLoginId: string;
	clientConnectionId: string;
}

export interface WebNativeProviderLogin {
	loginId: string;
	connectionId: string;
	status: "awaiting_member" | "completed" | "preparing";
	interactionUrl?: string;
	userCode?: string;
	expiresAt: string;
}

export interface WebNativeSubscription {
	readonly onboardingAvailable: boolean;
	beginProviderLogin(input: WebNativeProviderLoginInput, signal?: AbortSignal): Promise<WebNativeProviderLogin>;
	listConnections(signal?: AbortSignal): Promise<NativeExecutionConnections>;
	listSessionTurnProvenance(sessionId: string, signal?: AbortSignal): Promise<readonly SessionTurnProvenance[]>;
	requestSessionTurn(input: RequestSponsoredSessionTurnInput, signal?: AbortSignal): Promise<SessionTurnRequestResult>;
	createMemberSponsor(
		input: Omit<CreateMemberSponsorInput, "profileId">,
		signal?: AbortSignal,
	): Promise<{ bindingId: string; version: number }>;
	revokeConnection(
		input: Omit<RevokeNativeProviderConnectionInput, "profileId">,
		signal?: AbortSignal,
	): Promise<{ connectionId: string; status: "revoked" }>;
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
	const client = (signal?: AbortSignal, sessionId?: string) =>
		new NativeSubscriptionControlPlane({
			rpc: (method, args) => {
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
							if (response.status !== 200) throw new Error("Cloud execution response was unavailable.");
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
					if (error instanceof CloudRpcError && error.denied) throw error;
					throw new Error("Cloud execution could not be confirmed. Refresh its status before trying again.");
				});
			},
		});
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
							const timer = setTimeout(resolve, 5000);
							deadline.addEventListener(
								"abort",
								() => {
									clearTimeout(timer);
									reject(new Error("Provider login preparation was interrupted."));
								},
								{ once: true },
							);
						});
						check();
						prompt = await bridge.beginLogin(authorization);
						check();
					}
					return { ...prompt, connectionId: request.clientConnectionId, expiresAt: authorization.expiresAt };
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
		listConnections: (signal) => client(signal).listConnections(profileId),
		listSessionTurnProvenance: (sessionId, signal) => client(signal, sessionId).listSessionTurnProvenance(sessionId),
		requestSessionTurn: (input, signal) => client(signal, input.sessionId).requestSessionTurn(input),
		createMemberSponsor: (input, signal) => client(signal).createMemberSponsor({ ...input, profileId }),
		revokeConnection: (input, signal) => client(signal).revokeConnection({ ...input, profileId }),
	};
}
