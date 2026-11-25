import { describe, expect, it } from "vitest";
import surfacesCss from "../src/styles/surfaces.css?raw";

function declarations(selector: string, source = surfacesCss): string {
	return (
		new RegExp(`^\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`, "m").exec(source)?.[1] ?? ""
	);
}

function containerBlock(query: string): string {
	const marker = `@container (${query}) {`;
	const start = surfacesCss.indexOf(marker);
	if (start === -1) return "";
	let depth = 1;
	let at = start + marker.length;
	while (at < surfacesCss.length && depth > 0) {
		if (surfacesCss[at] === "{") depth++;
		else if (surfacesCss[at] === "}") depth--;
		at++;
	}
	return surfacesCss.slice(start + marker.length, at - 1);
}

describe("surface notch track spacing", () => {
	it("uses symmetric 4px end padding on the open pill track", () => {
		expect(declarations(".surface-pill")).toContain("padding: 0 4px");
		expect(surfacesCss).not.toMatch(/\.surface-pill:has\(> \.surface-hide-panels:last-child\)/);
	});

	it("keeps Publish controls free of negative horizontal margins so Publish never clips when first or overlaps dividers", () => {
		for (const selector of [
			".surface-publish-main",
			".surface-publish-menu",
			".surface-publish > .surface-publish-no",
		]) {
			expect(declarations(selector)).not.toMatch(/margin-(left|right):\s*-/);
		}
		expect(declarations(".surface-pill > .surface-pill-divider:has(+ .surface-publish)")).toContain(
			"margin-right: 4px",
		);
		expect(
			declarations(".surface-pill > :is(.surface-pill-address, .surface-publish) + .surface-pill-divider"),
		).toContain("margin-left: 6px");
	});

	it("tightens Publish and Hide-panels divider margins at narrow container widths without overlap", () => {
		const narrow = containerBlock("max-width: 40em");
		expect(
			declarations(".surface-pill > :is(.surface-pill-address, .surface-publish) + .surface-pill-divider", narrow),
		).toContain("margin-left: 2px");
		expect(
			declarations(
				".surface-pill > .surface-pill-divider:has(+ :is(.surface-publish, .surface-hide-panels))",
				narrow,
			),
		).toContain("margin-right: 2px");
	});

	it("hides the trailing divider when the device switch is first and hidden on narrow viewports", () => {
		const compact = containerBlock("max-width: 33em");
		expect(compact).toContain(
			'.surface-pill > .surface-toggle[data-toggle="device"]:first-child + .surface-pill-divider',
		);
	});

	it("nests no :has() inside :has() in surfaces.css", () => {
		const nested = [...surfacesCss.matchAll(/:has\(/g)].filter(({ index }) => {
			let depth = 1;
			for (let at = index + 5; at < surfacesCss.length && depth > 0; at++) {
				if (surfacesCss.startsWith(":has(", at)) return true;
				if (surfacesCss[at] === "(") depth++;
				else if (surfacesCss[at] === ")") depth--;
			}
			return false;
		});
		expect(nested.map(({ index }) => surfacesCss.slice(index, index + 80))).toEqual([]);
	});
});
