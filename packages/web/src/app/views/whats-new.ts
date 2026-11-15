import type { CodeReleaseLive, CodeReleaseSite, CodeReleases } from "../../cloud/releases.ts";
import { button, fmtTime, h, icon, notice, replace } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import type { CompanyController } from "../company.ts";
import {
	keyOf,
	quieted,
	type ReleaseClient,
	ReleaseDesk,
	type ReleaseDeskOptions,
	readyCount,
	titleOf,
} from "./release-desk.ts";
import { siteEmblem } from "./settings-sites.ts";

/**
 * The What's new page (`#/c/<id>/whats-new`, a platform page in the apps drawer; own code storage step 4): for each of
 * the company's projects whose code is kept in Qorpera and makes a website, what is live (its version, since when and
 * who said go, with Go back), the changes ready to go live as a picture with one line each, and Put it live and Not
 * yet. Founders see versions and pictures, never a change number, a commit, a check, a branch or a repository path.
 * Every member sees the page; owners and admins put a version live and go back (the kernel enforces the same rule).
 * Nothing builds after a yes: the version was made and kept when its change went in, so the switch cannot fail half
 * way. The page sends what it drew, and the kernel answers `moved` when the page moved meanwhile: it is read again.
 *
 * Not yet records nothing: it opens the member's conversation with the agent of the newest ready change (the
 * Co-Founder when there is none, or it left) with "Not yet: " waiting in its composer, and quiets the drawer's badge in
 * this browser until something new is ready.
 *
 * Look first (own code storage step 5.1): an owner or admin opens the ready version on the site's next host in a new
 * tab before anyone puts it live. It shows only while the read says `preview` (sites have addresses of their own), so a
 * kernel before step 5.1, or with hosts off, draws the page as before. The tab opens blank within the press with its way
 * back to this window cut; the one-time link the kernel answers is used once, there, and kept nowhere. Any other
 * answer closes the tab and says why in its own words.
 *
 * A site Qorpera took down (step 5.1) answers a "gone" page on every address, so its live row offers no link to it and
 * says so instead (the names of such sites, read beside the page with `takenDown`; without it, as before).
 *
 * The read, the writes, their outcomes and Look first's tab are What's new's desk (app/views/release-desk.ts), which the
 * thread's "a change is ready" card shares: this page draws what the desk holds.
 */

/** What the page is told and reads beside it: What's new's desk's options (app/views/release-desk.ts). */
export type WhatsNewOptions = ReleaseDeskOptions;

/** The apps drawer's entry for a read: present while a project makes a website, with how many changes are ready that
 * this member did not answer Not yet to. Only an owner or admin can put them live or say Not yet, so only they get the
 * count: anyone else would carry a badge they could never clear. */
export function whatsNewEntry(company: CompanyController, releases: CodeReleases): { ready: number } | undefined {
	if (!releases.sites.length) return undefined;
	if (!releases.canRelease) return { ready: 0 };
	const silent = quieted(company);
	let ready = 0;
	for (const { ready: point } of releases.sites)
		if (point && !silent.has(point.token)) ready += point.changes.length + point.quiet;
	return { ready };
}

/** The version live of each project's site, by the site's name in its link: the Sites page names it on the site's
 * row. */
export function liveVersions(releases: CodeReleases): Readonly<Record<string, number>> {
	return Object.fromEntries(
		releases.sites.flatMap((item) => (item.site && item.live ? [[item.site.slug, item.live.version]] : [])),
	);
}

export class WhatsNewView {
	readonly el = h("div", { class: "whats-new" });
	readonly #company: CompanyController;
	readonly #lifetime = new AbortController();
	/** The read and the writes, with their outcomes: shared with the thread's card (app/views/release-desk.ts). */
	readonly #desk: ReleaseDesk;
	/** The change cards drawn, by what they show: a draw keeps them, and their pictures, as they are. */
	#cards = new Map<string, HTMLElement>();

	constructor(company: CompanyController, client: ReleaseClient, signal: AbortSignal, options: WhatsNewOptions = {}) {
		this.#company = company;
		if (signal.aborted) this.#lifetime.abort();
		else signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		this.#desk = new ReleaseDesk(company, client, this.#lifetime.signal, options, (focusKey) => this.#draw(focusKey));
		this.#draw();
		void this.#desk.refresh();
	}

	dispose(): void {
		this.#lifetime.abort();
		this.#desk.dispose();
		this.#cards.clear();
		this.el.replaceChildren();
		this.el.remove();
	}

	/** Who said go, by the name the team knows them by; nobody when they left. */
	#liveLine(live: CodeReleaseLive): string {
		const version = String(live.version);
		const time = fmtTime(live.since);
		const name = live.by
			? this.#company.store.get().team?.members.find((member) => member.userId === live.by)?.displayName
			: undefined;
		if (!name) return t("Version {version} · since {time}", { version, time });
		return live.kind === "back"
			? t("Version {version} · since {time} · {name} went back", { version, time, name })
			: t("Version {version} · since {time} · {name} said go", { version, time, name });
	}

	/** What is live, as a row of the Sites page (styles/sites.css): the Sites globe, the version and who said go, where
	 * the password is, and the site's link and Go back as pill buttons. A site Qorpera took down (`down`) shows neither:
	 * every address of it shows a "gone" page, and the kernel refuses going back until Qorpera restores it. */
	#live(site: CodeReleaseSite, can: boolean, busy: boolean, down: boolean): HTMLElement {
		const live = site.live;
		const shown = live && site.site && !down ? site.site : undefined;
		const key = keyOf(site);
		let back: HTMLButtonElement | null = null;
		if (live && site.back && can && !down) {
			back = h(
				"button",
				{ type: "button", class: "site-button", disabled: busy, onclick: () => void this.#desk.goBack(site) },
				this.#desk.working?.site === key && this.#desk.working.action === "back"
					? t("Working…")
					: t("Go back to version {version}", { version: String(site.back.version) }),
			);
			back.dataset.focusKey = `back:${key}`;
		}
		return h(
			"div",
			{ class: "whats-new-live" },
			h(
				"article",
				{ class: `site-row is-whats-new${live ? "" : " is-waiting"}` },
				siteEmblem(),
				h(
					"div",
					{ class: "site-head" },
					h("strong", { class: "site-name" }, live ? t("Live now") : t("Not live yet")),
					live ? h("span", { class: "site-meta" }, this.#liveLine(live)) : null,
					down
						? h(
								"span",
								{ class: "site-meta" },
								t("Qorpera took this site down, so it can't be opened. See why in Sites."),
							)
						: null,
					// The password is read where it is kept: only owners and admins can see it there.
					shown && can
						? h(
								"span",
								{ class: "site-meta" },
								h(
									"a",
									{ href: `#/c/${this.#company.profile.profileId}/sites` },
									t("The password is in Sites."),
								),
							)
						: null,
				),
				// Not live yet, there is nothing to open or go back to: no row for it (a phone would keep it empty).
				shown || back
					? h(
							"div",
							{ class: "site-actions" },
							shown
								? h(
										"a",
										{ class: "site-button", href: shown.url, target: "_blank", rel: "noopener noreferrer" },
										t("Open the site"),
										icon("external"),
									)
								: null,
							back,
						)
					: null,
			),
		);
	}

	/** What is ready, and the buttons (Look first, while `look`, then Put it live and Not yet); or that nothing is. A site
	 * Qorpera took down (`down`) keeps only Not yet: the kernel refuses Look first and Put it live until it is restored,
	 * and the live row says why (the review of #1774, round 3). */
	#ready(
		site: CodeReleaseSite,
		can: boolean,
		look: boolean,
		busy: boolean,
		cards: Map<string, HTMLElement>,
		down: boolean,
	): HTMLElement[] {
		const ready = site.ready;
		if (!ready) return [h("p", { class: "whats-new-empty" }, t("Nothing new is ready."))];
		const key = keyOf(site);
		const count = String(ready.quiet);
		const listed = ready.changes.map((change) => {
			const shown = `${key}\n${JSON.stringify(change)}`;
			const card = this.#cards.get(shown) ?? this.#desk.tile(change);
			cards.set(shown, card);
			return card;
		});
		const behind =
			ready.quiet === 0
				? null
				: listed.length
					? ready.quiet === 1
						? t("and 1 change behind the scenes")
						: t("and {count} changes behind the scenes", { count })
					: ready.quiet === 1
						? t("1 change behind the scenes")
						: t("{count} changes behind the scenes", { count });
		return [
			h("h3", null, readyCount(ready)),
			listed.length ? h("div", { class: "whats-new-changes" }, ...listed) : null,
			behind ? h("p", { class: "whats-new-behind" }, behind) : null,
			this.#desk.actions(site, can, look, busy, down),
		].filter((item): item is HTMLElement => item !== null);
	}

	#site(site: CodeReleaseSite, can: boolean, look: boolean, cards: Map<string, HTMLElement>): HTMLElement {
		const key = keyOf(site);
		const busy = Boolean(this.#desk.working);
		const outcome = this.#desk.outcome?.site === key ? this.#desk.outcome : undefined;
		const said = (at: "live" | "ready" | "actions") =>
			outcome?.at === at
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
		const waiting = String(site.waiting);
		// A site Qorpera took down: every address of it shows a "gone" page, so no link to it and no password to share, and
		// nothing the kernel would refuse (Look first, Put it live, Go back); the live row says why, for a site that was
		// never live too (the review of #1774, F4 and round 3).
		const down = this.#desk.down(site);
		return h(
			"section",
			{ class: "whats-new-site", dataset: { site: key }, "aria-label": titleOf(site) },
			h("h2", null, titleOf(site)),
			this.#live(site, can, busy, down),
			said("live"),
			site.problem || site.givenUp
				? notice(
						"warn",
						site.problem === "SITE_LIMIT"
							? t("This project can't get a site: the company has 10. Take one offline in Sites.")
							: // Qorpera tries a change's upload five times; after that it waits for the next change.
								site.givenUp
								? t("The newest version could not be prepared. The next change that is saved gets a new try.")
								: t("The newest version could not be prepared. Qorpera is trying again."),
					)
				: null,
			said("ready"),
			...this.#ready(site, can, look, busy, cards, down),
			said("actions"),
			site.waiting > 0
				? h(
						"p",
						{ class: "whats-new-waiting" },
						site.waiting === 1
							? t("1 more change is not ready yet.")
							: t("{count} more changes are not ready yet.", { count: waiting }),
					)
				: null,
		);
	}

	#draw(focusKey?: string): void {
		if (this.#lifetime.signal.aborted) return;
		const active = document.activeElement as HTMLElement | null;
		const key = focusKey ?? (this.el.contains(active) ? active?.dataset.focusKey : undefined);
		const releases = this.#desk.releases;
		// Look first: only where the read offers it (owners and admins, while sites have addresses of their own).
		const look = this.#desk.look;
		const cards = new Map<string, HTMLElement>();
		let error: HTMLElement | null = null;
		const failed = this.#desk.error;
		if (failed) {
			const retry = button(t("Try again"), () => this.#desk.retry(), { small: true });
			retry.dataset.focusKey = "retry";
			error = h("p", { class: "connection-empty service-error", role: "alert" }, failed, " ", retry);
		}
		replace(
			this.el,
			error,
			this.#desk.loading && !releases ? h("p", { class: "whats-new-empty", role: "status" }, t("Checking…")) : null,
			releases && !releases.sites.length ? h("p", { class: "whats-new-empty" }, t("Nothing new is ready.")) : null,
			...(releases?.sites.map((site) => this.#site(site, releases.canRelease, look, cards)) ?? []),
		);
		this.#cards = cards;
		if (key) {
			const target = [...this.el.querySelectorAll<HTMLElement>("[data-focus-key]")].find(
				(item) => item.dataset.focusKey === key,
			);
			if (target && !target.matches(":disabled")) target.focus();
		}
	}
}
