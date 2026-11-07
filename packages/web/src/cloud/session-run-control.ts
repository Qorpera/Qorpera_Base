import { readBoundedCloudResponse, withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import {
	CloudSessionRunControl,
	type CloudSessionRunState,
	type CloudSessionRunTerminalStatus,
} from "@qorpera/cloud-client/cloud-session-run-control";
import type { Cloud } from "./client.ts";

export interface WebSessionRunControl {
	read(sessionId: string, staffAgentId: string, signal?: AbortSignal): Promise<CloudSessionRunState>;
	cancel(sessionId: string, runId: string, signal?: AbortSignal): Promise<CloudSessionRunTerminalStatus>;
}

/** Account-bound transport for the runtime's exact-run controls. The shared
 * client owns response validation and cancellation recovery semantics. */
export function createWebSessionRunControl(
	cloud: Cloud,
	memberId: string,
	companySignal: AbortSignal,
	current: (sessionId: string) => void,
): WebSessionRunControl {
	const origin = new URL(cloud.config.projectUrl);
	if (
		origin.protocol !== "https:" ||
		origin.username ||
		origin.password ||
		origin.pathname !== "/" ||
		origin.search ||
		origin.hash
	)
		throw new Error("Invalid cloud run control configuration.");
	const client = (sessionId: string, signal?: AbortSignal) =>
		new CloudSessionRunControl((method, args, caller) =>
			withCloudDeadline(
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
						throw new Error("Sign in again to control this cloud run.");
					// No `cache` option: see cloud/native-subscription.ts (the CORS preflight).
					const response = await fetch(`${origin.origin}/rest/v1/rpc/${method}`, {
						method: "POST",
						headers: {
							authorization: `Bearer ${data.session.access_token}`,
							apikey: cloud.config.publishableKey,
							"content-type": "application/json",
						},
						body: JSON.stringify(args),
						signal: deadline,
						redirect: "error",
						credentials: "omit",
					});
					cloud.noticeResponse?.(`${origin.origin}/rest/v1/rpc/${method}`, data.session.access_token, response);
					try {
						check();
						if (response.status === 401 || response.status === 403)
							return { data: null, error: { code: "42501" } };
						if (response.status !== 200) throw new Error("Cloud run control could not be confirmed.");
						const value: unknown = JSON.parse(
							new TextDecoder("utf-8", { fatal: true }).decode(
								await readBoundedCloudResponse(response, 16384, deadline),
							),
						);
						check();
						return { data: value, error: null };
					} finally {
						if (!response.body?.locked) void response.body?.cancel().catch(() => undefined);
					}
				},
				10000,
				AbortSignal.any([companySignal, caller, ...(signal ? [signal] : [])]),
			),
		);
	return {
		read: (sessionId: string, staffAgentId: string, signal?: AbortSignal) =>
			client(sessionId, signal).read(sessionId, staffAgentId),
		cancel: (sessionId: string, runId: string, signal?: AbortSignal) =>
			client(sessionId, signal).cancel(sessionId, runId),
	};
}
