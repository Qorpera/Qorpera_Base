import { describe, expect, it } from "vitest";
import { assertCodingGuestMounts, initializeCloudCodingGuestStorage } from "../src/cloud-coding-storage-guest.ts";

const data = "41 1 0:11 / /workspace rw,nosuid,nodev - virtiofs lxd_data rw\n";
const custody = "42 1 0:12 / /var/lib/qorpera-coding rw,nosuid,nodev - virtiofs lxd_custody rw\n";
const root = "1 0 8:1 / / rw - ext4 /dev/vda rw\n";
describe("coding guest NAS mount boundary", () => {
	it("accepts two distinct whole virtiofs mounts with unrelated guest mounts", () => {
		expect(assertCodingGuestMounts(root + data + custody)).toEqual({
			"/workspace": 41,
			"/var/lib/qorpera-coding": 42,
		});
	});
	it.each([
		["missing data", root + custody],
		["missing custody", root + data],
		["local directory fallback", root + data.replace("virtiofs", "ext4") + custody],
		["other transport", root + data + custody.replace("virtiofs", "9p")],
		["partial bind root", root + data.replace(" / /workspace ", " /subdir /workspace ") + custody],
		["read only mount", root + data.replace(" rw,nosuid", " ro,nosuid") + custody],
		["read only superblock", root + data + custody.replace("lxd_custody rw", "lxd_custody ro")],
		["contradictory options", root + data.replace("rw,nosuid", "rw,ro,nosuid") + custody],
		["contradictory super options", root + data + custody.replace("lxd_custody rw", "lxd_custody rw,ro")],
		["duplicate rw option", root + data.replace("rw,nosuid", "rw,rw,nosuid") + custody],
		["stacked mount", root + data + custody + data.replace(/^41/, "43")],
		[
			"nested workspace mount",
			root + data + custody + data.replace(/^41/, "43").replace("/workspace", "/workspace/repository"),
		],
		[
			"nested custody mount",
			root +
				data +
				custody +
				custody.replace(/^42/, "43").replace("/var/lib/qorpera-coding", "/var/lib/qorpera-coding/logs"),
		],
		["reused mount id", root + data + custody.replace(/^42/, "41")],
		["unsafe mount id", root + data.replace(/^41/, "9007199254740993") + custody],
		["missing source", root + data.replace("virtiofs lxd_data rw", "virtiofs rw") + custody],
		["extra suffix", root + data.replace("lxd_data rw", "lxd_data rw extra") + custody],
		["escaped unexpected target", root + data.replace("/workspace", "/work\\040space") + custody],
	])("refuses %s", (_reason, input) => {
		expect(() => assertCodingGuestMounts(input)).toThrow("MOUNT_INVALID");
	});
	it("bounds kernel metadata before parsing", () => {
		expect(() => assertCodingGuestMounts(root + data + custody + "x".repeat(1048576))).toThrow("MOUNT_INVALID");
	});
	it.runIf(process.getuid?.() !== 0)("refuses bootstrap before filesystem access without root", async () => {
		await expect(initializeCloudCodingGuestStorage()).rejects.toThrow("ROOT_REQUIRED");
	});
});
