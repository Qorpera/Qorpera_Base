/** The time zones this browser knows, named the way people look for them:
 * the city, the offset right now, and the zone's long name for search. */
export interface TimeZoneEntry {
	id: string;
	/** "Copenhagen", "Knox, Indiana", "UTC". */
	city: string;
	/** "GMT+2", "GMT-3:30", "GMT". */
	offset: string;
	/** Minutes east of GMT right now, for ordering. */
	minutes: number;
	/** "Central European Time" in the interface language (and English). */
	names: string[];
}

/** Browsers still list some zones under a city's old spelling (the zone
 * names are frozen); show and search the name people use today. */
const RENAMED: Record<string, string> = {
	Asmera: "Asmara",
	Calcutta: "Kolkata",
	"Coral Harbour": "Atikokan",
	Enderbury: "Kanton",
	Faeroe: "Faroe",
	Godthab: "Nuuk",
	Katmandu: "Kathmandu",
	Kiev: "Kyiv",
	Ponape: "Pohnpei",
	Rangoon: "Yangon",
	Saigon: "Ho Chi Minh City",
	Truk: "Chuuk",
};

/** The place an IANA name is named after; a middle part is its region. */
export function timeZoneCity(id: string): string {
	const parts = id.split("/").map((part) => part.replaceAll("_", " "));
	if (parts.length === 1) return parts[0]!;
	const city = RENAMED[parts.at(-1)!] ?? parts.at(-1)!;
	return parts.length > 2 ? `${city}, ${parts.at(-2)}` : city;
}

function zoneName(id: string, locale: string, style: "shortOffset" | "longGeneric", at: Date): string {
	return (
		new Intl.DateTimeFormat(locale, { timeZone: id, timeZoneName: style })
			.formatToParts(at)
			.find((part) => part.type === "timeZoneName")?.value ?? ""
	);
}

function offsetMinutes(label: string): number {
	const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(label);
	if (!match) return 0;
	return (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] ?? 0));
}

function supportedZones(): string[] {
	try {
		return Intl.supportedValuesOf("timeZone");
	} catch {
		return [];
	}
}

let cached: { key: string; entries: TimeZoneEntry[] } | undefined;

/** Every zone, west to east, then by city. Offsets are today's: a zone moves
 * when its clocks change, so the list is rebuilt once a day. Building costs a
 * few formatters per zone (~0.1 s), so it happens when a list is first opened. */
export function timeZoneEntries(locale: string, include: readonly string[] = [], at = new Date()): TimeZoneEntry[] {
	const key = `${locale}|${at.toISOString().slice(0, 10)}|${include.join(",")}`;
	if (cached?.key === key) return cached.entries;
	const ids = new Set([...supportedZones(), "UTC", ...include]);
	const entries: TimeZoneEntry[] = [];
	for (const id of ids) {
		try {
			const shortOffset = zoneName(id, "en", "shortOffset", at);
			const minutes = offsetMinutes(shortOffset);
			const names = new Set([zoneName(id, "en", "longGeneric", at)]);
			if (locale !== "en") names.add(zoneName(id, locale, "longGeneric", at));
			entries.push({
				id,
				city: timeZoneCity(id),
				offset: minutes === 0 ? "GMT" : shortOffset,
				minutes,
				names: [...names].filter(Boolean),
			});
		} catch {
			// A name this browser cannot format is not offered.
		}
	}
	entries.sort((a, b) => a.minutes - b.minutes || a.city.localeCompare(b.city, locale));
	cached = { key, entries };
	return entries;
}
