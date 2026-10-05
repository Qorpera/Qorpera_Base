import {
	INTERFACE_OUTSIDE_VALUE_MAX_CHARS,
	INTERFACE_OUTSIDE_VALUES_MAX,
	INTERFACE_QUOTE_SOURCES,
} from "@qorpera/cloud-client/interfaces";

/* Quoted outside content in a member's message (contract, the 2026-10-02 amendment "quoted outside content in a
 * member's message"; supabase/CLIENT-CONTRACT.md "Quotes in a member's message"). A message's `quotes` are spans of
 * its text that quote outside content, today an email's words. Each counts characters (Unicode code points) from 0,
 * with its end excluded, sits just inside « and », and names where its words came from. The platform fences those
 * words like a tool result, and the review never reads them as what the member asked for. */

/** A type, not an interface, so a message body holding quotes is plain JSON to the type checker. */
export type MessageQuote = {
	readonly start: number;
	readonly end: number;
	/** Where the words came from, from the contract's closed list: today only `mail`. */
	readonly source: string;
	/** The record: for `mail`, the thread's id. */
	readonly ref: string;
};

/** A message carries 1 to this many quotes. */
export const QUOTES_MAX = INTERFACE_OUTSIDE_VALUES_MAX;
/** A quote is 1 to this many characters. */
export const QUOTE_MAX_CHARACTERS = INTERFACE_OUTSIDE_VALUE_MAX_CHARS;
/** The shape of each source's record: a mail thread's id is 43 base64url characters. */
const REFS: Readonly<Record<string, RegExp>> = { mail: /^[A-Za-z0-9_-]{43}$/ };

export const QUOTE_OPEN = "«";
export const QUOTE_CLOSE = "»";

const pairAt = (text: string, at: number) => {
	const high = text.charCodeAt(at);
	const low = text.charCodeAt(at + 1);
	return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
};

/** Where the character at `index` (counted in code points) starts, in UTF-16 units. */
export function unitIndex(text: string, index: number): number {
	let units = 0;
	for (let count = 0; count < index && units < text.length; count++) units += pairAt(text, units) ? 2 : 1;
	return units;
}

/** How many characters (code points) stand before a UTF-16 index. */
export function characterIndex(text: string, units: number): number {
	let count = 0;
	for (let at = 0; at < units && at < text.length; count++) at += pairAt(text, at) ? 2 : 1;
	return count;
}

/** Whether a source's record names something of the right shape. */
export function quoteRefFits(source: string, ref: string): boolean {
	return INTERFACE_QUOTE_SOURCES.includes(source) && REFS[source]?.test(ref) === true;
}

/** A message's quotes as the cloud takes them (qorpera_check_member_quotes): 1 to 16, each with exactly `start`,
 * `end`, `source` and `ref`; in order and apart; each 1 to 2,000 characters just inside a pair of marks, with no mark
 * of its own inside (20260930087000: a quote is always «words»); from a source on the quote list, naming a record of
 * its shape. Undefined when `value` is not that. Whether the record exists is the cloud's to say. */
export function parseQuotes(value: unknown, text: string): MessageQuote[] | undefined {
	if (!Array.isArray(value) || value.length < 1 || value.length > QUOTES_MAX) return undefined;
	const characters = [...text];
	const quotes: MessageQuote[] = [];
	let previous = -1;
	for (const item of value) {
		if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
		const { start, end, source, ref, ...rest } = item as Record<string, unknown>;
		if (
			Object.keys(rest).length ||
			typeof start !== "number" ||
			typeof end !== "number" ||
			!Number.isSafeInteger(start) ||
			!Number.isSafeInteger(end) ||
			typeof source !== "string" ||
			typeof ref !== "string" ||
			start < 1 ||
			end <= start ||
			end - start > QUOTE_MAX_CHARACTERS ||
			end >= characters.length ||
			start <= previous ||
			characters[start - 1] !== QUOTE_OPEN ||
			characters[end] !== QUOTE_CLOSE ||
			characters.slice(start, end).some((letter) => letter === QUOTE_OPEN || letter === QUOTE_CLOSE) ||
			!quoteRefFits(source, ref)
		)
			return undefined;
		previous = end;
		quotes.push({ start, end, source, ref });
	}
	return quotes;
}

export function sameQuotes(a: readonly MessageQuote[], b: readonly MessageQuote[]): boolean {
	return (
		a.length === b.length &&
		a.every((quote, index) => {
			const other = b[index];
			return (
				other !== undefined &&
				quote.start === other.start &&
				quote.end === other.end &&
				quote.source === other.source &&
				quote.ref === other.ref
			);
		})
	);
}

/** A text as the cloud reads the member's own words (qorpera_member_message_fenced): each quote's words become its
 * placeholder, `[quote N]` counting from 1, and the marks stay. Mentions are read from this, so a name inside a quote
 * names nobody. `at` takes an index (UTF-16) of the folded text back to the text; a placeholder's letters go to its
 * quote's start. */
export function foldQuotes(
	text: string,
	quotes: readonly MessageQuote[],
): { text: string; at: (index: number) => number } {
	if (!quotes.length) return { text, at: (index) => index };
	let folded = "";
	let cursor = 0;
	// Each run of the member's own words: where it starts in the folded text and in the text.
	const runs: { folded: number; text: number; length: number }[] = [];
	const placeholders: { from: number; to: number; text: number }[] = [];
	quotes.forEach((quote, index) => {
		const start = unitIndex(text, quote.start);
		runs.push({ folded: folded.length, text: cursor, length: start - cursor });
		folded += text.slice(cursor, start);
		const placeholder = `[quote ${index + 1}]`;
		placeholders.push({ from: folded.length, to: folded.length + placeholder.length, text: start });
		folded += placeholder;
		cursor = unitIndex(text, quote.end);
	});
	runs.push({ folded: folded.length, text: cursor, length: text.length - cursor });
	folded += text.slice(cursor);
	return {
		text: folded,
		at: (index) => {
			const placeholder = placeholders.find((item) => index > item.from && index < item.to);
			if (placeholder) return placeholder.text;
			let run = runs[0]!;
			for (const item of runs) if (item.folded <= index) run = item;
			return run.text + Math.min(index - run.folded, run.length);
		},
	};
}
