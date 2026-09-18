import { CloudMemberCompanyFileClient as SharedMemberFileClient } from "@qorpera/cloud-client/cloud-member-company-editor";
import { GATEWAY_EDGE_USER_AGENT } from "@qorpera/cloud-client/node/cloud-object-store";
import { CloudMemberIdentityRecoveryClient } from "./cloud-member-identity-recovery.ts";

export * from "@qorpera/cloud-client/cloud-member-company-editor";

/** Desktop supplies edge transport and its separate recovery window client.
 * Cloud file authority and typed file operations are shared with the browser. */
export class CloudMemberCompanyFileClient extends SharedMemberFileClient {
	#identityRecovery: CloudMemberIdentityRecoveryClient | undefined;
	readonly #options: ConstructorParameters<typeof SharedMemberFileClient>[0];
	constructor(options: ConstructorParameters<typeof SharedMemberFileClient>[0]) {
		const request = options.fetch ?? fetch;
		super({
			...options,
			fetch: (input, init) => {
				const headers = new Headers(init?.headers);
				const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
				if (
					url.pathname.startsWith("/v1/member-company-file/") ||
					url.pathname.startsWith("/v1/member-file-exports/") ||
					headers.has("x-qorpera-company-path")
				)
					headers.set("user-agent", GATEWAY_EDGE_USER_AGENT);
				return request(input, { ...init, headers });
			},
		});
		this.#options = { ...options };
	}
	get identityRecovery(): CloudMemberIdentityRecoveryClient {
		this.#identityRecovery ??= new CloudMemberIdentityRecoveryClient(this.#options);
		return this.#identityRecovery;
	}
}
