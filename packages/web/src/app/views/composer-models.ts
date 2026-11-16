import {
	MODELS_BEFORE_LIST,
	modelName,
	modelProvider,
	PROVIDER_EFFORTS,
	type SESSION_EFFORTS,
	SESSION_MODEL_BEFORE_EFFORT,
	SESSION_MODELS,
	type SessionModel,
	type SessionModelSelection,
	type SessionProvider,
	type WebSessionModel,
} from "../../cloud/session-model.ts";
import { h, icon } from "../../ui/dom.ts";
import { phrase, presentationLocale, t } from "../../ui/preferences.ts";
import type { CompanyController } from "../company.ts";

const EFFORT_NAMES: Record<(typeof SESSION_EFFORTS)[number], string> = {
	low: phrase("Low"),
	medium: phrase("Medium"),
	high: phrase("High"),
	xhigh: phrase("Extra high"),
	max: phrase("Max"),
};

const PROVIDER_MARKS: Record<SessionProvider, string> = {
	openai: "./assets/provider-openai.svg",
	anthropic: "./assets/provider-claude.svg",
};

const EFFORT_SETTLE_MS = 450;

/** An effort's name in the interface language; one without a name here (xhigh, max) reads as its id. */
export function effortName(effort: string): string {
	return Object.hasOwn(EFFORT_NAMES, effort) ? t(EFFORT_NAMES[effort as keyof typeof EFFORT_NAMES]) : effort;
}

/** How much faster Fast runs each model, from the provider's model catalog. */
const FAST_SPEEDS: Record<string, number> = { "gpt-6-astra": 2, "gpt-6.1-sol": 2, "gpt-6-sol": 1.5, "gpt-6-luna": 1.5 };
const FAST_USES_MORE_OF_PLAN: ReadonlySet<string> = new Set(["gpt-6-astra", "gpt-6.1-sol"]);

/** The caption under the Fast switch for the conversation's model: "1.5x
 * speed", or "1,5x hastighed" in Danish. */
function fastCaption(modelId: string | undefined): string {
	const factor = modelId && Object.hasOwn(FAST_SPEEDS, modelId) ? FAST_SPEEDS[modelId] : undefined;
	if (!factor) return t("Faster replies");
	const speed = `${new Intl.NumberFormat(presentationLocale() === "da" ? "da-DK" : "en-GB").format(factor)}x`;
	return modelId !== undefined && FAST_USES_MORE_OF_PLAN.has(modelId)
		? t("{speed} speed, uses more of your plan", { speed })
		: t("{speed} speed", { speed });
}

export class ComposerModels {
	readonly button: HTMLButtonElement;
	readonly el: HTMLElement;
	readonly #label = h("small");
	readonly #status = h("p", { class: "composer-model-status", role: "status" });
	readonly #scope = h("p", { class: "composer-model-scope" });
	readonly #refresh: HTMLButtonElement;
	readonly #fast: HTMLButtonElement;
	readonly #title = h("p", { class: "composer-model-title", "aria-hidden": "true" });
	readonly #pick: HTMLButtonElement;
	readonly #pickName = h("span");
	readonly #provider: HTMLButtonElement;
	readonly #providerMark = h("span", { class: "composer-provider-mark" });
	readonly #list: HTMLElement;
	readonly #choices: HTMLButtonElement[];
	readonly #slider: HTMLElement;
	readonly #stops = h("span", { class: "composer-effort-stops" });
	readonly #company: CompanyController;
	readonly #sessionId: string;
	readonly #client: WebSessionModel | undefined;
	readonly #signal: AbortSignal;
	readonly #changed: () => void;
	#observed: SessionModel | undefined;
	#request: AbortController | undefined;
	#pending: SessionModelSelection | undefined;
	#pressed: HTMLElement | undefined;
	#listOpen = false;
	#sliding: number | undefined;
	#settle: ReturnType<typeof setTimeout> | undefined;
	#error = "";
	#started = false;
	#locked = true;
	#group = false;

	constructor(
		company: CompanyController,
		sessionId: string,
		client: WebSessionModel | undefined,
		signal: AbortSignal,
		open: () => void,
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
		this.#fast = h(
			"button",
			{
				type: "button",
				role: "menuitemcheckbox",
				"aria-checked": "false",
				"aria-label": t("Fast"),
				class: "composer-model-fast",
				onclick: () =>
					void this.#save(
						{ serviceTier: this.#observed?.serviceTier === "fast" ? "standard" : "fast" },
						this.#fast,
					),
			},
			icon("bolt"),
		);
		this.#pick = h(
			"button",
			{
				type: "button",
				role: "menuitem",
				class: "composer-model-pick",
				"aria-haspopup": "menu",
				"aria-expanded": "false",
				onclick: () => this.#toggleList(),
			},
			this.#pickName,
			icon("chevron"),
		);
		this.#provider = h(
			"button",
			{ type: "button", role: "menuitem", class: "composer-model-provider", onclick: () => this.#switchProvider() },
			this.#providerMark,
		);
		this.#choices = SESSION_MODELS.map((model) => {
			const choice: HTMLButtonElement = h(
				"button",
				{
					type: "button",
					role: "menuitemradio",
					class: "composer-model-choice",
					"aria-checked": "false",
					onclick: () => void this.#save(this.#selection(model.id), this.#pick),
				},
				h("span", null, model.name),
				icon("check"),
			);
			return choice;
		});
		this.#list = h(
			"div",
			{ class: "composer-model-list", role: "group", "aria-label": t("Models"), hidden: true },
			...this.#choices,
		);
		this.#slider = h(
			"div",
			{
				class: "composer-effort",
				role: "slider",
				tabindex: "0",
				"aria-label": t("Effort"),
				"aria-valuemin": "0",
				onkeydown: (event: KeyboardEvent) => this.#slideKey(event),
				onpointerdown: (event: PointerEvent) => this.#slideStart(event),
				onblur: () => this.#commitEffort(),
			},
			h("span", { class: "composer-effort-fill" }),
			this.#stops,
			h("span", { class: "composer-effort-thumb" }),
		);
		this.#refresh = h(
			"button",
			{ type: "button", role: "menuitem", hidden: true, onclick: () => void this.refresh() },
			t("Refresh model"),
		);
		this.el = h(
			"div",
			{
				class: "composer-models",
				role: "menu",
				tabindex: "-1",
				"aria-label": t("Model"),
				hidden: true,
				onkeydown: (event: KeyboardEvent) => {
					if (event.key !== "Escape" || !this.#listOpen) return;
					event.preventDefault();
					event.stopPropagation();
					this.#toggleList();
					this.#pick.focus();
				},
			},
			h(
				"div",
				{ class: "composer-model-top" },
				this.#fast,
				h("div", { class: "composer-model-center" }, this.#title, this.#pick),
				this.#provider,
			),
			this.#list,
			this.#slider,
			this.#scope,
			this.#status,
			this.#refresh,
		);
		signal.addEventListener("abort", () => clearTimeout(this.#settle), { once: true });
	}

	get pending(): boolean {
		return this.#pending !== undefined || this.#sliding !== undefined;
	}

	update(available: boolean, locked: boolean, group = false): void {
		if (this.#signal.aborted) return;
		this.#locked = locked;
		this.#group = group;
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
			this.#sliding = undefined;
			clearTimeout(this.#settle);
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
		this.#listOpen = false;
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
				if (!this.el.hidden && (document.activeElement === this.el || !this.el.contains(document.activeElement)))
					this.focus();
			}
		}
	}

	focus(): void {
		for (const control of [this.#slider, this.#pick, this.#refresh])
			if (!this.#unusable(control)) {
				control.focus();
				return;
			}
		this.el.focus();
	}

	#canRead(): boolean {
		const state = this.#company.store.get();
		return (
			!state.accessLost &&
			state.team?.capabilities.read === true &&
			state.sessions.some((item) => item.sessionId === this.#sessionId)
		);
	}

	#provided(): SessionProvider {
		return modelProvider(this.#observed?.modelId);
	}

	#accepted(): ReadonlySet<string> {
		if (this.#observed && this.#observed.reasoningEffort === undefined) return new Set([SESSION_MODEL_BEFORE_EFFORT]);
		return new Set(this.#observed?.models ?? MODELS_BEFORE_LIST);
	}

	#firstOf(provider: SessionProvider): string | undefined {
		const accepted = this.#accepted();
		return SESSION_MODELS.find((model) => model.provider === provider && accepted.has(model.id))?.id;
	}

	#toggleList(): void {
		this.#listOpen = !this.#listOpen;
		this.#render();
		if (this.#listOpen)
			(
				this.#choices.find((choice) => choice.getAttribute("aria-checked") === "true" && !choice.hidden) ??
				this.#choices.find((choice) => !choice.hidden && !choice.disabled)
			)?.focus();
	}

	#switchProvider(): void {
		const to: SessionProvider = this.#provided() === "openai" ? "anthropic" : "openai";
		const first = this.#firstOf(to);
		if (first) void this.#save(this.#selection(first), this.#provider);
	}

	#selection(modelId: string): SessionModelSelection {
		const effort = this.#observed?.reasoningEffort;
		const efforts: readonly string[] = PROVIDER_EFFORTS[modelProvider(modelId)];
		if (effort === undefined || efforts.includes(effort)) return { modelId };
		return { modelId, reasoningEffort: efforts[efforts.length - 1] };
	}

	#efforts(): readonly (typeof SESSION_EFFORTS)[number][] {
		return PROVIDER_EFFORTS[this.#provided()];
	}

	#slideKey(event: KeyboardEvent): void {
		const efforts = this.#efforts();
		const at = this.#sliding ?? efforts.indexOf(this.#observed?.reasoningEffort as (typeof efforts)[number]);
		const to =
			event.key === "ArrowLeft" || event.key === "PageDown"
				? at - 1
				: event.key === "ArrowRight" || event.key === "PageUp"
					? at + 1
					: event.key === "Home"
						? 0
						: event.key === "End"
							? efforts.length - 1
							: undefined;
		if (to === undefined) return;
		// WHY: the menu takes Left as "go back a page"; the slider's keys must not reach it.
		event.preventDefault();
		event.stopPropagation();
		if (this.#unusable(this.#slider)) return;
		this.#slide(Math.max(0, Math.min(efforts.length - 1, to)));
		clearTimeout(this.#settle);
		this.#settle = setTimeout(() => this.#commitEffort(), EFFORT_SETTLE_MS);
	}

	#slideStart(event: PointerEvent): void {
		if (event.button !== 0 || this.#unusable(this.#slider)) return;
		event.preventDefault();
		this.#slider.focus();
		const efforts = this.#efforts();
		const at = (x: number) => {
			const box = this.#slider.getBoundingClientRect();
			const inset = box.height / 2;
			const run = box.width - 2 * inset;
			const share = run > 0 ? (x - box.left - inset) / run : 0;
			return Math.max(0, Math.min(efforts.length - 1, Math.round(share * (efforts.length - 1))));
		};
		this.#slider.classList.add("is-dragging");
		this.#slider.setPointerCapture?.(event.pointerId);
		this.#slide(at(event.clientX));
		const move = (next: PointerEvent) => this.#slide(at(next.clientX));
		const end = () => {
			this.#slider.removeEventListener("pointermove", move);
			this.#slider.removeEventListener("pointerup", end);
			this.#slider.removeEventListener("pointercancel", end);
			this.#slider.classList.remove("is-dragging");
			this.#commitEffort();
		};
		this.#slider.addEventListener("pointermove", move);
		this.#slider.addEventListener("pointerup", end);
		this.#slider.addEventListener("pointercancel", end);
	}

	#slide(index: number): void {
		if (this.#sliding === index) return;
		this.#sliding = index;
		this.#notify();
	}

	#commitEffort(): void {
		clearTimeout(this.#settle);
		this.#settle = undefined;
		const index = this.#sliding;
		if (index === undefined) return;
		this.#sliding = undefined;
		const effort = this.#efforts()[index];
		if (!effort || effort === this.#observed?.reasoningEffort) {
			this.#notify();
			return;
		}
		void this.#save({ reasoningEffort: effort }, this.#slider);
	}

	async #save(selection: SessionModelSelection, pressed: HTMLElement): Promise<void> {
		if (
			!this.#client ||
			!this.#observed ||
			this.#request ||
			this.#error ||
			this.#signal.aborted ||
			this.button.disabled
		) {
			this.#notify();
			return;
		}
		const request = new AbortController();
		this.#request = request;
		const signal = AbortSignal.any([request.signal, this.#signal]);
		this.#pending = selection;
		this.#pressed = pressed;
		if (selection.modelId !== undefined) this.#listOpen = false;
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
				if (!this.el.hidden && (!this.el.contains(document.activeElement) || document.activeElement === this.el)) {
					if (this.#pressed && !this.#unusable(this.#pressed)) this.#pressed.focus();
					else this.focus();
				}
				this.#pressed = undefined;
			}
		}
	}

	#unusable(control: HTMLElement): boolean {
		if (control.hidden || control.closest("[hidden]")) return true;
		return control instanceof HTMLButtonElement ? control.disabled : control.getAttribute("aria-disabled") === "true";
	}

	#notify(): void {
		if (this.#signal.aborted) return;
		this.#render();
		this.#changed();
	}

	#render(): void {
		const focused = this.el.contains(document.activeElement) ? document.activeElement : null;
		const id = this.#observed?.modelId;
		// A group chat with no model chosen runs each agent on its own model; nothing is ticked.
		const name = id ? modelName(id) : this.#observed ? t("Each agent's own") : undefined;
		const effortId = this.#observed?.reasoningEffort;
		const effort = effortId && effortName(effortId);
		const tier = this.#observed?.serviceTier;
		const fast = tier === "fast";
		const provided = this.#provided();
		const summary = name && [name, effort, provided === "openai" && fast && t("Fast")].filter(Boolean).join(" · ");
		this.button.disabled = this.#locked || !this.#canRead();
		this.#label.textContent = this.pending
			? this.#error
				? t("Change unconfirmed")
				: t("Saving…")
			: (summary ?? (this.#error ? t("Unavailable") : t("Loading…")));
		const described = name
			? effort
				? t("Model: {name}, {effort} effort", { name, effort })
				: t("Model: {name}", { name })
			: t("Model");
		this.button.setAttribute(
			"aria-label",
			name && fast && provided === "openai" ? t("{model}, Fast", { model: described }) : described,
		);
		const unavailable = this.button.disabled || !this.#observed || Boolean(this.#request) || Boolean(this.#error);

		this.#fast.hidden = tier === undefined || provided !== "openai";
		this.#fast.setAttribute("aria-checked", String(fast));
		this.#fast.disabled = unavailable || this.#fast.hidden;
		this.#fast.title = fast ? `${t("Fast")}: ${fastCaption(id)}` : t("Fast");

		this.#pickName.textContent = name ?? (this.#error ? t("Unavailable") : t("Loading…"));
		this.#pick.disabled = unavailable;
		if (this.#pick.disabled) this.#listOpen = false;
		this.#pick.setAttribute("aria-expanded", String(this.#listOpen));
		this.#pick.setAttribute("aria-label", name ? t("Choose model ({name})", { name }) : t("Choose model"));

		const other: SessionProvider = provided === "openai" ? "anthropic" : "openai";
		const switchable = this.#firstOf(other) !== undefined;
		this.#provider.hidden = !switchable && provided !== "anthropic";
		this.#provider.disabled = unavailable || this.#provider.hidden || !switchable;
		const switchTo = other === "anthropic" ? t("Switch to Claude") : t("Switch to GPT");
		this.#provider.setAttribute("aria-label", switchTo);
		this.#provider.title =
			provided === "anthropic"
				? `${switchTo}. ${t("GPT answers light messages. Claude Code does the work, on your Claude plan.")}`
				: switchTo;
		this.#providerMark.className = `composer-provider-mark composer-provider-${provided}`;
		this.#providerMark.style.setProperty("mask-image", `url("${PROVIDER_MARKS[provided]}")`);
		this.#providerMark.style.setProperty("-webkit-mask-image", `url("${PROVIDER_MARKS[provided]}")`);

		const accepted = this.#accepted();
		this.#list.hidden = !this.#listOpen;
		for (const [index, choice] of this.#choices.entries()) {
			const model = SESSION_MODELS[index]!;
			choice.hidden = model.provider !== provided || !accepted.has(model.id);
			choice.setAttribute("aria-checked", String(model.id === id));
			choice.disabled = unavailable || choice.hidden || this.#list.hidden;
		}

		const efforts = this.#efforts();
		const pendingAt =
			this.#pending?.reasoningEffort !== undefined && this.#pending.modelId === undefined
				? efforts.indexOf(this.#pending.reasoningEffort as (typeof efforts)[number])
				: -1;
		const at = this.#sliding ?? (pendingAt >= 0 ? pendingAt : efforts.indexOf(effortId as (typeof efforts)[number]));
		const share = at >= 0 && efforts.length > 1 ? at / (efforts.length - 1) : 0;
		const atName = at >= 0 ? effortName(efforts[at]!) : (effort ?? "");
		this.#title.textContent = atName;
		this.#title.hidden = effortId === undefined;
		this.#slider.hidden = effortId === undefined;
		if (this.#stops.childElementCount !== efforts.length)
			this.#stops.replaceChildren(
				...efforts.map((_, index) => {
					const stop = h("i");
					stop.style.setProperty("--stop", String(efforts.length > 1 ? index / (efforts.length - 1) : 0));
					return stop;
				}),
			);
		for (const [index, stop] of [...this.#stops.children].entries()) stop.classList.toggle("is-on", index <= at);
		this.#slider.style.setProperty("--at", String(share));
		this.#slider.classList.toggle("is-unset", at < 0);
		this.#slider.setAttribute("aria-valuemax", String(efforts.length - 1));
		this.#slider.setAttribute("aria-valuenow", String(Math.max(0, at)));
		this.#slider.setAttribute("aria-valuetext", atName);
		this.#slider.setAttribute(
			"aria-disabled",
			String((unavailable && this.#sliding === undefined) || this.#slider.hidden),
		);
		this.#slider.tabIndex = this.#slider.hidden ? -1 : 0;

		const scope = this.#group ? t("Every agent in this group chat. Applies from your next message.") : "";
		if (this.#scope.textContent !== scope) this.#scope.textContent = scope;
		this.#status.textContent =
			this.#error || (this.#request ? (this.#pending ? t("Saving model…") : t("Loading model…")) : "");
		this.#refresh.hidden = !this.#error;
		this.#refresh.disabled = this.button.disabled || Boolean(this.#request);
		// Disabling a focused choice blurs it in browsers. Keep Escape and arrow
		// navigation inside the menu while the request is being confirmed.
		if (focused instanceof HTMLElement && focused !== this.el && this.#unusable(focused)) {
			if (this.#request) this.el.focus();
			else this.focus();
		}
	}
}
