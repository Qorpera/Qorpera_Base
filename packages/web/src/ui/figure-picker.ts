import { FIGURE_IDS, type FigureId, figureElement, nativeColorOf, PALETTE } from "./avatar.ts";
import { h, replace } from "./dom.ts";
import { matchesKey } from "./keys.ts";

export interface FigureChoice {
	figure: FigureId;
	color: string;
}

export class FigurePicker {
	readonly el = h("div", { class: "appearance-picker" });
	#choice: FigureChoice;
	readonly #change: (choice: FigureChoice) => void;
	readonly #keepColor: boolean;
	/** `keepColor` shows every figure in the chosen colour and keeps that colour
	 * when the figure changes, as the desktop's agent picker does. A figure in its
	 * own shade has no colour of its own to keep: every figure then shows, and
	 * brings, its own shade. */
	constructor(choice: FigureChoice, change: (choice: FigureChoice) => void, options: { keepColor?: boolean } = {}) {
		this.#choice = choice;
		this.#change = change;
		this.#keepColor = options.keepColor === true;
		this.#render();
	}
	/** Shows a choice made elsewhere, such as a saved figure, without reporting
	 * it. `redraw` rebuilds the figures even when the choice is unchanged. */
	update(choice: FigureChoice, redraw = false): void {
		if (!redraw && choice.figure === this.#choice.figure && choice.color === this.#choice.color) return;
		const focused = this.el.contains(document.activeElement) ? document.activeElement : null;
		this.#choice = choice;
		this.#render();
		this.#refocus(focused?.getAttribute("aria-label"));
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
		const keep = this.#keepColor && color !== nativeColorOf(figure);
		replace(
			this.el,
			h(
				"div",
				{ class: "figure-grid", role: "radiogroup", "aria-label": "Agent figure" },
				...FIGURE_IDS.map((id) =>
					h(
						"button",
						{
							type: "button",
							class: "figure-choice",
							role: "radio",
							tabindex: id === figure ? "0" : "-1",
							"aria-checked": String(id === figure),
							"aria-label": id,
							onclick: () => this.#choose({ figure: id, color: keep ? color : nativeColorOf(id) }),
						},
						figureElement(id, id === figure || keep ? color : undefined, { size: 32, still: true }),
					),
				),
			),
			h(
				"div",
				{ class: "color-grid", role: "radiogroup", "aria-label": "Agent color" },
				...PALETTE().map(({ name, color: hex }, index) =>
					h("button", {
						type: "button",
						class: "color-choice",
						role: "radio",
						tabindex:
							hex === color || (index === 0 && !PALETTE().some((item) => item.color === color)) ? "0" : "-1",
						"aria-checked": String(hex === color),
						"aria-label": name,
						dataset: { color: hex },
						onclick: () => this.#choose({ figure, color: hex }),
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
