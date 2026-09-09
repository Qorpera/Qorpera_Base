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
	constructor(choice: FigureChoice, change: (choice: FigureChoice) => void) {
		this.#choice = choice;
		this.#change = change;
		this.#render();
	}
	#choose(choice: FigureChoice): void {
		const focused = document.activeElement?.getAttribute("aria-label");
		this.#choice = choice;
		this.#render();
		this.#change(choice);
		[...this.el.querySelectorAll<HTMLButtonElement>("button")]
			.find((button) => button.getAttribute("aria-label") === focused)
			?.focus();
	}
	#render(): void {
		const { figure, color } = this.#choice;
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
							onclick: () => this.#choose({ figure: id, color: nativeColorOf(id) }),
						},
						figureElement(id, id === figure ? color : undefined, { size: 32, still: true }),
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
