import {
	DefaultModelsStaleError,
	DefaultModelsUnavailableError,
	defaultModelEfforts,
	type MemberDefaultModels,
	type WebDefaultModels,
} from "../../cloud/default-models.ts";
import { modelName, type SessionEffort } from "../../cloud/session-model.ts";
import { button, h, notice, replace } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";

function effortLabel(effort: SessionEffort): string {
	switch (effort) {
		case "low":
			return t("Low");
		case "medium":
			return t("Medium");
		case "high":
			return t("High");
		case "xhigh":
			return t("Extra high");
		case "max":
			return t("Max");
	}
}

function clampEffort(effort: SessionEffort, allowed: readonly SessionEffort[]): SessionEffort {
	if (allowed.includes(effort)) return effort;
	if (effort === "max" && allowed.includes("xhigh")) return "xhigh";
	return allowed[allowed.length - 1] ?? "high";
}

export class DefaultModelsView {
	readonly el = h("section", { class: "settings-group default-models-section" });
	readonly #client: WebDefaultModels;
	readonly #lifetime = new AbortController();
	#state: MemberDefaultModels | undefined;
	#loading = true;
	#loadError = false;
	#saving = false;
	#error: string | undefined;
	#status: string | undefined;

	constructor(client: WebDefaultModels, signal: AbortSignal) {
		this.#client = client;
		if (signal.aborted) {
			this.#lifetime.abort();
			return;
		}
		signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		this.#draw();
		void this.refresh();
	}

	dispose(): void {
		this.#lifetime.abort();
		this.el.replaceChildren();
		this.el.remove();
	}

	async refresh(): Promise<void> {
		if (this.#lifetime.signal.aborted) return;
		this.#loading = true;
		this.#loadError = false;
		if (!this.#state) this.#draw();
		try {
			const next = await this.#client.read(this.#lifetime.signal);
			if (this.#lifetime.signal.aborted) return;
			this.#state = next;
			this.#loadError = false;
		} catch {
			if (this.#lifetime.signal.aborted) return;
			this.#loadError = true;
		} finally {
			if (!this.#lifetime.signal.aborted) {
				this.#loading = false;
				this.#draw();
			}
		}
	}

	async #save(next: {
		conversationModel: string;
		conversationEffort: SessionEffort;
		codingModel: string;
		codingEffort: SessionEffort;
	}): Promise<void> {
		const current = this.#state;
		if (!current || this.#saving || this.#lifetime.signal.aborted) return;
		const conversationEffort = clampEffort(
			next.conversationEffort,
			defaultModelEfforts(current, next.conversationModel),
		);
		const codingEffort = clampEffort(next.codingEffort, defaultModelEfforts(current, next.codingModel));
		this.#saving = true;
		this.#error = undefined;
		this.#status = undefined;
		this.#draw();
		try {
			const saved = await this.#client.set(
				{
					conversationModel: next.conversationModel,
					conversationEffort,
					codingModel: next.codingModel,
					codingEffort,
					expectedVersion: current.version,
				},
				this.#lifetime.signal,
			);
			if (this.#lifetime.signal.aborted) return;
			this.#state = saved;
			this.#status = t("Default models saved.");
		} catch (error) {
			if (this.#lifetime.signal.aborted) return;
			if (error instanceof DefaultModelsStaleError) {
				this.#error = t("Default models changed elsewhere. Refreshed to latest.");
				this.#saving = false;
				await this.refresh();
				return;
			}
			if (error instanceof DefaultModelsUnavailableError) {
				this.#error = t("Connect that subscription below before choosing it as a default.");
				this.#saving = false;
				await this.refresh();
				return;
			}
			this.#error = t("Default models could not be saved. Try again.");
		} finally {
			if (!this.#lifetime.signal.aborted) {
				this.#saving = false;
				this.#draw();
			}
		}
	}

	#select(
		role: string,
		ariaLabel: string,
		options: readonly { value: string; label: string }[],
		selected: string,
		onChange: (value: string) => void,
	): HTMLSelectElement {
		const select = h(
			"select",
			{
				class: role.endsWith("-effort") ? "default-effort-select" : "default-model-select",
				"aria-label": ariaLabel,
				dataset: { role },
				disabled: this.#saving,
				onchange: (event: Event) => {
					onChange((event.currentTarget as HTMLSelectElement).value);
				},
			},
			...options.map((option) =>
				h("option", { value: option.value, selected: option.value === selected }, option.label),
			),
		);
		select.value = selected;
		return select;
	}

	#draw(): void {
		const heading = h(
			"div",
			{ class: "connection-section-heading" },
			h("h2", null, t("Default models")),
			this.#saving ? h("span", { class: "muted small", role: "status" }, t("Saving…")) : null,
		);
		const feedback = this.#error ? notice("danger", this.#error) : this.#status ? notice("ok", this.#status) : null;

		if (this.#loading && !this.#state) {
			replace(this.el, heading, h("p", { class: "connection-empty muted", role: "status" }, t("Checking…")));
			return;
		}
		if (this.#loadError && !this.#state) {
			replace(
				this.el,
				heading,
				h(
					"div",
					null,
					notice("danger", t("Your default models could not be read.")),
					button(t("Try again"), () => void this.refresh()),
				),
			);
			return;
		}

		const state = this.#state;
		if (!state) return;

		const convEfforts = defaultModelEfforts(state, state.conversationModel);
		const codingEfforts = defaultModelEfforts(state, state.codingModel);

		const convModelSelect = this.#select(
			"conversation-model",
			t("Conversational model"),
			state.conversationModels.map((id) => ({ value: id, label: modelName(id) })),
			state.conversationModel,
			(value) =>
				void this.#save({
					conversationModel: value,
					conversationEffort: state.conversationEffort,
					codingModel: state.codingModel,
					codingEffort: state.codingEffort,
				}),
		);
		const convEffortSelect = this.#select(
			"conversation-effort",
			t("Conversational effort"),
			convEfforts.map((effort) => ({ value: effort, label: effortLabel(effort) })),
			clampEffort(state.conversationEffort, convEfforts),
			(value) =>
				void this.#save({
					conversationModel: state.conversationModel,
					conversationEffort: value as SessionEffort,
					codingModel: state.codingModel,
					codingEffort: state.codingEffort,
				}),
		);
		const codingModelSelect = this.#select(
			"coding-model",
			t("Coding and working model"),
			state.codingModels.map((id) => ({ value: id, label: modelName(id) })),
			state.codingModel,
			(value) =>
				void this.#save({
					conversationModel: state.conversationModel,
					conversationEffort: state.conversationEffort,
					codingModel: value,
					codingEffort: state.codingEffort,
				}),
		);
		const codingEffortSelect = this.#select(
			"coding-effort",
			t("Coding and working effort"),
			codingEfforts.map((effort) => ({ value: effort, label: effortLabel(effort) })),
			clampEffort(state.codingEffort, codingEfforts),
			(value) =>
				void this.#save({
					conversationModel: state.conversationModel,
					conversationEffort: state.conversationEffort,
					codingModel: state.codingModel,
					codingEffort: value as SessionEffort,
				}),
		);

		const missingExtraProviders =
			!state.conversationModels.includes("gemini-4-neon") || !state.codingModels.includes("claude-opus-5-5");

		replace(
			this.el,
			heading,
			feedback,
			h(
				"div",
				{ class: "settings-rows default-models-card" },
				h(
					"div",
					{ class: "settings-preference-row default-model-row" },
					h(
						"div",
						{ class: "settings-copy" },
						h("strong", null, t("Conversational")),
						h("small", null, t("Default for chats and rooms without a chosen model.")),
					),
					h("div", { class: "default-model-controls" }, convModelSelect, convEffortSelect),
				),
				h(
					"div",
					{ class: "settings-preference-row default-model-row" },
					h(
						"div",
						{ class: "settings-copy" },
						h("strong", null, t("Coding & working")),
						h(
							"small",
							null,
							t("Default for background workers and coding sessions. Routines keep using your ChatGPT login."),
						),
					),
					h("div", { class: "default-model-controls" }, codingModelSelect, codingEffortSelect),
				),
			),
			missingExtraProviders
				? h(
						"p",
						{ class: "settings-help" },
						t("Connect Claude or add a Gemini API key below to choose their models here."),
					)
				: null,
		);
	}
}
