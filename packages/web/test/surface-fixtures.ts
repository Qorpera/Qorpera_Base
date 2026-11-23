import type {
	PointToChangeTarget,
	SurfaceChangeUnit,
	SurfacePreviewFrameState,
	SurfaceSession,
	SurfaceSessionMessage,
	SurfaceSummary,
	SurfaceWorkspace,
} from "@qorpera/contracts";
import { vi } from "vitest";
import {
	type SurfacesClient,
	SurfacesStore,
	type SurfacesStoreOptions,
	synthesizeMigration,
} from "../src/app/surfaces-store.ts";
import type {
	AddedSiteDomain,
	CompanySiteHostingState,
	CustomDomainStatus,
	SiteCustomDomain,
	WebSiteHosting,
} from "../src/cloud/site-hosting.ts";

export const COMPANY = "11111111-1111-4111-8111-111111111111";
export const SURFACE = "22222222-2222-4222-8222-222222222222";
export const SESSION = "33333333-3333-4333-8333-333333333333";
export const CHANGES = [
	"44444444-4444-4444-8444-444444444441",
	"44444444-4444-4444-8444-444444444442",
	"44444444-4444-4444-8444-444444444443",
] as const;
export const PREVIEW_IDS = ["66666666-6666-4666-8666-666666666661", "66666666-6666-4666-8666-666666666662"] as const;
export const MESSAGE_IDS = [
	"77777777-7777-4777-8777-777777777771",
	"77777777-7777-4777-8777-777777777772",
	"77777777-7777-4777-8777-777777777773",
	"77777777-7777-4777-8777-777777777774",
] as const;
export const VALID_PASS = "B".repeat(43);
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

export function change(
	id: string,
	seq: number,
	status: SurfaceChangeUnit["status"] = "staged",
	overrides: Partial<SurfaceChangeUnit> = {},
): SurfaceChangeUnit {
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
		...overrides,
	};
}

export function sessionMessage(
	id: string,
	authorKind: SurfaceSessionMessage["authorKind"],
	text: string,
	overrides: Partial<SurfaceSessionMessage> = {},
): SurfaceSessionMessage {
	return {
		id,
		sessionId: SESSION,
		authorKind,
		text,
		changeId: null,
		createdAt: NOW,
		...overrides,
	};
}

export function pointTarget(overrides: Partial<PointToChangeTarget> = {}): PointToChangeTarget {
	return {
		route: "/pricing",
		selector: "main > section.hero > button.cta",
		textSnippet: "Forudbestil · 1.995 kr.",
		tagName: "BUTTON",
		componentHint: "PreorderCta",
		boundingBox: { x: 120, y: 340, width: 220, height: 48 },
		viewport: { width: 1280, height: 800 },
		...overrides,
	};
}

export function previewFrame(overrides: Partial<SurfacePreviewFrameState> = {}): SurfacePreviewFrameState {
	return {
		previewId: PREVIEW_IDS[0],
		status: "ready",
		doorActionUrl: "https://thetaband--p12ab34cd.qorpera.com/__qorpera/member",
		memberPass: VALID_PASS,
		activeRoute: "/",
		toggledChangeIds: [CHANGES[0]],
		conflictReport: null,
		errorDetail: null,
		...overrides,
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
		messages: [],
		openChangeCount: changes.filter((item) => item.status === "staged" || item.status === "conflicted").length,
		createdAt: NOW,
		updatedAt: NOW,
		closedAt: null,
		...overrides,
	};
}

export function workspace(
	active: readonly SurfaceSession[],
	overrides: Partial<SurfaceWorkspace> = {},
): SurfaceWorkspace {
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
		...overrides,
	};
}

export function fakeClient(overrides: Partial<SurfacesClient> = {}): SurfacesClient {
	const fail = () => Promise.reject(new Error("not stubbed"));
	return {
		listSurfaces: vi.fn(async () => [summary()]),
		getSurfaceWorkspace: vi.fn(async () => workspace([session(["staged", "staged", "staged"])])),
		approveProposedSurface: vi.fn(async (id: string) => summary({ id, status: "active" })),
		archiveSurface: vi.fn(async (id: string) => summary({ id, status: "archived" })),
		setSurfaceAutoPublish: vi.fn(async (_id: string, enabled: boolean) => summary({ autoPublish: enabled })),
		startSurfaceSession: vi.fn(fail),
		replySurfaceSession: vi.fn(fail),
		setSessionChatOpen: vi.fn(async () => session(["staged", "staged", "staged"])),
		approveSurfaceChange: vi.fn(fail),
		approveSessionAll: vi.fn(fail),
		discardSurfaceChange: vi.fn(fail),
		undoSurfaceChange: vi.fn(fail),
		chooseExploration: vi.fn(fail),
		reconcileChanges: vi.fn(fail),
		spawnCrossSurfaceSession: vi.fn(fail),
		setPreviewSelection: vi.fn(fail),
		publishSurface: vi.fn(async () => summary({ unpublishedChangeCount: 0 })),
		listAutomations: vi.fn(async () => []),
		toggleAutomation: vi.fn(fail),
		getMigrationChecklist: vi.fn(async () => synthesizeMigration({ companyId: COMPANY, agents: [], boards: [] })),
		applyMigrationChecklist: vi.fn(fail),
		...overrides,
	} as SurfacesClient;
}

export function storeWith(client: SurfacesClient | undefined, extra: Partial<SurfacesStoreOptions> = {}) {
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
		...extra,
	});
}

export const HOSTED_SITE = "77777777-7777-4777-8777-777777777701";

export function siteDomain(
	hostname: string,
	status: CustomDomainStatus = "pending_dns",
	overrides: Partial<SiteCustomDomain> = {},
): SiteCustomDomain {
	return {
		id: "77777777-7777-4777-8777-7777777777a1",
		hostname,
		isApex: hostname.split(".").length === 2,
		isPrimary: false,
		status,
		verificationToken: "9f3a1c",
		lastCheckedAt: null,
		verifiedAt: null,
		tlsActiveAt: null,
		lastError: null,
		...overrides,
	};
}

export interface HostingWorld {
	entry: { isPublic: boolean; domains: SiteCustomDomain[] } | null;
	publicEnabled: boolean;
	domainsEnabled: boolean;
}

export function fakeSiteHosting(world: Partial<HostingWorld> = {}) {
	const now: HostingWorld = {
		entry: { isPublic: false, domains: [] },
		publicEnabled: true,
		domainsEnabled: true,
		...world,
	};
	const state = (): CompanySiteHostingState => ({
		hostsDomain: "qorpera.com",
		hostsEnabled: true,
		publicEnabled: now.publicEnabled,
		domainsEnabled: now.domainsEnabled,
		edgeIpv4: "203.0.113.7",
		edgeIpv6: "2001:db8::7",
		edgeCnameTarget: "edge.qorpera.com",
		sites: new Map(
			now.entry
				? [
						[
							HOSTED_SITE,
							{
								siteId: HOSTED_SITE,
								slug: "thetaband",
								isPublic: now.entry.isPublic,
								deploymentKind: "static" as const,
								storageMode: "db" as const,
								liveDeploymentId: null,
								domains: now.entry.domains.map((domain) => ({ ...domain })),
							},
						],
					]
				: [],
		),
	});
	let made = 0;
	const client = {
		read: vi.fn(async (_signal?: AbortSignal) => state()),
		setPublic: vi.fn(async (_siteId: string, isPublic: boolean, _signal?: AbortSignal) => {
			if (now.entry) now.entry.isPublic = isPublic;
			return isPublic;
		}),
		addDomain: vi.fn(
			async (siteId: string, hostname: string, isApex: boolean, _signal?: AbortSignal): Promise<AddedSiteDomain> => {
				made++;
				const domain = siteDomain(hostname, "pending_dns", {
					id: `77777777-7777-4777-8777-7777777777b${made}`,
					isApex,
				});
				now.entry?.domains.push(domain);
				return {
					id: domain.id,
					siteId,
					hostname,
					isApex,
					isPrimary: false,
					status: "pending_dns",
					verificationToken: domain.verificationToken,
					dns: {
						recordType: isApex ? "A" : "CNAME",
						ipv4: "203.0.113.7",
						ipv6: "2001:db8::7",
						cnameTarget: "edge.qorpera.com",
						txtHost: `_qorpera.${hostname}`,
						txtValue: `qorpera-verify=${domain.verificationToken}`,
					},
				};
			},
		),
		removeDomain: vi.fn(async (domainId: string, _signal?: AbortSignal) => {
			if (now.entry) now.entry.domains = now.entry.domains.filter((domain) => domain.id !== domainId);
			return true;
		}),
		setPrimaryDomain: vi.fn(async (domainId: string, _signal?: AbortSignal) => {
			let hostname = "";
			if (now.entry)
				now.entry.domains = now.entry.domains.map((domain) => {
					if (domain.id === domainId) hostname = domain.hostname;
					return { ...domain, isPrimary: domain.id === domainId };
				});
			return hostname;
		}),
		recheckDomain: vi.fn(
			async (domainId: string, _signal?: AbortSignal): Promise<CustomDomainStatus> =>
				now.entry?.domains.find((domain) => domain.id === domainId)?.status ?? "pending_dns",
		),
	} satisfies WebSiteHosting;
	return { client, world: now };
}
