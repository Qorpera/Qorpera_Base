import { describe, expect, it } from "vitest";
import { APP_ICON_MAX_BYTES, appIconIdOf, appIconPath, isAppIconId, parseAppIcon } from "../src/app-icons.ts";
import { INTERFACE_EMBLEMS } from "../src/interfaces.ts";

const svg = (body: string, root = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"') =>
	`<svg ${root}>${body}</svg>`;

describe("an app's own icon (12 Nov 2026)", () => {
	it("reads a compass: black shapes take the colour, white ones are cut out, a shape without fill is black", () => {
		const read = parseAppIcon(
			`<?xml version="1.0"?>\n<!-- a compass -->\n${svg(
				'\n  <circle cx="24" cy="24" r="20.5"/>\n  <path d="M32 14.5 27 27l-11 6.5 5-12.5z" fill="#fff"></path>\n  <path d="M8 24h4" stroke="white" stroke-width="2.6" stroke-linecap="round" fill="none"/>\n',
			)}\n`,
		);
		expect(read.ok).toBe(true);
		if (!read.ok) return;
		expect(read.icon.parts).toEqual([
			{ tag: "circle", attrs: { cx: "24", cy: "24", r: "20.5" }, fill: "ink", stroke: "none" },
			{ tag: "path", attrs: { d: "M32 14.5 27 27l-11 6.5 5-12.5z" }, fill: "cut", stroke: "none" },
			{
				tag: "path",
				attrs: { d: "M8 24h4", "stroke-width": "2.6", "stroke-linecap": "round" },
				fill: "none",
				stroke: "cut",
			},
		]);
	});

	it("takes a line drawn in black as ink with no fill, and width and height on the svg tag", () => {
		const read = parseAppIcon(
			svg(
				'<line x1="4" y1="4" x2="44" y2="44" stroke="#000" stroke-width="4"/>',
				'viewBox="0 0 48 48" width="48" height="48"',
			),
		);
		expect(read.ok && read.icon.parts[0]).toEqual({
			tag: "line",
			attrs: { x1: "4", y1: "4", x2: "44", y2: "44", "stroke-width": "4" },
			fill: "none",
			stroke: "ink",
		});
	});

	it("refuses what it could not draw safely or alike, saying what to change", () => {
		const refused = (text: string) => {
			const read = parseAppIcon(text);
			expect(read.ok, text).toBe(false);
			return read.ok ? "" : read.problem;
		};
		expect(refused(svg('<rect x="0" y="0" width="48" height="48"/>', 'viewBox="0 0 24 24"'))).toContain("48 by 48");
		expect(refused(svg('<g><circle cx="24" cy="24" r="9"/></g>'))).toContain("g is not a shape");
		expect(refused(svg('<image href="x.png"/>'))).toContain("image is not a shape");
		expect(refused(svg('<script>alert(1)</script><circle cx="24" cy="24" r="9"/>'))).toContain("script");
		expect(refused(svg('<circle cx="24" cy="24" r="9" onclick="x()"/>'))).toContain("may not have onclick");
		expect(refused(svg('<circle cx="24" cy="24" r="9" style="fill:red"/>'))).toContain("may not have style");
		expect(refused(svg('<circle cx="24" cy="24" r="9" transform="scale(2)"/>'))).toContain("transform");
		expect(refused(svg('<circle cx="24" cy="24" r="9" fill="red"/>'))).toContain("black");
		expect(refused(svg('<circle cx="24" cy="24" r="9" fill="url(#g)"/>'))).toContain("black");
		expect(refused(svg('<circle cx="calc(1)" cy="24" r="9"/>'))).toContain("not a number");
		expect(refused(svg('<path d="M0 0 url(x)"/>'))).toContain("not a number or path");
		expect(refused(svg('<circle cx="24" cy="24" r="9" fill="&#x23;000"/>'))).toContain("name=");
		expect(refused(svg('<circle cx="24" cy="24" r="9">text</circle>'))).toBeTruthy();
		expect(refused(svg('hello<circle cx="24" cy="24" r="9"/>'))).toContain("no text");
		expect(refused(svg('<circle cx="24" cy="24" r="9" fill="#fff"/>'))).toContain("at least one black");
		expect(refused(svg('<circle cx="24" cy="24" r="9" stroke="#000" stroke-width="40"/>'))).toContain("0.5 to 12");
		expect(refused(`${svg('<circle cx="24" cy="24" r="9"/>')}<p>after</p>`)).toContain("nothing after it");
		expect(refused('<svg viewBox="0 0 48 48" onload="x()"><circle cx="24" cy="24" r="9"/></svg>')).toContain(
			"onload",
		);
		expect(
			refused(svg('<circle cx="24" cy="24" r="9"/>', 'xmlns="http://example.com" viewBox="0 0 48 48"')),
		).toContain("namespace");
		expect(refused(svg('<circle cx="24" cy="24" r="1"/>'.repeat(41)))).toContain("at most 40");
		expect(refused(svg(`<path d="M0 0"/>${" ".repeat(APP_ICON_MAX_BYTES)}`))).toContain("8 KiB");
		expect(refused('<div><svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="9"/></svg></div>')).toContain("<svg>");
	});

	it("names icons by id, and the 24 built-in emblems are the picker's", () => {
		expect(appIconIdOf("compass.svg")).toBe("compass");
		expect(appIconIdOf("Trail Sign.svg")).toBeNull();
		expect(appIconIdOf("compass.png")).toBeNull();
		expect(isAppIconId("trail-sign-2")).toBe(true);
		expect(isAppIconId("-x")).toBe(false);
		expect(appIconPath("trip-planner", "compass")).toBe("apps/trip-planner/icons/compass.svg");
		expect(appIconPath("../x", "compass")).toBeNull();
		expect(INTERFACE_EMBLEMS).toHaveLength(24);
	});
});
