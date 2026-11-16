import { h, icon, replace } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import type { CompanyController } from "../company.ts";
import { type DataAskPlace, type DataAskSend, dataAskLine, dataAskReceiver } from "../data-ask.ts";

export class DataAskBox {
	readonly el = h("form", { class: "data-ask-box", hidden: true });
	readonly #company: CompanyController;
	readonly #send: DataAskSend | undefined;
	readonly #field = h("input", {
		type: "text",
		class: "data-ask-field",
		enterkeyhint: "send",
		autocomplete: "off",
		dataset: { focusKey: "ask" },
	});
	readonly #button = h("button", { type: "submit", class: "data-ask-send", disabled: true }, icon("send"));
	readonly #said = h("p", { class: "data-ask-said", hidden: true });
	#place: DataAskPlace | undefined;
	#busy = false;

	constructor(company: CompanyController, send: DataAskSend | undefined) {
		this.#company = company;
		this.#send = send;
		this.#button.setAttribute("aria-label", t("Ask"));
		this.#button.title = t("Ask");
		replace(this.el, h("div", { class: "data-ask-line" }, this.#field, this.#button), this.#said);
		this.#field.addEventListener("input", () => {
			this.#sync();
			if (!this.#said.classList.contains("is-held")) this.#say(undefined);
		});
		this.el.addEventListener("submit", (event) => {
			event.preventDefault();
			void this.#ask();
		});
	}

	update(place: DataAskPlace | undefined): void {
		this.#place = place;
		const agent = place && this.#send ? dataAskReceiver(this.#company) : undefined;
		this.el.hidden = agent === undefined;
		if (!place || !agent) return;
		const placeholder = t("Ask {name} about {database}…", { name: agent.displayName, database: place.databaseName });
		this.#field.placeholder = placeholder;
		this.#field.setAttribute("aria-label", placeholder);
		this.#sync();
	}

	#sync(): void {
		this.#field.disabled = this.#busy;
		this.#button.disabled = this.#busy || this.#field.value.trim() === "";
	}

	#say(words: string | undefined, href?: string, held = false): void {
		this.#said.hidden = words === undefined;
		this.#said.classList.toggle("is-held", held);
		this.#said.setAttribute("role", held ? "status" : "alert");
		replace(
			this.#said,
			words ?? "",
			href ? h("a", { class: "data-ask-open", href }, t("Open the conversation")) : null,
		);
	}

	async #ask(): Promise<void> {
		const words = this.#field.value.trim();
		const place = this.#place;
		const agent = dataAskReceiver(this.#company);
		if (!words || this.#busy || !place || !agent || !this.#send) return;
		this.#busy = true;
		this.#say(undefined);
		this.#sync();
		try {
			const result = await this.#send(agent.id, { text: words, quotes: [], header: dataAskLine(place) });
			if (result.held)
				this.#say(
					t("{name} already has a note of yours waiting.", {
						name: agent.displayName,
					}),
					result.href,
					true,
				);
			else {
				this.#field.value = "";
				location.hash = result.href;
			}
		} catch (error) {
			this.#say(error instanceof Error ? error.message : String(error));
		}
		this.#busy = false;
		this.#sync();
	}
}
