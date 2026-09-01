import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertCompanyComputerScreenBinding } from "../src/cloud-company-computer-contract.ts";
import {
	companyComputerScreenCreature,
	prepareCompanyComputerScreenWallpaper,
} from "../src/cloud-company-computer-desktop.ts";
import type { CompanyComputerGuestBoundary } from "../src/cloud-company-computer-guest.ts";
import { STAFF_CHARACTER_BY_TEMPLATE, STAFF_CHARACTER_IDS } from "../src/staff-characters.ts";
import { computerBinding, computerId } from "./fixtures/company-computer.ts";

const roots: string[] = [];
const execute = promisify(execFile);
const xfceHelper = fileURLToPath(
	new URL("../../../deploy/lxd-company-computer-guest/qorpera-screen-xfce", import.meta.url),
);
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function desktopFixture() {
	const root = await mkdtemp(join(await realpath(tmpdir()), "qorpera-desktop-"));
	roots.push(root);
	const layout = {
		workbenchRoot: join(root, "workbench"),
		desktopHome: join(root, "home"),
		screenStateRoot: join(root, "screens"),
		browserProfilesRoot: join(root, "profiles"),
	};
	const imageRoot = join(root, "image");
	await Promise.all([...Object.values(layout), imageRoot].map((directory) => mkdir(directory)));
	for (const creature of STAFF_CHARACTER_IDS)
		await writeFile(join(imageRoot, `qorpera-screen-${creature}.png`), `synthetic ${creature} image bytes`);
	const binding = computerBinding();
	const boundary: CompanyComputerGuestBoundary = {
		assertReady: vi.fn(async (actual) => assertCompanyComputerScreenBinding(actual, binding)),
	};
	return { root, layout, imageRoot, binding, boundary, templateId: "agent-manager" };
}

describe("restored agent wallpaper preparation (synthetic image bytes, local filesystem)", () => {
	it("uses the existing template mapping and renderer identity hash without accepting arbitrary asset names", () => {
		for (const [template, character] of Object.entries(STAFF_CHARACTER_BY_TEMPLATE))
			expect(companyComputerScreenCreature(computerBinding(), template)).toBe(character);
		const binding = computerBinding();
		let seed = 0;
		for (const character of binding.staffAgentId) seed = (seed * 31 + character.charCodeAt(0)) >>> 0;
		for (const template of [undefined, "unknown-template", "__proto__", "../../outside"])
			expect(companyComputerScreenCreature(binding, template)).toBe(
				STAFF_CHARACTER_IDS[seed % STAFF_CHARACTER_IDS.length],
			);
		expect(companyComputerScreenCreature(binding, "agent-manager", "bloom")).toBe("bloom");
		expect(companyComputerScreenCreature(binding, "agent-manager", "../../outside")).toBe("brain");
		expect(() => companyComputerScreenCreature({ ...binding, screenOrdinal: 33 })).toThrow("SCREEN_BINDING_MISMATCH");
	});

	it("publishes the exact image bytes under the bound UUID and refreshes appearance without deleting desktop settings", async () => {
		const fixture = await desktopFixture();
		const signal = new AbortController().signal;
		const first = await prepareCompanyComputerScreenWallpaper(fixture, signal);
		expect(first).toEqual({
			wallpaper: join(fixture.layout.screenStateRoot, computerId(6), "wallpaper.png"),
			creature: "brain",
		});
		expect(await readFile(first.wallpaper, "utf8")).toBe("synthetic brain image bytes");
		expect((await stat(first.wallpaper)).mode & 0o777).toBe(0o600);
		const config = join(fixture.layout.screenStateRoot, computerId(6), "config");
		await mkdir(config);
		await writeFile(join(config, "persistent.xml"), "preserved setting");
		const next = await prepareCompanyComputerScreenWallpaper(
			{ ...fixture, templateId: "software-developer" },
			signal,
		);
		expect(next.wallpaper).toBe(first.wallpaper);
		expect(next.creature).toBe("wisp");
		expect(await readFile(next.wallpaper, "utf8")).toBe("synthetic wisp image bytes");
		expect(await readFile(join(config, "persistent.xml"), "utf8")).toBe("preserved setting");
		await prepareCompanyComputerScreenWallpaper({ ...fixture, creature: "bloom" }, signal);
		expect(await readFile(next.wallpaper, "utf8")).toBe("synthetic bloom image bytes");
		expect((await readdir(join(fixture.layout.screenStateRoot, computerId(6)))).sort()).toEqual([
			"config",
			"wallpaper.png",
		]);
	});

	it("keeps the previous wallpaper and removes staging bytes when authority changes before publication", async () => {
		const fixture = await desktopFixture();
		const signal = new AbortController().signal;
		const { wallpaper } = await prepareCompanyComputerScreenWallpaper(fixture, signal);
		fixture.boundary.assertReady = vi
			.fn()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("STALE_BINDING"));
		await expect(
			prepareCompanyComputerScreenWallpaper({ ...fixture, templateId: "software-developer" }, signal),
		).rejects.toThrow("STALE_BINDING");
		expect(await readFile(wallpaper, "utf8")).toBe("synthetic brain image bytes");
		expect(await readdir(join(fixture.layout.screenStateRoot, computerId(6)))).toEqual(["wallpaper.png"]);
	});

	it("requires the verified binding and respects cancellation before writing", async () => {
		const fixture = await desktopFixture();
		await expect(
			prepareCompanyComputerScreenWallpaper(
				{ ...fixture, binding: { ...fixture.binding, staffAgentId: computerId(99) } },
				new AbortController().signal,
			),
		).rejects.toThrow("SCREEN_BINDING_MISMATCH");
		await expect(prepareCompanyComputerScreenWallpaper(fixture, AbortSignal.abort())).rejects.toThrow();
		expect(await readdir(fixture.layout.screenStateRoot)).toEqual([]);
	});

	it.each(["image", "screen"])("rejects a %s symlink without modifying its target", async (alias) => {
		const fixture = await desktopFixture();
		const outside = join(fixture.root, "outside");
		if (alias === "image") {
			const source = join(fixture.imageRoot, "qorpera-screen-brain.png");
			await writeFile(outside, "outside bytes");
			await rm(source);
			await symlink(outside, source);
		} else {
			await mkdir(outside);
			await writeFile(join(outside, "wallpaper.png"), "outside bytes");
			await symlink(outside, join(fixture.layout.screenStateRoot, computerId(6)));
		}
		await expect(prepareCompanyComputerScreenWallpaper(fixture, new AbortController().signal)).rejects.toThrow(
			alias === "image" ? "INVALID_SCREEN_WALLPAPER" : "UNSAFE_DESKTOP_STATE_DIRECTORY",
		);
		expect(await readFile(alias === "image" ? outside : join(outside, "wallpaper.png"), "utf8")).toBe(
			"outside bytes",
		);
	});
});

async function xfceFixture() {
	const root = await mkdtemp(join(await realpath(tmpdir()), "qorpera-xfce-"));
	roots.push(root);
	const bin = join(root, "bin");
	const config = join(root, "screen with spaces", "config");
	const wallpaper = join(root, "screen with spaces", "wallpaper.png");
	const log = join(root, "calls");
	await mkdir(bin);
	await mkdir(config, { recursive: true });
	await writeFile(wallpaper, "synthetic wallpaper");
	await writeFile(log, "");
	// All desktop commands are local test doubles. This never starts X11/XFCE.
	await writeFile(join(bin, "xrandr"), '#!/bin/sh\nprintf "%s connected 1920x1200\\n" "$TEST_MONITOR"\n', {
		mode: 0o700,
	});
	await writeFile(
		join(bin, "xfconf-query"),
		`#!/bin/sh
if [ "$#" -eq 4 ]; then exit "$TEST_QUERY_STATUS"; fi
if [ "$TEST_SET_STATUS" != 0 ]; then exit "$TEST_SET_STATUS"; fi
for arg do printf '%s\\t' "$arg" >> "$TEST_LOG"; done
printf '\\n' >> "$TEST_LOG"
`,
		{ mode: 0o700 },
	);
	await writeFile(join(bin, "xfce4-session"), '#!/bin/sh\nprintf "SESSION\\n" >> "$TEST_LOG"\n', { mode: 0o700 });
	const env = {
		PATH: `${bin}:/usr/bin:/bin`,
		DISPLAY: ":1",
		XDG_CONFIG_HOME: config,
		TEST_LOG: log,
		TEST_MONITOR: "Virtual-1",
		TEST_QUERY_STATUS: "1",
		TEST_SET_STATUS: "0",
	};
	return { root, wallpaper, log, env };
}

describe("restored XFCE startup settings (real Bash helper, fake X11/XFCE commands)", () => {
	it.each(["0", "1"])(
		"applies existing or new settings before the desktop starts: query status %s",
		async (queryStatus) => {
			const fixture = await xfceFixture();
			await execute("/bin/bash", [xfceHelper, fixture.wallpaper], {
				env: { ...fixture.env, TEST_QUERY_STATUS: queryStatus },
				timeout: 3000,
			});
			const calls = (await readFile(fixture.log, "utf8")).trimEnd().split("\n");
			const properties = [
				["xfce4-desktop", "/backdrop/screen0/monitorVirtual-1/workspace0/last-image", "string", fixture.wallpaper],
				["xfce4-desktop", "/backdrop/screen0/monitorVirtual-1/workspace0/image-style", "int", "5"],
				["xfce4-desktop", "/desktop-icons/style", "int", "0"],
				["xfce4-desktop", "/desktop-menu/show", "bool", "true"],
				["xfwm4", "/general/show_dock_shadow", "bool", "false"],
			];
			expect(calls.pop()).toBe("SESSION");
			expect(calls.map((call) => call.trimEnd().split("\t"))).toEqual(
				properties.map(([channel, path, type, value]) => [
					"-c",
					channel,
					"-p",
					path,
					...(queryStatus === "1" ? ["-n", "-t", type] : []),
					"-s",
					value,
				]),
			);
		},
	);

	it.each(["missing monitor", "invalid monitor", "failed property"])(
		"does not start XFCE after %s",
		async (failure) => {
			const fixture = await xfceFixture();
			const env = {
				...fixture.env,
				...(failure === "failed property"
					? { TEST_SET_STATUS: "1" }
					: { TEST_MONITOR: failure === "missing monitor" ? "" : "Virtual-1;command" }),
			};
			await expect(
				execute("/bin/bash", [xfceHelper, fixture.wallpaper], { env, timeout: 3000 }),
			).rejects.toMatchObject({ code: 1 });
			expect(await readFile(fixture.log, "utf8")).not.toContain("SESSION");
		},
	);

	it("refuses a wallpaper from a different screen state directory", async () => {
		const fixture = await xfceFixture();
		const other = join(fixture.root, "other.png");
		await writeFile(other, "synthetic other image");
		await expect(
			execute("/bin/bash", [xfceHelper, other], { env: fixture.env, timeout: 3000 }),
		).rejects.toMatchObject({ code: 65 });
		expect(await readFile(fixture.log, "utf8")).toBe("");
	});

	it("wires the helper inside the clean per-screen D-Bus environment without the obsolete launchers", async () => {
		const wrapper = await readFile(
			new URL("../../../deploy/lxd-company-computer-guest/qorpera-screen-session", import.meta.url),
			"utf8",
		);
		expect(wrapper).toContain("wallpaper=${QORPERA_SCREEN_WALLPAPER:?");
		expect(wrapper).toContain(`\${wallpaper} != "\${screen_state}/wallpaper.png"`);
		expect(wrapper).toContain(`XDG_CONFIG_HOME="\${screen_state}/config"`);
		expect(wrapper).toContain(`/usr/bin/dbus-run-session -- /usr/local/bin/qorpera-screen-xfce "\${wallpaper}"`);
		expect(wrapper).not.toMatch(/QORPERA_LIVE_COMPANY_ROOT|dataset\/live|qorpera-chrome/);
	});
});
