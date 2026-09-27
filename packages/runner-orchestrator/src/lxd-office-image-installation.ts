import { posix } from "node:path";
import { officeRecord, officeSha } from "./lxd-office-image-provenance.ts";
import { officePhysicalPath } from "./lxd-office-physical-policy.ts";

export const OFFICE_IMAGE_ROOT = "/opt/qorpera-office";
export const OFFICE_IMAGE_MOUNT_UNIT = "run-qorpera\\x2doffice-private.mount";
export const OFFICE_IMAGE_USER = "qorpera-office";
/** The apt units through which an image upgrades itself. The office service
 * and preparation refuse unless all are masked. This list must equal the
 * guests' (lxd-guest-image-updates.ts); scripts/office-image-self-update.test.mjs
 * checks it. */
export const OFFICE_IMAGE_SELF_UPDATE_UNITS = Object.freeze([
	"apt-daily.timer",
	"apt-daily-upgrade.timer",
	"apt-daily.service",
	"apt-daily-upgrade.service",
	"unattended-upgrades.service",
] as const);
export const OFFICE_IMAGE_EXECUTABLES = [
	"/usr/bin/node",
	"/usr/bin/flock",
	"/usr/bin/bwrap",
	"/usr/bin/tini",
	"/usr/bin/bash",
	"/usr/bin/Xtigervnc",
	"/usr/bin/xfce4-session",
	"/usr/bin/xfwm4",
	"/usr/bin/xfconf-query",
	"/usr/bin/dbus-run-session",
	"/usr/bin/xset",
	"/usr/bin/xprop",
	"/usr/bin/xdotool",
	"/usr/bin/scrot",
	"/usr/bin/systemctl",
	"/usr/bin/systemd-tmpfiles",
	"/usr/sbin/apparmor_parser",
	"/usr/lib/qorpera-chromium/chrome",
] as const;
export const OFFICE_IMAGE_PACKAGE_FILES = [
	"qorpera-company-computer-service.mjs",
	"qorpera-company-computer-preparation.mjs",
	"qorpera-company-computer-preparation-control.mjs",
	"qorpera-company-computer-configuration-control.mjs",
	"qorpera-company-computer-boot-configuration-control.mjs",
	"qorpera-company-computer-boot-service-start-control.mjs",
	"qorpera-company-computer-boot-service-restart-control.mjs",
	"qorpera-company-computer-service-start-control.mjs",
	"qorpera-company-computer-service-stop-control.mjs",
	"qorpera-company-computer-service-restart-control.mjs",
	"office-browser-child.mjs",
	"qorpera-office-image-install.cjs",
	"qorpera-company-computer.service",
	"qorpera-company-computer-preparation.service",
	"qorpera-office-preparation.conf",
	"qorpera-office-runtime.conf",
	"qorpera-office-private.mount.in",
	"qorpera-screen-session",
	"qorpera-screen-xfce",
	"qorpera-browser-policy.json",
	"qorpera-office-browser-bwrap.apparmor",
	"LICENSE",
] as const;

/** Desktop helpers admitted by newer packages; historical packages without them remain valid. */
export const OFFICE_IMAGE_DESKTOP_PACKAGE_FILES = ["qorpera-screen-browser"] as const;

export const OFFICE_IMAGE_RESET_PACKAGE_FILES = [
	"qorpera-company-computer-reset-configuration-control.mjs",
	"qorpera-company-computer-reset-service-start-control.mjs",
	"qorpera-company-computer-reset-service-restart-control.mjs",
] as const;

/** Explicit reset capability of an already validated, immutable image package.
 * Historical v1 packages remain valid for their original service-only uses. */
export function assertOfficeImageResetCapability(value: ReturnType<typeof parseOfficeImagePackage>): void {
	if (
		OFFICE_IMAGE_RESET_PACKAGE_FILES.some(
			(file) => !value.artifacts.some((artifact) => artifact.file === file && artifact.bytes > 0),
		)
	)
		throw new Error("OFFICE_RESET_IMAGE_CAPABILITY_UNCONFIRMED");
}

function imageId(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 2147483647)
		throw new Error("OFFICE_IMAGE_ID_INVALID");
	return value as number;
}

export function parseOfficeImageInstallationSpec(value: unknown) {
	const r = officeRecord(value, [
		"schema",
		"packageRoot",
		"packageManifestSha256",
		"uid",
		"gid",
		"architecture",
		"dependencies",
	]);
	if (r.schema !== "qorpera.office-image-installation/v1" || !["x64", "arm64"].includes(r.architecture as string))
		throw new Error("OFFICE_IMAGE_SPEC_INVALID");
	const d = officeRecord(r.dependencies, [
		"osReleaseSha256",
		"dpkgManifestSha256",
		"browserTreeSha256",
		"executables",
	]);
	const executables = officeRecord(d.executables, [...OFFICE_IMAGE_EXECUTABLES]);
	return {
		packageRoot: officePhysicalPath(r.packageRoot),
		packageManifestSha256: officeSha(r.packageManifestSha256),
		uid: imageId(r.uid),
		gid: imageId(r.gid),
		architecture: r.architecture as "x64" | "arm64",
		dependencies: {
			osReleaseSha256: officeSha(d.osReleaseSha256),
			dpkgManifestSha256: officeSha(d.dpkgManifestSha256),
			browserTreeSha256: officeSha(d.browserTreeSha256),
			executables: Object.fromEntries(OFFICE_IMAGE_EXECUTABLES.map((path) => [path, officeSha(executables[path])])),
		},
	};
}

export function officeImageDestination(file: string): { path: string; mode: number } {
	if (file === "qorpera-office-browser-bwrap.apparmor")
		return { path: "/etc/apparmor.d/qorpera-office-browser-bwrap", mode: 0o444 };
	if (file === "qorpera-office-private.mount.in")
		return { path: `/etc/systemd/system/${OFFICE_IMAGE_MOUNT_UNIT}`, mode: 0o644 };
	if (["qorpera-company-computer.service", "qorpera-company-computer-preparation.service"].includes(file))
		return { path: `/etc/systemd/system/${file}`, mode: 0o644 };
	if (["qorpera-office-runtime.conf", "qorpera-office-preparation.conf"].includes(file))
		return { path: `/usr/lib/tmpfiles.d/${file}`, mode: 0o644 };
	if (["qorpera-screen-session", "qorpera-screen-xfce", ...OFFICE_IMAGE_DESKTOP_PACKAGE_FILES].includes(file))
		return { path: `/usr/local/bin/${file}`, mode: 0o555 };
	if (file === "qorpera-browser-policy.json")
		return { path: "/usr/local/share/qorpera/browser-policy.json", mode: 0o444 };
	if (file === "office-browser-child.mjs")
		return { path: "/usr/local/lib/qorpera/office-browser-child.mjs", mode: 0o444 };
	// Static figure plus the optional hourly tone-on-tone frames (-00 .. -23).
	if (/^wallpapers\/qorpera-screen-[a-z]+(?:-(?:[01][0-9]|2[0-3]))?\.png$/.test(file))
		return { path: `/usr/share/backgrounds/${posix.basename(file)}`, mode: 0o444 };
	if (([...OFFICE_IMAGE_PACKAGE_FILES, ...OFFICE_IMAGE_RESET_PACKAGE_FILES] as readonly string[]).includes(file))
		return { path: `${OFFICE_IMAGE_ROOT}/${file}`, mode: 0o444 };
	if (
		file.startsWith("node_modules/playwright-core/") &&
		/^[a-zA-Z0-9._/-]+$/.test(file) &&
		!file.split("/").some((p) => !p || p === "." || p === "..")
	)
		return { path: `${OFFICE_IMAGE_ROOT}/${file}`, mode: 0o444 };
	throw new Error("OFFICE_IMAGE_PACKAGE_PATH_INVALID");
}

export function parseOfficeImagePackage(value: unknown) {
	const r = officeRecord(value, [
		"schema",
		"platform",
		"minimumNode",
		"playwright",
		"artifacts",
		"imagePrerequisites",
	]);
	if (
		r.schema !== "qorpera.company-computer-package/v1" ||
		r.platform !== "linux" ||
		r.minimumNode !== "22.19.0" ||
		typeof r.playwright !== "string" ||
		!/^\d+\.\d+\.\d+$/.test(r.playwright) ||
		JSON.stringify(r.imagePrerequisites) !==
			JSON.stringify([
				"cgroup-v2",
				"systemd-credentials",
				"unprivileged-user-namespaces",
				"bubblewrap",
				"tini",
				"xfce",
				"tigervnc",
				"chromium",
			]) ||
		!Array.isArray(r.artifacts) ||
		r.artifacts.length < OFFICE_IMAGE_PACKAGE_FILES.length + 4 ||
		r.artifacts.length > 4096
	)
		throw new Error("OFFICE_IMAGE_PACKAGE_INVALID");
	const files = new Set<string>();
	let total = 0;
	const artifacts = r.artifacts.map((value) => {
		const a = officeRecord(value, ["file", "bytes", "sha256"]);
		if (
			typeof a.file !== "string" ||
			files.has(a.file) ||
			!Number.isSafeInteger(a.bytes) ||
			(a.bytes as number) < 0 ||
			(a.bytes as number) > 32 * 1024 ** 2
		)
			throw new Error("OFFICE_IMAGE_ARTIFACT_INVALID");
		files.add(a.file);
		total += a.bytes as number;
		return { file: a.file, bytes: a.bytes as number, sha256: officeSha(a.sha256), ...officeImageDestination(a.file) };
	});
	if (
		total > 128 * 1024 ** 2 ||
		[
			...OFFICE_IMAGE_PACKAGE_FILES,
			"node_modules/playwright-core/package.json",
			"node_modules/playwright-core/index.mjs",
			"node_modules/playwright-core/browsers.json",
			"wallpapers/qorpera-screen-pebble.png",
		].some((f) => !files.has(f))
	)
		throw new Error("OFFICE_IMAGE_PACKAGE_INCOMPLETE");
	return { artifacts, playwright: r.playwright };
}

export function renderOfficeImageMount(template: string, uid: number, gid: number): string {
	if (template.split("@OFFICE_UID@").length !== 2 || template.split("@OFFICE_GID@").length !== 2)
		throw new Error("OFFICE_IMAGE_MOUNT_INVALID");
	return template.replace("@OFFICE_UID@", String(imageId(uid))).replace("@OFFICE_GID@", String(imageId(gid)));
}
