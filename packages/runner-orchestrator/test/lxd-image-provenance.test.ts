import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	LXD_IMAGE_PROVENANCE_SCHEMA,
	type LxdImageProvenanceStatement,
	signLxdImageProvenance,
	verifyLxdImageProvenance,
} from "../src/lxd-image-provenance.ts";

const fingerprint = "a".repeat(64);
const manifest = "b".repeat(64);

function statement(): LxdImageProvenanceStatement {
	return {
		schema: LXD_IMAGE_PROVENANCE_SCHEMA,
		image: {
			server: "local",
			fingerprint,
			baseFingerprint: "c".repeat(64),
			guestPackageManifestSha256: manifest,
		},
		source: {
			repository: "https://github.com/Qorpera/Qorpera_Base.git",
			commit: "d".repeat(40),
			tree: "clean",
		},
		acceptance: {
			testedAt: "2026-08-23T11:09:32.000Z",
			evidenceSha256: "e".repeat(64),
			virtualization: "kvm",
			bootMode: "uefi-secureboot",
			secureBoot: true,
			credentials: "absent",
			identityVolume: "absent",
			services: "fail-closed",
		},
	};
}

describe("LXD image provenance", () => {
	it("accepts an Ed25519 signature only for the configured immutable image contract", () => {
		const keyPair = generateKeyPairSync("ed25519");
		const envelope = signLxdImageProvenance(statement(), keyPair.privateKey);

		expect(
			verifyLxdImageProvenance(envelope, keyPair.publicKey, {
				imageServer: "local",
				imageFingerprint: fingerprint,
				guestPackageManifestSha256: manifest,
			}),
		).toEqual(statement());
	});

	it("signs with an encrypted off-node private key", () => {
		const keyPair = generateKeyPairSync("ed25519");
		const passphrase = "correct horse battery staple";
		const encrypted = keyPair.privateKey.export({
			type: "pkcs8",
			format: "pem",
			cipher: "aes-256-cbc",
			passphrase,
		});
		const envelope = signLxdImageProvenance(statement(), { key: encrypted, passphrase });

		expect(
			verifyLxdImageProvenance(envelope, keyPair.publicKey, {
				imageServer: "local",
				imageFingerprint: fingerprint,
				guestPackageManifestSha256: manifest,
			}),
		).toEqual(statement());
	});

	it("rejects statement tampering, a different trust root, and expectation drift", () => {
		const keyPair = generateKeyPairSync("ed25519");
		const envelope = signLxdImageProvenance(statement(), keyPair.privateKey);
		const other = generateKeyPairSync("ed25519");
		const expected = {
			imageServer: "local",
			imageFingerprint: fingerprint,
			guestPackageManifestSha256: manifest,
		};

		expect(() => verifyLxdImageProvenance(envelope, other.publicKey, expected)).toThrow("configured trust root");
		expect(() =>
			verifyLxdImageProvenance(
				{
					...envelope,
					statement: {
						...envelope.statement,
						image: { ...envelope.statement.image, fingerprint: "f".repeat(64) },
					},
				},
				keyPair.publicKey,
				expected,
			),
		).toThrow("signature is invalid");
		expect(() =>
			verifyLxdImageProvenance(envelope, keyPair.publicKey, {
				...expected,
				guestPackageManifestSha256: "0".repeat(64),
			}),
		).toThrow("does not authorize");
	});

	it("rejects extra fields and anything weaker than the accepted clean full-VM recipe", () => {
		const keyPair = generateKeyPairSync("ed25519");
		const envelope = signLxdImageProvenance(statement(), keyPair.privateKey);
		const expected = {
			imageServer: "local",
			imageFingerprint: fingerprint,
			guestPackageManifestSha256: manifest,
		};

		expect(() =>
			verifyLxdImageProvenance(
				{ ...envelope, statement: { ...envelope.statement, mutableAlias: true } },
				keyPair.publicKey,
				expected,
			),
		).toThrow("fields are invalid");
		expect(() =>
			signLxdImageProvenance(
				{
					...statement(),
					source: { ...statement().source, tree: "dirty" as "clean" },
				},
				keyPair.privateKey,
			),
		).toThrow("not an accepted full-VM build");
	});
});
