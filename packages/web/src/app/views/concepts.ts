import { type MenuEntry, menuPoint, openContextMenu, pressToOpenMenu } from "../../ui/context-menu.ts";
import { h, icon, linkHref, replace, setLinkHref } from "../../ui/dom.ts";
import { interfaceEmblem } from "../../ui/interface-emblem.ts";
import { t } from "../../ui/preferences.ts";
import { expandedRailWidth } from "../../ui/rail-layout.ts";
import { uiScale } from "../../ui/scale.ts";
import { forgetPictureUrl, pictureUrl } from "../folder-images.ts";
import { type CompanyApp, companyConcepts } from "../interface-apps.ts";
import { conceptsHash } from "../router.ts";
import { AppPanel, type AppPanelHost } from "./app-panel.ts";
import { QuestionDock } from "./question-dock.ts";

/* The Concepts viewer, `#/c/{id}/concepts[/{name}]` (Jonas, 8 November 2026: "a fullscreen view of the selected
 * concept, with a sidepanel for the different ideas/designs you could select to view"). The first thing a company shows
 * its founders is its concepts: the product they described, as the finished product, in several ideas or designs to
 * compare. Each is an interface app with `concept = true` in its app.toml.
 * - Full screen: Qorpera's own rail is away on this route (app/application.ts). The selected concept's frame fills all
 *   but the side panel, edge to edge, with nothing of Qorpera's around it: no header, no border, no inset and no band
 *   behind it (AppPanel's "concept" placement; Jonas, 13 November 2026: "I would try and minimize the
 *   borders/framing around the visual we are just trying to show"). The panel is the only furniture.
 * - The side panel stands in the company rail's place and is the rail: its width (ui/rail-layout.ts
 *   `expandedRailWidth`, the member's own choice for the expanded rail, never a compact rail's strip), its surface,
 *   its rows, its hover and its selection (Jonas, 13 November 2026: "polish it to match the style and width of the
 *   regular sidepanel"). It has the way back to the company and the concepts (cover or emblem, title, `about`, who
 *   made it), and it ends with its list (Jonas, 13 November 2026, on the Reload and Storage buttons and the strip under
 *   them: "get rid of this at the bottom of the concepts sidepanel").
 * - A concept's row has a menu of its own, the rail's (ui/context-menu.ts): a right-click, a long press on a touch
 *   screen, or Shift+F10 or the menu key on the focused row. It has Show in Storage, and for the open concept Reload,
 *   which also lets a concept that was told "Not now" three times ask again (views/app-ask-bar.ts).
 * - The strip that said whose the open concept is and that Qorpera never asks for passwords in it (security review r1
 *   H2, #1539 round 1) is gone on Jonas's word of 13 November 2026. Who made each concept still stands in its row; what
 *   keeps a member safe is as it was: the page has no network and submits no form, and nothing leaves it except through
 *   Qorpera's own bar, with the member's yes (RUNTIME-INTERFACE-APPS.md §6 H2).
 * - A cover is read by its file's version: a cover made or replaced shows once the folder says it changed, and a read
 *   that failed is tried again then.
 * - An item is a link to its concept's route: pressing it switches the concept in place, the panel as it is.
 * - The agents' open questions about the concept that is open (a choice between directions) stand in a dock over the
 *   stage's corner, drawn by Qorpera outside the concept's frame (views/question-dock.ts): one tap answers, as in the
 *   chat. A question is on the page of the concept it asks about and on no other (Jonas, 13 November 2026).
 * - The panel folds to the compact rail's strip (kept per viewer in this browser); at phone width it is a top bar
 *   with a menu. */

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
	/** The agents' open questions about the open concept, over the stage's corner (views/question-dock.ts). */
	#dock: QuestionDock | undefined;
	/** The concept the dock is showing the questions of, so a redraw that changed nothing leaves the dock alone. */
	#dockConcept: string | undefined;

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
				),
			),
			this.#stage,
		);
		if (host.panel.questions) {
			this.#dock = new QuestionDock(host.panel.questions, () => false);
			this.el.append(this.#dock.el);
		}
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
		// A row's own menu: Reload and Show in Storage, where the panel's foot had them.
		this.#list.addEventListener("contextmenu", (event) => this.#openRowMenu(event), {
			signal: this.#lifetime.signal,
		});
		pressToOpenMenu(this.#list, this.#lifetime.signal, (event) => this.#openRowMenu(event));
		// The panel is as wide as the member's own rail, which the window caps: a resize may change it.
		this.#widen();
		window.addEventListener("resize", () => this.#widen(), { signal: this.#lifetime.signal });
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
		this.#dock?.dispose();
		this.#dock = undefined;
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

	/** The panel takes the expanded rail's width, drawn at the app's scale as the rail's own is (ui/rail-layout.ts): a
	 * compact rail's strip never makes the open panel that narrow, and folding stays the panel's own. A whole number of
	 * pixels, so the toggle at the panel's edge stands on the pixel grid its glyph was drawn for. */
	#widen(): void {
		this.el.style.setProperty("--concepts-width", `${Math.round(expandedRailWidth() * uiScale())}px`);
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
		if (linkHref(this.#back) !== href) setLinkHref(this.#back, href);
		if (this.#back.getAttribute("aria-label") !== backLabel) {
			this.#back.setAttribute("aria-label", backLabel);
			this.#back.title = backLabel;
		}
		if (this.#backName.textContent !== company) this.#backName.textContent = company;
		this.#current.textContent = selected?.manifest.name ?? "";
		this.el.classList.toggle("is-collapsed", this.#collapsed);
		this.el.classList.toggle("is-menu-open", this.#menuOpen);
		// What the toggle does now, as the rail's sidebar toggle says it (Jonas, 13 November 2026).
		const collapseLabel = this.#collapsed ? t("Show sidebar") : t("Hide sidebar");
		this.#collapse.setAttribute("aria-label", collapseLabel);
		this.#collapse.title = collapseLabel;
		this.#collapse.setAttribute("aria-expanded", String(!this.#collapsed));
		this.#menu.setAttribute("aria-label", t("Concepts"));
		this.#menu.title = t("Concepts");
		this.#menu.setAttribute("aria-expanded", String(this.#menuOpen));
		this.#drawList(concepts, selected);
		this.#drawStage(concepts, selected);
		this.#drawDock(selected);
	}

	/** The dock shows the questions about the concept that is open, and no others (Jonas, 13 November 2026: the
	 * question box "should only be on the concept page it's asking about"). A question that points at no concept, or
	 * at one that is gone, is on none of them: it waits in its agent's thread. */
	#drawDock(selected: Concept | undefined): void {
		const name = selected?.name;
		if (!this.#dock || name === this.#dockConcept) return;
		this.#dockConcept = name;
		this.#dock.setMatch((apps) => name !== undefined && apps.has(name));
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
				manifest.about ? h("small", { class: "concepts-item-about" }, manifest.about) : null,
				h("small", { class: "concepts-item-by" }, this.#made(concept)),
			),
		);
	}

	/** A thumb shows its concept's cover as last read, or its emblem. */
	#paintThumb(thumb: HTMLElement, concept: Concept): void {
		const path = coverPath(concept);
		const url = path ? (this.#covers.get(path)?.url ?? null) : null;
		const shown = thumb.querySelector("img");
		if (url) {
			if (shown?.getAttribute("src") === url) return;
			replace(thumb, h("img", { src: url, alt: "", draggable: "false" }));
		} else if (shown || !thumb.firstChild) {
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

	/** A concept's row's menu, the rail's (a right-click, a long press, Shift+F10 or the menu key on the focused row):
	 * Reload for the open concept, and Show in Storage. Shift with a right-click keeps the browser's own menu. */
	#openRowMenu(event: MouseEvent): void {
		if (event.shiftKey && (event.clientX || event.clientY)) return;
		const row = (event.target as Element).closest<HTMLAnchorElement>("a.concepts-item");
		const concept = row && this.#concepts().find((entry) => entry.name === row.dataset.concept);
		if (!row || !concept) return;
		event.preventDefault();
		const name = concept.name;
		const items: MenuEntry[] = [
			// The open concept reads afresh; another opens fresh when it is pressed.
			...(name === this.#selected()?.name
				? [{ label: t("Reload"), icon: "reload", select: () => this.reload() }]
				: []),
			{ label: t("Show in Storage"), icon: "folder", select: () => this.#host.panel.openInStorage(concept.path) },
		];
		const point = menuPoint(event, row);
		openContextMenu({
			label: t("{name} actions", { name: concept.manifest.name }),
			x: point.x,
			y: point.y,
			items,
			opener: row,
			findOpener: () =>
				[...this.#list.querySelectorAll<HTMLElement>("a.concepts-item")].find(
					(item) => item.dataset.concept === name,
				) ?? null,
		});
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
