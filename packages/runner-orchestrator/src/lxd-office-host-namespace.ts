import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readlink, realpath, rename, rm } from "node:fs/promises";

export const OFFICE_HOST_NAMESPACE_RECORD = "/run/qorpera-office-provider/host-mount-namespace.json";
const directory = "/run/qorpera-office-provider";
const bootPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const namespacePattern = /^mnt:\[[1-9][0-9]{0,19}\]$/;

export function parseLxdOfficeHostNamespace(value: unknown): { bootId: string; namespace: string } {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("OFFICE_HOST_NAMESPACE_UNCONFIRMED");
	const r = value as Record<string, unknown>;
	if (
		Object.keys(r).sort().join(",") !== "bootId,namespace,schema" ||
		r.schema !== "qorpera.lxd-office-host-namespace/v1" ||
		typeof r.bootId !== "string" ||
		!bootPattern.test(r.bootId) ||
		typeof r.namespace !== "string" ||
		!namespacePattern.test(r.namespace)
	)
		throw new Error("OFFICE_HOST_NAMESPACE_UNCONFIRMED");
	return { bootId: r.bootId, namespace: r.namespace };
}

/** Fixed root startup helper. It records only PID 1's namespace and this boot;
 * the provider retains zero capabilities and never receives a namespace FD.
 */
export async function captureLxdOfficeHostNamespace(): Promise<void> {
	if (
		process.platform !== "linux" ||
		process.getuid?.() !== 0 ||
		process.geteuid?.() !== 0 ||
		process.getegid?.() !== 0
	)
		throw new Error("OFFICE_HOST_NAMESPACE_ROOT_REQUIRED");
	for (const path of ["/", "/run"]) {
		const info = await lstat(path);
		if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o6022) !== 0 || (await realpath(path)) !== path)
			throw new Error("OFFICE_HOST_NAMESPACE_PATH_UNPROTECTED");
	}
	const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
	const namespace = await readlink("/proc/1/ns/mnt");
	const record = { schema: "qorpera.lxd-office-host-namespace/v1", bootId, namespace };
	parseLxdOfficeHostNamespace(record);
	if (namespace !== (await readlink("/proc/self/ns/mnt")))
		throw new Error("OFFICE_PROVIDER_HOST_MOUNT_NAMESPACE_REQUIRED");
	try {
		await mkdir(directory, { mode: 0o755 });
		await chmod(directory, 0o755);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const info = await lstat(directory);
	if (
		!info.isDirectory() ||
		info.uid !== 0 ||
		info.gid !== 0 ||
		(info.mode & 0o7777) !== 0o755 ||
		(await realpath(directory)) !== directory
	)
		throw new Error("OFFICE_HOST_NAMESPACE_PATH_UNPROTECTED");
	try {
		const existing = await lstat(OFFICE_HOST_NAMESPACE_RECORD);
		if (
			!existing.isFile() ||
			existing.uid !== 0 ||
			existing.gid !== 0 ||
			existing.nlink !== 1 ||
			(existing.mode & 0o7777) !== 0o444
		)
			throw new Error("OFFICE_HOST_NAMESPACE_PATH_UNPROTECTED");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const temporary = await mkdtemp(`${directory}/.capture-`);
	try {
		const path = `${temporary}/record`;
		const file = await open(
			path,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o444,
		);
		try {
			await file.writeFile(`${JSON.stringify(record)}\n`);
			await file.chmod(0o444);
			await file.sync();
		} finally {
			await file.close();
		}
		if (
			namespace !== (await readlink("/proc/1/ns/mnt")) ||
			namespace !== (await readlink("/proc/self/ns/mnt")) ||
			bootId !== (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()
		)
			throw new Error("OFFICE_HOST_NAMESPACE_CHANGED");
		await rename(path, OFFICE_HOST_NAMESPACE_RECORD);
		const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		try {
			await parent.sync();
		} finally {
			await parent.close();
		}
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}
