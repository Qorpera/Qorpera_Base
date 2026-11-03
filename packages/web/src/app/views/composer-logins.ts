import { h, icon } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import type { SessionExecutionView } from "./session-execution.ts";

/** Which of the member's own logins pays for their messages in this conversation: a page of the
 * composer's menu, drawn and driven as the Model page is (composer-models.ts). The logins, their names
 * and the move are SessionExecutionView's, so the page lists what "Choose a login to continue" lists and
 * a pick moves the conversation as a press there does. The row shows only when there is a choice (two or
 * more logins that can pay), and nothing moves without the member's pick. */
export class ComposerLogins {
	readonly button: HTMLButtonElement;
	readonly el: HTMLElement;
	readonly #label = h("small");
	readonly #back: HTMLButtonElement;
	readonly #list = h("div");
	readonly #scope = h("p", { class: "composer-model-scope" });
	readonly #status = h("p", { class: "composer-model-status", role: "status" });
	readonly #execution: SessionExecutionView;
	/** Each listed login's choice, by connection id, kept across updates. */
	readonly #choices = new Map<string, HTMLButtonElement>();
	/** The login whose choice had focus when it was disabled; focus goes back to it once it is usable. */
	#returnTo: string | undefined;

	constructor(execution: SessionExecutionView, open: () => void, back: () => void) {
		this.#execution = execution;
		this.button = h(
			"button",
			{
				type: "button",
				role: "menuitem",
				"aria-haspopup": "menu",
				"aria-expanded": "false",
				hidden: true,
				onclick: open,
			},
			icon("key"),
			h("span", { class: "composer-model-label" }, t("Login"), this.#label),
			icon("chevron"),
		);
		this.#back = h("button", { type: "button", role: "menuitem", onclick: back }, icon("back"), t("Login"));
		this.el = h(
			"div",
			{ class: "composer-models composer-logins", role: "menu", "aria-label": t("Login"), hidden: true },
			this.#back,
			this.#list,
			this.#scope,
			this.#status,
		);
	}

	/** Draws the logins as the conversation's account view has them now. `locked` adds the composer's
	 * own reasons (a submission being checked) to the view's. */
	update(group: boolean, locked: boolean): void {
		const focused = this.el.contains(document.activeElement) ? document.activeElement : null;
		const logins = this.#execution.logins;
		const disabled = locked || this.#execution.locked;
		const current = logins.find((login) => login.current);
		this.button.hidden = logins.length < 2;
		this.button.disabled = disabled;
		this.#label.textContent = current?.account ?? "";
		this.button.setAttribute(
			"aria-label",
			current ? t("Login: {account}", { account: current.account }) : t("Login"),
		);
		const scope = group
			? t("Pays for your messages in this group chat. Applies from your next message.")
			: t("Pays for your messages in this conversation. Applies from your next message.");
		if (this.#scope.textContent !== scope) this.#scope.textContent = scope;
		const status = this.#execution.error ?? "";
		if (this.#status.textContent !== status) this.#status.textContent = status;
		for (const [connectionId, choice] of this.#choices)
			if (!logins.some((login) => login.connectionId === connectionId)) {
				choice.remove();
				this.#choices.delete(connectionId);
			}
		const choices = logins.map((login) => {
			let choice = this.#choices.get(login.connectionId);
			if (!choice) {
				choice = h(
					"button",
					{
						type: "button",
						role: "menuitemradio",
						"aria-checked": "false",
						onclick: () => this.#pick(login.connectionId),
					},
					h("span"),
					icon("check"),
				);
				this.#choices.set(login.connectionId, choice);
			}
			const name = choice.firstElementChild!;
			if (name.textContent !== login.account) name.textContent = login.account;
			choice.setAttribute("aria-checked", String(login.current));
			choice.disabled = disabled;
			return choice;
		});
		if (
			choices.length !== this.#list.children.length ||
			choices.some((choice, i) => this.#list.children[i] !== choice)
		)
			this.#list.replaceChildren(...choices);
		// Disabling a focused choice blurs it in browsers: keep Escape and the arrows inside the page
		// meanwhile, and return to that choice once it is usable again.
		if (focused instanceof HTMLButtonElement && focused !== this.#back) {
			if (focused.disabled || !this.el.contains(focused)) {
				const login = [...this.#choices].find(([, choice]) => choice === focused)?.[0];
				if (login !== undefined) this.#returnTo = login;
				this.#back.focus();
			}
		} else if (this.#returnTo !== undefined && !disabled && document.activeElement === this.#back) {
			const choice = this.#choices.get(this.#returnTo);
			this.#returnTo = undefined;
			if (choice) choice.focus();
			else this.focus();
		}
	}

	focus(): void {
		this.#returnTo = undefined;
		this.el.querySelector<HTMLButtonElement>('[aria-checked="true"]:not(:disabled)')?.focus();
		if (!this.el.contains(document.activeElement)) this.#back.focus();
	}

	/** Only the member's pick moves the conversation; the login that pays already stays as it is. */
	#pick(connectionId: string): void {
		const login = this.#execution.logins.find((item) => item.connectionId === connectionId);
		if (!login || login.current || this.button.disabled) return;
		void this.#execution.pick(connectionId);
	}
}
