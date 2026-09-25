import { h } from "../../ui/dom.ts";
import {
	type ComposerColorPreference,
	composerColorPreference,
	phrase,
	setComposerColorPreference,
	setThemePreference,
	setUiSizePreference,
	type ThemePreference,
	t,
	themePreference,
	type UiSizePreference,
	uiSizePreference,
	uiText,
} from "../../ui/preferences.ts";

/** Appearance choices are pictures of the result, not words in a menu: a
 * miniature window per theme and a miniature conversation per composer
 * colour. Each group is a native radio group, so keyboard and screen-reader
 * behaviour come for free. */

/** Radios group by name across the whole document, and the standalone
 * account page and the settings dialog can both hold these groups at once. */
let groups = 0;

interface Choice<T extends string> {
	value: T;
	label: string;
	swatch: HTMLElement;
}

function choices<T extends string>(
	base: string,
	label: string,
	items: Choice<T>[],
	current: () => T,
	save: (value: string) => boolean,
	failed: () => void,
): HTMLFieldSetElement {
	const inputs: HTMLInputElement[] = [];
	groups += 1;
	const name = `${base}-${groups}`;
	const group = h(
		"fieldset",
		{ class: "settings-choices", "aria-label": t(label) },
		...items.map((item) => {
			const input = h("input", { type: "radio", name, value: item.value, "aria-label": t(item.label) });
			input.checked = item.value === current();
			input.onchange = () => {
				if (!input.checked) return;
				if (!save(item.value)) {
					for (const other of inputs) other.checked = other.value === current();
					failed();
				}
			};
			inputs.push(input);
			return h(
				"label",
				{ class: "settings-choice" },
				input,
				item.swatch,
				h("span", { class: "settings-choice-label" }, uiText(item.label)),
			);
		}),
	);
	return group;
}

/** A miniature window in the theme's own surfaces: a header with two
 * lines of text and a panel of rows. */
function themeWindow(theme: "light" | "dark"): HTMLElement {
	return h(
		"span",
		{ class: `swatch-window swatch-window-${theme}` },
		h("span", { class: "swatch-bar swatch-bar-title" }),
		h("span", { class: "swatch-bar swatch-bar-sub" }),
		h(
			"span",
			{ class: "swatch-panel" },
			...[0, 1, 2].map(() =>
				h("span", { class: "swatch-row" }, h("i", { class: "swatch-pill" }), h("i", { class: "swatch-line" })),
			),
		),
	);
}

function themeSwatch(theme: ThemePreference): HTMLElement {
	const swatch = h("span", { class: `settings-swatch theme-swatch theme-swatch-${theme}`, "aria-hidden": "true" });
	// The System card is the light window with the dark window over its right half.
	if (theme === "system") swatch.append(themeWindow("light"), themeWindow("dark"));
	else swatch.append(themeWindow(theme));
	return swatch;
}

/** A miniature conversation in the page's current theme: an agent bubble, the
 * member's bubble and the composer's send disc carry the colour. */
function colorSwatch(color: ComposerColorPreference): HTMLElement {
	return h(
		"span",
		{ class: `settings-swatch color-swatch color-swatch-${color}`, "aria-hidden": "true" },
		h(
			"span",
			{ class: "swatch-window" },
			h("span", { class: "swatch-bubble swatch-bubble-agent" }),
			h("span", { class: "swatch-bubble swatch-bubble-member" }),
			h("span", { class: "swatch-composer" }, h("i", { class: "swatch-send" })),
		),
	);
}

export function themeChoices(failed: () => void): HTMLFieldSetElement {
	return choices<ThemePreference>(
		"theme",
		phrase("Theme"),
		[
			{ value: "system", label: phrase("System"), swatch: themeSwatch("system") },
			{ value: "light", label: phrase("Light"), swatch: themeSwatch("light") },
			{ value: "dark", label: phrase("Dark"), swatch: themeSwatch("dark") },
		],
		themePreference,
		setThemePreference,
		failed,
	);
}

export function composerColorChoices(failed: () => void): HTMLFieldSetElement {
	return choices<ComposerColorPreference>(
		"composer-color",
		phrase("Composer color"),
		[
			{ value: "blue", label: phrase("Blue"), swatch: colorSwatch("blue") },
			{ value: "green", label: phrase("Green"), swatch: colorSwatch("green") },
			{ value: "grey", label: phrase("Grey"), swatch: colorSwatch("grey") },
		],
		composerColorPreference,
		setComposerColorPreference,
		failed,
	);
}

export function uiSizeChoices(failed: () => void): HTMLFieldSetElement {
	const group = choices<UiSizePreference>(
		"ui-size",
		phrase("Interface size"),
		[
			{
				value: "small",
				label: phrase("Small"),
				swatch: h("span", { class: "settings-swatch size-swatch size-swatch-small", "aria-hidden": "true" }),
			},
			{
				value: "big",
				label: phrase("Big"),
				swatch: h("span", { class: "settings-swatch size-swatch size-swatch-big", "aria-hidden": "true" }),
			},
		],
		uiSizePreference,
		setUiSizePreference,
		failed,
	);
	group.classList.add("settings-size-choices");
	for (const input of group.querySelectorAll("input")) input.dataset.uiSizePreference = "";
	return group;
}
