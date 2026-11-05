import { describe, expect, it } from "vitest";
import {
	appFileKind,
	appLinkName,
	appPath,
	appRelativePath,
	isAppManifestPath,
	parseAppManifest,
	setAppPosted,
	writeAppManifest,
} from "../src/interface-apps.ts";

const OWNER = "0b0c3f1e-5a7d-4c2e-9f10-1a2b3c4d5e6f";

describe("interface apps", () => {
	it("reads a manifest with its defaults", () => {
		expect(parseAppManifest('name = "Sales"\n')).toEqual({
			ok: true,
			manifest: {
				name: "Sales",
				about: null,
				emblem: "page",
				colour: null,
				entry: "index.html",
				owner: null,
				posted: false,
				reads: [],
			},
		});
		const full = parseAppManifest(
			`name = "Sales"\nabout = "This week"\nemblem = "chart"\ncolour = "blue"\nentry = "pages/main.html"\nowner = "${OWNER}"\nposted = true\nreads = ["tables", "todos", "tables"]\n`,
		);
		expect(full).toEqual({
			ok: true,
			manifest: {
				name: "Sales",
				about: "This week",
				emblem: "chart",
				colour: "blue",
				entry: "pages/main.html",
				owner: OWNER,
				posted: true,
				reads: ["tables", "todos"],
			},
		});
	});

	it("names every problem with its line", () => {
		const parse = parseAppManifest(
			'name = ""\nemblem = "rocket"\nentry = "../x.html"\nposted = "yes"\nreads = ["mail"]\nextra = 1\n',
		);
		expect(parse.ok).toBe(false);
		if (parse.ok) return;
		expect(parse.problems.map((problem) => problem.line).sort()).toEqual([1, 2, 3, 4, 5, 6]);
		expect(parseAppManifest('name = "A"\nentry = "style.css"\n').ok).toBe(false);
		expect(parseAppManifest('name = "A"\nowner = "nobody"\n').ok).toBe(false);
		expect(parseAppManifest("name = ").ok).toBe(false);
	});

	it("writes a manifest that reads back as itself", () => {
		const manifest = {
			name: 'Say "hi"\\',
			about: "Line",
			emblem: "board" as const,
			colour: "teal" as const,
			entry: "index.html",
			owner: OWNER,
			posted: false,
			reads: ["files" as const],
		};
		expect(parseAppManifest(writeAppManifest(manifest))).toEqual({ ok: true, manifest });
	});

	it("sets posted in place", () => {
		const text = 'name = "A" # the name\nposted = false # hidden\nemblem = "chart"\n';
		expect(setAppPosted(text, true)).toBe('name = "A" # the name\nposted = true # hidden\nemblem = "chart"\n');
		expect(setAppPosted('name = "A"', true)).toBe('name = "A"\nposted = true\n');
		expect(setAppPosted('name = "A"\nposted = true\n', true)).toBe('name = "A"\nposted = true\n');
		expect(setAppPosted("broken =", true)).toBeNull();
	});

	it("places paths inside apps", () => {
		expect(appPath("apps/sales")).toEqual({ name: "sales", inner: "" });
		expect(appPath("apps/sales/js/app.js")).toEqual({ name: "sales", inner: "js/app.js" });
		expect(appPath("Apps/Sales/app.toml")).toEqual({ name: "sales", inner: "app.toml" });
		expect(appPath("apps/Bad_Name/x")).toBeNull();
		expect(appPath("designs/x.html")).toBeNull();
		expect(isAppManifestPath("apps/sales/app.toml")).toBe(true);
		expect(isAppManifestPath("apps/sales/sub/app.toml")).toBe(false);
	});

	it("resolves only plain relative paths", () => {
		expect(appRelativePath("./style.css")).toBe("style.css");
		expect(appRelativePath("img/logo.png")).toBe("img/logo.png");
		for (const bad of [
			"",
			"/abs.css",
			"../up.css",
			"a//b",
			"a/./b",
			"https://x.test/a.js",
			"data:text/css,",
			"a?b",
			"a#b",
			"a\\b",
		])
			expect(appRelativePath(bad)).toBeNull();
		expect(appFileKind("a/B.PNG")).toBe("png");
		expect(appFileKind(".hidden")).toBe("");
	});

	it("reads app links", () => {
		expect(appLinkName("app:sales-board")).toBe("sales-board");
		expect(appLinkName("app:Sales")).toBeUndefined();
		expect(appLinkName("apps:sales")).toBeUndefined();
		expect(appLinkName("app:../x")).toBeUndefined();
	});
});
