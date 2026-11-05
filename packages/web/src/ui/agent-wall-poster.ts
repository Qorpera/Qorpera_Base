import { foldWallDone, parseWall, type Wall, type WallItem, wallPreview } from "@qorpera/cloud-client/agent-wall";
import { isInterfaceName } from "@qorpera/cloud-client/interfaces";
import { forgetPictureUrl, pictureUrl } from "../app/folder-images.ts";
import type { HostedStaffAgent } from "../cloud/types.ts";
import { agentFigure } from "./avatar.ts";
import { h, icon, replace } from "./dom.ts";
import { folderLinkPath } from "./folder-links.ts";
import { markdownInline } from "./markdown.ts";
import { leave, playOnce } from "./motion.ts";
import { phrase, presentationDay, t } from "./preferences.ts";

/* An agent's wall, pinned on top of its chat (Jonas, 5 Nov 2026, direction A): a poster that folds to one line. Its
 * header row has the agent's figure, "N waits on you · N working on · N done" and Fold/Open; open, it shows what waits
 * on the member (first, highlighted), what the agent is working on, and what it has done (the two newest, then "N more
 * done", which shows the rest of the week and how many are earlier). The wall is the file
 * QorperaOS/agents/<handle>/wall.md (@qorpera/cloud-client/agent-wall); the view reads it and hands its text here.
 *
 * Each item is a headline (Jonas, 5 November 2026: no more text per headline than a glance takes). One with more to it
 * (a detail, a link) is a row that opens on a click: its detail and links, drawn as a message draws them, so its folder
 * links and app cards are the same buttons the app answers in a message (app/application.ts), and a preview of the
 * picture or app it links. What is new since the member last saw the wall open is marked; what
 * was seen, and whether the poster is folded, is kept per member and agent on this device.
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
/** How long a reveal from the agent's card waits for its wall to show before it no longer takes focus. */
const REVEAL_MS = 15_000;

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
		...wall.waiting.map((item) => itemKey("waiting", item.text)),
		...wall.working.map((item) => itemKey("working", item.text)),
		...wall.done.map((item) => itemKey("done", `${item.day}: ${item.text}`)),
	];
}

/** A headline as plain words for the row's button, which holds no link: Markdown drawn, then read back as text, so
 * an emphasis, a link's words or a bare address all read as words. */
function plainWords(text: string): string {
	const drawn = h("span", null, markdownInline(text.replace(LINK, "$1")));
	return drawn.textContent ?? "";
}

/** Markdown links in a headline: the row is a button, so they show as words there and as links when it opens. */
const LINK = /\[([^\]]*)\]\(((?:folder|app):[^)\s]+|https?:\/\/[^)\s]+)\)/g;

/** Where one member's view of one agent's wall is kept on this device (no member: the agent alone). */
function slot(member: string, agentId: string): string {
	return member ? `${member}.${agentId}` : agentId;
}

/* What was seen, the fold state and hiding are a convenience of this device: storage that throws or is empty changes
 * nothing but the marks (and a hide lasts while the poster is on screen). */
function readSeen(where: string): Set<string> | null {
	try {
		const raw = localStorage.getItem(SEEN_KEY + where);
		const value: unknown = raw === null ? null : JSON.parse(raw);
		return Array.isArray(value) ? new Set(value.filter((item): item is string => typeof item === "string")) : null;
	} catch {
		return null;
	}
}

function writeSeen(where: string, keys: readonly string[]): void {
	try {
		localStorage.setItem(SEEN_KEY + where, JSON.stringify(keys));
	} catch {
		/* Not kept: the marks come again next time. */
	}
}

function readFolded(where: string): boolean | null {
	try {
		const raw = localStorage.getItem(FOLD_KEY + where);
		return raw === "1" ? true : raw === "0" ? false : null;
	} catch {
		return null;
	}
}

function writeFolded(where: string, folded: boolean): void {
	try {
		localStorage.setItem(FOLD_KEY + where, folded ? "1" : "0");
	} catch {
		/* Not kept. */
	}
}

/** Whether `member` hid `agentId`'s wall on this device. Storage that throws reads as shown. */
export function wallHidden(member: string, agentId: string): boolean {
	try {
		return localStorage.getItem(HIDDEN_KEY + slot(member, agentId)) === "1";
	} catch {
		return false;
	}
}

function writeHidden(member: string, agentId: string, hidden: boolean): void {
	try {
		if (hidden) localStorage.setItem(HIDDEN_KEY + slot(member, agentId), "1");
		else localStorage.removeItem(HIDDEN_KEY + slot(member, agentId));
	} catch {
		/* Not kept: the poster shows again next time. */
	}
}

/** Shows `agentId`'s wall to `member` again, open: what "Latest notes" on the agent's card does before the thread opens. */
export function showWallAgain(member: string, agentId: string): void {
	writeHidden(member, agentId, false);
	writeFolded(slot(member, agentId), false);
}

/** How many items `text` holds (zero when it is no wall), and how many of them `member` has not seen on this device. */
export function wallNews(member: string, agentId: string, text: string): { items: number; unseen: number } {
	const keys = keysOf(parseWall(text).wall);
	const seen = readSeen(slot(member, agentId));
	return { items: keys.length, unseen: seen ? keys.filter((key) => !seen.has(key)).length : 0 };
}

export interface WallPosterOptions {
	/** The member who looks: hiding the poster is theirs, per agent. */
	member?: string;
	/** Reads a picture of the company's folder an item links, for its preview; null when there is none to show. */
	image?: (path: string, signal: AbortSignal) => Promise<Blob | null>;
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
	readonly #image: WallPosterOptions["image"];
	/** Previews read for this agent, by path: a picture is read once while the poster shows the agent. */
	#pictures = new Map<string, Promise<string | null>>();
	#pictureLife = new AbortController();
	/** Items opened, by key, while the poster shows this agent. */
	#expanded = new Set<string>();
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
	/** The items drawn, by key, for an item that opens later. */
	#items = new Map<string, WallItem>();
	/** Tells this poster's detail ids apart from another poster's on the page. */
	readonly #serial = Math.random().toString(36).slice(2, 8);
	/** Brought back from the agent's card: if the poster shows before this time, it takes focus. */
	#revealUntil = 0;
	/** Agents this poster hid: hidden while it is on screen even when storage keeps nothing. */
	readonly #hiddenHere = new Set<string>();
	/** Counts hides and reveals: a leaving animation that ends after a later one changes nothing. */
	#turn = 0;

	constructor(options: WallPosterOptions = {}) {
		this.#member = options.member ?? "";
		this.#onHide = options.onHide;
		this.#image = options.image;
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
			this.#expanded = new Set();
			this.#forgetPictures();
			this.#stopLeaving();
		} else if (text !== this.#text) {
			// The wall changed: an opened item reads its picture again, which may have changed with it.
			this.#forgetPictures();
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
		if (this.#isHidden(agent.id)) {
			this.el.hidden = true;
			this.#drawn = undefined;
			return;
		}
		const where = slot(this.#member, agent.id);
		const seen = readSeen(where);
		const present = new Set(keys);
		// Marks stay while the poster shows this agent; a wall seen for the first time has nothing to mark.
		this.#fresh = new Set([...this.#fresh].filter((item) => present.has(item)));
		if (seen) for (const item of keys) if (!seen.has(item)) this.#fresh.add(item);
		if (!this.#drawn) {
			const folded = readFolded(where);
			this.#open = this.#fresh.size > 0 || (folded === null ? wall.waiting.length > 0 : !folded);
		} else if ([...this.#fresh].some((item) => !this.#present.has(item))) this.#open = true;
		this.#present = present;
		this.el.hidden = false;
		this.#draw(agent, wall, today);
		this.#syncOpen();
		// Seen once open; a wall never seen before is the start to mark from, folded or not.
		if (this.#open || !seen) writeSeen(where, keys);
		if (this.#revealUntil) {
			// Not when the reveal is long past (its thread's read failed), nor into the middle of typing.
			const typing = document.activeElement?.closest("input, textarea, [contenteditable=true]");
			if (Date.now() <= this.#revealUntil && !typing) {
				this.el.scrollIntoView?.({ block: "nearest" });
				this.#toggle.focus({ preventScroll: true });
			}
			this.#revealUntil = 0;
		}
	}

	/** Shows the wall again, open, after the member hid or folded it ("Latest notes" on the agent's card): now when its
	 * text is here, else as soon as it is. */
	reveal(agentId: string): void {
		showWallAgain(this.#member, agentId);
		this.#hiddenHere.delete(agentId);
		this.#stopLeaving();
		this.#revealUntil = Date.now() + REVEAL_MS;
		if (this.#agent?.id !== agentId || this.#text === null) return;
		// Drawn as if first shown: open from the fold state just written, the new items marked.
		this.#key = "";
		this.#drawn = undefined;
		this.show(this.#agent, this.#text, this.#today);
	}

	/** The member hides the poster: it leaves, and stays away for them until "Latest notes" brings it back. */
	#hideWall(): void {
		const agent = this.#agent;
		if (!agent || this.el.hidden || this.el.dataset.leaving !== undefined) return;
		writeHidden(this.#member, agent.id, true);
		this.#hiddenHere.add(agent.id);
		const turn = ++this.#turn;
		leave(this.el, "is-leaving", () => {
			// A reveal, or another agent's wall, while it left: that one stands.
			if (turn !== this.#turn) return;
			this.#stopLeaving();
			this.el.hidden = true;
			this.#drawn = undefined;
			this.#onHide?.();
		});
	}

	/** Lets the pictures read for the agent shown so far go. */
	#forgetPictures(): void {
		this.#pictureLife.abort();
		this.#pictureLife = new AbortController();
		for (const url of this.#pictures.values()) void url.then((shown) => shown && forgetPictureUrl(shown));
		this.#pictures = new Map();
	}

	/** Lets the pictures go: the thread that shows the poster closed. */
	dispose(): void {
		this.#forgetPictures();
	}

	/** An opened item's preview: the picture it links (read once), or the app it links as a big card. */
	#preview(item: WallItem): HTMLElement | null {
		const target = wallPreview(item);
		if (!target) return null;
		if (target.kind === "app")
			return isInterfaceName(target.name)
				? h("div", { class: "agent-wall-preview is-app" }, markdownInline(`[${target.name}](app:${target.name})`))
				: null;
		const read = this.#image;
		// The path as the item's folder link names it: percent-decoded, one plain company path.
		const path = folderLinkPath(`folder:${target.path}`);
		if (!read || !path) return null;
		const box = h("div", { class: "agent-wall-preview is-image is-loading" });
		let shown = this.#pictures.get(path);
		if (!shown) {
			const signal = this.#pictureLife.signal;
			shown = read(path, signal).then(
				async (blob) => (blob && !signal.aborted ? pictureUrl(blob) : null),
				() => null,
			);
			this.#pictures.set(path, shown);
			// A picture that could not be read is read again next time.
			void shown.then((url) => {
				if (!url && this.#pictures.get(path) === shown) this.#pictures.delete(path);
			});
		}
		void shown.then((url) => {
			box.classList.remove("is-loading");
			if (!url) {
				box.remove();
				return;
			}
			const name = path.slice(path.lastIndexOf("/") + 1);
			// The picture opens in Storage, as its link does.
			replace(
				box,
				h(
					"button",
					{ type: "button", class: "folder-link agent-wall-picture", "data-folder-path": path },
					h("img", { src: url, alt: name, decoding: "async" }),
				),
			);
		});
		return box;
	}

	#toggleItem(key: string, row: HTMLElement): void {
		const open = !this.#expanded.has(key);
		if (open) this.#expanded.add(key);
		else this.#expanded.delete(key);
		const button = row.querySelector<HTMLButtonElement>(".agent-wall-row");
		const detail = row.querySelector<HTMLElement>(".agent-wall-detail");
		button?.setAttribute("aria-expanded", String(open));
		row.classList.toggle("is-open", open);
		if (detail) {
			detail.hidden = !open;
			// The preview is read only when the item first opens.
			if (open && detail.dataset.preview === "later") {
				delete detail.dataset.preview;
				const item = this.#items.get(key);
				const preview = item ? this.#preview(item) : null;
				if (preview) detail.append(preview);
			}
		}
	}

	#isHidden(agentId: string): boolean {
		return this.#hiddenHere.has(agentId) || wallHidden(this.#member, agentId);
	}

	/** Ends a leaving animation in place: the poster is whole and in reach again, and its end changes nothing. */
	#stopLeaving(): void {
		this.#turn++;
		if (this.el.dataset.leaving === undefined) return;
		this.el.classList.remove("is-leaving");
		this.el.inert = false;
		delete this.el.dataset.leaving;
		this.el.style.removeProperty("pointer-events");
	}

	#setOpen(open: boolean): void {
		if (open === this.#open) return;
		this.#open = open;
		if (this.#agent) writeFolded(slot(this.#member, this.#agent.id), !open);
		this.#syncOpen();
		if (open && this.#agent && this.#text !== null)
			writeSeen(slot(this.#member, this.#agent.id), keysOf(parseWall(this.#text).wall));
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
		const hide = t("Hide. Latest notes on {name}'s card brings it back.", { name: agent.displayName });
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
		this.#items = new Map();
		const item = (part: Part, entry: WallItem, keyText = entry.text) => {
			// The same headline twice in a part (two "Approve the post"): the second has a key of its own.
			let key = itemKey(part, keyText);
			for (let again = 2; drawn.has(key); again++) key = `${itemKey(part, keyText)}-${again}`;
			drawn.add(key);
			this.#items.set(key, entry);
			const fresh = this.#fresh.has(key);
			const mark = h(
				"span",
				{ class: "agent-wall-mark", "aria-hidden": "true" },
				part === "done" ? "✓" : part === "waiting" ? "!" : "",
			);
			const news = fresh ? h("span", { class: "visually-hidden" }, ` (${t("New")})`) : null;
			const links = [...entry.text.matchAll(LINK)].map((match) => match[0]);
			const opens = Boolean(entry.detail || links.length || wallPreview(entry));
			let row: HTMLElement;
			if (!opens)
				row = h(
					"li",
					{ class: `agent-wall-item${fresh ? " is-new" : ""}`, "data-wall-item": key },
					mark,
					h("span", { class: "agent-wall-text" }, markdownInline(entry.text)),
					news,
				);
			else {
				// The headline is the row's button: its links read as words there, and as links when it opens.
				const open = this.#expanded.has(key);
				const id = `agent-wall-detail-${key}-${this.#serial}`;
				const detail = h(
					"div",
					{ class: "agent-wall-detail", id, hidden: !open },
					entry.detail ? h("p", { class: "agent-wall-detail-text" }, markdownInline(entry.detail)) : null,
					links.length ? h("p", { class: "agent-wall-detail-links" }, markdownInline(links.join(" · "))) : null,
				);
				if (open) {
					const preview = this.#preview(entry);
					if (preview) detail.append(preview);
				} else detail.dataset.preview = "later";
				row = h(
					"li",
					{
						class: `agent-wall-item is-expandable${fresh ? " is-new" : ""}${open ? " is-open" : ""}`,
						"data-wall-item": key,
					},
					h(
						"button",
						{
							type: "button",
							class: "agent-wall-row",
							"aria-expanded": String(open),
							"aria-controls": id,
							onclick: () => this.#toggleItem(key, row),
						},
						mark,
						h("span", { class: "agent-wall-text" }, plainWords(entry.text)),
						news,
						icon("chevron"),
					),
					detail,
				);
			}
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
				wall.waiting.map((entry) => item("waiting", entry)),
			),
			part(
				"working",
				t("Working on"),
				wall.working.map((entry) => item("working", entry)),
			),
			part(
				"done",
				t("Done"),
				shownDone.map((done) => item("done", done, `${done.day}: ${done.text}`)),
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
