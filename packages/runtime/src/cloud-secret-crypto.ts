import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createPrivateKey,
	createPublicKey,
	hkdfSync,
	type KeyObject,
	randomBytes,
} from "node:crypto";
import {
	type CodingValueCapture,
	type CodingValueCaptureIdentity,
	openCodingValueCapture,
} from "./cloud-coding-value-capture-box.ts";
import {
	type EventHookCapture,
	type EventHookCaptureIdentity,
	openEventHookCapture,
} from "./cloud-event-hook-capture-box.ts";

const ENVELOPE_SCHEMA = "qorpera.cloud-secret-envelope/v1";
const PAYLOAD_SCHEMA = "qorpera.cloud-secret-payload/v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FIELD = /^[a-z][a-z0-9_]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_PLAINTEXT_BYTES = 64 * 1024;
const MAX_ENVELOPE_BYTES = 128 * 1024;

export interface CloudSecretEnvelopeIdentity {
	readonly companyId: string;
	readonly environmentId: string;
	readonly secretId: string;
	readonly version: number;
	readonly keyId: string;
}

interface CloudSecretEnvelope {
	schema: typeof ENVELOPE_SCHEMA;
	companyId: string;
	environmentId: string;
	secretId: string;
	version: number;
	keyId: string;
	aadSha256: string;
	payloadIv: string;
	payloadTag: string;
	payloadCiphertext: string;
	wrapIv: string;
	wrapTag: string;
	wrappedKey: string;
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype ||
		Object.keys(value).sort().join() !== [...keys].sort().join()
	)
		throw new Error(`${label} is invalid`);
	return value as Record<string, unknown>;
}

function validateIdentity(identity: CloudSecretEnvelopeIdentity): CloudSecretEnvelopeIdentity {
	if (
		![identity.companyId, identity.environmentId, identity.secretId].every((value) => UUID.test(value)) ||
		!Number.isSafeInteger(identity.version) ||
		identity.version < 1 ||
		!KEY_ID.test(identity.keyId)
	)
		throw new Error("Cloud secret envelope identity is invalid");
	return Object.freeze({
		companyId: identity.companyId,
		environmentId: identity.environmentId,
		secretId: identity.secretId,
		version: identity.version,
		keyId: identity.keyId,
	});
}

function aad(identity: CloudSecretEnvelopeIdentity): Buffer {
	return Buffer.from(
		JSON.stringify({
			schema: ENVELOPE_SCHEMA,
			companyId: identity.companyId,
			environmentId: identity.environmentId,
			secretId: identity.secretId,
			version: identity.version,
			keyId: identity.keyId,
		}),
		"utf8",
	);
}

function base64(value: Uint8Array): string {
	return Buffer.from(value).toString("base64url");
}

function bytes(value: unknown, length: number | readonly [number, number], label: string): Buffer {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${label} is invalid`);
	const decoded = Buffer.from(value, "base64url");
	const valid = Array.isArray(length)
		? decoded.byteLength >= length[0] && decoded.byteLength <= length[1]
		: decoded.byteLength === length;
	if (!valid || base64(decoded) !== value) {
		decoded.fill(0);
		throw new Error(`${label} is invalid`);
	}
	return decoded;
}

function key(value: Uint8Array): Buffer {
	if (value.byteLength !== 32) throw new Error("Cloud secret wrapping key must contain 32 bytes");
	return Buffer.from(value);
}

function normalizedFields(value: Readonly<Record<string, string>>): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Cloud secret fields are invalid");
	const names = Object.keys(value).sort();
	if (names.length < 1 || names.length > 16 || names.some((name) => !FIELD.test(name))) {
		throw new Error("Cloud secret fields are invalid");
	}
	const fields: Record<string, string> = {};
	for (const name of names) {
		const descriptor = Object.getOwnPropertyDescriptor(value, name);
		if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "string") {
			throw new Error("Cloud secret fields are invalid");
		}
		if (!descriptor.value || Buffer.byteLength(descriptor.value) > 32 * 1024) {
			throw new Error("Cloud secret field is invalid");
		}
		fields[name] = descriptor.value;
	}
	const encoded = Buffer.from(JSON.stringify({ schema: PAYLOAD_SCHEMA, fields }), "utf8");
	try {
		if (encoded.byteLength > MAX_PLAINTEXT_BYTES) throw new Error("Cloud secret payload is too large");
	} finally {
		encoded.fill(0);
	}
	return fields;
}

export function sealCloudSecretFields(
	fieldsValue: Readonly<Record<string, string>>,
	wrappingKey: Uint8Array,
	identityValue: CloudSecretEnvelopeIdentity,
): Uint8Array {
	const identity = validateIdentity(identityValue);
	const fields = normalizedFields(fieldsValue);
	const plaintext = Buffer.from(JSON.stringify({ schema: PAYLOAD_SCHEMA, fields }), "utf8");
	const associatedData = aad(identity);
	const dataKey = randomBytes(32);
	const payloadIv = randomBytes(12);
	const wrapIv = randomBytes(12);
	const kek = key(wrappingKey);
	try {
		const payloadCipher = createCipheriv("aes-256-gcm", dataKey, payloadIv);
		payloadCipher.setAAD(associatedData);
		const payloadCiphertext = Buffer.concat([payloadCipher.update(plaintext), payloadCipher.final()]);
		const payloadTag = payloadCipher.getAuthTag();
		const wrapCipher = createCipheriv("aes-256-gcm", kek, wrapIv);
		wrapCipher.setAAD(associatedData);
		const wrappedKey = Buffer.concat([wrapCipher.update(dataKey), wrapCipher.final()]);
		const wrapTag = wrapCipher.getAuthTag();
		const envelope: CloudSecretEnvelope = {
			schema: ENVELOPE_SCHEMA,
			...identity,
			aadSha256: createHash("sha256").update(associatedData).digest("hex"),
			payloadIv: base64(payloadIv),
			payloadTag: base64(payloadTag),
			payloadCiphertext: base64(payloadCiphertext),
			wrapIv: base64(wrapIv),
			wrapTag: base64(wrapTag),
			wrappedKey: base64(wrappedKey),
		};
		const encoded = Buffer.from(JSON.stringify(envelope), "utf8");
		if (encoded.byteLength > MAX_ENVELOPE_BYTES) {
			encoded.fill(0);
			throw new Error("Cloud secret envelope is too large");
		}
		return encoded;
	} finally {
		plaintext.fill(0);
		associatedData.fill(0);
		dataKey.fill(0);
		payloadIv.fill(0);
		wrapIv.fill(0);
		kek.fill(0);
		for (const name of Object.keys(fields)) fields[name] = "";
	}
}

function parseEnvelope(value: Uint8Array, expected: CloudSecretEnvelopeIdentity): CloudSecretEnvelope {
	if (value.byteLength < 1 || value.byteLength > MAX_ENVELOPE_BYTES)
		throw new Error("Cloud secret envelope is invalid");
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value));
	} catch {
		throw new Error("Cloud secret envelope is invalid");
	}
	const input = exactRecord(
		parsed,
		[
			"schema",
			"companyId",
			"environmentId",
			"secretId",
			"version",
			"keyId",
			"aadSha256",
			"payloadIv",
			"payloadTag",
			"payloadCiphertext",
			"wrapIv",
			"wrapTag",
			"wrappedKey",
		],
		"Cloud secret envelope",
	);
	if (
		input.schema !== ENVELOPE_SCHEMA ||
		input.companyId !== expected.companyId ||
		input.environmentId !== expected.environmentId ||
		input.secretId !== expected.secretId ||
		input.version !== expected.version ||
		input.keyId !== expected.keyId ||
		typeof input.aadSha256 !== "string" ||
		!SHA256.test(input.aadSha256)
	)
		throw new Error("Cloud secret envelope identity differs");
	return input as unknown as CloudSecretEnvelope;
}

/**
 * Plaintext is scoped to this callback. Callers must not retain, return, log,
 * serialize, or copy the fields; the cloud broker applies a separate output
 * fence to the callback result before releasing anything.
 */
export async function withCloudSecretFields<T>(
	envelopeBytes: Uint8Array,
	wrappingKey: Uint8Array,
	identityValue: CloudSecretEnvelopeIdentity,
	use: (fields: Readonly<Record<string, string>>) => Promise<T>,
): Promise<T> {
	const identity = validateIdentity(identityValue);
	const envelope = parseEnvelope(envelopeBytes, identity);
	const associatedData = aad(identity);
	const digest = createHash("sha256").update(associatedData).digest("hex");
	if (digest !== envelope.aadSha256) {
		associatedData.fill(0);
		throw new Error("Cloud secret envelope authentication differs");
	}
	const payloadIv = bytes(envelope.payloadIv, 12, "Cloud secret payload IV");
	const payloadTag = bytes(envelope.payloadTag, 16, "Cloud secret payload tag");
	const payloadCiphertext = bytes(
		envelope.payloadCiphertext,
		[1, MAX_PLAINTEXT_BYTES + 16],
		"Cloud secret payload ciphertext",
	);
	const wrapIv = bytes(envelope.wrapIv, 12, "Cloud secret wrap IV");
	const wrapTag = bytes(envelope.wrapTag, 16, "Cloud secret wrap tag");
	const wrappedKey = bytes(envelope.wrappedKey, 32, "Cloud secret wrapped key");
	const kek = key(wrappingKey);
	let dataKey: Buffer | undefined;
	let plaintext: Buffer | undefined;
	let fields: Record<string, string> | undefined;
	try {
		const wrapDecipher = createDecipheriv("aes-256-gcm", kek, wrapIv);
		wrapDecipher.setAAD(associatedData);
		wrapDecipher.setAuthTag(wrapTag);
		dataKey = Buffer.concat([wrapDecipher.update(wrappedKey), wrapDecipher.final()]);
		if (dataKey.byteLength !== 32) throw new Error("Cloud secret data key is invalid");
		const payloadDecipher = createDecipheriv("aes-256-gcm", dataKey, payloadIv);
		payloadDecipher.setAAD(associatedData);
		payloadDecipher.setAuthTag(payloadTag);
		plaintext = Buffer.concat([payloadDecipher.update(payloadCiphertext), payloadDecipher.final()]);
		if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) throw new Error("Cloud secret payload is too large");
		const payload = exactRecord(JSON.parse(plaintext.toString("utf8")), ["schema", "fields"], "Cloud secret payload");
		if (payload.schema !== PAYLOAD_SCHEMA) throw new Error("Cloud secret payload schema is invalid");
		fields = normalizedFields(payload.fields as Readonly<Record<string, string>>);
		return await use(fields);
	} catch {
		throw new Error("Cloud secret envelope could not be opened");
	} finally {
		associatedData.fill(0);
		payloadIv.fill(0);
		payloadTag.fill(0);
		payloadCiphertext.fill(0);
		wrapIv.fill(0);
		wrapTag.fill(0);
		wrappedKey.fill(0);
		kek.fill(0);
		dataKey?.fill(0);
		plaintext?.fill(0);
		if (fields) for (const name of Object.keys(fields)) fields[name] = "";
	}
}

/** A company's wrapping key under a derived key id (Vault By Default): HKDF-SHA256 of the master key
 * with the company id, so both copies of the shared vault get the same key and nothing is stored. */
function derivedWrappingKey(masterKey: Uint8Array, companyId: string): Buffer {
	if (!UUID.test(companyId)) throw new Error("Cloud secret company is invalid");
	return Buffer.from(hkdfSync("sha256", masterKey, "qorpera.company-kek/v1", companyId.toLowerCase(), 32));
}

/** A member's wrapping key (account model logins): HKDF-SHA256 of the shared vault's master key with the member's
 * user id under its own label, so it is never a company's key and both copies of the vault derive the same one. */
function memberWrappingKey(masterKey: Uint8Array, memberId: string): Buffer {
	if (!UUID.test(memberId)) throw new Error("Cloud secret member is invalid");
	return Buffer.from(hkdfSync("sha256", masterKey, "qorpera.member-kek/v1", memberId.toLowerCase(), 32));
}

/** Whose sealed secret a member envelope holds: the member and the login, under one of the vault's master keys. */
export interface CloudSecretMemberEnvelopeIdentity {
	readonly memberId: string;
	readonly loginId: string;
	readonly version: number;
	readonly keyId: string;
}

/** A member envelope is bound to its member and login: both identity fields name the member, the secret is the
 * login. Its key is the member's, so a company envelope never opens as one, nor one as a company envelope. */
export function memberEnvelopeIdentity(identity: CloudSecretMemberEnvelopeIdentity): CloudSecretEnvelopeIdentity {
	const memberId = identity.memberId.toLowerCase();
	return {
		companyId: memberId,
		environmentId: memberId,
		secretId: identity.loginId.toLowerCase(),
		version: identity.version,
		keyId: identity.keyId,
	};
}

/** The PKCS#8 prefix (RFC 8410) of an X25519 private key, for a raw 32-byte seed. */
const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519_BYTES = 12;

/** Which capture key: the secret a captured value goes to (a Stripe hook's reserved secret, E3c; a coding value's,
 * 20260930695000), under one of the company's keys. */
export interface CloudHookCaptureKeyIdentity {
	readonly companyId: string;
	readonly environmentId: string;
	readonly secretId: string;
	readonly keyId: string;
}

/** The HKDF info of each kind of capture key: a hook's and a coding value's never coincide for one secret id. */
const CAPTURE_KEY_INFO = {
	hook: { info: "qorpera.event-hook-capture-key/v1", label: "Hook capture key identity" },
	codingValue: { info: "qorpera.coding-value-capture-key/v1", label: "Coding value capture key identity" },
} as const;
type CaptureKeyKind = keyof typeof CAPTURE_KEY_INFO;

/** A capture key pair from the company's key: HKDF-SHA256 with its kind's own info, salted with the secret id and the
 * environment (lowercase, "secretId:environmentId"), as an X25519 seed. Nothing is stored: both copies of the vault
 * derive the same pair, and the office seals to its public half. */
function captureKey(companyKey: Uint8Array, identity: CloudHookCaptureKeyIdentity, kind: CaptureKeyKind): KeyObject {
	if (![identity.companyId, identity.environmentId, identity.secretId].every((value) => UUID.test(value)))
		throw new Error(`${CAPTURE_KEY_INFO[kind].label} is invalid`);
	const salt = `${identity.secretId.toLowerCase()}:${identity.environmentId.toLowerCase()}`;
	const seed = Buffer.from(hkdfSync("sha256", companyKey, salt, CAPTURE_KEY_INFO[kind].info, 32));
	const der = Buffer.concat([PKCS8_X25519, seed]);
	try {
		return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
	} finally {
		seed.fill(0);
		der.fill(0);
	}
}

/** A private key's raw public half (32 bytes, base64url). */
function rawPublicKey(privateKey: KeyObject): string {
	const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
	return Buffer.from(spki.subarray(SPKI_X25519_BYTES)).toString("base64url");
}

/** A broker keyring never exposes raw key material to an adapter. It holds each company's own keys
 * and, for the shared vault (Vault By Default), master keys from which each company's key is derived. */
export class CloudSecretKeyring {
	readonly #keys = new Map<string, Buffer>();
	readonly #derived = new Map<string, Buffer>();

	constructor(
		keys: Readonly<Record<string, Uint8Array>>,
		/** Master keys by key id: a company's key under such an id is derived for that company. */
		derivedKeys: Readonly<Record<string, Uint8Array>> = {},
	) {
		for (const [target, entries] of [
			[this.#keys, keys],
			[this.#derived, derivedKeys],
		] as const) {
			for (const [keyId, value] of Object.entries(entries)) {
				if (!KEY_ID.test(keyId) || value.byteLength !== 32 || this.#keys.has(keyId) || this.#derived.has(keyId)) {
					this.close();
					throw new Error("Cloud secret keyring is invalid");
				}
				target.set(keyId, Buffer.from(value));
			}
		}
		if (this.#keys.size + this.#derived.size < 1) throw new Error("Cloud secret keyring is empty");
	}

	has(keyId: string): boolean {
		return this.#keys.has(keyId) || this.#derived.has(keyId);
	}

	seal(fields: Readonly<Record<string, string>>, identity: CloudSecretEnvelopeIdentity): Uint8Array {
		const own = this.#keys.get(identity.keyId);
		if (own) return sealCloudSecretFields(fields, own, identity);
		const master = this.#derived.get(identity.keyId);
		if (!master) throw new Error("Cloud secret wrapping key is unavailable");
		const derived = derivedWrappingKey(master, identity.companyId);
		try {
			return sealCloudSecretFields(fields, derived, identity);
		} finally {
			derived.fill(0);
		}
	}

	async use<T>(
		envelope: Uint8Array,
		identity: CloudSecretEnvelopeIdentity,
		callback: (fields: Readonly<Record<string, string>>) => Promise<T>,
	): Promise<T> {
		const own = this.#keys.get(identity.keyId);
		if (own) return withCloudSecretFields(envelope, own, identity, callback);
		const master = this.#derived.get(identity.keyId);
		if (!master) throw new Error("Cloud secret wrapping key is unavailable");
		const derived = derivedWrappingKey(master, identity.companyId);
		try {
			return await withCloudSecretFields(envelope, derived, identity, callback);
		} finally {
			derived.fill(0);
		}
	}

	/** Whether this keyring can derive a member's key under a key id: only a shared vault's master key can. */
	hasMemberKey(keyId: string): boolean {
		return this.#derived.has(keyId);
	}

	/** Seals a member's own secret (an account model login) under the member's key. */
	sealMember(fields: Readonly<Record<string, string>>, identity: CloudSecretMemberEnvelopeIdentity): Uint8Array {
		const master = this.#derived.get(identity.keyId);
		if (!master) throw new Error("Cloud secret member key is unavailable");
		const derived = memberWrappingKey(master, identity.memberId);
		try {
			return sealCloudSecretFields(fields, derived, memberEnvelopeIdentity(identity));
		} finally {
			derived.fill(0);
		}
	}

	async useMember<T>(
		envelope: Uint8Array,
		identity: CloudSecretMemberEnvelopeIdentity,
		callback: (fields: Readonly<Record<string, string>>) => Promise<T>,
	): Promise<T> {
		const master = this.#derived.get(identity.keyId);
		if (!master) throw new Error("Cloud secret member key is unavailable");
		const derived = memberWrappingKey(master, identity.memberId);
		try {
			return await withCloudSecretFields(envelope, derived, memberEnvelopeIdentity(identity), callback);
		} finally {
			derived.fill(0);
		}
	}

	/** A capture private key, under the key the company's envelopes use: its own key, or the derived one. */
	#captureKey(identity: CloudHookCaptureKeyIdentity, kind: CaptureKeyKind): KeyObject {
		if (!KEY_ID.test(identity.keyId)) throw new Error(`${CAPTURE_KEY_INFO[kind].label} is invalid`);
		const own = this.#keys.get(identity.keyId);
		if (own) return captureKey(own, identity, kind);
		const master = this.#derived.get(identity.keyId);
		if (!master) throw new Error("Cloud secret wrapping key is unavailable");
		const derived = derivedWrappingKey(master, identity.companyId);
		try {
			return captureKey(derived, identity, kind);
		} finally {
			derived.fill(0);
		}
	}

	/** The public half the office seals a hook's captured secret to (32 raw bytes, base64url). */
	capturePublicKey(identity: CloudHookCaptureKeyIdentity): string {
		return rawPublicKey(this.#captureKey(identity, "hook"));
	}

	/** The captured secret inside a box the office sealed to this hook's capture key for exactly this call. */
	async openCapture<T>(
		identity: CloudHookCaptureKeyIdentity,
		box: unknown,
		expected: EventHookCaptureIdentity,
		callback: (capture: EventHookCapture) => Promise<T>,
		nowMs = Date.now(),
	): Promise<T> {
		const privateKey = this.#captureKey(identity, "hook");
		return openEventHookCapture(privateKey, rawPublicKey(privateKey), box, expected, callback, nowMs);
	}

	/** The public half the office seals a captured coding value to (20260930695000): the value's secret id's own pair,
	 * under its own info, never a hook's. */
	codingValueCapturePublicKey(identity: CloudHookCaptureKeyIdentity): string {
		return rawPublicKey(this.#captureKey(identity, "codingValue"));
	}

	/** The coding value inside a box the office sealed to this value's capture key for exactly this call. */
	async openCodingValueCapture<T>(
		identity: CloudHookCaptureKeyIdentity,
		box: unknown,
		expected: CodingValueCaptureIdentity,
		callback: (capture: CodingValueCapture) => Promise<T>,
		nowMs = Date.now(),
	): Promise<T> {
		const privateKey = this.#captureKey(identity, "codingValue");
		return openCodingValueCapture(privateKey, rawPublicKey(privateKey), box, expected, callback, nowMs);
	}

	close(): void {
		for (const value of this.#keys.values()) value.fill(0);
		for (const value of this.#derived.values()) value.fill(0);
		this.#keys.clear();
		this.#derived.clear();
	}
}
