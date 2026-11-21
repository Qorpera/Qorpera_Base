// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { inferSurfaceKind, opsComposerPlaceholder } from "../src/app/surface-kinds.ts";
import { recipientOf, renderLocalSitePreviewHtml } from "../src/app/surface-local-sandbox.ts";
import { clearLocalSandboxCache, synthesizeSurfaces } from "../src/app/surfaces-store.ts";
import { CrewFigures, crewLook, sessionCrew } from "../src/app/views/surface-crew.ts";
import { openCreateSurfaceSheet } from "../src/app/views/surface-migration-sheet.ts";
import { SurfaceRail } from "../src/app/views/surface-rail.ts";
import { SurfaceView } from "../src/app/views/surface-view.ts";
import {
	COMPANY,
	change,
	fakeClient,
	SESSION,
	SURFACE,
	session,
	storeWith,
	summary,
	workspace,
} from "./surface-fixtures.ts";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
	clearLocalSandboxCache();
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const inbox = summary({
	id: "55555555-5555-4555-8555-555555555501",
	slug: "inbox",
	title: "Inbox",
	group: "operations",
	archetype: "ops",
	icon: "mail",
	siteSlug: null,
	liveUrl: null,
	activeSessionCount: 1,
});

describe("surface kinds", () => {
	it("tells every surface's kind from its slug, icon and archetype", () => {
		expect(inferSurfaceKind(inbox)).toBe("inbox");
		expect(inferSurfaceKind({ slug: "money", icon: "coin", archetype: "ops" })).toBe("money");
		expect(inferSurfaceKind({ slug: "members", icon: "members", archetype: "ops" })).toBe("members");
		expect(inferSurfaceKind({ slug: "data", icon: "database", archetype: "ops" })).toBe("data");
		expect(inferSurfaceKind({ slug: "files", icon: "drawers", archetype: "ops" })).toBe("files");
		expect(inferSurfaceKind({ slug: "thetaband", icon: "globe", archetype: "live_build" })).toBe("website");
		expect(inferSurfaceKind({ slug: "mobile", icon: "phone", archetype: "live_build" })).toBe("mobile_app");
		expect(inferSurfaceKind({ slug: "desktop", icon: "window", archetype: "live_build" })).toBe("desktop_app");
		expect(inferSurfaceKind({ slug: "dashboard", icon: "chart", archetype: "live_build" })).toBe("dashboard");
		expect(inferSurfaceKind({ slug: "brand", icon: "spark", archetype: "studio" })).toBe("brand");
		expect(inferSurfaceKind({ slug: "headband", icon: "box", archetype: "studio" })).toBe("product");
		expect(inferSurfaceKind({ slug: "database", icon: "database", archetype: "studio" })).toBe("database");
		expect(opsComposerPlaceholder("inbox")).toBe("Ask an agent to draft, follow up, or summarize mail…");
		expect(opsComposerPlaceholder("files")).toBe("Ask an agent to organize, summarize, or create files…");
	});

	it("brings Members and Databases into Running when the company has those pages", () => {
		const surfaces = synthesizeSurfaces({
			companyId: COMPANY,
			sites: [],
			pages: ["mailbox", "bank", "members", "data"],
		});
		expect(surfaces.map((item) => item.slug)).toEqual(["inbox", "money", "members", "data", "files"]);
		expect(surfaces.every((item) => item.group === "operations")).toBe(true);
	});
});

describe("session crew", () => {
	it("gives every session a stable staff figure, never the Co-Founder's crown, and maps its state to motion", () => {
		const ids = Array.from(
			{ length: 40 },
			(_, index) => `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
		);
		const figures = ids.map((id) => sessionCrew(id).figure);
		expect(figures).not.toContain("crown");
		expect(new Set(figures).size).toBeGreaterThan(4);
		expect(sessionCrew(ids[3]!)).toEqual(sessionCrew(ids[3]!));
		expect(crewLook(session([], { state: "running" }))).toMatchObject({ tone: "working", activity: "Working" });
		expect(crewLook(session([], { state: "needs_input" }))).toMatchObject({ activity: "Waiting", ask: "question" });
		expect(crewLook(session(["conflicted"]))).toMatchObject({ tone: "attention", ask: "bang" });
		expect(crewLook(session(["staged"]))).toMatchObject({ tone: "ready", activity: "Idle", alive: true });
		expect(crewLook(session(["merged"]))).toMatchObject({ tone: "merged" });
	});

	it("hands back the same figure element across redraws until the session's look changes", () => {
		const crew = new CrewFigures();
		const ready = session(["staged"]);
		const first = crew.take(ready, 32);
		crew.settle();
		expect(crew.take(ready, 32)).toBe(first);
		crew.settle();
		const working = crew.take({ ...ready, state: "running" }, 32);
		expect(working).not.toBe(first);
		expect(working.classList.contains("is-working")).toBe(true);
		expect(working.querySelector(".figure")).not.toBeNull();
	});
});

describe("operational surfaces", () => {
	it("drafts one email on Inbox in local preview, with no preview toggles or diffs", async () => {
		vi.useFakeTimers();
		const store = storeWith(undefined, {
			companyName: "Brooks",
			localInteractive: true,
			synthesize: () => ({ companyId: COMPANY, sites: [], pages: ["mailbox"] }),
		});
		await store.load();
		const local = store.state.surfaces.find((item) => item.slug === "inbox")!;
		await store.openSurface("inbox");
		const started = await store.startSession(
			local.id,
			"could we reach out to asger again, and ask him to elaborate?",
		);
		vi.advanceTimersByTime(700);
		const ready = store.session(started!.id)!;
		expect(ready.changes).toHaveLength(1);
		const draft = ready.changes[0]!;
		expect(draft.kind).toBe("ops_action");
		expect(draft.diffStats).toBeNull();
		expect(draft.affectedPaths).toEqual(["mailto:asger"]);
		expect(draft.title).toBe("Could you elaborate?");
		expect(draft.summary).toContain("Hi Asger,");
		expect(draft.summary).toContain("Brooks");
		expect(await store.approveChange(ready.id, draft.id)).toBe("history");
		expect(store.state.undo?.verb).toBe("sent");
		expect(store.state.surfaces.find((item) => item.id === local.id)?.unpublishedChangeCount).toBe(0);
		store.dispose();
	});

	it("finds who an email is for in plain words", () => {
		expect(recipientOf("could we reach out to asger again, and ask him to elaborate?")).toBe("Asger");
		expect(recipientOf("Reply to Mette about the Safari bug")).toBe("Mette");
		expect(recipientOf("ask him to elaborate")).toBeNull();
	});

	it("shows an ops session as an agent-owned task in the rail and an email card in the drawer", async () => {
		const actionSession = session([], {
			surfaceId: inbox.id,
			title: "could we reach out to asger again",
			changes: [
				change("44444444-4444-4444-8444-444444444491", 1, "staged", {
					surfaceId: inbox.id,
					kind: "ops_action",
					title: "Could you elaborate?",
					summary: "Hi Asger,\n\nCould you elaborate a little?",
					affectedPaths: ["mailto:asger"],
					diffStats: { filesChanged: 2, additions: 38, deletions: 12 },
				}),
			],
		});
		const approveSurfaceChange = vi.fn(async () =>
			session(["merged"], {
				...actionSession,
				changes: [{ ...actionSession.changes[0]!, status: "merged" }],
				state: "completed",
			}),
		);
		const store = storeWith(
			fakeClient({
				listSurfaces: vi.fn(async () => [summary(), inbox]),
				getSurfaceWorkspace: vi.fn(async () => workspace([actionSession], { surface: inbox })),
				approveSurfaceChange,
			}),
		);
		await store.load();
		await store.openSurface("inbox");

		const rail = new SurfaceRail(store, COMPANY, new AbortController().signal);
		document.body.append(rail.el);
		rail.update("inbox");
		const row = rail.el.querySelector(".surface-session")!;
		expect(row.classList.contains("is-action")).toBe(true);
		expect(row.querySelector(".surface-crew .figure")).not.toBeNull();
		expect(row.querySelector(".surface-crew")?.getAttribute("data-figure")).not.toBe("crown");
		expect(row.querySelector(".surface-session-status")?.textContent).toBe("Draft ready");
		expect(row.querySelector(".surface-switch")).toBeNull();
		expect(row.querySelector('.surface-approve.is-action[aria-label^="Send"]')).not.toBeNull();
		const tile = rail.el.querySelector<HTMLElement>('.rail-surface[data-surface-slug="inbox"] .surface-tile')!;
		expect(tile.style.getPropertyValue("--surface-tint")).toBe("#2f63d8");
		expect(rail.el.querySelector('.rail-surface[data-surface-slug="inbox"] .rail-surface-sub')?.textContent).toBe(
			"1 session active",
		);

		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "inbox");
		document.body.append(view.el);
		await flush();
		view.update();
		expect(view.el.querySelector<HTMLTextAreaElement>(".surface-input")?.placeholder).toBe(
			"Ask an agent to draft, follow up, or summarize mail…",
		);
		store.openDrawer(inbox.id, actionSession.id);
		view.update();
		const drawer = view.el.querySelector(".surface-drawer")!;
		expect(drawer.querySelector(".surface-drawer-head .surface-crew.is-large")).not.toBeNull();
		const card = drawer.querySelector(".surface-action-card.is-email")!;
		expect(card.querySelector(".surface-email-meta")?.textContent).toContain("Asger");
		expect(card.querySelector(".surface-email-meta")?.textContent).toContain("Could you elaborate?");
		expect(drawer.querySelector(".surface-switch")).toBeNull();
		expect(drawer.textContent).not.toContain("toggle to preview");
		expect(drawer.textContent).not.toContain("+38");
		card.querySelector<HTMLButtonElement>('[data-act="approve"]')!.click();
		await flush();
		await flush();
		view.update();
		expect(approveSurfaceChange).toHaveBeenCalledWith(actionSession.changes[0]!.id);
		expect(view.el.querySelector(".surface-toast")?.textContent).toContain("Sent “Could you elaborate?”");
		view.dispose();
		store.dispose();
	});

	it("keeps preview switches and diffs on visual surfaces", async () => {
		const store = storeWith(fakeClient());
		await store.load();
		await store.openSurface("website");
		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "website");
		document.body.append(view.el);
		await flush();
		store.openDrawer(SURFACE, SESSION);
		view.update();
		const drawer = view.el.querySelector(".surface-drawer")!;
		expect(drawer.querySelectorAll(".surface-switch")).toHaveLength(3);
		expect(drawer.querySelector(".surface-action-card")).toBeNull();
		expect(view.el.querySelector<HTMLTextAreaElement>(".surface-input")?.placeholder).toBe(
			"Describe a change — it runs as its own session",
		);
		view.dispose();
		store.dispose();
	});
});

describe("creating surfaces", () => {
	it("offers nine kinds, a custom surface with colour, icon and brief, and opens a Mobile App in the phone frame", async () => {
		const navigated: string[] = [];
		const store = storeWith(undefined, {
			companyName: "Brooks",
			localInteractive: true,
			onNavigateSurface: (slug) => navigated.push(slug),
		});
		await store.load();
		const dialog = HTMLDialogElement.prototype;
		dialog.showModal ??= function (this: HTMLDialogElement) {
			this.open = true;
		};
		dialog.close ??= function (this: HTMLDialogElement) {
			this.open = false;
		};
		openCreateSurfaceSheet(store, COMPANY);
		const sheet = document.querySelector(".surface-create-sheet")!;
		const presets = [...sheet.querySelectorAll<HTMLElement>(".surface-create-card")].map(
			(card) => card.dataset.preset,
		);
		expect(presets).toEqual([
			"website",
			"web_app",
			"mobile_app",
			"desktop_app",
			"database",
			"dashboard",
			"brand",
			"product",
			"custom",
		]);
		const custom = sheet.querySelector<HTMLElement>(".surface-create-custom")!;
		expect(custom.hidden).toBe(true);
		sheet.querySelector<HTMLElement>('[data-preset="custom"]')!.click();
		expect(custom.hidden).toBe(false);
		expect(custom.querySelectorAll(".surface-create-swatch").length).toBeGreaterThan(5);

		sheet.querySelector<HTMLElement>('[data-preset="mobile_app"]')!.click();
		expect(custom.hidden).toBe(true);
		expect(sheet.querySelector<HTMLInputElement>(".surface-create-input")?.value).toBe("Mobile App");
		sheet
			.querySelector<HTMLFormElement>(".surface-create-form")!
			.dispatchEvent(new Event("submit", { cancelable: true }));
		await flush();
		const mobile = store.state.surfaces.find((item) => item.slug === "mobile")!;
		expect(store.lookOf(mobile).kind).toBe("mobile_app");
		expect(store.state.device).toBe("mobile");
		expect(navigated).toEqual(["mobile"]);

		const investor = await store.createSurface({
			title: "Investor Room",
			archetype: "studio",
			icon: "book",
			kind: "custom",
			accent: "#e0559b",
			description: "Data room for the seed round.",
		});
		expect(store.lookOf(investor!)).toEqual({ kind: "custom", accent: "#e0559b" });
		expect(store.workspace(investor!.id)?.briefSummary).toBe("Data room for the seed round.");
		expect(store.state.localStudioBase[investor!.id]?.["investor-room/brief.md"]).toContain(
			"Data room for the seed round.",
		);
		const database = await store.createSurface({
			title: "Database",
			slug: "database",
			archetype: "studio",
			kind: "database",
		});
		expect(store.state.localStudioBase[database!.id]?.["database/tables.json"]).toContain("customers");
		store.dispose();
	});

	it("renders a tailored local preview for every buildable kind", () => {
		const surface = summary({ title: "Brooks" });
		expect(renderLocalSitePreviewHtml("Brooks", surface, [], "live", "mobile_app")).toContain(
			'data-component="TabBar"',
		);
		expect(renderLocalSitePreviewHtml("Brooks", surface, [], "live", "desktop_app")).toContain(
			'data-component="TitleBar"',
		);
		expect(renderLocalSitePreviewHtml("Brooks", surface, [], "live", "dashboard")).toContain(
			'data-component="KpiRow"',
		);
		expect(renderLocalSitePreviewHtml("Brooks", surface, [], "live", "web_app")).toContain(
			'data-component="AppSidebar"',
		);
		expect(renderLocalSitePreviewHtml("Brooks", surface, [], "live", "website", "A calm brief.")).toContain(
			"A calm brief.",
		);
	});
});
