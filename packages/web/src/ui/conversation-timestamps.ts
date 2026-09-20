import { presentationLocale } from "./preferences.ts";

const TIMESTAMP_GAP_MS = 5 * 60 * 1000;

export function parseConversationTimestamp(value: string): Date | undefined {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

export function needsConversationTimestamp(current: Date, previous?: Date): boolean {
	return (
		!previous ||
		current.toDateString() !== previous.toDateString() ||
		current.getTime() - previous.getTime() >= TIMESTAMP_GAP_MS
	);
}

export function conversationTimestampLabel(date: Date, now = new Date()): string {
	const locale = presentationLocale();
	const time = date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	if (date.toDateString() === now.toDateString()) return `${locale === "da" ? "I dag" : "Today"} ${time}`;
	if (date.toDateString() === yesterday.toDateString()) return `${locale === "da" ? "I går" : "Yesterday"} ${time}`;
	const day = date.toLocaleDateString(locale, {
		weekday: "short",
		month: "short",
		day: "numeric",
		...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" as const } : {}),
	});
	return `${day} ${time}`;
}

export function conversationTimestampTitle(date: Date): string {
	return date.toLocaleString(presentationLocale(), { dateStyle: "full", timeStyle: "long" });
}
