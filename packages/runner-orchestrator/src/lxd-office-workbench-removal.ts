import { chmod, lstat, readdir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";

/** One pass's share of the retirement's 60-second window. */
const PASS_MS = 30000;

/**
 * Empty a deleted company's workbench (company delete D5b): everything under the
 * dedicated NAS workbench mount, which holds the office's adopted desktop,
 * screens, browser profiles and working files, and any sources an adoption left
 * in place. The mount root itself stays. Every entry must belong to the
 * workbench account and sit on the mount root's own filesystem; a symbolic link
 * is removed, never followed; a directory its owner cannot write is made
 * writable first. Anything else throws and holds the retirement for an operator.
 * A pass stops after 30 seconds and reports `done: false`; what it removed stays
 * removed, and the next pass continues. The caller has checked the mount and
 * that the VM is gone, so nothing else writes here.
 */
export async function removeLxdOfficeWorkbench(
	root: string,
	uid: number,
	signal: AbortSignal,
	passMs = PASS_MS,
): Promise<{ done: boolean; removed: number }> {
	signal.throwIfAborted();
	const deadline = performance.now() + passMs;
	const top = await lstat(root);
	if (!top.isDirectory() || top.uid !== uid) throw new Error("OFFICE_WORKBENCH_ROOT_DIFFERS");
	let removed = 0;
	// false once the pass is out of time; the entry and its parents stay.
	const remove = async (path: string): Promise<boolean> => {
		signal.throwIfAborted();
		if (performance.now() >= deadline) return false;
		const stat = await lstat(path);
		if (stat.dev !== top.dev || stat.uid !== uid) throw new Error("OFFICE_WORKBENCH_FOREIGN_ENTRY");
		if (stat.isDirectory()) {
			if ((stat.mode & 0o700) !== 0o700) await chmod(path, (stat.mode & 0o7777) | 0o700);
			for (const name of await readdir(path)) if (!(await remove(join(path, name)))) return false;
			await rmdir(path);
		} else await unlink(path);
		removed++;
		return true;
	};
	for (const name of await readdir(root)) if (!(await remove(join(root, name)))) return { done: false, removed };
	return { done: true, removed };
}
