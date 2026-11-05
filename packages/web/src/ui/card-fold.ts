import { h } from "./dom.ts";
import { t } from "./preferences.ts";

/* A card's long text, folded behind Show more (Jonas, 5 November 2026: "approval cards are completely unreadable"): a
 * question card's body and a review card's quoted content. A text is folded only when it is long, and once it is in the
 * page the fold goes away again when nothing is hidden (a wide screen). Opening one stays open while the card is drawn
 * again (an answer sent, a failed send, a change of language): which are open is kept by the card's id. */

/** Cards opened in this page, by id. */
const opened = new Set<string>();
let ids = 0;

/** `content` folded behind Show more when `long`, kept open across redraws by `key`. */
export function foldLong(content: HTMLElement, long: boolean, key: string): HTMLElement {
	if (!long) return content;
	const id = `card-fold-${++ids}`;
	content.id = id;
	content.classList.add("card-fold");
	const more = h("button", { type: "button", class: "card-more", "aria-controls": id }, "") as HTMLButtonElement;
	const set = (open: boolean) => {
		content.classList.toggle("is-folded", !open);
		more.setAttribute("aria-expanded", String(open));
		more.textContent = open ? t("Show less") : t("Show more");
		if (open) opened.add(key);
		else opened.delete(key);
	};
	more.addEventListener("click", () => set(content.classList.contains("is-folded")));
	set(opened.has(key));
	const wrap = h("div", { class: "card-fold-wrap" }, content, more);
	// In the page, a fold that hides nothing is no fold: its text shows whole and the button goes.
	if (typeof requestAnimationFrame === "function")
		requestAnimationFrame(() => {
			if (!content.isConnected || !content.classList.contains("is-folded") || content.scrollHeight === 0) return;
			if (content.scrollHeight <= content.clientHeight + 1) {
				content.classList.remove("card-fold", "is-folded");
				more.remove();
			}
		});
	return wrap;
}

/** The text a member sees of a line of Markdown: a link's words, not where it goes. */
export function shownLength(markdownText: string): number {
	return [...markdownText.replace(/\]\([^)]*\)/g, "]")].length;
}
