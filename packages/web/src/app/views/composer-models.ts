import {
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

const PROVIDERS: ReadonlyArray<{ id: SessionProvider; name: string; mark: string }> = [
	{ id: "openai", name: "GPT", mark: "./assets/provider-openai.svg" },
	{ id: "anthropic", name: "Claude", mark: "./assets/provider-claude.svg" },
];

const EFFORT_SETTLE_MS = 450;

/** An effort's name in the interface language; one without a name here (xhigh, max) reads as its id. */
export function effortName(effort: string): string {
	return Object.hasOwn(EFFORT_NAMES, effort) ? t(EFFORT_NAMES[effort as keyof typeof EFFORT_NAMES]) : effort;
}

/** How much faster Fast runs each model, from the provider's model catalog. */
const FAST_SPEEDS: Record<string, number> = { "gpt-6-astra": 2, "gpt-6-sol": 1.5, "gpt-6-luna": 1.5 };

/** The caption under the Fast switch for the conversation's model: "1.5x
 * speed", or "1,5x hastighed" in Danish. */
function fastCaption(modelId: string | undefined): string {
	const factor = modelId && Object.hasOwn(FAST_SPEEDS, modelId) ? FAST_SPEEDS[modelId] : undefined;
	if (!factor) return t("Faster replies");
	const speed = `${new Intl.NumberFormat(presentationLocale() === "da" ? "da-DK" : "en-GB").format(factor)}x`;
	// The catalog lists Astra's Fast tier as using more of the plan.
	return modelId === "gpt-6-astra"
		? t("{speed} speed, uses more of your plan", { speed })
		: t("{speed} speed", { speed });
}

export class ComposerModels {
	readonly button: HTMLButtonElement;
	readonly el: HTMLElement;
	readonly #label = h("small");
	readonly #status = h("p", { class: "composer-model-status", role: "status" });
	readonly #scope = h("p", { class: "composer-model-scope" });
	readonly #back: HTMLButtonElement;
	readonly #refresh: HTMLButtonElement;
	readonly #providerGroup: HTMLElement;
	readonly #providers: HTMLButtonElement[];
	readonly #choices: HTMLButtonElement[];
	readonly #pickNote = h("p", { class: "composer-model-note" });
	readonly #claudeNote: HTMLElement;
	readonly #effortGroup: HTMLElement;
	readonly #effortValue = h("span", { class: "composer-effort-value" });
	readonly #slider: HTMLElement;
	readonly #fast: HTMLButtonElement;
	readonly #fastCaption = h("small");
	readonly #speedGroup: HTMLElement;
	readonly #company: CompanyController;
	readonly #sessionId: string;
	readonly #client: WebSessionModel | undefined;
	readonly #signal: AbortSignal;
	readonly #changed: () => void;
	#observed: SessionModel | undefined;
	#request: AbortController | undefined;
	#pending: SessionModelSelection | undefined;
	#pressed: HTMLElement | undefined;
	#viewing: SessionProvider | undefined;
	#sliding: number | undefined;
	#settle: ReturnType<typeof setTimeout> | undefined;
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
		this.#back = h("button", { type: "button", role: "menuitem", onclick: back }, icon("back"), t("Model"));
		this.#providers = PROVIDERS.map((provider) => {
			const mark = h("span", { class: `composer-provider-mark composer-provider-${provider.id}` });
			mark.style.setProperty("mask-image", `url("${provider.mark}")`);
			mark.style.setProperty("-webkit-mask-image", `url("${provider.mark}")`);
			return h(
				"button",
				{
					type: "button",
					role: "menuitemradio",
					"aria-checked": "false",
					"aria-label": provider.name,
					title: provider.name,
					onclick: () => this.#view(provider.id),
				},
				mark,
			);
		});
		this.#providerGroup = h(
			"div",
			{ class: "composer-provider", role: "group", "aria-label": t("Provider"), hidden: true },
			...this.#providers,
		);
		this.#choices = SESSION_MODELS.map((model) => {
			const choice: HTMLButtonElement = h(
				"button",
				{
					type: "button",
					role: "menuitemradio",
					class: "composer-model-choice",
					"aria-checked": "false",
					onclick: () => void this.#save(this.#pick(model.id), choice),
				},
				h("span", null, model.name),
				icon("check"),
			);
			return choice;
		});
		this.#claudeNote = h(
			"p",
			{ class: "composer-model-note", hidden: true },
			t("GPT answers light messages. Claude Code does the work, on your Claude plan."),
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
			h("span", { class: "composer-effort-track" }, h("span", { class: "composer-effort-fill" })),
			h("span", { class: "composer-effort-stops" }),
			h("span", { class: "composer-effort-thumb" }),
		);
		this.#effortGroup = h(
			"div",
			{ class: "composer-model-group", role: "group", "aria-label": t("Effort"), hidden: true },
			h(
				"p",
				{ class: "composer-model-heading composer-effort-head", "aria-hidden": "true" },
				h("span", null, t("Effort")),
				this.#effortValue,
			),
			this.#slider,
		);
		// Fast is on unless this conversation turned it off.
		this.#fast = h(
			"button",
			{
				type: "button",
				role: "menuitemcheckbox",
				"aria-checked": "false",
				class: "composer-model-fast",
				onclick: () =>
					void this.#save(
						{ serviceTier: this.#observed?.serviceTier === "fast" ? "standard" : "fast" },
						this.#fast,
					),
			},
			h("span", { class: "composer-model-label" }, t("Fast"), this.#fastCaption),
			h("span", { class: "composer-switch", "aria-hidden": "true" }),
		);
		this.#speedGroup = h(
			"div",
			{ class: "composer-model-group", role: "group", "aria-label": t("Speed"), hidden: true },
			h("p", { class: "composer-model-heading", "aria-hidden": "true" }, t("Speed")),
			this.#fast,
		);
		this.#refresh = h(
			"button",
			{ type: "button", role: "menuitem", hidden: true, onclick: () => void this.refresh() },
			t("Refresh model"),
		);
		this.el = h(
			"div",
			{ class: "composer-models", role: "menu", "aria-label": t("Model"), hidden: true },
			h("div", { class: "composer-model-head" }, this.#back, this.#providerGroup),
			...this.#choices,
			this.#pickNote,
			this.#claudeNote,
			this.#effortGroup,
			this.#speedGroup,
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
		const scope = group
			? t("Every agent in this group chat. Applies from your next message.")
			: t("Only this conversation. Applies from your next message.");
		if (this.#scope.textContent !== scope) this.#scope.textContent = scope;
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
		this.#viewing = undefined;
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
				if (!this.el.hidden && document.activeElement === this.#back) this.focus();
			}
		}
	}

	focus(): void {
		this.el.querySelector<HTMLButtonElement>('.composer-model-choice[aria-checked="true"]:not(:disabled)')?.focus();
		if (!this.el.contains(document.activeElement))
			this.el.querySelector<HTMLButtonElement>(".composer-model-choice:not(:disabled)")?.focus();
		if (!this.el.contains(document.activeElement)) this.#back.focus();
	}

	#canRead(): boolean {
		const state = this.#company.store.get();
		return (
			!state.accessLost &&
			state.team?.capabilities.read === true &&
			state.sessions.some((item) => item.sessionId === this.#sessionId)
		);
	}

	#saved(): SessionProvider {
		return modelProvider(this.#observed?.modelId);
	}

	#shown(): SessionProvider {
		return this.#viewing ?? this.#saved();
	}

	#view(provider: SessionProvider): void {
		if (this.#shown() === provider) return;
		this.#viewing = provider === this.#saved() ? undefined : provider;
		this.#render();
		this.#providers[PROVIDERS.findIndex((item) => item.id === provider)]?.focus();
	}

	#pick(modelId: string): SessionModelSelection {
		const effort = this.#observed?.reasoningEffort;
		const efforts: readonly string[] = PROVIDER_EFFORTS[modelProvider(modelId)];
		if (effort === undefined || efforts.includes(effort)) return { modelId };
		return { modelId, reasoningEffort: efforts[efforts.length - 1] };
	}

	#efforts(): readonly (typeof SESSION_EFFORTS)[number][] {
		return PROVIDER_EFFORTS[this.#saved()];
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
		if (this.#slider.getAttribute("aria-disabled") === "true") return;
		this.#slide(Math.max(0, Math.min(efforts.length - 1, to)));
		clearTimeout(this.#settle);
		this.#settle = setTimeout(() => this.#commitEffort(), EFFORT_SETTLE_MS);
	}

	#slideStart(event: PointerEvent): void {
		if (event.button !== 0 || this.#slider.getAttribute("aria-disabled") === "true") return;
		event.preventDefault();
		this.#slider.focus();
		const efforts = this.#efforts();
		const at = (x: number) => {
			const box = this.#slider.getBoundingClientRect();
			const share = box.width ? (x - box.left) / box.width : 0;
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
		this.#notify();
		try {
			const value = await this.#client.set(this.#sessionId, selection, this.#observed.version, signal);
			signal.throwIfAborted();
			this.#observed = value;
			this.#pending = undefined;
			if (selection.modelId !== undefined) this.#viewing = undefined;
		} catch {
			if (!signal.aborted) this.#error = t("The change could not be confirmed. Refresh the model before sending.");
		} finally {
			if (this.#request === request) {
				this.#request = undefined;
				this.#notify();
				// Focus returns to the choice the member pressed once it is usable again.
				if (!this.el.hidden && document.activeElement === this.#back) {
					if (this.#pressed && !this.#unusable(this.#pressed)) this.#pressed.focus();
					else this.focus();
				}
				this.#pressed = undefined;
			}
		}
	}

	#unusable(control: HTMLElement): boolean {
		return control instanceof HTMLButtonElement
			? control.disabled || control.hidden
			: control.getAttribute("aria-disabled") === "true";
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
		const name = id
			? (SESSION_MODELS.find((item) => item.id === id)?.name ?? id)
			: this.#observed
				? t("Each agent's own")
				: undefined;
		const effortId = this.#observed?.reasoningEffort;
		const effort = effortId && effortName(effortId);
		const tier = this.#observed?.serviceTier;
		const fast = tier === "fast";
		const saved = this.#saved();
		const shown = this.#shown();
		const summary = name && [name, effort, saved === "openai" && fast && t("Fast")].filter(Boolean).join(" · ");
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
			name && fast && saved === "openai" ? t("{model}, Fast", { model: described }) : described,
		);
		const unavailable = this.button.disabled || !this.#observed || Boolean(this.#request) || Boolean(this.#error);
		const offered = new Set<SessionProvider>(["openai", ...(this.#observed?.providers ?? [])]);
		this.#providerGroup.hidden = !offered.has("anthropic") && saved !== "anthropic";
		for (const [index, choice] of this.#providers.entries()) {
			const provider = PROVIDERS[index]!.id;
			choice.setAttribute("aria-checked", String(provider === shown));
			choice.disabled = unavailable || this.#providerGroup.hidden || !offered.has(provider);
		}
		// A cloud that does not honour per-conversation effort omits it, and
		// accepts only GPT-6 Astra of the listed models. Hidden choices stay
		// disabled so arrow keys skip them.
		const beforeEffort = this.#observed !== undefined && effortId === undefined;
		for (const [index, choice] of this.#choices.entries()) {
			const model = SESSION_MODELS[index]!;
			choice.hidden = model.provider !== shown;
			choice.setAttribute("aria-checked", String(model.id === id));
			choice.disabled =
				unavailable ||
				choice.hidden ||
				!offered.has(model.provider) ||
				(beforeEffort && model.id !== SESSION_MODEL_BEFORE_EFFORT);
		}
		const elsewhere = shown !== saved;
		const backToGpt = elsewhere && shown === "openai";
		this.#pickNote.hidden = !backToGpt;
		this.#pickNote.textContent = backToGpt ? t("Pick a GPT model to switch this conversation back to GPT.") : "";
		this.#claudeNote.hidden = shown !== "anthropic";
		this.#effortGroup.hidden = effortId === undefined || elsewhere;
		const efforts = this.#efforts();
		const savedAt = efforts.indexOf(effortId as (typeof efforts)[number]);
		const at = this.#sliding ?? this.#pendingEffortAt(efforts) ?? savedAt;
		const stops = this.#slider.querySelector<HTMLElement>(".composer-effort-stops")!;
		if (stops.childElementCount !== efforts.length)
			stops.replaceChildren(
				...efforts.map((_, index) => {
					const stop = h("i");
					stop.style.setProperty("--stop", String(efforts.length > 1 ? index / (efforts.length - 1) : 0));
					return stop;
				}),
			);
		this.#slider.style.setProperty("--at", String(at >= 0 && efforts.length > 1 ? at / (efforts.length - 1) : 0));
		this.#slider.classList.toggle("is-unset", at < 0);
		this.#slider.setAttribute("aria-valuemax", String(efforts.length - 1));
		this.#slider.setAttribute("aria-valuenow", String(Math.max(0, at)));
		const atName = at >= 0 ? effortName(efforts[at]!) : (effort ?? "");
		this.#slider.setAttribute("aria-valuetext", atName);
		this.#effortValue.textContent = atName;
		const sliderOff = (unavailable && this.#sliding === undefined) || this.#effortGroup.hidden;
		this.#slider.setAttribute("aria-disabled", String(sliderOff));
		this.#slider.tabIndex = this.#effortGroup.hidden ? -1 : 0;
		// A cloud that does not run conversations on the Fast tier omits the
		// speed; an unfamiliar tier reads as off and can be switched on.
		this.#speedGroup.hidden = tier === undefined || saved !== "openai" || elsewhere;
		this.#fast.setAttribute("aria-checked", String(fast));
		this.#fast.disabled = unavailable || this.#speedGroup.hidden;
		this.#fastCaption.textContent = fastCaption(id);
		this.#status.textContent =
			this.#error || (this.#request ? (this.#pending ? t("Saving model…") : t("Loading model…")) : "");
		this.#refresh.hidden = !this.#error;
		this.#refresh.disabled = this.button.disabled || Boolean(this.#request);
		// Disabling a focused choice blurs it in browsers. Keep Escape and arrow
		// navigation inside the menu while the request is being confirmed.
		if (
			(focused instanceof HTMLButtonElement && (focused.disabled || focused.hidden)) ||
			(focused === this.#slider && this.#effortGroup.hidden)
		)
			this.#back.focus();
	}

	#pendingEffortAt(efforts: readonly string[]): number | undefined {
		const effort = this.#pending?.reasoningEffort;
		if (effort === undefined || this.#pending?.modelId !== undefined) return undefined;
		const index = efforts.indexOf(effort);
		return index < 0 ? undefined : index;
	}
}
