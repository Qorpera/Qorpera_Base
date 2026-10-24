import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { EnableBankingClient } from "@qorpera/runtime/cloud-connector-enable-banking";
import { CloudConnectorOAuthFlows } from "@qorpera/runtime/cloud-connector-oauth";
import {
	composeCloudConnectorService,
	parseCloudConnectorServiceConfig,
} from "@qorpera/runtime/cloud-connector-service";
import {
	CloudSecretBroker,
	type CloudSecretBrokerAuthority,
	type CloudSecretCaptureDescription,
} from "@qorpera/runtime/cloud-secret-broker";
import { HttpCloudSecretBrokerService } from "@qorpera/runtime/cloud-secret-broker-http";
import { CloudSecretKeyring } from "@qorpera/runtime/cloud-secret-crypto";
import { afterEach, expect, it, vi } from "vitest";

/** The company bank connection's sign-in (Bank interface part 2): the start asks Enable Banking for the
 * bank's own sign-in page, the bank's code comes back through the shared callback, and the confirm turns it
 * into a session that the vault seals with the accounts the member shared. */

const WEB = "https://app.qorpera.test";
const CALLBACK = "https://secrets.qorpera.test/v1/oauth/callback";
const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const applicationId = "1c5dff8a-a15b-4987-b1d7-8457d0653e03";
const privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
	type: "pkcs8",
	format: "pem",
}) as string;
const signal = new AbortController().signal;
const proofHash = (proof: string) => createHash("sha256").update(proof).digest("hex");

const services: HttpCloudSecretBrokerService[] = [];
afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
});

/** Enable Banking as the vault sees it: one Danish bank, its sign-in page, and a session with one account. */
function enableBanking(options: { accounts?: unknown[] } = {}) {
	const calls: { method: string; path: string; body: unknown; authorization: string | null }[] = [];
	const fetchImplementation = vi.fn<typeof fetch>(async (target, init) => {
		const url = new URL(String(target));
		const body = typeof init?.body === "string" || init?.body instanceof Uint8Array ? init.body : undefined;
		calls.push({
			method: init?.method ?? "GET",
			path: url.pathname + url.search,
			body: body ? JSON.parse(Buffer.from(body).toString("utf8")) : undefined,
			authorization: new Headers(init?.headers).get("authorization"),
		});
		if (url.origin !== "https://api.enablebanking.com") throw new Error(`unexpected ${url.href}`);
		if (url.pathname === "/aspsps")
			return Response.json({
				aspsps: [
					{ name: "Danske Bank", country: "DK", maximum_consent_validity: 90 * 86400 },
					{ name: "Nordea", country: "DK" },
				],
			});
		if (url.pathname === "/auth")
			return Response.json({
				url: "https://tilisy.enablebanking.com/ais/start?sessionid=abc",
				authorization_id: "auth-1",
			});
		if (url.pathname.startsWith("/sessions/") && init?.method === "DELETE") return Response.json({});
		if (url.pathname === "/sessions")
			return Response.json({
				session_id: "session-7f3e",
				accounts: options.accounts ?? [
					{
						uid: "uid-1",
						identification_hash: "hash-1",
						name: "Erhvervskonto",
						currency: "DKK",
						account_id: { iban: "DK5000400440116243" },
					},
				],
				access: { valid_until: "2027-01-19T11:59:00.000000+00:00" },
				aspsp: { name: "Danske Bank", country: "DK" },
			});
		throw new Error(`unexpected ${url.href}`);
	});
	const client = new EnableBankingClient({ applicationId, privateKeyPem }, fetchImplementation, () => new Date(NOW));
	return { client, calls, fetchImplementation };
}

function flows(bank = enableBanking(), now = () => NOW) {
	return new CloudConnectorOAuthFlows({
		clients: {},
		callbackUrl: CALLBACK,
		returnOrigins: [WEB],
		now,
		bank: bank.client,
	});
}

function bankStart(companyId = randomUUID(), ticketMinutes = 30) {
	const browserProof = randomBytes(32).toString("base64url");
	return {
		browserProof,
		input: {
			ticketId: randomUUID(),
			captureCapability: randomBytes(32).toString("base64url"),
			companyId,
			connectorId: "bank",
			returnTo: `${WEB}/#/settings`,
			browserProofSha256: proofHash(browserProof),
			bank: { name: "Danske Bank", country: "DK", psuType: "business" as const },
			ticketExpiresAt: new Date(NOW + ticketMinutes * 60_000).toISOString(),
		},
	};
}

it("starts a bank sign-in at Enable Banking with the shared callback, a company-routed state and the bank's longest consent", async () => {
	const bank = enableBanking();
	const oauth = flows(bank);
	expect(oauth.available()).toEqual(["bank"]);
	const { input } = bankStart();
	const started = await oauth.beginBank(input, signal);
	expect(started.authorizationUrl).toBe("https://tilisy.enablebanking.com/ais/start?sessionid=abc");
	expect(bank.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
		"GET /aspsps?country=DK&psu_type=business",
		"POST /auth",
	]);
	const auth = bank.calls[1]?.body as Record<string, unknown>;
	expect(auth.redirect_url).toBe(CALLBACK);
	expect(auth.psu_type).toBe("business");
	expect(auth.aspsp).toEqual({ name: "Danske Bank", country: "DK" });
	// The state begins with the company, like every connector's, so the shared origin routes the callback.
	expect(auth.state).toMatch(new RegExp(`^${input.companyId}\\.[A-Za-z0-9_-]{43}$`));
	// Danske Bank allows 90 days here: the consent asks for that, a minute short.
	expect((auth.access as Record<string, unknown>).valid_until).toBe(
		new Date(NOW + 90 * 86400_000 - 60_000).toISOString(),
	);
	// Every call is signed for the application, never with anything of the member's.
	expect(bank.calls.every((call) => call.authorization?.startsWith("Bearer "))).toBe(true);
	expect(started.expiresAt).toBe(new Date(NOW + 20 * 60_000).toISOString());
});

it("never lets a bank sign-in outlive its capture ticket, and makes no session for a return after it", async () => {
	const bank = enableBanking();
	let now = NOW;
	const oauth = flows(bank, () => now);
	// The capture ticket lasts ten minutes: the sign-in is offered for those ten, not twenty.
	const { input } = bankStart(randomUUID(), 10);
	const started = await oauth.beginBank(input, signal);
	expect(started.expiresAt).toBe(new Date(NOW + 10 * 60_000).toISOString());
	const state = (bank.calls[1]?.body as Record<string, string>).state as string;
	// Back from the bank after twelve minutes: refused before any session is made.
	now = NOW + 12 * 60_000;
	expect(() => oauth.receive({ state, code: "late-code" })).toThrow(expect.objectContaining({ reason: "expired" }));
	// Back with half a minute left: the confirm comes too close to the ticket's end to seal, so nothing is made.
	const second = bankStart(randomUUID(), 10);
	now = NOW;
	await oauth.beginBank(second.input, signal);
	now = NOW + 9 * 60_000 + 40_000;
	const receipt = oauth.receive({ state: (bank.calls[3]?.body as Record<string, string>).state, code: "c" });
	await expect(
		oauth.confirm(
			{ ticketId: second.input.ticketId, confirmation: receipt.confirmation, browserProof: second.browserProof },
			signal,
		),
	).rejects.toMatchObject({ reason: "expired" });
	expect(bank.calls.some((call) => call.path === "/sessions")).toBe(false);
	// A ticket that is nearly over starts nothing.
	now = NOW;
	await expect(oauth.beginBank(bankStart(randomUUID(), 0.25).input, signal)).rejects.toThrow("invalid");
});

it("closes a bank session the vault could not seal, and leaves other connectors alone", async () => {
	const bank = enableBanking();
	const oauth = flows(bank);
	const completion = {
		ticketId: randomUUID(),
		captureCapability: "c".repeat(43),
		companyId: randomUUID(),
		returnTo: `${WEB}/`,
		accountLabel: null,
	};
	await oauth.abandon({ ...completion, connectorId: "bank", fields: { session_id: "session-7f3e" } }, signal);
	expect(bank.calls.map((call) => `${call.method} ${call.path}`)).toEqual(["DELETE /sessions/session-7f3e"]);
	await oauth.abandon({ ...completion, connectorId: "gmail", fields: { refresh_token: "x" } }, signal);
	expect(bank.calls).toHaveLength(1);
});

it("refuses a bank Enable Banking does not list, a malformed choice, and a bank start without the application", async () => {
	const oauth = flows();
	const { input } = bankStart();
	await expect(oauth.beginBank({ ...input, bank: { ...input.bank, name: "Unknown Bank" } }, signal)).rejects.toThrow(
		"not available",
	);
	await expect(
		oauth.beginBank({ ...input, bank: { ...input.bank, psuType: "other" as "business" } }, signal),
	).rejects.toThrow("invalid");
	await expect(oauth.beginBank({ ...input, connectorId: "gmail" }, signal)).rejects.toThrow("invalid");
	// The bank is not a catalog connector: the plain start refuses it.
	expect(() => oauth.begin(input)).toThrow("unknown");
	const without = new CloudConnectorOAuthFlows({
		clients: {},
		callbackUrl: CALLBACK,
		returnOrigins: [WEB],
		now: () => NOW,
	});
	expect(without.available()).toEqual([]);
	await expect(without.beginBank(input, signal)).rejects.toThrow("unavailable");
});

it("turns the bank's code into a sealed session, the shared accounts and the bank's name, only for the starting browser", async () => {
	const bank = enableBanking();
	const oauth = flows(bank);
	const { input, browserProof } = bankStart();
	await oauth.beginBank(input, signal);
	const state = (bank.calls[1]?.body as Record<string, string>).state as string;
	const receipt = oauth.receive({ state, code: "bank-code-123" });
	expect(receipt.connectorId).toBe("bank");
	const completion = await oauth.confirm(
		{ ticketId: input.ticketId, confirmation: receipt.confirmation, browserProof },
		signal,
	);
	expect(bank.calls.at(-1)).toMatchObject({ method: "POST", path: "/sessions", body: { code: "bank-code-123" } });
	expect(completion.connectorId).toBe("bank");
	expect(completion.accountLabel).toBe("••6243");
	expect(completion.fields.session_id).toBe("session-7f3e");
	expect(completion.fields.bank).toBe("Danske Bank");
	expect(completion.fields.valid_until).toBe("2027-01-19T11:59:00.000000+00:00");
	expect(JSON.parse(completion.fields.accounts ?? "")).toEqual([
		{
			uid: "uid-1",
			identificationHash: "hash-1",
			name: "Erhvervskonto",
			currency: "DKK",
			iban: "DK5000400440116243",
			otherIdentification: null,
		},
	]);
});

it("connects nothing when the member shared no account, and reports a declined bank sign-in", async () => {
	const bank = enableBanking({ accounts: [] });
	const oauth = flows(bank);
	const first = bankStart();
	await oauth.beginBank(first.input, signal);
	const receipt = oauth.receive({ state: (bank.calls[1]?.body as Record<string, string>).state, code: "c" });
	await expect(
		oauth.confirm(
			{ ticketId: first.input.ticketId, confirmation: receipt.confirmation, browserProof: first.browserProof },
			signal,
		),
	).rejects.toMatchObject({ reason: "declined" });
	const second = bankStart();
	await oauth.beginBank(second.input, signal);
	expect(() =>
		oauth.receive({ state: (bank.calls[4]?.body as Record<string, string>).state, error: "access_denied" }),
	).toThrow(expect.objectContaining({ reason: "declined", connectorId: "bank" }));
});

it("reads the Enable Banking application from the connectors credential, alone or with the OAuth clients", () => {
	const base = { schema: "qorpera.cloud-connector-service/v1", publicOrigin: "https://secrets.qorpera.test" };
	const config = parseCloudConnectorServiceConfig(
		JSON.stringify({ ...base, enableBanking: { applicationId, privateKeyPem } }),
	);
	expect(config.enableBanking?.applicationId).toBe(applicationId);
	const service = composeCloudConnectorService(config, [WEB], vi.fn<typeof fetch>());
	expect(service.connectors).toEqual(["bank"]);
	expect(service.oauth.available()).toEqual(["bank"]);
	expect(service.bank).toBeInstanceOf(EnableBankingClient);
	expect(service.adapters).toEqual([]);
	for (const enableBanking of [
		{ applicationId: "not-an-id", privateKeyPem },
		{ applicationId, privateKeyPem: "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----\n" },
		{
			applicationId,
			privateKeyPem: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({
				type: "pkcs8",
				format: "pem",
			}),
		},
		{ applicationId, privateKeyPem, extra: true },
	]) {
		expect(() => parseCloudConnectorServiceConfig(JSON.stringify({ ...base, enableBanking }))).toThrow(
			"Enable Banking application is invalid",
		);
	}
});

/** The vault's routes, end to end: a bank ticket's start names the bank; the confirm seals the session. */
function routeFixture(connectorId = "bank") {
	const identity = {
		companyId: randomUUID(),
		environmentId: randomUUID(),
		secretId: randomUUID(),
		version: 1,
		keyId: "k1",
	};
	const ticketId = randomUUID();
	const capability = randomBytes(32).toString("base64url");
	const keyring = new CloudSecretKeyring({ [identity.keyId]: randomBytes(32) });
	const description: CloudSecretCaptureDescription = {
		schema: "qorpera.cloud-secret-capture-description/v1",
		ticketId,
		...identity,
		ownerKind: "company",
		ownerUserId: null,
		connectorId,
		secretName: "primary",
		purpose: "Company bank",
		expiresAt: "2099-01-01T00:00:00.000Z",
	};
	const captured: { envelope: Uint8Array; accountLabel: string | null }[] = [];
	const authority: CloudSecretBrokerAuthority = {
		describeCapture: vi.fn(async () => description),
		completeCapture: vi.fn(async (_ticket, _capability, envelope, _digest, accountLabel) => {
			captured.push({ envelope: Uint8Array.from(envelope), accountLabel });
			return {
				schema: "qorpera.cloud-secret-descriptor/v1",
				secretId: identity.secretId,
				version: 1,
				connectorId,
				secretName: "primary",
				purpose: description.purpose,
				ownerKind: "company",
				ownerUserId: null,
				status: "active",
				accountLabel,
			};
		}),
		authorizeOperation: vi.fn(async () => {
			throw new Error("not used");
		}),
		authorizeRepositoryCredential: vi.fn(async () => {
			throw new Error("not used");
		}),
	};
	const bank = enableBanking();
	const oauth = new CloudConnectorOAuthFlows({
		clients: {},
		callbackUrl: CALLBACK,
		returnOrigins: [WEB],
		bank: bank.client,
	});
	const service = new HttpCloudSecretBrokerService(
		new CloudSecretBroker({ authority, keyring, adapters: [] }),
		randomBytes(32).toString("base64url"),
		{ oauth, memberOrigins: [WEB] },
	);
	services.push(service);
	const proof = randomBytes(32).toString("base64url");
	return { identity, ticketId, capability, keyring, captured, bank, service, proof };
}

async function post(port: number, path: string, body: unknown) {
	return fetch(`http://127.0.0.1:${port}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", origin: WEB },
		body: JSON.stringify(body),
	});
}

it("starts a bank ticket only with a bank choice, returns through the shared callback, and seals the session on confirm", async () => {
	const f = routeFixture();
	const port = await f.service.start();
	const startPath = `/v1/oauth/${f.ticketId}/start?company=${f.identity.companyId}`;
	const startBody = {
		schema: "qorpera.cloud-connector-oauth-start/v2",
		captureCapability: f.capability,
		returnTo: `${WEB}/`,
		browserProofSha256: proofHash(f.proof),
	};
	// A bank ticket without the bank, or with a stray key in it, starts nothing.
	expect((await post(port, startPath, startBody)).status).not.toBe(200);
	expect(
		(
			await post(port, startPath, {
				...startBody,
				bank: { name: "Danske Bank", country: "DK", psuType: "business", x: 1 },
			})
		).status,
	).not.toBe(200);
	expect(f.bank.calls).toEqual([]);
	const started = await post(port, startPath, {
		...startBody,
		bank: { name: "Danske Bank", country: "DK", psuType: "business" },
	});
	expect(started.status).toBe(200);
	expect(await started.json()).toMatchObject({
		schema: "qorpera.cloud-connector-oauth-started/v1",
		connectorId: "bank",
		authorizationUrl: "https://tilisy.enablebanking.com/ais/start?sessionid=abc",
	});
	const state = (f.bank.calls[1]?.body as Record<string, string>).state as string;
	const callback = await fetch(
		`http://127.0.0.1:${port}/v1/oauth/callback?state=${encodeURIComponent(state)}&code=bank-code`,
		{ redirect: "manual" },
	);
	expect(callback.status).toBe(303);
	const location = new URL(callback.headers.get("location") ?? "");
	const fragment = new URLSearchParams(location.hash.replace(/^#\??/, ""));
	expect(fragment.get("connector")).toBe("bank");
	expect(fragment.get("connection")).toBe("confirm");
	const confirmed = await post(port, `/v1/oauth/${f.ticketId}/confirm?company=${f.identity.companyId}`, {
		schema: "qorpera.cloud-connector-oauth-confirm/v1",
		confirmation: fragment.get("confirmation"),
		browserProof: f.proof,
	});
	expect(confirmed.status).toBe(200);
	expect(await confirmed.json()).toEqual({
		schema: "qorpera.cloud-connector-oauth-confirmed/v1",
		connectorId: "bank",
		accountLabel: "••6243",
	});
	expect(f.captured).toHaveLength(1);
	expect(f.captured[0]?.accountLabel).toBe("••6243");
	// The sealed fields, opened through the keyring the vault itself uses.
	const sealed = await f.keyring.use(f.captured[0]?.envelope as Uint8Array, f.identity, async (opened) => ({
		...opened,
	}));
	expect(sealed.session_id).toBe("session-7f3e");
	expect(sealed.bank).toBe("Danske Bank");
	expect(JSON.parse(sealed.accounts ?? "")[0].uid).toBe("uid-1");
});

it("refuses a bank choice on any other connector's ticket", async () => {
	const f = routeFixture("gmail");
	const port = await f.service.start();
	const response = await post(port, `/v1/oauth/${f.ticketId}/start?company=${f.identity.companyId}`, {
		schema: "qorpera.cloud-connector-oauth-start/v2",
		captureCapability: f.capability,
		returnTo: `${WEB}/`,
		browserProofSha256: proofHash(f.proof),
		bank: { name: "Danske Bank", country: "DK", psuType: "business" },
	});
	expect(response.status).not.toBe(200);
	expect(f.bank.calls).toEqual([]);
});
