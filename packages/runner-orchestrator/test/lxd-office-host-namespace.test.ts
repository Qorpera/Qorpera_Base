import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertLxdOfficeHostNamespace } from "../src/lxd-office-physical-host.ts";

const files = vi.hoisted(() => ({ readlink: vi.fn(), open: vi.fn(), lstat: vi.fn(), realpath: vi.fn() }));
vi.mock("node:fs/promises", () => files);

const recordPath = "/run/qorpera-office-provider/host-mount-namespace.json";
const bootId = "a7d55b0e-e23c-4523-910f-de6ce2e5b5bc";
const namespace = "mnt:[4026531832]";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let record: { schema: string; bootId: string; namespace: string };
let owner: number;

beforeEach(() => {
	vi.resetAllMocks();
	Object.defineProperty(process, "platform", { value: "linux" });
	record = { schema: "qorpera.lxd-office-host-namespace/v1", bootId, namespace };
	owner = 0;
	const info = () => ({
		isFile: () => true,
		isDirectory: () => false,
		uid: owner,
		gid: 0,
		mode: 0o100444,
		nlink: 1,
		size: Buffer.byteLength(JSON.stringify(record)),
		dev: 1,
		ino: 2,
		ctimeMs: 1,
		mtimeMs: 1,
	});
	files.lstat.mockImplementation(async (path: string) =>
		path === recordPath ? info() : { isDirectory: () => true, uid: 0, mode: 0o40755 },
	);
	files.realpath.mockImplementation(async (path: string) => path);
	files.open.mockImplementation(async (path: string) => {
		const contents = Buffer.from(
			path === recordPath
				? JSON.stringify(record)
				: path === "/proc/self/fdinfo/10"
					? "mnt_id:\t42\n"
					: path === "/proc/self/mountinfo"
						? "42 1 0:1 / /run rw - tmpfs tmpfs rw\n"
						: "",
		);
		if (!contents.length) throw new Error(`Unexpected path: ${path}`);
		let position = 0;
		return {
			fd: 10,
			stat: async () => info(),
			close: async () => {},
			read: async (buffer: Buffer, offset: number, length: number) => {
				const bytesRead = contents.copy(buffer, offset, position, position + length);
				position += bytesRead;
				return { bytesRead };
			},
		};
	});
	files.readlink.mockImplementation(async (path: string) => (path === "/proc/self/ns/mnt" ? namespace : ""));
});
afterEach(() => Object.defineProperty(process, "platform", platform));

describe("unprivileged host namespace authority", () => {
	it.each(["", "EACCES", "EPERM"])("uses the protected current-boot record when PID 1 returns %j", async (result) => {
		files.readlink.mockImplementation(async (path: string) => {
			if (path === "/proc/self/ns/mnt") return namespace;
			if (result) throw Object.assign(new Error("Restricted"), { code: result });
			return "";
		});
		await expect(assertLxdOfficeHostNamespace(bootId)).resolves.toBe(namespace);
		expect(files.open).toHaveBeenCalledWith(recordPath, expect.any(Number));
	});
	it("accepts matching direct kernel evidence without reading a startup record", async () => {
		files.readlink.mockResolvedValue(namespace);
		await expect(assertLxdOfficeHostNamespace(bootId)).resolves.toBe(namespace);
		expect(files.open).not.toHaveBeenCalled();
	});
	it.each(["", "mnt:[]", "mnt:[0]", "different"])("refuses invalid current namespace %j", async (value) => {
		files.readlink.mockResolvedValue(value);
		await expect(assertLxdOfficeHostNamespace(bootId)).rejects.toThrow("HOST_MOUNT_NAMESPACE_REQUIRED");
		expect(files.open).not.toHaveBeenCalled();
	});
	it("does not replace a different direct kernel namespace with the startup record", async () => {
		files.readlink.mockImplementation(async (path: string) =>
			path === "/proc/self/ns/mnt" ? namespace : "mnt:[999]",
		);
		await expect(assertLxdOfficeHostNamespace(bootId)).rejects.toThrow("HOST_MOUNT_NAMESPACE_REQUIRED");
		expect(files.open).not.toHaveBeenCalled();
	});
	it("does not hide unrelated kernel read errors", async () => {
		files.readlink.mockImplementation(async (path: string) => {
			if (path === "/proc/self/ns/mnt") return namespace;
			throw Object.assign(new Error("Kernel read failed"), { code: "EIO" });
		});
		await expect(assertLxdOfficeHostNamespace(bootId)).rejects.toThrow("Kernel read failed");
		expect(files.open).not.toHaveBeenCalled();
	});
	it.each(["old-boot", "different-namespace", "unprotected-owner", "malformed-record"])(
		"refuses an empty kernel target with %s",
		async (fault) => {
			if (fault === "old-boot") record.bootId = "11111111-1111-4111-8111-111111111111";
			if (fault === "different-namespace") record.namespace = "mnt:[999]";
			if (fault === "unprotected-owner") owner = 20043;
			if (fault === "malformed-record") record.namespace = "";
			await expect(assertLxdOfficeHostNamespace(bootId)).rejects.toThrow();
		},
	);
});
