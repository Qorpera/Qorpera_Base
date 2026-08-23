export interface CompanyFileObjectLoaderOptions {
	primary?: "nas" | "supabase";
	gatewayUrl?: string;
	internalServiceRequest: boolean;
	memberToken: string;
	verifierToken?: string;
	storageDownload: (profileId: string, sha256: string) => Promise<Uint8Array>;
	fetch?: typeof fetch;
}

export function createCompanyFileObjectLoader(
	options: CompanyFileObjectLoaderOptions,
): (profileId: string, sha256: string) => Promise<Uint8Array> {
	if (options.primary === "supabase") return options.storageDownload;
	if (options.primary !== "nas") {
		throw new Error("Company File object storage primary is not configured");
	}
	const configuredGatewayUrl = options.gatewayUrl?.trim();
	if (!configuredGatewayUrl) throw new Error("Company File NAS gateway is not configured");
	const gatewayUrl = new URL(configuredGatewayUrl).href.replace(/\/$/, "");
	const token = options.internalServiceRequest ? options.verifierToken?.trim() : options.memberToken;
	if (!token) throw new Error("Company File verification gateway is not configured");
	const request = options.fetch ?? fetch;
	return async (profileId, sha256) => {
		const response = await request(`${gatewayUrl}/v1/profile-objects/${profileId}/${sha256}`, {
			headers: { authorization: `Bearer ${token}` },
		});
		if (!response.ok) throw new Error("Company File object is unavailable");
		return new Uint8Array(await response.arrayBuffer());
	};
}
