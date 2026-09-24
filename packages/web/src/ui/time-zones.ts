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

/** The place an IANA name is named after; a middle part is its region. Zones
 * named after no place read as their offset: POSIX "Etc/GMT-2" is two hours
 * ahead of GMT, so it reads "GMT+2". */
export function timeZoneCity(id: string): string {
	if (/^Etc\/(?:GMT|UTC|UCT|Universal|Zulu|Greenwich)$/.test(id)) return "UTC";
	const posix = /^Etc\/GMT([+-])(\d{1,2})$/.exec(id);
	if (posix) return posix[2] === "0" ? "UTC" : `GMT${posix[1] === "-" ? "+" : "-"}${Number(posix[2])}`;
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

function zoneEntry(id: string, locale: string, at: Date): TimeZoneEntry | undefined {
	try {
		const shortOffset = zoneName(id, "en", "shortOffset", at);
		const minutes = offsetMinutes(shortOffset);
		const names = new Set([zoneName(id, "en", "longGeneric", at)]);
		if (locale !== "en") names.add(zoneName(id, locale, "longGeneric", at));
		return {
			id,
			city: timeZoneCity(id),
			offset: minutes === 0 ? "GMT" : shortOffset,
			minutes,
			names: [...names].filter(Boolean),
		};
	} catch {
		// A name this browser cannot format is not offered.
		return undefined;
	}
}

function westToEast(locale: string): (a: TimeZoneEntry, b: TimeZoneEntry) => number {
	return (a, b) => a.minutes - b.minutes || a.city.localeCompare(b.city, locale);
}

let cached: { key: string; entries: TimeZoneEntry[] } | undefined;

/** Every zone, west to east, then by city. Offsets are today's: a zone moves
 * when its clocks change, so the list is rebuilt once a day. Building costs a
 * few formatters per zone (~0.1 s), so it happens when a list is first opened;
 * `include` (the device's and the chosen zone) adds to it without a rebuild. */
export function timeZoneEntries(locale: string, include: readonly string[] = [], at = new Date()): TimeZoneEntry[] {
	const key = `${locale}|${at.toISOString().slice(0, 10)}`;
	if (cached?.key !== key)
		cached = {
			key,
			entries: [...new Set([...supportedZones(), "UTC"])]
				.map((id) => zoneEntry(id, locale, at))
				.filter((entry) => entry !== undefined)
				.sort(westToEast(locale)),
		};
	const known = new Set(cached.entries.map((entry) => entry.id));
	const extra = [...new Set(include)]
		.filter((id) => !known.has(id))
		.map((id) => zoneEntry(id, locale, at))
		.filter((entry) => entry !== undefined);
	return extra.length ? [...cached.entries, ...extra].sort(westToEast(locale)) : cached.entries;
}
