import {
	SESSION_EFFORTS,
	SESSION_MODEL_BEFORE_EFFORT,
	SESSION_MODELS,
	type SessionModel,
	type SessionModelSelection,
	type WebSessionModel,
} from "../../cloud/session-model.ts";
import { h, icon } from "../../ui/dom.ts";
import { phrase, t } from "../../ui/preferences.ts";
import type { CompanyController } from "../company.ts";

const EFFORT_NAMES: Record<(typeof SESSION_EFFORTS)[number], string> = {
	low: phrase("Low"),
	medium: phrase("Medium"),
	high: phrase("High"),
};

/** Conversation-scoped model and effort; the server pins them when admitting
 * the member's next run in this conversation. */
export class ComposerModels {
	readonly button: HTMLButtonElement;
	readonly el: HTMLElement;
	readonly #label = h("small");
	readonly #status = h("p", { class: "composer-model-status", role: "status" });
	readonly #refresh: HTMLButtonElement;
	readonly #choices: HTMLButtonElement[];
	readonly #efforts: HTMLButtonElement[];
	readonly #effortGroup: HTMLElement;
	readonly #company: CompanyController;
	readonly #sessionId: string;
	readonly #client: WebSessionModel | undefined;
	readonly #signal: AbortSignal;
	readonly #changed: () => void;
	#observed: SessionModel | undefined;
	#request: AbortController | undefined;
	#pending: SessionModelSelection | undefined;
	#pressed: HTMLButtonElement | undefined;
	#error = "";
	#started = false;
	#locked = true;

	constructor(
		company: CompanyController,
		sessionId: string,
		client: WebSessionModel | undefined,
		signal: AbortSignal,
		open: () => void,
		back: () => void,
		changed: () => void,
	) {
		this.#company = company;
		this.#sessionId = sessionId;
		this.#client = client;
		this.#signal = signal;
		this.#changed = changed;
		this.button = h(
			"button",
			{ type: "button", role: "menuitem", "aria-haspopup": "menu", "aria-expanded": "false", onclick: open },
			icon("brain"),
			h("span", { class: "composer-model-label" }, t("Model"), this.#label),
			icon("chevron"),
		);
		// Each choice saves only what it changes; the cloud keeps the other.
		this.#choices = SESSION_MODELS.map((model) => {
			const choice: HTMLButtonElement = h(
				"button",
				{
					type: "button",
					role: "menuitemradio",
					"aria-checked": "false",
					onclick: () => void this.#save({ modelId: model.id }, choice),
				},
				h("span", null, model.name),
				icon("check"),
			);
			return choice;
		});
		this.#efforts = SESSION_EFFORTS.map((effort) => {
			const choice: HTMLButtonElement = h(
				"button",
				{
					type: "button",
					role: "menuitemradio",
					"aria-checked": "false",
					onclick: () => void this.#save({ reasoningEffort: effort }, choice),
				},
				h("span", null, t(EFFORT_NAMES[effort])),
				icon("check"),
			);
			return choice;
		});
		this.#effortGroup = h(
			"div",
			{ class: "composer-model-group", role: "group", "aria-label": t("Effort"), hidden: true },
			h("p", { class: "composer-model-heading", "aria-hidden": "true" }, t("Effort")),
			...this.#efforts,
		);
		this.#refresh = h(
			"button",
			{ type: "button", role: "menuitem", hidden: true, onclick: () => void this.refresh() },
			t("Refresh model"),
		);
		this.el = h(
			"div",
			{ class: "composer-models", role: "menu", "aria-label": t("Model"), hidden: true },
			h("button", { type: "button", role: "menuitem", onclick: back }, icon("back"), t("Model")),
			...this.#choices,
			this.#effortGroup,
			h("p", { class: "composer-model-scope" }, t("Only this conversation. Applies from your next message.")),
			this.#status,
			this.#refresh,
		);
	}

	get pending(): boolean {
		return this.#pending !== undefined;
	}

	update(available: boolean, locked: boolean): void {
		if (this.#signal.aborted) return;
		this.#locked = locked;
		this.button.hidden = !available || !this.#client;
		const state = this.#company.store.get();
		if (
			!available ||
			state.accessLost ||
			!state.team?.capabilities.read ||
			(!state.team.capabilities.write && this.pending)
		) {
			this.#request?.abort();
			this.#request = undefined;
			this.#observed = undefined;
			this.#pending = undefined;
			this.#started = false;
			this.#error = "";
		}
		this.#render();
		// Avoid re-entering the parent's initial render.
		if (available && !state.accessLost && state.team?.capabilities.read && this.#client && !this.#started) {
			this.#started = true;
			queueMicrotask(() => void this.refresh());
		}
	}

	async refresh(): Promise<void> {
		if (!this.#client || this.#signal.aborted || this.#request || !this.#canRead()) return;
		const request = new AbortController();
		this.#request = request;
		const signal = AbortSignal.any([request.signal, this.#signal]);
		this.#error = "";
		this.#notify();
		try {
			const value = await this.#client.read(this.#sessionId, signal);
			signal.throwIfAborted();
			this.#observed = value;
			this.#pending = undefined;
		} catch {
			if (!signal.aborted) this.#error = t("The model is unavailable. Refresh to try again.");
		} finally {
			if (this.#request === request) {
				this.#request = undefined;
				this.#notify();
				if (!this.el.hidden && document.activeElement === this.el.firstElementChild) this.focus();
			}
		}
	}

	focus(): void {
		this.el.querySelector<HTMLButtonElement>('[aria-checked="true"]:not(:disabled)')?.focus();
		if (!this.el.contains(document.activeElement)) this.el.querySelector<HTMLButtonElement>("button")?.focus();
	}

	#canRead(): boolean {
		const state = this.#company.store.get();
		return (
			!state.accessLost &&
			state.team?.capabilities.read === true &&
			state.sessions.some((item) => item.sessionId === this.#sessionId)
		);
	}

	async #save(selection: SessionModelSelection, pressed: HTMLButtonElement): Promise<void> {
		if (
			!this.#client ||
			!this.#observed ||
			this.#request ||
			this.#error ||
			this.#signal.aborted ||
			this.button.disabled
		)
			return;
		const request = new AbortController();
		this.#request = request;
		const signal = AbortSignal.any([request.signal, this.#signal]);
		this.#pending = selection;
		this.#pressed = pressed;
		this.#notify();
		try {
			const value = await this.#client.set(this.#sessionId, selection, this.#observed.version, signal);
			signal.throwIfAborted();
			this.#observed = value;
			this.#pending = undefined;
		} catch {
			if (!signal.aborted) this.#error = t("The change could not be confirmed. Refresh the model before sending.");
		} finally {
			if (this.#request === request) {
				this.#request = undefined;
				this.#notify();
				// Focus returns to the choice the member pressed once it is usable again.
				if (!this.el.hidden && document.activeElement === this.el.firstElementChild) {
					if (this.#pressed && !this.#pressed.disabled) this.#pressed.focus();
					else this.focus();
				}
				this.#pressed = undefined;
			}
		}
	}

	#notify(): void {
		if (this.#signal.aborted) return;
		this.#render();
		this.#changed();
	}

	#render(): void {
		const focused = this.el.contains(document.activeElement) ? document.activeElement : null;
		const id = this.#observed?.modelId;
		const name = SESSION_MODELS.find((item) => item.id === id)?.name ?? id;
		const effortId = this.#observed?.reasoningEffort;
		const effort =
			effortId && Object.hasOwn(EFFORT_NAMES, effortId)
				? t(EFFORT_NAMES[effortId as keyof typeof EFFORT_NAMES])
				: effortId;
		const summary = name && effort ? `${name} · ${effort}` : name;
		this.button.disabled = this.#locked || !this.#canRead();
		this.#label.textContent = this.pending
			? this.#error
				? t("Change unconfirmed")
				: t("Saving…")
			: (summary ?? (this.#error ? t("Unavailable") : t("Loading…")));
		this.button.setAttribute(
			"aria-label",
			name
				? effort
					? t("Model: {name}, {effort} effort", { name, effort })
					: t("Model: {name}", { name })
				: t("Model"),
		);
		const unavailable = this.button.disabled || !this.#observed || Boolean(this.#request) || Boolean(this.#error);
		// A cloud that does not honour per-conversation effort omits it, and
		// accepts only GPT-6 Astra of the listed models. Hidden choices stay
		// disabled so arrow keys skip them.
		const beforeEffort = this.#observed !== undefined && effortId === undefined;
		for (const [index, choice] of this.#choices.entries()) {
			const model = SESSION_MODELS[index]?.id;
			choice.setAttribute("aria-checked", String(model === id));
			choice.disabled = unavailable || (beforeEffort && model !== SESSION_MODEL_BEFORE_EFFORT);
		}
		this.#effortGroup.hidden = effortId === undefined;
		for (const [index, choice] of this.#efforts.entries()) {
			choice.setAttribute("aria-checked", String(SESSION_EFFORTS[index] === effortId));
			choice.disabled = unavailable || this.#effortGroup.hidden;
		}
		this.#status.textContent =
			this.#error || (this.#request ? (this.pending ? t("Saving model…") : t("Loading model…")) : "");
		this.#refresh.hidden = !this.#error;
		this.#refresh.disabled = this.button.disabled || Boolean(this.#request);
		// Disabling a focused choice blurs it in browsers. Keep Escape and arrow
		// navigation inside the menu while the request is being confirmed.
		if (focused instanceof HTMLButtonElement && (focused.disabled || focused.hidden))
			this.el.querySelector<HTMLButtonElement>("button")?.focus();
	}
}
