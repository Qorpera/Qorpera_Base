import { h, icon, replace } from "../../ui/dom.ts";
import { interfaceEmblem } from "../../ui/interface-emblem.ts";
import { t } from "../../ui/preferences.ts";
import { forgetPictureUrl, pictureUrl } from "../folder-images.ts";
import { type CompanyApp, companyConcepts } from "../interface-apps.ts";
import { conceptsHash } from "../router.ts";
import { AppPanel, type AppPanelHost } from "./app-panel.ts";

/* The Concepts viewer, `#/c/{id}/concepts[/{name}]` (Jonas, 8 November 2026: "a fullscreen view of the selected
 * concept, with a sidepanel for the different ideas/designs you could select to view"). The first thing a company shows
 * its founders is its concepts: the product they described, as the finished product, in several ideas or designs to
 * compare. Each is an interface app with `concept = true` in its app.toml.
 * - Full screen: Qorpera's own rail is away on this route (app/application.ts). The selected concept's frame fills all
 *   but a slim side panel in Qorpera's light look, with no header over it (AppPanel's "concept" placement).
 * - The side panel has the way back to the company, the concepts (cover or emblem, title, `about`, who made it) and,
 *   for the open one, Reload and Show in Storage.
 * - Whose the open concept is and that Qorpera never asks for passwords in it stand in a strip of the side panel that
 *   never folds away: under the list, along the folded strip, and under the phone's top bar (security review r1, H2,
 *   and #1539 round 1: a page that draws a sign-in can't pass for Qorpera's own).
 * - A cover is read by its file's version: a cover made or replaced shows once the folder says it changed, and a read
 *   that failed is tried again then.
 * - An item is a link to its concept's route: pressing it switches the concept in place, the panel as it is.
 * - The panel folds to a thin strip (kept per viewer in this browser); at phone width it is a top bar with a menu. */

/** Changes in the folder look at the covers again at most this often. */
const CHANGE_MS = 1500;

/** Whether the panel is folded, kept for the viewer in this browser. */
const COLLAPSED_KEY = "qorpera.web.concepts-collapsed";

function storedCollapsed(): boolean {
	try {
		return localStorage.getItem(COLLAPSED_KEY) === "1";
	} catch {
		return false;
	}
}

function storeCollapsed(collapsed: boolean): void {
	try {
		localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
	} catch {
		/* The choice lasts this view. */
	}
}

/** What the viewer needs from the open company. */
export interface ConceptsHost {
	/** What a concept's frame reads with, as an app's page reads. */
	readonly panel: AppPanelHost;
	readonly profileId: string;
	readonly companyName: () => string;
	/** Where the way back leads: the company's last open conversation, or its home. */
	readonly back: () => string;
	/** A picture of the company's folder, for a cover: null when it is none, or too large. */
	readonly picture: (path: string, signal: AbortSignal) => Promise<Blob | null>;
}

type Concept = ReturnType<typeof companyConcepts>[number];

/** A cover as shown: the version of its file that was read, and its picture's URL (null: the emblem shows). */
interface Cover {
	readonly version: string | null;
	readonly url: string | null;
}

/** A concept's cover's path in the company's folder, or null for none. */
const coverPath = (concept: Concept) => (concept.manifest.cover ? `${concept.path}/${concept.manifest.cover}` : null);

export class ConceptsView {
	readonly el: HTMLElement;
	readonly #host: ConceptsHost;
	readonly #lifetime = new AbortController();
	readonly #back: HTMLAnchorElement;
	readonly #backName = h("span", { class: "concepts-back-name" });
	readonly #current = h("span", { class: "concepts-current" });
	readonly #collapse: HTMLButtonElement;
	readonly #menu: HTMLButtonElement;
	readonly #list = h("ul", { class: "concepts-list" });
	readonly #foot = h("div", { class: "concepts-foot" });
	/** Whose the open concept is, and that Qorpera never asks for passwords in it: never folded away. */
	readonly #guard = h("p", { class: "concepts-guard" });
	readonly #stage = h("div", { class: "concepts-stage" });
	/** The concepts as last read. */
	#apps: readonly CompanyApp[] = [];
	/** The company's apps have been read once, so an empty list means none. */
	#read = false;
	/** The name in the route, or undefined for the most recently changed concept. */
	#asked: string | undefined;
	#panel: AppPanel | undefined;
	#shownList = "";
	#collapsed = storedCollapsed();
	#menuOpen = false;
	/** Each cover by its path, as last read. */
	readonly #covers = new Map<string, Cover>();
	/** The covers being read, and those to read again when that read ends. */
	readonly #coverReads = new Set<string>();
	readonly #coverAgain = new Set<string>();
	#timer: ReturnType<typeof setTimeout> | undefined;

	constructor(host: ConceptsHost, apps: readonly CompanyApp[], name: string | undefined) {
		this.#host = host;
		this.#apps = apps;
		this.#asked = name;
		this.#back = h("a", { class: "concepts-back", href: host.back() }, icon("back"), this.#backName);
		this.#collapse = h(
			"button",
			{
				type: "button",
				class: "concepts-button concepts-collapse",
				"aria-controls": "concepts-panel",
				onclick: () => this.#setCollapsed(!this.#collapsed),
			},
			icon("navigation"),
		);
		this.#menu = h(
			"button",
			{
				type: "button",
				class: "concepts-button concepts-menu",
				"aria-controls": "concepts-panel",
				onclick: () => this.#setMenuOpen(!this.#menuOpen),
			},
			icon("list"),
		);
		this.el = h(
			"section",
			{ class: "concepts" },
			h(
				"aside",
				{ class: "concepts-side", "aria-label": t("Concepts") },
				h("div", { class: "concepts-top" }, this.#back, this.#current, this.#collapse, this.#menu),
				h(
					"div",
					{ class: "concepts-panel", id: "concepts-panel" },
					h("h2", { class: "concepts-heading" }, t("Concepts")),
					h("nav", { "aria-label": t("Concepts") }, this.#list),
					this.#foot,
				),
				this.#guard,
			),
			this.#stage,
		);
		this.el.addEventListener(
			"keydown",
			(event: KeyboardEvent) => {
				if (event.key !== "Escape" || !this.#menuOpen || event.defaultPrevented) return;
				event.preventDefault();
				this.#setMenuOpen(false);
				this.#menu.focus();
			},
			{ signal: this.#lifetime.signal },
		);
		// A press on an item at phone width shows its concept: the menu closes over it.
		this.#list.addEventListener("click", () => this.#setMenuOpen(false), { signal: this.#lifetime.signal });
		// A change in the folder may be a cover made, replaced or taken away: its file's version says so.
		this.#lifetime.signal.addEventListener(
			"abort",
			host.panel.onFolderChange(() => {
				if (this.#timer !== undefined) return;
				this.#timer = setTimeout(() => {
					this.#timer = undefined;
					this.#checkCovers();
				}, CHANGE_MS);
			}),
			{ once: true },
		);
		this.#draw();
		// The company's first read may still be on its way: until it is in, no concept is said to be missing.
		void host.panel.readApps(this.#lifetime.signal).then(
			(read) => {
				if (this.#lifetime.signal.aborted) return;
				this.#read = true;
				this.#apps = read;
				this.#draw();
			},
			() => {
				if (this.#lifetime.signal.aborted) return;
				this.#read = true;
				this.#draw();
			},
		);
	}

	/** The concept the route names now, or the most recently changed one. */
	get selected(): string | undefined {
		return this.#selected()?.name;
	}

	/** The company's apps as now read, and the concept the route names. The open concept stays as it is unless another
	 * is asked for, or it left. */
	update(apps: readonly CompanyApp[], name: string | undefined): void {
		this.#apps = apps;
		if (apps.length > 0) this.#read = true;
		this.#asked = name;
		this.#draw();
	}

	/** Reads the open concept again. */
	reload(): void {
		void this.#panel?.reload(true);
		this.#checkCovers();
	}

	focus(): void {
		const item = this.#list.querySelector<HTMLElement>("a[aria-current]");
		(this.#collapsed || !item ? this.#back : item).focus({ preventScroll: true });
	}

	dispose(): void {
		this.#lifetime.abort();
		clearTimeout(this.#timer);
		this.#panel?.dispose();
		this.#panel = undefined;
		for (const cover of this.#covers.values()) if (cover.url) forgetPictureUrl(cover.url);
		this.#covers.clear();
		this.el.remove();
	}

	#concepts(): Concept[] {
		return companyConcepts(this.#apps);
	}

	#selected(): Concept | undefined {
		const concepts = this.#concepts();
		return this.#asked === undefined ? concepts[0] : concepts.find((concept) => concept.name === this.#asked);
	}

	#setCollapsed(collapsed: boolean): void {
		this.#collapsed = collapsed;
		storeCollapsed(collapsed);
		this.#draw();
	}

	#setMenuOpen(open: boolean): void {
		if (this.#menuOpen === open) return;
		this.#menuOpen = open;
		this.#draw();
	}

	#draw(): void {
		const concepts = this.#concepts();
		const selected = this.#selected();
		const company = this.#host.companyName();
		const backLabel = t("Back to {name}", { name: company });
		const href = this.#host.back();
		if (this.#back.getAttribute("href") !== href) this.#back.setAttribute("href", href);
		if (this.#back.getAttribute("aria-label") !== backLabel) {
			this.#back.setAttribute("aria-label", backLabel);
			this.#back.title = backLabel;
		}
		if (this.#backName.textContent !== company) this.#backName.textContent = company;
		this.#current.textContent = selected?.manifest.name ?? "";
		this.el.classList.toggle("is-collapsed", this.#collapsed);
		this.el.classList.toggle("is-menu-open", this.#menuOpen);
		const collapseLabel = this.#collapsed ? t("Show the concepts") : t("Hide the concepts");
		this.#collapse.setAttribute("aria-label", collapseLabel);
		this.#collapse.title = collapseLabel;
		this.#collapse.setAttribute("aria-expanded", String(!this.#collapsed));
		this.#menu.setAttribute("aria-label", t("Concepts"));
		this.#menu.title = t("Concepts");
		this.#menu.setAttribute("aria-expanded", String(this.#menuOpen));
		this.#drawList(concepts, selected);
		this.#drawFoot(selected);
		this.#drawGuard(selected);
		this.#drawStage(concepts, selected);
	}

	#drawGuard(selected: Concept | undefined): void {
		this.#guard.hidden = !selected;
		const text = selected ? `${this.#made(selected)} · ${t("Qorpera never asks for passwords here")}` : "";
		if (this.#guard.textContent !== text) this.#guard.textContent = text;
	}

	#drawList(concepts: readonly Concept[], selected: Concept | undefined): void {
		const model = JSON.stringify(
			concepts.map((concept) => [
				concept.name,
				concept.version,
				concept.manifest.name,
				concept.manifest.about,
				concept.manifest.emblem,
				concept.manifest.cover,
				this.#made(concept),
			]),
		);
		if (model !== this.#shownList) {
			this.#shownList = model;
			replace(this.#list, ...concepts.map((concept) => h("li", null, this.#item(concept))));
			this.#checkCovers();
		}
		for (const item of this.#list.querySelectorAll<HTMLAnchorElement>("a.concepts-item")) {
			if (item.dataset.concept === selected?.name) item.setAttribute("aria-current", "page");
			else item.removeAttribute("aria-current");
		}
	}

	#made(concept: Concept): string {
		const owner = this.#host.panel.agentName(concept.manifest.owner);
		return owner ? t("Made by {name}", { name: owner }) : t("Made by an agent");
	}

	#item(concept: Concept): HTMLElement {
		const manifest = concept.manifest;
		const thumb = h("span", { class: "concepts-thumb", "aria-hidden": "true" });
		this.#paintThumb(thumb, concept);
		return h(
			"a",
			{
				class: "concepts-item",
				href: conceptsHash(this.#host.profileId, concept.name),
				draggable: "false",
				dataset: { concept: concept.name },
				title: manifest.about ? `${manifest.name} · ${manifest.about}` : manifest.name,
			},
			thumb,
			h(
				"span",
				{ class: "concepts-item-copy" },
				h("strong", { class: "concepts-item-title" }, manifest.name),
				manifest.about ? h("span", { class: "concepts-item-about" }, manifest.about) : null,
				h("small", { class: "concepts-item-by" }, this.#made(concept)),
			),
		);
	}

	/** A thumb shows its concept's cover as last read, or its emblem. */
	#paintThumb(thumb: HTMLElement, concept: Concept): void {
		const path = coverPath(concept);
		const url = path ? (this.#covers.get(path)?.url ?? null) : null;
		if (url) {
			if (thumb.querySelector("img")?.getAttribute("src") === url) return;
			thumb.classList.add("has-cover");
			replace(thumb, h("img", { src: url, alt: "", draggable: "false" }));
		} else if (thumb.classList.contains("has-cover") || !thumb.firstChild) {
			thumb.classList.remove("has-cover");
			replace(thumb, interfaceEmblem(concept.manifest.emblem, 28));
		}
	}

	#paintThumbs(): void {
		const concepts = this.#concepts();
		for (const item of this.#list.querySelectorAll<HTMLElement>("a.concepts-item")) {
			const concept = concepts.find((entry) => entry.name === item.dataset.concept);
			const thumb = item.querySelector<HTMLElement>(".concepts-thumb");
			if (concept && thumb) this.#paintThumb(thumb, concept);
		}
	}

	/** Looks at each concept's cover again: one that is new, changed, gone, or whose read failed is read now. */
	#checkCovers(): void {
		const paths = new Set(this.#concepts().flatMap((concept) => coverPath(concept) ?? []));
		for (const path of paths) this.#checkCover(path);
		// A cover no concept names any more lets its picture go.
		for (const [path, cover] of this.#covers)
			if (!paths.has(path)) {
				this.#covers.delete(path);
				if (cover.url) forgetPictureUrl(cover.url);
			}
	}

	#checkCover(path: string): void {
		if (this.#coverReads.has(path)) {
			this.#coverAgain.add(path);
			return;
		}
		const signal = this.#lifetime.signal;
		this.#coverReads.add(path);
		void (async () => {
			const entry = (await this.#host.panel.folder().read(path, signal)).entry;
			const version = entry?.kind === "file" ? entry.version : null;
			const known = this.#covers.get(path);
			// The picture shown is the file as it is now. A cover with no picture yet, or none that could be shown, is
			// read again.
			if (known?.url && known.version === version) return;
			const blob = version === null ? null : await this.#host.picture(path, signal);
			const url = blob ? await pictureUrl(blob) : null;
			if (signal.aborted) {
				if (url) forgetPictureUrl(url);
				return;
			}
			this.#covers.set(path, { version, url });
			this.#paintThumbs();
			if (known?.url) forgetPictureUrl(known.url);
		})()
			.catch(() => {
				/* What was shown stands; the next change in the folder tries again. */
			})
			.finally(() => {
				this.#coverReads.delete(path);
				if (this.#coverAgain.delete(path) && !signal.aborted) this.#checkCover(path);
			});
	}

	#drawFoot(selected: Concept | undefined): void {
		const shown = selected ? `${selected.name}\n${selected.path}` : "";
		if (this.#foot.dataset.shown === shown) return;
		this.#foot.dataset.shown = shown;
		if (!selected) {
			replace(this.#foot);
			return;
		}
		const control = (name: string, label: string, onclick: () => void) =>
			h(
				"button",
				{ type: "button", class: "concepts-button", title: label, "aria-label": label, onclick },
				icon(name),
			);
		replace(
			this.#foot,
			h(
				"div",
				{ class: "concepts-actions" },
				control("reload", t("Reload"), () => this.reload()),
				control("folder", t("Show in Storage"), () => this.#host.panel.openInStorage(selected.path)),
			),
		);
	}

	#drawStage(concepts: readonly Concept[], selected: Concept | undefined): void {
		if (selected) {
			if (this.#panel?.target.kind === "app" && this.#panel.target.name === selected.name) return;
			this.#panel?.dispose();
			this.#panel = new AppPanel(this.#host.panel, { kind: "app", name: selected.name }, { kind: "concept" });
			replace(this.#stage, this.#panel.el);
			return;
		}
		// What was open left, or another that is not here is asked for: the stage says so once the apps are read.
		this.#panel?.dispose();
		this.#panel = undefined;
		const text = !this.#read
			? t("Opening…")
			: this.#asked !== undefined
				? t("This concept isn't in the company anymore.")
				: t("The company has no concepts yet.");
		// The newest concept it offers changes with the concepts, its text with the route.
		const newest = this.#read && this.#asked !== undefined ? concepts[0]?.name : undefined;
		const key = `${text}\n${newest ?? ""}`;
		const shown = this.#stage.querySelector<HTMLElement>(":scope > .concepts-status");
		if (shown?.dataset.shown === key) return;
		replace(
			this.#stage,
			h(
				"div",
				{ class: "concepts-status", dataset: { shown: key } },
				h("p", null, text),
				newest ? h("a", { href: conceptsHash(this.#host.profileId, newest) }, t("Open the newest concept")) : null,
			),
		);
	}
}
