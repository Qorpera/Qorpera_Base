import type { Page } from "playwright-core";

/* What is typed into a password, one-time code or card box never reaches an
 * agent. Browser screenshots mask these boxes, a whole-screen capture is
 * refused while one holds a value, and page snapshots are redacted here:
 * Playwright's aria snapshot copies every input's value into the text, so a
 * password a member typed during a takeover would reach the agent's next
 * snapshot until the form is sent. One selector decides all three. */

const INPUT = 'input:not([type="hidden" i])';
const NAMING_ATTRIBUTES = ["name", "id", "aria-label", "placeholder"];
// Words that name a password or a code anywhere in an attribute (English, German, Danish).
const SECRET_WORDS = [
	"password",
	"passwort",
	"passwd",
	"pwd",
	"passcode",
	"kennwort",
	"adgangskode",
	"kodeord",
	"one-time",
	"onetime",
	"totp",
	"2fa",
	"mfa",
	"cvc",
	"cvv",
];

/** Boxes whose value is private. Attribute matches ignore case; hidden inputs never count. */
export const COMPANY_COMPUTER_PRIVATE_FIELD_SELECTOR = [
	'input[type="password" i]',
	`${INPUT}[autocomplete~="current-password" i]`,
	`${INPUT}[autocomplete~="new-password" i]`,
	`${INPUT}[autocomplete~="one-time-code" i]`,
	`${INPUT}[autocomplete*="cc-" i]`,
	...NAMING_ATTRIBUTES.flatMap((attribute) => [
		...SECRET_WORDS.map((word) => `${INPUT}[${attribute}*="${word}" i]`),
		// "otp" only as its own word: "rootPath" is not a code.
		...['="otp"', '^="otp"', '$="otp"', '*="_otp"', '*="-otp"', '*=" otp"', '*="otp_"', '*="otp-"', '*="otp "'].map(
			(match) => `${INPUT}[${attribute}${match} i]`,
		),
		`${INPUT}[${attribute}*="verif" i][${attribute}*="code" i]`,
		`${INPUT}[${attribute}*="security" i][${attribute}*="code" i]`,
	]),
].join(",");

/** What the agent sees instead of a private value. */
export const COMPANY_COMPUTER_PRIVATE_VALUE = "[hidden]";

/** Values this short are hidden only where the page shows them in a box. */
const MIN_HIDDEN_ELSEWHERE = 4;
/** A value with this many letters and digits refuses a snapshot that still shows them in any form. */
const MIN_CHECKED_SKELETON = 6;
const MAX_PRIVATE_VALUES = 64;
const MAX_PRIVATE_VALUE = 4096;

interface PrivateValueQuery {
	selector: string;
	maxValues: number;
	maxValue: number;
	shownOnly: boolean;
}

/**
 * Runs inside the page (Playwright evaluate): the distinct non-empty values of
 * the private boxes in this document, open shadow roots included (the
 * snapshot reads those too). It stops one value past the limit so the caller
 * can refuse. Self-contained: it may use nothing outside its own body.
 */
export function companyComputerPrivateValuesInDocument(query: PrivateValueQuery): string[] {
	type Element = { shadowRoot?: Root | null; matches(selector: string): boolean; value?: unknown };
	type Root = { querySelectorAll(selector: string): ArrayLike<Element>; visibilityState?: string };
	const found = new Set<string>();
	const document = (globalThis as unknown as { document: Root }).document;
	if (query.shownOnly && document.visibilityState !== "visible") return [];
	const roots: Root[] = [document];
	for (let index = 0; index < roots.length && found.size <= query.maxValues; index++) {
		const all = roots[index].querySelectorAll("*");
		for (let item = 0; item < all.length && found.size <= query.maxValues; item++) {
			const element = all[item];
			if (element.shadowRoot) roots.push(element.shadowRoot);
			if (typeof element.value !== "string" || !element.value || !element.matches(query.selector)) continue;
			found.add(element.value.slice(0, query.maxValue));
		}
	}
	return [...found];
}

/**
 * The private values of a page: of its top document, or of every frame with
 * `allFrames` (a whole-screen capture shows card boxes inside iframes too; the
 * snapshot does not include iframe contents). `shownOnly` reads nothing from a
 * tab the browser does not show.
 */
export async function readCompanyComputerPrivateValues(
	page: Page,
	options: { shownOnly?: boolean; allFrames?: boolean } = {},
): Promise<string[]> {
	const query: PrivateValueQuery = {
		selector: COMPANY_COMPUTER_PRIVATE_FIELD_SELECTOR,
		maxValues: MAX_PRIVATE_VALUES,
		maxValue: MAX_PRIVATE_VALUE,
		shownOnly: options.shownOnly === true,
	};
	const answers: unknown[] = options.allFrames
		? await Promise.all(page.frames().map((frame) => frame.evaluate(companyComputerPrivateValuesInDocument, query)))
		: [await page.evaluate(companyComputerPrivateValuesInDocument, query)];
	const values = new Set<string>();
	for (const answer of answers) {
		if (!Array.isArray(answer)) throw new Error("PRIVATE_FIELD_UNREADABLE");
		for (const value of answer as unknown[]) {
			if (typeof value !== "string" || value.length > MAX_PRIVATE_VALUE) throw new Error("PRIVATE_FIELD_UNREADABLE");
			if (value) values.add(value);
		}
	}
	if (values.size > MAX_PRIVATE_VALUES) throw new Error("PRIVATE_FIELD_UNREADABLE");
	return [...values];
}

/** Browser screenshot masks for the private boxes of every frame. */
export const companyComputerPrivateFieldMasks = (page: Page) =>
	page.frames().map((frame) => frame.locator(COMPANY_COMPUTER_PRIVATE_FIELD_SELECTOR));

/* Playwright 1.62's aria snapshot lines (renderAriaTree): `- <key>`, `- <key>:`
 * followed by deeper lines, or `- <key>: <value>`. The key is the role, a
 * JSON-quoted (or /regex/) name and [attributes]; it is wrapped in single
 * quotes with ' doubled when YAML needs it. A box's value is its single text
 * child, written after the key, or as a `- text:` line beneath it when the box
 * also has a placeholder (a `- /placeholder:` line). */
const TEXT_ENTRY_ROLES = new Set(["textbox", "searchbox", "spinbutton", "combobox"]);

function snapshotLine(line: string): { indent: number; role: string; rest: string } | undefined {
	const start = /^( *)- /.exec(line);
	if (!start) return undefined;
	let at = start[0].length;
	let key = "";
	if (line[at] === "'") {
		for (at++; ; at++) {
			if (at >= line.length) return undefined;
			if (line[at] === "'") {
				if (line[at + 1] !== "'") break;
				at++;
			}
			key += line[at];
		}
		at++;
	} else {
		// An unquoted key never holds ": ", and a trailing ":" opens a block.
		const separator = line.indexOf(": ", at);
		const end = separator >= 0 ? separator : line.endsWith(":") ? line.length - 1 : line.length;
		key = line.slice(at, end);
		at = end;
	}
	return { indent: start[1].length, role: /^[a-z]*/.exec(key)![0], rest: line.slice(at) };
}

/** The snapshot as text parts, with null where a typed value was. */
function hideTypedValues(snapshot: string): Array<string | null> {
	let boxIndent = -1;
	return snapshot.split("\n").flatMap((line, index): Array<string | null> => {
		const text = index === 0 ? line : `\n${line}`;
		const parsed = snapshotLine(line);
		if (!parsed) return [text];
		if (boxIndent >= 0 && parsed.indent <= boxIndent) boxIndent = -1;
		const value = parsed.rest.startsWith(": ") ? [text.slice(0, text.length - parsed.rest.length + 2), null] : [text];
		if (boxIndent >= 0 && parsed.role === "text") return value;
		if (!TEXT_ENTRY_ROLES.has(parsed.role)) return [text];
		if (parsed.rest === ":") boxIndent = parsed.indent;
		return value;
	});
}

/** Playwright's normalizeWhiteSpace. */
const normalized = (value: string) => value.replace(/[​­]/g, "").trim().replace(/\s+/g, " ");
const YAML_ESCAPES: Record<string, string> = {
	"\\": "\\\\",
	'"': '\\"',
	"\b": "\\b",
	"\f": "\\f",
	"\n": "\\n",
	"\r": "\\r",
	"\t": "\\t",
};
/** Inside double quotes, as Playwright writes a text value (yamlEscapeValueIfNeeded). */
const yamlInner = (value: string) =>
	value.replace(
		/[\\"\x00-\x1f\x7f-\x9f]/g,
		(c) => YAML_ESCAPES[c] ?? `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
	);
/** Inside a name, as JSON.stringify writes it. */
const jsonInner = (value: string) => JSON.stringify(value).slice(1, -1);
/** Inside a single-quoted key. */
const doubledQuotes = (value: string) => value.replace(/'/g, "''");
/** Letters, digits and single spaces: what any of Playwright's renderings leaves of a value. */
const skeleton = (value: string) => value.replace(/[^\p{L}\p{N}\s\0]/gu, "").replace(/\s+/g, " ");

/**
 * Hide private values in an aria snapshot. When a private box on the page holds
 * a value, every typed value in the snapshot is hidden (the snapshot does not
 * say which box is which), and the private values are hidden wherever else the
 * page shows them: as text, as a box's value, inside a name or inside a quoted
 * key. A snapshot that still shows one in another form is refused.
 */
export function redactCompanyComputerSnapshot(snapshot: string, privateValues: readonly string[]): string {
	if (privateValues.length === 0) return snapshot;
	const forms = [
		...new Set(
			privateValues.flatMap((value) =>
				[value, normalized(value)].flatMap((base) => [
					base,
					yamlInner(base),
					jsonInner(base),
					doubledQuotes(base),
					doubledQuotes(jsonInner(base)),
				]),
			),
		),
	]
		.filter((form) => form.length >= MIN_HIDDEN_ELSEWHERE)
		.sort((a, b) => b.length - a.length);
	// Values are matched only in the page's text between hidden parts (null), never across or inside one.
	let parts = hideTypedValues(snapshot);
	for (const form of forms)
		parts = parts.flatMap((part) =>
			part === null ? [part] : part.split(form).flatMap((piece, index) => (index === 0 ? [piece] : [null, piece])),
		);
	const remaining = skeleton(parts.map((part) => part ?? "\0").join(""));
	for (const value of privateValues) {
		const left = skeleton(normalized(value)).trim();
		if (left.replace(/ /g, "").length >= MIN_CHECKED_SKELETON && remaining.includes(left))
			throw new Error("PRIVATE_FIELD_VISIBLE");
	}
	return parts.map((part) => part ?? COMPANY_COMPUTER_PRIVATE_VALUE).join("");
}
