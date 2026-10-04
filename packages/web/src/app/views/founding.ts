import {
	type CompanyFounding,
	FOUNDING_MAX_SEATS,
	FOUNDING_NAME_MAX_CHARACTERS,
	FOUNDING_ROLE_MAX_CHARACTERS,
	type FounderSeat,
} from "../../cloud/company-founding.ts";
import { button, confirmDialog, h, notice, personAvatar, spinner } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import type { FoundingController } from "../founding.ts";
import { navigate } from "../router.ts";

/* The founding table (table v3): one seat per co-founder, a role each, Connect ChatGPT, then Ready,
 * and one Start. People only; no agents, no billing.
 *
 * The page is built once and updated in place while the table refreshes every few seconds: text
 * fields are never replaced, so typing, an accent or IME composition, the caret, focus and the
 * scroll position all survive a refresh, and a click that lands during a refresh still counts.
 * Other parts are rebuilt only when what they show changes. Text saves when its field is left. */

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

/** One seat. Your own role field and Ready button are made once; the rest follows the seat. */
class SeatCard {
	readonly el: HTMLElement;
	readonly #top = new Slot();
	readonly #role = new Slot();
	readonly #foot = new Slot();
	readonly #founding: FoundingController;
	readonly #mine: boolean;
	#field: SyncedField<HTMLTextAreaElement> | undefined;
	#ready: HTMLButtonElement | undefined;
	#seat: FounderSeat | undefined;
	#revision = 0;

	readonly #carriedRole: string | undefined;

	constructor(founding: FoundingController, seat: FounderSeat, carriedRole?: string) {
		this.#founding = founding;
		this.#mine = seat.userId === founding.userId;
		this.#carriedRole = carriedRole;
		this.el = h(
			"article",
			{ class: this.#mine ? "founding-seat founding-seat-mine" : "founding-seat", "data-user": seat.userId },
			this.#top.el,
			this.#role.el,
			h("div", { class: "founding-seat-foot" }, this.#foot.el),
		);
	}

	/** Your unsaved role, if any. */
	get draft(): string | undefined {
		return this.#field?.draft;
	}

	update(table: CompanyFounding, seat: FounderSeat): void {
		this.#seat = seat;
		this.#revision = table.revision;
		const founding = this.#founding;
		this.#top.show(`${seat.displayName}\n${seat.state}`, () =>
			h(
				"div",
				{ class: "founding-seat-top" },
				personAvatar(seat.displayName, seat.userId),
				h(
					"div",
					{ class: "founding-who" },
					h("strong", null, seat.displayName),
					this.#mine ? h("small", null, t("You")) : null,
				),
				h("span", { class: "founding-kind" }, seat.state === "joined" ? t("Co-founder") : t("Invited")),
			),
		);
		if (this.#mine && seat.state === "joined") {
			this.#role.show("mine", () => {
				const field = h("textarea", {
					class: "founding-role founding-role-mine",
					rows: 3,
					maxlength: FOUNDING_ROLE_MAX_CHARACTERS,
					placeholder: t("What will you do? Optional — one sentence is plenty."),
					"aria-label": t("Your role"),
				});
				this.#field = new SyncedField(field, (value) => void founding.setRole(value), this.#carriedRole);
				return field;
			});
			this.#field?.show(seat.role);
			this.#foot.show("mine", () => {
				// One button for the seat's one step: Connect ChatGPT, then Ready. It is never replaced,
				// so a click that lands while the table refreshes still counts.
				this.#ready = button("", () => {
					// Ready as shown when clicked: a double click asks for the same thing twice.
					if (!this.#seat?.modelLoginReady) founding.openConnect(true);
					else void founding.setReady(this.#revision, !this.#seat.ready);
				});
				return this.#ready;
			});
			const ready = this.#ready!;
			const label = !seat.modelLoginReady ? t("Connect ChatGPT") : seat.ready ? t("Ready ✓") : t("Ready");
			if (ready.textContent !== label) ready.textContent = label;
			ready.className = `btn ${seat.modelLoginReady ? (seat.ready ? "founding-ready-on" : "founding-ready") : "founding-connect-button"}`;
			ready.title = !seat.modelLoginReady
				? t("Connect your own ChatGPT account to be Ready")
				: seat.ready
					? t("Not ready after all")
					: t("I'm ready for the table as it is now");
			return;
		}
		this.#field = undefined;
		this.#ready = undefined;
		this.#role.show(`${seat.state}\n${seat.role}`, () =>
			h(
				"p",
				{ class: seat.role ? "founding-role" : "founding-role founding-role-empty" },
				seat.role || (seat.state === "invited" ? t("Not joined yet") : t("No role written")),
			),
		);
		const canRemove = table.me.canManage && seat.state === "joined" && !this.#mine;
		const canWithdraw =
			seat.state === "invited" && !this.#mine && (table.me.canManage || seat.invitedByUserId === founding.userId);
		this.#foot.show([seat.state, seat.ready, seat.modelLoginReady, canRemove, canWithdraw].join("\n"), () => {
			const parts: HTMLElement[] = [];
			if (seat.state === "joined")
				parts.push(
					h(
						"span",
						{ class: seat.ready ? "founding-status founding-status-ready" : "founding-status" },
						seat.ready ? t("Ready ✓") : seat.modelLoginReady ? t("Not ready yet") : t("ChatGPT not connected"),
					),
				);
			if (canRemove)
				parts.push(
					button(
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
					),
				);
			if (canWithdraw)
				parts.push(button(t("Withdraw"), () => void founding.removeSeat(seat.userId), { small: true }));
			return h("div", { class: "founding-foot-row" }, ...parts);
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
	readonly #visionSlot = new Slot();
	#name: SyncedField<HTMLInputElement> | undefined;
	#vision: SyncedField<HTMLTextAreaElement> | undefined;
	readonly #invitation = new Slot();
	readonly #seatList = h("div", { class: "founding-seats" });
	readonly #seats = new Map<string, SeatCard>();
	readonly #inviteTile: HTMLButtonElement;
	readonly #friends: HTMLElement;
	readonly #friendList = new Slot();
	readonly #friendNote = new Slot();
	readonly #friendEmail: HTMLInputElement;
	readonly #friendAdd: HTMLButtonElement;
	readonly #connect: HTMLElement;
	readonly #connectBody = h("div");
	readonly #connectText = h("p", { class: "muted small" });
	readonly #error = new Slot();
	readonly #start: HTMLButtonElement;
	readonly #waiting = h("p", { class: "founding-hint" });
	readonly #owners = h("p", { class: "founding-hint" });
	readonly #withdrawn = h("p", { class: "founding-hint" });
	readonly #bar: HTMLElement;
	readonly #exit = new Slot();
	readonly #startedSlot = new Slot();
	readonly #opened = { friends: false, connect: false };

	/** Unsaved text brought over from the page this one replaces (a language change). */
	readonly #carried: FoundingDrafts;

	constructor(founding: FoundingController, carried: FoundingDrafts = {}) {
		this.#founding = founding;
		this.#carried = carried;
		this.el.append(this.#page.el);
		this.#inviteTile = h(
			"button",
			{
				type: "button",
				class: "founding-seat founding-seat-invite",
				onclick: () => founding.openFriends(!founding.store.get().friendsOpen),
			},
			h("span", { class: "founding-plus", "aria-hidden": "true" }, "+"),
			h("strong", null, t("Invite Co-founder")),
		);
		this.#friendEmail = h("input", {
			id: "foundingFriendEmail",
			type: "email",
			autocomplete: "email",
			placeholder: t("Their email address"),
		});
		this.#friendAdd = h("button", { type: "submit", class: "btn" }, t("Add friend"));
		this.#friends = h(
			"section",
			{ class: "founding-sheet", "aria-label": t("Invite a co-founder"), hidden: true },
			h(
				"div",
				{ class: "founding-sheet-head" },
				h("h2", null, t("Invite a co-founder")),
				h(
					"button",
					{
						type: "button",
						class: "founding-close",
						"aria-label": t("Close"),
						onclick: () => founding.openFriends(false),
					},
					"×",
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
					"×",
				),
			),
			this.#connectText,
			this.#connectBody,
		);
		this.#start = h("button", {
			type: "button",
			class: "btn btn-primary founding-start",
			onclick: () => void founding.start(),
		});
		this.#bar = h("div", { class: "founding-bar" }, this.#start, this.#waiting, this.#owners, this.#withdrawn);
	}

	/** Text typed here and not saved yet, to carry over when the page is built again. */
	drafts(): FoundingDrafts {
		const role = [...this.#seats.values()].map((card) => card.draft).find((draft) => draft !== undefined);
		return {
			...(this.#name?.draft !== undefined ? { name: this.#name.draft } : {}),
			...(this.#vision?.draft !== undefined ? { vision: this.#vision.draft } : {}),
			...(role !== undefined ? { role } : {}),
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
			h("header", { class: "founding-head" }, this.#nameSlot.el, this.#visionSlot.el),
			this.#invitation.el,
			this.#seatList,
			this.#friends,
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

		this.#nameSlot.show(joined ? "field" : `title\n${table.companyName}`, () => {
			if (!joined) {
				this.#name = undefined;
				return h("h1", { class: "founding-name" }, table.companyName);
			}
			const field = h("input", {
				class: "founding-name",
				type: "text",
				maxlength: FOUNDING_NAME_MAX_CHARACTERS,
				required: true,
				"aria-label": t("Company name"),
				autocomplete: "organization",
			});
			this.#name = new SyncedField(
				field,
				(value, synced) => {
					if (value.trim()) void founding.rename(value);
					else synced.reset();
				},
				this.#carried.name,
			);
			return field;
		});
		this.#name?.show(table.companyName);
		this.#visionSlot.show(joined ? "field" : `text\n${table.vision}`, () => {
			if (!joined) {
				this.#vision = undefined;
				return table.vision ? h("p", { class: "founding-vision" }, table.vision) : null;
			}
			const field = h("textarea", {
				class: "founding-vision",
				rows: 2,
				maxlength: VISION_MAX_UNITS,
				placeholder: t("What is the company for? One line is enough to start."),
				"aria-label": t("What the company is for"),
			});
			this.#vision = new SyncedField(field, (value) => void founding.describe(value), this.#carried.vision);
			return field;
		});
		this.#vision?.show(table.vision);

		const invitedBy = table.seats.find((seat) => seat.userId === me)?.invitedByUserId;
		const inviter = table.seats.find((seat) => seat.userId === invitedBy)?.displayName;
		this.#invitation.show(`${table.me.state}\n${inviter}\n${table.companyName}`, () =>
			table.me.state === "invited"
				? h(
						"div",
						{ class: "founding-invitation" },
						h(
							"p",
							null,
							inviter
								? t("{name} invited you to start {company} together.", {
										name: inviter,
										company: table.companyName,
									})
								: t("You are invited to start {company} together.", { company: table.companyName }),
						),
						h(
							"div",
							{ class: "row" },
							button(t("Decline"), () => void founding.respond(false)),
							button(t("Join the table"), () => void founding.respond(true), { primary: true }),
						),
					)
				: null,
		);

		// Seats in the server's order. A card is kept per person and moved only when the order changes.
		const cards = table.seats.map((seat) => {
			let card = this.#seats.get(seat.userId);
			if (!card) {
				card = new SeatCard(founding, seat, seat.userId === me ? this.#carried.role : undefined);
				this.#seats.set(seat.userId, card);
			}
			card.update(table, seat);
			return card.el;
		});
		for (const userId of [...this.#seats.keys()])
			if (!table.seats.some((seat) => seat.userId === userId)) this.#seats.delete(userId);
		// Only the cards that change place move, so your own card (and the role you are typing in it)
		// stays put when someone joins, leaves or is invited.
		const wanted: Element[] =
			joined && table.seats.length < FOUNDING_MAX_SEATS ? [...cards, this.#inviteTile] : cards;
		for (const child of [...this.#seatList.children]) if (!wanted.includes(child)) child.remove();
		wanted.forEach((node, index) => {
			const at = this.#seatList.children[index];
			if (at !== node) this.#seatList.insertBefore(node, at ?? null);
		});
		this.#inviteTile.setAttribute("aria-expanded", String(state.friendsOpen === true));

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
		const startLabel = state.busy === "start" ? t("Starting…") : t("Start {name}", { name: table.companyName });
		if (this.#start.textContent !== startLabel) this.#start.textContent = startLabel;
		this.#start.disabled = !table.me.canStart || state.busy === "start";
		this.#waiting.textContent =
			table.waitingFor.length > 0
				? t("Waiting for {names} to be ready", { names: names(table, table.waitingFor, me) })
				: t("Everyone is ready.");
		this.#owners.textContent = t("Everyone at the table becomes a founder of {name}.", { name: table.companyName });
		this.#withdrawn.textContent = t("Invitations nobody has answered are withdrawn at Start.");
		this.#withdrawn.hidden = !table.seats.some((seat) => seat.state === "invited");

		const alone = table.seats.filter((seat) => seat.state === "joined").length === 1;
		this.#exit.show(`${joined}\n${table.me.canManage}\n${alone}\n${table.companyName}`, () => {
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
				alone
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
		if (open && !this.#opened.friends) this.#friends.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
		this.#opened.friends = open;
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
						{ class: "founding-vision" },
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
								{ class: "founding-seat-top" },
								personAvatar(seat.displayName, seat.userId),
								h("div", { class: "founding-who" }, h("strong", null, seat.displayName)),
								h("span", { class: "founding-kind founding-kind-owner" }, t("Founder")),
							),
							seat.role ? h("p", { class: "founding-role" }, seat.role) : null,
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
