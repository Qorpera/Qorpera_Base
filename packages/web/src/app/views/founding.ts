import {
	type CompanyFounding,
	FOUNDING_MAX_SEATS,
	FOUNDING_NAME_MAX_CHARACTERS,
	FOUNDING_ROLE_MAX_CHARACTERS,
	type FounderSeat,
} from "../../cloud/company-founding.ts";
import type { FoundingField } from "../../cloud/founding-presence.ts";
import { button, confirmDialog, h, icon, notice, personAvatar, personColor, spinner } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import type { FounderLive, FoundingController } from "../founding.ts";
import { navigate } from "../router.ts";
import { mountCrown } from "./crown.ts";

/* The founding table, drawn as writing the first message together (Jonas, 22 October 2026, hub round 3):
 * the company's name as the page's heading, then one box like qorpera.com's, with the Co-Founder's crown
 * looking over its edge and the people at the table beside it. The box holds the idea, which every founder
 * may edit, and each founder's own line (their role) in their colour. Under it, one chip per seat, then
 * Ready and Start. People only; no agents, no billing.
 *
 * The page is built once and updated in place while the table refreshes every few seconds: text
 * fields are never replaced, so typing, an accent or IME composition, the caret, focus and the
 * scroll position all survive a refresh, and a click that lands during a refresh still counts.
 * Other parts are rebuilt only when what they show changes. Text saves when its field is left.
 *
 * With live presence (founding-presence.ts) the people here now have a ring in their colour over the box, someone
 * writing has a pulsing one, "Writing" on their chip and "{name} is writing" in the box, and their caret and name flag
 * stand in the idea box where they write. A field you have not touched follows the newest writer's words as it
 * follows the table's, their new words tinted in their colour; a field you changed keeps your words, and their caret
 * stands where it falls in them. Nothing of this is saved: Ready and Start still check your own fields. */

/** Text typed on the table and not saved yet. */
export interface FoundingDrafts {
	name?: string;
	vision?: string;
	role?: string;
}

/** The description's byte limit is 16 KiB; this many UTF-16 units always fits. */
const VISION_MAX_UNITS = 5000;

/** A part of the page rebuilt only when its key changes. */
class Slot {
	readonly el = h("div", { class: "founding-slot" });
	#key: string | undefined;
	show(key: string, build: () => HTMLElement | null): void {
		if (key === this.#key) return;
		this.#key = key;
		const built = build();
		if (built) this.el.replaceChildren(built);
		else this.el.replaceChildren();
	}
}

/** A text box that grows with its text, as qorpera.com's does. */
function growToText(field: HTMLTextAreaElement): void {
	field.style.height = "auto";
	if (field.scrollHeight > 0) field.style.height = `${field.scrollHeight}px`;
}

/** A place in a text that does not split a character made of two UTF-16 units. */
function whole(text: string, index: number): number {
	const at = Math.max(0, Math.min(index, text.length));
	const high = text.charCodeAt(at - 1);
	const low = text.charCodeAt(at);
	return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff ? at - 1 : at;
}

/** How two texts differ: the length of their common start, and of their common end after it. */
function common(a: string, b: string): { start: number; end: number } {
	const shorter = Math.min(a.length, b.length);
	let start = 0;
	while (start < shorter && a[start] === b[start]) start++;
	let end = 0;
	while (end < shorter - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
	return { start, end };
}

/** Where a caret at `index` in `from` stands in `to`: at the same words, or, inside words `to` does not have, where
 * they would begin. */
export function caretIn(from: string, index: number, to: string): number {
	if (from === to) return whole(to, index);
	const { start, end } = common(from, to);
	if (index <= start) return whole(to, index);
	if (index >= from.length - end) return whole(to, to.length - (from.length - index));
	return whole(to, start);
}

/** The part of `text` that is not in `saved`, if any. */
export function newWords(saved: string, text: string): { start: number; end: number } | undefined {
	const { start, end } = common(saved, text);
	const last = text.length - end;
	return last > start ? { start: whole(text, start), end: whole(text, last) } : undefined;
}

interface Caret {
	at: number;
	userId: string;
	name?: string;
}

/** Writes `text` into `container` with others' carets (a bar in their colour, with their name when given) and one
 * writer's new words tinted in their colour. In the copy laid over a text field the words are invisible and only
 * the carets and the tint show. */
function writeMarked(
	container: HTMLElement,
	text: string,
	carets: readonly Caret[],
	mark?: { start: number; end: number; userId: string },
): void {
	const cuts = [
		...new Set([0, text.length, ...carets.map((caret) => caret.at), ...(mark ? [mark.start, mark.end] : [])]),
	]
		.filter((at) => at >= 0 && at <= text.length)
		.sort((a, b) => a - b);
	const nodes: Node[] = [];
	cuts.forEach((at, index) => {
		for (const caret of carets.filter((item) => item.at === at)) {
			const bar = h("span", { class: "founding-caret" }, caret.name ? h("b", null, caret.name) : null);
			bar.style.setProperty("--line-color", personColor(caret.userId));
			nodes.push(bar);
		}
		const next = cuts[index + 1];
		if (next === undefined || next === at) return;
		const words = text.slice(at, next);
		if (mark && at >= mark.start && next <= mark.end) {
			const tinted = h("mark", { class: "founding-them" }, words);
			tinted.style.setProperty("--line-color", personColor(mark.userId));
			nodes.push(tinted);
		} else nodes.push(document.createTextNode(words));
	});
	// A text that ends in a new line has an empty last line, as the field shows it.
	if (text.endsWith("\n")) nodes.push(document.createTextNode("\u200b"));
	container.replaceChildren(...nodes);
}

/** A text field that shows the server's text unless you are editing it, and saves when you leave
 * it. Unsaved or refused text stays in the field; leaving it again tries again. */
class SyncedField<T extends HTMLInputElement | HTMLTextAreaElement> {
	readonly el: T;
	/** The field's own text when it last matched the server's (a space you just typed included). */
	#base = "";
	#server = "";
	/** Unsaved text brought over from the page this one replaced (a language change). */
	#carried: string | undefined;
	constructor(el: T, save: (value: string, field: SyncedField<T>) => void, carried?: string) {
		this.el = el;
		this.#carried = carried;
		const element: HTMLElement = el;
		element.addEventListener("blur", () => {
			if (this.dirty) save(el.value, this);
		});
		element.addEventListener("keydown", (event) => {
			// Enter that ends an IME composition is not a save (Safari reports it as keyCode 229).
			if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
			if (el instanceof HTMLTextAreaElement && event.shiftKey) return;
			event.preventDefault();
			el.blur();
		});
		if (el instanceof HTMLTextAreaElement) element.addEventListener("input", () => growToText(el));
	}
	/** You changed the field's words (being typed, being saved, or refused); only then does leaving it
	 * save. Spaces and new lines at the ends alone are no edit. */
	get dirty(): boolean {
		return this.el.value.trim() !== this.#base.trim();
	}
	/** The text not saved yet, if any. */
	get draft(): string | undefined {
		return this.dirty ? this.el.value : undefined;
	}
	show(value: string): void {
		this.#apply(value);
		if (this.el instanceof HTMLTextAreaElement) growToText(this.el);
	}
	#apply(value: string): void {
		this.#server = value;
		if (this.#carried !== undefined) {
			this.el.value = this.#carried;
			this.#base = value;
			this.#carried = undefined;
		}
		// The server has what the field says (spaces at the ends aside): nothing is unsaved, and a
		// space or new line you just typed stays.
		if (this.el.value.trim() === value) {
			this.#base = this.el.value;
			return;
		}
		if (this.dirty) return;
		// An untouched field (spaces at the ends aside) follows the server, even while it has focus; its
		// caret stays where it can.
		const focused = document.activeElement === this.el;
		const start = this.el.selectionStart;
		const end = this.el.selectionEnd;
		// A caret at the end stays at the end of the new text, so the next letters follow it.
		const atEnd = start === this.el.value.length && end === start;
		this.el.value = value;
		this.#base = value;
		if (focused && atEnd) this.el.setSelectionRange(value.length, value.length);
		else if (focused && start !== null && end !== null)
			this.el.setSelectionRange(Math.min(start, value.length), Math.min(end, value.length));
	}
	/** Puts the server's text back (a name cannot be empty). */
	reset(): void {
		this.el.value = this.#server;
		this.#base = this.#server;
	}
}

function names(table: CompanyFounding, userIds: readonly string[], me: string): string {
	const list = userIds.map((id) =>
		id === me ? t("you") : (table.seats.find((seat) => seat.userId === id)?.displayName ?? t("a founder")),
	);
	if (list.length <= 1) return list.join("");
	return t("{names} and {last}", { names: list.slice(0, -1).join(", "), last: list[list.length - 1]! });
}

/** Where someone is, live: at the table now, and writing. */
interface SeatPresence {
	here: boolean;
	writing: boolean;
}

/** One seat under the box: who, and where they are (Ready, not yet, invited, writing now); Remove or Withdraw when
 * you may. With live presence, the face of someone here now has a ring in their colour. */
class SeatChip {
	readonly el: HTMLElement;
	readonly #body = new Slot();
	readonly #founding: FoundingController;
	readonly #mine: boolean;

	constructor(founding: FoundingController, seat: FounderSeat) {
		this.#founding = founding;
		this.#mine = seat.userId === founding.userId;
		this.el = h(
			"article",
			{ class: this.#mine ? "founding-seat founding-seat-mine" : "founding-seat", "data-user": seat.userId },
			this.#body.el,
		);
	}

	update(table: CompanyFounding, seat: FounderSeat, presence: SeatPresence | undefined): void {
		const founding = this.#founding;
		const canRemove = table.me.canManage && seat.state === "joined" && !this.#mine;
		const canWithdraw =
			seat.state === "invited" && !this.#mine && (table.me.canManage || seat.invitedByUserId === founding.userId);
		this.el.classList.toggle("founding-seat-invited", seat.state === "invited");
		this.el.classList.toggle("founding-seat-here", presence?.here === true);
		const writing = presence?.writing === true && seat.state === "joined";
		const status = writing
			? t("Writing")
			: seat.state === "invited"
				? t("Invited")
				: seat.ready
					? t("Ready ✓")
					: seat.modelLoginReady
						? t("Not ready yet")
						: t("ChatGPT not connected");
		const here = presence?.here === true && !this.#mine;
		this.#body.show([seat.displayName, seat.state, status, here, canRemove, canWithdraw].join("\n"), () => {
			const face = personAvatar(seat.displayName, seat.userId);
			face.style.setProperty("--line-color", personColor(seat.userId));
			const line = h(
				"span",
				{
					class: writing
						? "founding-status founding-status-writing"
						: seat.ready && seat.state === "joined"
							? "founding-status founding-status-ready"
							: "founding-status",
				},
				status,
			);
			if (writing) line.style.setProperty("--line-color", personColor(seat.userId));
			return h(
				"div",
				{ class: "founding-seat-row" },
				face,
				h("strong", null, this.#mine ? t("You") : seat.displayName),
				here ? h("span", { class: "visually-hidden" }, t("Here now")) : null,
				line,
				canRemove
					? button(
							t("Remove"),
							() =>
								void confirmDialog(
									t("Remove {name} from the table?", { name: seat.displayName }),
									t("Remove"),
									true,
								).then((yes) => {
									if (yes) void founding.removeSeat(seat.userId);
								}),
							{ small: true },
						)
					: null,
				canWithdraw ? button(t("Withdraw"), () => void founding.removeSeat(seat.userId), { small: true }) : null,
			);
		});
	}
}

export class FoundingView {
	/** The page's scroller; it stays for the life of the view, and so does its scroll position. */
	readonly el = h("section", { class: "founding" });
	readonly #founding: FoundingController;
	#mode = "";
	readonly #page = new Slot();
	// The open table's parts, kept across refreshes.
	readonly #nameSlot = new Slot();
	readonly #sub = h("p", { class: "founding-sub" });
	readonly #visionSlot = new Slot();
	#name: SyncedField<HTMLInputElement> | undefined;
	#vision: SyncedField<HTMLTextAreaElement> | undefined;
	#role: SyncedField<HTMLTextAreaElement> | undefined;
	readonly #roleSlot = new Slot();
	readonly #lines = new Slot();
	readonly #heads = new Slot();
	readonly #crownStage = h("span", { class: "founding-crown", "aria-hidden": "true" });
	readonly #invitation = new Slot();
	readonly #seatList = h("div", { class: "founding-seats" });
	readonly #seats = new Map<string, SeatChip>();
	readonly #invite: HTMLButtonElement;
	readonly #inviteFaces = new Slot();
	/** "{name} is writing", under the box's text. */
	readonly #writing = h("p", { class: "founding-writing" });
	/** The others' carets over the idea box, laid out as its text is. */
	readonly #carets = h("div", { class: "founding-carets", "aria-hidden": "true" });
	readonly #boxFoot: HTMLElement;
	readonly #friends: HTMLElement;
	readonly #friendList = new Slot();
	readonly #friendNote = new Slot();
	readonly #friendEmail: HTMLInputElement;
	readonly #friendAdd: HTMLButtonElement;
	readonly #connect: HTMLElement;
	readonly #connectBody = h("div");
	readonly #connectText = h("p", { class: "muted small" });
	readonly #error = new Slot();
	readonly #ready: HTMLButtonElement;
	readonly #start: HTMLButtonElement;
	readonly #waiting = h("p", { class: "founding-hint" });
	readonly #owners = h("p", { class: "founding-hint" });
	readonly #withdrawn = h("p", { class: "founding-hint" });
	readonly #bar: HTMLElement;
	readonly #exit = new Slot();
	readonly #startedSlot = new Slot();
	readonly #opened = { connect: false };
	/** The table as the Ready and Start buttons were last drawn: a click asks for what it showed. */
	#seen: { revision: number; alone: boolean; ready: boolean; connected: boolean } = {
		revision: 0,
		alone: false,
		ready: false,
		connected: false,
	};

	/** Unsaved text brought over from the page this one replaces (a language change). */
	readonly #carried: FoundingDrafts;

	constructor(founding: FoundingController, carried: FoundingDrafts = {}) {
		this.#founding = founding;
		this.#carried = carried;
		founding.watchUnsaved(() => this.#unsaved());
		this.el.append(this.#page.el);
		this.#invite = h(
			"button",
			{
				type: "button",
				class: "founding-invite",
				onclick: () => founding.openFriends(!founding.store.get().friendsOpen),
			},
			this.#inviteFaces.el,
			h("span", { class: "founding-plus", "aria-hidden": "true" }, icon("plus")),
			t("Invite friends"),
		);
		this.#boxFoot = h("div", { class: "founding-box-foot" }, this.#invite, this.#writing);
		this.#friendEmail = h("input", {
			id: "foundingFriendEmail",
			type: "email",
			autocomplete: "email",
			placeholder: t("Their email address"),
		});
		this.#friendAdd = h("button", { type: "submit", class: "btn" }, t("Add friend"));
		this.#friends = h(
			"section",
			{ class: "founding-sheet founding-friends-sheet", "aria-label": t("Invite friends"), hidden: true },
			h(
				"div",
				{ class: "founding-sheet-head" },
				h("h2", null, t("Invite friends")),
				h("span", { class: "muted small" }, t("They join as co-founders.")),
				h(
					"button",
					{
						type: "button",
						class: "founding-close",
						"aria-label": t("Close"),
						onclick: () => founding.openFriends(false),
					},
					icon("close"),
				),
			),
			this.#friendList.el,
			h(
				"form",
				{
					class: "founding-add-friend",
					onsubmit: (event: Event) => {
						event.preventDefault();
						void founding.addFriend(this.#friendEmail.value).then((sent) => {
							if (sent) this.#friendEmail.value = "";
						});
					},
				},
				h("label", { for: "foundingFriendEmail" }, t("Add a friend")),
				h("div", { class: "founding-inline" }, this.#friendEmail, this.#friendAdd),
			),
			this.#friendNote.el,
		);
		this.#connect = h(
			"section",
			{ class: "founding-sheet founding-connect", "aria-label": t("Connect your ChatGPT account"), hidden: true },
			h(
				"div",
				{ class: "founding-sheet-head" },
				h("h2", null, t("Connect your ChatGPT account")),
				h(
					"button",
					{
						type: "button",
						class: "founding-close",
						"aria-label": t("Close"),
						onclick: () => founding.openConnect(false),
					},
					icon("close"),
				),
			),
			this.#connectText,
			this.#connectBody,
		);
		// One button for your seat's one step: Connect ChatGPT, then Ready. Never replaced, so a click that
		// lands while the table refreshes still counts; it asks for what it showed.
		this.#ready = h("button", {
			type: "button",
			class: "btn founding-ready",
			onclick: () => {
				const seen = this.#seen;
				if (!seen.connected) founding.openConnect(true);
				else void founding.setReady(seen.revision, !seen.ready);
			},
		});
		this.#start = h("button", {
			type: "button",
			class: "btn btn-primary founding-start",
			onclick: () => {
				// Alone at the table, Start is one press: Ready, then Start.
				if (this.#seen.alone) void founding.startAlone(this.#seen.revision);
				else void founding.start();
			},
		});
		this.#bar = h(
			"div",
			{ class: "founding-bar" },
			h("div", { class: "founding-actions" }, this.#ready, this.#start),
			this.#waiting,
			this.#owners,
			this.#withdrawn,
		);
	}

	/** Words you changed in a field that the table on the server does not have: a save that failed or is not sent
	 * yet. Compared with the table the controller holds, so a save that just went through counts at once, and a
	 * field you did not touch never holds anything up. An empty name is no edit (leaving it puts the name back).
	 * A page built again (a new language) and not drawn yet has no fields: the words carried over from the page
	 * it replaces count instead, so the check never lapses in between. */
	#unsaved(): boolean {
		const table = this.#founding.store.get().table;
		if (!table || table.phase !== "open") return false;
		const role = table.seats.find((seat) => seat.userId === this.#founding.userId)?.role ?? "";
		const typed = (field: SyncedField<HTMLInputElement | HTMLTextAreaElement> | undefined, carried?: string) =>
			field ? (field.dirty ? field.el.value.trim() : undefined) : carried?.trim();
		const differs = (words: string | undefined, server: string) => words !== undefined && words !== server;
		const name = typed(this.#name, this.#carried.name);
		return (
			(name !== "" && differs(name, table.companyName)) ||
			differs(typed(this.#vision, this.#carried.vision ?? this.#founding.pendingVision), table.vision) ||
			differs(typed(this.#role, this.#carried.role), role)
		);
	}

	/** Your field tells the others where you are and, live, your words and caret in it. */
	#watchLive(synced: SyncedField<HTMLInputElement | HTMLTextAreaElement>, kind: FoundingField): void {
		const founding = this.#founding;
		const field = synced.el;
		// Words count as yours only once you changed them: a field that follows another writer shows theirs.
		const send = (typing: boolean) => founding.noteLive(kind, field.value, field.selectionEnd, typing, synced.dirty);
		const element: HTMLElement = field;
		element.addEventListener("focus", () => {
			founding.noteField(kind);
			send(false);
		});
		element.addEventListener("blur", () => founding.noteField(null));
		element.addEventListener("input", () => send(true));
		// A caret moved by the keys or the pointer.
		element.addEventListener("keyup", (event) => {
			if (/^(Arrow|Home|End|Page)/.test(event.key)) send(false);
		});
		element.addEventListener("pointerup", () => send(false));
	}

	/** The newest writer's own words in a field that differ from the table's: an untouched field follows them. */
	#following(field: FoundingField): FounderLive | undefined {
		return (this.#founding.store.get().liveText ?? []).find((live) => live.field === field && live.unsaved);
	}

	/** The others' carets in the idea box, where they fall in the words it shows; the followed writer's new words
	 * tinted when the box shows exactly their words. */
	#paintVision(container: HTMLElement, shown: string): void {
		const state = this.#founding.store.get();
		const table = state.table;
		if (!table) return;
		const lives = (state.liveText ?? []).filter((live) => live.field === "vision");
		const carets = lives.flatMap((live) =>
			live.caret === null
				? []
				: [
						{
							at: caretIn(live.text, live.caret, shown),
							userId: live.userId,
							name: table.seats.find((seat) => seat.userId === live.userId)?.displayName ?? t("a founder"),
						},
					],
		);
		const followed = this.#following("vision");
		const words = followed && followed.text === shown ? newWords(table.vision, shown) : undefined;
		writeMarked(container, shown, carets, words && followed ? { ...words, userId: followed.userId } : undefined);
	}

	/** Text typed here and not saved yet, to carry over when the page is built again. */
	drafts(): FoundingDrafts {
		return {
			...(this.#name?.draft !== undefined ? { name: this.#name.draft } : {}),
			...(this.#vision?.draft !== undefined ? { vision: this.#vision.draft } : {}),
			...(this.#role?.draft !== undefined ? { role: this.#role.draft } : {}),
		};
	}

	update(): void {
		const state = this.#founding.store.get();
		const table = state.table;
		const mode = state.gone
			? `gone:${state.gone}`
			: !table
				? "loading"
				: table.phase === "started"
					? "started"
					: "open";
		if (mode !== this.#mode) {
			this.#mode = mode;
			this.#page.show(mode, () => this.#build(mode));
			// The crown stops when it leaves the page; the open table gets a new one each time it is built.
			if (mode === "open") {
				this.#crownStage.replaceChildren();
				mountCrown(this.#crownStage, { mirrored: false });
			}
		}
		if (mode === "loading")
			this.#error.show(state.readError ?? "", () => (state.readError ? notice("danger", state.readError) : null));
		else if (mode === "started") this.#started(table!);
		else if (mode === "open") this.#open(table!);
	}

	#build(mode: string): HTMLElement {
		if (mode.startsWith("gone:")) {
			const message = {
				declined: t("You declined the invitation."),
				left: t("You left the table."),
				closed: t("You closed the table."),
				unavailable: t("This table is no longer available to you."),
			}[mode.slice(5) as "declined" | "left" | "closed" | "unavailable"];
			return h(
				"div",
				{ class: "founding-page founding-gone" },
				h("p", null, message),
				h("a", { href: "#/", class: "btn" }, t("Back to your companies")),
			);
		}
		if (mode === "loading")
			return h("div", { class: "founding-page" }, spinner(t("Opening the table")), this.#error.el);
		if (mode === "started") return h("div", { class: "founding-page founding-started" }, this.#startedSlot.el);
		return h(
			"div",
			{ class: "founding-page" },
			h("header", { class: "founding-head" }, this.#nameSlot.el, this.#sub),
			this.#invitation.el,
			h(
				"div",
				{ class: "founding-ask" },
				this.#crownStage,
				this.#heads.el,
				h("div", { class: "founding-box" }, this.#visionSlot.el, this.#lines.el, this.#roleSlot.el, this.#boxFoot),
				this.#friends,
			),
			this.#seatList,
			this.#connect,
			this.#error.el,
			this.#bar,
			this.#exit.el,
		);
	}

	#open(table: CompanyFounding): void {
		const founding = this.#founding;
		const state = founding.store.get();
		const me = founding.userId;
		const joined = table.me.state === "joined";
		const mySeat = table.seats.find((seat) => seat.userId === me);

		const name = this.#following("name")?.text ?? table.companyName;
		this.#nameSlot.show(joined ? "field" : `title\n${name}`, () => {
			if (!joined) {
				this.#name = undefined;
				return h("h1", { class: "founding-name" }, name);
			}
			const field = h("input", {
				class: "founding-name",
				type: "text",
				maxlength: FOUNDING_NAME_MAX_CHARACTERS,
				required: true,
				"aria-label": t("Company name"),
				autocomplete: "organization",
			});
			const syncedName = new SyncedField(
				field,
				(value, synced) => {
					if (value.trim()) void founding.rename(value);
					else synced.reset();
				},
				this.#carried.name,
			);
			this.#name = syncedName;
			this.#watchLive(syncedName, "name");
			return field;
		});
		this.#name?.show(name);

		const invitedBy = mySeat?.invitedByUserId;
		const inviter = table.seats.find((seat) => seat.userId === invitedBy)?.displayName;
		const sub = joined
			? t("Your first message to the Co-Founder. Write it together.")
			: inviter
				? t("{name} invited you to start {company} together.", { name: inviter, company: table.companyName })
				: t("You are invited to start {company} together.", { company: table.companyName });
		if (this.#sub.textContent !== sub) this.#sub.textContent = sub;
		this.#invitation.show(`${table.me.state}`, () =>
			table.me.state === "invited"
				? h(
						"div",
						{ class: "founding-invitation" },
						button(t("Decline"), () => void founding.respond(false)),
						button(t("Join the table"), () => void founding.respond(true), { primary: true }),
					)
				: null,
		);

		const vision = this.#following("vision")?.text ?? table.vision;
		this.#visionSlot.show(joined ? "field" : "text", () => {
			if (!joined) {
				this.#vision = undefined;
				return h("p", { class: "founding-vision" });
			}
			const field = h("textarea", {
				class: "founding-vision",
				rows: 1,
				maxlength: VISION_MAX_UNITS,
				placeholder: t("What is the company for? One line is enough to start."),
				"aria-label": t("What the company is for"),
			});
			// The idea the opening could not save waits here as your unsaved text: leaving the box saves it.
			const syncedVision = new SyncedField(
				field,
				(value) => void founding.describe(value),
				this.#carried.vision ?? founding.pendingVision,
			);
			this.#vision = syncedVision;
			this.#watchLive(syncedVision, "vision");
			// Your own words move the others' carets too.
			field.addEventListener("input", () => this.#paintVision(this.#carets, field.value));
			return h("div", { class: "founding-vision-field" }, field, this.#carets);
		});
		this.#vision?.show(vision);
		const shownVision = this.#vision?.el.value ?? vision;
		const visionText = this.#visionSlot.el.querySelector<HTMLElement>("p.founding-vision");
		if (visionText) {
			visionText.hidden = !vision;
			this.#paintVision(visionText, vision);
		} else this.#paintVision(this.#carets, shownVision);

		// Every other founder's own line, in their colour, as they write it; yours is the field under them.
		const others = table.seats
			.filter((seat) => seat.userId !== me && seat.state === "joined")
			.map((seat) => {
				const live = (state.liveText ?? []).find((item) => item.userId === seat.userId && item.field === "role");
				const writing = live !== undefined && (live.unsaved || live.caret !== null);
				return { seat, text: writing ? live.text : seat.role, caret: writing ? live.caret : null };
			})
			.filter((line) => line.text || line.caret !== null);
		this.#lines.show(
			others.map((line) => `${line.seat.userId}:${line.seat.displayName}:${line.caret}:${line.text}`).join("\n"),
			() =>
				others.length === 0
					? null
					: h(
							"div",
							{ class: "founding-lines" },
							...others.map(({ seat, text, caret }) => {
								const words = h("span");
								writeMarked(words, text, caret === null ? [] : [{ at: caret, userId: seat.userId }]);
								const line = h(
									"p",
									{ class: "founding-line" },
									h("span", { class: "founding-line-who" }, seat.displayName),
									words,
								);
								line.style.setProperty("--line-color", personColor(seat.userId));
								return line;
							}),
						),
		);
		this.#roleSlot.show(joined ? "mine" : "none", () => {
			if (!joined) {
				this.#role = undefined;
				return null;
			}
			const field = h("textarea", {
				class: "founding-role founding-role-mine",
				rows: 1,
				maxlength: FOUNDING_ROLE_MAX_CHARACTERS,
				placeholder: t("What will you do? Optional — one sentence is plenty."),
				"aria-label": t("Your role"),
			});
			field.style.setProperty("--line-color", personColor(me));
			const syncedRole = new SyncedField(field, (value) => void founding.setRole(value), this.#carried.role);
			this.#role = syncedRole;
			this.#watchLive(syncedRole, "role");
			return field;
		});
		if (mySeat && joined) this.#role?.show(mySeat.role);

		// The people at the table look over the box's edge, as the crown does. With live presence, the ones here now
		// have a ring in their colour (you always), and someone writing a pulsing one.
		const presence = new Map((state.present ?? []).map((person) => [person.userId, person]));
		const live = state.live === true;
		const seen = (userId: string) =>
			live
				? {
						here: userId === me || presence.get(userId)?.here === true,
						writing: presence.get(userId)?.writing === true,
					}
				: undefined;
		this.#heads.show(
			[
				live,
				...table.seats.map((seat) => {
					const at = seen(seat.userId);
					return `${seat.userId}:${seat.displayName}:${seat.state}:${at?.here}:${at?.writing}`;
				}),
			].join("\n"),
			() =>
				h(
					"div",
					{ class: live ? "founding-heads founding-heads-live" : "founding-heads", "aria-hidden": "true" },
					...table.seats.map((seat) => {
						const at = seen(seat.userId);
						const face = personAvatar(seat.displayName, seat.userId);
						face.classList.toggle("founding-head-invited", seat.state === "invited");
						face.classList.toggle("founding-head-here", at?.here === true);
						face.classList.toggle("founding-head-writing", at?.writing === true && seat.state === "joined");
						face.style.setProperty("--line-color", personColor(seat.userId));
						return face;
					}),
				),
		);
		const writers = table.seats.filter((seat) => seat.state === "joined" && seen(seat.userId)?.writing);
		const writingText =
			writers.length === 0
				? ""
				: writers.length === 1
					? t("{name} is writing", { name: writers[0]!.displayName })
					: t("{names} are writing", {
							names: names(
								table,
								writers.map((seat) => seat.userId),
								me,
							),
						});
		if (this.#writing.dataset.text !== writingText) {
			this.#writing.dataset.text = writingText;
			this.#writing.replaceChildren(
				h("span", { class: "founding-dots", "aria-hidden": "true" }, h("b"), h("b"), h("b")),
				writingText,
			);
			if (writers[0]) this.#writing.style.setProperty("--line-color", personColor(writers[0].userId));
		}
		this.#writing.hidden = !writingText;
		const full = table.seats.length >= FOUNDING_MAX_SEATS;
		this.#invite.hidden = !joined || full;
		this.#boxFoot.hidden = this.#invite.hidden && this.#writing.hidden;
		this.#invite.setAttribute("aria-expanded", String(state.friendsOpen === true));
		this.#inviteFaces.show(table.seats.map((seat) => `${seat.userId}:${seat.displayName}`).join("\n"), () =>
			h(
				"span",
				{ class: "founding-invite-faces" },
				...table.seats.slice(0, 4).map((seat) => personAvatar(seat.displayName, seat.userId)),
			),
		);

		// Seats in the server's order. A chip is kept per person and moved only when the order changes.
		const chips = table.seats.map((seat) => {
			let chip = this.#seats.get(seat.userId);
			if (!chip) {
				chip = new SeatChip(founding, seat);
				this.#seats.set(seat.userId, chip);
			}
			chip.update(table, seat, seen(seat.userId));
			return chip.el;
		});
		for (const userId of [...this.#seats.keys()])
			if (!table.seats.some((seat) => seat.userId === userId)) this.#seats.delete(userId);
		for (const child of [...this.#seatList.children]) if (!chips.includes(child as HTMLElement)) child.remove();
		chips.forEach((node, index) => {
			const at = this.#seatList.children[index];
			if (at !== node) this.#seatList.insertBefore(node, at ?? null);
		});

		this.#friendsPanel(table, joined && state.friendsOpen === true);
		this.#connectPanel(table, joined && state.connectOpen === true);

		const error = state.error ?? state.readError ?? "";
		this.#error.show(`${error}\n${state.error !== undefined}`, () =>
			error
				? notice(
						"danger",
						error,
						state.error ? button(t("Dismiss"), () => founding.dismissError(), { small: true }) : null,
					)
				: null,
		);

		this.#bar.hidden = !joined;
		const alone = table.seats.length === 1 && mySeat?.state === "joined";
		const connected = mySeat?.modelLoginReady === true;
		const ready = mySeat?.ready === true;
		this.#seen = { revision: table.revision, alone, ready, connected };
		// Alone, Ready is part of Start; with others, each founder says Ready first.
		this.#ready.hidden = alone && connected;
		const readyLabel = !connected ? t("Connect ChatGPT") : ready ? t("Ready ✓") : t("Ready");
		if (this.#ready.textContent !== readyLabel) this.#ready.textContent = readyLabel;
		this.#ready.classList.toggle("founding-ready-on", connected && ready);
		this.#ready.classList.toggle("founding-connect-button", !connected);
		this.#ready.title = !connected
			? t("Connect your own ChatGPT account to be Ready")
			: ready
				? t("Not ready after all")
				: t("I'm ready for the table as it is now");
		const startLabel = state.busy === "start" ? t("Starting…") : t("Start {name}", { name: table.companyName });
		if (this.#start.textContent !== startLabel) this.#start.textContent = startLabel;
		this.#start.disabled = state.busy === "start" || (alone ? !connected : !table.me.canStart);
		this.#waiting.hidden = alone;
		this.#waiting.textContent =
			table.waitingFor.length > 0
				? t("Waiting for {names} to be ready", { names: names(table, table.waitingFor, me) })
				: t("Everyone is ready.");
		this.#owners.hidden = alone;
		this.#owners.textContent = t("Everyone at the table becomes a founder of {name}.", { name: table.companyName });
		this.#withdrawn.textContent = t("Invitations nobody has answered are withdrawn at Start.");
		this.#withdrawn.hidden = !table.seats.some((seat) => seat.state === "invited");

		const joinedCount = table.seats.filter((seat) => seat.state === "joined").length;
		this.#exit.show(`${joined}\n${table.me.canManage}\n${joinedCount === 1}\n${table.companyName}`, () => {
			if (!joined) return null;
			if (!table.me.canManage)
				return h(
					"div",
					{ class: "founding-exit" },
					button(
						t("Leave the table"),
						() =>
							void confirmDialog(
								t("Leave the table for {name}?", { name: table.companyName }),
								t("Leave"),
								true,
							).then(async (yes) => {
								if (yes && (await founding.leave())) navigate({ name: "hub" });
							}),
						{ small: true },
					),
				);
			return h(
				"div",
				{ class: "founding-exit" },
				joinedCount === 1
					? button(
							t("Close the table"),
							() =>
								void confirmDialog(
									t("Close this table? {name} will not be started.", { name: table.companyName }),
									t("Close the table"),
									true,
								).then(async (yes) => {
									if (yes && (await founding.close())) navigate({ name: "hub" });
								}),
							{ small: true },
						)
					: h("span", { class: "muted small" }, t("To close the table, remove the other seats first.")),
			);
		});
	}

	#friendsPanel(table: CompanyFounding, open: boolean): void {
		const state = this.#founding.store.get();
		this.#friends.hidden = !open;
		if (!open) return;
		const seats = new Map(table.seats.map((seat) => [seat.userId, seat.state]));
		const friends = (state.friends ?? []).filter((friend) => friend.status === "accepted");
		const loading = state.friends === undefined && !state.friendsError;
		const full = table.seats.length >= FOUNDING_MAX_SEATS;
		const key = [
			loading,
			full,
			...friends.map((friend) => `${friend.userId}:${friend.displayName}:${seats.get(friend.userId) ?? ""}`),
		].join("\n");
		this.#friendList.show(key, () => {
			if (loading) return spinner(t("Loading your friends"));
			if (friends.length === 0)
				return h("p", { class: "muted small" }, t("Your friends appear here. Add one below."));
			return h(
				"div",
				null,
				h(
					"ul",
					{ class: "founding-friends" },
					...friends.map((friend) => {
						const seat = seats.get(friend.userId);
						return h(
							"li",
							null,
							personAvatar(friend.displayName, friend.userId),
							h("strong", null, friend.displayName),
							seat
								? h("span", { class: "founding-status" }, seat === "joined" ? t("At the table") : t("Invited"))
								: button(t("Invite"), () => void this.#founding.invite(friend.userId), {
										small: true,
										primary: true,
										disabled: full,
									}),
						);
					}),
				),
				full ? h("p", { class: "muted small" }, t("A table has at most eight seats.")) : null,
			);
		});
		this.#friendAdd.disabled = state.addingFriend === true;
		this.#friendNote.show(`${state.friendAdded ?? ""}\n${state.friendsError ?? ""}`, () =>
			state.friendsError
				? notice("danger", state.friendsError)
				: state.friendAdded
					? h(
							"p",
							{ class: "muted small" },
							t("Friend request sent to {email}. Invite them here once they accept.", {
								email: state.friendAdded,
							}),
						)
					: null,
		);
	}

	#connectPanel(table: CompanyFounding, open: boolean): void {
		this.#connect.hidden = !open;
		if (open && !this.#opened.connect) this.#connect.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
		this.#opened.connect = open;
		if (!open) return;
		this.#connectText.textContent = t(
			"Your own account, connected to {name}. It pays for the work you start there. You can be Ready once it is connected.",
			{ name: table.companyName },
		);
		const panel = this.#founding.connections().el;
		if (panel.parentElement !== this.#connectBody) this.#connectBody.replaceChildren(panel);
	}

	#started(table: CompanyFounding): void {
		const before = this.#founding.store.get().beforeStart;
		// Start moves the roles into the company's files; show them as the table last had them.
		const seats = table.seats.map((seat) => ({
			...seat,
			role: before?.seats.find((earlier) => earlier.userId === seat.userId)?.role ?? "",
		}));
		const ready = table.start?.companyReady === true;
		const failed = !ready && table.start?.companySetup === "failed";
		const firstRun = ready ? (table.start?.firstRun ?? null) : null;
		const key = [
			ready,
			failed,
			firstRun,
			table.companyName,
			...seats.map((seat) => `${seat.userId}:${seat.displayName}:${seat.role}`),
		].join("\n");
		this.#startedSlot.show(key, () => {
			const owners = names(
				{ ...table, seats },
				seats.map((seat) => seat.userId),
				"",
			);
			return h(
				"div",
				{ class: "founding-started-body" },
				h(
					"header",
					{ class: "founding-head" },
					h(
						"h1",
						{ class: "founding-name" },
						ready
							? t("{name} has started", { name: table.companyName })
							: failed
								? t("{name} could not be set up", { name: table.companyName })
								: t("{name} is starting", { name: table.companyName }),
					),
					h(
						"p",
						{ class: "founding-sub" },
						seats.length === 1
							? t("{name} owns it now.", { name: owners })
							: t("{names} own it now.", { names: owners }),
					),
				),
				h(
					"div",
					{ class: "founding-seats" },
					...seats.map((seat) =>
						h(
							"article",
							{ class: "founding-seat" },
							h(
								"div",
								{ class: "founding-seat-row" },
								personAvatar(seat.displayName, seat.userId),
								h("strong", null, seat.displayName),
								h("span", { class: "founding-status founding-status-ready" }, t("Founder")),
							),
							seat.role ? h("p", { class: "founding-seat-role" }, seat.role) : null,
						),
					),
				),
				// The Co-Founder could not start on its own: say why, and how its founders start it.
				firstRun === "waiting_for_login" || firstRun === "failed"
					? notice(
							"warn",
							firstRun === "waiting_for_login"
								? t(
										"The Co-Founder has not started: no ChatGPT account could pay for its first run. Connect yours in Settings → My connections, then write to the Co-Founder in its thread.",
									)
								: t(
										"The Co-Founder's first run did not start. Write to the Co-Founder in its thread to begin.",
									),
						)
					: null,
				h(
					"div",
					{ class: "founding-bar" },
					ready
						? button(
								t("Open {name}", { name: table.companyName }),
								() => navigate({ name: "company", profileId: table.profileId, section: "home" }),
								{ primary: true },
							)
						: failed
							? notice(
									"danger",
									t(
										"Setting up {name} failed. It waits for us to set it up again; nothing you did caused it.",
										{
											name: table.companyName,
										},
									),
								)
							: spinner(t("Preparing {name}", { name: table.companyName })),
				),
			);
		});
	}
}
