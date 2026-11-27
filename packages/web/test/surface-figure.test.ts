// @vitest-environment jsdom
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SURFACE_KINDS, surfaceFigureOf, surfaceKindFigure } from "../src/app/surface-kinds.ts";
import { SurfaceRail } from "../src/app/views/surface-rail.ts";
import { SurfaceView } from "../src/app/views/surface-view.ts";
import { openMenu } from "../src/ui/context-menu.ts";
import { DANISH } from "../src/ui/danish/index.ts";
import {
	SURFACE_FIGURE_IDS,
	SURFACE_FIGURE_NAMES,
	surfaceFigure,
	surfaceFigureFromIcon,
	surfaceFigureIcon,
} from "../src/ui/surface-figure.ts";
import {
	COMPANY,
	fakeClient,
	folderContents,
	PREVIEW_IDS,
	previewFrame,
	SESSION,
	SURFACE,
	session,
	storeWith,
	summary,
	workspace,
} from "./surface-fixtures.ts";

describe("surface figures", () => {
	it("ships one picture per figure and nothing else", () => {
		const files = readdirSync(
			join(dirname(fileURLToPath(import.meta.url)), "../public/assets/surfaces/figures-v1"),
		).sort();
		expect(files).toEqual(SURFACE_FIGURE_IDS.map((id) => `${id}.png`).sort());
	});

	it("names every figure in English and Danish", () => {
		for (const id of SURFACE_FIGURE_IDS) expect(DANISH[SURFACE_FIGURE_NAMES[id]], id).toBeTruthy();
	});

	it("reads a chosen figure from the icon and ignores anything else", () => {
		expect(surfaceFigureIcon("piggy")).toBe("figure:piggy");
		expect(surfaceFigureFromIcon("figure:piggy")).toBe("piggy");
		expect(surfaceFigureFromIcon("figure:dragon")).toBeUndefined();
		expect(surfaceFigureFromIcon("mail")).toBeUndefined();
		expect(surfaceFigureFromIcon(null)).toBeUndefined();
	});

	it("gives every kind its own figure, and a chosen figure wins", () => {
		for (const kind of SURFACE_KINDS) expect(SURFACE_FIGURE_IDS).toContain(surfaceKindFigure(kind));
		expect(surfaceFigureOf({ icon: "globe" }, { kind: "website" })).toBe("browser");
		expect(surfaceFigureOf({ icon: "figure:jar" }, { kind: "website" })).toBe("jar");
		expect(surfaceFigureOf({ icon: "mail" }, { kind: "custom" })).toBe("envelope");
		expect(surfaceFigureOf({ icon: "rocket" }, { kind: "custom" })).toBe("gem");
		expect(surfaceFigureOf({ icon: "page" }, { kind: "money" })).toBe("money");
	});

	it("draws the picture with two eyes in rest and working states, with no ask symbol", () => {
		const resting = surfaceFigure("money");
		expect(resting.classList.contains("is-rest")).toBe(true);
		expect(resting.querySelector("img")?.getAttribute("src")).toMatch(/\/assets\/surfaces\/figures-v1\/money\.png$/);
		expect(resting.querySelectorAll(".surface-figure-eye")).toHaveLength(2);
		expect(resting.querySelector(".surface-figure-ask")).toBeNull();
		const working = surfaceFigure("money", "working");
		expect(working.classList.contains("is-working")).toBe(true);
		expect(working.querySelector(".surface-figure-ask")).toBeNull();
	});
});

function openFigures(rail: SurfaceRail): HTMLElement {
	rail.el
		.querySelector<HTMLElement>('.rail-surface[data-surface-slug="website"]')!
		.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
	[...document.querySelectorAll<HTMLElement>(".context-menu-item")]
		.find((item) => item.textContent?.includes("Figure"))!
		.click();
	return document.querySelector<HTMLElement>(".surface-figure-choices")!;
}

describe("a surface's figure in the rail", () => {
	afterEach(() => {
		document.body.replaceChildren();
		vi.useRealTimers();
	});

	it("rests or works without agent attention badges, keeping teammate publish-ask screen-reader words", async () => {
		const surfaces = [
			summary(),
			summary({ id: "s-busy", slug: "shop", title: "Shop", runningSessionCount: 2 }),
			summary({ id: "s-asks", slug: "mail", title: "Mail", runningSessionCount: 1, needsAttentionCount: 1 }),
			summary({
				id: "s-idle-asks",
				slug: "inbox",
				title: "Inbox",
				runningSessionCount: 0,
				needsAttentionCount: 0,
				publishAsk: {
					askedByUserId: "99999999-9999-4999-8999-999999999999",
					askedUserId: "11111111-1111-4111-8111-111111111111",
					askedAt: "2026-11-26T10:00:00Z",
					changeCount: 1,
					status: "open",
					answeredAt: null,
				},
			}),
		];
		const store = storeWith(fakeClient({ listSurfaces: vi.fn(async () => surfaces) }), {
			userId: "11111111-1111-4111-8111-111111111111",
		});
		await store.load();
		const rail = new SurfaceRail(store, COMPANY, new AbortController().signal);
		document.body.append(rail.el);
		rail.update("website");
		const row = (slug: string) => rail.el.querySelector<HTMLElement>(`.rail-surface[data-surface-slug="${slug}"]`)!;
		const state = (slug: string) => row(slug).querySelector(".surface-figure")?.className;
		const said = (slug: string) => row(slug).querySelector(".visually-hidden")?.textContent ?? null;

		expect(state("website")).toContain("is-rest");
		expect(said("website")).toBeNull();
		expect(state("shop")).toContain("is-working");
		expect(said("shop")).toBe("Working");
		expect(state("mail")).toContain("is-working");
		expect(state("mail")).not.toContain("is-attention");
		expect(row("mail").querySelector(".surface-figure-ask")).toBeNull();
		expect(said("mail")).toBe("Working");
		expect(state("inbox")).toContain("is-rest");
		expect(state("inbox")).not.toContain("is-attention");
		expect(row("inbox").querySelector(".surface-figure-ask")).toBeNull();
		expect(said("inbox")).toBe("Needs your attention");
		store.dispose();
	});

	it("opens the figures from a right-click on the rail and saves the one picked", async () => {
		const setSurfaceFigure = vi.fn(async (_id: string, figure: string) => summary({ icon: `figure:${figure}` }));
		const store = storeWith(fakeClient({ setSurfaceFigure }));
		await store.load();
		const rail = new SurfaceRail(store, COMPANY, new AbortController().signal);
		document.body.append(rail.el);
		rail.update("website");
		const row = rail.el.querySelector<HTMLElement>('.rail-surface[data-surface-slug="website"]')!;
		expect(row.querySelector(".surface-figure")?.getAttribute("data-figure")).toBe("browser");

		row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
		const panelRow = [...document.querySelectorAll<HTMLElement>(".context-menu-item")].find((item) =>
			item.textContent?.includes("Figure"),
		)!;
		panelRow.click();
		const choices = document.querySelector<HTMLElement>(".surface-figure-choices")!;
		expect(choices.querySelector('[aria-checked="true"]')?.getAttribute("data-figure")).toBe("browser");
		choices.querySelector<HTMLElement>('[data-figure="shop"]')!.click();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(setSurfaceFigure).toHaveBeenCalledWith(SURFACE, "shop");
		expect(store.state.surfaces[0]?.icon).toBe("figure:shop");
		rail.update("website");
		expect(rail.el.querySelector(".rail-surface .surface-figure")?.getAttribute("data-figure")).toBe("shop");
		store.dispose();
	});

	it("shows a hovered figure on the row at once and puts the saved one back when the pointer leaves", async () => {
		const setSurfaceFigure = vi.fn(async (_id: string, figure: string) => summary({ icon: `figure:${figure}` }));
		const store = storeWith(fakeClient({ setSurfaceFigure }));
		await store.load();
		const rail = new SurfaceRail(store, COMPANY, new AbortController().signal);
		document.body.append(rail.el);
		rail.update("website");
		const art = () =>
			rail.el.querySelector<HTMLElement>('.rail-surface[data-surface-slug="website"] .surface-figure')!;
		const choices = openFigures(rail);
		const hover = (figure: string) =>
			choices.querySelector(`[data-figure="${figure}"]`)!.dispatchEvent(new MouseEvent("pointerenter"));

		hover("shop");
		expect(art().dataset.figure).toBe("shop");
		expect(art().querySelector("img")?.getAttribute("loading")).toBe("eager");
		expect(art().querySelector("img")?.getAttribute("decoding")).toBe("sync");
		hover("jar");
		expect(art().dataset.figure).toBe("jar");
		rail.update("website");
		expect(art().dataset.figure).toBe("jar");
		choices.dispatchEvent(new MouseEvent("pointerleave"));
		expect(art().dataset.figure).toBe("browser");

		hover("shop");
		openMenu()?.close();
		expect(art().dataset.figure).toBe("browser");
		expect(setSurfaceFigure).not.toHaveBeenCalled();
		expect(store.state.surfaces[0]?.icon).toBe(summary().icon);
		store.dispose();
	});

	it("keeps a picked figure on the row while it saves and puts the old one back when the save fails", async () => {
		let fail!: (reason: Error) => void;
		const answer = new Promise<never>((_resolve, reject) => {
			fail = reject;
		});
		const setSurfaceFigure = vi.fn(() => answer);
		const store = storeWith(fakeClient({ setSurfaceFigure }));
		await store.load();
		const rail = new SurfaceRail(store, COMPANY, new AbortController().signal);
		document.body.append(rail.el);
		rail.update("website");
		const shown = () =>
			rail.el.querySelector<HTMLElement>('.rail-surface[data-surface-slug="website"] .surface-figure')?.dataset
				.figure;

		openFigures(rail).querySelector<HTMLElement>('[data-figure="shop"]')!.click();
		expect(openMenu()).toBeUndefined();
		expect(shown()).toBe("shop");
		rail.update("website");
		expect(shown()).toBe("shop");

		fail(new Error("offline"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(shown()).toBe("browser");
		store.dispose();
	});

	it("saves the last figure picked when a second pick lands while the first is saving", async () => {
		const answers: ((surface: ReturnType<typeof summary>) => void)[] = [];
		const setSurfaceFigure = vi.fn(
			(_id: string, _figure: string) =>
				new Promise<ReturnType<typeof summary>>((resolve) => {
					answers.push(resolve);
				}),
		);
		const store = storeWith(fakeClient({ setSurfaceFigure }));
		await store.load();
		const rail = new SurfaceRail(store, COMPANY, new AbortController().signal);
		document.body.append(rail.el);
		rail.update("website");
		const shown = () =>
			rail.el.querySelector<HTMLElement>('.rail-surface[data-surface-slug="website"] .surface-figure')?.dataset
				.figure;
		const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

		openFigures(rail).querySelector<HTMLElement>('[data-figure="shop"]')!.click();
		const again = openFigures(rail);
		expect(again.querySelector('[aria-checked="true"]')?.getAttribute("data-figure")).toBe("shop");
		again.querySelector<HTMLElement>('[data-figure="jar"]')!.click();
		expect(shown()).toBe("jar");
		expect(setSurfaceFigure).toHaveBeenCalledTimes(1);

		answers[0]!(summary({ icon: "figure:shop" }));
		await settle();
		rail.update("website");
		expect(shown()).toBe("jar");
		expect(setSurfaceFigure).toHaveBeenLastCalledWith(SURFACE, "jar");

		answers[1]!(summary({ icon: "figure:jar" }));
		await settle();
		rail.update("website");
		expect(shown()).toBe("jar");
		expect(store.state.surfaces[0]?.icon).toBe("figure:jar");
		expect(setSurfaceFigure).toHaveBeenCalledTimes(2);
		store.dispose();
	});

	it("turns Auto-publish on from the rail's right-click, where it stays reachable with the bar hidden", async () => {
		const setSurfaceAutoPublish = vi.fn(async (_id: string, enabled: boolean) => summary({ autoPublish: enabled }));
		const store = storeWith(fakeClient({ setSurfaceAutoPublish }));
		await store.load();
		const rail = new SurfaceRail(store, COMPANY, new AbortController().signal);
		document.body.append(rail.el);
		rail.update("website");
		const row = rail.el.querySelector<HTMLElement>('.rail-surface[data-surface-slug="website"]')!;

		row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
		const toggle = [...document.querySelectorAll<HTMLElement>(".context-menu-item")].find((item) =>
			item.textContent?.includes("Auto-publish on Approve"),
		)!;
		expect(toggle.getAttribute("aria-checked")).toBe("false");
		toggle.click();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(setSurfaceAutoPublish).toHaveBeenCalledWith(SURFACE, true);
		expect(store.state.surfaces[0]?.autoPublish).toBe(true);
		for (const node of document.body.querySelectorAll(".context-menu")) node.remove();
		store.dispose();
	});

	it("opens the same menu from a long press, under the row from the keyboard, and leaves Shift+right-click to the browser", async () => {
		const store = storeWith(fakeClient());
		await store.load();
		const rail = new SurfaceRail(store, COMPANY, new AbortController().signal);
		document.body.append(rail.el);
		rail.update("website");
		const row = rail.el.querySelector<HTMLElement>('.rail-surface[data-surface-slug="website"]')!;
		const menu = () => document.querySelector<HTMLElement>(".context-menu");

		row.dispatchEvent(
			new MouseEvent("contextmenu", { bubbles: true, cancelable: true, shiftKey: true, clientX: 30, clientY: 30 }),
		);
		expect(menu()).toBeNull();

		const keyboard = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
		row.dispatchEvent(keyboard);
		expect(keyboard.defaultPrevented).toBe(true);
		expect(menu()).not.toBeNull();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		for (const node of document.body.querySelectorAll(".context-menu")) node.remove();

		vi.useFakeTimers();
		try {
			row.dispatchEvent(
				new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch", clientX: 40, clientY: 40 }),
			);
			vi.advanceTimersByTime(600);
		} finally {
			vi.useRealTimers();
		}
		expect(menu()?.textContent).toContain("Figure");
		store.dispose();
	});

	it("shows an open surface's sessions as a row of small figures, six at most, with no list under it", async () => {
		const sessions = Array.from({ length: 8 }, (_, index) =>
			session([], {
				id: `44444444-4444-4444-8444-4444444444${String(index).padStart(2, "0")}`,
				title: `Session ${index}`,
				state: index === 0 ? "needs_input" : "ready",
			}),
		);
		const store = storeWith(fakeClient({ getSurfaceWorkspace: vi.fn(async () => workspace(sessions)) }));
		await store.load();
		await store.openSurface("website");
		const rail = new SurfaceRail(store, COMPANY, new AbortController().signal);
		document.body.append(rail.el);
		rail.update("website");
		const crew = rail.el.querySelector<HTMLElement>(".rail-surface.active .rail-surface-crew")!;

		expect(crew.getAttribute("aria-label")).toBe("8 sessions active");
		const figures = [...crew.querySelectorAll<HTMLElement>(".surface-crew.is-mini")];
		expect(figures).toHaveLength(6);
		expect(figures[0]?.title).toBe("Session 0");
		expect(figures[0]?.classList.contains("is-waiting")).toBe(true);
		expect(crew.querySelector(".rail-surface-crew-more")?.textContent).toBe("+2");
		expect(rail.el.querySelector(".surface-tree")).toBeNull();
		store.dispose();
	});

	it("renders no history row under an open surface even when it has past sessions", async () => {
		const past = session(["merged"], { state: "completed" });
		const store = storeWith(
			fakeClient({ getSurfaceWorkspace: vi.fn(async () => workspace([], { recentHistory: [past] })) }),
		);
		await store.load();
		await store.openSurface("website");
		const rail = new SurfaceRail(store, COMPANY, new AbortController().signal);
		document.body.append(rail.el);
		rail.update("website");

		expect(rail.el.querySelector(".surface-tree")).toBeNull();
		expect(rail.el.querySelector(".surface-history-toggle")).toBeNull();
		expect(rail.el.textContent).not.toContain("History");
		store.dispose();
	});

	it("keeps the agent row as the default subtitle whether the surface is open, left behind, or never visited", async () => {
		const mail = summary({ id: "s-mail", slug: "mail", title: "Mail", activeSessionCount: 0, liveUrl: null });
		const site = summary({ activeSessionCount: 1 });
		const mintPreviewPass = vi.fn();
		const setPreviewSelection = vi.fn();
		const loadCloudFiles = vi.fn(async () => folderContents({}));
		const getSurfaceWorkspace = vi.fn(async (id: string) =>
			id === site.id
				? workspace([session(["staged"])], {
						surface: site,
						previewState: {
							surfaceId: site.id,
							mode: "single",
							primary: previewFrame({ previewId: PREVIEW_IDS[0], doorActionUrl: null, memberPass: null }),
							compareFrames: [],
						},
					})
				: workspace([], { surface: mail }),
		);
		const store = storeWith(
			fakeClient({
				listSurfaces: vi.fn(async () => [site, mail]),
				getSurfaceWorkspace,
				mintPreviewPass,
				setPreviewSelection,
			}),
			{ loadCloudFiles },
		);
		await store.load();
		const rail = new SurfaceRail(store, COMPANY, new AbortController().signal);
		document.body.append(rail.el);
		rail.update(undefined);
		await Promise.resolve();
		await Promise.resolve();
		rail.update(undefined);

		const website = () => rail.el.querySelector<HTMLElement>('.rail-surface[data-surface-slug="website"]')!;
		expect(getSurfaceWorkspace).toHaveBeenCalledTimes(1);
		expect(getSurfaceWorkspace).toHaveBeenCalledWith(site.id, expect.any(AbortSignal));
		expect(mintPreviewPass).not.toHaveBeenCalled();
		expect(setPreviewSelection).not.toHaveBeenCalled();
		expect(loadCloudFiles).not.toHaveBeenCalled();
		expect(website().querySelector(".rail-surface-crew")).not.toBeNull();
		expect(website().querySelectorAll(".rail-surface-crew .surface-crew.is-mini")).toHaveLength(1);

		rail.update("mail");
		expect(website().querySelector(".rail-surface-crew")).not.toBeNull();

		rail.update("website");
		expect(website().querySelector(".rail-surface-crew")).not.toBeNull();
		store.dispose();
	});

	it("keeps a non-open surface's agent row fresh on realtime hints and falls back once sessions finish", async () => {
		vi.useFakeTimers();
		const mail = summary({ id: "s-mail", slug: "mail", title: "Mail", activeSessionCount: 0, liveUrl: null });
		let siteSummary = summary({ activeSessionCount: 1, runningSessionCount: 1 });
		let siteSessions = [session(["staged"], { state: "running" })];
		const getSurfaceWorkspace = vi.fn(async (id: string) =>
			id === SURFACE ? workspace(siteSessions, { surface: siteSummary }) : workspace([], { surface: mail }),
		);
		const store = storeWith(
			fakeClient({
				listSurfaces: vi.fn(async () => [siteSummary, mail]),
				getSurfaceWorkspace,
			}),
			{ realtimeLive: () => true },
		);
		await store.load();
		await store.openSurface("mail");
		const rail = new SurfaceRail(store, COMPANY, new AbortController().signal, undefined, undefined, () => "live");
		document.body.append(rail.el);
		rail.update("mail");
		await vi.advanceTimersByTimeAsync(0);
		rail.update("mail");

		const website = () => rail.el.querySelector<HTMLElement>('.rail-surface[data-surface-slug="website"]')!;
		expect(website().querySelector(".rail-surface-crew .surface-crew")?.classList.contains("is-working")).toBe(true);

		siteSummary = summary({ activeSessionCount: 1, runningSessionCount: 0, needsAttentionCount: 1 });
		siteSessions = [session(["staged"], { state: "needs_input" })];
		store.onRealtimeHint("surfaces");
		await vi.advanceTimersByTimeAsync(100);
		rail.update("mail");
		expect(website().querySelector(".rail-surface-crew .surface-crew")?.classList.contains("is-waiting")).toBe(true);
		expect(website().querySelector(".surface-figure")?.className).toContain("is-rest");

		siteSummary = summary({ activeSessionCount: 0, runningSessionCount: 0, needsAttentionCount: 0 });
		siteSessions = [];
		store.onRealtimeHint("surfaces");
		await vi.advanceTimersByTimeAsync(100);
		rail.update("mail");
		expect(website().querySelector(".rail-surface-crew")).toBeNull();
		expect(website().querySelector(".rail-surface-sub")?.textContent).toBe("Live · thetaband.dk");

		siteSummary = summary({ activeSessionCount: 1, runningSessionCount: 1, needsAttentionCount: 0 });
		siteSessions = [
			session(["staged"], {
				id: "44444444-4444-4444-8444-444444444499",
				state: "running",
			}),
		];
		store.onRealtimeHint("surfaces");
		await vi.advanceTimersByTimeAsync(100);
		rail.update("mail");
		expect(website().querySelector(".rail-surface-crew .surface-crew")?.classList.contains("is-working")).toBe(true);
		store.dispose();
	});

	it("fails quietly on background crew hydration and retries on the next realtime hint", async () => {
		vi.useFakeTimers();
		const site = summary({ activeSessionCount: 1 });
		const getSurfaceWorkspace = vi
			.fn()
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce(workspace([session(["staged"])], { surface: site }));
		const store = storeWith(
			fakeClient({
				listSurfaces: vi.fn(async () => [site]),
				getSurfaceWorkspace,
			}),
			{ realtimeLive: () => true },
		);
		await store.load();
		const rail = new SurfaceRail(store, COMPANY, new AbortController().signal);
		document.body.append(rail.el);
		rail.update(undefined);
		await vi.advanceTimersByTimeAsync(0);
		expect(store.state.error).toBeUndefined();
		expect(getSurfaceWorkspace).toHaveBeenCalledTimes(1);

		rail.update("other");
		await vi.advanceTimersByTimeAsync(0);
		expect(getSurfaceWorkspace).toHaveBeenCalledTimes(1);

		store.onRealtimeHint("surfaces");
		await vi.advanceTimersByTimeAsync(100);
		rail.update(undefined);
		await vi.advanceTimersByTimeAsync(0);
		rail.update(undefined);
		expect(getSurfaceWorkspace).toHaveBeenCalledTimes(2);
		expect(rail.el.querySelector('.rail-surface[data-surface-slug="website"] .rail-surface-crew')).not.toBeNull();
		store.dispose();
	});

	it("marks a session handed over from another surface until it is opened from the surface's agents", async () => {
		const store = storeWith(fakeClient({ getSurfaceWorkspace: vi.fn(async () => workspace([session([])])) }));
		await store.load();
		await store.openSurface("website");
		store.store.set({ highlight: { surfaceId: SURFACE, sessionId: SESSION } });
		const rail = new SurfaceRail(store, COMPANY, new AbortController().signal);
		document.body.append(rail.el);
		rail.update("website");
		expect(rail.el.querySelector(".rail-surface-crew .surface-crew")?.classList.contains("is-highlighted")).toBe(
			true,
		);

		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "website");
		document.body.append(view.el);
		view.update();
		expect(view.el.querySelector(".surface-bar .surface-crew")).toBeNull();
		view.el.querySelector<HTMLButtonElement>(`[data-act="focus-session"][data-session="${SESSION}"]`)!.click();
		expect(store.state.highlight).toBeUndefined();
		expect(store.state.drawer?.sessionId).toBe(SESSION);
		rail.update("website");
		expect(rail.el.querySelector(".rail-surface-crew .surface-crew")?.classList.contains("is-highlighted")).toBe(
			false,
		);

		store.closeDrawer();
		store.store.set({ highlight: { surfaceId: SURFACE, sessionId: SESSION } });
		store.openDrawer(SURFACE, SESSION);
		expect(store.state.highlight).toBeUndefined();
		store.dispose();
	});
});
