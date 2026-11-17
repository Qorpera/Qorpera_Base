import { CloudRpcError } from "../../cloud/client.ts";
import {
	type EventHook,
	type EventHookStatus,
	MAIL_BOX,
	MAIL_HANDLE,
	type MailHandles,
	type WebEventHooks,
} from "../../cloud/event-hooks.ts";
import { button, confirmDialog, fmtTime, h, icon, replace } from "../../ui/dom.ts";
import {
	cleanHandle,
	HANDLE_MAX_CHARACTERS,
	HandleCheck,
	handleUsable,
	handleWords,
	mailboxRefusal,
} from "../../ui/mail-address.ts";
import { phrase, t } from "../../ui/preferences.ts";

/**
 * The company's event hooks (events plan §6): its webhooks, under an agent's
 * Routines, and its mailboxes, under the Mailbox page's Addresses. What arrives at one starts the company's routines
 * that wait for it. Every member sees each one's name, what it is for and
 * whether it is on; a mailbox's email address is public by nature. An owner or
 * admin also sees a webhook's address, the one thing its sender needs, and
 * adds, pauses, resumes or removes them; the kernel refuses anyone else.
 * It adds address-proven webhooks only: a signed one needs its sender's
 * signing secret in the vault, and members never paste one.

 */

export type HooksClient = Pick<
	WebEventHooks,
	"list" | "createHook" | "createMailbox" | "setStatus" | "mailHandles" | "handleStatus"
>;
export type HookKind = "webhook" | "mailbox";
type Kind = HookKind;

export interface HooksAccess {
	/** Whether the signed-in member may add, pause or remove the company's hooks
	 * (owner or admin; the kernel enforces the same rule). */
	canManage(): boolean;
}

const FULL_ACCESS: HooksAccess = { canManage: () => true };

interface KindText {
	title: string;
	empty: string;
	add: string;
	name: string;
	example: string;
	hint: string;
	nameRule: string;
	taken: string;
	failed: string;
	ready: string;
	last: string;
	none: string;
	remove: string;
}

/** Each list's words, in the interface language. */
const KIND_TEXT: Record<Kind, KindText> = {
	webhook: {
		title: phrase("Webhooks"),
		empty: phrase(
			"No webhooks yet. A webhook lets another service, such as a shop or a payment provider, start the company's routines.",
		),
		add: phrase("Add webhook"),
		name: phrase("Webhook name"),
		example: phrase("e.g. new-orders"),
		hint: phrase(
			"Lowercase letters, digits and hyphens, starting with a letter. The company's agents read what it is for when something arrives.",
		),
		nameRule: phrase("A webhook name is lowercase letters, digits and hyphens, and starts with a letter."),
		taken: phrase("A webhook with this name already exists."),
		failed: phrase("The webhook could not be added. Try again."),
		ready: phrase("The webhook is ready. Give its address to the service that sends the events."),
		last: phrase("Last event {time}"),
		none: phrase("No events yet"),
		remove: phrase("Remove the webhook {name}? Anything sent to its address afterwards is turned away."),
	},
	mailbox: {
		title: phrase("Mailboxes"),
		empty: phrase("No mailboxes yet. Email sent to a company mailbox can start the company's routines."),
		add: phrase("Add mailbox"),
		name: phrase("Mailbox name"),
		example: phrase("e.g. invoices"),
		hint: phrase("The first part of the address: lowercase letters, digits, hyphens and underscores."),
		nameRule: phrase(
			"A mailbox name is lowercase letters, digits, hyphens and underscores, and starts and ends with a letter or digit.",
		),
		taken: phrase("This address is taken."),
		failed: phrase("The mailbox could not be added. Try again."),
		ready: phrase("The mailbox is ready. Email sent to it can start the company's routines."),
		last: phrase("Last email {time}"),
		none: phrase("No email yet"),
		remove: phrase("Remove the mailbox {name}? Email sent to it afterwards does not reach the company."),
	},
};

/** Who signs a signed webhook's deliveries (made by an agent; Settings adds none). */
const SIGNERS: Readonly<Record<string, string>> = {
	stripe: phrase("Signed by Stripe"),
	github: phrase("Signed by GitHub"),
	"hmac-sha256": phrase("Signed by its sender"),
};

/** The kernel's name rules (CLIENT-CONTRACT.md §2), checked here first to say what is wrong. */
const WEBHOOK_NAME = /^[a-z][a-z0-9-]{0,63}$/;

function kindOf(hook: EventHook): Kind {
	return hook.proof === "mail" ? "mailbox" : "webhook";
}

/** What a card is called: a mailbox by its email address. */
function title(hook: EventHook): string {
	return kindOf(hook) === "mailbox" ? (hook.email ?? hook.name) : hook.name;
}

/** Why adding a hook failed, in the interface language. */
function addError(kind: Kind, error: unknown): string {
	const code = error instanceof CloudRpcError ? error.code : undefined;
	if (code === "23505") return t(KIND_TEXT[kind].taken);
	if (code === "42501") return t("Only founders and admins can add, pause or remove them.");
	if (kind === "mailbox" && (code === "0A000" || code === "22023" || code === "54000")) return mailboxRefusal(error);
	if (code === "54000") return t("The company has as many webhooks and mailboxes as it can have. Remove one first.");
	return t(KIND_TEXT[kind].failed);
}

/** More beside the way to add a hook, and under it, where it stands above the list (`top`). */
export interface HooksTop {
	readonly beside?: () => HTMLElement | null;
	readonly below?: () => HTMLElement | null;
}

export class HooksView {
	readonly el = h("div", { class: "hooks" });
	readonly #client: HooksClient;
	readonly #lifetime = new AbortController();
	readonly #access: HooksAccess;
	/** The lists drawn: webhooks, mailboxes or both. */
	readonly #kinds: readonly Kind[];
	/** Told after a hook was added, paused, resumed or removed. */
	readonly #changed: () => void;
	readonly #card: ((hook: EventHook) => HTMLElement | null) | undefined;
	readonly #stateOf: ((hook: EventHook, text: string) => string | null) | undefined;
	readonly #top: HooksTop | undefined;
	readonly #formExtra: ((kind: HookKind) => HTMLElement | null) | undefined;
	readonly #added: ((hook: EventHook) => void) | undefined;
	readonly #unnamed: () => boolean;
	#drawnManage: boolean | undefined;
	#hooks: EventHook[] | undefined;
	#mail: MailHandles | undefined;
	readonly #handleCheck: HandleCheck;
	#handleLine: HTMLElement | undefined;
	#loading = true;
	#error: string | undefined;
	/** A hook's id while it changes, or the kind being added. */
	#working: string | undefined;
	#adding: Kind | undefined;
	readonly #drafts: Record<Kind, { name: string; purpose: string; handle: string }> = {
		webhook: { name: "", purpose: "", handle: "" },
		mailbox: { name: "", purpose: "", handle: "" },
	};
	/** The last action's outcome, under its hook's card or its kind's form. */
	#outcome: { key: string; tone: "ok" | "error"; text: string } | undefined;
	#refreshing: Promise<void> | undefined;
	/** One more read, asked for while a read was out, and the focus it draws with. */
	#again: { read: Promise<void>; focusKey: string | undefined } | undefined;

	constructor(
		client: HooksClient,
		signal: AbortSignal,
		options: {
			access?: HooksAccess;
			kinds?: readonly HookKind[];
			changed?: () => void;
			/** More of a hook, drawn in its card between its words and its buttons (the Mailbox: who answers a
			 * mailbox). The page that gives it calls `redraw` when what it shows changed. */
			card?: (hook: EventHook) => HTMLElement | null;
			/** What a hook's state line says, from what it says here (`text`); none for no line (the Mailbox: a paused
			 * mailbox only). */
			state?: (hook: EventHook, text: string) => string | null;
			/** The way to add a hook first, above its list rather than under it, with more beside its button and under it
			 * (the Mailbox: Digital Post's pill, and its card). The same `redraw` draws them again. */
			top?: HooksTop;
			/** More of the form that adds one, drawn under its fields (the Mailbox: who answers the new mailbox). */
			form?: (kind: HookKind) => HTMLElement | null;
			/** Told the hook the form made. */
			added?: (hook: EventHook) => void;
			unnamed?: () => boolean;
		} = {},
	) {
		this.#client = client;
		this.#access = options.access ?? FULL_ACCESS;
		this.#changed = options.changed ?? (() => {});
		this.#card = options.card;
		this.#stateOf = options.state;
		this.#top = options.top;
		this.#formExtra = options.form;
		this.#added = options.added;
		this.#unnamed = options.unnamed ?? (() => false);
		this.#kinds = options.kinds ?? ["webhook", "mailbox"];
		this.#handleCheck = new HandleCheck(
			(handle, signal) => this.#client.handleStatus(handle, signal),
			() => this.#drawHandleCheck(),
		);
		if (signal.aborted) this.#lifetime.abort();
		else signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		this.#draw();
		void this.#refresh();
	}

	/** Redraws when the member's authority over the company's hooks changed (the
	 * team loads after the page, or a role changes while it is open). */
	update(): void {
		if (this.#lifetime.signal.aborted || this.#access.canManage() === this.#drawnManage) return;
		if (!this.#access.canManage()) this.#adding = undefined;
		this.#draw();
		// The kernel sends a webhook's address only to an owner or admin: a member who just became one reads it.
		if (this.#access.canManage() && this.#hooks?.some((hook) => kindOf(hook) === "webhook" && !hook.url))
			void this.#refresh();
	}

	/** Draws again what the page's own parts of the cards and the form show (`card`, `form`). */
	redraw(): void {
		this.#draw();
	}

	dispose(): void {
		this.#lifetime.abort();
		this.#handleCheck.stop();
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

	async #read(focusKey?: string): Promise<void> {
		try {
			const signal = this.#lifetime.signal;
			const [hooks, mail] = await Promise.all([
				this.#client.list(signal),
				this.#kinds.includes("mailbox") ? this.#client.mailHandles(signal).catch(() => this.#mail) : undefined,
			]);
			if (signal.aborted) return;
			this.#hooks = hooks;
			this.#mail = mail;
			this.#error = undefined;
		} catch {
			if (this.#lifetime.signal.aborted) return;
			this.#error = t("The company's webhooks and mailboxes could not be read.");
		} finally {
			this.#loading = false;
			if (!this.#lifetime.signal.aborted) this.#draw(focusKey);
		}
	}

	async #setStatus(hook: EventHook, status: EventHookStatus | "removed"): Promise<void> {
		if (this.#working || this.#lifetime.signal.aborted) return;
		const kind = kindOf(hook);
		if (
			status === "removed" &&
			!(await confirmDialog(
				t(KIND_TEXT[kind].remove, { name: title(hook) }),
				t("Remove"),
				true,
				undefined,
				this.#lifetime.signal,
			))
		)
			return;
		if (this.#working || this.#lifetime.signal.aborted) return;
		this.#working = hook.id;
		this.#outcome = undefined;
		this.#draw();
		try {
			await this.#client.setStatus(hook.id, status, this.#lifetime.signal);
			if (!this.#lifetime.signal.aborted) this.#changed();
		} catch (error) {
			// A hook removed meanwhile (55000) leaves the list on the next read.
			if (!this.#lifetime.signal.aborted && !(error instanceof CloudRpcError && error.code === "55000"))
				this.#outcome = {
					key: hook.id,
					tone: "error",
					text:
						error instanceof CloudRpcError && error.code === "42501"
							? t("Only founders and admins can add, pause or remove them.")
							: t("It could not be changed. Try again."),
				};
		} finally {
			this.#working = undefined;
			if (!this.#lifetime.signal.aborted)
				await this.#refresh(status === "removed" ? `hook-add:${kind}` : `hook-toggle:${hook.id}`);
		}
	}

	async #add(kind: Kind): Promise<void> {
		if (this.#working || this.#lifetime.signal.aborted) return;
		const text = KIND_TEXT[kind];
		const draft = this.#drafts[kind];
		const name = draft.name.trim().toLowerCase();
		const owned = this.#handle();
		const handle = owned ?? draft.handle;
		const localPart = `${name}.${handle}`;
		const purpose = kind === "mailbox" ? localPart : draft.purpose.trim();
		const nameProblem =
			kind === "webhook" && name.startsWith("mail-")
				? t("Names beginning with mail- belong to mailboxes.")
				: !(kind === "webhook" ? WEBHOOK_NAME : MAIL_BOX).test(name)
					? t(text.nameRule)
					: undefined;
		const handleProblem =
			kind !== "mailbox" || owned !== undefined
				? undefined
				: !MAIL_HANDLE.test(handle)
					? t("Use a–z, 0–9 and hyphens")
					: handleUsable(this.#handleCheck.state) || this.#handleCheck.state === "checking"
						? undefined
						: handleWords(this.#handleCheck.state);
		const problem =
			nameProblem ??
			handleProblem ??
			(!purpose || [...purpose].length > 512 || /\p{Cc}/u.test(purpose)
				? t("Say what it is for, in one line.")
				: undefined);
		if (problem) {
			this.#outcome = { key: kind, tone: "error", text: problem };
			this.#draw(nameProblem ? `hook-name:${kind}` : handleProblem ? `hook-handle:${kind}` : `hook-purpose:${kind}`);
			return;
		}
		this.#working = kind;
		this.#outcome = undefined;
		this.#draw();
		try {
			const hook =
				kind === "webhook"
					? await this.#client.createHook(name, purpose, this.#lifetime.signal)
					: await this.#client.createMailbox(localPart, purpose, this.#lifetime.signal);
			if (this.#lifetime.signal.aborted) return;
			this.#working = undefined;
			this.#adding = undefined;
			this.#drafts[kind] = { name: "", purpose: "", handle: "" };
			if (kind === "mailbox" && owned === undefined && this.#mail)
				this.#mail = { ...this.#mail, handles: [...this.#mail.handles, handle] };
			this.#outcome = { key: hook.id, tone: "ok", text: t(text.ready) };
			// The new one shows at once, with its address to copy; the next read sorts it in.
			this.#hooks = [...(this.#hooks ?? []).filter((item) => item.id !== hook.id), hook];
			this.#changed();
			this.#added?.(hook);
			const focus = hook.url ? `hook-copy:${hook.id}` : `hook-add:${kind}`;
			this.#draw(focus);
			await this.#refresh(focus);
		} catch (error) {
			if (this.#lifetime.signal.aborted) return;
			this.#working = undefined;
			this.#outcome = { key: kind, tone: "error", text: addError(kind, error) };
			this.#draw(`hook-name:${kind}`);
		}
	}

	#handle(): string | undefined {
		return this.#mail?.handles.at(-1);
	}

	#domain(): string | undefined {
		return this.#mail?.domain ?? this.#hooks?.find((hook) => hook.email)?.email?.split("@")[1];
	}

	#drawHandleCheck(): void {
		const line = this.#handleLine;
		if (!line) return;
		const state = this.#handleCheck.state;
		line.textContent = handleWords(state);
		line.classList.toggle("is-ok", state === "free" || state === "ours");
		line.classList.toggle("is-error", state === "taken" || state === "invalid");
	}

	async #copy(hook: EventHook): Promise<void> {
		if (!hook.url) return;
		try {
			await navigator.clipboard.writeText(hook.url);
			this.#outcome = { key: hook.id, tone: "ok", text: t("The address is copied.") };
		} catch {
			this.#outcome = {
				key: hook.id,
				tone: "error",
				text: t("The address could not be copied. Select it and copy it."),
			};
		}
		if (!this.#lifetime.signal.aborted) this.#draw(`hook-copy:${hook.id}`);
	}

	/** The hook's state: whether it is on, when something last arrived, and who signs it. */
	/** The hook's state line, as the page that shows it wants it. */
	#stateLine(hook: EventHook): HTMLElement | null {
		const text = this.#state(hook);
		const shown = this.#stateOf ? this.#stateOf(hook, text) : text;
		return shown ? h("small", { class: "hook-state" }, shown) : null;
	}

	#state(hook: EventHook): string {
		const text = KIND_TEXT[kindOf(hook)];
		return [
			hook.status === "paused"
				? t("Paused")
				: hook.signingSecretReady === false
					? t("Waiting for its signing secret")
					: t("Active"),
			hook.lastReceivedAt ? t(text.last, { time: fmtTime(hook.lastReceivedAt) }) : t(text.none),
			// A Stripe hook's events refused under the secret the vault read: the endpoint's secret may have changed.
			hook.lastRefusal
				? t("Last refused event {time}: {reason}", {
						time: fmtTime(hook.lastRefusal.receivedAt),
						reason: hook.lastRefusal.reason,
					})
				: "",
			Object.hasOwn(SIGNERS, hook.proof) ? t(SIGNERS[hook.proof]!) : "",
		]
			.filter(Boolean)
			.join(" · ");
	}

	#outcomeLine(key: string): HTMLElement | null {
		if (this.#outcome?.key !== key) return null;
		return h(
			"p",
			{ class: `service-outcome ${this.#outcome.tone === "ok" ? "is-ok" : "is-error"}`, role: "status" },
			this.#outcome.text,
		);
	}

	#cardOf(hook: EventHook): HTMLElement {
		const kind = kindOf(hook);
		const manage = this.#access.canManage();
		const busy = this.#working === hook.id;
		// Members who are not owners or admins see the card read-only, without a webhook's address.
		const actions: HTMLElement[] = [];
		if (manage) {
			const paused = hook.status === "paused";
			const toggle = button(
				busy ? t("Working…") : paused ? t("Resume") : t("Pause"),
				() => void this.#setStatus(hook, paused ? "active" : "paused"),
				{ disabled: Boolean(this.#working) },
			);
			toggle.dataset.focusKey = `hook-toggle:${hook.id}`;
			const remove = button(t("Remove"), () => void this.#setStatus(hook, "removed"), {
				danger: true,
				disabled: Boolean(this.#working),
			});
			remove.dataset.focusKey = `hook-remove:${hook.id}`;
			actions.push(toggle, remove);
		}
		let address: HTMLElement | null = null;
		if (manage && hook.url) {
			const copy = button([icon("copy"), t("Copy")], () => void this.#copy(hook), { small: true });
			copy.dataset.focusKey = `hook-copy:${hook.id}`;
			address = h(
				"div",
				{ class: "hook-address" },
				h("div", { class: "hook-address-row" }, h("code", null, hook.url), copy),
				hook.proof === "address"
					? h(
							"small",
							null,
							t("Anyone with this address can send to it. Give it only to the service that sends the events."),
						)
					: null,
			);
		}
		return h(
			"article",
			{ class: "service-card hook-card", dataset: { hook: hook.id }, "aria-label": title(hook) },
			h("span", { class: "hook-icon" }, icon(kind === "mailbox" ? "mail" : "webhook")),
			h(
				"div",
				{ class: "settings-copy" },
				h("strong", null, title(hook)),
				// A mailbox added here has its name for a purpose (#add): the line is for one that says more.
				hook.purpose && hook.purpose !== hook.email?.split("@")[0] ? h("small", null, hook.purpose) : null,
				this.#stateLine(hook),
			),
			this.#card?.(hook) ?? null,
			h("div", { class: "connection-actions" }, ...actions),
			address,
			this.#outcomeLine(hook.id),
		);
	}

	#form(kind: Kind): HTMLElement {
		const text = KIND_TEXT[kind];
		const draft = this.#drafts[kind];
		const name = h("input", {
			type: "text",
			value: draft.name,
			maxlength: kind === "mailbox" ? "39" : "64",
			autocomplete: "off",
			autocapitalize: "none",
			spellcheck: "false",
			placeholder: t(text.example),
			"aria-label": t(text.name),
			oninput: () => {
				draft.name = name.value;
			},
		});
		name.dataset.focusKey = `hook-name:${kind}`;
		// Only a webhook says what it is for: a mailbox's name does.
		let purpose: HTMLInputElement | null = null;
		if (kind === "webhook") {
			const field = h("input", {
				type: "text",
				value: draft.purpose,
				maxlength: "512",
				autocomplete: "off",
				placeholder: t("What it is for, e.g. new orders from the shop"),
				"aria-label": t("What it is for"),
				oninput: () => {
					draft.purpose = field.value;
				},
			});
			field.dataset.focusKey = "hook-purpose:webhook";
			purpose = field;
		}
		const domain = kind === "mailbox" ? this.#domain() : undefined;
		const handle = kind === "mailbox" ? this.#handle() : undefined;
		let handleField: HTMLInputElement | null = null;
		this.#handleLine = undefined;
		if (kind === "mailbox" && handle === undefined) {
			const field = h("input", {
				type: "text",
				value: draft.handle,
				maxlength: String(HANDLE_MAX_CHARACTERS),
				autocomplete: "off",
				autocapitalize: "none",
				spellcheck: "false",
				placeholder: t("e.g. acme"),
				"aria-label": t("The company's part of the address"),
				oninput: () => {
					const cleaned = cleanHandle(field.value);
					if (cleaned !== field.value) field.value = cleaned;
					draft.handle = cleaned;
					this.#handleCheck.set(cleaned);
				},
			});
			field.dataset.focusKey = `hook-handle:${kind}`;
			handleField = field;
			this.#handleLine = h("p", { class: "service-outcome hook-handle-check", role: "status" });
			if (draft.handle) {
				this.#handleCheck.set(draft.handle);
				this.#drawHandleCheck();
			}
		}
		const tail =
			kind !== "mailbox"
				? null
				: handle !== undefined
					? h("span", { class: "hook-domain" }, `.${handle}${domain ? `@${domain}` : ""}`)
					: domain
						? h("span", { class: "hook-domain" }, `@${domain}`)
						: null;
		const add = h(
			"button",
			{ type: "submit", class: "btn btn-primary", disabled: Boolean(this.#working) },
			this.#working === kind ? t("Adding…") : t("Add"),
		);
		add.dataset.focusKey = `hook-submit:${kind}`;
		const cancel = button(t("Cancel"), () => {
			this.#adding = undefined;
			if (this.#outcome?.key === kind) this.#outcome = undefined;
			this.#draw(`hook-add:${kind}`);
		});
		return h(
			"form",
			{
				id: `hook-form-${kind}`,
				class: "hook-form",
				onsubmit: (event: Event) => {
					event.preventDefault();
					void this.#add(kind);
				},
			},
			h(
				"div",
				{ class: `hook-form-row${handleField ? " is-address" : ""}` },
				name,
				handleField ? h("span", { class: "hook-domain" }, ".") : null,
				handleField,
				tail,
			),
			this.#handleLine ?? null,
			h(
				"small",
				null,
				handleField
					? t("The first part, then the company's part, which every address of the company ends with.")
					: t(text.hint),
			),
			purpose,
			this.#formExtra?.(kind) ?? null,
			this.#outcomeLine(kind),
			h("div", { class: "hook-form-actions" }, add, cancel),
		);
	}

	#section(kind: Kind): HTMLElement {
		const text = KIND_TEXT[kind];
		const manage = this.#access.canManage();
		const hooks = (this.#hooks ?? []).filter((hook) => kindOf(hook) === kind);
		let addArea: HTMLElement | null = null;
		if (manage && !this.#loading && kind === "mailbox" && this.#unnamed() && this.#handle() === undefined) {
			const waits = h("p", { class: "connection-empty muted hook-waits" }, t("Your email address waits for a name"));
			addArea = this.#top
				? h(
						"div",
						{ class: "connection-add-area is-top" },
						h("div", { class: "connection-add-row" }, waits, this.#top.beside?.() ?? null),
						this.#top.below?.() ?? null,
					)
				: h("div", { class: "connection-add-area" }, waits);
		} else if (manage && !this.#loading) {
			const open = this.#adding === kind;
			const add = button(
				t(text.add),
				() => {
					this.#adding = open ? undefined : kind;
					if (this.#outcome?.key === "webhook" || this.#outcome?.key === "mailbox") this.#outcome = undefined;
					this.#draw(open ? `hook-add:${kind}` : `hook-name:${kind}`);
				},
				{ disabled: Boolean(this.#working) },
			);
			add.classList.add("hook-add");
			add.dataset.focusKey = `hook-add:${kind}`;
			add.setAttribute("aria-expanded", String(open));
			add.setAttribute("aria-controls", `hook-form-${kind}`);
			addArea = this.#top
				? h(
						"div",
						{ class: "connection-add-area is-top" },
						h("div", { class: "connection-add-row" }, add, this.#top.beside?.() ?? null),
						open ? this.#form(kind) : null,
						this.#top.below?.() ?? null,
					)
				: h("div", { class: "connection-add-area" }, add, open ? this.#form(kind) : null);
		}
		return h(
			"section",
			{ class: "settings-group", dataset: { hooks: kind } },
			this.#top ? addArea : null,
			h(
				"div",
				{ class: "connection-section-heading" },
				h("h2", null, t(text.title)),
				manage ? null : h("small", null, t("Only founders and admins can add, pause or remove them.")),
			),
			h(
				"div",
				{ class: "connection-list" },
				...hooks.map((hook) => this.#cardOf(hook)),
				this.#loading
					? h("p", { class: "connection-empty muted", role: "status" }, t("Checking…"))
					: hooks.length
						? null
						: h("p", { class: "connection-empty muted" }, t(text.empty)),
				this.#top ? null : addArea,
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
			retry.dataset.focusKey = "hook-retry";
			error = h("p", { class: "connection-empty service-error", role: "alert" }, this.#error, " ", retry);
		}
		replace(
			this.el,
			error,
			// Without a first read there is nothing to show but the way to try again.
			this.#hooks || this.#loading ? this.#kinds.map((kind) => this.#section(kind)) : null,
		);
		if (key) {
			const target = [...this.el.querySelectorAll<HTMLElement>("[data-focus-key]")].find(
				(item) => item.dataset.focusKey === key,
			);
			if (target && !target.matches(":disabled")) target.focus();
		}
	}
}
