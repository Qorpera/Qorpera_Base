import { DANISH } from "./danish/index.ts";

export {
	applyComposerColor,
	applyTheme,
	applyUiSize,
	type ComposerColorPreference,
	composerColorPreference,
	presentationTheme,
	setComposerColorPreference,
	setThemePreference,
	setUiSizePreference,
	type ThemePreference,
	themePreference,
	type UiSizePreference,
	uiSizePreference,
	watchTheme,
} from "./appearance.ts";

/** Browser presentation preferences contain no account or company state. */
export type LanguagePreference = "system" | "en" | "da";
const LANGUAGE_KEY = "qorpera.web.language";
const TIME_ZONE_KEY = "qorpera.web.time-zone";

export function languagePreference(): LanguagePreference {
	try {
		const value = localStorage.getItem(LANGUAGE_KEY);
		return value === "en" || value === "da" ? value : "system";
	} catch {
		return "system";
	}
}

export function presentationLocale(): "da" | "en" {
	const preference = languagePreference();
	return preference === "system" ? (navigator.language.toLowerCase().startsWith("da") ? "da" : "en") : preference;
}

type TextValues = Record<string, string | number>;
const missing = new Set<string>();
let taskLocale: "da" | "en" | undefined;

/** The locale, read once per task: a render calls t() hundreds of times.
 * A language change clears it at once (setLanguagePreference). */
function textLocale(): "da" | "en" {
	if (!taskLocale) {
		taskLocale = presentationLocale();
		queueMicrotask(() => {
			taskLocale = undefined;
		});
	}
	return taskLocale;
}

/** Interface text in the chosen language. Only interface text goes through
 * here, never company content (names, messages, file names): that goes in
 * `values`, which fill `{name}` placeholders untranslated. Keep a sentence
 * whole under one key, since Danish word order differs; pick plural keys by
 * count. Call it when rendering, not at module load: a language change
 * reloads the page, but tests switch language in place. */
export function t(source: string, values?: TextValues): string {
	let text = source;
	if (!Object.hasOwn(DANISH, source)) missing.add(source);
	else if (textLocale() === "da") text = DANISH[source]!;
	return values
		? text.replace(/\{(\w+)\}/g, (field, name: string) => (name in values ? String(values[name]) : field))
		: text;
}

/** Marks English interface text kept in a table or passed along before it
 * is drawn with t(): it returns the text unchanged, and lets
 * test/translations.test.ts find the key where it is written. */
export function phrase(source: string): string {
	return source;
}

/** Sources t() was asked for that have no Danish yet (checked after each test file). */
export function untranslated(): string[] {
	return [...missing];
}

/** t() as a span that follows a language change in place. */
export function uiText(source: string, values?: TextValues): HTMLSpanElement {
	const element = document.createElement("span");
	element.dataset.uiText = source;
	if (values) element.dataset.uiValues = JSON.stringify(values);
	element.textContent = t(source, values);
	return element;
}

export function applyLanguage(): void {
	taskLocale = undefined;
	document.documentElement.lang = presentationLocale();
	for (const element of document.querySelectorAll<HTMLElement>("[data-ui-text]")) {
		const values = element.dataset.uiValues ? (JSON.parse(element.dataset.uiValues) as TextValues) : undefined;
		element.textContent = t(element.dataset.uiText!, values);
	}
}

export function setLanguagePreference(value: string): boolean {
	if (value !== "system" && value !== "en" && value !== "da") return false;
	try {
		localStorage.setItem(LANGUAGE_KEY, value);
	} catch {
		return false;
	}
	taskLocale = undefined;
	applyLanguage();
	window.dispatchEvent(new Event("qorpera-language-change"));
	return true;
}

/** The device's zone, as the browser reports it. */
export function systemTimeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

const knownZones = new Set<string>();

function validTimeZone(value: string): boolean {
	if (knownZones.has(value)) return true;
	try {
		new Intl.DateTimeFormat("en", { timeZone: value });
	} catch {
		return false;
	}
	knownZones.add(value);
	return true;
}

/** "system" or an IANA zone this browser knows. */
export function timeZonePreference(): string {
	try {
		const value = localStorage.getItem(TIME_ZONE_KEY);
		return value && value !== "system" && validTimeZone(value) ? value : "system";
	} catch {
		return "system";
	}
}

/** The zone times are shown in: the stored choice, else the device's. */
export function presentationTimeZone(): string {
	const preference = timeZonePreference();
	return preference === "system" ? systemTimeZone() : preference;
}

/** Date formatting options for the chosen zone; none while following the
 * device, so those times format exactly as the browser's own. */
export function timeZoneOption(): { timeZone?: string } {
	const preference = timeZonePreference();
	return preference === "system" ? {} : { timeZone: preference };
}

const dayFormats = new Map<string, Intl.DateTimeFormat>();

/** The calendar day ("2026-09-24") a moment falls on in the shown zone; pass
 * the zone when formatting many dates so the preference is read once.
 * Following the device reads the local clock each time, so a device that
 * travels moves its midnights with it. */
export function presentationDay(date: Date, zone = timeZoneOption().timeZone): string {
	if (!zone) {
		const pad = (value: number) => String(value).padStart(2, "0");
		return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
	}
	let format = dayFormats.get(zone);
	if (!format) {
		format = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: zone });
		dayFormats.set(zone, format);
	}
	const parts = Object.fromEntries(format.formatToParts(date).map((part) => [part.type, part.value]));
	return `${parts.year}-${parts.month}-${parts.day}`;
}

/** The calendar day before a `presentationDay`, whatever the zone's clock changes. */
export function previousDay(day: string): string {
	const [year, month, date] = day.split("-").map(Number);
	return new Date(Date.UTC(year!, month! - 1, date! - 1)).toISOString().slice(0, 10);
}

export function setTimeZonePreference(value: string): boolean {
	if (value !== "system" && !validTimeZone(value)) return false;
	try {
		localStorage.setItem(TIME_ZONE_KEY, value);
	} catch {
		return false;
	}
	window.dispatchEvent(new Event("qorpera-time-zone-change"));
	return true;
}
