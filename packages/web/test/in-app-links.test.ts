// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { h, linkHref, setLinkHref } from "../src/ui/dom.ts";

/* In-app links carry no href, so the browser shows no address bubble on hover (Jonas, 9 Nov 2026). */
describe("in-app links", () => {
	afterEach(() => {
		document.body.replaceChildren();
		history.replaceState(null, "", "/#/start");
		vi.restoreAllMocks();
	});

	it("keep their place out of href, stay focusable, and leave outside links as they are", () => {
		const inApp = h("a", { href: "#/c/x" }, "In");
		expect(inApp.hasAttribute("href")).toBe(false);
		expect([inApp.getAttribute("data-href"), inApp.getAttribute("role"), inApp.tabIndex]).toEqual([
			"#/c/x",
			"link",
			0,
		]);
		expect(linkHref(inApp)).toBe("#/c/x");
		expect(h("a", { tabindex: "-1", href: "#/c/x" }).tabIndex).toBe(-1);
		const out = h("a", { href: "https://example.com/" }, "Out");
		expect([out.getAttribute("href"), out.hasAttribute("data-href"), linkHref(out)]).toEqual([
			"https://example.com/",
			false,
			"https://example.com/",
		]);
		setLinkHref(inApp, "#/c/y");
		expect([inApp.hasAttribute("href"), linkHref(inApp)]).toEqual([false, "#/c/y"]);
	});

	it("go on a click or Enter, open a new tab on a modified or middle click, and yield to a handler that prevents", () => {
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		const link = h("a", { href: "#/c/x" }, h("span", null, "In"));
		document.body.append(link);
		link.querySelector("span")!.click();
		expect(location.hash).toBe("#/c/x");

		history.replaceState(null, "", "/#/start");
		link.focus();
		link.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		expect(location.hash).toBe("#/c/x");

		history.replaceState(null, "", "/#/start");
		link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }));
		link.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
		expect(location.hash).toBe("#/start");
		expect(open.mock.calls.map(([url]) => String(url).replace(/^.*#/, "#"))).toEqual(["#/c/x", "#/c/x"]);

		const stopped = h("a", { href: "#/c/z", onclick: (event: Event) => event.preventDefault() }, "Held");
		document.body.append(stopped);
		stopped.click();
		expect(location.hash).toBe("#/start");
	});
});
