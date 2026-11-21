// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { SurfaceRail } from "../src/app/views/surface-rail.ts";
import { SurfaceView } from "../src/app/views/surface-view.ts";
import { linkHref } from "../src/ui/dom.ts";
import {
	CHANGES,
	COMPANY,
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
	document.body.replaceChildren();
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
});
