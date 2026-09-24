import { colorName, FIGURE_IDS, type FigureId, figureElement, figureName, nativeColorOf, PALETTE } from "./avatar.ts";
import { h, replace } from "./dom.ts";
import { matchesKey } from "./keys.ts";
import { t } from "./preferences.ts";

export interface FigureChoice {
	figure: FigureId;
	color: string;
}

export class FigurePicker {
	readonly el = h("div", { class: "appearance-picker" });
	#choice: FigureChoice;
	readonly #change: (choice: FigureChoice) => void;
	readonly #keepColor: boolean;
	/** Whether a figure change brings the new figure's own shade. */
	#follow: boolean;
	/** `keepColor` shows every figure in the chosen colour and keeps that colour
	 * when the figure changes, as the desktop's agent picker does. A figure in its
	 * own shade has no colour of its own to keep: every figure then shows, and
	 * brings, its own shade, until a colour is picked. */
	constructor(choice: FigureChoice, change: (choice: FigureChoice) => void, options: { keepColor?: boolean } = {}) {
		this.#choice = choice;
		this.#change = change;
		this.#keepColor = options.keepColor === true;
		this.#follow = this.#follows(choice);
		this.#render();
	}
	/** Shows a choice made elsewhere, such as a saved figure or another member's
	 * change, without reporting it, and decides again from it whether it follows
	 * the figure. `fresh` rebuilds the figures even when the choice is unchanged,
	 * as on opening. */
	update(choice: FigureChoice, fresh = false): void {
		if (!fresh && choice.figure === this.#choice.figure && choice.color === this.#choice.color) return;
		const focused = this.el.contains(document.activeElement) ? document.activeElement : null;
		this.#choice = choice;
		this.#follow = this.#follows(choice);
		this.#render();
		this.#refocus(focused?.getAttribute("aria-label"));
	}
	/** Puts the figure back in its own shade, which then follows the figure again. */
	reset(): void {
		const { figure } = this.#choice;
		this.#follow = true;
		this.#choose({ figure, color: nativeColorOf(figure) });
	}
	/** Decided from a starting point, never on each change: passing through a
	 * figure whose own shade is the chosen colour must not drop the choice. */
	#follows({ figure, color }: FigureChoice): boolean {
		return !this.#keepColor || color === nativeColorOf(figure);
	}
	#choose(choice: FigureChoice): void {
		const focused = document.activeElement?.getAttribute("aria-label");
		this.#choice = choice;
		this.#render();
		this.#change(choice);
		this.#refocus(focused);
	}
	#refocus(label: string | null | undefined): void {
		if (!label) return;
		[...this.el.querySelectorAll<HTMLButtonElement>("button")]
			.find((button) => button.getAttribute("aria-label") === label)
			?.focus();
	}
	#render(): void {
		const { figure, color } = this.#choice;
		const keep = !this.#follow;
		replace(
			this.el,
			h(
				"div",
				{ class: "figure-grid", role: "radiogroup", "aria-label": t("Agent figure") },
				...FIGURE_IDS.map((id) =>
					h(
						"button",
						{
							type: "button",
							class: "figure-choice",
							role: "radio",
							tabindex: id === figure ? "0" : "-1",
							"aria-checked": String(id === figure),
							"aria-label": figureName(id),
							onclick: () => this.#choose({ figure: id, color: keep ? color : nativeColorOf(id) }),
						},
						figureElement(id, id === figure || keep ? color : undefined, { size: 32, still: true }),
					),
				),
			),
			h(
				"div",
				{ class: "color-grid", role: "radiogroup", "aria-label": t("Agent color") },
				...PALETTE().map(({ name, color: hex }, index) =>
					h("button", {
						type: "button",
						class: "color-choice",
						role: "radio",
						tabindex:
							hex === color || (index === 0 && !PALETTE().some((item) => item.color === color)) ? "0" : "-1",
						"aria-checked": String(hex === color),
						"aria-label": colorName(name),
						dataset: { color: hex },
						onclick: () => {
							// A colour picked here is kept, even one that is some figure's own shade.
							if (this.#keepColor) this.#follow = false;
							this.#choose({ figure, color: hex });
						},
					}),
				),
			),
		);
		for (const swatch of this.el.querySelectorAll<HTMLElement>("[data-color]"))
			swatch.style.setProperty("--choice-color", swatch.dataset.color ?? "");
		this.el.onkeydown = (event) => {
			if (
				!(["left", "right", "next", "previous", "first", "last"] as const).some((action) =>
					matchesKey(event, action),
				)
			)
				return;
			const group = (event.target as Element).closest("[role=radiogroup]");
			const buttons = [...(group?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
			const index = buttons.indexOf(event.target as HTMLButtonElement);
			if (index < 0) return;
			event.preventDefault();
			const next = matchesKey(event, "first")
				? 0
				: matchesKey(event, "last")
					? buttons.length - 1
					: (index + (matchesKey(event, "left") || matchesKey(event, "previous") ? -1 : 1) + buttons.length) %
						buttons.length;
			buttons[next]?.focus();
			buttons[next]?.click();
		};
	}
}
