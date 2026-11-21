import {
	isUuid,
	parseBoundedText,
	parseInteger,
	parseRecord,
	parseTimestamp,
	parseUuid,
	WireValueError,
} from "./wire-values.ts";

export const SURFACE_SCHEMA_VERSION = "qorpera.surface/v1";
export const SURFACE_ORDER_SCHEMA_VERSION = "qorpera.surface-order/v1";
export const AUTOMATION_SCHEMA_VERSION = "qorpera.automation/v1";

export const SURFACE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SURFACE_MAX_TITLE_CHARS = 80;
export const SURFACE_MAX_PROMPT_CHARS = 16_000;
export const SURFACE_MAX_CHANGE_TITLE_CHARS = 160;
export const SURFACE_MAX_CHANGE_SUMMARY_CHARS = 2_000;
export const SURFACE_MAX_COMPARE_VARIANTS = 3;
// WHY: Each coding VM stays responsive around 6 concurrent turns; overflow spins up another machine rather than capping total sessions.
export const SURFACE_DEFAULT_MACHINE_TURN_DENSITY = 6;

export const SURFACE_GROUPS = ["products", "operations"] as const;
export type SurfaceGroup = (typeof SURFACE_GROUPS)[number];

export const SURFACE_ARCHETYPES = ["live_build", "studio", "ops"] as const;
export type SurfaceArchetype = (typeof SURFACE_ARCHETYPES)[number];

export const SURFACE_STATUSES = ["proposed", "active", "archived"] as const;
export type SurfaceStatus = (typeof SURFACE_STATUSES)[number];

export const SURFACE_SOURCE_KINDS = ["code_repo", "folder", "native_ops"] as const;
export type SurfaceSourceKind = (typeof SURFACE_SOURCE_KINDS)[number];

export const SURFACE_PREVIEW_MODES = ["static_site", "app_proxy", "studio_overlay", "none"] as const;
export type SurfacePreviewMode = (typeof SURFACE_PREVIEW_MODES)[number];

export const SURFACE_SESSION_STATES = [
	"queued",
	"running",
	"needs_input",
	"ready",
	"reconciling",
	"completed",
	"discarded",
	"failed",
] as const;
export type SurfaceSessionState = (typeof SURFACE_SESSION_STATES)[number];

export const SURFACE_SESSION_ORIGIN_KINDS = [
	"member",
	"cofounder",
	"automation",
	"point_to_change",
	"cross_surface",
] as const;
export type SurfaceSessionOriginKind = (typeof SURFACE_SESSION_ORIGIN_KINDS)[number];

export const SURFACE_CHANGE_KINDS = ["git_range", "folder_patch", "ops_action"] as const;
export type SurfaceChangeKind = (typeof SURFACE_CHANGE_KINDS)[number];

export const SURFACE_CHANGE_STATUSES = ["staged", "merging", "merged", "conflicted", "discarded", "reverted"] as const;
export type SurfaceChangeStatus = (typeof SURFACE_CHANGE_STATUSES)[number];

export const SURFACE_EXPLORATION_STATUSES = ["open", "chosen", "discarded"] as const;
export type SurfaceExplorationStatus = (typeof SURFACE_EXPLORATION_STATUSES)[number];

export const SURFACE_PREVIEW_STATUSES = [
	"live_baseline",
	"composing",
	"building",
	"ready",
	"conflicted",
	"failed",
] as const;
export type SurfacePreviewStatus = (typeof SURFACE_PREVIEW_STATUSES)[number];

export const SURFACE_AUTOMATION_OUTPUT_MODES = ["surface_session", "decision_card", "silent_note"] as const;
export type SurfaceAutomationOutputMode = (typeof SURFACE_AUTOMATION_OUTPUT_MODES)[number];

export const SURFACE_AUTOMATION_STATUSES = ["idle", "running", "needs_attention", "paused"] as const;
export type SurfaceAutomationStatus = (typeof SURFACE_AUTOMATION_STATUSES)[number];

export const SURFACE_SESSION_MESSAGE_AUTHORS = ["member", "session", "system"] as const;
export type SurfaceSessionMessageAuthor = (typeof SURFACE_SESSION_MESSAGE_AUTHORS)[number];

export const SURFACE_INSPECTOR_MODE_MESSAGE = "qorpera-inspector-mode";
export const SURFACE_INSPECTOR_PICK_MESSAGE = "qorpera-inspector-pick";
export const SURFACE_SITE_DOOR_ACTION_PATTERN =
	/^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*(?:--p[a-z0-9]{8})?\.qorpera\.com\/__qorpera\/member$/;

export interface SurfaceSessionMessage {
	readonly id: string;
	readonly sessionId: string;
	readonly authorKind: SurfaceSessionMessageAuthor;
	readonly text: string;
	readonly changeId: string | null;
	readonly createdAt: string;
}

export interface SurfaceSummary {
	readonly id: string;
	readonly slug: string;
	readonly title: string;
	readonly group: SurfaceGroup;
	readonly archetype: SurfaceArchetype;
	readonly status: SurfaceStatus;
	readonly icon: string;
	readonly sourceKind: SurfaceSourceKind;
	readonly repositoryKey: string | null;
	readonly folderRoot: string | null;
	readonly siteSlug: string | null;
	readonly previewMode: SurfacePreviewMode;
	readonly autoPublish: boolean;
	readonly liveUrl: string | null;
	readonly hasUnpublishedChanges: boolean;
	readonly unpublishedChangeCount: number;
	readonly activeSessionCount: number;
	readonly runningSessionCount: number;
	readonly pendingChangeCount: number;
	readonly needsAttentionCount: number;
	readonly sortOrder: number;
}

export interface SurfaceChangeDiffStats {
	readonly filesChanged: number;
	readonly additions: number;
	readonly deletions: number;
}

export interface SurfaceChangeUnit {
	readonly id: string;
	readonly sessionId: string;
	readonly surfaceId: string;
	readonly seq: number;
	readonly title: string;
	readonly summary: string;
	readonly kind: SurfaceChangeKind;
	readonly status: SurfaceChangeStatus;
	readonly parentSha: string | null;
	readonly headSha: string | null;
	readonly dependsOnChangeIds: readonly string[];
	readonly affectedPaths: readonly string[];
	readonly diffStats: SurfaceChangeDiffStats | null;
	readonly conflictPaths: readonly string[] | null;
	readonly landedChangeNumber: number | null;
	readonly canUndo: boolean;
	readonly createdAt: string;
	readonly resolvedAt: string | null;
}

export interface SurfaceSessionQuestion {
	readonly text: string;
	readonly options: readonly string[];
}

export interface SurfaceSession {
	readonly id: string;
	readonly surfaceId: string;
	readonly workerId: string | null;
	readonly title: string;
	readonly prompt: string;
	readonly state: SurfaceSessionState;
	readonly originKind: SurfaceSessionOriginKind;
	readonly originLabel: string | null;
	readonly explorationId: string | null;
	readonly explorationVariantLabel: string | null;
	readonly hasActiveChat: boolean;
	readonly question: SurfaceSessionQuestion | null;
	readonly changes: readonly SurfaceChangeUnit[];
	readonly messages: readonly SurfaceSessionMessage[];
	readonly openChangeCount: number;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly closedAt: string | null;
}

export interface SurfaceExplorationSet {
	readonly id: string;
	readonly surfaceId: string;
	readonly title: string;
	readonly status: SurfaceExplorationStatus;
	readonly chosenSessionId: string | null;
	readonly variantSessionIds: readonly string[];
	readonly createdAt: string;
	readonly resolvedAt: string | null;
}

export interface PointToChangeTarget {
	readonly route: string;
	readonly selector: string;
	readonly textSnippet: string;
	readonly tagName: string;
	readonly componentHint: string | null;
	readonly boundingBox: {
		readonly x: number;
		readonly y: number;
		readonly width: number;
		readonly height: number;
	};
	readonly viewport: {
		readonly width: number;
		readonly height: number;
	};
}

export interface SurfacePreviewConflict {
	readonly changeIds: readonly string[];
	readonly paths: readonly string[];
}

export interface SurfacePreviewFrameState {
	readonly previewId: string | null;
	readonly status: SurfacePreviewStatus;
	readonly doorActionUrl: string | null;
	readonly memberPass: string | null;
	readonly activeRoute: string;
	readonly toggledChangeIds: readonly string[];
	readonly conflictReport: SurfacePreviewConflict | null;
	readonly errorDetail: string | null;
}

export interface SurfacePreviewCompositionState {
	readonly surfaceId: string;
	readonly mode: "single" | "compare";
	readonly primary: SurfacePreviewFrameState;
	readonly compareFrames: readonly {
		readonly sessionId: string;
		readonly label: string;
		readonly frame: SurfacePreviewFrameState;
	}[];
}

export interface SurfaceAutomationSummary {
	readonly id: string;
	readonly key: string;
	readonly title: string;
	readonly scheduleSummary: string;
	readonly targetSurfaceSlug: string | null;
	readonly outputMode: SurfaceAutomationOutputMode;
	readonly enabled: boolean;
	readonly status: SurfaceAutomationStatus;
	readonly lastRunAt: string | null;
	readonly lastOutcomeSummary: string | null;
	readonly nextRunAt: string | null;
}

export interface SurfaceWorkspace {
	readonly surface: SurfaceSummary;
	readonly briefSummary: string | null;
	readonly activeSessions: readonly SurfaceSession[];
	readonly recentHistory: readonly SurfaceSession[];
	readonly explorations: readonly SurfaceExplorationSet[];
	readonly previewState: SurfacePreviewCompositionState;
}

export interface SurfaceMigrationAgentItem {
	readonly agentId: string;
	readonly handle: string;
	readonly name: string;
	readonly role: string;
	readonly routineCount: number;
	readonly recommendedAction: "fold_to_automation" | "fold_to_surface_brief" | "archive_readonly";
	readonly recommendedTargetSurfaceSlug: string | null;
}

export interface SurfaceMigrationBoardItem {
	readonly appName: string;
	readonly title: string;
	readonly kit: string | null;
	readonly recommendedAction: "promote_surface" | "archive_to_files";
	readonly recommendedSurfaceSlug: string | null;
}

export interface SurfaceMigrationChecklist {
	readonly companyId: string;
	readonly alreadyMigrated: boolean;
	readonly proposedSurfaces: readonly {
		readonly slug: string;
		readonly title: string;
		readonly group: SurfaceGroup;
		readonly archetype: SurfaceArchetype;
		readonly sourceKind: SurfaceSourceKind;
		readonly sourceRef: string | null;
	}[];
	readonly specialistAgents: readonly SurfaceMigrationAgentItem[];
	readonly legacyBoards: readonly SurfaceMigrationBoardItem[];
}

export const OPEN_SURFACE_CHANGE_STATUSES: ReadonlySet<SurfaceChangeStatus> = new Set([
	"staged",
	"merging",
	"conflicted",
]);

export const RUNNING_SURFACE_SESSION_STATES: ReadonlySet<SurfaceSessionState> = new Set([
	"queued",
	"running",
	"reconciling",
	"needs_input",
]);

export function countOpenSurfaceChanges(changes: readonly Pick<SurfaceChangeUnit, "status">[]): number {
	let count = 0;
	for (const change of changes) {
		if (OPEN_SURFACE_CHANGE_STATUSES.has(change.status)) count += 1;
	}
	return count;
}

// WHY: Prevents multi-change sessions from vanishing mid-review until every change is resolved and the member is done chatting.
export function nextSurfaceSessionLifecycleState(input: {
	state: SurfaceSessionState;
	hasActiveChat: boolean;
	changes: readonly Pick<SurfaceChangeUnit, "status">[];
}): SurfaceSessionState {
	if (RUNNING_SURFACE_SESSION_STATES.has(input.state) || input.state === "failed") return input.state;
	const openCount = countOpenSurfaceChanges(input.changes);
	if (openCount > 0 || input.hasActiveChat) return "ready";
	if (input.changes.length === 0) return input.state;
	const anyMerged = input.changes.some((change) => change.status === "merged");
	return anyMerged ? "completed" : "discarded";
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
	if (typeof value !== "string" || !allowed.includes(value as T)) throw new WireValueError(label);
	return value as T;
}

function parseOptionalText(value: unknown, label: string, maxLength: number): string | null {
	if (value === null || value === undefined) return null;
	return parseBoundedText(value, label, maxLength, 0);
}

function parseOptionalUuid(value: unknown, label: string): string | null {
	if (value === null || value === undefined) return null;
	return parseUuid(value, label);
}

function parseOptionalTimestamp(value: unknown, label: string): string | null {
	if (value === null || value === undefined) return null;
	return parseTimestamp(value, label).text;
}

function parseStringArray(value: unknown, label: string, maxItems: number, maxLength: number): string[] {
	if (!Array.isArray(value) || value.length > maxItems) throw new WireValueError(label);
	return value.map((item, index) => parseBoundedText(item, `${label}[${index}]`, maxLength));
}

function parseUuidArray(value: unknown, label: string, maxItems: number): string[] {
	if (!Array.isArray(value) || value.length > maxItems) throw new WireValueError(label);
	return value.map((item, index) => parseUuid(item, `${label}[${index}]`));
}

export function isSurfaceSlug(value: unknown): value is string {
	return typeof value === "string" && value.length >= 1 && value.length <= 64 && SURFACE_SLUG_PATTERN.test(value);
}

export function parseSurfaceSlug(value: unknown, label = "surface.slug"): string {
	if (!isSurfaceSlug(value)) throw new WireValueError(label);
	return value;
}

export function parseSurfaceSummary(value: unknown, label = "surface"): SurfaceSummary {
	const raw = parseRecord(value, label);
	if (typeof raw.autoPublish !== "boolean") throw new WireValueError(`${label}.autoPublish`);
	if (typeof raw.hasUnpublishedChanges !== "boolean") throw new WireValueError(`${label}.hasUnpublishedChanges`);
	return {
		id: parseUuid(raw.id, `${label}.id`),
		slug: parseSurfaceSlug(raw.slug, `${label}.slug`),
		title: parseBoundedText(raw.title, `${label}.title`, SURFACE_MAX_TITLE_CHARS),
		group: parseEnum(raw.group, SURFACE_GROUPS, `${label}.group`),
		archetype: parseEnum(raw.archetype, SURFACE_ARCHETYPES, `${label}.archetype`),
		status: parseEnum(raw.status, SURFACE_STATUSES, `${label}.status`),
		icon: parseBoundedText(raw.icon, `${label}.icon`, 40),
		sourceKind: parseEnum(raw.sourceKind, SURFACE_SOURCE_KINDS, `${label}.sourceKind`),
		repositoryKey: parseOptionalText(raw.repositoryKey, `${label}.repositoryKey`, 200),
		folderRoot: parseOptionalText(raw.folderRoot, `${label}.folderRoot`, 256),
		siteSlug: parseOptionalText(raw.siteSlug, `${label}.siteSlug`, 64),
		previewMode: parseEnum(raw.previewMode, SURFACE_PREVIEW_MODES, `${label}.previewMode`),
		autoPublish: raw.autoPublish,
		liveUrl: parseOptionalText(raw.liveUrl, `${label}.liveUrl`, 512),
		hasUnpublishedChanges: raw.hasUnpublishedChanges,
		unpublishedChangeCount: parseInteger(
			raw.unpublishedChangeCount ?? 0,
			`${label}.unpublishedChangeCount`,
			0,
			10_000,
		),
		activeSessionCount: parseInteger(raw.activeSessionCount ?? 0, `${label}.activeSessionCount`, 0, 10_000),
		runningSessionCount: parseInteger(raw.runningSessionCount ?? 0, `${label}.runningSessionCount`, 0, 10_000),
		pendingChangeCount: parseInteger(raw.pendingChangeCount ?? 0, `${label}.pendingChangeCount`, 0, 100_000),
		needsAttentionCount: parseInteger(raw.needsAttentionCount ?? 0, `${label}.needsAttentionCount`, 0, 100_000),
		sortOrder: parseInteger(raw.sortOrder ?? 0, `${label}.sortOrder`, -10_000, 100_000),
	};
}

export function parseSurfaceChangeUnit(value: unknown, label = "change"): SurfaceChangeUnit {
	const raw = parseRecord(value, label);
	if (typeof raw.canUndo !== "boolean") throw new WireValueError(`${label}.canUndo`);
	let diffStats: SurfaceChangeDiffStats | null = null;
	if (raw.diffStats !== null && raw.diffStats !== undefined) {
		const stats = parseRecord(raw.diffStats, `${label}.diffStats`);
		diffStats = {
			filesChanged: parseInteger(stats.filesChanged, `${label}.diffStats.filesChanged`, 0, 100_000),
			additions: parseInteger(stats.additions, `${label}.diffStats.additions`, 0, 10_000_000),
			deletions: parseInteger(stats.deletions, `${label}.diffStats.deletions`, 0, 10_000_000),
		};
	}
	return {
		id: parseUuid(raw.id, `${label}.id`),
		sessionId: parseUuid(raw.sessionId, `${label}.sessionId`),
		surfaceId: parseUuid(raw.surfaceId, `${label}.surfaceId`),
		seq: parseInteger(raw.seq, `${label}.seq`, 1, 10_000),
		title: parseBoundedText(raw.title, `${label}.title`, SURFACE_MAX_CHANGE_TITLE_CHARS),
		summary: parseBoundedText(raw.summary, `${label}.summary`, SURFACE_MAX_CHANGE_SUMMARY_CHARS, 0),
		kind: parseEnum(raw.kind, SURFACE_CHANGE_KINDS, `${label}.kind`),
		status: parseEnum(raw.status, SURFACE_CHANGE_STATUSES, `${label}.status`),
		parentSha: parseOptionalText(raw.parentSha, `${label}.parentSha`, 64),
		headSha: parseOptionalText(raw.headSha, `${label}.headSha`, 64),
		dependsOnChangeIds: parseUuidArray(raw.dependsOnChangeIds ?? [], `${label}.dependsOnChangeIds`, 64),
		affectedPaths: parseStringArray(raw.affectedPaths ?? [], `${label}.affectedPaths`, 500, 512),
		diffStats,
		conflictPaths:
			raw.conflictPaths === null || raw.conflictPaths === undefined
				? null
				: parseStringArray(raw.conflictPaths, `${label}.conflictPaths`, 500, 512),
		landedChangeNumber:
			raw.landedChangeNumber === null || raw.landedChangeNumber === undefined
				? null
				: parseInteger(raw.landedChangeNumber, `${label}.landedChangeNumber`, 1, 10_000_000),
		canUndo: raw.canUndo,
		createdAt: parseTimestamp(raw.createdAt, `${label}.createdAt`).text,
		resolvedAt: parseOptionalTimestamp(raw.resolvedAt, `${label}.resolvedAt`),
	};
}

export function parseSurfaceSessionMessage(value: unknown, label = "message"): SurfaceSessionMessage {
	const raw = parseRecord(value, label);
	return {
		id: parseUuid(raw.id, `${label}.id`),
		sessionId: parseUuid(raw.sessionId, `${label}.sessionId`),
		authorKind: parseEnum(raw.authorKind, SURFACE_SESSION_MESSAGE_AUTHORS, `${label}.authorKind`),
		text: parseBoundedText(raw.text, `${label}.text`, SURFACE_MAX_PROMPT_CHARS, 0),
		changeId: parseOptionalUuid(raw.changeId, `${label}.changeId`),
		createdAt: parseTimestamp(raw.createdAt, `${label}.createdAt`).text,
	};
}

export function parseSurfaceSession(value: unknown, label = "session"): SurfaceSession {
	const raw = parseRecord(value, label);
	if (typeof raw.hasActiveChat !== "boolean") throw new WireValueError(`${label}.hasActiveChat`);
	if (!Array.isArray(raw.changes)) throw new WireValueError(`${label}.changes`);
	const changes = raw.changes.map((item, index) => parseSurfaceChangeUnit(item, `${label}.changes[${index}]`));
	const rawMessages = raw.messages === undefined || raw.messages === null ? [] : raw.messages;
	if (!Array.isArray(rawMessages)) throw new WireValueError(`${label}.messages`);
	const messages = rawMessages.map((item, index) => parseSurfaceSessionMessage(item, `${label}.messages[${index}]`));
	let question: SurfaceSessionQuestion | null = null;
	if (raw.question !== null && raw.question !== undefined) {
		const q = parseRecord(raw.question, `${label}.question`);
		question = {
			text: parseBoundedText(q.text, `${label}.question.text`, 4000),
			options: parseStringArray(q.options ?? [], `${label}.question.options`, 12, 240),
		};
	}
	return {
		id: parseUuid(raw.id, `${label}.id`),
		surfaceId: parseUuid(raw.surfaceId, `${label}.surfaceId`),
		workerId: parseOptionalUuid(raw.workerId, `${label}.workerId`),
		title: parseBoundedText(raw.title, `${label}.title`, 160),
		prompt: parseBoundedText(raw.prompt, `${label}.prompt`, SURFACE_MAX_PROMPT_CHARS, 0),
		state: parseEnum(raw.state, SURFACE_SESSION_STATES, `${label}.state`),
		originKind: parseEnum(raw.originKind, SURFACE_SESSION_ORIGIN_KINDS, `${label}.originKind`),
		originLabel: parseOptionalText(raw.originLabel, `${label}.originLabel`, 160),
		explorationId: parseOptionalUuid(raw.explorationId, `${label}.explorationId`),
		explorationVariantLabel: parseOptionalText(raw.explorationVariantLabel, `${label}.explorationVariantLabel`, 80),
		hasActiveChat: raw.hasActiveChat,
		question,
		changes,
		messages,
		openChangeCount: parseInteger(
			raw.openChangeCount ?? countOpenSurfaceChanges(changes),
			`${label}.openChangeCount`,
			0,
			10_000,
		),
		createdAt: parseTimestamp(raw.createdAt, `${label}.createdAt`).text,
		updatedAt: parseTimestamp(raw.updatedAt, `${label}.updatedAt`).text,
		closedAt: parseOptionalTimestamp(raw.closedAt, `${label}.closedAt`),
	};
}

export function parseSurfaceExplorationSet(value: unknown, label = "exploration"): SurfaceExplorationSet {
	const raw = parseRecord(value, label);
	return {
		id: parseUuid(raw.id, `${label}.id`),
		surfaceId: parseUuid(raw.surfaceId, `${label}.surfaceId`),
		title: parseBoundedText(raw.title, `${label}.title`, 160),
		status: parseEnum(raw.status, SURFACE_EXPLORATION_STATUSES, `${label}.status`),
		chosenSessionId: parseOptionalUuid(raw.chosenSessionId, `${label}.chosenSessionId`),
		variantSessionIds: parseUuidArray(raw.variantSessionIds ?? [], `${label}.variantSessionIds`, 8),
		createdAt: parseTimestamp(raw.createdAt, `${label}.createdAt`).text,
		resolvedAt: parseOptionalTimestamp(raw.resolvedAt, `${label}.resolvedAt`),
	};
}

export function parseSurfacePreviewFrameState(value: unknown, label = "previewFrame"): SurfacePreviewFrameState {
	const raw = parseRecord(value, label);
	let conflictReport: SurfacePreviewConflict | null = null;
	if (raw.conflictReport !== null && raw.conflictReport !== undefined) {
		const conflict = parseRecord(raw.conflictReport, `${label}.conflictReport`);
		conflictReport = {
			changeIds: parseUuidArray(conflict.changeIds ?? [], `${label}.conflictReport.changeIds`, 64),
			paths: parseStringArray(conflict.paths ?? [], `${label}.conflictReport.paths`, 200, 512),
		};
	}
	return {
		previewId: parseOptionalUuid(raw.previewId, `${label}.previewId`),
		status: parseEnum(raw.status, SURFACE_PREVIEW_STATUSES, `${label}.status`),
		doorActionUrl: parseOptionalText(raw.doorActionUrl, `${label}.doorActionUrl`, 512),
		memberPass: parseOptionalText(raw.memberPass, `${label}.memberPass`, 128),
		activeRoute: parseBoundedText(raw.activeRoute ?? "/", `${label}.activeRoute`, 512),
		toggledChangeIds: parseUuidArray(raw.toggledChangeIds ?? [], `${label}.toggledChangeIds`, 128),
		conflictReport,
		errorDetail: parseOptionalText(raw.errorDetail, `${label}.errorDetail`, 1000),
	};
}

export function parseSurfacePreviewCompositionState(
	value: unknown,
	label = "previewState",
): SurfacePreviewCompositionState {
	const raw = parseRecord(value, label);
	const mode = parseEnum(raw.mode, ["single", "compare"] as const, `${label}.mode`);
	if (!Array.isArray(raw.compareFrames) || raw.compareFrames.length > SURFACE_MAX_COMPARE_VARIANTS) {
		throw new WireValueError(`${label}.compareFrames`);
	}
	return {
		surfaceId: parseUuid(raw.surfaceId, `${label}.surfaceId`),
		mode,
		primary: parseSurfacePreviewFrameState(raw.primary, `${label}.primary`),
		compareFrames: raw.compareFrames.map((item, index) => {
			const entry = parseRecord(item, `${label}.compareFrames[${index}]`);
			return {
				sessionId: parseUuid(entry.sessionId, `${label}.compareFrames[${index}].sessionId`),
				label: parseBoundedText(entry.label, `${label}.compareFrames[${index}].label`, 80),
				frame: parseSurfacePreviewFrameState(entry.frame, `${label}.compareFrames[${index}].frame`),
			};
		}),
	};
}

export function parseSurfaceWorkspace(value: unknown, label = "workspace"): SurfaceWorkspace {
	const raw = parseRecord(value, label);
	if (!Array.isArray(raw.activeSessions)) throw new WireValueError(`${label}.activeSessions`);
	if (!Array.isArray(raw.recentHistory)) throw new WireValueError(`${label}.recentHistory`);
	if (!Array.isArray(raw.explorations)) throw new WireValueError(`${label}.explorations`);
	return {
		surface: parseSurfaceSummary(raw.surface, `${label}.surface`),
		briefSummary: parseOptionalText(raw.briefSummary, `${label}.briefSummary`, 4000),
		activeSessions: raw.activeSessions.map((item, index) =>
			parseSurfaceSession(item, `${label}.activeSessions[${index}]`),
		),
		recentHistory: raw.recentHistory.map((item, index) =>
			parseSurfaceSession(item, `${label}.recentHistory[${index}]`),
		),
		explorations: raw.explorations.map((item, index) =>
			parseSurfaceExplorationSet(item, `${label}.explorations[${index}]`),
		),
		previewState: parseSurfacePreviewCompositionState(raw.previewState, `${label}.previewState`),
	};
}

export function parsePointToChangeTarget(value: unknown, label = "target"): PointToChangeTarget {
	const raw = parseRecord(value, label);
	const box = parseRecord(raw.boundingBox, `${label}.boundingBox`);
	const viewport = parseRecord(raw.viewport, `${label}.viewport`);
	const num = (v: unknown, field: string) => {
		if (typeof v !== "number" || !Number.isFinite(v) || v < -100_000 || v > 100_000) {
			throw new WireValueError(field);
		}
		return v;
	};
	return {
		route: parseBoundedText(raw.route, `${label}.route`, 512),
		selector: parseBoundedText(raw.selector, `${label}.selector`, 512),
		textSnippet: parseBoundedText(raw.textSnippet ?? "", `${label}.textSnippet`, 240, 0),
		tagName: parseBoundedText(raw.tagName, `${label}.tagName`, 40),
		componentHint: parseOptionalText(raw.componentHint, `${label}.componentHint`, 160),
		boundingBox: {
			x: num(box.x, `${label}.boundingBox.x`),
			y: num(box.y, `${label}.boundingBox.y`),
			width: num(box.width, `${label}.boundingBox.width`),
			height: num(box.height, `${label}.boundingBox.height`),
		},
		viewport: {
			width: parseInteger(
				Math.round(num(viewport.width, `${label}.viewport.width`)),
				`${label}.viewport.width`,
				1,
				20_000,
			),
			height: parseInteger(
				Math.round(num(viewport.height, `${label}.viewport.height`)),
				`${label}.viewport.height`,
				1,
				20_000,
			),
		},
	};
}

export function parseSurfaceAutomationSummary(value: unknown, label = "automation"): SurfaceAutomationSummary {
	const raw = parseRecord(value, label);
	if (typeof raw.enabled !== "boolean") throw new WireValueError(`${label}.enabled`);
	return {
		id: parseUuid(raw.id, `${label}.id`),
		key: parseBoundedText(raw.key, `${label}.key`, 80),
		title: parseBoundedText(raw.title, `${label}.title`, 120),
		scheduleSummary: parseBoundedText(raw.scheduleSummary, `${label}.scheduleSummary`, 160),
		targetSurfaceSlug:
			raw.targetSurfaceSlug === null || raw.targetSurfaceSlug === undefined
				? null
				: parseSurfaceSlug(raw.targetSurfaceSlug, `${label}.targetSurfaceSlug`),
		outputMode: parseEnum(raw.outputMode, SURFACE_AUTOMATION_OUTPUT_MODES, `${label}.outputMode`),
		enabled: raw.enabled,
		status: parseEnum(raw.status, SURFACE_AUTOMATION_STATUSES, `${label}.status`),
		lastRunAt: parseOptionalTimestamp(raw.lastRunAt, `${label}.lastRunAt`),
		lastOutcomeSummary: parseOptionalText(raw.lastOutcomeSummary, `${label}.lastOutcomeSummary`, 500),
		nextRunAt: parseOptionalTimestamp(raw.nextRunAt, `${label}.nextRunAt`),
	};
}

export function parseSurfaceMigrationChecklist(
	value: unknown,
	label = "migrationChecklist",
): SurfaceMigrationChecklist {
	const raw = parseRecord(value, label);
	if (typeof raw.alreadyMigrated !== "boolean") throw new WireValueError(`${label}.alreadyMigrated`);
	if (!Array.isArray(raw.proposedSurfaces)) throw new WireValueError(`${label}.proposedSurfaces`);
	if (!Array.isArray(raw.specialistAgents)) throw new WireValueError(`${label}.specialistAgents`);
	if (!Array.isArray(raw.legacyBoards)) throw new WireValueError(`${label}.legacyBoards`);
	return {
		companyId: parseUuid(raw.companyId, `${label}.companyId`),
		alreadyMigrated: raw.alreadyMigrated,
		proposedSurfaces: raw.proposedSurfaces.map((item, index) => {
			const entry = parseRecord(item, `${label}.proposedSurfaces[${index}]`);
			return {
				slug: parseSurfaceSlug(entry.slug, `${label}.proposedSurfaces[${index}].slug`),
				title: parseBoundedText(entry.title, `${label}.proposedSurfaces[${index}].title`, SURFACE_MAX_TITLE_CHARS),
				group: parseEnum(entry.group, SURFACE_GROUPS, `${label}.proposedSurfaces[${index}].group`),
				archetype: parseEnum(entry.archetype, SURFACE_ARCHETYPES, `${label}.proposedSurfaces[${index}].archetype`),
				sourceKind: parseEnum(
					entry.sourceKind,
					SURFACE_SOURCE_KINDS,
					`${label}.proposedSurfaces[${index}].sourceKind`,
				),
				sourceRef: parseOptionalText(entry.sourceRef, `${label}.proposedSurfaces[${index}].sourceRef`, 256),
			};
		}),
		specialistAgents: raw.specialistAgents.map((item, index) => {
			const entry = parseRecord(item, `${label}.specialistAgents[${index}]`);
			return {
				agentId: parseUuid(entry.agentId, `${label}.specialistAgents[${index}].agentId`),
				handle: parseBoundedText(entry.handle, `${label}.specialistAgents[${index}].handle`, 80),
				name: parseBoundedText(entry.name, `${label}.specialistAgents[${index}].name`, 120),
				role: parseBoundedText(entry.role ?? "", `${label}.specialistAgents[${index}].role`, 160, 0),
				routineCount: parseInteger(
					entry.routineCount ?? 0,
					`${label}.specialistAgents[${index}].routineCount`,
					0,
					1000,
				),
				recommendedAction: parseEnum(
					entry.recommendedAction,
					["fold_to_automation", "fold_to_surface_brief", "archive_readonly"] as const,
					`${label}.specialistAgents[${index}].recommendedAction`,
				),
				recommendedTargetSurfaceSlug:
					entry.recommendedTargetSurfaceSlug === null || entry.recommendedTargetSurfaceSlug === undefined
						? null
						: parseSurfaceSlug(entry.recommendedTargetSurfaceSlug, `${label}.specialistAgents[${index}].target`),
			};
		}),
		legacyBoards: raw.legacyBoards.map((item, index) => {
			const entry = parseRecord(item, `${label}.legacyBoards[${index}]`);
			return {
				appName: parseBoundedText(entry.appName, `${label}.legacyBoards[${index}].appName`, 80),
				title: parseBoundedText(entry.title, `${label}.legacyBoards[${index}].title`, 120),
				kit: parseOptionalText(entry.kit, `${label}.legacyBoards[${index}].kit`, 40),
				recommendedAction: parseEnum(
					entry.recommendedAction,
					["promote_surface", "archive_to_files"] as const,
					`${label}.legacyBoards[${index}].recommendedAction`,
				),
				recommendedSurfaceSlug:
					entry.recommendedSurfaceSlug === null || entry.recommendedSurfaceSlug === undefined
						? null
						: parseSurfaceSlug(entry.recommendedSurfaceSlug, `${label}.legacyBoards[${index}].surfaceSlug`),
			};
		}),
	};
}

export function isValidSurfaceId(value: unknown): value is string {
	return isUuid(value);
}
