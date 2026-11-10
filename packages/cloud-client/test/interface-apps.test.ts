import { describe, expect, it } from "vitest";
import {
	appFileKind,
	appLinkName,
	appPath,
	appRelativePath,
	appWriteTable,
	isAppManifestPath,
	parseAppManifest,
	parseAppWrites,
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
				writes: [],
				concept: false,
				cover: null,
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
				writes: [],
				concept: false,
				cover: null,
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
			writes: [],
			concept: false,
			cover: null,
		};
		expect(parseAppManifest(writeAppManifest(manifest))).toEqual({ ok: true, manifest });
		// A concept with its cover writes both, and reads back as itself.
		const concept = { ...manifest, concept: true, cover: "shots/cover.webp" };
		const written = writeAppManifest(concept);
		expect(written).toContain('concept = true\ncover = "shots/cover.webp"\n');
		expect(parseAppManifest(written)).toEqual({ ok: true, manifest: concept });
		// Not a concept and no cover: neither line is written.
		expect(writeAppManifest(manifest)).not.toMatch(/concept|cover/);
	});

	it("reads what a page may ask a member to change, and refuses anything else", () => {
		const parsed = parseAppManifest(
			'name = "Orders"\nreads = ["tables", "questions"]\nwrites = ["answers", "table:orders", "answers"]\n',
		);
		expect(parsed.ok && parsed.manifest).toMatchObject({
			reads: ["tables", "questions"],
			writes: ["answers", "table:orders"],
		});
		// It is written out and reads back as itself; a page that only shows writes no such line.
		if (parsed.ok) {
			expect(writeAppManifest(parsed.manifest)).toContain('writes = ["answers", "table:orders"]\n');
			expect(parseAppManifest(writeAppManifest(parsed.manifest))).toEqual(parsed);
			expect(writeAppManifest({ ...parsed.manifest, writes: [] })).not.toContain("writes");
		}
		// Only answers and a table by its folder's name; never the table the Members page keeps.
		for (const writes of [
			'"files"',
			'"tables"',
			'"table:"',
			'"table:Bad_Name"',
			'"table:orders/rows.csv"',
			'"table:areas"',
			'"answers", "everything"',
			Array.from({ length: 17 }, (_, at) => `"table:t${at}"`).join(", "),
		]) {
			const bad = parseAppManifest(`name = "A"\nwrites = [${writes}]\n`);
			expect(bad.ok, writes).toBe(false);
			if (!bad.ok) expect(bad.problems.map((problem) => problem.line)).toEqual([2]);
		}
		expect(parseAppManifest('name = "A"\nwrites = "answers"\n').ok).toBe(false);
		expect(parseAppWrites(["table:orders"])).toEqual({ writes: ["table:orders"] });
		expect(parseAppWrites([1])).toHaveProperty("problem");
		expect(appWriteTable("table:orders")).toBe("orders");
		expect(appWriteTable("answers")).toBeNull();
	});

	it("reads concept and cover, and refuses a cover that is no picture of the app", () => {
		const parsed = parseAppManifest('name = "Shop"\nconcept = true\ncover = "./cover.PNG"\n');
		expect(parsed.ok && parsed.manifest).toMatchObject({ concept: true, cover: "cover.PNG" });
		for (const cover of ["cover.jpg", "img/cover.jpeg", "cover.webp"])
			expect(parseAppManifest(`name = "Shop"\ncover = "${cover}"\n`).ok).toBe(true);
		const bad = parseAppManifest('name = "Shop"\nconcept = "yes"\ncover = "../cover.png"\n');
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.problems.map((problem) => problem.line)).toEqual([2, 3]);
		for (const cover of ["cover.gif", "cover.svg", "index.html", "/cover.png", "https://x.test/a.png", ""])
			expect(parseAppManifest(`name = "Shop"\ncover = "${cover}"\n`).ok).toBe(false);
		expect(parseAppManifest('name = "Shop"\ncover = 1\n').ok).toBe(false);
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
