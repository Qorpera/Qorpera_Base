import type { Page } from "playwright-core";

/* What is typed into a password, one-time code or card box never reaches an
 * agent. Browser screenshots mask these boxes, a whole-screen capture is
 * refused while one holds a value, and page snapshots are redacted here:
 * Playwright's aria snapshot copies every input's value into the text, so a
 * password a member typed during a takeover would reach the agent's next
 * snapshot until the form is sent. One selector decides all three. */

// Boxes a person types text into, including ones with an empty or unknown type (browsers show
// those as text boxes); checkboxes, radios, buttons, hidden, file, range and color inputs never count.
const TEXT_INPUT = `input${[
	"checkbox",
	"radio",
	"submit",
	"button",
	"reset",
	"image",
	"file",
	"hidden",
	"range",
	"color",
]
	.map((type) => `:not([type="${type}" i])`)
	.join("")}`;
const NAMING_ATTRIBUTES = ["name", "id", "aria-label", "placeholder"];
// Words that name a password or a code anywhere in an attribute (English, German, Danish).
const CONTAINED_WORDS = [
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
	"cvc",
	"cvv",
];
// Words that count only on their own: "rootPath" and "formFactor" are not codes.
const OWN_WORDS = ["otp", "mfa", "2fa"];

/** Boxes whose value is private. Attribute matches ignore case. */
export const COMPANY_COMPUTER_PRIVATE_FIELD_SELECTOR = [
	'input[type="password" i]',
	`${TEXT_INPUT}:is(${[
		// A box the vault filled with a secret (cloud-company-computer-account-fill.ts), whatever it is named.
		"[data-qorpera-private]",
		'[autocomplete~="current-password" i]',
		'[autocomplete~="new-password" i]',
		'[autocomplete~="one-time-code" i]',
		'[autocomplete*="cc-" i]',
		...NAMING_ATTRIBUTES.flatMap((attribute) => [
			...CONTAINED_WORDS.map((word) => `[${attribute}*="${word}" i]`),
			...OWN_WORDS.flatMap((word) => [
				`[${attribute}="${word}" i]`,
				`[${attribute}^="${word}" i]`,
				`[${attribute}$="${word}" i]`,
				...["_", "-", " "].flatMap((separator) => [
					`[${attribute}*="${separator}${word}" i]`,
					`[${attribute}*="${word}${separator}" i]`,
				]),
			]),
			`[${attribute}*="verif" i][${attribute}*="code" i]`,
			`[${attribute}*="security" i][${attribute}*="code" i]`,
		]),
	].join(",")})`,
].join(",");

/** What the agent sees instead of a private value. */
export const COMPANY_COMPUTER_PRIVATE_VALUE = "[hidden]";

/**
 * Text shaped like a hook's signing secret (E3c-3's shape guard): `whsec_` and letters, digits, `+`, `/` or `=`, also
 * percent-encoded as an address carries them. It is private on every page, whoever revealed it (an agent that clicks
 * Stripe's Reveal itself never reads the value): snapshots, titles and addresses hide it, and no screenshot is taken
 * while a page shows it. E3b's HMAC secrets have this shape too. Global: make a copy before `test`ing with it.
 */
export const COMPANY_COMPUTER_SECRET_SHAPE = /whsec_(?:[A-Za-z0-9+/=]|%2[BbFf]|%3[Dd])+/g;

/** The secret-shaped values `text` shows, each once. */
export function companyComputerSecretShapes(text: string): string[] {
	return [...new Set(text.match(COMPANY_COMPUTER_SECRET_SHAPE) ?? [])];
}

/** Values this short are hidden only where the page shows them in a box. */
const MIN_HIDDEN_ELSEWHERE = 4;
/** A value with this many letters and digits refuses a snapshot that still shows them, as a word of their own, in any form. */
const MIN_CHECKED_SKELETON = 8;
/** One read of a page's private values; a hung tab is unreadable, not a reason to wait. */
const READ_TIMEOUT_MS = 5_000;
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

function withinReadTimeout<T>(read: Promise<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("PRIVATE_FIELD_UNREADABLE")), READ_TIMEOUT_MS);
		read.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
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
	const reads = options.allFrames
		? page
				.frames()
				.filter((frame) => !frame.isDetached())
				.map((frame) => frame.evaluate(companyComputerPrivateValuesInDocument, query))
		: [page.evaluate(companyComputerPrivateValuesInDocument, query)];
	// A failure counts only once every frame's read has settled or timed out; a timed-out read is
	// left to finish on its own (it only reads).
	const settled = await Promise.allSettled(reads.map(withinReadTimeout));
	const values = new Set<string>();
	for (const read of settled) {
		if (read.status === "rejected") throw read.reason;
		const answer: unknown = read.value;
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
	page
		.frames()
		.filter((frame) => !frame.isDetached())
		.map((frame) => frame.locator(COMPANY_COMPUTER_PRIVATE_FIELD_SELECTOR));

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
const normalized = (value: string) =>
	value
		.replace(/[\u200b\u00ad]/g, "")
		.trim()
		.replace(/\s+/g, " ");
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

/** A value as a page address carries it: percent-encoded, or form-encoded. */
export function companyComputerUrlForms(value: string): string[] {
	// Percent-encoded, form-encoded, and percent-encoded with a space as + (as some scripts write a query).
	return [
		encodeURIComponent(value),
		new URLSearchParams([["v", value]]).toString().slice(2),
		encodeURIComponent(value).replace(/%20/g, "+"),
	];
}

/** `part` split at each `form`; an all-digit form only where it is a number of its own (a code, not part of one). */
function splitAt(part: string, form: string, bounded: boolean): Array<string | null> {
	if (!bounded) return part.split(form).flatMap((piece, index) => (index === 0 ? [piece] : [null, piece]));
	const out: Array<string | null> = [];
	let from = 0;
	for (let at = part.indexOf(form); at >= 0; at = part.indexOf(form, at + 1)) {
		if (/\d/.test(part[at - 1] ?? "") || /\d/.test(part[at + form.length] ?? "")) continue;
		out.push(part.slice(from, at), null);
		from = at + form.length;
		at = from - 1;
	}
	out.push(part.slice(from));
	return out;
}

/**
 * Hide private values in an aria snapshot. When a private box on the page holds
 * a value, every typed value in the snapshot is hidden (the snapshot does not
 * say which box is which), and the private values are hidden wherever else the
 * page shows them: as text, as a box's value, inside a name or inside a quoted
 * key. A snapshot that still shows one in another form is refused.
 *
 * `filled` are secrets the vault typed on this screen earlier (company accounts A1-3): they are hidden the same way
 * and also in a page address's spellings, but they do not hide every typed value (their boxes may be long gone);
 * an authenticator code among them is hidden only as a number of its own.
 */
export function redactCompanyComputerSnapshot(
	snapshot: string,
	privateValues: readonly string[],
	options: { filled?: readonly string[] } = {},
): string {
	const filled = options.filled ?? [];
	if (privateValues.length === 0 && filled.length === 0) return snapshot;
	const spell = (bases: string[]) =>
		bases.flatMap((base) => [
			base,
			yamlInner(base),
			jsonInner(base),
			doubledQuotes(base),
			doubledQuotes(jsonInner(base)),
		]);
	const forms = [
		...new Map(
			[
				...privateValues.flatMap((value) =>
					spell([value, normalized(value)]).map((form) => [form, false] as const),
				),
				...filled.flatMap((value) =>
					spell([value, normalized(value), ...companyComputerUrlForms(value)]).map(
						(form) => [form, /^\d+$/.test(value)] as const,
					),
				),
			].reverse(),
		),
	]
		.filter(([form]) => form.length >= MIN_HIDDEN_ELSEWHERE)
		.sort(([a], [b]) => b.length - a.length);
	// Values are matched only in the page's text between hidden parts (null), never across or inside one.
	let parts: Array<string | null> = privateValues.length > 0 ? hideTypedValues(snapshot) : [snapshot];
	for (const [form, bounded] of forms)
		parts = parts.flatMap((part) => (part === null ? [part] : splitAt(part, form, bounded)));
	const remaining = skeleton(parts.map((part) => part ?? "\0").join(""));
	for (const value of [...privateValues, ...filled]) {
		const left = skeleton(normalized(value)).trim();
		if (left.replace(/ /g, "").length < MIN_CHECKED_SKELETON) continue;
		// Only as a word of its own: a code inside a longer number is that number, not the code.
		for (let at = remaining.indexOf(left); at >= 0; at = remaining.indexOf(left, at + 1)) {
			const word = /[\p{L}\p{N}]/u;
			if (!word.test(remaining[at - 1] ?? "") && !word.test(remaining[at + left.length] ?? ""))
				throw new Error("PRIVATE_FIELD_VISIBLE");
		}
	}
	return parts.map((part) => part ?? COMPANY_COMPUTER_PRIVATE_VALUE).join("");
}
