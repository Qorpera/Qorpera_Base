/* Tiny DOM helpers. No framework: views build elements and replace children.
 * Text always goes through textContent, never innerHTML. */

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
	const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	if (sameDay) return time;
	const sameYear = date.getFullYear() === now.getFullYear();
	const day = date.toLocaleDateString(
		undefined,
		sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" },
	);
	return `${day}, ${time}`;
}

export function fmtDate(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime())
		? ""
		: date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
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

/* Staff avatars, as the desktop and mobile clients draw them: the creature
 * silhouette used as a mask filled with the agent's colour, plus two white
 * capsule eyes at per-creature positions (QorperaMobile CreatureEyeLayout,
 * which mirrors the desktop's staff-face). Unknown colours fall back to the
 * art's own teal, as both clients do. */
const CREATURES = ["bloom", "brain", "folio", "halo", "pebble", "ribbon", "wisp"] as const;
type Creature = (typeof CREATURES)[number];
const CREATURE_EYES: Record<Creature, [number, number, number, number, number, number, number]> = {
	folio: [0.415, 0.46, 0.552, 0.485, 0.05, 0.08, 6],
	brain: [0.545, 0.36, 0.66, 0.33, 0.05, 0.09, -8],
	halo: [0.435, 0.51, 0.555, 0.53, 0.035, 0.06, -8],
	wisp: [0.41, 0.45, 0.61, 0.48, 0.04, 0.08, 10],
	ribbon: [0.36, 0.39, 0.505, 0.355, 0.04, 0.08, -8],
	bloom: [0.42, 0.47, 0.555, 0.46, 0.04, 0.08, -8],
	pebble: [0.395, 0.325, 0.575, 0.305, 0.04, 0.075, -8],
};
const COLOR_ALIASES: Record<string, string> = {
	"qorpera-terracotta": "#ff642e",
	"qorpera-cobalt": "#1684ff",
	"qorpera-blue": "#1684ff",
	"qorpera-amber": "#ffae00",
	"qorpera-emerald": "#00c878",
	"qorpera-violet": "#8a4dff",
	"qorpera-coral": "#ff365e",
	"qorpera-pink": "#ff2994",
	"qorpera-indigo": "#5367e8",
	"qorpera-teal": "#00bfb3",
	"#cc7d5e": "#ff642e",
	"#e9606f": "#ff365e",
	"#d89b35": "#ffae00",
	"#4caf83": "#00c878",
	"#36a5a2": "#00bfb3",
	"#3f88df": "#1684ff",
	"#8c6dd7": "#8a4dff",
	"#d955a1": "#ff2994",
	"#777772": "#5367e8",
};

export function staffColor(value: string | undefined): string {
	const normalized = (value ?? "").trim().toLowerCase();
	const resolved = COLOR_ALIASES[normalized] ?? normalized;
	return /^#[0-9a-f]{6}$/.test(resolved) ? resolved : "#00bfb3";
}

function isCreature(value: string | undefined): value is Creature {
	return (CREATURES as readonly string[]).includes(value ?? "");
}

function pickCreature(name: string): Creature {
	let seed = 0;
	for (const character of name) seed = (seed * 33 + character.charCodeAt(0)) >>> 0;
	return CREATURES[seed % CREATURES.length] ?? "pebble";
}

export function creatureImage(creature: string | undefined, name: string, color?: string): HTMLElement {
	const kind = isCreature(creature) ? creature : pickCreature(name);
	const [x1, y1, x2, y2, width, height, rotation] = CREATURE_EYES[kind];
	const eye = (x: number, y: number) =>
		h("span", {
			class: "creature-eye",
			dataset: { x: String(x), y: String(y), w: String(width), h: String(height), r: String(rotation) },
		});
	const element = h(
		"span",
		{ class: "creature", dataset: { creature: kind }, "aria-hidden": "true" },
		h("span", { class: "creature-body" }),
		h("span", { class: "creature-face" }, eye(x1, y1), eye(x2, y2)),
	);
	// Geometry is data on the element; the CSSOM sets the properties, so the
	// strict Content Security Policy (no inline style attributes) holds.
	element.style.setProperty("--creature-color", staffColor(color));
	for (const eyeElement of element.querySelectorAll<HTMLElement>(".creature-eye")) {
		const data = eyeElement.dataset;
		eyeElement.style.left = `${Number(data.x) * 100}%`;
		eyeElement.style.top = `${Number(data.y) * 100}%`;
		eyeElement.style.width = `${Number(data.w) * 100}%`;
		eyeElement.style.height = `${Number(data.h) * 100}%`;
		eyeElement.style.transform = `translate(-50%, -50%) rotate(${data.r}deg)`;
	}
	return element;
}

/* The company logo. A company's picture is its logo, and the cloud carries
 * none: the desktop keeps the member's chosen character on the device
 * (CLIENT-CONTRACT.md request 10 asks for a logo field, either a named
 * character or an uploaded image). Until it exists, a company wears a
 * placeholder character derived from its profile id, which survives a rename.
 * The character is drawn the way staff avatars are — silhouette plus eyes — in
 * ink on a paper disc, so a company reads as a character without being
 * mistaken for a member of staff. */
const COMPANY_CHARACTERS = ["halo", "bloom", "folio", "pebble"] as const;
export type CompanyCharacter = (typeof COMPANY_CHARACTERS)[number];
const COMPANY_INK = "#26272b";

export function companyCharacter(seed: string): CompanyCharacter {
	let value = 0n;
	for (const character of seed) value = (value * 33n + BigInt(character.codePointAt(0) ?? 0)) & 0xffffffffffffffffn;
	return COMPANY_CHARACTERS[Number(value % BigInt(COMPANY_CHARACTERS.length))] ?? "halo";
}

export function companyLogo(seed: string, className = ""): HTMLElement {
	const character = companyCharacter(seed);
	return h(
		"span",
		{ class: ["company-logo", className].filter(Boolean).join(" "), "aria-hidden": "true" },
		creatureImage(character, character, COMPANY_INK),
	);
}

export function confirmDialog(message: string, confirmLabel: string, danger = false, typed?: string): Promise<boolean> {
	return new Promise((resolve) => {
		let input: HTMLInputElement | undefined;
		const close = (result: boolean) => {
			dialog.remove();
			resolve(result);
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
		(input ?? confirm).focus();
	});
}
