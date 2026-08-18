/**
 * OAuth 2.0 authorization-code onboarding (founder CLI context).
 *
 * Kernel-side refresh existed since Build 3; what was missing was the
 * FIRST grant — the browser dance. `qorpera company secret oauth <name>`
 * runs it here, in the founder's terminal process (which has network and
 * is outside every sandbox): a loopback redirect server on 127.0.0.1, a
 * PKCE (S256) authorization URL the founder opens, and a code exchange at
 * the token endpoint. The resulting tokens land directly in the kernel
 * secret store — the founder never sees or pastes a token, the agent
 * never sees anything at all, and from then on the ordinary kernel-side
 * refresh keeps the secret live.
 *
 * Generic RFC 6749 + RFC 7636 — no provider ontology. Providers that
 * return no refresh token get stored as static secrets (no auto-refresh),
 * stated plainly to the founder.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
	bindCompanySecret,
	type CompanySecret,
	materializeOAuthRequestHeaders,
	type OAuth2ClientAuthentication,
	type OAuthRequestHeaderTemplates,
} from "./company-connections.ts";

const DEFAULT_FLOW_TIMEOUT_MS = 5 * 60 * 1000;
const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i;
const FORBIDDEN_CLIENT_AUTH_HEADERS = new Set(["authorization", "content-type", "cookie", "host"]);

export interface OAuthOnboardingConfig {
	authUrl: string;
	tokenUrl: string;
	clientId: string;
	clientSecret?: string;
	scope?: string;
	/** Standard OAuth opens a GET URL. Some bank APIs first require a
	 * back-channel POST whose 3xx Location becomes the browser URL. */
	authorizationMethod?: "get" | "post";
	usePkce?: boolean;
	authorizationParameters?: Readonly<Record<string, string>>;
	authorizationHeaders?: OAuthRequestHeaderTemplates;
	clientAuthentication?: OAuth2ClientAuthentication;
	tokenHeaders?: OAuthRequestHeaderTemplates;
}

export interface OAuthOnboardingOptions {
	fetchImpl?: typeof fetch;
	/** Receives the authorization URL (the CLI prints it; tests drive it). */
	onAuthorizeUrl?: (url: string) => void;
	/** Receives the grant at the trusted boundary. Desktop profiles inject
	 * their selected local or hosted vault; the CLI keeps the machine-local
	 * connection store as its compatibility default. */
	storeSecret?: (root: string, name: string, secret: CompanySecret) => void | Promise<void>;
	/** Cancels the loopback listener before a grant is stored. */
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface OAuthOnboardingResult {
	kind: "oauth2" | "static";
	expiresAt?: string;
}

function base64url(input: Buffer): string {
	return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const RESERVED_AUTHORIZATION_PARAMETERS = new Set([
	"client_id",
	"code_challenge",
	"code_challenge_method",
	"redirect_uri",
	"response_type",
	"scope",
	"state",
]);

function clientAuthenticationHeaders(config: OAuthOnboardingConfig): Record<string, string> {
	const authentication = config.clientAuthentication;
	if (authentication?.kind !== "headers") return {};
	if (!config.clientSecret) throw new Error("OAuth onboarding requires a client secret for header authentication");
	if (
		!HTTP_HEADER_NAME_PATTERN.test(authentication.clientIdHeader) ||
		!HTTP_HEADER_NAME_PATTERN.test(authentication.clientSecretHeader) ||
		FORBIDDEN_CLIENT_AUTH_HEADERS.has(authentication.clientIdHeader.toLowerCase()) ||
		FORBIDDEN_CLIENT_AUTH_HEADERS.has(authentication.clientSecretHeader.toLowerCase()) ||
		authentication.clientIdHeader.toLowerCase() === authentication.clientSecretHeader.toLowerCase()
	) {
		throw new Error("OAuth client authentication headers are invalid");
	}
	return {
		[authentication.clientIdHeader]: config.clientId,
		[authentication.clientSecretHeader]: config.clientSecret,
	};
}

interface SafeOAuthError {
	code?: string;
	description?: string;
}

async function safeOAuthError(response: Response): Promise<SafeOAuthError> {
	try {
		const body = JSON.parse(await response.text()) as { error?: unknown; error_description?: unknown };
		return {
			...(typeof body.error === "string" && /^[a-z0-9_.-]{1,80}$/i.test(body.error) ? { code: body.error } : {}),
			...(typeof body.error_description === "string" && /^[a-z0-9 _.,:'()-]{1,200}$/i.test(body.error_description)
				? { description: body.error_description }
				: {}),
		};
	} catch {
		return {};
	}
}

/** Run the authorization-code + PKCE flow and bind the result as secret://<name>. */
export async function runOAuthOnboarding(
	root: string,
	name: string,
	config: OAuthOnboardingConfig,
	options?: OAuthOnboardingOptions,
): Promise<OAuthOnboardingResult> {
	const fetchImpl = options?.fetchImpl ?? fetch;
	const verifier = base64url(randomBytes(48));
	const challenge = base64url(createHash("sha256").update(verifier).digest());
	const state = randomUUID();
	const usePkce = config.usePkce ?? true;
	if (config.authorizationMethod !== "post" && config.clientAuthentication?.kind === "headers") {
		throw new Error("OAuth header client authentication requires a POST authorization request");
	}
	if (config.authorizationMethod !== "post" && config.authorizationHeaders) {
		throw new Error("OAuth authorization headers require a POST authorization request");
	}
	const configuredClientHeaders = clientAuthenticationHeaders(config);
	for (const name of Object.keys(config.authorizationParameters ?? {})) {
		if (RESERVED_AUTHORIZATION_PARAMETERS.has(name)) {
			throw new Error(`OAuth authorization parameter is reserved: ${name}`);
		}
	}

	const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolveCode, rejectCode) => {
		let redirectUri = "";
		let timer: NodeJS.Timeout | undefined;
		const cleanup = (): void => {
			if (timer) clearTimeout(timer);
			options?.signal?.removeEventListener("abort", onAbort);
		};
		const rejectFlow = (error: Error): void => {
			cleanup();
			if (server.listening) server.close();
			rejectCode(error);
		};
		const onAbort = (): void => rejectFlow(new Error("OAuth onboarding cancelled"));
		const server = createServer((request, response) => {
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			if (url.pathname !== "/callback") {
				response.writeHead(404).end();
				return;
			}
			const finish = (body: string): void => {
				response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
				server.close();
				cleanup();
			};
			if (url.searchParams.get("state") !== state) {
				finish(
					"<p>State mismatch — this authorization attempt was not started by Qorpera. Nothing was stored.</p>",
				);
				rejectCode(new Error("OAuth onboarding rejected: state mismatch"));
				return;
			}
			const grantedCode = url.searchParams.get("code");
			const providerError = url.searchParams.get("error");
			if (!grantedCode) {
				finish(`<p>Authorization failed${providerError ? `: ${providerError}` : ""}. Nothing was stored.</p>`);
				rejectCode(new Error(`OAuth onboarding failed: ${providerError ?? "no code returned"}`));
				return;
			}
			finish("<p>Authorization received — you can close this tab and return to the terminal.</p>");
			resolveCode({ code: grantedCode, redirectUri });
		});
		timer = setTimeout(
			() => rejectFlow(new Error("OAuth onboarding timed out waiting for the browser redirect")),
			options?.timeoutMs ?? DEFAULT_FLOW_TIMEOUT_MS,
		);
		timer.unref();
		if (options?.signal?.aborted) {
			onAbort();
			return;
		}
		options?.signal?.addEventListener("abort", onAbort, { once: true });
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as AddressInfo).port;
			redirectUri = `http://127.0.0.1:${port}/callback`;
			const authorize = new URL(config.authUrl);
			authorize.searchParams.set("response_type", "code");
			authorize.searchParams.set("client_id", config.clientId);
			authorize.searchParams.set("redirect_uri", redirectUri);
			authorize.searchParams.set("state", state);
			if (usePkce) {
				authorize.searchParams.set("code_challenge", challenge);
				authorize.searchParams.set("code_challenge_method", "S256");
			}
			if (config.scope) authorize.searchParams.set("scope", config.scope);
			for (const [name, value] of Object.entries(config.authorizationParameters ?? {})) {
				authorize.searchParams.set(name, value);
			}
			if (config.authorizationMethod !== "post") {
				options?.onAuthorizeUrl?.(authorize.toString());
				return;
			}
			void fetchImpl(authorize, {
				method: "POST",
				headers: {
					...materializeOAuthRequestHeaders(config.authorizationHeaders, authorize, ""),
					...configuredClientHeaders,
				},
				redirect: "manual",
				signal: options?.signal,
			})
				.then((response) => {
					const location = response.headers.get("location");
					if (response.status < 300 || response.status >= 400 || !location) {
						throw new Error(`OAuth onboarding failed: authorization endpoint returned ${response.status}`);
					}
					options?.onAuthorizeUrl?.(new URL(location, authorize).toString());
				})
				.catch((error: unknown) =>
					rejectFlow(error instanceof Error ? error : new Error("OAuth authorization request failed")),
				);
		});
		server.once("error", (error) => rejectFlow(error));
	});

	const exchange = new URLSearchParams({
		grant_type: "authorization_code",
		code,
		redirect_uri: redirectUri,
	});
	if (config.clientAuthentication?.kind !== "headers") {
		exchange.set("client_id", config.clientId);
		if (config.clientSecret) exchange.set("client_secret", config.clientSecret);
	}
	if (usePkce) exchange.set("code_verifier", verifier);
	const exchangeBody = exchange.toString();
	const exchangeHeaders: Record<string, string> = {
		"content-type": "application/x-www-form-urlencoded",
		...materializeOAuthRequestHeaders(config.tokenHeaders, config.tokenUrl, exchangeBody),
		...configuredClientHeaders,
	};
	const response = await fetchImpl(config.tokenUrl, {
		method: "POST",
		headers: exchangeHeaders,
		body: exchangeBody,
		signal: options?.signal,
	});
	if (!response.ok) {
		const providerError = await safeOAuthError(response);
		throw new Error(
			`OAuth onboarding failed: token endpoint returned ${response.status}${providerError.code ? ` (${providerError.code})` : ""}${providerError.description ? `: ${providerError.description}` : ""}`,
		);
	}
	const granted = (await response.json()) as {
		access_token?: unknown;
		refresh_token?: unknown;
		expires_in?: unknown;
	};
	if (typeof granted.access_token !== "string" || !granted.access_token) {
		throw new Error("OAuth onboarding failed: no access token in the grant");
	}
	const expiresAt =
		typeof granted.expires_in === "number" && Number.isFinite(granted.expires_in)
			? new Date(Date.now() + granted.expires_in * 1000).toISOString()
			: undefined;
	const secret: CompanySecret =
		typeof granted.refresh_token === "string" && granted.refresh_token
			? {
					kind: "oauth2",
					accessToken: granted.access_token,
					refreshToken: granted.refresh_token,
					tokenUrl: config.tokenUrl,
					clientId: config.clientId,
					...(config.clientSecret ? { clientSecret: config.clientSecret } : {}),
					...(config.clientAuthentication ? { clientAuthentication: config.clientAuthentication } : {}),
					...(config.tokenHeaders ? { tokenHeaders: config.tokenHeaders } : {}),
					...(config.scope ? { scope: config.scope } : {}),
					...(expiresAt ? { expiresAt } : {}),
				}
			: { kind: "static", value: granted.access_token };
	await (options?.storeSecret ?? bindCompanySecret)(root, name, secret);
	return { kind: secret.kind, ...(expiresAt ? { expiresAt } : {}) };
}
