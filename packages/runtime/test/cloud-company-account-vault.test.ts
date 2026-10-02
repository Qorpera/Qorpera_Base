import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	type CompanyAccountAuthority,
	type CompanyAccountCall,
	type CompanyAccountOpening,
	type CompanyAccountRequest,
	CompanyAccountVault,
	parseCompanyAccountAnswer,
	parseCompanyAccountRequest,
} from "@qorpera/runtime/cloud-company-account-vault";
import { parseCompanyAccountFields } from "@qorpera/runtime/cloud-company-accounts";
import {
	CloudSecretBroker,
	type CloudSecretBrokerAuthority,
	PostgresCloudSecretBrokerAuthority,
} from "@qorpera/runtime/cloud-secret-broker";
import { HttpCloudSecretBrokerClient, HttpCloudSecretBrokerService } from "@qorpera/runtime/cloud-secret-broker-http";
import { CloudSecretKeyring } from "@qorpera/runtime/cloud-secret-crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const keyrings: CloudSecretKeyring[] = [];
const services: HttpCloudSecretBrokerService[] = [];
afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
	for (const keyring of keyrings.splice(0)) keyring.close();
});

const companyId = "79800000-0000-4000-8000-000000000010";
const environmentId = "79800000-0000-4000-8000-000000000020";
const accountId = "79800000-0000-4000-8000-000000000050";
const todoId = "79800000-0000-4000-8000-000000000060";

function call(): CompanyAccountCall {
	return {
		binding: nativeToolAuthorityFixture().binding,
		receiptId: randomUUID(),
		inputSha256: "a".repeat(64),
		idempotencyKey: "b".repeat(64),
	};
}

function openRequest(overrides: Partial<Extract<CompanyAccountRequest, { action: "open" }>> = {}) {
	return {
		...call(),
		action: "open" as const,
		site: "vercel.com",
		signInHosts: [],
		login: "agents@nordlys.example",
		purpose: "Hosting for the website",
		todoId,
		password: {},
		...overrides,
	};
}

function descriptor(id = accountId, status = "pending") {
	return {
		schema: "qorpera.company-account/v1",
		accountId: id,
		site: "vercel.com",
		signInHosts: [],
		login: "agents@nordlys.example",
		twoStep: "none",
		status,
		version: 1,
	};
}

/** A database refusal as node-postgres raises it. */
function databaseError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

function vaultFixture(authority: Partial<CompanyAccountAuthority> = {}) {
	const keyring = new CloudSecretKeyring({ "company-kek-1": randomBytes(32) });
	keyrings.push(keyring);
	const openings: CompanyAccountOpening[] = [];
	/** The buffers the vault handed over, by reference: zeroed once the call is over. */
	const sent: Uint8Array[] = [];
	const fake: CompanyAccountAuthority = {
		describeCompanyAccountOpen: vi.fn(async () => ({
			schema: "qorpera.company-account-context/v1",
			companyId,
			environmentId,
			keyId: "company-kek-1",
		})),
		openCompanyAccount: vi.fn(async (_call: CompanyAccountCall, opening: CompanyAccountOpening) => {
			sent.push(opening.encryptedEnvelope);
			openings.push({ ...opening, encryptedEnvelope: Uint8Array.from(opening.encryptedEnvelope) });
			return descriptor(opening.secretId);
		}),
		setCompanyAccountState: vi.fn(async (_call: CompanyAccountCall, id: string, status: string) =>
			descriptor(id, status),
		),
		...authority,
	};
	const vault = new CompanyAccountVault({ authority: fake, keys: keyring, newId: () => accountId });
	return { keyring, openings, sent, authority: fake, vault };
}

describe("company account vault", () => {
	it("opens an account with a password it makes, sealed for the account's own id, company and environment", async () => {
		const f = vaultFixture();
		const answer = await f.vault.handle(
			openRequest({ password: { length: 32, symbols: false } }),
			AbortSignal.timeout(5000),
		);
		expect(answer).toEqual(descriptor());
		expect(JSON.stringify(answer)).not.toMatch(/password|envelope/i);
		const [opening] = f.openings;
		expect(opening).toMatchObject({ secretId: accountId, companyId, environmentId, keyId: "company-kek-1", todoId });
		expect(opening?.envelopeSha256).toBe(createHash("sha256").update(opening!.encryptedEnvelope).digest("hex"));
		// The envelope opens only with the identity the database stores, and holds the password and nothing else.
		const secret = await f.keyring.use(
			opening!.encryptedEnvelope,
			{ companyId, environmentId, secretId: accountId, version: 1, keyId: "company-kek-1" },
			async (fields) => parseCompanyAccountFields(fields),
		);
		expect(Object.keys(secret)).toEqual(["password"]);
		expect(secret.password).toMatch(/^[A-Za-z0-9]{32}$/);
		const sealed = { companyId, environmentId, secretId: accountId, version: 1, keyId: "company-kek-1" };
		for (const other of [
			{ secretId: randomUUID() },
			{ companyId: randomUUID() },
			{ environmentId: randomUUID() },
			{ version: 2 },
		])
			await expect(
				f.keyring.use(opening!.encryptedEnvelope, { ...sealed, ...other }, async () => "opened"),
				JSON.stringify(other),
			).rejects.toThrow();
		// The vault's own copy of the sealed bytes is wiped once the database has answered.
		expect(f.sent[0]?.every((byte) => byte === 0)).toBe(true);
	});

	it("answers the account a repeat of the same call opened first, and draws a new id for every attempt", async () => {
		const first = "79800000-0000-4000-8000-000000000051";
		const f = vaultFixture({ openCompanyAccount: vi.fn(async () => descriptor(first)) });
		expect(await f.vault.handle(openRequest(), AbortSignal.timeout(5000))).toEqual(descriptor(first));
		// With its own ids, two attempts never offer the database the same one.
		const g = vaultFixture();
		const vault = new CompanyAccountVault({ authority: g.authority, keys: g.keyring });
		await vault.handle(openRequest(), AbortSignal.timeout(5000));
		await vault.handle(openRequest(), AbortSignal.timeout(5000));
		expect(g.openings).toHaveLength(2);
		expect(g.openings[0]?.secretId).not.toBe(g.openings[1]?.secretId);
	});

	it("passes the database's refusals on in their own words, and nothing else", async () => {
		const refusing = (code: string, message: string) =>
			vaultFixture({
				openCompanyAccount: vi.fn(async () => {
					throw databaseError(code, message);
				}),
			});
		for (const [code, message] of [
			["22023", "An account is opened only for an open todo of this agent"],
			["23505", "The company already has this account; use it"],
			["0A000", "Company accounts are switched off"],
			["54000", "The company has too many accounts on this website"],
		]) {
			expect(await refusing(code!, message!).vault.handle(openRequest(), AbortSignal.timeout(5000))).toEqual({
				schema: "qorpera.company-account-refusal/v1",
				code,
				message,
			});
		}
		// The switch is read first, so a switched-off company is refused by the first call.
		const off = vaultFixture({
			describeCompanyAccountOpen: vi.fn(async () => {
				throw databaseError("0A000", "Company accounts are switched off");
			}),
		});
		expect(await off.vault.handle(openRequest(), AbortSignal.timeout(5000))).toEqual({
			schema: "qorpera.company-account-refusal/v1",
			code: "0A000",
			message: "Company accounts are switched off",
		});
		expect(off.authority.openCompanyAccount).not.toHaveBeenCalled();
		for (const error of [
			databaseError("42501", "company account id is taken"),
			databaseError("55000", "Company execution is paused"),
			databaseError("40P01", "deadlock detected"),
			new Error("connection reset"),
		]) {
			const f = vaultFixture({
				openCompanyAccount: vi.fn(async () => {
					throw error;
				}),
			});
			await expect(f.vault.handle(openRequest(), AbortSignal.timeout(5000))).rejects.toThrow(
				"Company account outcome unconfirmed",
			);
		}
	});

	it("never seals under a key it does not hold, nor for a malformed context or id", async () => {
		const contexts = [
			{ schema: "qorpera.company-account-context/v1", companyId, environmentId, keyId: "company-kek-9" },
			{ schema: "qorpera.company-account-context/v1", companyId: "x", environmentId, keyId: "company-kek-1" },
			{ schema: "qorpera.company-account-context/v1", companyId, environmentId, keyId: "company-kek-1", extra: 1 },
			{ schema: "other", companyId, environmentId, keyId: "company-kek-1" },
		];
		for (const context of contexts) {
			const f = vaultFixture({ describeCompanyAccountOpen: vi.fn(async () => context) });
			await expect(f.vault.handle(openRequest(), AbortSignal.timeout(5000))).rejects.toThrow(
				"Company account outcome unconfirmed",
			);
			expect(f.authority.openCompanyAccount).not.toHaveBeenCalled();
		}
		const f = vaultFixture();
		const bad = new CompanyAccountVault({ authority: f.authority, keys: f.keyring, newId: () => "not-a-uuid" });
		await expect(bad.handle(openRequest(), AbortSignal.timeout(5000))).rejects.toThrow(
			"Company account outcome unconfirmed",
		);
	});

	it("records a state change and refuses a database answer that is not an account", async () => {
		const f = vaultFixture();
		const request = { ...call(), action: "state" as const, accountId, status: "connected" as const };
		expect(await f.vault.handle(request, AbortSignal.timeout(5000))).toEqual(descriptor(accountId, "connected"));
		expect(f.authority.setCompanyAccountState).toHaveBeenCalledWith(
			request,
			accountId,
			"connected",
			expect.anything(),
		);
		const odd = vaultFixture({ setCompanyAccountState: vi.fn(async () => ({ ...descriptor(), password: "x" })) });
		await expect(odd.vault.handle(request, AbortSignal.timeout(5000))).rejects.toThrow(
			"Company account outcome unconfirmed",
		);
	});
});

describe("company account requests", () => {
	const wire = (overrides: Record<string, unknown> = {}) => ({
		schema: "qorpera.company-account-request/v1",
		...openRequest(),
		...overrides,
	});

	it("reads an open and a state change, and refuses anything else", () => {
		expect(parseCompanyAccountRequest(wire({ site: `${"a".repeat(63)}.example` }))).toMatchObject({
			site: `${"a".repeat(63)}.example`,
		});
		expect(parseCompanyAccountRequest(wire({ password: { length: 20 } }))).toMatchObject({
			action: "open",
			site: "vercel.com",
			password: { length: 20 },
		});
		expect(
			parseCompanyAccountRequest({
				schema: "qorpera.company-account-request/v1",
				...call(),
				action: "state",
				accountId: accountId.toUpperCase(),
				status: "needs_person",
			}),
		).toMatchObject({ action: "state", accountId, status: "needs_person" });
		for (const bad of [
			wire({ schema: "other" }),
			wire({ action: "use" }),
			wire({ site: "Vercel.com" }),
			wire({ site: "https://vercel.com" }),
			// A DNS label has at most 63 characters.
			wire({ site: `${"a".repeat(64)}.example` }),
			wire({ signInHosts: ["vercel.com"] }),
			wire({ signInHosts: ["a.com", "a.com"] }),
			wire({ login: " agents@nordlys.example" }),
			wire({ login: "a\nb" }),
			wire({ purpose: "" }),
			wire({ todoId: "todo" }),
			wire({ password: { length: 8 } }),
			wire({ password: { symbols: "yes" } }),
			wire({ password: { length: 20, extra: 1 } }),
			wire({ idempotencyKey: "short" }),
			wire({ extra: 1 }),
		])
			expect(() => parseCompanyAccountRequest(bad), JSON.stringify(bad)).toThrow();
	});

	it("reads an answer as an account's facts or a refusal, never anything carrying more", () => {
		expect(parseCompanyAccountAnswer(descriptor())).toEqual(descriptor());
		expect(
			parseCompanyAccountAnswer({
				schema: "qorpera.company-account-refusal/v1",
				code: "22023",
				message: "Use a todo",
			}),
		).toEqual({ schema: "qorpera.company-account-refusal/v1", code: "22023", message: "Use a todo" });
		// The login as the database keeps it, even one a person typed with a stray space.
		expect(parseCompanyAccountAnswer({ ...descriptor(), login: "\u00a0ida@nordlys.example" })).toMatchObject({
			login: "\u00a0ida@nordlys.example",
		});
		for (const bad of [
			{ ...descriptor(), keyId: "company-kek-1" },
			{ ...descriptor(), login: "" },
			{ schema: "qorpera.company-account-refusal/v1", code: "55000", message: "Company execution is paused" },
			{ ...descriptor(), status: "open" },
			{ ...descriptor(), version: 0 },
			{ schema: "qorpera.company-account-refusal/v1", code: "42501", message: "no" },
		])
			expect(() => parseCompanyAccountAnswer(bad), JSON.stringify(bad)).toThrow();
	});
});

describe("company accounts over the broker", () => {
	it("calls only its three broker-role functions, binding the tool call and the opening", async () => {
		const queries: Array<{ text: string; values: readonly unknown[] }> = [];
		const sent: Buffer[] = [];
		const authority = new PostgresCloudSecretBrokerAuthority({
			database: {
				async query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[]) {
					// A copy of each buffer as sent: the authority wipes its own afterwards.
					queries.push({
						text,
						values: values.map((value) => (Buffer.isBuffer(value) ? Buffer.from(value) : value)),
					});
					sent.push(...values.filter((value) => Buffer.isBuffer(value)));
					return { rowCount: 1, rows: [{ result: { accepted: true } } as unknown as Row] };
				},
			},
			brokerAuthorityId: randomUUID(),
			brokerCapability: randomBytes(32).toString("base64url"),
		});
		const request = openRequest({ signInHosts: ["accounts.vercel.com"] });
		await authority.describeCompanyAccountOpen(request, AbortSignal.timeout(5000));
		await authority.openCompanyAccount(
			request,
			{
				secretId: accountId,
				companyId,
				environmentId,
				site: request.site,
				signInHosts: request.signInHosts,
				login: request.login,
				purpose: request.purpose,
				todoId,
				keyId: "company-kek-1",
				encryptedEnvelope: Buffer.from("sealed"),
				envelopeSha256: "c".repeat(64),
			},
			AbortSignal.timeout(5000),
		);
		await authority.setCompanyAccountState(request, accountId, "closed", AbortSignal.timeout(5000));
		expect(queries.map((query) => query.text)).toEqual([
			"select public.qorpera_describe_company_account_open($1::uuid,$2::text,$3::jsonb,$4::uuid,$5::text,$6::text) as result",
			"select public.qorpera_open_company_account($1::uuid,$2::text,$3::jsonb,$4::uuid,$5::text,$6::text,$7::uuid,$8::uuid,$9::uuid,$10::text,$11::text[],$12::text,$13::text,$14::uuid,$15::text,$16::bytea,$17::text) as result",
			"select public.qorpera_set_company_account_state($1::uuid,$2::text,$3::jsonb,$4::uuid,$5::text,$6::text,$7::uuid,$8::text) as result",
		]);
		const head = [
			JSON.stringify(request.binding),
			request.receiptId,
			request.inputSha256,
			createHash("sha256").update(request.idempotencyKey).digest("hex"),
		];
		for (const query of queries) expect(query.values.slice(2, 6)).toEqual(head);
		expect(queries[1]?.values.slice(6)).toEqual([
			accountId,
			companyId,
			environmentId,
			"vercel.com",
			["accounts.vercel.com"],
			"agents@nordlys.example",
			"Hosting for the website",
			todoId,
			"company-kek-1",
			Buffer.from("sealed"),
			"c".repeat(64),
		]);
		expect(queries[2]?.values.slice(6)).toEqual([accountId, "closed"]);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.every((byte) => byte === 0)).toBe(true);
	});

	it("serves the runtime's calls with its token only, and a broker without the database calls has none", async () => {
		const f = vaultFixture();
		const authority: CloudSecretBrokerAuthority = {
			describeCapture: vi.fn(),
			completeCapture: vi.fn(),
			authorizeOperation: vi.fn(),
			authorizeRepositoryCredential: vi.fn(),
			describeCompanyAccountOpen: f.authority.describeCompanyAccountOpen,
			openCompanyAccount: vi.fn(async () => {
				throw databaseError("23505", "The company already has this account; use it");
			}),
			setCompanyAccountState: f.authority.setCompanyAccountState,
		};
		const runtimeToken = randomBytes(32).toString("base64url");
		const codingExecutorToken = randomBytes(32).toString("base64url");
		const service = new HttpCloudSecretBrokerService(
			new CloudSecretBroker({ authority, keyring: f.keyring, adapters: [] }),
			runtimeToken,
			{ codingExecutorToken },
		);
		services.push(service);
		const port = await service.start();
		const client = (token = runtimeToken) =>
			new HttpCloudSecretBrokerClient({
				origin: `http://127.0.0.1:${port}`,
				runtimeToken: token,
				companyId,
				allowLoopback: true,
			});
		expect(await client().companyAccount(openRequest(), AbortSignal.timeout(5000))).toEqual({
			schema: "qorpera.company-account-refusal/v1",
			code: "23505",
			message: "The company already has this account; use it",
		});
		const state = { ...call(), action: "state" as const, accountId, status: "connected" as const };
		expect(await client().companyAccount(state, AbortSignal.timeout(5000))).toEqual(
			descriptor(accountId, "connected"),
		);
		for (const token of [randomBytes(32).toString("base64url"), codingExecutorToken])
			await expect(client(token).companyAccount(state, AbortSignal.timeout(5000))).rejects.toThrow(
				"Cloud secret broker rejected the company account call",
			);
		expect(f.authority.setCompanyAccountState).toHaveBeenCalledTimes(1);
		const raw = await fetch(`http://127.0.0.1:${port}/v1/company-accounts?company=${companyId}`, {
			method: "POST",
			headers: { authorization: `Bearer ${runtimeToken}`, "content-type": "application/json" },
			body: JSON.stringify({ schema: "qorpera.company-account-request/v1", action: "open" }),
		});
		expect(raw.status).toBe(403);
		expect(await raw.json()).toEqual({ schema: "qorpera.cloud-secret-error/v1", error: "unavailable" });

		const plain = new CloudSecretBroker({
			authority: { ...authority, describeCompanyAccountOpen: undefined },
			keyring: f.keyring,
			adapters: [],
		});
		await expect(plain.companyAccount(state, AbortSignal.timeout(5000))).rejects.toThrow(
			"Company accounts unavailable",
		);
	});
});
