import {
	type ApplySurfaceMigrationInput,
	type CloudSurfacesClient,
	isMissingSurfaceRpcError,
	type StartSurfaceSessionOptions,
} from "@qorpera/cloud-client/surfaces";
import {
	countOpenSurfaceChanges,
	nextSurfaceSessionLifecycleState,
	OPEN_SURFACE_CHANGE_STATUSES,
	RUNNING_SURFACE_SESSION_STATES,
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

export type SurfacesClient = Pick<
	CloudSurfacesClient,
	| "listSurfaces"
	| "getSurfaceWorkspace"
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

export interface SurfaceUndo {
	readonly id: number;
	readonly label: string;
	readonly changeIds: readonly string[];
}

export interface SurfaceNote {
	readonly id: number;
	readonly sessionId: string;
	readonly text: string;
	readonly at: string;
	readonly priorMatches: number;
}

export interface SurfacesState {
	readonly source: SurfacesSource;
	readonly surfaces: readonly SurfaceSummary[];
	readonly workspaces: Readonly<Record<string, SurfaceWorkspace>>;
	readonly automations: readonly SurfaceAutomationSummary[];
	readonly migration?: SurfaceMigrationChecklist;
	readonly migrationDismissed: boolean;
	readonly drawer?: { readonly surfaceId: string; readonly sessionId: string };
	readonly mode: SurfacePreviewMode;
	readonly device: SurfaceDevice;
	readonly hiddenChanges: Readonly<Record<string, true>>;
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

export function openExplorations(workspace: SurfaceWorkspace | undefined): SurfaceExplorationSet[] {
	return workspace?.explorations.filter((set) => set.status === "open") ?? [];
}

export function surfaceBySlug(state: Pick<SurfacesState, "surfaces">, slug: string): SurfaceSummary | undefined {
	return state.surfaces.find((surface) => surface.slug === slug);
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
	readonly client: SurfacesClient | undefined;
	readonly synthesize: () => SurfaceSynthesisInput;
	readonly migration: () => SurfaceMigrationInput;
	readonly signal: AbortSignal;
	readonly unavailableMessage: string;
}

export class SurfacesStore {
	readonly store: Store<SurfacesState>;
	readonly #options: SurfacesStoreOptions;
	#undoTimer: ReturnType<typeof setTimeout> | undefined;
	#pollTimer: ReturnType<typeof setInterval> | undefined;
	#undoSeq = 0;
	#noteSeq = 0;
	#loaded: Promise<void> | undefined;

	constructor(options: SurfacesStoreOptions) {
		this.#options = options;
		this.store = new Store<SurfacesState>({
			source: "loading",
			surfaces: [],
			workspaces: {},
			automations: [],
			migrationDismissed: false,
			mode: "preview",
			device: "desktop",
			hiddenChanges: {},
			variantPick: {},
			historyOpen: false,
			collapsed: {},
			notes: [],
			busy: {},
		});
		options.signal.addEventListener("abort", () => this.dispose(), { once: true });
	}

	get state(): SurfacesState {
		return this.store.get();
	}

	dispose(): void {
		if (this.#undoTimer) clearTimeout(this.#undoTimer);
		if (this.#pollTimer) clearInterval(this.#pollTimer);
		this.#undoTimer = undefined;
		this.#pollTimer = undefined;
		this.store.dispose();
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
		this.store.set({
			source: "local",
			surfaces: synthesizeSurfaces(this.#options.synthesize()),
			migration: synthesizeMigration(this.#options.migration()),
			...(error ? { error } : {}),
		});
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
		const surfaces = synthesizeSurfaces(this.#options.synthesize());
		if (JSON.stringify(surfaces) !== JSON.stringify(this.state.surfaces)) this.store.set({ surfaces });
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
		if (running && !this.#pollTimer && this.#options.client) {
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
		return this.state.source === "cloud" && !isLocalSurfaceId(surface.id) && Boolean(this.#options.client);
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

	async startSession(
		surfaceId: string,
		prompt: string,
		options: StartSurfaceSessionOptions = {},
	): Promise<SurfaceSession | undefined> {
		const text = prompt.trim();
		if (!text) return undefined;
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

	#applySession(session: SurfaceSession, outcome: ApprovalOutcome): void {
		const workspace = this.state.workspaces[session.surfaceId];
		if (!workspace) return;
		this.#putWorkspace(replaceSession(workspace, session, outcome));
		if (outcome === "history" && this.state.drawer?.sessionId === session.id) this.store.set({ drawer: undefined });
	}

	#offerUndo(label: string, changeIds: readonly string[]): void {
		if (this.#undoTimer) clearTimeout(this.#undoTimer);
		const id = ++this.#undoSeq;
		this.store.set({ undo: { id, label, changeIds } });
		this.#undoTimer = setTimeout(() => {
			if (this.state.undo?.id === id) this.store.set({ undo: undefined });
		}, SURFACE_UNDO_MS);
	}

	drawerOpenOn(sessionId: string): boolean {
		return this.state.drawer?.sessionId === sessionId;
	}

	async approveChange(sessionId: string, changeId: string): Promise<ApprovalOutcome | undefined> {
		const drawerOpen = this.drawerOpenOn(sessionId);
		const updated = await this.#run(`change:${changeId}`, (client) => client.approveSurfaceChange(changeId));
		if (!updated) return undefined;
		const outcome = approvalOutcome(updated, drawerOpen);
		this.#applySession(updated, outcome);
		const change = updated.changes.find((item) => item.id === changeId);
		this.#offerUndo(change?.title ?? updated.title, [changeId]);
		void this.refreshSurfaces();
		return outcome;
	}

	async approveAll(sessionId: string): Promise<boolean> {
		const before = this.session(sessionId);
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
		this.#offerUndo(updated.title, merged);
		void this.refreshSurfaces();
		return true;
	}

	async discardSession(sessionId: string): Promise<boolean> {
		const session = this.session(sessionId);
		if (!session) return false;
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
		let restored: SurfaceSession | undefined;
		for (const change of session.changes.filter((item) => item.status === "merged" && item.canUndo)) {
			const next = await this.#run(`undo:${change.id}`, (client) => client.undoSurfaceChange(change.id));
			if (!next) return false;
			restored = next;
		}
		if (restored) this.#applySession(restored, approvalOutcome(restored, false));
		void this.refreshSurfaces();
		return Boolean(restored);
	}

	async chooseVariant(exploration: SurfaceExplorationSet, sessionId: string): Promise<boolean> {
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
		const surface = await this.#run(`publish:${surfaceId}`, (client) => client.publishSurface(surfaceId));
		if (!surface) return false;
		this.#putSurface(surface);
		return true;
	}

	async setAutoPublish(surfaceId: string, enabled: boolean): Promise<boolean> {
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
			return {
				surfaces: state.surfaces.map((item) => (item.id === surface.id ? surface : item)),
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
