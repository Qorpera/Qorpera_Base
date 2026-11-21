import { CloudSurfacesError } from "@qorpera/cloud-client/surfaces";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRoute, routeHash, surfaceHash } from "../src/app/router.ts";
import {
	approvalOutcome,
	clearLocalSandboxCache,
	migrationPending,
	reportsOwnedBy,
	runningSessionTotal,
	SURFACE_UNDO_MS,
	synthesizeMigration,
	synthesizeSurfaces,
	unpublishedChanges,
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
	clearLocalSandboxCache();
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

	it("supports interactive local preview sessions, partial approval, undo, migration, and tab persistence", async () => {
		vi.useFakeTimers();
		const navigated: string[] = [];
		const store = storeWith(undefined, {
			companyName: "Wristband company",
			localInteractive: true,
			onNavigateSurface: (slug) => navigated.push(slug),
		});
		await store.load();
		const brand = await store.createSurface({
			title: "Brand",
			slug: "brand",
			archetype: "studio",
			icon: "spark",
			folderRoot: "brand",
		});
		expect(brand?.slug).toBe("brand");
		expect(navigated).toEqual(["brand"]);
		expect(store.state.localStudioBase[brand!.id]?.["brand/tokens.json"]).toContain("#2a5d9e");

		const started = await store.startSession(
			brand!.id,
			"Warm up the accent color to terracotta and refine the headline voice",
		);
		expect(started?.state).toBe("running");
		vi.advanceTimersByTime(700);
		const ready = store.session(started!.id)!;
		expect(ready.state).toBe("ready");
		expect(ready.changes).toHaveLength(2);

		expect(await store.approveChange(ready.id, ready.changes[0]!.id)).toBe("open");
		expect(store.workspace(brand!.id)?.activeSessions).toHaveLength(1);
		expect(store.state.surfaces.find((item) => item.id === brand!.id)?.unpublishedChangeCount).toBe(1);
		expect(store.state.localStudioBase[brand!.id]?.["brand/tokens.json"]).toContain("#c65d3b");

		expect(await store.undo()).toBe(true);
		expect(store.state.localStudioBase[brand!.id]?.["brand/tokens.json"]).toContain("#2a5d9e");

		const migrated = await store.applyMigration({
			activateSurfaceSlugs: [],
			agentDecisions: [{ agentId: CHANGES[0], action: "fold_to_automation", targetSurfaceSlug: null }],
			archiveBoardNames: [],
		});
		expect(migrated).toBe(true);
		expect(store.state.foldedAgentIds[CHANGES[0]]).toBe(true);
		expect(store.state.automations).toHaveLength(1);
		store.dispose();

		const restored = storeWith(undefined, { companyName: "Wristband company", localInteractive: true });
		await restored.load();
		expect(restored.state.surfaces.some((item) => item.slug === "brand")).toBe(true);
		expect(restored.state.foldedAgentIds[CHANGES[0]]).toBe(true);
		expect(restored.state.automations).toHaveLength(1);
		restored.dispose();
	});

	it("bootstraps Day-0 cloud surfaces, hydrates patchManifest & cloud Notes, and responds to Realtime live hints", async () => {
		vi.useFakeTimers();
		const appSurfaceId = "22222222-2222-4222-8222-222222222229";
		const identity = summary({
			id: SURFACE,
			slug: "identity",
			title: "Identity",
			archetype: "studio",
			kind: "identity",
			accentHex: "#d76f45",
			isGlobal: true,
			folderRoot: "identity",
		});
		const createdApp = summary({
			id: appSurfaceId,
			slug: "mobile-app",
			title: "Mobile App",
			archetype: "live_build",
			kind: "mobile_app",
		});
		const mergedUnpublished = change(CHANGES[0], 1, "merged", {
			kind: "folder_patch",
			publishedAt: null,
			approvedByUserId: COMPANY,
			patchManifest: [{ op: "merge_json", path: "identity/tokens.json", patch: { accent: "#d76f45" } }],
		});
		const mergedPublished = change(CHANGES[1], 2, "merged", {
			kind: "folder_patch",
			publishedAt: "2026-11-21T18:00:00Z",
		});
		const activeSess = session(["merged", "merged"], {
			id: SESSION,
			surfaceId: identity.id,
			state: "running",
			notePaths: ["QorperaOS/surfaces/identity/notes/brand-notes.report.json"],
			changes: [mergedUnpublished, mergedPublished],
		});
		const bootstrapCompanySurfaces = vi.fn().mockResolvedValue([identity]);
		const createSurface = vi.fn().mockResolvedValue(createdApp);
		const createAutomation = vi.fn().mockResolvedValue({
			id: CHANGES[2],
			key: "weekly-check",
			title: "Weekly check",
			prompt: "Review conversion metrics",
			scheduleSummary: "Every Monday · 09:00",
			targetSurfaceSlug: "identity",
			outputMode: "surface_session" as const,
			enabled: true,
			status: "idle" as const,
			lastRunAt: null,
			lastOutcomeSummary: null,
			nextRunAt: null,
		});
		const deleteAutomation = vi.fn().mockResolvedValue(true);
		const client = fakeClient({
			listSurfaces: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([identity, createdApp]),
			bootstrapCompanySurfaces,
			createSurface,
			createAutomation,
			deleteAutomation,
			getSurfaceWorkspace: vi.fn().mockResolvedValue(workspace([activeSess], { surface: identity })),
		});
		const loadCloudFiles = vi.fn().mockResolvedValue({
			"QorperaOS/surfaces/identity/notes/brand-notes.report.json": JSON.stringify({
				slug: "brand-notes",
				headline: "Calm Danish Brand Voice",
				category: "Identity",
				readingTime: "2 min",
			}),
		});
		let realtimeConnected = true;
		const store = storeWith(client, {
			realtimeLive: () => realtimeConnected,
			loadCloudFiles,
			memberName: (id) => (id === COMPANY ? "Mads" : undefined),
			peopleAtSurface: (slug) => (slug === "identity" ? [{ userId: COMPANY, name: "Mads" }] : []),
		});

		await store.load();
		expect(bootstrapCompanySurfaces).toHaveBeenCalledWith(COMPANY);
		expect(store.state.source).toBe("cloud");
		expect(store.lookOf(identity)).toEqual({ kind: "identity", accent: "#d76f45" });

		await store.openSurface("identity");
		await Promise.resolve();
		expect(loadCloudFiles).toHaveBeenCalledTimes(1);
		expect(store.state.studioPatches[CHANGES[0]]).toEqual([
			{ op: "merge_json", path: "identity/tokens.json", patch: { accent: "#d76f45" } },
		]);
		expect(reportsOwnedBy(store.state, identity.id, { kind: "session", id: activeSess.id })).toHaveLength(1);
		expect(unpublishedChanges(store.state, identity.id).map((entry) => entry.change.id)).toEqual([CHANGES[0]]);
		expect(store.memberName(COMPANY)).toBe("Mads");
		expect(store.peopleAtSurface("identity")).toEqual([{ userId: COMPANY, name: "Mads" }]);

		const callsBefore = vi.mocked(client.getSurfaceWorkspace).mock.calls.length;
		vi.advanceTimersByTime(10_000);
		expect(vi.mocked(client.getSurfaceWorkspace).mock.calls.length).toBe(callsBefore);

		store.onRealtimeHint("surfaces");
		vi.advanceTimersByTime(200);
		expect(vi.mocked(client.getSurfaceWorkspace).mock.calls.length).toBeGreaterThan(callsBefore);

		const created = await store.createSurface({
			title: "Mobile App",
			archetype: "live_build",
			kind: "mobile_app",
		});
		expect(createSurface).toHaveBeenCalledTimes(1);
		expect(created?.id).toBe(createdApp.id);

		const auto = await store.createScheduledAgent({
			title: "Weekly check",
			prompt: "Review conversion metrics",
			scheduleSummary: "Every Monday · 09:00",
			targetSurfaceSlug: "identity",
		});
		expect(createAutomation).toHaveBeenCalledTimes(1);
		expect(auto?.id).toBe(CHANGES[2]);
		expect(await store.deleteScheduledAgent(CHANGES[2])).toBe(true);
		expect(deleteAutomation).toHaveBeenCalledWith(CHANGES[2]);

		realtimeConnected = false;
		store.dispose();
	});

	it("composes concurrent toggled changes alongside only the picked exploration variant", async () => {
		const explorationId = "88888888-8888-4888-8888-888888888881";
		const variantA = "33333333-3333-4333-8333-333333333311";
		const variantB = "33333333-3333-4333-8333-333333333312";
		const variantC = "33333333-3333-4333-8333-333333333313";
		const changeA = "44444444-4444-4444-8444-444444444411";
		const changeB = "44444444-4444-4444-8444-444444444412";
		const changeC = "44444444-4444-4444-8444-444444444413";
		const peerSession = "33333333-3333-4333-8333-333333333399";
		const peerChange = "44444444-4444-4444-8444-444444444499";

		const setPreviewSelection = vi.fn(async () => workspace([]).previewState);
		const client = fakeClient({
			getSurfaceWorkspace: vi.fn(async () =>
				workspace(
					[
						session(["staged"], {
							id: variantA,
							explorationId,
							explorationVariantLabel: "Light",
							changes: [change(changeA, 1, "staged", { sessionId: variantA })],
						}),
						session(["staged"], {
							id: variantB,
							explorationId,
							explorationVariantLabel: "Warm",
							changes: [change(changeB, 1, "staged", { sessionId: variantB })],
						}),
						session(["staged"], {
							id: variantC,
							explorationId,
							explorationVariantLabel: "Editorial",
							changes: [change(changeC, 1, "staged", { sessionId: variantC })],
						}),
						session(["staged", "staged"], {
							id: SESSION,
							changes: [change(CHANGES[0], 1, "staged"), change(CHANGES[1], 2, "staged")],
						}),
						session(["staged"], {
							id: peerSession,
							changes: [change(peerChange, 1, "staged", { sessionId: peerSession })],
						}),
					],
					{
						explorations: [
							{
								id: explorationId,
								surfaceId: SURFACE,
								title: "Hero direction",
								status: "open",
								chosenSessionId: null,
								variantSessionIds: [variantA, variantB, variantC],
								createdAt: "2026-11-21T10:00:00.000Z",
								resolvedAt: null,
							},
						],
					},
				),
			),
			setPreviewSelection,
		});

		const store = storeWith(client);
		await store.load();
		await store.openSurface("website");

		expect(store.activePreviewSessions(SURFACE).map((item) => item.id)).toEqual([variantA, SESSION, peerSession]);
		expect(store.previewSelection(SURFACE)).toEqual({
			toggledChangeIds: [CHANGES[0], CHANGES[1], peerChange],
			explorationSessionId: variantA,
		});

		await store.pickVariant(SURFACE, explorationId, variantB);
		expect(store.activePreviewSessions(SURFACE).map((item) => item.id)).toEqual([variantB, SESSION, peerSession]);
		expect(setPreviewSelection).toHaveBeenLastCalledWith(SURFACE, {
			toggledChangeIds: [CHANGES[0], CHANGES[1], peerChange],
			explorationSessionId: variantB,
		});

		await store.toggleChange(SURFACE, CHANGES[1]);
		expect(setPreviewSelection).toHaveBeenLastCalledWith(SURFACE, {
			toggledChangeIds: [CHANGES[0], peerChange],
			explorationSessionId: variantB,
		});
		store.dispose();
	});
});
