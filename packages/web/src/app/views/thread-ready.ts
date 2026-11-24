import type { CodeReleaseSite, CodeReleases } from "../../cloud/releases.ts";
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
	titleOf,
} from "./release-desk.ts";
import { shownLink } from "./site-shared.ts";

/**
 * "A change is ready", in the thread of the agent behind it (Jonas, 15 Nov 2026: "chat widgets if there are UX
 * components we need to add"): the agent says the change is ready, and the member answers it where they are, without
 * going to What's new. One card per project with a change ready from this thread's agent (the Co-Founder's thread when
 * no agent made it, or the agent left: the rule Not yet follows), below the last message, where the saved changes wait.
 *
 * The card is the thread's widget that waits for the member (a question's frame and width, ui/interaction-card.ts),
 * one thing shown once (the lead's review, 15 Nov 2026): the agent's figure and "Ready to go live" in the accent (the
 * project's name after it, quiet, only where the company has several), the picture of the newest change a customer
 * will notice, large (What's new's own tile, read the same way), its one line, and when more ride along "and N more
 * changes" as the way to What's new. An owner or admin has What's new's own Look first, Put it live and Not yet, which
 * do exactly what What's new's do, with every answer handled the same way: they are What's new's desk
 * (app/views/release-desk.ts), not a copy. Not yet puts "Not yet: " into this thread's composer, where the member
 * already is. Everyone else reads What's new's sentence that says who puts changes live. A site Qorpera took down has
 * no card, as nothing on it could be done: one quiet line in What's new's words leads to Sites.
 *
 * Once a change went live from here the card settles the way an answered question does: what the agent offered as its
 * bubble, the member's own "Put it live" on their side, and one quiet line, "Version N is live.", with the site's
 * address as a plain link. It stays while this thread is open; nothing is written to the thread.
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
	#shown = false;
	#agentDrawn: string | undefined;

	/** `agentId`: this thread's agent, as it is now. `shownChanged`: the card came or went, so the thread draws its items
	 * again. `last`: the company's last read, drawn at once; without one, the card reads. */
	constructor(
		company: CompanyController,
		sessionId: string,
		client: ReleaseClient,
		options: ReleaseDeskOptions,
		signal: AbortSignal,
		hooks: {
			agentId: () => string | undefined;
			focusComposer: () => void;
			shownChanged: () => void;
			/** The company's last read, which the card starts from without a read of its own. */
			last?: () => CodeReleases | undefined;
		},
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
		const last = hooks.last?.();
		if (last) this.#desk.seed(last);
		else void this.#desk.refresh();
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
		// Only where the company has more than one project that makes a site does a card say which one it is.
		const several = (releases?.sites.length ?? 0) > 1;
		// A change put live from here settles its card, with the version the answer (or the read after a lost one) named.
		const outcome = this.#desk.outcome;
		const went = outcome?.live !== undefined ? this.#lastShown.get(outcome.site) : undefined;
		if (outcome?.live !== undefined && went && !this.#settled.has(outcome.site))
			this.#settled.set(outcome.site, { ...went, version: outcome.live });
		const cards: HTMLElement[] = [];
		const tiles = new Map<string, HTMLElement>();
		for (const [site, settled] of this.#settled) {
			const now = releases?.sites.find((item) => keyOf(item) === site);
			cards.push(this.#settledCard(site, settled, now?.site?.url ?? settled.url, several));
		}
		for (const site of this.#mine()) {
			const ready = site.ready;
			// The change that settled here, still in a read from before it went live: its card has settled.
			if (!ready || this.#settled.get(keyOf(site))?.token === ready.token) continue;
			cards.push(
				this.#desk.down(site)
					? this.#takenDown(site)
					: this.#waiting(site, releases?.canRelease === true, tiles, several),
			);
		}
		for (const [shown, oldTile] of this.#tiles) if (!tiles.has(shown)) this.#desk.forgetTile(oldTile);
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

	/** The card's head: the agent's figure and "Ready to go live" in the accent, the thread's sign of something to do (as
	 * a question's "{name} asks you"); the project's name after it, quiet, only where the company has several. */
	#head(site: CodeReleaseSite, several: boolean): HTMLElement {
		const agent = this.#company.staffById(this.#agentId());
		const look = JSON.stringify([agent?.id, agent?.appearance, agent?.templateId]);
		if (this.#figure?.key !== look)
			this.#figure = { key: look, el: agentFigure(agent, agent?.displayName ?? "", { size: 30 }) };
		return h(
			"div",
			{ class: "interaction-call" },
			h("span", { class: "interaction-figure" }, this.#figure.el),
			h("strong", null, t("Ready to go live")),
			several ? h("span", { class: "thread-ready-project" }, titleOf(site)) : null,
		);
	}

	/** A project's ready change, waiting for the member. */
	#waiting(site: CodeReleaseSite, can: boolean, tiles: Map<string, HTMLElement>, several: boolean): HTMLElement {
		const ready = site.ready!;
		const key = keyOf(site);
		const desk = this.#desk;
		const newest = ready.changes[0];
		const total = ready.changes.length + ready.quiet;
		const quietOnly =
			ready.quiet === 1
				? t("1 change behind the scenes")
				: t("{count} changes behind the scenes", { count: String(ready.quiet) });
		this.#lastShown.set(key, {
			title: titleOf(site),
			notice: newest?.notice ?? quietOnly,
			token: ready.token,
			url: site.site?.url ?? null,
		});
		let tile: HTMLElement | null = null;
		if (newest) {
			const shown = `${key}\n${JSON.stringify(newest)}`;
			tile = this.#tiles.get(shown) ?? desk.tile(newest, "whats-new-change is-thread");
			tiles.set(shown, tile);
		}
		// The others that ride along: how many, as the way to What's new, where each one is.
		const more = total - 1;
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
		return h(
			"article",
			{
				class: "interaction-card is-asking thread-ready-card",
				dataset: { readySite: key },
				"aria-label": `${t("Ready to go live")}: ${titleOf(site)}`,
			},
			this.#head(site, several),
			said(["ready"]),
			// No change a customer will notice: the ones behind the scenes are the card's line.
			tile ?? h("p", { class: "whats-new-line" }, quietOnly),
			newest && more > 0
				? h(
						"a",
						{ class: "thread-ready-more", href: `#/c/${this.#company.profile.profileId}/whats-new` },
						more === 1 ? t("and 1 more change") : t("and {count} more changes", { count: String(more) }),
					)
				: null,
			desk.actions(site, can, desk.look, Boolean(desk.working), false, {
				sessionId: this.#sessionId,
				done: () => {
					if (!this.#lifetime.signal.aborted) this.#focusComposer();
				},
			}),
			said(["live", "actions"]),
		);
	}

	#takenDown(site: CodeReleaseSite): HTMLElement {
		return h(
			"p",
			{ class: "conversation-note thread-ready-down", role: "note", dataset: { readySite: keyOf(site) } },
			t("Qorpera took this site down, so it can't be opened."),
		);
	}

	/** A change that went live from here, as the exchange it was: what the agent offered as its bubble, the member's "Put
	 * it live", and one quiet line, the version live now and the site's address as a plain link. */
	#settledCard(site: string, settled: Settled, url: string | null, several: boolean): HTMLElement {
		return h(
			"article",
			{ class: "interaction-card is-exchange thread-ready-card is-settled", dataset: { readySite: site } },
			h(
				"div",
				{ class: "interaction-ask bubble" },
				several ? h("span", { class: "thread-ready-project" }, settled.title) : null,
				h("p", { class: "interaction-text" }, settled.notice),
			),
			h(
				"p",
				{ class: "interaction-result is-said mine" },
				h("span", { class: "interaction-chosen bubble" }, t("Put it live")),
			),
			h(
				"p",
				{ class: "interaction-result is-done thread-ready-live", role: "status" },
				h("span", { class: "review-mark is-approved", "aria-hidden": "true" }, icon("check")),
				h("span", null, t("Version {version} is live.", { version: String(settled.version) })),
				url
					? h(
							"a",
							{ class: "thread-ready-address", href: url, target: "_blank", rel: "noopener noreferrer" },
							shownLink(url),
							icon("external"),
						)
					: null,
			),
		);
	}
}
