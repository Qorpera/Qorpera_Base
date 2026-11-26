import type { StartSurfaceSessionOptions } from "@qorpera/cloud-client/surfaces";
import {
	type PointToChangeTarget,
	parsePointToChangeTarget,
	SURFACE_INSPECTOR_MODE_MESSAGE,
	SURFACE_INSPECTOR_PICK_MESSAGE,
	type SurfaceSummary,
	surfacePageKind,
} from "@qorpera/contracts";
import { reviveFigures } from "../../ui/avatar.ts";
import { type ContextMenu, type MenuEntry, openContextMenu, openMenu } from "../../ui/context-menu.ts";
import { growToText, h, icon, personAvatar } from "../../ui/dom.ts";
import { reviveGroupAvatars } from "../../ui/group-avatar.ts";
import { playOnce } from "../../ui/motion.ts";
import { t } from "../../ui/preferences.ts";
import { uiScale } from "../../ui/scale.ts";
import { type SurfaceSkeletonKind, surfaceSkeleton } from "../../ui/skeleton.ts";
import { afterPaint } from "../../ui/time-slice.ts";
import { opsComposerPlaceholder, supportsViewportSplit } from "../surface-kinds.ts";
import {
	askedToPublish,
	clampSurfaceZoom,
	DEFAULT_SURFACE_ZOOM,
	getLocalSandbox,
	isLocalSurfaceId,
	isOpenChange,
	isOpenVariant,
	loadLocalSandbox,
	MAX_SURFACE_ZOOM,
	MIN_SURFACE_ZOOM,
	migrationPending,
	openExplorations,
	runningSessionTotal,
	SURFACE_ZOOM_LEVELS,
	type SurfacePreviewMode,
	type SurfacesStore,
	stepSurfaceZoom,
	surfaceBySlug,
	surfaceHasDeliverables,
} from "../surfaces-store.ts";
import { type AddressMark, SurfaceAddress, type SurfaceSiteHosting } from "./surface-address-sheet.ts";
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
	readonly isSiteLive?: (surface: SurfaceSummary) => boolean | undefined;
	readonly loadStudioFiles?: (
		surface: SurfaceSummary,
		signal: AbortSignal,
	) => Promise<Readonly<Record<string, string>>>;
	readonly siteHosting?: (surface: SurfaceSummary) => SurfaceSiteHosting | undefined;
	readonly managesSites?: () => boolean;
	readonly canWrite?: () => boolean;
}

interface CompareColumn {
	readonly stage: SurfaceDoorStage;
	readonly column: HTMLElement;
	readonly head: HTMLElement;
	readonly abort: AbortController;
}

const PHONE_MODEL_KEY = "qorpera.web.surface-phone-model.v1";
export const GO_LIVE_PUBLISH_WAIT_MS = 5 * 60_000;
const AUTO_PUBLISH_OFF_QUIET_TRIES = 3;

interface PhoneModelSpec {
	readonly id: string;
	readonly label: string;
	readonly group?: string;
	readonly width: number;
	readonly height: number;
	readonly radius: number;
	readonly cutout: "island" | "notch" | "punch" | "none";
	readonly notch?: number;
	readonly status: number;
}

type PhoneShape = Pick<PhoneModelSpec, "width" | "height" | "radius" | "cutout" | "notch" | "status">;

const ISLAND_6_1: PhoneShape = { width: 393, height: 852, radius: 50, cutout: "island", status: 54 };
const ISLAND_6_3: PhoneShape = { width: 402, height: 874, radius: 52, cutout: "island", status: 54 };
const ISLAND_6_5: PhoneShape = { width: 420, height: 912, radius: 53, cutout: "island", status: 54 };
const ISLAND_6_7: PhoneShape = { width: 430, height: 932, radius: 54, cutout: "island", status: 54 };
const ISLAND_6_9: PhoneShape = { width: 440, height: 956, radius: 54, cutout: "island", status: 54 };
const NOTCH_6_1: PhoneShape = { width: 390, height: 844, radius: 47, cutout: "notch", notch: 162, status: 47 };
const NOTCH_6_7: PhoneShape = { width: 428, height: 926, radius: 53, cutout: "notch", notch: 162, status: 47 };
const NOTCH_MINI: PhoneShape = { width: 375, height: 812, radius: 44, cutout: "notch", notch: 172, status: 50 };
const WIDE_NOTCH = { notch: 210 } as const;

function iphone(group: string, name: string, shape: PhoneShape, extra: Partial<PhoneShape> = {}): PhoneModelSpec {
	const label = `iPhone ${name}`;
	const id = label.toLowerCase().replace(/\s+/g, "-");
	return { id, label, group, ...shape, ...extra };
}

const PHONE_MODELS: readonly PhoneModelSpec[] = [
	iphone("iPhone 18", "18 Pro", ISLAND_6_3),
	iphone("iPhone 18", "18 Pro Max", ISLAND_6_9),
	iphone("iPhone 17", "17", ISLAND_6_3),
	iphone("iPhone 17", "Air", ISLAND_6_5),
	iphone("iPhone 17", "17 Pro", ISLAND_6_3),
	iphone("iPhone 17", "17 Pro Max", ISLAND_6_9),
	iphone("iPhone 17", "17e", NOTCH_6_1),
	iphone("iPhone 16", "16", ISLAND_6_1),
	iphone("iPhone 16", "16 Plus", ISLAND_6_7),
	iphone("iPhone 16", "16 Pro", ISLAND_6_3),
	iphone("iPhone 16", "16 Pro Max", ISLAND_6_9),
	iphone("iPhone 16", "16e", NOTCH_6_1),
	iphone("iPhone 15", "15", ISLAND_6_1),
	iphone("iPhone 15", "15 Plus", ISLAND_6_7),
	iphone("iPhone 15", "15 Pro", ISLAND_6_1),
	iphone("iPhone 15", "15 Pro Max", ISLAND_6_7),
	iphone("iPhone 14", "14", NOTCH_6_1),
	iphone("iPhone 14", "14 Plus", NOTCH_6_7),
	iphone("iPhone 14", "14 Pro", ISLAND_6_1),
	iphone("iPhone 14", "14 Pro Max", ISLAND_6_7),
	iphone("iPhone 13", "13 mini", NOTCH_MINI),
	iphone("iPhone 13", "13", NOTCH_6_1),
	iphone("iPhone 13", "13 Pro", NOTCH_6_1),
	iphone("iPhone 13", "13 Pro Max", NOTCH_6_7),
	iphone("iPhone 12", "12 mini", NOTCH_MINI, { notch: 200 }),
	iphone("iPhone 12", "12", NOTCH_6_1, WIDE_NOTCH),
	iphone("iPhone 12", "12 Pro", NOTCH_6_1, WIDE_NOTCH),
	iphone("iPhone 12", "12 Pro Max", NOTCH_6_7, WIDE_NOTCH),
	{
		id: "iphone-se",
		label: "iPhone SE",
		width: 375,
		height: 667,
		radius: 26,
		cutout: "none",
		status: 20,
	},
	{
		id: "pixel-9",
		label: "Pixel 9",
		width: 412,
		height: 915,
		radius: 36,
		cutout: "punch",
		status: 40,
	},
];

/* WHY: Jonas 26 Nov: the phone reads best a little larger than life, so it rests at 110 % of its real size. */
const PHONE_RESTING_SCALE = 1.1;
const DEFAULT_PHONE_MODEL = PHONE_MODELS.find((model) => model.id === "iphone-16") ?? PHONE_MODELS[0]!;

const PHONE_BODY_EDGE = 16;

function phoneStatusIcons(): SVGSVGElement {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("class", "surface-phone-signal");
	svg.setAttribute("viewBox", "0 0 70 13");
	svg.innerHTML =
		'<rect x="0" y="8" width="3.2" height="4.5" rx="1"/><rect x="5" y="5.5" width="3.2" height="7" rx="1"/>' +
		'<rect x="10" y="3" width="3.2" height="9.5" rx="1"/><rect x="15" y=".5" width="3.2" height="12" rx="1"/>' +
		'<path d="M30.5 3.1c2.3 0 4.4.9 6 2.4l1.2-1.2a10.1 10.1 0 0 0-14.4 0l1.2 1.2a8.4 8.4 0 0 1 6-2.4Zm0 3.4c1.4 0 2.6.5 3.6 1.4l1.2-1.2a6.8 6.8 0 0 0-9.6 0l1.2 1.2c1-.9 2.2-1.4 3.6-1.4Zm0 3.3c.5 0 1 .2 1.3.5l-1.3 1.2-1.3-1.2c.3-.3.8-.5 1.3-.5Z"/>' +
		'<rect x="43.5" y=".5" width="23" height="12" rx="3.8" fill="none" stroke="currentColor" opacity=".35"/>' +
		'<rect x="45" y="2" width="20" height="9" rx="2.5"/><path d="M68 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2Z" opacity=".4"/>';
	return svg;
}

function phoneModelById(id: string | null | undefined): PhoneModelSpec {
	return PHONE_MODELS.find((model) => model.id === id) ?? DEFAULT_PHONE_MODEL;
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
	return `${element.dataset.act ?? ""}:${element.dataset.mode ?? element.dataset.device ?? element.dataset.zoomTarget ?? element.dataset.phoneModel ?? ""}`;
}

function restoreBarFocus(container: HTMLElement, focusKey: string | undefined): void {
	if (focusKey === undefined) return;
	const buttons = [...container.querySelectorAll<HTMLElement>("[data-act]")];
	const exact = buttons.find((item) => barFocusKey(item) === focusKey);
	if (exact && !(exact instanceof HTMLButtonElement && exact.disabled)) {
		exact.focus({ preventScroll: true });
		return;
	}
	if (focusKey.startsWith("zoom-out:") || focusKey.startsWith("zoom-in:")) {
		const target = focusKey.slice(focusKey.indexOf(":") + 1);
		container
			.querySelector<HTMLElement>(`[data-act="zoom-menu"][data-zoom-target="${target}"]`)
			?.focus({ preventScroll: true });
	}
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
	#active = new AbortController();
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
	readonly #showPanels = h(
		"button",
		{
			type: "button",
			class: "surface-show-panels",
			"aria-label": t("Show panels"),
			title: t("Show panels"),
			"data-act": "show-panels",
			hidden: true,
		},
		icon("show"),
	);
	readonly #composeOpen = h(
		"button",
		{
			type: "button",
			class: "surface-compose-open",
			"aria-label": t("Describe a change"),
			"data-act": "open-composer",
		},
		icon("edit"),
	);
	readonly #notch = h("div", { class: "surface-notch" }, this.#notchPill, this.#notchBar);
	readonly #panelToggle = h("button", {
		type: "button",
		class: "surface-panel-toggle",
		"data-act": "toggle-panel",
		hidden: true,
	});
	readonly #phoneModelCorner = h("div", { class: "surface-phone-corner is-start", hidden: true });
	readonly #phoneZoomCorner = h("div", { class: "surface-phone-corner is-end", hidden: true });
	readonly #phoneBody = h(
		"div",
		{ class: "surface-phone-body", "aria-hidden": "true" },
		...["action", "volume-up", "volume-down", "side"].map((part) =>
			h("i", { class: `surface-phone-button is-${part}` }),
		),
	);
	readonly #phoneGlass = h(
		"div",
		{ class: "surface-phone-glass", "aria-hidden": "true" },
		h(
			"div",
			{ class: "surface-phone-status" },
			h("span", { class: "surface-phone-clock" }, "9:41"),
			phoneStatusIcons(),
		),
		h("div", { class: "surface-phone-home" }),
	);
	readonly #topSlot = h("div", { class: "surface-top-slot", hidden: true });
	readonly #stage = h("div", { class: "surface-stage" });
	readonly #canvas = h("div", { class: "surface-canvas" });
	readonly #viewport = h("div", { class: "surface-viewport" });
	readonly #viewportBody = h("div", { class: "surface-viewport-body" });
	readonly #phoneSizer = h("div", { class: "surface-phone-sizer" });
	readonly #loadingSlot = h("div", { class: "surface-loading", hidden: true });
	readonly #mountSlot = h("div", { class: "surface-mount" });
	readonly #reportSlot = h("div", { class: "surface-report-slot", hidden: true });
	readonly #compareColumns = h("div", { class: "surface-compare-columns" });
	readonly #frames = h("div", { class: "surface-frames", hidden: true });
	readonly #banner = h("div", { class: "surface-banners" });
	readonly #chips = h("div", { class: "surface-chips" });
	readonly #targetRow = h("div", { class: "surface-target-row" });
	readonly #plus = h(
		"button",
		{
			type: "button",
			class: "surface-plus",
			"aria-label": t("Point or attach"),
			title: t("Point or attach"),
			"aria-haspopup": "menu",
			"aria-expanded": "false",
			hidden: true,
		},
		icon("plus"),
	);
	readonly #input = h("textarea", { class: "surface-input", rows: 1 });
	readonly #send = h("button", { type: "submit", class: "surface-send" }, icon("send"));
	readonly #shell = h(
		"div",
		{ class: "surface-composer-shell" },
		this.#showPanels,
		this.#composeOpen,
		this.#plus,
		this.#input,
		this.#send,
	);
	readonly #composer = h("form", { class: "surface-composer" }, this.#chips, this.#targetRow, this.#shell);
	readonly #images: SurfaceComposerImages;
	readonly #toast = h("div", { class: "surface-toast-host", role: "status" });
	readonly #drawer: SurfaceSessionDrawer;
	readonly #primaryDoor: SurfaceDoorStage;
	readonly #address: SurfaceAddress;
	readonly #compareDoors = new Map<string, CompareColumn>();
	#framesMode: "none" | "primary" | "compare" = "none";
	#pointing = false;
	#pointVisible = false;
	#pointEnabled = false;
	#plusMenu: ContextMenu | undefined;
	#plusShutBy: Event | undefined;
	#plusShuts = false;
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
	#parked = false;
	#needsRevive = false;
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
	#hasNotch = false;
	#panelsHidden = false;
	#peekTimer: ReturnType<typeof setTimeout> | undefined;
	readonly #thumbAt = new Map<string, readonly [number, number]>();
	#phoneModelId = DEFAULT_PHONE_MODEL.id;
	#phoneBarShown = "";
	#lastPhoneZoom = DEFAULT_SURFACE_ZOOM;
	#sitePublic = true;
	readonly #autoPublishAsked = new Set<string>();
	readonly #publishedAt = new Map<string, string>();
	readonly #autoPublishOffOwed = new Map<string, { tries: number; at: SurfaceSummary | undefined }>();
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
		const lifetimeSignal = this.#lifetime.signal;
		const activeSignal = this.#active.signal;
		this.#images = new SurfaceComposerImages(this.#shell, lifetimeSignal, () => this.#syncSend());
		this.#composer.insertBefore(this.#images.tray.el, this.#shell);
		this.#composer.append(this.#images.tray.status);
		this.#images.setAvailable(host.store.canAttachImages);
		this.#drawer = new SurfaceSessionDrawer(host.store, lifetimeSignal);
		this.#primaryDoor = new SurfaceDoorStage(this.#lifetime.signal, {
			onPick: (target) => {
				if (!this.#deactivated && !this.#parked) this.#onPick(target);
			},
			onShownChange: () => {
				if (this.#deactivated || this.#parked) return;
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
				if (this.#deactivated || this.#parked) return Promise.resolve(false);
				const surface = this.surface;
				return surface ? host.store.remintPreviewPass(surface.id, previewId, stalePass) : Promise.resolve(false);
			},
		});
		this.#topSlot.append(this.#banner);
		this.#phoneSizer.append(
			this.#phoneBody,
			this.#loadingSlot,
			this.#mountSlot,
			this.#reportSlot,
			this.#frames,
			this.#phoneGlass,
		);
		this.#viewportBody.append(this.#phoneSizer);
		this.#viewport.append(this.#viewportBody);
		this.#bar.append(this.#barTitle, this.#phoneModelCorner, this.#notch, this.#phoneZoomCorner);
		this.#canvas.append(this.#bar, this.#topSlot, this.#viewport, this.#composer, this.#toast);
		this.#address = new SurfaceAddress({
			container: this.#canvas,
			canManage: () => host.managesSites?.() === true,
			changed: () => {
				const surface = this.surface;
				if (!surface || this.#deactivated || this.#parked) return;
				this.#drawBar(surface);
				this.#drawToast();
			},
			beforePublic: () => this.#publishBeforeLive(),
			publicChanged: (isPublic) => {
				const surface = this.surface;
				if (!surface) return;
				if (isPublic) {
					this.#autoPublishOffOwed.set(surface.id, { tries: 0, at: undefined });
					return;
				}
				this.#autoPublishOffOwed.delete(surface.id);
				if (!surface.autoPublish) void host.store.setAutoPublish(surface.id, true, { quiet: true });
			},
			slugChanged: ({ slug, url }) => {
				const surface = this.surface;
				if (!surface) return;
				host.store.noteSiteSlug(surface.id, slug, url);
			},
			signal: lifetimeSignal,
		});
		this.#stage.append(this.#canvas, this.#drawer.el);
		this.el.append(this.#stage, this.#panelToggle);
		this.#notchBar.addEventListener("scroll", () => this.#markNotchCut(), { passive: true, signal: lifetimeSignal });
		this.#bar.addEventListener(
			"focusout",
			(event) => {
				if (this.#deactivated || this.#parked) return;
				const next = event.relatedTarget;
				if (!(next instanceof Element) || this.#bar.contains(next)) return;
				if (next.closest(".context-menu, dialog, .surface-address-sheet")) return;
				this.#closeBar();
			},
			{ signal: lifetimeSignal },
		);
		this.#wireActive(activeSignal);
		this.#attachObservers();
		this.#composer.addEventListener(
			"pointerover",
			(event) => {
				if (this.#composeOpen.getClientRects().length === 0) {
					this.#composer.classList.add("is-peek");
					return;
				}
				clearTimeout(this.#peekTimer);
				if (!this.#composeOpen.contains(event.target as Node)) return;
				// WHY: A pointer sweeping left to the eye crosses the pencil; opening at once would slide the eye away.
				this.#peekTimer = setTimeout(() => this.#composer.classList.add("is-peek"), 120);
			},
			{ signal: lifetimeSignal },
		);
		this.#composer.addEventListener(
			"pointerleave",
			() => {
				clearTimeout(this.#peekTimer);
				this.#composer.classList.remove("is-peek");
			},
			{ signal: lifetimeSignal },
		);
		lifetimeSignal.addEventListener("abort", () => clearTimeout(this.#peekTimer));
		this.#plus.addEventListener(
			"pointerdown",
			(event) => {
				this.#plusShuts = event === this.#plusShutBy;
			},
			{ signal: lifetimeSignal },
		);
		this.#plus.addEventListener(
			"click",
			(event) => {
				// WHY: The press that shut the open menu ends in this click; a keyboard click has no press before it.
				const shut = this.#plusShuts && event.detail > 0;
				this.#plusShuts = false;
				if (shut || this.#deactivated || this.#parked) return;
				this.#openPlusMenu();
			},
			{ signal: lifetimeSignal },
		);
		this.#composer.addEventListener(
			"submit",
			(event) => {
				event.preventDefault();
				if (this.#deactivated || this.#parked) return;
				void this.#submit();
			},
			{ signal: lifetimeSignal },
		);
		this.#input.addEventListener(
			"input",
			() => {
				if (this.#deactivated || this.#parked) return;
				growToText(this.#input);
				this.#syncSend();
			},
			{ signal: lifetimeSignal },
		);
		this.#input.addEventListener(
			"blur",
			() => {
				if (this.#deactivated || this.#parked) return;
				if (!this.#input.value.trim()) this.#host.store.keepOptions();
			},
			{ signal: lifetimeSignal },
		);
		this.#input.addEventListener(
			"keydown",
			(event) => {
				if (this.#deactivated || this.#parked) return;
				if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
					event.preventDefault();
					void this.#submit();
				}
			},
			{ signal: lifetimeSignal },
		);
		this.el.addEventListener(
			"click",
			(event) => {
				if (this.#deactivated || this.#parked) return;
				this.#click(event);
			},
			{ signal: lifetimeSignal },
		);
		// WHY: Skip the deferred skeleton flash when returning to a surface whose workspace is already warm in SurfacesStore.
		const warmSurface = surfaceBySlug(host.store.state, slug);
		const warmReady = Boolean(
			warmSurface && host.store.state.workspaces[warmSurface.id] && host.isMountLoading?.(warmSurface) !== true,
		);
		void host.store.openSurface(slug);
		if (warmReady) this.#contentReady = true;
		else this.#scheduleContentReady();
	}

	#attachObservers(): void {
		if (typeof ResizeObserver === "undefined") return;
		this.#viewportResizeObserver ??= new ResizeObserver(() => this.#syncPhoneViewport());
		this.#viewportResizeObserver.observe(this.#viewport);
		this.#notchResizeObserver ??= new ResizeObserver(() => {
			this.el.style.setProperty("--surface-drawer-shown", `${this.#drawer.el.offsetWidth}px`);
			this.#fitNotch();
		});
		for (const box of [this.#bar, this.#notchPill, this.#notchBar, this.#drawer.el])
			this.#notchResizeObserver.observe(box);
	}

	#wireActive(signal: AbortSignal): void {
		document.addEventListener(
			"pointerdown",
			(event) => {
				if (event.target instanceof Node && this.#bar.contains(event.target)) return;
				this.#closeBar();
			},
			{ capture: true, signal },
		);
		window.addEventListener(
			"blur",
			() => {
				setTimeout(() => {
					const focused = document.activeElement;
					if (
						!this.#deactivated &&
						!this.#parked &&
						focused instanceof HTMLIFrameElement &&
						this.el.contains(focused)
					)
						this.#closeBar();
				}, 0);
			},
			{ signal },
		);
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
		window.addEventListener("keydown", (event) => this.#keydown(event), { signal });
	}

	#scheduleContentReady(): void {
		this.#cancelReady = afterPaint(() => {
			this.#cancelReady = undefined;
			if (this.#deactivated || this.#parked || this.#disposed || this.#contentReady) return;
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

	#barHeld(): boolean {
		return this.#address.isOpen || openMenu() !== undefined || document.querySelector("dialog[open]") !== null;
	}

	#closeBar(): boolean {
		if (!this.#barOpen || this.#barPinned || this.#barHeld()) return false;
		this.#setBarOpen(false);
		return true;
	}

	#setBarOpen(open: boolean): void {
		this.#barOpen = open && this.#hasNotch;
		this.#paintNotch();
	}

	#paintNotch(): void {
		const hidden = this.#panelsHidden;
		const notchHidden = hidden || !this.#hasNotch;
		const open = !notchHidden && (this.#barOpen || this.#barPinned);
		this.el.classList.toggle("is-panels-hidden", hidden);
		this.#notch.classList.toggle("is-open", open);
		this.#notch.hidden = notchHidden;
		this.#showPanels.hidden = !hidden;
		this.#composeOpen.hidden = !hidden;
		this.#notchPill.hidden = notchHidden || this.#barPinned;
		this.#notchPill.inert = open || notchHidden;
		this.#notchPill.setAttribute("aria-expanded", String(open));
		this.#notchBar.hidden = notchHidden;
		this.#notchBar.inert = !open;
		this.#fitNotch();
	}

	#setPanelsHidden(hidden: boolean): void {
		if (this.#panelsHidden === hidden) return;
		const active = document.activeElement;
		const hadFocus = this.#notch.contains(active) || active === this.#showPanels || active === this.#composeOpen;
		this.#panelsHidden = hidden;
		this.#composer.classList.remove("is-peek");
		this.#barOpen = false;
		this.#barShown = "";
		const surface = this.surface;
		if (surface) this.#drawBar(surface);
		else this.#paintNotch();
		if (hidden) this.#showPanels.focus({ preventScroll: true });
		else if (hadFocus && this.#hasNotch) this.#notchPill.focus({ preventScroll: true });
		window.dispatchEvent(new Event("qorpera-rail-resize"));
	}

	#fitNotch(): void {
		if (this.#hasNotch && !this.#panelsHidden) {
			const layer = this.#notch.classList.contains("is-open") ? this.#notchBar : this.#notchPill;
			const width = layer.offsetWidth;
			const height = layer.offsetHeight;
			if (width > 0 && height > 0) {
				this.#notch.style.width = `${width}px`;
				this.#notch.style.height = `${height}px`;
			}
			for (const toggle of this.#notchBar.querySelectorAll<HTMLElement>(".surface-toggle")) this.#placeThumb(toggle);
			this.#markNotchCut();
		} else if (!this.#hasNotch) {
			this.#notch.style.removeProperty("width");
			this.#notch.style.removeProperty("height");
		}
		if (this.#fitPhoneCorners()) this.#syncPhoneViewport();
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

	// WHY: Park a warm SurfaceView in the LRU without tearing down its DOM/iframe mount, detaching global listeners while inactive.
	park(): void {
		if (this.#deactivated || this.#disposed || this.#parked) return;
		this.#parked = true;
		this.#needsRevive = true;
		this.#cancelReady?.();
		this.#cancelReady = undefined;
		this.#address.close();
		if (this.#pointing) this.#setPointing(false);
		this.#clearLocalLoadTimer();
		this.#viewportResizeObserver?.disconnect();
		this.#viewportResizeObserver = undefined;
		this.#notchResizeObserver?.disconnect();
		this.#notchResizeObserver = undefined;
		this.#active.abort();
		const ownSurfaceId = this.#lastSurfaceId || this.surface?.id;
		if (ownSurfaceId) {
			this.#host.store.clearActiveSurface(ownSurfaceId);
			if (this.#host.store.state.drawer?.surfaceId === ownSurfaceId) {
				this.#host.store.closeDrawer();
			}
		}
	}

	activate(): void {
		if (this.#deactivated || this.#disposed || !this.#parked) return;
		this.#parked = false;
		this.#active = new AbortController();
		this.#wireActive(this.#active.signal);
		this.#attachObservers();
		this.#contentReady = true;
		this.#primaryDoor.resetRetryState();
		for (const entry of this.#compareDoors.values()) entry.stage.resetRetryState();
		this.#framesShown = "";
		void this.#host.store.openSurface(this.slug);
		this.update();
	}

	deactivate(): void {
		if (this.#deactivated) return;
		this.#deactivated = true;
		this.#parked = false;
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
		if (this.#deactivated || this.#parked || this.#disposed) return;
		if (this.#needsRevive && this.el.isConnected) {
			this.#needsRevive = false;
			reviveFigures(this.el);
			reviveGroupAvatars(this.el);
		}
		const store = this.#host.store;
		const state = store.state;
		const surface = this.surface;
		if (!surface) {
			this.#hasNotch = false;
			this.#barOpen = false;
			this.#barPinned = false;
			this.#notch.hidden = true;
			this.#notch.classList.remove("is-open");
			this.#notch.style.removeProperty("width");
			this.#notch.style.removeProperty("height");
			this.#notchPill.replaceChildren();
			this.#notchBar.replaceChildren();
			this.#bar.hidden = true;
			this.#bar.classList.remove("has-phone-corners", "is-phone-stacked", "is-phone-tight", "is-phone-covered");
			this.#panelToggle.hidden = true;
			this.#phoneModelCorner.hidden = true;
			this.#phoneZoomCorner.hidden = true;
			this.#phoneBarShown = "";
			this.#lastPhoneZoom = DEFAULT_SURFACE_ZOOM;
			delete this.#viewport.dataset.siteZoomed;
			delete this.#viewport.dataset.phoneZoomed;
			this.#viewport.removeAttribute("data-phone-cutout");
			this.#viewport.style.removeProperty("--site-zoom");
			this.#viewport.style.removeProperty("--phone-w");
			this.#viewport.style.removeProperty("--phone-h");
			this.#viewport.style.removeProperty("--phone-r");
			this.#viewport.style.removeProperty("--phone-scale");
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
			if (this.#panelsHidden) {
				this.#panelsHidden = false;
				this.#paintNotch();
				window.dispatchEvent(new Event("qorpera-rail-resize"));
			}
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
		const reportMode = state.mode === "report" && look.kind !== "report" && surfaceHasDeliverables(state, surface.id);
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
					state.mode !== "live" &&
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
			const waitingForPreview = Boolean(
				!reportMode &&
					liveBuild &&
					!localLive &&
					!remoteCompare &&
					!showPrimary &&
					state.source === "cloud" &&
					state.mode !== "live" &&
					surface.sourceKind === "code_repo" &&
					store.isPreviewSyncing(surface.id) &&
					store.shownPreviewChangeCount(surface.id) > 0,
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
			} else if (waitingForWorkspace || waitingForPreview || waitingForMount) {
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
		const websiteZoom =
			surface.archetype === "live_build" && !reportMode && effectiveDevice === "desktop"
				? clampSurfaceZoom(state.websiteZoom)
				: DEFAULT_SURFACE_ZOOM;
		if (websiteZoom !== DEFAULT_SURFACE_ZOOM) {
			this.#viewport.dataset.siteZoomed = "true";
			this.#viewport.style.setProperty("--site-zoom", String(websiteZoom));
		} else {
			delete this.#viewport.dataset.siteZoomed;
			this.#viewport.style.removeProperty("--site-zoom");
		}
		this.#syncPhoneViewport();
	}

	#buildZoomControl(target: "website" | "phone", zoom: number, groupLabel?: string): HTMLElement {
		const pct = Math.round(zoom * 100);
		const canOut = zoom > MIN_SURFACE_ZOOM + 0.001;
		const canIn = zoom < MAX_SURFACE_ZOOM - 0.001;
		const label = groupLabel ?? (target === "phone" ? t("Phone zoom") : t("Preview zoom"));
		return h(
			"div",
			{
				class: `surface-zoom is-${target}${zoom !== DEFAULT_SURFACE_ZOOM ? " is-zoomed" : ""}`,
				role: "group",
				"aria-label": label,
				"data-zoom-target": target,
			},
			h(
				"button",
				{
					type: "button",
					class: "surface-zoom-step",
					disabled: !canOut,
					"aria-label": t("Zoom out"),
					title: t("Zoom out"),
					"data-act": "zoom-out",
					"data-zoom-target": target,
				},
				icon("minus"),
			),
			h(
				"button",
				{
					type: "button",
					class: "surface-zoom-value",
					"aria-label": t("Zoom level: {percent}%", { percent: pct }),
					"aria-haspopup": "menu",
					title: groupLabel,
					"data-act": "zoom-menu",
					"data-zoom-target": target,
				},
				`${pct}%`,
			),
			h(
				"button",
				{
					type: "button",
					class: "surface-zoom-step",
					disabled: !canIn,
					"aria-label": t("Zoom in"),
					title: t("Zoom in"),
					"data-act": "zoom-in",
					"data-zoom-target": target,
				},
				icon("plus"),
			),
		);
	}

	#syncPhoneViewport(): void {
		const isMobile = this.#viewport.dataset.device === "mobile";
		this.#phoneModelCorner.hidden = !isMobile;
		this.#phoneZoomCorner.hidden = !isMobile;
		if (!isMobile) {
			this.#viewport.removeAttribute("data-phone-cutout");
			this.#bar.classList.remove("has-phone-corners", "is-phone-stacked", "is-phone-tight", "is-phone-covered");
			delete this.#viewport.dataset.phoneStacked;
			delete this.#viewport.dataset.phoneZoomed;
			this.#viewport.style.removeProperty("--phone-w");
			this.#viewport.style.removeProperty("--phone-h");
			this.#viewport.style.removeProperty("--phone-r");
			this.#viewport.style.removeProperty("--phone-status");
			this.#viewport.style.removeProperty("--phone-notch");
			this.#viewport.style.removeProperty("--phone-scale");
			this.#viewportBody.scrollLeft = 0;
			this.#viewportBody.scrollTop = 0;
			this.#lastPhoneZoom = DEFAULT_SURFACE_ZOOM;
			return;
		}
		this.#bar.classList.add("has-phone-corners");
		const model = phoneModelById(this.#phoneModelId);
		this.#drawPhoneCorners(model);
		this.#fitPhoneCorners();
		const stacked = this.#viewport.dataset.phoneStacked === "true";
		const rect = this.#viewport.getBoundingClientRect();
		const ui = uiScale();
		const padX = Math.ceil(64 * ui);
		const padY = Math.ceil((stacked ? 224 : 188) * ui);
		const body = PHONE_BODY_EDGE * 2;
		const availW = rect.width > 0 ? Math.max(220, rect.width - padX) : model.width + body;
		const availH = rect.height > 0 ? Math.max(260, rect.height - padY) : model.height + body;
		const fitScale = Math.min(PHONE_RESTING_SCALE, availW / (model.width + body), availH / (model.height + body));
		const phoneZoom = clampSurfaceZoom(this.#host.store.state.phoneZoom);
		const scale = fitScale * phoneZoom;
		const wasOverflowX = this.#viewportBody.scrollWidth > this.#viewportBody.clientWidth + 1;
		this.#viewport.dataset.phoneCutout = model.cutout;
		if (phoneZoom !== DEFAULT_SURFACE_ZOOM) this.#viewport.dataset.phoneZoomed = "true";
		else delete this.#viewport.dataset.phoneZoomed;
		this.#viewport.style.setProperty("--phone-w", `${model.width}px`);
		this.#viewport.style.setProperty("--phone-h", `${model.height}px`);
		this.#viewport.style.setProperty("--phone-r", `${model.radius}px`);
		this.#viewport.style.setProperty("--phone-status", `${model.status}px`);
		if (model.notch) this.#viewport.style.setProperty("--phone-notch", `${model.notch}px`);
		else this.#viewport.style.removeProperty("--phone-notch");
		this.#viewport.style.setProperty("--phone-scale", scale.toFixed(4));
		if (phoneZoom !== this.#lastPhoneZoom) {
			this.#lastPhoneZoom = phoneZoom;
			const overflowX = this.#viewportBody.scrollWidth - this.#viewportBody.clientWidth;
			if (overflowX > 1 && !wasOverflowX) {
				this.#viewportBody.scrollLeft = Math.round(overflowX / 2);
			} else if (overflowX <= 1) {
				this.#viewportBody.scrollLeft = 0;
			}
		}
	}

	#drawPhoneCorners(model: PhoneModelSpec): void {
		const phoneZoom = clampSurfaceZoom(this.#host.store.state.phoneZoom);
		const barKey = `${model.id}:${Math.round(phoneZoom * 100)}`;
		if (barKey === this.#phoneBarShown) return;
		this.#phoneBarShown = barKey;
		const focused = document.activeElement;
		const corners = [this.#phoneModelCorner, this.#phoneZoomCorner];
		const focusIn = corners.find((corner) => focused instanceof HTMLElement && corner.contains(focused));
		const focusKey = focusIn && focused instanceof HTMLElement ? barFocusKey(focused) : undefined;
		this.#phoneModelCorner.replaceChildren(
			h(
				"button",
				{
					type: "button",
					class: "surface-phone-pick",
					"aria-haspopup": "menu",
					"aria-label": t("Phone: {name}", { name: model.label }),
					title: `${model.label} (${model.width} × ${model.height})`,
					"data-act": "phone-models",
				},
				h("span", null, model.label),
				icon("chevron-down"),
			),
		);
		this.#phoneZoomCorner.replaceChildren(this.#buildZoomControl("phone", phoneZoom));
		if (focusIn) restoreBarFocus(focusIn, focusKey);
	}

	#fitPhoneCorners(): boolean {
		if (!this.#bar.classList.contains("has-phone-corners")) return false;
		const style = getComputedStyle(this.#bar);
		const inner =
			this.#bar.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
		const start = this.#phoneModelCorner.offsetWidth;
		const end = this.#phoneZoomCorner.offsetWidth;
		const gap = Math.ceil(12 * uiScale());
		const notchShown = this.#hasNotch && !this.#panelsHidden;
		let stacked = false;
		let tight = false;
		let covered = false;
		if (notchShown) {
			const clears = (notch: number) => notch / 2 + Math.max(start, end) + gap <= inner / 2;
			const notch = (parseFloat(this.#notch.style.width) || this.#notch.offsetWidth) + 2;
			const restingNotch = this.#barPinned ? notch : this.#notchPill.offsetWidth + 2;
			stacked = inner > 0 && !clears(restingNotch);
			tight = stacked && start + end + gap > inner;
			covered = !stacked && inner > 0 && !clears(notch);
		} else {
			tight = inner > 0 && start + end + gap > inner;
		}
		const needsRoom = stacked || tight;
		const changed = needsRoom !== (this.#viewport.dataset.phoneStacked === "true");
		this.#bar.classList.toggle("is-phone-stacked", stacked);
		this.#bar.classList.toggle("is-phone-tight", tight);
		this.#bar.classList.toggle("is-phone-covered", covered);
		if (needsRoom) this.#viewport.dataset.phoneStacked = "true";
		else delete this.#viewport.dataset.phoneStacked;
		return changed;
	}

	#phoneModelMenu(): MenuEntry[] {
		const row = (model: PhoneModelSpec): MenuEntry => ({
			label: model.label,
			hint: `${model.width} × ${model.height}`,
			checked: model.id === this.#phoneModelId,
			select: () => this.#setPhoneModel(model.id),
		});
		const current = phoneModelById(this.#phoneModelId);
		const groups = [...new Set(PHONE_MODELS.map((model) => model.group))];
		return groups.flatMap((group): MenuEntry[] =>
			group
				? [
						{
							kind: "submenu",
							label: group,
							...(group === current.group
								? { icon: "check", ariaLabel: t("{group}, current: {name}", { group, name: current.label }) }
								: {}),
							items: PHONE_MODELS.filter((model) => model.group === group).map(row),
						},
					]
				: PHONE_MODELS.filter((model) => !model.group).map(row),
		);
	}

	#setPhoneModel(id: string): void {
		const model = phoneModelById(id);
		this.#phoneModelId = model.id;
		try {
			localStorage.setItem(PHONE_MODEL_KEY, model.id);
		} catch {
			/* WHY: Local browser storage is optional in private/sandboxed contexts. */
		}
		this.#phoneBarShown = "";
		this.#syncPhoneViewport();
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
		const reportMode = state.mode === "report" && look.kind !== "report" && surfaceHasDeliverables(state, surface.id);
		const effectiveMode: SurfacePreviewMode = state.mode === "live" ? "live" : reportMode ? "report" : "preview";
		const shownCount = effectiveMode === "preview" ? store.shownPreviewChangeCount(surface.id) : 0;
		const showViewportSplit = supportsViewportSplit(surface, look);
		const live = surface.archetype === "live_build";
		const mobileApp = look.kind === "mobile_app";
		if (mobileApp && this.#address.isOpen) {
			this.#address.close();
			return;
		}
		const effectiveDevice =
			reportMode || !live ? "desktop" : mobileApp ? "mobile" : showViewportSplit ? state.device : "desktop";
		const showWebsiteZoom = live && !reportMode && effectiveDevice === "desktop";
		const websiteZoom = clampSurfaceZoom(state.websiteZoom);
		const served = this.#host.isSiteLive?.(surface);
		const siteLive = served === true;
		const addressShown = live && siteLive;
		const reader = addressShown ? this.#host.siteHosting?.(surface) : undefined;
		const addressKey = this.#address.sync(addressShown, reader, surface.liveUrl);
		const mark = this.#address.mark();
		const site: AddressMark =
			!live || !this.#host.isSiteLive
				? "live"
				: served === undefined
					? "unknown"
					: !siteLive
						? "private"
						: reader && surface.liveUrl && !(mark === "unknown" && this.#address.readFailed)
							? mark
							: "live";
		this.#sitePublic = site === "live";
		if (site === "private" && !this.#address.isWriting) this.#publishWhileNotLive(surface);
		if (mark === "live" && !this.#address.isWriting) this.#switchAutoPublishOffOwed(surface);
		const key = JSON.stringify([
			site,
			siteLive,
			addressKey,
			surface.id,
			surface.title,
			surface.archetype,
			look.kind,
			surface.liveUrl,
			surface.unpublishedChangeCount,
			state.mode,
			reportMode,
			state.device,
			showViewportSplit,
			showWebsiteZoom,
			websiteZoom,
			studioHasChanges,
			panelOpen,
			openWorkCount,
			shownCount,
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
		const askedMe = !mobileApp && site === "live" && askedToPublish(surface, store.userId);
		const myAsk = ask && ask.askedByUserId === store.userId ? ask : null;
		const askKey = askedMe ? `${surface.id}:${ask!.askedAt}` : "";
		if (askKey && askKey !== this.#askShown) {
			this.#barOpen = true;
			if (state.mode === "live") queueMicrotask(() => store.setMode("preview"));
		}
		if (!this.#panelsHidden) this.#askShown = askKey;
		if ((mobileApp || site === "private") && state.mode === "live") queueMicrotask(() => store.setMode("preview"));

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
		const address = !mobileApp && live ? this.#address.button() : null;
		const count = surface.unpublishedChangeCount;
		if (!mobileApp) {
			if (address) groups.push(address);
			if (live && site === "live") {
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
						deviceSegment(
							"mobile",
							t("Mobile"),
							h("span", { class: "surface-phone-icon", "aria-hidden": "true" }),
						),
					),
				);
			}
			if (showWebsiteZoom) {
				const zoomLabel = look.kind === "website" ? t("Website zoom") : t("Preview zoom");
				groups.push(this.#buildZoomControl("website", websiteZoom, zoomLabel));
			}

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
						presentHere.length > 1
							? h("span", { class: "surface-pill-presence-fold" }, `+${presentHere.length - 1}`)
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
			} else if (site === "live" && surface.archetype !== "ops" && (count > 0 || publishBusy)) {
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
							publishBusy
								? h("span", { class: "surface-publish-word" }, t("Publishing…"))
								: saidNo
									? h("span", { class: "surface-publish-word" }, t("{name} said no", { name: saidNo }))
									: t("Publish"),
							publishBusy || saidNo
								? h("span", { class: "surface-publish-short" }, publishBusy ? t("Publish") : t("No"))
								: null,
							!publishBusy && !saidNo && count
								? h("span", { class: "surface-notch-count" }, String(count))
								: null,
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
		}

		const panelLabel = panelOpen ? t("Close panel") : t("Preview panel");
		this.#panelToggle.hidden = !(surface.archetype !== "ops" || hasAgents || panelOpen);
		this.#panelToggle.setAttribute("aria-pressed", String(panelOpen));
		this.#panelToggle.setAttribute("aria-label", panelLabel);
		this.#panelToggle.title = panelLabel;
		this.#panelToggle.replaceChildren(
			icon("panel-right"),
			...(!panelOpen && openWorkCount > 0
				? [h("span", { class: "surface-panel-toggle-dot", "aria-hidden": "true" }, String(openWorkCount))]
				: []),
		);

		if (groups.length > 0)
			groups.push(
				h(
					"button",
					{
						type: "button",
						class: "surface-hide-panels",
						"aria-label": t("Hide panels"),
						title: t("Hide panels"),
						"data-act": "hide-panels",
					},
					icon("hide"),
				),
			);
		else if (this.#panelsHidden) {
			this.#panelsHidden = false;
			window.dispatchEvent(new Event("qorpera-rail-resize"));
		}
		this.#hasNotch = groups.length > 0;
		this.#bar.hidden = !this.#hasNotch && effectiveDevice !== "mobile";
		this.#barTitle.textContent = surface.title;
		if (!this.#hasNotch) {
			this.#notchPill.replaceChildren();
			this.#notchBar.replaceChildren();
			this.#barOpen = false;
			this.#barPinned = false;
			this.#paintNotch();
			return;
		}
		const notchLabel =
			effectiveMode === "live"
				? live
					? t("Live")
					: t("Base")
				: effectiveMode === "report"
					? t("Notes")
					: t("Preview");
		const notchCount =
			effectiveMode === "preview" ? shownCount : site === "live" && count > 0 ? count : openWorkCount;
		this.#notchPill.replaceChildren(
			h("span", { class: "surface-notch-label" }, notchLabel),
			...(showWebsiteZoom && websiteZoom !== DEFAULT_SURFACE_ZOOM
				? [h("span", { class: "surface-notch-zoom" }, `${Math.round(websiteZoom * 100)}%`)]
				: []),
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
		restoreBarFocus(this.#notchBar, focusKey);
		this.#barPinned = Boolean(address) && this.#address.mark() === "private";
		if (this.#barPinned) this.#barOpen = true;
		this.#paintNotch();
	}

	#publishWhileNotLive(surface: SurfaceSummary): void {
		if (this.#host.canWrite?.() !== true) return;
		const store = this.#host.store;
		if (!surface.autoPublish && !this.#autoPublishAsked.has(surface.id)) {
			this.#autoPublishAsked.add(surface.id);
			void store.setAutoPublish(surface.id, true, { quiet: true });
		}
		const count = surface.unpublishedChangeCount;
		if (count === 0 && !surface.hasUnpublishedChanges) {
			this.#publishedAt.delete(surface.id);
			return;
		}
		const publishing = Boolean(store.state.busy[`publish:${surface.id}`]) || surface.publishStatus === "publishing";
		const at = `${count}:${surface.liveHeadSha ?? ""}`;
		if (publishing || this.#publishedAt.get(surface.id) === at) return;
		this.#publishedAt.set(surface.id, at);
		void store.publish(surface.id, { quiet: true });
	}

	#switchAutoPublishOffOwed(surface: SurfaceSummary): void {
		const owed = this.#autoPublishOffOwed.get(surface.id);
		const store = this.#host.store;
		if (!owed || store.state.busy[`auto:${surface.id}`]) return;
		if (!surface.autoPublish) {
			this.#autoPublishOffOwed.delete(surface.id);
			return;
		}
		if (owed.at === surface || owed.tries > AUTO_PUBLISH_OFF_QUIET_TRIES) return;
		owed.at = surface;
		owed.tries += 1;
		void store.setAutoPublish(surface.id, false, { quiet: owed.tries <= AUTO_PUBLISH_OFF_QUIET_TRIES });
	}

	async #publishBeforeLive(): Promise<boolean> {
		const store = this.#host.store;
		const surfaceId = this.surface?.id;
		if (!surfaceId) return false;
		const ceiling = new AbortController();
		const timer = setTimeout(() => ceiling.abort(), GO_LIVE_PUBLISH_WAIT_MS);
		const signal = AbortSignal.any([this.#active.signal, ceiling.signal]);
		const settled = () =>
			!store.state.busy[`publish:${surfaceId}`] &&
			store.state.surfaces.find((item) => item.id === surfaceId)?.publishStatus !== "publishing";
		try {
			if (!(await this.#until(settled, signal))) return false;
			const surface = this.surface;
			if (!surface) return false;
			if (surface.unpublishedChangeCount === 0 && !surface.hasUnpublishedChanges) return true;
			if (!(await store.publish(surface.id, { quiet: true }))) return false;
			if (!(await this.#until(settled, signal))) return false;
			const after = this.surface;
			return after !== undefined && after.publishStatus !== "failed";
		} finally {
			clearTimeout(timer);
		}
	}

	#until(done: () => boolean, signal: AbortSignal): Promise<boolean> {
		if (signal.aborted) return Promise.resolve(false);
		if (done()) return Promise.resolve(true);
		return new Promise((resolve) => {
			const finish = (answer: boolean) => {
				stop();
				signal.removeEventListener("abort", aborted);
				resolve(answer);
			};
			const aborted = () => finish(false);
			const stop = this.#host.store.store.subscribe(() => {
				if (done()) finish(true);
			});
			signal.addEventListener("abort", aborted, { once: true });
		});
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
			const page = surfacePageKind({ archetype: surface.archetype, lookKind: look.kind });
			this.#mount =
				this.#host.mount(surface, this.#lifetime.signal) ??
				(page === "report"
					? new SurfaceReportView({
							store,
							surface,
							signal: this.#lifetime.signal,
							loadFiles: this.#host.loadStudioFiles,
						})
					: page === "layout"
						? new SurfaceStudioView({
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
		const sandbox = getLocalSandbox();
		if (!sandbox) {
			// WHY: Load surface-local-sandbox.ts lazily so production surface views do not statically bundle dev sandbox code.
			void loadLocalSandbox().then(() => {
				if (this.#lifetime.signal.aborted || this.#localHost !== host) return;
				const current = surfaceBySlug(this.#host.store.state, this.slug);
				if (current?.id === surface.id && this.#localSiteShown !== key) this.#drawLocalLiveSite(current);
			});
			return;
		}
		this.#localSiteShown = key;
		const html = sandbox.renderLocalSitePreviewHtml(
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
			state.mode !== "live" &&
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
				const compareLook = store.lookOf(surface);
				entry.stage?.setFigure(JSON.stringify([surface.icon, compareLook]), () =>
					surfaceTile(surface, compareLook, "is-loader", "working", "now"),
				);
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
			const look = store.lookOf(surface);
			this.#primaryDoor.setFigure(JSON.stringify([surface.icon, look]), () =>
				surfaceTile(surface, look, "is-loader", "working", "now"),
			);
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
		const canStart = store.canStartSessions(surface);
		const pointVisible = surface.archetype === "live_build";
		const pointEnabled = pointVisible && canStart && (this.#primaryDoor.hasShown || Boolean(this.#localFrame));
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
			this.#images.available,
			this.#pointing,
			this.#target,
			running,
			pending,
			state.error,
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
		const inputLabel = surface.archetype === "ops" ? t("Ask an agent") : t("Describe a change");
		this.#input.setAttribute("aria-label", inputLabel);
		this.#composeOpen.setAttribute("aria-label", inputLabel);
		this.#composeOpen.disabled = !canStart;
		this.#send.setAttribute("aria-label", t("Start session"));
		this.#send.disabled = !canStart;
		this.#pointVisible = pointVisible;
		this.#pointEnabled = pointEnabled;
		this.#plus.hidden = !pointVisible && !this.#images.available;
		this.#plus.disabled = !canStart;
		this.#plus.classList.toggle("is-on", this.#pointing);
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
					{ class: "surface-chip is-running" },
					h("span", { class: "surface-state is-running" }),
					running === 1 ? t("1 session running") : t("{count} sessions running in parallel", { count: running }),
				),
			);
		this.#chips.replaceChildren(...chips);
		this.#paintFold();
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
		this.#paintFold();
	}

	#onPick(target: PointToChangeTarget): void {
		this.#target = target;
		this.#pointing = false;
		this.#primaryDoor.setInspectorMode(false);
		this.#localFrame?.contentWindow?.postMessage({ type: SURFACE_INSPECTOR_MODE_MESSAGE, active: false }, "*");
		this.el.classList.toggle("is-pointing", false);
		const surface = this.surface;
		if (surface) this.#drawChrome(surface);
		this.#paintFold();
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
			if (this.#closeBar()) {
				if (inside) this.#notchPill.focus();
			} else if (this.#panelsHidden && !this.#barHeld() && !isEditableTarget(event.target)) {
				event.preventDefault();
				this.#setPanelsHidden(false);
			}
			return;
		}
		if (event.key !== "p" && event.key !== "P") return;
		if (isEditableTarget(event.target)) return;
		if (this.#host.store.state.drawer || document.querySelector("dialog.surface-dialog[open], .settings-overlay"))
			return;
		if (!this.#pointEnabled) return;
		event.preventDefault();
		this.#setPointing(!this.#pointing);
	}

	#drawToast(): void {
		const undo = this.#host.store.state.undo;
		const key = undo ? `${undo.id}:${undo.pending ? "p" : "r"}:${this.#sitePublic}` : "";
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
							undo.verb === "merged" && this.#sitePublic
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
		this.#paintFold();
	}

	#openPlusMenu(): void {
		if (this.#plusMenu) {
			this.#plusMenu.close();
			return;
		}
		const items: MenuEntry[] = [];
		if (this.#pointVisible)
			items.push({
				label: t("Point at an element"),
				icon: "crosshair",
				checked: this.#pointing,
				multiple: true,
				...(this.#pointEnabled ? {} : { disabled: true, hint: t("Point is available when a preview is open") }),
				select: () => this.#setPointing(!this.#pointing),
			});
		if (this.#images.available)
			items.push({ label: t("Attach images"), icon: "attach", select: () => this.#images.open() });
		if (!items.length) return;
		const box = this.#plus.getBoundingClientRect();
		this.#plus.setAttribute("aria-expanded", "true");
		this.#plusMenu = openContextMenu({
			label: t("Point or attach"),
			x: box.left,
			y: this.#shell.getBoundingClientRect().top - 8 * uiScale(),
			up: true,
			opener: this.#plus,
			items,
			onClose: (press) => {
				this.#plusShutBy = press;
				this.#plusMenu = undefined;
				this.#plus.setAttribute("aria-expanded", "false");
				this.#paintFold();
			},
		});
		this.#paintFold();
	}

	#paintFold(): void {
		const held =
			Boolean(this.#plusMenu) ||
			this.#input.value.trim().length > 0 ||
			this.#pointing ||
			Boolean(this.#target) ||
			this.#images.files.length > 0;
		this.#composer.classList.toggle("is-held", held);
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
			case "zoom-out":
			case "zoom-in": {
				const dir = act === "zoom-in" ? 1 : -1;
				if (target.dataset.zoomTarget === "phone") {
					store.setPhoneZoom(stepSurfaceZoom(store.state.phoneZoom, dir));
				} else {
					store.setWebsiteZoom(stepSurfaceZoom(store.state.websiteZoom, dir));
				}
				return;
			}
			case "zoom-menu": {
				const zoomTarget = target.dataset.zoomTarget === "phone" ? "phone" : "website";
				const current = zoomTarget === "phone" ? store.state.phoneZoom : store.state.websiteZoom;
				const surface = surfaceBySlug(store.state, this.slug);
				const isWebsite = surface ? store.lookOf(surface).kind === "website" : false;
				const box = target.getBoundingClientRect();
				openContextMenu({
					label: zoomTarget === "phone" ? t("Phone zoom") : isWebsite ? t("Website zoom") : t("Preview zoom"),
					x: box.left,
					y: box.bottom + 6,
					opener: target,
					findOpener: () =>
						this.el.querySelector<HTMLElement>(`[data-act="zoom-menu"][data-zoom-target="${zoomTarget}"]`),
					items: SURFACE_ZOOM_LEVELS.map((level) => ({
						label: `${Math.round(level * 100)}%`,
						checked: Math.abs(current - level) < 0.001,
						select: () => {
							if (zoomTarget === "phone") store.setPhoneZoom(level);
							else store.setWebsiteZoom(level);
						},
					})),
				});
				return;
			}
			case "phone-models": {
				const box = target.getBoundingClientRect();
				openContextMenu({
					label: t("Phone model"),
					x: box.left,
					y: box.bottom + 6,
					opener: target,
					findOpener: () => this.el.querySelector<HTMLElement>('[data-act="phone-models"]'),
					items: this.#phoneModelMenu(),
				});
				return;
			}
			case "address":
				if (!this.#hasNotch) return;
				this.#address.toggle(event.detail === 0);
				return;
			case "expand-pill":
				if (!this.#hasNotch) return;
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
			case "hide-panels":
				if (!this.#hasNotch) return;
				this.#setPanelsHidden(true);
				return;
			case "show-panels":
				this.#setPanelsHidden(false);
				return;
			case "open-composer":
				// WHY: The folded input is display:none and cannot take focus; holding the bar open for the call lets
				// it, and #paintFold then drops the hold while the input's own :focus keeps the bar open.
				this.#composer.classList.add("is-held");
				this.#input.focus({ preventScroll: true });
				this.#paintFold();
				return;
			case "clear-target":
				this.#target = undefined;
				this.#drawChrome(surface);
				return;
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
