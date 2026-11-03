import { createHash, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import type { ModelLoginSignInHelper, ModelLoginSignInState } from "@qorpera/runtime/cloud-model-login-sign-in";
import {
	type AccountModelLoginAuthority,
	CloudModelLoginVault,
	MODEL_LOGIN_FIELD,
	type ModelLoginAuthority,
	type ModelLoginCodexIssue,
	type ModelLoginRenewer,
	type ModelLoginRunBinding,
	parseCodexLogin,
} from "@qorpera/runtime/cloud-model-login-vault";
import {
	CloudModelLoginSignIns,
	type ModelLoginSignInAuthority,
} from "@qorpera/runtime/cloud-model-login-vault-sign-in";
import { PostgresCloudSecretBrokerPrincipal, sharedBrokerCapability } from "@qorpera/runtime/cloud-secret-broker";
import { SharedCloudSecretBrokerCompanies } from "@qorpera/runtime/cloud-secret-broker-shared";
import {
	CloudSecretKeyring,
	memberEnvelopeIdentity,
	sealCloudSecretFields,
	withCloudSecretFields,
} from "@qorpera/runtime/cloud-secret-crypto";
import { afterEach, expect, it, vi } from "vitest";

/** Account model logins (20260930548000): one login per member in the shared vault, sealed under a key derived for
 * the member, handed to that member's runs in every company the vault serves and renewed by one chain only. */

const keyrings: CloudSecretKeyring[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const keyring of keyrings.splice(0)) keyring.close();
});

const signal = () => new AbortController().signal;
const KEY_ID = "vault-root-1";

function vaultKeyring(master = randomBytes(32)): { keyring: CloudSecretKeyring; master: Buffer } {
	const keyring = new CloudSecretKeyring({}, { [KEY_ID]: master });
	keyrings.push(keyring);
	return { keyring, master };
}

function jwt(claims: Record<string, unknown>): string {
	const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${part({ alg: "RS256", typ: "JWT" })}.${part(claims)}.c2lnbmF0dXJl`;
}

function codexLogin(options: { ageSeconds: number; lifeSeconds: number; refresh: string }): string {
	const iat = Math.floor(Date.now() / 1000) - options.ageSeconds;
	return `${JSON.stringify(
		{
			OPENAI_API_KEY: null,
			tokens: {
				id_token: jwt({ email: "member@example.test", iat }),
				access_token: jwt({ iat, exp: iat + options.lifeSeconds, jti: randomUUID() }),
				refresh_token: options.refresh,
				account_id: "account-1",
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

it("derives a member's key under its own label, apart from every company key, the same on both vault copies", async () => {
	const { keyring, master } = vaultKeyring();
	const member = randomUUID();
	const login = randomUUID();
	const identity = { memberId: member, loginId: login, version: 1, keyId: KEY_ID };
	const envelope = keyring.sealMember({ [MODEL_LOGIN_FIELD]: "login" }, identity);
	// HKDF-SHA256 of the master key, salt qorpera.member-kek/v1, info the member id: computed apart from the keyring.
	const memberKey = Buffer.from(hkdfSync("sha256", master, "qorpera.member-kek/v1", member, 32));
	await expect(
		withCloudSecretFields(
			envelope,
			memberKey,
			memberEnvelopeIdentity(identity),
			async (fields) => fields[MODEL_LOGIN_FIELD],
		),
	).resolves.toBe("login");
	// The other vault copy holds the same master key and opens it.
	const { keyring: copy } = vaultKeyring(Buffer.from(master));
	await expect(copy.useMember(envelope, identity, async (fields) => fields[MODEL_LOGIN_FIELD])).resolves.toBe("login");
	// Never a company's key: the company key derived for the same id opens nothing sealed for the member, and the
	// member's key opens no company envelope.
	const asCompany = { companyId: member, environmentId: member, secretId: login, version: 1, keyId: KEY_ID };
	await expect(keyring.use(envelope, asCompany, async () => "opened")).rejects.toThrow();
	const companyEnvelope = keyring.seal({ [MODEL_LOGIN_FIELD]: "login" }, asCompany);
	await expect(keyring.useMember(companyEnvelope, identity, async () => "opened")).rejects.toThrow();
	// Bound to its member and its login.
	await expect(
		keyring.useMember(envelope, { ...identity, memberId: randomUUID() }, async () => "opened"),
	).rejects.toThrow();
	await expect(
		keyring.useMember(envelope, { ...identity, loginId: randomUUID() }, async () => "opened"),
	).rejects.toThrow();
	await expect(keyring.useMember(envelope, { ...identity, version: 2 }, async () => "opened")).rejects.toThrow();
	// A company broker's own key derives no member key.
	const own = new CloudSecretKeyring({ "company-kek-1": randomBytes(32) });
	keyrings.push(own);
	expect(own.hasMemberKey("company-kek-1")).toBe(false);
	expect(keyring.hasMemberKey(KEY_ID)).toBe(true);
	expect(() => own.sealMember({ [MODEL_LOGIN_FIELD]: "login" }, { ...identity, keyId: "company-kek-1" })).toThrow(
		"Cloud secret member key is unavailable",
	);
	expect(() =>
		keyring.sealMember({ [MODEL_LOGIN_FIELD]: "login" }, { ...identity, memberId: "not-a-member" }),
	).toThrow();
	// A member envelope sealed under a key the member's derivation does not give is refused.
	const forged = sealCloudSecretFields(
		{ [MODEL_LOGIN_FIELD]: "login" },
		randomBytes(32),
		memberEnvelopeIdentity(identity),
	);
	await expect(keyring.useMember(forged, identity, async () => "opened")).rejects.toThrow();
});

/** A company broker that answers a run with the member's account login, and the vault's own account calls. */
function accountWorld(options: {
	stored: string;
	renewal?: boolean;
	change?: (answer: Record<string, unknown>) => Record<string, unknown>;
}) {
	const { keyring } = vaultKeyring();
	const run = binding();
	const member = randomUUID();
	const loginId = randomUUID();
	const companyId = randomUUID();
	const token = randomUUID();
	const envelope = keyring.sealMember(
		{ [MODEL_LOGIN_FIELD]: options.stored },
		{ memberId: member, loginId, version: 3, keyId: KEY_ID },
	);
	const stored = parseCodexLogin(options.stored);
	const answer = (): Record<string, unknown> => ({
		schema: "qorpera.model-login-issue/v1",
		loginId,
		loginKind: "codex",
		scope: "account",
		ownerUserId: member,
		companyId,
		computeIdentityId: run.computeIdentityId,
		version: 3,
		keyId: KEY_ID,
		encryptedEnvelopeBase64: Buffer.from(envelope).toString("base64"),
		envelopeSha256: createHash("sha256").update(envelope).digest("hex"),
		accessIssuedAt: stored.accessIssuedAt,
		accessExpiresAt: stored.accessExpiresAt,
		renewing: false,
		unchanged: false,
		renewal: options.renewal ? { token, baseVersion: 3, keyId: KEY_ID } : null,
	});
	const company = {
		issueModelLogin: vi.fn(async () => (options.change ? options.change(answer()) : answer())),
		commitModelLoginRenewal: vi.fn(async () => {
			throw new Error("a company broker saved an account login");
		}),
		releaseModelLoginRenewal: vi.fn(async () => {
			throw new Error("a company broker released an account login");
		}),
	} as unknown as ModelLoginAuthority & Record<string, ReturnType<typeof vi.fn>>;
	const account = {
		commitAccountModelLoginRenewal: vi.fn(async (renewal: { baseVersion: number }) => ({
			schema: "qorpera.model-login-renewal/v1",
			loginId,
			version: renewal.baseVersion + 1,
		})),
		releaseAccountModelLoginRenewal: vi.fn(async () => ({
			schema: "qorpera.model-login-renewal-release/v1",
			loginId,
			released: true,
			status: "active",
		})),
		takeIdleAccountModelLoginRenewal: vi.fn(async () => {
			const {
				scope: _scope,
				companyId: _company,
				computeIdentityId: _identity,
				renewing: _renewing,
				unchanged: _unchanged,
				...rest
			} = answer();
			return {
				...rest,
				schema: "qorpera.account-model-login-idle-renewal/v1",
				renewal: { token, baseVersion: 3, keyId: KEY_ID },
			};
		}),
		listAccountModelLoginsWithoutAccount: vi.fn(async () => ({
			schema: "qorpera.account-model-login-accounts/v1",
			logins: [
				{
					loginId,
					ownerUserId: member,
					version: 3,
					keyId: KEY_ID,
					encryptedEnvelopeBase64: Buffer.from(envelope).toString("base64"),
					envelopeSha256: createHash("sha256").update(envelope).digest("hex"),
				},
			],
		})),
		recordAccountModelLoginAccount: vi.fn(async () => ({ schema: "qorpera.model-login-account/v1", recorded: true })),
		switchOffReplacedByAccountLogins: vi.fn(async () => ({
			schema: "qorpera.model-login-switch-off/v1",
			switchedOff: 1,
			waiting: 0,
			refused: 0,
		})),
	} satisfies AccountModelLoginAuthority;
	return { keyring, run, member, loginId, token, company, account };
}

function renewer(renewed: string): ModelLoginRenewer & { renew: ReturnType<typeof vi.fn> } {
	return { renew: vi.fn(async () => ({ outcome: "renewed" as const, authJson: renewed })) };
}

it("hands a run its member's account login, opened with the member's key and never with its renewal token", async () => {
	const stored = codexLogin({ ageSeconds: 60, lifeSeconds: 864_000, refresh: "rt-account" });
	const w = accountWorld({ stored });
	const vault = new CloudModelLoginVault({ authority: w.company, accountAuthority: w.account, keyring: w.keyring });
	const login = (await vault.issue({ binding: w.run, knownVersion: null }, signal())) as ModelLoginCodexIssue;
	expect(login).toMatchObject({ schema: "qorpera.model-login/v1", version: 3 });
	expect(Object.keys(login).sort()).toEqual(["accessExpiresAt", "authJson", "schema", "version"]);
	expect(login.authJson).not.toContain("rt-account");
	expect(JSON.parse(login.authJson as string).tokens.refresh_token).toBe("");
});

it("renews an account login once and saves it with the vault's own call, sealed for the member", async () => {
	const stored = codexLogin({ ageSeconds: 600_000, lifeSeconds: 864_000, refresh: "rt-old" });
	const renewed = codexLogin({ ageSeconds: 0, lifeSeconds: 864_000, refresh: "rt-new" });
	const w = accountWorld({ stored, renewal: true });
	const vault = new CloudModelLoginVault({
		authority: w.company,
		accountAuthority: w.account,
		keyring: w.keyring,
		renewer: renewer(renewed),
	});
	const login = (await vault.issue({ binding: w.run, knownVersion: 3 }, signal())) as ModelLoginCodexIssue;
	expect(login.version).toBe(4);
	expect(w.company.commitModelLoginRenewal).not.toHaveBeenCalled();
	expect(w.account.commitAccountModelLoginRenewal).toHaveBeenCalledTimes(1);
	const saved = w.account.commitAccountModelLoginRenewal.mock.calls[0]?.[0] as {
		loginId: string;
		token: string;
		baseVersion: number;
		keyId: string;
		encryptedEnvelope: Uint8Array;
	};
	expect(saved).toMatchObject({ loginId: w.loginId, token: w.token, baseVersion: 3, keyId: KEY_ID });
	await expect(
		w.keyring.useMember(
			saved.encryptedEnvelope,
			{ memberId: w.member, loginId: w.loginId, version: 4, keyId: KEY_ID },
			async (fields) => fields[MODEL_LOGIN_FIELD],
		),
	).resolves.toBe(renewed);
});

it("gives an account login's lock back to the vault, never to a company broker, when the renewal fails", async () => {
	const stored = codexLogin({ ageSeconds: 600_000, lifeSeconds: 864_000, refresh: "rt-old" });
	const w = accountWorld({ stored, renewal: true });
	const refusing: ModelLoginRenewer = { renew: async () => ({ outcome: "refused", reason: "refresh_token_reused" }) };
	const vault = new CloudModelLoginVault({
		authority: w.company,
		accountAuthority: w.account,
		keyring: w.keyring,
		renewer: refusing,
	});
	await vault.issue({ binding: w.run, knownVersion: null }, signal());
	expect(w.company.releaseModelLoginRenewal).not.toHaveBeenCalled();
	expect(w.account.releaseAccountModelLoginRenewal).toHaveBeenCalledWith(
		{ loginId: w.loginId, token: w.token, baseVersion: 3, permanent: true, reason: "refresh_token_reused" },
		expect.any(AbortSignal),
	);
});

it("refuses an account answer it cannot trust: no vault calls, a plan login, another identity, a company key", async () => {
	const stored = codexLogin({ ageSeconds: 60, lifeSeconds: 864_000, refresh: "rt" });
	// A company broker without the shared vault's calls: refused, and its lock is left to lapse.
	const alone = accountWorld({ stored, renewal: true });
	await expect(
		new CloudModelLoginVault({ authority: alone.company, keyring: alone.keyring }).issue(
			{ binding: alone.run, knownVersion: null },
			signal(),
		),
	).rejects.toThrow("Account model logins are not served here");
	expect(alone.company.releaseModelLoginRenewal).not.toHaveBeenCalled();
	for (const change of [
		(answer: Record<string, unknown>) => ({ ...answer, loginKind: "chatgpt_plan" }),
		(answer: Record<string, unknown>) => ({ ...answer, scope: "company" }),
		(answer: Record<string, unknown>) => ({ ...answer, ownerUserId: "nobody" }),
		(answer: Record<string, unknown>) => ({ ...answer, computeIdentityId: randomUUID() }),
		(answer: Record<string, unknown>) => {
			const { scope: _scope, ...rest } = answer;
			return rest;
		},
	]) {
		const w = accountWorld({ stored, renewal: true, change });
		const vault = new CloudModelLoginVault({ authority: w.company, accountAuthority: w.account, keyring: w.keyring });
		await expect(vault.issue({ binding: w.run, knownVersion: null }, signal())).rejects.toThrow();
		expect(w.company.releaseModelLoginRenewal).not.toHaveBeenCalled();
	}
	// Sealed for another member: unreadable, and the vault gives the lock back.
	const w = accountWorld({ stored, renewal: true, change: (answer) => ({ ...answer, ownerUserId: randomUUID() }) });
	const vault = new CloudModelLoginVault({ authority: w.company, accountAuthority: w.account, keyring: w.keyring });
	await expect(vault.issue({ binding: w.run, knownVersion: null }, signal())).rejects.toThrow();
	expect(w.account.releaseAccountModelLoginRenewal).toHaveBeenCalledWith(
		expect.objectContaining({ loginId: w.loginId, token: w.token, permanent: false, reason: "login_unreadable" }),
		expect.any(AbortSignal),
	);
});

it("runs the vault's one account pass: idle renewal, accounts and the switch-off, all on its own calls", async () => {
	const stored = codexLogin({ ageSeconds: 600_000, lifeSeconds: 864_000, refresh: "rt-old" });
	const renewed = codexLogin({ ageSeconds: 0, lifeSeconds: 864_000, refresh: "rt-new" });
	const w = accountWorld({ stored });
	const vault = new CloudModelLoginVault({
		accountAuthority: w.account,
		keyring: w.keyring,
		renewer: renewer(renewed),
	});
	await expect(vault.renewIdleAccount(signal())).resolves.toBe("renewed");
	expect(w.account.commitAccountModelLoginRenewal).toHaveBeenCalledWith(
		expect.objectContaining({ loginId: w.loginId, token: w.token, baseVersion: 3 }),
		expect.any(AbortSignal),
	);
	await expect(vault.recordAccountLogins(signal())).resolves.toBe(1);
	expect(w.account.recordAccountModelLoginAccount).toHaveBeenCalledWith(
		{ loginId: w.loginId, accountIdentity: expect.stringMatching(/^[0-9a-f]{64}$/) },
		expect.any(AbortSignal),
	);
	await expect(vault.switchOffReplacedByAccountLogins(signal())).resolves.toEqual({
		switchedOff: 1,
		waiting: 0,
		refused: 0,
	});
	// It serves no company: a run's issue has nobody to ask.
	await expect(vault.issue({ binding: w.run, knownVersion: null }, signal())).rejects.toThrow(
		"Model login vault serves no company",
	);
});

const LOGIN = codexLogin({ ageSeconds: 0, lifeSeconds: 864_000, refresh: "rt-signed-in" });

/** One pending account sign-in in a fake database, finished at the helper. */
function signInWorld(options: { scope?: unknown; loginKind?: string } = {}) {
	const companyId = randomUUID();
	const signInId = randomUUID();
	const member = randomUUID();
	const capabilitySha256 = createHash("sha256").update("capability").digest("hex");
	const description: Record<string, unknown> = {
		schema: "qorpera.model-login-sign-in/v2",
		loginId: signInId,
		loginKind: options.loginKind ?? "codex",
		hostId: null,
		profileId: companyId,
		computeIdentityId: randomUUID(),
		computeIdentityOwnershipKind: "member",
		computeIdentityOwnerUserId: member,
		computeIdentityOwnerScopeKey: null,
		clientConnectionId: randomUUID(),
		status: "pending",
		expiresAt: new Date(Date.now() + 600_000).toISOString(),
		keyId: KEY_ID,
		modelLoginId: null,
		scope: options.scope ?? "account",
	};
	const saved: Buffer[] = [];
	const authority = {
		describeModelLoginSignIn: vi.fn(async () => ({ ...description })),
		completeModelLoginSignIn: vi.fn(async () => {
			throw new Error("an account sign-in completed as a company login");
		}),
		completeAccountModelLoginSignIn: vi.fn(async (completion: { encryptedEnvelope: Uint8Array }) => {
			// The vault wipes its envelope once the database answered: keep a copy, as the database does.
			saved.push(Buffer.from(completion.encryptedEnvelope));
			description.status = "completed";
			return { schema: "qorpera.model-login-sign-in-complete/v1" };
		}),
		modelLoginBrokerCompany: vi.fn(async () => companyId),
		completeChatGptPlanSignIn: vi.fn(),
	} satisfies ModelLoginSignInAuthority;
	let state: ModelLoginSignInState | { status: "unknown" } = {
		status: "completed",
		authJson: LOGIN,
		providerAccountEmail: "member@example.test",
	};
	const helper: ModelLoginSignInHelper = {
		beginSignIn: vi.fn(async () => state as ModelLoginSignInState),
		readSignIn: vi.fn(async () => state),
		listCompletedSignIns: vi.fn(async () => (state.status === "completed" ? [{ signInId, capabilitySha256 }] : [])),
		finishSignIn: vi.fn(async () => {
			state = { status: "unknown" };
		}),
	};
	return { companyId, signInId, member, authority, helper, description, saved };
}

it("completes an account sign-in as the member's account login, sealed under the member's key", async () => {
	const w = signInWorld();
	const { keyring } = vaultKeyring();
	const signIns = new CloudModelLoginSignIns({ authority: w.authority, keyring, helper: w.helper });
	await signIns.collect();
	expect(w.authority.completeModelLoginSignIn).not.toHaveBeenCalled();
	expect(w.authority.completeAccountModelLoginSignIn).toHaveBeenCalledTimes(1);
	const completion = (w.authority.completeAccountModelLoginSignIn.mock.calls as unknown[][])[0]?.[0] as {
		modelLoginId: string;
		keyId: string;
		encryptedEnvelope: Uint8Array;
		providerAccountEmail: string;
	};
	expect(completion).toMatchObject({ keyId: KEY_ID, providerAccountEmail: "member@example.test" });
	await expect(
		keyring.useMember(
			w.saved[0] as Buffer,
			{ memberId: w.member, loginId: completion.modelLoginId, version: 1, keyId: KEY_ID },
			async (fields) => fields[MODEL_LOGIN_FIELD],
		),
	).resolves.toBe(LOGIN);
	expect(w.helper.finishSignIn).toHaveBeenCalled();
});

it("refuses an account sign-in a company broker cannot seal, and one that names another scope or a plan", async () => {
	// A company broker's own key derives no member key: nothing completes.
	const own = signInWorld();
	const company = new CloudSecretKeyring({ [KEY_ID]: randomBytes(32) });
	keyrings.push(company);
	await new CloudModelLoginSignIns({ authority: own.authority, keyring: company, helper: own.helper }).collect();
	expect(own.authority.completeAccountModelLoginSignIn).not.toHaveBeenCalled();
	expect(own.authority.completeModelLoginSignIn).not.toHaveBeenCalled();
	for (const options of [{ scope: "company" }, { loginKind: "chatgpt_plan" }]) {
		const w = signInWorld(options);
		const { keyring } = vaultKeyring();
		await new CloudModelLoginSignIns({ authority: w.authority, keyring, helper: w.helper }).collect();
		expect(w.authority.completeAccountModelLoginSignIn).not.toHaveBeenCalled();
		expect(w.authority.completeModelLoginSignIn).not.toHaveBeenCalled();
	}
});

it("calls the shared vault's account functions with the principal's own capability hash", async () => {
	const queries: { text: string; values: readonly unknown[] }[] = [];
	const principalId = randomUUID();
	const secret = randomBytes(32).toString("base64url");
	const principal = new PostgresCloudSecretBrokerPrincipal({
		database: {
			async query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[]) {
				queries.push({ text, values });
				return { rowCount: 1, rows: [{ result: null } as unknown as Row] };
			},
		},
		principalId,
		principalSecret: secret,
	});
	await principal.takeIdleAccountModelLoginRenewal(signal());
	await principal.listAccountModelLoginsWithoutAccount(signal());
	await principal.switchOffReplacedByAccountLogins(signal());
	const own = createHash("sha256").update(sharedBrokerCapability(secret)).digest("hex");
	expect(queries.map((query) => query.values)).toEqual([
		[principalId, own],
		[principalId, own],
		[principalId, own],
	]);
	expect(queries.map((query) => /public\.(qorpera_[a-z_]+)\(/.exec(query.text)?.[1])).toEqual([
		"qorpera_take_idle_account_model_login_renewal",
		"qorpera_account_model_logins_without_account",
		"qorpera_switch_off_replaced_by_account_logins",
	]);
});

it("runs one account pass per upkeep cycle in the shared vault, whatever the number of companies", async () => {
	const { keyring } = vaultKeyring();
	const account = {
		commitAccountModelLoginRenewal: vi.fn(),
		releaseAccountModelLoginRenewal: vi.fn(),
		takeIdleAccountModelLoginRenewal: vi.fn(async () => ({
			schema: "qorpera.account-model-login-idle-renewal/v1",
			renewal: null,
		})),
		listAccountModelLoginsWithoutAccount: vi.fn(async () => ({
			schema: "qorpera.account-model-login-accounts/v1",
			logins: [],
		})),
		recordAccountModelLoginAccount: vi.fn(),
		switchOffReplacedByAccountLogins: vi.fn(async () => ({
			schema: "qorpera.model-login-switch-off/v1",
			switchedOff: 0,
			waiting: 0,
			refused: 0,
		})),
	};
	const helper = {
		beginSignIn: vi.fn(),
		readSignIn: vi.fn(),
		listCompletedSignIns: vi.fn(async () => []),
		finishSignIn: vi.fn(),
		renew: vi.fn(),
	} as unknown as ModelLoginSignInHelper & ModelLoginRenewer;
	const shared = new SharedCloudSecretBrokerCompanies({
		principal: {
			companies: vi.fn(),
			register: vi.fn(),
			authority: vi.fn(),
			eventVerificationsDue: vi.fn(),
			bankSyncsDue: vi.fn(),
			digitalPostSyncsDue: vi.fn(),
			...account,
		} as unknown as ConstructorParameters<typeof SharedCloudSecretBrokerCompanies>[0]["principal"],
		keyring,
		adapters: [],
		helper,
	});
	await shared.upkeep();
	expect(account.takeIdleAccountModelLoginRenewal).toHaveBeenCalledTimes(1);
	expect(account.listAccountModelLoginsWithoutAccount).toHaveBeenCalledTimes(1);
	expect(account.switchOffReplacedByAccountLogins).toHaveBeenCalledTimes(1);
	await shared.close();
});
