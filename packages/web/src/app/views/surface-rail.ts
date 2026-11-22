import type { SurfaceChangeUnit, SurfaceSession, SurfaceSummary } from "@qorpera/contracts";
import { menuPoint, openContextMenu, pressToOpenMenu } from "../../ui/context-menu.ts";
import { h, icon } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import { type SurfaceFigureState, surfaceFigure, surfaceFigureChoices } from "../../ui/surface-figure.ts";
import { surfaceHash } from "../router.ts";
import {
	type SurfaceLook,
	surfaceFigureOf,
	surfaceKindSubtitle,
	surfaceLookOf,
	surfaceTint,
} from "../surface-kinds.ts";
import { openExplorations, type SurfacesState, type SurfacesStore } from "../surfaces-store.ts";
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

function historyRows(state: SurfacesState, sessions: readonly SurfaceSession[]): HTMLElement[] {
	if (!sessions.length) return [];
	const toggle = h(
		"button",
		{
			type: "button",
			class: "surface-history-toggle",
			"aria-expanded": String(state.historyOpen),
			"data-act": "history",
		},
		icon("clock"),
		h("span", null, t("History")),
		h("span", { class: "surface-history-count" }, String(sessions.length)),
	);
	if (!state.historyOpen) return [toggle];
	return [
		toggle,
		...sessions.map((session) =>
			h(
				"div",
				{ class: "surface-history-row" },
				h("span", { class: "surface-change-title" }, session.title),
				session.changes.some((change) => change.status === "merged" && change.canUndo)
					? h(
							"button",
							{ type: "button", class: "surface-mini", "data-act": "revert", "data-session": session.id },
							icon("reset"),
							t("Revert"),
						)
					: null,
			),
		),
	];
}

export interface SurfaceRailMembers {
	readonly rows: readonly HTMLElement[];
	readonly unread: number;
	readonly active: boolean;
}

function reconcileChildren(parent: HTMLElement, children: readonly HTMLElement[]): void {
	const kept = new Set<Element>(children);
	for (const child of [...parent.children]) if (!kept.has(child)) child.remove();
	children.forEach((child, index) => {
		if (parent.children[index] !== child) parent.insertBefore(child, parent.children[index] ?? null);
	});
}

function treeFor(
	store: SurfacesStore,
	state: SurfacesState,
	surface: SurfaceSummary,
	active: boolean,
	membersList?: HTMLElement,
): HTMLElement | null {
	const children: HTMLElement[] = [];
	if (membersList) children.push(membersList);
	if (active) children.push(...historyRows(state, state.workspaces[surface.id]?.recentHistory ?? []));
	if (!children.length) return null;
	const look = store.lookOf(surface);
	const tree = h("div", { class: "surface-tree" }, children);
	tree.style.setProperty("--surface-tint", surfaceTint(look));
	return tree;
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

function surfaceSubtitle(surface: SurfaceSummary, look: SurfaceLook, members?: SurfaceRailMembers): string {
	if (surface.needsAttentionCount > 0) return t("Needs you");
	if (surface.activeSessionCount === 1) return t("1 session active");
	if (surface.activeSessionCount > 1) return t("{count} sessions active", { count: surface.activeSessionCount });
	if (look.kind === "members" && members && members.rows.length > 0) {
		if (members.unread > 0) return t("{count} unread", { count: members.unread });
		return members.rows.length === 1 ? t("1 teammate") : t("{count} teammates", { count: members.rows.length });
	}
	if (surface.archetype === "live_build" && surface.liveUrl)
		return t("Live · {host}", { host: hostOf(surface.liveUrl) });
	return surfaceKindSubtitle(look.kind);
}

function surfaceRow(
	surface: SurfaceSummary,
	look: SurfaceLook,
	profileId: string,
	active: boolean,
	crew: HTMLElement | null,
	members?: SurfaceRailMembers,
): HTMLElement {
	const state: SurfaceFigureState =
		surface.needsAttentionCount > 0 ? "attention" : surface.runningSessionCount > 0 ? "working" : "rest";
	const row = h(
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
		surfaceTile(surface, look, "", state),
		h(
			"span",
			{ class: "rail-surface-text" },
			h("span", { class: "rail-surface-name" }, surface.title),
			crew ?? h("span", { class: "rail-surface-sub" }, surfaceSubtitle(surface, look, members)),
		),
		state === "rest"
			? null
			: h("span", { class: "visually-hidden" }, state === "attention" ? t("Needs your attention") : t("Working")),
	);
	row.style.setProperty("--surface-tint", surfaceTint(look));
	return row;
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
	readonly #membersList = h("div", { class: "rail-members rail-surface-members" });
	readonly #store: SurfacesStore;
	readonly #profileId: string;
	readonly #onAddSurface: (() => void) | undefined;
	readonly #crew = new CrewFigures();
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
			],
		});
	}

	update(activeSlug: string | undefined, canAddProgram = false, members?: SurfaceRailMembers): void {
		const memberRows = members?.rows ?? [];
		reconcileChildren(this.#membersList, memberRows);
		const state = this.#store.state;
		const activeWorkspace = activeSlug
			? state.workspaces[state.surfaces.find((s) => s.slug === activeSlug)?.id ?? ""]
			: undefined;
		const deps: readonly unknown[] = [
			activeSlug,
			canAddProgram,
			memberRows.length,
			members?.unread ?? 0,
			members?.active ?? false,
			state.source,
			state.surfaces,
			activeWorkspace,
			state.hiddenChanges,
			state.variantPick,
			state.historyOpen,
			state.collapsed,
			state.drawer,
			state.highlight,
			state.busy,
			state.surfaceLooks,
		];
		if (
			this.#shown &&
			this.#shown.length === deps.length &&
			deps.every((value, index) => Object.is(this.#shown![index], value))
		) {
			return;
		}
		this.#shown = deps;
		const groups: HTMLElement[] = [];
		for (const [group, label] of [
			["products", t("Building")],
			["operations", t("Running")],
		] as const) {
			const groupSurfaces = state.surfaces.filter((surface) => surface.group === group);
			const activeSurfaces = groupSurfaces.filter((surface) => surface.status === "active");
			const proposedSurfaces = groupSurfaces.filter((surface) => surface.status === "proposed");
			if (!activeSurfaces.length && !proposedSurfaces.length) continue;
			groups.push(
				h(
					"div",
					{ class: "rail-surface-group", role: "group", "aria-label": label },
					h(
						"div",
						{ class: "rail-section-title rail-surface-title" },
						h("span", null, label),
						group === "products" && canAddProgram
							? this.#onAddSurface
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
									)
							: null,
					),
					activeSurfaces.flatMap((surface) => {
						const look = surfaceLookOf(surface, state.surfaceLooks);
						const active = surface.slug === activeSlug;
						const hasMembers = look.kind === "members" && memberRows.length > 0;
						const row = surfaceRow(
							surface,
							look,
							this.#profileId,
							active,
							crewRow(state, surface, this.#crew),
							hasMembers ? members : undefined,
						);
						const tree =
							active || hasMembers
								? treeFor(this.#store, state, surface, active, hasMembers ? this.#membersList : undefined)
								: null;
						return tree ? [row, tree] : [row];
					}),
					proposedSurfaces.map((surface) =>
						proposedSurfaceRow(
							surface,
							surfaceLookOf(surface, state.surfaceLooks),
							Boolean(state.busy[`surface:${surface.id}`]),
						),
					),
				),
			);
		}
		this.el.replaceChildren(...groups);
		this.el.hidden = groups.length === 0;
		this.#crew.settle();
	}

	#click(event: MouseEvent): void {
		const target = (event.target as Element).closest<HTMLElement>("[data-act]");
		if (!target || !this.el.contains(target)) return;
		event.preventDefault();
		const { act, surface, session } = target.dataset;
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
			case "history":
				store.toggleHistory();
				return;
			case "revert":
				if (session) void store.revertSession(session);
				return;
		}
	}
}
