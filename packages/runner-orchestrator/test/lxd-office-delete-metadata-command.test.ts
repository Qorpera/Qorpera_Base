import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLxdOfficeDeleteMetadataCommand } from "../src/lxd-office-delete-metadata-command.ts";
import { officeDigest } from "../src/lxd-office-image-provenance.ts";
import { OFFICE_PROVIDER_USER } from "../src/lxd-office-installation.ts";
import { officePhysicalFixture } from "./fixtures/office-physical-policy.ts";

// Injected process/filesystem/lock/reconciliation boundaries. The production
// protected-file reader, namespace fallback, policy parser and mount check run.
// These tests do not establish actual Linux UID changes or inherited flocks.
const injected = vi.hoisted(() => ({
	readlink: vi.fn(),
	open: vi.fn(),
	lstat: vi.fn(),
	realpath: vi.fn(),
	readFile: vi.fn(),
	command: vi.fn(),
	parents: vi.fn(),
	lock: vi.fn(),
	receipt: vi.fn(),
	reconcile: vi.fn(),
}));
vi.mock("node:fs/promises", () => injected);
vi.mock("../src/lxd-office-installation-host.ts", () => ({
	officeInstallCommand: injected.command,
	officeInstallParents: injected.parents,
	officeInstallLockFd: injected.lock,
}));
vi.mock("../src/lxd-office-delete-disposition.ts", () => ({ readLxdOfficeDeleteDisposition: injected.receipt }));
vi.mock("../src/lxd-office-delete-reconciliation.ts", () => ({ reconcileLxdOfficeDeleteMetadata: injected.reconcile }));

const uid = 20043,
	gid = 20043;
const boot = "a7d55b0e-e23c-4523-910f-de6ce2e5b5bc",
	namespace = "mnt:[4026531832]";
const recordPath = "/run/qorpera-office-provider/host-mount-namespace.json";
const configPath = "/etc/qorpera-office/service.json",
	policyPath = "/etc/qorpera-office/policy.json";
const installLock = "/run/qorpera-office-provider-install/install.lock";
const auditId = "12345678-1234-4234-8234-000000000041";
const descriptors = new Map<string, PropertyDescriptor | undefined>();
const files = new Map<string, Buffer>();
let allocationId: string, journal: string, serviceState: string;
let record: { schema: string; bootId: string; namespace: string };
let boundaryCount: number;
let beforeBoundary: (count: number) => void;

function bytes(path: string): Buffer {
	if (path === recordPath) return Buffer.from(JSON.stringify(record));
	const value = files.get(path);
	if (!value) throw new Error(`Unexpected injected read: ${path}`);
	return value;
}

beforeEach(() => {
	vi.resetAllMocks();
	files.clear();
	for (const [name, value] of Object.entries({
		platform: "linux",
		getuid: (): number => uid,
		geteuid: (): number => uid,
		getgid: (): number => gid,
		getegid: (): number => gid,
	})) {
		descriptors.set(name, Object.getOwnPropertyDescriptor(process, name));
		Object.defineProperty(process, name, { configurable: true, value });
	}
	const f = officePhysicalFixture();
	allocationId = f.binding.allocationId;
	journal = f.policy.journal.path;
	files.set(policyPath, Buffer.from(JSON.stringify(f.policy)));
	files.set(
		configPath,
		Buffer.from(
			JSON.stringify({
				schema: "qorpera.lxd-office-provider-service/v1",
				policyPath,
				provenancePath: "/etc/qorpera-office/provenance.json",
				planPath: "/etc/qorpera-office/plan.json",
				registryUrl: "https://control.example",
				registryCredential: {
					path: "/etc/qorpera-office/provider.credential",
					bytes: 64,
					sha256: "a".repeat(64),
				},
				inventoryLimits: {
					maxEntries: 100,
					maxDepth: 4,
					maxFileBytes: 1024,
					maxTotalBytes: 4096,
					maxManifestBytes: 65536,
				},
				pollIntervalMs: 2000,
			}),
		),
	);
	files.set("/proc/sys/kernel/random/boot_id", Buffer.from(`${boot}\n`));
	files.set(
		"/proc/self/status",
		Buffer.from(
			`Uid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t${gid}\t${gid}\t${gid}\t${gid}\nGroups:\t${gid}\nCapInh:\t0000000000000000\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapAmb:\t0000000000000000\nNoNewPrivs:\t1\n`,
		),
	);
	files.set(
		"/proc/self/mountinfo",
		Buffer.from("42 1 0:1 / / rw - ext4 /dev/vda rw\n43 1 8:16 / /mnt/office-journal rw - ext4 /dev/vdb rw\n"),
	);
	files.set("/proc/self/fdinfo/10", Buffer.from("mnt_id:\t42\n"));
	files.set("/proc/self/fdinfo/11", Buffer.from("mnt_id:\t43\n"));
	record = { schema: "qorpera.lxd-office-host-namespace/v1", bootId: boot, namespace };
	serviceState =
		"LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nControlPID=0\nJob=\nUnitFileState=disabled";
	boundaryCount = 0;
	beforeBoundary = () => {};
	injected.command.mockImplementation((file: string) => {
		if (file === "/usr/bin/getent") return `${OFFICE_PROVIDER_USER}:x:${uid}:${gid}::/nonexistent:/usr/sbin/nologin`;
		if (file === "/usr/bin/systemctl") return serviceState;
		throw new Error(`Unexpected injected command: ${file}`);
	});
	injected.parents.mockResolvedValue(undefined);
	injected.lock.mockResolvedValue(3);
	injected.receipt.mockResolvedValue({ plan: { providerBindingSha256: officeDigest(f.binding) } });
	injected.readFile.mockImplementation(async (path: string) => bytes(path).toString("utf8"));
	injected.readlink.mockImplementation(async (path: string) => {
		if (path === "/proc/self/ns/mnt") return namespace;
		if (path === "/proc/1/ns/mnt") throw Object.assign(new Error("Restricted"), { code: "EACCES" });
		throw new Error(`Unexpected injected readlink: ${path}`);
	});
	injected.realpath.mockImplementation(async (path: string) => path);
	const info = (path: string) => ({
		isFile: () => true,
		isDirectory: () => false,
		uid: 0,
		gid: 0,
		mode: 0o100444,
		nlink: 1,
		size: bytes(path).length,
		dev: 1,
		ino: 2,
		ctimeMs: 1,
		mtimeMs: 1,
	});
	injected.lstat.mockImplementation(async (path: string) =>
		path === journal
			? { isDirectory: () => true, uid, gid, mode: 0o40700 }
			: files.has(path) || path === recordPath
				? info(path)
				: { isDirectory: () => true, uid: 0, mode: 0o40755 },
	);
	injected.open.mockImplementation(async (path: string) => {
		if (path === journal) return { fd: 11, close: async () => {} };
		const contents = bytes(path);
		let offset = 0;
		return {
			fd: 10,
			stat: async () => info(path),
			close: async () => {},
			read: async (buffer: Buffer, start: number, length: number) => {
				const bytesRead = contents.copy(buffer, start, offset, offset + length);
				offset += bytesRead;
				return { bytesRead };
			},
		};
	});
	injected.reconcile.mockImplementation(async (_root: string, _context: unknown, boundary: () => Promise<void>) => {
		for (let count = 1; count <= 3; count++) {
			beforeBoundary(count);
			await boundary();
			boundaryCount++;
		}
		return { metadataComplete: true, originalOutcome: "unknown" };
	});
});

afterEach(() => {
	for (const [name, descriptor] of descriptors) {
		if (descriptor) Object.defineProperty(process, name, descriptor);
		else Reflect.deleteProperty(process, name);
	}
	descriptors.clear();
});

describe("metadata child boundary (injected Linux observations)", () => {
	it("uses the protected boot-bound namespace fallback without requesting elevation", async () => {
		await expect(runLxdOfficeDeleteMetadataCommand(configPath, allocationId, auditId)).resolves.toMatchObject({
			metadataComplete: true,
		});
		expect(boundaryCount).toBe(3);
		expect(injected.open.mock.calls.filter(([path]) => path === recordPath)).toHaveLength(4);
		expect(
			injected.command.mock.calls.every(([file]) => ["/usr/bin/getent", "/usr/bin/systemctl"].includes(file)),
		).toBe(true);
		expect(injected.lock.mock.calls).toEqual(
			Array.from({ length: 3 }, () => [
				[installLock, 0],
				[`${journal}/adoption.lock`, uid],
			]).flat(),
		);
	});
	it.each(["root", "effective-uid", "effective-gid"])(
		"rejects %s before protected reads or reconciliation",
		async (fault) => {
			Object.defineProperty(
				process,
				fault === "effective-gid" ? "getegid" : fault === "root" ? "getuid" : "geteuid",
				{ value: () => 0 },
			);
			await expect(runLxdOfficeDeleteMetadataCommand(configPath, allocationId, auditId)).rejects.toThrow(
				"PROVIDER_UID_REQUIRED",
			);
			expect(injected.open).not.toHaveBeenCalled();
			expect(injected.reconcile).not.toHaveBeenCalled();
		},
	);
	it.each(["boot", "namespace"])("refuses a fallback record with another %s", async (fault) => {
		if (fault === "boot") record.bootId = "11111111-1111-4111-8111-111111111111";
		else record.namespace = "mnt:[999]";
		await expect(runLxdOfficeDeleteMetadataCommand(configPath, allocationId, auditId)).rejects.toThrow();
		expect(injected.reconcile).not.toHaveBeenCalled();
	});
	it.each([
		`Uid:\t${uid}\t${uid}\t0\t${uid}`,
		`Gid:\t${gid}\t${gid}\t0\t${gid}`,
		`Uid:\t${uid}\t${uid}\t${uid}\t0`,
		"Groups:\t0",
		"Groups:\t1001",
		"CapInh:\t0000000000000001",
		"CapPrm:\t0000000000000001",
		"CapEff:\t0000000000000001",
		"CapAmb:\t0000000000000001",
		"NoNewPrivs:\t0",
	])("refuses privilege-bearing process status %s", async (changed) => {
		const name = changed.split(":")[0];
		files.set(
			"/proc/self/status",
			Buffer.from(
				bytes("/proc/self/status")
					.toString()
					.replace(new RegExp(`^${name}:.*$`, "m"), changed),
			),
		);
		await expect(runLxdOfficeDeleteMetadataCommand(configPath, allocationId, auditId)).rejects.toThrow(
			"PROCESS_PRIVILEGED",
		);
		expect(injected.open).not.toHaveBeenCalled();
		expect(injected.reconcile).not.toHaveBeenCalled();
	});
	it("accepts cleared supplementary groups", async () => {
		files.set(
			"/proc/self/status",
			Buffer.from(
				bytes("/proc/self/status")
					.toString()
					.replace(/^Groups:.*$/m, "Groups:"),
			),
		);
		await expect(runLxdOfficeDeleteMetadataCommand(configPath, allocationId, auditId)).resolves.toMatchObject({
			metadataComplete: true,
		});
	});
	it("rechecks process privileges before each publication boundary", async () => {
		beforeBoundary = (count) => {
			if (count === 2)
				files.set(
					"/proc/self/status",
					Buffer.from(bytes("/proc/self/status").toString().replace("NoNewPrivs:\t1", "NoNewPrivs:\t0")),
				);
		};
		await expect(runLxdOfficeDeleteMetadataCommand(configPath, allocationId, auditId)).rejects.toThrow(
			"PROCESS_PRIVILEGED",
		);
		expect(boundaryCount).toBe(1);
	});
	it("rechecks fallback authority before the next publication boundary", async () => {
		beforeBoundary = (count) => {
			if (count === 2) record.namespace = "mnt:[999]";
		};
		await expect(runLxdOfficeDeleteMetadataCommand(configPath, allocationId, auditId)).rejects.toThrow(
			"HOST_MOUNT_NAMESPACE_REQUIRED",
		);
		expect(boundaryCount).toBe(1);
	});
	it.each([installLock, "/mnt/office-journal/state/adoption.lock"])(
		"requires inherited kernel lock %s",
		async (missing) => {
			injected.lock.mockImplementation(async (path: string) => {
				if (path === missing) throw new Error("OFFICE_INSTALL_KERNEL_LOCK_REQUIRED");
				return 3;
			});
			await expect(runLxdOfficeDeleteMetadataCommand(configPath, allocationId, auditId)).rejects.toThrow(
				"KERNEL_LOCK_REQUIRED",
			);
			expect(boundaryCount).toBe(0);
		},
	);
	it("refuses a lock lost between metadata boundaries", async () => {
		beforeBoundary = (count) => {
			if (count === 2) injected.lock.mockRejectedValue(new Error("OFFICE_INSTALL_KERNEL_LOCK_REQUIRED"));
		};
		await expect(runLxdOfficeDeleteMetadataCommand(configPath, allocationId, auditId)).rejects.toThrow(
			"KERNEL_LOCK_REQUIRED",
		);
		expect(boundaryCount).toBe(1);
	});
	it.each([
		"ActiveState=active",
		"SubState=running",
		"MainPID=42",
		"ControlPID=42",
		"Job=42",
		"UnitFileState=enabled",
	])("requires stopped disabled state: %s", async (value) => {
		serviceState = serviceState.replace(new RegExp(`^${value.split("=")[0]}=.*$`, "m"), value);
		await expect(runLxdOfficeDeleteMetadataCommand(configPath, allocationId, auditId)).rejects.toThrow(
			"PROVIDER_NOT_STOPPED",
		);
		expect(boundaryCount).toBe(0);
	});
});
