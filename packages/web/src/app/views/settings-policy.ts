import { h, icon, notice } from "../../ui/dom.ts";

const POLICIES = [
	["spending", "Spending"],
	["external_communication", "External Communication"],
	["hard_to_reverse_changes", "Hard-to-reverse Changes"],
	["information_sharing", "Information Sharing"],
] as const;

/** Preview choices stay in this settings session; no company policy is read or written. */
export class PolicyView {
	readonly el: HTMLElement;
	constructor() {
		const choices = POLICIES.map(([key, label]) => {
			const select = h(
				"select",
				{ "aria-label": label },
				...(["ask", "act", "auto"] as const).map((mode) =>
					h("option", { value: mode }, mode.charAt(0).toUpperCase() + mode.slice(1)),
				),
			);
			return h("label", { class: "policy-row" }, icon(key), h("span", null, label), select);
		});
		this.el = h(
			"div",
			null,
			h(
				"header",
				{ class: "policy-heading" },
				h("h1", null, "Policy"),
				h("span", { class: "policy-note" }, icon("info"), "Instructions, not permissions"),
			),
			notice("neutral", "Preview only. These choices are not your company's active policy and are not saved."),
			h("div", { class: "policy-list" }, ...choices),
			h(
				"p",
				{ class: "policy-help" },
				"Ask: request approval first. Act: act when directly requested or authorized. Auto: act when it advances your request. These instructions do not expand access or bypass company permissions.",
			),
			h(
				"button",
				{ type: "button", class: "btn", disabled: true, title: "Saving policy is not available yet" },
				"Save policy",
			),
		);
	}
	dispose(): void {
		this.el.remove();
	}
}
