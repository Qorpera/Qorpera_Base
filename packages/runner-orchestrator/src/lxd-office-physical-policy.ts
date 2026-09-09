import { isIP } from "node:net";
import { resolve } from "node:path";
import { type LxdOfficeGuestBinding, parseLxdOfficeGuestBinding } from "./lxd-office-guest.ts";
import {
	officeDigest,
	officeImagePublicKey,
	officeRecord,
	officeSha,
	verifyLxdOfficeImageProvenance,
} from "./lxd-office-image-provenance.ts";

type Guest = Omit<LxdOfficeGuestBinding, "schema" | "allocationId" | "providerPolicySha256">;
export interface LxdOfficeMountPolicy {
	mountPoint: string;
	root: "/";
	filesystem: string;
	source: string;
}
export interface LxdOfficePhysicalPolicy {
	schema: "qorpera.lxd-office-physical-policy/v2";
	guest: Guest;
	host: {
		machineIdSha256: string;
		socketPath: string;
		socketGid: number;
		certificateSha256: string;
		serverName: string;
		serverVersion: string;
		architecture: "x86_64" | "aarch64";
	};
	image: { bytes: number; guestPackageManifestSha256: string; statementSha256: string; verificationKeySpki: string };
	infrastructure: { projectSha256: string; networkSha256: string; storagePoolSha256: string };
	workbench: LxdOfficeMountPolicy & { serverAddress: string; uid: number; gid: number };
	journal: LxdOfficeMountPolicy & { path: string };
}

export function officePhysicalPath(value: unknown): string {
	if (
		typeof value !== "string" ||
		value === "/" ||
		value.length > 4096 ||
		resolve(value) !== value ||
		/[\x00-\x20\x7f\\]/.test(value)
	)
		throw new Error("INVALID_OFFICE_PHYSICAL_PATH");
	return value;
}

const guestKeys = [
	"providerId",
	"companyId",
	"environmentId",
	"companyComputerId",
	"logicalComputerId",
	"computerGeneration",
	"project",
	"imageFingerprint",
	"bootstrapSha256",
	"storagePool",
	"rootDiskBytes",
	"workbenchSource",
	"network",
	"cpus",
	"memoryBytes",
];
function guest(value: unknown): Guest {
	const parsed = parseLxdOfficeGuestBinding({
		...officeRecord(value, guestKeys),
		schema: "qorpera.lxd-office-guest/v2",
		allocationId: "11111111-1111-4111-8111-111111111111",
		providerPolicySha256: "0".repeat(64),
	});
	return Object.fromEntries(
		guestKeys.map((key) => [key, parsed[key as keyof LxdOfficeGuestBinding]]),
	) as unknown as Guest;
}
function id(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 2 ** 32 - 2)
		throw new Error("INVALID_OFFICE_HOST_ID");
	return value as number;
}
function mount(value: Record<string, unknown>): LxdOfficeMountPolicy {
	if (
		value.root !== "/" ||
		typeof value.filesystem !== "string" ||
		typeof value.source !== "string" ||
		!value.source ||
		value.source.length > 4096 ||
		/[\x00-\x20\x7f\\]/.test(value.source)
	)
		throw new Error("INVALID_OFFICE_MOUNT_POLICY");
	return {
		mountPoint: officePhysicalPath(value.mountPoint),
		root: "/",
		filesystem: value.filesystem,
		source: value.source,
	};
}

export function parseLxdOfficePhysicalPolicy(value: unknown): Readonly<LxdOfficePhysicalPolicy> {
	const p = officeRecord(value, ["schema", "guest", "host", "image", "infrastructure", "workbench", "journal"]);
	const infrastructure = officeRecord(p.infrastructure, ["projectSha256", "networkSha256", "storagePoolSha256"]);
	const h = officeRecord(p.host, [
		"machineIdSha256",
		"socketPath",
		"socketGid",
		"certificateSha256",
		"serverName",
		"serverVersion",
		"architecture",
	]);
	const i = officeRecord(p.image, ["bytes", "guestPackageManifestSha256", "statementSha256", "verificationKeySpki"]);
	const w = officeRecord(p.workbench, ["mountPoint", "root", "filesystem", "source", "serverAddress", "uid", "gid"]);
	const j = officeRecord(p.journal, ["mountPoint", "root", "filesystem", "source", "path"]);
	const g = guest(p.guest);
	const workbench = { ...mount(w), serverAddress: w.serverAddress as string, uid: id(w.uid), gid: id(w.gid) };
	const journal = { ...mount(j), path: officePhysicalPath(j.path) };
	if (
		p.schema !== "qorpera.lxd-office-physical-policy/v2" ||
		(h.architecture !== "x86_64" && h.architecture !== "aarch64") ||
		typeof h.serverName !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(h.serverName) ||
		typeof h.serverVersion !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9.+~-]{0,63}$/.test(h.serverVersion) ||
		!Number.isSafeInteger(i.bytes) ||
		(i.bytes as number) < 1 ||
		(i.bytes as number) > 1024 ** 4 ||
		typeof i.verificationKeySpki !== "string" ||
		workbench.mountPoint !== g.workbenchSource ||
		!["nfs", "nfs4"].includes(workbench.filesystem) ||
		!workbench.source.includes(":/") ||
		typeof w.serverAddress !== "string" ||
		!isIP(w.serverAddress) ||
		workbench.uid === 0 ||
		!["ext4", "xfs", "btrfs", "zfs"].includes(journal.filesystem) ||
		!(journal.path === journal.mountPoint || journal.path.startsWith(`${journal.mountPoint}/`)) ||
		journal.mountPoint === workbench.mountPoint ||
		journal.mountPoint.startsWith(`${workbench.mountPoint}/`) ||
		workbench.mountPoint.startsWith(`${journal.mountPoint}/`)
	)
		throw new Error("INVALID_OFFICE_PHYSICAL_POLICY");
	officeImagePublicKey(i.verificationKeySpki);
	const host: LxdOfficePhysicalPolicy["host"] = {
		machineIdSha256: officeSha(h.machineIdSha256),
		socketPath: officePhysicalPath(h.socketPath),
		socketGid: id(h.socketGid),
		certificateSha256: officeSha(h.certificateSha256),
		serverName: h.serverName,
		serverVersion: h.serverVersion,
		architecture: h.architecture,
	};
	if (
		[workbench.mountPoint, journal.path].some(
			(root) => host.socketPath === root || host.socketPath.startsWith(`${root}/`),
		)
	)
		throw new Error("INVALID_OFFICE_SOCKET_LOCATION");
	return Object.freeze({
		schema: "qorpera.lxd-office-physical-policy/v2",
		infrastructure: Object.freeze({
			projectSha256: officeSha(infrastructure.projectSha256),
			networkSha256: officeSha(infrastructure.networkSha256),
			storagePoolSha256: officeSha(infrastructure.storagePoolSha256),
		}),
		guest: Object.freeze(g),
		host: Object.freeze(host),
		image: Object.freeze({
			bytes: i.bytes as number,
			guestPackageManifestSha256: officeSha(i.guestPackageManifestSha256),
			statementSha256: officeSha(i.statementSha256),
			verificationKeySpki: i.verificationKeySpki,
		}),
		workbench: Object.freeze(workbench),
		journal: Object.freeze(journal),
	});
}

export function lxdOfficePhysicalPolicySha256(value: LxdOfficePhysicalPolicy): string {
	return officeDigest(parseLxdOfficePhysicalPolicy(value));
}

export function assertLxdOfficePhysicalBinding(policy: LxdOfficePhysicalPolicy, value: LxdOfficeGuestBinding): void {
	const binding = parseLxdOfficeGuestBinding(value);
	const observed = Object.fromEntries(guestKeys.map((key) => [key, binding[key as keyof LxdOfficeGuestBinding]]));
	if (
		officeDigest(observed) !== officeDigest(policy.guest) ||
		binding.providerPolicySha256 !== lxdOfficePhysicalPolicySha256(policy)
	)
		throw new Error("LXD_OFFICE_PHYSICAL_BINDING_MISMATCH");
}

export function assertLxdOfficePhysicalImage(policy: LxdOfficePhysicalPolicy, envelope: unknown): void {
	const statement = verifyLxdOfficeImageProvenance(
		envelope,
		policy.image.verificationKeySpki,
		policy.image.statementSha256,
	);
	const image = statement.image;
	if (
		image.fingerprint !== policy.guest.imageFingerprint ||
		image.architecture !== policy.host.architecture ||
		image.bytes !== policy.image.bytes ||
		image.bootstrapSha256 !== policy.guest.bootstrapSha256 ||
		image.guestPackageManifestSha256 !== policy.image.guestPackageManifestSha256
	)
		throw new Error("LXD_OFFICE_IMAGE_POLICY_MISMATCH");
}
