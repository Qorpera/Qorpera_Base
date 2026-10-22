import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DigitalPostClient } from "@qorpera/runtime/cloud-connector-digital-post";
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

const proofHash = (proof: string) => createHash("sha256").update(proof).digest("hex");

function begin(oauth: CloudConnectorOAuthFlows, connectorId = "gmail", company = companyId) {
	const ticketId = randomUUID();
	const captureCapability = randomBytes(32).toString("base64url");
	// The starting browser keeps the proof; the broker only ever sees its hash
	// until the confirm step.
	const browserProof = randomBytes(32).toString("base64url");
	const started = oauth.begin({
		ticketId,
		captureCapability,
		companyId: company,
		connectorId,
		returnTo: "https://app.qorpera.test/#/c/x",
		browserProofSha256: proofHash(browserProof),
	});
	const url = new URL(started.authorizationUrl);
	return { ticketId, captureCapability, browserProof, started, url, state: url.searchParams.get("state") ?? "" };
}

/** The provider's callback, then the starting browser's confirmation. */
async function complete(
	oauth: CloudConnectorOAuthFlows,
	flow: { ticketId: string; browserProof: string },
	query: { state?: string; code?: string; error?: string },
) {
	const receipt = oauth.receive(query);
	return oauth.confirm(
		{ ticketId: flow.ticketId, confirmation: receipt.confirmation, browserProof: flow.browserProof },
		signal,
	);
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
	expect(url.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/gmail.compose");
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
		expect(() => oauth.receive({ state: forged, code: "x" })).toThrow(
			expect.objectContaining({ reason: "state_unknown" }),
		);
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
			browserProofSha256: "a".repeat(64),
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
	const flow = begin(oauth);
	const { ticketId, captureCapability, state } = flow;
	const receipt = oauth.receive({ state, code });
	expect(receipt).toMatchObject({ connectorId: "gmail", returnTo: "https://app.qorpera.test/#/c/x" });
	expect(receipt.confirmation).toMatch(/^[A-Za-z0-9_-]{43}$/);
	// Nothing is exchanged at the callback.
	expect(fetchImplementation).not.toHaveBeenCalled();
	const completion = await oauth.confirm(
		{ ticketId, confirmation: receipt.confirmation, browserProof: flow.browserProof },
		signal,
	);
	expect(completion).toEqual({
		ticketId,
		captureCapability,
		companyId,
		connectorId: "gmail",
		returnTo: "https://app.qorpera.test/#/c/x",
		fields: { refresh_token: "1//refresh-token-value-1234567890" },
		accountLabel: "anna@example.com",
	});
	// A replayed callback finds no pending state; a replayed confirmation finds nothing parked.
	expect(() => oauth.receive({ state, code })).toThrow(expect.objectContaining({ reason: "state_unknown" }));
	await expect(
		oauth.confirm({ ticketId, confirmation: receipt.confirmation, browserProof: flow.browserProof }, signal),
	).rejects.toMatchObject({ reason: "state_unknown" });
});

it("binds the sign-in to the browser that started it: a consent link finished elsewhere seals nothing", async () => {
	const fetchImplementation = vi.fn<typeof fetch>(async () =>
		Response.json({
			access_token: "ya29.access-token-value-1234567890",
			refresh_token: "1//refresh-value-123456789",
		}),
	);
	const oauth = flows(fetchImplementation);
	// The attacker company's admin starts a sign-in and sends the consent link on.
	const flow = begin(oauth);
	// The victim consents; the callback parks the code and sends the victim's
	// browser to the app with a confirmation id, but that browser has no proof.
	const receipt = oauth.receive({ state: flow.state, code: "victim-code" });
	for (const browserProof of [randomBytes(32).toString("base64url"), ""]) {
		const attempt = await oauth
			.confirm({ ticketId: flow.ticketId, confirmation: receipt.confirmation, browserProof }, signal)
			.catch((error) => error);
		expect(attempt).toBeInstanceOf(CloudConnectorOAuthError);
		expect(["browser_mismatch", "state_unknown"]).toContain(attempt.reason);
	}
	// One attempt per confirmation id: the starter, who holds the proof but never
	// saw the confirmation id, cannot finish it afterwards either.
	await expect(
		oauth.confirm(
			{ ticketId: flow.ticketId, confirmation: receipt.confirmation, browserProof: flow.browserProof },
			signal,
		),
	).rejects.toMatchObject({ reason: "state_unknown" });
	// Nothing was ever exchanged with the provider.
	expect(fetchImplementation).not.toHaveBeenCalled();
	// A confirmation for another ticket is refused too.
	const other = begin(oauth);
	const otherReceipt = oauth.receive({ state: other.state, code: "c" });
	await expect(
		oauth.confirm(
			{ ticketId: randomUUID(), confirmation: otherReceipt.confirmation, browserProof: other.browserProof },
			signal,
		),
	).rejects.toMatchObject({ reason: "state_unknown" });
	// The wrong ticket burned the confirmation: the right ticket cannot use it now.
	await expect(
		oauth.confirm(
			{ ticketId: other.ticketId, confirmation: otherReceipt.confirmation, browserProof: other.browserProof },
			signal,
		),
	).rejects.toMatchObject({ reason: "state_unknown" });
	expect(() =>
		oauth.begin({
			ticketId: randomUUID(),
			captureCapability: "c".repeat(43),
			companyId,
			connectorId: "gmail",
			returnTo: "https://app.qorpera.test/",
			browserProofSha256: "not-a-hash",
		}),
	).toThrow("invalid");
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
	const flow = begin(oauth, "github");
	const { url, state } = flow;
	expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
	expect(url.searchParams.has("code_challenge")).toBe(false);
	expect(url.searchParams.get("scope")).toBe("repo read:user user:email");
	await expect(complete(oauth, flow, { state, code: "abc123" })).resolves.toMatchObject({
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
	expect(() => oauth.receive({ state: declined.state, error: "access_denied" })).toThrow(
		expect.objectContaining({ reason: "declined", returnTo: "https://app.qorpera.test/#/c/x", connectorId: "gmail" }),
	);
	const noRefresh = begin(oauth);
	await expect(complete(oauth, noRefresh, { state: noRefresh.state, code: "x" })).rejects.toMatchObject({
		reason: "no_refresh_token",
	});
	const late = begin(oauth);
	clock += 11 * 60_000;
	expect(() => oauth.receive({ state: late.state, code: "x" })).toThrow(
		expect.objectContaining({ reason: "expired" }),
	);
	// A parked confirmation also expires.
	const slow = begin(oauth);
	const parked = oauth.receive({ state: slow.state, code: "x" });
	clock += 6 * 60_000;
	await expect(
		oauth.confirm(
			{ ticketId: slow.ticketId, confirmation: parked.confirmation, browserProof: slow.browserProof },
			signal,
		),
	).rejects.toMatchObject({ reason: "expired" });
	const unknown = await Promise.resolve()
		.then(() => oauth.receive({ state: `${companyId}.${randomBytes(32).toString("base64url")}`, code: "x" }))
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
	// Only the app's root page: another path or a query would leave the
	// confirmation id visible on a page the app does not load.
	expect(() => parseConnectorReturnUrl("https://app.qorpera.test/other/#/c/1", returnOrigins)).toThrow("invalid");
	expect(() => parseConnectorReturnUrl("https://app.qorpera.test/?next=x#/c/1", returnOrigins)).toThrow("invalid");
	expect(
		connectorReturnLocation("https://app.qorpera.test/#/c/1", "gmail", "confirm", { confirmation: "c".repeat(43) }),
	).toBe(`https://app.qorpera.test/#/c/1?connector=gmail&connection=confirm&confirmation=${"c".repeat(43)}`);
	expect(connectorReturnLocation("https://app.qorpera.test/", "github", "failed", { reason: "declined" })).toBe(
		"https://app.qorpera.test/#?connector=github&connection=failed&reason=declined",
	);
	expect(() =>
		flows().begin({
			ticketId: randomUUID(),
			captureCapability: "c".repeat(43),
			companyId,
			connectorId: "gmail",
			returnTo: "https://evil.example/",
			browserProofSha256: "a".repeat(64),
		}),
	).toThrow("invalid");
	expect(() =>
		flows().begin({
			ticketId: randomUUID(),
			captureCapability: "c".repeat(43),
			companyId,
			connectorId: "slack",
			returnTo: "https://app.qorpera.test/",
			browserProofSha256: "a".repeat(64),
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
	expect(service.adapters.map((adapter) => `${adapter.connectorId}:${adapter.operationId}`).sort()).toEqual([
		"gmail:create_draft",
		"gmail:delete_draft",
		"gmail:get_profile",
		"gmail:read_message",
		"gmail:read_thread",
		"gmail:search_messages",
		"gmail:send_draft",
		"gmail:send_message",
		"gmail:update_draft",
		"google_drive:create_file",
		"google_drive:read_file",
		"google_drive:search_files",
		"google_drive:update_file",
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

it("takes Qorpera's Digital Post certificate, alone or beside the OAuth clients, and refuses one without its key", () => {
	const dir = mkdtempSync(join(tmpdir(), "qorpera-connector-config-"));
	try {
		execFileSync("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", join(dir, "k")], {
			stdio: "ignore",
		});
		execFileSync(
			"openssl",
			["req", "-new", "-x509", "-key", join(dir, "k"), "-out", join(dir, "c"), "-days", "2", "-subj", "/CN=oces"],
			{
				stdio: "ignore",
			},
		);
		const digitalPost = {
			environment: "test",
			certificatePem: readFileSync(join(dir, "c"), "utf8"),
			privateKeyPem: readFileSync(join(dir, "k"), "utf8"),
		};
		const alone = parseCloudConnectorServiceConfig(
			JSON.stringify({ schema: "qorpera.cloud-connector-service/v1", publicOrigin: "https://s.test", digitalPost }),
		);
		expect(alone.digitalPost).toEqual(digitalPost);
		const service = composeCloudConnectorService(alone, ["https://app.qorpera.test"], vi.fn<typeof fetch>());
		expect(service.connectors).toEqual(["digital_post"]);
		expect(service.digitalPost).toBeInstanceOf(DigitalPostClient);
		expect(service.adapters).toEqual([]);
		const beside = composeCloudConnectorService(
			parseCloudConnectorServiceConfig(
				JSON.stringify({
					schema: "qorpera.cloud-connector-service/v1",
					publicOrigin: "https://s.test",
					github,
					digitalPost,
				}),
			),
			["https://app.qorpera.test"],
			vi.fn<typeof fetch>(),
		);
		expect(beside.connectors).toEqual(["github", "digital_post"]);
		expect(() =>
			parseCloudConnectorServiceConfig(
				JSON.stringify({
					schema: "qorpera.cloud-connector-service/v1",
					publicOrigin: "https://s.test",
					digitalPost: {
						...digitalPost,
						privateKeyPem: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----",
					},
				}),
			),
		).toThrow("Digital Post certificate is invalid");
		const withoutCertificate = composeCloudConnectorService(
			parseCloudConnectorServiceConfig(
				JSON.stringify({ schema: "qorpera.cloud-connector-service/v1", publicOrigin: "https://s.test", github }),
			),
			["https://app.qorpera.test"],
			vi.fn<typeof fetch>(),
		);
		expect(withoutCertificate.digitalPost).toBeUndefined();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("gives each company its own share of the pending sign-ins, and a shared vault's confirm only its own flows", async () => {
	const fetchImplementation = vi.fn<typeof fetch>();
	const oauth = flows(fetchImplementation);
	// Half the share back from the provider (parked for the browser's confirm), half still started.
	for (let started = 0; started < 16; started += 1) {
		const flow = begin(oauth);
		oauth.receive({ state: flow.state, code: "4/0AbCdEf" });
	}
	for (let started = 0; started < 16; started += 1) begin(oauth);
	// One company's admin cannot hold every slot at either stage: the next start for it is busy, another
	// company's is not.
	expect(() => begin(oauth)).toThrow("Connector OAuth is busy");
	const other = begin(oauth, "gmail", otherCompanyId);
	// A confirm routed to another company is refused before anything is exchanged.
	const receipt = oauth.receive({ state: other.state, code: "4/0AbCdEf" });
	await expect(
		oauth.confirm(
			{
				ticketId: other.ticketId,
				confirmation: receipt.confirmation,
				browserProof: other.browserProof,
				companyId,
			},
			signal,
		),
	).rejects.toMatchObject({ reason: "state_unknown" });
	expect(fetchImplementation).not.toHaveBeenCalled();
});
