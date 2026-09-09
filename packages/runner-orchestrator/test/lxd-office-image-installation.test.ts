import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	OFFICE_IMAGE_EXECUTABLES,
	OFFICE_IMAGE_MOUNT_UNIT,
	OFFICE_IMAGE_PACKAGE_FILES,
	officeImageDestination,
	parseOfficeImageInstallationSpec,
	parseOfficeImagePackage,
	renderOfficeImageMount,
} from "../src/lxd-office-image-installation.ts";

const sha = "a".repeat(64);
const spec = {
	schema: "qorpera.office-image-installation/v1",
	packageRoot: "/srv/image/package",
	packageManifestSha256: sha,
	uid: 1100,
	gid: 1100,
	architecture: "arm64",
	dependencies: {
		osReleaseSha256: sha,
		dpkgManifestSha256: sha,
		browserTreeSha256: sha,
		executables: Object.fromEntries(OFFICE_IMAGE_EXECUTABLES.map((path) => [path, sha])),
	},
};
const manifest = {
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
		"node_modules/playwright-core/package.json",
		"node_modules/playwright-core/index.mjs",
		"node_modules/playwright-core/browsers.json",
		"wallpapers/qorpera-screen-pebble.png",
	].map((file) => ({ file, bytes: 1, sha256: sha })),
};
describe("office image installation contract", () => {
	it("requires the reviewed dependency inventory and a dedicated non-root identity", () => {
		expect(parseOfficeImageInstallationSpec(spec).dependencies.executables).toEqual(spec.dependencies.executables);
		for (const invalid of [
			{ ...spec, uid: 0 },
			{ ...spec, startService: true },
			{ ...spec, architecture: "x86" },
			{ ...spec, dependencies: { ...spec.dependencies, executables: {} } },
		])
			expect(() => parseOfficeImageInstallationSpec(invalid)).toThrow();
	});
	it("requires an explicit digest for the kernel-lock launcher", () => {
		const executables = { ...spec.dependencies.executables };
		delete executables["/usr/bin/flock"];
		expect(() =>
			parseOfficeImageInstallationSpec({ ...spec, dependencies: { ...spec.dependencies, executables } }),
		).toThrow();
	});
	it("maps the complete runtime package to the paths consumed by the guest", () => {
		const result = parseOfficeImagePackage(manifest);
		expect(result.artifacts.find((a) => a.file === "office-browser-child.mjs")?.path).toBe(
			"/usr/local/lib/qorpera/office-browser-child.mjs",
		);
		expect(officeImageDestination("qorpera-office-runtime.conf").path).toBe(
			"/usr/lib/tmpfiles.d/qorpera-office-runtime.conf",
		);
		expect(officeImageDestination("qorpera-screen-session")).toEqual({
			path: "/usr/local/bin/qorpera-screen-session",
			mode: 0o555,
		});
		expect(officeImageDestination("qorpera-office-private.mount.in").path).toBe(
			`/etc/systemd/system/${OFFICE_IMAGE_MOUNT_UNIT}`,
		);
	});
	it("rejects arbitrary paths, traversal and duplicated or missing artifacts", () => {
		for (const path of [
			"/etc/passwd",
			"../outside",
			"qorpera-office-runtime.conf/other",
			"node_modules/playwright-core/../../outside",
			"node_modules/playwright-core/a//b",
			"wallpapers/other.png",
		])
			expect(() => officeImageDestination(path)).toThrow();
		for (const artifacts of [
			manifest.artifacts.slice(1),
			[...manifest.artifacts, manifest.artifacts[0]],
			[...manifest.artifacts, { file: "unknown.mjs", bytes: 1, sha256: sha }],
		])
			expect(() => parseOfficeImagePackage({ ...manifest, artifacts })).toThrow();
	});
	it("bounds package files and bytes without rejecting inert empty dependency files", () => {
		expect(
			parseOfficeImagePackage({
				...manifest,
				artifacts: [...manifest.artifacts, { file: "node_modules/playwright-core/empty", bytes: 0, sha256: sha }],
			}).artifacts,
		).toHaveLength(manifest.artifacts.length + 1);
		expect(() =>
			parseOfficeImagePackage({
				...manifest,
				artifacts: manifest.artifacts.map((a) => ({ ...a, bytes: 33 * 1024 ** 2 })),
			}),
		).toThrow();
		expect(() =>
			parseOfficeImagePackage({ ...manifest, artifacts: Array.from({ length: 4097 }, () => manifest.artifacts[0]) }),
		).toThrow();
	});
	it("renders only numeric ownership into the demand mount with boot ordering", () => {
		const template = readFileSync(
			new URL("../../../deploy/lxd-company-computer-guest/qorpera-office-private.mount.in", import.meta.url),
			"utf8",
		);
		const unit = renderOfficeImageMount(template, 1100, 1101);
		expect(unit).toContain("uid=1100,gid=1101");
		expect(unit).toContain("DefaultDependencies=no");
		expect(unit).toContain("Conflicts=umount.target");
		expect(unit).not.toContain("WantedBy=");
		expect(() => renderOfficeImageMount(template, 0, 1100)).toThrow();
		expect(() => renderOfficeImageMount(template.replace("@OFFICE_UID@", "0"), 1100, 1100)).toThrow();
	});
});
