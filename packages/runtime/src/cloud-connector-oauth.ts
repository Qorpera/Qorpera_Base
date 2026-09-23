import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
	type CloudConnectorDefinition,
	type CloudConnectorOAuthProvider,
	cloudConnector,
} from "./cloud-connector-catalog.ts";
import type { GoogleOAuthClient } from "./cloud-connector-google.ts";
import { connectorRequest, jsonRecord, jsonString, parseJsonResponse } from "./cloud-connector-http.ts";

/**
 * Runtime Step 7: OAuth authorization inside the cloud secret broker.
 *
 * The member's browser is sent to the provider from the broker, and the
 * provider sends it back to the broker. The authorization code, the token
 * exchange and the resulting refresh or access token exist only inside the
 * broker process, which seals them into the capture ticket the member opened.
 * The web client, the database, the runner and the model see only the safe
 * descriptor (contract §11.5). State is single-use, short-lived and bound to
 * one capture ticket and one return page.
 *
 * Several companies' brokers share one public origin, each its own process
 * behind one router. The provider's callback carries only `code` and `state`,
 * so the state begins with the ticket's company profile id,
 * `<profileId>.<43 random base64url characters>`: the router picks the
 * company's broker from that prefix (nginx `map $arg_state`), and the broker
 * accepts the callback only when the whole state is one it issued for that
 * company. The prefix is not a secret and grants nothing; the random part
 * stays single-use and unguessable.
 */

export interface CloudConnectorOAuthClients {
	readonly google?: GoogleOAuthClient;
	readonly github?: GoogleOAuthClient;
}

export interface CloudConnectorOAuthBegin {
	readonly ticketId: string;
	readonly captureCapability: string;
	/** The capture ticket's company profile id; it prefixes the state. */
	readonly companyId: string;
	readonly connectorId: string;
	readonly returnTo: string;
}

export interface CloudConnectorOAuthStarted {
	readonly authorizationUrl: string;
	readonly expiresAt: string;
}

export interface CloudConnectorOAuthCompletion {
	readonly ticketId: string;
	readonly captureCapability: string;
	readonly companyId: string;
	readonly connectorId: string;
	readonly returnTo: string;
	readonly fields: Readonly<Record<string, string>>;
	readonly accountLabel: string | null;
}

export type CloudConnectorOAuthFailureReason =
	| "declined"
	| "expired"
	| "provider_error"
	| "no_refresh_token"
	| "state_unknown";

export class CloudConnectorOAuthError extends Error {
	readonly reason: CloudConnectorOAuthFailureReason;
	readonly returnTo: string | undefined;
	readonly connectorId: string | undefined;
	constructor(reason: CloudConnectorOAuthFailureReason, returnTo?: string, connectorId?: string) {
		super(`Connector authorization ${reason}`);
		this.name = "CloudConnectorOAuthError";
		this.reason = reason;
		this.returnTo = returnTo;
		this.connectorId = connectorId;
	}
}

interface ProviderEndpoints {
	readonly authorization: string;
	readonly token: string;
	readonly identity: { readonly origin: string; readonly path: string };
	readonly pkce: boolean;
}

export const CLOUD_CONNECTOR_OAUTH_PROVIDERS: Readonly<Record<CloudConnectorOAuthProvider, ProviderEndpoints>> = {
	google: {
		authorization: "https://accounts.google.com/o/oauth2/v2/auth",
		token: "https://oauth2.googleapis.com/token",
		identity: { origin: "https://openidconnect.googleapis.com", path: "/v1/userinfo" },
		pkce: true,
	},
	github: {
		authorization: "https://github.com/login/oauth/authorize",
		token: "https://github.com/login/oauth/access_token",
		identity: { origin: "https://api.github.com", path: "/user" },
		pkce: false,
	},
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CAPABILITY = /^[A-Za-z0-9_-]{32,256}$/;
/** `<company profile id>.<32 random bytes, base64url>`. The router's nginx map
 * matches the same prefix (deploy/first-node/RUNTIME-STEP-7-CLOUD-CONNECTORS.md). */
export const CLOUD_CONNECTOR_OAUTH_STATE =
	/^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;
const CODE = /^[\x21-\x7e]{1,2048}$/;
const TOKEN = /^[A-Za-z0-9_./-]{20,4096}$/;
const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING = 256;
const MAX_RETURN_URL = 2048;

interface PendingAuthorization {
	readonly stateSha256: string;
	readonly ticketId: string;
	readonly captureCapability: string;
	readonly companyId: string;
	readonly connectorId: string;
	readonly returnTo: string;
	readonly codeVerifier: string | undefined;
	readonly expiresAt: number;
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function digestsMatch(left: string, right: string): boolean {
	const a = Buffer.from(left, "utf8");
	const b = Buffer.from(right, "utf8");
	return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

/** A return page is accepted only on an allow-listed web origin, over HTTPS
 * (or loopback for local development) and without credentials. The web app is
 * hash-routed, so a fragment is allowed; the outcome is appended after it. */
export function parseConnectorReturnUrl(value: unknown, allowedOrigins: readonly string[]): string {
	if (typeof value !== "string" || value.length > MAX_RETURN_URL) throw new Error("Connector return URL is invalid");
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Connector return URL is invalid");
	}
	if (
		url.username ||
		url.password ||
		!allowedOrigins.includes(url.origin) ||
		(url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname))
	)
		throw new Error("Connector return URL is invalid");
	return url.href;
}

export function parseConnectorReturnOrigins(value: unknown): readonly string[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 16)
		throw new Error("Connector return origins are invalid");
	const origins = value.map((item) => {
		if (typeof item !== "string") throw new Error("Connector return origins are invalid");
		const url = new URL(item);
		if (
			url.origin !== item ||
			(url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) ||
			url.username ||
			url.password
		)
			throw new Error("Connector return origins are invalid");
		return url.origin;
	});
	if (new Set(origins).size !== origins.length) throw new Error("Connector return origins are invalid");
	return Object.freeze(origins);
}

/** Appends the outcome to the return page's fragment, never to its query
 * string, so the outcome stays out of request logs. */
export function connectorReturnLocation(
	returnTo: string,
	connectorId: string,
	outcome: "connected" | "failed",
	reason?: CloudConnectorOAuthFailureReason,
): string {
	const url = new URL(returnTo);
	const fragment = new URLSearchParams({ connector: connectorId, connection: outcome, ...(reason ? { reason } : {}) });
	url.hash = url.hash ? `${url.hash}?${fragment.toString()}` : `#?${fragment.toString()}`;
	return url.href;
}

export class CloudConnectorOAuthFlows {
	readonly #clients: CloudConnectorOAuthClients;
	readonly #callbackUrl: string;
	readonly #returnOrigins: readonly string[];
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	readonly #random: (bytes: number) => Uint8Array;
	readonly #pending = new Map<string, PendingAuthorization>();

	constructor(options: {
		clients: CloudConnectorOAuthClients;
		callbackUrl: string;
		returnOrigins: readonly string[];
		fetch?: typeof fetch;
		now?: () => number;
		random?: (bytes: number) => Uint8Array;
	}) {
		const callback = new URL(options.callbackUrl);
		if (
			callback.protocol !== "https:" ||
			callback.username ||
			callback.password ||
			callback.search ||
			callback.hash ||
			!callback.pathname.endsWith("/v1/oauth/callback")
		)
			throw new Error("Connector OAuth callback URL is invalid");
		for (const client of Object.values(options.clients)) {
			if (!client) continue;
			if (!client.clientId || !client.clientSecret || /[\s\0]/.test(client.clientId + client.clientSecret))
				throw new Error("Connector OAuth client is invalid");
		}
		this.#clients = options.clients;
		this.#callbackUrl = callback.href;
		this.#returnOrigins = parseConnectorReturnOrigins([...options.returnOrigins]);
		this.#fetch = options.fetch ?? fetch;
		this.#now = options.now ?? Date.now;
		this.#random = options.random ?? ((bytes) => randomBytes(bytes));
	}

	/** Connectors whose provider has a registered OAuth client. */
	available(): readonly string[] {
		return Object.freeze(
			["github", "gmail", "google_drive"].filter(
				(connectorId) => this.#client(cloudConnector(connectorId)) !== undefined,
			),
		);
	}

	#client(connector: CloudConnectorDefinition): GoogleOAuthClient | undefined {
		return this.#clients[connector.oauth.provider];
	}

	#sweep(): void {
		const now = this.#now();
		for (const [key, pending] of this.#pending) if (pending.expiresAt <= now) this.#pending.delete(key);
	}

	begin(input: CloudConnectorOAuthBegin): CloudConnectorOAuthStarted {
		if (!UUID.test(input.ticketId) || !CAPABILITY.test(input.captureCapability) || !UUID.test(input.companyId))
			throw new Error("Connector OAuth start is invalid");
		const companyId = input.companyId.toLowerCase();
		const connector = cloudConnector(input.connectorId);
		const client = this.#client(connector);
		if (!client) throw new Error("Connector OAuth client is unavailable");
		const returnTo = parseConnectorReturnUrl(input.returnTo, this.#returnOrigins);
		this.#sweep();
		if (this.#pending.size >= MAX_PENDING) throw new Error("Connector OAuth is busy");
		const endpoints = CLOUD_CONNECTOR_OAUTH_PROVIDERS[connector.oauth.provider];
		const state = `${companyId}.${Buffer.from(this.#random(32)).toString("base64url")}`;
		const codeVerifier = endpoints.pkce ? Buffer.from(this.#random(32)).toString("base64url") : undefined;
		const expiresAt = this.#now() + STATE_TTL_MS;
		const url = new URL(endpoints.authorization);
		url.searchParams.set("client_id", client.clientId);
		url.searchParams.set("redirect_uri", this.#callbackUrl);
		url.searchParams.set("response_type", "code");
		url.searchParams.set("scope", connector.oauth.scopes.join(" "));
		url.searchParams.set("state", state);
		if (connector.oauth.provider === "google") {
			url.searchParams.set("access_type", "offline");
			url.searchParams.set("prompt", "consent");
			url.searchParams.set("include_granted_scopes", "false");
		}
		if (codeVerifier) {
			url.searchParams.set("code_challenge", createHash("sha256").update(codeVerifier).digest("base64url"));
			url.searchParams.set("code_challenge_method", "S256");
		}
		this.#pending.set(sha256(state), {
			stateSha256: sha256(state),
			ticketId: input.ticketId,
			captureCapability: input.captureCapability,
			companyId,
			connectorId: connector.id,
			returnTo,
			codeVerifier,
			expiresAt,
		});
		return { authorizationUrl: url.href, expiresAt: new Date(expiresAt).toISOString() };
	}

	/** Consumes the provider's callback. The pending entry is removed before
	 * any network call, so a replayed callback cannot mint a second capture. */
	async complete(
		query: { readonly state?: string; readonly code?: string; readonly error?: string },
		signal: AbortSignal,
	): Promise<CloudConnectorOAuthCompletion> {
		const state = typeof query.state === "string" ? CLOUD_CONNECTOR_OAUTH_STATE.exec(query.state) : null;
		if (!state) throw new CloudConnectorOAuthError("state_unknown");
		const key = sha256(state[0]);
		const pending = this.#pending.get(key);
		// The prefix only routes; the whole state must be one this broker issued
		// for that same company.
		if (!pending || !digestsMatch(pending.stateSha256, key) || pending.companyId !== state[1])
			throw new CloudConnectorOAuthError("state_unknown");
		this.#pending.delete(key);
		this.#sweep();
		if (pending.expiresAt <= this.#now()) {
			throw new CloudConnectorOAuthError("expired", pending.returnTo, pending.connectorId);
		}
		if (query.error !== undefined || typeof query.code !== "string" || !CODE.test(query.code)) {
			throw new CloudConnectorOAuthError(
				query.error === "access_denied" || query.error === "consent_required" ? "declined" : "provider_error",
				pending.returnTo,
				pending.connectorId,
			);
		}
		const connector = cloudConnector(pending.connectorId);
		const client = this.#client(connector);
		if (!client) throw new CloudConnectorOAuthError("provider_error", pending.returnTo, pending.connectorId);
		const endpoints = CLOUD_CONNECTOR_OAUTH_PROVIDERS[connector.oauth.provider];
		let tokens: Record<string, unknown>;
		try {
			tokens = await this.#exchange(endpoints, client, query.code, pending.codeVerifier, signal);
		} catch {
			throw new CloudConnectorOAuthError("provider_error", pending.returnTo, pending.connectorId);
		}
		const accessToken = jsonString(tokens.access_token, 4096);
		const refreshToken = jsonString(tokens.refresh_token, 4096);
		const fields: Record<string, string> = {};
		if (connector.credentialName === "refresh_token") {
			if (!refreshToken || !TOKEN.test(refreshToken)) {
				throw new CloudConnectorOAuthError("no_refresh_token", pending.returnTo, pending.connectorId);
			}
			fields.refresh_token = refreshToken;
		} else {
			if (!accessToken || !TOKEN.test(accessToken)) {
				throw new CloudConnectorOAuthError("provider_error", pending.returnTo, pending.connectorId);
			}
			fields[connector.credentialName] = accessToken;
		}
		let accountLabel: string | null = null;
		if (accessToken && TOKEN.test(accessToken)) {
			try {
				accountLabel = await this.#identity(endpoints, accessToken, signal);
			} catch {
				accountLabel = null;
			}
		}
		return {
			ticketId: pending.ticketId,
			captureCapability: pending.captureCapability,
			companyId: pending.companyId,
			connectorId: pending.connectorId,
			returnTo: pending.returnTo,
			fields,
			accountLabel,
		};
	}

	async #exchange(
		endpoints: ProviderEndpoints,
		client: GoogleOAuthClient,
		code: string,
		codeVerifier: string | undefined,
		signal: AbortSignal,
	): Promise<Record<string, unknown>> {
		const token = new URL(endpoints.token);
		const body = new URLSearchParams({
			client_id: client.clientId,
			client_secret: client.clientSecret,
			code,
			grant_type: "authorization_code",
			redirect_uri: this.#callbackUrl,
			...(codeVerifier ? { code_verifier: codeVerifier } : {}),
		}).toString();
		const response = await connectorRequest({
			fetch: this.#fetch,
			origin: token.origin,
			path: token.pathname,
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
			body,
			signal,
			maximumBytes: 64 * 1024,
			deadlineMs: 15_000,
		});
		if (response.status !== 200) throw new Error("Connector token exchange was refused");
		const parsed = jsonRecord(parseJsonResponse(response));
		if (parsed.error !== undefined) throw new Error("Connector token exchange was refused");
		return parsed;
	}

	async #identity(endpoints: ProviderEndpoints, accessToken: string, signal: AbortSignal): Promise<string | null> {
		const response = await connectorRequest({
			fetch: this.#fetch,
			origin: endpoints.identity.origin,
			path: endpoints.identity.path,
			headers: { authorization: `Bearer ${accessToken}`, "user-agent": "qorpera-cloud-connector" },
			signal,
			maximumBytes: 64 * 1024,
			deadlineMs: 10_000,
		});
		if (response.status !== 200) return null;
		const identity = jsonRecord(parseJsonResponse(response));
		const label = jsonString(identity.email, 254) ?? jsonString(identity.login, 254);
		return label && /^[^\s\0]{1,254}$/.test(label) ? label : null;
	}
}
