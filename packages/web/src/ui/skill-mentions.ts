import type { SkillSuggestion } from "../cloud/skills.ts";
import { h } from "./dom.ts";
import { matchesKey } from "./keys.ts";
import { t } from "./preferences.ts";

/** "/" and the name typed so far, right before the caret: at the start or after a space.
 * Names are lowercase; a capital typed while searching still searches. */
const TRIGGER = /(?:^|\s)\/([a-z0-9-]{0,64})$/i;
/** A whole "/name" standing on its own, coloured when it names a skill. */
const TOKEN = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=$|[\s.,;:!?)])/g;
/** A draft that may name a skill: its list is read so the name can be coloured. */
const MAY_NAME_SKILL = /(?:^|\s)\/[a-z0-9]/;
const SHOWN = 8;
/** A list older than this is read again when the member next types "/". */
const FRESH_MS = 60_000;
/** After a failed read, the next "/" tries again only after this long. */
const RETRY_MS = 10_000;
let menus = 0;

export type SkillLoader = (signal: AbortSignal) => Promise<readonly SkillSuggestion[]>;

/** Calls a skill from the composer (contract 15.2): typing "/" offers the conversation's
 * skills, picking one writes "/name", and a written name shows in blue. The field stays a
 * plain textarea; while the text names a skill, its characters turn transparent over a
 * copy of the same text in which the names are coloured. Without a loader it does nothing. */
export class SkillMentions {
	/** The textarea and, behind it, the coloured copy of its text. */
	readonly field: HTMLElement;
	/** The suggestions, above the composer. */
	readonly menu: HTMLElement;
	readonly #input: HTMLTextAreaElement;
	readonly #highlight: HTMLElement;
	readonly #load: SkillLoader | undefined;
	readonly #signal: AbortSignal;
	readonly #ownerName: () => string | undefined;
	#skills: readonly SkillSuggestion[] | undefined;
	#loadedAt = 0;
	#failedAt = Number.NEGATIVE_INFINITY;
	#loading: Promise<void> | undefined;
	/** The "/" being typed: where it stands in the text and the name typed after it. */
	#trigger: { start: number; query: string } | undefined;
	/** A "/" whose menu the member closed (Escape) or answered (a pick): it stays closed while
	 * the caret stays in that name. */
	#dismissed: number | undefined;
	#options: SkillSuggestion[] = [];
	#active = 0;

	constructor(
		input: HTMLTextAreaElement,
		load: SkillLoader | undefined,
		signal: AbortSignal,
		ownerName: () => string | undefined,
	) {
		this.#input = input;
		this.#load = load;
		this.#signal = signal;
		this.#ownerName = ownerName;
		this.#highlight = h("div", { class: "composer-highlight", "aria-hidden": "true" });
		this.field = h("div", { class: "composer-field" }, this.#highlight, input);
		this.menu = h("div", {
			class: "skill-menu",
			id: `skill-menu-${++menus}`,
			role: "listbox",
			"aria-label": t("Skills"),
			hidden: true,
		});
		if (!load) return;
		input.setAttribute("aria-autocomplete", "list");
		input.setAttribute("aria-controls", this.menu.id);
		input.addEventListener(
			"input",
			() => {
				this.sync();
				this.#update();
			},
			{ signal },
		);
		input.addEventListener(
			"scroll",
			() => {
				this.#highlight.scrollTop = input.scrollTop;
			},
			{ signal },
		);
		for (const type of ["click", "keyup", "focus"]) input.addEventListener(type, () => this.#update(), { signal });
		input.addEventListener("blur", () => this.#close(), { signal });
		// Picking with the pointer must not take the caret out of the field.
		this.menu.addEventListener("mousedown", (event) => event.preventDefault(), { signal });
	}

	/** Redraws the coloured copy; call it whenever the text changes without an input event. */
	sync(): void {
		if (!this.#load) return;
		const text = this.#input.value;
		const known = new Set(this.#skills?.map((skill) => skill.name));
		const parts: (Node | string)[] = [];
		let last = 0;
		for (const match of text.matchAll(TOKEN)) {
			const [, before = "", name = ""] = match;
			if (!known.has(name)) continue;
			const start = match.index + before.length;
			const end = start + name.length + 1;
			parts.push(text.slice(last, start), h("span", { class: "composer-skill" }, text.slice(start, end)));
			last = end;
		}
		const marked = parts.length > 0;
		this.field.classList.toggle("has-skills", marked);
		if (!marked) {
			this.#highlight.replaceChildren();
			// A draft that names skills gets its colour once the list is known.
			if (this.#skills === undefined && MAY_NAME_SKILL.test(text)) void this.#fetch();
			return;
		}
		// A final line break takes up its line in the field only with a character after it.
		this.#highlight.replaceChildren(...parts, `${text.slice(last)} `);
		// The field's scrollbar, when a long draft shows one, narrows its text; the copy follows.
		this.#highlight.style.right = `${this.#input.offsetWidth - this.#input.clientWidth}px`;
		this.#highlight.scrollTop = this.#input.scrollTop;
	}

	/** Moves through the open menu, picks or closes it. True when the key was the menu's. */
	keydown(event: KeyboardEvent): boolean {
		if (this.menu.hidden) return false;
		const consume = () => {
			event.preventDefault();
			event.stopPropagation();
			return true;
		};
		if (matchesKey(event, "dismiss")) {
			this.#dismissed = this.#trigger?.start;
			this.#close();
			return consume();
		}
		// While the list loads, or when nothing matches, Enter still sends.
		if (!this.#options.length) return false;
		if (matchesKey(event, "next") || matchesKey(event, "previous")) {
			const step = matchesKey(event, "next") ? 1 : -1;
			this.#select((this.#active + step + this.#options.length) % this.#options.length);
			return consume();
		}
		if ((matchesKey(event, "accept") || matchesKey(event, "tab")) && !event.shiftKey) {
			const skill = this.#options[this.#active];
			if (skill) this.#accept(skill);
			return consume();
		}
		return false;
	}

	#fetch(): Promise<void> {
		const now = Date.now();
		if (
			!this.#load ||
			this.#loading ||
			now - this.#failedAt < RETRY_MS ||
			(this.#skills !== undefined && now - this.#loadedAt < FRESH_MS)
		)
			return this.#loading ?? Promise.resolve();
		// An older list stays in use while the new one is read.
		this.#loading = this.#load(this.#signal)
			.then(
				(skills) => {
					this.#skills = skills;
					this.#loadedAt = Date.now();
				},
				() => {
					this.#failedAt = Date.now();
				},
			)
			.finally(() => {
				this.#loading = undefined;
				if (this.#signal.aborted) return;
				this.sync();
				// A "/" typed while the list was read, or one the old list had no match for, gets its menu now.
				if (document.activeElement === this.#input) this.#update();
			});
		return this.#loading;
	}

	#update(): void {
		const caret = this.#input.selectionStart;
		if (this.#input.disabled || document.activeElement !== this.#input || caret !== this.#input.selectionEnd) {
			this.#close();
			return;
		}
		const match = TRIGGER.exec(this.#input.value.slice(0, caret));
		if (!match) {
			this.#dismissed = undefined;
			this.#close();
			return;
		}
		const query = (match[1] ?? "").toLowerCase();
		const start = caret - query.length - 1;
		if (this.#dismissed === start) {
			this.#close();
			return;
		}
		const same = this.#trigger?.start === start && this.#trigger.query === query;
		this.#trigger = { start, query };
		void this.#fetch();
		this.#render(same);
	}

	#render(keepActive: boolean): void {
		const query = this.#trigger?.query ?? "";
		const skills = this.#skills;
		if (skills === undefined) {
			if (!this.#loading) {
				this.#close();
				return;
			}
			// Reading the list: grey lines in the menu's place, never a loading sentence.
			this.#options = [];
			this.menu.setAttribute("aria-busy", "true");
			this.menu.replaceChildren(
				...[0, 1].map(() =>
					h(
						"div",
						{ class: "skill-option is-loading", "aria-hidden": "true" },
						h("span", { class: "skeleton skeleton-line" }),
						h("span", { class: "skeleton skeleton-line skeleton-small" }),
					),
				),
			);
			this.#open();
			return;
		}
		this.menu.removeAttribute("aria-busy");
		const words = query.replaceAll("-", " ");
		this.#options = skills
			.map((skill) => ({
				skill,
				rank: skill.name.startsWith(query)
					? 0
					: skill.name.includes(query)
						? 1
						: skill.description?.toLowerCase().includes(words)
							? 2
							: 3,
			}))
			.filter((item) => item.rank < 3)
			.sort(
				(a, b) =>
					a.rank - b.rank ||
					(a.skill.scope === b.skill.scope ? 0 : a.skill.scope === "agent" ? -1 : 1) ||
					(a.skill.name < b.skill.name ? -1 : a.skill.name > b.skill.name ? 1 : 0),
			)
			.slice(0, SHOWN)
			.map((item) => item.skill);
		if (!this.#options.length) {
			if (query || skills.length) {
				this.#close();
				return;
			}
			this.menu.replaceChildren(
				h(
					"p",
					{ class: "skill-menu-note" },
					t("No skills yet. Agents save skills as they learn how the company works."),
				),
			);
			this.#open();
			return;
		}
		if (!keepActive || this.#active >= this.#options.length) this.#active = 0;
		const owner = this.#ownerName() ?? t("Agent");
		this.menu.replaceChildren(
			...this.#options.map((skill, index) =>
				h(
					"div",
					{
						class: "skill-option",
						id: `${this.menu.id}-${index}`,
						role: "option",
						"aria-selected": String(index === this.#active),
						onclick: () => this.#accept(skill),
						onmousemove: () => {
							if (index !== this.#active) this.#select(index);
						},
					},
					h("span", { class: "skill-option-name" }, `/${skill.name}`),
					h("span", { class: "skill-option-scope" }, skill.scope === "agent" ? owner : t("Company")),
					...(skill.description ? [h("span", { class: "skill-option-description" }, skill.description)] : []),
				),
			),
		);
		this.#open();
	}

	#select(index: number): void {
		this.#active = index;
		for (const [position, option] of [...this.menu.children].entries())
			option.setAttribute("aria-selected", String(position === index));
		const option = this.menu.children[index];
		option?.scrollIntoView?.({ block: "nearest" });
		if (option) this.#input.setAttribute("aria-activedescendant", option.id);
	}

	#accept(skill: SkillSuggestion): void {
		const trigger = this.#trigger;
		if (!trigger) return;
		const end = trigger.start + 1 + trigger.query.length;
		const after = this.#input.value.slice(end);
		this.#input.focus();
		this.#input.setRangeText(`/${skill.name}${/^\s/.test(after) ? "" : " "}`, trigger.start, end, "end");
		// Answered: the menu stays closed while the caret stays on this name.
		this.#dismissed = trigger.start;
		this.#close();
		this.#input.dispatchEvent(new Event("input", { bubbles: true }));
	}

	#open(): void {
		this.menu.hidden = false;
		const active = this.#options.length ? this.menu.children[this.#active] : undefined;
		if (active) this.#input.setAttribute("aria-activedescendant", active.id);
		else this.#input.removeAttribute("aria-activedescendant");
	}

	#close(): void {
		this.#trigger = undefined;
		this.#options = [];
		if (!this.menu.hidden) this.menu.hidden = true;
		this.#input.removeAttribute("aria-activedescendant");
	}
}
