import { type CompanySite, type CompanySiteTakedown, siteOfLink, type WebSites } from "../../cloud/sites.ts";
import { h, icon, replace } from "../../ui/dom.ts";
import { phrase, t } from "../../ui/preferences.ts";
import { changeError, hasPassword, shownLink, siteEmblem, stateOf, toClipboard } from "./settings-sites.ts";

/**
 * A site a message links, as a card under the message's words (Jonas, 15 Nov 2026: "chat widgets if there are UX
 * components we need to add"): when an agent's or a member's message links one of the company's own sites (its own
 * host, its old link on sites.qorpera.com, or an app link's host, matched against the company's list: never guessed
 * from the text), the site stands under the words as a row of its own, a sibling of an app's card (ui/markdown.ts
 * `appCard`, its frame, size and hover): the Sites globe, the site's title with its state, its address under it, and
 * a press anywhere on it opens the site in a new tab. A thread is calm, so the card is one row and shows each thing
 * once (the lead's review, 15 Nov 2026): no pills in it, and no password on screen. An owner or admin has one key on
 * it that copies the password, read with the Sites page's own call; the address line says so for a moment. A site
 * Qorpera took down is the same row, grey, "Taken down", with the operator's reason as its line; it leads to the
 * Sites page, where the whole sentence and the way to tell Qorpera are.
 *
 * The thread reads the company's sites once it opens (only while the company has any) and again when the window comes
 * back; every card of a site in the thread follows the last read that answered.
 */

export type ThreadSitesClient = Pick<WebSites, "list" | "password"> & Partial<Pick<WebSites, "access">>;

/** How long the address line says what a press on the key did. */
const SAID_MS = 2000;

export class ThreadSites {
	readonly #client: ThreadSitesClient;
	readonly #canManage: () => boolean;
	readonly #changed: () => void;
	readonly #profileId: string;
	readonly #lifetime = new AbortController();
	#sites: readonly CompanySite[] = [];
	#takenDown: ReadonlyMap<string, CompanySiteTakedown> = new Map();
	/** What the list says that a card's matching follows: a change draws the thread's messages again. */
	#key = "";
	#manage: boolean;
	/** The site whose password is being read and copied: its key is off meanwhile. */
	#copying: string | undefined;
	/** What a press on a site's key did, said on its address line for a moment. */
	readonly #said = new Map<string, { text: string; error: boolean }>();
	/** The cards drawn, each with its site's id: drawn again in place, and let go once it has left the thread. */
	readonly #cards = new Map<HTMLElement, string>();
	#reading: Promise<void> | undefined;

	/** `changed`: the list read changed what the thread's messages show (a link that is a site now, or no longer).
	 * `profileId`: the company, for the way to its Sites page. */
	constructor(
		client: ThreadSitesClient,
		canManage: () => boolean,
		profileId: string,
		signal: AbortSignal,
		changed: () => void,
	) {
		this.#client = client;
		this.#canManage = canManage;
		this.#profileId = profileId;
		this.#changed = changed;
		this.#manage = canManage();
		if (signal.aborted) this.#lifetime.abort();
		else signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		window.addEventListener("focus", () => void this.#read(), { signal: this.#lifetime.signal });
		void this.#read();
	}

	dispose(): void {
		this.#lifetime.abort();
		this.#cards.clear();
		this.#said.clear();
	}

	/** What a message's links are matched against: part of the key of each message that has a link. */
	get key(): string {
		return this.#key;
	}

	/** The company's site a link leads to, or undefined. */
	match(href: string): CompanySite | undefined {
		return siteOfLink(this.#sites, href);
	}

	/** A card for a site, drawn now and again whenever what it shows changes. */
	card(site: CompanySite): HTMLElement {
		const card = h("div", { class: "app-card site-card", dataset: { siteId: site.id } });
		this.#cards.set(card, site.id);
		this.#draw(card, site.id);
		return card;
	}

	/** Draws the cards again when the member's authority changed (the team read after the thread, or a role change): the
	 * key is an owner's or admin's alone. */
	update(): void {
		if (this.#lifetime.signal.aborted) return;
		const manage = this.#canManage();
		if (manage === this.#manage) return;
		this.#manage = manage;
		this.#drawAll();
	}

	#read(): Promise<void> {
		this.#reading ??= (async () => {
			try {
				// Which sites Qorpera took down, read beside the list; a read that fails keeps what the last one said.
				const access = this.#client.access?.(this.#lifetime.signal).catch(() => undefined);
				const sites = await this.#client.list(this.#lifetime.signal);
				const read = await access;
				if (this.#lifetime.signal.aborted) return;
				if (read) this.#takenDown = read.takenDown;
				this.#sites = sites;
				const key = JSON.stringify(sites.map((site) => [site.id, site.slug, site.kind, site.url]));
				if (key !== this.#key) {
					this.#key = key;
					this.#changed();
				}
				this.#drawAll();
			} catch {
				// No answer: the cards keep what the last read said.
			} finally {
				this.#reading = undefined;
			}
		})();
		return this.#reading;
	}

	/** Draws every card again; the keyboard stays on the key it was on. A card not in the page is let go: its message was
	 * drawn again, or left the thread. Every redraw comes after the task that made a card and put it in its message (a
	 * read, the window's focus, a change of role, a key's line), so a card that is not in the page by then never will be
	 * (review r1 of #1848, F2). */
	#drawAll(): void {
		for (const [card, id] of [...this.#cards]) {
			if (!card.isConnected) this.#cards.delete(card);
			else this.#draw(card, id);
		}
	}

	/** How many cards the thread keeps drawing (for its tests). */
	get drawn(): number {
		return this.#cards.size;
	}

	#draw(card: HTMLElement, id: string): void {
		if (this.#lifetime.signal.aborted) return;
		const site = this.#sites.find((item) => item.id === id);
		if (!site) return;
		const keyed = card.contains(document.activeElement) && document.activeElement?.matches(".site-card-key");
		const down = this.#takenDown.get(id);
		const name = site.title ?? site.slug;
		const said = down ? undefined : this.#said.get(id);
		const reason = down?.reason.replace(/[\s.]+$/, "") || down?.reason;
		card.classList.toggle("is-down", Boolean(down));
		// The whole row opens the site (or, taken down, the Sites page); the key stands above it, a control of its own.
		const open = h(
			"a",
			{
				class: "site-card-open",
				...(down
					? { href: `#/c/${this.#profileId}/sites` }
					: { href: site.url, target: "_blank", rel: "noopener noreferrer" }),
				"aria-label": down ? `${name}. ${t("Taken down")}. ${reason}` : t("Open {name}", { name }),
			},
			h("span", { class: "app-card-emblem", "aria-hidden": "true" }, siteEmblem()),
			h(
				"span",
				{ class: "app-card-copy" },
				h(
					"span",
					{ class: "site-card-head" },
					h("strong", { class: "app-card-title", title: name }, name),
					stateOf(site, Boolean(down)),
				),
				h(
					"small",
					{
						class: `app-card-note${said ? (said.error ? " is-error" : " is-said") : ""}`,
						title: down ? reason : site.url,
						...(said ? { role: "status" } : {}),
					},
					said?.text ?? (down ? reason : shownLink(site.url)),
				),
			),
		);
		let key: HTMLButtonElement | null = null;
		if (!down && this.#canManage() && hasPassword(site)) {
			key = h(
				"button",
				{
					type: "button",
					class: "site-pill-icon site-card-key",
					title: t("Copy the password"),
					"aria-label": t("Copy the password"),
					disabled: this.#copying === id,
					onclick: () => void this.#copyPassword(site),
				},
				icon("key"),
			);
		}
		replace(
			card,
			open,
			key,
			down ? null : h("span", { class: "app-card-go", "aria-hidden": "true" }, icon("external")),
		);
		if (keyed && key && !key.disabled) key.focus({ preventScroll: true });
	}

	/** Says on a site's address line what its key did, for a moment. */
	#say(id: string, text: string, error: boolean): void {
		const said = { text, error };
		this.#said.set(id, said);
		this.#drawAll();
		setTimeout(() => {
			if (this.#said.get(id) !== said || this.#lifetime.signal.aborted) return;
			this.#said.delete(id);
			this.#drawAll();
		}, SAID_MS);
	}

	/** Copies a site's password, read for it there and then with the Sites page's call: it never shows in the thread. The
	 * read is handed to the clipboard as it is read, where the browser takes that, so the copy keeps the press (Safari
	 * copies only within it). A browser that will not copy it sends the member to Sites, where the password is. */
	async #copyPassword(site: CompanySite): Promise<void> {
		if (this.#copying || this.#lifetime.signal.aborted || !this.#canManage() || !hasPassword(site)) return;
		this.#copying = site.id;
		this.#said.delete(site.id);
		this.#drawAll();
		const read = this.#client.password(site.id, this.#lifetime.signal);
		const copied = await toClipboard(read.then((answer) => answer.password));
		let failure: unknown;
		let answered = false;
		try {
			await read;
			answered = true;
		} catch (error) {
			failure = error;
		}
		this.#copying = undefined;
		if (this.#lifetime.signal.aborted) return;
		if (!answered)
			this.#say(site.id, changeError(failure, phrase("The password could not be read. Try again.")), true);
		else if (!copied) this.#say(site.id, t("The password is in Sites."), true);
		else this.#say(site.id, t("The password is copied."), false);
	}
}
