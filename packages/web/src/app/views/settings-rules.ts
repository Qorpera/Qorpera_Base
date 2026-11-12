import { CloudRpcError, describeError } from "../../cloud/client.ts";
import {
	type HostedReviewRule,
	REVIEW_RULE_MAX_LENGTH,
	type ReviewRuleOutcome,
	type ReviewRuleScope,
	type WebReviewRules,
} from "../../cloud/review-rules.ts";
import { button, h, icon, notice, replace } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";

const outcomeText = (outcome: ReviewRuleOutcome) =>
	outcome === "ask_first" ? t("Ask first") : t("Allow automatically");

function outcomeSelect(label: string, value?: ReviewRuleOutcome): HTMLSelectElement {
	const select = h(
		"select",
		{ "aria-label": label },
		h("option", { value: "allow_automatically" }, t("Allow automatically")),
		h("option", { value: "ask_first" }, t("Ask first")),
	) as HTMLSelectElement;
	if (value) select.value = value;
	return select;
}

function ruleInput(label: string, value = ""): HTMLInputElement {
	const input = h("input", {
		type: "text",
		maxLength: REVIEW_RULE_MAX_LENGTH,
		placeholder: t("e.g. reply to emails for me"),
		"aria-label": label,
	}) as HTMLInputElement;
	input.value = value;
	return input;
}

/**
 * Settings → Company → Agent rules (auto-review, kernel bundle v130), laid out as
 * Grok Bot's Auto-review rules: the form, then one table of every rule. Before
 * an agent acts outside the company (sends, buys, deletes, hires, sets up
 * routines), it checks these rules. A rule is one sentence, "When an agent
 * wants to …, it should: Ask first | Allow automatically". Every member writes
 * their own; owners and admins also write the company's, which everyone else
 * sees locked. A rule's sentence and outcome can be edited, not whom it applies
 * to (the kernel keeps a rule's scope).
 */
export class RulesView {
	readonly el = h("section", { class: "settings-group settings-rules", "aria-label": t("Agent rules") });
	readonly #client: WebReviewRules;
	readonly #lifetime = new AbortController();
	#rules: HostedReviewRule[] = [];
	#canManage: boolean;
	#loading = true;
	#missing = false;
	#error: string | undefined;
	#working = false;
	/** The rule being edited in its row: its draft (kept across redraws) and the text and outcome it started from. */
	#editing:
		| {
				id: string;
				when: HTMLInputElement;
				outcome: HTMLSelectElement;
				from: { when: string; outcome: ReviewRuleOutcome };
		  }
		| undefined;
	readonly #when = ruleInput(t("When an agent wants to:"));
	readonly #outcome = outcomeSelect(t("It should:"));
	readonly #scope = h(
		"select",
		{ "aria-label": t("Applies to:") },
		h("option", { value: "member" }, t("Only me")),
		h("option", { value: "company" }, t("Everyone in the company")),
	) as HTMLSelectElement;
	readonly #addButton = button(t("Add rule"), () => void this.#add(), { primary: true });

	readonly #role: () => string | undefined;
	#listedRole: string | undefined;
	/** Counts loads and changes: a load that a newer load or a change overtook is dropped. */
	#generation = 0;
	#refreshing = false;
	/** A change dropped a load on its way: load again once the change is done. */
	#stale = false;
	/** The latest load succeeded (a change's error or success says nothing about the list). */
	#listed = false;

	/** `role` is the member's current role in the company: a change reloads the rules (who may edit changes). */
	constructor(client: WebReviewRules, signal: AbortSignal, role: () => string | undefined = () => undefined) {
		this.#client = client;
		this.#role = role;
		// Until the list says, the role decides whether "Applies to:" shows, so the form does not jump.
		this.#canManage = ["owner", "admin"].includes(role() ?? "");
		if (signal.aborted) this.#lifetime.abort();
		else signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		this.#when.onkeydown = (event: KeyboardEvent) => {
			if (event.key === "Enter" && !event.isComposing) {
				event.preventDefault();
				void this.#add();
			}
		};
		this.#when.oninput = () => this.#syncAdd();
		this.#draw();
		void this.#refresh();
	}

	dispose(): void {
		this.#lifetime.abort();
	}

	/** The company changed: reload when the member's role did (after any change on its way). */
	update(): void {
		if (this.#loading || this.#working) return;
		const role = this.#role();
		// The role arriving after a list that loaded without it changes nothing: that list already
		// carries the cloud's answer on who may edit. A failed load is still retried when it arrives.
		if (!this.#stale && this.#listedRole === undefined && role !== undefined && this.#listed) {
			this.#listedRole = role;
			return;
		}
		if (this.#stale || role !== this.#listedRole) void this.#refresh();
	}

	async #refresh(): Promise<void> {
		const generation = ++this.#generation;
		// The role is noted as the load starts: a failed load is not retried until the role moves.
		this.#listedRole = this.#role();
		this.#stale = false;
		this.#refreshing = true;
		const current = () => !this.#lifetime.signal.aborted && generation === this.#generation;
		try {
			const listed = await this.#client.list();
			if (!current()) return;
			this.#rules = listed.rules;
			this.#canManage = listed.canManageCompanyRules;
			this.#error = undefined;
			this.#listed = true;
		} catch (error) {
			if (!current()) return;
			this.#listed = false;
			if (error instanceof CloudRpcError && error.missing) this.#missing = true;
			else this.#error = describeError(error);
		} finally {
			if (current()) {
				this.#refreshing = false;
				this.#loading = false;
				this.#draw();
			}
		}
	}

	#syncAdd(): void {
		this.#addButton.disabled = this.#loading || this.#working || !this.#when.value.trim();
	}

	async #add(): Promise<void> {
		const when = this.#when.value.trim();
		if (!when || this.#working || this.#loading) {
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

	#edit(rule: HostedReviewRule): void {
		const when = ruleInput(t("Action"), rule.when);
		const outcome = outcomeSelect(t("Behavior"), rule.outcome);
		when.onkeydown = (event: KeyboardEvent) => {
			if (event.key === "Enter" && !event.isComposing) {
				event.preventDefault();
				void this.#saveEdit(rule.id);
			}
		};
		this.#editing = { id: rule.id, when, outcome, from: { when: rule.when, outcome: rule.outcome } };
		this.#draw();
		when.focus();
		when.setSelectionRange(when.value.length, when.value.length);
	}

	#stopEditing(id: string): void {
		this.#editing = undefined;
		this.#draw();
		this.#focusRow(id);
	}

	async #saveEdit(id: string): Promise<void> {
		const editing = this.#editing;
		// The rule as listed now: a load while editing may have brought a newer one.
		const rule = this.#rules.find((item) => item.id === id);
		if (!editing || editing.id !== id || !rule || this.#working) return;
		const when = editing.when.value.trim();
		if (!when) {
			editing.when.focus();
			return;
		}
		const outcome = editing.outcome.value as ReviewRuleOutcome;
		// Nothing edited: never write the version the edit started from over a newer one.
		if (when === editing.from.when && outcome === editing.from.outcome) {
			this.#stopEditing(id);
			return;
		}
		let saved = false;
		await this.#change(async () => {
			const next = await this.#client.save({ id, scope: rule.scope, when, outcome });
			this.#rules = this.#rules.map((item) => (item.id === next.id ? next : item));
			if (this.#editing === editing) this.#editing = undefined;
			saved = true;
		});
		if (this.#lifetime.signal.aborted) return;
		if (saved) this.#focusRow(rule.id);
		else if (this.#editing === editing) editing.when.focus();
	}

	async #remove(rule: HostedReviewRule): Promise<void> {
		await this.#change(async () => {
			await this.#client.archive(rule.id);
			this.#rules = this.#rules.filter((item) => item.id !== rule.id);
			if (this.#editing?.id === rule.id) this.#editing = undefined;
		});
		// The row and its button are gone: keep the keyboard in the form.
		if (!this.el.contains(document.activeElement)) this.#when.focus();
	}

	async #change(work: () => Promise<void>): Promise<void> {
		// A load already on its way may not have this change: drop it, and load again once the change is done.
		if (this.#refreshing) this.#stale = true;
		this.#refreshing = false;
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

	/** Back to a row's Edit button (or the form when the row cannot be edited). */
	#focusRow(id: string): void {
		const edit = this.el.querySelector<HTMLButtonElement>(`tr[data-rule-id="${id}"] .settings-rule-edit`);
		(edit ?? this.#when).focus({ preventScroll: true });
	}

	#editable(rule: HostedReviewRule): boolean {
		return rule.scope === "member" || this.#canManage;
	}

	#row(rule: HostedReviewRule): HTMLElement {
		const editable = this.#editable(rule);
		const editing = editable && this.#editing?.id === rule.id ? this.#editing : undefined;
		const iconButton = (name: string, label: string, onclick: () => void, className = "") =>
			h(
				"button",
				{
					type: "button",
					class: `icon-button ${className}`.trim(),
					disabled: this.#working,
					title: label,
					"aria-label": label,
					onclick,
				},
				icon(name),
			);
		if (editing) {
			editing.when.disabled = this.#working;
			editing.outcome.disabled = this.#working;
		}
		return h(
			"tr",
			{
				class: editing ? "settings-rule is-editing" : "settings-rule",
				role: "row",
				"data-rule-id": rule.id,
				// Escape anywhere in the row being edited leaves the edit, not Settings.
				onkeydown: editing
					? (event: KeyboardEvent) => {
							if (event.key !== "Escape") return;
							event.preventDefault();
							event.stopPropagation();
							this.#stopEditing(rule.id);
						}
					: undefined,
			},
			h("td", { class: "settings-rule-when", role: "cell" }, editing ? editing.when : rule.when),
			h("td", { role: "cell" }, editing ? editing.outcome : outcomeText(rule.outcome)),
			h("td", { role: "cell" }, rule.scope === "company" ? t("Everyone in the company") : t("Only me")),
			h(
				"td",
				{ class: "settings-rule-actions", role: "cell" },
				editing
					? [
							iconButton("check", t("Save"), () => void this.#saveEdit(rule.id)),
							iconButton("close", t("Cancel"), () => this.#stopEditing(rule.id)),
						]
					: editable
						? [
								iconButton(
									"edit",
									t("Edit the rule: {rule}", { rule: rule.when }),
									() => this.#edit(rule),
									"settings-rule-edit",
								),
								iconButton(
									"trash",
									t("Remove the rule: {rule}", { rule: rule.when }),
									() => void this.#remove(rule),
								),
							]
						: h(
								"span",
								{
									class: "settings-rule-locked",
									role: "img",
									title: t("Owners and admins change company rules."),
									"aria-label": t("Locked"),
								},
								icon("lock"),
							),
			),
		);
	}

	#table(): HTMLElement | null {
		if (!this.#rules.length) return null;
		// The company's rules first, then the member's own, each in the order written.
		const rules = [
			...this.#rules.filter((rule) => rule.scope === "company"),
			...this.#rules.filter((rule) => rule.scope === "member"),
		];
		return h(
			"div",
			{ class: "settings-rule-table" },
			// Explicit roles: on a phone the rows are laid out as grids, which drops a table's own roles.
			h(
				"table",
				{ role: "table" },
				h(
					"thead",
					{ role: "rowgroup" },
					h(
						"tr",
						{ role: "row" },
						h("th", { scope: "col", role: "columnheader" }, t("Action")),
						h("th", { scope: "col", role: "columnheader", class: "settings-rule-outcome" }, t("Behavior")),
						h("th", { scope: "col", role: "columnheader", class: "settings-rule-scope" }, t("Applies to")),
						h(
							"th",
							{ scope: "col", role: "columnheader", class: "settings-rule-actions" },
							h("span", { class: "visually-hidden" }, t("Edit or remove")),
						),
					),
				),
				h("tbody", { role: "rowgroup" }, ...rules.map((rule) => this.#row(rule))),
			),
		);
	}

	#draw(): void {
		if (this.#lifetime.signal.aborted) return;
		const focused = this.el.contains(document.activeElement) ? document.activeElement : null;
		if (this.#missing) {
			replace(
				this.el,
				h("h2", null, t("Agent rules")),
				notice("neutral", t("Rules are not available on this cloud yet.")),
			);
			return;
		}
		// A load can take away the rule being edited, or the right to edit it: the edit ends,
		// and a keyboard in it moves to the form (the row has no pencil any more, if any row).
		const edited = this.#editing && this.#rules.find((rule) => rule.id === this.#editing?.id);
		const dropped = this.#editing && (!edited || !this.#editable(edited)) ? this.#editing.id : undefined;
		if (dropped) this.#editing = undefined;
		this.#scope.hidden = !this.#canManage;
		this.#when.disabled = this.#working;
		this.#syncAdd();
		replace(
			this.el,
			h("h2", null, t("Agent rules")),
			h(
				"div",
				{ class: "settings-rule-form" },
				h("label", { class: "settings-rule-field" }, h("span", null, t("When an agent wants to:")), this.#when),
				h(
					"div",
					{ class: "settings-rule-choices" },
					h("label", { class: "settings-rule-field" }, h("span", null, t("It should:")), this.#outcome),
					this.#canManage
						? h("label", { class: "settings-rule-field" }, h("span", null, t("Applies to:")), this.#scope)
						: null,
					this.#addButton,
				),
			),
			this.#error ? notice("danger", this.#error) : null,
			this.#table(),
			h("p", { class: "settings-rule-note" }, t("Built-in safety checks always apply.")),
		);
		if (focused instanceof HTMLElement && this.el.contains(focused)) focused.focus({ preventScroll: true });
		else if (dropped && focused?.closest(`tr[data-rule-id="${dropped}"]`)) this.#when.focus({ preventScroll: true });
	}
}
