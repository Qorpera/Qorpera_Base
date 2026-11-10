import { appLinkName } from "@qorpera/cloud-client/interface-apps";
import { Lexer, type MarkedToken } from "marked";
import { h } from "./dom.ts";
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
 * `folder:` link (ui/folder-links.ts) leaves nothing: it opens the Company File. */
function safeHref(href: string): string | undefined {
	try {
		const url = new URL(decodeEntities(href));
		if (["https:", "http:", "mailto:"].includes(url.protocol) && !url.username && !url.password) return url.href;
	} catch {
		// Relative paths and malformed URLs have no destination in this client.
	}
	return undefined;
}

/** A stretch of the source: where it starts, and its text. */
interface Place {
	readonly start: number;
	readonly raw: string;
}
/** What each token read, for a drawing made with `sourceRanges` (`place`). */
const places = new WeakMap<object, Place>();
/** The stretch of the source each drawn run of text stands for (`markdownSourceOffset`). */
const drawnFrom = new WeakMap<Text, Place>();

/** A token's own text as a node of the page. Where the token has a place, the node keeps the stretch it draws: text
 * that stands inside its token's marks (a code's ticks or fence, an image's brackets) keeps the stretch inside them. */
function drawn(token: MarkedToken, text: string): Text {
	const node = document.createTextNode(text);
	const place = places.get(token);
	if (!place) return node;
	if (token.type !== "code" && token.type !== "codespan" && token.type !== "image") {
		drawnFrom.set(node, place);
		return node;
	}
	// A fence's first line may name a language that the code itself spells too.
	const under = token.type === "code" && token.codeBlockStyle !== "indented" ? place.raw.indexOf("\n") + 1 : 0;
	const at = place.raw.indexOf(text, under);
	drawnFrom.set(
		node,
		at < 0 ? { start: place.start + under, raw: place.raw.slice(under) } : { start: place.start + at, raw: text },
	);
	return node;
}

/** Where `raw`, a token's own account of what it read, stands in `source` between `from` and `to`. A token inside a
 * quote or a list item read its lines without the "> " or the indent before them, so each line after the first may
 * stand behind such a prefix. */
function locate(source: string, raw: string, from: number, to: number): [start: number, end: number] | undefined {
	const [first = "", ...rest] = raw.split("\n");
	for (let start = source.indexOf(first, from); start >= 0 && start + first.length <= to; ) {
		let end = start + first.length;
		const fits = rest.every((line, index) => {
			if (source[end] !== "\n") return false;
			// A line before the last ends where the source's line does.
			const whole = index < rest.length - 1;
			for (let at = end + 1; at + line.length <= to; at++) {
				if (source.startsWith(line, at) && (!whole || source[at + line.length] === "\n")) {
					end = at + line.length;
					return true;
				}
				if (!" \t>".includes(source[at] ?? "\n")) return false;
			}
			return false;
		});
		if (fits) return [start, end];
		// An empty first line is found at every place, the source's end included: only go on while that moves.
		const next = source.indexOf(first, start + 1);
		if (next <= start) break;
		start = next;
	}
	return undefined;
}

/** Gives each token its place in `source` (`places`), in the order the lexer read them: a token stands after the one
 * before it and inside the one that holds it. One that can't be found (the lexer rewrote what it read: a tab, an
 * escaped bar in a table) gets no place, and the text drawn from it none either. Returns where the last one ended. */
function place(source: string, tokens: readonly MarkedToken[], from: number, to: number): number {
	let cursor = from;
	for (const token of tokens) {
		const found = locate(source, token.raw, cursor, to);
		if (!found) continue;
		const [start, end] = found;
		places.set(token, { start, raw: source.slice(start, end) });
		cursor = end;
		if (token.type === "list") place(source, token.items, start, end);
		else if (token.type === "table") {
			const cells = (row: typeof token.header) => row.flatMap((cell) => cell.tokens as MarkedToken[]);
			const header = place(source, cells(token.header), start, end);
			// The line of dashes under the header holds no cell.
			const dashes = source.indexOf("\n", source.indexOf("\n", start) + 1);
			place(source, token.rows.flatMap(cells), dashes > start && dashes < end ? dashes + 1 : header, end);
		} else if ("tokens" in token && token.tokens) {
			// A heading's and a list item's own mark may spell what follows it ("# #", "1. 1").
			const mark =
				token.type === "heading"
					? /^ {0,3}#{1,6}(?=\s|$)/.exec(token.raw)
					: token.type === "list_item"
						? /^[ \t]*(?:[*+-]|\d{1,9}[.)])/.exec(token.raw)
						: null;
			place(source, token.tokens as MarkedToken[], start + (mark?.[0].length ?? 0), end);
		}
	}
	return cursor;
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
				// An app's link among words: the sentence stays whole, with the name as a link, and the card stands under it.
				const parts = ("tokens" in token ? (token.tokens ?? []) : []) as MarkedToken[];
				const appOf = (part: MarkedToken) =>
					links && part.type === "link" ? appLinkName(decodeEntities(part.href)) : undefined;
				const apps = parts.filter((part) => appOf(part) !== undefined);
				if (!apps.length || parts.every((part) => appOf(part) !== undefined || !part.raw.trim()))
					return [h("p", null, children())];
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
										class: "folder-link",
										"data-app-name": app,
										title: t("Open {name}", { name: app }),
									},
									renderTokens(
										("tokens" in part ? (part.tokens ?? []) : []) as MarkedToken[],
										depth + 1,
										links,
									),
								),
							];
						}),
					),
					...renderTokens(apps, depth + 1, links),
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
				// An agent's interface app (`app:<name>`): a card the app answers by opening the app's own page
				// (deploy/first-node/RUNTIME-INTERFACE-APPS.md §4).
				const app = token.type === "link" ? appLinkName(decodeEntities(token.href)) : undefined;
				if (app !== undefined)
					return [
						h(
							"button",
							{
								type: "button",
								class: "app-card",
								"data-app-name": app,
								title: t("Open {name}", { name: app }),
							},
							h("span", { class: "app-card-emblem", "aria-hidden": "true" }, interfaceEmblem("page", 30)),
							h(
								"span",
								{ class: "app-card-copy" },
								h("strong", { class: "app-card-title" }, content),
								h("small", { class: "app-card-note" }, t("App · opens on its own page")),
							),
						),
					];
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
				const href = safeHref(token.href);
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
		if (options.sourceRanges) {
			// The source with its line ends as the lexer read them, and as a text area's value has them.
			const read = source.replace(/\r\n|\r/g, "\n");
			place(read, tokens, 0, read.length);
		}
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
 * stands for, never among the marks around it (a link's address, a list's number, a fence's language): the run's
 * start and end are the stretch's, and in between each drawn character is found in order, a character reference
 * (`&amp;`) as the one character it draws. The offset is into the source with `\n` line ends, as a text area's value
 * has them. Undefined where no text of the source stands: outside the drawing, or in text whose token the lexer
 * rewrote (`place`). */
export function markdownSourceOffset(node: Node, offset: number): number | undefined {
	const caret = caretText(node, offset);
	const from = caret && drawnFrom.get(caret[0]);
	if (!caret || !from) return undefined;
	const [text, index] = caret;
	if (index <= 0) return from.start;
	if (index >= text.data.length) return from.start + from.raw.length;
	let found = 0;
	let end = 0;
	for (const unit of from.raw.matchAll(/&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);|[\s\S]/giu)) {
		const draws = unit[0].length > 1 && unit[0].startsWith("&") ? decodeEntities(unit[0]) : unit[0];
		// What the source holds and the text does not draw: an escape's backslash, the indent of a code's line.
		if (!text.data.startsWith(draws, found)) continue;
		// Inside a reference's one character there is no place: before it.
		if (found + draws.length > index) return from.start + unit.index + (draws === unit[0] ? index - found : 0);
		found += draws.length;
		end = unit.index + unit[0].length;
	}
	return from.start + end;
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
		return groups.length
			? groups.map((group) => h("div", { class: "message-prose" }, renderTokens(group)))
			: [markdown(source)];
	} catch {
		return [h("div", { class: "text" }, source)];
	}
}
