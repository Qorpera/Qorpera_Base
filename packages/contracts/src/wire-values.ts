/**
 * Checks for values that cross a wire boundary (JSON bodies, RPC answers, URL parts, files).
 * One copy for every package: new code imports these instead of writing its own `uuid()`,
 * `record()` or `sha256()` helper and its own UUID regex (`scripts/check-wire-helpers.mjs`
 * counts the local copies and refuses new ones).
 *
 * Each parser returns the checked value or throws a `WireValueError` naming the label, never the
 * value, so a secret that arrived in the wrong field does not reach a log.
 */

export class WireValueError extends Error {
	readonly label: string;

	constructor(label: string, problem = "is invalid") {
		super(`${label} ${problem}`);
		this.name = "WireValueError";
		this.label = label;
	}
}

/**
 * The one UUID rule: a check that returns the value you pass in accepts lower case only; either case
 * comes in only through `parseUuid`/`normalizeUuid`, which return the lower-cased value to use.
 *
 * - The form is the canonical hyphenated RFC 9562 UUID: version 1 to 8, variant `10xx`. The nil
 *   UUID and other versions are refused.
 * - PostgreSQL's `uuid` type accepts either case and always prints lower case. So an id bound for a
 *   `uuid` column or parameter, or compared with one the database printed, may arrive in either case
 *   through `parseUuid`/`normalizeUuid`. A writer stores the value they return, never its input.
 * - Where the exact text matters, use `isUuid`/`UUID_PATTERN` and refuse upper case: ids in paths
 *   and file names (case-sensitive), inside documents that are digested or compared whole, stored
 *   as text keys, or covered by a signature (check the raw bytes before anything else).
 */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A UUID already in the lower case the database prints (see `UUID_PATTERN`); upper case is refused. */
export function isUuid(value: unknown): value is string {
	return typeof value === "string" && UUID_PATTERN.test(value);
}

/** A UUID in either letter case, returned lower-cased, or `null` (see `UUID_PATTERN`). */
export function normalizeUuid(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const lower = value.toLowerCase();
	return UUID_PATTERN.test(lower) ? lower : null;
}

/** A UUID in either letter case, returned lower-cased (see `UUID_PATTERN`). */
export function parseUuid(value: unknown, label: string): string {
	const id = normalizeUuid(value);
	if (id === null) throw new WireValueError(label);
	return id;
}

/**
 * A SHA-256 digest as lower-case hex: what `encode(digest(...), 'hex')` and Node's
 * `digest("hex")` produce, and what the database's own `~ '^[0-9a-f]{64}$'` checks accept.
 * Digests are compared as text, so upper case is refused rather than folded.
 */
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export function parseSha256Hex(value: unknown, label: string): string {
	if (typeof value !== "string" || !SHA256_HEX_PATTERN.test(value)) throw new WireValueError(label);
	return value;
}

/** A plain JSON object: not null, not an array. */
export function parseRecord(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new WireValueError(label);
	return value as Record<string, unknown>;
}

/** A plain JSON object with every `required` field and no field outside `required` and `optional`. */
export function parseClosedRecord(
	value: unknown,
	label: string,
	required: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	const input = parseRecord(value, label);
	const allowed = new Set([...required, ...optional]);
	if (Object.keys(input).some((key) => !allowed.has(key))) throw new WireValueError(label, "has an unknown field");
	const missing = required.find((key) => !Object.hasOwn(input, key));
	if (missing !== undefined) throw new WireValueError(label, `is missing ${missing}`);
	return input;
}

/**
 * A string of at most `maxLength` UTF-16 code units, at least `minLength` of them left once white
 * space is trimmed from both ends, and no NUL. Returned unchanged.
 */
export function parseBoundedText(value: unknown, label: string, maxLength: number, minLength = 1): string {
	if (
		typeof value !== "string" ||
		value.length > maxLength ||
		value.trim().length < minLength ||
		value.includes("\0")
	) {
		throw new WireValueError(label);
	}
	return value;
}

/** A safe integer from `minimum` to `maximum`, both included. */
export function parseInteger(value: unknown, label: string, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new WireValueError(label);
	}
	return value as number;
}

/** A checked time: the text exactly as it arrived, and the same instant as a `Date`. */
export type WireTimestamp = {
	/** Unchanged, with every fractional digit (PostgreSQL's microseconds included). Send this back, e.g. as a
	 * keyset cursor, and compare with it; the database reads it as the same instant. */
	readonly text: string;
	/** The same instant to the millisecond, for display and arithmetic. Digits past the millisecond are
	 * dropped here only. */
	readonly date: Date;
};

/** RFC 3339 date and time with an explicit offset; also PostgreSQL's text form (`2026-09-29 10:00:00+00`). */
const TIMESTAMP_PATTERN =
	/^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:[Zz]|([+-])(\d{2})(?::(\d{2}))?)$/;

/**
 * A time the database or another system printed: RFC 3339 / ISO 8601 date and time with an explicit
 * offset (`Z`, `±hh` or `±hh:mm`), with a `T` or a space between date and time. Anything else is
 * refused, bare numbers and times without an offset included, so the result never depends on the
 * host's time zone. Seconds run to 59 (no leap second). Read without `Date.parse`.
 */
export function parseTimestamp(value: unknown, label: string): WireTimestamp {
	if (typeof value !== "string" || value.length > 64) throw new WireValueError(label);
	const part = TIMESTAMP_PATTERN.exec(value);
	if (part === null) throw new WireValueError(label);
	const [year, month, day, hour, minute, second] = part.slice(1, 7).map(Number) as [
		number,
		number,
		number,
		number,
		number,
		number,
	];
	const offsetHours = part[9] === undefined ? 0 : Number(part[9]);
	const offsetMinutes = part[10] === undefined ? 0 : Number(part[10]);
	if (hour > 23 || minute > 59 || second > 59 || offsetHours > 23 || offsetMinutes > 59) {
		throw new WireValueError(label);
	}
	const date = new Date(0);
	date.setUTCFullYear(year, month - 1, day);
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
		throw new WireValueError(label);
	}
	const milliseconds = Number((part[7] ?? "").padEnd(3, "0").slice(0, 3));
	const offset = (part[8] === "-" ? -1 : 1) * (offsetHours * 60 + offsetMinutes);
	date.setUTCHours(hour, minute - offset, second, milliseconds);
	return { text: value, date };
}
