import { chmod, lstat, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

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
