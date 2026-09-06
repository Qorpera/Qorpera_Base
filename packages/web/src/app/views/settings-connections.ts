import { h, notice } from "../../ui/dom.ts";

/** The approved settings surface has no provider or service adapter yet. */
export class ConnectionsView {
	readonly el = h(
		"div",
		null,
		h("h1", null, "Connections"),
		notice("neutral", "Account and service connections are not available yet."),
		h(
			"section",
			{ class: "settings-group" },
			h("h2", null, "Model accounts"),
			h(
				"div",
				{ class: "connection-list" },
				...[
					["ChatGPT / Codex", "provider-openai.svg"],
					["Claude", "provider-anthropic.svg"],
				].map(([label, logo]) =>
					h(
						"article",
						{ class: "connection-card" },
						h("img", { class: "connection-logo", src: `./assets/${logo}`, alt: "" }),
						h("div", { class: "settings-copy" }, h("strong", null, label), h("small", null, "Not available yet")),
						h("button", { type: "button", class: "btn", disabled: true }, "Connect"),
					),
				),
			),
		),
		h(
			"section",
			{ class: "settings-group" },
			h("h2", null, "Services"),
			h(
				"div",
				{ class: "settings-card" },
				h(
					"div",
					{ class: "settings-copy" },
					h("strong", null, "Connect your tools"),
					h("small", null, "Not available yet"),
				),
				h("button", { type: "button", class: "btn", disabled: true }, "Add service"),
			),
		),
	);
	dispose(): void {
		this.el.remove();
	}
}
