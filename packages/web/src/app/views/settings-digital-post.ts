import {
	type DigitalPostConnection,
	type DigitalPostKeys,
	digitalPostAdminUrl,
	digitalPostKeyLooksValid,
} from "../../cloud/digital-post.ts";
import { CloudRpcError } from "../../cloud/client.ts";
import { button, fmtTime, h, icon, replace } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";

/**
 * Settings → Company connections → Digital Post (deploy/first-node/RUNTIME-DIGITAL-POST.md): the company's public post,
 * fetched into its folder and its Mailbox. Company first: an owner or admin connects it, everyone sees how it stands.
 *
 * Connecting happens in Digital Post's own Administrativ Adgang, with MitID Erhverv: the card lists the steps, with
 * Qorpera's CVR and the vault's addresses as the platform's settings give them, and takes the API key the receipt
 * shows. The key goes straight to the company vault; nothing here keeps it. Disconnect revokes it; the card says the
 * system should go in Administrativ Adgang too. The card shows once the state is read; on a cloud without the call it
 * stays hidden.
 */

export interface DigitalPostClient extends DigitalPostKeys {
	read(signal: AbortSignal): Promise<DigitalPostConnection>;
}

export interface DigitalPostAccess {
	/** Whether the signed-in member may connect or disconnect it (owner or admin; the vault checks the same rule). */
	canManage(): boolean;
}

export class DigitalPostView {
	readonly el = h("section", { class: "settings-group services digital-post" });
	readonly #client: DigitalPostClient;
	readonly #access: DigitalPostAccess;
	readonly #lifetime = new AbortController();
	#connection: DigitalPostConnection | undefined;
	#loading = true;
	/** The cloud has no Digital Post call yet. */
	#missing = false;
	#error: string | undefined;
	#working = false;
	#entering = false;
	#outcome: { tone: "ok" | "error"; text: string } | undefined;

	constructor(client: DigitalPostClient, signal: AbortSignal, options: { access: DigitalPostAccess }) {
		this.#client = client;
		this.#access = options.access;
		if (signal.aborted) this.#lifetime.abort();
		else signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		this.#draw();
		void this.#read();
	}

	dispose(): void {
		this.#lifetime.abort();
	}

	async #read(): Promise<void> {
		try {
			const connection = await this.#client.read(this.#lifetime.signal);
			if (this.#lifetime.signal.aborted) return;
			this.#connection = connection;
			this.#missing = false;
			this.#error = undefined;
		} catch (error) {
			if (this.#lifetime.signal.aborted) return;
			this.#missing = error instanceof CloudRpcError && error.missing;
			this.#error = this.#missing ? undefined : t("Digital Post could not be read.");
		} finally {
			this.#loading = false;
			if (!this.#lifetime.signal.aborted) this.#draw();
		}
	}

	async #save(apiKey: string): Promise<void> {
		if (this.#working || this.#lifetime.signal.aborted) return;
		if (!digitalPostKeyLooksValid(apiKey)) {
			this.#outcome = {
				tone: "error",
				text: t("This is not a Digital Post API key. Copy the key from the receipt Administrativ Adgang shows."),
			};
			this.#draw("digital-post-key");
			return;
		}
		this.#working = true;
		this.#outcome = undefined;
		this.#draw();
		try {
			await this.#client.save(apiKey, this.#connection?.secretId, this.#lifetime.signal);
			if (this.#lifetime.signal.aborted) return;
			this.#entering = false;
			this.#outcome = {
				tone: "ok",
				text: t("Digital Post is connected. Letters arrive in the Mailbox within a few minutes."),
			};
		} catch {
			if (this.#lifetime.signal.aborted) return;
			this.#outcome = { tone: "error", text: t("The key could not be saved. Check it and try again.") };
		} finally {
			this.#working = false;
			if (!this.#lifetime.signal.aborted) await this.#read();
		}
	}

	async #disconnect(secretId: string): Promise<void> {
		if (this.#working || this.#lifetime.signal.aborted) return;
		this.#working = true;
		this.#outcome = undefined;
		this.#draw();
		try {
			await this.#client.disconnect(secretId, this.#lifetime.signal);
			if (!this.#lifetime.signal.aborted)
				this.#outcome = {
					tone: "ok",
					text: t(
						"Digital Post is disconnected. Remove the Qorpera system in Administrativ Adgang too, or Digital Post keeps sending to it and moves the letters to Virk after seven days.",
					),
				};
		} catch {
			if (!this.#lifetime.signal.aborted)
				this.#outcome = { tone: "error", text: t("Digital Post could not be disconnected. Try again.") };
		} finally {
			this.#working = false;
			if (!this.#lifetime.signal.aborted) await this.#read();
		}
	}

	/** How the connection stands, in a line. */
	#standing(connection: DigitalPostConnection): string {
		if (!connection.connected) return t("Not connected");
		const parts = [
			connection.status === "waiting"
				? t("Connected. Checking Digital Post…")
				: connection.status === "refused"
					? t("Digital Post refused the key. Save the key again.")
					: connection.status === "failed"
						? t("Digital Post wasn't reached at the last try: {reason}", {
								reason: connection.lastError ?? t("no reason given"),
							})
						: connection.fetchedAt
							? t("Connected · checked {when}", { when: fmtTime(connection.fetchedAt) })
							: t("Connected"),
			connection.systemId ? t("system {id}", { id: connection.systemId.slice(0, 8) }) : null,
			connection.letters === 1 ? t("1 letter") : t("{count} letters", { count: connection.letters }),
		];
		return parts.filter((part): part is string => part !== null).join(" · ");
	}

	#steps(connection: DigitalPostConnection): HTMLElement | null {
		const supplier = connection.supplier;
		if (!supplier) return null;
		const admin = digitalPostAdminUrl(supplier.environment);
		return h(
			"div",
			{ class: "digital-post-steps" },
			h(
				"p",
				null,
				t("Set Qorpera up as the company's Digital Post system, in Digital Post's own Administrativ Adgang:"),
			),
			h(
				"ol",
				null,
				h(
					"li",
					null,
					h("a", { href: admin, target: "_blank", rel: "noopener noreferrer" }, t("Open Administrativ Adgang")),
					` ${t("and sign in with MitID Erhverv. You need Digital Post's system administrator right, which the company's rights administrator gives in Rettighedsportalen.")}`,
				),
				h(
					"li",
					null,
					t(
						"Choose Systemtilslutning, Opret system, Opsæt et nyt system. Name it Qorpera and set it up as a Modtagersystem.",
					),
				),
				h(
					"li",
					null,
					t("Choose REST PULL and add these IP addresses:"),
					" ",
					h("code", null, supplier.addresses.join(", ")),
				),
				h(
					"li",
					null,
					t("Under Giv din systemleverandør fuldmagt, type Qorpera's CVR:"),
					" ",
					h("code", null, supplier.cvr),
				),
				h("li", null, t("Activate it now, give a contact email, and press Tilslut.")),
				h("li", null, t("Copy the API key from the receipt and paste it here.")),
			),
			h(
				"p",
				{ class: "digital-post-note" },
				t(
					"From then on, the company's public post comes to Qorpera instead of e-Boks, mit.dk and Virk. A letter Qorpera can't read goes to Virk after seven days.",
				),
			),
		);
	}

	#keyForm(): HTMLElement {
		const field = h("input", {
			type: "password",
			class: "service-token",
			autocomplete: "off",
			spellcheck: "false",
			placeholder: t("Paste the API key"),
			"aria-label": t("Digital Post API key"),
		});
		field.dataset.focusKey = "digital-post-key";
		const save = button(this.#working ? t("Working…") : t("Save key"), () => void this.#save(field.value), {
			primary: true,
			disabled: this.#working,
		});
		return h(
			"form",
			{
				class: "service-token-form",
				onsubmit: (event: Event) => {
					event.preventDefault();
					void this.#save(field.value);
				},
			},
			h("div", { class: "service-token-row" }, field, save),
		);
	}

	#card(): HTMLElement {
		const connection = this.#connection;
		const manage = this.#access.canManage();
		const actions: HTMLElement[] = [];
		const available = connection?.supplier !== undefined;
		if (manage && connection?.connected && connection.secretId) {
			const secretId = connection.secretId;
			const replaceKey = button(
				t("Replace key"),
				() => {
					this.#entering = !this.#entering;
					this.#draw(this.#entering ? "digital-post-key" : undefined);
				},
				{ disabled: this.#working },
			);
			const disconnect = button(
				this.#working ? t("Working…") : t("Disconnect"),
				() => void this.#disconnect(secretId),
				{
					disabled: this.#working,
				},
			);
			disconnect.dataset.focusKey = "digital-post-disconnect";
			actions.push(replaceKey, disconnect);
		} else if (manage && connection && available) {
			const connect = button(
				t("Connect"),
				() => {
					this.#entering = !this.#entering;
					this.#draw(this.#entering ? "digital-post-key" : undefined);
				},
				{ primary: !this.#entering, disabled: this.#working || this.#loading },
			);
			connect.dataset.focusKey = "digital-post-connect";
			actions.push(connect);
		}
		const summary = !connection
			? t("Letters from public authorities, in the Mailbox and the company folder.")
			: connection.connected
				? this.#standing(connection)
				: available
					? t(
							"Letters from public authorities (Skattestyrelsen, Erhvervsstyrelsen, the municipality) arrive in the Mailbox and the company folder, where the agents read them.",
						)
					: t("Not available yet: Qorpera's Digital Post connection is being set up.");
		const children: (HTMLElement | null)[] = [
			h("span", { class: "connection-logo digital-post-logo", "aria-hidden": "true" }, icon("company")),
			h(
				"div",
				{ class: "settings-copy" },
				h("strong", null, t("Digital Post")),
				h("small", null, summary),
				connection?.connected && connection.held > 0
					? h(
							"small",
							{ class: "service-agents" },
							connection.held === 1
								? t("1 letter couldn't be read here; Digital Post puts it in the company's Virk mailbox.")
								: t(
										"{count} letters couldn't be read here; Digital Post puts them in the company's Virk mailbox.",
										{ count: connection.held },
									),
						)
					: null,
				connection?.connected
					? h("small", { class: "service-agents" }, t("Every agent in the company can read the letters."))
					: null,
			),
			h("div", { class: "connection-actions" }, ...actions),
			this.#outcome
				? h(
						"p",
						{ class: `service-outcome ${this.#outcome.tone === "ok" ? "is-ok" : "is-error"}`, role: "status" },
						this.#outcome.text,
					)
				: null,
		];
		if (manage && this.#entering && connection) {
			if (!connection.connected) children.push(this.#steps(connection));
			children.push(this.#keyForm());
		}
		return h("article", { class: "service-card", dataset: { connector: "digital_post" } }, ...children);
	}

	#draw(focusKey?: string): void {
		if (this.#lifetime.signal.aborted) return;
		this.el.hidden = this.#missing || (this.#loading && !this.#connection);
		if (this.el.hidden) {
			replace(this.el);
			return;
		}
		const active = document.activeElement as HTMLElement | null;
		const key = focusKey ?? (this.el.contains(active) ? active?.dataset.focusKey : undefined);
		replace(
			this.el,
			h(
				"div",
				{ class: "connection-section-heading" },
				h("h2", null, t("Digital Post")),
				this.#access.canManage()
					? null
					: h("small", null, t("Only founders and admins can connect or disconnect it.")),
			),
			this.#error ? h("p", { class: "connection-empty service-error", role: "alert" }, this.#error) : "",
			h("div", { class: "connection-list" }, this.#card()),
		);
		if (key) {
			const target = [...this.el.querySelectorAll<HTMLElement>("[data-focus-key]")].find(
				(item) => item.dataset.focusKey === key,
			);
			if (target && !target.matches(":disabled")) target.focus();
		}
	}
}
