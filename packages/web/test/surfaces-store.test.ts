import { CloudSurfacesError } from "@qorpera/cloud-client/surfaces";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRoute, routeHash, surfaceHash } from "../src/app/router.ts";
import {
	approvalOutcome,
	attachSurfaces,
	clearLocalSandboxCache,
	compiledCompanyIdentity,
	effectiveStudioBaseFiles,
	migrationPending,
	normalizeStudioPatchOps,
	PREVIEW_PASS_TTL_MS,
	readSurfaceFolderFiles,
	reportsOwnedBy,
	runningSessionTotal,
	SURFACE_UNDO_MS,
	surfacesDisabledOf,
	surfacesOf,
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
		const statuses: ("merged" | "staged")[] = ["merged", "merged", "merged"];
		const client = fakeClient({
			approveSessionAll: vi.fn(async () => session(["merged", "merged", "merged"], { state: "completed" })),
			undoSurfaceChange: vi.fn(async (id: string) => {
				const idx = CHANGES.indexOf(id as (typeof CHANGES)[number]);
				if (idx >= 0) statuses[idx] = "staged";
				return session([...statuses]);
			}),
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

	it("compiles identity/tokens.json from base + preview patches and updates live on approve and rollback", async () => {
		const store = storeWith(undefined, {
			companyName: "Thetaband",
			localInteractive: true,
			synthesize: () => ({ companyId: COMPANY, sites: [], pages: ["mailbox"] }),
		});
		await store.load();
		const identity = store.state.surfaces.find((item) => item.slug === "identity")!;
		await store.openSurface("identity");
		const identitySession = store.workspace(identity.id)!.activeSessions[0]!;
		const tokenChange = identitySession.changes[0]!;

		const previewed = compiledCompanyIdentity(store.state);
		expect(previewed).not.toBeNull();
		expect(previewed?.vars["--q-color-accent"]).toBe("#6f61cf");
		expect(previewed?.vars["--brand-accent"]).toBe("#6f61cf");
		expect(previewed?.css).toContain("--q-color-accent: #6f61cf;");

		await store.toggleChange(identity.id, tokenChange.id);
		expect(store.companyIdentityTokens()?.vars["--q-color-accent"]).toBe("#7c6fd6");

		await store.toggleChange(identity.id, tokenChange.id);
		expect(store.companyIdentityTokens()?.vars["--q-color-accent"]).toBe("#6f61cf");

		store.setMode("live");
		expect(store.companyIdentityTokens()?.vars["--q-color-accent"]).toBe("#7c6fd6");

		store.setMode("preview");
		await store.approveChange(identitySession.id, tokenChange.id);
		store.setMode("live");
		expect(store.companyIdentityTokens()?.vars["--q-color-accent"]).toBe("#6f61cf");

		await store.rollbackChange(tokenChange.id);
		expect(store.companyIdentityTokens()?.vars["--q-color-accent"]).toBe("#7c6fd6");
		store.dispose();
	});

	it("stays disabled when qorpera_surfaces_enabled returns false or is missing", async () => {
		const ownerA = {};
		const listSurfaces = vi.fn(async () => [summary()]);
		const bootstrapCompanySurfaces = vi.fn(async () => [summary()]);
		const disabledStore = storeWith(
			fakeClient({
				isSurfacesEnabled: vi.fn(async () => false),
				listSurfaces,
				bootstrapCompanySurfaces,
			}),
		);
		attachSurfaces(ownerA, disabledStore);
		expect(surfacesOf(ownerA)).toBeUndefined();
		await disabledStore.load();
		expect(disabledStore.state.source).toBe("disabled");
		expect(disabledStore.state.surfaces).toEqual([]);
		expect(surfacesOf(ownerA)).toBeUndefined();
		expect(surfacesDisabledOf(ownerA)).toBe(true);
		expect(listSurfaces).not.toHaveBeenCalled();
		expect(bootstrapCompanySurfaces).not.toHaveBeenCalled();
		disabledStore.dispose();

		const ownerB = {};
		const missingStore = storeWith(
			fakeClient({
				isSurfacesEnabled: vi.fn(async () => Promise.reject(new CloudSurfacesError("missing", "PGRST202"))),
				listSurfaces,
			}),
		);
		attachSurfaces(ownerB, missingStore);
		await missingStore.load();
		expect(missingStore.state.source).toBe("disabled");
		expect(missingStore.state.error).toBeUndefined();
		expect(surfacesOf(ownerB)).toBeUndefined();
		expect(surfacesDisabledOf(ownerB)).toBe(true);
		missingStore.dispose();
	});

	it("mints preview passes automatically when ready primary or compare previews arrive without a pass", async () => {
		const mintPreviewPass = vi.fn(async (previewId: string) => ({
			previewId,
			doorActionUrl: `https://thetaband--p${previewId.slice(-8)}.qorpera.com/__qorpera/member`,
			memberPass: VALID_PASS,
		}));
		const client = fakeClient({
			isSurfacesEnabled: vi.fn(async () => true),
			getSurfaceWorkspace: vi.fn(async () =>
				workspace([session(["staged"])], {
					previewState: {
						surfaceId: SURFACE,
						mode: "compare",
						primary: previewFrame({
							previewId: PREVIEW_IDS[0],
							status: "ready",
							doorActionUrl: null,
							memberPass: null,
						}),
						compareFrames: [
							{
								sessionId: SESSION,
								label: "Variant B",
								frame: previewFrame({
									previewId: PREVIEW_IDS[1],
									status: "ready",
									doorActionUrl: null,
									memberPass: null,
								}),
							},
						],
					},
				}),
			),
			mintPreviewPass,
		});
		const store = storeWith(client);
		await store.load();
		await store.openSurface("website");
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(mintPreviewPass).toHaveBeenCalledWith(PREVIEW_IDS[0]);
		expect(mintPreviewPass).toHaveBeenCalledWith(PREVIEW_IDS[1]);
		const ws = store.workspace(SURFACE)!;
		expect(ws.previewState.primary.memberPass).toBe(VALID_PASS);
		expect(ws.previewState.primary.doorActionUrl).toContain(PREVIEW_IDS[0].slice(-8));
		expect(ws.previewState.compareFrames[0]?.frame.memberPass).toBe(VALID_PASS);
		expect(ws.previewState.compareFrames[0]?.frame.doorActionUrl).toContain(PREVIEW_IDS[1].slice(-8));
		store.dispose();
	});

	it("keeps loading on transient isSurfacesEnabled network errors and recovers on retry", async () => {
		const owner = {};
		let attempts = 0;
		const isSurfacesEnabled = vi.fn(async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("Failed to fetch");
			return true;
		});
		const store = storeWith(fakeClient({ isSurfacesEnabled }));
		attachSurfaces(owner, store);

		await store.load();
		expect(store.state.source).toBe("loading");
		expect(surfacesDisabledOf(owner)).toBe(false);
		expect(surfacesOf(owner)).toBeUndefined();

		await store.load();
		expect(store.state.source).toBe("cloud");
		expect(surfacesDisabledOf(owner)).toBe(false);
		expect(surfacesOf(owner)).toBe(store);
		store.dispose();
	});

	it("skips redundant undo RPCs when a folder batch undo already restored sibling changes", async () => {
		const undoSurfaceChange = vi.fn(async () => session(["staged", "staged"]));
		const client = fakeClient({
			approveSessionAll: vi.fn(async () => session(["merged", "merged"])),
			undoSurfaceChange,
		});
		const store = storeWith(client);
		await store.load();
		await store.openSurface("website");
		await store.approveAll(SESSION);
		expect(store.state.undo?.changeIds).toEqual([CHANGES[0], CHANGES[1]]);

		await store.undo();
		expect(undoSurfaceChange).toHaveBeenCalledTimes(1);
		expect(undoSurfaceChange).toHaveBeenCalledWith(CHANGES[0]);
		store.dispose();
	});

	it("auto-composes preview selection once for cloud code_repo surfaces with newly staged changes and retries after transient failure without setting state.error", async () => {
		let attempts = 0;
		const readyPreview = {
			surfaceId: SURFACE,
			mode: "single" as const,
			primary: previewFrame({
				status: "composing",
				toggledChangeIds: [CHANGES[0]],
			}),
			compareFrames: [],
		};
		const setPreviewSelection = vi.fn(async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("transient offline");
			return readyPreview;
		});
		const client = fakeClient({
			getSurfaceWorkspace: vi.fn(async () => workspace([session(["staged"])])),
			setPreviewSelection,
		});
		const store = storeWith(client);
		await store.load();
		await store.openSurface("website");
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(setPreviewSelection).toHaveBeenCalledTimes(1);
		expect(setPreviewSelection).toHaveBeenCalledWith(SURFACE, {
			toggledChangeIds: [CHANGES[0]],
			explorationSessionId: null,
		});
		expect(store.state.error).toBeUndefined();

		await store.openSurface("website");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(setPreviewSelection).toHaveBeenCalledTimes(2);
		expect(store.workspace(SURFACE)?.previewState.primary.status).toBe("composing");

		await store.openSurface("website");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(setPreviewSelection).toHaveBeenCalledTimes(2);
		store.dispose();
	});

	it("compiles live company identity tokens from folder-relative staged patches on the identity surface", async () => {
		const identity = summary({
			id: "22222222-2222-4222-8222-222222222291",
			slug: "identity",
			title: "Identity",
			archetype: "studio",
			kind: "identity",
			isGlobal: true,
			sourceKind: "folder",
			repositoryKey: null,
			folderRoot: "identity",
			siteSlug: null,
			previewMode: "studio_overlay",
			liveUrl: null,
		});
		const c1 = change(CHANGES[0], 1, "staged", {
			surfaceId: identity.id,
			kind: "folder_patch",
			title: "Update accent",
			affectedPaths: ["tokens.json"],
			patchManifest: [{ op: "merge_json", path: "tokens.json", patch: { colors: { accent: "#c9643b" } } }],
		});
		const idSession = session(["staged"], { surfaceId: identity.id, changes: [c1] });
		const store = storeWith(
			fakeClient({
				listSurfaces: vi.fn(async () => [identity, summary()]),
				getSurfaceWorkspace: vi.fn(async () => workspace([idSession], { surface: identity })),
			}),
			{
				loadCloudFiles: vi.fn(async () => ({
					"identity/tokens.json": JSON.stringify({ colors: { primary: "#18181b", accent: "#2563eb" } }),
				})),
			},
		);
		await store.load();
		await store.openSurface("identity");
		await Promise.resolve();

		const tokens = store.companyIdentityTokens();
		expect(tokens?.vars["--q-color-primary"]).toBe("#18181b");
		expect(tokens?.vars["--q-color-accent"]).toBe("#c9643b");
		store.dispose();
	});

	it("keeps merging folder_patch active on approveAll, overlays optimistic base until post-merge cloud files settle, and refreshes immediately on publish and folder hints", async () => {
		vi.useFakeTimers();
		const identityId = "22222222-2222-4222-8222-222222222271";
		const identity = summary({
			id: identityId,
			slug: "identity",
			title: "Identity",
			archetype: "studio",
			sourceKind: "folder",
			folderRoot: "identity",
			kind: "identity",
			isGlobal: true,
			siteSlug: null,
			liveUrl: null,
		});
		const oldTokens = JSON.stringify({ colors: { accent: "#111111" } });
		const newTokens = JSON.stringify({ colors: { accent: "#ff5500" } });
		const patchManifest = [
			{ op: "merge_json" as const, path: "tokens.json", patch: { colors: { accent: "#ff5500" } } },
		];
		const stagedChange = change(CHANGES[0], 1, "staged", {
			surfaceId: identityId,
			kind: "folder_patch",
			affectedPaths: ["identity/tokens.json"],
			patchManifest,
		});
		const mergingChange = change(CHANGES[0], 1, "merging", {
			surfaceId: identityId,
			kind: "folder_patch",
			affectedPaths: ["identity/tokens.json"],
			patchManifest,
		});
		const mergedChange = change(CHANGES[0], 1, "merged", {
			surfaceId: identityId,
			kind: "folder_patch",
			affectedPaths: ["identity/tokens.json"],
			patchManifest,
		});
		const stagedSession = session(["staged"], { surfaceId: identityId, changes: [stagedChange] });
		const mergingSession = session(["merging"], { surfaceId: identityId, changes: [mergingChange] });
		const mergedSession = session(["merged"], { surfaceId: identityId, state: "completed", changes: [mergedChange] });

		const postMergeFiles = deferred<Record<string, string>>();
		const postPublishFiles = deferred<Record<string, string>>();
		const publishRpc = deferred<ReturnType<typeof summary>>();
		let loadCount = 0;
		const loadCloudFiles = vi.fn(async () => {
			loadCount += 1;
			if (loadCount === 1) return { "identity/tokens.json": oldTokens };
			if (loadCount === 2) return await postMergeFiles.promise;
			if (loadCount === 3) return await postPublishFiles.promise;
			return { "identity/tokens.json": JSON.stringify({ colors: { accent: "#00aa66" } }) };
		});

		const getSurfaceWorkspace = vi
			.fn()
			.mockResolvedValueOnce(workspace([stagedSession], { surface: identity }))
			.mockResolvedValue(
				workspace([], {
					surface: { ...identity, hasUnpublishedChanges: true, unpublishedChangeCount: 1 },
					recentHistory: [mergedSession],
				}),
			);

		const client = fakeClient({
			listSurfaces: vi.fn(async () => [identity]),
			getSurfaceWorkspace,
			approveSessionAll: vi.fn(async () => mergingSession),
			publishSurface: vi.fn(() => publishRpc.promise),
		});

		const store = storeWith(client, { loadCloudFiles, realtimeLive: () => true });
		await store.load();
		await store.openSurface("identity");
		await Promise.resolve();
		expect(loadCloudFiles).toHaveBeenCalledTimes(1);
		expect(store.surfaceUpdatePhase(identityId)).toBeNull();

		await store.approveAll(SESSION);
		expect(store.workspace(identityId)?.activeSessions).toHaveLength(1);
		expect(store.surfaceUpdatePhase(identityId)).toBe("merging");

		await store.refreshWorkspace(identityId);
		expect(store.workspace(identityId)?.activeSessions).toHaveLength(0);
		expect(store.surfaceUpdatePhase(identityId)).toBe("updating");
		expect(loadCloudFiles).toHaveBeenCalledTimes(2);
		expect(JSON.parse(effectiveStudioBaseFiles(store.state, identityId)?.["identity/tokens.json"] ?? "{}")).toEqual({
			colors: { accent: "#ff5500" },
		});
		expect(compiledCompanyIdentity(store.state)?.vars["--q-color-accent"]).toBe("#ff5500");

		postMergeFiles.resolve({ "identity/tokens.json": newTokens });
		await Promise.resolve();
		await Promise.resolve();
		expect(store.surfaceUpdatePhase(identityId)).toBeNull();
		expect(store.state.pendingStudioPatches[identityId]).toBeUndefined();
		expect(store.state.cloudSurfaceFiles[identityId]?.["identity/tokens.json"]).toBe(newTokens);

		const publishPromise = store.publish(identityId);
		expect(store.surfaceUpdatePhase(identityId)).toBe("publishing");
		publishRpc.resolve({
			...identity,
			hasUnpublishedChanges: false,
			unpublishedChangeCount: 0,
		});
		await publishPromise;
		expect(loadCloudFiles).toHaveBeenCalledTimes(3);
		expect(store.surfaceUpdatePhase(identityId)).toBe("updating");

		store.onFolderHint();
		vi.advanceTimersByTime(60);
		postPublishFiles.resolve({ "identity/tokens.json": newTokens });
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(loadCloudFiles).toHaveBeenCalledTimes(4);
		expect(store.surfaceUpdatePhase(identityId)).toBeNull();
		expect(store.state.cloudSurfaceFiles[identityId]?.["identity/tokens.json"]).toContain("#00aa66");
		store.dispose();
	});

	it("lists roots and reads studio files in parallel via readSurfaceFolderFiles", async () => {
		let activeLists = 0;
		let maxConcurrentLists = 0;
		let activeReads = 0;
		let maxConcurrentReads = 0;
		const encoder = new TextEncoder();
		const listGateA = deferred<void>();
		const listGateB = deferred<void>();
		const bothListsStarted = deferred<void>();
		const bothReadsStarted = deferred<void>();
		const readGates = [deferred<void>(), deferred<void>()];
		const folder = {
			list: vi.fn(async (parent: string | null) => {
				activeLists += 1;
				maxConcurrentLists = Math.max(maxConcurrentLists, activeLists);
				if (activeLists === 2) bothListsStarted.resolve();
				if (parent === "identity") await listGateA.promise;
				else await listGateB.promise;
				activeLists -= 1;
				if (parent === "identity") {
					return {
						entries: [
							{ path: "identity/tokens.json", kind: "file", file: { bytes: 16, id: 0 } },
							{ path: "identity/voice.md", kind: "file", file: { bytes: 16, id: 1 } },
							{ path: "identity/logo.png", kind: "file", file: { bytes: 16, id: 2 } },
						],
					};
				}
				return { entries: [] };
			}),
			readFile: vi.fn(async (file: { readonly bytes: number; readonly id: number }) => {
				activeReads += 1;
				maxConcurrentReads = Math.max(maxConcurrentReads, activeReads);
				if (activeReads === 2) bothReadsStarted.resolve();
				await readGates[file.id]!.promise;
				activeReads -= 1;
				return encoder.encode(file.id === 0 ? '{"accent":"#fff"}' : "Calm voice");
			}),
		};

		const promise = readSurfaceFolderFiles(
			folder,
			["identity", "QorperaOS/surfaces/identity/notes"],
			new AbortController().signal,
		);
		await bothListsStarted.promise;
		expect(maxConcurrentLists).toBe(2);
		listGateA.resolve();
		listGateB.resolve();
		await bothReadsStarted.promise;
		expect(maxConcurrentReads).toBe(2);
		readGates[0]!.resolve();
		readGates[1]!.resolve();

		const files = await promise;
		expect(files).toEqual({
			"identity/tokens.json": '{"accent":"#fff"}',
			"identity/voice.md": "Calm voice",
		});
	});

	it("polls composing/building previews, deduplicates in-flight polls, and pauses when the tab is hidden", async () => {
		vi.useFakeTimers();
		const fakeDoc = new EventTarget() as EventTarget & { visibilityState: DocumentVisibilityState };
		fakeDoc.visibilityState = "visible";
		const prevDocument = globalThis.document;
		Object.defineProperty(globalThis, "document", { configurable: true, value: fakeDoc });
		try {
			let pendingPoll = deferred<ReturnType<typeof workspace>>();
			let calls = 0;
			const client = fakeClient({
				getSurfaceWorkspace: vi.fn(async () => {
					calls += 1;
					if (calls === 1) {
						return workspace([session(["staged"])], {
							previewState: {
								surfaceId: SURFACE,
								mode: "single",
								primary: previewFrame({ status: "building", doorActionUrl: null, memberPass: null }),
								compareFrames: [],
							},
						});
					}
					return pendingPoll.promise;
				}),
			});
			const store = storeWith(client, { realtimeLive: () => false });
			await store.load();
			await store.openSurface("website");
			expect(calls).toBe(1);

			vi.advanceTimersByTime(4_100);
			expect(calls).toBe(2);
			vi.advanceTimersByTime(4_100);
			expect(calls).toBe(2);

			pendingPoll.resolve(
				workspace([session(["staged"])], {
					previewState: {
						surfaceId: SURFACE,
						mode: "single",
						primary: previewFrame({ status: "composing", doorActionUrl: null, memberPass: null }),
						compareFrames: [],
					},
				}),
			);
			await vi.advanceTimersByTimeAsync(0);

			fakeDoc.visibilityState = "hidden";
			fakeDoc.dispatchEvent(new Event("visibilitychange"));
			vi.advanceTimersByTime(12_000);
			expect(calls).toBe(2);

			pendingPoll = deferred<ReturnType<typeof workspace>>();
			fakeDoc.visibilityState = "visible";
			fakeDoc.dispatchEvent(new Event("visibilitychange"));
			expect(calls).toBe(3);

			pendingPoll.resolve(workspace([session(["staged"])]));
			await vi.advanceTimersByTimeAsync(0);
			store.dispose();
		} finally {
			Object.defineProperty(globalThis, "document", { configurable: true, value: prevDocument });
		}
	});

	it("coalesces rapid preview selection toggles and syncs setSessionChatOpen when switching exploration variants", async () => {
		const firstSync = deferred<ReturnType<typeof workspace>["previewState"]>();
		const secondSync = deferred<ReturnType<typeof workspace>["previewState"]>();
		const selections: { toggledChangeIds: string[]; explorationSessionId: string | null }[] = [];
		const setPreviewSelection = vi.fn(
			async (_surfaceId: string, sel: { toggledChangeIds: string[]; explorationSessionId: string | null }) => {
				selections.push(sel);
				return selections.length === 1 ? firstSync.promise : secondSync.promise;
			},
		);
		const setSessionChatOpen = vi.fn(async () => session(["staged"]));
		const variantA = session(["staged"], {
			id: "33333333-3333-4333-8333-333333333301",
			explorationId: "66666666-6666-4666-8666-666666666601",
			explorationVariantLabel: "Calm",
		});
		const variantB = session(["staged"], {
			id: "33333333-3333-4333-8333-333333333302",
			explorationId: "66666666-6666-4666-8666-666666666601",
			explorationVariantLabel: "Bold",
		});
		const baseSession = session(["staged", "staged"]);
		const client = fakeClient({
			getSurfaceWorkspace: vi.fn(async () =>
				workspace([baseSession, variantA, variantB], {
					explorations: [
						{
							id: "66666666-6666-4666-8666-666666666601",
							surfaceId: SURFACE,
							title: "Hero explorations",
							status: "open",
							chosenSessionId: null,
							variantSessionIds: [variantA.id, variantB.id],
							createdAt: "2026-10-16T09:00:00.000Z",
							resolvedAt: null,
						},
					],
					previewState: {
						surfaceId: SURFACE,
						mode: "single",
						primary: previewFrame({
							previewId: PREVIEW_IDS[0],
							toggledChangeIds: [CHANGES[0], CHANGES[1]],
						}),
						compareFrames: [],
					},
				}),
			),
			setPreviewSelection,
			setSessionChatOpen,
		});
		const store = storeWith(client);
		await store.load();
		await store.openSurface("website");

		const p1 = store.toggleChange(SURFACE, CHANGES[0]);
		const p2 = store.toggleChange(SURFACE, CHANGES[1]);
		expect(selections).toHaveLength(0);
		await new Promise((resolve) => setTimeout(resolve, 180));
		expect(selections).toHaveLength(1);
		expect(selections[0]?.toggledChangeIds).toEqual([]);

		const p2b = store.toggleChange(SURFACE, CHANGES[0]);
		firstSync.resolve({
			surfaceId: SURFACE,
			mode: "single",
			primary: previewFrame({ previewId: PREVIEW_IDS[0], toggledChangeIds: [] }),
			compareFrames: [],
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(selections).toHaveLength(2);
		expect(selections[1]?.toggledChangeIds).toEqual([CHANGES[0]]);

		secondSync.resolve({
			surfaceId: SURFACE,
			mode: "single",
			primary: previewFrame({ previewId: PREVIEW_IDS[1], toggledChangeIds: [CHANGES[0]] }),
			compareFrames: [],
		});
		await Promise.all([p1, p2, p2b]);
		expect(store.workspace(SURFACE)?.previewState.primary.previewId).toBe(PREVIEW_IDS[1]);

		store.openExplorationDrawer(SURFACE, "66666666-6666-4666-8666-666666666601");
		setSessionChatOpen.mockClear();
		const p3 = store.pickVariant(SURFACE, "66666666-6666-4666-8666-666666666601", variantB.id);
		await Promise.resolve();
		expect(setSessionChatOpen).toHaveBeenCalledWith(variantA.id, false);
		expect(setSessionChatOpen).toHaveBeenCalledWith(variantB.id, true);
		await p3;
		store.dispose();
	});

	it("tracks preview pass TTL/consumption, fences stale refreshes, scopes realtime hints, and applies partial multi-step mutations", async () => {
		vi.useFakeTimers();
		let mintCount = 0;
		const mintPreviewPass = vi.fn(async (previewId: string) => {
			mintCount += 1;
			return {
				previewId,
				doorActionUrl: "https://thetaband--p1.qorpera.com/__qorpera/member",
				memberPass: `${VALID_PASS.slice(0, -1)}${mintCount}`,
			};
		});
		const secondSurface = summary({
			id: "22222222-2222-4222-8222-222222222229",
			slug: "brand",
			title: "Brand",
			archetype: "studio",
			siteSlug: null,
			liveUrl: null,
		});
		const staleRefresh = deferred<ReturnType<typeof workspace>>();
		let websiteCalls = 0;
		const getSurfaceWorkspace = vi.fn(async (surfaceId: string) => {
			if (surfaceId === secondSurface.id) return workspace([], { surface: secondSurface });
			websiteCalls += 1;
			if (websiteCalls === 2) {
				return workspace([session(["staged", "staged"])], {
					previewState: {
						surfaceId: SURFACE,
						mode: "single",
						primary: previewFrame({ previewId: PREVIEW_IDS[0], doorActionUrl: null, memberPass: null }),
						compareFrames: [],
					},
				});
			}
			if (websiteCalls === 3) return staleRefresh.promise;
			if (websiteCalls === 4) {
				return workspace([], {
					surface: summary({ title: "Website (refreshed)" }),
					recentHistory: [session(["merged", "merged"], { state: "completed" })],
				});
			}
			return workspace([session(["staged", "staged"])], {
				previewState: {
					surfaceId: SURFACE,
					mode: "single",
					primary: previewFrame({ previewId: PREVIEW_IDS[0], doorActionUrl: null, memberPass: null }),
					compareFrames: [],
				},
			});
		});
		const approveDeferred = deferred<ReturnType<typeof session>>();
		let discardAttempts = 0;
		const client = fakeClient({
			listSurfaces: vi.fn(async () => [summary(), secondSurface]),
			getSurfaceWorkspace,
			mintPreviewPass,
			approveSurfaceChange: vi.fn(() => approveDeferred.promise),
			approveSessionAll: vi.fn(async () => session(["merged", "merged"])),
			discardSurfaceChange: vi.fn(async () => {
				discardAttempts += 1;
				if (discardAttempts === 1) return session(["discarded", "staged"]);
				throw new Error("second discard failed");
			}),
		});
		const store = storeWith(client);
		await store.load();
		await store.openSurface("brand");
		await store.openSurface("website");
		await Promise.resolve();
		await Promise.resolve();

		const pass1 = store.workspace(SURFACE)!.previewState.primary.memberPass!;
		expect(store.isPreviewPassUsable(PREVIEW_IDS[0], pass1)).toBe(true);
		vi.advanceTimersByTime(PREVIEW_PASS_TTL_MS + 1_000);
		expect(store.isPreviewPassUsable(PREVIEW_IDS[0], pass1)).toBe(false);

		store.markPreviewPassConsumed(PREVIEW_IDS[0], pass1);
		expect(await store.remintPreviewPass(SURFACE, PREVIEW_IDS[0], pass1)).toBe(true);
		const pass2 = store.workspace(SURFACE)!.previewState.primary.memberPass!;
		expect(pass2).not.toBe(pass1);
		expect(store.isPreviewPassUsable(PREVIEW_IDS[0], pass2)).toBe(true);

		mintPreviewPass.mockRejectedValueOnce(new Error("mint unavailable"));
		expect(await store.remintPreviewPass(SURFACE, PREVIEW_IDS[0], pass2)).toBe(false);
		expect(store.isPreviewPassUsable(PREVIEW_IDS[0], pass2)).toBe(false);

		await store.refreshWorkspace(SURFACE);
		await Promise.resolve();
		await Promise.resolve();
		const pass3 = store.workspace(SURFACE)!.previewState.primary.memberPass!;
		expect(pass3).not.toBe(pass2);
		expect(store.isPreviewPassUsable(PREVIEW_IDS[0], pass3)).toBe(true);

		const slowPromise = store.refreshWorkspace(SURFACE);
		store.openDrawer(SURFACE, SESSION);
		const approvePromise = store.approveChange(SESSION, CHANGES[0]);
		store.closeDrawer();
		approveDeferred.resolve(session(["merged", "merged"], { state: "completed" }));
		expect(await approvePromise).toBe("history");
		expect(store.workspace(SURFACE)?.recentHistory.map((s) => s.id)).toEqual([SESSION]);

		staleRefresh.resolve(workspace([session(["staged", "staged"])]));
		await slowPromise;
		expect(store.workspace(SURFACE)?.recentHistory.map((s) => s.id)).toEqual([SESSION]);
		expect(store.workspace(SURFACE)?.surface.title).toBe("Website (refreshed)");

		getSurfaceWorkspace.mockClear();
		store.onRealtimeHint("surfaces");
		vi.advanceTimersByTime(200);
		expect(getSurfaceWorkspace).toHaveBeenCalledWith(SURFACE);
		expect(getSurfaceWorkspace).not.toHaveBeenCalledWith(secondSurface.id);

		vi.advanceTimersByTime(SURFACE_UNDO_MS);
		await store.approveAll(SESSION);
		expect(store.state.undo).toBeUndefined();

		await store.refreshWorkspace(SURFACE);
		expect(await store.discardSession(SESSION)).toBe(false);
		expect(store.session(SESSION)?.changes[0]?.status).toBe("discarded");
		store.dispose();
	});

	it("runs a queued dirty refresh and clears updating flags even when an earlier loadCloudFiles call resolves undefined, and matches worker path normalization", async () => {
		const identityId = "22222222-2222-4222-8222-222222222279";
		const identity = summary({
			id: identityId,
			slug: "identity",
			title: "Identity",
			archetype: "studio",
			sourceKind: "folder",
			folderRoot: "identity",
			kind: "identity",
			isGlobal: true,
			siteSlug: null,
			liveUrl: null,
		});
		const firstLoad = deferred<Record<string, string> | undefined>();
		const secondLoad = deferred<Record<string, string> | undefined>();
		let calls = 0;
		const loadCloudFiles = vi.fn(() => {
			calls += 1;
			return calls === 1 ? firstLoad.promise : secondLoad.promise;
		});
		const client = fakeClient({
			listSurfaces: vi.fn(async () => [identity]),
			getSurfaceWorkspace: vi.fn(async () => workspace([], { surface: identity })),
		});
		const store = storeWith(client, { loadCloudFiles });
		await store.load();
		await store.openSurface("identity");
		expect(loadCloudFiles).toHaveBeenCalledTimes(1);
		expect(store.isCloudFilesLoading(identityId)).toBe(true);

		const dirtyRefresh = store.refreshCloudFiles(identity, { visible: true });
		expect(store.surfaceUpdatePhase(identityId)).toBe("updating");

		firstLoad.resolve(undefined);
		await dirtyRefresh;
		await Promise.resolve();
		expect(loadCloudFiles).toHaveBeenCalledTimes(2);
		expect(store.surfaceUpdatePhase(identityId)).toBe("updating");

		secondLoad.resolve({ "identity/tokens.json": '{"colors":{"accent":"#336699"}}' });
		await Promise.resolve();
		await Promise.resolve();
		expect(store.isCloudFilesLoading(identityId)).toBe(false);
		expect(store.surfaceUpdatePhase(identityId)).toBeNull();
		expect(store.state.cloudSurfaceFiles[identityId]?.["identity/tokens.json"]).toContain("#336699");

		expect(
			normalizeStudioPatchOps(
				[
					{ op: "write_text", path: "QorperaOS/surfaces/identity/notes/a.md", content: "note" },
					{ op: "write_text", path: "identity/tokens.json", content: "{}" },
					{ op: "write_text", path: "voice.md", content: "hi" },
				],
				"identity",
			).map((op) => op.path),
		).toEqual(["identity/QorperaOS/surfaces/identity/notes/a.md", "identity/tokens.json", "identity/voice.md"]);
		store.dispose();
	});

	it("reloads cloud files when a previously visited studio surface unmerges or merges during a background poll", async () => {
		vi.useFakeTimers();
		const studioId = "22222222-2222-4222-8222-222222222281";
		const otherId = "22222222-2222-4222-8222-222222222282";
		const studio = summary({
			id: studioId,
			slug: "brand",
			title: "Brand",
			archetype: "studio",
			sourceKind: "folder",
			folderRoot: "brand",
			kind: "brand",
			siteSlug: null,
			liveUrl: null,
			activeSessionCount: 1,
			runningSessionCount: 1,
		});
		const other = summary({
			id: otherId,
			slug: "shop",
			title: "Shop",
			activeSessionCount: 0,
			runningSessionCount: 0,
		});
		const patchManifest = [
			{ op: "merge_json" as const, path: "tokens.json", patch: { colors: { accent: "#ff5500" } } },
		];
		const mergedChange = change(CHANGES[0], 1, "merged", {
			surfaceId: studioId,
			kind: "folder_patch",
			affectedPaths: ["brand/tokens.json"],
			patchManifest,
		});
		const stagedChange = change(CHANGES[0], 1, "staged", {
			surfaceId: studioId,
			kind: "folder_patch",
			affectedPaths: ["brand/tokens.json"],
			patchManifest,
		});
		const baseTokens = JSON.stringify({ colors: { accent: "#224466" } });
		const mergedTokens = JSON.stringify({ colors: { accent: "#ff5500" } });
		let studioSession = session([], {
			surfaceId: studioId,
			state: "running",
			changes: [mergedChange],
		});
		let folderTokens = mergedTokens;
		const loadCloudFiles = vi.fn(
			async (surface: ReturnType<typeof summary>): Promise<Record<string, string>> =>
				surface.id === studioId ? { "brand/tokens.json": folderTokens } : {},
		);
		const getSurfaceWorkspace = vi.fn(async (surfaceId: string) =>
			surfaceId === studioId ? workspace([studioSession], { surface: studio }) : workspace([], { surface: other }),
		);
		const store = storeWith(
			fakeClient({
				listSurfaces: vi.fn(async () => [studio, other]),
				getSurfaceWorkspace,
			}),
			{ loadCloudFiles, realtimeLive: () => false },
		);

		await store.load();
		await store.openSurface("brand");
		await Promise.resolve();
		expect(loadCloudFiles).toHaveBeenCalledTimes(1);
		expect(JSON.parse(effectiveStudioBaseFiles(store.state, studioId)?.["brand/tokens.json"] ?? "{}")).toEqual({
			colors: { accent: "#ff5500" },
		});

		await store.openSurface("shop");
		await Promise.resolve();
		const loadsOnShop = loadCloudFiles.mock.calls.length;

		studioSession = session([], {
			surfaceId: studioId,
			state: "ready",
			changes: [stagedChange],
		});
		folderTokens = baseTokens;
		await vi.advanceTimersByTimeAsync(4_100);
		expect(loadCloudFiles.mock.calls.length).toBeGreaterThan(loadsOnShop);

		await store.openSurface("brand");
		await Promise.resolve();
		expect(JSON.parse(effectiveStudioBaseFiles(store.state, studioId)?.["brand/tokens.json"] ?? "{}")).toEqual({
			colors: { accent: "#224466" },
		});
		expect(store.state.pendingStudioPatches[studioId]).toBeUndefined();

		studioSession = session([], {
			surfaceId: studioId,
			state: "running",
			changes: [stagedChange],
		});
		await store.openSurface("brand");
		await store.openSurface("shop");
		await Promise.resolve();
		const loadsBeforeMerge = loadCloudFiles.mock.calls.length;

		studioSession = session([], {
			surfaceId: studioId,
			state: "ready",
			changes: [mergedChange],
		});
		folderTokens = mergedTokens;
		await vi.advanceTimersByTimeAsync(4_100);
		expect(loadCloudFiles.mock.calls.length).toBeGreaterThan(loadsBeforeMerge);

		await store.openSurface("brand");
		await Promise.resolve();
		expect(JSON.parse(effectiveStudioBaseFiles(store.state, studioId)?.["brand/tokens.json"] ?? "{}")).toEqual({
			colors: { accent: "#ff5500" },
		});
		expect(store.state.pendingStudioPatches[studioId]).toBeUndefined();
		store.dispose();
	});

	it("auto-composes when change headSha or liveHeadSha advances, avoids infinite failed-preview loops, supports retryPreview, and resets to live_baseline when last change closes", async () => {
		let currentHeadSha = "a".repeat(40);
		let currentLiveSha = "1".repeat(40);
		let currentStatus: "ready" | "failed" = "ready";
		let hasOpen = true;
		const setPreviewSelection = vi.fn(
			async (_surfaceId: string, sel: { toggledChangeIds: string[]; explorationSessionId: string | null }) => ({
				surfaceId: SURFACE,
				mode: "single" as const,
				primary:
					sel.toggledChangeIds.length === 0
						? previewFrame({
								previewId: null,
								status: "live_baseline",
								toggledChangeIds: [],
								doorActionUrl: null,
								memberPass: null,
							})
						: previewFrame({
								previewId: currentStatus === "failed" ? PREVIEW_IDS[0] : PREVIEW_IDS[1],
								status: currentStatus,
								toggledChangeIds: sel.toggledChangeIds,
								errorDetail: currentStatus === "failed" ? "Build error" : null,
							}),
				compareFrames: [],
			}),
		);
		const client = fakeClient({
			getSurfaceWorkspace: vi.fn(async () =>
				workspace(
					hasOpen
						? [
								session(["staged"], {
									changes: [
										change(CHANGES[0], 1, "staged", { parentSha: currentLiveSha, headSha: currentHeadSha }),
									],
								}),
							]
						: [],
					{
						surface: summary({ liveHeadSha: currentLiveSha }),
						previewState: {
							surfaceId: SURFACE,
							mode: "single",
							primary: previewFrame({
								previewId: PREVIEW_IDS[0],
								status: currentStatus,
								toggledChangeIds: [CHANGES[0]],
								errorDetail: currentStatus === "failed" ? "Build error" : null,
							}),
							compareFrames: [],
						},
					},
				),
			),
			setPreviewSelection,
		});
		const store = storeWith(client);
		await store.load();
		await store.openSurface("website");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(setPreviewSelection).toHaveBeenCalledTimes(0);

		currentStatus = "failed";
		await store.refreshWorkspace(SURFACE);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(setPreviewSelection).toHaveBeenCalledTimes(0);

		await store.retryPreview(SURFACE);
		expect(setPreviewSelection).toHaveBeenCalledTimes(1);

		currentStatus = "ready";
		currentHeadSha = "b".repeat(40);
		await store.refreshWorkspace(SURFACE);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(setPreviewSelection).toHaveBeenCalledTimes(2);

		currentLiveSha = "2".repeat(40);
		await store.refreshWorkspace(SURFACE);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(setPreviewSelection).toHaveBeenCalledTimes(3);

		hasOpen = false;
		await store.refreshWorkspace(SURFACE);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(setPreviewSelection).toHaveBeenCalledTimes(4);
		expect(store.workspace(SURFACE)?.previewState.primary.status).toBe("live_baseline");
		store.dispose();
	});

	it("polls composing/building previews at fast 1s cadence and sends compareSessionIds on compareExploration", async () => {
		vi.useFakeTimers();
		const variantA = session(["staged"], {
			id: "33333333-3333-4333-8333-333333333311",
			explorationId: "66666666-6666-4666-8666-666666666611",
			explorationVariantLabel: "Minimal",
			branchHeadSha: "a".repeat(40),
		});
		const variantB = session(["staged"], {
			id: "33333333-3333-4333-8333-333333333312",
			explorationId: "66666666-6666-4666-8666-666666666611",
			explorationVariantLabel: "Bold",
			branchHeadSha: "b".repeat(40),
		});
		let wsCalls = 0;
		const setPreviewSelection = vi.fn(
			async (
				_id: string,
				sel: { toggledChangeIds: string[]; explorationSessionId: string | null; compareSessionIds?: string[] },
			) => ({
				surfaceId: SURFACE,
				mode: (sel.compareSessionIds && sel.compareSessionIds.length >= 2 ? "compare" : "single") as
					| "compare"
					| "single",
				primary: previewFrame({
					status: "building",
					doorActionUrl: null,
					memberPass: null,
					toggledChangeIds: sel.toggledChangeIds,
				}),
				compareFrames: (sel.compareSessionIds ?? []).map((sid) => ({
					sessionId: sid,
					label: sid,
					frame: previewFrame({ status: "composing", doorActionUrl: null, memberPass: null }),
				})),
			}),
		);
		const client = fakeClient({
			getSurfaceWorkspace: vi.fn(async () => {
				wsCalls += 1;
				return workspace([variantA, variantB], {
					explorations: [
						{
							id: "66666666-6666-4666-8666-666666666611",
							surfaceId: SURFACE,
							title: "Header exploration",
							status: "open",
							chosenSessionId: null,
							variantSessionIds: [variantA.id, variantB.id],
							createdAt: "2026-10-16T09:00:00.000Z",
							resolvedAt: null,
						},
					],
					previewState: {
						surfaceId: SURFACE,
						mode: "single",
						primary: previewFrame({
							status: "building",
							doorActionUrl: null,
							memberPass: null,
							toggledChangeIds: [],
						}),
						compareFrames: [],
					},
				});
			}),
			setPreviewSelection,
		});
		const store = storeWith(client, { realtimeLive: () => false });
		await store.load();
		await store.openSurface("website");
		expect(wsCalls).toBe(1);

		await vi.advanceTimersByTimeAsync(1_050);
		expect(wsCalls).toBe(2);

		setPreviewSelection.mockClear();
		store.compareExploration("66666666-6666-4666-8666-666666666611");
		await vi.advanceTimersByTimeAsync(0);
		expect(setPreviewSelection).toHaveBeenCalledWith(SURFACE, {
			toggledChangeIds: [],
			explorationSessionId: variantA.id,
			compareSessionIds: [variantA.id, variantB.id],
		});
		store.dispose();
	});

	it("shows pending Merging toast for async merges until merged, and defers markPublished until async publish finishes", async () => {
		vi.useFakeTimers();
		let wsState: "staged" | "merging" | "merged" = "staged";
		let pubStatus: "idle" | "publishing" | "failed" = "idle";
		const undoSurfaceChange = vi.fn(async () => session(["staged"]));
		const client = fakeClient({
			getSurfaceWorkspace: vi.fn(async () =>
				workspace(wsState === "merged" ? [] : [session([wsState])], {
					surface: summary({
						publishStatus: pubStatus,
						lastPublishError: pubStatus === "failed" ? "Build exited 1" : null,
						hasUnpublishedChanges: wsState === "merged" && pubStatus !== "idle",
						unpublishedChangeCount: wsState === "merged" && pubStatus !== "idle" ? 1 : 0,
					}),
					recentHistory: wsState === "merged" ? [session(["merged"], { state: "completed" })] : [],
				}),
			),
			approveSurfaceChange: vi.fn(async () => {
				wsState = "merging";
				return session(["merging"]);
			}),
			undoSurfaceChange,
			publishSurface: vi.fn(async () => {
				pubStatus = "publishing";
				return summary({ publishStatus: "publishing", hasUnpublishedChanges: true, unpublishedChangeCount: 1 });
			}),
		});
		const store = storeWith(client, { realtimeLive: () => false });
		await store.load();
		await store.openSurface("website");

		await store.approveChange(SESSION, CHANGES[0]);
		expect(store.state.undo?.pending).toBe(true);
		expect(await store.undo()).toBe(false);
		expect(undoSurfaceChange).not.toHaveBeenCalled();

		wsState = "merged";
		pubStatus = "publishing";
		await store.refreshWorkspace(SURFACE);
		expect(store.state.undo?.pending).toBeUndefined();
		expect(store.state.undo?.changeIds).toEqual([CHANGES[0]]);

		await store.publish(SURFACE);
		expect(store.state.publishedChangeIds[CHANGES[0]]).toBeUndefined();
		expect(unpublishedChanges(store.state, SURFACE)).toHaveLength(1);

		pubStatus = "failed";
		await store.refreshWorkspace(SURFACE);
		expect(store.state.publishedChangeIds[CHANGES[0]]).toBeUndefined();
		expect(store.workspace(SURFACE)?.surface.lastPublishError).toBe("Build exited 1");

		await store.publish(SURFACE);
		expect(store.state.publishedChangeIds[CHANGES[0]]).toBeUndefined();
		pubStatus = "idle";
		await store.refreshWorkspace(SURFACE);
		expect(store.state.publishedChangeIds[CHANGES[0]]).toBe(true);
		store.dispose();
	});

	it("skips generated directories, caps subfolder walks, and enforces a byte budget in readSurfaceFolderFiles", async () => {
		const listedPaths: string[] = [];
		const readPaths: string[] = [];
		const chunk = "x".repeat(250_000);
		const tokens = JSON.stringify({ colors: { accent: "#2563eb" } });
		const folder = {
			list: vi.fn(async (path: string) => {
				listedPaths.push(path);
				if (path === "repo") {
					return {
						entries: [
							{ path: "repo/node_modules", kind: "folder" as const, file: null },
							{ path: "repo/.git", kind: "folder" as const, file: null },
							{ path: "repo/dist", kind: "folder" as const, file: null },
							{
								path: "repo/tokens.json",
								kind: "file" as const,
								file: { path: "repo/tokens.json", bytes: tokens.length },
							},
							...["a", "b", "c", "d", "e"].map((name) => ({
								path: `repo/${name}.txt`,
								kind: "file" as const,
								file: { path: `repo/${name}.txt`, bytes: chunk.length },
							})),
							...Array.from({ length: 16 }, (_, idx) => ({
								path: `repo/sub-${String(idx + 1).padStart(2, "0")}`,
								kind: "folder" as const,
								file: null,
							})),
						],
					};
				}
				return { entries: [] };
			}),
			readFile: vi.fn(async (file: { readonly path: string; readonly bytes: number }) => {
				readPaths.push(file.path);
				return new TextEncoder().encode(file.path === "repo/tokens.json" ? tokens : chunk);
			}),
		};

		const files = await readSurfaceFolderFiles(folder, ["repo"], new AbortController().signal);
		expect(listedPaths).not.toContain("repo/node_modules");
		expect(listedPaths).not.toContain("repo/.git");
		expect(listedPaths).not.toContain("repo/dist");
		expect(listedPaths.filter((path) => path.startsWith("repo/sub-"))).toHaveLength(12);
		expect(files["repo/tokens.json"]).toContain("#2563eb");
		expect(readPaths[0]).toBe("repo/tokens.json");
		const totalBytes = Object.values(files).reduce((sum, text) => sum + text.length, 0);
		expect(totalBytes).toBeLessThanOrEqual(1024 * 1024);
		expect(Object.keys(files).filter((path) => path.endsWith(".txt")).length).toBeLessThan(5);
	});
});
