// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthController } from "../src/app/auth.ts";
import { type AccountViewState, renderAccount } from "../src/app/views/account.ts";
import {
	applyComposerColor,
	composerColorPreference,
	setComposerColorPreference,
	setThemePreference,
	watchTheme,
} from "../src/ui/preferences.ts";
import { fixture, userA } from "./fixtures.ts";

const storageKey = "qorpera.web.composer-color";
let stopWatching: (() => void) | undefined;

beforeEach(() => {
	localStorage.clear();
	delete document.documentElement.dataset.composerColor;
	delete document.documentElement.dataset.theme;
	vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
});

afterEach(() => {
	stopWatching?.();
	stopWatching = undefined;
	document.body.replaceChildren();
	delete document.documentElement.dataset.composerColor;
	delete document.documentElement.dataset.theme;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	localStorage.clear();
});

function account() {
	const auth = new AuthController(fixture().cloud);
	auth.store.set({ user: userA });
	const container = document.createElement("div");
	document.body.append(container);
	const setState = vi.fn<(next: AccountViewState) => void>();
	const render = () => renderAccount(auth, container, {}, setState);
	render();
	const group = () => container.querySelector<HTMLFieldSetElement>('fieldset[aria-label="Composer color"]')!;
	const radios = () => [...group().querySelectorAll<HTMLInputElement>("input[type=radio]")];
	const checked = () => radios().find((radio) => radio.checked)?.value;
	const choose = (value: string) => {
		const radio = radios().find((item) => item.value === value)!;
		radio.checked = true;
		radio.dispatchEvent(new Event("change"));
	};
	return { container, render, group, radios, checked, choose, setState };
}

describe("composer color preference", () => {
	it("offers blue, green and grey as cards in Appearance and remembers changes when settings reopen", () => {
		const view = account();
		expect(view.group()).not.toBeNull();
		expect(view.group().closest("section")?.querySelector("h2")?.textContent).toBe("Appearance");
		expect(view.radios().map((radio) => radio.value)).toEqual(["blue", "green", "grey"]);
		expect(view.radios().map((radio) => radio.closest("label")?.querySelector(".color-swatch")?.className)).toEqual([
			"settings-swatch color-swatch color-swatch-blue",
			"settings-swatch color-swatch color-swatch-green",
			"settings-swatch color-swatch color-swatch-grey",
		]);
		expect(view.checked()).toBe("blue");
		for (const color of ["green", "grey", "blue"]) {
			view.choose(color);
			expect(localStorage.getItem(storageKey)).toBe(color);
			expect(document.documentElement.dataset.composerColor).toBe(color);
			view.render();
			expect(view.checked()).toBe(color);
		}
		expect(view.setState).not.toHaveBeenCalled();
	});

	it("offers System, Light and Dark as cards, the System card showing both halves", () => {
		const view = account();
		const group = view.container.querySelector<HTMLFieldSetElement>('fieldset[aria-label="Theme"]')!;
		const radios = [...group.querySelectorAll<HTMLInputElement>("input[type=radio]")];
		expect(radios.map((radio) => radio.value)).toEqual(["system", "light", "dark"]);
		expect(radios.find((radio) => radio.checked)?.value).toBe("system");
		expect(
			[...group.querySelectorAll(".theme-swatch-system .swatch-window")].map((window) => window.className),
		).toEqual(["swatch-window swatch-window-light", "swatch-window swatch-window-dark"]);
		expect(group.querySelectorAll(".theme-swatch-dark .swatch-window")).toHaveLength(1);
		const dark = radios.find((radio) => radio.value === "dark")!;
		dark.checked = true;
		dark.dispatchEvent(new Event("change"));
		expect(localStorage.getItem("qorpera.web.theme")).toBe("dark");
		expect(document.documentElement.dataset.theme).toBe("dark");
		view.render();
		expect(
			[...view.container.querySelectorAll<HTMLInputElement>('fieldset[aria-label="Theme"] input')].find(
				(radio) => radio.checked,
			)?.value,
		).toBe("dark");
		expect(view.setState).not.toHaveBeenCalled();
	});

	it("keeps two rendered groups independent, as the account page and the dialog can both show them", () => {
		const first = account();
		const second = account();
		expect(first.radios()[0]!.name).not.toBe(second.radios()[0]!.name);
		second.choose("green");
		expect(first.checked()).toBe("blue");
		expect(second.checked()).toBe("green");
	});

	it("restores saved colors before paint and keeps the color when switching theme", () => {
		expect(composerColorPreference()).toBe("blue");
		applyComposerColor();
		expect(document.documentElement.dataset.composerColor).toBe("blue");
		localStorage.setItem(storageKey, "green");
		applyComposerColor();
		expect(document.documentElement.dataset.composerColor).toBe("green");
		expect(setThemePreference("dark")).toBe(true);
		expect(document.documentElement.dataset.composerColor).toBe("green");
		expect(setThemePreference("light")).toBe(true);
		expect(document.documentElement.dataset.composerColor).toBe("green");
	});

	it("rejects invalid choices and falls back to blue for invalid or inaccessible storage", () => {
		expect(setComposerColorPreference("grey")).toBe(true);
		expect(setComposerColorPreference("purple")).toBe(false);
		expect(composerColorPreference()).toBe("grey");
		expect(document.documentElement.dataset.composerColor).toBe("grey");
		localStorage.setItem(storageKey, "purple");
		expect(composerColorPreference()).toBe("blue");
		applyComposerColor();
		expect(document.documentElement.dataset.composerColor).toBe("blue");
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("Storage blocked");
		});
		expect(composerColorPreference()).toBe("blue");
		expect(() => applyComposerColor()).not.toThrow();
	});

	it("keeps the saved color and resets the settings control when saving fails", () => {
		expect(setComposerColorPreference("green")).toBe(true);
		const view = account();
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("Storage full");
		});
		view.choose("grey");
		expect(view.checked()).toBe("green");
		expect(composerColorPreference()).toBe("green");
		expect(document.documentElement.dataset.composerColor).toBe("green");
		expect(view.setState).toHaveBeenCalledWith({ error: expect.stringMatching(/save.*composer.*color/i) });
	});

	it("follows changes from other tabs, handles cleared storage and removes its listener on cleanup", () => {
		localStorage.setItem(storageKey, "green");
		stopWatching = watchTheme();
		expect(document.documentElement.dataset.composerColor).toBe("green");
		localStorage.setItem(storageKey, "grey");
		window.dispatchEvent(new StorageEvent("storage", { key: storageKey }));
		expect(document.documentElement.dataset.composerColor).toBe("grey");
		localStorage.setItem(storageKey, "green");
		window.dispatchEvent(new StorageEvent("storage", { key: "unrelated.preference" }));
		expect(document.documentElement.dataset.composerColor).toBe("grey");
		localStorage.clear();
		window.dispatchEvent(new StorageEvent("storage", { key: null }));
		expect(document.documentElement.dataset.composerColor).toBe("blue");
		stopWatching();
		stopWatching = undefined;
		localStorage.setItem(storageKey, "grey");
		window.dispatchEvent(new StorageEvent("storage", { key: storageKey }));
		expect(document.documentElement.dataset.composerColor).toBe("blue");
	});
});

describe("General settings", () => {
	it("ends with Companies and offers no cloud endpoint override", () => {
		const view = account();
		expect([...view.container.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual([
			"Account",
			"Appearance",
			"Language & region",
			"Companies",
		]);
		expect(view.container.querySelector("details")).toBeNull();
		expect(view.container.querySelector('input[type="url"], input[type="text"]')).toBeNull();
		expect(view.container.textContent).not.toContain("Cloud endpoint");
	});
});
