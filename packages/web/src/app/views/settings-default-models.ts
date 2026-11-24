import {
	DefaultModelsStaleError,
	DefaultModelsUnavailableError,
	defaultModelEfforts,
	defaultVoiceProfiles,
	type MemberDefaultModels,
	voiceModelName,
	type WebDefaultModels,
} from "../../cloud/default-models.ts";
import { modelName, modelProvider, type SessionEffort } from "../../cloud/session-model.ts";
import { button, h, notice, replace } from "../../ui/dom.ts";
import { phrase, t } from "../../ui/preferences.ts";

const GEMINI_VOICE_TONES: Readonly<Record<string, string>> = {
	Charon: phrase("Informative"),
	Kore: phrase("Firm"),
	Puck: phrase("Upbeat"),
	Zephyr: phrase("Bright"),
	Aoede: phrase("Breezy"),
	Fenrir: phrase("Excitable"),
	Leda: phrase("Youthful"),
	Orus: phrase("Firm"),
	Callirrhoe: phrase("Easy-going"),
	Autonoe: phrase("Bright"),
	Enceladus: phrase("Breathy"),
	Iapetus: phrase("Clear"),
	Umbriel: phrase("Easy-going"),
	Algieba: phrase("Smooth"),
	Despina: phrase("Smooth"),
	Erinome: phrase("Clear"),
	Algenib: phrase("Gravelly"),
	Rasalgethi: phrase("Informative"),
	Laomedeia: phrase("Upbeat"),
	Achernar: phrase("Soft"),
	Alnilam: phrase("Firm"),
	Schedar: phrase("Even"),
	Gacrux: phrase("Mature"),
	Pulcherrima: phrase("Direct"),
	Achird: phrase("Friendly"),
	Zubenelgenubi: phrase("Casual"),
	Vindemiatrix: phrase("Gentle"),
	Sadachbia: phrase("Lively"),
	Sadaltager: phrase("Knowledgeable"),
	Sulafat: phrase("Warm"),
};

const CHATGPT_VOICE_LABELS: Readonly<Record<string, string>> = {
	cove: "Cove",
	juniper: "Juniper",
	maple: "Maple",
	spruce: "Spruce",
	ember: "Ember",
	vale: "Vale",
	breeze: "Breeze",
	arbor: "Arbor",
	sol: "Sol",
};

function voiceProfileLabel(voiceName: string): string {
	const tone = GEMINI_VOICE_TONES[voiceName];
	if (tone) return `${voiceName} — ${t(tone)}`;
	return CHATGPT_VOICE_LABELS[voiceName] ?? voiceName;
}

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

function clampVoice(voice: string | null, allowed: readonly string[]): string {
	if (voice && allowed.includes(voice)) return voice;
	return allowed[0] ?? voice ?? "";
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

	async #save(patch: {
		conversationModel?: string;
		conversationEffort?: SessionEffort;
		codingModel?: string;
		codingEffort?: SessionEffort;
		voiceModel?: string;
		voiceName?: string;
	}): Promise<void> {
		const current = this.#state;
		if (!current || this.#saving || this.#lifetime.signal.aborted) return;
		this.#saving = true;
		this.#error = undefined;
		this.#status = undefined;
		this.#draw();
		try {
			const saved = await this.#client.set(
				{
					...patch,
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
		options: readonly { value: string; label: string; disabled?: boolean }[],
		selected: string,
		onChange: (value: string) => void,
	): HTMLSelectElement {
		const select = h(
			"select",
			{
				class: role.endsWith("-effort") || role === "voice-name" ? "default-effort-select" : "default-model-select",
				"aria-label": ariaLabel,
				dataset: { role },
				disabled: this.#saving,
				onchange: (event: Event) => {
					onChange((event.currentTarget as HTMLSelectElement).value);
				},
			},
			...options.map((option) =>
				h(
					"option",
					{ value: option.value, selected: option.value === selected, disabled: option.disabled === true },
					option.label,
				),
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

		const convModels = state.conversationModels.filter((id) => modelProvider(id) !== "anthropic");
		const convUnavailable =
			state.storedConversationModel !== null && !convModels.includes(state.storedConversationModel);
		const codingUnavailable =
			state.storedCodingModel !== null && !state.codingModels.includes(state.storedCodingModel);
		const shownConvModel = convUnavailable
			? state.storedConversationModel!
			: modelProvider(state.conversationModel) === "anthropic"
				? (convModels[0] ?? "gpt-6.2-sol")
				: state.conversationModel;
		const shownCodingModel = codingUnavailable ? state.storedCodingModel! : state.codingModel;

		const convEfforts = defaultModelEfforts(
			state,
			"conversation",
			modelProvider(shownConvModel) === "anthropic" ? (convModels[0] ?? "gpt-6.2-sol") : shownConvModel,
		);
		const codingEfforts = defaultModelEfforts(state, "coding", shownCodingModel);

		const convModelOptions: { value: string; label: string; disabled?: boolean }[] = [
			...(convUnavailable
				? [
						{
							value: state.storedConversationModel!,
							label: t("{model} (unavailable here)", { model: modelName(state.storedConversationModel!) }),
							disabled: true,
						},
					]
				: []),
			...convModels.map((id) => ({ value: id, label: modelName(id) })),
		];
		const codingModelOptions: { value: string; label: string; disabled?: boolean }[] = [
			...(codingUnavailable
				? [
						{
							value: state.storedCodingModel!,
							label: t("{model} (unavailable here)", { model: modelName(state.storedCodingModel!) }),
							disabled: true,
						},
					]
				: []),
			...state.codingModels.map((id) => ({ value: id, label: modelName(id) })),
		];

		const convModelSelect = this.#select(
			"conversation-model",
			t("Conversational model"),
			convModelOptions,
			shownConvModel,
			(value) => {
				const allowed = defaultModelEfforts(state, "conversation", value);
				const clamped = clampEffort(state.conversationEffort, allowed);
				void this.#save(
					clamped !== state.conversationEffort
						? { conversationModel: value, conversationEffort: clamped }
						: { conversationModel: value },
				);
			},
		);
		const convEffortSelect = this.#select(
			"conversation-effort",
			t("Conversational effort"),
			convEfforts.map((effort) => ({ value: effort, label: effortLabel(effort) })),
			clampEffort(state.conversationEffort, convEfforts),
			(value) => {
				void this.#save({ conversationEffort: value as SessionEffort });
			},
		);
		const codingModelSelect = this.#select(
			"coding-model",
			t("Coding and working model"),
			codingModelOptions,
			shownCodingModel,
			(value) => {
				const allowed = defaultModelEfforts(state, "coding", value);
				const clamped = clampEffort(state.codingEffort, allowed);
				void this.#save(
					clamped !== state.codingEffort ? { codingModel: value, codingEffort: clamped } : { codingModel: value },
				);
			},
		);
		const codingEffortSelect = this.#select(
			"coding-effort",
			t("Coding and working effort"),
			codingEfforts.map((effort) => ({ value: effort, label: effortLabel(effort) })),
			clampEffort(state.codingEffort, codingEfforts),
			(value) => {
				const effort = value as SessionEffort;
				void this.#save(
					(effort === "xhigh" || effort === "max") && state.storedCodingModel === null
						? { codingModel: state.codingModel, codingEffort: effort }
						: { codingEffort: effort },
				);
			},
		);

		const voiceUnavailable = state.storedVoiceModel !== null && !state.voiceModels.includes(state.storedVoiceModel);
		const shownVoiceModel = voiceUnavailable ? state.storedVoiceModel! : state.voiceModel;
		const voiceProfiles = defaultVoiceProfiles(state, shownVoiceModel);
		const currentVoice =
			voiceUnavailable && state.storedVoiceName !== null
				? clampVoice(state.storedVoiceName, voiceProfiles)
				: clampVoice(state.voiceName, voiceProfiles);
		const voiceModelOptions: { value: string; label: string; disabled?: boolean }[] = [
			...(voiceUnavailable
				? [
						{
							value: state.storedVoiceModel!,
							label: t("{model} (unavailable here)", { model: voiceModelName(state.storedVoiceModel!) }),
							disabled: true,
						},
					]
				: []),
			...state.voiceModels.map((id) => ({ value: id, label: voiceModelName(id) })),
		];
		const voiceProfileOptions = voiceProfiles.map((profile) => ({
			value: profile,
			label: voiceProfileLabel(profile),
		}));
		const voiceModelSelect = this.#select(
			"voice-model",
			t("Voice model"),
			voiceModelOptions,
			shownVoiceModel,
			(value) => {
				const allowed = defaultVoiceProfiles(state, value);
				const nextVoice = clampVoice(currentVoice, allowed);
				void this.#save(
					nextVoice && nextVoice !== currentVoice
						? { voiceModel: value, voiceName: nextVoice }
						: { voiceModel: value },
				);
			},
		);
		const voiceNameSelect = this.#select(
			"voice-name",
			t("Voice profile"),
			voiceProfileOptions,
			currentVoice,
			(value) => {
				void this.#save(
					state.storedVoiceModel === null
						? { voiceModel: state.voiceModel, voiceName: value }
						: { voiceName: value },
				);
			},
		);
		const voiceRow = h(
			"div",
			{ class: "settings-preference-row default-model-row" },
			h(
				"div",
				{ class: "settings-copy" },
				h("strong", null, t("Voice")),
				h("small", null, t("Default model and voice profile for narrated Studio breakdowns.")),
			),
			h("div", { class: "default-model-controls" }, voiceModelSelect, voiceNameSelect),
		);

		const missingExtraProviders =
			!convModels.includes("gemini-4-neon") || !state.codingModels.includes("claude-opus-5-5");

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
				voiceRow,
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
