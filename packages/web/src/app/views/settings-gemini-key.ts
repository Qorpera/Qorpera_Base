import {
	formatUsdCents,
	formatUsdMicrodollars,
	GEMINI_MAX_CAP_CENTS,
	GEMINI_MIN_CAP_CENTS,
	type GeminiKeyErrorCode,
	type GeminiKeyErrorDetail,
	GeminiKeyInvalidError,
	GeminiKeyStaleError,
	type GeminiKeyState,
	geminiKeyLooksValid,
	type WebGeminiKey,
} from "../../cloud/gemini-key.ts";
import { button, fmtTime, h, notice, replace } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import { monthName } from "./settings-good-will.ts";

const GOOGLE_AI_STUDIO_SPEND_URL = "https://aistudio.google.com/spend";

function geminiErrorDetailMessage(detail: GeminiKeyErrorDetail): string {
	switch (detail) {
		case "free_tier_limit_zero":
			return t(
				"This key's Google project is on the Free Tier (quota limit 0). Gemini 4 Neon requires paid billing or claimed AI Ultra credits — claim your credits and link billing to this project in Google AI Studio, then click Check key.",
			);
		case "quota_limit_zero":
			return t(
				"Google returned a quota limit of 0 for Gemini 4 Neon on this key's project. Claim your AI Ultra credits or link a paid billing account to this project in Google AI Studio, then click Check key.",
			);
		case "billing_disabled":
			return t(
				"Google reported that billing or AI Ultra credits are not enabled for this key's project. Claim your monthly credits or enable billing in Google AI Studio, then click Check key.",
			);
		case "prepay_balance_empty":
			return t(
				"Google reported that this key's billing account has no prepay credit balance. Even when AI Ultra credits are claimed, Google AI Studio requires a prepay credit balance above $0 to resume service (eligible credits apply first). Top up in Google AI Studio Billing, then click Check key.",
			);
		case "spend_limit_reached":
			return t(
				"This key's Google AI Studio spending cap or credit balance was reached. Check your spend limit and credits in Google AI Studio.",
			);
		case "daily_quota_exhausted":
			return t(
				"This key's Google project reached its daily Gemini API quota. Check your usage tier in Google AI Studio or wait for the daily reset.",
			);
		case "rate_limited":
			return t(
				"Google temporarily rate-limited requests for this key's project. Wait a moment and try again, or check your rate limits in Google AI Studio.",
			);
		case "region_unsupported":
			return t("Google reported that the Gemini API is not available in this key's region.");
		case "service_disabled":
			return t(
				"The Generative Language API is disabled on this key's Google Cloud project. Enable it in Google Cloud or use a key from another project.",
			);
		case "api_key_expired":
			return t("This Gemini API key has expired. Create a new key in Google AI Studio and replace it here.");
		case "api_key_blocked":
			return t(
				"Google blocked this API key due to key restrictions. Allow the Generative Language API without referrer or IP restrictions in Google AI Studio, or replace the key here.",
			);
		case "api_key_invalid":
			return t("Google rejected this API key as invalid. Check it in Google AI Studio or replace it here.");
		case "model_not_found":
			return t("Google reported that Gemini 4 Neon is unavailable for this key.");
		case "overloaded":
			return t("Google's Gemini API is temporarily overloaded. Try again in a moment.");
	}
}

function geminiErrorMessage(code: GeminiKeyErrorCode, detail: GeminiKeyErrorDetail | null = null): string {
	if (detail) return geminiErrorDetailMessage(detail);
	switch (code) {
		case "billing_required":
			return t(
				"Google reported that billing or AI Ultra credits are not active for this key's project (Gemini 4 Neon requires paid billing, claimed credits, and a prepay balance above $0 in Google AI Studio). Check Billing in Google AI Studio, then click Check key.",
			);
		case "quota_exhausted":
			return t(
				"Google returned a quota or rate limit for this key's project. Check your rate limits and spend cap in Google AI Studio, or try again shortly.",
			);
		case "key_rejected":
			return t(
				"Google rejected this API key. Check that it is active and allowed to use the Generative Language API in Google AI Studio, or replace it here.",
			);
		case "model_unavailable":
			return t("Google reported that Gemini 4 Neon is unavailable for this key or region.");
		case "invalid_request":
			return t("Google rejected the last Gemini request made with this key.");
		case "provider_outage":
			return t("Google's Gemini API had a temporary server error on the last check or run.");
		case "transport_unavailable":
			return t("Qorpera could not reach Google's Gemini API on the last check or run.");
	}
}

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
	readonly #onChanged: (() => void) | undefined;
	readonly #lifetime = new AbortController();
	#state: GeminiKeyState | undefined;
	#loading = true;
	#loadError = false;
	#working: "save" | "settings" | "check" | "revoke" | undefined;
	#adding = false;
	#replacing = false;
	#keyDraft = "";
	#capDraft = "100";
	#error: string | undefined;
	#status: string | undefined;
	#lastErrorDetail: { readonly code: GeminiKeyErrorCode; readonly detail: GeminiKeyErrorDetail } | null = null;

	constructor(client: WebGeminiKey, signal: AbortSignal, onChanged?: () => void) {
		this.#client = client;
		this.#onChanged = onChanged;
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
			this.#lastErrorDetail = null;
			if (next.key) {
				this.#capDraft = formatCapInput(next.key.monthlyCapCents);
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
			this.#error = t("Enter a valid Gemini API key from Google AI Studio (starting with AQ. or AIza).");
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
		this.#working = "save";
		this.#error = undefined;
		this.#status = undefined;
		this.#draw();
		try {
			const next = await this.#client.save(
				{ apiKey, defaultForChats: false, monthlyCapCents },
				this.#lifetime.signal,
			);
			if (this.#lifetime.signal.aborted) return;
			this.#state = next;
			this.#lastErrorDetail = null;
			this.#keyDraft = "";
			this.#adding = false;
			this.#replacing = false;
			if (next.key) {
				this.#capDraft = formatCapInput(next.key.monthlyCapCents);
			}
			this.#onChanged?.();
			if (this.#client.check && next.key) {
				this.#working = "check";
				this.#draw();
				try {
					const checked = await this.#client.check(this.#lifetime.signal);
					if (this.#lifetime.signal.aborted) return;
					this.#state = checked.state;
					if (checked.ok) {
						this.#lastErrorDetail = null;
						this.#status = t("Gemini API key saved and verified for Gemini 4 Neon.");
					} else {
						this.#lastErrorDetail =
							checked.errorCode && checked.errorDetail
								? { code: checked.errorCode, detail: checked.errorDetail }
								: null;
					}
				} catch {
					if (this.#lifetime.signal.aborted) return;
					this.#status = t("Gemini API key saved.");
				}
			} else {
				this.#status = t("Gemini API key saved.");
			}
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

	async #updateSettings(monthlyCapCents: number | null, savedNotice: string): Promise<void> {
		const key = this.#state?.key;
		if (!key || this.#working || this.#lifetime.signal.aborted) return;
		this.#working = "settings";
		this.#error = undefined;
		this.#status = undefined;
		this.#draw();
		try {
			const next = await this.#client.updateSettings(
				{ defaultForChats: null, monthlyCapCents, expectedVersion: key.version },
				this.#lifetime.signal,
			);
			if (this.#lifetime.signal.aborted) return;
			this.#state = next;
			if (next.key) {
				this.#capDraft = formatCapInput(next.key.monthlyCapCents);
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

	async #checkKey(): Promise<void> {
		if (!this.#state?.key || !this.#client.check || this.#working || this.#lifetime.signal.aborted) return;
		this.#working = "check";
		this.#error = undefined;
		this.#status = undefined;
		this.#draw();
		try {
			const result = await this.#client.check(this.#lifetime.signal);
			if (this.#lifetime.signal.aborted) return;
			this.#state = result.state;
			if (result.ok) {
				this.#lastErrorDetail = null;
				this.#status = t("Key verified for Gemini 4 Neon. Ready to use.");
			} else {
				this.#lastErrorDetail =
					result.errorCode && result.errorDetail ? { code: result.errorCode, detail: result.errorDetail } : null;
			}
		} catch {
			if (this.#lifetime.signal.aborted) return;
			this.#error = t("The Gemini API key could not be checked. Try again.");
		} finally {
			if (!this.#lifetime.signal.aborted) {
				this.#working = undefined;
				this.#draw();
			}
		}
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
		await this.#updateSettings(parsed, t("Monthly spend cap saved."));
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
			this.#lastErrorDetail = null;
			this.#keyDraft = "";
			this.#adding = false;
			this.#replacing = false;
			this.#capDraft = "100";
			this.#status = t("Gemini API key removed.");
			this.#onChanged?.();
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
		const remainingMicrodollars =
			key.monthlyCapCents !== null ? Math.max(0, key.monthlyCapCents * 10_000 - key.monthSpendMicrodollars) : null;
		const remaining = remainingMicrodollars !== null ? formatUsdMicrodollars(remainingMicrodollars) : null;
		const percentRemaining =
			key.monthlyCapCents !== null && remainingMicrodollars !== null
				? Math.max(0, Math.min(100, Math.round((remainingMicrodollars / (key.monthlyCapCents * 10_000)) * 100)))
				: 0;
		const meterFill = h("span");
		meterFill.style.width = `${percentRemaining}%`;

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

		const checkButton = this.#client.check
			? button(this.#working === "check" ? t("Checking…") : t("Check key"), () => void this.#checkKey(), {
					disabled: busy,
				})
			: null;
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
		const billingLink = h(
			"a",
			{
				class: "gemini-billing-link",
				href: GOOGLE_AI_STUDIO_SPEND_URL,
				target: "_blank",
				rel: "noopener noreferrer",
			},
			t("Manage credits in Google AI Studio"),
		);
		const lastErrorCode = key.lastErrorCode ?? null;
		const activeDetail =
			lastErrorCode && this.#lastErrorDetail?.code === lastErrorCode ? this.#lastErrorDetail.detail : null;
		const healthNotice = lastErrorCode
			? notice(
					lastErrorCode === "key_rejected" ||
						lastErrorCode === "billing_required" ||
						lastErrorCode === "model_unavailable" ||
						activeDetail === "spend_limit_reached" ||
						activeDetail === "daily_quota_exhausted"
						? "danger"
						: "warn",
					key.lastErrorAt
						? t("{message} ({time})", {
								message: geminiErrorMessage(lastErrorCode, activeDetail),
								time: fmtTime(key.lastErrorAt),
							})
						: geminiErrorMessage(lastErrorCode, activeDetail),
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
					{ class: "connection-card", dataset: { geminiKeyId: key.id } },
					h("img", { class: "connection-logo", src: "./assets/provider-google.svg", alt: "" }),
					h(
						"div",
						{ class: "settings-copy" },
						h("strong", null, t("Gemini 4 Neon")),
						h("small", { class: "connection-email" }, t("Key {hint}", { hint: key.keyHint })),
						h(
							"small",
							{ class: "connection-scope" },
							key.lastCheckedAt && !lastErrorCode
								? t("Used in all your companies · Checked {time}", { time: fmtTime(key.lastCheckedAt) })
								: t("Used in all your companies"),
						),
					),
					h("div", { class: "connection-actions" }, checkButton, replaceButton, removeButton),
					h(
						"div",
						{ class: "connection-usage" },
						healthNotice,
						h(
							"div",
							{ class: "connection-usage-window" },
							h(
								"div",
								{ class: "connection-usage-heading" },
								h(
									"span",
									{ class: "connection-usage-label" },
									capLabel !== null
										? t("Tracked budget in {month}", { month: monthName(key.spendMonth) })
										: t("Spend in {month}", { month: monthName(key.spendMonth) }),
								),
								capLabel !== null && remaining !== null
									? key.capReached
										? h(
												"span",
												{ class: "connection-usage-limit" },
												t("{spent} of {cap} · Cap reached", { spent, cap: capLabel }),
											)
										: h(
												"span",
												null,
												t("{remaining} left of {cap} ({spent} spent)", {
													remaining,
													cap: capLabel,
													spent,
												}),
											)
									: h("span", null, t("{spent} · No monthly cap", { spent })),
							),
							capLabel !== null
								? h(
										"div",
										{
											class: `connection-usage-meter${percentRemaining <= 15 || key.capReached ? " is-low" : ""}`,
										},
										meterFill,
									)
								: null,
							h(
								"div",
								{ class: "gemini-credits-note" },
								h(
									"small",
									null,
									t(
										"Google does not expose AI Studio credit balances over the API, so Qorpera tracks spend made here.",
									),
								),
								" ",
								billingLink,
							),
						),
						key.capReached
							? notice("warn", t("Gemini conversations are paused until next month or until you raise the cap."))
							: null,
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
