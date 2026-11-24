import { presentationLocale, t } from "../../ui/preferences.ts";

export const goodWillName = () => t("Good will");

const locale = () => (presentationLocale() === "da" ? "da-DK" : "en-GB");

export function kroner(ore: number): string {
	return `${new Intl.NumberFormat(locale(), { maximumFractionDigits: 2 }).format(ore / 100)} kr`;
}

export function monthName(month: string): string {
	const [year, number] = month.split("-").map(Number);
	return new Date(Date.UTC(year!, number! - 1, 1)).toLocaleDateString(locale(), {
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	});
}

export function takeGoodWillReturn(): "card-saved" | "card-cancelled" | undefined {
	const hash = location.hash;
	const at = hash.indexOf("?");
	if (at < 0) return undefined;
	const value = new URLSearchParams(hash.slice(at + 1)).get("good-will");
	if (value !== "card-saved" && value !== "card-cancelled") return undefined;
	history.replaceState(null, "", hash.slice(0, at) || "#/");
	return value;
}
