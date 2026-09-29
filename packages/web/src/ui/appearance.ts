/* Appearance preferences: theme, composer colour and interface size. Kept
 * apart from preferences.ts, which carries the Danish dictionary, because
 * the head script (theme.ts) runs this before the first paint and must stay
 * small. Browser presentation only; no account or company state. */
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
	applyComposerColor();
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
	applyUiSize();
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
	document.documentElement.dataset.theme = theme;
	window.dispatchEvent(new Event("qorpera-theme-change"));
}

export function setThemePreference(value: string): boolean {
	if (value !== "system" && value !== "light" && value !== "dark") return false;
	try {
		localStorage.setItem(THEME_KEY, value);
	} catch {
		return false;
	}
	applyTheme();
	return true;
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
	system.addEventListener("change", applyTheme);
	window.addEventListener("storage", onStorage);
	return () => {
		system.removeEventListener("change", applyTheme);
		window.removeEventListener("storage", onStorage);
	};
}
