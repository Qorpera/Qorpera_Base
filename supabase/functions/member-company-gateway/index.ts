import { createHash } from "node:crypto";
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
// WHY: Exceeds data-gateway watchMs (20 s) so live /watch reconnect cycles reuse cached GoTrue verification instead of double-missing every 20 s.
const AUTH_CACHE_TTL_MS = 30_000;
const AUTH_CACHE_MAX = 2_048;
const verifiedMemberTokens = new Map<string, number>();
const inFlightMemberChecks = new Map<string, Promise<boolean>>();

function tokenExpiryMs(authorization: string): number | undefined {
	const raw = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
	const parts = raw.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (parts[1].length % 4)) % 4);
		const payload = JSON.parse(atob(padded)) as { exp?: unknown };
		return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1000 : undefined;
	} catch {
		return undefined;
	}
}

function rememberVerifiedMember(key: string, until: number): void {
	if (verifiedMemberTokens.size >= AUTH_CACHE_MAX) {
		const oldest = verifiedMemberTokens.keys().next().value;
		if (oldest !== undefined) verifiedMemberTokens.delete(oldest);
	}
	verifiedMemberTokens.set(key, until);
}

/** The auth service's own check of the member's token (GoTrue `/auth/v1/user`): yes, no (401/403), or a throw. */
async function memberSignedIn(authorization: string, signal: AbortSignal): Promise<boolean> {
	const base = Deno.env.get("SUPABASE_URL");
	const key = Deno.env.get("SUPABASE_ANON_KEY");
	if (!base || !key) throw new Error("Auth is not configured");
	if (base !== cachedAuthBase || !cachedAuthUserUrl) {
		cachedAuthUserUrl = new URL("/auth/v1/user", base);
		cachedAuthBase = base;
	}
	const tokenHash = createHash("sha256").update(`${base}\0${authorization}`, "utf8").digest("hex");
	const now = Date.now();
	const cachedUntil = verifiedMemberTokens.get(tokenHash);
	if (cachedUntil !== undefined) {
		if (cachedUntil > now) return true;
		verifiedMemberTokens.delete(tokenHash);
	}
	let pending = inFlightMemberChecks.get(tokenHash);
	if (!pending) {
		const authUrl = cachedAuthUserUrl;
		pending = withTimeoutScope(5_000, async (scopedSignal) => {
			const response = await fetch(authUrl, {
				headers: { apikey: key, authorization },
				redirect: "error",
				signal: scopedSignal,
			});
			void response.body?.cancel().catch(() => undefined);
			if (response.ok) {
				const expMs = tokenExpiryMs(authorization);
				const until = expMs !== undefined ? Math.min(Date.now() + AUTH_CACHE_TTL_MS, expMs) : Date.now() + AUTH_CACHE_TTL_MS;
				if (until > Date.now()) rememberVerifiedMember(tokenHash, until);
				return true;
			}
			if (response.status === 401 || response.status === 403) return false;
			throw new Error(`Auth answered ${response.status}`);
		}).finally(() => {
			if (inFlightMemberChecks.get(tokenHash) === pending) inFlightMemberChecks.delete(tokenHash);
		});
		inFlightMemberChecks.set(tokenHash, pending);
	}
	return new Promise<boolean>((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		pending.then(
			(ok) => {
				signal.removeEventListener("abort", onAbort);
				resolve(ok);
			},
			(err: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(err);
			},
		);
	});
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
