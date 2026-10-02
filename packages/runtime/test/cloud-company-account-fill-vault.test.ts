import { createHash, randomBytes } from "node:crypto";
import {
	type CompanyAccountFillIdentity,
	CompanyComputerFillKey,
} from "@qorpera/runtime/cloud-company-account-fill-box";
import {
	type CompanyAccountAuthority,
	type CompanyAccountFillRequest,
	CompanyAccountVault,
	parseCompanyAccountFillAnswer,
	parseCompanyAccountFillRequest,
} from "@qorpera/runtime/cloud-company-account-vault";
import { companyAccountFields, companyAccountTotpCode } from "@qorpera/runtime/cloud-company-accounts";
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
		field: field as CompanyAccountFillIdentity["field"],
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
		expect(queries[0]?.text).toBe(
			"select public.qorpera_fill_company_account($1::uuid,$2::text,$3::jsonb,$4::uuid,$5::text,$6::text) as result",
		);
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
		const service = new HttpCloudSecretBrokerService(
			new CloudSecretBroker({ authority, keyring: f.keyring, adapters: [] }),
			runtimeToken,
			{ codingExecutorToken },
		);
		services.push(service);
		const port = await service.start();
		const client = (token: string) =>
			new HttpCloudSecretBrokerClient({
				origin: `http://127.0.0.1:${port}`,
				runtimeToken: token,
				companyId,
				allowLoopback: true,
			});
		const answer = await client(runtimeToken).companyAccountFill(request(), AbortSignal.timeout(5000));
		expect(
			f.computer.open((answer as { box: Record<string, string> }).box, f.identity("password"), Date.now()).value,
		).toBe(password);
		for (const token of [randomBytes(32).toString("base64url"), codingExecutorToken])
			await expect(client(token).companyAccountFill(request(), AbortSignal.timeout(5000))).rejects.toThrow(
				"Cloud secret broker rejected the company account fill",
			);
		expect(f.authority.readCompanyAccountFill).toHaveBeenCalledTimes(1);
	});
});
