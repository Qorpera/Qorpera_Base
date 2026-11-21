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
import { deferred } from "./fixtures.ts";
import {
	CHANGES,
	COMPANY,
	change,
	fakeClient,
	MESSAGE_IDS,
	pointTarget,
	SESSION,
	SURFACE,
	session,
	sessionMessage,
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

	it("reconciles conflicted changes through the cloud client and refreshes the workspace", async () => {
		const conflicted = session(["conflicted", "staged"], {
			changes: [
				change(CHANGES[0], 1, "conflicted", { conflictPaths: ["src/hero.tsx"] }),
				change(CHANGES[1], 2, "staged"),
			],
		});
		const reconciling = session(["staged", "staged"], { state: "reconciling" });
		const getSurfaceWorkspace = vi
			.fn()
			.mockResolvedValueOnce(workspace([conflicted]))
			.mockResolvedValueOnce(workspace([reconciling]));
		const reconcileChanges = vi.fn(async () => reconciling);
		const store = storeWith(fakeClient({ getSurfaceWorkspace, reconcileChanges }));
		await store.load();
		await store.openSurface("website");
		const result = await store.reconcileChanges(SURFACE, [CHANGES[0], CHANGES[0]]);
		expect(reconcileChanges).toHaveBeenCalledWith(SURFACE, [CHANGES[0]]);
		expect(result?.state).toBe("reconciling");
		expect(store.workspace(SURFACE)?.activeSessions[0]?.state).toBe("reconciling");
		store.dispose();
	});

	it("falls back cleanly when reconciling a local surface conflict without a cloud client", async () => {
		const store = storeWith(undefined);
		await store.load();
		await store.openSurface("thetaband");
		const local = store.state.surfaces[0]!;
		const localConflicted = session(["conflicted"], {
			surfaceId: local.id,
			changes: [change(CHANGES[0], 1, "conflicted", { surfaceId: local.id, conflictPaths: ["index.html"] })],
		});
		const existing = store.workspace(local.id)!;
		store.store.set({
			workspaces: {
				...store.state.workspaces,
				[local.id]: {
					...existing,
					activeSessions: [localConflicted],
					previewState: {
						...existing.previewState,
						primary: {
							...existing.previewState.primary,
							status: "conflicted",
							conflictReport: { changeIds: [CHANGES[0]], paths: ["index.html"] },
						},
					},
				},
			},
		});
		const reconciled = await store.reconcileChanges(local.id, [CHANGES[0]]);
		expect(reconciled?.state).toBe("reconciling");
		expect(store.workspace(local.id)?.previewState.primary.conflictReport).toBeNull();
		expect(store.workspace(local.id)?.previewState.primary.status).toBe("composing");
		store.dispose();
	});

	it("forwards Point-to-Change metadata when starting a session", async () => {
		const target = pointTarget();
		const started = session(["staged"], {
			state: "running",
			originKind: "point_to_change",
			originLabel: "PreorderCta · /pricing",
		});
		const startSurfaceSession = vi.fn(async () => started);
		const store = storeWith(fakeClient({ startSurfaceSession }));
		await store.load();
		await store.openSurface("website");
		await store.startSession(SURFACE, "Gør knappen roligere", {
			target,
			originKind: "point_to_change",
			originLabel: "PreorderCta · /pricing",
		});
		expect(startSurfaceSession).toHaveBeenCalledWith(SURFACE, "Gør knappen roligere", {
			target,
			originKind: "point_to_change",
			originLabel: "PreorderCta · /pricing",
		});
		store.dispose();
	});

	it("appends an optimistic reply and reconciles it once durable session.messages arrives", async () => {
		const pending = deferred<ReturnType<typeof session>>();
		const replySurfaceSession = vi.fn(() => pending.promise);
		const store = storeWith(fakeClient({ replySurfaceSession }));
		await store.load();
		await store.openSurface("website");
		const sending = store.reply(SESSION, "Hold overskriften kort");
		expect(store.state.notes).toHaveLength(1);
		expect(store.state.notes[0]?.text).toBe("Hold overskriften kort");
		pending.resolve(
			session(["staged"], {
				messages: [sessionMessage(MESSAGE_IDS[0], "member", "Hold overskriften kort")],
			}),
		);
		expect(await sending).toBe(true);
		expect(store.state.notes).toHaveLength(0);
		expect(store.session(SESSION)?.messages).toHaveLength(1);
		store.dispose();
	});

	it("removes an optimistic reply when the reply RPC fails", async () => {
		const store = storeWith(
			fakeClient({ replySurfaceSession: vi.fn(async () => Promise.reject(new Error("offline"))) }),
		);
		await store.load();
		await store.openSurface("website");
		expect(await store.reply(SESSION, "Prøv igen")).toBe(false);
		expect(store.state.notes).toHaveLength(0);
		expect(store.state.error).toBe("offline");
		store.dispose();
	});

	it("spawns a cross-surface session via cloud RPC, highlights it, and navigates to the target surface", async () => {
		const brand = summary({
			id: "22222222-2222-4222-8222-222222222229",
			slug: "brand",
			title: "Brand",
			archetype: "studio",
			siteSlug: null,
			liveUrl: null,
		});
		const spawned = session([], {
			id: "33333333-3333-4333-8333-333333333399",
			surfaceId: SURFACE,
			title: "Sync Brand",
			state: "queued",
			originKind: "cross_surface",
			originLabel: "From Brand",
		});
		const spawnCrossSurfaceSession = vi.fn(async () => spawned);
		const navigated: string[] = [];
		const store = storeWith(
			fakeClient({ listSurfaces: vi.fn(async () => [summary(), brand]), spawnCrossSurfaceSession }),
			{ onNavigateSurface: (slug) => navigated.push(slug) },
		);
		await store.load();
		const result = await store.spawnCrossSurfaceSession({
			sourceSurfaceId: brand.id,
			targetSurfaceSlug: "website",
			prompt: "Sync updated accent token",
			title: "Sync Brand",
		});
		expect(spawnCrossSurfaceSession).toHaveBeenCalledWith({
			sourceSurfaceId: brand.id,
			targetSurfaceSlug: "website",
			prompt: "Sync updated accent token",
			title: "Sync Brand",
		});
		expect(result?.id).toBe(spawned.id);
		expect(store.state.highlight).toEqual({ surfaceId: SURFACE, sessionId: spawned.id });
		expect(navigated).toEqual(["website"]);
		store.dispose();
	});

	it("falls back cleanly to creating a local cross-surface session and navigating when offline", async () => {
		const navigated: string[] = [];
		const store = storeWith(undefined, { onNavigateSurface: (slug) => navigated.push(slug) });
		await store.load();
		const inbox = store.state.surfaces.find((item) => item.slug === "inbox")!;
		const created = await store.spawnCrossSurfaceSession({
			sourceSurfaceId: inbox.id,
			targetSurfaceSlug: "thetaband",
			prompt: "Fix Safari checkout layout bug from Mette",
		});
		expect(created?.originKind).toBe("cross_surface");
		expect(created?.originLabel).toBe("From Inbox");
		expect(navigated).toEqual(["thetaband"]);
		expect(store.state.highlight?.sessionId).toBe(created?.id);
		expect(store.workspace(created!.surfaceId)?.activeSessions.map((item) => item.id)).toContain(created?.id);
		store.dispose();
	});

	it("approves or dismisses proposed surfaces cleanly", async () => {
		const proposedA = summary({
			id: "22222222-2222-4222-8222-222222222241",
			slug: "app",
			title: "Meditation App",
			status: "proposed",
		});
		const proposedB = summary({
			id: "22222222-2222-4222-8222-222222222242",
			slug: "press",
			title: "Press Kit",
			status: "proposed",
		});
		const approveProposedSurface = vi.fn(async () => ({ ...proposedA, status: "active" as const }));
		const archiveSurface = vi.fn(async () => ({ ...proposedB, status: "archived" as const }));
		const store = storeWith(
			fakeClient({
				listSurfaces: vi.fn(async () => [summary(), proposedA, proposedB]),
				approveProposedSurface,
				archiveSurface,
			}),
		);
		await store.load();
		const approved = await store.approveProposedSurface(proposedA.id);
		expect(approved?.status).toBe("active");
		expect(store.state.surfaces.find((item) => item.id === proposedA.id)?.status).toBe("active");
		expect(await store.archiveSurface(proposedB.id)).toBe(true);
		expect(store.state.surfaces.find((item) => item.id === proposedB.id)).toBeUndefined();
		store.dispose();
	});
});
