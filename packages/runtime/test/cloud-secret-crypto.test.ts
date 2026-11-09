import { randomBytes, randomUUID } from "node:crypto";
import { sealCodingValueCapture } from "@qorpera/runtime/cloud-coding-value-capture-box";
import { sealEventHookCapture } from "@qorpera/runtime/cloud-event-hook-capture-box";
import { CloudSecretKeyring } from "@qorpera/runtime/cloud-secret-crypto";
import { describe, expect, it } from "vitest";

function identity(companyId: string, keyId: string) {
	return { companyId, environmentId: randomUUID(), secretId: randomUUID(), version: 1, keyId };
}

it("derives each company's key from the master key, the same on every copy of the shared vault", async () => {
	const master = randomBytes(32);
	const nodeOne = new CloudSecretKeyring({}, { "vault-root-1": master });
	const nodeTwo = new CloudSecretKeyring({}, { "vault-root-1": Buffer.from(master) });
	const company = randomUUID();
	const sealedFor = identity(company, "vault-root-1");
	const envelope = nodeOne.seal({ codex_auth_json: "login" }, sealedFor);
	await expect(nodeTwo.use(envelope, sealedFor, async (fields) => fields.codex_auth_json)).resolves.toBe("login");
	expect(nodeOne.has("vault-root-1")).toBe(true);
	nodeOne.close();
	nodeTwo.close();
});

it("derives a company's key as HKDF-SHA256(master, salt qorpera.company-kek/v1, info company), fixed value", async () => {
	// Computed apart from this code (Python's hmac, RFC 5869 by hand).
	const master = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
	const company = "0F0E0D0C-0B0A-4908-8706-050403020100";
	const expected = Buffer.from("755b45a9b70ddefcd1a4fafc4e263014a631178d3df962ddc154bc171e15883b", "hex");
	const derived = new CloudSecretKeyring({}, { "vault-root-1": master });
	// A company keyring that holds exactly that key under the same id opens what the derived one seals.
	const own = new CloudSecretKeyring({ "vault-root-1": expected });
	const sealedFor = identity(company.toLowerCase(), "vault-root-1");
	const envelope = derived.seal({ codex_auth_json: "login" }, sealedFor);
	await expect(own.use(envelope, sealedFor, async (fields) => fields.codex_auth_json)).resolves.toBe("login");
	derived.close();
	own.close();
});

it("keeps companies apart: another company's derived key cannot open an envelope", async () => {
	const master = randomBytes(32);
	const keyring = new CloudSecretKeyring({}, { "vault-root-1": master });
	const sealedFor = identity(randomUUID(), "vault-root-1");
	const envelope = keyring.seal({ codex_auth_json: "login" }, sealedFor);
	// The envelope names its company, so opening it as another company is refused outright.
	await expect(
		keyring.use(envelope, { ...sealedFor, companyId: randomUUID() }, async (fields) => fields.codex_auth_json),
	).rejects.toThrow();
	// And a keyring whose master differs cannot open it even for the right company.
	const other = new CloudSecretKeyring({}, { "vault-root-1": randomBytes(32) });
	await expect(other.use(envelope, sealedFor, async (fields) => fields.codex_auth_json)).rejects.toThrow();
	keyring.close();
	other.close();
});

it("serves a company's own key and derived keys side by side, and refuses a key id held twice", async () => {
	const own = randomBytes(32);
	const keyring = new CloudSecretKeyring({ "company-kek-1": own }, { "vault-root-1": randomBytes(32) });
	const company = randomUUID();
	const ownIdentity = identity(company, "company-kek-1");
	const envelope = keyring.seal({ secret: "own" }, ownIdentity);
	await expect(
		new CloudSecretKeyring({ "company-kek-1": own }).use(envelope, ownIdentity, async (fields) => fields.secret),
	).resolves.toBe("own");
	expect(() => keyring.seal({ secret: "x" }, identity(company, "unknown-kek"))).toThrow(
		"Cloud secret wrapping key is unavailable",
	);
	expect(() => new CloudSecretKeyring({ same: randomBytes(32) }, { same: randomBytes(32) })).toThrow(
		"Cloud secret keyring is invalid",
	);
	expect(() => new CloudSecretKeyring({}, {})).toThrow("Cloud secret keyring is empty");
	expect(() => new CloudSecretKeyring({}, { short: randomBytes(16) })).toThrow("Cloud secret keyring is invalid");
	keyring.close();
});

describe("hook capture keys (E3c)", () => {
	const company = "0f0e0d0c-0b0a-4908-8706-050403020100";
	const hook = {
		companyId: company,
		environmentId: "3F0E0D0C-0B0A-4908-8706-050403020103",
		secretId: "2F0E0D0C-0B0A-4908-8706-050403020102",
		keyId: "vault-root-1",
	};
	const call = {
		companyId: company,
		companyComputerId: randomUUID(),
		computerGeneration: 2,
		receiptId: randomUUID(),
		hookId: randomUUID(),
		field: "signing_secret" as const,
	};

	it("derives a hook's key pair from the company's key, the same on every copy of the vault, fixed value", () => {
		// Computed apart from this code (Python: RFC 5869 and RFC 7748 by hand), from the company key above.
		const expected = "PH8MpQfEuGM3XxWI0DGXiGS3gDnXsC_MBrgZ5fq3siU";
		const master = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
		const derived = new CloudSecretKeyring({}, { "vault-root-1": master });
		const own = new CloudSecretKeyring({
			"vault-root-1": Buffer.from("755b45a9b70ddefcd1a4fafc4e263014a631178d3df962ddc154bc171e15883b", "hex"),
		});
		expect(derived.capturePublicKey(hook)).toBe(expected);
		expect(own.capturePublicKey(hook)).toBe(expected);
		// The salt is the lowercase ids.
		expect(
			derived.capturePublicKey({
				...hook,
				environmentId: hook.environmentId.toLowerCase(),
				secretId: hook.secretId.toLowerCase(),
			}),
		).toBe(expected);
		expect(expected).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
		derived.close();
		own.close();
	});

	it("keeps hooks, environments and companies apart, and needs the company's key", () => {
		const keyring = new CloudSecretKeyring({ "company-kek-1": randomBytes(32) }, { "vault-root-1": randomBytes(32) });
		const base = keyring.capturePublicKey(hook);
		for (const other of [
			{ ...hook, secretId: randomUUID() },
			{ ...hook, environmentId: randomUUID() },
			{ ...hook, companyId: randomUUID() },
			{ ...hook, keyId: "company-kek-1" },
		])
			expect(keyring.capturePublicKey(other)).not.toBe(base);
		expect(() => keyring.capturePublicKey({ ...hook, keyId: "unknown-kek" })).toThrow(
			"Cloud secret wrapping key is unavailable",
		);
		for (const bad of [
			{ ...hook, secretId: "x" },
			{ ...hook, keyId: " " },
		])
			expect(() => keyring.capturePublicKey(bad)).toThrow("Hook capture key identity is invalid");
		keyring.close();
	});

	it("opens a capture sealed to the hook's public key, on any copy of the vault, and nowhere else", async () => {
		const master = randomBytes(32);
		const nodeOne = new CloudSecretKeyring({}, { "vault-root-1": master });
		const nodeTwo = new CloudSecretKeyring({}, { "vault-root-1": Buffer.from(master) });
		const value = "whsec_Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56";
		const box = sealEventHookCapture({ value, site: "dashboard.stripe.com" }, nodeOne.capturePublicKey(hook), call);
		await expect(nodeTwo.openCapture(hook, box, call, async (got) => got.value.toString("utf8"))).resolves.toBe(
			value,
		);
		await expect(
			nodeTwo.openCapture({ ...hook, secretId: randomUUID() }, box, call, async () => "opened"),
		).rejects.toThrow("Hook capture box does not open here");
		const other = new CloudSecretKeyring({}, { "vault-root-1": randomBytes(32) });
		await expect(other.openCapture(hook, box, call, async () => "opened")).rejects.toThrow(
			"Hook capture box does not open here",
		);
		nodeOne.close();
		nodeTwo.close();
		other.close();
	});
});

describe("coding value capture keys (20260930695000)", () => {
	const company = "0f0e0d0c-0b0a-4908-8706-050403020100";
	const value = {
		companyId: company,
		environmentId: "3F0E0D0C-0B0A-4908-8706-050403020103",
		secretId: "2F0E0D0C-0B0A-4908-8706-050403020102",
		keyId: "vault-root-1",
	};
	const call = {
		companyId: company,
		companyComputerId: randomUUID(),
		computerGeneration: 2,
		receiptId: randomUUID(),
		service: "npm",
		variable: "npm_token",
	};
	const token = `npm_${"Ab12".repeat(9)}`;

	it("derives a value's key pair under its own info, never a hook's for the same id, fixed value", () => {
		// Computed apart from this code (Python: RFC 5869 and RFC 7748 by hand, the hook's value above checked the same
		// way), from the company key the hook test names.
		const expected = "_LQM-IjN76YuHC-0R6oSWwELym3Yc7EZzWvE9d7v5D0";
		const master = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
		const derived = new CloudSecretKeyring({}, { "vault-root-1": master });
		const own = new CloudSecretKeyring({
			"vault-root-1": Buffer.from("755b45a9b70ddefcd1a4fafc4e263014a631178d3df962ddc154bc171e15883b", "hex"),
		});
		expect(derived.codingValueCapturePublicKey(value)).toBe(expected);
		expect(own.codingValueCapturePublicKey(value)).toBe(expected);
		expect(derived.capturePublicKey(value)).not.toBe(expected);
		expect(() => derived.codingValueCapturePublicKey({ ...value, secretId: "x" })).toThrow(
			"Coding value capture key identity is invalid",
		);
		expect(() => derived.codingValueCapturePublicKey({ ...value, keyId: "unknown-kek" })).toThrow(
			"Cloud secret wrapping key is unavailable",
		);
		derived.close();
		own.close();
	});

	it("opens a value sealed to its public key, on any copy of the vault, and never as a hook's capture", async () => {
		const master = randomBytes(32);
		const nodeOne = new CloudSecretKeyring({}, { "vault-root-1": master });
		const nodeTwo = new CloudSecretKeyring({}, { "vault-root-1": Buffer.from(master) });
		const box = sealCodingValueCapture(
			{ value: token, site: "www.npmjs.com" },
			/^npm_[A-Za-z0-9]{36}$/u,
			nodeOne.codingValueCapturePublicKey(value),
			call,
		);
		await expect(
			nodeTwo.openCodingValueCapture(value, box, call, async (got) => got.value.toString("utf8")),
		).resolves.toBe(token);
		await expect(
			nodeTwo.openCodingValueCapture({ ...value, secretId: randomUUID() }, box, call, async () => "opened"),
		).rejects.toThrow("Coding value capture box does not open here");
		// A hook's key for the same secret, and a hook's opener, never open it.
		const hookCall = { ...call, hookId: randomUUID(), field: "signing_secret" as const };
		await expect(nodeTwo.openCapture(value, box, hookCall, async () => "opened")).rejects.toThrow(
			"Hook capture box is malformed",
		);
		await expect(
			nodeTwo.openCapture(value, { ...box, schema: "qorpera.event-hook-capture-box/v1" }, hookCall, async () => "x"),
		).rejects.toThrow("Hook capture box does not open here");
		nodeOne.close();
		nodeTwo.close();
	});
});
