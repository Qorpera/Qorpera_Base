import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { systemdCredentialMetadataIsSafe } from "./systemd-credential.ts";

export const COMPANY_COMPUTER_SERVICE_CREDENTIALS = Object.freeze({
	"qorpera-office-config": 16384,
	"qorpera-office-registry": 8192,
	"qorpera-office-native": 128,
	"qorpera-office-objects": 128,
	"qorpera-office-tls-cert": 65536,
	"qorpera-office-tls-key": 32768,
});

/** Read-only systemd files, through an opened descriptor, with immutable root
 * ancestors. No environment fallback, symlink, FIFO, hardlink or partial read. */
export async function readCompanyComputerServiceCredential(
	directory: string,
	name: keyof typeof COMPANY_COMPUTER_SERVICE_CREDENTIALS,
): Promise<Buffer> {
	let bytes: Buffer | undefined;
	try {
		if (
			!Object.hasOwn(COMPANY_COMPUTER_SERVICE_CREDENTIALS, name) ||
			directory === "/" ||
			directory !== resolve(directory) ||
			/[\x00-\x20\x7f\\]/.test(directory) ||
			(await realpath(directory)) !== directory
		)
			throw new Error("path");
		let parent = directory;
		while (true) {
			const info = await lstat(parent);
			const leaf = parent === directory;
			if (
				!info.isDirectory() ||
				info.isSymbolicLink() ||
				(leaf
					? ![0, process.geteuid?.()].includes(info.uid) || (info.mode & 0o222) !== 0
					: info.uid !== 0 || (info.mode & 0o022) !== 0)
			)
				throw new Error("directory");
			if (parent === "/") break;
			parent = dirname(parent);
		}
		const maximum = COMPANY_COMPUTER_SERVICE_CREDENTIALS[name];
		const handle = await open(
			join(directory, name),
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		try {
			const before = await handle.stat();
			if (
				before.size < 1 ||
				before.nlink !== 1 ||
				(before.mode & 0o222) !== 0 ||
				!systemdCredentialMetadataIsSafe(
					{ ...before, isFile: before.isFile() },
					process.geteuid?.(),
					maximum,
					"linux",
				)
			)
				throw new Error("metadata");
			bytes = Buffer.alloc(maximum + 1);
			let length = 0;
			while (length < bytes.length) {
				const result = await handle.read(bytes, length, bytes.length - length, null);
				if (!result.bytesRead) break;
				length += result.bytesRead;
			}
			const after = await handle.stat();
			if (
				length !== before.size ||
				length > maximum ||
				["size", "uid", "gid", "mode", "nlink", "mtimeMs", "ctimeMs"].some(
					(key) => before[key as keyof typeof before] !== after[key as keyof typeof after],
				)
			)
				throw new Error("changed");
			return Buffer.from(bytes.subarray(0, length));
		} finally {
			await handle.close();
		}
	} catch {
		throw new Error("OFFICE_SERVICE_CREDENTIAL_UNAVAILABLE");
	} finally {
		bytes?.fill(0);
	}
}
