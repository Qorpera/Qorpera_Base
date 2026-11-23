// @vitest-environment jsdom
import type { SurfacePublishAsk, SurfaceSummary } from "@qorpera/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SurfacesClient } from "../src/app/surfaces-store.ts";
import { openPublishPatchnotesSheet } from "../src/app/views/surface-publish-sheet.ts";
import { SurfaceRail } from "../src/app/views/surface-rail.ts";
import { SurfaceView } from "../src/app/views/surface-view.ts";
import { COMPANY, fakeClient, SURFACE, storeWith, summary, workspace } from "./surface-fixtures.ts";

const JONAS = "13490000-0000-4000-8000-00000000000a";
const SOFIE = "13490000-0000-4000-8000-00000000000b";
const MADS = "13490000-0000-4000-8000-00000000000c";
const NAMES: Record<string, string> = { [JONAS]: "Jonas", [SOFIE]: "Sofie Lund", [MADS]: "Mads Holm" };

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function ask(status: SurfacePublishAsk["status"] = "open"): SurfacePublishAsk {
	return {
		askedByUserId: JONAS,
		askedUserId: SOFIE,
		askedAt: "2026-11-23T01:06:00Z",
		changeCount: 1,
		status,
		answeredAt: status === "declined" ? "2026-11-23T01:09:00Z" : null,
	};
}

function site(overrides: Partial<SurfaceSummary> = {}): SurfaceSummary {
	return summary({ unpublishedChangeCount: 1, hasUnpublishedChanges: true, publishAsk: null, ...overrides });
}

async function setUp(
	viewer: string,
	shown: SurfaceSummary,
	client: Partial<SurfacesClient> = {},
	team = [JONAS, SOFIE],
) {
	let current = shown;
	const answer = (next: Partial<SurfaceSummary>) => {
		current = { ...current, ...next };
		return current;
	};
	const calls = {
		askSurfacePublish: vi.fn(async (_surface: string, userId: string) =>
			answer({ publishAsk: { ...ask(), askedUserId: userId } }),
		),
		declineSurfacePublishAsk: vi.fn(async () => answer({ publishAsk: ask("declined") })),
		withdrawSurfacePublishAsk: vi.fn(async () => answer({ publishAsk: null })),
		publishSurface: vi.fn(async () =>
			answer({ publishAsk: null, unpublishedChangeCount: 0, hasUnpublishedChanges: false }),
		),
		...client,
	};
	const store = storeWith(
		fakeClient({
			listSurfaces: vi.fn(async () => [current]),
			getSurfaceWorkspace: vi.fn(async () => workspace([], { surface: current })),
			...calls,
		}),
		{
			userId: viewer,
			memberName: (userId) => NAMES[userId],
			publishers: () => team.map((userId) => ({ userId, name: NAMES[userId]! })),
		},
	);
	await store.load();
	return { store, calls };
}

const sheetText = () => document.querySelector(".surface-publish-sheet")?.textContent ?? "";
const sheetButton = (act: string) =>
	document.querySelector<HTMLButtonElement>(`.surface-publish-sheet [data-act="${act}"]`);

beforeEach(() => {
	HTMLDialogElement.prototype.showModal = function () {
		this.open = true;
	};
	HTMLDialogElement.prototype.close = function () {
		this.open = false;
		this.dispatchEvent(new Event("close"));
	};
});

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("asking a teammate to publish", () => {
	it("offers the one teammate who may publish, asks, and lets the asker take it back", async () => {
		const { store, calls } = await setUp(JONAS, site());
		expect(store.publishTeammates()).toEqual([{ userId: SOFIE, name: "Sofie Lund" }]);
		openPublishPatchnotesSheet(store, site());
		const askButton = sheetButton("ask")!;
		expect(askButton.textContent).toBe("SLAsk Sofie");
		expect(askButton.querySelector(".person-avatar")).not.toBeNull();

		askButton.click();
		await flush();
		expect(calls.askSurfacePublish).toHaveBeenCalledWith(SURFACE, SOFIE);
		expect(sheetText()).toContain("Waiting for Sofie.");
		expect(sheetButton("ask")).toBeNull();

		sheetButton("withdraw-ask")!.click();
		await flush();
		expect(calls.withdrawSurfacePublishAsk).toHaveBeenCalledWith(SURFACE);
		expect(sheetText()).not.toContain("Waiting for Sofie.");
		expect(sheetButton("ask")).not.toBeNull();
		store.dispose();
	});

	it("hides the ask with Auto-publish on, with nothing to publish, and with no teammate who may publish", async () => {
		for (const [shown, team] of [
			[site({ autoPublish: true }), [JONAS, SOFIE]],
			[site({ unpublishedChangeCount: 0, hasUnpublishedChanges: false }), [JONAS, SOFIE]],
			[site(), [JONAS]],
		] as const) {
			const { store } = await setUp(JONAS, shown, {}, [...team]);
			const dialog = openPublishPatchnotesSheet(store, shown);
			expect(sheetButton("ask")).toBeNull();
			expect(sheetButton("ask-menu")).toBeNull();
			dialog.close();
			store.dispose();
		}
	});

	it("shows a teammate's open ask to others without asking over it", async () => {
		const shown = site({ publishAsk: ask() });
		const { store } = await setUp(MADS, shown, {}, [JONAS, SOFIE, MADS]);
		openPublishPatchnotesSheet(store, shown);
		expect(sheetText()).toContain("Jonas asked Sofie to publish.");
		expect(sheetButton("ask-menu")).toBeNull();
		expect(sheetButton("confirm-publish")).not.toBeNull();
		store.dispose();
	});

	it("lets the asker pick one of several teammates by face", async () => {
		const { store, calls } = await setUp(JONAS, site(), {}, [JONAS, SOFIE, MADS]);
		openPublishPatchnotesSheet(store, site());
		expect(document.querySelector(".surface-publish-ask-pick")).toBeNull();
		sheetButton("ask-menu")!.click();
		const people = [...document.querySelectorAll<HTMLElement>(".surface-publish-ask-person")];
		expect(people.map((person) => person.textContent)).toEqual(["SLSofie Lund", "MHMads Holm"]);
		people[1]!.click();
		await flush();
		expect(calls.askSurfacePublish).toHaveBeenCalledWith(SURFACE, MADS);
		expect(document.querySelector(".surface-publish-ask-pick")).toBeNull();
		expect(sheetText()).toContain("Waiting for Mads.");
		store.dispose();
	});

	it("tells the asker in plain words that she said no, and clears it", async () => {
		const shown = site({ publishAsk: ask("declined") });
		const { store, calls } = await setUp(JONAS, shown);
		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "website");
		document.body.append(view.el);
		await flush();
		view.update();
		expect(view.el.querySelector(".surface-publish-main")?.textContent).toBe("SLSofie said no");

		openPublishPatchnotesSheet(store, shown);
		expect(sheetText()).toContain("Sofie said no.");
		expect(sheetButton("ask")).not.toBeNull();
		sheetButton("withdraw-ask")!.click();
		await flush();
		expect(calls.withdrawSurfacePublishAsk).toHaveBeenCalledWith(SURFACE);
		view.update();
		expect(view.el.querySelector(".surface-publish-main")?.textContent).toBe("Publish1");
		view.dispose();
		store.dispose();
	});

	it("shows the asked member yes and no on the Publish control, in front of the preview", async () => {
		const shown = site({ publishAsk: ask() });
		const { store, calls } = await setUp(SOFIE, shown);
		store.setMode("live");
		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "website");
		document.body.append(view.el);
		await flush();
		view.update();
		await flush();
		expect(store.state.mode).toBe("preview");
		const control = view.el.querySelector<HTMLElement>(".surface-publish.is-asked")!;
		expect(control.getAttribute("aria-label")).toBe("Jonas asks you to publish");
		expect(control.querySelector('[data-act="ask-yes"]')).not.toBeNull();

		control.querySelector<HTMLButtonElement>('[data-act="ask-no"]')!.click();
		await flush();
		expect(calls.declineSurfacePublishAsk).toHaveBeenCalledWith(SURFACE);
		view.update();
		expect(view.el.querySelector(".surface-publish.is-asked")).toBeNull();
		view.dispose();
		store.dispose();
	});

	it("publishes as the asked member on yes, through her own Publish", async () => {
		const shown = site({ publishAsk: ask() });
		const { store, calls } = await setUp(SOFIE, shown);
		const view = new SurfaceView({ store, mount: () => undefined, openMigration: () => undefined }, "website");
		document.body.append(view.el);
		await flush();
		view.update();
		view.el.querySelector<HTMLButtonElement>('[data-act="ask-yes"]')!.click();
		await flush();
		expect(calls.publishSurface).toHaveBeenCalledWith(SURFACE);
		expect(calls.declineSurfacePublishAsk).not.toHaveBeenCalled();
		view.dispose();
		store.dispose();
	});

	it("gives the asked member No in the sheet beside her Publish", async () => {
		const shown = site({ publishAsk: ask() });
		const { store, calls } = await setUp(SOFIE, shown);
		const dialog = openPublishPatchnotesSheet(store, shown);
		expect(sheetText()).toContain("Jonas asks you to publish.");
		expect(sheetButton("ask")).toBeNull();
		sheetButton("decline-ask")!.click();
		await flush();
		expect(calls.declineSurfacePublishAsk).toHaveBeenCalledWith(SURFACE);
		expect(dialog.el.open).toBe(false);
		store.dispose();
	});

	it("marks the surface Needs you in the rail for the asked member only", async () => {
		for (const [viewer, expected] of [
			[SOFIE, "Needs you"],
			[JONAS, null],
		] as const) {
			const { store } = await setUp(viewer, site({ publishAsk: ask(), activeSessionCount: 0 }));
			const rail = new SurfaceRail(store, COMPANY, new AbortController().signal);
			document.body.append(rail.el);
			rail.update(undefined);
			const row = rail.el.querySelector<HTMLElement>('.rail-surface[data-surface-slug="website"]')!;
			expect(row.querySelector(".rail-surface-sub")?.textContent === "Needs you" ? "Needs you" : null).toBe(
				expected,
			);
			rail.el.remove();
			store.dispose();
		}
	});
});
