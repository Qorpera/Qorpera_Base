import { CloudRpcError } from "../../cloud/client.ts";
import type {
	CompanySite,
	CompanySiteNamed,
	CompanySitePassword,
	CompanySiteTakedown,
	WebSites,
} from "../../cloud/sites.ts";
import { type MenuEntry, openContextMenu, openMenu } from "../../ui/context-menu.ts";
import { button, confirmDialog, fmtTime, h, icon, replace } from "../../ui/dom.ts";
import { interfaceEmblem } from "../../ui/interface-emblem.ts";
import { leave } from "../../ui/motion.ts";
import { phrase, t } from "../../ui/preferences.ts";
import { uiScale } from "../../ui/scale.ts";
import { listSkeleton } from "../../ui/skeleton.ts";

/**
 * The Sites page (`#/c/<id>/sites`, opened from the apps drawer; Jonas, 9 Nov 2026: out of Settings): the websites the
 * company's agents published, each at its own link on sites.qorpera.com with its own password. Redone on 12 Nov 2026 as
 * the Mailbox was (Jonas: "easy, minimalistic and pleasing"): a title and one short line, then one row per site on a
 * hairline, with no box: the Sites globe, the site's title and whether it is live, then its link as a pill (a press
 * copies it, the arrow opens it) and, for an owner or admin, its password as a pill beside it, hidden as dots, with an
 * eye to show it. What is done rarely is in the row's "⋯" menu: Change password and Take offline. What just happened is
 * said in a small dark toast at the foot (styles/sites.css).
 *
 * Every member sees each site's title, link and state. An owner or admin also reads a site's password (to share it),
 * changes it (every visitor then enters the new one) and takes a site offline; the kernel refuses anyone else. Agents
 * never see a password. An app link (v195) is a site too, at its own host. A project's site made from its code kept in
 * Qorpera (own code storage step 4) is listed once a member put it live in What's new; its source is the project's place
 * under code/, which no agent may publish from, and its row names the version What's new has live.
 *
 * A site Qorpera took down (step 5.1; the access read, `qorpera_company_site_access`) says so in its row in one plain
 * sentence with the operator's reason, in place of its link and password: every address of it shows a "gone" page, so
 * the row offers no link to one, and no "⋯": until Qorpera restores it the kernel refuses taking it offline, and its
 * password opens nothing. A project's site taken down before it ever went live is in no list: its row is drawn from
 * the access read, which names it (the review of #1774, F4), the same row. A kernel without the read draws the page as
 * before.
 *
 * Every answer that comes back late (a password read, a copy, a change, a take-offline, a read of the list, the version
 * What's new read) acts only on the page it was asked from, by one rule in three parts: it carries the moment it left
 * (`#moment`: its site, and the generation of what the page knew of that site's password) and acts only while `#still`
 * holds (the page mounted, the site listed, and for a password the same generation: not shown, hidden, changed or taken
 * away since); a password is put on screen only through `#reveal`, which refuses one the member may not see or one the
 * list says was changed after it; and a draw moves the focus only while `#mayFocus` holds (the focus on this page or on
 * nothing, and no question, confirmation or menu open over it).
 */

/** `access` (step 5.1) may be missing: the page is then drawn as before it. */
type SitesClient = Pick<WebSites, "list" | "password" | "setPassword" | "unpublish"> &
	Partial<Pick<WebSites, "access">>;

export interface SitesAccess {
	/** Whether the signed-in member may see passwords, change them and take sites offline (owner or admin; the
	 * kernel enforces the same rule). */
	canManage(): boolean;
}

/** Sites made from a project's code: where What's new is, and the version of each that it has live (as last read). */
export interface SitesReleases {
	readonly href: string;
	version(site: CompanySite): number | undefined;
}

export interface SitesOptions {
	access?: SitesAccess;
	/** Told the sites after each read and after one is taken offline: the apps drawer shows Sites while there are any. */
	listed?: (sites: readonly CompanySite[]) => void;
	releases?: SitesReleases;
	/** The company's Co-Founder, on the page while there is no site. */
	mascot?: () => HTMLElement | null;
}

const FULL_ACCESS: SitesAccess = { canManage: () => true };
const MANAGERS_ONLY = phrase("Only founders and admins can see passwords or take sites offline.");
/** How long the toast stays. */
const TOAST_MS = 4000;
/** How long a pill shows its check after a copy. */
const COPIED_MS = 1600;
/** A hidden password: twelve dots, whatever its length (the kernel's own are twelve letters and two dashes). */
const DOTS = "••••••••••••";

/** A site as members call it: its title, else its name in the link. */
export function nameOf(site: CompanySite): string {
	return site.title ?? site.slug;
}

/** The row of a site Qorpera took down that the list leaves out (a project's site that never went live), from what the
 * access read names: the row shows its name, that it was taken down and why, and nothing else (no link, password or
 * menu). */
function unlisted(id: string, named: CompanySiteNamed, down: CompanySiteTakedown): CompanySite {
	return {
		id,
		slug: named.slug,
		title: named.title,
		kind: named.kind,
		url: "",
		state: named.kind === "app" ? "off" : "publishing",
		source: named.source,
		files: 0,
		bytes: 0,
		publishedAt: null,
		publishedBy: null,
		createdAt: down.at,
		passwordChangedAt: down.at,
		machine: null,
		port: null,
	};
}

/** A project's site made from its code: only What's new puts a version of it live (the row is the plain one, with the
 * project's place under code/ as its source). */
function fromCode(site: CompanySite): boolean {
	return site.kind === "files" && site.source.startsWith("code/");
}

/** A site's link as the page shows it: no https:// in front and no slash at the end. */
export function shownLink(url: string): string {
	return url.replace(/^https:\/\//, "").replace(/\/$/, "");
}

/** The globe a site carries, in the Sites app's colour (styles/sites.css): each row of the Sites page, and What's new's
 * live row. */
export function siteEmblem(): SVGSVGElement {
	const emblem = interfaceEmblem("globe", 28);
	emblem.classList.add("site-emblem");
	return emblem;
}

/** Why a change was refused, in the interface language. */
export function changeError(error: unknown, fallback: string): string {
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

/** What to press to copy a text the page selected, when the browser would not let the page copy it. */
export function pressToCopy(): string {
	return /Mac|iPhone|iPad/.test(navigator.userAgent) ? t("Press ⌘C to copy.") : t("Press Ctrl+C to copy.");
}

/** Puts a text on the clipboard; false when the browser refuses. A text still being read is handed over as it is read,
 * where the browser takes that (a ClipboardItem of a promise), so the copy keeps the press it came from: Safari copies
 * only within the press. */
export async function toClipboard(text: string | Promise<string>): Promise<boolean> {
	const clipboard = navigator.clipboard as Clipboard | undefined;
	if (typeof text !== "string" && typeof ClipboardItem === "function" && typeof clipboard?.write === "function") {
		try {
			const blob = text.then((value) => new Blob([value], { type: "text/plain" }));
			// A read that fails is told by the caller, which waits on the read itself.
			blob.catch(() => {});
			await clipboard.write([new ClipboardItem({ "text/plain": blob })]);
			return true;
		} catch {
			// A browser that takes no promise there may still take the text itself.
		}
	}
	try {
		if (!clipboard) return false;
		await clipboard.writeText(await text);
		return true;
	} catch {
		return false;
	}
}

/** A password the list says was changed after it (the kernel writes both times from one column, so they compare). */
export function outdated(site: CompanySite, password: CompanySitePassword): boolean {
	return Date.parse(site.passwordChangedAt) > Date.parse(password.changedAt);
}

/** What a late answer was asked for: its site, and the generation of what the page knew of that site's password. */
interface Moment {
	readonly site: string;
	readonly era: number;
}

/** The site's state as a dot and a word; when and by whom it was published as its tip. A site Qorpera took down is that,
 * whatever the list says of it. */
function stateOf(site: CompanySite, down: boolean): HTMLElement {
	const published = site.publishedAt
		? site.publishedBy
			? t("Published {time} by {agent}", { time: fmtTime(site.publishedAt), agent: site.publishedBy.name })
			: t("Published {time}", { time: fmtTime(site.publishedAt) })
		: undefined;
	return h(
		"span",
		{ class: `site-state is-${down ? "down" : site.state}`, ...(published ? { title: published } : {}) },
		h("span", { class: "site-dot", "aria-hidden": "true" }),
		down ? t("Taken down") : site.state === "live" ? t("Live") : site.state === "off" ? t("Off") : t("Publishing…"),
	);
}

/** Why Qorpera took a site down, in one plain sentence: the operator's reason, without a full stop of its own, and how
 * to tell Qorpera it is wrong, through the product's own channel: Feedback in the member's menu, by that item's own
 * label (the lead's call, 13 Nov 2026: no address that is not known to reach anyone). */
function downLine(down: CompanySiteTakedown): HTMLElement {
	const reason = down.reason.replace(/[\s.]+$/, "") || down.reason;
	return h(
		"p",
		{ class: "site-down" },
		t("Qorpera took this site down: {reason}. If you think this is wrong, tell us with {feedback} in your menu.", {
			reason,
			feedback: t("Feedback"),
		}),
	);
}

/** What a site's pills show beside the site: whether the member may see its password (`manage`), whether a change is
 * on its way (`busy`: the password's controls are off) or its password is being read (`reading`), the password shown
 * (else dots), a text the browser would not copy shown whole to copy by hand, and what each press does. */
export interface SitePillsState {
	readonly manage: boolean;
	readonly busy: boolean;
	readonly reading: boolean;
	readonly password: string | undefined;
	readonly byHandLink: string | undefined;
	readonly byHandPassword: string | undefined;
	readonly copyLink: () => void;
	readonly copyPassword: () => void;
	readonly eye: () => void;
}

/** What a pill shows when the browser would not copy its text: the text whole, in a field that selects it. */
function byHandField(text: string, label: string, focusKey: string): HTMLElement {
	const field = h("input", {
		type: "text",
		class: "site-pill-field",
		readonly: true,
		value: text,
		"aria-label": label,
		onfocus: (event: FocusEvent) => (event.target as HTMLInputElement).select(),
	});
	field.dataset.focusKey = focusKey;
	return field;
}

const pillLead = (kind: string) => h("span", { class: "site-pill-lead" }, icon(kind), icon("copy"), icon("check"));

/** A site's link as a pill: a press on it copies it, the arrow opens the site; with `byHand`, the link whole in a field
 * to copy by hand. `id` names its controls (`site-copy-link:<id>`, `site-by-hand:link:<id>`). The Sites page's rows,
 * a site's card in a thread, and the line a thread's card settles on once a change is live. */
export function siteLinkPill(id: string, url: string, byHand: string | undefined, copy: () => void): HTMLElement {
	const copyLink = h(
		"button",
		{
			type: "button",
			class: "site-pill-main site-link-copy",
			title: t("Copy the link"),
			// Its name is the link it shows; with the link in the field beside it, what it does.
			...(byHand === undefined ? {} : { "aria-label": t("Copy the link") }),
			onclick: copy,
		},
		pillLead("link"),
		byHand === undefined ? h("span", { class: "site-pill-text" }, shownLink(url)) : null,
	);
	copyLink.dataset.focusKey = `site-copy-link:${id}`;
	return h(
		"div",
		{ class: "site-pill site-link" },
		copyLink,
		byHand === undefined ? null : byHandField(byHand, t("The link"), `site-by-hand:link:${id}`),
		h(
			"a",
			{
				class: "site-pill-icon site-link-open",
				href: url,
				target: "_blank",
				rel: "noopener noreferrer",
				title: t("Open the site"),
				"aria-label": t("Open the site"),
			},
			icon("external"),
		),
	);
}

/** A site's link and, for an owner or admin, its password, each a pill (the Sites page's rows, and a site's card in a
 * thread). */
export function sitePills(site: CompanySite, state: SitePillsState): HTMLElement {
	const link = siteLinkPill(site.id, site.url, state.byHandLink, state.copyLink);
	let secret: HTMLElement | null = null;
	if (state.manage) {
		const shown = state.password;
		const byHandPassword = state.byHandPassword;
		const copyPassword = h(
			"button",
			{
				type: "button",
				class: `site-pill-main site-secret-copy${shown !== undefined ? " is-shown" : ""}`,
				title: t("Copy the password"),
				disabled: state.busy,
				// Its name is the password once shown; hidden, or in the field beside it, what it does.
				...(shown !== undefined && byHandPassword === undefined ? {} : { "aria-label": t("Copy the password") }),
				...(state.reading ? { "aria-busy": "true" } : {}),
				onclick: state.copyPassword,
			},
			pillLead("key"),
			byHandPassword === undefined
				? h(
						"span",
						{
							class: "site-pill-text site-secret-text",
							...(shown !== undefined ? {} : { "aria-hidden": "true" }),
						},
						shown ?? DOTS,
					)
				: null,
		);
		copyPassword.dataset.focusKey = `site-copy-password:${site.id}`;
		const eye = h(
			"button",
			{
				type: "button",
				class: "site-pill-icon site-eye",
				title: shown !== undefined ? t("Hide password") : t("Show password"),
				"aria-label": shown !== undefined ? t("Hide password") : t("Show password"),
				disabled: state.busy,
				onclick: state.eye,
			},
			icon(shown !== undefined ? "hide" : "show"),
		);
		eye.dataset.focusKey = `site-eye:${site.id}`;
		secret = h(
			"div",
			{ class: `site-pill site-secret${state.reading ? " is-reading" : ""}` },
			copyPassword,
			byHandPassword === undefined
				? null
				: byHandField(byHandPassword, t("The password"), `site-by-hand:password:${site.id}`),
			eye,
		);
	}
	return h("div", { class: "site-share" }, link, secret);
}

/** A site's row (styles/sites.css): the Sites globe, its title and state (what `head` adds after them), the row's menu
 * if any, and under them its pills, or, for a site Qorpera took down, why. The Sites page draws each site with it, and a
 * thread draws a site a message links with it, compact (`classes`). */
export function siteRow(
	site: CompanySite,
	down: CompanySiteTakedown | undefined,
	parts: {
		readonly head?: HTMLElement | null;
		readonly more?: HTMLElement | null;
		readonly share: () => HTMLElement;
		readonly classes?: readonly (string | false | undefined)[];
	},
): HTMLElement {
	return h(
		"article",
		{
			class: ["site-row", `is-${down ? "down" : site.state}`, ...(parts.classes ?? [])].filter(Boolean).join(" "),
			dataset: { site: site.id },
			"aria-label": nameOf(site),
		},
		siteEmblem(),
		h(
			"div",
			{ class: "site-head" },
			h("strong", { class: "site-name" }, nameOf(site)),
			stateOf(site, Boolean(down)),
			parts.head ?? null,
		),
		parts.more ?? null,
		down ? downLine(down) : parts.share(),
	);
}

export class SitesView {
	readonly el = h("div", { class: "sites" });
	/** The page's scroller: it stays, so a redraw keeps its scroll. */
	readonly #scroll = h("div", { class: "sites-scroll" });
	/** Where the toast is said: a live region that stays, its words drawn anew each time. */
	readonly #toast = h("div", { class: "sites-toast-area", role: "status" });
	readonly #client: SitesClient;
	readonly #lifetime = new AbortController();
	readonly #access: SitesAccess;
	readonly #listed: (sites: readonly CompanySite[]) => void;
	readonly #releases: SitesReleases | undefined;
	readonly #mascot: (() => HTMLElement | null) | undefined;
	#mascotEl: HTMLElement | null | undefined;
	/** What the last draw drew from outside the page: the member's authority and the code sites' versions. */
	#drawn: { manage: boolean; versions: string } | undefined;
	#sites: CompanySite[] | undefined;
	/** The sites Qorpera took down, by id, as the last access read that answered said (none before one did). */
	#takenDown: ReadonlyMap<string, CompanySiteTakedown> = new Map();
	/** Their names, as that read gave them: a row for one the list leaves out. */
	#named: ReadonlyMap<string, CompanySiteNamed> = new Map();
	#loading = true;
	#error: string | undefined;
	/** The site changing, and how, while it does: the password pills and the menus are off meanwhile. */
	#working: { site: string; action: "show" | "copy" | "set" | "unpublish" } | undefined;
	/** Passwords shown, by site, until hidden or the member's authority goes. Only `#reveal` and `#forget` change it. */
	readonly #passwords = new Map<string, CompanySitePassword>();
	/** Each site's password generation: one more each time what the page knows of its password moves on (`#moment`). */
	readonly #eras = new Map<string, number>();
	/** A text the browser would not copy, shown whole in its pill as a field, selected for the member to copy by hand. */
	#byHand: { key: string; text: string } | undefined;
	/** Rows drawn before: only a new row moves in. */
	readonly #seen = new Set<string>();
	/** The site whose row is leaving after it was taken offline. */
	#leaving: string | undefined;
	/** The press that shut a row's menu, so the click it ends in opens nothing. */
	#menuShut: { site: string; press: Event } | undefined;
	/** The change-password question, while it is open. */
	#asking: { site: string; close(): void } | undefined;
	#said = 0;
	#refreshing: Promise<void> | undefined;
	/** One more read, asked for while a read was out, and the focus it draws with. */
	#again: { read: Promise<void>; focusKey: string | undefined } | undefined;

	constructor(client: SitesClient, signal: AbortSignal, options: SitesOptions = {}) {
		this.#client = client;
		this.#access = options.access ?? FULL_ACCESS;
		this.#listed = options.listed ?? (() => {});
		this.#releases = options.releases;
		this.#mascot = options.mascot;
		this.el.append(this.#scroll, this.#toast);
		if (signal.aborted) this.#lifetime.abort();
		else signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		this.#draw();
		void this.#refresh();
	}

	/** Redraws when what the page shows from outside it changed: the member's authority over the company's sites (the
	 * team loads after the page, or a role changes while it is open), or the version What's new has live of a site made
	 * from code. A member who is no longer an owner or admin keeps no password on screen. */
	update(): void {
		if (this.#lifetime.signal.aborted) return;
		const manage = this.#access.canManage();
		if (manage === this.#drawn?.manage && this.#versions() === this.#drawn.versions) return;
		if (!manage) {
			for (const site of new Set([...this.#passwords.keys(), ...(this.#sites ?? []).map((item) => item.id)]))
				this.#forget(site);
			this.#asking?.close();
		}
		this.#draw();
	}

	dispose(): void {
		this.#lifetime.abort();
		this.#passwords.clear();
		this.#byHand = undefined;
		this.#asking?.close();
		this.el.replaceChildren();
		this.el.remove();
	}

	/** What a late answer was asked for, taken when it leaves. */
	#moment(site: string): Moment {
		return { site, era: this.#eras.get(site) ?? 0 };
	}

	/** Whether a late answer may still act: the page is mounted, its site still listed, and (`secret`) the site's password
	 * is as the page knew it when the answer was asked for. */
	#still(moment: Moment, secret: boolean): boolean {
		if (this.#lifetime.signal.aborted) return false;
		if (this.#sites && !this.#sites.some((site) => site.id === moment.site)) return false;
		return !secret || (this.#eras.get(moment.site) ?? 0) === moment.era;
	}

	/** Puts a password on screen, unless the member may not see passwords or the list says it was changed after it. */
	#reveal(site: string, password: CompanySitePassword): boolean {
		const listed = this.#sites?.find((item) => item.id === site);
		if (!this.#access.canManage() || !listed || outdated(listed, password)) return false;
		this.#passwords.set(site, password);
		this.#eras.set(site, (this.#eras.get(site) ?? 0) + 1);
		return true;
	}

	/** Takes a site's password off the screen, with the field that held it to copy by hand. */
	#forget(site: string): void {
		this.#passwords.delete(site);
		if (this.#byHand?.key === `password:${site}`) this.#byHand = undefined;
		this.#eras.set(site, (this.#eras.get(site) ?? 0) + 1);
	}

	/** Whether a draw may move the focus: it is on this page or on nothing, and no question, confirmation or menu is
	 * open over it (a late answer never pulls the focus out from under the member). */
	#mayFocus(): boolean {
		const active = document.activeElement;
		const here = !active || active === document.body || this.el.contains(active);
		return here && !this.#asking && !openMenu() && !document.querySelector(".modal-backdrop:not([data-leaving])");
	}

	#versions(): string {
		return JSON.stringify(
			(this.#sites ?? []).filter(fromCode).map((site) => [site.id, this.#releases?.version(site) ?? null]),
		);
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
			// Which sites Qorpera took down, read beside the list and drawn with it (no row shows a dead link first). A read
			// that fails (a kernel without it, or no answer) keeps what the last one said.
			const access = this.#client.access?.(this.#lifetime.signal).catch(() => undefined);
			const sites = await this.#client.list(this.#lifetime.signal);
			const read = await access;
			if (this.#lifetime.signal.aborted) return;
			if (read) {
				this.#takenDown = read.takenDown;
				this.#named = read.named;
				// A site taken down shows no password: one on screen goes, and stays hidden if the site comes back.
				for (const id of read.takenDown.keys()) if (this.#passwords.has(id)) this.#forget(id);
			}
			// A site Qorpera took down that the list leaves out (a project's site that never went live): a row of its own,
			// after the listed ones.
			const listed = new Set(sites.map((site) => site.id));
			const missing = [...this.#takenDown].flatMap(([id, down]) => {
				const named = this.#named.get(id);
				return named && !listed.has(id) ? [unlisted(id, named, down)] : [];
			});
			this.#sites = missing.length ? [...sites, ...missing] : sites;
			this.#listed(this.#sites);
			this.#error = undefined;
			// A site gone meanwhile (taken offline elsewhere) leaves nothing of its own behind, and a password changed
			// since it was shown (elsewhere) leaves the screen.
			const byId = new Map(sites.map((site) => [site.id, site]));
			for (const [id, shown] of [...this.#passwords]) {
				const site = byId.get(id);
				if (!site || outdated(site, shown)) this.#forget(id);
			}
			for (const id of this.#eras.keys()) if (!byId.has(id)) this.#forget(id);
			if (this.#byHand && !byId.has(this.#byHand.key.slice(this.#byHand.key.indexOf(":") + 1)))
				this.#byHand = undefined;
			if (this.#asking && !byId.has(this.#asking.site)) this.#asking.close();
		} catch {
			if (this.#lifetime.signal.aborted) return;
			this.#error = t("The company's sites could not be read.");
		} finally {
			this.#loading = false;
			if (!this.#lifetime.signal.aborted) this.#draw(focusKey);
		}
	}

	/** Says what just happened at the foot of the page, for a few seconds. */
	#say(text: string): void {
		if (this.#lifetime.signal.aborted) return;
		const id = ++this.#said;
		const toast = h("div", { class: "sites-toast" }, text);
		replace(this.#toast, toast);
		setTimeout(() => {
			if (this.#said !== id || this.#lifetime.signal.aborted) return;
			leave(toast, "is-leaving", () => toast.remove());
		}, TOAST_MS);
	}

	/** A pill's check, for a moment after its text was copied. */
	#copied(focusKey: string): void {
		const pill = this.#control(focusKey);
		if (!pill) return;
		pill.classList.add("is-copied");
		setTimeout(() => pill.classList.remove("is-copied"), COPIED_MS);
	}

	#control(focusKey: string): HTMLElement | undefined {
		return [...this.el.querySelectorAll<HTMLElement>("[data-focus-key]")].find(
			(item) => item.dataset.focusKey === focusKey,
		);
	}

	/** The browser would not copy: the text is shown whole in its pill, selected, and the toast says what to press. */
	#copyByHand(key: string, text: string, focusKey: string): void {
		const free = this.#mayFocus();
		this.#byHand = { key, text };
		this.#draw(focusKey);
		const field = this.#control(focusKey);
		if (free && field instanceof HTMLInputElement) {
			field.focus();
			field.select();
		}
		this.#say(pressToCopy());
	}

	async #copyLink(site: CompanySite): Promise<void> {
		const focusKey = `site-copy-link:${site.id}`;
		const moment = this.#moment(site.id);
		const copied = await toClipboard(site.url);
		if (!this.#still(moment, false)) return;
		if (!copied) return this.#copyByHand(`link:${site.id}`, site.url, `site-by-hand:link:${site.id}`);
		if (this.#byHand?.key === `link:${site.id}`) {
			this.#byHand = undefined;
			this.#draw(focusKey);
		}
		this.#copied(focusKey);
		this.#say(t("The link is copied."));
	}

	/** Copies a site's password: the one shown, or one read for it there and then (it stays hidden). */
	async #copyPassword(site: CompanySite): Promise<void> {
		if (this.#working || this.#lifetime.signal.aborted) return;
		const focusKey = `site-copy-password:${site.id}`;
		const byHand = `site-by-hand:password:${site.id}`;
		const moment = this.#moment(site.id);
		const shown = this.#passwords.get(site.id);
		if (shown) {
			const copied = await toClipboard(shown.password);
			// Hidden, changed or taken away meanwhile: nothing of that password comes back on screen.
			if (!this.#still(moment, true)) return;
			if (!copied) return this.#copyByHand(`password:${site.id}`, shown.password, byHand);
			this.#copied(focusKey);
			this.#say(t("The password is copied."));
			return;
		}
		const working = { site: site.id, action: "copy" } as const;
		this.#working = working;
		this.#draw(focusKey);
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
		if (!this.#still(moment, true)) return this.#draw(focusKey);
		if (!password) {
			this.#draw(focusKey);
			this.#say(changeError(failure, phrase("The password could not be read. Try again.")));
			// The site may be gone (taken offline elsewhere): the read drops it.
			void this.#refresh(focusKey);
			return;
		}
		if (!copied) {
			if (!this.#reveal(site.id, password)) return this.#draw(focusKey);
			return this.#copyByHand(`password:${site.id}`, password.password, byHand);
		}
		this.#draw(focusKey);
		this.#copied(focusKey);
		this.#say(t("The password is copied."));
	}

	async #showPassword(site: CompanySite): Promise<void> {
		if (this.#working || this.#lifetime.signal.aborted) return;
		const focusKey = `site-eye:${site.id}`;
		const moment = this.#moment(site.id);
		const working = { site: site.id, action: "show" } as const;
		this.#working = working;
		this.#draw(focusKey);
		let password: CompanySitePassword | undefined;
		let failure: unknown;
		try {
			password = await this.#client.password(site.id, this.#lifetime.signal);
		} catch (error) {
			failure = error;
		}
		if (this.#working === working) this.#working = undefined;
		if (this.#lifetime.signal.aborted) return;
		// Its authority gone, or the site taken offline elsewhere meanwhile: the answer shows nothing.
		if (password && this.#still(moment, true)) this.#reveal(site.id, password);
		this.#draw(focusKey);
		if (password || !this.#still(moment, false)) return;
		this.#say(changeError(failure, phrase("The password could not be read. Try again.")));
		// The site may be gone (taken offline elsewhere): the read drops it.
		await this.#refresh(focusKey);
	}

	#hidePassword(site: CompanySite): void {
		this.#forget(site.id);
		this.#draw(`site-eye:${site.id}`);
	}

	/** The row's menu: what is done rarely. A press on "⋯" while its menu is open only shuts it. A site Qorpera took down
	 * has none (`#row`); one open as the read says so does nothing (`#unpublish`). */
	#openMenu(site: CompanySite, opener: HTMLElement): void {
		const findOpener = () => this.#control(`site-more:${site.id}`) ?? null;
		const box = opener.getBoundingClientRect();
		const offline: MenuEntry = {
			label: t("Take offline"),
			icon: "power",
			danger: true,
			select: () => void this.#unpublish(site),
		};
		const menu = openContextMenu({
			label: nameOf(site),
			x: box.left,
			y: box.bottom + 4 * uiScale(),
			opener,
			findOpener,
			onClose: (press) => {
				this.#menuShut = press ? { site: site.id, press } : undefined;
				findOpener()?.setAttribute("aria-expanded", "false");
			},
			items: [
				{ label: t("Change password"), icon: "key", select: () => this.#askPassword(site) },
				{ kind: "separator" },
				offline,
			],
		});
		// The menu hangs from the button's right edge, as the button stands at the row's end.
		const left = Math.max(8 * uiScale(), box.right - menu.el.offsetWidth);
		if (left < box.left) {
			menu.el.style.left = `${left}px`;
			menu.el.style.transformOrigin = "top right";
		}
		opener.setAttribute("aria-expanded", "true");
	}

	/** Asks for a site's new password: one the member types, or a new random one. The question stays while the change
	 * is on its way, and says there why one was refused, keeping what was typed. */
	#askPassword(site: CompanySite): void {
		if (this.#working || this.#asking || this.#lifetime.signal.aborted || !this.#access.canManage()) return;
		const signal = this.#lifetime.signal;
		const name = nameOf(site);
		const title = `site-password-title-${site.id}`;
		let busy = false;
		let closed = false;
		const input = h("input", {
			type: "text",
			class: "sites-question-input",
			maxlength: "128",
			autocomplete: "off",
			autocapitalize: "none",
			spellcheck: "false",
			placeholder: t("Type a new password, 10 to 128 characters"),
			"aria-label": t("New password for {name}", { name }),
		});
		const problem = h("p", { class: "sites-question-problem", role: "alert" });
		const save = button(t("Save password"), () => {}, { primary: true });
		save.type = "submit";
		// A new random password: a quiet line under the field, so the question keeps two buttons on a phone too.
		const randomLabel = h("span", null, t("Make a new password"));
		const random = h(
			"button",
			{ type: "button", class: "sites-question-random", onclick: () => void submit(null) },
			icon("reload"),
			randomLabel,
		);
		const cancel = button(t("Cancel"), () => close());
		const controls = [input, save, random, cancel];
		const close = (focusKey?: string) => {
			if (closed) return;
			closed = true;
			if (this.#asking?.site === site.id) this.#asking = undefined;
			leave(backdrop, "is-leaving", () => backdrop.remove());
			window.removeEventListener("hashchange", onHash);
			const back = (focusKey ? this.#control(focusKey) : undefined) ?? this.#control(`site-more:${site.id}`);
			if (back && !back.matches(":disabled")) back.focus();
		};
		const onHash = () => close();
		const submit = async (password: string | null) => {
			if (busy || closed) return;
			if (password !== null) {
				const wrong = passwordProblem(password);
				if (wrong) {
					problem.textContent = wrong;
					input.focus();
					return;
				}
			}
			busy = true;
			problem.textContent = "";
			for (const control of controls) control.disabled = true;
			const pressed = password === null ? randomLabel : save;
			const words = pressed.textContent;
			pressed.textContent = t("Working…");
			const moment = this.#moment(site.id);
			const working = { site: site.id, action: "set" } as const;
			this.#working = working;
			this.#draw();
			let next: CompanySitePassword | undefined;
			let failure: unknown;
			try {
				next = await this.#client.setPassword(site.id, password, signal);
			} catch (error) {
				failure = error;
			}
			if (this.#working === working) this.#working = undefined;
			if (signal.aborted) return;
			if (next) {
				// The old password leaves the screen, and the new one stands in its place, ready to copy and share, unless
				// the question was closed meanwhile (the member left, or lost their authority, or the site went) or the list
				// says the password changed again since.
				this.#forget(site.id);
				const shown = !closed && this.#still(moment, false) && this.#reveal(site.id, next);
				this.#draw();
				close(shown ? `site-copy-password:${site.id}` : undefined);
				if (this.#still(moment, false)) this.#say(t("The password is changed."));
				void this.#refresh(shown ? `site-copy-password:${site.id}` : undefined);
				return;
			}
			this.#draw();
			// A question closed meanwhile (the member left it, lost their authority, or the site went) says nothing.
			if (closed) return void this.#refresh();
			busy = false;
			for (const control of controls) control.disabled = false;
			pressed.textContent = words;
			problem.textContent = changeError(failure, phrase("The password could not be changed. Try again."));
			input.focus();
			// The site may be gone (taken offline elsewhere): the read drops it, and the question with it.
			void this.#refresh();
		};
		const form = h(
			"form",
			{
				class: "modal sites-question",
				role: "dialog",
				"aria-modal": "true",
				"aria-labelledby": title,
				onsubmit: (event: SubmitEvent) => {
					event.preventDefault();
					void submit(input.value);
				},
			},
			h("h2", { id: title }, t("New password for {name}", { name })),
			h("p", null, t("Every visitor enters the new password; the old one stops working at once.")),
			input,
			problem,
			random,
			h("div", { class: "modal-actions" }, cancel, save),
		);
		const backdrop = h(
			"div",
			{ class: "modal-backdrop", onclick: (event: MouseEvent) => event.target === backdrop && !busy && close() },
			form,
		);
		backdrop.addEventListener("keydown", (event) => {
			if (event.key === "Escape" && !event.isComposing) {
				event.preventDefault();
				event.stopPropagation();
				if (!busy) close();
			}
			if (event.key !== "Tab") return;
			const fields = [...backdrop.querySelectorAll<HTMLElement>("input:not(:disabled), button:not(:disabled)")];
			const first = fields[0];
			const last = fields[fields.length - 1];
			if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
				event.preventDefault();
				(event.shiftKey ? last : first)?.focus();
			}
		});
		this.#asking = { site: site.id, close: () => close() };
		document.body.append(backdrop);
		window.addEventListener("hashchange", onHash);
		input.focus();
	}

	async #unpublish(site: CompanySite): Promise<void> {
		// A site Qorpera took down stays until Qorpera restores it: a menu still open as the read said so does nothing.
		if (this.#working || this.#lifetime.signal.aborted || this.#takenDown.has(site.id)) return;
		const name = nameOf(site);
		const more = `site-more:${site.id}`;
		const moment = this.#moment(site.id);
		// The question counts as open over the page while it is asked: no late draw moves the focus behind it.
		const asking = { site: site.id, close: () => {} };
		this.#asking ??= asking;
		const yes = await confirmDialog(
			site.kind === "app"
				? t(
						"Take {name} offline? Its link stops working and its password is deleted. The app keeps running on its machine.",
						{ name },
					)
				: fromCode(site)
					? t(
							"Take {name} offline? Its earlier versions go with it. The newest one waits in What's new, with a new password, until you put it live.",
							{ name },
						)
					: t(
							"Take {name} offline? Its link stops working and its password is deleted. The files stay in the Company File.",
							{ name },
						),
			t("Take offline"),
			true,
			undefined,
			this.#lifetime.signal,
		);
		if (this.#asking === asking) this.#asking = undefined;
		// No; or while the question was open the site went (taken offline elsewhere), Qorpera took it down (the kernel
		// refuses it then), the member's authority went, or the page was left.
		if (
			!yes ||
			this.#working ||
			!this.#still(moment, false) ||
			!this.#access.canManage() ||
			this.#takenDown.has(site.id)
		)
			return;
		const working = { site: site.id, action: "unpublish" } as const;
		this.#working = working;
		this.#draw(more);
		let failure: unknown;
		let done = false;
		try {
			await this.#client.unpublish(site.id, this.#lifetime.signal);
			done = true;
		} catch (error) {
			failure = error;
		}
		if (this.#working === working) this.#working = undefined;
		if (this.#lifetime.signal.aborted) return;
		if (!done) {
			this.#draw(more);
			if (this.#still(moment, false))
				this.#say(changeError(failure, phrase("The site could not be taken offline. Try again.")));
			// Taken offline elsewhere meanwhile: the read after the failure drops it.
			await this.#refresh(more);
			return;
		}
		this.#forget(site.id);
		if (this.#byHand?.key === `link:${site.id}`) this.#byHand = undefined;
		// The focus goes to the next site's menu, else the one before, as the row leaves (a site Qorpera took down has none).
		const list = (this.#sites ?? []).filter((item) => item.id === site.id || !this.#takenDown.has(item.id));
		const at = list.findIndex((item) => item.id === site.id);
		const neighbour = list[at + 1] ?? list[at - 1];
		const focusKey = neighbour ? `site-more:${neighbour.id}` : undefined;
		this.#leaving = site.id;
		this.#draw(focusKey);
		this.#say(t("{name} is offline.", { name }));
		const gone = () => {
			if (this.#lifetime.signal.aborted) return;
			if (this.#leaving === site.id) this.#leaving = undefined;
			// It leaves the list at once; the read after it confirms it.
			this.#sites = this.#sites?.filter((item) => item.id !== site.id);
			this.#listed(this.#sites ?? []);
			this.#draw(focusKey);
		};
		const row = this.el.querySelector<HTMLElement>(`[data-site="${site.id}"]`);
		if (row) leave(row, "is-leaving", gone);
		else gone();
		await this.#refresh(focusKey);
	}

	/** A site's link and, for an owner or admin, its password, each a pill. */
	#share(site: CompanySite, manage: boolean, busy: boolean): HTMLElement {
		const shown = this.#passwords.get(site.id);
		return sitePills(site, {
			manage,
			busy,
			reading: this.#working?.site === site.id && this.#working.action !== "unpublish",
			password: shown?.password,
			byHandLink: this.#byHand?.key === `link:${site.id}` ? this.#byHand.text : undefined,
			byHandPassword: this.#byHand?.key === `password:${site.id}` ? this.#byHand.text : undefined,
			copyLink: () => void this.#copyLink(site),
			copyPassword: () => void this.#copyPassword(site),
			eye: () => (shown ? this.#hidePassword(site) : void this.#showPassword(site)),
		});
	}

	#row(site: CompanySite, manage: boolean, index: number): HTMLElement {
		const busy = Boolean(this.#working);
		const name = nameOf(site);
		// Taken down by Qorpera: one sentence in place of the link and the password, and no menu (nothing in it would be
		// done until Qorpera restores the site).
		const down = this.#takenDown.get(site.id);
		let more: HTMLElement | null = null;
		if (manage && !down) {
			const menu = h(
				"button",
				{
					type: "button",
					class: "site-more",
					title: t("More options for {name}", { name }),
					"aria-label": t("More options for {name}", { name }),
					"aria-haspopup": "menu",
					"aria-expanded": "false",
					disabled: busy,
				},
				icon("more"),
			);
			menu.dataset.focusKey = `site-more:${site.id}`;
			// A press on "⋯" while its menu is open only shuts the menu: the menu says which press shut it, and the click
			// that press ends in opens nothing. A click from the keyboard has no press before it.
			let shuts = false;
			menu.addEventListener("pointerdown", (event) => {
				shuts = this.#menuShut?.site === site.id && this.#menuShut.press === event;
			});
			menu.addEventListener("click", (event) => {
				const shut = shuts && event.detail > 0;
				shuts = false;
				this.#menuShut = undefined;
				if (!shut && !this.#working) this.#openMenu(site, menu);
			});
			more = menu;
		}
		// A site made from code: the version What's new has live, and the way there.
		const releases = this.#releases;
		const version = releases && fromCode(site) ? releases.version(site) : undefined;
		const from =
			releases && fromCode(site)
				? h(
						"span",
						{ class: "site-from" },
						version === undefined ? null : `${t("Version {version}", { version: String(version) })} · `,
						h("a", { href: releases.href }, t("What's new")),
					)
				: null;
		// Only a row new on the page moves in, one after another.
		const first = !this.#seen.has(site.id);
		this.#seen.add(site.id);
		const row = siteRow(site, down, {
			head: from,
			more,
			share: () => this.#share(site, manage, busy),
			classes: [first && "is-new", this.#leaving === site.id && "is-leaving"],
		});
		if (first) row.style.setProperty("--i", String(index));
		return row;
	}

	#empty(): HTMLElement {
		this.#mascotEl ??= this.#mascot?.() ?? null;
		return h(
			"div",
			{ class: "sites-empty" },
			this.#mascotEl,
			h("h2", null, t("No sites yet")),
			h("p", null, t("Ask an agent for a website and it shows up here.")),
		);
	}

	#draw(focusKey?: string): void {
		if (this.#lifetime.signal.aborted) return;
		const manage = this.#access.canManage();
		this.#drawn = { manage, versions: this.#versions() };
		const active = document.activeElement as HTMLElement | null;
		const key = focusKey ?? (this.el.contains(active) ? active?.dataset.focusKey : undefined);
		// Taken before the page is drawn again, while the focus is still where the member left it.
		const free = this.#mayFocus();
		let error: HTMLElement | null = null;
		if (this.#error) {
			const retry = h(
				"button",
				{
					type: "button",
					class: "site-button",
					onclick: () => {
						this.#loading = true;
						this.#error = undefined;
						this.#draw();
						void this.#refresh();
					},
				},
				t("Try again"),
			);
			retry.dataset.focusKey = "site-retry";
			error = h("p", { class: "sites-error", role: "alert" }, h("span", null, this.#error), retry);
		}
		const sites = this.#sites ?? [];
		replace(
			this.#scroll,
			h(
				"div",
				{ class: "sites-column" },
				h(
					"header",
					{ class: "sites-head" },
					h("h1", null, t("Sites")),
					sites.length
						? h("p", null, manage ? t("Share a site with its link and password.") : t(MANAGERS_ONLY))
						: null,
				),
				error,
				// Without a first read there is nothing to show but the way to try again.
				this.#loading && !sites.length ? listSkeleton(t("Checking…"), 2) : null,
				sites.length
					? h(
							"div",
							{ class: "site-rows", dataset: { sites: "list" } },
							...sites.map((site, index) => this.#row(site, manage, index)),
						)
					: this.#sites && !this.#loading
						? this.#empty()
						: null,
			),
		);
		if (key && free) {
			const target = this.#control(key);
			if (target && !target.matches(":disabled")) target.focus();
		}
	}
}
