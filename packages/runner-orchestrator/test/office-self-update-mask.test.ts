import { existsSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { maskOfficeSelfUpdateUnits } from "../../../deploy/lxd-company-computer-guest/office-self-update-mask.ts";

const UNITS = [
	"apt-daily.timer",
	"apt-daily-upgrade.timer",
	"apt-daily.service",
	"apt-daily-upgrade.service",
	"unattended-upgrades.service",
];
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A systemd whose `mask` writes links the way systemctl does, into `root`. */
async function systemd(options: { running?: string; unmaskable?: string; reports?: string } = {}) {
	const root = await mkdtemp(join(tmpdir(), "qorpera-office-tool-units-"));
	roots.push(root);
	const calls: string[][] = [];
	const run = (file: string, args: string[]): string => {
		calls.push([file, ...args]);
		if (file !== "/usr/bin/systemctl") throw new Error("unexpected command");
		const [verb, unit, property] = args;
		if (verb === "mask") {
			// Idempotent like systemctl: an existing mask stays.
			for (const name of args.slice(1))
				if (name !== options.unmaskable && !existsSync(join(root, name)))
					symlinkSync("/dev/null", join(root, name));
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

describe("office software install tool: self-update mask", () => {
	it("masks all five first, checks for a running job, then proves every link and unit state", async () => {
		const host = await systemd();
		await expect(maskOfficeSelfUpdateUnits(host.run, host.root)).resolves.toBeUndefined();
		expect(host.calls[0]).toEqual(["/usr/bin/systemctl", "mask", ...UNITS]);
		expect(host.calls.slice(1, 3).map((call) => call[2])).toEqual(["apt-daily.service", "apt-daily-upgrade.service"]);
		for (const unit of UNITS) expect(readlinkSync(join(host.root, unit))).toBe("/dev/null");
		// Idempotent: a retried install masks and passes again.
		await expect(maskOfficeSelfUpdateUnits(host.run, host.root)).resolves.toBeUndefined();
	});

	it.each(["apt-daily.service", "apt-daily-upgrade.service"])(
		"refuses while %s is running, after masking so no new job starts",
		async (running) => {
			const host = await systemd({ running });
			await expect(maskOfficeSelfUpdateUnits(host.run, host.root)).rejects.toThrow(
				"OFFICE_SOFTWARE_CONTROL_APT_JOB_RUNNING",
			);
			expect(host.calls[0]?.[1]).toBe("mask");
		},
	);

	it("refuses when a mask did not take, naming the unit", async () => {
		const host = await systemd({ unmaskable: "unattended-upgrades.service" });
		await expect(maskOfficeSelfUpdateUnits(host.run, host.root)).rejects.toThrow(
			"RUNNER_IMAGE_SELF_UPDATE_ENABLED:UNATTENDED_UPGRADES_SERVICE",
		);
	});

	it("refuses a /dev/null link that systemd does not report as masked", async () => {
		const host = await systemd({ reports: "enabled" });
		await expect(maskOfficeSelfUpdateUnits(host.run, host.root)).rejects.toThrow(
			"OFFICE_SOFTWARE_CONTROL_SELF_UPDATE_ENABLED",
		);
	});

	it("refuses a regular unit file in place of the mask", async () => {
		const host = await systemd();
		const run = (file: string, args: string[]) => {
			const result = host.run(file, args);
			// A packaged unit file where the mask should be.
			if (args[0] === "mask") {
				unlinkSync(join(host.root, "apt-daily-upgrade.timer"));
				writeFileSync(join(host.root, "apt-daily-upgrade.timer"), "[Timer]\n");
			}
			return result;
		};
		await expect(maskOfficeSelfUpdateUnits(run, host.root)).rejects.toThrow(
			"RUNNER_IMAGE_SELF_UPDATE_ENABLED:APT_DAILY_UPGRADE_TIMER",
		);
	});

	it("the install tool masks after every local check and before the challenge window", () => {
		const source = readFileSync(
			new URL("../../../deploy/lxd-company-computer-guest/office-service-software-control.ts", import.meta.url),
			"utf8",
		);
		const locked = source.slice(source.indexOf("async function lockedInstall("));
		const mask = locked.indexOf("await maskOfficeSelfUpdateUnits();");
		// After the stop history is proven and every candidate is read ...
		expect(mask).toBeGreaterThan(locked.indexOf("const completedStop = await read("));
		expect(mask).toBeGreaterThan(locked.lastIndexOf("await readServiceCandidate("));
		// ... and before the stopped-service recheck and the challenge window.
		expect(mask).toBeLessThan(locked.indexOf("const manager = createCompanyComputerServiceStopSystemdManager();"));
		expect(mask).toBeLessThan(locked.indexOf("return await installOfficeSoftwareWithinChallenge("));
	});
});
