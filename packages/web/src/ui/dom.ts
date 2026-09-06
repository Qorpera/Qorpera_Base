/* Tiny DOM helpers. No framework: views build elements and replace children.
 * Text always goes through textContent, never innerHTML. */

import { figureElement } from "./avatar.ts";
import { presentationLocale } from "./preferences.ts";

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

export function fmtTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	const now = new Date();
	const sameDay = date.toDateString() === now.toDateString();
	const time = date.toLocaleTimeString(presentationLocale(), { hour: "2-digit", minute: "2-digit" });
	if (sameDay) return time;
	const sameYear = date.getFullYear() === now.getFullYear();
	const day = date.toLocaleDateString(
		presentationLocale(),
		sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" },
	);
	return `${day}, ${time}`;
}

export function fmtDate(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime())
		? ""
		: date.toLocaleDateString(presentationLocale(), { year: "numeric", month: "short", day: "numeric" });
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

export function personAvatar(name: string, identity: string): HTMLElement {
	const colors = ["#778fc6", "#ab829c", "#b18b64", "#789e8d", "#9685b5", "#739eab"];
	let hash = 0;
	for (const character of identity) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
	const avatar = h("span", { class: "person-avatar", "aria-hidden": "true" }, initials(name));
	avatar.style.setProperty("--person-color", colors[hash % colors.length]!);
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
	navigation: ["M3 5h18v14H3Z", "M9 5v14"],
	check: ["m5 12 4 4L19 6"],
	image: ["M3 3h18v18H3Z", "m3 16 5-5 4 4 3-3 6 6", "M15 7h.01"],
	bell: ["M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"],
	plus: ["M12 5v14M5 12h14"],
	feedback: ["M21 15a4 4 0 0 1-4 4H7l-4 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"],
	close: ["m6 6 12 12M6 18 18 6"],
	chevron: ["m9 5 7 7-7 7"],
	back: ["m14 5-7 7 7 7M7 12h14"],
	computer: ["M4 3h16a1 1 0 0 1 1 1v12H3V4a1 1 0 0 1 1-1Z", "M8 21h8M12 16v5"],
	attach: ["m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8", "m8 12 5-5"],
	more: ["M5 12h.01M12 12h.01M19 12h.01"],
	send: ["M12 19V5m-6 6 6-6 6 6"],
	edit: ["m4 16 11-11a2 2 0 0 1 4 4L8 20H4v-4Z", "m13 7 4 4"],
	file: ["M14 2H5v20h14V7l-5-5ZM14 2v6h5", "M8 12h8M8 16h6"],
	copy: ["M8 8h12v13H8Z", "M16 8V3H3v13h5"],
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
	invitations: ["M22 6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6Z", "m22 7-10 6L2 7"],
	signout: ["m16 17 5-5-5-5", "M21 12H9", "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"],
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
	return svg;
}

export function spinner(label = "Loading"): HTMLElement {
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
 * figure derived from its profile id, which survives a rename. The Crown is
 * left out: it is the Co-Founder's. */
const COMPANY_FIGURES = ["planet", "acorn", "flame", "rocket", "heart", "ghost"] as const;
export type CompanyFigure = (typeof COMPANY_FIGURES)[number];
const COMPANY_INK = "#312f2d";

export function companyFigure(seed: string): CompanyFigure {
	let value = 0n;
	for (const character of seed) value = (value * 33n + BigInt(character.codePointAt(0) ?? 0)) & 0xffffffffffffffffn;
	return COMPANY_FIGURES[Number(value % BigInt(COMPANY_FIGURES.length))] ?? "planet";
}

export function companyLogo(seed: string, className = ""): HTMLElement {
	const logo = figureElement(companyFigure(seed), COMPANY_INK, { still: true });
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
			dialog.remove();
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
				placeholder: `Type ${typed} to confirm`,
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
					button("Cancel", () => close(false)),
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
