import type { HostedStaffAgent } from "../../cloud/types.ts";
import { figureElement } from "../../ui/avatar.ts";
import { SurfaceDialog } from "../../ui/dialog.ts";
import { button, h, icon, replace } from "../../ui/dom.ts";
import { type FigureChoice, FigurePicker } from "../../ui/figure-picker.ts";
import { matchesKey } from "../../ui/keys.ts";
import { phrase, t } from "../../ui/preferences.ts";
import type { CompanyController } from "../company.ts";
import type { AgentDraft, WorkspaceActions } from "../workspace-actions.ts";
import { type AgentEdits, editsFor, savedAgentDraft } from "./agent-edits.ts";
import { AgentRoutines, routineAccessFor } from "./agent-routines.ts";

type Page = "details" | "routines";
type TextKey = "displayName" | "role" | "charter";

const FIELDS: Record<TextKey, { label: string; empty: string }> = {
	displayName: { label: phrase("Agent name"), empty: phrase("An agent needs a name.") },
	role: { label: phrase("Agent title"), empty: phrase("An agent needs a title.") },
	// The description is the agent's responsibilities in plain prose, and what the agent works from.
	charter: { label: phrase("Responsibilities"), empty: phrase("An agent needs its responsibilities written down.") },
};

/** An agent's details, anchored under the conversation title. Name, title and
 * responsibilities are edited where they stand and save on their own; the figure
 * changes from a picker under it, as on the desktop. The responsibilities field is the
 * agent's description in plain prose and what the agent works from; there is no separate
 * responsibility page. Routines are a page of the same panel, opened from its top-right corner. */
export class AgentDetails {
	readonly dialog: SurfaceDialog;
	readonly #company: CompanyController;
	readonly #agent: HostedStaffAgent;
	readonly #actions: WorkspaceActions;
	readonly #lifetime = new AbortController();
	readonly #edits: AgentEdits;
	readonly #unsubscribeEdits: () => void;
	readonly #unsubscribe: () => void;
	readonly #pageButtons: Record<Exclude<Page, "details">, HTMLButtonElement>;
	readonly #details: HTMLElement;
	readonly #fields = {} as Record<TextKey, HTMLInputElement | HTMLTextAreaElement>;
	readonly #stage = h("span", { class: "agent-figure-stage" });
	readonly #figureButton: HTMLButtonElement;
	readonly #picker: HTMLElement;
	readonly #figures: FigurePicker;
	readonly #status = h("p", { class: "agent-details-status", role: "status" });
	#page: Page = "details";
	/** The field being typed in, if any. */
	#open: TextKey | undefined;
	#routines: AgentRoutines | undefined;
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
	) {
		this.#company = company;
		this.#agent = agent;
		this.#actions = actions;
		this.#edits = editsFor(company, agent, actions, scope);
		this.dialog = new SurfaceDialog(
			t("Agent details"),
			"agent-details staff-details",
			() => this.#closed(onClose),
			anchor,
		);
		const pageButton = (page: Exclude<Page, "details">, label: string, glyph: string) =>
			h(
				"button",
				{
					type: "button",
					class: "icon-button agent-page-button",
					title: label,
					"aria-label": label,
					"aria-pressed": "false",
					onclick: () => this.#go(this.#page === page ? "details" : page),
				},
				icon(glyph),
			);
		this.#pageButtons = { routines: pageButton("routines", t("Routines"), "clock") };
		this.dialog.tools.prepend(this.#pageButtons.routines);

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
				h("div", { class: "agent-details-names" }, this.#field("displayName"), this.#field("role")),
			),
			this.#field("charter"),
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
		this.#go("details", false);
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

	#latest(): HostedStaffAgent {
		return this.#company.staffById(this.#agent.id) ?? this.#agent;
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
					maxlength: key === "displayName" ? "64" : "160",
					autocomplete: "off",
					...events,
				});
		this.#fields[key] = control;
		// The sizer mirrors the text so the name and title are as wide as what they hold;
		// the description fills the popup's static frame instead (conversation.css).
		const sizer = h("span", { class: "agent-inline-size" }, control);
		return h(
			"label",
			{ class: `agent-inline-field agent-inline-${multiline ? "description" : key === "role" ? "title" : "name"}` },
			sizer,
			icon("edit"),
		);
	}

	#show(key: TextKey, value: string): void {
		const control = this.#fields[key];
		if (control.value !== value) control.value = value;
		const sizer = control.parentElement;
		if (sizer) sizer.dataset.value = value;
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

	#drawFigure(force = false): void {
		const { figure, color } = this.#current();
		const key = `${figure}:${color}`;
		if (!force && key === this.#drawn) return;
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

	#go(page: Page, focus = true): void {
		if (this.#lifetime.signal.aborted) return;
		const from = this.#page;
		this.#closePicker(false);
		this.#page = page;
		this.dialog.el.dataset.page = page;
		for (const [name, control] of Object.entries(this.#pageButtons))
			control.setAttribute("aria-pressed", String(name === page));
		if (page === "details") {
			replace(this.dialog.content, this.#details);
			// Figures that left the page stop drawing; this one is drawn anew.
			if (from !== "details") this.#drawFigure(true);
		} else {
			if (this.#routines) this.#routines.refresh();
			else
				this.#routines = new AgentRoutines(
					() => this.#latest(),
					routineAccessFor(this.#company, this.#actions),
					this.#lifetime.signal,
					() => this.#go("details"),
				);
			replace(this.dialog.content, this.#routines.el);
		}
		this.dialog.content.scrollTop = 0;
		if (!focus || page === from) return;
		const target =
			page === "details"
				? from === "details"
					? undefined
					: this.#pageButtons[from]
				: this.dialog.content.querySelector<HTMLButtonElement>(".dialog-page-back");
		target?.focus({ preventScroll: true });
	}
}
