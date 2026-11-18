// @vitest-environment jsdom
import { type Program, writeProgram } from "@qorpera/cloud-client/app-program";
import type { CloudMemberFolderFile } from "@qorpera/cloud-client/cloud-member-folder";
import { parseAppManifest } from "@qorpera/cloud-client/interface-apps";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readApps } from "../src/app/interface-apps.ts";
import { downloadOffer, memberSystem } from "../src/app/program-download.ts";
import { AppPanel, type AppPanelHost } from "../src/app/views/app-panel.ts";
import { ProgramPage, readProgram } from "../src/app/views/program-page.ts";
import { openMenu } from "../src/ui/context-menu.ts";
import { setLanguagePreference } from "../src/ui/preferences.ts";
import { folderFake } from "./folder-fake.ts";

const SHA = "b".repeat(64);
const APK = "apk of 0.2";
const TAR = "tarball of 0.1";
const kept = (file: string, bytes: number) => ({ file, bytes, sha256: SHA });
const PROGRAM: Program = {
	version: "0.2",
	forms: [
		{ for: "android", file: "fokusur-0.2.apk" },
		{ for: "linux", file: "fokusur-0.2.tar.gz" },
	],
	screens: { phone: "screens/phone.png", desktop: "screens/desktop.png" },
	versions: [
		{
			version: "0.2",
			date: "2026-11-20T09:30:00.000Z",
			forms: [
				{ for: "android", ...kept("fokusur-0.2.apk", APK.length) },
				{ for: "linux", ...kept("fokusur-0.2.tar.gz", 19_000_000) },
			],
		},
		{
			version: "0.1",
			date: "2026-11-02T13:00:00.000Z",
			forms: [{ for: "linux", ...kept("fokusur-0.1.tar.gz", TAR.length) }],
		},
	],
};

const pages: { dispose(): void }[] = [];
let saved: { name: string; href: string }[] = [];
beforeEach(() => {
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	URL.createObjectURL = vi.fn(() => "blob:program-file");
	URL.revokeObjectURL = vi.fn();
	saved = [];
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
		saved.push({ name: this.download, href: this.href });
	});
});
afterEach(() => {
	for (const page of pages.splice(0)) page.dispose();
	openMenu()?.close();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	document.body.replaceChildren();
	setLanguagePreference("en");
});

async function company(program: Program = PROGRAM) {
	const fake = folderFake({ seed: [] });
	fake.put("apps/fokusur/app.toml", 'name = "Fokusur"\nkit = "program"\nemblem = "page"\nposted = true\n');
	fake.put("apps/fokusur/versions/0.2/fokusur-0.2.apk", APK);
	fake.put("apps/fokusur/versions/0.1/fokusur-0.1.tar.gz", TAR);
	const read = fake.folder.read.getMockImplementation();
	if (!read) throw new Error("the fake folder has no read");
	const files = new Map<string, CloudMemberFolderFile>();
	// WHY: the fake hands a file a new hash on every read; a real folder's hash is its content's.
	fake.folder.read.mockImplementation(async (path, at) => {
		const found = await read(path, at);
		const file = found.entry?.file;
		if (!found.entry || !file) return found;
		const same = files.get(found.entry.version) ?? file;
		files.set(found.entry.version, same);
		return { ...found, entry: { ...found.entry, file: same } };
	});
	const signal = new AbortController().signal;
	const versions = await Promise.all(
		program.versions.map(async (each) => ({
			...each,
			forms: await Promise.all(
				each.forms.map(async (form) => {
					const found = await fake.folder.read(`apps/fokusur/versions/${each.version}/${form.file}`, signal);
					return { ...form, sha256: found.entry?.file?.fileSha256 ?? form.sha256 };
				}),
			),
		})),
	);
	fake.put("apps/fokusur/program.json", writeProgram({ ...program, versions }));
	return fake;
}

async function page(system: Parameters<typeof downloadOffer>[1], program: Program = PROGRAM) {
	const fake = await company(program);
	const read = await readProgram(fake.folder, "apps/fokusur", new AbortController().signal);
	if (!read.ok) throw new Error(read.message);
	const parsed = parseAppManifest(fake.text("apps/fokusur/app.toml") ?? "");
	if (!parsed.ok) throw new Error("manifest");
	const shown = new ProgramPage(
		{ folder: () => fake.folder, system },
		{ name: "fokusur", path: "apps/fokusur", manifest: parsed.manifest },
		read.program,
		read.key,
	);
	pages.push(shown);
	document.body.append(shown.el);
	const text = (selector: string) => shown.el.querySelector(selector)?.textContent ?? null;
	const kinds = () =>
		[...shown.el.querySelectorAll<HTMLElement>(".program-kind")].map(
			(kind) => `${kind.textContent}${kind.classList.contains("is-made") ? "" : " (not made)"}`,
		);
	return { fake, shown, text, kinds, button: () => shown.el.querySelector<HTMLButtonElement>(".program-download")! };
}

describe("the member's system", () => {
	it("is read from the browser", () => {
		const agent = (userAgent: string, maxTouchPoints = 0) => memberSystem({ userAgent, maxTouchPoints });
		expect(agent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36")).toBe(
			"android",
		);
		expect(agent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148")).toBe(
			"iphone",
		);
		expect(
			agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.1 Safari/605.1.15", 5),
		).toBe("iphone");
		expect(agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36")).toBe(
			"mac",
		);
		expect(agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36")).toBe(
			"windows",
		);
		expect(agent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36")).toBe("linux");
		expect(agent("Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/131 Safari/537.36")).toBeNull();
	});

	it("picks the member's own form, else the first in the fixed order", () => {
		const forms = PROGRAM.versions[0]!.forms;
		expect(downloadOffer(forms, "linux")).toMatchObject({ form: { for: "linux" }, own: true, install: false });
		expect(downloadOffer(forms, "android")).toMatchObject({ form: { for: "android" }, own: true, install: true });
		expect(downloadOffer(forms, "windows")).toMatchObject({ form: { for: "android" }, own: false });
		expect(downloadOffer([], "windows")).toBeNull();
	});
});

describe("a program's page", () => {
	it("shows the newest version, both pictures, and a Download for this computer", async () => {
		const { shown, text, kinds, button } = await page("linux");
		expect(text(".program-name")).toBe("Fokusur");
		expect(text(".program-state")).toMatch(/^Version 0\.2 · /);
		expect(shown.el.querySelector(".program-stage.has-phone.has-desktop")).not.toBeNull();
		expect(shown.el.querySelector(".program-window-bar")?.textContent).toBe("Fokusur");
		expect(button().textContent).toBe("Download");
		expect(text(".program-note")).toBe("For this computer");
		expect(kinds()).toEqual(["Android", "Linux", "Windows (not made)", "Mac (not made)", "iPhone (not made)"]);
		expect(shown.el.querySelector(".program-back")?.hasAttribute("hidden")).toBe(true);
	});

	it("offers the first form by its kind where the computer has none, and Install on an Android phone", async () => {
		const windows = await page("windows");
		expect(windows.button().textContent).toBe("Download for Android");
		expect(windows.text(".program-note")).toBe("Not made for Windows yet");
		const phone = await page("android");
		expect(phone.button().textContent).toBe("Install");
		expect(phone.text(".program-note")).toBe("For this phone");
	});

	it("shows one picture alone, and with none one tile with the file's name and size", async () => {
		const one = await page("linux", { ...PROGRAM, screens: { phone: "screens/phone.png" } });
		expect(one.shown.el.querySelector(".program-stage.has-phone:not(.has-desktop) .program-phone")).not.toBeNull();
		expect(one.shown.el.querySelector(".program-window")).toBeNull();
		const none = await page("windows", { ...PROGRAM, screens: {} });
		expect(none.shown.el.querySelector(".program-stage.is-tile .program-tile-initial")?.textContent).toBe("F");
		expect(none.text(".program-tile-file strong")).toBe("fokusur-0.2.apk");
		expect(none.text(".program-tile-file small")).toBe("10 B");
	});

	it("lists the earlier versions in its menu, shows the one picked and leads back to the newest", async () => {
		const { shown, text, kinds, button } = await page("linux");
		shown.el.querySelector<HTMLButtonElement>(".program-more")!.click();
		const menu = openMenu()!.el;
		expect(menu.textContent).toContain("Earlier versions");
		const rows = [...menu.querySelectorAll<HTMLElement>("[role=menuitemradio], [role=menuitem]")];
		expect(rows.map((row) => row.textContent)).toEqual([expect.stringMatching(/^0\.1 · /)]);
		rows[0]!.click();
		expect(shown.shown).toBe("0.1");
		expect(text(".program-state")).toMatch(/^Version 0\.1 · /);
		expect(kinds()).toEqual([
			"Android (not made)",
			"Linux",
			"Windows (not made)",
			"Mac (not made)",
			"iPhone (not made)",
		]);
		expect(button().textContent).toBe("Download");
		const back = shown.el.querySelector<HTMLButtonElement>(".program-back-button")!;
		expect(back.textContent).toBe("Back to the newest, 0.2");
		back.click();
		expect(shown.shown).toBe("0.2");
		expect(shown.el.querySelector(".program-back-button")).toBeNull();
	});

	it("downloads the picked version's file under its own name, then says where it is", async () => {
		const { shown, text, button } = await page("linux");
		shown.show("0.1");
		button().click();
		await vi.waitFor(() => expect(text(".program-note")).toBe("It's in your Downloads."));
		expect(saved).toEqual([{ name: "fokusur-0.1.tar.gz", href: "blob:program-file" }]);
		const handed = vi.mocked(URL.createObjectURL).mock.calls.at(-1)![0] as Blob;
		expect(handed.size).toBe(TAR.length);
		expect(button().disabled).toBe(false);
		shown.el.querySelector<HTMLButtonElement>('.program-kind[data-kind="linux"]')!.click();
		await vi.waitFor(() => expect(saved).toHaveLength(2));
	});

	it("says what Storage says of a file over the client's limit, and that a gone file is gone", async () => {
		const huge = structuredClone(PROGRAM) as Program;
		(huge.versions[0]!.forms[1] as { bytes: number }).bytes = 300 * 1024 * 1024;
		const large = await page("linux", huge);
		expect(large.button().disabled).toBe(true);
		expect(large.text(".program-note")).toBe("300 MiB: too large to download here.");
		const gone = await page("android");
		gone.fake.remove("apps/fokusur/versions/0.2/fokusur-0.2.apk");
		gone.button().click();
		await vi.waitFor(() => expect(gone.text(".program-note")).toBe("This file is no longer in the app's folder."));
		const rebuilt = await page("android");
		rebuilt.fake.put("apps/fokusur/versions/0.2/fokusur-0.2.apk", "another build");
		rebuilt.button().click();
		await vi.waitFor(() =>
			expect(rebuilt.text(".program-note")).toBe("This file changed after version 0.2 was kept."),
		);
		expect(saved).toEqual([]);
	});

	it("speaks Danish", async () => {
		setLanguagePreference("da");
		const { button, text } = await page("android");
		expect(button().textContent).toBe("Installér");
		expect(text(".program-note")).toBe("Til denne telefon");
	});
});

describe("a program app's page in the client", () => {
	it("draws the program natively, never in a frame, and says when it has no version", async () => {
		const fake = await company();
		let changed = () => {};
		let release = () => {};
		let holding = false;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const folder = {
			...fake.folder,
			readFile: async (...asked: Parameters<typeof fake.folder.readFile>) => {
				if (asked[0].bytes === APK.length) {
					holding = true;
					await held;
				}
				return fake.folder.readFile(...asked);
			},
		};
		const host = {
			folder: () => folder,
			agents: () => [],
			readApps: (signal: AbortSignal) => readApps(fake.folder, signal),
			apps: () => [],
			agentName: () => null,
			onFolderChange: (listener: () => void) => {
				changed = listener;
				return () => {};
			},
			openInStorage: vi.fn<(path: string) => void>(),
			openApp: vi.fn<(name: string) => void>(),
			budgetKey: crypto.randomUUID(),
		} satisfies AppPanelHost;
		const panel = new AppPanel(
			host,
			{ kind: "app", name: "fokusur" },
			{ kind: "page", back: { href: "#/c/x", label: "Back" } },
		);
		pages.push(panel);
		document.body.append(panel.el);
		await vi.waitFor(() =>
			expect(panel.el.querySelector(".program-page .program-name")?.textContent).toBe("Fokusur"),
		);
		expect(panel.el.querySelector("iframe")).toBeNull();
		expect(panel.el.querySelector(".side-panel-body.is-program")).not.toBeNull();
		const shown = panel.el.querySelector(".program-page");
		changed();
		await panel.reload(false);
		expect(panel.el.querySelector(".program-page")).toBe(shown);
		expect(panel.el.querySelector(".side-panel-status")).toBeNull();
		panel.el.querySelector<HTMLButtonElement>('.program-kind[data-kind="android"]')!.click();
		await vi.waitFor(() => expect(holding).toBe(true));
		await panel.reload(true);
		expect(panel.el.querySelector(".program-page")).toBe(shown);
		release();
		await vi.waitFor(() =>
			expect(panel.el.querySelector(".program-note")?.textContent).toBe("It's in your Downloads."),
		);
		expect(panel.el.querySelector(".program-page")).toBe(shown);
		fake.remove("apps/fokusur/program.json");
		await panel.reload(true);
		expect(panel.el.querySelector(".side-panel-status")?.textContent).toBe("This program has no version yet.");
		expect(panel.el.querySelector(".program-page")).toBeNull();
	});
});
