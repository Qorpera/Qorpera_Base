import type { Page } from "playwright-core";

/* What is typed into a password, one-time code or card box never reaches an
 * agent. Browser screenshots mask these boxes. A page snapshot needs more:
 * Playwright's aria snapshot copies every input's value into the text, so a
 * password a member typed during a takeover would reach the agent's next
 * snapshot until the form is sent. One selector decides both. */

/** Boxes whose value is private. Attribute matches ignore case. */
export const COMPANY_COMPUTER_PRIVATE_FIELD_SELECTOR = [
	'input[type="password" i]',
	'input[autocomplete~="current-password" i]',
	'input[autocomplete~="new-password" i]',
	'input[autocomplete~="one-time-code" i]',
	'input[autocomplete*="cc-" i]',
	...["name", "id", "aria-label", "placeholder"].flatMap((attribute) => [
		`input[${attribute}*="password" i]`,
		`input[${attribute}*="passcode" i]`,
		`input[${attribute}*="otp" i]`,
		`input[${attribute}*="2fa" i]`,
		`input[${attribute}*="mfa" i]`,
		`input[${attribute}*="one-time" i]`,
		`input[${attribute}*="cvc" i]`,
		`input[${attribute}*="cvv" i]`,
		`input[${attribute}*="verif" i][${attribute}*="code" i]`,
		`input[${attribute}*="security" i][${attribute}*="code" i]`,
	]),
].join(",");

/** What the agent sees instead of a private value. */
export const COMPANY_COMPUTER_PRIVATE_VALUE = "[hidden]";

/** Values in the page's own text that are this short are hidden only where the page shows them in a box. */
const MIN_HIDDEN_ELSEWHERE = 4;
const MAX_PRIVATE_FIELDS = 64;
const MAX_PRIVATE_VALUE = 4096;

/** The non-empty values of the private boxes in the top document, open shadow roots included (the snapshot reads those too). */
export async function readCompanyComputerPrivateValues(page: Page): Promise<string[]> {
	const values = await page.evaluate(
		({ selector, maxFields, maxValue }) => {
			type Node = { shadowRoot?: Root | null; matches(selector: string): boolean; value?: unknown };
			type Root = { querySelectorAll(selector: string): ArrayLike<Node> };
			const found: string[] = [];
			const roots: Root[] = [(globalThis as unknown as { document: Root }).document];
			for (let index = 0; index < roots.length && found.length <= maxFields; index++) {
				const all = roots[index].querySelectorAll("*");
				for (let item = 0; item < all.length; item++) {
					const element = all[item];
					if (element.shadowRoot) roots.push(element.shadowRoot);
					if (!element.matches(selector) || typeof element.value !== "string" || !element.value) continue;
					found.push(element.value.length > maxValue ? element.value.slice(0, maxValue) : element.value);
					if (found.length > maxFields) break;
				}
			}
			return found;
		},
		{ selector: COMPANY_COMPUTER_PRIVATE_FIELD_SELECTOR, maxFields: MAX_PRIVATE_FIELDS, maxValue: MAX_PRIVATE_VALUE },
	);
	if (
		!Array.isArray(values) ||
		values.length > MAX_PRIVATE_FIELDS ||
		values.some((value) => typeof value !== "string")
	)
		throw new Error("PRIVATE_FIELD_UNREADABLE");
	return [...new Set(values as string[])].filter((value) => value.length > 0);
}

/* Roles the aria snapshot gives a box that can hold typed text. The value is
 * written after the node's role, quoted name and [attributes] as ": value", or,
 * when the box also has a placeholder, as a "- text: value" line beneath it. */
const TEXT_ENTRY_LINE =
	/^(\s*)- (?:textbox|searchbox|spinbutton|combobox)(?: "(?:[^"\\]|\\.)*")?(?: \[[^\]\n]*\])*:( .*)?$/;
const TEXT_CHILD_LINE = /^(\s*)- text: /;

/** The snapshot as text parts, with null where a typed value was. */
function hideTypedValues(snapshot: string): Array<string | null> {
	let entryIndent = -1;
	return snapshot.split("\n").flatMap((line, index): Array<string | null> => {
		const lineBreak = index === 0 ? "" : "\n";
		const indent = line.length - line.trimStart().length;
		if (entryIndent >= 0 && indent <= entryIndent) entryIndent = -1;
		const entry = TEXT_ENTRY_LINE.exec(line);
		if (entry) {
			if (entry[2] === undefined) {
				entryIndent = entry[1].length;
				return [lineBreak + line];
			}
			return [`${lineBreak}${line.slice(0, line.length - entry[2].length)} `, null];
		}
		const child = entryIndent >= 0 ? TEXT_CHILD_LINE.exec(line) : null;
		return child ? [lineBreak + child[0], null] : [lineBreak + line];
	});
}

/** Playwright's YAML rendering of a text value (yamlEscapeValueIfNeeded), without the surrounding quotes. */
function escapedInner(value: string): string {
	return value.replace(/[\\"\x00-\x1f\x7f-\x9f]/g, (c) => {
		switch (c) {
			case "\\":
				return "\\\\";
			case '"':
				return '\\"';
			case "\b":
				return "\\b";
			case "\f":
				return "\\f";
			case "\n":
				return "\\n";
			case "\r":
				return "\\r";
			case "\t":
				return "\\t";
			default:
				return `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`;
		}
	});
}

/**
 * Hide private values in an aria snapshot. When a private box on the page holds
 * a value, every typed value in the snapshot is hidden (the snapshot does not
 * say which box is which), and the private values are hidden wherever else the
 * page shows them. If one can still be found afterwards the snapshot is refused.
 */
export function redactCompanyComputerSnapshot(snapshot: string, privateValues: readonly string[]): string {
	if (privateValues.length === 0) return snapshot;
	const forms = privateValues
		.filter((value) => value.length >= MIN_HIDDEN_ELSEWHERE)
		// The page's own text is shown with its spaces collapsed.
		.flatMap((value) => [value, escapedInner(value), value.replace(/\s+/g, " ").trim()])
		.filter((form) => form.length >= MIN_HIDDEN_ELSEWHERE)
		.sort((a, b) => b.length - a.length);
	// Values are matched only in the page's text between hidden parts (null), never across or inside one.
	let parts = hideTypedValues(snapshot);
	for (const form of new Set(forms))
		parts = parts.flatMap((part) =>
			part === null ? [part] : part.split(form).flatMap((piece, index) => (index === 0 ? [piece] : [null, piece])),
		);
	// A box's value has no line breaks, so a line break never completes one.
	const remaining = parts.map((part) => part ?? "\n").join("");
	if (forms.some((form) => remaining.includes(form))) throw new Error("PRIVATE_FIELD_VISIBLE");
	return parts.map((part) => part ?? COMPANY_COMPUTER_PRIVATE_VALUE).join("");
}
