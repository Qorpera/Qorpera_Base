import { h } from "./dom.ts";

export function friendsCount(count: number): HTMLElement {
	return h("span", { class: "friends-count", "aria-hidden": "true" }, count > 9 ? "9+" : String(count));
}
