// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CloudMemberDataAnswer, CloudMemberDataQuestion } from "@qorpera/cloud-client/cloud-member-data";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyNumbers } from "../src/app/interface-apps.ts";
import {
	companyToday,
	pageAddress,
	pageNames,
	readHours,
	readNow,
	readPages,
	SITE_DOOR_PASS,
	SITE_DOOR_READY,
	SITE_DOOR_SHOWN,
	SITE_DOOR_URL,
	SiteView,
	type SiteViewHost,
	shownAddress,
} from "../src/app/views/site-view.ts";
import { type Cloud, CloudRpcError } from "../src/cloud/client.ts";
import { type CompanySite, createWebSites, parseSiteMemberPass, type SiteMemberPass } from "../src/cloud/sites.ts";
import { setLanguagePreference } from "../src/ui/preferences.ts";
import { deferred, id, settle, timestamp } from "./fixtures.ts";

const shop: CompanySite = {
	id: id(81),
	slug: "wristband-shop",
	title: "Wristband shop",
	kind: "files",
	url: "https://wristband-shop.qorpera.com/",
	state: "live",
	source: "product/webshop",
	files: 12,
	bytes: 2048,
	publishedAt: timestamp,
	publishedBy: { agentId: id(90), name: "Co-Founder" },
	createdAt: timestamp,
	passwordChangedAt: timestamp,
	machine: null,
	port: null,
};
const PASS = "A".repeat(43);
const pass = (n = 0): SiteMemberPass & { state: "open" } => ({
	state: "open",
	host: "wristband-shop.qorpera.com",
	pass: `${PASS.slice(0, 42)}${n}`,
	expiresAt: "2026-11-15T10:01:00Z",
	action: "https://wristband-shop.qorpera.com/__qorpera/member",
});
/** The pass as the cloud answers it (V1, 20260930774000). */
const SCHEMA = "qorpera.site-member-pass/v1";
const raw = (n = 0) => ({ schema: SCHEMA, ...pass(n) });

const answer = (columns: string[], rows: unknown[][], etag = "e1"): CloudMemberDataAnswer => ({
	columns,
	rows,
	more: false,
	etag: etag.padEnd(16, "0"),
	asOf: "2026-11-15T10:00:00.000Z",
});
const now = (here: number, visits: number, etag = "n1") =>
	answer(["site", "here_now", "views_today", "visits_today"], [["wristband-shop", here, visits * 2, visits]], etag);
const hours = (visits: number[]) =>
	answer(
		["site", "hour", "hour_local", "views", "visits"],
		visits.map((value, index) => [
			"wristband-shop",
			`2026-11-14T${String(10 + index).padStart(2, "0")}:00:00Z`,
			"x",
			value * 2,
			value,
		]),
	);
const pages = (rows: [string, number][]) =>
	answer(
		["site", "path", "views", "visits"],
		rows.map(([path, views]) => ["wristband-shop", path, views, 1]),
	);

/** Each pass the view handed the door in its frame, and the origin it was handed to. */
const posted: { message: Record<string, unknown>; origin: string }[] = [];
const listened = new WeakSet<Window>();
let visibility: DocumentVisibilityState = "visible";
beforeEach(() => {
	posted.length = 0;
	setLanguagePreference("en");
	visibility = "visible";
	Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
/** The door in the frame says the site's page loaded, as public/site-door/door.js does. */
function shown(source: Window | null = frame().contentWindow, origin = location.origin): void {
	const event = new MessageEvent("message", { data: { type: SITE_DOOR_SHOWN }, origin });
	Object.defineProperty(event, "source", { value: source });
	window.dispatchEvent(event);
}
/** The door in the frame says it is ready (from `source`, at `origin`), as public/site-door/door.js does. */
function door(source: Window | null = frame().contentWindow, origin = location.origin): void {
	// The frame's window as it is now (setting its address may make a new one): what the view hands it is kept.
	const now = frame().contentWindow;
	if (now && !listened.has(now)) {
		listened.add(now);
		vi.spyOn(now, "postMessage").mockImplementation(((message: Record<string, unknown>, at: string) => {
			posted.push({ message, origin: at });
		}) as never);
	}
	const event = new MessageEvent("message", { data: { type: SITE_DOOR_READY }, origin });
	Object.defineProperty(event, "source", { value: source });
	window.dispatchEvent(event);
}
/** Each view opened, and its company, put away after each case. */
const opened: (() => void)[] = [];
afterEach(() => {
	for (const close of opened.splice(0)) close();
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** A view over a company whose numbers answer from `answers` (an Error: that question can't be read). */
function open(
	answers: Record<string, CloudMemberDataAnswer | Error> = {},
	extra: Partial<Omit<SiteViewHost, "site">> & { site?: CompanySite | undefined } = {},
) {
	const asked: CloudMemberDataQuestion[] = [];
	const company = new AbortController();
	const numbers = new CompanyNumbers(async (question) => {
		asked.push(question);
		const value = answers[question.question];
		if (!value) throw new Error("not counted");
		if (value instanceof Error) throw value;
		return value;
	}, company.signal);
	const { site: first, ...rest } = extra;
	let site: CompanySite | undefined = "site" in extra ? first : shop;
	let passes = 0;
	const host: SiteViewHost = {
		site: () => site,
		pass: vi.fn(async () => pass(passes++)),
		numbers,
		timeZone: () => "Europe/Copenhagen",
		...rest,
	};
	const view = new SiteView(host, shop.slug, company.signal);
	opened.push(() => company.abort());
	document.body.append(view.el);

	return {
		view,
		host,
		asked,
		answers,
		company,
		numbers,
		setSite: (next: CompanySite | undefined) => {
			site = next;
			view.update();
		},
	};
}
const text = (selector: string) => document.querySelector(selector)?.textContent;
const frame = () => document.querySelector<HTMLIFrameElement>("iframe.site-frame")!;

describe("a member's pass into a website", () => {
	it("takes only the site's own host, a plain pass, its time and the door on that host; or why there is none", () => {
		expect(parseSiteMemberPass(raw(), shop.slug)).toEqual(pass());
		for (const state of ["off", "gone", "none"] as const)
			expect(parseSiteMemberPass({ schema: SCHEMA, state }, shop.slug)).toEqual({ state });
		expect(parseSiteMemberPass({ schema: SCHEMA, state: "limited", retryAfter: 42 }, shop.slug)).toEqual({
			state: "limited",
			retryAfter: 42,
		});
		const next = "https://wristband-shop--next.qorpera.com/__qorpera/member";
		for (const bad of [
			{ ...raw(), host: "wristband-shop--next.qorpera.com", action: next },
			{ ...raw(), host: "other-shop.qorpera.com", action: "https://other-shop.qorpera.com/__qorpera/member" },
			{ ...raw(), host: "sites.qorpera.com" },
			{ ...raw(), host: "wristband-shop.qorpera.com.evil.example" },
			{ ...raw(), host: "wristband-shop.qorpera.com:8443" },
			{ ...raw(), action: "https://other-shop.qorpera.com/__qorpera/member" },
			{ ...raw(), action: "https://wristband-shop.qorpera.com/elsewhere" },
			{ ...raw(), pass: "short" },
			{ ...raw(), pass: `${PASS}A` },
			{ ...raw(), pass: `${PASS.slice(0, 40)}?x=` },
			{ ...raw(), expiresAt: "soon" },
			{ ...raw(), extra: true },
			{ ...raw(), schema: "qorpera.site-member-pass/v2" },
			{ schema: SCHEMA, state: "off", host: "wristband-shop.qorpera.com" },
			{ schema: SCHEMA, state: "limited" },
			{ schema: SCHEMA, state: "limited", retryAfter: -1 },
			{ schema: SCHEMA, state: "closed" },
			pass(),
			null,
		])
			expect(() => parseSiteMemberPass(bad, shop.slug)).toThrow("Invalid site pass.");
	});

	it("asks the cloud for the site by its id, as the member", async () => {
		const rpc = vi.fn(async () => raw());
		const sites = createWebSites({ rpc } as unknown as Cloud, { profileId: id(3) });
		expect(await sites.memberPass(shop)).toEqual(pass());
		expect(rpc).toHaveBeenCalledWith("qorpera_site_member_pass", { p_site: shop.id });
		await expect(sites.memberPass({ id: "x", slug: shop.slug })).rejects.toThrow("Invalid site.");
	});
});

describe("the site's view", () => {
	it("opens the real site in a sandboxed frame through the door, which posts a fresh pass, never in an address", async () => {
		const { host } = open();
		await settle();
		expect(host.pass).toHaveBeenCalledTimes(1);
		// The frame opens the door, a page of this app's own; the pass is never in an address.
		expect(frame().getAttribute("src")).toBe(SITE_DOOR_URL);
		expect(posted).toEqual([]);
		// Another window's word, or one from another origin, is no door's.
		door(window);
		door(frame().contentWindow, "https://wristband-shop.qorpera.com");
		expect(posted).toEqual([]);
		// The door is ready: it is handed the pass and the site's name, once, for this app's origin only.
		door();
		expect(posted).toEqual([
			{
				message: {
					type: SITE_DOOR_PASS,
					action: "https://wristband-shop.qorpera.com/__qorpera/member",
					pass: pass(0).pass,
					title: "Wristband shop",
				},
				origin: location.origin,
			},
		]);
		door();
		expect(posted).toHaveLength(1);
		expect(document.querySelector("form")).toBeNull();
		// Its own origin and scripts, never this app's page.
		expect(frame().getAttribute("sandbox")?.split(" ").sort()).toEqual(
			["allow-forms", "allow-popups", "allow-popups-to-escape-sandbox", "allow-same-origin", "allow-scripts"].sort(),
		);
		expect(frame().getAttribute("sandbox")).not.toContain("top-navigation");
		expect(frame().title).toBe("Wristband shop");
		// The address above it and a link out to the site in a new tab.
		expect(text(".site-address")).toBe("wristband-shop.qorpera.com");
		const out = document.querySelector<HTMLAnchorElement>("a.site-tool")!;
		expect(out.getAttribute("href")).toBe(shop.url);
		expect(out.target).toBe("_blank");
		expect(out.rel).toBe("noopener noreferrer");
		expect(out.getAttribute("aria-label")).toBe("Open in a new tab");
		// The window breathes until the site's answer loads, then shows it.
		const glass = document.querySelector(".site-glass")!;
		expect(glass.classList.contains("is-opening")).toBe(true);
		// The frame loading is only the door; another window's or origin's word is no door's.
		frame().dispatchEvent(new Event("load"));
		shown(window);
		shown(frame().contentWindow, "https://wristband-shop.qorpera.com");
		expect(glass.classList.contains("is-shown")).toBe(false);
		// The door says the site's page loaded.
		shown();
		expect(glass.classList.contains("is-shown")).toBe(true);
		expect(glass.classList.contains("is-opening")).toBe(false);
	});

	it("opens it again with a new pass on Reload", async () => {
		const { host } = open();
		await settle();
		door();
		document.querySelector<HTMLButtonElement>("button.site-tool")!.click();
		await settle();
		door();
		expect(host.pass).toHaveBeenCalledTimes(2);
		expect(posted.map((handed) => handed.message.pass)).toEqual([pass(0).pass, pass(1).pass]);
	});

	it("says quietly when the site can't be shown, with the way out to it", async () => {
		open(
			{},
			{ pass: vi.fn(async () => Promise.reject(new CloudRpcError("x", { message: "no", code: "PGRST202" }, 404))) },
		);
		await settle();
		expect(posted).toEqual([]);
		const cover = document.querySelector<HTMLElement>(".site-cover")!;
		expect(cover.hidden).toBe(false);
		expect(text(".site-cover-words")).toBe("This website can't be shown here right now.");
		const link = cover.querySelector<HTMLAnchorElement>("a")!;
		expect(link.hidden).toBe(false);
		expect(link.getAttribute("href")).toBe(shop.url);
		expect(link.target).toBe("_blank");
		// Nothing technical is named.
		expect(cover.textContent).not.toMatch(/pass|host|frame/i);
	});

	it("says in plain words why a site can't be opened now", async () => {
		const cases: [SiteMemberPass, string, boolean][] = [
			[{ state: "off" }, "This website can't be shown here right now.", true],
			[{ state: "gone" }, "This website was taken offline.", false],
			[{ state: "none" }, "This website isn't live yet.", false],
			[{ state: "limited", retryAfter: 30 }, "Try again in a moment.", true],
		];
		for (const [answer, words, linked] of cases) {
			document.body.replaceChildren();
			open({}, { pass: vi.fn(async () => answer) });
			await settle();
			expect(frame().getAttribute("src")).toBeNull();
			expect(document.querySelector<HTMLElement>(".site-cover")!.hidden).toBe(false);
			expect(text(".site-cover-words")).toBe(words);
			expect(document.querySelector<HTMLAnchorElement>(".site-cover a")!.hidden).toBe(!linked);
			expect(document.querySelector(".site-cover")!.textContent).not.toMatch(/\b(off|gone|none|limited)\b/);
		}
	});

	it("keeps the site showing when a Reload finds no pass for a while, and says so when it was taken down", async () => {
		const answers: SiteMemberPass[] = [pass(0), { state: "limited", retryAfter: 5 }, { state: "gone" }];
		open({}, { pass: vi.fn(async () => answers.shift()!) });
		await settle();
		door();
		shown();
		const reload = document.querySelector<HTMLButtonElement>("button.site-tool")!;
		reload.click();
		await settle();
		expect(document.querySelector<HTMLElement>(".site-cover")!.hidden).toBe(true);
		reload.click();
		await settle();
		expect(document.querySelector<HTMLElement>(".site-cover")!.hidden).toBe(false);
		expect(text(".site-cover-words")).toBe("This website was taken offline.");
	});

	it("keeps the site showing, on purpose, when a page picked finds no pass for a while", async () => {
		const answers: SiteMemberPass[] = [pass(0), { state: "limited", retryAfter: 5 }];
		const { host } = open(
			{ "site-pages": pages([["shop/index.html", 4]]) },
			{ pass: vi.fn(async () => answers.shift()!) },
		);
		await settle();
		door();
		shown();
		const src = frame().getAttribute("src");
		document.querySelector<HTMLButtonElement>(".site-top")!.click();
		await settle();
		// No pass: the page stays as it is (the app can't move the frame to the site itself), nothing covers it.
		expect(host.pass).toHaveBeenCalledTimes(2);
		expect(frame().getAttribute("src")).toBe(src);
		expect(posted).toHaveLength(1);
		expect(document.querySelector<HTMLElement>(".site-cover")!.hidden).toBe(true);
		expect(document.querySelector(".site-glass")!.classList.contains("is-shown")).toBe(true);
	});

	it("shows the old link's address while sites have no hosts of their own", async () => {
		open({}, { site: { ...shop, url: "https://sites.qorpera.com/wristband-shop/" } });
		expect(text(".site-address")).toBe("sites.qorpera.com/wristband-shop");
		expect(shownAddress("https://wristband-shop.qorpera.com/")).toBe("wristband-shop.qorpera.com");
	});

	it("says so when the site is no longer live, and asks for no pass after that", async () => {
		const { host, setSite } = open();
		await settle();
		setSite(undefined);
		expect(text(".site-cover-words")).toBe("This website isn't live any more.");
		expect(document.querySelector<HTMLAnchorElement>(".site-cover a")!.hidden).toBe(true);
		expect(document.querySelector<HTMLButtonElement>("button.site-tool")!.disabled).toBe(true);
		expect(document.querySelector<HTMLAnchorElement>("a.site-tool")!.hidden).toBe(true);
		expect(host.pass).toHaveBeenCalledTimes(1);
		// Put back up, it opens anew.
		setSite(shop);
		await settle();
		door();
		expect(host.pass).toHaveBeenCalledTimes(2);
		expect(posted).toHaveLength(1);
		expect(document.querySelector<HTMLElement>(".site-cover")!.hidden).toBe(true);
		expect(document.querySelector<HTMLButtonElement>("button.site-tool")!.disabled).toBe(false);
	});

	it("shows the people here now, today's visits, the last 24 hours and today's pages", async () => {
		const day = Array.from({ length: 30 }, (_, index) => (index === 29 ? 9 : index % 4));
		const { asked } = open({
			"site-now": now(14, 86),
			"site-hours": hours(day),
			"site-pages": pages([
				["index.html", 61],
				["shop/index.html", 30],
				["about.html", 9],
			]),
		});
		await settle();
		expect(text(".site-now-number")).toBe("14");
		expect(text(".site-now-label")).toBe("people here now");
		expect(document.querySelector(".site-view")!.classList.contains("has-people")).toBe(true);
		expect(text(".site-today")).toBe("86 visits today");
		// One line over the last 24 hours, with its soft field under it.
		const line = document.querySelector(".site-curve-line")!.getAttribute("d")!;
		expect(line.match(/C/g)).toHaveLength(23);
		expect(document.querySelector(".site-curve-area")).not.toBeNull();
		expect(document.querySelector(".site-curve")!.getAttribute("aria-label")).toBe(
			`Visits, last 24 hours: ${day.slice(-24).reduce((a, b) => a + b, 0)}`,
		);
		// The site's own questions, for this site, today's pages by the company's day.
		expect(asked.map((question) => [question.database, question.question, question.params])).toEqual([
			["qorpera", "site-now", { site: "wristband-shop" }],
			["qorpera", "site-hours", { site: "wristband-shop" }],
			[
				"qorpera",
				"site-pages",
				{
					site: "wristband-shop",
					from: companyToday("Europe/Copenhagen"),
					to: companyToday("Europe/Copenhagen"),
					limit: 3,
				},
			],
		]);
		const list = [...document.querySelectorAll<HTMLButtonElement>(".site-top")];
		expect(
			list.map((item) => [
				item.querySelector(".site-top-name")?.textContent,
				item.querySelector(".site-top-count")?.textContent,
			]),
		).toEqual([
			["Front page", "61"],
			["Shop", "30"],
			["About", "9"],
		]);
		// Its address is only where a press goes, and its tooltip.
		expect(list.map((item) => item.title)).toEqual(["/", "/shop/", "/about.html"]);
		expect(document.querySelector(".site-pages")!.textContent).not.toContain("/");
		expect(list.map((item) => item.style.getPropertyValue("--share"))).toEqual(["1.000", "0.492", "0.148"]);
		// A page moves the frame to it, with a pass of its own.
		list[1]!.click();
		await settle();
		door();
		expect(posted.at(-1)?.message).toEqual({
			type: SITE_DOOR_PASS,
			action: pass(1).action,
			pass: pass(1).pass,
			title: "Wristband shop",
			path: "/shop/",
		});
	});

	it("says one person and one visit in the singular", async () => {
		open({ "site-now": now(1, 1) });
		await settle();
		expect(text(".site-now-number")).toBe("1");
		expect(text(".site-now-label")).toBe("person here now");
		expect(text(".site-today")).toBe("1 visit today");
	});

	it("shows a calm zero before anyone has come: no visits yet, a flat line, no pages", async () => {
		open({ "site-now": now(0, 0), "site-hours": hours(new Array(48).fill(0)), "site-pages": pages([]) });
		await settle();
		expect(text(".site-now-number")).toBe("0");
		expect(document.querySelector(".site-view")!.classList.contains("has-people")).toBe(false);
		expect(text(".site-today")).toBe("No visits yet today");
		expect(document.querySelector(".site-curve")!.classList.contains("is-unknown")).toBe(false);
		expect(document.querySelector<HTMLElement>(".site-pages")!.hidden).toBe(true);
	});

	it("shows numbers it can't read as quiet dashes, never an error", async () => {
		open({ "site-now": new Error("The company's numbers can't be asked on this cloud yet") });
		await settle();
		expect(text(".site-now-number")).toBe("–");
		expect(text(".site-today")).toBe("– visits today");
		expect(document.querySelector(".site-view")!.classList.contains("is-unknown")).toBe(true);
		expect(document.querySelector(".site-curve")!.classList.contains("is-unknown")).toBe(true);
		expect(document.querySelector<HTMLElement>(".site-pages")!.hidden).toBe(true);
		expect(document.querySelector(".site-view")!.textContent).not.toMatch(/error|can't be asked/i);
		// Where no numbers can be asked at all, the same.
		document.body.replaceChildren();
		open({}, { numbers: undefined });
		await settle();
		expect(text(".site-now-number")).toBe("–");
	});

	it("asks the numbers again only while the view is open", async () => {
		vi.useFakeTimers();
		const { view, asked } = open({ "site-now": now(3, 10), "site-hours": hours([1, 2]), "site-pages": pages([]) });
		await vi.advanceTimersByTimeAsync(0);
		expect(asked).toHaveLength(3);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(asked.map((question) => question.question).slice(3)).toEqual(["site-now"]);
		view.dispose();
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(asked).toHaveLength(4);
	});

	it("asks again on the minute a number whose first ask failed, today's pages too", async () => {
		vi.useFakeTimers();
		const { answers, asked } = open({
			"site-now": new Error("Failed to fetch"),
			"site-pages": new Error("Failed to fetch"),
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(text(".site-now-number")).toBe("–");
		answers["site-now"] = now(4, 9);
		answers["site-pages"] = pages([["index.html", 5]]);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(text(".site-now-number")).toBe("4");
		expect(text(".site-today")).toBe("9 visits today");
		expect([...document.querySelectorAll(".site-top-name")].map((name) => name.textContent)).toEqual(["Front page"]);
		// Watched now, they are asked on their own clocks, not once more a minute by the view.
		const before = asked.filter((question) => question.question === "site-pages").length;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(asked.filter((question) => question.question === "site-pages").length - before).toBeLessThanOrEqual(1);
	});

	it("skips 60s failed-number retries while hidden and retries on visibilitychange", async () => {
		vi.useFakeTimers();
		const { answers, asked } = open({
			"site-now": new Error("Failed to fetch"),
			"site-pages": new Error("Failed to fetch"),
		});
		await vi.advanceTimersByTimeAsync(0);
		const afterInitial = asked.length;
		const hiddenSpy = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
		answers["site-now"] = now(4, 9);
		answers["site-pages"] = pages([["index.html", 5]]);
		await vi.advanceTimersByTimeAsync(180_000);
		// WHY: No retry asks should fire while the tab is hidden.
		expect(asked.length).toBe(afterInitial);

		hiddenSpy.mockReturnValue(false);
		document.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(0);
		expect(text(".site-now-number")).toBe("4");
		expect(text(".site-today")).toBe("9 visits today");
	});

	it("follows a new answer of who is here", async () => {
		vi.useFakeTimers();
		const { answers } = open({ "site-now": now(3, 10) });
		await vi.advanceTimersByTimeAsync(0);
		expect(text(".site-now-number")).toBe("3");
		answers["site-now"] = now(5, 12, "n2");
		await vi.advanceTimersByTimeAsync(15_000);
		expect(text(".site-now-number")).toBe("5");
		expect(text(".site-today")).toBe("12 visits today");
	});

	it("moves today's pages to the company's new day when it turns", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-15T22:58:00Z"));
		const { asked } = open({ "site-now": now(0, 0), "site-hours": hours([0]), "site-pages": pages([]) });
		await vi.advanceTimersByTimeAsync(0);
		const days = () =>
			asked.filter((question) => question.question === "site-pages").map((question) => question.params.from);
		expect(days()).toEqual(["2026-11-15"]);
		// Copenhagen's midnight passes: the view looks each minute, and asks for the new day's pages.
		await vi.advanceTimersByTimeAsync(3 * 60_000);
		expect([...new Set(days())]).toEqual(["2026-11-15", "2026-11-16"]);
		// The day before is no longer asked.
		const before = days().filter((day) => day === "2026-11-15").length;
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(days().filter((day) => day === "2026-11-15")).toHaveLength(before);
		expect(days().at(-1)).toBe("2026-11-16");
	});

	it("waits for a slow pass without posting a stale one after the view is put away", async () => {
		const slow = deferred<SiteMemberPass>();
		const { view } = open({}, { pass: () => slow.promise });
		view.dispose();
		slow.resolve(pass());
		await settle();
		expect(posted).toEqual([]);
	});
});

describe("reading the site's numbers", () => {
	it("reads only the site's own rows, and refuses an answer of another shape", () => {
		const both = answer(
			["site", "here_now", "views_today", "visits_today"],
			[
				["other", 9, 9, 9],
				["wristband-shop", 2, 7, 4],
			],
		);
		expect(readNow(both, "wristband-shop")).toEqual({ here: 2, visits: 4 });
		expect(readNow(answer(["site", "here"], [["wristband-shop", 2]]), "wristband-shop")).toBeUndefined();
		expect(
			readNow(answer(["site", "here_now", "visits_today"], [["wristband-shop", -1, 2]]), "wristband-shop"),
		).toBeUndefined();
		// A bigint may come as text.
		expect(
			readNow(answer(["site", "here_now", "visits_today"], [["wristband-shop", "3", "12"]]), "wristband-shop"),
		).toEqual({
			here: 3,
			visits: 12,
		});
		expect(readHours(hours([1, 2, 3]), "wristband-shop")).toEqual([1, 2, 3]);
		expect(readHours(hours([]), "wristband-shop")).toBeUndefined();
		expect(readPages(pages([["a.html", 0]]), "wristband-shop")).toEqual([]);
	});

	it("names each page as a member reads it, never by its path", () => {
		const front = "Front page";
		expect(pageNames(["/", "/lampen/", "/saadan-virker-den.html", "/Om_os.htm"], front)).toEqual([
			"Front page",
			"Lampen",
			"Saadan virker den",
			"Om os",
		]);
		// Percent-decoded, a nested page by its last segment.
		expect(pageNames(["/k%C3%B8b/", "/shop/hue/bl%C3%A5-hue.html", "/x/%E0%A4%A"], front)).toEqual([
			"Køb",
			"Blå hue",
			"%E0%A4%A",
		]);
		// Two that would read the same take their parent's name first.
		expect(pageNames(["/om-os/kontakt/", "/shop/kontakt.html", "/lampen/"], front)).toEqual([
			"Om os · Kontakt",
			"Shop · Kontakt",
			"Lampen",
		]);
	});

	it("names each page by its address on the site", () => {
		expect(pageAddress("index.html")).toBe("/");
		expect(pageAddress("shop/index.html")).toBe("/shop/");
		expect(pageAddress("shop/hat.html")).toBe("/shop/hat.html");
		for (const bad of ["/index.html", "../x.html", "a b.html", "x\n.html", ""])
			expect(pageAddress(bad)).toBeUndefined();
	});

	it("counts today in the company's own zone, or Copenhagen's when it has none it can use", () => {
		const late = new Date("2026-11-15T23:30:00Z");
		expect(companyToday("Europe/Copenhagen", late)).toBe("2026-11-16");
		expect(companyToday("America/New_York", late)).toBe("2026-11-15");
		expect(companyToday(null, late)).toBe("2026-11-16");
		expect(companyToday("Mars/Olympus", late)).toBe("2026-11-16");
	});
});

describe("the site door", () => {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const headers = readFileSync(resolve(root, "public/_headers"), "utf8");
	const doorPage = readFileSync(resolve(root, "public/site-door/index.html"), "utf8");
	const doorScript = readFileSync(resolve(root, "public/site-door/door.js"), "utf8");
	/** A rule's lines in public/_headers, as Pages reads them. */
	const rule = (path: string) => {
		const lines = headers.split("\n");
		const start = lines.indexOf(path);
		const end = lines.findIndex((line, index) => index > start && /^\S/.test(line) && !line.startsWith("#"));
		return lines
			.slice(start + 1, end < 0 ? undefined : end)
			.filter((line) => !line.startsWith("#"))
			.map((line) => line.trim());
	};

	it("alone sends this site's origin, posts only to a site's pass path, runs only its own script and is framed only here", () => {
		const door = rule("/site-door/*");
		// Pages applies /* first: what it inherits goes before its own.
		expect(door.slice(0, 3)).toEqual(["! Content-Security-Policy", "! X-Frame-Options", "! Referrer-Policy"]);
		expect(door).toContain("Referrer-Policy: strict-origin");
		expect(door).toContain("X-Frame-Options: SAMEORIGIN");
		const policy = door.find((line) => line.startsWith("Content-Security-Policy:"))!;
		const directives = policy
			.slice("Content-Security-Policy:".length)
			.split(";")
			.map((part) => part.trim());
		expect(directives).toEqual([
			"default-src 'none'",
			"script-src 'self'",
			"frame-src https://*.qorpera.com https://*.qorpera.site",
			"base-uri 'none'",
			"form-action https://*.qorpera.com/__qorpera/member https://*.qorpera.site/__qorpera/member",
			"frame-ancestors 'self'",
		]);
		// The app itself keeps sending no referrer, posting only to itself and framing only itself (default-src 'self'): no
		// other frame of it may go to a site's host.
		const app = rule("/*").find((line) => line.startsWith("Content-Security-Policy:"))!;
		expect(rule("/*")).toContain("Referrer-Policy: no-referrer");
		expect(app).toContain("form-action 'self';");
		expect(app).toContain("default-src 'self';");
		expect(app).not.toMatch(/frame-src|child-src|qorpera\.com/);
		// The page: its own script only, and nothing that would take its origin away.
		expect(doorPage).toContain('<script src="./door.js"></script>');
		expect(doorPage).not.toMatch(/<script>|name="referrer"|http-equiv/);
	});

	/** Runs door.js as a frame's script would, under a parent window and an origin of its own. */
	function runDoor(origin = "https://app.qorpera.com") {
		const parent = { postMessage: vi.fn() };
		let listen: ((event: { data: unknown; source: unknown; origin: string }) => void) | undefined;
		const self = {
			parent,
			addEventListener: (_type: string, handler: typeof listen) => {
				listen = handler;
			},
		};
		const submitted: { action: string; target: string; fields: Record<string, string> }[] = [];
		vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function (this: HTMLFormElement) {
			submitted.push({
				action: this.action,
				target: this.target,
				fields: Object.fromEntries([...new FormData(this)].map(([name, value]) => [name, String(value)])),
			});
		});
		new Function("window", "location", "document", doorScript)(self, { origin }, document);
		const say = (data: unknown, from: unknown = parent, at = origin) => listen?.({ data, source: from, origin: at });
		const site = document.querySelector<HTMLIFrameElement>('iframe[name="qorpera-site"]')!;
		return { parent, say, submitted, site };
	}

	it("holds the site's frame, says it is ready, then posts one pass its parent hands it into that frame", () => {
		const { parent, say, submitted, site } = runDoor();
		// The frame the site shows in: the door's own, sandboxed as the door is (a frame keeps its parent's sandbox).
		expect(site.parentElement).toBe(document.body);
		expect(parent.postMessage).toHaveBeenCalledWith({ type: SITE_DOOR_READY }, "https://app.qorpera.com");
		const handed = {
			type: SITE_DOOR_PASS,
			action: pass().action,
			pass: pass().pass,
			path: "/shop/",
			title: "Wristband shop",
		};
		// Not from its parent, not from this origin, or not a pass: nothing.
		say(handed, {});
		say(handed, parent, "https://wristband-shop.qorpera.com");
		say({ ...handed, type: "other" });
		for (const bad of [
			{ action: "https://wristband-shop--next.qorpera.com/__qorpera/member" },
			{ action: "https://evil.example/__qorpera/member" },
			{ action: "http://wristband-shop.qorpera.com/__qorpera/member" },
			{ action: "https://wristband-shop.qorpera.com/elsewhere" },
			{ pass: "short" },
			{ path: "shop/" },
			{ path: 3 },
		])
			say({ ...handed, ...bad });
		expect(submitted).toEqual([]);
		// Its own empty page loading before a pass is no site.
		Object.defineProperty(site, "contentDocument", { configurable: true, get: () => null });
		site.dispatchEvent(new Event("load"));
		expect(parent.postMessage).toHaveBeenCalledTimes(1);
		say(handed);
		expect(submitted).toEqual([
			{ action: pass().action, target: "qorpera-site", fields: { pass: pass().pass, path: "/shop/" } },
		]);
		expect(site.title).toBe("Wristband shop");
		expect(document.querySelector("form")).toBeNull();
		// Once only.
		say(handed);
		expect(submitted).toHaveLength(1);
		// The site's page loaded (another origin: no document the door can see): the parent hears it, at its origin only.
		site.dispatchEvent(new Event("load"));
		expect(parent.postMessage).toHaveBeenLastCalledWith({ type: SITE_DOOR_SHOWN }, "https://app.qorpera.com");
	});

	it("posts a pass without a path to the site's top", () => {
		const { say, submitted } = runDoor();
		say({ type: SITE_DOOR_PASS, action: pass().action, pass: pass().pass });
		expect(submitted).toEqual([{ action: pass().action, target: "qorpera-site", fields: { pass: pass().pass } }]);
	});

	it("accepts isolated preview hosts (--p<8>) and relays Point-to-Change messages only after a pass", () => {
		const { parent, say, submitted, site } = runDoor();
		const previewOrigin = "https://wristband-shop--p12ab34cd.qorpera.com";
		const previewAction = `${previewOrigin}/__qorpera/member`;
		const siteWindow = { postMessage: vi.fn() };
		Object.defineProperty(site, "contentWindow", { configurable: true, get: () => siteWindow });

		for (const badAction of [
			"https://wristband-shop--next.qorpera.com/__qorpera/member",
			"https://wristband-shop--p1234567.qorpera.com/__qorpera/member",
			"https://wristband-shop--p123456789.qorpera.com/__qorpera/member",
			"https://wristband-shop--P12ab34cd.qorpera.com/__qorpera/member",
			"https://preview--p12ab34cd.evil.example/__qorpera/member",
		]) {
			say({ type: SITE_DOOR_PASS, action: badAction, pass: pass().pass });
		}
		expect(submitted).toEqual([]);

		say({ type: "qorpera-inspector-mode", active: true });
		say({ type: "qorpera-inspector-pick", target: { route: "/" } }, siteWindow, previewOrigin);
		expect(siteWindow.postMessage).not.toHaveBeenCalled();
		expect(parent.postMessage).toHaveBeenCalledTimes(1);

		say({ type: SITE_DOOR_PASS, action: previewAction, pass: pass().pass, path: "/pricing" });
		expect(submitted).toEqual([
			{ action: previewAction, target: "qorpera-site", fields: { pass: pass().pass, path: "/pricing" } },
		]);

		say({ type: "qorpera-inspector-mode", active: true }, {}, "https://app.qorpera.com");
		say({ type: "qorpera-inspector-mode", active: true }, parent, previewOrigin);
		expect(siteWindow.postMessage).not.toHaveBeenCalled();

		say({ type: "qorpera-inspector-mode", active: 1 });
		expect(siteWindow.postMessage).toHaveBeenCalledWith(
			{ type: "qorpera-inspector-mode", active: true },
			previewOrigin,
		);
		say({ type: "qorpera-inspector-mode", active: false });
		expect(siteWindow.postMessage).toHaveBeenLastCalledWith(
			{ type: "qorpera-inspector-mode", active: false },
			previewOrigin,
		);

		const picked = { route: "/pricing", selector: "h1", tagName: "H1" };
		say({ type: "qorpera-inspector-pick", target: picked }, {}, previewOrigin);
		say({ type: "qorpera-inspector-pick", target: picked }, siteWindow, "https://other.qorpera.com");
		expect(parent.postMessage).toHaveBeenCalledTimes(1);

		say({ type: "qorpera-inspector-pick", target: picked }, siteWindow, previewOrigin);
		expect(parent.postMessage).toHaveBeenLastCalledWith(
			{ type: "qorpera-inspector-pick", target: picked },
			"https://app.qorpera.com",
		);

		say(
			{
				type: "qorpera:identity-tokens-css",
				css: ":root { --q-color-accent: #6f61cf; }",
				vars: { "--q-color-accent": "#6f61cf" },
			},
			{},
			"https://app.qorpera.com",
		);
		say(
			{
				type: "qorpera:identity-tokens-css",
				css: ":root { --q-color-accent: #6f61cf; }",
				vars: { "--q-color-accent": "#6f61cf" },
			},
			parent,
			previewOrigin,
		);
		expect(siteWindow.postMessage).toHaveBeenCalledTimes(2);

		say({
			type: "qorpera:identity-tokens-css",
			css: ":root { --q-color-accent: #6f61cf; }",
			vars: { "--q-color-accent": "#6f61cf" },
		});
		expect(siteWindow.postMessage).toHaveBeenLastCalledWith(
			{
				type: "qorpera:identity-tokens-css",
				css: ":root { --q-color-accent: #6f61cf; }",
				vars: { "--q-color-accent": "#6f61cf" },
			},
			previewOrigin,
		);
	});

	it("accepts a native qorpera.site own-host member pass action", () => {
		const { say, submitted } = runDoor();
		const action = "https://nordic-shop.qorpera.site/__qorpera/member";
		say({ type: SITE_DOOR_PASS, action, pass: pass().pass, path: "/" });
		expect(submitted).toEqual([{ action, target: "qorpera-site", fields: { pass: pass().pass, path: "/" } }]);
	});
});
