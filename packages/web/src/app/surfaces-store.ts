import { composeStudioPreview } from "@qorpera/cloud-client/surface-studio-patches";
import {
	type ApplySurfaceMigrationInput,
	type CloudSurfacesClient,
	isMissingSurfaceRpcError,
	type StartSurfaceSessionOptions,
} from "@qorpera/cloud-client/surfaces";
import {
	type CrossSurfaceHandoffRequest,
	countOpenSurfaceChanges,
	nextSurfaceSessionLifecycleState,
	OPEN_SURFACE_CHANGE_STATUSES,
	RUNNING_SURFACE_SESSION_STATES,
	type StudioPatchOp,
	type SurfaceAutomationSummary,
	type SurfaceChangeUnit,
	type SurfaceExplorationSet,
	type SurfaceMigrationChecklist,
	type SurfacePreviewCompositionState,
	type SurfaceSession,
	type SurfaceSummary,
	type SurfaceWorkspace,
} from "@qorpera/contracts";
import { phrase, t } from "../ui/preferences.ts";
import { Store } from "./state.ts";
import { isOpsKind, type SurfaceKind, type SurfaceLook, surfaceLookOf } from "./surface-kinds.ts";
import {
	isThetabandCompany,
	slugifySurfaceTitle,
	starterOrchestrationPlan,
	starterStudioFiles,
	synthesizeLocalChanges,
} from "./surface-local-sandbox.ts";

export type SurfacesClient = Pick<
	CloudSurfacesClient,
	| "listSurfaces"
	| "getSurfaceWorkspace"
	| "approveProposedSurface"
	| "archiveSurface"
	| "setSurfaceAutoPublish"
	| "startSurfaceSession"
	| "replySurfaceSession"
	| "setSessionChatOpen"
	| "approveSurfaceChange"
	| "approveSessionAll"
	| "discardSurfaceChange"
	| "undoSurfaceChange"
	| "chooseExploration"
	| "reconcileChanges"
	| "spawnCrossSurfaceSession"
	| "setPreviewSelection"
	| "publishSurface"
	| "listAutomations"
	| "toggleAutomation"
	| "getMigrationChecklist"
	| "applyMigrationChecklist"
>;

export type SurfacesSource = "loading" | "cloud" | "local";
export type SurfacePreviewMode = "live" | "preview" | "compare";
export type SurfaceDevice = "desktop" | "mobile";
export type ApprovalOutcome = "open" | "hold" | "history";

export const SURFACE_UNDO_MS = 5_000;
const POLL_MS = 4_000;

export type SurfaceUndoVerb = "merged" | "sent" | "done";

export interface SurfaceUndo {
	readonly id: number;
	readonly label: string;
	readonly changeIds: readonly string[];
	readonly verb: SurfaceUndoVerb;
}

export interface SurfaceNote {
	readonly id: number;
	readonly sessionId: string;
	readonly text: string;
	readonly at: string;
	readonly priorMatches: number;
}

export interface CreateSurfaceInput {
	readonly title: string;
	readonly slug?: string;
	readonly archetype: "live_build" | "studio";
	readonly icon?: string;
	readonly folderRoot?: string;
	readonly initialPrompt?: string;
	readonly kind?: SurfaceKind;
	readonly accent?: string;
	readonly description?: string;
}

export interface CreateScheduledAgentInput {
	readonly title: string;
	readonly prompt: string;
	readonly scheduleSummary: string;
	readonly targetSurfaceSlug?: string | null;
}

export interface ActiveTaskSessionEntry {
	readonly surface: SurfaceSummary;
	readonly session: SurfaceSession;
	readonly running: boolean;
}

export interface SurfacesState {
	readonly source: SurfacesSource;
	readonly surfaces: readonly SurfaceSummary[];
	readonly workspaces: Readonly<Record<string, SurfaceWorkspace>>;
	readonly automations: readonly SurfaceAutomationSummary[];
	readonly scheduledAgentPrompts: Readonly<Record<string, string>>;
	readonly migration?: SurfaceMigrationChecklist;
	readonly migrationDismissed: boolean;
	readonly foldedAgentIds: Readonly<Record<string, true>>;
	readonly localStudioBase: Readonly<Record<string, Readonly<Record<string, string>>>>;
	readonly surfaceLooks: Readonly<Record<string, SurfaceLook>>;
	readonly drawer?: { readonly surfaceId: string; readonly sessionId: string };
	readonly highlight?: { readonly surfaceId: string; readonly sessionId: string };
	readonly mode: SurfacePreviewMode;
	readonly device: SurfaceDevice;
	readonly hiddenChanges: Readonly<Record<string, true>>;
	readonly studioPatches: Readonly<Record<string, readonly StudioPatchOp[]>>;
	readonly variantPick: Readonly<Record<string, string>>;
	readonly historyOpen: boolean;
	readonly collapsed: Readonly<Record<string, true>>;
	readonly notes: readonly SurfaceNote[];
	readonly undo?: SurfaceUndo;
	readonly busy: Readonly<Record<string, true>>;
	readonly error?: string;
}

export interface SurfaceSynthesisInput {
	readonly companyId: string;
	readonly sites: readonly {
		readonly slug: string;
		readonly title: string | null;
		readonly kind: "files" | "app";
		readonly state: string;
		readonly url: string;
	}[];
	readonly pages: readonly string[];
}

export interface SurfaceMigrationInput {
	readonly companyId: string;
	readonly agents: readonly {
		readonly id: string;
		readonly handle: string;
		readonly name: string;
		readonly role: string;
	}[];
	readonly boards: readonly { readonly name: string; readonly title: string; readonly kit: string | null }[];
}

const LOCAL_PREFIX = "local-";

export function isLocalSurfaceId(id: string): boolean {
	return id.startsWith(LOCAL_PREFIX);
}

function localSurface(
	slug: string,
	title: string,
	group: SurfaceSummary["group"],
	archetype: SurfaceSummary["archetype"],
	icon: string,
	order: number,
	extra: Partial<SurfaceSummary> = {},
): SurfaceSummary {
	return {
		id: `${LOCAL_PREFIX}${slug}`,
		slug,
		title,
		group,
		archetype,
		status: "active",
		icon,
		sourceKind: archetype === "ops" ? "native_ops" : "folder",
		repositoryKey: null,
		folderRoot: null,
		siteSlug: null,
		previewMode: archetype === "live_build" ? "static_site" : "none",
		autoPublish: false,
		liveUrl: null,
		hasUnpublishedChanges: false,
		unpublishedChangeCount: 0,
		activeSessionCount: 0,
		runningSessionCount: 0,
		pendingChangeCount: 0,
		needsAttentionCount: 0,
		sortOrder: order,
		...extra,
	};
}

const OPS_SURFACES = [
	{ slug: "inbox", title: phrase("Inbox"), icon: "mail", page: "mailbox" },
	{ slug: "money", title: phrase("Money"), icon: "coin", page: "bank" },
	{ slug: "members", title: phrase("Members"), icon: "members", page: "members" },
	{ slug: "data", title: phrase("Databases"), icon: "database", page: "data" },
	{ slug: "files", title: phrase("Files"), icon: "drawers", page: null },
] as const;

// WHY: Unmigrated companies still get a surface-first rail built from what they already run, without any database rows.
export function synthesizeSurfaces(input: SurfaceSynthesisInput): SurfaceSummary[] {
	const taken = new Set<string>(OPS_SURFACES.map((ops) => ops.slug));
	const products = input.sites
		.filter((site) => site.kind === "files" && site.state !== "off")
		.map((site, index) => {
			const slug = taken.has(site.slug) ? `${site.slug}-site` : site.slug;
			taken.add(slug);
			return localSurface(slug, site.title?.trim() || site.slug, "products", "live_build", "globe", index, {
				siteSlug: site.slug,
				liveUrl: site.url,
			});
		});
	const operations = OPS_SURFACES.filter((ops) => ops.page === null || input.pages.includes(ops.page)).map(
		(ops, index) => localSurface(ops.slug, t(ops.title), "operations", "ops", ops.icon, 100 + index),
	);
	return [...products, ...operations];
}

export function synthesizeMigration(input: SurfaceMigrationInput): SurfaceMigrationChecklist {
	return {
		companyId: input.companyId,
		alreadyMigrated: false,
		proposedSurfaces: [],
		specialistAgents: input.agents.map((agent) => ({
			agentId: agent.id,
			handle: agent.handle,
			name: agent.name,
			role: agent.role,
			routineCount: 0,
			recommendedAction: "fold_to_automation",
			recommendedTargetSurfaceSlug: null,
		})),
		legacyBoards: input.boards.map((board) => ({
			appName: board.name,
			title: board.title,
			kit: board.kit,
			recommendedAction: "archive_to_files",
			recommendedSurfaceSlug: null,
		})),
	};
}

export function migrationPending(checklist: SurfaceMigrationChecklist | undefined): boolean {
	return Boolean(
		checklist &&
			!checklist.alreadyMigrated &&
			(checklist.specialistAgents.length > 0 || checklist.legacyBoards.length > 0),
	);
}

export function isRunningSession(session: Pick<SurfaceSession, "state">): boolean {
	return RUNNING_SURFACE_SESSION_STATES.has(session.state);
}

export function isOpenChange(change: Pick<SurfaceChangeUnit, "status">): boolean {
	return OPEN_SURFACE_CHANGE_STATUSES.has(change.status);
}

export function hasConflictedChange(session: Pick<SurfaceSession, "changes">): boolean {
	return session.changes.some((change) => change.status === "conflicted");
}

export function formatConflictPaths(paths: readonly string[]): string {
	if (paths.length === 0) return "";
	if (paths.length <= 2) return paths.join(", ");
	return t("{path} and {count} more", { path: paths[0]!, count: paths.length - 1 });
}

function memberMessageMatches(session: SurfaceSession, text: string): number {
	let count = 0;
	for (const message of session.messages)
		if (message.authorKind === "member" && message.text.trim() === text) count += 1;
	return count;
}

function reconcileNotes(notes: readonly SurfaceNote[], sessions: readonly SurfaceSession[]): SurfaceNote[] {
	if (notes.length === 0) return [];
	const byId = new Map(sessions.map((session) => [session.id, session]));
	return notes.filter((note) => {
		const session = byId.get(note.sessionId);
		return !session || memberMessageMatches(session, note.text) <= note.priorMatches;
	});
}

// WHY: Encodes Jonas's rule that a partially approved session stays open, and a fully approved one only lingers while its chat is open.
export function approvalOutcome(session: SurfaceSession, drawerOpen: boolean): ApprovalOutcome {
	if (countOpenSurfaceChanges(session.changes) > 0) return "open";
	const next = nextSurfaceSessionLifecycleState({
		state: session.state,
		hasActiveChat: drawerOpen,
		changes: session.changes,
	});
	return next === "ready" ? "hold" : "history";
}

export function sessionHeld(session: SurfaceSession): boolean {
	return (
		!isRunningSession(session) &&
		session.changes.length > 0 &&
		countOpenSurfaceChanges(session.changes) === 0 &&
		session.changes.some((change) => change.status === "merged")
	);
}

export function runningSessionTotal(state: Pick<SurfacesState, "surfaces" | "workspaces">): number {
	let total = 0;
	for (const surface of state.surfaces) {
		const workspace = state.workspaces[surface.id];
		total += workspace ? workspace.activeSessions.filter(isRunningSession).length : surface.runningSessionCount;
	}
	return total;
}

export function activeTaskSessions(state: Pick<SurfacesState, "surfaces" | "workspaces">): ActiveTaskSessionEntry[] {
	const items: ActiveTaskSessionEntry[] = [];
	for (const surface of state.surfaces) {
		if (surface.status !== "active") continue;
		const workspace = state.workspaces[surface.id];
		if (!workspace) continue;
		for (const session of workspace.activeSessions) {
			if (session.explorationId) continue;
			items.push({ surface, session, running: isRunningSession(session) });
		}
	}
	return items.sort((a, b) => {
		const rank = (entry: ActiveTaskSessionEntry) =>
			entry.running ? 0 : entry.session.state === "needs_input" || hasConflictedChange(entry.session) ? 1 : 2;
		return rank(a) - rank(b) || b.session.updatedAt.localeCompare(a.session.updatedAt);
	});
}

export function openExplorations(workspace: SurfaceWorkspace | undefined): SurfaceExplorationSet[] {
	return workspace?.explorations.filter((set) => set.status === "open") ?? [];
}

export function surfaceBySlug(state: Pick<SurfacesState, "surfaces">, slug: string): SurfaceSummary | undefined {
	return state.surfaces.find((surface) => surface.slug === slug);
}

export function productBuildSurfaces(state: Pick<SurfacesState, "surfaces">, excludeId?: string): SurfaceSummary[] {
	return state.surfaces.filter(
		(surface) => surface.status === "active" && surface.archetype === "live_build" && surface.id !== excludeId,
	);
}

function replaceSession(
	workspace: SurfaceWorkspace,
	session: SurfaceSession,
	outcome: ApprovalOutcome,
): SurfaceWorkspace {
	const active = workspace.activeSessions.filter((item) => item.id !== session.id);
	const history = workspace.recentHistory.filter((item) => item.id !== session.id);
	if (outcome === "history") return { ...workspace, activeSessions: active, recentHistory: [session, ...history] };
	const index = workspace.activeSessions.findIndex((item) => item.id === session.id);
	const next = [...active];
	next.splice(index < 0 ? next.length : index, 0, session);
	return { ...workspace, activeSessions: next, recentHistory: history };
}

function emptyPreview(surfaceId: string): SurfacePreviewCompositionState {
	return {
		surfaceId,
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
	};
}

export function localWorkspace(surface: SurfaceSummary): SurfaceWorkspace {
	return {
		surface,
		briefSummary: null,
		activeSessions: [],
		recentHistory: [],
		explorations: [],
		previewState: emptyPreview(surface.id),
	};
}

function describe(error: unknown): string {
	return error instanceof Error && error.message ? error.message : String(error);
}

export interface SurfacesStoreOptions {
	readonly companyId: string;
	readonly companyName?: string;
	readonly localInteractive?: boolean;
	readonly client: SurfacesClient | undefined;
	readonly synthesize: () => SurfaceSynthesisInput;
	readonly migration: () => SurfaceMigrationInput;
	readonly signal: AbortSignal;
	readonly unavailableMessage: string;
	readonly onNavigateSurface?: (slug: string) => void;
}

interface LocalSandboxCacheEntry {
	readonly surfaces: readonly SurfaceSummary[];
	readonly workspaces: Readonly<Record<string, SurfaceWorkspace>>;
	readonly automations: readonly SurfaceAutomationSummary[];
	readonly scheduledAgentPrompts: Readonly<Record<string, string>>;
	readonly migration?: SurfaceMigrationChecklist;
	readonly migrationDismissed: boolean;
	readonly foldedAgentIds: Readonly<Record<string, true>>;
	readonly localStudioBase: Readonly<Record<string, Readonly<Record<string, string>>>>;
	readonly surfaceLooks: Readonly<Record<string, SurfaceLook>>;
	readonly studioPatches: Readonly<Record<string, readonly StudioPatchOp[]>>;
	readonly hiddenChanges: Readonly<Record<string, true>>;
	readonly localCreatedIds: readonly string[];
	readonly localSeq: number;
}

const localSandboxCache = new Map<string, LocalSandboxCacheEntry>();

export function clearLocalSandboxCache(): void {
	localSandboxCache.clear();
}

export class SurfacesStore {
	readonly store: Store<SurfacesState>;
	readonly #options: SurfacesStoreOptions;
	readonly #localTimers = new Set<ReturnType<typeof setTimeout>>();
	readonly #localCreatedIds = new Set<string>();
	readonly #studioUndoSnapshots = new Map<string, Readonly<Record<string, string>>>();
	#undoTimer: ReturnType<typeof setTimeout> | undefined;
	#pollTimer: ReturnType<typeof setInterval> | undefined;
	#undoSeq = 0;
	#noteSeq = 0;
	#localSeq = 0;
	#loaded: Promise<void> | undefined;

	constructor(options: SurfacesStoreOptions) {
		this.#options = options;
		this.store = new Store<SurfacesState>({
			source: "loading",
			surfaces: [],
			workspaces: {},
			automations: [],
			scheduledAgentPrompts: {},
			migrationDismissed: false,
			foldedAgentIds: {},
			localStudioBase: {},
			surfaceLooks: {},
			mode: "preview",
			device: "desktop",
			hiddenChanges: {},
			studioPatches: {},
			variantPick: {},
			historyOpen: false,
			collapsed: {},
			notes: [],
			busy: {},
		});
		options.signal.addEventListener("abort", () => this.dispose(), { once: true });
		if (options.localInteractive) {
			this.store.subscribe(() => {
				if (this.isLocalInteractive) this.#persistLocalSandbox();
			});
		}
	}

	#persistLocalSandbox(): void {
		const state = this.state;
		localSandboxCache.set(this.#options.companyId, {
			surfaces: state.surfaces,
			workspaces: state.workspaces,
			automations: state.automations,
			scheduledAgentPrompts: state.scheduledAgentPrompts,
			migration: state.migration,
			migrationDismissed: state.migrationDismissed,
			foldedAgentIds: state.foldedAgentIds,
			localStudioBase: state.localStudioBase,
			surfaceLooks: state.surfaceLooks,
			studioPatches: state.studioPatches,
			hiddenChanges: state.hiddenChanges,
			localCreatedIds: [...this.#localCreatedIds],
			localSeq: this.#localSeq,
		});
	}

	get state(): SurfacesState {
		return this.store.get();
	}

	get isLocalInteractive(): boolean {
		return this.state.source === "local" && this.#options.localInteractive === true;
	}

	get companyName(): string {
		return this.#options.companyName?.trim() || "";
	}

	lookOf(surface: Pick<SurfaceSummary, "id" | "slug" | "icon" | "archetype">): SurfaceLook {
		return surfaceLookOf(surface, this.state.surfaceLooks);
	}

	dispose(): void {
		if (this.#undoTimer) clearTimeout(this.#undoTimer);
		if (this.#pollTimer) clearInterval(this.#pollTimer);
		for (const timer of this.#localTimers) clearTimeout(timer);
		this.#localTimers.clear();
		this.#undoTimer = undefined;
		this.#pollTimer = undefined;
		this.store.dispose();
	}

	#scheduleLocal(delayMs: number, work: () => void): void {
		const timer = setTimeout(() => {
			this.#localTimers.delete(timer);
			if (!this.#options.signal.aborted) work();
		}, delayMs);
		this.#localTimers.add(timer);
	}

	#syncLocalSurfaceCounts(workspace: SurfaceWorkspace): SurfaceSummary {
		const activeSessions = workspace.activeSessions;
		const running = activeSessions.filter(isRunningSession).length;
		const pending = activeSessions.reduce((sum, session) => sum + session.changes.filter(isOpenChange).length, 0);
		const needsAttention = activeSessions.filter(
			(session) => session.state === "needs_input" || hasConflictedChange(session),
		).length;
		return {
			...workspace.surface,
			activeSessionCount: activeSessions.length,
			runningSessionCount: running,
			pendingChangeCount: pending,
			needsAttentionCount: needsAttention,
		};
	}

	load(): Promise<void> {
		this.#loaded ??= this.#load();
		return this.#loaded;
	}

	async #load(): Promise<void> {
		const client = this.#options.client;
		if (!client) {
			this.#useLocal();
			return;
		}
		try {
			const surfaces = await client.listSurfaces(this.#options.companyId);
			if (this.#options.signal.aborted) return;
			if (surfaces.length === 0) this.#useLocal();
			else this.store.set({ source: "cloud", surfaces: sortSurfaces(surfaces) });
		} catch (error) {
			if (this.#options.signal.aborted) return;
			this.#useLocal(isMissingSurfaceRpcError(error) ? undefined : describe(error));
			return;
		}
		await Promise.all([this.#loadAutomations(client), this.#loadMigration(client)]);
	}

	#useLocal(error?: string): void {
		const cached = this.#options.localInteractive ? localSandboxCache.get(this.#options.companyId) : undefined;
		if (cached) {
			for (const id of cached.localCreatedIds) this.#localCreatedIds.add(id);
			this.#localSeq = Math.max(this.#localSeq, cached.localSeq);
			this.store.set({
				source: "local",
				surfaces: cached.surfaces,
				workspaces: cached.workspaces,
				automations: cached.automations,
				scheduledAgentPrompts: cached.scheduledAgentPrompts ?? {},
				migration: cached.migration,
				migrationDismissed: cached.migrationDismissed,
				foldedAgentIds: cached.foldedAgentIds,
				localStudioBase: cached.localStudioBase,
				surfaceLooks: cached.surfaceLooks,
				studioPatches: cached.studioPatches,
				hiddenChanges: cached.hiddenChanges,
				...(error ? { error } : {}),
			});
			this.resynthesize();
			return;
		}
		this.store.set({
			source: "local",
			surfaces: synthesizeSurfaces(this.#options.synthesize()),
			migration: synthesizeMigration(this.#options.migration()),
			...(error ? { error } : {}),
		});
		if (this.#options.localInteractive && isThetabandCompany(this.companyName)) {
			this.orchestrateStarterSurfaces();
		}
	}

	orchestrateStarterSurfaces(): readonly SurfaceSummary[] {
		if (!this.isLocalInteractive) return [];
		const plan = starterOrchestrationPlan(this.companyName);
		const now = new Date().toISOString();
		const createdSurfaces: SurfaceSummary[] = [];
		const taken = new Set(this.state.surfaces.map((surface) => surface.slug));
		const nextSurfaces = [...this.state.surfaces];
		const nextWorkspaces: Record<string, SurfaceWorkspace> = { ...this.state.workspaces };
		const nextLooks: Record<string, SurfaceLook> = { ...this.state.surfaceLooks };
		const nextStudioBase: Record<string, Readonly<Record<string, string>>> = { ...this.state.localStudioBase };
		const nextStudioPatches: Record<string, readonly StudioPatchOp[]> = { ...this.state.studioPatches };

		for (const [index, spec] of plan.surfaces.entries()) {
			if (taken.has(spec.slug)) continue;
			taken.add(spec.slug);
			const surface = localSurface(spec.slug, spec.name, "products", spec.archetype, spec.icon, index, {
				sourceKind: spec.archetype === "studio" ? "folder" : "code_repo",
				folderRoot: spec.folderRoot ?? null,
				previewMode: spec.archetype === "studio" ? "studio_overlay" : "static_site",
				liveUrl: spec.liveUrl ?? null,
			});
			this.#localCreatedIds.add(surface.id);
			const look: SurfaceLook = { kind: spec.kind };
			nextLooks[surface.id] = look;
			if (spec.archetype === "studio") {
				nextStudioBase[surface.id] = starterStudioFiles(surface, this.companyName, spec.kind, spec.brief);
			}
			const sessions: SurfaceSession[] = [];
			const explorations: SurfaceExplorationSet[] = [];
			const mainSessionId = `local-session-${++this.#localSeq}`;
			const mainChanges: SurfaceChangeUnit[] = spec.session.changes.map((entry, changeIndex) => {
				const changeId = `local-change-${++this.#localSeq}`;
				if (entry.studioPatch?.length) nextStudioPatches[changeId] = entry.studioPatch;
				return {
					id: changeId,
					sessionId: mainSessionId,
					surfaceId: surface.id,
					seq: changeIndex + 1,
					kind: entry.kind,
					title: entry.heading,
					summary: entry.summary,
					status: "staged",
					parentSha: null,
					headSha: null,
					dependsOnChangeIds: [],
					diffStats: { filesChanged: entry.paths.length || 1, additions: 24 + changeIndex * 11, deletions: 4 },
					affectedPaths: [...entry.paths],
					conflictPaths: null,
					landedChangeNumber: null,
					canUndo: false,
					createdAt: now,
					resolvedAt: null,
				};
			});
			sessions.push({
				id: mainSessionId,
				surfaceId: surface.id,
				workerId: null,
				title: spec.session.heading,
				prompt: spec.session.prompt,
				state: "ready",
				originKind: "cofounder",
				originLabel: "Co-Founder",
				explorationId: null,
				explorationVariantLabel: null,
				hasActiveChat: false,
				question: null,
				changes: mainChanges,
				messages: [
					{
						id: `local-message-${++this.#localSeq}`,
						sessionId: mainSessionId,
						authorKind: "member",
						text: spec.session.prompt,
						changeId: null,
						createdAt: now,
					},
					{
						id: `local-message-${++this.#localSeq}`,
						sessionId: mainSessionId,
						authorKind: "session",
						text: spec.session.reply,
						changeId: null,
						createdAt: now,
					},
				],
				openChangeCount: mainChanges.length,
				createdAt: now,
				updatedAt: now,
				closedAt: null,
			});

			if (spec.exploration) {
				const explorationId = `local-exploration-${++this.#localSeq}`;
				const variantIds: string[] = [];
				for (const variant of spec.exploration.variants) {
					const variantSessionId = `local-session-${++this.#localSeq}`;
					const changeId = `local-change-${++this.#localSeq}`;
					variantIds.push(variantSessionId);
					sessions.push({
						id: variantSessionId,
						surfaceId: surface.id,
						workerId: null,
						title: variant.label,
						prompt: variant.summary,
						state: "ready",
						originKind: "cofounder",
						originLabel: "Co-Founder",
						explorationId,
						explorationVariantLabel: variant.label,
						hasActiveChat: false,
						question: null,
						changes: [
							{
								id: changeId,
								sessionId: variantSessionId,
								surfaceId: surface.id,
								seq: 1,
								kind: "git_range",
								title: variant.changeTitle,
								summary: variant.summary,
								status: "staged",
								parentSha: null,
								headSha: null,
								dependsOnChangeIds: [],
								diffStats: { filesChanged: 3, additions: 86, deletions: 18 },
								affectedPaths: ["src/sections/Hero.tsx", "src/styles/theme.css"],
								conflictPaths: null,
								landedChangeNumber: null,
								canUndo: false,
								createdAt: now,
								resolvedAt: null,
							},
						],
						messages: [
							{
								id: `local-message-${++this.#localSeq}`,
								sessionId: variantSessionId,
								authorKind: "session",
								text: variant.summary,
								changeId: null,
								createdAt: now,
							},
						],
						openChangeCount: 1,
						createdAt: now,
						updatedAt: now,
						closedAt: null,
					});
				}
				explorations.push({
					id: explorationId,
					surfaceId: surface.id,
					title: spec.exploration.heading,
					status: "open",
					chosenSessionId: null,
					variantSessionIds: variantIds,
					createdAt: now,
					resolvedAt: null,
				});
			}

			const draftWorkspace: SurfaceWorkspace = {
				...localWorkspace(surface),
				briefSummary: spec.brief,
				activeSessions: sessions,
				explorations,
			};
			const syncedSurface = this.#syncLocalSurfaceCounts(draftWorkspace);
			nextWorkspaces[surface.id] = { ...draftWorkspace, surface: syncedSurface };
			nextSurfaces.push(syncedSurface);
			createdSurfaces.push(syncedSurface);
		}

		const existingKeys = new Set(this.state.automations.map((item) => item.key));
		const nextAutomations = [...this.state.automations];
		const nextPrompts = { ...this.state.scheduledAgentPrompts };
		for (const auto of plan.automations) {
			if (existingKeys.has(auto.key)) continue;
			const id = `local-automation-${++this.#localSeq}`;
			const { heading, ...rest } = auto;
			nextAutomations.push({ ...rest, id, title: heading });
			nextPrompts[id] = auto.scheduleSummary;
		}

		this.store.set({
			surfaces: sortSurfaces(nextSurfaces),
			workspaces: nextWorkspaces,
			surfaceLooks: nextLooks,
			localStudioBase: nextStudioBase,
			studioPatches: nextStudioPatches,
			automations: nextAutomations,
			scheduledAgentPrompts: nextPrompts,
			error: undefined,
		});
		return createdSurfaces;
	}

	async createScheduledAgent(input: CreateScheduledAgentInput): Promise<SurfaceAutomationSummary | undefined> {
		const title = input.title.trim();
		const prompt = input.prompt.trim();
		const schedule = input.scheduleSummary.trim() || t("Every day · 09:00");
		if (!title || !prompt) return undefined;
		if (!this.isLocalInteractive) {
			this.store.set({ error: this.#options.unavailableMessage });
			return undefined;
		}
		const id = `local-automation-${++this.#localSeq}`;
		const key = slugifySurfaceTitle(title, new Set(this.state.automations.map((item) => item.key)));
		const created: SurfaceAutomationSummary = {
			id,
			key,
			title,
			scheduleSummary: schedule,
			targetSurfaceSlug: input.targetSurfaceSlug || null,
			outputMode: input.targetSurfaceSlug ? "surface_session" : "decision_card",
			enabled: true,
			status: "idle",
			lastRunAt: null,
			lastOutcomeSummary: prompt.length <= 68 ? prompt : `${prompt.slice(0, 65).trimEnd()}…`,
			nextRunAt: null,
		};
		this.store.set((state) => ({
			automations: [...state.automations, created],
			scheduledAgentPrompts: { ...state.scheduledAgentPrompts, [id]: prompt },
			error: undefined,
		}));
		return created;
	}

	async updateScheduledAgent(
		id: string,
		patch: Partial<CreateScheduledAgentInput>,
	): Promise<SurfaceAutomationSummary | undefined> {
		const existing = this.state.automations.find((item) => item.id === id);
		if (!existing) return undefined;
		if (!this.isLocalInteractive || !id.startsWith("local-")) {
			this.store.set({ error: this.#options.unavailableMessage });
			return undefined;
		}
		const title = patch.title?.trim() || existing.title;
		const schedule = patch.scheduleSummary?.trim() || existing.scheduleSummary;
		const prompt = patch.prompt?.trim() ?? this.state.scheduledAgentPrompts[id] ?? existing.lastOutcomeSummary ?? "";
		const target = patch.targetSurfaceSlug !== undefined ? patch.targetSurfaceSlug : existing.targetSurfaceSlug;
		const updated: SurfaceAutomationSummary = {
			...existing,
			title,
			scheduleSummary: schedule,
			targetSurfaceSlug: target,
			outputMode: target ? "surface_session" : "decision_card",
			lastOutcomeSummary: prompt ? (prompt.length <= 68 ? prompt : `${prompt.slice(0, 65).trimEnd()}…`) : null,
		};
		this.store.set((state) => ({
			automations: state.automations.map((item) => (item.id === id ? updated : item)),
			scheduledAgentPrompts: { ...state.scheduledAgentPrompts, [id]: prompt },
			error: undefined,
		}));
		return updated;
	}

	async deleteScheduledAgent(id: string): Promise<boolean> {
		if (!this.isLocalInteractive || !id.startsWith("local-")) return false;
		this.store.set((state) => {
			const scheduledAgentPrompts = { ...state.scheduledAgentPrompts };
			delete scheduledAgentPrompts[id];
			return {
				automations: state.automations.filter((item) => item.id !== id),
				scheduledAgentPrompts,
			};
		});
		return true;
	}

	async #loadAutomations(client: SurfacesClient): Promise<void> {
		try {
			const automations = await client.listAutomations(this.#options.companyId);
			if (!this.#options.signal.aborted) this.store.set({ automations });
		} catch {
			/* WHY: Automations are a quiet extra; a failed read must not block the surfaces themselves. */
		}
	}

	async #loadMigration(client: SurfacesClient): Promise<void> {
		try {
			const migration = await client.getMigrationChecklist(this.#options.companyId);
			if (!this.#options.signal.aborted) this.store.set({ migration });
		} catch {
			if (!this.#options.signal.aborted)
				this.store.set({ migration: synthesizeMigration(this.#options.migration()) });
		}
	}

	resynthesize(): void {
		if (this.state.source !== "local") return;
		const existingById = new Map(this.state.surfaces.map((surface) => [surface.id, surface]));
		const synthesized = synthesizeSurfaces(this.#options.synthesize()).map((surface) => {
			const prev = existingById.get(surface.id);
			return prev
				? {
						...surface,
						autoPublish: prev.autoPublish,
						hasUnpublishedChanges: prev.hasUnpublishedChanges,
						unpublishedChangeCount: prev.unpublishedChangeCount,
						activeSessionCount: prev.activeSessionCount,
						runningSessionCount: prev.runningSessionCount,
						pendingChangeCount: prev.pendingChangeCount,
						needsAttentionCount: prev.needsAttentionCount,
					}
				: surface;
		});
		const keptCreated = this.state.surfaces.filter((surface) => this.#localCreatedIds.has(surface.id));
		const taken = new Set(synthesized.map((surface) => surface.slug));
		const mergedSurfaces = sortSurfaces([
			...synthesized,
			...keptCreated.filter((surface) => !taken.has(surface.slug)),
		]);
		const nextSurfaces =
			JSON.stringify(mergedSurfaces) !== JSON.stringify(this.state.surfaces) ? mergedSurfaces : undefined;
		const nextMigration = !this.state.migration?.alreadyMigrated
			? (() => {
					const synthesizedMigration = synthesizeMigration(this.#options.migration());
					return JSON.stringify(synthesizedMigration) !== JSON.stringify(this.state.migration)
						? synthesizedMigration
						: undefined;
				})()
			: undefined;
		if (nextSurfaces || nextMigration) {
			this.store.set({
				...(nextSurfaces ? { surfaces: nextSurfaces } : {}),
				...(nextMigration ? { migration: nextMigration } : {}),
			});
		}
	}

	workspace(surfaceId: string): SurfaceWorkspace | undefined {
		return this.state.workspaces[surfaceId];
	}

	async openSurface(slug: string): Promise<SurfaceWorkspace | undefined> {
		await this.load();
		const surface = surfaceBySlug(this.state, slug);
		if (!surface) return undefined;
		if (isLocalSurfaceId(surface.id) || !this.#options.client) {
			const existing = this.workspace(surface.id) ?? localWorkspace(surface);
			this.#putWorkspace({ ...existing, surface });
			return this.workspace(surface.id);
		}
		return this.refreshWorkspace(surface.id);
	}

	async refreshWorkspace(surfaceId: string): Promise<SurfaceWorkspace | undefined> {
		const client = this.#options.client;
		if (!client || isLocalSurfaceId(surfaceId)) return this.workspace(surfaceId);
		try {
			const workspace = await client.getSurfaceWorkspace(surfaceId);
			if (this.#options.signal.aborted) return undefined;
			this.#putWorkspace(workspace);
			return workspace;
		} catch (error) {
			if (!this.#options.signal.aborted) this.store.set({ error: describe(error) });
			return undefined;
		}
	}

	#putWorkspace(workspace: SurfaceWorkspace): void {
		const sessions = [...workspace.activeSessions, ...workspace.recentHistory];
		this.store.set((state) => {
			const notes = reconcileNotes(state.notes, sessions);
			return {
				workspaces: { ...state.workspaces, [workspace.surface.id]: workspace },
				surfaces: state.surfaces.map((surface) =>
					surface.id === workspace.surface.id ? workspace.surface : surface,
				),
				...(notes.length !== state.notes.length ? { notes } : {}),
			};
		});
		this.#syncPolling();
	}

	#syncPolling(): void {
		const running = Object.values(this.state.workspaces).some((workspace) =>
			workspace.activeSessions.some(isRunningSession),
		);
		if (running && !this.#pollTimer && this.#options.client && this.state.source === "cloud") {
			this.#pollTimer = setInterval(() => {
				for (const workspace of Object.values(this.state.workspaces))
					if (workspace.activeSessions.some(isRunningSession)) void this.refreshWorkspace(workspace.surface.id);
			}, POLL_MS);
		} else if (!running && this.#pollTimer) {
			clearInterval(this.#pollTimer);
			this.#pollTimer = undefined;
		}
	}

	canStartSessions(surface: SurfaceSummary): boolean {
		if (this.state.source === "cloud" && !isLocalSurfaceId(surface.id) && Boolean(this.#options.client)) return true;
		return this.isLocalInteractive;
	}

	async createSurface(input: CreateSurfaceInput): Promise<SurfaceSummary | undefined> {
		const title = input.title.trim();
		if (!title) return undefined;
		const taken = new Set(this.state.surfaces.map((surface) => surface.slug));
		const slug = slugifySurfaceTitle(input.slug?.trim() || title, taken);
		const icon = input.icon ?? (input.archetype === "studio" ? "spark" : "globe");
		const description = input.description?.trim() || null;
		const folderRoot =
			input.archetype === "studio" ? (input.folderRoot?.trim() || slug).replace(/^\/+|\/+$/g, "") : null;
		const sortOrder = this.state.surfaces.filter((surface) => surface.group === "products").length;
		const created = localSurface(slug, title, "products", input.archetype, icon, sortOrder, {
			sourceKind: input.archetype === "studio" ? "folder" : "code_repo",
			folderRoot,
			previewMode: input.archetype === "studio" ? "studio_overlay" : "static_site",
		});
		this.#localCreatedIds.add(created.id);
		const look: SurfaceLook = {
			kind: input.kind ?? surfaceLookOf(created).kind,
			...(input.accent ? { accent: input.accent } : {}),
		};
		const starterFiles =
			input.archetype === "studio"
				? starterStudioFiles(created, this.companyName, look.kind, description ?? undefined)
				: undefined;
		this.store.set((state) => ({
			surfaces: sortSurfaces([...state.surfaces, created]),
			workspaces: { ...state.workspaces, [created.id]: { ...localWorkspace(created), briefSummary: description } },
			surfaceLooks: { ...state.surfaceLooks, [created.id]: look },
			...(starterFiles ? { localStudioBase: { ...state.localStudioBase, [created.id]: starterFiles } } : {}),
			...(look.kind === "mobile_app" ? { device: "mobile" as const } : {}),
			error: undefined,
		}));
		this.#options.onNavigateSurface?.(created.slug);
		const prompt = input.initialPrompt?.trim();
		if (prompt && this.canStartSessions(created)) void this.startSession(created.id, prompt);
		return created;
	}

	setMode(mode: SurfacePreviewMode): void {
		this.store.set({ mode });
	}

	setDevice(device: SurfaceDevice): void {
		this.store.set({ device });
	}

	toggleHistory(): void {
		this.store.set((state) => ({ historyOpen: !state.historyOpen }));
	}

	toggleCollapsed(sessionId: string): void {
		this.store.set((state) => {
			const collapsed = { ...state.collapsed };
			if (collapsed[sessionId]) delete collapsed[sessionId];
			else collapsed[sessionId] = true;
			return { collapsed };
		});
	}

	dismissMigration(): void {
		this.store.set({ migrationDismissed: true });
	}

	clearError(): void {
		this.store.set({ error: undefined });
	}

	clearHighlight(): void {
		if (this.state.highlight) this.store.set({ highlight: undefined });
	}

	setStudioPatch(changeId: string, ops: readonly StudioPatchOp[]): void {
		this.store.set((state) => ({ studioPatches: { ...state.studioPatches, [changeId]: ops } }));
	}

	#sessionAt(sessionId: string): { workspace: SurfaceWorkspace; session: SurfaceSession } | undefined {
		for (const workspace of Object.values(this.state.workspaces)) {
			const session =
				workspace.activeSessions.find((item) => item.id === sessionId) ??
				workspace.recentHistory.find((item) => item.id === sessionId);
			if (session) return { workspace, session };
		}
		return undefined;
	}

	session(sessionId: string): SurfaceSession | undefined {
		return this.#sessionAt(sessionId)?.session;
	}

	async #run<T>(key: string, work: (client: SurfacesClient) => Promise<T>): Promise<T | undefined> {
		const client = this.#options.client;
		if (!client) {
			this.store.set({ error: this.#options.unavailableMessage });
			return undefined;
		}
		if (this.state.busy[key]) return undefined;
		this.store.set((state) => ({ busy: { ...state.busy, [key]: true }, error: undefined }));
		try {
			return await work(client);
		} catch (error) {
			if (!this.#options.signal.aborted)
				this.store.set({
					error: isMissingSurfaceRpcError(error) ? this.#options.unavailableMessage : describe(error),
				});
			return undefined;
		} finally {
			this.store.set((state) => {
				const busy = { ...state.busy };
				delete busy[key];
				return { busy };
			});
		}
	}

	#stageLocalSession(surface: SurfaceSummary, sessionId: string, prompt: string): void {
		this.#scheduleLocal(650, () => {
			const workspace = this.workspace(surface.id);
			const current = workspace?.activeSessions.find((item) => item.id === sessionId);
			if (!workspace || !current) return;
			const plan = synthesizeLocalChanges(
				workspace.surface,
				sessionId,
				prompt,
				() => `local-change-${++this.#localSeq}`,
				this.companyName,
				this.lookOf(workspace.surface).kind,
			);
			const now = new Date().toISOString();
			const ready: SurfaceSession = {
				...current,
				state: "ready",
				changes: [...plan.changes],
				openChangeCount: plan.changes.length,
				messages: [
					...current.messages,
					{
						id: `local-message-${++this.#localSeq}`,
						sessionId,
						authorKind: "session",
						text: plan.replyText,
						changeId: null,
						createdAt: now,
					},
				],
				updatedAt: now,
			};
			if (Object.keys(plan.studioPatches).length > 0) {
				this.store.set((state) => ({
					studioPatches: { ...state.studioPatches, ...plan.studioPatches },
				}));
			}
			const nextWorkspace = replaceSession(workspace, ready, "open");
			this.#putWorkspace({
				...nextWorkspace,
				surface: this.#syncLocalSurfaceCounts(nextWorkspace),
			});
		});
	}

	async startSession(
		surfaceId: string,
		prompt: string,
		options: StartSurfaceSessionOptions = {},
	): Promise<SurfaceSession | undefined> {
		const text = prompt.trim();
		if (!text) return undefined;
		if (this.isLocalInteractive && isLocalSurfaceId(surfaceId)) {
			const surface = this.state.surfaces.find((item) => item.id === surfaceId);
			if (!surface) return undefined;
			const workspace = this.workspace(surfaceId) ?? localWorkspace(surface);
			const now = new Date().toISOString();
			const id = `local-session-${++this.#localSeq}`;
			const cleanTitle = text.split(/[.!?\n]/)[0]?.trim() || text;
			const title = cleanTitle.length <= 42 ? cleanTitle : `${cleanTitle.slice(0, 39).trimEnd()}…`;
			const local: SurfaceSession = {
				id,
				surfaceId,
				workerId: null,
				title,
				prompt: text,
				state: "running",
				originKind: options.originKind ?? "member",
				originLabel: options.originLabel ?? null,
				explorationId: null,
				explorationVariantLabel: null,
				hasActiveChat: false,
				question: null,
				changes: [],
				messages: [
					{
						id: `local-message-${++this.#localSeq}`,
						sessionId: id,
						authorKind: "member",
						text,
						changeId: null,
						createdAt: now,
					},
				],
				openChangeCount: 0,
				createdAt: now,
				updatedAt: now,
				closedAt: null,
			};
			const nextWorkspace = { ...workspace, activeSessions: [...workspace.activeSessions, local] };
			this.#putWorkspace({
				...nextWorkspace,
				surface: this.#syncLocalSurfaceCounts(nextWorkspace),
			});
			this.#stageLocalSession(surface, id, text);
			return local;
		}
		const session = await this.#run(`start:${surfaceId}:${text}`, (client) =>
			client.startSurfaceSession(surfaceId, text, options),
		);
		if (!session) return undefined;
		const workspace = this.workspace(surfaceId);
		if (workspace) this.#putWorkspace({ ...workspace, activeSessions: [...workspace.activeSessions, session] });
		void this.refreshWorkspace(surfaceId);
		return session;
	}

	async reconcileChanges(surfaceId: string, changeIds: readonly string[]): Promise<SurfaceSession | undefined> {
		const ids = [...new Set(changeIds.filter(Boolean))];
		if (!ids.length) return undefined;
		if (isLocalSurfaceId(surfaceId) || !this.#options.client) {
			const workspace = this.workspace(surfaceId);
			const target = workspace?.activeSessions.find((session) =>
				session.changes.some((change) => ids.includes(change.id)),
			);
			if (workspace && target) {
				const updated: SurfaceSession = {
					...target,
					state: "reconciling",
					changes: target.changes.map((change) =>
						ids.includes(change.id) ? { ...change, status: "staged", conflictPaths: null } : change,
					),
					updatedAt: new Date().toISOString(),
				};
				this.#putWorkspace({
					...replaceSession(workspace, updated, "open"),
					previewState: {
						...workspace.previewState,
						primary: {
							...workspace.previewState.primary,
							status:
								workspace.previewState.primary.status === "conflicted"
									? "composing"
									: workspace.previewState.primary.status,
							conflictReport: null,
						},
					},
				});
				return updated;
			}
			this.store.set({ error: this.#options.unavailableMessage });
			return undefined;
		}
		const reconciled = await this.#run(`reconcile:${surfaceId}`, (client) => client.reconcileChanges(surfaceId, ids));
		if (!reconciled) return undefined;
		this.#applySession(reconciled, "open");
		void this.refreshWorkspace(surfaceId);
		void this.refreshSurfaces();
		return reconciled;
	}

	async approveProposedSurface(surfaceId: string): Promise<SurfaceSummary | undefined> {
		if (!this.#options.client || isLocalSurfaceId(surfaceId)) {
			const existing = this.state.surfaces.find((surface) => surface.id === surfaceId);
			if (!existing) return undefined;
			const activated: SurfaceSummary = { ...existing, status: "active" };
			this.#putSurface(activated);
			return activated;
		}
		const updated = await this.#run(`surface:${surfaceId}`, (client) => client.approveProposedSurface(surfaceId));
		if (!updated) return undefined;
		this.#putSurface(updated);
		return updated;
	}

	async archiveSurface(surfaceId: string): Promise<boolean> {
		const remove = () => {
			this.store.set((state) => {
				const workspaces = { ...state.workspaces };
				delete workspaces[surfaceId];
				return {
					surfaces: state.surfaces.filter((surface) => surface.id !== surfaceId),
					workspaces,
					...(state.drawer?.surfaceId === surfaceId ? { drawer: undefined } : {}),
					...(state.highlight?.surfaceId === surfaceId ? { highlight: undefined } : {}),
				};
			});
		};
		if (!this.#options.client || isLocalSurfaceId(surfaceId)) {
			remove();
			return true;
		}
		const archived = await this.#run(`surface:${surfaceId}`, (client) => client.archiveSurface(surfaceId));
		if (!archived) return false;
		remove();
		return true;
	}

	async spawnCrossSurfaceSession(request: CrossSurfaceHandoffRequest): Promise<SurfaceSession | undefined> {
		const prompt = request.prompt.trim();
		const targetSlug = request.targetSurfaceSlug.trim();
		if (!prompt || !targetSlug) return undefined;
		const targetSurface = surfaceBySlug(this.state, targetSlug);
		const sourceSurface = this.state.surfaces.find((item) => item.id === request.sourceSurfaceId);
		const placeAndNavigate = (session: SurfaceSession, slug: string): SurfaceSession => {
			const existing =
				this.workspace(session.surfaceId) ?? (targetSurface ? localWorkspace(targetSurface) : undefined);
			if (existing) {
				const next = replaceSession(existing, session, "open");
				const nextSurface: SurfaceSummary = {
					...existing.surface,
					activeSessionCount: next.activeSessions.length,
					runningSessionCount: next.activeSessions.filter(isRunningSession).length,
				};
				this.#putWorkspace({ ...next, surface: nextSurface });
			}
			this.store.set((state) => {
				const collapsed = { ...state.collapsed };
				delete collapsed[session.id];
				return { collapsed, highlight: { surfaceId: session.surfaceId, sessionId: session.id } };
			});
			this.#options.onNavigateSurface?.(slug);
			return session;
		};
		const createLocal = (): SurfaceSession | undefined => {
			if (!targetSurface) {
				this.store.set({ error: this.#options.unavailableMessage });
				return undefined;
			}
			const now = new Date().toISOString();
			const id = `local-session-${++this.#localSeq}`;
			const originLabel = sourceSurface ? t("From {source}", { source: sourceSurface.title }) : null;
			const local: SurfaceSession = {
				id,
				surfaceId: targetSurface.id,
				workerId: null,
				title: request.title?.trim() || originLabel || prompt.slice(0, 60),
				prompt,
				state: "queued",
				originKind: "cross_surface",
				originLabel,
				explorationId: null,
				explorationVariantLabel: null,
				hasActiveChat: false,
				question: null,
				changes: [],
				messages: [
					{
						id: `local-message-${++this.#localSeq}`,
						sessionId: id,
						authorKind: "member",
						text: prompt,
						changeId: null,
						createdAt: now,
					},
				],
				openChangeCount: 0,
				createdAt: now,
				updatedAt: now,
				closedAt: null,
			};
			const placed = placeAndNavigate(local, targetSurface.slug);
			if (this.isLocalInteractive) this.#stageLocalSession(targetSurface, placed.id, prompt);
			return placed;
		};
		const client = this.#options.client;
		if (!client || isLocalSurfaceId(request.sourceSurfaceId) || (targetSurface && isLocalSurfaceId(targetSurface.id)))
			return createLocal();
		const busyKey = `handoff:${request.sourceSurfaceId}:${targetSlug}`;
		if (this.state.busy[busyKey]) return undefined;
		this.store.set((state) => ({ busy: { ...state.busy, [busyKey]: true }, error: undefined }));
		try {
			const created = await client.spawnCrossSurfaceSession({
				...request,
				prompt,
				targetSurfaceSlug: targetSlug,
			});
			if (this.#options.signal.aborted) return undefined;
			placeAndNavigate(created, targetSurface?.slug ?? targetSlug);
			void this.refreshWorkspace(created.surfaceId);
			void this.refreshSurfaces();
			return created;
		} catch (error) {
			if (this.#options.signal.aborted) return undefined;
			if (isMissingSurfaceRpcError(error) && targetSurface) return createLocal();
			this.store.set({
				error: isMissingSurfaceRpcError(error) ? this.#options.unavailableMessage : describe(error),
			});
			return undefined;
		} finally {
			this.store.set((state) => {
				const busy = { ...state.busy };
				delete busy[busyKey];
				return { busy };
			});
		}
	}

	#applySession(session: SurfaceSession, outcome: ApprovalOutcome): void {
		const workspace = this.state.workspaces[session.surfaceId];
		if (!workspace) return;
		const next = replaceSession(workspace, session, outcome);
		this.#putWorkspace(
			isLocalSurfaceId(session.surfaceId) ? { ...next, surface: this.#syncLocalSurfaceCounts(next) } : next,
		);
		if (outcome === "history" && this.state.drawer?.sessionId === session.id) this.store.set({ drawer: undefined });
	}

	#commitLocalChangesToBase(surfaceId: string, changeIds: readonly string[]): void {
		const workspace = this.workspace(surfaceId);
		if (!workspace) return;
		if (workspace.surface.archetype === "studio") {
			const currentBase = this.state.localStudioBase[surfaceId];
			if (currentBase) {
				const ordered = changeIds
					.map((id) => ({ changeId: id, ops: this.state.studioPatches[id] ?? [] }))
					.filter((item) => item.ops.length > 0);
				if (ordered.length > 0) {
					for (const item of ordered) this.#studioUndoSnapshots.set(item.changeId, currentBase);
					const composed = composeStudioPreview(currentBase, ordered);
					this.store.set((state) => ({
						localStudioBase: { ...state.localStudioBase, [surfaceId]: composed.files },
					}));
				}
			}
		}
		if (workspace.surface.archetype !== "ops") {
			const surface = workspace.surface;
			const added = surface.autoPublish ? 0 : changeIds.length;
			if (added > 0) {
				this.#putSurface({
					...surface,
					hasUnpublishedChanges: true,
					unpublishedChangeCount: surface.unpublishedChangeCount + added,
				});
			}
		}
	}

	#undoLocalChangeIds(changeIds: readonly string[]): SurfaceSession | undefined {
		let restored: SurfaceSession | undefined;
		for (const changeId of changeIds) {
			let found: { workspace: SurfaceWorkspace; session: SurfaceSession } | undefined;
			for (const workspace of Object.values(this.state.workspaces)) {
				const session =
					workspace.activeSessions.find((item) => item.changes.some((change) => change.id === changeId)) ??
					workspace.recentHistory.find((item) => item.changes.some((change) => change.id === changeId));
				if (session) {
					found = { workspace, session };
					break;
				}
			}
			if (!found) continue;
			const now = new Date().toISOString();
			const changes = found.session.changes.map((change) =>
				change.id === changeId
					? { ...change, status: "staged" as const, canUndo: false, resolvedAt: null }
					: change,
			);
			restored = {
				...found.session,
				state: "ready",
				changes,
				openChangeCount: countOpenSurfaceChanges(changes),
				updatedAt: now,
				closedAt: null,
			};
			const snapshot = this.#studioUndoSnapshots.get(changeId);
			if (snapshot) {
				this.#studioUndoSnapshots.delete(changeId);
				this.store.set((state) => ({
					localStudioBase: { ...state.localStudioBase, [found!.workspace.surface.id]: snapshot },
				}));
			}
			const surface = found.workspace.surface;
			if (surface.unpublishedChangeCount > 0) {
				const nextCount = Math.max(0, surface.unpublishedChangeCount - 1);
				this.#putSurface({
					...surface,
					hasUnpublishedChanges: nextCount > 0,
					unpublishedChangeCount: nextCount,
				});
			}
			this.#applySession(restored, "open");
		}
		return restored;
	}

	#undoVerb(surface: SurfaceSummary): SurfaceUndoVerb {
		const kind = this.lookOf(surface).kind;
		if (kind === "inbox") return "sent";
		return isOpsKind(kind) || surface.archetype === "ops" ? "done" : "merged";
	}

	#undoVerbFor(surfaceId: string): SurfaceUndoVerb {
		const surface = this.state.surfaces.find((item) => item.id === surfaceId);
		return surface ? this.#undoVerb(surface) : "merged";
	}

	#doneLine(verb: SurfaceUndoVerb, title: string): string {
		if (verb === "sent") return t("Sent “{title}”", { title });
		if (verb === "done") return t("Done: “{title}”", { title });
		return t("Merged “{title}” into Base", { title });
	}

	#offerUndo(label: string, changeIds: readonly string[], verb: SurfaceUndoVerb = "merged"): void {
		if (this.#undoTimer) clearTimeout(this.#undoTimer);
		const id = ++this.#undoSeq;
		this.store.set({ undo: { id, label, changeIds, verb } });
		this.#undoTimer = setTimeout(() => {
			if (this.state.undo?.id === id) this.store.set({ undo: undefined });
		}, SURFACE_UNDO_MS);
	}

	drawerOpenOn(sessionId: string): boolean {
		return this.state.drawer?.sessionId === sessionId;
	}

	async approveChange(sessionId: string, changeId: string): Promise<ApprovalOutcome | undefined> {
		const drawerOpen = this.drawerOpenOn(sessionId);
		const found = this.#sessionAt(sessionId);
		if (this.isLocalInteractive && found && isLocalSurfaceId(found.workspace.surface.id)) {
			const now = new Date().toISOString();
			const target = found.session.changes.find((item) => item.id === changeId);
			const changes = found.session.changes.map((change) =>
				change.id === changeId ? { ...change, status: "merged" as const, canUndo: true, resolvedAt: now } : change,
			);
			const openCount = countOpenSurfaceChanges(changes);
			const updated: SurfaceSession = {
				...found.session,
				state: openCount === 0 && !drawerOpen ? "completed" : "ready",
				hasActiveChat: drawerOpen,
				changes,
				openChangeCount: openCount,
				messages: [
					...found.session.messages,
					{
						id: `local-message-${++this.#localSeq}`,
						sessionId,
						authorKind: "system",
						text: this.#doneLine(this.#undoVerb(found.workspace.surface), target?.title ?? found.session.title),
						changeId,
						createdAt: now,
					},
				],
				updatedAt: now,
				closedAt: openCount === 0 && !drawerOpen ? now : null,
			};
			this.#commitLocalChangesToBase(found.workspace.surface.id, [changeId]);
			const outcome = approvalOutcome(updated, drawerOpen);
			this.#applySession(updated, outcome);
			this.#offerUndo(target?.title ?? updated.title, [changeId], this.#undoVerb(found.workspace.surface));
			return outcome;
		}
		const updated = await this.#run(`change:${changeId}`, (client) => client.approveSurfaceChange(changeId));
		if (!updated) return undefined;
		const outcome = approvalOutcome(updated, drawerOpen);
		this.#applySession(updated, outcome);
		const change = updated.changes.find((item) => item.id === changeId);
		this.#offerUndo(change?.title ?? updated.title, [changeId], this.#undoVerbFor(updated.surfaceId));
		void this.refreshSurfaces();
		return outcome;
	}

	async approveAll(sessionId: string): Promise<boolean> {
		const before = this.session(sessionId);
		const found = this.#sessionAt(sessionId);
		if (this.isLocalInteractive && found && isLocalSurfaceId(found.workspace.surface.id)) {
			const now = new Date().toISOString();
			const openIds = found.session.changes.filter(isOpenChange).map((change) => change.id);
			const changes = found.session.changes.map((change) =>
				isOpenChange(change) ? { ...change, status: "merged" as const, canUndo: true, resolvedAt: now } : change,
			);
			const updated: SurfaceSession = {
				...found.session,
				state: "completed",
				hasActiveChat: false,
				changes,
				openChangeCount: 0,
				updatedAt: now,
				closedAt: now,
			};
			this.#commitLocalChangesToBase(found.workspace.surface.id, openIds);
			if (this.drawerOpenOn(sessionId)) this.store.set({ drawer: undefined });
			this.#applySession(updated, "history");
			if (openIds.length > 0) this.#offerUndo(updated.title, openIds, this.#undoVerb(found.workspace.surface));
			return true;
		}
		const updated = await this.#run(`session:${sessionId}`, (client) => client.approveSessionAll(sessionId));
		if (!updated) return false;
		const merged = updated.changes
			.filter(
				(change) =>
					change.status === "merged" && before?.changes.find((item) => item.id === change.id)?.status !== "merged",
			)
			.map((change) => change.id);
		if (this.drawerOpenOn(sessionId)) {
			this.store.set({ drawer: undefined });
			void this.#options.client?.setSessionChatOpen(sessionId, false).catch(() => undefined);
		}
		this.#applySession(updated, "history");
		this.#offerUndo(updated.title, merged, this.#undoVerbFor(updated.surfaceId));
		void this.refreshSurfaces();
		return true;
	}

	async discardSession(sessionId: string): Promise<boolean> {
		const session = this.session(sessionId);
		if (!session) return false;
		if (this.isLocalInteractive && isLocalSurfaceId(session.surfaceId)) {
			const now = new Date().toISOString();
			const changes = session.changes.map((change) =>
				isOpenChange(change) ? { ...change, status: "discarded" as const } : change,
			);
			const updated: SurfaceSession = {
				...session,
				state: "discarded",
				hasActiveChat: false,
				changes,
				openChangeCount: 0,
				updatedAt: now,
				closedAt: now,
			};
			if (this.drawerOpenOn(sessionId)) this.store.set({ drawer: undefined });
			this.#applySession(updated, "history");
			return true;
		}
		let latest: SurfaceSession | undefined = session;
		for (const change of session.changes.filter(isOpenChange)) {
			const next = await this.#run(`change:${change.id}`, (client) => client.discardSurfaceChange(change.id));
			if (!next) return false;
			latest = next;
		}
		if (this.drawerOpenOn(sessionId)) {
			this.store.set({ drawer: undefined });
			void this.#options.client?.setSessionChatOpen(sessionId, false).catch(() => undefined);
		}
		if (latest) this.#applySession(latest, "history");
		return true;
	}

	async undo(): Promise<boolean> {
		const undo = this.state.undo;
		if (!undo) return false;
		if (this.#undoTimer) clearTimeout(this.#undoTimer);
		this.store.set({ undo: undefined });
		if (this.isLocalInteractive && undo.changeIds.every((id) => id.startsWith("local-"))) {
			return Boolean(this.#undoLocalChangeIds(undo.changeIds));
		}
		let restored: SurfaceSession | undefined;
		for (const changeId of undo.changeIds) {
			const next = await this.#run(`undo:${changeId}`, (client) => client.undoSurfaceChange(changeId));
			if (!next) return false;
			restored = next;
		}
		if (restored) this.#applySession(restored, approvalOutcome(restored, this.drawerOpenOn(restored.id)));
		void this.refreshSurfaces();
		return true;
	}

	async revertSession(sessionId: string): Promise<boolean> {
		const session = this.session(sessionId);
		if (!session) return false;
		const undoable = session.changes.filter((item) => item.status === "merged" && item.canUndo);
		if (this.isLocalInteractive && isLocalSurfaceId(session.surfaceId)) {
			return Boolean(this.#undoLocalChangeIds(undoable.map((item) => item.id)));
		}
		let restored: SurfaceSession | undefined;
		for (const change of undoable) {
			const next = await this.#run(`undo:${change.id}`, (client) => client.undoSurfaceChange(change.id));
			if (!next) return false;
			restored = next;
		}
		if (restored) this.#applySession(restored, approvalOutcome(restored, false));
		void this.refreshSurfaces();
		return Boolean(restored);
	}

	async chooseVariant(exploration: SurfaceExplorationSet, sessionId: string): Promise<boolean> {
		if (this.isLocalInteractive && isLocalSurfaceId(exploration.surfaceId)) {
			const workspace = this.workspace(exploration.surfaceId);
			if (!workspace) return false;
			const now = new Date().toISOString();
			const variantIds = new Set(exploration.variantSessionIds);
			const chosen = workspace.activeSessions.find((item) => item.id === sessionId);
			if (!chosen) return false;
			const mergedIds = chosen.changes.filter(isOpenChange).map((change) => change.id);
			const closedVariants: SurfaceSession[] = [];
			const remainingActive: SurfaceSession[] = [];
			for (const session of workspace.activeSessions) {
				if (!variantIds.has(session.id)) {
					remainingActive.push(session);
					continue;
				}
				if (session.id === sessionId) {
					closedVariants.push({
						...session,
						state: "completed",
						changes: session.changes.map((change) =>
							isOpenChange(change)
								? { ...change, status: "merged" as const, canUndo: true, resolvedAt: now }
								: change,
						),
						openChangeCount: 0,
						updatedAt: now,
						closedAt: now,
					});
				} else {
					closedVariants.push({
						...session,
						state: "discarded",
						changes: session.changes.map((change) =>
							isOpenChange(change) ? { ...change, status: "discarded" as const } : change,
						),
						openChangeCount: 0,
						updatedAt: now,
						closedAt: now,
					});
				}
			}
			const nextExplorations = workspace.explorations.map((item) =>
				item.id === exploration.id
					? { ...item, status: "chosen" as const, chosenSessionId: sessionId, resolvedAt: now }
					: item,
			);
			this.#commitLocalChangesToBase(exploration.surfaceId, mergedIds);
			const refreshedSurface =
				this.state.surfaces.find((item) => item.id === exploration.surfaceId) ?? workspace.surface;
			const nextWorkspace: SurfaceWorkspace = {
				...workspace,
				surface: refreshedSurface,
				activeSessions: remainingActive,
				recentHistory: [...closedVariants, ...workspace.recentHistory],
				explorations: nextExplorations,
			};
			this.#putWorkspace({ ...nextWorkspace, surface: this.#syncLocalSurfaceCounts(nextWorkspace) });
			this.store.set({ mode: this.state.mode === "compare" ? "preview" : this.state.mode });
			if (mergedIds.length > 0) this.#offerUndo(chosen.explorationVariantLabel ?? chosen.title, mergedIds);
			return true;
		}
		const chosen = await this.#run(`exploration:${exploration.id}`, (client) =>
			client.chooseExploration(exploration.id, sessionId),
		);
		if (!chosen) return false;
		this.store.set({ mode: this.state.mode === "compare" ? "preview" : this.state.mode });
		await this.refreshWorkspace(exploration.surfaceId);
		this.#offerUndo(
			chosen.explorationVariantLabel ?? chosen.title,
			chosen.changes.filter((change) => change.status === "merged").map((change) => change.id),
		);
		void this.refreshSurfaces();
		return true;
	}

	async reply(sessionId: string, text: string): Promise<boolean> {
		const message = text.trim();
		if (!message || this.state.busy[`reply:${sessionId}`]) return false;
		const existing = this.session(sessionId);
		if (this.isLocalInteractive && existing && isLocalSurfaceId(existing.surfaceId)) {
			const now = new Date().toISOString();
			const updated: SurfaceSession = {
				...existing,
				messages: [
					...existing.messages,
					{
						id: `local-message-${++this.#localSeq}`,
						sessionId,
						authorKind: "member",
						text: message,
						changeId: null,
						createdAt: now,
					},
					{
						id: `local-message-${++this.#localSeq}`,
						sessionId,
						authorKind: "session",
						text: t("Got it — updated the open changes with “{note}”.", { note: message }),
						changeId: null,
						createdAt: now,
					},
				],
				updatedAt: now,
			};
			this.#applySession(updated, "open");
			return true;
		}
		const priorMatches =
			(existing ? memberMessageMatches(existing, message) : 0) +
			this.state.notes.filter((note) => note.sessionId === sessionId && note.text === message).length;
		const note: SurfaceNote = {
			id: ++this.#noteSeq,
			sessionId,
			text: message,
			at: new Date().toISOString(),
			priorMatches,
		};
		this.store.set((state) => ({ notes: [...state.notes, note] }));
		const updated = await this.#run(`reply:${sessionId}`, (client) => client.replySurfaceSession(sessionId, message));
		if (!updated) {
			this.store.set((state) => ({ notes: state.notes.filter((item) => item.id !== note.id) }));
			return false;
		}
		if (this.state.workspaces[updated.surfaceId]) this.#applySession(updated, "open");
		else this.store.set((state) => ({ notes: reconcileNotes(state.notes, [updated]) }));
		return true;
	}

	openDrawer(surfaceId: string, sessionId: string): void {
		const previous = this.state.drawer;
		if (previous?.sessionId === sessionId) return;
		if (previous) this.closeDrawer();
		this.store.set({ drawer: { surfaceId, sessionId } });
		if (!isLocalSurfaceId(surfaceId))
			void this.#options.client?.setSessionChatOpen(sessionId, true).catch(() => undefined);
	}

	closeDrawer(): void {
		const drawer = this.state.drawer;
		if (!drawer) return;
		this.store.set({ drawer: undefined });
		if (!isLocalSurfaceId(drawer.surfaceId))
			void this.#options.client?.setSessionChatOpen(drawer.sessionId, false).catch(() => undefined);
		const session = this.session(drawer.sessionId);
		if (session && sessionHeld(session)) this.#applySession(session, "history");
	}

	isChangeShown(changeId: string): boolean {
		return !this.state.hiddenChanges[changeId];
	}

	async toggleChange(surfaceId: string, changeId: string): Promise<void> {
		this.store.set((state) => {
			const hiddenChanges = { ...state.hiddenChanges };
			if (hiddenChanges[changeId]) delete hiddenChanges[changeId];
			else hiddenChanges[changeId] = true;
			return { hiddenChanges };
		});
		await this.#syncPreview(surfaceId);
	}

	async pickVariant(surfaceId: string, explorationId: string, sessionId: string): Promise<void> {
		this.store.set((state) => ({ variantPick: { ...state.variantPick, [explorationId]: sessionId } }));
		await this.#syncPreview(surfaceId);
	}

	pickedVariant(exploration: SurfaceExplorationSet): string | undefined {
		return this.state.variantPick[exploration.id] ?? exploration.variantSessionIds[0];
	}

	previewSelection(surfaceId: string): { toggledChangeIds: string[]; explorationSessionId: string | null } {
		const workspace = this.workspace(surfaceId);
		const toggledChangeIds: string[] = [];
		for (const session of workspace?.activeSessions ?? [])
			for (const change of session.changes)
				if (isOpenChange(change) && this.isChangeShown(change.id)) toggledChangeIds.push(change.id);
		const exploration = openExplorations(workspace)[0];
		return { toggledChangeIds, explorationSessionId: exploration ? (this.pickedVariant(exploration) ?? null) : null };
	}

	async #syncPreview(surfaceId: string): Promise<void> {
		if (isLocalSurfaceId(surfaceId) || !this.#options.client) return;
		const selection = this.previewSelection(surfaceId);
		const previewState = await this.#run(`preview:${surfaceId}`, (client) =>
			client.setPreviewSelection(surfaceId, selection),
		);
		const workspace = this.workspace(surfaceId);
		if (previewState && workspace) this.#putWorkspace({ ...workspace, previewState });
	}

	async publish(surfaceId: string): Promise<boolean> {
		if (this.isLocalInteractive && isLocalSurfaceId(surfaceId)) {
			const surface = this.state.surfaces.find((item) => item.id === surfaceId);
			if (!surface) return false;
			this.#putSurface({ ...surface, hasUnpublishedChanges: false, unpublishedChangeCount: 0 });
			return true;
		}
		const surface = await this.#run(`publish:${surfaceId}`, (client) => client.publishSurface(surfaceId));
		if (!surface) return false;
		this.#putSurface(surface);
		return true;
	}

	async setAutoPublish(surfaceId: string, enabled: boolean): Promise<boolean> {
		if (this.isLocalInteractive && isLocalSurfaceId(surfaceId)) {
			const surface = this.state.surfaces.find((item) => item.id === surfaceId);
			if (!surface) return false;
			this.#putSurface({ ...surface, autoPublish: enabled });
			return true;
		}
		const surface = await this.#run(`auto:${surfaceId}`, (client) =>
			client.setSurfaceAutoPublish(surfaceId, enabled),
		);
		if (!surface) return false;
		this.#putSurface(surface);
		return true;
	}

	#putSurface(surface: SurfaceSummary): void {
		this.store.set((state) => {
			const workspace = state.workspaces[surface.id];
			const nextSurfaces = sortSurfaces(state.surfaces.map((item) => (item.id === surface.id ? surface : item)));
			return {
				surfaces: nextSurfaces,
				workspaces: workspace ? { ...state.workspaces, [surface.id]: { ...workspace, surface } } : state.workspaces,
			};
		});
	}

	async refreshSurfaces(): Promise<void> {
		const client = this.#options.client;
		if (!client || this.state.source !== "cloud") return;
		try {
			const surfaces = await client.listSurfaces(this.#options.companyId);
			if (!this.#options.signal.aborted && surfaces.length) this.store.set({ surfaces: sortSurfaces(surfaces) });
		} catch {
			/* WHY: Counts refresh opportunistically; the last good list stays on screen. */
		}
	}

	async toggleAutomation(automationId: string, enabled: boolean): Promise<boolean> {
		if (this.isLocalInteractive && automationId.startsWith("local-")) {
			this.store.set((state) => ({
				automations: state.automations.map((item) => (item.id === automationId ? { ...item, enabled } : item)),
			}));
			return true;
		}
		const updated = await this.#run(`automation:${automationId}`, (client) =>
			client.toggleAutomation(automationId, enabled),
		);
		if (!updated) return false;
		this.store.set((state) => ({
			automations: state.automations.map((item) => (item.id === updated.id ? updated : item)),
		}));
		return true;
	}

	async applyMigration(input: ApplySurfaceMigrationInput): Promise<boolean> {
		if (this.isLocalInteractive) {
			const migration = this.state.migration;
			const agentsById = new Map((migration?.specialistAgents ?? []).map((agent) => [agent.agentId, agent]));
			const folded: Record<string, true> = { ...this.state.foldedAgentIds };
			const newAutomations: SurfaceAutomationSummary[] = [];
			for (const decision of input.agentDecisions) {
				if (decision.action !== "keep") folded[decision.agentId] = true;
				if (decision.action === "fold_to_automation") {
					const agent = agentsById.get(decision.agentId);
					if (!agent) continue;
					newAutomations.push({
						id: `local-automation-${++this.#localSeq}`,
						key: agent.handle.toLowerCase().replace(/[^a-z0-9]+/g, "-") || `automation-${this.#localSeq}`,
						title: agent.name,
						scheduleSummary: agent.role || t("Scheduled check"),
						targetSurfaceSlug: decision.targetSurfaceSlug ?? null,
						outputMode: "surface_session",
						enabled: true,
						status: "idle",
						lastRunAt: null,
						lastOutcomeSummary: t("Folded from agent"),
						nextRunAt: null,
					});
				}
			}
			this.store.set((state) => ({
				automations: [...state.automations, ...newAutomations],
				foldedAgentIds: folded,
				migrationDismissed: true,
				...(migration ? { migration: { ...migration, alreadyMigrated: true } } : {}),
				error: undefined,
			}));
			return true;
		}
		const surfaces = await this.#run("migration", (client) =>
			client.applyMigrationChecklist(this.#options.companyId, input),
		);
		if (!surfaces) return false;
		const migration = this.state.migration;
		this.store.set({
			source: surfaces.length ? "cloud" : this.state.source,
			surfaces: surfaces.length ? sortSurfaces(surfaces) : this.state.surfaces,
			...(migration ? { migration: { ...migration, alreadyMigrated: true } } : {}),
		});
		const client = this.#options.client;
		if (client) await this.#loadAutomations(client);
		return true;
	}
}

function sortSurfaces(surfaces: readonly SurfaceSummary[]): SurfaceSummary[] {
	return surfaces
		.filter((surface) => surface.status !== "archived")
		.sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title));
}

const registry = new WeakMap<object, SurfacesStore>();

export function attachSurfaces(owner: object, store: SurfacesStore): void {
	registry.set(owner, store);
}

export function surfacesOf(owner: object): SurfacesStore | undefined {
	return registry.get(owner);
}
