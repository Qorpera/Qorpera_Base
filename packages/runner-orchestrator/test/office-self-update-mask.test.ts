import { existsSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { maskOfficeSelfUpdateUnits } from "../../../deploy/lxd-company-computer-guest/office-self-update-mask.ts";
import { maskOfficeImageSelfUpdate } from "../src/lxd-office-image-installation-host.ts";

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

/** A systemd whose `mask` writes links the way systemctl does, into `root`.
 * `show --property=X --value u...` prints one value per unit, blank-line
 * separated like systemctl; `show u --property=X --value` (the image
 * installer's form) prints one. */
async function systemd(options: { running?: string; unmaskable?: string; reports?: string } = {}) {
	const root = await mkdtemp(join(tmpdir(), "qorpera-office-tool-units-"));
	roots.push(root);
	const calls: string[][] = [];
	const masked = (unit: string) => {
		try {
			return readlinkSync(join(root, unit)) === "/dev/null";
		} catch {
			return false;
		}
	};
	const one = (property: string, unit: string) => {
		if (property === "--property=ActiveState") return unit === options.running ? "activating" : "inactive";
		if (property === "--property=LoadState") return masked(unit) ? "masked" : "loaded";
		if (property === "--property=UnitFileState") return options.reports ?? (masked(unit) ? "masked" : "enabled");
		throw new Error("unexpected property");
	};
	const run = (file: string, args: string[]): string => {
		calls.push([file, ...args]);
		if (file !== "/usr/bin/systemctl") throw new Error("unexpected command");
		if (args[0] === "mask") {
			// Idempotent like systemctl: an existing mask stays.
			for (const name of args.slice(1))
				if (name !== options.unmaskable && !existsSync(join(root, name)))
					symlinkSync("/dev/null", join(root, name));
			return "";
		}
		if (args[0] !== "show") throw new Error("unexpected systemctl call");
		if (args[1]?.startsWith("--property=") && args[2] === "--value")
			return args
				.slice(3)
				.map((unit) => one(args[1]!, unit))
				.join("\n\n");
		if (args[2]?.startsWith("--property=") && args[3] === "--value") return one(args[2], args[1]!);
		throw new Error("unexpected systemctl call");
	};
	return { root, run, calls };
}
const steps = (calls: string[][]) => calls.map((call) => (call[1] === "mask" ? "mask" : call[2]));

describe("office software install tool: self-update mask", () => {
	it("masks all five first, checks for a running job, then proves every link and unit state", async () => {
		const host = await systemd();
		await expect(maskOfficeSelfUpdateUnits(host.run, host.root)).resolves.toBeUndefined();
		expect(steps(host.calls)).toEqual([
			"--property=LoadState",
			"mask",
			"--property=ActiveState",
			"--property=UnitFileState",
		]);
		expect(host.calls[1]).toEqual(["/usr/bin/systemctl", "mask", ...UNITS]);
		expect(host.calls[2]?.slice(4)).toEqual(["apt-daily.service", "apt-daily-upgrade.service"]);
		for (const unit of UNITS) expect(readlinkSync(join(host.root, unit))).toBe("/dev/null");
	});

	it("skips the mask and its systemd reload when all five are already masked (a retried install)", async () => {
		const host = await systemd();
		await maskOfficeSelfUpdateUnits(host.run, host.root);
		host.calls.length = 0;
		await expect(maskOfficeSelfUpdateUnits(host.run, host.root)).resolves.toBeUndefined();
		expect(steps(host.calls)).toEqual(["--property=LoadState", "--property=ActiveState", "--property=UnitFileState"]);
	});

	it.each(["apt-daily.service", "apt-daily-upgrade.service"])(
		"refuses while %s is running, after masking so no new job starts",
		async (running) => {
			const host = await systemd({ running });
			await expect(maskOfficeSelfUpdateUnits(host.run, host.root)).rejects.toThrow(
				"OFFICE_SOFTWARE_CONTROL_APT_JOB_RUNNING",
			);
			expect(steps(host.calls).slice(0, 2)).toEqual(["--property=LoadState", "mask"]);
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

	it("refuses an answer that does not cover every unit", async () => {
		const host = await systemd();
		const run = (file: string, args: string[]) =>
			args[1] === "--property=LoadState" ? "masked" : host.run(file, args);
		await expect(maskOfficeSelfUpdateUnits(run, host.root)).rejects.toThrow("OFFICE_SOFTWARE_CONTROL_SYSTEMD");
	});

	it.each([{}, { running: "apt-daily-upgrade.service" }, { unmaskable: "apt-daily.timer" }, { reports: "enabled" }])(
		"agrees with the image installer's mask step (%o)",
		async (options) => {
			const tool = await systemd(options);
			const installer = await systemd(options);
			const outcome = (promise: Promise<void>) =>
				promise.then(
					() => "masked",
					() => "refused",
				);
			expect(await outcome(maskOfficeSelfUpdateUnits(tool.run, tool.root))).toBe(
				await outcome(maskOfficeImageSelfUpdate(installer.run, installer.root)),
			);
			// Same masks on disk afterwards.
			for (const unit of UNITS)
				expect(existsSync(join(tool.root, unit))).toBe(existsSync(join(installer.root, unit)));
		},
	);

	it("the install tool masks after every local check and before its own challenge check", () => {
		const source = readFileSync(
			new URL("../../../deploy/lxd-company-computer-guest/office-service-software-control.ts", import.meta.url),
			"utf8",
		);
		const locked = source.slice(source.indexOf("async function lockedInstall("));
		const at = (anchor: string, last = false) => {
			const index = last ? locked.lastIndexOf(anchor) : locked.indexOf(anchor);
			expect(index, anchor).toBeGreaterThanOrEqual(0);
			return index;
		};
		const mask = at("await maskOfficeSelfUpdateUnits();");
		// After the stop history is proven and every candidate is read ...
		expect(mask).toBeGreaterThan(at("const completedStop = await read("));
		expect(mask).toBeGreaterThan(at("await readServiceCandidate(", true));
		// ... and before the stopped-service recheck and the tool's challenge check.
		expect(mask).toBeLessThan(at("const manager = createCompanyComputerServiceStopSystemdManager();"));
		expect(mask).toBeLessThan(at("return await installOfficeSoftwareWithinChallenge("));
	});
});
