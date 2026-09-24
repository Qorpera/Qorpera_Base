import { Lexer, type MarkedToken } from "marked";
import { h } from "./dom.ts";
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
 * never automatic remote requests. Raw HTML is always rendered as text. */
function safeHref(href: string): string | undefined {
	try {
		const url = new URL(decodeEntities(href));
		if (["https:", "http:", "mailto:"].includes(url.protocol) && !url.username && !url.password) return url.href;
	} catch {
		// Relative paths and malformed URLs have no destination in this client.
	}
	return undefined;
}

function renderTokens(tokens: readonly MarkedToken[], depth = 0): Node[] {
	if (depth > 32) return [document.createTextNode(tokens.map((token) => token.raw).join(""))];
	return tokens.flatMap((token): Node[] => {
		const children = () => renderTokens(("tokens" in token ? (token.tokens ?? []) : []) as MarkedToken[], depth + 1);
		switch (token.type) {
			case "space":
			case "def":
				return [];
			case "heading":
				return [h(token.depth <= 2 ? "h2" : "h3", { "data-heading-level": token.depth }, children())];
			case "paragraph":
				return [h("p", null, children())];
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
								renderTokens(item.tokens as MarkedToken[], depth + 1),
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
							renderTokens(cell.tokens as MarkedToken[], depth + 1),
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
				const href = safeHref(token.href);
				const content =
					token.type === "image"
						? t("Image: {name}", { name: decodeEntities(token.text) || t("Open image") })
						: children();
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

export function markdown(source: string): HTMLElement {
	try {
		// This lexer has no extensions, so its output contains built-in tokens only.
		return h(
			"div",
			{ class: "message-prose" },
			renderTokens(Lexer.lex(source, { gfm: true, breaks: true }) as MarkedToken[]),
		);
	} catch {
		return h("div", { class: "text" }, source);
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
