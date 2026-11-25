// @vitest-environment jsdom
import {
	SURFACE_INSPECTOR_MODE_MESSAGE,
	SURFACE_INSPECTOR_PICK_MESSAGE,
	type SurfaceAutomationSummary,
	type SurfaceExplorationSet,
	type SurfaceSession,
	type SurfaceSummary,
	type SurfaceWorkspace,
} from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SurfacesClient } from "../src/app/surfaces-store.ts";
import { SITE_DOOR_PASS, SITE_DOOR_READY, SITE_DOOR_SHOWN, SITE_DOOR_URL } from "../src/app/views/site-view.ts";
import { previewStatusText, publishFailureText, SurfaceDoorStage } from "../src/app/views/surface-door.ts";
import { openPublishSheet } from "../src/app/views/surface-publish-sheet.ts";
import { SurfaceRail } from "../src/app/views/surface-rail.ts";
import { SurfaceReportView } from "../src/app/views/surface-report-view.ts";
import { SurfaceView } from "../src/app/views/surface-view.ts";
import { openMenu } from "../src/ui/context-menu.ts";
import { linkHref } from "../src/ui/dom.ts";
import { deferred } from "./fixtures.ts";
import {
	CHANGES,
	COMPANY,
	change,
	fakeClient,
	folderContents,
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
	it("lists the interfaces in one list, Inbox first, with no seeded sections and no rail switches", async () => {
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
		rail.update("website");
		expect(rail.el.querySelectorAll(".rail-surface-title")).toHaveLength(0);
		const names = [...rail.el.querySelectorAll(".rail-surface-name")].map((node) => node.textContent);
		expect(names[0]).toBe("Inbox");
		expect(names).toContain("Website");
		const active = rail.el.querySelector<HTMLAnchorElement>(".rail-surface.active");
		expect(active ? linkHref(active) : null).toBe(`#/c/${COMPANY}/s/website`);
		expect(active?.querySelector(".surface-figure")?.getAttribute("data-figure")).toBe("browser");
		expect(rail.el.querySelector(".rail-surface-add")).toBeNull();
		expect(rail.el.querySelector(".surface-switch")).toBeNull();
		const crew = active?.querySelector<HTMLElement>(".rail-surface-crew");
		expect(crew?.getAttribute("aria-label")).toBe("1 session active");
		expect(crew?.querySelectorAll(".surface-crew.is-mini")).toHaveLength(1);
		expect(rail.el.querySelector(".surface-session, .surface-tree")).toBeNull();
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

	describe("Delete in the right-click menu", () => {
		const inbox = summary({
			id: "55555555-5555-4555-8555-555555555555",
			slug: "inbox",
			title: "Inbox",
			group: "operations",
			archetype: "ops",
			icon: "mail",
			siteSlug: null,
			activeSessionCount: 0,
		});
		const quiet = { activeSessionCount: 0, pendingChangeCount: 0, liveUrl: null };
		const railRow = (rail: SurfaceRail, slug: string) =>
			rail.el.querySelector<HTMLElement>(`.rail-surface[data-surface-slug="${slug}"]`);
		const menuRow = (label: string) =>
			[...document.querySelectorAll<HTMLElement>(".context-menu-item")].find(
				(item) => item.textContent?.trim() === label,
			);
		const openRowMenu = (rail: SurfaceRail, slug: string) =>
			railRow(rail, slug)!.dispatchEvent(
				new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }),
			);
		const chooseDelete = async (rail: SurfaceRail, slug: string) => {
			openRowMenu(rail, slug);
			menuRow("Delete")!.click();
			await flush();
		};
		const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
		const dialogButton = (label: string) =>
			[...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label)!;
		const scheduled = (id: string, targetSurfaceSlug: string | null): SurfaceAutomationSummary => ({
			id,
			key: id,
			title: "Weekly check",
			scheduleSummary: "Mondays 08:00",
			targetSurfaceSlug,
			outputMode: targetSurfaceSlug ? "surface_session" : "decision_card",
			enabled: true,
			status: "idle",
			lastRunAt: null,
			lastOutcomeSummary: null,
			nextRunAt: null,
			ownable: true,
			ownerUserId: null,
			offer: null,
		});
		const railOf = async (
			surfaces: readonly SurfaceSummary[],
			client: Partial<SurfacesClient> = {},
			open = "website",
		) => {
			const store = storeWith(
				fakeClient({
					listSurfaces: vi.fn(async () => [...surfaces]),
					getSurfaceWorkspace: vi.fn(async (id: string) =>
						workspace([], { surface: surfaces.find((item) => item.id === id)! }),
					),
					...client,
				}),
			);
			await store.load();
			const reportError = vi.fn();
			const rail = new SurfaceRail(store, COMPANY, new AbortController().signal, undefined, reportError);
			document.body.append(rail.el);
			rail.update(open);
			return { store, rail, reportError };
		};

		afterEach(async () => {
			openMenu()?.close();
			await flush();
			history.replaceState(null, "", location.pathname);
		});

		it("asks first, deletes on the dialog's Delete, and leaves the deleted surface's page", async () => {
			const archiveSurface = vi.fn(async (id: string) => summary({ id, status: "archived" }));
			const { store, rail, reportError } = await railOf([summary(quiet), inbox], { archiveSurface });

			openRowMenu(rail, "website");
			const remove = menuRow("Delete")!;
			expect(remove.classList.contains("danger")).toBe(true);
			expect(remove.previousElementSibling?.getAttribute("role")).toBe("separator");
			remove.click();
			expect(openMenu()).toBeUndefined();
			await flush();
			expect(dialog()?.querySelector("p")?.textContent).toBe(
				"Delete Website? It is removed for everyone in the company.",
			);
			expect(dialog()!.querySelector(".modal-list")).toBeNull();
			dialogButton("Cancel").click();
			await flush();
			expect(dialog()).toBeNull();
			expect(archiveSurface).not.toHaveBeenCalled();
			expect(railRow(rail, "website")).not.toBeNull();

			await chooseDelete(rail, "website");
			expect(dialogButton("Delete").classList.contains("btn-danger")).toBe(true);
			dialogButton("Delete").click();
			await flush();
			rail.update("website");
			expect(archiveSurface).toHaveBeenCalledWith(SURFACE);
			expect(railRow(rail, "website")).toBeNull();
			expect(railRow(rail, "inbox")).not.toBeNull();
			expect(location.hash).toBe(`#/c/${COMPANY}`);
			expect(reportError).not.toHaveBeenCalled();
			store.dispose();
		});

		it("stays on the page that is open when another surface is deleted", async () => {
			const shop = summary({ ...quiet, id: "55555555-5555-4555-8555-555555555577", slug: "shop", title: "Shop" });
			const { store, rail } = await railOf([summary(), shop]);

			await chooseDelete(rail, "shop");
			dialogButton("Delete").click();
			await flush();
			rail.update("website");
			expect(railRow(rail, "shop")).toBeNull();
			expect(location.hash).toBe("");
			store.dispose();
		});

		it("asks the one question whatever the surface holds, and deletes it all with the one call", async () => {
			const listAutomations = vi.fn(async () => [
				scheduled("a-1", "website"),
				scheduled("a-2", "inbox"),
				scheduled("a-3", null),
			]);
			const deleteAutomation = vi.fn(async () => true);
			const archiveSurface = vi.fn(async (id: string) => summary({ id, status: "archived" }));
			const { store, rail } = await railOf(
				[summary({ activeSessionCount: 3, runningSessionCount: 2, pendingChangeCount: 1 }), inbox],
				{ listAutomations, deleteAutomation, archiveSurface },
				"inbox",
			);
			const reads = listAutomations.mock.calls.length;

			await chooseDelete(rail, "website");
			expect(dialog()!.classList.contains("confirm-dialog")).toBe(true);
			expect([...dialog()!.children].map((item) => item.tagName)).toEqual(["P", "DIV"]);
			expect(dialog()!.querySelector("p")?.textContent).toBe(
				"Delete Website? It is removed for everyone in the company.",
			);
			dialogButton("Delete").click();
			await flush();
			expect(archiveSurface).toHaveBeenCalledTimes(1);
			expect(archiveSurface).toHaveBeenCalledWith(SURFACE);
			expect(deleteAutomation).not.toHaveBeenCalled();
			expect(listAutomations).toHaveBeenCalledTimes(reads);
			expect(store.state.automations.map((item) => item.id)).toEqual(["a-2", "a-3"]);
			expect(store.state.surfaces.map((item) => item.slug)).toEqual(["inbox"]);
			store.dispose();
		});

		it("says so in the rail and keeps the surface and its scheduled agents when the delete fails", async () => {
			const { store, rail, reportError } = await railOf([summary()], {
				listAutomations: vi.fn(async () => [scheduled("a-1", "website"), scheduled("a-2", "website")]),
				archiveSurface: vi.fn(async () => Promise.reject(new Error("permission denied"))),
			});

			await chooseDelete(rail, "website");
			dialogButton("Delete").click();
			await flush();
			rail.update("website");
			expect(reportError).toHaveBeenCalledWith("Website could not be deleted.");
			expect(store.state.automations.map((item) => item.id)).toEqual(["a-1", "a-2"]);
			expect(railRow(rail, "website")).not.toBeNull();
			expect(location.hash).toBe("");
			store.dispose();
		});

		it("opens one dialog for a surface however often Delete is chosen", async () => {
			const { store, rail } = await railOf([summary()]);

			openRowMenu(rail, "website");
			menuRow("Delete")!.click();
			await chooseDelete(rail, "website");
			expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
			dialogButton("Cancel").click();
			store.dispose();
		});

		it("offers no Delete on a built-in surface, which nothing can bring back", async () => {
			const { store, rail } = await railOf([summary(), inbox]);

			openRowMenu(rail, "inbox");
			expect(menuRow("Figure")).toBeDefined();
			expect(menuRow("Delete")).toBeUndefined();
			expect(openMenu()!.el.querySelector('[role="separator"]')).toBeNull();
			store.dispose();
		});

		it("deletes a member's own section from its title, its interfaces moving out of it (Jonas, 24 Nov 2026)", async () => {
			const store = storeWith(
				fakeClient({
					listSurfaces: vi.fn(async () => [summary(quiet), inbox]),
					getSurfaceWorkspace: vi.fn(async () => workspace([], { surface: summary(quiet) })),
				}),
			);
			await store.load();
			let layout = {
				schema: "qorpera.member-surface-rail/v1" as const,
				order: [inbox.id],
				sections: [{ id: "design", name: "Design", surfaces: [SURFACE] }],
			};
			const change = vi.fn((next: typeof layout) => {
				layout = next;
			});
			const rail = new SurfaceRail(store, COMPANY, new AbortController().signal, {
				layout: () => layout,
				canArrange: () => true,
				change,
				refuse: vi.fn(),
			});
			document.body.append(rail.el);
			rail.update("website");
			expect([...rail.el.querySelectorAll(".rail-surface-title")].map((item) => item.textContent)).toEqual([
				"Design",
			]);

			rail.el
				.querySelector<HTMLElement>('[data-surface-section="design"]')!
				.dispatchEvent(
					new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }),
				);
			expect(menuRow("Rename section")).toBeDefined();
			menuRow("Delete section")!.click();
			await flush();
			expect(dialog()?.querySelector("p")?.textContent).toBe(
				'Delete your section "Design"? Its interfaces move out of it, to the end of the list.',
			);
			dialogButton("Delete section").click();
			await flush();
			expect(change).toHaveBeenCalledOnce();
			expect(layout).toEqual({ schema: "qorpera.member-surface-rail/v1", order: [inbox.id, SURFACE], sections: [] });
			rail.update("website");
			expect(rail.el.querySelectorAll(".rail-surface-title")).toHaveLength(0);
			expect(railRow(rail, "website")).not.toBeNull();
			store.dispose();
		});
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
		expect(view.el.querySelector(".surface-publish .surface-notch-count")?.textContent).toBe("2");
		expect(view.el.querySelector(".surface-mount .real-site-view")).toBe(mounted);
		expect(update).toHaveBeenCalled();
		expect(view.el.querySelector<HTMLTextAreaElement>(".surface-input")?.disabled).toBe(false);

		store.openDrawer(SURFACE, SESSION);
		await flush();
		view.update();
		const drawer = view.el.querySelector(".surface-drawer")!;
		expect(drawer.classList.contains("is-open")).toBe(true);
		expect(drawer.querySelector(".surface-changes-toggle")?.textContent).toBe("1 change ready");
		expect(drawer.querySelector('[data-act="approve"]')).toBeNull();
		drawer.querySelector<HTMLButtonElement>(".surface-changes-toggle")!.click();
		drawer.querySelector<HTMLButtonElement>(`[data-act="open-change"][data-change="${CHANGES[2]}"]`)?.click();
		const approveBtn = drawer.querySelector<HTMLElement>(`[data-act="approve"][data-change="${CHANGES[2]}"]`)!;
		expect(approveBtn.querySelector(".surface-approve-face.is-ghost")?.getAttribute("data-text")).toBe("Confirm");
		approveBtn.click();
		const confirmBtn = drawer.querySelector<HTMLElement>(`[data-act="approve"][data-change="${CHANGES[2]}"]`)!;
		expect(confirmBtn.classList.contains("is-confirming")).toBe(true);
		expect(confirmBtn.textContent).toBe("Confirm");
		expect(confirmBtn.querySelector(".surface-approve-face.is-ghost")?.getAttribute("data-text")).toBe("Approve");
		confirmBtn.click();
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

	it("says each option's first open change under its name in the Changes panel", async () => {
		const explorationId = "88888888-8888-4888-8888-888888888883";
		const secondSessionId = "33333333-3333-4333-8333-333333333336";
		const variantA = session(["staged"], {
			id: SESSION,
			explorationId,
			explorationVariantLabel: "Aftenlys",
			changes: [change(CHANGES[0], 1, "staged", { summary: "Warm evening light on the hero." })],
		});
		const variantB = session([], { id: secondSessionId, explorationId, explorationVariantLabel: "Varmt studie" });
		const ws = workspace([variantA, variantB], {
			explorations: [
				{
					id: explorationId,
					surfaceId: SURFACE,
					title: "Forsidens udtryk",
					status: "open",
					chosenSessionId: null,
					variantSessionIds: [SESSION, secondSessionId],
					createdAt: "2026-11-21T10:00:00.000Z",
					resolvedAt: null,
				},
			],
		});
		const store = storeWith(fakeClient({ getSurfaceWorkspace: vi.fn(async () => ws) }));
		await store.load();
		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "website");
		document.body.append(view.el);
		await flush();
		store.openPreviewPanel();
		view.update();

		const options = [...view.el.querySelectorAll(".surface-drawer .surface-overview-option")];
		expect(options.map((option) => option.querySelector(".surface-overview-option-label")?.textContent)).toEqual([
			"Aftenlys",
			"Varmt studie",
		]);
		expect(
			options.map((option) => option.querySelector(".surface-overview-option-line")?.textContent ?? null),
		).toEqual(["Warm evening light on the hero.", null]);
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
			previewBaseChangeIds: [CHANGES[0]],
		});
		expect(view.el.querySelector(".surface-target-pill")).toBeNull();
		view.dispose();
		store.dispose();
	});

	it("hides conflict banners and Reconcile buttons while rendering calm Updating preview status during silent reconciliation", async () => {
		const overlappingSession = session(["conflicted", "staged"], {
			changes: [
				change(CHANGES[0], 1, "conflicted", { conflictPaths: ["src/hero.tsx", "src/theme.css"] }),
				change(CHANGES[1], 2, "staged"),
			],
		});
		const ws = workspace([overlappingSession], {
			previewState: {
				surfaceId: SURFACE,
				mode: "single",
				primary: {
					...previewFrame({ status: "reconciling", doorActionUrl: null, memberPass: null }),
					conflictReport: null,
				},
				compareFrames: [],
			},
		});
		const store = storeWith(fakeClient({ getSurfaceWorkspace: vi.fn(async () => ws) }));
		await store.load();
		await store.openSurface("website");

		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "website");
		document.body.append(view.el);
		await flush();
		store.openDrawer(SURFACE, SESSION);
		view.update();
		expect(view.el.querySelector(".surface-banner.is-conflict")).toBeNull();
		expect(view.el.querySelector('[data-act="reconcile"]')).toBeNull();
		expect(view.el.querySelector(".surface-frame.is-waiting")?.textContent).toContain("Updating preview…");

		const drawer = view.el.querySelector(".surface-drawer")!;
		expect(drawer.querySelector(".surface-drawer-change.is-conflicted")).toBeNull();
		expect(drawer.querySelector('[data-act="reconcile"]')).toBeNull();
		drawer.querySelector<HTMLButtonElement>(".surface-changes-toggle")!.click();
		drawer.querySelector<HTMLButtonElement>(`[data-act="open-change"][data-change="${CHANGES[0]}"]`)?.click();
		expect(drawer.querySelector(`[data-act="approve"][data-change="${CHANGES[0]}"]`)).not.toBeNull();
		view.dispose();
		store.dispose();
	});

	it("folds an agent's changes into one box, keeps focus on its controls, and approves them all from it", async () => {
		const approveSessionAll = vi.fn(async () => session(["merged", "merged"], { state: "completed" }));
		let state: SurfaceSession["state"] = "running";
		const client = fakeClient({
			getSurfaceWorkspace: vi.fn(async () => workspace([session(["staged", "staged"], { state })])),
			approveSessionAll,
		});
		const store = storeWith(client);
		await store.load();
		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "website");
		document.body.append(view.el);
		await flush();
		store.openDrawer(SURFACE, SESSION);
		view.update();
		const drawer = view.el.querySelector(".surface-drawer")!;
		const toggle = () => drawer.querySelector<HTMLButtonElement>(".surface-changes-toggle")!;
		expect(toggle().textContent).toBe("2 changes ready");
		expect(drawer.querySelector('[data-act="approve-all"]')).toBeNull();
		toggle().focus();
		toggle().click();
		expect(toggle().getAttribute("aria-expanded")).toBe("true");
		expect(document.activeElement).toBe(toggle());
		expect(drawer.querySelectorAll(".surface-drawer-change")).toHaveLength(2);
		expect(drawer.querySelector('[data-act="approve-all"]')).toBeNull();

		state = "ready";
		await store.refreshWorkspace(SURFACE);
		view.update();
		const row = drawer.querySelector<HTMLButtonElement>(`[data-act="open-change"][data-change="${CHANGES[1]}"]`)!;
		row.click();
		expect(document.activeElement).toBe(
			drawer.querySelector(`[data-act="open-change"][data-change="${CHANGES[1]}"]`),
		);
		expect(drawer.querySelector(".surface-drawer-change.is-expanded")?.getAttribute("data-change")).toBe(CHANGES[1]);
		drawer.querySelector<HTMLButtonElement>(".surface-changes-fold")!.click();
		expect(document.activeElement).toBe(drawer.querySelector(".surface-changes-fold"));
		expect(drawer.querySelectorAll(".surface-drawer-change")).toHaveLength(0);
		drawer.querySelector<HTMLButtonElement>(".surface-changes-fold")!.click();

		const approveAll = drawer.querySelector<HTMLButtonElement>('[data-act="approve-all"]')!;
		expect(approveAll.textContent).toBe("Approve all");
		approveAll.click();
		const confirm = drawer.querySelector<HTMLButtonElement>('[data-act="approve-all"]')!;
		expect(confirm.classList.contains("is-confirming")).toBe(true);
		expect(confirm.textContent).toBe("Confirm");
		expect(approveSessionAll).not.toHaveBeenCalled();
		confirm.click();
		await flush();
		expect(approveSessionAll).toHaveBeenCalledWith(SESSION);
		view.dispose();
		store.dispose();
	});

	it("renders durable session.messages and reconciles optimistic replies in the drawer", async () => {
		const durable = [
			sessionMessage(MESSAGE_IDS[0], "member", "Gør heroen roligere"),
			sessionMessage(MESSAGE_IDS[1], "session", "Jeg strammer typografien og fjerner støj i hero-sektionen."),
			sessionMessage(MESSAGE_IDS[2], "system", "Staged change: Skarpere hero-tekst — Kortere og roligere.", {
				changeId: CHANGES[0],
			}),
			sessionMessage(
				"77777777-7777-4777-8777-777777777778",
				"system",
				"Staged option: Editorial hero — Clean look.",
				{
					changeId: CHANGES[1],
				},
			),
			sessionMessage("77777777-7777-4777-8777-777777777779", "system", "Merge conflicted. Reconcile to resolve.", {
				changeId: CHANGES[0],
			}),
			sessionMessage("77777777-7777-4777-8777-77777777777a", "system", "Merged “Ny pris” into Base", {
				changeId: CHANGES[1],
			}),
			sessionMessage("77777777-7777-4777-8777-77777777777b", "system", "Discarded change: Superpower-udkast", {
				changeId: CHANGES[0],
			}),
			sessionMessage("77777777-7777-4777-8777-77777777777c", "system", "Discarded options: A, B"),
			sessionMessage("77777777-7777-4777-8777-77777777777d", "system", "Restored change: Ny pris", {
				changeId: CHANGES[1],
			}),
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
			["surface-message is-system", expect.stringContaining("Merge conflicted. Reconcile to resolve.")],
			["surface-message is-system", expect.stringContaining("Merged “Ny pris” into Base")],
			["surface-message is-system", expect.stringContaining("Discarded “Superpower-udkast”")],
			["surface-message is-system", expect.stringContaining("Discarded options: A, B")],
			["surface-message is-system", expect.stringContaining("Restored “Ny pris”")],
		]);
		const systemRows = [...drawer.querySelectorAll(".surface-message.is-system")];
		expect(systemRows[0]?.getAttribute("data-change-id")).toBe(CHANGES[0]);
		expect(systemRows[0]?.querySelector(".surface-system-dot")).not.toBeNull();
		expect(systemRows[1]?.querySelector(".surface-system-mark")).not.toBeNull();
		expect(systemRows[2]?.querySelector(".surface-system-dot")).not.toBeNull();
		expect(systemRows[2]?.querySelector(".surface-system-mark")).toBeNull();
		expect(systemRows[3]?.querySelector(".surface-system-dot")).not.toBeNull();
		expect(systemRows[4]?.querySelector(".surface-system-mark")).not.toBeNull();

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

	it("draws an agent's message in the drawer as Markdown", async () => {
		const text = "**Brooks** afventer jeres aktivering.\n\n- Logo\n- Farver\n\nSe `src/hero.tsx`.";
		const client = fakeClient({
			getSurfaceWorkspace: vi.fn(async () =>
				workspace([session(["staged"], { messages: [sessionMessage(MESSAGE_IDS[1], "session", text)] })]),
			),
		});
		const store = storeWith(client);
		await store.load();
		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "website");
		document.body.append(view.el);
		await flush();
		store.openDrawer(SURFACE, SESSION);
		view.update();

		const message = view.el.querySelector(".surface-drawer .surface-message.is-session")!;
		expect(message.querySelector("strong")?.textContent).toBe("Brooks");
		expect([...message.querySelectorAll("li")].map((item) => item.textContent)).toEqual(["Logo", "Farver"]);
		expect(message.querySelector("code")?.textContent).toBe("src/hero.tsx");
		expect(message.textContent).not.toContain("**");
		view.dispose();
		store.dispose();
	});

	it("shows no Send to bar on Brand Studio or on an ops surface like Inbox", async () => {
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
		const store = storeWith(
			fakeClient({
				listSurfaces: vi.fn(async () => [summary(), brand, inbox]),
				getSurfaceWorkspace: vi.fn(async (id: string) =>
					workspace([], { surface: id === brand.id ? brand : id === inbox.id ? inbox : summary() }),
				),
			}),
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
		expect(brandView.el.querySelector(".surface-handoff-btn")).toBeNull();
		brandView.dispose();

		const inboxView = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "inbox");
		document.body.append(inboxView.el);
		await flush();
		inboxView.update();
		expect(inboxView.el.querySelector(".surface-handoff-btn")).toBeNull();
		expect(inboxView.el.querySelector<HTMLElement>(".surface-bar")?.hidden).toBe(true);
		inboxView.dispose();
		store.dispose();
	});

	it("hides the composer on unavailable surfaces and seeds no section titles", async () => {
		const store = storeWith(undefined, {
			synthesize: () => ({ companyId: COMPANY, sites: [], pages: [] }),
		});
		await store.load();
		const rail = new SurfaceRail(store, COMPANY, new AbortController().signal);
		document.body.append(rail.el);
		rail.update("missing");
		expect(rail.el.querySelector(".rail-surface-create")).toBeNull();
		expect(rail.el.querySelectorAll(".rail-surface-title")).toHaveLength(0);

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

	it("times out hung preview handshakes with one auto-remint retry and never submits consumed passes", async () => {
		vi.useFakeTimers();
		const consumed = new Set<string>();
		const remints: { previewId: string; stalePass?: string }[] = [];
		const controller = new AbortController();
		const stage = new SurfaceDoorStage(controller.signal, {
			handshakeTimeoutMs: 500,
			isPassUsable: (_previewId, pass) => !consumed.has(pass),
			onPassSent: (_previewId, pass) => consumed.add(pass),
			onNeedFreshPass: (previewId, stalePass) => {
				remints.push({ previewId, stalePass });
				return undefined;
			},
		});
		document.body.append(stage.el);

		const pass1 = VALID_PASS;
		const pass2 = `${VALID_PASS.slice(0, -1)}2`;
		stage.sync(previewFrame({ previewId: PREVIEW_IDS[0], memberPass: pass1 }), "Preview");
		const firstFrame = stage.el.querySelector<HTMLIFrameElement>("iframe.is-staging")!;
		spyFrameMessages(firstFrame);
		sendFromFrame(firstFrame, { type: SITE_DOOR_READY });
		expect(consumed.has(pass1)).toBe(true);

		vi.advanceTimersByTime(500);
		expect(stage.el.querySelector("iframe.is-staging")).toBeNull();
		expect(remints).toEqual([{ previewId: PREVIEW_IDS[0], stalePass: pass1 }]);

		stage.sync(previewFrame({ previewId: PREVIEW_IDS[0], memberPass: pass1 }), "Preview");
		expect(stage.el.querySelector("iframe.is-staging")).toBeNull();

		stage.sync(previewFrame({ previewId: PREVIEW_IDS[0], memberPass: pass2 }), "Preview");
		expect(stage.el.querySelector("iframe.is-staging")).not.toBeNull();
		vi.advanceTimersByTime(500);
		expect(remints).toHaveLength(1);
		expect(stage.el.querySelector(".surface-frame.is-waiting .surface-state.is-failed")).not.toBeNull();

		const pass3 = `${VALID_PASS.slice(0, -1)}3`;
		stage.sync(previewFrame({ previewId: PREVIEW_IDS[1], memberPass: pass3 }), "Preview 2");
		const liveFrame = stage.el.querySelector<HTMLIFrameElement>("iframe.is-staging")!;
		spyFrameMessages(liveFrame);
		sendFromFrame(liveFrame, { type: SITE_DOOR_READY });
		sendFromFrame(liveFrame, { type: SITE_DOOR_SHOWN });
		expect(stage.hasShown).toBe(true);
		stage.sync(previewFrame({ previewId: PREVIEW_IDS[1], memberPass: null }), "Preview 2");
		expect(stage.el.querySelector("iframe.is-shown")).toBe(liveFrame);
		expect(stage.el.querySelector("iframe.is-staging")).toBeNull();

		const failStage = new SurfaceDoorStage(controller.signal, {
			handshakeTimeoutMs: 500,
			onNeedFreshPass: async () => false,
		});
		document.body.append(failStage.el);
		failStage.sync(previewFrame({ previewId: PREVIEW_IDS[0], memberPass: pass1 }), "Preview fail");
		vi.advanceTimersByTime(500);
		await Promise.resolve();
		await Promise.resolve();
		expect(failStage.el.querySelector(".surface-frame.is-waiting .surface-state.is-failed")).not.toBeNull();
		expect(failStage.el.querySelector(".surface-frame.is-waiting p")?.textContent).toBe(
			"The preview could not be opened.",
		);

		controller.abort();
		vi.useRealTimers();
	});

	it("preserves a cross-surface drawer when an outgoing SurfaceView disposes and tracks concurrent publish rollbacks", async () => {
		const brand = summary({
			id: "22222222-2222-4222-8222-222222222229",
			slug: "brand",
			title: "Brand",
			archetype: "studio",
			siteSlug: null,
			liveUrl: null,
		});
		const rb1 = deferred<ReturnType<typeof session>>();
		const rb2 = deferred<ReturnType<typeof session>>();
		let rbCount = 0;
		const store = storeWith(
			fakeClient({
				listSurfaces: vi.fn(async () => [summary({ unpublishedChangeCount: 2 }), brand]),
				getSurfaceWorkspace: vi.fn(async (id: string) =>
					id === brand.id
						? workspace(
								[session(["staged"], { id: "33333333-3333-4333-8333-333333333399", surfaceId: brand.id })],
								{
									surface: brand,
								},
							)
						: workspace([session(["merged", "merged"])], { surface: summary({ unpublishedChangeCount: 2 }) }),
				),
				undoSurfaceChange: vi.fn(() => {
					rbCount += 1;
					return rbCount === 1 ? rb1.promise : rb2.promise;
				}),
			}),
		);
		await store.load();
		const websiteView = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "website");
		document.body.append(websiteView.el);
		await flush();
		websiteView.update();

		await store.openSurface("brand");
		store.openDrawer(brand.id, "33333333-3333-4333-8333-333333333399");
		websiteView.dispose();
		expect(store.state.drawer).toEqual({
			surfaceId: brand.id,
			sessionId: "33333333-3333-4333-8333-333333333399",
		});

		HTMLDialogElement.prototype.showModal = function () {
			this.open = true;
		};
		HTMLDialogElement.prototype.close = function () {
			this.open = false;
			this.dispatchEvent(new Event("close"));
		};
		const websiteSurface = store.state.surfaces.find((item) => item.id === SURFACE)!;
		const sheet = openPublishSheet(store, websiteSurface);
		const buttons = [...sheet.el.querySelectorAll<HTMLButtonElement>('[data-act="rollback"]')];
		expect(buttons).toHaveLength(2);
		buttons[0]!.click();
		sheet.el.querySelector<HTMLButtonElement>(`[data-act="rollback"][data-change="${CHANGES[1]}"]`)!.click();
		expect(
			sheet.el.querySelector<HTMLButtonElement>(`[data-act="rollback"][data-change="${CHANGES[0]}"]`)?.disabled,
		).toBe(true);
		expect(
			sheet.el.querySelector<HTMLButtonElement>(`[data-act="rollback"][data-change="${CHANGES[1]}"]`)?.disabled,
		).toBe(true);

		rb1.resolve(session(["staged", "merged"]));
		await flush();
		expect(
			sheet.el.querySelector<HTMLButtonElement>(`[data-act="rollback"][data-change="${CHANGES[1]}"]`)?.disabled,
		).toBe(true);
		sheet.close();
		rb2.resolve(session(["staged", "staged"]));
		await flush();
		store.dispose();
	});

	it("words a failed build for the member by its code and never shows the build log", () => {
		const failed = (errorDetail: string | null) => previewStatusText(previewFrame({ status: "failed", errorDetail }));
		expect(failed('PREVIEW_BUILD_FAILED\nThe build "npm run build" exited with code 1.\nsrc/main.tsx: error')).toBe(
			"The preview could not be built.",
		);
		expect(failed("PREVIEW_BUILD_NO_HOURS\nThe company has no computer hours left.")).toBe(
			"The company is out of computer hours, so the preview could not be built.",
		);
		expect(failed("PREVIEW_BUILD_NO_MACHINE\nNo coding machine could be had.")).toBe(
			"No machine was free to build the preview. Try again in a moment.",
		);
		expect(failed('PREVIEW_BUILD_TOO_LARGE\nThe build\'s output in "out" has more than 500 web files.')).toBe(
			"The built preview does not fit within the limits of a site.",
		);
		expect(failed("CODE_HOST_SITE_READ_FAILED: x")).toBe("The preview could not be built.");
		expect(failed(null)).toBe("The preview could not be built.");
		expect(publishFailureText("PREVIEW_BUILD_FAILED\nlog")).toBe(
			"The site could not be built, so nothing was published.",
		);
		expect(publishFailureText("PREVIEW_BUILD_TOO_LARGE\nlog")).toBe(
			"The built site does not fit within the limits of a site, so nothing was published.",
		);
		expect(publishFailureText("Missing index.html")).toBeNull();
	});

	it("keeps the last preview that built on screen with a quiet mark while a failed build is being fixed", () => {
		const controller = new AbortController();
		const remints: string[] = [];
		const stage = new SurfaceDoorStage(controller.signal, {
			onNeedFreshPass: (previewId) => {
				remints.push(previewId);
				return undefined;
			},
		});
		document.body.append(stage.el);
		const pill = stage.el.querySelector<HTMLElement>(".surface-preview-pill")!;
		const failed = (overrides: Partial<ReturnType<typeof previewFrame>> = {}) =>
			previewFrame({
				previewId: PREVIEW_IDS[0],
				status: "failed",
				doorActionUrl: null,
				memberPass: null,
				errorDetail: 'PREVIEW_BUILD_FAILED\nThe build "npm run build" exited with code 1.',
				kept: {
					previewId: PREVIEW_IDS[1],
					doorActionUrl: "https://thetaband--p12ab34cd.qorpera.com/__qorpera/member",
					memberPass: VALID_PASS,
				},
				fixing: true,
				...overrides,
			});

		stage.sync(failed(), "Website");
		const kept = stage.el.querySelector<HTMLIFrameElement>("iframe.is-staging")!;
		const posted = spyFrameMessages(kept);
		sendFromFrame(kept, { type: SITE_DOOR_READY });
		expect(posted[0]?.message).toMatchObject({ type: SITE_DOOR_PASS, pass: VALID_PASS });
		sendFromFrame(kept, { type: SITE_DOOR_SHOWN });
		expect(stage.el.querySelector("iframe.is-shown")).toBe(kept);
		expect(stage.el.querySelector<HTMLElement>(".surface-frame.is-waiting")?.hidden).toBe(true);
		expect(pill.hidden).toBe(false);
		expect(pill.textContent).toBe("Being fixed");
		expect(pill.querySelector(".surface-state.is-running")).not.toBeNull();
		expect(stage.el.textContent).not.toContain("could not be built");
		expect(stage.el.textContent).not.toContain("npm run build");

		stage.sync(failed({ kept: { previewId: PREVIEW_IDS[1], doorActionUrl: null, memberPass: null } }), "Website");
		expect(stage.el.querySelector("iframe.is-shown")).toBe(kept);
		expect(stage.el.querySelector("iframe.is-staging")).toBeNull();
		expect(pill.textContent).toBe("Being fixed");
		expect(remints).toEqual([]);

		stage.sync(failed({ fixing: false }), "Website");
		expect(stage.el.querySelector("iframe.is-shown")).toBe(kept);
		expect(pill.textContent).toBe("The preview could not be built.");
		expect(pill.querySelector(".surface-state.is-failed")).not.toBeNull();

		stage.sync(
			previewFrame({ previewId: PREVIEW_IDS[0], status: "building", doorActionUrl: null, memberPass: null }),
			"Website",
		);
		expect(stage.el.querySelector("iframe.is-shown")).toBe(kept);
		expect(pill.textContent).toBe("Building preview…");

		stage.sync(failed({ kept: null, fixing: false }), "Website");
		expect(stage.el.querySelector("iframe")).toBeNull();
		expect(pill.hidden).toBe(true);
		expect(stage.el.querySelector(".surface-frame.is-waiting .surface-state.is-failed")).not.toBeNull();
		expect(stage.el.querySelector(".surface-frame.is-waiting p")?.textContent).toBe(
			"The preview could not be built.",
		);

		const fresh = new SurfaceDoorStage(controller.signal, {
			onNeedFreshPass: (previewId) => {
				remints.push(previewId);
				return undefined;
			},
		});
		fresh.sync(failed({ kept: { previewId: PREVIEW_IDS[1], doorActionUrl: null, memberPass: null } }), "Website");
		expect(remints).toEqual([PREVIEW_IDS[1]]);
		expect(fresh.el.querySelector<HTMLElement>(".surface-preview-pill")?.hidden).toBe(true);
		controller.abort();
	});

	it("says a failed publish is being fixed under its sentence, and nothing when the field is missing", async () => {
		HTMLDialogElement.prototype.showModal = function () {
			this.open = true;
		};
		HTMLDialogElement.prototype.close = function () {
			this.open = false;
			this.dispatchEvent(new Event("close"));
		};
		const failedPublish = {
			publishStatus: "failed" as const,
			lastPublishError: "PREVIEW_BUILD_FAILED\nlog",
			hasUnpublishedChanges: true,
			unpublishedChangeCount: 1,
		};
		for (const [extra, shown] of [
			[{ publishBeingFixed: true }, true],
			[{ publishBeingFixed: false }, false],
			[{}, false],
		] as const) {
			const store = storeWith(
				fakeClient({
					listSurfaces: vi.fn(async () => [summary({ ...failedPublish, ...extra })]),
					getSurfaceWorkspace: vi.fn(async () =>
						workspace([session(["merged"])], { surface: summary({ ...failedPublish, ...extra }) }),
					),
				}),
			);
			await store.load();
			const sheet = openPublishSheet(store, store.state.surfaces[0]!);
			expect(sheet.el.querySelector(".surface-sheet-error")?.textContent).toBe(
				"The site could not be built, so nothing was published.",
			);
			const note = sheet.el.querySelector(".surface-sheet-lead[role=status]");
			expect(note?.textContent ?? null).toBe(shown ? "Being fixed" : null);
			sheet.close();
			store.dispose();
		}
	});

	it("renders Retry preview button on failed door frames, Failed session badges & Retry action, pending merge toast, and publish errors in the publish window", async () => {
		const controller = new AbortController();
		const onRetry = vi.fn();
		const door = new SurfaceDoorStage(controller.signal, { onRetry });
		document.body.append(door.el);
		door.sync(
			previewFrame({ status: "failed", errorDetail: "Vite build failed", doorActionUrl: null, memberPass: null }),
			"Website",
		);
		const retryBtn = door.el.querySelector<HTMLButtonElement>('[data-act="retry-preview"]')!;
		expect(retryBtn).not.toBeNull();
		expect(retryBtn.hidden).toBe(false);
		retryBtn.click();
		expect(onRetry).toHaveBeenCalledTimes(1);

		door.sync(previewFrame({ status: "building", doorActionUrl: null, memberPass: null }), "Website");
		expect(retryBtn.hidden).toBe(true);
		controller.abort();

		const failedSession = session(["staged"], {
			id: "33333333-3333-4333-8333-333333333341",
			title: "Broken session",
			state: "failed",
			messages: [sessionMessage(MESSAGE_IDS[0], "system", "Session timed out after worker retry. Reply to retry.")],
		});
		const readySession = session(["staged"], {
			id: "33333333-3333-4333-8333-333333333342",
			title: "Normal ready session",
			state: "ready",
		});
		const replySurfaceSession = vi.fn(async () => ({ ...failedSession, state: "queued" as const }));
		const approveSurfaceChange = vi.fn(async () => ({
			...readySession,
			changes: [change(CHANGES[0], 1, "merging")],
		}));
		let currentPublishStatus: "idle" | "publishing" | "failed" = "failed";
		const client = fakeClient({
			listSurfaces: vi.fn(async () => [
				summary({
					publishStatus: currentPublishStatus,
					lastPublishError: currentPublishStatus === "failed" ? "Missing index.html" : null,
					hasUnpublishedChanges: true,
					unpublishedChangeCount: 1,
				}),
			]),
			getSurfaceWorkspace: vi.fn(async () =>
				workspace([readySession, failedSession], {
					surface: summary({
						publishStatus: currentPublishStatus,
						lastPublishError: currentPublishStatus === "failed" ? "Missing index.html" : null,
						hasUnpublishedChanges: true,
						unpublishedChangeCount: 1,
					}),
					recentHistory: [session(["merged"], { state: "completed" })],
				}),
			),
			replySurfaceSession,
			approveSurfaceChange,
			publishSurface: vi.fn(async () => {
				currentPublishStatus = "publishing";
				return summary({ publishStatus: "publishing", hasUnpublishedChanges: true, unpublishedChangeCount: 1 });
			}),
		});
		const store = storeWith(client);
		await store.load();
		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "website");
		document.body.append(view.el);
		await flush();
		view.update();

		expect(view.el.querySelector(".surface-bar")?.textContent).not.toContain("Failed");

		const cards = [...view.el.querySelectorAll<HTMLElement>(".surface-overview-card.is-agent")];
		expect(cards[0]?.dataset.session).toBe(failedSession.id);
		expect(cards[0]?.classList.contains("is-failed")).toBe(true);
		const retrySessionBtn = cards[0]!.querySelector<HTMLButtonElement>('[data-act="retry-session"]')!;
		expect(retrySessionBtn).not.toBeNull();
		retrySessionBtn.click();
		await flush();
		expect(replySurfaceSession).toHaveBeenCalledWith(failedSession.id, expect.any(String));

		await store.approveChange(readySession.id, CHANGES[0]);
		view.update();
		const pendingToast = view.el.querySelector(".surface-toast.is-pending");
		expect(pendingToast).not.toBeNull();
		expect(pendingToast?.textContent).toContain("Merging");
		expect(pendingToast?.querySelector('[data-act="undo"]')).toBeNull();

		HTMLDialogElement.prototype.showModal = function () {
			this.open = true;
		};
		HTMLDialogElement.prototype.close = function () {
			this.open = false;
			this.dispatchEvent(new Event("close"));
		};
		const sheet = openPublishSheet(store, store.state.surfaces[0]!);
		expect(sheet.el.querySelector(".surface-sheet-error")?.textContent).toBe("Missing index.html");
		sheet.el.querySelector<HTMLButtonElement>('[data-act="confirm-publish"]')!.click();
		await flush();
		expect(sheet.el.open).toBe(true);
		expect(sheet.el.querySelector('[data-act="confirm-publish"]')?.textContent).toBe("Publishing…");

		currentPublishStatus = "idle";
		await store.refreshWorkspace(SURFACE);
		expect(sheet.el.open).toBe(false);

		view.dispose();
		store.dispose();
	});

	it("discards one change from its overview card on a second press, keeping the button's size", async () => {
		const ready = session(["staged", "staged"], { id: "33333333-3333-4333-8333-333333333351", title: "Ready" });
		const waiting = session(["staged"], {
			id: "33333333-3333-4333-8333-333333333352",
			title: "Waiting",
			state: "needs_input",
			question: { text: "Which one?", options: [] },
			changes: [change(CHANGES[2], 1, "staged")],
			openChangeCount: 1,
		});
		const working = session(["staged"], {
			id: "33333333-3333-4333-8333-333333333353",
			title: "Working",
			state: "running",
		});
		const discardSurfaceChange = vi.fn(async (changeId: string) =>
			changeId === CHANGES[0]
				? {
						...ready,
						changes: [change(CHANGES[0], 1, "discarded"), change(CHANGES[1], 2, "staged")],
						openChangeCount: 1,
					}
				: { ...waiting, changes: [change(CHANGES[2], 1, "discarded")], openChangeCount: 0 },
		);
		const client = fakeClient({
			getSurfaceWorkspace: vi.fn(async () => workspace([ready, waiting, working])),
			discardSurfaceChange,
		});
		const store = storeWith(client);
		await store.load();
		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "website");
		document.body.append(view.el);
		await flush();
		view.update();

		const card = (id: string) =>
			view.el.querySelector<HTMLElement>(`.surface-overview-card.is-agent[data-session="${id}"]`)!;
		const discardOf = (id: string, changeId: string) =>
			card(id).querySelector<HTMLElement>(`[data-act="discard-change-armed"][data-change="${changeId}"]`);
		expect(discardOf(working.id, CHANGES[0])).toBeNull();
		expect(discardOf(waiting.id, CHANGES[2])).not.toBeNull();

		const first = discardOf(ready.id, CHANGES[0])!;
		expect(first.textContent).toBe("Discard");
		expect(first.querySelector(".surface-approve-face.is-ghost")?.getAttribute("data-text")).toBe("Confirm");
		first.click();
		const armed = discardOf(ready.id, CHANGES[0])!;
		expect(armed.classList.contains("is-confirming")).toBe(true);
		expect(armed.dataset.armed).toBe("true");
		expect(armed.textContent).toBe("Confirm");
		expect(armed.querySelector(".surface-approve-face.is-ghost")?.getAttribute("data-text")).toBe("Discard");
		expect(discardOf(ready.id, CHANGES[1])!.classList.contains("is-confirming")).toBe(false);
		expect(discardSurfaceChange).not.toHaveBeenCalled();

		armed.click();
		await flush();
		await flush();
		expect(discardSurfaceChange).toHaveBeenCalledWith(CHANGES[0]);
		view.update();
		expect(discardOf(ready.id, CHANGES[0])).toBeNull();
		expect(discardOf(ready.id, CHANGES[1])?.classList.contains("is-confirming")).toBe(false);

		discardOf(waiting.id, CHANGES[2])!.click();
		discardOf(waiting.id, CHANGES[2])!.click();
		await flush();
		await flush();
		view.update();
		expect(store.workspace(SURFACE)?.activeSessions.map((item) => item.id)).toContain(waiting.id);
		expect(card(waiting.id)?.querySelector(".surface-question")?.textContent).toContain("Which one?");
		expect(discardSurfaceChange).toHaveBeenLastCalledWith(CHANGES[2]);
		expect(discardOf(waiting.id, CHANGES[2])).toBeNull();
		view.dispose();
		store.dispose();
	});

	it("enters with a page loading screen, defers heavy mounting until after first paint, and cancels mounts when switched away", async () => {
		const brand = summary({
			id: "22222222-2222-4222-8222-222222222241",
			slug: "brand",
			title: "Brand",
			archetype: "studio",
			siteSlug: null,
			liveUrl: null,
		});
		const inbox = summary({
			id: "22222222-2222-4222-8222-222222222242",
			slug: "inbox",
			title: "Inbox",
			group: "operations",
			archetype: "ops",
			icon: "mail",
			sourceKind: "native_ops",
			previewMode: "none",
			siteSlug: null,
			liveUrl: null,
		});
		const store = storeWith(
			fakeClient({
				listSurfaces: vi.fn(async () => [summary(), brand, inbox]),
				getSurfaceWorkspace: vi.fn(async (id: string) =>
					workspace([], { surface: id === brand.id ? brand : id === inbox.id ? inbox : summary() }),
				),
			}),
		);
		await store.load();

		const skippedMount = vi.fn(() => ({ el: document.createElement("div"), update: vi.fn(), dispose: vi.fn() }));
		const skippedView = new SurfaceView({ store, mount: skippedMount, openMigration: () => undefined }, "website");
		document.body.append(skippedView.el);
		skippedView.update();
		const skippedLoading = skippedView.el.querySelector<HTMLElement>(".surface-loading")!;
		expect(skippedLoading.hidden).toBe(false);
		expect(skippedLoading.querySelector(".skeleton-surface-live")).not.toBeNull();
		expect(skippedView.el.querySelector<HTMLElement>(".surface-mount")?.hidden).toBe(true);
		expect(skippedMount).not.toHaveBeenCalled();

		skippedView.dispose();
		await flush();
		expect(skippedMount).not.toHaveBeenCalled();

		const opsEl = document.createElement("div");
		opsEl.className = "ops-loaded";
		const opsMount = vi.fn(() => ({ el: opsEl, update: vi.fn(), dispose: vi.fn() }));
		const opsView = new SurfaceView({ store, mount: opsMount, openMigration: () => undefined }, "inbox");
		document.body.append(opsView.el);
		opsView.update();
		expect(opsView.el.querySelector<HTMLElement>(".surface-loading")?.hidden).toBe(false);
		expect(opsView.el.querySelector(".skeleton-surface-ops")).not.toBeNull();
		expect(opsMount).not.toHaveBeenCalled();

		await flush();
		expect(opsMount).toHaveBeenCalledTimes(1);
		expect(opsView.el.querySelector<HTMLElement>(".surface-loading")?.hidden).toBe(true);
		expect(opsView.el.querySelector<HTMLElement>(".surface-mount")?.hidden).toBe(false);
		expect(opsView.el.querySelector(".surface-mount .ops-loaded")).toBe(opsEl);
		opsView.dispose();

		const studioView = new SurfaceView(
			{
				store,
				mount: () => undefined,
				openMigration: () => undefined,
				loadStudioFiles: async () => ({ "brand/voice.md": "Calm.\n" }),
			},
			"brand",
		);
		document.body.append(studioView.el);
		studioView.update();
		expect(studioView.el.querySelector(".skeleton-surface-studio")).not.toBeNull();
		expect(studioView.el.querySelector(".surface-studio")).toBeNull();
		await flush();
		expect(studioView.el.querySelector<HTMLElement>(".surface-loading")?.hidden).toBe(true);
		expect(studioView.el.querySelector(".surface-studio")).not.toBeNull();
		studioView.dispose();
		store.dispose();
	});

	it("holds the loading screen while a preview workspace or mount dependency loads and avoids mounting live views behind Preview", async () => {
		const pendingWorkspace = deferred<ReturnType<typeof workspace>>();
		const site = summary({ activeSessionCount: 1, pendingChangeCount: 1 });
		const store = storeWith(
			fakeClient({
				listSurfaces: vi.fn(async () => [site]),
				getSurfaceWorkspace: vi.fn(() => pendingWorkspace.promise),
			}),
		);
		await store.load();

		const mountEl = document.createElement("div");
		mountEl.className = "live-site-mount";
		let mountLoading = true;
		const mount = vi.fn(() => ({ el: mountEl, update: vi.fn(), dispose: vi.fn() }));
		const view = new SurfaceView(
			{
				store,
				mount,
				isMountLoading: () => mountLoading,
				openMigration: () => undefined,
			},
			"website",
		);
		document.body.append(view.el);
		await flush();
		view.update();
		expect(view.el.querySelector<HTMLElement>(".surface-loading")?.hidden).toBe(false);
		expect(view.el.querySelector(".surface-empty")).toBeNull();
		expect(mount).not.toHaveBeenCalled();

		pendingWorkspace.resolve(
			workspace([session(["staged"])], {
				surface: site,
				previewState: {
					surfaceId: SURFACE,
					mode: "single",
					primary: previewFrame({
						previewId: PREVIEW_IDS[0],
						doorActionUrl: "https://thetaband--p1111aaaa.qorpera.com/__qorpera/member",
						memberPass: VALID_PASS,
					}),
					compareFrames: [],
				},
			}),
		);
		await flush();
		view.update();
		expect(view.el.querySelector<HTMLElement>(".surface-loading")?.hidden).toBe(true);
		expect(view.el.querySelector<HTMLElement>(".surface-frames")?.hidden).toBe(false);
		expect(view.el.querySelector<HTMLElement>(".surface-mount")?.hidden).toBe(true);
		expect(mount).not.toHaveBeenCalled();

		store.setMode("live");
		view.update();
		expect(view.el.querySelector<HTMLElement>(".surface-loading")?.hidden).toBe(false);
		expect(mount).not.toHaveBeenCalled();

		mountLoading = false;
		view.update();
		expect(view.el.querySelector<HTMLElement>(".surface-loading")?.hidden).toBe(true);
		expect(mount).toHaveBeenCalledTimes(1);
		expect(view.el.querySelector(".surface-mount .live-site-mount")).toBe(mountEl);

		view.dispose();
		store.dispose();
	});

	it("keeps SurfaceRail row elements and tiles in place when switching the active surface", async () => {
		const brand = summary({
			id: "22222222-2222-4222-8222-222222222243",
			slug: "brand",
			title: "Brand",
			archetype: "studio",
			siteSlug: null,
			liveUrl: null,
		});
		const store = storeWith(
			fakeClient({
				listSurfaces: vi.fn(async () => [summary(), brand]),
				getSurfaceWorkspace: vi.fn(async (id: string) =>
					workspace([], { surface: id === brand.id ? brand : summary() }),
				),
			}),
		);
		await store.load();
		const rail = new SurfaceRail(store, COMPANY, new AbortController().signal);
		document.body.append(rail.el);
		rail.update("website");

		const websiteRow = rail.el.querySelector<HTMLAnchorElement>('.rail-surface[data-surface-slug="website"]')!;
		const brandRow = rail.el.querySelector<HTMLAnchorElement>('.rail-surface[data-surface-slug="brand"]')!;
		const websiteTile = websiteRow.querySelector(".surface-tile")!;
		const brandTile = brandRow.querySelector(".surface-tile")!;
		expect(websiteRow.classList.contains("active")).toBe(true);
		expect(websiteRow.getAttribute("aria-current")).toBe("page");
		expect(brandRow.classList.contains("active")).toBe(false);

		rail.update("brand");
		expect(rail.el.querySelector('.rail-surface[data-surface-slug="website"]')).toBe(websiteRow);
		expect(rail.el.querySelector('.rail-surface[data-surface-slug="brand"]')).toBe(brandRow);
		expect(websiteRow.querySelector(".surface-tile")).toBe(websiteTile);
		expect(brandRow.querySelector(".surface-tile")).toBe(brandTile);
		expect(websiteRow.classList.contains("active")).toBe(false);
		expect(websiteRow.getAttribute("aria-current")).toBeNull();
		expect(brandRow.classList.contains("active")).toBe(true);
		expect(brandRow.getAttribute("aria-current")).toBe("page");

		await store.openSurface("brand");
		rail.update("brand");
		expect(rail.el.querySelector('.rail-surface[data-surface-slug="website"]')).toBe(websiteRow);
		expect(rail.el.querySelector('.rail-surface[data-surface-slug="brand"]')).toBe(brandRow);
		expect(websiteRow.querySelector(".surface-tile")).toBe(websiteTile);
		expect(brandRow.querySelector(".surface-tile")).toBe(brandTile);
		store.dispose();
	});

	it("deactivates an outgoing SurfaceView immediately while keeping heavy mount disposal deferred until dispose()", async () => {
		const inbox = summary({
			id: "22222222-2222-4222-8222-222222222244",
			slug: "inbox",
			title: "Inbox",
			archetype: "ops",
			icon: "mail",
			siteSlug: null,
			liveUrl: null,
		});
		const store = storeWith(
			fakeClient({
				listSurfaces: vi.fn(async () => [inbox]),
				getSurfaceWorkspace: vi.fn(async () =>
					workspace([session(["staged"], { surfaceId: inbox.id })], { surface: inbox }),
				),
			}),
		);
		await store.load();

		const clearActiveSpy = vi.spyOn(store, "clearActiveSurface");
		const mountEl = document.createElement("div");
		const mountDeactivate = vi.fn();
		const mountDispose = vi.fn();
		const mountUpdate = vi.fn();
		const view = new SurfaceView(
			{
				store,
				mount: () => ({ el: mountEl, update: mountUpdate, deactivate: mountDeactivate, dispose: mountDispose }),
				openMigration: () => undefined,
			},
			"inbox",
		);
		document.body.append(view.el);
		await flush();
		view.update();
		store.openDrawer(inbox.id, SESSION);
		expect(store.state.drawer?.surfaceId).toBe(inbox.id);

		const updatesBefore = mountUpdate.mock.calls.length;
		view.deactivate();
		expect(mountDeactivate).toHaveBeenCalledTimes(1);
		expect(mountDispose).not.toHaveBeenCalled();
		expect(clearActiveSpy).toHaveBeenCalledWith(inbox.id);
		expect(store.state.drawer).toBeUndefined();

		view.update();
		expect(mountUpdate).toHaveBeenCalledTimes(updatesBefore);

		view.dispose();
		view.dispose();
		expect(mountDispose).toHaveBeenCalledTimes(1);
		store.dispose();
	});

	it("disposes a live_build mount when switching away from Live mode to Preview", async () => {
		const liveSurface = summary({
			activeSessionCount: 1,
			pendingChangeCount: 1,
		});
		const store = storeWith(
			fakeClient({
				listSurfaces: vi.fn(async () => [liveSurface]),
				getSurfaceWorkspace: vi.fn(async () =>
					workspace([session(["staged"])], {
						surface: liveSurface,
						previewState: {
							surfaceId: liveSurface.id,
							mode: "single",
							primary: previewFrame(),
							compareFrames: [],
						},
					}),
				),
			}),
		);
		await store.load();
		const mountDispose = vi.fn();
		const mountCreate = vi.fn(() => ({
			el: document.createElement("div"),
			update: vi.fn(),
			dispose: mountDispose,
		}));
		const view = new SurfaceView(
			{
				store,
				mount: mountCreate,
				openMigration: () => undefined,
			},
			liveSurface.slug,
		);
		document.body.append(view.el);
		await flush();
		store.setMode("live");
		view.update();
		expect(mountCreate).toHaveBeenCalledTimes(1);
		expect(mountDispose).not.toHaveBeenCalled();

		store.setMode("preview");
		view.update();
		expect(mountDispose).toHaveBeenCalledTimes(1);
		view.dispose();
		store.dispose();
	});

	it("shows per-change deliverable pills in the sidepanel, deduplicates session Notes, and opens staged articles and HTML pages directly", async () => {
		const studio = summary({
			id: "22222222-2222-4222-8222-222222222261",
			slug: "marketing",
			title: "Marketing",
			archetype: "studio",
			kind: "custom",
			sourceKind: "folder",
			repositoryKey: null,
			folderRoot: "surfaces/marketing",
			siteSlug: null,
			liveUrl: null,
			activeSessionCount: 1,
			pendingChangeCount: 2,
		});
		const c1 = change(CHANGES[0], 1, "staged", {
			surfaceId: studio.id,
			sessionId: SESSION,
			title: "Q3 retention report",
			summary: "Adds cohort metrics and recommendations.",
			kind: "folder_patch",
			affectedPaths: ["reports/q3.report.json"],
			patchManifest: [
				{
					op: "write_text",
					path: "reports/q3.report.json",
					content: JSON.stringify({
						slug: "q3-retention",
						headline: "Q3 Retention Report",
						readingTime: "3 min",
						sections: [{ id: "s1", heading: "Highlights", paragraphs: ["Retention climbed."] }],
					}),
				},
			],
		});
		const c2 = change(CHANGES[1], 2, "staged", {
			surfaceId: studio.id,
			sessionId: SESSION,
			title: "Launch blog post",
			summary: "Standalone HTML post for the launch.",
			kind: "folder_patch",
			affectedPaths: ["posts/launch.html"],
			patchManifest: [
				{
					op: "write_text",
					path: "posts/launch.html",
					content:
						"<!doctype html><html><head><title>Launch Post</title></head><body><h1>Launch</h1></body></html>",
				},
			],
		});
		const sess = session([], {
			id: SESSION,
			surfaceId: studio.id,
			title: "Content writer",
			changes: [c1, c2],
			openChangeCount: 2,
		});
		const store = storeWith(
			fakeClient({
				listSurfaces: vi.fn(async () => [studio]),
				getSurfaceWorkspace: vi.fn(async () => workspace([sess], { surface: studio })),
			}),
			{ loadCloudFiles: vi.fn(async () => folderContents({})) },
		);
		await store.load();
		const view = new SurfaceView(
			{
				store,
				mount: () => ({ el: document.createElement("div"), update: vi.fn(), dispose: vi.fn() }),
				openMigration: () => undefined,
			},
			studio.slug,
		);
		document.body.append(view.el);
		await flush();
		view.update();

		const drawer = view.el.querySelector<HTMLElement>(".surface-drawer")!;
		expect(drawer.querySelectorAll(".surface-agent-note")).toHaveLength(0);
		const overviewPills = [...drawer.querySelectorAll<HTMLButtonElement>(".surface-overview-deliverable")];
		expect(overviewPills).toHaveLength(2);
		expect(overviewPills.map((pill) => pill.textContent)).toEqual(["Article", "HTML"]);

		await store.toggleChange(studio.id, c1.id);
		view.update();
		expect(store.isChangeShown(c1.id)).toBe(false);

		drawer.querySelectorAll<HTMLButtonElement>(".surface-overview-deliverable")[0]!.click();
		await flush();
		view.update();
		expect(store.isChangeShown(c1.id)).toBe(true);
		expect(store.state.mode).toBe("report");
		expect(store.state.activeReportSlug).toBe("q3-retention");
		expect(view.el.querySelector<HTMLElement>(".surface-report-slot")?.hidden).toBe(false);
		expect(view.el.querySelector(".report-headline")?.textContent).toBe("Q3 Retention Report");

		drawer.querySelector<HTMLButtonElement>('[data-act="focus-session"]')!.click();
		view.update();
		expect(drawer.querySelectorAll(".surface-agent-note")).toHaveLength(0);
		drawer.querySelector<HTMLButtonElement>(".surface-changes-toggle")!.click();
		expect(drawer.querySelectorAll(".surface-drawer-change-summary")).toHaveLength(0);
		const openRow = (index: number): void =>
			drawer.querySelectorAll<HTMLButtonElement>('[data-act="open-change"]')[index]!.click();
		openRow(0);
		const firstSummary = drawer.querySelector(".surface-drawer-change-summary")?.textContent;
		const firstDeliverables = [...drawer.querySelectorAll<HTMLButtonElement>(".surface-drawer-deliverable")];
		expect(firstDeliverables).toHaveLength(1);
		expect(firstDeliverables[0]!.textContent).toContain("Q3 Retention Report");
		expect(firstDeliverables[0]!.classList.contains("is-open")).toBe(true);
		openRow(1);
		expect([firstSummary, drawer.querySelector(".surface-drawer-change-summary")?.textContent]).toEqual([
			"Adds cohort metrics and recommendations.",
			"Standalone HTML post for the launch.",
		]);
		const secondDeliverables = [...drawer.querySelectorAll<HTMLButtonElement>(".surface-drawer-deliverable")];
		expect(secondDeliverables).toHaveLength(1);
		secondDeliverables[0]!.click();
		await flush();
		view.update();
		expect(store.state.activeReportSlug).toBe("doc:surfaces/marketing/posts/launch.html");
		expect(view.el.querySelector(".report-html-card h2")?.textContent).toBe("Launch Post");

		view.dispose();
		store.dispose();
	});

	it("opens a staged PDF deliverable from its sidepanel PDF pill and compares it against Base", async () => {
		const studio = summary({
			id: "22222222-2222-4222-8222-222222222262",
			slug: "marketing",
			title: "Marketing",
			archetype: "studio",
			kind: "custom",
			icon: "star",
			sourceKind: "folder",
			repositoryKey: null,
			folderRoot: "surfaces/marketing",
			siteSlug: null,
			liveUrl: null,
			activeSessionCount: 1,
			pendingChangeCount: 1,
		});
		const pdfRef = {
			manifestSha256: "a".repeat(64),
			fileSha256: "b".repeat(64),
			bytes: 3072,
			mediaType: "application/pdf",
		};
		const pdfChange = change(CHANGES[0], 1, "staged", {
			surfaceId: studio.id,
			sessionId: SESSION,
			title: "Investor Q3 deck",
			summary: "Attached board summary PDF.",
			kind: "folder_patch",
			affectedPaths: ["reports/q3-deck.pdf"],
			patchManifest: [{ op: "write_file", path: "reports/q3-deck.pdf", file: pdfRef }],
		});
		const sess = session([], {
			id: SESSION,
			surfaceId: studio.id,
			title: "Analyst",
			changes: [pdfChange],
			openChangeCount: 1,
		});
		const createObjectURL = vi.fn(() => "blob:q3-deck");
		const revokeObjectURL = vi.fn();
		Object.assign(URL, { createObjectURL, revokeObjectURL });
		try {
			const store = storeWith(
				fakeClient({
					listSurfaces: vi.fn(async () => [studio]),
					getSurfaceWorkspace: vi.fn(async () => workspace([sess], { surface: studio })),
				}),
				{
					loadCloudFiles: vi.fn(async () => folderContents({})),
					readCloudBinary: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
				},
			);
			await store.load();
			const view = new SurfaceView(
				{
					store,
					mount: () => ({ el: document.createElement("div"), update: vi.fn(), dispose: vi.fn() }),
					openMigration: () => undefined,
				},
				studio.slug,
			);
			document.body.append(view.el);
			await flush();
			view.update();

			const pill = view.el.querySelector<HTMLButtonElement>(".surface-overview-deliverable")!;
			expect(pill.textContent).toBe("PDF");
			pill.click();
			await flush();
			view.update();

			expect(store.state.mode).toBe("report");
			expect(store.state.activeReportSlug).toBe("doc:surfaces/marketing/reports/q3-deck.pdf");
			const card = view.el.querySelector<HTMLElement>(
				'.studio-pdf-card[data-file="surfaces/marketing/reports/q3-deck.pdf"]',
			)!;
			expect(card).not.toBeNull();
			await vi.waitFor(() =>
				expect(card.querySelector("iframe.studio-pdf-frame")?.getAttribute("src")).toBe("./pdf-preview/"),
			);
			expect(card.querySelector('a[download="q3-deck.pdf"]')?.getAttribute("href")).toBe("blob:q3-deck");
			expect(view.el.querySelector(".surface-overview-deliverable")?.classList.contains("is-open")).toBe(true);

			const dedicated = new SurfaceReportView({
				store,
				surface: studio,
				signal: new AbortController().signal,
				baseFiles: {},
				timeSlice: false,
			});
			store.setMode("compare");
			dedicated.update();
			expect(dedicated.el.querySelector(".studio-compare-card")?.textContent).toContain("Q3 deck");
			expect(dedicated.el.querySelector(".studio-compare-card")?.textContent).toContain("Added");
			dedicated.dispose();

			view.dispose();
			await vi.waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:q3-deck"));
			store.dispose();
		} finally {
			Reflect.deleteProperty(URL, "createObjectURL");
			Reflect.deleteProperty(URL, "revokeObjectURL");
		}
	});

	it("keeps Markdown fallback items alongside PDFs unless structured reports or HTML exist", async () => {
		const reportSurface = summary({
			id: "22222222-2222-4222-8222-222222222263",
			slug: "research",
			title: "Research",
			archetype: "studio",
			kind: "report",
			icon: "doc",
			sourceKind: "folder",
			repositoryKey: null,
			folderRoot: "surfaces/research",
			siteSlug: null,
			liveUrl: null,
			activeSessionCount: 1,
			pendingChangeCount: 1,
		});
		const basePdfRef = {
			manifestSha256: "c".repeat(64),
			fileSha256: "d".repeat(64),
			bytes: 2048,
			mediaType: "application/pdf",
		};
		const stagedPdfRef = {
			manifestSha256: "e".repeat(64),
			fileSha256: "f".repeat(64),
			bytes: 3072,
			mediaType: "application/pdf",
		};
		const mdAndPdfChange = change(CHANGES[0], 1, "staged", {
			surfaceId: reportSurface.id,
			sessionId: SESSION,
			title: "Notes and appendix",
			summary: "Updates memo and attaches appendix PDF.",
			kind: "folder_patch",
			affectedPaths: ["notes/memo.md", "appendix.pdf"],
			patchManifest: [
				{ op: "write_text", path: "notes/memo.md", content: "# Field Memo\n\nKey findings." },
				{ op: "write_file", path: "appendix.pdf", file: stagedPdfRef },
			],
		});
		const sess = session([], {
			id: SESSION,
			surfaceId: reportSurface.id,
			title: "Analyst",
			changes: [mdAndPdfChange],
			openChangeCount: 1,
		});
		const createObjectURL = vi.fn(() => "blob:appendix");
		const revokeObjectURL = vi.fn();
		Object.assign(URL, { createObjectURL, revokeObjectURL });
		try {
			const store = storeWith(
				fakeClient({
					listSurfaces: vi.fn(async () => [reportSurface]),
					getSurfaceWorkspace: vi.fn(async () => workspace([sess], { surface: reportSurface })),
				}),
				{
					loadCloudFiles: vi.fn(async () =>
						folderContents(
							{ "surfaces/research/notes/memo.md": "# Field Memo\n\nOld findings." },
							{ "surfaces/research/appendix.pdf": basePdfRef },
						),
					),
					readCloudBinary: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
				},
			);
			await store.load();
			await store.openSurface(reportSurface.slug);
			const reportView = new SurfaceReportView({
				store,
				surface: reportSurface,
				signal: new AbortController().signal,
				baseFiles: { "surfaces/research/notes/memo.md": "# Field Memo\n\nOld findings." },
				timeSlice: false,
			});
			reportView.update();
			const switcherLabels = [...reportView.el.querySelectorAll(".report-switcher button")].map((b) =>
				b.textContent?.trim(),
			);
			expect(switcherLabels).toEqual(["Field Memo", "Appendix"]);

			store.setMode("compare");
			reportView.update();
			const compareCards = [...reportView.el.querySelectorAll(".studio-compare-card")].map(
				(c) => c.textContent ?? "",
			);
			expect(compareCards).toHaveLength(2);
			expect(compareCards.some((text) => text.includes("Appendix"))).toBe(true);
			expect(compareCards.some((text) => text.includes("Field Memo"))).toBe(true);
			reportView.dispose();
			store.dispose();

			const structuredStore = storeWith(
				fakeClient({
					listSurfaces: vi.fn(async () => [reportSurface]),
					getSurfaceWorkspace: vi.fn(async () => workspace([], { surface: reportSurface })),
				}),
				{
					loadCloudFiles: vi.fn(async () =>
						folderContents(
							{
								"surfaces/research/notes/memo.md": "# Scratchpad",
								"surfaces/research/reports/q4.report.json": JSON.stringify({
									headline: "Q4 Outlook",
									sections: [{ heading: "Summary", body: "Growth holds steady." }],
								}),
							},
							{ "surfaces/research/appendix.pdf": basePdfRef },
						),
					),
					readCloudBinary: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
				},
			);
			await structuredStore.load();
			await structuredStore.openSurface(reportSurface.slug);
			const structuredView = new SurfaceReportView({
				store: structuredStore,
				surface: reportSurface,
				signal: new AbortController().signal,
				baseFiles: {
					"surfaces/research/notes/memo.md": "# Scratchpad",
					"surfaces/research/reports/q4.report.json": JSON.stringify({
						headline: "Q4 Outlook",
						sections: [{ heading: "Summary", body: "Growth holds steady." }],
					}),
				},
				timeSlice: false,
			});
			structuredView.update();
			const structuredLabels = [...structuredView.el.querySelectorAll(".report-switcher button")].map((b) =>
				b.textContent?.trim(),
			);
			expect(structuredLabels).toEqual(["Q4 Outlook", "Appendix"]);
			structuredView.dispose();
			structuredStore.dispose();
		} finally {
			Reflect.deleteProperty(URL, "createObjectURL");
			Reflect.deleteProperty(URL, "revokeObjectURL");
		}
	});
});

describe("removing an agent from the Changes list", () => {
	afterEach(async () => {
		openMenu()?.close();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

	it("removes a finished routine at once and asks first for one that is working on a change", async () => {
		const routine = session([], {
			id: "33333333-3333-4333-8333-333333333351",
			title: "Co-Founder Pulse",
			state: "ready",
		});
		const working = session(["staged"], {
			id: "33333333-3333-4333-8333-333333333352",
			title: "Add the wordmark",
			state: "running",
		});
		const kept = session(["staged"], {
			id: "33333333-3333-4333-8333-333333333353",
			title: "Kept proposal",
			state: "ready",
		});
		let active = [routine, working, kept];
		const discardSurfaceSession = vi.fn(async (sessionId: string) => {
			const ended = active.find((item) => item.id === sessionId)!;
			active = active.filter((item) => item.id !== sessionId);
			return {
				...ended,
				state: "discarded" as const,
				changes: ended.changes.map((item) => ({ ...item, status: "discarded" as const })),
			};
		});
		const store = storeWith(
			fakeClient({
				listSurfaces: vi.fn(async () => [summary()]),
				getSurfaceWorkspace: vi.fn(async () => workspace(active)),
				discardSurfaceSession,
			}),
		);
		await store.load();
		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "website");
		document.body.append(view.el);
		await flush();
		view.update();

		const card = (id: string) =>
			view.el.querySelector<HTMLElement>(`.surface-overview-card.is-agent[data-session="${id}"]`);
		const chooseRemove = async (id: string) => {
			card(id)!.dispatchEvent(
				new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }),
			);
			const row = [...document.querySelectorAll<HTMLElement>(".context-menu-item")].find(
				(item) => item.textContent?.trim() === "Remove",
			)!;
			expect(row.classList.contains("danger")).toBe(true);
			row.click();
			await flush();
		};
		const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
		const dialogButton = (label: string) =>
			[...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label)!;

		await chooseRemove(routine.id);
		expect(dialog()).toBeNull();
		expect(discardSurfaceSession).toHaveBeenCalledWith(routine.id);
		view.update();
		expect(card(routine.id)).toBeNull();

		await chooseRemove(working.id);
		expect(dialog()?.querySelector("p")?.textContent).toBe(
			"Remove Add the wordmark? The agent stops and its unapproved changes are dropped.",
		);
		dialogButton("Cancel").click();
		await flush();
		expect(discardSurfaceSession).toHaveBeenCalledTimes(1);
		expect(card(working.id)).not.toBeNull();

		await chooseRemove(working.id);
		expect(dialogButton("Remove").classList.contains("btn-danger")).toBe(true);
		dialogButton("Remove").click();
		await flush();
		view.update();
		expect(discardSurfaceSession).toHaveBeenLastCalledWith(working.id);
		expect(card(working.id)).toBeNull();
		expect(card(kept.id)).not.toBeNull();
		view.dispose();
		store.dispose();
	});

	it("forwards the targeted changeId when replying via Change (including option groups) and omits it on an exploration variant without a staged change", async () => {
		const explorationId = "88888888-8888-4888-8888-888888888891";
		const emptyVariantId = "33333333-3333-4333-8333-333333333392";
		const optionSessionId = "33333333-3333-4333-8333-333333333393";
		const targetedSession = session(["staged", "staged"], {
			id: SESSION,
			changes: [
				change(CHANGES[0], 1, "staged", { title: "Hero direction" }),
				change(CHANGES[1], 2, "staged", { title: "Pricing section" }),
			],
		});
		const optionSession = session(["staged", "staged"], {
			id: optionSessionId,
			changes: [
				change(CHANGES[0], 1, "staged", {
					title: "Stille ritual",
					optionGroupKey: "homepage-direction",
					optionGroupTitle: "Forside",
				}),
				change(CHANGES[1], 2, "staged", {
					title: "Appen først",
					optionGroupKey: "homepage-direction",
					optionGroupTitle: "Forside",
				}),
			],
		});
		const variantWithChange = session(["staged"], {
			id: "33333333-3333-4333-8333-333333333391",
			explorationId,
			explorationVariantLabel: "Aftenlys",
			changes: [change(CHANGES[0], 1, "staged", { title: "Aftenlys hero" })],
		});
		const variantWithoutChange = session([], {
			id: emptyVariantId,
			explorationId,
			explorationVariantLabel: "Varmt studie",
			changes: [],
		});
		const replySurfaceSession = vi.fn(async (sessionId: string) =>
			sessionId === emptyVariantId
				? variantWithoutChange
				: sessionId === optionSessionId
					? optionSession
					: targetedSession,
		);
		const client = fakeClient({
			getSurfaceWorkspace: vi.fn(async () =>
				workspace([targetedSession, optionSession, variantWithChange, variantWithoutChange], {
					explorations: [
						{
							id: explorationId,
							surfaceId: SURFACE,
							title: "Forsidens udtryk",
							status: "open",
							chosenSessionId: null,
							variantSessionIds: [variantWithChange.id, variantWithoutChange.id],
							createdAt: "2026-11-21T10:00:00.000Z",
							resolvedAt: null,
						},
					],
				}),
			),
			replySurfaceSession,
		});
		const store = storeWith(client);
		await store.load();
		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "website");
		document.body.append(view.el);
		await flush();

		store.openDrawer(SURFACE, SESSION);
		view.update();
		const drawer = view.el.querySelector(".surface-drawer")!;
		drawer.querySelector<HTMLButtonElement>('[data-act="fold-changes"]')!.click();
		view.update();
		drawer.querySelector<HTMLButtonElement>(`[data-act="open-change"][data-change="${CHANGES[1]}"]`)!.click();
		view.update();
		drawer.querySelector<HTMLButtonElement>(`[data-act="quote-change"][data-change="${CHANGES[1]}"]`)!.click();
		view.update();
		const input = drawer.querySelector<HTMLInputElement>(".surface-drawer-input")!;
		input.value = "Gør prisen strammere";
		drawer
			.querySelector<HTMLFormElement>(".surface-drawer-foot")!
			.dispatchEvent(new Event("submit", { cancelable: true }));
		await flush();
		expect(replySurfaceSession).toHaveBeenNthCalledWith(
			1,
			SESSION,
			"Re: [Pricing section]\nGør prisen strammere",
			true,
			undefined,
			CHANGES[1],
		);

		store.openDrawer(SURFACE, optionSessionId);
		view.update();
		drawer
			.querySelector<HTMLButtonElement>(
				`[data-act="quote-change"][data-session="${optionSessionId}"][data-change="${CHANGES[0]}"]`,
			)!
			.click();
		view.update();
		input.value = "Gør overskriften mørkere";
		drawer
			.querySelector<HTMLFormElement>(".surface-drawer-foot")!
			.dispatchEvent(new Event("submit", { cancelable: true }));
		await flush();
		expect(replySurfaceSession).toHaveBeenNthCalledWith(
			2,
			optionSessionId,
			"Re: [Stille ritual]\nGør overskriften mørkere",
			true,
			undefined,
			CHANGES[0],
		);

		store.openExplorationDrawer(SURFACE, explorationId);
		view.update();
		drawer.querySelector<HTMLButtonElement>(`[data-act="pick-variant"][data-session="${emptyVariantId}"]`)!.click();
		await flush();
		view.update();
		const variantQuote = drawer.querySelector<HTMLButtonElement>(
			`[data-act="quote-change"][data-session="${emptyVariantId}"]`,
		)!;
		expect(variantQuote.getAttribute("data-change")).toBeNull();
		variantQuote.click();
		view.update();
		input.value = "Start i en roligere retning";
		drawer
			.querySelector<HTMLFormElement>(".surface-drawer-foot")!
			.dispatchEvent(new Event("submit", { cancelable: true }));
		await flush();
		expect(replySurfaceSession).toHaveBeenNthCalledWith(
			3,
			emptyVariantId,
			"Re: [Varmt studie]\nStart i en roligere retning",
		);
		view.dispose();
		store.dispose();
	});

	it("shows the primary preview door instead of the live mount when mode stayed on report or compare from another surface", async () => {
		const ready = previewFrame({
			previewId: PREVIEW_IDS[0],
			toggledChangeIds: [CHANGES[0], CHANGES[1]],
		});
		const ws = workspace([session(["staged", "staged"])], {
			previewState: { surfaceId: SURFACE, mode: "single", primary: ready, compareFrames: [] },
		});
		const store = storeWith(fakeClient({ getSurfaceWorkspace: vi.fn(async () => ws) }));
		await store.load();
		store.setMode("report");
		const mounted = document.createElement("div");
		mounted.className = "real-site-view";
		const mount = vi.fn(() => ({ el: mounted, update: () => undefined, dispose: () => undefined }));
		const view = new SurfaceView({ store, mount, openMigration: () => undefined }, "website");
		document.body.append(view.el);
		await flush();
		view.update();

		expect(mount).not.toHaveBeenCalled();
		expect(view.el.querySelectorAll("iframe.surface-frame")).toHaveLength(1);
		expect(view.el.querySelector(".surface-notch-label")?.textContent).toBe("Preview");

		store.setMode("compare");
		view.update();
		expect(mount).not.toHaveBeenCalled();
		expect(view.el.querySelectorAll("iframe.surface-frame")).toHaveLength(1);
		view.dispose();
		store.dispose();
	});

	it("holds the loading skeleton instead of flashing the live mount while auto-syncing a live_baseline workspace with staged changes", async () => {
		let resolvePreview!: (value: SurfaceWorkspace["previewState"]) => void;
		const setPreviewSelection = vi.fn(
			() =>
				new Promise<SurfaceWorkspace["previewState"]>((resolve) => {
					resolvePreview = resolve;
				}),
		);
		const store = storeWith(
			fakeClient({
				getSurfaceWorkspace: vi.fn(async () => workspace([session(["staged", "staged"])])),
				setPreviewSelection,
			}),
		);
		await store.load();
		const mounted = document.createElement("div");
		mounted.className = "real-site-view";
		const mount = vi.fn(() => ({ el: mounted, update: () => undefined, dispose: () => undefined }));
		const view = new SurfaceView({ store, mount, openMigration: () => undefined }, "website");
		document.body.append(view.el);
		await flush();
		view.update();

		expect(setPreviewSelection).toHaveBeenCalledTimes(1);
		expect(mount).not.toHaveBeenCalled();
		expect(view.el.querySelector(".skeleton-surface")).not.toBeNull();

		resolvePreview({
			surfaceId: SURFACE,
			mode: "single",
			primary: previewFrame({
				previewId: PREVIEW_IDS[0],
				toggledChangeIds: [CHANGES[0], CHANGES[1]],
			}),
			compareFrames: [],
		});
		await flush();
		view.update();

		expect(mount).not.toHaveBeenCalled();
		expect(view.el.querySelector(".skeleton-surface")).toBeNull();
		expect(view.el.querySelectorAll("iframe.surface-frame")).toHaveLength(1);
		view.dispose();
		store.dispose();
	});
});
