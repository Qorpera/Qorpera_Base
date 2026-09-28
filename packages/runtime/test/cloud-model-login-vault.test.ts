import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	accessOnlyCodexLogin,
	CloudModelLoginVault,
	MODEL_LOGIN_FIELD,
	type ModelLoginAuthority,
	type ModelLoginRenewer,
	type ModelLoginRunBinding,
	parseCodexLogin,
} from "@qorpera/runtime/cloud-model-login-vault";
import { CloudSecretBroker, type CloudSecretBrokerAuthority } from "@qorpera/runtime/cloud-secret-broker";
import { HttpCloudSecretBrokerService, issueModelLogin } from "@qorpera/runtime/cloud-secret-broker-http";
import { CloudSecretKeyring, withCloudSecretFields } from "@qorpera/runtime/cloud-secret-crypto";
import { afterEach, expect, it, vi } from "vitest";

const services: HttpCloudSecretBrokerService[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const service of services.splice(0)) await service.close();
});

function jwt(claims: Record<string, unknown>): string {
	const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${part({ alg: "RS256", typ: "JWT" })}.${part(claims)}.c2lnbmF0dXJl`;
}

/** A Codex ChatGPT login whose pass started `ageSeconds` ago and lasts `lifeSeconds`. */
function codexLogin(options: { ageSeconds: number; lifeSeconds: number; refresh: string; account?: string }): string {
	const now = Math.floor(Date.now() / 1000);
	const iat = now - options.ageSeconds;
	return `${JSON.stringify(
		{
			OPENAI_API_KEY: null,
			tokens: {
				id_token: jwt({ email: "member@example.test", iat }),
				access_token: jwt({ iat, exp: iat + options.lifeSeconds, jti: randomUUID() }),
				refresh_token: options.refresh,
				account_id: options.account ?? "account-1",
			},
			last_refresh: new Date(iat * 1000).toISOString(),
		},
		null,
		2,
	)}\n`;
}

function binding(): ModelLoginRunBinding {
	return {
		leaseId: randomUUID(),
		runId: randomUUID(),
		jobId: randomUUID(),
		runnerId: randomUUID(),
		assignmentId: randomUUID(),
		credentialCapsuleId: randomUUID(),
		computeIdentityId: randomUUID(),
	};
}

/** An authority that answers like the database for one stored login version. */
function fixture(options: {
	stored: string;
	renewal?: boolean;
	renewing?: boolean;
	unchanged?: boolean;
	envelopeSha256?: string;
	change?: (answer: Record<string, unknown>) => Record<string, unknown>;
}) {
	const keyId = "company-kek-1";
	const wrappingKey = randomBytes(32);
	const keyring = new CloudSecretKeyring({ [keyId]: wrappingKey });
	const run = binding();
	const loginId = randomUUID();
	const companyId = randomUUID();
	const identity = { companyId, environmentId: run.computeIdentityId, secretId: loginId, keyId };
	const envelope = keyring.seal({ [MODEL_LOGIN_FIELD]: options.stored }, { ...identity, version: 3 });
	const stored = parseCodexLogin(options.stored);
	const renewalToken = randomUUID();
	const authority: ModelLoginAuthority & { [K in keyof ModelLoginAuthority]: ReturnType<typeof vi.fn> } = {
		issueModelLogin: vi.fn(async () => {
			const answer: Record<string, unknown> = options.unchanged
				? {
						schema: "qorpera.model-login-issue/v1",
						loginId,
						companyId,
						computeIdentityId: run.computeIdentityId,
						version: 3,
						accessIssuedAt: stored.accessIssuedAt,
						accessExpiresAt: stored.accessExpiresAt,
						renewing: options.renewing ?? false,
						unchanged: true,
					}
				: {
						schema: "qorpera.model-login-issue/v1",
						loginId,
						companyId,
						computeIdentityId: run.computeIdentityId,
						version: 3,
						keyId,
						encryptedEnvelopeBase64: Buffer.from(envelope).toString("base64"),
						envelopeSha256: options.envelopeSha256 ?? createHash("sha256").update(envelope).digest("hex"),
						accessIssuedAt: stored.accessIssuedAt,
						accessExpiresAt: stored.accessExpiresAt,
						renewing: options.renewing ?? false,
						unchanged: false,
						renewal: options.renewal ? { token: renewalToken, baseVersion: 3, keyId } : null,
					};
			return options.change ? options.change(answer) : answer;
		}),
		commitModelLoginRenewal: vi.fn(async (renewal: { baseVersion: number }) => ({
			schema: "qorpera.model-login-renewal/v1",
			loginId,
			version: renewal.baseVersion + 1,
		})),
		releaseModelLoginRenewal: vi.fn(async () => ({
			schema: "qorpera.model-login-renewal-release/v1",
			loginId,
			released: true,
			status: "active",
		})),
	};
	return { authority, keyring, wrappingKey, run, loginId, companyId, identity, renewalToken };
}

function tokens(text: string): Record<string, string> {
	return (JSON.parse(text) as { tokens: Record<string, string> }).tokens;
}

it("hands a run the stored login without its renewal token", async () => {
	const stored = codexLogin({ ageSeconds: 60, lifeSeconds: 864_000, refresh: "rt-stored" });
	const f = fixture({ stored });
	const vault = new CloudModelLoginVault({ authority: f.authority, keyring: f.keyring });
	const login = await vault.issue({ binding: f.run, knownVersion: null }, new AbortController().signal);
	expect(login.version).toBe(3);
	expect(login.accessExpiresAt).toBe(parseCodexLogin(stored).accessExpiresAt);
	expect(tokens(login.authJson as string)).toEqual({ ...tokens(stored), refresh_token: "" });
	expect(login.authJson).not.toContain("rt-stored");
	// Without a renewer the vault never asks for the renewal lock.
	expect(f.authority.issueModelLogin).toHaveBeenCalledWith(f.run, null, false, expect.any(AbortSignal));
});

it("answers a host that already holds the current version without a login", async () => {
	const f = fixture({ stored: codexLogin({ ageSeconds: 60, lifeSeconds: 864_000, refresh: "rt" }), unchanged: true });
	const vault = new CloudModelLoginVault({ authority: f.authority, keyring: f.keyring });
	await expect(vault.issue({ binding: f.run, knownVersion: 3 }, new AbortController().signal)).resolves.toMatchObject({
		version: 3,
		authJson: null,
	});
});

it("renews under the lock it holds and saves the next version sealed for that version", async () => {
	const stored = codexLogin({ ageSeconds: 500_000, lifeSeconds: 864_000, refresh: "rt-old" });
	const renewed = codexLogin({ ageSeconds: 0, lifeSeconds: 864_000, refresh: "rt-new" });
	const f = fixture({ stored, renewal: true });
	const renewer: ModelLoginRenewer = {
		renew: vi.fn(async () => ({ outcome: "renewed" as const, authJson: renewed })),
	};
	const vault = new CloudModelLoginVault({ authority: f.authority, keyring: f.keyring, renewer });
	const login = await vault.issue({ binding: f.run, knownVersion: 3 }, new AbortController().signal);
	expect(renewer.renew).toHaveBeenCalledWith(stored, expect.any(AbortSignal));
	expect(f.authority.issueModelLogin).toHaveBeenCalledWith(f.run, 3, true, expect.any(AbortSignal));
	expect(login.version).toBe(4);
	expect(tokens(login.authJson as string).access_token).toBe(tokens(renewed).access_token);
	expect(login.authJson).not.toContain("rt-new");
	const commit = vi.mocked(f.authority.commitModelLoginRenewal).mock.calls[0]?.[0] as {
		token: string;
		baseVersion: number;
		encryptedEnvelope: Uint8Array;
		envelopeSha256: string;
		accessExpiresAt: string;
	};
	expect(commit).toMatchObject({
		token: f.renewalToken,
		baseVersion: 3,
		accessExpiresAt: parseCodexLogin(renewed).accessExpiresAt,
	});
	expect(createHash("sha256").update(commit.encryptedEnvelope).digest("hex")).toBe(commit.envelopeSha256);
	// The saved envelope opens only as version 4 of this login and holds the full renewed login.
	await expect(
		withCloudSecretFields(commit.encryptedEnvelope, f.wrappingKey, { ...f.identity, version: 4 }, async (fields) => ({
			...fields,
		})),
	).resolves.toEqual({ [MODEL_LOGIN_FIELD]: renewed });
	await expect(
		withCloudSecretFields(commit.encryptedEnvelope, f.wrappingKey, { ...f.identity, version: 3 }, async () => true),
	).rejects.toThrow();
	expect(f.authority.releaseModelLoginRenewal).not.toHaveBeenCalled();
});

it("gives the lock back when the provider refuses the renewal, and the run keeps the current pass", async () => {
	const stored = codexLogin({ ageSeconds: 500_000, lifeSeconds: 864_000, refresh: "rt-used" });
	const f = fixture({ stored, renewal: true });
	const renewer: ModelLoginRenewer = {
		renew: vi.fn(async () => ({ outcome: "refused" as const, reason: "refresh_token_reused" })),
	};
	const vault = new CloudModelLoginVault({ authority: f.authority, keyring: f.keyring, renewer });
	const login = await vault.issue({ binding: f.run, knownVersion: null }, new AbortController().signal);
	expect(login.version).toBe(3);
	expect(tokens(login.authJson as string).access_token).toBe(tokens(stored).access_token);
	expect(f.authority.releaseModelLoginRenewal).toHaveBeenCalledWith(
		{ loginId: f.loginId, token: f.renewalToken, baseVersion: 3, permanent: true, reason: "refresh_token_reused" },
		expect.any(AbortSignal),
	);
	expect(f.authority.commitModelLoginRenewal).not.toHaveBeenCalled();
});

it("refuses a renewed login of another account or with an older pass", async () => {
	const stored = codexLogin({ ageSeconds: 500_000, lifeSeconds: 864_000, refresh: "rt-old" });
	for (const renewed of [
		codexLogin({ ageSeconds: 0, lifeSeconds: 864_000, refresh: "rt-new", account: "account-2" }),
		codexLogin({ ageSeconds: 600_000, lifeSeconds: 864_000, refresh: "rt-new" }),
	]) {
		const f = fixture({ stored, renewal: true });
		const renewer: ModelLoginRenewer = { renew: async () => ({ outcome: "renewed", authJson: renewed }) };
		const vault = new CloudModelLoginVault({ authority: f.authority, keyring: f.keyring, renewer });
		const login = await vault.issue({ binding: f.run, knownVersion: null }, new AbortController().signal);
		expect(login.version).toBe(3);
		expect(f.authority.commitModelLoginRenewal).not.toHaveBeenCalled();
		expect(f.authority.releaseModelLoginRenewal).toHaveBeenCalledWith(
			expect.objectContaining({ permanent: false, reason: "renewal_invalid" }),
			expect.any(AbortSignal),
		);
	}
});

it("keeps a renewed pass for this run when the new version cannot be saved", async () => {
	const stored = codexLogin({ ageSeconds: 500_000, lifeSeconds: 864_000, refresh: "rt-old" });
	const renewed = codexLogin({ ageSeconds: 0, lifeSeconds: 864_000, refresh: "rt-new" });
	const f = fixture({ stored, renewal: true });
	f.authority.commitModelLoginRenewal.mockRejectedValue(new Error("database is unavailable"));
	const vault = new CloudModelLoginVault({
		authority: f.authority,
		keyring: f.keyring,
		renewer: { renew: async () => ({ outcome: "renewed", authJson: renewed }) },
	});
	const login = await vault.issue({ binding: f.run, knownVersion: null }, new AbortController().signal);
	expect(f.authority.commitModelLoginRenewal).toHaveBeenCalledTimes(3);
	expect(tokens(login.authJson as string).access_token).toBe(tokens(renewed).access_token);
	expect(login.version).toBe(3);
	// The provider spent the old renewal token, so the stored login needs a new sign-in.
	expect(f.authority.releaseModelLoginRenewal).toHaveBeenCalledWith(
		expect.objectContaining({ permanent: true, reason: "renewal_unsaved" }),
		expect.any(AbortSignal),
	);
});

it("refuses a pass that has ended, a tampered envelope and a login without a renewal token", async () => {
	const ended = fixture({ stored: codexLogin({ ageSeconds: 900_000, lifeSeconds: 864_000, refresh: "rt" }) });
	await expect(
		new CloudModelLoginVault({ authority: ended.authority, keyring: ended.keyring }).issue(
			{ binding: ended.run, knownVersion: null },
			new AbortController().signal,
		),
	).rejects.toThrow("pass has ended");
	const tampered = fixture({
		stored: codexLogin({ ageSeconds: 60, lifeSeconds: 864_000, refresh: "rt" }),
		envelopeSha256: "0".repeat(64),
	});
	await expect(
		new CloudModelLoginVault({ authority: tampered.authority, keyring: tampered.keyring }).issue(
			{ binding: tampered.run, knownVersion: null },
			new AbortController().signal,
		),
	).rejects.toThrow("envelope is invalid");
	expect(() => parseCodexLogin(codexLogin({ ageSeconds: 60, lifeSeconds: 864_000, refresh: "" }))).toThrow();
	expect(() => parseCodexLogin(JSON.stringify({ OPENAI_API_KEY: "sk-1", tokens: {} }))).toThrow();
});

it("makes the run copy from the login's known fields, with an empty renewal token", () => {
	const stored = codexLogin({ ageSeconds: 60, lifeSeconds: 864_000, refresh: "rt-stored" });
	const copy = JSON.parse(accessOnlyCodexLogin(stored)) as Record<string, unknown>;
	const original = JSON.parse(stored) as Record<string, unknown>;
	expect(copy).toEqual({ ...original, tokens: { ...(original.tokens as object), refresh_token: "" } });
	// Anything beyond the known fields is refused, not handed on.
	const extra = JSON.stringify({ ...original, agent_identity: { record: "private" } });
	expect(() => parseCodexLogin(extra)).toThrow();
	expect(() => accessOnlyCodexLogin(extra)).toThrow();
	const extraToken = JSON.stringify({ ...original, tokens: { ...(original.tokens as object), session: "private" } });
	expect(() => parseCodexLogin(extraToken)).toThrow();
});

it("never renews with a key it cannot seal with, and gives the lock back", async () => {
	const stored = codexLogin({ ageSeconds: 500_000, lifeSeconds: 864_000, refresh: "rt-old" });
	const f = fixture({
		stored,
		renewal: true,
		change: (answer) => ({ ...answer, renewal: { ...(answer.renewal as object), keyId: "rotated-kek-2" } }),
	});
	const renewer: ModelLoginRenewer = { renew: vi.fn(async () => ({ outcome: "renewed" as const, authJson: stored })) };
	const keyring = new CloudSecretKeyring({ "company-kek-1": f.wrappingKey, "unrelated-kek": randomBytes(32) });
	const vault = new CloudModelLoginVault({ authority: f.authority, keyring, renewer });
	const login = await vault.issue({ binding: f.run, knownVersion: null }, new AbortController().signal);
	expect(login.version).toBe(3);
	expect(renewer.renew).not.toHaveBeenCalled();
	expect(f.authority.releaseModelLoginRenewal).toHaveBeenCalledWith(
		expect.objectContaining({ permanent: false, reason: "renewal_key_unavailable" }),
		expect.any(AbortSignal),
	);
});

it("gives the lock back when the renewer fails, and saves once after a lost database answer", async () => {
	const stored = codexLogin({ ageSeconds: 500_000, lifeSeconds: 864_000, refresh: "rt-old" });
	const failing = fixture({ stored, renewal: true });
	const broken = new CloudModelLoginVault({
		authority: failing.authority,
		keyring: failing.keyring,
		renewer: {
			renew: async () => {
				throw new Error("helper unreachable");
			},
		},
	});
	await expect(
		broken.issue({ binding: failing.run, knownVersion: null }, new AbortController().signal),
	).resolves.toMatchObject({
		version: 3,
	});
	expect(failing.authority.releaseModelLoginRenewal).toHaveBeenCalledWith(
		expect.objectContaining({ permanent: false, reason: "renewer_failed" }),
		expect.any(AbortSignal),
	);
	const renewed = codexLogin({ ageSeconds: 0, lifeSeconds: 864_000, refresh: "rt-new" });
	const lost = fixture({ stored, renewal: true });
	lost.authority.commitModelLoginRenewal.mockRejectedValueOnce(new Error("connection reset"));
	const vault = new CloudModelLoginVault({
		authority: lost.authority,
		keyring: lost.keyring,
		renewer: { renew: async () => ({ outcome: "renewed", authJson: renewed }) },
	});
	const login = await vault.issue({ binding: lost.run, knownVersion: null }, new AbortController().signal);
	expect(login.version).toBe(4);
	expect(lost.authority.commitModelLoginRenewal).toHaveBeenCalledTimes(2);
	// The second try sends the very same envelope, so the database recognises a save it already made.
	const [first, second] = vi
		.mocked(lost.authority.commitModelLoginRenewal)
		.mock.calls.map((call) => (call[0] as { envelopeSha256: string }).envelopeSha256);
	expect(second).toBe(first);
	expect(lost.authority.releaseModelLoginRenewal).not.toHaveBeenCalled();
});

it("gives the lock back when the stored login cannot be opened", async () => {
	const f = fixture({
		stored: codexLogin({ ageSeconds: 500_000, lifeSeconds: 864_000, refresh: "rt" }),
		renewal: true,
	});
	const vault = new CloudModelLoginVault({
		authority: f.authority,
		keyring: new CloudSecretKeyring({ "company-kek-1": randomBytes(32) }),
		renewer: { renew: vi.fn() },
	});
	await expect(vault.issue({ binding: f.run, knownVersion: null }, new AbortController().signal)).rejects.toThrow();
	expect(f.authority.releaseModelLoginRenewal).toHaveBeenCalledWith(
		expect.objectContaining({ permanent: false, reason: "login_unreadable" }),
		expect.any(AbortSignal),
	);
});

it("refuses an answer for another identity, a renewal of another version, or an unchanged answer with a renewal", async () => {
	const stored = codexLogin({ ageSeconds: 60, lifeSeconds: 864_000, refresh: "rt" });
	const cases: Array<(answer: Record<string, unknown>) => Record<string, unknown>> = [
		(answer) => ({ ...answer, computeIdentityId: randomUUID() }),
		(answer) => ({ ...answer, renewal: { token: randomUUID(), baseVersion: 2, keyId: "company-kek-1" } }),
		(answer) => ({
			...answer,
			unchanged: true,
			renewal: { token: randomUUID(), baseVersion: 3, keyId: "company-kek-1" },
		}),
	];
	for (const change of cases) {
		const f = fixture({ stored, change });
		const vault = new CloudModelLoginVault({ authority: f.authority, keyring: f.keyring });
		await expect(vault.issue({ binding: f.run, knownVersion: 3 }, new AbortController().signal)).rejects.toThrow();
		// An unreadable answer that carried a renewal lock gives it back.
		const answer = (await f.authority.issueModelLogin.mock.results[0]?.value) as {
			renewal?: { token: string } | null;
		};
		if (answer.renewal)
			expect(f.authority.releaseModelLoginRenewal).toHaveBeenCalledWith(
				expect.objectContaining({ token: answer.renewal.token, permanent: false, reason: "issue_unreadable" }),
				expect.any(AbortSignal),
			);
		else expect(f.authority.releaseModelLoginRenewal).not.toHaveBeenCalled();
	}
});

it("serves the route only with the runtime token, uncached, and the client reads it", async () => {
	const stored = codexLogin({ ageSeconds: 60, lifeSeconds: 864_000, refresh: "rt-stored" });
	const f = fixture({ stored });
	const refuse = vi.fn(async () => {
		throw new Error("not in this test");
	});
	const brokerAuthority: CloudSecretBrokerAuthority = {
		describeCapture: refuse,
		completeCapture: refuse,
		authorizeOperation: refuse,
		authorizeRepositoryCredential: refuse,
	};
	const broker = new CloudSecretBroker({ authority: brokerAuthority, keyring: f.keyring, adapters: [] });
	const runtimeToken = randomBytes(32).toString("base64url");
	const withLogins = new HttpCloudSecretBrokerService(broker, runtimeToken, {
		modelLogins: new CloudModelLoginVault({ authority: f.authority, keyring: f.keyring }),
	});
	const without = new HttpCloudSecretBrokerService(broker, runtimeToken, {});
	services.push(withLogins, without);
	const port = await withLogins.start();
	const post = (servicePort: number, authorization: string) =>
		fetch(`http://127.0.0.1:${servicePort}/v1/model-logins?company=${f.companyId}`, {
			method: "POST",
			headers: { authorization, "content-type": "application/json" },
			body: JSON.stringify({ schema: "qorpera.model-login-request/v1", binding: f.run, knownVersion: null }),
		});
	expect((await post(port, `Bearer ${randomBytes(32).toString("base64url")}`)).status).toBe(404);
	expect((await post(await without.start(), `Bearer ${runtimeToken}`)).status).toBe(404);
	const served = await post(port, `Bearer ${runtimeToken}`);
	expect(served.status).toBe(200);
	expect(served.headers.get("cache-control")).toBe("no-store");
	expect(served.headers.get("access-control-allow-origin")).toBeNull();
	const text = await served.text();
	expect(text).not.toContain("rt-stored");
	const client = await issueModelLogin(
		{ origin: `http://127.0.0.1:${port}`, runtimeToken, companyId: f.companyId, allowLoopback: true },
		{ binding: f.run, knownVersion: null },
		new AbortController().signal,
	);
	expect(client).toEqual(JSON.parse(text));
	for (const body of [
		{ schema: "qorpera.model-login-request/v2", binding: f.run, knownVersion: null },
		{ schema: "qorpera.model-login-request/v1", binding: f.run, knownVersion: 0 },
		{ schema: "qorpera.model-login-request/v1", binding: { ...f.run, model: "gpt" }, knownVersion: null },
		{ schema: "qorpera.model-login-request/v1", binding: f.run, knownVersion: null, extra: true },
	]) {
		const invalid = await fetch(`http://127.0.0.1:${port}/v1/model-logins?company=${f.companyId}`, {
			method: "POST",
			headers: { authorization: `Bearer ${runtimeToken}`, "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		expect(invalid.status).toBe(403);
	}
	f.authority.issueModelLogin.mockRejectedValueOnce(new Error("model login run binding is unavailable"));
	const refused = await post(port, `Bearer ${runtimeToken}`);
	expect(refused.status).toBe(403);
	expect(await refused.json()).toEqual({ schema: "qorpera.cloud-secret-error/v1", error: "unavailable" });
	f.keyring.close();
});
