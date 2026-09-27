import { mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	assertGuestImageSelfUpdateMasked,
	GUEST_IMAGE_SELF_UPDATE_UNITS,
	guestImageSelfUpdateCode,
} from "../src/lxd-guest-image-updates.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A unit directory as `systemctl mask` leaves it: each unit a link to /dev/null. */
async function masked(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "qorpera-image-units-"));
	roots.push(root);
	for (const unit of GUEST_IMAGE_SELF_UPDATE_UNITS) await symlink("/dev/null", join(root, unit));
	return root;
}

describe("guest image self-update guard", () => {
	it("covers exactly the apt timers, their services and the unattended-upgrades service", () => {
		expect(GUEST_IMAGE_SELF_UPDATE_UNITS).toEqual([
			"apt-daily.timer",
			"apt-daily-upgrade.timer",
			"apt-daily.service",
			"apt-daily-upgrade.service",
			"unattended-upgrades.service",
		]);
	});

	it("names each unit in one fixed code", () => {
		expect(GUEST_IMAGE_SELF_UPDATE_UNITS.map(guestImageSelfUpdateCode)).toEqual([
			"RUNNER_IMAGE_SELF_UPDATE_ENABLED:APT_DAILY_TIMER",
			"RUNNER_IMAGE_SELF_UPDATE_ENABLED:APT_DAILY_UPGRADE_TIMER",
			"RUNNER_IMAGE_SELF_UPDATE_ENABLED:APT_DAILY_SERVICE",
			"RUNNER_IMAGE_SELF_UPDATE_ENABLED:APT_DAILY_UPGRADE_SERVICE",
			"RUNNER_IMAGE_SELF_UPDATE_ENABLED:UNATTENDED_UPGRADES_SERVICE",
		]);
	});

	it("accepts an image whose five units are all masked", async () => {
		await expect(assertGuestImageSelfUpdateMasked(await masked())).resolves.toBeUndefined();
	});

	it.each(GUEST_IMAGE_SELF_UPDATE_UNITS.map((unit) => [unit]))("refuses when %s is not masked", async (unit) => {
		const root = await masked();
		await unlink(join(root, unit));
		const code = `RUNNER_IMAGE_SELF_UPDATE_ENABLED:${unit.toUpperCase().replace(/[.-]/g, "_")}`;
		await expect(assertGuestImageSelfUpdateMasked(root)).rejects.toThrow(code);
	});

	it.each([
		["an enablement link to the packaged unit", async (path: string) => symlink("/usr/lib/systemd/system/x", path)],
		["a relative link that only resolves to /dev/null", async (path: string) => symlink("../../../dev/null", path)],
		["a regular unit file", async (path: string) => writeFile(path, "[Timer]\n")],
		["an empty unit file", async (path: string) => writeFile(path, "")],
	])("refuses %s in place of the mask", async (_label, replace) => {
		const root = await masked();
		await unlink(join(root, "apt-daily-upgrade.timer"));
		await replace(join(root, "apt-daily-upgrade.timer"));
		await expect(assertGuestImageSelfUpdateMasked(root)).rejects.toThrow(
			"RUNNER_IMAGE_SELF_UPDATE_ENABLED:APT_DAILY_UPGRADE_TIMER",
		);
	});

	it("refuses when the unit directory is missing", async () => {
		const root = await masked();
		await expect(assertGuestImageSelfUpdateMasked(join(root, "absent"))).rejects.toThrow(
			"RUNNER_IMAGE_SELF_UPDATE_ENABLED:APT_DAILY_TIMER",
		);
	});
});
