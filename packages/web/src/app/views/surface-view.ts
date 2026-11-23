import type { StartSurfaceSessionOptions } from "@qorpera/cloud-client/surfaces";
import {
	type PointToChangeTarget,
	parsePointToChangeTarget,
	SURFACE_INSPECTOR_MODE_MESSAGE,
	SURFACE_INSPECTOR_PICK_MESSAGE,
	type SurfaceSummary,
} from "@qorpera/contracts";
import { openContextMenu, openMenu } from "../../ui/context-menu.ts";
import { growToText, h, icon, personAvatar } from "../../ui/dom.ts";
import { playOnce } from "../../ui/motion.ts";
import { t } from "../../ui/preferences.ts";
import { type SurfaceSkeletonKind, surfaceSkeleton } from "../../ui/skeleton.ts";
import { afterPaint } from "../../ui/time-slice.ts";
import { opsComposerPlaceholder, supportsViewportSplit } from "../surface-kinds.ts";
import { renderLocalSitePreviewHtml } from "../surface-local-sandbox.ts";
import {
	askedToPublish,
	formatConflictPaths,
	isLocalSurfaceId,
	isOpenChange,
	isOpenVariant,
	migrationPending,
	openExplorations,
	runningSessionTotal,
	type SurfacePreviewMode,
	type SurfacesStore,
	surfaceBySlug,
	surfaceHasReports,
} from "../surfaces-store.ts";
import { SurfaceAddress, type SurfaceSiteHosting } from "./surface-address-sheet.ts";
import { SurfaceComposerImages } from "./surface-composer-images.ts";
import { applyIdentityTokensToFrame, SurfaceDoorStage } from "./surface-door.ts";
import { firstName, openPublishSheet } from "./surface-publish-sheet.ts";
import { surfaceTile } from "./surface-rail.ts";
import { SurfaceReportView } from "./surface-report-view.ts";
import { SurfaceSessionDrawer } from "./surface-session-drawer.ts";
import { SurfaceStudioView } from "./surface-studio-view.ts";

export interface SurfaceMount {
	readonly el: HTMLElement;
	update(): void;
	deactivate?(): void;
	dispose(): void;
}

export interface SurfaceViewHost {
	readonly store: SurfacesStore;
	mount(surface: SurfaceSummary, signal: AbortSignal): SurfaceMount | undefined;
	openMigration(): void;
	readonly isMountLoading?: (surface: SurfaceSummary) => boolean;
	readonly isSiteLive?: (surface: SurfaceSummary) => boolean;
	readonly loadStudioFiles?: (
		surface: SurfaceSummary,
		signal: AbortSignal,
	) => Promise<Readonly<Record<string, string>>>;
	readonly siteHosting?: (surface: SurfaceSummary) => SurfaceSiteHosting | undefined;
	readonly managesSites?: () => boolean;
}

interface CompareColumn {
	readonly stage: SurfaceDoorStage;
	readonly column: HTMLElement;
	readonly head: HTMLElement;
	readonly abort: AbortController;
}

const PHONE_MODEL_KEY = "qorpera.web.surface-phone-model.v1";

interface PhoneModelSpec {
	readonly id: string;
	readonly label: string;
	readonly shortLabel: string;
	readonly width: number;
	readonly height: number;
	readonly radius: number;
	readonly cutout: "island" | "punch" | "none";
}

const PHONE_MODELS: readonly PhoneModelSpec[] = [
	{
		id: "iphone-16",
		label: "iPhone 16",
		shortLabel: "iPhone 16",
		width: 393,
		height: 852,
		radius: 50,
		cutout: "island",
	},
	{
		id: "iphone-16-pro-max",
		label: "iPhone 16 Pro Max",
		shortLabel: "16 Pro Max",
		width: 440,
		height: 956,
		radius: 54,
		cutout: "island",
	},
	{
		id: "iphone-se",
		label: "iPhone SE",
		shortLabel: "iPhone SE",
		width: 375,
		height: 667,
		radius: 26,
		cutout: "none",
	},
	{ id: "pixel-9", label: "Pixel 9", shortLabel: "Pixel 9", width: 412, height: 915, radius: 36, cutout: "punch" },
];

function phoneModelById(id: string | null | undefined): PhoneModelSpec {
	return PHONE_MODELS.find((model) => model.id === id) ?? PHONE_MODELS[0]!;
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

function barFocusKey(element: HTMLElement): string {
	return `${element.dataset.act ?? ""}:${element.dataset.mode ?? element.dataset.device ?? ""}`;
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
	readonly #active = new AbortController();
	readonly #lifetime = new AbortController();
	readonly #bar = h("header", { class: "surface-bar" });
	readonly #barTitle = h("h1", { class: "visually-hidden surface-title" });
	readonly #notchPill = h("button", {
		type: "button",
		class: "surface-notch-pill",
		"aria-expanded": "false",
		"data-act": "expand-pill",
	});
	readonly #notchBar = h("nav", { class: "surface-pill" });
	readonly #notch = h("div", { class: "surface-notch" }, this.#notchPill, this.#notchBar);
	readonly #panelToggle = h("button", {
		type: "button",
		class: "surface-panel-toggle",
		"data-act": "toggle-panel",
		hidden: true,
	});
	readonly #phoneBar = h("div", {
		class: "surface-phone-bar",
		role: "group",
		"aria-label": t("Phone model"),
		hidden: true,
	});
	readonly #topSlot = h("div", { class: "surface-top-slot", hidden: true });
	readonly #stage = h("div", { class: "surface-stage" });
	readonly #canvas = h("div", { class: "surface-canvas" });
	readonly #viewport = h("div", { class: "surface-viewport" });
	readonly #loadingSlot = h("div", { class: "surface-loading", hidden: true });
	readonly #mountSlot = h("div", { class: "surface-mount" });
	readonly #reportSlot = h("div", { class: "surface-report-slot", hidden: true });
	readonly #compareColumns = h("div", { class: "surface-compare-columns" });
	readonly #frames = h("div", { class: "surface-frames", hidden: true });
	readonly #banner = h("div", { class: "surface-banners" });
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
	readonly #shell = h("div", { class: "surface-composer-shell" }, this.#point, this.#input, this.#send);
	readonly #composer = h("form", { class: "surface-composer" }, this.#chips, this.#targetRow, this.#shell);
	readonly #images: SurfaceComposerImages;
	readonly #toast = h("div", { class: "surface-toast-host", role: "status" });
	readonly #drawer: SurfaceSessionDrawer;
	readonly #primaryDoor: SurfaceDoorStage;
	readonly #address: SurfaceAddress;
	readonly #compareDoors = new Map<string, CompareColumn>();
	#framesMode: "none" | "primary" | "compare" = "none";
	#pointing = false;
	#target: PointToChangeTarget | undefined;
	#mount: SurfaceMount | undefined;
	#attachedReport: SurfaceReportView | undefined;
	#localHost: HTMLElement | undefined;
	#localFrame: HTMLIFrameElement | undefined;
	#localCover: HTMLElement | undefined;
	#localLoadTimer: ReturnType<typeof setTimeout> | undefined;
	#localSiteShown = "";
	#loadingKind: SurfaceSkeletonKind | "" = "";
	#contentReady = false;
	#deactivated = false;
	#disposed = false;
	#cancelReady: (() => void) | undefined;
	#mountedFor = "";
	#lastSurfaceId = "";
	#barShown = "";
	#askShown = "";
	#framesShown = "";
	#chromeShown = "";
	#insteadShown: string | undefined;
	#toastShown = "";
	#barOpen = false;
	#barPinned = false;
	readonly #thumbAt = new Map<string, readonly [number, number]>();
	#phoneModelId = PHONE_MODELS[0]!.id;
	#phoneBarShown = "";
	#viewportResizeObserver: ResizeObserver | undefined;
	#notchResizeObserver: ResizeObserver | undefined;

	constructor(host: SurfaceViewHost, slug: string) {
		this.#host = host;
		this.slug = slug;
		try {
			const storedModel = localStorage.getItem(PHONE_MODEL_KEY);
			if (storedModel) this.#phoneModelId = phoneModelById(storedModel).id;
		} catch {
			/* WHY: Local browser storage is optional in private/sandboxed contexts. */
		}
		const signal = this.#active.signal;
		this.#images = new SurfaceComposerImages(this.#shell, signal, () => this.#syncSend());
		this.#shell.insertBefore(this.#images.button, this.#input);
		this.#composer.insertBefore(this.#images.tray.el, this.#shell);
		this.#composer.append(this.#images.tray.status);
		this.#images.setAvailable(host.store.canAttachImages);
		this.#drawer = new SurfaceSessionDrawer(host.store, signal);
		this.#primaryDoor = new SurfaceDoorStage(this.#lifetime.signal, {
			onPick: (target) => {
				if (!this.#deactivated) this.#onPick(target);
			},
			onShownChange: () => {
				if (this.#deactivated) return;
				const surface = this.surface;
				if (surface) this.#drawChrome(surface);
			},
			onRetry: () => {
				const surface = this.surface;
				if (surface) void host.store.retryPreview(surface.id);
			},
			isPassUsable: (previewId, pass) => host.store.isPreviewPassUsable(previewId, pass),
			onPassSent: (previewId, pass) => host.store.markPreviewPassConsumed(previewId, pass),
			onNeedFreshPass: (previewId, stalePass) => {
				if (this.#deactivated) return Promise.resolve(false);
				const surface = this.surface;
				return surface ? host.store.remintPreviewPass(surface.id, previewId, stalePass) : Promise.resolve(false);
			},
		});
		this.#topSlot.append(this.#banner);
		this.#viewport.append(this.#phoneBar, this.#loadingSlot, this.#mountSlot, this.#reportSlot, this.#frames);
		this.#bar.append(this.#barTitle, this.#notch);
		this.#canvas.append(this.#bar, this.#topSlot, this.#viewport, this.#composer, this.#toast);
		this.#address = new SurfaceAddress({
			container: this.#canvas,
			canManage: () => host.managesSites?.() === true,
			changed: () => {
				const surface = this.surface;
				if (surface && !this.#deactivated) this.#drawBar(surface);
			},
			signal,
		});
		this.#stage.append(this.#canvas, this.#drawer.el);
		this.el.append(this.#stage, this.#panelToggle);
		this.#wireBar(signal);
		if (typeof ResizeObserver !== "undefined") {
			this.#viewportResizeObserver = new ResizeObserver(() => this.#syncPhoneViewport());
			this.#viewportResizeObserver.observe(this.#viewport);
			this.#notchResizeObserver = new ResizeObserver(() => {
				this.el.style.setProperty("--surface-drawer-shown", `${this.#drawer.el.offsetWidth}px`);
				this.#fitNotch();
			});
			for (const box of [this.#bar, this.#notchPill, this.#notchBar, this.#drawer.el])
				this.#notchResizeObserver.observe(box);
		}
		window.addEventListener("resize", () => this.#syncPhoneViewport(), { signal });
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
				this.#syncSend();
			},
			{ signal },
		);
		this.#input.addEventListener(
			"blur",
			() => {
				if (!this.#input.value.trim()) this.#host.store.keepOptions();
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
		this.#scheduleContentReady();
	}

	#scheduleContentReady(): void {
		this.#cancelReady = afterPaint(() => {
			this.#cancelReady = undefined;
			if (this.#deactivated || this.#disposed || this.#contentReady) return;
			this.#contentReady = true;
			this.update();
		}, this.#active.signal);
	}

	#clearLocalLoadTimer(): void {
		if (this.#localLoadTimer !== undefined) {
			clearTimeout(this.#localLoadTimer);
			this.#localLoadTimer = undefined;
		}
	}

	#showLoading(kind: SurfaceSkeletonKind, label = t("Opening surface…")): void {
		this.#mountSlot.hidden = true;
		this.#reportSlot.hidden = true;
		this.#frames.hidden = true;
		this.#loadingSlot.hidden = false;
		if (this.#loadingKind !== kind) {
			this.#loadingKind = kind;
			this.#loadingSlot.replaceChildren(surfaceSkeleton(label, kind));
		}
	}

	#hideLoading(revealSlot?: HTMLElement): void {
		if (this.#loadingSlot.hidden) return;
		this.#loadingSlot.hidden = true;
		this.#loadingKind = "";
		this.#loadingSlot.replaceChildren();
		if (revealSlot) playOnce(revealSlot, "is-entering");
	}

	#disposeMount(): void {
		if (!this.#mount) return;
		this.#mount.dispose();
		this.#mount = undefined;
		this.#mountedFor = "";
		this.#mountSlot.replaceChildren();
	}

	#disposeAttachedReport(): void {
		if (!this.#attachedReport) return;
		this.#attachedReport.dispose();
		this.#attachedReport = undefined;
		this.#reportSlot.replaceChildren();
	}

	#clearFrames(): void {
		const hadFrames = this.#framesMode !== "none" || this.#compareDoors.size > 0;
		if (!hadFrames && this.#frames.hidden) return;
		this.#clearCompare();
		this.#primaryDoor.clear();
		if (hadFrames && this.#pointing && !this.#localFrame) this.#setPointing(false);
		this.#frames.classList.remove("is-compare");
		if (this.#framesMode !== "none") {
			this.#frames.replaceChildren();
			this.#framesMode = "none";
		}
		this.#framesShown = "";
		this.#frames.hidden = true;
	}

	get surface(): SurfaceSummary | undefined {
		return surfaceBySlug(this.#host.store.state, this.slug);
	}

	#wireBar(signal: AbortSignal): void {
		this.#notchBar.addEventListener("scroll", () => this.#markNotchCut(), { passive: true, signal });
		document.addEventListener(
			"pointerdown",
			(event) => {
				if (event.target instanceof Node && this.#bar.contains(event.target)) return;
				this.#closeBar();
			},
			{ capture: true, signal },
		);
		this.#bar.addEventListener(
			"focusout",
			(event) => {
				const next = event.relatedTarget;
				if (!(next instanceof Element) || this.#bar.contains(next)) return;
				if (next.closest(".context-menu, dialog, .surface-address-sheet")) return;
				this.#closeBar();
			},
			{ signal },
		);
		window.addEventListener(
			"blur",
			() => {
				setTimeout(() => {
					const focused = document.activeElement;
					if (!this.#deactivated && focused instanceof HTMLIFrameElement && this.el.contains(focused))
						this.#closeBar();
				}, 0);
			},
			{ signal },
		);
	}

	#barHeld(): boolean {
		return this.#address.isOpen || openMenu() !== undefined || document.querySelector("dialog[open]") !== null;
	}

	#closeBar(): boolean {
		if (!this.#barOpen || this.#barPinned || this.#barHeld()) return false;
		this.#setBarOpen(false);
		return true;
	}

	#setBarOpen(open: boolean): void {
		this.#barOpen = open;
		this.#paintNotch();
	}

	#paintNotch(): void {
		const open = this.#barOpen || this.#barPinned;
		this.#notch.classList.toggle("is-open", open);
		this.#notchPill.hidden = this.#barPinned;
		this.#notchPill.inert = open;
		this.#notchPill.setAttribute("aria-expanded", String(open));
		this.#notchBar.inert = !open;
		this.#fitNotch();
	}

	#fitNotch(): void {
		const layer = this.#notch.classList.contains("is-open") ? this.#notchBar : this.#notchPill;
		const width = layer.offsetWidth;
		const height = layer.offsetHeight;
		if (width > 0 && height > 0) {
			this.#notch.style.width = `${width}px`;
			this.#notch.style.height = `${height}px`;
		}
		for (const toggle of this.#notchBar.querySelectorAll<HTMLElement>(".surface-toggle")) this.#placeThumb(toggle);
		this.#markNotchCut();
	}

	#markNotchCut(): void {
		const bar = this.#notchBar;
		const hidden = bar.scrollWidth - bar.clientWidth;
		bar.classList.toggle("is-cut-start", hidden > 1 && bar.scrollLeft > 1);
		bar.classList.toggle("is-cut-end", hidden > 1 && bar.scrollLeft < hidden - 1);
	}

	#placeThumb(toggle: HTMLElement): void {
		const thumb = toggle.querySelector<HTMLElement>(".surface-toggle-thumb");
		const on = toggle.querySelector<HTMLElement>("button.is-on");
		if (!thumb || !on || on.offsetWidth === 0) return;
		const name = toggle.dataset.toggle ?? "";
		const next = [on.offsetLeft, on.offsetWidth] as const;
		const was = this.#thumbAt.get(name);
		if (!thumb.style.width && was && (was[0] !== next[0] || was[1] !== next[1])) {
			thumb.style.left = `${was[0]}px`;
			thumb.style.width = `${was[1]}px`;
			void thumb.offsetWidth;
		}
		thumb.style.left = `${next[0]}px`;
		thumb.style.width = `${next[1]}px`;
		this.#thumbAt.set(name, next);
	}

	focus(): void {
		if (!this.#input.disabled) this.#input.focus({ preventScroll: true });
	}

	deactivate(): void {
		if (this.#deactivated) return;
		this.#deactivated = true;
		this.#cancelReady?.();
		this.#cancelReady = undefined;
		this.#address.close();
		this.#clearLocalLoadTimer();
		this.#viewportResizeObserver?.disconnect();
		this.#viewportResizeObserver = undefined;
		this.#notchResizeObserver?.disconnect();
		this.#notchResizeObserver = undefined;
		this.#mount?.deactivate?.();
		this.#attachedReport?.deactivate();
		this.#active.abort();
		const ownSurfaceId = this.#lastSurfaceId || this.surface?.id;
		if (ownSurfaceId) {
			this.#host.store.clearActiveSurface(ownSurfaceId);
			if (this.#host.store.state.drawer?.surfaceId === ownSurfaceId) {
				this.#host.store.closeDrawer();
			}
		}
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.deactivate();
		this.#clearCompare();
		this.#primaryDoor.dispose();
		this.#attachedReport?.dispose();
		this.#attachedReport = undefined;
		this.#lifetime.abort();
		this.#mount?.dispose();
		this.#mount = undefined;
	}

	update(): void {
		if (this.#deactivated || this.#disposed) return;
		const store = this.#host.store;
		const state = store.state;
		const surface = this.surface;
		if (!surface) {
			this.#notchBar.replaceChildren();
			this.#bar.hidden = true;
			this.#panelToggle.hidden = true;
			this.#phoneBar.hidden = true;
			this.#banner.replaceChildren();
			this.#toast.replaceChildren();
			this.#topSlot.hidden = true;
			this.#composer.hidden = true;
			this.#clearFrames();
			this.#reportSlot.hidden = true;
			this.#clearLocalLoadTimer();
			this.#localHost = undefined;
			this.#localFrame = undefined;
			this.#localCover = undefined;
			this.#localSiteShown = "";
			this.#mountedFor = "";
			this.#barShown = "";
			this.#chromeShown = "";
			this.#toastShown = "";
			this.el.classList.remove("has-drawer", "has-banner", "is-pointing");
			this.#drawer.update(undefined);
			if (state.source === "loading") {
				this.#showLoading("live", t("Opening surface…"));
			} else {
				this.#hideLoading();
				this.#mountSlot.hidden = false;
				this.#mountSlot.replaceChildren(
					h("div", { class: "surface-empty" }, h("p", null, t("This surface isn't available."))),
				);
			}
			return;
		}
		this.#lastSurfaceId = surface.id;
		store.setActiveSurface(surface.id);
		this.#composer.hidden = false;
		const look = store.lookOf(surface);
		const workspace = state.workspaces[surface.id];
		const preview = workspace?.previewState;
		const reportMode = state.mode === "report" && look.kind !== "report" && surfaceHasReports(state, surface.id);
		const skeletonKind: SurfaceSkeletonKind =
			reportMode || look.kind === "report"
				? "report"
				: surface.archetype === "studio"
					? "studio"
					: surface.archetype === "ops"
						? "ops"
						: "live";
		this.#drawBar(surface);
		if (!this.#contentReady) {
			this.#showLoading(skeletonKind, t("Opening surface…"));
		} else {
			const liveBuild = surface.archetype === "live_build";
			const localLive = store.isLocalInteractive && isLocalSurfaceId(surface.id);
			const explorations = openExplorations(workspace);
			const targetExploration =
				liveBuild && !localLive && state.mode === "compare"
					? (explorations.find((item) => item.id === state.compareTargetId) ?? explorations[0])
					: undefined;
			const remoteCompare = Boolean(!reportMode && targetExploration && preview && workspace);
			const showPrimary = Boolean(
				!reportMode &&
					liveBuild &&
					!localLive &&
					!remoteCompare &&
					state.mode === "preview" &&
					preview !== undefined &&
					preview.primary.status !== "live_baseline",
			);
			const waitingForWorkspace = Boolean(
				!reportMode &&
					liveBuild &&
					!localLive &&
					state.source === "cloud" &&
					state.mode !== "live" &&
					!workspace &&
					store.isWorkspaceLoading(surface.id) &&
					(surface.pendingChangeCount > 0 || surface.activeSessionCount > 0 || !surface.siteSlug),
			);
			const waitingForMount = Boolean(
				!reportMode && !remoteCompare && !showPrimary && this.#host.isMountLoading?.(surface),
			);
			if (reportMode) {
				this.#clearFrames();
				if (surface.archetype === "live_build") this.#disposeMount();
				this.#mountSlot.hidden = true;
				this.#hideLoading(this.#reportSlot);
				this.#reportSlot.hidden = false;
				if (!this.#attachedReport) {
					this.#attachedReport = new SurfaceReportView({
						store,
						surface,
						signal: this.#lifetime.signal,
					});
					this.#reportSlot.replaceChildren(this.#attachedReport.el);
				}
				this.#attachedReport.update();
			} else if (remoteCompare || showPrimary) {
				this.#disposeAttachedReport();
				this.#reportSlot.hidden = true;
				if (surface.archetype === "live_build") this.#disposeMount();
				this.#hideLoading(this.#frames);
				this.#drawFrames(surface);
				const identityTokens = store.companyIdentityTokens();
				this.#primaryDoor.setIdentityTokens(identityTokens);
				for (const entry of this.#compareDoors.values()) entry.stage.setIdentityTokens(identityTokens);
			} else if (waitingForWorkspace || waitingForMount) {
				this.#disposeAttachedReport();
				this.#clearFrames();
				this.#showLoading(skeletonKind, t("Opening surface…"));
			} else {
				this.#disposeAttachedReport();
				this.#reportSlot.hidden = true;
				this.#clearFrames();
				this.#mountSlot.hidden = false;
				this.#drawMount(surface);
				this.#hideLoading(this.#mountSlot.querySelector(".skeleton-surface") ? undefined : this.#mountSlot);
			}
			if (this.#localHost) {
				if (this.#mountSlot.hidden) {
					// WHY: Unmount local srcdoc iframe while hidden so Chromium/Blink never re-attaches it in a 0x0 detached layout state.
					if (this.#localFrame) {
						this.#clearLocalLoadTimer();
						this.#localHost.replaceChildren();
						this.#localFrame = undefined;
						this.#localCover = undefined;
						this.#localHost.classList.remove("is-opening", "is-shown");
					}
					this.#localSiteShown = "";
				} else {
					this.#drawLocalLiveSite(surface);
				}
			}
		}
		this.#drawChrome(surface);
		this.#drawer.update(surface);
		this.#drawToast();
		const panelOpen = store.isPreviewPanelOpen(surface.id);
		this.el.classList.toggle("has-drawer", panelOpen);
		const effectiveDevice =
			reportMode || surface.archetype !== "live_build"
				? "desktop"
				: look.kind === "mobile_app"
					? "mobile"
					: supportsViewportSplit(surface, look)
						? state.device
						: "desktop";
		this.#viewport.dataset.device = effectiveDevice;
		this.#syncPhoneViewport();
	}

	#syncPhoneViewport(): void {
		const isMobile = this.#viewport.dataset.device === "mobile";
		this.#phoneBar.hidden = !isMobile;
		if (!isMobile) {
			this.#viewport.removeAttribute("data-phone-cutout");
			this.#viewport.style.removeProperty("--phone-w");
			this.#viewport.style.removeProperty("--phone-h");
			this.#viewport.style.removeProperty("--phone-r");
			this.#viewport.style.removeProperty("--phone-scale");
			return;
		}
		const model = phoneModelById(this.#phoneModelId);
		const rect = this.#viewport.getBoundingClientRect();
		const availW = rect.width > 0 ? Math.max(220, rect.width - 36) : model.width + 24;
		const availH = rect.height > 0 ? Math.max(260, rect.height - 208) : model.height + 24;
		const scale = Math.min(1, availW / (model.width + 20), availH / (model.height + 20));
		this.#viewport.dataset.phoneCutout = model.cutout;
		this.#viewport.style.setProperty("--phone-w", `${model.width}px`);
		this.#viewport.style.setProperty("--phone-h", `${model.height}px`);
		this.#viewport.style.setProperty("--phone-r", `${model.radius}px`);
		this.#viewport.style.setProperty("--phone-scale", scale.toFixed(4));

		const pct = Math.round(scale * 100);
		const barKey = `${model.id}:${pct}`;
		if (barKey === this.#phoneBarShown) return;
		this.#phoneBarShown = barKey;
		this.#phoneBar.replaceChildren(
			h(
				"div",
				{ class: "surface-phone-models" },
				...PHONE_MODELS.map((item) =>
					h(
						"button",
						{
							type: "button",
							class: `surface-phone-model${item.id === model.id ? " is-on" : ""}`,
							"aria-pressed": String(item.id === model.id),
							"data-act": "phone-model",
							"data-phone-model": item.id,
							title: `${item.label} (${item.width} × ${item.height})`,
						},
						item.shortLabel,
					),
				),
			),
			h(
				"span",
				{ class: "surface-phone-dims" },
				pct < 100 ? `${model.width} × ${model.height} · ${pct}%` : `${model.width} × ${model.height}`,
			),
		);
	}

	#drawBar(surface: SurfaceSummary): void {
		const store = this.#host.store;
		const state = store.state;
		const look = store.lookOf(surface);
		const workspace = state.workspaces[surface.id];
		const explorations = openExplorations(workspace);
		const plainSessions = (workspace?.activeSessions ?? []).filter((session) => !isOpenVariant(session, workspace));
		const studioHasChanges =
			surface.archetype === "studio" &&
			Boolean(
				workspace?.activeSessions.some((session) =>
					session.changes.some((change) => change.kind === "folder_patch" && isOpenChange(change)),
				),
			);
		const panelOpen = store.isPreviewPanelOpen(surface.id);
		const openWorkCount =
			plainSessions.reduce((sum, session) => sum + session.changes.filter(isOpenChange).length, 0) +
			explorations.length;
		const hasAgents = explorations.length + plainSessions.length > 0;
		const showViewportSplit = supportsViewportSplit(surface, look);
		const siteLive = this.#host.isSiteLive?.(surface) === true;
		const addressShown = surface.archetype === "live_build" && siteLive;
		const addressKey = this.#address.sync(
			addressShown,
			addressShown ? this.#host.siteHosting?.(surface) : undefined,
			surface.liveUrl,
		);
		const key = JSON.stringify([
			siteLive,
			addressKey,
			surface.id,
			surface.title,
			surface.archetype,
			look.kind,
			surface.liveUrl,
			surface.unpublishedChangeCount,
			state.mode,
			state.device,
			showViewportSplit,
			studioHasChanges,
			panelOpen,
			openWorkCount,
			hasAgents,
			Boolean(state.busy[`publish:${surface.id}`]),
			surface.publishStatus ?? "idle",
			store.peopleAtSurface(surface.slug).map((person) => [person.userId, person.name]),
			surface.publishAsk ?? null,
			Boolean(state.busy[`publish-ask:${surface.id}`]),
		]);
		if (key === this.#barShown) return;
		this.#barShown = key;
		const ask = surface.publishAsk ?? null;
		const askedMe = askedToPublish(surface, store.userId);
		const myAsk = ask && ask.askedByUserId === store.userId ? ask : null;
		const askKey = askedMe ? `${surface.id}:${ask!.askedAt}` : "";
		if (askKey && askKey !== this.#askShown) {
			this.#barOpen = true;
			if (state.mode === "live") queueMicrotask(() => store.setMode("preview"));
		}
		this.#askShown = askKey;

		const live = surface.archetype === "live_build";
		const effectiveMode: SurfacePreviewMode = state.mode === "compare" ? "preview" : state.mode;
		const toggle = (name: string, label: string, ...segments: HTMLElement[]) =>
			h(
				"div",
				{ class: "surface-toggle", role: "group", "aria-label": label, "data-toggle": name },
				h("i", { class: "surface-toggle-thumb", "aria-hidden": "true" }),
				...segments,
			);
		const modeSegment = (mode: SurfacePreviewMode, label: string, title: string) =>
			h(
				"button",
				{
					type: "button",
					class: effectiveMode === mode ? "is-on" : "",
					"aria-pressed": String(effectiveMode === mode),
					title,
					"data-act": "mode",
					"data-mode": mode,
				},
				label,
			);
		const deviceSegment = (device: "desktop" | "mobile", label: string, glyph: Element) =>
			h(
				"button",
				{
					type: "button",
					class: state.device === device ? "is-on" : "",
					"aria-pressed": String(state.device === device),
					"aria-label": label,
					"data-act": "device",
					"data-device": device,
				},
				glyph,
			);

		const groups: HTMLElement[] = [];
		const address = live ? this.#address.button() : null;
		if (address) groups.push(address);
		if (live) {
			groups.push(
				toggle(
					"mode",
					t("What the surface shows"),
					modeSegment("live", t("Live"), t("What visitors see right now")),
					modeSegment("preview", t("Preview"), t("Base with the changes you have turned on")),
				),
			);
		} else if (studioHasChanges || (surface.archetype === "studio" && state.mode === "report")) {
			groups.push(
				toggle(
					"mode",
					t("What the surface shows"),
					modeSegment("live", t("Base"), t("Saved studio files without open changes")),
					modeSegment("preview", t("Preview"), t("Base with the changes you have turned on")),
				),
			);
		}
		if (showViewportSplit) {
			groups.push(
				toggle(
					"device",
					t("Viewport"),
					deviceSegment("desktop", t("Desktop"), icon("computer")),
					deviceSegment("mobile", t("Mobile"), h("span", { class: "surface-phone-icon", "aria-hidden": "true" })),
				),
			);
		}

		const count = surface.unpublishedChangeCount;
		const presentHere = store.peopleAtSurface(surface.slug);
		if (presentHere.length > 0) {
			const presentLabel =
				presentHere.length === 1
					? t("{name} is here", { name: presentHere[0]!.name })
					: t("{names} are here", { names: presentHere.map((person) => person.name).join(", ") });
			groups.push(
				h(
					"span",
					{ class: "surface-pill-presence", title: presentLabel, "aria-label": presentLabel },
					...presentHere.slice(0, 3).map((person) => personAvatar(person.name, person.userId)),
					presentHere.length > 3
						? h("span", { class: "surface-pill-presence-more" }, `+${presentHere.length - 3}`)
						: null,
				),
			);
		}
		const publishBusy = Boolean(state.busy[`publish:${surface.id}`]) || surface.publishStatus === "publishing";
		const askBusy = Boolean(state.busy[`publish-ask:${surface.id}`]);
		const personName = (userId: string) => store.memberName(userId) ?? t("A teammate");
		if (askedMe && surface.archetype !== "ops" && count > 0 && !publishBusy) {
			const asker = personName(ask!.askedByUserId);
			const label = t("{name} asks you to publish", { name: firstName(asker) });
			groups.push(
				h(
					"div",
					{ class: "surface-publish has-changes is-asked", role: "group", "aria-label": label },
					h(
						"button",
						{ type: "button", class: "surface-publish-main", title: label, "data-act": "publish" },
						personAvatar(asker, ask!.askedByUserId),
						h("span", { class: "surface-publish-word" }, t("Publish")),
					),
					h(
						"button",
						{
							type: "button",
							class: "surface-publish-yes",
							disabled: askBusy,
							"aria-label": t("Yes, publish"),
							title: t("Yes, publish"),
							"data-act": "ask-yes",
						},
						icon("check"),
					),
					h(
						"button",
						{
							type: "button",
							class: "surface-publish-no",
							disabled: askBusy,
							"aria-label": t("No"),
							title: t("No"),
							"data-act": "ask-no",
						},
						icon("close"),
					),
				),
			);
		} else if (surface.archetype !== "ops" && (count > 0 || publishBusy)) {
			const askedUser = myAsk && !publishBusy ? myAsk.askedUserId : null;
			const saidNo = askedUser && myAsk?.status === "declined" ? firstName(personName(askedUser)) : null;
			groups.push(
				h(
					"div",
					{ class: `surface-publish${count ? " has-changes" : ""}${publishBusy ? " is-busy" : ""}` },
					h(
						"button",
						{
							type: "button",
							class: "surface-publish-main",
							disabled: publishBusy,
							title: publishBusy ? t("Publishing…") : t("Publish Base to the live surface"),
							"data-act": "publish",
						},
						publishBusy ? h("span", { class: "surface-state is-running", "aria-hidden": "true" }) : null,
						saidNo && askedUser ? personAvatar(personName(askedUser), askedUser) : null,
						publishBusy ? t("Publishing…") : saidNo ? t("{name} said no", { name: saidNo }) : t("Publish"),
						!publishBusy && !saidNo && count ? h("span", { class: "surface-notch-count" }, String(count)) : null,
						askedUser && !saidNo
							? h(
									"span",
									{
										class: "surface-publish-waiting",
										title: t("Waiting for {name}", { name: firstName(personName(askedUser)) }),
									},
									personAvatar(personName(askedUser), askedUser),
								)
							: null,
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
				),
			);
		}

		const panelLabel = panelOpen ? t("Close panel") : t("Preview panel");
		this.#panelToggle.hidden = !(surface.archetype !== "ops" || hasAgents);
		this.#panelToggle.setAttribute("aria-pressed", String(panelOpen));
		this.#panelToggle.setAttribute("aria-label", panelLabel);
		this.#panelToggle.title = panelLabel;
		this.#panelToggle.replaceChildren(
			icon("panel-right"),
			...(!panelOpen && openWorkCount > 0
				? [h("span", { class: "surface-panel-toggle-dot", "aria-hidden": "true" }, String(openWorkCount))]
				: []),
		);

		this.#bar.hidden = groups.length === 0;
		this.#barTitle.textContent = surface.title;
		const notchLabel =
			effectiveMode === "live"
				? live
					? t("Live")
					: t("Base")
				: effectiveMode === "report"
					? t("Notes")
					: t("Preview");
		const notchCount = count > 0 ? count : openWorkCount;
		this.#notchPill.replaceChildren(
			h("span", { class: "surface-notch-label" }, notchLabel),
			...(notchCount > 0 ? [h("span", { class: "surface-notch-count" }, String(notchCount))] : []),
		);
		const focused = document.activeElement;
		const focusKey =
			focused instanceof HTMLElement && this.#notchBar.contains(focused) ? barFocusKey(focused) : undefined;
		this.#notchBar.setAttribute("aria-label", surface.title);
		this.#notchBar.replaceChildren(
			...groups.flatMap((group, index) =>
				index === 0 ? [group] : [h("span", { class: "surface-pill-divider", "aria-hidden": "true" }), group],
			),
		);
		if (focusKey !== undefined)
			[...this.#notchBar.querySelectorAll<HTMLElement>("[data-act]")]
				.find((item) => barFocusKey(item) === focusKey)
				?.focus({ preventScroll: true });
		this.#barPinned = Boolean(address) && this.#address.mark() === "private";
		if (this.#barPinned) this.#barOpen = true;
		this.#paintNotch();
	}

	#drawMount(surface: SurfaceSummary): void {
		const store = this.#host.store;
		const look = store.lookOf(surface);
		const key = `${surface.id}:${surface.siteSlug ?? ""}:${surface.archetype}:${look.kind}`;
		if (key !== this.#mountedFor) {
			this.#mount?.dispose();
			this.#clearLocalLoadTimer();
			this.#localHost = undefined;
			this.#localFrame = undefined;
			this.#localCover = undefined;
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
							surfaceTile(surface, look, "is-hero"),
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

	#createLocalFrame(title: string, html: string, attachInspector: boolean, onLoad?: () => void): HTMLIFrameElement {
		const frame = h("iframe", {
			class: "surface-frame surface-local-frame",
			sandbox: "allow-scripts",
			title,
		});
		frame.addEventListener(
			"load",
			() => {
				if (attachInspector) {
					frame.contentWindow?.postMessage({ type: SURFACE_INSPECTOR_MODE_MESSAGE, active: this.#pointing }, "*");
				}
				applyIdentityTokensToFrame(frame, this.#host.store.companyIdentityTokens());
				onLoad?.();
			},
			{ signal: this.#active.signal, once: true },
		);
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
		const identityTokens = store.companyIdentityTokens();
		const exploration = openExplorations(workspace)[0];
		const pickedId = exploration ? store.pickedVariant(exploration) : undefined;
		const appliedChanges =
			mode === "live"
				? []
				: (workspace?.activeSessions ?? []).flatMap((session) => {
						if (isOpenVariant(session, workspace) && session.id !== pickedId) return [];
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
			identityTokens?.css ?? "",
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
			identityTokens,
		);
		const firstOpen = !host.classList.contains("is-shown");
		const cover = firstOpen
			? h("div", { class: "surface-local-cover" }, surfaceSkeleton(t("Opening surface…"), "live"))
			: undefined;
		let frame: HTMLIFrameElement;
		const reveal = () => {
			if (this.#localFrame !== frame) return;
			this.#clearLocalLoadTimer();
			host.classList.remove("is-opening");
			host.classList.add("is-shown");
			if (this.#localCover === cover) {
				cover?.remove();
				this.#localCover = undefined;
			}
		};
		// WHY: Mount a fresh iframe element on every document swap so Blink always lays out and paints srcdoc cleanly.
		frame = this.#createLocalFrame(t("Preview of {title}", { title: surface.title }), html, true, reveal);
		this.#localFrame = frame;
		this.#localCover = cover;
		this.#clearLocalLoadTimer();
		if (firstOpen && cover) {
			host.classList.add("is-opening");
			host.replaceChildren(frame, cover);
			this.#localLoadTimer = setTimeout(reveal, 1500);
		} else {
			host.classList.remove("is-opening");
			host.classList.add("is-shown");
			host.replaceChildren(frame);
		}
		applyIdentityTokensToFrame(frame, identityTokens);
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
		const liveBuild = surface.archetype === "live_build";
		const explorations = openExplorations(workspace);
		const localLive = store.isLocalInteractive && isLocalSurfaceId(surface.id);
		const targetExploration =
			liveBuild && !localLive && state.mode === "compare"
				? (explorations.find((item) => item.id === state.compareTargetId) ?? explorations[0])
				: undefined;
		const remoteCompare = Boolean(targetExploration && preview && workspace);
		const showPrimary =
			liveBuild &&
			!remoteCompare &&
			state.mode === "preview" &&
			preview !== undefined &&
			preview.primary.status !== "live_baseline";

		const key = JSON.stringify([state.mode, remoteCompare, targetExploration?.id, showPrimary, preview, surface.id]);
		if (key === this.#framesShown) return;
		this.#framesShown = key;
		this.#frames.classList.toggle("is-compare", remoteCompare);

		if (remoteCompare && preview && targetExploration && workspace) {
			if (this.#pointing) this.#setPointing(false);
			this.#primaryDoor.clear();
			if (this.#framesMode !== "compare") {
				this.#primaryDoor.el.remove();
				this.#frames.replaceChildren(this.#compareColumns);
				this.#framesMode = "compare";
			}
			const variantSessions = workspace.activeSessions.filter(
				(session) => session.explorationId === targetExploration.id,
			);
			const keep = new Set(variantSessions.map((session) => session.id));
			for (const [id, entry] of this.#compareDoors) {
				if (keep.has(id)) continue;
				entry.abort.abort();
				entry.stage?.dispose();
				entry.column.remove();
				this.#compareDoors.delete(id);
			}
			for (const session of variantSessions) {
				const compared = preview.compareFrames.find((item) => item.sessionId === session.id);
				const label = compared?.label ?? session.explorationVariantLabel ?? session.title;
				const frameState = compared
					? compared.frame
					: { ...preview.primary, status: "building" as const, doorActionUrl: null, memberPass: null };
				let entry = this.#compareDoors.get(session.id);
				const buildHead = (): HTMLElement =>
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
								"data-exploration": targetExploration.id,
								"data-session": session.id,
							},
							t("Use this one"),
						),
					);
				if (!entry) {
					const abort = new AbortController();
					const head = buildHead();
					const stage = new SurfaceDoorStage(abort.signal, {
						onRetry: () => void store.retryPreview(surface.id),
						isPassUsable: (previewId, pass) => store.isPreviewPassUsable(previewId, pass),
						onPassSent: (previewId, pass) => store.markPreviewPassConsumed(previewId, pass),
						onNeedFreshPass: (previewId, stalePass) => store.remintPreviewPass(surface.id, previewId, stalePass),
					});
					stage.setIdentityTokens(store.companyIdentityTokens());
					const column = h("div", { class: "surface-compare-column" }, head, stage.el);
					entry = { stage, column, head, abort };
					this.#compareDoors.set(session.id, entry);
					this.#compareColumns.append(entry.column);
				} else {
					const nextHead = buildHead();
					entry.head.replaceWith(nextHead);
					entry = { ...entry, head: nextHead };
					this.#compareDoors.set(session.id, entry);
				}
				entry.stage?.sync(frameState, label);
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
		const instead = store.insteadOf(surface.id);
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
			instead?.id,
		]);
		if (key === this.#chromeShown) return;
		this.#chromeShown = key;
		this.#input.disabled = !canStart;
		this.#input.placeholder = !canStart
			? t("Sessions start once Surfaces are enabled for this company")
			: instead
				? t("What should it be instead?")
				: surface.archetype === "ops"
					? opsComposerPlaceholder(store.lookOf(surface).kind)
					: t("Describe a change — it runs as its own session");
		if (instead?.id !== this.#insteadShown) {
			this.#insteadShown = instead?.id;
			if (instead && canStart) this.#input.focus({ preventScroll: true });
		}
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
		this.#topSlot.hidden = this.#banner.childElementCount === 0;
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
		if (event.key === "Escape" && this.#pointing) {
			event.preventDefault();
			this.#setPointing(false);
			return;
		}
		if (event.key === "Escape") {
			const inside = this.#bar.contains(document.activeElement);
			if (this.#closeBar() && inside) this.#notchPill.focus();
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

	#drawToast(): void {
		const undo = this.#host.store.state.undo;
		const key = undo ? `${undo.id}:${undo.pending ? "p" : "r"}` : "";
		if (key === this.#toastShown) return;
		this.#toastShown = key;
		this.#toast.replaceChildren(
			undo
				? undo.pending
					? h(
							"div",
							{ class: "surface-toast is-pending" },
							h("span", { class: "surface-state is-running", "aria-hidden": "true" }),
							h("span", null, t("Merging “{title}”…", { title: undo.label })),
						)
					: h(
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
							undo.verb === "merged"
								? h(
										"button",
										{ type: "button", class: "surface-toast-review", "data-act": "open-publish" },
										t("Publish"),
									)
								: null,
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

	#syncSend(): void {
		this.#send.classList.toggle("is-ready", this.#input.value.trim().length > 0 && !this.#images.problem);
	}

	async #submit(): Promise<void> {
		const surface = this.surface;
		const text = this.#input.value.trim();
		if (!surface || !text || this.#input.disabled || this.#images.problem) return;
		const target = this.#target;
		const options: StartSurfaceSessionOptions = target
			? { target, originKind: "point_to_change", originLabel: targetOriginLabel(target) }
			: {};
		const files = this.#images.files;
		const instead = this.#host.store.insteadOf(surface.id);
		this.#input.value = "";
		growToText(this.#input);
		this.#images.set([]);
		const session = await this.#host.store.startSession(surface.id, text, options, files);
		if (session && instead) void this.#host.store.discardExploration(instead);
		if (!session) {
			if (!this.#input.value) {
				this.#input.value = text;
				growToText(this.#input);
			}
			if (!this.#images.files.length) this.#images.set(files);
			this.#syncSend();
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
			case "phone-model": {
				const model = phoneModelById(target.dataset.phoneModel);
				this.#phoneModelId = model.id;
				try {
					localStorage.setItem(PHONE_MODEL_KEY, model.id);
				} catch {
					/* WHY: Local browser storage is optional in private/sandboxed contexts. */
				}
				this.#phoneBarShown = "";
				this.#syncPhoneViewport();
				return;
			}
			case "address":
				this.#address.toggle(event.detail === 0);
				return;
			case "expand-pill":
				this.#setBarOpen(true);
				if (event.detail === 0)
					(
						this.#notchBar.querySelector<HTMLElement>("button.is-on") ??
						this.#notchBar.querySelector<HTMLElement>("button:not(:disabled)")
					)?.focus();
				return;
			case "toggle-panel":
				store.togglePreviewPanel(surface.id);
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
			case "ask-yes":
				void store.publish(surface.id);
				return;
			case "ask-no":
				void store.declinePublishAsk(surface.id);
				return;
			case "publish":
			case "open-publish":
				openPublishSheet(store, surface);
				return;
			case "publish-menu": {
				const box = target.getBoundingClientRect();
				const items = [];
				if (surface.liveUrl) {
					const url = surface.liveUrl;
					items.push({
						label: t("Open {host}", { host: hostOf(url) }),
						icon: "external",
						select: () => window.open(url, "_blank", "noopener"),
					});
				}
				items.push({
					label: t("Auto-publish on Approve"),
					hint: t("Approved changes go live without a separate Publish."),
					checked: surface.autoPublish,
					multiple: true,
					select: () => void store.setAutoPublish(surface.id, !surface.autoPublish),
				});
				openContextMenu({
					label: t("Publish options"),
					x: box.left,
					y: box.bottom + 4,
					opener: target,
					items,
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
