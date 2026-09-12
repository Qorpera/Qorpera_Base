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
import { type Cloud, CloudRpcError } from "./client.ts";

export interface WebNativeSubscription {
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
		listConnections: (signal) => client(signal).listConnections(profileId),
		listSessionTurnProvenance: (sessionId, signal) => client(signal, sessionId).listSessionTurnProvenance(sessionId),
		requestSessionTurn: (input, signal) => client(signal, input.sessionId).requestSessionTurn(input),
		createMemberSponsor: (input, signal) => client(signal).createMemberSponsor({ ...input, profileId }),
		revokeConnection: (input, signal) => client(signal).revokeConnection({ ...input, profileId }),
	};
}
