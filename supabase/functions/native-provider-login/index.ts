import { forwardNativeProviderLogin } from "./native-provider-login.ts";

const RPC_TIMEOUT_MS = 5_000;

/** Asks the backend for the login gateway: the identity's home node when eligible, else the least loaded (qorpera_runtime_login_gateway_choose). */
async function chooseLoginGateway(capabilitySha256: string): Promise<string | undefined> {
	const base = Deno.env.get("SUPABASE_URL");
	const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
	if (!base || !key) return undefined;
	const response = await fetch(new URL("/rest/v1/rpc/qorpera_runtime_login_gateway_choose", base), {
		method: "POST",
		headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
		body: JSON.stringify({ p_capability_sha256: capabilitySha256 }),
		redirect: "error",
		signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
	});
	if (!response.ok) {
		await response.body?.cancel();
		return undefined;
	}
	const chosen = (await response.json()) as { url?: unknown };
	return typeof chosen?.url === "string" ? chosen.url : undefined;
}

/** Exact web origins this deployment serves, as a JSON array; absent means the production app only. */
function allowedOrigins(): readonly string[] | undefined {
	const value = Deno.env.get("QORPERA_WEB_ORIGINS");
	if (!value) return undefined;
	const parsed: unknown = JSON.parse(value);
	if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 8 || parsed.some((item) => typeof item !== "string"))
		throw new Error("QORPERA_WEB_ORIGINS must be a JSON array of one to eight origins");
	return parsed as string[];
}

Deno.serve((request) =>
	forwardNativeProviderLogin(request, {
		allowedOrigins: allowedOrigins(),
		upstreamUrl: Deno.env.get("QORPERA_NATIVE_PROVIDER_UPSTREAM_URL"),
		upstreamResolver: chooseLoginGateway,
	}),
);
