import { h, icon } from "./dom.ts";
import { matchesKey } from "./keys.ts";

/* A right-click menu, Grok Bot's shape: icon rows, separators, a submenu that
 * opens beside its row, a destructive last row. One menu is open at a time; it
 * closes on a choice, Escape, Tab, a press outside, a scroll behind it, a resize
 * or a route change, and hands focus back to what opened it. */

export type MenuEntry =
	| {
			kind?: "item";
			label: string;
			icon?: string;
			danger?: boolean;
			/** A radio choice in a submenu: the current one carries a check. */
			checked?: boolean;
			select: () => void;
	  }
	| { kind: "submenu"; label: string; icon?: string; items: MenuEntry[] }
	| { kind: "separator" };

export interface ContextMenuOptions {
	label: string;
	/** Where the pointer was, in viewport pixels. The menu opens down and to the right of it. */
	x: number;
	y: number;
	items: MenuEntry[];
	/** Gets focus back when the menu closes, and a class while it is open. */
	opener?: HTMLElement;
	onClose?: () => void;
}

export interface ContextMenu {
	readonly el: HTMLElement;
	close(): void;
}

const MARGIN = 8;
let active: ContextMenu | undefined;

/** The open menu, if any (tests and the rail read it). */
export function openMenu(): ContextMenu | undefined {
	return active;
}

/** Places a fixed element at (x, y), flipped or clamped to stay on screen. */
function place(element: HTMLElement, x: number, y: number, flipX?: number): void {
	const { width, height } = element.getBoundingClientRect();
	let left = x;
	if (left + width > window.innerWidth - MARGIN)
		left = flipX !== undefined ? flipX - width : window.innerWidth - width - MARGIN;
	let top = y;
	if (top + height > window.innerHeight - MARGIN) top = Math.max(MARGIN, window.innerHeight - height - MARGIN);
	element.style.left = `${Math.max(MARGIN, left)}px`;
	element.style.top = `${Math.max(MARGIN, top)}px`;
}

function menuItems(menu: HTMLElement): HTMLElement[] {
	return [...menu.querySelectorAll<HTMLElement>(":scope > [role^=menuitem]")];
}

function moveFocus(menu: HTMLElement, event: KeyboardEvent): boolean {
	const items = menuItems(menu);
	const index = items.indexOf(document.activeElement as HTMLElement);
	const offset = matchesKey(event, "next") ? 1 : matchesKey(event, "previous") ? -1 : 0;
	const next = matchesKey(event, "first")
		? 0
		: matchesKey(event, "last")
			? items.length - 1
			: offset
				? (index + offset + items.length) % items.length
				: -1;
	if (next < 0) return false;
	items[next]?.focus();
	return true;
}

export function openContextMenu(options: ContextMenuOptions): ContextMenu {
	active?.close();
	const lifetime = new AbortController();
	const opener = options.opener;
	let submenu: { el: HTMLElement; trigger: HTMLElement } | undefined;
	let closed = false;

	const closeSubmenu = (focusTrigger = false) => {
		if (!submenu) return;
		submenu.trigger.setAttribute("aria-expanded", "false");
		submenu.trigger.classList.remove("is-open");
		submenu.el.remove();
		if (focusTrigger) submenu.trigger.focus();
		submenu = undefined;
	};

	const build = (entries: MenuEntry[], label: string, nested: boolean): HTMLElement => {
		const menu = h("div", {
			class: nested ? "context-menu context-submenu" : "context-menu",
			role: "menu",
			"aria-label": label,
			tabindex: "-1",
		});
		for (const entry of entries) {
			if (entry.kind === "separator") {
				menu.append(h("div", { class: "context-menu-separator", role: "separator" }));
				continue;
			}
			const glyph = entry.icon ? icon(entry.icon) : h("span", { class: "icon", "aria-hidden": "true" });
			if (entry.kind === "submenu") {
				const trigger = h(
					"button",
					{
						type: "button",
						class: "context-menu-item",
						role: "menuitem",
						"aria-haspopup": "menu",
						"aria-expanded": "false",
					},
					glyph,
					h("span", { class: "context-menu-label" }, entry.label),
					h("span", { class: "context-menu-chevron" }, icon("chevron")),
				);
				const open = (focusFirst: boolean) => {
					if (submenu?.trigger === trigger) {
						if (focusFirst) menuItems(submenu.el)[0]?.focus();
						return;
					}
					closeSubmenu();
					const child = build(entry.items, entry.label, true);
					document.body.append(child);
					const row = trigger.getBoundingClientRect();
					const parent = menu.getBoundingClientRect();
					place(child, parent.right - 2, row.top - 5, parent.left + 2);
					submenu = { el: child, trigger };
					trigger.setAttribute("aria-expanded", "true");
					trigger.classList.add("is-open");
					if (focusFirst) menuItems(child)[0]?.focus();
				};
				trigger.addEventListener("click", () => open(true));
				trigger.addEventListener("pointerenter", () => open(false));
				trigger.addEventListener("keydown", (event) => {
					if (matchesKey(event, "right")) {
						event.preventDefault();
						open(true);
					}
				});
				menu.append(trigger);
				continue;
			}
			const radio = entry.checked !== undefined;
			const item = h(
				"button",
				{
					type: "button",
					class: entry.danger ? "context-menu-item danger" : "context-menu-item",
					role: radio ? "menuitemradio" : "menuitem",
					...(radio ? { "aria-checked": String(entry.checked) } : {}),
				},
				radio ? (entry.checked ? icon("check") : glyph) : glyph,
				h("span", { class: "context-menu-label" }, entry.label),
			);
			item.addEventListener("click", () => {
				// Focus goes back to the opener first, so a dialog the choice opens returns it there.
				handle.close();
				entry.select();
			});
			// A row in the parent menu closes an open submenu, as a native menu does.
			if (!nested) item.addEventListener("pointerenter", () => closeSubmenu());
			menu.append(item);
		}
		// The row under the pointer takes focus, so the arrow keys continue from it.
		menu.addEventListener("pointermove", (event) => {
			const row = (event.target as Element).closest<HTMLElement>("[role^=menuitem]");
			if (row && row.parentElement === menu && document.activeElement !== row) row.focus({ preventScroll: true });
		});
		menu.addEventListener("keydown", (event) => {
			if (moveFocus(menu, event)) event.preventDefault();
			else if (nested && (matchesKey(event, "left") || matchesKey(event, "dismiss"))) {
				event.preventDefault();
				event.stopPropagation();
				closeSubmenu(true);
			} else if (matchesKey(event, "dismiss")) {
				event.preventDefault();
				event.stopPropagation();
				handle.close();
			} else if (matchesKey(event, "tab")) {
				event.preventDefault();
				handle.close();
			}
		});
		menu.addEventListener("contextmenu", (event) => event.preventDefault());
		return menu;
	};

	const root = build(options.items, options.label, false);
	const handle: ContextMenu = {
		el: root,
		close() {
			if (closed) return;
			closed = true;
			lifetime.abort();
			closeSubmenu();
			root.remove();
			opener?.classList.remove("menu-open");
			if (active === handle) active = undefined;
			// Focus returns only when it was in the menu; a press elsewhere keeps its own target.
			if (opener?.isConnected && (!document.activeElement || document.activeElement === document.body))
				opener.focus({ preventScroll: true });
			options.onClose?.();
		},
	};
	document.body.append(root);
	place(root, options.x, options.y);
	opener?.classList.add("menu-open");
	active = handle;
	menuItems(root)[0]?.focus({ preventScroll: true });

	const inside = (target: EventTarget | null) =>
		target instanceof Node && (root.contains(target) || Boolean(submenu?.el.contains(target)));
	const signal = lifetime.signal;
	document.addEventListener(
		"pointerdown",
		(event) => {
			if (!inside(event.target)) handle.close();
		},
		{ capture: true, signal },
	);
	// Scrolling what the menu belongs to moves its row away; a conversation that scrolls
	// itself (new messages arrive) leaves the menu alone.
	document.addEventListener(
		"scroll",
		(event) => {
			const target = event.target;
			if (
				!inside(target) &&
				(target === document || (target instanceof Node && Boolean(opener && target.contains(opener))))
			)
				handle.close();
		},
		{ capture: true, signal },
	);
	window.addEventListener("resize", () => handle.close(), { signal });
	window.addEventListener("blur", () => handle.close(), { signal });
	window.addEventListener("hashchange", () => handle.close(), { signal });
	return handle;
}

/** Where a context menu opened from the keyboard (Shift+F10, the menu key) stands: under its element. */
export function menuPoint(event: MouseEvent, element: Element): { x: number; y: number } {
	if (event.clientX || event.clientY) return { x: event.clientX, y: event.clientY };
	const rect = element.getBoundingClientRect();
	return { x: rect.left + Math.min(24, rect.width / 2), y: rect.bottom - 4 };
}
