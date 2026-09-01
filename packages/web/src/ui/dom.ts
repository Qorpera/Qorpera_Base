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

export function spinner(label = "Loading"): HTMLElement {
	return h(
		"div",
		{ class: "spinner", role: "status", "aria-label": label },
		h("span", { class: "spinner-dot" }),
		h("span", { class: "spinner-text" }, label),
	);
}

export function creatureImage(creature: string | undefined, name: string): HTMLElement {
	const known = ["bloom", "brain", "folio", "halo", "pebble", "ribbon", "wisp"];
	if (creature && known.includes(creature)) {
		return h("img", {
			class: "creature",
			src: `./assets/staff-creatures/${creature}.png`,
			alt: "",
			width: 40,
			height: 40,
		});
	}
	return h("span", { class: "avatar", "aria-hidden": "true" }, initials(name));
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
