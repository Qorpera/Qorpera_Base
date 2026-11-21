// @vitest-environment jsdom
import {
	SURFACE_INSPECTOR_MODE_MESSAGE,
	SURFACE_INSPECTOR_PICK_MESSAGE,
	type SurfaceExplorationSet,
} from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SITE_DOOR_PASS, SITE_DOOR_READY, SITE_DOOR_SHOWN, SITE_DOOR_URL } from "../src/app/views/site-view.ts";
import { SurfaceRail } from "../src/app/views/surface-rail.ts";
import { SurfaceView } from "../src/app/views/surface-view.ts";
import { linkHref } from "../src/ui/dom.ts";
import { deferred } from "./fixtures.ts";
import {
	CHANGES,
	COMPANY,
	change,
	fakeClient,
	MESSAGE_IDS,
	PREVIEW_IDS,
	pointTarget,
	previewFrame,
	SESSION,
	SURFACE,
	session,
	sessionMessage,
	storeWith,
	summary,
	VALID_PASS,
	workspace,
} from "./surface-fixtures.ts";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function spyFrameMessages(iframe: HTMLIFrameElement): { message: Record<string, unknown>; origin: string }[] {
	const sent: { message: Record<string, unknown>; origin: string }[] = [];
	const win = iframe.contentWindow!;
	vi.spyOn(win, "postMessage").mockImplementation(((message: Record<string, unknown>, origin: string) => {
		sent.push({ message, origin });
	}) as never);
	return sent;
}

function sendFromFrame(iframe: HTMLIFrameElement, data: Record<string, unknown>, origin = location.origin): void {
	const event = new MessageEvent("message", { data, origin });
	Object.defineProperty(event, "source", { value: iframe.contentWindow });
	window.dispatchEvent(event);
}

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("the surface rail", () => {
	it("lists Building and Running and nests the active surface's sessions and changes under it", async () => {
		const client = fakeClient({
			listSurfaces: vi.fn(async () => [
				summary({ unpublishedChangeCount: 1 }),
				summary({
					id: "55555555-5555-4555-8555-555555555555",
					slug: "inbox",
					title: "Inbox",
					group: "operations",
					archetype: "ops",
					icon: "mail",
					siteSlug: null,
					activeSessionCount: 0,
				}),
			]),
		});
		const store = storeWith(client);
		await store.load();
		await store.openSurface("website");
		const rail = new SurfaceRail(store, COMPANY, new AbortController().signal);
		document.body.append(rail.el);
		rail.update("website", true);
		const titles = [...rail.el.querySelectorAll(".rail-surface-title > span")].map((node) => node.textContent);
		expect(titles).toEqual(["Building", "Running"]);
		const active = rail.el.querySelector<HTMLAnchorElement>(".rail-surface.active");
		expect(active ? linkHref(active) : null).toBe(`#/c/${COMPANY}/s/website`);
		expect(active?.querySelector(".interface-emblem")).not.toBeNull();
		const add = rail.el.querySelector(".rail-surface-add");
		expect(add ? linkHref(add) : null).toBe(`#/c/${COMPANY}/new-program`);
		const changes = [...rail.el.querySelectorAll(".surface-change .surface-change-title")].map(
			(node) => node.textContent,
		);
		expect(changes).toEqual(["Change 1", "Change 2", "Change 3"]);
		rail.el.querySelector<HTMLElement>(`.surface-switch[data-change="${CHANGES[1]}"]`)!.click();
		await flush();
		expect(store.isChangeShown(CHANGES[1])).toBe(false);
		rail.update("website", true);
		expect(rail.el.querySelector(`.surface-switch[data-change="${CHANGES[1]}"]`)?.getAttribute("aria-checked")).toBe(
			"false",
		);
		store.dispose();
	});

	it("renders proposed surfaces calmly with 1-click Approve and Dismiss actions", async () => {
		const proposedApp = summary({
			id: "55555555-5555-4555-8555-555555555511",
			slug: "meditation-app",
			title: "Meditation App",
			status: "proposed",
		});
		const proposedPress = summary({
			id: "55555555-5555-4555-8555-555555555512",
			slug: "press-kit",
			title: "Press Kit",
			status: "proposed",
		});
		const approveProposedSurface = vi.fn(async () => ({ ...proposedApp, status: "active" as const }));
		const archiveSurface = vi.fn(async () => ({ ...proposedPress, status: "archived" as const }));
		const store = storeWith(
			fakeClient({
				listSurfaces: vi.fn(async () => [summary(), proposedApp, proposedPress]),
				approveProposedSurface,
				archiveSurface,
			}),
		);
		await store.load();
		const rail = new SurfaceRail(store, COMPANY, new AbortController().signal);
		document.body.append(rail.el);
		rail.update("website");

		const proposedRows = [...rail.el.querySelectorAll(".rail-surface-proposed")];
		expect(proposedRows.map((row) => row.querySelector(".rail-surface-name")?.textContent)).toEqual([
			"Meditation App",
			"Press Kit",
		]);
		expect(proposedRows[0]?.querySelector(".rail-proposed-tag")?.textContent).toBe("Proposed");
		expect(rail.el.querySelectorAll("a.rail-surface")).toHaveLength(1);

		rail.el
			.querySelector<HTMLButtonElement>(`[data-act="approve-surface"][data-surface="${proposedApp.id}"]`)!
			.click();
		await flush();
		rail.update("website");
		expect(approveProposedSurface).toHaveBeenCalledWith(proposedApp.id);
		expect(rail.el.querySelectorAll("a.rail-surface")).toHaveLength(2);
		expect(rail.el.querySelectorAll(".rail-surface-proposed")).toHaveLength(1);

		rail.el
			.querySelector<HTMLButtonElement>(`[data-act="dismiss-surface"][data-surface="${proposedPress.id}"]`)!
			.click();
		await flush();
		rail.update("website");
		expect(archiveSurface).toHaveBeenCalledWith(proposedPress.id);
		expect(rail.el.querySelectorAll(".rail-surface-proposed")).toHaveLength(0);
		store.dispose();
	});
});

describe("the surface page", () => {
	it("draws a thin bar with Publish, mounts the real view, and holds a session merged with its drawer open", async () => {
		const client = fakeClient({
			listSurfaces: vi.fn(async () => [summary({ unpublishedChangeCount: 2 })]),
			getSurfaceWorkspace: vi.fn(async () => ({
				...workspace([session(["merged", "merged", "staged"])]),
				surface: summary({ unpublishedChangeCount: 2 }),
			})),
			approveSurfaceChange: vi.fn(async () => session(["merged", "merged", "merged"], { hasActiveChat: true })),
		});
		const store = storeWith(client);
		await store.load();
		const mounted = document.createElement("div");
		mounted.className = "real-site-view";
		const update = vi.fn();
		const view = new SurfaceView(
			{ store, mount: () => ({ el: mounted, update, dispose: () => undefined }), openMigration: () => undefined },
			"website",
		);
		document.body.append(view.el);
		await flush();
		view.update();
		expect(view.el.querySelector(".surface-title")?.textContent).toBe("Website");
		expect(view.el.querySelector(".surface-publish .surface-count")?.textContent).toBe("2");
		expect(view.el.querySelector(".surface-mount .real-site-view")).toBe(mounted);
		expect(update).toHaveBeenCalled();
		expect(view.el.querySelector<HTMLTextAreaElement>(".surface-input")?.disabled).toBe(false);

		store.openDrawer(SURFACE, SESSION);
		await flush();
		view.update();
		const drawer = view.el.querySelector(".surface-drawer")!;
		expect(drawer.classList.contains("is-open")).toBe(true);
		drawer.querySelector<HTMLElement>(`[data-act="approve"][data-change="${CHANGES[2]}"]`)!.click();
		await flush();
		await flush();
		view.update();
		expect(drawer.querySelector(".surface-done strong")?.textContent).toBe("All changes merged");
		expect(view.el.querySelector(".surface-toast")?.textContent).toContain("Change 3");
		drawer.querySelector<HTMLElement>(".surface-done [data-act='close']")!.click();
		await flush();
		view.update();
		expect(drawer.classList.contains("is-open")).toBe(false);
		expect(store.workspace(SURFACE)?.recentHistory.map((item) => item.id)).toEqual([SESSION]);
		view.dispose();
		store.dispose();
	});

	it("keeps the composer closed where Surfaces are not enabled yet", async () => {
		const store = storeWith(undefined);
		await store.load();
		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "thetaband");
		await flush();
		view.update();
		expect(view.el.querySelector<HTMLTextAreaElement>(".surface-input")?.disabled).toBe(true);
		expect(view.el.querySelector(".surface-banner")?.textContent).toContain("Fold 1 specialist agents and 1 boards");
		view.dispose();
		store.dispose();
	});

	it("mounts Preview through ./site-door/ and swaps double-buffered previews without flicker", async () => {
		const first = previewFrame({
			previewId: PREVIEW_IDS[0],
			doorActionUrl: "https://thetaband--p1111aaaa.qorpera.com/__qorpera/member",
			memberPass: VALID_PASS,
			activeRoute: "/pricing",
		});
		const second = previewFrame({
			previewId: PREVIEW_IDS[1],
			doorActionUrl: "https://thetaband--p2222bbbb.qorpera.com/__qorpera/member",
			memberPass: `${VALID_PASS.slice(0, 42)}Z`,
			activeRoute: "/pricing",
		});
		const baseWorkspace = workspace([session(["staged"])], {
			previewState: { surfaceId: SURFACE, mode: "single", primary: first, compareFrames: [] },
		});
		const client = fakeClient({ getSurfaceWorkspace: vi.fn(async () => baseWorkspace) });
		const store = storeWith(client);
		await store.load();
		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "website");
		document.body.append(view.el);
		await flush();
		view.update();

		const iframes = () => [...view.el.querySelectorAll<HTMLIFrameElement>("iframe.surface-frame")];
		expect(iframes()).toHaveLength(1);
		const firstFrame = iframes()[0]!;
		expect(firstFrame.getAttribute("src")).toBe(SITE_DOOR_URL);
		expect(firstFrame.getAttribute("sandbox")).toContain("allow-scripts");
		expect(firstFrame.classList.contains("is-staging")).toBe(true);
		const firstPosted = spyFrameMessages(firstFrame);
		sendFromFrame(firstFrame, { type: SITE_DOOR_READY });
		expect(firstPosted).toEqual([
			{
				message: {
					type: SITE_DOOR_PASS,
					action: first.doorActionUrl,
					pass: first.memberPass,
					title: "Preview of Website",
					path: "/pricing",
				},
				origin: location.origin,
			},
		]);
		sendFromFrame(firstFrame, { type: SITE_DOOR_SHOWN });
		expect(firstFrame.classList.contains("is-shown")).toBe(true);
		expect(firstFrame.classList.contains("is-staging")).toBe(false);

		store.store.set({
			workspaces: {
				[SURFACE]: {
					...baseWorkspace,
					previewState: {
						...baseWorkspace.previewState,
						primary: { ...first, status: "building", doorActionUrl: null, memberPass: null },
					},
				},
			},
		});
		view.update();
		expect(iframes()).toEqual([firstFrame]);
		expect(view.el.querySelector<HTMLElement>(".surface-preview-pill")?.hidden).toBe(false);

		store.store.set({
			workspaces: {
				[SURFACE]: {
					...baseWorkspace,
					previewState: { ...baseWorkspace.previewState, primary: second },
				},
			},
		});
		view.update();
		expect(iframes()).toHaveLength(2);
		expect(iframes()[0]).toBe(firstFrame);
		expect(firstFrame.classList.contains("is-shown")).toBe(true);
		const secondFrame = iframes()[1]!;
		expect(secondFrame.getAttribute("src")).toBe(SITE_DOOR_URL);
		expect(secondFrame.classList.contains("is-staging")).toBe(true);
		const secondPosted = spyFrameMessages(secondFrame);
		sendFromFrame(secondFrame, { type: SITE_DOOR_READY });
		expect(secondPosted[0]?.message).toMatchObject({
			type: SITE_DOOR_PASS,
			action: second.doorActionUrl,
			pass: second.memberPass,
			path: "/pricing",
		});
		expect(iframes()).toHaveLength(2);
		sendFromFrame(secondFrame, { type: SITE_DOOR_SHOWN });
		expect(iframes()).toEqual([secondFrame]);
		expect(secondFrame.classList.contains("is-shown")).toBe(true);
		expect(firstFrame.isConnected).toBe(false);
		view.dispose();
		store.dispose();
	});

	it("mounts Compare variants through independent ./site-door/ frames", async () => {
		const explorationId = "88888888-8888-4888-8888-888888888881";
		const secondSessionId = "33333333-3333-4333-8333-333333333334";
		const exploration: SurfaceExplorationSet = {
			id: explorationId,
			surfaceId: SURFACE,
			title: "Forsidens udtryk",
			status: "open",
			chosenSessionId: null,
			variantSessionIds: [SESSION, secondSessionId],
			createdAt: "2026-11-21T10:00:00.000Z",
			resolvedAt: null,
		};
		const variantA = session(["staged"], { id: SESSION, explorationId, explorationVariantLabel: "Aftenlys" });
		const variantB = session(["staged"], {
			id: secondSessionId,
			explorationId,
			explorationVariantLabel: "Varmt studie",
		});
		const frameA = previewFrame({
			previewId: PREVIEW_IDS[0],
			doorActionUrl: "https://thetaband--paaaa1111.qorpera.com/__qorpera/member",
		});
		const frameB = previewFrame({
			previewId: PREVIEW_IDS[1],
			doorActionUrl: "https://thetaband--pbbbb2222.qorpera.com/__qorpera/member",
		});
		const ws = workspace([variantA, variantB], {
			explorations: [exploration],
			previewState: {
				surfaceId: SURFACE,
				mode: "compare",
				primary: frameA,
				compareFrames: [
					{ sessionId: SESSION, label: "Aftenlys", frame: frameA },
					{ sessionId: secondSessionId, label: "Varmt studie", frame: frameB },
				],
			},
		});
		const store = storeWith(fakeClient({ getSurfaceWorkspace: vi.fn(async () => ws) }));
		await store.load();
		store.setMode("compare");
		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "website");
		document.body.append(view.el);
		await flush();
		view.update();

		const frames = [...view.el.querySelectorAll<HTMLIFrameElement>(".surface-compare-column iframe.surface-frame")];
		expect(frames).toHaveLength(2);
		expect(frames.map((item) => item.getAttribute("src"))).toEqual([SITE_DOOR_URL, SITE_DOOR_URL]);
		const postedA = spyFrameMessages(frames[0]!);
		const postedB = spyFrameMessages(frames[1]!);
		sendFromFrame(frames[0]!, { type: SITE_DOOR_READY });
		sendFromFrame(frames[1]!, { type: SITE_DOOR_READY });
		expect(postedA[0]?.message.action).toBe(frameA.doorActionUrl);
		expect(postedB[0]?.message.action).toBe(frameB.doorActionUrl);
		sendFromFrame(frames[0]!, { type: SITE_DOOR_SHOWN });
		sendFromFrame(frames[1]!, { type: SITE_DOOR_SHOWN });
		expect(frames.every((item) => item.classList.contains("is-shown"))).toBe(true);
		view.dispose();
		store.dispose();
	});

	it("supports Point-to-Change mode, validates picked targets, and starts a targeted session", async () => {
		const target = pointTarget();
		const ws = workspace([session(["staged"])], {
			previewState: { surfaceId: SURFACE, mode: "single", primary: previewFrame(), compareFrames: [] },
		});
		const startSurfaceSession = vi.fn(async () =>
			session(["staged"], {
				state: "running",
				originKind: "point_to_change",
				originLabel: "PreorderCta · /pricing",
			}),
		);
		const store = storeWith(fakeClient({ getSurfaceWorkspace: vi.fn(async () => ws), startSurfaceSession }));
		await store.load();
		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "website");
		document.body.append(view.el);
		await flush();
		view.update();

		const frame = view.el.querySelector<HTMLIFrameElement>("iframe.surface-frame")!;
		const posted = spyFrameMessages(frame);
		sendFromFrame(frame, { type: SITE_DOOR_READY });
		sendFromFrame(frame, { type: SITE_DOOR_SHOWN });
		posted.length = 0;

		const pointBtn = view.el.querySelector<HTMLButtonElement>(".surface-point")!;
		expect(pointBtn.hidden).toBe(false);
		expect(pointBtn.disabled).toBe(false);
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "p" }));
		expect(pointBtn.getAttribute("aria-pressed")).toBe("true");
		expect(posted.at(-1)).toEqual({
			message: { type: SURFACE_INSPECTOR_MODE_MESSAGE, active: true },
			origin: location.origin,
		});

		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		expect(pointBtn.getAttribute("aria-pressed")).toBe("false");
		expect(posted.at(-1)).toEqual({
			message: { type: SURFACE_INSPECTOR_MODE_MESSAGE, active: false },
			origin: location.origin,
		});

		pointBtn.click();
		expect(pointBtn.getAttribute("aria-pressed")).toBe("true");

		sendFromFrame(frame, { type: SURFACE_INSPECTOR_PICK_MESSAGE, target: { bad: true } });
		expect(view.el.querySelector(".surface-target-pill")).toBeNull();
		expect(pointBtn.getAttribute("aria-pressed")).toBe("true");

		sendFromFrame(frame, { type: SURFACE_INSPECTOR_PICK_MESSAGE, target });
		expect(pointBtn.getAttribute("aria-pressed")).toBe("false");
		expect(posted.at(-1)?.message).toEqual({ type: SURFACE_INSPECTOR_MODE_MESSAGE, active: false });
		const pill = view.el.querySelector(".surface-target-pill")!;
		expect(pill.textContent).toContain("PreorderCta");
		expect(pill.textContent).toContain("/pricing");
		expect(pill.textContent).toContain("Forudbestil");
		const input = view.el.querySelector<HTMLTextAreaElement>(".surface-input")!;
		expect(document.activeElement).toBe(input);

		input.value = "Gør knappen roligere";
		view.el
			.querySelector<HTMLFormElement>(".surface-composer")!
			.dispatchEvent(new Event("submit", { cancelable: true }));
		await flush();
		expect(startSurfaceSession).toHaveBeenCalledWith(SURFACE, "Gør knappen roligere", {
			target,
			originKind: "point_to_change",
			originLabel: "PreorderCta · /pricing",
		});
		expect(view.el.querySelector(".surface-target-pill")).toBeNull();
		view.dispose();
		store.dispose();
	});

	it("surfaces conflicts in the rail, drawer, and viewport with 1-click Reconcile", async () => {
		const conflictedSession = session(["conflicted", "staged"], {
			changes: [
				change(CHANGES[0], 1, "conflicted", { conflictPaths: ["src/hero.tsx", "src/theme.css"] }),
				change(CHANGES[1], 2, "staged"),
			],
		});
		const ws = workspace([conflictedSession], {
			previewState: {
				surfaceId: SURFACE,
				mode: "single",
				primary: {
					...previewFrame({ status: "conflicted", doorActionUrl: null, memberPass: null }),
					conflictReport: { changeIds: [CHANGES[0], CHANGES[1]], paths: ["src/hero.tsx"] },
				},
				compareFrames: [],
			},
		});
		const reconcileChanges = vi.fn(async () => session(["staged", "staged"], { state: "reconciling" }));
		const store = storeWith(fakeClient({ getSurfaceWorkspace: vi.fn(async () => ws), reconcileChanges }));
		await store.load();
		await store.openSurface("website");

		const rail = new SurfaceRail(store, COMPANY, new AbortController().signal);
		document.body.append(rail.el);
		rail.update("website");
		expect(rail.el.querySelector(".surface-change.is-conflicted .surface-change-paths")?.textContent).toBe(
			"src/hero.tsx, src/theme.css",
		);
		rail.el.querySelector<HTMLButtonElement>(`.surface-reconcile[data-change="${CHANGES[0]}"]`)!.click();
		await flush();
		expect(reconcileChanges).toHaveBeenNthCalledWith(1, SURFACE, [CHANGES[0]]);

		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "website");
		document.body.append(view.el);
		await flush();
		store.openDrawer(SURFACE, SESSION);
		view.update();
		expect(view.el.querySelector(".surface-banner.is-conflict")?.textContent).toContain("src/hero.tsx");
		view.el.querySelector<HTMLButtonElement>('.surface-banner.is-conflict [data-act="reconcile"]')!.click();
		await flush();
		expect(reconcileChanges).toHaveBeenNthCalledWith(2, SURFACE, [CHANGES[0], CHANGES[1]]);

		const drawer = view.el.querySelector(".surface-drawer")!;
		expect(drawer.querySelector(".surface-drawer-change.is-conflicted")?.textContent).toContain("src/hero.tsx");
		drawer.querySelector<HTMLButtonElement>(`[data-act="reconcile"][data-change="${CHANGES[0]}"]`)!.click();
		await flush();
		expect(reconcileChanges).toHaveBeenNthCalledWith(3, SURFACE, [CHANGES[0]]);
		view.dispose();
		store.dispose();
	});

	it("renders durable session.messages and reconciles optimistic replies in the drawer", async () => {
		const durable = [
			sessionMessage(MESSAGE_IDS[0], "member", "Gør heroen roligere"),
			sessionMessage(MESSAGE_IDS[1], "session", "Jeg strammer typografien og fjerner støj i hero-sektionen."),
			sessionMessage(MESSAGE_IDS[2], "system", "Change recorded: Skarpere hero-tekst", { changeId: CHANGES[0] }),
		];
		const replyDeferred = deferred<ReturnType<typeof session>>();
		const client = fakeClient({
			getSurfaceWorkspace: vi.fn(async () => workspace([session(["staged"], { messages: durable })])),
			replySurfaceSession: vi.fn(() => replyDeferred.promise),
		});
		const store = storeWith(client);
		await store.load();
		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "website");
		document.body.append(view.el);
		await flush();
		store.openDrawer(SURFACE, SESSION);
		view.update();

		const drawer = view.el.querySelector(".surface-drawer")!;
		const messages = () => [...drawer.querySelectorAll(".surface-message")];
		expect(messages().map((el) => [el.className, el.textContent])).toEqual([
			["surface-message is-member", "Gør heroen roligere"],
			["surface-message is-session", "Jeg strammer typografien og fjerner støj i hero-sektionen."],
			["surface-message is-system", expect.stringContaining("Change recorded: Skarpere hero-tekst")],
		]);
		expect(drawer.querySelector(".surface-message.is-system")?.getAttribute("data-change-id")).toBe(CHANGES[0]);

		const input = drawer.querySelector<HTMLInputElement>(".surface-drawer-input")!;
		input.value = "Gør prisen lidt tydeligere";
		drawer
			.querySelector<HTMLFormElement>(".surface-drawer-foot")!
			.dispatchEvent(new Event("submit", { cancelable: true }));
		view.update();
		expect(drawer.querySelectorAll(".surface-message.is-member.is-pending")).toHaveLength(1);
		expect(drawer.querySelector(".surface-message.is-pending")?.textContent).toBe("Gør prisen lidt tydeligere");

		replyDeferred.resolve(
			session(["staged"], {
				messages: [...durable, sessionMessage(MESSAGE_IDS[3], "member", "Gør prisen lidt tydeligere")],
			}),
		);
		await flush();
		await flush();
		view.update();
		expect(drawer.querySelectorAll(".surface-message.is-pending")).toHaveLength(0);
		expect(drawer.querySelectorAll(".surface-message.is-member").length).toBe(2);
		view.dispose();
		store.dispose();
	});

	it("hands off directly from Brand Studio and via inline prompt from Inbox to Website", async () => {
		const brand = summary({
			id: "22222222-2222-4222-8222-222222222229",
			slug: "brand",
			title: "Brand",
			archetype: "studio",
			folderRoot: "brand",
			siteSlug: null,
			liveUrl: null,
		});
		const inbox = summary({
			id: "22222222-2222-4222-8222-222222222230",
			slug: "inbox",
			title: "Inbox",
			group: "operations",
			archetype: "ops",
			icon: "mail",
			siteSlug: null,
			liveUrl: null,
		});
		const spawned = session([], {
			id: "33333333-3333-4333-8333-333333333388",
			surfaceId: SURFACE,
			state: "queued",
			originKind: "cross_surface",
			originLabel: "From Brand",
		});
		const spawnCrossSurfaceSession = vi.fn(async () => spawned);
		const navigated: string[] = [];
		const store = storeWith(
			fakeClient({
				listSurfaces: vi.fn(async () => [summary(), brand, inbox]),
				getSurfaceWorkspace: vi.fn(async (id: string) =>
					workspace([], { surface: id === brand.id ? brand : id === inbox.id ? inbox : summary() }),
				),
				spawnCrossSurfaceSession,
			}),
			{ onNavigateSurface: (slug) => navigated.push(slug) },
		);
		await store.load();

		const brandView = new SurfaceView(
			{
				store,
				mount: () => undefined,
				openMigration: () => undefined,
				loadStudioFiles: async () => ({ "brand/voice.md": "Warm Nordic minimalism.\n" }),
			},
			"brand",
		);
		document.body.append(brandView.el);
		await flush();
		brandView.update();
		expect(brandView.el.querySelector(".surface-studio")).not.toBeNull();
		const syncBarBtn = brandView.el.querySelector<HTMLButtonElement>(".surface-handoff-btn")!;
		expect(syncBarBtn.textContent).toContain("Sync to Website");
		syncBarBtn.click();
		await flush();
		expect(spawnCrossSurfaceSession).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				sourceSurfaceId: brand.id,
				targetSurfaceSlug: "website",
			}),
		);
		expect(navigated).toEqual(["website"]);
		brandView.dispose();

		const inboxView = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "inbox");
		document.body.append(inboxView.el);
		await flush();
		inboxView.update();
		const sendBarBtn = inboxView.el.querySelector<HTMLButtonElement>(".surface-handoff-btn")!;
		expect(sendBarBtn.textContent).toContain("Send to Website…");
		sendBarBtn.click();
		const form = inboxView.el.querySelector<HTMLFormElement>(".surface-handoff-bar")!;
		expect(form.hidden).toBe(false);
		const handoffInput = form.querySelector<HTMLInputElement>(".surface-handoff-input")!;
		handoffInput.value = "Fix Mette's Safari checkout bug";
		form.dispatchEvent(new Event("submit", { cancelable: true }));
		await flush();
		expect(spawnCrossSurfaceSession).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				sourceSurfaceId: inbox.id,
				targetSurfaceSlug: "website",
				prompt: "Fix Mette's Safari checkout bug",
			}),
		);
		expect(form.hidden).toBe(true);
		expect(navigated).toEqual(["website", "website"]);
		inboxView.dispose();
		store.dispose();
	});

	it("hides the composer on unavailable surfaces and omits an empty Building group", async () => {
		const store = storeWith(undefined, {
			synthesize: () => ({ companyId: COMPANY, sites: [], pages: [] }),
		});
		await store.load();
		const rail = new SurfaceRail(store, COMPANY, new AbortController().signal);
		document.body.append(rail.el);
		rail.update("missing", true);
		expect(rail.el.querySelector(".rail-surface-create")).toBeNull();
		expect(rail.el.querySelector('[aria-label="Building"]')).toBeNull();

		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "missing");
		document.body.append(view.el);
		await flush();
		view.update();
		expect(view.el.querySelector<HTMLElement>(".surface-composer")?.hidden).toBe(true);
		expect(view.el.querySelector<HTMLElement>(".surface-top-slot")?.hidden).toBe(true);
		expect(view.el.querySelector(".surface-empty")?.textContent).toContain("This surface isn't available.");
		view.dispose();
		store.dispose();
	});
});
