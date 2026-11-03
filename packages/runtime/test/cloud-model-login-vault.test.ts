import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	accessOnlyCodexLogin,
	CloudModelLoginVault,
	MODEL_LOGIN_FIELD,
	type ModelLoginAuthority,
	type ModelLoginCodexIssue,
	type ModelLoginRenewer,
	type ModelLoginRunBinding,
	parseCodexLogin,
} from "@qorpera/runtime/cloud-model-login-vault";
import { CloudSecretBroker, type CloudSecretBrokerAuthority } from "@qorpera/runtime/cloud-secret-broker";
import { HttpCloudSecretBrokerService, issueModelLogin } from "@qorpera/runtime/cloud-secret-broker-http";
import { CloudSecretKeyring, withCloudSecretFields } from "@qorpera/runtime/cloud-secret-crypto";
import {
	CloudSecretBrokerBusyError,
	markCloudVaultDatabaseFailure,
} from "@qorpera/runtime/cloud-vault-database-failure";
import { DatabaseError } from "pg";
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
	/** The idle take hands over this login (else no login is due). */
	idle?: boolean;
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
		takeIdleModelLoginRenewal: vi.fn(async () => {
			if (!options.idle) return { schema: "qorpera.model-login-idle-renewal/v1", renewal: null };
			const answer: Record<string, unknown> = {
				schema: "qorpera.model-login-idle-renewal/v1",
				loginId,
				companyId,
				computeIdentityId: run.computeIdentityId,
				version: 3,
				keyId,
				encryptedEnvelopeBase64: Buffer.from(envelope).toString("base64"),
				envelopeSha256: options.envelopeSha256 ?? createHash("sha256").update(envelope).digest("hex"),
				accessIssuedAt: stored.accessIssuedAt,
				accessExpiresAt: stored.accessExpiresAt,
				renewal: { token: renewalToken, baseVersion: 3, keyId },
			};
			return options.change ? options.change(answer) : answer;
		}),
		listModelLoginsWithoutAccount: vi.fn(async () => ({
			schema: "qorpera.model-login-accounts/v1",
			logins: [
				{
					loginId,
					companyId,
					computeIdentityId: run.computeIdentityId,
					version: 3,
					keyId,
					encryptedEnvelopeBase64: Buffer.from(envelope).toString("base64"),
					envelopeSha256: createHash("sha256").update(envelope).digest("hex"),
				},
			],
		})),
		recordModelLoginAccount: vi.fn(async (account: { loginId: string }) => ({
			schema: "qorpera.model-login-account/v1",
			loginId: account.loginId,
			recorded: true,
		})),
		switchOffReplacedNodeLogins: vi.fn(async () => ({
			schema: "qorpera.model-login-switch-off/v1",
			switchedOff: 1,
			waiting: 2,
			refused: 0,
		})),
		commitChatGptPlanRenewal: vi.fn(async () => undefined),
		takeChatGptPlanRevocation: vi.fn(async () => undefined),
		finishChatGptPlanRevocation: vi.fn(async () => undefined),
	};
	return { authority, keyring, wrappingKey, run, loginId, companyId, identity, renewalToken, envelope };
}

function tokens(text: string): Record<string, string> {
	return (JSON.parse(text) as { tokens: Record<string, string> }).tokens;
}

it("hands a run the stored login without its renewal token", async () => {
	const stored = codexLogin({ ageSeconds: 60, lifeSeconds: 864_000, refresh: "rt-stored" });
	const f = fixture({ stored });
	const vault = new CloudModelLoginVault({ authority: f.authority, keyring: f.keyring });
	const login = (await vault.issue(
		{ binding: f.run, knownVersion: null },
		new AbortController().signal,
	)) as ModelLoginCodexIssue;
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
	const login = (await vault.issue(
		{ binding: f.run, knownVersion: 3 },
		new AbortController().signal,
	)) as ModelLoginCodexIssue;
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
	const login = (await vault.issue(
		{ binding: f.run, knownVersion: null },
		new AbortController().signal,
	)) as ModelLoginCodexIssue;
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
		const login = (await vault.issue(
			{ binding: f.run, knownVersion: null },
			new AbortController().signal,
		)) as ModelLoginCodexIssue;
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
	const login = (await vault.issue(
		{ binding: f.run, knownVersion: null },
		new AbortController().signal,
	)) as ModelLoginCodexIssue;
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
	const login = (await vault.issue(
		{ binding: f.run, knownVersion: null },
		new AbortController().signal,
	)) as ModelLoginCodexIssue;
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
	const login = (await vault.issue(
		{ binding: lost.run, knownVersion: null },
		new AbortController().signal,
	)) as ModelLoginCodexIssue;
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

it("renews an idle login under the lock it takes and saves the next version for that login", async () => {
	const stored = codexLogin({ ageSeconds: 500_000, lifeSeconds: 864_000, refresh: "rt-old" });
	const renewed = codexLogin({ ageSeconds: 0, lifeSeconds: 864_000, refresh: "rt-new" });
	const f = fixture({ stored, idle: true });
	const renewer: ModelLoginRenewer = {
		renew: vi.fn(async () => ({ outcome: "renewed" as const, authJson: renewed })),
	};
	const vault = new CloudModelLoginVault({ authority: f.authority, keyring: f.keyring, renewer });
	await expect(vault.renewIdle(new AbortController().signal)).resolves.toBe("renewed");
	expect(renewer.renew).toHaveBeenCalledWith(stored, expect.any(AbortSignal));
	expect(f.authority.issueModelLogin).not.toHaveBeenCalled();
	const commit = vi.mocked(f.authority.commitModelLoginRenewal).mock.calls[0]?.[0] as {
		loginId: string;
		token: string;
		baseVersion: number;
		encryptedEnvelope: Uint8Array;
		accessExpiresAt: string;
	};
	expect(commit).toMatchObject({
		loginId: f.loginId,
		token: f.renewalToken,
		baseVersion: 3,
		accessExpiresAt: parseCodexLogin(renewed).accessExpiresAt,
	});
	await expect(
		withCloudSecretFields(commit.encryptedEnvelope, f.wrappingKey, { ...f.identity, version: 4 }, async (fields) =>
			tokens(fields[MODEL_LOGIN_FIELD] as string),
		),
	).resolves.toMatchObject({ refresh_token: "rt-new" });
	expect(f.authority.releaseModelLoginRenewal).not.toHaveBeenCalled();
});

it("takes no idle login when none is due or without a renewer", async () => {
	const stored = codexLogin({ ageSeconds: 60, lifeSeconds: 864_000, refresh: "rt" });
	const renewer: ModelLoginRenewer = { renew: vi.fn() };
	const due = fixture({ stored });
	await expect(
		new CloudModelLoginVault({ authority: due.authority, keyring: due.keyring, renewer }).renewIdle(
			new AbortController().signal,
		),
	).resolves.toBe("none");
	expect(due.authority.takeIdleModelLoginRenewal).toHaveBeenCalledTimes(1);
	const bare = fixture({ stored, idle: true });
	await expect(
		new CloudModelLoginVault({ authority: bare.authority, keyring: bare.keyring }).renewIdle(
			new AbortController().signal,
		),
	).resolves.toBe("none");
	expect(bare.authority.takeIdleModelLoginRenewal).not.toHaveBeenCalled();
	expect(renewer.renew).not.toHaveBeenCalled();
});

it("gives an idle login's lock back when the renewal is refused, fails or the answer is unreadable", async () => {
	const stored = codexLogin({ ageSeconds: 500_000, lifeSeconds: 864_000, refresh: "rt-old" });
	const refused = fixture({ stored, idle: true });
	const refusing: ModelLoginRenewer = {
		renew: vi.fn(async () => ({ outcome: "refused" as const, reason: "refresh_token_reused" })),
	};
	await expect(
		new CloudModelLoginVault({ authority: refused.authority, keyring: refused.keyring, renewer: refusing }).renewIdle(
			new AbortController().signal,
		),
	).resolves.toBe("failed");
	expect(refused.authority.releaseModelLoginRenewal).toHaveBeenCalledWith(
		{
			loginId: refused.loginId,
			token: refused.renewalToken,
			baseVersion: 3,
			permanent: true,
			reason: "refresh_token_reused",
		},
		expect.any(AbortSignal),
	);
	expect(refused.authority.commitModelLoginRenewal).not.toHaveBeenCalled();

	const renewer: ModelLoginRenewer = { renew: vi.fn() };
	const tampered = fixture({ stored, idle: true, envelopeSha256: "0".repeat(64) });
	await expect(
		new CloudModelLoginVault({ authority: tampered.authority, keyring: tampered.keyring, renewer }).renewIdle(
			new AbortController().signal,
		),
	).rejects.toThrow("Model login envelope is invalid");
	expect(tampered.authority.releaseModelLoginRenewal).toHaveBeenCalledWith(
		{
			loginId: tampered.loginId,
			token: tampered.renewalToken,
			baseVersion: 3,
			permanent: false,
			reason: "issue_unreadable",
		},
		expect.any(AbortSignal),
	);

	const otherVersion = fixture({
		stored,
		idle: true,
		change: (answer) => ({ ...answer, renewal: { ...(answer.renewal as object), baseVersion: 2 } }),
	});
	await expect(
		new CloudModelLoginVault({ authority: otherVersion.authority, keyring: otherVersion.keyring, renewer }).renewIdle(
			new AbortController().signal,
		),
	).rejects.toThrow("Model login renewal is invalid");

	// A login sealed for another login id cannot be opened: the lock goes back, nothing is renewed.
	const unreadable = fixture({ stored, idle: true, change: (answer) => ({ ...answer, loginId: randomUUID() }) });
	await expect(
		new CloudModelLoginVault({ authority: unreadable.authority, keyring: unreadable.keyring, renewer }).renewIdle(
			new AbortController().signal,
		),
	).resolves.toBe("failed");
	expect(vi.mocked(unreadable.authority.releaseModelLoginRenewal).mock.calls[0]?.[0]).toMatchObject({
		permanent: false,
		reason: "login_unreadable",
	});
	expect(renewer.renew).not.toHaveBeenCalled();
});

it("records a login's ChatGPT account from its current version, as nodes record it", async () => {
	const stored = codexLogin({ ageSeconds: 60, lifeSeconds: 864_000, refresh: "rt", account: "account-7" });
	const f = fixture({ stored });
	const vault = new CloudModelLoginVault({ authority: f.authority, keyring: f.keyring });
	await expect(vault.recordAccounts(new AbortController().signal)).resolves.toBe(1);
	expect(f.authority.recordModelLoginAccount).toHaveBeenCalledWith(
		{
			loginId: f.loginId,
			accountIdentity: createHash("sha256").update("openai-account:").update("account-7").digest("hex"),
		},
		expect.any(AbortSignal),
	);

	// A login sealed for another login cannot be opened: it is skipped, and nothing is recorded.
	f.authority.listModelLoginsWithoutAccount.mockResolvedValueOnce({
		schema: "qorpera.model-login-accounts/v1",
		logins: [
			{
				loginId: randomUUID(),
				companyId: f.companyId,
				computeIdentityId: f.run.computeIdentityId,
				version: 3,
				keyId: "company-kek-1",
				encryptedEnvelopeBase64: Buffer.from(f.envelope).toString("base64"),
				envelopeSha256: createHash("sha256").update(f.envelope).digest("hex"),
			},
		],
	});
	f.authority.recordModelLoginAccount.mockClear();
	await expect(vault.recordAccounts(new AbortController().signal)).resolves.toBe(0);
	expect(f.authority.recordModelLoginAccount).not.toHaveBeenCalled();
	f.authority.listModelLoginsWithoutAccount.mockResolvedValueOnce({ schema: "other", logins: [] });
	await expect(vault.recordAccounts(new AbortController().signal)).rejects.toThrow("Model login accounts are invalid");
});

it("reads one switch-off pass and refuses an answer it does not know", async () => {
	const f = fixture({ stored: codexLogin({ ageSeconds: 60, lifeSeconds: 864_000, refresh: "rt" }) });
	const vault = new CloudModelLoginVault({ authority: f.authority, keyring: f.keyring });
	await expect(vault.switchOffReplacedNodeLogins(new AbortController().signal)).resolves.toEqual({
		switchedOff: 1,
		waiting: 2,
		refused: 0,
	});
	for (const answer of [
		{ schema: "qorpera.model-login-switch-off/v1", switchedOff: -1, waiting: 0, refused: 0 },
		{ schema: "qorpera.model-login-switch-off/v1", switchedOff: 0, waiting: 5, refused: 0 },
		{ schema: "other", switchedOff: 0, waiting: 0, refused: 0 },
	]) {
		f.authority.switchOffReplacedNodeLogins.mockResolvedValueOnce(answer);
		await expect(vault.switchOffReplacedNodeLogins(new AbortController().signal)).rejects.toThrow(
			"Model login switch-off is invalid",
		);
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
	// G2-6a: only the run's own lease proves its binding (the database's proof stands in here).
	const holder = `job.${f.run.jobId.toLowerCase()}.${randomBytes(32).toString("base64url")}`;
	const withLogins = new HttpCloudSecretBrokerService(broker, runtimeToken, {
		modelLogins: new CloudModelLoginVault({ authority: f.authority, keyring: f.keyring }),
		proveBinding: async (binding, presented) => {
			if (presented !== holder || (binding as { jobId?: string }).jobId !== f.run.jobId)
				throw new Error("native binding proof is refused");
		},
	});
	const without = new HttpCloudSecretBrokerService(broker, runtimeToken, {});
	services.push(withLogins, without);
	const port = await withLogins.start();
	// `null` sends no holder (an omitted argument sends the run's own).
	const post = (servicePort: number, authorization: string, identity: string | null = holder) =>
		fetch(`http://127.0.0.1:${servicePort}/v1/model-logins?company=${f.companyId}`, {
			method: "POST",
			headers: {
				authorization,
				"content-type": "application/json",
				...(identity === null ? {} : { "x-qorpera-identity": identity }),
			},
			body: JSON.stringify({ schema: "qorpera.model-login-request/v1", binding: f.run, knownVersion: null }),
		});
	expect((await post(port, `Bearer ${randomBytes(32).toString("base64url")}`)).status).toBe(404);
	// Without the run's own lease no login is handed out, and the vault is not even asked.
	for (const identity of [null, `job.${f.run.jobId.toLowerCase()}.${"w".repeat(43)}`]) {
		const refused = await post(port, `Bearer ${runtimeToken}`, identity);
		expect(refused.status).toBe(403);
	}
	expect(f.authority.issueModelLogin).not.toHaveBeenCalled();
	expect((await post(await without.start(), `Bearer ${runtimeToken}`)).status).toBe(404);
	const served = await post(port, `Bearer ${runtimeToken}`);
	expect(served.status).toBe(200);
	expect(served.headers.get("cache-control")).toBe("no-store");
	expect(served.headers.get("access-control-allow-origin")).toBeNull();
	const text = await served.text();
	expect(text).not.toContain("rt-stored");
	const client = await issueModelLogin(
		{
			origin: `http://127.0.0.1:${port}`,
			runtimeToken,
			companyId: f.companyId,
			holder: () => holder,
			allowLoopback: true,
		},
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
			headers: {
				authorization: `Bearer ${runtimeToken}`,
				"content-type": "application/json",
				"x-qorpera-identity": holder,
			},
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

it("answers 503 busy when the database could not serve the call, which the host takes for a lost answer, and 403 for a refusal", async () => {
	const f = fixture({ stored: codexLogin({ ageSeconds: 60, lifeSeconds: 864_000, refresh: "rt-stored" }) });
	const refuse = vi.fn(async () => {
		throw new Error("not in this test");
	});
	const broker = new CloudSecretBroker({
		authority: {
			describeCapture: refuse,
			completeCapture: refuse,
			authorizeOperation: refuse,
			authorizeRepositoryCredential: refuse,
		},
		keyring: f.keyring,
		adapters: [],
	});
	const runtimeToken = randomBytes(32).toString("base64url");
	const holder = `job.${f.run.jobId.toLowerCase()}.${randomBytes(32).toString("base64url")}`;
	const proveBinding = vi.fn(async (_binding: object, _holder: string) => undefined);
	const service = new HttpCloudSecretBrokerService(broker, runtimeToken, {
		modelLogins: new CloudModelLoginVault({ authority: f.authority, keyring: f.keyring }),
		proveBinding,
	});
	services.push(service);
	const port = await service.start();
	const issue = () =>
		issueModelLogin(
			{
				origin: `http://127.0.0.1:${port}`,
				runtimeToken,
				companyId: f.companyId,
				holder: () => holder,
				allowLoopback: true,
			},
			{ binding: f.run, knownVersion: null },
			new AbortController().signal,
		);
	const post = () =>
		fetch(`http://127.0.0.1:${port}/v1/model-logins?company=${f.companyId}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${runtimeToken}`,
				"content-type": "application/json",
				"x-qorpera-identity": holder,
			},
			body: JSON.stringify({ schema: "qorpera.model-login-request/v1", binding: f.run, knownVersion: null }),
		});
	const secret = "PRIVATE_LOGIN_6f0c";
	// The server's answer carries its source routine; the pooler's own (Supavisor) is FATAL and has none.
	const sqlError = (code: string) =>
		Object.assign(new DatabaseError(`server said ${secret}`, 0, "error"), {
			code,
			severity: "ERROR",
			routine: "exec_stmt_raise",
		});
	const poolerError = (code: string) =>
		Object.assign(new DatabaseError(`pooler said ${secret}`, 0, "error"), { code, severity: "FATAL" });
	const system = (code: string) => Object.assign(new Error(`connect ${code} ${secret}`), { code });
	const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
	// What the vault's database client and its 5 s deadline throw when the database could not serve the call.
	for (const [label, failure, logged] of [
		["session ended", sqlError("57P01"), "57P01"],
		["connection lost", sqlError("08006"), "08006"],
		["too many connections", sqlError("53300"), "53300"],
		["statement timeout", sqlError("57014"), "57014"],
		["pooler failure", poolerError("XX000"), "XX000"],
		["pooler session limit", poolerError("08P01"), "08P01"],
		["pool wait", new Error("timeout exceeded when trying to connect"), "pool timeout"],
		["connect timeout", new Error("Connection terminated due to connection timeout"), "connect timeout"],
		["socket", system("ECONNRESET"), "ECONNRESET"],
		["socket pipe", system("EPIPE"), "EPIPE"],
		["ended", new Error("Connection terminated unexpectedly"), "connection ended"],
		["unnamed", new Error(`pg said ${secret}`), "no sqlstate"],
	] as const) {
		log.mockClear();
		f.authority.issueModelLogin.mockRejectedValueOnce(markCloudVaultDatabaseFailure(failure));
		const busy = await post();
		expect(busy.status, label).toBe(503);
		expect(busy.headers.get("retry-after"), label).toBe("5");
		expect(busy.headers.get("cache-control"), label).toBe("no-store");
		expect(await busy.json(), label).toEqual({ schema: "qorpera.cloud-secret-error/v1", error: "busy" });
		expect(log, label).toHaveBeenCalledExactlyOnceWith(
			`Cloud secret broker: the database could not serve a request (class: ${logged}); answered busy.`,
		);
	}
	// The binding proof is a database call too, and the host's client takes the 503 for its own error.
	proveBinding.mockRejectedValueOnce(
		markCloudVaultDatabaseFailure(new Error("timeout exceeded when trying to connect")),
	);
	await expect(issue()).rejects.toBeInstanceOf(CloudSecretBrokerBusyError);
	// A call's own deadline passing is the database's too.
	f.authority.issueModelLogin.mockRejectedValueOnce(markCloudVaultDatabaseFailure(new Error("late"), "call deadline"));
	await expect(issue()).rejects.toBeInstanceOf(CloudSecretBrokerBusyError);
	log.mockClear();
	// A refusal the database raised on purpose, a failure that is not the database's (even one shaped like a lost
	// session), and the vault's own refusal stay the opaque 403, and the host's client takes them for a refusal.
	for (const [label, failure] of [
		["insufficient privilege", markCloudVaultDatabaseFailure(sqlError("42501"))],
		["not in prerequisite state", markCloudVaultDatabaseFailure(sqlError("55000"))],
		["invalid parameter", markCloudVaultDatabaseFailure(sqlError("22023"))],
		["raised", markCloudVaultDatabaseFailure(sqlError("P0001"))],
		// This repository's SQL raises XX000 on purpose for a broken invariant.
		["raised invariant", markCloudVaultDatabaseFailure(sqlError("XX000"))],
		["not the database's", sqlError("57P01")],
		["helper socket", system("ECONNREFUSED")],
		["vault refusal", new Error("Model login envelope is another kind of login")],
	] as const) {
		f.authority.issueModelLogin.mockRejectedValueOnce(failure);
		const refused = await post();
		expect(refused.status, label).toBe(403);
		expect(await refused.json(), label).toEqual({ schema: "qorpera.cloud-secret-error/v1", error: "unavailable" });
	}
	f.authority.issueModelLogin.mockRejectedValueOnce(markCloudVaultDatabaseFailure(sqlError("42501")));
	const refusal = await issue().catch((error: unknown) => error);
	expect(refusal).toBeInstanceOf(Error);
	expect(refusal).not.toBeInstanceOf(CloudSecretBrokerBusyError);
	expect(log).not.toHaveBeenCalled();
	expect(log.mock.calls.flat().join("\n")).not.toContain(secret);
	log.mockRestore();
	f.keyring.close();
});
