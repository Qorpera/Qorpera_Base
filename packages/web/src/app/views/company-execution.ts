import type { CompanyExecutionState, WebCompanyExecution } from "../../cloud/company-execution.ts";
import { button, h, notice, replace } from "../../ui/dom.ts";

function dollars(microusd: number): string {
	const value = BigInt(microusd);
	const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
	return `${value / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}

/** Human controls for the cloud-owned company brake and admission limits. */
export class CompanyExecutionView {
	readonly el = h("section", { class: "settings-group company-execution" });
	readonly #control: Pick<WebCompanyExecution, "read" | "setPause" | "setCeiling">;
	readonly #canManage: () => boolean;
	readonly #lifetime = new AbortController();
	readonly #status = h("div", { role: "status" });
	readonly #feedback = h("div");
	readonly #spend = h("input", {
		type: "text",
		maxlength: "30",
		inputmode: "decimal",
		"aria-label": "Monthly spend ceiling (USD)",
	});
	readonly #tokens = h("input", {
		type: "text",
		maxlength: "16",
		inputmode: "numeric",
		"aria-label": "Monthly token ceiling",
	});
	readonly #wakes = h("input", {
		type: "text",
		maxlength: "7",
		inputmode: "numeric",
		"aria-label": "Autonomous wakes per hour",
	});
	readonly #reason = h("input", {
		type: "text",
		maxlength: "1024",
		"aria-label": "Company pause or resume reason",
		placeholder: "Reason (optional)",
	});
	readonly #refresh: HTMLButtonElement;
	readonly #pause: HTMLButtonElement;
	readonly #save: HTMLButtonElement;
	readonly #role = h("p", { class: "muted" });
	#state: CompanyExecutionState | undefined;
	#request: AbortController | undefined;
	#busy = false;
	#uncertain = false;
	#mutating = false;
	#message: string | undefined;

	constructor(
		control: Pick<WebCompanyExecution, "read" | "setPause" | "setCeiling">,
		signal: AbortSignal,
		canManage: () => boolean,
	) {
		this.#control = control;
		this.#canManage = canManage;
		this.#refresh = button("Refresh company execution", () => void this.refresh(), { small: true });
		this.#pause = button("Pause company execution", () => void this.#setPause(), { danger: true });
		this.#save = button("Save execution ceilings", () => void this.#saveCeilings(), { primary: true });
		this.el.append(
			h("h2", null, "Company execution"),
			h(
				"p",
				{ class: "muted" },
				"Pausing blocks new company work and fences running work. Resuming allows new work again.",
			),
			this.#status,
			this.#feedback,
			this.#role,
			h("div", { class: "row" }, this.#pause, this.#reason),
			h("h3", null, "Execution ceilings"),
			h(
				"p",
				{ class: "muted" },
				"Monthly spend and token limits apply to API-billed execution. Subscription accounts also retain their provider limits.",
			),
			h("label", { class: "field" }, "Monthly spend ceiling (USD)", this.#spend),
			h("label", { class: "field" }, "Monthly token ceiling", this.#tokens),
			h("label", { class: "field" }, "Autonomous wakes per hour", this.#wakes),
			h("div", { class: "row" }, this.#save, this.#refresh),
		);
		if (signal.aborted) this.dispose();
		else signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		this.update();
		void this.refresh();
	}

	update(): void {
		if (this.#lifetime.signal.aborted) return;
		const canManage = this.#canManage();
		if (!canManage && this.#mutating) {
			this.#request?.abort();
			this.#request = undefined;
			this.#state = undefined;
			this.#busy = false;
			this.#mutating = false;
			this.#uncertain = true;
			this.#message = "Your permissions changed. Refresh company execution to confirm its state.";
		}
		const disabled = !canManage || this.#busy || this.#uncertain || !this.#state;
		for (const input of [this.#spend, this.#tokens, this.#wakes, this.#reason]) input.disabled = disabled;
		this.#pause.disabled = disabled;
		this.#save.disabled = disabled;
		this.#refresh.disabled = this.#busy;
		this.#pause.textContent = this.#state?.paused ? "Resume company execution" : "Pause company execution";
		this.#role.textContent = canManage
			? "Owners and admins can change company execution."
			: "Only owners and admins can change company execution.";
		replace(this.#feedback, this.#message ? notice("neutral", this.#message) : null);
		const state = this.#state;
		this.#status.textContent = state
			? `${state.paused ? "Company execution is paused." : "Company execution is enabled."} This month: $${dollars(state.spendMicrousdUsed)} accounted spend (including reservations), ${state.tokensUsed} reserved token budget; ${state.wakesLastHour} autonomous wakes in the last hour. ${state.trips} ceiling trips this month.`
			: this.#busy
				? "Checking company execution…"
				: "Company execution status is unavailable.";
	}

	async refresh(): Promise<void> {
		if (this.#lifetime.signal.aborted || this.#busy) return;
		const request = new AbortController();
		this.#request = request;
		const signal = AbortSignal.any([this.#lifetime.signal, request.signal]);
		this.#busy = true;
		this.#state = undefined;
		this.update();
		try {
			const state = await this.#control.read(signal);
			if (signal.aborted) return;
			this.#state = state;
			this.#uncertain = false;
			this.#message = undefined;
			this.#spend.value = dollars(state.spendMicrousdPerPeriod);
			this.#tokens.value = String(state.tokensPerPeriod);
			this.#wakes.value = String(state.wakesPerHour);
		} catch {
			if (signal.aborted) return;
			this.#message = this.#uncertain
				? "The change could not be confirmed. Refresh company execution before trying again."
				: "Company execution status is unavailable. Refresh to try again.";
		} finally {
			if (this.#request === request) {
				this.#request = undefined;
				this.#busy = false;
				this.update();
			}
		}
	}

	async #setPause(): Promise<void> {
		const state = this.#state;
		if (!state || this.#pause.disabled || !this.#canManage()) return;
		const paused = !state.paused;
		const reason = this.#reason.value.trim() || undefined;
		await this.#mutate((signal) => this.#control.setPause(paused, reason, signal));
	}

	async #saveCeilings(): Promise<void> {
		const state = this.#state;
		if (!state || this.#save.disabled || !this.#canManage()) return;
		const spend = this.#spend.value.trim(),
			tokens = this.#tokens.value.trim(),
			wakes = this.#wakes.value.trim();
		if (
			spend.length > 30 ||
			tokens.length > 16 ||
			wakes.length > 7 ||
			!/^\d+(?:\.\d{1,6})?$/.test(spend) ||
			!/^\d+$/.test(tokens) ||
			!/^\d+$/.test(wakes)
		) {
			this.#message = "Enter positive whole tokens and wakes, and a USD amount with at most six decimal places.";
			this.update();
			return;
		}
		const [whole, fraction = ""] = spend.split(".");
		const spendMicrousdPerPeriod = Number(BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0")));
		const tokensPerPeriod = Number(tokens),
			wakesPerHour = Number(wakes);
		if (
			!Number.isSafeInteger(spendMicrousdPerPeriod) ||
			spendMicrousdPerPeriod < 1 ||
			!Number.isSafeInteger(tokensPerPeriod) ||
			tokensPerPeriod < 1 ||
			!Number.isSafeInteger(wakesPerHour) ||
			wakesPerHour < 1 ||
			wakesPerHour > 1_000_000
		) {
			this.#message = "Enter valid positive ceilings. Wakes must be between 1 and 1,000,000 per hour.";
			this.update();
			return;
		}
		await this.#mutate((signal) =>
			this.#control.setCeiling(
				{ expectedVersion: state.version, spendMicrousdPerPeriod, tokensPerPeriod, wakesPerHour },
				signal,
			),
		);
	}

	async #mutate(action: (signal: AbortSignal) => Promise<unknown>): Promise<void> {
		if (this.#lifetime.signal.aborted || this.#busy || this.#uncertain || !this.#canManage()) return;
		const request = new AbortController();
		this.#request = request;
		const signal = AbortSignal.any([this.#lifetime.signal, request.signal]);
		this.#busy = true;
		this.#mutating = true;
		this.#uncertain = true;
		this.#message = "Saving company execution…";
		this.update();
		let confirmed = false;
		try {
			await action(signal);
			if (!signal.aborted) confirmed = true;
		} catch {
			if (!signal.aborted)
				this.#message = "The change could not be confirmed. Refresh company execution before trying again.";
		} finally {
			if (this.#request === request) {
				this.#request = undefined;
				this.#busy = false;
				this.#mutating = false;
				this.#state = undefined;
				this.update();
			}
		}
		if (confirmed) await this.refresh();
	}

	dispose(): void {
		this.#lifetime.abort();
		this.#request?.abort();
		this.#state = undefined;
		for (const field of [this.#spend, this.#tokens, this.#wakes, this.#reason]) field.value = "";
		this.el.replaceChildren();
	}
}
