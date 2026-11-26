/* An HTML page from the Company File (an agent's prototype: one file with its styles and scripts inline), shown live
 * and locked down. Each frame loads public/page-preview/, a fixed document under a policy of its own (its meta tag and
 * public/_headers), and the page is handed to it once it is ready:
 * - the sandbox lets scripts run but gives the frame no origin, so the page reaches none of this app's cookies,
 *   storage or sign-in; it can't open windows or dialogs, send forms, start downloads or move this app's page;
 * - its policy lets inline styles and scripts and data: and blob: pictures and fonts in, and nothing from the network:
 *   no request, connection or frame of another site;
 * - no browser lets a policy stop WebRTC, so the frame document takes its interfaces away before the page runs, and
 *   takes out any frame put into the page before it loads (a frame would be a window of its own, with them);
 *   A frame in a shadow tree counts too: the frame document watches every shadow root the page's scripts make, and
 *   a page is handed over only once it is checked to declare none (framePage);
 * - link hints that make the browser look up a name or open a connection (dns-prefetch, preconnect) obey no policy
 *   either: the page's own are taken out before it is handed over (framePage). A hint the page's script adds while
 *   it runs still reaches the network: nothing in a page can stop the browser acting on it. What it can carry out is
 *   what the frame holds: the page itself and what the member types into it, nothing of the app;
 * - this app's own policy (default-src 'self', so frame-src 'self') keeps the frame on this site, and every page of
 *   this site but the frame document refuses to be framed (frame-ancestors 'none').
 * The app's policy also governs a srcdoc or blob: frame, whose inline styles and scripts it would block: that is why
 * the frame is a document of its own. Proven in Chromium with the site's headers by scripts/test-web-page-frame-browser.mjs. */

/** The frame document, beside index.html. */
export const PAGE_FRAME_URL = "./page-preview/";
/** The frame's word that it is ready, and this app's answer carrying the page (public/page-preview/index.html). */
export const PAGE_READY = "qorpera-page-ready";
export const PAGE_CONTENT = "qorpera-page";
/** The frame's word that Escape was pressed in the page and the page left it alone. */
export const PAGE_ESCAPE = "qorpera-page-escape";
/** Link hints the browser acts on without asking the page's policy. */
const NETWORK_HINTS = new Set(["dns-prefetch", "preconnect"]);

/** Template attributes that make the parser attach a shadow root (the second is the older spelling). */
const DECLARATIVE_SHADOW_ROOT = ["shadowrootmode", "shadowroot"];
const LETTER = /[a-z]/i;
const SPACE = /[\t\n\f\r ]/;
const RAW_TEXT = new Set(["iframe", "noembed", "noframes", "plaintext", "script", "style", "textarea", "title", "xmp"]);

export interface InertHtmlParse {
	readonly doc: Document;
	readonly tagAttr: string;
	readonly styleAttr: string;
	readonly endNoframesToken: string;
}

function past(html: string, end: string, from: number): number {
	const found = html.indexOf(end, from);
	return found === -1 ? html.length : found + end.length;
}

function readTag(
	html: string,
	nameAt: number,
): {
	readonly name: string;
	readonly nameAt: number;
	readonly styles: number[];
	readonly end: number;
} {
	let at = nameAt;
	while (at < html.length && !/[\t\n\f\r />]/.test(html[at]!)) at++;
	const name = html.slice(nameAt, at).toLowerCase();
	const styles: number[] = [];
	while (at < html.length && html[at] !== ">") {
		if (SPACE.test(html[at]!) || html[at] === "/") {
			at++;
			continue;
		}
		const start = at++;
		while (at < html.length && !/[\t\n\f\r />=]/.test(html[at]!)) at++;
		if (html.slice(start, at).toLowerCase() === "style") styles.push(start);
		let equals = at;
		while (equals < html.length && SPACE.test(html[equals]!)) equals++;
		if (html[equals] !== "=") continue;
		at = equals + 1;
		while (at < html.length && SPACE.test(html[at]!)) at++;
		const quote = html[at];
		if (quote === '"' || quote === "'") at = past(html, quote, at + 1);
		else while (at < html.length && !/[\t\n\f\r >]/.test(html[at]!)) at++;
	}
	return { name, nameAt, styles, end: Math.min(at + 1, html.length) };
}

function randomNonce(): string {
	const bytes = new Uint8Array(8);
	globalThis.crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function uniqueToken(html: string, prefix: string): string {
	let token = prefix;
	while (html.includes(token)) token += "x";
	return token;
}

// WHY: Chromium enforces the parent document's style-src CSP on DOMParser detached documents and logs violations for
// every <style> and style= attribute; renaming <style> to <noframes> and style= to data-* keeps parsing CSP-quiet,
// treating SVG <style> as raw text intentionally while framePage validates unfit elements via plain DOMParser.
function neutralizeStyles(
	html: string,
	styleTagMarker: string,
	styleAttrName: string,
	endNoframesToken: string,
): string {
	const parts: string[] = [];
	let copied = 0;
	const rename = (from: number, to: string) => {
		parts.push(html.slice(copied, from), to);
		copied = from + "style".length;
	};
	let at = 0;
	while (at < html.length) {
		const open = html.indexOf("<", at);
		if (open === -1) break;
		const after = html[open + 1] ?? "";
		const closing = after === "/" && LETTER.test(html[open + 2] ?? "");
		if (html.startsWith("<!--", open)) at = past(html, "-->", open + 4);
		else if (after === "!" || after === "?" || (after === "/" && !closing)) at = past(html, ">", open + 2);
		else if (!closing && !LETTER.test(after)) at = open + 1;
		else {
			const tag = readTag(html, open + (closing ? 2 : 1));
			if (tag.name === "style") rename(tag.nameAt, closing ? "noframes" : `noframes ${styleTagMarker}=""`);
			if (!closing) for (const attribute of tag.styles) rename(attribute, styleAttrName);
			at = tag.end;
			if (!closing && RAW_TEXT.has(tag.name)) {
				const end = new RegExp(`</${tag.name}(?=[\\t\\n\\f\\r />])`, "gi");
				end.lastIndex = at;
				const closeAt = tag.name === "plaintext" ? html.length : (end.exec(html)?.index ?? html.length);
				if (tag.name === "style" && closeAt > at) {
					const raw = html.slice(at, closeAt);
					if (/<\/noframes/i.test(raw)) {
						parts.push(html.slice(copied, at), raw.replace(/<\/noframes/gi, endNoframesToken));
						copied = closeAt;
					}
				}
				at = closeAt;
			}
		}
	}
	parts.push(html.slice(copied));
	return parts.join("");
}

export function parseHtmlInert(html: string, options?: { readonly fixedStyleAttr?: string }): InertHtmlParse {
	const nonce = randomNonce();
	const tagAttr = uniqueToken(html, `data-qorpera-style-tag-${nonce}`);
	const styleAttr = options?.fixedStyleAttr ?? uniqueToken(html, `data-qorpera-style-${nonce}`);
	const endNoframesToken = uniqueToken(html, `__qorpera_endnf_${nonce}__`);
	const inert = neutralizeStyles(html, tagAttr, styleAttr, endNoframesToken);
	return {
		doc: new DOMParser().parseFromString(inert, "text/html"),
		tagAttr,
		styleAttr,
		endNoframesToken,
	};
}

export function serializeHtmlInert(
	page: Document,
	inert: Pick<InertHtmlParse, "tagAttr" | "styleAttr" | "endNoframesToken">,
): string {
	const raw = `${page.doctype ? new XMLSerializer().serializeToString(page.doctype) : ""}${page.documentElement.outerHTML}`;
	const tagRe = new RegExp(`<noframes\\b([^>]*?)\\s+${inert.tagAttr}(?:="")?([^>]*)>([\\s\\S]*?)<\\/noframes>`, "gi");
	const attrRe = new RegExp(`\\b${inert.styleAttr}(?=[\\t\\n\\f\\r =>/])`, "gi");
	return raw
		.replace(tagRe, "<style$1$2>$3</style>")
		.replace(attrRe, "style")
		.split(inert.endNoframesToken)
		.join("</noframes");
}

function mayContainUnfit(html: string): boolean {
	if (/(?:noscript|shadowroot|dns-prefetch|preconnect)/i.test(html)) return true;
	// WHY: HTML character references can spell a link's rel value (e.g. &#112;reconnect), so any <link with & goes to DOMParser.
	return /<link[\t\n\f\r />]/i.test(html) && html.includes("&");
}

function isHint(link: Element): boolean {
	return (link.getAttribute("rel") ?? "")
		.toLowerCase()
		.split(/[\t\n\f\r ]+/)
		.some((token) => NETWORK_HINTS.has(token));
}

/** What the page may not bring into the frame: a declarative shadow root (the frame document watches only the roots
 * the page's scripts make), a dns-prefetch or preconnect link, and noscript. The frame parses the page with scripting
 * on, this check with it off, and noscript is the only thing that differs between the two (a noscript's content is
 * text there, markup here): with none, the frame's parse is the one checked here. Template contents count, as
 * scripts can bring them in. */
function unfit(page: Document): Element[] {
	const found: Element[] = [];
	const scopes: ParentNode[] = [page];
	for (let index = 0; index < scopes.length; index++)
		for (const element of scopes[index]!.querySelectorAll("noscript, template, link[rel]")) {
			if (element instanceof HTMLTemplateElement) scopes.push(element.content);
			if (
				element.localName === "noscript" ||
				(element.localName === "template" && DECLARATIVE_SHADOW_ROOT.some((name) => element.hasAttribute(name))) ||
				(element.localName === "link" && isHint(element))
			)
				found.push(element);
		}
	return found;
}

export function frameParsedPage(
	page: Document,
	rawHtml?: string,
	inert?: Pick<InertHtmlParse, "tagAttr" | "styleAttr" | "endNoframesToken">,
): string | null {
	if (inert) {
		const candidate = rawHtml !== undefined ? rawHtml : serializeHtmlInert(page, inert);
		return framePage(candidate);
	}
	const found = unfit(page);
	if (found.length === 0 && rawHtml !== undefined) return rawHtml;
	for (const element of found)
		if (element.localName === "template") for (const name of DECLARATIVE_SHADOW_ROOT) element.removeAttribute(name);
		else element.remove();
	const handed = `${page.doctype ? new XMLSerializer().serializeToString(page.doctype) : ""}${page.documentElement.outerHTML}`;
	// WHY: a changed page's text can read back as other markup than the page checked (a script's <!-- swallowing a
	// later </script>); the frame reads the text, so the text is what is checked.
	return unfit(new DOMParser().parseFromString(handed, "text/html")).length === 0 ? handed : null;
}

export function framePage(html: string): string | null {
	if (!mayContainUnfit(html)) return html;
	return frameParsedPage(new DOMParser().parseFromString(html, "text/html"), html);
}
