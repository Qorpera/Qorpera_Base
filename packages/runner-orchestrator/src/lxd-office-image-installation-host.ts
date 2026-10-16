import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	OFFICE_IMAGE_EXECUTABLES,
	OFFICE_IMAGE_FOLDER_MOUNT_UNIT,
	OFFICE_IMAGE_MOUNT_UNIT,
	OFFICE_IMAGE_ROOT,
	OFFICE_IMAGE_SELF_UPDATE_UNITS,
	OFFICE_IMAGE_USER,
	parseOfficeImageInstallationSpec,
	parseOfficeImagePackage,
	renderOfficeImageMount,
} from "./lxd-office-image-installation.ts";
import { officeDigest } from "./lxd-office-image-provenance.ts";
import { officeInstallHash as hash } from "./lxd-office-installation.ts";
import {
	assertOfficeInstallLocalDescriptor,
	assertOfficeInstallUnitsUnmodified,
	officeInstallCommand as command,
	officeInstallLockedChild,
	officeInstallLockFd,
	officeInstallParents,
	publishOfficeInstallFile,
	readOfficeInstallFile,
} from "./lxd-office-installation-host.ts";

const units = [
	"qorpera-company-computer.service",
	"qorpera-company-computer-preparation.service",
	OFFICE_IMAGE_MOUNT_UNIT,
];
// The company folder's units come with newer packages only. The helper starts one folder mount per desktop or command
// from the template.
const folderUnits = ["qorpera-office-folder-helper.socket", "qorpera-office-folder-helper.service"];
const folderMounts = OFFICE_IMAGE_FOLDER_MOUNT_UNIT.replace("@.", "@*.");
const lock = "/run/qorpera-office-image-install.lock";
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const infoKey = (s: Awaited<ReturnType<typeof lstat>>) => [
	s.dev,
	s.ino,
	s.mode,
	s.nlink,
	s.size,
	s.uid,
	s.gid,
	s.mtimeMs,
	s.ctimeMs,
];
function rootOnly(): void {
	if (
		process.platform !== "linux" ||
		process.getuid?.() !== 0 ||
		process.geteuid?.() !== 0 ||
		process.getegid?.() !== 0
	)
		throw new Error("OFFICE_IMAGE_ROOT_LINUX_REQUIRED");
}
async function exists(path: string) {
	return lstat(path).catch((error) => {
		if (!absent(error)) throw error;
		return undefined;
	});
}
async function imageFile(path: string, maximum: number, executable = false) {
	await officeInstallParents(path);
	const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		await assertOfficeInstallLocalDescriptor(f.fd);
		const s = await f.stat();
		if (
			!s.isFile() ||
			s.uid !== 0 ||
			s.gid !== 0 ||
			s.nlink !== 1 ||
			(s.mode & 0o6022) !== 0 ||
			s.size > maximum ||
			(executable && (s.mode & 0o111) !== 0o111) ||
			(await realpath(path)) !== path
		)
			throw new Error("OFFICE_IMAGE_DEPENDENCY_UNPROTECTED");
		const h = createHash("sha256"),
			bytes = Buffer.alloc(1024 ** 2);
		let total = 0;
		while (true) {
			const got = await f.read(bytes, 0, bytes.length, null);
			if (!got.bytesRead) break;
			total += got.bytesRead;
			if (total > maximum) throw new Error("OFFICE_IMAGE_DEPENDENCY_TOO_LARGE");
			h.update(bytes.subarray(0, got.bytesRead));
		}
		if (
			total !== s.size ||
			!isDeepStrictEqual(infoKey(s), infoKey(await f.stat())) ||
			!isDeepStrictEqual(infoKey(s), infoKey(await lstat(path)))
		)
			throw new Error("OFFICE_IMAGE_DEPENDENCY_CHANGED");
		return { sha256: h.digest("hex"), bytes: total, mode: s.mode & 0o7777 };
	} finally {
		await f.close();
	}
}

/** Read-only measurements to compare with separately reviewed image inputs.
 * The installer never learns new acceptable pins from the current image. */
export async function inspectOfficeImageDependencies() {
	rootOnly();
	const executables: Record<string, string> = {};
	for (const path of OFFICE_IMAGE_EXECUTABLES)
		executables[path] = (await imageFile(path, 512 * 1024 ** 2, true)).sha256;
	const entries: Array<{ path: string; mode: number; sha256?: string; bytes?: number }> = [];
	let total = 0;
	async function browser(path: string, relative: string): Promise<void> {
		const s = await lstat(path);
		if (!s.isDirectory() || s.uid !== 0 || s.gid !== 0 || (s.mode & 0o6022) !== 0 || (await realpath(path)) !== path)
			throw new Error("OFFICE_IMAGE_BROWSER_UNPROTECTED");
		entries.push({ path: relative, mode: s.mode & 0o7777 });
		for (const name of (await readdir(path)).sort()) {
			if (!/^[a-zA-Z0-9._-]+$/.test(name) || name === "." || name === ".." || entries.length >= 4096)
				throw new Error("OFFICE_IMAGE_BROWSER_INVALID");
			const child = join(path, name),
				rel = `${relative}/${name}`,
				info = await lstat(child);
			if (info.isDirectory()) await browser(child, rel);
			else {
				const file = await imageFile(child, 512 * 1024 ** 2);
				total += file.bytes;
				if (total > 1024 ** 3) throw new Error("OFFICE_IMAGE_BROWSER_TOO_LARGE");
				entries.push({ path: rel, ...file });
			}
		}
		if (!isDeepStrictEqual(infoKey(s), infoKey(await lstat(path)))) throw new Error("OFFICE_IMAGE_BROWSER_CHANGED");
	}
	await browser("/usr/lib/qorpera-chromium", "");
	return {
		osReleaseSha256: (await imageFile("/usr/lib/os-release", 65536)).sha256,
		dpkgManifestSha256: hash(command("/usr/bin/dpkg-query", ["-W"])),
		browserTreeSha256: officeDigest(entries),
		executables,
	};
}

type OfficeImageCommand = (file: string, args: string[]) => string;

/** Proves each self-update unit masked as `systemctl mask` writes it: a local
 * link to /dev/null that systemd also reports as masked. */
export async function assertOfficeImageSelfUpdateMasked(
	run: OfficeImageCommand = command,
	unitDirectory = "/etc/systemd/system",
): Promise<void> {
	for (const unit of OFFICE_IMAGE_SELF_UPDATE_UNITS) {
		const target = await readlink(join(unitDirectory, unit)).catch(() => undefined);
		if (
			target !== "/dev/null" ||
			run("/usr/bin/systemctl", ["show", unit, "--property=UnitFileState", "--value"]) !== "masked"
		)
			throw new Error("OFFICE_IMAGE_SELF_UPDATE_ENABLED");
	}
}

/** A published office must never update itself (run d1f454e2, 2026-09-24):
 * the timers catch up on every boot from the build's stamps, needrestart then
 * restarts the office under members and the shutdown inhibitor refuses the
 * VM's stop. Masking first means no timer starts a job after the check; a job
 * already running is refused, never stopped mid-upgrade. */
export async function maskOfficeImageSelfUpdate(
	run: OfficeImageCommand = command,
	unitDirectory = "/etc/systemd/system",
): Promise<void> {
	run("/usr/bin/systemctl", ["mask", ...OFFICE_IMAGE_SELF_UPDATE_UNITS]);
	for (const unit of ["apt-daily.service", "apt-daily-upgrade.service"])
		if (
			!["inactive", "failed"].includes(
				run("/usr/bin/systemctl", ["show", unit, "--property=ActiveState", "--value"]),
			)
		)
			throw new Error("OFFICE_IMAGE_APT_JOB_RUNNING");
	await assertOfficeImageSelfUpdateMasked(run, unitDirectory);
}

function account(uid: number, gid: number, create = false): void {
	const user = command("/usr/bin/getent", ["passwd", OFFICE_IMAGE_USER], true),
		byUid = command("/usr/bin/getent", ["passwd", String(uid)], true);
	const group = command("/usr/bin/getent", ["group", OFFICE_IMAGE_USER], true),
		byGid = command("/usr/bin/getent", ["group", String(gid)], true);
	if (user !== byUid || group !== byGid) throw new Error("OFFICE_IMAGE_IDENTITY_CONFLICT");
	if (
		group &&
		(group.split(":")[0] !== OFFICE_IMAGE_USER || Number(group.split(":")[2]) !== gid || group.split(":")[3])
	)
		throw new Error("OFFICE_IMAGE_GROUP_SHARED");
	if (user) {
		const fields = user.split(":");
		if (
			fields.length !== 7 ||
			fields[0] !== OFFICE_IMAGE_USER ||
			Number(fields[2]) !== uid ||
			Number(fields[3]) !== gid ||
			fields[5] !== "/nonexistent" ||
			fields[6] !== "/usr/sbin/nologin" ||
			command("/usr/bin/passwd", ["--status", OFFICE_IMAGE_USER]).split(/\s+/)[1] !== "L" ||
			command("/usr/bin/id", ["-G", OFFICE_IMAGE_USER]) !== String(gid)
		)
			throw new Error("OFFICE_IMAGE_IDENTITY_UNPROTECTED");
	}
	for (const line of command("/usr/bin/getent", ["passwd"]).split("\n")) {
		const p = line.split(":");
		if (p[0] !== OFFICE_IMAGE_USER && (Number(p[2]) === uid || Number(p[3]) === gid))
			throw new Error("OFFICE_IMAGE_IDENTITY_SHARED");
	}
	if (
		command("/usr/bin/ps", ["-eo", "uid="])
			.split(/\s+/)
			.some((v) => v && Number(v) === uid)
	)
		throw new Error("OFFICE_IMAGE_PROCESSES_REMAIN");
	if (create) {
		if (!group) command("/usr/sbin/groupadd", ["--gid", String(gid), OFFICE_IMAGE_USER]);
		if (!user)
			command("/usr/sbin/useradd", [
				"--uid",
				String(uid),
				"--gid",
				String(gid),
				"--no-create-home",
				"--home-dir",
				"/nonexistent",
				"--shell",
				"/usr/sbin/nologin",
				"--password",
				"!",
				OFFICE_IMAGE_USER,
			]);
		account(uid, gid);
	}
}

async function cleanImage(uid: number, gid: number): Promise<void> {
	for (const name of [...units, ...folderUnits]) {
		const state = command("/usr/bin/systemctl", ["show", name, "--property=ActiveState", "--value"]);
		if (
			!["inactive", "failed"].includes(state) ||
			command("/usr/bin/systemctl", ["show", name, "--property=Job", "--value"])
		)
			throw new Error("OFFICE_IMAGE_UNIT_NOT_STOPPED");
	}
	// No folder mount may run or wait to run.
	if (
		command("/usr/bin/systemctl", ["list-units", "--all", "--plain", "--no-legend", "--full", folderMounts])
			.split("\n")
			.some((line) => line && !["inactive", "failed"].includes(line.split(/\s+/)[2]!)) ||
		command("/usr/bin/systemctl", ["list-jobs", "--plain", "--no-legend", folderMounts])
	)
		throw new Error("OFFICE_IMAGE_UNIT_NOT_STOPPED");
	await assertOfficeInstallUnitsUnmodified([...units, ...folderUnits, OFFICE_IMAGE_FOLDER_MOUNT_UNIT]);
	// Nor may one folder mount (an instance, named after the @) carry a unit file or drop-in of its own.
	for (const directory of command("/usr/bin/systemd-analyze", ["unit-paths"]).split("\n")) {
		const entries = await readdir(directory).catch((error: unknown) => {
			if (absent(error)) return [];
			throw error;
		});
		if (entries.some((entry) => /^qorpera-office-folder-mount@[^.]/.test(entry)))
			throw new Error("OFFICE_INSTALL_UNIT_OVERRIDE");
	}
	for (const path of [
		"/var/lib/qorpera",
		"/var/lib/qorpera-native-provider",
		"/qorpera/company-live",
		"/etc/qorpera",
		"/root/.codex",
		"/root/.pi",
	])
		if (await exists(path)) throw new Error("OFFICE_IMAGE_EXISTING_IDENTITY");
	const mounts = (await readFile("/proc/self/mountinfo", "utf8")).split("\n").map((line) => line.split(" ")[4] ?? "");
	for (const path of [
		"/var/lib/qorpera-office",
		"/etc/qorpera-office",
		"/run/qorpera-office",
		"/run/qorpera-office-preparation",
	])
		if (mounts.some((m) => m === path || m.startsWith(`${path}/`))) throw new Error("OFFICE_IMAGE_EXISTING_MOUNT");
	async function empty(path: string, allowed: string[] = []) {
		const s = await exists(path);
		if (!s) return;
		await officeInstallParents(path);
		if (
			!s.isDirectory() ||
			s.uid !== 0 ||
			(s.mode & 0o6022) !== 0 ||
			(await realpath(path)) !== path ||
			(await readdir(path)).some((v) => !allowed.includes(v))
		)
			throw new Error("OFFICE_IMAGE_EXISTING_STATE");
	}
	await empty("/var/lib/qorpera-office");
	await empty("/etc/qorpera-office", ["credentials", "boots"]);
	await empty("/etc/qorpera-office/credentials");
	await empty("/etc/qorpera-office/boots");
	await empty("/run/qorpera-office-preparation", ["control.lock"]);
	if (await exists("/run/qorpera-office-preparation/control.lock")) {
		const s = await lstat("/run/qorpera-office-preparation/control.lock");
		if (!s.isFile() || s.uid !== 0 || s.gid !== 0 || s.nlink !== 1 || s.size !== 0 || (s.mode & 0o7777) !== 0o600)
			throw new Error("OFFICE_IMAGE_EXISTING_STATE");
	}
	await empty("/run/qorpera-office", ["private", "display", "browser", "captures"]);
	for (const child of ["private", "display", "browser", "captures"]) {
		const path = `/run/qorpera-office/${child}`,
			s = await exists(path);
		if (
			s &&
			(!s.isDirectory() ||
				s.uid !== uid ||
				s.gid !== gid ||
				(s.mode & 0o7777) !== 0o700 ||
				(await realpath(path)) !== path ||
				(await readdir(path)).length)
		)
			throw new Error("OFFICE_IMAGE_EXISTING_STATE");
	}
}

async function load(path: string) {
	rootOnly();
	const specBytes = await readOfficeInstallFile(path, 32768),
		spec = parseOfficeImageInstallationSpec(JSON.parse(specBytes.toString("utf8")));
	if (spec.architecture !== process.arch) throw new Error("OFFICE_IMAGE_ARCHITECTURE_MISMATCH");
	const manifest = await readOfficeInstallFile(join(spec.packageRoot, "manifest.json"), 1024 ** 2);
	if (hash(manifest) !== spec.packageManifestSha256) throw new Error("OFFICE_IMAGE_PACKAGE_CHANGED");
	const parsed = parseOfficeImagePackage(JSON.parse(manifest.toString("utf8"))),
		targets = [];
	for (const artifact of parsed.artifacts) {
		const bytes = await readOfficeInstallFile(
			join(spec.packageRoot, artifact.file),
			artifact.bytes,
			false,
			artifact.bytes === 0,
		);
		if (bytes.length !== artifact.bytes || hash(bytes) !== artifact.sha256)
			throw new Error("OFFICE_IMAGE_ARTIFACT_CHANGED");
		if (
			artifact.file === "qorpera-office-image-install.cjs" &&
			!(await readOfficeInstallFile(process.argv[1]!, 1024 ** 2)).equals(bytes)
		)
			throw new Error("OFFICE_IMAGE_EXECUTABLE_MISMATCH");
		if (
			artifact.file === "node_modules/playwright-core/package.json" &&
			JSON.parse(bytes.toString("utf8")).version !== parsed.playwright
		)
			throw new Error("OFFICE_IMAGE_PLAYWRIGHT_MISMATCH");
		targets.push({
			path: artifact.path,
			bytes:
				artifact.file === "qorpera-office-private.mount.in" ||
				artifact.file === `${OFFICE_IMAGE_FOLDER_MOUNT_UNIT}.in`
					? Buffer.from(renderOfficeImageMount(bytes.toString("utf8"), spec.uid, spec.gid))
					: bytes,
			mode: artifact.mode,
			gid: 0,
		});
		// Root preparation/service control compares the loaded unit with this
		// immutable image reference before any guest operation is authorized.
		if (artifact.file === units[0] || artifact.file === units[1])
			targets.push({ path: `${OFFICE_IMAGE_ROOT}/${artifact.file}`, bytes, mode: 0o444, gid: 0 });
	}
	const browserBwrap = await readOfficeInstallFile("/usr/bin/bwrap", 32 * 1024 ** 2);
	if (hash(browserBwrap) !== spec.dependencies.executables["/usr/bin/bwrap"])
		throw new Error("OFFICE_IMAGE_DEPENDENCIES_CHANGED");
	targets.push({ path: "/usr/local/lib/qorpera/qorpera-browser-bwrap", bytes: browserBwrap, mode: 0o555, gid: 0 });
	const receipt = {
		schema: "qorpera.office-image-installation-receipt/v1",
		specSha256: hash(specBytes),
		packageManifestSha256: spec.packageManifestSha256,
		architecture: spec.architecture,
		uid: spec.uid,
		gid: spec.gid,
		dependencies: spec.dependencies,
		files: targets.map((t) => ({ path: t.path, bytes: t.bytes.length, sha256: hash(t.bytes), mode: t.mode })),
	};
	targets.push({
		path: `${OFFICE_IMAGE_ROOT}/installation.json`,
		bytes: Buffer.from(`${JSON.stringify(receipt)}\n`),
		mode: 0o444,
		gid: 0,
	});
	return { spec, targets, receipt };
}

async function preflight(loaded: Awaited<ReturnType<typeof load>>) {
	const { spec } = loaded;
	await cleanImage(spec.uid, spec.gid);
	account(spec.uid, spec.gid);
	if (!isDeepStrictEqual(await inspectOfficeImageDependencies(), spec.dependencies))
		throw new Error("OFFICE_IMAGE_DEPENDENCIES_CHANGED");
	command("/usr/sbin/apparmor_parser", [
		"--skip-kernel-load",
		"--skip-cache",
		join(spec.packageRoot, "qorpera-office-browser-bwrap.apparmor"),
	]);
	const node = /^v(\d+)\.(\d+)\.(\d+)$/.exec(command("/usr/bin/node", ["--version"]));
	if (
		!node ||
		Number(node[1]) < 22 ||
		(Number(node[1]) === 22 && Number(node[2]) < 19) ||
		!(Number((await readFile("/proc/sys/user/max_user_namespaces", "utf8")).trim()) > 0)
	)
		throw new Error("OFFICE_IMAGE_RUNTIME_UNSUPPORTED");
	for (const target of loaded.targets) {
		if (!(await exists(target.path))) continue;
		const bytes = await readOfficeInstallFile(target.path, target.bytes.length, false, target.bytes.length === 0),
			s = await lstat(target.path);
		if (!bytes.equals(target.bytes) || s.gid !== 0 || (s.mode & 0o7777) !== target.mode)
			throw new Error("OFFICE_IMAGE_EXISTING_FILES_DIFFER");
	}
}

export async function installOfficeImage(stage: "--check" | "--apply" | "--locked", specPath: string) {
	const loaded = await load(specPath);
	await preflight(loaded);
	if (stage === "--check") {
		console.log(
			JSON.stringify({
				schema: "qorpera.office-image-installation-check/v1",
				specSha256: loaded.receipt.specSha256,
				files: loaded.targets.length,
				state: "unconfigured-inactive",
			}),
		);
		return;
	}
	if (stage === "--apply") {
		await officeInstallParents(lock);
		const f = await open(
			lock,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		).catch((error) => {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			return undefined;
		});
		if (f) {
			try {
				await f.chmod(0o600);
				await f.sync();
			} finally {
				await f.close();
			}
		}
		const s = await lstat(lock);
		if (
			!s.isFile() ||
			s.uid !== 0 ||
			s.gid !== 0 ||
			s.nlink !== 1 ||
			s.size !== 0 ||
			(s.mode & 0o7777) !== 0o600 ||
			(await realpath(lock)) !== lock
		)
			throw new Error("OFFICE_IMAGE_LOCK_UNPROTECTED");
		await officeInstallLockedChild(lock, "--locked", specPath);
		return;
	}
	await officeInstallLockFd(lock, 0);
	await maskOfficeImageSelfUpdate();
	account(loaded.spec.uid, loaded.spec.gid, true);
	for (const target of loaded.targets) {
		await officeInstallLockFd(lock, 0);
		await publishOfficeInstallFile(target);
	}
	const appArmor = await readFile("/sys/module/apparmor/parameters/enabled", "utf8").catch((error) => {
		if (absent(error)) return "N";
		throw error;
	});
	if (!/^[YN]\n?$/.test(appArmor)) throw new Error("OFFICE_IMAGE_APPARMOR_UNCONFIRMED");
	command("/usr/sbin/apparmor_parser", [
		appArmor.trim() === "Y" ? "--replace" : "--skip-kernel-load",
		"--skip-cache",
		"/etc/apparmor.d/qorpera-office-browser-bwrap",
	]);
	await officeInstallParents("/var/lib/qorpera-office/.placeholder", true);
	await chmod("/var/lib/qorpera-office", 0o755);
	// Each computer's network units and the company folder's come with newer packages only.
	const optionalUnits: string[] = [];
	for (const name of [
		"qorpera-computer-network.service",
		"qorpera-computer-plumb.socket",
		"qorpera-computer-plumb@.service",
		...folderUnits,
		OFFICE_IMAGE_FOLDER_MOUNT_UNIT,
	])
		if (
			await lstat(`/etc/systemd/system/${name}`).then(
				() => true,
				(error: unknown) => {
					if (absent(error)) return false;
					throw error;
				},
			)
		)
			optionalUnits.push(`/etc/systemd/system/${name}`);
	command("/usr/bin/systemd-analyze", ["verify", ...units.map((n) => `/etc/systemd/system/${n}`), ...optionalUnits]);
	command("/usr/bin/systemd-tmpfiles", [
		"--create",
		"/usr/lib/tmpfiles.d/qorpera-office-preparation.conf",
		"/usr/lib/tmpfiles.d/qorpera-office-runtime.conf",
	]);
	command("/usr/bin/systemctl", ["daemon-reload"]);
	command("/usr/bin/systemctl", ["disable", units[0]!]);
	await preflight(loaded);
	if (command("/usr/bin/systemctl", ["show", units[0]!, "--property=UnitFileState", "--value"]) !== "disabled")
		throw new Error("OFFICE_IMAGE_SERVICE_NOT_DISABLED");
	await assertOfficeImageSelfUpdateMasked();
	console.log(
		JSON.stringify({
			schema: "qorpera.office-image-installation-result/v1",
			specSha256: loaded.receipt.specSha256,
			files: loaded.targets.length,
			state: "unconfigured-inactive",
		}),
	);
}
