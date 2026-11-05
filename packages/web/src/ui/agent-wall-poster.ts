import { foldWallDone, parseWall, type Wall } from "@qorpera/cloud-client/agent-wall";
import type { HostedStaffAgent } from "../cloud/types.ts";
import { agentFigure } from "./avatar.ts";
import { h, icon, replace } from "./dom.ts";
import { markdownInline } from "./markdown.ts";
import { leave, playOnce } from "./motion.ts";
import { phrase, presentationDay, t } from "./preferences.ts";

/* An agent's wall, pinned on top of its chat (Jonas, 5 Nov 2026, direction A): a poster that folds to one line. Its
 * header row has the agent's figure, "N waits on you · N working on · N done" and Fold/Open; open, it shows what waits
 * on the member (first, highlighted), what the agent is working on, and what it has done (the two newest, then "N more
 * done", which shows the rest of the week and how many are earlier). The wall is the file
 * QorperaOS/agents/<handle>/wall.md (@qorpera/cloud-client/agent-wall); the view reads it and hands its text here.
 *
 * Each item is one line of Markdown, drawn as a message draws it, so its folder links and app cards are the same buttons
 * the app answers in a message (app/application.ts). What is new since the member last saw the wall open is marked; what
 * was seen, and whether the poster is folded, is kept per agent on this device.
 *
 * The member can hide the poster (Jonas, 5 Nov 2026: "it updates itself, but you can then dismiss it"). It stays hidden
 * for that member and agent on this device while the agent keeps the wall up to date, and "Latest notes" on the agent's
 * card brings it back open (showWallAgain). */

export type WallPosterAgent = Pick<HostedStaffAgent, "id" | "displayName" | "appearance" | "templateId">;

/** Done items shown while the done part is short. */
const DONE_SHORT = 2;
const SEEN_KEY = "qorpera.agent-wall.seen.";
const FOLD_KEY = "qorpera.agent-wall.folded.";
const HIDDEN_KEY = "qorpera.agent-wall.hidden.";

type Part = "waiting" | "working" | "done";

/** A short, stable name for one item: its part and its words (a done item's day too). FNV-1a, 32 bits. */
function itemKey(part: Part, text: string): string {
	let hash = 0x811c9dc5;
	for (const char of `${part}\n${text}`) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(36);
}

function keysOf(wall: Wall): string[] {
	return [
		...wall.waiting.map((text) => itemKey("waiting", text)),
		...wall.working.map((text) => itemKey("working", text)),
		...wall.done.map((item) => itemKey("done", `${item.day}: ${item.text}`)),
	];
}

/* What was seen and the fold state are a convenience of this device: storage that throws or is empty changes nothing
 * but the marks. */
function readSeen(agentId: string): Set<string> | null {
	try {
		const raw = localStorage.getItem(SEEN_KEY + agentId);
		const value: unknown = raw === null ? null : JSON.parse(raw);
		return Array.isArray(value) ? new Set(value.filter((item): item is string => typeof item === "string")) : null;
	} catch {
		return null;
	}
}

function writeSeen(agentId: string, keys: readonly string[]): void {
	try {
		localStorage.setItem(SEEN_KEY + agentId, JSON.stringify(keys));
	} catch {
		/* Not kept: the marks come again next time. */
	}
}

function readFolded(agentId: string): boolean | null {
	try {
		const raw = localStorage.getItem(FOLD_KEY + agentId);
		return raw === "1" ? true : raw === "0" ? false : null;
	} catch {
		return null;
	}
}

function writeFolded(agentId: string, folded: boolean): void {
	try {
		localStorage.setItem(FOLD_KEY + agentId, folded ? "1" : "0");
	} catch {
		/* Not kept. */
	}
}

/** Whether `member` hid `agentId`'s wall on this device. Storage that throws reads as shown. */
export function wallHidden(member: string, agentId: string): boolean {
	try {
		return localStorage.getItem(`${HIDDEN_KEY}${member}.${agentId}`) === "1";
	} catch {
		return false;
	}
}

function writeHidden(member: string, agentId: string, hidden: boolean): void {
	try {
		if (hidden) localStorage.setItem(`${HIDDEN_KEY}${member}.${agentId}`, "1");
		else localStorage.removeItem(`${HIDDEN_KEY}${member}.${agentId}`);
	} catch {
		/* Not kept: the poster shows again next time. */
	}
}

/** Shows `agentId`'s wall to `member` again, open: what "Latest notes" on the agent's card does before the thread opens. */
export function showWallAgain(member: string, agentId: string): void {
	writeHidden(member, agentId, false);
	writeFolded(agentId, false);
}

/** How many items `text` holds (zero when it is no wall), and how many of them this device has not seen yet. */
export function wallNews(agentId: string, text: string): { items: number; unseen: number } {
	const keys = keysOf(parseWall(text).wall);
	const seen = readSeen(agentId);
	return { items: keys.length, unseen: seen ? keys.filter((key) => !seen.has(key)).length : 0 };
}

export interface WallPosterOptions {
	/** The member who looks: hiding the poster is theirs, per agent. */
	member?: string;
	/** After the member hid the poster (and it left), so the view can put focus where they find it again. */
	onHide?: () => void;
}

export class AgentWallPoster {
	readonly el: HTMLElement;
	readonly #toggle: HTMLButtonElement;
	readonly #figure = h("span", { class: "agent-wall-figure", "aria-hidden": "true" });
	readonly #summary = h("p", { class: "agent-wall-summary" });
	readonly #body = h("div", { class: "agent-wall-body", id: `agent-wall-${crypto.randomUUID()}` });
	readonly #fold: HTMLElement;
	readonly #hide: HTMLButtonElement;
	readonly #member: string;
	readonly #onHide: (() => void) | undefined;
	#agent: WallPosterAgent | undefined;
	#text: string | null = null;
	#key = "";
	#today = "";
	#figureKey = "";
	#open = false;
	/** The whole week of done items is shown. */
	#moreDone = false;
	/** Items new since the member last saw this wall, while the poster shows this agent. */
	#fresh = new Set<string>();
	/** The items of the wall shown last: a new one that joins opens the poster. */
	#present = new Set<string>();
	/** Items drawn so far: one that joins later comes in moving. */
	#drawn: Set<string> | undefined;
	/** Brought back from the agent's card: once the poster shows, it takes focus. */
	#revealed = false;

	constructor(options: WallPosterOptions = {}) {
		this.#member = options.member ?? "";
		this.#onHide = options.onHide;
		this.#hide = h(
			"button",
			{ type: "button", class: "agent-wall-hide", onclick: () => this.#hideWall() },
			icon("close"),
		);
		this.#toggle = h("button", {
			type: "button",
			class: "agent-wall-toggle",
			"aria-controls": this.#body.id,
			onclick: () => this.#setOpen(!this.#open),
		});
		this.#fold = h("div", { class: "agent-wall-fold" }, this.#body);
		this.el = h(
			"section",
			{ class: "agent-wall", hidden: true },
			h("div", { class: "agent-wall-head" }, this.#figure, this.#summary, this.#toggle, this.#hide),
			this.#fold,
		);
	}

	/** Whether the poster shows (a wall with at least one item). */
	get shown(): boolean {
		return !this.el.hidden;
	}

	/** Shows `agent`'s wall as `text` reads, or nothing when there is no agent, no text or no item. `today` is the
	 * member's day (`YYYY-MM-DD`), which decides what is earlier. The same wall again changes nothing. */
	show(agent: WallPosterAgent | undefined, text: string | null, today = presentationDay(new Date())): void {
		const key = JSON.stringify([agent?.id, agent?.displayName, agent?.appearance, text, today]);
		if (key === this.#key) return;
		this.#key = key;
		if (agent?.id !== this.#agent?.id) {
			this.#fresh = new Set();
			this.#drawn = undefined;
			this.#moreDone = false;
		}
		this.#agent = agent;
		this.#text = text;
		this.#today = today;
		const wall = agent && text !== null ? parseWall(text).wall : undefined;
		const keys = wall ? keysOf(wall) : [];
		if (!agent || !wall || !keys.length) {
			this.el.hidden = true;
			this.#drawn = undefined;
			return;
		}
		// Hidden by the member, the poster stays away while the wall changes, and what is new stays unseen for the card.
		if (wallHidden(this.#member, agent.id)) {
			this.el.hidden = true;
			this.#drawn = undefined;
			return;
		}
		const seen = readSeen(agent.id);
		const present = new Set(keys);
		// Marks stay while the poster shows this agent; a wall seen for the first time has nothing to mark.
		this.#fresh = new Set([...this.#fresh].filter((item) => present.has(item)));
		if (seen) for (const item of keys) if (!seen.has(item)) this.#fresh.add(item);
		if (!this.#drawn) {
			const folded = readFolded(agent.id);
			this.#open = this.#fresh.size > 0 || (folded === null ? wall.waiting.length > 0 : !folded);
		} else if ([...this.#fresh].some((item) => !this.#present.has(item))) this.#open = true;
		this.#present = present;
		this.el.hidden = false;
		this.#draw(agent, wall, today);
		this.#syncOpen();
		// Seen once open; a wall never seen before is the start to mark from, folded or not.
		if (this.#open || !seen) writeSeen(agent.id, keys);
		if (this.#revealed) {
			this.#revealed = false;
			this.el.scrollIntoView?.({ block: "nearest" });
			this.#toggle.focus({ preventScroll: true });
		}
	}

	/** Shows the wall again, open, after the member hid or folded it ("Latest notes" on the agent's card): now when its
	 * text is here, else as soon as it is. */
	reveal(agentId: string): void {
		showWallAgain(this.#member, agentId);
		this.#revealed = true;
		if (this.#agent?.id !== agentId || this.#text === null) return;
		// Drawn as if first shown: open from the fold state just written, the new items marked.
		this.#key = "";
		this.#drawn = undefined;
		this.show(this.#agent, this.#text, this.#today);
	}

	/** The member hides the poster: it leaves, and stays away for them until "Latest notes" brings it back. */
	#hideWall(): void {
		const agent = this.#agent;
		if (!agent || this.el.hidden) return;
		writeHidden(this.#member, agent.id, true);
		leave(this.el, "is-leaving", () => {
			this.el.classList.remove("is-leaving");
			this.el.inert = false;
			delete this.el.dataset.leaving;
			this.el.style.removeProperty("pointer-events");
			// Still hidden by the member: a reveal while it left has shown it already.
			if (wallHidden(this.#member, agent.id)) {
				this.el.hidden = true;
				this.#drawn = undefined;
			}
			this.#onHide?.();
		});
	}

	#setOpen(open: boolean): void {
		if (open === this.#open) return;
		this.#open = open;
		if (this.#agent) writeFolded(this.#agent.id, !open);
		this.#syncOpen();
		if (open && this.#agent && this.#text !== null) writeSeen(this.#agent.id, keysOf(parseWall(this.#text).wall));
	}

	#syncOpen(): void {
		this.el.classList.toggle("is-folded", !this.#open);
		this.#fold.inert = !this.#open;
		this.#toggle.textContent = this.#open ? t("Fold") : t("Open");
		this.#toggle.setAttribute("aria-expanded", String(this.#open));
	}

	#draw(agent: WallPosterAgent, wall: Wall, today: string): void {
		const figureKey = JSON.stringify([agent.id, agent.displayName, agent.appearance, agent.templateId]);
		if (figureKey !== this.#figureKey) {
			this.#figureKey = figureKey;
			replace(this.#figure, agentFigure(agent, agent.displayName, { size: 22 }));
		}
		this.el.setAttribute("aria-label", t("{name}'s wall", { name: agent.displayName }));
		const hide = t("Hide. To see it again, click {name} at the top and choose Latest notes.", {
			name: agent.displayName,
		});
		this.#hide.setAttribute("aria-label", hide);
		this.#hide.title = hide;
		const counts: Node[] = [];
		const count = (n: number, one: string, many = one, className?: string) => {
			if (!n) return;
			if (counts.length) counts.push(document.createTextNode(" · "));
			counts.push(h("span", className ? { class: className } : null, t(n === 1 ? one : many, { n })));
		};
		count(wall.waiting.length, phrase("{n} waits on you"), phrase("{n} wait on you"), "agent-wall-count-waiting");
		count(wall.working.length, phrase("{n} working on"));
		count(wall.done.length, phrase("{n} done"));
		replace(this.#summary, ...counts);

		const drawn = new Set<string>();
		const item = (part: Part, text: string, keyText = text) => {
			const key = itemKey(part, keyText);
			drawn.add(key);
			const fresh = this.#fresh.has(key);
			const row = h(
				"li",
				{ class: `agent-wall-item${fresh ? " is-new" : ""}`, "data-wall-item": key },
				h(
					"span",
					{ class: "agent-wall-mark", "aria-hidden": "true" },
					part === "done" ? "✓" : part === "waiting" ? "!" : "",
				),
				h("span", { class: "agent-wall-text" }, markdownInline(text)),
				fresh ? h("span", { class: "visually-hidden" }, ` (${t("New")})`) : null,
			);
			// What joins the wall while it is on screen comes in moving; a highlight fades in on what is new.
			if (this.#drawn && !this.#drawn.has(key)) playOnce(row, "is-entering");
			return row;
		};
		const part = (name: Part, heading: string, rows: Node[], foot?: Node | null) =>
			rows.length
				? h(
						"div",
						{ class: `agent-wall-part is-${name}` },
						h(
							"h2",
							{ class: "agent-wall-heading" },
							heading,
							h(
								"span",
								{ class: "agent-wall-number" },
								String(name === "done" ? wall.done.length : rows.length),
							),
						),
						h("ul", { class: "agent-wall-list" }, rows),
						foot ?? null,
					)
				: null;

		const { recent } = foldWallDone(wall.done, today);
		const longest = Math.max(DONE_SHORT, recent.length);
		const extra = Math.max(0, Math.min(longest, wall.done.length) - DONE_SHORT);
		const shownDone = wall.done.slice(0, this.#moreDone && extra ? longest : DONE_SHORT);
		const earlier = wall.done.length - Math.min(longest, wall.done.length);
		let foot: HTMLElement | null = null;
		if (extra && !this.#moreDone)
			foot = h(
				"p",
				{ class: "agent-wall-more" },
				h(
					"button",
					{ type: "button", class: "agent-wall-link", onclick: () => this.#setMoreDone(true) },
					t("{n} more done", { n: extra }),
				),
			);
		else if (extra || earlier)
			foot = h(
				"p",
				{ class: "agent-wall-more" },
				earlier ? t("Earlier: {n}", { n: earlier }) : null,
				earlier && extra ? " · " : null,
				extra
					? h(
							"button",
							{ type: "button", class: "agent-wall-link", onclick: () => this.#setMoreDone(false) },
							t("Show fewer"),
						)
					: null,
			);
		replace(
			this.#body,
			part(
				"waiting",
				t("Waits on you"),
				wall.waiting.map((text) => item("waiting", text)),
			),
			part(
				"working",
				t("Working on"),
				wall.working.map((text) => item("working", text)),
			),
			part(
				"done",
				t("Done"),
				shownDone.map((done) => item("done", done.text, `${done.day}: ${done.text}`)),
				foot,
			),
		);
		// Done items the member shows with "more done" slide in the first time; what was drawn before stays still.
		this.#drawn = new Set([...(this.#drawn ?? []), ...drawn]);
	}

	#setMoreDone(more: boolean): void {
		this.#moreDone = more;
		const agent = this.#agent;
		const text = this.#text;
		if (!agent || text === null) return;
		this.#draw(agent, parseWall(text).wall, this.#today);
		this.#body.querySelector<HTMLButtonElement>(".agent-wall-more .agent-wall-link")?.focus();
	}
}
