// @vitest-environment jsdom
import type {
	SurfaceCombineTracksResult,
	SurfacePreviewCompositionState,
	SurfaceSession,
	SurfaceSessionArtifact,
} from "@qorpera/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAppWorkbenchSurface } from "../src/app/surface-kinds.ts";
import { SurfaceRail } from "../src/app/views/surface-rail.ts";
import { SurfaceView } from "../src/app/views/surface-view.ts";
import { PAGE_CONTENT, PAGE_FRAME_URL, PAGE_READY } from "../src/ui/page-frame.ts";
import {
	CHANGES,
	COMPANY,
	change,
	fakeClient,
	fakeSiteHosting,
	MESSAGE_IDS,
	PREVIEW_IDS,
	SESSION,
	SURFACE,
	session,
	sessionMessage,
	storeWith,
	summary,
	VALID_PASS,
	workspace,
} from "./surface-fixtures.ts";

const SESSION_2 = "33333333-3333-4333-8333-333333333334";
const ARTIFACT_MOCKUP = "88888888-8888-4888-8888-888888888881";
const ARTIFACT_PLAN = "88888888-8888-4888-8888-888888888882";
const HOSTED_SITE = "99999999-9999-4999-8999-999999999991";

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function appSummary(overrides: Parameters<typeof summary>[0] = {}) {
	return summary({
		id: SURFACE,
		slug: "web-app",
		title: "Web App",
		kind: "web_app",
		icon: "spark",
		sourceKind: "code_repo",
		repositoryKey: "qorpera/qorpera-base",
		repositorySubpath: "packages/web",
		defaultBranch: "master",
		siteSlug: "stifteren-web-app",
		liveUrl: "https://stifteren-web-app.qorpera.site/",
		activeSessionCount: 2,
		pendingChangeCount: 2,
		needsAttentionCount: 1,
		...overrides,
	});
}

function mockupArtifact(overrides: Partial<SurfaceSessionArtifact> = {}): SurfaceSessionArtifact {
	return {
		id: ARTIFACT_MOCKUP,
		sessionId: SESSION,
		surfaceId: SURFACE,
		kind: "mockup",
		artifactKey: "nav-redesign",
		title: "Sidebar Redesign Mockup",
		summary: "Three-pane navigation layout",
		contentFormat: "html",
		contentText: null,
		imageRef: null,
		changeId: null,
		revision: 2,
		createdByKind: "agent",
		createdByUserId: null,
		createdAt: "2026-11-27T10:00:00Z",
		updatedAt: "2026-11-27T10:05:00Z",
		...overrides,
	};
}

function planArtifact(overrides: Partial<SurfaceSessionArtifact> = {}): SurfaceSessionArtifact {
	return {
		id: ARTIFACT_PLAN,
		sessionId: SESSION,
		surfaceId: SURFACE,
		kind: "plan",
		artifactKey: "rollout-plan",
		title: "Migration Plan",
		summary: "Step-by-step rollout checklist",
		contentFormat: "markdown",
		contentText: null,
		imageRef: null,
		changeId: null,
		revision: 1,
		createdByKind: "agent",
		createdByUserId: null,
		createdAt: "2026-11-27T10:00:00Z",
		updatedAt: "2026-11-27T10:02:00Z",
		...overrides,
	};
}

describe("AppWorkbenchView", () => {
	const {
		showModal: originalShowModal,
		show: originalShow,
		close: originalClose,
	} = HTMLDialogElement.prototype;

	beforeEach(() => {
		HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
			this.setAttribute("open", "");
		};
		HTMLDialogElement.prototype.show = HTMLDialogElement.prototype.showModal;
		HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
			this.removeAttribute("open");
		};
	});

	afterEach(() => {
		document.body.replaceChildren();
		localStorage.clear();
		HTMLDialogElement.prototype.showModal = originalShowModal;
		HTMLDialogElement.prototype.show = originalShow;
		HTMLDialogElement.prototype.close = originalClose;
		vi.restoreAllMocks();
	});

	it("mounts AppWorkbenchView only for code_repo app surfaces and leaves website, studio, and ops unchanged", async () => {
		const webApp = appSummary();
		const website = summary({ id: "22222222-2222-4222-8222-222222222223", slug: "website", kind: "website" });
		const studio = summary({
			id: "22222222-2222-4222-8222-222222222224",
			slug: "identity",
			kind: "identity",
			archetype: "studio",
			sourceKind: "folder",
			repositoryKey: null,
		});
		const ops = summary({
			id: "22222222-2222-4222-8222-222222222225",
			slug: "inbox",
			kind: "inbox",
			archetype: "ops",
			sourceKind: "native_ops",
			repositoryKey: null,
		});
		expect(isAppWorkbenchSurface(webApp, { kind: "web_app" })).toBe(true);
		expect(isAppWorkbenchSurface(webApp, { kind: "mobile_app" })).toBe(true);
		expect(isAppWorkbenchSurface(webApp, { kind: "desktop_app" })).toBe(true);
		expect(isAppWorkbenchSurface({ ...webApp, id: "local-phone-app" }, { kind: "mobile_app" })).toBe(false);
		expect(isAppWorkbenchSurface(website, { kind: "website" })).toBe(false);
		expect(isAppWorkbenchSurface(studio, { kind: "identity" })).toBe(false);
		expect(isAppWorkbenchSurface(ops, { kind: "inbox" })).toBe(false);

		const setPreviewSelection = vi.fn();
		const trackA = session(["staged"], { id: SESSION, surfaceId: webApp.id, title: "Auth refactor" });
		const trackB = session(["staged"], {
			id: SESSION_2,
			surfaceId: webApp.id,
			title: "Billing webhook",
			changes: [
				change(CHANGES[1], 1, "staged", { sessionId: SESSION_2, surfaceId: webApp.id, title: "Add webhook" }),
			],
		});
		const client = fakeClient({
			listSurfaces: vi.fn(async () => [webApp, website]),
			getSurfaceWorkspace: vi.fn(async (id: string) =>
				id === webApp.id ? workspace([trackA, trackB], { surface: webApp }) : workspace([], { surface: website }),
			),
			setPreviewSelection,
		});
		const store = storeWith(client);
		await store.load();

		const appView = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "web-app");
		document.body.append(appView.el);
		for (let i = 0; i < 3; i++) {
			await flush();
			appView.update();
		}
		expect(appView.el.classList.contains("is-workbench")).toBe(true);
		expect(appView.el.querySelector(".workbench")).not.toBeNull();
		expect(appView.el.querySelectorAll(".workbench-track-item").length).toBe(2);
		expect(setPreviewSelection).not.toHaveBeenCalled();

		const siteView = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "website");
		document.body.append(siteView.el);
		for (let i = 0; i < 3; i++) {
			await flush();
			siteView.update();
		}
		expect(siteView.el.classList.contains("is-workbench")).toBe(false);
		expect(siteView.el.querySelector(".workbench")).toBeNull();

		const rail = new SurfaceRail(store, COMPANY, new AbortController().signal);
		document.body.append(rail.el);
		rail.update("website");
		const appRow = rail.el.querySelector<HTMLElement>('.rail-surface[data-surface-slug="web-app"]')!;
		const siteRow = rail.el.querySelector<HTMLElement>('.rail-surface[data-surface-slug="website"]')!;
		expect(appRow.querySelector(".visually-hidden")?.textContent).toContain("Needs your attention");
		expect(siteRow.querySelector(".visually-hidden")?.textContent ?? "").not.toContain("Needs your attention");

		appView.dispose();
		siteView.dispose();
		store.dispose();
	});

	it("starts isolated tracks with empty previewBaseChangeIds, stops running turns non-destructively, and answers questions", async () => {
		const webApp = appSummary();
		let trackA: SurfaceSession = session(["staged"], {
			id: SESSION,
			surfaceId: webApp.id,
			title: "Auth flow",
			state: "running",
			currentActivity: "Updating session middleware",
			progressSteps: [
				{ id: "s1", label: "Inspect middleware", status: "done" },
				{ id: "s2", label: "Add cookie check", status: "in_progress" },
			],
			checksSummary: {
				status: "passed",
				summary: "All 12 tests passed",
				commands: [{ name: "vitest", status: "passed", durationMs: 1400 }],
			},
			externalPr: {
				provider: "github",
				repository: "qorpera/qorpera-base",
				number: 42,
				url: "https://github.com/qorpera/qorpera-base/pull/42",
				state: "open",
			},
		});
		const trackB: SurfaceSession = session(["staged"], {
			id: SESSION_2,
			surfaceId: webApp.id,
			title: "Design polish",
			state: "needs_input",
			question: { text: "Which sidebar width?", options: ["Compact (240px)", "Roomy (300px)"] },
			changes: [
				change(CHANGES[1], 1, "staged", { sessionId: SESSION_2, surfaceId: webApp.id, title: "Adjust layout" }),
			],
		});
		const createdTrack: SurfaceSession = session([], {
			id: "33333333-3333-4333-8333-333333333335",
			surfaceId: webApp.id,
			title: "Export CSV",
			prompt: "Add CSV export to orders",
			state: "queued",
			changes: [],
			openChangeCount: 0,
			messages: [sessionMessage(MESSAGE_IDS[2], "member", "Add CSV export to orders")],
		});

		let activeSessions: SurfaceSession[] = [trackA, trackB];
		const startSurfaceSession = vi.fn(async () => {
			activeSessions = [...activeSessions, createdTrack];
			return createdTrack;
		});
		const cancelSurfaceSessionTurn = vi.fn(async () => {
			trackA = { ...trackA, state: "ready", currentActivity: null };
			activeSessions = activeSessions.map((item) => (item.id === trackA.id ? trackA : item));
			return trackA;
		});
		const replySurfaceSession = vi.fn(async (id: string, text: string) => ({
			...(id === SESSION_2 ? trackB : trackA),
			state: "queued" as const,
			question: null,
			messages: [
				...(id === SESSION_2 ? trackB.messages : trackA.messages),
				sessionMessage(MESSAGE_IDS[3], "member", text),
			],
		}));

		const client = fakeClient({
			listSurfaces: vi.fn(async () => [webApp]),
			getSurfaceWorkspace: vi.fn(async () => workspace(activeSessions, { surface: webApp })),
			startSurfaceSession,
			cancelSurfaceSessionTurn,
			replySurfaceSession,
		});
		const store = storeWith(client);
		await store.load();
		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "web-app");
		document.body.append(view.el);
		for (let i = 0; i < 3; i++) {
			await flush();
			view.update();
		}

		expect(view.el.textContent).toContain("Updating session middleware");
		expect(view.el.textContent).toContain("Add cookie check");
		expect(view.el.textContent).toContain("Checks passed");
		expect(view.el.querySelector<HTMLAnchorElement>(".workbench-pr-link")?.href).toBe(
			"https://github.com/qorpera/qorpera-base/pull/42",
		);
		expect(view.el.querySelectorAll('[data-act="stop-turn"]').length).toBe(1);
		expect(view.el.querySelector<HTMLTextAreaElement>(".workbench-composer-input")?.rows).toBe(1);

		view.el.querySelector<HTMLButtonElement>('[data-act="stop-turn"]')!.click();
		await flush();
		view.update();
		expect(cancelSurfaceSessionTurn).toHaveBeenCalledWith(SESSION);
		expect(view.el.querySelector('[data-act="stop-turn"]')).toBeNull();

		view.el.querySelector<HTMLButtonElement>(`[data-act="select-track"][data-session="${SESSION_2}"]`)!.click();
		view.update();
		expect(view.el.textContent).toContain("Which sidebar width?");
		view.el.querySelector<HTMLButtonElement>('[data-act="answer-option"][data-option="Compact (240px)"]')!.click();
		await flush();
		expect(replySurfaceSession).toHaveBeenCalledWith(SESSION_2, "Compact (240px)");

		view.el.querySelector<HTMLButtonElement>('[data-act="new-track"]')!.click();
		view.update();
		expect(view.el.textContent).toContain("Start a new update track");
		const input = view.el.querySelector<HTMLTextAreaElement>(".workbench-composer-input")!;
		input.value = "Add CSV export to orders";
		input.dispatchEvent(new Event("input"));
		view.el
			.querySelector<HTMLFormElement>(".workbench-composer")!
			.dispatchEvent(new Event("submit", { cancelable: true }));
		await flush();
		expect(startSurfaceSession).toHaveBeenCalledWith(
			SURFACE,
			"Add CSV export to orders",
			expect.objectContaining({ previewBaseChangeIds: [] }),
		);
		expect(store.selectedTrackOf(SURFACE)).toBe(createdTrack.id);

		view.dispose();
		store.dispose();
	});

	it("lazy-loads mockups in a strict sandboxed iframe, renders markdown plans, previews isolated tracks, combines tracks, and ships tracks", async () => {
		const webApp = appSummary();
		const trackA = session(["staged"], {
			id: SESSION,
			surfaceId: webApp.id,
			title: "New sidebar",
			artifacts: [mockupArtifact(), planArtifact()],
		});
		const trackB = session(["staged"], {
			id: SESSION_2,
			surfaceId: webApp.id,
			title: "Dark tokens",
			changes: [
				change(CHANGES[1], 1, "staged", { sessionId: SESSION_2, surfaceId: webApp.id, title: "Dark palette" }),
			],
		});
		const isolatedPreview: SurfacePreviewCompositionState = {
			surfaceId: webApp.id,
			mode: "single",
			selectedSessionId: SESSION,
			previewScope: "track",
			primary: {
				previewId: PREVIEW_IDS[0],
				status: "ready",
				doorActionUrl: "https://stifteren-web-app--p0.qorpera.site/__qorpera_preview_door",
				memberPass: VALID_PASS,
				activeRoute: "/",
				toggledChangeIds: [CHANGES[0]],
				conflictReport: null,
				errorDetail: null,
			},
			compareFrames: [],
		};
		const combinedPreview: SurfacePreviewCompositionState = {
			surfaceId: webApp.id,
			mode: "single",
			selectedSessionId: null,
			previewScope: "explicit",
			primary: {
				previewId: PREVIEW_IDS[1],
				status: "ready",
				doorActionUrl: "https://stifteren-web-app--p1.qorpera.site/__qorpera_preview_door",
				memberPass: VALID_PASS,
				activeRoute: "/",
				toggledChangeIds: [CHANGES[0], CHANGES[1]],
				conflictReport: null,
				errorDetail: null,
			},
			compareFrames: [],
		};

		const getSurfaceSessionArtifact = vi.fn(async (id: string) =>
			id === ARTIFACT_MOCKUP
				? mockupArtifact({
						contentText:
							'<!doctype html><html><head><link rel="preconnect" href="https://evil.example"><style>h1{color:#111}</style></head><body><h1>Mockup Hero</h1><noscript>nope</noscript></body></html>',
					})
				: planArtifact({ contentText: "## Rollout\n\n- Step one\n- Step two" }),
		);
		const selectSurfaceTrackPreview = vi.fn(async (_surfaceId: string, opts?: { activeRoute?: string }) => ({
			...isolatedPreview,
			primary: { ...isolatedPreview.primary, activeRoute: opts?.activeRoute ?? "/" },
		}));
		const combineSurfaceTracks = vi.fn(
			async (
				_surfaceId: string,
				sessionIds: readonly string[],
				land = false,
			): Promise<SurfaceCombineTracksResult> =>
				land
					? {
							mode: "land",
							sessionIds,
							changeIds: [CHANGES[0], CHANGES[1]],
							jobId: "77777777-7777-4777-8777-777777777779",
						}
					: { mode: "preview", sessionIds, previewState: combinedPreview },
		);
		const shipSurfaceTrack = vi.fn(async () => ({
			...trackA,
			state: "completed" as const,
			changes: trackA.changes.map((c) => ({ ...c, status: "merging" as const })),
			openChangeCount: 0,
		}));

		const hosting = fakeSiteHosting({ entry: { isPublic: true, domains: [] } });
		const client = fakeClient({
			listSurfaces: vi.fn(async () => [webApp]),
			getSurfaceWorkspace: vi.fn(async () => workspace([trackA, trackB], { surface: webApp })),
			getSurfaceSessionArtifact,
			selectSurfaceTrackPreview,
			combineSurfaceTracks,
			shipSurfaceTrack,
		});
		const store = storeWith(client);
		await store.load();

		const view = new SurfaceView(
			{
				store,
				mount: () => undefined,
				openMigration: () => undefined,
				isSiteLive: () => true,
				siteHosting: () => ({ siteId: HOSTED_SITE, client: hosting.client }),
				managesSites: () => true,
			},
			"web-app",
		);
		document.body.append(view.el);
		for (let i = 0; i < 3; i++) {
			await flush();
			view.update();
		}

		view.el
			.querySelector<HTMLButtonElement>(`[data-act="open-artifact"][data-artifact="${ARTIFACT_MOCKUP}"]`)!
			.click();
		await flush();
		view.update();
		expect(getSurfaceSessionArtifact).toHaveBeenCalledWith(ARTIFACT_MOCKUP, expect.any(AbortSignal));
		const mockupFrame = view.el.querySelector<HTMLIFrameElement>(".workbench-artifact-iframe")!;
		expect(mockupFrame).not.toBeNull();
		expect(mockupFrame.getAttribute("sandbox")).toBe("allow-scripts");
		expect(mockupFrame.getAttribute("referrerpolicy")).toBe("no-referrer");
		expect(mockupFrame.getAttribute("src")).toBe(PAGE_FRAME_URL);
		const postMessage = vi.fn();
		const fakeWin = { postMessage } as unknown as Window;
		Object.defineProperty(mockupFrame, "contentWindow", { configurable: true, value: fakeWin });
		mockupFrame.dispatchEvent(new Event("load"));
		const readyEvent = new MessageEvent("message", { data: { type: PAGE_READY } });
		Object.defineProperty(readyEvent, "source", { value: fakeWin });
		window.dispatchEvent(readyEvent);
		expect(postMessage).toHaveBeenCalledTimes(1);
		const handed = postMessage.mock.calls[0]?.[0] as { type: string; html: string };
		expect(handed.type).toBe(PAGE_CONTENT);
		expect(handed.html).toContain("Mockup Hero");
		expect(handed.html).toContain("h1{color:#111}");
		expect(handed.html).not.toContain("preconnect");
		expect(handed.html).not.toContain("noscript");

		view.el
			.querySelector<HTMLButtonElement>(`[data-act="expand-artifact"][data-artifact="${ARTIFACT_MOCKUP}"]`)!
			.click();
		const expandedDialog = document.body.querySelector<HTMLDialogElement>("dialog.page-preview-dialog");
		expect(expandedDialog).not.toBeNull();
		expect(expandedDialog?.querySelector<HTMLIFrameElement>(".page-preview-frame")?.getAttribute("src")).toBe(
			PAGE_FRAME_URL,
		);
		expandedDialog?.querySelector<HTMLButtonElement>(".surface-close")?.click();
		expect(document.body.querySelector("dialog.page-preview-dialog")).toBeNull();

		view.el.querySelector<HTMLButtonElement>(`[data-act="open-artifact"][data-artifact="${ARTIFACT_PLAN}"]`)!.click();
		await flush();
		view.update();
		expect(getSurfaceSessionArtifact).toHaveBeenCalledWith(ARTIFACT_PLAN, expect.any(AbortSignal));
		expect(view.el.querySelector(".workbench-artifact-markdown")?.textContent).toContain("Step one");

		view.el.querySelector<HTMLButtonElement>(`[data-act="preview-track"][data-session="${SESSION}"]`)!.click();
		await flush();
		view.update();
		expect(selectSurfaceTrackPreview).toHaveBeenCalledWith(SURFACE, { sessionId: SESSION, activeRoute: "/" });
		expect(view.el.querySelector(".workbench-preview-scope")?.textContent).toBe("Isolated track preview");

		const routeInput = view.el.querySelector<HTMLInputElement>(".workbench-route-input")!;
		routeInput.value = "/settings";
		routeInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await flush();
		expect(selectSurfaceTrackPreview).toHaveBeenLastCalledWith(SURFACE, {
			sessionId: SESSION,
			activeRoute: "/settings",
		});

		view.el.querySelector<HTMLButtonElement>('[data-act="toggle-combine"]')!.click();
		view.update();
		view.el.querySelector<HTMLButtonElement>(`[data-act="toggle-combine-item"][data-session="${SESSION}"]`)!.click();
		view.el
			.querySelector<HTMLButtonElement>(`[data-act="toggle-combine-item"][data-session="${SESSION_2}"]`)!
			.click();
		view.update();
		view.el.querySelector<HTMLButtonElement>('[data-act="combine-preview"]')!.click();
		await flush();
		view.update();
		expect(combineSurfaceTracks).toHaveBeenCalledWith(SURFACE, [SESSION, SESSION_2], false);
		expect(view.el.querySelector(".workbench-preview-scope")?.textContent).toBe("Combined preview (2 tracks)");

		view.el.querySelector<HTMLButtonElement>('[data-act="combine-land"]')!.click();
		view.update();
		expect(combineSurfaceTracks).toHaveBeenCalledTimes(1);
		view.el.querySelector<HTMLButtonElement>('[data-act="combine-land"]')!.click();
		await flush();
		expect(combineSurfaceTracks).toHaveBeenCalledWith(SURFACE, [SESSION, SESSION_2], true);

		const shipPublishBtn = () => view.el.querySelector<HTMLButtonElement>('[data-act="ship-publish-track"]')!;
		shipPublishBtn().click();
		view.update();
		expect(shipSurfaceTrack).not.toHaveBeenCalled();
		shipPublishBtn().click();
		await flush();
		expect(shipSurfaceTrack).toHaveBeenCalledWith(SESSION, true);

		view.el.querySelector<HTMLButtonElement>('[data-act="full-preview"]')!.click();
		view.update();
		expect(view.el.classList.contains("is-workbench")).toBe(false);
		const backBtn = view.el.querySelector<HTMLButtonElement>('[data-act="back-to-workbench"]')!;
		expect(backBtn.hidden).toBe(false);
		backBtn.click();
		view.update();
		expect(view.el.classList.contains("is-workbench")).toBe(true);

		view.dispose();
		store.dispose();
	});

	it("stops automatic artifact retries on failure, re-points preview on track switch, and keeps parked workbench inactive in full preview", async () => {
		const webApp = appSummary();
		const trackA = session(["staged"], {
			id: SESSION,
			surfaceId: webApp.id,
			title: "Track A",
			artifacts: [mockupArtifact()],
		});
		const trackB = session([], {
			id: SESSION_2,
			surfaceId: webApp.id,
			title: "Track B",
			changes: [],
			openChangeCount: 0,
		});
		const previewFor = (sessionId: string | null): SurfacePreviewCompositionState => ({
			surfaceId: webApp.id,
			mode: "single",
			selectedSessionId: sessionId,
			previewScope: "track",
			primary: {
				previewId: sessionId === SESSION ? PREVIEW_IDS[0] : PREVIEW_IDS[1],
				status: sessionId === SESSION ? "ready" : "live_baseline",
				doorActionUrl:
					sessionId === SESSION ? "https://stifteren-web-app--p0.qorpera.site/__qorpera_preview_door" : null,
				memberPass: sessionId === SESSION ? VALID_PASS : null,
				activeRoute: "/",
				toggledChangeIds: sessionId === SESSION ? [CHANGES[0]] : [],
				conflictReport: null,
				errorDetail: null,
			},
			compareFrames: [],
		});
		let currentPreview = previewFor(SESSION);
		const getSurfaceSessionArtifact = vi.fn(async () => {
			throw new Error("Artifact offline");
		});
		const selectSurfaceTrackPreview = vi.fn(async (_surfaceId: string, opts?: { sessionId?: string | null }) => {
			currentPreview = previewFor(opts?.sessionId ?? null);
			return currentPreview;
		});
		const client = fakeClient({
			listSurfaces: vi.fn(async () => [webApp]),
			getSurfaceWorkspace: vi.fn(async () =>
				workspace([trackA, trackB], { surface: webApp, previewState: currentPreview }),
			),
			getSurfaceSessionArtifact,
			selectSurfaceTrackPreview,
		});
		const store = storeWith(client);
		await store.load();
		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "web-app");
		document.body.append(view.el);
		const unsub = store.store.subscribe(() => view.update());
		for (let i = 0; i < 3; i++) {
			await flush();
			view.update();
		}

		expect(view.el.querySelector(".workbench-preview-scope")?.textContent).toBe("Isolated track preview");

		view.el.querySelector<HTMLButtonElement>('[data-act="full-preview"]')!.click();
		view.update();
		view.park();
		view.activate();
		await flush();
		view.update();
		expect(view.el.querySelector<HTMLElement>(".workbench")?.hidden).toBe(true);
		expect(view.el.querySelector(".workbench iframe.surface-frame")).toBeNull();
		view.el.querySelector<HTMLButtonElement>('[data-act="back-to-workbench"]')!.click();
		view.update();
		expect(view.el.querySelector<HTMLElement>(".workbench")?.hidden).toBe(false);

		view.el.querySelector<HTMLButtonElement>(`[data-act="select-track"][data-session="${SESSION_2}"]`)!.click();
		view.update();
		expect(view.el.querySelector(".workbench-preview-scope")?.textContent).toBe("Live baseline");
		expect(view.el.querySelector(".workbench iframe.surface-frame")).toBeNull();
		await flush();
		expect(selectSurfaceTrackPreview).toHaveBeenCalledWith(SURFACE, { sessionId: SESSION_2, activeRoute: "/" });

		view.el.querySelector<HTMLButtonElement>(`[data-act="select-track"][data-session="${SESSION}"]`)!.click();
		await flush();
		view.update();
		expect(selectSurfaceTrackPreview).toHaveBeenLastCalledWith(SURFACE, { sessionId: SESSION, activeRoute: "/" });

		view.el.querySelector<HTMLButtonElement>('[data-act="new-track"]')!.click();
		await flush();
		expect(selectSurfaceTrackPreview).toHaveBeenLastCalledWith(SURFACE, { sessionId: null, activeRoute: "/" });

		view.el.querySelector<HTMLButtonElement>(`[data-act="select-track"][data-session="${SESSION}"]`)!.click();
		await flush();
		view.update();
		view.el
			.querySelector<HTMLButtonElement>(`[data-act="open-artifact"][data-artifact="${ARTIFACT_MOCKUP}"]`)!
			.click();
		await flush();
		view.update();
		await flush();
		view.update();
		store.clearError();
		await flush();
		view.update();
		expect(getSurfaceSessionArtifact).toHaveBeenCalledTimes(1);
		const retryBtn = view.el.querySelector<HTMLButtonElement>('[data-act="retry-artifact"]')!;
		expect(retryBtn).not.toBeNull();
		retryBtn.click();
		await flush();
		expect(getSurfaceSessionArtifact).toHaveBeenCalledTimes(2);

		unsub();
		view.dispose();
		store.dispose();
	});

	it("auto-syncs isolated track preview when new changes are staged and falls back from stale explicit combine on reopen", async () => {
		const webApp = appSummary();
		const trackA = session(["staged"], { id: SESSION, surfaceId: webApp.id, title: "Track A" });
		let trackB: SurfaceSession = session([], {
			id: SESSION_2,
			surfaceId: webApp.id,
			title: "Track B",
			changes: [],
			openChangeCount: 0,
		});
		let currentPreview: SurfacePreviewCompositionState = {
			surfaceId: webApp.id,
			mode: "single",
			selectedSessionId: null,
			previewScope: "explicit",
			primary: {
				previewId: PREVIEW_IDS[1],
				status: "ready",
				doorActionUrl: "https://stifteren-web-app--p1.qorpera.site/__qorpera_preview_door",
				memberPass: VALID_PASS,
				activeRoute: "/",
				toggledChangeIds: [CHANGES[0], CHANGES[1]],
				conflictReport: null,
				errorDetail: null,
			},
			compareFrames: [],
		};
		const selectSurfaceTrackPreview = vi.fn(
			async (_surfaceId: string, opts?: { sessionId?: string | null; activeRoute?: string }) => {
				const sid = opts?.sessionId ?? null;
				const toggled = sid === SESSION ? [CHANGES[0]] : sid === SESSION_2 ? trackB.changes.map((c) => c.id) : [];
				currentPreview = {
					surfaceId: webApp.id,
					mode: "single",
					selectedSessionId: sid,
					previewScope: "track",
					primary: {
						previewId: toggled.length > 0 ? PREVIEW_IDS[0] : null,
						status: toggled.length > 0 ? "ready" : "live_baseline",
						doorActionUrl:
							toggled.length > 0 ? "https://stifteren-web-app--p0.qorpera.site/__qorpera_preview_door" : null,
						memberPass: toggled.length > 0 ? VALID_PASS : null,
						activeRoute: opts?.activeRoute ?? "/",
						toggledChangeIds: toggled,
						conflictReport: null,
						errorDetail: null,
					},
					compareFrames: [],
				};
				return currentPreview;
			},
		);
		const client = fakeClient({
			listSurfaces: vi.fn(async () => [webApp]),
			getSurfaceWorkspace: vi.fn(async () =>
				workspace([trackA, trackB], { surface: webApp, previewState: currentPreview }),
			),
			selectSurfaceTrackPreview,
		});
		const store = storeWith(client);
		await store.load();
		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "web-app");
		document.body.append(view.el);
		const unsub = store.store.subscribe(() => view.update());
		for (let i = 0; i < 3; i++) {
			await flush();
			view.update();
		}

		expect(view.el.querySelector(".workbench-preview-scope")?.textContent).toBe("Live baseline");
		const routeInput = view.el.querySelector<HTMLInputElement>(".workbench-route-input")!;
		routeInput.value = "/orders";
		routeInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await flush();
		expect(selectSurfaceTrackPreview).toHaveBeenLastCalledWith(SURFACE, {
			sessionId: SESSION,
			activeRoute: "/orders",
		});

		currentPreview = {
			...currentPreview,
			selectedSessionId: null,
			previewScope: "explicit",
			primary: { ...currentPreview.primary, toggledChangeIds: [CHANGES[0], CHANGES[1]] },
		};
		await store.refreshWorkspace(SURFACE);
		view.update();
		view.el.querySelector<HTMLButtonElement>('[data-act="refresh-preview"]')!.click();
		await flush();
		expect(selectSurfaceTrackPreview).toHaveBeenLastCalledWith(SURFACE, {
			sessionId: SESSION,
			activeRoute: "/orders",
		});

		view.el.querySelector<HTMLButtonElement>(`[data-act="select-track"][data-session="${SESSION_2}"]`)!.click();
		await flush();
		view.update();
		expect(selectSurfaceTrackPreview).toHaveBeenLastCalledWith(SURFACE, {
			sessionId: SESSION_2,
			activeRoute: "/orders",
		});
		const callsBeforeStage = selectSurfaceTrackPreview.mock.calls.length;

		trackB = {
			...trackB,
			changes: [change(CHANGES[1], 1, "staged", { sessionId: SESSION_2, surfaceId: webApp.id, title: "Stage B1" })],
			openChangeCount: 1,
		};
		await store.refreshWorkspace(SURFACE);
		await flush();
		view.update();
		expect(selectSurfaceTrackPreview).toHaveBeenCalledTimes(callsBeforeStage + 1);
		expect(selectSurfaceTrackPreview).toHaveBeenLastCalledWith(SURFACE, {
			sessionId: SESSION_2,
			activeRoute: "/orders",
		});
		expect(view.el.querySelector(".workbench-preview-scope")?.textContent).toBe("Isolated track preview");

		unsub();
		view.dispose();
		store.dispose();
	});

	it("renders a single tab strip, toggles the tracks rail, opens code source from the repo chip, and auto-loads ready track previews", async () => {
		const webApp = appSummary();
		const trackA = session(["staged"], { id: SESSION, surfaceId: webApp.id, title: "3D Canvas Studio" });
		const trackB = session(["staged"], {
			id: SESSION_2,
			surfaceId: webApp.id,
			title: "Guided Vibe Flow",
			changes: [
				change(CHANGES[1], 1, "staged", { sessionId: SESSION_2, surfaceId: webApp.id, title: "Guided flow" }),
			],
		});
		let currentPreview: SurfacePreviewCompositionState = {
			surfaceId: webApp.id,
			mode: "single",
			selectedSessionId: null,
			previewScope: "track",
			primary: {
				previewId: null,
				status: "live_baseline",
				doorActionUrl: null,
				memberPass: null,
				activeRoute: "/",
				toggledChangeIds: [],
				conflictReport: null,
				errorDetail: null,
			},
			compareFrames: [],
		};
		const selectSurfaceTrackPreview = vi.fn(
			async (_surfaceId: string, opts?: { sessionId?: string | null; activeRoute?: string }) => {
				currentPreview = {
					surfaceId: webApp.id,
					mode: "single",
					selectedSessionId: opts?.sessionId ?? null,
					previewScope: "track",
					primary: {
						previewId: PREVIEW_IDS[0],
						status: "ready",
						doorActionUrl: "https://stifteren-web-app--p0.qorpera.site/__qorpera/member",
						memberPass: VALID_PASS,
						activeRoute: opts?.activeRoute ?? "/",
						toggledChangeIds: [CHANGES[0]],
						conflictReport: null,
						errorDetail: null,
					},
					compareFrames: [],
				};
				return currentPreview;
			},
		);
		const hosting = fakeSiteHosting({ entry: { isPublic: false, domains: [] } });
		const client = fakeClient({
			listSurfaces: vi.fn(async () => [webApp]),
			getSurfaceWorkspace: vi.fn(async () =>
				workspace([trackA, trackB], { surface: webApp, previewState: currentPreview }),
			),
			selectSurfaceTrackPreview,
			listCompanyCodeRepositories: vi.fn(async () => []),
		});
		const store = storeWith(client);
		await store.load();
		const view = new SurfaceView(
			{
				store,
				mount: () => undefined,
				openMigration: () => undefined,
				isSiteLive: () => false,
				siteHosting: () => ({ siteId: HOSTED_SITE, client: hosting.client }),
				managesSites: () => true,
			},
			"web-app",
		);
		document.body.append(view.el);
		const unsub = store.store.subscribe(() => view.update());
		for (let i = 0; i < 3; i++) {
			await flush();
			view.update();
		}

		expect(view.el.querySelector(".workbench-panel-head")).toBeNull();
		expect(view.el.querySelectorAll('.workbench-tab-group [data-act="panel-tab"]').length).toBe(4);
		expect(selectSurfaceTrackPreview).toHaveBeenCalledTimes(1);
		expect(selectSurfaceTrackPreview).toHaveBeenCalledWith(SURFACE, { sessionId: SESSION, activeRoute: "/" });
		expect(view.el.querySelector(".workbench-preview-scope")?.textContent).toBe("Isolated track preview");
		expect(view.el.querySelector(".workbench-bar-left > .surface-pill-address")).not.toBeNull();
		expect(view.el.querySelector('.workbench-inline-changes [data-act="approve-change"]')).toBeNull();

		currentPreview = {
			...currentPreview,
			selectedSessionId: SESSION_2,
			previewScope: "track",
			primary: {
				...currentPreview.primary,
				previewId: PREVIEW_IDS[1],
				toggledChangeIds: [CHANGES[1]],
			},
		};
		await store.refreshWorkspace(SURFACE);
		await flush();
		view.update();
		expect(selectSurfaceTrackPreview).toHaveBeenCalledTimes(1);
		expect(view.el.querySelector('.workbench-preview-empty [data-act="preview-track"]')).not.toBeNull();

		const tracksRail = view.el.querySelector<HTMLElement>(".workbench-tracks")!;
		expect(tracksRail.hidden).toBe(false);
		view.el.querySelector<HTMLButtonElement>('[data-act="toggle-tracks"]')!.click();
		view.update();
		expect(tracksRail.hidden).toBe(true);
		expect(view.el.querySelector(".workbench-tracks-toggle .workbench-count-badge")?.textContent).toBe("2");
		view.el.querySelector<HTMLButtonElement>('[data-act="toggle-tracks"]')!.click();
		view.update();
		expect(tracksRail.hidden).toBe(false);

		const body = view.el.querySelector<HTMLElement>(".workbench-body")!;
		const panel = view.el.querySelector<HTMLElement>(".workbench-panel")!;
		Object.defineProperty(body, "clientWidth", { configurable: true, value: 1000 });
		view.update();
		expect(Number.parseInt(panel.style.width, 10)).toBeLessThanOrEqual(1000 - 236 - 340);

		const resizer = view.el.querySelector<HTMLElement>(".workbench-panel-resizer")!;
		resizer.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 500, bubbles: true }));
		window.dispatchEvent(new MouseEvent("pointermove", { clientX: 580, bubbles: true }));
		window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
		expect(Number.parseInt(panel.style.width, 10)).toBe(344);
		resizer.dispatchEvent(new MouseEvent("pointerdown", { button: 0, clientX: 580, bubbles: true }));
		window.dispatchEvent(new MouseEvent("pointermove", { clientX: 530, bubbles: true }));
		window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
		expect(Number.parseInt(panel.style.width, 10)).toBe(394);

		Object.defineProperty(body, "clientWidth", { configurable: true, value: 680 });
		view.update();
		expect(tracksRail.hidden).toBe(true);
		expect(panel.hidden).toBe(false);

		body.style.flexDirection = "column";
		Object.defineProperty(body, "clientWidth", { configurable: true, value: 420 });
		view.update();
		expect(tracksRail.hidden).toBe(false);
		expect(panel.hidden).toBe(false);
		view.el.querySelector<HTMLButtonElement>('[data-act="toggle-tracks"]')!.click();
		view.update();
		expect(tracksRail.hidden).toBe(true);
		expect(panel.hidden).toBe(false);
		view.el.querySelector<HTMLButtonElement>('[data-act="toggle-tracks"]')!.click();
		view.update();
		expect(tracksRail.hidden).toBe(false);
		expect(panel.hidden).toBe(false);

		view.el.querySelector<HTMLButtonElement>('.workbench-repo-chip[data-act="open-source"]')!.click();
		await flush();
		expect(view.el.querySelector('.surface-address-page[data-page="source"]')).not.toBeNull();

		unsub();
		view.dispose();
		store.dispose();
	});
});
