import type { SurfaceFolderContents } from "@qorpera/cloud-client/surface-folder-files";
import {
	composeStudioPreview,
	detectLineageReconciliationTarget,
	findMatchingStudioReconciliation,
	type LineageReconciliationTarget,
} from "@qorpera/cloud-client/surface-studio-patches";
import {
	type ApplySurfaceMigrationInput,
	type CloudSurfacesClient,
	isMissingSurfaceRpcError,
	isSurfacesDisabledError,
	type StartSurfaceSessionOptions,
} from "@qorpera/cloud-client/surfaces";
import {
	type CompiledIdentityTokens,
	type CrossSurfaceHandoffRequest,
	compileIdentityTokens,
	countOpenSurfaceChanges,
	IDENTITY_TOKENS_JSON_PATH,
	nextSurfaceSessionLifecycleState,
	OPEN_SURFACE_CHANGE_STATUSES,
	RUNNING_SURFACE_SESSION_STATES,
	type StudioBinaryRef,
	type StudioPatchChange,
	type StudioPatchOp,
	type SurfaceAutomationSummary,
	type SurfaceChangeUnit,
	type SurfaceExplorationSet,
	type SurfaceImageRef,
	type SurfaceMigrationChecklist,
	type SurfacePreviewCompositionState,
	type SurfaceReconciliation,
	type SurfaceSession,
	type SurfaceSessionImages,
	type SurfaceSummary,
	type SurfaceUnseenNote,
	type SurfaceWorkspace,
} from "@qorpera/contracts";
import { phrase, t } from "../ui/preferences.ts";
import { type SurfaceFigureId, surfaceFigureIcon } from "../ui/surface-figure.ts";
import { Store } from "./state.ts";
import {
	isOpsKind,
	isThetabandCompany,
	type SurfaceKind,
	type SurfaceLook,
	slugifySurfaceTitle,
	surfaceLookOf,
} from "./surface-kinds.ts";

type LocalSandboxModule = typeof import("./surface-local-sandbox.ts");
let localSandbox: LocalSandboxModule | undefined;
let localSandboxLoading: Promise<LocalSandboxModule> | undefined;

export function registerLocalSandbox(mod: LocalSandboxModule): void {
	localSandbox = mod;
}

export function getLocalSandbox(): LocalSandboxModule | undefined {
	return localSandbox;
}

export function loadLocalSandbox(): Promise<LocalSandboxModule> {
	if (localSandbox) return Promise.resolve(localSandbox);
	localSandboxLoading ??= import("./surface-local-sandbox.ts").then(
		(mod) => {
			localSandbox = mod;
			return mod;
		},
		(error: unknown) => {
			localSandboxLoading = undefined;
			throw error;
		},
	);
	return localSandboxLoading;
}

const SURFACE_BATCH_CONCURRENCY = 4;

async function runBounded<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
	const count = Math.min(limit, items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: count }, async () => {
			while (next < items.length) {
				const index = next++;
				await worker(items[index]!);
			}
		}),
	);
}

const APPROVAL_STATUS_RANK: Record<SurfaceChangeUnit["status"], number> = {
	staged: 0,
	conflicted: 0,
	reverted: 0,
	merging: 1,
	merged: 2,
	discarded: 2,
};

function mergeApprovedSession(previous: SurfaceSession | undefined, incoming: SurfaceSession): SurfaceSession {
	if (!previous) return incoming;
	const newer = incoming.updatedAt >= previous.updatedAt ? incoming : previous;
	const older = newer === incoming ? previous : incoming;
	const olderById = new Map(older.changes.map((change) => [change.id, change]));
	const changes = newer.changes.map((change) => {
		const other = olderById.get(change.id);
		if (!other) return change;
		return APPROVAL_STATUS_RANK[other.status] > APPROVAL_STATUS_RANK[change.status] ? other : change;
	});
	const openChangeCount = countOpenSurfaceChanges(changes);
	return { ...newer, changes, openChangeCount };
}

function approvalWaves(
	changeIds: readonly string[],
	changes: readonly SurfaceChangeUnit[] | undefined,
): readonly (readonly string[])[] {
	if (changeIds.length <= 1 || !changes?.length) return [changeIds];
	const selected = new Set(changeIds);
	const byId = new Map(changes.map((change) => [change.id, change]));
	const remaining = new Set(changeIds);
	const waves: string[][] = [];
	while (remaining.size > 0) {
		const wave: string[] = [];
		for (const id of changeIds) {
			if (!remaining.has(id)) continue;
			const deps = byId.get(id)?.dependsOnChangeIds ?? [];
			if (!deps.some((dep) => selected.has(dep) && remaining.has(dep))) wave.push(id);
		}
		if (wave.length === 0) {
			for (const id of changeIds) if (remaining.has(id)) waves.push([id]);
			break;
		}
		for (const id of wave) remaining.delete(id);
		waves.push(wave);
	}
	return waves;
}

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
	| "chooseSurfaceChangeOption"
	| "discardSurfaceOptionGroup"
	| "discardSurfaceSession"
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
> &
	Partial<
		Pick<
			CloudSurfacesClient,
			| "isSurfacesEnabled"
			| "mintPreviewPass"
			| "createSurface"
			| "bootstrapCompanySurfaces"
			| "discardExploration"
			| "createAutomation"
			| "updateAutomation"
			| "deleteAutomation"
			| "offerAutomation"
			| "answerAutomationOffer"
			| "setSurfaceFigure"
			| "surfaceSessionImages"
			| "noteSurfaceSession"
			| "unseenSurfaceNotes"
			| "markSurfaceNotesSeen"
			| "askSurfacePublish"
			| "declineSurfacePublishAsk"
			| "withdrawSurfacePublishAsk"
			| "ensureSurfaceReconciliation"
		>
	>;

export type SurfacesSource = "loading" | "disabled" | "cloud" | "local";
export type SurfacePreviewMode = "live" | "preview" | "compare" | "report";
export type SurfacePreviewPanelState = "auto" | "open" | "closed";
export type SurfaceDevice = "desktop" | "mobile";
export type ApprovalOutcome = "open" | "hold" | "history";
export type SurfaceUpdatePhase = "publishing" | "merging" | "updating";

export const SURFACE_ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;
export const DEFAULT_SURFACE_ZOOM = 1;
export const MIN_SURFACE_ZOOM: number = SURFACE_ZOOM_LEVELS[0];
export const MAX_SURFACE_ZOOM: number = SURFACE_ZOOM_LEVELS[SURFACE_ZOOM_LEVELS.length - 1]!;

export function clampSurfaceZoom(zoom: number): number {
	if (!Number.isFinite(zoom)) return DEFAULT_SURFACE_ZOOM;
	const clamped = Math.min(MAX_SURFACE_ZOOM, Math.max(MIN_SURFACE_ZOOM, zoom));
	return Math.round(clamped * 100) / 100;
}

export function stepSurfaceZoom(current: number, direction: -1 | 1): number {
	const value = clampSurfaceZoom(current);
	if (direction > 0) {
		return SURFACE_ZOOM_LEVELS.find((level) => level > value + 0.001) ?? MAX_SURFACE_ZOOM;
	}
	for (let index = SURFACE_ZOOM_LEVELS.length - 1; index >= 0; index -= 1) {
		const level = SURFACE_ZOOM_LEVELS[index]!;
		if (level < value - 0.001) return level;
	}
	return MIN_SURFACE_ZOOM;
}

export const SURFACE_UNDO_MS = 5_000;
const POLL_MS = 4_000;
const FAST_POLL_MS = 1_000;
const HINT_DEBOUNCE_MS = 50;
const FOLDER_HINT_DEBOUNCE_MS = 50;
export const PREVIEW_TOGGLE_DEBOUNCE_MS = 50;
const PREVIEW_SYNC_RETRY_MS = [1_500, 3_000, 6_000] as const;
export const PREVIEW_PASS_TTL_MS = 45_000;
const MAX_LOCAL_SANDBOX_CACHE = 8;
const LOCAL_AUTOMATION_OWNER = { ownable: false, ownerUserId: null, offer: null } as const;

export interface PendingStudioPatch {
	readonly changeId: string;
	readonly ops: readonly StudioPatchOp[];
	readonly rev: number;
}

export const MAX_CACHED_BINARY_BYTES = 64 * 1024 * 1024;
const MAX_CACHED_CLOUD_FILES = 6;

function sameFileMap(
	a: Readonly<Record<string, string>> | undefined,
	b: Readonly<Record<string, string>> | undefined,
): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	if (aKeys.length !== bKeys.length) return false;
	for (const key of aKeys) {
		if (!Object.hasOwn(b, key) || a[key] !== b[key]) return false;
	}
	return true;
}

function pruneCloudSurfaceFiles<T>(
	current: Readonly<Record<string, T>>,
	surfaceId: string,
	files: T,
	keepIds: ReadonlySet<string>,
): Record<string, T> {
	const next: Record<string, T> = {};
	for (const [id, entry] of Object.entries(current)) {
		if (id !== surfaceId) next[id] = entry;
	}
	next[surfaceId] = files;
	const keys = Object.keys(next);
	let excess = keys.length - MAX_CACHED_CLOUD_FILES;
	if (excess > 0) {
		for (const id of keys) {
			if (excess <= 0) break;
			if (id === surfaceId || keepIds.has(id)) continue;
			delete next[id];
			excess--;
		}
	}
	return next;
}

function sameBinaryMap(
	a: Readonly<Record<string, StudioBinaryRef>> | undefined,
	b: Readonly<Record<string, StudioBinaryRef>> | undefined,
): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	const aKeys = Object.keys(a);
	if (aKeys.length !== Object.keys(b).length) return false;
	return aKeys.every(
		(key) =>
			Object.hasOwn(b, key) &&
			a[key]!.fileSha256 === b[key]!.fileSha256 &&
			a[key]!.manifestSha256 === b[key]!.manifestSha256,
	);
}

export function normalizeSurfacePath(path: string, folderRoot: string | null | undefined): string {
	const cleaned = path.trim().replace(/^\/+|\/+$/g, "");
	const root = folderRoot?.trim().replace(/^\/+|\/+$/g, "") ?? "";
	if (!root || !cleaned || cleaned === root || cleaned.startsWith(`${root}/`)) return cleaned;
	return `${root}/${cleaned}`;
}

export function normalizeStudioPatchOps(
	ops: readonly StudioPatchOp[],
	folderRoot: string | null | undefined,
): readonly StudioPatchOp[] {
	const root = folderRoot?.trim().replace(/^\/+|\/+$/g, "") ?? "";
	if (!root) return ops;
	let changed = false;
	const next = ops.map((op) => {
		const target = normalizeSurfacePath(op.path, root);
		if (target === op.path) return op;
		changed = true;
		return { ...op, path: target };
	});
	return changed ? next : ops;
}

export type SurfaceUndoVerb = "merged" | "sent" | "done";

export interface SurfaceUndo {
	readonly id: number;
	readonly label: string;
	readonly changeIds: readonly string[];
	readonly verb: SurfaceUndoVerb;
	readonly pending?: boolean;
}

export interface SurfaceNote {
	readonly id: number;
	readonly sessionId: string;
	readonly text: string;
	readonly at: string;
	readonly priorMatches: number;
	readonly files?: readonly File[];
	readonly to?: readonly string[];
}

export interface SurfaceTeammate {
	readonly userId: string;
	readonly name: string;
}

export interface CreateSurfaceInput {
	readonly title: string;
	readonly slug?: string;
	readonly archetype: "live_build" | "studio";
	readonly icon?: string;
	readonly folderRoot?: string;
	readonly initialPrompt?: string;
	readonly kind?: SurfaceKind;
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
	readonly cloudSurfaceFiles: Readonly<Record<string, Readonly<Record<string, string>>>>;
	readonly localStudioBinaries: Readonly<Record<string, Readonly<Record<string, StudioBinaryRef>>>>;
	readonly cloudSurfaceBinaries: Readonly<Record<string, Readonly<Record<string, StudioBinaryRef>>>>;
	readonly pendingStudioPatches: Readonly<Record<string, readonly PendingStudioPatch[]>>;
	readonly loadingCloudFiles: Readonly<Record<string, true>>;
	readonly updatingCloudFiles: Readonly<Record<string, true>>;
	readonly surfaceLooks: Readonly<Record<string, SurfaceLook>>;
	readonly drawer?: { readonly surfaceId: string; readonly sessionId: string; readonly explorationId?: string };
	readonly highlight?: { readonly surfaceId: string; readonly sessionId: string };
	readonly mode: SurfacePreviewMode;
	readonly activeReportSlug?: string;
	readonly previewPanel: SurfacePreviewPanelState;
	readonly opsPanelSurfaceId?: string;
	readonly compareTargetId?: string;
	readonly compareFocusSessionId?: string;
	readonly compareExcludedSessions: Readonly<Record<string, true>>;
	readonly device: SurfaceDevice;
	readonly websiteZoom: number;
	readonly phoneZoom: number;
	readonly hiddenChanges: Readonly<Record<string, boolean>>;
	readonly optionPick: Readonly<Record<string, string | null>>;
	readonly publishedChangeIds: Readonly<Record<string, true>>;
	readonly studioPatches: Readonly<Record<string, readonly StudioPatchOp[]>>;
	readonly variantPick: Readonly<Record<string, string>>;
	readonly insteadOf?: { readonly surfaceId: string; readonly explorationId: string };
	readonly collapsed: Readonly<Record<string, true>>;
	readonly notes: readonly SurfaceNote[];
	readonly sessionImages: Readonly<Record<string, SurfaceSessionImages>>;
	readonly unseenNotes: Readonly<Record<string, SurfaceUnseenNote>>;
	readonly reconciliationRequests: Readonly<Record<string, "pending" | "failed">>;
	readonly previewSyncing: Readonly<Record<string, true>>;
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
		if ((message.authorKind === "member" || message.authorKind === "note") && message.text.trim() === text)
			count += 1;
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
			if (isOpenVariant(session, workspace)) continue;
			items.push({ surface, session, running: isRunningSession(session) });
		}
	}
	return items.sort((a, b) => {
		const rank = (entry: ActiveTaskSessionEntry) =>
			entry.running ? 0 : entry.session.state === "needs_input" ? 1 : 2;
		return rank(a) - rank(b) || b.session.updatedAt.localeCompare(a.session.updatedAt);
	});
}

export function optionGroupId(sessionId: string, optionGroupKey: string): string {
	return `${sessionId}:${optionGroupKey}`;
}

export interface SurfaceChangeOptionGroup {
	readonly key: string;
	readonly title: string | null;
	readonly options: readonly SurfaceChangeUnit[];
}

export type SurfaceSessionChangeEntry =
	| { readonly kind: "change"; readonly change: SurfaceChangeUnit }
	| { readonly kind: "option_group"; readonly group: SurfaceChangeOptionGroup };

export function groupSessionChanges(changes: readonly SurfaceChangeUnit[]): SurfaceSessionChangeEntry[] {
	const counts = new Map<string, number>();
	for (const change of changes) {
		if (isOpenChange(change) && change.optionGroupKey) {
			counts.set(change.optionGroupKey, (counts.get(change.optionGroupKey) ?? 0) + 1);
		}
	}
	const emitted = new Set<string>();
	const entries: SurfaceSessionChangeEntry[] = [];
	for (const change of changes) {
		const key = isOpenChange(change) ? (change.optionGroupKey ?? null) : null;
		if (key && (counts.get(key) ?? 0) >= 2) {
			if (emitted.has(key)) continue;
			emitted.add(key);
			const options = changes.filter((item) => isOpenChange(item) && item.optionGroupKey === key);
			const title = options.find((item) => item.optionGroupTitle?.trim())?.optionGroupTitle?.trim() ?? null;
			entries.push({ kind: "option_group", group: { key, title, options } });
		} else {
			entries.push({ kind: "change", change });
		}
	}
	return entries;
}

export function pickedOptionChangeId(
	session: Pick<SurfaceSession, "id" | "changes">,
	optionGroupKey: string,
	optionPick: Readonly<Record<string, string | null>>,
): string | null {
	const options = session.changes.filter((change) => isOpenChange(change) && change.optionGroupKey === optionGroupKey);
	if (options.length === 0) return null;
	const key = optionGroupId(session.id, optionGroupKey);
	if (Object.hasOwn(optionPick, key)) {
		const picked = optionPick[key];
		if (picked === null) return null;
		if (picked && options.some((item) => item.id === picked)) return picked;
	}
	return options[0]!.id;
}

export function isSessionChangeShown(
	session: Pick<SurfaceSession, "id" | "changes"> & { readonly state?: SurfaceSession["state"] },
	change: SurfaceChangeUnit,
	state: Pick<SurfacesState, "hiddenChanges" | "optionPick">,
): boolean {
	if (!isOpenChange(change)) return false;
	if (change.optionGroupKey) {
		let openInGroup = 0;
		for (const item of session.changes) {
			if (isOpenChange(item) && item.optionGroupKey === change.optionGroupKey) openInGroup += 1;
		}
		if (openInGroup >= 2) {
			return pickedOptionChangeId(session, change.optionGroupKey, state.optionPick) === change.id;
		}
	}
	const explicit = state.hiddenChanges[change.id];
	if (explicit !== undefined) return !explicit;
	return session.state !== "failed";
}

export function openExplorations(workspace: SurfaceWorkspace | undefined): SurfaceExplorationSet[] {
	return workspace?.explorations.filter((set) => set.status === "open") ?? [];
}

function workspaceHasOpenWork(workspace: SurfaceWorkspace | undefined): boolean {
	return Boolean(workspace && (workspace.activeSessions.length > 0 || openExplorations(workspace).length > 0));
}

export function isOpenVariant(
	session: Pick<SurfaceSession, "explorationId">,
	workspace: Pick<SurfaceWorkspace, "explorations"> | undefined,
): boolean {
	return (
		Boolean(session.explorationId) &&
		(workspace?.explorations.some((set) => set.id === session.explorationId && set.status === "open") ?? false)
	);
}

export interface UnpublishedChangeEntry {
	readonly change: SurfaceChangeUnit;
	readonly session: SurfaceSession;
	readonly exploration?: SurfaceExplorationSet;
}

export function askedToPublish(surface: SurfaceSummary, userId: string | undefined): boolean {
	return Boolean(userId) && surface.publishAsk?.status === "open" && surface.publishAsk.askedUserId === userId;
}

export function unpublishedChanges(
	state: Pick<SurfacesState, "workspaces" | "publishedChangeIds">,
	surfaceId: string,
): UnpublishedChangeEntry[] {
	const workspace = state.workspaces[surfaceId];
	if (!workspace) return [];
	const seen = new Set<string>();
	const items: UnpublishedChangeEntry[] = [];
	const sessions = [...workspace.activeSessions, ...workspace.recentHistory];
	for (const session of sessions) {
		const exploration = session.explorationId
			? workspace.explorations.find((item) => item.id === session.explorationId)
			: undefined;
		for (const change of session.changes) {
			if (
				change.status !== "merged" ||
				change.publishedAt ||
				state.publishedChangeIds[change.id] ||
				seen.has(change.id)
			)
				continue;
			seen.add(change.id);
			items.push({ change, session, ...(exploration ? { exploration } : {}) });
		}
	}
	return items.sort((a, b) =>
		(b.change.resolvedAt ?? b.change.createdAt).localeCompare(a.change.resolvedAt ?? a.change.createdAt),
	);
}

export function surfaceBySlug(state: Pick<SurfacesState, "surfaces">, slug: string): SurfaceSummary | undefined {
	return state.surfaces.find((surface) => surface.slug === slug);
}

function findIdentitySurface(state: Pick<SurfacesState, "surfaces" | "surfaceLooks">): SurfaceSummary | undefined {
	return state.surfaces.find(
		(surface) =>
			surface.status === "active" &&
			(surface.isGlobal === true || surfaceLookOf(surface, state.surfaceLooks).kind === "identity"),
	);
}

export function effectiveStudioBaseFiles(
	state: Pick<SurfacesState, "localStudioBase"> &
		Partial<Pick<SurfacesState, "cloudSurfaceFiles" | "pendingStudioPatches">>,
	surfaceId: string,
): Readonly<Record<string, string>> | undefined {
	const cloudFiles = state.cloudSurfaceFiles?.[surfaceId];
	const localFiles = state.localStudioBase[surfaceId];
	const pending = state.pendingStudioPatches?.[surfaceId];
	if (!cloudFiles && !localFiles && (!pending || pending.length === 0)) return undefined;
	let base: Readonly<Record<string, string>> =
		cloudFiles && localFiles ? { ...cloudFiles, ...localFiles } : (cloudFiles ?? localFiles ?? {});
	if (pending && pending.length > 0) {
		base = composeStudioPreview(
			base,
			pending.map((item) => ({ changeId: item.changeId, ops: item.ops })),
		).files;
	}
	return base;
}

export function effectiveStudioBaseBinaries(
	state: Partial<Pick<SurfacesState, "localStudioBinaries" | "cloudSurfaceBinaries" | "pendingStudioPatches">>,
	surfaceId: string,
): Readonly<Record<string, StudioBinaryRef>> {
	const cloud = state.cloudSurfaceBinaries?.[surfaceId];
	const local = state.localStudioBinaries?.[surfaceId];
	const pending = state.pendingStudioPatches?.[surfaceId];
	const base: Readonly<Record<string, StudioBinaryRef>> =
		cloud && local ? { ...cloud, ...local } : (cloud ?? local ?? {});
	if (!pending?.some((item) => item.ops.some((op) => op.op === "write_file" || op.op === "delete"))) return base;
	return composeStudioPreview(
		{},
		pending.map((item) => ({ changeId: item.changeId, ops: item.ops })),
		undefined,
		base,
	).binaries;
}

export interface CompanyIdentityFiles {
	readonly surfaceId: string;
	readonly folderRoot: string;
	readonly files: Readonly<Record<string, string>>;
	readonly baseFiles: Readonly<Record<string, string>>;
	readonly binaries: Readonly<Record<string, StudioBinaryRef>>;
	readonly baseBinaries: Readonly<Record<string, StudioBinaryRef>>;
}

const identityFilesByState = new WeakMap<SurfacesState, CompanyIdentityFiles | null>();
const compiledIdentityByFiles = new WeakMap<CompanyIdentityFiles, CompiledIdentityTokens | null>();
let lastIdentityFiles:
	| {
			readonly identityId: string;
			readonly folderRoot: string | null | undefined;
			readonly liveMode: boolean;
			readonly cloudFiles: Readonly<Record<string, string>> | undefined;
			readonly localFiles: Readonly<Record<string, string>> | undefined;
			readonly cloudBinaries: Readonly<Record<string, StudioBinaryRef>> | undefined;
			readonly localBinaries: Readonly<Record<string, StudioBinaryRef>> | undefined;
			readonly pendingPatches: readonly PendingStudioPatch[] | undefined;
			readonly workspace: SurfaceWorkspace | undefined;
			readonly variantPick: Readonly<Record<string, string>>;
			readonly hiddenChanges: Readonly<Record<string, boolean>>;
			readonly optionPick: Readonly<Record<string, string | null>>;
			readonly studioPatches: Readonly<Record<string, readonly StudioPatchOp[]>>;
			readonly result: CompanyIdentityFiles;
	  }
	| undefined;

function sameRecord<T>(a: Readonly<Record<string, T>>, b: Readonly<Record<string, T>>): boolean {
	if (a === b) return true;
	const keys = Object.keys(a);
	if (keys.length !== Object.keys(b).length) return false;
	return keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key]);
}

function sameIdentityFiles(a: CompanyIdentityFiles, b: CompanyIdentityFiles): boolean {
	return (
		a.surfaceId === b.surfaceId &&
		a.folderRoot === b.folderRoot &&
		sameRecord(a.files, b.files) &&
		sameRecord(a.baseFiles, b.baseFiles) &&
		sameRecord(a.binaries, b.binaries) &&
		sameRecord(a.baseBinaries, b.baseBinaries)
	);
}

export function companyIdentityFiles(state: SurfacesState): CompanyIdentityFiles | null {
	if (identityFilesByState.has(state)) return identityFilesByState.get(state) ?? null;
	const identity = findIdentitySurface(state);
	if (!identity) {
		identityFilesByState.set(state, null);
		return null;
	}
	const cloudFiles = state.cloudSurfaceFiles[identity.id];
	const localFiles = state.localStudioBase[identity.id];
	const cloudBinaries = state.cloudSurfaceBinaries[identity.id];
	const localBinaries = state.localStudioBinaries[identity.id];
	const pendingPatches = state.pendingStudioPatches[identity.id];
	const liveMode = state.mode === "live";
	const workspace = liveMode ? undefined : state.workspaces[identity.id];
	const last = lastIdentityFiles;
	if (
		last &&
		last.identityId === identity.id &&
		last.folderRoot === identity.folderRoot &&
		last.liveMode === liveMode &&
		last.cloudFiles === cloudFiles &&
		last.localFiles === localFiles &&
		last.cloudBinaries === cloudBinaries &&
		last.localBinaries === localBinaries &&
		last.pendingPatches === pendingPatches &&
		(liveMode ||
			(last.workspace === workspace &&
				last.variantPick === state.variantPick &&
				last.hiddenChanges === state.hiddenChanges &&
				last.optionPick === state.optionPick &&
				last.studioPatches === state.studioPatches))
	) {
		identityFilesByState.set(state, last.result);
		return last.result;
	}
	const baseFiles: Readonly<Record<string, string>> = effectiveStudioBaseFiles(state, identity.id) ?? {};
	const baseBinaries = effectiveStudioBaseBinaries(state, identity.id);
	let files: Readonly<Record<string, string>> = baseFiles;
	let binaries: Readonly<Record<string, StudioBinaryRef>> = baseBinaries;
	if (!liveMode && workspace) {
		const pickedVariants = new Set(
			openExplorations(workspace)
				.map((exploration) => state.variantPick[exploration.id] ?? exploration.variantSessionIds[0])
				.filter((id): id is string => Boolean(id)),
		);
		const ordered: StudioPatchChange[] = [];
		for (const session of workspace.activeSessions) {
			if (isOpenVariant(session, workspace) && !pickedVariants.has(session.id)) continue;
			for (const change of session.changes) {
				if (change.kind !== "folder_patch" || !isSessionChangeShown(session, change, state)) continue;
				const ops = state.studioPatches[change.id] ?? change.patchManifest;
				if (ops?.length)
					ordered.push({
						changeId: change.id,
						ops: normalizeStudioPatchOps(ops, identity.folderRoot),
						...(change.baseFiles ? { baseFiles: change.baseFiles } : {}),
						...(change.previewBaseChangeIds?.length ? { previewBaseChangeIds: change.previewBaseChangeIds } : {}),
					});
			}
		}
		if (ordered.length > 0) {
			const composed = composeStudioPreview(baseFiles, ordered, identity.folderRoot ?? "identity", baseBinaries, {
				reconciliations: workspace.reconciliations,
			});
			files = composed.files;
			binaries = composed.binaries;
		}
	}
	const fresh: CompanyIdentityFiles = {
		surfaceId: identity.id,
		folderRoot: identity.folderRoot?.replace(/^\/+|\/+$/g, "") ?? "",
		files,
		baseFiles,
		binaries,
		baseBinaries,
	};
	const result = last && sameIdentityFiles(last.result, fresh) ? last.result : fresh;
	lastIdentityFiles = {
		identityId: identity.id,
		folderRoot: identity.folderRoot,
		liveMode,
		cloudFiles,
		localFiles,
		cloudBinaries,
		localBinaries,
		pendingPatches,
		workspace,
		variantPick: state.variantPick,
		hiddenChanges: state.hiddenChanges,
		optionPick: state.optionPick,
		studioPatches: state.studioPatches,
		result,
	};
	identityFilesByState.set(state, result);
	return result;
}

export type IdentityWordmarkStatus = "loading" | "preview-loading" | "settled";

export function identityWordmarkStatus(store: SurfacesStore | undefined, disabled = false): IdentityWordmarkStatus {
	if (disabled) return "settled";
	if (!store) return "loading";
	const state = store.state;
	if (state.source === "loading") return "loading";
	if (state.source === "local" && store.fellBackAfterLoadError) return "loading";
	if (state.source !== "cloud") return "settled";
	const identity = findIdentitySurface(state);
	if (!identity) return "settled";
	if (state.cloudSurfaceFiles[identity.id] === undefined && state.localStudioBase[identity.id] === undefined) {
		return "loading";
	}
	if (state.mode !== "live" && identity.activeSessionCount > 0 && !state.workspaces[identity.id]) {
		return "preview-loading";
	}
	return "settled";
}

export function compiledCompanyIdentity(state: SurfacesState): CompiledIdentityTokens | null {
	const identity = companyIdentityFiles(state);
	if (!identity) return null;
	if (compiledIdentityByFiles.has(identity)) return compiledIdentityByFiles.get(identity) ?? null;
	const tokensJson =
		identity.files[IDENTITY_TOKENS_JSON_PATH] ??
		(identity.folderRoot ? identity.files[`${identity.folderRoot}/tokens.json`] : undefined);
	const result = tokensJson?.trim() ? compileIdentityTokens(tokensJson) : null;
	compiledIdentityByFiles.set(identity, result);
	return result;
}

export interface SurfaceReportSummary {
	readonly path: string;
	readonly slug: string;
	readonly title: string;
	readonly category: string;
	readonly readingTime: string;
	readonly ownerTitle?: string;
}

export type SurfaceDeliverableKind = "report" | "html" | "pdf";

export interface SurfaceChangeDeliverable {
	readonly kind: SurfaceDeliverableKind;
	readonly path: string;
	readonly slug: string;
	readonly title: string;
	readonly category?: string;
	readonly readingTime?: string;
}

export function surfaceDocSlug(path: string): string {
	return `doc:${path.trim().replace(/^\/+|\/+$/g, "")}`;
}

const REPORT_FILE_RE = /\.report\.json$/i;
const HTML_DELIVERABLE_RE = /\.html?$/i;
const PDF_DELIVERABLE_RE = /\.pdf$/i;
const MODULE_DELIVERABLE_RE = /(?:^|\/)modules\/[^/]+\//i;
const HTML_TITLE_ENTITIES: Readonly<Record<string, string>> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

export function isStandaloneHtmlDeliverablePath(path: string, folderRoot?: string | null): boolean {
	if (!HTML_DELIVERABLE_RE.test(path)) return false;
	const normalized = path.trim().replace(/^\/+|\/+$/g, "");
	const root = folderRoot?.trim().replace(/^\/+|\/+$/g, "") ?? "";
	const relative = root && normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
	return !MODULE_DELIVERABLE_RE.test(relative);
}

function readableDeliverableTitle(path: string): string {
	const base =
		path
			.split("/")
			.at(-1)
			?.replace(/\.report\.json$/i, "")
			.replace(/\.[a-z0-9]+$/i, "") ?? path;
	const spaced = base
		.replace(/[-_]+/g, " ")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.trim();
	if (!spaced) return path;
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function extractHtmlDeliverableTitle(html: string, fallbackPath: string): string {
	const match = html.match(/<title\b[^>]*>([\s\S]{1,200}?)<\/title>/i);
	if (!match) return readableDeliverableTitle(fallbackPath);
	const title = match[1]!
		.replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|([a-z]+));/gi, (full, hex, dec, named) => {
			if (hex) {
				const code = Number.parseInt(hex, 16);
				return Number.isFinite(code) ? String.fromCodePoint(code) : full;
			}
			if (dec) {
				const code = Number.parseInt(dec, 10);
				return Number.isFinite(code) ? String.fromCodePoint(code) : full;
			}
			return HTML_TITLE_ENTITIES[String(named).toLowerCase()] ?? full;
		})
		.trim()
		.replace(/\s+/g, " ");
	return title && title.length <= 80 ? title : readableDeliverableTitle(fallbackPath);
}

const EMPTY_REPORTS: readonly SurfaceReportSummary[] = [];
const EMPTY_DELIVERABLES: readonly SurfaceChangeDeliverable[] = [];
const singleFileReportCache = new WeakMap<Readonly<Record<string, string>>, readonly SurfaceReportSummary[]>();
const dualFileReportCache = new WeakMap<
	Readonly<Record<string, string>>,
	WeakMap<Readonly<Record<string, string>>, readonly SurfaceReportSummary[]>
>();

interface StagedReportsCacheEntry {
	readonly cloudFiles: Readonly<Record<string, string>> | undefined;
	readonly localFiles: Readonly<Record<string, string>> | undefined;
	readonly pending: readonly PendingStudioPatch[] | undefined;
	readonly studioPatches: Readonly<Record<string, readonly StudioPatchOp[]>> | undefined;
	readonly reports: readonly SurfaceReportSummary[];
}

const stagedReportsCache = new WeakMap<SurfaceWorkspace, StagedReportsCacheEntry>();

function parseSingleReportSummary(path: string, content: string): SurfaceReportSummary | undefined {
	if (!REPORT_FILE_RE.test(path) || !content) return undefined;
	try {
		const parsed: unknown = JSON.parse(content);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const rec = parsed as Record<string, unknown>;
		const slug =
			typeof rec.slug === "string" && rec.slug.trim()
				? rec.slug.trim()
				: path.replace(/^.*\//, "").replace(REPORT_FILE_RE, "");
		const title =
			(typeof rec.headline === "string" && rec.headline.trim()) ||
			(typeof rec.title === "string" && rec.title.trim()) ||
			slug;
		const category = typeof rec.category === "string" ? rec.category.trim() : "";
		const readingTime = typeof rec.readingTime === "string" ? rec.readingTime.trim() : "";
		const ownerTitle =
			typeof rec.ownerTitle === "string" && rec.ownerTitle.trim() ? rec.ownerTitle.trim() : undefined;
		return { path, slug, title, category, readingTime, ...(ownerTitle ? { ownerTitle } : {}) };
	} catch {
		return undefined;
	}
}

function parseReportsFromFiles(files: Readonly<Record<string, string>>): readonly SurfaceReportSummary[] {
	const results: SurfaceReportSummary[] = [];
	for (const path of Object.keys(files).sort()) {
		const content = files[path];
		if (!content) continue;
		const summary = parseSingleReportSummary(path, content);
		if (summary) results.push(summary);
	}
	return results.length > 0 ? results : EMPTY_REPORTS;
}

type SurfaceReportReadState = Pick<SurfacesState, "localStudioBase"> &
	Partial<
		Pick<
			SurfacesState,
			| "cloudSurfaceFiles"
			| "cloudSurfaceBinaries"
			| "localStudioBinaries"
			| "pendingStudioPatches"
			| "workspaces"
			| "studioPatches"
		>
	>;

function folderRootForState(state: SurfaceReportReadState, surfaceId: string): string | null {
	return state.workspaces?.[surfaceId]?.surface.folderRoot ?? null;
}

function composedFilesForSingleChange(
	baseFiles: Readonly<Record<string, string>>,
	changeId: string,
	ops: readonly StudioPatchOp[],
	folderRoot: string | null,
): Readonly<Record<string, string>> {
	const normalizedOps = normalizeStudioPatchOps(ops, folderRoot);
	return composeStudioPreview(baseFiles, [{ changeId, ops: normalizedOps }], folderRoot).files;
}

export function changeDeliverables(
	state: SurfaceReportReadState,
	surfaceId: string,
	change: SurfaceChangeUnit,
): readonly SurfaceChangeDeliverable[] {
	const folderRoot = folderRootForState(state, surfaceId);
	const baseFiles = effectiveStudioBaseFiles(state, surfaceId) ?? {};
	const baseBinaries = effectiveStudioBaseBinaries(state, surfaceId);
	const ops = state.studioPatches?.[change.id];
	const touched = new Map<string, "deleted" | "present">();
	let files: Readonly<Record<string, string>> = baseFiles;
	let binaries: Readonly<Record<string, StudioBinaryRef>> = baseBinaries;
	if (ops && ops.length > 0) {
		const normalizedOps = normalizeStudioPatchOps(ops, folderRoot);
		for (const op of normalizedOps) {
			touched.set(op.path, op.op === "delete" ? "deleted" : "present");
		}
		const composed = composeStudioPreview(
			baseFiles,
			[{ changeId: change.id, ops: normalizedOps }],
			folderRoot,
			baseBinaries,
		);
		files = composed.files;
		binaries = composed.binaries;
	} else {
		for (const rawPath of change.affectedPaths) {
			const path = normalizeSurfacePath(rawPath, folderRoot);
			if (path) touched.set(path, "present");
		}
	}
	const results: SurfaceChangeDeliverable[] = [];
	const seen = new Set<string>();
	for (const [path, status] of touched) {
		if (status === "deleted" || seen.has(path)) continue;
		if (REPORT_FILE_RE.test(path)) {
			const content = files[path];
			const summary = content ? parseSingleReportSummary(path, content) : undefined;
			if (!summary) continue;
			seen.add(path);
			results.push({
				kind: "report",
				path: summary.path,
				slug: summary.slug,
				title: summary.title,
				...(summary.category ? { category: summary.category } : {}),
				...(summary.readingTime ? { readingTime: summary.readingTime } : {}),
			});
			continue;
		}
		if (isStandaloneHtmlDeliverablePath(path, folderRoot)) {
			const content = files[path];
			if (content === undefined && ops && ops.length > 0) continue;
			seen.add(path);
			results.push({
				kind: "html",
				path,
				slug: surfaceDocSlug(path),
				title: content ? extractHtmlDeliverableTitle(content, path) : readableDeliverableTitle(path),
			});
			continue;
		}
		if (PDF_DELIVERABLE_RE.test(path) && binaries[path]) {
			seen.add(path);
			results.push({
				kind: "pdf",
				path,
				slug: surfaceDocSlug(path),
				title: readableDeliverableTitle(path),
			});
		}
	}
	return results.length > 0 ? results : EMPTY_DELIVERABLES;
}

function collectOpenChangeOps(
	workspace: SurfaceWorkspace | undefined,
	studioPatches: Readonly<Record<string, readonly StudioPatchOp[]>> | undefined,
): { readonly changeId: string; readonly ops: readonly StudioPatchOp[] }[] {
	if (!workspace || !studioPatches) return [];
	const entries: { readonly changeId: string; readonly ops: readonly StudioPatchOp[] }[] = [];
	for (const session of workspace.activeSessions) {
		for (const change of session.changes) {
			if (change.kind !== "folder_patch" || !isOpenChange(change)) continue;
			const ops = studioPatches[change.id];
			if (ops && ops.length > 0) entries.push({ changeId: change.id, ops });
		}
	}
	return entries;
}

export function surfaceReports(state: SurfaceReportReadState, surfaceId: string): readonly SurfaceReportSummary[] {
	const workspace = state.workspaces?.[surfaceId];
	const pending = state.pendingStudioPatches?.[surfaceId];
	const cloudFiles = state.cloudSurfaceFiles?.[surfaceId];
	const localFiles = state.localStudioBase[surfaceId];
	const openPatches = collectOpenChangeOps(workspace, state.studioPatches);
	if (workspace && openPatches.length > 0) {
		const cached = stagedReportsCache.get(workspace);
		if (
			cached &&
			cached.cloudFiles === cloudFiles &&
			cached.localFiles === localFiles &&
			cached.pending === pending &&
			cached.studioPatches === state.studioPatches
		) {
			return cached.reports;
		}
		const folderRoot = workspace.surface.folderRoot ?? null;
		const baseFiles = effectiveStudioBaseFiles(state, surfaceId) ?? {};
		const byPath = new Map<string, SurfaceReportSummary>();
		for (const summary of parseReportsFromFiles(baseFiles)) byPath.set(summary.path, summary);
		// WHY: Compose each open change independently against base so a conflict on an unrelated file cannot hide staged reports.
		for (const entry of openPatches) {
			const normalizedOps = normalizeStudioPatchOps(entry.ops, folderRoot);
			const reportOps = normalizedOps.filter((op) => REPORT_FILE_RE.test(op.path));
			if (reportOps.length === 0) continue;
			const composed = composedFilesForSingleChange(baseFiles, entry.changeId, reportOps, folderRoot);
			for (const op of reportOps) {
				if (op.op === "delete") {
					byPath.delete(op.path);
					continue;
				}
				const content = composed[op.path];
				const summary = content ? parseSingleReportSummary(op.path, content) : undefined;
				if (summary) byPath.set(summary.path, summary);
			}
		}
		const reports =
			byPath.size > 0 ? [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)) : EMPTY_REPORTS;
		stagedReportsCache.set(workspace, {
			cloudFiles,
			localFiles,
			pending,
			studioPatches: state.studioPatches,
			reports,
		});
		return reports;
	}
	if (pending && pending.length > 0) {
		const effective = effectiveStudioBaseFiles(state, surfaceId);
		return effective ? parseReportsFromFiles(effective) : EMPTY_REPORTS;
	}
	if (!cloudFiles && !localFiles) return EMPTY_REPORTS;
	if (cloudFiles && localFiles) {
		let byLocal = dualFileReportCache.get(cloudFiles);
		if (!byLocal) {
			byLocal = new WeakMap();
			dualFileReportCache.set(cloudFiles, byLocal);
		}
		const cached = byLocal.get(localFiles);
		if (cached) return cached;
		const parsed = parseReportsFromFiles({ ...cloudFiles, ...localFiles });
		byLocal.set(localFiles, parsed);
		return parsed;
	}
	const files = (cloudFiles ?? localFiles)!;
	const cached = singleFileReportCache.get(files);
	if (cached) return cached;
	const parsed = parseReportsFromFiles(files);
	singleFileReportCache.set(files, parsed);
	return parsed;
}

export function surfaceHasReports(state: SurfaceReportReadState, surfaceId: string): boolean {
	return surfaceReports(state, surfaceId).length > 0;
}

export function surfaceHasDeliverables(state: SurfaceReportReadState, surfaceId: string): boolean {
	if (surfaceReports(state, surfaceId).length > 0) return true;
	const workspace = state.workspaces?.[surfaceId];
	const folderRoot = workspace?.surface.folderRoot ?? null;
	if (workspace) {
		for (const session of workspace.activeSessions) {
			for (const change of session.changes) {
				if (change.kind !== "folder_patch" || !isOpenChange(change)) continue;
				if (changeDeliverables(state, surfaceId, change).length > 0) return true;
			}
		}
	}
	const baseFiles = effectiveStudioBaseFiles(state, surfaceId);
	if (baseFiles) {
		for (const path of Object.keys(baseFiles)) {
			if (isStandaloneHtmlDeliverablePath(path, folderRoot)) return true;
		}
	}
	const baseBinaries = effectiveStudioBaseBinaries(state, surfaceId);
	for (const path of Object.keys(baseBinaries)) {
		if (PDF_DELIVERABLE_RE.test(path)) return true;
	}
	return false;
}

interface ReportsOwnerCacheEntry {
	readonly reports: readonly SurfaceReportSummary[];
	readonly studioPatches: Readonly<Record<string, readonly StudioPatchOp[]>>;
	readonly byOwner: Map<string, readonly SurfaceReportSummary[]>;
}

const reportsOwnerCache = new WeakMap<SurfaceWorkspace, ReportsOwnerCacheEntry>();

export function reportsOwnedBy(
	state: Pick<SurfacesState, "localStudioBase" | "workspaces" | "studioPatches"> &
		Partial<Pick<SurfacesState, "cloudSurfaceFiles" | "pendingStudioPatches">>,
	surfaceId: string,
	owner: { readonly kind: "exploration"; readonly id: string } | { readonly kind: "session"; readonly id: string },
): readonly SurfaceReportSummary[] {
	const reports = surfaceReports(state, surfaceId);
	if (reports.length === 0) return EMPTY_REPORTS;
	const workspace = state.workspaces[surfaceId];
	if (!workspace) return EMPTY_REPORTS;
	const wantedKey = `${owner.kind}:${owner.id}`;
	const cached = reportsOwnerCache.get(workspace);
	if (cached && cached.reports === reports && cached.studioPatches === state.studioPatches) {
		return cached.byOwner.get(wantedKey) ?? EMPTY_REPORTS;
	}
	const folderRoot = workspace.surface.folderRoot ?? null;
	const matchesReportPath = (candidate: string, reportPath: string): boolean =>
		candidate === reportPath || normalizeSurfacePath(candidate, folderRoot) === reportPath;
	const explorations = openExplorations(workspace);
	const plainSessions = workspace.activeSessions.filter((session) => !isOpenVariant(session, workspace));
	const variantsByExploration = new Map<string, SurfaceSession[]>();
	for (const session of workspace.activeSessions) {
		if (!session.explorationId || !isOpenVariant(session, workspace)) continue;
		const list = variantsByExploration.get(session.explorationId);
		if (list) list.push(session);
		else variantsByExploration.set(session.explorationId, [session]);
	}
	const chosen = workspace.explorations.filter(
		(exp) => exp.status === "chosen" && plainSessions.some((sess) => sess.id === exp.chosenSessionId),
	);
	const ownerKeyFor = (report: SurfaceReportSummary): string | undefined => {
		for (const exp of explorations) {
			if (exp.notePaths?.some((p) => matchesReportPath(p, report.path))) return `exploration:${exp.id}`;
		}
		for (const exp of chosen) {
			if (exp.notePaths?.some((p) => matchesReportPath(p, report.path))) return `session:${exp.chosenSessionId}`;
		}
		for (const sess of plainSessions) {
			if (sess.notePaths?.some((p) => matchesReportPath(p, report.path))) return `session:${sess.id}`;
		}
		if (report.ownerTitle) {
			const wanted = report.ownerTitle.toLowerCase();
			const exp = explorations.find((item) => item.title.toLowerCase() === wanted);
			if (exp) return `exploration:${exp.id}`;
			const kept = chosen.find((item) => item.title.toLowerCase() === wanted);
			if (kept) return `session:${kept.chosenSessionId}`;
			const sess = plainSessions.find((item) => item.title.toLowerCase() === wanted);
			if (sess) return `session:${sess.id}`;
		}
		for (const sess of plainSessions) {
			const touches = sess.changes.some(
				(change) =>
					change.affectedPaths.some((p) => matchesReportPath(p, report.path)) ||
					(state.studioPatches[change.id] ?? []).some((op) => matchesReportPath(op.path, report.path)),
			);
			if (touches) return `session:${sess.id}`;
		}
		for (const exp of explorations) {
			const variants = variantsByExploration.get(exp.id) ?? [];
			const touches = variants.some((variant) =>
				variant.changes.some(
					(change) =>
						change.affectedPaths.some((p) => matchesReportPath(p, report.path)) ||
						(state.studioPatches[change.id] ?? []).some((op) => matchesReportPath(op.path, report.path)),
				),
			);
			if (touches) return `exploration:${exp.id}`;
		}
		if (plainSessions[0]) return `session:${plainSessions[0].id}`;
		if (explorations[0]) return `exploration:${explorations[0].id}`;
		return undefined;
	};
	const byOwner = new Map<string, SurfaceReportSummary[]>();
	for (const report of reports) {
		const key = ownerKeyFor(report);
		if (!key) continue;
		const list = byOwner.get(key);
		if (list) list.push(report);
		else byOwner.set(key, [report]);
	}
	reportsOwnerCache.set(workspace, { reports, studioPatches: state.studioPatches, byOwner });
	return byOwner.get(wantedKey) ?? EMPTY_REPORTS;
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

export interface QuietCall {
	readonly quiet?: boolean;
}

export interface SurfacesStoreOptions {
	readonly companyId: string;
	readonly companyName?: string;
	readonly localInteractive?: boolean;
	readonly sandboxMode?: boolean;
	readonly client: SurfacesClient | undefined;
	readonly synthesize: () => SurfaceSynthesisInput;
	readonly migration: () => SurfaceMigrationInput;
	readonly signal: AbortSignal;
	readonly unavailableMessage: string;
	readonly onNavigateSurface?: (slug: string) => void;
	readonly realtimeLive?: () => boolean;
	readonly memberName?: (userId: string) => string | undefined;
	readonly teammates?: () => readonly SurfaceTeammate[];
	readonly peopleAtSurface?: (slug: string) => readonly { readonly userId: string; readonly name: string }[];
	readonly userId?: string;
	readonly publishers?: () => readonly { readonly userId: string; readonly name: string }[];
	readonly loadCloudFiles?: (
		surface: SurfaceSummary,
		signal: AbortSignal,
	) => Promise<SurfaceFolderContents | undefined>;
	readonly readCloudBinary?: (file: StudioBinaryRef, signal: AbortSignal) => Promise<Uint8Array>;
	readonly uploadImage?: (
		surfaceId: string,
		clientInputId: string,
		file: File,
		signal: AbortSignal,
	) => Promise<SurfaceImageRef>;
	readonly readImage?: (
		sessionId: string,
		clientInputId: string,
		image: SurfaceImageRef,
		signal: AbortSignal,
	) => Promise<Blob>;
	readonly renameLegacyRoutine?: (
		routineId: string,
		clientRoutineId: string,
		title: string,
		signal: AbortSignal,
	) => Promise<void>;
	readonly deleteLegacyRoutine?: (routineId: string, clientRoutineId: string, signal: AbortSignal) => Promise<void>;
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
	readonly localStudioBinaries: Readonly<Record<string, Readonly<Record<string, StudioBinaryRef>>>>;
	readonly surfaceLooks: Readonly<Record<string, SurfaceLook>>;
	readonly studioPatches: Readonly<Record<string, readonly StudioPatchOp[]>>;
	readonly hiddenChanges: Readonly<Record<string, boolean>>;
	readonly optionPick: Readonly<Record<string, string | null>>;
	readonly publishedChangeIds: Readonly<Record<string, true>>;
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
	readonly #cloudFilesLoading = new Set<string>();
	readonly #cloudFilesDirty = new Set<string>();
	readonly #cloudFilesDirtyVisible = new Set<string>();
	readonly #cloudFilesRev = new Map<string, number>();
	readonly #deliverableHosts = new Map<string, (path: string) => boolean>();
	readonly #mintingPreviewPasses = new Map<string, Promise<boolean>>();
	readonly #previewPassMeta = new Map<
		string,
		{ readonly pass: string; readonly mintedAt: number; consumed: boolean; retryMint?: boolean }
	>();
	readonly #workspaceEpoch = new Map<string, number>();
	readonly #latestWorkspaceReq = new Map<string, number>();
	readonly #inFlightWorkspaceRefreshes = new Set<string>();
	readonly #hydratedAttempted = new Set<string>();
	readonly #previewSyncInFlight = new Set<string>();
	readonly #previewSyncDirty = new Set<string>();
	readonly #previewSyncForeground = new Set<string>();
	readonly #previewSyncGen = new Map<string, number>();
	readonly #previewSyncWaiters = new Map<string, (() => void)[]>();
	readonly #previewSyncDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	readonly #previewSyncDebounceWaiters = new Map<string, (() => void)[]>();
	readonly #lastPreviewSyncKey = new Map<string, string>();
	readonly #previewSyncSettledBaselineKey = new Map<string, string>();
	readonly #previewSyncRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	readonly #previewSyncRetryCounts = new Map<string, { readonly key: string; readonly count: number }>();
	readonly #previewIdSelectionKey = new Map<string, string>();
	readonly #pendingMerges = new Map<
		string,
		{
			readonly surfaceId: string;
			readonly label: string;
			readonly changeIds: readonly string[];
			readonly verb: SurfaceUndoVerb;
			readonly undoId: number;
		}
	>();
	readonly #pendingPublishChanges = new Map<string, readonly string[]>();
	#activeSurfaceId: string | undefined;
	#workspaceReqSeq = 0;
	#surfacesReqSeq = 0;
	#surfacesMutationEpoch = 0;
	#undoTimer: ReturnType<typeof setTimeout> | undefined;
	#pollTimer: ReturnType<typeof setInterval> | undefined;
	#pollIntervalMs = 0;
	#hintTimer: ReturnType<typeof setTimeout> | undefined;
	#folderHintTimer: ReturnType<typeof setTimeout> | undefined;
	#retryLoadTimer: ReturnType<typeof setTimeout> | undefined;
	#suspended = false;
	#visitAbort = new AbortController();
	#pendingHintFiles = false;
	#undoSeq = 0;
	#noteSeq = 0;
	#localSeq = 0;
	readonly #imageReads = new Map<string, string>();
	readonly #binaryReads = new Map<string, { readonly read: Promise<Uint8Array>; readonly bytes: number }>();
	readonly #reconciliationRequested = new Set<string>();
	#loaded: Promise<void> | undefined;
	#fallbackAfterLoadError = false;

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
			cloudSurfaceFiles: {},
			localStudioBinaries: {},
			cloudSurfaceBinaries: {},
			pendingStudioPatches: {},
			loadingCloudFiles: {},
			updatingCloudFiles: {},
			surfaceLooks: {},
			mode: "preview",
			previewPanel: "auto",
			compareExcludedSessions: {},
			device: "desktop",
			websiteZoom: DEFAULT_SURFACE_ZOOM,
			phoneZoom: DEFAULT_SURFACE_ZOOM,
			hiddenChanges: {},
			optionPick: {},
			publishedChangeIds: {},
			studioPatches: {},
			variantPick: {},
			collapsed: {},
			notes: [],
			sessionImages: {},
			unseenNotes: {},
			reconciliationRequests: {},
			previewSyncing: {},
			busy: {},
		});
		if (options.signal.aborted) this.#visitAbort.abort();
		options.signal.addEventListener("abort", () => this.dispose(), { once: true });
		if (typeof document !== "undefined") {
			document.addEventListener(
				"visibilitychange",
				() => {
					if (this.#options.signal.aborted || this.#suspended) return;
					this.#syncPolling();
					if (
						document.visibilityState !== "hidden" &&
						this.state.source === "cloud" &&
						this.#options.client &&
						this.#options.realtimeLive?.() !== true
					) {
						this.#pollDueWorkspaces();
					}
				},
				{ signal: options.signal },
			);
		}
		if (options.localInteractive) {
			this.store.subscribe(() => {
				if (this.isLocalInteractive) this.#persistLocalSandbox();
			});
		}
	}

	#persistLocalSandbox(): void {
		const state = this.state;
		localSandboxCache.delete(this.#options.companyId);
		localSandboxCache.set(this.#options.companyId, {
			surfaces: state.surfaces,
			workspaces: state.workspaces,
			automations: state.automations,
			scheduledAgentPrompts: state.scheduledAgentPrompts,
			migration: state.migration,
			migrationDismissed: state.migrationDismissed,
			foldedAgentIds: state.foldedAgentIds,
			localStudioBase: state.localStudioBase,
			localStudioBinaries: state.localStudioBinaries,
			surfaceLooks: state.surfaceLooks,
			studioPatches: state.studioPatches,
			hiddenChanges: state.hiddenChanges,
			optionPick: state.optionPick,
			publishedChangeIds: state.publishedChangeIds,
			localCreatedIds: [...this.#localCreatedIds],
			localSeq: this.#localSeq,
		});
		while (localSandboxCache.size > MAX_LOCAL_SANDBOX_CACHE) {
			const oldest = localSandboxCache.keys().next().value;
			if (oldest === undefined) break;
			localSandboxCache.delete(oldest);
		}
	}

	get state(): SurfacesState {
		return this.store.get();
	}

	get isLocalInteractive(): boolean {
		return this.state.source === "local" && this.#options.localInteractive === true;
	}

	get fellBackAfterLoadError(): boolean {
		return this.#fallbackAfterLoadError;
	}

	get companyId(): string {
		return this.#options.companyId;
	}

	get companyName(): string {
		return this.#options.companyName?.trim() || "";
	}

	memberName(userId: string | null | undefined): string | undefined {
		if (!userId) return undefined;
		return this.#options.memberName?.(userId);
	}

	teammates(): readonly SurfaceTeammate[] {
		return this.#options.teammates?.() ?? [];
	}

	turnHolder(session: SurfaceSession): SurfaceTeammate | undefined {
		if (!this.teammates().length || !(isRunningSession(session) || session.state === "needs_input")) return undefined;
		const userId = session.turnRequestedByUserId;
		const name = this.memberName(userId);
		return userId && name ? { userId, name } : undefined;
	}

	unseenNotesOn(surfaceId: string): number {
		let count = 0;
		for (const item of Object.values(this.state.unseenNotes)) if (item.surfaceId === surfaceId) count += item.count;
		return count;
	}

	seeNotes(sessionId: string): void {
		if (!this.state.unseenNotes[sessionId]) return;
		this.store.set((state) => {
			const { [sessionId]: _seen, ...rest } = state.unseenNotes;
			return { unseenNotes: rest };
		});
		void this.#options.client?.markSurfaceNotesSeen?.(sessionId).catch(() => undefined);
	}

	peopleAtSurface(slug: string): readonly { readonly userId: string; readonly name: string }[] {
		return this.#options.peopleAtSurface?.(slug) ?? [];
	}

	get userId(): string | undefined {
		return this.#options.userId;
	}

	publishTeammates(): readonly { readonly userId: string; readonly name: string }[] {
		return (this.#options.publishers?.() ?? []).filter((person) => person.userId !== this.#options.userId);
	}

	lookOf(surface: Pick<SurfaceSummary, "id" | "slug" | "icon" | "archetype" | "kind" | "accentHex">): SurfaceLook {
		return surfaceLookOf(surface, this.state.surfaceLooks);
	}

	companyIdentityTokens(): CompiledIdentityTokens | null {
		return compiledCompanyIdentity(this.state);
	}

	companyIdentityFiles(): CompanyIdentityFiles | null {
		return companyIdentityFiles(this.state);
	}

	get canLoadCloudFiles(): boolean {
		return Boolean(this.#options.loadCloudFiles);
	}

	get canRenameLegacyRoutine(): boolean {
		return Boolean(this.#options.renameLegacyRoutine);
	}

	get canDeleteLegacyRoutine(): boolean {
		return Boolean(this.#options.deleteLegacyRoutine);
	}

	readStudioBinary(file: StudioBinaryRef, signal: AbortSignal): Promise<Uint8Array> {
		signal.throwIfAborted();
		const read = localSandbox?.localStudioBinaryBytes(file) ?? this.#binaryRead(file);
		if (!read) return Promise.reject(new Error("No folder to read from"));
		return new Promise<Uint8Array>((resolve, reject) => {
			const stop = () => reject(signal.reason);
			signal.addEventListener("abort", stop, { once: true });
			read.then(
				(bytes) => {
					signal.removeEventListener("abort", stop);
					resolve(bytes);
				},
				(error: unknown) => {
					signal.removeEventListener("abort", stop);
					reject(error);
				},
			);
		});
	}

	#binaryRead(file: StudioBinaryRef): Promise<Uint8Array> | undefined {
		const key = file.fileSha256;
		const kept = this.#binaryReads.get(key);
		if (kept) {
			this.#binaryReads.delete(key);
			this.#binaryReads.set(key, kept);
			return kept.read;
		}
		const readCloudBinary = this.#options.readCloudBinary;
		if (!readCloudBinary) return undefined;
		const read = readCloudBinary(file, this.#options.signal);
		if (file.bytes > MAX_CACHED_BINARY_BYTES / 2) return read;
		const entry = { read, bytes: file.bytes };
		this.#binaryReads.set(key, entry);
		read.catch(() => {
			if (this.#binaryReads.get(key) === entry) this.#binaryReads.delete(key);
		});
		let held = 0;
		for (const item of this.#binaryReads.values()) held += item.bytes;
		for (const [oldest, item] of this.#binaryReads) {
			if (held <= MAX_CACHED_BINARY_BYTES || oldest === key) break;
			this.#binaryReads.delete(oldest);
			held -= item.bytes;
		}
		return read;
	}

	isCloudFilesLoading(surfaceId: string): boolean {
		return Boolean(this.state.loadingCloudFiles[surfaceId]);
	}

	surfaceUpdatePhase(surfaceId: string): SurfaceUpdatePhase | null {
		const state = this.state;
		const surface = state.surfaces.find((item) => item.id === surfaceId);
		if (state.busy[`publish:${surfaceId}`] || surface?.publishStatus === "publishing") return "publishing";
		const workspace = state.workspaces[surfaceId];
		if (workspace) {
			for (const session of workspace.activeSessions) {
				if (state.busy[`session:${session.id}`]) return "merging";
				for (const change of session.changes) {
					if (
						change.status === "merging" ||
						state.busy[`change:${change.id}`] ||
						state.busy[`undo:${change.id}`]
					) {
						return "merging";
					}
				}
			}
			for (const session of workspace.recentHistory) {
				for (const change of session.changes) {
					if (state.busy[`undo:${change.id}`]) return "merging";
				}
			}
			for (const exploration of workspace.explorations) {
				if (state.busy[`exploration:${exploration.id}`]) return "merging";
			}
			if (
				workspace.previewState.primary.status === "reconciling" ||
				(workspace.reconciliations ?? []).some((rec) => rec.status === "queued" || rec.status === "running")
			) {
				return "updating";
			}
		}
		if (state.updatingCloudFiles[surfaceId]) return "updating";
		return null;
	}

	isSurfaceUpdating(surfaceId: string): boolean {
		return this.surfaceUpdatePhase(surfaceId) !== null;
	}

	get suspended(): boolean {
		return this.#suspended;
	}

	// WHY: Parked company controllers hibernate surface timers without discarding warm workspace state.
	suspend(): void {
		if (this.#options.signal.aborted || this.#suspended) return;
		this.#suspended = true;
		this.#visitAbort.abort();
		this.#activeSurfaceId = undefined;
		if (this.#pollTimer) clearInterval(this.#pollTimer);
		if (this.#hintTimer) clearTimeout(this.#hintTimer);
		if (this.#folderHintTimer) clearTimeout(this.#folderHintTimer);
		if (this.#retryLoadTimer) clearTimeout(this.#retryLoadTimer);
		this.#pollTimer = undefined;
		this.#pollIntervalMs = 0;
		this.#hintTimer = undefined;
		this.#folderHintTimer = undefined;
		this.#retryLoadTimer = undefined;
		for (const timer of this.#previewSyncRetryTimers.values()) clearTimeout(timer);
		this.#previewSyncRetryTimers.clear();
		for (const timer of this.#previewSyncDebounceTimers.values()) clearTimeout(timer);
		this.#previewSyncDebounceTimers.clear();
		for (const waiters of this.#previewSyncDebounceWaiters.values()) {
			for (const resolve of waiters) resolve();
		}
		this.#previewSyncDebounceWaiters.clear();
	}

	resume(): void {
		if (this.#options.signal.aborted || !this.#suspended) return;
		this.#suspended = false;
		this.#visitAbort = new AbortController();
		if ((this.state.source === "loading" && !this.#loaded) || this.#fallbackAfterLoadError) {
			this.#loaded = undefined;
			void this.load();
			return;
		}
		this.#syncPolling();
		if (this.state.source === "cloud") {
			const retryHydrate = [...this.#hydratedAttempted].filter(
				(id) =>
					!this.state.workspaces[id] &&
					this.state.surfaces.some(
						(surface) => surface.id === id && surface.status === "active" && surface.activeSessionCount > 0,
					),
			);
			this.#hydratedAttempted.clear();
			for (const id of retryHydrate) this.hydrateWorkspace(id);
			void this.refreshSurfaces();
			const dirty = [...this.#cloudFilesDirty].map((id) => ({
				id,
				visible: this.#cloudFilesDirtyVisible.has(id),
			}));
			this.#cloudFilesDirty.clear();
			this.#cloudFilesDirtyVisible.clear();
			const missingDirty: string[] = [];
			for (const entry of dirty) {
				const surface =
					this.state.surfaces.find((item) => item.id === entry.id) ?? this.state.workspaces[entry.id]?.surface;
				if (surface && !isLocalSurfaceId(surface.id)) {
					void this.refreshCloudFiles(surface, { visible: entry.visible });
				} else {
					missingDirty.push(entry.id);
				}
			}
			if (missingDirty.length > 0) {
				this.store.set((state) => {
					let nextLoading: Record<string, true> | undefined;
					let nextUpdating: Record<string, true> | undefined;
					for (const id of missingDirty) {
						if (state.loadingCloudFiles[id]) {
							nextLoading ??= { ...state.loadingCloudFiles };
							delete nextLoading[id];
						}
						if (state.updatingCloudFiles[id]) {
							nextUpdating ??= { ...state.updatingCloudFiles };
							delete nextUpdating[id];
						}
					}
					if (!nextLoading && !nextUpdating) return {};
					return {
						...(nextLoading ? { loadingCloudFiles: nextLoading } : {}),
						...(nextUpdating ? { updatingCloudFiles: nextUpdating } : {}),
					};
				});
			}
			this.refreshPendingCloudFiles();
			for (const workspace of Object.values(this.state.workspaces)) {
				if (isLocalSurfaceId(workspace.surface.id)) continue;
				const hasCrew = workspace.activeSessions.length > 0 || openExplorations(workspace).length > 0;
				if (hasCrew || this.#workspaceNeedsPoll(workspace)) {
					void this.refreshWorkspace(workspace.surface.id, 0, { background: true });
				}
			}
			const client = this.#options.client;
			if (client) {
				void this.#loadAutomations(client);
				void this.#loadUnseenNotes(client);
			}
		}
	}

	dispose(): void {
		this.#visitAbort.abort();
		if (this.#undoTimer) clearTimeout(this.#undoTimer);
		if (this.#pollTimer) clearInterval(this.#pollTimer);
		if (this.#hintTimer) clearTimeout(this.#hintTimer);
		if (this.#folderHintTimer) clearTimeout(this.#folderHintTimer);
		if (this.#retryLoadTimer) clearTimeout(this.#retryLoadTimer);
		for (const timer of this.#localTimers) clearTimeout(timer);
		this.#localTimers.clear();
		this.#studioUndoSnapshots.clear();
		this.#binaryReads.clear();
		this.#hydratedAttempted.clear();
		this.#previewPassMeta.clear();
		this.#previewSyncDirty.clear();
		this.#previewSyncForeground.clear();
		this.#lastPreviewSyncKey.clear();
		this.#previewSyncSettledBaselineKey.clear();
		for (const timer of this.#previewSyncRetryTimers.values()) clearTimeout(timer);
		this.#previewSyncRetryTimers.clear();
		this.#previewSyncRetryCounts.clear();
		this.#previewIdSelectionKey.clear();
		this.#pendingMerges.clear();
		this.#pendingPublishChanges.clear();
		this.#reconciliationRequested.clear();
		for (const timer of this.#previewSyncDebounceTimers.values()) clearTimeout(timer);
		this.#previewSyncDebounceTimers.clear();
		for (const waiters of this.#previewSyncDebounceWaiters.values()) {
			for (const resolve of waiters) resolve();
		}
		this.#previewSyncDebounceWaiters.clear();
		for (const waiters of this.#previewSyncWaiters.values()) {
			for (const resolve of waiters) resolve();
		}
		this.#previewSyncWaiters.clear();
		this.#undoTimer = undefined;
		this.#pollTimer = undefined;
		this.#pollIntervalMs = 0;
		this.#hintTimer = undefined;
		this.#folderHintTimer = undefined;
		this.#retryLoadTimer = undefined;
		lastIdentityFiles = undefined;
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
		return {
			...workspace.surface,
			activeSessionCount: activeSessions.length,
			runningSessionCount: running,
			pendingChangeCount: pending,
			needsAttentionCount: 0,
		};
	}

	load(): Promise<void> {
		if (this.#options.signal.aborted || this.#suspended || this.#visitAbort.signal.aborted) {
			return Promise.resolve();
		}
		this.#loaded ??= this.#load();
		return this.#loaded;
	}

	async #load(): Promise<void> {
		const client = this.#options.client;
		if (!client || this.#options.sandboxMode === true) {
			this.#useLocal();
			return;
		}
		const signal = this.#visitAbort.signal;
		if (this.#options.signal.aborted || this.#suspended || signal.aborted) {
			if (this.state.source === "loading") this.#loaded = undefined;
			return;
		}
		if (client.isSurfacesEnabled) {
			try {
				const enabled = await client.isSurfacesEnabled(signal);
				if (this.#options.signal.aborted) return;
				if (signal.aborted) {
					if (this.state.source === "loading") this.#loaded = undefined;
					return;
				}
				if (!enabled) {
					this.#fallbackAfterLoadError = false;
					this.store.set({ source: "disabled", surfaces: [], automations: [], error: undefined });
					return;
				}
			} catch (error) {
				if (this.#options.signal.aborted) return;
				if (signal.aborted) {
					if (this.state.source === "loading") this.#loaded = undefined;
					return;
				}
				if (isMissingSurfaceRpcError(error) || isSurfacesDisabledError(error)) {
					this.#fallbackAfterLoadError = false;
					this.store.set({ source: "disabled", surfaces: [], automations: [], error: undefined });
					return;
				}
				// WHY: Keep loading on transient network errors so Surfaces do not stay hidden or redirect home for the rest of the session.
				this.#loaded = undefined;
				this.store.set({ source: "loading", error: describe(error) });
				if (!this.#retryLoadTimer && !this.#suspended) {
					this.#retryLoadTimer = setTimeout(() => {
						this.#retryLoadTimer = undefined;
						if (!this.#options.signal.aborted && !this.#suspended && this.state.source === "loading") {
							void this.load();
						}
					}, POLL_MS);
				}
				return;
			}
		}
		try {
			let surfaces = await client.listSurfaces(this.#options.companyId, signal);
			if (this.#options.signal.aborted) return;
			if (signal.aborted) {
				if (this.state.source === "loading") this.#loaded = undefined;
				return;
			}
			if (surfaces.length === 0 && client.bootstrapCompanySurfaces) {
				try {
					surfaces = await client.bootstrapCompanySurfaces(this.#options.companyId, signal);
					if (this.#options.signal.aborted) return;
					if (signal.aborted) {
						if (this.state.source === "loading") this.#loaded = undefined;
						return;
					}
				} catch (bootstrapError) {
					if (this.#options.signal.aborted || signal.aborted) {
						if (this.state.source === "loading") this.#loaded = undefined;
						return;
					}
					if (!isMissingSurfaceRpcError(bootstrapError)) {
						/* WHY: Viewers without write rights cannot bootstrap rows; fall through cleanly. */
					}
				}
			}
			if (surfaces.length === 0) this.#useLocal();
			else {
				this.#fallbackAfterLoadError = false;
				this.store.set({ source: "cloud", surfaces: sortSurfaces(surfaces) });
			}
		} catch (error) {
			if (this.#options.signal.aborted) return;
			if (signal.aborted) {
				if (this.state.source === "loading") this.#loaded = undefined;
				return;
			}
			if (isSurfacesDisabledError(error)) {
				this.#fallbackAfterLoadError = false;
				this.store.set({ source: "disabled", surfaces: [], automations: [], error: undefined });
				return;
			}
			this.#useLocal(isMissingSurfaceRpcError(error) ? undefined : describe(error));
			return;
		}
		await Promise.all([this.#loadAutomations(client), this.#loadMigration(client), this.#loadUnseenNotes(client)]);
	}

	#useLocal(error?: string): void {
		this.#fallbackAfterLoadError = Boolean(error);
		const cached = this.#options.localInteractive ? localSandboxCache.get(this.#options.companyId) : undefined;
		if (cached) {
			localSandboxCache.delete(this.#options.companyId);
			localSandboxCache.set(this.#options.companyId, cached);
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
				localStudioBinaries: cached.localStudioBinaries,
				surfaceLooks: cached.surfaceLooks,
				studioPatches: cached.studioPatches,
				hiddenChanges: cached.hiddenChanges,
				optionPick: cached.optionPick ?? {},
				publishedChangeIds: cached.publishedChangeIds ?? {},
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
		if (
			this.#options.localInteractive &&
			this.#options.sandboxMode !== false &&
			isThetabandCompany(this.companyName)
		) {
			if (localSandbox) {
				this.orchestrateStarterSurfaces();
			} else {
				void loadLocalSandbox().then(() => {
					if (!this.#options.signal.aborted) this.orchestrateStarterSurfaces();
				});
			}
		}
	}

	orchestrateStarterSurfaces(): readonly SurfaceSummary[] {
		if (!this.isLocalInteractive) return [];
		const sandbox = localSandbox;
		if (!sandbox) {
			void loadLocalSandbox().then(() => {
				if (!this.#options.signal.aborted) this.orchestrateStarterSurfaces();
			});
			return [];
		}
		const plan = sandbox.starterOrchestrationPlan(this.companyName);
		const now = new Date().toISOString();
		const createdSurfaces: SurfaceSummary[] = [];
		const taken = new Set(this.state.surfaces.map((surface) => surface.slug));
		const nextSurfaces = [...this.state.surfaces];
		const nextWorkspaces: Record<string, SurfaceWorkspace> = { ...this.state.workspaces };
		const nextLooks: Record<string, SurfaceLook> = { ...this.state.surfaceLooks };
		const nextStudioBase: Record<string, Readonly<Record<string, string>>> = { ...this.state.localStudioBase };
		const nextStudioBinaries: Record<string, Readonly<Record<string, StudioBinaryRef>>> = {
			...this.state.localStudioBinaries,
		};
		const nextStudioPatches: Record<string, readonly StudioPatchOp[]> = { ...this.state.studioPatches };

		for (const [index, spec] of plan.surfaces.entries()) {
			if (taken.has(spec.slug)) continue;
			taken.add(spec.slug);
			const surface = localSurface(spec.slug, spec.name, "products", spec.archetype, spec.icon, index, {
				kind: spec.kind,
				...(spec.kind === "identity" ? { isGlobal: true } : {}),
				sourceKind: spec.archetype === "studio" ? "folder" : "code_repo",
				folderRoot: spec.folderRoot ?? null,
				previewMode: spec.archetype === "studio" ? "studio_overlay" : "static_site",
				liveUrl: spec.liveUrl ?? null,
			});
			this.#localCreatedIds.add(surface.id);
			const look: SurfaceLook = { kind: spec.kind };
			nextLooks[surface.id] = look;
			if (spec.archetype === "studio") {
				nextStudioBase[surface.id] = {
					...sandbox.starterStudioFiles(surface, this.companyName, spec.kind, spec.brief),
					...(spec.attachedReports ?? {}),
				};
				const binaries = sandbox.starterStudioBinaries(surface, this.companyName, spec.kind);
				if (Object.keys(binaries).length > 0) nextStudioBinaries[surface.id] = binaries;
			} else if (spec.attachedReports && Object.keys(spec.attachedReports).length > 0) {
				nextStudioBase[surface.id] = { ...spec.attachedReports };
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
			nextAutomations.push({ ...rest, ...LOCAL_AUTOMATION_OWNER, id, title: heading });
			nextPrompts[id] = auto.scheduleSummary;
		}

		this.store.set({
			surfaces: sortSurfaces(nextSurfaces),
			workspaces: nextWorkspaces,
			surfaceLooks: nextLooks,
			localStudioBase: nextStudioBase,
			localStudioBinaries: nextStudioBinaries,
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
		if (this.state.source === "cloud" && this.#options.client?.createAutomation) {
			const created = await this.#run("automation:create", (client) =>
				client.createAutomation!(this.#options.companyId, {
					title,
					prompt,
					scheduleSummary: schedule,
					targetSurfaceSlug: input.targetSurfaceSlug || null,
				}),
			);
			if (!created) return undefined;
			this.store.set((state) => ({
				automations: [created, ...state.automations.filter((item) => item.id !== created.id)],
				scheduledAgentPrompts: { ...state.scheduledAgentPrompts, [created.id]: created.prompt ?? prompt },
				error: undefined,
			}));
			return created;
		}
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
			prompt,
			scheduleSummary: schedule,
			targetSurfaceSlug: input.targetSurfaceSlug || null,
			outputMode: input.targetSurfaceSlug ? "surface_session" : "decision_card",
			enabled: true,
			status: "idle",
			lastRunAt: null,
			lastOutcomeSummary: prompt.length <= 68 ? prompt : `${prompt.slice(0, 65).trimEnd()}…`,
			nextRunAt: null,
			...LOCAL_AUTOMATION_OWNER,
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
		if (this.state.source === "cloud" && !id.startsWith("local-")) {
			if (!existing.ownable) {
				const nextTitle = patch.title?.trim();
				const initialPrompt =
					this.state.scheduledAgentPrompts[id] ?? existing.lastOutcomeSummary ?? existing.scheduleSummary;
				const promptChanged = patch.prompt !== undefined && patch.prompt.trim() !== initialPrompt.trim();
				const scheduleChanged =
					patch.scheduleSummary !== undefined && patch.scheduleSummary.trim() !== existing.scheduleSummary.trim();
				const targetChanged =
					patch.targetSurfaceSlug !== undefined &&
					(patch.targetSurfaceSlug || null) !== (existing.targetSurfaceSlug || null);
				if (!nextTitle || promptChanged || scheduleChanged || targetChanged || !this.#options.renameLegacyRoutine) {
					this.store.set({ error: this.#options.unavailableMessage });
					return undefined;
				}
				const renameLegacyRoutine = this.#options.renameLegacyRoutine;
				const ok = await this.#run(`automation:${id}`, async () => {
					await renameLegacyRoutine(id, existing.key, nextTitle, this.#visitAbort.signal);
					return true;
				});
				if (!ok) return undefined;
				const updated: SurfaceAutomationSummary = { ...existing, title: nextTitle };
				this.store.set((state) => ({
					automations: state.automations.map((item) => (item.id === id ? updated : item)),
					error: undefined,
				}));
				return updated;
			}
			if (this.#options.client?.updateAutomation) {
				const updated = await this.#run(`automation:${id}`, (client) =>
					client.updateAutomation!(id, {
						...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
						...(patch.prompt !== undefined ? { prompt: patch.prompt.trim() } : {}),
						...(patch.scheduleSummary !== undefined ? { scheduleSummary: patch.scheduleSummary.trim() } : {}),
						...(patch.targetSurfaceSlug !== undefined ? { targetSurfaceSlug: patch.targetSurfaceSlug } : {}),
					}),
				);
				if (!updated) return undefined;
				this.store.set((state) => ({
					automations: state.automations.map((item) => (item.id === id ? updated : item)),
					scheduledAgentPrompts: {
						...state.scheduledAgentPrompts,
						[id]: updated.prompt ?? patch.prompt?.trim() ?? state.scheduledAgentPrompts[id] ?? "",
					},
					error: undefined,
				}));
				return updated;
			}
		}
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
			prompt,
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
		const existing = this.state.automations.find((item) => item.id === id);
		if (this.state.source === "cloud" && !id.startsWith("local-")) {
			if (existing && !existing.ownable) {
				const deleteLegacyRoutine = this.#options.deleteLegacyRoutine;
				if (!deleteLegacyRoutine) {
					this.store.set({ error: this.#options.unavailableMessage });
					return false;
				}
				const ok = await this.#run(`automation:delete:${id}`, async () => {
					await deleteLegacyRoutine(id, existing.key, this.#visitAbort.signal);
					return true;
				});
				if (!ok) return false;
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
			if (this.#options.client?.deleteAutomation) {
				const ok = await this.#run(`automation:delete:${id}`, (client) => client.deleteAutomation!(id));
				if (!ok) return false;
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
		}
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

	async #loadUnseenNotes(client: SurfacesClient): Promise<void> {
		if (!client.unseenSurfaceNotes || this.#suspended) return;
		const signal = this.#visitAbort.signal;
		try {
			const unseen = await client.unseenSurfaceNotes(this.#options.companyId, signal);
			if (this.#options.signal.aborted || signal.aborted) return;
			const next = Object.fromEntries(unseen.map((item) => [item.sessionId, item]));
			if (JSON.stringify(next) !== JSON.stringify(this.state.unseenNotes)) this.store.set({ unseenNotes: next });
		} catch {
			/* WHY: Unseen notes are a mark on the rail; the last good list stays on screen. */
		}
	}

	async #loadAutomations(client: SurfacesClient): Promise<void> {
		if (this.#suspended) return;
		const signal = this.#visitAbort.signal;
		try {
			const automations = await client.listAutomations(this.#options.companyId, signal);
			if (!this.#options.signal.aborted && !signal.aborted) {
				const prompts: Record<string, string> = {};
				for (const item of automations) {
					if (item.prompt) prompts[item.id] = item.prompt;
				}
				this.store.set((state) => {
					const mergedPrompts = { ...state.scheduledAgentPrompts, ...prompts };
					const promptsUnchanged = sameFileMap(state.scheduledAgentPrompts, mergedPrompts);
					const automationsUnchanged =
						state.automations.length === automations.length &&
						JSON.stringify(state.automations) === JSON.stringify(automations);
					if (automationsUnchanged && promptsUnchanged) return {};
					return {
						...(automationsUnchanged ? {} : { automations }),
						...(promptsUnchanged ? {} : { scheduledAgentPrompts: mergedPrompts }),
					};
				});
			}
		} catch {
			/* WHY: Automations are a quiet extra; a failed read must not block the surfaces themselves. */
		}
	}

	async #loadMigration(client: SurfacesClient): Promise<void> {
		if (this.#suspended) return;
		const signal = this.#visitAbort.signal;
		try {
			const migration = await client.getMigrationChecklist(this.#options.companyId, signal);
			if (!this.#options.signal.aborted && !signal.aborted) this.store.set({ migration });
		} catch {
			if (!this.#options.signal.aborted && !signal.aborted)
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

	isWorkspaceLoading(surfaceId: string): boolean {
		return this.#inFlightWorkspaceRefreshes.has(surfaceId);
	}

	isPreviewSyncing(surfaceId: string): boolean {
		return Boolean(this.state.previewSyncing[surfaceId]);
	}

	readonly #requestedStudioTabs = new Map<string, string>();

	requestStudioTab(slug: string, tab: string): void {
		this.#requestedStudioTabs.set(slug.toLowerCase(), tab.toLowerCase());
	}

	consumeRequestedStudioTab(slug: string): string | undefined {
		const key = slug.toLowerCase();
		const tab = this.#requestedStudioTabs.get(key);
		if (tab !== undefined) this.#requestedStudioTabs.delete(key);
		return tab;
	}

	setActiveSurface(surfaceId: string | undefined): void {
		const changed = this.#activeSurfaceId !== surfaceId;
		this.#activeSurfaceId = surfaceId;
		if (
			changed &&
			surfaceId &&
			this.state.workspaces[surfaceId] &&
			!this.#inFlightWorkspaceRefreshes.has(surfaceId)
		) {
			this.#maybeAutoSyncPreview(surfaceId);
		}
	}

	clearActiveSurface(surfaceId: string): void {
		if (this.#activeSurfaceId === surfaceId) {
			this.#activeSurfaceId = undefined;
			this.#clearPreviewSyncRetry(surfaceId, false);
		}
		if (this.state.opsPanelSurfaceId === surfaceId) this.store.set({ opsPanelSurfaceId: undefined });
	}

	isActiveSurface(surfaceId: string): boolean {
		return this.#activeSurfaceId === surfaceId;
	}

	async openSurface(slug: string): Promise<SurfaceWorkspace | undefined> {
		await this.load();
		const surface = surfaceBySlug(this.state, slug);
		if (!surface) return undefined;
		this.#activeSurfaceId = surface.id;
		this.#hydratedAttempted.delete(surface.id);
		this.#previewSyncSettledBaselineKey.delete(surface.id);
		this.#clearPreviewSyncRetry(surface.id);
		if (isLocalSurfaceId(surface.id) || !this.#options.client) {
			const existing = this.workspace(surface.id) ?? localWorkspace(surface);
			this.#putWorkspace({ ...existing, surface });
			return this.workspace(surface.id);
		}
		const workspace = await this.refreshWorkspace(surface.id);
		if (!workspace && this.state.workspaces[surface.id]) {
			this.#maybeAutoSyncPreview(surface.id);
		}
		return workspace;
	}

	hydrateWorkspace(surfaceId: string): void {
		if (
			this.state.source !== "cloud" ||
			isLocalSurfaceId(surfaceId) ||
			!this.#options.client ||
			this.state.workspaces[surfaceId] ||
			this.#inFlightWorkspaceRefreshes.has(surfaceId) ||
			this.#hydratedAttempted.has(surfaceId)
		) {
			return;
		}
		this.#hydratedAttempted.add(surfaceId);
		void this.refreshWorkspace(surfaceId, 0, { background: true });
	}

	async refreshWorkspace(
		surfaceId: string,
		retryDepth = 0,
		options?: { readonly background?: boolean },
	): Promise<SurfaceWorkspace | undefined> {
		const client = this.#options.client;
		if (!client || isLocalSurfaceId(surfaceId) || this.#suspended) return this.workspace(surfaceId);
		const reqId = ++this.#workspaceReqSeq;
		const startEpoch = this.#workspaceEpoch.get(surfaceId) ?? 0;
		const signal = this.#visitAbort.signal;
		this.#latestWorkspaceReq.set(surfaceId, reqId);
		this.#inFlightWorkspaceRefreshes.add(surfaceId);
		let rerun = false;
		let result: SurfaceWorkspace | undefined;
		try {
			const workspace = await client.getSurfaceWorkspace(surfaceId, signal);
			if (this.#options.signal.aborted || signal.aborted) return undefined;
			if (this.#latestWorkspaceReq.get(surfaceId) !== reqId) {
				return this.workspace(surfaceId);
			}
			if ((this.#workspaceEpoch.get(surfaceId) ?? 0) !== startEpoch) {
				rerun = retryDepth < 2;
				result = this.workspace(surfaceId);
			} else {
				this.#putWorkspace(workspace, false, options);
				result = workspace;
			}
		} catch (error) {
			if (signal.aborted && !this.#options.signal.aborted) {
				if (!this.state.workspaces[surfaceId]) this.#hydratedAttempted.delete(surfaceId);
			} else if (
				!options?.background &&
				!this.#options.signal.aborted &&
				this.#latestWorkspaceReq.get(surfaceId) === reqId
			) {
				this.store.set({ error: describe(error) });
			}
			result = undefined;
		} finally {
			if (this.#latestWorkspaceReq.get(surfaceId) === reqId) {
				this.#inFlightWorkspaceRefreshes.delete(surfaceId);
			}
		}
		if (
			rerun &&
			!this.#options.signal.aborted &&
			!signal.aborted &&
			!this.#suspended &&
			this.#latestWorkspaceReq.get(surfaceId) === reqId
		) {
			return this.refreshWorkspace(surfaceId, retryDepth + 1, options);
		}
		return result;
	}

	isPreviewPassUsable(previewId: string, pass: string): boolean {
		const meta = this.#previewPassMeta.get(previewId);
		if (!meta || meta.pass !== pass) return true;
		return !meta.consumed && Date.now() - meta.mintedAt < PREVIEW_PASS_TTL_MS;
	}

	markPreviewPassConsumed(previewId: string, pass: string): void {
		const existing = this.#previewPassMeta.get(previewId);
		if (existing && existing.pass === pass) {
			existing.consumed = true;
			return;
		}
		this.#previewPassMeta.set(previewId, { pass, mintedAt: Date.now(), consumed: true });
	}

	remintPreviewPass(surfaceId: string, previewId: string, stalePass?: string): Promise<boolean> {
		if (stalePass) this.markPreviewPassConsumed(previewId, stalePass);
		return this.#ensurePreviewPass(surfaceId, previewId);
	}

	#putWorkspace(
		workspace: SurfaceWorkspace,
		bumpEpoch = true,
		options?: { readonly background?: boolean; readonly fromPreviewSync?: boolean },
	): void {
		const surfaceId = workspace.surface.id;
		const background =
			options?.background === true &&
			surfaceId !== this.#activeSurfaceId &&
			surfaceId !== this.state.drawer?.surfaceId;
		const prevWorkspace = this.state.workspaces[surfaceId];
		const prevSurface = prevWorkspace?.surface ?? this.state.surfaces.find((surface) => surface.id === surfaceId);
		const recPrefix = `${surfaceId}:`;
		const recRevision = workspace.surface.folderRevision ?? 0;
		const recHead = workspace.surface.liveHeadSha ?? "";
		const presentRecKeys = new Set<string>();
		for (const rec of workspace.reconciliations ?? []) {
			const ids = [...new Set(rec.selectedChangeIds.filter(Boolean))].sort();
			if (ids.length) presentRecKeys.add(`${surfaceId}:${recRevision}:${recHead}:${ids.join(",")}`);
		}
		for (const key of [...this.#reconciliationRequested]) {
			if (!key.startsWith(recPrefix)) continue;
			if (this.state.reconciliationRequests[key] !== undefined) continue;
			if (!presentRecKeys.has(key)) this.#reconciliationRequested.delete(key);
		}
		if (bumpEpoch) {
			this.#workspaceEpoch.set(surfaceId, (this.#workspaceEpoch.get(surfaceId) ?? 0) + 1);
		}
		const now = Date.now();
		const trackIncomingPass = (frame: SurfaceWorkspace["previewState"]["primary"]): void => {
			if (!frame.previewId || !frame.memberPass) return;
			const existing = this.#previewPassMeta.get(frame.previewId);
			if (!existing || existing.pass !== frame.memberPass) {
				this.#previewPassMeta.set(frame.previewId, { pass: frame.memberPass, mintedAt: now, consumed: false });
			}
		};
		trackIncomingPass(workspace.previewState.primary);
		for (const entry of workspace.previewState.compareFrames) trackIncomingPass(entry.frame);
		const sessions = [...workspace.activeSessions, ...workspace.recentHistory];
		const extractedPatches: Record<string, readonly StudioPatchOp[]> = {};
		for (const session of sessions) {
			for (const change of session.changes) {
				if (change.patchManifest && change.patchManifest.length > 0) {
					extractedPatches[change.id] = normalizeStudioPatchOps(
						change.patchManifest,
						workspace.surface.folderRoot,
					);
				}
			}
		}

		const canSyncCloudFiles =
			this.state.source === "cloud" &&
			!isLocalSurfaceId(surfaceId) &&
			Boolean(this.#options.loadCloudFiles) &&
			(!background || Boolean(this.state.cloudSurfaceFiles[surfaceId]) || this.#cloudFilesLoading.has(surfaceId));
		const isFolderSurface = workspace.surface.sourceKind === "folder" || workspace.surface.archetype === "studio";
		const newlyLandedPatches: StudioPatchChange[] = [];
		const unmergedChangeIds = new Set<string>();
		let needsVisibleFileReload = false;

		if (canSyncCloudFiles && prevWorkspace) {
			const prevStatusByChange = new Map<string, SurfaceChangeUnit["status"]>();
			for (const session of [...prevWorkspace.activeSessions, ...prevWorkspace.recentHistory]) {
				for (const change of session.changes) prevStatusByChange.set(change.id, change.status);
			}
			for (const session of sessions) {
				for (const change of session.changes) {
					if (change.kind !== "folder_patch") continue;
					const prevStatus = prevStatusByChange.get(change.id);
					if (change.status === "merged" && prevStatus !== undefined && prevStatus !== "merged") {
						needsVisibleFileReload = true;
						const ops =
							extractedPatches[change.id] ?? this.state.studioPatches[change.id] ?? change.patchManifest;
						if (ops?.length) {
							newlyLandedPatches.push({
								changeId: change.id,
								ops: normalizeStudioPatchOps(ops, workspace.surface.folderRoot),
							});
						}
					} else if (prevStatus === "merged" && change.status !== "merged") {
						needsVisibleFileReload = true;
						unmergedChangeIds.add(change.id);
					}
				}
			}
			if (
				isFolderSurface &&
				prevSurface &&
				(workspace.surface.publishStatus !== prevSurface.publishStatus ||
					workspace.surface.unpublishedChangeCount !== prevSurface.unpublishedChangeCount)
			) {
				needsVisibleFileReload = true;
			}
		}

		const nextRev = needsVisibleFileReload ? (this.#cloudFilesRev.get(surfaceId) ?? 0) + 1 : 0;
		if (needsVisibleFileReload) {
			this.#cloudFilesRev.set(surfaceId, nextRev);
		}

		this.store.set((state) => {
			const prevState = state.workspaces[surfaceId]?.previewState;
			const prevPasses = new Map<string, { readonly doorActionUrl: string | null; readonly memberPass: string }>();
			if (prevState?.primary.previewId && prevState.primary.memberPass) {
				prevPasses.set(prevState.primary.previewId, {
					doorActionUrl: prevState.primary.doorActionUrl,
					memberPass: prevState.primary.memberPass,
				});
			}
			if (prevState?.primary.kept?.memberPass) {
				prevPasses.set(prevState.primary.kept.previewId, {
					doorActionUrl: prevState.primary.kept.doorActionUrl,
					memberPass: prevState.primary.kept.memberPass,
				});
			}
			for (const entry of prevState?.compareFrames ?? []) {
				if (entry.frame.previewId && entry.frame.memberPass) {
					prevPasses.set(entry.frame.previewId, {
						doorActionUrl: entry.frame.doorActionUrl,
						memberPass: entry.frame.memberPass,
					});
				}
			}
			const usablePrevPass = (
				previewId: string,
			): { readonly doorActionUrl: string | null; readonly memberPass: string } | null => {
				const prev = prevPasses.get(previewId);
				if (!prev) return null;
				const meta = this.#previewPassMeta.get(previewId);
				return meta &&
					meta.pass === prev.memberPass &&
					(meta.consumed || now - meta.mintedAt >= PREVIEW_PASS_TTL_MS)
					? null
					: prev;
			};
			const keepPass = <T extends SurfaceWorkspace["previewState"]["primary"]>(frame: T): T => {
				if (frame.kept && !frame.kept.memberPass) {
					const prev = usablePrevPass(frame.kept.previewId);
					return prev
						? {
								...frame,
								kept: {
									...frame.kept,
									doorActionUrl: frame.kept.doorActionUrl ?? prev.doorActionUrl,
									memberPass: prev.memberPass,
								},
							}
						: frame;
				}
				if (frame.status !== "ready" || !frame.previewId || frame.memberPass) return frame;
				const prev = usablePrevPass(frame.previewId);
				if (!prev) return frame;
				return {
					...frame,
					doorActionUrl: frame.doorActionUrl ?? prev.doorActionUrl,
					memberPass: prev.memberPass,
				};
			};
			const nextPrimary = keepPass(workspace.previewState.primary);
			const nextCompare = workspace.previewState.compareFrames.map((entry) => ({
				...entry,
				frame: keepPass(entry.frame),
			}));
			const mergedWorkspace: SurfaceWorkspace = {
				...workspace,
				previewState: {
					...workspace.previewState,
					primary: nextPrimary,
					compareFrames: nextCompare,
				},
			};
			const notes = reconcileNotes(state.notes, sessions);
			const nextPatches =
				Object.keys(extractedPatches).length > 0
					? { ...state.studioPatches, ...extractedPatches }
					: state.studioPatches;
			let nextPendingStudioPatches = state.pendingStudioPatches;
			if (newlyLandedPatches.length > 0 || unmergedChangeIds.size > 0) {
				const existingPending = (state.pendingStudioPatches[surfaceId] ?? []).filter(
					(item) =>
						!unmergedChangeIds.has(item.changeId) &&
						!newlyLandedPatches.some((added) => added.changeId === item.changeId),
				);
				const updatedPending: PendingStudioPatch[] = [
					...existingPending,
					...newlyLandedPatches.map((item) => ({ changeId: item.changeId, ops: item.ops, rev: nextRev })),
				];
				const copy = { ...state.pendingStudioPatches };
				if (updatedPending.length > 0) copy[surfaceId] = updatedPending;
				else delete copy[surfaceId];
				nextPendingStudioPatches = copy;
			}
			const existingWorkspace = state.workspaces[surfaceId];
			const workspaceUnchanged =
				existingWorkspace !== undefined && JSON.stringify(existingWorkspace) === JSON.stringify(mergedWorkspace);
			const existingSurface = state.surfaces.find((surface) => surface.id === surfaceId);
			const surfaceUnchanged =
				existingSurface !== undefined && JSON.stringify(existingSurface) === JSON.stringify(workspace.surface);
			const patchesChanged =
				nextPatches !== state.studioPatches && JSON.stringify(nextPatches) !== JSON.stringify(state.studioPatches);
			const clearOpsPanel = state.opsPanelSurfaceId === surfaceId && !workspaceHasOpenWork(mergedWorkspace);
			if (
				workspaceUnchanged &&
				surfaceUnchanged &&
				!patchesChanged &&
				nextPendingStudioPatches === state.pendingStudioPatches &&
				notes.length === state.notes.length &&
				!clearOpsPanel
			) {
				return {};
			}
			return {
				...(workspaceUnchanged ? {} : { workspaces: { ...state.workspaces, [surfaceId]: mergedWorkspace } }),
				...(surfaceUnchanged
					? {}
					: {
							surfaces: state.surfaces.map((surface) =>
								surface.id === surfaceId ? workspace.surface : surface,
							),
						}),
				...(patchesChanged ? { studioPatches: nextPatches } : {}),
				...(nextPendingStudioPatches !== state.pendingStudioPatches
					? { pendingStudioPatches: nextPendingStudioPatches }
					: {}),
				...(notes.length !== state.notes.length ? { notes } : {}),
				...(clearOpsPanel ? { opsPanelSurfaceId: undefined } : {}),
			};
		});
		const stored = this.state.workspaces[surfaceId];
		if (stored) {
			this.#reconcilePendingPublish(stored.surface);
			this.#reconcilePendingMerges(stored);
		}
		if (!background && stored && !isLocalSurfaceId(surfaceId) && this.#options.client?.mintPreviewPass) {
			const frames = [stored.previewState.primary, ...stored.previewState.compareFrames.map((entry) => entry.frame)];
			for (const frame of frames) {
				if (frame.status === "ready" && frame.previewId && !frame.memberPass) {
					const meta = this.#previewPassMeta.get(frame.previewId);
					if (!meta || !meta.consumed || meta.retryMint) {
						void this.#ensurePreviewPass(surfaceId, frame.previewId);
					}
				}
			}
		}
		if (canSyncCloudFiles) {
			if (needsVisibleFileReload) {
				void this.refreshCloudFiles(workspace.surface, { visible: true });
			} else if (!background && !this.state.cloudSurfaceFiles[surfaceId]) {
				void this.refreshCloudFiles(workspace.surface);
			}
		}
		if (!background) {
			this.#maybeAutoSyncPreview(workspace.surface.id, { fromPreviewSync: options?.fromPreviewSync });
		}
		this.#syncPolling();
	}

	#maybeAutoSyncPreview(surfaceId: string, options?: { readonly fromPreviewSync?: boolean }): void {
		const stored = this.state.workspaces[surfaceId];
		if (
			!stored ||
			this.state.source !== "cloud" ||
			isLocalSurfaceId(surfaceId) ||
			!this.#options.client ||
			stored.surface.archetype !== "live_build" ||
			stored.surface.sourceKind !== "code_repo"
		) {
			return;
		}
		const info = this.#previewSelectionInfo(surfaceId);
		if (this.state.mode === "compare" && (info.selection.compareSessionIds?.length ?? 0) >= 2) {
			return;
		}
		const primary = stored.previewState.primary;
		if (info.hasOpenChanges) {
			const primaryIds = [...new Set(primary.toggledChangeIds)].sort().join(",");
			const stalePreviewId = Boolean(
				primary.previewId &&
					this.#previewIdSelectionKey.has(primary.previewId) &&
					this.#previewIdSelectionKey.get(primary.previewId) !== info.selectionKey,
			);
			const matchesPrimary =
				primary.status !== "live_baseline" &&
				primary.status !== "failed" &&
				!stalePreviewId &&
				primaryIds === info.toggledKey;
			if (matchesPrimary) {
				this.#lastPreviewSyncKey.set(surfaceId, info.selectionKey);
				if (primary.previewId && !this.#previewIdSelectionKey.has(primary.previewId)) {
					this.#previewIdSelectionKey.set(primary.previewId, info.selectionKey);
				}
				this.#previewSyncSettledBaselineKey.delete(surfaceId);
				this.#clearPreviewSyncRetry(surfaceId);
				return;
			}
			if (options?.fromPreviewSync) {
				if (primary.status === "live_baseline") {
					this.#previewSyncSettledBaselineKey.set(surfaceId, info.selectionKey);
				}
				return;
			}
			if (this.#previewSyncInFlight.has(surfaceId) || this.#previewSyncDebounceTimers.has(surfaceId)) {
				return;
			}
			if (primary.status === "failed" && !stalePreviewId && primaryIds === info.toggledKey) {
				if (this.#lastPreviewSyncKey.get(surfaceId) === info.selectionKey) return;
				this.#lastPreviewSyncKey.set(surfaceId, info.selectionKey);
				void this.#syncPreview(surfaceId, { background: true });
				return;
			}
			if (
				primary.status === "live_baseline" &&
				this.#previewSyncSettledBaselineKey.get(surfaceId) === info.selectionKey
			) {
				return;
			}
			this.#lastPreviewSyncKey.set(surfaceId, info.selectionKey);
			void this.#syncPreview(surfaceId, { background: true });
		} else {
			this.#previewSyncSettledBaselineKey.delete(surfaceId);
			this.#clearPreviewSyncRetry(surfaceId);
			if (primary.status !== "live_baseline") {
				if (
					options?.fromPreviewSync ||
					this.#previewSyncInFlight.has(surfaceId) ||
					this.#previewSyncDebounceTimers.has(surfaceId)
				) {
					return;
				}
				const emptyKey = `empty|${info.selectionKey}`;
				if (this.#lastPreviewSyncKey.get(surfaceId) !== emptyKey) {
					this.#lastPreviewSyncKey.set(surfaceId, emptyKey);
					void this.#syncPreview(surfaceId, { background: true });
				}
			} else {
				this.#lastPreviewSyncKey.delete(surfaceId);
			}
		}
	}

	#ensurePreviewPass(surfaceId: string, previewId: string): Promise<boolean> {
		const mint = this.#options.client?.mintPreviewPass;
		if (!mint || isLocalSurfaceId(surfaceId)) return Promise.resolve(false);
		const inFlight = this.#mintingPreviewPasses.get(previewId);
		if (inFlight) return inFlight;
		const promise = (async (): Promise<boolean> => {
			try {
				const grant = await mint.call(this.#options.client, previewId);
				if (this.#options.signal.aborted) return false;
				this.#previewPassMeta.set(grant.previewId, {
					pass: grant.memberPass,
					mintedAt: Date.now(),
					consumed: false,
				});
				let applied = false;
				this.store.set((state) => {
					const workspace = state.workspaces[surfaceId];
					if (!workspace) return {};
					let changed = false;
					const patchFrame = <T extends SurfaceWorkspace["previewState"]["primary"]>(frame: T): T => {
						if (frame.kept?.previewId === grant.previewId) {
							changed = true;
							return {
								...frame,
								kept: { ...frame.kept, doorActionUrl: grant.doorActionUrl, memberPass: grant.memberPass },
							};
						}
						if (frame.previewId !== grant.previewId) return frame;
						changed = true;
						return {
							...frame,
							doorActionUrl: grant.doorActionUrl,
							memberPass: grant.memberPass,
						};
					};
					const primary = patchFrame(workspace.previewState.primary);
					const compareFrames = workspace.previewState.compareFrames.map((entry) => ({
						...entry,
						frame: patchFrame(entry.frame),
					}));
					if (!changed) return {};
					applied = true;
					return {
						workspaces: {
							...state.workspaces,
							[surfaceId]: {
								...workspace,
								previewState: {
									...workspace.previewState,
									primary,
									compareFrames,
								},
							},
						},
					};
				});
				return applied;
			} catch {
				/* WHY: A transient preview pass mint failure fails the waiting stage and retries on the next workspace refresh. */
				const meta = this.#previewPassMeta.get(previewId);
				if (meta) meta.retryMint = true;
				return false;
			} finally {
				this.#mintingPreviewPasses.delete(previewId);
			}
		})();
		this.#mintingPreviewPasses.set(previewId, promise);
		return promise;
	}

	async refreshCloudFiles(surface: SurfaceSummary, options?: { readonly visible?: boolean }): Promise<void> {
		const loadFiles = this.#options.loadCloudFiles;
		if (!loadFiles || this.#suspended || isLocalSurfaceId(surface.id)) return;
		const visible = options?.visible === true;
		if (this.#cloudFilesLoading.has(surface.id)) {
			this.#cloudFilesDirty.add(surface.id);
			if (visible) {
				this.#cloudFilesDirtyVisible.add(surface.id);
				if (!this.state.updatingCloudFiles[surface.id]) {
					this.store.set((state) => ({
						updatingCloudFiles: { ...state.updatingCloudFiles, [surface.id]: true },
					}));
				}
			}
			return;
		}
		this.#cloudFilesLoading.add(surface.id);
		const fetchStartRev = this.#cloudFilesRev.get(surface.id) ?? 0;
		const hadCachedFiles = this.state.cloudSurfaceFiles[surface.id] !== undefined;
		if (!hadCachedFiles || visible) {
			this.store.set((state) => ({
				...(!hadCachedFiles && !state.loadingCloudFiles[surface.id]
					? { loadingCloudFiles: { ...state.loadingCloudFiles, [surface.id]: true } }
					: {}),
				...(visible && !state.updatingCloudFiles[surface.id]
					? { updatingCloudFiles: { ...state.updatingCloudFiles, [surface.id]: true } }
					: {}),
			}));
		}
		let shouldRerun = false;
		let rerunVisible = false;
		const signal = this.#visitAbort.signal;
		try {
			const contents = await loadFiles(surface, signal);
			if (!this.#options.signal.aborted && contents !== undefined) {
				const { files, binaries } = contents;
				this.store.set((state) => {
					const existingPending = state.pendingStudioPatches[surface.id];
					let nextPendingStudioPatches = state.pendingStudioPatches;
					if (existingPending && existingPending.length > 0) {
						const remaining = existingPending.filter((item) => item.rev > fetchStartRev);
						if (remaining.length !== existingPending.length) {
							const copy = { ...state.pendingStudioPatches };
							if (remaining.length > 0) copy[surface.id] = remaining;
							else delete copy[surface.id];
							nextPendingStudioPatches = copy;
						}
					}
					const filesUnchanged = sameFileMap(state.cloudSurfaceFiles[surface.id], files);
					const hadBinaries = state.cloudSurfaceBinaries[surface.id];
					const binariesUnchanged =
						sameBinaryMap(hadBinaries, binaries) || (!hadBinaries && Object.keys(binaries).length === 0);
					if (filesUnchanged && binariesUnchanged && nextPendingStudioPatches === state.pendingStudioPatches)
						return {};
					const keepIds = new Set<string>();
					if (this.#activeSurfaceId) keepIds.add(this.#activeSurfaceId);
					if (state.drawer?.surfaceId) keepIds.add(state.drawer.surfaceId);
					const identity = findIdentitySurface(state);
					if (identity) keepIds.add(identity.id);
					return {
						...(filesUnchanged
							? {}
							: {
									cloudSurfaceFiles: pruneCloudSurfaceFiles(
										state.cloudSurfaceFiles,
										surface.id,
										files,
										keepIds,
									),
								}),
						...(binariesUnchanged
							? {}
							: {
									cloudSurfaceBinaries: pruneCloudSurfaceFiles(
										state.cloudSurfaceBinaries,
										surface.id,
										binaries,
										keepIds,
									),
								}),
						...(nextPendingStudioPatches !== state.pendingStudioPatches
							? { pendingStudioPatches: nextPendingStudioPatches }
							: {}),
					};
				});
			}
		} catch {
			if (signal.aborted && !this.#options.signal.aborted) {
				this.#cloudFilesDirty.add(surface.id);
				if (visible) this.#cloudFilesDirtyVisible.add(surface.id);
			} else if (!this.#options.signal.aborted) {
				this.store.set((state) => {
					const existingPending = state.pendingStudioPatches[surface.id];
					if (!existingPending?.length) return {};
					const remaining = existingPending.filter((item) => item.rev > fetchStartRev);
					if (remaining.length === existingPending.length) return {};
					const copy = { ...state.pendingStudioPatches };
					if (remaining.length > 0) copy[surface.id] = remaining;
					else delete copy[surface.id];
					return { pendingStudioPatches: copy };
				});
			}
		} finally {
			this.#cloudFilesLoading.delete(surface.id);
			if (!this.#options.signal.aborted && this.#cloudFilesDirty.has(surface.id)) {
				if (this.#suspended) {
					if (visible) this.#cloudFilesDirtyVisible.add(surface.id);
				} else {
					this.#cloudFilesDirty.delete(surface.id);
					shouldRerun = true;
					rerunVisible = this.#cloudFilesDirtyVisible.delete(surface.id) || visible;
				}
			} else {
				this.#cloudFilesDirtyVisible.delete(surface.id);
				if (!this.#options.signal.aborted) {
					this.store.set((state) => {
						const nextLoading = state.loadingCloudFiles[surface.id] ? { ...state.loadingCloudFiles } : undefined;
						if (nextLoading) delete nextLoading[surface.id];
						const nextUpdating = state.updatingCloudFiles[surface.id]
							? { ...state.updatingCloudFiles }
							: undefined;
						if (nextUpdating) delete nextUpdating[surface.id];
						if (!nextLoading && !nextUpdating) return {};
						return {
							...(nextLoading ? { loadingCloudFiles: nextLoading } : {}),
							...(nextUpdating ? { updatingCloudFiles: nextUpdating } : {}),
						};
					});
				}
			}
		}
		if (shouldRerun && !this.#options.signal.aborted && !this.#suspended) {
			const latestSurface = this.state.surfaces.find((item) => item.id === surface.id) ?? surface;
			await this.refreshCloudFiles(latestSurface, { visible: rerunVisible });
		}
	}

	onFolderHint(): void {
		if (this.#options.signal.aborted || this.#suspended || !this.#options.loadCloudFiles) return;
		if (this.#folderHintTimer) return;
		this.#folderHintTimer = setTimeout(() => {
			this.#folderHintTimer = undefined;
			if (this.#options.signal.aborted || this.#suspended || this.state.source !== "cloud") return;
			const workspaces = Object.values(this.state.workspaces).filter(
				(workspace) => !isLocalSurfaceId(workspace.surface.id),
			);
			const refreshed = new Set<string>();
			for (const workspace of workspaces) {
				const relevant =
					workspace.surface.id === this.#activeSurfaceId ||
					workspace.surface.id === this.state.drawer?.surfaceId ||
					this.#workspaceNeedsPoll(workspace) ||
					(!this.#activeSurfaceId && workspaces.length <= 1);
				if (!relevant) continue;
				refreshed.add(workspace.surface.id);
				void this.refreshCloudFiles(workspace.surface);
			}
			const identity = findIdentitySurface(this.state);
			if (identity && !refreshed.has(identity.id) && !isLocalSurfaceId(identity.id)) {
				void this.refreshCloudFiles(identity);
			}
		}, FOLDER_HINT_DEBOUNCE_MS);
	}

	refreshPendingCloudFiles(): void {
		if (this.state.source !== "cloud" || this.#suspended || !this.#options.loadCloudFiles) return;
		const seen = new Set<string>();
		for (const workspace of Object.values(this.state.workspaces)) {
			seen.add(workspace.surface.id);
			if (!isLocalSurfaceId(workspace.surface.id) && !this.state.cloudSurfaceFiles[workspace.surface.id]) {
				void this.refreshCloudFiles(workspace.surface);
			}
		}
		const identity = findIdentitySurface(this.state);
		if (identity && !isLocalSurfaceId(identity.id)) {
			if (!seen.has(identity.id) && !this.state.cloudSurfaceFiles[identity.id]) {
				void this.refreshCloudFiles(identity);
			}
			if (identity.activeSessionCount > 0 && !this.state.workspaces[identity.id]) {
				this.hydrateWorkspace(identity.id);
			}
		}
	}

	refreshIdentityFiles(): void {
		if (this.state.source !== "cloud" || !this.#options.loadCloudFiles) return;
		const identity = findIdentitySurface(this.state);
		if (identity && !isLocalSurfaceId(identity.id)) void this.refreshCloudFiles(identity);
	}

	onRealtimeHint(resource: "surfaces" | "company-file"): void {
		if (this.#options.signal.aborted || this.#suspended) return;
		if (resource === "company-file") this.#pendingHintFiles = true;
		if (this.#hintTimer) return;
		this.#hintTimer = setTimeout(() => {
			this.#hintTimer = undefined;
			if (this.#options.signal.aborted || this.#suspended) return;
			const reloadFiles = this.#pendingHintFiles;
			this.#pendingHintFiles = false;
			if (this.state.source === "loading" && !this.#loaded) {
				void this.load();
				return;
			}
			if (this.state.source === "cloud") {
				const retryHydrate = [...this.#hydratedAttempted].filter(
					(id) =>
						!this.state.workspaces[id] &&
						this.state.surfaces.some(
							(surface) => surface.id === id && surface.status === "active" && surface.activeSessionCount > 0,
						),
				);
				this.#hydratedAttempted.clear();
				for (const id of retryHydrate) this.hydrateWorkspace(id);
				void this.refreshSurfaces();
				const client = this.#options.client;
				if (client) {
					void this.#loadAutomations(client);
					void this.#loadUnseenNotes(client);
				}
				const workspaces = Object.values(this.state.workspaces).filter(
					(workspace) => !isLocalSurfaceId(workspace.surface.id),
				);
				const refreshed = new Set<string>();
				for (const workspace of workspaces) {
					const foreground =
						workspace.surface.id === this.#activeSurfaceId ||
						workspace.surface.id === this.state.drawer?.surfaceId;
					const activePoll =
						foreground ||
						this.#workspaceNeedsPoll(workspace) ||
						(!this.#activeSurfaceId && workspaces.length <= 1);
					const hasCrew = workspace.activeSessions.length > 0 || openExplorations(workspace).length > 0;
					if (!activePoll && !hasCrew) continue;
					refreshed.add(workspace.surface.id);
					void this.refreshWorkspace(workspace.surface.id, 0, { background: !foreground });
					if (reloadFiles && activePoll) void this.refreshCloudFiles(workspace.surface);
				}
				if (reloadFiles) {
					const identity = findIdentitySurface(this.state);
					if (identity && !refreshed.has(identity.id) && !isLocalSurfaceId(identity.id)) {
						void this.refreshCloudFiles(identity);
					}
				}
			}
		}, HINT_DEBOUNCE_MS);
	}

	#workspaceNeedsPoll(workspace: SurfaceWorkspace): boolean {
		return (
			workspace.surface.publishStatus === "publishing" ||
			workspace.previewState.primary.status === "composing" ||
			workspace.previewState.primary.status === "reconciling" ||
			workspace.previewState.primary.status === "building" ||
			workspace.previewState.compareFrames.some(
				(entry) =>
					entry.frame.status === "composing" ||
					entry.frame.status === "reconciling" ||
					entry.frame.status === "building",
			) ||
			(workspace.reconciliations ?? []).some((rec) => rec.status === "queued" || rec.status === "running") ||
			workspace.activeSessions.some(
				(session) => isRunningSession(session) || session.changes.some((change) => change.status === "merging"),
			)
		);
	}

	#pollDueWorkspaces(): void {
		for (const workspace of Object.values(this.state.workspaces)) {
			if (
				!isLocalSurfaceId(workspace.surface.id) &&
				this.#workspaceNeedsPoll(workspace) &&
				!this.#inFlightWorkspaceRefreshes.has(workspace.surface.id)
			) {
				const foreground =
					workspace.surface.id === this.#activeSurfaceId || workspace.surface.id === this.state.drawer?.surfaceId;
				void this.refreshWorkspace(workspace.surface.id, 0, { background: !foreground });
			}
		}
	}

	#syncPolling(): void {
		if (this.#suspended) {
			if (this.#pollTimer) {
				clearInterval(this.#pollTimer);
				this.#pollTimer = undefined;
				this.#pollIntervalMs = 0;
			}
			return;
		}
		const workspaces = Object.values(this.state.workspaces);
		const fast = workspaces.some(
			(workspace) =>
				workspace.surface.publishStatus === "publishing" ||
				workspace.previewState.primary.status === "composing" ||
				workspace.previewState.primary.status === "reconciling" ||
				workspace.previewState.primary.status === "building" ||
				workspace.previewState.compareFrames.some(
					(entry) =>
						entry.frame.status === "composing" ||
						entry.frame.status === "reconciling" ||
						entry.frame.status === "building",
				) ||
				(workspace.reconciliations ?? []).some((rec) => rec.status === "queued" || rec.status === "running") ||
				workspace.activeSessions.some((session) => session.changes.some((change) => change.status === "merging")),
		);
		const running = fast || workspaces.some((workspace) => this.#workspaceNeedsPoll(workspace));
		const realtimeConnected = this.#options.realtimeLive?.() === true;
		const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
		const targetIntervalMs = fast ? FAST_POLL_MS : POLL_MS;
		if (running && !realtimeConnected && !hidden && this.#options.client && this.state.source === "cloud") {
			if (this.#pollTimer && this.#pollIntervalMs === targetIntervalMs) return;
			if (this.#pollTimer) clearInterval(this.#pollTimer);
			this.#pollIntervalMs = targetIntervalMs;
			this.#pollTimer = setInterval(() => {
				if (
					this.#options.signal.aborted ||
					this.#options.realtimeLive?.() === true ||
					(typeof document !== "undefined" && document.visibilityState === "hidden")
				) {
					this.#syncPolling();
					return;
				}
				this.#pollDueWorkspaces();
			}, targetIntervalMs);
		} else if ((!running || realtimeConnected || hidden) && this.#pollTimer) {
			clearInterval(this.#pollTimer);
			this.#pollTimer = undefined;
			this.#pollIntervalMs = 0;
		}
	}

	canStartSessions(surface: SurfaceSummary): boolean {
		if (this.state.source === "cloud" && !isLocalSurfaceId(surface.id) && Boolean(this.#options.client)) return true;
		return this.isLocalInteractive;
	}

	async createSurface(input: CreateSurfaceInput): Promise<SurfaceSummary | undefined> {
		const title = input.title.trim();
		if (!title) return undefined;
		const icon = input.icon ?? (input.archetype === "studio" ? "spark" : "globe");
		const description = input.description?.trim() || null;
		const taken = new Set(this.state.surfaces.map((surface) => surface.slug));
		const explicitSlug = input.slug?.trim();
		const slug = slugifySurfaceTitle(explicitSlug || title, taken);
		const explicitFolderRoot = input.folderRoot?.trim().replace(/^\/+|\/+$/g, "");
		const folderRoot =
			input.archetype === "studio"
				? explicitFolderRoot || (input.kind === "identity" ? "identity" : `surfaces/${slug}`)
				: null;
		if (this.state.source === "cloud" && this.#options.client?.createSurface) {
			const cloudSlug = input.archetype === "studio" ? slug : explicitSlug || undefined;
			const created = await this.#run("surface:create", (client) =>
				client.createSurface!(this.#options.companyId, {
					title,
					...(cloudSlug ? { slug: cloudSlug } : {}),
					archetype: input.archetype,
					...(input.kind ? { kind: input.kind } : {}),
					icon,
					folderRoot,
					briefSummary: description,
					isGlobal: input.kind === "identity",
				}),
			);
			if (!created) return undefined;
			this.#surfacesMutationEpoch += 1;
			const look: SurfaceLook = { kind: input.kind ?? surfaceLookOf(created).kind };
			this.store.set((state) => ({
				surfaces: sortSurfaces([...state.surfaces.filter((item) => item.id !== created.id), created]),
				workspaces: {
					...state.workspaces,
					[created.id]: { ...localWorkspace(created), briefSummary: description },
				},
				surfaceLooks: { ...state.surfaceLooks, [created.id]: look },
				...(look.kind === "mobile_app" ? { device: "mobile" as const } : {}),
				error: undefined,
			}));
			this.#options.onNavigateSurface?.(created.slug);
			const prompt = input.initialPrompt?.trim();
			if (prompt && this.canStartSessions(created)) void this.startSession(created.id, prompt);
			return created;
		}
		const sortOrder = this.state.surfaces.filter((surface) => surface.group === "products").length;
		const created = localSurface(slug, title, "products", input.archetype, icon, sortOrder, {
			sourceKind: input.archetype === "studio" ? "folder" : "code_repo",
			folderRoot,
			previewMode: input.archetype === "studio" ? "studio_overlay" : "static_site",
		});
		this.#localCreatedIds.add(created.id);
		const look: SurfaceLook = { kind: input.kind ?? surfaceLookOf(created).kind };
		const sandbox = input.archetype === "studio" ? (localSandbox ?? (await loadLocalSandbox())) : undefined;
		const starterFiles =
			sandbox && input.archetype === "studio"
				? sandbox.starterStudioFiles(created, this.companyName, look.kind, description ?? undefined)
				: undefined;
		const starterBinaries =
			sandbox && input.archetype === "studio"
				? sandbox.starterStudioBinaries(created, this.companyName, look.kind)
				: {};
		this.store.set((state) => ({
			surfaces: sortSurfaces([...state.surfaces, created]),
			workspaces: { ...state.workspaces, [created.id]: { ...localWorkspace(created), briefSummary: description } },
			surfaceLooks: { ...state.surfaceLooks, [created.id]: look },
			...(starterFiles ? { localStudioBase: { ...state.localStudioBase, [created.id]: starterFiles } } : {}),
			...(Object.keys(starterBinaries).length > 0
				? { localStudioBinaries: { ...state.localStudioBinaries, [created.id]: starterBinaries } }
				: {}),
			...(look.kind === "mobile_app" ? { device: "mobile" as const } : {}),
			error: undefined,
		}));
		this.#options.onNavigateSurface?.(created.slug);
		const prompt = input.initialPrompt?.trim();
		if (prompt && this.canStartSessions(created)) void this.startSession(created.id, prompt);
		return created;
	}

	setMode(mode: SurfacePreviewMode): void {
		const wasCompare = this.state.mode === "compare";
		this.store.set({
			mode,
			...(mode !== "compare" ? { compareFocusSessionId: undefined } : {}),
			...(mode !== "report" ? { activeReportSlug: undefined } : {}),
		});
		if (mode !== "compare" && mode !== "live" && this.#activeSurfaceId) {
			const ws = this.workspace(this.#activeSurfaceId);
			if (
				wasCompare &&
				ws &&
				this.state.source === "cloud" &&
				!isLocalSurfaceId(ws.surface.id) &&
				ws.surface.sourceKind === "code_repo" &&
				ws.previewState.mode === "compare"
			) {
				void this.#syncPreview(ws.surface.id, { background: true });
			} else {
				this.#maybeAutoSyncPreview(this.#activeSurfaceId);
			}
		}
	}

	selectReport(slug: string | undefined): void {
		if (this.state.activeReportSlug === slug) return;
		this.store.set({ activeReportSlug: slug });
	}

	openReport(surfaceId: string, slug?: string): void {
		const state = this.state;
		const surface = state.surfaces.find((item) => item.id === surfaceId);
		const dedicatedReport = Boolean(surface && this.lookOf(surface).kind === "report");
		const reports = surfaceReports(state, surfaceId);
		const targetSlug = slug ?? reports[0]?.slug;
		if (dedicatedReport) {
			this.store.set({
				mode: "preview",
				activeReportSlug: targetSlug,
				...(state.previewPanel === "closed" ? { previewPanel: "open" as const } : {}),
			});
			return;
		}
		if (state.mode === "report" && (!targetSlug || state.activeReportSlug === targetSlug || reports.length <= 1)) {
			this.store.set({ mode: "preview", activeReportSlug: undefined });
			return;
		}
		this.store.set({
			mode: "report",
			activeReportSlug: targetSlug,
			...(state.previewPanel === "closed" ? { previewPanel: "open" as const } : {}),
		});
	}

	hostDeliverables(surfaceId: string, reveal: (path: string) => boolean): () => void {
		this.#deliverableHosts.set(surfaceId, reveal);
		return () => {
			if (this.#deliverableHosts.get(surfaceId) === reveal) this.#deliverableHosts.delete(surfaceId);
		};
	}

	async openChangeDeliverable(surfaceId: string, changeId: string, slug: string, path?: string): Promise<void> {
		const state = this.state;
		const surface = state.surfaces.find((item) => item.id === surfaceId);
		const dedicatedReport = Boolean(surface && this.lookOf(surface).kind === "report");
		const wasHidden = !this.isChangeShown(changeId);
		const inTab = Boolean(!dedicatedReport && path && this.#deliverableHosts.get(surfaceId)?.(path));
		if (inTab && state.mode === "compare") this.setMode("preview");
		if (!inTab && !dedicatedReport && !wasHidden && state.mode === "report" && state.activeReportSlug === slug) {
			this.store.set({ mode: "preview", activeReportSlug: undefined });
			return;
		}
		this.store.set((current) => {
			let hiddenChanges = current.hiddenChanges;
			if (wasHidden) {
				const nextHidden = { ...hiddenChanges };
				const failedOwner = this.#changeBelongsToFailedSession(changeId);
				if (failedOwner) nextHidden[changeId] = false;
				else delete nextHidden[changeId];
				hiddenChanges = nextHidden;
			}
			return {
				hiddenChanges,
				mode: dedicatedReport || inTab ? ("preview" as const) : ("report" as const),
				activeReportSlug: slug,
				...(current.previewPanel === "closed" ? { previewPanel: "open" as const } : {}),
			};
		});
		if (wasHidden) {
			await this.#syncPreview(surfaceId, { debounceMs: PREVIEW_TOGGLE_DEBOUNCE_MS });
		}
	}

	openPreviewPanel(surfaceId?: string): void {
		const targetId = surfaceId ?? this.state.drawer?.surfaceId ?? this.#activeSurfaceId;
		const target = targetId ? this.state.surfaces.find((item) => item.id === targetId) : undefined;
		if (this.state.drawer) this.closeDrawer();
		if (target?.archetype === "ops") {
			this.store.set({
				opsPanelSurfaceId: workspaceHasOpenWork(this.state.workspaces[target.id]) ? target.id : undefined,
			});
			return;
		}
		this.store.set({ previewPanel: "open", opsPanelSurfaceId: undefined });
	}

	returnToOverview(surfaceId?: string): void {
		const targetId = surfaceId ?? this.state.drawer?.surfaceId ?? this.#activeSurfaceId;
		if (this.state.drawer) this.closeDrawer();
		if (!targetId) {
			this.store.set({ previewPanel: "open", opsPanelSurfaceId: undefined });
			return;
		}
		if (this.isPreviewPanelOpen(targetId)) return;
		this.openPreviewPanel(targetId);
	}

	closePanel(surfaceId?: string): void {
		const targetId = surfaceId ?? this.state.drawer?.surfaceId ?? this.#activeSurfaceId;
		const target = targetId ? this.state.surfaces.find((item) => item.id === targetId) : undefined;
		if (this.state.drawer) this.closeDrawer();
		if (target?.archetype === "ops") {
			if (this.state.opsPanelSurfaceId !== undefined) this.store.set({ opsPanelSurfaceId: undefined });
			return;
		}
		this.store.set({ previewPanel: "closed", opsPanelSurfaceId: undefined });
	}

	isPreviewPanelOpen(surfaceId: string): boolean {
		const state = this.state;
		const surface = state.surfaces.find((item) => item.id === surfaceId);
		if (!surface) return false;
		if (state.drawer?.surfaceId === surfaceId) return true;
		const hasWork = workspaceHasOpenWork(state.workspaces[surfaceId]);
		if (surface.archetype === "ops") return hasWork && state.opsPanelSurfaceId === surfaceId;
		if (state.previewPanel === "closed") return false;
		if (state.previewPanel === "open") return true;
		if (state.mode === "live") return false;
		return hasWork;
	}

	togglePreviewPanel(surfaceId: string): void {
		if (this.isPreviewPanelOpen(surfaceId)) this.closePanel(surfaceId);
		else this.openPreviewPanel(surfaceId);
	}

	navigateSurface(slug: string): void {
		this.#options.onNavigateSurface?.(slug);
	}

	compareExploration(explorationId: string): void {
		this.store.set({ mode: "compare", compareTargetId: explorationId, compareFocusSessionId: undefined });
		const ws = Object.values(this.state.workspaces).find((item) =>
			item.explorations.some((exp) => exp.id === explorationId),
		);
		if (
			ws &&
			this.state.source === "cloud" &&
			!isLocalSurfaceId(ws.surface.id) &&
			ws.surface.sourceKind === "code_repo"
		) {
			void this.#syncPreview(ws.surface.id);
		}
	}

	compareSession(sessionId: string): void {
		this.store.set({ mode: "compare", compareTargetId: "sessions", compareFocusSessionId: sessionId });
	}

	setCompareTarget(targetId: string): void {
		this.store.set({ mode: "compare", compareTargetId: targetId });
		const ws = Object.values(this.state.workspaces).find((item) =>
			item.explorations.some((exp) => exp.id === targetId),
		);
		if (
			ws &&
			this.state.source === "cloud" &&
			!isLocalSurfaceId(ws.surface.id) &&
			ws.surface.sourceKind === "code_repo"
		) {
			void this.#syncPreview(ws.surface.id);
		}
	}

	toggleCompareOverlay(sessionId: string): void {
		this.store.set((state) => {
			const compareExcludedSessions = { ...state.compareExcludedSessions };
			if (compareExcludedSessions[sessionId]) delete compareExcludedSessions[sessionId];
			else compareExcludedSessions[sessionId] = true;
			return { compareExcludedSessions };
		});
	}

	async inspectVariant(
		surfaceId: string,
		explorationId: string | undefined,
		sessionId: string,
		openDrawer = false,
	): Promise<void> {
		if (explorationId) await this.pickVariant(surfaceId, explorationId, sessionId);
		this.store.set({ mode: "preview" });
		if (openDrawer) this.openDrawer(surfaceId, sessionId);
	}

	setDevice(device: SurfaceDevice): void {
		this.store.set({ device });
	}

	setWebsiteZoom(zoom: number): void {
		const next = clampSurfaceZoom(zoom);
		if (this.state.websiteZoom !== next) this.store.set({ websiteZoom: next });
	}

	setPhoneZoom(zoom: number): void {
		const next = clampSurfaceZoom(zoom);
		if (this.state.phoneZoom !== next) this.store.set({ phoneZoom: next });
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

	async #run<T>(key: string, work: (client: SurfacesClient) => Promise<T>, quiet = false): Promise<T | undefined> {
		const client = this.#options.client;
		if (!client) {
			if (!quiet) this.store.set({ error: this.#options.unavailableMessage });
			return undefined;
		}
		if (this.state.busy[key]) return undefined;
		this.store.set((state) => ({ busy: { ...state.busy, [key]: true }, ...(quiet ? {} : { error: undefined }) }));
		try {
			return await work(client);
		} catch (error) {
			if (!this.#options.signal.aborted && !quiet)
				this.store.set({
					error: isMissingSurfaceRpcError(error) ? this.#options.unavailableMessage : describe(error),
				});
			return undefined;
		} finally {
			if (!this.#options.signal.aborted) {
				this.store.set((state) => {
					const busy = { ...state.busy };
					delete busy[key];
					return { busy };
				});
			}
		}
	}

	#stageLocalSession(surface: SurfaceSummary, sessionId: string, prompt: string): void {
		this.#scheduleLocal(650, () => {
			const finish = (sandbox: LocalSandboxModule): void => {
				if (this.#options.signal.aborted) return;
				const workspace = this.workspace(surface.id);
				const current = workspace?.activeSessions.find((item) => item.id === sessionId);
				if (!workspace || !current) return;
				const plan = sandbox.synthesizeLocalChanges(
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
			};
			if (localSandbox) finish(localSandbox);
			else void loadLocalSandbox().then(finish);
		});
	}

	get canAttachImages(): boolean {
		return Boolean(
			this.#options.uploadImage && this.#options.client?.surfaceSessionImages && !this.isLocalInteractive,
		);
	}

	async #uploadImages(
		client: SurfacesClient,
		surfaceId: string,
		files: readonly File[],
	): Promise<{ clientInputId: string; images: SurfaceImageRef[] } | undefined> {
		if (!files.length) return undefined;
		const upload = this.#options.uploadImage;
		if (!upload || !client.surfaceSessionImages) throw new Error(t("Images can't be sent here yet."));
		const clientInputId = crypto.randomUUID();
		const images = await Promise.all(
			files.map((file) => upload(surfaceId, clientInputId, file, this.#options.signal)),
		);
		return { clientInputId, images };
	}

	ensureSessionImages(session: SurfaceSession): void {
		const client = this.#options.client;
		if (!client?.surfaceSessionImages || isLocalSurfaceId(session.surfaceId)) return;
		const key = session.messages
			.filter((message) => message.authorKind === "member")
			.map((message) => message.id)
			.join(",");
		if (!key || this.#imageReads.get(session.id) === key) return;
		this.#imageReads.set(session.id, key);
		client.surfaceSessionImages(session.id).then(
			(images) => {
				if (this.#options.signal.aborted || this.#imageReads.get(session.id) !== key) return;
				this.store.set((state) => ({ sessionImages: { ...state.sessionImages, [session.id]: images } }));
			},
			() => undefined,
		);
	}

	readSessionImage(
		sessionId: string,
		clientInputId: string,
		image: SurfaceImageRef,
		signal: AbortSignal,
	): Promise<Blob> {
		const read = this.#options.readImage;
		if (!read) return Promise.reject(new Error(t("This image is not available.")));
		return read(sessionId, clientInputId, image, signal);
	}

	async startSession(
		surfaceId: string,
		prompt: string,
		options: StartSurfaceSessionOptions = {},
		files: readonly File[] = [],
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
		const resolvedOptions: StartSurfaceSessionOptions =
			options.previewBaseChangeIds === undefined && this.state.mode !== "live"
				? (() => {
						const previewBaseChangeIds = this.visiblePreviewChangeIds(surfaceId);
						return previewBaseChangeIds.length > 0 ? { ...options, previewBaseChangeIds } : options;
					})()
				: options;
		const session = await this.#run(`start:${surfaceId}:${text}`, async (client) => {
			const attached = await this.#uploadImages(client, surfaceId, files);
			return client.startSurfaceSession(
				surfaceId,
				text,
				attached ? { ...resolvedOptions, ...attached } : resolvedOptions,
			);
		});
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
			this.#surfacesMutationEpoch += 1;
			this.#hydratedAttempted.delete(surfaceId);
			this.store.set((state) => {
				const workspaces = { ...state.workspaces };
				delete workspaces[surfaceId];
				const cloudSurfaceFiles = { ...state.cloudSurfaceFiles };
				delete cloudSurfaceFiles[surfaceId];
				const localStudioBase = { ...state.localStudioBase };
				delete localStudioBase[surfaceId];
				const cloudSurfaceBinaries = { ...state.cloudSurfaceBinaries };
				delete cloudSurfaceBinaries[surfaceId];
				const localStudioBinaries = { ...state.localStudioBinaries };
				delete localStudioBinaries[surfaceId];
				const pendingStudioPatches = { ...state.pendingStudioPatches };
				delete pendingStudioPatches[surfaceId];
				const loadingCloudFiles = { ...state.loadingCloudFiles };
				delete loadingCloudFiles[surfaceId];
				const updatingCloudFiles = { ...state.updatingCloudFiles };
				delete updatingCloudFiles[surfaceId];
				return {
					surfaces: state.surfaces.filter((surface) => surface.id !== surfaceId),
					workspaces,
					cloudSurfaceFiles,
					localStudioBase,
					cloudSurfaceBinaries,
					localStudioBinaries,
					pendingStudioPatches,
					loadingCloudFiles,
					updatingCloudFiles,
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

	async deleteSurface(surfaceId: string): Promise<boolean> {
		const surface = this.state.surfaces.find((item) => item.id === surfaceId);
		if (!surface || !(await this.archiveSurface(surfaceId))) return false;
		this.store.set((state) => ({
			automations: state.automations.filter((item) => item.targetSurfaceSlug !== surface.slug),
		}));
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
			if (!this.#options.signal.aborted) {
				this.store.set((state) => {
					const busy = { ...state.busy };
					delete busy[busyKey];
					return { busy };
				});
			}
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
					const composed = composeStudioPreview(currentBase, ordered, workspace.surface.folderRoot);
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

	#evictStudioUndoSnapshots(changeIds: readonly string[] | undefined): void {
		if (!changeIds) return;
		for (const id of changeIds) this.#studioUndoSnapshots.delete(id);
	}

	#offerUndo(label: string, changeIds: readonly string[], verb: SurfaceUndoVerb = "merged"): void {
		if (this.#undoTimer) clearTimeout(this.#undoTimer);
		const previous = this.state.undo;
		if (previous) this.#evictStudioUndoSnapshots(previous.changeIds);
		const id = ++this.#undoSeq;
		this.store.set({ undo: { id, label, changeIds, verb } });
		this.#undoTimer = setTimeout(() => {
			this.#undoTimer = undefined;
			this.#evictStudioUndoSnapshots(changeIds);
			if (!this.#options.signal.aborted && this.state.undo?.id === id) this.store.set({ undo: undefined });
		}, SURFACE_UNDO_MS);
	}

	// WHY: Async code_repo/folder merges stay in "merging" until the worker finishes; show a pending toast and start Undo only once merged.
	#offerPendingMerge(
		surfaceId: string,
		label: string,
		changeIds: readonly string[],
		verb: SurfaceUndoVerb = "merged",
	): void {
		if (changeIds.length === 0) return;
		if (this.#undoTimer) {
			clearTimeout(this.#undoTimer);
			this.#undoTimer = undefined;
		}
		const previous = this.state.undo;
		if (previous) this.#evictStudioUndoSnapshots(previous.changeIds);
		const id = ++this.#undoSeq;
		this.#pendingMerges.set(`${surfaceId}:${id}`, { surfaceId, label, changeIds, verb, undoId: id });
		this.store.set({ undo: { id, label, changeIds, verb, pending: true } });
	}

	#reconcilePendingMerges(workspace: SurfaceWorkspace): void {
		const surfaceId = workspace.surface.id;
		const statusById = new Map<string, SurfaceChangeUnit["status"]>();
		for (const session of [...workspace.activeSessions, ...workspace.recentHistory]) {
			for (const change of session.changes) statusById.set(change.id, change.status);
		}
		for (const [key, entry] of [...this.#pendingMerges.entries()]) {
			if (entry.surfaceId !== surfaceId) continue;
			const statuses = entry.changeIds
				.map((id) => statusById.get(id))
				.filter((s): s is SurfaceChangeUnit["status"] => Boolean(s));
			if (statuses.length === 0) continue;
			if (statuses.every((s) => s === "merged")) {
				this.#pendingMerges.delete(key);
				this.#offerUndo(entry.label, entry.changeIds, entry.verb);
			} else if (!statuses.some((s) => s === "merging")) {
				this.#pendingMerges.delete(key);
				if (this.state.undo?.id === entry.undoId) this.store.set({ undo: undefined });
			}
		}
	}

	#reconcilePendingPublish(surface: SurfaceSummary): void {
		const pending = this.#pendingPublishChanges.get(surface.id);
		if (!pending) return;
		if (surface.publishStatus === "idle" || (surface.publishStatus === undefined && !surface.hasUnpublishedChanges)) {
			this.#pendingPublishChanges.delete(surface.id);
			if (pending.length > 0) {
				this.store.set((state) => {
					const publishedChangeIds = { ...state.publishedChangeIds };
					for (const id of pending) publishedChangeIds[id] = true;
					return { publishedChangeIds };
				});
			}
		} else if (surface.publishStatus === "failed") {
			this.#pendingPublishChanges.delete(surface.id);
		}
	}

	drawerOpenOn(sessionId: string): boolean {
		return this.state.drawer?.sessionId === sessionId;
	}

	async approveChange(sessionId: string, changeId: string): Promise<ApprovalOutcome | undefined> {
		const found = this.#sessionAt(sessionId);
		if (this.isLocalInteractive && found && isLocalSurfaceId(found.workspace.surface.id)) {
			const drawerOpen = this.drawerOpenOn(sessionId);
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
		const outcome = approvalOutcome(updated, this.drawerOpenOn(sessionId));
		this.#applySession(updated, outcome);
		const change = updated.changes.find((item) => item.id === changeId);
		const verb = this.#undoVerbFor(updated.surfaceId);
		if (change?.status === "merging") {
			const mergingIds = updated.changes.filter((item) => item.status === "merging").map((item) => item.id);
			this.#offerPendingMerge(
				updated.surfaceId,
				change.title,
				mergingIds.length > 0 ? mergingIds : [changeId],
				verb,
			);
		} else if (!change || change.status === "merged") {
			this.#offerUndo(change?.title ?? updated.title, [changeId], verb);
		} else if (change.status === "staged") {
			void this.refreshWorkspace(updated.surfaceId);
		}
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
		const merging = updated.changes
			.filter(
				(change) =>
					change.status === "merging" &&
					before?.changes.find((item) => item.id === change.id)?.status !== "merging",
			)
			.map((change) => change.id);
		if (this.drawerOpenOn(sessionId)) {
			this.store.set({ drawer: undefined });
			void this.#options.client?.setSessionChatOpen(sessionId, false).catch(() => undefined);
		}
		this.#applySession(updated, approvalOutcome(updated, false));
		const verb = this.#undoVerbFor(updated.surfaceId);
		if (merged.length > 0) this.#offerUndo(updated.title, merged, verb);
		else if (merging.length > 0) this.#offerPendingMerge(updated.surfaceId, updated.title, merging, verb);
		else if (updated.changes.some(isOpenChange)) void this.refreshWorkspace(updated.surfaceId);
		void this.refreshSurfaces();
		return true;
	}

	async approveChanges(
		surfaceId: string,
		groups: readonly { readonly sessionId: string; readonly changeIds: readonly string[] }[],
	): Promise<boolean> {
		const targets = groups.filter((group) => group.changeIds.length > 0);
		const ids = targets.flatMap((group) => group.changeIds);
		if (ids.length === 0) return false;
		const titleOf = (id: string): string =>
			targets
				.map((group) => this.session(group.sessionId)?.changes.find((change) => change.id === id)?.title)
				.find(Boolean) ?? "";
		const labelFor = (done: readonly string[]): string =>
			done.length === 1 ? titleOf(done[0]!) : t("{count} changes", { count: done.length });
		const verb = this.#undoVerbFor(surfaceId);
		if (this.isLocalInteractive && isLocalSurfaceId(surfaceId)) {
			const now = new Date().toISOString();
			const updatedSessions: SurfaceSession[] = [];
			for (const group of targets) {
				const found = this.#sessionAt(group.sessionId);
				if (!found) continue;
				const chosen = new Set(group.changeIds);
				const drawerOpen = this.drawerOpenOn(group.sessionId);
				const changes = found.session.changes.map((change) =>
					chosen.has(change.id) && isOpenChange(change)
						? { ...change, status: "merged" as const, canUndo: true, resolvedAt: now }
						: change,
				);
				const openCount = countOpenSurfaceChanges(changes);
				updatedSessions.push({
					...found.session,
					state: openCount === 0 && !drawerOpen ? "completed" : "ready",
					hasActiveChat: drawerOpen,
					changes,
					openChangeCount: openCount,
					messages: [
						...found.session.messages,
						...found.session.changes
							.filter((change) => chosen.has(change.id) && isOpenChange(change))
							.map((change) => ({
								id: `local-message-${++this.#localSeq}`,
								sessionId: group.sessionId,
								authorKind: "system" as const,
								text: this.#doneLine(verb, change.title),
								changeId: change.id,
								createdAt: now,
							})),
					],
					updatedAt: now,
					closedAt: openCount === 0 && !drawerOpen ? now : null,
				});
			}
			const done = ids.filter((id) =>
				updatedSessions.some((session) => session.changes.some((change) => change.id === id)),
			);
			if (done.length === 0) return false;
			this.#commitLocalChangesToBase(surfaceId, done);
			for (const updated of updatedSessions)
				this.#applySession(updated, approvalOutcome(updated, this.drawerOpenOn(updated.id)));
			this.#offerUndo(labelFor(done), done, verb);
			return true;
		}
		const client = this.#options.client;
		if (!client) {
			this.store.set({ error: this.#options.unavailableMessage });
			return false;
		}
		const keys = ids.map((id) => `change:${id}`);
		if (keys.some((key) => this.state.busy[key])) return false;
		this.store.set((state) => {
			const busy = { ...state.busy };
			for (const key of keys) busy[key] = true;
			return { busy, error: undefined };
		});
		const approved = new Map<string, SurfaceSession>();
		const plans = targets.map((group) => {
			const session = this.session(group.sessionId);
			const open = session?.changes.filter(isOpenChange) ?? [];
			const whole =
				open.length === group.changeIds.length && open.every((change) => group.changeIds.includes(change.id));
			return { group, whole, waves: whole ? [] : approvalWaves(group.changeIds, session?.changes) };
		});
		let firstError: unknown;
		let hasError = false;
		try {
			// WHY: Independent sessions and dependency-free changes approve concurrently with bounded parallelism.
			await runBounded(plans, SURFACE_BATCH_CONCURRENCY, async ({ group, whole, waves }) => {
				try {
					if (whole) {
						approved.set(
							group.sessionId,
							mergeApprovedSession(
								approved.get(group.sessionId),
								await client.approveSessionAll(group.sessionId),
							),
						);
						return;
					}
					for (const wave of waves) {
						let waveError = false;
						await runBounded(wave, SURFACE_BATCH_CONCURRENCY, async (id) => {
							try {
								const next = await client.approveSurfaceChange(id);
								approved.set(group.sessionId, mergeApprovedSession(approved.get(group.sessionId), next));
							} catch (error) {
								if (!hasError) {
									hasError = true;
									firstError = error;
								}
								waveError = true;
							}
						});
						if (waveError) return;
					}
				} catch (error) {
					if (!hasError) {
						hasError = true;
						firstError = error;
					}
				}
			});
			if (hasError && !this.#options.signal.aborted)
				this.store.set({
					error: isMissingSurfaceRpcError(firstError) ? this.#options.unavailableMessage : describe(firstError),
				});
		} finally {
			if (!this.#options.signal.aborted)
				this.store.set((state) => {
					const busy = { ...state.busy };
					for (const key of keys) delete busy[key];
					return { busy };
				});
		}
		const finished = !hasError;
		if (approved.size === 0) return false;
		const statusById = new Map<string, SurfaceChangeUnit["status"]>();
		for (const updated of approved.values()) {
			if (this.drawerOpenOn(updated.id) && !updated.changes.some(isOpenChange)) {
				this.store.set({ drawer: undefined });
				void client.setSessionChatOpen(updated.id, false).catch(() => undefined);
			}
			this.#applySession(updated, approvalOutcome(updated, this.drawerOpenOn(updated.id)));
			for (const change of updated.changes) statusById.set(change.id, change.status);
		}
		const merged = ids.filter((id) => statusById.get(id) === "merged");
		const merging = ids.filter((id) => statusById.get(id) === "merging");
		const done = [...merged, ...merging];
		if (merging.length > 0) this.#offerPendingMerge(surfaceId, labelFor(done), done, verb);
		else if (merged.length > 0) this.#offerUndo(labelFor(merged), merged, verb);
		if (!finished || ids.some((id) => statusById.get(id) === "staged")) void this.refreshWorkspace(surfaceId);
		void this.refreshSurfaces();
		return finished;
	}

	async discardChange(sessionId: string, changeId: string): Promise<boolean> {
		const found = this.#sessionAt(sessionId);
		if (!found) return false;
		if (this.isLocalInteractive && isLocalSurfaceId(found.workspace.surface.id)) {
			const drawerOpen = this.drawerOpenOn(sessionId);
			const now = new Date().toISOString();
			const target = found.session.changes.find((item) => item.id === changeId);
			let changes = found.session.changes.map((change) =>
				change.id === changeId ? { ...change, status: "discarded" as const, resolvedAt: now } : change,
			);
			if (target?.optionGroupKey) {
				const survivors = changes.filter(
					(change) => isOpenChange(change) && change.optionGroupKey === target.optionGroupKey,
				);
				if (survivors.length === 1) {
					const survivorId = survivors[0]!.id;
					changes = changes.map((change) =>
						change.id === survivorId ? { ...change, optionGroupKey: null, optionGroupTitle: null } : change,
					);
				}
			}
			const openCount = countOpenSurfaceChanges(changes);
			const hasMerged = changes.some((change) => change.status === "merged");
			const stillRunning = isRunningSession(found.session);
			const allDiscarded = !stillRunning && openCount === 0 && !hasMerged;
			const closes = !stillRunning && openCount === 0 && !drawerOpen;
			const updated: SurfaceSession = {
				...found.session,
				state: stillRunning ? found.session.state : allDiscarded ? "discarded" : closes ? "completed" : "ready",
				hasActiveChat: stillRunning ? found.session.hasActiveChat : !allDiscarded && drawerOpen,
				changes,
				openChangeCount: openCount,
				messages: [
					...found.session.messages,
					{
						id: `local-message-${++this.#localSeq}`,
						sessionId,
						authorKind: "system",
						text: t("Discarded “{title}”", { title: target?.title ?? found.session.title }),
						changeId,
						createdAt: now,
					},
				],
				updatedAt: now,
				closedAt: allDiscarded || closes ? now : null,
			};
			this.store.set((state) => {
				if (state.hiddenChanges[changeId] === undefined) return {};
				const hiddenChanges = { ...state.hiddenChanges };
				delete hiddenChanges[changeId];
				return { hiddenChanges };
			});
			const outcome: ApprovalOutcome = stillRunning
				? "open"
				: allDiscarded
					? "history"
					: approvalOutcome(updated, drawerOpen);
			if (outcome === "history" && this.drawerOpenOn(sessionId)) this.store.set({ drawer: undefined });
			this.#applySession(updated, outcome);
			return true;
		}
		const updated = await this.#run(`change:${changeId}`, (client) => client.discardSurfaceChange(changeId));
		if (!updated) return false;
		const openCount = countOpenSurfaceChanges(updated.changes);
		const hasMerged = updated.changes.some((change) => change.status === "merged");
		const outcome: ApprovalOutcome = isRunningSession(updated)
			? "open"
			: openCount === 0 && !hasMerged
				? "history"
				: approvalOutcome(updated, this.drawerOpenOn(sessionId));
		if (outcome === "history" && this.drawerOpenOn(sessionId)) {
			this.store.set({ drawer: undefined });
			void this.#options.client?.setSessionChatOpen(sessionId, false).catch(() => undefined);
		}
		const hasDependents = this.workspace(updated.surfaceId)?.activeSessions.some((session) =>
			session.changes.some(
				(change) =>
					change.id !== changeId &&
					isOpenChange(change) &&
					(change.previewBaseChangeIds?.includes(changeId) ?? false),
			),
		);
		this.#applySession(updated, outcome);
		if (hasDependents) void this.refreshWorkspace(updated.surfaceId);
		void this.refreshSurfaces();
		return true;
	}

	async discardExploration(exploration: SurfaceExplorationSet): Promise<boolean> {
		if (this.state.insteadOf?.explorationId === exploration.id) this.store.set({ insteadOf: undefined });
		if (this.isLocalInteractive && isLocalSurfaceId(exploration.surfaceId)) {
			const workspace = this.workspace(exploration.surfaceId);
			if (!workspace) return false;
			const now = new Date().toISOString();
			const variantIds = new Set(exploration.variantSessionIds);
			const closedVariants: SurfaceSession[] = [];
			const remainingActive: SurfaceSession[] = [];
			for (const session of workspace.activeSessions) {
				if (!variantIds.has(session.id)) {
					remainingActive.push(session);
					continue;
				}
				closedVariants.push({
					...session,
					state: "discarded",
					changes: session.changes.map((change) =>
						isOpenChange(change) ? { ...change, status: "discarded" as const, resolvedAt: now } : change,
					),
					openChangeCount: 0,
					updatedAt: now,
					closedAt: now,
				});
			}
			const nextExplorations = workspace.explorations.map((item) =>
				item.id === exploration.id ? { ...item, status: "discarded" as const, resolvedAt: now } : item,
			);
			const nextWorkspace: SurfaceWorkspace = {
				...workspace,
				activeSessions: remainingActive,
				recentHistory: [...closedVariants, ...workspace.recentHistory],
				explorations: nextExplorations,
			};
			if (
				this.state.drawer?.explorationId === exploration.id ||
				(this.state.drawer && variantIds.has(this.state.drawer.sessionId))
			)
				this.store.set({ drawer: undefined });
			this.#putWorkspace({ ...nextWorkspace, surface: this.#syncLocalSurfaceCounts(nextWorkspace) });
			return true;
		}
		if (this.#options.client?.discardExploration && !isLocalSurfaceId(exploration.surfaceId)) {
			const result = await this.#run(`exploration:discard:${exploration.id}`, async (client) => {
				await client.discardExploration!(exploration.id);
				return true;
			});
			if (!result) return false;
		} else {
			for (const variantId of exploration.variantSessionIds) {
				await this.discardSession(variantId);
			}
		}
		if (this.state.drawer?.explorationId === exploration.id) this.store.set({ drawer: undefined });
		await this.refreshWorkspace(exploration.surfaceId);
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
		const closed = await this.#run(`discard-session:${sessionId}`, (client) =>
			client.discardSurfaceSession(sessionId),
		);
		if (!closed) return false;
		if (this.drawerOpenOn(sessionId)) this.store.set({ drawer: undefined });
		const discardedIds = new Set<string>([
			...session.changes.filter(isOpenChange).map((change) => change.id),
			...closed.changes.filter((change) => change.status === "discarded").map((change) => change.id),
		]);
		const hasDependents =
			discardedIds.size > 0 &&
			(this.workspace(closed.surfaceId)?.activeSessions.some(
				(other) =>
					other.id !== sessionId &&
					other.changes.some(
						(change) =>
							isOpenChange(change) &&
							(change.previewBaseChangeIds?.some((baseId) => discardedIds.has(baseId)) ?? false),
					),
			) ??
				false);
		this.#applySession(closed, "history");
		if (hasDependents) void this.refreshWorkspace(closed.surfaceId);
		void this.refreshSurfaces();
		return true;
	}

	async undo(): Promise<boolean> {
		const undo = this.state.undo;
		if (!undo || undo.pending) return false;
		if (this.#undoTimer) {
			clearTimeout(this.#undoTimer);
			this.#undoTimer = undefined;
		}
		this.store.set({ undo: undefined });
		if (this.isLocalInteractive && undo.changeIds.every((id) => id.startsWith("local-"))) {
			return Boolean(this.#undoLocalChangeIds(undo.changeIds));
		}
		const restored = new Map<string, SurfaceSession>();
		const applyRestored = (): void => {
			for (const session of restored.values())
				this.#applySession(session, approvalOutcome(session, this.drawerOpenOn(session.id)));
			if (restored.size > 0) void this.refreshSurfaces();
		};
		const sessionForChange = (changeId: string): string | undefined => {
			for (const workspace of Object.values(this.state.workspaces)) {
				const session =
					workspace.activeSessions.find((item) => item.changes.some((change) => change.id === changeId)) ??
					workspace.recentHistory.find((item) => item.changes.some((change) => change.id === changeId));
				if (session) return session.id;
			}
			return undefined;
		};
		const grouped = new Map<string, string[]>();
		for (const changeId of undo.changeIds) {
			const key = sessionForChange(changeId) ?? `unknown:${changeId}`;
			const bucket = grouped.get(key) ?? [];
			bucket.push(changeId);
			grouped.set(key, bucket);
		}
		let failed = false;
		// WHY: Undo distinct sessions concurrently while keeping same-session batch undos sequential so atomic batches skip cleanly.
		await runBounded([...grouped.values()], SURFACE_BATCH_CONCURRENCY, async (changeIds) => {
			for (const changeId of changeIds) {
				const already = [...restored.values()].some(
					(session) => session.changes.find((item) => item.id === changeId)?.status === "staged",
				);
				if (already) continue;
				const next = await this.#run(`undo:${changeId}`, (client) => client.undoSurfaceChange(changeId));
				if (!next) {
					failed = true;
					return;
				}
				restored.set(next.id, next);
			}
		});
		applyRestored();
		if (failed) return false;
		if (restored.size === 0) void this.refreshSurfaces();
		return true;
	}

	async rollbackChange(changeId: string): Promise<boolean> {
		let found: { workspace: SurfaceWorkspace; session: SurfaceSession; change: SurfaceChangeUnit } | undefined;
		for (const workspace of Object.values(this.state.workspaces)) {
			const session =
				workspace.activeSessions.find((item) => item.changes.some((change) => change.id === changeId)) ??
				workspace.recentHistory.find((item) => item.changes.some((change) => change.id === changeId));
			if (session) {
				const change = session.changes.find((item) => item.id === changeId);
				if (change) {
					found = { workspace, session, change };
					break;
				}
			}
		}
		if (!found) return false;
		const surfaceId = found.workspace.surface.id;
		if (this.isLocalInteractive && isLocalSurfaceId(surfaceId)) {
			const exploration = found.session.explorationId
				? found.workspace.explorations.find((item) => item.id === found.session.explorationId)
				: undefined;
			if (exploration) {
				const now = new Date().toISOString();
				const variantIds = new Set(exploration.variantSessionIds);
				const allSessions = [...found.workspace.activeSessions, ...found.workspace.recentHistory];
				const restoredVariants: SurfaceSession[] = [];
				for (const variantId of exploration.variantSessionIds) {
					const existing = allSessions.find((item) => item.id === variantId);
					if (!existing) continue;
					const changes = existing.changes.map((item) => ({
						...item,
						status: "staged" as const,
						canUndo: false,
						resolvedAt: null,
					}));
					restoredVariants.push({
						...existing,
						state: "ready",
						changes,
						openChangeCount: countOpenSurfaceChanges(changes),
						updatedAt: now,
						closedAt: null,
					});
				}
				const nextExplorations = found.workspace.explorations.map((item) =>
					item.id === exploration.id
						? { ...item, status: "open" as const, chosenSessionId: null, resolvedAt: null }
						: item,
				);
				const nextCount = Math.max(0, found.workspace.surface.unpublishedChangeCount - 1);
				const nextSurface: SurfaceSummary = {
					...found.workspace.surface,
					hasUnpublishedChanges: nextCount > 0,
					unpublishedChangeCount: nextCount,
				};
				const nextWorkspace: SurfaceWorkspace = {
					...found.workspace,
					surface: nextSurface,
					activeSessions: [
						...found.workspace.activeSessions.filter((item) => !variantIds.has(item.id)),
						...restoredVariants,
					],
					recentHistory: found.workspace.recentHistory.filter((item) => !variantIds.has(item.id)),
					explorations: nextExplorations,
				};
				this.#putWorkspace({ ...nextWorkspace, surface: this.#syncLocalSurfaceCounts(nextWorkspace) });
				return true;
			}
			return Boolean(this.#undoLocalChangeIds([changeId]));
		}
		const restored = await this.#run(`undo:${changeId}`, (client) => client.undoSurfaceChange(changeId));
		if (!restored) return false;
		this.#applySession(restored, approvalOutcome(restored, this.drawerOpenOn(restored.id)));
		await this.refreshWorkspace(surfaceId);
		void this.refreshSurfaces();
		return true;
	}

	async chooseVariant(exploration: SurfaceExplorationSet, sessionId: string): Promise<boolean> {
		const focusChosen = (state: SurfacesState): Partial<SurfacesState> => ({
			mode: state.mode === "compare" ? "preview" : state.mode,
			...(state.insteadOf?.explorationId === exploration.id ? { insteadOf: undefined } : {}),
			...(state.drawer?.explorationId === exploration.id
				? { drawer: { surfaceId: exploration.surfaceId, sessionId } }
				: {}),
		});
		if (this.isLocalInteractive && isLocalSurfaceId(exploration.surfaceId)) {
			const workspace = this.workspace(exploration.surfaceId);
			if (!workspace?.activeSessions.some((item) => item.id === sessionId)) return false;
			const now = new Date().toISOString();
			const variantIds = new Set(exploration.variantSessionIds);
			const dropped: SurfaceSession[] = [];
			const remainingActive: SurfaceSession[] = [];
			for (const session of workspace.activeSessions) {
				if (!variantIds.has(session.id) || session.id === sessionId) {
					remainingActive.push(session);
					continue;
				}
				dropped.push({
					...session,
					state: "discarded",
					changes: session.changes.map((change) =>
						isOpenChange(change) ? { ...change, status: "discarded" as const, resolvedAt: now } : change,
					),
					openChangeCount: 0,
					updatedAt: now,
					closedAt: now,
				});
			}
			const nextWorkspace: SurfaceWorkspace = {
				...workspace,
				activeSessions: remainingActive,
				recentHistory: [...dropped, ...workspace.recentHistory],
				explorations: workspace.explorations.map((item) =>
					item.id === exploration.id
						? { ...item, status: "chosen" as const, chosenSessionId: sessionId, resolvedAt: now }
						: item,
				),
			};
			this.#putWorkspace({ ...nextWorkspace, surface: this.#syncLocalSurfaceCounts(nextWorkspace) });
			this.store.set(focusChosen);
			return true;
		}
		const chosen = await this.#run(`exploration:${exploration.id}`, (client) =>
			client.chooseExploration(exploration.id, sessionId),
		);
		if (!chosen) return false;
		this.store.set(focusChosen);
		await this.refreshWorkspace(exploration.surfaceId);
		void this.refreshSurfaces();
		return true;
	}

	async retrySession(sessionId: string): Promise<boolean> {
		return this.reply(sessionId, t("Retry and complete the requested changes."));
	}

	async reply(sessionId: string, text: string, files: readonly File[] = [], changeId?: string): Promise<boolean> {
		const message = text.trim();
		if (!message || this.state.busy[`reply:${sessionId}`]) return false;
		const targetChangeId = changeId?.trim() || undefined;
		const existing = this.session(sessionId);
		if (this.isLocalInteractive && existing && isLocalSurfaceId(existing.surfaceId)) {
			const now = new Date().toISOString();
			const refMatch = message.match(/^Re:\s*\[([^\]]+)\]\s*\n([\s\S]*)$/);
			const replyAck = refMatch
				? t("Got it — updated “{title}” with “{note}”.", {
						title: refMatch[1]!.trim(),
						note: refMatch[2]!.trim(),
					})
				: t("Got it — updated the open changes with “{note}”.", { note: message });
			const updated: SurfaceSession = {
				...existing,
				messages: [
					...existing.messages,
					{
						id: `local-message-${++this.#localSeq}`,
						sessionId,
						authorKind: "member",
						text: message,
						changeId: targetChangeId ?? null,
						createdAt: now,
					},
					{
						id: `local-message-${++this.#localSeq}`,
						sessionId,
						authorKind: "session",
						text: replyAck,
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
			...(files.length ? { files: [...files] } : {}),
		};
		this.store.set((state) => ({ notes: [...state.notes, note] }));
		const updated = await this.#run(`reply:${sessionId}`, async (client) => {
			const surfaceId = existing?.surfaceId;
			if (files.length && !surfaceId) throw new Error(t("This session is not available."));
			const attached = surfaceId ? await this.#uploadImages(client, surfaceId, files) : undefined;
			return targetChangeId
				? client.replySurfaceSession(sessionId, message, true, attached, targetChangeId)
				: attached
					? client.replySurfaceSession(sessionId, message, true, attached)
					: client.replySurfaceSession(sessionId, message);
		});
		if (!updated) {
			this.store.set((state) => ({ notes: state.notes.filter((item) => item.id !== note.id) }));
			return false;
		}
		if (this.state.workspaces[updated.surfaceId]) this.#applySession(updated, "open");
		else this.store.set((state) => ({ notes: reconcileNotes(state.notes, [updated]) }));
		return true;
	}

	async noteTo(sessionId: string, text: string, to: readonly string[]): Promise<boolean> {
		const message = text.trim();
		const existing = this.session(sessionId);
		if (!message || !to.length || !existing || this.state.busy[`reply:${sessionId}`]) return false;
		if (this.isLocalInteractive && isLocalSurfaceId(existing.surfaceId)) {
			const now = new Date().toISOString();
			this.#applySession(
				{
					...existing,
					messages: [
						...existing.messages,
						{
							id: `local-message-${++this.#localSeq}`,
							sessionId,
							authorKind: "note",
							text: message,
							changeId: null,
							noteTo: [...to],
							createdAt: now,
						},
					],
				},
				"open",
			);
			return true;
		}
		const note: SurfaceNote = {
			id: ++this.#noteSeq,
			sessionId,
			text: message,
			at: new Date().toISOString(),
			priorMatches:
				memberMessageMatches(existing, message) +
				this.state.notes.filter((item) => item.sessionId === sessionId && item.text === message).length,
			to: [...to],
		};
		this.store.set((state) => ({ notes: [...state.notes, note] }));
		const updated = await this.#run(`reply:${sessionId}`, (client) => {
			if (!client.noteSurfaceSession) throw new Error(t("Notes to teammates are not available here yet."));
			return client.noteSurfaceSession(sessionId, message, to);
		});
		if (!updated) {
			this.store.set((state) => ({ notes: state.notes.filter((item) => item.id !== note.id) }));
			return false;
		}
		if (this.state.workspaces[updated.surfaceId]) this.#applySession(updated, "open");
		else this.store.set((state) => ({ notes: reconcileNotes(state.notes, [updated]) }));
		return true;
	}

	openDrawer(surfaceId: string, sessionId: string): void {
		if (this.state.highlight?.sessionId === sessionId) this.store.set({ highlight: undefined });
		const previous = this.state.drawer;
		if (previous?.sessionId === sessionId && !previous.explorationId) return;
		if (previous) this.closeDrawer();
		this.store.set({ drawer: { surfaceId, sessionId } });
		if (!isLocalSurfaceId(surfaceId))
			void this.#options.client?.setSessionChatOpen(sessionId, true).catch(() => undefined);
	}

	openExplorationDrawer(surfaceId: string, explorationId: string): void {
		const previous = this.state.drawer;
		if (previous?.explorationId === explorationId) return;
		const exploration = this.workspace(surfaceId)?.explorations.find((item) => item.id === explorationId);
		const sessionId = exploration ? this.pickedVariant(exploration) : undefined;
		if (!exploration || !sessionId) return;
		if (previous) this.closeDrawer();
		this.store.set({ drawer: { surfaceId, sessionId, explorationId } });
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
		const state = this.state;
		for (const workspace of Object.values(state.workspaces)) {
			for (const session of workspace.activeSessions) {
				const found = session.changes.find((item) => item.id === changeId);
				if (found) return isSessionChangeShown(session, found, state);
			}
		}
		return !state.hiddenChanges[changeId];
	}

	pickedOption(session: Pick<SurfaceSession, "id" | "changes">, optionGroupKey: string): string | null {
		return pickedOptionChangeId(session, optionGroupKey, this.state.optionPick);
	}

	async pickOption(surfaceId: string, sessionId: string, optionGroupKey: string, changeId: string): Promise<void> {
		const key = optionGroupId(sessionId, optionGroupKey);
		const session = this.session(sessionId);
		const current = session ? pickedOptionChangeId(session, optionGroupKey, this.state.optionPick) : null;
		const nextPick = current === changeId ? null : changeId;
		this.store.set((state) => ({
			optionPick: { ...state.optionPick, [key]: nextPick },
			...(state.mode === "live" || state.mode === "report"
				? { mode: "preview" as const, activeReportSlug: undefined }
				: {}),
		}));
		await this.#syncPreview(surfaceId);
	}

	async chooseOption(sessionId: string, changeId: string): Promise<boolean> {
		const found = this.#sessionAt(sessionId);
		if (!found) return false;
		const target = found.session.changes.find((item) => item.id === changeId);
		const groupKey = target?.optionGroupKey ?? null;
		const pickKey = groupKey ? optionGroupId(sessionId, groupKey) : null;
		const finalizeLocalState = (): void => {
			this.store.set((state) => {
				const hiddenChanges = { ...state.hiddenChanges };
				delete hiddenChanges[changeId];
				const optionPick = { ...state.optionPick };
				if (pickKey) delete optionPick[pickKey];
				return {
					hiddenChanges,
					optionPick,
					...(state.mode === "live" || state.mode === "report"
						? { mode: "preview" as const, activeReportSlug: undefined }
						: {}),
				};
			});
		};
		if (this.isLocalInteractive && isLocalSurfaceId(found.workspace.surface.id)) {
			if (!target || !isOpenChange(target)) return false;
			const now = new Date().toISOString();
			const changes = found.session.changes.map((change) => {
				if (change.id === changeId) {
					return { ...change, optionGroupKey: null, optionGroupTitle: null };
				}
				if (groupKey && change.optionGroupKey === groupKey && isOpenChange(change)) {
					return { ...change, status: "discarded" as const, resolvedAt: now };
				}
				return change;
			});
			const updated: SurfaceSession = {
				...found.session,
				changes,
				openChangeCount: countOpenSurfaceChanges(changes),
				messages: [
					...found.session.messages,
					{
						id: `local-message-${++this.#localSeq}`,
						sessionId,
						authorKind: "system",
						text: t("Selected option: {title}", { title: target.title }),
						changeId,
						createdAt: now,
					},
				],
				updatedAt: now,
			};
			finalizeLocalState();
			this.#applySession(updated, "open");
			return true;
		}
		const busyKey = pickKey ? `option-group:${pickKey}` : `change:${changeId}`;
		const droppedIds = new Set(
			found.session.changes
				.filter(
					(change) =>
						groupKey && change.optionGroupKey === groupKey && change.id !== changeId && isOpenChange(change),
				)
				.map((change) => change.id),
		);
		const updated = await this.#run(busyKey, (client) => client.chooseSurfaceChangeOption(changeId));
		if (!updated) return false;
		const hasDependents =
			droppedIds.size > 0 &&
			Boolean(
				this.workspace(updated.surfaceId)?.activeSessions.some((session) =>
					session.changes.some(
						(change) =>
							!droppedIds.has(change.id) &&
							isOpenChange(change) &&
							(change.previewBaseChangeIds?.some((id) => droppedIds.has(id)) ?? false),
					),
				),
			);
		finalizeLocalState();
		this.#applySession(updated, "open");
		await this.#syncPreview(found.workspace.surface.id);
		if (hasDependents) void this.refreshWorkspace(updated.surfaceId);
		void this.refreshSurfaces();
		return true;
	}

	async discardOptionGroup(sessionId: string, optionGroupKey: string): Promise<boolean> {
		const found = this.#sessionAt(sessionId);
		if (!found) return false;
		const pickKey = optionGroupId(sessionId, optionGroupKey);
		const clearPick = (): void => {
			this.store.set((state) => {
				if (!Object.hasOwn(state.optionPick, pickKey)) return {};
				const optionPick = { ...state.optionPick };
				delete optionPick[pickKey];
				return { optionPick };
			});
		};
		if (this.isLocalInteractive && isLocalSurfaceId(found.workspace.surface.id)) {
			const drawerOpen = this.drawerOpenOn(sessionId);
			const now = new Date().toISOString();
			const dropped = found.session.changes.filter(
				(change) => change.optionGroupKey === optionGroupKey && isOpenChange(change),
			);
			const changes = found.session.changes.map((change) =>
				change.optionGroupKey === optionGroupKey && isOpenChange(change)
					? { ...change, status: "discarded" as const, resolvedAt: now }
					: change,
			);
			const openCount = countOpenSurfaceChanges(changes);
			const hasMerged = changes.some((change) => change.status === "merged");
			const stillRunning = isRunningSession(found.session);
			const allDiscarded = !stillRunning && openCount === 0 && !hasMerged;
			const closes = !stillRunning && openCount === 0 && !drawerOpen;
			const updated: SurfaceSession = {
				...found.session,
				state: stillRunning ? found.session.state : allDiscarded ? "discarded" : closes ? "completed" : "ready",
				hasActiveChat: stillRunning ? found.session.hasActiveChat : !allDiscarded && drawerOpen,
				changes,
				openChangeCount: openCount,
				messages:
					dropped.length > 0
						? [
								...found.session.messages,
								{
									id: `local-message-${++this.#localSeq}`,
									sessionId,
									authorKind: "system",
									text:
										dropped.length === 1
											? t("Discarded option “{title}”", { title: dropped[0]!.title })
											: t("Discarded options: {titles}", { titles: dropped.map((c) => c.title).join(", ") }),
									changeId: dropped.length === 1 ? dropped[0]!.id : null,
									createdAt: now,
								},
							]
						: found.session.messages,
				updatedAt: now,
				closedAt: allDiscarded || closes ? now : null,
			};
			clearPick();
			const outcome: ApprovalOutcome = stillRunning
				? "open"
				: allDiscarded
					? "history"
					: approvalOutcome(updated, drawerOpen);
			if (outcome === "history" && this.drawerOpenOn(sessionId)) this.store.set({ drawer: undefined });
			this.#applySession(updated, outcome);
			return true;
		}
		const droppedIds = new Set(
			found.session.changes
				.filter((change) => change.optionGroupKey === optionGroupKey && isOpenChange(change))
				.map((change) => change.id),
		);
		const updated = await this.#run(`option-group:${pickKey}`, (client) =>
			client.discardSurfaceOptionGroup(sessionId, optionGroupKey),
		);
		if (!updated) return false;
		clearPick();
		const openCount = countOpenSurfaceChanges(updated.changes);
		const hasMerged = updated.changes.some((change) => change.status === "merged");
		const outcome: ApprovalOutcome = isRunningSession(updated)
			? "open"
			: openCount === 0 && !hasMerged
				? "history"
				: approvalOutcome(updated, this.drawerOpenOn(sessionId));
		if (outcome === "history" && this.drawerOpenOn(sessionId)) {
			this.store.set({ drawer: undefined });
			void this.#options.client?.setSessionChatOpen(sessionId, false).catch(() => undefined);
		}
		const hasDependents =
			droppedIds.size > 0 &&
			Boolean(
				this.workspace(updated.surfaceId)?.activeSessions.some((session) =>
					session.changes.some(
						(change) =>
							!droppedIds.has(change.id) &&
							isOpenChange(change) &&
							(change.previewBaseChangeIds?.some((id) => droppedIds.has(id)) ?? false),
					),
				),
			);
		this.#applySession(updated, outcome);
		await this.#syncPreview(found.workspace.surface.id);
		if (hasDependents) void this.refreshWorkspace(updated.surfaceId);
		void this.refreshSurfaces();
		return true;
	}

	canEnsureReconciliation(surfaceId: string): boolean {
		return !isLocalSurfaceId(surfaceId) && Boolean(this.#options.client?.ensureSurfaceReconciliation);
	}

	reconciliationFor(surfaceId: string, changeIds: readonly string[]): SurfaceReconciliation | undefined {
		const workspace = this.workspace(surfaceId);
		return findMatchingStudioReconciliation(workspace?.reconciliations, changeIds) ?? undefined;
	}

	lineageReconciliationTarget(
		surfaceId: string,
		selectedChangeIds: readonly string[],
	): LineageReconciliationTarget | null {
		const workspace = this.workspace(surfaceId);
		if (!workspace || selectedChangeIds.length === 0) return null;
		const openChanges: SurfaceChangeUnit[] = [];
		for (const session of workspace.activeSessions) {
			for (const change of session.changes) {
				if (isOpenChange(change)) openChanges.push(change);
			}
		}
		return detectLineageReconciliationTarget(openChanges, selectedChangeIds, workspace.surface.folderRoot);
	}

	activeReconciliationFor(surfaceId: string, selectedChangeIds: readonly string[]): SurfaceReconciliation | undefined {
		const workspace = this.workspace(surfaceId);
		const recs = workspace?.reconciliations;
		if (!workspace || !recs || recs.length === 0 || selectedChangeIds.length === 0) return undefined;
		const exact = findMatchingStudioReconciliation(recs, selectedChangeIds);
		if (exact) return exact;
		const activeSet = new Set(selectedChangeIds);
		const basesById = new Map<string, readonly string[]>();
		for (const session of workspace.activeSessions) {
			for (const change of session.changes) {
				if (change.previewBaseChangeIds && change.previewBaseChangeIds.length > 0) {
					basesById.set(change.id, change.previewBaseChangeIds);
				}
			}
		}
		const matching = recs
			.filter((rec) => {
				if (rec.selectedChangeIds.length === 0 || !rec.selectedChangeIds.every((id) => activeSet.has(id))) {
					return false;
				}
				const covered = new Set(rec.selectedChangeIds);
				for (const id of rec.selectedChangeIds) {
					if (basesById.get(id)?.some((baseId) => activeSet.has(baseId) && !covered.has(baseId))) {
						return false;
					}
				}
				return true;
			})
			.sort((a, b) => b.selectedChangeIds.length - a.selectedChangeIds.length);
		return matching[0];
	}

	visiblePreviewChangeIds(surfaceId: string): string[] {
		const ids: string[] = [];
		for (const session of this.activePreviewSessions(surfaceId)) {
			for (const change of session.changes) {
				if (isOpenChange(change) && this.isChangeShown(change.id)) ids.push(change.id);
			}
		}
		return ids;
	}

	shownPreviewChangeCount(surfaceId: string): number {
		const surface = this.workspace(surfaceId)?.surface;
		const builtByCloud =
			this.state.source === "cloud" &&
			!isLocalSurfaceId(surfaceId) &&
			surface?.archetype === "live_build" &&
			surface.sourceKind === "code_repo";
		if (!builtByCloud) return this.visiblePreviewChangeIds(surfaceId).length;
		const { toggledChangeIds, explorationSessionId } = this.previewSelection(surfaceId);
		const variant = explorationSessionId
			? this.workspace(surfaceId)?.activeSessions.find((session) => session.id === explorationSessionId)
			: undefined;
		return toggledChangeIds.length + (variant?.changes.filter(isOpenChange).length ?? 0);
	}

	#reconciliationRequestKey(surfaceId: string, changeIds: readonly string[]): string | null {
		const ids = [...new Set(changeIds.filter(Boolean))];
		if (!ids.length) return null;
		const workspace = this.workspace(surfaceId);
		const revision = workspace?.surface.folderRevision ?? 0;
		const head = workspace?.surface.liveHeadSha ?? "";
		return `${surfaceId}:${revision}:${head}:${ids.sort().join(",")}`;
	}

	#clearReconciliationRequest(key: string): void {
		if (!(key in this.state.reconciliationRequests)) return;
		this.store.set((state) => {
			if (!(key in state.reconciliationRequests)) return {};
			const next = { ...state.reconciliationRequests };
			delete next[key];
			return { reconciliationRequests: next };
		});
	}

	reconciliationRequestState(surfaceId: string, changeIds: readonly string[]): "pending" | "failed" | undefined {
		const key = this.#reconciliationRequestKey(surfaceId, changeIds);
		return key ? this.state.reconciliationRequests[key] : undefined;
	}

	async ensureReconciliation(
		surfaceId: string,
		changeIds: readonly string[],
		conflictPaths: readonly string[] = [],
		retry = false,
	): Promise<SurfaceReconciliation | undefined> {
		const ids = [...new Set(changeIds.filter(Boolean))];
		if (!ids.length) return undefined;
		const client = this.#options.client;
		if (isLocalSurfaceId(surfaceId) || !client?.ensureSurfaceReconciliation) return undefined;
		const workspace = this.workspace(surfaceId);
		const existing = findMatchingStudioReconciliation(workspace?.reconciliations, ids);
		if (!retry && existing) return existing;
		const key = this.#reconciliationRequestKey(surfaceId, ids);
		if (!key) return undefined;
		if (this.state.reconciliationRequests[key] === "pending") return undefined;
		if (!retry && this.#reconciliationRequested.has(key)) return undefined;
		this.#reconciliationRequested.add(key);
		this.store.set((state) => ({
			reconciliationRequests: { ...state.reconciliationRequests, [key]: "pending" },
		}));
		try {
			const record = await client.ensureSurfaceReconciliation(surfaceId, ids, conflictPaths, retry);
			if (this.#options.signal.aborted) return record;
			this.#clearReconciliationRequest(key);
			const current = this.workspace(surfaceId);
			if (current) {
				const prior = current.reconciliations ?? [];
				const nextReconciliations = [record, ...prior.filter((item) => item.id !== record.id)];
				const flipPreview =
					retry &&
					current.surface.sourceKind === "code_repo" &&
					(current.previewState.primary.status === "failed" ||
						current.previewState.primary.status === "conflicted");
				this.#putWorkspace({
					...current,
					reconciliations: nextReconciliations,
					...(flipPreview
						? {
								previewState: {
									...current.previewState,
									primary: {
										...current.previewState.primary,
										status: "reconciling",
										conflictReport: null,
										errorDetail: null,
									},
								},
							}
						: {}),
				});
			}
			return record;
		} catch (error) {
			if (!this.#options.signal.aborted) {
				this.store.set((state) => ({
					reconciliationRequests: { ...state.reconciliationRequests, [key]: "failed" },
					...(retry ? { error: describe(error) } : {}),
				}));
			}
			return undefined;
		}
	}

	async retryPreview(surfaceId: string): Promise<void> {
		const workspace = this.workspace(surfaceId);
		const primary = workspace?.previewState.primary;
		if (
			workspace &&
			primary &&
			primary.status === "failed" &&
			primary.toggledChangeIds.length > 0 &&
			findMatchingStudioReconciliation(workspace.reconciliations, primary.toggledChangeIds)?.status === "failed" &&
			this.#options.client?.ensureSurfaceReconciliation
		) {
			await this.ensureReconciliation(surfaceId, primary.toggledChangeIds, [], true);
			return;
		}
		const timer = this.#previewSyncDebounceTimers.get(surfaceId);
		if (timer) {
			clearTimeout(timer);
			this.#previewSyncDebounceTimers.delete(surfaceId);
		}
		this.#lastPreviewSyncKey.delete(surfaceId);
		this.#previewSyncSettledBaselineKey.delete(surfaceId);
		this.#clearPreviewSyncRetry(surfaceId);
		const primaryId = primary?.previewId;
		if (primaryId) this.#previewIdSelectionKey.delete(primaryId);
		await this.#syncPreview(surfaceId);
	}

	#changeBelongsToFailedSession(changeId: string): boolean {
		for (const workspace of Object.values(this.state.workspaces)) {
			for (const session of workspace.activeSessions) {
				if (session.changes.some((item) => item.id === changeId)) return session.state === "failed";
			}
		}
		return false;
	}

	async toggleChange(surfaceId: string, changeId: string): Promise<void> {
		this.#previewSyncSettledBaselineKey.delete(surfaceId);
		this.#clearPreviewSyncRetry(surfaceId);
		const currentlyShown = this.isChangeShown(changeId);
		const failedOwner = this.#changeBelongsToFailedSession(changeId);
		this.store.set((state) => {
			const hiddenChanges = { ...state.hiddenChanges };
			if (currentlyShown) {
				if (failedOwner) delete hiddenChanges[changeId];
				else hiddenChanges[changeId] = true;
			} else if (failedOwner) {
				hiddenChanges[changeId] = false;
			} else {
				delete hiddenChanges[changeId];
			}
			return {
				hiddenChanges,
				...(state.mode === "live" || state.mode === "report"
					? { mode: "preview" as const, activeReportSlug: undefined }
					: {}),
			};
		});
		await this.#syncPreview(surfaceId, { debounceMs: PREVIEW_TOGGLE_DEBOUNCE_MS });
	}

	async pickVariant(surfaceId: string, explorationId: string, sessionId: string): Promise<void> {
		this.#previewSyncSettledBaselineKey.delete(surfaceId);
		this.#clearPreviewSyncRetry(surfaceId);
		const previousDrawer = this.state.drawer;
		const switchingDrawer = previousDrawer?.explorationId === explorationId && previousDrawer.sessionId !== sessionId;
		this.store.set((state) => ({
			variantPick: { ...state.variantPick, [explorationId]: sessionId },
			...(state.drawer?.explorationId === explorationId ? { drawer: { surfaceId, sessionId, explorationId } } : {}),
			...(state.mode === "live" || state.mode === "report"
				? { mode: "preview" as const, activeReportSlug: undefined }
				: {}),
		}));
		if (switchingDrawer && !isLocalSurfaceId(surfaceId)) {
			void this.#options.client?.setSessionChatOpen(previousDrawer.sessionId, false).catch(() => undefined);
			void this.#options.client?.setSessionChatOpen(sessionId, true).catch(() => undefined);
		}
		await this.#syncPreview(surfaceId);
	}

	askInstead(surfaceId: string, explorationId: string): void {
		this.store.set({ insteadOf: { surfaceId, explorationId } });
	}

	keepOptions(): void {
		if (this.state.insteadOf) this.store.set({ insteadOf: undefined });
	}

	insteadOf(surfaceId: string): SurfaceExplorationSet | undefined {
		const asked = this.state.insteadOf;
		if (asked?.surfaceId !== surfaceId) return undefined;
		return openExplorations(this.workspace(surfaceId)).find((item) => item.id === asked.explorationId);
	}

	pickedVariant(exploration: SurfaceExplorationSet): string | undefined {
		return this.state.variantPick[exploration.id] ?? exploration.variantSessionIds[0];
	}

	activePreviewSessions(surfaceId: string): SurfaceSession[] {
		const workspace = this.workspace(surfaceId);
		const pickedExplorationSessions = new Set(
			openExplorations(workspace)
				.map((exploration) => this.pickedVariant(exploration))
				.filter((id): id is string => Boolean(id)),
		);
		const sessions: SurfaceSession[] = [];
		for (const session of workspace?.activeSessions ?? []) {
			if (isOpenVariant(session, workspace) && !pickedExplorationSessions.has(session.id)) continue;
			sessions.push(session);
		}
		return sessions;
	}

	previewSelection(surfaceId: string): { toggledChangeIds: string[]; explorationSessionId: string | null } {
		const workspace = this.workspace(surfaceId);
		const explorations = openExplorations(workspace);
		const primaryExploration = explorations[0];
		const explorationSessionId = primaryExploration ? (this.pickedVariant(primaryExploration) ?? null) : null;
		const toggledChangeIds: string[] = [];
		for (const session of this.activePreviewSessions(surfaceId)) {
			if (explorationSessionId && session.id === explorationSessionId) continue;
			for (const change of session.changes) {
				if (isOpenChange(change) && this.isChangeShown(change.id)) toggledChangeIds.push(change.id);
			}
		}
		return { toggledChangeIds, explorationSessionId };
	}

	#previewSelectionInfo(surfaceId: string): {
		readonly selection: {
			toggledChangeIds: string[];
			explorationSessionId: string | null;
			compareSessionIds?: string[];
		};
		readonly toggledKey: string;
		readonly selectionKey: string;
		readonly hasOpenChanges: boolean;
	} {
		const baseSelection = this.previewSelection(surfaceId);
		const workspace = this.workspace(surfaceId);
		const explorations = openExplorations(workspace);
		const compareTarget =
			this.state.mode === "compare"
				? (explorations.find((item) => item.id === this.state.compareTargetId) ?? explorations[0])
				: undefined;
		const compareSessionIds =
			compareTarget && compareTarget.variantSessionIds.length >= 2
				? compareTarget.variantSessionIds.slice(0, 3)
				: [];
		const selection = compareSessionIds.length >= 2 ? { ...baseSelection, compareSessionIds } : baseSelection;
		const changeById = new Map<string, SurfaceChangeUnit>();
		for (const session of workspace?.activeSessions ?? []) {
			for (const change of session.changes) changeById.set(change.id, change);
		}
		const changeStamp = (id: string): string => {
			const ch = changeById.get(id);
			return ch ? `${id}:${ch.parentSha ?? ""}:${ch.headSha ?? ""}` : id;
		};
		const explorationSession =
			selection.explorationSessionId !== null
				? workspace?.activeSessions.find((session) => session.id === selection.explorationSessionId)
				: undefined;
		const explorationChangeStamps =
			explorationSession?.changes.filter(isOpenChange).map((change) => changeStamp(change.id)) ?? [];
		const toggledKey = [...new Set(selection.toggledChangeIds)].sort().join(",");
		const toggledStampKey = [...new Set(selection.toggledChangeIds)].sort().map(changeStamp).join(",");
		const explorationKey = [...new Set(explorationChangeStamps)].sort().join(",");
		const explorationHeadKey = explorationSession?.branchHeadSha ?? "";
		const compareKey = compareSessionIds
			.map((sid) => {
				const sess = workspace?.activeSessions.find((item) => item.id === sid);
				return `${sid}:${sess?.branchHeadSha ?? ""}`;
			})
			.join(",");
		const surfaceStamp = `${workspace?.surface.liveHeadSha ?? ""}:${workspace?.surface.unpublishedChangeCount ?? 0}`;
		return {
			selection,
			toggledKey,
			selectionKey: `${surfaceStamp}|${selection.explorationSessionId ?? ""}:${explorationHeadKey}|${toggledStampKey}|${explorationKey}|${compareKey}`,
			hasOpenChanges: toggledKey.length > 0 || explorationKey.length > 0 || compareSessionIds.length >= 2,
		};
	}

	#setPreviewSyncing(surfaceId: string, active: boolean): void {
		const current = Boolean(this.state.previewSyncing[surfaceId]);
		if (current === active || this.#options.signal.aborted) return;
		this.store.set((state) => {
			const next = { ...state.previewSyncing };
			if (active) next[surfaceId] = true;
			else delete next[surfaceId];
			return { previewSyncing: next };
		});
	}

	#clearPreviewSyncRetry(surfaceId: string, resetCount = true): void {
		const timer = this.#previewSyncRetryTimers.get(surfaceId);
		if (timer) {
			clearTimeout(timer);
			this.#previewSyncRetryTimers.delete(surfaceId);
		}
		if (resetCount) this.#previewSyncRetryCounts.delete(surfaceId);
		this.#setPreviewSyncing(
			surfaceId,
			this.#previewSyncInFlight.has(surfaceId) || this.#previewSyncDebounceTimers.has(surfaceId),
		);
	}

	#schedulePreviewSyncRetry(surfaceId: string, selectionKey: string): void {
		if (this.#options.signal.aborted) return;
		const active = surfaceId === this.#activeSurfaceId || surfaceId === this.state.drawer?.surfaceId;
		if (!active) return;
		const prev = this.#previewSyncRetryCounts.get(surfaceId);
		const attempt = prev && prev.key === selectionKey ? prev.count : 0;
		if (attempt >= PREVIEW_SYNC_RETRY_MS.length) {
			this.#clearPreviewSyncRetry(surfaceId, false);
			return;
		}
		const delayMs = PREVIEW_SYNC_RETRY_MS[attempt]!;
		this.#previewSyncRetryCounts.set(surfaceId, { key: selectionKey, count: attempt + 1 });
		const existing = this.#previewSyncRetryTimers.get(surfaceId);
		if (existing) clearTimeout(existing);
		const timer = setTimeout(() => {
			this.#previewSyncRetryTimers.delete(surfaceId);
			if (this.#options.signal.aborted) return;
			const stillActive = surfaceId === this.#activeSurfaceId || surfaceId === this.state.drawer?.surfaceId;
			if (stillActive) this.#maybeAutoSyncPreview(surfaceId);
		}, delayMs);
		this.#previewSyncRetryTimers.set(surfaceId, timer);
	}

	async #syncPreview(surfaceId: string, options?: { background?: boolean; debounceMs?: number }): Promise<void> {
		const client = this.#options.client;
		if (isLocalSurfaceId(surfaceId) || !client) return;
		const foreground = !options?.background;
		const debounceMs = options?.debounceMs ?? 0;
		const busyKey = `preview:${surfaceId}`;
		if (debounceMs > 0 && !this.#previewSyncInFlight.has(surfaceId)) {
			const existingTimer = this.#previewSyncDebounceTimers.get(surfaceId);
			if (existingTimer) clearTimeout(existingTimer);
			this.#clearPreviewSyncRetry(surfaceId, false);
			if (foreground) {
				this.#previewSyncForeground.add(surfaceId);
				if (!this.#options.signal.aborted && (!this.state.busy[busyKey] || this.state.error !== undefined)) {
					this.store.set((state) => ({ busy: { ...state.busy, [busyKey]: true }, error: undefined }));
				}
			}
			this.#setPreviewSyncing(surfaceId, true);
			await new Promise<void>((resolve) => {
				const list = this.#previewSyncDebounceWaiters.get(surfaceId);
				if (list) list.push(resolve);
				else this.#previewSyncDebounceWaiters.set(surfaceId, [resolve]);
				const timer = setTimeout(() => {
					this.#previewSyncDebounceTimers.delete(surfaceId);
					if (this.#options.signal.aborted) {
						const pending = this.#previewSyncDebounceWaiters.get(surfaceId);
						if (pending) {
							this.#previewSyncDebounceWaiters.delete(surfaceId);
							for (const done of pending) done();
						}
						return;
					}
					void this.#syncPreview(surfaceId, { background: !this.#previewSyncForeground.has(surfaceId) }).finally(
						() => {
							const pending = this.#previewSyncDebounceWaiters.get(surfaceId);
							if (pending) {
								this.#previewSyncDebounceWaiters.delete(surfaceId);
								for (const done of pending) done();
							}
						},
					);
				}, debounceMs);
				this.#previewSyncDebounceTimers.set(surfaceId, timer);
			});
			return;
		}
		const pendingTimer = this.#previewSyncDebounceTimers.get(surfaceId);
		if (pendingTimer) {
			clearTimeout(pendingTimer);
			this.#previewSyncDebounceTimers.delete(surfaceId);
		}
		this.#clearPreviewSyncRetry(surfaceId, false);
		this.#previewSyncGen.set(surfaceId, (this.#previewSyncGen.get(surfaceId) ?? 0) + 1);
		this.#previewSyncDirty.add(surfaceId);
		if (foreground) {
			this.#previewSyncForeground.add(surfaceId);
			if (!this.#options.signal.aborted && (!this.state.busy[busyKey] || this.state.error !== undefined)) {
				this.store.set((state) => ({ busy: { ...state.busy, [busyKey]: true }, error: undefined }));
			}
		}
		if (this.#previewSyncInFlight.has(surfaceId)) {
			await new Promise<void>((resolve) => {
				const list = this.#previewSyncWaiters.get(surfaceId);
				if (list) list.push(resolve);
				else this.#previewSyncWaiters.set(surfaceId, [resolve]);
			});
			return;
		}
		this.#previewSyncInFlight.add(surfaceId);
		this.#setPreviewSyncing(surfaceId, true);
		let retryKey: string | undefined;
		try {
			while (this.#previewSyncDirty.has(surfaceId) && !this.#options.signal.aborted) {
				this.#previewSyncDirty.delete(surfaceId);
				retryKey = undefined;
				const gen = this.#previewSyncGen.get(surfaceId) ?? 0;
				const info = this.#previewSelectionInfo(surfaceId);
				this.#lastPreviewSyncKey.set(surfaceId, info.selectionKey);
				const currentWorkspace = this.workspace(surfaceId);
				if (
					currentWorkspace?.surface.sourceKind === "code_repo" &&
					info.selection.explorationSessionId === null &&
					info.selection.toggledChangeIds.length > 0
				) {
					const lineageTarget = this.lineageReconciliationTarget(surfaceId, info.selection.toggledChangeIds);
					if (lineageTarget && !this.reconciliationFor(surfaceId, lineageTarget.changeIds)) {
						void this.ensureReconciliation(surfaceId, lineageTarget.changeIds, lineageTarget.conflictPaths);
					}
				}
				try {
					const previewState = await client.setPreviewSelection(surfaceId, info.selection);
					if (this.#options.signal.aborted) return;
					if ((this.#previewSyncGen.get(surfaceId) ?? 0) !== gen) continue;
					if (previewState?.primary.previewId) {
						this.#previewIdSelectionKey.set(previewState.primary.previewId, info.selectionKey);
					}
					if (previewState && (previewState.primary.status !== "live_baseline" || !info.hasOpenChanges)) {
						this.#previewSyncRetryCounts.delete(surfaceId);
						this.#previewSyncSettledBaselineKey.delete(surfaceId);
					}
					const workspace = this.workspace(surfaceId);
					if (previewState && workspace) {
						this.#putWorkspace({ ...workspace, previewState }, true, { fromPreviewSync: true });
					}
				} catch (error) {
					if (this.#lastPreviewSyncKey.get(surfaceId) === info.selectionKey) {
						this.#lastPreviewSyncKey.delete(surfaceId);
					}
					if (
						!this.#options.signal.aborted &&
						this.#previewSyncForeground.has(surfaceId) &&
						!this.#previewSyncDirty.has(surfaceId)
					) {
						this.store.set({
							error: isMissingSurfaceRpcError(error) ? this.#options.unavailableMessage : describe(error),
						});
					} else if (!this.#options.signal.aborted && !this.#previewSyncDirty.has(surfaceId)) {
						retryKey = info.selectionKey;
					}
					if (!this.#previewSyncDirty.has(surfaceId)) break;
				}
			}
		} finally {
			this.#previewSyncInFlight.delete(surfaceId);
			const wasForeground = this.#previewSyncForeground.delete(surfaceId);
			if (!this.#options.signal.aborted && this.state.busy[busyKey]) {
				this.store.set((state) => {
					const busy = { ...state.busy };
					delete busy[busyKey];
					return { busy };
				});
			}
			this.#setPreviewSyncing(surfaceId, this.#previewSyncDebounceTimers.has(surfaceId));
			if (retryKey && !wasForeground && !this.#previewSyncDirty.has(surfaceId)) {
				this.#schedulePreviewSyncRetry(surfaceId, retryKey);
			}
			const waiters = this.#previewSyncWaiters.get(surfaceId);
			if (waiters) {
				this.#previewSyncWaiters.delete(surfaceId);
				for (const resolve of waiters) resolve();
			}
			const debouncedWaiters = this.#previewSyncDebounceWaiters.get(surfaceId);
			if (debouncedWaiters && !this.#previewSyncDebounceTimers.has(surfaceId)) {
				this.#previewSyncDebounceWaiters.delete(surfaceId);
				for (const resolve of debouncedWaiters) resolve();
			}
		}
	}

	async publish(surfaceId: string, options: QuietCall = {}): Promise<boolean> {
		const pendingIds = unpublishedChanges(this.state, surfaceId).map((entry) => entry.change.id);
		const markPublished = () => {
			if (!pendingIds.length) return;
			this.store.set((state) => {
				const publishedChangeIds = { ...state.publishedChangeIds };
				for (const id of pendingIds) publishedChangeIds[id] = true;
				return { publishedChangeIds };
			});
		};
		if (this.isLocalInteractive && isLocalSurfaceId(surfaceId)) {
			const surface = this.state.surfaces.find((item) => item.id === surfaceId);
			if (!surface) return false;
			markPublished();
			this.#putSurface({ ...surface, hasUnpublishedChanges: false, unpublishedChangeCount: 0 });
			return true;
		}
		const surface = await this.#run(
			`publish:${surfaceId}`,
			(client) => client.publishSurface(surfaceId),
			options.quiet,
		);
		if (!surface) return false;
		// WHY: Defer marking changes published until async code_repo publish jobs finish transitioning back to idle.
		if (surface.publishStatus === "publishing") {
			this.#pendingPublishChanges.set(surfaceId, pendingIds);
		} else if (surface.publishStatus !== "failed") {
			markPublished();
		}
		this.#putSurface(surface);
		if (
			this.state.source === "cloud" &&
			!isLocalSurfaceId(surface.id) &&
			this.#options.loadCloudFiles &&
			(surface.sourceKind === "folder" || surface.archetype === "studio")
		) {
			void this.refreshCloudFiles(surface, { visible: true });
		}
		return true;
	}

	askToPublish(surfaceId: string, userId: string): Promise<boolean> {
		return this.#publishAsk(surfaceId, (client) => client.askSurfacePublish?.(surfaceId, userId));
	}

	declinePublishAsk(surfaceId: string): Promise<boolean> {
		return this.#publishAsk(surfaceId, (client) => client.declineSurfacePublishAsk?.(surfaceId));
	}

	withdrawPublishAsk(surfaceId: string): Promise<boolean> {
		return this.#publishAsk(surfaceId, (client) => client.withdrawSurfacePublishAsk?.(surfaceId));
	}

	async #publishAsk(
		surfaceId: string,
		call: (client: SurfacesClient) => Promise<SurfaceSummary> | undefined,
	): Promise<boolean> {
		const surface = await this.#run(`publish-ask:${surfaceId}`, async (client) => {
			const pending = call(client);
			if (!pending) throw new Error(this.#options.unavailableMessage);
			return await pending;
		});
		if (!surface) return false;
		this.#putSurface(surface);
		return true;
	}

	async setAutoPublish(surfaceId: string, enabled: boolean, options: QuietCall = {}): Promise<boolean> {
		if (this.isLocalInteractive && isLocalSurfaceId(surfaceId)) {
			const surface = this.state.surfaces.find((item) => item.id === surfaceId);
			if (!surface) return false;
			this.#putSurface({ ...surface, autoPublish: enabled });
			return true;
		}
		const surface = await this.#run(
			`auto:${surfaceId}`,
			(client) => client.setSurfaceAutoPublish(surfaceId, enabled),
			options.quiet,
		);
		if (!surface) return false;
		this.#putSurface(surface);
		return true;
	}

	async setFigure(surfaceId: string, figure: SurfaceFigureId): Promise<boolean> {
		const current = this.state.surfaces.find((item) => item.id === surfaceId);
		if (!current) return false;
		if (this.isLocalInteractive && isLocalSurfaceId(surfaceId)) {
			this.#putSurface({ ...current, icon: surfaceFigureIcon(figure) });
			return true;
		}
		const surface = await this.#run(`figure:${surfaceId}`, (client) => client.setSurfaceFigure!(surfaceId, figure));
		if (!surface) return false;
		this.#putSurface(surface);
		return true;
	}

	noteSiteSlug(surfaceId: string, slug: string, url: string): void {
		const current = this.state.surfaces.find((item) => item.id === surfaceId);
		if (!current) return;
		if (current.siteSlug !== slug || current.liveUrl !== url) {
			this.#putSurface({ ...current, siteSlug: slug, liveUrl: url });
		}
		if (this.state.source === "cloud" && this.state.workspaces[surfaceId] && !isLocalSurfaceId(surfaceId)) {
			void this.refreshWorkspace(surfaceId, 0, { background: false });
		}
	}

	#putSurface(surface: SurfaceSummary): void {
		this.#surfacesMutationEpoch += 1;
		this.#reconcilePendingPublish(surface);
		this.store.set((state) => {
			const workspace = state.workspaces[surface.id];
			const nextSurfaces = sortSurfaces(state.surfaces.map((item) => (item.id === surface.id ? surface : item)));
			return {
				surfaces: nextSurfaces,
				workspaces: workspace ? { ...state.workspaces, [surface.id]: { ...workspace, surface } } : state.workspaces,
			};
		});
		this.#syncPolling();
	}

	async refreshSurfaces(): Promise<void> {
		const client = this.#options.client;
		if (!client || this.state.source !== "cloud" || this.#suspended) return;
		const reqId = ++this.#surfacesReqSeq;
		const startEpoch = this.#surfacesMutationEpoch;
		const signal = this.#visitAbort.signal;
		try {
			const surfaces = await client.listSurfaces(this.#options.companyId, signal);
			if (
				!this.#options.signal.aborted &&
				!signal.aborted &&
				!this.#suspended &&
				reqId === this.#surfacesReqSeq &&
				startEpoch === this.#surfacesMutationEpoch &&
				surfaces.length
			) {
				const prevById = new Map(this.state.surfaces.map((surface) => [surface.id, surface]));
				const next = sortSurfaces(surfaces);
				if (
					this.state.surfaces.length !== next.length ||
					JSON.stringify(this.state.surfaces) !== JSON.stringify(next)
				) {
					this.store.set({ surfaces: next });
				}
				const identity = findIdentitySurface(this.state);
				if (identity && prevById.get(identity.id)?.status !== "active" && !isLocalSurfaceId(identity.id)) {
					if (!this.state.cloudSurfaceFiles[identity.id]) void this.refreshCloudFiles(identity);
					if (identity.activeSessionCount > 0 && !this.state.workspaces[identity.id]) {
						this.hydrateWorkspace(identity.id);
					}
				}
				for (const surface of next) {
					if (surface.status !== "active" || isLocalSurfaceId(surface.id)) continue;
					const prev = prevById.get(surface.id);
					const workspace = this.state.workspaces[surface.id];
					const changed = surfaceCountsChanged(prev, surface);
					if (changed) this.#hydratedAttempted.delete(surface.id);
					if (
						workspace &&
						!this.#inFlightWorkspaceRefreshes.has(surface.id) &&
						(changed || (surface.activeSessionCount === 0 && workspace.activeSessions.length > 0))
					) {
						const foreground =
							surface.id === this.#activeSurfaceId || surface.id === this.state.drawer?.surfaceId;
						void this.refreshWorkspace(surface.id, 0, { background: !foreground });
					}
				}
			}
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

	async offerAutomation(automationId: string, toUserId: string): Promise<boolean> {
		return this.#ownAutomation(automationId, (client) => client.offerAutomation?.(automationId, toUserId));
	}

	async answerAutomationOffer(automationId: string, offerId: string, yes: boolean): Promise<boolean> {
		return this.#ownAutomation(automationId, (client) => client.answerAutomationOffer?.(offerId, yes));
	}

	async #ownAutomation(
		automationId: string,
		call: (client: SurfacesClient) => Promise<SurfaceAutomationSummary> | undefined,
	): Promise<boolean> {
		const updated = await this.#run(`automation:${automationId}`, async (client) => call(client));
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
						...LOCAL_AUTOMATION_OWNER,
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
		this.#surfacesMutationEpoch += 1;
		const migration = this.state.migration;
		if (surfaces.length) this.#fallbackAfterLoadError = false;
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

function surfaceCountsChanged(prev: SurfaceSummary | undefined, next: SurfaceSummary): boolean {
	if (!prev) return false;
	return (
		prev.activeSessionCount !== next.activeSessionCount ||
		prev.runningSessionCount !== next.runningSessionCount ||
		prev.pendingChangeCount !== next.pendingChangeCount ||
		prev.needsAttentionCount !== next.needsAttentionCount ||
		prev.siteSlug !== next.siteSlug ||
		prev.liveUrl !== next.liveUrl
	);
}

function sortSurfaces(surfaces: readonly SurfaceSummary[]): SurfaceSummary[] {
	return (
		surfaces
			// WHY: The cloud lists the retired Members surface until migration 20260930869000 archives it.
			.filter((surface) => surface.status !== "archived" && surface.kind !== "members")
			.sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title))
	);
}

const registry = new WeakMap<object, SurfacesStore>();

export function attachSurfaces(owner: object, store: SurfacesStore): void {
	registry.set(owner, store);
}

export function surfacesStoreOf(owner: object): SurfacesStore | undefined {
	return registry.get(owner);
}

export function surfacesOf(owner: object): SurfacesStore | undefined {
	const store = registry.get(owner);
	if (!store) return undefined;
	const source = store.state.source;
	if (source === "loading" || source === "disabled") return undefined;
	return store;
}

export function surfacesDisabledOf(owner: object): boolean {
	return registry.get(owner)?.state.source === "disabled";
}
