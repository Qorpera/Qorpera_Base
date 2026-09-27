import type { RoomDraft } from "../../cloud/room-drafts.ts";
import { h, icon, personAvatar, replace } from "../../ui/dom.ts";
import { matchesKey } from "../../ui/keys.ts";
import { presentationLocale, t } from "../../ui/preferences.ts";
import type { CompanyController } from "../company.ts";
import { DRAFT_TYPING_MS, type DraftStatus, type DraftSync, type RoomDraftRoom } from "../room-drafts.ts";
import { moveIndex, type TextEdit } from "../text-merge.ts";

/* Other members' unsent messages, right above the composer. Each shows as a
 * notch with the member's picture, typing while they type; pointing at it opens
 * the notch up to show the message as it is written, and clicking it lets this
 * member write in it.
 * Only its owner can send it. The member's own composer says who is writing in
 * it with them. */

/** Put `text` in a field, keeping the member's caret and selection where they were. */
function showKeepingCaret(field: HTMLTextAreaElement, text: string, edit: TextEdit): void {
	if (field.value === text) return;
	const focused = document.activeElement === field;
	const { selectionStart, selectionEnd, selectionDirection, scrollTop } = field;
	field.value = text;
	if (focused) {
		const start = Math.min(text.length, moveIndex(selectionStart, edit));
		const end = Math.min(text.length, moveIndex(selectionEnd, edit));
		field.setSelectionRange(start, end, selectionDirection ?? undefined);
	}
	field.scrollTop = scrollTop;
}

function names(values: readonly string[]): string {
	return new Intl.ListFormat(presentationLocale(), { style: "long", type: "conjunction" }).format(values);
}

interface Notch {
	el: HTMLButtonElement;
	peek: HTMLElement;
	text: HTMLElement;
	name: HTMLElement;
}

interface OpenDraft {
	ownerUserId: string;
	sync: DraftSync;
	el: HTMLElement;
	input: HTMLTextAreaElement;
}

export class SharedDrafts {
	readonly el = h("div", { class: "composer-drafts", hidden: true });
	readonly #row = h("div", { class: "draft-notches" });
	readonly #helpers = h("div", { class: "draft-helpers", role: "status", hidden: true });
	readonly #company: CompanyController;
	readonly #sessionId: string;
	readonly #composer: HTMLTextAreaElement;
	/** The composer's height or the space above it changed. */
	readonly #resized: () => void;
	readonly #notches = new Map<string, Notch>();
	#room: RoomDraftRoom | undefined;
	#release: (() => void) | undefined;
	#unsubscribe: (() => void) | undefined;
	#open: OpenDraft | undefined;
	#composing = false;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#helpersKey = "";
	#disposed = false;
	readonly #stopShown: () => void;

	constructor(company: CompanyController, sessionId: string, composer: HTMLTextAreaElement, resized: () => void) {
		this.#company = company;
		this.#sessionId = sessionId;
		this.#composer = composer;
		this.#resized = resized;
		this.el.append(this.#row, this.#helpers);
		composer.addEventListener("compositionstart", () => {
			this.#composing = true;
		});
		composer.addEventListener("compositionend", () => {
			this.#composing = false;
			// A browser may end the letter without another input event: take the text as it stands.
			company.conversation(sessionId).set({ draft: composer.value });
			this.input();
		});
		// Another member's words arrive in the member's own draft without moving their caret.
		this.#stopShown = company.roomDrafts.onShown(sessionId, (text, edit) => {
			showKeepingCaret(composer, text, edit);
			this.#resized();
		});
	}

	/** The member typed in their own composer. */
	input(): void {
		this.#company.roomDrafts.input(this.#sessionId);
	}

	/** The conversation changed: follow its room while its drafts are shared. */
	update(): void {
		if (this.#disposed) return;
		const room = this.#company.roomDrafts.room(this.#sessionId);
		if (room !== this.#room) {
			this.#unsubscribe?.();
			this.#release?.();
			this.#unsubscribe = undefined;
			this.#release = undefined;
			this.#room = room;
			if (room) {
				this.#release = this.#company.roomDrafts.watch(this.#sessionId, {
					caret: () => (document.activeElement === this.#composer ? this.#composer.selectionEnd : undefined),
					busy: () => this.#composing,
				});
				this.#unsubscribe = room.store.subscribe(() => this.#render());
			} else this.#close(false);
		}
		this.#render();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		clearTimeout(this.#timer);
		this.#stopShown();
		this.#unsubscribe?.();
		this.#release?.();
		this.#close(false);
	}

	#render(): void {
		if (this.#disposed) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		const room = this.#room;
		const state = room?.store.get();
		const me = this.#company.userId;
		const now = Date.now();
		let nextChange = Number.POSITIVE_INFINITY;
		const typing = (ownerUserId: string) => {
			const activity = state?.activity[ownerUserId];
			if (!activity || now - activity.at >= DRAFT_TYPING_MS) return undefined;
			nextChange = Math.min(nextChange, activity.at + DRAFT_TYPING_MS);
			return activity;
		};
		const drafts = state?.unavailable ? [] : (state?.drafts ?? []);
		// The open draft closes once it is sent or emptied and nothing typed here is still on its way.
		const open = this.#open;
		if (open) {
			const draft = drafts.find((item) => item.ownerUserId === open.ownerUserId);
			if (!room || ((!draft || !draft.body) && open.sync.settled && !open.input.value)) this.#close(false);
		}
		const others = drafts
			.filter(
				(draft) => draft.ownerUserId !== me && draft.body.trim() && draft.ownerUserId !== this.#open?.ownerUserId,
			)
			.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
		for (const [owner, notch] of this.#notches)
			if (!others.some((draft) => draft.ownerUserId === owner)) {
				notch.el.remove();
				this.#notches.delete(owner);
			}
		for (const draft of others) this.#renderNotch(draft, typing(draft.ownerUserId) !== undefined);
		// Keep the row in the drafts' order without moving a notch that is already in place.
		let cursor = this.#row.firstChild;
		for (const draft of others) {
			const notch = this.#notches.get(draft.ownerUserId)!.el;
			if (notch !== cursor) this.#row.insertBefore(notch, cursor);
			cursor = notch.nextSibling;
		}
		this.#renderHelpers(
			drafts.find((draft) => draft.ownerUserId === me),
			typing(me),
		);
		const hidden = !others.length && this.#helpers.hidden && !this.#open;
		if (this.el.hidden !== hidden) {
			this.el.hidden = hidden;
			this.#resized();
		}
		if (Number.isFinite(nextChange)) this.#timer = setTimeout(() => this.#render(), Math.max(50, nextChange - now));
	}

	#renderNotch(draft: RoomDraft, typing: boolean): void {
		const name = this.#company.memberName(draft.ownerUserId);
		let notch = this.#notches.get(draft.ownerUserId);
		if (!notch) {
			const nameEl = h("span");
			const text = h("span", { class: "draft-peek-text" });
			// The notch opened up: it lies over the notch, picture on the picture, and grows from there.
			const peek = h(
				"span",
				{ class: "draft-peek", "aria-hidden": "true" },
				personAvatar(name, draft.ownerUserId),
				h(
					"span",
					{ class: "draft-peek-body" },
					h(
						"span",
						{ class: "draft-peek-name" },
						nameEl,
						h("span", { class: "draft-dots" }, h("i"), h("i"), h("i")),
					),
					text,
				),
			);
			const el = h(
				"button",
				{
					type: "button",
					class: "draft-notch",
					dataset: { owner: draft.ownerUserId },
					onclick: () => this.#openDraft(draft.ownerUserId),
				},
				personAvatar(name, draft.ownerUserId),
				h("span", { class: "draft-dots", "aria-hidden": "true" }, h("i"), h("i"), h("i")),
				peek,
			);
			// The opened notch never runs past the end of the row (or the window).
			const room = () =>
				el.style.setProperty(
					"--draft-peek-room",
					`${Math.max(0, Math.floor(this.#row.getBoundingClientRect().right - el.getBoundingClientRect().left))}px`,
				);
			// Measured whenever the pointer or focus arrives, so a notch that appeared under a
			// resting pointer, or moved since, never opens past the row.
			el.addEventListener("pointerenter", room);
			el.addEventListener("mouseover", room);
			el.addEventListener("focus", room);
			notch = { el, peek, text, name: nameEl };
			this.#notches.set(draft.ownerUserId, notch);
		}
		notch.el.classList.toggle("is-typing", typing);
		const label = typing
			? t("{name} is writing a message. Open it to write with them", { name })
			: t("{name} has an unsent message. Open it to write with them", { name });
		if (notch.el.getAttribute("aria-label") !== label) notch.el.setAttribute("aria-label", label);
		const heading = typing ? t("{name} is writing", { name }) : t("{name}'s message", { name });
		if (notch.name.textContent !== heading) notch.name.textContent = heading;
		if (notch.text.textContent !== draft.body) notch.text.textContent = draft.body;
	}

	/** The member's own draft: who else is writing in it. */
	#renderHelpers(own: RoomDraft | undefined, activity: { editorUserId: string } | undefined): void {
		const me = this.#company.userId;
		const helpers = own?.body && this.#composer.value ? own.contributors.filter((id) => id !== me) : [];
		const active = activity && activity.editorUserId !== me ? activity.editorUserId : undefined;
		const shown = active && !helpers.includes(active) ? [active, ...helpers] : helpers;
		const key = JSON.stringify([shown, active, shown.map((id) => this.#company.memberName(id))]);
		if (key === this.#helpersKey) return;
		this.#helpersKey = key;
		this.#helpers.hidden = !shown.length;
		this.#helpers.classList.toggle("is-typing", Boolean(active));
		const list = names(shown.map((id) => this.#company.memberName(id)));
		replace(
			this.#helpers,
			...shown.slice(0, 3).map((id) => personAvatar(this.#company.memberName(id), id)),
			h(
				"span",
				null,
				active
					? t("{name} is writing with you", { name: this.#company.memberName(active) })
					: t("Written with {names}", { names: list }),
			),
		);
	}

	#openDraft(ownerUserId: string): void {
		if (this.#open?.ownerUserId === ownerUserId) {
			this.#close(true);
			return;
		}
		this.#close(false);
		const draft = this.#room?.draft(ownerUserId);
		if (!draft) return;
		const name = this.#company.memberName(ownerUserId);
		const input = h("textarea", {
			class: "draft-panel-input",
			rows: 1,
			"aria-label": t("{name}'s message", { name }),
		});
		const status = h("p", { class: "draft-panel-status", role: "status", hidden: true });
		const showStatus = (now: DraftStatus) => {
			status.hidden = now === "saved";
			status.textContent =
				now === "retrying"
					? t("Not saved yet. Trying again…")
					: now === "too-long"
						? t("Too long to share. Shorten it to share your changes.")
						: "";
		};
		const state: { composing: boolean } = { composing: false };
		const opened = this.#company.roomDrafts.edit(this.#sessionId, ownerUserId, {
			text: () => input.value,
			caret: () => (document.activeElement === input ? input.selectionEnd : undefined),
			busy: () => state.composing,
			show: (text, edit) => {
				showKeepingCaret(input, text, edit);
				this.#autosize(input);
			},
			gone: () => {
				if (this.#open?.input === input) this.#close(false);
			},
			status: (now) => showStatus(now),
		});
		if (!opened) return;
		const { sync } = opened;
		input.value = opened.text;
		showStatus(sync.status);
		input.addEventListener("input", () => {
			sync.changed();
			this.#autosize(input);
		});
		input.addEventListener("compositionstart", () => {
			state.composing = true;
		});
		input.addEventListener("compositionend", () => {
			state.composing = false;
			sync.changed();
		});
		input.addEventListener("keydown", (event) => {
			if (matchesKey(event, "dismiss")) {
				event.preventDefault();
				event.stopPropagation();
				this.#close(true);
			}
		});
		const el = h(
			"section",
			{ class: "draft-panel", role: "group", "aria-label": t("{name}'s message", { name }) },
			h(
				"header",
				{ class: "draft-panel-head" },
				personAvatar(name, ownerUserId),
				h(
					"span",
					{ class: "draft-panel-label" },
					h("span", { class: "draft-panel-title" }, t("{name}'s message", { name })),
					" ",
					h("span", { class: "draft-panel-note" }, t("Only {name} can send it", { name })),
				),
				h(
					"button",
					{
						type: "button",
						class: "icon-button draft-panel-close",
						title: t("Close"),
						"aria-label": t("Close"),
						onclick: () => this.#close(true),
					},
					icon("close"),
				),
			),
			input,
			status,
		);
		this.#open = { ownerUserId, sync, el, input };
		this.el.append(el);
		this.#render();
		this.#autosize(input);
		input.focus();
		input.setSelectionRange(input.value.length, input.value.length);
		this.#resized();
	}

	/** Stop writing in another member's draft; what was typed still reaches it. */
	#close(refocus: boolean): void {
		const open = this.#open;
		if (!open) return;
		this.#open = undefined;
		const focused = open.el.contains(document.activeElement);
		open.el.remove();
		void this.#company.roomDrafts.leave(open.sync);
		if (this.#disposed) return;
		this.#render();
		this.#resized();
		if (refocus || focused) {
			const notch = this.#notches.get(open.ownerUserId)?.el;
			(notch ?? this.#composer).focus({ preventScroll: true });
		}
	}

	#autosize(input: HTMLTextAreaElement): void {
		input.style.height = "auto";
		const tallest = Number.parseFloat(getComputedStyle(input).maxHeight) || Number.POSITIVE_INFINITY;
		input.style.height = `${Math.min(input.scrollHeight, tallest)}px`;
		input.style.overflowY = input.scrollHeight > tallest ? "auto" : "hidden";
		this.#resized();
	}
}
