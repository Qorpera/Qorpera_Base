import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { systemdCredentialMetadataIsSafe } from "../../packages/runtime/src/systemd-credential.ts";

/** Credential filenames are selected by reviewed service configuration only. */
export async function readCodingServiceCredential(directory: string, name: string): Promise<string> {
	if (!/^qorpera-coding-[a-z0-9-]{1,80}$/.test(name) || resolve(directory) !== directory ||
		await realpath(directory) !== directory) throw new Error("CODING_CREDENTIAL_PATH_INVALID");
	const file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
	let bytes: Buffer | undefined;
	try {
		const metadata = await file.stat();
		if (!systemdCredentialMetadataIsSafe({ ...metadata, isFile: metadata.isFile() }, process.getuid?.(), 32768) ||
			metadata.size < 1 || metadata.nlink !== 1) throw new Error("CODING_CREDENTIAL_UNSAFE");
		bytes = await file.readFile();
		if (bytes.length !== metadata.size) throw new Error("CODING_CREDENTIAL_CHANGED");
		return new TextDecoder("utf8", { fatal: true }).decode(bytes).trim();
	} finally {
		bytes?.fill(0);
		await file.close();
	}
}
