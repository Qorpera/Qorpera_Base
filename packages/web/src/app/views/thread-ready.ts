import type { CodeReleaseSite } from "../../cloud/releases.ts";
import { agentFigure } from "../../ui/avatar.ts";
import { h, icon, replace } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import type { CompanyController } from "../company.ts";
import {
	keyOf,
	type ReleaseClient,
	ReleaseDesk,
	type ReleaseDeskOptions,
	readyAgent,
	readyCount,
	titleOf,
} from "./release-desk.ts";
import { siteLinkPill, toClipboard } from "./settings-sites.ts";

/**
 * "A change is ready", in the thread of the agent behind it (Jonas, 15 Nov 2026: "chat widgets if there are UX
 * components we need to add"): the agent says the change is ready, and the member answers it where they are, without
 * going to What's new. One card per project with a change ready from this thread's agent (the Co-Founder's thread when
 * no agent made it, or the agent left: the rule Not yet follows), below the last message, where the saved changes wait.
 *
 * The card is the thread's widget that waits for the member (a question's frame, ui/interaction-card.ts): the agent's
 * figure beside the project's name, the picture of the newest change a customer will notice, large (What's new's own
 * tile, read the same way), its one line, and What's new's count when more ride along. An owner or admin has What's
 * new's own Look first, Put it live and Not yet, which do exactly what What's new's do, with every answer handled the
 * same way: they are What's new's desk (app/views/release-desk.ts), not a copy. Not yet puts "Not yet: " into this
 * thread's composer, where the member already is. Everyone else reads What's new's sentence that says who puts changes
 * live. A site Qorpera took down offers nothing the kernel would refuse, and says so in What's new's words.
 *
 * Once a change went live from here the card settles the way an answered question does: what the agent offered as its
 * bubble, the member's own "Put it live" on their side, and one quiet line, "Version N is live.", with the site's link
 * as the Sites page's pill (copy, open). It stays while this thread is open; nothing is written to the thread.
 */

/** What a card showed when it was last drawn waiting: what it settles on once its change is live. */
interface Shown {
	readonly title: string;
	readonly notice: string;
	readonly token: string;
	readonly url: string | null;
}

/** A change that went live from here: the version, and what the card showed of it. */
interface Settled extends Shown {
	readonly version: number;
}

export class ThreadReady {
	readonly el = h("div", { class: "thread-ready" });
	readonly #company: CompanyController;
	readonly #sessionId: string;
	readonly #agentId: () => string | undefined;
	readonly #focusComposer: () => void;
	readonly #shownChanged: () => void;
	readonly #desk: ReleaseDesk;
	readonly #lifetime = new AbortController();
	/** The change tiles drawn, by what they show: a draw keeps them, and their pictures, as they are. */
	#tiles = new Map<string, HTMLElement>();
	/** The agent's figure, kept while it is the same agent: its motion runs on through a draw. */
	#figure: { key: string; el: HTMLElement } | undefined;
	readonly #lastShown = new Map<string, Shown>();
	readonly #settled = new Map<string, Settled>();
	/** The link of a settled card the browser would not copy, shown whole to copy by hand. */
	#byHand: string | undefined;
	#shown = false;
	#agentDrawn: string | undefined;

	/** `agentId`: this thread's agent, as it is now. `shownChanged`: the card came or went, so the thread draws its items
	 * again. */
	constructor(
		company: CompanyController,
		sessionId: string,
		client: ReleaseClient,
		options: ReleaseDeskOptions,
		signal: AbortSignal,
		hooks: { agentId: () => string | undefined; focusComposer: () => void; shownChanged: () => void },
	) {
		this.#company = company;
		this.#sessionId = sessionId;
		this.#agentId = hooks.agentId;
		this.#focusComposer = hooks.focusComposer;
		this.#shownChanged = hooks.shownChanged;
		if (signal.aborted) this.#lifetime.abort();
		else signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		this.#desk = new ReleaseDesk(company, client, this.#lifetime.signal, options, (focusKey) => this.#draw(focusKey));
		this.#draw();
		void this.#desk.refresh();
	}

	dispose(): void {
		this.#lifetime.abort();
		this.#desk.dispose();
		this.#tiles.clear();
	}

	/** Whether there is a card to show in this thread. */
	get shown(): boolean {
		return this.#shown;
	}

	/** Draws again when the thread's agent became known or changed. */
	update(): void {
		if (this.#agentId() !== this.#agentDrawn) this.#draw();
	}

	/** The projects with a change ready from this thread's agent, in the read's order. */
	#mine(): CodeReleaseSite[] {
		const agentId = this.#agentId();
		const releases = this.#desk.releases;
		if (!agentId || !releases) return [];
		return releases.sites.filter((site) => site.ready && readyAgent(this.#company, site.ready)?.id === agentId);
	}

	#draw(focusKey?: string): void {
		if (this.#lifetime.signal.aborted) return;
		this.#agentDrawn = this.#agentId();
		const active = document.activeElement as HTMLElement | null;
		const key = focusKey ?? (this.el.contains(active) ? active?.dataset.focusKey : undefined);
		const releases = this.#desk.releases;
		// A change put live from here settles its card, with the version the answer (or the read after a lost one) named.
		const outcome = this.#desk.outcome;
		const went = outcome?.live !== undefined ? this.#lastShown.get(outcome.site) : undefined;
		if (outcome?.live !== undefined && went && !this.#settled.has(outcome.site))
			this.#settled.set(outcome.site, { ...went, version: outcome.live });
		const cards: HTMLElement[] = [];
		const tiles = new Map<string, HTMLElement>();
		const drawn = new Set<string>();
		for (const [site, settled] of this.#settled) {
			drawn.add(site);
			const now = releases?.sites.find((item) => keyOf(item) === site);
			cards.push(this.#settledCard(site, settled, now?.site?.url ?? settled.url));
		}
		for (const site of this.#mine()) {
			const ready = site.ready;
			// The change that settled here, still in a read from before it went live: its card has settled.
			if (!ready || this.#settled.get(keyOf(site))?.token === ready.token) continue;
			cards.push(this.#waiting(site, releases?.canRelease === true, tiles));
		}
		this.#tiles = tiles;
		replace(this.el, ...cards);
		const shown = cards.length > 0;
		if (shown !== this.#shown) {
			this.#shown = shown;
			this.#shownChanged();
		}
		if (key) {
			const target = [...this.el.querySelectorAll<HTMLElement>("[data-focus-key]")].find(
				(item) => item.dataset.focusKey === key,
			);
			if (target && !target.matches(":disabled")) target.focus({ preventScroll: true });
		}
	}

	/** The agent's figure at the card's head, beside the project's name. */
	#head(title: string): HTMLElement {
		const agent = this.#company.staffById(this.#agentId());
		const look = JSON.stringify([agent?.id, agent?.appearance, agent?.templateId]);
		if (this.#figure?.key !== look)
			this.#figure = { key: look, el: agentFigure(agent, agent?.displayName ?? "", { size: 30 }) };
		return h(
			"div",
			{ class: "interaction-call" },
			h("span", { class: "interaction-figure" }, this.#figure.el),
			h("strong", null, title),
		);
	}

	/** A project's ready change, waiting for the member. */
	#waiting(site: CodeReleaseSite, can: boolean, tiles: Map<string, HTMLElement>): HTMLElement {
		const ready = site.ready!;
		const key = keyOf(site);
		const desk = this.#desk;
		const title = titleOf(site);
		const newest = ready.changes[0];
		this.#lastShown.set(key, {
			title,
			notice: newest?.notice ?? readyCount(ready),
			token: ready.token,
			url: site.site?.url ?? null,
		});
		let tile: HTMLElement | null = null;
		if (newest) {
			const shown = `${key}\n${JSON.stringify(newest)}`;
			tile = this.#tiles.get(shown) ?? desk.tile(newest, "whats-new-change is-thread");
			tiles.set(shown, tile);
		}
		const total = ready.changes.length + ready.quiet;
		const outcome = desk.outcome?.site === key ? desk.outcome : undefined;
		const said = (where: readonly string[]) =>
			outcome && where.includes(outcome.at)
				? h(
						"p",
						{
							class:
								outcome.tone === "plain"
									? "service-outcome"
									: `service-outcome ${outcome.tone === "ok" ? "is-ok" : "is-error"}`,
							role: "status",
						},
						outcome.text,
					)
				: null;
		const down = desk.down(site);
		return h(
			"article",
			{
				class: "interaction-card is-asking thread-ready-card",
				dataset: { readySite: key },
				"aria-label": title,
			},
			this.#head(title),
			said(["ready"]),
			tile,
			// No change a customer will notice: how many are ready is the card's line.
			newest
				? total > 1
					? h("p", { class: "whats-new-behind" }, readyCount(ready))
					: null
				: h("p", { class: "whats-new-line" }, readyCount(ready)),
			down
				? h(
						"p",
						{ class: "whats-new-managers" },
						t("Qorpera took this site down, so it can't be opened. See why in Sites."),
					)
				: null,
			desk.actions(site, can, desk.look, Boolean(desk.working), down, {
				sessionId: this.#sessionId,
				done: () => {
					if (!this.#lifetime.signal.aborted) this.#focusComposer();
				},
			}),
			said(["live", "actions"]),
		);
	}

	/** A change that went live from here, as the exchange it was: what the agent offered, the member's "Put it live", and
	 * the version live now with the site's link. */
	#settledCard(site: string, settled: Settled, url: string | null): HTMLElement {
		return h(
			"article",
			{ class: "interaction-card is-exchange thread-ready-card is-settled", dataset: { readySite: site } },
			h(
				"div",
				{ class: "interaction-ask bubble" },
				h("h3", { class: "interaction-title" }, settled.title),
				h("p", { class: "interaction-text" }, settled.notice),
			),
			h(
				"p",
				{ class: "interaction-result is-said mine" },
				h("span", { class: "interaction-chosen bubble" }, t("Put it live")),
			),
			h(
				"div",
				{ class: "interaction-result is-done thread-ready-live", role: "status" },
				h("span", { class: "review-mark is-approved", "aria-hidden": "true" }, icon("check")),
				h("span", null, t("Version {version} is live.", { version: String(settled.version) })),
				url ? siteLinkPill(site, url, this.#byHand, () => void this.#copyLink(site, url)) : null,
			),
		);
	}

	/** Copies a settled card's link, as the Sites page's pill does: a check for a moment, or the link whole to copy by
	 * hand when the browser would not. */
	async #copyLink(site: string, url: string): Promise<void> {
		const copied = await toClipboard(url);
		if (this.#lifetime.signal.aborted) return;
		const focusKey = copied ? `site-copy-link:${site}` : `site-by-hand:link:${site}`;
		this.#byHand = copied ? undefined : url;
		this.#draw(focusKey);
		const control = [...this.el.querySelectorAll<HTMLElement>("[data-focus-key]")].find(
			(item) => item.dataset.focusKey === focusKey,
		);
		if (!control) return;
		if (control instanceof HTMLInputElement) control.select();
		else {
			control.classList.add("is-copied");
			setTimeout(() => control.classList.remove("is-copied"), 1600);
		}
	}
}
