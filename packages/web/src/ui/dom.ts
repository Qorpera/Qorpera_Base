/* Tiny DOM helpers. No framework: views build elements and replace children.
 * Text always goes through textContent, never innerHTML. */

import { figureElement } from "./avatar.ts";
import { leave } from "./motion.ts";
import { attachPersonPicture } from "./person-pictures.ts";
import { presentationDay, presentationLocale, t, timeZoneOption } from "./preferences.ts";

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
			else if (key === "dataset") Object.assign(element.dataset, value as Record<string, string>);
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

/** Times and days are the chosen zone's (Settings → General → Time zone). */
export function fmtTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	const zone = timeZoneOption();
	const day = presentationDay(date, zone.timeZone),
		today = presentationDay(new Date(), zone.timeZone);
	const time = date.toLocaleTimeString(presentationLocale(), { hour: "2-digit", minute: "2-digit", ...zone });
	if (day === today) return time;
	const sameYear = day.slice(0, 4) === today.slice(0, 4);
	const shown = date.toLocaleDateString(
		presentationLocale(),
		sameYear
			? { month: "short", day: "numeric", ...zone }
			: { year: "numeric", month: "short", day: "numeric", ...zone },
	);
	return `${shown}, ${time}`;
}

export function fmtDate(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime())
		? ""
		: date.toLocaleDateString(presentationLocale(), {
				year: "numeric",
				month: "short",
				day: "numeric",
				...timeZoneOption(),
			});
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
const ICON_PATHS: Record<string, string[]> = {
	// Lucide list / table-2, matching the existing ISC-licensed icon set.
	list: ["M3 5h.01", "M3 12h.01", "M3 19h.01", "M8 5h13", "M8 12h13", "M8 19h13"],
	table: ["M3 9h18", "M9 3v18"],
	navigation: ["M3 5h18v14H3Z", "M9 5v14"],
	interfaces: ["M3 12h4l3-7 4 14 3-7h4"],
	check: ["m5 12 4 4L19 6"],
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
	// qorpera.com's kinds of company (landing/src/site/site.js), so the app's chips match the website's.
	shop: ["M5 8h14l-1.2 11.2a1 1 0 0 1-1 .8H7.2a1 1 0 0 1-1-.8z", "M9 8V6.5a3 3 0 0 1 6 0V8"],
	megaphone: ["M4 10v4h3l6 4V6L7 10z", "M17 9.5a3.5 3.5 0 0 1 0 5"],
	cup: ["M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z", "M16 10h1.5a2.5 2.5 0 0 1 0 5H16", "M9 3.5v2M12 3.5v2"],
	briefcase: [
		"M6 8h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z",
		"M9 8V6a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 6v2M4 13h16",
	],
	brush: ["M14.5 5.5l4 4-2 2-4-4z", "M12.5 7.5L5 15l4 4 7.5-7.5"],
	code: ["M9 8l-4 4 4 4M15 8l4 4-4 4"],
	feedback: ["M21 15a4 4 0 0 1-4 4H7l-4 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"],
	close: ["m6 6 12 12M6 18 18 6"],
	lock: ["M5 11h14v10H5Z", "M8 11V7a4 4 0 0 1 8 0v4"],
	chevron: ["m9 5 7 7-7 7"],
	"chevron-down": ["m6 9 6 6 6-6"],
	search: ["M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z", "m20 20-3.9-3.9"],
	back: ["m14 5-7 7 7 7M7 12h14"],
	computer: ["M4 3h16a1 1 0 0 1 1 1v12H3V4a1 1 0 0 1 1-1Z", "M8 21h8M12 16v5"],
	attach: ["m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8", "m8 12 5-5"],
	more: ["M5 12h.01M12 12h.01M19 12h.01"],
	send: ["M12 19V5m-6 6 6-6 6 6"],
	edit: ["m4 16 11-11a2 2 0 0 1 4 4L8 20H4v-4Z", "m13 7 4 4"],
	file: ["M14 2H5v20h14V7l-5-5ZM14 2v6h5", "M8 12h8M8 16h6"],
	link: ["M9 17H7A5 5 0 0 1 7 7h2", "M15 7h2a5 5 0 1 1 0 10h-2", "M8 12h8"],
	copy: ["M8 8h12v13H8Z", "M16 8V3H3v13h5"],
	mail: [
		"M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z",
		"m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7",
	],
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
	settings: [
		"M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z",
		"M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
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
	folder_plus: [
		"M12 10v6M9 13h6",
		"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
	],
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
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "1.8");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("class", "icon");
	for (const d of ICON_PATHS[name] ?? []) {
		const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
		path.setAttribute("d", d);
		svg.append(path);
	}
	// Lucide layout-grid / table-2 use native rectangles rather than path outlines.
	const rectangles =
		name === "grid"
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
 * palette's bright colours (avatar-appearance.js), never Charcoal or Gray, so
 * the hub is not a row of black figures (Jonas, 8 November 2026). */
const COMPANY_FIGURES = ["planet", "acorn", "flame", "rocket", "heart", "ghost"] as const;
export type CompanyFigure = (typeof COMPANY_FIGURES)[number];
export const COMPANY_COLORS = [
	"#87674c",
	"#ff365e",
	"#f96e2d",
	"#fcb51b",
	"#00c878",
	"#00bfb3",
	"#2047bd",
	"#b83ff5",
	"#ff2994",
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

export function companyLogo(seed: string, className = ""): HTMLElement {
	const logo = figureElement(companyFigure(seed), companyColor(seed), { still: true });
	logo.className = [logo.className, "company-logo", className].filter(Boolean).join(" ");
	return logo;
}

export function confirmDialog(
	message: string,
	confirmLabel: string,
	danger = false,
	typed?: string,
	signal?: AbortSignal,
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
