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
			// A longer call can never fit the provider's 5 s install challenge.
			timeout: 4000,
			maxBuffer: 65536,
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch {
		throw new Error("OFFICE_SOFTWARE_CONTROL_SYSTEMD");
	}
}

/** One property of several units, one value per unit (systemctl separates
 * units by a blank line). */
function values(run: OfficeSelfUpdateCommand, property: string, units: readonly string[]): string[] {
	const found = run("/usr/bin/systemctl", ["show", `--property=${property}`, "--value", ...units])
		.split(/\n+/)
		.filter(Boolean);
	if (found.length !== units.length) throw new Error("OFFICE_SOFTWARE_CONTROL_SYSTEMD");
	return found;
}

/** An office on an image that can update itself has needrestart restart the
 * office under members and its shutdown inhibitor refuse the VM's stop (run
 * d1f454e2, 2026-09-24). The software install tool masks the apt units before
 * any service lands; a v98+ office service refuses to start without them, so
 * the successor's measured start proves this step. The same checks as the
 * image installer's maskOfficeImageSelfUpdate, kept outside the provider
 * packages so this root tool does not bundle the provider.
 *
 * The tool runs inside the provider's 5 s install challenge, so the work is
 * kept small: units already masked (a retried install, or an image the
 * installer masked) skip the mask call and its systemd reload, and each check
 * is one systemctl call. Masking comes first, so no timer starts a job after
 * the check; a job already running is refused, never stopped mid-upgrade. */
export async function maskOfficeSelfUpdateUnits(
	run: OfficeSelfUpdateCommand = systemctl,
	unitDirectory = "/etc/systemd/system",
): Promise<void> {
	if (values(run, "LoadState", GUEST_IMAGE_SELF_UPDATE_UNITS).some((state) => state !== "masked"))
		run("/usr/bin/systemctl", ["mask", ...GUEST_IMAGE_SELF_UPDATE_UNITS]);
	if (
		values(run, "ActiveState", ["apt-daily.service", "apt-daily-upgrade.service"]).some(
			(state) => state !== "inactive" && state !== "failed",
		)
	)
		throw new Error("OFFICE_SOFTWARE_CONTROL_APT_JOB_RUNNING");
	await assertGuestImageSelfUpdateMasked(unitDirectory);
	if (values(run, "UnitFileState", GUEST_IMAGE_SELF_UPDATE_UNITS).some((state) => state !== "masked"))
		throw new Error("OFFICE_SOFTWARE_CONTROL_SELF_UPDATE_ENABLED");
}
