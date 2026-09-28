import { randomBytes, randomUUID } from "node:crypto";
import { CloudSecretKeyring } from "@qorpera/runtime/cloud-secret-crypto";
import { expect, it } from "vitest";

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
