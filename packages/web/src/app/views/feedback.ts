import type { CloudApi } from "../../cloud/api.ts";
import { describeError } from "../../cloud/client.ts";
import { h } from "../../ui/dom.ts";
import { matchesKey } from "../../ui/keys.ts";
import { uiText } from "../../ui/preferences.ts";

const CATEGORIES = [
	["bug", "Bug"],
	["bad-result", "Bad result"],
	["good-result", "Good result"],
	["feature-request", "Feature request"],
	["performance", "Performance"],
	["other", "Other"],
] as const;

/** The app's feedback flow, using the existing account RPC. One dialog owns
 * one submission id so retrying a failed request cannot create a duplicate. */
export class FeedbackView {
	readonly el: HTMLDialogElement;
	readonly #api: CloudApi;
	readonly #close: () => void;
	readonly #id = crypto.randomUUID();
	readonly #details = h("textarea", {
		"aria-label": "Feedback details",
		maxlength: "10000",
		placeholder: "Share details (required)",
		required: true,
	});
	readonly #status = h("p", { class: "feedback-status", role: "status", "aria-live": "polite" });
	readonly #submit = h("button", { class: "feedback-submit", type: "submit", disabled: true }, "Submit");
	readonly #categories = h("fieldset", { class: "feedback-categories" }, h("legend", null, "Feedback category"));
	readonly #form: HTMLFormElement;
	readonly #closeButton: HTMLButtonElement;
	#category: string | undefined;
	#submitting = false;
	#disposed = false;
	#timer: ReturnType<typeof setTimeout> | undefined;

	constructor(api: CloudApi, close: () => void) {
		this.#api = api;
		this.#close = close;
		this.#closeButton = h(
			"button",
			{ class: "feedback-close", type: "button", "aria-label": "Close feedback", onclick: () => this.#dismiss() },
			"×",
		);
		for (const [value, label] of CATEGORIES) {
			const button = h(
				"button",
				{
					class: "feedback-category",
					type: "button",
					"aria-pressed": "false",
					onclick: () => {
						this.#category = this.#category === value ? undefined : value;
						for (const category of this.#categories.querySelectorAll("button"))
							category.setAttribute("aria-pressed", String(category === button && this.#category === value));
					},
				},
				`+ ${label}`,
			);
			this.#categories.append(button);
		}
		this.#form = h(
			"form",
			{
				class: "feedback-modal",
				onsubmit: (event: Event) => {
					event.preventDefault();
					void this.#send();
				},
			},
			h("header", null, h("h2", null, uiText("Share feedback")), this.#closeButton),
			h(
				"div",
				{ class: "feedback-body" },
				this.#categories,
				h("label", { class: "feedback-details-wrap" }, this.#details),
			),
			h("footer", null, this.#status, this.#submit),
		);
		this.el = h(
			"dialog",
			{ class: "feedback-dialog", "aria-label": "Share feedback", "aria-modal": "true" },
			this.#form,
		);
		this.#details.addEventListener("input", () => {
			this.#submit.disabled = this.#submitting || !this.#details.value.trim();
		});
		this.el.addEventListener("cancel", (event) => {
			event.preventDefault();
			this.#dismiss();
		});
		this.el.addEventListener("click", (event) => {
			if (event.target === this.el) this.#dismiss();
		});
		this.el.addEventListener("keydown", (event) => {
			if (matchesKey(event, "dismiss")) {
				event.preventDefault();
				event.stopPropagation();
				this.#dismiss();
			}
		});
	}

	open(): void {
		this.el.showModal();
		this.#details.focus();
	}
	#dismiss(): void {
		if (!this.#submitting && !this.#disposed) this.#close();
	}
	async #send(): Promise<void> {
		const details = this.#details.value.trim();
		if (this.#submitting || this.#disposed || !details || !this.#form.reportValidity()) return;
		this.#submitting = true;
		this.#form.setAttribute("aria-busy", "true");
		this.#categories.disabled = this.#details.disabled = this.#closeButton.disabled = this.#submit.disabled = true;
		this.#status.textContent = "";
		this.#status.removeAttribute("data-state");
		this.#submit.textContent = "Sending…";
		try {
			await this.#api.submitFeedback(this.#id, this.#category ?? "other", details);
			if (this.#disposed) return;
			this.#status.dataset.state = "success";
			this.#status.textContent = "Feedback sent. Thank you.";
			this.#submit.textContent = "Sent";
			this.#timer = setTimeout(() => {
				if (!this.#disposed) this.#close();
			}, 900);
		} catch (error) {
			if (this.#disposed) return;
			this.#submitting = false;
			this.#status.textContent = describeError(error);
			this.#submit.textContent = "Try again";
			this.#categories.disabled = this.#details.disabled = this.#closeButton.disabled = false;
			this.#submit.disabled = !this.#details.value.trim();
		} finally {
			if (!this.#disposed) this.#form.removeAttribute("aria-busy");
		}
	}
	dispose(): void {
		this.#disposed = true;
		clearTimeout(this.#timer);
		this.el.close();
		this.el.remove();
	}
}
