// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderAppearance } from "../src/app/views/appearance.ts";
import tokens from "../src/styles/tokens.css?raw";
import { h } from "../src/ui/dom.ts";
import { isPhoneLayout } from "../src/ui/layout.ts";
import { applyUiSize, setUiSizePreference, uiSizePreference, watchTheme } from "../src/ui/preferences.ts";
import { RailLayout } from "../src/ui/rail-layout.ts";
import { uiScale } from "../src/ui/scale.ts";

const key = "qorpera.web.ui-size";
let stop: (() => void) | undefined;
let rail: RailLayout | undefined;
let style: HTMLStyleElement;

beforeEach(() => {
	localStorage.clear();
	delete document.documentElement.dataset.uiSize;
	vi.stubGlobal("innerWidth", 1600);
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: query.startsWith("(max-width:") && window.innerWidth <= Number.parseFloat(query.slice(12)),
		addEventListener() {},
		removeEventListener() {},
	}));
	style = h("style", null, tokens);
	document.head.append(style);
});

afterEach(() => {
	stop?.();
	stop = undefined;
	rail?.dispose();
	rail = undefined;
	style.remove();
	document.body.replaceChildren();
	delete document.documentElement.dataset.uiSize;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	localStorage.clear();
});

function appearance() {
	const container = h("div");
	document.body.append(container);
	container.append(renderAppearance());
	const group = container.querySelector<HTMLFieldSetElement>('fieldset[aria-label="Interface size"]')!;
	const radios = [...group.querySelectorAll<HTMLInputElement>("input[type=radio]")];
	const selected = () => radios.find((input) => input.checked)?.value;
	const choose = (value: string) => {
		radios.find((input) => input.value === value)!.click();
	};
	return { group, radios, selected, choose, container };
}

describe("interface size", () => {
	it("defaults to Big and restores Small with the original scale before paint", () => {
		expect(uiSizePreference()).toBe("big");
		applyUiSize();
		expect(uiScale()).toBe(1.3);
		localStorage.setItem(key, "small");
		applyUiSize();
		expect(uiScale()).toBe(1);
		localStorage.setItem(key, "unexpected");
		applyUiSize();
		expect(uiScale()).toBe(1.3);
		expect(setUiSizePreference("medium")).toBe(false);
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		expect(() => applyUiSize()).not.toThrow();
		expect(uiSizePreference()).toBe("big");
	});

	it("offers both sizes in Appearance, persists changes and synchronizes mounted controls", () => {
		const first = appearance();
		const second = appearance();
		expect(first.group.closest("section")?.querySelector("h2")?.textContent).toBe("Appearance");
		expect(
			first.group.parentElement?.previousElementSibling?.querySelector("fieldset")?.getAttribute("aria-label"),
		).toBe("Composer color");
		expect(first.group.textContent).toBe("SmallBig");
		expect(first.radios.map((input) => input.value)).toEqual(["small", "big"]);
		expect(first.radios[0]!.name).not.toBe(second.radios[0]!.name);
		expect(first.group.querySelectorAll('.settings-swatch[aria-hidden="true"]')).toHaveLength(2);
		expect(first.selected()).toBe("big");
		first.choose("small");
		expect(uiScale()).toBe(1);
		expect(localStorage.getItem(key)).toBe("small");
		expect(second.selected()).toBe("small");
		expect(appearance().selected()).toBe("small");
		second.choose("big");
		expect(first.selected()).toBe("big");
		expect(uiScale()).toBe(1.3);
	});

	it("leaves the saved size and selected control intact if saving fails", () => {
		setUiSizePreference("small");
		const view = appearance();
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("full");
		});
		view.choose("big");
		expect(view.selected()).toBe("small");
		expect(uiScale()).toBe(1);
		expect(view.container.querySelector("[role=alert]")?.textContent).toBe(
			"Your browser could not save the interface size preference.",
		);
	});

	it("follows storage changes and clearing in other tabs, then removes its listener", () => {
		stop = watchTheme();
		const view = appearance();
		localStorage.setItem(key, "small");
		window.dispatchEvent(new StorageEvent("storage", { key }));
		expect(uiScale()).toBe(1);
		expect(view.selected()).toBe("small");
		localStorage.clear();
		window.dispatchEvent(new StorageEvent("storage", { key: null }));
		expect(uiScale()).toBe(1.3);
		stop();
		stop = undefined;
		localStorage.setItem(key, "small");
		window.dispatchEvent(new StorageEvent("storage", { key }));
		expect(uiScale()).toBe(1.3);
	});

	it("refreshes rail geometry and phone layout immediately while keeping a custom rail width", () => {
		applyUiSize();
		const aside = h("aside");
		const frame = h("div", null, aside);
		document.body.append(frame);
		rail = new RailLayout(frame, aside);
		expect(Number.parseFloat(aside.style.getPropertyValue("--rail-width"))).toBeCloseTo(479.7);
		setUiSizePreference("small");
		expect(aside.style.getPropertyValue("--rail-width")).toBe("456px");
		rail.el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
		expect(localStorage.getItem("qorpera.web.rail-width.v4")).toBe("472");
		setUiSizePreference("big");
		expect(Number.parseFloat(aside.style.getPropertyValue("--rail-width"))).toBeCloseTo(613.6);
		setUiSizePreference("small");
		rail.el.dispatchEvent(new MouseEvent("dblclick"));
		expect(localStorage.getItem("qorpera.web.rail-width.v4")).toBeNull();
		setUiSizePreference("big");
		expect(Number.parseFloat(aside.style.getPropertyValue("--rail-width"))).toBeCloseTo(479.7);
		vi.stubGlobal("innerWidth", 900);
		expect(isPhoneLayout()).toBe(true);
		setUiSizePreference("small");
		expect(isPhoneLayout()).toBe(false);
	});
});
