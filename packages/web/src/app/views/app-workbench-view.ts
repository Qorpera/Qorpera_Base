import type {
	SurfaceChangeUnit,
	SurfaceImageRef,
	SurfacePreviewCompositionState,
	SurfaceSession,
	SurfaceSessionArtifact,
	SurfaceSessionArtifactKind,
	SurfaceSessionChecksSummary,
	SurfaceSessionMessage,
	SurfaceSessionProgressStep,
	SurfaceSummary,
	SurfaceWorkspace,
} from "@qorpera/contracts";
import { AppFrame } from "../../ui/app-frame.ts";
import { SurfaceDialog } from "../../ui/dialog.ts";
import { confirmDialog, fmtTime, growToText, h, icon, personAvatar, replace } from "../../ui/dom.ts";
import { markdown } from "../../ui/markdown.ts";
import { framePage } from "../../ui/page-frame.ts";
import { t } from "../../ui/preferences.ts";
import { ReceivedAttachments } from "../../ui/received-attachments.ts";
import { uiScale } from "../../ui/scale.ts";
import {
	groupSessionChanges,
	isOpenChange,
	isRunningSession,
	optionGroupId,
	type SurfaceNote,
	type SurfaceTeammate,
} from "../surfaces-store.ts";
import { SurfaceAddress } from "./surface-address-sheet.ts";
import { SurfaceComposerImages } from "./surface-composer-images.ts";
import { SurfaceDoorStage } from "./surface-door.ts";
import { openPublishSheet } from "./surface-publish-sheet.ts";
import { APPROVE_ARM_MS, approveLabel } from "./surface-session-drawer.ts";
import type { SurfaceMount, SurfaceViewHost } from "./surface-view.ts";

export type WorkbenchPanelTab = "preview" | "mockups" | "plans" | "changes";

const PANEL_WIDTH_KEY = "qorpera.web.workbench-panel-width.v1";
const TRACKS_WIDTH = 236;
const THREAD_MIN_WIDTH = 340;
const PANEL_DEFAULT_WIDTH = 440;
const PANEL_MIN_WIDTH = 320;
const PANEL_MAX_WIDTH = 920;
const PANEL_MAX_SHARE = 0.62;
const MARKDOWN_CACHE_MAX = 96;
const parsedMarkdownCache = new Map<string, HTMLElement>();

function refuseMockupCall(): Promise<{ ok: false; error: string }> {
	return Promise.resolve({ ok: false, error: "Not available in mockup preview" });
}

function expectedTrackPreviewChangeIds(session: SurfaceSession): string[] {
	const candidates = session.changes
		.filter((change) => change.status === "staged" || change.status === "conflicted")
		.sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
	const seenGroups = new Set<string>();
	const picked: string[] = [];
	for (const change of candidates) {
		const groupKey = change.optionGroupKey ?? change.id;
		if (seenGroups.has(groupKey)) continue;
		seenGroups.add(groupKey);
		picked.push(change.id);
	}
	return picked.sort();
}

function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	const setA = new Set(a);
	if (setA.size !== a.length) return false;
	for (const id of b) {
		if (!setA.has(id)) return false;
	}
	return true;
}

function cachedMarkdown(text: string): HTMLElement {
	const cached = parsedMarkdownCache.get(text);
	if (cached) {
		parsedMarkdownCache.delete(text);
		parsedMarkdownCache.set(text, cached);
		return cached.cloneNode(true) as HTMLElement;
	}
	const rendered = markdown(text, { surfaceRow: true });
	parsedMarkdownCache.set(text, rendered);
	while (parsedMarkdownCache.size > MARKDOWN_CACHE_MAX) {
		const oldest = parsedMarkdownCache.keys().next().value;
		if (oldest === undefined) break;
		parsedMarkdownCache.delete(oldest);
	}
	return rendered.cloneNode(true) as HTMLElement;
}

function isMockupArtifact(artifact: SurfaceSessionArtifact): boolean {
	return artifact.kind === "mockup";
}

function isPlanArtifact(artifact: SurfaceSessionArtifact): boolean {
	return artifact.kind !== "mockup";
}

function artifactKindLabel(kind: SurfaceSessionArtifactKind): string {
	switch (kind) {
		case "mockup":
			return t("Mockup");
		case "plan":
			return t("Plan");
		case "report":
			return t("Report");
		case "diff_summary":
			return t("Summary");
		case "checklist":
			return t("Checklist");
	}
}

function trackStateMeta(session: SurfaceSession): { readonly label: string; readonly tone: string } {
	if (isRunningSession(session)) return { label: t("Working"), tone: "running" };
	if (session.state === "needs_input") return { label: t("Needs input"), tone: "attention" };
	if (session.state === "failed") return { label: t("Failed"), tone: "danger" };
	if (session.state === "completed") return { label: t("Shipped"), tone: "done" };
	if (session.state === "discarded") return { label: t("Discarded"), tone: "muted" };
	if (session.changes.some((change) => change.status === "merging")) return { label: t("Merging"), tone: "running" };
	if (session.changes.some((change) => change.status === "conflicted"))
		return { label: t("Needs review"), tone: "attention" };
	if (session.changes.some(isOpenChange)) return { label: t("Ready"), tone: "ready" };
	return { label: t("Open"), tone: "idle" };
}

function checksMeta(checks: SurfaceSessionChecksSummary): { readonly label: string; readonly tone: string } {
	switch (checks.status) {
		case "passed":
			return { label: t("Checks passed"), tone: "ok" };
		case "failed":
			return { label: t("Checks failed"), tone: "danger" };
		case "running":
			return { label: t("Running checks"), tone: "running" };
		case "skipped":
			return { label: t("Checks skipped"), tone: "muted" };
		default:
			return { label: t("Checks pending"), tone: "muted" };
	}
}

function safeExternalUrl(url: string | null | undefined): string | null {
	if (!url) return null;
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
	} catch {
		return null;
	}
}

function formatDurationMs(durationMs: number | null | undefined): string {
	if (durationMs === null || durationMs === undefined || !Number.isFinite(durationMs)) return "";
	if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
	return `${(durationMs / 1000).toFixed(1)} s`;
}

function sessionNeedsAttention(session: SurfaceSession): boolean {
	return (
		session.state === "needs_input" ||
		session.state === "failed" ||
		session.changes.some((change) => change.status === "conflicted")
	);
}

function sessionOpenChanges(session: SurfaceSession): readonly SurfaceChangeUnit[] {
	return session.changes.filter(isOpenChange);
}

function canShipSession(session: SurfaceSession): boolean {
	if (isRunningSession(session) || session.state === "discarded" || session.state === "completed") return false;
	const open = sessionOpenChanges(session);
	if (open.length === 0) return false;
	const optionGroups = new Map<string, number>();
	for (const change of open) {
		if (!change.optionGroupKey) continue;
		optionGroups.set(change.optionGroupKey, (optionGroups.get(change.optionGroupKey) ?? 0) + 1);
	}
	for (const count of optionGroups.values()) {
		if (count > 1) return false;
	}
	return true;
}

function changeStatusBadge(change: SurfaceChangeUnit): HTMLElement {
	switch (change.status) {
		case "merged":
			return h("span", { class: "workbench-pill is-ok" }, icon("check"), t("Merged"));
		case "merging":
			return h("span", { class: "workbench-pill is-running" }, t("Merging"));
		case "conflicted":
			return h("span", { class: "workbench-pill is-attention" }, t("Needs review"));
		case "discarded":
			return h("span", { class: "workbench-pill is-muted" }, t("Discarded"));
		case "reverted":
			return h("span", { class: "workbench-pill is-muted" }, t("Reverted"));
		default:
			return h("span", { class: "workbench-pill is-ready" }, t("Staged"));
	}
}

function diffStatsLabel(change: SurfaceChangeUnit): string {
	if (!change.diffStats) return "";
	const { filesChanged, additions, deletions } = change.diffStats;
	return t("{files} files · +{added} / -{removed}", {
		files: filesChanged,
		added: additions,
		removed: deletions,
	});
}

export interface AppWorkbenchOptions {
	readonly onFullPreview?: () => void;
}

export class AppWorkbenchView {
	readonly el = h("div", { class: "workbench" });
	readonly #host: SurfaceViewHost;
	readonly #options: AppWorkbenchOptions;
	readonly #lifetime = new AbortController();
	readonly #bar = h("header", { class: "workbench-bar" });
	readonly #barLeft = h("div", { class: "workbench-bar-left" });
	readonly #barRight = h("div", { class: "workbench-bar-right" });
	readonly #banner = h("div", { class: "workbench-banners", hidden: true });
	readonly #body = h("div", { class: "workbench-body" });
	readonly #tracksRail = h("aside", { class: "workbench-tracks" });
	readonly #tracksTop = h("div", { class: "workbench-tracks-top" });
	readonly #searchInput = h("input", {
		type: "search",
		class: "workbench-search",
		placeholder: t("Filter tracks…"),
		"aria-label": t("Filter tracks"),
		autocomplete: "off",
	}) as HTMLInputElement;
	readonly #combineBar = h("div", { class: "workbench-combine-bar", hidden: true });
	readonly #trackList = h("div", { class: "workbench-track-list" });
	readonly #thread = h("main", { class: "workbench-thread" });
	readonly #trackHead = h("div", { class: "workbench-track-head" });
	readonly #threadScroll = h("div", { class: "workbench-thread-scroll" });
	readonly #progressSlot = h("div", { class: "workbench-progress-slot", hidden: true });
	readonly #messagesSlot = h("div", { class: "workbench-messages" });
	readonly #composerInput = h("textarea", {
		class: "workbench-composer-input",
		rows: 1,
		placeholder: t("Describe what you want to plan, design, or change…"),
		"aria-label": t("Message"),
	}) as HTMLTextAreaElement;
	readonly #composerAction = h("div", { class: "workbench-composer-actions" });
	readonly #composerShell = h("div", { class: "workbench-composer-shell" });
	readonly #composerForm = h("form", { class: "workbench-composer" });
	readonly #images: SurfaceComposerImages;
	readonly #panel = h("aside", { class: "workbench-panel" });
	readonly #panelResizer = h("div", {
		class: "workbench-panel-resizer",
		role: "separator",
		tabindex: "0",
		"aria-label": t("Resize side panel"),
		"aria-orientation": "vertical",
		"aria-valuemin": String(PANEL_MIN_WIDTH),
	});
	readonly #panelContent = h("div", { class: "workbench-panel-content" });
	readonly #previewPane = h("div", { class: "workbench-preview-pane", hidden: true });
	readonly #previewToolbar = h("div", { class: "workbench-preview-toolbar" });
	readonly #routeInput = h("input", {
		type: "text",
		class: "workbench-route-input",
		value: "/",
		"aria-label": t("Preview path"),
		autocomplete: "off",
		spellcheck: "false",
	}) as HTMLInputElement;
	readonly #previewScopeEl = h("span", { class: "workbench-preview-scope" });
	readonly #previewControls = h("div", { class: "workbench-preview-controls" });
	readonly #previewViewport = h("div", { class: "workbench-preview-viewport" });
	readonly #liveMountSlot = h("div", { class: "workbench-live-mount", hidden: true });
	readonly #previewEmpty = h("div", { class: "workbench-preview-empty", hidden: true });
	readonly #mockupsPane = h("div", { class: "workbench-artifact-pane", hidden: true });
	readonly #plansPane = h("div", { class: "workbench-artifact-pane", hidden: true });
	readonly #changesPane = h("div", { class: "workbench-changes-pane", hidden: true });
	readonly #toast = h("div", { class: "surface-toast-host", role: "status" });
	readonly #door: SurfaceDoorStage;
	readonly #address: SurfaceAddress;
	readonly #sentImages = new Map<string, ReceivedAttachments>();
	readonly #localImageUrls = new Map<File, string>();
	readonly #combineSelected = new Set<string>();
	#surface: SurfaceSummary | undefined;
	#liveMount: SurfaceMount | undefined;
	#liveMountedFor = "";
	#liveMountParked = false;
	#mockupFrame: AppFrame | undefined;
	#artifactDialog: SurfaceDialog | undefined;
	#dialogMockupFrame: AppFrame | undefined;
	#tracksOpen = true;
	#tracksUserPinned = false;
	#bodyResizeObserver: ResizeObserver | undefined;
	#panelOpen = true;
	#panelTab: WorkbenchPanelTab = "preview";
	#panelWidth = PANEL_DEFAULT_WIDTH;
	#previewDevice: "desktop" | "mobile" = "desktop";
	#previewDevicePinned = false;
	#selectedMockupId: string | null = null;
	#selectedPlanId: string | null = null;
	#combining = false;
	#explicitCombineActive = false;
	#searchQuery = "";
	#armedKey: string | null = null;
	#armTimer: ReturnType<typeof setTimeout> | undefined;
	#parked = false;
	#deactivated = false;
	#disposed = false;
	#barKey = "";
	#tracksKey = "";
	#headKey = "";
	#progressKey = "";
	#threadKey = "";
	#previewKey = "";
	#mockupPaneKey = "";
	#planPaneKey = "";
	#changesPaneKey = "";
	#toastKey = "";
	#lastRenderedSessionId: string | null = null;
	#lastRenderedMessageCount = 0;
	#lastSyncedRoute = "/";
	#lastTrackAutoSyncKey = "";
	#lastInitialTrackSyncKey = "";

	constructor(host: SurfaceViewHost, signal: AbortSignal, options: AppWorkbenchOptions = {}) {
		this.#host = host;
		this.#options = options;
		signal.addEventListener("abort", () => this.dispose(), { once: true });
		try {
			const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY));
			if (Number.isFinite(saved) && saved >= PANEL_MIN_WIDTH) this.#panelWidth = saved;
		} catch {
			/* WHY: Local browser storage is optional in private or sandboxed contexts. */
		}
		const life = this.#lifetime.signal;
		this.#images = new SurfaceComposerImages(this.#composerShell, life, () => this.#syncComposerState());
		this.#images.setAvailable(host.store.canAttachImages);
		this.#composerShell.append(this.#images.button, this.#composerInput, this.#composerAction);
		this.#composerForm.append(this.#images.tray.el, this.#composerShell, this.#images.tray.status);

		this.#door = new SurfaceDoorStage(life, {
			onRetry: () => {
				if (this.#surface) {
					void this.#host.store.retryPreview(this.#surface.id, {
						keepExplicitCombine: this.#explicitCombineActive,
					});
				}
			},
			isPassUsable: (previewId, pass) => this.#host.store.isPreviewPassUsable(previewId, pass),
			onPassSent: (previewId, pass) => this.#host.store.markPreviewPassConsumed(previewId, pass),
			onNeedFreshPass: (previewId, stalePass) => {
				if (this.#parked || this.#deactivated || !this.#surface) return Promise.resolve(false);
				return this.#host.store.remintPreviewPass(this.#surface.id, previewId, stalePass);
			},
		});

		this.#previewToolbar.append(this.#previewScopeEl, this.#routeInput, this.#previewControls);
		this.#previewViewport.append(this.#door.el, this.#liveMountSlot, this.#previewEmpty);
		this.#previewPane.append(this.#previewToolbar, this.#previewViewport);
		this.#panelContent.append(this.#previewPane, this.#mockupsPane, this.#plansPane, this.#changesPane);
		this.#panel.append(this.#panelResizer, this.#panelContent);

		this.#tracksRail.append(this.#tracksTop, this.#combineBar, this.#trackList);
		this.#threadScroll.append(this.#progressSlot, this.#messagesSlot);
		this.#thread.append(this.#trackHead, this.#threadScroll, this.#composerForm);
		this.#body.append(this.#tracksRail, this.#thread, this.#panel);
		this.#bar.append(this.#barLeft, this.#barRight);
		this.el.append(this.#bar, this.#banner, this.#body, this.#toast);

		this.#address = new SurfaceAddress({
			container: this.el,
			canManage: () => host.managesSites?.() === true,
			changed: () => {
				if (this.#surface && !this.#parked && !this.#deactivated) {
					const workspace = this.#host.store.workspace(this.#surface.id);
					const selectedId = this.#host.store.selectedTrackOf(this.#surface.id);
					const selected = selectedId ? this.#findSession(workspace, selectedId) : undefined;
					this.#barKey = "";
					this.#drawBar(this.#surface, workspace, selected);
				}
			},
			slugChanged: ({ slug, url }) => {
				if (this.#surface) host.store.noteSiteSlug(this.#surface.id, slug, url);
			},
			codeSource: () => {
				const surface = this.#surface;
				if (!surface || surface.sourceKind !== "code_repo") return undefined;
				return {
					repositoryKey: surface.repositoryKey,
					repositorySubpath: surface.repositorySubpath ?? null,
					defaultBranch: surface.defaultBranch ?? "main",
					listRepositories: (abort) => host.store.listCodeRepositories(abort),
					save: async (input) => Boolean(await host.store.bindSurfaceRepository(surface.id, input)),
					lastError: () => host.store.state.error,
				};
			},
			runtimeConfig: () => {
				const surface = this.#surface;
				if (!surface || surface.sourceKind !== "code_repo" || !host.siteHosting?.(surface)) return undefined;
				return {
					load: (abort) => host.store.getSurfaceAppRuntimeConfig(surface.id, abort),
					saveConfig: (input) => host.store.setSurfaceAppRuntimeConfig(surface.id, input),
					grantSecret: (input) => host.store.grantSurfaceAppSecret(input),
					revokeGrant: (grantId) => host.store.revokeSurfaceAppSecretGrant(grantId),
				};
			},
			signal: life,
		});

		this.#wireEvents(life);
		if (typeof ResizeObserver !== "undefined") {
			this.#bodyResizeObserver = new ResizeObserver(() => this.#syncLayoutToWidth());
			this.#bodyResizeObserver.observe(this.#body);
		}
		this.#syncLayoutToWidth();
	}

	#disposeMockupFrame(): void {
		if (!this.#mockupFrame) return;
		this.#mockupFrame.dispose();
		this.#mockupFrame = undefined;
	}

	#closeArtifactDialog(): void {
		if (this.#dialogMockupFrame) {
			this.#dialogMockupFrame.dispose();
			this.#dialogMockupFrame = undefined;
		}
		if (this.#artifactDialog) {
			const dialog = this.#artifactDialog;
			this.#artifactDialog = undefined;
			dialog.close(false);
		}
	}

	#disposeLiveMount(): void {
		if (!this.#liveMount) return;
		this.#liveMount.dispose();
		this.#liveMount = undefined;
		this.#liveMountParked = false;
		this.#liveMountedFor = "";
		this.#liveMountSlot.replaceChildren();
		this.#liveMountSlot.hidden = true;
	}

	#parkLiveMount(): void {
		if (!this.#liveMount) return;
		if (this.#liveMount.park) {
			if (!this.#liveMountParked) {
				this.#liveMount.park();
				this.#liveMountParked = true;
			}
		} else {
			this.#disposeLiveMount();
		}
	}

	#drawLiveMount(surface: SurfaceSummary): boolean {
		const key = `${surface.id}:${surface.siteSlug ?? ""}:${surface.liveUrl ?? ""}`;
		if (key !== this.#liveMountedFor) {
			this.#disposeLiveMount();
			const mounted = this.#host.mount(surface, this.#lifetime.signal);
			if (mounted) {
				this.#liveMount = mounted;
				this.#liveMountedFor = key;
				this.#liveMountParked = false;
				this.#liveMountSlot.replaceChildren(mounted.el);
			}
		}
		if (!this.#liveMount) {
			this.#liveMountSlot.hidden = true;
			return false;
		}
		if (this.#liveMountParked) {
			this.#liveMountParked = false;
			this.#liveMount.activate?.();
		}
		this.#liveMountSlot.hidden = false;
		this.#liveMount.update?.();
		return true;
	}

	focus(): void {
		if (!this.#composerInput.disabled) this.#composerInput.focus({ preventScroll: true });
	}

	park(): void {
		if (this.#parked || this.#disposed) return;
		this.#parked = true;
		this.#disarm();
		this.#address.close();
		this.#closeArtifactDialog();
		this.#disposeMockupFrame();
		this.#door.clear();
		this.#parkLiveMount();
		this.#previewKey = "";
		this.#mockupPaneKey = "";
	}

	activate(): void {
		if (!this.#parked || this.#deactivated || this.#disposed) return;
		this.#parked = false;
		this.#door.resetRetryState();
		this.#previewKey = "";
		this.#mockupPaneKey = "";
		this.#syncLayoutToWidth();
		if (this.#surface) this.update(this.#surface);
	}

	deactivate(): void {
		if (this.#deactivated) return;
		this.#deactivated = true;
		this.#parked = false;
		this.#disarm();
		this.#address.close();
		this.#closeArtifactDialog();
		this.#disposeMockupFrame();
		this.#door.clear();
		this.#liveMount?.deactivate?.();
		this.#liveMountParked = false;
		this.#mockupPaneKey = "";
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.deactivate();
		this.#bodyResizeObserver?.disconnect();
		this.#bodyResizeObserver = undefined;
		this.#door.dispose();
		this.#disposeLiveMount();
		this.#disposeMockupFrame();
		this.#closeArtifactDialog();
		for (const view of this.#sentImages.values()) view.dispose();
		this.#sentImages.clear();
		for (const url of this.#localImageUrls.values()) URL.revokeObjectURL(url);
		this.#localImageUrls.clear();
		this.#lifetime.abort();
		this.el.remove();
	}

	update(surface: SurfaceSummary): void {
		if (this.#parked || this.#deactivated || this.#disposed) return;
		const switchingSurface = this.#surface?.id !== surface.id;
		this.#surface = surface;
		const store = this.#host.store;
		const look = store.lookOf(surface);
		if (switchingSurface) {
			this.#combining = false;
			this.#explicitCombineActive = false;
			this.#lastTrackAutoSyncKey = "";
			this.#lastInitialTrackSyncKey = "";
			this.#combineSelected.clear();
			this.#selectedMockupId = null;
			this.#selectedPlanId = null;
			this.#searchQuery = "";
			this.#searchInput.value = "";
			this.#barKey = "";
			this.#tracksKey = "";
			this.#headKey = "";
			this.#progressKey = "";
			this.#threadKey = "";
			this.#previewKey = "";
			this.#mockupPaneKey = "";
			this.#planPaneKey = "";
			this.#changesPaneKey = "";
			this.#closeArtifactDialog();
			this.#disposeMockupFrame();
			this.#disposeLiveMount();
			this.#previewDevicePinned = false;
			this.#previewDevice = look.kind === "mobile_app" ? "mobile" : "desktop";
		} else if (!this.#previewDevicePinned) {
			this.#previewDevice = look.kind === "mobile_app" ? "mobile" : "desktop";
		}

		const workspace = store.workspace(surface.id);
		const selectedId = store.selectedTrackOf(surface.id);
		const selected = selectedId ? this.#findSession(workspace, selectedId) : undefined;
		if (selected) store.ensureSessionImages(selected);

		this.#syncLayoutToWidth(false);
		this.#drawBar(surface, workspace, selected);
		this.#drawBanner(surface);
		this.#drawTracks(surface, workspace, selected?.id ?? null);
		this.#drawThread(surface, workspace, selected);
		this.#drawPanel(surface, workspace, selected);
		if (this.#panelOpen && this.#panelTab === "preview" && workspace && selected) {
			const preview = workspace.previewState;
			const expectedIds = expectedTrackPreviewChangeIds(selected);
			const trackMatches = preview.previewScope === "track" && preview.selectedSessionId === selected.id;
			if (trackMatches) {
				if (sameIdSet(expectedIds, preview.primary.toggledChangeIds)) {
					this.#lastTrackAutoSyncKey = "";
				} else {
					const syncKey = `${surface.id}:${selected.id}:${expectedIds.join(",")}`;
					if (syncKey !== this.#lastTrackAutoSyncKey) {
						this.#lastTrackAutoSyncKey = syncKey;
						this.#syncPreviewToSelection(surface, selected.id);
					}
				}
			} else if (!this.#explicitCombineActive && preview.previewScope !== "explicit" && expectedIds.length > 0) {
				const initialKey = `${surface.id}:${selected.id}`;
				if (initialKey !== this.#lastInitialTrackSyncKey) {
					this.#lastInitialTrackSyncKey = initialKey;
					this.#syncPreviewToSelection(surface, selected.id);
				}
			}
		}
		this.#drawToast();
		this.#syncComposerState(selected);
	}

	#findSession(workspace: SurfaceWorkspace | undefined, sessionId: string): SurfaceSession | undefined {
		if (!workspace) return undefined;
		return (
			workspace.activeSessions.find((item) => item.id === sessionId) ??
			workspace.recentHistory.find((item) => item.id === sessionId)
		);
	}

	#wireEvents(signal: AbortSignal): void {
		this.#searchInput.addEventListener(
			"input",
			() => {
				this.#searchQuery = this.#searchInput.value.trim().toLowerCase();
				if (this.#surface) {
					this.#tracksKey = "";
					const workspace = this.#host.store.workspace(this.#surface.id);
					const selectedId = this.#host.store.selectedTrackOf(this.#surface.id);
					this.#drawTracks(this.#surface, workspace, selectedId);
				}
			},
			{ signal },
		);

		this.#routeInput.addEventListener(
			"keydown",
			(event) => {
				if (event.key !== "Enter" || event.isComposing) return;
				event.preventDefault();
				void this.#navigatePreviewRoute();
			},
			{ signal },
		);

		this.#composerInput.addEventListener(
			"input",
			() => {
				growToText(this.#composerInput);
				this.#syncComposerState();
			},
			{ signal },
		);

		this.#composerInput.addEventListener(
			"keydown",
			(event) => {
				if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
					event.preventDefault();
					void this.#submitComposer();
				}
			},
			{ signal },
		);

		this.#composerForm.addEventListener(
			"submit",
			(event) => {
				event.preventDefault();
				void this.#submitComposer();
			},
			{ signal },
		);

		this.#panelResizer.addEventListener(
			"pointerdown",
			(event) => {
				if (event.button !== 0) return;
				event.preventDefault();
				const startX = event.clientX;
				const startWidth = Math.max(PANEL_MIN_WIDTH, Math.min(this.#panelCap(), this.#panelWidth));
				const scale = uiScale();
				this.#panelResizer.setPointerCapture?.(event.pointerId);
				this.#body.classList.add("is-resizing");
				const move = (moveEvent: PointerEvent) => {
					const delta = (startX - moveEvent.clientX) / scale;
					this.#panelWidth = Math.max(PANEL_MIN_WIDTH, Math.min(this.#panelCap(), Math.round(startWidth + delta)));
					this.#applyPanelWidth();
				};
				const finish = () => {
					this.#body.classList.remove("is-resizing");
					window.removeEventListener("pointermove", move);
					window.removeEventListener("pointerup", finish);
					window.removeEventListener("pointercancel", finish);
					this.#panelResizer.removeEventListener("lostpointercapture", finish);
					try {
						localStorage.setItem(PANEL_WIDTH_KEY, String(this.#panelWidth));
					} catch {
						/* WHY: Local browser storage is optional in private or sandboxed contexts. */
					}
				};
				window.addEventListener("pointermove", move, { signal });
				window.addEventListener("pointerup", finish, { once: true, signal });
				window.addEventListener("pointercancel", finish, { once: true, signal });
				this.#panelResizer.addEventListener("lostpointercapture", finish, { once: true, signal });
			},
			{ signal },
		);

		this.#panelResizer.addEventListener(
			"keydown",
			(event) => {
				if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
				event.preventDefault();
				const step = event.key === "ArrowLeft" ? 24 : -24;
				this.#panelWidth = Math.max(PANEL_MIN_WIDTH, Math.min(this.#panelCap(), this.#panelWidth + step));
				this.#applyPanelWidth();
			},
			{ signal },
		);

		window.addEventListener("resize", () => this.#syncLayoutToWidth(), { signal });

		this.el.addEventListener(
			"click",
			(event) => {
				if (this.#parked || this.#deactivated) return;
				void this.#onClick(event);
			},
			{ signal },
		);
	}

	#bodyWidth(): number {
		const raw = this.#body.clientWidth;
		return raw > 0 ? raw / uiScale() : 0;
	}

	#isStackedLayout(): boolean {
		if (typeof getComputedStyle === "function") {
			const direction = getComputedStyle(this.#body).flexDirection;
			if (direction === "column" || direction === "column-reverse") return true;
			if (direction === "row" || direction === "row-reverse") return false;
		}
		return typeof window.matchMedia === "function" && window.matchMedia("(max-width: 720px)").matches;
	}

	#isTightRowLayout(): boolean {
		if (this.#isStackedLayout()) return false;
		const width = this.#bodyWidth();
		return width > 0 && width < TRACKS_WIDTH + THREAD_MIN_WIDTH + PANEL_MIN_WIDTH;
	}

	#panelCap(): number {
		const width = this.#bodyWidth();
		if (width > 0) {
			const reservedTracks = this.#tracksOpen ? TRACKS_WIDTH : 0;
			const available = Math.floor(width - reservedTracks - THREAD_MIN_WIDTH);
			return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, available));
		}
		const scale = uiScale();
		return Math.max(
			PANEL_MIN_WIDTH,
			Math.min(PANEL_MAX_WIDTH, Math.floor((window.innerWidth * PANEL_MAX_SHARE) / scale)),
		);
	}

	#syncLayoutToWidth(redrawBar = true): void {
		const width = this.#bodyWidth();
		const prevTracksOpen = this.#tracksOpen;
		if (width > 0) {
			if (this.#isTightRowLayout() && this.#tracksOpen && this.#panelOpen) {
				this.#tracksOpen = false;
				this.#tracksUserPinned = false;
			} else if (!this.#tracksUserPinned) {
				if (this.#isStackedLayout()) {
					this.#tracksOpen = true;
				} else {
					const bothFit = width >= TRACKS_WIDTH + THREAD_MIN_WIDTH + PANEL_MIN_WIDTH;
					if (this.#panelOpen && !bothFit) this.#tracksOpen = false;
					else if (!this.#panelOpen || bothFit) this.#tracksOpen = true;
				}
			}
		}
		this.#tracksRail.hidden = !this.#tracksOpen;
		this.#applyPanelWidth();
		if (redrawBar && prevTracksOpen !== this.#tracksOpen && this.#surface && !this.#parked && !this.#deactivated) {
			const workspace = this.#host.store.workspace(this.#surface.id);
			const selectedId = this.#host.store.selectedTrackOf(this.#surface.id);
			const selected = selectedId ? this.#findSession(workspace, selectedId) : undefined;
			this.#barKey = "";
			this.#drawBar(this.#surface, workspace, selected);
		}
	}

	#applyPanelWidth(): void {
		const max = this.#panelCap();
		const width = Math.max(PANEL_MIN_WIDTH, Math.min(max, this.#panelWidth));
		this.#panel.style.width = `${Math.round(width * uiScale())}px`;
		this.#panelResizer.setAttribute("aria-valuemax", String(max));
		this.#panelResizer.setAttribute("aria-valuenow", String(width));
	}

	#arm(key: string): boolean {
		if (this.#armedKey === key) {
			this.#disarm();
			return true;
		}
		if (this.#armTimer) clearTimeout(this.#armTimer);
		this.#armedKey = key;
		this.#armTimer = setTimeout(() => {
			this.#armedKey = null;
			this.#armTimer = undefined;
			if (this.#surface) this.update(this.#surface);
		}, APPROVE_ARM_MS);
		if (this.#surface) this.update(this.#surface);
		return false;
	}

	#disarm(): void {
		if (this.#armTimer) {
			clearTimeout(this.#armTimer);
			this.#armTimer = undefined;
		}
		this.#armedKey = null;
	}

	#drawBar(surface: SurfaceSummary, workspace?: SurfaceWorkspace, selected?: SurfaceSession): void {
		const store = this.#host.store;
		const look = store.lookOf(surface);
		const addressShown = Boolean(surface.liveUrl && look.kind !== "mobile_app");
		const hosting = addressShown ? this.#host.siteHosting?.(surface) : undefined;
		const addressKey = this.#address.sync(addressShown, hosting, surface.liveUrl);
		const artifacts = selected?.artifacts ?? [];
		const mockupCount = artifacts.filter(isMockupArtifact).length;
		const planCount = artifacts.filter(isPlanArtifact).length;
		const changeCount = selected ? sessionOpenChanges(selected).length : 0;
		const activeTrackCount = workspace?.activeSessions.length ?? surface.activeSessionCount;
		const canManage = this.#host.managesSites?.() === true;
		const canPublish = Boolean(surface.hasUnpublishedChanges || !surface.liveUrl);
		const publishing = surface.publishStatus === "publishing" || Boolean(store.state.busy[`publish:${surface.id}`]);
		const key = JSON.stringify([
			surface.id,
			surface.title,
			surface.repositoryKey,
			surface.repositorySubpath ?? null,
			surface.defaultBranch ?? "main",
			surface.liveUrl,
			surface.unpublishedChangeCount,
			surface.hasUnpublishedChanges,
			surface.publishStatus ?? "idle",
			publishing,
			addressKey,
			this.#tracksOpen,
			activeTrackCount,
			canManage,
			this.#panelOpen,
			this.#panelTab,
			mockupCount,
			planCount,
			changeCount,
			Boolean(this.#options.onFullPreview),
		]);
		if (key === this.#barKey) return;
		this.#barKey = key;

		const addrBtn = this.#address.button();
		const repoText = surface.repositoryKey
			? surface.repositorySubpath
				? `${surface.repositoryKey} · ${surface.repositorySubpath}`
				: surface.repositoryKey
			: null;
		const repoChip = repoText
			? canManage && addressShown
				? h(
						"button",
						{
							type: "button",
							class: "workbench-repo-chip",
							title: t("Code source: {repo}", { repo: repoText }),
							"data-act": "open-source",
						},
						icon("code"),
						h("span", null, repoText),
					)
				: h("span", { class: "workbench-repo-chip", title: repoText }, icon("code"), h("span", null, repoText))
			: null;

		replace(
			this.#barLeft,
			h(
				"button",
				{
					type: "button",
					class: `workbench-tracks-toggle${this.#tracksOpen ? " is-active" : ""}`,
					title: this.#tracksOpen ? t("Hide tracks") : t("Show tracks"),
					"aria-label": this.#tracksOpen ? t("Hide tracks") : t("Show tracks"),
					"aria-pressed": String(this.#tracksOpen),
					"data-act": "toggle-tracks",
				},
				icon("navigation"),
				!this.#tracksOpen && activeTrackCount > 0
					? h("span", { class: "workbench-count-badge" }, String(activeTrackCount))
					: null,
			),
			h("h1", { class: "workbench-title" }, surface.title),
			addrBtn,
			repoChip,
			canPublish
				? h(
						"button",
						{
							type: "button",
							class: "btn btn-small btn-primary workbench-publish-btn",
							disabled: publishing,
							"data-act": "open-publish",
						},
						publishing
							? t("Publishing…")
							: surface.unpublishedChangeCount > 0
								? t("Publish ({count})", { count: surface.unpublishedChangeCount })
								: t("Publish"),
					)
				: null,
		);

		const tabButton = (tab: WorkbenchPanelTab, label: string, glyph: string, count = 0) => {
			const active = this.#panelOpen && this.#panelTab === tab;
			return h(
				"button",
				{
					type: "button",
					class: `workbench-tab-btn${active ? " is-active" : ""}`,
					title: label,
					"aria-pressed": String(active),
					"data-act": "panel-tab",
					"data-tab": tab,
				},
				icon(glyph),
				h("span", { class: "workbench-tab-label" }, label),
				count > 0 ? h("span", { class: "workbench-count-badge" }, String(count)) : null,
			);
		};

		replace(
			this.#barRight,
			h(
				"div",
				{ class: "workbench-tab-group", role: "tablist", "aria-label": t("Side panel views") },
				tabButton("preview", t("Preview"), "globe"),
				tabButton("mockups", t("Mockups"), "sparkle", mockupCount),
				tabButton("plans", t("Plans"), "file", planCount),
				tabButton("changes", t("Changes"), "list", changeCount),
			),
			h("span", { class: "workbench-bar-divider", "aria-hidden": "true" }),
			this.#options.onFullPreview
				? h(
						"button",
						{
							type: "button",
							class: "workbench-icon-btn",
							title: t("Full preview"),
							"aria-label": t("Full preview"),
							"data-act": "full-preview",
						},
						icon("expand"),
					)
				: null,
			h(
				"button",
				{
					type: "button",
					class: `workbench-icon-btn${this.#panelOpen ? " is-active" : ""}`,
					title: this.#panelOpen ? t("Hide side panel") : t("Show side panel"),
					"aria-label": this.#panelOpen ? t("Hide side panel") : t("Show side panel"),
					"aria-pressed": String(this.#panelOpen),
					"data-act": "toggle-panel",
				},
				icon("panel-right"),
			),
		);
	}

	#drawBanner(surface: SurfaceSummary): void {
		const error = this.#host.store.state.error;
		const publishError = surface.publishStatus === "failed" ? surface.lastPublishError : null;
		if (!error && !publishError) {
			this.#banner.hidden = true;
			this.#banner.replaceChildren();
			return;
		}
		this.#banner.hidden = false;
		replace(
			this.#banner,
			error
				? h(
						"div",
						{ class: "workbench-banner is-error", role: "alert" },
						h("span", null, error),
						h(
							"button",
							{
								type: "button",
								class: "workbench-banner-close",
								"aria-label": t("Dismiss"),
								"data-act": "dismiss-error",
							},
							icon("close"),
						),
					)
				: null,
			publishError
				? h("div", { class: "workbench-banner is-warn", role: "status" }, h("span", null, publishError))
				: null,
		);
	}

	#drawTracks(surface: SurfaceSummary, workspace: SurfaceWorkspace | undefined, selectedId: string | null): void {
		const active = workspace?.activeSessions ?? [];
		const history = workspace?.recentHistory ?? [];
		const query = this.#searchQuery;
		const matches = (session: SurfaceSession) =>
			!query || session.title.toLowerCase().includes(query) || session.prompt.toLowerCase().includes(query);
		const filteredActive = active.filter(matches);
		const filteredHistory = history.filter(matches);
		const activeIds = new Set(active.map((item) => item.id));
		for (const id of [...this.#combineSelected]) {
			if (!activeIds.has(id)) this.#combineSelected.delete(id);
		}
		if (active.length < 2 && this.#combining) {
			this.#combining = false;
			this.#combineSelected.clear();
		}
		const combineBusy = Boolean(this.#host.store.state.busy[`combine-tracks:${surface.id}`]);
		const key = JSON.stringify([
			surface.id,
			selectedId,
			this.#combining,
			[...this.#combineSelected].sort(),
			combineBusy,
			this.#armedKey,
			query,
			filteredActive.map((s) => [
				s.id,
				s.title,
				s.state,
				s.openChangeCount,
				s.updatedAt,
				s.checksSummary?.status ?? null,
				s.artifacts?.length ?? 0,
				s.changes.some((c) => c.status === "conflicted"),
			]),
			filteredHistory.map((s) => [s.id, s.title, s.state, s.updatedAt, s.artifacts?.length ?? 0]),
		]);
		if (key === this.#tracksKey) return;
		this.#tracksKey = key;

		replace(
			this.#tracksTop,
			h(
				"div",
				{ class: "workbench-tracks-actions" },
				h(
					"button",
					{
						type: "button",
						class: `btn btn-small btn-primary workbench-new-track-btn${selectedId === null ? " is-active" : ""}`,
						"data-act": "new-track",
					},
					icon("plus"),
					h("span", null, t("New track")),
				),
				active.length >= 2
					? h(
							"button",
							{
								type: "button",
								class: `btn btn-small workbench-combine-toggle${this.#combining ? " is-active" : ""}`,
								"aria-pressed": String(this.#combining),
								"data-act": "toggle-combine",
							},
							icon("filter"),
							h("span", null, t("Combine")),
						)
					: null,
			),
			this.#searchInput,
		);

		this.#combineBar.hidden = !this.#combining;
		if (this.#combining) {
			const count = this.#combineSelected.size;
			const valid = count >= 2 && count <= 8;
			const landArmed = this.#armedKey === `combine-land:${surface.id}`;
			replace(
				this.#combineBar,
				h(
					"p",
					{ class: "workbench-combine-hint" },
					count === 0
						? t("Select 2 to 8 tracks to preview or ship together.")
						: t("{count} tracks selected", { count }),
				),
				h(
					"div",
					{ class: "workbench-combine-buttons" },
					h(
						"button",
						{
							type: "button",
							class: "btn btn-small",
							disabled: !valid || combineBusy,
							"data-act": "combine-preview",
						},
						t("Preview combined"),
					),
					h(
						"button",
						{
							type: "button",
							class: `btn btn-small btn-primary${landArmed ? " is-confirming" : ""}`,
							disabled: !valid || combineBusy,
							"data-act": "combine-land",
						},
						approveLabel(t("Ship combined"), landArmed),
					),
				),
			);
		} else {
			this.#combineBar.replaceChildren();
		}

		const renderRow = (session: SurfaceSession, isHistory: boolean): HTMLElement => {
			const meta = trackStateMeta(session);
			const isSelected = session.id === selectedId;
			const openCount = sessionOpenChanges(session).length;
			const artifactCount = session.artifacts?.length ?? 0;
			const attention = !isHistory && sessionNeedsAttention(session);
			const checked = this.#combineSelected.has(session.id);

			const card = h(
				"button",
				{
					type: "button",
					class: [
						"workbench-track-item",
						isSelected && "is-selected",
						attention && "is-attention",
						isHistory && "is-history",
					]
						.filter(Boolean)
						.join(" "),
					"data-act": this.#combining && !isHistory ? "toggle-combine-item" : "select-track",
					"data-session": session.id,
					"aria-current": isSelected ? "true" : undefined,
				},
				h(
					"div",
					{ class: "workbench-track-row-top" },
					this.#combining && !isHistory
						? h("input", {
								type: "checkbox",
								class: "workbench-track-check",
								checked,
								tabindex: "-1",
								"aria-label": session.title,
							})
						: h("span", { class: `workbench-dot is-${meta.tone}`, "aria-hidden": "true" }),
					h("span", { class: "workbench-track-title" }, session.title),
				),
				h(
					"div",
					{ class: "workbench-track-row-meta" },
					h("span", { class: `workbench-track-state is-${meta.tone}` }, meta.label),
					openCount > 0
						? h(
								"span",
								{ class: "workbench-track-meta-chip" },
								openCount === 1 ? t("1 change") : t("{count} changes", { count: openCount }),
							)
						: null,
					artifactCount > 0
						? h(
								"span",
								{ class: "workbench-track-meta-chip" },
								artifactCount === 1 ? t("1 artifact") : t("{count} artifacts", { count: artifactCount }),
							)
						: null,
					session.checksSummary
						? h(
								"span",
								{ class: `workbench-track-meta-chip is-${checksMeta(session.checksSummary).tone}` },
								checksMeta(session.checksSummary).label,
							)
						: null,
				),
			);
			return card;
		};

		replace(
			this.#trackList,
			filteredActive.length > 0
				? h(
						"div",
						{ class: "workbench-track-group" },
						h("div", { class: "workbench-track-group-label" }, t("Active tracks")),
						...filteredActive.map((session) => renderRow(session, false)),
					)
				: h(
						"div",
						{ class: "workbench-track-empty" },
						query ? t("No matching tracks.") : t("No active tracks yet."),
					),
			filteredHistory.length > 0
				? h(
						"details",
						{ class: "workbench-history", open: filteredActive.length === 0 },
						h(
							"summary",
							{ class: "workbench-history-summary" },
							icon("chevron-down"),
							h("span", null, t("History ({count})", { count: filteredHistory.length })),
						),
						h(
							"div",
							{ class: "workbench-history-list" },
							...filteredHistory.map((session) => renderRow(session, true)),
						),
					)
				: null,
		);
	}

	#drawThread(
		surface: SurfaceSummary,
		workspace: SurfaceWorkspace | undefined,
		selected: SurfaceSession | undefined,
	): void {
		const store = this.#host.store;
		if (!selected) {
			this.#headKey = "";
			this.#trackHead.hidden = true;
			this.#trackHead.replaceChildren();
			this.#progressSlot.hidden = true;
			this.#progressSlot.replaceChildren();
			const emptyKey = `empty:${surface.id}:${workspace?.activeSessions.length ?? 0}`;
			if (emptyKey !== this.#threadKey) {
				this.#threadKey = emptyKey;
				this.#lastRenderedSessionId = null;
				this.#lastRenderedMessageCount = 0;
				replace(
					this.#messagesSlot,
					h(
						"div",
						{ class: "workbench-welcome" },
						h("h2", { class: "workbench-welcome-title" }, t("Start a new update track")),
						h(
							"p",
							{ class: "workbench-welcome-copy" },
							t(
								"Each track runs in its own isolated workspace so you can discuss ideas, review mockups and plans, and preview changes without affecting other tracks.",
							),
						),
					),
				);
			}
			return;
		}

		this.#trackHead.hidden = false;
		const running = isRunningSession(selected);
		const shippable = canShipSession(selected);
		const shipBusy = Boolean(store.state.busy[`ship-track:${selected.id}`]);
		const discardBusy = Boolean(store.state.busy[`discard-session:${selected.id}`]);
		const previewBusy = Boolean(store.state.busy[`track-preview:${surface.id}`]);
		const isHistory = selected.state === "completed" || selected.state === "discarded";
		const prUrl = safeExternalUrl(selected.externalPr?.url);
		const showingThisTrackPreview = Boolean(
			this.#panelOpen &&
				this.#panelTab === "preview" &&
				workspace?.previewState.previewScope === "track" &&
				workspace.previewState.selectedSessionId === selected.id &&
				this.#previewMatchesSelection(workspace.previewState, selected),
		);
		const headKey = JSON.stringify([
			selected.id,
			selected.title,
			selected.state,
			selected.openChangeCount,
			selected.checksSummary?.status ?? null,
			prUrl,
			selected.externalPr?.number ?? null,
			running,
			shippable,
			showingThisTrackPreview,
			shipBusy,
			discardBusy,
			previewBusy,
			this.#armedKey,
		]);
		if (headKey !== this.#headKey) {
			this.#headKey = headKey;
			const meta = trackStateMeta(selected);
			const shipArmed = this.#armedKey === `ship:${selected.id}`;
			const shipPublishArmed = this.#armedKey === `ship-publish:${selected.id}`;
			replace(
				this.#trackHead,
				h(
					"div",
					{ class: "workbench-track-head-info" },
					h("h2", { class: "workbench-track-head-title", title: selected.title }, selected.title),
					h(
						"div",
						{ class: "workbench-track-head-badges" },
						h("span", { class: `workbench-pill is-${meta.tone}` }, meta.label),
						selected.checksSummary
							? h(
									"span",
									{ class: `workbench-pill is-${checksMeta(selected.checksSummary).tone}` },
									checksMeta(selected.checksSummary).label,
								)
							: null,
						prUrl
							? h(
									"a",
									{
										class: "workbench-pr-link",
										href: prUrl,
										target: "_blank",
										rel: "noopener noreferrer",
									},
									icon("external"),
									h(
										"span",
										null,
										selected.externalPr?.number
											? t("PR #{number}", { number: selected.externalPr.number })
											: t("Pull request"),
									),
								)
							: null,
					),
				),
				h(
					"div",
					{ class: "workbench-track-head-actions" },
					selected.state === "failed"
						? h(
								"button",
								{
									type: "button",
									class: "btn btn-small",
									"data-act": "retry-track",
									"data-session": selected.id,
								},
								icon("reload"),
								h("span", null, t("Retry")),
							)
						: null,
					!isHistory && sessionOpenChanges(selected).length > 0 && !showingThisTrackPreview
						? h(
								"button",
								{
									type: "button",
									class: "btn btn-small",
									disabled: previewBusy,
									"data-act": "preview-track",
									"data-session": selected.id,
								},
								icon("globe"),
								h("span", null, t("Preview")),
							)
						: null,
					shippable
						? h(
								"button",
								{
									type: "button",
									class: `btn btn-small${shipArmed ? " is-confirming" : ""}`,
									disabled: shipBusy,
									title: t("Merge this track into Base without publishing live yet"),
									"data-act": "ship-track",
									"data-session": selected.id,
								},
								approveLabel(t("Ship"), shipArmed),
							)
						: null,
					shippable
						? h(
								"button",
								{
									type: "button",
									class: `btn btn-small btn-primary${shipPublishArmed ? " is-confirming" : ""}`,
									disabled: shipBusy,
									title: t("Merge this track into Base and publish live"),
									"data-act": "ship-publish-track",
									"data-session": selected.id,
								},
								approveLabel(t("Ship & publish"), shipPublishArmed),
							)
						: null,
					!isHistory
						? h(
								"button",
								{
									type: "button",
									class: "workbench-icon-btn is-danger",
									title: t("Discard track"),
									"aria-label": t("Discard track"),
									disabled: discardBusy,
									"data-act": "discard-track",
									"data-session": selected.id,
								},
								icon("trash"),
							)
						: null,
				),
			);
		}

		const steps = selected.progressSteps ?? [];
		const showProgress = Boolean(running || selected.currentActivity || steps.length > 0 || selected.checksSummary);
		this.#progressSlot.hidden = !showProgress;
		if (showProgress) {
			const progressKey = JSON.stringify([
				selected.id,
				running,
				selected.currentActivity ?? null,
				steps,
				selected.checksSummary ?? null,
			]);
			if (progressKey !== this.#progressKey) {
				this.#progressKey = progressKey;
				replace(this.#progressSlot, this.#renderProgressCard(selected, running, steps));
			}
		} else if (this.#progressKey !== "") {
			this.#progressKey = "";
			this.#progressSlot.replaceChildren();
		}

		const pendingNotes = store.state.notes.filter((note) => note.sessionId === selected.id);
		const sessionImages = store.state.sessionImages[selected.id];
		const threadKey = JSON.stringify([
			selected.id,
			selected.state,
			selected.updatedAt,
			selected.question,
			selected.messages.length,
			selected.messages.at(-1)?.id ?? "",
			selected.artifacts?.map((a) => [a.id, a.revision, a.title, a.summary]) ?? [],
			selected.changes.map((c) => [c.id, c.status, c.title, c.optionGroupKey ?? null, c.conflictPaths?.length ?? 0]),
			pendingNotes.map((n) => n.id),
			sessionImages?.messages.length ?? 0,
			this.#armedKey,
			Boolean(store.state.busy[`reply:${selected.id}`]),
		]);
		if (threadKey === this.#threadKey) return;
		const wasNearBottom =
			this.#threadScroll.scrollHeight - this.#threadScroll.scrollTop - this.#threadScroll.clientHeight < 96;
		const switchingTrack = this.#lastRenderedSessionId !== selected.id;
		const newMessage = selected.messages.length > this.#lastRenderedMessageCount;
		this.#threadKey = threadKey;
		this.#lastRenderedSessionId = selected.id;
		this.#lastRenderedMessageCount = selected.messages.length;

		const imagesByMessageId = new Map(
			(sessionImages?.messages ?? []).map((entry) => [entry.messageId, entry] as const),
		);
		const rows: HTMLElement[] = [];
		for (const message of selected.messages) {
			rows.push(this.#renderMessage(selected, message, imagesByMessageId.get(message.id)));
		}
		for (const note of pendingNotes) {
			rows.push(this.#renderPendingNote(note));
		}
		if (selected.state === "needs_input" && selected.question) {
			rows.push(this.#renderQuestionCard(selected));
		}
		if (selected.artifacts && selected.artifacts.length > 0) {
			rows.push(this.#renderArtifactStrip(selected.artifacts));
		}
		if (selected.changes.length > 0) {
			rows.push(this.#renderInlineChanges(selected));
		}
		replace(this.#messagesSlot, ...rows);
		if (switchingTrack || (newMessage && wasNearBottom)) {
			this.#threadScroll.scrollTop = this.#threadScroll.scrollHeight;
		}
	}

	#renderProgressCard(
		session: SurfaceSession,
		running: boolean,
		steps: readonly SurfaceSessionProgressStep[],
	): HTMLElement {
		const activity = session.currentActivity || (running ? t("Working on this track…") : null);
		const checks = session.checksSummary;
		return h(
			"section",
			{ class: `workbench-progress${running ? " is-running" : ""}` },
			activity
				? h(
						"div",
						{ class: "workbench-progress-head" },
						running ? h("span", { class: "surface-state is-running", "aria-hidden": "true" }) : icon("check"),
						h("span", { class: "workbench-progress-activity" }, activity),
					)
				: null,
			steps.length > 0
				? h(
						"ol",
						{ class: "workbench-progress-steps" },
						...steps.map((step) =>
							h(
								"li",
								{ class: `workbench-step is-${step.status}` },
								h("span", { class: `workbench-step-dot is-${step.status}`, "aria-hidden": "true" }),
								h("span", { class: "workbench-step-label" }, step.label),
								step.detail ? h("span", { class: "workbench-step-detail" }, step.detail) : null,
							),
						),
					)
				: null,
			checks
				? h(
						"div",
						{ class: "workbench-checks-summary" },
						h("span", { class: `workbench-pill is-${checksMeta(checks).tone}` }, checksMeta(checks).label),
						checks.summary ? h("span", { class: "workbench-checks-text" }, checks.summary) : null,
						checks.commands && checks.commands.length > 0
							? h(
									"div",
									{ class: "workbench-checks-commands" },
									...checks.commands.map((cmd) =>
										h(
											"span",
											{ class: `workbench-cmd-chip is-${cmd.status}` },
											h("span", null, cmd.name),
											cmd.durationMs !== null && cmd.durationMs !== undefined
												? h("span", { class: "workbench-cmd-dur" }, formatDurationMs(cmd.durationMs))
												: null,
										),
									),
								)
							: null,
					)
				: null,
		);
	}

	#person(userId: string | null | undefined): SurfaceTeammate | undefined {
		const name = this.#host.store.memberName(userId);
		return userId && name ? { userId, name } : undefined;
	}

	#sentImageView(
		key: string,
		sessionId: string,
		attached: { readonly clientInputId: string; readonly images: readonly SurfaceImageRef[] },
	): ReceivedAttachments {
		const known = this.#sentImages.get(key);
		if (known) return known;
		const images = attached.images;
		const view = new ReceivedAttachments(
			{
				id: attached.clientInputId,
				attachmentCount: images.length,
				attachments: images.map((image, index) => ({
					kind: "image" as const,
					name: images.length > 1 ? t("Image {n}", { n: index + 1 }) : t("Image"),
					mediaType: image.mediaType,
					bytes: image.bytes,
					reference: { sha256: image.sha256, bytes: image.bytes, mediaType: image.mediaType },
				})),
			},
			(_id, index, abort) => {
				const image = images[index];
				return image
					? this.#host.store.readSessionImage(sessionId, attached.clientInputId, image, abort)
					: Promise.reject(new Error(t("This image is not available.")));
			},
		);
		view.el.classList.add("surface-message-images");
		this.#sentImages.set(key, view);
		return view;
	}

	#localImages(files: readonly File[] | undefined): HTMLElement | null {
		if (!files?.length) return null;
		return h(
			"div",
			{ class: "surface-message-images is-sending" },
			...files.map((file) => {
				let url = this.#localImageUrls.get(file);
				if (!url) {
					url = URL.createObjectURL(file);
					this.#localImageUrls.set(file, url);
				}
				return h("img", { src: url, alt: file.name, class: "surface-message-image" });
			}),
		);
	}

	#renderMessage(
		session: SurfaceSession,
		message: SurfaceSessionMessage,
		attached?: { readonly clientInputId: string; readonly images: readonly SurfaceImageRef[] },
	): HTMLElement {
		if (message.authorKind === "system") {
			return h(
				"div",
				{ class: "workbench-msg is-system" },
				h("span", { class: "workbench-msg-system-dot", "aria-hidden": "true" }),
				h("span", { class: "workbench-msg-system-text" }, message.text),
				h("time", { class: "workbench-msg-time", datetime: message.createdAt }, fmtTime(message.createdAt)),
			);
		}
		if (message.authorKind === "session") {
			return h(
				"article",
				{ class: "workbench-msg is-assistant" },
				h(
					"div",
					{ class: "workbench-msg-meta" },
					h("span", { class: "workbench-msg-author" }, t("Assistant")),
					h("time", { class: "workbench-msg-time", datetime: message.createdAt }, fmtTime(message.createdAt)),
				),
				h("div", { class: "workbench-msg-body" }, cachedMarkdown(message.text)),
			);
		}
		if (message.authorKind === "agent") {
			const label = message.authorLabel?.trim() || "Co-Founder";
			return h(
				"article",
				{ class: "workbench-msg is-agent" },
				h(
					"div",
					{ class: "workbench-msg-meta" },
					h("span", { class: "workbench-msg-author" }, label),
					h("time", { class: "workbench-msg-time", datetime: message.createdAt }, fmtTime(message.createdAt)),
				),
				h("div", { class: "workbench-msg-body" }, cachedMarkdown(message.text)),
			);
		}
		const author = this.#person(message.authorUserId);
		const images = attached
			? this.#sentImageView(`${session.id}:${message.id}:${attached.clientInputId}`, session.id, attached).el
			: null;
		return h(
			"article",
			{ class: `workbench-msg is-member${message.authorKind === "note" ? " is-note" : ""}` },
			h(
				"div",
				{ class: "workbench-msg-meta" },
				author ? personAvatar(author.name, author.userId) : null,
				h("span", { class: "workbench-msg-author" }, author?.name ?? t("You")),
				h("time", { class: "workbench-msg-time", datetime: message.createdAt }, fmtTime(message.createdAt)),
			),
			images,
			h("p", { class: "workbench-msg-text" }, message.text),
		);
	}

	#renderPendingNote(note: SurfaceNote): HTMLElement {
		return h(
			"article",
			{ class: "workbench-msg is-member is-pending" },
			h(
				"div",
				{ class: "workbench-msg-meta" },
				h("span", { class: "workbench-msg-author" }, t("You")),
				h("time", { class: "workbench-msg-time", datetime: note.at }, fmtTime(note.at)),
			),
			this.#localImages(note.files),
			h("p", { class: "workbench-msg-text" }, note.text),
		);
	}

	#renderQuestionCard(session: SurfaceSession): HTMLElement {
		const question = session.question!;
		const busy = Boolean(this.#host.store.state.busy[`reply:${session.id}`]);
		return h(
			"section",
			{ class: "workbench-question-card" },
			h("div", { class: "workbench-question-label" }, t("Waiting for your input")),
			h("p", { class: "workbench-question-text" }, question.text),
			question.options.length > 0
				? h(
						"div",
						{ class: "workbench-question-options" },
						...question.options.map((option) =>
							h(
								"button",
								{
									type: "button",
									class: "btn btn-small",
									disabled: busy,
									"data-act": "answer-option",
									"data-session": session.id,
									"data-option": option,
								},
								option,
							),
						),
					)
				: null,
		);
	}

	#renderArtifactStrip(artifacts: readonly SurfaceSessionArtifact[]): HTMLElement {
		return h(
			"section",
			{ class: "workbench-artifacts-strip" },
			h("div", { class: "workbench-section-label" }, t("Mockups & documents")),
			h(
				"div",
				{ class: "workbench-artifact-cards" },
				...artifacts.map((artifact) =>
					h(
						"button",
						{
							type: "button",
							class: "workbench-artifact-card",
							"data-act": "open-artifact",
							"data-artifact": artifact.id,
							"data-kind": artifact.kind,
						},
						h(
							"div",
							{ class: "workbench-artifact-card-head" },
							icon(isMockupArtifact(artifact) ? "sparkle" : "file"),
							h("span", { class: "workbench-artifact-kind" }, artifactKindLabel(artifact.kind)),
							h("span", { class: "workbench-artifact-rev" }, t("v{revision}", { revision: artifact.revision })),
						),
						h("strong", { class: "workbench-artifact-title" }, artifact.title),
						artifact.summary ? h("p", { class: "workbench-artifact-summary" }, artifact.summary) : null,
					),
				),
			),
		);
	}

	#renderInlineChanges(session: SurfaceSession): HTMLElement {
		const grouped = groupSessionChanges(session.changes);
		const running = isRunningSession(session);
		const store = this.#host.store;
		const singleShippableChange =
			grouped.length === 1 &&
			grouped[0]?.kind === "change" &&
			sessionOpenChanges(session).length === 1 &&
			canShipSession(session);
		return h(
			"section",
			{ class: "workbench-inline-changes" },
			h(
				"div",
				{ class: "workbench-section-head" },
				h("span", { class: "workbench-section-label" }, t("Track changes")),
				h(
					"button",
					{
						type: "button",
						class: "workbench-link-btn",
						"data-act": "panel-tab",
						"data-tab": "changes",
					},
					t("Inspect all"),
				),
			),
			...grouped.map((entry) => {
				if (entry.kind === "option_group") {
					const groupKey = optionGroupId(session.id, entry.group.key);
					const busy = Boolean(store.state.busy[`option-group:${groupKey}`]);
					return h(
						"div",
						{ class: "workbench-option-group" },
						h("div", { class: "workbench-option-group-title" }, entry.group.title),
						...entry.group.options.map((option) =>
							h(
								"div",
								{ class: "workbench-change-row" },
								h(
									"div",
									{ class: "workbench-change-copy" },
									h("strong", { class: "workbench-change-title" }, option.title),
									option.summary ? h("p", { class: "workbench-change-summary" }, option.summary) : null,
								),
								!running
									? h(
											"button",
											{
												type: "button",
												class: "btn btn-small btn-primary",
												disabled: busy,
												"data-act": "choose-option",
												"data-session": session.id,
												"data-change": option.id,
											},
											t("Use this one"),
										)
									: null,
							),
						),
					);
				}
				const ch = entry.change;
				const open = isOpenChange(ch);
				const busy = Boolean(store.state.busy[`change:${ch.id}`]);
				const approveArmed = this.#armedKey === `approve:${ch.id}`;
				const stats = diffStatsLabel(ch);
				return h(
					"div",
					{ class: `workbench-change-row is-${ch.status}` },
					h(
						"div",
						{ class: "workbench-change-copy" },
						h(
							"div",
							{ class: "workbench-change-head" },
							h("strong", { class: "workbench-change-title" }, ch.title),
							changeStatusBadge(ch),
						),
						ch.summary ? h("p", { class: "workbench-change-summary" }, ch.summary) : null,
						stats ? h("span", { class: "workbench-change-stats" }, stats) : null,
					),
					open && !running && !singleShippableChange
						? h(
								"div",
								{ class: "workbench-change-actions" },
								h(
									"button",
									{
										type: "button",
										class: `btn btn-small btn-primary${approveArmed ? " is-confirming" : ""}`,
										disabled: busy,
										"data-act": "approve-change",
										"data-session": session.id,
										"data-change": ch.id,
									},
									approveLabel(t("Approve"), approveArmed),
								),
								h(
									"button",
									{
										type: "button",
										class: "btn btn-small",
										disabled: busy,
										"data-act": "discard-change",
										"data-session": session.id,
										"data-change": ch.id,
									},
									t("Discard"),
								),
							)
						: null,
				);
			}),
		);
	}

	#drawPanel(
		surface: SurfaceSummary,
		workspace: SurfaceWorkspace | undefined,
		selected: SurfaceSession | undefined,
	): void {
		this.#panel.hidden = !this.#panelOpen;
		if (!this.#panelOpen) {
			this.#door.clear();
			this.#parkLiveMount();
			this.#disposeMockupFrame();
			this.#previewKey = "";
			this.#mockupPaneKey = "";
			return;
		}
		this.#applyPanelWidth();
		const artifacts = selected?.artifacts ?? [];
		const mockups = artifacts.filter(isMockupArtifact);
		const plans = artifacts.filter(isPlanArtifact);

		if (this.#selectedMockupId && !mockups.some((item) => item.id === this.#selectedMockupId)) {
			this.#selectedMockupId = null;
		}
		if (!this.#selectedMockupId && mockups.length > 0) this.#selectedMockupId = mockups[0]!.id;

		if (this.#selectedPlanId && !plans.some((item) => item.id === this.#selectedPlanId)) {
			this.#selectedPlanId = null;
		}
		if (!this.#selectedPlanId && plans.length > 0) this.#selectedPlanId = plans[0]!.id;

		this.#previewPane.hidden = this.#panelTab !== "preview";
		this.#mockupsPane.hidden = this.#panelTab !== "mockups";
		this.#plansPane.hidden = this.#panelTab !== "plans";
		this.#changesPane.hidden = this.#panelTab !== "changes";

		if (this.#panelTab === "preview") {
			this.#drawPreviewPane(surface, workspace, selected);
		} else {
			this.#door.clear();
			this.#parkLiveMount();
			this.#previewKey = "";
		}
		if (this.#panelTab === "mockups") {
			this.#drawArtifactPane(this.#mockupsPane, mockups, this.#selectedMockupId, "mockup");
		} else if (this.#mockupFrame) {
			this.#disposeMockupFrame();
			this.#mockupsPane.replaceChildren();
			this.#mockupPaneKey = "";
		}
		if (this.#panelTab === "plans") {
			this.#drawArtifactPane(this.#plansPane, plans, this.#selectedPlanId, "plan");
		}
		if (this.#panelTab === "changes") {
			this.#drawChangesPane(selected);
		}
	}

	#drawPreviewPane(
		surface: SurfaceSummary,
		workspace: SurfaceWorkspace | undefined,
		selected: SurfaceSession | undefined,
	): void {
		const store = this.#host.store;
		const preview = workspace?.previewState;
		const primary = preview?.primary;
		const route = primary?.activeRoute || "/";
		if (document.activeElement !== this.#routeInput && route !== this.#lastSyncedRoute) {
			this.#lastSyncedRoute = route;
			this.#routeInput.value = route;
		}

		const previewMatches = this.#previewMatchesSelection(preview, selected);
		const showDoor = Boolean(primary && primary.status !== "live_baseline" && previewMatches);
		const scopeLabel = this.#previewScopeLabel(preview, workspace, selected, previewMatches);
		const liveHref = safeExternalUrl(surface.liveUrl);
		const pendingTrackChanges = selected ? expectedTrackPreviewChangeIds(selected).length : 0;
		const syncingPreview = Boolean(store.state.busy[`track-preview:${surface.id}`]);
		const previewKey = JSON.stringify([
			surface.id,
			selected?.id ?? null,
			scopeLabel,
			this.#previewDevice,
			liveHref,
			showDoor,
			previewMatches,
			pendingTrackChanges,
			primary?.previewId ?? null,
			primary?.status ?? "none",
			primary?.activeRoute ?? "/",
			primary?.memberPass ?? null,
			primary?.doorActionUrl ?? null,
			primary?.errorDetail ?? null,
			primary?.fixing ?? false,
			primary?.kept?.previewId ?? null,
			syncingPreview,
		]);
		if (previewKey === this.#previewKey) {
			if (!showDoor) {
				const mounted = this.#drawLiveMount(surface);
				this.#previewEmpty.hidden = mounted;
			}
			return;
		}
		this.#previewKey = previewKey;

		this.#previewScopeEl.textContent = scopeLabel;
		replace(
			this.#previewControls,
			h(
				"button",
				{
					type: "button",
					class: `workbench-icon-btn${this.#previewDevice === "desktop" ? " is-active" : ""}`,
					title: t("Desktop width"),
					"aria-label": t("Desktop width"),
					"aria-pressed": String(this.#previewDevice === "desktop"),
					"data-act": "preview-device",
					"data-device": "desktop",
				},
				icon("computer"),
			),
			h(
				"button",
				{
					type: "button",
					class: `workbench-icon-btn${this.#previewDevice === "mobile" ? " is-active" : ""}`,
					title: t("Mobile width"),
					"aria-label": t("Mobile width"),
					"aria-pressed": String(this.#previewDevice === "mobile"),
					"data-act": "preview-device",
					"data-device": "mobile",
				},
				h("span", { class: "surface-phone-icon", "aria-hidden": "true" }),
			),
			h(
				"button",
				{
					type: "button",
					class: "workbench-icon-btn",
					title: t("Refresh preview"),
					"aria-label": t("Refresh preview"),
					"data-act": "refresh-preview",
				},
				icon("reload"),
			),
			liveHref
				? h(
						"a",
						{
							class: "workbench-icon-btn",
							href: liveHref,
							target: "_blank",
							rel: "noopener noreferrer",
							title: t("Open live app"),
							"aria-label": t("Open live app"),
						},
						icon("external"),
					)
				: null,
		);

		this.#previewViewport.dataset.device = this.#previewDevice;
		if (showDoor && primary) {
			this.#disposeLiveMount();
			this.#previewEmpty.hidden = true;
			this.#door.el.hidden = false;
			this.#door.sync(primary, surface.title);
			this.#door.setIdentityTokens(store.companyIdentityTokens());
		} else {
			this.#door.clear();
			this.#door.el.hidden = true;
			const mounted = this.#drawLiveMount(surface);
			this.#previewEmpty.hidden = mounted;
			if (!mounted) {
				if (pendingTrackChanges > 0 && selected) {
					replace(
						this.#previewEmpty,
						syncingPreview ? h("span", { class: "surface-state is-running", "aria-hidden": "true" }) : null,
						h(
							"p",
							null,
							syncingPreview
								? t("Loading track preview…")
								: t("This track has staged changes ready to preview."),
						),
						!syncingPreview
							? h(
									"button",
									{
										type: "button",
										class: "btn btn-small btn-primary",
										"data-act": "preview-track",
										"data-session": selected.id,
									},
									icon("globe"),
									h("span", null, t("Preview track")),
								)
							: null,
					);
				} else {
					replace(
						this.#previewEmpty,
						h(
							"p",
							null,
							t("No preview changes on this track yet. Ask for a change or inspect Mockups and Plans."),
						),
						liveHref
							? h(
									"a",
									{
										class: "btn btn-small",
										href: liveHref,
										target: "_blank",
										rel: "noopener noreferrer",
									},
									icon("external"),
									h("span", null, t("Open live app")),
								)
							: null,
					);
				}
			}
		}
	}

	#previewMatchesSelection(
		preview: SurfacePreviewCompositionState | undefined,
		selected: SurfaceSession | undefined,
	): boolean {
		if (!preview || preview.primary.status === "live_baseline") return false;
		if (preview.previewScope === "explicit") return this.#explicitCombineActive;
		if (preview.previewScope === "track") return Boolean(selected && preview.selectedSessionId === selected.id);
		return preview.selectedSessionId == null || Boolean(selected && preview.selectedSessionId === selected.id);
	}

	#syncPreviewToSelection(surface: SurfaceSummary, sessionId: string | null): void {
		const store = this.#host.store;
		const workspace = store.workspace(surface.id);
		const preview = workspace?.previewState;
		if (!preview) return;
		const route = this.#routeInput.value.trim() || preview.primary.activeRoute || "/";
		const selected = sessionId ? this.#findSession(workspace, sessionId) : undefined;
		const toggledMismatch =
			sessionId !== null &&
			preview.previewScope === "track" &&
			preview.selectedSessionId === sessionId &&
			selected !== undefined &&
			!sameIdSet(expectedTrackPreviewChangeIds(selected), preview.primary.toggledChangeIds);
		const needsSync =
			preview.previewScope === "explicit" ||
			toggledMismatch ||
			(sessionId === null
				? preview.selectedSessionId != null || preview.primary.status !== "live_baseline"
				: preview.selectedSessionId !== sessionId || preview.previewScope !== "track");
		if (needsSync) {
			void store.selectTrackPreview(surface.id, { sessionId, activeRoute: route });
		}
	}

	#previewScopeLabel(
		preview: SurfacePreviewCompositionState | undefined,
		workspace: SurfaceWorkspace | undefined,
		selected: SurfaceSession | undefined,
		previewMatches: boolean,
	): string {
		if (!preview || preview.primary.status === "live_baseline" || !previewMatches) return t("Live baseline");
		if (preview.previewScope === "explicit") {
			const toggled = new Set(preview.primary.toggledChangeIds);
			const trackCount = (workspace?.activeSessions ?? []).filter((session) =>
				session.changes.some((change) => toggled.has(change.id)),
			).length;
			return trackCount >= 2 ? t("Combined preview ({count} tracks)", { count: trackCount }) : t("Combined preview");
		}
		if (preview.previewScope === "track" && selected && preview.selectedSessionId === selected.id) {
			return t("Isolated track preview");
		}
		return t("Preview");
	}

	#drawArtifactPane(
		container: HTMLElement,
		items: readonly SurfaceSessionArtifact[],
		selectedId: string | null,
		group: "mockup" | "plan",
	): void {
		if (items.length === 0) {
			const emptyKey = `empty:${group}`;
			if ((group === "mockup" ? this.#mockupPaneKey : this.#planPaneKey) === emptyKey) return;
			if (group === "mockup") {
				this.#disposeMockupFrame();
				this.#mockupPaneKey = emptyKey;
			} else {
				this.#planPaneKey = emptyKey;
			}
			replace(
				container,
				h(
					"div",
					{ class: "workbench-pane-empty" },
					h(
						"p",
						null,
						group === "mockup"
							? t("No mockups on this track yet. Ask the assistant to sketch a design or UI mockup.")
							: t("No plans or documents on this track yet. Ask the assistant to write a plan or checklist."),
					),
				),
			);
			return;
		}
		const current = items.find((item) => item.id === selectedId) ?? items[0]!;
		const store = this.#host.store;
		const cached = store.state.sessionArtifacts[current.id];
		const loading = Boolean(store.state.loadingArtifacts[current.id]);
		const failedRev = store.state.failedArtifacts[current.id];
		const loadFailed = failedRev !== undefined && failedRev >= current.revision;
		const resolved =
			cached &&
			cached.revision >= current.revision &&
			(cached.contentText !== null || cached.contentFormat === "image_ref")
				? cached
				: current;
		if (resolved.contentText === null && resolved.contentFormat !== "image_ref" && !loading && !loadFailed) {
			void store.loadSessionArtifact(current.id, current.revision);
		}
		const paneKey = JSON.stringify([
			group,
			current.id,
			resolved.revision,
			resolved.title,
			resolved.summary,
			resolved.contentFormat,
			resolved.contentText !== null ? resolved.contentText.length : null,
			resolved.updatedAt,
			loading,
			loadFailed,
			items.map((item) => [item.id, item.title, item.revision]),
		]);
		if ((group === "mockup" ? this.#mockupPaneKey : this.#planPaneKey) === paneKey) return;
		if (group === "mockup") {
			this.#disposeMockupFrame();
			this.#mockupPaneKey = paneKey;
		} else {
			this.#planPaneKey = paneKey;
		}

		let canExpand = false;
		let viewer: HTMLElement;
		if (loading) {
			viewer = h("div", { class: "workbench-pane-empty" }, h("p", null, t("Loading…")));
		} else if (resolved.contentFormat === "html" && resolved.contentText !== null) {
			const framed = framePage(resolved.contentText);
			if (framed !== null) {
				canExpand = true;
				this.#mockupFrame = new AppFrame(
					{ html: framed },
					resolved.title,
					"workbench-artifact-iframe",
					refuseMockupCall,
					() => {},
				);
				viewer = this.#mockupFrame.frame;
			} else {
				viewer = h(
					"div",
					{ class: "workbench-artifact-unframed" },
					h("p", { class: "workbench-artifact-unframed-note" }, t("This page can't be shown live, so its source is shown.")),
					h("pre", { class: "workbench-artifact-pre" }, resolved.contentText),
				);
			}
		} else if (resolved.contentFormat === "markdown" && resolved.contentText !== null) {
			canExpand = true;
			viewer = h("div", { class: "workbench-artifact-markdown" }, cachedMarkdown(resolved.contentText));
		} else if (resolved.contentFormat === "json" && resolved.contentText !== null) {
			canExpand = true;
			viewer = h("pre", { class: "workbench-artifact-pre" }, resolved.contentText);
		} else if (resolved.contentFormat === "image_ref") {
			viewer = h("div", { class: "workbench-pane-empty" }, h("p", null, resolved.summary || resolved.title));
		} else {
			viewer = h(
				"div",
				{ class: "workbench-pane-empty" },
				h("p", null, t("Artifact content is unavailable.")),
				h(
					"button",
					{
						type: "button",
						class: "btn btn-small",
						"data-act": "retry-artifact",
						"data-artifact": current.id,
						"data-revision": String(current.revision),
					},
					t("Retry"),
				),
			);
		}

		replace(
			container,
			items.length > 1
				? h(
						"div",
						{ class: "workbench-artifact-picker" },
						...items.map((item) =>
							h(
								"button",
								{
									type: "button",
									class: `workbench-artifact-pill${item.id === current.id ? " is-active" : ""}`,
									"data-act": "select-artifact",
									"data-group": group,
									"data-artifact": item.id,
								},
								item.title,
							),
						),
					)
				: null,
			h(
				"div",
				{ class: "workbench-artifact-head" },
				h("strong", { class: "workbench-artifact-heading", title: resolved.title }, resolved.title),
				canExpand
					? h(
							"button",
							{
								type: "button",
								class: "workbench-icon-btn",
								title: t("Show {name} large", { name: resolved.title }),
								"aria-label": t("Show {name} large", { name: resolved.title }),
								"data-act": "expand-artifact",
								"data-artifact": current.id,
							},
							icon("expand"),
						)
					: null,
			),
			h(
				"div",
				{ class: "workbench-artifact-meta" },
				h("span", { class: "workbench-pill is-idle" }, artifactKindLabel(resolved.kind)),
				h("span", { class: "workbench-artifact-rev" }, t("v{revision}", { revision: resolved.revision })),
				h("time", { class: "workbench-msg-time", datetime: resolved.updatedAt }, fmtTime(resolved.updatedAt)),
			),
			resolved.summary ? h("p", { class: "workbench-artifact-lead", title: resolved.summary }, resolved.summary) : null,
			h("div", { class: "workbench-artifact-stage" }, viewer),
		);
	}

	#expandArtifact(artifactId: string): void {
		const surface = this.#surface;
		if (!surface) return;
		const store = this.#host.store;
		const selectedId = store.selectedTrackOf(surface.id);
		const session = selectedId ? this.#findSession(store.workspace(surface.id), selectedId) : undefined;
		const summary = session?.artifacts?.find((item) => item.id === artifactId);
		const cached = store.state.sessionArtifacts[artifactId];
		const artifact =
			cached && (!summary || cached.revision >= summary.revision) && cached.contentText !== null ? cached : summary;
		if (!artifact || artifact.contentText === null) return;
		this.#closeArtifactDialog();
		let body: HTMLElement;
		if (artifact.contentFormat === "html") {
			const framed = framePage(artifact.contentText);
			if (framed === null) return;
			this.#dialogMockupFrame = new AppFrame(
				{ html: framed },
				artifact.title,
				"page-preview-frame",
				refuseMockupCall,
				() => {},
			);
			body = this.#dialogMockupFrame.frame;
		} else if (artifact.contentFormat === "markdown") {
			body = h("div", { class: "workbench-artifact-dialog-body workbench-artifact-markdown" }, cachedMarkdown(artifact.contentText));
		} else if (artifact.contentFormat === "json") {
			body = h("pre", { class: "workbench-artifact-dialog-body workbench-artifact-pre" }, artifact.contentText);
		} else {
			return;
		}
		const dialog = new SurfaceDialog(artifact.title, "file-preview-dialog page-preview-dialog", () => {
			if (this.#dialogMockupFrame) {
				this.#dialogMockupFrame.dispose();
				this.#dialogMockupFrame = undefined;
			}
			if (this.#artifactDialog === dialog) this.#artifactDialog = undefined;
		});
		this.#artifactDialog = dialog;
		dialog.content.append(h("h2", null, artifact.title), body);
		dialog.open();
	}

	#drawChangesPane(selected: SurfaceSession | undefined): void {
		const store = this.#host.store;
		const paneKey = selected
			? JSON.stringify([
					selected.id,
					selected.state,
					selected.checksSummary ?? null,
					selected.changes.map((c) => [
						c.id,
						c.status,
						c.title,
						c.summary,
						c.optionGroupKey ?? null,
						c.affectedPaths.length,
						c.conflictPaths?.length ?? 0,
						c.canUndo,
					]),
					this.#armedKey,
				])
			: "empty";
		if (paneKey === this.#changesPaneKey) return;
		this.#changesPaneKey = paneKey;
		if (!selected || selected.changes.length === 0) {
			replace(
				this.#changesPane,
				h("div", { class: "workbench-pane-empty" }, h("p", null, t("No changes staged on this track yet."))),
			);
			return;
		}
		const running = isRunningSession(selected);
		const grouped = groupSessionChanges(selected.changes);
		const checks = selected.checksSummary;

		replace(
			this.#changesPane,
			checks
				? h(
						"div",
						{ class: "workbench-checks-card" },
						h(
							"div",
							{ class: "workbench-checks-card-head" },
							h("strong", null, t("Verification")),
							h("span", { class: `workbench-pill is-${checksMeta(checks).tone}` }, checksMeta(checks).label),
						),
						checks.summary ? h("p", { class: "workbench-change-summary" }, checks.summary) : null,
						checks.commands && checks.commands.length > 0
							? h(
									"ul",
									{ class: "workbench-checks-list" },
									...checks.commands.map((cmd) =>
										h(
											"li",
											{ class: `workbench-checks-item is-${cmd.status}` },
											h("span", null, cmd.name),
											h("span", { class: "workbench-cmd-dur" }, formatDurationMs(cmd.durationMs)),
										),
									),
								)
							: null,
					)
				: null,
			...grouped.map((entry) => {
				if (entry.kind === "option_group") {
					const groupKey = optionGroupId(selected.id, entry.group.key);
					const busy = Boolean(store.state.busy[`option-group:${groupKey}`]);
					return h(
						"section",
						{ class: "workbench-change-card" },
						h("div", { class: "workbench-option-group-title" }, entry.group.title),
						...entry.group.options.map((opt) =>
							h(
								"div",
								{ class: "workbench-change-row" },
								h(
									"div",
									{ class: "workbench-change-copy" },
									h("strong", { class: "workbench-change-title" }, opt.title),
									opt.summary ? h("p", { class: "workbench-change-summary" }, opt.summary) : null,
								),
								!running
									? h(
											"button",
											{
												type: "button",
												class: "btn btn-small btn-primary",
												disabled: busy,
												"data-act": "choose-option",
												"data-session": selected.id,
												"data-change": opt.id,
											},
											t("Use this one"),
										)
									: null,
							),
						),
					);
				}
				const ch = entry.change;
				const open = isOpenChange(ch);
				const busy = Boolean(store.state.busy[`change:${ch.id}`]);
				const approveArmed = this.#armedKey === `approve:${ch.id}`;
				const stats = diffStatsLabel(ch);
				return h(
					"section",
					{ class: `workbench-change-card is-${ch.status}` },
					h(
						"div",
						{ class: "workbench-change-head" },
						h("strong", { class: "workbench-change-title" }, ch.title),
						changeStatusBadge(ch),
					),
					ch.summary ? h("p", { class: "workbench-change-summary" }, ch.summary) : null,
					stats ? h("div", { class: "workbench-change-stats" }, stats) : null,
					ch.affectedPaths.length > 0
						? h(
								"details",
								{ class: "workbench-change-files" },
								h(
									"summary",
									null,
									ch.affectedPaths.length === 1
										? t("1 affected file")
										: t("{count} affected files", { count: ch.affectedPaths.length }),
								),
								h(
									"ul",
									{ class: "workbench-file-list" },
									...ch.affectedPaths.map((path) => h("li", null, path)),
								),
							)
						: null,
					ch.conflictPaths && ch.conflictPaths.length > 0
						? h(
								"p",
								{ class: "workbench-conflict-note" },
								t("Overlaps with another change across {count} files.", { count: ch.conflictPaths.length }),
							)
						: null,
					h(
						"div",
						{ class: "workbench-change-actions" },
						open && !running
							? h(
									"button",
									{
										type: "button",
										class: `btn btn-small btn-primary${approveArmed ? " is-confirming" : ""}`,
										disabled: busy,
										"data-act": "approve-change",
										"data-session": selected.id,
										"data-change": ch.id,
									},
									approveLabel(t("Approve"), approveArmed),
								)
							: null,
						open && !running
							? h(
									"button",
									{
										type: "button",
										class: "btn btn-small",
										disabled: busy,
										"data-act": "discard-change",
										"data-session": selected.id,
										"data-change": ch.id,
									},
									t("Discard"),
								)
							: null,
						ch.status === "merged" && ch.canUndo
							? h(
									"button",
									{
										type: "button",
										class: "btn btn-small",
										disabled: busy,
										"data-act": "rollback-change",
										"data-change": ch.id,
									},
									t("Undo"),
								)
							: null,
					),
				);
			}),
		);
	}

	#drawToast(): void {
		const undo = this.#host.store.state.undo;
		const key = undo ? `${undo.id}:${undo.pending ? "p" : "r"}:${undo.label}` : "";
		if (key === this.#toastKey) return;
		this.#toastKey = key;
		replace(
			this.#toast,
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
							h("span", null, t("Merged “{title}” into Base", { title: undo.label })),
							h(
								"button",
								{ type: "button", "data-act": "undo" },
								h("span", { class: "surface-ring", "aria-hidden": "true" }),
								t("Undo"),
							),
						)
				: null,
		);
	}

	#syncComposerState(selected?: SurfaceSession): void {
		const surface = this.#surface;
		const store = this.#host.store;
		const resolved =
			selected ??
			(surface
				? this.#findSession(store.workspace(surface.id), store.selectedTrackOf(surface.id) ?? "")
				: undefined);
		const canWrite = this.#host.canWrite?.() !== false;
		const running = Boolean(resolved && isRunningSession(resolved));
		const discarded = resolved?.state === "discarded";
		const busy = Boolean(resolved && store.state.busy[`reply:${resolved.id}`]);
		const stopBusy = Boolean(resolved && store.state.busy[`stop-turn:${resolved.id}`]);
		const textReady = this.#composerInput.value.trim().length > 0 && !this.#images.problem;

		this.#composerInput.disabled = !canWrite || running || Boolean(discarded);
		this.#composerInput.placeholder = !resolved
			? t("Describe what you want to plan, design, or change…")
			: running
				? t("Working… press Stop to pause")
				: discarded
					? t("This track was discarded. Start a new track to continue.")
					: t("Continue discussing or refine this track…");

		if (running && resolved) {
			replace(
				this.#composerAction,
				h(
					"button",
					{
						type: "button",
						class: "btn btn-small btn-danger workbench-composer-stop",
						disabled: stopBusy,
						"data-act": "stop-turn",
						"data-session": resolved.id,
					},
					icon("stop"),
					h("span", null, stopBusy ? t("Stopping…") : t("Stop")),
				),
			);
		} else {
			replace(
				this.#composerAction,
				h(
					"button",
					{
						type: "submit",
						class: `surface-send workbench-send${textReady && !busy && canWrite && !discarded ? " is-ready" : ""}`,
						disabled: !textReady || busy || !canWrite || Boolean(discarded),
						"aria-label": resolved ? t("Send reply") : t("Start track"),
					},
					icon("send"),
				),
			);
		}
	}

	async #submitComposer(): Promise<void> {
		const surface = this.#surface;
		const text = this.#composerInput.value.trim();
		if (!surface || !text || this.#composerInput.disabled || this.#images.problem) return;
		const store = this.#host.store;
		const selectedId = store.selectedTrackOf(surface.id);
		const files = this.#images.files;
		this.#composerInput.value = "";
		growToText(this.#composerInput);
		this.#images.set([]);
		this.#syncComposerState();

		if (!selectedId) {
			const created = await store.startSession(surface.id, text, { previewBaseChangeIds: [] }, files);
			if (!created) {
				if (!this.#composerInput.value) {
					this.#composerInput.value = text;
					growToText(this.#composerInput);
				}
				if (!this.#images.files.length) this.#images.set(files);
				this.#syncComposerState();
			}
			return;
		}
		const sent = await store.reply(selectedId, text, files);
		if (!sent) {
			if (!this.#composerInput.value) {
				this.#composerInput.value = text;
				growToText(this.#composerInput);
			}
			if (!this.#images.files.length) this.#images.set(files);
			this.#syncComposerState();
		}
	}

	async #navigatePreviewRoute(): Promise<void> {
		const surface = this.#surface;
		if (!surface) return;
		const raw = this.#routeInput.value.trim();
		const activeRoute = raw.startsWith("/") ? raw : `/${raw}`;
		this.#routeInput.value = activeRoute;
		this.#lastSyncedRoute = activeRoute;
		const store = this.#host.store;
		const workspace = store.workspace(surface.id);
		const preview = workspace?.previewState;
		if (
			this.#explicitCombineActive &&
			preview?.previewScope === "explicit" &&
			preview.primary.toggledChangeIds.length > 0
		) {
			const toggled = new Set(preview.primary.toggledChangeIds);
			const combineSessionIds = (workspace?.activeSessions ?? [])
				.filter((session) => session.changes.some((change) => toggled.has(change.id)))
				.map((session) => session.id);
			if (combineSessionIds.length >= 2) {
				await store.selectTrackPreview(surface.id, { combineSessionIds, activeRoute });
				return;
			}
		}
		this.#explicitCombineActive = false;
		const sessionId = store.selectedTrackOf(surface.id);
		await store.selectTrackPreview(surface.id, { sessionId, activeRoute });
	}

	async #onClick(event: MouseEvent): Promise<void> {
		const target = (event.target as Element).closest<HTMLElement>("[data-act]");
		if (!target || !this.el.contains(target)) return;
		const surface = this.#surface;
		if (!surface) return;
		const store = this.#host.store;
		const { act } = target.dataset;

		switch (act) {
			case "address":
				this.#address.toggle(event.detail === 0);
				return;
			case "open-source":
				this.#address.openSource(event.detail === 0);
				return;
			case "open-publish":
				openPublishSheet(store, surface);
				return;
			case "full-preview":
				this.#options.onFullPreview?.();
				return;
			case "toggle-tracks": {
				this.#tracksOpen = !this.#tracksOpen;
				this.#tracksUserPinned = true;
				if (this.#tracksOpen && this.#panelOpen && this.#isTightRowLayout()) {
					this.#panelOpen = false;
				}
				this.update(surface);
				return;
			}
			case "toggle-panel": {
				this.#panelOpen = !this.#panelOpen;
				if (this.#panelOpen && this.#tracksOpen && this.#isTightRowLayout()) {
					this.#tracksOpen = false;
					this.#tracksUserPinned = false;
				}
				this.update(surface);
				return;
			}
			case "panel-tab": {
				const tab = target.dataset.tab as WorkbenchPanelTab | undefined;
				if (!tab) return;
				if (this.#panelOpen && this.#panelTab === tab && target.classList.contains("workbench-tab-btn")) {
					this.#panelOpen = false;
				} else {
					this.#panelOpen = true;
					this.#panelTab = tab;
					if (this.#tracksOpen && this.#isTightRowLayout()) {
						this.#tracksOpen = false;
						this.#tracksUserPinned = false;
					}
				}
				this.update(surface);
				return;
			}
			case "new-track":
				this.#combining = false;
				this.#explicitCombineActive = false;
				this.#lastTrackAutoSyncKey = "";
				this.#lastInitialTrackSyncKey = "";
				this.#combineSelected.clear();
				this.#disarm();
				store.selectTrack(surface.id, null);
				this.#syncPreviewToSelection(surface, null);
				this.update(surface);
				this.focus();
				return;
			case "select-track": {
				const sessionId = target.dataset.session;
				if (!sessionId) return;
				this.#combining = false;
				this.#explicitCombineActive = false;
				this.#lastTrackAutoSyncKey = "";
				this.#lastInitialTrackSyncKey = "";
				this.#combineSelected.clear();
				this.#disarm();
				store.selectTrack(surface.id, sessionId);
				this.#selectedMockupId = null;
				this.#selectedPlanId = null;
				this.#syncPreviewToSelection(surface, sessionId);
				this.update(surface);
				return;
			}
			case "toggle-combine":
				this.#combining = !this.#combining;
				this.#combineSelected.clear();
				this.#disarm();
				this.update(surface);
				return;
			case "toggle-combine-item": {
				const sessionId = target.dataset.session;
				if (!sessionId) return;
				if (this.#combineSelected.has(sessionId)) this.#combineSelected.delete(sessionId);
				else if (this.#combineSelected.size < 8) this.#combineSelected.add(sessionId);
				this.update(surface);
				return;
			}
			case "combine-preview": {
				const ids = [...this.#combineSelected];
				if (ids.length < 2) return;
				this.#panelOpen = true;
				this.#panelTab = "preview";
				this.#explicitCombineActive = true;
				if (this.#tracksOpen && this.#isTightRowLayout()) {
					this.#tracksOpen = false;
					this.#tracksUserPinned = false;
				}
				await store.combineTracks(surface.id, ids, false);
				this.update(surface);
				return;
			}
			case "combine-land": {
				const ids = [...this.#combineSelected];
				if (ids.length < 2) return;
				if (!this.#arm(`combine-land:${surface.id}`)) return;
				const result = await store.combineTracks(surface.id, ids, true);
				if (result) {
					this.#combining = false;
					this.#explicitCombineActive = false;
					this.#combineSelected.clear();
				}
				this.update(surface);
				return;
			}
			case "preview-track": {
				const sessionId = target.dataset.session;
				if (!sessionId) return;
				this.#combining = false;
				this.#explicitCombineActive = false;
				this.#lastTrackAutoSyncKey = "";
				this.#lastInitialTrackSyncKey = "";
				this.#combineSelected.clear();
				this.#panelOpen = true;
				this.#panelTab = "preview";
				if (this.#tracksOpen && this.#isTightRowLayout()) {
					this.#tracksOpen = false;
					this.#tracksUserPinned = false;
				}
				store.selectTrack(surface.id, sessionId);
				await store.selectTrackPreview(surface.id, {
					sessionId,
					activeRoute: this.#routeInput.value.trim() || "/",
				});
				this.update(surface);
				return;
			}
			case "preview-device": {
				const device = target.dataset.device === "mobile" ? "mobile" : "desktop";
				this.#previewDevice = device;
				this.#previewDevicePinned = true;
				this.update(surface);
				return;
			}
			case "refresh-preview":
				this.#lastTrackAutoSyncKey = "";
				this.#lastInitialTrackSyncKey = "";
				await store.retryPreview(surface.id, { keepExplicitCombine: this.#explicitCombineActive });
				return;
			case "stop-turn": {
				const sessionId = target.dataset.session;
				if (!sessionId) return;
				await store.stopSessionTurn(sessionId);
				this.update(surface);
				return;
			}
			case "retry-track": {
				const sessionId = target.dataset.session;
				if (!sessionId) return;
				await store.retrySession(sessionId);
				return;
			}
			case "ship-track": {
				const sessionId = target.dataset.session;
				if (!sessionId || !this.#arm(`ship:${sessionId}`)) return;
				await store.shipTrack(sessionId, false);
				this.update(surface);
				return;
			}
			case "ship-publish-track": {
				const sessionId = target.dataset.session;
				if (!sessionId || !this.#arm(`ship-publish:${sessionId}`)) return;
				await store.shipTrack(sessionId, true);
				this.update(surface);
				return;
			}
			case "discard-track": {
				const sessionId = target.dataset.session;
				if (!sessionId) return;
				const session = store.session(sessionId);
				const message = session
					? t("This will discard “{title}” and remove its unmerged changes.", { title: session.title })
					: t("This will discard the track and remove its unmerged changes.");
				const confirmed = await confirmDialog(message, t("Discard"), true);
				if (!confirmed) return;
				const ok = await store.discardSession(sessionId);
				if (ok) {
					this.#explicitCombineActive = false;
					this.#lastTrackAutoSyncKey = "";
					this.#lastInitialTrackSyncKey = "";
					const nextActive = store.workspace(surface.id)?.activeSessions[0]?.id ?? null;
					store.selectTrack(surface.id, nextActive);
					this.#syncPreviewToSelection(surface, nextActive);
					this.update(surface);
				}
				return;
			}
			case "answer-option": {
				const sessionId = target.dataset.session;
				const option = target.dataset.option;
				if (!sessionId || !option) return;
				await store.reply(sessionId, option);
				return;
			}
			case "open-artifact": {
				const artifactId = target.dataset.artifact;
				const kind = target.dataset.kind as SurfaceSessionArtifactKind | undefined;
				if (!artifactId) return;
				this.#panelOpen = true;
				if (kind === "mockup") {
					this.#panelTab = "mockups";
					this.#selectedMockupId = artifactId;
				} else {
					this.#panelTab = "plans";
					this.#selectedPlanId = artifactId;
				}
				if (this.#tracksOpen && this.#isTightRowLayout()) {
					this.#tracksOpen = false;
					this.#tracksUserPinned = false;
				}
				const session = store.session(store.selectedTrackOf(surface.id) ?? "");
				const meta = session?.artifacts?.find((item) => item.id === artifactId);
				void store.loadSessionArtifact(artifactId, meta?.revision, { force: true });
				this.update(surface);
				return;
			}
			case "select-artifact": {
				const artifactId = target.dataset.artifact;
				const group = target.dataset.group;
				if (!artifactId) return;
				if (group === "mockup") this.#selectedMockupId = artifactId;
				else this.#selectedPlanId = artifactId;
				const session = store.session(store.selectedTrackOf(surface.id) ?? "");
				const meta = session?.artifacts?.find((item) => item.id === artifactId);
				void store.loadSessionArtifact(artifactId, meta?.revision, { force: true });
				this.update(surface);
				return;
			}
			case "retry-artifact": {
				const artifactId = target.dataset.artifact;
				if (!artifactId) return;
				const parsedRev = Number(target.dataset.revision);
				const expectedRevision = Number.isFinite(parsedRev) && parsedRev >= 1 ? parsedRev : undefined;
				void store.loadSessionArtifact(artifactId, expectedRevision, { force: true });
				this.update(surface);
				return;
			}
			case "expand-artifact": {
				const artifactId = target.dataset.artifact;
				if (!artifactId) return;
				this.#expandArtifact(artifactId);
				return;
			}
			case "choose-option": {
				const sessionId = target.dataset.session;
				const changeId = target.dataset.change;
				if (!sessionId || !changeId) return;
				await store.chooseOption(sessionId, changeId);
				return;
			}
			case "approve-change": {
				const sessionId = target.dataset.session;
				const changeId = target.dataset.change;
				if (!sessionId || !changeId || !this.#arm(`approve:${changeId}`)) return;
				await store.approveChange(sessionId, changeId);
				return;
			}
			case "discard-change": {
				const sessionId = target.dataset.session;
				const changeId = target.dataset.change;
				if (!sessionId || !changeId) return;
				await store.discardChange(sessionId, changeId);
				return;
			}
			case "rollback-change": {
				const changeId = target.dataset.change;
				if (!changeId) return;
				await store.rollbackChange(changeId);
				return;
			}
			case "undo":
				await store.undo();
				return;
			case "dismiss-error":
				store.clearError();
				return;
		}
	}
}
