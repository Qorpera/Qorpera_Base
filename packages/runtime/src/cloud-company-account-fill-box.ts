import {
	createCipheriv,
	createDecipheriv,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	hkdfSync,
	type KeyObject,
	randomBytes,
} from "node:crypto";
import { isUuid } from "@qorpera/contracts";

/* A company account's value on its way into one Company Computer (A1-3,
 * deploy/first-node/RUNTIME-COMPANY-ACCOUNTS.md). The office service makes an X25519 key pair in memory
 * when it starts and reports the public half with its boot. The vault seals the value to that key; the
 * native host only carries the sealed box to the office in the computer action it already sends. So the
 * value exists in the clear only in the vault and inside that office service, never on the host, in a
 * receipt or in a transcript.
 *
 * The box is bound to the computer, its boot generation and the one tool call (effect receipt): the
 * office opens it only for the action it is performing. The hosts the value may be typed into travel
 * inside the sealed payload, so no one on the way can widen them. */

const BOX_SCHEMA = "qorpera.company-account-fill-box/v1";
const PAYLOAD_SCHEMA = "qorpera.company-account-fill/v1";
const INFO = Buffer.from("qorpera.company-account-fill/v1", "utf8");
const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** The X25519 SubjectPublicKeyInfo prefix (RFC 8410), for a raw 32-byte key. */
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");
const MAX_VALUE = 256;
/** A sealed value is typed within this long or never: an authenticator code lives 30 s. */
export const COMPANY_ACCOUNT_FILL_LIFETIME_MS = 90_000;

export type CompanyAccountFillField = "login" | "password" | "new_password" | "code";
const FIELDS: readonly CompanyAccountFillField[] = ["login", "password", "new_password", "code"];

/** Who may open the box: one computer's boot, for one tool call. */
export interface CompanyAccountFillIdentity {
	readonly companyId: string;
	readonly companyComputerId: string;
	readonly computerGeneration: number;
	readonly receiptId: string;
	readonly accountId: string;
	readonly field: CompanyAccountFillField;
}

export interface CompanyAccountFill {
	readonly field: CompanyAccountFillField;
	readonly value: string;
	/** The account's site first, then its sign-in hosts: the only pages the value may be typed into. */
	readonly hosts: readonly string[];
	readonly notAfterMs: number;
}

function base64(value: Uint8Array): string {
	return Buffer.from(value).toString("base64url");
}

function decoded(value: unknown, length: number | readonly [number, number], label: string): Buffer {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${label} is malformed`);
	const out = Buffer.from(value, "base64url");
	const fits = Array.isArray(length)
		? out.byteLength >= length[0] && out.byteLength <= length[1]
		: out.byteLength === length;
	if (!fits || base64(out) !== value) throw new Error(`${label} is malformed`);
	return out;
}

function identity(value: CompanyAccountFillIdentity): CompanyAccountFillIdentity {
	if (
		!isUuid(value.companyId) ||
		!isUuid(value.companyComputerId) ||
		!isUuid(value.receiptId) ||
		!isUuid(value.accountId) ||
		!Number.isSafeInteger(value.computerGeneration) ||
		value.computerGeneration < 1 ||
		!FIELDS.includes(value.field)
	)
		throw new Error("Company account fill identity is malformed");
	return {
		companyId: value.companyId,
		companyComputerId: value.companyComputerId,
		computerGeneration: value.computerGeneration,
		receiptId: value.receiptId,
		accountId: value.accountId,
		field: value.field,
	};
}

function associatedData(value: CompanyAccountFillIdentity): Buffer {
	return Buffer.from(JSON.stringify({ schema: BOX_SCHEMA, ...identity(value) }), "utf8");
}

function hosts(value: unknown): string[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 5)
		throw new Error("Company account fill hosts are malformed");
	const out = value.map((host) => {
		if (typeof host !== "string" || host.length > 253 || !HOST.test(host))
			throw new Error("Company account fill hosts are malformed");
		return host;
	});
	if (new Set(out).size !== out.length) throw new Error("Company account fill hosts are malformed");
	return out;
}

/** An X25519 public key as the office reports it: 32 raw bytes, base64url. */
export function parseCompanyComputerFillPublicKey(value: unknown): KeyObject {
	const raw = decoded(value, 32, "Company Computer fill key");
	return createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: "der", type: "spki" });
}

/** The office's key pair for one service start; the private half never leaves its memory. */
export class CompanyComputerFillKey {
	readonly publicKey: string;
	readonly #privateKey: KeyObject;

	constructor() {
		const pair = generateKeyPairSync("x25519");
		this.#privateKey = pair.privateKey;
		const spki = pair.publicKey.export({ format: "der", type: "spki" });
		this.publicKey = base64(spki.subarray(SPKI_X25519.byteLength));
	}

	/** The fill inside a box sealed to this key for exactly this identity, or an error. */
	open(box: unknown, expected: CompanyAccountFillIdentity, nowMs = Date.now()): CompanyAccountFill {
		if (
			!box ||
			typeof box !== "object" ||
			Array.isArray(box) ||
			Object.keys(box).sort().join() !== "ciphertext,ephemeralPublicKey,iv,schema,tag"
		)
			throw new Error("Company account fill box is malformed");
		const input = box as Record<string, unknown>;
		if (input.schema !== BOX_SCHEMA) throw new Error("Company account fill box is malformed");
		const ephemeral = decoded(input.ephemeralPublicKey, 32, "Company account fill box");
		const iv = decoded(input.iv, 12, "Company account fill box");
		const tag = decoded(input.tag, 16, "Company account fill box");
		const ciphertext = decoded(input.ciphertext, [1, 4096], "Company account fill box");
		const key = boxKey(
			this.#privateKey,
			createPublicKey({ key: Buffer.concat([SPKI_X25519, ephemeral]), format: "der", type: "spki" }),
			ephemeral,
			Buffer.from(this.publicKey, "base64url"),
		);
		let plaintext: Buffer | undefined;
		try {
			const decipher = createDecipheriv("aes-256-gcm", key, iv);
			decipher.setAAD(associatedData(expected));
			decipher.setAuthTag(tag);
			plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
		} catch {
			throw new Error("Company account fill box does not open here");
		} finally {
			key.fill(0);
		}
		try {
			const payload = JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>;
			if (
				!payload ||
				typeof payload !== "object" ||
				Object.keys(payload).sort().join() !== "field,hosts,notAfterMs,schema,value" ||
				payload.schema !== PAYLOAD_SCHEMA ||
				payload.field !== expected.field ||
				typeof payload.value !== "string" ||
				payload.value.length < 1 ||
				payload.value.length > MAX_VALUE ||
				/[\0-\x1f\x7f]/.test(payload.value) ||
				!Number.isSafeInteger(payload.notAfterMs)
			)
				throw new Error("Company account fill is malformed");
			if ((payload.notAfterMs as number) < nowMs) throw new Error("Company account fill expired");
			return {
				field: expected.field,
				value: payload.value,
				hosts: hosts(payload.hosts),
				notAfterMs: payload.notAfterMs as number,
			};
		} catch (error) {
			if (error instanceof Error && error.message === "Company account fill expired") throw error;
			throw new Error("Company account fill is malformed");
		} finally {
			plaintext.fill(0);
		}
	}
}

function boxKey(privateKey: KeyObject, publicKey: KeyObject, ephemeral: Buffer, recipient: Buffer): Buffer {
	// X25519 refuses a low-order peer key (an all-zero secret) with an error.
	const shared = diffieHellman({ privateKey, publicKey });
	try {
		return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([ephemeral, recipient]), INFO, 32));
	} finally {
		shared.fill(0);
	}
}

/** The vault's side: the value sealed to one computer's boot key for one tool call. */
export function sealCompanyAccountFill(
	fill: { readonly value: string; readonly hosts: readonly string[] },
	recipientPublicKey: string,
	expected: CompanyAccountFillIdentity,
	nowMs = Date.now(),
): Record<string, string> {
	const checked = identity(expected);
	if (
		typeof fill.value !== "string" ||
		fill.value.length < 1 ||
		fill.value.length > MAX_VALUE ||
		/[\0-\x1f\x7f]/.test(fill.value)
	)
		throw new Error("Company account fill value is malformed");
	const recipient = parseCompanyComputerFillPublicKey(recipientPublicKey);
	const pair = generateKeyPairSync("x25519");
	const ephemeral = pair.publicKey.export({ format: "der", type: "spki" }).subarray(SPKI_X25519.byteLength);
	const key = boxKey(pair.privateKey, recipient, Buffer.from(ephemeral), Buffer.from(recipientPublicKey, "base64url"));
	const iv = randomBytes(12);
	const plaintext = Buffer.from(
		JSON.stringify({
			schema: PAYLOAD_SCHEMA,
			field: checked.field,
			value: fill.value,
			hosts: hosts([...fill.hosts]),
			notAfterMs: nowMs + COMPANY_ACCOUNT_FILL_LIFETIME_MS,
		}),
		"utf8",
	);
	try {
		const cipher = createCipheriv("aes-256-gcm", key, iv);
		cipher.setAAD(associatedData(checked));
		const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
		return {
			schema: BOX_SCHEMA,
			ephemeralPublicKey: base64(ephemeral),
			iv: base64(iv),
			tag: base64(cipher.getAuthTag()),
			ciphertext: base64(ciphertext),
		};
	} finally {
		key.fill(0);
		plaintext.fill(0);
	}
}
