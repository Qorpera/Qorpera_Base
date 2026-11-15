import {
	type CompanySite,
	type CompanySitePassword,
	type CompanySiteTakedown,
	siteOfLink,
	type WebSites,
} from "../../cloud/sites.ts";
import { h, replace } from "../../ui/dom.ts";
import { phrase } from "../../ui/preferences.ts";
import { changeError, outdated, pressToCopy, sitePills, siteRow, toClipboard } from "./settings-sites.ts";

/**
 * A site a message links, as a card under the message's words (Jonas, 15 Nov 2026: "chat widgets if there are UX
 * components we need to add"): when an agent's or a member's message links one of the company's own sites (its own
 * host, its old link on sites.qorpera.com, or an app link's host, matched against the company's list: never guessed
 * from the text), the site stands under the words as a row of its own, as an app's card does (ui/markdown.ts). The card
 * is the Sites page's row, compact: the globe, the site's title, its state, its link as a pill to copy and open and, for
 * an owner or admin, its password as a pill, hidden as dots, with the eye to show it (app/views/settings-sites.ts
 * `siteRow`, `sitePills`; the same calls and the same rule for who may see it). A site Qorpera took down says so in the
 * Sites page's sentence with the operator's reason, with no link and no password.
 *
 * The thread reads the company's sites once it opens (only while the company has any) and again when the window comes
 * back. Every card of a site in the thread shows the same: a password shown in one is shown in each, and hidden in each.
 * A password is put on screen only while the member may see passwords, the site is listed and not taken down, and the
 * list does not say it was changed after it; an answer that comes back after the member hid it, or after a newer read,
 * shows nothing (each site's password has a generation, as on the Sites page). What a press could not do is said under
 * that card in one line, until the next press on the site.
 */

export type ThreadSitesClient = Pick<WebSites, "list" | "password"> & Partial<Pick<WebSites, "access">>;

/** How long a pill shows its check after a copy (the Sites page's). */
const COPIED_MS = 1600;

export class ThreadSites {
	readonly #client: ThreadSitesClient;
	readonly #canManage: () => boolean;
	readonly #changed: () => void;
	readonly #lifetime = new AbortController();
	#sites: readonly CompanySite[] = [];
	#takenDown: ReadonlyMap<string, CompanySiteTakedown> = new Map();
	/** What the list says that a card's matching and look follow: a change draws the thread's messages again. */
	#key = "";
	#manage: boolean;
	/** Passwords shown, by site, until hidden or the member's authority goes. */
	readonly #passwords = new Map<string, CompanySitePassword>();
	/** Each site's password generation: one more each time what the thread knows of its password moves on. */
	readonly #eras = new Map<string, number>();
	#working: { site: string; action: "show" | "copy" } | undefined;
	/** A text the browser would not copy, shown whole in its pill, selected for the member to copy by hand. */
	#byHand: { key: string; text: string } | undefined;
	/** What a press on a site could not do, said under its cards until the next press on it. */
	readonly #said = new Map<string, string>();
	/** The cards drawn, each with its site's id: drawn again in place, and let go once it has left the thread. */
	readonly #cards = new Map<HTMLElement, string>();
	#reading: Promise<void> | undefined;

	/** `changed`: the list read changed what the thread's messages show (a link that is a site now, or no longer). */
	constructor(client: ThreadSitesClient, canManage: () => boolean, signal: AbortSignal, changed: () => void) {
		this.#client = client;
		this.#canManage = canManage;
		this.#changed = changed;
		this.#manage = canManage();
		if (signal.aborted) this.#lifetime.abort();
		else signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		window.addEventListener("focus", () => void this.#read(), { signal: this.#lifetime.signal });
		void this.#read();
	}

	dispose(): void {
		this.#lifetime.abort();
		this.#passwords.clear();
		this.#byHand = undefined;
		this.#cards.clear();
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
		const card = h("div", { class: "site-card", dataset: { siteId: site.id } });
		this.#cards.set(card, site.id);
		this.#draw(card, site.id);
		return card;
	}

	/** Draws the cards again when the member's authority changed (the team read after the thread, or a role change); a
	 * member who is no longer an owner or admin keeps no password on screen. */
	update(): void {
		if (this.#lifetime.signal.aborted) return;
		const manage = this.#canManage();
		if (manage === this.#manage) return;
		this.#manage = manage;
		// Every site's password moves on, so a read still out shows nothing when it answers.
		if (!manage)
			for (const site of new Set([...this.#passwords.keys(), ...this.#sites.map((item) => item.id)]))
				this.#forget(site);
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
				const byId = new Map(sites.map((site) => [site.id, site]));
				// A site gone or taken down shows no password, and one changed since it was shown (elsewhere) leaves the screen.
				for (const [id, shown] of [...this.#passwords]) {
					const site = byId.get(id);
					if (!site || outdated(site, shown) || this.#takenDown.has(id)) this.#forget(id);
				}
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

	#forget(site: string): void {
		this.#passwords.delete(site);
		if (this.#byHand?.key === `password:${site}`) this.#byHand = undefined;
		this.#eras.set(site, (this.#eras.get(site) ?? 0) + 1);
	}

	/** Puts a password on screen, unless the member may not see passwords, the site is not listed or taken down, or the
	 * list says it was changed after it. */
	#reveal(id: string, password: CompanySitePassword): boolean {
		const listed = this.#sites.find((site) => site.id === id);
		if (!this.#canManage() || !listed || this.#takenDown.has(id) || outdated(listed, password)) return false;
		this.#passwords.set(id, password);
		this.#eras.set(id, (this.#eras.get(id) ?? 0) + 1);
		return true;
	}

	/** Draws every card again; the one pressed (`within`) puts the keyboard on `focusKey`. */
	#drawAll(focusKey?: string, within?: HTMLElement): void {
		for (const [card, id] of [...this.#cards]) {
			// A card that stood in the thread and left it (its message drawn again) is let go.
			if (!card.isConnected && card.dataset.placed) this.#cards.delete(card);
			else this.#draw(card, id, card === within ? focusKey : undefined);
		}
	}

	#draw(card: HTMLElement, id: string, focusKey?: string): void {
		if (this.#lifetime.signal.aborted) return;
		const site = this.#sites.find((item) => item.id === id);
		if (!site) return;
		if (card.isConnected) card.dataset.placed = "1";
		const active = document.activeElement as HTMLElement | null;
		const key = focusKey ?? (card.contains(active) ? active?.dataset.focusKey : undefined);
		const down = this.#takenDown.get(id);
		const manage = this.#canManage();
		const shown = this.#passwords.get(id);
		const said = this.#said.get(id);
		replace(
			card,
			siteRow(site, down, {
				classes: ["is-thread"],
				share: () =>
					sitePills(site, {
						manage,
						busy: Boolean(this.#working),
						reading: this.#working?.site === id,
						password: shown?.password,
						byHandLink: this.#byHand?.key === `link:${id}` ? this.#byHand.text : undefined,
						byHandPassword: this.#byHand?.key === `password:${id}` ? this.#byHand.text : undefined,
						copyLink: () => void this.#copyLink(site, card),
						copyPassword: () => void this.#copyPassword(site, card),
						eye: () => (shown ? this.#hide(id, card) : void this.#show(site, card)),
					}),
			}),
			said ? h("p", { class: "service-outcome is-error site-card-said", role: "status" }, said) : null,
		);
		if (key) {
			const target = [...card.querySelectorAll<HTMLElement>("[data-focus-key]")].find(
				(item) => item.dataset.focusKey === key,
			);
			if (target && !target.matches(":disabled")) target.focus({ preventScroll: true });
		}
	}

	#control(card: HTMLElement, focusKey: string): HTMLElement | undefined {
		return [...card.querySelectorAll<HTMLElement>("[data-focus-key]")].find(
			(item) => item.dataset.focusKey === focusKey,
		);
	}

	/** A pill's check, for a moment after its text was copied. */
	#copied(card: HTMLElement, focusKey: string): void {
		const pill = this.#control(card, focusKey);
		if (!pill) return;
		pill.classList.add("is-copied");
		setTimeout(() => pill.classList.remove("is-copied"), COPIED_MS);
	}

	/** The browser would not copy: the text is shown whole in its pill, selected, and the line says what to press. */
	#byHandIn(card: HTMLElement, id: string, key: string, text: string, focusKey: string): void {
		this.#byHand = { key, text };
		this.#said.set(id, pressToCopy());
		this.#drawAll(focusKey, card);
		const field = this.#control(card, focusKey);
		if (field instanceof HTMLInputElement) {
			field.focus({ preventScroll: true });
			field.select();
		}
	}

	async #copyLink(site: CompanySite, card: HTMLElement): Promise<void> {
		const focusKey = `site-copy-link:${site.id}`;
		this.#said.delete(site.id);
		const copied = await toClipboard(site.url);
		if (this.#lifetime.signal.aborted) return;
		if (!copied) return this.#byHandIn(card, site.id, `link:${site.id}`, site.url, `site-by-hand:link:${site.id}`);
		if (this.#byHand?.key === `link:${site.id}`) this.#byHand = undefined;
		this.#drawAll(focusKey, card);
		this.#copied(card, focusKey);
	}

	async #show(site: CompanySite, card: HTMLElement): Promise<void> {
		if (this.#working || this.#lifetime.signal.aborted) return;
		const focusKey = `site-eye:${site.id}`;
		const era = this.#eras.get(site.id) ?? 0;
		this.#said.delete(site.id);
		const working = { site: site.id, action: "show" } as const;
		this.#working = working;
		this.#drawAll(focusKey, card);
		let password: CompanySitePassword | undefined;
		let failure: unknown;
		try {
			password = await this.#client.password(site.id, this.#lifetime.signal);
		} catch (error) {
			failure = error;
		}
		if (this.#working === working) this.#working = undefined;
		if (this.#lifetime.signal.aborted) return;
		// Hidden, changed or taken away meanwhile, or the member's authority gone: the answer shows nothing.
		if (password && (this.#eras.get(site.id) ?? 0) === era) this.#reveal(site.id, password);
		else if (!password)
			this.#said.set(site.id, changeError(failure, phrase("The password could not be read. Try again.")));
		this.#drawAll(focusKey, card);
	}

	#hide(id: string, card: HTMLElement): void {
		this.#forget(id);
		this.#said.delete(id);
		this.#drawAll(`site-eye:${id}`, card);
	}

	/** Copies a site's password: the one shown, or one read for it there and then (it stays hidden). */
	async #copyPassword(site: CompanySite, card: HTMLElement): Promise<void> {
		if (this.#working || this.#lifetime.signal.aborted) return;
		const focusKey = `site-copy-password:${site.id}`;
		const byHand = `site-by-hand:password:${site.id}`;
		const era = this.#eras.get(site.id) ?? 0;
		this.#said.delete(site.id);
		const shown = this.#passwords.get(site.id);
		if (shown) {
			const copied = await toClipboard(shown.password);
			if (this.#lifetime.signal.aborted || (this.#eras.get(site.id) ?? 0) !== era) return;
			if (!copied) return this.#byHandIn(card, site.id, `password:${site.id}`, shown.password, byHand);
			this.#drawAll(focusKey, card);
			this.#copied(card, focusKey);
			return;
		}
		const working = { site: site.id, action: "copy" } as const;
		this.#working = working;
		this.#drawAll(focusKey, card);
		const read = this.#client.password(site.id, this.#lifetime.signal);
		const copied = await toClipboard(read.then((answer) => answer.password));
		let password: CompanySitePassword | undefined;
		let failure: unknown;
		try {
			password = await read;
		} catch (error) {
			failure = error;
		}
		if (this.#working === working) this.#working = undefined;
		if (this.#lifetime.signal.aborted) return;
		if ((this.#eras.get(site.id) ?? 0) !== era) return this.#drawAll();
		if (!password) {
			this.#said.set(site.id, changeError(failure, phrase("The password could not be read. Try again.")));
			this.#drawAll();
			return;
		}
		if (!copied) {
			if (!this.#reveal(site.id, password)) return this.#drawAll();
			this.#drawAll();
			return this.#byHandIn(card, site.id, `password:${site.id}`, password.password, byHand);
		}
		this.#drawAll(focusKey, card);
		this.#copied(card, focusKey);
	}
}
