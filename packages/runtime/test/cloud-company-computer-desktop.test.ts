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
	companyComputerScreenCharacter,
	companyComputerScreenCreature,
	isCompanyComputerScreenTimeZone,
	prepareCompanyComputerScreenWallpaper,
} from "@qorpera/runtime/cloud-company-computer-desktop";
import type { CompanyComputerGuestBoundary } from "@qorpera/runtime/cloud-company-computer-guest";
import {
	COMPANY_COMPUTER_WALLPAPER_BY_CHARACTER,
	COMPANY_COMPUTER_WALLPAPER_FILES,
	COMPANY_COMPUTER_WALLPAPER_IDS,
} from "@qorpera/runtime/cloud-company-computer-wallpapers";
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
	for (const creature of COMPANY_COMPUTER_WALLPAPER_IDS)
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
			expect(companyComputerScreenCreature(computerBinding(), template)).toBe(
				COMPANY_COMPUTER_WALLPAPER_BY_CHARACTER[character],
			);
		const binding = computerBinding();
		let seed = 0;
		for (const character of binding.staffAgentId) seed = (seed * 31 + character.charCodeAt(0)) >>> 0;
		for (const template of [undefined, "unknown-template", "__proto__", "../../outside"])
			expect(companyComputerScreenCreature(binding, template)).toBe(
				COMPANY_COMPUTER_WALLPAPER_BY_CHARACTER[STAFF_CHARACTER_IDS[seed % STAFF_CHARACTER_IDS.length]],
			);
		// The same walk the clients use (`figureFor`), so an agent nobody has
		// dressed yet shows the same figure on its desktop as in its avatar.
		expect(companyComputerScreenCharacter(binding)).toBe(STAFF_CHARACTER_IDS[seed % STAFF_CHARACTER_IDS.length]);
		expect(companyComputerScreenCharacter(binding, "co-founder")).toBe("crown");
		expect(companyComputerScreenCreature(binding, "agent-manager", "flame")).toBe("ribbon");
		expect(companyComputerScreenCreature(binding, "agent-manager", "../../outside")).toBe("halo");
		expect(() => companyComputerScreenCreature({ ...binding, screenOrdinal: 33 })).toThrow("SCREEN_BINDING_MISMATCH");
	});

	it("maps every avatar to the installed file that actually draws it", async () => {
		// The file names are historical; the figure inside each template is the
		// traced path of a current avatar. Pin the table to the art itself.
		const baked = await readFile(
			fileURLToPath(new URL("../../web/public/assets/avatars/vector-baked.js", import.meta.url)),
			"utf8",
		);
		const figures = (
			JSON.parse(baked.slice(baked.indexOf("Object.freeze(") + 14, baked.lastIndexOf(")"))) as {
				figures: Record<string, { d: string }>;
			}
		).figures;
		expect(Object.keys(figures).sort()).toEqual([...STAFF_CHARACTER_IDS].sort());
		const drawn = new Set<string>();
		for (const character of STAFF_CHARACTER_IDS) {
			const asset = COMPANY_COMPUTER_WALLPAPER_BY_CHARACTER[character];
			const template = await readFile(
				fileURLToPath(
					new URL(`../../../deploy/lxd-company-computer-guest/backdrops-source/${asset}.html`, import.meta.url),
				),
				"utf8",
			);
			expect(template.match(/<path d="([^"]+)"/)?.[1], `${character} is drawn by ${asset}`).toBe(
				figures[character].d,
			);
			drawn.add(asset);
		}
		expect([...drawn].sort()).toEqual([...COMPANY_COMPUTER_WALLPAPER_IDS].sort());
	});

	it("prepares every current avatar from the actual packaged guest artwork", async () => {
		const fixture = await desktopFixture();
		const imageRoot = fileURLToPath(new URL("../../../deploy/lxd-company-computer-guest/backdrops", import.meta.url));
		expect((await readdir(imageRoot)).sort()).toEqual(COMPANY_COMPUTER_WALLPAPER_FILES);
		for (const character of STAFF_CHARACTER_IDS) {
			const prepared = await prepareCompanyComputerScreenWallpaper(
				{ ...fixture, imageRoot, creature: character },
				new AbortController().signal,
			);
			expect(await readFile(prepared.wallpaper)).toEqual(
				await readFile(join(imageRoot, `qorpera-screen-${COMPANY_COMPUTER_WALLPAPER_BY_CHARACTER[character]}.png`)),
			);
			expect(prepared.backdrops).toBeDefined();
			expect(await readdir(prepared.backdrops!)).toHaveLength(24);
		}
	});

	it("publishes the exact image bytes under the bound UUID and refreshes appearance without deleting desktop settings", async () => {
		const fixture = await desktopFixture();
		const signal = new AbortController().signal;
		const first = await prepareCompanyComputerScreenWallpaper(fixture, signal);
		expect(first).toEqual({
			wallpaper: join(fixture.layout.screenStateRoot, computerId(6), "wallpaper.png"),
			creature: "halo",
		});
		expect(await readFile(first.wallpaper, "utf8")).toBe("synthetic halo image bytes");
		expect((await stat(first.wallpaper)).mode & 0o777).toBe(0o600);
		const config = join(fixture.layout.screenStateRoot, computerId(6), "config");
		await mkdir(config);
		await writeFile(join(config, "persistent.xml"), "preserved setting");
		const next = await prepareCompanyComputerScreenWallpaper(
			{ ...fixture, templateId: "software-developer" },
			signal,
		);
		expect(next.wallpaper).toBe(first.wallpaper);
		expect(next.creature).toBe("pebble");
		expect(await readFile(next.wallpaper, "utf8")).toBe("synthetic pebble image bytes");
		expect(await readFile(join(config, "persistent.xml"), "utf8")).toBe("preserved setting");
		await prepareCompanyComputerScreenWallpaper({ ...fixture, creature: "flame" }, signal);
		expect(await readFile(next.wallpaper, "utf8")).toBe("synthetic ribbon image bytes");
		expect((await readdir(join(fixture.layout.screenStateRoot, computerId(6)))).sort()).toEqual([
			"config",
			"wallpaper.png",
		]);
	});

	it("stages the hourly tone-on-tone set and the company zone beside the wallpaper, and clears both when withdrawn", async () => {
		const fixture = await desktopFixture();
		const signal = new AbortController().signal;
		for (const hour of COMPANY_COMPUTER_SCREEN_HOURS)
			await writeFile(join(fixture.imageRoot, `qorpera-screen-halo-${hour}.png`), `synthetic halo ${hour}`);
		const screen = join(fixture.layout.screenStateRoot, computerId(6));
		const staged = await prepareCompanyComputerScreenWallpaper({ ...fixture, timeZone: "Europe/Copenhagen" }, signal);
		expect(staged).toEqual({
			wallpaper: join(screen, "wallpaper.png"),
			creature: "halo",
			backdrops: join(screen, "backdrops"),
		});
		expect((await readdir(screen)).sort()).toEqual(["backdrops", "time-zone", "wallpaper.png"]);
		expect(await readFile(join(screen, "time-zone"), "utf8")).toBe("Europe/Copenhagen\n");
		expect((await stat(join(screen, "backdrops"))).mode & 0o777).toBe(0o700);
		expect((await readdir(join(screen, "backdrops"))).sort()).toEqual(
			COMPANY_COMPUTER_SCREEN_HOURS.map((hour) => `${hour}.png`),
		);
		expect(await readFile(join(screen, "backdrops", "19.png"), "utf8")).toBe("synthetic halo 19");
		expect((await stat(join(screen, "backdrops", "19.png"))).mode & 0o777).toBe(0o600);
		// A partial hourly set (an older or damaged image) falls back to the static wallpaper.
		await rm(join(fixture.imageRoot, "qorpera-screen-halo-07.png"));
		const withdrawn = await prepareCompanyComputerScreenWallpaper(fixture, signal);
		expect(withdrawn).toEqual({ wallpaper: join(screen, "wallpaper.png"), creature: "halo" });
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
		expect(await readFile(wallpaper, "utf8")).toBe("synthetic halo image bytes");
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
			const source = join(fixture.imageRoot, "qorpera-screen-halo.png");
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

/** The dock helper with doubles for the X tools: `windows` is the window manager's client list. */
async function dockFixture() {
	const root = await mkdtemp(join(await realpath(tmpdir()), "qorpera-dock-"));
	roots.push(root);
	const bin = join(root, "bin");
	const runtime = join(root, "run");
	const config = join(root, "config");
	const entry = join(config, "xfce4", "panel", "launcher-6", "qorpera-browser.desktop");
	await mkdir(bin);
	await mkdir(runtime);
	await mkdir(join(config, "xfce4", "panel", "launcher-6"), { recursive: true });
	await mkdir(join(config, "qorpera-dock"));
	for (const state of ["idle", "launching", "running", "failed"])
		await writeFile(join(config, "qorpera-dock", `browser.${state}.desktop`), `Icon=browser-${state}\n`);
	await writeFile(entry, "Icon=browser-idle\n");
	const script = (
		await readFile(
			new URL("../../../deploy/lxd-company-computer-guest/qorpera-screen-browser", import.meta.url),
			"utf8",
		)
	).replace("runtime_root=/run/qorpera", `runtime_root=${JSON.stringify(runtime)}`);
	expect(script).toContain(runtime);
	const launcher = join(root, "qorpera-screen-browser");
	await writeFile(launcher, script, { mode: 0o755 });
	const double = async (name: string, body: string) =>
		writeFile(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
	const q = (name: string) => JSON.stringify(join(root, name));
	await double("xdotool", `echo "$*" >> ${q("xdotool.log")}`);
	// xprop answers from two files: the client list line and one class per window id.
	await double(
		"xprop",
		`if [[ $1 == -root ]]; then cat ${q("clients")} 2>/dev/null; exit 0; fi
if [[ $1 == -id && -e ${q("classes")}/$2 ]]; then cat ${q("classes")}/$2; exit 0; fi
exit 1`,
	);
	for (const tool of ["thunar", "xfce4-terminal"])
		await double(tool, `echo "${tool} $*" | sed 's/ $//' >> ${q("started")}`);
	// Any dialog tool would be a defect: these doubles only leave evidence.
	for (const dialog of ["xmessage", "zenity", "notify-send"]) await double(dialog, `: > ${q("dialog")}`);
	// Stands in for the office service: the second wait "opens" the browser if asked.
	// It also records the dock entry at each wait, and eats every request it sees.
	await double(
		"sleep",
		`count=$(cat ${q("sleeps")} 2>/dev/null || echo 0); echo $((count + 1)) > ${q("sleeps")}
cat ${JSON.stringify(entry)} >> ${q("entries")}
if [[ -e ${JSON.stringify(join(runtime, "browser-request"))} ]]; then
	if [[ -e ${q("service")} && $count -ge 1 ]]; then
		echo '_NET_CLIENT_LIST(WINDOW): window id # 0x400009' > ${q("clients")}
		mkdir -p ${q("classes")}; echo 'WM_CLASS(STRING) = "chromium", "Chromium"' > ${q("classes")}/0x400009
	fi
	if [[ -e ${q("refusing")} ]]; then rm -f ${JSON.stringify(join(runtime, "browser-request"))}; echo asked >> ${q("asked")}; fi
fi`,
	);
	const env = { PATH: `${bin}:/usr/bin:/bin`, DISPLAY: ":1", XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime };
	return {
		root,
		bin,
		runtime,
		config,
		entry,
		launcher,
		env,
		run: (...args: string[]) => execute("/bin/bash", [launcher, ...args], { timeout: 10000, env, cwd: root }),
		/** Replace the client list, oldest first. */
		windows: async (list: Record<string, string>) => {
			await rm(join(root, "classes"), { recursive: true, force: true });
			await mkdir(join(root, "classes"));
			const ids = Object.keys(list);
			await writeFile(
				join(root, "clients"),
				ids.length
					? `_NET_CLIENT_LIST(WINDOW): window id # ${ids.join(", ")}\n`
					: "_NET_CLIENT_LIST(WINDOW): window id # \n",
			);
			for (const [id, name] of Object.entries(list))
				await writeFile(join(root, "classes", id), `WM_CLASS(STRING) = "${name.toLowerCase()}", "${name}"\n`);
		},
		/** The xdotool calls since the last look. */
		xdotool: async () => {
			const log = await readFile(join(root, "xdotool.log"), "utf8").catch(() => "");
			await rm(join(root, "xdotool.log"), { force: true });
			return log.trim().split("\n").filter(Boolean);
		},
	};
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
				// Seen only through VNC: nothing composited, shadowed, previewed or animated.
				["xfwm4", "/general/use_compositing", "bool", "false"],
				["xfwm4", "/general/show_frame_shadow", "bool", "false"],
				["xfwm4", "/general/show_popup_shadow", "bool", "false"],
				["xfwm4", "/general/cycle_preview", "bool", "false"],
				["xfwm4", "/general/zoom_desktop", "bool", "false"],
				["xfwm4", "/general/box_resize", "bool", "true"],
				["xfwm4", "/general/workspace_count", "int", "1"],
				["xfwm4", "/general/scroll_workspaces", "bool", "false"],
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
		expect(wrapper).toContain("/usr/local/bin/qorpera-screen-browser");
		expect(wrapper).not.toMatch(/Exec=.*qorpera-chromium|xfce4-web-browser|xfce4-appfinder|applicationsmenu/);
		// No dialog can ever cover a screen somebody is looking at, and no window list.
		expect(wrapper).not.toMatch(/xmessage|zenity|tasklist/);
		// The X server never blanks, never listens and takes no viewer-side overrides.
		expect(wrapper).toContain("-noreset -s 0 ");
		expect(wrapper).toContain("-SecurityTypes None");
		expect(wrapper).toContain("-AllowOverride ''");
		const browser = await readFile(
			new URL("../../../deploy/lxd-company-computer-guest/qorpera-screen-browser", import.meta.url),
			"utf8",
		);
		expect(browser).toContain("xdotool windowactivate");
		expect(browser).not.toMatch(/qorpera-chromium|bwrap|playwright/);
		// The launcher starts nothing itself and says nothing about private sign-in,
		// which no member client can reach any more.
		expect(browser).not.toMatch(/chromium-browser|google-chrome|signs in|privately/i);
		expect(browser).toContain("runtime_root=/run/qorpera");
		expect(browser).not.toMatch(/xmessage|zenity|notify-send/);
		const helper = await readFile(xfceHelper, "utf8");
		expect(helper).not.toMatch(/xmessage|zenity|qorpera-chromium|bwrap/);
		expect(helper).toContain("xprop -root -spy _NET_CLIENT_LIST");
	});

	it("asks the office service for the browser through one empty file, waits, asks once more and never opens a dialog", async () => {
		const f = await dockFixture();
		await expect(execute("/bin/bash", [f.launcher], { env: { PATH: f.env.PATH } })).rejects.toThrow();
		await expect(f.run("browser", "extra")).rejects.toMatchObject({ code: 64 });
		await expect(f.run("elsewhere")).rejects.toMatchObject({ code: 64 });

		// 1. A browser window is already on the screen: raise it, ask for nothing.
		await f.windows({ "0x400007": "Chromium" });
		await f.run();
		expect(await f.xdotool()).toEqual(["windowmap 0x400007", "windowactivate 0x400007"]);
		expect(await readdir(f.runtime)).toEqual([]);

		// 2. No window: the icon answers at once, one empty request goes out, and the
		// window the service opened is raised.
		await f.windows({});
		await writeFile(join(f.root, "service"), "");
		await f.run();
		expect((await readdir(f.runtime)).filter((name) => !name.endsWith(".lock"))).toEqual(["browser-request"]);
		expect((await stat(join(f.runtime, "browser-request"))).size).toBe(0);
		expect(await f.xdotool()).toEqual(["windowmap 0x400009", "windowactivate 0x400009"]);
		const opening = (await readFile(join(f.root, "entries"), "utf8")).trim().split("\n");
		expect(new Set(opening)).toEqual(new Set(["Icon=browser-launching"]));
		expect(await readFile(f.entry, "utf8")).toBe("Icon=browser-running\n");

		// 3. The service refuses or fails: a second request after the first wait, then
		// only the quiet dock icon for a moment, and the idle icon again. Never a dialog.
		await f.windows({});
		await rm(join(f.root, "service"));
		await rm(join(f.root, "sleeps"));
		await rm(join(f.runtime, "browser-request"));
		await writeFile(join(f.root, "refusing"), "");
		await writeFile(join(f.root, "entries"), "");
		await expect(f.run()).rejects.toMatchObject({ code: 1 });
		expect((await readFile(join(f.root, "asked"), "utf8")).trim().split("\n")).toHaveLength(2);
		expect((await readFile(join(f.root, "sleeps"), "utf8")).trim()).toBe("81");
		const entries = (await readFile(join(f.root, "entries"), "utf8")).trim().split("\n");
		expect(entries.slice(0, 80).every((line) => line === "Icon=browser-launching")).toBe(true);
		expect(entries[80]).toBe("Icon=browser-failed");
		expect(await readFile(f.entry, "utf8")).toBe("Icon=browser-idle\n");
		expect(await readdir(f.root)).not.toContain("dialog");
		// Nothing is left behind: no marker for the watcher, no private write directory.
		expect(await readdir(f.runtime)).toEqual([]);
		expect((await readdir(f.config)).filter((name) => name.startsWith(".qorpera"))).toEqual([]);
	});

	it("brings back a minimised window from the dock instead of starting another, for all three icons", async () => {
		const f = await dockFixture();
		// Only the window manager's client list knows a minimised window. The newest
		// window of the application is restored (mapped) and activated.
		await f.windows({
			"0x400001": "Thunar",
			"0x400003": "Xfce4-terminal",
			"0x400005": "Thunar",
			"0x400007": "Chromium",
		});
		await f.run("files");
		expect(await f.xdotool()).toEqual(["windowmap 0x400005", "windowactivate 0x400005"]);
		await f.run("terminal");
		expect(await f.xdotool()).toEqual(["windowmap 0x400003", "windowactivate 0x400003"]);
		await f.run();
		expect(await f.xdotool()).toEqual(["windowmap 0x400007", "windowactivate 0x400007"]);
		expect(await readdir(f.root)).not.toContain("started");
		// The launcher never relies on a visibility search again.
		expect(await readFile(f.launcher, "utf8")).not.toMatch(/--onlyvisible|xdotool search/);
		// With no window the tool itself starts, in the launcher's working directory.
		await f.windows({ "0x400007": "Chromium" });
		await f.run("files");
		await f.run("terminal");
		expect((await readFile(join(f.root, "started"), "utf8")).trim().split("\n")).toEqual([
			"thunar .",
			"xfce4-terminal",
		]);
	});

	it("answers a second click at once while the first launcher is still waiting for the service", async () => {
		const f = await dockFixture();
		await f.windows({});
		// The first launcher holds the lock (this double refuses it to the second click).
		await writeFile(join(f.bin, "flock"), "#!/bin/bash\nexit 1\n", { mode: 0o755 });
		await f.run();
		expect(await readFile(f.entry, "utf8")).toBe("Icon=browser-launching\n");
		expect(await readdir(f.runtime)).toEqual(["qorpera-screen-browser.lock"]);
		expect(await readdir(f.root)).not.toContain("sleeps");
	});

	it("shows a running dot while an application has a window, minimised included, in one pass per burst of events", async () => {
		const fixture = await xfceFixture();
		const config = fixture.env.XDG_CONFIG_HOME;
		const runtime = join(fixture.root, "run");
		await mkdir(runtime);
		const dock = join(config, "qorpera-dock");
		await mkdir(dock);
		const entries = {
			browser: join(config, "xfce4", "panel", "launcher-6", "qorpera-browser.desktop"),
			files: join(config, "xfce4", "panel", "launcher-5", "qorpera-files.desktop"),
			terminal: join(config, "xfce4", "panel", "launcher-4", "qorpera-terminal.desktop"),
		};
		for (const [app, entry] of Object.entries(entries)) {
			await mkdir(join(entry, ".."), { recursive: true });
			for (const state of ["idle", "running"])
				await writeFile(join(dock, `${app}.${state}.desktop`), `${app} ${state}\n`);
			await writeFile(entry, `${app} idle\n`);
		}
		const bin = join(fixture.root, "bin");
		const passes = join(fixture.root, "passes");
		// The window manager announces a burst of five changes, then the X server ends.
		// The client list is the only source: no visibility search can miss a minimised window.
		await writeFile(
			join(bin, "xprop"),
			`#!/bin/sh
if [ "$2" = "-spy" ]; then for i in 1 2 3 4 5; do echo "_NET_CLIENT_LIST(WINDOW): window id # 0x400007"; done; exit 0; fi
if [ "$1" = "-root" ]; then echo pass >> ${JSON.stringify(passes)}; echo "_NET_CLIENT_LIST(WINDOW): window id # 0x400007, 0xbad;id"; exit 0; fi
if [ "$2" = "0x400007" ]; then echo "WM_CLASS(STRING) = \\"x\\", \\"$TEST_OPEN\\""; exit 0; fi
exit 1
`,
			{ mode: 0o700 },
		);
		await writeFile(join(bin, "xdotool"), `#!/bin/sh\n: > ${JSON.stringify(join(fixture.root, "searched"))}\n`, {
			mode: 0o700,
		});
		const read = async () =>
			Object.fromEntries(
				await Promise.all(
					Object.entries(entries).map(async ([app, entry]) => [app, (await readFile(entry, "utf8")).trim()]),
				),
			);
		const env = { ...fixture.env, XDG_RUNTIME_DIR: runtime };
		// A stale marker of a killed launcher is cleared when the desktop starts.
		await writeFile(join(runtime, "qorpera-screen-browser.launching"), "");
		await execute("/bin/bash", [xfceHelper, fixture.wallpaper], {
			env: { ...env, TEST_OPEN: "Thunar" },
			timeout: 3000,
		});
		await vi.waitFor(
			async () =>
				expect(await read()).toEqual({
					browser: "browser idle",
					files: "files running",
					terminal: "terminal idle",
				}),
			{ timeout: 3000 },
		);
		expect(await readdir(runtime)).toEqual([]);
		const bash = Number((await execute("/bin/bash", ["-c", "echo $BASH_VERSINFO"])).stdout.trim());
		await vi.waitFor(
			async () =>
				expect((await readFile(passes, "utf8")).trim().split("\n")).toHaveLength(
					// `read -t 0` only sees waiting input from Bash 4 (the image has 5); older shells pass per event.
					bash >= 4 ? 1 : 5,
				),
			{ timeout: 5000 },
		);
		await execute("/bin/bash", [xfceHelper, fixture.wallpaper], {
			env: { ...env, TEST_OPEN: "Chromium" },
			timeout: 3000,
		});
		await vi.waitFor(
			async () =>
				expect(await read()).toEqual({
					browser: "browser running",
					files: "files idle",
					terminal: "terminal idle",
				}),
			{ timeout: 3000 },
		);
		// The desktop itself started both times; the watcher never holds it up.
		expect((await readFile(fixture.log, "utf8")).match(/SESSION/g)).toHaveLength(2);
		expect(await readdir(fixture.root)).not.toContain("searched");
		// Entries were swapped through a private directory that is gone again.
		await vi.waitFor(
			async () => expect((await readdir(config)).filter((name) => name.startsWith(".qorpera"))).toEqual([]),
			{ timeout: 5000 },
		);
	});

	it("starts the desktop even when every cosmetic window-manager setting is refused", async () => {
		const fixture = await xfceFixture();
		// This double refuses the xfwm4 look settings only; the backdrop ones still apply.
		await writeFile(
			join(fixture.root, "bin", "xfconf-query"),
			`#!/bin/sh
if [ "$#" -eq 4 ]; then exit 1; fi
case "$4" in /general/show_dock_shadow) ;; /general/*) exit 1;; esac
for arg do printf '%s\\t' "$arg" >> "$TEST_LOG"; done
printf '\\n' >> "$TEST_LOG"
`,
			{ mode: 0o700 },
		);
		const { stderr } = await execute("/bin/bash", [xfceHelper, fixture.wallpaper], {
			env: fixture.env,
			timeout: 3000,
		});
		const calls = (await readFile(fixture.log, "utf8")).trimEnd().split("\n");
		expect(calls.pop()).toBe("SESSION");
		expect(calls).toHaveLength(6);
		expect(stderr.match(/Skipped cosmetic desktop setting/g)).toHaveLength(8);
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
		const run = () =>
			execute(
				"/bin/bash",
				[
					"-c",
					`set -euo pipefail; umask 0077; screen_state=${JSON.stringify(screenState)}; workbench_root=${JSON.stringify(workbench)}\n${block}`,
				],
				{ timeout: 3000 },
			);
		await run();
		const config = join(screenState, "config", "xfce4");
		const panel = await readFile(join(config, "xfconf", "xfce-perchannel-xml", "xfce4-panel.xml"), "utf8");
		expect(panel).toContain('<channel name="xfce4-panel" version="1.0">');
		expect(panel.match(/value="launcher"/g)).toHaveLength(3);
		expect(panel).not.toMatch(/applicationsmenu|xfce4-web-browser|xfce4-appfinder|directorymenu|tasklist|pager/);
		// One flat, opaque dark bar along the bottom edge; no top bar, no window list.
		expect(panel.match(/<property name="panel-\d+"/g)).toHaveLength(1);
		expect(panel).toContain('value="p=10;x=0;y=0"');
		expect(panel).toContain('<property name="length" type="uint" value="100"/>');
		expect(panel).toContain('<property name="icon-size" type="uint" value="64"/>');
		expect(panel).toContain('<property name="background-style" type="uint" value="1"/>');
		// Date, gap, browser, files, terminal, gap, time: equal ends keep the icons on the centre line.
		expect([...panel.matchAll(/<value type="int" value="(\d)"\/>/g)].map((match) => match[1])).toEqual([
			"1",
			"7",
			"1",
			"6",
			"5",
			"4",
			"2",
			"3",
		]);
		const dock = join(screenState, "config", "qorpera-dock");
		// Original icons, carried by the script itself as real PNG files.
		for (const icon of [
			"browser-idle",
			"browser-launching",
			"browser-running",
			"browser-failed",
			"files-idle",
			"files-running",
			"terminal-idle",
			"terminal-running",
		]) {
			const bytes = await readFile(join(dock, `${icon}.png`));
			expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
			expect(bytes.readUInt32BE(16)).toBe(112);
			expect(bytes.readUInt32BE(20)).toBe(112);
			expect(bytes).toEqual(
				await readFile(
					new URL(`../../../deploy/lxd-company-computer-guest/design/icons/${icon}.png`, import.meta.url),
				),
			);
		}
		const terminal = await readFile(join(config, "panel", "launcher-4", "qorpera-terminal.desktop"), "utf8");
		expect(terminal).toContain(`Path=${workbench}\nIcon=${join(dock, "terminal-idle.png")}\n`);
		expect(terminal).toBe(await readFile(join(dock, "terminal.idle.desktop"), "utf8"));
		expect(await readFile(join(dock, "browser.running.desktop"), "utf8")).toContain(
			`Exec=/usr/local/bin/qorpera-screen-browser\nIcon=${join(dock, "browser-running.png")}\n`,
		);
		const css = await readFile(join(screenState, "config", "gtk-3.0", "gtk.css"), "utf8");
		expect(css).toContain(".xfce4-panel button:hover");
		expect(css).toContain("-gtk-icon-transform: translateY(-9px)");
		// Everything the look adds is scoped to the panel; no other application is restyled.
		for (const selector of css.replace(/\/\*[\s\S]*?\*\//g, "").match(/^[^\s{}][^{}]*\{/gm) ?? [])
			for (const part of selector.replace("{", "").split(",")) expect(part.trim()).toMatch(/^\.xfce4-panel\b/);
		// Files and Terminal go through the dock helper, which restores an existing window first.
		expect(await readFile(join(config, "panel", "launcher-5", "qorpera-files.desktop"), "utf8")).toContain(
			`Exec=/usr/local/bin/qorpera-screen-browser files\nPath=${workbench}\n`,
		);
		expect(terminal).toContain("Exec=/usr/local/bin/qorpera-screen-browser terminal\n");
		expect(await readFile(join(config, "panel", "launcher-6", "qorpera-browser.desktop"), "utf8")).toContain(
			"Exec=/usr/local/bin/qorpera-screen-browser\n",
		);
		expect(await readFile(join(config, "terminal", "terminalrc"), "utf8")).toContain("CustomCommand=/usr/bin/bash");
		expect((await stat(join(config, "terminal", "terminalrc"))).mode & 0o777).toBe(0o600);
		// No predictable temporary names, and the private write directory is gone.
		expect(text).not.toMatch(/\.tmp\.\$\$/);
		expect((await readdir(join(screenState, "config"))).filter((name) => name.startsWith(".qorpera"))).toEqual([]);

		// Something inside the desktop planted directories where files belong (and at
		// the old predictable temporary names). Looks are skipped; the desktop still gets
		// its panel, launchers and terminal. Only a file the session needs stops it.
		const planted = [join(screenState, "config", "gtk-3.0", "gtk.css"), join(dock, "browser-idle.png")];
		for (const path of planted) {
			await rm(path);
			await mkdir(path);
		}
		await mkdir(join(config, "xfconf", "xfce-perchannel-xml", "xfce4-panel.xml.tmp.1"));
		await mkdir(join(screenState, "config", ".qorpera-write.planted"));
		const again = await run();
		expect(again.stderr.match(/Skipped cosmetic desktop file/g)).toHaveLength(2);
		expect(await readFile(join(config, "panel", "launcher-6", "qorpera-browser.desktop"), "utf8")).toContain(
			"Exec=/usr/local/bin/qorpera-screen-browser\n",
		);
		expect((await readdir(join(screenState, "config"))).filter((name) => name.startsWith(".qorpera"))).toEqual([]);
		await rm(join(config, "terminal", "terminalrc"));
		await mkdir(join(config, "terminal", "terminalrc"));
		await expect(run()).rejects.toMatchObject({ code: 1 });
	});
});
