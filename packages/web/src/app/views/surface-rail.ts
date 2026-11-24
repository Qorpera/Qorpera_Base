import type { SurfaceChangeUnit, SurfaceSession, SurfaceSummary } from "@qorpera/contracts";
import {
	type ArrangedRail,
	addSection,
	arrangeSurfaces,
	defaultSurfaceOrder,
	LOOSE_ZONE,
	moveSurface,
	moveSurfaceTo,
	newSurfaceSectionId,
	nudgeSection,
	nudgeSurface,
	removeSection,
	renameSection,
	SECTION_ZONE,
	SURFACE_SECTION_NAME_LIMIT,
	type SurfaceRailLayout,
} from "../../cloud/surface-rail-layout.ts";
import { type MenuEntry, menuPoint, openContextMenu, pressToOpenMenu } from "../../ui/context-menu.ts";
import { confirmDialog, h, icon } from "../../ui/dom.ts";
import { matchesKey } from "../../ui/keys.ts";
import { nameDialog } from "../../ui/name-dialog.ts";
import { presentationLocale, t } from "../../ui/preferences.ts";
import {
	type SurfaceFigureId,
	type SurfaceFigurePaint,
	type SurfaceFigureState,
	surfaceFigure,
	surfaceFigureChoices,
	surfaceFigureIcon,
} from "../../ui/surface-figure.ts";
import type { SiteAnswer } from "../company.ts";
import { surfaceHash } from "../router.ts";
import {
	type SurfaceLook,
	surfaceFigureOf,
	surfaceKindSubtitle,
	surfaceLookOf,
	surfaceTint,
} from "../surface-kinds.ts";
import {
	askedToPublish,
	isOpenVariant,
	openExplorations,
	type SurfacesState,
	type SurfacesStore,
	type SurfaceTeammate,
} from "../surfaces-store.ts";
import { CrewFigures } from "./surface-crew.ts";

export function surfaceTile(
	surface: Pick<SurfaceSummary, "icon">,
	look: SurfaceLook,
	className = "",
	state: SurfaceFigureState = "rest",
	paint: SurfaceFigurePaint = "lazy",
): HTMLElement {
	const tile = h(
		"span",
		{ class: ["surface-tile", className].filter(Boolean).join(" "), "aria-hidden": "true" },
		surfaceFigure(surfaceFigureOf(surface, look), state, paint),
	);
	tile.style.setProperty("--surface-tint", surfaceTint(look));
	return tile;
}

export function isActionChange(
	change: Pick<SurfaceChangeUnit, "kind">,
	surface: Pick<SurfaceSummary, "archetype">,
): boolean {
	return change.kind === "ops_action" || surface.archetype === "ops";
}

function reconcileChildren(parent: HTMLElement, children: readonly HTMLElement[]): void {
	const kept = new Set<Element>(children);
	for (const child of [...parent.children]) if (!kept.has(child)) child.remove();
	children.forEach((child, index) => {
		if (parent.children[index] !== child) parent.insertBefore(child, parent.children[index] ?? null);
	});
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

const CREW_SHOWN = 6;

function crewRow(
	state: SurfacesState,
	surface: SurfaceSummary,
	crew: CrewFigures,
	turn: (session: SurfaceSession) => SurfaceTeammate | undefined,
): HTMLElement | null {
	const workspace = state.workspaces[surface.id];
	const sessions = workspace?.activeSessions ?? [];
	const figures = [
		...sessions
			.filter((session) => !isOpenVariant(session, workspace))
			.map((session) => {
				const figure = crew.take(session, 20, "is-mini", turn(session));
				figure.title = session.title;
				figure.classList.toggle("is-highlighted", state.highlight?.sessionId === session.id);
				return figure;
			}),
		...openExplorations(workspace).map((exploration) => {
			const figure = crew.takeExploration(
				exploration,
				sessions.filter((session) => session.explorationId === exploration.id),
				20,
				"is-mini",
			);
			figure.title = exploration.title;
			return figure;
		}),
	];
	if (!figures.length) return null;
	const hidden = figures.length - CREW_SHOWN;
	return h(
		"span",
		{
			class: "rail-surface-sub rail-surface-crew",
			role: "group",
			"aria-label":
				figures.length === 1 ? t("1 session active") : t("{count} sessions active", { count: figures.length }),
		},
		figures.slice(0, CREW_SHOWN),
		hidden > 0 ? h("span", { class: "rail-surface-crew-more", "aria-hidden": "true" }, `+${hidden}`) : null,
	);
}

function surfaceSubtitle(surface: SurfaceSummary, look: SurfaceLook, site: SiteAnswer = "unknown"): string {
	if (surface.needsAttentionCount > 0) return t("Needs you");
	if (surface.activeSessionCount === 1) return t("1 session active");
	if (surface.activeSessionCount > 1) return t("{count} sessions active", { count: surface.activeSessionCount });
	if (surface.archetype === "live_build" && surface.liveUrl) {
		const host = hostOf(surface.liveUrl);
		return site === "live" ? t("Live · {host}", { host }) : site === "private" ? t("Not live yet") : host;
	}
	return surfaceKindSubtitle(look.kind);
}

function setRowActive(row: HTMLElement, active: boolean): void {
	row.classList.toggle("active", active);
	if (active) row.setAttribute("aria-current", "page");
	else row.removeAttribute("aria-current");
}

interface SurfaceRowEntry {
	readonly el: HTMLAnchorElement;
	readonly nameEl: HTMLElement;
	tileEl: HTMLElement;
	tileKey: string;
	subEl: HTMLElement;
	noticeEl: HTMLElement | null;
	noticeText: string | null;
}

function noteMark(tile: HTMLElement, notes: number): HTMLElement {
	if (notes > 0) tile.append(h("span", { class: "rail-mention", "aria-hidden": "true" }, "@"));
	return tile;
}

function rowNotice(surface: SurfaceSummary, notes: number): string | null {
	const notice = [
		surface.needsAttentionCount > 0 ? t("Needs your attention") : surface.runningSessionCount > 0 ? t("Working") : "",
		notes > 0 ? t("A teammate left you a note") : "",
	]
		.filter(Boolean)
		.join(" · ");
	return notice || null;
}

function syncRowTile(
	entry: SurfaceRowEntry,
	surface: SurfaceSummary,
	look: SurfaceLook,
	notes: number,
	paint: SurfaceFigurePaint = "lazy",
): void {
	const state: SurfaceFigureState = surface.runningSessionCount > 0 ? "working" : "rest";
	const tileKey = JSON.stringify([surfaceFigureOf(surface, look), state, surfaceTint(look), notes > 0]);
	if (entry.tileKey === tileKey) return;
	const nextTile = noteMark(surfaceTile(surface, look, "", state, paint), notes);
	entry.tileEl.replaceWith(nextTile);
	entry.tileEl = nextTile;
	entry.tileKey = tileKey;
}

function createSurfaceRow(
	surface: SurfaceSummary,
	look: SurfaceLook,
	profileId: string,
	active: boolean,
	crew: HTMLElement | null,
	notes: number,
	site: SiteAnswer,
): SurfaceRowEntry {
	const state: SurfaceFigureState = surface.runningSessionCount > 0 ? "working" : "rest";
	const tint = surfaceTint(look);
	const tileKey = JSON.stringify([surfaceFigureOf(surface, look), state, tint, notes > 0]);
	const tileEl = noteMark(surfaceTile(surface, look, "", state), notes);
	const nameEl = h("span", { class: "rail-surface-name" }, surface.title);
	const subEl = crew ?? h("span", { class: "rail-surface-sub" }, surfaceSubtitle(surface, look, site));
	const noticeText = rowNotice(surface, notes);
	const noticeEl = noticeText ? h("span", { class: "visually-hidden" }, noticeText) : null;
	const el = h(
		"a",
		{
			class: `rail-surface${active ? " active" : ""}`,
			href: surfaceHash(profileId, surface.slug),
			title: surface.title,
			draggable: "false",
			"data-surface-slug": surface.slug,
			"data-surface-kind": look.kind,
			...(active ? { "aria-current": "page" } : {}),
		},
		tileEl,
		h("span", { class: "rail-surface-text" }, nameEl, subEl),
		noticeEl,
	);
	el.style.setProperty("--surface-tint", tint);
	return { el, nameEl, tileEl, tileKey, subEl, noticeEl, noticeText };
}

function syncSurfaceRow(
	entry: SurfaceRowEntry,
	surface: SurfaceSummary,
	look: SurfaceLook,
	profileId: string,
	active: boolean,
	crew: HTMLElement | null,
	notes: number,
	site: SiteAnswer,
): void {
	const href = surfaceHash(profileId, surface.slug);
	if (entry.el.getAttribute("href") !== href) entry.el.setAttribute("href", href);
	if (entry.el.title !== surface.title) entry.el.title = surface.title;
	if (entry.el.dataset.surfaceSlug !== surface.slug) entry.el.dataset.surfaceSlug = surface.slug;
	if (entry.el.dataset.surfaceKind !== look.kind) entry.el.dataset.surfaceKind = look.kind;
	const tint = surfaceTint(look);
	if (entry.el.style.getPropertyValue("--surface-tint") !== tint) entry.el.style.setProperty("--surface-tint", tint);
	setRowActive(entry.el, active);
	syncRowTile(entry, surface, look, notes);
	if (entry.nameEl.textContent !== surface.title) entry.nameEl.textContent = surface.title;
	if (crew) {
		entry.subEl.replaceWith(crew);
		entry.subEl = crew;
	} else {
		const subtitle = surfaceSubtitle(surface, look, site);
		if (entry.subEl.classList.contains("rail-surface-crew")) {
			const nextSub = h("span", { class: "rail-surface-sub" }, subtitle);
			entry.subEl.replaceWith(nextSub);
			entry.subEl = nextSub;
		} else if (entry.subEl.textContent !== subtitle) {
			entry.subEl.textContent = subtitle;
		}
	}
	const noticeText = rowNotice(surface, notes);
	if (entry.noticeText !== noticeText) {
		entry.noticeText = noticeText;
		if (noticeText) {
			if (entry.noticeEl) {
				entry.noticeEl.textContent = noticeText;
			} else {
				entry.noticeEl = h("span", { class: "visually-hidden" }, noticeText);
				entry.el.append(entry.noticeEl);
			}
		} else if (entry.noticeEl) {
			entry.noticeEl.remove();
			entry.noticeEl = null;
		}
	}
}

function proposedSurfaceRow(surface: SurfaceSummary, look: SurfaceLook, busy: boolean): HTMLElement {
	return h(
		"div",
		{ class: "rail-surface-proposed", "data-proposed-surface": surface.slug },
		surfaceTile(surface, look, "is-small"),
		h("span", { class: "rail-surface-name" }, surface.title),
		h("span", { class: "rail-proposed-tag" }, t("Proposed")),
		h(
			"span",
			{ class: "rail-proposed-actions" },
			h(
				"button",
				{
					type: "button",
					class: "rail-proposed-btn is-approve",
					disabled: busy,
					"aria-label": t("Approve {title}", { title: surface.title }),
					title: t("Approve surface"),
					"data-act": "approve-surface",
					"data-surface": surface.id,
				},
				icon("check"),
			),
			h(
				"button",
				{
					type: "button",
					class: "rail-proposed-btn is-dismiss",
					disabled: busy,
					"aria-label": t("Dismiss {title}", { title: surface.title }),
					title: t("Dismiss proposed surface"),
					"data-act": "dismiss-surface",
					"data-surface": surface.id,
				},
				icon("close"),
			),
		),
	);
}

export interface SurfaceRailArranger {
	layout(): SurfaceRailLayout | undefined;
	canArrange(): boolean;
	change(next: SurfaceRailLayout): void;
	refuse(message: string): void;
}

export class SurfaceRail {
	readonly el = h("div", { class: "rail-surfaces" });
	readonly #store: SurfacesStore;
	readonly #profileId: string;
	readonly #arranger: SurfaceRailArranger | undefined;
	readonly #signal: AbortSignal;
	readonly #reportError: ((text: string) => void) | undefined;
	readonly #siteAnswer: ((surface: SurfaceSummary) => SiteAnswer) | undefined;
	readonly #crew = new CrewFigures();
	readonly #groups = new Map<string, HTMLElement>();
	readonly #rows = new Map<string, SurfaceRowEntry & { readonly item: HTMLElement }>();
	readonly #proposedRows = new Map<string, { readonly el: HTMLElement; readonly key: string }>();
	readonly #deleting = new Set<string>();
	readonly #savingFigures = new Map<string, SurfaceFigureId>();
	#hoveredFigure: { readonly surfaceId: string; readonly figure: SurfaceFigureId } | undefined;
	#activeSlug: string | undefined;
	#shown: readonly unknown[] | undefined;
	#arranged: ArrangedRail<SurfaceSummary> = { loose: [], sections: [] };

	constructor(
		store: SurfacesStore,
		profileId: string,
		signal: AbortSignal,
		arranger?: SurfaceRailArranger,
		reportError?: (text: string) => void,
		siteAnswer?: (surface: SurfaceSummary) => SiteAnswer,
	) {
		this.#store = store;
		this.#profileId = profileId;
		this.#signal = signal;
		this.#arranger = arranger;
		this.#reportError = reportError;
		this.#siteAnswer = siteAnswer;
		this.el.addEventListener("click", (event) => this.#click(event), { signal });
		this.el.addEventListener("contextmenu", (event) => this.#menu(event), { signal });
		pressToOpenMenu(this.el, signal, (event) => this.#menu(event));
		this.el.addEventListener("keydown", (event) => this.#keydown(event), { signal });
	}

	canDrag(itemId: string): boolean {
		return Boolean(this.#arranger?.canArrange()) && this.#find(itemId) !== undefined;
	}

	accepts(zone: string, itemId: string): boolean {
		return this.isOwnZone(zone) && this.canDrag(itemId);
	}

	isOwnZone(zone: string): boolean {
		return zone === LOOSE_ZONE || zone.startsWith(SECTION_ZONE);
	}

	drop(itemId: string, zone: string, order: readonly string[]): void {
		if (!this.canDrag(itemId)) return;
		const next = moveSurface(this.#arranged, itemId, zone, order);
		if (next) this.#change(next);
	}

	async askNewSection(surfaceId?: string): Promise<void> {
		const name = await nameDialog({
			title: t("New section"),
			label: t("Section name"),
			confirm: t("Create"),
			maxLength: SURFACE_SECTION_NAME_LIMIT,
			signal: this.#signal,
		});
		if (!name || !this.#arranger?.canArrange()) return;
		const existing = this.#sectionNamed(name);
		if (existing && surfaceId) {
			const next = moveSurfaceTo(this.#arranged, surfaceId, existing.id);
			if (next) this.#change(next);
			return;
		}
		if (existing) {
			this.#arranger.refuse(t("A section called {name} already exists.", { name: `"${existing.name}"` }));
			return;
		}
		this.#change(addSection(this.#arranged, newSurfaceSectionId(), name, surfaceId));
	}

	canArrange(): boolean {
		return Boolean(this.#arranger?.canArrange());
	}

	#find(surfaceId: string): SurfaceSummary | undefined {
		return [...this.#arranged.loose, ...this.#arranged.sections.flatMap((section) => section.surfaces)].find(
			(surface) => surface.id === surfaceId,
		);
	}

	#sectionNamed(name: string, except?: string) {
		const wanted = name.toLocaleLowerCase();
		return this.#arranged.sections.find(
			(section) => section.id !== except && section.name.toLocaleLowerCase() === wanted,
		);
	}

	#change(next: SurfaceRailLayout): void {
		this.#arranger?.change(next);
	}

	#keydown(event: KeyboardEvent): void {
		const title = (event.target as Element).closest<HTMLElement>("[data-surface-section]");
		if (title && (event.key === "Enter" || event.key === " ")) {
			event.preventDefault();
			this.#sectionMenu(new MouseEvent("contextmenu", { cancelable: true }), title);
			return;
		}
		const delta = matchesKey(event, "previous") ? -1 : matchesKey(event, "next") ? 1 : 0;
		if (!event.altKey || !delta) return;
		const item = (event.target as Element).closest<HTMLElement>("[data-surface-id]");
		const surfaceId = item?.dataset.surfaceId;
		if (!surfaceId || !this.canDrag(surfaceId)) return;
		event.preventDefault();
		const next = nudgeSurface(this.#arranged, surfaceId, delta);
		if (!next) return;
		this.#change(next);
		this.el.querySelector<HTMLElement>(`[data-surface-id="${surfaceId}"] .rail-surface`)?.focus();
	}

	#menu(event: MouseEvent): void {
		if (event.shiftKey && (event.clientX || event.clientY)) return;
		const title = (event.target as Element | null)?.closest<HTMLElement>("[data-surface-section]");
		if (title) {
			this.#sectionMenu(event, title);
			return;
		}
		const row = (event.target as Element | null)?.closest<HTMLElement>(".rail-surface");
		const surface = this.#store.state.surfaces.find((item) => item.slug === row?.dataset.surfaceSlug);
		if (!row || !surface) return;
		event.preventDefault();
		const chosen = surfaceFigureOf(this.#withShownFigure(surface), this.#store.lookOf(surface));
		openContextMenu({
			label: surface.title,
			...menuPoint(event, row),
			opener: row,
			findOpener: () =>
				[...this.el.querySelectorAll<HTMLElement>(".rail-surface")].find(
					(item) => item.dataset.surfaceSlug === surface.slug,
				) ?? null,
			items: [
				{
					kind: "panel",
					label: t("Figure"),
					icon: "palette",
					panel: (close) => ({
						el: surfaceFigureChoices(
							chosen,
							(figure) => {
								if (figure !== chosen) void this.#saveFigure(surface.id, figure);
								close();
							},
							(figure) => this.#hoverFigure(surface.id, figure),
						),
						dispose: () => this.#hoverFigure(surface.id, undefined),
					}),
				},
				...(surface.archetype === "ops"
					? []
					: [
							{
								label: t("Auto-publish on Approve"),
								hint: t("Approved changes go live without a separate Publish."),
								checked: surface.autoPublish,
								multiple: true,
								select: () => void this.#store.setAutoPublish(surface.id, !surface.autoPublish),
							},
							{ kind: "separator" as const },
							{
								label: t("Delete"),
								icon: "trash",
								danger: true,
								select: () => void this.#delete(surface.id),
							},
						]),
				...this.#moveToMenu(surface.id),
			],
		});
	}

	#hoverFigure(surfaceId: string, figure: SurfaceFigureId | undefined): void {
		this.#hoveredFigure = figure ? { surfaceId, figure } : undefined;
		this.#redrawFigure(surfaceId);
	}

	async #saveFigure(surfaceId: string, figure: SurfaceFigureId): Promise<void> {
		const saving = this.#savingFigures.has(surfaceId);
		this.#savingFigures.set(surfaceId, figure);
		this.#redrawFigure(surfaceId);
		if (saving) return;
		try {
			let sent: SurfaceFigureId | undefined;
			while (sent !== this.#savingFigures.get(surfaceId)) {
				sent = this.#savingFigures.get(surfaceId);
				if (!sent || !(await this.#store.setFigure(surfaceId, sent))) break;
			}
		} finally {
			this.#savingFigures.delete(surfaceId);
			this.#redrawFigure(surfaceId);
		}
	}

	#withShownFigure(surface: SurfaceSummary): SurfaceSummary {
		const figure =
			this.#hoveredFigure?.surfaceId === surface.id
				? this.#hoveredFigure.figure
				: this.#savingFigures.get(surface.id);
		return figure ? { ...surface, icon: surfaceFigureIcon(figure) } : surface;
	}

	#redrawFigure(surfaceId: string): void {
		const state = this.#store.state;
		const entry = this.#rows.get(surfaceId);
		const surface = state.surfaces.find((item) => item.id === surfaceId);
		if (!entry || !surface) return;
		syncRowTile(
			entry,
			this.#withShownFigure(surface),
			surfaceLookOf(surface, state.surfaceLooks),
			this.#store.unseenNotesOn(surfaceId),
			"now",
		);
	}

	async #delete(surfaceId: string): Promise<void> {
		if (this.#deleting.has(surfaceId)) return;
		this.#deleting.add(surfaceId);
		try {
			const surface = this.#store.state.surfaces.find((item) => item.id === surfaceId);
			if (!surface) return;
			const confirmed = await confirmDialog(
				t("Delete {name}? It is removed for everyone in the company.", { name: surface.title }),
				t("Delete"),
				true,
				undefined,
				this.#signal,
			);
			if (!confirmed) return;
			if (!(await this.#store.deleteSurface(surfaceId))) this.#reportNotDeleted(surface.title);
			else if (this.#activeSlug === surface.slug) location.hash = `#/c/${this.#profileId}`;
		} finally {
			this.#deleting.delete(surfaceId);
		}
	}

	#reportNotDeleted(name: string): void {
		if (!this.#signal.aborted) this.#reportError?.(t("{name} could not be deleted.", { name }));
	}

	#moveToMenu(surfaceId: string): MenuEntry[] {
		if (!this.canDrag(surfaceId)) return [];
		const here = this.#arranged.sections.find((section) => section.surfaces.some((item) => item.id === surfaceId));
		const move = (sectionId: string | undefined) => () => {
			if (sectionId === here?.id) return;
			const next = moveSurfaceTo(this.#arranged, surfaceId, sectionId);
			if (next) this.#change(next);
		};
		return [
			{ kind: "separator" },
			{
				kind: "submenu",
				label: t("Move to"),
				icon: "section_plus",
				items: [
					...(this.#arranged.sections.length
						? [
								{ label: t("No section"), checked: !here, select: move(undefined) },
								...this.#arranged.sections.map((section) => ({
									label: section.name,
									checked: here?.id === section.id,
									select: move(section.id),
								})),
								{ kind: "separator" as const },
							]
						: []),
					{ label: t("New section…"), icon: "section_plus", select: () => void this.askNewSection(surfaceId) },
				],
			},
		];
	}

	#sectionMenu(event: MouseEvent, title: HTMLElement): void {
		const sectionId = title.dataset.surfaceSection;
		const section = this.#arranged.sections.find((item) => item.id === sectionId);
		event.preventDefault();
		if (!section || !this.#arranger?.canArrange()) return;
		const at = this.#arranged.sections.indexOf(section);
		const nudge = (delta: -1 | 1) => () => {
			const next = nudgeSection(this.#arranged, section.id, delta);
			if (next) this.#change(next);
		};
		openContextMenu({
			label: t("{name} actions", { name: section.name }),
			...menuPoint(event, title),
			opener: title,
			findOpener: () => this.el.querySelector<HTMLElement>(`[data-surface-section="${section.id}"]`),
			items: [
				{
					label: t("Rename section"),
					icon: "edit",
					select: async () => {
						const name = await nameDialog({
							title: t("Rename section"),
							label: t("Section name"),
							value: section.name,
							confirm: t("Rename"),
							maxLength: SURFACE_SECTION_NAME_LIMIT,
							signal: this.#signal,
						});
						if (!name || !this.#arranger?.canArrange()) return;
						const clash = this.#sectionNamed(name, section.id);
						if (clash)
							this.#arranger.refuse(t("A section called {name} already exists.", { name: `"${clash.name}"` }));
						else this.#change(renameSection(this.#arranged, section.id, name));
					},
				},
				...(at > 0 ? [{ label: t("Move up"), select: nudge(-1) }] : []),
				...(at < this.#arranged.sections.length - 1 ? [{ label: t("Move down"), select: nudge(1) }] : []),
				{ kind: "separator" },
				{
					label: t("Delete section"),
					icon: "trash",
					danger: true,
					select: async () => {
						const question = section.surfaces.length
							? t("Delete your section {name}? Its interfaces move out of it, to the end of the list.", {
									name: `"${section.name}"`,
								})
							: t("Delete your section {name}?", { name: `"${section.name}"` });
						if (await confirmDialog(question, t("Delete section"), true, undefined, this.#signal))
							this.#change(removeSection(this.#arranged, section.id));
					},
				},
			],
		});
	}

	update(activeSlug: string | undefined): void {
		const state = this.#store.state;
		const layout = this.#arranger?.layout();
		const arrangeable = Boolean(this.#arranger?.canArrange());
		const deps: readonly unknown[] = [
			state.surfaces.map((surface) => this.#siteAnswer?.(surface) ?? "unknown").join(),
			presentationLocale(),
			state.source,
			state.surfaces,
			state.workspaces,
			state.highlight,
			state.busy,
			state.surfaceLooks,
			state.unseenNotes,
			this.#store.teammates().length,
			layout,
			arrangeable,
		];
		if (
			this.#shown &&
			this.#shown.length === deps.length &&
			deps.every((value, index) => Object.is(this.#shown![index], value))
		) {
			for (const surface of state.surfaces) {
				if (surface.status === "active" && surface.activeSessionCount > 0 && !state.workspaces[surface.id]) {
					this.#store.hydrateWorkspace(surface.id);
				}
			}
			if (this.#activeSlug !== activeSlug) {
				this.#activeSlug = activeSlug;
				for (const entry of this.#rows.values()) {
					setRowActive(entry.el, entry.el.dataset.surfaceSlug === activeSlug);
				}
			}
			return;
		}
		this.#shown = deps;
		this.#activeSlug = activeSlug;
		const looks = state.surfaceLooks;
		const active = state.surfaces.filter((surface) => surface.status === "active");
		const companyOrder = defaultSurfaceOrder(
			[
				...active.filter((surface) => surface.group === "products"),
				...active.filter((surface) => surface.group !== "products"),
			],
			(surface) => surfaceLookOf(surface, looks).kind === "inbox",
		);
		this.#arranged = arrangeSurfaces(companyOrder, layout);
		const proposed = state.surfaces.filter((surface) => surface.status === "proposed");
		const seenActive = new Set<string>();
		const seenProposed = new Set<string>();
		const item = (listed: SurfaceSummary): HTMLElement => {
			const asksMe = askedToPublish(listed, this.#store.userId);
			const surface = asksMe ? { ...listed, needsAttentionCount: listed.needsAttentionCount + 1 } : listed;
			seenActive.add(surface.id);
			const look = surfaceLookOf(surface, looks);
			if (surface.activeSessionCount > 0 && !state.workspaces[surface.id]) {
				this.#store.hydrateWorkspace(surface.id);
			}
			const crew = asksMe ? null : crewRow(state, surface, this.#crew, (session) => this.#store.turnHolder(session));
			const notes = this.#store.unseenNotesOn(surface.id);
			const shown = this.#withShownFigure(surface);
			const site = this.#siteAnswer?.(listed) ?? "unknown";
			const isActive = surface.slug === activeSlug;
			let entry = this.#rows.get(surface.id);
			if (!entry) {
				const row = createSurfaceRow(shown, look, this.#profileId, isActive, crew, notes, site);
				entry = { ...row, item: h("div", { class: "rail-surface-item", "data-surface-id": surface.id }, row.el) };
				this.#rows.set(surface.id, entry);
			} else {
				syncSurfaceRow(entry, shown, look, this.#profileId, isActive, crew, notes, site);
			}
			return entry.item;
		};
		const proposedItem = (surface: SurfaceSummary): HTMLElement => {
			seenProposed.add(surface.id);
			const look = surfaceLookOf(surface, looks);
			const busy = Boolean(state.busy[`surface:${surface.id}`]);
			const key = JSON.stringify([
				surface.slug,
				surface.title,
				surfaceFigureOf(surface, look),
				surfaceTint(look),
				busy,
				presentationLocale(),
			]);
			let entry = this.#proposedRows.get(surface.id);
			if (!entry || entry.key !== key) {
				entry = { el: proposedSurfaceRow(surface, look, busy), key };
				this.#proposedRows.set(surface.id, entry);
			}
			return entry.el;
		};
		const group = (id: string): HTMLElement => {
			let el = this.#groups.get(id);
			if (!el) {
				el = h("div", { class: "rail-surface-group" });
				this.#groups.set(id, el);
			}
			return el;
		};
		const loose = group(LOOSE_ZONE);
		loose.className = `rail-surface-group rail-surface-loose${this.#arranged.loose.length ? "" : " is-empty"}`;
		loose.dataset.dropZone = LOOSE_ZONE;
		reconcileChildren(loose, [...this.#arranged.loose.map(item), ...proposed.map(proposedItem)]);
		const sections = this.#arranged.sections.map((section) => {
			const titleId = `rail-surface-section-${section.id}`;
			const el = group(`${SECTION_ZONE}${section.id}`);
			el.className = `rail-surface-group rail-surface-section${section.surfaces.length ? "" : " is-empty"}`;
			el.setAttribute("role", "group");
			el.setAttribute("aria-labelledby", titleId);
			el.dataset.dropZone = `${SECTION_ZONE}${section.id}`;
			const title = h(
				"div",
				{
					id: titleId,
					class: "rail-section-title rail-surface-title",
					"data-surface-section": section.id,
					...(arrangeable ? { tabindex: "0", role: "button", "aria-haspopup": "menu" } : {}),
				},
				h("span", null, section.name),
			);
			const old = el.querySelector<HTMLElement>(":scope > [data-surface-section]");
			const head = old && old.outerHTML === title.outerHTML ? old : title;
			reconcileChildren(el, [head, ...section.surfaces.map(item)]);
			return el;
		});
		const zones = new Set([LOOSE_ZONE, ...this.#arranged.sections.map((section) => `${SECTION_ZONE}${section.id}`)]);
		for (const id of [...this.#groups.keys()]) if (!zones.has(id)) this.#groups.delete(id);
		for (const id of [...this.#rows.keys()]) if (!seenActive.has(id)) this.#rows.delete(id);
		for (const id of [...this.#proposedRows.keys()]) if (!seenProposed.has(id)) this.#proposedRows.delete(id);
		reconcileChildren(this.el, [loose, ...sections]);
		this.el.hidden = this.#arranged.loose.length + proposed.length + this.#arranged.sections.length === 0;
		this.#crew.settle();
	}

	#click(event: MouseEvent): void {
		const title = (event.target as Element).closest<HTMLElement>("[data-surface-section]");
		if (title) {
			this.#sectionMenu(event, title);
			return;
		}
		const target = (event.target as Element).closest<HTMLElement>("[data-act]");
		if (!target || !this.el.contains(target)) return;
		event.preventDefault();
		const { act, surface } = target.dataset;
		const store = this.#store;
		switch (act) {
			case "approve-surface":
				if (surface) void store.approveProposedSurface(surface);
				return;
			case "dismiss-surface":
				if (surface) void store.archiveSurface(surface);
				return;
		}
	}
}
