import type { HostedStaffAgent } from "../../cloud/types.ts";
import { figureElement } from "../../ui/avatar.ts";
import { SurfaceDialog } from "../../ui/dialog.ts";
import { button, h, icon, replace } from "../../ui/dom.ts";
import { type FigureChoice, FigurePicker } from "../../ui/figure-picker.ts";
import { matchesKey } from "../../ui/keys.ts";
import { markdown, markdownSourceOffset } from "../../ui/markdown.ts";
import { phrase, t } from "../../ui/preferences.ts";
import type { CompanyController } from "../company.ts";
import type { AgentDraft, WorkspaceActions } from "../workspace-actions.ts";
import { type AgentEdits, editsFor, savedAgentDraft } from "./agent-edits.ts";
import { AgentRoutines, routineAccessFor } from "./agent-routines.ts";
import { type CardFootActions, cardFoot } from "./card-foot.ts";

/** A name and responsibilities, and no title under the name (Jonas, 10 November 2026: a name and responsibility is
 * enough). The agent's role still lives in its agent.md; the card neither shows nor edits it. */
type TextKey = "displayName" | "charter";

const FIELDS: Record<TextKey, { label: string; empty: string }> = {
	displayName: { label: phrase("Agent name"), empty: phrase("An agent needs a name.") },
	// The description is the agent's responsibilities in plain prose, and what the agent works from.
	charter: { label: phrase("Responsibilities"), empty: phrase("An agent needs its responsibilities written down.") },
};

/** What the card opens or does besides editing the agent. Each is left out where the
 * member can't use it, and the card then shows no control for it. */
export interface AgentCardActions extends CardFootActions {
	computer?: () => void;
}

/** An agent's card: what a right-click on the agent in the rail opens (and, on a phone,
 * the conversation title). Name and responsibilities are edited where they stand
 * and save on their own; the figure changes from a picker under it, as on the desktop. The
 * responsibilities field is the agent's description in plain prose and what the agent works
 * from. It is written in Markdown and the card draws it so (Jonas, 10 November 2026: "the description isn't
 * rendering the markdown designs they are written in"); the text itself takes the drawing's place while it is
 * edited. Under it, the agent's computer and routines, then Copy, Hide and Delete. Latest notes
 * left the card again (Jonas, 10 November 2026): the wall stays above the agent's composer.
 * Routines are a page of the card itself, with a way back. */
export class AgentDetails {
	readonly dialog: SurfaceDialog;
	readonly #company: CompanyController;
	readonly #actions: WorkspaceActions;
	readonly #agent: HostedStaffAgent;
	/** The routines page, kept while the card is open so going back and forth reads the list again in place. */
	#routines: AgentRoutines | undefined;
	readonly #routinesLink: HTMLButtonElement | null;
	readonly #lifetime = new AbortController();
	readonly #edits: AgentEdits;
	readonly #unsubscribeEdits: () => void;
	readonly #unsubscribe: () => void;
	readonly #details: HTMLElement;
	readonly #fields = {} as Record<TextKey, HTMLInputElement | HTMLTextAreaElement>;
	readonly #stage = h("span", { class: "agent-figure-stage" });
	readonly #figureButton: HTMLButtonElement;
	readonly #picker: HTMLElement;
	readonly #figures: FigurePicker;
	readonly #status = h("p", { class: "agent-details-status", role: "status" });
	/** The responsibilities drawn as the Markdown they are written in: what the card shows while their field does not
	 * have the focus. A picture of the field's text, so assistive technology reads the field alone. */
	readonly #reading = h("div", { class: "agent-inline-reading", "aria-hidden": "true" });
	/** The text `#reading` was last drawn from. */
	#drawnText: string | undefined;
	/** The field being typed in, if any. */
	#open: TextKey | undefined;
	#drawn = "";
	#discarded = false;
	#statusTimer: ReturnType<typeof setTimeout> | undefined;
	constructor(
		company: CompanyController,
		agent: HostedStaffAgent,
		actions: WorkspaceActions,
		onClose: () => void,
		anchor?: HTMLElement,
		scope: AbortSignal = company.signal,
		card: AgentCardActions = {},
		placement: "below" | "beside" = "below",
	) {
		this.#company = company;
		this.#actions = actions;
		this.#agent = agent;
		this.#edits = editsFor(company, agent, actions, scope);
		this.dialog = new SurfaceDialog(
			t("Agent details"),
			"agent-details agent-card",
			() => this.#closed(onClose),
			anchor,
			placement,
		);
		// Each closes the card first: what it opens takes the screen, or asks its own question.
		const then = (act: () => void) => () => {
			this.dialog.close(false);
			act();
		};
		const link = (label: string, glyph: string, act: (() => void) | undefined) =>
			act
				? h(
						"button",
						{ type: "button", class: "agent-card-link", onclick: then(act) },
						icon(glyph),
						h("span", null, label),
						icon("chevron"),
					)
				: null;
		const routines = h(
			"button",
			{ type: "button", class: "agent-card-link", onclick: () => this.#showRoutines() },
			icon("clock"),
			h("span", null, t("Routines")),
			icon("chevron"),
		) as HTMLButtonElement;
		this.#routinesLink = routines;
		const links = [link(t("Computer"), "computer", card.computer), routines];
		const foot = cardFoot(card, {
			close: () => this.dialog.close(false),
			copyFailed: () => {
				this.#say(t("The conversation ID could not be copied."));
				// Then the edits' own line comes back, a failed save's Try again with it.
				this.#statusTimer = setTimeout(() => this.#syncEdits(), 2400);
			},
			signal: this.#lifetime.signal,
		});

		this.#figures = new FigurePicker(savedAgentDraft(agent), (choice) => this.#choose(choice), { keepColor: true });
		this.#picker = h(
			"div",
			{
				class: "agent-figure-picker",
				role: "dialog",
				"aria-label": t("Choose a figure and color"),
				hidden: true,
				onkeydown: (event: KeyboardEvent) => {
					if (!matchesKey(event, "dismiss")) return;
					event.preventDefault();
					event.stopPropagation();
					this.#closePicker(true);
				},
			},
			h(
				"button",
				{
					type: "button",
					class: "agent-figure-reset",
					onclick: () => this.#figures.reset(),
				},
				t("Reset"),
			),
			this.#figures.el,
		);
		this.#figureButton = h(
			"button",
			{
				type: "button",
				class: "agent-figure-button",
				"aria-label": t("Edit figure"),
				"aria-haspopup": "dialog",
				"aria-expanded": "false",
				onclick: () => (this.#picker.hidden ? this.#openPicker() : this.#closePicker(true)),
			},
			this.#stage,
			h("span", { class: "agent-figure-pencil", "aria-hidden": "true" }, icon("edit")),
			h("span", { class: "agent-figure-tip", "aria-hidden": "true" }, t("Edit figure")),
		);
		this.#details = h(
			"div",
			{ class: "agent-page agent-details-page" },
			h(
				"div",
				{ class: "agent-details-identity" },
				h("div", { class: "agent-figure-area" }, this.#figureButton, this.#picker),
				h("div", { class: "agent-details-names" }, this.#field("displayName")),
			),
			this.#field("charter"),
			links.some(Boolean) ? h("div", { class: "agent-card-links" }, ...links) : null,
			foot,
			this.#status,
		);
		// A click elsewhere in the panel puts the figure picker away.
		this.dialog.el.addEventListener(
			"pointerdown",
			(event) => {
				if (
					!this.#picker.hidden &&
					event.target instanceof Node &&
					!this.#picker.contains(event.target) &&
					!this.#figureButton.contains(event.target)
				)
					this.#closePicker(false);
			},
			{ signal: this.#lifetime.signal },
		);
		this.#unsubscribe = company.store.subscribe(() => {
			if (company.signal.aborted || !company.store.get().team?.capabilities.read || !company.staffById(agent.id))
				this.dispose();
			else this.#sync();
		});
		company.signal.addEventListener("abort", () => this.dispose(), { signal: this.#lifetime.signal });
		scope.addEventListener("abort", () => this.dispose(), { signal: this.#lifetime.signal });
		this.#unsubscribeEdits = this.#edits.store.subscribe(() => this.#syncEdits());
		this.#sync();
		this.#syncEdits();
		this.dialog.el.dataset.page = "details";
		replace(this.dialog.content, this.#details);
		this.dialog.open();
	}

	dispose(): void {
		this.#discarded = true;
		this.#edits.dispose();
		this.dialog.close(false);
	}

	#closed(onClose: () => void): void {
		if (!this.#discarded) {
			// Closing the panel with a field still open counts as leaving the field.
			if (this.#open) this.#commit(this.#open);
		}
		this.#lifetime.abort();
		clearTimeout(this.#statusTimer);
		this.#unsubscribe();
		this.#unsubscribeEdits();
		onClose();
	}

	#current(): AgentDraft {
		return this.#edits.current();
	}

	#canWrite(): boolean {
		return this.#edits.canWrite();
	}

	/** A name, title or description that reads as text and is edited in place.
	 * Enter or leaving the field saves it; Escape puts the saved text back. */
	#field(key: TextKey): HTMLElement {
		const multiline = key === "charter";
		const events = {
			"aria-label": t(FIELDS[key].label),
			oninput: () => this.#show(key, control.value),
			onkeydown: (event: KeyboardEvent) => {
				if (matchesKey(event, "dismiss")) {
					event.preventDefault();
					event.stopPropagation();
					this.#show(key, this.#current()[key]);
					this.#leave(control);
				} else if (matchesKey(event, "accept") && (!multiline || event.metaKey || event.ctrlKey)) {
					event.preventDefault();
					this.#leave(control);
				}
			},
			onfocus: () => {
				this.#open = key;
			},
			onblur: () => this.#commit(key),
		};
		const control: HTMLInputElement | HTMLTextAreaElement = multiline
			? h("textarea", { rows: 5, maxlength: "10000", ...events })
			: h("input", {
					type: "text",
					// No width of its own: the sizer gives it the width of its text.
					size: "1",
					maxlength: "64",
					autocomplete: "off",
					...events,
				});
		this.#fields[key] = control;
		// The sizer mirrors the text so the name is as wide as what it holds;
		// the description fills the popup's static frame instead (conversation.css).
		const sizer = h("span", { class: "agent-inline-size" }, control);
		if (!multiline) return h("label", { class: "agent-inline-field agent-inline-name" }, sizer, icon("edit"));
		// The drawn text stands in the field's place until the field has the focus (conversation.css).
		return h(
			"label",
			{
				class: "agent-inline-field agent-inline-description has-reading",
				onclick: (event: MouseEvent) => this.#editAt(event),
			},
			sizer,
			this.#reading,
			icon("edit"),
		);
	}

	/** A click on the drawn responsibilities opens their field with the caret where the click fell. The click is
	 * answered here, not by the label: a member who can only read keeps the drawing, and so does a click that ends a
	 * selection of its text. */
	#editAt(event: MouseEvent): void {
		const control = this.#fields.charter;
		// A click in the field itself is the field's own.
		if (!(event.target instanceof Node) || control.parentElement?.contains(event.target)) return;
		event.preventDefault();
		const selection = getSelection();
		if (!this.#canWrite() || (selection && !selection.isCollapsed && this.#reading.contains(selection.anchorNode)))
			return;
		const caret = document.caretPositionFromPoint?.(event.clientX, event.clientY);
		// WebKit's older name for the same, where the first is missing.
		const range = caret ? undefined : document.caretRangeFromPoint?.(event.clientX, event.clientY);
		const node = caret?.offsetNode ?? range?.startContainer;
		const at =
			node && this.#reading.contains(node)
				? markdownSourceOffset(control.value, node, caret?.offset ?? range?.startOffset ?? 0)
				: undefined;
		if (at !== undefined) control.setSelectionRange(at, at);
		// Focusing brings the caret into view.
		control.focus();
	}

	#show(key: TextKey, value: string): void {
		const control = this.#fields[key];
		if (control.value !== value) control.value = value;
		const sizer = control.parentElement;
		if (sizer) sizer.dataset.value = value;
		// The field covers the drawing while it is typed in, so the drawing follows once the typing is over.
		if (key !== "charter" || key === this.#open || value === this.#drawnText) return;
		this.#drawnText = value;
		// Links read as their text: a click here edits, and nothing leaves the card.
		replace(this.#reading, markdown(value, { links: false, sourceRanges: true }));
	}

	/** Leaves a field for the panel itself, so the keyboard stays in the panel. */
	#leave(control: HTMLElement): void {
		control.blur();
		if (!this.#lifetime.signal.aborted) this.dialog.el.focus({ preventScroll: true });
	}

	#commit(key: TextKey): void {
		if (this.#open === key) this.#open = undefined;
		if (this.#lifetime.signal.aborted) return;
		const value = this.#fields[key].value.trim();
		const current = this.#current()[key];
		if (value === current || !this.#canWrite()) {
			this.#show(key, current);
			return;
		}
		if (!value) {
			this.#show(key, current);
			this.#say(t(FIELDS[key].empty));
			return;
		}
		this.#show(key, value);
		this.#change({ [key]: value });
	}

	#choose(choice: FigureChoice): void {
		const current = this.#current();
		if (!this.#canWrite() || (choice.figure === current.figure && choice.color === current.color)) return;
		this.#change(choice);
		this.#drawFigure();
	}

	#change(change: Partial<AgentDraft>): void {
		this.#edits.change(change);
	}

	#syncEdits(): void {
		if (this.#lifetime.signal.aborted) return;
		this.#sync();
		const { status, failed, saved } = this.#edits.store.get();
		this.#say(status, saved, failed);
	}

	/** The agent's routines take the card, which widens for them; the way back returns to the details. */
	#showRoutines(): void {
		if (this.#lifetime.signal.aborted) return;
		this.#closePicker(false);
		if (this.#routines) this.#routines.refresh();
		else
			this.#routines = new AgentRoutines(
				() => this.#company.staffById(this.#agent.id) ?? this.#agent,
				routineAccessFor(this.#company, this.#actions),
				this.#lifetime.signal,
				() => this.#showDetails(),
				true,
			);
		this.dialog.el.dataset.page = "routines";
		replace(this.dialog.content, this.#routines.el);
		this.dialog.content.scrollTop = 0;
		this.dialog.content.querySelector<HTMLElement>(".routine-close")?.focus({ preventScroll: true });
	}

	#showDetails(): void {
		if (this.#lifetime.signal.aborted) return;
		this.dialog.el.dataset.page = "details";
		replace(this.dialog.content, this.#details);
		// Figures that left the page stop drawing; this one is drawn anew.
		this.#drawn = "";
		this.#drawFigure();
		this.#routinesLink?.focus({ preventScroll: true });
	}

	#say(text: string, fade = false, retry = false): void {
		if (this.#lifetime.signal.aborted) return;
		clearTimeout(this.#statusTimer);
		replace(
			this.#status,
			text,
			retry
				? button(t("Try again"), () => void this.#edits.save(), { small: true, disabled: !this.#canWrite() })
				: null,
		);
		if (fade) this.#statusTimer = setTimeout(() => replace(this.#status), 2400);
	}

	/** Brings the panel up to date with the roster without touching a field
	 * that is being typed in. */
	#sync(): void {
		if (this.#lifetime.signal.aborted) return;
		const canWrite = this.#canWrite();
		if (!canWrite) {
			this.#closePicker(false);
		}
		const current = this.#current();
		for (const key of Object.keys(this.#fields) as TextKey[]) {
			const control = this.#fields[key];
			control.readOnly = !canWrite;
			control.closest(".agent-inline-field")?.classList.toggle("is-editable", canWrite);
			// Revocation discards even text that has not blurred into the shared draft.
			if (!canWrite || key !== this.#open) this.#show(key, current[key]);
		}
		this.#figureButton.disabled = !canWrite;
		this.#drawFigure();
	}

	#drawFigure(): void {
		const { figure, color } = this.#current();
		const key = `${figure}:${color}`;
		if (key === this.#drawn) return;
		this.#drawn = key;
		replace(this.#stage, figureElement(figure, color, { size: 100, identity: this.#agent.id }));
		if (!this.#picker.hidden) this.#figures.update({ figure, color });
	}

	#openPicker(): void {
		if (!this.#canWrite()) return;
		const { figure, color } = this.#current();
		// Rebuilt on every opening: figures that left the page are not kept alive.
		this.#figures.update({ figure, color }, true);
		this.#picker.hidden = false;
		this.#figureButton.setAttribute("aria-expanded", "true");
		this.dialog.el.classList.add("is-choosing-figure");
		this.#picker.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus({ preventScroll: true });
	}

	#closePicker(focusButton: boolean): void {
		if (this.#picker.hidden) return;
		this.#picker.hidden = true;
		this.#figureButton.setAttribute("aria-expanded", "false");
		this.dialog.el.classList.remove("is-choosing-figure");
		if (focusButton) this.#figureButton.focus({ preventScroll: true });
	}
}
