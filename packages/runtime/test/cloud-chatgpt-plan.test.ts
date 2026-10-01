import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import {
	ChatGptPlanOAuth,
	chatGptPlanCodeChallenge,
	parseChatGptPlanClient,
	parseChatGptPlanLogin,
	serializeChatGptPlanLogin,
} from "@qorpera/runtime/cloud-chatgpt-plan";
import { expect, it, vi } from "vitest";
import { fakeOpenAi, ISSUER } from "./fixtures/chatgpt-plan-openai.ts";

const HOST = "urn:uuid:3d2c6a1e-7b4f-4c55-9a1e-2f6b8c9d0e1f";
const signal = () => new AbortController().signal;

async function signedIn(openai: ReturnType<typeof fakeOpenAi>, oauth: ChatGptPlanOAuth, subject = "user-abc") {
	const verifier = randomBytes(48).toString("base64url");
	const url = await oauth.authorizationUrl(
		{
			state: `state-${randomBytes(4).toString("hex")}`,
			nonce: "nonce-1",
			codeChallenge: chatGptPlanCodeChallenge(verifier),
			hostId: HOST,
		},
		signal(),
	);
	const { code } = openai.consent(url, { subject });
	return oauth.exchange({ code, codeVerifier: verifier, nonce: "nonce-1", hostId: HOST }, signal());
}

it("reads the operator's client registration and refuses anything else", () => {
	expect(
		parseChatGptPlanClient(
			JSON.stringify({
				schema: "qorpera.chatgpt-plan-client/v1",
				clientId: "oaiapp_qorpera",
				clientSecret: null,
				redirectUri: "https://project.supabase.co/functions/v1/chatgpt-plan-callback",
			}),
		),
	).toEqual({
		clientId: "oaiapp_qorpera",
		clientSecret: null,
		redirectUri: "https://project.supabase.co/functions/v1/chatgpt-plan-callback",
	});
	const base = {
		schema: "qorpera.chatgpt-plan-client/v1",
		clientId: "oaiapp_qorpera",
		clientSecret: "x".repeat(32),
		redirectUri: "https://project.supabase.co/functions/v1/chatgpt-plan-callback",
	};
	for (const bad of [
		{ ...base, redirectUri: "http://project.supabase.co/callback" },
		{ ...base, redirectUri: "https://user:pass@project.supabase.co/callback" },
		{ ...base, clientSecret: "short" },
		{ ...base, extra: true },
		{ ...base, schema: "qorpera.chatgpt-plan-client/v2" },
	])
		expect(() => parseChatGptPlanClient(JSON.stringify(bad))).toThrow();
});

it("builds OpenAI's authorization address from its discovery document, with PKCE, the plan scopes and the host id", async () => {
	const openai = fakeOpenAi();
	const oauth = new ChatGptPlanOAuth({ client: openai.client, fetch: openai.fetch });
	const url = new URL(
		await oauth.authorizationUrl({ state: "s1", nonce: "n1", codeChallenge: "c".repeat(43), hostId: HOST }, signal()),
	);
	expect(url.origin + url.pathname).toBe(`${ISSUER}/api/accounts/authorize`);
	expect(Object.fromEntries(url.searchParams)).toEqual({
		client_id: openai.clientId,
		response_type: "code",
		redirect_uri: openai.redirectUri,
		scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
		resource: "https://api.openai.com/v1",
		state: "s1",
		nonce: "n1",
		code_challenge: "c".repeat(43),
		code_challenge_method: "S256",
		ext_agent_host_id: HOST,
	});
	await expect(
		oauth.authorizationUrl({ state: "s", nonce: "n", codeChallenge: "c", hostId: "member@example.test" }, signal()),
	).rejects.toThrow("host id");
	// The discovery document is read once and kept.
	await oauth.authorizationUrl({ state: "s2", nonce: "n2", codeChallenge: "c".repeat(43), hostId: HOST }, signal());
	expect(openai.requests.filter((request) => request.path === "/.well-known/openid-configuration")).toHaveLength(1);
});

it("refuses a discovery document that points away from OpenAI", async () => {
	const openai = fakeOpenAi();
	const moved = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : input);
		if (url.pathname === "/.well-known/openid-configuration")
			return new Response(
				JSON.stringify({
					issuer: ISSUER,
					authorization_endpoint: "https://evil.example/authorize",
					token_endpoint: `${ISSUER}/api/accounts/oauth/token`,
					revocation_endpoint: `${ISSUER}/api/accounts/oauth/revoke`,
					jwks_uri: `${ISSUER}/.well-known/jwks.json`,
				}),
				{ status: 200 },
			);
		return openai.fetch(input, init);
	}) as typeof fetch;
	const oauth = new ChatGptPlanOAuth({ client: openai.client, fetch: moved });
	await expect(
		oauth.authorizationUrl({ state: "s", nonce: "n", codeChallenge: "c".repeat(43), hostId: HOST }, signal()),
	).rejects.toThrow();
});

it("exchanges a code for a login: verifier, callback address, client secret in the Basic header only, ID token checked", async () => {
	const openai = fakeOpenAi();
	const oauth = new ChatGptPlanOAuth({ client: openai.client, fetch: openai.fetch });
	const login = await signedIn(openai, oauth);
	expect(login.subject).toBe("user-abc");
	expect(login.email).toBe("member@example.test");
	expect(login.hostId).toBe(HOST);
	expect(login.clientId).toBe(openai.clientId);
	expect(login.scopes).toContain("chatgpt.tokens.use.direct");
	expect(Date.parse(login.accessExpiresAt) - Date.parse(login.accessIssuedAt)).toBe(3_600_000);
	expect(login.renewNotBefore).not.toBeNull();
	const exchange = openai.requests.find((request) => request.form.get("grant_type") === "authorization_code");
	expect(exchange?.authorization).toMatch(/^Basic /);
	expect(exchange?.form.get("client_secret")).toBeNull();
	expect(parseChatGptPlanLogin(serializeChatGptPlanLogin(login))).toEqual(login);
});

it("refuses an exchange whose ID token fails a check, or that grants no plan use", async () => {
	const openai = fakeOpenAi();
	const oauth = new ChatGptPlanOAuth({ client: openai.client, fetch: openai.fetch });
	const verifier = randomBytes(48).toString("base64url");
	const url = await oauth.authorizationUrl(
		{ state: "s", nonce: "right-nonce", codeChallenge: chatGptPlanCodeChallenge(verifier), hostId: HOST },
		signal(),
	);
	// The nonce the vault kept differs from the one in the ID token.
	const first = openai.consent(url, { subject: "user-abc" });
	await expect(
		oauth.exchange({ code: first.code, codeVerifier: verifier, nonce: "other-nonce", hostId: HOST }, signal()),
	).rejects.toThrow("ID token");
	// A wrong verifier: OpenAI refuses the code.
	const second = openai.consent(url, { subject: "user-abc" });
	await expect(
		oauth.exchange({ code: second.code, codeVerifier: "wrong", nonce: "right-nonce", hostId: HOST }, signal()),
	).rejects.toThrow();
	// The member declined plan use: a valid sign-in, but no plan scope.
	openai.behaviour.withoutPlanScope = true;
	const third = openai.consent(url, { subject: "user-abc" });
	await expect(
		oauth.exchange({ code: third.code, codeVerifier: verifier, nonce: "right-nonce", hostId: HOST }, signal()),
	).rejects.toThrow("not granted");
	// Both answers OpenAI gave (the wrong nonce, no plan use) are ended at OpenAI, never left live there.
	await vi.waitFor(() => expect(openai.revoked.size).toBe(2));
});

it("loads OpenAI's keys before it spends the one-time code", async () => {
	const openai = fakeOpenAi();
	openai.behaviour.keysStatus = 503;
	const oauth = new ChatGptPlanOAuth({ client: openai.client, fetch: openai.fetch });
	const verifier = randomBytes(48).toString("base64url");
	const url = await oauth.authorizationUrl(
		{ state: "s", nonce: "n", codeChallenge: chatGptPlanCodeChallenge(verifier), hostId: HOST },
		signal(),
	);
	const { code } = openai.consent(url, { subject: "user-abc" });
	await expect(oauth.exchange({ code, codeVerifier: verifier, nonce: "n", hostId: HOST }, signal())).rejects.toThrow();
	expect(openai.requests.filter((request) => request.path === "/api/accounts/oauth/token")).toHaveLength(0);
	// Once the keys are back, the same code still works.
	openai.behaviour.keysStatus = 200;
	await expect(
		new ChatGptPlanOAuth({ client: openai.client, fetch: openai.fetch }).exchange(
			{ code, codeVerifier: verifier, nonce: "n", hostId: HOST },
			signal(),
		),
	).resolves.toMatchObject({ subject: "user-abc" });
});

it("checks the ID token's signature against OpenAI's keys and its audience against this client", async () => {
	const openai = fakeOpenAi();
	let clock = Date.now();
	const oauth = new ChatGptPlanOAuth({ client: openai.client, fetch: openai.fetch, now: () => clock });
	const now = Math.floor(clock / 1000);
	const claims = { iss: ISSUER, aud: openai.clientId, sub: "user-abc", nonce: "n", iat: now, exp: now + 600 };
	await expect(oauth.verifyIdToken(openai.jwt(claims), "n", signal())).resolves.toEqual({
		subject: "user-abc",
		email: null,
	});
	const { privateKey: stranger } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	await expect(oauth.verifyIdToken(openai.jwt(claims, stranger), "n", signal())).rejects.toThrow("signature");
	await expect(oauth.verifyIdToken(openai.jwt({ ...claims, aud: "oaiapp_other" }), "n", signal())).rejects.toThrow();
	await expect(
		oauth.verifyIdToken(openai.jwt({ ...claims, iss: "https://evil.example" }), "n", signal()),
	).rejects.toThrow();
	await expect(oauth.verifyIdToken(openai.jwt({ ...claims, exp: now - 60 }), "n", signal())).rejects.toThrow();
	// Several audiences: only with this client as the authorized party.
	const both = { ...claims, aud: [openai.clientId, "oaiapp_other"] };
	await expect(oauth.verifyIdToken(openai.jwt(both), "n", signal())).rejects.toThrow();
	await expect(
		oauth.verifyIdToken(openai.jwt({ ...both, azp: openai.clientId }), "n", signal()),
	).resolves.toMatchObject({
		subject: "user-abc",
	});
	await expect(oauth.verifyIdToken(openai.jwt({ ...claims, azp: "oaiapp_other" }), "n", signal())).rejects.toThrow();
	const keyFetches = () => openai.requests.filter((request) => request.path === "/.well-known/jwks.json").length;
	// An unknown key id refetches the keys only once a minute has passed since the last fetch.
	const first = keyFetches();
	await expect(oauth.verifyIdToken(openai.jwt(claims, undefined, "key-2"), "n", signal())).rejects.toThrow("unknown");
	expect(keyFetches()).toBe(first);
	clock += 61_000;
	await expect(oauth.verifyIdToken(openai.jwt(claims, undefined, "key-2"), "n", signal())).rejects.toThrow("unknown");
	expect(keyFetches()).toBe(first + 1);
	await expect(oauth.verifyIdToken(openai.jwt(claims, undefined, "key-2"), "n", signal())).rejects.toThrow("unknown");
	expect(keyFetches()).toBe(first + 1);
	// OpenAI adds an EC P-256 key: after the minute, callers at the same moment share one fetch, and ES256
	// tokens verify.
	openai.addKey("key-ec", "ec");
	clock += 61_000;
	const ec = openai.jwt(claims, undefined, "key-ec");
	const [one, two] = await Promise.all([
		oauth.verifyIdToken(ec, "n", signal()),
		oauth.verifyIdToken(ec, "n", signal()),
	]);
	expect(one.subject).toBe("user-abc");
	expect(two.subject).toBe("user-abc");
	expect(keyFetches()).toBe(first + 2);
	// A key published for another algorithm than the token names is refused, and so are a P-384 key and an
	// RSA key under 2048 bits.
	openai.addKey("key-mislabelled", "rsa-mislabelled");
	openai.addKey("key-p384", "ec-p384");
	openai.addKey("key-small", "rsa-1024");
	clock += 61_000;
	for (const kid of ["key-mislabelled", "key-p384", "key-small"])
		await expect(oauth.verifyIdToken(openai.jwt(claims, undefined, kid), "n", signal())).rejects.toThrow("signature");
});

it("shares one key fetch, which a caller whose time ends gives up alone", async () => {
	const openai = fakeOpenAi();
	const oauth = new ChatGptPlanOAuth({ client: openai.client, fetch: openai.fetch });
	const now = Math.floor(Date.now() / 1000);
	const idToken = openai.jwt({
		iss: ISSUER,
		aud: openai.clientId,
		sub: "user-abc",
		nonce: "n",
		iat: now,
		exp: now + 600,
	});
	const [late, waiting] = await Promise.allSettled([
		oauth.verifyIdToken(idToken, "n", AbortSignal.abort()),
		oauth.verifyIdToken(idToken, "n", signal()),
	]);
	expect(late.status).toBe("rejected");
	expect(waiting).toEqual({ status: "fulfilled", value: { subject: "user-abc", email: null } });
	expect(openai.requests.filter((request) => request.path === "/.well-known/jwks.json")).toHaveLength(1);
});

it("renews once per refresh token: a reused or dead token is refused for good, the client's own errors are not", async () => {
	const openai = fakeOpenAi();
	const oauth = new ChatGptPlanOAuth({ client: openai.client, fetch: openai.fetch });
	const login = await signedIn(openai, oauth);
	const renewed = await oauth.refresh(login, signal());
	expect(renewed.outcome).toBe("renewed");
	if (renewed.outcome !== "renewed") return;
	expect(renewed.login.refreshToken).not.toBe(login.refreshToken);
	expect(renewed.login.subject).toBe(login.subject);
	expect(renewed.login.idToken).toBe(login.idToken);
	expect(openai.requests.at(-1)?.form.get("scope")).toBeNull();
	// The spent token again: OpenAI says reused; the member signs in again.
	expect(await oauth.refresh(login, signal())).toEqual({ outcome: "refused", reason: "refresh_refused" });
	openai.behaviour.tokenAnswer = { status: 401, body: { error: "invalid_client" } };
	expect(await oauth.refresh(renewed.login, signal())).toEqual({ outcome: "transient", reason: "client_refused" });
	openai.behaviour.tokenAnswer = { status: 503, body: { error: "temporarily_unavailable" } };
	expect(await oauth.refresh(renewed.login, signal())).toEqual({
		outcome: "transient",
		reason: "provider_unavailable",
	});
	// Plan use withdrawn in ChatGPT's settings: the login serves nobody any longer.
	openai.behaviour.withoutPlanScope = true;
	const revokedBefore = openai.revoked.size;
	expect(await oauth.refresh(renewed.login, signal())).toEqual({ outcome: "refused", reason: "plan_withdrawn" });
	await vi.waitFor(() => expect(openai.revoked.size).toBe(revokedBefore + 1));
	// Another registration's login is never renewed with this client.
	expect(await oauth.refresh({ ...login, clientId: "oaiapp_other" }, signal())).toEqual({
		outcome: "transient",
		reason: "client_changed",
	});
});

it("never spends the refresh token for a reason that passes: OpenAI's keys are loaded first", async () => {
	const openai = fakeOpenAi();
	const login = await signedIn(openai, new ChatGptPlanOAuth({ client: openai.client, fetch: openai.fetch }));
	// A vault that just started has no keys yet; OpenAI's keys are unreachable.
	openai.behaviour.keysStatus = 503;
	const fresh = new ChatGptPlanOAuth({ client: openai.client, fetch: openai.fetch });
	expect(await fresh.refresh(login, signal())).toEqual({ outcome: "transient", reason: "provider_unreachable" });
	expect(openai.spent.has(login.refreshToken)).toBe(false);
});

it("after OpenAI spent the refresh token, keeps or ends the login but never leaves it to a retry", async () => {
	const openai = fakeOpenAi();
	const oauth = new ChatGptPlanOAuth({ client: openai.client, fetch: openai.fetch });
	const login = await signedIn(openai, oauth);
	// An ID token on the renewal, signed with a key the vault cannot fetch yet: the renewal is kept with the
	// stored ID token (the access token still names the owner).
	openai.behaviour.idTokenOnRefresh = { kid: "key-later" };
	const kept = await oauth.refresh(login, signal());
	expect(kept.outcome).toBe("renewed");
	if (kept.outcome !== "renewed") return;
	expect(kept.login.idToken).toBe(login.idToken);
	// A verifiable ID token replaces the stored one.
	openai.behaviour.idTokenOnRefresh = { kid: "key-1" };
	const replaced = await oauth.refresh(kept.login, signal());
	expect(replaced.outcome).toBe("renewed");
	if (replaced.outcome !== "renewed") return;
	expect(replaced.login.idToken).not.toBe(login.idToken);
	expect(replaced.login.email).toBe("renewed@example.test");
	// An answer without `scope` keeps the access token's own scopes (RFC 6749 6).
	openai.behaviour.idTokenOnRefresh = undefined;
	openai.behaviour.omitScopeOnRefresh = true;
	const unscoped = await oauth.refresh(replaced.login, signal());
	expect(unscoped.outcome).toBe("renewed");
	if (unscoped.outcome !== "renewed") return;
	expect(unscoped.login.scopes).toContain("chatgpt.tokens.use.direct");
	openai.behaviour.omitScopeOnRefresh = false;
	// An ID token naming someone else: the login ends, and the new refresh token is ended at OpenAI.
	openai.behaviour.idTokenOnRefresh = { kid: "key-1", subject: "user-other" };
	const revokedBefore = openai.revoked.size;
	expect(await oauth.refresh(unscoped.login, signal())).toEqual({
		outcome: "refused",
		reason: "renewal_owner_differs",
	});
	await vi.waitFor(() => expect(openai.revoked.size).toBe(revokedBefore + 1));
});

it("refuses a renewal answer it cannot read, keeps the old refresh token when OpenAI sends none, and keeps the login's scopes when neither the answer nor the token names them", async () => {
	const openai = fakeOpenAi();
	const oauth = new ChatGptPlanOAuth({ client: openai.client, fetch: openai.fetch });
	const login = await signedIn(openai, oauth);
	// A 200 that is not JSON: OpenAI may have spent the token, and the replacement is unreadable.
	openai.behaviour.tokenAnswer = { status: 200, body: undefined };
	expect(await oauth.refresh(login, signal())).toEqual({ outcome: "refused", reason: "renewal_invalid" });
	// No new refresh token (RFC 6749 6): the old one stays the login's.
	openai.behaviour.omitRefreshTokenOnRefresh = true;
	const kept = await oauth.refresh(login, signal());
	expect(kept.outcome).toBe("renewed");
	if (kept.outcome !== "renewed") return;
	expect(kept.login.refreshToken).toBe(login.refreshToken);
	expect(kept.login.accessToken).not.toBe(login.accessToken);
	openai.behaviour.omitRefreshTokenOnRefresh = false;
	// Neither `scope` in the answer nor a `scope` claim: the login's earlier scopes.
	openai.behaviour.omitScopeOnRefresh = true;
	openai.behaviour.omitScopeClaim = true;
	const scoped = await oauth.refresh(kept.login, signal());
	expect(scoped.outcome).toBe("renewed");
	if (scoped.outcome !== "renewed") return;
	expect(scoped.login.scopes).toEqual(login.scopes);
});

it("keeps OpenAI's earliest renewal only within the pass, in seconds or milliseconds", async () => {
	const openai = fakeOpenAi();
	const oauth = new ChatGptPlanOAuth({ client: openai.client, fetch: openai.fetch });
	let login = await signedIn(openai, oauth);
	const renew = async (earliest: number | string | undefined) => {
		openai.behaviour.earliestRefreshAt = earliest;
		const result = await oauth.refresh(login, signal());
		if (result.outcome !== "renewed") throw new Error(`renewal ${result.outcome}`);
		login = result.login;
		return login.renewNotBefore;
	};
	const inTenMinutes = Date.now() + 10 * 60_000;
	expect(Date.parse((await renew(Math.floor(inTenMinutes / 1000))) ?? "")).toBeCloseTo(inTenMinutes, -4);
	expect(Date.parse((await renew(inTenMinutes)) ?? "")).toBeCloseTo(inTenMinutes, -4);
	expect(Date.parse((await renew(new Date(inTenMinutes).toISOString())) ?? "")).toBeCloseTo(inTenMinutes, -4);
	// After the pass ends, or a day ahead: a renewal must stay possible, so the time is not kept.
	expect(await renew(Math.floor(Date.now() / 1000) + 2 * 3600)).toBeNull();
	expect(await renew(Date.now() + 40 * 24 * 3600_000)).toBeNull();
	expect(await renew("tomorrow")).toBeNull();
});

it("encodes the client in the Basic header as OAuth asks, whatever characters the secret holds", async () => {
	const openai = fakeOpenAi({ clientSecret: "p!a'(s)s~w*o+r/d=&%x" });
	const login = await signedIn(openai, new ChatGptPlanOAuth({ client: openai.client, fetch: openai.fetch }));
	expect(login.subject).toBe("user-abc");
});

it("ends a session at OpenAI, and counts a token OpenAI no longer knows as ended", async () => {
	const openai = fakeOpenAi({ clientSecret: null });
	const oauth = new ChatGptPlanOAuth({ client: openai.client, fetch: openai.fetch });
	const login = await signedIn(openai, oauth);
	expect(await oauth.revoke(login.refreshToken, signal())).toBe("revoked");
	expect(openai.revoked.has(login.refreshToken)).toBe(true);
	const revocation = openai.requests.find((request) => request.path === "/api/accounts/oauth/revoke");
	expect(Object.fromEntries(revocation?.form ?? [])).toEqual({
		token: login.refreshToken,
		token_type_hint: "refresh_token",
		client_id: openai.clientId,
	});
	// A public client sends no Authorization header at all.
	expect(revocation?.authorization).toBeNull();
	openai.behaviour.revocationStatus = 503;
	expect(await oauth.revoke("rt_other", signal())).toBe("transient");
});

it("keeps a sealed login to exactly its fields", () => {
	const login = {
		clientId: "oaiapp_qorpera",
		subject: "user-abc",
		email: null,
		hostId: HOST,
		idToken: null,
		accessToken: "a".repeat(40),
		refreshToken: "r".repeat(40),
		scopes: ["chatgpt.tokens.use.direct"],
		accessIssuedAt: "2026-10-01T00:00:00.000Z",
		accessExpiresAt: "2026-10-01T01:00:00.000Z",
		renewNotBefore: null,
	};
	const text = serializeChatGptPlanLogin(login);
	expect(parseChatGptPlanLogin(text)).toEqual(login);
	const record = JSON.parse(text) as Record<string, unknown>;
	expect(() => parseChatGptPlanLogin(JSON.stringify({ ...record, agentIdentity: "x" }))).toThrow();
	expect(() => parseChatGptPlanLogin(JSON.stringify({ ...record, hostId: "laptop-1" }))).toThrow();
	expect(() =>
		parseChatGptPlanLogin(JSON.stringify({ ...record, accessExpiresAt: "2026-09-30T00:00:00.000Z" })),
	).toThrow();
	expect(createHash("sha256").update("v").digest("base64url")).toBe(chatGptPlanCodeChallenge("v"));
});
