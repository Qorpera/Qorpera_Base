import { createPrivateKey, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	openRecoveryRelease,
	parseRecoveryKeyBinding,
	parseRecoveryReleaseBinding,
	type RecoveryKeyBinding,
	type RecoveryReleaseBinding,
	recoveryDigest,
	recoveryPublicKey,
	recoveryPublicKeyDigest,
	recoveryPublicKeyText,
	sealRecoveryRelease,
	signRecoveryBackup,
	unwrapRecoveryKey,
	verifyRecoveryBackup,
	wrapRecoveryKey,
} from "@qorpera/runtime/cloud-identity-recovery-crypto";
import { openNativeCredentialCapsule, sealNativeCredentialCapsule } from "@qorpera/runtime/cloud-native-provider-host";
import { afterEach, describe, expect, it } from "vitest";

const authority = generateKeyPairSync("rsa", { modulusLength: 3072, publicExponent: 65537 });
const recipient = generateKeyPairSync("rsa", { modulusLength: 3072, publicExponent: 65537 });
const signer = generateKeyPairSync("ed25519");
const otherSigner = generateKeyPairSync("ed25519");
const master = randomBytes(32);
const binding: RecoveryKeyBinding = {
	companyId: randomUUID(),
	computeIdentityId: randomUUID(),
	authorityId: randomUUID(),
	revision: 1,
	policySha256: "a".repeat(64),
	keySha256: recoveryDigest(master),
	wrappingKeySha256: recoveryPublicKeyDigest(authority.publicKey),
};
const now = Date.parse("2026-08-28T10:00:00.000Z");
const wrapped = wrapRecoveryKey(master, binding, authority.publicKey);
const backup = signRecoveryBackup(binding, wrapped, signer.privateKey);
const backupBytes = Buffer.from(JSON.stringify(backup));
const releaseBinding: RecoveryReleaseBinding = {
	key: binding,
	recoveryId: randomUUID(),
	targetId: randomUUID(),
	epoch: 1,
	backupSha256: recoveryDigest(backupBytes),
	recipientKeySha256: recoveryPublicKeyDigest(recipient.publicKey),
	issuedAt: new Date(now).toISOString(),
	expiresAt: new Date(now + 60_000).toISOString(),
};
const release = sealRecoveryRelease(master, releaseBinding, recipient.publicKey, signer.privateKey);
const releaseBytes = Buffer.from(JSON.stringify(release));
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("cloud identity recovery cryptography", () => {
	it("verifies a signed backup and restores the same key only to the registered recipient", () => {
		expect(verifyRecoveryBackup(backupBytes, binding, signer.publicKey)).toEqual(backup);
		const recovered = unwrapRecoveryKey(wrapped, binding, authority.privateKey);
		expect(recovered).toEqual(master);
		recovered.fill(0);
		const restored = openRecoveryRelease(releaseBytes, releaseBinding, recipient.privateKey, signer.publicKey, now);
		expect(restored).toEqual(master);
		restored.fill(0);
		expect(backupBytes.includes(master)).toBe(false);
		expect(releaseBytes.includes(master)).toBe(false);
		expect(backupBytes.includes(master.toString("base64url"))).toBe(false);
	});

	it.each(["companyId", "computeIdentityId", "authorityId"] as const)("rejects another %s", (field) => {
		const changed = { ...binding, [field]: randomUUID() };
		expect(() => verifyRecoveryBackup(backupBytes, changed, signer.publicKey)).toThrow("authority differs");
		expect(() => unwrapRecoveryKey(wrapped, changed, authority.privateKey)).toThrow("decryption rejected");
	});

	it.each(["policySha256", "keySha256", "wrappingKeySha256"] as const)("rejects changed %s", (field) => {
		const changed = { ...binding, [field]: "b".repeat(64) };
		expect(() => verifyRecoveryBackup(backupBytes, changed, signer.publicKey)).toThrow();
		expect(() => unwrapRecoveryKey(wrapped, changed, authority.privateKey)).toThrow();
	});

	it("rejects rollback and a forged signature", () => {
		expect(() => verifyRecoveryBackup(backupBytes, { ...binding, revision: 2 }, signer.publicKey)).toThrow();
		expect(() => verifyRecoveryBackup(backupBytes, binding, otherSigner.publicKey)).toThrow("signature rejected");
		const forged = Buffer.from(JSON.stringify({ ...backup, wrappedKey: Buffer.alloc(384).toString("base64url") }));
		expect(() => verifyRecoveryBackup(forged, binding, signer.publicKey)).toThrow("signature rejected");
	});

	it.each(["recoveryId", "targetId"] as const)("rejects a release for another %s", (field) => {
		expect(() =>
			openRecoveryRelease(
				releaseBytes,
				{ ...releaseBinding, [field]: randomUUID() },
				recipient.privateKey,
				signer.publicKey,
				now,
			),
		).toThrow("authority differs");
	});

	it("rejects wrong epochs, recipients and signing authorities", () => {
		expect(() =>
			openRecoveryRelease(
				releaseBytes,
				{ ...releaseBinding, epoch: 2 },
				recipient.privateKey,
				signer.publicKey,
				now,
			),
		).toThrow();
		expect(() =>
			openRecoveryRelease(releaseBytes, releaseBinding, authority.privateKey, signer.publicKey, now),
		).toThrow();
		expect(() =>
			openRecoveryRelease(releaseBytes, releaseBinding, recipient.privateKey, otherSigner.publicKey, now),
		).toThrow("signature rejected");
	});

	it.each([now - 1, now + 60_000, Number.NaN])("rejects an invalid release clock %s", (clock) => {
		expect(() =>
			openRecoveryRelease(releaseBytes, releaseBinding, recipient.privateKey, signer.publicKey, clock),
		).toThrow();
	});

	it("separates backup and release encryption domains even under the same RSA key", () => {
		const sameRecipient = { ...releaseBinding, recipientKeySha256: binding.wrappingKeySha256 };
		const sameKeyRelease = sealRecoveryRelease(master, sameRecipient, authority.publicKey, signer.privateKey);
		expect(() => unwrapRecoveryKey(sameKeyRelease.wrappedKey, binding, authority.privateKey)).toThrow();
	});

	it("rejects noncanonical fields, encodings, revisions and timestamps", () => {
		expect(() => parseRecoveryKeyBinding({ ...binding, canRestore: true })).toThrow();
		for (const revision of [0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1, "1", null])
			expect(() => parseRecoveryKeyBinding({ ...binding, revision })).toThrow();
		expect(() =>
			parseRecoveryReleaseBinding({ ...releaseBinding, expiresAt: new Date(now + 60_001).toISOString() }),
		).toThrow();
		expect(() => parseRecoveryReleaseBinding({ ...releaseBinding, issuedAt: "2026-08-28T10:00:00Z" })).toThrow();
		expect(() => signRecoveryBackup(binding, `${wrapped}=`, signer.privateKey)).toThrow();
		expect(() =>
			verifyRecoveryBackup(
				Buffer.from(JSON.stringify({ ...backup, signature: `${backup.signature}=` })),
				binding,
				signer.publicKey,
			),
		).toThrow();
		expect(() => verifyRecoveryBackup(Buffer.alloc(16_385), binding, signer.publicKey)).toThrow();
	});

	it("accepts only canonical SPKI public keys of the pinned algorithms", () => {
		const encoded = recoveryPublicKeyText(authority.publicKey);
		expect(recoveryPublicKeyText(recoveryPublicKey(encoded, "rsa"))).toBe(encoded);
		expect(() => recoveryPublicKey(encoded, "ed25519")).toThrow();
		expect(() => recoveryPublicKey(`${encoded}=`, "rsa")).toThrow();
		const weak = generateKeyPairSync("rsa", { modulusLength: 2048 });
		expect(() => recoveryPublicKey(recoveryPublicKeyText(weak.publicKey), "rsa")).toThrow();
		const privateText = authority.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url");
		expect(() => recoveryPublicKey(privateText, "rsa")).toThrow();
		const restored = createPrivateKey({ key: Buffer.from(privateText, "base64url"), format: "der", type: "pkcs8" });
		expect(recoveryPublicKeyDigest(restored)).toBe(binding.wrappingKeySha256);
	});

	it("decrypts an existing native credential capsule after replacement-key delivery", async () => {
		const root = await mkdtemp(join(tmpdir(), "qorpera-recovery-capsule-"));
		roots.push(root);
		const source = join(root, "source");
		const target = join(root, "replacement");
		await mkdir(join(source, "codex"), { recursive: true, mode: 0o700 });
		await mkdir(target, { mode: 0o700 });
		await writeFile(join(source, "codex", "auth.json"), '{"synthetic":true}\n', { mode: 0o600 });
		const capsuleId = randomUUID();
		const capsule = await sealNativeCredentialCapsule(source, master.toString("base64url"), capsuleId);
		const restored = openRecoveryRelease(releaseBytes, releaseBinding, recipient.privateKey, signer.publicKey, now);
		try {
			await openNativeCredentialCapsule(capsule, target, restored.toString("base64url"), capsuleId);
			expect(await readFile(join(target, "codex", "auth.json"), "utf8")).toBe('{"synthetic":true}\n');
		} finally {
			restored.fill(0);
		}
	});
});
