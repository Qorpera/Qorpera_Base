import type { StartSurfaceSessionOptions } from "@qorpera/cloud-client/surfaces";
import {
	type PointToChangeTarget,
	parsePointToChangeTarget,
	SURFACE_INSPECTOR_MODE_MESSAGE,
	SURFACE_INSPECTOR_PICK_MESSAGE,
	type SurfaceSummary,
	type SurfaceWorkspace,
} from "@qorpera/contracts";
import { openContextMenu } from "../../ui/context-menu.ts";
import { growToText, h, icon } from "../../ui/dom.ts";
import { t } from "../../ui/preferences.ts";
import { opsComposerPlaceholder } from "../surface-kinds.ts";
import { renderLocalSitePreviewHtml } from "../surface-local-sandbox.ts";
import {
	formatConflictPaths,
	isLocalSurfaceId,
	isOpenChange,
	migrationPending,
	openExplorations,
	productBuildSurfaces,
	runningSessionTotal,
	type SurfacePreviewMode,
	type SurfacesStore,
	surfaceBySlug,
} from "../surfaces-store.ts";
import { SurfaceDoorStage } from "./surface-door.ts";
import { surfaceTile } from "./surface-rail.ts";
import { SurfaceReportView } from "./surface-report-view.ts";
import { SurfaceSessionDrawer } from "./surface-session-drawer.ts";
import { SurfaceStudioView } from "./surface-studio-view.ts";

export interface SurfaceMount {
	readonly el: HTMLElement;
	update(): void;
	dispose(): void;
}

export interface SurfaceViewHost {
	readonly store: SurfacesStore;
	mount(surface: SurfaceSummary, signal: AbortSignal): SurfaceMount | undefined;
	openMigration(): void;
	readonly loadStudioFiles?: (
		surface: SurfaceSummary,
		signal: AbortSignal,
	) => Promise<Readonly<Record<string, string>>>;
}

interface CompareColumn {
	readonly stage?: SurfaceDoorStage;
	localFrame?: HTMLIFrameElement;
	localDoc?: string;
	readonly column: HTMLElement;
	readonly title: HTMLButtonElement;
	readonly steer?: HTMLButtonElement;
	readonly approve?: HTMLButtonElement;
	readonly abort: AbortController;
}

function hostOf(url: string | null): string {
	if (!url) return "";
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

function targetOriginLabel(target: PointToChangeTarget): string {
	const element = target.componentHint?.trim() || target.tagName.toLowerCase();
	const label = target.route && target.route !== "/" ? `${element} · ${target.route}` : element;
	return label.slice(0, 160);
}

function isEditableTarget(target: EventTarget | null): boolean {
	if (!(target instanceof Element)) return false;
	if (
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement
	)
		return true;
	return target instanceof HTMLElement && target.isContentEditable;
}

export class SurfaceView {
	readonly el = h("section", { class: "page surface-page" });
	readonly slug: string;
	readonly #host: SurfaceViewHost;
	readonly #lifetime = new AbortController();
	readonly #bar = h("header", { class: "surface-bar" });
	readonly #topSlot = h("div", { class: "surface-top-slot", hidden: true });
	readonly #stage = h("div", { class: "surface-stage" });
	readonly #viewport = h("div", { class: "surface-viewport" });
	readonly #mountSlot = h("div", { class: "surface-mount" });
	readonly #compareBar = h("div", { class: "surface-compare-bar", hidden: true });
	readonly #compareColumns = h("div", { class: "surface-compare-columns" });
	readonly #frames = h("div", { class: "surface-frames", hidden: true });
	readonly #banner = h("div", { class: "surface-banners" });
	readonly #handoffTargetTag = h("span", { class: "surface-handoff-target" });
	readonly #handoffSelect = h("select", { class: "surface-handoff-select", "aria-label": t("Target surface") });
	readonly #handoffInput = h("input", { class: "surface-handoff-input", type: "text", autocomplete: "off" });
	readonly #handoffSubmit = h("button", { type: "submit", class: "btn btn-primary btn-small" }, t("Start session"));
	readonly #handoffForm = h(
		"form",
		{ class: "surface-handoff-bar", hidden: true },
		icon("forward"),
		this.#handoffTargetTag,
		this.#handoffSelect,
		this.#handoffInput,
		this.#handoffSubmit,
		h("button", { type: "button", class: "btn btn-small", "data-act": "handoff-cancel" }, t("Cancel")),
	);
	readonly #chips = h("div", { class: "surface-chips" });
	readonly #targetRow = h("div", { class: "surface-target-row" });
	readonly #point = h(
		"button",
		{ type: "button", class: "surface-point", "data-act": "point", "aria-pressed": "false", hidden: true },
		icon("crosshair"),
		h("span", null, t("Point")),
	);
	readonly #input = h("textarea", { class: "surface-input", rows: 1 });
	readonly #send = h("button", { type: "submit", class: "surface-send" }, icon("send"));
	readonly #composer = h(
		"form",
		{ class: "surface-composer" },
		this.#chips,
		this.#targetRow,
		h("div", { class: "surface-composer-shell" }, this.#point, this.#input, this.#send),
	);
	readonly #toast = h("div", { class: "surface-toast-host", role: "status" });
	readonly #drawer: SurfaceSessionDrawer;
	readonly #primaryDoor: SurfaceDoorStage;
	readonly #compareDoors = new Map<string, CompareColumn>();
	#framesMode: "none" | "primary" | "compare" = "none";
	#pointing = false;
	#handoffOpen = false;
	#handoffTarget = "";
	#target: PointToChangeTarget | undefined;
	#mount: SurfaceMount | undefined;
	#localHost: HTMLElement | undefined;
	#localFrame: HTMLIFrameElement | undefined;
	#localSiteShown = "";
	#mobileCompareLayout: "side" | "single" = "side";
	#mobileSingleId = "";
	#mountedFor = "";
	#barShown = "";
	#framesShown = "";
	#chromeShown = "";
	#toastShown: number | undefined;
	#deviceDefaulted = false;

	constructor(host: SurfaceViewHost, slug: string) {
		this.#host = host;
		this.slug = slug;
		const signal = this.#lifetime.signal;
		this.#drawer = new SurfaceSessionDrawer(host.store, signal);
		this.#primaryDoor = new SurfaceDoorStage(signal, {
			onPick: (target) => this.#onPick(target),
			onShownChange: () => {
				const surface = this.surface;
				if (surface) this.#drawChrome(surface);
			},
		});
		this.#topSlot.append(this.#handoffForm, this.#banner);
		this.#viewport.append(this.#mountSlot, this.#frames);
		this.#stage.append(this.#viewport, this.#composer, this.#drawer.el, this.#toast);
		this.el.append(this.#bar, this.#topSlot, this.#stage);
		window.addEventListener(
			"message",
			(event: MessageEvent) => {
				if (!this.#localFrame || event.source !== this.#localFrame.contentWindow) return;
				const data = event.data as { type?: unknown; target?: unknown } | null;
				if (!data || data.type !== SURFACE_INSPECTOR_PICK_MESSAGE) return;
				const picked = parsePointToChangeTarget(data.target);
				if (picked) this.#onPick(picked);
			},
			{ signal },
		);
		this.#handoffForm.addEventListener(
			"submit",
			(event) => {
				event.preventDefault();
				void this.#submitHandoff();
			},
			{ signal },
		);
		this.#handoffSelect.addEventListener(
			"change",
			() => {
				this.#handoffTarget = this.#handoffSelect.value;
				const chosen = productBuildSurfaces(this.#host.store.state, this.surface?.id).find(
					(item) => item.slug === this.#handoffTarget,
				);
				if (chosen) this.#handoffInput.placeholder = t("What should {name} do?", { name: chosen.title });
			},
			{ signal },
		);
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
		window.addEventListener("keydown", (event) => this.#keydown(event), { signal });
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
		this.#clearCompare();
		this.#primaryDoor.dispose();
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
			this.#banner.replaceChildren();
			this.#toast.replaceChildren();
			this.#handoffOpen = false;
			this.#handoffForm.hidden = true;
			this.#topSlot.hidden = true;
			this.#composer.hidden = true;
			this.#frames.hidden = true;
			this.#mountSlot.hidden = false;
			this.#localHost = undefined;
			this.#localFrame = undefined;
			this.#localSiteShown = "";
			this.#mountedFor = "";
			this.#barShown = "";
			this.#framesShown = "";
			this.#chromeShown = "";
			this.#toastShown = undefined;
			this.el.classList.remove("has-drawer", "has-banner", "is-pointing");
			this.#drawer.update();
			this.#mountSlot.replaceChildren(
				h(
					"div",
					{ class: "surface-empty" },
					h("p", null, state.source === "loading" ? t("Opening surface…") : t("This surface isn't available.")),
				),
			);
			return;
		}
		this.#composer.hidden = false;
		if (!this.#deviceDefaulted && surface.archetype === "live_build") {
			this.#deviceDefaulted = true;
			const wanted = store.lookOf(surface).kind === "mobile_app" ? "mobile" : "desktop";
			if (state.device !== wanted) queueMicrotask(() => store.setDevice(wanted));
		}
		this.#drawBar(surface);
		this.#drawMount(surface);
		this.#drawFrames(surface);
		if (this.#localHost) {
			if (this.#mountSlot.hidden) {
				// WHY: Unmount local srcdoc iframe while hidden so Chromium/Blink never re-attaches it in a 0x0 detached layout state.
				if (this.#localFrame) {
					this.#localHost.replaceChildren();
					this.#localFrame = undefined;
				}
				this.#localSiteShown = "";
			} else {
				this.#drawLocalLiveSite(surface);
			}
		}
		this.#drawChrome(surface);
		this.#drawer.update();
		this.#drawToast();
		this.el.classList.toggle("has-drawer", Boolean(state.drawer));
		this.#viewport.dataset.device = surface.archetype === "live_build" ? state.device : "desktop";
	}

	#drawBar(surface: SurfaceSummary): void {
		const store = this.#host.store;
		const state = store.state;
		const workspace = state.workspaces[surface.id];
		const explorations = openExplorations(workspace);
		const plainSessions = (workspace?.activeSessions ?? []).filter((session) => !session.explorationId);
		const canCompareLive =
			explorations.length > 0 ||
			(store.isLocalInteractive && isLocalSurfaceId(surface.id) && plainSessions.length > 0);
		const studioHasChanges =
			surface.archetype === "studio" &&
			Boolean(
				workspace?.activeSessions.some((session) =>
					session.changes.some((change) => change.kind === "folder_patch" && isOpenChange(change)),
				),
			);
		const handoffTargets =
			surface.archetype === "studio" || surface.archetype === "ops" ? productBuildSurfaces(state, surface.id) : [];
		const busyHandoff = handoffTargets.some((target) => Boolean(state.busy[`handoff:${surface.id}:${target.slug}`]));
		const look = store.lookOf(surface);
		const key = JSON.stringify([
			surface,
			look,
			state.mode,
			state.device,
			canCompareLive,
			studioHasChanges,
			handoffTargets.map((target) => [target.slug, target.title]),
			busyHandoff,
			this.#handoffOpen,
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
		const handoffLabel =
			handoffTargets.length === 1
				? surface.archetype === "studio"
					? t("Sync to {target}", { target: handoffTargets[0]!.title })
					: t("Send to {target}…", { target: handoffTargets[0]!.title })
				: surface.archetype === "studio"
					? t("Sync to…")
					: t("Send to…");
		this.#bar.replaceChildren(
			h(
				"div",
				{ class: "surface-bar-lead" },
				surfaceTile(surface, look, 16, "is-bar"),
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
							canCompareLive ? seg("compare", t("Compare"), t("Every direction side by side")) : null,
						)
					: studioHasChanges
						? h(
								"div",
								{ class: "surface-seg", role: "group", "aria-label": t("What the surface shows") },
								seg("live", t("Base"), t("Saved studio files without open changes")),
								seg("preview", t("Preview"), t("Base with the changes you have turned on")),
								seg("compare", t("Compare"), t("Compare Base and Preview side by side")),
							)
						: null,
			),
			h(
				"div",
				{ class: "surface-bar-tools" },
				handoffTargets.length > 0
					? h(
							"button",
							{
								type: "button",
								class: `surface-handoff-btn${this.#handoffOpen ? " is-on" : ""}`,
								disabled: busyHandoff,
								"data-act": "handoff-open",
							},
							icon("forward"),
							handoffLabel,
						)
					: null,
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
		const store = this.#host.store;
		const look = store.lookOf(surface);
		const key = `${surface.id}:${surface.siteSlug ?? ""}:${surface.archetype}:${look.kind}`;
		if (key !== this.#mountedFor) {
			this.#mount?.dispose();
			this.#localHost = undefined;
			this.#localFrame = undefined;
			this.#localSiteShown = "";
			this.#mount =
				this.#host.mount(surface, this.#lifetime.signal) ??
				(surface.archetype === "studio"
					? look.kind === "report"
						? new SurfaceReportView({
								store,
								surface,
								signal: this.#lifetime.signal,
								loadFiles: this.#host.loadStudioFiles,
							})
						: new SurfaceStudioView({
								store,
								surface,
								signal: this.#lifetime.signal,
								loadFiles: this.#host.loadStudioFiles,
							})
					: undefined);
			if (
				!this.#mount &&
				store.isLocalInteractive &&
				isLocalSurfaceId(surface.id) &&
				surface.archetype === "live_build"
			) {
				this.#mountedFor = key;
				this.#localHost = h("div", { class: "surface-local-site" });
				this.#mountSlot.replaceChildren(this.#localHost);
			} else {
				// WHY: Retry mount on next update when an ops view (e.g. Files) waits for company team permissions to load.
				if (this.#mount) this.#mountedFor = key;
				this.#mountSlot.replaceChildren(
					this.#mount?.el ??
						h(
							"div",
							{ class: "surface-empty" },
							surfaceTile(surface, look, 30, "is-hero"),
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
		}
		this.#mount?.update();
	}

	#createLocalFrame(title: string, html: string, attachInspector: boolean): HTMLIFrameElement {
		const frame = h("iframe", {
			class: "surface-frame surface-local-frame",
			sandbox: "allow-scripts",
			title,
		});
		if (attachInspector) {
			frame.addEventListener(
				"load",
				() => {
					frame.contentWindow?.postMessage({ type: SURFACE_INSPECTOR_MODE_MESSAGE, active: this.#pointing }, "*");
				},
				{ signal: this.#lifetime.signal },
			);
		}
		frame.srcdoc = html;
		return frame;
	}

	#drawLocalLiveSite(surface: SurfaceSummary): void {
		const host = this.#localHost;
		if (!host) return;
		const store = this.#host.store;
		const state = store.state;
		const workspace = state.workspaces[surface.id];
		const mode = state.mode === "live" ? "live" : "preview";
		const look = store.lookOf(surface);
		const exploration = openExplorations(workspace)[0];
		const pickedId = exploration ? store.pickedVariant(exploration) : undefined;
		const appliedChanges =
			mode === "live"
				? []
				: (workspace?.activeSessions ?? []).flatMap((session) => {
						if (session.explorationId && session.id !== pickedId) return [];
						return session.changes.filter((change) => isOpenChange(change) && store.isChangeShown(change.id));
					});
		const key = JSON.stringify([
			surface.id,
			surface.title,
			store.companyName,
			mode,
			look,
			pickedId,
			workspace?.briefSummary,
			appliedChanges.map((change) => [change.id, change.title, change.summary]),
		]);
		if (key === this.#localSiteShown && this.#localFrame?.parentElement === host) return;
		this.#localSiteShown = key;
		const html = renderLocalSitePreviewHtml(
			store.companyName,
			surface,
			appliedChanges,
			mode,
			look.kind === "custom" ? "website" : look.kind,
			workspace?.briefSummary ?? undefined,
			look.accent,
		);
		// WHY: Mount a fresh iframe element on every document swap so Blink always lays out and paints srcdoc cleanly.
		const frame = this.#createLocalFrame(t("Preview of {title}", { title: surface.title }), html, true);
		this.#localFrame = frame;
		host.replaceChildren(frame);
	}

	#clearCompare(): void {
		for (const entry of this.#compareDoors.values()) {
			entry.abort.abort();
			entry.stage?.dispose();
			entry.column.remove();
		}
		this.#compareDoors.clear();
	}

	#drawFrames(surface: SurfaceSummary): void {
		const store = this.#host.store;
		const state = store.state;
		const workspace = state.workspaces[surface.id];
		const preview = workspace?.previewState;
		const mode = surface.archetype === "live_build" ? state.mode : "live";
		const explorations = openExplorations(workspace);
		const plainSessions = (workspace?.activeSessions ?? []).filter((session) => !session.explorationId);
		const localLive = store.isLocalInteractive && isLocalSurfaceId(surface.id);
		const compare = mode === "compare" && (explorations.length > 0 || (localLive && plainSessions.length > 0));
		const localCompare = compare && localLive;
		const showPrimary = mode === "preview" && preview !== undefined && preview.primary.status !== "live_baseline";
		const targetOptions: { readonly id: string; readonly label: string }[] = [
			...explorations.map((item) => ({
				id: item.id,
				label: `${item.title} (${item.variantSessionIds.length})`,
			})),
			...(localCompare && plainSessions.length > 0 ? [{ id: "sessions", label: t("Base & sessions") }] : []),
		];
		const activeTarget =
			state.compareTargetId && targetOptions.some((option) => option.id === state.compareTargetId)
				? state.compareTargetId
				: (targetOptions[0]?.id ?? "sessions");
		const mobileCompare = compare && state.device === "mobile";
		const key = JSON.stringify([
			mode,
			compare,
			localCompare,
			mobileCompare,
			this.#mobileCompareLayout,
			this.#mobileSingleId,
			activeTarget,
			state.compareExcludedSessions,
			showPrimary,
			preview,
			surface.id,
			surface.title,
			localCompare
				? workspace?.activeSessions.map((session) => [
						session.id,
						session.title,
						session.explorationVariantLabel,
						session.changes.length,
					])
				: null,
			localCompare ? state.hiddenChanges : null,
			targetOptions,
		]);
		if (key === this.#framesShown) return;
		this.#framesShown = key;
		this.#viewport.classList.toggle("is-compare-mobile", mobileCompare);
		this.#frames.classList.toggle("is-compare", compare);
		this.#frames.classList.toggle("is-mobile-side", mobileCompare && this.#mobileCompareLayout === "side");
		this.#frames.classList.toggle("is-mobile-single", mobileCompare && this.#mobileCompareLayout === "single");
		if (compare && (preview || localCompare)) {
			if (this.#pointing) this.#setPointing(false);
			this.#primaryDoor.clear();
			const exploration = explorations.find((item) => item.id === activeTarget);

			if (this.#framesMode !== "compare") {
				this.#primaryDoor.el.remove();
				this.#frames.replaceChildren(this.#compareBar, this.#compareColumns);
				this.#framesMode = "compare";
			}

			const look = store.lookOf(surface);
			const activeOverlayChanges =
				localCompare && exploration
					? plainSessions
							.filter((session) => !state.compareExcludedSessions[session.id])
							.flatMap((session) =>
								session.changes.filter((change) => isOpenChange(change) && store.isChangeShown(change.id)),
							)
					: [];

			interface CompareItem {
				readonly id: string;
				readonly label: string;
				readonly explorationId?: string;
				readonly sessionId?: string;
				readonly isBase?: boolean;
				readonly html?: string;
				readonly frameState?: SurfaceWorkspace["previewState"]["primary"];
			}

			const items: CompareItem[] = [];
			if (exploration) {
				const variantSessions = workspace!.activeSessions.filter(
					(session) => session.explorationId === exploration.id,
				);
				for (const session of variantSessions) {
					const compared = preview?.compareFrames.find((item) => item.sessionId === session.id);
					const label = compared?.label ?? session.explorationVariantLabel ?? session.title;
					if (localCompare) {
						const variantChanges = [...session.changes.filter(isOpenChange), ...activeOverlayChanges];
						items.push({
							id: session.id,
							label,
							explorationId: exploration.id,
							sessionId: session.id,
							html: renderLocalSitePreviewHtml(
								store.companyName,
								surface,
								variantChanges,
								"preview",
								look.kind === "custom" ? "website" : look.kind,
								workspace?.briefSummary ?? undefined,
								look.accent,
							),
						});
					} else if (preview) {
						items.push({
							id: session.id,
							label,
							explorationId: exploration.id,
							sessionId: session.id,
							frameState: compared
								? compared.frame
								: { ...preview.primary, status: "building" as const, doorActionUrl: null, memberPass: null },
						});
					}
				}
			} else if (localCompare) {
				items.push({
					id: "__base__",
					label: t("Live baseline"),
					isBase: true,
					html: renderLocalSitePreviewHtml(
						store.companyName,
						surface,
						[],
						"live",
						look.kind === "custom" ? "website" : look.kind,
						workspace?.briefSummary ?? undefined,
						look.accent,
					),
				});
				for (const session of plainSessions) {
					items.push({
						id: session.id,
						label: session.title,
						sessionId: session.id,
						html: renderLocalSitePreviewHtml(
							store.companyName,
							surface,
							session.changes.filter(isOpenChange),
							"preview",
							look.kind === "custom" ? "website" : look.kind,
							workspace?.briefSummary ?? undefined,
							look.accent,
						),
					});
				}
			}

			const activeSingleId =
				this.#mobileSingleId && items.some((item) => item.id === this.#mobileSingleId)
					? this.#mobileSingleId
					: (items[1]?.id ?? items[0]?.id ?? "");
			const singleMode = mobileCompare && this.#mobileCompareLayout === "single" && items.length > 1;
			const visibleItems = singleMode ? items.filter((item) => item.id === activeSingleId) : items;

			const showCompareBar =
				targetOptions.length > 1 ||
				(localCompare && Boolean(exploration) && plainSessions.length > 0) ||
				(mobileCompare && items.length > 1);
			this.#compareBar.hidden = !showCompareBar;
			if (showCompareBar) {
				const barChildren: HTMLElement[] = [];
				if (targetOptions.length > 1) {
					barChildren.push(
						h(
							"div",
							{ class: "surface-compare-tabs", role: "tablist", "aria-label": t("Compare sets") },
							targetOptions.map((option) =>
								h(
									"button",
									{
										type: "button",
										role: "tab",
										class: `surface-compare-tab${option.id === activeTarget ? " is-on" : ""}`,
										"aria-selected": String(option.id === activeTarget),
										"data-act": "compare-target",
										"data-target": option.id,
									},
									option.label,
								),
							),
						),
					);
				}
				if (singleMode) {
					barChildren.push(
						h(
							"div",
							{
								class: "surface-compare-tabs surface-mobile-flip",
								role: "tablist",
								"aria-label": t("Phone screen"),
							},
							items.map((item) =>
								h(
									"button",
									{
										type: "button",
										role: "tab",
										class: `surface-compare-tab${item.id === activeSingleId ? " is-on" : ""}`,
										"aria-selected": String(item.id === activeSingleId),
										"data-act": "mobile-compare-pick",
										"data-item": item.id,
									},
									item.label,
								),
							),
						),
					);
				}
				if (localCompare && exploration && plainSessions.length > 0) {
					barChildren.push(
						h(
							"div",
							{ class: "surface-compare-overlays" },
							h("span", { class: "surface-compare-overlay-label" }, t("Layer with:")),
							...plainSessions.map((session) => {
								const on = !state.compareExcludedSessions[session.id];
								return h(
									"button",
									{
										type: "button",
										class: `surface-compare-overlay${on ? " is-on" : ""}`,
										"aria-pressed": String(on),
										"data-act": "compare-overlay",
										"data-session": session.id,
									},
									on ? icon("check") : null,
									session.title,
								);
							}),
						),
					);
				}
				if (mobileCompare && items.length > 1) {
					barChildren.push(
						h(
							"div",
							{
								class: "surface-seg surface-mobile-compare-seg",
								role: "group",
								"aria-label": t("Phone compare layout"),
							},
							h(
								"button",
								{
									type: "button",
									class: this.#mobileCompareLayout === "side" ? "is-on" : "",
									"aria-pressed": String(this.#mobileCompareLayout === "side"),
									"data-act": "mobile-compare-layout",
									"data-layout": "side",
								},
								t("Side by side"),
							),
							h(
								"button",
								{
									type: "button",
									class: this.#mobileCompareLayout === "single" ? "is-on" : "",
									"aria-pressed": String(this.#mobileCompareLayout === "single"),
									"data-act": "mobile-compare-layout",
									"data-layout": "single",
								},
								t("Single phone"),
							),
						),
					);
				}
				this.#compareBar.replaceChildren(...barChildren);
			} else {
				this.#compareBar.replaceChildren();
			}

			const keep = new Set(visibleItems.map((item) => item.id));
			for (const [id, entry] of this.#compareDoors) {
				if (keep.has(id)) continue;
				entry.abort.abort();
				entry.stage?.dispose();
				entry.column.remove();
				this.#compareDoors.delete(id);
			}

			for (const item of visibleItems) {
				let entry = this.#compareDoors.get(item.id);
				if (!entry) {
					const abort = new AbortController();
					const title = h(
						"button",
						{
							type: "button",
							class: "surface-compare-open",
							title: item.isBase ? t("Open Live") : t("Open in Preview"),
							"data-act": item.isBase ? "inspect-base" : "inspect-variant",
							...(item.explorationId ? { "data-exploration": item.explorationId } : {}),
							...(item.sessionId ? { "data-session": item.sessionId } : {}),
						},
						h("strong", null, item.label),
						h("span", { class: "surface-compare-open-hint", "aria-hidden": "true" }, "↗"),
					);
					const steer = item.sessionId
						? h(
								"button",
								{
									type: "button",
									class: "btn btn-small surface-compare-steer",
									"data-act": "steer-variant",
									...(item.explorationId ? { "data-exploration": item.explorationId } : {}),
									"data-session": item.sessionId,
								},
								t("Steer"),
							)
						: undefined;
					const approve = item.isBase
						? undefined
						: h(
								"button",
								{
									type: "button",
									class: "btn btn-small",
									"data-act": item.explorationId ? "choose" : "approve-session",
									...(item.explorationId ? { "data-exploration": item.explorationId } : {}),
									...(item.sessionId ? { "data-session": item.sessionId } : {}),
								},
								t("Approve"),
							);
					const head = h(
						"div",
						{ class: "surface-compare-head" },
						title,
						h("div", { class: "surface-compare-actions" }, steer ?? null, approve ?? null),
					);
					if (item.html !== undefined) {
						const localFrame = this.#createLocalFrame(item.label, item.html, false);
						const column = h(
							"div",
							{ class: "surface-compare-column" },
							head,
							h("div", { class: "surface-door-stage surface-local-site" }, localFrame),
						);
						entry = { localFrame, localDoc: item.html, column, title, steer, approve, abort };
					} else {
						const stage = new SurfaceDoorStage(abort.signal);
						const column = h("div", { class: "surface-compare-column" }, head, stage.el);
						entry = { stage, column, title, steer, approve, abort };
					}
					this.#compareDoors.set(item.id, entry);
					this.#compareColumns.append(entry.column);
				} else {
					const strong = entry.title.querySelector("strong");
					if (strong) strong.textContent = item.label;
					if (item.explorationId) {
						entry.title.dataset.exploration = item.explorationId;
						if (entry.steer) entry.steer.dataset.exploration = item.explorationId;
						if (entry.approve) entry.approve.dataset.exploration = item.explorationId;
					}
				}
				if (entry.localFrame && item.html !== undefined) {
					if (entry.localDoc !== item.html) {
						const fresh = this.#createLocalFrame(item.label, item.html, false);
						entry.localFrame.replaceWith(fresh);
						entry.localFrame = fresh;
						entry.localDoc = item.html;
					}
				} else if (entry.stage && item.frameState) {
					entry.stage.sync(item.frameState, item.label);
				}
			}
			this.#frames.hidden = false;
			this.#mountSlot.hidden = true;
			return;
		}
		if (showPrimary && preview) {
			this.#clearCompare();
			if (this.#framesMode !== "primary") {
				this.#frames.replaceChildren(this.#primaryDoor.el);
				this.#framesMode = "primary";
			}
			this.#primaryDoor.sync(preview.primary, t("Preview of {title}", { title: surface.title }));
			this.#frames.hidden = false;
			this.#mountSlot.hidden = true;
			return;
		}
		this.#clearCompare();
		this.#primaryDoor.clear();
		if (this.#pointing) this.#setPointing(false);
		if (this.#framesMode !== "none") {
			this.#frames.replaceChildren();
			this.#framesMode = "none";
		}
		this.#frames.hidden = true;
		this.#mountSlot.hidden = false;
	}

	#drawChrome(surface: SurfaceSummary): void {
		const store = this.#host.store;
		const state = store.state;
		const workspace = state.workspaces[surface.id];
		const preview = workspace?.previewState;
		const conflict = preview?.primary.conflictReport ?? null;
		const hasConflict = Boolean(conflict && (conflict.changeIds.length > 0 || conflict.paths.length > 0));
		const busyReconcile = Boolean(state.busy[`reconcile:${surface.id}`]);
		const canStart = store.canStartSessions(surface);
		const pointVisible = surface.archetype === "live_build";
		const hasPreviewDoor = Boolean(
			preview?.primary.status === "ready" && preview.primary.doorActionUrl && preview.primary.memberPass,
		);
		const pointEnabled =
			pointVisible && canStart && (hasPreviewDoor || this.#primaryDoor.hasShown || Boolean(this.#localFrame));
		if (this.#pointing && !pointEnabled) {
			this.#pointing = false;
			this.#primaryDoor.setInspectorMode(false);
			this.#localFrame?.contentWindow?.postMessage({ type: SURFACE_INSPECTOR_MODE_MESSAGE, active: false }, "*");
		}
		const running = runningSessionTotal(state);
		const pending = migrationPending(state.migration) && !state.migrationDismissed;
		const key = JSON.stringify([
			surface.id,
			canStart,
			pointVisible,
			pointEnabled,
			this.#pointing,
			this.#target,
			running,
			pending,
			state.error,
			hasConflict ? conflict : null,
			busyReconcile,
			state.migration?.specialistAgents.length,
			state.migration?.legacyBoards.length,
		]);
		if (key === this.#chromeShown) return;
		this.#chromeShown = key;
		this.#input.disabled = !canStart;
		this.#input.placeholder = !canStart
			? t("Sessions start once Surfaces are enabled for this company")
			: surface.archetype === "ops"
				? opsComposerPlaceholder(store.lookOf(surface).kind)
				: t("Describe a change — it runs as its own session");
		this.#input.setAttribute("aria-label", surface.archetype === "ops" ? t("Ask an agent") : t("Describe a change"));
		this.#send.setAttribute("aria-label", t("Start session"));
		this.#send.disabled = !canStart;
		this.#point.hidden = !pointVisible;
		this.#point.disabled = !pointEnabled;
		this.#point.classList.toggle("is-on", this.#pointing);
		this.#point.setAttribute("aria-pressed", String(this.#pointing));
		this.#point.title = pointEnabled ? t("Point at an element (P)") : t("Point is available when a preview is open");
		this.el.classList.toggle("is-pointing", this.#pointing);
		const chips: HTMLElement[] = [];
		if (this.#pointing)
			chips.push(
				h(
					"span",
					{ class: "surface-chip is-pointing" },
					icon("crosshair"),
					t("Click anything on the page to target it · Esc to cancel"),
				),
			);
		if (running > 0)
			chips.push(
				h(
					"span",
					{ class: "surface-chip" },
					h("span", { class: "surface-state is-running" }),
					running === 1 ? t("1 session running") : t("{count} sessions running in parallel", { count: running }),
				),
			);
		this.#chips.replaceChildren(...chips);
		if (this.#target) {
			const label = this.#target.componentHint?.trim() || this.#target.tagName.toLowerCase();
			const snippet = this.#target.textSnippet.trim();
			this.#targetRow.replaceChildren(
				h(
					"div",
					{ class: "surface-target-pill" },
					icon("crosshair"),
					h("strong", { class: "surface-target-name" }, label),
					h("span", { class: "surface-target-route" }, this.#target.route),
					snippet ? h("span", { class: "surface-target-snippet", title: snippet }, snippet) : null,
					h(
						"button",
						{
							type: "button",
							class: "surface-target-clear",
							"aria-label": t("Remove target"),
							"data-act": "clear-target",
						},
						icon("close"),
					),
				),
			);
		} else {
			this.#targetRow.replaceChildren();
		}
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
		if (hasConflict && conflict) {
			const paths = formatConflictPaths(conflict.paths);
			banners.push(
				h(
					"div",
					{ class: "surface-banner is-conflict", role: "alert" },
					h("span", { class: "surface-state is-conflicted", "aria-hidden": "true" }),
					h(
						"span",
						{ title: conflict.paths.join(", ") || undefined },
						paths ? t("Preview conflict in {paths}", { paths }) : t("Preview changes conflict."),
					),
					h(
						"button",
						{
							type: "button",
							class: "btn btn-primary btn-small",
							"data-act": "reconcile",
							disabled: busyReconcile || conflict.changeIds.length === 0,
						},
						t("Reconcile"),
					),
				),
			);
		}
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
		this.#syncTopSlot();
		this.el.classList.toggle("has-banner", banners.length > 0);
	}

	#syncTopSlot(): void {
		this.#topSlot.hidden = !this.#handoffOpen && this.#banner.childElementCount === 0;
	}

	#setPointing(active: boolean): void {
		if (active === this.#pointing) return;
		const surface = this.surface;
		if (active) {
			if (!surface || surface.archetype !== "live_build" || !this.#host.store.canStartSessions(surface)) return;
			if (this.#host.store.state.mode !== "preview") {
				this.#host.store.setMode("preview");
				this.#drawBar(surface);
				this.#drawMount(surface);
				this.#drawFrames(surface);
			}
		}
		this.#pointing = active;
		this.#primaryDoor.setInspectorMode(active);
		this.#localFrame?.contentWindow?.postMessage({ type: SURFACE_INSPECTOR_MODE_MESSAGE, active }, "*");
		this.el.classList.toggle("is-pointing", active);
		if (surface) this.#drawChrome(surface);
	}

	#onPick(target: PointToChangeTarget): void {
		this.#target = target;
		this.#pointing = false;
		this.#primaryDoor.setInspectorMode(false);
		this.#localFrame?.contentWindow?.postMessage({ type: SURFACE_INSPECTOR_MODE_MESSAGE, active: false }, "*");
		this.el.classList.toggle("is-pointing", false);
		const surface = this.surface;
		if (surface) this.#drawChrome(surface);
		this.focus();
	}

	#keydown(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
		if (event.key === "Escape" && this.#handoffOpen) {
			event.preventDefault();
			this.#closeHandoff();
			return;
		}
		if (event.key === "Escape" && this.#pointing) {
			event.preventDefault();
			this.#setPointing(false);
			return;
		}
		if (event.key !== "p" && event.key !== "P") return;
		if (isEditableTarget(event.target)) return;
		if (this.#host.store.state.drawer || document.querySelector("dialog.surface-dialog[open], .settings-overlay"))
			return;
		if (this.#point.hidden || this.#point.disabled) return;
		event.preventDefault();
		this.#setPointing(!this.#pointing);
	}

	async #syncStudioTo(surface: SurfaceSummary, targetSlug: string): Promise<void> {
		const target = productBuildSurfaces(this.#host.store.state, surface.id).find((item) => item.slug === targetSlug);
		if (!target) return;
		await this.#host.store.spawnCrossSurfaceSession({
			sourceSurfaceId: surface.id,
			targetSurfaceSlug: target.slug,
			title: t("Sync {source}", { source: surface.title }),
			prompt: t("Sync the latest updates from {source} into {target}.", {
				source: surface.title,
				target: target.title,
			}),
			sourceRef: { surfaceSlug: surface.slug, ...(surface.folderRoot ? { folderRoot: surface.folderRoot } : {}) },
		});
	}

	#openHandoffPrompt(surface: SurfaceSummary): void {
		const targets = productBuildSurfaces(this.#host.store.state, surface.id);
		if (!targets.length) return;
		if (!targets.some((item) => item.slug === this.#handoffTarget)) this.#handoffTarget = targets[0]!.slug;
		const chosen = targets.find((item) => item.slug === this.#handoffTarget) ?? targets[0]!;
		this.#handoffOpen = true;
		this.#handoffForm.hidden = false;
		this.#syncTopSlot();
		if (targets.length === 1) {
			this.#handoffSelect.hidden = true;
			this.#handoffTargetTag.hidden = false;
			this.#handoffTargetTag.textContent = chosen.title;
		} else {
			this.#handoffTargetTag.hidden = true;
			this.#handoffSelect.hidden = false;
			this.#handoffSelect.replaceChildren(
				...targets.map((item) =>
					h("option", { value: item.slug, selected: item.slug === chosen.slug }, item.title),
				),
			);
			this.#handoffSelect.value = chosen.slug;
		}
		this.#handoffInput.placeholder = t("What should {name} do?", { name: chosen.title });
		this.#handoffInput.setAttribute("aria-label", t("What should {name} do?", { name: chosen.title }));
		this.#drawBar(surface);
		this.#handoffInput.focus({ preventScroll: true });
	}

	#closeHandoff(): void {
		if (!this.#handoffOpen) return;
		this.#handoffOpen = false;
		this.#handoffForm.hidden = true;
		this.#syncTopSlot();
		const surface = this.surface;
		if (surface) this.#drawBar(surface);
	}

	async #submitHandoff(): Promise<void> {
		const surface = this.surface;
		const prompt = this.#handoffInput.value.trim();
		if (!surface || !prompt) return;
		const targets = productBuildSurfaces(this.#host.store.state, surface.id);
		const target = targets.find((item) => item.slug === this.#handoffTarget) ?? targets[0];
		if (!target) return;
		this.#handoffInput.value = "";
		const created = await this.#host.store.spawnCrossSurfaceSession({
			sourceSurfaceId: surface.id,
			targetSurfaceSlug: target.slug,
			title: t("From {source}", { source: surface.title }),
			prompt,
			sourceRef: { surfaceSlug: surface.slug },
		});
		if (!created) {
			this.#handoffInput.value = prompt;
			return;
		}
		this.#closeHandoff();
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
						h(
							"span",
							null,
							undo.verb === "sent"
								? t("Sent “{title}”", { title: undo.label })
								: undo.verb === "done"
									? t("Done: “{title}”", { title: undo.label })
									: t("Merged “{title}” into Base", { title: undo.label }),
						),
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
		const target = this.#target;
		const options: StartSurfaceSessionOptions = target
			? { target, originKind: "point_to_change", originLabel: targetOriginLabel(target) }
			: {};
		this.#input.value = "";
		growToText(this.#input);
		this.#send.classList.remove("is-ready");
		const session = await this.#host.store.startSession(surface.id, text, options);
		if (!session) {
			this.#input.value = text;
			growToText(this.#input);
			this.#send.classList.toggle("is-ready", text.length > 0);
			return;
		}
		if (target) {
			this.#target = undefined;
			this.#drawChrome(surface);
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
			case "mode": {
				const next = target.dataset.mode as SurfacePreviewMode;
				if (next !== "preview" && this.#pointing) this.#setPointing(false);
				store.setMode(next);
				return;
			}
			case "device":
				store.setDevice(target.dataset.device === "mobile" ? "mobile" : "desktop");
				return;
			case "point":
				this.#setPointing(!this.#pointing);
				return;
			case "clear-target":
				this.#target = undefined;
				this.#drawChrome(surface);
				return;
			case "reconcile": {
				const ids = store.workspace(surface.id)?.previewState.primary.conflictReport?.changeIds ?? [];
				if (ids.length) void store.reconcileChanges(surface.id, ids);
				return;
			}
			case "handoff-open": {
				const targets = productBuildSurfaces(store.state, surface.id);
				if (!targets.length) return;
				if (surface.archetype === "studio") {
					if (targets.length === 1) {
						void this.#syncStudioTo(surface, targets[0]!.slug);
						return;
					}
					const box = target.getBoundingClientRect();
					openContextMenu({
						label: t("Sync to…"),
						x: box.left,
						y: box.bottom + 4,
						opener: target,
						items: targets.map((item) => ({
							label: item.title,
							select: () => void this.#syncStudioTo(surface, item.slug),
						})),
					});
					return;
				}
				if (this.#handoffOpen) this.#closeHandoff();
				else this.#openHandoffPrompt(surface);
				return;
			}
			case "handoff-cancel":
				this.#closeHandoff();
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
			case "approve-session":
				if (target.dataset.session) void store.approveAll(target.dataset.session);
				return;
			case "compare-target":
				if (target.dataset.target) store.setCompareTarget(target.dataset.target);
				return;
			case "compare-overlay":
				if (target.dataset.session) store.toggleCompareOverlay(target.dataset.session);
				return;
			case "mobile-compare-layout":
				this.#mobileCompareLayout = target.dataset.layout === "single" ? "single" : "side";
				this.#drawFrames(surface);
				return;
			case "mobile-compare-pick":
				if (target.dataset.item) {
					this.#mobileSingleId = target.dataset.item;
					this.#drawFrames(surface);
				}
				return;
			case "inspect-base":
				store.setMode("live");
				return;
			case "inspect-variant":
				if (target.dataset.session)
					void store.inspectVariant(surface.id, target.dataset.exploration, target.dataset.session, false);
				return;
			case "steer-variant":
				if (target.dataset.session)
					void store.inspectVariant(surface.id, target.dataset.exploration, target.dataset.session, true);
				return;
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
