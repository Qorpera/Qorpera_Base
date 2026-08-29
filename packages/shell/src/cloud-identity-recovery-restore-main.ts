import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recoveryCapability } from "./cloud-identity-recovery.ts";
import { parseRecoveryPrivateKey, readRecoveryCredential } from "./cloud-identity-recovery-config.ts";
import {
	recoveryInteger,
	recoveryPublicKey,
	recoveryRecord,
	recoverySha256,
	recoveryUuid,
} from "./cloud-identity-recovery-crypto.ts";
import { HttpIdentityRecoveryGuestTransport, restoreNativeIdentityKey } from "./cloud-identity-recovery-guest.ts";

export async function runIdentityRecoveryRestoreMain(environment = process.env): Promise<void> {
	if (process.platform !== "linux" || process.geteuid?.() !== 0)
		throw new Error("Identity restoration requires the trusted cloud guest root");
	const credentials = environment.CREDENTIALS_DIRECTORY;
	if (!credentials || !isAbsolute(credentials)) throw new Error("Recovery guest requires private credentials");
	const config = recoveryRecord(JSON.parse(await readRecoveryCredential(credentials, "qorpera-recovery-restore")), [
		"schema",
		"companyId",
		"computeIdentityId",
		"authorityId",
		"recoveryId",
		"targetId",
		"epoch",
		"backupSha256",
		"serviceOrigin",
		"signingPublicKey",
	]);
	if (config.schema !== "qorpera.identity-recovery-restore/v1")
		throw new Error("Recovery restore configuration is unsupported");
	const receipt = await restoreNativeIdentityKey({
		directory: "/var/lib/qorpera/identity",
		companyId: recoveryUuid(config.companyId),
		computeIdentityId: recoveryUuid(config.computeIdentityId),
		authorityId: recoveryUuid(config.authorityId),
		recoveryId: recoveryUuid(config.recoveryId),
		targetId: recoveryUuid(config.targetId),
		epoch: recoveryInteger(config.epoch),
		backupSha256: recoverySha256(config.backupSha256),
		signingKey: recoveryPublicKey(String(config.signingPublicKey), "ed25519"),
		recipientKey: parseRecoveryPrivateKey(
			await readRecoveryCredential(credentials, "qorpera-recovery-recipient-key"),
			"rsa",
		),
		targetCapability: recoveryCapability(await readRecoveryCredential(credentials, "qorpera-recovery-target")),
		transport: new HttpIdentityRecoveryGuestTransport(String(config.serviceOrigin)),
		signal: AbortSignal.timeout(60_000),
	});
	console.log(JSON.stringify({ status: receipt.status, receiptId: receipt.receiptId, epoch: receipt.epoch }));
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
	if (process.argv.length === 3 && process.argv[2] === "--help") {
		console.log(
			"Restore an owner-approved cloud identity into the fixed private identity volume. No work is started.",
		);
	} else {
		runIdentityRecoveryRestoreMain().catch(() => {
			console.error(
				"Identity recovery was not confirmed; retain the private volume and retry the same authorized request.",
			);
			process.exitCode = 1;
		});
	}
}
