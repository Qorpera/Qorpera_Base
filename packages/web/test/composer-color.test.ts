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
	const select = () => container.querySelector<HTMLSelectElement>('select[aria-label="Composer color"]')!;
	return { container, render, select, setState };
}

describe("composer color preference", () => {
	it("offers blue, green and grey in Appearance and remembers changes when settings reopen", () => {
		const view = account();
		expect(view.select()).not.toBeNull();
		expect(view.select().closest("section")?.querySelector("h2")?.textContent).toBe("Appearance");
		expect([...view.select().options].map((option) => option.value)).toEqual(["blue", "green", "grey"]);
		expect(view.select().value).toBe("blue");
		for (const color of ["green", "grey", "blue"]) {
			view.select().value = color;
			view.select().dispatchEvent(new Event("change"));
			expect(localStorage.getItem(storageKey)).toBe(color);
			expect(document.documentElement.dataset.composerColor).toBe(color);
			view.render();
			expect(view.select().value).toBe(color);
		}
		expect(view.setState).not.toHaveBeenCalled();
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
		view.select().value = "grey";
		view.select().dispatchEvent(new Event("change"));
		expect(view.select().value).toBe("green");
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
