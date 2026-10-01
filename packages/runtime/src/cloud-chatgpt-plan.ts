import { createHash, createPublicKey, type JsonWebKey, type KeyObject, verify as verifySignature } from "node:crypto";
import { isUuid, parseRecord } from "@qorpera/contracts";
import { connectorRequest, jsonRecord, jsonString, parseJsonResponse } from "./cloud-connector-http.ts";

/**
 * Sign in with ChatGPT (founder decision 2026-10-01, built switched off): a member's ChatGPT Plus or
 * Pro plan pays for the work that member starts. OpenAI's OAuth gives a one-hour access token and a
 * rotating 30-day refresh token; the vault keeps both, renews one at a time (a second renewer would
 * spend the rotating token), and hands a run only the access token.
 *
 * This module is OpenAI's side: the client registration the operator configures (a private credential,
 * never in code), the endpoints from OpenAI's discovery document, the authorization address, the code
 * exchange with the ID token checked against OpenAI's keys, renewal, revocation, and the login record
 * the vault seals. Every request is pinned to https://auth.openai.com, follows no redirect, and is
 * bounded in time and size.
 */

export const CHATGPT_PLAN_ISSUER = "https://auth.openai.com";
export const CHATGPT_PLAN_RESOURCE = "https://api.openai.com/v1";
/** The scope that lets an app use the member's plan; an ID token alone does not. */
export const CHATGPT_PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPES = ["openid", "profile", "email", "offline_access", "resource.invoke", CHATGPT_PLAN_SCOPE];
/** The one envelope field that holds a plan login. */
export const CHATGPT_PLAN_LOGIN_FIELD = "chatgpt_plan_login";
const CLIENT_SCHEMA = "qorpera.chatgpt-plan-client/v1";
const LOGIN_SCHEMA = "qorpera.chatgpt-plan-login/v1";
const DISCOVERY_PATH = "/.well-known/openid-configuration";
const DISCOVERY_TTL_MS = 60 * 60_000;
/** An unknown key id refetches OpenAI's keys at most this often. */
const KEYS_REFETCH_MS = 60_000;
const REQUEST_DEADLINE_MS = 15_000;
const MAX_TOKEN = 16 * 1024;
const JWT = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]*)$/;
/** Refresh errors that mean the refresh token no longer works: the member must sign in again. */
const REFUSED_REFRESH = new Set([
	"invalid_grant",
	"invalid_refresh_token",
	"token_expired",
	"refresh_token_expired",
	"refresh_token_invalidated",
	"refresh_token_reused",
]);

/** Qorpera's registration with OpenAI, from the operator's private credential. */
export interface ChatGptPlanClient {
	readonly clientId: string;
	/** A confidential client's secret, sent only in the token request's Basic header; null for a public client. */
	readonly clientSecret: string | null;
	/** Where OpenAI sends the member back: the callback Edge Function, exactly as registered. */
	readonly redirectUri: string;
}

/** A member's plan login as the vault seals it. Never leaves the vault whole: a run gets the access token. */
export interface ChatGptPlanLogin {
	readonly clientId: string;
	/** OpenAI's verified subject: the account this login belongs to. */
	readonly subject: string;
	readonly email: string | null;
	readonly hostId: string;
	/** Kept for OpenAI's `id_token_hint` on a later sign-in. */
	readonly idToken: string | null;
	readonly accessToken: string;
	readonly refreshToken: string;
	readonly scopes: readonly string[];
	readonly accessIssuedAt: string;
	readonly accessExpiresAt: string;
	/** OpenAI's earliest time for the next renewal, when it named one. */
	readonly renewNotBefore: string | null;
}

/** A renewal's outcome. `refused` means the refresh token no longer works (the member signs in again). */
export type ChatGptPlanRenewal =
	| { readonly outcome: "renewed"; readonly login: ChatGptPlanLogin }
	| { readonly outcome: "refused" | "transient"; readonly reason: string };

interface Endpoints {
	readonly authorization: URL;
	readonly token: URL;
	readonly revocation: URL;
	readonly keys: URL;
}

/** A login's stable host id as the database makes it: `urn:uuid:` and a UUID. */
export function isChatGptPlanHostId(value: unknown): value is string {
	return typeof value === "string" && value.startsWith("urn:uuid:") && isUuid(value.slice("urn:uuid:".length));
}

function exactKeys(input: Record<string, unknown>, keys: readonly string[], label: string): void {
	if (Object.keys(input).sort().join() !== [...keys].sort().join()) throw new Error(`${label} is invalid`);
}

function token(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length < 1 || value.length > MAX_TOKEN || !/^[\x21-\x7e]+$/.test(value))
		throw new Error(`${label} is invalid`);
	return value;
}

function isoTime(value: unknown, label: string): string {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid`);
	return new Date(Date.parse(value)).toISOString();
}

function httpsAddress(value: unknown, label: string): URL {
	if (typeof value !== "string" || value.length > 2048) throw new Error(`${label} is invalid`);
	const url = new URL(value);
	if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error(`${label} is invalid`);
	return url;
}

/** OpenAI's own endpoint: on the issuer's origin. */
function issuerEndpoint(value: unknown, label: string): URL {
	const url = httpsAddress(value, label);
	if (url.origin !== CHATGPT_PLAN_ISSUER || url.search) throw new Error(`${label} is invalid`);
	return url;
}

/** Reads the operator's credential `qorpera-cloud-secret-chatgpt-plan`. */
export function parseChatGptPlanClient(text: string): ChatGptPlanClient {
	const input = parseRecord(JSON.parse(text), "ChatGPT plan client");
	exactKeys(input, ["schema", "clientId", "clientSecret", "redirectUri"], "ChatGPT plan client");
	if (
		input.schema !== CLIENT_SCHEMA ||
		typeof input.clientId !== "string" ||
		!/^[\x21-\x7e]{8,256}$/.test(input.clientId) ||
		(input.clientSecret !== null &&
			(typeof input.clientSecret !== "string" || !/^[\x21-\x7e]{16,512}$/.test(input.clientSecret)))
	)
		throw new Error("ChatGPT plan client is invalid");
	return Object.freeze({
		clientId: input.clientId,
		clientSecret: input.clientSecret,
		redirectUri: httpsAddress(input.redirectUri, "ChatGPT plan callback address").href,
	});
}

function jwtPart(part: string, label: string): Record<string, unknown> {
	return parseRecord(JSON.parse(Buffer.from(part, "base64url").toString("utf8")), label);
}

/** The claims of an access token, read without a signature check: it came from OpenAI's token
 * endpoint over TLS, and the vault reads only its times and owner. */
function accessClaims(accessToken: string): Record<string, unknown> {
	const matched = JWT.exec(accessToken);
	if (!matched) throw new Error("ChatGPT plan access token is invalid");
	return jwtPart(matched[2] as string, "ChatGPT plan access token");
}

function seconds(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** OpenAI's earliest time for the next renewal, as Unix seconds, milliseconds or a time. A value outside
 * the pass it came with (from 5 minutes ago to the pass's end, at most a day ahead) is ignored: a renewal
 * must stay possible before the pass ends, and the database refuses a time far ahead. */
function earliestRenewal(value: unknown, now: number, accessExpiresAt: number): string | null {
	const number = seconds(value);
	const at =
		number !== undefined
			? number > 1e11
				? number
				: number * 1000
			: typeof value === "string" && Number.isFinite(Date.parse(value))
				? Date.parse(value)
				: undefined;
	if (at === undefined || at < now - 5 * 60_000 || at > Math.min(accessExpiresAt, now + 24 * 60 * 60_000)) return null;
	return new Date(at).toISOString();
}

export function serializeChatGptPlanLogin(login: ChatGptPlanLogin): string {
	return JSON.stringify({
		schema: LOGIN_SCHEMA,
		clientId: login.clientId,
		subject: login.subject,
		email: login.email,
		hostId: login.hostId,
		idToken: login.idToken,
		accessToken: login.accessToken,
		refreshToken: login.refreshToken,
		scopes: [...login.scopes],
		accessIssuedAt: login.accessIssuedAt,
		accessExpiresAt: login.accessExpiresAt,
		renewNotBefore: login.renewNotBefore,
	});
}

/** Reads a sealed plan login. Exactly its fields: anything else is refused rather than handed on. */
export function parseChatGptPlanLogin(text: string): ChatGptPlanLogin {
	if (Buffer.byteLength(text, "utf8") > 64 * 1024) throw new Error("ChatGPT plan login is too large");
	const input = parseRecord(JSON.parse(text), "ChatGPT plan login");
	exactKeys(
		input,
		[
			"schema",
			"clientId",
			"subject",
			"email",
			"hostId",
			"idToken",
			"accessToken",
			"refreshToken",
			"scopes",
			"accessIssuedAt",
			"accessExpiresAt",
			"renewNotBefore",
		],
		"ChatGPT plan login",
	);
	if (
		input.schema !== LOGIN_SCHEMA ||
		typeof input.subject !== "string" ||
		input.subject.length < 1 ||
		input.subject.length > 512 ||
		(input.email !== null && (typeof input.email !== "string" || input.email.length > 254)) ||
		typeof input.hostId !== "string" ||
		!isChatGptPlanHostId(input.hostId) ||
		!Array.isArray(input.scopes) ||
		input.scopes.length > 32 ||
		input.scopes.some((scope) => typeof scope !== "string" || !/^[\x21-\x7e]{1,128}$/.test(scope))
	)
		throw new Error("ChatGPT plan login is invalid");
	const accessIssuedAt = isoTime(input.accessIssuedAt, "ChatGPT plan pass start");
	const accessExpiresAt = isoTime(input.accessExpiresAt, "ChatGPT plan pass end");
	if (Date.parse(accessExpiresAt) <= Date.parse(accessIssuedAt)) throw new Error("ChatGPT plan login is invalid");
	return Object.freeze({
		clientId: token(input.clientId, "ChatGPT plan client id"),
		subject: input.subject,
		email: input.email,
		hostId: input.hostId,
		idToken: input.idToken === null ? null : token(input.idToken, "ChatGPT plan ID token"),
		accessToken: token(input.accessToken, "ChatGPT plan access token"),
		refreshToken: token(input.refreshToken, "ChatGPT plan refresh token"),
		scopes: Object.freeze([...(input.scopes as string[])]),
		accessIssuedAt,
		accessExpiresAt,
		renewNotBefore:
			input.renewNotBefore === null ? null : isoTime(input.renewNotBefore, "ChatGPT plan earliest renewal"),
	});
}

/** PKCE: the challenge OpenAI receives for a verifier the vault keeps. */
export function chatGptPlanCodeChallenge(codeVerifier: string): string {
	return createHash("sha256").update(codeVerifier).digest("base64url");
}

/** An ID token that fails a check (signature, algorithm, issuer, audience, time, nonce, owner). A key
 * that cannot be fetched is not this: it says nothing about the token. */
class IdTokenRefused extends Error {}

/** A key id OpenAI's key set does not hold (yet). Like a fetch that failed, it says nothing about the
 * token: a renewal keeps its stored ID token. */
class SigningKeyUnknown extends Error {}

/** OpenAI's discovery document answered, but not as this vault needs it (status, issuer, an endpoint). */
class DiscoveryUnusable extends Error {}

/** A token answer OpenAI gave (200) that this vault cannot use, with a fixed label safe to log. */
class TokenAnswerUnusable extends Error {
	readonly label: "answer unreadable" | "plan scope not granted" | "answer unusable";
	constructor(label: TokenAnswerUnusable["label"]) {
		super(`ChatGPT plan token answer: ${label}`);
		this.label = label;
	}
}

/** What may be logged about a failed OpenAI request: the HTTP status and OpenAI's error code, or a fixed
 * label for an answer this vault refused, never a token, code or secret. */
export function chatGptPlanFailure(error: unknown): string {
	if (error instanceof TokenRefused) return `token endpoint ${error.status}${error.code ? ` ${error.code}` : ""}`;
	if (error instanceof IdTokenRefused) return "ID token refused";
	if (error instanceof SigningKeyUnknown) return "signing key unknown";
	if (error instanceof TokenAnswerUnusable) return `token ${error.label}`;
	if (error instanceof DiscoveryUnusable) return "discovery unusable";
	return "OpenAI unreachable";
}

/** A shared request's promise, given up by this caller alone when its own signal ends. The shared promise
 * itself never goes unhandled: a fetch nobody waits for any more fails quietly. */
function abortable<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
	value.catch(() => undefined);
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolveValue, reject) => {
		const onAbort = (): void => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		value.then(
			(result) => {
				signal.removeEventListener("abort", onAbort);
				resolveValue(result);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

/** A token endpoint answer OpenAI refused, with its machine-readable code when it gave one. */
class TokenRefused extends Error {
	readonly code: string | null;
	readonly status: number;
	constructor(status: number, code: string | null) {
		super("ChatGPT plan token request was refused");
		this.status = status;
		this.code = code;
	}
}

export class ChatGptPlanOAuth {
	readonly #client: ChatGptPlanClient;
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	#endpoints: { readonly at: number; readonly value: Promise<Endpoints> } | undefined;
	#keys = new Map<string, { readonly key: KeyObject; readonly alg: string | undefined }>();
	#keysAt = Number.NEGATIVE_INFINITY;
	#keysLoading: Promise<void> | undefined;

	constructor(options: { client: ChatGptPlanClient; fetch?: typeof fetch; now?: () => number }) {
		this.#client = options.client;
		this.#fetch = options.fetch ?? fetch;
		this.#now = options.now ?? Date.now;
	}

	get clientId(): string {
		return this.#client.clientId;
	}

	/** Where the member's browser goes to sign in and consent: Authorization Code with PKCE, the plan
	 * scopes, the resource, and this login's stable host id. */
	async authorizationUrl(
		input: { state: string; nonce: string; codeChallenge: string; hostId: string },
		signal: AbortSignal,
	): Promise<string> {
		if (!isChatGptPlanHostId(input.hostId)) throw new Error("ChatGPT plan host id is invalid");
		const url = new URL((await this.#discover(signal)).authorization);
		url.searchParams.set("client_id", this.#client.clientId);
		url.searchParams.set("response_type", "code");
		url.searchParams.set("redirect_uri", this.#client.redirectUri);
		url.searchParams.set("scope", SCOPES.join(" "));
		url.searchParams.set("resource", CHATGPT_PLAN_RESOURCE);
		url.searchParams.set("state", input.state);
		url.searchParams.set("nonce", input.nonce);
		url.searchParams.set("code_challenge", input.codeChallenge);
		url.searchParams.set("code_challenge_method", "S256");
		url.searchParams.set("ext_agent_host_id", input.hostId);
		return url.href;
	}

	/** Exchanges the code the member's callback brought for a login: the ID token's signature, issuer,
	 * audience, expiry and nonce checked, and the plan scope granted. OpenAI's endpoints and keys are
	 * loaded before the one-time code is spent; a login OpenAI issued but this vault refuses is ended at
	 * OpenAI at once, never left live there. */
	async exchange(
		input: { code: string; codeVerifier: string; nonce: string; hostId: string },
		signal: AbortSignal,
	): Promise<ChatGptPlanLogin> {
		await this.#discover(signal);
		if (this.#keys.size === 0) await this.#loadKeys(signal);
		const answer = await this.#tokenRequest(
			{
				grant_type: "authorization_code",
				code: input.code,
				redirect_uri: this.#client.redirectUri,
				client_id: this.#client.clientId,
				code_verifier: input.codeVerifier,
				resource: CHATGPT_PLAN_RESOURCE,
			},
			signal,
		);
		try {
			let idToken: string;
			try {
				idToken = token(answer.id_token, "ChatGPT plan ID token");
			} catch {
				throw new TokenAnswerUnusable("answer unusable");
			}
			const identity = await this.verifyIdToken(idToken, input.nonce, signal);
			return this.#login(answer, {
				subject: identity.subject,
				email: identity.email,
				hostId: input.hostId,
				idToken,
			});
		} catch (error) {
			this.#endIssued(answer);
			throw error;
		}
	}

	/** Ends a refresh token OpenAI issued in an answer this vault will not keep. Nothing waits on it: the
	 * caller's answer does not depend on OpenAI's. */
	#endIssued(answer: Record<string, unknown>): void {
		if (typeof answer.refresh_token === "string" && answer.refresh_token.length > 0)
			void this.revoke(answer.refresh_token, AbortSignal.timeout(REQUEST_DEADLINE_MS)).catch(() => undefined);
	}

	/** One renewal: the refresh token is spent and replaced. The renewed login keeps its owner.
	 *
	 * Everything that can fail for a passing reason (discovery, OpenAI's signing keys) is loaded before
	 * the refresh token is spent, so only that part can be `transient`. Once OpenAI answered 200 the old
	 * token is gone: an answer the vault cannot keep is `refused` (the member signs in again) and the new
	 * token is ended at OpenAI, never left behind. */
	async refresh(login: ChatGptPlanLogin, signal: AbortSignal): Promise<ChatGptPlanRenewal> {
		if (login.clientId !== this.#client.clientId) return { outcome: "transient", reason: "client_changed" };
		try {
			await this.#discover(signal);
			if (this.#keys.size === 0) await this.#loadKeys(signal);
		} catch {
			return { outcome: "transient", reason: "provider_unreachable" };
		}
		let answer: Record<string, unknown>;
		try {
			answer = await this.#tokenRequest(
				{
					grant_type: "refresh_token",
					client_id: this.#client.clientId,
					refresh_token: login.refreshToken,
					resource: CHATGPT_PLAN_RESOURCE,
				},
				signal,
			);
		} catch (error) {
			// A 200 this vault cannot read: OpenAI spent the token, and its replacement is unreadable.
			if (error instanceof TokenAnswerUnusable) return { outcome: "refused", reason: "renewal_invalid" };
			if (error instanceof TokenRefused) {
				if (error.code !== null && REFUSED_REFRESH.has(error.code))
					return { outcome: "refused", reason: "refresh_refused" };
				// Our registration, not the member's login: never mark logins for a new sign-in over it.
				if (error.code === "invalid_client") return { outcome: "transient", reason: "client_refused" };
				return { outcome: "transient", reason: error.status >= 500 ? "provider_unavailable" : "refresh_rejected" };
			}
			return { outcome: "transient", reason: "provider_unreachable" };
		}
		// Ends whichever refresh token is live after this answer: the new one, or the old one when OpenAI sent
		// none (it then stays valid, RFC 6749 6).
		const spent = (reason: string): ChatGptPlanRenewal => {
			this.#endIssued(answer.refresh_token === undefined ? { refresh_token: login.refreshToken } : answer);
			return { outcome: "refused", reason };
		};
		let idToken = login.idToken;
		let email = login.email;
		if (answer.id_token !== undefined) {
			try {
				const candidate = token(answer.id_token, "ChatGPT plan ID token");
				const identity = await this.verifyIdToken(candidate, null, signal);
				if (identity.subject !== login.subject) return spent("renewal_owner_differs");
				idToken = candidate;
				email = identity.email ?? email;
			} catch (error) {
				// A key that could not be fetched says nothing about the token: keep the stored ID token (the
				// access token's own subject still pins the owner below). A token that fails a check ends it.
				if (error instanceof IdTokenRefused || !(error instanceof Error)) return spent("renewal_invalid");
			}
		}
		try {
			return {
				outcome: "renewed",
				login: this.#login(
					answer,
					{ subject: login.subject, email, hostId: login.hostId, idToken },
					{ scopes: login.scopes, refreshToken: login.refreshToken },
				),
			};
		} catch (error) {
			// The plan permission can be withdrawn in ChatGPT's settings: such a login serves nobody.
			if (error instanceof TokenAnswerUnusable && error.label === "plan scope not granted")
				return spent("plan_withdrawn");
			return spent("renewal_invalid");
		}
	}

	/** Ends the login's renewable session at OpenAI. An empty 200 is success, also for a token that no
	 * longer works; a refusal of the token itself means the session is over too. */
	async revoke(refreshToken: string, signal: AbortSignal): Promise<"revoked" | "transient"> {
		try {
			const endpoints = await this.#discover(signal);
			const response = await connectorRequest({
				fetch: this.#fetch,
				origin: endpoints.revocation.origin,
				path: endpoints.revocation.pathname,
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded", ...this.#basicAuthorization() },
				body: new URLSearchParams({
					token: refreshToken,
					token_type_hint: "refresh_token",
					client_id: this.#client.clientId,
				}).toString(),
				signal,
				maximumBytes: 16 * 1024,
				deadlineMs: REQUEST_DEADLINE_MS,
			});
			if (response.status === 200) return "revoked";
			if (response.status === 400) {
				const code = jsonString(jsonRecord(parseJsonResponse(response)).error, 128);
				if (code !== null && REFUSED_REFRESH.has(code)) return "revoked";
			}
			return "transient";
		} catch {
			return "transient";
		}
	}

	/** Checks an ID token against OpenAI's published keys: signature, issuer, audience (this client),
	 * expiry with a small tolerance, and the nonce when one is expected. */
	async verifyIdToken(
		idToken: string,
		nonce: string | null,
		signal: AbortSignal,
	): Promise<{ subject: string; email: string | null }> {
		const matched = JWT.exec(idToken);
		if (!matched) throw new IdTokenRefused("ChatGPT plan ID token is invalid");
		let header: Record<string, unknown>;
		let claims: Record<string, unknown>;
		try {
			header = jwtPart(matched[1] as string, "ChatGPT plan ID token header");
			claims = jwtPart(matched[2] as string, "ChatGPT plan ID token");
		} catch {
			throw new IdTokenRefused("ChatGPT plan ID token is invalid");
		}
		if ((header.alg !== "RS256" && header.alg !== "ES256") || typeof header.kid !== "string")
			throw new IdTokenRefused("ChatGPT plan ID token is invalid");
		const { key, alg } = await this.#key(header.kid, signal);
		const signed = Buffer.from(`${matched[1]}.${matched[2]}`, "ascii");
		const signature = Buffer.from(matched[3] as string, "base64url");
		const details = key.asymmetricKeyDetails;
		const valid =
			(alg === undefined || alg === header.alg) &&
			(header.alg === "RS256"
				? key.asymmetricKeyType === "rsa" &&
					(details?.modulusLength ?? 0) >= 2048 &&
					verifySignature("sha256", signed, key, signature)
				: key.asymmetricKeyType === "ec" &&
					details?.namedCurve === "prime256v1" &&
					verifySignature("sha256", signed, { key, dsaEncoding: "ieee-p1363" }, signature));
		if (!valid) throw new IdTokenRefused("ChatGPT plan ID token signature is invalid");
		const audience = claims.aud;
		const audiences = Array.isArray(audience) ? audience : [audience];
		const nowSeconds = this.#now() / 1000;
		if (
			claims.iss !== CHATGPT_PLAN_ISSUER ||
			!audiences.includes(this.#client.clientId) ||
			// Several audiences: the token must name this client as the one it was issued to.
			(audiences.length > 1 && claims.azp !== this.#client.clientId) ||
			(claims.azp !== undefined && claims.azp !== this.#client.clientId) ||
			typeof claims.exp !== "number" ||
			claims.exp + 5 < nowSeconds ||
			(typeof claims.iat === "number" && claims.iat - 300 > nowSeconds) ||
			typeof claims.sub !== "string" ||
			claims.sub.length < 1 ||
			claims.sub.length > 512 ||
			(nonce !== null && claims.nonce !== nonce)
		)
			throw new IdTokenRefused("ChatGPT plan ID token is invalid");
		const email = jsonString(claims.email, 254);
		return { subject: claims.sub, email: email && /^[^\s\0]{3,254}$/.test(email) ? email : null };
	}

	/** A login from a token answer. The granted scopes are the answer's; an answer that leaves them out
	 * (a refresh may: RFC 6749 6) keeps the access token's own, else the login's earlier ones. A refresh
	 * answer without a new refresh token (also allowed by RFC 6749 6) keeps the one the login had. */
	#login(
		answer: Record<string, unknown>,
		owner: { subject: string; email: string | null; hostId: string; idToken: string | null },
		earlier?: { readonly scopes: readonly string[]; readonly refreshToken: string },
	): ChatGptPlanLogin {
		let accessToken: string;
		let refreshToken: string;
		let claims: Record<string, unknown>;
		try {
			accessToken = token(answer.access_token, "ChatGPT plan access token");
			refreshToken =
				answer.refresh_token === undefined && earlier
					? earlier.refreshToken
					: token(answer.refresh_token, "ChatGPT plan refresh token");
			claims = accessClaims(accessToken);
		} catch {
			throw new TokenAnswerUnusable("answer unusable");
		}
		if (answer.token_type !== undefined && String(answer.token_type).toLowerCase() !== "bearer")
			throw new TokenAnswerUnusable("answer unusable");
		const listed = (value: unknown) => (typeof value === "string" ? value.split(" ").filter(Boolean) : undefined);
		const scopes = listed(answer.scope) ?? listed(claims.scope) ?? [...(earlier?.scopes ?? [])];
		if (!scopes.includes(CHATGPT_PLAN_SCOPE)) throw new TokenAnswerUnusable("plan scope not granted");
		// An access token for another account or another client is not this login's.
		if (claims.sub !== undefined && claims.sub !== owner.subject) throw new TokenAnswerUnusable("answer unusable");
		if (claims.client_id !== undefined && claims.client_id !== this.#client.clientId)
			throw new TokenAnswerUnusable("answer unusable");
		const now = this.#now();
		const expiresIn = seconds(answer.expires_in);
		const expiresAt =
			seconds(claims.exp) !== undefined ? (claims.exp as number) * 1000 : expiresIn ? now + expiresIn * 1000 : 0;
		if (expiresAt <= now) throw new TokenAnswerUnusable("answer unusable");
		const issuedAt =
			seconds(claims.iat) !== undefined && (claims.iat as number) * 1000 < expiresAt
				? (claims.iat as number) * 1000
				: Math.min(now, expiresAt - 1000);
		return Object.freeze({
			clientId: this.#client.clientId,
			subject: owner.subject,
			email: owner.email,
			hostId: owner.hostId,
			idToken: owner.idToken,
			accessToken,
			refreshToken,
			scopes: Object.freeze(scopes),
			accessIssuedAt: new Date(issuedAt).toISOString(),
			accessExpiresAt: new Date(expiresAt).toISOString(),
			renewNotBefore: earliestRenewal(answer.earliest_refresh_at, now, expiresAt),
		});
	}

	#basicAuthorization(): Record<string, string> {
		const secret = this.#client.clientSecret;
		if (secret === null) return {};
		const form = (value: string) => new URLSearchParams({ value }).toString().slice("value=".length);
		return {
			authorization: `Basic ${Buffer.from(`${form(this.#client.clientId)}:${form(secret)}`).toString("base64")}`,
		};
	}

	/** One token endpoint request. The secret goes only in the Basic header, never in the form. */
	async #tokenRequest(form: Record<string, string>, signal: AbortSignal): Promise<Record<string, unknown>> {
		const endpoints = await this.#discover(signal);
		const response = await connectorRequest({
			fetch: this.#fetch,
			origin: endpoints.token.origin,
			path: endpoints.token.pathname,
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", ...this.#basicAuthorization() },
			body: new URLSearchParams(form).toString(),
			signal,
			maximumBytes: 64 * 1024,
			deadlineMs: REQUEST_DEADLINE_MS,
		});
		let parsed: Record<string, unknown> = {};
		try {
			parsed = jsonRecord(parseJsonResponse(response));
		} catch {
			if (response.status === 200) throw new TokenAnswerUnusable("answer unreadable");
		}
		if (response.status !== 200 || parsed.error !== undefined)
			throw new TokenRefused(response.status, jsonString(parsed.error, 128));
		return parsed;
	}

	/** OpenAI's endpoints from its discovery document, kept an hour; each one on the issuer's origin. One
	 * fetch serves every caller under its own deadline: a caller whose time ends gives up alone. */
	#discover(signal: AbortSignal): Promise<Endpoints> {
		const known = this.#endpoints;
		if (known && this.#now() - known.at < DISCOVERY_TTL_MS) return abortable(known.value, signal);
		const value = (async (): Promise<Endpoints> => {
			const response = await connectorRequest({
				fetch: this.#fetch,
				origin: CHATGPT_PLAN_ISSUER,
				path: DISCOVERY_PATH,
				headers: {},
				signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
				maximumBytes: 64 * 1024,
				deadlineMs: REQUEST_DEADLINE_MS,
			});
			if (response.status !== 200) throw new DiscoveryUnusable("ChatGPT plan discovery is unavailable");
			try {
				const document = jsonRecord(parseJsonResponse(response));
				if (document.issuer !== CHATGPT_PLAN_ISSUER) throw new Error("ChatGPT plan issuer differs");
				return Object.freeze({
					authorization: issuerEndpoint(document.authorization_endpoint, "ChatGPT plan authorization endpoint"),
					token: issuerEndpoint(document.token_endpoint, "ChatGPT plan token endpoint"),
					revocation: issuerEndpoint(document.revocation_endpoint, "ChatGPT plan revocation endpoint"),
					keys: issuerEndpoint(document.jwks_uri, "ChatGPT plan keys"),
				});
			} catch {
				throw new DiscoveryUnusable("ChatGPT plan discovery is invalid");
			}
		})();
		this.#endpoints = { at: this.#now(), value };
		// A failed discovery is not kept: the next call asks again.
		value.catch(() => {
			if (this.#endpoints?.value === value) this.#endpoints = undefined;
		});
		return abortable(value, signal);
	}

	/** OpenAI's signing key by id. An unknown id waits for a fetch already running, else starts one at most
	 * once a minute; a key the set does not hold is refused. */
	async #key(keyId: string, signal: AbortSignal): Promise<{ key: KeyObject; alg: string | undefined }> {
		let known = this.#keys.get(keyId);
		if (known) return known;
		if (this.#keysLoading) await abortable(this.#keysLoading, signal);
		else if (this.#now() - this.#keysAt >= KEYS_REFETCH_MS) await this.#loadKeys(signal);
		known = this.#keys.get(keyId);
		if (!known) throw new SigningKeyUnknown("ChatGPT plan signing key is unknown");
		return known;
	}

	/** Fetches OpenAI's key set once for every caller waiting on it, under its own deadline: a caller
	 * whose time ends gives up alone, and the fetch goes on for the others. */
	#loadKeys(signal: AbortSignal): Promise<void> {
		this.#keysLoading ??= (async () => {
			this.#keysAt = this.#now();
			const deadline = AbortSignal.timeout(REQUEST_DEADLINE_MS);
			const endpoints = await this.#discover(deadline);
			const response = await connectorRequest({
				fetch: this.#fetch,
				origin: endpoints.keys.origin,
				path: endpoints.keys.pathname,
				headers: {},
				signal: deadline,
				maximumBytes: 256 * 1024,
				deadlineMs: REQUEST_DEADLINE_MS,
			});
			if (response.status !== 200) throw new Error("ChatGPT plan signing keys are unavailable");
			const set = jsonRecord(parseJsonResponse(response));
			if (!Array.isArray(set.keys) || set.keys.length > 32) throw new Error("ChatGPT plan signing keys are invalid");
			const keys = new Map<string, { key: KeyObject; alg: string | undefined }>();
			for (const entry of set.keys) {
				try {
					const jwk = parseRecord(entry, "ChatGPT plan signing key");
					if (typeof jwk.kid !== "string" || (jwk.use !== undefined && jwk.use !== "sig")) continue;
					if (jwk.kty !== "RSA" && jwk.kty !== "EC") continue;
					keys.set(jwk.kid, {
						key: createPublicKey({ key: jwk as JsonWebKey, format: "jwk" }),
						alg: typeof jwk.alg === "string" ? jwk.alg : undefined,
					});
				} catch {
					// A key this vault cannot read is skipped; a token signed with it is refused.
				}
			}
			this.#keys = keys;
		})().finally(() => {
			this.#keysLoading = undefined;
		});
		return abortable(this.#keysLoading, signal);
	}
}
