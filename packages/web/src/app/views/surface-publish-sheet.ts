import type { SurfaceSummary } from "@qorpera/contracts";
import { SurfaceDialog } from "../../ui/dialog.ts";
import { fmtTime, h, icon } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import { type SurfacesStore, unpublishedChanges } from "../surfaces-store.ts";
import { surfaceTile } from "./surface-rail.ts";

function hostOf(url: string | null): string {
	if (!url) return "";
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

export function openPublishPatchnotesSheet(store: SurfacesStore, initialSurface: SurfaceSummary): SurfaceDialog {
	const surfaceId = initialSurface.id;
	let unsubscribe: (() => void) | undefined;
	const dialog = new SurfaceDialog(t("Patch notes"), "surface-sheet surface-publish-sheet", () => {
		unsubscribe?.();
		unsubscribe = undefined;
	});
	const body = h("div", { class: "surface-patchnotes-body" });
	const status = h("p", { class: "surface-sheet-status", role: "status" });
	let rollingBack: string | undefined;
	let publishing = false;

	const render = () => {
		const state = store.state;
		const surface = state.surfaces.find((item) => item.id === surfaceId) ?? initialSurface;
		const look = store.lookOf(surface);
		const entries = unpublishedChanges(state, surfaceId);
		const total = Math.max(entries.length, surface.unpublishedChangeCount);
		const host = hostOf(surface.liveUrl);
		const subtitle = host ? `${surface.title} · ${host}` : surface.title;

		const listNodes: HTMLElement[] =
			entries.length > 0
				? [
						h(
							"ul",
							{ class: "surface-patchnotes-list" },
							...entries.map(({ change, session, exploration }) => {
								const sourceLabel = exploration ? exploration.title : session.title;
								const busy =
									rollingBack === change.id || Boolean(state.busy[`undo:${change.id}`]) || publishing;
								const stamp = fmtTime(change.resolvedAt ?? change.createdAt);
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
											},
											icon("reset"),
											h("span", null, t("Rollback")),
										),
									),
									change.summary ? h("p", { class: "surface-patchnote-summary" }, change.summary) : null,
									h(
										"div",
										{ class: "surface-patchnote-meta" },
										h("span", { class: "surface-patchnote-source" }, sourceLabel),
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

		const cancelBtn = h(
			"button",
			{ type: "button", class: "btn", disabled: publishing, "data-act": "cancel" },
			t("Cancel"),
		);
		const publishLabel = publishing
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
				disabled: publishing || total === 0,
				"data-act": "confirm-publish",
			},
			publishLabel,
		);

		body.replaceChildren(
			h(
				"div",
				{ class: "surface-patchnotes-head" },
				surfaceTile(surface, look, 22, "is-sheet"),
				h("div", { class: "surface-patchnotes-heading" }, h("h2", null, t("Patch notes")), h("p", null, subtitle)),
				total > 0
					? h(
							"span",
							{ class: "surface-patchnotes-badge" },
							total === 1 ? t("1 change") : t("{count} changes", { count: total }),
						)
					: null,
			),
			h(
				"p",
				{ class: "surface-sheet-lead" },
				total > 0
					? t("Review everything approved into Base. Roll back any change before going live.")
					: t("Live matches Base"),
			),
			...listNodes,
			h("div", { class: "surface-sheet-actions" }, status, cancelBtn, publishBtn),
		);
	};

	body.addEventListener("click", (event) => {
		const target = (event.target as Element).closest<HTMLElement>("[data-act]");
		if (!target) return;
		const { act, change } = target.dataset;
		if (act === "cancel") {
			dialog.close();
			return;
		}
		if (act === "rollback" && change) {
			rollingBack = change;
			status.textContent = "";
			render();
			void store.rollbackChange(change).then((ok) => {
				rollingBack = undefined;
				if (!ok) status.textContent = store.state.error ?? t("That didn't work. Try again.");
				render();
			});
			return;
		}
		if (act === "confirm-publish") {
			publishing = true;
			status.textContent = t("Publishing…");
			render();
			void store.publish(surfaceId).then((ok) => {
				publishing = false;
				if (ok) dialog.close();
				else {
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
