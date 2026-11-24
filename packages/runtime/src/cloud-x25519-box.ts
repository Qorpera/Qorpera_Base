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

const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");
const BOX_HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export const BOX_CLOCK_SKEW_MS = 60_000;

export function encodeBoxBase64Url(value: Uint8Array): string {
	return Buffer.from(value).toString("base64url");
}

export function decodeBoxBase64Url(value: unknown, length: number | readonly [number, number], label: string): Buffer {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${label} is malformed`);
	const out = Buffer.from(value, "base64url");
	const fits = Array.isArray(length)
		? out.byteLength >= length[0] && out.byteLength <= length[1]
		: out.byteLength === length;
	if (!fits || encodeBoxBase64Url(out) !== value) throw new Error(`${label} is malformed`);
	return out;
}

export function isValidBoxHost(value: unknown): value is string {
	return typeof value === "string" && value.length <= 253 && BOX_HOST.test(value);
}

export function createX25519PublicKeyFromRaw(raw: Buffer): KeyObject {
	return createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: "der", type: "spki" });
}

export function parseX25519PublicKey(value: unknown, label: string): KeyObject {
	return createX25519PublicKeyFromRaw(decodeBoxBase64Url(value, 32, label));
}

export function generateX25519KeyPair(): { readonly privateKey: KeyObject; readonly publicKey: string } {
	const pair = generateKeyPairSync("x25519");
	const spki = pair.publicKey.export({ format: "der", type: "spki" });
	return {
		privateKey: pair.privateKey,
		publicKey: encodeBoxBase64Url(spki.subarray(SPKI_X25519.byteLength)),
	};
}

function deriveBoxKey(
	privateKey: KeyObject,
	peer: KeyObject,
	ephemeral: Buffer,
	recipient: Buffer,
	info: string | Buffer,
): Buffer {
	const shared = diffieHellman({ privateKey, publicKey: peer });
	try {
		return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([ephemeral, recipient]), info, 32));
	} finally {
		shared.fill(0);
	}
}

export function sealX25519Box(options: {
	readonly boxSchema: string;
	readonly info: string | Buffer;
	readonly keyLabel: string;
	readonly recipientPublicKey: string;
	readonly associatedData: Buffer;
	readonly plaintext: Buffer;
}): Record<string, string> {
	const recipient = decodeBoxBase64Url(options.recipientPublicKey, 32, options.keyLabel);
	const pair = generateKeyPairSync("x25519");
	const ephemeral = Buffer.from(
		pair.publicKey.export({ format: "der", type: "spki" }).subarray(SPKI_X25519.byteLength),
	);
	const key = deriveBoxKey(
		pair.privateKey,
		createX25519PublicKeyFromRaw(recipient),
		ephemeral,
		recipient,
		options.info,
	);
	const iv = randomBytes(12);
	try {
		const cipher = createCipheriv("aes-256-gcm", key, iv);
		cipher.setAAD(options.associatedData);
		const ciphertext = Buffer.concat([cipher.update(options.plaintext), cipher.final()]);
		return {
			schema: options.boxSchema,
			ephemeralPublicKey: encodeBoxBase64Url(ephemeral),
			iv: encodeBoxBase64Url(iv),
			tag: encodeBoxBase64Url(cipher.getAuthTag()),
			ciphertext: encodeBoxBase64Url(ciphertext),
		};
	} finally {
		key.fill(0);
		options.plaintext.fill(0);
	}
}

export function openX25519Box(options: {
	readonly boxSchema: string;
	readonly info: string | Buffer;
	readonly boxLabel: string;
	readonly keyLabel: string;
	readonly privateKey: KeyObject;
	readonly recipientPublicKey: string;
	readonly box: unknown;
	readonly associatedData: Buffer | (() => Buffer);
}): Buffer {
	const { box } = options;
	if (
		!box ||
		typeof box !== "object" ||
		Array.isArray(box) ||
		Object.keys(box).sort().join() !== "ciphertext,ephemeralPublicKey,iv,schema,tag"
	)
		throw new Error(`${options.boxLabel} is malformed`);
	const input = box as Record<string, unknown>;
	if (input.schema !== options.boxSchema) throw new Error(`${options.boxLabel} is malformed`);
	const ephemeral = decodeBoxBase64Url(input.ephemeralPublicKey, 32, options.boxLabel);
	const iv = decodeBoxBase64Url(input.iv, 12, options.boxLabel);
	const tag = decodeBoxBase64Url(input.tag, 16, options.boxLabel);
	const ciphertext = decodeBoxBase64Url(input.ciphertext, [1, 4096], options.boxLabel);
	const recipient = decodeBoxBase64Url(options.recipientPublicKey, 32, options.keyLabel);
	let key: Buffer;
	try {
		key = deriveBoxKey(
			options.privateKey,
			createX25519PublicKeyFromRaw(ephemeral),
			ephemeral,
			recipient,
			options.info,
		);
	} catch {
		throw new Error(`${options.boxLabel} does not open here`);
	}
	try {
		const aad = typeof options.associatedData === "function" ? options.associatedData() : options.associatedData;
		const decipher = createDecipheriv("aes-256-gcm", key, iv);
		decipher.setAAD(aad);
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	} catch {
		throw new Error(`${options.boxLabel} does not open here`);
	} finally {
		key.fill(0);
	}
}
