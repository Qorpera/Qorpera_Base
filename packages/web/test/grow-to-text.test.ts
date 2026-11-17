// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { growToText, h } from "../src/ui/dom.ts";

describe("a text box that grows with its text", () => {
	it("keeps the page where it was scrolled while it measures itself", () => {
		const field = h("textarea");
		const page = h("section", null, h("div", null, field));
		document.body.append(page);
		let top = 600;
		Object.defineProperty(page, "scrollTop", {
			configurable: true,
			get: () => top,
			set: (value: number) => {
				top = value;
			},
		});
		Object.defineProperty(field, "scrollHeight", {
			configurable: true,
			get: () => {
				if (field.style.height === "auto") top = 120;
				return 900;
			},
		});
		growToText(field);
		expect(field.style.height).toBe("900px");
		expect(top).toBe(600);
		page.remove();
	});
});
