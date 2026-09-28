import { createHash, randomBytes, randomUUID } from "node:crypto";
import { MODEL_LOGIN_FIELD } from "@qorpera/runtime/cloud-model-login-vault";
import { CloudModelLoginUsage, type ModelLoginUsageAuthority } from "@qorpera/runtime/cloud-model-login-vault-usage";
import { CloudSecretBroker, type CloudSecretBrokerAuthority } from "@qorpera/runtime/cloud-secret-broker";
import { HttpCloudSecretBrokerService } from "@qorpera/runtime/cloud-secret-broker-http";
import { CloudSecretKeyring } from "@qorpera/runtime/cloud-secret-crypto";
import { afterEach, expect, it, vi } from "vitest";

const keyrings: CloudSecretKeyring[] = [];
const services: HttpCloudSecretBrokerService[] = [];
afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
	for (const keyring of keyrings.splice(0)) keyring.close();
});

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const LOGIN = `${JSON.stringify({
	OPENAI_API_KEY: null,
	tokens: {
		id_token: `${part({ alg: "RS256" })}.${part({ email: "member@example.test" })}.c2ln`,
		access_token: `${part({ alg: "RS256" })}.${part({ iat: now, exp: now + 864_000 })}.c2ln`,
		refresh_token: "rt-kept-in-the-vault",
		account_id: "account-1",
	},
	last_refresh: new Date(now * 1000).toISOString(),
})}\n`;
const signal = () => new AbortController().signal;

function world(options: { status?: string; keyId?: string; logins?: number } = {}) {
	const companyId = randomUUID();
	const computeIdentityId = randomUUID();
	const loginId = randomUUID();
	const requestId = randomUUID();
	const memberId = randomUUID();
	const capability = randomBytes(32).toString("base64url");
	const capabilitySha256 = createHash("sha256").update(capability).digest("hex");
	const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
	const keyring = new CloudSecretKeyring({ "company-kek-1": randomBytes(32) });
	keyrings.push(keyring);
	const connectionId = randomUUID();
	const logins = Array.from({ length: options.logins ?? 1 }, (_, index) => {
		const id = index === 0 ? loginId : randomUUID();
		const envelope = keyring.seal(
			{ [MODEL_LOGIN_FIELD]: LOGIN },
			{ companyId, environmentId: computeIdentityId, secretId: id, version: 3, keyId: "company-kek-1" },
		);
		return {
			loginId: id,
			version: 3,
			keyId: options.keyId ?? "company-kek-1",
			encryptedEnvelopeBase64: Buffer.from(envelope).toString("base64"),
			envelopeSha256: createHash("sha256").update(envelope).digest("hex"),
			connectionId: index === 0 ? connectionId : randomUUID(),
			connectionVersion: 2,
			credentialCapsuleId: randomUUID(),
		};
	});
	const description = {
		schema: "qorpera.model-login-account-refresh/v1",
		requestId,
		profileId: companyId,
		computeIdentityId,
		requestedByUserId: memberId,
		status: options.status ?? "pending",
		expiresAt,
		logins,
	};
	const authority = {
		describeModelLoginAccountRefresh: vi.fn(async () => structuredClone(description)),
		recordModelLoginAccountMetadata: vi.fn(
			async (
				_record: Parameters<ModelLoginUsageAuthority["recordModelLoginAccountMetadata"]>[0],
				_signal: AbortSignal,
			) => true,
		),
		completeModelLoginAccountRefresh: vi.fn(async () => true),
	} satisfies ModelLoginUsageAuthority;
	const body = {
		schema: "qorpera.native-account-refresh/v1",
		request_id: requestId,
		compute_identity_id: computeIdentityId,
		requested_by_user_id: memberId,
		expires_at: expiresAt,
		refresh_capability: capability,
	};
	const usageFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
		expect((init?.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
		expect((init?.headers as Record<string, string>)["ChatGPT-Account-Id"]).toBe("account-1");
		return Response.json({
			rate_limit: { primary_window: { used_percent: 42, limit_window_seconds: 18_000 } },
		});
	});
	return {
		companyId,
		requestId,
		capabilitySha256,
		connectionId,
		loginId,
		keyring,
		authority,
		usageFetch,
		request: { companyId, capability, body },
	};
}

it("reads a vault login's usage with its pass, records it for the connection version, and completes the refresh", async () => {
	const w = world();
	const usage = new CloudModelLoginUsage({
		authority: w.authority,
		keyring: w.keyring,
		fetch: w.usageFetch as typeof fetch,
	});
	expect(await usage.refresh(w.request, signal())).toEqual({
		schema: "qorpera.native-account-refresh-result/v1",
		request_id: w.requestId,
		status: "completed",
	});
	expect(w.authority.describeModelLoginAccountRefresh).toHaveBeenCalledWith(
		{ requestId: w.requestId, capabilitySha256: w.capabilitySha256 },
		expect.any(AbortSignal),
	);
	expect(w.usageFetch).toHaveBeenCalledTimes(1);
	const recorded = w.authority.recordModelLoginAccountMetadata.mock.calls[0]?.[0];
	expect(recorded).toMatchObject({
		requestId: w.requestId,
		capabilitySha256: w.capabilitySha256,
		loginId: w.loginId,
		connectionId: w.connectionId,
		connectionVersion: 2,
		providerAccountEmail: "member@example.test",
		providerAccountUsage: { windows: [{ id: "primary", label: "5 hours", usedPercent: 42, windowSeconds: 18_000 }] },
	});
	expect(recorded?.providerAccountIdentity).toMatch(/^[0-9a-f]{64}$/);
	// Only display metadata leaves the vault: never the login or its renewal token.
	expect(JSON.stringify(w.authority.recordModelLoginAccountMetadata.mock.calls)).not.toContain("rt-kept-in-the-vault");
	expect(w.authority.completeModelLoginAccountRefresh).toHaveBeenCalledWith(
		{ requestId: w.requestId, capabilitySha256: w.capabilitySha256 },
		expect.any(AbortSignal),
	);
});

it("settles a refresh whose login cannot be read or answers nothing, and answers a completed one from the database", async () => {
	const unreadable = world({ keyId: "company-kek-2" });
	const usage = new CloudModelLoginUsage({
		authority: unreadable.authority,
		keyring: unreadable.keyring,
		fetch: unreadable.usageFetch as typeof fetch,
	});
	expect((await usage.refresh(unreadable.request, signal())).status).toBe("completed");
	expect(unreadable.authority.recordModelLoginAccountMetadata).not.toHaveBeenCalled();
	expect(unreadable.authority.completeModelLoginAccountRefresh).toHaveBeenCalled();
	const silent = world();
	silent.usageFetch.mockResolvedValue(new Response("busy", { status: 503 }));
	await new CloudModelLoginUsage({
		authority: silent.authority,
		keyring: silent.keyring,
		fetch: silent.usageFetch as typeof fetch,
	}).refresh(silent.request, signal());
	expect(silent.authority.recordModelLoginAccountMetadata.mock.calls[0]?.[0]).toMatchObject({
		providerAccountEmail: "member@example.test",
		providerAccountUsage: null,
	});
	const done = world({ status: "completed" });
	expect(
		(
			await new CloudModelLoginUsage({
				authority: done.authority,
				keyring: done.keyring,
				fetch: done.usageFetch as typeof fetch,
			}).refresh(done.request, signal())
		).status,
	).toBe("completed");
	expect(done.usageFetch).not.toHaveBeenCalled();
	expect(done.authority.completeModelLoginAccountRefresh).not.toHaveBeenCalled();
});

it("reads at most eight logins, all at once, and still settles", async () => {
	const w = world({ logins: 9 });
	let open = 0;
	let most = 0;
	w.usageFetch.mockImplementation(async () => {
		open += 1;
		most = Math.max(most, open);
		await new Promise((resolveWait) => setTimeout(resolveWait, 20));
		open -= 1;
		return Response.json({ rate_limit: { primary_window: { used_percent: 1 } } });
	});
	const usage = new CloudModelLoginUsage({
		authority: w.authority,
		keyring: w.keyring,
		fetch: w.usageFetch as typeof fetch,
	});
	expect((await usage.refresh(w.request, signal())).status).toBe("completed");
	expect(w.usageFetch).toHaveBeenCalledTimes(8);
	expect(most).toBe(8);
	expect(w.authority.recordModelLoginAccountMetadata).toHaveBeenCalledTimes(8);
});

it("refuses a refresh that differs from the database's record or has ended, before reading any login", async () => {
	const w = world();
	const usage = new CloudModelLoginUsage({
		authority: w.authority,
		keyring: w.keyring,
		fetch: w.usageFetch as typeof fetch,
	});
	for (const [body, companyId, capability] of [
		[{ ...w.request.body }, randomUUID(), undefined],
		[{ ...w.request.body, compute_identity_id: randomUUID() }, undefined, undefined],
		[{ ...w.request.body, requested_by_user_id: randomUUID() }, undefined, undefined],
		[{ ...w.request.body, refresh_capability: randomBytes(32).toString("base64url") }, undefined, undefined],
		[{ ...w.request.body }, undefined, randomBytes(32).toString("base64url")],
		[{ ...w.request.body, extra: true }, undefined, undefined],
	] as const)
		await expect(
			usage.refresh(
				{ companyId: companyId ?? w.companyId, capability: capability ?? w.request.capability, body },
				signal(),
			),
		).rejects.toThrow();
	expect(w.usageFetch).not.toHaveBeenCalled();
	const ended = world({ status: "expired" });
	await expect(
		new CloudModelLoginUsage({
			authority: ended.authority,
			keyring: ended.keyring,
			fetch: ended.usageFetch as typeof fetch,
		}).refresh(ended.request, signal()),
	).rejects.toThrow("ended");
	expect(ended.usageFetch).not.toHaveBeenCalled();
});

it("serves the account refresh route to the refresh's own capability, uncached, and only when configured", async () => {
	const w = world();
	const refuse = vi.fn(async () => {
		throw new Error("not in this test");
	});
	const brokerAuthority: CloudSecretBrokerAuthority = {
		describeCapture: refuse,
		completeCapture: refuse,
		authorizeOperation: refuse,
		authorizeRepositoryCredential: refuse,
	};
	const broker = new CloudSecretBroker({ authority: brokerAuthority, keyring: w.keyring, adapters: [] });
	const runtimeToken = randomBytes(32).toString("base64url");
	const usage = new CloudModelLoginUsage({
		authority: w.authority,
		keyring: w.keyring,
		fetch: w.usageFetch as typeof fetch,
	});
	const withUsage = new HttpCloudSecretBrokerService(broker, runtimeToken, { modelLoginUsage: usage });
	const without = new HttpCloudSecretBrokerService(broker, runtimeToken, {});
	services.push(withUsage, without);
	const port = await withUsage.start();
	const post = (servicePort: number, authorization: string | undefined, company = w.companyId) =>
		fetch(`http://127.0.0.1:${servicePort}/v1/model-logins/${company}/account-refresh`, {
			method: "POST",
			headers: { ...(authorization ? { authorization } : {}), "content-type": "application/json" },
			body: JSON.stringify(w.request.body),
		});
	expect((await post(await without.start(), `Bearer ${w.request.capability}`)).status).toBe(404);
	const served = await post(port, `Bearer ${w.request.capability}`);
	expect(served.status).toBe(200);
	expect(served.headers.get("cache-control")).toBe("no-store");
	expect(served.headers.get("access-control-allow-origin")).toBeNull();
	expect(await served.json()).toEqual({
		schema: "qorpera.native-account-refresh-result/v1",
		request_id: w.requestId,
		status: "completed",
	});
	for (const response of [
		await post(port, undefined),
		await post(port, `Bearer ${runtimeToken}`),
		await post(port, `Bearer ${w.request.capability}`, randomUUID()),
	]) {
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ schema: "qorpera.cloud-secret-error/v1", error: "unavailable" });
	}
});
