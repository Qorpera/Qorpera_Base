import { execFileSync, spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { officePhysicalPath } from "./lxd-office-physical-policy.ts";

const environment = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" };
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const metadata = (info: Awaited<ReturnType<typeof lstat>>) => [
	info.dev,
	info.ino,
	info.uid,
	info.gid,
	info.mode,
	info.nlink,
	info.size,
	info.mtimeMs,
	info.ctimeMs,
];

interface InstallTarget {
	path: string;
	bytes: Buffer;
	mode: number;
	gid: number;
}

async function parents(path: string, create = false): Promise<void> {
	const paths = [];
	// A fixed systemd mount filename contains literal backslashes (\\x2d).
	// Treat only the basename as opaque; its directory must still satisfy the
	// strict canonical physical-path contract. No filename enters a shell.
	if (join(dirname(path), basename(path)) !== path || /[\u0000-\u001f\u007f]/.test(path))
		throw new Error("OFFICE_INSTALL_PATH_UNPROTECTED");
	let current = officePhysicalPath(dirname(path));
	while (true) {
		paths.unshift(current);
		if (current === "/") break;
		current = dirname(current);
	}
	for (const part of paths) {
		try {
			await lstat(part);
		} catch (error) {
			if (!create || !missing(error)) throw error;
			await mkdir(part, { mode: 0o755 });
			await chmod(part, 0o755);
		}
		const info = await lstat(part);
		if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o6022) !== 0 || (await realpath(part)) !== part)
			throw new Error("OFFICE_INSTALL_PATH_UNPROTECTED");
	}
}

async function localDescriptor(fd: number): Promise<void> {
	const ids = [...(await readFile(`/proc/self/fdinfo/${fd}`, "utf8")).matchAll(/^mnt_id:\s+([1-9][0-9]*)$/gm)];
	const mounts = (await readFile("/proc/self/mountinfo", "utf8"))
		.split("\n")
		.filter((line) => line.split(" ", 1)[0] === ids[0]?.[1]);
	if (
		ids.length !== 1 ||
		mounts.length !== 1 ||
		!["ext4", "xfs", "btrfs", "zfs", "overlay", "tmpfs"].includes(mounts[0]!.split(" - ")[1]?.split(" ")[0] ?? "")
	)
		throw new Error("OFFICE_INSTALL_LOCAL_FILES_REQUIRED");
}

async function protectedBytes(path: string, limit: number, secret = false, allowEmpty = false): Promise<Buffer> {
	await parents(path);
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		await localDescriptor(file.fd);
		const before = await file.stat();
		if (
			!before.isFile() ||
			before.uid !== 0 ||
			before.nlink !== 1 ||
			(before.mode & 0o6022) !== 0 ||
			before.size < (allowEmpty ? 0 : 1) ||
			before.size > limit ||
			(await realpath(path)) !== path ||
			(secret && ((before.mode & 0o7777) !== 0o400 || before.gid !== 0))
		)
			throw new Error("OFFICE_INSTALL_FILE_UNPROTECTED");
		const bytes = Buffer.alloc(before.size + 1);
		let offset = 0;
		try {
			while (offset < bytes.length) {
				const got = await file.read(bytes, offset, bytes.length - offset, null);
				if (!got.bytesRead) break;
				offset += got.bytesRead;
			}
			if (
				offset !== before.size ||
				!isDeepStrictEqual(metadata(before), metadata(await file.stat())) ||
				!isDeepStrictEqual(metadata(before), metadata(await lstat(path)))
			)
				throw new Error("OFFICE_INSTALL_FILE_CHANGED");
			return bytes.subarray(0, offset);
		} catch (error) {
			bytes.fill(0);
			throw error;
		}
	} finally {
		await file.close();
	}
}

function command(file: string, args: string[], absent = false): string {
	try {
		return execFileSync(file, args, {
			encoding: "utf8",
			env: environment,
			timeout: 10000,
			maxBuffer: 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch (error) {
		if (absent && (error as { status?: number }).status === 2) return "";
		throw new Error("OFFICE_INSTALL_COMMAND_FAILED");
	}
}

async function targetExists(target: InstallTarget): Promise<boolean> {
	try {
		const bytes = await protectedBytes(target.path, target.bytes.length, false, target.bytes.length === 0);
		try {
			const info = await lstat(target.path);
			if (!bytes.equals(target.bytes) || info.gid !== target.gid || (info.mode & 0o7777) !== target.mode)
				throw new Error("OFFICE_INSTALL_EXISTING_FILES_DIFFER");
			return true;
		} finally {
			bytes.fill(0);
		}
	} catch (error) {
		if (missing(error)) return false;
		throw error;
	}
}

async function unitOverrides(names: readonly string[]): Promise<void> {
	// Inspect disk as well as the manager: a newly written drop-in may not have
	// been loaded yet. Global and dash-prefix drop-ins affect these units too.
	const paths = command("/usr/bin/systemd-analyze", ["unit-paths"]).split("\n");
	for (const name of names) {
		const expected = `/etc/systemd/system/${name}`;
		const suffix = name.slice(name.lastIndexOf("."));
		// The manager never loads a template itself (`systemctl show` refuses its name). Its instances take its
		// fragment and drop-ins, which the disk checks below cover.
		if (!name.endsWith(`@${suffix}`)) {
			const fields = Object.fromEntries(
				command("/usr/bin/systemctl", ["show", name, "--property=FragmentPath,SourcePath,DropInPaths"])
					.split("\n")
					.map((line) => {
						const at = line.indexOf("=");
						return [line.slice(0, at), line.slice(at + 1)];
					}),
			);
			if (fields.DropInPaths || fields.SourcePath || (fields.FragmentPath && fields.FragmentPath !== expected))
				throw new Error("OFFICE_INSTALL_UNIT_OVERRIDE");
		}
		const prefixes = [`${suffix.slice(1)}.d`, `${name}.d`];
		for (let i = name.indexOf("-"); i >= 0; i = name.indexOf("-", i + 1))
			prefixes.push(`${name.slice(0, i + 1)}${suffix}.d`);
		for (const directory of paths) {
			officePhysicalPath(directory);
			const fragment = join(directory, name);
			if (fragment !== expected) {
				const exists = await lstat(fragment).catch((error) => {
					if (!missing(error)) throw error;
					return undefined;
				});
				if (exists) throw new Error("OFFICE_INSTALL_UNIT_OVERRIDE");
			}
			for (const prefix of prefixes) {
				const entries = await readdir(join(directory, prefix)).catch((error) => {
					if (!missing(error)) throw error;
					return [];
				});
				if (entries.some((entry) => entry.endsWith(".conf"))) throw new Error("OFFICE_INSTALL_UNIT_OVERRIDE");
			}
		}
	}
}

export {
	parents as officeInstallParents,
	protectedBytes as readOfficeInstallFile,
	command as officeInstallCommand,
	lockFd as officeInstallLockFd,
	lockedChild as officeInstallLockedChild,
	publish as publishOfficeInstallFile,
	unitOverrides as assertOfficeInstallUnitsUnmodified,
	localDescriptor as assertOfficeInstallLocalDescriptor,
};

async function lockFd(path: string, uid: number): Promise<number> {
	const info = await lstat(path, { bigint: true });
	if (
		!info.isFile() ||
		info.uid !== BigInt(uid) ||
		info.nlink !== 1n ||
		info.size !== 0n ||
		(info.mode & 0o7777n) !== 0o600n ||
		(await realpath(path)) !== path
	)
		throw new Error("OFFICE_INSTALL_LOCK_UNPROTECTED");
	const major = ((info.dev >> 8n) & 0xfffn) | ((info.dev >> 32n) & 0xfffff000n),
		minor = (info.dev & 0xffn) | ((info.dev >> 12n) & 0xffffff00n);
	for (const encoded of await readdir("/proc/self/fd")) {
		if (!/^\d+$/.test(encoded)) continue;
		const text = await readFile(`/proc/self/fdinfo/${encoded}`, "utf8").catch(() => "");
		const match = /^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+\d+\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s+0\s+EOF$/m.exec(
			text,
		);
		if (
			match &&
			BigInt(`0x${match[1]}`) === major &&
			BigInt(`0x${match[2]}`) === minor &&
			BigInt(match[3]!) === info.ino
		)
			return Number(encoded);
	}
	throw new Error("OFFICE_INSTALL_KERNEL_LOCK_REQUIRED");
}

async function lockedChild(path: string, stage: string, spec: string, inherited?: number): Promise<void> {
	const child = spawn(
		"/usr/bin/flock",
		[
			"--exclusive",
			"--nonblock",
			"--no-fork",
			path,
			"/usr/bin/node",
			"--jitless",
			"--disable-proto=throw",
			"--disallow-code-generation-from-strings",
			process.argv[1]!,
			stage,
			"--spec",
			spec,
		],
		{
			env: environment,
			stdio:
				inherited === undefined ? ["ignore", "inherit", "inherit"] : ["ignore", "inherit", "inherit", inherited],
		},
	);
	const stop = () => child.kill("SIGTERM");
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	try {
		await new Promise<void>((resolve, reject) => {
			child.once("error", () => reject(new Error("OFFICE_INSTALL_CHILD_FAILED")));
			child.once("exit", (status) => (status === 0 ? resolve() : reject(new Error("OFFICE_INSTALL_CHILD_FAILED"))));
		});
	} finally {
		process.off("SIGTERM", stop);
		process.off("SIGINT", stop);
	}
}

async function publish(target: InstallTarget): Promise<void> {
	if (await targetExists(target)) return;
	await parents(target.path, true);
	if ((await readdir(dirname(target.path))).filter((name) => name.startsWith(".office-install-")).length >= 128)
		throw new Error("OFFICE_INSTALL_STAGING_RECOVERY_REQUIRED");
	const temporaryRoot = await mkdtemp(`${dirname(target.path)}/.office-install-`);
	const temporary = `${temporaryRoot}/file`;
	try {
		const file = await open(
			temporary,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			await file.writeFile(target.bytes);
			await file.chown(0, target.gid);
			await file.chmod(target.mode);
			await file.sync();
		} finally {
			await file.close();
		}
		// The installation mutex excludes another publisher; root-owned parents
		// exclude service users. Existing files are never replaced by installation.
		if (
			await lstat(target.path).then(
				() => true,
				(error) => {
					if (missing(error)) return false;
					throw error;
				},
			)
		)
			throw new Error("OFFICE_INSTALL_TARGET_APPEARED");
		await rename(temporary, target.path);
		const parent = await open(
			dirname(target.path),
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
		);
		try {
			await parent.sync();
		} finally {
			await parent.close();
		}
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
}
