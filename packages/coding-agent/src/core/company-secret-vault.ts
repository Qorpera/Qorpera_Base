import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type CompanySecret, validCompanySecret } from "./company-connections.ts";

const SECRET_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const COMPANY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;
const PORTABLE_BUNDLE_MAX_BYTES = 12 * 1024 * 1024;
const PORTABLE_BUNDLE_MAX_ENTRIES = 256;
const SCRYPT_COST = 32_768;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;

export const PORTABLE_COMPANY_CREDENTIALS_SCHEMA = "qorpera.credentials/v1" as const;

export interface CompanySecretProtector {
	id: string;
	protect(plaintext: string): Buffer;
	unprotect(ciphertext: Buffer): string;
}

interface ProtectedSecretRecord {
	protectorId: string;
	ciphertextBase64: string;
	updatedAt: string;
}

interface ProtectedSecretVaultState {
	version: 1;
	entries: Record<string, ProtectedSecretRecord>;
}

export interface ProtectedCompanySecretVault {
	list(): string[];
	get(name: string): CompanySecret | undefined;
	put(name: string, secret: CompanySecret): void;
	remove(name: string): boolean;
}

export interface PortableCompanyCredentialBundle {
	schema: typeof PORTABLE_COMPANY_CREDENTIALS_SCHEMA;
	companyId: string;
	createdAt: string;
	entryCount: number;
	keyDerivation: {
		name: "scrypt";
		saltBase64: string;
		cost: typeof SCRYPT_COST;
		blockSize: typeof SCRYPT_BLOCK_SIZE;
		parallelization: typeof SCRYPT_PARALLELIZATION;
	};
	encryption: {
		name: "aes-256-gcm";
		nonceBase64: string;
		authTagBase64: string;
		ciphertextBase64: string;
	};
}

export interface PortableCompanyCredentialImportOptions {
	overwrite?: boolean;
}

export interface PortableCompanyCredentialImportResult {
	imported: string[];
	overwritten: string[];
}

interface PortableCredentialPayload {
	version: 1;
	companyId: string;
	secrets: Record<string, CompanySecret>;
}

export function protectedCompanySecretVaultPath(vaultRoot: string, companyIdentity: string): string {
	const id = createHash("sha256").update(companyIdentity).digest("hex");
	return join(resolve(vaultRoot), `${id}.vault.json`);
}

function emptyState(): ProtectedSecretVaultState {
	return { version: 1, entries: {} };
}

function validCompanyId(companyId: string): boolean {
	return COMPANY_ID_PATTERN.test(companyId);
}

function validTimestamp(timestamp: unknown): timestamp is string {
	if (typeof timestamp !== "string") return false;
	const milliseconds = Date.parse(timestamp);
	return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === timestamp;
}

function assertPortablePassphrase(passphrase: string): void {
	const bytes = Buffer.byteLength(passphrase, "utf-8");
	if (bytes < 12 || bytes > 1_024 || CONTROL_CHARACTER_PATTERN.test(passphrase)) {
		throw new Error("Portable credential passphrase must be 12 to 1024 UTF-8 bytes without control characters");
	}
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function exactBase64(value: unknown, expectedBytes?: number): Buffer | undefined {
	if (typeof value !== "string" || !value) return undefined;
	const decoded = Buffer.from(value, "base64");
	if (decoded.toString("base64") !== value || (expectedBytes !== undefined && decoded.length !== expectedBytes)) {
		return undefined;
	}
	return decoded;
}

function portableBundleAdditionalData(
	bundle: Pick<PortableCompanyCredentialBundle, "companyId" | "createdAt">,
): Buffer {
	return Buffer.from(`${PORTABLE_COMPANY_CREDENTIALS_SCHEMA}\0${bundle.companyId}\0${bundle.createdAt}`, "utf-8");
}

function parsePortableBundle(serialized: string): {
	bundle: PortableCompanyCredentialBundle;
	salt: Buffer;
	nonce: Buffer;
	authTag: Buffer;
	ciphertext: Buffer;
} {
	if (!serialized || Buffer.byteLength(serialized, "utf-8") > PORTABLE_BUNDLE_MAX_BYTES) {
		throw new Error("Portable company credential bundle is invalid");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(serialized);
	} catch {
		throw new Error("Portable company credential bundle is invalid");
	}
	const bundle = recordValue(parsed);
	const keyDerivation = recordValue(bundle?.keyDerivation);
	const encryption = recordValue(bundle?.encryption);
	const salt = exactBase64(keyDerivation?.saltBase64, 16);
	const nonce = exactBase64(encryption?.nonceBase64, 12);
	const authTag = exactBase64(encryption?.authTagBase64, 16);
	const ciphertext = exactBase64(encryption?.ciphertextBase64);
	if (
		!bundle ||
		!keyDerivation ||
		!encryption ||
		!exactKeys(bundle, ["schema", "companyId", "createdAt", "entryCount", "keyDerivation", "encryption"]) ||
		!exactKeys(keyDerivation, ["name", "saltBase64", "cost", "blockSize", "parallelization"]) ||
		!exactKeys(encryption, ["name", "nonceBase64", "authTagBase64", "ciphertextBase64"]) ||
		bundle.schema !== PORTABLE_COMPANY_CREDENTIALS_SCHEMA ||
		typeof bundle.companyId !== "string" ||
		!validCompanyId(bundle.companyId) ||
		!validTimestamp(bundle.createdAt) ||
		typeof bundle.entryCount !== "number" ||
		!Number.isInteger(bundle.entryCount) ||
		bundle.entryCount < 1 ||
		bundle.entryCount > PORTABLE_BUNDLE_MAX_ENTRIES ||
		keyDerivation.name !== "scrypt" ||
		keyDerivation.cost !== SCRYPT_COST ||
		keyDerivation.blockSize !== SCRYPT_BLOCK_SIZE ||
		keyDerivation.parallelization !== SCRYPT_PARALLELIZATION ||
		encryption.name !== "aes-256-gcm" ||
		!salt ||
		!nonce ||
		!authTag ||
		!ciphertext ||
		ciphertext.length === 0
	) {
		throw new Error("Portable company credential bundle is invalid");
	}
	return {
		bundle: bundle as unknown as PortableCompanyCredentialBundle,
		salt,
		nonce,
		authTag,
		ciphertext,
	};
}

function parsePortablePayload(plaintext: string, companyId: string, entryCount: number): PortableCredentialPayload {
	let parsed: unknown;
	try {
		parsed = JSON.parse(plaintext);
	} catch {
		throw new Error("Portable company credentials could not be decrypted");
	}
	const payload = recordValue(parsed);
	const secrets = recordValue(payload?.secrets);
	if (
		!payload ||
		!secrets ||
		!exactKeys(payload, ["version", "companyId", "secrets"]) ||
		payload.version !== 1 ||
		payload.companyId !== companyId ||
		Object.keys(secrets).length !== entryCount
	) {
		throw new Error("Portable company credentials could not be decrypted");
	}
	for (const [name, secret] of Object.entries(secrets)) {
		if (!SECRET_NAME_PATTERN.test(name) || !recordValue(secret) || !validCompanySecret(secret as CompanySecret)) {
			throw new Error("Portable company credentials could not be decrypted");
		}
	}
	return payload as unknown as PortableCredentialPayload;
}

function readState(path: string): ProtectedSecretVaultState {
	if (!existsSync(path)) return emptyState();
	const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<ProtectedSecretVaultState>;
	if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object" || Array.isArray(parsed.entries)) {
		throw new Error(`Protected company secret vault is invalid: ${path}`);
	}
	for (const [name, entry] of Object.entries(parsed.entries)) {
		if (
			!SECRET_NAME_PATTERN.test(name) ||
			!entry ||
			typeof entry !== "object" ||
			typeof entry.protectorId !== "string" ||
			!entry.protectorId ||
			typeof entry.ciphertextBase64 !== "string" ||
			!entry.ciphertextBase64 ||
			typeof entry.updatedAt !== "string" ||
			!Number.isFinite(Date.parse(entry.updatedAt))
		) {
			throw new Error(`Protected company secret vault is invalid: ${path}`);
		}
	}
	return parsed as ProtectedSecretVaultState;
}

function writeState(path: string, state: ProtectedSecretVaultState): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(state, null, "\t")}\n`, FILE_WRITE_OPTIONS);
	try {
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

export function createProtectedCompanySecretVault(
	path: string,
	protector: CompanySecretProtector,
): ProtectedCompanySecretVault {
	if (!protector.id.trim()) throw new Error("Company secret protector id is required");
	const normalizedPath = resolve(path);
	return {
		list: () => Object.keys(readState(normalizedPath).entries).sort(),
		get: (name) => {
			if (!SECRET_NAME_PATTERN.test(name)) throw new Error(`Invalid secret name: ${name}`);
			const record = readState(normalizedPath).entries[name];
			if (!record) return undefined;
			if (record.protectorId !== protector.id) {
				throw new Error(`Company secret requires unavailable protector: ${record.protectorId}`);
			}
			const plaintext = protector.unprotect(Buffer.from(record.ciphertextBase64, "base64"));
			const secret = JSON.parse(plaintext) as CompanySecret;
			if (!validCompanySecret(secret)) throw new Error(`Protected company secret is invalid: ${name}`);
			return secret;
		},
		put: (name, secret) => {
			if (!SECRET_NAME_PATTERN.test(name)) throw new Error(`Invalid secret name: ${name}`);
			if (!validCompanySecret(secret)) throw new Error(`Invalid ${secret.kind} secret for ${name}`);
			const state = readState(normalizedPath);
			state.entries[name] = {
				protectorId: protector.id,
				ciphertextBase64: protector.protect(JSON.stringify(secret)).toString("base64"),
				updatedAt: new Date().toISOString(),
			};
			writeState(normalizedPath, state);
		},
		remove: (name) => {
			if (!SECRET_NAME_PATTERN.test(name)) throw new Error(`Invalid secret name: ${name}`);
			const state = readState(normalizedPath);
			if (!(name in state.entries)) return false;
			delete state.entries[name];
			writeState(normalizedPath, state);
			return true;
		},
	};
}

/** Rewrap one logical company's credentials for an explicit transfer to a
 * different OS protector. The serialized bundle contains no plaintext secret
 * names or values and is bound to the durable company id. */
export function exportPortableCompanyCredentials(
	vault: ProtectedCompanySecretVault,
	companyId: string,
	passphrase: string,
	now = new Date(),
): string {
	if (!validCompanyId(companyId)) throw new Error("Portable credential company identity is invalid");
	assertPortablePassphrase(passphrase);
	const names = vault.list();
	if (names.length === 0) throw new Error("The company has no credentials to export");
	if (names.length > PORTABLE_BUNDLE_MAX_ENTRIES || new Set(names).size !== names.length) {
		throw new Error("The company credential vault cannot be exported");
	}
	const secrets: Record<string, CompanySecret> = {};
	for (const name of names) {
		if (!SECRET_NAME_PATTERN.test(name)) throw new Error("The company credential vault cannot be exported");
		const secret = vault.get(name);
		if (!secret) throw new Error(`Company credential disappeared during export: ${name}`);
		secrets[name] = secret;
	}
	const createdAt = now.toISOString();
	const salt = randomBytes(16);
	const nonce = randomBytes(12);
	const key = scryptSync(passphrase, salt, 32, {
		N: SCRYPT_COST,
		r: SCRYPT_BLOCK_SIZE,
		p: SCRYPT_PARALLELIZATION,
		maxmem: SCRYPT_MAX_MEMORY,
	});
	try {
		const cipher = createCipheriv("aes-256-gcm", key, nonce);
		cipher.setAAD(portableBundleAdditionalData({ companyId, createdAt }));
		const plaintext = JSON.stringify({ version: 1, companyId, secrets } satisfies PortableCredentialPayload);
		const ciphertext = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
		const bundle: PortableCompanyCredentialBundle = {
			schema: PORTABLE_COMPANY_CREDENTIALS_SCHEMA,
			companyId,
			createdAt,
			entryCount: names.length,
			keyDerivation: {
				name: "scrypt",
				saltBase64: salt.toString("base64"),
				cost: SCRYPT_COST,
				blockSize: SCRYPT_BLOCK_SIZE,
				parallelization: SCRYPT_PARALLELIZATION,
			},
			encryption: {
				name: "aes-256-gcm",
				nonceBase64: nonce.toString("base64"),
				authTagBase64: cipher.getAuthTag().toString("base64"),
				ciphertextBase64: ciphertext.toString("base64"),
			},
		};
		return `${JSON.stringify(bundle, null, "\t")}\n`;
	} finally {
		key.fill(0);
	}
}

/** Import an explicit credential transfer into the destination OS vault.
 * Forks and unrelated companies fail before decryption because their durable
 * company id differs. Existing names require an explicit overwrite choice. */
export function importPortableCompanyCredentials(
	vault: ProtectedCompanySecretVault,
	companyId: string,
	serialized: string,
	passphrase: string,
	options: PortableCompanyCredentialImportOptions = {},
): PortableCompanyCredentialImportResult {
	if (!validCompanyId(companyId)) throw new Error("Portable credential company identity is invalid");
	assertPortablePassphrase(passphrase);
	const parsed = parsePortableBundle(serialized);
	if (parsed.bundle.companyId !== companyId) {
		throw new Error("Portable credential bundle belongs to a different company");
	}
	const key = scryptSync(passphrase, parsed.salt, 32, {
		N: SCRYPT_COST,
		r: SCRYPT_BLOCK_SIZE,
		p: SCRYPT_PARALLELIZATION,
		maxmem: SCRYPT_MAX_MEMORY,
	});
	let plaintext: string;
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, parsed.nonce);
		decipher.setAAD(portableBundleAdditionalData(parsed.bundle));
		decipher.setAuthTag(parsed.authTag);
		plaintext = Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]).toString("utf-8");
	} catch {
		throw new Error("Portable company credentials could not be decrypted");
	} finally {
		key.fill(0);
	}
	const payload = parsePortablePayload(plaintext, companyId, parsed.bundle.entryCount);
	const names = Object.keys(payload.secrets).sort();
	const existing = new Set(vault.list());
	const overwritten = names.filter((name) => existing.has(name));
	if (overwritten.length > 0 && !options.overwrite) {
		throw new Error(`Portable credential import would overwrite: ${overwritten.join(", ")}`);
	}
	const previous = new Map(names.map((name) => [name, vault.get(name)]));
	const applied: string[] = [];
	try {
		for (const name of names) {
			vault.put(name, payload.secrets[name]!);
			applied.push(name);
		}
	} catch (error) {
		for (const name of applied.reverse()) {
			const secret = previous.get(name);
			if (secret) vault.put(name, secret);
			else vault.remove(name);
		}
		throw error;
	}
	return { imported: names, overwritten };
}
