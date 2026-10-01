import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";

/**
 * A fake of OpenAI's side of Sign in with ChatGPT for the vault's tests: the discovery document, the
 * signing keys, the authorization step (a member consenting), the token endpoint (code exchange and
 * rotating refresh) and revocation. It checks what OpenAI checks: the PKCE verifier, the exact callback
 * address, the client, the resource, and a refresh token used once.
 */

export const ISSUER = "https://auth.openai.com";
const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

export interface FakeOpenAiOptions {
	readonly clientId?: string;
	readonly clientSecret?: string | null;
	readonly redirectUri?: string;
	readonly now?: () => number;
}

interface Grant {
	readonly subject: string;
	readonly email: string | null;
	readonly scope: string;
	readonly nonce: string;
	readonly codeChallenge: string;
	readonly redirectUri: string;
}

export function fakeOpenAi(options: FakeOpenAiOptions = {}) {
	const clientId = options.clientId ?? "oaiapp_qorpera_test";
	const clientSecret = options.clientSecret === undefined ? "s".repeat(32) : options.clientSecret;
	const redirectUri = options.redirectUri ?? "https://project.supabase.co/functions/v1/chatgpt-plan-callback";
	const now = options.now ?? Date.now;
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	/** OpenAI's published keys: an RSA key, and keys a test adds (an EC key, a key with another alg). */
	const jwks: Array<Record<string, unknown>> = [
		{ ...publicKey.export({ format: "jwk" }), kid: "key-1", use: "sig", alg: "RS256" },
	];
	const codes = new Map<string, Grant>();
	/** Live refresh tokens; a used one moves to `spent` (using it again is `refresh_token_reused`). */
	const refreshTokens = new Map<string, Grant>();
	const spent = new Set<string>();
	const revoked = new Set<string>();
	const requests: Array<{ path: string; form: URLSearchParams; authorization: string | null }> = [];
	const behaviour = {
		/** The next token endpoint answer, instead of the normal one. */
		tokenAnswer: undefined as undefined | { status: number; body: unknown },
		/** Leave the plan scope out of the next tokens (the member declined plan use). */
		withoutPlanScope: false,
		/** Seconds until the next tokens' earliest renewal, or null for none. */
		earliestRefreshIn: 1800 as number | null,
		accessLifeSeconds: 3600,
		revocationStatus: 200,
		/** A refresh answer also carries an ID token, signed with this key id (unknown ids are refused). */
		idTokenOnRefresh: undefined as undefined | { kid: string; subject?: string },
		/** A refresh answer leaves `scope` out (RFC 6749 6 allows it when unchanged). */
		omitScopeOnRefresh: false,
		/** The earliest renewal as sent, overriding `earliestRefreshIn` (to test units and bounds). */
		earliestRefreshAt: undefined as undefined | number | string,
		keysStatus: 200,
		/** A refresh answer carries no new refresh token, and the old one stays live (RFC 6749 6). */
		omitRefreshTokenOnRefresh: false,
		/** Access tokens carry no `scope` claim. */
		omitScopeClaim: false,
	};
	const signers = new Map<string, { key: KeyObject; alg: "RS256" | "ES256" }>([
		["key-1", { key: privateKey, alg: "RS256" }],
	]);

	const jwt = (claims: Record<string, unknown>, key?: KeyObject, kid = "key-1", alg?: "RS256" | "ES256") => {
		const signer = signers.get(kid);
		const algorithm = alg ?? signer?.alg ?? "RS256";
		const signed = `${part({ alg: algorithm, kid, typ: "JWT" })}.${part(claims)}`;
		const signature =
			algorithm === "ES256"
				? sign("sha256", Buffer.from(signed), { key: key ?? (signer?.key as KeyObject), dsaEncoding: "ieee-p1363" })
				: sign("sha256", Buffer.from(signed), key ?? signer?.key ?? privateKey);
		return `${signed}.${signature.toString("base64url")}`;
	};

	/** Publishes another signing key: an EC P-256 or P-384 key, an RSA key whose published alg differs, or
	 * an RSA key of 1024 bits. */
	const addKey = (kid: string, kind: "ec" | "ec-p384" | "rsa-mislabelled" | "rsa-1024") => {
		if (kind === "ec" || kind === "ec-p384") {
			const pair = generateKeyPairSync("ec", { namedCurve: kind === "ec" ? "prime256v1" : "secp384r1" });
			jwks.push({ ...pair.publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "ES256" });
			signers.set(kid, { key: pair.privateKey, alg: "ES256" });
		} else if (kind === "rsa-1024") {
			const pair = generateKeyPairSync("rsa", { modulusLength: 1024 });
			jwks.push({ ...pair.publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" });
			signers.set(kid, { key: pair.privateKey, alg: "RS256" });
		} else {
			const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
			jwks.push({ ...pair.publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "ES256" });
			signers.set(kid, { key: pair.privateKey, alg: "RS256" });
		}
	};

	const tokensFor = (grant: Grant, idToken: boolean, refresh_ = false) => {
		const issued = Math.floor(now() / 1000);
		const scope = behaviour.withoutPlanScope
			? grant.scope
					.split(" ")
					.filter((scope) => scope !== "chatgpt.tokens.use.direct")
					.join(" ")
			: grant.scope;
		const keepRefresh = refresh_ && behaviour.omitRefreshTokenOnRefresh;
		const refresh = `rt_${randomBytes(24).toString("base64url")}`;
		if (!keepRefresh) refreshTokens.set(refresh, grant);
		return {
			access_token: jwt({
				sub: grant.subject,
				aud: "https://api.openai.com/v1",
				client_id: clientId,
				...(behaviour.omitScopeClaim ? {} : { scope }),
				iss: ISSUER,
				iat: issued,
				nbf: issued,
				exp: issued + behaviour.accessLifeSeconds,
				jti: randomBytes(8).toString("hex"),
			}),
			...(keepRefresh ? {} : { refresh_token: refresh }),
			...(idToken
				? {
						id_token: jwt({
							iss: ISSUER,
							aud: clientId,
							sub: grant.subject,
							email: grant.email,
							nonce: grant.nonce,
							iat: issued,
							exp: issued + 3600,
						}),
					}
				: {}),
			...(refresh_ && behaviour.idTokenOnRefresh
				? {
						id_token: jwt(
							{
								iss: ISSUER,
								aud: clientId,
								sub: behaviour.idTokenOnRefresh.subject ?? grant.subject,
								email: "renewed@example.test",
								iat: issued,
								exp: issued + 3600,
							},
							undefined,
							behaviour.idTokenOnRefresh.kid,
						),
					}
				: {}),
			token_type: "Bearer",
			expires_in: behaviour.accessLifeSeconds,
			...(refresh_ && behaviour.omitScopeOnRefresh ? {} : { scope }),
			...(behaviour.earliestRefreshAt !== undefined
				? { earliest_refresh_at: behaviour.earliestRefreshAt }
				: behaviour.earliestRefreshIn === null
					? {}
					: { earliest_refresh_at: issued + behaviour.earliestRefreshIn }),
		};
	};

	const json = (status: number, body: unknown) =>
		new Response(body === undefined ? "" : JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});

	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : input);
		if (url.origin !== ISSUER) return json(404, { error: "not_found" });
		const form = new URLSearchParams(
			typeof init?.body === "string" ? init.body : Buffer.from((init?.body as Uint8Array) ?? []).toString(),
		);
		const headers = new Headers(init?.headers);
		requests.push({ path: url.pathname, form, authorization: headers.get("authorization") });
		if (url.pathname === "/.well-known/openid-configuration")
			return json(200, {
				issuer: ISSUER,
				authorization_endpoint: `${ISSUER}/api/accounts/authorize`,
				token_endpoint: `${ISSUER}/api/accounts/oauth/token`,
				revocation_endpoint: `${ISSUER}/api/accounts/oauth/revoke`,
				jwks_uri: `${ISSUER}/.well-known/jwks.json`,
			});
		if (url.pathname === "/.well-known/jwks.json")
			return behaviour.keysStatus === 200 ? json(200, { keys: jwks }) : json(behaviour.keysStatus, {});
		if (url.pathname === "/api/accounts/oauth/revoke") {
			if (behaviour.revocationStatus !== 200) return json(behaviour.revocationStatus, { error: "server_error" });
			const token = form.get("token") ?? "";
			revoked.add(token);
			refreshTokens.delete(token);
			return new Response("", { status: 200 });
		}
		if (url.pathname !== "/api/accounts/oauth/token") return json(404, { error: "not_found" });
		// RFC 6749 2.3.1: client id and secret are form-encoded before the Basic header.
		const formEncoded = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
		const expected =
			clientSecret === null
				? null
				: `Basic ${Buffer.from(`${formEncoded(clientId)}:${formEncoded(clientSecret)}`).toString("base64")}`;
		if (headers.get("authorization") !== expected || form.get("client_secret") !== null)
			return json(401, { error: "invalid_client" });
		if (form.get("client_id") !== clientId || form.get("resource") !== "https://api.openai.com/v1")
			return json(400, { error: "invalid_request" });
		if (behaviour.tokenAnswer) {
			const answer = behaviour.tokenAnswer;
			behaviour.tokenAnswer = undefined;
			return json(answer.status, answer.body);
		}
		if (form.get("grant_type") === "authorization_code") {
			const grant = codes.get(form.get("code") ?? "");
			codes.delete(form.get("code") ?? "");
			if (
				!grant ||
				form.get("redirect_uri") !== grant.redirectUri ||
				createHash("sha256")
					.update(form.get("code_verifier") ?? "")
					.digest("base64url") !== grant.codeChallenge
			)
				return json(400, { error: "invalid_grant" });
			return json(200, tokensFor(grant, true));
		}
		if (form.get("grant_type") === "refresh_token") {
			const refresh = form.get("refresh_token") ?? "";
			if (spent.has(refresh)) return json(400, { error: "refresh_token_reused" });
			const grant = refreshTokens.get(refresh);
			if (!grant) return json(400, { error: "invalid_grant" });
			if (!behaviour.omitRefreshTokenOnRefresh) {
				refreshTokens.delete(refresh);
				spent.add(refresh);
			}
			return json(200, tokensFor(grant, false, true));
		}
		return json(400, { error: "unsupported_grant_type" });
	}) as typeof globalThis.fetch;

	/** The member signs in and consents at OpenAI's authorization address; the browser would come back
	 * to the callback with this code and state. */
	const consent = (authorizationUrl: string, member: { subject: string; email?: string | null }) => {
		const url = new URL(authorizationUrl);
		const code = `code_${randomBytes(16).toString("base64url")}`;
		codes.set(code, {
			subject: member.subject,
			email: member.email === undefined ? "member@example.test" : member.email,
			scope: url.searchParams.get("scope") ?? "",
			nonce: url.searchParams.get("nonce") ?? "",
			codeChallenge: url.searchParams.get("code_challenge") ?? "",
			redirectUri: url.searchParams.get("redirect_uri") ?? "",
		});
		return { code, state: url.searchParams.get("state") ?? "" };
	};

	/** Gives out a refresh token as a sign-in would, for tests that start from a stored login. */
	const issueRefreshToken = (subject: string) => {
		const tokens = tokensFor(
			{
				subject,
				email: null,
				scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
				nonce: "",
				codeChallenge: "",
				redirectUri,
			},
			false,
		);
		// Not a refresh answer: it always carries a refresh token and its scope.
		return { ...tokens, refresh_token: tokens.refresh_token as string, scope: tokens.scope as string };
	};

	return {
		clientId,
		clientSecret,
		redirectUri,
		fetch,
		consent,
		jwt,
		requests,
		behaviour,
		refreshTokens,
		spent,
		revoked,
		issueRefreshToken,
		addKey,
		client: { clientId, clientSecret, redirectUri },
	};
}
