import { CloudMemberCompanyFileReader as SharedMemberFileReader } from "@qorpera/cloud-client/cloud-member-company-file";
import { GATEWAY_EDGE_USER_AGENT } from "@qorpera/cloud-client/node/cloud-object-store";

export type { CloudMemberCompanyFileRead } from "@qorpera/cloud-client/cloud-member-company-file";

/** Desktop transport adds the existing object-edge user agent. Authorization,
 * path/version selection and byte verification are shared with the web client. */
export class CloudMemberCompanyFileReader extends SharedMemberFileReader {
	constructor(options: ConstructorParameters<typeof SharedMemberFileReader>[0]) {
		const request = options.fetch ?? fetch;
		super({
			...options,
			fetch: (input, init) => {
				const headers = new Headers(init?.headers);
				if (headers.has("x-qorpera-company-path")) headers.set("user-agent", GATEWAY_EDGE_USER_AGENT);
				return request(input, { ...init, headers });
			},
		});
	}
}
