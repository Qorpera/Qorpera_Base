import { parseWall, type Wall, type WallItem, wallPreview } from "@qorpera/cloud-client/agent-wall";
import { isInterfaceName } from "@qorpera/cloud-client/interfaces";
import { forgetPictureUrl, pictureUrl } from "../app/folder-images.ts";
import type { HostedStaffAgent } from "../cloud/types.ts";
import { h, icon, replace } from "./dom.ts";
import { folderLinkPath } from "./folder-links.ts";
import { markdownInline } from "./markdown.ts";
import { playOnce } from "./motion.ts";
import { phrase, t } from "./preferences.ts";

/* An agent's wall, right above its composer (Jonas, 6 Nov 2026): one small centred button, "N waits on you · N working",
 * that opens upward and pushes the chat up. Open, it shows what the agent is working on and, nearest the composer, what
 * waits on the member. What the agent has done is not shown (Jonas, 10 Nov 2026: "showing this notch of what's been
 * done is pointless"): a wall with only done items shows nothing, though the file keeps its Done part. The wall
 * is the file QorperaOS/agents/<handle>/wall.md (@qorpera/cloud-client/agent-wall); the view reads it and hands its text
 * here.
 *
 * Each item is a headline (Jonas, 5 November 2026: no more text per headline than a glance takes). One with more to it
 * (a detail, a link) is a row that opens on a click: its detail and links, drawn as a message draws them, so its folder
 * links and app cards are the same buttons the app answers in a message (app/application.ts), and a preview of the
 * picture or app it links. What is new since the member last saw the wall open is marked; what
 * was seen, and whether the poster is folded, is kept per member and agent on this device. */

export type WallPosterAgent = Pick<HostedStaffAgent, "id" | "displayName" | "appearance" | "templateId">;

const SEEN_KEY = "qorpera.agent-wall.seen.";
const FOLD_KEY = "qorpera.agent-wall.folded.";

type Part = "waiting" | "working";

/** A short, stable name for one item: its part and its words. FNV-1a, 32 bits. */
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
	];
}

/** The wall as the poster shows it: what waits and what is worked on, without what is done. */
function shownWall(text: string): Wall {
	return { ...parseWall(text).wall, done: [] };
}

/** A headline as plain words for the row's button, which holds no link: Markdown drawn, then read back as text, so
 * an emphasis, a link's words or a bare address all read as words. */
function plainWords(text: string): string {
	const drawn = h("span", null, markdownInline(text.replace(LINK, "$1")));
	return drawn.textContent ?? "";
}

/** An item as the member answers it: two with one headline and different details are two questions. */
function answerKey(entry: WallItem): string {
	return `${entry.text}\n${entry.detail ?? ""}`;
}

/** Markdown links in a headline: the row is a button, so they show as words there and as links when it opens. */
const LINK = /\[([^\]]*)\]\(((?:folder|app):[^)\s]+|https?:\/\/[^)\s]+)\)/g;

/** Where one member's view of one agent's wall is kept on this device (no member: the agent alone). */
function slot(member: string, agentId: string): string {
	return member ? `${member}.${agentId}` : agentId;
}

/* What was seen and the fold state are a convenience of this device: storage that throws or is empty changes nothing
 * but the marks. */
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

export interface WallPosterOptions {
	/** The member who looks: what was seen and the fold state are theirs, per agent. */
	member?: string;
	/** Reads a picture of the company's folder an item links, for its preview; null when there is none to show. */
	image?: (path: string, signal: AbortSignal) => Promise<Blob | null>;
	/** The member means to answer what waits on them: the view puts them in its composer. */
	/** The member pressed Answer: the question's words, and the item to name to `answerSent`. */
	onAnswer?: (question: string, item: string) => void;
}

export class AgentWallPoster {
	readonly el: HTMLElement;
	readonly #toggle: HTMLButtonElement;
	/** What the closed button leads with: a dot when something waits, else a spinner while something is worked on. */
	readonly #state = h("span", { class: "agent-wall-state", "aria-hidden": "true" });
	readonly #summary = h("span", { class: "agent-wall-summary" });
	readonly #closeWord = h("span", { class: "agent-wall-close-word" });
	readonly #body = h("div", { class: "agent-wall-body", id: `agent-wall-${crypto.randomUUID()}` });
	readonly #fold: HTMLElement;
	readonly #member: string;
	readonly #onAnswer: WallPosterOptions["onAnswer"];
	readonly #image: WallPosterOptions["image"];
	/** Previews read for this agent, by path: a picture is read once while the poster shows the agent. */
	#pictures = new Map<string, Promise<string | null>>();
	#pictureLife = new AbortController();
	/** Items opened, by key, while the poster shows this agent. */
	#expanded = new Set<string>();
	#agent: WallPosterAgent | undefined;
	#text: string | null = null;
	#key = "";
	#open = false;
	/** Items answered from here: until the agent takes them off the wall, they wait on nobody. */
	#answered = new Set<string>();
	/** Items new since the member last saw this wall, while the poster shows this agent. */
	#fresh = new Set<string>();
	/** Items drawn so far: one that joins later comes in moving. */
	#drawn: Set<string> | undefined;
	/** The items drawn, by key, for an item that opens later. */
	#items = new Map<string, WallItem>();
	/** Tells this poster's detail ids apart from another poster's on the page. */
	readonly #serial = Math.random().toString(36).slice(2, 8);

	constructor(options: WallPosterOptions = {}) {
		this.#member = options.member ?? "";
		this.#onAnswer = options.onAnswer;
		this.#image = options.image;
		this.#toggle = h(
			"button",
			{
				type: "button",
				class: "agent-wall-toggle",
				"aria-controls": this.#body.id,
				onclick: () => this.#setOpen(!this.#open),
			},
			this.#state,
			this.#summary,
			this.#closeWord,
			icon("chevron"),
		);
		this.#fold = h("div", { class: "agent-wall-fold" }, this.#body);
		this.el = h(
			"section",
			{ class: "agent-wall", hidden: true },
			this.#fold,
			h("div", { class: "agent-wall-bar" }, this.#toggle),
		);
	}

	/** Whether the poster shows (a wall with at least one item). */
	get shown(): boolean {
		return !this.el.hidden;
	}

	/** Shows `agent`'s wall as `text` reads, or nothing when there is no agent, no text, or nothing that waits or is
	 * worked on. The same wall again changes nothing. */
	show(agent: WallPosterAgent | undefined, text: string | null): void {
		const key = JSON.stringify([agent?.id, agent?.displayName, agent?.appearance, text]);
		if (key === this.#key) return;
		this.#key = key;
		if (agent?.id !== this.#agent?.id) {
			this.#fresh = new Set();
			this.#drawn = undefined;
			this.#expanded = new Set();
			this.#answered = new Set();
			this.#forgetPictures();
		} else if (text !== this.#text) {
			// The wall changed: an opened item reads its picture again, which may have changed with it.
			this.#forgetPictures();
		}
		this.#agent = agent;
		this.#text = text;
		const wall = agent && text !== null ? shownWall(text) : undefined;
		// Off the wall, an answered item is over: the same words later are a new question.
		if (wall) {
			const asked = new Set(wall.waiting.map(answerKey));
			this.#answered = new Set([...this.#answered].filter((item) => asked.has(item)));
		}
		const keys = wall ? keysOf(wall) : [];
		if (!agent || !wall || !keys.length) {
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
		// Closed until the member opens it, however much is new: the button says so and the chat keeps its room.
		if (!this.#drawn) this.#open = readFolded(where) === false;
		this.el.hidden = false;
		this.#draw(agent, wall);
		this.#syncOpen();
		// Seen once open; a wall never seen before is the start to mark from, folded or not.
		if (this.#open || !seen) writeSeen(where, keys);
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
			shown = read(path, signal)
				.then((blob) => (blob && !signal.aborted ? pictureUrl(blob) : null))
				.catch(() => null);
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

	/** The answer to this item (from `onAnswer`) has been sent. */
	answerSent(item: string): void {
		this.#answered.add(item);
		if (this.#agent && this.#text !== null && !this.el.hidden) this.#draw(this.#agent, shownWall(this.#text));
	}

	#setOpen(open: boolean): void {
		if (open === this.#open) return;
		this.#open = open;
		const agent = this.#agent;
		if (agent) writeFolded(slot(this.#member, agent.id), !open);
		if (open && agent && this.#text !== null) writeSeen(slot(this.#member, agent.id), keysOf(shownWall(this.#text)));
		// Closed again, what was new has been seen: the button no longer counts it.
		if (!open) {
			this.#fresh = new Set();
		}
		if (agent && this.#text !== null) this.#draw(agent, shownWall(this.#text));
		this.#syncOpen();
	}

	#syncOpen(): void {
		this.el.classList.toggle("is-folded", !this.#open);
		this.#fold.inert = !this.#open;
		// Open, the rows say what the summary said: the button says what it does.
		this.#closeWord.textContent = t("Close");
		this.#toggle.setAttribute("aria-expanded", String(this.#open));
	}

	#draw(agent: WallPosterAgent, wall: Wall): void {
		this.el.setAttribute("aria-label", t("{name}'s wall", { name: agent.displayName }));
		const counts: Node[] = [];
		const count = (n: number, one: string, many = one, className?: string) => {
			if (!n) return;
			counts.push(
				h(
					"span",
					className ? { class: className } : null,
					`${counts.length ? " · " : ""}${t(n === 1 ? one : many, { n })}`,
				),
			);
		};
		const answered = wall.waiting.filter((entry) => this.#answered.has(answerKey(entry))).length;
		const waiting = wall.waiting.length - answered;
		count(waiting, phrase("{n} waits on you"), phrase("{n} wait on you"), "agent-wall-count-waiting");
		count(answered, phrase("{n} answered"));
		count(wall.working.length, phrase("{n} working"));
		replace(this.#summary, ...counts);
		this.#state.className = `agent-wall-state${waiting ? " is-waiting" : wall.working.length ? " is-working" : ""}`;

		const drawn = new Set<string>();
		this.#items = new Map();
		const item = (part: Part, entry: WallItem, keyText = entry.text) => {
			// The same headline twice in a part (two "Approve the post"): the second has a key of its own.
			let key = itemKey(part, keyText);
			for (let again = 2; drawn.has(key); again++) key = `${itemKey(part, keyText)}-${again}`;
			drawn.add(key);
			this.#items.set(key, entry);
			const fresh = this.#fresh.has(key);
			const mark = h("span", { class: "agent-wall-mark", "aria-hidden": "true" });
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
			if (part === "waiting" && this.#onAnswer) {
				row.classList.add("has-answer");
				const done = this.#answered.has(answerKey(entry));
				row.classList.toggle("is-answered", done);
				row.append(
					h(
						"button",
						{
							type: "button",
							class: "btn btn-small agent-wall-answer",
							...(done ? { title: t("Answer again"), "aria-label": t("Answer again") } : {}),
							onclick: () => {
								// The question moves down into the composer.
								this.#setOpen(false);
								this.#onAnswer?.(plainWords(entry.text), answerKey(entry));
							},
						},
						done ? t("Answered") : t("Answer"),
					),
				);
			}
			// What joins the wall while it is on screen comes in moving.
			if (this.#drawn && !this.#drawn.has(key)) playOnce(row, "is-entering");
			return row;
		};
		const part = (name: Part, label: string, rows: Node[]) =>
			rows.length
				? h(
						"div",
						{ class: `agent-wall-part is-${name}`, role: "group", "aria-label": label },
						h("ul", { class: "agent-wall-list" }, rows),
					)
				: null;

		replace(
			this.#body,
			part(
				"working",
				t("Working on"),
				wall.working.map((entry) => item("working", entry)),
			),
			part(
				"waiting",
				t("Waits on you"),
				wall.waiting.map((entry) => item("waiting", entry)),
			),
		);
		// What was drawn before stays still.
		this.#drawn = new Set([...(this.#drawn ?? []), ...drawn]);
	}
}
