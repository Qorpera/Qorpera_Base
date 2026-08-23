import { createHash, createPrivateKey, createPublicKey, type KeyObject, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";

export const LXD_IMAGE_PROVENANCE_SCHEMA = "qorpera.lxd-runner-image-provenance/v1";
export const LXD_IMAGE_PROVENANCE_ENVELOPE_SCHEMA = "qorpera.lxd-runner-image-provenance-envelope/v1";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface LxdImageProvenanceStatement {
	schema: typeof LXD_IMAGE_PROVENANCE_SCHEMA;
	image: {
		server: string;
		fingerprint: string;
		baseFingerprint: string;
		guestPackageManifestSha256: string;
	};
	source: {
		repository: string;
		commit: string;
		tree: "clean";
	};
	acceptance: {
		testedAt: string;
		evidenceSha256: string;
		virtualization: "kvm";
		bootMode: "uefi-secureboot";
		secureBoot: true;
		credentials: "absent";
		identityVolume: "absent";
		services: "fail-closed";
	};
}

export interface LxdImageProvenanceEnvelope {
	schema: typeof LXD_IMAGE_PROVENANCE_ENVELOPE_SCHEMA;
	statement: LxdImageProvenanceStatement;
	signature: {
		algorithm: "ed25519";
		keyIdSha256: string;
		value: string;
	};
}

export interface LxdImageProvenanceExpectation {
	imageServer: string;
	imageFingerprint: string;
	guestPackageManifestSha256: string;
}

export interface LxdImageProvenanceSigningKey {
	key: string | Buffer;
	passphrase: string | Buffer;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
	return value as Record<string, unknown>;
}

function exactRecord(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
	const input = record(value, label);
	const actual = Object.keys(input).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		throw new Error(`${label} fields are invalid`);
	}
	return input;
}

function text(value: unknown, label: string): string {
	if (typeof value !== "string" || !value || value !== value.trim() || /[\0\r\n]/.test(value)) {
		throw new Error(`${label} is invalid`);
	}
	return value;
}

function sha256(value: unknown, label: string): string {
	const encoded = text(value, label);
	if (!SHA256_PATTERN.test(encoded)) throw new Error(`${label} is invalid`);
	return encoded;
}

function imageServer(value: unknown): string {
	const encoded = text(value, "Provenance image server");
	if (encoded === "local") return encoded;
	let parsed: URL;
	try {
		parsed = new URL(encoded);
	} catch {
		throw new Error("Provenance image server is invalid");
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.username ||
		parsed.password ||
		parsed.hash ||
		parsed.toString() !== encoded
	) {
		throw new Error("Provenance image server is invalid");
	}
	return encoded;
}

function repository(value: unknown): string {
	const encoded = text(value, "Provenance source repository");
	let parsed: URL;
	try {
		parsed = new URL(encoded);
	} catch {
		throw new Error("Provenance source repository is invalid");
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.username ||
		parsed.password ||
		parsed.hash ||
		parsed.toString() !== encoded
	) {
		throw new Error("Provenance source repository is invalid");
	}
	return encoded;
}

function testedAt(value: unknown): string {
	const encoded = text(value, "Provenance acceptance time");
	const parsed = new Date(encoded);
	if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== encoded) {
		throw new Error("Provenance acceptance time must be canonical UTC ISO-8601");
	}
	return encoded;
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((entry) => canonical(entry));
	if (!value || typeof value !== "object") return value;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) {
		const entry = (value as Record<string, unknown>)[key];
		if (entry !== undefined) output[key] = canonical(entry);
	}
	return output;
}

export function canonicalLxdImageProvenanceStatement(statement: LxdImageProvenanceStatement): string {
	return JSON.stringify(canonical(statement));
}

export function parseLxdImageProvenanceStatement(value: unknown): LxdImageProvenanceStatement {
	const input = exactRecord(value, "LXD image provenance statement", ["schema", "image", "source", "acceptance"]);
	const image = exactRecord(input.image, "LXD image provenance image", [
		"server",
		"fingerprint",
		"baseFingerprint",
		"guestPackageManifestSha256",
	]);
	const source = exactRecord(input.source, "LXD image provenance source", ["repository", "commit", "tree"]);
	const acceptance = exactRecord(input.acceptance, "LXD image provenance acceptance", [
		"testedAt",
		"evidenceSha256",
		"virtualization",
		"bootMode",
		"secureBoot",
		"credentials",
		"identityVolume",
		"services",
	]);
	const commit = text(source.commit, "Provenance source commit");
	if (
		input.schema !== LXD_IMAGE_PROVENANCE_SCHEMA ||
		!GIT_COMMIT_PATTERN.test(commit) ||
		source.tree !== "clean" ||
		acceptance.virtualization !== "kvm" ||
		acceptance.bootMode !== "uefi-secureboot" ||
		acceptance.secureBoot !== true ||
		acceptance.credentials !== "absent" ||
		acceptance.identityVolume !== "absent" ||
		acceptance.services !== "fail-closed"
	) {
		throw new Error("LXD image provenance statement is not an accepted full-VM build");
	}
	return {
		schema: LXD_IMAGE_PROVENANCE_SCHEMA,
		image: {
			server: imageServer(image.server),
			fingerprint: sha256(image.fingerprint, "Provenance image fingerprint"),
			baseFingerprint: sha256(image.baseFingerprint, "Provenance base-image fingerprint"),
			guestPackageManifestSha256: sha256(
				image.guestPackageManifestSha256,
				"Provenance guest-package manifest digest",
			),
		},
		source: {
			repository: repository(source.repository),
			commit,
			tree: "clean",
		},
		acceptance: {
			testedAt: testedAt(acceptance.testedAt),
			evidenceSha256: sha256(acceptance.evidenceSha256, "Provenance acceptance-evidence digest"),
			virtualization: "kvm",
			bootMode: "uefi-secureboot",
			secureBoot: true,
			credentials: "absent",
			identityVolume: "absent",
			services: "fail-closed",
		},
	};
}

function ed25519PublicKey(key: string | Buffer | KeyObject): KeyObject {
	const publicKey = key instanceof Object && "type" in key ? (key as KeyObject) : createPublicKey(key);
	if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
		throw new Error("LXD image provenance key must be an Ed25519 public key");
	}
	return publicKey;
}

function keyId(publicKey: KeyObject): string {
	return createHash("sha256")
		.update(publicKey.export({ type: "spki", format: "der" }))
		.digest("hex");
}

function parseEnvelope(value: unknown): LxdImageProvenanceEnvelope {
	const input = exactRecord(value, "LXD image provenance envelope", ["schema", "statement", "signature"]);
	const signature = exactRecord(input.signature, "LXD image provenance signature", [
		"algorithm",
		"keyIdSha256",
		"value",
	]);
	const encodedSignature = text(signature.value, "LXD image provenance signature");
	const decodedSignature = Buffer.from(encodedSignature, "base64");
	if (
		input.schema !== LXD_IMAGE_PROVENANCE_ENVELOPE_SCHEMA ||
		signature.algorithm !== "ed25519" ||
		decodedSignature.byteLength !== 64 ||
		decodedSignature.toString("base64") !== encodedSignature
	) {
		throw new Error("LXD image provenance envelope is invalid");
	}
	return {
		schema: LXD_IMAGE_PROVENANCE_ENVELOPE_SCHEMA,
		statement: parseLxdImageProvenanceStatement(input.statement),
		signature: {
			algorithm: "ed25519",
			keyIdSha256: sha256(signature.keyIdSha256, "LXD image provenance key id"),
			value: encodedSignature,
		},
	};
}

export function signLxdImageProvenance(
	statement: LxdImageProvenanceStatement,
	privateKeyInput: string | Buffer | KeyObject | LxdImageProvenanceSigningKey,
): LxdImageProvenanceEnvelope {
	const accepted = parseLxdImageProvenanceStatement(statement);
	const privateKey =
		privateKeyInput instanceof Object && "type" in privateKeyInput
			? (privateKeyInput as KeyObject)
			: privateKeyInput instanceof Object && "key" in privateKeyInput
				? createPrivateKey({ key: privateKeyInput.key, passphrase: privateKeyInput.passphrase })
				: createPrivateKey(privateKeyInput);
	if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
		throw new Error("LXD image provenance signer must be an Ed25519 private key");
	}
	const publicKey = ed25519PublicKey(createPublicKey(privateKey));
	return {
		schema: LXD_IMAGE_PROVENANCE_ENVELOPE_SCHEMA,
		statement: accepted,
		signature: {
			algorithm: "ed25519",
			keyIdSha256: keyId(publicKey),
			value: sign(null, Buffer.from(canonicalLxdImageProvenanceStatement(accepted)), privateKey).toString("base64"),
		},
	};
}

export function verifyLxdImageProvenance(
	envelopeInput: unknown,
	publicKeyInput: string | Buffer | KeyObject,
	expectation: LxdImageProvenanceExpectation,
): LxdImageProvenanceStatement {
	const envelope = parseEnvelope(envelopeInput);
	const publicKey = ed25519PublicKey(publicKeyInput);
	if (envelope.signature.keyIdSha256 !== keyId(publicKey)) {
		throw new Error("LXD image provenance was not signed by the configured trust root");
	}
	if (
		!verify(
			null,
			Buffer.from(canonicalLxdImageProvenanceStatement(envelope.statement)),
			publicKey,
			Buffer.from(envelope.signature.value, "base64"),
		)
	) {
		throw new Error("LXD image provenance signature is invalid");
	}
	if (
		envelope.statement.image.server !== imageServer(expectation.imageServer) ||
		envelope.statement.image.fingerprint !== sha256(expectation.imageFingerprint, "Expected LXD image fingerprint") ||
		envelope.statement.image.guestPackageManifestSha256 !==
			sha256(expectation.guestPackageManifestSha256, "Expected guest-package manifest digest")
	) {
		throw new Error("LXD image provenance does not authorize the configured image contract");
	}
	return envelope.statement;
}

export function verifyLxdImageProvenanceFiles(
	provenancePath: string,
	publicKeyPath: string,
	expectation: LxdImageProvenanceExpectation,
): LxdImageProvenanceStatement {
	let envelope: unknown;
	try {
		envelope = JSON.parse(readFileSync(provenancePath, "utf-8")) as unknown;
	} catch {
		throw new Error("LXD image provenance file is unreadable or invalid JSON");
	}
	let publicKey: Buffer;
	try {
		publicKey = readFileSync(publicKeyPath);
	} catch {
		throw new Error("LXD image provenance public key is unreadable");
	}
	return verifyLxdImageProvenance(envelope, publicKey, expectation);
}
