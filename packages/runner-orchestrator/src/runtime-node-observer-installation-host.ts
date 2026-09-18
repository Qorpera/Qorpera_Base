import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { officeInstallHash } from "./lxd-office-installation.ts";
import {
	assertOfficeInstallUnitsUnmodified,
	officeInstallCommand as command,
	officeInstallLockedChild as lockedChild,
	officeInstallLockFd as lockFd,
	officeInstallParents as parents,
	readOfficeInstallFile as protectedBytes,
	publishOfficeInstallFile as publish,
} from "./lxd-office-installation-host.ts";
import { officePhysicalPath } from "./lxd-office-physical-policy.ts";
import {
	NODE_OBSERVER_INSTALL_ARTIFACTS,
	NODE_OBSERVER_INSTALL_DOCUMENTS,
	NODE_OBSERVER_INSTALL_ROOT,
	NODE_OBSERVER_USER,
	type NodeObserverInstallDocument,
	parseNodeObserverInstallationManifest,
	parseNodeObserverInstallationSpec,
	validateNodeObserverInstallationDocuments,
} from "./runtime-node-observer-installation.ts";

const mutex = "/run/qorpera-node-observer-install/install.lock",
	unit = "qorpera-node-observer.service",
	namespaceUnit = "qorpera-node-host-namespace.service";
const keys = Object.keys(NODE_OBSERVER_INSTALL_DOCUMENTS) as NodeObserverInstallDocument[];
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
function stopped(name: string, exited = false) {
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
		throw new Error("NODE_OBSERVER_INSTALL_SERVICE_NOT_STOPPED");
}
function identity(uid: number, gid: number, socketGid: number, create = false): void {
	const name = NODE_OBSERVER_USER,
		byName = command("/usr/bin/getent", ["passwd", name], true),
		byUid = command("/usr/bin/getent", ["passwd", String(uid)], true),
		group = command("/usr/bin/getent", ["group", name], true),
		byGid = command("/usr/bin/getent", ["group", String(gid)], true),
		socket = command("/usr/bin/getent", ["group", String(socketGid)], true).split(":");
	if (socket.length !== 4 || !/^[a-z_][a-z0-9_-]{0,31}$/.test(socket[0]!))
		throw new Error("NODE_OBSERVER_INSTALL_SOCKET_GROUP_MISSING");
	if (byName !== byUid || group !== byGid) throw new Error("NODE_OBSERVER_INSTALL_IDENTITY_CONFLICT");
	if (group) {
		const f = group.split(":");
		if (
			f.length !== 4 ||
			f[0] !== name ||
			Number(f[2]) !== gid ||
			f[3]!.split(",").some((member) => member && member !== name)
		)
			throw new Error("NODE_OBSERVER_INSTALL_GROUP_SHARED");
	}
	if (byName) {
		const f = byName.split(":");
		if (
			f.length !== 7 ||
			f[0] !== name ||
			Number(f[2]) !== uid ||
			Number(f[3]) !== gid ||
			f[5] !== "/nonexistent" ||
			f[6] !== "/usr/sbin/nologin"
		)
			throw new Error("NODE_OBSERVER_INSTALL_IDENTITY_CONFLICT");
		if (command("/usr/bin/passwd", ["--status", name]).split(/\s+/)[1] !== "L")
			throw new Error("NODE_OBSERVER_INSTALL_ACCOUNT_UNLOCKED");
		if (
			!isDeepStrictEqual(
				command("/usr/bin/id", ["-G", name])
					.split(/\s+/)
					.map(Number)
					.sort((a, b) => a - b),
				[gid, socketGid].sort((a, b) => a - b),
			)
		)
			throw new Error("NODE_OBSERVER_INSTALL_GROUPS_DIFFER");
	}
	for (const line of command("/usr/bin/getent", ["passwd"]).split("\n")) {
		const f = line.split(":");
		if (f[0] !== name && (Number(f[2]) === uid || Number(f[3]) === gid))
			throw new Error("NODE_OBSERVER_INSTALL_IDENTITY_SHARED");
	}
	if (
		command("/usr/bin/ps", ["-eo", "uid="])
			.split(/\s+/)
			.some((v) => v && Number(v) === uid)
	)
		throw new Error("NODE_OBSERVER_INSTALL_PROCESSES_REMAIN");
	if (create) {
		if (!group) command("/usr/sbin/groupadd", ["--gid", String(gid), name]);
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
				name,
			]);
		identity(uid, gid, socketGid);
	}
}
async function load(path: string) {
	if (
		process.platform !== "linux" ||
		process.getuid?.() !== 0 ||
		process.geteuid?.() !== 0 ||
		process.getegid?.() !== 0
	)
		throw new Error("NODE_OBSERVER_INSTALL_ROOT_LINUX_REQUIRED");
	const encoded = await protectedBytes(path, 16384),
		spec = parseNodeObserverInstallationSpec(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(encoded))),
		manifestBytes = await protectedBytes(join(spec.packageRoot, "manifest.json"), 16384);
	if (officeInstallHash(manifestBytes) !== spec.packageManifestSha256)
		throw new Error("NODE_OBSERVER_INSTALL_PACKAGE_CHANGED");
	const artifacts: Record<string, Buffer> = {};
	for (const a of parseNodeObserverInstallationManifest(JSON.parse(manifestBytes.toString("utf8")))) {
		const bytes = await protectedBytes(join(spec.packageRoot, a.file), a.bytes);
		if (bytes.length !== a.bytes || officeInstallHash(bytes) !== a.sha256)
			throw new Error("NODE_OBSERVER_INSTALL_ARTIFACT_CHANGED");
		artifacts[a.file] = bytes;
	}
	if (!(await protectedBytes(process.argv[1]!, 2 * 1024 ** 2)).equals(artifacts["qorpera-node-observer-install.cjs"]!))
		throw new Error("NODE_OBSERVER_INSTALL_EXECUTABLE_DIFFERS");
	const documents = {} as Record<NodeObserverInstallDocument, Buffer>;
	try {
		for (const key of keys)
			documents[key] = await protectedBytes(spec.documents[key].path, spec.documents[key].bytes, key === "key");
		const validated = validateNodeObserverInstallationDocuments(
			spec,
			documents,
			artifacts["qorpera-node-observer.service.in"]!.toString("utf8"),
		);
		const machine = (await protectedBytes("/etc/machine-id", 64)).toString("utf8");
		if (
			!/^[0-9a-f]{32}\n?$/.test(machine) ||
			/^0{32}\n?$/.test(machine) ||
			officeInstallHash(machine.trim()) !== validated.policy.host.machineIdSha256 ||
			validated.policy.host.architecture !==
				(process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : "unsupported")
		)
			throw new Error("NODE_OBSERVER_INSTALL_HOST_DIFFERS");
		await parents(validated.policy.host.socketPath);
		const socket = await lstat(validated.policy.host.socketPath);
		if (
			!socket.isSocket() ||
			socket.uid !== 0 ||
			socket.gid !== validated.policy.host.socketGid ||
			(socket.mode & 0o7777) !== 0o660 ||
			(await realpath(validated.policy.host.socketPath)) !== validated.policy.host.socketPath
		)
			throw new Error("NODE_OBSERVER_INSTALL_SOCKET_UNPROTECTED");
		const version = /^v(\d+)\.(\d+)\.(\d+)$/.exec(command("/usr/bin/node", ["--version"]));
		if (!version || Number(version[1]) < 22 || (Number(version[1]) === 22 && Number(version[2]) < 19))
			throw new Error("NODE_OBSERVER_INSTALL_NODE_UNSUPPORTED");
		return { spec, specSha256: officeInstallHash(encoded), artifacts, documents, ...validated };
	} catch (error) {
		documents.key?.fill(0);
		throw error;
	}
}
type Loaded = Awaited<ReturnType<typeof load>>;
function targets(l: Loaded) {
	const result: Array<{ path: string; bytes: Buffer; mode: number; gid: number }> = [];
	for (const name of NODE_OBSERVER_INSTALL_ARTIFACTS.filter((n) => n.endsWith(".cjs")))
		result.push({ path: join(NODE_OBSERVER_INSTALL_ROOT, name), bytes: l.artifacts[name]!, mode: 0o444, gid: 0 });
	for (const key of keys)
		result.push({
			path: NODE_OBSERVER_INSTALL_DOCUMENTS[key].path,
			bytes: l.documents[key],
			mode: NODE_OBSERVER_INSTALL_DOCUMENTS[key].mode,
			gid: key === "key" ? l.spec.gid : 0,
		});
	result.push(
		{ path: `/etc/systemd/system/${unit}`, bytes: Buffer.from(l.unit), mode: 0o644, gid: 0 },
		{ path: `/etc/systemd/system/${namespaceUnit}`, bytes: l.artifacts[namespaceUnit]!, mode: 0o644, gid: 0 },
	);
	const receipt = {
		schema: "qorpera.node-observer-installation-receipt/v1",
		packageManifestSha256: l.spec.packageManifestSha256,
		policySha256: l.spec.policySha256,
		uid: l.spec.uid,
		gid: l.spec.gid,
		files: result.map((t) => ({
			path: t.path,
			bytes: t.bytes.length,
			sha256: officeInstallHash(t.bytes),
			mode: t.mode,
			gid: t.gid,
		})),
	};
	result.push({
		path: join(NODE_OBSERVER_INSTALL_ROOT, "installation.json"),
		bytes: Buffer.from(`${JSON.stringify(receipt)}\n`),
		mode: 0o444,
		gid: 0,
	});
	return result;
}
async function exists(t: ReturnType<typeof targets>[number]): Promise<boolean> {
	try {
		const bytes = await protectedBytes(t.path, t.bytes.length);
		try {
			const s = await lstat(t.path);
			if (!bytes.equals(t.bytes) || s.gid !== t.gid || (s.mode & 0o7777) !== t.mode)
				throw new Error("NODE_OBSERVER_INSTALL_EXISTING_FILES_DIFFER");
			return true;
		} finally {
			bytes.fill(0);
		}
	} catch (e) {
		if (missing(e)) return false;
		throw e;
	}
}
async function preflight(l: Loaded) {
	stopped(unit);
	stopped(namespaceUnit, true);
	await assertOfficeInstallUnitsUnmodified([unit, namespaceUnit]);
	identity(l.spec.uid, l.spec.gid, l.policy.host.socketGid);
	const planned = targets(l),
		present = await Promise.all(planned.map(exists));
	if (present.at(-1) && present.some((v) => !v)) throw new Error("NODE_OBSERVER_INSTALL_STATE_REQUIRES_RECOVERY");
}
export async function runNodeObserverInstallation(
	stage: "--check" | "--apply" | "--commit",
	specPath: string,
): Promise<void> {
	const l = await load(officePhysicalPath(specPath));
	try {
		await preflight(l);
		if (stage === "--check") {
			console.log(
				JSON.stringify({
					schema: "qorpera.node-observer-installation-check/v1",
					specSha256: l.specSha256,
					policySha256: l.spec.policySha256,
					uid: l.spec.uid,
					gid: l.spec.gid,
					targets: targets(l).map((t) => t.path),
					serviceWillRemain: "disabled-inactive",
				}),
			);
			return;
		}
		if (stage === "--apply") {
			await parents(mutex, true);
			const file = await open(
				mutex,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600,
			).catch((e) => {
				if (e.code === "EEXIST") return undefined;
				throw e;
			});
			if (file) {
				await file.chmod(0o600);
				await file.sync();
				await file.close();
			}
			const s = await lstat(mutex);
			if (
				!s.isFile() ||
				s.uid !== 0 ||
				s.gid !== 0 ||
				s.nlink !== 1 ||
				s.size !== 0 ||
				(s.mode & 0o7777) !== 0o600 ||
				(await realpath(mutex)) !== mutex
			)
				throw new Error("NODE_OBSERVER_INSTALL_LOCK_UNPROTECTED");
			await lockedChild(mutex, "--commit", specPath);
			return;
		}
		await lockFd(mutex, 0);
		identity(l.spec.uid, l.spec.gid, l.policy.host.socketGid, true);
		await preflight(l);
		for (const t of targets(l)) {
			await lockFd(mutex, 0);
			await publish(t);
		}
		command("/usr/bin/systemd-analyze", [
			"verify",
			`/etc/systemd/system/${unit}`,
			`/etc/systemd/system/${namespaceUnit}`,
		]);
		command("/usr/bin/systemctl", ["daemon-reload"]);
		await assertOfficeInstallUnitsUnmodified([unit, namespaceUnit]);
		command("/usr/bin/systemctl", ["disable", unit]);
		stopped(unit);
		stopped(namespaceUnit, true);
		if (command("/usr/bin/systemctl", ["show", unit, "--property=UnitFileState", "--value"]) !== "disabled")
			throw new Error("NODE_OBSERVER_INSTALL_SERVICE_NOT_DISABLED");
		for (const t of targets(l)) if (!(await exists(t))) throw new Error("NODE_OBSERVER_INSTALL_READBACK_FAILED");
		console.log(
			JSON.stringify({
				schema: "qorpera.node-observer-installation-result/v1",
				specSha256: l.specSha256,
				packageManifestSha256: l.spec.packageManifestSha256,
				service: "disabled-inactive",
				configuration: "installed-or-preserved",
				enrollment: "not performed",
			}),
		);
	} finally {
		l.documents.key.fill(0);
	}
}
