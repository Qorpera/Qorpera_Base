// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "../src/ui/dom.ts";

/* app.qorpera.com serves `style-src 'self'`, which drops a style attribute set from script but not a style set through
 * the CSSOM (checked live 10 Nov 2026: the Bank page's progress bar ignored its `--done`). */
describe("an element's style", () => {
	afterEach(() => vi.restoreAllMocks());

	it("is set through the CSSOM, never as an attribute the page's policy would drop", () => {
		const setAttribute = vi.spyOn(Element.prototype, "setAttribute");
		const bar = h("i", { class: "bar", style: "--done: 0.25; height: 40%" });
		expect(setAttribute.mock.calls.some(([name]) => name === "style")).toBe(false);
		expect(bar.style.getPropertyValue("--done").trim()).toBe("0.25");
		expect(bar.style.height).toBe("40%");
		expect(bar.className).toBe("bar");
	});
});
