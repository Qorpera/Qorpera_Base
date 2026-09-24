import { presentationDay, presentationLocale, previousDay, timeZoneOption } from "./preferences.ts";

const TIMESTAMP_GAP_MS = 5 * 60 * 1000;

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

export function conversationTimestampLabel(date: Date, now = new Date()): string {
	const locale = presentationLocale();
	const zone = timeZoneOption();
	const time = date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit", ...zone });
	const day = presentationDay(date, zone.timeZone),
		today = presentationDay(now, zone.timeZone);
	if (day === today) return `${locale === "da" ? "I dag" : "Today"} ${time}`;
	if (day === previousDay(today)) return `${locale === "da" ? "I går" : "Yesterday"} ${time}`;
	const shown = date.toLocaleDateString(locale, {
		weekday: "short",
		month: "short",
		day: "numeric",
		...(day.slice(0, 4) !== today.slice(0, 4) ? { year: "numeric" as const } : {}),
		...zone,
	});
	return `${shown} ${time}`;
}

export function conversationTimestampTitle(date: Date): string {
	return date.toLocaleString(presentationLocale(), { dateStyle: "full", timeStyle: "long", ...timeZoneOption() });
}
