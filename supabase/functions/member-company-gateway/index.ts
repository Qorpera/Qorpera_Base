import { forwardMemberCompanyGateway } from "./member-company-gateway.ts";

function allowedOrigins(): readonly string[] | undefined {
	const raw = Deno.env.get("QORPERA_WEB_ORIGINS");
	if (!raw) return undefined;
	const value: unknown = JSON.parse(raw);
	if (!Array.isArray(value) || value.length < 1 || value.length > 8 || value.some((item) => typeof item !== "string"))
		throw new Error("QORPERA_WEB_ORIGINS must contain one to eight origins");
	return value as string[];
}

/** The auth service's own check of the member's token (GoTrue `/auth/v1/user`): yes, no (401/403), or a throw. */
async function memberSignedIn(authorization: string, signal: AbortSignal): Promise<boolean> {
	const base = Deno.env.get("SUPABASE_URL");
	const key = Deno.env.get("SUPABASE_ANON_KEY");
	if (!base || !key) throw new Error("Auth is not configured");
	const response = await fetch(new URL("/auth/v1/user", base), {
		headers: { apikey: key, authorization },
		redirect: "error",
		signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
	});
	await response.body?.cancel();
	if (response.ok) return true;
	if (response.status === 401 || response.status === 403) return false;
	throw new Error(`Auth answered ${response.status}`);
}

Deno.serve((request) =>
	forwardMemberCompanyGateway(request, {
		upstreamUrl: Deno.env.get("QORPERA_MEMBER_GATEWAY_UPSTREAM_URL"),
		allowedOrigins: allowedOrigins(),
		memberSignedIn,
	}),
);
