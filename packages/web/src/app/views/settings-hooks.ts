import { CloudRpcError } from "../../cloud/client.ts";
import type { EventHook, EventHookStatus, WebEventHooks } from "../../cloud/event-hooks.ts";
import { button, confirmDialog, fmtTime, h, icon, replace } from "../../ui/dom.ts";
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

export type HooksClient = Pick<WebEventHooks, "list" | "createHook" | "createMailbox" | "setStatus">;
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
	purpose: string;
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
		purpose: phrase("What it is for, e.g. new orders from the shop"),
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
		purpose: phrase("What it is for, e.g. invoices from suppliers"),
		hint: phrase("The part before the @: lowercase letters, digits, dots, hyphens and underscores."),
		nameRule: phrase(
			"A mailbox name is lowercase letters, digits, dots, hyphens and underscores, and starts and ends with a letter or digit.",
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
const MAILBOX_NAME = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/;

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
	if (code === "54000") return t("The company has as many webhooks and mailboxes as it can have. Remove one first.");
	if (code === "0A000" && kind === "mailbox") return t("Company mail is not set up yet.");
	if (code === "22023" && kind === "mailbox" && error instanceof Error && error.message.includes("reserved"))
		return t("This mailbox name is reserved. Choose another.");
	if (code === "42501") return t("Only founders and admins can add, pause or remove them.");
	return t(KIND_TEXT[kind].failed);
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
	#drawnManage: boolean | undefined;
	#hooks: EventHook[] | undefined;
	#loading = true;
	#error: string | undefined;
	/** A hook's id while it changes, or the kind being added. */
	#working: string | undefined;
	#adding: Kind | undefined;
	readonly #drafts: Record<Kind, { name: string; purpose: string }> = {
		webhook: { name: "", purpose: "" },
		mailbox: { name: "", purpose: "" },
	};
	/** The last action's outcome, under its hook's card or its kind's form. */
	#outcome: { key: string; tone: "ok" | "error"; text: string } | undefined;
	#refreshing: Promise<void> | undefined;
	/** One more read, asked for while a read was out, and the focus it draws with. */
	#again: { read: Promise<void>; focusKey: string | undefined } | undefined;

	constructor(
		client: HooksClient,
		signal: AbortSignal,
		options: { access?: HooksAccess; kinds?: readonly HookKind[]; changed?: () => void } = {},
	) {
		this.#client = client;
		this.#access = options.access ?? FULL_ACCESS;
		this.#changed = options.changed ?? (() => {});
		this.#kinds = options.kinds ?? ["webhook", "mailbox"];
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

	async #read(focusKey?: string): Promise<void> {
		try {
			const hooks = await this.#client.list(this.#lifetime.signal);
			if (this.#lifetime.signal.aborted) return;
			this.#hooks = hooks;
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
		const purpose = draft.purpose.trim();
		const nameProblem =
			kind === "webhook" && name.startsWith("mail-")
				? t("Names beginning with mail- belong to mailboxes.")
				: !(kind === "webhook" ? WEBHOOK_NAME : MAILBOX_NAME).test(name) || name.includes("..")
					? t(text.nameRule)
					: undefined;
		const problem =
			nameProblem ??
			(!purpose || [...purpose].length > 512 || /\p{Cc}/u.test(purpose)
				? t("Say what it is for, in one line.")
				: undefined);
		if (problem) {
			this.#outcome = { key: kind, tone: "error", text: problem };
			this.#draw(nameProblem ? `hook-name:${kind}` : `hook-purpose:${kind}`);
			return;
		}
		this.#working = kind;
		this.#outcome = undefined;
		this.#draw();
		try {
			const hook =
				kind === "webhook"
					? await this.#client.createHook(name, purpose, this.#lifetime.signal)
					: await this.#client.createMailbox(name, purpose, this.#lifetime.signal);
			if (this.#lifetime.signal.aborted) return;
			this.#working = undefined;
			this.#adding = undefined;
			this.#drafts[kind] = { name: "", purpose: "" };
			this.#outcome = { key: hook.id, tone: "ok", text: t(text.ready) };
			// The new one shows at once, with its address to copy; the next read sorts it in.
			this.#hooks = [...(this.#hooks ?? []).filter((item) => item.id !== hook.id), hook];
			this.#changed();
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

	#card(hook: EventHook): HTMLElement {
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
				hook.purpose ? h("small", null, hook.purpose) : null,
				h("small", { class: "hook-state" }, this.#state(hook)),
			),
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
			maxlength: "64",
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
		const purpose = h("input", {
			type: "text",
			value: draft.purpose,
			maxlength: "512",
			autocomplete: "off",
			placeholder: t(text.purpose),
			"aria-label": t("What it is for"),
			oninput: () => {
				draft.purpose = purpose.value;
			},
		});
		purpose.dataset.focusKey = `hook-purpose:${kind}`;
		// A mailbox's domain is the company mail's, known once the company has one mailbox.
		const domain = kind === "mailbox" ? this.#hooks?.find((hook) => hook.email)?.email?.split("@")[1] : undefined;
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
			h("div", { class: "hook-form-row" }, name, domain ? h("span", { class: "hook-domain" }, `@${domain}`) : null),
			h("small", null, t(text.hint)),
			purpose,
			this.#outcomeLine(kind),
			h("div", { class: "hook-form-actions" }, add, cancel),
		);
	}

	#section(kind: Kind): HTMLElement {
		const text = KIND_TEXT[kind];
		const manage = this.#access.canManage();
		const hooks = (this.#hooks ?? []).filter((hook) => kindOf(hook) === kind);
		let addArea: HTMLElement | null = null;
		if (manage && !this.#loading) {
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
			addArea = h("div", { class: "connection-add-area" }, add, open ? this.#form(kind) : null);
		}
		return h(
			"section",
			{ class: "settings-group", dataset: { hooks: kind } },
			h(
				"div",
				{ class: "connection-section-heading" },
				h("h2", null, t(text.title)),
				manage ? null : h("small", null, t("Only founders and admins can add, pause or remove them.")),
			),
			h(
				"div",
				{ class: "connection-list" },
				...hooks.map((hook) => this.#card(hook)),
				this.#loading
					? h("p", { class: "connection-empty muted", role: "status" }, t("Checking…"))
					: hooks.length
						? null
						: h("p", { class: "connection-empty muted" }, t(text.empty)),
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
