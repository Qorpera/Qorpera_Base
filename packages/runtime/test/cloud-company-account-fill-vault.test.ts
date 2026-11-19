import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	type CompanyAccountFillIdentity,
	CompanyComputerFillKey,
} from "@qorpera/runtime/cloud-company-account-fill-box";
import {
	type CompanyAccountAuthority,
	type CompanyAccountFillRequest,
	type CompanyAccountMachineFillRequest,
	CompanyAccountVault,
	parseCompanyAccountFillAnswer,
	parseCompanyAccountFillRequest,
	parseCompanyAccountMachineFillRequest,
} from "@qorpera/runtime/cloud-company-account-vault";
import { companyAccountFields, companyAccountTotpCode } from "@qorpera/runtime/cloud-company-accounts";
import {
	CloudSecretBroker,
	type CloudSecretBrokerAuthority,
	PostgresCloudSecretBrokerAuthority,
} from "@qorpera/runtime/cloud-secret-broker";
import {
	HttpCloudSecretBrokerClient,
	HttpCloudSecretBrokerService,
	type NativeBindingProof,
} from "@qorpera/runtime/cloud-secret-broker-http";
import { CloudSecretKeyring } from "@qorpera/runtime/cloud-secret-crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeToolAuthorityFixture } from "./fixtures/native-tool-authority-fixture.ts";

const keyrings: CloudSecretKeyring[] = [];
const services: HttpCloudSecretBrokerService[] = [];
afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
	for (const keyring of keyrings.splice(0)) keyring.close();
});

const companyId = "80300000-0000-4000-8000-000000000010";
const environmentId = "80300000-0000-4000-8000-000000000020";
const accountId = "80300000-0000-4000-8000-000000000050";
const receiptId = "80300000-0000-4000-8000-000000000060";
const companyComputerId = "80300000-0000-4000-8000-000000000070";
/** RFC 6238's SHA-1 seed in base32. */
const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const password = "Pw-1234567890abcdEFGH";
/** A 30 s period's first moment: a code with all 30 s left. */
const now = 1_790_000_010_000;

function request(field = "password"): CompanyAccountFillRequest {
	return {
		binding: nativeToolAuthorityFixture().binding,
		receiptId,
		idempotencyKey: "b".repeat(64),
		envelope: JSON.stringify({ operation: { arguments: { action: "vault_fill", field } } }),
	};
}

/** The vault with a real keyring, an account sealed in it, and the database's fill answer for one computer. */
function fixture(
	options: { totp?: boolean; field?: string; context?: Record<string, unknown>; now?: number; oneLine?: boolean } = {},
) {
	const keyring = new CloudSecretKeyring({ "company-kek-1": randomBytes(32) });
	keyrings.push(keyring);
	const computer = new CompanyComputerFillKey();
	const envelope = keyring.seal(
		companyAccountFields({
			password,
			...(options.totp === false ? {} : { totp: { seed, digits: 6, period: 30, algorithm: "SHA1" } }),
		}),
		{ companyId, environmentId, secretId: accountId, version: 2, keyId: "company-kek-1" },
	);
	const context = {
		schema: "qorpera.company-account-fill-context/v1",
		accountId,
		site: "vercel.com",
		signInHosts: ["accounts.vercel.com"],
		login: "agents@nordlys.example",
		twoStep: "authenticator",
		status: "connected",
		version: 2,
		companyId,
		environmentId,
		keyId: "company-kek-1",
		// As PostgreSQL's encode(…, 'base64') writes it: a line break every 76 characters.
		encryptedEnvelopeBase64: options.oneLine
			? Buffer.from(envelope).toString("base64")
			: (
					Buffer.from(envelope)
						.toString("base64")
						.match(/.{1,76}/g) ?? []
				).join("\n"),
		envelopeSha256: createHash("sha256").update(envelope).digest("hex"),
		receiptId,
		field: options.field ?? "password",
		companyComputerId,
		computerGeneration: 3,
		fillPublicKey: computer.publicKey,
		...options.context,
	};
	const authority: CompanyAccountAuthority = {
		describeCompanyAccountOpen: vi.fn(),
		openCompanyAccount: vi.fn(),
		setCompanyAccountState: vi.fn(),
		readCompanyAccountFill: vi.fn(async () => context),
	};
	const wait = vi.fn(async (_ms: number) => undefined);
	let clock = options.now ?? now;
	const vault = new CompanyAccountVault({
		authority,
		keys: keyring,
		now: () => clock,
		wait: async (ms) => {
			await wait(ms);
			clock += ms;
		},
	});
	const identity = (field: string): CompanyAccountFillIdentity => ({
		companyId,
		companyComputerId,
		computerGeneration: 3,
		receiptId,
		accountId,
		field: field as Exclude<CompanyAccountFillIdentity["field"], "signing_secret">,
	});
	return { keyring, computer, vault, authority, wait, identity, clock: () => clock };
}

describe("company account fill in the vault", () => {
	it("seals the password, the login or the code now to the computer's key, for this call and the account's hosts", async () => {
		for (const [field, expected] of [
			["password", password],
			["login", "agents@nordlys.example"],
			["code", companyAccountTotpCode({ seed, digits: 6, period: 30, algorithm: "SHA1" }, now)],
		] as const) {
			const f = fixture({ field });
			const answer = await f.vault.fill(request(field), AbortSignal.timeout(5000));
			expect(answer.schema, field).toBe("qorpera.company-account-fill-answer/v1");
			expect(JSON.stringify(answer)).not.toContain(expected);
			const box = (answer as { box: Record<string, string> }).box;
			expect(f.computer.open(box, f.identity(field), now)).toMatchObject({
				field,
				value: expected,
				hosts: ["vercel.com", "accounts.vercel.com"],
			});
			// Not for another computer, call or field.
			expect(() => new CompanyComputerFillKey().open(box, f.identity(field), now)).toThrow();
			expect(() => f.computer.open(box, { ...f.identity(field), computerGeneration: 4 }, now)).toThrow();
			expect(f.wait).not.toHaveBeenCalled();
		}
	});

	it("reads the envelope in PostgreSQL's spelling and in one line alike", async () => {
		const f = fixture();
		expect((await f.vault.fill(request(), AbortSignal.timeout(5000))).schema).toBe(
			"qorpera.company-account-fill-answer/v1",
		);
		const context = await f.authority.readCompanyAccountFill(request(), AbortSignal.timeout(5000));
		const spelled = (context as { encryptedEnvelopeBase64: string }).encryptedEnvelopeBase64;
		expect(spelled.split("\n").length).toBeGreaterThan(5);
		const g = fixture({ oneLine: true });
		const answer = await g.vault.fill(request(), AbortSignal.timeout(5000));
		expect(answer.schema).toBe("qorpera.company-account-fill-answer/v1");
	});

	it("waits for the next code when the current one has less than three seconds left", async () => {
		// 28.5 s into a 30 s period.
		const late = now + 28_500;
		const f = fixture({ field: "code", now: late });
		const answer = await f.vault.fill(request("code"), AbortSignal.timeout(5000));
		expect(f.wait).toHaveBeenCalledWith(1_550);
		const box = (answer as { box: Record<string, string> }).box;
		expect(f.computer.open(box, f.identity("code"), f.clock()).value).toBe(
			companyAccountTotpCode({ seed, digits: 6, period: 30, algorithm: "SHA1" }, late + 1_550),
		);
	});

	it("refuses a code for an account without an authenticator, in words the agent can act on", async () => {
		const f = fixture({ field: "code", totp: false });
		expect(await f.vault.fill(request("code"), AbortSignal.timeout(5000))).toEqual({
			schema: "qorpera.company-account-refusal/v1",
			code: "22023",
			message: "This account has no authenticator in the vault; its code comes by mail or text",
		});
	});

	it("passes the database's refusals on, and seals nothing for an answer that does not hold together", async () => {
		const refused = fixture();
		refused.authority.readCompanyAccountFill = vi.fn(async () => {
			throw Object.assign(new Error("This computer cannot type account values until it restarts on a newer image"), {
				code: "0A000",
			});
		});
		const vault = new CompanyAccountVault({ authority: refused.authority, keys: refused.keyring });
		expect(await vault.fill(request(), AbortSignal.timeout(5000))).toEqual({
			schema: "qorpera.company-account-refusal/v1",
			code: "0A000",
			message: "This computer cannot type account values until it restarts on a newer image",
		});
		for (const context of [
			{ receiptId: "80300000-0000-4000-8000-000000000061" },
			{ envelopeSha256: "0".repeat(64) },
			{ encryptedEnvelopeBase64: "AQI" },
			{ keyId: "company-kek-9" },
			{ version: 1 },
			{ companyId: "80300000-0000-4000-8000-000000000011" },
			{ accountId: "80300000-0000-4000-8000-000000000051" },
			{ fillPublicKey: Buffer.alloc(32).toString("base64url") },
			{ fillPublicKey: "short" },
			{ field: "new_password" },
			{ site: "Vercel.com" },
			{ extra: 1 },
		]) {
			const f = fixture({ context });
			await expect(f.vault.fill(request(), AbortSignal.timeout(5000)), JSON.stringify(context)).rejects.toThrow(
				"Company account fill unconfirmed",
			);
		}
	});
});

describe("company account fill requests and answers", () => {
	it("reads a fill request and answer, and refuses anything else", () => {
		const wire = { schema: "qorpera.company-account-fill-request/v1", ...request() };
		const { binding: _binding, ...rest } = request();
		expect(parseCompanyAccountFillRequest(wire)).toMatchObject(rest);
		for (const bad of [
			{ ...wire, schema: "other" },
			{ ...wire, extra: 1 },
			{ ...wire, envelope: "" },
			{ ...wire, envelope: "x".repeat(65_537) },
			{ ...wire, receiptId: "x" },
			{ ...wire, idempotencyKey: "short" },
		])
			expect(() => parseCompanyAccountFillRequest(bad)).toThrow();
		const box = { schema: "s", ephemeralPublicKey: "e", iv: "i", tag: "t", ciphertext: "c" };
		expect(parseCompanyAccountFillAnswer({ schema: "qorpera.company-account-fill-answer/v1", box })).toEqual({
			schema: "qorpera.company-account-fill-answer/v1",
			box,
		});
		for (const bad of [
			{ schema: "qorpera.company-account-fill-answer/v1", box, value: "x" },
			{ schema: "qorpera.company-account-fill-answer/v1", box: { ...box, value: "x" } },
			{ schema: "qorpera.company-account-refusal/v1", code: "55000", message: "paused" },
		])
			expect(() => parseCompanyAccountFillAnswer(bad)).toThrow();
	});
});

describe("company account fill over the broker", () => {
	it("calls only the broker's fill function, with the call's own envelope", async () => {
		const queries: Array<{ text: string; values: readonly unknown[] }> = [];
		const authority = new PostgresCloudSecretBrokerAuthority({
			database: {
				async query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[]) {
					queries.push({ text, values });
					return { rowCount: 1, rows: [{ result: {} } as unknown as Row] };
				},
			},
			brokerAuthorityId: "80300000-0000-4000-8000-000000000040",
			brokerCapability: randomBytes(32).toString("base64url"),
		});
		const call = request();
		await authority.readCompanyAccountFill(call, AbortSignal.timeout(5000));
		expect(queries).toHaveLength(1);
		expect(queries[0]?.text).toMatch(/\bpublic\.qorpera_fill_company_account\(/);
		expect(queries[0]?.values.slice(2)).toEqual([
			JSON.stringify(call.binding),
			receiptId,
			call.envelope,
			createHash("sha256").update(call.idempotencyKey).digest("hex"),
		]);
	});

	it("serves the runtime's fills with its token only", async () => {
		const f = fixture();
		const authority: CloudSecretBrokerAuthority = {
			describeCapture: vi.fn(),
			completeCapture: vi.fn(),
			authorizeOperation: vi.fn(),
			authorizeRepositoryCredential: vi.fn(),
			...f.authority,
		};
		const runtimeToken = randomBytes(32).toString("base64url");
		const codingExecutorToken = randomBytes(32).toString("base64url");
		// G2-6a: the database's lease proof stands in here (its own test is 986): only the run's own lease token, as
		// `job.<the binding's job>.<lease token>`, proves a request's binding.
		const fill = request();
		const lease = randomBytes(32).toString("base64url");
		const own = `job.${fill.binding.jobId.toLowerCase()}.${lease}`;
		const proveBinding = vi.fn<NativeBindingProof>(async (binding, presented) => {
			if (presented !== `job.${(binding as { jobId: string }).jobId.toLowerCase()}.${lease}`)
				throw new Error("native binding proof is refused");
		});
		const service = new HttpCloudSecretBrokerService(
			new CloudSecretBroker({ authority, keyring: f.keyring, adapters: [] }),
			runtimeToken,
			{ codingExecutorToken, proveBinding },
		);
		services.push(service);
		const port = await service.start();
		const client = (token: string, holder = own) =>
			new HttpCloudSecretBrokerClient({
				origin: `http://127.0.0.1:${port}`,
				runtimeToken: token,
				companyId,
				holder: () => holder,
				allowLoopback: true,
			});
		const answer = await client(runtimeToken).companyAccountFill(fill, AbortSignal.timeout(5000));
		expect(
			f.computer.open((answer as { box: Record<string, string> }).box, f.identity("password"), Date.now()).value,
		).toBe(password);
		expect(proveBinding).toHaveBeenCalledWith(
			expect.objectContaining({ jobId: fill.binding.jobId, runId: fill.binding.runId }),
			own,
		);
		for (const token of [randomBytes(32).toString("base64url"), codingExecutorToken])
			await expect(client(token).companyAccountFill(fill, AbortSignal.timeout(5000))).rejects.toThrow(
				"Cloud secret broker rejected the company account fill",
			);
		// Without the run's own lease (a malformed holder, another run's, or another lease token for this run's job), the
		// fill is refused before the database is asked anything.
		for (const holder of [
			"",
			lease,
			`identity.${lease}`,
			`${own}x`,
			`job.${randomUUID()}.${lease}`,
			`job.${fill.binding.jobId.toLowerCase()}.${"W".repeat(43)}`,
		])
			await expect(client(runtimeToken, holder).companyAccountFill(fill, AbortSignal.timeout(5000))).rejects.toThrow(
				"Cloud secret broker rejected the company account fill",
			);
		expect(f.authority.readCompanyAccountFill).toHaveBeenCalledTimes(1);
	});
});

describe("company account fill on a machine", () => {
	const companyMachineId = "80300000-0000-4000-8000-000000000080";
	const placementId = "80300000-0000-4000-8000-000000000081";
	const bootId = "80300000-0000-4000-8000-000000000082";
	function machine(
		options: { field?: string; context?: Record<string, unknown>; helper?: CompanyComputerFillKey } = {},
	) {
		const f = fixture(options.field ? { field: options.field } : {});
		const helper = options.helper ?? new CompanyComputerFillKey();
		const office = f.authority.readCompanyAccountFill as unknown as () => Promise<Record<string, unknown>>;
		const read = vi.fn(async () => {
			const { companyComputerId: _computer, computerGeneration: _generation, ...facts } = await office();
			return {
				...facts,
				schema: "qorpera.company-account-machine-fill-context/v1",
				companyMachineId,
				placementId,
				bootId,
				fillPublicKey: helper.publicKey,
				...options.context,
			};
		});
		const vault = new CompanyAccountVault({
			authority: { ...f.authority, readCompanyAccountMachineFill: read },
			keys: f.keyring,
			now: () => now,
		});
		const fillRequest = (field = options.field ?? "password"): CompanyAccountMachineFillRequest => ({
			...request(field),
			executorOwner: "mx-803",
			placementId,
			bootId,
			fillPublicKey: helper.publicKey,
		});
		const identity = (field: string) =>
			({
				companyId,
				companyMachineId,
				placementId,
				bootId,
				receiptId,
				accountId,
				field,
			}) as CompanyAccountFillIdentity;
		return { ...f, helper, read, vault, fillRequest, identity };
	}

	it("seals the password, the login or the code now to the helper's key, bound to the machine, placement and boot", async () => {
		for (const [field, expected] of [
			["password", password],
			["login", "agents@nordlys.example"],
			["code", companyAccountTotpCode({ seed, digits: 6, period: 30, algorithm: "SHA1" }, now)],
		] as const) {
			const f = machine({ field });
			const asked = f.fillRequest(field);
			const answer = await f.vault.machineFill(asked, AbortSignal.timeout(5000));
			expect(answer.schema, field).toBe("qorpera.company-account-fill-answer/v1");
			expect(JSON.stringify(answer)).not.toContain(expected);
			const box = (answer as { box: Record<string, string> }).box;
			expect(f.helper.open(box, f.identity(field), now)).toMatchObject({
				field,
				value: expected,
				hosts: ["vercel.com", "accounts.vercel.com"],
			});
			expect(f.read).toHaveBeenCalledWith(asked, expect.any(AbortSignal));
			// Never for another key, boot, placement or receipt, nor as an office's box.
			expect(() => new CompanyComputerFillKey().open(box, f.identity(field), now)).toThrow();
			for (const other of [{ bootId: randomUUID() }, { placementId: randomUUID() }, { receiptId: randomUUID() }])
				expect(() =>
					f.helper.open(box, { ...f.identity(field), ...other } as CompanyAccountFillIdentity, now),
				).toThrow();
			expect(() =>
				f.helper.open(
					box,
					{
						companyId,
						companyComputerId: companyMachineId,
						computerGeneration: 1,
						receiptId,
						accountId,
						field,
					} as never,
					now,
				),
			).toThrow();
		}
	});

	it("seals nothing when the database's answer is not exactly what the executor named", async () => {
		for (const context of [
			{ placementId: "80300000-0000-4000-8000-000000000091" },
			{ bootId: "80300000-0000-4000-8000-000000000092" },
			{ fillPublicKey: new CompanyComputerFillKey().publicKey },
			{ receiptId: "80300000-0000-4000-8000-000000000061" },
			{ schema: "qorpera.company-account-fill-context/v1" },
			{ companyComputerId: companyMachineId },
			{ field: "new_password" },
		]) {
			const f = machine({ context });
			await expect(
				f.vault.machineFill(f.fillRequest(), AbortSignal.timeout(5000)),
				JSON.stringify(context),
			).rejects.toThrow("Company account fill unconfirmed");
		}
		// The database's refusals pass on in its own words; a broker without the machine read seals nothing.
		const refused = machine();
		refused.read.mockRejectedValueOnce(
			Object.assign(new Error("The company has no such open account"), { code: "22023" }),
		);
		expect(await refused.vault.machineFill(refused.fillRequest(), AbortSignal.timeout(5000))).toEqual({
			schema: "qorpera.company-account-refusal/v1",
			code: "22023",
			message: "The company has no such open account",
		});
		const f = fixture();
		const without = new CompanyAccountVault({ authority: f.authority, keys: f.keyring });
		await expect(
			without.machineFill(
				{ ...request(), executorOwner: "mx", placementId, bootId, fillPublicKey: f.computer.publicKey },
				AbortSignal.timeout(5000),
			),
		).rejects.toThrow("Company account fill unconfirmed");
	});

	it("reads the executor's request and refuses anything else", () => {
		const helper = new CompanyComputerFillKey();
		const { binding, ...rest } = request();
		const wire = {
			schema: "qorpera.company-account-machine-fill-request/v1",
			binding,
			...rest,
			executorOwner: "mx-803",
			placementId,
			bootId,
			fillPublicKey: helper.publicKey,
		};
		expect(parseCompanyAccountMachineFillRequest(wire)).toMatchObject({
			...rest,
			executorOwner: "mx-803",
			placementId,
			bootId,
		});
		for (const bad of [
			{ ...wire, schema: "qorpera.company-account-fill-request/v1" },
			{ ...wire, value: password },
			{ ...wire, executorOwner: "mx 803" },
			{ ...wire, placementId: "placement" },
			{ ...wire, fillPublicKey: "short" },
			{ ...wire, idempotencyKey: "short" },
		])
			expect(() => parseCompanyAccountMachineFillRequest(bad), JSON.stringify(bad)).toThrow();
	});

	it("calls the broker's machine fill function, and serves it with the coding executor's token only", async () => {
		const queries: Array<{ text: string; values: readonly unknown[] }> = [];
		const postgres = new PostgresCloudSecretBrokerAuthority({
			database: {
				async query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[]) {
					queries.push({ text, values });
					return { rowCount: 1, rows: [{ result: {} } as unknown as Row] };
				},
			},
			brokerAuthorityId: "80300000-0000-4000-8000-000000000040",
			brokerCapability: randomBytes(32).toString("base64url"),
		});
		const f = machine();
		const call = f.fillRequest();
		await postgres.readCompanyAccountMachineFill(call, AbortSignal.timeout(5000));
		expect(queries[0]?.text).toMatch(/\bpublic\.qorpera_fill_company_account_on_machine\(/);
		expect(queries[0]?.values.slice(2)).toEqual([
			JSON.stringify(call.binding),
			receiptId,
			call.envelope,
			createHash("sha256").update(call.idempotencyKey).digest("hex"),
			"mx-803",
			placementId,
			bootId,
			f.helper.publicKey,
		]);
		const authority: CloudSecretBrokerAuthority = {
			describeCapture: vi.fn(),
			completeCapture: vi.fn(),
			authorizeOperation: vi.fn(),
			authorizeRepositoryCredential: vi.fn(),
			...f.authority,
			readCompanyAccountMachineFill: f.read,
		};
		const runtimeToken = randomBytes(32).toString("base64url");
		const codingExecutorToken = randomBytes(32).toString("base64url");
		const service = new HttpCloudSecretBrokerService(
			new CloudSecretBroker({ authority, keyring: f.keyring, adapters: [] }),
			runtimeToken,
			{ codingExecutorToken, proveBinding: vi.fn<NativeBindingProof>(async () => undefined) },
		);
		services.push(service);
		const port = await service.start();
		const post = (token: string) =>
			fetch(`http://127.0.0.1:${port}/v1/machine-account-fills?company=${companyId}`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify({ schema: "qorpera.company-account-machine-fill-request/v1", ...call }),
			});
		const served = await post(codingExecutorToken);
		expect(served.status).toBe(200);
		expect(served.headers.get("cache-control")).toBe("no-store");
		const answer = (await served.json()) as { box: Record<string, string> };
		expect(f.helper.open(answer.box, f.identity("password"), Date.now()).value).toBe(password);
		// The runtime token every guest holds never opens it.
		for (const token of [runtimeToken, randomBytes(32).toString("base64url")]) {
			const refused = await post(token);
			expect(refused.status).toBe(404);
		}
		expect(f.read).toHaveBeenCalledTimes(1);
	});
});
