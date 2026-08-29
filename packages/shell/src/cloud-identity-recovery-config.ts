import { createPrivateKey, type KeyObject } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { recoveryPublicKey, recoveryPublicKeyText } from "./cloud-identity-recovery-crypto.ts";
import { systemdCredentialMetadataIsSafe } from "./systemd-credential.ts";

export async function readRecoveryCredential(directory: string, name: string): Promise<string> {
	if (!isAbsolute(directory) || !/^[a-z][a-z0-9-]+$/.test(name))
		throw new Error("Recovery credential path is invalid");
	const handle = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const info = await handle.stat();
		if (
			info.size < 1 ||
			!systemdCredentialMetadataIsSafe(
				{
					isFile: info.isFile(),
					size: info.size,
					uid: info.uid,
					gid: info.gid,
					mode: info.mode,
				},
				process.geteuid?.(),
				16_384,
				"linux",
			)
		)
			throw new Error("Recovery credential ownership, permissions or size is unsafe");
		const bytes = Buffer.alloc(16_385);
		const read = await handle.read(bytes, 0, bytes.byteLength, 0);
		if (read.bytesRead !== info.size || read.bytesRead > 16_384)
			throw new Error("Recovery credential changed during read");
		return new TextDecoder("utf8", { fatal: true }).decode(bytes.subarray(0, read.bytesRead)).trim();
	} finally {
		await handle.close();
	}
}

export function parseRecoveryPrivateKey(encoded: string, algorithm: "rsa" | "ed25519"): KeyObject {
	if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length > 8192)
		throw new Error("Recovery private key encoding is invalid");
	const bytes = Buffer.from(encoded, "base64url");
	try {
		if (bytes.toString("base64url") !== encoded) throw new Error("Recovery private key encoding is noncanonical");
		const key = createPrivateKey({ key: bytes, type: "pkcs8", format: "der" });
		recoveryPublicKey(recoveryPublicKeyText(key), algorithm);
		return key;
	} finally {
		bytes.fill(0);
	}
}
