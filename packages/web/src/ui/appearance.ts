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
	// From the press that chose it; chosen from the keyboard, from the focused choice.
	const focused =
		document.activeElement instanceof HTMLElement ? document.activeElement.getBoundingClientRect() : undefined;
	const { x, y } =
		lastPress ??
		(focused?.width
			? { x: focused.left + focused.width / 2, y: focused.top + focused.height / 2 }
			: { x: width / 2, y: height / 2 });
	const root = document.documentElement.style;
	root.setProperty("--theme-x", `${x}px`);
	root.setProperty("--theme-y", `${y}px`);
	root.setProperty("--theme-r", `${Math.hypot(Math.max(x, width - x), Math.max(y, height - y))}px`);
	const shown = transition.call(document, () => allAtOnce(apply)) as
		| { ready?: Promise<unknown>; finished?: Promise<unknown> }
		| undefined;
	// A transition skipped by a quicker second choice rejects these; the look still applies.
	shown?.ready?.catch(() => undefined);
	shown?.finished?.catch(() => undefined);
}

/** Safari on a Mac draws its toolbar in one grey while the window is in front and in a
 * darker one behind; the sidebars take the same two greys so they read as one surface with
 * it (Jonas, 9 Nov 2026; styles/tokens.css). Other browsers, iPads and an installed web app
 * keep the design's own sidebar grey. */
export function safariOnMac(): boolean {
	const agent = navigator.userAgent;
	return (
		/Macintosh/.test(agent) &&
		/Safari\//.test(agent) &&
		!/Chrome|Chromium|CriOS|FxiOS|Firefox|Edg|OPR/.test(agent) &&
		(navigator.maxTouchPoints ?? 0) < 2 &&
		!window.matchMedia("(display-mode: standalone)").matches
	);
}

/** Marks Safari and whether its window is in front. Focus inside an iframe of the page still
 * counts as in front: document.hasFocus() covers nested frames. */
export function applyBrowserChrome(): void {
	const root = document.documentElement;
	if (!safariOnMac()) {
		delete root.dataset.chrome;
		delete root.dataset.windowInactive;
		return;
	}
	root.dataset.chrome = "safari";
	if (document.hasFocus()) delete root.dataset.windowInactive;
	else root.dataset.windowInactive = "";
}

/** Keep the in-front mark current. While focus sits inside an iframe the page gets no blur
 * when the window goes behind, so it looks again every half second until it does. */
function watchBrowserChrome(): () => void {
	applyBrowserChrome();
	if (document.documentElement.dataset.chrome !== "safari") return () => undefined;
	let framePoll: ReturnType<typeof setInterval> | undefined;
	const stopPoll = () => {
		if (framePoll !== undefined) clearInterval(framePoll);
		framePoll = undefined;
	};
	const check = () => {
		applyBrowserChrome();
		if (!document.hasFocus()) stopPoll();
	};
	const onFocus = () => {
		stopPoll();
		applyBrowserChrome();
	};
	const onBlur = () => {
		// Focus moving into a frame blurs the page first; look once it has landed.
		setTimeout(() => {
			applyBrowserChrome();
			if (document.hasFocus() && framePoll === undefined) framePoll = setInterval(check, 500);
		}, 0);
	};
	window.addEventListener("focus", onFocus);
	window.addEventListener("blur", onBlur);
	return () => {
		stopPoll();
		window.removeEventListener("focus", onFocus);
		window.removeEventListener("blur", onBlur);
	};
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
	const key = () => {
		lastPress = undefined;
	};
	window.addEventListener("pointerdown", press, { capture: true, passive: true });
	window.addEventListener("keydown", key, { capture: true, passive: true });
	system.addEventListener("change", applyTheme);
	window.addEventListener("storage", onStorage);
	const stopChrome = watchBrowserChrome();
	return () => {
		stopChrome();
		window.removeEventListener("pointerdown", press, { capture: true });
		window.removeEventListener("keydown", key, { capture: true });
		system.removeEventListener("change", applyTheme);
		window.removeEventListener("storage", onStorage);
	};
}
