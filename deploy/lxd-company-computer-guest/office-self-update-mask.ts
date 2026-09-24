import { execFileSync } from "node:child_process";
import {
	assertGuestImageSelfUpdateMasked,
	GUEST_IMAGE_SELF_UPDATE_UNITS,
} from "../../packages/runtime/src/lxd-guest-image-updates.ts";

export type OfficeSelfUpdateCommand = (file: string, args: string[]) => string;

const ENVIRONMENT = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C", LC_ALL: "C" };
function systemctl(file: string, args: string[]): string {
	try {
		return execFileSync(file, args, {
			encoding: "utf8",
			env: ENVIRONMENT,
			timeout: 10000,
			maxBuffer: 65536,
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch {
		throw new Error("OFFICE_SOFTWARE_CONTROL_SYSTEMD");
	}
}

/** An office on an image that can update itself has needrestart restart the
 * office under members and its shutdown inhibitor refuse the VM's stop (run
 * d1f454e2, 2026-09-24). The software install tool masks the apt units before
 * any service lands; a v98+ office service refuses to start without them, so
 * the successor's measured start proves this step. The same steps as the image
 * installer's maskOfficeImageSelfUpdate, kept outside the provider packages so
 * this root tool does not bundle the provider. Masking first means no timer
 * starts a job after the check; a job already running is refused, never
 * stopped mid-upgrade. Idempotent. */
export async function maskOfficeSelfUpdateUnits(
	run: OfficeSelfUpdateCommand = systemctl,
	unitDirectory = "/etc/systemd/system",
): Promise<void> {
	run("/usr/bin/systemctl", ["mask", ...GUEST_IMAGE_SELF_UPDATE_UNITS]);
	for (const unit of ["apt-daily.service", "apt-daily-upgrade.service"])
		if (!["inactive", "failed"].includes(run("/usr/bin/systemctl", ["show", unit, "--property=ActiveState", "--value"])))
			throw new Error("OFFICE_SOFTWARE_CONTROL_APT_JOB_RUNNING");
	await assertGuestImageSelfUpdateMasked(unitDirectory);
	for (const unit of GUEST_IMAGE_SELF_UPDATE_UNITS)
		if (run("/usr/bin/systemctl", ["show", unit, "--property=UnitFileState", "--value"]) !== "masked")
			throw new Error("OFFICE_SOFTWARE_CONTROL_SELF_UPDATE_ENABLED");
}
