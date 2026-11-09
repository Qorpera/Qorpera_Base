import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	type CodingValueCaptureIdentity,
	codingValuePattern,
	sealCodingValueCapture,
} from "@qorpera/runtime/cloud-coding-value-capture-box";
import {
	type CodingValueAuthority,
	type CodingValueCaptureCall,
	type CodingValueCaptureKey,
	type CodingValueCaptureVersion,
	CodingValueVault,
	parseCodingValueCaptureAnswer,
	parseCodingValuePrepareAnswer,
	parseCodingValueRequest,
} from "@qorpera/runtime/cloud-coding-value-vault";
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

// 20260930695000: an agent makes a key on npm, GitHub, Stripe or Resend in its company computer's browser; the office
// reads it off the page and seals it to the value's capture key; the vault opens it, checks it, seals it as the
// value's next version and stores it, which also grants it to the call's repository.

const keyrings: CloudSecretKeyring[] = [];
const services: HttpCloudSecretBrokerService[] = [];
afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
	for (const keyring of keyrings.splice(0)) keyring.close();
});

const companyId = "99800000-0000-4000-8000-000000000010";
const environmentId = "99800000-0000-4000-8000-000000000020";
const secretId = "99800000-0000-4000-8000-000000000050";
const reservedId = "99800000-0000-4000-8000-000000000051";
const companyComputerId = "99800000-0000-4000-8000-000000000090";
const receiptId = "99800000-0000-4000-8000-0000000000a0";
const keyId = "company-kek-1";
const valueKey = { companyId, environmentId, secretId, keyId };
const now = 1_790_000_000_000;
const npmPattern = "^npm_[A-Za-z0-9]{36}$";
const token = `npm_${"Ab12Cd34Ef".repeat(3)}Gh12Kl`;
/** Who may open a capture's box: the vault, for this call of this computer's boot, of this value. */
const boxIdentity: CodingValueCaptureIdentity = {
	companyId,
	companyComputerId,
	computerGeneration: 3,
	receiptId,
	service: "npm",
	variable: "npm_token",
};

/** One vault_capture of a coding value, as the native host began it: its operation envelope names the run's company
 * and environment (its principals) and the value. */
function call(binding = nativeToolAuthorityFixture().binding): CodingValueCaptureCall {
	return {
		binding,
		receiptId,
		idempotencyKey: "c".repeat(64),
		envelope: JSON.stringify({
			schema: "qorpera.cloud-tool-operation/v2",
			principals: { companyId, environmentId, runId: binding.runId },
			operation: {
				tool: "computer_browser",
				arguments: {
					kind: "browser",
					action: "vault_capture",
					role: "button",
					name: "Generate token",
					codingValue: {
						service: "npm",
						variable: "npm_token",
						repository: "acme/web",
						purpose: "Installs the private packages.",
					},
				},
			},
		}),
	};
}

/** A database refusal as node-postgres raises it. */
function databaseError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

/** PostgreSQL's encode(…, 'base64'): a line break every 76 characters. */
function postgresBase64(bytes: Uint8Array): string {
	return (
		Buffer.from(bytes)
			.toString("base64")
			.match(/.{1,76}/g) ?? []
	).join("\n");
}

function fixture(authority: Partial<CodingValueAuthority> = {}, options: { at?: number; keyIds?: string[] } = {}) {
	const keyring = new CloudSecretKeyring(
		Object.fromEntries((options.keyIds ?? [keyId]).map((id) => [id, randomBytes(32)])),
	);
	keyrings.push(keyring);
	const publicKey = (id = secretId, key = keyId) =>
		keyring.codingValueCapturePublicKey({ companyId, environmentId, secretId: id, keyId: key });
	/** The prepare's answer when it keeps (or made) the key for `id`. */
	const kept = (id = secretId, replaced = false, key = keyId) => ({
		schema: "qorpera.coding-value-capture-key/v1",
		companyId,
		environmentId,
		variable: "npm_token",
		keyId: key,
		secretId: id,
		current: true,
		replaced,
		capturePublicKey: publicKey(id, key),
	});
	/** The database's description of the call's capture key, as qorpera_folder_describe_coding_value_capture gives it:
	 * by default no key yet, and no id the value keeps. */
	const described = (overrides: Record<string, unknown> = {}) => ({
		schema: "qorpera.coding-value-capture-description/v1",
		companyId,
		environmentId,
		variable: "npm_token",
		keyId,
		current: false,
		...overrides,
	});
	/** The database's answer to a capture's read, as qorpera_folder_read_coding_value_capture gives it. */
	const context = (overrides: Record<string, unknown> = {}) => ({
		schema: "qorpera.coding-value-capture-context/v1",
		secretId,
		version: 1,
		service: "npm",
		site: "www.npmjs.com",
		valuePattern: npmPattern,
		variable: "npm_token",
		repository: "acme/web",
		companyId,
		environmentId,
		keyId,
		capturePublicKey: publicKey(),
		receiptId,
		companyComputerId,
		computerGeneration: 3,
		...overrides,
	});
	/** The version the vault holds, as the read carries it. */
	const held = (value: string, version = 1) => {
		const envelope = keyring.seal({ value }, { ...valueKey, version });
		return {
			version,
			keyId,
			encryptedEnvelopeBase64: postgresBase64(envelope),
			envelopeSha256: createHash("sha256").update(envelope).digest("hex"),
		};
	};
	const box = (value = token, site = "www.npmjs.com", identity = boxIdentity, pattern = npmPattern) =>
		sealCodingValueCapture({ value, site }, codingValuePattern(pattern), publicKey(), identity, now);
	const keys: CodingValueCaptureKey[] = [];
	const stored: CodingValueCaptureVersion[] = [];
	/** The buffers the vault handed over, by reference: zeroed once the call is over. */
	const sent: Uint8Array[] = [];
	const describe = vi.fn<CodingValueAuthority["describeCodingValueCapture"]>(async () => described());
	const prepare = vi.fn<CodingValueAuthority["prepareCodingValueCapture"]>(async (_call, key) => {
		keys.push(key);
		return kept(key.secretId);
	});
	const read = vi.fn<CodingValueAuthority["readCodingValueCapture"]>(async () => context());
	const store = vi.fn<CodingValueAuthority["storeCodingValueCapture"]>(async (_call, version) => {
		sent.push(version.encryptedEnvelope);
		stored.push({ ...version, encryptedEnvelope: Uint8Array.from(version.encryptedEnvelope) });
		return {
			schema: "qorpera.coding-value-capture-stored/v1",
			variable: "npm_token",
			repository: "acme/web",
			secretId,
			version: version.version,
			replayed: false,
		};
	});
	const fake: CodingValueAuthority = {
		describeCodingValueCapture: describe,
		prepareCodingValueCapture: prepare,
		readCodingValueCapture: read,
		storeCodingValueCapture: store,
		...authority,
	};
	const vault = new CodingValueVault({
		authority: fake,
		keys: keyring,
		newId: () => secretId,
		now: () => options.at ?? now + 1000,
	});
	return {
		keyring,
		publicKey,
		described,
		kept,
		context,
		held,
		box,
		keys,
		stored,
		sent,
		describe,
		prepare,
		read,
		store,
		authority: fake,
		vault,
	};
}

/** The stored version's fields, opened as a coding session's environment opens them. */
function opened(keyring: CloudSecretKeyring, version: CodingValueCaptureVersion) {
	return keyring.use(version.encryptedEnvelope, { ...valueKey, version: version.version }, async (fields) => ({
		...fields,
	}));
}

const signal = () => AbortSignal.timeout(5000);

describe("a coding value's capture key", () => {
	it("is described first, then made for a new id under the company's key, its public half alone sent", async () => {
		const f = fixture();
		const request = call();
		expect(await f.vault.prepare(request, signal())).toEqual({
			schema: "qorpera.coding-value-prepare-answer/v1",
			variable: "npm_token",
			replaced: false,
		});
		expect(f.describe).toHaveBeenCalledWith(request, expect.anything());
		expect(f.prepare).toHaveBeenCalledOnce();
		expect(f.prepare).toHaveBeenCalledWith(request, { secretId, keyId, publicKey: f.publicKey() }, expect.anything());
		expect(f.describe.mock.invocationCallOrder[0]).toBeLessThan(f.prepare.mock.invocationCallOrder[0]!);
		expect(f.publicKey()).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	it("is made for the id the value keeps, under the key id the database names", async () => {
		const f = fixture({}, { keyIds: ["company-kek-1", "company-kek-2"] });
		f.describe.mockResolvedValueOnce(f.described({ secretId: reservedId, keyId: "company-kek-2" }));
		f.prepare.mockResolvedValueOnce(f.kept(reservedId, true, "company-kek-2"));
		expect(await f.vault.prepare(call(), signal())).toMatchObject({ replaced: true });
		expect(f.prepare.mock.calls.map(([, key]) => key)).toEqual([
			{ secretId: reservedId, keyId: "company-kek-2", publicKey: f.publicKey(reservedId, "company-kek-2") },
		]);
		// A key id this vault does not hold: nothing is prepared.
		const other = fixture();
		other.describe.mockResolvedValueOnce(other.described({ keyId: "company-kek-9" }));
		await expect(other.vault.prepare(call(), signal())).rejects.toThrow("Coding value capture unconfirmed");
		expect(other.prepare).not.toHaveBeenCalled();
	});

	it("keeps a current key without making it again, only when it is this vault's own for that id", async () => {
		const f = fixture();
		f.describe.mockResolvedValueOnce(
			f.described({ secretId: reservedId, current: true, capturePublicKey: f.publicKey(reservedId) }),
		);
		expect(await f.vault.prepare(call(), signal())).toEqual({
			schema: "qorpera.coding-value-prepare-answer/v1",
			variable: "npm_token",
			replaced: false,
		});
		expect(f.prepare).not.toHaveBeenCalled();
		const forged = fixture();
		forged.describe.mockResolvedValueOnce(
			forged.described({ secretId: reservedId, current: true, capturePublicKey: forged.publicKey() }),
		);
		await expect(forged.vault.prepare(call(), signal())).rejects.toThrow("Coding value capture unconfirmed");
		expect(forged.prepare).not.toHaveBeenCalled();
		for (const other of [
			{ current: true },
			{ current: true, secretId: reservedId },
			{ capturePublicKey: f.publicKey() },
			{ keyId: " " },
			{ variable: "NPM_TOKEN" },
			{ schema: "qorpera.coding-value-capture-key/v1" },
			{ extra: true },
		]) {
			const bad = fixture();
			bad.describe.mockResolvedValueOnce(bad.described(other));
			await expect(bad.vault.prepare(call(), signal()), JSON.stringify(other)).rejects.toThrow(
				"Coding value capture unconfirmed",
			);
			expect(bad.prepare).not.toHaveBeenCalled();
		}
	});

	it("follows the id the database names when it changed since the description, and never far", async () => {
		const f = fixture();
		f.prepare
			.mockResolvedValueOnce({
				schema: "qorpera.coding-value-capture-key/v1",
				companyId,
				environmentId,
				variable: "npm_token",
				keyId,
				secretId: reservedId,
				current: false,
			})
			.mockResolvedValueOnce(f.kept(reservedId, true));
		expect(await f.vault.prepare(call(), signal())).toMatchObject({ replaced: true });
		expect(f.prepare.mock.calls.map(([, key]) => key)).toEqual([
			{ secretId, keyId, publicKey: f.publicKey() },
			{ secretId: reservedId, keyId, publicKey: f.publicKey(reservedId) },
		]);
		const restless = fixture();
		let n = 0;
		restless.prepare.mockImplementation(async () => ({
			schema: "qorpera.coding-value-capture-key/v1",
			companyId,
			environmentId,
			variable: "npm_token",
			keyId,
			secretId: `99800000-0000-4000-8000-00000000010${n++}`,
			current: false,
		}));
		await expect(restless.vault.prepare(call(), signal())).rejects.toThrow("Coding value capture unconfirmed");
		expect(restless.prepare).toHaveBeenCalledTimes(3);
		// A prepare's answer for another company, environment, value or key, or the key not this vault's: unconfirmed.
		for (const other of [
			{ companyId: randomUUID() },
			{ environmentId: randomUUID() },
			{ variable: "npm_auth_token" },
			{ keyId: "company-kek-2" },
			{ current: false },
			{ capturePublicKey: f.publicKey(reservedId) },
			{ extra: true },
		]) {
			const bad = fixture();
			bad.prepare.mockResolvedValue({ ...bad.kept(), ...other });
			await expect(bad.vault.prepare(call(), signal()), JSON.stringify(other)).rejects.toThrow(
				"Coding value capture unconfirmed",
			);
		}
	});

	it("passes the database's refusals on in their own words, and asks again after a write that met another", async () => {
		for (const step of ["describe", "prepare"] as const)
			for (const [code, message] of [
				["42501", "coding value capture receipt is unavailable"],
				["42501", "Only owners and admins can save coding values; ask one of them"],
				["0A000", "Coding values need a company on the company folder"],
			] as const) {
				const fail = vi.fn(async () => {
					throw databaseError(code, message);
				});
				const f = fixture(
					step === "describe" ? { describeCodingValueCapture: fail } : { prepareCodingValueCapture: fail },
				);
				expect(await f.vault.prepare(call(), signal())).toEqual({
					schema: "qorpera.coding-value-refusal/v1",
					code,
					message,
				});
			}
		const raced = fixture();
		raced.prepare.mockRejectedValueOnce(databaseError("40003", "coding value capture outcome is unconfirmed"));
		expect(await raced.vault.prepare(call(), signal())).toMatchObject({ replaced: false });
		expect(raced.describe).toHaveBeenCalledTimes(2);
		expect(raced.prepare).toHaveBeenCalledTimes(2);
	});
});

describe("a coding value's capture", () => {
	it("stores the value as the next version, sealed as a member's coding value is, and wipes what it sent", async () => {
		const f = fixture();
		const request = { ...call(), box: f.box() };
		expect(await f.vault.capture(request, signal())).toEqual({
			schema: "qorpera.coding-value-capture-answer/v1",
			variable: "npm_token",
			repository: "acme/web",
			version: 1,
			unchanged: false,
		});
		expect(f.read).toHaveBeenCalledWith(request, expect.anything());
		expect(f.stored).toHaveLength(1);
		const version = f.stored[0] as CodingValueCaptureVersion;
		expect(version).toMatchObject({ ...valueKey, version: 1 });
		expect(version.envelopeSha256).toBe(createHash("sha256").update(version.encryptedEnvelope).digest("hex"));
		await expect(opened(f.keyring, version)).resolves.toEqual({ value: token });
		expect(Buffer.from(version.encryptedEnvelope).toString("utf8")).not.toContain("npm_");
		expect(f.sent[0]?.every((byte) => byte === 0)).toBe(true);
	});

	it("stores a value equal to the version it holds all the same, for the call's grant, and says it was unchanged", async () => {
		const same = fixture();
		same.read.mockResolvedValue(same.context({ version: 2, current: same.held(token) }));
		expect(await same.vault.capture({ ...call(), box: same.box() }, signal())).toEqual({
			schema: "qorpera.coding-value-capture-answer/v1",
			variable: "npm_token",
			repository: "acme/web",
			version: 2,
			unchanged: true,
		});
		expect(same.stored.map((version) => version.version)).toEqual([2]);
		const changed = fixture();
		changed.read.mockResolvedValue(changed.context({ version: 2, current: changed.held(`npm_${"x".repeat(36)}`) }));
		expect(await changed.vault.capture({ ...call(), box: changed.box() }, signal())).toMatchObject({
			version: 2,
			unchanged: false,
		});
		// A held version whose envelope is not the one its digest names is never compared, and nothing is stored.
		const forged = fixture();
		forged.read.mockResolvedValue(
			forged.context({ version: 2, current: { ...forged.held(token), envelopeSha256: "d".repeat(64) } }),
		);
		await expect(forged.vault.capture({ ...call(), box: forged.box() }, signal())).rejects.toThrow(
			"Coding value capture unconfirmed",
		);
		expect(forged.store).not.toHaveBeenCalled();
	});

	it("answers a call asked again with what it stored, without opening its box again", async () => {
		const f = fixture();
		f.read.mockResolvedValue(f.context({ version: 2, captured: { version: 1 } }));
		const box = f.box(token, "www.npmjs.com", { ...boxIdentity, receiptId: randomUUID() });
		expect(await f.vault.capture({ ...call(), box }, signal())).toMatchObject({ version: 1, unchanged: false });
		expect(f.store).not.toHaveBeenCalled();
	});

	it("refuses a value off another site, of another shape, or read too long ago, and stores nothing", async () => {
		const elsewhere = fixture();
		expect(
			await elsewhere.vault.capture({ ...call(), box: elsewhere.box(token, "evil.example.com") }, signal()),
		).toEqual({
			schema: "qorpera.coding-value-refusal/v1",
			code: "22023",
			message: "Values of npm are taken from www.npmjs.com",
		});
		// The office's pattern let it through; the database's does not.
		const shape = fixture();
		const short = "npm_short1234";
		expect(
			await shape.vault.capture(
				{ ...call(), box: shape.box(short, "www.npmjs.com", boxIdentity, "^npm_[A-Za-z0-9]{9}$") },
				signal(),
			),
		).toEqual({
			schema: "qorpera.coding-value-refusal/v1",
			code: "22023",
			message: "The value read is not a whole key of npm",
		});
		const late = fixture({}, { at: now + 90_001 });
		expect(await late.vault.capture({ ...call(), box: late.box() }, signal())).toMatchObject({
			schema: "qorpera.coding-value-refusal/v1",
			code: "55000",
		});
		for (const f of [elsewhere, shape, late]) expect(f.store).not.toHaveBeenCalled();
		// A box for another call, service or variable never opens; a context for another call is unconfirmed.
		const f = fixture();
		for (const box of [
			f.box(token, "www.npmjs.com", { ...boxIdentity, computerGeneration: 4 }),
			f.box(token, "www.npmjs.com", { ...boxIdentity, variable: "npm_auth_token" }),
			f.box(token, "www.npmjs.com", { ...boxIdentity, service: "github" }),
		])
			await expect(f.vault.capture({ ...call(), box }, signal())).rejects.toThrow(
				"Coding value capture unconfirmed",
			);
		f.read.mockResolvedValue(f.context({ receiptId: randomUUID() }));
		await expect(f.vault.capture({ ...call(), box: f.box() }, signal())).rejects.toThrow(
			"Coding value capture unconfirmed",
		);
		// A pattern that does not mean the same in both dialects is never guessed at.
		f.read.mockResolvedValue(f.context({ valuePattern: "^npm_\\w{36}$" }));
		await expect(f.vault.capture({ ...call(), box: f.box() }, signal())).rejects.toThrow(
			"Coding value capture unconfirmed",
		);
		expect(f.store).not.toHaveBeenCalled();
	});

	it("reads again after a store that met another capture, and leaves one it keeps losing unconfirmed", async () => {
		const lost = databaseError("40003", "coding value capture outcome is unconfirmed");
		const raced = fixture();
		raced.store.mockRejectedValueOnce(lost);
		raced.read
			.mockResolvedValueOnce(raced.context())
			.mockResolvedValueOnce(raced.context({ version: 2, current: raced.held(`npm_${"x".repeat(36)}`) }));
		expect(await raced.vault.capture({ ...call(), box: raced.box() }, signal())).toMatchObject({ version: 2 });
		expect(raced.read).toHaveBeenCalledTimes(2);
		for (const [error, attempts] of [
			[lost, 3],
			[new Error("connection terminated"), 1],
		] as const) {
			const sent: Uint8Array[] = [];
			const f = fixture({
				storeCodingValueCapture: vi.fn(async (_call, version: CodingValueCaptureVersion) => {
					sent.push(version.encryptedEnvelope);
					throw error;
				}),
			});
			await expect(f.vault.capture({ ...call(), box: f.box() }, signal())).rejects.toThrow(
				"Coding value capture unconfirmed",
			);
			expect(sent).toHaveLength(attempts);
			expect(sent.every((envelope) => envelope.every((byte) => byte === 0))).toBe(true);
		}
		// The database's refusal in its own words.
		const removed = fixture();
		removed.read.mockRejectedValueOnce(databaseError("55000", "The coding value's capture key must be made again"));
		expect(await removed.vault.capture({ ...call(), box: removed.box() }, signal())).toEqual({
			schema: "qorpera.coding-value-refusal/v1",
			code: "55000",
			message: "The coding value's capture key must be made again",
		});
		// A store's answer for another secret or repository is unconfirmed.
		for (const other of [{ secretId: randomUUID() }, { repository: "acme/other" }]) {
			const bad = fixture({
				storeCodingValueCapture: vi.fn(async () => ({
					schema: "qorpera.coding-value-capture-stored/v1",
					variable: "npm_token",
					repository: "acme/web",
					secretId,
					version: 1,
					replayed: false,
					...other,
				})),
			});
			await expect(bad.vault.capture({ ...call(), box: bad.box() }, signal())).rejects.toThrow(
				"Coding value capture unconfirmed",
			);
		}
	});
});

describe("coding value requests and answers", () => {
	it("reads a prepare and a capture, and refuses anything else", () => {
		const request = call();
		const box = sealCodingValueCapture(
			{ value: token, site: "www.npmjs.com" },
			codingValuePattern(npmPattern),
			Buffer.alloc(32, 9).toString("base64url"),
			boxIdentity,
			now,
		);
		expect(parseCodingValueRequest({ schema: "qorpera.coding-value-prepare-request/v1", ...request })).toEqual({
			prepare: request,
		});
		const wired = { schema: "qorpera.coding-value-capture-request/v1", ...request, box };
		expect(parseCodingValueRequest(wired)).toEqual({ capture: { ...request, box } });
		for (const bad of [
			{ ...wired, schema: "qorpera.event-hook-capture-request/v1" },
			{ schema: "qorpera.coding-value-prepare-request/v1", ...request, box },
			{ ...wired, box: undefined },
			{ ...wired, box: { ...box, extra: "x" } },
			{ ...wired, idempotencyKey: "short" },
			{ ...wired, value: token },
		])
			expect(() => parseCodingValueRequest(bad)).toThrow();
		const prepared = { schema: "qorpera.coding-value-prepare-answer/v1", variable: "npm_token", replaced: false };
		expect(parseCodingValuePrepareAnswer(prepared)).toEqual(prepared);
		const answer = {
			schema: "qorpera.coding-value-capture-answer/v1",
			variable: "npm_token",
			repository: "acme/web",
			version: 2,
			unchanged: true,
		};
		expect(parseCodingValueCaptureAnswer(answer)).toEqual(answer);
		const refusal = {
			schema: "qorpera.coding-value-refusal/v1",
			code: "55000",
			message: "This company is being deleted",
		};
		expect(parseCodingValueCaptureAnswer(refusal)).toEqual(refusal);
		expect(parseCodingValuePrepareAnswer(refusal)).toEqual(refusal);
		for (const bad of [
			{ ...answer, version: 0 },
			{ ...answer, value: token },
			{ ...answer, repository: "Acme/Web" },
			{ ...refusal, code: "40003" },
		])
			expect(() => parseCodingValueCaptureAnswer(bad), JSON.stringify(bad)).toThrow();
		expect(() => parseCodingValuePrepareAnswer({ ...prepared, replaced: "no" })).toThrow();
	});
});

describe("coding values over the broker", () => {
	it("calls only its broker-role functions, with the run's binding and the call's own envelope", async () => {
		const queries: Array<{ text: string; values: readonly unknown[] }> = [];
		const sent: Buffer[] = [];
		const brokerAuthorityId = randomUUID();
		const brokerCapability = randomBytes(32).toString("base64url");
		const authority = new PostgresCloudSecretBrokerAuthority({
			database: {
				async query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[]) {
					queries.push({
						text,
						values: values.map((value) => (Buffer.isBuffer(value) ? Buffer.from(value) : value)),
					});
					sent.push(...values.filter((value) => Buffer.isBuffer(value)));
					return { rowCount: 1, rows: [{ result: { accepted: true } } as unknown as Row] };
				},
			},
			brokerAuthorityId,
			brokerCapability,
		});
		const request = call();
		await authority.describeCodingValueCapture(request, signal());
		await authority.prepareCodingValueCapture(request, { secretId, keyId, publicKey: "k" }, signal());
		await authority.readCodingValueCapture(request, signal());
		await authority.storeCodingValueCapture(
			request,
			{ ...valueKey, version: 2, encryptedEnvelope: Buffer.from("sealed"), envelopeSha256: "e".repeat(64) },
			signal(),
		);
		expect(queries.map((query) => query.text)).toEqual([
			"select public.qorpera_folder_describe_coding_value_capture($1::uuid,$2::text,$3::jsonb,$4::uuid,$5::text,$6::text) as result",
			"select public.qorpera_folder_prepare_coding_value_capture($1::uuid,$2::text,$3::jsonb,$4::uuid,$5::text,$6::text,$7::uuid,$8::text,$9::text) as result",
			"select public.qorpera_folder_read_coding_value_capture($1::uuid,$2::text,$3::jsonb,$4::uuid,$5::text,$6::text) as result",
			"select public.qorpera_folder_store_coding_value_capture($1::uuid,$2::text,$3::jsonb,$4::uuid,$5::text,$6::text,$7::uuid,$8::bigint,$9::uuid,$10::uuid,$11::text,$12::bytea,$13::text) as result",
		]);
		const head = [
			brokerAuthorityId,
			createHash("sha256").update(brokerCapability).digest("hex"),
			JSON.stringify(request.binding),
			receiptId,
			request.envelope,
			createHash("sha256").update("c".repeat(64)).digest("hex"),
		];
		expect(queries.map((query) => query.values)).toEqual([
			head,
			[...head, secretId, keyId, "k"],
			head,
			[...head, secretId, 2, companyId, environmentId, keyId, Buffer.from("sealed"), "e".repeat(64)],
		]);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.every((byte) => byte === 0)).toBe(true);
	});

	it("serves the runtime's prepares and captures with its token and the run's own lease only", async () => {
		const f = fixture();
		const base: CloudSecretBrokerAuthority = {
			describeCapture: vi.fn(),
			completeCapture: vi.fn(),
			authorizeOperation: vi.fn(),
			authorizeRepositoryCredential: vi.fn(),
		};
		const runtimeToken = randomBytes(32).toString("base64url");
		const lease = randomBytes(32).toString("base64url");
		const proveBinding = vi.fn<NativeBindingProof>(async (binding, presented) => {
			if (presented !== `job.${(binding as { jobId: string }).jobId.toLowerCase()}.${lease}`)
				throw new Error("native binding proof is refused");
		});
		const service = new HttpCloudSecretBrokerService(
			new CloudSecretBroker({ authority: { ...base, ...f.authority }, keyring: f.keyring, adapters: [] }),
			runtimeToken,
			{ proveBinding },
		);
		services.push(service);
		const port = await service.start();
		const request = call();
		const own = `job.${request.binding.jobId.toLowerCase()}.${lease}`;
		const client = (holder = own, token = runtimeToken) =>
			new HttpCloudSecretBrokerClient({
				origin: `http://127.0.0.1:${port}`,
				runtimeToken: token,
				companyId,
				holder: () => holder,
				allowLoopback: true,
			});
		expect(await client().codingValuePrepare(request, signal())).toEqual({
			schema: "qorpera.coding-value-prepare-answer/v1",
			variable: "npm_token",
			replaced: false,
		});
		// The broker's vault keeps the real clock, so the box is read now.
		const box = sealCodingValueCapture(
			{ value: token, site: "www.npmjs.com" },
			codingValuePattern(npmPattern),
			f.publicKey(),
			boxIdentity,
			Date.now(),
		);
		expect(await client().codingValueCapture({ ...request, box }, signal())).toEqual({
			schema: "qorpera.coding-value-capture-answer/v1",
			variable: "npm_token",
			repository: "acme/web",
			version: 1,
			unchanged: false,
		});
		expect(proveBinding).toHaveBeenCalledWith(expect.objectContaining({ jobId: request.binding.jobId }), own);
		f.read.mockRejectedValueOnce(databaseError("55000", "This company is being deleted"));
		expect(await client().codingValueCapture({ ...request, box }, signal())).toEqual({
			schema: "qorpera.coding-value-refusal/v1",
			code: "55000",
			message: "This company is being deleted",
		});
		// Without the runtime's token or the run's own lease, refused before the database is asked anything.
		const calls = f.describe.mock.calls.length + f.read.mock.calls.length + f.prepare.mock.calls.length;
		await expect(
			client(own, randomBytes(32).toString("base64url")).codingValuePrepare(request, signal()),
		).rejects.toThrow("Cloud secret broker rejected the coding value capture");
		for (const holder of ["", lease, `job.${randomUUID()}.${lease}`])
			await expect(client(holder).codingValueCapture({ ...request, box }, signal())).rejects.toThrow(
				"Cloud secret broker rejected the coding value capture",
			);
		expect(f.describe.mock.calls.length + f.read.mock.calls.length + f.prepare.mock.calls.length).toBe(calls);
		expect(f.stored).toHaveLength(1);
		// A broker whose database cannot serve coding values takes none.
		const bare = new CloudSecretBroker({ authority: base, keyring: f.keyring, adapters: [] });
		await expect(bare.codingValuePrepare(request, signal())).rejects.toThrow("Coding values unavailable");
	});
});
