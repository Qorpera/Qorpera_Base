import type {
	SurfaceChangeUnit,
	SurfaceExplorationSet,
	SurfaceSession,
	SurfaceSessionMessage,
	SurfaceSummary,
	SurfaceWorkspace,
} from "@qorpera/contracts";
import { fmtTime, h, icon } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import type { SurfaceLook } from "../surface-kinds.ts";
import {
	formatConflictPaths,
	hasConflictedChange,
	isOpenChange,
	isRunningSession,
	openExplorations,
	type SurfacesStore,
	sessionHeld,
} from "../surfaces-store.ts";
import { CrewFigures } from "./surface-crew.ts";
import { isActionChange } from "./surface-rail.ts";

function recipientOf(change: SurfaceChangeUnit): string | null {
	const address = change.affectedPaths.find((path) => path.startsWith("mailto:"))?.slice("mailto:".length);
	if (!address) return null;
	const name = address.split("@")[0] ?? address;
	return name ? name.charAt(0).toLocaleUpperCase() + name.slice(1) : address;
}

function actionCard(
	change: SurfaceChangeUnit,
	look: SurfaceLook,
	single: boolean,
	busy: boolean,
	running: boolean,
): HTMLElement {
	const inbox = look.kind === "inbox";
	const open = isOpenChange(change);
	const recipient = inbox ? recipientOf(change) : null;
	const done = change.status === "merged";
	return h(
		"article",
		{
			class: ["surface-action-card", inbox && "is-email", done && "is-done"].filter(Boolean).join(" "),
			"data-change": change.id,
		},
		h(
			"div",
			{ class: "surface-action-head" },
			h("span", { class: "surface-action-kind" }, inbox ? t("Email draft") : t("Ready for your approval")),
			done
				? h("span", { class: "surface-tag is-merged" }, icon("check"), inbox ? t("Sent") : t("Done"))
				: change.status === "discarded"
					? h("span", { class: "surface-tag" }, t("Discarded"))
					: null,
		),
		inbox
			? h(
					"dl",
					{ class: "surface-email-meta" },
					recipient ? [h("dt", null, t("To")), h("dd", null, recipient)] : null,
					h("dt", null, t("Subject")),
					h("dd", null, change.title),
				)
			: h("strong", { class: "surface-action-title" }, change.title),
		change.summary ? h("p", { class: "surface-action-body" }, change.summary) : null,
		open && !running
			? h(
					"div",
					{ class: "surface-action-buttons" },
					h(
						"button",
						{
							type: "button",
							class: "btn btn-primary btn-small",
							"data-act": "approve",
							"data-change": change.id,
							disabled: busy,
						},
						inbox ? icon("send") : null,
						inbox ? t("Send") : t("Approve"),
					),
					single
						? h("button", { type: "button", class: "btn btn-small", "data-act": "discard" }, t("Discard"))
						: null,
				)
			: null,
	);
}

function messageRow(message: SurfaceSessionMessage): HTMLElement {
	if (message.authorKind === "system")
		return h(
			"div",
			{
				class: "surface-message is-system",
				...(message.changeId ? { "data-change-id": message.changeId } : {}),
			},
			message.changeId
				? h("span", { class: "surface-system-mark", "aria-hidden": "true" }, icon("check"))
				: h("span", { class: "surface-system-dot", "aria-hidden": "true" }),
			h("span", { class: "surface-system-text" }, message.text),
			h("time", { datetime: message.createdAt }, fmtTime(message.createdAt)),
		);
	if (message.authorKind === "session")
		return h("p", { class: "surface-message is-session", title: fmtTime(message.createdAt) }, message.text);
	return h("p", { class: "surface-message is-member", title: fmtTime(message.createdAt) }, message.text);
}

function changeTag(change: SurfaceChangeUnit): HTMLElement | null {
	if (change.status === "merged") return h("span", { class: "surface-tag is-merged" }, icon("check"), t("Merged"));
	if (change.status === "conflicted") return h("span", { class: "surface-tag is-conflicted" }, t("Conflict"));
	if (change.status === "discarded") return h("span", { class: "surface-tag" }, t("Discarded"));
	if (change.status === "reverted") return h("span", { class: "surface-tag" }, t("Reverted"));
	if (change.status === "merging") return h("span", { class: "surface-tag" }, t("Merging"));
	return null;
}

function agentStatusSummary(session: SurfaceSession, surface: SurfaceSummary, look: SurfaceLook): string {
	if (session.state === "needs_input") return t("Needs you");
	if (isRunningSession(session)) return t("Working");
	if (hasConflictedChange(session)) return t("Conflict");
	const live = session.changes.filter((change) => change.status !== "discarded");
	const open = live.filter(isOpenChange).length;
	const actions = live.length > 0 && live.every((change) => isActionChange(change, surface));
	if (actions) {
		if (open > 1) return t("{count} actions ready", { count: open });
		return look.kind === "inbox" ? t("Draft ready") : t("Action ready");
	}
	if (open === 1) return t("1 change ready");
	if (open > 1) return t("{count} changes ready", { count: open });
	return t("Ready");
}

function rankSessions(sessions: readonly SurfaceSession[]): SurfaceSession[] {
	const score = (session: SurfaceSession): number =>
		session.state === "needs_input"
			? 0
			: hasConflictedChange(session)
				? 1
				: isRunningSession(session)
					? 2
					: session.changes.some(isOpenChange)
						? 3
						: 4;
	return [...sessions].sort((a, b) => score(a) - score(b));
}

export class SurfaceSessionDrawer {
	readonly el = h("aside", { class: "surface-drawer", "aria-hidden": "true" });
	readonly #head = h("div", { class: "surface-drawer-head" });
	readonly #body = h("div", { class: "surface-drawer-body" });
	readonly #input = h("input", { class: "surface-drawer-input", autocomplete: "off" });
	readonly #send = h("button", { type: "submit", class: "surface-send is-ready" }, icon("send"));
	readonly #form = h("form", { class: "surface-drawer-foot" }, this.#input, this.#send);
	readonly #store: SurfacesStore;
	readonly #crew = new CrewFigures();
	#surfaceId = "";
	#shown = "";
	#sessionId = "";
	#messages = 0;

	constructor(store: SurfacesStore, signal: AbortSignal) {
		this.#store = store;
		this.el.append(h("div", { class: "surface-drawer-inner" }, this.#head, this.#body, this.#form));
		this.#form.addEventListener(
			"submit",
			(event) => {
				event.preventDefault();
				const sessionId = store.state.drawer?.sessionId;
				const text = this.#input.value.trim();
				if (!sessionId || !text) return;
				this.#input.value = "";
				void store.reply(sessionId, text).then((ok) => {
					if (!ok && !this.#input.value) this.#input.value = text;
				});
			},
			{ signal },
		);
		this.el.addEventListener("click", (event) => this.#click(event), { signal });
	}

	update(surface?: SurfaceSummary): void {
		const store = this.#store;
		const state = store.state;
		const targetSurface =
			surface ?? (state.drawer ? state.surfaces.find((item) => item.id === state.drawer?.surfaceId) : undefined);
		this.#surfaceId = targetSurface?.id ?? "";
		const focusedSession =
			state.drawer && (!targetSurface || state.drawer.surfaceId === targetSurface.id)
				? store.session(state.drawer.sessionId)
				: undefined;
		const overviewOpen = Boolean(!focusedSession && targetSurface && store.isPreviewPanelOpen(targetSurface.id));
		const open = Boolean(focusedSession) || overviewOpen;
		this.el.classList.toggle("is-open", open);
		this.el.classList.toggle("is-overview", overviewOpen);
		this.el.setAttribute("aria-hidden", String(!open));
		this.el.inert = !open;
		if (!open) {
			this.#shown = "";
			this.#sessionId = "";
			this.#messages = 0;
			return;
		}
		if (focusedSession) {
			this.#form.hidden = false;
			this.#renderFocused(focusedSession, targetSurface);
			return;
		}
		if (targetSurface) {
			this.#form.hidden = true;
			this.#renderOverview(targetSurface);
		}
	}

	#renderOverview(surface: SurfaceSummary): void {
		const store = this.#store;
		const state = store.state;
		const workspace = state.workspaces[surface.id];
		const look = store.lookOf(surface);
		const explorations = openExplorations(workspace);
		const plainSessions = rankSessions((workspace?.activeSessions ?? []).filter((session) => !session.explorationId));
		const openChangeTotal = plainSessions.reduce((sum, s) => sum + s.changes.filter(isOpenChange).length, 0);
		const key = JSON.stringify([
			"overview",
			surface.id,
			surface.archetype,
			look,
			state.mode,
			state.hiddenChanges,
			state.variantPick,
			state.busy,
			explorations,
			plainSessions,
		]);
		if (key === this.#shown) return;
		this.#shown = key;
		this.#sessionId = "";
		this.#messages = 0;

		const summaryParts: string[] = [];
		if (plainSessions.length === 1) summaryParts.push(t("1 agent"));
		else if (plainSessions.length > 1) summaryParts.push(t("{count} agents", { count: plainSessions.length }));
		if (openChangeTotal === 1) summaryParts.push(t("1 change ready"));
		else if (openChangeTotal > 1) summaryParts.push(t("{count} changes ready", { count: openChangeTotal }));

		this.#head.className = "surface-drawer-head is-overview";
		this.#head.replaceChildren(
			h(
				"div",
				{ class: "surface-drawer-title" },
				h("h2", null, surface.archetype === "ops" ? t("Agents") : t("Preview")),
				summaryParts.length > 0 ? h("p", null, summaryParts.join(" · ")) : null,
			),
			h(
				"button",
				{ type: "button", class: "icon-button", "aria-label": t("Close panel"), "data-act": "close-panel" },
				icon("close"),
			),
		);

		const parts: HTMLElement[] = [];
		if (workspace) {
			for (const exploration of explorations) {
				parts.push(this.#explorationCard(exploration, workspace));
			}
		}
		for (const session of plainSessions) {
			parts.push(this.#agentCard(session, surface, look));
		}
		if (parts.length === 0) {
			parts.push(
				h(
					"p",
					{ class: "surface-overview-empty" },
					t("No open changes yet. Describe a change below to start an agent."),
				),
			);
		}
		this.#crew.settle();
		this.#body.replaceChildren(...parts);
	}

	#explorationCard(exploration: SurfaceExplorationSet, workspace: SurfaceWorkspace): HTMLElement {
		const store = this.#store;
		const state = store.state;
		const variants = exploration.variantSessionIds
			.map((id) => workspace.activeSessions.find((session) => session.id === id))
			.filter((session): session is SurfaceSession => Boolean(session));
		const pickedId = store.pickedVariant(exploration);
		const picked = variants.find((item) => item.id === pickedId) ?? variants[0];
		const busy = Boolean(state.busy[`exploration:${exploration.id}`]);
		return h(
			"section",
			{ class: "surface-overview-card is-exploration", "data-exploration": exploration.id },
			h(
				"div",
				{ class: "surface-overview-card-head" },
				h("span", { class: "surface-state is-exploring", "aria-hidden": "true" }),
				h("strong", { class: "surface-overview-card-title" }, exploration.title),
			),
			h(
				"div",
				{ class: "surface-overview-options", role: "radiogroup", "aria-label": exploration.title },
				...variants.map((variant) => {
					const label = variant.explorationVariantLabel ?? variant.title;
					const checked = variant.id === picked?.id;
					return h(
						"button",
						{
							type: "button",
							class: `surface-overview-option${checked ? " is-picked" : ""}`,
							role: "radio",
							"aria-checked": String(checked),
							"data-act": "pick-variant",
							"data-exploration": exploration.id,
							"data-session": variant.id,
						},
						h("span", { class: "surface-radio", "aria-hidden": "true" }),
						h("span", { class: "surface-overview-option-label" }, label),
					);
				}),
			),
			picked
				? h(
						"div",
						{ class: "surface-overview-card-foot" },
						h(
							"button",
							{
								type: "button",
								class: "btn btn-small",
								disabled: busy,
								"data-act": "choose-variant",
								"data-exploration": exploration.id,
								"data-session": picked.id,
							},
							t("Approve {label}", { label: picked.explorationVariantLabel ?? picked.title }),
						),
					)
				: null,
		);
	}

	#agentCard(session: SurfaceSession, surface: SurfaceSummary, look: SurfaceLook): HTMLElement {
		const store = this.#store;
		const state = store.state;
		const running = isRunningSession(session);
		const listed = session.changes.filter((change) => change.status !== "discarded");
		const openChanges = listed.filter(isOpenChange);
		const actionSession =
			surface.archetype === "ops" ||
			(listed.length > 0 && listed.every((change) => isActionChange(change, surface)));
		const busyReconcile = Boolean(state.busy[`reconcile:${surface.id}`]);
		const attention = session.state === "needs_input" || hasConflictedChange(session);

		const head = h(
			"button",
			{
				type: "button",
				class: "surface-overview-agent-head",
				"data-act": "focus-session",
				"data-session": session.id,
				title: t("View responses"),
			},
			this.#crew.take(session, 30),
			h(
				"span",
				{ class: "surface-overview-agent-copy" },
				h("strong", null, session.title),
				h("span", null, agentStatusSummary(session, surface, look)),
			),
			h("span", { class: "surface-overview-agent-go", "aria-hidden": "true" }, icon("chevron")),
		);

		const bodyItems: HTMLElement[] = [];
		if (session.question) {
			bodyItems.push(
				h(
					"div",
					{ class: "surface-question is-compact" },
					h("p", null, session.question.text),
					h(
						"div",
						{ class: "surface-question-options" },
						session.question.options.map((option) =>
							h(
								"button",
								{
									type: "button",
									class: "btn btn-small",
									"data-act": "answer",
									"data-session": session.id,
									"data-answer": option,
								},
								option,
							),
						),
					),
				),
			);
		}
		if (actionSession && openChanges.length > 0) {
			const inbox = look.kind === "inbox";
			bodyItems.push(
				h(
					"div",
					{ class: "surface-overview-changes" },
					...openChanges.map((change) =>
						h(
							"div",
							{ class: "surface-overview-change" },
							h("span", { class: "surface-overview-change-title" }, change.title),
							!running
								? h(
										"button",
										{
											type: "button",
											class: "btn btn-small",
											disabled: Boolean(state.busy[`change:${change.id}`]),
											"data-act": "approve",
											"data-session": session.id,
											"data-change": change.id,
										},
										inbox ? t("Send") : t("Approve"),
									)
								: null,
						),
					),
				),
			);
		} else if (!actionSession && openChanges.length > 0) {
			bodyItems.push(
				h(
					"div",
					{ class: "surface-overview-changes" },
					...openChanges.map((change) => {
						const conflicted = change.status === "conflicted";
						const shown = store.isChangeShown(change.id);
						return h(
							"div",
							{ class: `surface-overview-change${conflicted ? " is-conflicted" : ""}` },
							h("button", {
								type: "button",
								class: "surface-switch",
								role: "switch",
								"aria-checked": String(shown),
								"aria-label": t("Show {title} in the preview", { title: change.title }),
								"data-act": "toggle",
								"data-change": change.id,
							}),
							h("span", { class: "surface-overview-change-title" }, change.title),
							conflicted && !running
								? h(
										"button",
										{
											type: "button",
											class: "surface-overview-act is-danger",
											disabled: busyReconcile,
											"data-act": "reconcile",
											"data-change": change.id,
										},
										t("Reconcile"),
									)
								: !running
									? h(
											"button",
											{
												type: "button",
												class: "surface-overview-act",
												disabled: Boolean(state.busy[`change:${change.id}`]),
												"data-act": "approve",
												"data-session": session.id,
												"data-change": change.id,
											},
											t("Approve"),
										)
									: null,
						);
					}),
				),
			);
		}

		return h(
			"section",
			{
				class: ["surface-overview-card", "is-agent", attention && "is-attention"].filter(Boolean).join(" "),
				"data-session": session.id,
			},
			head,
			...bodyItems,
		);
	}

	#renderFocused(session: SurfaceSession, surface: SurfaceSummary | undefined): void {
		const store = this.#store;
		const state = store.state;
		const notes = state.notes.filter((note) => note.sessionId === session.id);
		const resolvedSurface = surface ?? state.surfaces.find((item) => item.id === session.surfaceId);
		const look = resolvedSurface ? store.lookOf(resolvedSurface) : undefined;
		const key = JSON.stringify(["focused", session, notes, state.hiddenChanges, state.busy, look]);
		if (key === this.#shown) return;
		this.#shown = key;
		this.#input.placeholder = t("Steer this session…");
		this.#input.setAttribute("aria-label", t("Steer this session…"));
		this.#send.setAttribute("aria-label", t("Send"));
		this.#head.className = "surface-drawer-head";
		this.#head.replaceChildren(
			h(
				"button",
				{
					type: "button",
					class: "icon-button surface-drawer-back",
					"aria-label": t("All changes"),
					title: t("All changes"),
					"data-act": "back-overview",
				},
				icon("back"),
			),
			this.#crew.take(session, 36, "is-large"),
			h(
				"div",
				{ class: "surface-drawer-title" },
				h("h2", null, session.title),
				h(
					"p",
					null,
					[session.originLabel, fmtTime(session.createdAt)]
						.filter((part): part is string => Boolean(part))
						.join(" · "),
				),
			),
			h(
				"button",
				{ type: "button", class: "icon-button", "aria-label": t("Close session"), "data-act": "close" },
				icon("close"),
			),
		);
		this.#crew.settle();
		this.#body.replaceChildren(...this.#content(session, notes, resolvedSurface, look));
		const count = (session.messages.length || (session.prompt ? 1 : 0)) + notes.length;
		if (session.id !== this.#sessionId || count !== this.#messages) {
			this.#sessionId = session.id;
			this.#messages = count;
			this.#body.scrollTop = this.#body.scrollHeight;
		}
	}

	#content(
		session: SurfaceSession,
		notes: readonly { text: string }[],
		surface: SurfaceSummary | undefined,
		look: SurfaceLook | undefined,
	): HTMLElement[] {
		const store = this.#store;
		const parts: HTMLElement[] = [];
		const listed = session.changes.filter((change) => change.status !== "discarded");
		const actionSession = Boolean(
			surface &&
				(surface.archetype === "ops" ||
					(listed.length > 0 && listed.every((change) => isActionChange(change, surface)))),
		);
		if (isRunningSession(session) && session.state !== "needs_input")
			parts.push(
				h(
					"p",
					{ class: "surface-drawer-working" },
					actionSession
						? t("On it — you'll review everything here before anything goes out.")
						: t("Working — changes appear in Preview when they are ready."),
				),
			);
		if (sessionHeld(session))
			parts.push(
				h(
					"div",
					{ class: "surface-done" },
					h("span", { class: "surface-done-mark" }, icon("check")),
					h("strong", null, actionSession ? t("All done") : t("All changes merged")),
					h(
						"p",
						null,
						actionSession
							? t("Nothing else waits on you here.")
							: t("They are in Base. Publish when you're ready."),
					),
					h("button", { type: "button", class: "btn btn-primary btn-small", "data-act": "close" }, t("Close")),
				),
			);
		if (session.question)
			parts.push(
				h(
					"div",
					{ class: "surface-question" },
					h("p", null, session.question.text),
					h(
						"div",
						{ class: "surface-question-options" },
						session.question.options.map((option) =>
							h(
								"button",
								{ type: "button", class: "btn btn-small", "data-act": "answer", "data-answer": option },
								option,
							),
						),
					),
				),
			);
		if (actionSession && look && listed.length && !sessionHeld(session)) {
			const openActions = listed.filter(isOpenChange);
			for (const change of listed)
				parts.push(
					actionCard(
						change,
						look,
						openActions.length <= 1,
						Boolean(store.state.busy[`change:${change.id}`]),
						isRunningSession(session),
					),
				);
			if (openActions.length > 1 && !isRunningSession(session))
				parts.push(
					h(
						"div",
						{ class: "surface-drawer-actions" },
						h(
							"button",
							{ type: "button", class: "btn btn-primary btn-small", "data-act": "approve-all" },
							look.kind === "inbox"
								? t("Send all {count}", { count: openActions.length })
								: t("Approve all {count}", { count: openActions.length }),
						),
						h("button", { type: "button", class: "btn btn-small", "data-act": "discard" }, t("Discard")),
					),
				);
		} else if (listed.length && !sessionHeld(session)) {
			parts.push(
				h(
					"p",
					{ class: "surface-drawer-label" },
					listed.length === 1
						? t("1 change · toggle to preview")
						: t("{count} changes · toggle to preview", { count: listed.length }),
				),
			);
			const busyReconcile = Boolean(store.state.busy[`reconcile:${session.surfaceId}`]);
			for (const change of listed) {
				const open = isOpenChange(change);
				const conflicted = change.status === "conflicted";
				const shown = store.isChangeShown(change.id);
				const conflictPaths = change.conflictPaths?.length ? formatConflictPaths(change.conflictPaths) : "";
				parts.push(
					h(
						"div",
						{ class: `surface-drawer-change${open ? "" : " is-closed"}${conflicted ? " is-conflicted" : ""}` },
						open
							? h("button", {
									type: "button",
									class: "surface-switch",
									role: "switch",
									"aria-checked": String(shown),
									"aria-label": t("Show {title} in the preview", { title: change.title }),
									"data-act": "toggle",
									"data-change": change.id,
								})
							: h("span", { class: "surface-change-mark" }, icon("check")),
						h(
							"div",
							{ class: "surface-drawer-change-copy" },
							conflicted
								? h(
										"div",
										{ class: "surface-drawer-change-head" },
										h("strong", null, change.title),
										changeTag(change),
									)
								: h("strong", null, change.title),
							conflicted && conflictPaths
								? h(
										"small",
										{ class: "surface-conflict-paths", title: change.conflictPaths?.join(", ") },
										t("Conflicts in {paths}", { paths: conflictPaths }),
									)
								: null,
						),
						conflicted && !isRunningSession(session)
							? h(
									"button",
									{
										type: "button",
										class: "btn btn-small surface-btn-reconcile",
										"data-act": "reconcile",
										"data-change": change.id,
										disabled: busyReconcile,
									},
									t("Reconcile"),
								)
							: open && !conflicted && !isRunningSession(session)
								? h(
										"button",
										{
											type: "button",
											class: "btn btn-small",
											"data-act": "approve",
											"data-change": change.id,
											disabled: Boolean(store.state.busy[`change:${change.id}`]),
										},
										t("Approve"),
									)
								: conflicted
									? null
									: changeTag(change),
					),
				);
			}
			const open = session.changes.filter(isOpenChange).length;
			const conflictedCount = session.changes.filter((change) => change.status === "conflicted").length;
			if (!isRunningSession(session))
				parts.push(
					h(
						"div",
						{ class: "surface-drawer-actions" },
						conflictedCount > 1
							? h(
									"button",
									{
										type: "button",
										class: "btn btn-primary btn-small",
										"data-act": "reconcile-all",
										disabled: busyReconcile,
									},
									t("Reconcile all"),
								)
							: open > 1 && conflictedCount === 0
								? h(
										"button",
										{ type: "button", class: "btn btn-primary btn-small", "data-act": "approve-all" },
										t("Approve all {count}", { count: open }),
									)
								: null,
						open > 0
							? h("button", { type: "button", class: "btn btn-small", "data-act": "discard" }, t("Discard"))
							: null,
					),
				);
		}
		parts.push(h("div", { class: "surface-drawer-rule" }));
		if (session.messages.length > 0) {
			for (const message of session.messages) parts.push(messageRow(message));
		} else if (session.prompt) {
			parts.push(h("p", { class: "surface-message is-member" }, session.prompt));
		}
		for (const note of notes) parts.push(h("p", { class: "surface-message is-member is-pending" }, note.text));
		return parts;
	}

	#click(event: MouseEvent): void {
		const target = (event.target as Element).closest<HTMLElement>("[data-act]");
		if (!target) return;
		const store = this.#store;
		const drawer = store.state.drawer;
		const surfaceId = drawer?.surfaceId ?? this.#surfaceId;
		if (!surfaceId) return;
		const { act, change, answer, session, exploration } = target.dataset;
		const sessionId = session ?? drawer?.sessionId;
		switch (act) {
			case "close":
			case "close-panel":
				store.closePanel();
				return;
			case "back-overview":
				store.openPreviewPanel();
				return;
			case "focus-session":
				if (session) store.openDrawer(surfaceId, session);
				return;
			case "pick-variant":
				if (exploration && session) void store.pickVariant(surfaceId, exploration, session);
				return;
			case "choose-variant": {
				const workspace = store.workspace(surfaceId);
				const set = workspace?.explorations.find((item) => item.id === exploration);
				if (set && session) void store.chooseVariant(set, session);
				return;
			}
			case "toggle":
				if (change) void store.toggleChange(surfaceId, change);
				return;
			case "approve":
				if (sessionId && change) void store.approveChange(sessionId, change);
				return;
			case "approve-all":
				if (sessionId) void store.approveAll(sessionId);
				return;
			case "reconcile":
				if (change) void store.reconcileChanges(surfaceId, [change]);
				return;
			case "reconcile-all": {
				const current = sessionId ? store.session(sessionId) : undefined;
				const ids = current?.changes.filter((item) => item.status === "conflicted").map((item) => item.id) ?? [];
				if (ids.length) void store.reconcileChanges(surfaceId, ids);
				return;
			}
			case "discard":
				if (sessionId) void store.discardSession(sessionId);
				return;
			case "answer":
				if (sessionId && answer) void store.reply(sessionId, answer);
				return;
		}
	}
}
