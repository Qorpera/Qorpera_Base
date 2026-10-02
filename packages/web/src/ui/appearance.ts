/* Appearance preferences: theme, composer colour and interface size. Kept
 * apart from preferences.ts, which carries the Danish dictionary, because
 * the head script (theme.ts) runs this before the first paint and must stay
 * small. Browser presentation only; no account or company state. */
import { reducedMotion } from "./motion.ts";

export type ThemePreference = "system" | "light" | "dark";
export type ComposerColorPreference = "blue" | "green" | "grey";
export type UiSizePreference = "big" | "small";
const THEME_KEY = "qorpera.web.theme";
const COMPOSER_COLOR_KEY = "qorpera.web.composer-color";
const UI_SIZE_KEY = "qorpera.web.ui-size";
const SYSTEM_DARK = "(prefers-color-scheme: dark)";

export function composerColorPreference(): ComposerColorPreference {
	try {
		const value = localStorage.getItem(COMPOSER_COLOR_KEY);
		return value === "green" || value === "grey" ? value : "blue";
	} catch {
		return "blue";
	}
}

export function applyComposerColor(): void {
	document.documentElement.dataset.composerColor = composerColorPreference();
}

export function setComposerColorPreference(value: string): boolean {
	if (value !== "blue" && value !== "green" && value !== "grey") return false;
	try {
		localStorage.setItem(COMPOSER_COLOR_KEY, value);
	} catch {
		return false;
	}
	reveal(document.documentElement.dataset.composerColor !== value, applyComposerColor);
	return true;
}

export function themePreference(): ThemePreference {
	try {
		const value = localStorage.getItem(THEME_KEY);
		return value === "light" || value === "dark" ? value : "system";
	} catch {
		return "system";
	}
}

export function uiSizePreference(): UiSizePreference {
	try {
		return localStorage.getItem(UI_SIZE_KEY) === "small" ? "small" : "big";
	} catch {
		return "big";
	}
}

/** Restore before paint, then refresh measured layouts just as a window resize does. */
export function applyUiSize(): void {
	const size = uiSizePreference();
	const changed = document.documentElement.dataset.uiSize !== size;
	document.documentElement.dataset.uiSize = size;
	for (const input of document.querySelectorAll<HTMLInputElement>("input[data-ui-size-preference]")) {
		input.checked = input.value === size;
	}
	if (changed) window.dispatchEvent(new Event("resize"));
}

export function setUiSizePreference(value: string): boolean {
	if (value !== "big" && value !== "small") return false;
	try {
		localStorage.setItem(UI_SIZE_KEY, value);
	} catch {
		return false;
	}
	reveal(document.documentElement.dataset.uiSize !== value, applyUiSize);
	return true;
}

/** The theme on screen: the stored choice, else the device's appearance. */
export function presentationTheme(): "light" | "dark" {
	const preference = themePreference();
	return preference === "system" ? (window.matchMedia(SYSTEM_DARK).matches ? "dark" : "light") : preference;
}

/** Runs before the first paint (theme.ts) and again on every change. Colours
 * come from the stylesheet; the figure painter repaints on
 * `qorpera-theme-change`. */
export function applyTheme(): void {
	const theme = presentationTheme();
	if (document.documentElement.dataset.theme === theme) return;
	allAtOnce(() => {
		document.documentElement.dataset.theme = theme;
		window.dispatchEvent(new Event("qorpera-theme-change"));
	});
}

export function setThemePreference(value: string): boolean {
	if (value !== "system" && value !== "light" && value !== "dark") return false;
	try {
		localStorage.setItem(THEME_KEY, value);
	} catch {
		return false;
	}
	reveal(document.documentElement.dataset.theme !== presentationTheme(), applyTheme);
	return true;
}

/** A look changes all at once: no hover or press fade runs into it (styles/motion.css). */
function allAtOnce(change: () => void): void {
	const root = document.documentElement;
	root.dataset.themeChanging = "";
	change();
	const settled = () => delete root.dataset.themeChanging;
	if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => requestAnimationFrame(settled));
	else settled();
}

/** Where the member last pressed: a look they choose washes out from there. */
let lastPress: { x: number; y: number } | undefined;

/** A theme, highlight colour or size chosen in the app spreads over the page from the
 * choice, as a circle (styles/motion.css), where the browser can show the page's two looks
 * at once. */
function reveal(changes: boolean, apply: () => void): void {
	const transition = (document as Document & { startViewTransition?: (update: () => void) => unknown })
		.startViewTransition;
	if (!transition || reducedMotion() || !changes) {
		allAtOnce(apply);
		return;
	}
	const { innerWidth: width, innerHeight: height } = window;
	const { x, y } = lastPress ?? { x: width / 2, y: height / 2 };
	const root = document.documentElement.style;
	root.setProperty("--theme-x", `${x}px`);
	root.setProperty("--theme-y", `${y}px`);
	root.setProperty("--theme-r", `${Math.hypot(Math.max(x, width - x), Math.max(y, height - y))}px`);
	transition.call(document, () => allAtOnce(apply));
}

/** Follow the device's appearance and choices made in other tabs. */
export function watchTheme(): () => void {
	const system = window.matchMedia(SYSTEM_DARK);
	const onStorage = (event: StorageEvent) => {
		if (event.key === THEME_KEY || event.key === null) applyTheme();
		if (event.key === COMPOSER_COLOR_KEY || event.key === null) applyComposerColor();
		if (event.key === UI_SIZE_KEY || event.key === null) applyUiSize();
	};
	applyTheme();
	applyComposerColor();
	applyUiSize();
	const press = (event: PointerEvent) => {
		lastPress = { x: event.clientX, y: event.clientY };
	};
	window.addEventListener("pointerdown", press, { capture: true, passive: true });
	system.addEventListener("change", applyTheme);
	window.addEventListener("storage", onStorage);
	return () => {
		window.removeEventListener("pointerdown", press, { capture: true });
		system.removeEventListener("change", applyTheme);
		window.removeEventListener("storage", onStorage);
	};
}
