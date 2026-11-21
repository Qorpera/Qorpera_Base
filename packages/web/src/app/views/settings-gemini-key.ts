import {
	formatUsdCents,
	formatUsdMicrodollars,
	GEMINI_MAX_CAP_CENTS,
	GEMINI_MIN_CAP_CENTS,
	GeminiKeyInvalidError,
	GeminiKeyStaleError,
	type GeminiKeyState,
	geminiKeyLooksValid,
	type WebGeminiKey,
} from "../../cloud/gemini-key.ts";
import { button, h, notice, replace } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import { monthName } from "./settings-good-will.ts";

function parseCapDollars(raw: string): number | null | "invalid" {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	if (!/^\d+(?:\.\d{1,2})?$/.test(trimmed)) return "invalid";
	const [whole, frac = ""] = trimmed.split(".");
	const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
	if (!Number.isSafeInteger(cents) || cents < GEMINI_MIN_CAP_CENTS || cents > GEMINI_MAX_CAP_CENTS) {
		return "invalid";
	}
	return cents;
}

function formatCapInput(cents: number | null): string {
	if (cents === null) return "";
	return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

export class GeminiKeyView {
	readonly el = h("section", { class: "settings-group gemini-key-section" });
	readonly #client: WebGeminiKey;
	readonly #lifetime = new AbortController();
	#state: GeminiKeyState | undefined;
	#loading = true;
	#loadError = false;
	#working: "save" | "settings" | "revoke" | undefined;
	#adding = false;
	#replacing = false;
	#keyDraft = "";
	#capDraft = "100";
	#defaultDraft = false;
	#error: string | undefined;
	#status: string | undefined;

	constructor(client: WebGeminiKey, signal: AbortSignal) {
		this.#client = client;
		if (signal.aborted) {
			this.#lifetime.abort();
			return;
		}
		signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		this.#draw();
		void this.#refresh();
	}

	dispose(): void {
		this.#lifetime.abort();
		this.#keyDraft = "";
		this.el.replaceChildren();
		this.el.remove();
	}

	async #refresh(): Promise<void> {
		if (this.#lifetime.signal.aborted) return;
		this.#loading = true;
		this.#loadError = false;
		this.#draw();
		try {
			const next = await this.#client.read(this.#lifetime.signal);
			if (this.#lifetime.signal.aborted) return;
			this.#state = next;
			if (next.key) {
				this.#capDraft = formatCapInput(next.key.monthlyCapCents);
				this.#defaultDraft = next.key.defaultForChats;
			}
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

	async #saveNewKey(): Promise<void> {
		if (this.#working || this.#lifetime.signal.aborted) return;
		const apiKey = this.#keyDraft.trim();
		if (!geminiKeyLooksValid(apiKey)) {
			this.#error = t("Enter a valid Gemini API key starting with AIza.");
			this.#status = undefined;
			this.#draw();
			return;
		}
		const existing = this.#state?.key;
		const monthlyCapCents = existing ? existing.monthlyCapCents : parseCapDollars(this.#capDraft);
		if (monthlyCapCents === "invalid") {
			this.#error = t("Enter a monthly cap between $1 and $100,000, or leave it blank for no limit.");
			this.#status = undefined;
			this.#draw();
			return;
		}
		const defaultForChats = existing ? existing.defaultForChats : this.#defaultDraft;
		this.#working = "save";
		this.#error = undefined;
		this.#status = undefined;
		this.#draw();
		try {
			const next = await this.#client.save({ apiKey, defaultForChats, monthlyCapCents }, this.#lifetime.signal);
			if (this.#lifetime.signal.aborted) return;
			this.#state = next;
			this.#keyDraft = "";
			this.#adding = false;
			this.#replacing = false;
			if (next.key) {
				this.#capDraft = formatCapInput(next.key.monthlyCapCents);
				this.#defaultDraft = next.key.defaultForChats;
			}
			this.#status = t("Gemini API key saved.");
		} catch (error) {
			if (this.#lifetime.signal.aborted) return;
			this.#error =
				error instanceof GeminiKeyInvalidError
					? t("Google did not accept that API key. Check it and try again.")
					: t("The Gemini API key could not be saved. Try again.");
		} finally {
			if (!this.#lifetime.signal.aborted) {
				this.#working = undefined;
				this.#draw();
			}
		}
	}

	async #updateSettings(defaultForChats: boolean, monthlyCapCents: number | null, savedNotice: string): Promise<void> {
		const key = this.#state?.key;
		if (!key || this.#working || this.#lifetime.signal.aborted) return;
		this.#working = "settings";
		this.#error = undefined;
		this.#status = undefined;
		this.#draw();
		try {
			const next = await this.#client.updateSettings(
				{ defaultForChats, monthlyCapCents, expectedVersion: key.version },
				this.#lifetime.signal,
			);
			if (this.#lifetime.signal.aborted) return;
			this.#state = next;
			if (next.key) {
				this.#capDraft = formatCapInput(next.key.monthlyCapCents);
				this.#defaultDraft = next.key.defaultForChats;
			}
			this.#status = savedNotice;
		} catch (error) {
			if (this.#lifetime.signal.aborted) return;
			if (error instanceof GeminiKeyStaleError) {
				this.#error = t("Gemini settings changed elsewhere. Refresh and try again.");
				this.#working = undefined;
				await this.#refresh();
				return;
			}
			this.#error = t("Gemini settings could not be saved. Try again.");
		} finally {
			if (!this.#lifetime.signal.aborted) {
				this.#working = undefined;
				this.#draw();
			}
		}
	}

	async #toggleDefault(): Promise<void> {
		const key = this.#state?.key;
		if (!key) return;
		const nextDefault = !key.defaultForChats;
		await this.#updateSettings(
			nextDefault,
			key.monthlyCapCents,
			nextDefault
				? t("Gemini 4 Neon is now the default for your chats.")
				: t("Gemini 4 Neon is no longer the default for your chats."),
		);
	}

	async #saveCap(): Promise<void> {
		const key = this.#state?.key;
		if (!key) return;
		const parsed = parseCapDollars(this.#capDraft);
		if (parsed === "invalid") {
			this.#error = t("Enter a monthly cap between $1 and $100,000, or leave it blank for no limit.");
			this.#status = undefined;
			this.#draw();
			return;
		}
		await this.#updateSettings(key.defaultForChats, parsed, t("Monthly spend cap saved."));
	}

	async #revoke(): Promise<void> {
		if (!this.#state?.key || this.#working || this.#lifetime.signal.aborted) return;
		this.#working = "revoke";
		this.#error = undefined;
		this.#status = undefined;
		this.#draw();
		try {
			const next = await this.#client.revoke(this.#lifetime.signal);
			if (this.#lifetime.signal.aborted) return;
			this.#state = next;
			this.#keyDraft = "";
			this.#adding = false;
			this.#replacing = false;
			this.#capDraft = "100";
			this.#defaultDraft = false;
			this.#status = t("Gemini API key removed.");
		} catch {
			if (this.#lifetime.signal.aborted) return;
			this.#error = t("The Gemini API key could not be removed. Try again.");
		} finally {
			if (!this.#lifetime.signal.aborted) {
				this.#working = undefined;
				this.#draw();
			}
		}
	}

	#keyForm(isReplace: boolean): HTMLElement {
		const busy = Boolean(this.#working);
		const keyInput = h("input", {
			type: "password",
			class: "service-token",
			autocomplete: "off",
			spellcheck: "false",
			placeholder: t("Paste your Gemini API key"),
			"aria-label": t("Gemini API key"),
			value: this.#keyDraft,
			disabled: busy,
			oninput: (event: Event) => {
				this.#keyDraft = (event.currentTarget as HTMLInputElement).value;
			},
		});
		const capInput = isReplace
			? null
			: h("input", {
					type: "number",
					class: "gemini-cap-input",
					min: "1",
					max: "100000",
					step: "0.01",
					placeholder: t("No limit"),
					"aria-label": t("Monthly spend cap (USD)"),
					value: this.#capDraft,
					disabled: busy,
					oninput: (event: Event) => {
						this.#capDraft = (event.currentTarget as HTMLInputElement).value;
					},
				});
		const defaultCheck = isReplace
			? null
			: h(
					"label",
					{ class: "gemini-default-option" },
					h("input", {
						type: "checkbox",
						checked: this.#defaultDraft,
						disabled: busy,
						onchange: (event: Event) => {
							this.#defaultDraft = (event.currentTarget as HTMLInputElement).checked;
						},
					}),
					h("span", null, t("Use Gemini 4 Neon by default for my chats")),
				);
		const saveButton = h(
			"button",
			{ type: "submit", class: "btn btn-primary", disabled: busy },
			this.#working === "save" ? t("Saving…") : t("Save key"),
		);
		const cancelButton = button(
			t("Cancel"),
			() => {
				this.#keyDraft = "";
				this.#adding = false;
				this.#replacing = false;
				this.#error = undefined;
				this.#draw();
			},
			{ disabled: busy },
		);
		return h(
			"form",
			{
				class: "service-token-form gemini-key-form",
				onsubmit: (event: SubmitEvent) => {
					event.preventDefault();
					void this.#saveNewKey();
				},
			},
			h("div", { class: "service-token-row" }, keyInput),
			capInput
				? h("label", { class: "gemini-cap-field" }, h("span", null, t("Monthly spend cap (USD)")), capInput)
				: null,
			defaultCheck,
			h("div", { class: "hook-form-actions" }, saveButton, cancelButton),
			h(
				"small",
				null,
				t(
					"Encrypted in the shared vault. Qorpera verifies the key with Google before saving and never shows it again.",
				),
			),
		);
	}

	#draw(): void {
		const heading = h("div", { class: "connection-section-heading" }, h("h2", null, t("Gemini API key")));
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
					notice("danger", t("Your Gemini API key could not be read.")),
					button(t("Try again"), () => void this.#refresh()),
				),
			);
			return;
		}

		const state = this.#state;
		if (!state) return;
		const key = state.key;

		if (!key) {
			const addButton =
				state.vaultAvailable && !this.#adding
					? button(
							t("Add API key"),
							() => {
								this.#adding = true;
								this.#capDraft = "100";
								this.#defaultDraft = false;
								this.#keyDraft = "";
								this.#error = undefined;
								this.#status = undefined;
								this.#draw();
							},
							{ primary: true },
						)
					: null;
			replace(
				this.el,
				heading,
				feedback,
				h(
					"div",
					{ class: "connection-list" },
					h(
						"article",
						{ class: "connection-card" },
						h("img", { class: "connection-logo", src: "./assets/provider-google.svg", alt: "" }),
						h(
							"div",
							{ class: "settings-copy" },
							h("strong", null, t("Gemini 4 Neon")),
							h(
								"small",
								null,
								state.vaultAvailable
									? t(
											"Use your own Gemini API key (including AI Ultra API credits) for conversations in all your companies. Background work and routines keep using your other logins.",
										)
									: t("Gemini API keys are not available in this company yet."),
							),
						),
						addButton ? h("div", { class: "connection-actions" }, addButton) : null,
						state.vaultAvailable && this.#adding ? this.#keyForm(false) : null,
					),
				),
			);
			return;
		}

		const busy = Boolean(this.#working);
		const spent = formatUsdMicrodollars(key.monthSpendMicrodollars);
		const capLabel = key.monthlyCapCents !== null ? formatUsdCents(key.monthlyCapCents) : null;
		const percentUsed =
			key.monthlyCapCents !== null
				? Math.min(100, Math.round((key.monthSpendMicrodollars / (key.monthlyCapCents * 10_000)) * 100))
				: 0;
		const meterFill = h("span");
		meterFill.style.width = `${percentUsed}%`;

		const defaultSwitch = h("button", {
			type: "button",
			role: "switch",
			class: "routine-switch",
			"aria-checked": String(key.defaultForChats),
			"aria-label": t("Use Gemini 4 Neon by default for my chats"),
			onclick: () => void this.#toggleDefault(),
		});
		if (busy) defaultSwitch.setAttribute("aria-disabled", "true");

		const currentCapText = formatCapInput(key.monthlyCapCents);
		const capSaveButton = h(
			"button",
			{ type: "submit", class: "btn", disabled: busy || this.#capDraft.trim() === currentCapText },
			t("Save"),
		);
		const capInput = h("input", {
			type: "number",
			class: "gemini-cap-input",
			min: "1",
			max: "100000",
			step: "0.01",
			placeholder: t("No limit"),
			"aria-label": t("Monthly spend cap (USD)"),
			value: this.#capDraft,
			disabled: busy,
			oninput: (event: Event) => {
				this.#capDraft = (event.currentTarget as HTMLInputElement).value;
				capSaveButton.disabled = busy || this.#capDraft.trim() === currentCapText;
			},
		});

		const replaceButton = button(
			t("Replace key"),
			() => {
				this.#replacing = !this.#replacing;
				this.#keyDraft = "";
				this.#error = undefined;
				this.#status = undefined;
				this.#draw();
			},
			{ disabled: busy },
		);
		const removeButton = button(
			this.#working === "revoke" ? t("Removing…") : t("Remove key"),
			() => void this.#revoke(),
			{ danger: true, disabled: busy },
		);

		replace(
			this.el,
			heading,
			feedback,
			h(
				"div",
				{ class: "connection-list" },
				h(
					"article",
					{ class: "connection-card", dataset: { geminiKeyId: key.id } },
					h("img", { class: "connection-logo", src: "./assets/provider-google.svg", alt: "" }),
					h(
						"div",
						{ class: "settings-copy" },
						h("strong", null, t("Gemini 4 Neon")),
						h("small", { class: "connection-email" }, t("Key {hint}", { hint: key.keyHint })),
						h("small", { class: "connection-scope" }, t("Used in all your companies")),
					),
					h("div", { class: "connection-actions" }, replaceButton, removeButton),
					h(
						"div",
						{ class: "connection-usage" },
						h(
							"div",
							{ class: "connection-usage-window" },
							h(
								"div",
								{ class: "connection-usage-heading" },
								h(
									"span",
									{ class: "connection-usage-label" },
									t("Spend in {month}", { month: monthName(key.spendMonth) }),
								),
								capLabel !== null
									? key.capReached
										? h(
												"span",
												{ class: "connection-usage-limit" },
												t("{spent} of {cap} · Cap reached", { spent, cap: capLabel }),
											)
										: h("span", null, t("{spent} of {cap}", { spent, cap: capLabel }))
									: h("span", null, t("{spent} · No monthly cap", { spent })),
							),
							capLabel !== null
								? h(
										"div",
										{
											class: `connection-usage-meter${percentUsed >= 85 || key.capReached ? " is-low" : ""}`,
										},
										meterFill,
									)
								: null,
						),
						key.capReached
							? notice("warn", t("Gemini conversations are paused until next month or until you raise the cap."))
							: null,
					),
					h(
						"div",
						{ class: "connection-away" },
						h(
							"div",
							{ class: "settings-copy" },
							h("strong", null, t("Use Gemini 4 Neon by default for my chats")),
							h(
								"small",
								null,
								t(
									"New conversations without a chosen model use Gemini 4 Neon. Background workers and routines keep using your other logins.",
								),
							),
						),
						defaultSwitch,
					),
					h(
						"form",
						{
							class: "connection-away gemini-cap-row",
							onsubmit: (event: SubmitEvent) => {
								event.preventDefault();
								void this.#saveCap();
							},
						},
						h(
							"div",
							{ class: "settings-copy" },
							h("strong", null, t("Monthly spend cap (USD)")),
							h(
								"small",
								null,
								t(
									"Leave empty for no cap. Conversations pause instead of switching to another account when the cap is reached.",
								),
							),
						),
						h("div", { class: "gemini-cap-controls" }, capInput, capSaveButton),
					),
					this.#replacing ? this.#keyForm(true) : null,
				),
			),
		);
	}
}
