import { CloudRpcError, describeError } from "../../cloud/client.ts";
import {
	type HostedReviewRule,
	REVIEW_RULE_MAX_LENGTH,
	type ReviewRuleOutcome,
	type ReviewRuleScope,
	type WebReviewRules,
} from "../../cloud/review-rules.ts";
import { badge, button, h, notice, replace } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";

/**
 * Settings → Rules (auto-review, kernel bundle v115). Before an agent acts
 * outside the company (sends, buys, deletes, hires, sets up routines), it checks
 * these rules. A rule is one sentence, "When an agent wants to …, it should:
 * Ask first | Allow automatically". Every member writes their own; owners and
 * admins also write the company's, which everyone else sees locked. Ask first
 * wins when rules conflict, and built-in safety checks always apply.
 */
export class RulesView {
	readonly el = h("div", { class: "settings-rules" });
	readonly #client: WebReviewRules;
	readonly #lifetime = new AbortController();
	#rules: HostedReviewRule[] = [];
	#canManage = false;
	#loading = true;
	#missing = false;
	#error: string | undefined;
	#working = false;
	readonly #when = h("input", {
		type: "text",
		maxLength: REVIEW_RULE_MAX_LENGTH,
		placeholder: t("e.g. reply to emails for me"),
		"aria-label": t("When an agent wants to:"),
	}) as HTMLInputElement;
	readonly #outcome = h(
		"select",
		{ "aria-label": t("It should:") },
		h("option", { value: "allow_automatically" }, t("Allow automatically")),
		h("option", { value: "ask_first" }, t("Ask first")),
	) as HTMLSelectElement;
	readonly #scope = h(
		"select",
		{ "aria-label": t("Applies to:") },
		h("option", { value: "member" }, t("Only me")),
		h("option", { value: "company" }, t("Everyone in the company")),
	) as HTMLSelectElement;

	readonly #role: () => string | undefined;
	#listedRole: string | undefined;
	/** Counts loads and changes: a load that a newer load or a change overtook is dropped. */
	#generation = 0;

	/** `role` is the member's current role in the company: a change reloads the rules (who may edit changes). */
	constructor(client: WebReviewRules, signal: AbortSignal, role: () => string | undefined = () => undefined) {
		this.#client = client;
		this.#role = role;
		if (signal.aborted) this.#lifetime.abort();
		else signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		this.#when.onkeydown = (event: KeyboardEvent) => {
			if (event.key === "Enter" && !event.isComposing) {
				event.preventDefault();
				void this.#add();
			}
		};
		this.#draw();
		void this.#refresh();
	}

	dispose(): void {
		this.#lifetime.abort();
	}

	/** The company changed: reload when the member's role did. */
	update(): void {
		if (!this.#loading && this.#role() !== this.#listedRole) void this.#refresh();
	}

	async #refresh(): Promise<void> {
		const generation = ++this.#generation;
		const role = this.#role();
		const current = () => !this.#lifetime.signal.aborted && generation === this.#generation;
		try {
			const listed = await this.#client.list();
			if (!current()) return;
			this.#rules = listed.rules;
			this.#canManage = listed.canManageCompanyRules;
			this.#listedRole = role;
			this.#error = undefined;
		} catch (error) {
			if (!current()) return;
			if (error instanceof CloudRpcError && error.missing) this.#missing = true;
			else this.#error = describeError(error);
		} finally {
			if (current()) {
				this.#loading = false;
				this.#draw();
			}
		}
	}

	async #add(): Promise<void> {
		const when = this.#when.value.trim();
		if (!when || this.#working) {
			this.#when.focus();
			return;
		}
		const scope: ReviewRuleScope = this.#canManage && this.#scope.value === "company" ? "company" : "member";
		await this.#change(async () => {
			const rule = await this.#client.save({
				id: crypto.randomUUID(),
				scope,
				when,
				outcome: this.#outcome.value as ReviewRuleOutcome,
			});
			this.#rules = [...this.#rules.filter((item) => item.id !== rule.id), rule];
			this.#when.value = "";
		});
		this.#when.focus();
	}

	async #remove(rule: HostedReviewRule): Promise<void> {
		await this.#change(async () => {
			await this.#client.archive(rule.id);
			this.#rules = this.#rules.filter((item) => item.id !== rule.id);
		});
		// The row and its button are gone: keep the keyboard in the form.
		if (!this.el.contains(document.activeElement)) this.#when.focus();
	}

	async #change(work: () => Promise<void>): Promise<void> {
		// A load already on its way may not have this change: drop it, and load again after if the role moved.
		this.#generation++;
		this.#working = true;
		this.#error = undefined;
		this.#draw();
		try {
			await work();
		} catch (error) {
			if (!this.#lifetime.signal.aborted) this.#error = describeError(error);
		} finally {
			if (!this.#lifetime.signal.aborted) {
				this.#working = false;
				this.#draw();
				this.update();
			}
		}
	}

	#row(rule: HostedReviewRule): HTMLElement {
		const editable = rule.scope === "member" || this.#canManage;
		return h(
			"li",
			{ class: "settings-rule" },
			h(
				"div",
				{ class: "settings-copy" },
				h("small", null, t("When an agent wants to")),
				h("strong", null, rule.when),
			),
			badge(
				rule.outcome === "ask_first" ? t("Ask first") : t("Allow automatically"),
				rule.outcome === "ask_first" ? "warn" : "ok",
			),
			editable
				? h(
						"button",
						{
							type: "button",
							class: "btn btn-small",
							disabled: this.#working,
							title: t("Remove this rule"),
							"aria-label": t("Remove the rule: {rule}", { rule: rule.when }),
							onclick: () => void this.#remove(rule),
						},
						t("Remove"),
					)
				: h(
						"span",
						{ class: "settings-rule-locked muted small", title: t("Owners and admins change company rules.") },
						t("Locked"),
					),
		);
	}

	#list(title: string, rules: HostedReviewRule[], empty: string, note?: string): HTMLElement {
		return h(
			"section",
			{ class: "settings-group" },
			h("h2", null, title),
			note ? h("p", { class: "muted small" }, note) : null,
			rules.length
				? h("ul", { class: "settings-rule-list" }, ...rules.map((rule) => this.#row(rule)))
				: h("p", { class: "muted small" }, empty),
		);
	}

	#draw(): void {
		if (this.#lifetime.signal.aborted) return;
		const focused = this.el.contains(document.activeElement) ? document.activeElement : null;
		const intro = h(
			"p",
			{ class: "muted" },
			t(
				"Before an agent acts outside the company, such as sending, paying, deleting or hiring, it checks these rules.",
			),
		);
		if (this.#missing) {
			replace(
				this.el,
				h("h1", null, t("Rules")),
				intro,
				notice("neutral", t("Rules are not available on this cloud yet.")),
			);
			return;
		}
		if (this.#loading) {
			replace(this.el, h("h1", null, t("Rules")), intro, h("p", { class: "muted small" }, t("Loading rules…")));
			return;
		}
		this.#scope.hidden = !this.#canManage;
		this.#when.disabled = this.#working;
		const company = this.#rules.filter((rule) => rule.scope === "company");
		const own = this.#rules.filter((rule) => rule.scope === "member");
		replace(
			this.el,
			h("h1", null, t("Rules")),
			intro,
			this.#error ? notice("danger", this.#error) : null,
			this.#list(
				t("Company rules"),
				company,
				t("No company rules yet."),
				this.#canManage
					? t("These apply to every agent, whoever it works for.")
					: t("Owners and admins write company rules."),
			),
			this.#list(t("Your rules"), own, t("You have no rules yet."), t("These apply when an agent works for you.")),
			h(
				"section",
				{ class: "settings-group settings-rule-form" },
				h("h2", null, t("Add a rule")),
				h("label", null, t("When an agent wants to:"), this.#when),
				h(
					"div",
					{ class: "settings-rule-choices" },
					h("label", null, t("It should:"), this.#outcome),
					this.#canManage ? h("label", null, t("Applies to:"), this.#scope) : null,
					button(t("Add rule"), () => void this.#add(), { primary: true, disabled: this.#working }),
				),
				h(
					"p",
					{ class: "muted small" },
					t("Ask first wins when rules conflict. Built-in safety checks always apply."),
				),
			),
		);
		if (focused instanceof HTMLElement && this.el.contains(focused)) focused.focus({ preventScroll: true });
	}
}
