import { constants } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseRecoveryDirectoryMount, type RecoveryDirectoryMount } from "./cloud-identity-recovery-filesystems.ts";

export interface CompanyComputerCommandLimits {
	memoryBytes: number;
	pids: number;
	cpuQuota: number;
	cpuPeriod: number;
}

/** Verify the broker itself cannot recover host privileges while launching an
 * untrusted command. The office systemd unit must set these kernel properties. */
export function assertCompanyComputerCommandProcess(status: string): void {
	for (const name of ["CapPrm", "CapEff", "CapBnd", "CapAmb", "NoNewPrivs"]) {
		const values = [...status.matchAll(new RegExp(`^${name}:\\s+([^\\n]+)$`, "gm"))];
		if (values.length !== 1 || !(name === "NoNewPrivs" ? /^1$/ : /^0{16}$/).test(values[0][1]))
			throw new Error("OFFICE_PROCESS_PRIVILEGES_UNSAFE");
	}
}

/** Service/VM limits are kernel-enforced, not model-provided estimates. The
 * office entrypoint supplies its admitted allocation's upper bounds. */
export function assertCompanyComputerCommandLimits(
	limits: CompanyComputerCommandLimits,
	actual: { memory: string; pids: string; cpu: string },
): void {
	if (
		Object.keys(limits).sort().join() !== "cpuPeriod,cpuQuota,memoryBytes,pids" ||
		Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1)
	)
		throw new Error("INVALID_OFFICE_COMMAND_LIMITS");
	const integer = (value: string): bigint => {
		if (!/^[1-9][0-9]*$/.test(value)) throw new Error("OFFICE_COMMAND_LIMITS_UNAVAILABLE");
		return BigInt(value);
	};
	const [quota, period, extra] = actual.cpu.trim().split(" ");
	if (
		extra !== undefined ||
		!period ||
		integer(actual.memory.trim()) > BigInt(limits.memoryBytes) ||
		integer(actual.pids.trim()) > BigInt(limits.pids) ||
		integer(quota) * BigInt(limits.cpuPeriod) > BigInt(limits.cpuQuota) * integer(period)
	)
		throw new Error("OFFICE_COMMAND_LIMITS_UNAVAILABLE");
}

export async function readCompanyComputerLinuxMetadata(path: string, limit: number): Promise<string> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const bytes = Buffer.alloc(limit + 1);
		let length = 0;
		while (length < bytes.length) {
			const read = await handle.read(bytes, length, bytes.length - length, null);
			if (!read.bytesRead) break;
			length += read.bytesRead;
		}
		if (length > limit) throw new Error("OFFICE_KERNEL_METADATA_TOO_LARGE");
		return new TextDecoder("utf8", { fatal: true }).decode(bytes.subarray(0, length));
	} finally {
		await handle.close();
	}
}

export async function assertCompanyComputerImageArtifact(path: string, directory = false): Promise<void> {
	if (path !== resolve(path) || (await realpath(path)) !== path) throw new Error("UNSAFE_OFFICE_IMAGE_ARTIFACT");
	let current = path;
	while (true) {
		const info = await lstat(current);
		if (
			info.uid !== 0 ||
			(info.mode & 0o6022) !== 0 ||
			info.isSymbolicLink() ||
			(current === path && !directory ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())
		)
			throw new Error("UNSAFE_OFFICE_IMAGE_ARTIFACT");
		if (current === "/") break;
		current = dirname(current);
	}
}

export async function assertCompanyComputerLinuxHost(
	limits: CompanyComputerCommandLimits,
	signal: AbortSignal,
): Promise<void> {
	if (process.platform !== "linux" || !process.getuid?.() || !process.geteuid?.())
		throw new Error("UNPRIVILEGED_LINUX_OFFICE_REQUIRED");
	assertCompanyComputerCommandProcess(await readCompanyComputerLinuxMetadata("/proc/self/status", 65536));
	const cgroup = await readCompanyComputerLinuxMetadata("/proc/self/cgroup", 4096);
	const match = /^0::(\/[^\n]*)\n?$/.exec(cgroup);
	if (!match || resolve(match[1]) !== match[1]) throw new Error("OFFICE_CGROUP_V2_REQUIRED");
	const root = `/sys/fs/cgroup${match[1] === "/" ? "" : match[1]}`;
	assertCompanyComputerCommandLimits(limits, {
		memory: await readCompanyComputerLinuxMetadata(`${root}/memory.max`, 128),
		pids: await readCompanyComputerLinuxMetadata(`${root}/pids.max`, 128),
		cpu: await readCompanyComputerLinuxMetadata(`${root}/cpu.max`, 128),
	});
	signal.throwIfAborted();
}

export async function openCompanyComputerLinuxDirectory(path: string, privateMode: boolean): Promise<FileHandle> {
	if (
		process.platform !== "linux" ||
		!process.getuid?.() ||
		process.getuid() !== process.geteuid?.() ||
		path !== resolve(path) ||
		path === "/" ||
		path.length > 4096 ||
		/[\x00-\x1f\x7f\\]/.test(path)
	)
		throw new Error("UNSAFE_OFFICE_DIRECTORY");
	// Adopted NAS roots are private service-owned state, not image artifacts.
	// Walk from / through pinned, non-following directory descriptors. Neither
	// arbitrary writable ancestors nor symlink traversal may substitute state.
	// Executables, bootstrap and receipts still use the root-only artifact check.
	const O_PATH = 0x200000;
	const uid = BigInt(process.getuid());
	const parents: { handle: FileHandle; path: string }[] = [];
	let result: FileHandle | undefined;
	try {
		parents.push({ handle: await open("/", O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW), path: "/" });
		const validate = async (item: (typeof parents)[number], final: boolean) => {
			const info = await item.handle.stat({ bigint: true });
			if (
				!info.isDirectory() ||
				(info.mode & 0o6022n) !== 0n ||
				(final
					? info.uid !== uid ||
						(info.mode & (privateMode ? 0o077n : 0o022n)) !== 0n ||
						(info.mode & 0o700n) !== 0o700n
					: info.uid !== 0n && (info.uid !== uid || (info.mode & 0o777n) !== 0o700n)) ||
				(await realpath(`/proc/self/fd/${item.handle.fd}`)) !== item.path
			)
				throw new Error("UNSAFE_OFFICE_DIRECTORY");
		};
		for (const component of path.slice(1).split("/")) {
			const parent = parents.at(-1)!;
			await validate(parent, false);
			parents.push({
				handle: await open(
					`/proc/self/fd/${parent.handle.fd}/${component}`,
					O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW,
				),
				path: `${parent.path === "/" ? "" : parent.path}/${component}`,
			});
		}
		const leaf = parents.at(-1)!;
		await validate(leaf, true);
		// Reopen the pinned inode as readable for callers that inspect or inherit
		// it. /proc/self/fd is the explicit trusted kernel descriptor reference.
		result = await open(
			`/proc/self/fd/${leaf.handle.fd}`,
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NONBLOCK,
		);
		const [actual, pinned] = await Promise.all([result.stat({ bigint: true }), leaf.handle.stat({ bigint: true })]);
		if (actual.dev !== pinned.dev || actual.ino !== pinned.ino) throw new Error("UNSAFE_OFFICE_DIRECTORY");
		for (const item of parents) await validate(item, item === leaf);
		return result;
	} catch (error) {
		await result?.close();
		throw error;
	} finally {
		await Promise.all(parents.map(({ handle }) => handle.close()));
	}
}

export async function assertCompanyComputerWorkbenchMount(
	directory: FileHandle,
	expected: RecoveryDirectoryMount,
	roots: readonly string[],
): Promise<void> {
	const mountInfo = await readCompanyComputerLinuxMetadata("/proc/self/mountinfo", 1_048_576);
	const mount = parseRecoveryDirectoryMount(
		mountInfo,
		await readCompanyComputerLinuxMetadata(`/proc/self/fdinfo/${directory.fd}`, 4096),
	);
	if (!isDeepStrictEqual(mount, expected)) throw new Error("OFFICE_WORKBENCH_MOUNT_CHANGED");
	for (const line of mountInfo.trim().split("\n")) {
		const point = line
			.split(" ")[4]
			?.replace(/\\(040|011|012|134)/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
		if (!point || roots.some((path) => point.startsWith(`${path}/`))) throw new Error("OFFICE_NESTED_MOUNT_DENIED");
	}
}

export function companyComputerLinuxSandboxArgs(): string[] {
	return [
		"--unshare-user",
		"--unshare-pid",
		"--unshare-net",
		"--unshare-ipc",
		"--unshare-uts",
		"--unshare-cgroup",
		"--disable-userns",
		"--assert-userns-disabled",
		"--die-with-parent",
		"--new-session",
		"--cap-drop",
		"ALL",
		"--clearenv",
		"--ro-bind",
		"/usr",
		"/usr",
		"--symlink",
		"usr/bin",
		"/bin",
		"--symlink",
		"usr/lib",
		"/lib",
		"--symlink",
		"usr/lib64",
		"/lib64",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--size",
		"67108864",
		"--tmpfs",
		"/tmp",
	];
}
