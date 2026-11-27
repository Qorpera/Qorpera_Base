import { parseHtmlInert } from "./page-frame.ts";

export const MAIL_FRAME_URL = "./mail-preview/";
export const MAIL_READY = "qorpera-mail-ready";
export const MAIL_INIT = "qorpera-mail";
export const MAIL_RENDER = "qorpera-mail-render";
export const MAIL_HEIGHT = "qorpera-mail-height";
export const MAIL_OPEN = "qorpera-mail-open";
export const MAIL_ESCAPE = "qorpera-mail-escape";

const MAX_HEIGHT_PX = 50_000;
const INITIAL_HEIGHT_PX = 120;
const MAX_HREF_LENGTH = 4096;

const DROPPED_TAGS = new Set([
	"script",
	"noscript",
	"noframes",
	"iframe",
	"frame",
	"frameset",
	"object",
	"embed",
	"applet",
	"portal",
	"fencedframe",
	"base",
	"meta",
	"link",
	"title",
	"audio",
	"video",
	"source",
	"track",
	"template",
	"textarea",
	"select",
	"option",
	"input",
	"canvas",
	"dialog",
	"foreignobject",
	"animate",
	"animatemotion",
	"animatetransform",
	"set",
	"feimage",
	"handler",
	"listener",
]);

const DROPPED_ATTRS = new Set([
	"srcdoc",
	"formaction",
	"action",
	"method",
	"enctype",
	"ping",
	"autofocus",
	"autoplay",
	"shadowrootmode",
	"shadowroot",
	"integrity",
	"nonce",
	"is",
	"poster",
	"cite",
	"longdesc",
	"lowsrc",
	"dynsrc",
]);

const BLOCK_TAGS = new Set([
	"address",
	"article",
	"aside",
	"blockquote",
	"dd",
	"div",
	"dl",
	"dt",
	"fieldset",
	"figcaption",
	"figure",
	"footer",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"header",
	"hr",
	"li",
	"main",
	"nav",
	"ol",
	"p",
	"pre",
	"section",
	"table",
	"tr",
	"ul",
]);

const RASTER_DATA_IMAGE =
	/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/=\s]+$/i;
const SAFE_COLOR = /^(?:#[0-9a-f]{3,8}|[a-z]{3,20}|rgba?\(\s*[\d.%\s,/]+\)|hsla?\(\s*[\d.%\s,/a-z]+\))$/i;
const INVISIBLE_CHARS = /(?:\u034f|\u200b|\u200c|\u200d|\ufeff|\u00ad)+/g;

export interface SanitizedMailHtml {
	readonly styles: readonly string[];
	readonly bodyHtml: string;
	readonly bodyStyle: string;
	readonly bodyBg: string;
	readonly bodyDir: "ltr" | "rtl" | "auto" | "";
	readonly remoteImageCount: number;
	readonly hasContent: boolean;
}

export interface MailFramePayload {
	readonly styles: readonly string[];
	readonly bodyHtml: string;
	readonly bodyStyle: string;
	readonly bodyBg: string;
	readonly bodyDir: "ltr" | "rtl" | "auto" | "";
}

function stripControls(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]+/g, "").trim();
}

export function safeMailHref(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const cleaned = stripControls(value);
	if (!cleaned || cleaned.length > MAX_HREF_LENGTH) return null;
	if (cleaned.startsWith("#")) return cleaned;
	let parsed: URL;
	try {
		parsed = new URL(cleaned);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:" && parsed.protocol !== "mailto:") return null;
	return parsed.href;
}

function safeHttpsImageUrl(value: string): string | null {
	const cleaned = stripControls(value);
	if (!cleaned || cleaned.length > MAX_HREF_LENGTH) return null;
	let parsed: URL;
	try {
		parsed = new URL(cleaned);
	} catch {
		return null;
	}
	return parsed.protocol === "https:" ? parsed.href : null;
}

function safeRasterDataUri(value: string): string | null {
	const cleaned = stripControls(value);
	return RASTER_DATA_IMAGE.test(cleaned) ? cleaned.replace(/\s+/g, "") : null;
}

function decodeCssEscapes(css: string): string {
	return css
		.replace(/\\([0-9a-fA-F]{1,6})[\t\n\f\r ]?/g, (match, hex: string) => {
			const code = Number.parseInt(hex, 16);
			if (code < 0x20 || code === 0x22 || code === 0x27 || code === 0x5c || code > 0x10ffff) return match;
			if (code >= 0xd800 && code <= 0xdfff) return "\ufffd";
			return String.fromCodePoint(code);
		})
		.replace(/\\([g-zG-Z])/g, "$1");
}

function escapeCssUrl(url: string): string {
	return url.replace(/[\\"'\n\r\f]/g, (character) => `\\${character.codePointAt(0)!.toString(16)} `);
}

function replaceCssFunction(css: string, pattern: RegExp, replacement: string): string {
	let out = "";
	let cursor = 0;
	pattern.lastIndex = 0;
	for (;;) {
		const match = pattern.exec(css);
		if (!match) break;
		out += css.slice(cursor, match.index) + replacement;
		let depth = 1;
		let index = match.index + match[0].length;
		let quote = "";
		while (index < css.length && depth > 0) {
			const ch = css[index]!;
			if (quote) {
				if (ch === "\\") index += 2;
				else {
					if (ch === quote) quote = "";
					index += 1;
				}
				continue;
			}
			if (ch === '"' || ch === "'") quote = ch;
			else if (ch === "(") depth += 1;
			else if (ch === ")") depth -= 1;
			index += 1;
		}
		cursor = index;
		pattern.lastIndex = cursor;
	}
	return out + css.slice(cursor);
}

function sanitizeCssUrls(css: string, allowRemoteImages: boolean, counter: { remoteImages: number } | null): string {
	return css.replace(
		/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s][^)]*))\s*\)/gi,
		(_match, dq: string | undefined, sq: string | undefined, bare: string | undefined) => {
			const raw = (dq ?? sq ?? bare ?? "").trim();
			const data = safeRasterDataUri(raw);
			if (data) return `url("${data}")`;
			const https = safeHttpsImageUrl(raw);
			if (https && counter) {
				counter.remoteImages += 1;
				return allowRemoteImages ? `url("${escapeCssUrl(https)}")` : "none";
			}
			return "none";
		},
	);
}

function sanitizeCss(css: string, allowRemoteImages: boolean, counter: { remoteImages: number }): string {
	let cleaned = css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, " ");
	cleaned = decodeCssEscapes(cleaned);
	cleaned = cleaned.replace(/@(?:import|charset|namespace)\b[^;{}]*(?:;|$)/gi, "");
	cleaned = replaceCssFunction(cleaned, /(?:-webkit-)?image-set\s*\(/gi, "none");
	cleaned = replaceCssFunction(cleaned, /\bexpression\s*\(/gi, "none");
	cleaned = cleaned.replace(/(?:-moz-binding|behavior)\s*:[^;{}]*/gi, "");
	cleaned = cleaned.replace(/\bposition\s*:\s*fixed\b/gi, "position: static");
	cleaned = cleaned.replace(/@font-face\s*\{[^}]*\}/gi, (block) => sanitizeCssUrls(block, false, null));
	cleaned = sanitizeCssUrls(cleaned, allowRemoteImages, counter);
	return cleaned.trim();
}

function parseCssPixels(style: string, prop: "width" | "height"): number | null {
	const match = new RegExp(
		`(?:^|;)\\s*${prop}\\s*:\\s*([0-9]+(?:\\.[0-9]+)?)\\s*(px)?\\s*(?:!important)?\\s*(?:;|$)`,
		"i",
	).exec(style);
	if (!match) return null;
	const value = Number(match[1]);
	return Number.isFinite(value) ? value : null;
}

function parseAttrPixels(el: Element, name: "width" | "height"): number | null {
	const raw = el.getAttribute(name)?.trim();
	if (!raw) return null;
	const match = /^([0-9]+(?:\.[0-9]+)?)(?:px)?$/i.exec(raw);
	if (!match) return null;
	const value = Number(match[1]);
	return Number.isFinite(value) ? value : null;
}

function isTrackingPixel(el: Element, style: string): boolean {
	if (
		/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0+)?(?:\s*;|\s*!important|\s*$))/i.test(
			style,
		)
	)
		return true;
	const w = parseAttrPixels(el, "width") ?? parseCssPixels(style, "width");
	const h = parseAttrPixels(el, "height") ?? parseCssPixels(style, "height");
	if (w === 0 || h === 0) return true;
	return w !== null && h !== null && w <= 1 && h <= 1;
}

function splitSrcset(raw: string): string[] {
	const entries: string[] = [];
	let start = 0;
	let index = 0;
	while (index < raw.length) {
		while (index < raw.length && /[\s,]/.test(raw[index]!)) index += 1;
		if (index >= raw.length) break;
		start = index;
		if (/^data:/i.test(raw.slice(index))) {
			const comma = raw.indexOf(",", index);
			if (comma !== -1) index = comma + 1;
		}
		while (index < raw.length && !/\s/.test(raw[index]!)) {
			if (raw[index] === "," && index > start) break;
			index += 1;
		}
		while (index < raw.length && raw[index] !== ",") index += 1;
		const item = raw.slice(start, index).trim();
		if (item) entries.push(item);
		index += 1;
	}
	return entries;
}

function sanitizeSrcset(
	raw: string,
	allowRemoteImages: boolean,
	tracking: boolean,
): { readonly kept: string | null; readonly hadRemote: boolean } {
	const kept: string[] = [];
	let hadRemote = false;
	for (const entry of splitSrcset(raw)) {
		const parts = entry.split(/\s+/);
		const url = parts[0] ?? "";
		const descriptor = parts.slice(1).join(" ");
		if (descriptor && !/^(?:\d+(?:\.\d+)?x|\d+w)$/i.test(descriptor)) continue;
		const data = safeRasterDataUri(url);
		if (data) {
			kept.push(descriptor ? `${data} ${descriptor}` : data);
			continue;
		}
		const https = safeHttpsImageUrl(url);
		if (https) {
			hadRemote = true;
			if (!tracking && allowRemoteImages) kept.push(descriptor ? `${https} ${descriptor}` : https);
		}
	}
	return { kept: kept.length > 0 ? kept.join(", ") : null, hadRemote };
}

function safeColor(value: string | null): string {
	if (!value) return "";
	const cleaned = value.trim();
	return SAFE_COLOR.test(cleaned) ? cleaned : "";
}

function safeDir(value: string | null): "ltr" | "rtl" | "auto" | "" {
	const cleaned = value?.trim().toLowerCase();
	return cleaned === "ltr" || cleaned === "rtl" || cleaned === "auto" ? cleaned : "";
}

export function sanitizeMailHtml(
	rawHtml: string,
	options: { readonly allowRemoteImages?: boolean } = {},
): SanitizedMailHtml {
	const allowRemoteImages = options.allowRemoteImages === true;
	const inert = parseHtmlInert(rawHtml);
	const { doc } = inert;
	const counter = { remoteImages: 0 };
	const styles: string[] = [];

	for (const styleTag of [...doc.querySelectorAll(`noframes[${inert.tagAttr}]`)]) {
		if (!styleTag.closest("noscript, template")) {
			const rawCss = (styleTag.textContent ?? "").split(inert.endNoframesToken).join("</noframes");
			const cleaned = sanitizeCss(rawCss, allowRemoteImages, counter);
			if (cleaned) styles.push(cleaned);
		}
		styleTag.remove();
	}

	const rawBodyStyle = doc.body.getAttribute(inert.styleAttr) ?? "";
	const bodyStyle = rawBodyStyle ? sanitizeCss(rawBodyStyle, allowRemoteImages, counter) : "";
	const bodyBg = safeColor(doc.body.getAttribute("bgcolor"));
	const bodyDir = safeDir(doc.body.getAttribute("dir") ?? doc.documentElement.getAttribute("dir"));

	const queue: Element[] = [...doc.body.children];
	for (let cursor = 0; cursor < queue.length; cursor += 1) {
		const el = queue[cursor]!;
		const tag = el.localName.toLowerCase();
		if (DROPPED_TAGS.has(tag)) {
			el.remove();
			continue;
		}
		const rawInlineStyle = el.getAttribute(inert.styleAttr) ?? "";
		const tracking = tag === "img" && isTrackingPixel(el, rawInlineStyle);
		let sanitizedStyle = "";
		if (rawInlineStyle) sanitizedStyle = sanitizeCss(rawInlineStyle, allowRemoteImages, counter);

		let imageHasAllowedSrc = false;
		let imageHasRemote = false;

		for (const attr of [...el.attributes]) {
			const lower = attr.name.toLowerCase();
			if (lower === inert.styleAttr) {
				if (sanitizedStyle) el.setAttribute(inert.styleAttr, sanitizedStyle);
				else el.removeAttribute(attr.name);
				continue;
			}
			if (lower.startsWith("on") || lower.startsWith("data-qorpera-") || DROPPED_ATTRS.has(lower)) {
				el.removeAttribute(attr.name);
				continue;
			}
			if (lower === "href" || lower === "xlink:href") {
				if (tag === "a" || tag === "area") {
					const safe = safeMailHref(attr.value);
					if (safe) {
						el.setAttribute("href", safe);
						if (lower !== "href") el.removeAttribute(attr.name);
					} else el.removeAttribute(attr.name);
				} else if (tag === "use" && /^#[A-Za-z0-9_-]+$/.test(attr.value.trim())) {
					el.setAttribute(attr.name, attr.value.trim());
				} else {
					el.removeAttribute(attr.name);
				}
				continue;
			}
			if (lower === "src") {
				if (tag !== "img") {
					el.removeAttribute(attr.name);
					continue;
				}
				const data = safeRasterDataUri(attr.value);
				if (data) {
					el.setAttribute("src", data);
					imageHasAllowedSrc = true;
					continue;
				}
				const https = safeHttpsImageUrl(attr.value);
				if (https) {
					imageHasRemote = true;
					if (!tracking && allowRemoteImages) {
						el.setAttribute("src", https);
						el.setAttribute("referrerpolicy", "no-referrer");
						imageHasAllowedSrc = true;
						continue;
					}
				}
				el.removeAttribute(attr.name);
				continue;
			}
			if (lower === "srcset") {
				if (tag !== "img") {
					el.removeAttribute(attr.name);
					continue;
				}
				const { kept, hadRemote } = sanitizeSrcset(attr.value, allowRemoteImages, tracking);
				if (hadRemote) imageHasRemote = true;
				if (kept) {
					el.setAttribute("srcset", kept);
					if (hadRemote && allowRemoteImages) el.setAttribute("referrerpolicy", "no-referrer");
					imageHasAllowedSrc = true;
				} else {
					el.removeAttribute(attr.name);
				}
				continue;
			}
			if (lower === "background") {
				const data = safeRasterDataUri(attr.value);
				if (data) {
					el.setAttribute("background", data);
					continue;
				}
				const https = safeHttpsImageUrl(attr.value);
				if (https) {
					counter.remoteImages += 1;
					if (allowRemoteImages) {
						el.setAttribute("background", https);
						continue;
					}
				}
				el.removeAttribute(attr.name);
				continue;
			}
			if (lower === "target" && tag !== "a" && tag !== "area") {
				el.removeAttribute(attr.name);
			}
		}

		if (tag === "img" && imageHasRemote && !tracking) counter.remoteImages += 1;

		if (tag === "a" || tag === "area") {
			if (el.hasAttribute("href")) {
				el.setAttribute("rel", "noopener noreferrer");
				el.setAttribute("target", "_blank");
			} else {
				el.removeAttribute("target");
			}
		} else if (tag === "button") {
			el.setAttribute("type", "button");
		} else if (tag === "img" && !imageHasAllowedSrc) {
			const alt = (el.getAttribute("alt") ?? "").replace(INVISIBLE_CHARS, "").trim();
			el.setAttribute("data-qorpera-hidden-img", !tracking && alt ? "alt" : "empty");
			if (tracking && imageHasRemote) el.removeAttribute("alt");
		}

		for (const child of el.children) queue.push(child);
	}

	const visibleText = (doc.body.textContent ?? "").replace(INVISIBLE_CHARS, "").trim();
	const hasVisual =
		doc.body.querySelector('img[src], img[data-qorpera-hidden-img="alt"], svg, hr') !== null ||
		counter.remoteImages > 0;
	const attrRe = new RegExp(`\\b${inert.styleAttr}(?=[\\t\\n\\f\\r =>/])`, "gi");
	const bodyHtml = doc.body.innerHTML.replace(attrRe, "style");

	return {
		styles,
		bodyHtml,
		bodyStyle,
		bodyBg,
		bodyDir,
		remoteImageCount: counter.remoteImages,
		hasContent: visibleText.length > 0 || hasVisual,
	};
}

export function mailHtmlToText(rawHtml: string): string {
	const inert = parseHtmlInert(rawHtml);
	const { doc } = inert;
	for (const el of [
		...doc.querySelectorAll(`head, style, script, title, noscript, template, noframes[${inert.tagAttr}]`),
	])
		el.remove();
	const parts: string[] = [];
	const walk = (node: Node): void => {
		if (node.nodeType === Node.TEXT_NODE) {
			const value = (node.textContent ?? "").replace(INVISIBLE_CHARS, "");
			if (value) parts.push(value);
			return;
		}
		if (node.nodeType !== Node.ELEMENT_NODE) return;
		const tag = (node as Element).localName.toLowerCase();
		if (tag === "br") {
			parts.push("\n");
			return;
		}
		const block = BLOCK_TAGS.has(tag);
		if (block) parts.push("\n");
		for (const child of node.childNodes) walk(child);
		if (block) parts.push("\n");
		else if (tag === "td" || tag === "th") parts.push(" ");
	};
	walk(doc.body);
	return parts
		.join("")
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/[ \t\f\v\u00a0]+/g, " ").trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export interface MailFrameCallbacks {
	readonly onOpen: (href: string) => void;
	readonly onEscape?: () => void;
}

export class MailFrame {
	readonly frame: HTMLIFrameElement;
	#payload: MailFramePayload;
	readonly #callbacks: MailFrameCallbacks;
	readonly #lifetime = new AbortController();
	#port: MessagePort | undefined;
	#height = INITIAL_HEIGHT_PX;

	constructor(payload: MailFramePayload, title: string, callbacks: MailFrameCallbacks) {
		this.#payload = payload;
		this.#callbacks = callbacks;
		const frame = document.createElement("iframe");
		frame.className = "mailbox-html-frame";
		frame.setAttribute("sandbox", "allow-scripts");
		frame.setAttribute("referrerpolicy", "no-referrer");
		frame.setAttribute("src", MAIL_FRAME_URL);
		frame.title = title;
		frame.style.height = `${this.#height}px`;
		this.frame = frame;
		window.addEventListener("message", (event) => this.#onWindowMessage(event), {
			signal: this.#lifetime.signal,
		});
	}

	update(payload: MailFramePayload): void {
		this.#payload = payload;
		if (!this.#port || this.#lifetime.signal.aborted) return;
		this.#port.postMessage({ type: MAIL_RENDER, ...payload });
	}

	dispose(): void {
		this.#lifetime.abort();
		this.#port?.close();
		this.#port = undefined;
	}

	#onWindowMessage(event: MessageEvent): void {
		if (event.source === null || event.source !== this.frame.contentWindow) return;
		const data = event.data as { type?: unknown } | null;
		if (!data || typeof data !== "object" || data.type !== MAIL_READY) return;
		if (this.#lifetime.signal.aborted) return;
		this.#port?.close();
		const channel = new MessageChannel();
		this.#port = channel.port1;
		channel.port1.addEventListener("message", (msg) => this.#onPortMessage(msg.data), {
			signal: this.#lifetime.signal,
		});
		channel.port1.start();
		this.frame.contentWindow?.postMessage({ type: MAIL_INIT, ...this.#payload }, "*", [channel.port2]);
	}

	#onPortMessage(data: unknown): void {
		if (!data || typeof data !== "object" || Array.isArray(data)) return;
		const message = data as Record<string, unknown>;
		if (message.type === MAIL_HEIGHT) {
			const height = message.height;
			if (typeof height !== "number" || !Number.isFinite(height) || height < 0) return;
			const next = Math.min(MAX_HEIGHT_PX, Math.max(24, Math.ceil(height)));
			if (next !== this.#height) {
				this.#height = next;
				this.frame.style.height = `${next}px`;
			}
			return;
		}
		if (message.type === MAIL_OPEN) {
			const href = safeMailHref(message.href);
			if (href && !href.startsWith("#")) this.#callbacks.onOpen(href);
			return;
		}
		if (message.type === MAIL_ESCAPE) {
			this.#callbacks.onEscape?.();
		}
	}
}
