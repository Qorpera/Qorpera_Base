import { execFileSync, spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, chown, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	assertOfficeInstallationUpgrade,
	OFFICE_CONFIG_ROOT,
	OFFICE_INSTALL_ARTIFACTS,
	OFFICE_INSTALL_DOCUMENTS,
	OFFICE_INSTALL_ROOT,
	OFFICE_PROVIDER_USER,
	type OfficeInstallDocument,
	officeInstallHash,
	parseOfficeInstallationManifest,
	parseOfficeInstallationReceipt,
	parseOfficeInstallationSpec,
	validateOfficeInstallationDocuments,
} from "./lxd-office-installation.ts";
import { assertLxdOfficeHostMount } from "./lxd-office-physical-host.ts";
import { officePhysicalPath } from "./lxd-office-physical-policy.ts";

const rootLock = "/run/qorpera-office-provider-install/install.lock";
const providerUnit = "qorpera-office-provider.service",
	namespaceUnit = "qorpera-office-host-namespace.service";
const documentKeys = Object.keys(OFFICE_INSTALL_DOCUMENTS) as OfficeInstallDocument[];
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

function rootOnly(): void {
	if (
		process.platform !== "linux" ||
		process.getuid?.() !== 0 ||
		process.geteuid?.() !== 0 ||
		process.getegid?.() !== 0
	)
		throw new Error("OFFICE_INSTALL_ROOT_LINUX_REQUIRED");
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

function stopped(name: string, exited = false): void {
	const fields = Object.fromEntries(
		command("/usr/bin/systemctl", ["show", name, "--property=LoadState,ActiveState,SubState,MainPID,ControlPID,Job"])
			.split("\n")
			.map((line) => {
				const at = line.indexOf("=");
				return [line.slice(0, at), line.slice(at + 1)];
			}),
	);
	if (
		!["loaded", "not-found"].includes(fields.LoadState ?? "") ||
		fields.MainPID !== "0" ||
		fields.ControlPID !== "0" ||
		fields.Job !== "" ||
		!(
			["inactive", "failed"].includes(fields.ActiveState ?? "") ||
			(exited && fields.ActiveState === "active" && fields.SubState === "exited")
		)
	)
		throw new Error("OFFICE_INSTALL_SERVICE_NOT_STOPPED");
}

function identity(uid: number, gid: number, socketGid: number, create = false): void {
	const byName = command("/usr/bin/getent", ["passwd", OFFICE_PROVIDER_USER], true),
		byUid = command("/usr/bin/getent", ["passwd", String(uid)], true);
	const group = command("/usr/bin/getent", ["group", OFFICE_PROVIDER_USER], true),
		byGid = command("/usr/bin/getent", ["group", String(gid)], true);
	const socket = command("/usr/bin/getent", ["group", String(socketGid)], true).split(":");
	if (socket.length !== 4 || !/^[a-z_][a-z0-9_-]{0,31}$/.test(socket[0]!))
		throw new Error("OFFICE_INSTALL_SOCKET_GROUP_MISSING");
	if (byName !== byUid || group !== byGid) throw new Error("OFFICE_INSTALL_IDENTITY_CONFLICT");
	if (group) {
		const fields = group.split(":");
		if (
			fields.length !== 4 ||
			fields[0] !== OFFICE_PROVIDER_USER ||
			Number(fields[2]) !== gid ||
			fields[3]!.split(",").some((member) => member && member !== OFFICE_PROVIDER_USER)
		)
			throw new Error("OFFICE_INSTALL_CREDENTIAL_GROUP_SHARED");
	}
	if (byName) {
		const fields = byName.split(":");
		if (
			fields.length !== 7 ||
			fields[0] !== OFFICE_PROVIDER_USER ||
			Number(fields[2]) !== uid ||
			Number(fields[3]) !== gid ||
			fields[5] !== "/nonexistent" ||
			fields[6] !== "/usr/sbin/nologin"
		)
			throw new Error("OFFICE_INSTALL_IDENTITY_CONFLICT");
		if (command("/usr/bin/passwd", ["--status", OFFICE_PROVIDER_USER]).split(/\s+/)[1] !== "L")
			throw new Error("OFFICE_INSTALL_ACCOUNT_NOT_LOCKED");
		const groups = command("/usr/bin/id", ["-G", OFFICE_PROVIDER_USER])
			.split(/\s+/)
			.map(Number)
			.sort((a, b) => a - b);
		if (
			!isDeepStrictEqual(
				groups,
				[gid, socketGid].sort((a, b) => a - b),
			)
		)
			throw new Error("OFFICE_INSTALL_IDENTITY_GROUPS_CHANGED");
	}
	for (const line of command("/usr/bin/getent", ["passwd"]).split("\n")) {
		const fields = line.split(":");
		if (fields[0] !== OFFICE_PROVIDER_USER && (Number(fields[2]) === uid || Number(fields[3]) === gid))
			throw new Error("OFFICE_INSTALL_IDENTITY_SHARED");
	}
	if (
		command("/usr/bin/ps", ["-eo", "uid="])
			.split(/\s+/)
			.some((value) => value && Number(value) === uid)
	)
		throw new Error("OFFICE_INSTALL_PROVIDER_PROCESSES_REMAIN");
	if (create) {
		if (!group) command("/usr/sbin/groupadd", ["--gid", String(gid), OFFICE_PROVIDER_USER]);
		if (!byName)
			command("/usr/sbin/useradd", [
				"--uid",
				String(uid),
				"--gid",
				String(gid),
				"--groups",
				socket[0]!,
				"--no-create-home",
				"--home-dir",
				"/nonexistent",
				"--shell",
				"/usr/sbin/nologin",
				"--password",
				"!",
				OFFICE_PROVIDER_USER,
			]);
		identity(uid, gid, socketGid);
	}
}

type Loaded = Awaited<ReturnType<typeof load>>;
async function load(path: string) {
	rootOnly();
	const encoded = await protectedBytes(path, 16384),
		spec = parseOfficeInstallationSpec(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(encoded)));
	const manifestBytes = await protectedBytes(join(spec.packageRoot, "manifest.json"), 16384);
	if (officeInstallHash(manifestBytes) !== spec.packageManifestSha256)
		throw new Error("OFFICE_INSTALL_PACKAGE_CHANGED");
	const manifest = parseOfficeInstallationManifest(JSON.parse(manifestBytes.toString("utf8")));
	const artifacts: Record<string, Buffer> = {};
	for (const artifact of manifest) {
		const bytes = await protectedBytes(join(spec.packageRoot, artifact.file), artifact.bytes);
		if (bytes.length !== artifact.bytes || officeInstallHash(bytes) !== artifact.sha256)
			throw new Error("OFFICE_INSTALL_ARTIFACT_CHANGED");
		artifacts[artifact.file] = bytes;
	}
	if (
		!(await protectedBytes(process.argv[1]!, 2 * 1024 ** 2)).equals(artifacts["qorpera-office-provider-install.cjs"]!)
	)
		throw new Error("OFFICE_INSTALL_EXECUTABLE_MISMATCH");
	const documents = {} as Record<OfficeInstallDocument, Buffer>;
	try {
		for (const key of documentKeys)
			documents[key] = await protectedBytes(spec.documents[key].path, spec.documents[key].bytes, key === "registry");
		const validated = validateOfficeInstallationDocuments(
			spec,
			documents,
			artifacts["qorpera-office-provider.service.in"]!.toString("utf8"),
		);
		const machine = (await protectedBytes("/etc/machine-id", 64)).toString("utf8").trim();
		if (
			!/^[0-9a-f]{32}$/.test(machine) ||
			/^0+$/.test(machine) ||
			officeInstallHash(machine) !== validated.policy.host.machineIdSha256 ||
			validated.policy.host.architecture !==
				(process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : "unsupported")
		)
			throw new Error("OFFICE_INSTALL_HOST_MISMATCH");
		const version = /^v(\d+)\.(\d+)\.(\d+)$/.exec(command("/usr/bin/node", ["--version"]));
		if (!version || Number(version[1]) < 22 || (Number(version[1]) === 22 && Number(version[2]) < 19))
			throw new Error("OFFICE_INSTALL_NODE_UNSUPPORTED");
		return { spec, specSha256: officeInstallHash(encoded), manifest, artifacts, documents, ...validated };
	} catch (error) {
		documents.registry?.fill(0);
		throw error;
	}
}

async function journal(loaded: Loaded, create = false): Promise<string[]> {
	const { path } = loaded.policy.journal;
	await parents(path);
	const info = await lstat(path).catch((error) => {
		if (!missing(error)) throw error;
		return undefined;
	});
	const observedPath = info ? path : dirname(path);
	const fd = await open(observedPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		assertLxdOfficeHostMount(
			await readFile("/proc/self/mountinfo", "utf8"),
			await readFile(`/proc/self/fdinfo/${fd.fd}`, "utf8"),
			loaded.policy.journal,
			path,
		);
	} finally {
		await fd.close();
	}
	if (!info) {
		if (!create) return [];
		await mkdir(path, { mode: 0o700 });
		await chmod(path, 0o700);
		await chown(path, loaded.uid, loaded.gid);
	} else if (
		!info.isDirectory() ||
		info.uid !== loaded.uid ||
		info.gid !== loaded.gid ||
		(info.mode & 0o7777) !== 0o700 ||
		(await realpath(path)) !== path
	)
		throw new Error("OFFICE_INSTALL_JOURNAL_UNPROTECTED");
	const entries = await readdir(path),
		lock = join(path, "adoption.lock");
	if (!entries.includes("adoption.lock")) {
		if (entries.length) throw new Error("OFFICE_INSTALL_JOURNAL_LOCK_MISSING");
		if (create) {
			const f = await open(
				lock,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600,
			);
			try {
				await f.chown(loaded.uid, loaded.gid);
				await f.chmod(0o600);
				await f.sync();
			} finally {
				await f.close();
			}
		}
	} else {
		const value = await lstat(lock);
		if (
			!value.isFile() ||
			value.uid !== loaded.uid ||
			value.gid !== loaded.gid ||
			(value.mode & 0o7777) !== 0o600 ||
			value.nlink !== 1 ||
			value.size !== 0 ||
			(await realpath(lock)) !== lock
		)
			throw new Error("OFFICE_INSTALL_JOURNAL_LOCK_UNPROTECTED");
	}
	if (create) {
		for (const directory of [path, dirname(path)]) {
			const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
			try {
				await parent.sync();
			} finally {
				await parent.close();
			}
		}
	}
	return entries.filter((name) => name !== "adoption.lock");
}

function targets(loaded: Loaded) {
	const result: Array<{ path: string; bytes: Buffer; mode: number; gid: number }> = [];
	for (const file of OFFICE_INSTALL_ARTIFACTS.filter((name) => name.endsWith(".cjs")))
		result.push({ path: join(OFFICE_INSTALL_ROOT, file), bytes: loaded.artifacts[file]!, mode: 0o444, gid: 0 });
	for (const key of documentKeys)
		result.push({
			path: join(OFFICE_CONFIG_ROOT, OFFICE_INSTALL_DOCUMENTS[key].file),
			bytes: loaded.documents[key],
			mode: OFFICE_INSTALL_DOCUMENTS[key].mode,
			gid: key === "registry" ? loaded.gid : 0,
		});
	result.push(
		{ path: `/etc/systemd/system/${providerUnit}`, bytes: Buffer.from(loaded.unit), mode: 0o644, gid: 0 },
		{ path: `/etc/systemd/system/${namespaceUnit}`, bytes: loaded.artifacts[namespaceUnit]!, mode: 0o644, gid: 0 },
	);
	const record = {
		schema: "qorpera.lxd-office-provider-installation-receipt/v1",
		packageManifestSha256: loaded.spec.packageManifestSha256,
		providerPolicySha256: loaded.spec.providerPolicySha256,
		uid: loaded.uid,
		gid: loaded.gid,
		files: result.map((target) => ({
			path: target.path,
			bytes: target.bytes.length,
			sha256: officeInstallHash(target.bytes),
			mode: target.mode,
			gid: target.gid,
		})),
	};
	result.push({
		path: join(OFFICE_INSTALL_ROOT, "installation.json"),
		bytes: Buffer.from(`${JSON.stringify(record)}\n`),
		mode: 0o444,
		gid: 0,
	});
	return result;
}

async function targetExists(target: ReturnType<typeof targets>[number]): Promise<boolean> {
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

async function unitOverrides(names: readonly string[] = [providerUnit, namespaceUnit]): Promise<void> {
	// Inspect disk as well as the manager: a newly written drop-in may not have
	// been loaded yet. Global and dash-prefix drop-ins affect these units too.
	const paths = command("/usr/bin/systemd-analyze", ["unit-paths"]).split("\n");
	for (const name of names) {
		const expected = `/etc/systemd/system/${name}`;
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
		const suffix = name.slice(name.lastIndexOf("."));
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

async function preflight(loaded: Loaded): Promise<void> {
	stopped(providerUnit);
	stopped(namespaceUnit, true);
	await unitOverrides();
	identity(loaded.uid, loaded.gid, loaded.policy.host.socketGid);
	const entries = await journal(loaded);
	const expected = targets(loaded);
	let absent = 0;
	for (const target of expected) if (!(await targetExists(target))) absent += 1;
	if (absent && entries.length) {
		const previous = loaded.spec.previousInstallation;
		if (!previous) throw new Error("OFFICE_INSTALL_STATE_REQUIRES_RECOVERY");
		const bytes = await protectedBytes(previous.path, previous.bytes);
		if (officeInstallHash(bytes) !== previous.sha256) throw new Error("OFFICE_INSTALL_PREVIOUS_RECEIPT_CHANGED");
		const receipt = parseOfficeInstallationReceipt(
			JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)),
		);
		await assertOfficeInstallationUpgrade(
			receipt,
			{ providerPolicySha256: loaded.spec.providerPolicySha256, uid: loaded.uid, gid: loaded.gid },
			expected.map((target) => ({
				path: target.path,
				sha256: officeInstallHash(target.bytes),
				bytes: target.bytes.length,
			})),
			(path) =>
				lstat(path).then(
					() => true,
					(error) => {
						if (missing(error)) return false;
						throw error;
					},
				),
		);
	}
}

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

async function publish(target: ReturnType<typeof targets>[number]): Promise<void> {
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

export async function runOfficeProviderInstallation(
	stage: "--check" | "--apply" | "--prepare" | "--commit",
	specPath: string,
): Promise<void> {
	const loaded = await load(officePhysicalPath(specPath));
	try {
		await preflight(loaded);
		if (stage === "--check") {
			console.log(
				JSON.stringify({
					schema: "qorpera.lxd-office-provider-installation-check/v1",
					specSha256: loaded.specSha256,
					providerPolicySha256: loaded.spec.providerPolicySha256,
					uid: loaded.uid,
					gid: loaded.gid,
					targets: targets(loaded).map((target) => target.path),
					serviceWillRemain: "disabled-inactive",
				}),
			);
			return;
		}
		if (stage === "--apply") {
			await parents(rootLock, true);
			const file = await open(
				rootLock,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600,
			).catch((error) => {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
				throw error;
			});
			if (file) {
				await file.chmod(0o600);
				await file.sync();
				await file.close();
			}
			const value = await lstat(rootLock);
			if (
				!value.isFile() ||
				value.uid !== 0 ||
				value.gid !== 0 ||
				value.nlink !== 1 ||
				value.size !== 0 ||
				(value.mode & 0o7777) !== 0o600 ||
				(await realpath(rootLock)) !== rootLock
			)
				throw new Error("OFFICE_INSTALL_LOCK_UNPROTECTED");
			await lockedChild(rootLock, "--prepare", specPath);
			return;
		}
		const master = await lockFd(rootLock, 0);
		if (stage === "--prepare") {
			identity(loaded.uid, loaded.gid, loaded.policy.host.socketGid, true);
			await journal(loaded, true);
			await lockedChild(join(loaded.policy.journal.path, "adoption.lock"), "--commit", specPath, master);
			return;
		}
		await lockFd(join(loaded.policy.journal.path, "adoption.lock"), loaded.uid);
		await preflight(loaded);
		for (const target of targets(loaded)) {
			await lockFd(rootLock, 0);
			await lockFd(join(loaded.policy.journal.path, "adoption.lock"), loaded.uid);
			await publish(target);
		}
		command("/usr/bin/systemd-analyze", [
			"verify",
			`/etc/systemd/system/${providerUnit}`,
			`/etc/systemd/system/${namespaceUnit}`,
		]);
		command("/usr/bin/systemctl", ["daemon-reload"]);
		await unitOverrides();
		command("/usr/bin/systemctl", ["disable", providerUnit]);
		stopped(providerUnit);
		stopped(namespaceUnit, true);
		if (command("/usr/bin/systemctl", ["show", providerUnit, "--property=UnitFileState", "--value"]) !== "disabled")
			throw new Error("OFFICE_INSTALL_SERVICE_NOT_DISABLED");
		for (const target of targets(loaded))
			if (!(await targetExists(target))) throw new Error("OFFICE_INSTALL_READBACK_FAILED");
		console.log(
			JSON.stringify({
				schema: "qorpera.lxd-office-provider-installation-result/v1",
				specSha256: loaded.specSha256,
				packageManifestSha256: loaded.spec.packageManifestSha256,
				service: "disabled-inactive",
				configuration: "installed-or-preserved",
				journals: "preserved",
			}),
		);
	} finally {
		loaded.documents.registry.fill(0);
	}
}
