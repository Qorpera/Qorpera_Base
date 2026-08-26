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
	/* Objects are content-addressed, so serving them from either store is
	 * equivalent — but the two stores drift: NAS-primary clients upload
	 * pending-revision objects the runner path never mirrors to storage, and
	 * runner uploads never reach the NAS. A primary-only verifier therefore
	 * fails every open or publication that follows a fresh divergence. Try
	 * the configured primary first and fall back to the other store per
	 * object; closure verification downstream still proves the content. */
	const gatewayLoader = createGatewayLoader(options);
	if (options.primary === "supabase") {
		return chainLoaders(options.storageDownload, gatewayLoader);
	}
	if (options.primary !== "nas") {
		throw new Error("Company File object storage primary is not configured");
	}
	if (!gatewayLoader) throw new Error("Company File NAS gateway is not configured");
	return chainLoaders(gatewayLoader, options.storageDownload);
}

type ObjectLoader = (profileId: string, sha256: string) => Promise<Uint8Array>;

function chainLoaders(primary: ObjectLoader, fallback: ObjectLoader | undefined): ObjectLoader {
	if (!fallback) return primary;
	return async (profileId, sha256) => {
		try {
			return await primary(profileId, sha256);
		} catch {
			return await fallback(profileId, sha256);
		}
	};
}

function createGatewayLoader(options: CompanyFileObjectLoaderOptions): ObjectLoader | undefined {
	const configuredGatewayUrl = options.gatewayUrl?.trim();
	if (!configuredGatewayUrl) return undefined;
	const gatewayUrl = new URL(configuredGatewayUrl).href.replace(/\/$/, "");
	const token = options.internalServiceRequest ? options.verifierToken?.trim() : options.memberToken;
	if (!token) return undefined;
	const request = options.fetch ?? fetch;
	return async (profileId, sha256) => {
		const response = await request(`${gatewayUrl}/v1/profile-objects/${profileId}/${sha256}`, {
			headers: {
				authorization: `Bearer ${token}`,
				/* The gateway sits behind Cloudflare, whose bot rules 1010-ban
				 * clients presenting non-browser user agents before the origin
				 * is reached (observed 2026-08-26; a browser UA passes to real
				 * authentication). This is server-to-server traffic carrying a
				 * bearer credential — the UA satisfies the edge, nothing else. */
				"user-agent":
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
			},
		});
		if (!response.ok) {
			throw new Error("Company File object is unavailable");
		}
		return new Uint8Array(await response.arrayBuffer());
	};
}
