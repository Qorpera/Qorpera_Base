import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readdir, readFile, readlink, realpath, rename } from "node:fs/promises";
import { request } from "node:http";
import { dirname, join } from "node:path";
import { officeCanonical, officeDigest, officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import { officeInstallHash } from "./lxd-office-installation.ts";
import {
	officeInstallCommand,
	officeInstallLockFd,
	officeInstallParents,
	readOfficeInstallFile,
} from "./lxd-office-installation-host.ts";
import { checkDirectory, code, publish, readRecord, syncDirectory } from "./lxd-office-journal-files.ts";
import { officePhysicalPath } from "./lxd-office-physical-policy.ts";
import {
	type NodeUpdateDrain,
	type NodeUpdateIntent,
	type NodeUpdateReceipt,
	type NodeUpdateRelease,
	parseNodeUpdateReceipt,
} from "./runtime-node-update.ts";
import type { NodeUpdatePhysicalPorts } from "./runtime-node-update-ports.ts";
import type { RuntimeNodeUpdateRegistry } from "./runtime-node-update-registry.ts";

const properties = [
	"LoadState",
	"ActiveState",
	"SubState",
	"MainPID",
	"ControlPID",
	"Job",
	"InvocationID",
	"ExecMainStartTimestampMonotonic",
	"FragmentPath",
	"DropInPaths",
	"User",
	"Group",
	"ControlGroup",
] as const;
export function parseNodeUpdateHostEnrollment(value: unknown) {
	const e = officeRecord(value, [
		"schema",
		"machineIdSha256",
		"journalRoot",
		"lockPath",
		"artifactBaseUrl",
		"service",
		"unitPath",
		"unitSha256",
		"dropIns",
		"launcher",
		"runtimePath",
		"runtimeSha256",
		"installedPath",
		"installedMode",
		"serviceUser",
		"serviceGroup",
		"serviceUid",
		"configuration",
		"healthUrls",
		"lxdSocket",
		"lxdProject",
	]);
	if (
		e.schema !== "qorpera.node-update-host/v1" ||
		typeof e.service !== "string" ||
		!/^qorpera-[a-z0-9-]{1,64}\.service$/.test(e.service) ||
		e.unitPath !== `/etc/systemd/system/${e.service}` ||
		e.runtimePath !== "/usr/bin/node" ||
		![0o444, 0o555, 0o755].includes(e.installedMode as number) ||
		!Number.isSafeInteger(e.serviceUid) ||
		(e.serviceUid as number) < 1 ||
		(e.serviceUid as number) > 2147483647 ||
		typeof e.serviceUser !== "string" ||
		!/^[a-z_][a-z0-9_-]{0,31}$/.test(e.serviceUser) ||
		typeof e.serviceGroup !== "string" ||
		!/^[a-z_][a-z0-9_-]{0,31}$/.test(e.serviceGroup) ||
		typeof e.lxdProject !== "string" ||
		!/^[a-z][a-z0-9-]{0,62}$/.test(e.lxdProject)
	)
		throw new Error("NODE_UPDATE_HOST_ENROLLMENT_INVALID");
	const installedPath = officePhysicalPath(e.installedPath),
		journalRoot = officePhysicalPath(e.journalRoot),
		lockPath = officePhysicalPath(e.lockPath);
	if (
		!/^\/opt\/(?:qorpera\/[a-z0-9-]+|qorpera-native25-phql-a1)\/qorpera-[a-z0-9-]+\.mjs$/.test(installedPath) ||
		!journalRoot.startsWith("/var/lib/qorpera-node-updater/") ||
		lockPath !== `${journalRoot}/update.lock`
	)
		throw new Error("NODE_UPDATE_HOST_PATH_INVALID");
	const base = typeof e.artifactBaseUrl === "string" ? new URL(e.artifactBaseUrl) : null;
	if (
		!base ||
		base.protocol !== "https:" ||
		base.username ||
		base.password ||
		base.search ||
		base.hash ||
		base.href !== e.artifactBaseUrl ||
		!base.pathname.endsWith("/")
	)
		throw new Error("NODE_UPDATE_ARTIFACT_SOURCE_INVALID");
	if (
		!Array.isArray(e.configuration) ||
		e.configuration.length < 1 ||
		e.configuration.length > 16 ||
		!Array.isArray(e.healthUrls) ||
		e.healthUrls.length < 1 ||
		e.healthUrls.length > 4
	)
		throw new Error("NODE_UPDATE_HOST_ENROLLMENT_INVALID");
	const configuration = e.configuration.map((entry) => {
		const f = officeRecord(entry, ["path", "sha256"]);
		const path = officePhysicalPath(f.path);
		if (!path.startsWith("/etc/qorpera/") && !path.startsWith("/etc/qorpera-native25-phql-a1/"))
			throw new Error("NODE_UPDATE_CONFIGURATION_PATH_INVALID");
		return { path, sha256: officeSha(f.sha256) };
	});
	if (new Set(configuration.map((f) => f.path)).size !== configuration.length)
		throw new Error("NODE_UPDATE_CONFIGURATION_PATH_INVALID");
	if (!Array.isArray(e.dropIns) || e.dropIns.length > 64) throw new Error("NODE_UPDATE_DROP_INS_INVALID");
	const dropIns = e.dropIns.map((value) => {
		const f = officeRecord(value, ["path", "sha256"]),
			path = officePhysicalPath(f.path);
		if (dirname(path) !== `${e.unitPath}.d` || !/^[a-zA-Z0-9_-]+\.conf$/.test(path.split("/").at(-1)!))
			throw new Error("NODE_UPDATE_DROP_INS_INVALID");
		return { path, sha256: officeSha(f.sha256) };
	});
	if (new Set(dropIns.map((f) => f.path)).size !== dropIns.length) throw new Error("NODE_UPDATE_DROP_INS_INVALID");
	let launcher: { path: string; sha256: string; artifactSha256: string; templatePath: string } | null = null;
	if (e.launcher !== null) {
		const f = officeRecord(e.launcher, ["path", "sha256", "artifactSha256", "templatePath"]);
		if (
			!/^\/opt\/qorpera-native25-phql-a1\/provider-launch-(?:node02-)?v52\.py$/.test(String(f.path)) ||
			f.templatePath !== "/etc/qorpera/node-updater/launcher-template.py" ||
			installedPath !== "/opt/qorpera-native25-phql-a1/qorpera-lxd-provider-v52-a1.mjs" ||
			e.installedMode !== 0o444
		)
			throw new Error("NODE_UPDATE_LAUNCHER_ENROLLMENT_INVALID");
		launcher = {
			path: officePhysicalPath(f.path),
			sha256: officeSha(f.sha256),
			artifactSha256: officeSha(f.artifactSha256),
			templatePath: f.templatePath,
		};
	}
	if (installedPath.startsWith("/opt/qorpera-native25-phql-a1/") && !launcher)
		throw new Error("NODE_UPDATE_LAUNCHER_ENROLLMENT_INVALID");
	const healthUrls = e.healthUrls.map((value) => {
		const url = typeof value === "string" ? new URL(value) : null;
		if (
			!url ||
			url.protocol !== "http:" ||
			url.hostname !== "127.0.0.1" ||
			!url.port ||
			url.username ||
			url.password ||
			url.pathname !== "/healthz" ||
			url.search ||
			url.hash ||
			url.href !== value
		)
			throw new Error("NODE_UPDATE_HEALTH_URL_INVALID");
		return url.href;
	});
	return Object.freeze({
		schema: "qorpera.node-update-host/v1" as const,
		machineIdSha256: officeSha(e.machineIdSha256),
		journalRoot,
		lockPath,
		artifactBaseUrl: base.href,
		service: e.service,
		unitPath: e.unitPath,
		unitSha256: officeSha(e.unitSha256),
		dropIns,
		launcher,
		runtimePath: e.runtimePath,
		runtimeSha256: officeSha(e.runtimeSha256),
		installedPath,
		installedMode: e.installedMode as number,
		serviceUser: e.serviceUser,
		serviceGroup: e.serviceGroup,
		serviceUid: e.serviceUid as number,
		configuration,
		healthUrls,
		lxdSocket: officePhysicalPath(e.lxdSocket),
		lxdProject: e.lxdProject,
	});
}
export type NodeUpdateHostEnrollment = ReturnType<typeof parseNodeUpdateHostEnrollment>;

/** The root-enrolled template is immutable across revisions. Only its one
 * existing checked digest literal may change; every other byte is preserved. */
export function deriveNodeUpdateLauncher(
	template: Buffer,
	templateSha256: string,
	enrolledArtifactSha256: string,
	artifactSha256: string,
): Buffer {
	for (const digest of [templateSha256, enrolledArtifactSha256, artifactSha256]) officeSha(digest);
	if (template.length > 65536 || officeInstallHash(template) !== templateSha256)
		throw new Error("NODE_UPDATE_LAUNCHER_TEMPLATE_CHANGED");
	const text = new TextDecoder("utf-8", { fatal: true }).decode(template);
	const check = `need(hashlib.sha256(read(BUNDLE,0o444,1024*1024)).hexdigest()=='${enrolledArtifactSha256}')`;
	if (text.split(enrolledArtifactSha256).length !== 2 || !text.split("\n").some((line) => line.trim() === check))
		throw new Error("NODE_UPDATE_LAUNCHER_DIGEST_NOT_UNIQUE");
	const offset = template.indexOf(Buffer.from(enrolledArtifactSha256));
	return Buffer.concat([template.subarray(0, offset), Buffer.from(artifactSha256), template.subarray(offset + 64)]);
}

/** IPv4 loopback health must be served by a listening socket held by the
 * exact enrolled service MainPID, not merely any successful local HTTP server. */
export function nodeUpdateHealthSocket(tcp: string, descriptors: readonly string[], port: number): string {
	const address = `0100007F:${port.toString(16).padStart(4, "0").toUpperCase()}`;
	const matches = tcp
		.split("\n")
		.slice(1)
		.map((line) => line.trim().split(/\s+/))
		.filter(
			(f) =>
				f[1] === address &&
				f[3] === "0A" &&
				/^[1-9][0-9]*$/.test(f[9] ?? "") &&
				descriptors.includes(`socket:[${f[9]}]`),
		);
	if (matches.length !== 1) throw new Error("NODE_UPDATE_HEALTH_LISTENER_NOT_OWNED");
	return matches[0][9];
}

/** Re-observe after all asynchronous prerequisites; dispatch has no further
 * asynchronous preparation between the identity comparison and command spawn. */
export async function dispatchNodeUpdateForUnchangedInvocation<T>(
	expected: T,
	observe: () => Promise<T>,
	dispatch: () => Promise<void>,
): Promise<void> {
	if (officeCanonical(await observe()) !== officeCanonical(expected))
		throw new Error("NODE_UPDATE_SERVICE_INVOCATION_CHANGED");
	await dispatch();
}

/** Concrete enrolled binary and checked-launcher Linux updater. All writable paths, service identity,
 * configuration, runtime and source origin come from root enrollment. The
 * signed release supplies only the next exact raw .mjs bytes. No archive or
 * package-provided command is executed, and unit/config/image pins are retained.
 * A native launcher changes only its one root-enrolled binary digest literal. */
export class LinuxNodeUpdatePhysicalPorts implements NodeUpdatePhysicalPorts {
	readonly #e: NodeUpdateHostEnrollment;
	readonly #root: string;
	readonly #registry: RuntimeNodeUpdateRegistry;
	constructor(enrollment: NodeUpdateHostEnrollment, revisionRoot: string, registry: RuntimeNodeUpdateRegistry) {
		this.#e = parseNodeUpdateHostEnrollment(enrollment);
		this.#root = officePhysicalPath(revisionRoot);
		this.#registry = registry;
		if (dirname(this.#root) !== this.#e.journalRoot || !/^revision-[1-9][0-9]*$/.test(this.#root.split("/").at(-1)!))
			throw new Error("NODE_UPDATE_REVISION_ROOT_INVALID");
	}
	async #custody(signal: AbortSignal) {
		signal.throwIfAborted();
		if (
			process.platform !== "linux" ||
			process.getuid?.() !== 0 ||
			process.geteuid?.() !== 0 ||
			process.getegid?.() !== 0
		)
			throw new Error("NODE_UPDATE_ROOT_LINUX_REQUIRED");
		await officeInstallParents(this.#e.lockPath);
		await officeInstallLockFd(this.#e.lockPath, 0);
		await checkDirectory(this.#root);
		const machine = (await readOfficeInstallFile("/etc/machine-id", 64)).toString("utf8");
		if (!/^[0-9a-f]{32}\n?$/.test(machine) || officeInstallHash(machine.trim()) !== this.#e.machineIdSha256)
			throw new Error("NODE_UPDATE_HOST_IDENTITY_CHANGED");
		if (
			officeInstallHash(await readOfficeInstallFile(this.#e.runtimePath, 128 * 1024 ** 2)) !==
				this.#e.runtimeSha256 ||
			officeInstallHash(await readOfficeInstallFile(this.#e.unitPath, 65536)) !== this.#e.unitSha256
		)
			throw new Error("NODE_UPDATE_HOST_ENROLLMENT_CHANGED");
		for (const file of this.#e.dropIns) {
			if (officeInstallHash(await readOfficeInstallFile(file.path, 65536)) !== file.sha256)
				throw new Error("NODE_UPDATE_DROP_INS_CHANGED");
		}
		for (const file of this.#e.configuration) {
			const bytes = await readOfficeInstallFile(file.path, 1024 * 1024);
			try {
				if (officeInstallHash(bytes) !== file.sha256) throw new Error("NODE_UPDATE_CONFIGURATION_CHANGED");
			} finally {
				bytes.fill(0);
			}
		}
		return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
	}
	async #launcherBytes(artifactSha256: string) {
		const e = this.#e.launcher;
		return e
			? deriveNodeUpdateLauncher(
					await readOfficeInstallFile(e.templatePath, 65536),
					e.sha256,
					e.artifactSha256,
					artifactSha256,
				)
			: null;
	}
	async #launcherPlan(release: NodeUpdateRelease) {
		const before = await this.#launcherBytes(release.previous.artifactSha256),
			after = await this.#launcherBytes(release.artifact.sha256);
		if (before && release.artifact.bytes > 1024 * 1024) throw new Error("NODE_UPDATE_LAUNCHER_ARTIFACT_OVERSIZED");
		return {
			artifactPath: this.#e.installedPath,
			beforeArtifactSha256: release.previous.artifactSha256,
			afterArtifactSha256: release.artifact.sha256,
			launcherPath: this.#e.launcher?.path ?? null,
			beforeLauncherSha256: before ? officeInstallHash(before) : null,
			afterLauncherSha256: after ? officeInstallHash(after) : null,
		};
	}
	async #facts(expectedArtifact: string, running: boolean, launcherArtifact = expectedArtifact) {
		const output = officeInstallCommand("/usr/bin/systemctl", [
			"show",
			this.#e.service,
			`--property=${properties.join(",")}`,
		]);
		const pairs = output.split("\n").map((line) => {
			const at = line.indexOf("=");
			if (at < 1) throw new Error("NODE_UPDATE_SERVICE_STATE_INVALID");
			return [line.slice(0, at), line.slice(at + 1)] as const;
		});
		const fields = officeRecord(Object.fromEntries(pairs), properties);
		if (
			pairs.length !== properties.length ||
			fields.LoadState !== "loaded" ||
			fields.FragmentPath !== this.#e.unitPath ||
			fields.DropInPaths !== this.#e.dropIns.map((f) => f.path).join(" ") ||
			fields.User !== this.#e.serviceUser ||
			fields.Group !== this.#e.serviceGroup ||
			fields.ControlPID !== "0" ||
			fields.Job !== ""
		)
			throw new Error("NODE_UPDATE_SERVICE_ENROLLMENT_CHANGED");
		const installed = await readOfficeInstallFile(this.#e.installedPath, 64 * 1024 ** 2),
			stat = await lstat(this.#e.installedPath);
		if (
			officeInstallHash(installed) !== expectedArtifact ||
			(stat.mode & 0o7777) !== this.#e.installedMode ||
			stat.gid !== 0
		)
			throw new Error("NODE_UPDATE_INSTALLED_ARTIFACT_CHANGED");
		const launcher = await this.#launcherBytes(launcherArtifact);
		if (launcher && this.#e.launcher) {
			const current = await readOfficeInstallFile(this.#e.launcher.path, 65536),
				stat = await lstat(this.#e.launcher.path);
			if (!current.equals(launcher) || stat.gid !== 0 || (stat.mode & 0o7777) !== 0o555)
				throw new Error("NODE_UPDATE_INSTALLED_LAUNCHER_CHANGED");
		}
		if (running) {
			if (
				fields.ActiveState !== "active" ||
				fields.SubState !== "running" ||
				typeof fields.MainPID !== "string" ||
				!/^[1-9][0-9]*$/.test(fields.MainPID) ||
				typeof fields.InvocationID !== "string" ||
				!/^[0-9a-f]{32}$/.test(fields.InvocationID) ||
				!/^[1-9][0-9]*$/.test(String(fields.ExecMainStartTimestampMonotonic))
			)
				throw new Error("NODE_UPDATE_SERVICE_NOT_RUNNING");
			const pid = fields.MainPID,
				status = await readFile(`/proc/${pid}/status`, "utf8"),
				cmdline = await readFile(`/proc/${pid}/cmdline`);
			if (
				cmdline.toString("utf8") !== `${this.#e.runtimePath}\0--jitless\0${this.#e.installedPath}\0` ||
				!new RegExp(
					`^Uid:\\s+${this.#e.serviceUid}\\s+${this.#e.serviceUid}\\s+${this.#e.serviceUid}\\s+${this.#e.serviceUid}$`,
					"m",
				).test(status) ||
				(await realpath(`/proc/${pid}/exe`)) !== this.#e.runtimePath
			)
				throw new Error("NODE_UPDATE_SERVICE_PROCESS_CHANGED");
			const again = officeInstallCommand("/usr/bin/systemctl", [
				"show",
				this.#e.service,
				"--property=InvocationID",
				"--value",
			]);
			if (again !== fields.InvocationID) throw new Error("NODE_UPDATE_SERVICE_INVOCATION_CHANGED");
		} else {
			if (fields.ActiveState !== "inactive" || fields.SubState !== "dead" || fields.MainPID !== "0")
				throw new Error("NODE_UPDATE_SERVICE_NOT_STOPPED");
			const cgroup = `/sys/fs/cgroup/system.slice/${this.#e.service}`;
			const populated = await readFile(`${cgroup}/cgroup.events`, "utf8").catch((error) => {
				if (code(error, "ENOENT")) return "populated 0\n";
				throw error;
			});
			if (
				!/^populated 0$/m.test(populated) ||
				(fields.ControlGroup !== "" && fields.ControlGroup !== `/system.slice/${this.#e.service}`)
			)
				throw new Error("NODE_UPDATE_SERVICE_DESCENDANTS_REMAIN");
		}
		return {
			artifactSha256: expectedArtifact,
			launcherSha256: launcher ? officeInstallHash(launcher) : null,
			fields,
		};
	}
	async #lxd(path: string, signal: AbortSignal): Promise<unknown> {
		await officeInstallParents(this.#e.lxdSocket);
		const socket = await lstat(this.#e.lxdSocket);
		if (
			!socket.isSocket() ||
			socket.uid !== 0 ||
			(socket.mode & 0o0002) !== 0 ||
			(await realpath(this.#e.lxdSocket)) !== this.#e.lxdSocket
		)
			throw new Error("NODE_UPDATE_LXD_SOCKET_UNSAFE");
		return new Promise((resolve, reject) => {
			const req = request(
				{
					socketPath: this.#e.lxdSocket,
					path,
					method: "GET",
					signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
				},
				(response) => {
					const chunks: Buffer[] = [];
					let size = 0;
					response.on("data", (chunk: Buffer) => {
						size += chunk.length;
						if (size > 1024 * 1024) req.destroy(new Error("bounded LXD read"));
						else chunks.push(chunk);
					});
					response.on("error", () => reject(new Error("NODE_UPDATE_LXD_UNAVAILABLE")));
					response.on("end", () => {
						try {
							const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
							if (
								response.statusCode !== 200 ||
								envelope.type !== "sync" ||
								envelope.status_code !== 200 ||
								!Object.hasOwn(envelope, "metadata")
							)
								throw new Error();
							resolve(envelope.metadata);
						} catch {
							reject(new Error("NODE_UPDATE_LXD_UNAVAILABLE"));
						}
					});
				},
			);
			req.on("error", () => reject(new Error("NODE_UPDATE_LXD_UNAVAILABLE")));
			req.end();
		});
	}
	async #quiet(signal: AbortSignal) {
		const instances = await this.#lxd(`/1.0/instances?project=${this.#e.lxdProject}&recursion=1`, signal),
			operations = await this.#lxd(`/1.0/operations?project=${this.#e.lxdProject}`, signal);
		if (
			!Array.isArray(instances) ||
			instances.length > 256 ||
			instances.some(
				(i: unknown) =>
					typeof i !== "object" ||
					i === null ||
					!("status" in i) ||
					i.status !== "Stopped" ||
					!("status_code" in i) ||
					i.status_code !== 102 ||
					!("name" in i) ||
					typeof i.name !== "string" ||
					!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(i.name),
			) ||
			typeof operations !== "object" ||
			operations === null ||
			Array.isArray(operations) ||
			Object.values(operations).some((list: unknown) => !Array.isArray(list) || list.length !== 0)
		)
			throw new Error("NODE_UPDATE_PHYSICAL_DRAIN_INCOMPLETE");
		const measured = instances
			.map((value: unknown) => {
				const i = value as { name: string };
				return { name: i.name, status: "Stopped", statusCode: 102 };
			})
			.sort((a, b) => a.name.localeCompare(b.name));
		if (new Set(measured.map((i) => i.name)).size !== measured.length)
			throw new Error("NODE_UPDATE_PHYSICAL_DRAIN_INCOMPLETE");
		return { project: this.#e.lxdProject, instances: measured, pendingOperations: 0 };
	}
	async #health(signal: AbortSignal, service: { fields: Record<string, unknown> }) {
		const pid = String(service.fields.MainPID);
		if (!/^[1-9][0-9]*$/.test(pid)) throw new Error("NODE_UPDATE_HEALTH_LISTENER_NOT_OWNED");
		const ownedSocket = async (url: string) => {
			const names = await readdir(`/proc/${pid}/fd`);
			const links = await Promise.all(
				names.map((name) =>
					readlink(`/proc/${pid}/fd/${name}`).catch((error) => {
						if (code(error, "ENOENT")) return "";
						throw error;
					}),
				),
			);
			return nodeUpdateHealthSocket(
				await readFile(`/proc/${pid}/net/tcp`, "utf8"),
				links,
				Number(new URL(url).port),
			);
		};
		const measured: { url: string; ok: true; listenerInode: string; pid: string }[] = [];
		for (const url of this.#e.healthUrls) {
			const listenerInode = await ownedSocket(url);
			const response = await fetch(url, {
				redirect: "error",
				signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
			});
			if (response.status !== 200 || !response.body) throw new Error("NODE_UPDATE_HEALTH_UNCONFIRMED");
			const reader = response.body.getReader();
			let size = 0;
			const chunks: Uint8Array[] = [];
			try {
				while (true) {
					const item = await reader.read();
					if (item.done) break;
					size += item.value.length;
					if (size > 1024) throw new Error("NODE_UPDATE_HEALTH_UNCONFIRMED");
					chunks.push(item.value);
				}
			} finally {
				await reader.cancel();
				reader.releaseLock();
			}
			if (officeCanonical(JSON.parse(Buffer.concat(chunks).toString("utf8"))) !== '{"ok":true}')
				throw new Error("NODE_UPDATE_HEALTH_UNCONFIRMED");
			if ((await ownedSocket(url)) !== listenerInode) throw new Error("NODE_UPDATE_HEALTH_LISTENER_CHANGED");
			measured.push({ url, ok: true, listenerInode, pid });
		}
		return measured;
	}
	async #prior(phase: string, release: NodeUpdateRelease) {
		const value = officeRecord((await readRecord(join(this.#root, `${phase}-physical.json`), 65536)).value, [
			"schema",
			"hostEnrollmentSha256",
			"publicationPlan",
			"intentSha256",
			"bootId",
			"facts",
			"drain",
			"receipt",
		]);
		if (officeCanonical(value.publicationPlan) !== officeCanonical(await this.#launcherPlan(release)))
			throw new Error("NODE_UPDATE_PUBLICATION_PLAN_CHANGED");
		if (value.hostEnrollmentSha256 !== officeDigest(this.#e)) throw new Error("NODE_UPDATE_HOST_ENROLLMENT_CHANGED");
		const { receipt, ...evidence } = value,
			r = officeRecord(receipt, ["schema", "intentSha256", "state", "evidenceSha256", "drain"]);
		if (
			value.schema !== "qorpera.node-update-physical-evidence/v1" ||
			value.intentSha256 !== officeDigest((await readRecord(join(this.#root, `${phase}-intent.json`))).value) ||
			r.intentSha256 !== value.intentSha256 ||
			r.evidenceSha256 !== officeDigest(evidence) ||
			r.state !== "succeeded"
		)
			throw new Error("NODE_UPDATE_PHYSICAL_EVIDENCE_CHANGED");
		return value;
	}
	async #authorize(intent: NodeUpdateIntent, drain: NodeUpdateDrain | null, signal: AbortSignal) {
		if (!drain) throw new Error("NODE_UPDATE_DRAIN_REQUIRED");
		await this.#registry.check(intent, drain, signal);
	}
	async #control(
		action: "stop" | "start",
		signal: AbortSignal,
		expected: { artifactSha256: string; launcherSha256: string | null; fields: Record<string, unknown> },
	): Promise<void> {
		const lock = await officeInstallLockFd(this.#e.lockPath, 0);
		await dispatchNodeUpdateForUnchangedInvocation(
			expected,
			() => this.#facts(expected.artifactSha256, action === "stop"),
			() =>
				new Promise<void>((resolve, reject) => {
					const child = spawn("/usr/bin/systemctl", [action, this.#e.service], {
						cwd: "/",
						env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" },
						stdio: ["ignore", "ignore", "ignore", lock],
						signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
						killSignal: "SIGKILL",
					});
					child.on("error", () => reject(new Error("NODE_UPDATE_SYSTEMD_OUTCOME_UNCONFIRMED")));
					child.on("exit", (status) =>
						status === 0 ? resolve() : reject(new Error("NODE_UPDATE_SYSTEMD_OUTCOME_UNCONFIRMED")),
					);
				}),
		);
	}
	async verifyAdmission(
		release: NodeUpdateRelease,
		intent: NodeUpdateIntent,
		drain: NodeUpdateDrain,
		signal: AbortSignal,
	): Promise<void> {
		const bootId = await this.#custody(signal),
			started = await this.#prior("start", release),
			current = await this.#facts(release.artifact.sha256, true);
		if (started.bootId !== bootId || officeCanonical(started.facts) !== officeCanonical(current))
			throw new Error("NODE_UPDATE_SUCCESSOR_INVOCATION_CHANGED");
		const health = await this.#health(signal, current),
			physicalDrain = await this.#quiet(signal);
		if (officeCanonical(await this.#facts(release.artifact.sha256, true)) !== officeCanonical(current))
			throw new Error("NODE_UPDATE_SUCCESSOR_INVOCATION_CHANGED");
		const bytes = Buffer.from(
			`${officeCanonical({ schema: "qorpera.node-update-admission-check/v1", intentSha256: officeDigest(intent), hostEnrollmentSha256: officeDigest(this.#e), bootId, service: current, health, physicalDrain, drain })}\n`,
		);
		await publish(this.#root, "resume-admission-check.json", bytes);
		if (!(await readRecord(join(this.#root, "resume-admission-check.json"), 65536)).bytes.equals(bytes))
			throw new Error("NODE_UPDATE_ADMISSION_CHECK_CONFLICT");
		if (officeCanonical(await this.#facts(release.artifact.sha256, true)) !== officeCanonical(current))
			throw new Error("NODE_UPDATE_SUCCESSOR_INVOCATION_CHANGED");
	}
	async execute(
		release: NodeUpdateRelease,
		intent: NodeUpdateIntent,
		drain: NodeUpdateDrain | null,
		signal: AbortSignal,
	): Promise<NodeUpdateReceipt> {
		const bootId = await this.#custody(signal),
			publicationPlan = await this.#launcherPlan(release);
		if (
			release.machineIdSha256 !== this.#e.machineIdSha256 ||
			intent.releaseSha256 !== officeDigest(release) ||
			intent.phase === "drain" ||
			intent.phase === "resume"
		)
			throw new Error("NODE_UPDATE_PHYSICAL_PHASE_INVALID");
		const claim = officeRecord((await readRecord(join(this.#root, `${intent.phase}-effect.json`))).value, [
			"intentSha256",
		]);
		if (claim.intentSha256 !== officeDigest(intent)) throw new Error("NODE_UPDATE_PHYSICAL_CLAIM_DIFFERS");
		if (
			!(await publish(
				this.#root,
				`${intent.phase}-host-claim.json`,
				Buffer.from(`${officeCanonical({ intentSha256: officeDigest(intent), bootId, publicationPlan })}\n`),
			))
		)
			throw new Error("NODE_UPDATE_PHYSICAL_ALREADY_CLAIMED");
		let facts: unknown;
		if (intent.phase === "stage") {
			const before = await this.#facts(release.previous.artifactSha256, true),
				response = await fetch(`${this.#e.artifactBaseUrl}${release.artifact.sha256}.mjs`, {
					redirect: "error",
					credentials: "omit",
					signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
				});
			if (response.status !== 200 || !response.body) throw new Error("NODE_UPDATE_ARTIFACT_UNAVAILABLE");
			const reader = response.body.getReader(),
				chunks: Uint8Array[] = [];
			let size = 0;
			try {
				while (true) {
					const item = await reader.read();
					if (item.done) break;
					size += item.value.length;
					if (size > release.artifact.bytes) throw new Error("NODE_UPDATE_ARTIFACT_OVERSIZED");
					chunks.push(item.value);
				}
			} finally {
				await reader.cancel();
				reader.releaseLock();
			}
			const bytes = Buffer.concat(chunks);
			if (bytes.length !== release.artifact.bytes || officeInstallHash(bytes) !== release.artifact.sha256)
				throw new Error("NODE_UPDATE_ARTIFACT_CHANGED");
			await publish(this.#root, "artifact.mjs", bytes);
			if (!(await readOfficeInstallFile(join(this.#root, "artifact.mjs"), release.artifact.bytes)).equals(bytes))
				throw new Error("NODE_UPDATE_STAGED_ARTIFACT_CHANGED");
			const launcher = await this.#launcherBytes(release.artifact.sha256);
			if (launcher) {
				await publish(this.#root, "launcher.py", launcher);
				if (!(await readOfficeInstallFile(join(this.#root, "launcher.py"), 65536)).equals(launcher))
					throw new Error("NODE_UPDATE_STAGED_LAUNCHER_CHANGED");
			}
			facts = {
				before,
				stagedSha256: officeInstallHash(bytes),
				stagedLauncherSha256: launcher ? officeInstallHash(launcher) : null,
			};
		} else if (intent.phase === "stop") {
			const staged = await this.#prior("stage", release),
				before = await this.#facts(release.previous.artifactSha256, true);
			const stageFacts = officeRecord(staged.facts, ["before", "stagedSha256", "stagedLauncherSha256"]);
			if (staged.bootId !== bootId || officeCanonical(stageFacts.before) !== officeCanonical(before))
				throw new Error("NODE_UPDATE_PREDECESSOR_INVOCATION_CHANGED");
			const physicalDrain = await this.#quiet(signal);
			await this.#custody(signal);
			await this.#authorize(intent, drain, signal);
			await this.#control("stop", signal, before);
			facts = { before, after: await this.#facts(release.previous.artifactSha256, false), physicalDrain };
		} else if (intent.phase === "install") {
			const stopped = await this.#prior("stop", release);
			if (stopped.bootId !== bootId) throw new Error("NODE_UPDATE_BOOT_CHANGED");
			await this.#facts(release.previous.artifactSha256, false);
			await this.#quiet(signal);
			const bytes = await readOfficeInstallFile(join(this.#root, "artifact.mjs"), release.artifact.bytes);
			if (bytes.length !== release.artifact.bytes || officeInstallHash(bytes) !== release.artifact.sha256)
				throw new Error("NODE_UPDATE_STAGED_ARTIFACT_CHANGED");
			const stagedLauncher = await this.#launcherBytes(release.artifact.sha256);
			if (
				stagedLauncher &&
				!(await readOfficeInstallFile(join(this.#root, "launcher.py"), 65536)).equals(stagedLauncher)
			)
				throw new Error("NODE_UPDATE_STAGED_LAUNCHER_CHANGED");
			const prepare = async (path: string, content: Buffer, mode: number) => {
				await officeInstallParents(path);
				const temporary = join(
					dirname(path),
					`.node-update-${intent.releaseSha256}-${path.endsWith(".py") ? "launcher" : "artifact"}`,
				);
				const file = await open(
					temporary,
					constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
					0o600,
				);
				try {
					await file.writeFile(content);
					await file.chown(0, 0);
					await file.chmod(mode);
					await file.sync();
				} finally {
					await file.close();
				}
				return temporary;
			};
			const temporary = await prepare(this.#e.installedPath, bytes, this.#e.installedMode);
			const temporaryLauncher =
				stagedLauncher && this.#e.launcher ? await prepare(this.#e.launcher.path, stagedLauncher, 0o555) : null;
			await this.#custody(signal);
			await this.#authorize(intent, drain, signal);
			await this.#facts(release.previous.artifactSha256, false);
			await rename(temporary, this.#e.installedPath);
			await syncDirectory(dirname(this.#e.installedPath));
			if (temporaryLauncher && this.#e.launcher) {
				// A crash between publications has no sealed result. Inspection never
				// repairs this intermediate pair and no start can follow it.
				await this.#custody(signal);
				await this.#authorize(intent, drain, signal);
				await this.#facts(release.artifact.sha256, false, release.previous.artifactSha256);
				await rename(temporaryLauncher, this.#e.launcher.path);
				await syncDirectory(dirname(this.#e.launcher.path));
			}
			facts = await this.#facts(release.artifact.sha256, false);
		} else if (intent.phase === "start") {
			if ((await this.#prior("install", release)).bootId !== bootId) throw new Error("NODE_UPDATE_BOOT_CHANGED");
			await this.#facts(release.artifact.sha256, false);
			await this.#quiet(signal);
			await this.#custody(signal);
			await this.#authorize(intent, drain, signal);
			await this.#control("start", signal, await this.#facts(release.artifact.sha256, false));
			facts = await this.#facts(release.artifact.sha256, true);
		} else {
			const started = await this.#prior("start", release);
			facts = await this.#facts(release.artifact.sha256, true);
			if (started.bootId !== bootId || officeCanonical(started.facts) !== officeCanonical(facts))
				throw new Error("NODE_UPDATE_SUCCESSOR_INVOCATION_CHANGED");
			const service = facts as {
				artifactSha256: string;
				launcherSha256: string | null;
				fields: Record<string, unknown>;
			};
			facts = { service, health: await this.#health(signal, service), physicalDrain: await this.#quiet(signal) };
			if (officeCanonical(await this.#facts(release.artifact.sha256, true)) !== officeCanonical(service))
				throw new Error("NODE_UPDATE_SUCCESSOR_INVOCATION_CHANGED");
		}
		await this.#custody(signal);
		const evidence = {
				schema: "qorpera.node-update-physical-evidence/v1",
				hostEnrollmentSha256: officeDigest(this.#e),
				publicationPlan,
				intentSha256: officeDigest(intent),
				bootId,
				facts,
				drain,
			},
			receipt: NodeUpdateReceipt = {
				schema: "qorpera.runtime-node-update-receipt/v1",
				intentSha256: officeDigest(intent),
				state: "succeeded",
				evidenceSha256: officeDigest(evidence),
				drain,
			};
		const bytes = Buffer.from(`${officeCanonical({ ...evidence, receipt })}\n`);
		await publish(this.#root, `${intent.phase}-physical.json`, bytes);
		if (!(await readRecord(join(this.#root, `${intent.phase}-physical.json`), 65536)).bytes.equals(bytes))
			throw new Error("NODE_UPDATE_PHYSICAL_RECEIPT_CONFLICT");
		return receipt;
	}
	async inspect(
		release: NodeUpdateRelease,
		intent: NodeUpdateIntent,
		signal: AbortSignal,
	): Promise<NodeUpdateReceipt | null> {
		await this.#custody(signal);
		const retained = await this.#prior(intent.phase, release).catch((error) => {
			if (code(error, "ENOENT")) return null;
			throw error;
		});
		if (!retained) return null;
		const { receipt, ...evidence } = retained;
		if (
			retained.schema !== "qorpera.node-update-physical-evidence/v1" ||
			retained.intentSha256 !== officeDigest(intent) ||
			typeof receipt !== "object" ||
			receipt === null ||
			!("evidenceSha256" in receipt) ||
			receipt.evidenceSha256 !== officeDigest(evidence)
		)
			throw new Error("NODE_UPDATE_PHYSICAL_EVIDENCE_CHANGED");
		return parseNodeUpdateReceipt(receipt, intent, retained.drain as NodeUpdateDrain | null);
	}
}
