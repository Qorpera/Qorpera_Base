// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import appCss from "../src/styles/app.css?raw";
import { h } from "../src/ui/dom.ts";

afterEach(() => {
	document.head.querySelector("style[data-rail-unassigned-test]")?.remove();
	document.body.replaceChildren();
});

function styleRules(rules: CSSRuleList): CSSStyleRule[] {
	return [...rules].flatMap((rule) =>
		rule instanceof CSSStyleRule ? [rule] : "cssRules" in rule ? styleRules(rule.cssRules as CSSRuleList) : [],
	);
}

describe("the rail's empty Unassigned title", () => {
	// Unassigned with no one in it is no category; a drag shows its title as a place to drop,
	// but never in the collapsed rail, where no section has a title. jsdom's computed style
	// ignores specificity, so this reads which rules reach the title and what they set.
	it("hides at rest, shows while dragging, and stays hidden in the collapsed rail", () => {
		const style = h("style", { "data-rail-unassigned-test": "true" });
		style.textContent = appCss.replace(/^@import .*;$/gm, "");
		document.head.append(style);
		const rules = styleRules(style.sheet!.cssRules).filter((rule) => rule.style.display);
		const title = h("div", { class: "rail-section-title" }, "Unassigned");
		const group = h("div", { class: "rail-section is-empty" }, title, h("div", { class: "rail-section-list" }));
		const list = h("div", { class: "rail-scroll" }, group);
		const frame = h("div", { class: "frame" }, h("aside", { class: "rail" }, list));
		document.body.append(frame);
		/** What the rules that reach the title set its display to. */
		const displays = () =>
			new Set(rules.filter((rule) => title.matches(rule.selectorText)).map((r) => r.style.display));
		expect(displays()).toEqual(new Set(["none"]));
		list.classList.add("rail-dragging");
		expect(displays()).toContain("block");
		frame.classList.add("rail-compact");
		expect(displays()).toEqual(new Set(["none"]));
		frame.classList.remove("rail-compact");
		// With no section at all the title is hidden outright, dragging or not.
		title.hidden = true;
		expect(displays()).toEqual(new Set(["none"]));
		// Someone in it: nothing hides the title.
		title.hidden = false;
		list.classList.remove("rail-dragging");
		group.classList.remove("is-empty");
		expect(displays().has("none")).toBe(false);
	});
});
