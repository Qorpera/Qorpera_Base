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
	it("refuses a malformed superblock device", () => {
		expect(() => assertCodingGuestMounts(root + data.replace(" 0:11 ", " x:11 ") + custody)).toThrow("MOUNT_INVALID");
	});
});

// The coding VM as the command unit sees it (ProtectSystem=strict, the unit's
// ReadWritePaths, PrivateTmp, PrivateDevices, ProtectProc=invisible and
// NoNewPrivileges' nosuid): systemd renumbers every mount in the unit's
// namespace, remounts the two NAS roots read-only per mount (their virtiofs
// superblocks stay rw) and bind-mounts each writable path onto itself.
const commandId = "6f1c1b7e-2d4a-4c3e-9a57-0b8f3c2d1e4f";
const writablePaths = [
	"/workspace/repository",
	"/workspace/home",
	"/workspace/cache",
	`/var/lib/qorpera-coding/logs/${commandId}`,
];
const sandboxLines = [
	"801 700 252:1 / / ro,nosuid,relatime master:1 - ext4 /dev/sda2 rw,discard,errors=remount-ro",
	"802 801 0:5 / /dev rw,nosuid,noexec - tmpfs tmpfs rw,size=4k,mode=755,inode64",
	"803 801 0:24 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw,hidepid=invisible",
	"804 801 0:25 / /run rw,nosuid,nodev,relatime master:5 - tmpfs tmpfs rw,size=401992k,mode=755,inode64",
	"805 801 252:1 /tmp/systemd-private-0f3c-qorpera-coding.service-a1/tmp /tmp rw,nosuid,relatime master:1 - ext4 /dev/sda2 rw,discard,errors=remount-ro",
	"820 801 0:45 / /workspace ro,nosuid,nodev,relatime master:250 - virtiofs lxd_workspace rw",
	"821 801 0:46 / /var/lib/qorpera-coding ro,nosuid,nodev,relatime master:260 - virtiofs lxd_custody rw",
	"830 820 0:45 /repository /workspace/repository rw,nosuid,nodev,relatime master:250 - virtiofs lxd_workspace rw",
	"831 820 0:45 /home /workspace/home rw,nosuid,nodev,relatime master:250 - virtiofs lxd_workspace rw",
	"832 820 0:45 /cache /workspace/cache rw,nosuid,nodev,relatime master:250 - virtiofs lxd_workspace rw",
	`833 821 0:46 /logs/${commandId} /var/lib/qorpera-coding/logs/${commandId} rw,nosuid,nodev,relatime master:260 - virtiofs lxd_custody rw`,
];
const sandboxed = (lines: string[] = sandboxLines) => `${lines.join("\n")}\n`;
const replace = (target: string, line: string) =>
	sandboxLines.map((entry) => (entry.split(" ")[4] === target ? line : entry));
describe("coding guest NAS mount boundary inside the command unit", () => {
	it("accepts the unit's view: read-only roots with exactly its writable binds of the same superblocks", () => {
		expect(assertCodingGuestMounts(sandboxed(), { writablePaths })).toEqual({
			"/workspace": 820,
			"/var/lib/qorpera-coding": 821,
		});
	});
	it("keeps the strict check for root callers (the unit's view is refused without the sandbox)", () => {
		expect(() => assertCodingGuestMounts(sandboxed())).toThrow("MOUNT_INVALID");
		expect(() =>
			assertCodingGuestMounts(
				sandboxed(sandboxLines.filter((line) => !/ \/(repository|home|cache|logs\/)/.test(line))),
			),
		).toThrow("MOUNT_INVALID");
	});
	it("also accepts the host's view, where nothing is mounted beneath the roots", () => {
		expect(assertCodingGuestMounts(root + data + custody, { writablePaths })).toEqual({
			"/workspace": 41,
			"/var/lib/qorpera-coding": 42,
		});
	});
	it.each([
		[
			"an undeclared mount beneath the workspace",
			sandboxed([
				...sandboxLines,
				"834 830 0:60 / /workspace/repository/node_modules rw,nosuid,nodev - tmpfs tmpfs rw",
			]),
		],
		[
			"another command's log directory",
			sandboxed([
				...sandboxLines,
				"834 821 0:46 /logs/00000000-0000-4000-8000-000000000001 /var/lib/qorpera-coding/logs/00000000-0000-4000-8000-000000000001 rw,nosuid,nodev - virtiofs lxd_custody rw",
			]),
		],
		[
			"a foreign filesystem at a declared path",
			sandboxed(replace("/workspace/cache", "832 820 0:61 / /workspace/cache rw,nosuid,nodev - tmpfs tmpfs rw")),
		],
		[
			"a declared path bound from a different superblock",
			sandboxed(
				replace(
					"/workspace/repository",
					"830 820 0:47 /repository /workspace/repository rw,nosuid,nodev - virtiofs lxd_workspace rw",
				),
			),
		],
		[
			"the log directory bound from the workspace's superblock",
			sandboxed(
				replace(
					`/var/lib/qorpera-coding/logs/${commandId}`,
					`833 821 0:45 /logs/${commandId} /var/lib/qorpera-coding/logs/${commandId} rw,nosuid,nodev - virtiofs lxd_workspace rw`,
				),
			),
		],
		[
			"a declared path bound from another subtree",
			sandboxed(
				replace(
					"/workspace/repository",
					"830 820 0:45 /home /workspace/repository rw,nosuid,nodev - virtiofs lxd_workspace rw",
				),
			),
		],
		[
			"a read-only writable path",
			sandboxed(
				replace(
					"/workspace/repository",
					"830 820 0:45 /repository /workspace/repository ro,nosuid,nodev - virtiofs lxd_workspace rw",
				),
			),
		],
		[
			"a root superblock that is not rw",
			sandboxed(
				replace(
					"/workspace",
					"820 801 0:45 / /workspace ro,nosuid,nodev,relatime master:250 - virtiofs lxd_workspace ro",
				),
			),
		],
		[
			"a root superblock without its rw option",
			sandboxed(
				replace(
					"/var/lib/qorpera-coding",
					"821 801 0:46 / /var/lib/qorpera-coding ro,nosuid,nodev - virtiofs lxd_custody nosuid",
				),
			),
		],
		[
			"a bind whose superblock options lack rw",
			sandboxed(
				replace(
					"/workspace/home",
					"831 820 0:45 /home /workspace/home rw,nosuid,nodev - virtiofs lxd_workspace ro",
				),
			),
		],
		[
			"a root mount with contradictory options",
			sandboxed(replace("/workspace", "820 801 0:45 / /workspace rw,ro,nosuid,nodev - virtiofs lxd_workspace rw")),
		],
		[
			"a stacked mount on a declared path",
			sandboxed([
				...sandboxLines,
				"834 830 0:45 /repository /workspace/repository rw,nosuid,nodev - virtiofs lxd_workspace rw",
			]),
		],
		[
			"a stacked root",
			sandboxed([...sandboxLines, "834 820 0:45 / /workspace rw,nosuid,nodev - virtiofs lxd_workspace rw"]),
		],
		[
			"a partial root bind",
			sandboxed(replace("/workspace", "820 801 0:45 /repository /workspace ro - virtiofs lxd_workspace rw")),
		],
	])("refuses %s", (_reason, input) => {
		expect(() => assertCodingGuestMounts(input, { writablePaths })).toThrow("MOUNT_INVALID");
	});
	it.each([
		["no paths", []],
		["a path outside both roots", [...writablePaths, "/etc"]],
		["a root itself", ["/workspace"]],
		["a relative path", ["workspace/repository"]],
		["a parent step", ["/workspace/../etc"]],
		["a trailing slash", ["/workspace/repository/"]],
		["a duplicate", [...writablePaths, "/workspace/home"]],
		["a similar prefix", ["/workspace-other/repository"]],
	])("refuses a sandbox declaring %s", (_reason, paths) => {
		expect(() => assertCodingGuestMounts(sandboxed(), { writablePaths: paths })).toThrow("SANDBOX_INVALID");
	});
});
