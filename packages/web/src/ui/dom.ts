/* Tiny DOM helpers. No framework: views build elements and replace children.
 * Text always goes through textContent, never innerHTML. */

import { figureElement } from "./avatar.ts";
import { attachCompanyLogo } from "./company-logos.ts";
import { leave } from "./motion.ts";
import { attachPersonPicture } from "./person-pictures.ts";
import { presentationDay, presentationLocale, systemTimeZone, t, timeZoneOption } from "./preferences.ts";

export type Child = Node | string | number | boolean | null | undefined | Child[];
type Attrs = Record<string, unknown>;

function append(parent: Node, children: Child[]): void {
	for (const child of children) {
		if (child === null || child === undefined || child === false || child === true) continue;
		if (Array.isArray(child)) {
			append(parent, child);
			continue;
		}
		parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
	}
}

/* In-app links carry their place in data-href, not href. A real href makes the browser show the address in a
 * bubble at the bottom of the window on every hover (Jonas, 9 Nov 2026: "can I get rid of this?"), and no page
 * can turn that off. So an in-app link is an <a role="link" tabindex="0"> that one listener on the document
 * follows: a click or Enter goes there, Cmd/Ctrl/Shift-click or a middle click opens it in a new tab. A
 * handler that prevents the click's default still stops it, as it would stop a real link. Links that leave the
 * app (http, mailto, blob) keep their href, so the browser still shows where they go. */
const isInAppHref = (href: string) => href.startsWith("#");

/** Where a link goes, in-app (data-href) or out (href). */
export function linkHref(link: Element): string | null {
	return link.getAttribute("data-href") ?? link.getAttribute("href");
}

/** Points a link somewhere, the way h() would have. */
export function setLinkHref(link: HTMLAnchorElement, href: string): void {
	if (!isInAppHref(href)) {
		link.removeAttribute("data-href");
		link.setAttribute("href", href);
		return;
	}
	link.removeAttribute("href");
	link.setAttribute("data-href", href);
	link.setAttribute("role", "link");
	if (!link.hasAttribute("tabindex")) link.setAttribute("tabindex", "0");
	followInAppLinks(link.ownerDocument);
}

const following = new WeakSet<Document>();
function followInAppLinks(doc: Document): void {
	if (following.has(doc)) return;
	following.add(doc);
	const view = doc.defaultView;
	const target = (event: Event) =>
		event.target instanceof Element ? event.target.closest<HTMLElement>("a[data-href]") : null;
	const go = (link: HTMLElement, newTab: boolean) => {
		const url = new URL(link.getAttribute("data-href")!, doc.baseURI);
		if (!view) return;
		if (newTab) view.open(url.href, "_blank", "noopener");
		// The router's own way (router.ts navigate): only the hash moves.
		else if (url.href.split("#")[0] === view.location.href.split("#")[0]) view.location.hash = url.hash;
		else view.location.assign(url.href);
	};
	doc.addEventListener("click", (event) => {
		const link = target(event);
		if (!link || event.defaultPrevented || event.button !== 0) return;
		// Handled here; jsdom would otherwise follow the link without an href to the page's bare address.
		event.preventDefault();
		go(link, event.metaKey || event.ctrlKey || event.shiftKey);
	});
	doc.addEventListener("auxclick", (event) => {
		const link = target(event);
		if (!link || event.defaultPrevented || event.button !== 1) return;
		event.preventDefault();
		go(link, true);
	});
	doc.addEventListener("keydown", (event) => {
		const link = target(event);
		if (!link || link !== event.target || event.defaultPrevented || event.key !== "Enter" || event.isComposing)
			return;
		event.preventDefault();
		// Enter on a real link fires its click, so the link's own click handlers run first here too.
		if (event.metaKey || event.ctrlKey || event.shiftKey) go(link, true);
		else link.click();
	});
}

export function h<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attrs: Attrs | null = null,
	...children: Child[]
): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag);
	if (attrs) {
		for (const [key, value] of Object.entries(attrs)) {
			if (value === undefined || value === null || value === false) continue;
			if (key === "class") element.className = String(value);
			else if (key === "href" && element instanceof HTMLAnchorElement && isInAppHref(String(value))) {
				// tabindex given in attrs is applied after this and wins.
				setLinkHref(element, String(value));
			} else if (key === "dataset") Object.assign(element.dataset, value as Record<string, string>);
			// Through the CSSOM: the app's Content-Security-Policy (`style-src 'self'`, public/_headers) drops a style
			// attribute the page sets, so a bar's height or a custom property given as an attribute never applied.
			else if (key === "style") element.style.cssText = String(value);
			else if (key.startsWith("on") && typeof value === "function") {
				element.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
			} else if (
				key === "value" ||
				key === "checked" ||
				key === "disabled" ||
				key === "hidden" ||
				key === "selected"
			) {
				(element as unknown as Record<string, unknown>)[key] = value;
			} else element.setAttribute(key, value === true ? "" : String(value));
		}
	}
	append(element, children);
	return element;
}

export function replace(parent: Element, ...children: Child[]): void {
	parent.replaceChildren();
	append(parent, children);
}

const MAX_DATE_FORMATS = 32;
const dateFormats = new Map<string, Intl.DateTimeFormat>();
let taskSystemZone: string | undefined;

function resolvedSystemZone(): string {
	if (taskSystemZone === undefined) {
		taskSystemZone = systemTimeZone();
		queueMicrotask(() => {
			taskSystemZone = undefined;
		});
	}
	return taskSystemZone;
}

export function formatPresentationDate(
	date: Date,
	kind: "time" | "short-date" | "full-date",
	locale = presentationLocale(),
	timeZone = timeZoneOption().timeZone,
): string {
	const zoneKey = timeZone ? `z:${timeZone}` : `s:${resolvedSystemZone()}`;
	const key = `${kind}\0${locale}\0${zoneKey}`;
	let format = dateFormats.get(key);
	if (!format) {
		if (dateFormats.size >= MAX_DATE_FORMATS) dateFormats.clear();
		const zone = timeZone ? { timeZone } : {};
		format = new Intl.DateTimeFormat(
			locale,
			kind === "time"
				? { hour: "2-digit", minute: "2-digit", ...zone }
				: kind === "short-date"
					? { month: "short", day: "numeric", ...zone }
					: { year: "numeric", month: "short", day: "numeric", ...zone },
		);
		dateFormats.set(key, format);
	}
	return format.format(date);
}

/** Times and days are the chosen zone's (Settings → General → Time zone). */
export function fmtTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	const locale = presentationLocale();
	const timeZone = timeZoneOption().timeZone;
	const day = presentationDay(date, timeZone),
		today = presentationDay(new Date(), timeZone);
	const time = formatPresentationDate(date, "time", locale, timeZone);
	if (day === today) return time;
	const sameYear = day.slice(0, 4) === today.slice(0, 4);
	const shown = formatPresentationDate(date, sameYear ? "short-date" : "full-date", locale, timeZone);
	return `${shown}, ${time}`;
}

export function fmtDate(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? "" : formatPresentationDate(date, "full-date");
}

export function fmtBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "";
	const units = ["B", "KiB", "MiB", "GiB", "TiB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${unit === 0 ? value : value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function initials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	const first = parts[0]?.[0] ?? "?";
	const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
	return (first + last).toUpperCase();
}

/** A person's own colour: their initials disc's, and their words at a founding table. */
export function personColor(identity: string): string {
	const colors = ["#778fc6", "#ab829c", "#b18b64", "#789e8d", "#9685b5", "#739eab"];
	let hash = 0;
	for (const character of identity) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
	return colors[hash % colors.length]!;
}

export function personAvatar(name: string, identity: string): HTMLElement {
	const avatar = h("span", { class: "person-avatar", "aria-hidden": "true" }, initials(name));
	avatar.style.setProperty("--person-color", personColor(identity));
	// An account id brings the person's own picture, when they chose one.
	attachPersonPicture(avatar, identity);
	return avatar;
}

export function growToText(field: HTMLTextAreaElement): void {
	const scrolled: [HTMLElement, number][] = [];
	for (let at = field.parentElement; at; at = at.parentElement)
		if (at.scrollTop > 0) scrolled.push([at, at.scrollTop]);
	field.style.height = "auto";
	if (field.scrollHeight > 0) field.style.height = `${field.scrollHeight}px`;
	for (const [at, top] of scrolled) at.scrollTop = top;
}

export function shortId(id: string): string {
	return id.slice(0, 8);
}

export type Tone = "neutral" | "ok" | "warn" | "danger" | "accent";

export function badge(label: string, tone: Tone = "neutral", title?: string): HTMLElement {
	return h("span", { class: `badge badge-${tone}`, ...(title ? { title } : {}) }, label);
}

export function notice(tone: Tone, ...children: Child[]): HTMLElement {
	return h("div", { class: `notice notice-${tone}`, role: tone === "danger" ? "alert" : "status" }, ...children);
}

export function button(
	label: Child,
	onClick: (event: MouseEvent) => void,
	options: { primary?: boolean; danger?: boolean; small?: boolean; disabled?: boolean; title?: string } = {},
): HTMLButtonElement {
	return h(
		"button",
		{
			type: "button",
			class: ["btn", options.primary && "btn-primary", options.danger && "btn-danger", options.small && "btn-small"]
				.filter(Boolean)
				.join(" "),
			disabled: options.disabled === true,
			...(options.title ? { title: options.title } : {}),
			onclick: onClick,
		},
		label,
	);
}

/* Small stroked icons, the desktop's set (Lucide, ISC). Drawn inline so they
 * inherit the row's colour; an <img> could not. */

/** Icons drawn on a grid of their own instead of Lucide's 24, so their lines fall on whole pixels at the size they are
 * shown: the grid's size (the viewBox) and its line. The sidebar's toggle (Jonas, 13 November 2026: it read thin and
 * soft) is drawn for the 20 px box the Concepts viewer gives it at the default scale (styles/conversation.css): a
 * 1.5 px line, Lucide's 1.8 of 24 at that size, so it weighs what the icons beside it weigh. Its lines are centred on
 * quarter pixels, so at 2x every edge is a whole device pixel and at 1x the outline's outer edge is a whole pixel. The
 * outline is 16 by 14, the optical size of the search and plus icons beside it in the rail, with outer corners of 3.5;
 * the divider stands a third in from the panel's side. */
const ICON_GRIDS: Readonly<Record<string, { readonly size: number; readonly stroke: number }>> = {
	navigation: { size: 20, stroke: 1.5 },
};

const ICON_PATHS: Record<string, string[]> = {
	// Lucide list / table-2, matching the existing ISC-licensed icon set.
	list: ["M3 5h.01", "M3 12h.01", "M3 19h.01", "M8 5h13", "M8 12h13", "M8 19h13"],
	table: ["M3 9h18", "M9 3v18"],
	// The sidebar, on a grid of its own (ICON_GRIDS): its outline is a rectangle (icon), this is its divider.
	navigation: ["M7.75 3.75v12.5"],
	interfaces: ["M3 12h4l3-7 4 14 3-7h4"],
	check: ["m5 12 4 4L19 6"],
	bolt: ["M13 2 4.5 13.5H11L10 22l8.5-11.5H12L13 2Z"],
	appearance: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", "M12 3v18", "M12 7h7M12 12h9M12 17h7"],
	image: ["M3 3h18v18H3Z", "m3 16 5-5 4 4 3-3 6 6", "M15 7h.01"],
	camera: [
		"M9 4h6l2 3h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h3Z",
		"M15 13a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
	],
	bell: ["M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"],
	plus: ["M12 5v14M5 12h14"],
	arrow_up: ["M12 19V5", "M5.5 11.5 12 5l6.5 6.5"],
	globe: [
		"M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
		"M3 12h18",
		"M12 3c2.4 2.5 3.6 5.5 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3Z",
	],
	// Two sparks: Generate icon, which asks an agent to draw.
	sparkle: [
		"M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4z",
		"M18 15l.9 2.1 2.1.9-2.1.9L18 21l-.9-2.1-2.1-.9 2.1-.9z",
	],
	// A painter's palette (Lucide palette): the drawer's Colour menu.
	palette: [
		"M12 2.5a9.5 9.5 0 1 0 0 19c1.2 0 1.8-.8 1.8-1.7 0-.5-.2-.9-.5-1.2-.3-.4-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8h2.1a4.8 4.8 0 0 0 4.8-4.8c0-4.6-4.3-8.2-9.5-8.2z",
		"M7.5 11.5h.01",
		"M9.5 7h.01",
		"M14.5 7h.01",
		"M17 10.5h.01",
	],
	code: ["M9 8l-4 4 4 4M15 8l4 4-4 4"],
	feedback: ["M21 15a4 4 0 0 1-4 4H7l-4 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"],
	close: ["m6 6 12 12M6 18 18 6"],
	lock: ["M5 11h14v10H5Z", "M8 11V7a4 4 0 0 1 8 0v4"],
	chevron: ["m9 5 7 7-7 7"],
	"chevron-down": ["m6 9 6 6 6-6"],
	search: ["M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z", "m20 20-3.9-3.9"],
	back: ["m14 5-7 7 7 7M7 12h14"],
	// Lucide reply, reply-all and forward: a mail app's three answers.
	reply: ["m9 17-5-5 5-5", "M20 18v-2a4 4 0 0 0-4-4H4"],
	reply_all: ["m7 17-5-5 5-5", "m12 17-5-5 5-5", "M22 18v-2a4 4 0 0 0-4-4H7"],
	forward: ["m15 17 5-5-5-5", "M4 18v-2a4 4 0 0 1 4-4h12"],
	computer: ["M4 3h16a1 1 0 0 1 1 1v12H3V4a1 1 0 0 1 1-1Z", "M8 21h8M12 16v5"],
	attach: ["m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8", "m8 12 5-5"],
	more: ["M5 12h.01M12 12h.01M19 12h.01"],
	send: ["M12 19V5m-6 6 6-6 6 6"],
	// Lucide mic.
	mic: ["M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z", "M19 10v2a7 7 0 0 1-14 0v-2", "M12 19v3"],
	edit: ["m4 16 11-11a2 2 0 0 1 4 4L8 20H4v-4Z", "m13 7 4 4"],
	file: ["M14 2H5v20h14V7l-5-5ZM14 2v6h5", "M8 12h8M8 16h6"],
	link: ["M9 17H7A5 5 0 0 1 7 7h2", "M15 7h2a5 5 0 1 1 0 10h-2", "M8 12h8"],
	// Lucide arrow-up-right: open in a new tab.
	external: ["M7 17 17 7", "M7 7h10v10"],
	// Lucide power: take something offline.
	power: ["M12 2v10", "M18.4 6.6a9 9 0 1 1-12.77.04"],
	copy: ["M8 8h12v13H8Z", "M16 8V3H3v13h5"],
	mail: [
		"M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z",
		"m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7",
	],
	inbox: [
		"M22 12h-6l-2 3h-4l-2-3H2",
		"M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z",
	],
	at: ["M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z", "M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"],
	webhook: [
		"M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2",
		"m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06",
		"m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8",
	],
	map: ["M12 7v5M5 12h14M5 12v5M19 12v5", "M9 2h6v5H9ZM2 17h6v5H2ZM16 17h6v5h-6Z"],
	clock: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", "M12 7v5l3 2"],
	brain: ["M12 4c-4-4-8 0-6 3-5 1-4 8-1 8-1 5 5 7 7 3M12 4c4-4 8 0 6 3 5 1 4 8 1 8 1 5-5 7-7 3V4"],
	spending: [
		"M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
		"M15.2 8.8c-.7-.5-1.7-.8-2.7-.8-1.5 0-2.7.7-2.7 1.8 0 2.8 5.6 1.3 5.6 4.3 0 1.1-1.1 1.9-2.8 1.9-1.2 0-2.3-.4-3.1-1M12.5 6.3v11.4",
	],
	external_communication: ["m21 3-7.2 18-3.7-7.1L3 10.2zM10.1 13.9 21 3"],
	hard_to_reverse_changes: ["m9 7-5 5 5 5M4 12h10a6 6 0 0 1 6 6"],
	information_sharing: [
		"M20.5 5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z",
		"M8.5 12a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z",
		"M20.5 19a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z",
		"m8.3 10.9 7.4-4.8M8.3 13.1l7.4 4.8",
	],
	info: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", "M12 11v5M12 8h.01"],
	// Lucide hand: the rail's raised hand on an agent whose work waits on the member.
	hand: [
		"M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2",
		"M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2",
		"M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8",
		"M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15",
	],
	settings: [
		"M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z",
		"M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
	],
	trophy: [
		"M6 9H4.5a2.5 2.5 0 0 1 0-5H6",
		"M18 9h1.5a2.5 2.5 0 0 0 0-5H18",
		"M4 22h16",
		"M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22",
		"M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22",
		"M18 2H6v7a6 6 0 0 0 12 0V2Z",
	],
	friends: [
		"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",
		"M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
		"M22 21v-2a4 4 0 0 0-3-3.87",
		"M16 3.13a4 4 0 0 1 0 7.75",
	],
	company: [
		"M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16",
		"M6 10H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-2",
		"M10 8h4M10 12h4",
		"M14 21v-3a2 2 0 0 0-4 0v3",
	],
	connections: ["M12 22v-5", "M9 8V2M15 8V2", "M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"],
	key: [
		"M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4Z",
		"M16.5 7.5h.01",
	],
	plan: ["M2 6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2Z", "M2 10h20", "M6 15h4"],
	signout: ["m16 17 5-5-5-5", "M21 12H9", "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"],
	pin: [
		"M12 17v5",
		"M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1Z",
	],
	unpin: [
		"M12 17v5",
		"M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89",
		"m2 2 20 20",
		"M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11",
	],
	folder: [
		"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
	],
	/* A section's title over two agents' rows, and a plus (Jonas, 11 Nov 2026: the folder with a plus read as files). */
	section_plus: [
		"M3.5 5h7",
		"M18 2.5v6",
		"M15 5.5h6",
		"M9.5 12h11",
		"M9.5 18.5h11",
		"M6.5 12a1.5 1.5 0 1 1-3 0 1.5 1.5 0 1 1 3 0",
		"M6.5 18.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 1 1 3 0",
	],
	/* Back to how it was: Reset sidebar. */
	reset: ["M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5"],
	hide: [
		"M10.73 5.08a10.74 10.74 0 0 1 11.2 6.57 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-1.44 2.49",
		"M14.08 14.16a3 3 0 0 1-4.24-4.24",
		"M17.48 17.5a10.75 10.75 0 0 1-15.42-5.15 1 1 0 0 1 0-.7 10.75 10.75 0 0 1 4.45-5.14",
		"m2 2 20 20",
	],
	show: [
		"M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0",
		"M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
	],
	download: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "m7 10 5 5 5-5", "M12 15V3"],
	// Lucide maximize-2: show something large.
	reload: ["M20 11a8 8 0 1 0-2.3 5.7", "M20 4v7h-7"],
	expand: ["M15 3h6v6", "M9 21H3v-6", "m21 3-7 7", "m3 21 7-7"],
	trash: [
		"M3 6h18",
		"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6",
		"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2",
		"M10 11v6M14 11v6",
	],
};

export function icon(name: keyof typeof ICON_PATHS | string): SVGSVGElement {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	const grid = ICON_GRIDS[name];
	svg.setAttribute("viewBox", `0 0 ${grid?.size ?? 24} ${grid?.size ?? 24}`);
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", String(grid?.stroke ?? 1.8));
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("class", "icon");
	for (const d of ICON_PATHS[name] ?? []) {
		const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
		path.setAttribute("d", d);
		svg.append(path);
	}
	// Lucide layout-grid / table-2 and the sidebar's outline use native rectangles rather than path outlines.
	const rectangles =
		name === "navigation"
			? [[2.75, 3.75, 14.5, 12.5, 2.75]]
			: name === "grid"
				? [
						[3, 3, 7, 7, 1],
						[14, 3, 7, 7, 1],
						[14, 14, 7, 7, 1],
						[3, 14, 7, 7, 1],
					]
				: name === "table"
					? [[3, 3, 18, 18, 2]]
					: [];
	for (const [x, y, width, height, radius] of rectangles) {
		const rectangle = document.createElementNS("http://www.w3.org/2000/svg", "rect");
		for (const [key, value] of Object.entries({ x, y, width, height, rx: radius }))
			rectangle.setAttribute(key, String(value));
		svg.append(rectangle);
	}
	return svg;
}

export function spinner(label = t("Loading")): HTMLElement {
	return h(
		"div",
		{ class: "spinner", role: "status", "aria-label": label },
		h("span", { class: "spinner-dot" }),
		h("span", { class: "spinner-text" }, label),
	);
}

/* The company logo. A company's picture is its logo, and the cloud carries
 * none (CLIENT-CONTRACT.md request 10 asks for a logo field, either a named
 * figure or an uploaded image). Until it exists, a company wears a placeholder
 * figure and colour derived from its profile id, which survive a rename. The
 * Crown is left out: it is the Co-Founder's. The colour is one of the
 * palette's bright colours (avatar-appearance.js), never Charcoal or Slate, so
 * the hub is not a row of black figures (Jonas, 8 November 2026). The moon
 * took the retired ghost's place (10 November 2026); the list keeps its
 * length, so every other company keeps its figure. */
const COMPANY_FIGURES = ["planet", "acorn", "flame", "rocket", "heart", "moon"] as const;
export type CompanyFigure = (typeof COMPANY_FIGURES)[number];
export const COMPANY_COLORS = [
	"#87674c",
	"#e22538",
	"#f96e2d",
	"#fcb51b",
	"#0fbd59",
	"#3faff3",
	"#2047bd",
	"#a145f7",
	"#fa59ac",
] as const;

function seedHash(seed: string, multiplier: bigint): bigint {
	let value = 0n;
	for (const character of seed)
		value = (value * multiplier + BigInt(character.codePointAt(0) ?? 0)) & 0xffffffffffffffffn;
	return value;
}

export function companyFigure(seed: string): CompanyFigure {
	return COMPANY_FIGURES[Number(seedHash(seed, 33n) % BigInt(COMPANY_FIGURES.length))] ?? "planet";
}

/** A second hash, so a company's colour does not follow its figure. */
export function companyColor(seed: string): string {
	return COMPANY_COLORS[Number(seedHash(seed, 131n) % BigInt(COMPANY_COLORS.length))] ?? COMPANY_COLORS[0];
}

/** A company's logo: its own, laid over its figure once the logo store has it (ui/company-logos.ts), else the figure
 * derived from its id. `seed` is the company's id. */
export function companyLogo(seed: string, className = "", unnamed = false): HTMLElement {
	const logo = unnamed
		? h(
				"span",
				{ class: "figure is-unnamed", "aria-hidden": "true" },
				h("span", { class: "company-logo-unknown" }, "?"),
			)
		: figureElement(companyFigure(seed), companyColor(seed), { still: true });
	logo.className = [logo.className, "company-logo", className].filter(Boolean).join(" ");
	attachCompanyLogo(logo, seed);
	return logo;
}

export function confirmDialog(
	message: string,
	confirmLabel: string,
	danger = false,
	typed?: string,
	signal?: AbortSignal,
	/** Lines under the message, as a list: what the choice changes. */
	details?: readonly string[],
): Promise<boolean> {
	if (signal?.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		let input: HTMLInputElement | undefined;
		let closed = false;
		const previousFocus = document.activeElement;
		const close = (result: boolean) => {
			if (closed) return;
			closed = true;
			leave(dialog, "is-leaving", () => dialog.remove());
			signal?.removeEventListener("abort", cancel);
			window.removeEventListener("hashchange", cancel);
			document.removeEventListener("keydown", onKey);
			if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
			resolve(result);
		};
		const cancel = () => close(false);
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				cancel();
			}
			if (event.key !== "Tab") return;
			const fields = [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled), input")];
			const next = event.shiftKey ? fields[fields.length - 1] : fields[0];
			if (
				!dialog.contains(document.activeElement) ||
				document.activeElement === (event.shiftKey ? fields[0] : fields[fields.length - 1])
			) {
				event.preventDefault();
				next?.focus();
			}
		};
		const confirm = button(confirmLabel, () => close(true), { primary: !danger, danger, disabled: Boolean(typed) });
		if (typed) {
			input = h("input", {
				type: "text",
				placeholder: t("Type {name} to confirm", { name: typed }),
				oninput: () => {
					confirm.disabled = input?.value.trim() !== typed;
				},
			});
		}
		const dialog = h(
			"div",
			{ class: "modal-backdrop", onclick: (event: MouseEvent) => event.target === dialog && close(false) },
			h(
				"div",
				{ class: "modal", role: "alertdialog", "aria-modal": "true" },
				h("p", null, message),
				details?.length ? h("ul", { class: "modal-list" }, ...details.map((line) => h("li", null, line))) : null,
				input ?? null,
				h(
					"div",
					{ class: "modal-actions" },
					button(t("Cancel"), () => close(false)),
					confirm,
				),
			),
		);
		document.body.appendChild(dialog);
		signal?.addEventListener("abort", cancel, { once: true });
		window.addEventListener("hashchange", cancel);
		document.addEventListener("keydown", onKey);
		(input ?? confirm).focus();
	});
}
