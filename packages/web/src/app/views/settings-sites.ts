import { CloudRpcError } from "../../cloud/client.ts";
import type { CompanySite, CompanySitePassword, WebSites } from "../../cloud/sites.ts";
import { button, confirmDialog, fmtBytes, fmtTime, h, icon, replace } from "../../ui/dom.ts";
import { phrase, t } from "../../ui/preferences.ts";

/**
 * Settings → Sites: the websites the company's agents published, each at its own link on sites.qorpera.com with its
 * own password. Every member sees each site's name, link, state, when and by which agent it was last published, and
 * where in the Company File it came from. An owner or admin also reads a site's password (to share it), changes it
 * (every visitor then enters the new one) and takes a site offline; the kernel refuses anyone else. Agents never see a
 * password.
 */

type SitesClient = Pick<WebSites, "list" | "password" | "setPassword" | "unpublish">;

export interface SitesAccess {
	/** Whether the signed-in member may see passwords, change them and take sites offline (owner or admin; the
	 * kernel enforces the same rule). */
	canManage(): boolean;
}

const FULL_ACCESS: SitesAccess = { canManage: () => true };
const MANAGERS_ONLY = phrase("Only founders and admins can see passwords or take sites offline.");

/** A site as members call it: its title, else its name in the link. */
function nameOf(site: CompanySite): string {
	return site.title ?? site.slug;
}

/** Why a change was refused, in the interface language. */
function changeError(error: unknown, fallback: string): string {
	const code = error instanceof CloudRpcError ? error.code : undefined;
	if (code === "42501") return t(MANAGERS_ONLY);
	if (code === "22023") return t("A site password is 10 to 128 characters.");
	return t(fallback);
}

/** A password a member typed, checked as the kernel checks it; the problem, or undefined. */
function passwordProblem(password: string): string | undefined {
	const length = [...password].length;
	return length < 10 || length > 128 || /\p{Cc}/u.test(password) || !password.trim()
		? t("A site password is 10 to 128 characters.")
		: undefined;
}

export class SitesView {
	readonly el = h("div", { class: "sites" });
	readonly #client: SitesClient;
	readonly #lifetime = new AbortController();
	readonly #access: SitesAccess;
	#drawnManage: boolean | undefined;
	#sites: CompanySite[] | undefined;
	#loading = true;
	#error: string | undefined;
	/** The site changing, and how, while it does. */
	#working: { site: string; action: "show" | "set" | "unpublish" } | undefined;
	/** Passwords shown, by site, until hidden or the member's authority goes. */
	readonly #passwords = new Map<string, CompanySitePassword>();
	/** The site whose change-password form is open, and what is typed in it. */
	#changing: string | undefined;
	#draft = "";
	/** The last action's outcome, under its site's card. */
	#outcome: { key: string; tone: "ok" | "error"; text: string } | undefined;
	#refreshing: Promise<void> | undefined;
	/** One more read, asked for while a read was out, and the focus it draws with. */
	#again: { read: Promise<void>; focusKey: string | undefined } | undefined;

	constructor(client: SitesClient, signal: AbortSignal, options: { access?: SitesAccess } = {}) {
		this.#client = client;
		this.#access = options.access ?? FULL_ACCESS;
		if (signal.aborted) this.#lifetime.abort();
		else signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		this.#draw();
		void this.#refresh();
	}

	/** Redraws when the member's authority over the company's sites changed (the team loads after the page, or a role
	 * changes while it is open). A member who is no longer an owner or admin keeps no password on screen. */
	update(): void {
		if (this.#lifetime.signal.aborted || this.#access.canManage() === this.#drawnManage) return;
		if (!this.#access.canManage()) {
			this.#passwords.clear();
			this.#changing = undefined;
			this.#draft = "";
		}
		this.#draw();
	}

	dispose(): void {
		this.#lifetime.abort();
		this.#passwords.clear();
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
			const sites = await this.#client.list(this.#lifetime.signal);
			if (this.#lifetime.signal.aborted) return;
			this.#sites = sites;
			this.#error = undefined;
			// A site gone meanwhile (taken offline elsewhere) leaves nothing of its own behind.
			const ids = new Set(sites.map((site) => site.id));
			for (const id of this.#passwords.keys()) if (!ids.has(id)) this.#passwords.delete(id);
			if (this.#changing && !ids.has(this.#changing)) this.#changing = undefined;
		} catch {
			if (this.#lifetime.signal.aborted) return;
			this.#error = t("The company's sites could not be read.");
		} finally {
			this.#loading = false;
			if (!this.#lifetime.signal.aborted) this.#draw(focusKey);
		}
	}

	/** Runs one action on a site, every card's buttons off meanwhile; a refusal shows under its card. A change
	 * (`read`), and any failure, reads the list again afterwards. */
	async #act(
		site: CompanySite,
		action: "show" | "set" | "unpublish",
		work: () => Promise<void>,
		fallback: string,
		focusKey: string,
		read: boolean,
	): Promise<void> {
		if (this.#working || this.#lifetime.signal.aborted) return;
		this.#working = { site: site.id, action };
		this.#outcome = undefined;
		this.#draw();
		let drawn = focusKey;
		let again = read;
		try {
			await work();
		} catch (error) {
			if (this.#lifetime.signal.aborted) return;
			this.#outcome = { key: site.id, tone: "error", text: changeError(error, fallback) };
			// The focus stays on what the member pressed. The site may be gone (taken offline elsewhere): the read
			// drops it.
			drawn =
				action === "show"
					? `site-show-password:${site.id}`
					: action === "set"
						? `site-password-input:${site.id}`
						: `site-unpublish:${site.id}`;
			again = true;
		} finally {
			this.#working = undefined;
			if (!this.#lifetime.signal.aborted) this.#draw(drawn);
		}
		if (again) await this.#refresh(drawn);
	}

	#showPassword(site: CompanySite): Promise<void> {
		return this.#act(
			site,
			"show",
			async () => {
				const password = await this.#client.password(site.id, this.#lifetime.signal);
				if (!this.#lifetime.signal.aborted && this.#access.canManage()) this.#passwords.set(site.id, password);
			},
			phrase("The password could not be read. Try again."),
			`site-copy-password:${site.id}`,
			false,
		);
	}

	#hidePassword(site: CompanySite): void {
		this.#passwords.delete(site.id);
		if (this.#outcome?.key === site.id) this.#outcome = undefined;
		this.#draw(`site-show-password:${site.id}`);
	}

	/** Opens or closes a site's change-password form. */
	#toggleChange(site: CompanySite): void {
		const open = this.#changing === site.id;
		this.#changing = open ? undefined : site.id;
		this.#draft = "";
		if (this.#outcome?.key === site.id) this.#outcome = undefined;
		this.#draw(open ? `site-change:${site.id}` : `site-password-input:${site.id}`);
	}

	/** Sets the password: the one typed, or (null) a new random one. */
	#setPassword(site: CompanySite, password: string | null): Promise<void> {
		if (password !== null) {
			const problem = passwordProblem(password);
			if (problem) {
				this.#outcome = { key: site.id, tone: "error", text: problem };
				this.#draw(`site-password-input:${site.id}`);
				return Promise.resolve();
			}
		}
		return this.#act(
			site,
			"set",
			async () => {
				const next = await this.#client.setPassword(site.id, password, this.#lifetime.signal);
				if (this.#lifetime.signal.aborted) return;
				this.#changing = undefined;
				this.#draft = "";
				if (this.#access.canManage()) this.#passwords.set(site.id, next);
				this.#outcome = {
					key: site.id,
					tone: "ok",
					text: t("The password is changed. Every visitor enters the new one."),
				};
			},
			phrase("The password could not be changed. Try again."),
			`site-copy-password:${site.id}`,
			true,
		);
	}

	async #unpublish(site: CompanySite): Promise<void> {
		if (this.#working || this.#lifetime.signal.aborted) return;
		if (
			!(await confirmDialog(
				t(
					"Take {name} offline? Its link stops working and its password is deleted. The files stay in the Company File.",
					{ name: nameOf(site) },
				),
				t("Unpublish"),
				true,
				undefined,
				this.#lifetime.signal,
			))
		)
			return;
		await this.#act(
			site,
			"unpublish",
			async () => {
				await this.#client.unpublish(site.id, this.#lifetime.signal);
				if (this.#lifetime.signal.aborted) return;
				this.#passwords.delete(site.id);
				if (this.#changing === site.id) this.#changing = undefined;
				// It leaves the list at once; the read after it confirms it.
				this.#sites = this.#sites?.filter((item) => item.id !== site.id);
			},
			phrase("The site could not be taken offline. Try again."),
			`site-unpublish:${site.id}`,
			true,
		);
	}

	async #copy(site: CompanySite, text: string, kind: "link" | "password"): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
			this.#outcome = {
				key: site.id,
				tone: "ok",
				text: kind === "link" ? t("The link is copied.") : t("The password is copied."),
			};
		} catch {
			this.#outcome = {
				key: site.id,
				tone: "error",
				text:
					kind === "link"
						? t("The link could not be copied. Select it and copy it.")
						: t("The password could not be copied. Select it and copy it."),
			};
		}
		if (!this.#lifetime.signal.aborted) this.#draw(`site-copy-${kind}:${site.id}`);
	}

	/** The site's state: live or still publishing, when and by whom it was last published, and how big it is. */
	#state(site: CompanySite): string {
		const files = site.files === 1 ? t("1 file") : t("{count} files", { count: String(site.files) });
		return [
			site.state === "live" ? t("Live") : t("Publishing…"),
			site.publishedAt
				? site.publishedBy
					? t("Published {time} by {agent}", { time: fmtTime(site.publishedAt), agent: site.publishedBy.name })
					: t("Published {time}", { time: fmtTime(site.publishedAt) })
				: "",
			`${files}, ${fmtBytes(site.bytes)}`,
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

	/** A row of the card: a value in a code box, its buttons, and a line under it. */
	#row(value: HTMLElement, buttons: HTMLElement[], note?: string): HTMLElement {
		return h(
			"div",
			{ class: "hook-address" },
			h("div", { class: "hook-address-row" }, h("code", null, value), ...buttons),
			note ? h("small", null, note) : null,
		);
	}

	#changeForm(site: CompanySite): HTMLElement {
		const busy = Boolean(this.#working);
		const input = h("input", {
			type: "text",
			class: "service-token",
			value: this.#draft,
			maxlength: "128",
			autocomplete: "off",
			autocapitalize: "none",
			spellcheck: "false",
			placeholder: t("Type a new password, 10 to 128 characters"),
			"aria-label": t("New password for {name}", { name: nameOf(site) }),
			oninput: () => {
				this.#draft = input.value;
			},
		});
		input.dataset.focusKey = `site-password-input:${site.id}`;
		const save = h(
			"button",
			{ type: "submit", class: "btn btn-primary", disabled: busy },
			this.#working?.site === site.id && this.#working.action === "set" ? t("Working…") : t("Save password"),
		);
		save.dataset.focusKey = `site-password-save:${site.id}`;
		const random = button(t("Make a new password"), () => void this.#setPassword(site, null), { disabled: busy });
		random.dataset.focusKey = `site-password-random:${site.id}`;
		const cancel = button(t("Cancel"), () => this.#toggleChange(site), { disabled: busy });
		return h(
			"form",
			{
				id: `site-password-form-${site.id}`,
				class: "service-token-form",
				onsubmit: (event: Event) => {
					event.preventDefault();
					void this.#setPassword(site, this.#draft);
				},
			},
			h("div", { class: "service-token-row" }, input, save),
			h("div", { class: "hook-form-actions" }, random, cancel),
			h("small", null, t("Every visitor enters the new password; the old one stops working at once.")),
		);
	}

	#card(site: CompanySite): HTMLElement {
		const manage = this.#access.canManage();
		const busy = Boolean(this.#working);
		const shown = manage ? this.#passwords.get(site.id) : undefined;
		const actions: HTMLElement[] = [];
		if (manage) {
			if (!shown) {
				const show = button(
					this.#working?.site === site.id && this.#working.action === "show" ? t("Working…") : t("Show password"),
					() => void this.#showPassword(site),
					{ disabled: busy },
				);
				show.dataset.focusKey = `site-show-password:${site.id}`;
				actions.push(show);
			}
			const change = button(t("Change password"), () => this.#toggleChange(site), { disabled: busy });
			change.dataset.focusKey = `site-change:${site.id}`;
			change.setAttribute("aria-expanded", String(this.#changing === site.id));
			change.setAttribute("aria-controls", `site-password-form-${site.id}`);
			const unpublish = button(
				this.#working?.site === site.id && this.#working.action === "unpublish" ? t("Working…") : t("Unpublish"),
				() => void this.#unpublish(site),
				{ danger: true, disabled: busy },
			);
			unpublish.dataset.focusKey = `site-unpublish:${site.id}`;
			actions.push(change, unpublish);
		}
		const copyLink = button([icon("copy"), t("Copy")], () => void this.#copy(site, site.url, "link"), {
			small: true,
		});
		copyLink.dataset.focusKey = `site-copy-link:${site.id}`;
		const link = h("a", { href: site.url, target: "_blank", rel: "noopener noreferrer" }, site.url);
		let password: HTMLElement | null = null;
		if (shown) {
			const copy = button([icon("copy"), t("Copy")], () => void this.#copy(site, shown.password, "password"), {
				small: true,
			});
			copy.dataset.focusKey = `site-copy-password:${site.id}`;
			const hide = button(t("Hide"), () => this.#hidePassword(site), { small: true });
			hide.dataset.focusKey = `site-hide-password:${site.id}`;
			password = this.#row(
				h("span", { class: "site-password" }, shown.password),
				[copy, hide],
				t("Share the link and this password only with the people who should see the site."),
			);
		}
		return h(
			"article",
			{ class: "service-card hook-card site-card", dataset: { site: site.id }, "aria-label": nameOf(site) },
			h("span", { class: "hook-icon" }, icon("globe")),
			h(
				"div",
				{ class: "settings-copy" },
				h("strong", null, nameOf(site)),
				h("small", { class: "hook-state" }, this.#state(site)),
				site.source ? h("small", null, t("From {source}", { source: site.source })) : null,
			),
			h("div", { class: "connection-actions" }, ...actions),
			this.#row(link, [copyLink]),
			password,
			manage && this.#changing === site.id ? this.#changeForm(site) : null,
			this.#outcomeLine(site.id),
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
			retry.dataset.focusKey = "site-retry";
			error = h("p", { class: "connection-empty service-error", role: "alert" }, this.#error, " ", retry);
		}
		const sites = this.#sites ?? [];
		replace(
			this.el,
			error,
			// Without a first read there is nothing to show but the way to try again.
			this.#sites || this.#loading
				? h(
						"section",
						{ class: "settings-group", dataset: { sites: "list" } },
						this.#access.canManage()
							? null
							: h("div", { class: "connection-section-heading" }, h("small", null, t(MANAGERS_ONLY))),
						h(
							"div",
							{ class: "connection-list" },
							...sites.map((site) => this.#card(site)),
							this.#loading
								? h("p", { class: "connection-empty muted", role: "status" }, t("Checking…"))
								: sites.length
									? null
									: h(
											"p",
											{ class: "connection-empty muted" },
											t(
												"No sites yet. When an agent publishes a website for the company, it shows here with its link and password.",
											),
										),
						),
					)
				: null,
		);
		if (key) {
			const target = [...this.el.querySelectorAll<HTMLElement>("[data-focus-key]")].find(
				(item) => item.dataset.focusKey === key,
			);
			if (target && !target.matches(":disabled")) target.focus();
		}
	}
}
