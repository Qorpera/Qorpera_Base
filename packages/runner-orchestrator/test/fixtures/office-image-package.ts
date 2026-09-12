import { createHash } from "node:crypto";
import {
	OFFICE_IMAGE_PACKAGE_FILES,
	OFFICE_IMAGE_RESET_PACKAGE_FILES,
} from "../../src/lxd-office-image-installation.ts";
export const officeImagePackageFixture = (reset = true) => ({
	schema: "qorpera.company-computer-package/v1",
	platform: "linux",
	minimumNode: "22.19.0",
	playwright: "1.62.1",
	imagePrerequisites: [
		"cgroup-v2",
		"systemd-credentials",
		"unprivileged-user-namespaces",
		"bubblewrap",
		"tini",
		"xfce",
		"tigervnc",
		"chromium",
	],
	artifacts: [
		...OFFICE_IMAGE_PACKAGE_FILES,
		...(reset ? OFFICE_IMAGE_RESET_PACKAGE_FILES : []),
		"node_modules/playwright-core/package.json",
		"node_modules/playwright-core/index.mjs",
		"node_modules/playwright-core/browsers.json",
		"wallpapers/qorpera-screen-pebble.png",
	].map((file) => {
		const mount = Buffer.from("[Mount]\nOptions=uid=@OFFICE_UID@,gid=@OFFICE_GID@\n");
		return file === "qorpera-office-private.mount.in"
			? { file, bytes: mount.length, sha256: createHash("sha256").update(mount).digest("hex") }
			: { file, bytes: 1, sha256: "a".repeat(64) };
	}),
});
export const officeImagePackageBytes = () => Buffer.from(JSON.stringify(officeImagePackageFixture()));
export const officeImagePackageSha256 = () => createHash("sha256").update(officeImagePackageBytes()).digest("hex");
