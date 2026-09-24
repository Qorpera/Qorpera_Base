import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertCodingGuestMounts, initializeCloudCodingGuestStorage } from "../src/cloud-coding-storage-guest.ts";

// One session W of a member's machine, beside another session O of the same machine.
const W = "6f1c1b7e-2d4a-4c3e-9a57-0b8f3c2d1e40";
const O = "6f1c1b7e-2d4a-4c3e-9a57-0b8f3c2d1e41";
const data = `41 1 0:11 / /workspace/${W} rw,nosuid,nodev - virtiofs lxd_data--${W} rw\n`;
const custody = `42 1 0:12 / /var/lib/qorpera-coding/${W} rw,nosuid,nodev - virtiofs lxd_custody--${W} rw\n`;
const other = `51 1 0:21 / /workspace/${O} rw,nosuid,nodev - virtiofs lxd_data--${O} rw\n52 1 0:22 / /var/lib/qorpera-coding/${O} rw,nosuid,nodev - virtiofs lxd_custody--${O} rw\n`;
const root = "1 0 8:1 / / rw - ext4 /dev/vda rw\n";
describe("coding guest NAS mount boundary", () => {
	it("accepts the session's two whole virtiofs mounts beside other sessions and unrelated guest mounts", () => {
		expect(assertCodingGuestMounts(root + data + custody + other, W)).toEqual({
			[`/workspace/${W}`]: 41,
			[`/var/lib/qorpera-coding/${W}`]: 42,
		});
	});
	it("judges only the session it was asked about", () => {
		expect(() => assertCodingGuestMounts(root + other, W)).toThrow("MOUNT_INVALID");
		expect(() => assertCodingGuestMounts(root + data + custody, "not-a-session")).toThrow("INVALID_CODING_SESSION");
	});
	it.each([
		["missing data", root + custody],
		["missing custody", root + data],
		["local directory fallback", root + data.replace("virtiofs", "ext4") + custody],
		["other transport", root + data + custody.replace("virtiofs", "9p")],
		["partial bind root", root + data.replace(` / /workspace/${W} `, ` /subdir /workspace/${W} `) + custody],
		["read only mount", root + data.replace(" rw,nosuid", " ro,nosuid") + custody],
		["read only superblock", root + data + custody.replace(`lxd_custody--${W} rw`, `lxd_custody--${W} ro`)],
		["contradictory options", root + data.replace("rw,nosuid", "rw,ro,nosuid") + custody],
		["contradictory super options", root + data + custody.replace(`lxd_custody--${W} rw`, `lxd_custody--${W} rw,ro`)],
		["duplicate rw option", root + data.replace("rw,nosuid", "rw,rw,nosuid") + custody],
		["stacked mount", root + data + custody + data.replace(/^41/, "43")],
		[
			"nested workspace mount",
			root + data + custody + data.replace(/^41/, "43").replace(`/workspace/${W}`, `/workspace/${W}/repository`),
		],
		[
			"nested custody mount",
			root +
				data +
				custody +
				custody.replace(/^42/, "43").replace(`/var/lib/qorpera-coding/${W}`, `/var/lib/qorpera-coding/${W}/logs`),
		],
		["reused mount id", root + data + custody.replace(/^42/, "41")],
		["unsafe mount id", root + data.replace(/^41/, "9007199254740993") + custody],
		["missing source", root + data.replace(`virtiofs lxd_data--${W} rw`, "virtiofs rw") + custody],
		["extra suffix", root + data.replace(`lxd_data--${W} rw`, `lxd_data--${W} rw extra`) + custody],
		["escaped unexpected target", root + data.replace(`/workspace/${W}`, `/work\\040space/${W}`) + custody],
		["malformed parent id", root + data.replace("41 1 ", "41 x ") + custody],
	])("refuses %s", (_reason, input) => {
		expect(() => assertCodingGuestMounts(input, W)).toThrow("MOUNT_INVALID");
	});
	it("bounds kernel metadata before parsing", () => {
		expect(() => assertCodingGuestMounts(root + data + custody + "x".repeat(1048576), W)).toThrow("MOUNT_INVALID");
	});
	it.runIf(process.getuid?.() !== 0)("refuses bootstrap before filesystem access without root", async () => {
		await expect(initializeCloudCodingGuestStorage(W)).rejects.toThrow("ROOT_REQUIRED");
	});
	it("refuses a malformed superblock device", () => {
		expect(() => assertCodingGuestMounts(root + data.replace(" 0:11 ", " x:11 ") + custody, W)).toThrow(
			"MOUNT_INVALID",
		);
	});
});

// The member's machine as one session's command unit sees it (TemporaryFileSystem
// over both guest roots with only this session bound beneath, ProtectSystem=strict,
// the unit's ReadWritePaths, PrivateTmp, PrivateDevices, ProtectProc=invisible and
// NoNewPrivileges' nosuid): systemd renumbers every mount in the unit's namespace,
// covers /workspace and /var/lib/qorpera-coding with private tmpfs, binds the
// session's two NAS roots beneath them read-only per mount (BindReadOnlyPaths;
// their virtiofs superblocks stay rw) and bind-mounts each writable path onto
// itself. The real table of such a unit is the fixture below.
const commandId = "6f1c1b7e-2d4a-4c3e-9a57-0b8f3c2d1e4f";
const writablePaths = [
	`/workspace/${W}/repository`,
	`/workspace/${W}/home`,
	`/workspace/${W}/cache`,
	`/var/lib/qorpera-coding/${W}/logs/${commandId}`,
];
const sandboxLines = [
	"801 700 252:1 / / ro,nosuid,relatime master:1 - ext4 /dev/sda2 rw,discard,errors=remount-ro",
	"802 801 0:5 / /dev rw,nosuid,noexec - tmpfs tmpfs rw,size=4k,mode=755,inode64",
	"803 801 0:24 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw,hidepid=invisible",
	"804 801 0:25 / /run rw,nosuid,nodev,relatime master:5 - tmpfs tmpfs rw,size=401992k,mode=755,inode64",
	"805 801 252:1 /tmp/systemd-private-0f3c-qorpera-coding.service-a1/tmp /tmp rw,nosuid,relatime master:1 - ext4 /dev/sda2 rw,discard,errors=remount-ro",
	"810 801 0:70 / /workspace rw,nosuid,nodev - tmpfs tmpfs rw,size=393056k,nr_inodes=409600,mode=755,inode64",
	"811 801 0:71 / /var/lib/qorpera-coding rw,nosuid,nodev - tmpfs tmpfs rw,size=393056k,nr_inodes=409600,mode=755,inode64",
	`820 810 0:45 / /workspace/${W} ro,nosuid,nodev,relatime master:250 - virtiofs lxd_data--${W} rw`,
	`821 811 0:46 / /var/lib/qorpera-coding/${W} ro,nosuid,nodev,relatime master:260 - virtiofs lxd_custody--${W} rw`,
	`830 820 0:45 /repository /workspace/${W}/repository rw,nosuid,nodev,relatime master:250 - virtiofs lxd_data--${W} rw`,
	`831 820 0:45 /home /workspace/${W}/home rw,nosuid,nodev,relatime master:250 - virtiofs lxd_data--${W} rw`,
	`832 820 0:45 /cache /workspace/${W}/cache rw,nosuid,nodev,relatime master:250 - virtiofs lxd_data--${W} rw`,
	`833 821 0:46 /logs/${commandId} /var/lib/qorpera-coding/${W}/logs/${commandId} rw,nosuid,nodev,relatime master:260 - virtiofs lxd_custody--${W} rw`,
];
const sandboxed = (lines: string[] = sandboxLines) => `${lines.join("\n")}\n`;
const replace = (target: string, line: string) =>
	sandboxLines.map((entry) => (entry.split(" ")[4] === target ? line : entry));
describe("coding guest NAS mount boundary inside the command unit", () => {
	it("accepts the unit's view: read-only roots with exactly its writable binds of the same superblocks", () => {
		expect(assertCodingGuestMounts(sandboxed(), W, { writablePaths })).toEqual({
			[`/workspace/${W}`]: 820,
			[`/var/lib/qorpera-coding/${W}`]: 821,
		});
	});
	it("accepts the real table of a v106 command unit on node 2 (BindReadOnlyPaths, systemd 255)", () => {
		// Captured 2026-09-24 20:15Z in a proof VM with the unit's exact systemd-run
		// properties; in it the command could write its repository, home, cache and
		// own log directory, and was refused on both roots, an earlier command's
		// output.log and another session.
		const worker = "46aa30ee-87b6-46d7-b4ac-af2e786be151",
			command = "2902c6d7-c734-46d8-8178-95e39186e151";
		const table = readFileSync(
			new URL("./fixtures/coding-command-unit-readonly-mountinfo.txt", import.meta.url),
			"utf8",
		);
		expect(
			assertCodingGuestMounts(table, worker, {
				writablePaths: [
					`/workspace/${worker}/repository`,
					`/workspace/${worker}/home`,
					`/workspace/${worker}/cache`,
					`/var/lib/qorpera-coding/${worker}/logs/${command}`,
				],
			}),
		).toEqual({ [`/workspace/${worker}`]: 477, [`/var/lib/qorpera-coding/${worker}`]: 478 });
		expect(() => assertCodingGuestMounts(table, worker)).toThrow("MOUNT_INVALID");
	});
	it("refuses the real table of a v103 unit, whose roots were writable per mount (plain BindPaths)", () => {
		// Captured 2026-09-24 on node 2; in such a unit a command could rewrite an
		// earlier command's output.log of its own session.
		const worker = "5a829c4d-dfe3-4abd-847c-39db67ace3c4",
			command = "a06a68b5-49e1-4544-a741-cbad0d7e2371";
		const table = readFileSync(new URL("./fixtures/coding-command-unit-mountinfo.txt", import.meta.url), "utf8");
		expect(() =>
			assertCodingGuestMounts(table, worker, {
				writablePaths: [
					`/workspace/${worker}/repository`,
					`/workspace/${worker}/home`,
					`/workspace/${worker}/cache`,
					`/var/lib/qorpera-coding/${worker}/logs/${command}`,
				],
			}),
		).toThrow("MOUNT_INVALID");
		// The same table is never the machine's own view.
		expect(() => assertCodingGuestMounts(table, worker)).toThrow("MOUNT_INVALID");
		// Nor is a table with either cover alone.
		const lines = table.trim().split("\n");
		for (const cover of ["/workspace", "/var/lib/qorpera-coding"]) {
			const only = lines.filter(
				(line) => line.split(" ")[4] === cover || !/ \/(workspace|var\/lib\/qorpera-coding)(\/| )/.test(line),
			);
			const host = [
				...only,
				`900 1 0:50 / /workspace/${worker} rw,relatime - virtiofs lxd_data rw`,
				`901 1 0:51 / /var/lib/qorpera-coding/${worker} rw,relatime - virtiofs lxd_custody rw`,
			];
			expect(host.filter((line) => line.split(" ")[4] === cover)).toHaveLength(1);
			expect(() => assertCodingGuestMounts(`${host.join("\n")}\n`, worker)).toThrow("MOUNT_INVALID");
			// Without the cover the same machine view passes as the host's.
			expect(
				assertCodingGuestMounts(`${host.filter((line) => line.split(" ")[4] !== cover).join("\n")}\n`, worker),
			).toEqual({ [`/workspace/${worker}`]: 900, [`/var/lib/qorpera-coding/${worker}`]: 901 });
		}
	});
	it("ignores another session attached after the unit started: it lies under the cover", () => {
		const later = [
			...sandboxLines,
			`860 801 0:47 / /workspace/${O} rw,nosuid,nodev,relatime master:300 - virtiofs lxd_data--${O} rw`,
			`861 801 0:48 / /var/lib/qorpera-coding/${O} rw,nosuid,nodev,relatime master:301 - virtiofs lxd_custody--${O} rw`,
		];
		expect(assertCodingGuestMounts(sandboxed(later), W, { writablePaths })).toEqual({
			[`/workspace/${W}`]: 820,
			[`/var/lib/qorpera-coding/${W}`]: 821,
		});
	});
	it("keeps the strict check for root callers (the unit's view is refused without the sandbox)", () => {
		expect(() => assertCodingGuestMounts(sandboxed(), W)).toThrow("MOUNT_INVALID");
		expect(() =>
			assertCodingGuestMounts(
				sandboxed(sandboxLines.filter((line) => !/\/(repository|home|cache|logs\/)/.test(line.split(" ")[4]))),
				W,
			),
		).toThrow("MOUNT_INVALID");
	});
	it("fails closed outside the unit: the host's view is refused in sandbox mode", () => {
		expect(() => assertCodingGuestMounts(root + data + custody, W, { writablePaths })).toThrow("MOUNT_INVALID");
	});
	it.each([
		[
			"another session reachable beside this one",
			sandboxed([
				...sandboxLines,
				`860 810 0:47 / /workspace/${O} ro,nosuid,nodev,relatime master:300 - virtiofs lxd_data--${O} rw`,
			]),
		],
		[
			"another session's custody reachable beside this one",
			sandboxed([
				...sandboxLines,
				`861 811 0:48 / /var/lib/qorpera-coding/${O} ro,nosuid,nodev,relatime master:301 - virtiofs lxd_custody--${O} rw`,
			]),
		],
		[
			"no cover over the guest's workspace root",
			sandboxed(
				sandboxLines
					.filter((line) => line.split(" ")[4] !== "/workspace")
					.map((line) => line.replace(/^820 810 /, "820 801 ")),
			),
		],
		[
			"a cover that is not private memory",
			sandboxed(
				replace(
					"/var/lib/qorpera-coding",
					"811 801 0:71 / /var/lib/qorpera-coding rw,nosuid,nodev - ext4 /dev/sda2 rw",
				),
			),
		],
		[
			"the session bound outside its cover",
			sandboxed(
				replace(
					`/workspace/${W}`,
					`820 801 0:45 / /workspace/${W} ro,nosuid,nodev,relatime master:250 - virtiofs lxd_data--${W} rw`,
				),
			),
		],
		[
			"an undeclared mount beneath the workspace",
			sandboxed([
				...sandboxLines,
				`834 830 0:60 / /workspace/${W}/repository/node_modules rw,nosuid,nodev - tmpfs tmpfs rw`,
			]),
		],
		[
			"another command's log directory",
			sandboxed([
				...sandboxLines,
				`834 821 0:46 /logs/00000000-0000-4000-8000-000000000001 /var/lib/qorpera-coding/${W}/logs/00000000-0000-4000-8000-000000000001 rw,nosuid,nodev - virtiofs lxd_custody--${W} rw`,
			]),
		],
		[
			"a foreign filesystem at a declared path",
			sandboxed(
				replace(`/workspace/${W}/cache`, `832 820 0:61 / /workspace/${W}/cache rw,nosuid,nodev - tmpfs tmpfs rw`),
			),
		],
		[
			"a declared path bound from a different superblock",
			sandboxed(
				replace(
					`/workspace/${W}/repository`,
					`830 820 0:47 /repository /workspace/${W}/repository rw,nosuid,nodev - virtiofs lxd_data--${W} rw`,
				),
			),
		],
		[
			"the log directory bound from the workspace's superblock",
			sandboxed(
				replace(
					`/var/lib/qorpera-coding/${W}/logs/${commandId}`,
					`833 821 0:45 /logs/${commandId} /var/lib/qorpera-coding/${W}/logs/${commandId} rw,nosuid,nodev - virtiofs lxd_data--${W} rw`,
				),
			),
		],
		[
			"a declared path bound from another subtree",
			sandboxed(
				replace(
					`/workspace/${W}/repository`,
					`830 820 0:45 /home /workspace/${W}/repository rw,nosuid,nodev - virtiofs lxd_data--${W} rw`,
				),
			),
		],
		[
			"a read-only writable path",
			sandboxed(
				replace(
					`/workspace/${W}/repository`,
					`830 820 0:45 /repository /workspace/${W}/repository ro,nosuid,nodev - virtiofs lxd_data--${W} rw`,
				),
			),
		],
		[
			"a root superblock that is not rw",
			sandboxed(
				replace(
					`/workspace/${W}`,
					`820 810 0:45 / /workspace/${W} ro,nosuid,nodev,relatime master:250 - virtiofs lxd_data--${W} ro`,
				),
			),
		],
		[
			"a root superblock without its rw option",
			sandboxed(
				replace(
					`/var/lib/qorpera-coding/${W}`,
					`821 811 0:46 / /var/lib/qorpera-coding/${W} ro,nosuid,nodev - virtiofs lxd_custody--${W} nosuid`,
				),
			),
		],
		[
			"a bind whose superblock options lack rw",
			sandboxed(
				replace(
					`/workspace/${W}/home`,
					`831 820 0:45 /home /workspace/${W}/home rw,nosuid,nodev - virtiofs lxd_data--${W} ro`,
				),
			),
		],
		[
			"a root mount with contradictory options",
			sandboxed(
				replace(
					`/workspace/${W}`,
					`820 810 0:45 / /workspace/${W} rw,ro,nosuid,nodev - virtiofs lxd_data--${W} rw`,
				),
			),
		],
		[
			"a stacked mount on a declared path",
			sandboxed([
				...sandboxLines,
				`834 830 0:45 /repository /workspace/${W}/repository rw,nosuid,nodev - virtiofs lxd_data--${W} rw`,
			]),
		],
		[
			"a stacked root",
			sandboxed([...sandboxLines, `834 810 0:45 / /workspace/${W} rw,nosuid,nodev - virtiofs lxd_data--${W} rw`]),
		],
		["a missing declared bind", sandboxed(sandboxLines.filter((line) => !line.includes(` /workspace/${W}/cache `)))],
		[
			"a missing log bind",
			sandboxed(sandboxLines.filter((line) => !line.includes(` /var/lib/qorpera-coding/${W}/logs/${commandId} `))),
		],
		[
			"a custody root left writable per mount",
			sandboxed(
				replace(
					`/var/lib/qorpera-coding/${W}`,
					`821 811 0:46 / /var/lib/qorpera-coding/${W} rw,nosuid,nodev,relatime master:260 - virtiofs lxd_custody--${W} rw`,
				),
			),
		],
		[
			"a data root left writable per mount",
			sandboxed(
				replace(
					`/workspace/${W}`,
					`820 810 0:45 / /workspace/${W} rw,nosuid,nodev,relatime master:250 - virtiofs lxd_data--${W} rw`,
				),
			),
		],
		[
			"a partial root bind",
			sandboxed(
				replace(`/workspace/${W}`, `820 810 0:45 /repository /workspace/${W} ro - virtiofs lxd_data--${W} rw`),
			),
		],
	])("refuses %s", (_reason, input) => {
		expect(() => assertCodingGuestMounts(input, W, { writablePaths })).toThrow("MOUNT_INVALID");
	});
	it.each([
		["no paths", []],
		["a path outside both roots", [...writablePaths, "/etc"]],
		["a root itself", [`/workspace/${W}`]],
		["a guest root", ["/workspace/repository"]],
		["another session's folder", [...writablePaths, `/workspace/${O}/repository`]],
		["a relative path", [`workspace/${W}/repository`]],
		["a parent step", [`/workspace/${W}/../etc`]],
		["a trailing slash", [`/workspace/${W}/repository/`]],
		["a duplicate", [...writablePaths, `/workspace/${W}/home`]],
		["a similar prefix", [`/workspace/${W}-other/repository`]],
	])("refuses a sandbox declaring %s", (_reason, paths) => {
		expect(() => assertCodingGuestMounts(sandboxed(), W, { writablePaths: paths })).toThrow("SANDBOX_INVALID");
	});
});
