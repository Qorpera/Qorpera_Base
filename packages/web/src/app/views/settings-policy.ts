import { type Cloud, describeError } from "../../cloud/client.ts";
import { COMPANY_POLICY_KEYS, type CompanyPolicyConfig, type CompanyPolicyMode } from "../../cloud/company-policy.ts";
import { PolicyApi, type PolicyCommand, type PolicyDocument } from "../../cloud/policy-api.ts";
import { SettingsApi } from "../../cloud/settings-api.ts";
import { button, h, icon, notice, replace, spinner } from "../../ui/dom.ts";
import type { CompanyController } from "../company.ts";

const LABELS = {
	spending: "Spending",
	external_communication: "External Communication",
	hard_to_reverse_changes: "Hard-to-reverse Changes",
	information_sharing: "Information Sharing",
};
export class PolicyView {
	readonly el = h("div");
	readonly #api: PolicyApi;
	readonly #company: CompanyController;
	readonly #lifetime = new AbortController();
	#document?: PolicyDocument;
	#draft?: CompanyPolicyConfig;
	#command?: PolicyCommand;
	#attempt?: { document: PolicyDocument; policy: CompanyPolicyConfig; key: string };
	#busy = false;
	#error?: string;
	#message?: string;
	readonly #unsubscribe: () => void;
	constructor(cloud: Cloud, company: CompanyController, signal: AbortSignal) {
		this.#company = company;
		this.#api = new PolicyApi(
			new SettingsApi(
				cloud,
				company.profile,
				company.userId,
				AbortSignal.any([signal, company.signal, this.#lifetime.signal]),
			),
		);
		let canAuthorize = company.store.get().team?.capabilities.authorize === true;
		this.#unsubscribe = company.store.subscribe(() => {
			const next = company.store.get().team?.capabilities.authorize === true;
			if (next === canAuthorize) return;
			canAuthorize = next;
			this.#draw();
		});
		void this.#load();
	}
	dispose(): void {
		this.#lifetime.abort();
		this.#unsubscribe();
	}
	async #load(): Promise<void> {
		await this.#run(async () => {
			this.#document = undefined;
			this.#draft = undefined;
			const document = await this.#api.read();
			this.#document = document;
			this.#draft = { ...document.policy };
			this.#command = undefined;
			this.#attempt = undefined;
		});
	}
	async #run(action: () => Promise<void>): Promise<void> {
		if (this.#busy || this.#lifetime.signal.aborted) return;
		this.#busy = true;
		this.#error = undefined;
		this.#message = undefined;
		this.#draw();
		try {
			await action();
		} catch (error) {
			this.#error = describeError(error);
		} finally {
			this.#busy = false;
			if (!this.#lifetime.signal.aborted) this.#draw();
		}
	}
	async #acceptResult(command: PolicyCommand): Promise<void> {
		this.#command = command;
		if (command.state === "applied") {
			const document = await this.#api.read();
			this.#document = document;
			this.#draft = { ...document.policy };
			this.#attempt = undefined;
			this.#command = undefined;
			this.#message = "Policy saved.";
		} else if (command.state === "rejected") {
			this.#attempt = undefined;
			this.#command = undefined;
			this.#message = "Policy change rejected.";
		}
	}
	#draw(): void {
		if (this.#lifetime.signal.aborted) return;
		const canAuthorize = this.#company.store.get().team?.capabilities.authorize === true;
		const pending = this.#command;
		const changed =
			this.#draft &&
			this.#document &&
			COMPANY_POLICY_KEYS.some((key) => this.#draft![key] !== this.#document!.policy[key]);
		replace(
			this.el,
			h(
				"header",
				{ class: "policy-heading" },
				h("h1", null, "Policy"),
				h("span", { class: "policy-note" }, icon("info"), "Instructions, not permissions"),
			),
			this.#error ? notice("danger", this.#error) : null,
			this.#message ? notice("ok", this.#message) : null,
			!this.#document
				? this.#busy
					? spinner("Loading policy")
					: notice("neutral", "Policy could not be loaded.")
				: h(
						"div",
						{ class: "policy-list" },
						...COMPANY_POLICY_KEYS.map((key) => {
							const select = h(
								"select",
								{
									"aria-label": LABELS[key],
									disabled: !canAuthorize || this.#busy || Boolean(pending || this.#attempt),
								},
								...(["ask", "act", "auto"] as const).map((mode) =>
									h(
										"option",
										{ value: mode, selected: this.#draft?.[key] === mode },
										mode.charAt(0).toUpperCase() + mode.slice(1),
									),
								),
							);
							select.onchange = () => {
								if (this.#draft) this.#draft[key] = select.value as CompanyPolicyMode;
								this.#draw();
								this.el.querySelector<HTMLSelectElement>(`select[aria-label="${LABELS[key]}"]`)?.focus();
							};
							return h("label", { class: "policy-row" }, icon(key), h("span", null, LABELS[key]), select);
						}),
					),
			h(
				"p",
				{ class: "policy-help" },
				"Ask: request approval first. Act: act when directly requested or authorized. Auto: act when it advances your request. Changes apply to new runs. These instructions do not expand access or bypass company permissions.",
			),
			!canAuthorize ? notice("neutral", "An owner or admin can change company policy.") : null,
			pending
				? notice(
						"neutral",
						pending.state === "review_required"
							? "Review the selected policy changes before applying them."
							: "The cloud is processing this policy change.",
						pending.state === "review_required" && canAuthorize
							? h(
									"div",
									{ class: "row" },
									button(
										"Apply policy",
										() =>
											void this.#run(async () =>
												this.#acceptResult(await this.#api.review(pending, "approve")),
											),
										{ disabled: this.#busy },
									),
									button(
										"Reject change",
										() =>
											void this.#run(async () =>
												this.#acceptResult(await this.#api.review(pending, "reject")),
											),
										{ disabled: this.#busy },
									),
								)
							: null,
						button(
							"Check status",
							() => void this.#run(async () => this.#acceptResult(await this.#api.status(pending))),
							{ disabled: this.#busy },
						),
					)
				: null,
			h(
				"div",
				{ class: "row" },
				canAuthorize && this.#document && !pending
					? button(
							this.#attempt ? "Retry save" : "Save policy",
							() =>
								void this.#run(async () => {
									this.#attempt ??= {
										document: this.#document!,
										policy: { ...this.#draft! },
										key: crypto.randomUUID(),
									};
									await this.#acceptResult(
										await this.#api.save(this.#attempt.document, this.#attempt.policy, this.#attempt.key),
									);
								}),
							{ disabled: this.#busy || !changed },
						)
					: null,
				button("Reload policy", () => void this.#load(), { disabled: this.#busy }),
			),
		);
	}
}
