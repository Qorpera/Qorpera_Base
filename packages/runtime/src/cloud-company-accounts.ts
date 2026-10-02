import { createHmac, randomBytes } from "node:crypto";

/* Company website accounts (A1, deploy/first-node/RUNTIME-COMPANY-ACCOUNTS.md): what the vault keeps for
 * one account, and the values only the vault makes. A password is drawn here and leaves the vault only
 * into a page box on the company's computer; an authenticator code is made here from the seed the vault
 * keeps, which no agent sees. */

/** The sealed fields of an account's envelope (cloud-secret-crypto field names). */
const FIELD_PASSWORD = "password";
const FIELD_PASSWORD_PREVIOUS = "password_previous";
const FIELD_TOTP = "totp";
const FIELD_RECOVERY_CODES = "recovery_codes";

export type CompanyAccountTotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

/** An authenticator (RFC 6238) as the website set it up: the seed in canonical base32. */
export interface CompanyAccountTotp {
	readonly seed: string;
	readonly digits: 6 | 7 | 8;
	readonly period: number;
	readonly algorithm: CompanyAccountTotpAlgorithm;
}

export interface CompanyAccountRecoveryCode {
	readonly code: string;
	readonly used: boolean;
}

/** One version of an account's secrets. */
export interface CompanyAccountSecret {
	readonly password: string;
	/** The password before a change, kept until the website accepted the new one. */
	readonly passwordPrevious?: string;
	readonly totp?: CompanyAccountTotp;
	readonly recoveryCodes?: readonly CompanyAccountRecoveryCode[];
}

const MAX_PASSWORD = 256;
const MAX_RECOVERY_CODES = 32;
const RECOVERY_CODE = /^[A-Za-z0-9][A-Za-z0-9-]{3,63}$/;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** RFC 4226 asks for at least 128 bits and many websites give 80; never fewer, never absurdly many. */
const MIN_SEED_BYTES = 10;
const MAX_SEED_BYTES = 64;

function text(value: unknown, label: string, max: number): string {
	if (typeof value !== "string" || value.length === 0 || value.length > max || /[\0-\x1f\x7f]/.test(value))
		throw new Error(`Company account ${label} is malformed`);
	return value;
}

/** RFC 4648 base32, letter case and spaces, hyphens and padding ignored (as authenticator apps accept it). */
export function decodeCompanyAccountBase32(value: string): Uint8Array {
	const clean = value.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
	if (clean.length === 0 || clean.length > 128 || ![...clean].every((c) => BASE32.includes(c)))
		throw new Error("Company account authenticator seed is malformed");
	const bytes: number[] = [];
	let buffer = 0;
	let bits = 0;
	for (const c of clean) {
		buffer = (buffer << 5) | BASE32.indexOf(c);
		bits += 5;
		if (bits >= 8) {
			bytes.push((buffer >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	// Leftover bits must be zero padding, as an encoder writes them.
	if ((buffer & ((1 << bits) - 1)) !== 0) throw new Error("Company account authenticator seed is malformed");
	return Uint8Array.from(bytes);
}

function totp(value: unknown): CompanyAccountTotp {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Company account authenticator is malformed");
	const input = value as Record<string, unknown>;
	const keys = Object.keys(input).sort().join(",");
	if (keys !== "algorithm,digits,period,seed") throw new Error("Company account authenticator is malformed");
	const seed = text(input.seed, "authenticator seed", 128);
	const length = decodeCompanyAccountBase32(seed).byteLength;
	if (seed !== seed.replace(/[\s=-]/g, "").toUpperCase() || length < MIN_SEED_BYTES || length > MAX_SEED_BYTES)
		throw new Error("Company account authenticator seed is malformed");
	if (input.digits !== 6 && input.digits !== 7 && input.digits !== 8)
		throw new Error("Company account authenticator digits are malformed");
	if (!Number.isInteger(input.period) || (input.period as number) < 15 || (input.period as number) > 120)
		throw new Error("Company account authenticator period is malformed");
	if (input.algorithm !== "SHA1" && input.algorithm !== "SHA256" && input.algorithm !== "SHA512")
		throw new Error("Company account authenticator algorithm is malformed");
	return { seed, digits: input.digits, period: input.period as number, algorithm: input.algorithm };
}

function recoveryCodes(value: unknown): CompanyAccountRecoveryCode[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RECOVERY_CODES)
		throw new Error("Company account recovery codes are malformed");
	const seen = new Set<string>();
	return value.map((item) => {
		if (
			!item ||
			typeof item !== "object" ||
			Array.isArray(item) ||
			Object.keys(item).sort().join(",") !== "code,used"
		)
			throw new Error("Company account recovery codes are malformed");
		const { code, used } = item as Record<string, unknown>;
		if (typeof code !== "string" || !RECOVERY_CODE.test(code) || typeof used !== "boolean" || seen.has(code))
			throw new Error("Company account recovery codes are malformed");
		seen.add(code);
		return { code, used };
	});
}

/** An account's secrets as the envelope's fields. */
export function companyAccountFields(secret: CompanyAccountSecret): Record<string, string> {
	const fields: Record<string, string> = { [FIELD_PASSWORD]: text(secret.password, "password", MAX_PASSWORD) };
	if (secret.passwordPrevious !== undefined)
		fields[FIELD_PASSWORD_PREVIOUS] = text(secret.passwordPrevious, "previous password", MAX_PASSWORD);
	if (secret.totp !== undefined) fields[FIELD_TOTP] = JSON.stringify(totp(secret.totp));
	if (secret.recoveryCodes !== undefined)
		fields[FIELD_RECOVERY_CODES] = JSON.stringify(recoveryCodes(secret.recoveryCodes));
	return fields;
}

/** An envelope's fields as an account's secrets; anything else is refused. */
export function parseCompanyAccountFields(fields: Readonly<Record<string, string>>): CompanyAccountSecret {
	const known = new Set([FIELD_PASSWORD, FIELD_PASSWORD_PREVIOUS, FIELD_TOTP, FIELD_RECOVERY_CODES]);
	if (Object.keys(fields).some((name) => !known.has(name))) throw new Error("Company account envelope is malformed");
	const json = (name: string): unknown => {
		try {
			return JSON.parse(fields[name]!);
		} catch {
			throw new Error("Company account envelope is malformed");
		}
	};
	return {
		password: text(fields[FIELD_PASSWORD], "password", MAX_PASSWORD),
		...(fields[FIELD_PASSWORD_PREVIOUS] === undefined
			? {}
			: { passwordPrevious: text(fields[FIELD_PASSWORD_PREVIOUS], "previous password", MAX_PASSWORD) }),
		...(fields[FIELD_TOTP] === undefined ? {} : { totp: totp(json(FIELD_TOTP)) }),
		...(fields[FIELD_RECOVERY_CODES] === undefined
			? {}
			: { recoveryCodes: recoveryCodes(json(FIELD_RECOVERY_CODES)) }),
	};
}

export interface CompanyAccountPasswordPolicy {
	/** 12 to 64 characters; 24 by default. */
	readonly length?: number;
	/** Whether the website takes symbols; true by default. */
	readonly symbols?: boolean;
}

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
/** Symbols nearly every website accepts; no quotes, backslash, spaces or characters forms treat specially. */
const SYMBOLS = "-_.!@#%+=";

/** A uniform index below `size` from the random source (rejection sampling, no modulo bias). */
function index(size: number, random: (bytes: number) => Uint8Array): number {
	const limit = 256 - (256 % size);
	for (;;) {
		const [byte] = random(1);
		if (byte !== undefined && byte < limit) return byte % size;
	}
}

/**
 * A new password: at least one lower case letter, upper case letter and digit (and symbol when the
 * website takes them), the rest drawn from all of them, in a random order.
 */
export function generateCompanyAccountPassword(
	policy: CompanyAccountPasswordPolicy = {},
	random: (bytes: number) => Uint8Array = (bytes) => randomBytes(bytes),
): string {
	const length = policy.length ?? 24;
	if (!Number.isInteger(length) || length < 12 || length > 64)
		throw new Error("Company account password length is malformed");
	const classes = policy.symbols === false ? [LOWER, UPPER, DIGITS] : [LOWER, UPPER, DIGITS, SYMBOLS];
	const all = classes.join("");
	const characters = classes.map((set) => set[index(set.length, random)]!);
	while (characters.length < length) characters.push(all[index(all.length, random)]!);
	for (let i = characters.length - 1; i > 0; i--) {
		const j = index(i + 1, random);
		[characters[i], characters[j]] = [characters[j]!, characters[i]!];
	}
	return characters.join("");
}

/** The authenticator's code at `atMs` (RFC 6238 over RFC 4226). */
export function companyAccountTotpCode(value: CompanyAccountTotp, atMs: number): string {
	const checked = totp(value);
	if (!Number.isSafeInteger(atMs) || atMs < 0) throw new Error("Company account authenticator time is malformed");
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 1000 / checked.period)));
	const key = decodeCompanyAccountBase32(checked.seed);
	try {
		const mac = createHmac(checked.algorithm.toLowerCase(), key).update(counter).digest();
		const offset = mac[mac.length - 1]! & 0x0f;
		const binary = mac.readUInt32BE(offset) & 0x7fffffff;
		return String(binary % 10 ** checked.digits).padStart(checked.digits, "0");
	} finally {
		key.fill(0);
	}
}

/** An authenticator from the `otpauth://totp/...` link a website's setup QR code carries. */
export function parseCompanyAccountOtpauth(uri: string): CompanyAccountTotp {
	let url: URL;
	try {
		url = new URL(text(uri, "authenticator link", 2048));
	} catch {
		throw new Error("Company account authenticator link is malformed");
	}
	if (url.protocol !== "otpauth:" || url.hostname.toLowerCase() !== "totp")
		throw new Error("Company account authenticator link is not a time-based code");
	const secret = url.searchParams.get("secret");
	if (secret === null) throw new Error("Company account authenticator link has no seed");
	const algorithm = (url.searchParams.get("algorithm") ?? "SHA1").toUpperCase();
	const digits = Number(url.searchParams.get("digits") ?? "6");
	const period = Number(url.searchParams.get("period") ?? "30");
	return totp({ seed: secret.replace(/[\s=-]/g, "").toUpperCase(), digits, period, algorithm });
}

/** Recovery codes as a website shows or downloads them: one per line (or comma), numbering and spaces dropped. */
export function parseCompanyAccountRecoveryCodes(value: string): CompanyAccountRecoveryCode[] {
	if (typeof value !== "string" || value.length > 16 * 1024 || /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))
		throw new Error("Company account recovery codes are malformed");
	const codes = value
		.split(/[\r\n,]+/)
		.map((line) => line.replace(/^\s*\d{1,2}[.)]\s+/, "").replace(/\s+/g, ""))
		.filter((line) => line.length > 0);
	return recoveryCodes([...new Set(codes)].map((code) => ({ code, used: false })));
}
