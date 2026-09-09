import { CloudMemberBrowserRecovery } from "@qorpera/cloud-client/cloud-member-browser-recovery";
import { readBoundedCloudResponse, withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import type { Cloud } from "./client.ts";

/** Account cleanup remains reachable after company membership has ended. */
export function webBrowserRecovery(cloud: Cloud, memberId: string, signal: AbortSignal, current: () => void) {
	const origin = new URL(cloud.config.projectUrl);
	if (
		origin.protocol !== "https:" ||
		origin.username ||
		origin.password ||
		origin.pathname !== "/" ||
		origin.search ||
		origin.hash
	)
		throw new Error("Invalid browser access configuration.");
	const check = () => {
		signal.throwIfAborted();
		current();
	};
	const client = new CloudMemberBrowserRecovery({
		memberId,
		rpc: (method, args, caller) =>
			withCloudDeadline(
				async (deadline) => {
					check();
					const { data, error } = await cloud.supabase.auth.getSession();
					check();
					deadline.throwIfAborted();
					if (
						error ||
						data.session?.user.id !== memberId ||
						!data.session ||
						!/^[A-Za-z0-9._~-]{1,8192}$/.test(data.session.access_token)
					)
						throw new Error("Sign in again to manage your browser access.");
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
						cache: "no-store",
						credentials: "omit",
					});
					try {
						check();
						if (response.status !== 200) throw new Error("Browser access could not be confirmed.");
						const value = JSON.parse(
							new TextDecoder("utf-8", { fatal: true }).decode(
								await readBoundedCloudResponse(response, 1024 * 1024, deadline),
							),
						);
						check();
						deadline.throwIfAborted();
						return { data: value, error: null };
					} finally {
						if (!response.body?.locked) void response.body?.cancel().catch(() => undefined);
					}
				},
				10000,
				AbortSignal.any([signal, caller]),
			),
	});
	return { client, signal, current: check };
}
