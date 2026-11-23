import type { SurfaceSummary } from "@qorpera/contracts";
import { SurfaceDialog } from "../../ui/dialog.ts";
import { fmtTime, h, icon, personAvatar } from "../../ui/dom.ts";
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

async function copyToClipboard(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		return false;
	}
	return false;
}

export interface PublishPatchnotesOptions {
	readonly loadSitePassword?: (surface: SurfaceSummary) => Promise<string | null>;
}

export function openPublishPatchnotesSheet(
	store: SurfacesStore,
	initialSurface: SurfaceSummary,
	options: PublishPatchnotesOptions = {},
): SurfaceDialog {
	const surfaceId = initialSurface.id;
	let unsubscribe: (() => void) | undefined;
	let closed = false;
	let copiedTimer: ReturnType<typeof setTimeout> | undefined;
	let copiedKind: "link" | "password" | undefined;
	let sitePassword: string | null = null;
	let passwordLoadedFor = "";
	const dialog = new SurfaceDialog(t("Patch notes"), "surface-sheet surface-publish-sheet", () => {
		closed = true;
		if (copiedTimer) {
			clearTimeout(copiedTimer);
			copiedTimer = undefined;
		}
		unsubscribe?.();
		unsubscribe = undefined;
	});
	const body = h("div", { class: "surface-patchnotes-body" });
	const status = h("p", { class: "surface-sheet-status", role: "status" });
	const rollingBack = new Set<string>();
	let publishing = false;
	let choosing = false;
	let awaitingAsyncPublish = false;
	let lastRenderKey: string | undefined;

	const currentSurface = (): SurfaceSummary =>
		store.state.surfaces.find((item) => item.id === surfaceId) ?? initialSurface;

	const markCopied = (kind: "link" | "password") => {
		if (closed) return;
		copiedKind = kind;
		if (copiedTimer) clearTimeout(copiedTimer);
		copiedTimer = setTimeout(() => {
			copiedTimer = undefined;
			copiedKind = undefined;
			if (!closed) render();
		}, 2_000);
		render();
	};

	const ensurePasswordLoaded = (surface: SurfaceSummary) => {
		const liveUrl = surface.liveUrl?.trim() || "";
		if (!liveUrl || !options.loadSitePassword) return;
		const key = `${surface.id}:${surface.siteSlug ?? ""}:${liveUrl}`;
		if (key === passwordLoadedFor) return;
		passwordLoadedFor = key;
		void Promise.resolve(options.loadSitePassword(surface))
			.then((password) => {
				if (closed || key !== passwordLoadedFor) return;
				const next = password?.trim() || null;
				if (next !== sitePassword) {
					sitePassword = next;
					render();
				}
			})
			.catch(() => {
				/* WHY: Missing site password permissions gracefully omit the copy-password button. */
			});
	};

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
			if (surface.publishStatus === "failed") {
				awaitingAsyncPublish = false;
				status.textContent =
					publishFailureText(surface.lastPublishError) ??
					surface.lastPublishError ??
					t("Publish failed. Try again.");
			}
		}
		const look = store.lookOf(surface);
		const entries = unpublishedChanges(state, surfaceId);
		const total = Math.max(entries.length, surface.unpublishedChangeCount);
		const liveUrl = surface.liveUrl?.trim() || "";
		const host = hostOf(liveUrl || null);
		const subtitle = host ? `${surface.title} · ${host}` : surface.title;
		ensurePasswordLoaded(surface);

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
			liveUrl,
			look.kind,
			look.accent ?? "",
			sitePassword ?? "",
			copiedKind ?? "",
			publishing,
			awaitingAsyncPublish,
			status.textContent ?? "",
			ask,
			me ?? "",
			teammates,
			surface.autoPublish,
			askBusy,
			choosing,
			entries.map(({ change, session, exploration }) => [
				change.id,
				change.title,
				change.summary ?? "",
				change.resolvedAt ?? change.createdAt,
				change.approvedByUserId ?? "",
				change.undoBatchSize ?? 1,
				exploration?.title ?? session.title,
				rollingBack.has(change.id) || Boolean(state.busy[`undo:${change.id}`]),
			]),
		]);
		if (renderKey === lastRenderKey) return;
		lastRenderKey = renderKey;

		const shareBar = liveUrl
			? h(
					"div",
					{ class: "surface-share-bar" },
					h(
						"div",
						{ class: "surface-share-copy" },
						h("span", { class: "surface-share-label" }, t("Share live link")),
						h("span", { class: "surface-share-url", title: liveUrl }, liveUrl),
					),
					h(
						"div",
						{ class: "surface-share-actions" },
						h(
							"button",
							{
								type: "button",
								class: `surface-share-btn${copiedKind === "link" ? " is-copied" : ""}`,
								"data-act": "copy-link",
							},
							icon(copiedKind === "link" ? "check" : "copy"),
							h("span", null, copiedKind === "link" ? t("Copied") : t("Copy link")),
						),
						sitePassword
							? h(
									"button",
									{
										type: "button",
										class: `surface-share-btn${copiedKind === "password" ? " is-copied" : ""}`,
										"data-act": "copy-password",
									},
									icon(copiedKind === "password" ? "check" : "key"),
									h("span", null, copiedKind === "password" ? t("Copied") : t("Copy password")),
								)
							: null,
						h(
							"a",
							{
								class: "surface-share-btn is-open",
								href: liveUrl,
								target: "_blank",
								rel: "noopener noreferrer",
							},
							h("span", null, t("Open")),
							icon("external"),
						),
					),
				)
			: null;

		const listNodes: HTMLElement[] =
			entries.length > 0
				? [
						h(
							"ul",
							{ class: "surface-patchnotes-list" },
							...entries.map(({ change, session, exploration }) => {
								const sourceLabel = exploration ? exploration.title : session.title;
								const approver = store.memberName(change.approvedByUserId);
								const busy =
									rollingBack.has(change.id) || Boolean(state.busy[`undo:${change.id}`]) || publishing;
								const stamp = fmtTime(change.resolvedAt ?? change.createdAt);
								const batchSize =
									change.kind === "folder_patch" || change.kind === "git_range"
										? (change.undoBatchSize ?? 1)
										: 1;
								return h(
									"li",
									{ class: "surface-patchnote-item", "data-change": change.id },
									h(
										"div",
										{ class: "surface-patchnote-top" },
										h("span", { class: "surface-patchnote-dot", "aria-hidden": "true" }),
										h("strong", { class: "surface-patchnote-title" }, change.title),
										h(
											"button",
											{
												type: "button",
												class: "surface-patchnote-rollback",
												disabled: busy,
												"data-act": "rollback",
												"data-change": change.id,
												...(batchSize > 1
													? {
															title: t("Rolls back all {count} changes landed together in this batch", {
																count: batchSize,
															}),
														}
													: {}),
											},
											icon("reset"),
											h(
												"span",
												null,
												batchSize > 1 ? t("Rollback batch ({count})", { count: batchSize }) : t("Rollback"),
											),
										),
									),
									change.summary ? h("p", { class: "surface-patchnote-summary" }, change.summary) : null,
									h(
										"div",
										{ class: "surface-patchnote-meta" },
										h("span", { class: "surface-patchnote-source" }, sourceLabel),
										approver
											? h(
													"span",
													{ class: "surface-patchnote-approver" },
													t("Approved by {name}", { name: approver }),
												)
											: null,
										stamp ? h("time", { datetime: change.resolvedAt ?? change.createdAt }, stamp) : null,
									),
								);
							}),
						),
					]
				: total > 0
					? [
							h(
								"p",
								{ class: "surface-patchnotes-empty" },
								total === 1
									? t("1 approved change in Base is ready to publish.")
									: t("{count} approved changes in Base are ready to publish.", { count: total }),
							),
						]
					: [h("p", { class: "surface-patchnotes-empty" }, t("No unpublished changes in Base right now."))];

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
		const cancelBtn = h(
			"button",
			{ type: "button", class: "btn", disabled: publishing, "data-act": "cancel" },
			surface.publishStatus === "publishing" ? t("Close") : t("Cancel"),
		);
		const publishLabel = publishInProgress
			? t("Publishing…")
			: total === 1
				? t("Publish 1 change")
				: total > 1
					? t("Publish {count} changes", { count: total })
					: t("Publish");
		const publishBtn = h(
			"button",
			{
				type: "button",
				class: "btn btn-primary",
				disabled: publishInProgress || total === 0,
				"data-act": "confirm-publish",
			},
			publishLabel,
		);

		body.replaceChildren(
			h(
				"div",
				{ class: "surface-patchnotes-head" },
				surfaceTile(surface, look, "is-sheet"),
				h("div", { class: "surface-patchnotes-heading" }, h("h2", null, t("Patch notes")), h("p", null, subtitle)),
				total > 0
					? h(
							"span",
							{ class: "surface-patchnotes-badge" },
							total === 1 ? t("1 change") : t("{count} changes", { count: total }),
						)
					: null,
			),
			...(shareBar ? [shareBar] : []),
			...(publishError ? [h("p", { class: "surface-sheet-error", role: "alert" }, publishError)] : []),
			h(
				"p",
				{ class: "surface-sheet-lead" },
				total > 0
					? t("Review everything approved into Base. Roll back any change before going live.")
					: t("Live matches Base"),
			),
			...listNodes,
			...(askNote ? [askNote] : []),
			...(picker ? [picker] : []),
			h("div", { class: "surface-sheet-actions" }, status, cancelBtn, declineBtn, askBtn, publishBtn),
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
		if (act === "copy-link") {
			const liveUrl = currentSurface().liveUrl?.trim() || "";
			if (!liveUrl) return;
			void copyToClipboard(liveUrl).then((ok) => {
				if (ok) markCopied("link");
			});
			return;
		}
		if (act === "copy-password") {
			if (!sitePassword) return;
			void copyToClipboard(sitePassword).then((ok) => {
				if (ok) markCopied("password");
			});
			return;
		}
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
			status.textContent = t("Publishing…");
			render();
			void store.publish(surfaceId).then((ok) => {
				publishing = false;
				if (closed) return;
				if (ok) {
					if (currentSurface().publishStatus === "publishing") {
						awaitingAsyncPublish = true;
						status.textContent = t("Publishing…");
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
