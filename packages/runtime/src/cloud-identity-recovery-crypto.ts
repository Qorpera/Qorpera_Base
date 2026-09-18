import {
	constants,
	createHash,
	createHmac,
	createPublicKey,
	type KeyObject,
	privateDecrypt,
	publicEncrypt,
	sign,
	verify,
} from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_ENVELOPE_BYTES = 16_384;

export interface RecoveryKeyBinding {
	companyId: string;
	computeIdentityId: string;
	authorityId: string;
	revision: number;
	policySha256: string;
	keySha256: string;
	wrappingKeySha256: string;
}

export interface RecoveryBackup {
	schema: "qorpera.identity-key-backup/v1";
	binding: RecoveryKeyBinding;
	wrappedKey: string;
	signature: string;
}

export interface RecoveryReleaseBinding {
	key: RecoveryKeyBinding;
	recoveryId: string;
	targetId: string;
	epoch: number;
	backupSha256: string;
	recipientKeySha256: string;
	issuedAt: string;
	expiresAt: string;
}

export interface RecoveryRelease {
	schema: "qorpera.identity-key-release/v1";
	binding: RecoveryReleaseBinding;
	wrappedKey: string;
	signature: string;
}

export function recoveryDigest(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function recoveryRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid recovery record");
	const input = value as Record<string, unknown>;
	if (Object.keys(input).length !== keys.length || keys.some((key) => !Object.hasOwn(input, key)))
		throw new Error("Invalid recovery record fields");
	return input;
}

export function recoveryUuid(value: unknown): string {
	if (typeof value !== "string" || !UUID.test(value)) throw new Error("Invalid recovery identity");
	return value;
}

export function recoverySha256(value: unknown): string {
	if (typeof value !== "string" || !SHA256.test(value)) throw new Error("Invalid recovery digest");
	return value;
}

export function recoveryInteger(value: unknown, minimum = 1): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum)
		throw new Error("Invalid recovery revision");
	return value;
}

export function recoveryTimestamp(value: unknown): string {
	if (typeof value !== "string" || value.length !== 24 || !Number.isFinite(Date.parse(value)))
		throw new Error("Invalid recovery timestamp");
	if (new Date(value).toISOString() !== value) throw new Error("Noncanonical recovery timestamp");
	return value;
}

export function recoveryBase64(value: unknown, bytes: number): Buffer {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid recovery encoding");
	const decoded = Buffer.from(value, "base64url");
	if (decoded.byteLength !== bytes || decoded.toString("base64url") !== value)
		throw new Error("Invalid recovery encoding");
	return decoded;
}

export function recoveryPublicKey(encoded: string, kind: "rsa" | "ed25519"): KeyObject {
	if (typeof encoded !== "string" || encoded.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(encoded))
		throw new Error("Invalid recovery public key");
	const der = Buffer.from(encoded, "base64url");
	if (der.toString("base64url") !== encoded) throw new Error("Invalid recovery public key");
	const key = createPublicKey({ key: der, format: "der", type: "spki" });
	if (
		key.type !== "public" ||
		key.asymmetricKeyType !== kind ||
		(kind === "rsa" &&
			(key.asymmetricKeyDetails?.modulusLength !== 3072 || key.asymmetricKeyDetails.publicExponent !== 65537n)) ||
		key.export({ type: "spki", format: "der" }).toString("base64url") !== encoded
	)
		throw new Error("Unsupported recovery public key");
	return key;
}

export function recoveryPublicKeyText(key: KeyObject): string {
	const publicKey = key.type === "public" ? key : createPublicKey(key);
	return publicKey.export({ type: "spki", format: "der" }).toString("base64url");
}

export function recoveryPublicKeyDigest(key: KeyObject): string {
	return recoveryDigest(Buffer.from(recoveryPublicKeyText(key), "base64url"));
}

export function parseRecoveryKeyBinding(value: unknown): RecoveryKeyBinding {
	const input = recoveryRecord(value, [
		"companyId",
		"computeIdentityId",
		"authorityId",
		"revision",
		"policySha256",
		"keySha256",
		"wrappingKeySha256",
	]);
	return {
		companyId: recoveryUuid(input.companyId),
		computeIdentityId: recoveryUuid(input.computeIdentityId),
		authorityId: recoveryUuid(input.authorityId),
		revision: recoveryInteger(input.revision),
		policySha256: recoverySha256(input.policySha256),
		keySha256: recoverySha256(input.keySha256),
		wrappingKeySha256: recoverySha256(input.wrappingKeySha256),
	};
}

export function parseRecoveryReleaseBinding(value: unknown): RecoveryReleaseBinding {
	const input = recoveryRecord(value, [
		"key",
		"recoveryId",
		"targetId",
		"epoch",
		"backupSha256",
		"recipientKeySha256",
		"issuedAt",
		"expiresAt",
	]);
	const binding: RecoveryReleaseBinding = {
		key: parseRecoveryKeyBinding(input.key),
		recoveryId: recoveryUuid(input.recoveryId),
		targetId: recoveryUuid(input.targetId),
		epoch: recoveryInteger(input.epoch),
		backupSha256: recoverySha256(input.backupSha256),
		recipientKeySha256: recoverySha256(input.recipientKeySha256),
		issuedAt: recoveryTimestamp(input.issuedAt),
		expiresAt: recoveryTimestamp(input.expiresAt),
	};
	const duration = Date.parse(binding.expiresAt) - Date.parse(binding.issuedAt);
	if (duration <= 0 || duration > 60_000) throw new Error("Invalid recovery release lifetime");
	return binding;
}

function label(purpose: "backup" | "release", binding: RecoveryKeyBinding | RecoveryReleaseBinding): Buffer {
	return Buffer.from(`qorpera.identity-key-${purpose}/v1\0${JSON.stringify(binding)}`, "utf8");
}

export function wrapRecoveryKey(key: Uint8Array, binding: RecoveryKeyBinding, publicKey: KeyObject): string {
	const normalized = parseRecoveryKeyBinding(binding);
	recoveryPublicKey(recoveryPublicKeyText(publicKey), "rsa");
	if (
		key.byteLength !== 32 ||
		recoveryDigest(key) !== normalized.keySha256 ||
		recoveryPublicKeyDigest(publicKey) !== normalized.wrappingKeySha256
	)
		throw new Error("Recovery key does not match its binding");
	return publicEncrypt(
		{
			key: publicKey,
			padding: constants.RSA_PKCS1_OAEP_PADDING,
			oaepHash: "sha256",
			oaepLabel: label("backup", normalized),
		},
		key,
	).toString("base64url");
}

export function unwrapRecoveryKey(wrappedKey: string, binding: RecoveryKeyBinding, privateKey: KeyObject): Buffer {
	const normalized = parseRecoveryKeyBinding(binding);
	recoveryPublicKey(recoveryPublicKeyText(privateKey), "rsa");
	if (privateKey.type !== "private" || recoveryPublicKeyDigest(privateKey) !== normalized.wrappingKeySha256)
		throw new Error("Recovery wrapping authority differs");
	let key: Buffer;
	try {
		key = privateDecrypt(
			{
				key: privateKey,
				padding: constants.RSA_PKCS1_OAEP_PADDING,
				oaepHash: "sha256",
				oaepLabel: label("backup", normalized),
			},
			recoveryBase64(wrappedKey, 384),
		);
	} catch {
		throw new Error("Recovery key decryption rejected");
	}
	if (key.byteLength !== 32 || recoveryDigest(key) !== normalized.keySha256) {
		key.fill(0);
		throw new Error("Recovery key commitment differs");
	}
	return key;
}

export function signRecoveryBackup(
	binding: RecoveryKeyBinding,
	wrappedKey: string,
	signingKey: KeyObject,
): RecoveryBackup {
	recoveryBase64(wrappedKey, 384);
	recoveryPublicKey(recoveryPublicKeyText(signingKey), "ed25519");
	if (signingKey.type !== "private") throw new Error("Recovery signing key is not private");
	const body = {
		schema: "qorpera.identity-key-backup/v1" as const,
		binding: parseRecoveryKeyBinding(binding),
		wrappedKey,
	};
	return { ...body, signature: sign(null, Buffer.from(JSON.stringify(body)), signingKey).toString("base64url") };
}

export function verifyRecoveryBackup(
	bytes: Uint8Array,
	expected: RecoveryKeyBinding,
	publicKey: KeyObject,
): RecoveryBackup {
	if (bytes.byteLength > MAX_ENVELOPE_BYTES) throw new Error("Recovery envelope exceeds its bound");
	const input = recoveryRecord(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)), [
		"schema",
		"binding",
		"wrappedKey",
		"signature",
	]);
	if (input.schema !== "qorpera.identity-key-backup/v1") throw new Error("Invalid recovery backup schema");
	const binding = parseRecoveryKeyBinding(input.binding);
	if (JSON.stringify(binding) !== JSON.stringify(parseRecoveryKeyBinding(expected)))
		throw new Error("Recovery backup authority differs");
	recoveryPublicKey(recoveryPublicKeyText(publicKey), "ed25519");
	const wrappedKey = recoveryBase64(input.wrappedKey, 384).toString("base64url");
	const signature = recoveryBase64(input.signature, 64);
	const body = { schema: "qorpera.identity-key-backup/v1" as const, binding, wrappedKey };
	if (!verify(null, Buffer.from(JSON.stringify(body)), publicKey, signature))
		throw new Error("Recovery backup signature rejected");
	return { ...body, signature: signature.toString("base64url") };
}

export function sealRecoveryRelease(
	key: Uint8Array,
	binding: RecoveryReleaseBinding,
	recipientKey: KeyObject,
	signingKey: KeyObject,
): RecoveryRelease {
	const normalized = parseRecoveryReleaseBinding(binding);
	recoveryPublicKey(recoveryPublicKeyText(recipientKey), "rsa");
	recoveryPublicKey(recoveryPublicKeyText(signingKey), "ed25519");
	if (
		key.byteLength !== 32 ||
		recoveryDigest(key) !== normalized.key.keySha256 ||
		recoveryPublicKeyDigest(recipientKey) !== normalized.recipientKeySha256 ||
		signingKey.type !== "private"
	)
		throw new Error("Recovery release key binding differs");
	const wrappedKey = publicEncrypt(
		{
			key: recipientKey,
			padding: constants.RSA_PKCS1_OAEP_PADDING,
			oaepHash: "sha256",
			oaepLabel: label("release", normalized),
		},
		key,
	).toString("base64url");
	const body = { schema: "qorpera.identity-key-release/v1" as const, binding: normalized, wrappedKey };
	return { ...body, signature: sign(null, Buffer.from(JSON.stringify(body)), signingKey).toString("base64url") };
}

export function openRecoveryRelease(
	bytes: Uint8Array,
	expected: RecoveryReleaseBinding,
	recipientKey: KeyObject,
	signingPublicKey: KeyObject,
	now = Date.now(),
): Buffer {
	const release = verifyRecoveryRelease(bytes, expected, signingPublicKey);
	const binding = release.binding;
	if (
		!Number.isSafeInteger(now) ||
		now < Date.parse(binding.issuedAt) ||
		now >= Date.parse(binding.expiresAt) ||
		recipientKey.type !== "private" ||
		recoveryPublicKeyDigest(recipientKey) !== binding.recipientKeySha256
	)
		throw new Error("Recovery release authority differs or expired");
	recoveryPublicKey(recoveryPublicKeyText(recipientKey), "rsa");
	let key: Buffer;
	try {
		key = privateDecrypt(
			{
				key: recipientKey,
				padding: constants.RSA_PKCS1_OAEP_PADDING,
				oaepHash: "sha256",
				oaepLabel: label("release", binding),
			},
			recoveryBase64(release.wrappedKey, 384),
		);
	} catch {
		throw new Error("Recovery release decryption rejected");
	}
	if (key.byteLength !== 32 || recoveryDigest(key) !== binding.key.keySha256) {
		key.fill(0);
		throw new Error("Recovery release commitment differs");
	}
	return key;
}

export function verifyRecoveryRelease(
	bytes: Uint8Array,
	expected: RecoveryReleaseBinding,
	signingPublicKey: KeyObject,
): RecoveryRelease {
	if (bytes.byteLength > MAX_ENVELOPE_BYTES) throw new Error("Recovery envelope exceeds its bound");
	const input = recoveryRecord(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)), [
		"schema",
		"binding",
		"wrappedKey",
		"signature",
	]);
	if (input.schema !== "qorpera.identity-key-release/v1") throw new Error("Invalid recovery release schema");
	const binding = parseRecoveryReleaseBinding(input.binding);
	if (JSON.stringify(binding) !== JSON.stringify(parseRecoveryReleaseBinding(expected)))
		throw new Error("Recovery release authority differs");
	recoveryPublicKey(recoveryPublicKeyText(signingPublicKey), "ed25519");
	const wrappedKey = recoveryBase64(input.wrappedKey, 384).toString("base64url");
	const body = { schema: "qorpera.identity-key-release/v1" as const, binding, wrappedKey };
	if (!verify(null, Buffer.from(JSON.stringify(body)), signingPublicKey, recoveryBase64(input.signature, 64)))
		throw new Error("Recovery release signature rejected");
	return { ...body, signature: recoveryBase64(input.signature, 64).toString("base64url") };
}

/** Proof is usable only for this committed release; never a provider credential. */
export function recoveryPossessionProof(key: Uint8Array, recoveryId: string, releaseSha256: string): Buffer {
	if (key.byteLength !== 32) throw new Error("Invalid recovery key");
	return createHmac("sha256", key)
		.update(`qorpera.identity-key-installed/v1\0${recoveryUuid(recoveryId)}\0${recoverySha256(releaseSha256)}`)
		.digest();
}
