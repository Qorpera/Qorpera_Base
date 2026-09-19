import { SESSION_MODELS, type SessionModel, type WebSessionModel } from "../../cloud/session-model.ts";
import { h, icon } from "../../ui/dom.ts";
import type { CompanyController } from "../company.ts";

/** Conversation-scoped choices; the server pins them when admitting new runs. */
export class ComposerModels {
	readonly button: HTMLButtonElement;
	readonly el: HTMLElement;
	readonly #label = h("small");
	readonly #status = h("p", { class: "composer-model-status", role: "status" });
	readonly #refresh: HTMLButtonElement;
	readonly #choices: HTMLButtonElement[];
	readonly #company: CompanyController;
	readonly #sessionId: string;
	readonly #client: WebSessionModel | undefined;
	readonly #signal: AbortSignal;
	readonly #changed: () => void;
	#observed: SessionModel | undefined;
	#request: AbortController | undefined;
	#pendingModel: string | undefined;
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
			h("span", { class: "composer-model-label" }, "Model", this.#label),
			icon("chevron"),
		);
		this.#choices = SESSION_MODELS.map((model) =>
			h(
				"button",
				{
					type: "button",
					role: "menuitemradio",
					"aria-checked": "false",
					onclick: () => void this.#save(model.id),
				},
				h("span", null, model.name),
				icon("check"),
			),
		);
		this.#refresh = h(
			"button",
			{ type: "button", role: "menuitem", hidden: true, onclick: () => void this.refresh() },
			"Refresh model",
		);
		this.el = h(
			"div",
			{ class: "composer-models", role: "menu", "aria-label": "Model", hidden: true },
			h("button", { type: "button", role: "menuitem", onclick: back }, icon("back"), "Model"),
			...this.#choices,
			h("p", { class: "composer-model-scope" }, "Only this conversation. Applies to new Codex runs. Low effort."),
			this.#status,
			this.#refresh,
		);
	}

	get pending(): boolean {
		return this.#pendingModel !== undefined;
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
			this.#pendingModel = undefined;
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
			this.#pendingModel = undefined;
		} catch {
			if (!signal.aborted) this.#error = "The model is unavailable. Refresh to try again.";
		} finally {
			if (this.#request === request) {
				this.#request = undefined;
				this.#notify();
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

	async #save(modelId: string): Promise<void> {
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
		this.#pendingModel = modelId;
		this.#notify();
		try {
			const value = await this.#client.set(this.#sessionId, modelId, this.#observed.version, signal);
			signal.throwIfAborted();
			this.#observed = value;
			this.#pendingModel = undefined;
		} catch {
			if (!signal.aborted) this.#error = "The change could not be confirmed. Refresh the model before sending.";
		} finally {
			if (this.#request === request) {
				this.#request = undefined;
				this.#notify();
			}
		}
	}

	#notify(): void {
		if (this.#signal.aborted) return;
		this.#render();
		this.#changed();
	}

	#render(): void {
		const id = this.#observed?.modelId;
		const name = SESSION_MODELS.find((item) => item.id === id)?.name ?? id;
		this.button.disabled = this.#locked || !this.#canRead();
		this.#label.textContent = this.pending
			? this.#error
				? "Change unconfirmed"
				: "Saving…"
			: (name ?? (this.#error ? "Unavailable" : "Loading…"));
		this.button.setAttribute("aria-label", name ? `Model: ${name}` : "Model");
		for (const [index, choice] of this.#choices.entries()) {
			choice.setAttribute("aria-checked", String(SESSION_MODELS[index]?.id === id));
			choice.disabled = this.button.disabled || !this.#observed || Boolean(this.#request) || Boolean(this.#error);
		}
		this.#status.textContent =
			this.#error || (this.#request ? (this.pending ? "Saving model…" : "Loading model…") : "");
		this.#refresh.hidden = !this.#error;
		this.#refresh.disabled = this.button.disabled || Boolean(this.#request);
	}
}
