import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ModelLoginSignInHelper } from "@qorpera/runtime/cloud-model-login-sign-in";
import { CloudModelLoginUpkeep } from "@qorpera/runtime/cloud-model-login-upkeep";
import type { ModelLoginRenewer } from "@qorpera/runtime/cloud-model-login-vault";
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
	await principal.register(company, new AbortController().signal);
	const own = createHash("sha256").update(sharedBrokerCapability(secret)).digest("hex");
	expect(db.queries).toEqual([
		{
			text: "select public.qorpera_broker_principal_companies($1::uuid,$2::text) as result",
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

function principalFixture(options: { registered?: string[]; unregistered?: string[]; keyId?: string } = {}) {
	const authorityIds = new Map<string, string>();
	const authorityOf = (companyId: string) => {
		const known = authorityIds.get(companyId) ?? randomUUID();
		authorityIds.set(companyId, known);
		return known;
	};
	const state = { registered: [...(options.registered ?? [])], unregistered: [...(options.unregistered ?? [])] };
	const principal = {
		companies: vi.fn(async () => ({
			schema: "qorpera.broker-principal-companies/v1",
			registered: state.registered.map((companyId) => ({
				companyId,
				authorityId: authorityOf(companyId),
				keyId: options.keyId ?? "vault-root-1",
			})),
			unregistered: [...state.unregistered],
		})),
		register: vi.fn(async (companyId: string) => {
			state.unregistered = state.unregistered.filter((id) => id !== companyId);
			state.registered.push(companyId);
			return {
				schema: "qorpera.broker-principal-registration/v1",
				companyId,
				authorityId: authorityOf(companyId),
				keyId: options.keyId ?? "vault-root-1",
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
	const first = randomUUID();
	const second = randomUUID();
	const { principal } = principalFixture({ registered: [first], keyId: "other-root" });
	const companies = new SharedCloudSecretBrokerCompanies({
		principal,
		keyring: new CloudSecretKeyring({}, { "vault-root-1": randomBytes(32) }),
		adapters: [],
	});
	await companies.refresh(new AbortController().signal);
	expect(await companies.resolve(first, new AbortController().signal)).toBeUndefined();

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
	const service = new HttpCloudSecretBrokerService(companies, token, { host: "127.0.0.1", port: 0 });
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
