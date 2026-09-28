import type { SkillSuggestion } from "../cloud/skills.ts";
import { h } from "./dom.ts";
import { matchesKey } from "./keys.ts";
import { t } from "./preferences.ts";

/** "/" and the name typed so far, right before the caret: at the start or after a space.
 * Names are lowercase; a capital typed while searching still searches. */
const TRIGGER = /(?:^|\s)\/([a-z0-9-]{0,64})$/i;
/** A character that continues a name: with one right after the caret, the caret is inside a
 * written name, not at the end of one being typed. */
const NAME_CHARACTER = /^[a-z0-9-]/i;
/** A whole "/name" standing on its own, coloured when it names a skill. */
const TOKEN = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=$|[\s.,;:!?)])/g;
/** A draft that may name a skill: its list is read so the name can be coloured. */
const MAY_NAME_SKILL = /(?:^|\s)\/[a-z0-9]/;
const SHOWN = 8;
/** A list older than this is read again when the member next types "/" (the company's shared
 * list answers most of those reads; together they keep a list under a minute old). */
const FRESH_MS = 20_000;
/** After a failed read, the next "/" tries again only after this long. */
const RETRY_MS = 10_000;
let menus = 0;

export type SkillLoader = (signal: AbortSignal) => Promise<readonly SkillSuggestion[]>;

export interface SkillMentionOptions {
	/** Reads the conversation's skills; without it the composer offers none and colours nothing. */
	readonly load: SkillLoader | undefined;
	/** The view's lifetime: listeners end with it, and a list that lands after it is ignored. */
	readonly signal: AbortSignal;
	/** The conversation's agent, who labels its own skills. */
	readonly ownerName: () => string | undefined;
	/** The menu opened (so the composer's other menu can close). */
	readonly opened?: () => void;
	/** A new list of skills arrived (so written messages can mark their names). */
	readonly listed?: () => void;
}

/** Blocks that end a word: text in two of them never runs together. */
const WORD_BLOCKS = "p, li, div, h1, h2, h3, h4, h5, h6, blockquote, td, th, dd, dt, pre";

/** Marks the names of known skills in rendered message text: whole "/name" words in text
 * outside code and links become spans. A word runs on across inline elements, so a name glued
 * to bold text or code before or after it is not a name, as it would not be in the composer.
 * Running it again over text it marked changes nothing. */
export function markSkillNames(root: ParentNode, names: ReadonlySet<string>): void {
	if (!names.size) return;
	// The text in reading order; a line break stands between two texts as the space it is.
	const texts: (Text | "\n")[] = [];
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
	for (let node = walker.nextNode(); node; node = walker.nextNode())
		if (node instanceof Text) texts.push(node);
		else if (node instanceof HTMLBRElement) texts.push("\n");
	const block = (node: Node) => node.parentElement?.closest(WORD_BLOCKS) ?? null;
	const edge = (neighbour: Text | "\n" | undefined, text: Text, end: boolean) =>
		neighbour === "\n"
			? neighbour
			: neighbour && block(neighbour) === block(text)
				? end
					? neighbour.data.slice(-1)
					: neighbour.data.slice(0, 1)
				: "";
	for (const [index, text] of texts.entries()) {
		if (text === "\n" || text.parentElement?.closest("code, pre, a, kbd, .message-skill")) continue;
		const before = edge(texts[index - 1], text, true);
		const after = edge(texts[index + 1], text, false);
		const value = text.data;
		const parts: (Node | string)[] = [];
		let last = 0;
		for (const match of value.matchAll(TOKEN)) {
			const [, lead = "", name = ""] = match;
			const start = match.index + lead.length;
			const end = start + name.length + 1;
			if (
				!names.has(name) ||
				(start === 0 && before !== "" && !/\s/.test(before)) ||
				(end === value.length && after !== "" && !/[\s.,;:!?)]/.test(after))
			)
				continue;
			parts.push(value.slice(last, start), h("span", { class: "message-skill" }, value.slice(start, end)));
			last = end;
		}
		if (parts.length) text.replaceWith(...parts, value.slice(last));
	}
}

interface Ranked {
	readonly skill: SkillSuggestion;
	/** 0 the name starts with the query, 1 the name contains it, 2 only the description does. */
	readonly rank: number;
}

/** Calls a skill from the composer (contract 15.2): typing "/" offers the conversation's
 * skills, picking one writes "/name", and a written name shows in blue. The field stays a
 * plain textarea; while the text names a skill, its characters turn transparent and a copy
 * of the same text, with the names coloured, lies over them. Without a loader it does nothing. */
export class SkillMentions {
	/** The textarea and the coloured copy of its text. */
	readonly field: HTMLElement;
	/** The popup above the composer: the suggestions, or a note when there are none yet. */
	readonly menu: HTMLElement;
	readonly #list: HTMLElement;
	readonly #note: HTMLElement;
	readonly #input: HTMLTextAreaElement;
	readonly #highlight: HTMLElement;
	readonly #load: SkillLoader | undefined;
	readonly #signal: AbortSignal;
	readonly #ownerName: () => string | undefined;
	readonly #opened: () => void;
	readonly #listed: () => void;
	#skills: readonly SkillSuggestion[] | undefined;
	#loadedAt = 0;
	#failedAt = Number.NEGATIVE_INFINITY;
	#loading: Promise<void> | undefined;
	/** The "/" being typed: where it stands in the text and the name typed after it. */
	#trigger: { start: number; query: string } | undefined;
	/** A "/" whose menu the member closed (Escape) or answered (a pick): it stays closed while
	 * the caret stays in that name. */
	#dismissed: number | undefined;
	#options: Ranked[] = [];
	/** The highlighted option; -1 when no name starts with what was typed, so Enter still sends. */
	#active = -1;
	/** What the menu shows now: the same list and query draw nothing new. */
	#drawn: { skills: readonly SkillSuggestion[] | undefined; query: string; loading: boolean } | undefined;

	constructor(input: HTMLTextAreaElement, options: SkillMentionOptions) {
		const { load, signal } = options;
		this.#input = input;
		this.#load = load;
		this.#signal = signal;
		this.#ownerName = options.ownerName;
		this.#opened = options.opened ?? (() => {});
		this.#listed = options.listed ?? (() => {});
		this.#highlight = h("div", { class: "composer-highlight", "aria-hidden": "true" });
		this.field = h("div", { class: "composer-field" }, this.#highlight, input);
		const id = `skill-menu-${++menus}`;
		this.#list = h("div", { class: "skill-list", id, role: "listbox", "aria-label": t("Skills") });
		this.#note = h("p", { class: "skill-menu-note", hidden: true });
		this.menu = h("div", { class: "skill-menu", hidden: true }, this.#list, this.#note);
		if (!load) return;
		input.setAttribute("aria-autocomplete", "list");
		input.setAttribute("aria-controls", id);
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
		input.addEventListener("blur", () => this.close(), { signal });
		// Picking with the pointer must not take the caret out of the field.
		this.menu.addEventListener("mousedown", (event) => event.preventDefault(), { signal });
	}

	/** Redraws the coloured copy. Call it whenever the text or the field's size changes without
	 * an input event (a restored draft, a resize that shows or hides the field's scrollbar). */
	sync(): void {
		if (!this.#load) return;
		const text = this.#input.value;
		const known = this.names();
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

	/** The names of the skills known now: empty until the list is first read. */
	names(): ReadonlySet<string> {
		return new Set(this.#skills?.map((skill) => skill.name));
	}

	/** Reads the list once when text elsewhere (a written message) may name a skill; a list
	 * being read or failed a moment ago is left as it is. */
	want(text: string): void {
		// Only the first read: later reads follow a typed "/", so an open thread reads nothing by itself.
		if (this.#skills === undefined && MAY_NAME_SKILL.test(text)) void this.#fetch();
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
			this.close();
			return consume();
		}
		// While the list loads, or when nothing matches, the keys are the field's: Enter sends.
		if (!this.#options.length) return false;
		if (matchesKey(event, "next") || matchesKey(event, "previous")) {
			const count = this.#options.length;
			const from = this.#active < 0 ? (matchesKey(event, "next") ? -1 : 0) : this.#active;
			this.#select((from + (matchesKey(event, "next") ? 1 : -1) + count) % count);
			return consume();
		}
		// Enter and Tab pick only a highlighted skill: a "/word" that merely appears inside some
		// name or description is the member's own text, and Enter sends it as written.
		const active = this.#options[this.#active];
		if (active && (matchesKey(event, "accept") || matchesKey(event, "tab")) && !event.shiftKey) {
			this.#accept(active.skill);
			return consume();
		}
		return false;
	}

	/** Closes the menu; the next keystroke in a "/name" opens it again. */
	close(): void {
		this.#trigger = undefined;
		this.#options = [];
		this.#drawn = undefined;
		if (!this.menu.hidden) this.menu.hidden = true;
		this.#input.removeAttribute("aria-activedescendant");
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
		// An older list stays in use while the new one is read, and after a failed read.
		// An adapter that throws at once is a failed read like any other, never an error in the view.
		const load = this.#load;
		this.#loading = Promise.resolve()
			.then(() => load(this.#signal))
			.then(
				(skills) => {
					// Written messages are marked again only when the names changed, not for every read.
					const before = this.names();
					const changed =
						this.#skills === undefined ||
						skills.length !== before.size ||
						skills.some((skill) => !before.has(skill.name));
					this.#skills = skills;
					this.#loadedAt = Date.now();
					if (changed && !this.#signal.aborted) this.#listed();
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
		const value = this.#input.value;
		const match =
			!this.#input.disabled && document.activeElement === this.#input && caret === this.#input.selectionEnd
				? TRIGGER.exec(value.slice(0, caret))
				: null;
		if (!match) {
			this.#dismissed = undefined;
			this.close();
			return;
		}
		const query = (match[1] ?? "").toLowerCase();
		const start = caret - query.length - 1;
		// Inside a name already written the caret is not typing one: arrows and Enter stay the field's.
		if (this.#dismissed === start || NAME_CHARACTER.test(value.slice(caret))) {
			this.close();
			return;
		}
		this.#trigger = { start, query };
		void this.#fetch();
		this.#render();
	}

	#render(): void {
		const query = this.#trigger?.query ?? "";
		const skills = this.#skills;
		const loading = skills === undefined && this.#loading !== undefined;
		if (
			this.#drawn &&
			this.#drawn.skills === skills &&
			this.#drawn.query === query &&
			this.#drawn.loading === loading
		)
			return;
		this.#drawn = { skills, query, loading };
		this.#note.hidden = true;
		this.#list.hidden = false;
		if (skills === undefined) {
			if (!loading) {
				this.close();
				return;
			}
			// Reading the list: grey lines in the menu's place, never a loading sentence.
			this.#options = [];
			this.#active = -1;
			this.#list.setAttribute("aria-busy", "true");
			this.#list.replaceChildren(
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
		this.#list.removeAttribute("aria-busy");
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
			.slice(0, SHOWN);
		if (!this.#options.length) {
			if (query || skills.length) {
				this.close();
				return;
			}
			// No skills at all: say so beside the (empty) list, which may only hold options.
			this.#list.replaceChildren();
			this.#list.hidden = true;
			this.#note.textContent = t("No skills yet. Agents save skills as they learn how the company works.");
			this.#note.hidden = false;
			this.#active = -1;
			this.#open();
			return;
		}
		// A name that starts with what was typed is highlighted, ready for Enter. Other matches are
		// only offered: "/api" at the end of a message is not "/rapid-response" unless chosen.
		this.#active = this.#options[0]?.rank === 0 ? 0 : -1;
		const owner = this.#ownerName() ?? t("Agent");
		this.#list.replaceChildren(
			...this.#options.map(({ skill }, index) =>
				h(
					"div",
					{
						class: "skill-option",
						id: `${this.#list.id}-${index}`,
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
		for (const [position, option] of [...this.#list.children].entries())
			option.setAttribute("aria-selected", String(position === index));
		const option = this.#list.children[index];
		option?.scrollIntoView?.({ block: "nearest" });
		if (option) this.#input.setAttribute("aria-activedescendant", option.id);
	}

	#accept(skill: SkillSuggestion): void {
		const trigger = this.#trigger;
		const value = this.#input.value;
		let end = trigger ? trigger.start + 1 + trigger.query.length : -1;
		// The text moved under the menu (a send, a restored draft): never write at stale offsets.
		if (!trigger || value.slice(trigger.start, end).toLowerCase() !== `/${trigger.query}`) {
			this.close();
			return;
		}
		// The whole name the caret was in is replaced, never half of it.
		while (end < value.length && NAME_CHARACTER.test(value.slice(end))) end++;
		const after = value.slice(end);
		this.#input.focus();
		this.#input.setRangeText(`/${skill.name}${/^\s/.test(after) ? "" : " "}`, trigger.start, end, "end");
		// Answered: the menu stays closed while the caret stays on this name.
		this.#dismissed = trigger.start;
		this.close();
		this.#input.dispatchEvent(new Event("input", { bubbles: true }));
	}

	#open(): void {
		const wasHidden = this.menu.hidden;
		this.menu.hidden = false;
		const active = this.#active >= 0 ? this.#list.children[this.#active] : undefined;
		if (active) this.#input.setAttribute("aria-activedescendant", active.id);
		else this.#input.removeAttribute("aria-activedescendant");
		if (wasHidden) this.#opened();
	}
}
