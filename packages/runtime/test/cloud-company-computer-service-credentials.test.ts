import { readCompanyComputerServiceCredential } from "@qorpera/runtime/cloud-company-computer-service-credentials";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fs = vi.hoisted(() => ({
	lstat: vi.fn(),
	open: vi.fn(),
	realpath: vi.fn(),
	stat: vi.fn(),
	read: vi.fn(),
	close: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ lstat: fs.lstat, open: fs.open, realpath: fs.realpath }));
const directory = "/run/credentials/qorpera-company-computer.service";
let metadata: {
	size: number;
	uid: number;
	gid: number;
	mode: number;
	nlink: number;
	mtimeMs: number;
	ctimeMs: number;
	isFile(): boolean;
};
let source: Buffer;
let offset: number;
let scratch: Buffer | undefined;
beforeEach(() => {
	vi.spyOn(process, "geteuid").mockReturnValue(1000);
	source = Buffer.from("n".repeat(43));
	offset = 0;
	scratch = undefined;
	metadata = {
		size: source.length,
		uid: 1000,
		gid: 1000,
		mode: 0o400,
		nlink: 1,
		mtimeMs: 1,
		ctimeMs: 1,
		isFile: () => true,
	};
	fs.realpath.mockImplementation(async (value) => value);
	fs.lstat.mockImplementation(async () => ({
		uid: 0,
		mode: 0o555,
		isDirectory: () => true,
		isSymbolicLink: () => false,
	}));
	fs.open.mockResolvedValue({ stat: fs.stat, read: fs.read, close: fs.close });
	fs.stat.mockImplementation(async () => ({ ...metadata }));
	fs.close.mockResolvedValue(undefined);
	fs.read.mockImplementation(async (bytes: Buffer, at: number, length: number) => {
		scratch = bytes;
		const count = Math.min(7, source.length - offset, length);
		source.copy(bytes, at, offset, offset + count);
		offset += count;
		return { bytesRead: count };
	});
});
afterEach(() => {
	expect(scratch?.every((byte) => byte === 0) ?? true).toBe(true);
	vi.restoreAllMocks();
	for (const mock of Object.values(fs)) mock.mockReset();
});
const read = () => readCompanyComputerServiceCredential(directory, "qorpera-office-native");
describe("descriptor-bound systemd office credentials", () => {
	it("handles short reads without truncation, closes and clears temporary bytes", async () => {
		expect(await read()).toEqual(source);
		expect(fs.close).toHaveBeenCalledTimes(1);
		expect(fs.read.mock.calls.length).toBeGreaterThan(6);
	});
	it.each(["writable", "world readable", "hardlinked", "fifo", "empty", "oversized", "wrong owner"])(
		"refuses %s credentials",
		async (bad) => {
			if (bad === "writable") metadata.mode = 0o600;
			if (bad === "world readable") metadata.mode = 0o444;
			if (bad === "hardlinked") metadata.nlink = 2;
			if (bad === "fifo") metadata.isFile = () => false;
			if (bad === "empty") metadata.size = 0;
			if (bad === "oversized") metadata.size = 129;
			if (bad === "wrong owner") metadata.uid = 1001;
			await expect(read()).rejects.toThrow("OFFICE_SERVICE_CREDENTIAL_UNAVAILABLE");
			expect(fs.close).toHaveBeenCalledTimes(1);
			expect(fs.read).not.toHaveBeenCalled();
		},
	);
	it.each(["short", "grown", "changed"])("refuses %s reads", async (bad) => {
		if (bad === "short") source = source.subarray(0, 40);
		if (bad === "grown") source = Buffer.alloc(129);
		if (bad === "changed")
			fs.stat.mockResolvedValueOnce({ ...metadata }).mockResolvedValue({ ...metadata, ctimeMs: 2 });
		await expect(read()).rejects.toThrow("OFFICE_SERVICE_CREDENTIAL_UNAVAILABLE");
		expect(fs.close).toHaveBeenCalledTimes(1);
	});
	it.each(["alias", "writable directory", "user parent", "open failure"])(
		"rejects %s without exposing paths or OS errors",
		async (bad) => {
			if (bad === "alias") fs.realpath.mockResolvedValue("/elsewhere");
			if (bad === "writable directory")
				fs.lstat.mockResolvedValue({ uid: 0, mode: 0o755, isDirectory: () => true, isSymbolicLink: () => false });
			if (bad === "user parent")
				fs.lstat.mockResolvedValue({
					uid: 1000,
					mode: 0o555,
					isDirectory: () => true,
					isSymbolicLink: () => false,
				});
			if (bad === "open failure") fs.open.mockRejectedValue(new Error("secret-path"));
			await expect(read()).rejects.toThrow(/^OFFICE_SERVICE_CREDENTIAL_UNAVAILABLE$/);
		},
	);
});
