import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	assertOfficeImageResetCapability,
	OFFICE_IMAGE_AGENT_PLUG_PACKAGE_FILES,
	OFFICE_IMAGE_EXECUTABLES,
	OFFICE_IMAGE_FOLDER_MOUNT_UNIT,
	OFFICE_IMAGE_FOLDER_PACKAGE_FILES,
	OFFICE_IMAGE_FOLDER_PROGRAM,
	OFFICE_IMAGE_MOUNT_UNIT,
	OFFICE_IMAGE_NETWORK_PACKAGE_FILES,
	OFFICE_IMAGE_PACKAGE_FILES,
	OFFICE_IMAGE_RESET_PACKAGE_FILES,
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
	it("preserves historical packages while requiring explicit reset helper inventory", () => {
		const historical = parseOfficeImagePackage(manifest);
		expect(() => assertOfficeImageResetCapability(historical)).toThrow("OFFICE_RESET_IMAGE_CAPABILITY_UNCONFIRMED");
		const artifacts = [
			...manifest.artifacts,
			...OFFICE_IMAGE_RESET_PACKAGE_FILES.map((file) => ({ file, bytes: 1, sha256: sha })),
		];
		expect(() => assertOfficeImageResetCapability(parseOfficeImagePackage({ ...manifest, artifacts }))).not.toThrow();
		for (const missing of OFFICE_IMAGE_RESET_PACKAGE_FILES)
			expect(() =>
				assertOfficeImageResetCapability(
					parseOfficeImagePackage({ ...manifest, artifacts: artifacts.filter((a) => a.file !== missing) }),
				),
			).toThrow("OFFICE_RESET_IMAGE_CAPABILITY_UNCONFIRMED");
	});
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
	it("pins the AppArmor parser and requires the browser profile in the package closure", () => {
		const executables = { ...spec.dependencies.executables };
		delete executables["/usr/sbin/apparmor_parser"];
		expect(() =>
			parseOfficeImageInstallationSpec({ ...spec, dependencies: { ...spec.dependencies, executables } }),
		).toThrow();
		expect(() =>
			parseOfficeImagePackage({
				...manifest,
				artifacts: manifest.artifacts.filter((a) => a.file !== "qorpera-office-browser-bwrap.apparmor"),
			}),
		).toThrow();
		expect(officeImageDestination("qorpera-office-browser-bwrap.apparmor")).toEqual({
			path: "/etc/apparmor.d/qorpera-office-browser-bwrap",
			mode: 0o444,
		});
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
		expect(officeImageDestination("qorpera-screen-browser")).toEqual({
			path: "/usr/local/bin/qorpera-screen-browser",
			mode: 0o555,
		});
		// Each computer's own network: the root plumber, its firewall and units.
		expect(officeImageDestination("qorpera-computer-plumb")).toEqual({
			path: "/usr/local/lib/qorpera/qorpera-computer-plumb",
			mode: 0o500,
		});
		expect(officeImageDestination("qorpera-computer-network.nft")).toEqual({
			path: "/usr/local/share/qorpera/computer-network.nft",
			mode: 0o444,
		});
		for (const unit of [
			"qorpera-computer-network.service",
			"qorpera-computer-plumb.socket",
			"qorpera-computer-plumb@.service",
		])
			expect(officeImageDestination(unit)).toEqual({ path: `/etc/systemd/system/${unit}`, mode: 0o644 });
		const network = OFFICE_IMAGE_NETWORK_PACKAGE_FILES.map((file) => ({ file, bytes: 1, sha256: sha }));
		expect(() =>
			parseOfficeImagePackage({ ...manifest, artifacts: [...manifest.artifacts, ...network] }),
		).not.toThrow();
		for (const missing of OFFICE_IMAGE_NETWORK_PACKAGE_FILES)
			expect(() =>
				parseOfficeImagePackage({
					...manifest,
					artifacts: [...manifest.artifacts, ...network.filter((a) => a.file !== missing)],
				}),
			).toThrow("OFFICE_IMAGE_PACKAGE_INCOMPLETE");
		// The machine's agent card: named before netplan and udev's own names, and
		// systemd-networkd kept off it and off the plumber's routes.
		expect(officeImageDestination("qorpera-agent-plug.rules")).toEqual({
			path: "/etc/udev/rules.d/70-qorpera-agent-plug.rules",
			mode: 0o644,
		});
		expect(officeImageDestination("qorpera-agent-plug.network")).toEqual({
			path: "/etc/systemd/network/00-qorpera-agent-plug.network",
			mode: 0o644,
		});
		expect(officeImageDestination("qorpera-agent-plug-networkd.conf")).toEqual({
			path: "/etc/systemd/networkd.conf.d/qorpera-agent-plug.conf",
			mode: 0o644,
		});
		const plug = OFFICE_IMAGE_AGENT_PLUG_PACKAGE_FILES.map((file) => ({ file, bytes: 1, sha256: sha }));
		expect(() =>
			parseOfficeImagePackage({ ...manifest, artifacts: [...manifest.artifacts, ...network, ...plug] }),
		).not.toThrow();
		expect(() => parseOfficeImagePackage({ ...manifest, artifacts: [...manifest.artifacts, ...plug] })).toThrow(
			"OFFICE_IMAGE_PACKAGE_INCOMPLETE",
		);
		for (const missing of OFFICE_IMAGE_AGENT_PLUG_PACKAGE_FILES)
			expect(() =>
				parseOfficeImagePackage({
					...manifest,
					artifacts: [...manifest.artifacts, ...network, ...plug.filter((a) => a.file !== missing)],
				}),
			).toThrow("OFFICE_IMAGE_PACKAGE_INCOMPLETE");
		// The packaged files are the ones installed.
		const packaged = readFileSync(new URL("../../../scripts/package-company-computer.mjs", import.meta.url), "utf8");
		for (const file of [...OFFICE_IMAGE_NETWORK_PACKAGE_FILES, ...OFFICE_IMAGE_AGENT_PLUG_PACKAGE_FILES])
			expect(packaged).toContain(`"${file}"`);
		// The machine's firewall and each computer's own filter block the same ranges.
		const ranges = (text: string) =>
			/elements = \{([^}]*)\}/
				.exec(text)?.[1]
				?.split(",")
				.map((range) => range.trim());
		const deploy = new URL("../../../deploy/lxd-company-computer-guest/", import.meta.url);
		const machine = ranges(readFileSync(new URL("qorpera-computer-network.nft", deploy), "utf8"));
		expect(machine).toContain("169.254.0.0/16");
		expect(ranges(readFileSync(new URL("qorpera-computer-plumb", deploy), "utf8"))).toEqual(machine);
		for (const frame of ["qorpera-screen-brain.png", "qorpera-screen-brain-00.png", "qorpera-screen-brain-23.png"])
			expect(officeImageDestination(`wallpapers/${frame}`)).toEqual({
				path: `/usr/share/backgrounds/${frame}`,
				mode: 0o444,
			});
		for (const frame of ["qorpera-screen-brain-24.png", "qorpera-screen-brain-7.png", "qorpera-screen-Brain.png"])
			expect(() => officeImageDestination(`wallpapers/${frame}`)).toThrow("OFFICE_IMAGE_PACKAGE_PATH_INVALID");
	});
	it("admits the company folder's program, helper and units together, where the helper's units run them", () => {
		expect(OFFICE_IMAGE_FOLDER_PACKAGE_FILES.map((file) => officeImageDestination(file))).toEqual([
			{ path: "/opt/qorpera-office/qorpera-company-computer-folder-helper.mjs", mode: 0o444 },
			{ path: "/etc/systemd/system/qorpera-office-folder-helper.service", mode: 0o644 },
			{ path: "/etc/systemd/system/qorpera-office-folder-helper.socket", mode: 0o644 },
			{ path: `/etc/systemd/system/${OFFICE_IMAGE_FOLDER_MOUNT_UNIT}`, mode: 0o644 },
			{ path: OFFICE_IMAGE_FOLDER_PROGRAM, mode: 0o555 },
		]);
		const folder = OFFICE_IMAGE_FOLDER_PACKAGE_FILES.map((file) => ({ file, bytes: 1, sha256: sha }));
		expect(() => parseOfficeImagePackage({ ...manifest, artifacts: [...manifest.artifacts, ...folder] })).not.toThrow();
		for (const missing of OFFICE_IMAGE_FOLDER_PACKAGE_FILES)
			expect(() =>
				parseOfficeImagePackage({
					...manifest,
					artifacts: [...manifest.artifacts, ...folder.filter((a) => a.file !== missing)],
				}),
			).toThrow("OFFICE_IMAGE_PACKAGE_INCOMPLETE");
		// The helper's units name the installed paths.
		const deploy = new URL("../../../deploy/lxd-company-computer-guest/", import.meta.url);
		expect(readFileSync(new URL("qorpera-office-folder-helper.service", deploy), "utf8")).toContain(
			`ExecStart=/usr/bin/node /opt/qorpera-office/${OFFICE_IMAGE_FOLDER_PACKAGE_FILES[0]}\n`,
		);
		expect(readFileSync(new URL("qorpera-office-folder-mount@.service.in", deploy), "utf8")).toContain(
			`ExecStart=${OFFICE_IMAGE_FOLDER_PROGRAM} mount `,
		);
		// The helper is image code: the office's own code never lists it.
		expect(OFFICE_IMAGE_PACKAGE_FILES as readonly string[]).not.toContain(OFFICE_IMAGE_FOLDER_PACKAGE_FILES[0]);
		expect(OFFICE_IMAGE_EXECUTABLES as readonly string[]).not.toContain(OFFICE_IMAGE_FOLDER_PROGRAM);
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
	it("renders the office account's ids into the folder mount template once each", () => {
		const template = readFileSync(
			new URL("../../../deploy/lxd-company-computer-guest/qorpera-office-folder-mount@.service.in", import.meta.url),
			"utf8",
		);
		const unit = renderOfficeImageMount(template, 1100, 1101);
		expect(unit).toContain("--owner-uid 1100 --owner-gid 1101");
		expect(unit).not.toContain("@OFFICE_");
		expect(unit).not.toContain("WantedBy=");
	});
});
