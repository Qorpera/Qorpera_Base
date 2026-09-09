import { constants } from "node:fs";
import { type FileHandle, lstat, open, readlink, realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { COMPANY_COMPUTER_SERVICE_CGROUP } from "@qorpera/contracts";
import {
	assertCompanyComputerImageArtifact,
	readCompanyComputerLinuxMetadata,
} from "./cloud-company-computer-linux-host.ts";
import {
	type CompanyComputerServiceUnitState,
	readCompanyComputerServiceSystemdState,
} from "./cloud-company-computer-service-start-systemd.ts";
import { assertCompanyComputerSystemdImage, office, systemctl } from "./cloud-company-computer-systemd.ts";

export interface CompanyComputerServiceStopObservation {
	readonly service: CompanyComputerServiceUnitState;
	readonly cgroupState: "absent" | "empty" | "populated";
}
export interface CompanyComputerServiceStopManager {
	inspect(signal: AbortSignal): Promise<CompanyComputerServiceStopObservation>;
	stop(signal: AbortSignal): Promise<void>;
}
export function assertCompanyComputerServiceStopped(value: CompanyComputerServiceStopObservation): void {
	const service = value.service;
	if (
		!["inactive", "failed"].includes(service.activeState) ||
		(service.activeState === "inactive" ? service.subState !== "dead" : service.subState !== "failed") ||
		service.mainPid !== 0 ||
		service.controlPid !== 0 ||
		service.jobId !== 0 ||
		!["absent", "empty"].includes(value.cgroupState)
	)
		throw new Error("OFFICE_SERVICE_NOT_STOPPED");
}
const missing = (e: unknown) => e instanceof Error && "code" in e && e.code === "ENOENT";
const root = "/sys/fs/cgroup";
/** The populated event covers descendants, including processes absent from
 * the unit's main PID. Never infer emptiness from a directory listing or PID 0. */
export function parseCompanyComputerCgroupEvents(value: string): "empty" | "populated" {
	if (typeof value !== "string" || Buffer.byteLength(value) > 4096 || !/^(?:[a-z_]+ [0-9]+\n)+$/.test(value))
		throw new Error("OFFICE_CGROUP_UNCONFIRMED");
	const fields = new Map<string, string>();
	for (const line of value.trimEnd().split("\n")) {
		const [key, value] = line.split(" ");
		if (fields.has(key)) throw new Error("OFFICE_CGROUP_UNCONFIRMED");
		fields.set(key, value);
	}
	if (!["0", "1"].includes(fields.get("populated") ?? "") || !["0", "1"].includes(fields.get("frozen") ?? ""))
		throw new Error("OFFICE_CGROUP_UNCONFIRMED");
	return fields.get("populated") === "0" ? "empty" : "populated";
}
async function controlNamespace() {
	if (
		process.platform !== "linux" ||
		process.getuid?.() !== 0 ||
		process.geteuid?.() !== 0 ||
		process.getgid?.() !== 0 ||
		process.getegid?.() !== 0
	)
		throw new Error("OFFICE_STOP_ROOT_REQUIRED");
	for (const kind of ["mnt", "cgroup"])
		if ((await readlink(`/proc/self/ns/${kind}`)) !== (await readlink(`/proc/1/ns/${kind}`)))
			throw new Error("OFFICE_STOP_NAMESPACE_CHANGED");
	const mounts = (await readCompanyComputerLinuxMetadata("/proc/self/mountinfo", 1048576))
		.trimEnd()
		.split("\n")
		.map((line) => line.split(" "));
	const selected = mounts.filter((fields) => fields[4] === root || fields[4]?.startsWith(`${root}/`));
	if (
		selected.length !== 1 ||
		selected[0][3] !== "/" ||
		selected[0][4] !== root ||
		selected[0][selected[0].indexOf("-") + 1] !== "cgroup2"
	)
		throw new Error("OFFICE_CGROUP_MOUNT_UNCONFIRMED");
}
async function sameDirectory(handle: FileHandle, path: string) {
	const current = await handle.stat(),
		named = await lstat(path);
	if (
		!current.isDirectory() ||
		current.uid !== 0 ||
		current.gid !== 0 ||
		(current.mode & 0o6022) !== 0 ||
		current.dev !== named.dev ||
		current.ino !== named.ino ||
		(await realpath(`/proc/self/fd/${handle.fd}`)) !== path
	)
		throw new Error("OFFICE_CGROUP_CHANGED");
}
async function cgroupState(): Promise<CompanyComputerServiceStopObservation["cgroupState"]> {
	await controlNamespace();
	await assertCompanyComputerImageArtifact(root, true);
	const handles: Array<{ handle: FileHandle; path: string }> = [];
	try {
		const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		handles.push({ handle, path: root });
		for (const part of ["system.slice", office]) {
			const parent = handles.at(-1)!;
			await sameDirectory(parent.handle, parent.path);
			try {
				const child = await open(
					`/proc/self/fd/${parent.handle.fd}/${part}`,
					constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
				);
				handles.push({ handle: child, path: `${parent.path}/${part}` });
			} catch (error) {
				if (!missing(error)) throw error;
				for (const item of handles) await sameDirectory(item.handle, item.path);
				await controlNamespace();
				return "absent";
			}
		}
		const directory = handles.at(-1)!;
		await sameDirectory(directory.handle, root + COMPANY_COMPUTER_SERVICE_CGROUP);
		const file = await open(
			`/proc/self/fd/${directory.handle.fd}/cgroup.events`,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		try {
			const before = await file.stat();
			if (!before.isFile() || before.uid !== 0 || before.gid !== 0 || (before.mode & 0o6022) !== 0)
				throw new Error("OFFICE_CGROUP_UNPROTECTED");
			const buffer = Buffer.alloc(4097);
			const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
			if (bytesRead > 4096) throw new Error("OFFICE_CGROUP_UNCONFIRMED");
			const state = parseCompanyComputerCgroupEvents(
				new TextDecoder("utf8", { fatal: true }).decode(buffer.subarray(0, bytesRead)),
			);
			const after = await file.stat(),
				named = await lstat(`${directory.path}/cgroup.events`);
			if (
				before.dev !== after.dev ||
				before.ino !== after.ino ||
				before.dev !== named.dev ||
				before.ino !== named.ino
			)
				throw new Error("OFFICE_CGROUP_CHANGED");
			for (const item of handles) await sameDirectory(item.handle, item.path);
			await controlNamespace();
			return state;
		} finally {
			await file.close();
		}
	} finally {
		for (const { handle } of handles.reverse()) await handle.close();
	}
}
/** Fixed ordinary-unit control only. Production always measures PID 1's
 * cgroup namespace and descriptor-bound kernel files; no path comes from RPC. */
export function createCompanyComputerServiceStopSystemdManager(): CompanyComputerServiceStopManager {
	return {
		async inspect(signal) {
			signal.throwIfAborted();
			await controlNamespace();
			const before = await readCompanyComputerServiceSystemdState(signal),
				group = await cgroupState(),
				after = await readCompanyComputerServiceSystemdState(signal);
			signal.throwIfAborted();
			if (!isDeepStrictEqual(before, after)) throw new Error("OFFICE_STOP_SERVICE_CHANGED");
			return { service: after, cgroupState: group };
		},
		async stop(signal) {
			signal.throwIfAborted();
			await controlNamespace();
			await assertCompanyComputerSystemdImage();
			await systemctl(["stop", office], 80000, signal);
		},
	};
}
