import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	recoveryDigest, recoveryPossessionProof, recoveryPublicKeyDigest, sealRecoveryRelease,
} from "../packages/shell/src/cloud-identity-recovery-crypto.ts";
import {
	assertIdentityRecoveryMarker, identityRecoveryEpochFilename, restoreNativeIdentityKey,
} from "../packages/shell/src/cloud-identity-recovery-guest.ts";
import { FileRecoveryObjectStore } from "../packages/shell/src/cloud-identity-recovery-store.ts";
import { openRecoveryFilesystems, parseRecoveryDirectoryMount } from "../packages/shell/src/cloud-identity-recovery-filesystems.ts";
import { openNativeCredentialCapsule, sealNativeCredentialCapsule } from "../packages/shell/src/cloud-native-provider-host.ts";

if (process.platform !== "linux") throw new Error("This synthetic filesystem probe requires Linux");
const root = await mkdtemp(join(tmpdir(), "qorpera-recovery-linux-"));
const key = randomBytes(32);
try {
	for (const name of ["journal", "identity", "original", "decrypted"])
		await mkdir(join(root, name), { mode: 0o700 });
	const directory = await open(join(root, "journal"), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		const mount = parseRecoveryDirectoryMount(
			await readFile("/proc/self/mountinfo", "utf8"),
			await readFile(join("/proc/self/fdinfo", String(directory.fd)), "utf8"),
		);
		assert.ok(mount.mountPoint.startsWith("/"));
		assert.ok(mount.filesystem);
	} finally {
		await directory.close();
	}
	await assert.rejects(openRecoveryFilesystems({
		journalRoot: join(root, "journal"), journalMountPoint: join(root, "journal"),
		nasRoot: join(root, "unmounted-nas", "objects"), nasMountPoint: join(root, "unmounted-nas"),
		nasSource: "192.0.2.90:/synthetic-recovery",
	}), /persistent local filesystem/);
	const signal = AbortSignal.timeout(30_000);
	const address = "a".repeat(64);
	const candidates = [Buffer.from("candidate-one"), Buffer.from("candidate-two")];
	const winners = await Promise.all(candidates.map((bytes) =>
		new FileRecoveryObjectStore(join(root, "journal")).put(address, bytes, signal)));
	assert.deepEqual(winners[0], winners[1]);
	assert.ok(candidates.some((bytes) => bytes.equals(Buffer.from(winners[0]))));
	await symlink(join(root, "journal", address), join(root, "journal", "b".repeat(64)));
	await assert.rejects(new FileRecoveryObjectStore(join(root, "journal")).get("b".repeat(64), signal));
	await chmod(join(root, "journal"), 0o755);
	await assert.rejects(new FileRecoveryObjectStore(join(root, "journal")).get(address, signal), /private/);
	const signer = generateKeyPairSync("ed25519");
	const recipient = generateKeyPairSync("rsa", { modulusLength: 3072 });
	const issuedAt = Date.now();
	const binding = {
		key: {
			companyId: randomUUID(), computeIdentityId: randomUUID(), authorityId: randomUUID(),
			revision: 1, policySha256: "c".repeat(64), keySha256: recoveryDigest(key), wrappingKeySha256: "d".repeat(64),
		},
		recoveryId: randomUUID(), targetId: randomUUID(), epoch: 1, backupSha256: "e".repeat(64),
		recipientKeySha256: recoveryPublicKeyDigest(recipient.publicKey),
		issuedAt: new Date(issuedAt).toISOString(), expiresAt: new Date(issuedAt + 30_000).toISOString(),
	};
	const release = Buffer.from(JSON.stringify(sealRecoveryRelease(key, binding, recipient.publicKey, signer.privateKey)));
	const receipt = {
		recoveryId: binding.recoveryId, companyId: binding.key.companyId, computeIdentityId: binding.key.computeIdentityId,
		targetId: binding.targetId, backupRevision: 1, storageSource: "nas", status: "completed", epoch: 1,
		notBefore: binding.issuedAt, expiresAt: binding.expiresAt, receiptId: randomUUID(),
	};
	let releases = 0;
	let completions = 0;
	const transport = {
		async post(path, body) {
			assert.equal(body.recoveryId, binding.recoveryId);
			if (path === "release") { releases++; return { release: release.toString("base64url") }; }
			assert.equal(path, "complete");
			assert.equal(body.releaseSha256, recoveryDigest(release));
			assert.equal(body.proof, recoveryPossessionProof(key, binding.recoveryId, recoveryDigest(release)).toString("base64url"));
			if (++completions === 1) throw new Error("Synthetic lost acknowledgement");
			return receipt;
		},
	};
	const options = {
		directory: join(root, "identity"), companyId: binding.key.companyId, computeIdentityId: binding.key.computeIdentityId,
		authorityId: binding.key.authorityId, recoveryId: binding.recoveryId, targetId: binding.targetId, epoch: 1,
		backupSha256: binding.backupSha256, recipientKey: recipient.privateKey, signingKey: signer.publicKey,
		targetCapability: randomBytes(32).toString("base64url"), transport, signal,
	};
	await assert.rejects(restoreNativeIdentityKey(options), /Synthetic lost acknowledgement/);
	assert.deepEqual(await restoreNativeIdentityKey(options), receipt);
	assert.deepEqual(await restoreNativeIdentityKey(options), receipt);
	assert.equal(releases, 1);
	assert.equal(completions, 3);
	const restored = (await readFile(join(options.directory, "qorpera-native-provider-master-key"), "utf8")).trim();
	assert.equal(restored, key.toString("base64url"));
	const marker = JSON.parse(await readFile(join(options.directory, identityRecoveryEpochFilename(1)), "utf8"));
	const state = {
		companyId: binding.key.companyId, computeIdentityId: binding.key.computeIdentityId, epoch: 1,
		blocked: false, policySha256: binding.key.policySha256, keySha256: binding.key.keySha256,
		canInitialize: false, recoveryConfiguration: null,
	};
	assertIdentityRecoveryMarker(marker, state);
	assert.throws(() => assertIdentityRecoveryMarker(marker, { ...state, epoch: 2 }), /generation/);
	await mkdir(join(root, "original", "codex"), { mode: 0o700 });
	await writeFile(join(root, "original", "codex", "auth.json"), '{"syntheticCredential":true}', { mode: 0o600 });
	const capsuleId = randomUUID();
	const capsule = await sealNativeCredentialCapsule(join(root, "original"), key.toString("base64url"), capsuleId);
	await openNativeCredentialCapsule(capsule, join(root, "decrypted"), restored, capsuleId);
	assert.equal(await readFile(join(root, "decrypted", "codex", "auth.json"), "utf8"), '{"syntheticCredential":true}');
	console.log(JSON.stringify({
		schema: "qorpera.identity-recovery-linux-proof/v1", platform: process.platform, arch: process.arch,
		node: process.version, uid: process.geteuid(), synthetic: true, descriptorAnchoredStore: true,
		concurrentImmutablePublication: true, symlinkDenied: true, publicPermissionsDenied: true,
		descriptorMountIdentity: true, missingDedicatedJournalDenied: true,
		guestLostAckReplay: true, nativeCapsuleDecrypted: true, oldGenerationDenied: true, realProviderCalls: false,
	}));
} finally {
	key.fill(0);
	await rm(root, { recursive: true, force: true });
}
