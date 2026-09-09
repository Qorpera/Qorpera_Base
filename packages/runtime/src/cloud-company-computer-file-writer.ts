import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, link, mkdtemp, open, readFile, realpath, rm, unlink } from "node:fs/promises";
import { CLOUD_FILE_TRANSFER_MAX_BYTES, parseWorkbenchFilePath } from "@qorpera/cloud-client/cloud-file-transfer";
import { readCompanyComputerWorkbenchFile } from "./cloud-company-computer-file-reader.ts";

/** Import under an already admitted workbench handle. stagingRoot MUST be the
 * broker-only screen-state parent, never a directory mounted into commands,
 * desktops or browsers. Both handles stay caller-owned on the same pinned mount.
 * Private staging permits an atomic hard-link publication without exposing a
 * replaceable source name. The destination is never overwritten or rolled back.
 * A concurrent workspace edit may invalidate completion and retain an unknown
 * effect; it cannot cause cleanup to delete the public destination. */
export async function writeCompanyComputerWorkbenchFile(
	root: FileHandle,
	stagingRoot: FileHandle,
	input: { path: string; bytes: Uint8Array; sha256: string },
	signal: AbortSignal,
): Promise<{ path: string; bytes: number; sha256: string }> {
	const path = parseWorkbenchFilePath(input.path),
		bytes = Uint8Array.from(input.bytes),
		sha256 = input.sha256;
	if (
		bytes.length > CLOUD_FILE_TRANSFER_MAX_BYTES ||
		!/^[a-f0-9]{64}$/.test(sha256) ||
		createHash("sha256").update(bytes).digest("hex") !== sha256
	)
		throw new Error("INVALID_WORKBENCH_IMPORT_BYTES");
	if (process.platform !== "linux" || !process.getuid?.() || process.getuid() !== process.geteuid?.())
		throw new Error("UNPRIVILEGED_LINUX_OFFICE_REQUIRED");
	const uid = BigInt(process.getuid()),
		fdPath = (file: FileHandle) => `/proc/self/fd/${file.fd}`;
	const rootPath = await realpath(fdPath(root)),
		stagingPath = await realpath(fdPath(stagingRoot));
	if (stagingPath === rootPath || stagingPath.startsWith(`${rootPath}/`) || rootPath.startsWith(`${stagingPath}/`))
		throw new Error("UNSAFE_WORKBENCH_IMPORT_STAGING");
	const mount = async (file: FileHandle) => {
		const text = await readFile(`/proc/self/fdinfo/${file.fd}`, "utf8"),
			id = /^mnt_id:\s+(\d+)$/m.exec(text)?.[1];
		if (!id || text.length > 4096) throw new Error("WORKBENCH_FILE_MOUNT_UNAVAILABLE");
		return id;
	};
	const mountId = await mount(root),
		rootInfo = await root.stat({ bigint: true });
	const parents: Array<{ file: FileHandle; path: string }> = [{ file: root, path: rootPath }];
	let temporary: string | undefined, source: FileHandle | undefined;
	const closeFiles = async () => {
		const closed = await Promise.allSettled([
			source?.close(),
			...parents.slice(1).map(({ file }) => file.close()),
			temporary ? rm(temporary, { recursive: true, force: false }) : undefined,
		]);
		const failed = closed.find((entry) => entry.status === "rejected");
		if (failed?.status === "rejected") throw failed.reason;
	};
	const check = async (entry: (typeof parents)[number], privateMode = false) => {
		const info = await entry.file.stat({ bigint: true });
		if (
			!info.isDirectory() ||
			info.uid !== uid ||
			info.dev !== rootInfo.dev ||
			(info.mode & (privateMode ? 0o6077n : 0o6022n)) !== 0n ||
			(await realpath(fdPath(entry.file))) !== entry.path ||
			(await mount(entry.file)) !== mountId
		)
			throw new Error("WORKBENCH_FILE_SCOPE_CHANGED");
	};
	try {
		signal.throwIfAborted();
		await check(parents[0]);
		await check({ file: stagingRoot, path: stagingPath }, true);
		const parts = path.split("/");
		for (const component of parts.slice(0, -1)) {
			signal.throwIfAborted();
			const parent = parents.at(-1)!;
			await check(parent);
			parents.push({
				file: await open(
					`${fdPath(parent.file)}/${component}`,
					constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
				),
				path: `${parent.path}/${component}`,
			});
		}
		const parent = parents.at(-1)!;
		await check(parent);
		// The complete screen-state parent is never mounted in untrusted work.
		// Only each pre-adopted UUID child is mounted by the desktop launcher.
		temporary = await mkdtemp(`${fdPath(stagingRoot)}/.qorpera-import-`);
		const sourcePath = `${temporary}/content`;
		source = await open(
			sourcePath,
			constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		let offset = 0;
		while (offset < bytes.length) {
			signal.throwIfAborted();
			const written = await source.write(bytes, offset, Math.min(65536, bytes.length - offset), offset);
			if (!written.bytesWritten) throw new Error("WORKBENCH_IMPORT_WRITE_FAILED");
			offset += written.bytesWritten;
		}
		await source.sync();
		const info = await source.stat({ bigint: true });
		if (
			!info.isFile() ||
			info.nlink !== 1n ||
			info.uid !== uid ||
			info.dev !== rootInfo.dev ||
			info.size !== BigInt(bytes.length) ||
			(info.mode & 0o6077n) !== 0n ||
			(await mount(source)) !== mountId
		)
			throw new Error("WORKBENCH_IMPORT_STAGING_CHANGED");
		await check({ file: stagingRoot, path: stagingPath }, true);
		for (const entry of parents) await check(entry);
		signal.throwIfAborted();
		// link() is no-replace, including existing symlinks and directories. The
		// source name is broker-private; the target parent is the checked inode.
		await link(sourcePath, `${fdPath(parent.file)}/${parts.at(-1)!}`);
		await unlink(sourcePath);
		await parent.file.sync();
		for (const entry of parents) await check(entry);
		const actual = await readCompanyComputerWorkbenchFile(root, path, signal);
		if (actual.length !== bytes.length || createHash("sha256").update(actual).digest("hex") !== sha256)
			throw new Error("WORKBENCH_IMPORT_CHANGED");
		signal.throwIfAborted();
		return { path, bytes: bytes.length, sha256 };
	} finally {
		await closeFiles();
	}
}
