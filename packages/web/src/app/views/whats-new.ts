import { CloudRpcError } from "../../cloud/client.ts";
import { CloudShapeError } from "../../cloud/parse.ts";
import type {
	CodeReleaseCalls,
	CodeReleaseChange,
	CodeReleaseLive,
	CodeReleaseSite,
	CodeReleases,
} from "../../cloud/releases.ts";
import { button, confirmDialog, fmtTime, h, icon, notice, replace } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import type { CompanyController } from "../company.ts";
import { forgetPictureUrl, pictureUrl } from "../folder-images.ts";

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
 */

export interface WhatsNewOptions {
	/** Reads a picture of the company's folder; null when there is none to show. */
	image?: (path: string, signal: AbortSignal) => Promise<Blob | null>;
	/** Told after each read and after Not yet: the apps drawer's entry and its badge follow. */
	listed?: (releases: CodeReleases) => void;
}

/** The changes a member quieted with Not yet, by the token of what the page showed, per member and company. */
const QUIET_KEY = "qorpera.web.whats-new-quiet";

function quietKey(company: CompanyController): string {
	return `${QUIET_KEY}:${company.profile.profileId}:${company.userId}`;
}

function quieted(company: CompanyController): Set<string> {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(quietKey(company)) ?? "[]");
		return new Set(Array.isArray(value) ? value.filter((token): token is string => typeof token === "string") : []);
	} catch {
		return new Set();
	}
}

/** Quiets `token`, keeping only the tokens the page still shows. */
function quiet(company: CompanyController, token: string, shown: readonly string[]): void {
	const kept = [...quieted(company)].filter((item) => shown.includes(item));
	try {
		localStorage.setItem(quietKey(company), JSON.stringify([...new Set([...kept, token])]));
	} catch {
		/* The badge comes back with the next read. */
	}
}

/** The apps drawer's entry for a read: present while a project makes a website, with how many changes are ready that
 * this member did not answer Not yet to. */
export function whatsNewEntry(company: CompanyController, releases: CodeReleases): { ready: number } | undefined {
	if (!releases.sites.length) return undefined;
	const silent = quieted(company);
	let ready = 0;
	for (const { ready: point } of releases.sites)
		if (point && !silent.has(point.token)) ready += point.changes.length + point.quiet;
	return { ready };
}

const keyOf = (site: CodeReleaseSite) => `${site.owner}/${site.name}`;

/** What the page calls a project: its site's title, else its name. */
function titleOf(site: CodeReleaseSite): string {
	return site.site?.title ?? site.site?.slug ?? site.name;
}

/** Why a write did not go through, in the interface language. */
function failure(error: unknown): string {
	if (error instanceof CloudRpcError) {
		if (error.code === "42501") return t("only founders and admins can put a version live");
		// The 3 s lock wait (the executor was keeping a new version) or the statement's time.
		if (error.code === "55P03" || error.code === "57014") return t("Qorpera was busy for a moment");
		if (error.code === "P0002") return t("the project is no longer there");
		// A request that never got an answer has no status.
		if (error.status !== undefined && error.status > 0) return t("something went wrong on Qorpera's side");
	} else if (error instanceof CloudShapeError) return t("something went wrong on Qorpera's side");
	return t("Qorpera could not be reached");
}

export class WhatsNewView {
	readonly el = h("div", { class: "whats-new" });
	readonly #company: CompanyController;
	readonly #client: Pick<CodeReleaseCalls, "list" | "putLive" | "goBack">;
	readonly #lifetime = new AbortController();
	readonly #image: WhatsNewOptions["image"];
	readonly #listed: (releases: CodeReleases) => void;
	#releases: CodeReleases | undefined;
	#loading = true;
	#error: string | undefined;
	/** The project acting, and how, while it does: every button is off meanwhile. */
	#working: { site: string; action: "live" | "back" | "talk" } | undefined;
	/** The last action's outcome, in its project where it happened: a version that went live under what is live, a page
	 * that moved above what is ready now, a press that did not go through under its button. */
	#outcome: { site: string; at: "live" | "ready" | "actions"; tone: "ok" | "error"; text: string } | undefined;
	/** Pictures read, by path: read once while the page is open. */
	readonly #pictures = new Map<string, Promise<string | null>>();
	/** The change cards drawn, by what they show: a draw keeps them, and their pictures, as they are. */
	#cards = new Map<string, HTMLElement>();
	#refreshing: Promise<void> | undefined;
	#again: Promise<void> | undefined;

	constructor(
		company: CompanyController,
		client: Pick<CodeReleaseCalls, "list" | "putLive" | "goBack">,
		signal: AbortSignal,
		options: WhatsNewOptions = {},
	) {
		this.#company = company;
		this.#client = client;
		this.#image = options.image;
		this.#listed = options.listed ?? (() => {});
		if (signal.aborted) this.#lifetime.abort();
		else signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		this.#draw();
		void this.#refresh();
	}

	dispose(): void {
		this.#lifetime.abort();
		for (const shown of this.#pictures.values()) void shown.then((url) => url && forgetPictureUrl(url));
		this.#pictures.clear();
		this.#cards.clear();
		this.el.replaceChildren();
		this.el.remove();
	}

	/** Reads the page. A read already out may have left before the caller's write, so a caller then gets one more read
	 * after it, shared by every caller meanwhile. */
	#refresh(): Promise<void> {
		if (this.#lifetime.signal.aborted) return Promise.resolve();
		if (!this.#refreshing) {
			this.#refreshing = this.#read().finally(() => {
				this.#refreshing = undefined;
			});
			return this.#refreshing;
		}
		this.#again ??= this.#refreshing.then(() => {
			this.#again = undefined;
			return this.#refresh();
		});
		return this.#again;
	}

	async #read(): Promise<void> {
		try {
			const releases = await this.#client.list(this.#lifetime.signal);
			if (this.#lifetime.signal.aborted) return;
			this.#releases = releases;
			this.#error = undefined;
			this.#listed(releases);
		} catch {
			if (this.#lifetime.signal.aborted) return;
			this.#error = t("What's new could not be read.");
		} finally {
			this.#loading = false;
			this.#draw();
		}
	}

	/** Runs one write for a project, every button off meanwhile, then reads the page again. */
	async #write(
		site: CodeReleaseSite,
		action: "live" | "back",
		work: (signal: AbortSignal) => Promise<{ state: "live"; version: number } | { state: "moved" }>,
	): Promise<void> {
		if (this.#working || this.#lifetime.signal.aborted) return;
		const key = keyOf(site);
		const focus = `${action}:${key}`;
		this.#working = { site: key, action };
		this.#outcome = undefined;
		this.#draw(focus);
		try {
			const answer = await work(this.#lifetime.signal);
			if (this.#lifetime.signal.aborted) return;
			this.#outcome =
				answer.state === "live"
					? {
							site: key,
							at: "live",
							tone: "ok",
							text: t("Version {version} is live.", { version: String(answer.version) }),
						}
					: {
							site: key,
							at: "ready",
							tone: "ok",
							text: t("Something changed while you looked. Here is what is ready now."),
						};
		} catch (error) {
			if (this.#lifetime.signal.aborted) return;
			const why = failure(error);
			this.#outcome = {
				site: key,
				at: action === "live" ? "actions" : "live",
				tone: "error",
				text:
					action === "live"
						? t("It did not go live: {why}. Nothing changed.", { why })
						: t("It did not go back: {why}. Nothing changed.", { why }),
			};
		} finally {
			this.#working = undefined;
			if (!this.#lifetime.signal.aborted) this.#draw(focus);
		}
		await this.#refresh();
	}

	#putLive(site: CodeReleaseSite): Promise<void> {
		const ready = site.ready;
		if (!ready) return Promise.resolve();
		return this.#write(site, "live", (signal) =>
			this.#client.putLive(
				site.owner,
				site.name,
				{ live: site.live?.version ?? null, change: ready.change, token: ready.token },
				signal,
			),
		);
	}

	async #goBack(site: CodeReleaseSite): Promise<void> {
		const { live, back } = site;
		if (!live || !back || this.#working || this.#lifetime.signal.aborted) return;
		const version = String(back.version);
		if (
			!(await confirmDialog(
				t("Put version {version} back up? Version {current} comes off the site at once; its changes stay ready.", {
					version,
					current: String(live.version),
				}),
				t("Go back"),
				false,
				undefined,
				this.#lifetime.signal,
			))
		)
			return;
		await this.#write(site, "back", (signal) =>
			this.#client.goBack(site.owner, site.name, { live: live.version, to: back.version }, signal),
		);
	}

	/** Not yet: the agent of the newest ready change hears it in the member's own words. Its thread opens with "Not yet: "
	 * waiting in the composer; nothing is sent. The Co-Founder hears it when no agent made the change, or it left. */
	async #notYet(site: CodeReleaseSite): Promise<void> {
		const ready = site.ready;
		if (!ready || this.#working || this.#lifetime.signal.aborted) return;
		const company = this.#company;
		const profileId = company.profile.profileId;
		const key = keyOf(site);
		const cofounderId = company.cofounderId();
		const named = company.staffById(ready.agent ?? undefined);
		const agent = named?.employmentStatus === "active" ? named : company.staffById(cofounderId);
		const from = location.hash;
		this.#working = { site: key, action: "talk" };
		this.#outcome = undefined;
		this.#draw(`talk:${key}`);
		try {
			if (!agent) throw new Error(t("The thread could not be opened."));
			const isCofounder = agent.id === cofounderId;
			let sessionId: string;
			if (isCofounder) {
				const opened = await company.openCofounderConversation();
				if (!opened.sessionId) throw new Error(opened.reason ?? t("The Co-Founder's thread can't be opened here."));
				sessionId = opened.sessionId;
			} else sessionId = await company.openStaffConversation(agent);
			if (this.#lifetime.signal.aborted) return;
			const text = t("Not yet: ");
			if (!(company.conversation(sessionId).get().draft ?? "").includes(text))
				company.addToDraft(sessionId, { text, quotes: [] });
			// The badge is quiet in this browser until something else is ready.
			const releases = this.#releases;
			if (releases) {
				quiet(
					company,
					ready.token,
					releases.sites.flatMap((item) => (item.ready ? [item.ready.token] : [])),
				);
				this.#listed(releases);
			}
			if (location.hash === from)
				location.hash = isCofounder ? `#/c/${profileId}` : `#/c/${profileId}/staff/${agent.id}`;
		} catch (error) {
			if (this.#lifetime.signal.aborted) return;
			this.#outcome = {
				site: key,
				at: "actions",
				tone: "error",
				text: error instanceof Error && error.message ? error.message : t("The thread could not be opened."),
			};
		} finally {
			this.#working = undefined;
			if (!this.#lifetime.signal.aborted) this.#draw(`talk:${key}`);
		}
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

	/** What is live: the Sites page's card, with the site's link, where its password is, and Go back. */
	#live(site: CodeReleaseSite, can: boolean, busy: boolean): HTMLElement {
		const live = site.live;
		const shown = live && site.site ? site.site : undefined;
		const key = keyOf(site);
		let back: HTMLButtonElement | null = null;
		if (live && site.back && can) {
			back = button(
				this.#working?.site === key && this.#working.action === "back"
					? t("Working…")
					: t("Go back to version {version}", { version: String(site.back.version) }),
				() => void this.#goBack(site),
				{ disabled: busy },
			);
			back.dataset.focusKey = `back:${key}`;
		}
		return h(
			"div",
			{ class: "connection-list whats-new-live" },
			h(
				"article",
				{ class: "service-card hook-card" },
				h("span", { class: "hook-icon" }, icon("globe")),
				h(
					"div",
					{ class: "settings-copy" },
					h("strong", null, live ? t("Live now") : t("Not live yet")),
					live ? h("small", { class: "hook-state" }, this.#liveLine(live)) : null,
					// The password is read where it is kept: only owners and admins can see it there.
					shown && can
						? h(
								"small",
								null,
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
							{ class: "connection-actions" },
							shown
								? h(
										"a",
										{ class: "btn", href: shown.url, target: "_blank", rel: "noopener noreferrer" },
										t("Open the site"),
									)
								: null,
							back,
						)
					: null,
			),
		);
	}

	/** A change as the page shows it: its picture with its one line under it, or the line alone on a plain tile. */
	#card(change: CodeReleaseChange): HTMLElement {
		const was = change.wasLive ? h("small", { class: "whats-new-was" }, t("Was live before")) : null;
		const line = h("p", { class: "whats-new-line" }, change.notice);
		const card = h("article", { class: "whats-new-change" });
		const plain = () => {
			card.classList.add("is-plain");
			replace(card, line, was);
		};
		const read = this.#image;
		if (!change.picture || !read) {
			plain();
			return card;
		}
		const path = change.picture;
		const box = h("div", { class: "choice-picture is-loading" });
		replace(card, box, line, was);
		const show = () => {
			let shown = this.#pictures.get(path);
			if (!shown) {
				const signal = this.#lifetime.signal;
				shown = read(path, signal)
					.then((blob) => (blob && !signal.aborted ? pictureUrl(blob) : null))
					.catch(() => null);
				this.#pictures.set(path, shown);
			}
			void shown.then((url) => {
				if (this.#lifetime.signal.aborted) return;
				if (!url) return plain();
				box.classList.remove("is-loading");
				box.append(h("img", { src: url, alt: "", decoding: "async" }));
			});
		};
		// Pictures are read as they come near the screen.
		if (typeof IntersectionObserver !== "function") show();
		else {
			const seen = new IntersectionObserver(
				(entries) => {
					if (!entries.some((entry) => entry.isIntersecting)) return;
					seen.disconnect();
					show();
				},
				{ rootMargin: "200px" },
			);
			seen.observe(box);
			this.#lifetime.signal.addEventListener("abort", () => seen.disconnect(), { once: true });
		}
		return card;
	}

	/** What is ready, and the two buttons; or that nothing is. */
	#ready(site: CodeReleaseSite, can: boolean, busy: boolean, cards: Map<string, HTMLElement>): HTMLElement[] {
		const ready = site.ready;
		if (!ready) return [h("p", { class: "whats-new-empty" }, t("Nothing new is ready."))];
		const key = keyOf(site);
		const total = ready.changes.length + ready.quiet;
		const count = String(ready.quiet);
		const listed = ready.changes.map((change) => {
			const shown = `${key}\n${JSON.stringify(change)}`;
			const card = this.#cards.get(shown) ?? this.#card(change);
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
		let actions: HTMLElement;
		if (can) {
			const working = this.#working?.site === key ? this.#working.action : undefined;
			const put = button(
				working === "live" ? t("Putting it live…") : site.live ? t("Put it live") : t("Put the first version live"),
				() => void this.#putLive(site),
				{ primary: true, disabled: busy },
			);
			put.dataset.focusKey = `live:${key}`;
			const notYet = button(working === "talk" ? t("Working…") : t("Not yet"), () => void this.#notYet(site), {
				disabled: busy,
			});
			notYet.dataset.focusKey = `talk:${key}`;
			actions = h("div", { class: "whats-new-actions" }, put, notYet);
		} else actions = h("p", { class: "whats-new-managers" }, t("Founders and admins put changes live."));
		return [
			h("h3", null, total === 1 ? t("1 change is ready") : t("{count} changes are ready", { count: String(total) })),
			listed.length ? h("div", { class: "whats-new-changes" }, ...listed) : null,
			behind ? h("p", { class: "whats-new-behind" }, behind) : null,
			actions,
		].filter((item): item is HTMLElement => item !== null);
	}

	#site(site: CodeReleaseSite, can: boolean, cards: Map<string, HTMLElement>): HTMLElement {
		const key = keyOf(site);
		const busy = Boolean(this.#working);
		const outcome = this.#outcome?.site === key ? this.#outcome : undefined;
		const said = (at: "live" | "ready" | "actions") =>
			outcome?.at === at
				? h(
						"p",
						{ class: `service-outcome ${outcome.tone === "ok" ? "is-ok" : "is-error"}`, role: "status" },
						outcome.text,
					)
				: null;
		const waiting = String(site.waiting);
		return h(
			"section",
			{ class: "whats-new-site", dataset: { site: key }, "aria-label": titleOf(site) },
			h("h2", null, titleOf(site)),
			this.#live(site, can, busy),
			said("live"),
			site.problem
				? notice(
						"warn",
						site.problem === "SITE_LIMIT"
							? t("This project can't get a site: the company has 10. Take one offline in Sites.")
							: t("The newest version could not be prepared. Qorpera is trying again."),
					)
				: null,
			said("ready"),
			...this.#ready(site, can, busy, cards),
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
		const releases = this.#releases;
		const cards = new Map<string, HTMLElement>();
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
			retry.dataset.focusKey = "retry";
			error = h("p", { class: "connection-empty service-error", role: "alert" }, this.#error, " ", retry);
		}
		replace(
			this.el,
			error,
			this.#loading && !releases ? h("p", { class: "whats-new-empty", role: "status" }, t("Checking…")) : null,
			releases && !releases.sites.length ? h("p", { class: "whats-new-empty" }, t("Nothing new is ready.")) : null,
			...(releases?.sites.map((site) => this.#site(site, releases.canRelease, cards)) ?? []),
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
