// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileHit, filePlace, isPlumbing, oneCopyEach } from "../src/app/views/search-files.ts";
import {
	rankHits,
	type SearchFiles,
	type SearchHit,
	type SearchKind,
	type SearchSources,
	SearchWindow,
	shortAge,
	sortHits,
} from "../src/app/views/search-window.ts";
import { markSettingsPlace } from "../src/app/views/settings.ts";
import { h } from "../src/ui/dom.ts";
import { stubDialogs } from "./search-window-helpers.ts";
import "./register-lazy.ts";

const opened: string[] = [];
const hit = (
	kind: SearchKind,
	title: string,
	detail = "",
	words = "",
	more: Partial<Pick<SearchHit, "at" | "marks">> = {},
): SearchHit => ({
	key: `${kind}:${title}`,
	kind,
	title,
	detail,
	words,
	...more,
	lead: () => h("span"),
	open: () => opened.push(title),
});
const HITS = [
	hit("people", "Designer", "Drawing the logo", "", { at: "2026-11-23T08:00:00Z", marks: ["working"] }),
	hit("people", "Brand review", "Group chat", "", { at: "2026-11-23T11:00:00Z", marks: ["needs-you"] }),
	hit("people", "Co-Founder", "Hiring a brand designer", "", { at: "2026-11-22T11:00:00Z" }),
	hit("apps", "Brand identity", "Studio"),
	hit("settings", "Appearance", "Settings · General", "theme dark light"),
	hit("settings", "Language & region", "Settings · General", "sprog dansk"),
];

const LOGO = hit("files", "logo.svg", "brand");

function sources(files?: SearchFiles): SearchSources {
	return {
		profileId: "p1",
		companyName: "Dekora",
		hits: () => HITS,
		revive: (key) => (key === LOGO.key ? LOGO : undefined),
		...(files ? { files } : {}),
	};
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
	const picked = () =>
		window.el.querySelector('.search-window-hit[aria-selected="true"] .search-window-title')?.textContent;
	const choose = (button: string, label: string) => {
		window.el.querySelector<HTMLElement>(button)!.click();
		const items = [...window.el.querySelectorAll<HTMLElement>(".context-menu:not(.is-leaving) .context-menu-item")];
		const offered = items.map((item) => item.textContent);
		items.find((item) => item.textContent === label)?.click();
		return offered;
	};
	const kind = () => window.el.querySelector(".search-window-pick")?.textContent;
	return { window, opener, input, type, key, titles, groups, picked, choose, kind };
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

	it("narrows to one kind with Tab or the picker, and Esc widens before it closes", () => {
		const { window, opener, input, type, key, titles, groups, choose, kind } = mount();
		expect(kind()).toBe("All");
		type("brand");
		key("Tab");
		expect(kind()).toBe("Agents and people");
		expect(input.placeholder).toBe("Search agents and people");
		expect(groups()).toEqual([]);
		expect(titles()).toEqual(["Brand review", "Co-Founder"]);
		key("Tab");
		expect(titles()).toEqual(["Brand identity"]);
		key("Tab", { shiftKey: true });
		key("Tab", { shiftKey: true });
		expect(groups()).toEqual(["Agents and people", "Apps"]);
		expect(choose(".search-window-pick", "Apps")).toEqual(["All", "Agents and people", "Apps", "Files", "Settings"]);
		expect(kind()).toBe("Apps");
		expect(titles()).toEqual(["Brand identity"]);
		expect(document.activeElement).toBe(input);
		window.el.dispatchEvent(new Event("cancel", { cancelable: true }));
		expect(window.isOpen).toBe(true);
		expect(groups()).toEqual(["Agents and people", "Apps"]);
		window.el.dispatchEvent(new Event("cancel", { cancelable: true }));
		expect(window.isOpen).toBe(false);
		expect(document.activeElement).toBe(opener);
	});

	it("lists a whole kind without a word typed, newest first, each with how long ago", () => {
		vi.useFakeTimers({ now: new Date("2026-11-23T12:00:00Z") });
		const { window, choose, titles } = mount();
		choose(".search-window-pick", "Agents and people");
		expect(titles()).toEqual(["Brand review", "Designer", "Co-Founder"]);
		expect([...window.el.querySelectorAll(".search-window-time")].map((time) => time.textContent)).toEqual([
			"1h",
			"4h",
			"1d",
		]);
		choose(".search-window-pick", "Files");
		expect(window.el.querySelector(".search-window-empty")?.textContent).toBe("Nothing here yet.");
	});

	it("sorts by name and shows only what a filter keeps, with the filters of the kind picked", () => {
		const { window, type, choose, titles, groups } = mount();
		const filter = window.el.querySelector<HTMLElement>(".search-window-filter")!;
		expect(choose(".search-window-filter", "Needs you")).toEqual([
			"Latest",
			"Name",
			"Everything",
			"Needs you",
			"Working",
			"Images",
			"Documents",
			"Folders",
		]);
		expect(groups()).toEqual(["Agents and people"]);
		expect(titles()).toEqual(["Brand review"]);
		expect(filter.classList.contains("is-on")).toBe(true);
		choose(".search-window-filter", "Everything");
		expect(filter.classList.contains("is-on")).toBe(false);
		expect(groups()).toEqual([]);
		type("brand");
		expect(choose(".search-window-filter", "Name").slice(0, 3)).toEqual(["Best match", "Latest", "Name"]);
		expect(titles()).toEqual(["Brand review", "Co-Founder", "Brand identity"]);
		choose(".search-window-filter", "Latest");
		expect(titles()).toEqual(["Brand review", "Co-Founder", "Brand identity"]);
		choose(".search-window-pick", "Settings");
		expect(choose(".search-window-filter", "Name")).toEqual(["Best match", "Latest", "Name"]);
	});

	it("opens a menu on the press, and the press that closes it does not open it again", () => {
		const { window } = mount();
		const pick = window.el.querySelector<HTMLElement>(".search-window-pick")!;
		const menus = () => window.el.querySelectorAll(".context-menu:not(.is-leaving)").length;
		const press = () => pick.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
		press();
		expect(menus()).toBe(1);
		press();
		expect(menus()).toBe(0);
		press();
		expect(menus()).toBe(1);
		const filter = window.el.querySelector<HTMLElement>(".search-window-filter")!;
		filter.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
		expect(menus()).toBe(1);
		expect(window.el.querySelector(".context-menu:not(.is-leaving)")?.getAttribute("aria-label")).toBe(
			"Sort and filter",
		);
		window.close();
		expect(menus()).toBe(0);
	});

	it("picks the row under a pointer that moved, never one a scroll brought under it", () => {
		const { window, type, picked } = mount();
		type("brand");
		const rows = [...window.el.querySelectorAll<HTMLElement>(".search-window-hit")];
		const move = (row: HTMLElement, y: number) =>
			row.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 40, clientY: y }));
		move(rows[1]!, 80);
		expect(picked()).toBe("Co-Founder");
		move(rows[2]!, 80);
		expect(picked()).toBe("Co-Founder");
		move(rows[2]!, 120);
		expect(picked()).toBe("Brand identity");
		rows[0]!.click();
		expect(opened).toEqual(["Brand review"]);
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

	it("keeps a file opened from it in Recent, and reads the recent changes again on every open", async () => {
		let reads = 0;
		const files: SearchFiles = {
			search: async () => ({ hits: [LOGO], more: false }),
			recent: async () => {
				reads++;
				return [];
			},
		};
		const { window, type, key, titles } = mount(files);
		type("svg");
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(titles()).toEqual(["logo.svg"]);
		key("Enter");
		expect(opened).toEqual(["logo.svg"]);
		window.open(sources(files));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(titles()).toEqual(["logo.svg"]);
		expect(reads).toBe(2);
	});

	it("clears rendered results when reset closes the search window", () => {
		const { window, type, titles } = mount();
		type("brand");
		expect(titles().length).toBeGreaterThan(0);
		window.reset();
		expect(window.isOpen).toBe(false);
		expect(titles()).toEqual([]);
	});

	it("renders cached recent files and repeat queries immediately on reopen, revalidates in background, and clears on invalidation or company switch", async () => {
		vi.useFakeTimers();
		let recentResolve: ((hits: SearchHit[]) => void) | undefined;
		let searchCalls = 0;
		const recentFile = fileHit({ path: "notes/roadmap.md", kind: "file" }, () => {});
		const files: SearchFiles = {
			recent: vi.fn(
				() =>
					new Promise<SearchHit[]>((resolve) => {
						recentResolve = resolve;
					}),
			),
			search: vi.fn(async (query) => {
				searchCalls++;
				return { hits: [fileHit({ path: `docs/${query}.md`, kind: "file" }, () => {})], more: false };
			}),
		};
		const { window, type, titles } = mount(files);
		recentResolve!([recentFile]);
		await Promise.resolve();
		await Promise.resolve();
		expect(titles()).toEqual(["roadmap.md"]);

		type("budget");
		await vi.advanceTimersByTimeAsync(150);
		expect(searchCalls).toBe(1);
		expect(titles()).toContain("budget.md");

		window.close();
		recentResolve = undefined;
		window.open(sources(files));
		// WHY: Cached recent files render synchronously at 0ms while the background recent() refresh is still pending.
		expect(titles()).toEqual(["roadmap.md"]);
		expect(files.recent).toHaveBeenCalledTimes(2);

		type("budget");
		// WHY: Cached query results render at 0ms before FILE_DELAY_MS fires, then revalidate after debounce.
		expect(titles()).toContain("budget.md");
		expect(searchCalls).toBe(1);
		await vi.advanceTimersByTimeAsync(150);
		expect(searchCalls).toBe(2);

		window.invalidateFiles("p1");
		window.close();
		window.open(sources(files));
		expect(titles()).toEqual([]);

		recentResolve!([recentFile]);
		await Promise.resolve();
		await Promise.resolve();
		expect(titles()).toEqual(["roadmap.md"]);

		window.close();
		window.open({ ...sources(files), profileId: "other-company" });
		expect(titles()).toEqual([]);
	});
});

describe("times and order", () => {
	it("writes how long ago in a few characters, then the day", () => {
		const now = Date.parse("2026-11-23T12:00:00Z");
		expect(shortAge("2026-11-23T11:59:40Z", now)).toBe("now");
		expect(shortAge("2026-11-23T11:48:00Z", now)).toBe("12m");
		expect(shortAge("2026-11-23T09:10:00Z", now)).toBe("2h");
		expect(shortAge("2026-11-20T12:00:00Z", now)).toBe("3d");
		expect(shortAge("2026-11-02T12:00:00Z", now)).toBe("3w");
		expect(shortAge("2026-07-04T12:00:00Z", now)).toBe("Jul 4");
		expect(shortAge("2025-07-04T12:00:00Z", now)).toBe("Jul 4, 2025");
		expect(shortAge(undefined, now)).toBe("");
		expect(shortAge("not a time", now)).toBe("");
	});

	it("puts the newest first and what has no time last, or orders by name", () => {
		expect(sortHits(HITS.slice(0, 4), "latest").map((one) => one.title)).toEqual([
			"Brand review",
			"Designer",
			"Co-Founder",
			"Brand identity",
		]);
		expect(sortHits(HITS.slice(0, 4), "name").map((one) => one.title)).toEqual([
			"Brand identity",
			"Brand review",
			"Co-Founder",
			"Designer",
		]);
	});
});

describe("files in the search window", () => {
	const title = (slug: string) => (slug === "website" ? "Hjemmeside" : undefined);

	it("says where a file is in a few words, never the folders a code area keeps its copies in", () => {
		expect(filePlace("notes.md", title)).toBe("Company File");
		expect(filePlace("brand/logo/logo-dark.svg", title)).toBe("brand / logo");
		expect(filePlace("research/2026/q4/names/shop-names.md", title)).toBe("q4 / names");
		expect(filePlace("code/surfaces/website/main/styles.css", title)).toBe("Hjemmeside");
		expect(filePlace("code/surfaces/website/main/src/assets/product.png", title)).toBe("Hjemmeside / assets");
		expect(filePlace("code/surfaces/website", title)).toBe("Code");
		expect(filePlace("code/surfaces", title)).toBe("Code");
		expect(filePlace("code", title)).toBe("Company File");
		expect(filePlace("code/surfaces/shop/main/index.html", title)).toBe("shop");
		expect(filePlace("code/acme/storefront/main/src/app.ts", title)).toBe("storefront / src");
		const draft = "code/surfaces/website/worktrees/533ab75c-8957-408f-ab6e-5d1f6c2a9e10";
		expect(filePlace(`${draft}/styles.css`, title)).toBe("Hjemmeside · draft");
		expect(filePlace(`${draft}/src/assets/product.png`, title)).toBe("Hjemmeside / assets · draft");
	});

	it("keeps one copy of a file: the published one, else the newest draft, and nothing of git's own", () => {
		const copies = [
			{ path: "code/surfaces/website/worktrees/aaa/styles.css", kind: "file", at: "2026-11-23T10:00:00Z" },
			{ path: "brand/logo.svg", kind: "file", at: "2026-11-20T10:00:00Z" },
			{ path: "code/surfaces/website/main/styles.css", kind: "file", at: "2026-11-22T10:00:00Z" },
			{ path: "code/surfaces/website/worktrees/bbb/styles.css", kind: "file", at: "2026-11-23T11:00:00Z" },
			{ path: "code/surfaces/website/worktrees/aaa/new.css", kind: "file", at: "2026-11-23T09:00:00Z" },
			{ path: "code/surfaces/website/worktrees/bbb/new.css", kind: "file", at: "2026-11-23T12:00:00Z" },
			{ path: "code/surfaces/website/repo.git/HEAD", kind: "file", at: "2026-11-23T12:00:00Z" },
			{ path: "code/surfaces/website/repo.git", kind: "folder", at: "2026-11-23T12:00:00Z" },
			{ path: "code/surfaces/website/worktrees", kind: "folder", at: "2026-11-23T12:00:00Z" },
			{ path: "code/surfaces/website/worktrees/bbb", kind: "folder", at: "2026-11-23T12:00:00Z" },
			{ path: "code/surfaces/website/main", kind: "folder", at: "2026-11-22T10:00:00Z" },
			{ path: "code/surfaces/website/main/.git", kind: "file", at: "2026-11-22T10:00:00Z" },
			{ path: "code/surfaces/website/worktrees/bbb/.git", kind: "file", at: "2026-11-23T12:00:00Z" },
			{ path: "code/surfaces/website", kind: "folder", at: "2026-11-22T10:00:00Z" },
		];
		expect(oneCopyEach(copies).map((file) => file.path)).toEqual([
			"brand/logo.svg",
			"code/surfaces/website/main/styles.css",
			"code/surfaces/website/worktrees/bbb/new.css",
			"code/surfaces/website",
		]);
		expect(isPlumbing("code/surfaces/website/worktrees/bbb/new.css")).toBe(false);
		expect(isPlumbing("notes/repo.git/HEAD")).toBe(false);
	});

	it("draws a file as the Files page does and opens it where it is", () => {
		const shown: string[] = [];
		const logo = fileHit({ path: "brand/logo.svg", kind: "file", at: "2026-11-20T10:00:00Z" }, (path) =>
			shown.push(path),
		);
		expect([logo.title, logo.detail, logo.at, logo.marks]).toEqual([
			"logo.svg",
			"brand",
			"2026-11-20T10:00:00Z",
			["image"],
		]);
		expect(logo.lead().querySelector(".storage-glyph")).not.toBeNull();
		expect((logo.lead() as HTMLElement).className).toBe("files-kind is-image");
		logo.open();
		expect(shown).toEqual(["brand/logo.svg"]);
		expect(fileHit({ path: "brand", kind: "folder" }, () => {}).marks).toEqual(["folder"]);
		expect(fileHit({ path: "code/surfaces/website/main/styles.css", kind: "file" }, () => {}).marks).toBeUndefined();
	});
});

describe("lighting a setting", () => {
	it("lights the group whose heading names the place once its tab draws", async () => {
		stubDialogs();
		const content = h("div", { class: "settings-content" });
		document.body.append(content);
		markSettingsPlace("Appearance");
		const group = h("section", { class: "settings-group" }, h("h2", null, "Appearance"));
		content.append(h("section", { class: "settings-group" }, h("h2", null, "Account")), group);
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(group.classList.contains("is-found")).toBe(true);
		expect(content.querySelectorAll(".is-found")).toHaveLength(1);
	});
});
