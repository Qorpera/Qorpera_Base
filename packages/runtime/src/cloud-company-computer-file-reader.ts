import { constants } from "node:fs";
import { type FileHandle, open, readFile, realpath } from "node:fs/promises";
import { CLOUD_FILE_TRANSFER_MAX_BYTES, parseWorkbenchFilePath } from "@qorpera/cloud-client/cloud-file-transfer";

/** Broker-only read below an already admitted, mount-checked workbench handle.
 * No shell, symlinks, alternate mounts, hard links, devices or unbounded reads.
 * The caller owns the root and must retain the physical call until it settles. */
export async function readCompanyComputerWorkbenchFile(
	root: FileHandle,
	value: string,
	signal: AbortSignal,
): Promise<Uint8Array> {
	const path = parseWorkbenchFilePath(value);
	if (process.platform !== "linux" || !process.getuid?.() || process.getuid() !== process.geteuid?.())
		throw new Error("UNPRIVILEGED_LINUX_OFFICE_REQUIRED");
	const uid = BigInt(process.getuid());
	const fdPath = (file: FileHandle) => `/proc/self/fd/${file.fd}`;
	const rootPath = await realpath(fdPath(root));
	const mount = async (file: FileHandle) => {
		const text = await readFile(`/proc/self/fdinfo/${file.fd}`, "utf8");
		const id = /^mnt_id:\s+(\d+)$/m.exec(text)?.[1];
		if (!id || text.length > 4096) throw new Error("WORKBENCH_FILE_MOUNT_UNAVAILABLE");
		return id;
	};
	const mountId = await mount(root),
		rootInfo = await root.stat({ bigint: true });
	const parents: Array<{ file: FileHandle; path: string }> = [{ file: root, path: rootPath }];
	let file: FileHandle | undefined;
	const closeFiles = async () => {
		const results = await Promise.allSettled([file?.close(), ...parents.slice(1).map(({ file }) => file.close())]);
		const failed = results.find((result) => result.status === "rejected");
		if (failed?.status === "rejected") throw failed.reason;
	};
	const checkParent = async (entry: (typeof parents)[number]) => {
		const info = await entry.file.stat({ bigint: true });
		if (
			!info.isDirectory() ||
			info.uid !== uid ||
			info.dev !== rootInfo.dev ||
			(info.mode & 0o6022n) !== 0n ||
			(await realpath(fdPath(entry.file))) !== entry.path ||
			(await mount(entry.file)) !== mountId
		)
			throw new Error("WORKBENCH_FILE_SCOPE_CHANGED");
	};
	try {
		const parts = path.split("/");
		for (const part of parts.slice(0, -1)) {
			signal.throwIfAborted();
			const parent = parents.at(-1)!;
			await checkParent(parent);
			const child = await open(
				`${fdPath(parent.file)}/${part}`,
				constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
			);
			parents.push({ file: child, path: `${parent.path}/${part}` });
		}
		const parent = parents.at(-1)!;
		await checkParent(parent);
		signal.throwIfAborted();
		// O_NONBLOCK keeps FIFO/device substitutions from blocking before fstat.
		file = await open(
			`${fdPath(parent.file)}/${parts.at(-1)!}`,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		const before = await file.stat({ bigint: true });
		if (
			!before.isFile() ||
			before.uid !== uid ||
			before.nlink !== 1n ||
			before.dev !== rootInfo.dev ||
			(before.mode & 0o6022n) !== 0n ||
			before.size < 0n ||
			before.size > BigInt(CLOUD_FILE_TRANSFER_MAX_BYTES) ||
			(await mount(file)) !== mountId ||
			(await realpath(fdPath(file))) !== `${rootPath}/${path}`
		)
			throw new Error("INVALID_WORKBENCH_FILE");
		const bytes = new Uint8Array(Number(before.size));
		let offset = 0;
		while (offset < bytes.length) {
			signal.throwIfAborted();
			const { bytesRead } = await file.read(bytes, offset, Math.min(65536, bytes.length - offset), offset);
			if (bytesRead === 0) throw new Error("WORKBENCH_FILE_CHANGED");
			offset += bytesRead;
		}
		const after = await file.stat({ bigint: true });
		if (
			after.ino !== before.ino ||
			after.dev !== before.dev ||
			after.size !== before.size ||
			after.nlink !== 1n ||
			after.mode !== before.mode ||
			after.uid !== before.uid ||
			after.mtimeNs !== before.mtimeNs ||
			after.ctimeNs !== before.ctimeNs ||
			(await realpath(fdPath(file))) !== `${rootPath}/${path}` ||
			(await mount(file)) !== mountId
		)
			throw new Error("WORKBENCH_FILE_CHANGED");
		for (const entry of parents) await checkParent(entry);
		signal.throwIfAborted();
		return bytes;
	} finally {
		await closeFiles();
	}
}
