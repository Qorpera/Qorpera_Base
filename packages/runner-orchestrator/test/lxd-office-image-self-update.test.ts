import { readFileSync, readlinkSync, symlinkSync } from "node:fs";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OFFICE_IMAGE_SELF_UPDATE_UNITS } from "../src/lxd-office-image-installation.ts";
import {
	assertOfficeImageSelfUpdateMasked,
	maskOfficeImageSelfUpdate,
} from "../src/lxd-office-image-installation-host.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A systemd whose `mask` writes links the way systemctl does, into `root`. */
async function systemd(options: { running?: string; unmaskable?: string; reports?: string } = {}) {
	const root = await mkdtemp(join(tmpdir(), "qorpera-office-units-"));
	roots.push(root);
	const calls: string[][] = [];
	const run = (file: string, args: string[]): string => {
		calls.push([file, ...args]);
		if (file !== "/usr/bin/systemctl") throw new Error("unexpected command");
		const [verb, unit, property] = args;
		if (verb === "mask") {
			for (const name of args.slice(1)) if (name !== options.unmaskable) symlinkSync("/dev/null", join(root, name));
			return "";
		}
		if (verb === "show" && property === "--property=ActiveState")
			return unit === options.running ? "activating" : "inactive";
		if (verb === "show" && property === "--property=UnitFileState") {
			if (options.reports) return options.reports;
			try {
				return readlinkSync(join(root, unit!)) === "/dev/null" ? "masked" : "enabled";
			} catch {
				return "enabled";
			}
		}
		throw new Error("unexpected systemctl call");
	};
	return { root, run, calls };
}

describe("office image self-update masking", () => {
	it("covers the same five units as the guests", () => {
		expect(OFFICE_IMAGE_SELF_UPDATE_UNITS).toEqual([
			"apt-daily.timer",
			"apt-daily-upgrade.timer",
			"apt-daily.service",
			"apt-daily-upgrade.service",
			"unattended-upgrades.service",
		]);
	});

	it("masks all five before checking for a running job, then proves every mask", async () => {
		const host = await systemd();
		await expect(maskOfficeImageSelfUpdate(host.run, host.root)).resolves.toBeUndefined();
		expect(host.calls[0]).toEqual(["/usr/bin/systemctl", "mask", ...OFFICE_IMAGE_SELF_UPDATE_UNITS]);
		expect(host.calls.slice(1, 3).map((call) => call[2])).toEqual(["apt-daily.service", "apt-daily-upgrade.service"]);
		for (const unit of OFFICE_IMAGE_SELF_UPDATE_UNITS) expect(readlinkSync(join(host.root, unit))).toBe("/dev/null");
	});

	it.each(["apt-daily.service", "apt-daily-upgrade.service"])(
		"refuses while %s is running, after masking so no new job starts",
		async (running) => {
			const host = await systemd({ running });
			await expect(maskOfficeImageSelfUpdate(host.run, host.root)).rejects.toThrow("OFFICE_IMAGE_APT_JOB_RUNNING");
			expect(host.calls[0]?.[1]).toBe("mask");
		},
	);

	it("refuses when a mask did not take", async () => {
		const host = await systemd({ unmaskable: "unattended-upgrades.service" });
		await expect(maskOfficeImageSelfUpdate(host.run, host.root)).rejects.toThrow("OFFICE_IMAGE_SELF_UPDATE_ENABLED");
	});

	it("refuses a /dev/null link that systemd does not report as masked", async () => {
		const host = await systemd({ reports: "enabled" });
		host.run("/usr/bin/systemctl", ["mask", ...OFFICE_IMAGE_SELF_UPDATE_UNITS]);
		await expect(assertOfficeImageSelfUpdateMasked(host.run, host.root)).rejects.toThrow(
			"OFFICE_IMAGE_SELF_UPDATE_ENABLED",
		);
	});

	it("refuses a regular unit file in place of the mask", async () => {
		const host = await systemd();
		host.run("/usr/bin/systemctl", ["mask", ...OFFICE_IMAGE_SELF_UPDATE_UNITS]);
		await unlink(join(host.root, "apt-daily-upgrade.timer"));
		await writeFile(join(host.root, "apt-daily-upgrade.timer"), "[Timer]\n");
		await expect(assertOfficeImageSelfUpdateMasked(host.run, host.root)).rejects.toThrow(
			"OFFICE_IMAGE_SELF_UPDATE_ENABLED",
		);
	});

	it("the root install stage masks before it creates the account or publishes a file, and proves it last", () => {
		// The stage needs root on Linux; pin its order in the source instead.
		const source = readFileSync(new URL("../src/lxd-office-image-installation-host.ts", import.meta.url), "utf8");
		const locked = source.slice(source.indexOf("export async function installOfficeImage("));
		const mask = locked.indexOf("await maskOfficeImageSelfUpdate();");
		expect(mask).toBeGreaterThan(locked.indexOf("await officeInstallLockFd(lock, 0);"));
		expect(mask).toBeLessThan(locked.indexOf("account(loaded.spec.uid, loaded.spec.gid, true);"));
		expect(mask).toBeLessThan(locked.indexOf("await publishOfficeInstallFile(target);"));
		const proof = locked.lastIndexOf("await assertOfficeImageSelfUpdateMasked();");
		expect(proof).toBeGreaterThan(locked.indexOf('"OFFICE_IMAGE_SERVICE_NOT_DISABLED"'));
		expect(proof).toBeLessThan(locked.indexOf('"qorpera.office-image-installation-result/v1"'));
	});
});
