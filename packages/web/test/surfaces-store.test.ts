import { CloudSurfacesError } from "@qorpera/cloud-client/surfaces";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRoute, routeHash, surfaceHash } from "../src/app/router.ts";
import {
	approvalOutcome,
	migrationPending,
	runningSessionTotal,
	SURFACE_UNDO_MS,
	synthesizeMigration,
	synthesizeSurfaces,
} from "../src/app/surfaces-store.ts";
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

afterEach(() => {
	vi.useRealTimers();
});

describe("the surface route", () => {
	it("parses and writes #/c/{id}/s/{slug}", () => {
		const route = parseRoute(`#/c/${COMPANY}/s/website`);
		expect(route).toEqual({ name: "company", profileId: COMPANY, section: "surface", id: "website" });
		expect(routeHash(route)).toBe(surfaceHash(COMPANY, "website"));
	});

	it("falls back to the company's home for a slug that is no surface name", () => {
		expect(parseRoute(`#/c/${COMPANY}/s/Not_A_Slug`)).toEqual({
			name: "company",
			profileId: COMPANY,
			section: "home",
		});
	});
});

describe("synthesized surfaces", () => {
	it("turns live websites into Building and the native pages into Running", () => {
		const surfaces = synthesizeSurfaces({
			companyId: COMPANY,
			sites: [
				{ slug: "thetaband", title: "Thetaband", kind: "files", state: "live", url: "https://a.example" },
				{ slug: "inbox", title: null, kind: "files", state: "live", url: "https://b.example" },
				{ slug: "tool", title: "Tool", kind: "app", state: "live", url: "https://c.example" },
			],
			pages: ["mailbox"],
		});
		expect(surfaces.map((item) => [item.slug, item.group, item.archetype])).toEqual([
			["thetaband", "products", "live_build"],
			["inbox-site", "products", "live_build"],
			["inbox", "operations", "ops"],
			["files", "operations", "ops"],
		]);
		expect(surfaces[0]?.siteSlug).toBe("thetaband");
	});

	it("offers the migration while specialist agents or boards remain", () => {
		expect(migrationPending(synthesizeMigration({ companyId: COMPANY, agents: [], boards: [] }))).toBe(false);
		expect(
			migrationPending(
				synthesizeMigration({ companyId: COMPANY, agents: [], boards: [{ name: "a", title: "A", kit: null }] }),
			),
		).toBe(true);
	});
});

describe("the multi-change lifecycle", () => {
	it("keeps a partly approved session open", () => {
		expect(approvalOutcome(session(["merged", "staged", "staged"]), false)).toBe("open");
	});

	it("holds a fully approved session while its chat is open, and files it in History otherwise", () => {
		expect(approvalOutcome(session(["merged", "merged", "merged"]), true)).toBe("hold");
		expect(approvalOutcome(session(["merged", "merged", "merged"]), false)).toBe("history");
		expect(approvalOutcome(session(["merged"]), false)).toBe("history");
	});
});

describe("SurfacesStore", () => {
	it("synthesizes surfaces when the cloud has no surface calls yet", async () => {
		const store = storeWith(
			fakeClient({ listSurfaces: vi.fn(async () => Promise.reject(new CloudSurfacesError("missing", "PGRST202"))) }),
		);
		await store.load();
		expect(store.state.source).toBe("local");
		expect(store.state.error).toBeUndefined();
		expect(store.state.surfaces.map((item) => item.slug)).toEqual(["thetaband", "inbox", "money", "files"]);
		expect(migrationPending(store.state.migration)).toBe(true);
		expect(store.canStartSessions(store.state.surfaces[0]!)).toBe(false);
	});

	it("synthesizes surfaces for a company without surface rows", async () => {
		const store = storeWith(fakeClient({ listSurfaces: vi.fn(async () => []) }));
		await store.load();
		expect(store.state.source).toBe("local");
	});

	it("approving one of three changes keeps the session and offers Undo", async () => {
		vi.useFakeTimers();
		const client = fakeClient({
			approveSurfaceChange: vi.fn(async () => session(["merged", "staged", "staged"])),
		});
		const store = storeWith(client);
		await store.load();
		await store.openSurface("website");
		expect(await store.approveChange(SESSION, CHANGES[0])).toBe("open");
		expect(store.workspace(SURFACE)?.activeSessions.map((item) => item.id)).toEqual([SESSION]);
		expect(store.state.undo?.changeIds).toEqual([CHANGES[0]]);
		vi.advanceTimersByTime(SURFACE_UNDO_MS + 1);
		expect(store.state.undo).toBeUndefined();
		store.dispose();
	});

	it("approving the last change with the drawer open holds the session until the drawer closes", async () => {
		const client = fakeClient({
			getSurfaceWorkspace: vi.fn(async () => workspace([session(["merged", "merged", "staged"])])),
			approveSurfaceChange: vi.fn(async () => session(["merged", "merged", "merged"], { hasActiveChat: true })),
		});
		const store = storeWith(client);
		await store.load();
		await store.openSurface("website");
		store.openDrawer(SURFACE, SESSION);
		expect(client.setSessionChatOpen).toHaveBeenCalledWith(SESSION, true);
		expect(await store.approveChange(SESSION, CHANGES[2])).toBe("hold");
		expect(store.workspace(SURFACE)?.activeSessions).toHaveLength(1);
		store.closeDrawer();
		expect(client.setSessionChatOpen).toHaveBeenCalledWith(SESSION, false);
		expect(store.workspace(SURFACE)?.activeSessions).toHaveLength(0);
		expect(store.workspace(SURFACE)?.recentHistory.map((item) => item.id)).toEqual([SESSION]);
		store.dispose();
	});

	it("approving a single-change session from the rail files it in History at once", async () => {
		const client = fakeClient({
			getSurfaceWorkspace: vi.fn(async () => workspace([session(["staged"])])),
			approveSurfaceChange: vi.fn(async () => session(["merged"], { state: "completed" })),
		});
		const store = storeWith(client);
		await store.load();
		await store.openSurface("website");
		expect(await store.approveChange(SESSION, CHANGES[0])).toBe("history");
		expect(store.workspace(SURFACE)?.activeSessions).toHaveLength(0);
		expect(store.state.undo?.changeIds).toEqual([CHANGES[0]]);
		store.dispose();
	});

	it("Approve all closes the drawer, files the session and Undo restores it", async () => {
		const restored = session(["staged", "staged", "staged"]);
		const client = fakeClient({
			approveSessionAll: vi.fn(async () => session(["merged", "merged", "merged"], { state: "completed" })),
			undoSurfaceChange: vi.fn(async () => restored),
		});
		const store = storeWith(client);
		await store.load();
		await store.openSurface("website");
		store.openDrawer(SURFACE, SESSION);
		expect(await store.approveAll(SESSION)).toBe(true);
		expect(store.state.drawer).toBeUndefined();
		expect(store.workspace(SURFACE)?.recentHistory).toHaveLength(1);
		expect(store.state.undo?.changeIds).toEqual([...CHANGES]);
		expect(await store.undo()).toBe(true);
		expect(client.undoSurfaceChange).toHaveBeenCalledTimes(3);
		expect(store.workspace(SURFACE)?.activeSessions.map((item) => item.id)).toEqual([SESSION]);
		expect(store.workspace(SURFACE)?.recentHistory).toHaveLength(0);
		store.dispose();
	});

	it("previews every open change that is turned on", async () => {
		const client = fakeClient({
			setPreviewSelection: vi.fn(async () => workspace([]).previewState),
		});
		const store = storeWith(client);
		await store.load();
		await store.openSurface("website");
		await store.toggleChange(SURFACE, CHANGES[1]);
		expect(client.setPreviewSelection).toHaveBeenCalledWith(SURFACE, {
			toggledChangeIds: [CHANGES[0], CHANGES[2]],
			explorationSessionId: null,
		});
		store.dispose();
	});

	it("counts running sessions across surfaces without a cap", () => {
		expect(
			runningSessionTotal({
				surfaces: [summary({ runningSessionCount: 7 }), summary({ id: "other", runningSessionCount: 5 })],
				workspaces: {},
			}),
		).toBe(12);
	});

	it("says Surfaces are unavailable when an action reaches an unmigrated cloud", async () => {
		const client = fakeClient({
			publishSurface: vi.fn(async () => Promise.reject(new CloudSurfacesError("missing", "42883"))),
		});
		const store = storeWith(client);
		await store.load();
		expect(await store.publish(SURFACE)).toBe(false);
		expect(store.state.error).toBe("Surfaces aren't enabled for this company yet.");
		store.dispose();
	});
});
