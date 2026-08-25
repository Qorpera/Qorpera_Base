export interface RunnerBrokerObjectLoaderOptions {
	primary?: "nas" | "supabase";
	gatewayUrl?: string;
	verifierToken?: string;
	storageDownload: (profileId: string, sha256: string) => Promise<Uint8Array>;
	fetch?: typeof fetch;
}

export function createRunnerBrokerObjectLoader(
	options: RunnerBrokerObjectLoaderOptions,
): (profileId: string, sha256: string) => Promise<Uint8Array> {
	if (options.primary === "supabase") return options.storageDownload;
	if (options.primary !== "nas") throw new Error("Runner broker object storage primary is not configured");
	const configuredGatewayUrl = options.gatewayUrl?.trim();
	const verifierToken = options.verifierToken?.trim();
	if (!configuredGatewayUrl || !verifierToken) throw new Error("Runner broker NAS gateway is not configured");
	const gatewayUrl = new URL(configuredGatewayUrl).href.replace(/\/$/, "");
	const request = options.fetch ?? fetch;
	return async (profileId, sha256) => {
		const response = await request(`${gatewayUrl}/v1/profile-objects/${profileId}/${sha256}`, {
			headers: { authorization: `Bearer ${verifierToken}` },
		});
		if (!response.ok) throw new Error("Runner broker object is unavailable");
		return new Uint8Array(await response.arrayBuffer());
	};
}
