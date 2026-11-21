import { INTERFACE_EMBLEMS } from "@qorpera/cloud-client/interfaces";
import type { SurfaceChangeUnit, SurfaceExplorationSet, SurfaceSession, SurfaceSummary } from "@qorpera/contracts";
import { h, icon } from "../../ui/dom.ts";
import { type Emblem, interfaceEmblem } from "../../ui/interface-emblem.ts";
import { t } from "../../ui/preferences.ts";
import { surfaceHash } from "../router.ts";
import {
	type SurfaceLook,
	surfaceKindSubtitle,
	surfaceLookOf,
	surfaceTileEmblem,
	surfaceTint,
} from "../surface-kinds.ts";
import {
	formatConflictPaths,
	hasConflictedChange,
	isOpenChange,
	isRunningSession,
	openExplorations,
	type SurfacesState,
	type SurfacesStore,
	sessionHeld,
} from "../surfaces-store.ts";
import { CrewFigures, crewWave } from "./surface-crew.ts";

const EMBLEMS: ReadonlySet<string> = new Set<string>([
	...INTERFACE_EMBLEMS,
	"bank",
	"globe",
	"spark",
	"drawers",
	"phone",
	"window",
	"database",
]);

export function surfaceEmblem(surface: Pick<SurfaceSummary, "icon" | "archetype">): Emblem {
	if (EMBLEMS.has(surface.icon)) return surface.icon as Emblem;
	return surface.archetype === "live_build" ? "globe" : surface.archetype === "ops" ? "board" : "page";
}

export function surfaceTile(
	surface: Pick<SurfaceSummary, "icon">,
	look: SurfaceLook,
	emblemSize = 22,
	className = "",
): HTMLElement {
	const tile = h(
		"span",
		{ class: ["surface-tile", className].filter(Boolean).join(" "), "aria-hidden": "true" },
		interfaceEmblem(surfaceTileEmblem(surface, look), emblemSize),
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

function actionReadyLine(look: SurfaceLook, count: number): string {
	if (count > 1) return t("{count} actions ready", { count });
	return look.kind === "inbox" ? t("Draft ready") : t("Action ready");
}

function sessionLine(session: SurfaceSession, surface: SurfaceSummary, look: SurfaceLook): HTMLElement | string {
	if (session.state === "needs_input") return t("Needs you");
	if (isRunningSession(session)) return crewWave();
	if (session.state === "failed") return t("Failed");
	if (hasConflictedChange(session)) return t("Conflict");
	const live = session.changes.filter((change) => change.status !== "discarded");
	const actions = live.length > 0 && live.every((change) => isActionChange(change, surface));
	if (sessionHeld(session)) return actions ? t("All done") : t("All merged");
	const open = live.filter(isOpenChange).length;
	if (actions) return open ? actionReadyLine(look, open) : t("Ready");
	const merged = live.filter((change) => change.status === "merged").length;
	if (merged > 0) return t("{merged} of {total} merged", { merged, total: live.length });
	if (open === 1) return t("1 change ready");
	if (open > 1) return t("{count} changes ready", { count: open });
	return t("Ready");
}

export function sessionStatus(session: SurfaceSession): HTMLElement {
	if (isRunningSession(session) && session.state !== "needs_input")
		return h("span", { class: "surface-state is-running", "aria-label": t("Working") });
	if (session.state === "needs_input")
		return h("span", { class: "surface-state is-asking", "aria-label": t("Needs your answer") });
	if (session.state === "failed") return h("span", { class: "surface-state is-failed", "aria-label": t("Failed") });
	if (hasConflictedChange(session))
		return h("span", { class: "surface-state is-conflicted", "aria-label": t("Conflict") });
	if (sessionHeld(session))
		return h("span", { class: "surface-state is-merged", "aria-label": t("Merged") }, icon("check"));
	return h("span", { class: "surface-state is-ready", "aria-label": t("Ready") });
}

function reconcileButton(surfaceId: string, changeId: string, title: string, busy: boolean): HTMLElement {
	return h(
		"button",
		{
			type: "button",
			class: "surface-reconcile",
			disabled: busy,
			"aria-label": t("Reconcile {title}", { title }),
			title: t("Reconcile conflict"),
			"data-act": "reconcile",
			"data-surface": surfaceId,
			"data-change": changeId,
		},
		t("Reconcile"),
	);
}

function sendButton(sessionId: string, change: SurfaceChangeUnit, look: SurfaceLook): HTMLElement {
	const inbox = look.kind === "inbox";
	return h(
		"button",
		{
			type: "button",
			class: "surface-approve is-action",
			"aria-label": inbox
				? t("Send {title}", { title: change.title })
				: t("Approve {title}", { title: change.title }),
			title: inbox ? t("Send") : t("Approve"),
			"data-act": "approve",
			"data-session": sessionId,
			"data-change": change.id,
		},
		icon(inbox ? "send" : "check"),
	);
}

function sessionRow(
	state: SurfacesState,
	session: SurfaceSession,
	surface: SurfaceSummary,
	look: SurfaceLook,
	crew: CrewFigures,
): HTMLElement {
	const running = isRunningSession(session);
	const conflicted = !running && hasConflictedChange(session);
	const busyReconcile = Boolean(state.busy[`reconcile:${session.surfaceId}`]);
	const openChanges = session.changes.filter(isOpenChange);
	const live = session.changes.filter((change) => change.status !== "discarded");
	const actions = live.length > 0 && live.every((change) => isActionChange(change, surface));
	const main = h(
		"button",
		{
			type: "button",
			class: "surface-session-main",
			title: session.title,
			"data-act": "open",
			"data-surface": session.surfaceId,
			"data-session": session.id,
		},
		crew.take(session, 32),
		h(
			"span",
			{ class: "surface-session-text" },
			h("span", { class: "surface-session-title" }, session.title),
			h("span", { class: "surface-session-status" }, sessionLine(session, surface, look)),
		),
	);
	const head = h("div", { class: "surface-session-head" }, main);
	const single = live.length === 1 && openChanges.length === 1 && !running;
	if (single && actions) {
		head.append(sendButton(session.id, openChanges[0]!, look));
	} else if (conflicted) {
		const firstConflicted = openChanges.find((change) => change.status === "conflicted");
		if (firstConflicted)
			head.append(reconcileButton(session.surfaceId, firstConflicted.id, firstConflicted.title, busyReconcile));
	}
	const row = h(
		"div",
		{
			class: [
				"surface-session",
				running && "is-running",
				conflicted && "is-conflicted",
				actions && "is-action",
				state.drawer?.sessionId === session.id && "is-selected",
				state.highlight?.sessionId === session.id && "is-highlighted",
			]
				.filter(Boolean)
				.join(" "),
		},
		head,
	);
	const conflictPaths = openChanges.find((change) => change.status === "conflicted")?.conflictPaths;
	if (conflicted && conflictPaths?.length) {
		row.append(
			h(
				"p",
				{ class: "surface-conflict-paths", title: conflictPaths.join(", ") },
				formatConflictPaths(conflictPaths),
			),
		);
	}
	return row;
}

function explorationRow(
	store: SurfacesStore,
	exploration: SurfaceExplorationSet,
	variants: readonly SurfaceSession[],
): HTMLElement {
	const picked = store.pickedVariant(exploration);
	const running = variants.some(isRunningSession);
	return h(
		"div",
		{ class: "surface-session surface-exploration is-open" },
		h(
			"div",
			{ class: "surface-session-head" },
			h(
				"button",
				{
					type: "button",
					class: "surface-session-main surface-exploration-trigger",
					"data-act": "open-exploration",
					"data-exploration": exploration.id,
				},
				h("span", { class: "surface-state is-exploring", "aria-hidden": "true" }),
				h("span", { class: "surface-session-title" }, exploration.title),
				h(
					"span",
					{ class: "surface-session-meta" },
					running ? t("Working") : t("{count} live", { count: variants.length }),
				),
			),
		),
		h(
			"div",
			{ class: "surface-changes", role: "radiogroup", "aria-label": exploration.title },
			variants.map((session) =>
				h(
					"button",
					{
						type: "button",
						class: "surface-variant",
						role: "radio",
						"aria-checked": String(session.id === picked),
						"data-act": "variant",
						"data-surface": exploration.surfaceId,
						"data-exploration": exploration.id,
						"data-session": session.id,
					},
					h("span", { class: "surface-radio", "aria-hidden": "true" }),
					h("span", { class: "surface-change-title" }, session.explorationVariantLabel ?? session.title),
					isRunningSession(session) ? h("span", { class: "surface-state is-running" }) : null,
				),
			),
		),
	);
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
	crew: CrewFigures,
	active: boolean,
	membersList?: HTMLElement,
): HTMLElement {
	const workspace = state.workspaces[surface.id];
	const explorations = openExplorations(workspace);
	const sessions = workspace?.activeSessions ?? [];
	const plain = sessions.filter((session) => !session.explorationId);
	const look = store.lookOf(surface);
	const children: HTMLElement[] = [];
	if (membersList) children.push(membersList);
	if (active) {
		children.push(
			...plain.map((session) => sessionRow(state, session, surface, look, crew)),
			...explorations.map((exploration) =>
				explorationRow(
					store,
					exploration,
					sessions.filter((session) => session.explorationId === exploration.id),
				),
			),
		);
		if (!children.length && workspace)
			children.push(
				h(
					"p",
					{ class: "surface-tree-empty" },
					store.canStartSessions(surface)
						? surface.archetype === "ops"
							? t("Nothing waiting. Ask an agent below.")
							: t("No open sessions. Describe a change below.")
						: t("Nothing in progress."),
				),
			);
		children.push(...historyRows(state, workspace?.recentHistory ?? []));
	}
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
	members?: SurfaceRailMembers,
): HTMLElement {
	const meta: HTMLElement[] = [];
	if (surface.runningSessionCount > 0)
		meta.push(h("span", { class: "rail-surface-working", "aria-label": t("Working") }));
	if (surface.needsAttentionCount > 0)
		meta.push(h("span", { class: "surface-attention", "aria-label": t("Needs your attention") }));
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
		surfaceTile(surface, look),
		h(
			"span",
			{ class: "rail-surface-text" },
			h("span", { class: "rail-surface-name" }, surface.title),
			h("span", { class: "rail-surface-sub" }, surfaceSubtitle(surface, look, members)),
		),
		meta.length ? h("span", { class: "rail-surface-meta" }, meta) : null,
	);
	row.style.setProperty("--surface-tint", surfaceTint(look));
	return row;
}

function proposedSurfaceRow(surface: SurfaceSummary, look: SurfaceLook, busy: boolean): HTMLElement {
	return h(
		"div",
		{ class: "rail-surface-proposed", "data-proposed-surface": surface.slug },
		surfaceTile(surface, look, 18, "is-small"),
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
	#shown = "";
	#active: string | undefined;

	constructor(store: SurfacesStore, profileId: string, signal: AbortSignal, onAddSurface?: () => void) {
		this.#store = store;
		this.#profileId = profileId;
		this.#onAddSurface = onAddSurface;
		this.el.addEventListener("click", (event) => this.#click(event), { signal });
	}

	update(activeSlug: string | undefined, canAddProgram = false, members?: SurfaceRailMembers): void {
		this.#active = activeSlug;
		const memberRows = members?.rows ?? [];
		reconcileChildren(this.#membersList, memberRows);
		const state = this.#store.state;
		const key = JSON.stringify([
			activeSlug,
			canAddProgram,
			memberRows.length,
			members?.unread ?? 0,
			members?.active ?? false,
			state.source,
			state.surfaces,
			activeSlug ? state.workspaces[state.surfaces.find((s) => s.slug === activeSlug)?.id ?? ""] : null,
			state.hiddenChanges,
			state.variantPick,
			state.historyOpen,
			state.collapsed,
			state.drawer,
			state.highlight,
			state.busy,
			state.surfaceLooks,
		]);
		if (key === this.#shown) return;
		this.#shown = key;
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
						const row = surfaceRow(surface, look, this.#profileId, active, hasMembers ? members : undefined);
						return active || hasMembers
							? [
									row,
									treeFor(
										this.#store,
										state,
										surface,
										this.#crew,
										active,
										hasMembers ? this.#membersList : undefined,
									),
								]
							: [row];
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
		const { act, surface, session, change, exploration } = target.dataset;
		const store = this.#store;
		const state = store.state;
		const activeSurface = state.surfaces.find((item) => item.slug === this.#active);
		switch (act) {
			case "add-surface":
				this.#onAddSurface?.();
				return;
			case "open":
				if (surface && session) {
					if (state.highlight?.sessionId === session) store.clearHighlight();
					if (state.drawer?.sessionId === session) store.closeDrawer();
					else store.openDrawer(surface, session);
				}
				return;
			case "approve-surface":
				if (surface) void store.approveProposedSurface(surface);
				return;
			case "dismiss-surface":
				if (surface) void store.archiveSurface(surface);
				return;
			case "toggle":
				if (surface && change) void store.toggleChange(surface, change);
				return;
			case "approve":
				if (session && change) void store.approveChange(session, change);
				return;
			case "reconcile":
				if (surface && change) void store.reconcileChanges(surface, [change]);
				return;
			case "approve-all":
				if (session) void store.approveAll(session);
				return;
			case "fold":
				if (session) store.toggleCollapsed(session);
				return;
			case "variant":
				if (surface && exploration && session) void store.inspectVariant(surface, exploration, session, false);
				return;
			case "open-exploration":
				store.setMode("preview");
				store.openPreviewPanel();
				return;
			case "choose": {
				const workspace = activeSurface ? state.workspaces[activeSurface.id] : undefined;
				const set = workspace?.explorations.find((item) => item.id === exploration);
				if (set && session) void store.chooseVariant(set, session);
				return;
			}
			case "history":
				store.toggleHistory();
				return;
			case "revert":
				if (session) void store.revertSession(session);
				return;
		}
	}
}
