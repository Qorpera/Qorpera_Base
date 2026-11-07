import { CloudMemberFolderClient, CloudMemberFolderHints } from "@qorpera/cloud-client/cloud-member-folder";
import { withCloudDeadline } from "@qorpera/cloud-client/cloud-request";
import { createClient } from "@supabase/supabase-js";
import type { Cloud } from "./client.ts";
import { memberRouteTarget } from "./deployment-config.ts";
import { createWebMessageErases, type WebMessageErases } from "./message-erases.ts";
import type { HostedProfile, HostedProfileRole } from "./types.ts";

/** A member's endpoints, token and transport for one company. */
interface MemberFolderOptions {
	readonly environmentId: string;
	readonly supabaseUrl: string;
	readonly publishableKey: string;
	readonly objectGatewayUrl: string;
	readonly accessToken: (signal: AbortSignal) => Promise<string>;
	readonly fetch: typeof fetch;
}

/** The product owns member lifetime; the shared SDK owns the company folder's calls. Every company is folder-v2
 * (founder decision, 3 October 2026): members read its folder (C4 P27) and write it through the member commit route
 * (P34a). */
export class WebCompanyFiles {
	readonly company: { readonly role: HostedProfileRole; readonly canWrite: boolean };
	readonly signal: AbortSignal;
	readonly #options: MemberFolderOptions;
	readonly #current: () => void;
	constructor(
		cloud: Cloud,
		profile: HostedProfile,
		memberId: string,
		role: HostedProfileRole,
		signal: AbortSignal,
		current: () => void,
		canWrite = role !== "viewer",
	) {
		this.company = Object.freeze({ role, canWrite });
		this.signal = signal;
		this.#current = current;
		this.#options = {
			environmentId: profile.environmentId,
			supabaseUrl: cloud.config.projectUrl,
			publishableKey: cloud.config.publishableKey,
			objectGatewayUrl: cloud.config.objectGatewayUrl,
			accessToken: async (requestSignal) => {
				this.current();
				requestSignal.throwIfAborted();
				const { data, error } = await cloud.supabase.auth.getSession();
				this.current();
				requestSignal.throwIfAborted();
				if (
					error ||
					!data.session ||
					data.session.user.id !== memberId ||
					!/^[A-Za-z0-9._~-]{1,8192}$/.test(data.session.access_token)
				)
					throw new Error("Sign in again to open Company File.");
				return data.session.access_token;
			},
			fetch: async (input, init) => {
				this.current();
				// Enable the public bridge only after its deployment has been accepted.
				// This is a configured transport selection, never a fallback after a write.
				const target = memberRouteTarget(cloud.config, input instanceof Request ? input.url : String(input));
				const response = await fetch(input instanceof Request ? new Request(target, input) : target, {
					...init,
					credentials: "omit",
					signal: AbortSignal.any([
						signal,
						...(input instanceof Request ? [input.signal] : []),
						...(init?.signal ? [init.signal] : []),
					]),
				});
				try {
					this.current();
				} catch (error) {
					void response.body?.cancel().catch(() => undefined);
					throw error;
				}
				return response;
			},
		};
	}
	current(): void {
		this.signal.throwIfAborted();
		this.#current();
	}
	/** The company's folder: reads (C4 P27) and the member's change sets (P34a). */
	folder(): CloudMemberFolderClient {
		this.current();
		return new CloudMemberFolderClient({
			environmentId: this.#options.environmentId,
			supabaseUrl: this.#options.supabaseUrl,
			objectGatewayUrl: this.#options.objectGatewayUrl,
			publishableKey: this.#options.publishableKey,
			accessToken: this.#options.accessToken,
			fetch: this.#options.fetch,
		});
	}
	/** The member's erases of single messages (summary trees M3c), through the same member route transport. */
	messageErases(): WebMessageErases {
		this.current();
		return createWebMessageErases(this.#options);
	}
	/** The folder's hint (folder core C4, P30): `onHint(seq)` when it changed. Closes with this company's signal.
	 * Its private channel joins once Realtime holds the member's token. The client sets that only after its first
	 * answer, so a channel joined at once went out with the publishable key, was refused ("Unauthorized") and joined
	 * only on the 10 s retry (3 Nov 2026). `onState`: whether its channel is subscribed, each time that changes. */
	folderHints(onHint: (seq: number) => void, onState?: (connected: boolean) => void): { close(): Promise<void> } {
		this.current();
		const client = this.#realtime();
		let hints: CloudMemberFolderHints | undefined;
		let closed = false;
		const joined = withCloudDeadline(() => client.realtime.setAuth(), 5000, this.signal)
			// Without a token the join is refused as before, and the hints' own retry joins again.
			.catch(() => undefined)
			.then(() => {
				if (closed || this.signal.aborted) return;
				hints = new CloudMemberFolderHints({
					environmentId: this.#options.environmentId,
					client,
					signal: this.signal,
					onHint,
					...(onState ? { onState } : {}),
				});
			});
		return {
			close: async () => {
				closed = true;
				await joined;
				await hints?.close();
			},
		};
	}
	#realtime() {
		return createClient(this.#options.supabaseUrl, this.#options.publishableKey, {
			auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
			accessToken: () => withCloudDeadline((signal) => this.#options.accessToken(signal), 2000, this.signal),
		});
	}
}
