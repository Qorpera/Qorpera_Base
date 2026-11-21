// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { inferSurfaceKind, opsComposerPlaceholder } from "../src/app/surface-kinds.ts";
import { recipientOf, renderLocalSitePreviewHtml } from "../src/app/surface-local-sandbox.ts";
import { activeTaskSessions, clearLocalSandboxCache, synthesizeSurfaces } from "../src/app/surfaces-store.ts";
import { CrewFigures, crewLook, sessionCrew } from "../src/app/views/surface-crew.ts";
import { openCreateSurfaceSheet, openScheduleAgentSheet } from "../src/app/views/surface-migration-sheet.ts";
import { SurfaceRail } from "../src/app/views/surface-rail.ts";
import { SurfaceView } from "../src/app/views/surface-view.ts";
import { RailLayout } from "../src/ui/rail-layout.ts";
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
			"report",
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

describe("unified agents, nested members, and Thetaband orchestration", () => {
	it("nests human member threads directly under the Members surface with teammate count", async () => {
		const store = storeWith(undefined, {
			companyName: "Brooks",
			localInteractive: true,
			synthesize: () => ({ companyId: COMPANY, sites: [], pages: ["mailbox", "members"] }),
		});
		await store.load();
		await store.openSurface("members");
		const rail = new SurfaceRail(store, COMPANY, new AbortController().signal);
		document.body.append(rail.el);
		const marie = document.createElement("a");
		marie.className = "rail-row";
		marie.dataset.memberId = "user-marie";
		marie.textContent = "Marie Malling";
		rail.update("members", false, { rows: [marie], unread: 0, active: false });

		const membersRow = rail.el.querySelector('.rail-surface[data-surface-slug="members"]')!;
		expect(membersRow.querySelector(".rail-surface-sub")?.textContent).toBe("1 teammate");
		const tree = membersRow.nextElementSibling!;
		expect(tree.querySelector('.rail-members [data-member-id="user-marie"]')).toBe(marie);
		expect(tree.querySelector(".surface-tree-empty")).toBeNull();
		expect(rail.el.querySelector('[aria-label="Building"]')).toBeNull();
		store.dispose();
	});

	it("creates and edits a prompt + schedule agent without HR persona charters", async () => {
		const store = storeWith(undefined, {
			companyName: "Brooks",
			localInteractive: true,
			synthesize: () => ({ companyId: COMPANY, sites: [], pages: ["mailbox"] }),
		});
		await store.load();
		const dialog = HTMLDialogElement.prototype;
		dialog.showModal ??= function (this: HTMLDialogElement) {
			this.open = true;
		};
		dialog.close ??= function (this: HTMLDialogElement) {
			this.open = false;
		};
		openScheduleAgentSheet(store);
		const sheet = document.querySelector(".surface-schedule-sheet")!;
		const [nameInput, scheduleInput] = sheet.querySelectorAll<HTMLInputElement>("input.surface-create-input");
		const promptInput = sheet.querySelector<HTMLTextAreaElement>("textarea.surface-create-prompt")!;
		nameInput!.value = "Morning inbox triage";
		promptInput.value = "Summarize urgent customer replies and draft follow-ups.";
		scheduleInput!.value = "Every day · 09:00";
		sheet.querySelector<HTMLFormElement>("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
		await flush();
		expect(store.state.automations).toHaveLength(1);
		const created = store.state.automations[0]!;
		expect(created.title).toBe("Morning inbox triage");
		expect(store.state.scheduledAgentPrompts[created.id]).toBe(
			"Summarize urgent customer replies and draft follow-ups.",
		);
		await store.updateScheduledAgent(created.id, { scheduleSummary: "Every Monday · 09:00" });
		expect(store.state.automations[0]?.scheduleSummary).toBe("Every Monday · 09:00");
		await store.deleteScheduledAgent(created.id);
		expect(store.state.automations).toHaveLength(0);
		store.dispose();
	});

	it("lets the left sidepanel close completely and reopen without disturbing stored width", () => {
		vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
		const aside = document.createElement("aside");
		aside.className = "rail";
		const frame = document.createElement("div");
		frame.className = "frame";
		frame.append(aside);
		document.body.append(frame);
		const layout = new RailLayout(frame, aside);
		expect(layout.hidden).toBe(false);
		expect(frame.classList.contains("rail-hidden-desktop")).toBe(false);
		layout.toggleHidden();
		expect(layout.hidden).toBe(true);
		expect(frame.classList.contains("rail-hidden-desktop")).toBe(true);
		expect(aside.inert).toBe(true);
		expect(layout.el.hidden).toBe(true);
		layout.toggleHidden();
		expect(layout.hidden).toBe(false);
		expect(frame.classList.contains("rail-hidden-desktop")).toBe(false);
		expect(aside.inert).toBe(false);
		expect(layout.el.hidden).toBe(false);
		layout.dispose();
		vi.unstubAllGlobals();
	});

	it("centralizes the spacious white pill header, defaults the Preview panel to all agents without side-by-side compare, and keeps focused toggles headline-only", async () => {
		const store = storeWith(undefined, {
			companyName: "Thetaband",
			localInteractive: true,
			synthesize: () => ({ companyId: COMPANY, sites: [], pages: ["mailbox", "bank", "members"] }),
		});
		await store.load();
		const productSlugs = store.state.surfaces
			.filter((surface) => surface.group === "products")
			.map((surface) => surface.slug);
		expect(productSlugs).toEqual(["website", "phone-app", "product", "financials"]);
		expect(activeTaskSessions(store.state)).toHaveLength(4);
		expect(store.state.automations.length).toBeGreaterThanOrEqual(2);

		const productSurface = store.state.surfaces.find((surface) => surface.slug === "product")!;
		expect(store.state.localStudioBase[productSurface.id]?.["product/specs.json"]).toContain("BrainBit");

		const website = store.state.surfaces.find((surface) => surface.slug === "website")!;
		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "website");
		document.body.append(view.el);
		await flush();
		view.update();

		expect(view.el.querySelector(".surface-bar-lead")).toBeNull();
		expect(view.el.querySelector(".surface-pill.is-spacious")).not.toBeNull();
		const modeLabels = [...view.el.querySelectorAll(".surface-pill-modes button")].map((btn) => btn.textContent);
		expect(modeLabels).toEqual(["Live", "Preview", "Notes"]);
		const headerAgent = view.el.querySelector<HTMLButtonElement>(".surface-pill .surface-bar-agent")!;
		expect(headerAgent.querySelector(".surface-crew .figure")).not.toBeNull();
		expect(headerAgent.querySelector(".surface-bar-agent-count")?.textContent).toBe("2");

		const stage = view.el.querySelector(".surface-stage")!;
		expect(stage.children[0]?.classList.contains("surface-canvas")).toBe(true);
		expect(stage.children[1]?.classList.contains("surface-drawer")).toBe(true);
		const drawer = view.el.querySelector<HTMLElement>(".surface-drawer")!;
		expect(drawer.classList.contains("is-open")).toBe(true);
		expect(drawer.classList.contains("is-overview")).toBe(true);
		expect(drawer.querySelector(".surface-overview-compare")).toBeNull();
		expect(drawer.querySelectorAll(".surface-overview-option")).toHaveLength(3);
		expect(drawer.querySelectorAll(".surface-overview-change .surface-switch")).toHaveLength(2);

		const localFrame = view.el.querySelector<HTMLIFrameElement>(".surface-mount iframe.surface-local-frame")!;
		expect(localFrame.srcdoc).toContain("Lyse flader");

		drawer.querySelectorAll<HTMLButtonElement>(".surface-overview-option")[1]!.click();
		await flush();
		view.update();
		const switchedFrame = view.el.querySelector<HTMLIFrameElement>(".surface-mount iframe.surface-local-frame")!;
		expect(switchedFrame).not.toBe(localFrame);
		expect(switchedFrame.srcdoc).toContain("Portræt og telefon");

		drawer.querySelector<HTMLButtonElement>('[data-act="choose-variant"]')!.click();
		await flush();
		view.update();
		expect(store.workspace(website.id)?.explorations[0]?.status).toBe("chosen");
		expect(store.state.surfaces.find((surface) => surface.id === website.id)?.unpublishedChangeCount).toBe(1);

		drawer.querySelector<HTMLButtonElement>('[data-act="focus-session"]')!.click();
		view.update();
		expect(drawer.classList.contains("is-overview")).toBe(false);
		expect(drawer.querySelector(".surface-message.is-session")).not.toBeNull();
		expect(drawer.querySelector<HTMLFormElement>(".surface-drawer-foot")?.hidden).toBe(false);
		const focusedCopy = drawer.querySelector(".surface-drawer-change-copy")!;
		expect(focusedCopy.querySelector("strong")?.textContent).toBe("Tydelig pris: 1.995 kr. inkl. fragt");
		expect(focusedCopy.querySelector("span")).toBeNull();
		expect(focusedCopy.querySelector("small")).toBeNull();

		drawer.querySelector<HTMLButtonElement>('[data-act="back-overview"]')!.click();
		view.update();
		expect(drawer.classList.contains("is-open")).toBe(true);
		expect(drawer.classList.contains("is-overview")).toBe(true);

		view.el.querySelector<HTMLButtonElement>('[data-act="toggle-panel"]')!.click();
		view.update();
		expect(drawer.classList.contains("is-open")).toBe(false);
		view.el.querySelector<HTMLButtonElement>('[data-act="toggle-panel"]')!.click();
		view.update();
		expect(drawer.classList.contains("is-open")).toBe(true);
		view.dispose();
		store.dispose();
	});

	it("renders Phone App in Preview with toggles and folded Design Notes essay", async () => {
		const store = storeWith(undefined, {
			companyName: "Thetaband",
			localInteractive: true,
			synthesize: () => ({ companyId: COMPANY, sites: [], pages: ["mailbox"] }),
		});
		await store.load();
		store.setDevice("mobile");
		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "phone-app");
		document.body.append(view.el);
		await flush();
		view.update();

		expect(view.el.querySelector<HTMLElement>(".surface-viewport")?.dataset.device).toBe("mobile");
		expect(view.el.querySelector(".surface-mount iframe.surface-local-frame")?.getAttribute("srcdoc")).toContain(
			"Thetaband",
		);

		view.el.querySelector<HTMLButtonElement>('[data-act="mode"][data-mode="report"]')!.click();
		view.update();
		expect(view.el.querySelector<HTMLElement>(".surface-report-slot")?.hidden).toBe(false);
		expect(view.el.querySelector(".report-headline")?.textContent).toBe(
			"Designing the Thetaband App for Quiet Evenings",
		);
		expect(view.el.querySelector(".report-line-svg")).not.toBeNull();
		expect(view.el.querySelector(".report-quote")).not.toBeNull();
		expect(view.el.querySelector(".report-figure-panels")).not.toBeNull();
		expect(view.el.querySelector<HTMLElement>(".surface-viewport")?.dataset.device).toBe("desktop");
		view.dispose();
		store.dispose();
	});

	it("organizes Product Studio with folded Vendor Analysis tab, charts, tables, and Public post lens", async () => {
		const store = storeWith(undefined, {
			companyName: "Thetaband",
			localInteractive: true,
			synthesize: () => ({ companyId: COMPANY, sites: [], pages: ["mailbox"] }),
		});
		await store.load();
		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "product");
		document.body.append(view.el);
		await flush();
		view.update();

		expect(view.el.querySelector(".studio-3d-canvas")).not.toBeNull();
		expect(view.el.querySelectorAll(".studio-vendor-card")).toHaveLength(0);
		expect(view.el.querySelector(".studio-diff-prev")?.textContent).toBe("Prototype v2 (BrainBit evaluering)");
		expect(view.el.querySelector(".studio-diff-next")?.textContent).toBe("Klar til Batch 1 (BrainBit låst)");

		const explodeBtn = view.el.querySelector<HTMLButtonElement>('[data-act="3d-explode"]')!;
		explodeBtn.click();
		expect(view.el.querySelector<HTMLElement>(".studio-3d-callouts")?.hidden).toBe(false);

		const tabs = [...view.el.querySelectorAll<HTMLButtonElement>(".studio-tab")];
		expect(tabs.map((tab) => tab.textContent)).toEqual([
			"Overview",
			"Specs & BOM",
			"Production & Vendors",
			"Analysis",
			"Brief & Files",
		]);

		tabs[2]!.click();
		expect(view.el.querySelectorAll(".studio-vendor-card")).toHaveLength(4);
		view.el.querySelector<HTMLButtonElement>('[data-act="studio-tab"][data-tab="analysis"]')!.click();
		expect(view.el.querySelector(".report-headline")?.textContent).toBe("Why BrainBit OEM for Batch 1");
		expect(view.el.querySelectorAll(".report-bar-row")).toHaveLength(3);
		expect(view.el.querySelector(".report-table")).not.toBeNull();
		expect(view.el.querySelector(".report-callout.is-decision")).not.toBeNull();

		view.el.querySelector<HTMLButtonElement>('[data-act="report-lens"][data-lens="public"]')!.click();
		expect(view.el.querySelector(".surface-report")?.classList.contains("is-public-lens")).toBe(true);
		expect(view.el.querySelector(".report-public-banner")?.textContent).toContain(
			"thetaband.dk/journal/batch-1-hardware",
		);
		expect(view.el.querySelector(".report-callout.is-decision")).toBeNull();

		view.el.querySelector<HTMLButtonElement>('[data-act="mode"][data-mode="live"]')!.click();
		view.update();
		expect(view.el.querySelector(".studio-diff-prev")).toBeNull();
		view.dispose();
		store.dispose();
	});
});
