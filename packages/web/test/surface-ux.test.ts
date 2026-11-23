// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthController } from "../src/app/auth.ts";
import { CompanyController } from "../src/app/company.ts";
import { inferSurfaceKind, opsComposerPlaceholder } from "../src/app/surface-kinds.ts";
import { recipientOf, renderLocalSitePreviewHtml } from "../src/app/surface-local-sandbox.ts";
import {
	activeTaskSessions,
	attachSurfaces,
	clearLocalSandboxCache,
	synthesizeSurfaces,
} from "../src/app/surfaces-store.ts";
import { HubController } from "../src/app/views/hub.ts";
import { renderNewCompany } from "../src/app/views/new-company.ts";
import { renderRail } from "../src/app/views/shell.ts";
import { SITE_DOOR_READY, SITE_DOOR_SHOWN } from "../src/app/views/site-view.ts";
import { CrewFigures, crewLook, sessionCrew } from "../src/app/views/surface-crew.ts";
import { IDENTITY_TOKENS_CSS_MESSAGE, SurfaceDoorStage } from "../src/app/views/surface-door.ts";
import { openCreateSurfaceSheet, openScheduleAgentSheet } from "../src/app/views/surface-migration-sheet.ts";
import { openPublishPatchnotesSheet } from "../src/app/views/surface-publish-sheet.ts";
import { SurfaceRail } from "../src/app/views/surface-rail.ts";
import { SurfaceView } from "../src/app/views/surface-view.ts";
import { linkHref } from "../src/ui/dom.ts";
import { RailLayout } from "../src/ui/rail-layout.ts";
import { fixture, id, profileA, staff, stubFigureMotion, userA } from "./fixtures.ts";
import {
	CHANGES,
	COMPANY,
	change,
	fakeClient,
	fakeSiteHosting,
	HOSTED_SITE,
	MESSAGE_IDS,
	previewFrame,
	SESSION,
	SURFACE,
	session,
	sessionMessage,
	siteDomain,
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
	vi.unstubAllGlobals();
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
		expect(inferSurfaceKind({ slug: "members", icon: "members", archetype: "ops" })).toBe("custom");
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

	it("brings Databases into Running when the company has that page, and never the retired Members page", () => {
		const surfaces = synthesizeSurfaces({
			companyId: COMPANY,
			sites: [],
			pages: ["mailbox", "bank", "members", "data"],
		});
		expect(surfaces.map((item) => item.slug)).toEqual(["inbox", "money", "data", "files"]);
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
		expect(rail.el.querySelector(".surface-tree")).toBeNull();
		const crew = rail.el.querySelector<HTMLElement>('.rail-surface[data-surface-slug="inbox"] .rail-surface-crew')!;
		expect(crew.getAttribute("aria-label")).toBe("1 session active");
		expect(crew.querySelectorAll(".surface-crew.is-mini .figure")).toHaveLength(1);
		expect(crew.querySelector(".surface-crew")?.getAttribute("data-figure")).not.toBe("crown");
		const tile = rail.el.querySelector<HTMLElement>('.rail-surface[data-surface-slug="inbox"] .surface-tile')!;
		expect(tile.style.getPropertyValue("--surface-tint")).toBe("#2f63d8");
		expect(tile.querySelector(".surface-figure")?.getAttribute("data-figure")).toBe("envelope");

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
		const confirmSend = drawer.querySelector<HTMLButtonElement>('.surface-action-card [data-act="approve"]')!;
		expect(confirmSend.classList.contains("is-confirming")).toBe(true);
		expect(confirmSend.textContent).toBe("Confirm");
		const sendGhost = confirmSend.querySelector(".surface-approve-face.is-ghost")!;
		expect(sendGhost.getAttribute("data-text")).toBe("Send");
		expect(sendGhost.querySelector(".icon")).not.toBeNull();
		expect(confirmSend.querySelector(".surface-approve-face:not(.is-ghost) .icon")).toBeNull();
		confirmSend.click();
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
	it("offers nine kinds, a figure for each, a custom surface with a brief, and opens a Mobile App in the phone frame", async () => {
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
		openCreateSurfaceSheet(store);
		const sheet = document.querySelector(".surface-create-sheet")!;
		const presets = [...sheet.querySelectorAll<HTMLElement>(".surface-create-kind")].map((row) => row.dataset.preset);
		expect(presets).toEqual([
			"custom",
			"identity",
			"website",
			"web_app",
			"mobile_app",
			"desktop_app",
			"database",
			"dashboard",
			"product",
			"report",
		]);
		const custom = sheet.querySelector<HTMLElement>(".surface-create-custom")!;
		expect(custom.hidden).toBe(false);
		expect(sheet.querySelector('[data-preset="custom"]')?.getAttribute("aria-pressed")).toBe("true");
		expect(sheet.querySelector<HTMLInputElement>(".surface-create-name")?.value).toBe("");
		expect(sheet.querySelector(".surface-sheet-link")).toBeNull();
		expect(sheet.querySelector(".surface-create-swatch")).toBeNull();
		const picked = () =>
			sheet.querySelector<HTMLElement>('.surface-figure-choice[aria-checked="true"]')?.dataset.figure;
		expect(sheet.querySelectorAll(".surface-figure-choice")).toHaveLength(26);
		expect(picked()).toBe("gem");
		const hero = () => sheet.querySelector<HTMLElement>(".surface-create-stage .surface-figure")?.dataset.figure;
		const line = () => sheet.querySelector(".surface-create-line")?.textContent;
		expect(hero()).toBe("gem");

		sheet.querySelector<HTMLElement>('[data-preset="mobile_app"]')!.click();
		expect(custom.hidden).toBe(true);
		expect(picked()).toBe("phone");
		expect(hero()).toBe("phone");
		expect(line()).toBe("iOS & Android app");
		expect(sheet.querySelector('[data-preset="mobile_app"]')?.getAttribute("aria-pressed")).toBe("true");
		const avatar = sheet.querySelector<HTMLButtonElement>(".surface-create-avatar")!;
		const figures = sheet.querySelector<HTMLElement>(".surface-create-figures")!;
		expect(sheet.querySelector(".surface-create-swap")).toBeNull();
		expect(figures.hidden).toBe(true);
		avatar.click();
		expect(figures.hidden).toBe(false);
		expect(avatar.getAttribute("aria-expanded")).toBe("true");
		sheet
			.querySelector<HTMLElement>('.surface-figure-choice[data-figure="jar"]')!
			.dispatchEvent(new MouseEvent("pointerenter"));
		expect(hero()).toBe("jar");
		expect(picked()).toBe("phone");
		sheet.querySelector<HTMLElement>(".surface-figure-choices")!.dispatchEvent(new MouseEvent("pointerleave"));
		expect(hero()).toBe("phone");
		sheet.querySelector<HTMLElement>('.surface-figure-choice[data-figure="piggy"]')!.click();
		expect(figures.hidden).toBe(true);
		expect(hero()).toBe("piggy");
		sheet.querySelector<HTMLElement>('[data-preset="website"]')!.click();
		expect(picked()).toBe("piggy");
		expect(hero()).toBe("piggy");
		sheet.querySelector<HTMLElement>('[data-preset="mobile_app"]')!.click();
		expect(sheet.querySelector<HTMLInputElement>(".surface-create-name")?.value).toBe("Mobile App");
		sheet
			.querySelector<HTMLFormElement>(".surface-create-form")!
			.dispatchEvent(new Event("submit", { cancelable: true }));
		await flush();
		const mobile = store.state.surfaces.find((item) => item.slug === "mobile")!;
		expect(store.lookOf(mobile).kind).toBe("mobile_app");
		expect(mobile.icon).toBe("figure:piggy");
		expect(store.state.device).toBe("mobile");
		expect(navigated).toEqual(["mobile"]);

		const investor = await store.createSurface({
			title: "Investor Room",
			archetype: "studio",
			icon: "book",
			kind: "custom",
			description: "Data room for the seed round.",
		});
		expect(store.lookOf(investor!)).toEqual({ kind: "custom" });
		expect(investor!.folderRoot).toBe("surfaces/investor-room");
		expect(store.workspace(investor!.id)?.briefSummary).toBe("Data room for the seed round.");
		expect(store.state.localStudioBase[investor!.id]?.["surfaces/investor-room/brief.md"]).toContain(
			"Data room for the seed round.",
		);
		const database = await store.createSurface({
			title: "Database",
			slug: "database",
			archetype: "studio",
			kind: "database",
		});
		expect(database!.folderRoot).toBe("surfaces/database");
		expect(store.state.localStudioBase[database!.id]?.["surfaces/database/tables.json"]).toContain("customers");

		openCreateSurfaceSheet(store);
		const productSheet = document.querySelector(".surface-create-sheet")!;
		productSheet.querySelector<HTMLElement>('[data-preset="product"]')!.click();
		const nameField = productSheet.querySelector<HTMLInputElement>(".surface-create-name")!;
		nameField.value = "Thetabands";
		nameField.dispatchEvent(new Event("input", { bubbles: true }));
		productSheet
			.querySelector<HTMLFormElement>(".surface-create-form")!
			.dispatchEvent(new Event("submit", { cancelable: true }));
		await flush();
		const thetabands = store.state.surfaces.find((item) => item.slug === "thetabands")!;
		expect(thetabands).toBeDefined();
		expect(thetabands.folderRoot).toBe("surfaces/thetabands");
		expect(store.lookOf(thetabands).kind).toBe("product");
		store.dispose();
	});

	it("moves the kind with the arrow keys and folds the figure picker without closing the window", async () => {
		const store = storeWith(undefined, { companyName: "Brooks", localInteractive: true });
		await store.load();
		const dialog = HTMLDialogElement.prototype;
		dialog.showModal ??= function (this: HTMLDialogElement) {
			this.open = true;
		};
		dialog.close ??= function (this: HTMLDialogElement) {
			this.open = false;
		};
		openCreateSurfaceSheet(store);
		const sheet = document.querySelector<HTMLDialogElement>(".surface-create-sheet")!;
		const row = (id: string) => sheet.querySelector<HTMLElement>(`[data-preset="${id}"]`)!;
		const press = (target: HTMLElement, key: string) =>
			target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

		row("report").focus();
		press(row("report"), "ArrowDown");
		expect(document.activeElement).toBe(row("custom"));
		expect(row("custom").getAttribute("aria-pressed")).toBe("true");
		expect(sheet.querySelector<HTMLElement>(".surface-create-custom")!.hidden).toBe(false);
		press(row("custom"), "ArrowRight");
		expect(document.activeElement).toBe(row("identity"));
		expect(row("identity").getAttribute("aria-pressed")).toBe("true");
		press(row("identity"), "ArrowLeft");
		expect(document.activeElement).toBe(row("custom"));

		const avatar = sheet.querySelector<HTMLButtonElement>(".surface-create-avatar")!;
		const figures = sheet.querySelector<HTMLElement>(".surface-create-figures")!;
		avatar.click();
		avatar.focus();
		press(avatar, "Escape");
		expect(figures.hidden).toBe(true);
		expect(sheet.open).toBe(true);
		expect(sheet.isConnected).toBe(true);

		avatar.click();
		expect(figures.hidden).toBe(false);
		const name = sheet.querySelector<HTMLElement>(".surface-create-name")!;
		name.dispatchEvent(new Event("pointerdown", { bubbles: true }));
		expect(figures.hidden).toBe(true);
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

describe("unified agents, the retired Members surface, and Thetaband orchestration", () => {
	it("leaves the retired Members surface out while the cloud still lists it", async () => {
		const members = summary({
			id: "55555555-5555-4555-8555-555555555509",
			slug: "members",
			title: "Members",
			group: "operations",
			archetype: "ops",
			kind: "members",
			icon: "members",
			siteSlug: null,
			liveUrl: null,
		});
		const store = storeWith(fakeClient({ listSurfaces: vi.fn(async () => [inbox, members]) }));
		await store.load();
		expect(store.state.surfaces.map((surface) => surface.slug)).toEqual(["inbox"]);
		const rail = new SurfaceRail(store, COMPANY, new AbortController().signal);
		rail.update(undefined);
		expect(rail.el.querySelector('[data-surface-slug="members"]')).toBeNull();
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

	it("centralizes the spacious white pill header with agent-owned explorations, Notes inside the owning agent, expandable drawer, and 2nd-row Approve/Change/Discard", async () => {
		const store = storeWith(undefined, {
			companyName: "Thetaband",
			localInteractive: true,
			synthesize: () => ({ companyId: COMPANY, sites: [], pages: ["mailbox", "bank", "members"] }),
		});
		await store.load();
		const productSlugs = store.state.surfaces
			.filter((surface) => surface.group === "products")
			.map((surface) => surface.slug);
		expect(productSlugs).toEqual(["identity", "website", "phone-app", "product", "financials"]);
		expect(activeTaskSessions(store.state)).toHaveLength(5);
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
		expect(modeLabels).toEqual(["Live", "Preview"]);
		expect(view.el.querySelector(".surface-pill-device")).not.toBeNull();
		expect(view.el.querySelector(".surface-pill-address")).toBeNull();

		const headerAgents = [...view.el.querySelectorAll<HTMLButtonElement>(".surface-pill .surface-bar-agent")];
		expect(headerAgents).toHaveLength(2);
		expect(headerAgents[0]?.querySelector(".surface-crew .figure")).not.toBeNull();
		expect(headerAgents[0]?.querySelector(".surface-bar-agent-count")?.textContent).toBe("3");
		expect(headerAgents[1]?.querySelector(".surface-crew .figure")).not.toBeNull();
		expect(headerAgents[1]?.querySelector(".surface-bar-agent-count")?.textContent).toBe("2");

		const stage = view.el.querySelector(".surface-stage")!;
		expect(stage.children[0]?.classList.contains("surface-canvas")).toBe(true);
		expect(stage.children[1]?.classList.contains("surface-drawer")).toBe(true);
		const drawer = view.el.querySelector<HTMLElement>(".surface-drawer")!;
		expect(drawer.classList.contains("is-open")).toBe(true);
		expect(drawer.classList.contains("is-overview")).toBe(true);
		expect(drawer.querySelector(".surface-drawer-resizer")).not.toBeNull();
		expect(drawer.querySelector(".surface-overview-compare")).toBeNull();

		const explorationCard = drawer.querySelector<HTMLElement>(".surface-overview-card.is-exploration")!;
		expect(explorationCard.querySelector(".surface-overview-agent-head .surface-crew .figure")).not.toBeNull();
		const ownedNote = explorationCard.querySelector<HTMLButtonElement>(".surface-agent-note")!;
		expect(ownedNote.textContent).toContain("How Thetaband Presents Itself at First Visit");
		const optionsBox = explorationCard.querySelector(".surface-overview-options")!;
		expect(ownedNote.compareDocumentPosition(optionsBox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

		ownedNote.click();
		view.update();
		expect(view.el.querySelector<HTMLElement>(".surface-report-slot")?.hidden).toBe(false);
		expect(view.el.querySelector(".report-headline")?.textContent).toBe(
			"How Thetaband Presents Itself at First Visit",
		);
		expect(drawer.classList.contains("is-open")).toBe(true);

		drawer.querySelectorAll<HTMLButtonElement>(".surface-overview-option")[1]!.click();
		await flush();
		view.update();
		expect(view.el.querySelector<HTMLElement>(".surface-report-slot")?.hidden).toBe(true);
		const switchedFrame = view.el.querySelector<HTMLIFrameElement>(".surface-mount iframe.surface-local-frame")!;
		expect(switchedFrame.srcdoc).toContain("Portræt og telefon");

		const ask = view.el.querySelector<HTMLTextAreaElement>(".surface-composer .surface-input")!;
		const foot = explorationCard.ownerDocument.querySelector(".surface-overview-card.is-exploration .is-options")!;
		expect([...foot.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
			"Use this one",
			"None of these",
		]);
		foot.querySelector<HTMLButtonElement>('[data-act="instead-of"]')!.click();
		view.update();
		expect(ask.placeholder).toBe("What should it be instead?");
		expect(document.activeElement).toBe(ask);
		ask.blur();
		view.update();
		expect(ask.placeholder).toBe("Describe a change — it runs as its own session");
		expect(store.workspace(website.id)?.explorations[0]?.status).toBe("open");

		drawer.querySelector<HTMLButtonElement>('[data-act="focus-exploration"]')!.click();
		view.update();
		expect(drawer.classList.contains("is-overview")).toBe(false);
		expect(drawer.querySelector(".surface-drawer-head h2")?.textContent).toBe("Forsidens udtryk");
		expect(drawer.querySelector(".surface-drawer-body > .surface-agent-note")).not.toBeNull();
		expect(drawer.querySelectorAll(".surface-drawer-option-row")).toHaveLength(3);

		const useVariant = drawer.querySelector<HTMLButtonElement>('[data-act="choose-variant"]')!;
		expect(useVariant.textContent).toBe("Use this one");
		const pickedId = useVariant.dataset.session!;
		const waiting = store.session(pickedId)!.changes.map((change) => change.status);
		useVariant.click();
		await flush();
		view.update();
		const chosen = store.workspace(website.id)!;
		expect(chosen.explorations[0]).toMatchObject({ status: "chosen", chosenSessionId: pickedId });
		expect(
			chosen.activeSessions.filter((session) => session.explorationId === chosen.explorations[0]!.id),
		).toHaveLength(1);
		expect(store.session(pickedId)!.changes.map((change) => change.status)).toEqual(waiting);
		expect(store.state.drawer).toEqual({ surfaceId: website.id, sessionId: pickedId });
		expect(store.state.undo).toBeUndefined();
		expect(drawer.querySelector('[data-act="choose-variant"]')).toBeNull();
		expect(store.state.surfaces.find((surface) => surface.id === website.id)?.unpublishedChangeCount).toBe(0);
		expect(drawer.classList.contains("is-overview")).toBe(false);
		expect(drawer.querySelectorAll(".surface-drawer-change:not(.is-option)").length).toBe(waiting.length);
		drawer.querySelector<HTMLButtonElement>('[data-act="back-overview"]')!.click();
		view.update();
		expect(drawer.classList.contains("is-overview")).toBe(true);
		expect(drawer.querySelector(".surface-overview-card.is-exploration")).toBeNull();
		const keptCard = drawer
			.querySelector(`.surface-overview-card.is-agent [data-session="${pickedId}"]`)!
			.closest(".surface-overview-card")!;
		expect(keptCard.querySelector(".surface-agent-note")?.textContent).toContain(
			"How Thetaband Presents Itself at First Visit",
		);
		expect(await store.approveAll(pickedId)).toBe(true);
		view.update();
		expect(store.state.surfaces.find((surface) => surface.id === website.id)?.unpublishedChangeCount).toBe(1);

		view.el.querySelector<HTMLButtonElement>('[data-act="collapse-pill"]')!.click();
		expect(view.el.querySelector(".surface-pill")).toBeNull();
		const notch = view.el.querySelector<HTMLButtonElement>(".surface-notch")!;
		expect(notch).not.toBeNull();
		notch.click();
		expect(view.el.querySelector(".surface-pill")).not.toBeNull();
		expect(view.el.querySelector(".surface-notch")).toBeNull();

		const dialog = HTMLDialogElement.prototype;
		dialog.showModal ??= function (this: HTMLDialogElement) {
			this.open = true;
		};
		dialog.close ??= function (this: HTMLDialogElement) {
			this.open = false;
		};

		[
			...drawer.querySelectorAll<HTMLElement>(
				".surface-overview-card.is-agent:not(.is-exploration) .surface-overview-change-title",
			),
		]
			.find((title) => title.textContent === "Tydelig pris: 1.995 kr. inkl. fragt")!
			.click();
		view.update();
		expect(drawer.classList.contains("is-overview")).toBe(false);
		expect(drawer.querySelector(".surface-message.is-session")).not.toBeNull();
		expect(drawer.querySelector<HTMLFormElement>(".surface-drawer-foot")?.hidden).toBe(false);
		const firstChange = drawer.querySelector<HTMLElement>(".surface-drawer-change")!;
		expect(firstChange.querySelector(".surface-drawer-change-title")?.textContent).toBe(
			"Tydelig pris: 1.995 kr. inkl. fragt",
		);
		const rowActions = [...firstChange.querySelectorAll<HTMLButtonElement>(".surface-drawer-change-acts button")].map(
			(btn) => btn.getAttribute("role") ?? btn.textContent,
		);
		expect(rowActions).toEqual(["switch", "Approve", "Change", "Discard"]);
		expect(drawer.querySelector(".surface-drawer-title p")).toBeNull();
		expect(drawer.textContent).not.toContain("toggle to preview");

		firstChange.querySelector<HTMLButtonElement>('[data-act="approve"]')!.click();
		const confirmFirst = drawer.querySelector<HTMLButtonElement>('.surface-drawer-change [data-act="approve"]')!;
		expect(confirmFirst.classList.contains("is-confirming")).toBe(true);
		confirmFirst.click();
		await flush();
		view.update();
		expect(store.state.surfaces.find((surface) => surface.id === website.id)?.unpublishedChangeCount).toBe(2);

		view.el.querySelector<HTMLButtonElement>('[data-act="publish"]')!.click();
		const patchSheet = document.querySelector(".surface-publish-sheet")!;
		expect(patchSheet).not.toBeNull();
		expect(patchSheet.querySelectorAll(".surface-patchnote-item")).toHaveLength(2);
		patchSheet.querySelector<HTMLButtonElement>('[data-act="rollback"]')!.click();
		await flush();
		expect(patchSheet.querySelectorAll(".surface-patchnote-item")).toHaveLength(1);
		patchSheet.querySelector<HTMLButtonElement>('[data-act="confirm-publish"]')!.click();
		await flush();
		expect(document.querySelector(".surface-publish-sheet")).toBeNull();
		expect(store.state.surfaces.find((surface) => surface.id === website.id)?.unpublishedChangeCount).toBe(0);

		const remainingChange = drawer.querySelector<HTMLElement>(".surface-drawer-change:not(.is-closed)")!;
		remainingChange.querySelector<HTMLButtonElement>('[data-act="quote-change"]')!.click();
		const replyStrip = drawer.querySelector<HTMLElement>(".surface-drawer-reply")!;
		expect(replyStrip.hidden).toBe(false);
		const drawerInput = drawer.querySelector<HTMLInputElement>(".surface-drawer-input")!;
		expect(document.activeElement).toBe(drawerInput);
		drawerInput.value = "Gør prisen endnu mere rolig";
		drawer
			.querySelector<HTMLFormElement>(".surface-drawer-foot")!
			.dispatchEvent(new Event("submit", { cancelable: true }));
		await flush();
		view.update();
		expect(replyStrip.hidden).toBe(true);
		expect(drawer.querySelector(".surface-message-ref")).not.toBeNull();

		drawer.querySelector<HTMLButtonElement>('[data-act="discard-change"]')!.click();
		await flush();
		view.update();
		expect(drawer.querySelectorAll(".surface-drawer-change")).toHaveLength(1);
		expect(drawer.querySelector('[data-act="toggle-expand"]')).toBeNull();

		drawer.querySelector<HTMLButtonElement>('[data-act="back-overview"]')!.click();
		view.update();
		expect(drawer.classList.contains("is-open")).toBe(true);
		expect(drawer.classList.contains("is-overview")).toBe(true);
		expect(drawer.querySelector(".surface-drawer-title h2")?.textContent).toBe("Changes");
		expect(drawer.querySelector(".surface-drawer-title p")).toBeNull();

		view.el.querySelector<HTMLButtonElement>('[data-act="toggle-panel"]')!.click();
		view.update();
		expect(drawer.classList.contains("is-open")).toBe(false);
		view.el.querySelector<HTMLButtonElement>('[data-act="toggle-panel"]')!.click();
		view.update();
		expect(drawer.classList.contains("is-open")).toBe(true);
		view.dispose();
		store.dispose();
	});

	it("drops a session's options when the member says what it should be instead", async () => {
		const store = storeWith(undefined, {
			companyName: "Thetaband",
			localInteractive: true,
			synthesize: () => ({ companyId: COMPANY, sites: [], pages: ["mailbox", "bank", "members"] }),
		});
		await store.load();
		const website = store.state.surfaces.find((surface) => surface.slug === "website")!;
		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "website");
		document.body.append(view.el);
		await flush();
		view.update();
		const options = store.workspace(website.id)!.explorations[0]!;
		expect(options.status).toBe("open");

		view.el.querySelector<HTMLButtonElement>('.surface-drawer [data-act="instead-of"]')!.click();
		view.update();
		const ask = view.el.querySelector<HTMLTextAreaElement>(".surface-composer .surface-input")!;
		expect(ask.placeholder).toBe("What should it be instead?");
		ask.value = "En rolig forside med ét stort billede";
		view.el
			.querySelector<HTMLFormElement>(".surface-composer")!
			.dispatchEvent(new Event("submit", { cancelable: true }));
		await flush();
		view.update();

		const after = store.workspace(website.id)!;
		expect(after.explorations.find((item) => item.id === options.id)?.status).toBe("discarded");
		expect(after.activeSessions.some((session) => options.variantSessionIds.includes(session.id))).toBe(false);
		expect(after.activeSessions.some((session) => session.prompt === "En rolig forside med ét stort billede")).toBe(
			true,
		);
		expect(store.state.insteadOf).toBeUndefined();
		expect(ask.placeholder).toBe("Describe a change — it runs as its own session");
		expect(view.el.querySelector(".surface-overview-card.is-exploration")).toBeNull();
		view.el.remove();
		store.dispose();
	});

	it("renders Phone App without a desktop/mobile toggle and opens Design Notes from the owning agent", async () => {
		const store = storeWith(undefined, {
			companyName: "Thetaband",
			localInteractive: true,
			synthesize: () => ({ companyId: COMPANY, sites: [], pages: ["mailbox"] }),
		});
		await store.load();
		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "phone-app");
		document.body.append(view.el);
		await flush();
		view.update();

		expect(view.el.querySelector(".surface-pill-device")).toBeNull();
		expect(view.el.querySelector<HTMLElement>(".surface-viewport")?.dataset.device).toBe("mobile");
		expect(view.el.querySelector(".surface-mount iframe.surface-local-frame")?.getAttribute("srcdoc")).toContain(
			"Thetaband",
		);

		const agentNote = view.el.querySelector<HTMLButtonElement>(".surface-drawer .surface-agent-note")!;
		expect(agentNote.textContent).toContain("Designing the Thetaband App for Quiet Evenings");
		agentNote.click();
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

	it("organizes Product Studio with folded Vendor Analysis tab, charts, tables, and no Internal/Public lens toggle", async () => {
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

		expect(view.el.querySelector(".studio-stage .studio-model")).not.toBeNull();
		expect(view.el.querySelector(".studio-3d-canvas")).toBeNull();
		expect(view.el.querySelector<HTMLElement>(".studio-model .studio-3d-view")?.hidden).toBe(true);
		expect(view.el.querySelectorAll(".studio-vendor-card")).toHaveLength(0);
		expect(view.el.querySelector(".studio-diff-prev")).toBeNull();
		expect(view.el.querySelector(".studio-fact.is-changed")).not.toBeNull();

		const tabLabels = () =>
			[...view.el.querySelectorAll<HTMLButtonElement>(".studio-tab")].map((tab) => tab.textContent);
		expect(tabLabels()).toEqual(["Overview", "Specs", "Vendors", "Reports", "Files"]);

		view.el.querySelector<HTMLButtonElement>('[data-act="studio-tab"][data-tab="specs"]')!.click();
		expect(view.el.querySelector(".studio-diff-prev")?.textContent).toBe("Prototype v2 (BrainBit evaluering)");
		expect(view.el.querySelector(".studio-diff-next")?.textContent).toBe("Klar til Batch 1 (BrainBit låst)");

		view.el.querySelector<HTMLButtonElement>('[data-act="studio-tab"][data-tab="vendors"]')!.click();
		expect(view.el.querySelectorAll(".studio-vendor-card")).toHaveLength(4);
		view.el.querySelector<HTMLButtonElement>('[data-act="studio-tab"][data-tab="analysis"]')!.click();
		expect(view.el.querySelector(".report-headline")?.textContent).toBe("Why BrainBit OEM for Batch 1");
		expect(view.el.querySelectorAll(".report-bar-row")).toHaveLength(3);
		expect(view.el.querySelector(".report-table")).not.toBeNull();
		expect(view.el.querySelector(".report-callout.is-decision")).not.toBeNull();
		expect(view.el.querySelector('[data-act="report-lens"]')).toBeNull();

		view.el.querySelector<HTMLButtonElement>('[data-act="mode"][data-mode="live"]')!.click();
		view.update();
		expect(view.el.querySelector(".studio-diff-prev")).toBeNull();
		view.dispose();
		store.dispose();
	});

	it("unifies sidebar Agents into Working, Scheduled, and Ready with no Move button, no Other agents drawer, and no duplicate agents", async () => {
		stubFigureMotion();
		vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
		const f = fixture();
		const cofounder = { ...staff, id: id(10), displayName: "Co-Founder", templateId: "co-founder" };
		const working = { ...staff, id: id(11), displayName: "Strategi", role: "Strategy" };
		const scheduled = { ...staff, id: id(12), displayName: "Marked", role: "Market research" };
		const idle = { ...staff, id: id(13), displayName: "Webdesign", role: "Site craft" };
		const company = new CompanyController(f.api, profileA, userA.id);
		company.store.set({
			loading: false,
			staff: [cofounder, working, scheduled, idle],
			activity: [
				{
					staffAgentId: working.id,
					runId: id(80),
					sourceKind: "session_turn",
					activity: "working",
					jobStatus: "leased",
					updatedAt: "2026-11-21T10:00:00Z",
				},
			],
			agentNotes: {
				[scheduled.id]: { next: { title: "Hold markedsoverblik", at: "2026-11-22T08:00:00Z" } },
			},
		});
		const store = storeWith(undefined, {
			companyName: "Thetaband",
			localInteractive: true,
			synthesize: () => ({ companyId: profileA.profileId, sites: [], pages: ["mailbox", "members"] }),
		});
		await store.load();
		attachSurfaces(company, store);

		const container = document.createElement("aside");
		const frame = document.createElement("div");
		frame.className = "frame";
		frame.append(container);
		document.body.append(frame);
		const auth = new AuthController(f.cloud);
		const draw = (section: "surface" | "staff", routeId: string) =>
			renderRail(container, company, {
				profiles: [profileA],
				user: userA,
				route: { name: "company", profileId: profileA.profileId, section, id: routeId },
				auth,
				invitations: 0,
				openSettings: () => {},
				openFeedback: () => {},
				openFriends: () => {},
				agentActions: {},
			});
		draw("surface", "website");

		const hub = container.querySelector<HTMLElement>(".rail-agents-hub");
		expect(hub).not.toBeNull();
		expect(hub?.querySelector(".rail-legacy-migrate")).toBeNull();
		expect(hub?.querySelector(".rail-agents-legacy")).toBeNull();
		expect(hub?.textContent).not.toContain("Other agents");

		const subheads = [...hub!.querySelectorAll<HTMLElement>(".rail-agents-subhead")].map((el) => el.textContent);
		expect(subheads).toEqual(["Working", "Scheduled", "Ready"]);

		const staffHrefs = [...hub!.querySelectorAll<HTMLAnchorElement>("a.rail-agent-hub-row")]
			.map((a) => linkHref(a))
			.filter((href): href is string => Boolean(href?.includes("/staff/")));
		expect(staffHrefs).toEqual([
			`#/c/${profileA.profileId}/staff/${working.id}`,
			`#/c/${profileA.profileId}/staff/${scheduled.id}`,
			`#/c/${profileA.profileId}/staff/${idle.id}`,
		]);
		expect(new Set(staffHrefs).size).toBe(3);
		expect(hub?.querySelector("[data-hub-exploration]")).not.toBeNull();

		const toggle = hub!.querySelector<HTMLButtonElement>("button.rail-agents-head")!;
		const body = hub!.querySelector<HTMLElement>(".rail-agents-body")!;
		const count = hub!.querySelector<HTMLElement>(".rail-agents-count")!;
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(body.hasAttribute("inert")).toBe(true);
		expect(count.hidden).toBe(false);
		const rows = hub!.querySelectorAll(".rail-agent-hub-row").length;
		expect(Number(count.textContent)).toBe(rows);
		expect(hub!.querySelector(".rail-agents-head .rail-hidden-unread")).toBeNull();
		expect(toggle.getAttribute("aria-label")).toBe(`Agents: ${rows}`);
		toggle.click();
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(body.hasAttribute("inert")).toBe(false);
		expect(count.hidden).toBe(true);
		expect(localStorage.getItem("qorpera.web.rail-agents-open")).toBe("1");
		expect(toggle.getAttribute("aria-label")).toBe("Agents");
		toggle.click();
		expect(body.hasAttribute("inert")).toBe(true);

		draw("staff", idle.id);
		expect(body.hasAttribute("inert")).toBe(false);
		expect(hub!.querySelector(`a[data-agent-id="${idle.id}"]`)?.classList.contains("active")).toBe(true);
		expect(localStorage.getItem("qorpera.web.rail-agents-open")).toBe("0");
		toggle.click();
		expect(body.hasAttribute("inert")).toBe(true);
		draw("staff", idle.id);
		expect(body.hasAttribute("inert")).toBe(true);
		draw("surface", "website");
		draw("staff", scheduled.id);
		expect(body.hasAttribute("inert")).toBe(false);
		draw("surface", "website");
		expect(body.hasAttribute("inert")).toBe(true);
		localStorage.removeItem("qorpera.web.rail-agents-open");

		const dialog = HTMLDialogElement.prototype;
		dialog.showModal ??= function (this: HTMLDialogElement) {
			this.open = true;
		};
		const add = container.querySelector<HTMLAnchorElement>(".rail-add")!;
		expect(add.getAttribute("aria-label")).toBe("New surface");
		const click = new MouseEvent("click", { bubbles: true, cancelable: true });
		add.dispatchEvent(click);
		expect(click.defaultPrevented).toBe(true);
		expect(document.querySelector(".context-menu")).toBeNull();
		expect(document.querySelector(".surface-create-sheet")).not.toBeNull();

		auth.dispose();
		store.dispose();
		company.stop();
		vi.unstubAllGlobals();
	});

	it("shows a website's address in the bar only while its site is live", async () => {
		stubFigureMotion();
		const store = storeWith(undefined, {
			companyName: "Thetaband",
			localInteractive: true,
			synthesize: () => ({ companyId: COMPANY, sites: [], pages: ["mailbox"] }),
		});
		await store.load();
		let live = true;
		const view = new SurfaceView(
			{ store, mount: () => undefined, openMigration: () => undefined, isSiteLive: () => live },
			"website",
		);
		document.body.append(view.el);
		await flush();
		view.update();

		const address = view.el.querySelector<HTMLButtonElement>(".surface-pill-modes > button.surface-pill-address");
		expect(address?.textContent).toBe("thetaband.dk");
		expect(address?.getAttribute("aria-expanded")).toBe("false");
		expect(address?.closest('[role="group"]')).toBeNull();
		address!.click();
		const sheet = view.el.querySelector<HTMLElement>(".surface-address-sheet")!;
		expect(sheet.hidden).toBe(false);
		expect(sheet.querySelector<HTMLAnchorElement>(".surface-address-open")?.getAttribute("href")).toBe(
			"https://thetaband.dk",
		);
		expect(view.el.querySelector(".surface-pill-address")?.getAttribute("aria-expanded")).toBe("true");
		view.el.querySelector<HTMLButtonElement>(".surface-pill-address")!.click();
		expect(sheet.hidden).toBe(true);
		const modes = view.el.querySelector('.surface-pill-mode-set[role="group"]');
		expect([...(modes?.querySelectorAll("button") ?? [])].map((button) => button.textContent)).toEqual([
			"Live",
			"Preview",
		]);

		live = false;
		view.update();
		expect(view.el.querySelector(".surface-pill-address")).toBeNull();
		expect(view.el.querySelector(".surface-pill-mode-set button")).not.toBeNull();

		view.dispose();
		store.dispose();
	});

	it("draws the address as a button that marks where the site lives and opens its sheet", async () => {
		stubFigureMotion();
		const store = storeWith(undefined, {
			companyName: "Thetaband",
			localInteractive: true,
			synthesize: () => ({ companyId: COMPANY, sites: [], pages: ["mailbox"] }),
		});
		await store.load();
		const hosting = fakeSiteHosting();
		let site: { siteId: string; client: typeof hosting.client } | undefined;
		let live = true;
		const view = new SurfaceView(
			{
				store,
				mount: () => undefined,
				openMigration: () => undefined,
				isSiteLive: () => live,
				siteHosting: () => site,
				managesSites: () => true,
			},
			"website",
		);
		document.body.append(view.el);
		await flush();
		view.update();
		const address = () => view.el.querySelector<HTMLButtonElement>(".surface-pill-address");

		expect(address()?.className).toBe("surface-pill-address is-unknown");
		expect(address()?.dataset.act).toBe("address");
		expect(hosting.client.read).not.toHaveBeenCalled();

		site = { siteId: HOSTED_SITE, client: hosting.client };
		view.update();
		await flush();
		expect(hosting.client.read).toHaveBeenCalledTimes(1);
		expect(address()?.className).toBe("surface-pill-address is-private");
		expect(address()?.title).toBe("Only your team can open it");
		expect(address()?.querySelector(".surface-address-lock svg")).not.toBeNull();
		expect(address()?.textContent).toBe("thetaband.dk");

		address()!.click();
		await flush();
		const sheet = view.el.querySelector<HTMLElement>(".surface-canvas > .surface-address-sheet")!;
		expect(sheet.hidden).toBe(false);
		[...sheet.querySelectorAll<HTMLButtonElement>("button")]
			.find((item) => item.textContent === "Put it live")!
			.click();
		expect(address()?.className).toBe("surface-pill-address is-live");
		expect(address()?.title).toBe("Anyone can open it");
		expect(address()?.querySelector(".surface-address-dot")).not.toBeNull();
		await flush();

		hosting.world.entry!.domains = [siteDomain("www.thetaband.dk")];
		address()!.click();
		address()!.click();
		await flush();
		expect(address()?.className).toBe("surface-pill-address is-waiting");
		expect(address()?.title).toBe("Waiting for your domain");
		expect(address()?.textContent).toBe("www.thetaband.dk");

		hosting.world.entry!.domains = [siteDomain("www.thetaband.dk", "tls_active", { isPrimary: true })];
		address()!.click();
		address()!.click();
		await flush();
		expect(address()?.className).toBe("surface-pill-address is-live");
		expect(address()?.textContent).toBe("www.thetaband.dk");

		address()!.click();
		await flush();
		address()!.focus();
		address()!.click();
		expect(sheet.hidden).toBe(false);
		expect(document.activeElement).toBe(sheet);
		await flush();
		expect(document.activeElement).toBe(sheet);
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(sheet.hidden).toBe(true);
		expect(document.activeElement).toBe(address());

		const composer = view.el.querySelector<HTMLTextAreaElement>(".surface-input")!;
		composer.focus();
		address()!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
		expect(sheet.hidden).toBe(false);
		expect(document.activeElement).toBe(composer);
		address()!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));

		live = false;
		view.update();
		expect(address()).toBeNull();
		expect(sheet.hidden).toBe(true);

		view.dispose();
		store.dispose();
	});

	it("keeps the header pill balanced into three flex groups with collapse nested in the right tools", async () => {
		stubFigureMotion();
		const store = storeWith(undefined, {
			companyName: "Thetaband",
			localInteractive: true,
			synthesize: () => ({ companyId: COMPANY, sites: [], pages: ["mailbox"] }),
		});
		await store.load();
		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "website");
		document.body.append(view.el);
		await flush();
		view.update();

		const pill = view.el.querySelector<HTMLElement>(".surface-pill");
		expect(pill?.classList.contains("is-spacious")).toBe(true);
		expect([...(pill?.children ?? [])].map((child) => child.className)).toEqual([
			"surface-pill-modes",
			"surface-bar-crew",
			"surface-pill-right",
		]);
		expect(pill?.querySelector(".surface-pill-right .surface-pill-collapse")).not.toBeNull();

		view.dispose();
		store.dispose();
	});

	it("renders the foundational Identity interface with global reach chips, Design System, Philosophy, and Voice & Files", async () => {
		stubFigureMotion();
		const store = storeWith(undefined, {
			companyName: "Thetaband",
			localInteractive: true,
			synthesize: () => ({ companyId: COMPANY, sites: [], pages: ["mailbox"] }),
		});
		await store.load();
		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "identity");
		document.body.append(view.el);
		await flush();
		view.update();

		const tabs = [...view.el.querySelectorAll<HTMLButtonElement>(".studio-tab")].map((tab) => tab.textContent);
		expect(tabs).toEqual(["Overview", "Design System", "Philosophy", "Voice & Files"]);

		const reachChips = [...view.el.querySelectorAll<HTMLButtonElement>(".studio-reach-chip")].map(
			(chip) => chip.dataset.slug,
		);
		expect(reachChips).toEqual(["website", "phone-app", "product", "financials"]);
		expect(view.el.querySelector('[data-token="colors.Aften Lavendel"] code')?.textContent).toBe("#6f61cf");

		view.el.querySelector<HTMLButtonElement>('[data-act="studio-tab"][data-tab="analysis"]')!.click();
		expect(view.el.querySelector(".report-headline")?.textContent).toBe("Calm Technology You Actually Put On");

		view.el.querySelector<HTMLButtonElement>('[data-act="studio-tab"][data-tab="files"]')!.click();
		expect(view.el.querySelector('[data-file="identity/voice.md"]')?.textContent).toContain(
			"Vi siger / Vi siger aldrig",
		);

		const panelToggle = view.el.querySelector<HTMLButtonElement>(":scope > .surface-panel-toggle");
		expect(panelToggle).not.toBeNull();
		expect(view.el.querySelector(".surface-canvas .surface-panel-toggle")).toBeNull();
		expect(view.el.querySelector('.surface-drawer [data-act="close-panel"]')).toBeNull();
		expect(view.el.querySelector('.surface-drawer [data-act="close"]')).toBeNull();

		view.dispose();
		store.dispose();
	});

	it("lets mobile previews switch between exact phone models and updates logical viewport dimensions", async () => {
		stubFigureMotion();
		const store = storeWith(undefined, {
			companyName: "Thetaband",
			localInteractive: true,
			synthesize: () => ({ companyId: COMPANY, sites: [], pages: ["mailbox"] }),
		});
		await store.load();
		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "phone-app");
		document.body.append(view.el);
		await flush();
		view.update();

		const viewport = view.el.querySelector<HTMLElement>(".surface-viewport")!;
		expect(viewport.dataset.device).toBe("mobile");
		expect(viewport.style.getPropertyValue("--phone-w")).toBe("393px");
		expect(viewport.style.getPropertyValue("--phone-h")).toBe("852px");
		expect(viewport.dataset.phoneCutout).toBe("island");

		view.el.querySelector<HTMLButtonElement>('[data-phone-model="iphone-se"]')!.click();
		expect(viewport.style.getPropertyValue("--phone-w")).toBe("375px");
		expect(viewport.style.getPropertyValue("--phone-h")).toBe("667px");
		expect(viewport.dataset.phoneCutout).toBe("none");

		view.el.querySelector<HTMLButtonElement>('[data-phone-model="pixel-9"]')!.click();
		expect(viewport.style.getPropertyValue("--phone-w")).toBe("412px");
		expect(viewport.style.getPropertyValue("--phone-h")).toBe("915px");
		expect(viewport.dataset.phoneCutout).toBe("punch");

		view.dispose();
		store.dispose();
	});

	it("renders multiplayer surface presence in the header pill and teammate attribution in drawer chat and patch notes", async () => {
		stubFigureMotion();
		const madsId = "99999999-9999-4999-8999-999999999999";
		const site = summary({
			id: SURFACE,
			slug: "website",
			title: "Website",
			unpublishedChangeCount: 1,
			hasUnpublishedChanges: true,
		});
		const approved = change(CHANGES[0], 1, "merged", {
			title: "Update pricing hero",
			summary: "Clarifies all-in DKK pricing.",
			approvedByUserId: madsId,
			publishedAt: null,
			resolvedAt: "2026-11-21T19:30:00Z",
		});
		const open = change(CHANGES[1], 2, "staged", { title: "Refine Danish FAQ" });
		const activeSess = session(["merged", "staged"], {
			id: SESSION,
			surfaceId: site.id,
			title: "Launch polish",
			changes: [approved, open],
			messages: [
				sessionMessage(MESSAGE_IDS[0], "member", "Please clarify Batch 1 delivery.", {
					authorUserId: madsId,
				}),
			],
		});
		const client = fakeClient({
			listSurfaces: vi.fn().mockResolvedValue([site]),
			getSurfaceWorkspace: vi.fn().mockResolvedValue(workspace([activeSess], { surface: site })),
		});
		const store = storeWith(client, {
			memberName: (id) => (id === madsId ? "Mads" : undefined),
			peopleAtSurface: (slug) => (slug === "website" ? [{ userId: madsId, name: "Mads" }] : []),
		});
		await store.load();
		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "website");
		document.body.append(view.el);
		await flush();
		view.update();

		const presence = view.el.querySelector<HTMLElement>(".surface-pill-presence");
		expect(presence).not.toBeNull();
		expect(presence?.title).toBe("Mads is here");

		store.openDrawer(site.id, activeSess.id);
		view.update();
		expect(view.el.querySelector(".surface-message-author")?.textContent).toBe("Mads");

		view.el.querySelector<HTMLButtonElement>('[data-act="publish"]')!.click();
		expect(document.querySelector(".surface-patchnote-approver")?.textContent).toBe("Approved by Mads");
		document.querySelector<HTMLButtonElement>('.surface-publish-sheet [data-act="cancel"]')?.click();

		view.dispose();
		store.dispose();
	});

	it("renders affected file chips and omits the folder source footer in the Changes drawer", async () => {
		stubFigureMotion();
		const navigated: string[] = [];
		const site = summary({
			id: SURFACE,
			slug: "website",
			title: "Website",
			repositoryKey: "website",
			folderRoot: null,
			activeSessionCount: 1,
			pendingChangeCount: 1,
		});
		const identitySurface = summary({
			id: "55555555-5555-4555-8555-555555555588",
			slug: "identity",
			title: "Identity",
			archetype: "studio",
			kind: "identity",
			isGlobal: true,
			repositoryKey: null,
			folderRoot: "identity",
			liveUrl: null,
			siteSlug: null,
			activeSessionCount: 0,
			pendingChangeCount: 0,
		});
		const multiFileChange = change(CHANGES[0], 1, "staged", {
			title: "Refine hero & tokens",
			affectedPaths: ["identity/tokens.json", "src/Hero.tsx", "src/Footer.tsx", "src/Nav.tsx"],
		});
		const activeSess = session(["staged"], {
			id: SESSION,
			surfaceId: site.id,
			title: "Hero polish",
			changes: [multiFileChange],
		});
		const client = fakeClient({
			listSurfaces: vi.fn().mockResolvedValue([site, identitySurface]),
			getSurfaceWorkspace: vi
				.fn()
				.mockImplementation(async (surfaceId: string) =>
					surfaceId === site.id
						? workspace([activeSess], { surface: site })
						: workspace([], { surface: identitySurface }),
				),
		});
		const store = storeWith(client, {
			onNavigateSurface: (slug) => navigated.push(slug),
		});
		await store.load();
		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "website");
		document.body.append(view.el);
		await flush();
		view.update();

		const chips = [...view.el.querySelectorAll<HTMLAnchorElement>(".surface-overview-change .surface-file-chip")];
		expect(chips.map((chip) => chip.textContent)).toEqual([
			"identity/tokens.json",
			"src/Hero.tsx",
			"src/Footer.tsx",
			"+1",
		]);
		expect(linkHref(chips[0]!)).toBe(`#/c/${COMPANY}/s/files`);
		expect(store.state.drawer).toBeUndefined();
		chips[0]!.click();
		expect(navigated).toEqual(["files"]);
		expect(location.hash).toBe(`#/c/${COMPANY}/s/files`);
		expect(store.state.drawer).toBeUndefined();

		expect(view.el.querySelector(".surface-drawer.is-open.is-overview")).not.toBeNull();
		expect(view.el.querySelector(".surface-drawer-source")).toBeNull();
		expect(view.el.querySelector(".surface-source-pill")).toBeNull();

		view.dispose();

		store.openPreviewPanel();
		const identityView = new SurfaceView(
			{ store, mount: () => undefined, openMigration: () => undefined },
			"identity",
		);
		document.body.append(identityView.el);
		await flush();
		identityView.update();
		expect(identityView.el.querySelector(".surface-drawer.is-open.is-overview")).not.toBeNull();
		expect(identityView.el.querySelector(".surface-drawer-source")).toBeNull();
		expect(identityView.el.querySelector(".surface-source-pill")).toBeNull();

		identityView.dispose();
		store.dispose();
	});

	it("renders Share live link bar inside Patch notes sheet, copies link and optional password", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText },
		});
		HTMLDialogElement.prototype.showModal = function () {
			this.open = true;
		};
		HTMLDialogElement.prototype.close = function () {
			this.open = false;
			this.dispatchEvent(new Event("close"));
		};
		const site = summary({
			id: SURFACE,
			slug: "website",
			title: "Website",
			liveUrl: "https://thetaband.qorpera.com",
			unpublishedChangeCount: 1,
			hasUnpublishedChanges: true,
		});
		const client = fakeClient({
			listSurfaces: vi.fn().mockResolvedValue([site]),
			getSurfaceWorkspace: vi.fn().mockResolvedValue(workspace([], { surface: site })),
		});
		const store = storeWith(client);
		await store.load();

		const loadSitePassword = vi.fn().mockResolvedValue("nordic-pass-42");
		const dialog = openPublishPatchnotesSheet(store, site, { loadSitePassword });
		await flush();

		const shareBar = document.querySelector<HTMLElement>(".surface-share-bar")!;
		expect(shareBar).not.toBeNull();
		expect(shareBar.querySelector(".surface-share-url")?.textContent).toBe("https://thetaband.qorpera.com");
		const openLink = shareBar.querySelector<HTMLAnchorElement>(".surface-share-btn.is-open")!;
		expect(openLink.getAttribute("href")).toBe("https://thetaband.qorpera.com");
		expect(openLink.target).toBe("_blank");
		expect(openLink.rel).toContain("noopener");

		const copyLinkBtn = shareBar.querySelector<HTMLButtonElement>('[data-act="copy-link"]')!;
		copyLinkBtn.click();
		await flush();
		expect(writeText).toHaveBeenCalledWith("https://thetaband.qorpera.com");
		expect(document.querySelector('[data-act="copy-link"]')?.textContent).toBe("Copied");

		const copyPassBtn = document.querySelector<HTMLButtonElement>('[data-act="copy-password"]')!;
		expect(copyPassBtn).not.toBeNull();
		copyPassBtn.click();
		await flush();
		expect(writeText).toHaveBeenCalledWith("nordic-pass-42");
		expect(document.querySelector('[data-act="copy-password"]')?.textContent).toBe("Copied");
		dialog.close();

		const dialogWithoutPass = openPublishPatchnotesSheet(store, site);
		await flush();
		expect(document.querySelector(".surface-share-bar")).not.toBeNull();
		expect(document.querySelector('[data-act="copy-password"]')).toBeNull();
		dialogWithoutPass.close();
		store.dispose();
	});

	it("folds optional starting surfaces and reference URL into NewCompanyView submissions without affecting blank ones", () => {
		const f = fixture();
		const hub = new HubController(f.api, userA.id);
		const start = vi.spyOn(hub, "startFromIdea").mockResolvedValue(false);
		const host = document.createElement("div");
		document.body.append(host);
		renderNewCompany(hub, host, { userId: userA.id, name: "Anna" });

		expect(host.querySelector("label")).toBeNull();
		const idea = host.querySelector<HTMLTextAreaElement>(".hero-idea")!;
		const form = host.querySelector<HTMLFormElement>(".hero-box")!;
		const url = host.querySelector<HTMLInputElement>(".hero-starter-url")!;

		idea.value = "Calm wearable for meditation";
		idea.dispatchEvent(new Event("input"));
		form.requestSubmit();
		expect(start).toHaveBeenLastCalledWith("Calm wearable for meditation", "start", "", { spectators: [] });

		const websitePill = host.querySelector<HTMLButtonElement>('[data-starter-surface="website"]')!;
		const mobilePill = host.querySelector<HTMLButtonElement>('[data-starter-surface="mobile-app"]')!;
		websitePill.click();
		mobilePill.click();
		expect(websitePill.getAttribute("aria-pressed")).toBe("true");
		expect(mobilePill.getAttribute("aria-pressed")).toBe("true");
		url.value = "https://thetaband.dk";
		form.requestSubmit();
		expect(start).toHaveBeenLastCalledWith(
			"Calm wearable for meditation\n\nStarting surfaces: Website, Mobile App\nReference URL: https://thetaband.dk",
			"start",
			"",
			{ spectators: [] },
		);

		start.mockClear();
		idea.value = "";
		form.requestSubmit();
		expect(start).not.toHaveBeenCalled();

		hub.dispose();
	});

	it("renders the Used by line on Identity, the same one-line links on Product, and applies live Identity CSS vars to Product", async () => {
		stubFigureMotion();
		const navigated: string[] = [];
		const store = storeWith(undefined, {
			companyName: "Thetaband",
			localInteractive: true,
			onNavigateSurface: (slug) => navigated.push(slug),
			synthesize: () => ({ companyId: COMPANY, sites: [], pages: ["mailbox"] }),
		});
		await store.load();
		const identitySurface = store.state.surfaces.find((item) => item.slug === "identity")!;
		await store.openSurface("identity");

		const identityView = new SurfaceView(
			{ store, mount: () => undefined, openMigration: () => undefined },
			"identity",
		);
		document.body.append(identityView.el);
		await flush();
		identityView.update();

		const identityReach = identityView.el.querySelector<HTMLElement>(
			'[data-identity-reach="true"][data-live-linked="true"]',
		)!;
		expect(identityReach).not.toBeNull();
		expect(identityReach.textContent).toContain("Used by");
		expect(identityReach.textContent).not.toContain("identity/tokens.json");
		expect(identityReach.querySelector(".studio-live-dot")).toBeNull();
		identityView.dispose();

		const productView = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "product");
		document.body.append(productView.el);
		await flush();
		productView.update();

		const productStudio = productView.el.querySelector<HTMLElement>(".surface-studio")!;
		expect(productStudio.classList.contains("has-identity-tokens")).toBe(true);
		expect(productStudio.style.getPropertyValue("--q-color-accent")).toBe("#6f61cf");

		const sharedStrip = productView.el.querySelector<HTMLElement>('.studio-reach[data-live-linked="true"]')!;
		expect(sharedStrip).not.toBeNull();
		expect(productView.el.querySelector(".studio-shared-links")).toBeNull();
		expect(sharedStrip.querySelector('[data-link-dir="in"]')?.textContent).toContain("Builds on");
		expect(sharedStrip.querySelector('[data-link-dir="out"]')?.textContent).toContain("Used by");
		expect(sharedStrip.textContent).not.toContain("tokens.css");
		expect(sharedStrip.textContent).not.toContain("specs.json");
		expect(sharedStrip.textContent).not.toContain("CSS vars");

		const outSlugs = [
			...sharedStrip.querySelectorAll<HTMLButtonElement>('[data-link-dir="out"] .studio-reach-chip'),
		].map((chip) => chip.dataset.slug);
		expect(outSlugs).toContain("website");
		expect(outSlugs).toContain("phone-app");
		expect(new Set(outSlugs).size).toBe(outSlugs.length);
		const inSlugs = [
			...sharedStrip.querySelectorAll<HTMLButtonElement>('[data-link-dir="in"] .studio-reach-chip'),
		].map((chip) => chip.dataset.slug);
		expect(inSlugs).toContain("identity");
		expect(new Set(inSlugs).size).toBe(inSlugs.length);

		sharedStrip.querySelector<HTMLButtonElement>('[data-link-dir="in"] [data-slug="identity"]')!.click();
		expect(navigated).toEqual(["identity"]);

		const identityTokenChange = store.workspace(identitySurface.id)!.activeSessions[0]!.changes[0]!;
		await store.toggleChange(identitySurface.id, identityTokenChange.id);
		productView.update();
		expect(productStudio.style.getPropertyValue("--q-color-accent")).toBe("#7c6fd6");

		productView.dispose();
		store.dispose();
	});

	it("injects live compiled Identity CSS tokens into local live_build iframes and posts them to SurfaceDoorStage", async () => {
		stubFigureMotion();
		const store = storeWith(undefined, {
			companyName: "Thetaband",
			localInteractive: true,
			synthesize: () => ({ companyId: COMPANY, sites: [], pages: ["mailbox"] }),
		});
		await store.load();
		const identitySurface = store.state.surfaces.find((item) => item.slug === "identity")!;
		await store.openSurface("identity");
		const identityTokenChange = store.workspace(identitySurface.id)!.activeSessions[0]!.changes[0]!;

		const websiteView = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "website");
		document.body.append(websiteView.el);
		await flush();
		websiteView.update();

		const localFrame = websiteView.el.querySelector<HTMLIFrameElement>("iframe.surface-local-frame")!;
		expect(localFrame).not.toBeNull();
		expect(localFrame.srcdoc).toContain("data-qorpera-identity-tokens");
		expect(localFrame.srcdoc).toContain("--q-color-accent: #6f61cf;");
		expect(
			localFrame.contentDocument?.head.querySelector("style[data-qorpera-identity-tokens]")?.textContent,
		).toContain("--q-color-accent: #6f61cf;");

		await store.toggleChange(identitySurface.id, identityTokenChange.id);
		websiteView.update();
		const updatedFrame = websiteView.el.querySelector<HTMLIFrameElement>("iframe.surface-local-frame")!;
		expect(updatedFrame.srcdoc).toContain("--q-color-accent: #7c6fd6;");
		expect(
			updatedFrame.contentDocument?.head.querySelector("style[data-qorpera-identity-tokens]")?.textContent,
		).toContain("--q-color-accent: #7c6fd6;");
		websiteView.dispose();

		const controller = new AbortController();
		const stage = new SurfaceDoorStage(controller.signal);
		document.body.append(stage.el);
		const tokensBefore = store.companyIdentityTokens()!;
		stage.setIdentityTokens(tokensBefore);
		stage.sync(
			previewFrame({
				previewId: "66666666-6666-4666-8666-666666666601",
				doorActionUrl: "https://thetaband--p1111aaaa.qorpera.com/__qorpera/member",
				memberPass: "A".repeat(43),
			}),
			"Preview of Website",
		);
		const doorFrame = stage.el.querySelector<HTMLIFrameElement>("iframe.surface-frame")!;
		const posted: { message: unknown; origin: string }[] = [];
		const mockWin = {
			postMessage(message: unknown, origin: string) {
				posted.push({ message, origin });
			},
		} as unknown as Window;
		Object.defineProperty(doorFrame, "contentWindow", { configurable: true, get: () => mockWin });
		window.dispatchEvent(
			new MessageEvent("message", { data: { type: SITE_DOOR_READY }, source: mockWin, origin: location.origin }),
		);
		window.dispatchEvent(
			new MessageEvent("message", { data: { type: SITE_DOOR_SHOWN }, source: mockWin, origin: location.origin }),
		);
		expect(posted.at(-1)).toEqual({
			message: {
				type: IDENTITY_TOKENS_CSS_MESSAGE,
				css: tokensBefore.css,
				vars: tokensBefore.vars,
			},
			origin: "*",
		});

		await store.toggleChange(identitySurface.id, identityTokenChange.id);
		const tokensAfter = store.companyIdentityTokens()!;
		stage.setIdentityTokens(tokensAfter);
		expect(posted.at(-1)).toEqual({
			message: {
				type: IDENTITY_TOKENS_CSS_MESSAGE,
				css: tokensAfter.css,
				vars: tokensAfter.vars,
			},
			origin: "*",
		});

		controller.abort();
		store.dispose();
	});
});
