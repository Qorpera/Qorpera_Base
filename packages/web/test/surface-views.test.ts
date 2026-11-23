// @vitest-environment jsdom
import {
	SURFACE_INSPECTOR_MODE_MESSAGE,
	SURFACE_INSPECTOR_PICK_MESSAGE,
	type SurfaceAutomationSummary,
	type SurfaceExplorationSet,
} from "@qorpera/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SITE_DOOR_PASS, SITE_DOOR_READY, SITE_DOOR_SHOWN, SITE_DOOR_URL } from "../src/app/views/site-view.ts";
import { SurfaceDoorStage } from "../src/app/views/surface-door.ts";
import { openPublishPatchnotesSheet } from "../src/app/views/surface-publish-sheet.ts";
import { SurfaceRail } from "../src/app/views/surface-rail.ts";
import { SurfaceView } from "../src/app/views/surface-view.ts";
import { openMenu } from "../src/ui/context-menu.ts";
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
	it("lists Building and Running and nests clean session navigation rows under the active surface without rail switches", async () => {
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
		expect(active?.querySelector(".surface-figure")?.getAttribute("data-figure")).toBe("browser");
		const add = rail.el.querySelector(".rail-surface-add");
		expect(add ? linkHref(add) : null).toBe(`#/c/${COMPANY}/new-program`);
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
		const railRow = (rail: SurfaceRail, slug: string) =>
			rail.el.querySelector<HTMLElement>(`.rail-surface[data-surface-slug="${slug}"]`);
		const rightClick = (rail: SurfaceRail, slug: string) =>
			railRow(rail, slug)!.dispatchEvent(
				new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }),
			);
		const menuRow = (label: string) =>
			[...document.querySelectorAll<HTMLElement>(".context-menu-item")].find(
				(item) => item.textContent?.trim() === label,
			);
		const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
		const dialogButton = (label: string) =>
			[...dialog()!.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label)!;
		const dialogLines = () => [...dialog()!.querySelectorAll(".modal-list li")].map((item) => item.textContent);
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

		afterEach(() => {
			openMenu()?.close();
			history.replaceState(null, "", location.pathname);
		});

		it("asks first, deletes on the dialog's Delete, and leaves the deleted surface's page", async () => {
			const archiveSurface = vi.fn(async (id: string) => summary({ id, status: "archived" }));
			const store = storeWith(fakeClient({ listSurfaces: vi.fn(async () => [summary(), inbox]), archiveSurface }));
			await store.load();
			const reportError = vi.fn();
			const rail = new SurfaceRail(store, COMPANY, new AbortController().signal, undefined, reportError);
			document.body.append(rail.el);
			rail.update("website");

			rightClick(rail, "website");
			const remove = menuRow("Delete")!;
			expect(remove.classList.contains("danger")).toBe(true);
			expect(remove.previousElementSibling?.getAttribute("role")).toBe("separator");
			remove.click();
			expect(openMenu()).toBeUndefined();
			expect(dialog()?.querySelector("p")?.textContent).toBe(
				"Delete Website? It is removed for everyone in the company.",
			);
			expect(dialogLines()).toEqual(["Its site stays online. Settings → Sites takes it offline."]);
			dialogButton("Cancel").click();
			await flush();
			expect(dialog()).toBeNull();
			expect(archiveSurface).not.toHaveBeenCalled();
			expect(railRow(rail, "website")).not.toBeNull();

			rightClick(rail, "website");
			menuRow("Delete")!.click();
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
			const shop = summary({
				id: "55555555-5555-4555-8555-555555555577",
				slug: "shop",
				title: "Shop",
				liveUrl: null,
			});
			const store = storeWith(fakeClient({ listSurfaces: vi.fn(async () => [summary(), shop]) }));
			await store.load();
			const rail = new SurfaceRail(store, COMPANY, new AbortController().signal);
			document.body.append(rail.el);
			rail.update("website");

			rightClick(rail, "shop");
			menuRow("Delete")!.click();
			expect(dialog()!.querySelector(".modal-list")).toBeNull();
			dialogButton("Delete").click();
			await flush();
			rail.update("website");
			expect(railRow(rail, "shop")).toBeNull();
			expect(location.hash).toBe("");
			store.dispose();
		});

		it("says what goes with it and what stays, and deletes its scheduled agents, a teammate's new one too, before the surface", async () => {
			const calls: string[] = [];
			const deleteAutomation = vi.fn(async (id: string) => {
				calls.push(`agent ${id}`);
				return true;
			});
			const archiveSurface = vi.fn(async (id: string) => {
				calls.push("surface");
				return summary({ id, status: "archived" });
			});
			const listAutomations = vi.fn(async () => [
				scheduled("a-1", "website"),
				scheduled("a-2", "inbox"),
				scheduled("a-3", null),
			]);
			const store = storeWith(
				fakeClient({
					listSurfaces: vi.fn(async () => [summary({ runningSessionCount: 2 }), inbox]),
					listAutomations,
					deleteAutomation,
					archiveSurface,
				}),
			);
			await store.load();
			listAutomations.mockImplementation(async () => [
				scheduled("a-1", "website"),
				scheduled("a-2", "inbox"),
				scheduled("a-3", null),
				scheduled("a-4", "website"),
			]);
			const rail = new SurfaceRail(store, COMPANY, new AbortController().signal);
			document.body.append(rail.el);
			rail.update("inbox");

			rightClick(rail, "website");
			menuRow("Delete")!.click();
			expect(dialogLines()).toEqual([
				"Its scheduled agent is deleted too.",
				"The 2 sessions working in it run to their end.",
				"Its site stays online. Settings → Sites takes it offline.",
			]);
			dialogButton("Delete").click();
			await flush();
			expect(calls).toEqual(["agent a-1", "agent a-4", "surface"]);
			expect(store.state.automations.map((item) => item.id)).toEqual(["a-2", "a-3"]);
			expect(store.state.surfaces.map((item) => item.slug)).toEqual(["inbox"]);
			store.dispose();
		});

		it("counts several scheduled agents and one working session", async () => {
			const store = storeWith(
				fakeClient({
					listSurfaces: vi.fn(async () => [summary({ runningSessionCount: 1, liveUrl: null })]),
					listAutomations: vi.fn(async () => [scheduled("a-1", "website"), scheduled("a-2", "website")]),
				}),
			);
			await store.load();
			const rail = new SurfaceRail(store, COMPANY, new AbortController().signal);
			document.body.append(rail.el);
			rail.update("website");

			rightClick(rail, "website");
			menuRow("Delete")!.click();
			expect(dialogLines()).toEqual([
				"Its 2 scheduled agents are deleted too.",
				"The session working in it runs to its end.",
			]);
			dialogButton("Cancel").click();
			store.dispose();
		});

		it("keeps the surface when one of its scheduled agents cannot be deleted", async () => {
			const archiveSurface = vi.fn(async (id: string) => summary({ id, status: "archived" }));
			const store = storeWith(
				fakeClient({
					listAutomations: vi.fn(async () => [scheduled("a-1", "website")]),
					deleteAutomation: vi.fn(async () => Promise.reject(new Error("permission denied"))),
					archiveSurface,
				}),
			);
			await store.load();
			const reportError = vi.fn();
			const rail = new SurfaceRail(store, COMPANY, new AbortController().signal, undefined, reportError);
			document.body.append(rail.el);
			rail.update("website");

			rightClick(rail, "website");
			menuRow("Delete")!.click();
			dialogButton("Delete").click();
			await flush();
			rail.update("website");
			expect(archiveSurface).not.toHaveBeenCalled();
			expect(reportError).toHaveBeenCalledWith("Website could not be deleted.");
			expect(railRow(rail, "website")).not.toBeNull();
			expect(store.state.automations.map((item) => item.id)).toEqual(["a-1"]);
			store.dispose();
		});

		it("says so in the rail and keeps the surface when the delete fails", async () => {
			const archiveSurface = vi.fn(async () => Promise.reject(new Error("permission denied")));
			const store = storeWith(fakeClient({ archiveSurface }));
			await store.load();
			const reportError = vi.fn();
			const rail = new SurfaceRail(store, COMPANY, new AbortController().signal, undefined, reportError);
			document.body.append(rail.el);
			rail.update("website");

			rightClick(rail, "website");
			menuRow("Delete")!.click();
			dialogButton("Delete").click();
			await flush();
			rail.update("website");
			expect(reportError).toHaveBeenCalledWith("Website could not be deleted.");
			expect(railRow(rail, "website")).not.toBeNull();
			expect(location.hash).toBe("");
			store.dispose();
		});

		it("offers no Delete on a built-in surface, which nothing can bring back", async () => {
			const store = storeWith(fakeClient({ listSurfaces: vi.fn(async () => [summary(), inbox]) }));
			await store.load();
			const rail = new SurfaceRail(store, COMPANY, new AbortController().signal);
			document.body.append(rail.el);
			rail.update("website");

			rightClick(rail, "inbox");
			expect(menuRow("Figure")).toBeDefined();
			expect(menuRow("Delete")).toBeUndefined();
			expect(openMenu()!.el.querySelector('[role="separator"]')).toBeNull();
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
		expect(view.el.querySelector(".surface-publish .surface-count")?.textContent).toBe("2");
		expect(view.el.querySelector(".surface-mount .real-site-view")).toBe(mounted);
		expect(update).toHaveBeenCalled();
		expect(view.el.querySelector<HTMLTextAreaElement>(".surface-input")?.disabled).toBe(false);

		store.openDrawer(SURFACE, SESSION);
		await flush();
		view.update();
		const drawer = view.el.querySelector(".surface-drawer")!;
		expect(drawer.classList.contains("is-open")).toBe(true);
		const approveBtn = drawer.querySelector<HTMLElement>(`[data-act="approve"][data-change="${CHANGES[2]}"]`)!;
		approveBtn.click();
		const confirmBtn = drawer.querySelector<HTMLElement>(`[data-act="approve"][data-change="${CHANGES[2]}"]`)!;
		expect(confirmBtn.classList.contains("is-confirming")).toBe(true);
		expect(confirmBtn.textContent).toBe("Confirm");
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

		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "website");
		document.body.append(view.el);
		await flush();
		store.openDrawer(SURFACE, SESSION);
		view.update();
		expect(view.el.querySelector(".surface-banner.is-conflict")?.textContent).toContain("src/hero.tsx");
		view.el.querySelector<HTMLButtonElement>('.surface-banner.is-conflict [data-act="reconcile"]')!.click();
		await flush();
		expect(reconcileChanges).toHaveBeenNthCalledWith(1, SURFACE, [CHANGES[0], CHANGES[1]]);

		const drawer = view.el.querySelector(".surface-drawer")!;
		expect(drawer.querySelector(".surface-drawer-change.is-conflicted")?.textContent).toContain("src/hero.tsx");
		drawer.querySelector<HTMLButtonElement>(`[data-act="reconcile"][data-change="${CHANGES[0]}"]`)!.click();
		await flush();
		expect(reconcileChanges).toHaveBeenNthCalledWith(2, SURFACE, [CHANGES[0]]);
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
		expect(inboxView.el.querySelector(".surface-notch, .surface-pill")).toBeNull();
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
		const sheet = openPublishPatchnotesSheet(store, websiteSurface);
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

	it("renders Retry preview button on failed door frames, Failed session badges & Retry action, pending merge toast, and publish errors in patch notes", async () => {
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

		const failedBarBadge = view.el.querySelector(".surface-bar-agent-badge.is-danger");
		expect(failedBarBadge?.textContent).toBe("Failed");

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
		const sheet = openPublishPatchnotesSheet(store, store.state.surfaces[0]!);
		expect(sheet.el.querySelector(".surface-sheet-error")?.textContent).toBe("Missing index.html");
		sheet.el.querySelector<HTMLButtonElement>('[data-act="confirm-publish"]')!.click();
		await flush();
		expect(sheet.el.open).toBe(true);
		expect(sheet.el.querySelector(".surface-sheet-status")?.textContent).toBe("Publishing…");

		currentPublishStatus = "idle";
		await store.refreshWorkspace(SURFACE);
		expect(sheet.el.open).toBe(false);

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
});
