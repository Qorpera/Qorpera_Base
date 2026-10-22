import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { CloudConnectorOAuthFlows } from "@qorpera/runtime/cloud-connector-oauth";
import type { ModelLoginSignInHelper } from "@qorpera/runtime/cloud-model-login-sign-in";
import { CloudModelLoginUpkeep } from "@qorpera/runtime/cloud-model-login-upkeep";
import { CloudModelLoginVault, type ModelLoginRenewer } from "@qorpera/runtime/cloud-model-login-vault";
import {
	PostgresCloudSecretBrokerAuthority,
	PostgresCloudSecretBrokerPrincipal,
	sharedBrokerCapability,
} from "@qorpera/runtime/cloud-secret-broker";
import { HttpCloudSecretBrokerService } from "@qorpera/runtime/cloud-secret-broker-http";
import {
	type CloudSecretBrokerCompanies,
	type CloudSecretBrokerCompanyScope,
	SharedCloudSecretBrokerCompanies,
} from "@qorpera/runtime/cloud-secret-broker-shared";
import { CloudSecretKeyring } from "@qorpera/runtime/cloud-secret-crypto";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

const secret = randomBytes(32).toString("base64url");

function database() {
	const queries: { text: string; values: readonly unknown[] }[] = [];
	return {
		queries,
		client: {
			async query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[]) {
				queries.push({ text, values });
				return { rowCount: 1, rows: [{ result: null } as unknown as Row] };
			},
		},
	};
}

it("derives the principal's and each company's capability from the one secret, the same on every copy", () => {
	const company = randomUUID();
	expect(sharedBrokerCapability(secret, company)).toBe(sharedBrokerCapability(secret, company.toUpperCase()));
	expect(sharedBrokerCapability(secret, company)).not.toBe(sharedBrokerCapability(secret, randomUUID()));
	expect(sharedBrokerCapability(secret)).not.toBe(sharedBrokerCapability(secret, company));
	expect(sharedBrokerCapability(secret, company)).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(() => sharedBrokerCapability("short")).toThrow("Shared cloud secret broker secret is invalid");
	// Fixed values, computed apart from this code (Python's hmac): HMAC-SHA256 over the two labels.
	const fixed = Buffer.from(Array.from({ length: 32 }, (_, index) => 32 + index)).toString("base64url");
	expect(sharedBrokerCapability(fixed)).toBe("jV1yyqZ_Jl0_kfk04tpAun6MdLCIFNARnbC1HhlO9bI");
	expect(sharedBrokerCapability(fixed, "0F0E0D0C-0B0A-4908-8706-050403020100")).toBe(
		"vGW434I_uNAL8xnksHtqdhzxBLnt_RvlUCHV6hcDS64",
	);
});

it("calls the principal's functions with its own capability hash and registers with the company's", async () => {
	const db = database();
	const principalId = randomUUID();
	const company = randomUUID();
	const principal = new PostgresCloudSecretBrokerPrincipal({
		database: db.client,
		principalId,
		principalSecret: secret,
	});
	await principal.companies(new AbortController().signal);
	await principal.eventVerificationsDue(new AbortController().signal);
	await principal.digitalPostSyncsDue(new AbortController().signal);
	await principal.register(company, new AbortController().signal);
	const own = createHash("sha256").update(sharedBrokerCapability(secret)).digest("hex");
	expect(db.queries).toEqual([
		{
			text: "select public.qorpera_broker_principal_companies($1::uuid,$2::text) as result",
			values: [principalId, own],
		},
		{
			text: "select public.qorpera_broker_principal_event_verifications_due($1::uuid,$2::text) as result",
			values: [principalId, own],
		},
		{
			text: "select public.qorpera_broker_principal_digital_post_syncs_due($1::uuid,$2::text) as result",
			values: [principalId, own],
		},
		{
			text: "select public.qorpera_register_company_with_broker_principal($1::uuid,$2::text,$3::uuid,$4::text) as result",
			values: [
				principalId,
				own,
				company,
				createHash("sha256").update(sharedBrokerCapability(secret, company)).digest("hex"),
			],
		},
	]);
	// A company's authority carries its derived capability into every existing broker call.
	const authorityId = randomUUID();
	await principal.authority(company, authorityId).modelLoginBrokerCompany(new AbortController().signal);
	expect(db.queries.at(-1)?.values).toEqual([
		authorityId,
		createHash("sha256").update(sharedBrokerCapability(secret, company)).digest("hex"),
	]);
	expect(principal.authority(company, authorityId)).toBeInstanceOf(PostgresCloudSecretBrokerAuthority);
});

function principalFixture(
	options: {
		registered?: string[];
		unregistered?: string[];
		due?: string[];
		digitalPostDue?: string[];
		keyId?: string;
		principalKeyId?: string;
	} = {},
) {
	const authorityIds = new Map<string, string>();
	const authorityOf = (companyId: string) => {
		const known = authorityIds.get(companyId) ?? randomUUID();
		authorityIds.set(companyId, known);
		return known;
	};
	const state = {
		registered: [...(options.registered ?? [])],
		unregistered: [...(options.unregistered ?? [])],
		keyId: options.keyId ?? "vault-root-1",
	};
	const principal = {
		companies: vi.fn(async () => ({
			schema: "qorpera.broker-principal-companies/v1",
			keyId: options.principalKeyId ?? "vault-root-1",
			registered: state.registered.map((companyId) => ({
				companyId,
				authorityId: authorityOf(companyId),
				keyId: state.keyId,
			})),
			unregistered: [...state.unregistered],
		})),
		eventVerificationsDue: vi.fn(async () => ({
			schema: "qorpera.broker-principal-event-verifications/v1",
			companyIds: [...(options.due ?? [])],
		})),
		digitalPostSyncsDue: vi.fn(async () => ({
			schema: "qorpera.broker-principal-digital-post-syncs/v1",
			companyIds: [...(options.digitalPostDue ?? [])],
		})),
		register: vi.fn(async (companyId: string) => {
			state.unregistered = state.unregistered.filter((id) => id !== companyId);
			state.registered.push(companyId);
			return {
				schema: "qorpera.broker-principal-registration/v1",
				companyId,
				authorityId: authorityOf(companyId),
				keyId: state.keyId,
			};
		}),
		authority: vi.fn(
			(companyId: string, _authorityId: string) =>
				({
					modelLoginBrokerCompany: vi.fn(async () => companyId),
				}) as unknown as PostgresCloudSecretBrokerAuthority,
		),
	};
	return { principal, state };
}

function helperFixture() {
	return {
		beginSignIn: vi.fn(),
		readSignIn: vi.fn(),
		listCompletedSignIns: vi.fn(async (_request: { companyId: string }) => []),
		finishSignIn: vi.fn(),
		renew: vi.fn(),
	} as unknown as ModelLoginSignInHelper & ModelLoginRenewer & { listCompletedSignIns: ReturnType<typeof vi.fn> };
}

it("registers new companies, serves every registered one, and drops one no longer listed", async () => {
	const one = randomUUID();
	const two = randomUUID();
	const { principal, state } = principalFixture({ registered: [one], unregistered: [two] });
	const keyring = new CloudSecretKeyring({}, { "vault-root-1": randomBytes(32) });
	const companies = new SharedCloudSecretBrokerCompanies({ principal, keyring, adapters: [] });
	await companies.refresh(new AbortController().signal);
	expect(principal.register).toHaveBeenCalledExactlyOnceWith(two, expect.any(AbortSignal));
	const scope = (await companies.resolve(one, new AbortController().signal)) as CloudSecretBrokerCompanyScope;
	expect(scope.companyId).toBe(one);
	expect((await companies.resolve(two.toUpperCase(), new AbortController().signal))?.companyId).toBe(two);
	// Without a helper nothing signs in; usage and the login vault are served either way.
	expect(scope.modelLoginSignIns).toBeUndefined();
	// A later refresh keeps the same services for a company whose authority did not change.
	await companies.refresh(new AbortController().signal);
	expect(await companies.resolve(one, new AbortController().signal)).toBe(scope);
	state.registered = [two];
	await companies.refresh(new AbortController().signal);
	expect(await companies.resolve(one, new AbortController().signal)).toBeUndefined();
	expect(principal.authority).toHaveBeenCalledTimes(2);
	keyring.close();
});

it("looks a company created a moment ago up again, but not on every request", async () => {
	let now = 1_000_000;
	const { principal, state } = principalFixture();
	const companies = new SharedCloudSecretBrokerCompanies({
		principal,
		keyring: new CloudSecretKeyring({}, { "vault-root-1": randomBytes(32) }),
		adapters: [],
		now: () => now,
	});
	const fresh = randomUUID();
	expect(await companies.resolve(fresh, new AbortController().signal)).toBeUndefined();
	expect(principal.companies).toHaveBeenCalledTimes(1);
	state.unregistered.push(fresh);
	now += 500;
	expect(await companies.resolve(fresh, new AbortController().signal)).toBeUndefined();
	expect(principal.companies).toHaveBeenCalledTimes(1);
	now += 2000;
	expect((await companies.resolve(fresh, new AbortController().signal))?.companyId).toBe(fresh);
	expect(principal.companies).toHaveBeenCalledTimes(2);
	await expect(companies.resolve("not-a-company", new AbortController().signal)).rejects.toThrow(
		"Shared vault company is invalid",
	);
});

it("never serves a company whose key this vault cannot derive, and survives a failed registration", async () => {
	const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
	const first = randomUUID();
	const second = randomUUID();
	const { principal, state } = principalFixture({ registered: [first] });
	const companies = new SharedCloudSecretBrokerCompanies({
		principal,
		keyring: new CloudSecretKeyring({}, { "vault-root-1": randomBytes(32) }),
		adapters: [],
	});
	await companies.refresh(new AbortController().signal);
	expect((await companies.resolve(first, new AbortController().signal))?.companyId).toBe(first);
	// Its key id changes to one this vault cannot derive: it is no longer served.
	state.keyId = "other-root";
	await companies.refresh(new AbortController().signal);
	expect(await companies.resolve(first, new AbortController().signal)).toBeUndefined();

	// A vault without the principal's key registers nobody: registering would switch the company to vault
	// sign-in that this vault can never serve.
	const keyless = principalFixture({ unregistered: [second], principalKeyId: "other-root" });
	const withoutKey = new SharedCloudSecretBrokerCompanies({
		principal: keyless.principal,
		keyring: new CloudSecretKeyring({}, { "vault-root-1": randomBytes(32) }),
		adapters: [],
	});
	await withoutKey.refresh(new AbortController().signal);
	expect(keyless.principal.register).not.toHaveBeenCalled();
	// An answer that does not name the principal's key is refused outright.
	keyless.principal.companies.mockResolvedValueOnce({
		schema: "qorpera.broker-principal-companies/v1",
		registered: [],
		unregistered: [second],
	} as never);
	await expect(withoutKey.refresh(new AbortController().signal)).rejects.toThrow("Shared vault companies are invalid");
	expect(logged).toHaveBeenCalledWith(
		"Shared vault: this vault does not hold the principal's key; it registers no company.",
	);

	const failing = principalFixture({ unregistered: [first, second] });
	failing.principal.register.mockRejectedValueOnce(new Error("company already has a vault"));
	const others = new SharedCloudSecretBrokerCompanies({
		principal: failing.principal,
		keyring: new CloudSecretKeyring({}, { "vault-root-1": randomBytes(32) }),
		adapters: [],
	});
	await others.refresh(new AbortController().signal);
	expect(failing.principal.register).toHaveBeenCalledTimes(2);
	expect((await others.resolve(second, new AbortController().signal))?.companyId).toBe(second);
	expect(logged).toHaveBeenCalledWith(
		"Shared vault: a company's registration was refused; the next refresh looks again.",
	);
});

it("answers a request for a registered company once the refresh in flight ends, a start's first included", async () => {
	let now = 1_000_000;
	const one = randomUUID();
	const { principal, state } = principalFixture();
	const companies = new SharedCloudSecretBrokerCompanies({
		principal,
		keyring: new CloudSecretKeyring({}, { "vault-root-1": randomBytes(32) }),
		adapters: [],
		now: () => now,
	});
	// A lookup a moment ago: the 2 s limit is running.
	expect(await companies.resolve(randomUUID(), new AbortController().signal)).toBeUndefined();
	let release = (): void => undefined;
	principal.companies.mockImplementationOnce(async () => {
		await new Promise<void>((resolveRelease) => {
			release = resolveRelease;
		});
		return {
			schema: "qorpera.broker-principal-companies/v1",
			keyId: "vault-root-1",
			registered: [{ companyId: one, authorityId: randomUUID(), keyId: "vault-root-1" }],
			unregistered: [],
		};
	});
	state.registered.push(one);
	const refreshing = companies.refresh(new AbortController().signal);
	now += 100;
	const resolving = companies.resolve(one, new AbortController().signal);
	release();
	await refreshing;
	expect((await resolving)?.companyId).toBe(one);
});

it("stops a company's upkeep pass after the renewal in hand when the vault closes", async () => {
	const renewals: (() => void)[] = [];
	const renewIdle = vi.spyOn(CloudModelLoginVault.prototype, "renewIdle").mockImplementation(
		() =>
			new Promise((resolveRenewal) => {
				renewals.push(() => resolveRenewal("renewed"));
			}),
	);
	vi.spyOn(CloudModelLoginVault.prototype, "recordAccounts").mockResolvedValue(0);
	vi.spyOn(CloudModelLoginVault.prototype, "switchOffReplacedNodeLogins").mockResolvedValue({
		switchedOff: 0,
	} as never);
	const { principal } = principalFixture({ registered: [randomUUID()] });
	const companies = new SharedCloudSecretBrokerCompanies({
		principal,
		keyring: new CloudSecretKeyring({}, { "vault-root-1": randomBytes(32) }),
		adapters: [],
	});
	await companies.refresh(new AbortController().signal);
	const passing = companies.upkeep();
	await vi.waitFor(() => expect(renewals).toHaveLength(1));
	const closing = companies.close();
	renewals.shift()?.();
	await closing;
	await passing;
	// Without the close the pass would go on to its twelfth renewal.
	expect(renewIdle).toHaveBeenCalledTimes(1);
});

it("collects a signing-in company's sign-ins every pass and every company's on a sweep", async () => {
	let now = 5_000_000;
	const one = randomUUID();
	const two = randomUUID();
	const { principal } = principalFixture({ registered: [one, two] });
	const helper = helperFixture();
	const companies = new SharedCloudSecretBrokerCompanies({
		principal,
		keyring: new CloudSecretKeyring({}, { "vault-root-1": randomBytes(32) }),
		adapters: [],
		helper,
		sweepEveryMs: 30_000,
		now: () => now,
	});
	await companies.refresh(new AbortController().signal);
	const asked = () =>
		helper.listCompletedSignIns.mock.calls.map(([request]) => (request as { companyId: string }).companyId);
	await companies.collect();
	expect(asked().sort()).toEqual([one, two].sort());
	helper.listCompletedSignIns.mockClear();
	now += 2000;
	await companies.collect();
	expect(asked()).toEqual([]);
	companies.signingIn(two);
	now += 2000;
	await companies.collect();
	expect(asked()).toEqual([two]);
	now += 30_000;
	helper.listCompletedSignIns.mockClear();
	await companies.collect();
	expect(asked().sort()).toEqual([one, two].sort());
	// The signing-in mark ends after 20 minutes.
	now += 21 * 60_000;
	helper.listCompletedSignIns.mockClear();
	await companies.collect();
	helper.listCompletedSignIns.mockClear();
	now += 2000;
	await companies.collect();
	expect(asked()).toEqual([]);
});

it("runs every served company's connector token revocations in turn, on the company's own authority", async () => {
	const one = randomUUID();
	const two = randomUUID();
	const { principal } = principalFixture({ registered: [one, two] });
	// Each company's own authority; the first one's claim waits until the vault closes.
	const claims = new Map<string, ReturnType<typeof vi.fn>>();
	let claimed = () => {};
	let firstPassDone = false;
	const waiting = new Promise<void>((resolve) => {
		claimed = resolve;
	});
	principal.authority.mockImplementation((companyId: string) => {
		const claim = vi.fn(async (_limit: number, signal: AbortSignal) => {
			if (firstPassDone) {
				claimed();
				await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
				signal.throwIfAborted();
			}
			return [];
		});
		claims.set(companyId, claim);
		return {
			claimConnectorTokenRevocations: claim,
			completeConnectorTokenRevocation: vi.fn(),
		} as unknown as PostgresCloudSecretBrokerAuthority;
	});
	const companies = new SharedCloudSecretBrokerCompanies({
		principal,
		keyring: new CloudSecretKeyring({}, { "vault-root-1": randomBytes(32) }),
		adapters: [],
		revoker: { revoke: vi.fn() },
	});
	await companies.refresh(new AbortController().signal);
	await companies.revokeTokens();
	firstPassDone = true;
	expect([...claims.keys()].sort()).toEqual([one, two].sort());
	for (const claim of claims.values()) expect(claim).toHaveBeenCalledExactlyOnceWith(20, expect.any(AbortSignal));
	// A pass in hand sees the close, and no pass runs after it.
	vi.spyOn(console, "error").mockImplementation(() => undefined);
	const running = companies.revokeTokens();
	await waiting;
	await companies.close();
	await running;
	const first = [...claims.values()].find((claim) => claim.mock.calls.length === 2)!;
	expect((first.mock.calls[1]![1] as AbortSignal).aborted).toBe(true);
	await companies.revokeTokens();
	expect([...claims.values()].reduce((total, claim) => total + claim.mock.calls.length, 0)).toBe(3);
});

it("checks the signed deliveries of each served company that has some due, on the company's own authority", async () => {
	const one = randomUUID();
	const two = randomUUID();
	const idle = randomUUID();
	// A company the vault does not serve (another vault's, or just dropped) is passed over.
	const { principal } = principalFixture({
		registered: [one, two, idle],
		due: [two, randomUUID(), one.toUpperCase()],
	});
	const claims = new Map<string, ReturnType<typeof vi.fn>>();
	principal.authority.mockImplementation((companyId: string) => {
		const claim = vi.fn(async () => ({ schema: "qorpera.event-verification-claim/v1", deliveries: [], refused: 0 }));
		claims.set(companyId, claim);
		return {
			claimEventVerifications: claim,
			finishEventVerification: vi.fn(),
		} as unknown as PostgresCloudSecretBrokerAuthority;
	});
	const companies = new SharedCloudSecretBrokerCompanies({
		principal,
		keyring: new CloudSecretKeyring({}, { "vault-root-1": randomBytes(32) }),
		adapters: [],
		revoker: { revoke: vi.fn() },
	});
	await companies.refresh(new AbortController().signal);
	await companies.verifyEvents();
	expect(principal.eventVerificationsDue).toHaveBeenCalledOnce();
	expect(claims.get(idle)).not.toHaveBeenCalled();
	for (const companyId of [one, two])
		expect(claims.get(companyId)).toHaveBeenCalledExactlyOnceWith(16, expect.any(AbortSignal));
	principal.eventVerificationsDue.mockResolvedValueOnce({ schema: "other", companyIds: [] });
	await expect(companies.verifyEvents()).rejects.toThrow("Shared vault event verifications are invalid");
	await companies.close();
	await companies.verifyEvents();
	expect(principal.eventVerificationsDue).toHaveBeenCalledTimes(2);
	expect([...claims.values()].reduce((total, claim) => total + claim.mock.calls.length, 0)).toBe(2);
});

it("fetches the Digital Post of each served company that has a sync due, on its own authority, only with the certificate", async () => {
	const one = randomUUID();
	const idle = randomUUID();
	const { principal } = principalFixture({ registered: [one, idle], digitalPostDue: [one, randomUUID()] });
	const claims = new Map<string, ReturnType<typeof vi.fn>>();
	principal.authority.mockImplementation((companyId: string) => {
		const claim = vi.fn(async () => null);
		claims.set(companyId, claim);
		return { claimDigitalPostSync: claim } as unknown as PostgresCloudSecretBrokerAuthority;
	});
	const options = {
		principal,
		keyring: new CloudSecretKeyring({}, { "vault-root-1": randomBytes(32) }),
		adapters: [],
		revoker: { revoke: vi.fn() },
	};
	// Without Qorpera's Digital Post certificate nothing is asked.
	const without = new SharedCloudSecretBrokerCompanies(options);
	await without.refresh(new AbortController().signal);
	await without.syncDigitalPost();
	expect(principal.digitalPostSyncsDue).not.toHaveBeenCalled();
	const companies = new SharedCloudSecretBrokerCompanies({
		...options,
		digitalPost: { available: vi.fn(), letter: vi.fn(), receipt: vi.fn() },
	});
	claims.clear();
	await companies.refresh(new AbortController().signal);
	await companies.syncDigitalPost();
	expect(principal.digitalPostSyncsDue).toHaveBeenCalledOnce();
	expect(claims.get(one)).toHaveBeenCalledOnce();
	expect(claims.get(idle)).not.toHaveBeenCalled();
	principal.digitalPostSyncsDue.mockResolvedValueOnce({ schema: "other", companyIds: [] });
	await expect(companies.syncDigitalPost()).rejects.toThrow("Shared vault Digital Post syncs are invalid");
	await Promise.all([without.close(), companies.close()]);
});

it("runs every served company's upkeep pass in turn, and its loops until closed", async () => {
	const pass = vi.spyOn(CloudModelLoginUpkeep.prototype, "pass").mockResolvedValue(undefined);
	const { principal } = principalFixture({ registered: [randomUUID(), randomUUID()] });
	const companies = new SharedCloudSecretBrokerCompanies({
		principal,
		keyring: new CloudSecretKeyring({}, { "vault-root-1": randomBytes(32) }),
		adapters: [],
	});
	await companies.refresh(new AbortController().signal);
	await companies.upkeep();
	expect(pass).toHaveBeenCalledTimes(2);

	vi.useFakeTimers();
	const looping = principalFixture({ registered: [randomUUID()] });
	const shared = new SharedCloudSecretBrokerCompanies({
		principal: looping.principal,
		keyring: new CloudSecretKeyring({}, { "vault-root-1": randomBytes(32) }),
		adapters: [],
		refreshEveryMs: 1000,
	});
	shared.start();
	shared.start();
	await vi.advanceTimersByTimeAsync(0);
	expect(looping.principal.companies).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(1000);
	expect(looping.principal.companies).toHaveBeenCalledTimes(2);
	await shared.close();
	await vi.advanceTimersByTimeAsync(10_000);
	expect(looping.principal.companies).toHaveBeenCalledTimes(2);
});

it("serves each request from its company's services on the shared vault, and nothing for another", async () => {
	const token = randomBytes(32).toString("base64url");
	const served = randomUUID();
	const execute = vi.fn(async () => ({ type: "json", value: {} }));
	const signIn = vi.fn(async () => ({
		schema: "qorpera.native-provider-login-result/v1",
		login_id: randomUUID(),
		status: "preparing",
		interaction_url: null,
		user_code: null,
	}));
	const scope = {
		companyId: served,
		broker: { execute },
		modelLogins: undefined,
		modelLoginSignIns: { signIn },
		modelLoginUsage: undefined,
	} as unknown as CloudSecretBrokerCompanyScope;
	const signingIn = vi.fn((_companyId: string) => undefined);
	const resolve = vi.fn(async (companyId: string) => (companyId === served ? scope : undefined));
	const companies: CloudSecretBrokerCompanies = { resolve, signingIn };
	const confirm = vi.fn(async () => {
		throw new Error("state_unknown");
	});
	const service = new HttpCloudSecretBrokerService(companies, token, {
		host: "127.0.0.1",
		port: 0,
		oauth: { confirm } as unknown as CloudConnectorOAuthFlows,
	});
	const port = await service.start();
	try {
		const post = (path: string, authorization: string, body: unknown = {}) =>
			fetch(`http://127.0.0.1:${port}${path}`, {
				method: "POST",
				headers: { authorization: `Bearer ${authorization}`, "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		// No company, or a company this vault does not serve: not found, and nothing runs.
		expect((await post("/v1/operations", token)).status).toBe(404);
		expect((await post(`/v1/operations?company=${randomUUID()}`, token)).status).toBe(404);
		expect(execute).not.toHaveBeenCalled();
		// The served company's operation reaches its own broker (which then checks the request itself).
		await post(`/v1/operations?company=${served}`, token, { schema: "invalid" });
		expect(resolve).toHaveBeenLastCalledWith(served, expect.any(AbortSignal));
		// A member's sign-in names the company in the path, and marks it as signing in.
		const capability = randomBytes(32).toString("base64url");
		const answer = await post(`/v1/model-logins/${served}/login`, capability, { schema: "any" });
		expect(answer.status).toBe(200);
		expect(signingIn).toHaveBeenCalledExactlyOnceWith(served);
		expect(signIn).toHaveBeenCalledWith(
			expect.objectContaining({ companyId: served, capability }),
			expect.any(AbortSignal),
		);
		// A sign-in the database refuses does not put the company on the frequent collection.
		signIn.mockRejectedValueOnce(new Error("Vault sign-in is unavailable"));
		expect((await post(`/v1/model-logins/${served}/login`, capability, { schema: "any" })).ok).toBe(false);
		expect(signingIn).toHaveBeenCalledTimes(1);
		// A connector sign-in's confirm names the company the request was routed to.
		await post(`/v1/oauth/${randomUUID()}/confirm?company=${served}`, token, {
			schema: "qorpera.cloud-connector-oauth-confirm/v1",
			confirmation: randomBytes(32).toString("base64url"),
			browserProof: randomBytes(32).toString("base64url"),
		});
		expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ companyId: served }), expect.any(AbortSignal));
	} finally {
		await service.close();
	}
	expect(
		() =>
			new HttpCloudSecretBrokerService(companies, token, {
				host: "127.0.0.1",
				port: 0,
				modelLoginUsage: {} as never,
			}),
	).toThrow("Cloud secret broker service configuration is invalid");
});
