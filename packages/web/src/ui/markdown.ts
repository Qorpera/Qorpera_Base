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
				return [h("code", null, token.text)];
			case "code":
				return [h("pre", null, h("code", null, token.text))];
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
						? [document.createTextNode(decodeEntities(token.text))]
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
							h("span", { class: "app-card-emblem", "aria-hidden": "true" }, interfaceEmblem("page", null, 30)),
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
				return token.tokens ? children() : [document.createTextNode(decodeEntities(token.text))];
			case "escape":
			case "html":
				return [document.createTextNode(token.text)];
			default:
				return [document.createTextNode(token.raw)];
		}
	});
}

export interface MarkdownOptions {
	/** False draws a link as its text and an image as its alt text (an interface's text block, §3.3). */
	readonly links?: boolean;
	/** Only the first block that isn't a heading or a rule: a text block's `show = "first-paragraph"`. */
	readonly firstParagraph?: boolean;
}

export function markdown(source: string, options: MarkdownOptions = {}): HTMLElement {
	try {
		// This lexer has no extensions, so its output contains built-in tokens only.
		let tokens = Lexer.lex(source, { gfm: true, breaks: true }) as MarkedToken[];
		if (options.firstParagraph) {
			const first = tokens.find((token) => !["space", "def", "heading", "hr"].includes(token.type));
			tokens = first ? [first] : [];
		}
		return h("div", { class: "message-prose" }, renderTokens(tokens, 0, options.links !== false));
	} catch {
		return h("div", { class: "text" }, source);
	}
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
