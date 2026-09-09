import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";

export function code(error: unknown, expected: string): boolean {
	return error instanceof Error && "code" in error && error.code === expected;
}

export async function checkDirectory(path: string): Promise<void> {
	const stat = await lstat(path);
	if (
		!stat.isDirectory() ||
		stat.uid !== process.getuid?.() ||
		(stat.mode & 0o7777) !== 0o700 ||
		(await realpath(path)) !== path
	)
		throw new Error("LXD_OFFICE_JOURNAL_DIRECTORY_UNSAFE");
}

export async function syncDirectory(path: string): Promise<void> {
	const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

export async function readRecord(path: string, limit = 16384): Promise<{ value: unknown; bytes: Buffer }> {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16 * 1024 ** 2 + 4096)
		throw new Error("INVALID_OFFICE_JOURNAL_RECORD_LIMIT");
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = await file.stat();
		if (
			!before.isFile() ||
			before.uid !== process.getuid?.() ||
			(before.mode & 0o7777) !== 0o600 ||
			before.nlink !== 1 ||
			before.size < 1 ||
			before.size > limit
		)
			throw new Error("invalid journal record");
		const buffer = Buffer.alloc(before.size + 1);
		let size = 0;
		while (size < buffer.length) {
			const result = await file.read(buffer, size, buffer.length - size, size);
			if (result.bytesRead === 0) break;
			size += result.bytesRead;
		}
		const after = await file.stat();
		if (
			size !== before.size ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			before.ctimeMs !== after.ctimeMs ||
			before.mode !== after.mode ||
			before.uid !== after.uid ||
			before.nlink !== after.nlink
		)
			throw new Error("journal record changed");
		const bytes = buffer.subarray(0, size);
		return { bytes, value: JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)) as unknown };
	} finally {
		await file.close();
	}
}

/** Publish a complete, fsynced immutable record with an atomic no-overwrite
 * link. Concurrent providers compete for the same sequence; only its winner
 * may dispatch. No expiring lock, overwrite or stale-lock takeover exists. */
export async function publish(root: string, name: string, bytes: Buffer): Promise<boolean> {
	await checkDirectory(root);
	const temporary = join(root, `.write-${randomUUID()}`);
	const file = await open(
		temporary,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		await file.writeFile(bytes);
		await file.sync();
	} finally {
		await file.close();
	}
	let created = false;
	try {
		await link(temporary, join(root, name));
		created = true;
	} catch (error) {
		if (!code(error, "EEXIST")) throw error;
	} finally {
		await unlink(temporary);
		await syncDirectory(root);
	}
	return created;
}
