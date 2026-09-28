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
