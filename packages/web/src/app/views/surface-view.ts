import type { SurfacePreviewFrameState, SurfaceSummary } from "@qorpera/contracts";
import { openContextMenu } from "../../ui/context-menu.ts";
import { growToText, h, icon } from "../../ui/dom.ts";
import { interfaceEmblem } from "../../ui/interface-emblem.ts";
import { t } from "../../ui/preferences.ts";
import {
	migrationPending,
	openExplorations,
	runningSessionTotal,
	type SurfacePreviewMode,
	type SurfacesStore,
	surfaceBySlug,
} from "../surfaces-store.ts";
import { surfaceEmblem } from "./surface-rail.ts";
import { SurfaceSessionDrawer } from "./surface-session-drawer.ts";

export interface SurfaceMount {
	readonly el: HTMLElement;
	update(): void;
	dispose(): void;
}

export interface SurfaceViewHost {
	readonly store: SurfacesStore;
	mount(surface: SurfaceSummary, signal: AbortSignal): SurfaceMount | undefined;
	openMigration(): void;
}

function hostOf(url: string | null): string {
	if (!url) return "";
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

function previewStatusText(frame: SurfacePreviewFrameState): string {
	switch (frame.status) {
		case "composing":
			return t("Composing preview…");
		case "building":
			return t("Building preview…");
		case "conflicted":
			return t("These changes conflict. Turn one off to preview the rest.");
		case "failed":
			return frame.errorDetail ?? t("The preview could not be built.");
		default:
			return "";
	}
}

function frameOf(frame: SurfacePreviewFrameState, title: string): HTMLElement {
	if (frame.status === "ready" && frame.doorActionUrl)
		return h("iframe", {
			class: "surface-frame",
			src: frame.doorActionUrl,
			title,
			referrerpolicy: "no-referrer",
		});
	return h(
		"div",
		{ class: "surface-frame is-waiting" },
		h("span", { class: "surface-state is-running" }),
		h("p", null, previewStatusText(frame) || t("Preview appears here when a change is ready.")),
	);
}

export class SurfaceView {
	readonly el = h("section", { class: "page surface-page" });
	readonly slug: string;
	readonly #host: SurfaceViewHost;
	readonly #lifetime = new AbortController();
	readonly #bar = h("header", { class: "surface-bar" });
	readonly #stage = h("div", { class: "surface-stage" });
	readonly #viewport = h("div", { class: "surface-viewport" });
	readonly #mountSlot = h("div", { class: "surface-mount" });
	readonly #frames = h("div", { class: "surface-frames", hidden: true });
	readonly #banner = h("div", { class: "surface-banners" });
	readonly #chips = h("div", { class: "surface-chips" });
	readonly #input = h("textarea", { class: "surface-input", rows: 1 });
	readonly #send = h("button", { type: "submit", class: "surface-send" }, icon("send"));
	readonly #composer = h(
		"form",
		{ class: "surface-composer" },
		this.#chips,
		h("div", { class: "surface-composer-shell" }, this.#input, this.#send),
	);
	readonly #toast = h("div", { class: "surface-toast-host", role: "status" });
	readonly #drawer: SurfaceSessionDrawer;
	#mount: SurfaceMount | undefined;
	#mountedFor = "";
	#barShown = "";
	#framesShown = "";
	#chromeShown = "";
	#toastShown: number | undefined;

	constructor(host: SurfaceViewHost, slug: string) {
		this.#host = host;
		this.slug = slug;
		const signal = this.#lifetime.signal;
		this.#drawer = new SurfaceSessionDrawer(host.store, signal);
		this.#viewport.append(this.#mountSlot, this.#frames);
		this.#stage.append(this.#viewport, this.#banner, this.#composer, this.#drawer.el, this.#toast);
		this.el.append(this.#bar, this.#stage);
		this.#composer.addEventListener(
			"submit",
			(event) => {
				event.preventDefault();
				void this.#submit();
			},
			{ signal },
		);
		this.#input.addEventListener(
			"input",
			() => {
				growToText(this.#input);
				this.#send.classList.toggle("is-ready", this.#input.value.trim().length > 0);
			},
			{ signal },
		);
		this.#input.addEventListener(
			"keydown",
			(event) => {
				if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
					event.preventDefault();
					void this.#submit();
				}
			},
			{ signal },
		);
		this.el.addEventListener("click", (event) => this.#click(event), { signal });
		void host.store.openSurface(slug);
	}

	get surface(): SurfaceSummary | undefined {
		return surfaceBySlug(this.#host.store.state, this.slug);
	}

	focus(): void {
		if (!this.#input.disabled) this.#input.focus({ preventScroll: true });
	}

	dispose(): void {
		this.#lifetime.abort();
		this.#mount?.dispose();
		this.#mount = undefined;
		this.#host.store.closeDrawer();
	}

	update(): void {
		const store = this.#host.store;
		const state = store.state;
		const surface = this.surface;
		if (!surface) {
			this.#bar.replaceChildren();
			this.#mountSlot.replaceChildren(
				h(
					"div",
					{ class: "surface-empty" },
					h("p", null, state.source === "loading" ? t("Opening surface…") : t("This surface isn't available.")),
				),
			);
			return;
		}
		this.#drawBar(surface);
		this.#drawMount(surface);
		this.#drawFrames(surface);
		this.#drawChrome(surface);
		this.#drawer.update();
		this.#drawToast();
		this.el.classList.toggle("has-drawer", Boolean(state.drawer));
		this.#viewport.dataset.device = surface.archetype === "live_build" ? state.device : "desktop";
	}

	#drawBar(surface: SurfaceSummary): void {
		const state = this.#host.store.state;
		const workspace = state.workspaces[surface.id];
		const explorations = openExplorations(workspace);
		const key = JSON.stringify([
			surface,
			state.mode,
			state.device,
			explorations.length,
			Boolean(state.busy[`publish:${surface.id}`]),
		]);
		if (key === this.#barShown) return;
		this.#barShown = key;
		const live = surface.archetype === "live_build";
		const seg = (mode: SurfacePreviewMode, label: string, title: string, disabled = false) =>
			h(
				"button",
				{
					type: "button",
					class: state.mode === mode ? "is-on" : "",
					"aria-pressed": String(state.mode === mode),
					title,
					disabled,
					"data-act": "mode",
					"data-mode": mode,
				},
				label,
			);
		const count = surface.unpublishedChangeCount;
		this.#bar.replaceChildren(
			h(
				"div",
				{ class: "surface-bar-lead" },
				interfaceEmblem(surfaceEmblem(surface), 18),
				h("h1", { class: "surface-title" }, surface.title),
				surface.liveUrl
					? h(
							"a",
							{ class: "surface-sub", href: surface.liveUrl, target: "_blank", rel: "noopener" },
							h("span", { class: "surface-live-dot", "aria-hidden": "true" }),
							hostOf(surface.liveUrl),
						)
					: null,
			),
			h(
				"div",
				{ class: "surface-bar-center" },
				live
					? h(
							"div",
							{ class: "surface-seg", role: "group", "aria-label": t("What the surface shows") },
							seg("live", t("Live"), t("What visitors see right now")),
							seg("preview", t("Preview"), t("Base with the changes you have turned on")),
							explorations.length ? seg("compare", t("Compare"), t("Every direction side by side")) : null,
						)
					: null,
			),
			h(
				"div",
				{ class: "surface-bar-tools" },
				live
					? h(
							"div",
							{ class: "surface-seg is-icons", role: "group", "aria-label": t("Viewport") },
							h(
								"button",
								{
									type: "button",
									class: state.device === "desktop" ? "is-on" : "",
									"aria-pressed": String(state.device === "desktop"),
									"aria-label": t("Desktop"),
									"data-act": "device",
									"data-device": "desktop",
								},
								icon("computer"),
							),
							h(
								"button",
								{
									type: "button",
									class: state.device === "mobile" ? "is-on" : "",
									"aria-pressed": String(state.device === "mobile"),
									"aria-label": t("Mobile"),
									"data-act": "device",
									"data-device": "mobile",
								},
								h("span", { class: "surface-phone-icon", "aria-hidden": "true" }),
							),
						)
					: null,
				surface.archetype !== "ops"
					? h(
							"div",
							{ class: `surface-publish${count ? " has-changes" : ""}` },
							h(
								"button",
								{
									type: "button",
									class: "surface-publish-main",
									disabled: !count || Boolean(state.busy[`publish:${surface.id}`]),
									title: count ? t("Publish Base to the live surface") : t("Live matches Base"),
									"data-act": "publish",
								},
								t("Publish"),
								count ? h("span", { class: "surface-count" }, String(count)) : null,
							),
							h(
								"button",
								{
									type: "button",
									class: "surface-publish-menu",
									"aria-label": t("Publish options"),
									"aria-haspopup": "menu",
									"data-act": "publish-menu",
								},
								icon("chevron-down"),
							),
						)
					: null,
			),
		);
	}

	#drawMount(surface: SurfaceSummary): void {
		const key = `${surface.id}:${surface.siteSlug ?? ""}:${surface.archetype}`;
		if (key !== this.#mountedFor) {
			this.#mount?.dispose();
			this.#mount = this.#host.mount(surface, this.#lifetime.signal);
			this.#mountedFor = key;
			this.#mountSlot.replaceChildren(
				this.#mount?.el ??
					h(
						"div",
						{ class: "surface-empty" },
						interfaceEmblem(surfaceEmblem(surface), 44),
						h("h2", null, surface.title),
						h(
							"p",
							null,
							surface.archetype === "live_build"
								? t("Nothing is live yet. Describe what to build below.")
								: t("This surface has nothing to show yet."),
						),
					),
			);
		}
		this.#mount?.update();
	}

	#drawFrames(surface: SurfaceSummary): void {
		const state = this.#host.store.state;
		const workspace = state.workspaces[surface.id];
		const preview = workspace?.previewState;
		const mode = surface.archetype === "live_build" ? state.mode : "live";
		const compare = mode === "compare" && openExplorations(workspace).length > 0;
		const showPrimary = mode === "preview" && preview !== undefined && preview.primary.status !== "live_baseline";
		const key = JSON.stringify([mode, compare, showPrimary, preview, surface.id]);
		if (key === this.#framesShown) return;
		this.#framesShown = key;
		this.#frames.classList.toggle("is-compare", compare);
		if (compare && preview) {
			const exploration = openExplorations(workspace)[0]!;
			const sessions = workspace!.activeSessions.filter((session) => session.explorationId === exploration.id);
			const frames = sessions.map((session) => {
				const compared = preview.compareFrames.find((item) => item.sessionId === session.id);
				const label = compared?.label ?? session.explorationVariantLabel ?? session.title;
				return h(
					"div",
					{ class: "surface-compare-column" },
					h(
						"div",
						{ class: "surface-compare-head" },
						h("strong", null, label),
						h(
							"button",
							{
								type: "button",
								class: "btn btn-small",
								"data-act": "choose",
								"data-exploration": exploration.id,
								"data-session": session.id,
							},
							t("Approve"),
						),
					),
					compared
						? frameOf(compared.frame, label)
						: frameOf({ ...preview.primary, status: "building", doorActionUrl: null }, label),
				);
			});
			this.#frames.replaceChildren(...frames);
			this.#frames.hidden = false;
			this.#mountSlot.hidden = true;
			return;
		}
		if (showPrimary && preview) {
			this.#frames.replaceChildren(frameOf(preview.primary, t("Preview of {title}", { title: surface.title })));
			this.#frames.hidden = false;
			this.#mountSlot.hidden = true;
			return;
		}
		this.#frames.replaceChildren();
		this.#frames.hidden = true;
		this.#mountSlot.hidden = false;
	}

	#drawChrome(surface: SurfaceSummary): void {
		const store = this.#host.store;
		const state = store.state;
		const canStart = store.canStartSessions(surface);
		const running = runningSessionTotal(state);
		const pending = migrationPending(state.migration) && !state.migrationDismissed;
		const key = JSON.stringify([
			surface.id,
			canStart,
			running,
			pending,
			state.error,
			state.migration?.specialistAgents.length,
			state.migration?.legacyBoards.length,
		]);
		if (key === this.#chromeShown) return;
		this.#chromeShown = key;
		this.#input.disabled = !canStart;
		this.#input.placeholder = canStart
			? t("Describe a change — it runs as its own session")
			: t("Sessions start once Surfaces are enabled for this company");
		this.#input.setAttribute("aria-label", t("Describe a change"));
		this.#send.setAttribute("aria-label", t("Start session"));
		this.#send.disabled = !canStart;
		this.#chips.replaceChildren(
			running > 0
				? h(
						"span",
						{ class: "surface-chip" },
						h("span", { class: "surface-state is-running" }),
						running === 1
							? t("1 session running")
							: t("{count} sessions running in parallel", { count: running }),
					)
				: "",
		);
		const banners: HTMLElement[] = [];
		if (state.error)
			banners.push(
				h(
					"div",
					{ class: "surface-banner is-error", role: "alert" },
					h("span", null, state.error),
					h("button", { type: "button", class: "btn btn-small", "data-act": "dismiss-error" }, t("Dismiss")),
				),
			);
		if (pending && state.migration) {
			const agents = state.migration.specialistAgents.length;
			const boards = state.migration.legacyBoards.length;
			banners.push(
				h(
					"div",
					{ class: "surface-banner" },
					h(
						"span",
						null,
						t("Fold {agents} specialist agents and {boards} boards into Surfaces and Automations.", {
							agents,
							boards,
						}),
					),
					h("button", { type: "button", class: "btn btn-primary btn-small", "data-act": "migrate" }, t("Review")),
					h("button", { type: "button", class: "btn btn-small", "data-act": "dismiss-migration" }, t("Not now")),
				),
			);
		}
		this.#banner.replaceChildren(...banners);
		this.el.classList.toggle("has-banner", banners.length > 0);
	}

	#drawToast(): void {
		const undo = this.#host.store.state.undo;
		if (undo?.id === this.#toastShown) return;
		this.#toastShown = undo?.id;
		this.#toast.replaceChildren(
			undo
				? h(
						"div",
						{ class: "surface-toast" },
						icon("check"),
						h("span", null, t("Merged “{title}” into Base", { title: undo.label })),
						h(
							"button",
							{ type: "button", "data-act": "undo" },
							h("span", { class: "surface-ring", "aria-hidden": "true" }),
							t("Undo"),
						),
					)
				: "",
		);
	}

	async #submit(): Promise<void> {
		const surface = this.surface;
		const text = this.#input.value.trim();
		if (!surface || !text || this.#input.disabled) return;
		this.#input.value = "";
		growToText(this.#input);
		this.#send.classList.remove("is-ready");
		const session = await this.#host.store.startSession(surface.id, text);
		if (!session) {
			this.#input.value = text;
			growToText(this.#input);
		}
	}

	#click(event: MouseEvent): void {
		const target = (event.target as Element).closest<HTMLElement>("[data-act]");
		if (!target || this.#drawer.el.contains(target) || !this.el.contains(target)) return;
		const store = this.#host.store;
		const surface = this.surface;
		if (!surface) return;
		const { act } = target.dataset;
		switch (act) {
			case "mode":
				store.setMode(target.dataset.mode as SurfacePreviewMode);
				return;
			case "device":
				store.setDevice(target.dataset.device === "mobile" ? "mobile" : "desktop");
				return;
			case "publish":
				void store.publish(surface.id);
				return;
			case "publish-menu": {
				const box = target.getBoundingClientRect();
				openContextMenu({
					label: t("Publish options"),
					x: box.left,
					y: box.bottom + 4,
					opener: target,
					items: [
						{
							label: t("Auto-publish on Approve"),
							hint: t("Approved changes go live without a separate Publish."),
							checked: surface.autoPublish,
							multiple: true,
							select: () => void store.setAutoPublish(surface.id, !surface.autoPublish),
						},
					],
				});
				return;
			}
			case "choose": {
				const workspace = store.workspace(surface.id);
				const exploration = workspace?.explorations.find((item) => item.id === target.dataset.exploration);
				if (exploration && target.dataset.session) void store.chooseVariant(exploration, target.dataset.session);
				return;
			}
			case "undo":
				void store.undo();
				return;
			case "migrate":
				this.#host.openMigration();
				return;
			case "dismiss-migration":
				store.dismissMigration();
				return;
			case "dismiss-error":
				store.clearError();
				return;
		}
	}
}
