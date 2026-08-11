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
import { bindCompanySecret, type CompanySecret } from "./company-connections.ts";

const DEFAULT_FLOW_TIMEOUT_MS = 5 * 60 * 1000;

export interface OAuthOnboardingConfig {
	authUrl: string;
	tokenUrl: string;
	clientId: string;
	clientSecret?: string;
	scope?: string;
}

export interface OAuthOnboardingOptions {
	fetchImpl?: typeof fetch;
	/** Receives the authorization URL (the CLI prints it; tests drive it). */
	onAuthorizeUrl?: (url: string) => void;
	timeoutMs?: number;
}

export interface OAuthOnboardingResult {
	kind: "oauth2" | "static";
	expiresAt?: string;
}

function base64url(input: Buffer): string {
	return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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

	const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolveCode, rejectCode) => {
		let redirectUri = "";
		const server = createServer((request, response) => {
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			if (url.pathname !== "/callback") {
				response.writeHead(404).end();
				return;
			}
			const finish = (body: string): void => {
				response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
				server.close();
				clearTimeout(timer);
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
		const timer = setTimeout(() => {
			server.close();
			rejectCode(new Error("OAuth onboarding timed out waiting for the browser redirect"));
		}, options?.timeoutMs ?? DEFAULT_FLOW_TIMEOUT_MS);
		timer.unref();
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as AddressInfo).port;
			redirectUri = `http://127.0.0.1:${port}/callback`;
			const authorize = new URL(config.authUrl);
			authorize.searchParams.set("response_type", "code");
			authorize.searchParams.set("client_id", config.clientId);
			authorize.searchParams.set("redirect_uri", redirectUri);
			authorize.searchParams.set("state", state);
			authorize.searchParams.set("code_challenge", challenge);
			authorize.searchParams.set("code_challenge_method", "S256");
			if (config.scope) authorize.searchParams.set("scope", config.scope);
			options?.onAuthorizeUrl?.(authorize.toString());
		});
		server.once("error", rejectCode);
	});

	const exchange = new URLSearchParams({
		grant_type: "authorization_code",
		code,
		redirect_uri: redirectUri,
		client_id: config.clientId,
		code_verifier: verifier,
	});
	if (config.clientSecret) exchange.set("client_secret", config.clientSecret);
	const response = await fetchImpl(config.tokenUrl, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: exchange.toString(),
	});
	if (!response.ok) {
		throw new Error(`OAuth onboarding failed: token endpoint returned ${response.status}`);
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
					...(config.scope ? { scope: config.scope } : {}),
					...(expiresAt ? { expiresAt } : {}),
				}
			: { kind: "static", value: granted.access_token };
	bindCompanySecret(root, name, secret);
	return { kind: secret.kind, ...(expiresAt ? { expiresAt } : {}) };
}
