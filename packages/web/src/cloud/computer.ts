import type { CompanyComputerScope } from "@qorpera/cloud-client/cloud-company-computer-contract";
import { CloudMemberCompanyComputerClient } from "@qorpera/cloud-client/cloud-member-company-computer";
import type { Cloud } from "./client.ts";
import type { HostedProfile } from "./types.ts";

/** Member-only transport. Every request rechecks the account and company
 * lifetime, including after an asynchronous token refresh. */
export class WebCompanyComputer {
	readonly client: CloudMemberCompanyComputerClient;
	readonly canRequestWake: boolean;
	readonly #cloud: Cloud;
	readonly #memberId: string;
	readonly #current: () => void;
	constructor(cloud: Cloud, profile: HostedProfile, memberId: string, signal: AbortSignal, current: () => void) {
		this.canRequestWake = ["owner", "admin", "contributor"].includes(profile.role);
		this.#cloud = cloud;
		this.#memberId = memberId;
		this.#current = () => {
			signal.throwIfAborted();
			current();
		};
		this.client = new CloudMemberCompanyComputerClient({
			companyId: profile.profileId,
			environmentId: profile.environmentId,
			supabaseUrl: cloud.config.projectUrl,
			publishableKey: cloud.config.publishableKey,
			accessToken: async (requestSignal) => {
				this.#current();
				requestSignal.throwIfAborted();
				const { data, error } = await cloud.supabase.auth.getSession();
				this.#current();
				requestSignal.throwIfAborted();
				if (error || !data.session || data.session.user.id !== memberId)
					throw new Error("Sign in again to open this computer.");
				return data.session.access_token;
			},
			fetch: async (input, init) => {
				this.#current();
				const response = await globalThis.fetch(input, {
					...init,
					signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
				});
				try {
					this.#current();
				} catch (error) {
					void response.body?.cancel().catch(() => undefined);
					throw error;
				}
				return response;
			},
		});
	}
	views(scope: CompanyComputerScope) {
		this.#current();
		const origin = this.#cloud.config.officeViewerOrigin;
		if (!origin) throw new Error("Screen viewing is not configured.");
		return this.client.views(scope, this.#memberId, `${origin}/office/${scope.companyComputerId}/view`);
	}
}
