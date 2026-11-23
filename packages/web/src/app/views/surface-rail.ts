import type { SurfaceChangeUnit, SurfaceSummary } from "@qorpera/contracts";
import { menuPoint, openContextMenu, pressToOpenMenu } from "../../ui/context-menu.ts";
import { h, icon } from "../../ui/dom.ts";
import { presentationLocale, t } from "../../ui/preferences.ts";
import { type SurfaceFigureState, surfaceFigure, surfaceFigureChoices } from "../../ui/surface-figure.ts";
import { surfaceHash } from "../router.ts";
import {
	type SurfaceLook,
	surfaceFigureOf,
	surfaceKindSubtitle,
	surfaceLookOf,
	surfaceTint,
} from "../surface-kinds.ts";
import { askedToPublish, openExplorations, type SurfacesState, type SurfacesStore } from "../surfaces-store.ts";
import { CrewFigures } from "./surface-crew.ts";

export function surfaceTile(
	surface: Pick<SurfaceSummary, "icon">,
	look: SurfaceLook,
	className = "",
	state: SurfaceFigureState = "rest",
): HTMLElement {
	const tile = h(
		"span",
		{ class: ["surface-tile", className].filter(Boolean).join(" "), "aria-hidden": "true" },
		surfaceFigure(surfaceFigureOf(surface, look), state),
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

function crewRow(state: SurfacesState, surface: SurfaceSummary, crew: CrewFigures): HTMLElement | null {
	const workspace = state.workspaces[surface.id];
	const sessions = workspace?.activeSessions ?? [];
	const figures = [
		...sessions
			.filter((session) => !session.explorationId)
			.map((session) => {
				const figure = crew.take(session, 20, "is-mini");
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

function surfaceSubtitle(surface: SurfaceSummary, look: SurfaceLook): string {
	if (surface.needsAttentionCount > 0) return t("Needs you");
	if (surface.activeSessionCount === 1) return t("1 session active");
	if (surface.activeSessionCount > 1) return t("{count} sessions active", { count: surface.activeSessionCount });
	if (surface.archetype === "live_build" && surface.liveUrl)
		return t("Live · {host}", { host: hostOf(surface.liveUrl) });
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

interface SurfaceGroupEntry {
	readonly el: HTMLElement;
	readonly head: HTMLElement;
	headKey: string;
}

function createSurfaceRow(
	surface: SurfaceSummary,
	look: SurfaceLook,
	profileId: string,
	active: boolean,
	crew: HTMLElement | null,
): SurfaceRowEntry {
	const state: SurfaceFigureState = surface.runningSessionCount > 0 ? "working" : "rest";
	const tint = surfaceTint(look);
	const tileKey = JSON.stringify([surfaceFigureOf(surface, look), state, tint]);
	const tileEl = surfaceTile(surface, look, "", state);
	const nameEl = h("span", { class: "rail-surface-name" }, surface.title);
	const subEl = crew ?? h("span", { class: "rail-surface-sub" }, surfaceSubtitle(surface, look));
	const noticeText =
		surface.needsAttentionCount > 0
			? t("Needs your attention")
			: surface.runningSessionCount > 0
				? t("Working")
				: null;
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
): void {
	const href = surfaceHash(profileId, surface.slug);
	if (entry.el.getAttribute("href") !== href) entry.el.setAttribute("href", href);
	if (entry.el.title !== surface.title) entry.el.title = surface.title;
	if (entry.el.dataset.surfaceSlug !== surface.slug) entry.el.dataset.surfaceSlug = surface.slug;
	if (entry.el.dataset.surfaceKind !== look.kind) entry.el.dataset.surfaceKind = look.kind;
	const tint = surfaceTint(look);
	if (entry.el.style.getPropertyValue("--surface-tint") !== tint) entry.el.style.setProperty("--surface-tint", tint);
	setRowActive(entry.el, active);
	const state: SurfaceFigureState = surface.runningSessionCount > 0 ? "working" : "rest";
	const tileKey = JSON.stringify([surfaceFigureOf(surface, look), state, tint]);
	if (entry.tileKey !== tileKey) {
		const nextTile = surfaceTile(surface, look, "", state);
		entry.tileEl.replaceWith(nextTile);
		entry.tileEl = nextTile;
		entry.tileKey = tileKey;
	}
	if (entry.nameEl.textContent !== surface.title) entry.nameEl.textContent = surface.title;
	if (crew) {
		entry.subEl.replaceWith(crew);
		entry.subEl = crew;
	} else {
		const subtitle = surfaceSubtitle(surface, look);
		if (entry.subEl.classList.contains("rail-surface-crew")) {
			const nextSub = h("span", { class: "rail-surface-sub" }, subtitle);
			entry.subEl.replaceWith(nextSub);
			entry.subEl = nextSub;
		} else if (entry.subEl.textContent !== subtitle) {
			entry.subEl.textContent = subtitle;
		}
	}
	const noticeText =
		surface.needsAttentionCount > 0
			? t("Needs your attention")
			: surface.runningSessionCount > 0
				? t("Working")
				: null;
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

export class SurfaceRail {
	readonly el = h("div", { class: "rail-surfaces" });
	readonly #store: SurfacesStore;
	readonly #profileId: string;
	readonly #onAddSurface: (() => void) | undefined;
	readonly #crew = new CrewFigures();
	readonly #groups = new Map<"products" | "operations", SurfaceGroupEntry>();
	readonly #rows = new Map<string, SurfaceRowEntry>();
	readonly #proposedRows = new Map<string, { readonly el: HTMLElement; readonly key: string }>();
	#activeSlug: string | undefined;
	#shown: readonly unknown[] | undefined;

	constructor(store: SurfacesStore, profileId: string, signal: AbortSignal, onAddSurface?: () => void) {
		this.#store = store;
		this.#profileId = profileId;
		this.#onAddSurface = onAddSurface;
		this.el.addEventListener("click", (event) => this.#click(event), { signal });
		this.el.addEventListener("contextmenu", (event) => this.#menu(event), { signal });
		pressToOpenMenu(this.el, signal, (event) => this.#menu(event));
	}

	#menu(event: MouseEvent): void {
		if (event.shiftKey && (event.clientX || event.clientY)) return;
		const row = (event.target as Element | null)?.closest<HTMLElement>(".rail-surface");
		const surface = this.#store.state.surfaces.find((item) => item.slug === row?.dataset.surfaceSlug);
		if (!row || !surface) return;
		event.preventDefault();
		const chosen = surfaceFigureOf(surface, this.#store.lookOf(surface));
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
						el: surfaceFigureChoices(chosen, (figure) => {
							close();
							if (figure !== chosen) void this.#store.setFigure(surface.id, figure);
						}),
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
						]),
			],
		});
	}

	update(activeSlug: string | undefined, canAddProgram = false): void {
		const state = this.#store.state;
		const deps: readonly unknown[] = [
			canAddProgram,
			presentationLocale(),
			state.source,
			state.surfaces,
			state.workspaces,
			state.highlight,
			state.busy,
			state.surfaceLooks,
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
		const groups: HTMLElement[] = [];
		const seenActive = new Set<string>();
		const seenProposed = new Set<string>();
		for (const [group, label] of [
			["products", t("Building")],
			["operations", t("Running")],
		] as const) {
			const groupSurfaces = state.surfaces.filter((surface) => surface.group === group);
			const activeSurfaces = groupSurfaces.filter((surface) => surface.status === "active");
			const proposedSurfaces = groupSurfaces.filter((surface) => surface.status === "proposed");
			if (!activeSurfaces.length && !proposedSurfaces.length) continue;
			const headKey = JSON.stringify([label, group === "products" && canAddProgram, Boolean(this.#onAddSurface)]);
			let groupEntry = this.#groups.get(group);
			if (!groupEntry) {
				const head = h("div", { class: "rail-section-title rail-surface-title" });
				const el = h("div", { class: "rail-surface-group", role: "group", "aria-label": label }, head);
				groupEntry = { el, head, headKey: "" };
				this.#groups.set(group, groupEntry);
			}
			if (groupEntry.headKey !== headKey) {
				groupEntry.headKey = headKey;
				groupEntry.el.setAttribute("aria-label", label);
				groupEntry.head.replaceChildren(
					h("span", null, label),
					...(group === "products" && canAddProgram
						? [
								this.#onAddSurface
									? h(
											"button",
											{
												type: "button",
												class: "rail-surface-add",
												"aria-label": t("New surface"),
												title: t("New surface"),
												"data-act": "add-surface",
											},
											icon("plus"),
										)
									: h(
											"a",
											{
												class: "rail-surface-add",
												href: `#/c/${this.#profileId}/new-program`,
												"aria-label": t("New program"),
												title: t("New program"),
											},
											icon("plus"),
										),
							]
						: []),
				);
			}
			const groupChildren: HTMLElement[] = [groupEntry.head];
			for (const listed of activeSurfaces) {
				const asksMe = askedToPublish(listed, this.#store.userId);
				const surface = asksMe ? { ...listed, needsAttentionCount: listed.needsAttentionCount + 1 } : listed;
				seenActive.add(surface.id);
				const look = surfaceLookOf(surface, state.surfaceLooks);
				const active = surface.slug === activeSlug;
				if (surface.activeSessionCount > 0 && !state.workspaces[surface.id]) {
					this.#store.hydrateWorkspace(surface.id);
				}
				const crew = asksMe ? null : crewRow(state, surface, this.#crew);
				let entry = this.#rows.get(surface.id);
				if (!entry) {
					entry = createSurfaceRow(surface, look, this.#profileId, active, crew);
					this.#rows.set(surface.id, entry);
				} else {
					syncSurfaceRow(entry, surface, look, this.#profileId, active, crew);
				}
				groupChildren.push(entry.el);
			}
			for (const surface of proposedSurfaces) {
				seenProposed.add(surface.id);
				const look = surfaceLookOf(surface, state.surfaceLooks);
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
				groupChildren.push(entry.el);
			}
			reconcileChildren(groupEntry.el, groupChildren);
			groups.push(groupEntry.el);
		}
		for (const id of [...this.#rows.keys()]) {
			if (!seenActive.has(id)) this.#rows.delete(id);
		}
		for (const id of [...this.#proposedRows.keys()]) {
			if (!seenProposed.has(id)) this.#proposedRows.delete(id);
		}
		reconcileChildren(this.el, groups);
		this.el.hidden = groups.length === 0;
		this.#crew.settle();
	}

	#click(event: MouseEvent): void {
		const target = (event.target as Element).closest<HTMLElement>("[data-act]");
		if (!target || !this.el.contains(target)) return;
		event.preventDefault();
		const { act, surface } = target.dataset;
		const store = this.#store;
		switch (act) {
			case "add-surface":
				this.#onAddSurface?.();
				return;
			case "approve-surface":
				if (surface) void store.approveProposedSurface(surface);
				return;
			case "dismiss-surface":
				if (surface) void store.archiveSurface(surface);
				return;
		}
	}
}
