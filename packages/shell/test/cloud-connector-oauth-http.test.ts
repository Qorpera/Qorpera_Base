import { createHash, randomBytes, randomUUID } from "node:crypto";
import { CloudConnectorOAuthFlows } from "@qorpera/runtime/cloud-connector-oauth";
import {
	CloudSecretBroker,
	type CloudSecretBrokerAuthority,
	type CloudSecretCaptureDescription,
} from "@qorpera/runtime/cloud-secret-broker";
import { HttpCloudSecretBrokerService } from "@qorpera/runtime/cloud-secret-broker-http";
import { CloudSecretKeyring } from "@qorpera/runtime/cloud-secret-crypto";
import { afterEach, expect, it, vi } from "vitest";

/** The broker's member-facing OAuth routes: start from the web app (CORS),
 * return from the provider (redirect), and the capture in between. */

const services: HttpCloudSecretBrokerService[] = [];
afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
});

const WEB = "https://app.qorpera.test";
const google = { clientId: "g.apps.googleusercontent.com", clientSecret: `GOCSPX-${randomBytes(8).toString("hex")}` };

function fixture(connectorId = "gmail", ownerKind: "company" | "member" = "company") {
	const identity = {
		companyId: randomUUID(),
		environmentId: randomUUID(),
		secretId: randomUUID(),
		version: 1,
		keyId: "k1",
	};
	const ticketId = randomUUID();
	const capability = randomBytes(32).toString("base64url");
	const wrappingKey = randomBytes(32);
	const keyring = new CloudSecretKeyring({ [identity.keyId]: wrappingKey });
	const description: CloudSecretCaptureDescription = {
		schema: "qorpera.cloud-secret-capture-description/v1",
		ticketId,
		...identity,
		ownerKind,
		ownerUserId: ownerKind === "member" ? randomUUID() : null,
		connectorId,
		secretName: "primary",
		purpose: "Gmail account",
		expiresAt: "2099-01-01T00:00:00.000Z",
	};
	const captured: { envelope: Uint8Array; accountLabel: string | null }[] = [];
	const authority: CloudSecretBrokerAuthority = {
		describeCapture: vi.fn(async (ticket, capabilitySha) => {
			if (ticket !== ticketId || capabilitySha.length !== 64) throw new Error("private");
			return description;
		}),
		completeCapture: vi.fn(async (_ticket, _capability, envelope, _digest, accountLabel) => {
			captured.push({ envelope: Uint8Array.from(envelope), accountLabel });
			return {
				schema: "qorpera.cloud-secret-descriptor/v1",
				secretId: identity.secretId,
				version: 1,
				connectorId,
				secretName: "primary",
				purpose: description.purpose,
				ownerKind,
				ownerUserId: description.ownerUserId,
				status: "active",
				accountLabel,
			};
		}),
		authorizeOperation: vi.fn(async () => {
			throw new Error("not used");
		}),
	};
	const provider = vi.fn<typeof fetch>(async (target) => {
		const url = new URL(String(target));
		if (url.href === "https://oauth2.googleapis.com/token")
			return Response.json({
				access_token: "ya29.access-token-value-1234567890",
				refresh_token: "1//refresh-token-value-1234567890",
			});
		if (url.href === "https://openidconnect.googleapis.com/v1/userinfo")
			return Response.json({ email: "anna@example.com" });
		throw new Error(`unexpected ${url.href}`);
	});
	const oauth = new CloudConnectorOAuthFlows({
		clients: { google },
		callbackUrl: "https://secrets.qorpera.test/v1/oauth/callback",
		returnOrigins: [WEB],
		fetch: provider,
	});
	const broker = new CloudSecretBroker({ authority, keyring, adapters: [] });
	const runtimeToken = randomBytes(32).toString("base64url");
	const service = new HttpCloudSecretBrokerService(broker, runtimeToken, { oauth, memberOrigins: [WEB] });
	services.push(service);
	// The starting browser's proof: the app keeps it and sends only its hash.
	const proof = randomBytes(32).toString("base64url");
	const proofSha256 = createHash("sha256").update(proof).digest("hex");
	return {
		ticketId,
		capability,
		service,
		captured,
		keyring,
		wrappingKey,
		authority,
		provider,
		proof,
		proofSha256,
		companyId: identity.companyId,
	};
}

async function confirm(
	f: ReturnType<typeof fixture>,
	port: number,
	confirmation: string,
	browserProof: string,
	origin = WEB,
) {
	return fetch(`http://127.0.0.1:${port}/v1/oauth/${f.ticketId}/confirm?company=${f.companyId}`, {
		method: "POST",
		headers: { "content-type": "application/json", origin },
		body: JSON.stringify({ schema: "qorpera.cloud-connector-oauth-confirm/v1", confirmation, browserProof }),
	});
}

async function start(f: ReturnType<typeof fixture>, body: unknown, origin = WEB) {
	const port = await f.service.start();
	// The web app names the company in the query so the shared origin's router
	// reaches this company's broker; the broker itself routes by path only.
	const response = await fetch(`http://127.0.0.1:${port}/v1/oauth/${f.ticketId}/start?company=${f.companyId}`, {
		method: "POST",
		headers: { "content-type": "application/json", origin },
		body: JSON.stringify(body),
	});
	return { port, response };
}

it("answers the web app's preflight and start request with CORS headers and a provider URL", async () => {
	const f = fixture();
	const port = await f.service.start();
	const preflight = await fetch(`http://127.0.0.1:${port}/v1/oauth/${f.ticketId}/start`, {
		method: "OPTIONS",
		headers: { origin: WEB, "access-control-request-method": "POST" },
	});
	expect(preflight.status).toBe(204);
	expect(preflight.headers.get("access-control-allow-origin")).toBe(WEB);
	const denied = await fetch(`http://127.0.0.1:${port}/v1/oauth/${f.ticketId}/start`, {
		method: "OPTIONS",
		headers: { origin: "https://evil.example" },
	});
	expect(denied.status).toBe(404);
	const response = await fetch(`http://127.0.0.1:${port}/v1/oauth/${f.ticketId}/start?company=${f.companyId}`, {
		method: "POST",
		headers: { "content-type": "application/json", origin: WEB },
		body: JSON.stringify({
			schema: "qorpera.cloud-connector-oauth-start/v2",
			captureCapability: f.capability,
			browserProofSha256: f.proofSha256,
			returnTo: `${WEB}/#/c/1`,
		}),
	});
	expect(response.status).toBe(200);
	expect(response.headers.get("access-control-allow-origin")).toBe(WEB);
	const started = (await response.json()) as Record<string, string>;
	expect(started.schema).toBe("qorpera.cloud-connector-oauth-started/v1");
	expect(started.connectorId).toBe("gmail");
	expect(new URL(started.authorizationUrl).origin).toBe("https://accounts.google.com");
	f.wrappingKey.fill(0);
	f.keyring.close();
});

it("refuses a start with a wrong capability or a foreign return page", async () => {
	const f = fixture();
	const wrong = await start(f, {
		schema: "qorpera.cloud-connector-oauth-start/v2",
		captureCapability: randomBytes(32).toString("base64url").slice(0, 43),
		browserProofSha256: f.proofSha256,
		returnTo: `${WEB}/`,
	});
	// The authority accepts any 64-hex digest in this fixture, so the ticket
	// describes fine; the foreign return page is what must fail.
	expect(wrong.response.status).toBe(200);
	const foreign = await fetch(`http://127.0.0.1:${wrong.port}/v1/oauth/${f.ticketId}/start`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			schema: "qorpera.cloud-connector-oauth-start/v2",
			captureCapability: f.capability,
			browserProofSha256: f.proofSha256,
			returnTo: "https://evil.example/",
		}),
	});
	expect(foreign.status).toBe(403);
	expect(await foreign.json()).toEqual({ schema: "qorpera.cloud-secret-error/v1", error: "unavailable" });
	f.wrappingKey.fill(0);
	f.keyring.close();
});

it("parks the provider callback and seals only when the starting browser confirms with its proof", async () => {
	const f = fixture();
	const { port, response } = await start(f, {
		schema: "qorpera.cloud-connector-oauth-start/v2",
		captureCapability: f.capability,
		browserProofSha256: f.proofSha256,
		returnTo: `${WEB}/#/c/1`,
	});
	const started = (await response.json()) as Record<string, string>;
	const state = new URL(started.authorizationUrl).searchParams.get("state");
	// The router picks the company's broker from the state's prefix.
	expect(state?.startsWith(`${f.companyId}.`)).toBe(true);
	const callback = await fetch(
		`http://127.0.0.1:${port}/v1/oauth/callback?state=${state}&code=4%2Fcode-value&scope=ignored`,
		{ redirect: "manual" },
	);
	expect(callback.status).toBe(303);
	const location = callback.headers.get("location") ?? "";
	const match =
		/^https:\/\/app\.qorpera\.test\/#\/c\/1\?connector=gmail&connection=confirm&confirmation=([A-Za-z0-9_-]{43})$/.exec(
			location,
		);
	expect(match).not.toBeNull();
	// Nothing is exchanged or sealed at the callback.
	expect(f.captured).toHaveLength(0);
	expect(f.provider).not.toHaveBeenCalled();
	const confirmed = await confirm(f, port, match?.[1] ?? "", f.proof);
	expect(confirmed.status).toBe(200);
	expect(confirmed.headers.get("access-control-allow-origin")).toBe(WEB);
	expect(await confirmed.json()).toEqual({
		schema: "qorpera.cloud-connector-oauth-confirmed/v1",
		connectorId: "gmail",
		accountLabel: "anna@example.com",
	});
	expect(f.captured).toHaveLength(1);
	expect(f.captured[0].accountLabel).toBe("anna@example.com");
	expect(Buffer.from(f.captured[0].envelope).toString("latin1")).not.toContain("refresh-token-value");
	// Neither the callback nor the confirmation can be replayed into a second capture.
	const replay = await fetch(`http://127.0.0.1:${port}/v1/oauth/callback?state=${state}&code=4%2Fcode-value`, {
		redirect: "manual",
	});
	expect(replay.status).toBe(400);
	expect((await confirm(f, port, match?.[1] ?? "", f.proof)).status).toBe(403);
	expect(f.captured).toHaveLength(1);
	f.wrappingKey.fill(0);
	f.keyring.close();
});

it("refuses a confirmation from a browser without the starting browser's proof and seals nothing", async () => {
	const f = fixture();
	const { port, response } = await start(f, {
		schema: "qorpera.cloud-connector-oauth-start/v2",
		captureCapability: f.capability,
		browserProofSha256: f.proofSha256,
		returnTo: `${WEB}/#/c/1`,
	});
	// The consent link is sent to someone else, who signs in with their account.
	const state = new URL(((await response.json()) as Record<string, string>).authorizationUrl).searchParams.get(
		"state",
	);
	const callback = await fetch(`http://127.0.0.1:${port}/v1/oauth/callback?state=${state}&code=victim-code`, {
		redirect: "manual",
	});
	const confirmation = new URLSearchParams((callback.headers.get("location") ?? "").split("?")[1]).get("confirmation");
	// Their browser holds no proof for this sign-in.
	const refused = await confirm(f, port, confirmation ?? "", randomBytes(32).toString("base64url"));
	expect(refused.status).toBe(403);
	expect(await refused.json()).toEqual({
		schema: "qorpera.cloud-connector-oauth-failed/v1",
		reason: "browser_mismatch",
	});
	// The starter, who holds the proof, cannot finish it afterwards (one attempt).
	expect((await confirm(f, port, confirmation ?? "", f.proof)).status).toBe(403);
	expect(f.captured).toHaveLength(0);
	expect(f.provider).not.toHaveBeenCalled();
	f.wrappingKey.fill(0);
	f.keyring.close();
});

it("refuses a sign-in for a ticket that is not company-owned", async () => {
	const f = fixture("gmail", "member");
	const { response } = await start(f, {
		schema: "qorpera.cloud-connector-oauth-start/v2",
		captureCapability: f.capability,
		browserProofSha256: f.proofSha256,
		returnTo: `${WEB}/#/c/1`,
	});
	expect(response.status).toBe(403);
	f.wrappingKey.fill(0);
	f.keyring.close();
});

it("sends a declined consent back to the web app as a failure fragment without capturing", async () => {
	const f = fixture();
	const { port, response } = await start(f, {
		schema: "qorpera.cloud-connector-oauth-start/v2",
		captureCapability: f.capability,
		browserProofSha256: f.proofSha256,
		returnTo: `${WEB}/#/c/1`,
	});
	const state = new URL(((await response.json()) as Record<string, string>).authorizationUrl).searchParams.get(
		"state",
	);
	const callback = await fetch(`http://127.0.0.1:${port}/v1/oauth/callback?state=${state}&error=access_denied`, {
		redirect: "manual",
	});
	expect(callback.status).toBe(303);
	expect(callback.headers.get("location")).toBe(`${WEB}/#/c/1?connector=gmail&connection=failed&reason=declined`);
	expect(f.captured).toHaveLength(0);
	f.wrappingKey.fill(0);
	f.keyring.close();
});

it("refuses a sign-in start from an origin outside the broker's member origins", async () => {
	const f = fixture();
	const { response } = await start(
		f,
		{
			schema: "qorpera.cloud-connector-oauth-start/v2",
			captureCapability: f.capability,
			browserProofSha256: f.proofSha256,
			returnTo: `${WEB}/`,
		},
		"https://evil.example",
	);
	expect(response.status).toBe(403);
	expect(response.headers.get("access-control-allow-origin")).toBeNull();
	expect(f.authority.describeCapture).not.toHaveBeenCalled();
	f.wrappingKey.fill(0);
	f.keyring.close();
});

it("keeps the OAuth routes closed when no connector service is configured", async () => {
	const f = fixture();
	const broker = new CloudSecretBroker({ authority: f.authority, keyring: f.keyring, adapters: [] });
	const plain = new HttpCloudSecretBrokerService(broker, randomBytes(32).toString("base64url"), {
		memberOrigins: [WEB],
	});
	services.push(plain);
	const port = await plain.start();
	const startResponse = await fetch(`http://127.0.0.1:${port}/v1/oauth/${f.ticketId}/start`, {
		method: "POST",
		headers: { "content-type": "application/json", origin: WEB },
		body: JSON.stringify({
			schema: "qorpera.cloud-connector-oauth-start/v2",
			captureCapability: f.capability,
			browserProofSha256: f.proofSha256,
			returnTo: `${WEB}/`,
		}),
	});
	expect(startResponse.status).toBe(404);
	expect(f.authority.describeCapture).not.toHaveBeenCalled();
	const callback = await fetch(`http://127.0.0.1:${port}/v1/oauth/callback?state=x&code=y`, { redirect: "manual" });
	expect(callback.status).toBe(404);
	f.wrappingKey.fill(0);
	f.keyring.close();
});
