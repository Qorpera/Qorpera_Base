// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import appCss from "../src/styles/app.css?raw";
import { h } from "../src/ui/dom.ts";

afterEach(() => {
	document.head.querySelector("style[data-rail-dock-test]")?.remove();
	document.body.replaceChildren();
});

function styleRules(rules: CSSRuleList): CSSStyleRule[] {
	return [...rules].flatMap((rule) =>
		rule instanceof CSSStyleRule ? [rule] : "cssRules" in rule ? styleRules(rule.cssRules as CSSRuleList) : [],
	);
}

function reaches(element: Element, selector: string): boolean {
	try {
		return element.matches(selector);
	} catch {
		return false;
	}
}

describe("the rail's Agents and Members dock", () => {
	it("stands on the rail with no frame of its own, in the wide and the compact rail", () => {
		const style = h("style", { "data-rail-dock-test": "true" });
		style.textContent = appCss.replace(/^@import .*;$/gm, "");
		document.head.append(style);
		const dock = h("div", { class: "rail-dock" }, h("div", { class: "rail-section rail-members" }));
		const frame = h(
			"div",
			{ class: "frame" },
			h("aside", { class: "rail" }, h("div", { class: "rail-scroll" }, h("div", { class: "rail-section" }), dock)),
		);
		document.body.append(frame);
		const rules = styleRules(style.sheet!.cssRules);
		const framing = () =>
			rules
				.filter((rule) => reaches(dock, rule.selectorText))
				.flatMap((rule) => [rule.style.border, rule.style.borderRadius])
				.filter(Boolean);
		expect(rules.some((rule) => reaches(dock, rule.selectorText) && rule.style.position === "sticky")).toBe(true);
		expect(framing()).toEqual([]);
		frame.classList.add("rail-compact");
		expect(framing()).toEqual([]);
	});

	it("fades the list out under a shadow in the rail's own colour, which takes no clicks from the rows under it", () => {
		const dock = /\.rail-dock \{([^}]*)\}/.exec(appCss)?.[1] ?? "";
		expect(dock).toMatch(/box-shadow: 0 -\d+px \d+px var\(--rail\);/);
		expect(dock).not.toMatch(/mask-image|padding|border/);
	});
});

describe("app.css selectors", () => {
	it("nest no :has() inside :has(), which browsers drop together with the whole rule", () => {
		const nested = [...appCss.matchAll(/:has\(/g)].filter(({ index }) => {
			let depth = 1;
			for (let at = index + 5; at < appCss.length && depth > 0; at++) {
				if (appCss.startsWith(":has(", at)) return true;
				if (appCss[at] === "(") depth++;
				else if (appCss[at] === ")") depth--;
			}
			return false;
		});
		expect(nested.map(({ index }) => appCss.slice(index, index + 80))).toEqual([]);
	});
});
