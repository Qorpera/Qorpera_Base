import { chmod, lstat, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** Where the folder program keeps the files it holds outside the company folder (`node_modules`, build output, MC3,
 * deploy/first-node/RUNTIME-FOLDER-MACHINE-CACHES.md "Where the cache lives"): on the machine's disk, never under
 * /run, which empties at every start. The trusted side that starts the program names one with `--cache-dir`:
 * - coding and test machines: one for the machine, `machine`;
 * - company machines: one for the machine's desktops, `desktop` (every desktop view has one authority, whoever holds
 *   it), and one per owner for its commands, `agent-<uuid>` or `member-<uuid>`.
 * The program takes the folder only as a real one of its own user closed to every other user, and makes none of it. */
export const FOLDER_CACHE = Object.freeze({
	root: "/var/lib/qorpera-folder/cache",
	machine: "/var/lib/qorpera-folder/cache/machine",
});

/** Makes a cache folder and the two above it (`qorpera-folder/cache/<leaf>`), each a real folder (never a link) of
 * this process's user and closed to every other user. Throws FOLDER_CACHE_DIR_UNCONFIRMED for one in another shape. */
export async function ensureFolderCacheDir(path: string): Promise<void> {
	const owner = process.geteuid?.();
	for (const folder of [dirname(dirname(path)), dirname(path), path]) {
		await mkdir(folder, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "EEXIST") throw error;
		});
		const info = await lstat(folder);
		if (!info.isDirectory() || info.uid !== owner) throw new Error("FOLDER_CACHE_DIR_UNCONFIRMED");
		await chmod(folder, 0o700);
	}
}
