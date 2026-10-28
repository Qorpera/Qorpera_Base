// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { folderLinkPath } from "../src/ui/folder-links.ts";
import { markdown, markdownBubbles } from "../src/ui/markdown.ts";

describe("a folder link's path", () => {
	it.each([
		["folder:designs/sales-dashboard.html", "designs/sales-dashboard.html"],
		["folder:QorperaOS/vision/vision.md", "QorperaOS/vision/vision.md"],
		["folder:notes", "notes"],
		["folder:designs/sales%20dashboard.html", "designs/sales dashboard.html"],
		["folder:code/app/src/main.ts", "code/app/src/main.ts"],
	])("reads %s as %s", (href, path) => {
		expect(folderLinkPath(href)).toBe(path);
	});

	it.each([
		"folder:",
		"folder:/vision/vision.md",
		"folder:vision/",
		"folder:../vision.md",
		"folder:designs/../../secret.md",
		"folder:./designs/page.html",
		"folder:designs//page.html",
		"folder:designs/page.html ",
		"folder:designs\\page.html",
		"folder:a%2F..%2Fb.md",
		"folder:%E0%A4%A",
		"folder:https://example.com/page.html",
		"folder:javascript:alert(1)",
		"folder:mailto:someone@example.com",
		"folder:folder:vision.md",
		"Folder:vision/vision.md",
		" folder:vision/vision.md",
		"https://example.com/folder:vision.md",
		"vision/vision.md",
	])("refuses %j", (href) => {
		expect(folderLinkPath(href)).toBeUndefined();
	});
});

describe("folder links in a message", () => {
	it("draws each as a button that carries its path and says where it goes", () => {
		const prose = markdown(
			"Open [the dashboard](folder:designs/sales-dashboard.html) or ![a chart](folder:designs/chart.png).",
		);
		const links = [...prose.querySelectorAll<HTMLButtonElement>("button.folder-link")];
		expect(links.map((link) => [link.textContent, link.dataset.folderPath, link.type, link.title])).toEqual([
			["the dashboard", "designs/sales-dashboard.html", "button", "Open designs/sales-dashboard.html in Storage"],
			["Image: a chart", "designs/chart.png", "button", "Open designs/chart.png in Storage"],
		]);
		expect(prose.querySelector("a")).toBeNull();
	});

	it("draws anything else written with the scheme as its text, never as a link", () => {
		const prose = markdown("[up](folder:../secret.md) [scheme](folder:https://evil.example/x) [root](folder:/etc)");
		expect(prose.querySelector("button, a")).toBeNull();
		expect(prose.textContent).toBe("up scheme root");
	});

	it("keeps them as text where links are off, and finds them in every bubble", () => {
		expect(markdown("[d](folder:designs/d.html)", { links: false }).querySelector("button, a")).toBeNull();
		const bubbles = markdownBubbles("First [a](folder:a.md)\n\nSecond [b](folder:b/c.md)");
		expect(bubbles.map((bubble) => bubble.querySelector<HTMLElement>(".folder-link")?.dataset.folderPath)).toEqual([
			"a.md",
			"b/c.md",
		]);
	});
});
