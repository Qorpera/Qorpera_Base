import { constants } from "node:fs";
import { type FileHandle, open, readlink, realpath } from "node:fs/promises";
import { type CompanyComputerPreparationRequest, companyComputerPreparationAdoptionReceipt } from "@qorpera/contracts";
import { assertCompanyComputerWorkbenchMount } from "./cloud-company-computer-linux-host.ts";

/** Root-only metadata custody for an already adopted workbench. Retains every
 * directory descriptor through receipt publication. Never enumerates, reads,
 * copies, deletes or compares mutable working files with their old inventory. */
export async function openCompanyComputerRetainedWorkbench(
	original: CompanyComputerPreparationRequest,
	signal: AbortSignal,
) {
	if (
		process.platform !== "linux" ||
		process.getuid?.() !== 0 ||
		process.geteuid?.() !== 0 ||
		process.getgid?.() !== 0 ||
		process.getegid?.() !== 0
	)
		throw new Error("OFFICE_RETAINED_WORKBENCH_ROOT_REQUIRED");
	const receipt = companyComputerPreparationAdoptionReceipt(original),
		roots = Object.values(receipt.layout);
	const handles: Array<{ path: string; handle: FileHandle; leaf: boolean; dev: bigint; ino: bigint }> = [];
	const O_PATH = 0x200000;
	const namespace = async () => {
		signal.throwIfAborted();
		if ((await readlink("/proc/self/ns/mnt")) !== (await readlink("/proc/1/ns/mnt")))
			throw new Error("office mount namespace changed");
	};
	const verifyDirectory = async (item: (typeof handles)[number]) => {
		signal.throwIfAborted();
		const stat = await item.handle.stat({ bigint: true });
		if (
			!stat.isDirectory() ||
			stat.dev !== item.dev ||
			stat.ino !== item.ino ||
			(stat.mode & 0o6022n) !== 0n ||
			(item.leaf
				? stat.uid !== BigInt(original.uid) || stat.gid !== BigInt(original.gid) || (stat.mode & 0o777n) !== 0o700n
				: stat.uid === 0n
					? stat.gid !== 0n
					: stat.uid !== BigInt(original.uid) ||
						stat.gid !== BigInt(original.gid) ||
						(stat.mode & 0o777n) !== 0o700n) ||
			(await realpath(`/proc/self/fd/${item.handle.fd}`)) !== item.path ||
			(await realpath(item.path)) !== item.path
		)
			throw new Error("retained directory custody changed");
		const named = await open(item.path, O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		try {
			const current = await named.stat({ bigint: true });
			if (current.dev !== item.dev || current.ino !== item.ino) throw new Error("retained directory replaced");
		} finally {
			await named.close();
		}
	};
	const close = async () => {
		const results = await Promise.allSettled(
			handles
				.splice(0)
				.reverse()
				.map((item) => item.handle.close()),
		);
		for (const result of results) if (result.status === "rejected") throw result.reason;
	};
	const retain = async (path: string, handle: FileHandle, leaf: boolean) => {
		try {
			const stat = await handle.stat({ bigint: true });
			const item = { path, handle, leaf, dev: stat.dev, ino: stat.ino };
			handles.push(item);
			return item;
		} catch (error) {
			await handle.close();
			throw error;
		}
	};
	try {
		await namespace();
		for (const root of roots) {
			let parent = await retain("/", await open("/", O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW), false);
			for (const part of root.slice(1).split("/")) {
				await verifyDirectory(parent);
				const path = `${parent.path === "/" ? "" : parent.path}/${part}`,
					handle = await open(
						`/proc/self/fd/${parent.handle.fd}/${part}`,
						O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW,
					);
				parent = await retain(path, handle, path === root);
			}
			await verifyDirectory(parent);
		}
		const verify = async () => {
			await namespace();
			for (const item of handles) {
				await verifyDirectory(item);
				if (item.leaf) await assertCompanyComputerWorkbenchMount(item.handle, original.workbenchMount, roots);
			}
			await namespace();
		};
		await verify();
		return { verify, close };
	} catch (error) {
		await close();
		throw error;
	}
}
