import { withTimeoutScope } from "../_shared/abort-timeout.ts";
import { forwardMemberCompanyGateway } from "./member-company-gateway.ts";

let cachedOriginsRaw: string | undefined;
let cachedOrigins: readonly string[] | undefined;

function allowedOrigins(): readonly string[] | undefined {
	const raw = Deno.env.get("QORPERA_WEB_ORIGINS");
	if (!raw) return undefined;
	if (raw === cachedOriginsRaw) return cachedOrigins;
	const value: unknown = JSON.parse(raw);
	if (!Array.isArray(value) || value.length < 1 || value.length > 8 || value.some((item) => typeof item !== "string"))
		throw new Error("QORPERA_WEB_ORIGINS must contain one to eight origins");
	cachedOriginsRaw = raw;
	cachedOrigins = value as string[];
	return cachedOrigins;
}

let cachedAuthBase: string | undefined;
let cachedAuthUserUrl: URL | undefined;

/** The auth service's own check of the member's token (GoTrue `/auth/v1/user`): yes, no (401/403), or a throw. */
async function memberSignedIn(authorization: string, signal: AbortSignal): Promise<boolean> {
	const base = Deno.env.get("SUPABASE_URL");
	const key = Deno.env.get("SUPABASE_ANON_KEY");
	if (!base || !key) throw new Error("Auth is not configured");
	if (base !== cachedAuthBase || !cachedAuthUserUrl) {
		cachedAuthUserUrl = new URL("/auth/v1/user", base);
		cachedAuthBase = base;
	}
	const authUrl = cachedAuthUserUrl;
	return withTimeoutScope(
		5_000,
		async (scopedSignal) => {
			const response = await fetch(authUrl, {
				headers: { apikey: key, authorization },
				redirect: "error",
				signal: scopedSignal,
			});
			void response.body?.cancel().catch(() => undefined);
			if (response.ok) return true;
			if (response.status === 401 || response.status === 403) return false;
			throw new Error(`Auth answered ${response.status}`);
		},
		signal,
	);
}

/**
 * The auth service's own issuer, when this deployment names it: `QORPERA_MEMBER_TOKEN_ISSUER`, set to exactly the
 * string the auth service puts in a token's `iss`, copied unchanged from the stack's own environment — on the pinned
 * self-hosted configuration that is `API_EXTERNAL_URL` **as it stands, with nothing appended** (review r2 F2 of #1746).
 * Nothing here derives it, and this repo states no value: the operator copies what the auth service has. It is never
 * `SUPABASE_URL`, the address the functions reach the stack at on the compose network, which no token carries: taking
 * that for the issuer would refuse every real member token (review r1 F2). Unset, the pointer route still serves and
 * only the issuer goes unchecked.
 */
let cachedIssuerRaw: string | undefined;
let cachedIssuer: string | undefined;

function memberTokenIssuer(): string | undefined {
	const issuer = Deno.env.get("QORPERA_MEMBER_TOKEN_ISSUER");
	if (!issuer) return undefined;
	if (issuer === cachedIssuerRaw) return cachedIssuer;
	// Whatever the auth service states, with or without a path (`https://host` and `https://host/auth/v1` are both
	// real issuers on different configurations): an exact https URL, nothing guessed and no path demanded.
	const url = new URL(issuer);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		issuer.replace(/\/$/, "") !== `${url.origin}${url.pathname}`.replace(/\/$/, "")
	)
		throw new Error("QORPERA_MEMBER_TOKEN_ISSUER must be the exact https issuer the auth service states");
	cachedIssuerRaw = issuer;
	cachedIssuer = issuer;
	return cachedIssuer;
}

Deno.serve((request) =>
	forwardMemberCompanyGateway(request, {
		upstreamUrl: Deno.env.get("QORPERA_MEMBER_GATEWAY_UPSTREAM_URL"),
		allowedOrigins: allowedOrigins(),
		memberSignedIn,
		memberTokenIssuer: memberTokenIssuer(),
	}),
);
