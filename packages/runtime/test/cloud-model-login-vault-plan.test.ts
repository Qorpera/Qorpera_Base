import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	CHATGPT_PLAN_LOGIN_FIELD,
	type ChatGptPlanLogin,
	ChatGptPlanOAuth,
	parseChatGptPlanLogin,
	serializeChatGptPlanLogin,
} from "@qorpera/runtime/cloud-chatgpt-plan";
import {
	CloudModelLoginVault,
	type ModelLoginAuthority,
	type ModelLoginRunBinding,
} from "@qorpera/runtime/cloud-model-login-vault";
import { CloudSecretKeyring, withCloudSecretFields } from "@qorpera/runtime/cloud-secret-crypto";
import { afterEach, expect, it, vi } from "vitest";
import { fakeOpenAi } from "./fixtures/chatgpt-plan-openai.ts";

const keyrings: CloudSecretKeyring[] = [];
afterEach(() => {
	for (const keyring of keyrings.splice(0)) keyring.close();
});

const HOST = "urn:uuid:3d2c6a1e-7b4f-4c55-9a1e-2f6b8c9d0e1f";
const signal = () => new AbortController().signal;

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

/** A plan login the vault keeps as version 3, OpenAI's fake behind it, and the database's answers. */
function fixture(options: { renewal?: boolean; unchanged?: boolean; idle?: boolean; revocation?: boolean } = {}) {
	const openai = fakeOpenAi();
	const keyId = "company-kek-1";
	const wrappingKey = randomBytes(32);
	const keyring = new CloudSecretKeyring({ [keyId]: wrappingKey });
	keyrings.push(keyring);
	const run = binding();
	const loginId = randomUUID();
	const companyId = randomUUID();
	const tokens = openai.issueRefreshToken("user-abc");
	const now = Date.now();
	const stored: ChatGptPlanLogin = {
		clientId: openai.clientId,
		subject: "user-abc",
		email: "member@example.test",
		hostId: HOST,
		idToken: null,
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token,
		scopes: String(tokens.scope).split(" "),
		accessIssuedAt: new Date(now - 40 * 60_000).toISOString(),
		accessExpiresAt: new Date(now + 20 * 60_000).toISOString(),
		renewNotBefore: null,
	};
	const identity = { companyId, environmentId: run.computeIdentityId, secretId: loginId, keyId };
	const envelope = keyring.seal(
		{ [CHATGPT_PLAN_LOGIN_FIELD]: serializeChatGptPlanLogin(stored) },
		{ ...identity, version: 3 },
	);
	const renewalToken = randomUUID();
	const sealed = {
		keyId,
		encryptedEnvelopeBase64: Buffer.from(envelope).toString("base64"),
		envelopeSha256: createHash("sha256").update(envelope).digest("hex"),
	};
	const authority: ModelLoginAuthority & { [K in keyof ModelLoginAuthority]: ReturnType<typeof vi.fn> } = {
		issueModelLogin: vi.fn(async () =>
			options.unchanged
				? {
						schema: "qorpera.model-login-issue/v1",
						loginId,
						loginKind: "chatgpt_plan",
						companyId,
						computeIdentityId: run.computeIdentityId,
						version: 3,
						accessIssuedAt: stored.accessIssuedAt,
						accessExpiresAt: stored.accessExpiresAt,
						renewing: false,
						unchanged: true,
					}
				: {
						schema: "qorpera.model-login-issue/v1",
						loginId,
						loginKind: "chatgpt_plan",
						companyId,
						computeIdentityId: run.computeIdentityId,
						version: 3,
						...sealed,
						accessIssuedAt: stored.accessIssuedAt,
						accessExpiresAt: stored.accessExpiresAt,
						renewing: false,
						unchanged: false,
						renewal: options.renewal ? { token: renewalToken, baseVersion: 3, keyId } : null,
					},
		),
		commitModelLoginRenewal: vi.fn(async () => {
			throw new Error("a plan renewal is never saved as a Codex one");
		}),
		commitChatGptPlanRenewal: vi.fn(async (renewal: { baseVersion: number }) => ({
			schema: "qorpera.model-login-renewal/v1",
			loginId,
			version: renewal.baseVersion + 1,
		})),
		releaseModelLoginRenewal: vi.fn(async () => ({
			schema: "qorpera.model-login-renewal-release/v1",
			released: true,
		})),
		takeIdleModelLoginRenewal: vi.fn(async () =>
			options.idle
				? {
						schema: "qorpera.model-login-idle-renewal/v1",
						loginId,
						loginKind: "chatgpt_plan",
						companyId,
						computeIdentityId: run.computeIdentityId,
						version: 3,
						...sealed,
						accessIssuedAt: stored.accessIssuedAt,
						accessExpiresAt: stored.accessExpiresAt,
						renewal: { token: renewalToken, baseVersion: 3, keyId },
					}
				: { schema: "qorpera.model-login-idle-renewal/v1", renewal: null },
		),
		listModelLoginsWithoutAccount: vi.fn(async () => ({ schema: "qorpera.model-login-accounts/v1", logins: [] })),
		recordModelLoginAccount: vi.fn(async () => undefined),
		switchOffReplacedNodeLogins: vi.fn(async () => undefined),
		takeChatGptPlanRevocation: vi.fn(async () =>
			options.revocation
				? {
						schema: "qorpera.chatgpt-plan-revocation/v1",
						loginId,
						companyId,
						computeIdentityId: run.computeIdentityId,
						version: 3,
						...sealed,
						revocation: { token: renewalToken, baseVersion: 3 },
					}
				: { schema: "qorpera.chatgpt-plan-revocation/v1", revocation: null },
		),
		finishChatGptPlanRevocation: vi.fn(async () => ({
			schema: "qorpera.chatgpt-plan-revocation-finished/v1",
			loginId,
			status: "revoked",
		})),
	};
	const oauth = new ChatGptPlanOAuth({ client: openai.client, fetch: openai.fetch });
	return { openai, oauth, keyring, wrappingKey, run, loginId, companyId, identity, stored, renewalToken, authority };
}

it("hands a run the plan login's access token alone, never its refresh token", async () => {
	const f = fixture();
	const vault = new CloudModelLoginVault({ authority: f.authority, keyring: f.keyring, chatGptPlan: f.oauth });
	const login = await vault.issue({ binding: f.run, knownVersion: null }, signal());
	expect(login).toEqual({
		schema: "qorpera.model-login/v1",
		loginKind: "chatgpt_plan",
		version: 3,
		accessExpiresAt: f.stored.accessExpiresAt,
		accessToken: f.stored.accessToken,
	});
	expect(JSON.stringify(login)).not.toContain(f.stored.refreshToken);
	// With a plan client the vault may renew, so it asks for the lock.
	expect(f.authority.issueModelLogin).toHaveBeenCalledWith(f.run, null, true, expect.any(AbortSignal));
	const unchanged = fixture({ unchanged: true });
	await expect(
		new CloudModelLoginVault({ authority: unchanged.authority, keyring: unchanged.keyring }).issue(
			{ binding: unchanged.run, knownVersion: 3 },
			signal(),
		),
	).resolves.toEqual({
		schema: "qorpera.model-login/v1",
		loginKind: "chatgpt_plan",
		version: 3,
		accessExpiresAt: unchanged.stored.accessExpiresAt,
		accessToken: null,
	});
});

it("renews a plan login under the lock: OpenAI rotates the refresh token, the vault seals and saves version 4", async () => {
	const f = fixture({ renewal: true });
	const vault = new CloudModelLoginVault({ authority: f.authority, keyring: f.keyring, chatGptPlan: f.oauth });
	const login = await vault.issue({ binding: f.run, knownVersion: null }, signal());
	expect(login).toMatchObject({ loginKind: "chatgpt_plan", version: 4 });
	expect("accessToken" in login && login.accessToken).not.toBe(f.stored.accessToken);
	expect(f.openai.spent.has(f.stored.refreshToken)).toBe(true);
	const saved = f.authority.commitChatGptPlanRenewal.mock.calls[0]?.[0] as {
		token: string;
		baseVersion: number;
		encryptedEnvelope: Uint8Array;
		renewNotBefore: string | null;
	};
	expect(saved).toMatchObject({ token: f.renewalToken, baseVersion: 3 });
	expect(saved.renewNotBefore).not.toBeNull();
	const renewed = await withCloudSecretFields(
		saved.encryptedEnvelope,
		f.wrappingKey,
		{ ...f.identity, version: 4 },
		async (fields) => parseChatGptPlanLogin(fields[CHATGPT_PLAN_LOGIN_FIELD] as string),
	);
	expect(renewed.subject).toBe("user-abc");
	expect(renewed.refreshToken).not.toBe(f.stored.refreshToken);
	expect(f.openai.refreshTokens.has(renewed.refreshToken)).toBe(true);
	expect(f.authority.releaseModelLoginRenewal).not.toHaveBeenCalled();
});

it("gives the lock back on a refusal, marking the login for a new sign-in only when OpenAI refused the token", async () => {
	const refused = fixture({ renewal: true });
	refused.openai.behaviour.tokenAnswer = { status: 400, body: { error: "refresh_token_reused" } };
	const vault = new CloudModelLoginVault({
		authority: refused.authority,
		keyring: refused.keyring,
		chatGptPlan: refused.oauth,
	});
	// The run still gets the pass it has.
	await expect(vault.issue({ binding: refused.run, knownVersion: null }, signal())).resolves.toMatchObject({
		version: 3,
	});
	expect(refused.authority.releaseModelLoginRenewal).toHaveBeenCalledWith(
		expect.objectContaining({ permanent: true, reason: "refresh_refused", baseVersion: 3 }),
		expect.any(AbortSignal),
	);
	const outage = fixture({ renewal: true });
	outage.openai.behaviour.tokenAnswer = { status: 503, body: { error: "temporarily_unavailable" } };
	await new CloudModelLoginVault({
		authority: outage.authority,
		keyring: outage.keyring,
		chatGptPlan: outage.oauth,
	}).issue({ binding: outage.run, knownVersion: null }, signal());
	expect(outage.authority.releaseModelLoginRenewal).toHaveBeenCalledWith(
		expect.objectContaining({ permanent: false, reason: "provider_unavailable" }),
		expect.any(AbortSignal),
	);
	// A vault without a plan client cannot renew a plan login: it gives the lock back at once.
	const clientless = fixture({ renewal: true });
	await new CloudModelLoginVault({
		authority: clientless.authority,
		keyring: clientless.keyring,
		renewer: { renew: vi.fn() },
	}).issue({ binding: clientless.run, knownVersion: null }, signal());
	expect(clientless.authority.releaseModelLoginRenewal).toHaveBeenCalledWith(
		expect.objectContaining({ permanent: false, reason: "renewer_unavailable" }),
		expect.any(AbortSignal),
	);
	expect(clientless.openai.requests).toHaveLength(0);
});

it("marks the login for a new sign-in when a renewal OpenAI made cannot be saved", async () => {
	const f = fixture({ renewal: true });
	f.authority.commitChatGptPlanRenewal.mockRejectedValue(new Error("database unavailable"));
	const vault = new CloudModelLoginVault({ authority: f.authority, keyring: f.keyring, chatGptPlan: f.oauth });
	const login = await vault.issue({ binding: f.run, knownVersion: null }, signal());
	// This run keeps the newest pass, under the old version number.
	expect(login).toMatchObject({ version: 3 });
	expect("accessToken" in login && login.accessToken).not.toBe(f.stored.accessToken);
	expect(f.authority.commitChatGptPlanRenewal).toHaveBeenCalledTimes(3);
	expect(f.authority.releaseModelLoginRenewal).toHaveBeenCalledWith(
		expect.objectContaining({ permanent: true, reason: "renewal_unsaved" }),
		expect.any(AbortSignal),
	);
});

it("ends a renewal whose pass is not later than the saved one: a new sign-in, and the new token ended at OpenAI", async () => {
	const f = fixture({ renewal: true });
	// OpenAI spends the old refresh token but answers with a pass ending before the one the vault holds.
	f.openai.behaviour.accessLifeSeconds = 60;
	const vault = new CloudModelLoginVault({ authority: f.authority, keyring: f.keyring, chatGptPlan: f.oauth });
	await expect(vault.issue({ binding: f.run, knownVersion: null }, signal())).resolves.toMatchObject({ version: 3 });
	expect(f.openai.spent.has(f.stored.refreshToken)).toBe(true);
	expect(f.authority.commitChatGptPlanRenewal).not.toHaveBeenCalled();
	expect(f.authority.releaseModelLoginRenewal).toHaveBeenCalledWith(
		expect.objectContaining({ permanent: true, reason: "renewal_invalid", baseVersion: 3 }),
		expect.any(AbortSignal),
	);
	expect(f.openai.revoked.size).toBe(1);
	expect(f.openai.refreshTokens.size).toBe(0);
});

it("renews an idle plan login the same way", async () => {
	const f = fixture({ idle: true });
	const vault = new CloudModelLoginVault({ authority: f.authority, keyring: f.keyring, chatGptPlan: f.oauth });
	await expect(vault.renewIdle(signal())).resolves.toBe("renewed");
	expect(f.authority.commitChatGptPlanRenewal).toHaveBeenCalledOnce();
	// Without a Codex renewer or a plan client the vault renews nothing and takes no lock.
	const idle = fixture({ idle: true });
	await expect(
		new CloudModelLoginVault({ authority: idle.authority, keyring: idle.keyring }).renewIdle(signal()),
	).resolves.toBe("none");
	expect(idle.authority.takeIdleModelLoginRenewal).not.toHaveBeenCalled();
});

it("ends an unused plan login at OpenAI before marking it revoked, and leaves it when OpenAI cannot be reached", async () => {
	const f = fixture({ revocation: true });
	const vault = new CloudModelLoginVault({ authority: f.authority, keyring: f.keyring, chatGptPlan: f.oauth });
	await expect(vault.revokeUnused(signal())).resolves.toBe("revoked");
	expect(f.openai.revoked.has(f.stored.refreshToken)).toBe(true);
	expect(f.authority.finishChatGptPlanRevocation).toHaveBeenCalledWith(
		{ loginId: f.loginId, token: f.renewalToken, baseVersion: 3 },
		expect.any(AbortSignal),
	);
	const unreachable = fixture({ revocation: true });
	unreachable.openai.behaviour.revocationStatus = 503;
	await expect(
		new CloudModelLoginVault({
			authority: unreachable.authority,
			keyring: unreachable.keyring,
			chatGptPlan: unreachable.oauth,
		}).revokeUnused(signal()),
	).resolves.toBe("failed");
	expect(unreachable.authority.finishChatGptPlanRevocation).not.toHaveBeenCalled();
	const none = fixture();
	await expect(
		new CloudModelLoginVault({
			authority: none.authority,
			keyring: none.keyring,
			chatGptPlan: none.oauth,
		}).revokeUnused(signal()),
	).resolves.toBe("none");
	// Without a plan client nothing is taken.
	const clientless = fixture({ revocation: true });
	await expect(
		new CloudModelLoginVault({ authority: clientless.authority, keyring: clientless.keyring }).revokeUnused(signal()),
	).resolves.toBe("none");
	expect(clientless.authority.takeChatGptPlanRevocation).not.toHaveBeenCalled();
});

it("refuses an envelope of another kind than the database names, giving the lock back", async () => {
	const f = fixture({ renewal: true });
	const answer = (await f.authority.issueModelLogin(f.run, null, true, signal())) as Record<string, unknown>;
	f.authority.issueModelLogin.mockResolvedValue({
		...answer,
		loginKind: "codex",
		computeIdentityId: f.run.computeIdentityId,
	});
	const vault = new CloudModelLoginVault({ authority: f.authority, keyring: f.keyring, chatGptPlan: f.oauth });
	await expect(vault.issue({ binding: f.run, knownVersion: null }, signal())).rejects.toThrow();
	expect(f.authority.releaseModelLoginRenewal).toHaveBeenCalledWith(
		expect.objectContaining({ permanent: false, reason: "login_unreadable" }),
		expect.any(AbortSignal),
	);
});
