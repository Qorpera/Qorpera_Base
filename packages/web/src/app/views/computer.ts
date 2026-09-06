import type { HostedStaffAgent } from "../../cloud/types.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { h, icon, replace } from "../../ui/dom.ts";
import { matchesKey } from "../../ui/keys.ts";

/** The panel is a UI surface. It neither starts a computer nor connects a
 * screen. An unavailable state cannot be mistaken for a live idle machine. */
export class ComputerPanel {
	readonly el: HTMLElement;
	constructor(agent: HostedStaffAgent, close: () => void) {
		this.el = h(
			"aside",
			{ class: "computer-panel", "aria-label": "Agent computer" },
			h(
				"header",
				null,
				h("strong", null, "Computer"),
				h(
					"button",
					{ type: "button", class: "icon-button", "aria-label": "Close computer", onclick: close },
					icon("close"),
				),
			),
			h(
				"div",
				{ class: "computer-panel-body" },
				h(
					"section",
					{ class: "computer-preview" },
					h(
						"div",
						{ class: "computer-preview-screen" },
						agentFigure(agent, agent.displayName, { size: 64 }),
						h("span", null, "Computer unavailable"),
					),
					h("strong", null, agent.displayName),
					h("p", { class: "muted" }, "Computer access is not available yet."),
				),
				h(
					"section",
					{ class: "computer-routines" },
					h("h2", null, "Routines"),
					h("p", { class: "muted" }, "Recurring work, on a schedule or when something happens."),
					h("div", { class: "routine-empty" }, icon("clock"), h("p", null, "Routines will appear here.")),
					h("button", { type: "button", class: "btn", disabled: true }, "Create routine"),
				),
			),
		);
		this.el.addEventListener("keydown", (event) => {
			if (matchesKey(event, "dismiss")) {
				event.preventDefault();
				event.stopPropagation();
				close();
			}
		});
	}
	focus(): void {
		this.el.querySelector<HTMLButtonElement>("button")?.focus();
	}
	dispose(): void {
		replace(this.el);
		this.el.remove();
	}
}
