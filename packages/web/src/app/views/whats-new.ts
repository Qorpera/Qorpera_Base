import { CloudRpcError } from "../../cloud/client.ts";
import { CloudShapeError } from "../../cloud/parse.ts";
import type {
	CodeReleaseAnswer,
	CodeReleaseCalls,
	CodeReleaseChange,
	CodeReleaseLive,
	CodeReleaseSite,
	CodeReleases,
	SitePreviewAnswer,
} from "../../cloud/releases.ts";
import { button, confirmDialog, fmtTime, h, icon, notice, replace } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import type { CompanyController } from "../company.ts";
import { forgetPictureUrl, pictureUrl } from "../folder-images.ts";
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
 */

export interface WhatsNewOptions {
	/** Reads a picture of the company's folder; null when there is none to show. */
	image?: (path: string, signal: AbortSignal) => Promise<Blob | null>;
	/** Told after each read and after Not yet: the apps drawer's entry and its badge follow. */
	listed?: (releases: CodeReleases) => void;
	/** The names (slugs) of the company's sites Qorpera took down (step 5.1), read beside each read of the page. A kernel
	 * without the read fails it: the page then keeps what the last read that answered said (none before one did). */
	takenDown?: (signal: AbortSignal) => Promise<ReadonlySet<string>>;
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

const keyOf = (site: CodeReleaseSite) => `${site.owner}/${site.name}`;

/** What the page calls a project: its site's title, else its name. */
function titleOf(site: CodeReleaseSite): string {
	return site.site?.title ?? site.site?.slug ?? site.name;
}

/** Why the database refused a write, in the interface language; undefined when nothing proves it did not go through.
 * Only an error PostgREST answers with one of these SQLSTATEs proves that the call's transaction rolled back: the two
 * functions raise 42501 (not an owner or admin), P0002 (no such repository) and 22023 (a malformed argument), and
 * Postgres raises 55P03 (the 3 s lock wait) and 57014 (the statement's time). Anything else may have come after a
 * commit (a gateway's 502 or 504, a 5xx with no SQLSTATE, a body that is no JSON, a malformed answer, the deadline, no
 * network): the write may have gone through, so the page claims neither until a read shows which (E.md lists every
 * kind). */
function refusal(error: unknown): string | undefined {
	if (!(error instanceof CloudRpcError)) return undefined;
	switch (error.code) {
		case "42501":
			return t("only founders and admins can put a version live");
		case "55P03":
		case "57014":
			return t("Qorpera was busy for a moment");
		case "P0002":
			return t("the project is no longer there");
		case "22023":
			return t("something went wrong on Qorpera's side");
	}
	return undefined;
}

/** An action's outcome on the page: in its project, where (under what is live, above what is ready, under the buttons),
 * how it reads, and the last read it stays through (WhatsNewView's `#outcome`). */
interface Outcome {
	site: string;
	at: "live" | "ready" | "actions";
	tone: "ok" | "error" | "plain";
	text: string;
	through?: number;
}

/** Why the kernel refused a write it answered (`refused`): nothing changed. */
function refusedWhy(code: string): string {
	return code === "SITE_TAKEN_DOWN" ? t("Qorpera took this site down") : t("something went wrong on Qorpera's side");
}

/** What Look first says when the tab did not go to the version: where on the page, and in its own words for each
 * answer; undefined for `off` (sites have no addresses of their own now: the button goes with the next read). */
function lookWords(
	answer: SitePreviewAnswer | undefined,
	failure: unknown,
	opened: boolean,
): Pick<Outcome, "at" | "tone" | "text"> | undefined {
	if (answer?.state === "off") return undefined;
	if (answer?.state === "moved")
		return { at: "ready", tone: "ok", text: t("Something changed while you looked. Here is what is ready now.") };
	if (answer?.state === "gone")
		return {
			at: "actions",
			tone: "error",
			text: t("Qorpera took this site down, so it can't be opened. See why in Sites."),
		};
	if (failure instanceof CloudRpcError && failure.code === "42501")
		return {
			at: "actions",
			tone: "error",
			text: t("Only founders and admins can look at a version before it goes live."),
		};
	// Answered, but not with a link (the browser stopped the tab, a refusal with its code, an answer not as expected):
	// another press may open it. No answer at all (no network, the deadline, a gateway's page): Qorpera was not reached.
	const answered = !opened || failure instanceof CloudShapeError || (failure instanceof CloudRpcError && failure.code);
	return {
		at: "actions",
		tone: "error",
		text: answered
			? t("The next version could not be opened. Try again.")
			: t("The next version could not be opened: Qorpera could not be reached. Try again."),
	};
}

export class WhatsNewView {
	readonly el = h("div", { class: "whats-new" });
	readonly #company: CompanyController;
	/** `openPreview` (step 5.1) may be missing: no Look first then. */
	readonly #client: Pick<CodeReleaseCalls, "list" | "putLive" | "goBack"> &
		Partial<Pick<CodeReleaseCalls, "openPreview">>;
	readonly #lifetime = new AbortController();
	readonly #image: WhatsNewOptions["image"];
	readonly #listed: (releases: CodeReleases) => void;
	readonly #readTakenDown: WhatsNewOptions["takenDown"];
	/** The sites Qorpera took down, by name, as the last read that answered said: no link to one. */
	#takenDown: ReadonlySet<string> = new Set();
	#releases: CodeReleases | undefined;
	#loading = true;
	#error: string | undefined;
	/** The project acting, and how, while it does: every button is off meanwhile. */
	#working: { site: string; action: "live" | "back" | "talk" | "look" } | undefined;
	/** Look first answered `off` (sites have no addresses of their own now): its button is gone until a read says
	 * otherwise. */
	#lookOff = false;
	/** The last action's outcome, in its project where it happened: a version that went live under what is live, a page
	 * that moved above what is ready now, a press that did not go through under its button. It stays through the reads
	 * that had started when it was settled (`through`; unset while its write's own read is still to come) and goes with
	 * the first later read that succeeds: the page never keeps an old outcome over what a read shows. */
	#outcome: Outcome | undefined;
	/** A write whose answer never came (no network, the deadline): it may or may not have gone through, so the page claims
	 * neither until a read that started after it (`after`) shows which. */
	#unsettled:
		| { site: string; action: "live" | "back"; before: number | null; to: number | null; after: number }
		| undefined;
	/** Reads started so far: each read knows its place, so one that left before a write never settles it. */
	#started = 0;
	/** Pictures read, by path: read once while the page is open. */
	readonly #pictures = new Map<string, Promise<string | null>>();
	/** The change cards drawn, by what they show: a draw keeps them, and their pictures, as they are. */
	#cards = new Map<string, HTMLElement>();
	#refreshing: Promise<void> | undefined;
	#again: Promise<void> | undefined;

	constructor(
		company: CompanyController,
		client: Pick<CodeReleaseCalls, "list" | "putLive" | "goBack"> & Partial<Pick<CodeReleaseCalls, "openPreview">>,
		signal: AbortSignal,
		options: WhatsNewOptions = {},
	) {
		this.#company = company;
		this.#client = client;
		this.#image = options.image;
		this.#listed = options.listed ?? (() => {});
		this.#readTakenDown = options.takenDown;
		if (signal.aborted) this.#lifetime.abort();
		else signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		this.#draw();
		void this.#refresh();
		// Back in this window, the page reads again: another tab or another member may have put a version live, or the
		// member's role changed.
		window.addEventListener(
			"focus",
			() => {
				if (!this.#working) void this.#refresh();
			},
			{ signal: this.#lifetime.signal },
		);
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
		const read = ++this.#started;
		try {
			// Which sites Qorpera took down, read beside the page and drawn with it (no live row shows a dead link first).
			const down = this.#readTakenDown?.(this.#lifetime.signal).catch(() => undefined);
			const releases = await this.#client.list(this.#lifetime.signal);
			const takenDown = await down;
			if (this.#lifetime.signal.aborted) return;
			if (takenDown) this.#takenDown = takenDown;
			this.#releases = releases;
			this.#lookOff = false;
			this.#error = undefined;
			this.#settle(releases, read);
			this.#listed(releases);
		} catch (error) {
			if (this.#lifetime.signal.aborted) return;
			this.#error = t("What's new could not be read.");
			// Refused (the member left or lost the company) or gone: what was read before is no longer theirs to act on. A
			// read that got no answer keeps it, under the line that says so.
			if (error instanceof CloudRpcError && (error.denied || error.missing)) this.#releases = undefined;
			// A write still unsettled stays so: the member hears that it is not known, and how to find out.
			const pending = this.#unsettled;
			if (pending)
				this.#outcome = {
					site: pending.site,
					at: "live",
					tone: "error",
					text:
						pending.action === "live"
							? t(
									"Qorpera could not be reached, so it is not known whether it went live. Open this page again in a moment.",
								)
							: t(
									"Qorpera could not be reached, so it is not known whether it went back. Open this page again in a moment.",
								),
				};
		} finally {
			this.#loading = false;
			this.#draw();
		}
	}

	/** What a read that succeeded does to the outcome: an unsettled write is settled by a read that started after it
	 * (the version it asked for is live: it went through; else nothing changed and the line goes, the page showing what
	 * is); any other outcome goes once a read started after its own has succeeded. */
	#settle(releases: CodeReleases, read: number): void {
		const pending = this.#unsettled;
		if (pending && read > pending.after) {
			this.#unsettled = undefined;
			const now = releases.sites.find((item) => keyOf(item) === pending.site)?.live ?? null;
			const done =
				now !== null &&
				(pending.action === "live"
					? now.version !== pending.before
					: now.kind === "back" && now.version === pending.to);
			this.#outcome =
				now && done
					? {
							site: pending.site,
							at: "live",
							tone: "ok",
							text: t("Version {version} is live.", { version: String(now.version) }),
							through: read,
						}
					: undefined;
			return;
		}
		if (!pending && this.#outcome?.through !== undefined && read > this.#outcome.through) this.#outcome = undefined;
	}

	/** Runs one write for a project, every button off meanwhile, then reads the page again. */
	async #write(
		site: CodeReleaseSite,
		action: "live" | "back",
		work: (signal: AbortSignal) => Promise<CodeReleaseAnswer>,
	): Promise<void> {
		if (this.#working || this.#lifetime.signal.aborted) return;
		const key = keyOf(site);
		const focus = `${action}:${key}`;
		const before = site.live?.version ?? null;
		this.#working = { site: key, action };
		this.#outcome = undefined;
		this.#unsettled = undefined;
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
					: answer.state === "refused"
						? // Refused (Qorpera took the site down): nothing changed, and the answer says why.
							{
								site: key,
								at: action === "live" ? "actions" : "live",
								tone: "error",
								text:
									action === "live"
										? t("It did not go live: {why}. Nothing changed.", { why: refusedWhy(answer.code) })
										: t("It did not go back: {why}. Nothing changed.", { why: refusedWhy(answer.code) }),
							}
						: // Moved: what was shown is no longer so, and nothing changed; the read shows what is now.
							action === "live"
							? {
									site: key,
									at: "ready",
									tone: "ok",
									text: t("Something changed while you looked. Here is what is ready now."),
								}
							: {
									site: key,
									at: "live",
									tone: "ok",
									text: t("Something changed while you looked. Here is what is live now."),
								};
		} catch (error) {
			if (this.#lifetime.signal.aborted) return;
			const why = refusal(error);
			if (why === undefined) {
				// No answer: it may have gone through. Claim neither until a read shows which.
				this.#unsettled = {
					site: key,
					action,
					before,
					to: action === "back" ? (site.back?.version ?? null) : null,
					after: this.#started,
				};
				this.#outcome = {
					site: key,
					at: "live",
					tone: "plain",
					text:
						action === "live"
							? t("It may not have gone live: Qorpera could not be reached. Checking…")
							: t("It may not have gone back: Qorpera could not be reached. Checking…"),
				};
			} else
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
		// The write's own read has run: the next read that succeeds takes its line away.
		if (this.#outcome && this.#outcome.through === undefined && !this.#unsettled) {
			this.#outcome.through = this.#started;
			if (!this.#lifetime.signal.aborted) this.#draw();
		}
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
			if (!agent) throw new Error("No agent to tell");
			const isCofounder = agent.id === cofounderId;
			let sessionId: string;
			if (isCofounder) {
				const opened = await company.openCofounderConversation();
				if (!opened.sessionId) throw new Error("No Co-Founder thread");
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
		} catch {
			if (this.#lifetime.signal.aborted) return;
			// One plain line whatever went wrong: the cloud's own words for a thread that would not open name machinery.
			this.#outcome = {
				site: key,
				at: "actions",
				tone: "error",
				text: t("The thread could not be opened."),
				through: this.#started,
			};
		} finally {
			this.#working = undefined;
			if (!this.#lifetime.signal.aborted) this.#draw(`talk:${key}`);
		}
	}

	/** Look first: the ready version on the site's next host, in a new tab. The tab is opened blank within the press (one
	 * opened after the call would be stopped by the browser) and its way back to this window is cut at once, before
	 * anything loads in it; only then is the one-time link asked for, and the tab sent there. The link is used that once
	 * and goes nowhere else: not on the page, not in storage, not in a line. Any other answer closes the tab and says why
	 * under the buttons (or, for a page that moved, above what is ready now, read again). */
	async #lookFirst(site: CodeReleaseSite): Promise<void> {
		const client = this.#client;
		const ready = site.ready;
		const slug = site.site?.slug;
		if (!ready || !slug || !client.openPreview || this.#working || this.#lifetime.signal.aborted) return;
		const key = keyOf(site);
		const focus = `look:${key}`;
		const tab = window.open("about:blank", "_blank");
		if (tab) tab.opener = null;
		this.#working = { site: key, action: "look" };
		this.#outcome = undefined;
		this.#draw(focus);
		let answer: SitePreviewAnswer | undefined;
		let failure: unknown;
		if (tab)
			try {
				answer = await client.openPreview(
					site.owner,
					site.name,
					{ change: ready.change, slug },
					this.#lifetime.signal,
				);
			} catch (error) {
				failure = error;
			}
		this.#working = undefined;
		if (answer?.state === "open" && tab && !this.#lifetime.signal.aborted) {
			try {
				if (!tab.closed) tab.location.replace(answer.url);
			} catch {
				// The member sent the tab elsewhere meanwhile: the link is not used, and it ends by itself in two minutes.
			}
			this.#draw(focus);
			return;
		}
		tab?.close();
		if (this.#lifetime.signal.aborted) return;
		const words = lookWords(answer, failure, Boolean(tab));
		const again =
			answer?.state === "moved" ||
			answer?.state === "off" ||
			(failure instanceof CloudRpcError && (failure.code === "42501" || failure.code === "P0002"));
		if (answer?.state === "off") this.#lookOff = true;
		const said: Outcome | undefined = words && { site: key, ...words };
		this.#outcome = said;
		this.#draw(focus);
		// The page moved, sites have no addresses of their own now, or the member or the project is gone: read it again.
		if (again) await this.#refresh();
		// The line goes with the second read that succeeds after it (or after the press): coming back from the closed tab
		// reads the page once (the window's focus), and that read leaves it.
		if (said && this.#outcome === said) said.through = this.#started + (tab ? 1 : 0);
		if (!this.#lifetime.signal.aborted) this.#draw();
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
	 * the password is, and the site's link and Go back as pill buttons. */
	#live(site: CodeReleaseSite, can: boolean, busy: boolean): HTMLElement {
		const live = site.live;
		// A site Qorpera took down: every address of it shows a "gone" page, so no link to it, and no password to share.
		const down = Boolean(live && site.site && this.#takenDown.has(site.site.slug));
		const shown = live && site.site && !down ? site.site : undefined;
		const key = keyOf(site);
		let back: HTMLButtonElement | null = null;
		if (live && site.back && can) {
			back = h(
				"button",
				{ type: "button", class: "site-button", disabled: busy, onclick: () => void this.#goBack(site) },
				this.#working?.site === key && this.#working.action === "back"
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
				// A file that is no picture after all (it does not decode) is the line on its tile, as one not read.
				box.append(h("img", { src: url, alt: "", decoding: "async", onerror: () => plain() }));
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

	/** What is ready, and the buttons (Look first, while `look`, then Put it live and Not yet); or that nothing is. */
	#ready(
		site: CodeReleaseSite,
		can: boolean,
		look: boolean,
		busy: boolean,
		cards: Map<string, HTMLElement>,
	): HTMLElement[] {
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
			// Look first, before Put it live: a project with a site, while the read offers it.
			let first: HTMLButtonElement | null = null;
			if (look && site.site) {
				first = button(working === "look" ? t("Opening…") : t("Look first"), () => void this.#lookFirst(site), {
					disabled: busy,
				});
				first.dataset.focusKey = `look:${key}`;
			}
			actions = h("div", { class: "whats-new-actions" }, first, put, notYet);
		} else actions = h("p", { class: "whats-new-managers" }, t("Founders and admins put changes live."));
		return [
			h("h3", null, total === 1 ? t("1 change is ready") : t("{count} changes are ready", { count: String(total) })),
			listed.length ? h("div", { class: "whats-new-changes" }, ...listed) : null,
			behind ? h("p", { class: "whats-new-behind" }, behind) : null,
			actions,
		].filter((item): item is HTMLElement => item !== null);
	}

	#site(site: CodeReleaseSite, can: boolean, look: boolean, cards: Map<string, HTMLElement>): HTMLElement {
		const key = keyOf(site);
		const busy = Boolean(this.#working);
		const outcome = this.#outcome?.site === key ? this.#outcome : undefined;
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
		return h(
			"section",
			{ class: "whats-new-site", dataset: { site: key }, "aria-label": titleOf(site) },
			h("h2", null, titleOf(site)),
			this.#live(site, can, busy),
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
			...this.#ready(site, can, look, busy, cards),
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
		// Look first: only where the read offers it (owners and admins, while sites have addresses of their own).
		const look = Boolean(releases?.preview && !this.#lookOff && this.#client.openPreview);
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
