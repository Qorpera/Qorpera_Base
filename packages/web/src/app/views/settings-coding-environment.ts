import { CloudRpcError } from "../../cloud/client.ts";
import {
	CODING_REPOSITORY,
	CODING_VARIABLE_NAME,
	type CodingEnvironmentGrant,
	type CodingEnvironmentOwner,
	type CodingEnvironmentVariable,
	codingValueProblem,
	type WebCodingEnvironment,
} from "../../cloud/coding-environment.ts";
import { button, confirmDialog, h, icon, replace } from "../../ui/dom.ts";
import { phrase, t } from "../../ui/preferences.ts";

/**
 * Settings → environment variables for coding (F3 step 5j): values a coding session gets as environment variables,
 * such as a token that installs private packages. The tab decides who owns a new one: AI subscriptions adds the
 * member's own, which reach that member's coding sessions in every repository and leave with them; Company
 * connections adds the company's, which reach a coding session only in a repository an owner or admin gave it to,
 * win there over a member's of the same name, and stay when someone leaves. Each card says what changes for coding
 * sessions; a value is captured at the company's broker and never drawn, nor kept here after its save.
 */

export interface CodingEnvironmentAccess {
	/** Whether the signed-in member may change this owner's variables: an owner or admin for the company's, anyone
	 * who may write for their own (the kernel enforces the same rules). */
	canManage(): boolean;
}

const FULL_ACCESS: CodingEnvironmentAccess = { canManage: () => true };

interface OwnerText {
	lead: string;
	readOnly: string;
}

const OWNER_TEXT: Record<CodingEnvironmentOwner, OwnerText> = {
	member: {
		lead: phrase("Your coding sessions get these in every repository. They leave with you."),
		readOnly: phrase("Viewers can see them, but not add or change them."),
	},
	company: {
		lead: phrase(
			"A coding session gets one of these only in a repository it's given to. They stay when someone leaves.",
		),
		readOnly: phrase("Only founders and admins can add, change or remove them."),
	},
};

const VALUE_PROBLEM = {
	short: phrase("The value must be at least 8 characters."),
	long: phrase("The value can be at most 32 KB."),
	nul: phrase("The value can't contain a null character."),
} as const;

/** The repositories a list of grants names, as one phrase. */
function repositories(grants: readonly CodingEnvironmentGrant[]): string {
	return grants.map((grant) => grant.repository).join(", ");
}

/** A value's field, read only when its form is sent; every draw makes a new, empty one. A textarea keeps a multiline
 * value's line breaks but reads each back as LF, so while the field holds just what was last pasted into it, the
 * paste is what is sent, CR and all. */
function valueField(options: { class?: string; placeholder: string; label: string; focusKey: string }): {
	field: HTMLTextAreaElement;
	read(): string;
} {
	let pasted: string | undefined;
	const field = h("textarea", {
		class: options.class,
		rows: "3",
		autocomplete: "off",
		autocapitalize: "off",
		spellcheck: "false",
		placeholder: options.placeholder,
		"aria-label": options.label,
		onpaste: (event: ClipboardEvent) => {
			pasted = event.clipboardData?.getData("text/plain");
		},
	});
	field.dataset.focusKey = options.focusKey;
	return {
		field,
		read: () => (pasted !== undefined && pasted.replace(/\r\n?/g, "\n") === field.value ? pasted : field.value),
	};
}

export class CodingEnvironmentView {
	readonly el = h("div", { class: "coding-environment" });
	readonly #client: WebCodingEnvironment;
	readonly #owner: CodingEnvironmentOwner;
	readonly #lifetime = new AbortController();
	readonly #access: CodingEnvironmentAccess;
	readonly #onChange: (() => void) | undefined;
	#drawnManage: boolean | undefined;
	/** This owner's variables and, for a member, the company's too: a company variable granted on a repository wins
	 * there over the member's of the same name. */
	#variables: CodingEnvironmentVariable[] | undefined;
	#loading = true;
	#error: string | undefined;
	/** What is being changed: `add`, or an action and the variable's or grant's id. */
	#working: string | undefined;
	#adding = false;
	/** The add form's name and purpose. Its value stays in its field until the save, never here. */
	#draft = { name: "", purpose: "" };
	/** The one card form open: a variable's new value, or the repository to give it to. */
	#open: { secretId: string; form: "value" | "repository" } | undefined;
	#repositoryDraft = "";
	/** The last action's outcome, under its variable's card or the add form. */
	#outcome: { key: string; tone: "ok" | "error"; text: string } | undefined;
	#refreshing: Promise<void> | undefined;
	/** One more read, asked for while a read was out, and the focus it draws with. */
	#again: { read: Promise<void>; focusKey: string | undefined } | undefined;

	constructor(
		client: WebCodingEnvironment,
		signal: AbortSignal,
		options: {
			owner: CodingEnvironmentOwner;
			access?: CodingEnvironmentAccess;
			/** Called after each change of this view's that reached the cloud, saved or refused (a refusal may still
			 * have changed something), once this view's own read has started. */
			onChange?: () => void;
		},
	) {
		this.#client = client;
		this.#owner = options.owner;
		this.#access = options.access ?? FULL_ACCESS;
		this.#onChange = options.onChange;
		if (signal.aborted) this.#lifetime.abort();
		else signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		this.#draw();
		void this.#refresh();
	}

	/** Redraws when the member's authority over these variables changed (the team loads after the page, or a role
	 * changes while it is open). */
	update(): void {
		if (this.#lifetime.signal.aborted || this.#access.canManage() === this.#drawnManage) return;
		if (!this.#access.canManage()) {
			this.#adding = false;
			this.#open = undefined;
		}
		this.#draw();
	}

	/** Reads the list again because the other tab's view changed it: a company variable given to a repository, or
	 * taken back, changes which of the member's own is used there. Nothing after dispose. */
	reload(): void {
		void this.#refresh();
	}

	dispose(): void {
		this.#lifetime.abort();
		this.el.replaceChildren();
		this.el.remove();
	}

	/** Reads the list. A read already out may have left before the caller's change, so a caller then gets one more
	 * read after it (shared by every caller meanwhile, drawn with the last one's focus). */
	#refresh(focusKey?: string): Promise<void> {
		if (this.#lifetime.signal.aborted) return Promise.resolve();
		if (!this.#refreshing) {
			this.#refreshing = this.#read(focusKey).finally(() => {
				this.#refreshing = undefined;
			});
			return this.#refreshing;
		}
		if (this.#again) {
			this.#again.focusKey = focusKey;
			return this.#again.read;
		}
		const again: { read: Promise<void>; focusKey: string | undefined } = {
			read: this.#refreshing.then(() => {
				this.#again = undefined;
				return this.#refresh(again.focusKey);
			}),
			focusKey,
		};
		this.#again = again;
		return again.read;
	}

	/** After a change that reached the cloud: reads this view's list again, then tells whoever shows it too. */
	#changed(focusKey?: string): Promise<void> {
		const read = this.#refresh(focusKey);
		this.#onChange?.();
		return read;
	}

	async #read(focusKey?: string): Promise<void> {
		try {
			const variables = await this.#client.list(this.#lifetime.signal);
			if (this.#lifetime.signal.aborted) return;
			this.#variables = variables;
			this.#error = undefined;
		} catch {
			if (this.#lifetime.signal.aborted) return;
			this.#error = t("The environment variables could not be read.");
		} finally {
			this.#loading = false;
			if (!this.#lifetime.signal.aborted) this.#draw(focusKey);
		}
	}

	/** This view's own variables: the member's on AI subscriptions, the company's on Company connections. */
	#own(): CodingEnvironmentVariable[] {
		return (this.#variables ?? []).filter((variable) => variable.ownerKind === this.#owner);
	}

	/** Why a change was refused, in the interface language. */
	#failure(error: unknown, kind: "add" | "replace" | "grant" | "other"): string {
		if (error instanceof CloudRpcError) {
			const capture = kind === "add" || kind === "replace";
			// The cloud keeps the names the coding machine sets itself and the AI providers' sign-ins.
			if (capture && error.code === "22023" && error.message.includes("not available"))
				return t("That name is taken by the coding machine or an AI provider's sign-in. Choose another.");
			// The cloud allows one open replacement of a variable: an earlier page's try left one, which closes
			// within ten minutes.
			if (kind === "replace" && error.code === "23505")
				return t("An earlier try to save this value is still open. Try again in a few minutes.");
			if (kind === "grant" && error.code === "22023")
				return t("Write the repository as owner/name, for example acme/web.");
			if (error.denied) return t(OWNER_TEXT[this.#owner].readOnly);
		}
		return t("It could not be changed. Try again.");
	}

	/** What a saved value changes for coding sessions. */
	#saved(name: string, replaced: CodingEnvironmentVariable | undefined): string {
		if (!replaced)
			return this.#owner === "member"
				? t("{name} is saved. Your coding sessions get it from their next start.", { name })
				: t("{name} is saved. Give it to a repository so coding sessions there get it.", { name });
		if (this.#owner === "member")
			return t("The value of {name} is replaced. Your coding sessions get the new one from their next start.", {
				name,
			});
		if (!replaced.grants.length)
			return t("The value of {name} is replaced. No coding session gets it yet.", { name });
		return t(
			"The value of {name} is replaced. Coding sessions in {repositories} get the new one from their next start.",
			{ name, repositories: repositories(replaced.grants) },
		);
	}

	/** Saves a value as a new variable, or over this owner's variable of that name. The value lives only in this
	 * call; every draw from here on has empty value fields. */
	async #add(value: string): Promise<void> {
		if (this.#working || this.#lifetime.signal.aborted) return;
		const name = this.#draft.name.trim().toUpperCase();
		const purpose = this.#draft.purpose.trim();
		const valueProblem = codingValueProblem(value);
		const problem: [string, string] | undefined = !CODING_VARIABLE_NAME.test(name)
			? ["name", t("A variable name is capital letters, digits and underscores, and starts with a letter.")]
			: !purpose || [...purpose].length > 512 || /\p{Cc}/u.test(purpose)
				? ["purpose", t("Say what it is for, in one line.")]
				: valueProblem
					? ["value", t(VALUE_PROBLEM[valueProblem])]
					: undefined;
		if (problem) {
			this.#outcome = { key: "add", tone: "error", text: problem[1] };
			this.#draw(`coding-${problem[0]}:${this.#owner}`);
			return;
		}
		const existing = this.#own().find((variable) => variable.name === name);
		this.#working = "add";
		this.#outcome = undefined;
		this.#draw();
		try {
			await this.#client.capture(
				{ ownerKind: this.#owner, name, purpose, value, existingSecretId: existing?.secretId },
				this.#lifetime.signal,
			);
			if (this.#lifetime.signal.aborted) return;
			this.#working = undefined;
			this.#adding = false;
			this.#draft = { name: "", purpose: "" };
			this.#outcome = { key: `variable:${name}`, tone: "ok", text: this.#saved(name, existing) };
			this.#draw(`coding-add:${this.#owner}`);
			await this.#changed(`coding-add:${this.#owner}`);
		} catch (error) {
			if (this.#lifetime.signal.aborted) return;
			this.#working = undefined;
			this.#outcome = { key: "add", tone: "error", text: this.#failure(error, existing ? "replace" : "add") };
			this.#draw(`coding-name:${this.#owner}`);
			// A lost answer may still have saved it, and a name added elsewhere meanwhile (23505) is replaced by the
			// next try once it is listed.
			await this.#changed();
		}
	}

	async #replace(variable: CodingEnvironmentVariable, value: string): Promise<void> {
		if (this.#working || this.#lifetime.signal.aborted) return;
		const key = `variable:${variable.name}`;
		const problem = codingValueProblem(value);
		if (problem) {
			this.#outcome = { key, tone: "error", text: t(VALUE_PROBLEM[problem]) };
			this.#draw(`coding-new-value:${variable.secretId}`);
			return;
		}
		this.#working = `replace:${variable.secretId}`;
		this.#outcome = undefined;
		this.#draw();
		let focus = `coding-new-value:${variable.secretId}`;
		try {
			await this.#client.capture(
				{
					ownerKind: this.#owner,
					name: variable.name,
					purpose: variable.purpose,
					value,
					existingSecretId: variable.secretId,
				},
				this.#lifetime.signal,
			);
			if (this.#lifetime.signal.aborted) return;
			this.#open = undefined;
			this.#outcome = { key, tone: "ok", text: this.#saved(variable.name, variable) };
			focus = `coding-replace:${variable.secretId}`;
		} catch (error) {
			if (!this.#lifetime.signal.aborted)
				this.#outcome = { key, tone: "error", text: this.#failure(error, "replace") };
		} finally {
			this.#working = undefined;
			if (!this.#lifetime.signal.aborted) await this.#changed(focus);
		}
	}

	async #remove(variable: CodingEnvironmentVariable): Promise<void> {
		if (this.#working || this.#lifetime.signal.aborted) return;
		if (
			!(await confirmDialog(
				t("Remove {name}? New coding sessions won't get it.", { name: variable.name }),
				t("Remove"),
				true,
				undefined,
				this.#lifetime.signal,
			))
		)
			return;
		if (this.#working || this.#lifetime.signal.aborted) return;
		this.#working = `remove:${variable.secretId}`;
		this.#outcome = undefined;
		this.#draw();
		try {
			await this.#client.remove(variable.secretId, this.#lifetime.signal);
			if (this.#open?.secretId === variable.secretId) this.#open = undefined;
		} catch (error) {
			if (!this.#lifetime.signal.aborted)
				this.#outcome = { key: `variable:${variable.name}`, tone: "error", text: this.#failure(error, "other") };
		} finally {
			this.#working = undefined;
			if (!this.#lifetime.signal.aborted) await this.#changed(`coding-add:${this.#owner}`);
		}
	}

	async #grant(variable: CodingEnvironmentVariable): Promise<void> {
		if (this.#working || this.#lifetime.signal.aborted) return;
		const key = `variable:${variable.name}`;
		// The cloud stores a repository in lower case, as GitHub matches it.
		const repository = this.#repositoryDraft.trim().toLowerCase();
		if (!CODING_REPOSITORY.test(repository)) {
			this.#outcome = { key, tone: "error", text: t("Write the repository as owner/name, for example acme/web.") };
			this.#draw(`coding-repository:${variable.secretId}`);
			return;
		}
		this.#working = `grant:${variable.secretId}`;
		this.#outcome = undefined;
		this.#draw();
		let focus = `coding-repository:${variable.secretId}`;
		try {
			const grant = await this.#client.grant(variable.secretId, repository, this.#lifetime.signal);
			if (this.#lifetime.signal.aborted) return;
			this.#open = undefined;
			this.#repositoryDraft = "";
			this.#outcome = {
				key,
				tone: "ok",
				text: t("Coding sessions in {repository} get {name} from their next start.", {
					repository: grant.repository,
					name: variable.name,
				}),
			};
			// The card says so at once; the next read confirms it. Giving it again answers the same grant.
			this.#variables = this.#variables?.map((item) =>
				item.secretId === variable.secretId && !item.grants.some((known) => known.grantId === grant.grantId)
					? { ...item, grants: [...item.grants, grant] }
					: item,
			);
			focus = `coding-give:${variable.secretId}`;
		} catch (error) {
			if (!this.#lifetime.signal.aborted)
				this.#outcome = { key, tone: "error", text: this.#failure(error, "grant") };
		} finally {
			this.#working = undefined;
			if (!this.#lifetime.signal.aborted) await this.#changed(focus);
		}
	}

	async #revokeGrant(variable: CodingEnvironmentVariable, grant: CodingEnvironmentGrant): Promise<void> {
		if (this.#working || this.#lifetime.signal.aborted) return;
		if (
			!(await confirmDialog(
				t("Coding sessions in {repository} will stop getting {name}.", {
					repository: grant.repository,
					name: variable.name,
				}),
				t("Remove"),
				true,
				undefined,
				this.#lifetime.signal,
			))
		)
			return;
		if (this.#working || this.#lifetime.signal.aborted) return;
		this.#working = `revoke:${grant.grantId}`;
		this.#outcome = undefined;
		this.#draw();
		try {
			await this.#client.revokeGrant(grant.grantId, this.#lifetime.signal);
		} catch (error) {
			if (!this.#lifetime.signal.aborted)
				this.#outcome = { key: `variable:${variable.name}`, tone: "error", text: this.#failure(error, "other") };
		} finally {
			this.#working = undefined;
			if (!this.#lifetime.signal.aborted) await this.#changed(`coding-give:${variable.secretId}`);
		}
		// A grant withdrawn elsewhere meanwhile is refused here, but what the member asked for is done.
		if (
			this.#outcome?.tone === "error" &&
			!this.#variables?.some((item) => item.grants.some((known) => known.grantId === grant.grantId))
		) {
			this.#outcome = undefined;
			this.#draw();
		}
	}

	/** What the variable changes for coding sessions: where it reaches, and for a member's, where the company's of the
	 * same name wins. */
	#reach(variable: CodingEnvironmentVariable): string {
		if (variable.ownerKind === "company")
			return variable.grants.length
				? t("Coding sessions in {repositories} get it.", { repositories: repositories(variable.grants) })
				: t("No coding session gets it yet.");
		const company = (this.#variables ?? []).flatMap((item) =>
			item.ownerKind === "company" && item.name === variable.name ? item.grants : [],
		);
		const own = t("Your coding sessions get it.");
		return company.length
			? `${own} ${t("In {repositories}, the company's {name} is used instead.", {
					repositories: repositories(company),
					name: variable.name,
				})}`
			: own;
	}

	#outcomeLine(key: string): HTMLElement | null {
		if (this.#outcome?.key !== key) return null;
		return h(
			"p",
			{ class: `service-outcome ${this.#outcome.tone === "ok" ? "is-ok" : "is-error"}`, role: "status" },
			this.#outcome.text,
		);
	}

	#close(variable: CodingEnvironmentVariable, focusKey: string): void {
		this.#open = undefined;
		if (this.#outcome?.key === `variable:${variable.name}` && this.#outcome.tone === "error")
			this.#outcome = undefined;
		this.#draw(focusKey);
	}

	/** A variable's new value: the services' token form. Its field is drawn empty every time. */
	#valueForm(variable: CodingEnvironmentVariable): HTMLElement {
		const id = variable.secretId;
		const value = valueField({
			class: "service-token",
			placeholder: t("Paste the new value"),
			label: t("New value for {name}", { name: variable.name }),
			focusKey: `coding-new-value:${id}`,
		});
		// Enter in the field is a line break, so the button saves.
		const save = button(
			this.#working === `replace:${id}` ? t("Saving…") : t("Save value"),
			() => void this.#replace(variable, value.read()),
			{ primary: true, disabled: Boolean(this.#working) },
		);
		const cancel = button(t("Cancel"), () => this.#close(variable, `coding-replace:${id}`), {
			disabled: Boolean(this.#working),
		});
		return h(
			"form",
			{
				class: "service-token-form",
				onsubmit: (event: Event) => {
					event.preventDefault();
					void this.#replace(variable, value.read());
				},
			},
			h("small", null, t("Once saved, a value is never shown again.")),
			h("div", { class: "service-token-row" }, value.field, save, cancel),
		);
	}

	/** The repository to give a company variable to, as owner/name. */
	#repositoryForm(variable: CodingEnvironmentVariable): HTMLElement {
		const id = variable.secretId;
		const field = h("input", {
			type: "text",
			class: "service-token",
			value: this.#repositoryDraft,
			maxlength: "140",
			autocomplete: "off",
			autocapitalize: "none",
			spellcheck: "false",
			placeholder: t("owner/name"),
			"aria-label": t("Repository for {name}", { name: variable.name }),
			oninput: () => {
				this.#repositoryDraft = field.value;
			},
		});
		field.dataset.focusKey = `coding-repository:${id}`;
		const add = button(this.#working === `grant:${id}` ? t("Adding…") : t("Add"), () => void this.#grant(variable), {
			primary: true,
			disabled: Boolean(this.#working),
		});
		const cancel = button(t("Cancel"), () => this.#close(variable, `coding-give:${id}`), {
			disabled: Boolean(this.#working),
		});
		const hint = t("Coding sessions in that repository get {name} from their next start.", { name: variable.name });
		return h(
			"form",
			{
				class: "service-token-form",
				onsubmit: (event: Event) => {
					event.preventDefault();
					void this.#grant(variable);
				},
			},
			h("small", null, hint),
			h("div", { class: "service-token-row" }, field, add, cancel),
		);
	}

	#card(variable: CodingEnvironmentVariable): HTMLElement {
		const id = variable.secretId;
		const manage = this.#access.canManage();
		const company = variable.ownerKind === "company";
		// Members without authority see the card read-only.
		const actions: HTMLElement[] = [];
		let grants: HTMLElement | null = null;
		let forms: HTMLElement | null = null;
		if (manage) {
			const remove = button(
				this.#working === `remove:${id}` ? t("Working…") : t("Remove"),
				() => void this.#remove(variable),
				{ danger: true, disabled: Boolean(this.#working) },
			);
			remove.dataset.focusKey = `coding-remove:${id}`;
			actions.push(remove);
			// Each repository a company variable is given to, with the way to take it back.
			if (company && variable.grants.length)
				grants = h(
					"div",
					{ class: "connection-accounts" },
					...variable.grants.map((grant) => {
						const revoke = button(
							this.#working === `revoke:${grant.grantId}` ? t("Working…") : t("Remove"),
							() => void this.#revokeGrant(variable, grant),
							{ small: true, disabled: Boolean(this.#working) },
						);
						revoke.dataset.focusKey = `coding-grant-remove:${grant.grantId}`;
						revoke.setAttribute("aria-label", t("Remove {repository}", { repository: grant.repository }));
						return h(
							"div",
							{ class: "connection-account", dataset: { grant: grant.grantId } },
							h("span", null, grant.repository),
							revoke,
						);
					}),
				);
			if (this.#open?.secretId === id)
				forms = this.#open.form === "value" ? this.#valueForm(variable) : this.#repositoryForm(variable);
			else {
				const toggle = (label: string, form: "value" | "repository", focusKey: string) => {
					const item = button(
						label,
						() => {
							this.#open = { secretId: id, form };
							this.#repositoryDraft = "";
							if (this.#outcome?.key === `variable:${variable.name}`) this.#outcome = undefined;
							this.#draw(form === "value" ? `coding-new-value:${id}` : `coding-repository:${id}`);
						},
						{ small: true, disabled: Boolean(this.#working) },
					);
					item.dataset.focusKey = focusKey;
					return item;
				};
				forms = h(
					"div",
					{ class: "service-alternative" },
					toggle(t("Replace value"), "value", `coding-replace:${id}`),
					company ? [" ", toggle(t("Give to a repository"), "repository", `coding-give:${id}`)] : null,
				);
			}
		}
		return h(
			"article",
			{ class: "service-card hook-card", dataset: { variable: id }, "aria-label": variable.name },
			h("span", { class: "hook-icon" }, icon("key")),
			h(
				"div",
				{ class: "settings-copy" },
				h("strong", null, variable.name),
				h("small", null, variable.purpose),
				h("small", { class: "hook-state" }, this.#reach(variable)),
			),
			h("div", { class: "connection-actions" }, ...actions),
			grants,
			forms,
			this.#outcomeLine(`variable:${variable.name}`),
		);
	}

	#form(): HTMLElement {
		const owner = this.#owner;
		const draft = this.#draft;
		const name = h("input", {
			type: "text",
			value: draft.name,
			maxlength: "64",
			autocomplete: "off",
			autocapitalize: "characters",
			spellcheck: "false",
			placeholder: t("e.g. NPM_TOKEN"),
			"aria-label": t("Variable name"),
			oninput: () => {
				draft.name = name.value;
			},
		});
		name.dataset.focusKey = `coding-name:${owner}`;
		const purpose = h("input", {
			type: "text",
			value: draft.purpose,
			maxlength: "512",
			autocomplete: "off",
			placeholder: t("What it is for, e.g. installs private packages"),
			"aria-label": t("What it is for"),
			oninput: () => {
				draft.purpose = purpose.value;
			},
		});
		purpose.dataset.focusKey = `coding-purpose:${owner}`;
		// Read only when the form is sent; every draw makes a new, empty field. Enter in it is a line break, so the
		// button sends the form.
		const value = valueField({
			placeholder: t("Paste the value"),
			label: t("Value"),
			focusKey: `coding-value:${owner}`,
		});
		const add = h(
			"button",
			{ type: "submit", class: "btn btn-primary", disabled: Boolean(this.#working) },
			this.#working === "add" ? t("Adding…") : t("Add"),
		);
		const cancel = button(t("Cancel"), () => {
			this.#adding = false;
			if (this.#outcome?.key === "add") this.#outcome = undefined;
			this.#draw(`coding-add:${owner}`);
		});
		return h(
			"form",
			{
				id: `coding-variable-form-${owner}`,
				class: "hook-form",
				onsubmit: (event: Event) => {
					event.preventDefault();
					void this.#add(value.read());
				},
			},
			name,
			h("small", null, t("Capital letters, digits and underscores, starting with a letter.")),
			purpose,
			value.field,
			h("small", null, t("Once saved, a value is never shown again.")),
			this.#outcomeLine("add"),
			h("div", { class: "hook-form-actions" }, add, cancel),
		);
	}

	#section(): HTMLElement {
		const owner = this.#owner;
		const manage = this.#access.canManage();
		const variables = this.#own();
		let addArea: HTMLElement | null = null;
		if (manage && !this.#loading) {
			const open = this.#adding;
			const add = button(
				t("Add a variable"),
				() => {
					this.#adding = !open;
					if (this.#outcome?.key === "add") this.#outcome = undefined;
					this.#draw(open ? `coding-add:${owner}` : `coding-name:${owner}`);
				},
				{ disabled: Boolean(this.#working) },
			);
			add.classList.add("hook-add");
			add.dataset.focusKey = `coding-add:${owner}`;
			add.setAttribute("aria-expanded", String(open));
			add.setAttribute("aria-controls", `coding-variable-form-${owner}`);
			addArea = h("div", { class: "connection-add-area" }, add, open ? this.#form() : null);
		}
		return h(
			"section",
			{ class: "settings-group", dataset: { codingEnvironment: owner } },
			h(
				"div",
				{ class: "connection-section-heading" },
				h(
					"div",
					{ class: "settings-copy" },
					h("h2", null, t("Environment variables for coding")),
					h("small", null, t(OWNER_TEXT[owner].lead)),
				),
				manage ? null : h("small", null, t(OWNER_TEXT[owner].readOnly)),
			),
			h(
				"div",
				{ class: "connection-list" },
				...variables.map((variable) => this.#card(variable)),
				this.#loading
					? h("p", { class: "connection-empty muted", role: "status" }, t("Checking…"))
					: variables.length
						? null
						: h("p", { class: "connection-empty muted" }, t("No variables yet.")),
				addArea,
			),
		);
	}

	#draw(focusKey?: string): void {
		if (this.#lifetime.signal.aborted) return;
		this.#drawnManage = this.#access.canManage();
		const active = document.activeElement as HTMLElement | null;
		const key = focusKey ?? (this.el.contains(active) ? active?.dataset.focusKey : undefined);
		let error: HTMLElement | null = null;
		if (this.#error) {
			const retry = button(
				t("Try again"),
				() => {
					this.#loading = true;
					this.#error = undefined;
					this.#draw();
					void this.#refresh();
				},
				{ small: true },
			);
			retry.dataset.focusKey = `coding-retry:${this.#owner}`;
			error = h("p", { class: "connection-empty service-error", role: "alert" }, this.#error, " ", retry);
		}
		replace(
			this.el,
			error,
			// Without a first read there is nothing to show but the way to try again.
			this.#variables || this.#loading ? this.#section() : null,
		);
		if (key) {
			const target = [...this.el.querySelectorAll<HTMLElement>("[data-focus-key]")].find(
				(item) => item.dataset.focusKey === key,
			);
			if (target && !target.matches(":disabled")) target.focus();
		}
	}
}
