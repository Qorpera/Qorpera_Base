import type { SurfaceSummary } from "@qorpera/contracts";
import { SurfaceDialog } from "../../ui/dialog.ts";
import { h, icon, personAvatar } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import { askedToPublish, type SurfacesStore, unpublishedChanges } from "../surfaces-store.ts";
import { publishFailureText } from "./surface-door.ts";
import { surfaceTile } from "./surface-rail.ts";

export function firstName(name: string): string {
	return name.trim().split(/\s+/)[0] || name;
}

function hostOf(url: string | null): string {
	if (!url) return "";
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

export function openPublishSheet(store: SurfacesStore, initialSurface: SurfaceSummary): SurfaceDialog {
	const surfaceId = initialSurface.id;
	let unsubscribe: (() => void) | undefined;
	let closed = false;
	const dialog = new SurfaceDialog(t("Publish"), "surface-sheet surface-publish-sheet", () => {
		closed = true;
		unsubscribe?.();
		unsubscribe = undefined;
	});
	const body = h("div", { class: "surface-publish-body" });
	const status = h("p", { class: "surface-sheet-status", role: "status" });
	const rollingBack = new Set<string>();
	let publishing = false;
	let choosing = false;
	let awaitingAsyncPublish = false;
	let lastRenderKey: string | undefined;

	const currentSurface = (): SurfaceSummary =>
		store.state.surfaces.find((item) => item.id === surfaceId) ?? initialSurface;

	const render = () => {
		if (closed) return;
		const state = store.state;
		const surface = currentSurface();
		if (awaitingAsyncPublish) {
			if (
				surface.publishStatus === "idle" ||
				(surface.publishStatus === undefined && !surface.hasUnpublishedChanges)
			) {
				awaitingAsyncPublish = false;
				dialog.close();
				return;
			}
			if (surface.publishStatus === "failed") awaitingAsyncPublish = false;
		}
		const look = store.lookOf(surface);
		const entries = unpublishedChanges(state, surfaceId);
		const total = Math.max(entries.length, surface.unpublishedChangeCount);
		const host = hostOf(surface.liveUrl?.trim() || null);

		const me = store.userId;
		const ask = surface.publishAsk ?? null;
		const askedMe = askedToPublish(surface, me);
		const myAsk = ask && ask.askedByUserId === me ? ask : null;
		const teammates = store.publishTeammates();
		const askBusy = Boolean(state.busy[`publish-ask:${surface.id}`]);
		const nameOf = (userId: string) => store.memberName(userId) ?? t("A teammate");

		const publishError =
			surface.publishStatus === "failed"
				? publishFailureText(surface.lastPublishError) ||
					surface.lastPublishError?.trim() ||
					t("The last publish failed. Try again.")
				: "";

		const renderKey = JSON.stringify([
			surface.title,
			surface.unpublishedChangeCount,
			surface.publishStatus ?? "",
			publishError,
			host,
			look.kind,
			look.accent ?? "",
			publishing,
			awaitingAsyncPublish,
			status.textContent ?? "",
			ask,
			me ?? "",
			teammates,
			surface.autoPublish,
			askBusy,
			choosing,
			entries.map(({ change }) => [
				change.id,
				change.title,
				change.summary ?? "",
				store.memberName(change.approvedByUserId) ?? "",
				change.undoBatchSize ?? 1,
				rollingBack.has(change.id) || Boolean(state.busy[`undo:${change.id}`]),
			]),
		]);
		if (renderKey === lastRenderKey) return;
		lastRenderKey = renderKey;

		const list =
			entries.length > 0
				? h(
						"ul",
						{ class: "surface-publish-changes" },
						...entries.map(({ change }) => {
							const approver =
								change.approvedByUserId && change.approvedByUserId !== me
									? store.memberName(change.approvedByUserId)
									: undefined;
							const busy = rollingBack.has(change.id) || Boolean(state.busy[`undo:${change.id}`]) || publishing;
							const together =
								change.kind === "folder_patch" || change.kind === "git_range" ? (change.undoBatchSize ?? 1) : 1;
							return h(
								"li",
								{ class: "surface-publish-change", "data-change": change.id },
								h(
									"div",
									{ class: "surface-publish-change-top" },
									h("strong", null, change.title),
									h(
										"button",
										{
											type: "button",
											class: "surface-publish-undo",
											disabled: busy,
											"data-act": "rollback",
											"data-change": change.id,
											...(together > 1
												? { title: t("They were approved together, so they are undone together.") }
												: {}),
										},
										icon("reset"),
										h(
											"span",
											null,
											together === 2
												? t("Undo with 1 other")
												: together > 2
													? t("Undo with {count} others", { count: together - 1 })
													: t("Undo"),
										),
									),
								),
								change.summary ? h("p", null, change.summary) : null,
								approver
									? h(
											"p",
											{ class: "surface-publish-change-by" },
											t("Approved by {name}", { name: firstName(approver) }),
										)
									: null,
							);
						}),
					)
				: null;

		const publishInProgress = publishing || surface.publishStatus === "publishing";
		const askLine = (userId: string, text: string, ...actions: HTMLElement[]) =>
			h(
				"div",
				{ class: "surface-publish-ask-line" },
				personAvatar(nameOf(userId), userId),
				h("span", { class: "surface-publish-ask-text" }, text),
				...actions,
			);
		const askNote = askedMe
			? askLine(
					ask!.askedByUserId,
					t("{name} asks you to publish.", { name: firstName(nameOf(ask!.askedByUserId)) }),
				)
			: myAsk?.status === "declined"
				? askLine(
						myAsk.askedUserId,
						t("{name} said no.", { name: firstName(nameOf(myAsk.askedUserId)) }),
						h(
							"button",
							{
								type: "button",
								class: "surface-publish-ask-act",
								disabled: askBusy,
								"data-act": "withdraw-ask",
							},
							t("OK"),
						),
					)
				: myAsk
					? askLine(
							myAsk.askedUserId,
							t("Waiting for {name}.", { name: firstName(nameOf(myAsk.askedUserId)) }),
							h(
								"button",
								{
									type: "button",
									class: "surface-publish-ask-act",
									disabled: askBusy,
									"data-act": "withdraw-ask",
								},
								t("Take back"),
							),
						)
					: ask?.status === "open"
						? askLine(
								ask.askedUserId,
								t("{asker} asked {name} to publish.", {
									asker: firstName(nameOf(ask.askedByUserId)),
									name: firstName(nameOf(ask.askedUserId)),
								}),
							)
						: null;
		const canAsk =
			!askedMe &&
			ask?.status !== "open" &&
			!surface.autoPublish &&
			total > 0 &&
			!publishInProgress &&
			teammates.length > 0;
		const only = teammates.length === 1 ? teammates[0]! : null;
		const askBtn = canAsk
			? only
				? h(
						"button",
						{
							type: "button",
							class: "btn surface-publish-ask-btn",
							disabled: askBusy,
							"data-act": "ask",
							"data-user": only.userId,
						},
						personAvatar(only.name, only.userId),
						t("Ask {name}", { name: firstName(only.name) }),
					)
				: h(
						"button",
						{
							type: "button",
							class: "btn surface-publish-ask-btn",
							disabled: askBusy,
							"aria-expanded": String(choosing),
							"data-act": "ask-menu",
						},
						t("Ask a teammate"),
					)
			: null;
		const picker =
			canAsk && !only && choosing
				? h(
						"div",
						{ class: "surface-publish-ask-pick", role: "group", "aria-label": t("Ask a teammate") },
						...teammates.map((person) =>
							h(
								"button",
								{
									type: "button",
									class: "surface-publish-ask-person",
									disabled: askBusy,
									"data-act": "ask",
									"data-user": person.userId,
								},
								personAvatar(person.name, person.userId),
								h("span", null, person.name),
							),
						),
					)
				: null;
		const declineBtn = askedMe
			? h(
					"button",
					{ type: "button", class: "btn", disabled: askBusy || publishing, "data-act": "decline-ask" },
					t("No"),
				)
			: null;
		const lastBtn =
			total > 0 || publishInProgress
				? h(
						"button",
						{
							type: "button",
							class: "btn btn-primary",
							disabled: publishInProgress,
							"data-act": "confirm-publish",
						},
						publishInProgress ? t("Publishing…") : t("Publish"),
					)
				: h("button", { type: "button", class: "btn btn-primary", "data-act": "cancel" }, t("Done"));

		body.replaceChildren(
			h(
				"div",
				{ class: "surface-publish-head" },
				surfaceTile(surface, look, "is-sheet"),
				h(
					"div",
					{ class: "surface-publish-heading" },
					h(
						"h2",
						null,
						total === 1
							? t("Publish 1 change?")
							: total > 1
								? t("Publish {count} changes?", { count: total })
								: t("Nothing to publish"),
					),
					h("p", null, host ? `${surface.title} · ${host}` : surface.title),
				),
			),
			...(publishError ? [h("p", { class: "surface-sheet-error", role: "alert" }, publishError)] : []),
			...(list ? [list] : []),
			...(askNote ? [askNote] : []),
			...(picker ? [picker] : []),
			h("div", { class: "surface-sheet-actions" }, status, declineBtn, askBtn, lastBtn),
		);
	};

	const runAsk = async (pending: Promise<boolean>): Promise<boolean> => {
		status.textContent = "";
		const ok = await pending;
		if (!closed && !ok) {
			status.textContent = store.state.error ?? t("That didn't work. Try again.");
			render();
		}
		return ok;
	};

	body.addEventListener("click", (event) => {
		const target = (event.target as Element).closest<HTMLElement>("[data-act]");
		if (!target) return;
		const { act, change } = target.dataset;
		if (act === "cancel") {
			dialog.close();
			return;
		}
		if (act === "ask" && target.dataset.user) {
			choosing = false;
			void runAsk(store.askToPublish(surfaceId, target.dataset.user));
			return;
		}
		if (act === "ask-menu") {
			choosing = !choosing;
			render();
			body.querySelector<HTMLElement>(choosing ? ".surface-publish-ask-person" : '[data-act="ask-menu"]')?.focus();
			return;
		}
		if (act === "withdraw-ask") {
			void runAsk(store.withdrawPublishAsk(surfaceId));
			return;
		}
		if (act === "decline-ask") {
			void runAsk(store.declinePublishAsk(surfaceId)).then((ok) => {
				if (ok) dialog.close();
			});
			return;
		}
		if (act === "rollback" && change) {
			if (rollingBack.has(change) || publishing) return;
			rollingBack.add(change);
			status.textContent = "";
			render();
			void store.rollbackChange(change).then((ok) => {
				rollingBack.delete(change);
				if (closed) return;
				if (!ok) status.textContent = store.state.error ?? t("That didn't work. Try again.");
				render();
			});
			return;
		}
		if (act === "confirm-publish") {
			if (publishing) return;
			publishing = true;
			status.textContent = "";
			render();
			void store.publish(surfaceId).then((ok) => {
				publishing = false;
				if (closed) return;
				if (ok) {
					if (currentSurface().publishStatus === "publishing") {
						awaitingAsyncPublish = true;
						render();
					} else {
						dialog.close();
					}
				} else {
					status.textContent = store.state.error ?? t("That didn't work. Try again.");
					render();
				}
			});
		}
	});

	dialog.content.append(body);
	render();
	unsubscribe = store.store.subscribe(render);
	dialog.open();
	return dialog;
}
