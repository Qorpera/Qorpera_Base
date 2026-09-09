import { describe, expect, it } from "vitest";
import { assertLxdOfficeHostMount } from "../src/lxd-office-physical-host.ts";
import { officePhysicalFixture } from "./fixtures/office-physical-policy.ts";

const nfs =
	"42 1 0:48 / /mnt/office-workbench rw,nosuid,nodev,relatime - nfs4 192.0.2.1:/offices/test rw,vers=4.2,hard,proto=tcp,addr=192.0.2.1";
const local = "43 1 8:16 / /mnt/office-journal rw,relatime - ext4 /dev/vdb rw";
const fd = "pos:\t0\nflags:\t02304000\nmnt_id:\t42\nino:\t12\n";
const mountInfo = `${nfs}\n${local}\n`;
function check(info = mountInfo, fdInfo = fd) {
	const { policy } = officePhysicalFixture();
	assertLxdOfficeHostMount(
		info,
		fdInfo,
		policy.workbench,
		policy.guest.workbenchSource,
		policy.workbench.serverAddress,
	);
}
describe("provider descriptor-bound storage inspection", () => {
	it("accepts the exact NFS v4 backing and a separate persistent local journal", () => {
		expect(() => check()).not.toThrow();
		const { policy } = officePhysicalFixture();
		expect(() =>
			assertLxdOfficeHostMount(mountInfo, "mnt_id:\t43\n", policy.journal, policy.journal.path),
		).not.toThrow();
	});
	it.each([
		["nfs4", "ext4"],
		["192.0.2.1:/offices/test", "/dev/vdc"],
		["192.0.2.1:/offices/test", "192.0.2.1:/another-office"],
		["addr=192.0.2.1", "addr=192.0.2.2"],
		["hard", "soft"],
		["hard", "hard,softerr"],
		["hard", "hard,softreval"],
		["proto=tcp", "proto=udp"],
		["vers=4.2", "vers=3"],
		["vers=4.2", "vers=4.2,vers=3"],
		["addr=192.0.2.1", "addr=192.0.2.1,addr=192.0.2.2"],
		["rw,nosuid", "ro,nosuid"],
		["rw,vers", "ro,vers"],
		["nosuid,", ""],
		["nodev,", ""],
		[" / /mnt/office-workbench", " /partial /mnt/office-workbench"],
	])("rejects changed mount field %s → %s", (before, after) => {
		expect(() => check(mountInfo.replace(before, after))).toThrow();
	});
	it("rejects absent/stale descriptors, multiple matching mounts and mounts hidden below a directory", () => {
		for (const fdInfo of ["", "mnt_id:\t99\n", `${fd}mnt_id:\t42\n`])
			expect(() => check(mountInfo, fdInfo)).toThrow();
		expect(() => check(`${mountInfo}${nfs}\n`)).toThrow();
		expect(() => check(`${mountInfo}${nfs.replace(/^42/, "44")}\n`)).toThrow();
		expect(() => check(`${mountInfo}44 1 0:49 / /mnt/office-workbench/profiles rw - tmpfs tmpfs rw\n`)).toThrow();
		expect(() => check(`${mountInfo}malformed\n`)).toThrow();
	});
	it("rejects local fallback after NAS loss, escaped paths and oversized kernel metadata", () => {
		expect(() => check(local, "mnt_id:\t43\n")).toThrow();
		expect(() => check(mountInfo.replace("/offices/test", "/offices/test\\040bad"))).toThrow();
		expect(() => check(" ".repeat(1048577))).toThrow();
		expect(() => check(mountInfo, " ".repeat(4097))).toThrow();
	});
});
