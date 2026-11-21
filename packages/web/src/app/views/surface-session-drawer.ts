import type { SurfaceChangeUnit, SurfaceSession, SurfaceSessionMessage } from "@qorpera/contracts";
import { fmtTime, h, icon } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import {
	formatConflictPaths,
	isOpenChange,
	isRunningSession,
	type SurfacesStore,
	sessionHeld,
} from "../surfaces-store.ts";
import { sessionStatus } from "./surface-rail.ts";

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

function diffLine(change: SurfaceChangeUnit): string {
	const stats = change.diffStats;
	if (!stats) return "";
	return stats.filesChanged === 1
		? t("1 file · +{added} −{removed}", { added: stats.additions, removed: stats.deletions })
		: t("{files} files · +{added} −{removed}", {
				files: stats.filesChanged,
				added: stats.additions,
				removed: stats.deletions,
			});
}

export class SurfaceSessionDrawer {
	readonly el = h("aside", { class: "surface-drawer", "aria-hidden": "true" });
	readonly #head = h("div", { class: "surface-drawer-head" });
	readonly #body = h("div", { class: "surface-drawer-body" });
	readonly #input = h("input", { class: "surface-drawer-input", autocomplete: "off" });
	readonly #send = h("button", { type: "submit", class: "surface-send is-ready" }, icon("send"));
	readonly #form = h("form", { class: "surface-drawer-foot" }, this.#input, this.#send);
	readonly #store: SurfacesStore;
	#shown = "";
	#sessionId = "";
	#messages = 0;

	constructor(store: SurfacesStore, signal: AbortSignal) {
		this.#store = store;
		this.el.append(this.#head, this.#body, this.#form);
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

	update(): void {
		const state = this.#store.state;
		const session = state.drawer ? this.#store.session(state.drawer.sessionId) : undefined;
		this.el.classList.toggle("is-open", Boolean(session));
		this.el.setAttribute("aria-hidden", String(!session));
		this.el.inert = !session;
		if (!session) {
			this.#shown = "";
			this.#sessionId = "";
			this.#messages = 0;
			return;
		}
		const notes = state.notes.filter((note) => note.sessionId === session.id);
		const key = JSON.stringify([session, notes, state.hiddenChanges, state.busy]);
		if (key === this.#shown) return;
		this.#shown = key;
		this.#input.placeholder = t("Steer this session…");
		this.#input.setAttribute("aria-label", t("Steer this session…"));
		this.#send.setAttribute("aria-label", t("Send"));
		this.#head.replaceChildren(
			sessionStatus(session),
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
		this.#body.replaceChildren(...this.#content(session, notes));
		const count = (session.messages.length || (session.prompt ? 1 : 0)) + notes.length;
		if (session.id !== this.#sessionId || count !== this.#messages) {
			this.#sessionId = session.id;
			this.#messages = count;
			this.#body.scrollTop = this.#body.scrollHeight;
		}
	}

	#content(session: SurfaceSession, notes: readonly { text: string }[]): HTMLElement[] {
		const store = this.#store;
		const parts: HTMLElement[] = [];
		if (isRunningSession(session) && session.state !== "needs_input")
			parts.push(
				h(
					"p",
					{ class: "surface-drawer-working" },
					h("span", { class: "surface-state is-running" }),
					t("Working — changes appear in Preview when they are ready."),
				),
			);
		if (sessionHeld(session))
			parts.push(
				h(
					"div",
					{ class: "surface-done" },
					h("span", { class: "surface-done-mark" }, icon("check")),
					h("strong", null, t("All changes merged")),
					h("p", null, t("They are in Base. Publish when you're ready.")),
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
		const listed = session.changes.filter((change) => change.status !== "discarded");
		if (listed.length && !sessionHeld(session)) {
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
							change.summary ? h("span", null, change.summary) : null,
							conflicted && conflictPaths
								? h(
										"small",
										{ class: "surface-conflict-paths", title: change.conflictPaths?.join(", ") },
										t("Conflicts in {paths}", { paths: conflictPaths }),
									)
								: null,
							diffLine(change) ? h("small", null, diffLine(change)) : null,
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
		if (!drawer) return;
		const { act, change, answer } = target.dataset;
		switch (act) {
			case "close":
				store.closeDrawer();
				return;
			case "toggle":
				if (change) void store.toggleChange(drawer.surfaceId, change);
				return;
			case "approve":
				if (change) void store.approveChange(drawer.sessionId, change);
				return;
			case "approve-all":
				void store.approveAll(drawer.sessionId);
				return;
			case "reconcile":
				if (change) void store.reconcileChanges(drawer.surfaceId, [change]);
				return;
			case "reconcile-all": {
				const session = store.session(drawer.sessionId);
				const ids = session?.changes.filter((item) => item.status === "conflicted").map((item) => item.id) ?? [];
				if (ids.length) void store.reconcileChanges(drawer.surfaceId, ids);
				return;
			}
			case "discard":
				void store.discardSession(drawer.sessionId);
				return;
			case "answer":
				if (answer) void store.reply(drawer.sessionId, answer);
				return;
		}
	}
}
