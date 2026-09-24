// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import appCss from "../src/styles/app.css?raw";
import conversationCss from "../src/styles/conversation.css?raw";
import darkCss from "../src/styles/dark.css?raw";
import feedbackCss from "../src/styles/feedback.css?raw";
import settingsCss from "../src/styles/settings.css?raw";
import tokensCss from "../src/styles/tokens.css?raw";

afterEach(() => {
	for (const style of document.head.querySelectorAll("style[data-dialog-close-test]")) style.remove();
});

function styleRules(rules: CSSRuleList): CSSStyleRule[] {
	return [...rules].flatMap((rule) =>
		rule instanceof CSSStyleRule ? [rule] : "cssRules" in rule ? styleRules(rule.cssRules as CSSRuleList) : [],
	);
}

describe("dialog close buttons", () => {
	// A dialog's × is a bare glyph: no grey square behind it at rest, on hover or on keyboard focus.
	it("never paints a background behind the settings or feedback ×, in any state or theme", () => {
		const style = document.createElement("style");
		style.dataset.dialogCloseTest = "true";
		style.textContent = [tokensCss, settingsCss, conversationCss, feedbackCss, appCss, darkCss]
			.join("\n")
			.replace(/^@import .*;$/gm, "");
		document.head.append(style);
		const rules = styleRules(style.sheet!.cssRules).filter((rule) =>
			/\.(settings|feedback)-close\b/.test(rule.selectorText),
		);
		expect(rules.map((rule) => rule.selectorText)).toEqual(
			expect.arrayContaining([
				".settings-close",
				".settings-close:is(:hover, :focus-visible)",
				".feedback-close",
				".feedback-close:hover:not(:disabled), .feedback-close:focus-visible",
			]),
		);
		for (const rule of rules)
			for (const property of ["background", "background-color"])
				expect(rule.style.getPropertyValue(property), `${rule.selectorText} ${property}`).toMatch(
					/^(transparent)?$/,
				);
	});
});
