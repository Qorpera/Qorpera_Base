import type { HostedStaffAgent } from "../../cloud/types.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { h, icon, replace } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import { AppActionRefused, type AppAsk, type AppGate, type AppGateOutcome, type PreparedAsk } from "../app-actions.ts";

/* The bar an interface app's request is put to the member on (deploy/first-node/RUNTIME-INTERFACE-APPS.md §5 "Writes";
 * security review r1, H3 and L3). An app's page can only ask (app/app-actions.ts); this bar is the member's yes, and
 * the only way a request becomes a change. Qorpera draws it outside the app's frame, above the page, which it pushes
 * down, so nothing of the page is ever under its buttons and the page can neither draw it nor press it: the frame has
 * no origin and reaches nothing of this document.
 * - It shows what will be saved in Qorpera's own words: the question and the answer chosen, as the agent's card says
 *   them, or the table, the row and each cell as it is and as it will be. Its sentences hold no text of the app's.
 * - A note to the app's owner (`tell`) is the member's own words, written in a field of the bar's, which starts with
 *   the page's draft: what goes is what the field holds when the member sends it, and Send is off while it is empty.
 *   What the page says the note is about is a value on the bar, never part of its sentences.
 * - Every request is its own bar. Nothing is remembered: there is no "always allow".
 * - A page can time a request to land under a click meant for the page, so the yes button wakes a second after the bar
 *   is on screen, takes only a press that began after it woke, and is never where the focus lands: Not now is, or for
 *   a note the field, which sends nothing (Enter in it is a new line), and where a key held down since before the bar
 *   came in types nothing. Enter in the page stays in the page. Escape on the bar is Not now.
 * - One bar at a time: while one is open another request is refused at once. After three Not now in a row the app asks
 *   no more until the member reloads it.
 * - However much a request holds, the bar stays within the screen: its lines scroll inside it and both buttons stay
 *   within reach.
 * - The member sees how it went: saved, sent, waiting in the agent's thread (with the way there), or why not. A note
 *   that thread cannot take now (its draft answers something else already, app/tell-agent.ts) stays on the bar with its
 *   words, and a line says why, with the way there. */

export interface AppAskBarHost {
	/** The app's emblem, drawn afresh. */
	readonly emblem: () => Node;
	readonly agent: (agentId: string) => HostedStaffAgent | undefined;
	/** A request is on screen, or no longer. While one is, the panel does not pass the page's Escape on (L3). */
	readonly open: (open: boolean) => void;
}

/** The yes button wakes this long after the bar is on screen. */
export const ASK_ALLOW_AFTER_MS = 1_000;
/** Not now this many times in a row, and the app asks no more until it is reloaded. */
export const ASK_DECLINES_BEFORE_QUIET = 3;
const SAVED_MS = 1_800;
const FAILED_MS = 8_000;
const QUIET_MS = 6_000;

let bars = 0;

/** A value as the bar shows it: a line break is a mark, so no value draws lines of its own under the bar's. */
const oneLine = (value: string) => value.replace(/\s*[\r\n]+\s*/g, " ↵ ").replace(/\t/g, " ");

/** The request on the bar: `working` once the member allowed it and its change is on its way. */
interface Pending {
	readonly settle: (outcome: AppGateOutcome) => void;
	working: boolean;
}

export class AppAskBar implements AppGate {
	readonly el: HTMLElement;
	readonly #host: AppAskBarHost;
	readonly #titleId = `app-ask-${++bars}`;
	/** The request on the bar, until the member chose and it was settled. */
	#pending: Pending | undefined;
	#declines = 0;
	/** What puts a settled bar away, or wakes the yes button. */
	#timer: ReturnType<typeof setTimeout> | undefined;
	#stopWaking: (() => void) | undefined;
	#disposed = false;

	constructor(host: AppAskBarHost) {
		this.#host = host;
		this.el = h("section", { class: "app-ask", role: "group", "aria-labelledby": this.#titleId, hidden: true });
	}

	closed(): "busy" | "quiet" | null {
		return this.#pending ? "busy" : this.#declines >= ASK_DECLINES_BEFORE_QUIET ? "quiet" : null;
	}

	ask(ask: AppAsk, perform: PreparedAsk["perform"], keep?: PreparedAsk["keep"]): Promise<AppGateOutcome> {
		const closed = this.#disposed ? "gone" : this.closed();
		if (closed) return Promise.resolve({ outcome: closed });
		return new Promise((resolve) => {
			const pending: Pending = {
				settle: (outcome) => {
					if (this.#pending === pending) this.#pending = undefined;
					resolve(outcome);
				},
				working: false,
			};
			this.#pending = pending;
			this.#show(ask, perform, pending, keep);
		});
	}

	/** The page a request came from is gone (reloaded, changed or left): one still waiting for the member is put away,
	 * unsaved. One the member already allowed is on its way, and the bar still says how it went. */
	cancel(): void {
		const pending = this.#pending;
		if (!pending || pending.working) return;
		pending.settle({ outcome: "gone" });
		this.#hide();
	}

	/** The member reloaded the app: it may ask again, and what the bar still said of an earlier request goes. */
	reset(): void {
		this.cancel();
		this.#declines = 0;
		if (!this.#pending && !this.el.hidden) this.#hide();
	}

	dispose(): void {
		this.#disposed = true;
		this.#pending?.settle({ outcome: "gone" });
		this.#clear();
		this.el.remove();
	}

	#clear(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#stopWaking?.();
		this.#stopWaking = undefined;
	}

	#hide(): void {
		this.#clear();
		const within = this.el.contains(document.activeElement);
		this.el.hidden = true;
		replace(this.el);
		this.#host.open(false);
		// The keyboard goes back to the page it was taken from.
		if (within) this.el.parentElement?.querySelector<HTMLElement>("iframe")?.focus({ preventScroll: true });
	}

	/** The lines under the title; for a note, with the field the member writes it in. */
	#lines(ask: AppAsk, field: HTMLTextAreaElement | undefined): HTMLElement {
		const line = (label: Node | string, ...value: (Node | string)[]) => [
			h("dt", null, label),
			h("dd", null, ...value),
		];
		const cell = (value: string | null) =>
			value === null
				? h("span", { class: "app-ask-empty" }, t("empty"))
				: h("span", { class: "app-ask-value" }, oneLine(value));
		if (ask.kind === "answer")
			return h(
				"dl",
				{ class: "app-ask-lines" },
				...line(t("Question"), oneLine(ask.question)),
				...line(t("Your answer"), oneLine(ask.answers.join(", "))),
			);
		if (ask.kind === "tell")
			return h(
				"dl",
				{ class: "app-ask-lines" },
				// The app's name and the page's words for the thing, each a value of its own.
				...line(
					t("About"),
					h("span", { class: "app-ask-value" }, oneLine(ask.app)),
					h("span", { class: "app-ask-dot", "aria-hidden": "true" }, " · "),
					h("span", { class: "app-ask-value" }, ask.about),
				),
				...line(h("label", { for: field?.id }, t("Your note")), field ?? ""),
			);
		return h(
			"dl",
			{ class: "app-ask-lines" },
			...line(t("Table"), oneLine(ask.table)),
			...(ask.row === null ? [] : line(t("Row"), oneLine(ask.row))),
			...ask.changes.flatMap((change) =>
				line(
					change.column,
					...(ask.add
						? [cell(change.after)]
						: [
								h("span", { class: "app-ask-was" }, cell(change.before)),
								h("span", { class: "app-ask-arrow", "aria-label": t("becomes") }, "→"),
								cell(change.after),
							]),
				),
			),
		);
	}

	/** The field a note is written in, with the page's draft. It sends nothing: Enter is a new line in it, and a key held
	 * down since before the bar came in types nothing (a key pressed here may repeat). */
	#field(ask: Extract<AppAsk, { kind: "tell" }>): HTMLTextAreaElement {
		const field = h("textarea", {
			class: "app-ask-field",
			id: `${this.#titleId}-note`,
			rows: "2",
			placeholder: t("Write your note"),
			value: ask.draft,
		});
		const pressed = new Set<string>();
		field.addEventListener("keydown", (event) => {
			if (!event.repeat) pressed.add(event.code);
			else if (!pressed.has(event.code)) event.preventDefault();
		});
		field.addEventListener("keyup", (event) => pressed.delete(event.code));
		// It grows with what is written, up to its own height (styles/conversation.css), and then scrolls.
		const fit = () => {
			field.style.height = "auto";
			field.style.height = `${field.scrollHeight + field.offsetHeight - field.clientHeight}px`;
		};
		field.addEventListener("input", fit);
		queueMicrotask(fit);
		return field;
	}

	#show(ask: AppAsk, perform: PreparedAsk["perform"], pending: Pending, keep?: PreparedAsk["keep"]): void {
		this.#clear();
		const agent = ask.kind === "row" ? undefined : this.#host.agent(ask.agentId);
		const name = agent?.displayName ?? t("The agent");
		const title = h(
			"strong",
			{ class: "app-ask-title", id: this.#titleId },
			ask.kind === "answer"
				? t("This app wants to send your answer to {name}", { name })
				: ask.kind === "tell"
					? t("This app wants to send your note to {name}", { name })
					: ask.add
						? t("This app wants to add a row to a company table")
						: t("This app wants to change a row in a company table"),
		);
		const field = ask.kind === "tell" ? this.#field(ask) : undefined;
		const later = h("button", { type: "button", class: "app-ask-button" }, t("Not now"));
		const yes = h(
			"button",
			{ type: "button", class: "app-ask-button is-yes", disabled: true },
			ask.kind === "answer"
				? t("Send answer")
				: ask.kind === "tell"
					? t("Send note")
					: ask.add
						? t("Add row")
						: t("Change row"),
		);
		// The yes button wakes a second after the bar is on a screen the member can see, and takes only a press that
		// began after that: a click or a key already on its way when the bar came in does nothing. A note's Send is
		// awake only while its field holds words, and a press counts only from when it last woke.
		let woke = false;
		let awake = Number.POSITIVE_INFINITY;
		let pressed = -1;
		const ready = () => {
			const can = woke && !pending.working && (!field || field.value.trim() !== "");
			if (can === !yes.disabled) return;
			yes.disabled = !can;
			yes.classList.toggle("is-awake", can);
			if (can) awake = Date.now();
		};
		const wake = () => {
			clearTimeout(this.#timer);
			if (document.visibilityState === "hidden") return;
			this.#timer = setTimeout(() => {
				woke = true;
				ready();
			}, ASK_ALLOW_AFTER_MS);
		};
		document.addEventListener("visibilitychange", wake);
		this.#stopWaking = () => document.removeEventListener("visibilitychange", wake);
		field?.addEventListener("input", ready);
		// A note its thread could not take is kept for the app with the member's words as they write them, so going to
		// the thread to look (the held line's Open) loses nothing: the app's bar shows it again on the way back.
		let holding = ask.kind === "tell" && ask.held === true;
		field?.addEventListener("input", () => {
			if (holding) keep?.(field.value);
		});
		yes.addEventListener("pointerdown", (event) => {
			if ((event as PointerEvent).button === 0) pressed = Date.now();
		});
		yes.addEventListener("keydown", (event) => {
			if ((event.key === "Enter" || event.key === " ") && !event.repeat) pressed = Date.now();
		});
		// A key held down since before the bar came in does not answer it.
		later.addEventListener("keydown", (event) => {
			if (event.repeat) event.preventDefault();
		});
		const decline = () => {
			if (this.#pending !== pending || pending.working) return;
			if (holding) keep?.(undefined);
			this.#declines++;
			pending.settle({ outcome: "declined" });
			if (this.#declines < ASK_DECLINES_BEFORE_QUIET) return this.#hide();
			this.#settled(
				h(
					"p",
					{ class: "app-ask-note", role: "status" },
					t("This app asked three times. It can ask again after you reload it."),
				),
				QUIET_MS,
			);
		};
		later.addEventListener("click", decline);
		yes.addEventListener("click", () => {
			if (this.#pending !== pending || pending.working || yes.disabled || pressed < awake) return;
			const words = field?.value ?? "";
			pending.working = true;
			this.#clear();
			yes.disabled = true;
			later.disabled = true;
			if (field) field.readOnly = true;
			yes.textContent = ask.kind === "row" ? t("Saving…") : t("Sending…");
			void perform(words).then(
				(note) => {
					this.#declines = 0;
					if (ask.kind === "tell" && note?.held) {
						holding = true;
						// Not added to the thread, whose draft answers something else already: the note stays here with its words,
						// and Send tries again once that is sent or cleared there.
						pending.working = false;
						later.disabled = false;
						if (field) field.readOnly = false;
						yes.textContent = t("Send note");
						replace(
							held,
							t("{name}'s thread has a message started. Send or clear it there, then send this note.", { name }),
							" ",
							h("a", { class: "app-ask-link", href: note.href }, t("Open")),
						);
						held.hidden = false;
						ready();
						field?.focus({ preventScroll: true });
						return;
					}
					if (ask.kind === "tell" && note && !note.sent) {
						// It waits in the agent's thread, for the member to send from there: the bar stays until they go there
						// or close it.
						pending.settle({ outcome: "told", sent: false });
						this.#settled(
							h(
								"p",
								{ class: "app-ask-note is-waiting", role: "status" },
								icon("clock"),
								t("Your note waits in {name}'s thread", { name }),
							),
							null,
							h("a", { class: "app-ask-button is-go", href: note.href, onclick: () => this.#hide() }, t("Open")),
						);
						return;
					}
					pending.settle(ask.kind === "tell" ? { outcome: "told", sent: true } : { outcome: "saved" });
					this.#settled(
						h(
							"p",
							{ class: "app-ask-note is-saved", role: "status" },
							icon("check"),
							ask.kind === "row" ? t("Saved") : t("Sent to {name}", { name }),
						),
						SAVED_MS,
					);
				},
				(error: unknown) => {
					const message =
						error instanceof AppActionRefused ? error.message : t("That could not be saved. Try again.");
					pending.settle({ outcome: "failed", message });
					this.#settled(h("p", { class: "app-ask-note is-failed", role: "alert" }, message), FAILED_MS);
				},
			);
		});
		const lines = this.#lines(ask, field);
		const held = h("p", { class: "app-ask-held", role: "status", hidden: true });
		replace(
			this.el,
			h(
				"span",
				{ class: "app-ask-figure", "aria-hidden": "true" },
				ask.kind === "answer"
					? agentFigure(agent, name, { size: 30, activity: "Waiting", ask: "question" })
					: ask.kind === "tell"
						? agentFigure(agent, name, { size: 30 })
						: this.#host.emblem(),
			),
			h("div", { class: "app-ask-copy" }, title, lines, held),
			h("div", { class: "app-ask-buttons" }, later, yes),
		);
		// Escape on the bar is Not now, as anywhere it closes what asks (once: a held Escape says it once).
		this.el.onkeydown = (event) => {
			if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
			event.preventDefault();
			event.stopPropagation();
			if (!event.repeat) decline();
		};
		this.el.hidden = false;
		this.el.classList.remove("is-settled");
		this.el.classList.toggle("is-note", ask.kind === "tell");
		// Lines longer than the bar may be scroll inside it (styles/conversation.css): the keyboard reaches them too.
		if (lines.scrollHeight > lines.clientHeight) lines.tabIndex = 0;
		this.#host.open(true);
		// Out of the page and onto the safe answer, so Enter never allows: Not now, or a note's own field, at its end.
		if (field) {
			field.focus({ preventScroll: true });
			field.setSelectionRange(field.value.length, field.value.length);
		} else later.focus({ preventScroll: true });
		wake();
	}

	/** The bar once its request is settled: how it went, with a way to put it away, until it goes by itself (`ms`; null:
	 * it stays until the member closes it). A new request may take its place at once. */
	#settled(note: HTMLElement, ms: number | null, ...ways: HTMLElement[]): void {
		if (this.#disposed) return;
		this.#clear();
		this.el.onkeydown = null;
		const close = h(
			"button",
			{ type: "button", class: "app-ask-button", onclick: () => this.#pending === undefined && this.#hide() },
			t("Close"),
		);
		const within = this.el.contains(document.activeElement);
		replace(this.el, note, h("div", { class: "app-ask-buttons" }, close, ...ways));
		this.el.classList.add("is-settled");
		this.el.classList.remove("is-note");
		this.#host.open(false);
		if (within) (ways[0] ?? close).focus({ preventScroll: true });
		if (ms !== null)
			this.#timer = setTimeout(() => {
				if (this.#pending === undefined) this.#hide();
			}, ms);
	}
}
