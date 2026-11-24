import { presentationDay, presentationLocale, previousDay, systemTimeZone, t, timeZoneOption } from "./preferences.ts";

const TIMESTAMP_GAP_MS = 5 * 60 * 1000;
const MAX_FORMAT_CACHE = 32;
const clockFormats = new Map<string, Intl.DateTimeFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();
const titleFormats = new Map<string, Intl.DateTimeFormat>();

function cachedDateTimeFormat(
	cache: Map<string, Intl.DateTimeFormat>,
	key: string,
	locale: string,
	options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
	let format = cache.get(key);
	if (!format) {
		if (cache.size >= MAX_FORMAT_CACHE) {
			const oldest = cache.keys().next().value;
			if (oldest !== undefined) cache.delete(oldest);
		}
		format = new Intl.DateTimeFormat(locale, options);
		cache.set(key, format);
	}
	return format;
}

export function parseConversationTimestamp(value: string): Date | undefined {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Days begin at midnight in the chosen zone (Settings → General → Time zone). */
export function needsConversationTimestamp(current: Date, previous?: Date): boolean {
	const zone = timeZoneOption().timeZone;
	return (
		!previous ||
		presentationDay(current, zone) !== presentationDay(previous, zone) ||
		current.getTime() - previous.getTime() >= TIMESTAMP_GAP_MS
	);
}

function formatKeyBase(locale: string, zone: { timeZone?: string }): string {
	return `${locale}|${zone.timeZone ?? `sys:${systemTimeZone()}`}`;
}

/** The time of day alone ("10:04", "2:18 PM"), as the thread's own time lines write it. */
export function conversationClockLabel(date: Date): string {
	const locale = presentationLocale();
	const zone = timeZoneOption();
	const key = formatKeyBase(locale, zone);
	return cachedDateTimeFormat(clockFormats, key, locale, { hour: "numeric", minute: "2-digit", ...zone }).format(date);
}

export function conversationTimestampLabel(date: Date, now = new Date()): string {
	const locale = presentationLocale();
	const zone = timeZoneOption();
	const keyBase = formatKeyBase(locale, zone);
	const time = cachedDateTimeFormat(clockFormats, keyBase, locale, {
		hour: "numeric",
		minute: "2-digit",
		...zone,
	}).format(date);
	const day = presentationDay(date, zone.timeZone),
		today = presentationDay(now, zone.timeZone);
	if (day === today) return t("Today {time}", { time });
	if (day === previousDay(today)) return t("Yesterday {time}", { time });
	const withYear = day.slice(0, 4) !== today.slice(0, 4);
	const shown = cachedDateTimeFormat(dateFormats, `${keyBase}|${withYear ? "y" : "n"}`, locale, {
		weekday: "short",
		month: "short",
		day: "numeric",
		...(withYear ? { year: "numeric" as const } : {}),
		...zone,
	}).format(date);
	return `${shown} ${time}`;
}

export function conversationTimestampTitle(date: Date): string {
	const locale = presentationLocale();
	const zone = timeZoneOption();
	const key = formatKeyBase(locale, zone);
	return cachedDateTimeFormat(titleFormats, key, locale, { dateStyle: "full", timeStyle: "long", ...zone }).format(
		date,
	);
}
