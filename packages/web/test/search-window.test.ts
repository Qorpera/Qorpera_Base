import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	rankHits,
	type SearchFiles,
	type SearchHit,
	type SearchKind,
	type SearchSources,
	SearchWindow,
} from "../src/app/views/search-window.ts";
import { h } from "../src/ui/dom.ts";
import { stubDialogs } from "./search-window-helpers.ts";

const opened: string[] = [];
const hit = (kind: SearchKind, title: string, detail = "", words = ""): SearchHit => ({
	key: `${kind}:${title}`,
	kind,
	title,
	detail,
	words,
	lead: () => h("span"),
	open: () => opened.push(title),
});
const HITS = [
	hit("people", "Designer", "Drawing the logo"),
	hit("people", "Brand review", "Group chat"),
	hit("people", "Co-Founder", "Hiring a brand designer"),
	hit("apps", "Brand identity", "Studio"),
	hit("settings", "Appearance", "Settings · General", "theme dark light"),
	hit("settings", "Language & region", "Settings · General", "sprog dansk"),
];

function sources(files?: SearchFiles): SearchSources {
	return { profileId: "p1", companyName: "Dekora", hits: () => HITS, ...(files ? { files } : {}) };
}

function mount(files?: SearchFiles) {
	const window = new SearchWindow();
	const opener = h("button");
	document.body.append(opener);
	window.open(sources(files), opener);
	const input = window.el.querySelector<HTMLInputElement>(".search-window-input")!;
	const type = (text: string) => {
		input.value = text;
		input.dispatchEvent(new Event("input"));
	};
	const key = (name: string, init: KeyboardEventInit = {}) =>
		input.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));
	const titles = () => [...window.el.querySelectorAll(".search-window-title")].map((title) => title.textContent);
	const groups = () => [...window.el.querySelectorAll(".search-window-group")].map((group) => group.textContent);
	const picked = () => window.el.querySelector('.search-window-hit[aria-selected="true"] .search-window-title')?.textContent;
	return { window, opener, input, type, key, titles, groups, picked };
}

beforeEach(() => {
	stubDialogs();
	opened.length = 0;
});
afterEach(() => {
	vi.useRealTimers();
	document.body.replaceChildren();
	localStorage.clear();
});

describe("ranking", () => {
	it("keeps hits with every word, names that start with a word first", () => {
		expect(rankHits(HITS, ["brand"]).map((one) => one.title)).toEqual([
			"Brand review",
			"Brand identity",
			"Co-Founder",
		]);
		expect(rankHits(HITS, ["dark"]).map((one) => one.title)).toEqual(["Appearance"]);
		expect(rankHits(HITS, ["brand", "studio"]).map((one) => one.title)).toEqual(["Brand identity"]);
		expect(rankHits(HITS, ["zebra"])).toEqual([]);
	});
});

describe("the search window", () => {
	it("groups hits by kind, marks the words, and goes where Enter or a click leads", () => {
		const { window, opener, input, type, key, titles, groups, picked } = mount();
		expect(document.activeElement).toBe(input);
		type("brand");
		expect(groups()).toEqual(["Agents and people", "Apps"]);
		expect(titles()).toEqual(["Brand review", "Co-Founder", "Brand identity"]);
		expect(window.el.querySelector(".search-window-title mark")?.textContent).toBe("Brand");
		expect(picked()).toBe("Brand review");
		key("ArrowDown");
		key("ArrowDown");
		expect(picked()).toBe("Brand identity");
		expect(input.getAttribute("aria-activedescendant")).toBe("search-window-hit-2");
		key("ArrowDown");
		expect(picked()).toBe("Brand identity");
		key("Enter");
		expect(opened).toEqual(["Brand identity"]);
		expect(window.isOpen).toBe(false);
		expect(document.activeElement).not.toBe(opener);
		window.open(sources(), opener);
		type("dark");
		window.el.querySelector<HTMLElement>(".search-window-hit")!.click();
		expect(opened).toEqual(["Brand identity", "Appearance"]);
	});

	it("narrows to one kind with Tab or a chip, and Esc widens before it closes", () => {
		const { window, opener, type, key, titles, groups } = mount();
		type("brand");
		key("Tab");
		expect(groups()).toEqual(["Agents and people"]);
		expect(window.el.querySelector('.search-window-kind[aria-pressed="true"]')?.textContent).toBe(
			"Agents and people",
		);
		key("Tab");
		expect(titles()).toEqual(["Brand identity"]);
		key("Tab", { shiftKey: true });
		key("Tab", { shiftKey: true });
		expect(groups()).toEqual(["Agents and people", "Apps"]);
		[...window.el.querySelectorAll<HTMLElement>(".search-window-kind")].find((chip) => chip.textContent === "Apps")!.click();
		expect(groups()).toEqual(["Apps"]);
		window.el.dispatchEvent(new Event("cancel", { cancelable: true }));
		expect(window.isOpen).toBe(true);
		expect(groups()).toEqual(["Agents and people", "Apps"]);
		window.el.dispatchEvent(new Event("cancel", { cancelable: true }));
		expect(window.isOpen).toBe(false);
		expect(document.activeElement).toBe(opener);
	});

	it("says when nothing matches, and offers what was opened lately when empty", () => {
		const { window, type, key, titles, groups } = mount();
		expect(window.el.querySelector(".search-window-empty")?.textContent).toBe(
			"Type to find agents, apps, files and settings.",
		);
		type("zebra");
		expect(window.el.querySelector(".search-window-empty")?.textContent).toBe("Nothing in Dekora matches “zebra”.");
		type("lang");
		key("Enter");
		window.open(sources());
		expect(groups()).toEqual(["Recent"]);
		expect(titles()).toEqual(["Language & region"]);
	});

	it("asks for files once typing pauses, keeps only the newest answer, and says when files can't be searched", async () => {
		vi.useFakeTimers();
		const asked: { query: string; limit: number; signal: AbortSignal }[] = [];
		let answer: (hits: SearchHit[]) => void = () => {};
		let refuse: () => void = () => {};
		const files: SearchFiles = {
			search: (query, limit, signal) => {
				asked.push({ query, limit, signal });
				return new Promise((resolve, reject) => {
					answer = (hits) => resolve({ hits, more: false });
					refuse = () => reject(new Error("offline"));
				});
			},
			recent: async () => [hit("files", "brand-guide.md", "brand")],
		};
		const { window, type, titles, groups } = mount(files);
		await vi.runAllTimersAsync();
		expect(groups()).toEqual(["Recent"]);
		expect(titles()).toEqual(["brand-guide.md"]);
		type("bra");
		type("brand");
		await vi.advanceTimersByTimeAsync(119);
		expect(asked).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(asked.map((one) => [one.query, one.limit])).toEqual([["brand", 4]]);
		answer([hit("files", "logo.svg", "brand")]);
		await vi.runAllTimersAsync();
		expect(groups()).toEqual(["Agents and people", "Apps", "Files"]);
		expect(titles()).toContain("logo.svg");
		type("brand x");
		await vi.advanceTimersByTimeAsync(120);
		type("brand y");
		expect(asked[1]!.signal.aborted).toBe(true);
		await vi.advanceTimersByTimeAsync(120);
		refuse();
		await vi.runAllTimersAsync();
		expect(window.el.querySelector(".search-window-note")?.textContent).toBe("Files could not be searched just now.");
	});
});
