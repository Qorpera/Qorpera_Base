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
 * The one UUID rule. PostgreSQL's `uuid` type accepts any letter case and always prints lower
 * case: an id the database emitted is lower case, while one a person, a URL or another system
 * hands over may not be. So the check accepts either case, in the canonical hyphenated form of an
 * RFC 9562 UUID (version 1 to 8, variant `10xx`), and `parseUuid` returns it lower-cased, the form
 * the database prints, so a checked id compares equal to the database's own.
 */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
	return typeof value === "string" && UUID_PATTERN.test(value);
}

/** A UUID in either letter case, returned lower-cased (see `UUID_PATTERN`). */
export function parseUuid(value: unknown, label: string): string {
	if (!isUuid(value)) throw new WireValueError(label);
	return value.toLowerCase();
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
 * A string of at most `maxLength` UTF-16 code units with at least `minLength` characters that are
 * not white space, and no NUL. Returned unchanged.
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

/** A time the database or another system printed, returned in ISO 8601 UTC with milliseconds. */
export function parseTimestamp(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length > 64) throw new WireValueError(label);
	const time = Date.parse(value);
	if (!Number.isFinite(time)) throw new WireValueError(label);
	return new Date(time).toISOString();
}
