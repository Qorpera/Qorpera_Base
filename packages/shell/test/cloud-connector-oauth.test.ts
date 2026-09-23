import { randomBytes, randomUUID } from "node:crypto";
import {
	CLOUD_CONNECTOR_OAUTH_STATE,
	CloudConnectorOAuthError,
	CloudConnectorOAuthFlows,
	connectorReturnLocation,
	parseConnectorReturnUrl,
} from "@qorpera/runtime/cloud-connector-oauth";
import {
	composeCloudConnectorService,
	parseCloudConnectorServiceConfig,
} from "@qorpera/runtime/cloud-connector-service";
import { expect, it, vi } from "vitest";

const google = { clientId: "g.apps.googleusercontent.com", clientSecret: `GOCSPX-${randomBytes(8).toString("hex")}` };
const github = { clientId: "Iv1.abcdefabcdef", clientSecret: randomBytes(20).toString("hex") };
const callbackUrl = "https://secrets.qorpera.test/v1/oauth/callback";
const returnOrigins = ["https://app.qorpera.test"];
const companyId = "a5a5a5a5-0000-4000-8000-00000000c041";
const otherCompanyId = "b6b6b6b6-0000-4000-8000-00000000c042";
const signal = new AbortController().signal;

function flows(fetchImplementation: typeof fetch = vi.fn<typeof fetch>(), now = () => 1_000_000) {
	return new CloudConnectorOAuthFlows({
		clients: { google, github },
		callbackUrl,
		returnOrigins,
		fetch: fetchImplementation,
		now,
	});
}

function begin(oauth: CloudConnectorOAuthFlows, connectorId = "gmail", company = companyId) {
	const ticketId = randomUUID();
	const captureCapability = randomBytes(32).toString("base64url");
	const started = oauth.begin({
		ticketId,
		captureCapability,
		companyId: company,
		connectorId,
		returnTo: "https://app.qorpera.test/#/c/x",
	});
	const url = new URL(started.authorizationUrl);
	return { ticketId, captureCapability, started, url, state: url.searchParams.get("state") ?? "" };
}

it("builds a Google consent URL with offline access, PKCE and the connector's scopes", () => {
	const { url, state } = begin(flows());
	expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
	expect(url.searchParams.get("client_id")).toBe(google.clientId);
	expect(url.searchParams.get("redirect_uri")).toBe(callbackUrl);
	expect(url.searchParams.get("access_type")).toBe("offline");
	expect(url.searchParams.get("prompt")).toBe("consent");
	expect(url.searchParams.get("code_challenge_method")).toBe("S256");
	expect(url.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/gmail.send");
	// The state starts with the company so the shared public origin can route
	// the provider's callback to this company's broker; the rest is random.
	expect(state).toMatch(new RegExp(`^${companyId}\\.[A-Za-z0-9_-]{43}$`));
	expect(CLOUD_CONNECTOR_OAUTH_STATE.exec(state)?.[1]).toBe(companyId);
	expect(url.href).not.toContain(google.clientSecret);
});

it("keeps the random part of the state unguessable and bound to the company it was issued for", async () => {
	const oauth = flows(vi.fn<typeof fetch>());
	const first = begin(oauth);
	const second = begin(oauth);
	const random = (state: string) => state.slice(companyId.length + 1);
	expect(random(first.state)).not.toBe(random(second.state));
	expect(random(first.state)).toHaveLength(43);
	// The same random part under another company's prefix is not a state this
	// broker issued; neither is the bare random part or an upper-cased prefix.
	for (const forged of [
		`${otherCompanyId}.${random(first.state)}`,
		random(first.state),
		`${companyId.toUpperCase()}.${random(first.state)}`,
		`${companyId}.${random(first.state)}x`,
	]) {
		await expect(oauth.complete({ state: forged, code: "x" }, signal)).rejects.toMatchObject({
			reason: "state_unknown",
		});
	}
	// A company id normalizes to lower case in the state.
	const upper = begin(oauth, "gmail", otherCompanyId.toUpperCase());
	expect(upper.state.startsWith(`${otherCompanyId}.`)).toBe(true);
	expect(() =>
		oauth.begin({
			ticketId: randomUUID(),
			captureCapability: "c".repeat(43),
			companyId: "not-a-company",
			connectorId: "gmail",
			returnTo: "https://app.qorpera.test/",
		}),
	).toThrow("invalid");
});

it("completes a Google callback into a refresh-token field and an account label, once", async () => {
	const code = "4/0AbCdEf";
	const fetchImplementation = vi.fn<typeof fetch>(async (target, init) => {
		const url = new URL(String(target));
		if (url.href === "https://oauth2.googleapis.com/token") {
			const body = new URLSearchParams(String(init?.body));
			expect(body.get("code")).toBe(code);
			expect(body.get("redirect_uri")).toBe(callbackUrl);
			expect(body.get("client_secret")).toBe(google.clientSecret);
			expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
			return Response.json({
				access_token: "ya29.access-token-value-1234567890",
				refresh_token: "1//refresh-token-value-1234567890",
				expires_in: 3599,
			});
		}
		if (url.href === "https://openidconnect.googleapis.com/v1/userinfo") {
			expect((init?.headers as Record<string, string>).authorization).toBe(
				"Bearer ya29.access-token-value-1234567890",
			);
			return Response.json({ sub: "1", email: "anna@example.com", email_verified: true });
		}
		throw new Error(`unexpected ${url.href}`);
	});
	const oauth = flows(fetchImplementation);
	const { ticketId, captureCapability, state } = begin(oauth);
	const completion = await oauth.complete({ state, code }, signal);
	expect(completion).toEqual({
		ticketId,
		captureCapability,
		companyId,
		connectorId: "gmail",
		returnTo: "https://app.qorpera.test/#/c/x",
		fields: { refresh_token: "1//refresh-token-value-1234567890" },
		accountLabel: "anna@example.com",
	});
	// A replayed callback finds no pending state.
	await expect(oauth.complete({ state, code }, signal)).rejects.toMatchObject({ reason: "state_unknown" });
});

it("keeps the GitHub access token, labels by login, and sends no PKCE", async () => {
	const fetchImplementation = vi.fn<typeof fetch>(async (target) => {
		const url = new URL(String(target));
		if (url.href === "https://github.com/login/oauth/access_token")
			return Response.json({ access_token: `gho_${"a".repeat(36)}`, token_type: "bearer", scope: "repo" });
		if (url.href === "https://api.github.com/user") return Response.json({ login: "octocat", id: 1 });
		throw new Error(`unexpected ${url.href}`);
	});
	const oauth = flows(fetchImplementation);
	const { url, state } = begin(oauth, "github");
	expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
	expect(url.searchParams.has("code_challenge")).toBe(false);
	expect(url.searchParams.get("scope")).toBe("repo read:user user:email");
	await expect(oauth.complete({ state, code: "abc123" }, signal)).resolves.toMatchObject({
		connectorId: "github",
		fields: { access_token: `gho_${"a".repeat(36)}` },
		accountLabel: "octocat",
	});
});

it("reports declined, expired, missing-refresh-token and unknown-state outcomes with the return page", async () => {
	let clock = 1_000_000;
	const fetchImplementation = vi.fn<typeof fetch>(async () =>
		Response.json({ access_token: "ya29.access-token-value-1234567890", expires_in: 3599 }),
	);
	const oauth = flows(fetchImplementation, () => clock);
	const declined = begin(oauth);
	await expect(oauth.complete({ state: declined.state, error: "access_denied" }, signal)).rejects.toMatchObject({
		reason: "declined",
		returnTo: "https://app.qorpera.test/#/c/x",
		connectorId: "gmail",
	});
	const noRefresh = begin(oauth);
	await expect(oauth.complete({ state: noRefresh.state, code: "x" }, signal)).rejects.toMatchObject({
		reason: "no_refresh_token",
	});
	const late = begin(oauth);
	clock += 11 * 60_000;
	await expect(oauth.complete({ state: late.state, code: "x" }, signal)).rejects.toMatchObject({ reason: "expired" });
	const unknown = await oauth
		.complete({ state: `${companyId}.${randomBytes(32).toString("base64url")}`, code: "x" }, signal)
		.catch((error) => error);
	expect(unknown).toBeInstanceOf(CloudConnectorOAuthError);
	expect(unknown.reason).toBe("state_unknown");
	expect(unknown.returnTo).toBeUndefined();
});

it("accepts return pages only on allow-listed origins and places the outcome in the fragment", () => {
	expect(parseConnectorReturnUrl("https://app.qorpera.test/#/c/1", returnOrigins)).toBe(
		"https://app.qorpera.test/#/c/1",
	);
	expect(() => parseConnectorReturnUrl("https://evil.example/#/c/1", returnOrigins)).toThrow("invalid");
	expect(() => parseConnectorReturnUrl("https://app.qorpera.test.evil/", returnOrigins)).toThrow("invalid");
	expect(() => parseConnectorReturnUrl("javascript:alert(1)", returnOrigins)).toThrow("invalid");
	expect(connectorReturnLocation("https://app.qorpera.test/#/c/1", "gmail", "connected")).toBe(
		"https://app.qorpera.test/#/c/1?connector=gmail&connection=connected",
	);
	expect(connectorReturnLocation("https://app.qorpera.test/", "github", "failed", "declined")).toBe(
		"https://app.qorpera.test/#?connector=github&connection=failed&reason=declined",
	);
	expect(() =>
		flows().begin({
			ticketId: randomUUID(),
			captureCapability: "c".repeat(43),
			companyId,
			connectorId: "gmail",
			returnTo: "https://evil.example/",
		}),
	).toThrow("invalid");
	expect(() =>
		flows().begin({
			ticketId: randomUUID(),
			captureCapability: "c".repeat(43),
			companyId,
			connectorId: "slack",
			returnTo: "https://app.qorpera.test/",
		}),
	).toThrow("unknown");
});

it("composes the broker's connector service from one credential and refuses incomplete ones", () => {
	const config = parseCloudConnectorServiceConfig(
		JSON.stringify({
			schema: "qorpera.cloud-connector-service/v1",
			publicOrigin: "https://secrets.qorpera.test",
			google,
		}),
	);
	// Sign-ins return only to the broker's own member origins (config v2).
	const service = composeCloudConnectorService(config, ["https://app.qorpera.test"], vi.fn<typeof fetch>());
	expect(service.connectors).toEqual(["gmail", "google_drive"]);
	expect(service.adapters.map((adapter) => adapter.connectorId)).toEqual([
		...Array(4).fill("gmail"),
		...Array(4).fill("google_drive"),
	]);
	expect(service.oauth.available()).toEqual(["gmail", "google_drive"]);
	expect(() => composeCloudConnectorService(config, [], vi.fn<typeof fetch>())).toThrow("return origins");
	expect(() =>
		parseCloudConnectorServiceConfig(
			JSON.stringify({
				schema: "qorpera.cloud-connector-service/v1",
				publicOrigin: "https://s.test",
			}),
		),
	).toThrow("no OAuth client");
	expect(() =>
		parseCloudConnectorServiceConfig(
			JSON.stringify({
				schema: "qorpera.cloud-connector-service/v1",
				publicOrigin: "http://s.test",
				github,
			}),
		),
	).toThrow("public origin");
	// The return list moved to the broker's memberOrigins; a stray key is refused.
	expect(() =>
		parseCloudConnectorServiceConfig(
			JSON.stringify({
				schema: "qorpera.cloud-connector-service/v1",
				publicOrigin: "https://s.test",
				returnOrigins: ["https://a.test"],
				github,
			}),
		),
	).toThrow("invalid");
});
