import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assertCompanyComputerScreenBinding } from "@qorpera/cloud-client/cloud-company-computer-contract";
import { STAFF_CHARACTER_BY_TEMPLATE, STAFF_CHARACTER_IDS } from "@qorpera/cloud-client/staff-characters";
import {
	COMPANY_COMPUTER_SCREEN_HOURS,
	companyComputerScreenCreature,
	isCompanyComputerScreenTimeZone,
	prepareCompanyComputerScreenWallpaper,
} from "@qorpera/runtime/cloud-company-computer-desktop";
import type { CompanyComputerGuestBoundary } from "@qorpera/runtime/cloud-company-computer-guest";
import { afterEach, describe, expect, it, vi } from "vitest";
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

	it("stages the hourly tone-on-tone set and the company zone beside the wallpaper, and clears both when withdrawn", async () => {
		const fixture = await desktopFixture();
		const signal = new AbortController().signal;
		for (const hour of COMPANY_COMPUTER_SCREEN_HOURS)
			await writeFile(join(fixture.imageRoot, `qorpera-screen-brain-${hour}.png`), `synthetic brain ${hour}`);
		const screen = join(fixture.layout.screenStateRoot, computerId(6));
		const staged = await prepareCompanyComputerScreenWallpaper({ ...fixture, timeZone: "Europe/Copenhagen" }, signal);
		expect(staged).toEqual({
			wallpaper: join(screen, "wallpaper.png"),
			creature: "brain",
			backdrops: join(screen, "backdrops"),
		});
		expect((await readdir(screen)).sort()).toEqual(["backdrops", "time-zone", "wallpaper.png"]);
		expect(await readFile(join(screen, "time-zone"), "utf8")).toBe("Europe/Copenhagen\n");
		expect((await stat(join(screen, "backdrops"))).mode & 0o777).toBe(0o700);
		expect((await readdir(join(screen, "backdrops"))).sort()).toEqual(
			COMPANY_COMPUTER_SCREEN_HOURS.map((hour) => `${hour}.png`),
		);
		expect(await readFile(join(screen, "backdrops", "19.png"), "utf8")).toBe("synthetic brain 19");
		expect((await stat(join(screen, "backdrops", "19.png"))).mode & 0o777).toBe(0o600);
		// A partial hourly set (an older or damaged image) falls back to the static wallpaper.
		await rm(join(fixture.imageRoot, "qorpera-screen-brain-07.png"));
		const withdrawn = await prepareCompanyComputerScreenWallpaper(fixture, signal);
		expect(withdrawn).toEqual({ wallpaper: join(screen, "wallpaper.png"), creature: "brain" });
		expect((await readdir(screen)).sort()).toEqual(["wallpaper.png"]);
		for (const zone of ["Europe/Copenhagen; rm -rf /", "../../etc", "", "x".repeat(65)])
			await expect(prepareCompanyComputerScreenWallpaper({ ...fixture, timeZone: zone }, signal)).rejects.toThrow(
				"INVALID_SCREEN_TIME_ZONE",
			);
		expect(isCompanyComputerScreenTimeZone("America/Argentina/Buenos_Aires")).toBe(true);
		expect(isCompanyComputerScreenTimeZone("Etc/GMT+1")).toBe(true);
		expect(isCompanyComputerScreenTimeZone("A/B/C/D")).toBe(false);
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
	const backdrops = join(root, "screen with spaces", "backdrops");
	await mkdir(backdrops);
	for (const hour of COMPANY_COMPUTER_SCREEN_HOURS) await writeFile(join(backdrops, `${hour}.png`), `frame ${hour}`);
	const env = {
		PATH: `${bin}:/usr/bin:/bin`,
		DISPLAY: ":1",
		XDG_CONFIG_HOME: config,
		TZ: "Etc/GMT-9",
		TEST_LOG: log,
		TEST_MONITOR: "Virtual-1",
		TEST_QUERY_STATUS: "1",
		TEST_SET_STATUS: "0",
	};
	return { root, wallpaper, backdrops, log, env };
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
				["xfce4-desktop", "/backdrop/screen0/monitorVirtual-1/workspace0/backdrop-cycle-enable", "bool", "false"],
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

	it("cycles the hourly set chronologically on the company's local clock when the wrapper supplies it", async () => {
		const fixture = await xfceFixture();
		const env = { ...fixture.env, QORPERA_SCREEN_BACKDROPS: fixture.backdrops };
		await execute("/bin/bash", [xfceHelper, fixture.wallpaper], { env, timeout: 3000 });
		const calls = (await readFile(fixture.log, "utf8")).trimEnd().split("\n");
		expect(calls.pop()).toBe("SESSION");
		const hour = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: "Etc/GMT-9" })
			.format(new Date())
			.padStart(2, "0");
		const backdrop = "/backdrop/screen0/monitorVirtual-1/workspace0";
		expect(
			calls
				.slice(0, 4)
				.map((call) => call.trimEnd().split("\t").slice(3, 4).concat(call.trimEnd().split("\t").slice(-1))),
		).toEqual([
			[`${backdrop}/last-image`, join(fixture.backdrops, `${hour}.png`)],
			[`${backdrop}/backdrop-cycle-enable`, "true"],
			[`${backdrop}/backdrop-cycle-period`, "6"],
			[`${backdrop}/backdrop-cycle-random-order`, "false"],
		]);
		// A set elsewhere, or one missing a frame, never reaches the desktop.
		await rm(join(fixture.backdrops, "23.png"));
		await expect(execute("/bin/bash", [xfceHelper, fixture.wallpaper], { env, timeout: 3000 })).rejects.toMatchObject(
			{
				code: 65,
			},
		);
		await expect(
			execute("/bin/bash", [xfceHelper, fixture.wallpaper], {
				env: { ...env, QORPERA_SCREEN_BACKDROPS: join(fixture.root, "elsewhere") },
				timeout: 3000,
			}),
		).rejects.toMatchObject({ code: 65 });
	});

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
		// The desktop follows the company's local day and carries only the office dock.
		expect(wrapper).toContain(`TZ="\${time_zone}" QORPERA_SCREEN_BACKDROPS="\${backdrops}"`);
		expect(wrapper).toContain(`! -f /usr/share/zoneinfo/\${time_zone}`);
		for (const launcher of ["qorpera-terminal.desktop", "qorpera-files.desktop", "qorpera-browser.desktop"])
			expect(wrapper).toContain(launcher);
		expect(wrapper).toContain("Exec=/usr/local/bin/qorpera-screen-browser");
		expect(wrapper).not.toMatch(/Exec=.*qorpera-chromium|xfce4-web-browser|xfce4-appfinder|applicationsmenu/);
		const browser = await readFile(
			new URL("../../../deploy/lxd-company-computer-guest/qorpera-screen-browser", import.meta.url),
			"utf8",
		);
		expect(browser).toContain("xdotool windowactivate");
		expect(browser).not.toMatch(/qorpera-chromium|bwrap|playwright/);
	});

	it("writes the dock, launchers and terminal shell into the screen state before the desktop starts", async () => {
		const fixture = await xfceFixture();
		const wrapper = new URL("../../../deploy/lxd-company-computer-guest/qorpera-screen-session", import.meta.url);
		// Extract only the file-writing block; the remaining wrapper needs a real X server.
		const text = await readFile(wrapper, "utf8");
		const start = text.indexOf("panel_config=");
		const end = text.indexOf(`cd "\${workbench_root}"`);
		// The guest image resolves aliases with GNU realpath; the local double must not.
		const block = text
			.slice(start, end)
			.replaceAll(`$(/usr/bin/realpath -e -- "\${directory}")`, `$(cd "\${directory}" && pwd -P)`);
		expect(start).toBeGreaterThan(0);
		expect(end).toBeGreaterThan(start);
		expect(block).not.toContain("/usr/bin/realpath");
		const screenState = join(fixture.root, "screen with spaces");
		const workbench = join(fixture.root, "workbench dir");
		await mkdir(workbench);
		await execute(
			"/bin/bash",
			[
				"-c",
				`set -euo pipefail; umask 0077; screen_state=${JSON.stringify(screenState)}; workbench_root=${JSON.stringify(workbench)}\n${block}`,
			],
			{ timeout: 3000 },
		);
		const config = join(screenState, "config", "xfce4");
		const panel = await readFile(join(config, "xfconf", "xfce-perchannel-xml", "xfce4-panel.xml"), "utf8");
		expect(panel).toContain('<channel name="xfce4-panel" version="1.0">');
		expect(panel.match(/value="launcher"/g)).toHaveLength(3);
		expect(panel).not.toMatch(/applicationsmenu|xfce4-web-browser|xfce4-appfinder|directorymenu/);
		expect(await readFile(join(config, "panel", "launcher-4", "qorpera-terminal.desktop"), "utf8")).toContain(
			`Path=${workbench}`,
		);
		expect(await readFile(join(config, "panel", "launcher-5", "qorpera-files.desktop"), "utf8")).toContain(
			"Exec=thunar .",
		);
		expect(await readFile(join(config, "panel", "launcher-6", "qorpera-browser.desktop"), "utf8")).toContain(
			"Exec=/usr/local/bin/qorpera-screen-browser",
		);
		expect(await readFile(join(config, "terminal", "terminalrc"), "utf8")).toContain("CustomCommand=/usr/bin/bash");
		expect((await stat(join(config, "terminal", "terminalrc"))).mode & 0o777).toBe(0o600);
	});
});
