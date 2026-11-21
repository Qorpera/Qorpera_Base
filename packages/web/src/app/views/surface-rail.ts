import { INTERFACE_EMBLEMS } from "@qorpera/cloud-client/interfaces";
import type { SurfaceExplorationSet, SurfaceSession, SurfaceSummary } from "@qorpera/contracts";
import { h, icon } from "../../ui/dom.ts";
import { type Emblem, interfaceEmblem } from "../../ui/interface-emblem.ts";
import { t } from "../../ui/preferences.ts";
import { surfaceHash } from "../router.ts";
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

const EMBLEMS: ReadonlySet<string> = new Set<string>([...INTERFACE_EMBLEMS, "bank", "globe", "spark", "drawers"]);

export function surfaceEmblem(surface: Pick<SurfaceSummary, "icon" | "archetype">): Emblem {
	if (EMBLEMS.has(surface.icon)) return surface.icon as Emblem;
	return surface.archetype === "live_build" ? "globe" : surface.archetype === "ops" ? "board" : "page";
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

function changeSwitch(surfaceId: string, changeId: string, shown: boolean, title: string): HTMLElement {
	return h("button", {
		type: "button",
		class: "surface-switch",
		role: "switch",
		"aria-checked": String(shown),
		"aria-label": shown ? t("Hide {title} from the preview", { title }) : t("Show {title} in the preview", { title }),
		"data-act": "toggle",
		"data-surface": surfaceId,
		"data-change": changeId,
	});
}

function approveButton(sessionId: string, changeId: string, title: string): HTMLElement {
	return h(
		"button",
		{
			type: "button",
			class: "surface-approve",
			"aria-label": t("Approve {title}", { title }),
			title: t("Approve and merge into Base"),
			"data-act": "approve",
			"data-session": sessionId,
			"data-change": changeId,
		},
		icon("check"),
	);
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

function sessionRow(store: SurfacesStore, state: SurfacesState, session: SurfaceSession): HTMLElement {
	const running = isRunningSession(session);
	const open = !state.collapsed[session.id];
	const held = sessionHeld(session);
	const conflicted = !running && hasConflictedChange(session);
	const busyReconcile = Boolean(state.busy[`reconcile:${session.surfaceId}`]);
	const openChanges = session.changes.filter(isOpenChange);
	const merged = session.changes.filter((change) => change.status === "merged").length;
	const main = h(
		"button",
		{
			type: "button",
			class: "surface-session-main",
			"data-act": "open",
			"data-surface": session.surfaceId,
			"data-session": session.id,
		},
		sessionStatus(session),
		h("span", { class: "surface-session-title" }, session.title),
	);
	const head = h("div", { class: "surface-session-head" }, main);
	const single = session.changes.length === 1 && openChanges.length === 1 && !running;
	if (single) {
		const change = openChanges[0]!;
		head.append(
			change.status === "conflicted"
				? reconcileButton(session.surfaceId, change.id, change.title, busyReconcile)
				: approveButton(session.id, change.id, change.title),
			changeSwitch(session.surfaceId, change.id, store.isChangeShown(change.id), change.title),
		);
	} else {
		const meta = running
			? t("Working")
			: conflicted
				? t("Conflict")
				: held
					? t("All merged")
					: session.changes.length
						? `${merged}/${session.changes.length}`
						: "";
		if (meta) main.append(h("span", { class: "surface-session-meta" }, meta));
		if (!running && !conflicted && openChanges.length > 1)
			head.append(
				h(
					"button",
					{
						type: "button",
						class: "surface-approve",
						"aria-label": t("Approve all changes in {title}", { title: session.title }),
						title: t("Approve all"),
						"data-act": "approve-all",
						"data-session": session.id,
					},
					icon("check"),
				),
			);
		if (session.changes.length > 1)
			head.append(
				h(
					"button",
					{
						type: "button",
						class: "surface-chevron",
						"aria-expanded": String(open),
						"aria-label": open
							? t("Fold {title}", { title: session.title })
							: t("Unfold {title}", { title: session.title }),
						"data-act": "fold",
						"data-session": session.id,
					},
					icon("chevron"),
				),
			);
	}
	const row = h(
		"div",
		{
			class: [
				"surface-session",
				running && "is-running",
				conflicted && "is-conflicted",
				open && "is-open",
				state.drawer?.sessionId === session.id && "is-selected",
				state.highlight?.sessionId === session.id && "is-highlighted",
			]
				.filter(Boolean)
				.join(" "),
		},
		head,
	);
	if (single && openChanges[0]?.status === "conflicted" && openChanges[0].conflictPaths?.length) {
		const paths = openChanges[0].conflictPaths;
		row.append(h("p", { class: "surface-conflict-paths", title: paths.join(", ") }, formatConflictPaths(paths)));
	}
	if (!single && open && session.changes.length > 1)
		row.append(
			h(
				"div",
				{ class: "surface-changes" },
				session.changes
					.filter((change) => change.status !== "discarded")
					.map((change) => {
						if (change.status === "merged")
							return h(
								"div",
								{ class: "surface-change is-merged" },
								h("span", { class: "surface-change-mark" }, icon("check")),
								h("span", { class: "surface-change-title" }, change.title),
								h("span", { class: "surface-change-merged" }, t("Merged")),
							);
						const shown = store.isChangeShown(change.id);
						if (change.status === "conflicted") {
							const paths = change.conflictPaths?.length ? formatConflictPaths(change.conflictPaths) : "";
							return h(
								"div",
								{ class: `surface-change is-conflicted${shown ? "" : " is-hidden"}` },
								changeSwitch(session.surfaceId, change.id, shown, change.title),
								h(
									"div",
									{ class: "surface-change-copy" },
									h(
										"span",
										{
											class: "surface-change-title",
											title: change.conflictPaths?.join(", ") || change.summary,
										},
										change.title,
									),
									paths
										? h(
												"small",
												{ class: "surface-change-paths", title: change.conflictPaths?.join(", ") },
												paths,
											)
										: null,
								),
								running ? null : reconcileButton(session.surfaceId, change.id, change.title, busyReconcile),
							);
						}
						return h(
							"div",
							{ class: `surface-change${shown ? "" : " is-hidden"}` },
							changeSwitch(session.surfaceId, change.id, shown, change.title),
							h("span", { class: "surface-change-title", title: change.summary }, change.title),
							running ? null : approveButton(session.id, change.id, change.title),
						);
					}),
			),
		);
	return row;
}

function explorationRow(
	store: SurfacesStore,
	exploration: SurfaceExplorationSet,
	variants: readonly SurfaceSession[],
): HTMLElement {
	const picked = store.pickedVariant(exploration);
	const pickedSession = variants.find((session) => session.id === picked);
	const running = variants.some(isRunningSession);
	return h(
		"div",
		{ class: "surface-session surface-exploration is-open" },
		h(
			"div",
			{ class: "surface-session-head" },
			h(
				"span",
				{ class: "surface-session-main" },
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
			h(
				"div",
				{ class: "surface-variant-foot" },
				variants.length > 1
					? h(
							"button",
							{ type: "button", class: "surface-mini", "data-act": "compare" },
							icon("table"),
							t("Compare"),
						)
					: null,
				pickedSession && !running
					? h(
							"button",
							{
								type: "button",
								class: "surface-mini",
								"data-act": "choose",
								"data-exploration": exploration.id,
								"data-session": pickedSession.id,
							},
							icon("check"),
							t("Approve"),
						)
					: null,
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

function treeFor(store: SurfacesStore, state: SurfacesState, surface: SurfaceSummary): HTMLElement {
	const workspace = state.workspaces[surface.id];
	const explorations = openExplorations(workspace);
	const sessions = workspace?.activeSessions ?? [];
	const plain = sessions.filter((session) => !session.explorationId);
	const children: HTMLElement[] = [
		...plain.map((session) => sessionRow(store, state, session)),
		...explorations.map((exploration) =>
			explorationRow(
				store,
				exploration,
				sessions.filter((session) => session.explorationId === exploration.id),
			),
		),
	];
	if (!children.length && workspace)
		children.push(
			h(
				"p",
				{ class: "surface-tree-empty" },
				store.canStartSessions(surface)
					? t("No open sessions. Describe a change below.")
					: t("Nothing in progress."),
			),
		);
	children.push(...historyRows(state, workspace?.recentHistory ?? []));
	return h("div", { class: "surface-tree" }, children);
}

function surfaceRow(surface: SurfaceSummary, profileId: string, active: boolean): HTMLElement {
	const meta: HTMLElement[] = [];
	if (surface.runningSessionCount > 0)
		meta.push(h("span", { class: "surface-state is-running", "aria-label": t("Working") }));
	if (surface.activeSessionCount > 0) meta.push(h("span", null, String(surface.activeSessionCount)));
	if (surface.needsAttentionCount > 0)
		meta.push(h("span", { class: "surface-attention", "aria-label": t("Needs your attention") }));
	return h(
		"a",
		{
			class: `rail-surface${active ? " active" : ""}`,
			href: surfaceHash(profileId, surface.slug),
			draggable: "false",
			"data-surface-slug": surface.slug,
			...(active ? { "aria-current": "page" } : {}),
		},
		interfaceEmblem(surfaceEmblem(surface), 19),
		h("span", { class: "rail-surface-name" }, surface.title),
		meta.length ? h("span", { class: "rail-surface-meta" }, meta) : null,
	);
}

function proposedSurfaceRow(surface: SurfaceSummary, busy: boolean): HTMLElement {
	return h(
		"div",
		{ class: "rail-surface-proposed", "data-proposed-surface": surface.slug },
		interfaceEmblem(surfaceEmblem(surface), 18),
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
	#shown = "";
	#active: string | undefined;

	constructor(store: SurfacesStore, profileId: string, signal: AbortSignal, onAddSurface?: () => void) {
		this.#store = store;
		this.#profileId = profileId;
		this.#onAddSurface = onAddSurface;
		this.el.addEventListener("click", (event) => this.#click(event), { signal });
	}

	update(activeSlug: string | undefined, canAddProgram = false): void {
		this.#active = activeSlug;
		const state = this.#store.state;
		const key = JSON.stringify([
			activeSlug,
			canAddProgram,
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
			if (
				!activeSurfaces.length &&
				!proposedSurfaces.length &&
				!(group === "products" && canAddProgram && state.source !== "loading")
			)
				continue;
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
						const active = surface.slug === activeSlug;
						const row = surfaceRow(surface, this.#profileId, active);
						return active ? [row, treeFor(this.#store, state, surface)] : [row];
					}),
					proposedSurfaces.map((surface) =>
						proposedSurfaceRow(surface, Boolean(state.busy[`surface:${surface.id}`])),
					),
					group === "products" &&
						!activeSurfaces.length &&
						!proposedSurfaces.length &&
						canAddProgram &&
						this.#onAddSurface
						? h(
								"button",
								{
									type: "button",
									class: "rail-surface-create",
									"data-act": "add-surface",
								},
								icon("plus"),
								h("span", null, t("Add a surface")),
							)
						: null,
				),
			);
		}
		this.el.replaceChildren(...groups);
		this.el.hidden = groups.length === 0;
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
				if (surface && exploration && session) void store.pickVariant(surface, exploration, session);
				return;
			case "compare":
				store.setMode("compare");
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
