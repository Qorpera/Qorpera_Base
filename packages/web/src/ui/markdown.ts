import { appLinkName } from "@qorpera/cloud-client/interface-apps";
import { Lexer, type MarkedToken, type Tokens } from "marked";
import { h, icon } from "./dom.ts";
import { folderLinkPath } from "./folder-links.ts";
import { interfaceEmblem } from "./interface-emblem.ts";
import { t } from "./preferences.ts";

// Parse only a single validated character reference, never source markup.
// The result still enters the page through a text node or a checked URL.
function decodeEntities(value: string): string {
	return value.replace(
		/&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/gi,
		(entity) => new DOMParser().parseFromString(entity, "text/html").body.textContent ?? entity,
	);
}

/** Only explicit web/mail links can leave a transcript. Images are links,
 * never automatic remote requests. Raw HTML is always rendered as text. A
 * `folder:` link (ui/folder-links.ts) leaves nothing: it opens the Company File.
 * Answers the address as the browser reads it (`https:`, `http:` or `mailto:`, with no name or password in it), or
 * undefined. A link in an agent's interface app is checked by this same rule (app/interface-apps.ts `appLink`). */
export function webHref(href: string): string | undefined {
	try {
		const url = new URL(href);
		if (["https:", "http:", "mailto:"].includes(url.protocol) && !url.username && !url.password) return url.href;
	} catch {
		// Relative paths and malformed URLs have no destination in this client.
	}
	return undefined;
}

/** A text the lexer read tokens from, and the way from an offset in it to the source: the source itself, or the inside
 * of a quote or of a list item, whose lines stand in the source behind a "> ", a bullet or an indent. */
interface Layer {
	readonly text: string;
	readonly toSource: (offset: number) => number;
}
/** Where a token stands: in which text, from where, and what of that text it is. */
interface Place {
	readonly layer: Layer;
	readonly start: number;
	readonly raw: string;
}
/** Where an offset into a drawn run of text falls in the source. */
type Stretch = (offset: number) => number;
/** Each token's place, for a drawing made with `sourceRanges` (`place`). */
const places = new WeakMap<object, Place>();
/** The way from each drawn run of text to the source (`markdownSourceOffset`). */
const drawnFrom = new WeakMap<Text, Stretch>();

/** Text drawn with its character references read (`&amp;` as "&"): each reference is one place, before it or after
 * it. `raw` stands at `start`; none unless it reads as exactly `text`. */
function referenced(start: number, raw: string, text: string): Stretch | undefined {
	if (decodeEntities(raw) !== text) return undefined;
	return (offset) => {
		let found = 0;
		for (const unit of raw.matchAll(/&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);|[\s\S]/giu)) {
			const draws = unit[0].length > 1 && unit[0].startsWith("&") ? decodeEntities(unit[0]) : unit[0];
			if (found + draws.length > offset)
				return start + unit.index + (draws === unit[0] ? Math.max(0, offset - found) : 0);
			found += draws.length;
		}
		return start + raw.length;
	};
}

/** Text that stands in `raw` (at `start`) line for line, each of its lines the end of a line there: a code's lines
 * under its fence or behind its indent, a quote's behind its "> ", a list item's behind its bullet and indent. None
 * unless every line does, or for no text at all. */
function lineByLine(start: number, raw: string, text: string): Stretch | undefined {
	if (!text) return undefined;
	const lines = text.split("\n");
	const written = raw.split("\n");
	const starts: number[] = [];
	let at = start;
	for (const [index, line] of lines.entries()) {
		const whole = written[index];
		if (whole === undefined || !whole.endsWith(line)) return undefined;
		starts.push(at + whole.length - line.length);
		at += whole.length + 1;
	}
	return (offset) => {
		let rest = Math.max(0, offset);
		for (const [index, line] of lines.entries()) {
			if (rest <= line.length || index === lines.length - 1)
				return (starts[index] ?? start) + Math.min(rest, line.length);
			rest -= line.length + 1;
		}
		return start;
	};
}

/** The way from the text drawn for `token` to where it stands in its layer. Only what is drawn has a place: never a
 * code's ticks or fence, an image's brackets and address, or the inside of an escape. */
function stretchOf(token: MarkedToken, { start, raw }: Place, text: string): Stretch | undefined {
	switch (token.type) {
		case "text":
			return referenced(start, raw, text);
		case "image":
			// "![", then the words as they are written.
			return raw.startsWith(`![${token.text}]`) ? referenced(start + 2, token.text, text) : undefined;
		case "escape":
			return (offset) => (offset <= 0 ? start : start + raw.length);
		case "codespan": {
			const ticks = /^`+/.exec(raw)?.[0].length ?? 0;
			const inside = raw.slice(ticks, raw.length - ticks);
			// One space inside each end is the mark's, where the lexer took them from the code.
			const pad = inside.length - text.length === 2 && /^[ \n]/.test(inside) && /[ \n]$/.test(inside) ? 1 : 0;
			// A line end inside the code is drawn as a space, in the same place.
			if (inside.slice(pad, inside.length - pad).replace(/\n/g, " ") !== text) return undefined;
			return (offset) => start + ticks + pad + Math.min(Math.max(0, offset), text.length);
		}
		case "code": {
			// The code stands under a fence's first line, which may name a language the code spells too.
			const under = token.codeBlockStyle === "indented" ? 0 : raw.indexOf("\n") + 1;
			return lineByLine(start + under, raw.slice(under), text);
		}
		default:
			return lineByLine(start, raw, text);
	}
}

/** A token's own text as a node of the page, with its way to the source where it has one. */
function drawn(token: MarkedToken, text: string): Text {
	const node = document.createTextNode(text);
	const place = places.get(token);
	const stretch = place && stretchOf(token, place, text);
	if (place && stretch) drawnFrom.set(node, (offset) => place.layer.toSource(stretch(offset)));
	return node;
}

/** Gives the tokens of one text their places (`places`). Nothing is looked for: the lexer read `tokens` from
 * `layer.text` one after another from `from`, so each stands where the one before it ended, with at most empty lines
 * between two. One that does not (the lexer rewrote what it read: a tab, a mark it took out) gets no place, and
 * neither do those after it: where they stand would be a guess. */
function place(layer: Layer, tokens: readonly MarkedToken[], from: number): void {
	let at = from;
	for (const token of tokens) {
		// A task's box is put in after the lexing, into no text that was read: beside the item's tokens, or at the
		// head of the item's first paragraph, which says it read the box too.
		if (token.type === "checkbox") continue;
		const boxed = token.type === "paragraph" || token.type === "text" ? token.tokens?.[0] : undefined;
		const box = boxed?.type === "checkbox" ? boxed.raw.length : 0;
		const raw = token.raw.slice(box);
		let start = at;
		while (layer.text[start] === "\n" && !layer.text.startsWith(raw, start)) start++;
		if (!layer.text.startsWith(raw, start)) return;
		places.set(token, { layer, start, raw });
		at = start + raw.length;
		// What the token holds was read from its own text, which stands inside it after its opening mark.
		const inside = (text: string, lead: number) => {
			if ("tokens" in token && token.tokens && Number.isInteger(lead) && raw.startsWith(text, lead))
				place(layer, token.tokens as MarkedToken[], start + lead);
		};
		switch (token.type) {
			case "list":
				place(layer, token.items, start);
				break;
			case "list_item":
			case "blockquote": {
				// Read from the lines without the "> ", the bullet or the indent before each: a text of its own.
				const lines = lineByLine(start, raw, token.text);
				if (lines)
					place(
						{ text: token.text, toSource: (offset) => layer.toSource(lines(offset)) },
						token.tokens as MarkedToken[],
						0,
					);
				break;
			}
			case "table": {
				// A row is a line of the table: the header's the first, the line of dashes next, then one for each row.
				let line = start;
				for (const [row, written] of raw.split("\n").entries()) {
					const cells = row ? token.rows[row - 2] : token.header;
					if (cells) placeCells(layer, cells, written, line);
					line += written.length + 1;
				}
				break;
			}
			case "heading":
				inside(token.text, /^ {0,3}#{1,6}(?=[ \t]|$)[ \t]*/.exec(raw)?.[0].length ?? 0);
				break;
			case "paragraph":
			case "text":
				inside(token.text.slice(box), 0);
				break;
			case "strong":
			case "em":
			case "del":
				inside(token.text, (raw.length - token.text.length) / 2);
				break;
			case "link":
				// Written as it reads, between "<" and ">", or between "[" and "]": a label whose bracket the lexer
				// unescaped is none of these.
				if (raw === token.text || raw === `<${token.text}>` || raw.startsWith(`[${token.text}]`))
					inside(token.text, raw === token.text ? 0 : 1);
				break;
		}
	}
}

/** Gives the tokens of a table row's cells their places, each inside its own cell: between the bars that divide the
 * row, as the lexer divides it (a bar behind an odd count of backslashes is the cell's own). A cell the lexer rewrote
 * (it draws an escaped bar as a bar) gets no place. `line` is the row, and `base` where it stands in the layer. */
function placeCells(layer: Layer, cells: Tokens.Table["header"], line: string, base: number): void {
	const bars = [...line.matchAll(/\|/g)]
		.map((bar) => bar.index)
		.filter((bar) => (/\\*$/.exec(line.slice(0, bar))?.[0].length ?? 0) % 2 === 0);
	const edges = [-1, ...bars, line.length];
	const spans = bars.map((bar, index) => [bar + 1, edges[index + 2] ?? line.length] as const);
	spans.unshift([0, edges[1] ?? line.length]);
	// A bar at the row's start or end leaves an empty cell outside it, which is none.
	if (spans[0] && !line.slice(...spans[0]).trim()) spans.shift();
	const last = spans.at(-1);
	if (last && !line.slice(...last).trim()) spans.pop();
	for (const [index, cell] of cells.entries()) {
		const span = spans[index];
		if (!span) return;
		const inside = line.slice(...span);
		if (inside.trim() === cell.text)
			place(layer, cell.tokens as MarkedToken[], base + span[0] + inside.length - inside.trimStart().length);
	}
}

/** An agent's interface app linked in a message (`app:<name>`): a card the app answers by opening the app's own page
 * (deploy/first-node/RUNTIME-INTERFACE-APPS.md §4). It is drawn plain here, as this has no company: a page's emblem
 * and "App" under the name. Once the company's apps are read it shows the app as the drawer does, its own emblem in
 * its own colour, and what the app is about in one line (app/application.ts).
 * A member's note sent from an app's page (§5 "tell") opens with the same card (views/conversation.ts), with what the
 * note is about as its line (`about`), which stays: once the apps are read, its title becomes the app's own name. */
export function appCard(app: string, name: string | Node[], about?: string): HTMLElement {
	return h(
		"button",
		{
			type: "button",
			class: about === undefined ? "app-card" : "app-card is-note",
			"data-app-name": app,
			title: t("Open {name}", { name: app }),
		},
		h("span", { class: "app-card-emblem", "aria-hidden": "true" }, interfaceEmblem("page", 34)),
		h(
			"span",
			{ class: "app-card-copy" },
			h("strong", { class: "app-card-title" }, name),
			h("small", { class: "app-card-note", title: about }, about ?? t("App")),
		),
		h("span", { class: "app-card-go", "aria-hidden": "true" }, icon("chevron")),
	);
}

/** `links` false draws a link as its text and an image as its alt text: nothing leaves the page or is fetched. */
function renderTokens(tokens: readonly MarkedToken[], depth = 0, links = true): Node[] {
	if (depth > 32) return [document.createTextNode(tokens.map((token) => token.raw).join(""))];
	return tokens.flatMap((token): Node[] => {
		const children = () =>
			renderTokens(("tokens" in token ? (token.tokens ?? []) : []) as MarkedToken[], depth + 1, links);
		switch (token.type) {
			case "space":
			case "def":
			// The list case draws each task checkbox. marked also keeps the "[x] " marker
			// as a token, at the start of the item or of its first paragraph.
			case "checkbox":
				return [];
			case "heading":
				return [h(token.depth <= 2 ? "h2" : "h3", { "data-heading-level": token.depth }, children())];
			case "paragraph": {
				// An app's link among words: the sentence stays whole, with the name as a link, and the app's card stands
				// under it, once however often the sentence names the app. Cards stand in a row of their own
				// (`.app-cards`), never in a paragraph: a thread draws that row under the words' bubble, not in it
				// (`markdownBubbles`).
				const parts = ("tokens" in token ? (token.tokens ?? []) : []) as MarkedToken[];
				const appOf = (part: MarkedToken) =>
					links && part.type === "link" ? appLinkName(decodeEntities(part.href)) : undefined;
				const inner = (part: MarkedToken) =>
					renderTokens(("tokens" in part ? (part.tokens ?? []) : []) as MarkedToken[], depth + 1, links);
				const named = new Set<string>();
				const cards = parts.flatMap((part) => {
					const app = appOf(part);
					if (app === undefined || named.has(app)) return [];
					named.add(app);
					return [appCard(app, inner(part))];
				});
				if (!cards.length) return [h("p", null, children())];
				const row = h("div", { class: "app-cards" }, cards);
				if (parts.every((part) => appOf(part) !== undefined || !part.raw.trim())) return [row];
				return [
					h(
						"p",
						null,
						parts.flatMap((part): Node[] => {
							const app = appOf(part);
							if (app === undefined) return renderTokens([part], depth + 1, links);
							return [
								h(
									"button",
									{
										type: "button",
										class: "folder-link app-link",
										"data-app-name": app,
										title: t("Open {name}", { name: app }),
									},
									inner(part),
								),
							];
						}),
					),
					row,
				];
			}
			case "blockquote":
				return [h("blockquote", null, children())];
			case "strong":
				return [h("strong", null, children())];
			case "em":
				return [h("em", null, children())];
			case "del":
				return [h("del", null, children())];
			case "codespan":
				return [h("code", null, drawn(token, token.text))];
			case "code":
				return [h("pre", null, h("code", null, drawn(token, token.text)))];
			case "br":
				return [h("br")];
			case "hr":
				return [h("hr")];
			case "list":
				return [
					h(
						token.ordered ? "ol" : "ul",
						token.ordered ? { start: token.start || 1 } : null,
						...token.items.map((item) =>
							h(
								"li",
								null,
								item.task
									? h("input", {
											type: "checkbox",
											checked: item.checked,
											disabled: true,
											"aria-label": t("Task status"),
										})
									: null,
								renderTokens(item.tokens as MarkedToken[], depth + 1, links),
							),
						),
					),
				];
			case "table": {
				const cells = (row: typeof token.header, heading: boolean) =>
					row.map((cell) =>
						h(
							heading ? "th" : "td",
							heading ? { scope: "col" } : null,
							renderTokens(cell.tokens as MarkedToken[], depth + 1, links),
						),
					);
				return [
					h(
						"div",
						{ class: "message-table", tabindex: "0", "aria-label": t("Message table") },
						h(
							"table",
							null,
							h("thead", null, h("tr", null, cells(token.header, true))),
							h("tbody", null, ...token.rows.map((row) => h("tr", null, cells(row, false)))),
						),
					),
				];
			}
			case "link":
			case "image": {
				if (!links)
					return token.type === "image"
						? [drawn(token, decodeEntities(token.text))]
						: [h("span", null, children())];
				const content =
					token.type === "image"
						? t("Image: {name}", { name: decodeEntities(token.text) || t("Open image") })
						: children();
				// An agent's interface app where no paragraph placed it (a list's item, a table's cell): its card, in place.
				const app = token.type === "link" ? appLinkName(decodeEntities(token.href)) : undefined;
				if (app !== undefined) return [appCard(app, content)];
				// A file or folder of the company's own Company File: a button the app answers by opening Storage there.
				const path = folderLinkPath(decodeEntities(token.href));
				if (path !== undefined)
					return [
						h(
							"button",
							{
								type: "button",
								class: "folder-link",
								"data-folder-path": path,
								title: t("Open {path} in Storage", { path }),
							},
							content,
						),
					];
				const href = webHref(decodeEntities(token.href));
				return [
					href
						? h("a", { href, target: "_blank", rel: "noopener noreferrer", title: token.title }, content)
						: h("span", null, content),
				];
			}
			case "text":
				return token.tokens ? children() : [drawn(token, decodeEntities(token.text))];
			case "escape":
			case "html":
				return [drawn(token, token.text)];
			default:
				return [drawn(token, token.raw)];
		}
	});
}

export interface MarkdownOptions {
	/** False draws a link as its text and an image as its alt text (an interface's text block, §3.3). */
	readonly links?: boolean;
	/** Only the first block that isn't a heading or a rule: a text block's `show = "first-paragraph"`. */
	readonly firstParagraph?: boolean;
	/** Each drawn run of text keeps which stretch of the source it stands for, so a place in the drawn text can be
	 * found in the text behind it (`markdownSourceOffset`). */
	readonly sourceRanges?: boolean;
}

export function markdown(source: string, options: MarkdownOptions = {}): HTMLElement {
	try {
		// This lexer has no extensions, so its output contains built-in tokens only.
		let tokens = Lexer.lex(source, { gfm: true, breaks: true }) as MarkedToken[];
		if (options.sourceRanges)
			// The source with its line ends as the lexer read them, and as a text area's value has them.
			place({ text: source.replace(/\r\n|\r/g, "\n"), toSource: (offset) => offset }, tokens, 0);
		if (options.firstParagraph) {
			const first = tokens.find((token) => !["space", "def", "heading", "hr"].includes(token.type));
			tokens = first ? [first] : [];
		}
		return h("div", { class: "message-prose" }, renderTokens(tokens, 0, options.links !== false));
	} catch {
		return h("div", { class: "text" }, source);
	}
}

/** A caret as a place in a run of text. One that stands between elements stands at the start of the text after it,
 * or else at the end of the text before it. */
function caretText(node: Node, offset: number): [text: Text, offset: number] | undefined {
	if (node instanceof Text) return [node, offset];
	const texts = (root: Node | undefined) => (root ? document.createTreeWalker(root, NodeFilter.SHOW_TEXT) : undefined);
	const after = node.childNodes[offset];
	const first = after instanceof Text ? after : texts(after)?.firstChild();
	if (first instanceof Text) return [first, 0];
	const before = node.childNodes[offset - 1];
	const last = before instanceof Text ? before : texts(before)?.lastChild();
	return last instanceof Text ? [last, last.data.length] : undefined;
}

/** Where in the source a place in its drawn text falls: `node` and `offset` as a caret gives them, in a drawing that
 * `markdown` made with `sourceRanges`. The place is counted inside the stretch of the source that the run of text
 * draws, never among the marks around it (a link's address, a list's number, a fence's language, a table's bars):
 * a character reference (`&amp;`) counts as the one character it draws where references are read, and as written in
 * code. It is exact or there is none, and nothing is searched for: every token stands where the lexer read it
 * (`place`). The offset is into the source with `\n` line ends, as a text area's value has them. Undefined where no
 * text of the source stands: outside the drawing, or in text whose token the lexer rewrote. */
export function markdownSourceOffset(node: Node, offset: number): number | undefined {
	const caret = caretText(node, offset);
	return caret && drawnFrom.get(caret[0])?.(caret[1]);
}

/** One line of Markdown as inline content (an agent wall's item, ui/agent-wall-poster.ts): emphasis, code and links,
 * the links drawn as in a message (folder links and app cards included), no blocks. */
export function markdownInline(source: string): HTMLElement {
	try {
		const tokens = Lexer.lexInline(source, { gfm: true }) as MarkedToken[];
		return h("span", { class: "message-prose" }, renderTokens(tokens));
	} catch {
		return h("span", { class: "text" }, source);
	}
}

/** Match the desktop's paragraph bubbles without splitting structured blocks.
 * Lex the whole send once so reference links can resolve across bubbles. This
 * is display grouping only: all admitted text stays in its canonical message. */
export function markdownBubbles(source: string): HTMLElement[] {
	try {
		const tokens = Lexer.lex(source, { gfm: true, breaks: true }) as MarkedToken[];
		const groups: MarkedToken[][] = [];
		let boundary = false;
		for (const token of tokens) {
			if (token.type === "space" || token.type === "def") {
				boundary = true;
				continue;
			}
			const previous = groups.at(-1);
			const followsIntroduction =
				(token.type === "list" || token.type === "table") && /[:：]\s*$/.test(previous?.at(-1)?.raw ?? "");
			if (!previous || (boundary && !followsIntroduction)) groups.push([token]);
			else previous.push(token);
			boundary = /\n[\t ]*\n[\t ]*$/.test(token.raw);
		}
		if (!groups.length) return [markdown(source)];
		// A row of app cards is a part of its own, after the words it followed: the thread draws it without a bubble.
		const parts: HTMLElement[] = [];
		for (const group of groups) {
			let prose: Node[] = [];
			const words = () => {
				if (prose.length) parts.push(h("div", { class: "message-prose" }, prose));
				prose = [];
			};
			for (const node of renderTokens(group)) {
				if (node instanceof HTMLElement && node.classList.contains("app-cards")) {
					words();
					parts.push(node);
				} else prose.push(node);
			}
			words();
		}
		return parts;
	} catch {
		return [h("div", { class: "text" }, source)];
	}
}
