import { withTimeoutScope } from "../_shared/abort-timeout.ts";
import { forwardNativeProviderLogin } from "./native-provider-login.ts";

const RPC_TIMEOUT_MS = 5_000;

/** Asks the backend for the login gateway: the identity's home node when eligible, else the least loaded (qorpera_runtime_login_gateway_choose). */
async function chooseLoginGateway(capabilitySha256: string, purpose?: "account_refresh"): Promise<string | undefined> {
	const base = Deno.env.get("SUPABASE_URL");
	const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
	if (!base || !key) return undefined;
	return withTimeoutScope(RPC_TIMEOUT_MS, async (signal) => {
		const response = await fetch(new URL(`/rest/v1/rpc/qorpera_runtime_${purpose ?? "login"}_gateway_choose`, base), {
			method: "POST",
			headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({ p_capability_sha256: capabilitySha256 }),
			redirect: "error",
			signal,
		});
		if (!response.ok) {
			void response.body?.cancel().catch(() => undefined);
			return undefined;
		}
		const chosen = (await response.json()) as { url?: unknown };
		return typeof chosen?.url === "string" ? chosen.url : undefined;
	});
}

let cachedOriginsRaw: string | undefined;
let cachedOrigins: readonly string[] | undefined;

/** Exact web origins this deployment serves, as a JSON array; absent means the production app only. */
function allowedOrigins(): readonly string[] | undefined {
	const value = Deno.env.get("QORPERA_WEB_ORIGINS");
	if (!value) return undefined;
	if (value === cachedOriginsRaw) return cachedOrigins;
	const parsed: unknown = JSON.parse(value);
	if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 8 || parsed.some((item) => typeof item !== "string"))
		throw new Error("QORPERA_WEB_ORIGINS must be a JSON array of one to eight origins");
	cachedOriginsRaw = value;
	cachedOrigins = parsed as string[];
	return cachedOrigins;
}

Deno.serve((request) =>
	forwardNativeProviderLogin(request, {
		allowedOrigins: allowedOrigins(),
		upstreamUrl: Deno.env.get("QORPERA_NATIVE_PROVIDER_UPSTREAM_URL"),
		upstreamResolver: chooseLoginGateway,
	}),
);
