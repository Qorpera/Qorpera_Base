// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountApplication } from "../src/app/application.ts";
import { AuthController } from "../src/app/auth.ts";
import { type AccountViewState, renderAccount } from "../src/app/views/account.ts";
import { fmtDate, fmtTime } from "../src/ui/dom.ts";
import {
	languagePreference,
	previousDay,
	setLanguagePreference,
	setTimeZonePreference,
	systemTimeZone,
	timeZonePreference,
} from "../src/ui/preferences.ts";
import { timeZoneCity, timeZoneEntries } from "../src/ui/time-zones.ts";
import { fixture, profileA, session, settle, userA } from "./fixtures.ts";

beforeEach(() => {
	localStorage.clear();
	// "Follow system" in jsdom's en-US, on a device in UTC.
	vi.stubEnv("TZ", "UTC");
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});

afterEach(() => {
	document.body.replaceChildren();
	localStorage.clear();
	document.documentElement.lang = "";
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

function account() {
	const auth = new AuthController(fixture().cloud);
	auth.store.set({ user: userA });
	const container = document.createElement("div");
	document.body.append(container);
	const setState = vi.fn<(next: AccountViewState) => void>();
	const render = () => renderAccount(auth, container, {}, setState);
	render();
	const buttons = () => [...container.querySelectorAll<HTMLButtonElement>(".preference-picker-button")];
	return { container, render, setState, language: () => buttons()[0]!, timeZone: () => buttons()[1]! };
}

/** The accessible name the button's aria-labelledby builds. */
function nameOf(button: HTMLButtonElement): string {
	return button
		.getAttribute("aria-labelledby")!
		.split(" ")
		.map((id) => document.getElementById(id)?.textContent)
		.join(" ");
}

function search(): HTMLInputElement {
	return document.activeElement as HTMLInputElement;
}

function type(text: string) {
	search().value = text;
	search().dispatchEvent(new Event("input"));
}

function key(name: string) {
	search().dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
}

function shown(button: HTMLButtonElement): string[][] {
	const list = document.getElementById(button.getAttribute("aria-controls")!)!;
	return [...list.querySelectorAll<HTMLElement>("[role=option]:not([hidden])")].map((option) => [
		option.querySelector(".preference-picker-label")!.textContent!,
		option.querySelector(".preference-picker-detail")?.textContent ?? "",
	]);
}

function option(button: HTMLButtonElement, label: string): HTMLElement {
	const list = document.getElementById(button.getAttribute("aria-controls")!)!;
	return [...list.querySelectorAll<HTMLElement>("[role=option]")].find(
		(candidate) => candidate.querySelector(".preference-picker-label")?.textContent === label,
	)!;
}

describe("language and time zone settings", () => {
	it("shows both as buttons in one card under Language & region", () => {
		const view = account();
		const group = view.language().closest("section")!;
		expect(group.querySelector("h2")?.textContent).toBe("Language & region");
		expect(group.querySelector(".settings-rows")?.contains(view.timeZone())).toBe(true);
		expect(view.container.querySelector("select[aria-label=Language]")).toBeNull();
		expect(nameOf(view.language())).toBe("Language Follow system");
		expect(nameOf(view.timeZone())).toBe("Time zone Follow system");
		expect(view.language().getAttribute("aria-haspopup")).toBe("listbox");
		expect(view.language().getAttribute("aria-expanded")).toBe("false");
	});

	it("lists each language by its own name with the interface's name beside it, and picks one by search", () => {
		const view = account();
		view.language().click();
		expect(view.language().getAttribute("aria-expanded")).toBe("true");
		expect(search().getAttribute("role")).toBe("combobox");
		expect(search().placeholder).toBe("Search language");
		expect(shown(view.language())).toEqual([
			["Follow system", ""],
			["Dansk", "Danish"],
			["English", "English"],
		]);
		const follow = option(view.language(), "Follow system");
		expect(follow.getAttribute("aria-selected")).toBe("true");
		expect(follow.querySelector(".icon")).not.toBeNull();
		expect(option(view.language(), "Dansk").querySelector(".icon")).toBeNull();
		type("danish");
		expect(shown(view.language())).toEqual([["Dansk", "Danish"]]);
		key("Enter");
		expect(languagePreference()).toBe("da");
		expect(document.documentElement.lang).toBe("da");
		expect(view.language().getAttribute("aria-expanded")).toBe("false");
		expect(document.activeElement).toBe(view.language());
		expect(nameOf(view.language())).toBe("Sprog Dansk");
		expect(nameOf(view.timeZone())).toBe("Tidszone Følg systemet");
		view.language().click();
		expect(search().placeholder).toBe("Søg efter sprog");
		expect(shown(view.language())).toEqual([
			["Følg systemet", ""],
			["Dansk", "Dansk"],
			["English", "Engelsk"],
		]);
		expect(option(view.language(), "Dansk").getAttribute("aria-selected")).toBe("true");
		option(view.language(), "Følg systemet").click();
		expect(languagePreference()).toBe("system");
		expect(view.setState).not.toHaveBeenCalled();
	});

	it("keeps Escape inside the list, so Settings stays open", () => {
		const view = account();
		const settingsKeys = vi.fn();
		document.addEventListener("keydown", settingsKeys);
		try {
			view.language().click();
			key("Escape");
			expect(view.language().getAttribute("aria-expanded")).toBe("false");
			expect(document.activeElement).toBe(view.language());
			expect(settingsKeys).not.toHaveBeenCalled();
			// Arrow keys on the button open the list, as they open a native select.
			view.language().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true }));
			expect(view.language().getAttribute("aria-expanded")).toBe("true");
		} finally {
			document.removeEventListener("keydown", settingsKeys);
		}
	});

	it("filters, says when nothing matches, moves with the arrow keys and closes on a click elsewhere", () => {
		const view = account();
		view.timeZone().click();
		const clear = view.container.querySelector<HTMLButtonElement>(".preference-picker-clear")!;
		const empty = view.container.querySelector<HTMLElement>(".preference-picker-empty")!;
		expect(clear.getAttribute("aria-label")).toBe("Close");
		type("no such place");
		expect(shown(view.timeZone())).toEqual([]);
		expect(empty.hidden).toBe(false);
		expect(empty.textContent).toBe("No matches");
		expect(clear.getAttribute("aria-label")).toBe("Clear search");
		clear.click();
		expect(search().value).toBe("");
		expect(empty.hidden).toBe(true);
		expect(shown(view.timeZone()).length).toBeGreaterThan(100);
		type("europe");
		const first = search().getAttribute("aria-activedescendant");
		key("ArrowDown");
		const second = search().getAttribute("aria-activedescendant");
		expect(second).not.toBe(first);
		expect(document.getElementById(second!)?.classList.contains("is-active")).toBe(true);
		expect(document.getElementById(first!)?.classList.contains("is-active")).toBe(false);
		key("ArrowUp");
		expect(search().getAttribute("aria-activedescendant")).toBe(first);
		document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		expect(view.timeZone().getAttribute("aria-expanded")).toBe("false");
		expect(view.container.querySelector("[role=option]")).toBeNull();
		clear.click();
		expect(view.timeZone().getAttribute("aria-expanded")).toBe("false");
	});

	it("finds a zone by city, region or zone name, stores it and shows it on the button", () => {
		const view = account();
		const changes = vi.fn();
		window.addEventListener("qorpera-time-zone-change", changes);
		try {
			view.timeZone().click();
			expect(shown(view.timeZone())[0]).toEqual(["Follow system", timeZoneCity(systemTimeZone())]);
			type("copenhagen");
			expect(shown(view.timeZone())).toEqual([["Copenhagen", expect.stringMatching(/^GMT\+[12]$/)]]);
			type("central european");
			expect(shown(view.timeZone()).map(([city]) => city)).toContain("Copenhagen");
			type("europe par");
			expect(shown(view.timeZone())).toEqual([["Paris", expect.stringMatching(/^GMT\+[12]$/)]]);
			// Old spellings the zone names keep are shown and found by today's name.
			type("kyiv");
			expect(shown(view.timeZone())).toEqual([["Kyiv", expect.stringMatching(/^GMT\+[23]$/)]]);
			type("india standard");
			expect(shown(view.timeZone()).map(([city]) => city)).toContain("Kolkata");
			type("copenhagen");
			option(view.timeZone(), "Copenhagen").click();
			expect(timeZonePreference()).toBe("Europe/Copenhagen");
			expect(localStorage.getItem("qorpera.web.time-zone")).toBe("Europe/Copenhagen");
			expect(changes).toHaveBeenCalledTimes(1);
			expect(nameOf(view.timeZone())).toBe("Time zone Copenhagen");
			view.render();
			expect(nameOf(view.timeZone())).toBe("Time zone Copenhagen");
			view.timeZone().click();
			expect(option(view.timeZone(), "Copenhagen").getAttribute("aria-selected")).toBe("true");
			expect(option(view.timeZone(), "Follow system").getAttribute("aria-selected")).toBe("false");
			// Picking the current value again changes nothing.
			option(view.timeZone(), "Copenhagen").click();
			expect(changes).toHaveBeenCalledTimes(1);
		} finally {
			window.removeEventListener("qorpera-time-zone-change", changes);
		}
	});

	it("keeps one highlighted row through filtering, and Enter picks the one it shows", () => {
		const view = account();
		view.language().click();
		const highlighted = () => [...document.querySelectorAll(".is-active")].map((row) => row.textContent);
		const described = () => document.getElementById(search().getAttribute("aria-activedescendant")!)?.textContent;
		type("dan");
		type("");
		expect(highlighted()).toEqual(["Follow system"]);
		expect(described()).toBe("Follow system");
		type("e");
		expect(shown(view.language()).map(([label]) => label)).toEqual(["Follow system", "English"]);
		option(view.language(), "English").dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
		expect(highlighted()).toEqual(["EnglishEnglish"]);
		type("");
		type("eng");
		expect(highlighted()).toEqual(["EnglishEnglish"]);
		expect(described()).toBe("EnglishEnglish");
		key("ArrowUp");
		expect(highlighted()).toEqual(["EnglishEnglish"]);
		key("Enter");
		expect(languagePreference()).toBe("en");
	});

	it("matches an offset as a whole number", () => {
		const view = account();
		view.timeZone().click();
		type("gmt+1");
		const offsets = shown(view.timeZone()).map(([, offset]) => offset);
		expect(offsets.length).toBeGreaterThan(0);
		expect(new Set(offsets)).toEqual(new Set(["GMT+1"]));
		type("gmt+10");
		expect(new Set(shown(view.timeZone()).map(([, offset]) => offset))).toEqual(new Set(["GMT+10"]));
	});

	it("opens the list from the row's name, and keeps an open list and its focus when the panel redraws", () => {
		const view = account();
		view.timeZone().closest(".settings-preference-row")!.querySelector("label")!.click();
		expect(view.timeZone().getAttribute("aria-expanded")).toBe("true");
		type("cop");
		const field = search();
		view.render();
		expect(view.timeZone().getAttribute("aria-expanded")).toBe("true");
		expect(document.activeElement).toBe(field);
		expect(field.value).toBe("cop");
		expect(view.container.querySelectorAll(".preference-picker-popover:not([hidden])")).toHaveLength(1);
	});

	it("reports a zone the browser cannot store", () => {
		const view = account();
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("Blocked");
		});
		view.timeZone().click();
		type("tokyo");
		key("Enter");
		expect(view.setState).toHaveBeenCalledWith({ error: "Your browser could not save the time zone preference." });
		expect(timeZonePreference()).toBe("system");
	});
});

describe("time zone preference", () => {
	it("accepts only zones the browser knows and falls back to the device", () => {
		expect(setTimeZonePreference("Mars/Olympus_Mons")).toBe(false);
		expect(timeZonePreference()).toBe("system");
		localStorage.setItem("qorpera.web.time-zone", "Mars/Olympus_Mons");
		expect(timeZonePreference()).toBe("system");
		expect(setTimeZonePreference("America/Argentina/Ushuaia")).toBe(true);
		expect(timeZonePreference()).toBe("America/Argentina/Ushuaia");
	});

	it("formats list and card times in the chosen zone", () => {
		vi.stubEnv("TZ", "UTC");
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-21T01:00:00Z"));
		const late = "2026-09-20T22:30:00Z";
		expect(fmtTime(late)).toMatch(/Sep 20, 10:30/);
		expect(setTimeZonePreference("Asia/Tokyo")).toBe(true);
		expect(fmtTime(late)).toMatch(/^07:30/);
		expect(fmtDate(late)).toBe("Sep 21, 2026");
		expect(setTimeZonePreference("America/New_York")).toBe(true);
		expect(fmtTime(late)).toMatch(/^06:30/);
		expect(fmtTime("2025-09-20T12:00:00Z")).toMatch(/Sep 20, 2025, 08:00/);
	});

	it("counts back calendar days across months, years and leap days", () => {
		expect(previousDay("2027-01-01")).toBe("2026-12-31");
		expect(previousDay("2026-03-01")).toBe("2026-02-28");
		expect(previousDay("2028-03-01")).toBe("2028-02-29");
	});

	it("names zones by city and orders them west to east", () => {
		expect(timeZoneCity("Europe/Copenhagen")).toBe("Copenhagen");
		expect(timeZoneCity("America/Indiana/Tell_City")).toBe("Tell City, Indiana");
		expect(timeZoneCity("UTC")).toBe("UTC");
		expect(timeZoneCity("Asia/Calcutta")).toBe("Kolkata");
		// POSIX signs are the other way round: Etc/GMT-2 is two hours ahead.
		expect(timeZoneCity("Etc/GMT-2")).toBe("GMT+2");
		expect(timeZoneCity("Etc/GMT+5")).toBe("GMT-5");
		expect(timeZoneCity("Etc/GMT+0")).toBe("UTC");
		expect(timeZoneCity("Etc/UTC")).toBe("UTC");
		const entries = timeZoneEntries("en", ["Asia/Kolkata"], new Date("2026-01-15T12:00:00Z"));
		expect(entries.map((entry) => entry.id)).toEqual(expect.arrayContaining(["UTC", "Asia/Kolkata"]));
		expect(entries.find((entry) => entry.id === "UTC")?.offset).toBe("GMT");
		// Another included zone reuses the built list instead of formatting every zone again.
		const copenhagen = entries.find((entry) => entry.id === "Europe/Copenhagen");
		expect(
			timeZoneEntries("en", ["Etc/GMT-2"], new Date("2026-01-15T12:00:00Z")).find(
				(entry) => entry.id === "Europe/Copenhagen",
			),
		).toBe(copenhagen);
		expect(entries.find((entry) => entry.id === "Asia/Kolkata")?.offset).toBe("GMT+5:30");
		expect(entries.find((entry) => entry.id === "Europe/Copenhagen")).toMatchObject({
			offset: "GMT+1",
			names: ["Central European Time"],
		});
		const minutes = entries.map((entry) => entry.minutes);
		expect(minutes).toEqual([...minutes].sort((a, b) => a - b));
		expect(
			timeZoneEntries("da", [], new Date("2026-07-15T12:00:00Z")).find((entry) => entry.id === "Europe/Copenhagen"),
		).toMatchObject({
			offset: "GMT+2",
			names: ["Central European Time", expect.stringMatching(/^Centraleuropæisk/)],
		});
	});
});

describe("changing the time zone with a conversation open", () => {
	afterEach(() => {
		history.replaceState(null, "", "/");
	});

	it("redraws the screens in the new zone and keeps the draft", async () => {
		vi.useFakeTimers();
		history.replaceState(null, "", `/#/c/${profileA.profileId}/chat/${session.sessionId}`);
		const f = fixture();
		const root = document.createElement("div");
		document.body.append(root);
		const dispose = mountApplication(root, f.cloud, f.api);
		try {
			const draw = async () => {
				await settle();
				await vi.advanceTimersByTimeAsync(60);
			};
			await draw();
			const composer = root.querySelector<HTMLTextAreaElement>("textarea.composer-input")!;
			composer.value = "Half a thought";
			composer.dispatchEvent(new Event("input"));
			expect(setTimeZonePreference("Asia/Tokyo")).toBe(true);
			await draw();
			const redrawn = root.querySelector<HTMLTextAreaElement>("textarea.composer-input")!;
			expect(redrawn).not.toBe(composer);
			expect(redrawn.value).toBe("Half a thought");
		} finally {
			dispose();
		}
	});

	it("redraws in the new language in place, keeps the draft, and reopens Settings where it was", async () => {
		vi.useFakeTimers();
		history.replaceState(null, "", `/#/c/${profileA.profileId}/chat/${session.sessionId}`);
		const f = fixture();
		const root = document.createElement("div");
		document.body.append(root);
		const dispose = mountApplication(root, f.cloud, f.api);
		try {
			const draw = async () => {
				await settle();
				await vi.advanceTimersByTimeAsync(60);
			};
			await draw();
			const composer = root.querySelector<HTMLTextAreaElement>("textarea.composer-input")!;
			expect(composer.placeholder).toBe("Message…");
			composer.value = "Half a thought";
			composer.dispatchEvent(new Event("input"));
			root.querySelector<HTMLButtonElement>(".account-trigger")!.click();
			root.querySelector<HTMLButtonElement>('[data-account-action="settings"]')!.click();
			expect(setLanguagePreference("da")).toBe(true);
			await draw();
			const redrawn = root.querySelector<HTMLTextAreaElement>("textarea.composer-input")!;
			expect(redrawn.placeholder).toBe("Besked…");
			expect(redrawn.value).toBe("Half a thought");
			expect(root.querySelectorAll(".settings-dialog")).toHaveLength(1);
			expect(root.querySelector("#settings-content h1")?.textContent).toBe("Generelt");
			expect(document.activeElement).toBe(root.querySelector(".preference-picker-button"));
			expect(root.querySelector(".rail")?.getAttribute("aria-label")).toBe("Virksomhedsnavigation");
			// The rail keeps its search field across redraws; its words follow the language.
			expect(root.querySelector<HTMLInputElement>(".rail-search input")?.placeholder).toBe("Søg efter agenter");
		} finally {
			dispose();
		}
	});
});
