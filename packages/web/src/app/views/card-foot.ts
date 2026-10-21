import { h, icon, replace } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";

/** What the foot of an agent's or a group chat's card offers. Each is left out where the member
 * can't use it, and the foot then shows no control for it. */
export interface CardFootActions {
	/** Pins the item to this member's pinned row, or unpins it when `pinned`. */
	pin?: () => void;
	pinned?: boolean;
	/** Hides the item from this member's sidebar, or shows it again when `hidden`. */
	hide?: () => void;
	hidden?: boolean;
	remove?: () => void;
	/** The conversation whose id the card copies. */
	conversationId?: string;
}

/** The card's foot: Pin (or Unpin), Copy conversation ID, Hide (or Show) and Delete as plain icons at its
 * right edge, named by their tooltips. Copy keeps the card open and turns into a check for a moment; Pin,
 * Hide and Delete close the card first (`close`). `copyFailed` says so in the card's own words. Null when
 * the member can use none of them. */
export function cardFoot(
	card: CardFootActions,
	options: { close: () => void; copyFailed: () => void; signal: AbortSignal },
): HTMLElement | null {
	const square = (label: string, glyph: string, act: (() => void) | undefined, danger = false) =>
		act
			? (h(
					"button",
					{
						type: "button",
						class: `agent-card-square${danger ? " is-danger" : ""}`,
						title: label,
						"aria-label": label,
						onclick: act,
					},
					icon(glyph),
				) as HTMLButtonElement)
			: null;
	const closing = (act: (() => void) | undefined) =>
		act &&
		(() => {
			options.close();
			act();
		});
	let copied: ReturnType<typeof setTimeout> | undefined;
	options.signal.addEventListener("abort", () => clearTimeout(copied), { once: true });
	const conversationId = card.conversationId;
	const copy = conversationId
		? square(t("Copy conversation ID"), "copy", () => {
				void (async () => {
					try {
						if (!navigator.clipboard) throw new Error("No clipboard");
						await navigator.clipboard.writeText(conversationId);
					} catch {
						if (!options.signal.aborted) options.copyFailed();
						return;
					}
					if (options.signal.aborted || !copy) return;
					clearTimeout(copied);
					replace(copy, icon("check"));
					copy.classList.add("is-done");
					copy.setAttribute("aria-label", t("Copied"));
					copied = setTimeout(() => {
						replace(copy, icon("copy"));
						copy.classList.remove("is-done");
						copy.setAttribute("aria-label", t("Copy conversation ID"));
					}, 1600);
				})();
			})
		: null;
	const squares = [
		card.pinned ? square(t("Unpin"), "unpin", closing(card.pin)) : square(t("Pin"), "pin", closing(card.pin)),
		copy,
		card.hidden
			? square(t("Show in sidebar"), "show", closing(card.hide))
			: square(t("Hide from sidebar"), "hide", closing(card.hide)),
		square(t("Delete"), "trash", closing(card.remove), true),
	];
	return squares.some(Boolean) ? h("div", { class: "agent-card-squares" }, ...squares) : null;
}
