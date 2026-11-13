import type { HostedStaffAgent } from "../../cloud/types.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { h, icon, replace } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import { AppActionRefused, type AppAsk, type AppGate, type AppGateOutcome } from "../app-actions.ts";

/* The bar an interface app's request is put to the member on (deploy/first-node/RUNTIME-INTERFACE-APPS.md §5 "Writes";
 * security review r1, H3 and L3). An app's page can only ask (app/app-actions.ts); this bar is the member's yes, and
 * the only way a request becomes a change. Qorpera draws it outside the app's frame, above the page, which it pushes
 * down, so nothing of the page is ever under its buttons and the page can neither draw it nor press it: the frame has
 * no origin and reaches nothing of this document.
 * - It shows what will be saved in Qorpera's own words: the question and the answer chosen, as the agent's card says
 *   them, or the table, the row and each cell as it is and as it will be. Its sentences hold no text of the app's.
 * - Every request is its own bar. Nothing is remembered: there is no "always allow".
 * - A page can time a request to land under a click meant for the page, so the yes button wakes a second after the bar
 *   is on screen, takes only a press that began after it woke, and is never where the focus lands: Not now is. Enter
 *   in the page stays in the page.
 * - One bar at a time: while one is open another request is refused at once. After three Not now in a row the app asks
 *   no more until the member reloads it.
 * - However much a request holds, the bar stays within the screen: its lines scroll inside it and both buttons stay
 *   within reach.
 * - The member sees how it went: saved, or why not. */

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

	ask(ask: AppAsk, perform: () => Promise<void>): Promise<AppGateOutcome> {
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
			this.#show(ask, perform, pending);
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

	#lines(ask: AppAsk): HTMLElement {
		const line = (label: string, ...value: (Node | string)[]) => [h("dt", null, label), h("dd", null, ...value)];
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

	#show(ask: AppAsk, perform: () => Promise<void>, pending: Pending): void {
		this.#clear();
		const agent = ask.kind === "answer" ? this.#host.agent(ask.agentId) : undefined;
		const name = agent?.displayName ?? t("The agent");
		const title = h(
			"strong",
			{ class: "app-ask-title", id: this.#titleId },
			ask.kind === "answer"
				? t("This app wants to send your answer to {name}", { name })
				: ask.add
					? t("This app wants to add a row to a company table")
					: t("This app wants to change a row in a company table"),
		);
		const later = h("button", { type: "button", class: "app-ask-button" }, t("Not now"));
		const yes = h(
			"button",
			{ type: "button", class: "app-ask-button is-yes", disabled: true },
			ask.kind === "answer" ? t("Send answer") : ask.add ? t("Add row") : t("Change row"),
		);
		// The yes button wakes a second after the bar is on a screen the member can see, and takes only a press that
		// began after that: a click or a key already on its way when the bar came in does nothing.
		let awake = Number.POSITIVE_INFINITY;
		let pressed = -1;
		const wake = () => {
			clearTimeout(this.#timer);
			if (document.visibilityState === "hidden") return;
			this.#timer = setTimeout(() => {
				awake = Date.now();
				yes.disabled = false;
				yes.classList.add("is-awake");
			}, ASK_ALLOW_AFTER_MS);
		};
		document.addEventListener("visibilitychange", wake);
		this.#stopWaking = () => document.removeEventListener("visibilitychange", wake);
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
		later.addEventListener("click", () => {
			if (this.#pending !== pending || pending.working) return;
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
		});
		yes.addEventListener("click", () => {
			if (this.#pending !== pending || pending.working || yes.disabled || pressed < awake) return;
			pending.working = true;
			this.#clear();
			yes.disabled = true;
			later.disabled = true;
			yes.textContent = ask.kind === "answer" ? t("Sending…") : t("Saving…");
			void perform().then(
				() => {
					this.#declines = 0;
					pending.settle({ outcome: "saved" });
					this.#settled(
						h(
							"p",
							{ class: "app-ask-note is-saved", role: "status" },
							icon("check"),
							ask.kind === "answer" ? t("Sent to {name}", { name }) : t("Saved"),
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
		const lines = this.#lines(ask);
		replace(
			this.el,
			h(
				"span",
				{ class: "app-ask-figure", "aria-hidden": "true" },
				ask.kind === "answer"
					? agentFigure(agent, name, { size: 30, activity: "Waiting", ask: "question" })
					: this.#host.emblem(),
			),
			h("div", { class: "app-ask-copy" }, title, lines),
			h("div", { class: "app-ask-buttons" }, later, yes),
		);
		this.el.hidden = false;
		this.el.classList.remove("is-settled");
		// Lines longer than the bar may be scroll inside it (styles/conversation.css): the keyboard reaches them too.
		if (lines.scrollHeight > lines.clientHeight) lines.tabIndex = 0;
		this.#host.open(true);
		// Out of the page and onto the safe answer, so Enter never allows.
		later.focus({ preventScroll: true });
		wake();
	}

	/** The bar once its request is settled: how it went, with a way to put it away, until it goes by itself. A new
	 * request may take its place at once. */
	#settled(note: HTMLElement, ms: number): void {
		if (this.#disposed) return;
		this.#clear();
		const close = h(
			"button",
			{ type: "button", class: "app-ask-button", onclick: () => this.#pending === undefined && this.#hide() },
			t("Close"),
		);
		const within = this.el.contains(document.activeElement);
		replace(this.el, note, h("div", { class: "app-ask-buttons" }, close));
		this.el.classList.add("is-settled");
		this.#host.open(false);
		if (within) close.focus({ preventScroll: true });
		this.#timer = setTimeout(() => {
			if (this.#pending === undefined) this.#hide();
		}, ms);
	}
}
