import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CompanySecretProtector,
	createProtectedCompanySecretVault,
	exportPortableCompanyCredentials,
	importPortableCompanyCredentials,
	protectedCompanySecretVaultPath,
} from "../src/core/company-secret-vault.ts";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const TRANSFER_PASSPHRASE = "correct horse battery staple";

function createTestProtector(id: string): CompanySecretProtector {
	const key = randomBytes(32);
	return {
		id,
		protect: (plaintext) => {
			const nonce = randomBytes(12);
			const cipher = createCipheriv("aes-256-gcm", key, nonce);
			const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
			return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
		},
		unprotect: (ciphertext) => {
			const decipher = createDecipheriv("aes-256-gcm", key, ciphertext.subarray(0, 12));
			decipher.setAuthTag(ciphertext.subarray(12, 28));
			return Buffer.concat([decipher.update(ciphertext.subarray(28)), decipher.final()]).toString("utf-8");
		},
	};
}

describe("protected company secret vault", () => {
	let root: string;
	let protector: CompanySecretProtector;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "qorpera-company-secret-vault-"));
		protector = createTestProtector("test-aes-256-gcm-v1");
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("stores OAuth grants as protected ciphertext outside portable company content", () => {
		const path = protectedCompanySecretVaultPath(root, "local:11111111-1111-4111-8111-111111111111");
		const vault = createProtectedCompanySecretVault(path, protector);
		vault.put("google_sheets_oauth", {
			kind: "oauth2",
			accessToken: "google-access",
			refreshToken: "google-refresh",
			tokenUrl: "https://oauth2.googleapis.com/token",
			clientId: "qorpera-desktop-client",
		});

		expect(vault.list()).toEqual(["google_sheets_oauth"]);
		expect(vault.get("google_sheets_oauth")).toMatchObject({
			kind: "oauth2",
			accessToken: "google-access",
			refreshToken: "google-refresh",
		});
		const stored = readFileSync(path, "utf-8");
		expect(stored).toContain("test-aes-256-gcm-v1");
		expect(stored).not.toContain("google-access");
		expect(stored).not.toContain("google-refresh");
	});

	it("fails closed when the required protector is unavailable", () => {
		const path = protectedCompanySecretVaultPath(root, "cloud:11111111-1111-4111-8111-111111111111");
		createProtectedCompanySecretVault(path, protector).put("ledger", { kind: "static", value: "sensitive" });
		const wrongProtector = { ...protector, id: "different-protector" };
		expect(() => createProtectedCompanySecretVault(path, wrongProtector).get("ledger")).toThrow(
			/unavailable protector/,
		);
	});

	it("rewraps an explicit transfer under a different destination protector", () => {
		const sourcePath = protectedCompanySecretVaultPath(root, `local:${COMPANY_ID}`);
		const destinationPath = protectedCompanySecretVaultPath(root, `destination:${COMPANY_ID}`);
		const source = createProtectedCompanySecretVault(sourcePath, protector);
		source.put("google_sheets", {
			kind: "oauth2",
			accessToken: "portable-access-token",
			refreshToken: "portable-refresh-token",
			tokenUrl: "https://oauth2.googleapis.com/token",
			clientId: "desktop-client",
		});
		source.put("ledger_api", { kind: "static", value: "portable-api-key" });

		const bundle = exportPortableCompanyCredentials(source, COMPANY_ID, TRANSFER_PASSPHRASE);
		expect(bundle).not.toContain("google_sheets");
		expect(bundle).not.toContain("portable-access-token");
		expect(bundle).not.toContain("portable-api-key");

		const destination = createProtectedCompanySecretVault(
			destinationPath,
			createTestProtector("destination-os-protector-v1"),
		);
		expect(importPortableCompanyCredentials(destination, COMPANY_ID, bundle, TRANSFER_PASSPHRASE)).toEqual({
			imported: ["google_sheets", "ledger_api"],
			overwritten: [],
		});
		expect(destination.get("google_sheets")).toMatchObject({
			kind: "oauth2",
			refreshToken: "portable-refresh-token",
		});
		expect(readFileSync(destinationPath, "utf-8")).toContain("destination-os-protector-v1");
		expect(readFileSync(destinationPath, "utf-8")).not.toContain("portable-refresh-token");
	});

	it("rejects the wrong passphrase, tampering, and a different company identity", () => {
		const source = createProtectedCompanySecretVault(
			protectedCompanySecretVaultPath(root, `source:${COMPANY_ID}`),
			protector,
		);
		source.put("ledger", { kind: "static", value: "sensitive" });
		const bundle = exportPortableCompanyCredentials(source, COMPANY_ID, TRANSFER_PASSPHRASE);
		const destination = createProtectedCompanySecretVault(
			protectedCompanySecretVaultPath(root, `destination:${COMPANY_ID}`),
			createTestProtector("destination-v1"),
		);

		expect(() =>
			importPortableCompanyCredentials(destination, COMPANY_ID, bundle, "this passphrase is wrong"),
		).toThrow("could not be decrypted");
		expect(() =>
			importPortableCompanyCredentials(destination, OTHER_COMPANY_ID, bundle, TRANSFER_PASSPHRASE),
		).toThrow("different company");
		const tampered = JSON.parse(bundle) as { encryption: { ciphertextBase64: string } };
		tampered.encryption.ciphertextBase64 = `${tampered.encryption.ciphertextBase64.slice(0, -4)}AAAA`;
		expect(() =>
			importPortableCompanyCredentials(destination, COMPANY_ID, JSON.stringify(tampered), TRANSFER_PASSPHRASE),
		).toThrow("could not be decrypted");
		expect(destination.list()).toEqual([]);
	});

	it("requires an explicit overwrite when the destination already has a named credential", () => {
		const source = createProtectedCompanySecretVault(
			protectedCompanySecretVaultPath(root, `source:${COMPANY_ID}`),
			protector,
		);
		source.put("ledger", { kind: "static", value: "source-value" });
		const bundle = exportPortableCompanyCredentials(source, COMPANY_ID, TRANSFER_PASSPHRASE);
		const destination = createProtectedCompanySecretVault(
			protectedCompanySecretVaultPath(root, `destination:${COMPANY_ID}`),
			createTestProtector("destination-v1"),
		);
		destination.put("ledger", { kind: "static", value: "destination-value" });

		expect(() => importPortableCompanyCredentials(destination, COMPANY_ID, bundle, TRANSFER_PASSPHRASE)).toThrow(
			"would overwrite: ledger",
		);
		expect(destination.get("ledger")).toEqual({ kind: "static", value: "destination-value" });
		expect(
			importPortableCompanyCredentials(destination, COMPANY_ID, bundle, TRANSFER_PASSPHRASE, {
				overwrite: true,
			}),
		).toEqual({ imported: ["ledger"], overwritten: ["ledger"] });
		expect(destination.get("ledger")).toEqual({ kind: "static", value: "source-value" });
	});
});
