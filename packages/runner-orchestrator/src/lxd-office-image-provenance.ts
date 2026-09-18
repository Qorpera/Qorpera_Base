import { createHash, createPublicKey, verify } from "node:crypto";

/** Office images have no native runner OCI image or Compute Identity. Keep
 * their trust domain separate from the runner image envelope. This module
 * verifies existing evidence; it cannot sign or publish a candidate. */
export interface LxdOfficeImageStatement {
	schema: "qorpera.lxd-office-image-provenance/v1";
	image: {
		fingerprint: string;
		baseFingerprint: string;
		architecture: "x86_64" | "aarch64";
		bytes: number;
		guestPackageManifestSha256: string;
		bootstrapSha256: string;
	};
	source: { repository: string; commit: string; tree: "clean" };
	acceptance: {
		testedAt: string;
		evidenceSha256: string;
		virtualization: "kvm";
		bootMode: "uefi-secureboot";
		secureBoot: true;
		credentials: "absent";
		computeIdentity: "absent";
		companyState: "absent";
		services: "fail-closed";
	};
}

export function officeRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype ||
		Object.keys(value).length !== keys.length ||
		Object.keys(value).sort().join() !== [...keys].sort().join()
	)
		throw new Error("INVALID_OFFICE_PHYSICAL_RECORD");
	return value as Record<string, unknown>;
}

export function officeSha(value: unknown): string {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error("INVALID_OFFICE_SHA256");
	return value;
}

export function officeCanonical(value: unknown): string {
	const sorted = (input: unknown): unknown => {
		if (Array.isArray(input)) return input.map(sorted);
		if (!input || typeof input !== "object") return input;
		return Object.fromEntries(
			Object.keys(input)
				.sort()
				.map((key) => [key, sorted((input as Record<string, unknown>)[key])]),
		);
	};
	return JSON.stringify(sorted(value));
}

export function officeDigest(value: unknown): string {
	return createHash("sha256").update(officeCanonical(value)).digest("hex");
}

export function officeImagePublicKey(spki: unknown) {
	if (typeof spki !== "string" || spki.length > 1024) throw new Error("INVALID_OFFICE_IMAGE_KEY");
	const bytes = Buffer.from(spki, "base64");
	if (bytes.toString("base64") !== spki) throw new Error("INVALID_OFFICE_IMAGE_KEY");
	const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
	if (key.asymmetricKeyType !== "ed25519" || !key.export({ format: "der", type: "spki" }).equals(bytes))
		throw new Error("INVALID_OFFICE_IMAGE_KEY");
	return key;
}

export function parseLxdOfficeImageStatement(value: unknown): LxdOfficeImageStatement {
	const v = officeRecord(value, ["schema", "image", "source", "acceptance"]);
	const i = officeRecord(v.image, [
		"fingerprint",
		"baseFingerprint",
		"architecture",
		"bytes",
		"guestPackageManifestSha256",
		"bootstrapSha256",
	]);
	const s = officeRecord(v.source, ["repository", "commit", "tree"]);
	const a = officeRecord(v.acceptance, [
		"testedAt",
		"evidenceSha256",
		"virtualization",
		"bootMode",
		"secureBoot",
		"credentials",
		"computeIdentity",
		"companyState",
		"services",
	]);
	if (typeof s.repository !== "string" || s.repository.length > 2048) throw new Error("INVALID_OFFICE_IMAGE_SOURCE");
	const repository = new URL(s.repository);
	if (
		v.schema !== "qorpera.lxd-office-image-provenance/v1" ||
		(i.architecture !== "x86_64" && i.architecture !== "aarch64") ||
		!Number.isSafeInteger(i.bytes) ||
		(i.bytes as number) < 1 ||
		(i.bytes as number) > 1024 ** 4 ||
		repository.protocol !== "https:" ||
		repository.username ||
		repository.password ||
		repository.hash ||
		repository.search ||
		repository.toString() !== s.repository ||
		typeof s.commit !== "string" ||
		!/^[0-9a-f]{40}$/.test(s.commit) ||
		s.tree !== "clean" ||
		typeof a.testedAt !== "string" ||
		a.testedAt.length !== 24 ||
		!Number.isFinite(Date.parse(a.testedAt)) ||
		new Date(a.testedAt).toISOString() !== a.testedAt ||
		a.virtualization !== "kvm" ||
		a.bootMode !== "uefi-secureboot" ||
		a.secureBoot !== true ||
		a.credentials !== "absent" ||
		a.computeIdentity !== "absent" ||
		a.companyState !== "absent" ||
		a.services !== "fail-closed"
	)
		throw new Error("OFFICE_IMAGE_NOT_ACCEPTED");
	return {
		schema: "qorpera.lxd-office-image-provenance/v1",
		image: {
			fingerprint: officeSha(i.fingerprint),
			baseFingerprint: officeSha(i.baseFingerprint),
			architecture: i.architecture,
			bytes: i.bytes as number,
			guestPackageManifestSha256: officeSha(i.guestPackageManifestSha256),
			bootstrapSha256: officeSha(i.bootstrapSha256),
		},
		source: { repository: s.repository, commit: s.commit, tree: "clean" },
		acceptance: {
			testedAt: a.testedAt,
			evidenceSha256: officeSha(a.evidenceSha256),
			virtualization: "kvm",
			bootMode: "uefi-secureboot",
			secureBoot: true,
			credentials: "absent",
			computeIdentity: "absent",
			companyState: "absent",
			services: "fail-closed",
		},
	};
}

/** The enrolled policy pins the complete statement and public key. A valid
 * signature attests retained build/acceptance evidence, not this boot's health. */
export function verifyLxdOfficeImageProvenance(
	value: unknown,
	verificationKeySpki: string,
	statementSha256: string,
): LxdOfficeImageStatement {
	try {
		const envelope = officeRecord(value, ["schema", "statement", "signature"]);
		const signature = officeRecord(envelope.signature, ["algorithm", "value"]);
		const statement = parseLxdOfficeImageStatement(envelope.statement);
		const key = officeImagePublicKey(verificationKeySpki);
		if (typeof signature.value !== "string" || signature.value.length !== 88) throw new Error("invalid signature");
		const bytes = Buffer.from(signature.value, "base64");
		if (
			envelope.schema !== "qorpera.lxd-office-image-provenance-envelope/v1" ||
			signature.algorithm !== "ed25519" ||
			bytes.length !== 64 ||
			bytes.toString("base64") !== signature.value ||
			officeDigest(statement) !== officeSha(statementSha256) ||
			!verify(null, Buffer.from(officeCanonical(statement)), key, bytes)
		)
			throw new Error("untrusted image provenance");
		return statement;
	} catch {
		throw new Error("LXD_OFFICE_IMAGE_PROVENANCE_UNCONFIRMED");
	}
}
