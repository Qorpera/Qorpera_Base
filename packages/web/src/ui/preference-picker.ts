import { h, icon } from "./dom.ts";
import { matchesKey } from "./keys.ts";
import { t } from "./preferences.ts";
import { uiScale } from "./scale.ts";

export interface PickerOption {
	value: string;
	label: string;
	/** Right-hand text: a language's name in the interface language, a zone's offset. */
	detail?: string;
	/** More words the search matches, never shown. */
	keywords?: string;
	title?: string;
}

export interface PreferencePickerSetup {
	/** Id of the row's visible label; the button reads as "<label> <value>". */
	labelId: string;
	/** English source of the search placeholder, translated when the list opens. */
	searchLabel: string;
	/** Built when the list opens, so a long list costs nothing until it is used. */
	options: () => PickerOption[];
	value: () => string;
	/** The button's text for a value. */
	display: (value: string) => Node | string;
	/** Store a choice; the button then shows `value()` again. */
	choose: (value: string) => void;
}

const MARGIN = 8;
const GAP = 6;
const WIDTH = 320;
const TALLEST = 440;

let pickers = 0;

function searchable(text: string): string {
	return text.normalize("NFD").replace(/\p{M}/gu, "").replace(/[_/]/g, " ").toLowerCase();
}

/** A term that ends in a number matches only a whole number: "gmt+1" finds
 * GMT+1, not GMT+10 or GMT+1:30. Other terms match anywhere. */
function contains(text: string, term: string): boolean {
	if (!/\d$/.test(term)) return text.includes(term);
	for (let at = text.indexOf(term); at !== -1; at = text.indexOf(term, at + 1)) {
		const before = text.charAt(at - 1),
			after = text.charAt(at + term.length);
		if (!(/\d/.test(term.charAt(0)) && /\d/.test(before)) && !/[\d:]/.test(after)) return true;
	}
	return false;
}

/** A settings value as a small button that opens a searchable list: the name
 * on the left, a second name or offset on the right, a check on the current
 * one. Focus stays in the search field and the arrow keys move through the
 * list (the ARIA combobox pattern). The list floats over the settings page
 * (fixed), so the scrolling page never clips it. */
export class PreferencePicker {
	readonly el: HTMLElement;
	readonly #setup: PreferencePickerSetup;
	readonly #id = `preference-picker-${++pickers}`;
	/** For the row's <label for>, so clicking the row's name opens the list too. */
	readonly buttonId = `${this.#id}-button`;
	readonly #value = h("span", { id: `${this.#id}-value`, class: "preference-picker-value" });
	readonly #button: HTMLButtonElement;
	readonly #popover = h("div", {
		class: "preference-picker-popover",
		hidden: true,
		// Keep focus in the search field while the pointer picks a row.
		onmousedown: (event: MouseEvent) => {
			if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
		},
	});
	#open: AbortController | undefined;
	#rows: { option: PickerOption; el: HTMLElement; text: string }[] = [];
	#shown: HTMLElement[] = [];
	/** The highlighted row itself, not its index: filtering replaces #shown. */
	#active: HTMLElement | undefined;
	#frame = 0;
	#search: HTMLInputElement | undefined;
	#clear: HTMLButtonElement | undefined;
	#empty: HTMLElement | undefined;

	constructor(setup: PreferencePickerSetup) {
		this.#setup = setup;
		this.#button = h(
			"button",
			{
				type: "button",
				id: this.buttonId,
				class: "preference-picker-button",
				"aria-haspopup": "listbox",
				"aria-expanded": "false",
				"aria-controls": `${this.#id}-list`,
				"aria-labelledby": `${setup.labelId} ${this.#id}-value`,
				onclick: () => (this.#open ? this.close(true) : this.open()),
				onkeydown: (event: KeyboardEvent) => {
					if (!this.#open && (matchesKey(event, "next") || matchesKey(event, "previous"))) {
						event.preventDefault();
						this.open();
					}
				},
			},
			this.#value,
			icon("chevron-down"),
		);
		this.el = h("span", { class: "preference-picker" }, this.#button, this.#popover);
		this.refresh();
	}

	/** Show the current value on the button. */
	refresh(): void {
		this.#value.replaceChildren(this.#setup.display(this.#setup.value()));
	}

	open(): void {
		if (this.#open) return;
		const lifetime = new AbortController();
		this.#open = lifetime;
		const current = this.#setup.value();
		const listId = `${this.#id}-list`;
		const search = h("input", {
			type: "text",
			role: "combobox",
			class: "preference-picker-search-input",
			"aria-expanded": "true",
			"aria-controls": listId,
			"aria-autocomplete": "list",
			"aria-label": t(this.#setup.searchLabel),
			placeholder: t(this.#setup.searchLabel),
			autocomplete: "off",
			spellcheck: false,
			oninput: () => this.#filter(),
			onkeydown: (event: KeyboardEvent) => this.#key(event),
		});
		const clear = h(
			"button",
			{
				type: "button",
				class: "preference-picker-clear",
				"aria-label": t("Close"),
				onclick: () => {
					if (!search.value) return this.close(true);
					search.value = "";
					this.#filter();
					search.focus();
				},
			},
			icon("close"),
		);
		const list = h("div", { id: listId, class: "preference-picker-list", role: "listbox" });
		list.setAttribute("aria-labelledby", this.#setup.labelId);
		this.#rows = this.#setup.options().map((option, index) => {
			const selected = option.value === current;
			const el = h(
				"div",
				{
					id: `${this.#id}-option-${index}`,
					class: "preference-picker-option",
					role: "option",
					"aria-selected": String(selected),
					...(option.title ? { title: option.title } : {}),
					onclick: () => this.#choose(option.value),
					onmousemove: () => this.#activate(el, false),
				},
				h("span", { class: "preference-picker-label" }, option.label),
				option.detail ? h("span", { class: "preference-picker-detail" }, option.detail) : null,
				selected ? icon("check") : null,
			);
			return {
				option,
				el,
				text: searchable([option.label, option.detail, option.keywords, option.value].filter(Boolean).join(" ")),
			};
		});
		list.append(...this.#rows.map((row) => row.el));
		const empty = h("p", { class: "preference-picker-empty", role: "status", hidden: true });
		this.#search = search;
		this.#clear = clear;
		this.#empty = empty;
		this.#popover.replaceChildren(
			h("div", { class: "preference-picker-search" }, icon("search"), search, clear),
			list,
			empty,
		);
		this.#popover.hidden = false;
		this.#button.setAttribute("aria-expanded", "true");
		this.#shown = this.#rows.map((row) => row.el);
		this.#place(true);
		this.#activate((this.#rows.find((row) => row.option.value === current) ?? this.#rows[0])?.el, false);
		// Open on the current value, in the middle of the list when it is long.
		const chosen = this.#active;
		if (chosen) list.scrollTop = chosen.offsetTop - (list.clientHeight - chosen.offsetHeight) / 2;
		search.focus();
		document.addEventListener(
			"pointerdown",
			(event) => {
				if (!this.el.isConnected) this.close(false);
				else if (!this.el.contains(event.target as Node)) this.close(false);
			},
			{ capture: true, signal: lifetime.signal },
		);
		// Follow the button while the page scrolls or resizes, once per frame.
		const follow = (event: Event) => {
			if (!this.el.isConnected) this.close(false);
			else if (!(event.target instanceof Node && this.#popover.contains(event.target)) && !this.#frame)
				this.#frame = requestAnimationFrame(() => {
					this.#frame = 0;
					if (this.#open) this.#place();
				});
		};
		window.addEventListener("resize", follow, { signal: lifetime.signal });
		document.addEventListener("scroll", follow, { capture: true, passive: true, signal: lifetime.signal });
	}

	close(returnFocus: boolean): void {
		const lifetime = this.#open;
		if (!lifetime) return;
		this.#open = undefined;
		lifetime.abort();
		if (this.#frame) cancelAnimationFrame(this.#frame);
		this.#frame = 0;
		this.#popover.hidden = true;
		this.#popover.replaceChildren();
		this.#rows = [];
		this.#shown = [];
		this.#active = undefined;
		this.#search = this.#clear = this.#empty = undefined;
		this.#button.setAttribute("aria-expanded", "false");
		if (returnFocus && this.#button.isConnected) this.#button.focus();
	}

	#choose(value: string): void {
		const changed = value !== this.#setup.value();
		this.close(true);
		if (changed) this.#setup.choose(value);
		this.refresh();
	}

	#filter(): void {
		const search = this.#search;
		if (!search || !this.#clear || !this.#empty) return;
		const terms = searchable(search.value).split(/\s+/).filter(Boolean);
		this.#shown = [];
		for (const row of this.#rows) {
			const match = terms.every((term) => contains(row.text, term));
			row.el.hidden = !match;
			if (match) this.#shown.push(row.el);
		}
		this.#clear.setAttribute("aria-label", search.value ? t("Clear search") : t("Close"));
		this.#empty.hidden = this.#shown.length > 0;
		this.#empty.textContent = this.#shown.length ? "" : t("No matches");
		this.#activate(this.#shown[0], true);
		this.#place();
	}

	#activate(row: HTMLElement | undefined, scroll: boolean): void {
		if (row === this.#active) return;
		this.#active?.classList.remove("is-active");
		this.#active = row;
		if (row) {
			row.classList.add("is-active");
			this.#search?.setAttribute("aria-activedescendant", row.id);
			if (scroll) row.scrollIntoView?.({ block: "nearest" });
		} else this.#search?.removeAttribute("aria-activedescendant");
	}

	#key(event: KeyboardEvent): void {
		if (matchesKey(event, "dismiss")) {
			// The settings dialog closes on Escape too; this Escape is the list's.
			event.preventDefault();
			event.stopPropagation();
			this.close(true);
		} else if (matchesKey(event, "next") || matchesKey(event, "previous")) {
			event.preventDefault();
			const at = this.#active ? this.#shown.indexOf(this.#active) : -1;
			const next = at + (matchesKey(event, "next") ? 1 : -1);
			this.#activate(this.#shown[Math.min(Math.max(next, 0), this.#shown.length - 1)], true);
		} else if (matchesKey(event, "accept")) {
			event.preventDefault();
			const row = this.#rows.find((candidate) => candidate.el === this.#active);
			if (row) this.#choose(row.option.value);
		} else if (matchesKey(event, "tab")) {
			// Tab moves on from the button, as it would from a closed list.
			this.close(true);
		}
	}

	/** Under the button, right edges aligned, or above it when there is more
	 * room there; always inside the window. */
	#place(opening = false): void {
		const popover = this.#popover;
		const anchor = this.#button.getBoundingClientRect();
		// The constants are design pixels; the window and the button are measured in screen pixels.
		const scale = uiScale();
		const [margin, gap] = [MARGIN * scale, GAP * scale];
		const width = Math.min(WIDTH * scale, innerWidth - 2 * margin);
		const below = innerHeight - anchor.bottom - gap - margin;
		const above = anchor.top - gap - margin;
		const up = below < 280 * scale && above > below;
		popover.style.width = `${width}px`;
		popover.style.maxHeight = `${Math.max(120 * scale, Math.min(TALLEST * scale, up ? above : below))}px`;
		const left = Math.min(Math.max(anchor.right - width, margin), innerWidth - width - margin);
		const top = up ? anchor.top - gap - popover.offsetHeight : anchor.bottom + gap;
		popover.style.left = `${left}px`;
		popover.style.top = `${top}px`;
		// A transformed or filtered ancestor moves "fixed" off the window's
		// corner; measure and correct so the list still sits at the button.
		// As it opens, measured without the opening animation's transform, which would read as an
		// offset. (Turning the animation off and on starts it again, so only then: never while it
		// is open, as it is placed again on every keystroke and scroll.)
		if (opening) popover.style.animation = "none";
		const placed = popover.getBoundingClientRect();
		if (opening) popover.style.removeProperty("animation");
		if (placed.width > 0 && (placed.left !== left || placed.top !== top)) {
			popover.style.left = `${2 * left - placed.left}px`;
			popover.style.top = `${2 * top - placed.top}px`;
		}
	}
}
