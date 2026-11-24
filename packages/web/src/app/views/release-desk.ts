import { CloudRpcError } from "../../cloud/client.ts";
import { CloudShapeError } from "../../cloud/parse.ts";
import type {
	CodeReleaseAnswer,
	CodeReleaseCalls,
	CodeReleaseChange,
	CodeReleaseReady,
	CodeReleaseSite,
	CodeReleases,
	SitePreviewAnswer,
} from "../../cloud/releases.ts";
import type { HostedStaffAgent } from "../../cloud/types.ts";
import { button, confirmDialog, h, replace } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import type { CompanyController } from "../company.ts";
import { forgetPictureUrl, pictureUrl } from "../folder-images.ts";

/**
 * What's new's desk (own code storage): the read of the company's projects that make a website, and the member's
 * writes on them, with every answer they can get and the words for each. One implementation for the two places a member
 * puts a change live: the What's new page (app/views/whats-new.ts) and the "a change is ready" card in the thread of the
 * agent behind it (app/views/thread-ready.ts; Jonas, 15 Nov 2026: "chat widgets if there are UX components we need to
 * add"). Each place draws what the desk holds and keeps nothing of its own about a write: the desk tells it when to
 * draw again (`changed`, with the control that keeps the keyboard).
 *
 * The page sends what it drew, and the kernel answers `moved` when the page moved meanwhile: it is read again. A write
 * whose answer never came may have gone through, so the desk claims neither until a read that started after it shows
 * which. Not yet records nothing: it puts "Not yet: " in the composer of the agent's thread and quiets the apps drawer's
 * badge in this browser until something new is ready. Look first opens the ready version on the site's next host in a
 * tab opened blank within the press, its way back cut at once; the one-time link the kernel answers is used once, there,
 * and kept nowhere.
 */

export interface ReleaseDeskOptions {
	/** Reads a picture of the company's folder; null when there is none to show. */
	image?: (path: string, signal: AbortSignal) => Promise<Blob | null>;
	/** Told after each read and after Not yet: the apps drawer's entry and its badge follow. */
	listed?: (releases: CodeReleases) => void;
	/** The names (slugs) of the company's sites Qorpera took down (step 5.1), read beside each read of the page. A kernel
	 * without the read fails it: the desk then keeps what the last read that answered said (none before one did). */
	takenDown?: (signal: AbortSignal) => Promise<ReadonlySet<string>>;
}

/** `openPreview` (step 5.1) may be missing: no Look first then. */
export type ReleaseClient = Pick<CodeReleaseCalls, "list" | "putLive" | "goBack"> &
	Partial<Pick<CodeReleaseCalls, "openPreview">>;

/** The changes a member quieted with Not yet, by the token of what the page showed, per member and company. */
const QUIET_KEY = "qorpera.web.whats-new-quiet";

function quietKey(company: CompanyController): string {
	return `${QUIET_KEY}:${company.profile.profileId}:${company.userId}`;
}

export function quieted(company: CompanyController): Set<string> {
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

/** A project, as the desk tells them apart. */
export const keyOf = (site: CodeReleaseSite) => `${site.owner}/${site.name}`;

/** What a member calls a project: its site's title, else its name. */
export function titleOf(site: CodeReleaseSite): string {
	return site.site?.title ?? site.site?.slug ?? site.name;
}

/** The words for how many changes are ready: What's new's heading over them, and the thread's card. */
export function readyCount(ready: CodeReleaseReady): string {
	const total = ready.changes.length + ready.quiet;
	return total === 1 ? t("1 change is ready") : t("{count} changes are ready", { count: String(total) });
}

/** Who hears Not yet for a ready change: the agent behind the newest change while it is active, else the Co-Founder. The
 * thread that shows the change's card is this agent's. */
export function readyAgent(company: CompanyController, ready: CodeReleaseReady): HostedStaffAgent | undefined {
	const named = company.staffById(ready.agent ?? undefined);
	return named?.employmentStatus === "active" ? named : company.staffById(company.cofounderId());
}

/** Why the database refused a write, in the interface language; undefined when nothing proves it did not go through.
 * Only an error PostgREST answers with one of these SQLSTATEs proves that the call's transaction rolled back: the two
 * functions raise 42501 (not an owner or admin), P0002 (no such repository) and 22023 (a malformed argument), and
 * Postgres raises 55P03 (the 3 s lock wait) and 57014 (the statement's time). Anything else may have come after a
 * commit (a gateway's 502 or 504, a 5xx with no SQLSTATE, a body that is no JSON, a malformed answer, the deadline, no
 * network): the write may have gone through, so the desk claims neither until a read shows which (E.md lists every
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

/** An action's outcome: in its project, where What's new says it (under what is live, above what is ready, under the
 * buttons), how it reads, and the last read it stays through. `live`: the version a Put it live put live, which the
 * thread's card settles on. */
export interface Outcome {
	site: string;
	at: "live" | "ready" | "actions";
	tone: "ok" | "error" | "plain";
	text: string;
	through?: number;
	live?: number;
}

/** Why the kernel refused a write it answered (`refused`): nothing changed. */
function refusedWhy(code: string): string {
	return code === "SITE_TAKEN_DOWN" ? t("Qorpera took this site down") : t("something went wrong on Qorpera's side");
}

/** What Look first says when the tab did not go to the version: where, and in its own words for each answer; undefined
 * for `off` (sites have no addresses of their own now: the button goes with the next read). */
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
			text: t("Qorpera took this site down, so it can't be opened."),
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

/** What a project is doing while it does: every button of the desk is off meanwhile. */
export interface ReleaseWork {
	readonly site: string;
	readonly action: "live" | "back" | "talk" | "look";
}

export class ReleaseDesk {
	readonly #company: CompanyController;
	readonly #client: ReleaseClient;
	readonly #lifetime = new AbortController();
	readonly #image: ReleaseDeskOptions["image"];
	readonly #listed: (releases: CodeReleases) => void;
	readonly #readTakenDown: ReleaseDeskOptions["takenDown"];
	readonly #changed: (focusKey?: string) => void;
	/** The sites Qorpera took down, by name, as the last read that answered said: no link to one. */
	#takenDown: ReadonlySet<string> = new Set();
	#releases: CodeReleases | undefined;
	#loading = true;
	#error: string | undefined;
	#working: ReleaseWork | undefined;
	/** Look first answered `off` (sites have no addresses of their own now): its button is gone until a read says
	 * otherwise. */
	#lookOff = false;
	/** The last action's outcome, in its project where it happened: a version that went live under what is live, a page
	 * that moved above what is ready now, a press that did not go through under its button. It stays through the reads
	 * that had started when it was settled (`through`; unset while its write's own read is still to come) and goes with
	 * the first later read that succeeds: the desk never keeps an old outcome over what a read shows. */
	#outcome: Outcome | undefined;
	/** A write whose answer never came (no network, the deadline): it may or may not have gone through, so the desk claims
	 * neither until a read that started after it (`after`) shows which. */
	#unsettled:
		| { site: string; action: "live" | "back"; before: number | null; to: number | null; after: number }
		| undefined;
	/** Reads started so far: each read knows its place, so one that left before a write never settles it. */
	#started = 0;
	/** Pictures read, by path: read once while the desk is open. */
	readonly #pictures = new Map<string, Promise<string | null>>();
	#imageObserver: IntersectionObserver | undefined;
	readonly #imageCallbacks = new WeakMap<Element, () => void>();
	readonly #tileBoxes = new WeakMap<Element, Element>();
	#refreshing: Promise<void> | undefined;
	#again: Promise<void> | undefined;

	/** `changed` draws the place again (with the control that keeps the keyboard, if any). Nothing is read until the
	 * place asks (`refresh`); then again each time the window comes back, as another tab or another member may have put a
	 * version live, or the member's role changed. */
	constructor(
		company: CompanyController,
		client: ReleaseClient,
		signal: AbortSignal,
		options: ReleaseDeskOptions,
		changed: (focusKey?: string) => void,
	) {
		this.#company = company;
		this.#client = client;
		this.#image = options.image;
		this.#listed = options.listed ?? (() => {});
		this.#readTakenDown = options.takenDown;
		this.#changed = changed;
		if (signal.aborted) this.#lifetime.abort();
		else signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		window.addEventListener(
			"focus",
			() => {
				if (!this.#working) void this.refresh();
			},
			{ signal: this.#lifetime.signal },
		);
	}

	dispose(): void {
		this.#lifetime.abort();
		this.#imageObserver?.disconnect();
		this.#imageObserver = undefined;
		for (const shown of this.#pictures.values()) void shown.then((url) => url && forgetPictureUrl(url));
		this.#pictures.clear();
	}

	get signal(): AbortSignal {
		return this.#lifetime.signal;
	}

	/** The last read that answered; undefined before one did, or once the cloud refused the member. */
	get releases(): CodeReleases | undefined {
		return this.#releases;
	}

	get loading(): boolean {
		return this.#loading;
	}

	/** Why the last read failed, in the member's words. */
	get error(): string | undefined {
		return this.#error;
	}

	get working(): ReleaseWork | undefined {
		return this.#working;
	}

	get outcome(): Outcome | undefined {
		return this.#outcome;
	}

	/** Look first: only where the read offers it (owners and admins, while sites have addresses of their own). */
	get look(): boolean {
		return Boolean(this.#releases?.preview && !this.#lookOff && this.#client.openPreview);
	}

	/** A site Qorpera took down: every address of it shows a "gone" page, so no link to it, and nothing the kernel would
	 * refuse (Look first, Put it live, Go back). */
	down(site: CodeReleaseSite): boolean {
		return Boolean(site.site && this.#takenDown.has(site.site.slug));
	}

	#draw(focusKey?: string): void {
		if (!this.#lifetime.signal.aborted) this.#changed(focusKey);
	}

	/** Starts from a read the company made already (the apps drawer's): drawn at once, with no read of its own; the sites
	 * Qorpera took down are read beside it. The next read is the window's coming back, or a write's own. */
	seed(releases: CodeReleases): void {
		if (this.#lifetime.signal.aborted) return;
		this.#releases = releases;
		this.#loading = false;
		this.#draw();
		void this.#readTakenDown?.(this.#lifetime.signal).then(
			(down) => {
				if (this.#lifetime.signal.aborted || this.#started > 0) return;
				this.#takenDown = down;
				this.#draw();
			},
			() => {},
		);
	}

	/** Try again after a read that failed. */
	retry(): void {
		this.#loading = true;
		this.#error = undefined;
		this.#draw();
		void this.refresh();
	}

	/** Reads the projects. A read already out may have left before the caller's write, so a caller then gets one more
	 * read after it, shared by every caller meanwhile. */
	refresh(): Promise<void> {
		if (this.#lifetime.signal.aborted) return Promise.resolve();
		if (!this.#refreshing) {
			this.#refreshing = this.#read().finally(() => {
				this.#refreshing = undefined;
			});
			return this.#refreshing;
		}
		this.#again ??= this.#refreshing.then(() => {
			this.#again = undefined;
			return this.refresh();
		});
		return this.#again;
	}

	async #read(): Promise<void> {
		const read = ++this.#started;
		try {
			// Which sites Qorpera took down, read beside the projects and drawn with them (no live row shows a dead link first).
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
	 * (the version it asked for is live: it went through; else nothing changed and the line goes, the place showing what
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
							...(pending.action === "live" ? { live: now.version } : {}),
						}
					: undefined;
			return;
		}
		if (!pending && this.#outcome?.through !== undefined && read > this.#outcome.through) this.#outcome = undefined;
	}

	/** Runs one write for a project, every button off meanwhile, then reads the projects again. */
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
							...(action === "live" ? { live: answer.version } : {}),
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
			this.#draw(focus);
		}
		await this.refresh();
		// The write's own read has run: the next read that succeeds takes its line away.
		if (this.#outcome && this.#outcome.through === undefined && !this.#unsettled) {
			this.#outcome.through = this.#started;
			this.#draw();
		}
	}

	/** Put it live: every change after the live version up to the ready one, as the place drew it. */
	putLive(site: CodeReleaseSite): Promise<void> {
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

	/** Go back (What's new only): asked once, then the version before goes live again. */
	async goBack(site: CodeReleaseSite): Promise<void> {
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

	/** Not yet: the agent of the newest ready change hears it in the member's own words, with "Not yet: " waiting in the
	 * composer of its thread; nothing is sent. From What's new the thread opens (the Co-Founder's when no agent made the
	 * change, or it left); from the agent's thread itself (`here`, its session), "Not yet: " goes into its composer where
	 * it stands, and the place puts the keyboard there. */
	async notYet(site: CodeReleaseSite, here?: string): Promise<void> {
		const ready = site.ready;
		if (!ready || this.#working || this.#lifetime.signal.aborted) return;
		const company = this.#company;
		const profileId = company.profile.profileId;
		const key = keyOf(site);
		const cofounderId = company.cofounderId();
		const agent = readyAgent(company, ready);
		const from = location.hash;
		this.#working = { site: key, action: "talk" };
		this.#outcome = undefined;
		this.#draw(`talk:${key}`);
		try {
			let sessionId: string;
			let isCofounder = false;
			if (here !== undefined) sessionId = here;
			else {
				if (!agent) throw new Error("No agent to tell");
				isCofounder = agent.id === cofounderId;
				if (isCofounder) {
					const opened = await company.openCofounderConversation();
					if (!opened.sessionId) throw new Error("No Co-Founder thread");
					sessionId = opened.sessionId;
				} else sessionId = await company.openStaffConversation(agent);
			}
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
			if (here === undefined && agent && location.hash === from)
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
			this.#draw(`talk:${key}`);
		}
	}

	/** Look first: the ready version on the site's next host, in a new tab. The tab is opened blank within the press (one
	 * opened after the call would be stopped by the browser) and its way back to this window is cut at once, before
	 * anything loads in it; only then is the one-time link asked for, and the tab sent there. The link is used that once
	 * and goes nowhere else: not on the page, not in storage, not in a line. Any other answer closes the tab and says why
	 * under the buttons (or, for a page that moved, above what is ready now, read again). */
	async lookFirst(site: CodeReleaseSite): Promise<void> {
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
		if (again) await this.refresh();
		// The line goes with the second read that succeeds after it (or after the press): coming back from the closed tab
		// reads the projects once (the window's focus), and that read leaves it.
		if (said && this.#outcome === said) said.through = this.#started + (tab ? 1 : 0);
		this.#draw();
	}

	/** What a member can press for what is ready, in both places: for an owner or admin (`can`) Look first (while `look`,
	 * a project with a site), Put it live and Not yet, each saying while it works ("Putting it live…", "Opening…",
	 * "Working…"), all off while anything works (`busy`); for anyone else the sentence that says who does. A site Qorpera
	 * took down (`down`) keeps only Not yet: the kernel refuses Look first and Put it live until it is restored (the review
	 * of #1774, round 3). From the agent's own thread (`here`, its session) Not yet stays there (`notYet`), and the buttons
	 * keep their short words whatever happens: "Put it live" for a first version too, and no other words while a press
	 * is on its way (the pressed one is marked busy and all are off), so the card's one row of them never changes width
	 * (the review of #1850). */
	actions(
		site: CodeReleaseSite,
		can: boolean,
		look: boolean,
		busy: boolean,
		down: boolean,
		here?: { readonly sessionId: string; readonly done: () => void },
	): HTMLElement {
		if (!can) return h("p", { class: "whats-new-managers" }, t("Founders and admins put changes live."));
		const key = keyOf(site);
		const working = this.#working?.site === key ? this.#working.action : undefined;
		const short = Boolean(here);
		let put: HTMLButtonElement | null = null;
		if (!down) {
			put = button(
				short
					? t("Put it live")
					: working === "live"
						? t("Putting it live…")
						: site.live
							? t("Put it live")
							: t("Put the first version live"),
				() => void this.putLive(site),
				{ primary: true, disabled: busy },
			);
			put.dataset.focusKey = `live:${key}`;
			if (short && working === "live") put.setAttribute("aria-busy", "true");
		}
		const notYet = button(
			working === "talk" && !short ? t("Working…") : t("Not yet"),
			() => void (here ? this.notYet(site, here.sessionId).then(here.done) : this.notYet(site)),
			{ disabled: busy },
		);
		notYet.dataset.focusKey = `talk:${key}`;
		if (short && working === "talk") notYet.setAttribute("aria-busy", "true");
		// Look first, before Put it live: a project with a site, while the read offers it.
		let first: HTMLButtonElement | null = null;
		if (look && site.site && !down) {
			first = button(
				working === "look" && !short ? t("Opening…") : t("Look first"),
				() => void this.lookFirst(site),
				{
					disabled: busy,
				},
			);
			first.dataset.focusKey = `look:${key}`;
			if (short && working === "look") first.setAttribute("aria-busy", "true");
		}
		return h("div", { class: "whats-new-actions" }, first, put, notYet);
	}

	/** A change as both places show it: its picture with its one line under it (and "Was live before" when Go back took
	 * it off once), or the line alone on a plain tile. Pictures are read as they come near the screen, once while the desk
	 * is open; a file that is no picture after all (it does not decode) is the line on its tile, as one not read. */
	tile(change: CodeReleaseChange, className = "whats-new-change"): HTMLElement {
		const was = change.wasLive ? h("small", { class: "whats-new-was" }, t("Was live before")) : null;
		const line = h("p", { class: "whats-new-line" }, change.notice);
		const card = h("article", { class: className });
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
				box.append(h("img", { src: url, alt: "", decoding: "async", onerror: () => plain() }));
			});
		};
		if (typeof IntersectionObserver !== "function") show();
		else {
			if (!this.#imageObserver) {
				this.#imageObserver = new IntersectionObserver(
					(entries) => {
						for (const entry of entries) {
							if (!entry.isIntersecting) continue;
							const run = this.#imageCallbacks.get(entry.target);
							this.#imageCallbacks.delete(entry.target);
							this.#imageObserver?.unobserve(entry.target);
							run?.();
						}
					},
					{ rootMargin: "200px" },
				);
			}
			this.#imageCallbacks.set(box, show);
			this.#tileBoxes.set(card, box);
			this.#imageObserver.observe(box);
		}
		return card;
	}

	// WHY: Unobserve detached tile picture boxes when a view redraws and drops old cards so IntersectionObserver does not retain removed DOM nodes.
	forgetTile(card: Element): void {
		const box = this.#tileBoxes.get(card);
		if (!box) return;
		this.#tileBoxes.delete(card);
		this.#imageCallbacks.delete(box);
		this.#imageObserver?.unobserve(box);
	}
}
