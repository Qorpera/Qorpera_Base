// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
	APP_BRAND_PATH,
	type AppBrand,
	appBaseStyle,
	appColours,
	appScheme,
	parseAppBrand,
	readAppBrand,
} from "../src/app/interface-app-style.ts";
import { folderFake } from "./folder-fake.ts";

const NONE = { accent: null, background: null, text: null };
const brand = (light: Partial<AppBrand["light"]>, dark: Partial<AppBrand["dark"]> = {}): AppBrand => ({
	light: { ...NONE, ...light },
	dark: { ...NONE, ...dark },
});
const page = (head: string) => new DOMParser().parseFromString(`<!doctype html><head>${head}</head>`, "text/html");

describe("a company's colours", () => {
	it("are read from brand.toml: accent, background and text, for a light page and under [dark]", () => {
		expect(
			parseAppBrand(
				'# Fjeldtur\naccent = "#1F6F5B"\nbackground = "#f5f6ef"\ntext = "#123"\nfont = "Inter"\n\n[dark]\naccent = "#7fd1b4"\nbackground = "#141a17"\n',
			),
		).toEqual({
			light: { accent: "#1f6f5b", background: "#f5f6ef", text: "#112233" },
			dark: { accent: "#7fd1b4", background: "#141a17", text: null },
		});
		// Only a hex colour is a colour: nothing else can reach a page's stylesheet.
		expect(
			parseAppBrand(
				'accent = "red"\nbackground = "#fff; } body { display: none"\ntext = 5\n[dark]\naccent = "rgb(1, 2, 3)"\ntext = "#12345"\n',
			),
		).toEqual({ light: NONE, dark: NONE });
		expect(parseAppBrand('dark = "#000000"\naccent = "#1f6f5b"')).toEqual(brand({ accent: "#1f6f5b" }));
		expect(parseAppBrand("")).toEqual({ light: NONE, dark: NONE });
		// A file that is not TOML gives no colours.
		expect(parseAppBrand("accent: #1f6f5b")).toBeNull();
	});

	it("are read with the member's own read, and are none when the file is missing, too large or not text", async () => {
		const signal = new AbortController().signal;
		expect(APP_BRAND_PATH).toBe("QorperaOS/brand/brand.toml");
		const fake = folderFake({ seed: [] });
		expect(await readAppBrand(fake.folder, signal)).toBeNull();
		fake.put(APP_BRAND_PATH, 'accent = "#1f6f5b"\n');
		expect(await readAppBrand(fake.folder, signal)).toEqual(brand({ accent: "#1f6f5b" }));
		fake.put(APP_BRAND_PATH, `accent = "#1f6f5b"\n# ${"x".repeat(4096)}\n`);
		expect(await readAppBrand(fake.folder, signal)).toBeNull();
		// A read that fails is not "no colours": the panel keeps the ones it had.
		const failing = { ...fake.folder, read: async () => Promise.reject(new Error("offline")) };
		await expect(readAppBrand(failing as never, signal)).rejects.toThrow("offline");
	});

	it("are used only where text stays readable on them", () => {
		// With none, Qorpera's own page, text and link colours.
		expect(appColours("light", null)).toMatchObject({
			background: "#ffffff",
			text: "#161615",
			accent: "#305fbe",
			onAccent: "#ffffff",
			shade: "light",
			good: "#0f7a5a",
		});
		expect(appColours("dark", null)).toMatchObject({
			background: "#1f2120",
			text: "#f4f3f0",
			accent: "#6ea4ff",
			onAccent: "#161615",
			shade: "dark",
			good: "#5ed6a9",
		});
		const fjeldtur = brand(
			{ accent: "#1f6f5b", background: "#f5f6ef", text: "#1d2b24" },
			{ background: "#141a17", text: "#e8efe9" },
		);
		expect(appColours("light", fjeldtur)).toMatchObject({
			background: "#f5f6ef",
			text: "#1d2b24",
			accent: "#1f6f5b",
			onAccent: "#ffffff",
		});
		// A dark page takes the colours under [dark]; the light accent stands in when it shows on the dark background,
		// and here it does not (2.9 to 1), so Qorpera's own does.
		expect(appColours("dark", fjeldtur)).toMatchObject({ background: "#141a17", text: "#e8efe9", accent: "#6ea4ff" });
		expect(appColours("dark", brand({ accent: "#e5835c" }))).toMatchObject({
			background: "#1f2120",
			accent: "#e5835c",
		});
		expect(appColours("dark", brand({ accent: "#e5835c" }, { accent: "#7fd1b4" })).accent).toBe("#7fd1b4");
		// Text that does not read on the background (under 4.5 to 1): both are left out, together.
		expect(appColours("light", brand({ background: "#f5f6ef", text: "#9aa39d" }))).toMatchObject({
			background: "#ffffff",
			text: "#161615",
		});
		expect(appColours("light", brand({ background: "#222222" }))).toMatchObject({ background: "#ffffff" });
		expect(appColours("light", brand({ text: "#eeeeee" }))).toMatchObject({ text: "#161615" });
		// An accent that does not show on the background (under 3 to 1) is left out.
		expect(appColours("light", brand({ accent: "#ffe45c" })).accent).toBe("#305fbe");
		// A light accent takes dark text on it.
		expect(appColours("dark", brand({}, { accent: "#ffe45c" }))).toMatchObject({
			accent: "#ffe45c",
			onAccent: "#161615",
		});
		// A company whose page is dark in the light scheme too: controls and the status colours follow the page.
		expect(appColours("light", brand({ background: "#101418", text: "#f0f0f0" }))).toMatchObject({
			background: "#101418",
			shade: "dark",
			good: "#5ed6a9",
			accent: "#6ea4ff",
		});
	});
});

describe("an app's scheme", () => {
	it("is the app's own only for a page that says it supports light and dark, the web's own way", () => {
		expect(appScheme(page(""), "dark")).toBe("light");
		expect(appScheme(page('<meta name="color-scheme" content="light">'), "dark")).toBe("light");
		expect(appScheme(page('<meta name="color-scheme" content="only light">'), "dark")).toBe("light");
		expect(appScheme(page('<meta name="color-scheme" content="light dark">'), "dark")).toBe("dark");
		expect(appScheme(page('<meta name="color-scheme" content="light dark">'), "light")).toBe("light");
		expect(appScheme(page('<meta name="COLOR-SCHEME" content=" Dark\tLight ">'), "dark")).toBe("dark");
		// A page that is dark alone is dark in a light app too.
		expect(appScheme(page('<meta name="color-scheme" content="dark">'), "light")).toBe("dark");
		// Another meta says nothing.
		expect(appScheme(page('<meta name="theme-color" content="dark">'), "dark")).toBe("light");
	});
});

describe("the base style", () => {
	it("is one layer of variables and plain defaults, holding nothing but fixed text and checked colours", () => {
		const css = appBaseStyle("light", brand({ accent: "#1f6f5b", background: "#f5f6ef", text: "#1d2b24" }));
		expect(css.startsWith("@layer qorpera-base {\n:root {")).toBe(true);
		expect(css.trimEnd().endsWith("}")).toBe(true);
		for (const line of [
			"color-scheme: light;",
			"--q-bg: #f5f6ef;",
			"--q-text: #1d2b24;",
			"--q-accent: #1f6f5b;",
			"--q-on-accent: #ffffff;",
			"--q-muted: color-mix(in srgb, var(--q-text) 68%, var(--q-bg));",
			"--q-line: color-mix(in srgb, var(--q-text) 14%, var(--q-bg));",
			"--q-surface: color-mix(in srgb, var(--q-text) 5%, var(--q-bg));",
			"--q-good: #0f7a5a;",
			"--q-warn: #9a6300;",
			"--q-bad: #b33a2f;",
			"--q-font: system-ui,",
			"html { background: var(--q-bg); color: var(--q-text); font: 100%/1.55 var(--q-font);",
			// The page's margin alone holds the column to a readable width: a page that sets its own takes the width back.
			"body { margin: clamp(20px, 4vw, 44px) max(clamp(16px, 4vw, 44px), calc((100% - 800px) / 2));",
			"a { color: var(--q-accent);",
			"th, td { padding: 0.55em 0.9em 0.55em 0; border-bottom: 1px solid var(--q-line);",
			// What a page says in its markup still counts.
			"table:not([width]) { width: 100%; }",
			"th:not([align]) { text-align: start; }",
		])
			expect(css, line).toContain(line);
		// Nothing loads, nothing is forced, and no rule closes the page's own style element.
		expect(css).not.toMatch(/url\(|@import|!important|<\/|max-width: \d+px/i);
		expect(appBaseStyle("dark", null)).toContain("color-scheme: dark;\n\t--q-bg: #1f2120;\n\t--q-text: #f4f3f0;");
		// The defaults are the same in both schemes: only the variables differ.
		const rules = (text: string) => text.slice(text.indexOf("html {"));
		expect(rules(appBaseStyle("dark", null))).toBe(rules(css));
	});
});
