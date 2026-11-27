import type { CloudMemberDataAnswer, CloudMemberDataQuestion } from "@qorpera/cloud-client/cloud-member-data";
import { APP_NUMBERS_DATABASE } from "@qorpera/cloud-client/interface-apps";
import type { CompanySite, SiteMemberPass } from "../../cloud/sites.ts";
import { h, icon } from "../../ui/dom.ts";
import { presentationLocale, t } from "../../ui/preferences.ts";
import type { CompanyLiveSource } from "../interface-apps.ts";

/* One of the company's websites, live, with its numbers (company views step 4, slice V2; Jonas, 14 Nov 2026: "Yes,
 * platform draws it"; the bar is the sketch's screen 38, without its heat glows). One big window: the real site in a
 * frame, opened with a member's pass, so no password is asked; its address above it, Reload, and a link out to it in a
 * new tab. Beside it on a wide page, under it on a narrow one: how many people are on the site now, a quiet line with
 * today's visits, one curve of the last 24 hours, and the three pages seen most today, each of which moves the frame to
 * that page.
 *
 * - The pass (`qorpera_site_member_pass`, V1) is good once, for a minute, on the site's own host. The frame first loads
 *   the site door (public/site-door/), a page of this app's own that holds a frame of its own; the view hands it the
 *   pass by postMessage, and the door posts it to `https://<host>/__qorpera/member` into the frame it holds, never in
 *   an address; site-serve opens the site's own session in that frame and answers with the page. The door is a page of its own because the site's host takes a
 *   pass only with this app's exact Origin, and this app sends no referrer, under which a form of its own would say
 *   `Origin: null`; the door alone sends its origin. A fresh pass is asked on open, on Reload and for each page picked.
 * - The door holds the frame the site shows in: the app frames only its own pages, and only the door's policy frames
 *   the sites' hosts (public/_headers), so no other frame of the app (a Company File page, an interface app) can go to
 *   one. The door says when the site's page has loaded. The frames are sandboxed so neither can move this app's page.
 * - The numbers are the company's own (`qorpera/site-now`, `site-hours`, `site-pages`), watched through CompanyNumbers
 *   only while the view is open; each is asked again on its own clock. A number that can't be read is a quiet dash.
 * - Members never see how: no pass, host or step is named. */

/** What the view needs of the app. */
export interface SiteViewHost {
	/** The website as the company last read it; undefined once it is no live website of the company. */
	site(): CompanySite | undefined;
	/** A member's pass into the site (V1). */
	pass(site: CompanySite, signal: AbortSignal): Promise<SiteMemberPass>;
	/** The company's numbers, asked and watched as the member; absent where none can be asked. */
	readonly numbers?: CompanyLiveSource;
	/** The company's own time zone, whose day "today" is: the cloud counts days in it. */
	timeZone(): string | null | undefined;
	readonly siteAlone?: boolean;
}

/** The site door, beside index.html, and the words it and the view speak (public/site-door/door.js). */
export const SITE_DOOR_URL = "./site-door/";
export const SITE_DOOR_READY = "qorpera-site-door-ready";
export const SITE_DOOR_PASS = "qorpera-site-door";
export const SITE_DOOR_SHOWN = "qorpera-site-door-shown";

/** The numbers' zone while the company has none, the rule the cloud holds (20260930767000). */
const DEFAULT_ZONE = "Europe/Copenhagen";
/** The sandbox the site runs in: its own origin, scripts, forms and windows of its own; never this app's page. */
const SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox";
/** The hours the curve draws. */
const HOURS = 24;
/** The pages listed. */
const PAGES = 3;
const DASH = "–";

/** One page of the site as the counts name it (a file of its live version) and as its address has it. */
export interface SitePage {
	readonly path: string;
	readonly views: number;
}

/** What the view shows of the numbers: undefined where they can't be read (yet). */
interface Numbers {
	now?: { here: number; visits: number };
	hours?: number[];
	pages?: SitePage[];
}

/** A count in an answer: a whole number from 0 (a bigint may come as text). */
function count(value: unknown): number | undefined {
	const number = typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
	return typeof number === "number" && Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

/** The answer's rows of the site `slug`, each as a record by column; undefined when the answer has not the columns. */
function rowsOf(
	answer: CloudMemberDataAnswer,
	slug: string,
	columns: readonly string[],
): Record<string, unknown>[] | undefined {
	if (!["site", ...columns].every((column) => answer.columns.includes(column))) return undefined;
	return answer.rows
		.map((row) => Object.fromEntries(answer.columns.map((column, index) => [column, row[index]])))
		.filter((row) => row.site === slug);
}

/** `site-now`: who is here now and today's visits. */
export function readNow(answer: CloudMemberDataAnswer, slug: string): Numbers["now"] {
	const row = rowsOf(answer, slug, ["here_now", "visits_today"])?.[0];
	const here = count(row?.here_now);
	const visits = count(row?.visits_today);
	return here === undefined || visits === undefined ? undefined : { here, visits };
}

/** `site-hours`: the visits of the last 24 hours, oldest first, this hour last. */
export function readHours(answer: CloudMemberDataAnswer, slug: string): number[] | undefined {
	const rows = rowsOf(answer, slug, ["hour", "visits"]);
	if (!rows?.length) return undefined;
	const visits = rows
		.sort((a, b) => String(a.hour).localeCompare(String(b.hour)))
		.slice(-HOURS)
		.map((row) => count(row.visits));
	return visits.every((value) => value !== undefined) ? (visits as number[]) : undefined;
}

/** `site-pages`: the pages seen most, most seen first. */
export function readPages(answer: CloudMemberDataAnswer, slug: string): SitePage[] | undefined {
	const rows = rowsOf(answer, slug, ["path", "views"]);
	if (!rows) return undefined;
	const pages: SitePage[] = [];
	for (const row of rows) {
		const views = count(row.views);
		if (typeof row.path !== "string" || views === undefined || views === 0) continue;
		pages.push({ path: row.path, views });
	}
	return pages.sort((a, b) => b.views - a.views).slice(0, PAGES);
}

/** A page's address on the site, from the file the counts name: `index.html` is `/`, `shop/index.html` is `/shop/`,
 * any other file its own path. Undefined for a name that is no plain path. */
export function pageAddress(path: string): string | undefined {
	if (!/^[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,512}$/.test(path) || path.startsWith("/") || path.split("/").includes(".."))
		return undefined;
	if (path === "index.html") return "/";
	if (path.endsWith("/index.html")) return `/${path.slice(0, -"index.html".length)}`;
	return `/${path}`;
}

/** A path segment as a member reads it: percent-decoded, without a .html or .htm ending, dashes and underscores as
 * spaces, its first letter a capital. */
function readableSegment(segment: string): string {
	let text = segment;
	try {
		text = decodeURIComponent(segment);
	} catch {
		/* A broken escape stays as it is. */
	}
	text = text
		.replace(/\.html?$/i, "")
		.replace(/[-_]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!text) return segment;
	return text.charAt(0).toLocaleUpperCase(presentationLocale()) + text.slice(1);
}

/** The names the top pages show, by their addresses on the site: the front page as `front`, any other by its last
 * segment made readable ("/lampen/" "Lampen", "/saadan-virker-den.html" "Saadan virker den"); two that would read the
 * same each take their parent's name before theirs ("Om os · Kontakt"). Never a path: members see no technical text. */
export function pageNames(addresses: readonly string[], front: string): string[] {
	const parts = addresses.map((address) => address.split("/").filter(Boolean));
	const names = parts.map((segments) => (segments.length ? readableSegment(segments.at(-1)!) : front));
	const count = new Map<string, number>();
	for (const name of names) count.set(name, (count.get(name) ?? 0) + 1);
	return names.map((name, index) => {
		const segments = parts[index]!;
		return (count.get(name) ?? 0) > 1 && segments.length > 1
			? `${readableSegment(segments.at(-2)!)} · ${name}`
			: name;
	});
}

/** The company's day today, YYYY-MM-DD in its zone (its own, or the cloud's default when it has none or an unknown one). */
export function companyToday(zone: string | null | undefined, now = new Date()): string {
	const format = (timeZone: string) =>
		new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
	try {
		return format(zone || DEFAULT_ZONE);
	} catch {
		return format(DEFAULT_ZONE);
	}
}

/** The site's address as a member reads it: its host, and its path where it has one (an old link). */
export function shownAddress(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "")}`;
	} catch {
		return url;
	}
}

let frames = 0;

export class SiteView {
	readonly el: HTMLElement;
	readonly #host: SiteViewHost;
	readonly #slug: string;
	readonly #lifetime = new AbortController();
	readonly #frame: HTMLIFrameElement;
	readonly #glass: HTMLElement;
	readonly #cover: HTMLElement;
	readonly #address: HTMLElement;
	readonly #out: HTMLAnchorElement;
	readonly #title: HTMLElement;
	readonly #reload: HTMLButtonElement;
	readonly #nowNumber: HTMLElement;
	readonly #nowLabel: HTMLElement;
	readonly #today: HTMLElement;
	readonly #curve: SVGSVGElement;
	readonly #pages: HTMLElement;
	readonly #numbers: Numbers = {};
	/** The open in flight: a newer one ends it. */
	#opening: AbortController | undefined;
	/** A page has shown in the frame since the view opened. */
	#shown = false;
	/** The door is opening in the frame to post this pass, at this path of the site. */
	#pending: { action: string; pass: string; path: string | undefined } | undefined;
	/** The door was handed a pass: its word that the site's page loaded shows the site. */
	#awaiting = false;
	#parked = false;
	#doorWindow: Window | null = null;
	/** The day today's pages are watched for, and their watch (undefined while it is not running). */
	#pagesDay: string | undefined;
	#pagesWatch: number | undefined;
	/** The questions watched or being asked now, by name: one that failed is asked again on the minute. */
	readonly #following = new Set<string>();
	#drawnSite: string | undefined;
	/** The site was no live website of the company at the last update. */
	#gone = false;

	constructor(host: SiteViewHost, slug: string, signal: AbortSignal) {
		this.#host = host;
		this.#slug = slug;
		signal.addEventListener("abort", () => this.dispose(), { once: true, signal: this.#lifetime.signal });
		const name = `qorpera-site-${++frames}`;
		this.#frame = h("iframe", {
			class: "site-frame",
			name,
			sandbox: SANDBOX,
			referrerpolicy: "no-referrer",
			title: slug,
		});
		// The door in the frame says it is ready, and that the site's page loaded. Ready, it is handed the pass it opened
		// for, once, and only to this app's origin.
		window.addEventListener(
			"message",
			(event) => {
				const door = this.#frame.contentWindow;
				const data = event.data as { type?: unknown } | null;
				if (!door || event.source !== door || event.origin !== location.origin) return;
				if (data?.type === SITE_DOOR_SHOWN) {
					if (!this.#awaiting) return;
					this.#shown = true;
					this.#glass.classList.add("is-shown");
					this.#glass.classList.remove("is-opening");
					return;
				}
				if (data?.type !== SITE_DOOR_READY) return;
				const pending = this.#pending;
				this.#pending = undefined;
				if (!pending) {
					if (this.#doorWindow !== null && door !== this.#doorWindow && !this.#parked) {
						this.#doorWindow = null;
						this.#shown = false;
						this.#awaiting = false;
						this.#glass.classList.remove("is-shown");
						this.#glass.classList.add("is-opening");
						this.#open();
					}
					return;
				}
				this.#doorWindow = door;
				this.#awaiting = true;
				door.postMessage(
					{
						type: SITE_DOOR_PASS,
						action: pending.action,
						pass: pending.pass,
						title: this.#frame.title,
						...(pending.path ? { path: pending.path } : {}),
					},
					location.origin,
				);
			},
			{ signal: this.#lifetime.signal },
		);
		this.#cover = h(
			"div",
			{ class: "site-cover", hidden: true },
			h("p", { class: "site-cover-words" }),
			h("a", { class: "site-cover-link", target: "_blank", rel: "noopener noreferrer" }, t("Open it in a new tab")),
		);
		this.#glass = h("div", { class: "site-glass is-opening" }, this.#frame, this.#cover);
		this.#address = h("span", { class: "site-address" });
		this.#reload = h(
			"button",
			{
				type: "button",
				class: "site-tool",
				"aria-label": t("Reload"),
				title: t("Reload"),
				onclick: () => this.#open(),
			},
			icon("reload"),
		);
		this.#out = h(
			"a",
			{
				class: "site-tool",
				target: "_blank",
				rel: "noopener noreferrer",
				"aria-label": t("Open in a new tab"),
				title: t("Open in a new tab"),
			},
			icon("external"),
		);
		this.#title = h("h1", { class: "visually-hidden" });
		this.#nowNumber = h("span", { class: "site-now-number" }, DASH);
		this.#nowLabel = h("span", { class: "site-now-label" }, t("people here now"));
		this.#today = h("p", { class: "site-today" });
		this.#curve = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		this.#curve.setAttribute("class", "site-curve");
		this.#curve.setAttribute("viewBox", "0 0 240 72");
		this.#curve.setAttribute("preserveAspectRatio", "none");
		this.#curve.setAttribute("role", "img");
		this.#pages = h("ol", { class: "site-pages" });
		this.el = host.siteAlone
			? h("div", { class: "site-view is-alone" }, this.#title, h("div", { class: "site-window" }, this.#glass))
			: h(
					"div",
					{ class: "site-view" },
					this.#title,
					h(
						"div",
						{ class: "site-window" },
						h(
							"div",
							{ class: "site-bar" },
							this.#address,
							h("span", { class: "site-tools" }, this.#reload, this.#out),
						),
						this.#glass,
					),
					h(
						"div",
						{ class: "site-side" },
						h(
							"p",
							{ class: "site-now" },
							h("span", { class: "site-live", "aria-hidden": "true" }),
							this.#nowNumber,
							this.#nowLabel,
						),
						this.#today,
						h("figure", { class: "site-day" }, this.#curve, h("figcaption", null, t("Last 24 hours"))),
						this.#pages,
					),
				);
		this.update();
		this.#drawNumbers();
		this.#watch();
		this.#open();
	}

	/** The company's sites were read again: the site's name and link follow; one no longer live shows so. */
	update(): void {
		const site = this.#host.site();
		const drawn = JSON.stringify(site ? [site.title, site.url] : null);
		if (drawn === this.#drawnSite) return;
		this.#drawnSite = drawn;
		if (!site) {
			this.#opening?.abort();
			this.#pending = undefined;
			this.#gone = true;
			this.#showCover(t("This website isn't live any more."), undefined);
			this.#reload.disabled = true;
			this.#out.removeAttribute("href");
			this.#out.hidden = true;
			return;
		}
		const name = site.title ?? site.slug;
		this.#title.textContent = name;
		this.#frame.title = name;
		this.#address.textContent = shownAddress(site.url);
		this.#out.href = site.url;
		this.#out.hidden = false;
		this.#reload.disabled = false;
		this.#cover.querySelector<HTMLAnchorElement>(".site-cover-link")!.href = site.url;
		// Live again (put back up after it was taken down): it opens anew.
		if (this.#gone) {
			this.#gone = false;
			this.#shown = false;
			this.#glass.classList.remove("is-shown");
			this.#open();
		}
	}

	park(): void {
		if (this.#lifetime.signal.aborted || this.#parked) return;
		this.#parked = true;
		this.#opening?.abort();
		this.#opening = undefined;
		this.#pending = undefined;
		this.#awaiting = false;
		this.#shown = false;
		this.#doorWindow = null;
		this.#glass.classList.remove("is-shown", "is-opening");
		this.#frame.removeAttribute("src");
	}

	activate(): void {
		if (this.#lifetime.signal.aborted || !this.#parked) return;
		this.#parked = false;
		if (!this.#gone) this.#open();
	}

	dispose(): void {
		this.#opening?.abort();
		this.#pending = undefined;
		this.#doorWindow = null;
		this.#parked = false;
		this.#lifetime.abort();
	}

	reload(): void {
		this.#open();
	}

	/** Opens the site in the frame with a fresh pass, at `to` (a path of the site) or at its start. */
	#open(to?: string): void {
		const site = this.#host.site();
		if (!site || this.#lifetime.signal.aborted || this.#parked) return;
		this.#opening?.abort();
		const opening = new AbortController();
		this.#opening = opening;
		if (!this.#shown) this.#glass.classList.add("is-opening");
		const without = (state: Exclude<SiteMemberPass["state"], "open"> | "failed") => {
			// Taken down or not live: said so, whatever showed before.
			if (state === "gone" || state === "none") {
				this.#showCover(
					state === "gone" ? t("This website was taken offline.") : t("This website isn't live yet."),
					undefined,
				);
				return;
			}
			// Shown once already: the page stays as it is, for Reload and a page picked alike. The app can't move the frame
			// to the site itself (it frames only its own pages), and a word over the page would hide it for a moment's wait.
			if (this.#shown) return;
			this.#showCover(
				state === "limited" ? t("Try again in a moment.") : t("This website can't be shown here right now."),
				site.url,
			);
		};
		this.#host.pass(site, opening.signal).then(
			(pass) => {
				if (opening.signal.aborted || this.#lifetime.signal.aborted) return;
				if (pass.state !== "open") {
					without(pass.state);
					return;
				}
				this.#enter(pass.action, pass.pass, to);
			},
			() => {
				if (opening.signal.aborted || this.#lifetime.signal.aborted) return;
				without("failed");
			},
		);
	}

	/** Opens the door in the frame, which posts the pass once it is ready (the message listener above). */
	#enter(action: string, pass: string, path: string | undefined): void {
		this.#cover.hidden = true;
		this.#glass.classList.remove("is-covered");
		this.#pending = { action, pass, path };
		this.#awaiting = false;
		this.#doorWindow = null;
		this.#frame.src = SITE_DOOR_URL;
	}

	#showCover(words: string, url: string | undefined): void {
		this.#cover.querySelector(".site-cover-words")!.textContent = words;
		const link = this.#cover.querySelector<HTMLAnchorElement>(".site-cover-link")!;
		link.hidden = !url;
		if (url) link.href = url;
		this.#cover.hidden = false;
		this.#glass.classList.add("is-covered");
		this.#glass.classList.remove("is-opening");
	}

	/* ---- the numbers ---------------------------------------------------------------------------------------------- */

	#asked(question: string, params: CloudMemberDataQuestion["params"] = {}): CloudMemberDataQuestion {
		return { database: APP_NUMBERS_DATABASE, question, params: { site: this.#slug, ...params } };
	}

	/** Watches the site's numbers while the view is open; each that can't be read stays a dash. */
	#watch(): void {
		const numbers = this.#host.numbers;
		if (!numbers) return;
		const page = this.#lifetime.signal;
		this.#follow("site-now", (answer) => {
			this.#numbers.now = readNow(answer, this.#slug);
			this.#drawNumbers();
		});
		this.#follow("site-hours", (answer) => {
			this.#numbers.hours = readHours(answer, this.#slug);
			this.#drawNumbers();
		});
		this.#watchPages();
		// WHY: Skip background retries while hidden and catch up immediately when the tab returns.
		const tick = () => {
			if (typeof document !== "undefined" && document.hidden) return;
			this.#follow("site-now");
			this.#follow("site-hours");
			this.#watchPages();
		};
		const minute = setInterval(tick, 60_000);
		if (typeof document !== "undefined") document.addEventListener("visibilitychange", tick, { signal: page });
		page.addEventListener("abort", () => clearInterval(minute), { once: true });
	}

	/** What each followed question does with an answer. */
	readonly #readers = new Map<string, (answer: CloudMemberDataAnswer) => void>();

	/** Watches one of the site's questions, unless it is watched or being asked already. A first ask that fails leaves
	 * it to the minute. */
	#follow(question: string, read?: (answer: CloudMemberDataAnswer) => void): void {
		const numbers = this.#host.numbers;
		if (read) this.#readers.set(question, read);
		const reader = this.#readers.get(question);
		if (!numbers || !reader || this.#following.has(question) || this.#lifetime.signal.aborted) return;
		this.#following.add(question);
		numbers
			.watch(this.#lifetime.signal, this.#asked(question), (_watch, answer) => reader(answer))
			.then(
				(started) => reader(started.answer),
				() => this.#following.delete(question),
			);
	}

	/** Today's pages, watched for the company's day today; asked anew when the day turns. */
	#watchPages(): void {
		const numbers = this.#host.numbers;
		if (!numbers || this.#lifetime.signal.aborted) return;
		const today = companyToday(this.#host.timeZone());
		// Watched for today, or being asked for it: nothing to do. A first ask that failed left no day.
		if (today === this.#pagesDay) return;
		this.#pagesDay = today;
		if (this.#pagesWatch !== undefined) numbers.unwatch(this.#lifetime.signal, this.#pagesWatch);
		this.#pagesWatch = undefined;
		const read = (answer: CloudMemberDataAnswer) => {
			if (this.#pagesDay !== today) return;
			this.#numbers.pages = readPages(answer, this.#slug);
			this.#drawNumbers();
		};
		numbers
			.watch(
				this.#lifetime.signal,
				this.#asked("site-pages", { from: today, to: today, limit: PAGES }),
				(_w, answer) => read(answer),
			)
			.then(
				(started) => {
					if (this.#pagesDay !== today) {
						numbers.unwatch(this.#lifetime.signal, started.watch);
						return;
					}
					this.#pagesWatch = started.watch;
					read(started.answer);
				},
				() => {
					if (this.#pagesDay === today) this.#pagesDay = undefined;
				},
			);
	}

	#drawNumbers(): void {
		const format = new Intl.NumberFormat(presentationLocale());
		const now = this.#numbers.now;
		this.#nowNumber.textContent = now ? format.format(now.here) : DASH;
		this.#nowLabel.textContent = now?.here === 1 ? t("person here now") : t("people here now");
		this.el.classList.toggle("has-people", (now?.here ?? 0) > 0);
		this.el.classList.toggle("is-unknown", !now);
		this.#today.textContent = !now
			? t("{count} visits today", { count: DASH })
			: now.visits === 0
				? t("No visits yet today")
				: now.visits === 1
					? t("1 visit today")
					: t("{count} visits today", { count: format.format(now.visits) });
		this.#drawCurve(this.#numbers.hours);
		this.#drawPages(this.#numbers.pages);
	}

	/** One line over the last 24 hours, its area a soft field under it; a dashed line where they can't be read. */
	#drawCurve(hours: number[] | undefined): void {
		const ns = "http://www.w3.org/2000/svg";
		const width = 240;
		const height = 72;
		const top = 6;
		const line = document.createElementNS(ns, "path");
		this.#curve.setAttribute(
			"aria-label",
			hours ? t("Visits, last 24 hours: {count}", { count: hours.reduce((a, b) => a + b, 0) }) : t("Last 24 hours"),
		);
		this.#curve.classList.toggle("is-unknown", !hours);
		if (!hours) {
			line.setAttribute("d", `M0 ${height - 1}H${width}`);
			line.setAttribute("class", "site-curve-line");
			this.#curve.replaceChildren(line);
			return;
		}
		const most = Math.max(1, ...hours);
		const step = hours.length > 1 ? width / (hours.length - 1) : width;
		const points = hours.map((value, index): [number, number] => [
			index * step,
			height - 1 - (value / most) * (height - 1 - top),
		]);
		// A smooth line: each point joined to the next by a curve whose handles stand level, halfway between them.
		const [first] = points;
		if (!first) return;
		let d = `M${first[0].toFixed(1)} ${first[1].toFixed(1)}`;
		for (let index = 1; index < points.length; index++) {
			const [x0, y0] = points[index - 1]!;
			const [x1, y1] = points[index]!;
			const mid = (x0 + x1) / 2;
			d += ` C${mid.toFixed(1)} ${y0.toFixed(1)} ${mid.toFixed(1)} ${y1.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
		}
		if (points.length === 1) d += `H${width}`;
		const area = document.createElementNS(ns, "path");
		area.setAttribute("d", `${d} L${width} ${height} L0 ${height} Z`);
		area.setAttribute("class", "site-curve-area");
		line.setAttribute("d", d);
		line.setAttribute("class", "site-curve-line");
		this.#curve.replaceChildren(area, line);
	}

	/** The pages seen most today, each a soft bar as long as its share, which opens that page in the frame. */
	#drawPages(pages: SitePage[] | undefined): void {
		const shown = (pages ?? []).flatMap((page) => {
			const address = pageAddress(page.path);
			return address ? [{ ...page, address }] : [];
		});
		const most = Math.max(1, ...shown.map((page) => page.views));
		const format = new Intl.NumberFormat(presentationLocale());
		const names = pageNames(
			shown.map((page) => page.address),
			t("Front page"),
		);
		this.#pages.hidden = shown.length === 0;
		this.#pages.replaceChildren(
			...shown.map((page, index) => {
				const name = names[index]!;
				// The page's address is where a press goes, and its tooltip; never its text.
				const item = h(
					"button",
					{
						type: "button",
						class: "site-top",
						title: page.address,
						onclick: () => this.#open(page.address),
					},
					h("span", { class: "site-top-name" }, name),
					h("span", { class: "site-top-count" }, format.format(page.views)),
				);
				item.style.setProperty("--share", (page.views / most).toFixed(3));
				return h("li", null, item);
			}),
		);
	}
}
