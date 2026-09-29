import { constants } from "node:fs";
import { chmod, type FileHandle, lstat, open, readdir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { LxdHostInventoryClient, LxdHostInventoryInstance } from "./lxd-client.ts";
import { readRecord } from "./lxd-office-journal-files.ts";

/** Linux O_PATH, as in lxd-office-storage-inventory.ts: the inode, never its contents. */
const O_PATH = 0x200000;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const ADOPTION_RECORD = new RegExp(`^adoption-(?:result-)?(${UUID})\\.json$`);
const INVENTORY_RECORD = /^inventory-[0-9a-f]{64}\.json$/;
const ADOPTION_TREE = /^\.qorpera-adopt(?:ed|ion-staging)-/;
/** Deeper than any workbench; a deeper tree is held for an operator (each level holds a descriptor). */
const MAX_DEPTH = 1024;

export interface LxdOfficeWorkbenchScope {
	/** The verified NAS mount (`policy.workbench.mountPoint`). */
	readonly root: string;
	/** Its export, `server:/path`, and the server's address. */
	readonly source: string;
	readonly serverAddress: string;
	/** The workbench account: every entry must be its own. */
	readonly uid: number;
	/** This office's journal, whose adoption and inventory records name what it owns. */
	readonly journalRoot: string;
}

/** A failure named by a fixed token the lifecycle log can show. */
function failure(reason: string, cause?: unknown): Error {
	return new Error(`OFFICE_WORKBENCH_${reason}`, cause === undefined ? undefined : { cause });
}

/**
 * The top-level names under the workbench this office accounts for: its adoptions' trees and staging
 * trees (by adoption id, from its journal) and the top-level names its retained inventories saw (the
 * sources an adoption left in place). Another office's adoption tree is never among them, even if one of
 * this office's inventories saw it.
 */
export async function lxdOfficeWorkbenchNames(journalRoot: string, root: string): Promise<Set<string>> {
	const names = new Set<string>();
	const inventories: string[] = [];
	for (const name of await readdir(journalRoot)) {
		const adoption = ADOPTION_RECORD.exec(name);
		if (adoption) {
			names.add(`.qorpera-adopted-${adoption[1]}`);
			names.add(`.qorpera-adoption-staging-${adoption[1]}`);
		} else if (INVENTORY_RECORD.test(name)) inventories.push(name);
	}
	for (const name of inventories) {
		const observation = (await readRecord(join(journalRoot, name), 16 * 1024 ** 2 + 4096)).value as {
			inventory?: { root?: unknown; entries?: unknown };
		};
		const inventory = observation?.inventory;
		if (inventory?.root !== root) continue;
		if (!Array.isArray(inventory.entries)) throw failure("INVENTORY_INVALID");
		for (const entry of inventory.entries) {
			const path = (entry as { path?: unknown })?.path;
			if (typeof path !== "string") throw failure("INVENTORY_INVALID");
			const top = path.split("/")[0];
			if (top && top !== "." && !ADOPTION_TREE.test(top)) names.add(top);
		}
	}
	return names;
}

const beneath = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);
const overlaps = (a: string, b: string): boolean => beneath(a, b) || beneath(b, a);

/**
 * The workbench must be this office's alone. Refused when another LXD instance on this host has a disk at,
 * under or above the mount, or when another NFS mount on this host reaches the same export (the same
 * server, the same, an enclosing or an enclosed path). An export shared with another host cannot be seen
 * here: the provisioning rule is one export per office.
 */
export function assertLxdOfficeWorkbenchExclusive(
	scope: Pick<LxdOfficeWorkbenchScope, "root" | "source" | "serverAddress">,
	instances: readonly Pick<LxdHostInventoryInstance, "expandedDevices">[],
	mountInfo: string,
): void {
	for (const instance of instances)
		for (const device of Object.values(instance.expandedDevices))
			if (device.type === "disk" && typeof device.source === "string" && overlaps(device.source, scope.root))
				throw failure("SHARED");
	const split = scope.source.indexOf(":/");
	const server = scope.source.slice(0, split),
		exported = scope.source.slice(split + 1).replace(/\/+$/, "") || "/";
	for (const line of mountInfo.trim().split("\n")) {
		const [prefix, suffix] = line.split(" - ");
		const mountPoint = prefix?.split(" ")[4]?.replace(/\\040/g, " ");
		const [filesystem, source, superOptions] = suffix?.split(" ") ?? [];
		if (!mountPoint || !source || !filesystem?.startsWith("nfs") || mountPoint === scope.root) continue;
		const at = source.indexOf(":/");
		if (at < 0) continue;
		const sameServer =
			source.slice(0, at) === server || (superOptions ?? "").split(",").includes(`addr=${scope.serverAddress}`);
		const path = source.slice(at + 1).replace(/\/+$/, "") || "/";
		if (sameServer && (path === "/" || exported === "/" || overlaps(path, exported))) throw failure("SHARED");
	}
}

async function mountId(file: FileHandle): Promise<string> {
	const info = await readFileText(`/proc/self/fdinfo/${file.fd}`);
	const matches = [...info.matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)];
	if (matches.length !== 1) throw failure("MOUNT_UNCONFIRMED");
	return matches[0][1];
}

async function readFileText(path: string, limit = 65536): Promise<string> {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const text = await file.readFile({ encoding: "utf8" });
		if (Buffer.byteLength(text) > limit) throw failure("MOUNT_UNCONFIRMED");
		return text;
	} finally {
		await file.close();
	}
}

/**
 * Empty a deleted company's workbench (company delete D5b): the adopted desktop, screens, browser
 * profiles, working files and the sources an adoption left in place, including state an adoption
 * quarantined. The mount root stays. Linux only; the walk holds a descriptor per directory and names
 * entries through `/proc/self/fd`, so no path is resolved twice and depth is no path-length limit.
 * Every entry must be the workbench account's and on the root's mount (checked per directory by mount
 * id); a symbolic link is removed, never followed; a directory is made 0700 before it is read. A
 * top-level name this office does not account for holds the removal for an operator. A pass stops at
 * its budget and reports `done: false`; what it removed stays removed.
 */
export async function removeLxdOfficeWorkbench(
	scope: LxdOfficeWorkbenchScope,
	names: ReadonlySet<string>,
	signal: AbortSignal,
	passMs: number,
): Promise<{ done: boolean; removed: number }> {
	if (process.platform !== "linux") throw failure("LINUX_REQUIRED");
	signal.throwIfAborted();
	const deadline = performance.now() + passMs;
	let removed = 0;
	const root = await open(scope.root, O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		const top = await root.stat();
		if (!top.isDirectory() || top.uid !== scope.uid) throw failure("ROOT_DIFFERS");
		const rootMount = await mountId(root);
		const at = (directory: FileHandle, name: string) => `/proc/self/fd/${directory.fd}/${name}`;
		// false once the pass is out of time; the entry and its parents stay.
		const remove = async (parent: FileHandle, name: string, depth: number): Promise<boolean> => {
			signal.throwIfAborted();
			if (performance.now() >= deadline) return false;
			const path = at(parent, name);
			const stat = await lstat(path);
			if (stat.uid !== scope.uid || stat.dev !== top.dev) throw failure("FOREIGN_ENTRY");
			if (!stat.isDirectory()) {
				await unlink(path);
				removed++;
				return true;
			}
			if (depth > MAX_DEPTH) throw failure("TOO_DEEP");
			const directory = await open(path, O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW);
			try {
				const opened = await directory.stat();
				if (opened.ino !== stat.ino || opened.dev !== stat.dev) throw failure("CHANGED");
				if ((await mountId(directory)) !== rootMount) throw failure("FOREIGN_ENTRY");
				// Exactly 0700: a set-id bit would be refused under the unit's RestrictSUIDSGID.
				if ((opened.mode & 0o7777) !== 0o700) await chmod(`/proc/self/fd/${directory.fd}`, 0o700);
				for (const child of await readdir(`/proc/self/fd/${directory.fd}`))
					if (!(await remove(directory, child, depth + 1))) return false;
			} finally {
				await directory.close();
			}
			await rmdir(path);
			removed++;
			return true;
		};
		const listing = await readdir(`/proc/self/fd/${root.fd}`);
		if (listing.some((name) => !names.has(name))) throw failure("UNACCOUNTED_ENTRY");
		for (const name of listing.sort()) if (!(await remove(root, name, 1))) return { done: false, removed };
		// Done only when the root, still on the same mount, lists nothing.
		if ((await mountId(root)) !== rootMount || (await readdir(`/proc/self/fd/${root.fd}`)).length > 0)
			throw failure("NOT_EMPTY");
		return { done: true, removed };
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("OFFICE_WORKBENCH_")) throw error;
		if (signal.aborted) throw error;
		const reason = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "";
		throw failure(/^E[A-Z]{1,15}$/.test(reason) ? `REMOVAL_${reason}` : "REMOVAL_FAILED", error);
	} finally {
		await root.close();
	}
}

/** The provider's pass: this office's names, the exclusivity fence, then the removal. */
export async function emptyLxdOfficeWorkbench(
	scope: LxdOfficeWorkbenchScope,
	host: LxdHostInventoryClient,
	signal: AbortSignal,
	passMs: number,
): Promise<{ done: boolean; removed: number }> {
	if (process.platform !== "linux") throw failure("LINUX_REQUIRED");
	const names = await lxdOfficeWorkbenchNames(scope.journalRoot, scope.root);
	const { instances } = await host.inspectHostInventory(signal);
	assertLxdOfficeWorkbenchExclusive(scope, instances, await readFileText("/proc/self/mountinfo", 1048576));
	return removeLxdOfficeWorkbench(scope, names, signal, passMs);
}
