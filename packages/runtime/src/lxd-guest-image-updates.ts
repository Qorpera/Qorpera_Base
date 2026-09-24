import { readlink } from "node:fs/promises";
import { join } from "node:path";

/** The units through which a guest image upgrades itself. Their timers are
 * Persistent= with stamps from the image build, so apt-daily-upgrade catches up
 * about 30 s after every fresh boot; unattended-upgrades then has needrestart
 * restart the guest's services under the run, and its shutdown inhibitor
 * refuses the VM's poweroff. The image build masks all five. */
export const GUEST_IMAGE_SELF_UPDATE_UNITS = Object.freeze([
	"apt-daily.timer",
	"apt-daily-upgrade.timer",
	"apt-daily.service",
	"apt-daily-upgrade.service",
	"unattended-upgrades.service",
] as const);

export const GUEST_IMAGE_SELF_UPDATE_ENABLED = "RUNNER_IMAGE_SELF_UPDATE_ENABLED";

/** Refuses unless each unit is masked the way `systemctl mask` writes it: a
 * link from the local unit directory to /dev/null, which outranks the
 * packaged unit. The code names the first unit that is not masked. */
export async function assertGuestImageSelfUpdateMasked(unitDirectory = "/etc/systemd/system"): Promise<void> {
	for (const unit of GUEST_IMAGE_SELF_UPDATE_UNITS) {
		let target: string | undefined;
		try {
			target = await readlink(join(unitDirectory, unit));
		} catch (error) {
			// Absent, or a regular unit file rather than a link: not masked.
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "EINVAL") throw error;
		}
		if (target !== "/dev/null")
			throw new Error(`${GUEST_IMAGE_SELF_UPDATE_ENABLED}:${unit.toUpperCase().replace(/[.-]/g, "_")}`);
	}
}
