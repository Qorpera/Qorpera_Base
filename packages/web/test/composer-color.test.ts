// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthController } from "../src/app/auth.ts";
import { renderAccount } from "../src/app/views/account.ts";
import { renderAppearance } from "../src/app/views/appearance.ts";
import appCss from "../src/styles/app.css?raw";
import settingsCss from "../src/styles/settings.css?raw";
import surfacesCss from "../src/styles/surfaces.css?raw";
import tokensCss from "../src/styles/tokens.css?raw";
import { h } from "../src/ui/dom.ts";
import {
	applyComposerColor,
	composerColorPreference,
	setComposerColorPreference,
	setThemePreference,
	watchTheme,
} from "../src/ui/preferences.ts";
import { RailSelection } from "../src/ui/rail-selection.ts";
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

function appearance() {
	const container = document.createElement("div");
	document.body.append(container);
	const render = () => container.replaceChildren(renderAppearance());
	render();
	const group = () => container.querySelector<HTMLFieldSetElement>('fieldset[aria-label="Composer color"]')!;
	const radios = () => [...group().querySelectorAll<HTMLInputElement>("input[type=radio]")];
	const checked = () => radios().find((radio) => radio.checked)?.value;
	const choose = (value: string) => {
		const radio = radios().find((item) => item.value === value)!;
		radio.checked = true;
		radio.dispatchEvent(new Event("change"));
	};
	return { container, render, group, radios, checked, choose };
}

describe("composer color preference", () => {
	it("offers blue, green and grey as cards in Appearance and remembers changes when settings reopen", () => {
		const view = appearance();
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
		expect(view.container.querySelector("[role=alert]")).toBeNull();
	});

	it("offers System, Light and Dark as cards, the System card showing both halves", () => {
		const view = appearance();
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
		expect(view.container.querySelector("[role=alert]")).toBeNull();
	});

	it("keeps two rendered groups independent", () => {
		const first = appearance();
		const second = appearance();
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
		const view = appearance();
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("Storage full");
		});
		view.choose("grey");
		expect(view.checked()).toBe("green");
		expect(composerColorPreference()).toBe("green");
		expect(document.documentElement.dataset.composerColor).toBe("green");
		expect(view.container.querySelector("[role=alert]")?.textContent).toMatch(/save.*composer.*color/i);
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
	it("holds Account and Language & region", () => {
		const auth = new AuthController(fixture().cloud);
		auth.store.set({ user: userA });
		const view = { container: document.createElement("div") };
		renderAccount(auth, view.container, {}, () => {});
		expect([...view.container.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual([
			"Account",
			"Language & region",
		]);
	});

	it("shows theme, color and size as three card groups named for screen readers", () => {
		const view = appearance();
		const panel = view.group().closest("section")!;
		expect([...panel.querySelectorAll("fieldset")].map((group) => group.getAttribute("aria-label"))).toEqual([
			"Theme",
			"Composer color",
			"Interface size",
		]);
		expect([...panel.querySelectorAll(".settings-preference")].map((row) => row.children.length)).toEqual([1, 1, 1]);
		expect(panel.textContent).toBe("AppearanceSystemLightDarkBlueGreenGreySmallBig");
	});
});

function cssRulesOf(raw: string): CSSStyleRule[] {
	const style = h("style", null, raw.replace(/^@import .*;$/gm, ""));
	document.head.append(style);
	const flatten = (rules: CSSRuleList): CSSStyleRule[] =>
		[...rules].flatMap((rule) =>
			rule instanceof CSSStyleRule ? [rule] : "cssRules" in rule ? flatten(rule.cssRules as CSSRuleList) : [],
		);
	const rules = flatten(style.sheet!.cssRules);
	style.remove();
	return rules;
}

describe("rail selection and grey appearance styles", () => {
	it("replaces dark grey with the soft interface grey in tokens and settings swatch", () => {
		const tokenRules = cssRulesOf(tokensCss);
		const greyRule = tokenRules.find((rule) => rule.selectorText === ':root[data-composer-color="grey"]');
		expect(greyRule?.style.getPropertyValue("--composer-accent").trim()).toBe(
			"color-mix(in srgb, var(--text) 7%, var(--bg))",
		);
		expect(greyRule?.style.getPropertyValue("--composer-on-accent").trim()).toBe("var(--text)");
		expect(greyRule?.style.getPropertyValue("--composer-accent-ink").trim()).toBe("#5b5b5b");

		const darkGreyRule = tokenRules.find(
			(rule) => rule.selectorText === ':root[data-theme="dark"][data-composer-color="grey"]',
		);
		expect(darkGreyRule?.style.getPropertyValue("--composer-accent-ink").trim()).toBe("#989894");

		const settingsRules = cssRulesOf(settingsCss);
		const swatchRule = settingsRules.find((rule) => rule.selectorText === ".color-swatch-grey");
		expect(swatchRule?.style.getPropertyValue("--swatch-accent").trim()).toBe(
			"color-mix(in srgb, var(--text) 7%, transparent)",
		);
	});

	it("styles active rail surfaces and agent rows with the settings selection tokens like the Co-Founder", () => {
		const surfaceRules = cssRulesOf(surfacesCss);
		const activeSurface = surfaceRules.find(
			(rule) => rule.selectorText === ".rail-surface.active, .rail-surface.active:hover",
		);
		expect(activeSurface?.style.background).toBe("var(--rail-selection)");
		expect(activeSurface?.style.color).toBe("var(--rail-selection-text)");

		const activeSurfaceName = surfaceRules.find(
			(rule) => rule.selectorText === ".rail-surface.active .rail-surface-name",
		);
		expect(activeSurfaceName?.style.color).toBe("var(--rail-selection-text)");

		const activeSurfaceSub = surfaceRules.find(
			(rule) =>
				rule.selectorText ===
				".rail-surface.active .rail-surface-sub, .rail-surface.active .rail-surface-crew-more",
		);
		expect(activeSurfaceSub?.style.color).toBe("var(--rail-selection-sub)");

		const activeAgentHub = surfaceRules.find(
			(rule) => rule.selectorText === ".rail-agent-hub-row.active, .rail-agent-hub-row.active:hover",
		);
		expect(activeAgentHub?.style.background).toBe("var(--rail-selection)");
		expect(activeAgentHub?.style.color).toBe("var(--rail-selection-text)");

		const appRules = cssRulesOf(appCss);
		const cofounder = appRules.find(
			(rule) => rule.selectorText === ".cofounder-home.active, .cofounder-home.active:hover",
		);
		expect(cofounder?.style.background).toBe("var(--rail-selection)");
		expect(cofounder?.style.color).toBe("var(--rail-selection-text)");

		const greyRail = appRules.find(
			(rule) =>
				rule.selectorText === ':root[data-composer-color="grey"] :is(.rail, .concepts-side, .rail-drag-ghost)',
		);
		expect(greyRail?.style.getPropertyValue("--rail-selection").trim()).toBe(
			"color-mix(in srgb, var(--text) 7%, var(--rail))",
		);
		expect(greyRail?.style.getPropertyValue("--rail-selection-sub").trim()).toBe("var(--rail-small)");
	});

	it("slides RailSelection from Co-Founder to an active surface row", () => {
		const list = h("div", { class: "rail-scroll" });
		const cofounder = h("a", { class: "cofounder-home active" }, "Co-Founder");
		const surface = h("a", { class: "rail-surface" }, "Identity");
		list.append(cofounder, surface);
		document.body.append(list);

		Object.defineProperty(cofounder, "offsetParent", { value: list });
		Object.defineProperty(surface, "offsetParent", { value: list });
		list.getBoundingClientRect = () => new DOMRect(0, 0, 300, 600);
		cofounder.getBoundingClientRect = () => new DOMRect(10, 20, 260, 72);
		surface.getBoundingClientRect = () => new DOMRect(10, 120, 260, 64);

		const selection = new RailSelection();
		const animate = vi.fn(() => ({ finished: new Promise<void>(() => {}), cancel: vi.fn() }) as unknown as Animation);
		selection.ghost.animate = animate;

		selection.measure(list);
		cofounder.classList.remove("active");
		surface.classList.add("active");
		selection.move(list);

		expect(animate).toHaveBeenCalledOnce();
		expect(surface.classList.contains("selection-arriving")).toBe(true);
		expect(selection.moving).toBe(selection.ghost);
	});
});
