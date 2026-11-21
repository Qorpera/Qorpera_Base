import type { SurfaceChangeUnit, SurfaceSession, SurfaceSummary, SurfaceWorkspace } from "@qorpera/contracts";
import { vi } from "vitest";
import { type SurfacesClient, SurfacesStore, synthesizeMigration } from "../src/app/surfaces-store.ts";

export const COMPANY = "11111111-1111-4111-8111-111111111111";
export const SURFACE = "22222222-2222-4222-8222-222222222222";
export const SESSION = "33333333-3333-4333-8333-333333333333";
export const CHANGES = [
	"44444444-4444-4444-8444-444444444441",
	"44444444-4444-4444-8444-444444444442",
	"44444444-4444-4444-8444-444444444443",
] as const;
const NOW = "2026-11-21T10:00:00.000Z";

export function summary(overrides: Partial<SurfaceSummary> = {}): SurfaceSummary {
	return {
		id: SURFACE,
		slug: "website",
		title: "Website",
		group: "products",
		archetype: "live_build",
		status: "active",
		icon: "globe",
		sourceKind: "code_repo",
		repositoryKey: "thetaband/site",
		folderRoot: null,
		siteSlug: "thetaband",
		previewMode: "static_site",
		autoPublish: false,
		liveUrl: "https://thetaband.dk",
		hasUnpublishedChanges: false,
		unpublishedChangeCount: 0,
		activeSessionCount: 1,
		runningSessionCount: 0,
		pendingChangeCount: 3,
		needsAttentionCount: 0,
		sortOrder: 0,
		...overrides,
	};
}

export function change(id: string, seq: number, status: SurfaceChangeUnit["status"] = "staged"): SurfaceChangeUnit {
	return {
		id,
		sessionId: SESSION,
		surfaceId: SURFACE,
		seq,
		title: `Change ${seq}`,
		summary: "",
		kind: "git_range",
		status,
		parentSha: null,
		headSha: null,
		dependsOnChangeIds: [],
		affectedPaths: [],
		diffStats: null,
		conflictPaths: null,
		landedChangeNumber: null,
		canUndo: status === "merged",
		createdAt: NOW,
		resolvedAt: null,
	};
}

export function session(
	statuses: readonly SurfaceChangeUnit["status"][],
	overrides: Partial<SurfaceSession> = {},
): SurfaceSession {
	const changes = statuses.map((status, index) => change(CHANGES[index]!, index + 1, status));
	return {
		id: SESSION,
		surfaceId: SURFACE,
		workerId: null,
		title: "Forudbestilling & konvertering",
		prompt: "Gør forudbestillingen mere overbevisende",
		state: "ready",
		originKind: "member",
		originLabel: null,
		explorationId: null,
		explorationVariantLabel: null,
		hasActiveChat: false,
		question: null,
		changes,
		openChangeCount: changes.filter((item) => item.status === "staged").length,
		createdAt: NOW,
		updatedAt: NOW,
		closedAt: null,
		...overrides,
	};
}

export function workspace(active: readonly SurfaceSession[]): SurfaceWorkspace {
	return {
		surface: summary(),
		briefSummary: null,
		activeSessions: active,
		recentHistory: [],
		explorations: [],
		previewState: {
			surfaceId: SURFACE,
			mode: "single",
			primary: {
				previewId: null,
				status: "live_baseline",
				doorActionUrl: null,
				memberPass: null,
				activeRoute: "/",
				toggledChangeIds: [],
				conflictReport: null,
				errorDetail: null,
			},
			compareFrames: [],
		},
	};
}

export function fakeClient(overrides: Partial<SurfacesClient> = {}): SurfacesClient {
	const fail = () => Promise.reject(new Error("not stubbed"));
	return {
		listSurfaces: vi.fn(async () => [summary()]),
		getSurfaceWorkspace: vi.fn(async () => workspace([session(["staged", "staged", "staged"])])),
		setSurfaceAutoPublish: vi.fn(async (_id: string, enabled: boolean) => summary({ autoPublish: enabled })),
		startSurfaceSession: vi.fn(fail),
		replySurfaceSession: vi.fn(fail),
		setSessionChatOpen: vi.fn(async () => session(["staged", "staged", "staged"])),
		approveSurfaceChange: vi.fn(fail),
		approveSessionAll: vi.fn(fail),
		discardSurfaceChange: vi.fn(fail),
		undoSurfaceChange: vi.fn(fail),
		chooseExploration: vi.fn(fail),
		setPreviewSelection: vi.fn(fail),
		publishSurface: vi.fn(async () => summary({ unpublishedChangeCount: 0 })),
		listAutomations: vi.fn(async () => []),
		toggleAutomation: vi.fn(fail),
		getMigrationChecklist: vi.fn(async () => synthesizeMigration({ companyId: COMPANY, agents: [], boards: [] })),
		applyMigrationChecklist: vi.fn(fail),
		...overrides,
	} as SurfacesClient;
}

export function storeWith(client: SurfacesClient | undefined) {
	return new SurfacesStore({
		companyId: COMPANY,
		client,
		synthesize: () => ({
			companyId: COMPANY,
			sites: [{ slug: "thetaband", title: "Thetaband", kind: "files", state: "live", url: "https://thetaband.dk" }],
			pages: ["mailbox", "bank"],
		}),
		migration: () => ({
			companyId: COMPANY,
			agents: [{ id: CHANGES[0], handle: "market", name: "Market Watcher", role: "Research" }],
			boards: [{ name: "concepts", title: "Concepts", kit: null }],
		}),
		signal: new AbortController().signal,
		unavailableMessage: "Surfaces aren't enabled for this company yet.",
	});
}
